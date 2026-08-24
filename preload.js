const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcherAPI', {
  launchGame: (options) => ipcRenderer.send('launch-game', options),
  openFolder: () => ipcRenderer.send('open-game-folder'),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  onLog: (callback) => ipcRenderer.on('game-log', (event, data) => callback(data)),
  onStatus: (callback) => ipcRenderer.on('game-status', (event, data) => callback(data))
});
