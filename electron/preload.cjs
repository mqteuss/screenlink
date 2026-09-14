const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenLinkProfile', Object.freeze({
  load: () => ipcRenderer.invoke('screenlink:profile:load'),
  save: profile => ipcRenderer.invoke('screenlink:profile:save', profile)
}));

contextBridge.exposeInMainWorld('screenLinkDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  getUpdateState: () => ipcRenderer.invoke('screenlink:update:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('screenlink:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('screenlink:update:download'),
  installUpdate: () => ipcRenderer.invoke('screenlink:update:install'),
  onUpdateState: callback => {
    if (typeof callback !== 'function') return () => undefined;
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('screenlink:update:state', listener);
    return () => ipcRenderer.removeListener('screenlink:update:state', listener);
  }
}));
