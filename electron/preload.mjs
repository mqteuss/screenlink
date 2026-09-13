import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('screenLinkProfile', Object.freeze({
  load: () => ipcRenderer.invoke('screenlink:profile:load'),
  save: profile => ipcRenderer.invoke('screenlink:profile:save', profile)
}));

contextBridge.exposeInMainWorld('screenLinkDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform
}));
