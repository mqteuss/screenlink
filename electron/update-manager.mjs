import { Notification } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

const CHANNELS = {
  state: 'screenlink:update:state',
  getState: 'screenlink:update:get-state',
  check: 'screenlink:update:check',
  download: 'screenlink:update:download',
  install: 'screenlink:update:install'
};

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

function cleanVersion(value) {
  return String(value || '').replace(/^v/i, '').slice(0, 40);
}

function errorMessage(error) {
  const value = error instanceof Error ? error.message : String(error || 'Falha desconhecida.');
  return value.replace(/\s+/g, ' ').slice(0, 240);
}

export function registerAutoUpdates({ ipcMain, app, getMainWindow, isTrustedSender }) {
  const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
  const enabled = process.platform === 'win32' && app.isPackaged && !portable;
  let userInitiated = false;
  let notifiedVersion = '';
  let interval = null;
  let initialTimer = null;
  let disposed = false;
  let state = {
    status: enabled ? 'idle' : portable ? 'portable' : app.isPackaged ? 'unsupported' : 'development',
    currentVersion: cleanVersion(app.getVersion()),
    version: '',
    percent: null,
    transferred: null,
    total: null,
    message: portable
      ? 'A edição portátil avisa sobre versões novas, mas deve ser substituída manualmente.'
      : app.isPackaged
        ? 'Atualização automática disponível somente no instalador do Windows.'
        : 'A busca de atualizações fica ativa no aplicativo instalado.',
    notice: false,
    canAutoUpdate: enabled
  };

  const publish = patch => {
    state = { ...state, ...patch };
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.state, state);
    return state;
  };

  const showNativeNotification = version => {
    if (!Notification.isSupported() || notifiedVersion === version) return;
    notifiedVersion = version;
    const notification = new Notification({
      title: 'Atualização do ScreenLink',
      body: `A versão ${version} está pronta para baixar.`,
      silent: true
    });
    notification.on('click', () => {
      const window = getMainWindow();
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    notification.show();
  };

  const check = async (manual = false) => {
    userInitiated = manual;
    if (!enabled) return publish({ notice: manual });
    publish({ status: 'checking', percent: null, message: manual ? 'Procurando uma versão mais recente…' : '', notice: manual });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      publish({
        status: manual ? 'error' : 'idle',
        message: manual ? `Não foi possível buscar atualizações: ${errorMessage(error)}` : '',
        notice: manual
      });
    }
    return state;
  };

  const trusted = event => {
    if (!isTrustedSender(event)) throw new Error('Origem não autorizada para controlar atualizações.');
  };

  const handleGetState = event => {
    trusted(event);
    return state;
  };
  const handleCheck = async event => {
    trusted(event);
    return check(true);
  };
  const handleDownload = async event => {
    trusted(event);
    if (!enabled || state.status !== 'available') return state;
    publish({ status: 'downloading', percent: 0, message: 'Baixando a atualização…', notice: true });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      publish({ status: 'error', message: `O download falhou: ${errorMessage(error)}`, notice: true });
    }
    return state;
  };
  const handleInstall = event => {
    trusted(event);
    if (!enabled || state.status !== 'downloaded') return false;
    publish({ status: 'installing', message: 'Reiniciando para concluir a atualização…', notice: true });
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  };

  ipcMain.handle(CHANNELS.getState, handleGetState);
  ipcMain.handle(CHANNELS.check, handleCheck);
  ipcMain.handle(CHANNELS.download, handleDownload);
  ipcMain.handle(CHANNELS.install, handleInstall);

  if (enabled) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => publish({ status: 'checking', percent: null, notice: userInitiated }));
    autoUpdater.on('update-available', info => {
      const version = cleanVersion(info.version);
      publish({ status: 'available', version, percent: null, message: `A versão ${version} está disponível.`, notice: true });
      showNativeNotification(version);
    });
    autoUpdater.on('update-not-available', () => publish({
      status: userInitiated ? 'current' : 'idle',
      version: '',
      percent: null,
      message: userInitiated ? 'Você já está usando a versão mais recente.' : '',
      notice: userInitiated
    }));
    autoUpdater.on('download-progress', progress => publish({
      status: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      transferred: Math.max(0, Math.round(progress.transferred)),
      total: Math.max(0, Math.round(progress.total)),
      message: 'Baixando a atualização…',
      notice: true
    }));
    autoUpdater.on('update-downloaded', info => publish({
      status: 'downloaded',
      version: cleanVersion(info.version || state.version),
      percent: 100,
      message: 'Atualização pronta. Reinicie para instalar.',
      notice: true
    }));
    autoUpdater.on('error', error => publish({
      status: userInitiated || state.status === 'downloading' ? 'error' : 'idle',
      message: userInitiated || state.status === 'downloading' ? `A atualização falhou: ${errorMessage(error)}` : '',
      notice: userInitiated || state.status === 'downloading'
    }));
  }

  return {
    start() {
      if (!enabled || disposed || initialTimer) return;
      initialTimer = setTimeout(() => void check(false), 3_500);
      interval = setInterval(() => void check(false), CHECK_INTERVAL_MS);
      interval.unref?.();
    },
    dispose() {
      disposed = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (interval) clearInterval(interval);
      ipcMain.removeHandler(CHANNELS.getState);
      ipcMain.removeHandler(CHANNELS.check);
      ipcMain.removeHandler(CHANNELS.download);
      ipcMain.removeHandler(CHANNELS.install);
      autoUpdater.removeAllListeners();
    }
  };
}
