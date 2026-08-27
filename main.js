const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { autoUpdater } = require('electron-updater');
const DiscordRPC = require('discord-rpc');

let mainWindow;
const launcher = new Client();
const cinderRoot = path.join(app.getPath('appData'), '.cinder');
const modsDir = path.join(cinderRoot, 'mods');

if (!fs.existsSync(cinderRoot)) fs.mkdirSync(cinderRoot, { recursive: true });
if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

const CLIENT_ID = '123456789012345678';
let rpcClient;

function initDiscordRPC() {
  try {
    DiscordRPC.register(CLIENT_ID);
    rpcClient = new DiscordRPC.Client({ transport: 'ipc' });
    rpcClient.on('ready', () => setRPCActivity('Idle in Launcher', 'Home'));
    rpcClient.login({ clientId: CLIENT_ID }).catch(() => {});
  } catch (err) {}
}

function setRPCActivity(details, state) {
  if (!rpcClient) return;
  try {
    rpcClient.setActivity({
      details: details,
      state: state,
      largeImageKey: 'cinder_logo',
      largeImageText: 'Cinder Client',
      startTimestamp: new Date(),
      instance: false,
    });
  } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  initDiscordRPC();

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.on('open-external', (e, url) => { if (url) shell.openExternal(url); });
ipcMain.on('open-game-folder', () => shell.openPath(cinderRoot));

// Modrinth API IPC handlers
ipcMain.handle('get-installed-mods', async () => {
  try {
    if (!fs.existsSync(modsDir)) return [];
    return fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
  } catch (e) {
    return [];
  }
});

ipcMain.handle('delete-mod', async (event, filename) => {
  try {
    const filePath = path.join(modsDir, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('search-mods', async (event, { query, version, loader }) => {
  return new Promise((resolve) => {
    const facets = JSON.stringify([
      [`project_type:mod`],
      [`versions:${version}`],
      [`categories:${loader.toLowerCase()}`]
    ]);
    const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(facets)}&limit=12`;

    https.get(url, { headers: { 'User-Agent': 'CinderClient/1.0.4' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.hits || []);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
});

ipcMain.handle('install-mod', async (event, { projectId, version, loader }) => {
  return new Promise((resolve) => {
    const url = `https://api.modrinth.com/v2/project/${projectId}/version?loaders=["${loader.toLowerCase()}"]&game_versions=["${version}"]`;

    https.get(url, { headers: { 'User-Agent': 'CinderClient/1.0.4' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const versions = JSON.parse(data);
          if (!versions || versions.length === 0) {
            return resolve({ success: false, error: 'No compatible build found' });
          }
          const primaryFile = versions[0].files.find(f => f.primary) || versions[0].files[0];
          const destPath = path.join(modsDir, primaryFile.filename);
          const fileStream = fs.createWriteStream(destPath);

          https.get(primaryFile.url, (fileRes) => {
            fileRes.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              resolve({ success: true });
            });
          }).on('error', (err) => resolve({ success: false, error: err.message }));
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    }).on('error', (e) => resolve({ success: false, error: e.message }));
  });
});

// Launch Game IPC
ipcMain.on('launch-game', async (event, config) => {
  const { username, version, loaderType, memoryMax, fpsBoost, serverIp } = config;

  const customArgs = [
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+UseG1GC",
    "-XX:G1NewSizePercent=20",
    "-XX:G1ReservePercent=20",
    "-XX:MaxGCPauseMillis=50",
    "-XX:G1HeapRegionSize=32M",
    "-Dsun.rmi.dgc.client.gcInterval=2147483646",
    "-Dsun.rmi.dgc.server.gcInterval=2147483646"
  ];

  if (fpsBoost) {
    customArgs.push("-XX:+AlwaysPreTouch", "-XX:+DisableExplicitGC");
  }

  let versionConfig = {
    number: version,
    type: "release"
  };

  if (loaderType === 'Fabric') {
    try {
      mainWindow?.webContents.send('game-log', { text: `Resolving Fabric metadata for Minecraft ${version}...` });
      const fabricData = await new Promise((resolve, reject) => {
        https.get(`https://meta.fabricmc.net/v2/versions/loader/${version}`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          });
        }).on('error', reject);
      });

      if (fabricData && fabricData.length > 0) {
        const loaderVer = fabricData[0].loader.version;
        versionConfig = {
          number: version,
          type: "release",
          custom: `fabric-loader-${loaderVer}-${version}`
        };
      }
    } catch (e) {
      mainWindow?.webContents.send('game-log', { text: `Fabric fetch failed: ${e.message}` });
    }
  }

  const launchOpts = {
    authorization: Authenticator.getAuth(username || 'Player'),
    root: cinderRoot,
    version: versionConfig,
    memory: {
      max: `${memoryMax || 4096}M`,
      min: "2048M"
    },
    customArgs: customArgs
  };

  if (serverIp) {
    launchOpts.quickPlay = {
      type: 'multiplayer',
      identifier: serverIp
    };
  }

  setRPCActivity(`Playing as ${username || 'Player'}`, `${version} (${loaderType})`);

  try {
    launcher.launch(launchOpts);
    launcher.on('debug', (e) => mainWindow?.webContents.send('game-log', { text: e }));
    launcher.on('data', (e) => {
      mainWindow?.webContents.send('game-log', { text: e });
      mainWindow?.webContents.send('game-status', 'started');
    });
    launcher.on('progress', (e) => {
      mainWindow?.webContents.send('game-log', { text: `Downloading ${e.type}: ${e.task} / ${e.total}` });
    });
    launcher.on('close', () => {
      mainWindow?.webContents.send('game-status', 'closed');
      setRPCActivity('Idle in Launcher', 'Home');
    });
  } catch (err) {
    mainWindow?.webContents.send('game-log', { text: `[ERROR]: ${err.message}` });
    mainWindow?.webContents.send('game-status', 'closed');
  }
});

// Auto-Updater
autoUpdater.on('update-available', () => {
  mainWindow?.webContents.send('update-message', 'Update available. Downloading...');
});

autoUpdater.on('update-downloaded', () => {
  mainWindow?.webContents.send('update-message', 'Update downloaded. Restarting...');
  setTimeout(() => autoUpdater.quitAndInstall(), 3000);
});
