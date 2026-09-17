import { desktopCapturer, ipcMain } from 'electron';

const STATE_CHANNEL = 'screenlink:display-picker:state';
const CHOOSE_CHANNEL = 'screenlink:display-picker:choose';
const CANCEL_CHANNEL = 'screenlink:display-picker:cancel';

function sourceKind(source) {
  return source.id.startsWith('screen:') ? 'screen' : 'window';
}

function nativeImageDataUrl(image) {
  try {
    return image && !image.isEmpty() ? image.toDataURL() : null;
  } catch {
    return null;
  }
}

function serializeSource(source) {
  return {
    id: source.id,
    name: source.name,
    kind: sourceKind(source),
    thumbnail: nativeImageDataUrl(source.thumbnail),
    appIcon: nativeImageDataUrl(source.appIcon)
  };
}

async function listDesktopSources() {
  const baseOptions = {
    types: ['screen', 'window'],
    thumbnailSize: { width: 384, height: 216 }
  };
  try {
    return await desktopCapturer.getSources({ ...baseOptions, fetchWindowIcons: true });
  } catch (error) {
    console.warn('Não foi possível listar fontes com ícones; tentando novamente sem ícones.', error);
    return desktopCapturer.getSources({ ...baseOptions, fetchWindowIcons: false });
  }
}

export function registerDisplayMedia({ targetSession, getParentWindow, isTrustedRequest, isTrustedSender }) {
  let activePicker = null;

  function isActivePickerEvent(event) {
    const senderFrame = event.senderFrame;
    return Boolean(
      activePicker
      && !activePicker.webContents.isDestroyed()
      && event.sender?.id === activePicker.webContents.id
      && senderFrame
      && senderFrame === senderFrame.top
      && (!isTrustedSender || isTrustedSender(event))
    );
  }

  function settlePicker(sourceId = null) {
    const picker = activePicker;
    if (!picker || picker.settled) return;
    picker.settled = true;
    activePicker = null;
    picker.webContents.removeListener('destroyed', picker.onDestroyed);
    const source = sourceId ? picker.sources.find(candidate => candidate.id === sourceId) ?? null : null;
    if (!picker.webContents.isDestroyed()) picker.webContents.send(STATE_CHANNEL, { open: false });
    picker.resolve(source);
  }

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

    const sources = await listDesktopSources();
    if (!sources.length) return null;

    const parent = getParentWindow?.();
    if (!parent || parent.isDestroyed() || parent.webContents.isDestroyed()) return null;
    const webContents = parent.webContents;

    return new Promise(resolve => {
      const onDestroyed = () => settlePicker();
      activePicker = { webContents, sources, resolve, settled: false, onDestroyed };
      webContents.once('destroyed', onDestroyed);
      webContents.send(STATE_CHANNEL, {
        open: true,
        sources: sources.map(serializeSource),
        systemAudioAvailable: process.platform === 'win32'
      });
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
    ipcMain.removeHandler(CHOOSE_CHANNEL);
    ipcMain.removeHandler(CANCEL_CHANNEL);
  };
}
