import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { registerDisplayMedia } from '../electron/display-picker.mjs';
import { mediaPermissionKind } from '../electron/media-permissions.mjs';
import { registerProfileIpc } from '../electron/profile-store.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, '..');

function waitFor(check, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch {
        // A página pode estar entre navegações.
      }
      if (Date.now() >= deadline) return reject(new Error('Tempo esgotado aguardando o seletor integrado.'));
      setTimeout(poll, 50);
    };
    void poll();
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

app.whenReady().then(async () => {
  let disposeDisplayMedia = null;
  let disposeProfileIpc = null;
  let window = null;
  let exitCode = 0;
  try {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    process.env.PORT = String(port);
    process.env.HOST = '127.0.0.1';
    await import('../server.mjs');

    window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 720,
      backgroundColor: '#080b0d',
      webPreferences: {
        preload: path.join(APP_ROOT, 'electron', 'preload.cjs'),
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
      return allowedPermissions.has(permission) && isTrustedUrl(source);
    });
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const source = details?.requestingUrl || webContents?.getURL?.() || '';
      const mediaKind = mediaPermissionKind(details);
      callback(allowedPermissions.has(permission)
        && isTrustedUrl(source)
        && (permission !== 'media' || mediaKind === 'display' || mediaKind === 'microphone'));
    });
    const isTrustedSender = event => isTrustedUrl(event?.senderFrame?.url || event?.sender?.getURL?.() || '');
    disposeProfileIpc = registerProfileIpc({
      ipcMain,
      userDataDirectory: app.getPath('userData'),
      isTrustedSender
    });
    ipcMain.handle('screenlink:update:get-state', () => ({
      status: 'development', currentVersion: app.getVersion(), version: '', percent: null,
      transferred: null, total: null, message: 'Teste local', notice: false, canAutoUpdate: false
    }));
    disposeDisplayMedia = registerDisplayMedia({
      targetSession: session.defaultSession,
      getParentWindow: () => window,
      isTrustedSender,
      isTrustedRequest: request => isTrustedUrl(request.securityOrigin)
    });

    await window.loadURL(origin);
    await window.webContents.executeJavaScript("localStorage.setItem('screenlink-onboarding-v1', 'complete'); location.reload(); true;");
    await waitFor(() => window.webContents.executeJavaScript("document.readyState === 'complete' && Boolean(document.querySelector('.unified-room-app'))"));
    await window.webContents.executeJavaScript(`
      window.captureFinished = false;
      window.captureError = '';
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        .then(stream => {
          window.captureStream = stream;
          window.captureFinished = true;
        })
        .catch(error => {
          window.captureError = error?.name + ': ' + error?.message;
          window.captureFinished = true;
        });
      true;
    `, true);

    const uiState = await waitFor(() => window.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.desktop-display-picker');
      const backdrop = document.querySelector('.desktop-display-picker-backdrop');
      const cards = [...document.querySelectorAll('.desktop-display-source')];
      if (!dialog || !backdrop || !cards.length) return null;
      const style = getComputedStyle(dialog);
      const opacity = Number.parseFloat(style.opacity);
      const backdropOpacity = Number.parseFloat(getComputedStyle(backdrop).opacity);
      if (opacity < .99 || backdropOpacity < .99) return null;
      return {
        title: document.querySelector('#desktop-display-picker-title')?.textContent,
        cardCount: cards.length,
        backdropCount: document.querySelectorAll('.desktop-display-picker-backdrop').length,
        modalVisible: style.visibility !== 'hidden' && style.display !== 'none' && opacity >= .99,
        selectedTab: document.querySelector('.desktop-display-picker-tabs .is-active')?.textContent?.trim()
      };
    })()`));
    assert.equal(uiState.title, 'Compartilhar tela');
    assert.ok(uiState.cardCount > 0);
    assert.equal(uiState.backdropCount, 1);
    assert.equal(uiState.modalVisible, true);
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'O fluxo integrado abriu outra janela do Electron.');

    const screenshotPath = path.join(tmpdir(), 'screenlink-integrated-display-picker.png');
    const screenshot = await window.webContents.capturePage();
    await writeFile(screenshotPath, screenshot.toPNG());

    await window.webContents.executeJavaScript("document.querySelector('.desktop-display-source')?.click()");
    await waitFor(() => window.webContents.executeJavaScript('window.captureFinished'));
    const result = await window.webContents.executeJavaScript(`({
      error: window.captureError,
      hasVideo: Boolean(window.captureStream?.getVideoTracks()[0]),
      hasAudio: Boolean(window.captureStream?.getAudioTracks()[0]),
      pickerStillOpen: Boolean(document.querySelector('.desktop-display-picker-backdrop'))
    })`);
    assert.equal(result.error, '');
    assert.equal(result.hasVideo, true);
    if (process.platform === 'win32') assert.equal(result.hasAudio, true);
    await waitFor(() => window.webContents.executeJavaScript("!document.querySelector('.desktop-display-picker-backdrop')"));
    await window.webContents.executeJavaScript("window.captureStream?.getTracks().forEach(track => track.stop())");

    console.log('PASS integrated picker UI', JSON.stringify({ uiState, result, screenshotPath, windowCount: BrowserWindow.getAllWindows().length }));
  } catch (error) {
    exitCode = 1;
    console.error('FAIL integrated picker UI', error);
  } finally {
    disposeDisplayMedia?.();
    disposeProfileIpc?.();
    ipcMain.removeHandler('screenlink:update:get-state');
    for (const currentWindow of BrowserWindow.getAllWindows()) {
      if (!currentWindow.isDestroyed()) currentWindow.destroy();
    }
    app.exit(exitCode);
  }
});
