import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(APP_DIR, 'dist');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_ORIGIN = normalizeOrigin(process.env.PUBLIC_ORIGIN);

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2']
]);

function splitUrls(value, fallback = '') {
  return String(value || fallback).split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeOrigin(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    console.warn('PUBLIC_ORIGIN is invalid; using the request or local network address.');
    return '';
  }
}

function privateIpv4Score(address) {
  if (/^192\.168\./.test(address)) return 3;
  if (/^10\./.test(address)) return 2;
  const match = /^172\.(\d+)\./.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return 1;
  return 0;
}

function findLanOrigin() {
  const addresses = Object.values(networkInterfaces())
    .flatMap(details => details || [])
    .filter(details => details.family === 'IPv4' && !details.internal)
    .map(details => ({ address: details.address, score: privateIpv4Score(details.address) }))
    .filter(details => details.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!addresses[0]) return '';
  return `http://${addresses[0].address}:${PORT}`;
}

const LAN_ORIGIN = findLanOrigin();

function requestOrigin(request) {
  const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
  const host = request.headers.host || `localhost:${PORT}`;
  return normalizeOrigin(`${protocol}://${host}`) || `http://localhost:${PORT}`;
}

function viewerOrigin(request) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  const origin = requestOrigin(request);
  const hostname = new URL(origin).hostname;
  return (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') && LAN_ORIGIN
    ? LAN_ORIGIN
    : origin;
}

function loadIceServers() {
  const urls = splitUrls(process.env.STUN_URLS, 'stun:stun.cloudflare.com:3478')
    .filter(url => /^stuns?:/i.test(url));
  return [{ urls: urls.length ? urls : ['stun:stun.cloudflare.com:3478'] }];
}

const iceServers = loadIceServers();

/** @type {Map<string, {tokenHash: Buffer, host: WebSocket, viewer: null | {id: string, socket: WebSocket}}>} */
const rooms = new Map();
/** @type {WeakMap<WebSocket, {role: 'host' | 'viewer', roomId: string, peerId?: string}>} */
const clients = new WeakMap();

function tokenHash(token) {
  return createHash('sha256').update(token).digest();
}

function tokenMatches(expected, candidate) {
  const actual = tokenHash(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function fail(socket, code, message) {
  sendJson(socket, { type: 'error', code, message });
}

function validRoomId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{12,64}$/.test(value);
}

function validToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function validDescription(value) {
  return value && typeof value === 'object' && ['offer', 'answer'].includes(value.type) && typeof value.sdp === 'string' && value.sdp.length <= 220_000;
}

function closeViewer(room, { notifyHost = true, code = 1000, reason = 'Viewer left' } = {}) {
  const viewer = room.viewer;
  if (!viewer) return;
  room.viewer = null;
  clients.delete(viewer.socket);
  if (notifyHost) sendJson(room.host, { type: 'viewer-left', peerId: viewer.id });
  if (viewer.socket.readyState === WebSocket.OPEN || viewer.socket.readyState === WebSocket.CONNECTING) {
    viewer.socket.close(code, reason);
  }
}

function endRoom(roomId, { hostEnded = false, closeHost = false } = {}) {
  const room = rooms.get(roomId);
  if (!room) return;
  rooms.delete(roomId);
  const viewer = room.viewer;
  if (viewer) {
    if (hostEnded) sendJson(viewer.socket, { type: 'host-ended' });
    else fail(viewer.socket, 'HOST_OFFLINE', 'O computador está temporariamente desconectado.');
    closeViewer(room, { notifyHost: false, code: hostEnded ? 1000 : 4001, reason: hostEnded ? 'Host ended' : 'Host offline' });
  }
  clients.delete(room.host);
  if (closeHost && (room.host.readyState === WebSocket.OPEN || room.host.readyState === WebSocket.CONNECTING)) {
    room.host.close(hostEnded ? 1000 : 4001, hostEnded ? 'Host ended' : 'Host replaced');
  }
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(self), display-capture=(self)');
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

async function serveFile(request, response) {
  setSecurityHeaders(response);
  const url = new URL(request.url || '/', 'http://screenlink.local');
  if (url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, mode: 'p2p-stun' }));
    return;
  }
  if (url.pathname === '/runtime-config') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ viewerOrigin: viewerOrigin(request), mode: 'p2p-stun' }));
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  let requestedPath;
  try {
    requestedPath = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }

  const relativePath = requestedPath.replace(/^\/+/, '');
  let filePath = path.resolve(DIST_DIR, relativePath || 'index.html');
  if (!filePath.startsWith(`${path.resolve(DIST_DIR)}${path.sep}`) && filePath !== path.resolve(DIST_DIR, 'index.html')) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error('Not a file');
  } catch {
    if (path.extname(relativePath)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    filePath = path.join(DIST_DIR, 'index.html');
  }

  try {
    const content = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const isAsset = filePath.includes(`${path.sep}assets${path.sep}`);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES.get(extension) || 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    if (request.method === 'HEAD') response.end();
    else response.end(content);
  } catch {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ScreenLink ainda não foi compilado. Execute npm run build.');
  }
}

const server = http.createServer((request, response) => {
  void serveFile(request, response);
});
const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://screenlink.local').pathname;
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, webSocket => websocketServer.emit('connection', webSocket, request));
});

websocketServer.on('connection', socket => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', async raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      fail(socket, 'BAD_JSON', 'Mensagem inválida.');
      return;
    }
    if (!message || typeof message.type !== 'string') {
      fail(socket, 'BAD_MESSAGE', 'Mensagem inválida.');
      return;
    }

    if (message.type === 'ping') {
      sendJson(socket, { type: 'pong', at: Number(message.at) || Date.now() });
      return;
    }

    if (message.type === 'create-room') {
      if (clients.has(socket)) {
        fail(socket, 'ALREADY_JOINED', 'Este dispositivo já está em uma sala.');
        return;
      }
      if (!validRoomId(message.roomId) || !validToken(message.token)) {
        fail(socket, 'BAD_ROOM', 'Não foi possível criar o link privado.');
        return;
      }
      const existing = rooms.get(message.roomId);
      if (existing) {
        if (!tokenMatches(existing.tokenHash, message.token)) {
          fail(socket, 'ROOM_EXISTS', 'Esta sala já está sendo usada.');
          return;
        }
        endRoom(message.roomId, { closeHost: true });
      }
      rooms.set(message.roomId, { tokenHash: tokenHash(message.token), host: socket, viewer: null });
      clients.set(socket, { role: 'host', roomId: message.roomId });
      sendJson(socket, { type: 'room-created', roomId: message.roomId, iceServers });
      return;
    }

    if (message.type === 'join-room') {
      if (clients.has(socket)) {
        fail(socket, 'ALREADY_JOINED', 'Este dispositivo já está em uma sala.');
        return;
      }
      if (!validRoomId(message.roomId) || !validToken(message.token)) {
        fail(socket, 'BAD_ROOM', 'Este link privado não é válido.');
        return;
      }
      const room = rooms.get(message.roomId);
      if (!room || room.host.readyState !== WebSocket.OPEN) {
        fail(socket, 'HOST_OFFLINE', 'O computador ainda não está compartilhando.');
        return;
      }
      if (!tokenMatches(room.tokenHash, message.token)) {
        fail(socket, 'UNAUTHORIZED', 'Este link privado não é válido.');
        return;
      }
      if (room.viewer?.socket.readyState === WebSocket.OPEN) {
        fail(socket, 'ROOM_FULL', 'Este link já está sendo usado em outro dispositivo.');
        return;
      }
      if (room.viewer) closeViewer(room, { notifyHost: false });
      const peerId = randomUUID();
      room.viewer = { id: peerId, socket };
      clients.set(socket, { role: 'viewer', roomId: message.roomId, peerId });
      sendJson(socket, { type: 'joined', roomId: message.roomId, peerId, iceServers });
      sendJson(room.host, { type: 'viewer-joined', peerId });
      return;
    }

    const client = clients.get(socket);
    if (!client) {
      fail(socket, 'NOT_JOINED', 'Abra ou crie uma sala primeiro.');
      return;
    }
    const room = rooms.get(client.roomId);
    if (!room) {
      fail(socket, 'HOST_OFFLINE', 'A transmissão não está mais disponível.');
      return;
    }

    if (message.type === 'leave-room') {
      if (client.role === 'host') {
        endRoom(client.roomId, { hostEnded: true });
        socket.close(1000, 'Host ended');
      } else if (room.viewer?.socket === socket) {
        closeViewer(room);
      }
      return;
    }

    if (message.type === 'offer') {
      if (client.role !== 'host' || room.viewer?.id !== message.peerId || !validDescription(message.sdp) || message.sdp.type !== 'offer') {
        fail(socket, 'BAD_OFFER', 'Não foi possível iniciar o vídeo.');
        return;
      }
      sendJson(room.viewer.socket, { type: 'offer', peerId: message.peerId, sdp: message.sdp });
      return;
    }

    if (message.type === 'answer') {
      if (client.role !== 'viewer' || room.viewer?.socket !== socket || room.viewer.id !== message.peerId || !validDescription(message.sdp) || message.sdp.type !== 'answer') {
        fail(socket, 'BAD_ANSWER', 'Não foi possível confirmar o vídeo.');
        return;
      }
      sendJson(room.host, { type: 'answer', peerId: message.peerId, sdp: message.sdp });
      return;
    }

    if (message.type === 'ice-candidate') {
      if (typeof message.peerId !== 'string' || !message.candidate || typeof message.candidate !== 'object') return;
      if (client.role === 'host' && room.viewer?.id === message.peerId) {
        sendJson(room.viewer.socket, { type: 'ice-candidate', peerId: message.peerId, candidate: message.candidate });
      } else if (client.role === 'viewer' && room.viewer?.socket === socket && room.viewer.id === message.peerId) {
        sendJson(room.host, { type: 'ice-candidate', peerId: message.peerId, candidate: message.candidate });
      }
      return;
    }

    if (message.type === 'media-state') {
      if (
        client.role !== 'host' ||
        room.viewer?.id !== message.peerId ||
        typeof message.videoPaused !== 'boolean' ||
        typeof message.screenAudioEnabled !== 'boolean' ||
        typeof message.microphoneEnabled !== 'boolean'
      ) {
        fail(socket, 'BAD_MEDIA_STATE', 'Não foi possível atualizar os controles da transmissão.');
        return;
      }
      sendJson(room.viewer.socket, {
        type: 'media-state',
        peerId: message.peerId,
        videoPaused: message.videoPaused,
        screenAudioEnabled: message.screenAudioEnabled,
        microphoneEnabled: message.microphoneEnabled
      });
      return;
    }

    fail(socket, 'UNKNOWN_MESSAGE', 'Mensagem não reconhecida.');
  });

  socket.on('close', () => {
    const client = clients.get(socket);
    if (!client) return;
    clients.delete(socket);
    const room = rooms.get(client.roomId);
    if (!room) return;
    if (client.role === 'host' && room.host === socket) {
      endRoom(client.roomId);
    } else if (client.role === 'viewer' && room.viewer?.socket === socket) {
      closeViewer(room, { notifyHost: true });
    }
  });
  socket.on('error', () => undefined);
});

const heartbeat = setInterval(() => {
  for (const socket of websocketServer.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);
heartbeat.unref();

server.listen(PORT, HOST, () => {
  console.log(`ScreenLink disponível em http://${HOST}:${PORT}`);
  if (LAN_ORIGIN) console.log(`Convites locais usarão ${PUBLIC_ORIGIN || LAN_ORIGIN}`);
  console.log('Modo WebRTC P2P + STUN, sem TURN.');
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of websocketServer.clients) socket.close(1001, 'Server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
