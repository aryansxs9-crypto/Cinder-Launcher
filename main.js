const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { Client, Authenticator } = require('minecraft-launcher-core');

let win;
const launcher = new Client();

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#07070b',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

ipcMain.on('window-minimize', () => win.minimize());
ipcMain.on('window-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('window-close', () => win.close());

const gameRoot = path.join(app.getPath('appData'), '.ember');
ipcMain.on('open-game-folder', () => shell.openPath(gameRoot));

ipcMain.on('launch-game', (event, { username, version, memoryMax }) => {
  const auth = Authenticator.getAuth(username || 'Player');

  const opts = {
    clientPackage: null,
    authorization: auth,
    root: gameRoot,
    version: {
      number: version || '1.20.4',
      type: 'release'
    },
    memory: {
      max: `${memoryMax}M`,
      min: '1024M'
    }
  };

  win.webContents.send('game-status', 'downloading');
  launcher.launch(opts);

  launcher.on('debug', (e) => win.webContents.send('game-log', { type: 'debug', text: e }));
  launcher.on('data', (e) => win.webContents.send('game-log', { type: 'info', text: e }));
  launcher.on('progress', (e) => {
    win.webContents.send('game-log', { type: 'info', text: `Downloading ${e.type}: ${Math.round((e.task / e.total) * 100)}%` });
  });

  launcher.on('start', () => win.webContents.send('game-status', 'started'));
  launcher.on('close', () => win.webContents.send('game-status', 'closed'));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
