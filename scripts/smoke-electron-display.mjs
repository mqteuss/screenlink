import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, session } from 'electron';
import { registerDisplayMedia } from '../electron/display-picker.mjs';

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

  const isAllowedPermission = permission => permission === 'display-capture' || permission === 'media';
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => isAllowedPermission(permission));
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(isAllowedPermission(permission)));
  disposeDisplayMedia = registerDisplayMedia({
    targetSession: session.defaultSession,
    getParentWindow: () => requester,
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
    hasProfileSave: typeof window.screenLinkProfile?.save === 'function'
  })`);
  assert.deepEqual(desktopBridge, { isDesktop: true, hasProfileLoad: true, hasProfileSave: true });
  console.log('INFO desktop bridges ready');
  console.log('INFO requester ready');
  await requester.webContents.executeJavaScript(`
    window.captureFinished = false;
    window.captureError = '';
    navigator.mediaDevices.getDisplayMedia({ video: true })
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

  const picker = await waitFor(() => BrowserWindow.getAllWindows().find(window => window !== requester));
  console.log('INFO picker opened');
  await waitFor(() => picker.webContents.executeJavaScript("document.readyState === 'complete'"));
  const pickerState = await waitFor(async () => {
    const state = await picker.webContents.executeJavaScript(`({
      bridgeReady: typeof window.screenLinkDisplayPicker?.list === 'function',
      screenCount: Number(document.querySelector('#screen-count')?.textContent || 0),
      windowCount: Number(document.querySelector('#window-count')?.textContent || 0),
      cardCount: document.querySelectorAll('.source-card').length,
      errorText: document.querySelector('#empty-state')?.hidden ? '' : document.querySelector('#empty-state')?.textContent
    })`);
    return state.bridgeReady && state.screenCount + state.windowCount > 0 ? state : null;
  });

  assert.equal(pickerState.bridgeReady, true);
  assert.ok(pickerState.screenCount > 0, 'Nenhuma tela foi enumerada pelo desktopCapturer.');
  assert.ok(pickerState.cardCount > 0, 'Nenhuma fonte foi renderizada no seletor.');
  console.log('INFO sources rendered', JSON.stringify(pickerState));
  await picker.webContents.executeJavaScript("document.querySelector('.source-card')?.click()");

  await waitFor(() => requester.webContents.executeJavaScript('window.captureFinished'));
  const captureResult = await requester.webContents.executeJavaScript(`({
    error: window.captureError,
    label: window.captureTrackLabel,
    hasVideo: Boolean(window.captureStream?.getVideoTracks()[0])
  })`);
  assert.equal(captureResult.error, '');
  assert.equal(captureResult.hasVideo, true);
  await requester.webContents.executeJavaScript("window.captureStream?.getTracks().forEach(track => track.stop())");

  console.log('PASS Electron display picker', JSON.stringify({ pickerState, captureResult }));
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
