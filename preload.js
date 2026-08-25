const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcherAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  openFolder: () => ipcRenderer.send('open-game-folder'),
  launchGame: (config) => ipcRenderer.send('launch-game', config),
  onStatus: (callback) => ipcRenderer.on('game-status', (event, status) => callback(status)),
  onLog: (callback) => ipcRenderer.on('game-log', (event, data) => callback(data)),
  onUpdaterLog: (callback) => ipcRenderer.on('updater-log', (event, message) => callback(message))
});
