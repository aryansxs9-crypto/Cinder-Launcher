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

if (!fs.existsSync(cinderRoot)) {
  fs.mkdirSync(cinderRoot, { recursive: true });
}

const CLIENT_ID = '123456789012345678';
let rpcClient;

function initDiscordRPC() {
  try {
    DiscordRPC.register(CLIENT_ID);
    rpcClient = new DiscordRPC.Client({ transport: 'ipc' });

    rpcClient.on('ready', () => {
      setRPCActivity('Idle in Launcher', 'Main Menu');
    });

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
    width: 1080,
    height: 680,
    minWidth: 960,
    minHeight: 600,
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.on('open-external', (event, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

ipcMain.on('open-game-folder', () => {
  shell.openPath(cinderRoot);
});

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
            try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
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
      mainWindow?.webContents.send('game-log', { text: `Fabric resolution fallback to vanilla: ${e.message}` });
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
      setRPCActivity('Idle in Launcher', 'Main Menu');
    });

  } catch (err) {
    mainWindow?.webContents.send('game-log', { text: `[ERROR]: ${err.message}` });
    mainWindow?.webContents.send('game-status', 'closed');
  }
});

autoUpdater.on('update-available', () => {
  mainWindow?.webContents.send('update-message', 'Update available. Downloading...');
});

autoUpdater.on('update-downloaded', () => {
  mainWindow?.webContents.send('update-message', 'Update ready. Restarting...');
  setTimeout(() => {
    autoUpdater.quitAndInstall();
  }, 3000);
});
