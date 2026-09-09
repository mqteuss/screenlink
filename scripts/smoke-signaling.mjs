import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 19_000 + Math.floor(Math.random() * 1_000);
const HTTP_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: PROJECT_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PUBLIC_ORIGIN: 'https://screenlink.example.test/path-is-ignored',
    STUN_URLS: 'stun:stun.cloudflare.com:3478'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let childOutput = '';
child.stdout.on('data', chunk => { childOutput += chunk; });
child.stderr.on('data', chunk => { childOutput += chunk; });

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${HTTP_URL}/health`);
      if (response.ok) return response.json();
    } catch {
      // The process can take a moment to bind its port.
    }
    await delay(100);
  }
  throw new Error(`Server did not start.\n${childOutput}`);
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error('WebSocket connection timed out')), 3_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function nextMessage(socket, expectedType) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedType}`));
    }, 3_000);
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== expectedType) return;
      cleanup();
      resolve(message);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Socket closed while waiting for ${expectedType}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

function send(socket, message) {
  socket.send(JSON.stringify(message));
}

const roomId = 'room_1234567890';
const token = 'token_1234567890_abcdefghijklmnopqrstuvwxyz';
const sockets = [];

try {
  const initialHealth = await waitForServer();
  assert.equal(initialHealth.ok, true);
  assert.equal(initialHealth.mode, 'p2p-stun');

  const page = await fetch(HTTP_URL);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"><\/div>/);

  const runtimeConfig = await (await fetch(`${HTTP_URL}/runtime-config`)).json();
  assert.equal(runtimeConfig.viewerOrigin, 'https://screenlink.example.test');
  assert.equal(runtimeConfig.mode, 'p2p-stun');

  const host = await connect();
  const viewer = await connect();
  const extraViewer = await connect();
  sockets.push(host, viewer, extraViewer);

  const roomCreated = nextMessage(host, 'room-created');
  send(host, { type: 'create-room', roomId, token });
  const created = await roomCreated;
  assert.equal(created.roomId, roomId);
  assert.ok(created.iceServers.every(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.every(url => String(url).startsWith('stun:'));
  }));

  const viewerJoined = nextMessage(viewer, 'joined');
  const hostSawViewer = nextMessage(host, 'viewer-joined');
  send(viewer, { type: 'join-room', roomId, token });
  const joined = await viewerJoined;
  const hostJoin = await hostSawViewer;
  assert.equal(hostJoin.peerId, joined.peerId);

  const roomFull = nextMessage(extraViewer, 'error');
  send(extraViewer, { type: 'join-room', roomId, token });
  assert.equal((await roomFull).code, 'ROOM_FULL');

  const offerReceived = nextMessage(viewer, 'offer');
  send(host, { type: 'offer', peerId: joined.peerId, sdp: { type: 'offer', sdp: 'v=0\r\n' } });
  assert.equal((await offerReceived).peerId, joined.peerId);

  const answerReceived = nextMessage(host, 'answer');
  send(viewer, { type: 'answer', peerId: joined.peerId, sdp: { type: 'answer', sdp: 'v=0\r\n' } });
  assert.equal((await answerReceived).peerId, joined.peerId);

  const candidateReceived = nextMessage(viewer, 'ice-candidate');
  send(host, { type: 'ice-candidate', peerId: joined.peerId, candidate: { candidate: 'candidate:test' } });
  assert.equal((await candidateReceived).candidate.candidate, 'candidate:test');

  const viewerLeft = nextMessage(host, 'viewer-left');
  send(viewer, { type: 'leave-room' });
  assert.equal((await viewerLeft).peerId, joined.peerId);

  const replacementJoined = nextMessage(extraViewer, 'joined');
  const hostSawReplacement = nextMessage(host, 'viewer-joined');
  send(extraViewer, { type: 'join-room', roomId, token });
  const replacement = await replacementJoined;
  assert.equal((await hostSawReplacement).peerId, replacement.peerId);

  const hostEnded = nextMessage(extraViewer, 'host-ended');
  send(host, { type: 'leave-room' });
  await hostEnded;

  await delay(50);
  const finalHealth = await (await fetch(`${HTTP_URL}/health`)).json();
  assert.equal(finalHealth.rooms, 0);

  console.log('PASS: site, private room, one-viewer limit, P2P/STUN signaling, and shutdown flow.');
} finally {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
  child.kill('SIGTERM');
}
