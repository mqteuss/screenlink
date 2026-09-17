import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, session } from 'electron';
import { registerDisplayMedia } from '../electron/display-picker.mjs';
import { mediaPermissionKind } from '../electron/media-permissions.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(SCRIPT_DIR, '../electron');
const TEST_PAGE = `<!doctype html>
<html lang="pt-BR">
  <body><button id="share" type="button">Compartilhar</button></body>
</html>`;

function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check();
        if (value) {
          resolve(value);
          return;
        }
      } catch {
        // A janela pode ainda estar carregando.
      }
      if (Date.now() >= deadline) {
        reject(new Error('Tempo esgotado aguardando o seletor de tela.'));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

app.whenReady().then(async () => {
assert.equal(mediaPermissionKind({ mediaTypes: [] }), 'display');
assert.equal(mediaPermissionKind({ mediaTypes: ['audio'] }), 'microphone');
assert.equal(mediaPermissionKind({ mediaTypes: ['video'] }), 'deny');
assert.equal(mediaPermissionKind({ mediaTypes: ['audio', 'video'] }), 'deny');
const server = createServer((_request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'"
  });
  response.end(TEST_PAGE);
});

let disposeDisplayMedia = null;
let requester = null;
let exitCode = 0;

try {
  const address = await listen(server);
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  requester = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(ELECTRON_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const isTrustedUrl = value => {
    try {
      return new URL(value).origin === origin;
    } catch {
      return false;
    }
  };
  const allowedPermissions = new Set(['clipboard-sanitized-write', 'display-capture', 'fullscreen', 'media']);
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const source = requestingOrigin || webContents?.getURL?.() || '';
    const granted = allowedPermissions.has(permission) && isTrustedUrl(source);
    console.log('INFO permission check', JSON.stringify({ permission, source, granted }));
    return granted;
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const source = details?.requestingUrl || webContents?.getURL?.() || '';
    const requestedMedia = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    const mediaKind = mediaPermissionKind(details);
    const granted = allowedPermissions.has(permission)
      && isTrustedUrl(source)
      && (permission !== 'media' || mediaKind === 'display' || mediaKind === 'microphone');
    console.log('INFO permission request', JSON.stringify({ permission, source, requestedMedia, granted }));
    callback(granted);
  });
  disposeDisplayMedia = registerDisplayMedia({
    targetSession: session.defaultSession,
    getParentWindow: () => requester,
    isTrustedSender: event => isTrustedUrl(event?.senderFrame?.url || event?.sender?.getURL?.() || ''),
    isTrustedRequest: request => {
      console.log('INFO display handler called', JSON.stringify({
        videoRequested: request.videoRequested,
        audioRequested: request.audioRequested,
        securityOrigin: request.securityOrigin
      }));
      return true;
    }
  });

  await requester.loadURL(origin);
  const desktopBridge = await requester.webContents.executeJavaScript(`({
    isDesktop: window.screenLinkDesktop?.isDesktop,
    hasProfileLoad: typeof window.screenLinkProfile?.load === 'function',
    hasProfileSave: typeof window.screenLinkProfile?.save === 'function',
    hasDisplayState: typeof window.screenLinkDesktop?.onDisplayPickerState === 'function',
    hasDisplayChoose: typeof window.screenLinkDesktop?.chooseDisplaySource === 'function',
    hasDisplayCancel: typeof window.screenLinkDesktop?.cancelDisplayPicker === 'function'
  })`);
  assert.deepEqual(desktopBridge, { isDesktop: true, hasProfileLoad: true, hasProfileSave: true, hasDisplayState: true, hasDisplayChoose: true, hasDisplayCancel: true });
  console.log('INFO desktop bridges ready');
  console.log('INFO requester ready');
  await requester.webContents.executeJavaScript(`
    window.captureFinished = false;
    window.captureError = '';
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      .then(stream => {
        window.captureStream = stream;
        window.captureTrackLabel = stream.getVideoTracks()[0]?.label || '';
        window.captureFinished = true;
      })
      .catch(error => {
        window.captureError = error?.name + ': ' + error?.message;
        window.captureFinished = true;
      });
    true;
  `, true);
  console.log('INFO capture requested');
  await new Promise(resolve => setTimeout(resolve, 250));
  console.log('INFO capture state', await requester.webContents.executeJavaScript(`JSON.stringify({
    finished: window.captureFinished,
    error: window.captureError,
    mediaDevices: Boolean(navigator.mediaDevices),
    getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia
  })`));

  const pickerState = await waitFor(async () => {
    const state = await requester.webContents.executeJavaScript(`({
      open: document.querySelector('#screenlink-integrated-display-picker')?.dataset.open === 'true',
      sourceCount: Number(document.querySelector('#screenlink-integrated-display-picker')?.dataset.sourceCount || 0),
      cardCount: document.querySelector('#screenlink-integrated-display-picker')?.shadowRoot?.querySelectorAll('.source').length || 0,
      dialogDisplay: getComputedStyle(document.querySelector('#screenlink-integrated-display-picker')?.shadowRoot?.querySelector('.dialog')).display,
      dialogRadius: getComputedStyle(document.querySelector('#screenlink-integrated-display-picker')?.shadowRoot?.querySelector('.dialog')).borderRadius
    })`);
    return state.open && state.sourceCount > 0 && state.cardCount > 0 ? state : null;
  });

  assert.ok(pickerState.cardCount > 0, 'Nenhuma tela foi renderizada pelo fallback integrado.');
  assert.equal(pickerState.dialogDisplay, 'grid');
  assert.notEqual(pickerState.dialogRadius, '0px');
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'O seletor abriu uma BrowserWindow secundária.');
  console.log('INFO integrated sources delivered', JSON.stringify(pickerState));
  await requester.webContents.executeJavaScript("document.querySelector('#screenlink-integrated-display-picker').shadowRoot.querySelector('.source').click()");

  await waitFor(() => requester.webContents.executeJavaScript('window.captureFinished'));
  const captureResult = await requester.webContents.executeJavaScript(`({
    error: window.captureError,
    label: window.captureTrackLabel,
    hasVideo: Boolean(window.captureStream?.getVideoTracks()[0]),
    hasAudio: Boolean(window.captureStream?.getAudioTracks()[0])
  })`);
  assert.equal(captureResult.error, '');
  assert.equal(captureResult.hasVideo, true);
  if (process.platform === 'win32') assert.equal(captureResult.hasAudio, true);
  await requester.webContents.executeJavaScript(`
    window.captureStream?.getTracks().forEach(track => track.stop());
    window.captureFinished = false;
    window.captureError = '';
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      .then(stream => {
        stream.getTracks().forEach(track => track.stop());
        window.captureFinished = true;
      })
      .catch(error => {
        window.captureError = error?.name + ': ' + error?.message;
        window.captureFinished = true;
      });
    true;
  `);
  await waitFor(() => requester.webContents.executeJavaScript("document.querySelector('#screenlink-integrated-display-picker')?.dataset.open === 'true'"));
  await requester.webContents.executeJavaScript("document.querySelector('#screenlink-integrated-display-picker').shadowRoot.querySelector('[data-cancel]').click()");
  await waitFor(() => requester.webContents.executeJavaScript('window.captureFinished'));
  const cancelResult = await requester.webContents.executeJavaScript('window.captureError');
  assert.match(cancelResult, /NotAllowedError|AbortError/);
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'Cancelar abriu uma BrowserWindow secundária.');
  console.log('PASS integrated Electron display picker', JSON.stringify({ pickerState, captureResult, cancelResult, windowCount: BrowserWindow.getAllWindows().length }));
} catch (error) {
  exitCode = 1;
  console.error('FAIL Electron display picker', error);
} finally {
  disposeDisplayMedia?.();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
  }
  server.closeAllConnections();
  server.close();
  app.exit(exitCode);
}
});
