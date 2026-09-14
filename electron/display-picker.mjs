import { BrowserWindow, desktopCapturer, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ELECTRON_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIST_CHANNEL = 'screenlink:display-picker:list';
const CHOOSE_CHANNEL = 'screenlink:display-picker:choose';
const CANCEL_CHANNEL = 'screenlink:display-picker:cancel';

function sourceKind(source) {
  return source.id.startsWith('screen:') ? 'screen' : 'window';
}

function serializeSource(source) {
  return {
    id: source.id,
    name: source.name,
    kind: sourceKind(source),
    thumbnail: source.thumbnail.toDataURL(),
    appIcon: source.appIcon?.isEmpty() ? null : source.appIcon?.toDataURL() || null
  };
}

export function registerDisplayMedia({ targetSession, getParentWindow, isTrustedRequest }) {
  let activePicker = null;

  function isActivePickerEvent(event) {
    return Boolean(
      activePicker
      && !activePicker.window.isDestroyed()
      && event.sender?.id === activePicker.window.webContents.id
      && event.senderFrame === activePicker.window.webContents.mainFrame
    );
  }

  function settlePicker(sourceId = null) {
    const picker = activePicker;
    if (!picker || picker.settled) return;
    picker.settled = true;
    activePicker = null;
    const source = sourceId ? picker.sources.find(candidate => candidate.id === sourceId) ?? null : null;
    picker.resolve(source);
    if (!picker.window.isDestroyed()) picker.window.close();
  }

  ipcMain.handle(LIST_CHANNEL, event => {
    if (!isActivePickerEvent(event)) throw new Error('Seletor de tela inválido.');
    return activePicker.sources.map(serializeSource);
  });

  ipcMain.handle(CHOOSE_CHANNEL, (event, sourceId) => {
    if (!isActivePickerEvent(event) || typeof sourceId !== 'string') return false;
    const exists = activePicker.sources.some(source => source.id === sourceId);
    if (exists) settlePicker(sourceId);
    return exists;
  });

  ipcMain.handle(CANCEL_CHANNEL, event => {
    if (!isActivePickerEvent(event)) return false;
    settlePicker();
    return true;
  });

  async function openPicker() {
    if (activePicker) settlePicker();

    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 384, height: 216 },
      fetchWindowIcons: true
    });
    if (!sources.length) return null;

    const parent = getParentWindow?.();
    return new Promise(resolve => {
      const pickerWindow = new BrowserWindow({
        width: 920,
        height: 680,
        minWidth: 700,
        minHeight: 500,
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        modal: Boolean(parent && !parent.isDestroyed()),
        show: false,
        skipTaskbar: true,
        title: 'Compartilhar tela',
        backgroundColor: '#0b0f12',
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(ELECTRON_DIR, 'display-picker-preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          devTools: false
        }
      });

      activePicker = { window: pickerWindow, sources, resolve, settled: false };
      pickerWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
        console.error(`Falha ao carregar o preload do seletor ${preloadPath}.`, error);
      });
      pickerWindow.once('ready-to-show', () => pickerWindow.show());
      pickerWindow.on('closed', () => settlePicker());
      pickerWindow.loadFile(path.join(ELECTRON_DIR, 'display-picker.html')).catch(() => settlePicker());
    });
  }

  targetSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isTrustedRequest(request) || !request.videoRequested) {
      callback(null);
      return;
    }

    try {
      const source = await openPicker();
      if (!source) {
        callback(null);
        return;
      }

      const streams = { video: source };
      if (request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    } catch (error) {
      console.error('Não foi possível abrir o seletor de tela.', error);
      callback(null);
    }
  }, { useSystemPicker: false });

  return () => {
    settlePicker();
    targetSession.setDisplayMediaRequestHandler(null);
    ipcMain.removeHandler(LIST_CHANNEL);
    ipcMain.removeHandler(CHOOSE_CHANNEL);
    ipcMain.removeHandler(CANCEL_CHANNEL);
  };
}
