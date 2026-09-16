import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roomCss = await readFile(path.join(PROJECT_DIR, 'src', 'room.css'), 'utf8');
assert.match(roomCss, /\.unified-room-stage \.screen-tile video\s*\{[^}]*opacity:\s*1;/, 'The active screen tile must override the legacy hidden-video opacity.');
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
    STUN_URLS: 'stun:stun.cloudflare.com:3478',
    TURN_URLS: 'turn:turn.example.test:3478?transport=udp',
    TURN_USERNAME: 'screenlink-test',
    TURN_CREDENTIAL: 'screenlink-secret',
    PARTICIPANT_RECONNECT_GRACE_MS: '250'
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

function connect(options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL, options);
    const timer = setTimeout(() => reject(new Error('WebSocket connection timed out')), 3_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function expectOriginRejected(origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL, { origin });
    const timer = setTimeout(() => reject(new Error('Disallowed WebSocket origin was not rejected')), 3_000);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      try {
        assert.equal(response.statusCode, 403);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once('open', () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error('Disallowed WebSocket origin connected successfully'));
    });
    socket.once('error', () => undefined);
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
  assert.equal(initialHealth.mode, 'p2p-mesh');

  const page = await fetch(HTTP_URL);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('permissions-policy'), 'camera=(), microphone=(self), display-capture=(self)');
  assert.equal(page.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(page.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-permitted-cross-domain-policies'), 'none');
  assert.match(page.headers.get('content-security-policy') || '', /style-src-attr 'unsafe-inline'/);
  assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.match(await page.text(), /<div id="root"><\/div>/);

  const runtimeConfig = await (await fetch(`${HTTP_URL}/runtime-config`)).json();
  assert.equal(runtimeConfig.viewerOrigin, 'https://screenlink.example.test');
  assert.equal(runtimeConfig.mode, 'p2p-mesh');
  await expectOriginRejected('https://malicious.example.test');
  const sameDeploymentOrigin = await connect({ origin: 'https://screenlink.example.test' });
  sameDeploymentOrigin.close();

  let host = await connect();
  const viewer = await connect();
  const viewerTwo = await connect();
  const viewerThree = await connect();
  const extraViewer = await connect();
  sockets.push(host, viewer, viewerTwo, viewerThree, extraViewer);

  const roomCreated = nextMessage(host, 'room-created');
  send(host, { type: 'create-room', roomId, token, maxViewers: 3 });
  const created = await roomCreated;
  assert.equal(created.roomId, roomId);
  assert.equal(created.maxViewers, 3);
  assert.ok(created.iceServers.some(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(url => String(url).startsWith('turn:'));
  }));

  const viewerJoined = nextMessage(viewer, 'joined');
  const hostSawViewer = nextMessage(host, 'viewer-joined');
  send(viewer, { type: 'join-room', roomId, token });
  const joined = await viewerJoined;
  assert.match(joined.resumeToken, /^[A-Za-z0-9_-]{32,128}$/);
  const hostJoin = await hostSawViewer;
  assert.equal(hostJoin.peerId, joined.peerId);

  const viewerTwoJoined = nextMessage(viewerTwo, 'joined');
  const hostSawViewerTwo = nextMessage(host, 'viewer-joined');
  send(viewerTwo, { type: 'join-room', roomId, token });
  const joinedTwo = await viewerTwoJoined;
  assert.equal((await hostSawViewerTwo).peerId, joinedTwo.peerId);

  const viewerThreeJoined = nextMessage(viewerThree, 'joined');
  const hostSawViewerThree = nextMessage(host, 'viewer-joined');
  send(viewerThree, { type: 'join-room', roomId, token });
  const joinedThree = await viewerThreeJoined;
  assert.equal((await hostSawViewerThree).peerId, joinedThree.peerId);

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
  send(host, { type: 'ice-candidate', peerId: joined.peerId, candidate: { candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.equal((await candidateReceived).candidate.candidate, 'candidate:test');

  const viewerMicrophoneOffer = nextMessage(host, 'offer');
  send(viewer, { type: 'offer', peerId: joined.peerId, sdp: { type: 'offer', sdp: 'v=0\r\na=sendonly\r\n' } });
  assert.equal((await viewerMicrophoneOffer).peerId, joined.peerId);

  const viewerMicrophoneAnswer = nextMessage(viewer, 'answer');
  send(host, { type: 'answer', peerId: joined.peerId, sdp: { type: 'answer', sdp: 'v=0\r\na=recvonly\r\n' } });
  assert.equal((await viewerMicrophoneAnswer).peerId, joined.peerId);

  host.terminate();
  await delay(50);
  host = await connect();
  sockets.push(host);
  const resumedRoom = nextMessage(host, 'room-created');
  send(host, { type: 'create-room', roomId, token, maxViewers: 3 });
  const resumed = await resumedRoom;
  assert.equal(resumed.maxViewers, 3);
  assert.deepEqual(new Set(resumed.viewerIds), new Set([joined.peerId, joinedTwo.peerId, joinedThree.peerId]));

  const reconnectId = joinedTwo.peerId;
  viewerTwo.terminate();
  await delay(50);
  const viewerTwoReconnect = await connect();
  sockets.push(viewerTwoReconnect);
  const viewerTwoRejoined = nextMessage(viewerTwoReconnect, 'joined');
  send(viewerTwoReconnect, { type: 'join-room', roomId, token, peerId: reconnectId, resumeToken: joinedTwo.resumeToken });
  const rejoinedViewerTwo = await viewerTwoRejoined;
  assert.equal(rejoinedViewerTwo.peerId, reconnectId);
  assert.equal(rejoinedViewerTwo.resumed, true);

  const viewerLeft = nextMessage(host, 'viewer-left');
  send(viewer, { type: 'leave-room' });
  assert.equal((await viewerLeft).peerId, joined.peerId);

  const extraJoined = nextMessage(extraViewer, 'joined');
  const hostSawExtra = nextMessage(host, 'viewer-joined');
  send(extraViewer, { type: 'join-room', roomId, token });
  const extra = await extraJoined;
  assert.equal((await hostSawExtra).peerId, extra.peerId);

  const hostEndedTwo = nextMessage(viewerTwoReconnect, 'host-ended');
  const hostEndedThree = nextMessage(viewerThree, 'host-ended');
  const hostEndedExtra = nextMessage(extraViewer, 'host-ended');
  send(host, { type: 'leave-room' });
  await Promise.all([hostEndedTwo, hostEndedThree, hostEndedExtra]);

  const invalidCodeClient = await connect();
  sockets.push(invalidCodeClient);
  const invalidCode = nextMessage(invalidCodeClient, 'error');
  send(invalidCodeClient, { type: 'join-group-room-code', code: 'ABCD', profile: { name: 'Teste', avatar: 'orbit', status: 'Teste', device: 'desktop' } });
  assert.equal((await invalidCode).code, 'BAD_ROOM');

  let roomOwner = await connect();
  const roomMember = await connect();
  let roomMemberTwo = await connect();
  sockets.push(roomOwner, roomMember, roomMemberTwo);
  const ownerKey = 'owner_1234567890_abcdefghijklmnopqrstuvwxyz';
  const ownerReady = nextMessage(roomOwner, 'room-ready');
  send(roomOwner, {
    type: 'create-group-room',
    roomId,
    token,
    ownerKey,
    maxParticipants: 8,
    profile: { name: 'Criador', avatar: 'orbit', status: 'Pronto para jogar', device: 'desktop' }
  });
  const ownerSession = await ownerReady;
  assert.equal(ownerSession.leaderId, ownerSession.selfId);
  assert.equal(ownerSession.participants.length, 1);
  assert.match(ownerSession.joinCode, /^[A-Z2-9]{6}$/);
  assert.deepEqual(ownerSession.invite, { roomId, token });
  assert.equal(ownerSession.participants[0].status, 'Pronto para jogar');

  const memberReady = nextMessage(roomMember, 'room-ready');
  const ownerSawMember = nextMessage(roomOwner, 'participant-joined');
  send(roomMember, {
    type: 'join-group-room',
    roomId,
    token,
    profile: { name: 'Membro 1', avatar: 'nova', status: 'Ouvindo', device: 'desktop' }
  });
  const memberSession = await memberReady;
  assert.equal((await ownerSawMember).participant.id, memberSession.selfId);
  assert.equal(memberSession.leaderId, ownerSession.selfId);
  assert.match(memberSession.resumeToken, /^[A-Za-z0-9_-]{32,128}$/);

  const memberTwoReady = nextMessage(roomMemberTwo, 'room-ready');
  const ownerSawMemberTwo = nextMessage(roomOwner, 'participant-joined');
  send(roomMemberTwo, {
    type: 'join-group-room-code',
    code: ownerSession.joinCode,
    profile: { name: 'Membro 2', avatar: 'pixel', status: 'No celular', device: 'mobile' }
  });
  const memberTwoSession = await memberTwoReady;
  assert.equal((await ownerSawMemberTwo).participant.id, memberTwoSession.selfId);
  assert.deepEqual(memberTwoSession.invite, { roomId, token });
  assert.match(memberTwoSession.resumeToken, /^[A-Za-z0-9_-]{32,128}$/);

  roomMemberTwo.terminate();
  await delay(50);
  const roomMemberTwoReconnect = await connect();
  sockets.push(roomMemberTwoReconnect);
  const memberTwoResumed = nextMessage(roomMemberTwoReconnect, 'room-ready');
  const ownerSawMemberTwoResume = nextMessage(roomOwner, 'participant-state');
  send(roomMemberTwoReconnect, {
    type: 'join-group-room-code',
    code: ownerSession.joinCode,
    participantId: memberTwoSession.selfId,
    resumeToken: memberTwoSession.resumeToken,
    profile: { name: 'Membro 2', avatar: 'pixel', status: 'Reconectado', device: 'mobile' }
  });
  const resumedMemberTwoSession = await memberTwoResumed;
  assert.equal(resumedMemberTwoSession.selfId, memberTwoSession.selfId);
  assert.equal(resumedMemberTwoSession.resumed, true);
  assert.equal((await ownerSawMemberTwoResume).participant.id, memberTwoSession.selfId);
  roomMemberTwo = roomMemberTwoReconnect;

  const impersonator = await connect();
  sockets.push(impersonator);
  const impersonatorReady = nextMessage(impersonator, 'room-ready');
  const ownerSawImpersonator = nextMessage(roomOwner, 'participant-joined');
  send(impersonator, {
    type: 'join-group-room-code',
    code: ownerSession.joinCode,
    participantId: memberSession.selfId,
    resumeToken: 'invalid_resume_token_that_cannot_match_1234567890',
    profile: { name: 'Impostor', avatar: 'orbit', status: 'Teste de segurança', device: 'desktop' }
  });
  const impersonatorSession = await impersonatorReady;
  assert.notEqual(impersonatorSession.selfId, memberSession.selfId);
  assert.equal(impersonatorSession.resumed, false);
  assert.equal((await ownerSawImpersonator).participant.id, impersonatorSession.selfId);
  assert.equal(roomMember.readyState, WebSocket.OPEN);
  const ownerSawImpersonatorLeave = nextMessage(roomOwner, 'participant-left');
  send(impersonator, { type: 'leave-group-room' });
  assert.equal((await ownerSawImpersonatorLeave).peerId, impersonatorSession.selfId);

  const memberSignal = nextMessage(roomMember, 'peer-signal');
  send(roomMemberTwo, { type: 'peer-signal', targetId: memberSession.selfId, kind: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\n' } });
  const relayedGroupOffer = await memberSignal;
  assert.equal(relayedGroupOffer.fromId, memberTwoSession.selfId);

  const invalidCandidate = nextMessage(roomMemberTwo, 'error');
  send(roomMemberTwo, { type: 'peer-signal', targetId: memberSession.selfId, kind: 'ice-candidate', candidate: { candidate: 'candidate:missing-mid' } });
  assert.equal((await invalidCandidate).code, 'BAD_SIGNAL');

  const ownerChatFallback = nextMessage(roomOwner, 'chat-fallback');
  const memberTwoChatFallback = nextMessage(roomMemberTwo, 'chat-fallback');
  send(roomMember, { type: 'chat-fallback', message: { id: 'fallback-chat-1', text: 'mensagem de fallback', sentAt: 123456789 } });
  const [ownerFallbackMessage, memberTwoFallbackMessage] = await Promise.all([ownerChatFallback, memberTwoChatFallback]);
  assert.equal(ownerFallbackMessage.message.id, 'fallback-chat-1');
  assert.equal(ownerFallbackMessage.message.text, 'mensagem de fallback');
  assert.equal(ownerFallbackMessage.message.senderId, memberSession.selfId);
  assert.equal(ownerFallbackMessage.message.senderName, 'Membro 1');
  assert.equal(memberTwoFallbackMessage.message.id, 'fallback-chat-1');
  assert.equal(memberTwoFallbackMessage.message.senderId, memberSession.selfId);

  const memberChatAck = nextMessage(roomMember, 'chat-ack');
  send(roomOwner, { type: 'chat-ack', targetId: memberSession.selfId, messageId: 'fallback-chat-1' });
  const relayedChatAck = await memberChatAck;
  assert.equal(relayedChatAck.fromId, ownerSession.selfId);
  assert.equal(relayedChatAck.messageId, 'fallback-chat-1');

  const invalidChatAck = nextMessage(roomMemberTwo, 'error');
  send(roomMemberTwo, { type: 'chat-ack', targetId: memberTwoSession.selfId, messageId: 'fallback-chat-1' });
  assert.equal((await invalidChatAck).code, 'BAD_CHAT_ACK');

  const ownerState = nextMessage(roomOwner, 'participant-state');
  send(roomMember, {
    type: 'participant-state',
    profile: { name: 'Membro 1', avatar: 'nova', status: 'Compartilhando agora', device: 'desktop' },
    sharing: true,
    microphoneEnabled: true
  });
  const sharedState = await ownerState;
  assert.equal(sharedState.participant.sharing, true);
  assert.equal(sharedState.participant.microphoneEnabled, true);
  assert.equal(sharedState.participant.status, 'Compartilhando agora');

  const promoted = nextMessage(roomMember, 'leader-changed');
  roomOwner.terminate();
  assert.equal((await promoted).leaderId, memberSession.selfId);

  roomOwner = await connect();
  sockets.push(roomOwner);
  const reclaimedReady = nextMessage(roomOwner, 'room-ready');
  const reclaimedLeadership = nextMessage(roomMember, 'leader-changed');
  send(roomOwner, {
    type: 'create-group-room',
    roomId,
    token,
    ownerKey,
    participantId: ownerSession.selfId,
    maxParticipants: 8,
    profile: { name: 'Criador', avatar: 'orbit', status: 'Voltei', device: 'desktop' }
  });
  const reclaimedSession = await reclaimedReady;
  assert.equal(reclaimedSession.selfId, ownerSession.selfId);
  assert.equal((await reclaimedLeadership).leaderId, ownerSession.selfId);

  const roomClosedOne = nextMessage(roomMember, 'room-closed');
  const roomClosedTwo = nextMessage(roomMemberTwo, 'room-closed');
  send(roomOwner, { type: 'close-group-room' });
  await Promise.all([roomClosedOne, roomClosedTwo]);

  await delay(50);
  const finalHealth = await (await fetch(`${HTTP_URL}/health`)).json();
  assert.equal(finalHealth.rooms, 0);

  console.log('PASS: security headers/origin checks, authenticated session resume, validated signaling, mesh presence/chat delivery/screen state, reconnect grace, leader migration, owner reclaim, optional ICE fallback, and shutdown flow.');
} finally {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
  child.kill('SIGTERM');
}
