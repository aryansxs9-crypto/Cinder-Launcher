const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const DiscordRPC = require('discord-rpc');
const { autoUpdater } = require('electron-updater');
const { Client, Authenticator } = require('minecraft-launcher-core');

let win;
const launcher = new Client();

// --- Discord Rich Presence (RPC) ---
const CLIENT_ID = '1542072339121045584';
DiscordRPC.register(CLIENT_ID);
const rpc = new DiscordRPC.Client({ transport: 'ipc' });
let startTimestamp = new Date();

async function setActivity(details = 'In Launcher', state = 'Browsing Settings') {
  if (!rpc) return;
  try {
    await rpc.setActivity({
      details: details,
      state: state,
      startTimestamp: startTimestamp,
      largeImageKey: 'logo',
      largeImageText: 'Ember Client',
      smallImageKey: 'logo',
      smallImageText: 'Ember Launcher',
      instance: false
    });
  } catch (err) {}
}

rpc.on('ready', () => {
  setActivity('In Launcher', 'Idling');
});

rpc.login({ clientId: CLIENT_ID }).catch(() => {});

// --- Electron Window Setup ---
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
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }
  });
}

// Updater Log Handlers
autoUpdater.on('checking-for-update', () => win && win.webContents.send('updater-log', 'Checking for updates...'));
autoUpdater.on('update-available', (info) => win && win.webContents.send('updater-log', `Update v${info.version} found! Downloading...`));
autoUpdater.on('update-not-available', () => win && win.webContents.send('updater-log', 'Launcher is up to date.'));
autoUpdater.on('download-progress', (p) => win && win.webContents.send('updater-log', `Downloading update: ${Math.round(p.percent)}%`));
autoUpdater.on('update-downloaded', () => {
  win && win.webContents.send('updater-log', 'Update ready. Restarting...');
  setTimeout(() => autoUpdater.quitAndInstall(), 2000);
});
autoUpdater.on('error', (err) => {
  if (err.message && err.message.includes('404')) {
    win && win.webContents.send('updater-log', 'Launcher is up to date (no newer release found).');
  } else {
    win && win.webContents.send('updater-log', `Updater status: ${err.message}`);
  }
});

app.whenReady().then(createWindow);

// Window controls
ipcMain.on('window-minimize', () => win && win.minimize());
ipcMain.on('window-maximize', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('window-close', () => win && win.close());

const gameRoot = path.join(app.getPath('appData'), '.ember');
const modsDir = path.join(gameRoot, 'mods');

ipcMain.on('open-game-folder', () => {
  if (!fs.existsSync(gameRoot)) fs.mkdirSync(gameRoot, { recursive: true });
  shell.openPath(gameRoot);
});

// --- MODRINTH API & MODS HANDLERS ---

// Search mods on Modrinth
ipcMain.handle('search-mods', async (event, { query, version, loader }) => {
  try {
    const facets = [];
    facets.push([`project_type:mod`]);
    if (version) facets.push([`versions:${version}`]);
    if (loader && loader.toLowerCase() !== 'vanilla') facets.push([`categories:${loader.toLowerCase()}`]);

    const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=20`;
    const res = await axios.get(url, { headers: { 'User-Agent': 'EmberLauncher/1.0.1' } });
    return res.data.hits || [];
  } catch (err) {
    return [];
  }
});

// Install mod directly to .ember/mods/
ipcMain.handle('install-mod', async (event, { projectId, version, loader }) => {
  try {
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

    let loaderFilter = (loader && loader.toLowerCase() !== 'vanilla') ? `&loaders=["${loader.toLowerCase()}"]` : '';
    let versionFilter = version ? `&game_versions=["${version}"]` : '';
    
    const versionUrl = `https://api.modrinth.com/v2/project/${projectId}/version?${loaderFilter}${versionFilter}`;
    const res = await axios.get(versionUrl, { headers: { 'User-Agent': 'EmberLauncher/1.0.1' } });
    
    if (!res.data || res.data.length === 0) {
      throw new Error('No compatible release found for this version/loader.');
    }

    const primaryFile = res.data[0].files.find(f => f.primary) || res.data[0].files[0];
    if (!primaryFile) throw new Error('No downloadable file attached.');

    const targetPath = path.join(modsDir, primaryFile.filename);
    const writer = fs.createWriteStream(targetPath);

    const response = await axios({
      url: primaryFile.url,
      method: 'GET',
      responseType: 'stream'
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve({ success: true, filename: primaryFile.filename }));
      writer.on('error', reject);
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Get installed mods
ipcMain.handle('get-installed-mods', async () => {
  try {
    if (!fs.existsSync(modsDir)) return [];
    return fs.readdirSync(modsDir).filter(file => file.endsWith('.jar'));
  } catch (err) {
    return [];
  }
});

// Delete mod
ipcMain.handle('delete-mod', async (event, filename) => {
  try {
    const filePath = path.join(modsDir, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { success: true };
    }
    return { success: false, error: 'File not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Download and write Fabric Loader JSON into .ember/versions/
async function prepareFabricProfile(gameVersion) {
  try {
    const metaUrl = `https://meta.fabricmc.net/v2/versions/loader/${gameVersion}`;
    const { data } = await axios.get(metaUrl);
    if (!data || data.length === 0) return null;

    const loaderVersion = data[0].loader.version;
    const profileId = `fabric-loader-${loaderVersion}-${gameVersion}`;
    
    const versionDir = path.join(gameRoot, 'versions', profileId);
    const jsonPath = path.join(versionDir, `${profileId}.json`);

    if (!fs.existsSync(versionDir)) {
      fs.mkdirSync(versionDir, { recursive: true });
    }

    const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${gameVersion}/${loaderVersion}/profile/json`;
    const profileRes = await axios.get(profileUrl);

    fs.writeFileSync(jsonPath, JSON.stringify(profileRes.data, null, 2));
    return profileId;
  } catch (err) {
    if (win) {
      win.webContents.send('game-log', { text: `[WARN] Failed to download Fabric profile: ${err.message}` });
    }
    return null;
  }
}

// Launch Minecraft Handler
ipcMain.on('launch-game', async (event, { username, version, loaderType, memoryMax, fpsBoost, serverIp }) => {
  try {
    if (!fs.existsSync(gameRoot)) fs.mkdirSync(gameRoot, { recursive: true });

    const auth = Authenticator.getAuth(username || 'Player');
    const selectedVersion = version || '1.20.4';

    const customArgs = fpsBoost ? [
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:+AlwaysPreTouch'
    ] : [];

    if (serverIp) customArgs.push('--server', serverIp);

    let versionPayload = {
      number: selectedVersion,
      type: 'release'
    };

    if (loaderType === 'Fabric') {
      win.webContents.send('game-log', { text: `[CORE] Resolving Fabric profile for Minecraft ${selectedVersion}...` });
      const customProfile = await prepareFabricProfile(selectedVersion);
      if (customProfile) {
        versionPayload.custom = customProfile;
      }
    }

    const opts = {
      clientPackage: null,
      authorization: auth,
      root: gameRoot,
      version: versionPayload,
      memory: {
        max: `${memoryMax || 4096}M`,
        min: '1024M'
      },
      customArgs: customArgs
    };

    win.webContents.send('game-log', { text: `[CORE] Starting Minecraft ${selectedVersion} (${loaderType})...` });
    win.webContents.send('game-status', 'downloading');

    startTimestamp = new Date();
    setActivity(`Playing Minecraft ${selectedVersion} (${loaderType})`, `As ${username || 'Player'}`);

    launcher.launch(opts);
  } catch (err) {
    win.webContents.send('game-log', { text: `[ERROR] Launch failed: ${err.message}` });
    win.webContents.send('game-status', 'closed');
    setActivity('In Launcher', 'Idling');
  }
});

// Logs & Lifecycle Handlers
launcher.on('debug', (e) => win && win.webContents.send('game-log', { type: 'debug', text: e }));
launcher.on('data', (e) => win && win.webContents.send('game-log', { type: 'info', text: e }));
launcher.on('progress', (e) => {
  if (win && e.total > 0) {
    win.webContents.send('game-log', { type: 'info', text: `Downloading ${e.type}: ${Math.round((e.task / e.total) * 100)}%` });
  }
});
launcher.on('start', () => win && win.webContents.send('game-status', 'started'));
launcher.on('close', () => {
  if (win) win.webContents.send('game-status', 'closed');
  setActivity('In Launcher', 'Idling');
});
launcher.on('close-with-error', (err) => {
  if (win) {
    win.webContents.send('game-log', { text: `[CRASH] Process exited with error: ${err}` });
    win.webContents.send('game-status', 'closed');
  }
  setActivity('In Launcher', 'Idling');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
               
