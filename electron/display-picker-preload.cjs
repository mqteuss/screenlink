const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenLinkDisplayPicker', Object.freeze({
  list: () => ipcRenderer.invoke('screenlink:display-picker:list'),
  choose: sourceId => ipcRenderer.invoke('screenlink:display-picker:choose', sourceId),
  cancel: () => ipcRenderer.invoke('screenlink:display-picker:cancel')
}));
