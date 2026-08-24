const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
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

// Fabric loader profile resolver
async function setupFabric(gameVersion) {
  try {
    const metaUrl = `https://meta.fabricmc.net/v2/versions/loader/${gameVersion}`;
    const { data } = await axios.get(metaUrl);
    if (!data || data.length === 0) return null;
    const loaderVersion = data[0].loader.version;
    return `fabric-loader-${loaderVersion}-${gameVersion}`;
  } catch (err) {
    return null;
  }
}

ipcMain.on('launch-game', async (event, { username, version, loaderType, memoryMax, fpsBoost }) => {
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

  let versionPayload = {
    number: version || '1.20.4',
    type: 'release'
  };

  if (loaderType === 'Fabric') {
    win.webContents.send('game-log', { text: `Resolving Fabric metadata for Minecraft ${version}...` });
    const customVersion = await setupFabric(version);
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
    customArgs: performanceFlags
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
