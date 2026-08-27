const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcherAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  openFolder: () => ipcRenderer.send('open-game-folder'),
  openLink: (url) => ipcRenderer.send('open-external', url),
  launchGame: (config) => ipcRenderer.send('launch-game', config),
  getInstalledMods: () => ipcRenderer.invoke('get-installed-mods'),
  searchMods: (query, version, loader) => ipcRenderer.invoke('search-mods', { query, version, loader }),
  installMod: (projectId, version, loader) => ipcRenderer.invoke('install-mod', { projectId, version, loader }),
  deleteMod: (filename) => ipcRenderer.invoke('delete-mod', filename),
  onLog: (callback) => ipcRenderer.on('game-log', (event, value) => callback(value)),
  onStatus: (callback) => ipcRenderer.on('game-status', (event, value) => callback(value)),
  onUpdaterLog: (callback) => ipcRenderer.on('update-message', (event, value) => callback(value))
});
