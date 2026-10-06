const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopBridge', {
  openDownloads: () => ipcRenderer.invoke('open-downloads'),
  saveOutputs: (files, automatic = false) => ipcRenderer.invoke('save-outputs', files, automatic),
  importYoutube: (url, mediaType, videoQuality = 480) => ipcRenderer.invoke('import-youtube', url, mediaType, videoQuality),
})
