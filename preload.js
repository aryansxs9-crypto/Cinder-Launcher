const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openGameFolder: () => ipcRenderer.send('open-game-folder'),
  launchGame: (config) => ipcRenderer.send('launch-game', config),
  onGameLog: (callback) => ipcRenderer.on('game-log', (event, value) => callback(value)),
  onGameStatus: (callback) => ipcRenderer.on('game-status', (event, value) => callback(value)),
  onUpdateMessage: (callback) => ipcRenderer.on('update-message', (event, value) => callback(value))
});
