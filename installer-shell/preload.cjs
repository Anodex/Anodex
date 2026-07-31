const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('anodexInstaller', {
  getInfo: () => ipcRenderer.invoke('installer:info'),
  chooseLocation: () => ipcRenderer.invoke('installer:choose-location'),
  startInstall: (destination) => ipcRenderer.invoke('installer:start', destination),
  launch: (destination) => ipcRenderer.invoke('installer:launch', destination),
  minimize: () => ipcRenderer.send('installer:minimize'),
  close: () => ipcRenderer.send('installer:close'),
  onStatus(listener) {
    const receiveStatus = (_event, status) => listener(status)
    ipcRenderer.on('installer:status', receiveStatus)
    return () => ipcRenderer.removeListener('installer:status', receiveStatus)
  }
})
