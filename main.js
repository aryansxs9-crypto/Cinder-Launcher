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

// Auto-updater logging
autoUpdater.on('checking-for-update', () => {
  win && win.webContents.send('updater-log', 'Checking for new launcher updates...');
});

autoUpdater.on('update-available', (info) => {
  win && win.webContents.send('updater-log', `New update v${info.version} found! Downloading in background...`);
});

autoUpdater.on('update-not-available', () => {
  win && win.webContents.send('updater-log', 'Launcher is up to date.');
});

autoUpdater.on('download-progress', (progressObj) => {
  win && win.webContents.send('updater-log', `Downloading update: ${Math.round(progressObj.percent)}%`);
});

autoUpdater.on('update-downloaded', () => {
  win && win.webContents.send('updater-log', 'Update ready. Restarting launcher...');
  setTimeout(() => {
    autoUpdater.quitAndInstall();
  }, 2000);
});

autoUpdater.on('error', (err) => {
  win && win.webContents.send('updater-log', `Update check failed: ${err.message}`);
});

app.whenReady().then(createWindow);

// Window controls
ipcMain.on('window-minimize', () => win.minimize());
ipcMain.on('window-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('window-close', () => win.close());

// Root folder auto-creation
const gameRoot = path.join(app.getPath('appData'), '.ember');

ipcMain.on('open-game-folder', () => {
  if (!fs.existsSync(gameRoot)) {
    fs.mkdirSync(gameRoot, { recursive: true });
  }
  shell.openPath(gameRoot);
});

// Dynamic Loader Resolvers (Fabric & Quilt)
async function resolveLoaderProfile(loaderType, gameVersion) {
  try {
    if (loaderType === 'Fabric') {
      const { data } = await axios.get(`https://meta.fabricmc.net/v2/versions/loader/${gameVersion}`);
      if (data && data.length > 0) {
        return `fabric-loader-${data[0].loader.version}-${gameVersion}`;
      }
    } else if (loaderType === 'Quilt') {
      const { data } = await axios.get(`https://meta.quiltmc.org/v3/versions/loader/${gameVersion}`);
      if (data && data.length > 0) {
        return `quilt-loader-${data[0].loader.version}-${gameVersion}`;
      }
    }
  } catch (err) {
    return null;
  }
  return null;
}

// Launch Minecraft handler
ipcMain.on('launch-game', async (event, { username, version, loaderType, memoryMax, fpsBoost, serverIp }) => {
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

  const launchArgs = [...performanceFlags];
  if (serverIp) {
    launchArgs.push('--server', serverIp);
  }

  let versionPayload = {
    number: version || '1.20.4',
    type: 'release'
  };

  if (loaderType === 'Fabric' || loaderType === 'Quilt') {
    win.webContents.send('game-log', { text: `Resolving ${loaderType} metadata for Minecraft ${version}...` });
    const customVersion = await resolveLoaderProfile(loaderType, version);
    if (customVersion) {
      versionPayload.custom = customVersion;
    }
  }

  const opts = {
    clientPackage: null,
    authorization: auth,
    root: gameRoot,
    version: versionPayload,
    memory: {
      max: `${memoryMax}M`,
      min: '1024M'
    },
    customArgs: launchArgs
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
