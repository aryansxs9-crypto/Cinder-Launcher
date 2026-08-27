const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { autoUpdater } = require('electron-updater');
const DiscordRPC = require('discord-rpc');

const CLIENT_ID = '123456789012345678'; // Optional: Replace with your Discord Application ID
let rpcClient = null;
let mainWindow = null;
const launcher = new Client();

// 1. Root Game Directory Initialization (.cinderclient)
const cinderRoot = path.join(app.getPath('appData'), '.cinderclient');
const modsFolder = path.join(cinderRoot, 'mods');

if (!fs.existsSync(cinderRoot)) fs.mkdirSync(cinderRoot, { recursive: true });
if (!fs.existsSync(modsFolder)) fs.mkdirSync(modsFolder, { recursive: true });

// 2. Initialize Discord RPC
function initDiscordRPC() {
  try {
    DiscordRPC.register(CLIENT_ID);
    rpcClient = new DiscordRPC.Client({ transport: 'ipc' });

    rpcClient.on('ready', () => {
      setRPCActivity('Idle in Launcher', 'Menu');
    });

    rpcClient.login({ clientId: CLIENT_ID }).catch(() => {
      console.log('Discord RPC: Discord client not detected.');
    });
  } catch (err) {
    console.log('Discord RPC error:', err.message);
  }
}

function setRPCActivity(details, state) {
  if (!rpcClient) return;
  try {
    rpcClient.setActivity({
      details: details,
      state: state,
      largeImageKey: 'cinder_logo',
      largeImageText: 'Cinder Client',
      instance: false,
      startTimestamp: new Date()
    });
  } catch (e) {}
}

// 3. Create Main Electron Window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 680,
    minWidth: 920,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#050608',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    initDiscordRPC();
    
    // Check for updates automatically in packaged build
    if (app.isPackaged) {
      autoUpdater.checkForUpdatesAndNotify();
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 4. Window Action IPC Handlers
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.on('open-folder', () => shell.openPath(cinderRoot));
ipcMain.on('open-link', (event, url) => shell.openExternal(url));

// 5. Auto-Updater Event Handlers
autoUpdater.on('checking-for-update', () => {
  mainWindow?.webContents.send('updater-log', 'Checking for client updates...');
});
autoUpdater.on('update-available', (info) => {
  mainWindow?.webContents.send('updater-log', `Update v${info.version} available! Downloading silently...`);
});
autoUpdater.on('update-not-available', () => {
  mainWindow?.webContents.send('updater-log', 'Cinder Client is up to date.');
});
autoUpdater.on('update-downloaded', () => {
  mainWindow?.webContents.send('updater-log', 'Update ready. Installing on quit...');
});
autoUpdater.on('error', (err) => {
  mainWindow?.webContents.send('updater-log', `AutoUpdater: ${err.message}`);
});

// 6. Modrinth Mods Hub IPC Handlers
ipcMain.handle('get-installed-mods', async () => {
  try {
    return fs.readdirSync(modsFolder).filter(file => file.endsWith('.jar'));
  } catch (e) {
    return [];
  }
});

ipcMain.handle('delete-mod', async (event, filename) => {
  try {
    const targetPath = path.join(modsFolder, filename);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('search-mods', async (event, { query, version, loader }) => {
  return new Promise((resolve) => {
    const loaderParam = loader.toLowerCase() === 'vanilla' ? 'fabric' : loader.toLowerCase();
    const facets = encodeURIComponent(JSON.stringify([
      [`versions:${version}`],
      [`categories:${loaderParam}`],
      ["project_type:mod"]
    ]));
    
    const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query || '')}&facets=${facets}&limit=20`;

    https.get(url, { headers: { 'User-Agent': 'CinderLauncher/1.0.1 (aryansxs9)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.hits || []);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
});

ipcMain.handle('install-mod', async (event, { projectId, version, loader }) => {
  return new Promise((resolve) => {
    const loaderParam = loader.toLowerCase() === 'vanilla' ? 'fabric' : loader.toLowerCase();
    const url = `https://api.modrinth.com/v2/project/${projectId}/version?loaders=["${loaderParam}"]&game_versions=["${version}"]`;

    https.get(url, { headers: { 'User-Agent': 'CinderLauncher/1.0.1 (aryansxs9)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const versions = JSON.parse(data);
          if (!versions.length || !versions[0].files.length) {
            return resolve({ success: false, error: 'No compatible file found.' });
          }

          const primaryFile = versions[0].files.find(f => f.primary) || versions[0].files[0];
          const destPath = path.join(modsFolder, primaryFile.filename);
          const fileStream = fs.createWriteStream(destPath);

          https.get(primaryFile.url, (downloadStream) => {
            downloadStream.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              resolve({ success: true });
            });
          }).on('error', (err) => resolve({ success: false, error: err.message }));

        } catch (err) {
          resolve({ success: false, error: err.message });
        }
      });
    }).on('error', (err) => resolve({ success: false, error: err.message }));
  });
});

// 7. Minecraft Launch Handler
ipcMain.on('launch-game', async (event, config) => {
  const { username, version, loaderType, memoryMax, fpsBoost, serverIp } = config;

  // Optimized JVM Performance Flags
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

  const launchOpts = {
    authorization: Authenticator.getAuth(username || 'Player'),
    root: cinderRoot,
    version: {
      number: version,
      type: "release"
    },
    memory: {
      max: `${memoryMax || 4096}M`,
      min: "2048M"
    },
    customArgs: customArgs
  };

  // Attach quick-connect server IP if provided
  if (serverIp) {
    launchOpts.quickPlay = {
      type: 'multiplayer',
      identifier: serverIp
    };
  }

  // Configure Loaders
  if (loaderType === 'Fabric') {
    launchOpts.version.custom = 'fabric';
  } else if (loaderType === 'Forge') {
    launchOpts.version.custom = 'forge';
  }

  setRPCActivity(`Playing as ${username}`, `${version} (${loaderType})`);

  try {
    launcher.launch(launchOpts);

    launcher.on('debug', (e) => {
      mainWindow?.webContents.send('game-log', { text: e });
    });

    launcher.on('data', (e) => {
      mainWindow?.webContents.send('game-log', { text: e });
      mainWindow?.webContents.send('game-status', 'started');
    });

    launcher.on('progress', (e) => {
      mainWindow?.webContents.send('game-log', { 
        text: `Downloading ${e.type}: ${e.task} / ${e.total}` 
      });
    });

    launcher.on('close', () => {
      mainWindow?.webContents.send('game-status', 'closed');
      setRPCActivity('Idle in Launcher', 'Menu');
    });

  } catch (err) {
    mainWindow?.webContents.send('game-log', { text: `[ERROR]: ${err.message}` });
    mainWindow?.webContents.send('game-status', 'closed');
  }
});
      
