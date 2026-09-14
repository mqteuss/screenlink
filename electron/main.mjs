import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerDisplayMedia } from './display-picker.mjs';
import { registerProfileIpc } from './profile-store.mjs';

const ELECTRON_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ELECTRON_DIR, '..');
const PRELOAD_PATH = path.join(ELECTRON_DIR, 'preload.mjs');
const APP_ID = 'app.screenlink.desktop';
const DEFAULT_APP_URL = 'https://screenlink-jgnx.onrender.com/';
const ALLOWED_PERMISSIONS = new Set([
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'media'
]);

let mainWindow = null;
let trustedOrigin = '';
let appUrlToLoad = '';
let disposeProfileIpc = null;
let disposeDisplayMedia = null;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName('ScreenLink');
app.setAppUserModelId(APP_ID);

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function normalizeAppUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function isTrustedUrl(value) {
  return Boolean(trustedOrigin) && originOf(value) === trustedOrigin;
}

function isSafeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function isTrustedSender(event) {
  const frameUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
  return isTrustedUrl(frameUrl);
}

function probePort(port) {
  return new Promise(resolve => {
    const probe = createNetServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '0.0.0.0', port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(firstPort = 8787, attempts = 40) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = firstPort + offset;
    if (await probePort(port)) return port;
  }
  throw new Error('Nenhuma porta local livre foi encontrada para iniciar o ScreenLink.');
}

async function waitForHealth(origin, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`, { cache: 'no-store' });
      if (response.ok) return;
    } catch {
      // O servidor local pode ainda estar carregando os módulos empacotados.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('O servidor local do ScreenLink não respondeu a tempo.');
}

async function startBundledServer() {
  const port = await findAvailablePort();
  process.env.PORT = String(port);
  process.env.HOST = '0.0.0.0';
  process.env.SCREENLINK_EMBEDDED = '1';
  const localOrigin = `http://127.0.0.1:${port}`;
  await import(pathToFileURL(path.join(APP_ROOT, 'server.mjs')).href);
  await waitForHealth(localOrigin);
  return localOrigin;
}

async function waitForRemoteHealth(appUrl, timeoutMs = 55_000) {
  const healthUrl = new URL('/health', appUrl).href;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(6_000)
      });
      if (response.ok) return;
    } catch {
      // O Render pode estar em cold start; a tela de abertura permanece visível.
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('O serviço público não respondeu a tempo.');
}

async function resolveAppUrl() {
  const configuredValue = String(process.env.SCREENLINK_APP_URL || '').trim();
  if (configuredValue.toLowerCase() === 'local') return startBundledServer();

  const remoteUrl = normalizeAppUrl(configuredValue || DEFAULT_APP_URL);
  if (!remoteUrl) throw new Error('SCREENLINK_APP_URL precisa ser HTTPS ou uma origem local segura.');
  try {
    await waitForRemoteHealth(remoteUrl);
    return remoteUrl;
  } catch (error) {
    console.warn('Serviço público indisponível; iniciando o modo local.', error);
    return startBundledServer();
  }
}

function configureSession() {
  const appSession = session.defaultSession;

  appSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const source = requestingOrigin || webContents?.getURL?.() || '';
    return ALLOWED_PERMISSIONS.has(permission) && isTrustedUrl(source);
  });

  appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const source = details?.requestingUrl || webContents?.getURL?.() || '';
    callback(ALLOWED_PERMISSIONS.has(permission) && isTrustedUrl(source));
  });

  disposeDisplayMedia = registerDisplayMedia({
    targetSession: appSession,
    getParentWindow: () => mainWindow,
    isTrustedRequest: request => {
      try {
        const isTopFrame = !request.frame || request.frame === request.frame.top;
        return isTopFrame && isTrustedUrl(request.securityOrigin);
      } catch {
        return false;
      }
    }
  });
}

function configureWindowSecurity(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });

  window.webContents.on('will-attach-webview', event => event.preventDefault());
}

async function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 920,
    minHeight: 620,
    show: false,
    title: 'ScreenLink',
    backgroundColor: '#080b0d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });

  mainWindow = window;
  configureWindowSecurity(window);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  await window.loadFile(path.join(ELECTRON_DIR, 'loading.html'));
  return window;
}

async function bootstrap() {
  configureSession();
  disposeProfileIpc = registerProfileIpc({
    ipcMain,
    userDataDirectory: app.getPath('userData'),
    isTrustedSender
  });

  const window = await createMainWindow();
  const appUrl = await resolveAppUrl();
  appUrlToLoad = appUrl;
  trustedOrigin = originOf(appUrl);
  if (!trustedOrigin) throw new Error('A origem do ScreenLink é inválida.');
  await window.loadURL(appUrl);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady()
    .then(bootstrap)
    .catch(error => {
      console.error(error);
      dialog.showErrorBox('ScreenLink não iniciou', error instanceof Error ? error.message : String(error));
      app.quit();
    });
}

app.on('activate', () => {
  if (!mainWindow && appUrlToLoad) {
    void createMainWindow()
      .then(window => window.loadURL(appUrlToLoad))
      .catch(console.error);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  disposeDisplayMedia?.();
  disposeDisplayMedia = null;
  disposeProfileIpc?.();
  disposeProfileIpc = null;
});
