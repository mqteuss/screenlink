import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('screenLinkProfile', {
  load: () => ipcRenderer.invoke('screenlink:profile:load'),
  save: profile => ipcRenderer.invoke('screenlink:profile:save', profile)
});
