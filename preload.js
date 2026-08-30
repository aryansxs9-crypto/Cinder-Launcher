const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcherAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openGameFolder: () => ipcRenderer.send('open-game-folder'),

  // Microsoft Authentication
  loginMicrosoft: () => ipcRenderer.invoke('login-microsoft'),
  logoutAccount: () => ipcRenderer.invoke('logout-account'),

  // FPS Optimization Bundle
  installFpsBundle: (payload) => ipcRenderer.invoke('install-fps-bundle', payload),

  // Game Engine & Process Control
  launchGame: (config) => ipcRenderer.send('launch-game', config),
  stopGame: () => ipcRenderer.send('stop-game'),
  onGameLog: (callback) => ipcRenderer.on('game-log', (event, data) => callback(data)),
  onGameStatus: (callback) => ipcRenderer.on('game-status', (event, data) => callback(data)),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),

  // Modrinth API
  getInstalledMods: () => ipcRenderer.invoke('get-installed-mods'),
  deleteMod: (filename) => ipcRenderer.invoke('delete-mod', filename),
  searchMods: (payload) => ipcRenderer.invoke('search-mods', payload),
  installMod: (payload) => ipcRenderer.invoke('install-mod', payload)
});
