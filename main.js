const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { autoUpdater } = require('electron-updater');
const { Client, Authenticator } = require('minecraft-launcher-core');

let win;
const launcher = new Client();

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#050608',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');

  win.once('ready-to-show', () => {
    if (app.isPackaged) {
      autoUpdater.checkForUpdatesAndNotify();
    }
  });
}

// Auto-Updater Listeners
autoUpdater.on('checking-for-update', () => {
  win && win.webContents.send('updater-log', 'Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  win && win.webContents.send('updater-log', `Update v${info.version} available! Downloading...`);
});

autoUpdater.on('update-not-available', () => {
  win && win.webContents.send('updater-log', 'Launcher is up to date.');
});

autoUpdater.on('download-progress', (progressObj) => {
  win && win.webContents.send('updater-log', `Downloading update: ${Math.round(progressObj.percent)}%`);
});

autoUpdater.on('update-downloaded', () => {
  win && win.webContents.send('updater-log', 'Update ready. Restarting...');
  setTimeout(() => {
    autoUpdater.quitAndInstall();
  }, 2000);
});

autoUpdater.on('error', (err) => {
  if (err.message && err.message.includes('404')) {
    win && win.webContents.send('updater-log', 'Running latest release.');
  } else {
    win && win.webContents.send('updater-log', `Updater status: ${err.message}`);
  }
});

app.whenReady().then(createWindow);

// Window Controls
ipcMain.on('window-minimize', () => win.minimize());
ipcMain.on('window-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('window-close', () => win.close());

// Root Folder Directory
const gameRoot = path.join(app.getPath('appData'), '.ember');

ipcMain.on('open-game-folder', () => {
  if (!fs.existsSync(gameRoot)) {
    fs.mkdirSync(gameRoot, { recursive: true });
  }
  shell.openPath(gameRoot);
});

// Launch Minecraft Handler
ipcMain.on('launch-game', async (event, { username, version, loaderType, memoryMax, fpsBoost, serverIp }) => {
  try {
    if (!fs.existsSync(gameRoot)) {
      fs.mkdirSync(gameRoot, { recursive: true });
    }

    const auth = Authenticator.getAuth(username || 'Player');

    const performanceFlags = fpsBoost ? [
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:+AlwaysPreTouch',
      '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5',
      '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90',
      '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32',
      '-XX:+PerfDisableSharedMem',
      '-XX:MaxTenuringThreshold=1'
    ] : [];

    const customArgs = [...performanceFlags];
    if (serverIp) {
      customArgs.push('--server', serverIp);
    }

    const selectedVersion = version || '1.20.4';

    const opts = {
      clientPackage: null,
      authorization: auth,
      root: gameRoot,
      version: {
        number: selectedVersion,
        type: 'release'
      },
      memory: {
        max: `${memoryMax || 4096}M`,
        min: '1024M'
      },
      customArgs: customArgs
    };

    win.webContents.send('game-log', { text: `[CORE] Initializing Minecraft ${selectedVersion}...` });
    win.webContents.send('game-status', 'downloading');

    launcher.launch(opts);
  } catch (err) {
    win.webContents.send('game-log', { text: `[ERROR] Failed to start launch process: ${err.message}` });
    win.webContents.send('game-status', 'closed');
  }
});

// Stream Minecraft logs to UI
launcher.on('debug', (e) => win && win.webContents.send('game-log', { type: 'debug', text: e }));
launcher.on('data', (e) => win && win.webContents.send('game-log', { type: 'info', text: e }));
launcher.on('progress', (e) => {
  if (win && e.total > 0) {
    win.webContents.send('game-log', { type: 'info', text: `Downloading ${e.type}: ${Math.round((e.task / e.total) * 100)}%` });
  }
});
launcher.on('start', () => win && win.webContents.send('game-status', 'started'));
launcher.on('close', () => win && win.webContents.send('game-status', 'closed'));
launcher.on('close-with-error', (err) => {
  if (win) {
    win.webContents.send('game-log', { text: `[CRASH] Process exited with error: ${err}` });
    win.webContents.send('game-status', 'closed');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
               
