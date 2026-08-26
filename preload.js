const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('launcherAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  openFolder: () => ipcRenderer.send('open-game-folder'),
  openLink: (url) => shell.openExternal(url),
  launchGame: (config) => ipcRenderer.send('launch-game', config),
  onStatus: (callback) => ipcRenderer.on('game-status', (event, status) => callback(status)),
  onLog: (callback) => ipcRenderer.on('game-log', (event, data) => callback(data)),
  onUpdaterLog: (callback) => ipcRenderer.on('updater-log', (event, message) => callback(message)),

  // Mod Hub APIs
  searchMods: (query, version, loader) => ipcRenderer.invoke('search-mods', { query, version, loader }),
  installMod: (projectId, version, loader) => ipcRenderer.invoke('install-mod', { projectId, version, loader }),
  getInstalledMods: () => ipcRenderer.invoke('get-installed-mods'),
  deleteMod: (filename) => ipcRenderer.invoke('delete-mod', filename)
});
