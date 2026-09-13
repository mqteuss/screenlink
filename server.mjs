import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(APP_DIR, 'dist');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_ORIGIN = normalizeOrigin(process.env.PUBLIC_ORIGIN, true);
const EXTRA_ALLOWED_ORIGINS = new Set(splitUrls(process.env.ALLOWED_ORIGINS).map(normalizeOrigin).filter(Boolean));
const MIN_VIEWERS = 1;
const MAX_VIEWERS = 8;
const configuredRoomLimit = Number(process.env.MAX_ACTIVE_ROOMS || 2_500);
const MAX_ACTIVE_ROOMS = Number.isSafeInteger(configuredRoomLimit) && configuredRoomLimit >= 10 ? configuredRoomLimit : 2_500;
const configuredConnectionLimit = Number(process.env.MAX_CONNECTIONS || 10_000);
const MAX_CONNECTIONS = Number.isSafeInteger(configuredConnectionLimit) && configuredConnectionLimit >= 10 ? configuredConnectionLimit : 10_000;
const SIGNAL_GRACE_MS = 5 * 60_000;

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

function normalizeOrigin(value, warn = false) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    if (warn) console.warn('PUBLIC_ORIGIN is invalid; using the request or local network address.');
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
  const stunUrls = splitUrls(process.env.STUN_URLS, 'stun:stun.cloudflare.com:3478')
    .filter(url => /^stuns?:/i.test(url));
  const servers = [{ urls: stunUrls.length ? stunUrls : ['stun:stun.cloudflare.com:3478'] }];

  const turnUrls = splitUrls(process.env.TURN_URLS).filter(url => /^turns?:/i.test(url));
  const username = String(process.env.TURN_USERNAME || '').trim();
  const credential = String(process.env.TURN_CREDENTIAL || '').trim();
  if (turnUrls.length && username && credential) {
    servers.push({ urls: turnUrls, username, credential });
  }
  return servers;
}

const iceServers = loadIceServers();
const turnEnabled = iceServers.some(server => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.some(url => /^turns?:/i.test(url));
});

/**
 * @typedef {{id: string, socket: WebSocket | null, expiryTimer: NodeJS.Timeout | null}} Viewer
 * @typedef {{tokenHash: Buffer, host: WebSocket | null, hostExpiryTimer: NodeJS.Timeout | null, viewers: Map<string, Viewer>, maxViewers: number}} Room
 */
/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {WeakMap<WebSocket, {role: 'host' | 'viewer', roomId: string, peerId?: string}>} */
const clients = new WeakMap();

/**
 * @typedef {{name: string, avatar: string, status: string, device: 'desktop' | 'mobile'}} GroupProfile
 * @typedef {{id: string, socket: WebSocket | null, profile: GroupProfile, joinedAt: number, sharing: boolean, microphoneEnabled: boolean, isOwner: boolean, expiryTimer: NodeJS.Timeout | null}} GroupParticipant
 * @typedef {{token: string, tokenHash: Buffer, joinCode: string, ownerKeyHash: Buffer, ownerId: string, leaderId: string, participants: Map<string, GroupParticipant>, maxParticipants: number, expiryTimer: NodeJS.Timeout | null}} GroupRoom
 */
/** @type {Map<string, GroupRoom>} */
const groupRooms = new Map();
/** @type {WeakMap<WebSocket, {roomId: string, peerId: string}>} */
const groupClients = new WeakMap();

function tokenHash(token) {
  return createHash('sha256').update(token).digest();
}

function tokenMatches(expected, candidate) {
  const actual = tokenHash(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sendJson(socket, payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
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

function validJoinCode(value) {
  return typeof value === 'string' && /^[A-Z2-9]{6,8}$/.test(value.trim().toUpperCase());
}

function normalizeIceCandidate(value) {
  if (!value || typeof value !== 'object') return null;
  const candidate = typeof value.candidate === 'string' ? value.candidate : '';
  if (!candidate || candidate.length > 8_192) return null;
  const sdpMid = value.sdpMid === null || typeof value.sdpMid === 'undefined' ? null : String(value.sdpMid);
  const sdpMLineIndex = value.sdpMLineIndex === null || typeof value.sdpMLineIndex === 'undefined' ? null : Number(value.sdpMLineIndex);
  const usernameFragment = typeof value.usernameFragment === 'string' ? value.usernameFragment : undefined;
  if ((sdpMid?.length ?? 0) > 128 || (usernameFragment?.length ?? 0) > 256) return null;
  if (sdpMLineIndex !== null && (!Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 128)) return null;
  if (sdpMLineIndex === null && !sdpMid) return null;
  return { candidate, sdpMid, sdpMLineIndex, ...(usernameFragment ? { usernameFragment } : {}) };
}

const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function allocateJoinCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = randomBytes(6);
    const code = Array.from(bytes, byte => JOIN_CODE_ALPHABET[byte % JOIN_CODE_ALPHABET.length]).join('');
    if (![...groupRooms.values()].some(room => room.joinCode === code)) return code;
  }
  throw new Error('Não foi possível reservar um código curto para a sala.');
}

function validPeerId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeProfile(value) {
  const source = value && typeof value === 'object' ? value : {};
  const name = String(source.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 28) || 'Participante';
  const avatarValue = String(source.avatar || '');
  const isPreset = /^[a-z0-9-]{1,24}$/i.test(avatarValue);
  const isLocalPhoto = /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(avatarValue) && avatarValue.length <= 32_000;
  const avatar = isPreset || isLocalPhoto ? avatarValue : 'orbit';
  const status = String(source.status || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || 'Disponível';
  const device = source.device === 'mobile' ? 'mobile' : 'desktop';
  return { name, avatar, status, device };
}

function publicParticipant(participant) {
  return {
    id: participant.id,
    name: participant.profile.name,
    avatar: participant.profile.avatar,
    status: participant.profile.status,
    device: participant.profile.device,
    joinedAt: participant.joinedAt,
    sharing: participant.sharing,
    microphoneEnabled: participant.microphoneEnabled,
    connected: Boolean(participant.socket?.readyState === WebSocket.OPEN)
  };
}

function connectedGroupParticipants(room, exceptId = '') {
  return [...room.participants.values()]
    .filter(participant => participant.id !== exceptId && participant.socket?.readyState === WebSocket.OPEN)
    .sort((left, right) => left.joinedAt - right.joinedAt);
}

function broadcastGroup(room, payload, exceptId = '') {
  for (const participant of connectedGroupParticipants(room, exceptId)) sendJson(participant.socket, payload);
}

function electGroupLeader(room, { reclaimed = false } = {}) {
  const owner = room.participants.get(room.ownerId);
  const nextLeader = owner?.socket?.readyState === WebSocket.OPEN
    ? owner.id
    : connectedGroupParticipants(room)[0]?.id || '';
  if (room.leaderId === nextLeader && !reclaimed) return;
  room.leaderId = nextLeader;
  if (nextLeader) broadcastGroup(room, { type: 'leader-changed', leaderId: nextLeader, reclaimed });
}

function clearGroupRoomExpiry(room) {
  if (room.expiryTimer) clearTimeout(room.expiryTimer);
  room.expiryTimer = null;
}

function scheduleGroupRoomExpiry(roomId, room) {
  clearGroupRoomExpiry(room);
  if (connectedGroupParticipants(room).length) return;
  room.expiryTimer = setTimeout(() => {
    if (groupRooms.get(roomId) === room && connectedGroupParticipants(room).length === 0) groupRooms.delete(roomId);
  }, SIGNAL_GRACE_MS);
  room.expiryTimer.unref?.();
}

function detachGroupParticipant(roomId, room, participant, { remove = false } = {}) {
  const socket = participant.socket;
  if (socket) groupClients.delete(socket);
  participant.socket = null;
  participant.sharing = false;
  participant.microphoneEnabled = false;
  if (participant.expiryTimer) clearTimeout(participant.expiryTimer);
  broadcastGroup(room, { type: 'participant-left', peerId: participant.id }, participant.id);
  if (remove) {
    room.participants.delete(participant.id);
  } else {
    participant.expiryTimer = setTimeout(() => {
      if (room.participants.get(participant.id) === participant && participant.socket === null && !participant.isOwner) {
        room.participants.delete(participant.id);
      }
    }, SIGNAL_GRACE_MS);
    participant.expiryTimer.unref?.();
  }
  electGroupLeader(room);
  scheduleGroupRoomExpiry(roomId, room);
}

function attachGroupParticipant(roomId, room, participant, socket, profile, resumed) {
  clearGroupRoomExpiry(room);
  if (participant.expiryTimer) clearTimeout(participant.expiryTimer);
  participant.expiryTimer = null;
  const previousSocket = participant.socket;
  if (previousSocket && previousSocket !== socket) {
    groupClients.delete(previousSocket);
    if (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING) previousSocket.close(4003, 'Participant signal replaced');
  }
  participant.socket = socket;
  participant.profile = normalizeProfile(profile);
  groupClients.set(socket, { roomId, peerId: participant.id });
  const roster = connectedGroupParticipants(room).map(publicParticipant);
  sendJson(socket, {
    type: 'room-ready',
    roomId,
    joinCode: room.joinCode,
    invite: { roomId, token: room.token },
    selfId: participant.id,
    leaderId: room.leaderId || participant.id,
    maxParticipants: room.maxParticipants,
    isOwner: participant.isOwner,
    resumed,
    iceServers,
    participants: roster
  });
  broadcastGroup(room, { type: 'participant-joined', participant: publicParticipant(participant) }, participant.id);
  const wasLeader = room.leaderId;
  electGroupLeader(room, { reclaimed: participant.isOwner && wasLeader !== participant.id });
}

function closeGroupRoom(roomId) {
  const room = groupRooms.get(roomId);
  if (!room) return;
  groupRooms.delete(roomId);
  clearGroupRoomExpiry(room);
  for (const participant of room.participants.values()) {
    if (participant.expiryTimer) clearTimeout(participant.expiryTimer);
    if (participant.socket) {
      sendJson(participant.socket, { type: 'room-closed' });
      groupClients.delete(participant.socket);
      participant.socket.close(1000, 'Room closed');
    }
  }
}

function validDescription(value) {
  return value && typeof value === 'object' && ['offer', 'answer'].includes(value.type) && typeof value.sdp === 'string' && value.sdp.length <= 220_000;
}

function normalizeMaxViewers(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_VIEWERS && parsed <= MAX_VIEWERS ? parsed : MIN_VIEWERS;
}

function clearExpiry(target, key) {
  if (target[key]) clearTimeout(target[key]);
  target[key] = null;
}

function closeViewer(room, peerId, { notifyHost = true, code = 1000, reason = 'Viewer left' } = {}) {
  const viewer = room.viewers.get(peerId);
  if (!viewer) return;
  clearExpiry(viewer, 'expiryTimer');
  room.viewers.delete(peerId);
  const socket = viewer.socket;
  viewer.socket = null;
  if (socket) clients.delete(socket);
  if (notifyHost) sendJson(room.host, { type: 'viewer-left', peerId });
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    socket.close(code, reason);
  }
}

function detachViewer(room, viewer) {
  const socket = viewer.socket;
  if (socket) clients.delete(socket);
  viewer.socket = null;
  clearExpiry(viewer, 'expiryTimer');
  viewer.expiryTimer = setTimeout(() => {
    if (room.viewers.get(viewer.id) === viewer && viewer.socket === null) {
      closeViewer(room, viewer.id, { notifyHost: true, code: 4001, reason: 'Viewer offline' });
    }
  }, SIGNAL_GRACE_MS);
  viewer.expiryTimer.unref?.();
}

function endRoom(roomId, { hostEnded = false, closeHost = false } = {}) {
  const room = rooms.get(roomId);
  if (!room) return;
  rooms.delete(roomId);
  clearExpiry(room, 'hostExpiryTimer');

  for (const [peerId, viewer] of [...room.viewers]) {
    if (viewer.socket) {
      if (hostEnded) sendJson(viewer.socket, { type: 'host-ended' });
      else fail(viewer.socket, 'HOST_OFFLINE', 'O computador está temporariamente desconectado.');
    }
    closeViewer(room, peerId, {
      notifyHost: false,
      code: hostEnded ? 1000 : 4001,
      reason: hostEnded ? 'Host ended' : 'Host offline'
    });
  }

  const host = room.host;
  room.host = null;
  if (host) clients.delete(host);
  if (closeHost && host && (host.readyState === WebSocket.OPEN || host.readyState === WebSocket.CONNECTING)) {
    host.close(hostEnded ? 1000 : 4001, hostEnded ? 'Host ended' : 'Host replaced');
  }
}

function detachHost(roomId, room, socket) {
  if (room.host !== socket) return;
  clients.delete(socket);
  room.host = null;
  clearExpiry(room, 'hostExpiryTimer');
  room.hostExpiryTimer = setTimeout(() => {
    if (rooms.get(roomId) === room && room.host === null) endRoom(roomId);
  }, SIGNAL_GRACE_MS);
  room.hostExpiryTimer.unref?.();
}

function relayToViewer(room, peerId, payload) {
  const viewer = room.viewers.get(peerId);
  if (!viewer) return false;
  if (viewer.socket?.readyState === WebSocket.OPEN) {
    sendJson(viewer.socket, payload);
    return true;
  }
  return false;
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

function websocketOriginAllowed(request) {
  const supplied = request.headers.origin;
  if (!supplied) return true;
  const origin = normalizeOrigin(supplied);
  if (!origin) return false;
  return origin === requestOrigin(request) || origin === PUBLIC_ORIGIN || EXTRA_ALLOWED_ORIGINS.has(origin);
}

const socketRateLimits = new WeakMap();
const joinAttemptBuckets = new Map();

function consumeSocketBudget(socket, type) {
  const now = Date.now();
  let state = socketRateLimits.get(socket);
  if (!state || now - state.startedAt >= 10_000) state = { startedAt: now, total: 0, chat: 0, stateUpdates: 0 };
  state.total += 1;
  if (type === 'chat-fallback' || type === 'chat-ack') state.chat += 1;
  if (type === 'participant-state' || type === 'media-state') state.stateUpdates += 1;
  socketRateLimits.set(socket, state);
  return state.total <= 360 && state.chat <= 30 && state.stateUpdates <= 80;
}

function clientAddress(request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
}

function allowJoinAttempt(address) {
  const now = Date.now();
  let bucket = joinAttemptBuckets.get(address);
  if (!bucket || now >= bucket.resetAt) bucket = { count: 0, resetAt: now + 60_000 };
  bucket.count += 1;
  joinAttemptBuckets.set(address, bucket);
  if (joinAttemptBuckets.size > 5_000) {
    for (const [key, value] of joinAttemptBuckets) if (now >= value.resetAt) joinAttemptBuckets.delete(key);
    while (joinAttemptBuckets.size > 5_000) joinAttemptBuckets.delete(joinAttemptBuckets.keys().next().value);
  }
  return bucket.count <= 24;
}

async function serveFile(request, response) {
  setSecurityHeaders(response);
  const url = new URL(request.url || '/', 'http://screenlink.local');
  if (url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size + groupRooms.size, mode: 'p2p-mesh', turnEnabled }));
    return;
  }
  if (url.pathname === '/runtime-config') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ viewerOrigin: viewerOrigin(request), mode: 'p2p-mesh', turnEnabled }));
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
  void serveFile(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    if (!response.writableEnded) response.end('Não foi possível atender esta solicitação.');
  });
});
const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://screenlink.local').pathname;
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!websocketOriginAllowed(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (websocketServer.clients.size >= MAX_CONNECTIONS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\n\r\n');
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, webSocket => websocketServer.emit('connection', webSocket, request));
});

websocketServer.on('connection', (socket, request) => {
  const address = clientAddress(request);
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', async raw => {
    try {
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
    if (!consumeSocketBudget(socket, message.type)) {
      fail(socket, 'RATE_LIMITED', 'Muitas ações em pouco tempo. Aguarde alguns segundos.');
      socket.close(1008, 'Rate limit exceeded');
      return;
    }

    if (message.type === 'ping') {
      sendJson(socket, { type: 'pong', at: Number(message.at) || Date.now() });
      return;
    }

    if (message.type === 'create-group-room') {
      if (clients.has(socket) || groupClients.has(socket)) {
        fail(socket, 'ALREADY_JOINED', 'Este dispositivo já está em uma sala.');
        return;
      }
      if (!validRoomId(message.roomId) || !validToken(message.token) || !validToken(message.ownerKey)) {
        fail(socket, 'BAD_ROOM', 'Não foi possível criar a sala.');
        return;
      }
      const maxParticipants = Math.max(2, normalizeMaxViewers(message.maxParticipants));
      let room = groupRooms.get(message.roomId);
      if (room) {
        if (!tokenMatches(room.tokenHash, message.token) || !tokenMatches(room.ownerKeyHash, message.ownerKey)) {
          fail(socket, 'UNAUTHORIZED_OWNER', 'A chave deste computador não corresponde ao criador da sala.');
          return;
        }
        room.maxParticipants = Math.max(room.maxParticipants, connectedGroupParticipants(room).length, maxParticipants);
        let owner = room.participants.get(room.ownerId);
        if (!owner) {
          owner = {
            id: room.ownerId,
            socket: null,
            profile: normalizeProfile(message.profile),
            joinedAt: Date.now(),
            sharing: false,
            microphoneEnabled: false,
            isOwner: true,
            expiryTimer: null
          };
          room.participants.set(owner.id, owner);
        }
        attachGroupParticipant(message.roomId, room, owner, socket, message.profile, true);
        return;
      }

      if (rooms.size + groupRooms.size >= MAX_ACTIVE_ROOMS) {
        fail(socket, 'SERVER_BUSY', 'O servidor atingiu o limite temporário de salas. Tente novamente em instantes.');
        return;
      }

      const ownerId = validPeerId(message.participantId) ? message.participantId : randomUUID();
      const owner = {
        id: ownerId,
        socket: null,
        profile: normalizeProfile(message.profile),
        joinedAt: Date.now(),
        sharing: false,
        microphoneEnabled: false,
        isOwner: true,
        expiryTimer: null
      };
      room = {
        token: message.token,
        tokenHash: tokenHash(message.token),
        joinCode: allocateJoinCode(),
        ownerKeyHash: tokenHash(message.ownerKey),
        ownerId,
        leaderId: ownerId,
        participants: new Map([[ownerId, owner]]),
        maxParticipants,
        expiryTimer: null
      };
      groupRooms.set(message.roomId, room);
      attachGroupParticipant(message.roomId, room, owner, socket, message.profile, false);
      return;
    }

    if (message.type === 'join-group-room' || message.type === 'join-group-room-code') {
      if (clients.has(socket) || groupClients.has(socket)) {
        fail(socket, 'ALREADY_JOINED', 'Este dispositivo já está em uma sala.');
        return;
      }
      const joiningByCode = message.type === 'join-group-room-code';
      const normalizedCode = String(message.code || '').trim().toUpperCase();
      if (joiningByCode && !allowJoinAttempt(address)) {
        fail(socket, 'RATE_LIMITED', 'Muitas tentativas de código. Aguarde um minuto antes de tentar novamente.');
        return;
      }
      if (joiningByCode ? !validJoinCode(normalizedCode) : !validRoomId(message.roomId) || !validToken(message.token)) {
        fail(socket, 'BAD_ROOM', 'O código da sala não é válido.');
        return;
      }
      const roomEntry = joiningByCode
        ? [...groupRooms.entries()].find(([, candidate]) => candidate.joinCode === normalizedCode)
        : [message.roomId, groupRooms.get(message.roomId)];
      const roomId = roomEntry?.[0];
      const room = roomEntry?.[1];
      if (!room || !roomId || (!joiningByCode && !tokenMatches(room.tokenHash, message.token))) {
        fail(socket, 'ROOM_NOT_FOUND', 'A sala não existe mais ou o código está incorreto.');
        return;
      }
      const requestedId = validPeerId(message.participantId) ? message.participantId : '';
      let participant = requestedId ? room.participants.get(requestedId) : null;
      if (participant?.isOwner) participant = null;
      const resumed = Boolean(participant);
      if (!participant) {
        if (connectedGroupParticipants(room).length >= room.maxParticipants) {
          fail(socket, 'ROOM_FULL', `A sala atingiu o limite de ${room.maxParticipants} participantes.`);
          return;
        }
        participant = {
          id: randomUUID(),
          socket: null,
          profile: normalizeProfile(message.profile),
          joinedAt: Date.now(),
          sharing: false,
          microphoneEnabled: false,
          isOwner: false,
          expiryTimer: null
        };
        room.participants.set(participant.id, participant);
      }
      attachGroupParticipant(roomId, room, participant, socket, message.profile, resumed);
      return;
    }

    const groupClient = groupClients.get(socket);
    if (groupClient) {
      const room = groupRooms.get(groupClient.roomId);
      const participant = room?.participants.get(groupClient.peerId);
      if (!room || !participant || participant.socket !== socket) {
        fail(socket, 'ROOM_NOT_FOUND', 'A sala não está mais disponível.');
        return;
      }

      if (message.type === 'leave-group-room') {
        detachGroupParticipant(groupClient.roomId, room, participant, { remove: !participant.isOwner });
        socket.close(1000, 'Participant left');
        return;
      }

      if (message.type === 'close-group-room') {
        if (!participant.isOwner) {
          fail(socket, 'OWNER_ONLY', 'Somente o criador pode encerrar a sala para todos.');
          return;
        }
        closeGroupRoom(groupClient.roomId);
        return;
      }

      if (message.type === 'peer-signal') {
        const target = typeof message.targetId === 'string' ? room.participants.get(message.targetId) : null;
        if (!target?.socket || target.socket.readyState !== WebSocket.OPEN) {
          fail(socket, 'PEER_OFFLINE', 'O outro participante está temporariamente offline.');
          return;
        }
        if (message.kind === 'offer' || message.kind === 'answer') {
          if (!validDescription(message.sdp) || message.sdp.type !== message.kind) {
            fail(socket, 'BAD_DESCRIPTION', 'Não foi possível negociar a conexão WebRTC.');
            return;
          }
          sendJson(target.socket, { type: 'peer-signal', fromId: participant.id, kind: message.kind, sdp: message.sdp });
          return;
        }
        if (message.kind === 'ice-candidate') {
          const candidate = normalizeIceCandidate(message.candidate);
          if (!candidate) {
            fail(socket, 'BAD_SIGNAL', 'Candidato ICE inválido.');
            return;
          }
          sendJson(target.socket, { type: 'peer-signal', fromId: participant.id, kind: 'ice-candidate', candidate });
          return;
        }
        fail(socket, 'BAD_SIGNAL', 'Sinal WebRTC inválido.');
        return;
      }

      if (message.type === 'chat-fallback') {
        const incoming = message.message;
        const id = typeof incoming?.id === 'string' && /^[a-z0-9._:-]{1,200}$/i.test(incoming.id) ? incoming.id : '';
        const text = typeof incoming?.text === 'string' ? incoming.text.trim().slice(0, 1_000) : '';
        const sentAt = Number(incoming?.sentAt);
        if (!id || !text) {
          fail(socket, 'BAD_CHAT', 'A mensagem enviada é inválida.');
          return;
        }
        broadcastGroup(room, {
          type: 'chat-fallback',
          message: {
            id,
            senderId: participant.id,
            senderName: participant.profile.name,
            text,
            sentAt: Number.isFinite(sentAt) && sentAt > 0 ? sentAt : Date.now()
          }
        }, participant.id);
        return;
      }

      if (message.type === 'chat-ack') {
        const targetId = typeof message.targetId === 'string' ? message.targetId : '';
        const messageId = typeof message.messageId === 'string' && /^[a-z0-9._:-]{1,200}$/i.test(message.messageId) ? message.messageId : '';
        if (!validPeerId(targetId) || targetId === participant.id || !messageId) {
          fail(socket, 'BAD_CHAT_ACK', 'A confirmação da mensagem é inválida.');
          return;
        }
        const target = room.participants.get(targetId);
        if (target?.socket?.readyState === WebSocket.OPEN) {
          sendJson(target.socket, { type: 'chat-ack', fromId: participant.id, messageId });
        }
        return;
      }

      if (message.type === 'participant-state') {
        participant.profile = normalizeProfile(message.profile || participant.profile);
        participant.sharing = Boolean(message.sharing);
        participant.microphoneEnabled = Boolean(message.microphoneEnabled);
        broadcastGroup(room, { type: 'participant-state', participant: publicParticipant(participant) }, participant.id);
        return;
      }

      fail(socket, 'UNKNOWN_MESSAGE', 'Mensagem não reconhecida.');
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
      const requestedMaxViewers = normalizeMaxViewers(message.maxViewers);
      const existing = rooms.get(message.roomId);
      if (existing) {
        if (!tokenMatches(existing.tokenHash, message.token)) {
          fail(socket, 'ROOM_EXISTS', 'Esta sala já está sendo usada.');
          return;
        }
        const oldHost = existing.host;
        if (oldHost && oldHost !== socket) {
          clients.delete(oldHost);
          if (oldHost.readyState === WebSocket.OPEN || oldHost.readyState === WebSocket.CONNECTING) {
            oldHost.close(4003, 'Host signal replaced');
          }
        }
        clearExpiry(existing, 'hostExpiryTimer');
        existing.host = socket;
        existing.maxViewers = Math.max(existing.viewers.size, requestedMaxViewers);
        clients.set(socket, { role: 'host', roomId: message.roomId });
        sendJson(socket, {
          type: 'room-created',
          roomId: message.roomId,
          iceServers,
          maxViewers: existing.maxViewers,
          viewerIds: [...existing.viewers.keys()]
        });
        return;
      }

      if (rooms.size + groupRooms.size >= MAX_ACTIVE_ROOMS) {
        fail(socket, 'SERVER_BUSY', 'O servidor atingiu o limite temporário de salas. Tente novamente em instantes.');
        return;
      }

      const room = {
        tokenHash: tokenHash(message.token),
        host: socket,
        hostExpiryTimer: null,
        viewers: new Map(),
        maxViewers: requestedMaxViewers
      };
      rooms.set(message.roomId, room);
      clients.set(socket, { role: 'host', roomId: message.roomId });
      sendJson(socket, { type: 'room-created', roomId: message.roomId, iceServers, maxViewers: room.maxViewers, viewerIds: [] });
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
      if (!room || room.host?.readyState !== WebSocket.OPEN) {
        fail(socket, 'HOST_OFFLINE', 'O computador ainda não está compartilhando.');
        return;
      }
      if (!tokenMatches(room.tokenHash, message.token)) {
        fail(socket, 'UNAUTHORIZED', 'Este link privado não é válido.');
        return;
      }

      const requestedPeerId = validPeerId(message.peerId) ? message.peerId : '';
      const resumedViewer = requestedPeerId ? room.viewers.get(requestedPeerId) : null;
      if (resumedViewer) {
        clearExpiry(resumedViewer, 'expiryTimer');
        const previousSocket = resumedViewer.socket;
        if (previousSocket && previousSocket !== socket) {
          clients.delete(previousSocket);
          if (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING) {
            previousSocket.close(4003, 'Viewer signal replaced');
          }
        }
        resumedViewer.socket = socket;
        clients.set(socket, { role: 'viewer', roomId: message.roomId, peerId: resumedViewer.id });
        sendJson(socket, { type: 'joined', roomId: message.roomId, peerId: resumedViewer.id, iceServers, resumed: true });
        sendJson(room.host, { type: 'viewer-joined', peerId: resumedViewer.id, resumed: true });
        return;
      }

      if (room.viewers.size >= room.maxViewers) {
        fail(socket, 'ROOM_FULL', `Esta transmissão atingiu o limite de ${room.maxViewers} espectador${room.maxViewers === 1 ? '' : 'es'}.`);
        return;
      }

      const peerId = randomUUID();
      const viewer = { id: peerId, socket, expiryTimer: null };
      room.viewers.set(peerId, viewer);
      clients.set(socket, { role: 'viewer', roomId: message.roomId, peerId });
      sendJson(socket, { type: 'joined', roomId: message.roomId, peerId, iceServers, resumed: false });
      sendJson(room.host, { type: 'viewer-joined', peerId, resumed: false });
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
      } else if (client.peerId) {
        closeViewer(room, client.peerId);
      }
      return;
    }

    if (message.type === 'offer' || message.type === 'answer') {
      const expectedSdpType = message.type;
      if (typeof message.peerId !== 'string' || !validDescription(message.sdp) || message.sdp.type !== expectedSdpType) {
        fail(socket, message.type === 'offer' ? 'BAD_OFFER' : 'BAD_ANSWER', 'Não foi possível negociar a conexão WebRTC.');
        return;
      }
      if (client.role === 'host') {
        if (!relayToViewer(room, message.peerId, { type: message.type, peerId: message.peerId, sdp: message.sdp })) {
          fail(socket, 'PEER_OFFLINE', 'O espectador está temporariamente sem sinalização.');
        }
      } else if (client.peerId === message.peerId && room.host?.readyState === WebSocket.OPEN) {
        sendJson(room.host, { type: message.type, peerId: message.peerId, sdp: message.sdp });
      } else {
        fail(socket, 'BAD_PEER', 'O dispositivo remoto não está disponível.');
      }
      return;
    }

    if (message.type === 'ice-candidate') {
      const candidate = normalizeIceCandidate(message.candidate);
      if (typeof message.peerId !== 'string' || !candidate) {
        fail(socket, 'BAD_CANDIDATE', 'Candidato ICE inválido.');
        return;
      }
      if (client.role === 'host') {
        relayToViewer(room, message.peerId, { type: 'ice-candidate', peerId: message.peerId, candidate });
      } else if (client.peerId === message.peerId && room.host?.readyState === WebSocket.OPEN) {
        sendJson(room.host, { type: 'ice-candidate', peerId: message.peerId, candidate });
      }
      return;
    }

    if (message.type === 'media-state') {
      if (
        client.role !== 'host' ||
        !room.viewers.has(message.peerId) ||
        typeof message.screenSharing !== 'boolean' ||
        typeof message.videoPaused !== 'boolean' ||
        typeof message.screenAudioEnabled !== 'boolean' ||
        typeof message.microphoneEnabled !== 'boolean'
      ) {
        fail(socket, 'BAD_MEDIA_STATE', 'Não foi possível atualizar os controles da transmissão.');
        return;
      }
      relayToViewer(room, message.peerId, {
        type: 'media-state',
        peerId: message.peerId,
        screenSharing: message.screenSharing,
        videoPaused: message.videoPaused,
        screenAudioEnabled: message.screenAudioEnabled,
        microphoneEnabled: message.microphoneEnabled
      });
      return;
    }

    fail(socket, 'UNKNOWN_MESSAGE', 'Mensagem não reconhecida.');
    } catch {
      fail(socket, 'SERVER_ERROR', 'Não foi possível processar esta ação.');
      try {
        socket.close(1011, 'Message processing failed');
      } catch {
        socket.terminate();
      }
    }
  });

  socket.on('close', () => {
    const groupClient = groupClients.get(socket);
    if (groupClient) {
      groupClients.delete(socket);
      const room = groupRooms.get(groupClient.roomId);
      const participant = room?.participants.get(groupClient.peerId);
      if (room && participant?.socket === socket) detachGroupParticipant(groupClient.roomId, room, participant);
      return;
    }
    const client = clients.get(socket);
    if (!client) return;
    clients.delete(socket);
    const room = rooms.get(client.roomId);
    if (!room) return;
    if (client.role === 'host') {
      detachHost(client.roomId, room, socket);
    } else if (client.peerId) {
      const viewer = room.viewers.get(client.peerId);
      if (viewer?.socket === socket) detachViewer(room, viewer);
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
  console.log(`Modo WebRTC P2P + STUN${turnEnabled ? ' + TURN fallback' : ''}.`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const roomId of [...groupRooms.keys()]) closeGroupRoom(roomId);
  for (const roomId of [...rooms.keys()]) endRoom(roomId, { hostEnded: true });
  for (const socket of websocketServer.clients) socket.close(1001, 'Server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
