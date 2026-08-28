const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const AdmZip = require('adm-zip');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { autoUpdater } = require('electron-updater');
const DiscordRPC = require('discord-rpc');

let mainWindow;
const launcher = new Client();
const cinderRoot = path.join(app.getPath('appData'), '.cinder');
const modsDir = path.join(cinderRoot, 'mods');
const runtimesDir = path.join(cinderRoot, 'runtime');

// Ensure root directories exist
[cinderRoot, modsDir, runtimesDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Discord RPC Setup
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

// Window Controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.on('open-external', (e, url) => { if (url) shell.openExternal(url); });
ipcMain.on('open-game-folder', () => shell.openPath(cinderRoot));

// Modrinth API IPC Handlers
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

    https.get(url, { headers: { 'User-Agent': 'CinderClient/1.0.0' } }, (res) => {
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

    https.get(url, { headers: { 'User-Agent': 'CinderClient/1.0.0' } }, (res) => {
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

// Automatic Java Runtime Resolver & Downloader
function getRequiredJavaVersion(mcVersion) {
  const parts = mcVersion.split('.').map(n => parseInt(n, 10));
  const major = parts[0];
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;

  if (major === 1) {
    if (minor > 20 || (minor === 20 && patch >= 5)) return 21; // MC 1.20.5, 1.21, 1.21.4+
    if (minor >= 17) return 17; // MC 1.17 - 1.20.4
    return 8; // MC 1.16.5 and below
  }
  return 21;
}

function findExecutable(dir, exeName) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const found = findExecutable(fullPath, exeName);
      if (found) return found;
    } else if (file.toLowerCase() === exeName.toLowerCase()) {
      return fullPath;
    }
  }
  return null;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CinderClient/1.0.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download runtime: HTTP ${res.statusCode}`));
      }
      const fileStream = fs.createWriteStream(dest);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
    }).on('error', reject);
  });
}

async function ensureJavaRuntime(targetJavaMajor) {
  const javaDir = path.join(runtimesDir, `java-${targetJavaMajor}`);
  
  if (fs.existsSync(javaDir)) {
    const existingExe = findExecutable(javaDir, 'javaw.exe') || findExecutable(javaDir, 'java.exe');
    if (existingExe) return existingExe;
  }

  fs.mkdirSync(javaDir, { recursive: true });
  mainWindow?.webContents.send('game-log', { text: `[Java Engine] Required Java ${targetJavaMajor} not found. Auto-downloading OpenJDK...` });

  const apiUrl = `https://api.adoptium.net/v3/binary/latest/${targetJavaMajor}/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk`;
  const zipPath = path.join(runtimesDir, `java-${targetJavaMajor}.zip`);

  mainWindow?.webContents.send('game-log', { text: `[Java Engine] Downloading portable Java ${targetJavaMajor} package...` });
  await downloadFile(apiUrl, zipPath);

  mainWindow?.webContents.send('game-log', { text: `[Java Engine] Extracting Java runtime into client folder...` });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(javaDir, true);

  // Clean up temporary zip
  try { fs.unlinkSync(zipPath); } catch (e) {}

  const javaExe = findExecutable(javaDir, 'javaw.exe') || findExecutable(javaDir, 'java.exe');
  if (!javaExe) throw new Error(`Java extraction succeeded but javaw.exe was not found.`);

  mainWindow?.webContents.send('game-log', { text: `[Java Engine] Java ${targetJavaMajor} installed and configured successfully.` });
  return javaExe;
}

// Launch Game Engine
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

  try {
    // 1. Resolve and ensure matching Java runtime automatically
    const targetJavaVer = getRequiredJavaVersion(version);
    const resolvedJavaPath = await ensureJavaRuntime(targetJavaVer);

    const launchOpts = {
      authorization: Authenticator.getAuth(username || 'Player'),
      root: cinderRoot,
      javaPath: resolvedJavaPath,
      version: versionConfig,
      memory: {
        max: `${memoryMax || 4096}M`,
        min: "2048M"
      },
      customArgs: customArgs
    };

    // 2. Fabric Loader Resolution & Profile Auto-Download
    if (loaderType === 'Fabric') {
      try {
        mainWindow?.webContents.send('game-log', { text: `[Fabric] Resolving Fabric Loader metadata for Minecraft ${version}...` });

        const loadersData = await new Promise((resolve, reject) => {
          https.get(`https://meta.fabricmc.net/v2/versions/loader/${version}`, { headers: { 'User-Agent': 'CinderClient/1.0.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
          }).on('error', reject);
        });

        if (!loadersData || loadersData.length === 0) {
          throw new Error(`No compatible Fabric Loader release for version ${version}`);
        }

        const loaderVer = loadersData[0].loader.version;
        const customVersionName = `fabric-loader-${loaderVer}-${version}`;
        const versionDir = path.join(cinderRoot, 'versions', customVersionName);
        const versionJsonPath = path.join(versionDir, `${customVersionName}.json`);

        if (!fs.existsSync(versionJsonPath)) {
          mainWindow?.webContents.send('game-log', { text: `[Fabric] Downloading profile JSON (${customVersionName})...` });
          fs.mkdirSync(versionDir, { recursive: true });

          const profileJson = await new Promise((resolve, reject) => {
            https.get(`https://meta.fabricmc.net/v2/versions/loader/${version}/${loaderVer}/profile/json`, { headers: { 'User-Agent': 'CinderClient/1.0.0' } }, (res) => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => resolve(data));
            }).on('error', reject);
          });

          fs.writeFileSync(versionJsonPath, profileJson, 'utf-8');
          mainWindow?.webContents.send('game-log', { text: `[Fabric] Profile ready.` });
        }

        versionConfig.custom = customVersionName;
      } catch (e) {
        mainWindow?.webContents.send('game-log', { text: `[Fabric Warning] ${e.message}. Launching Vanilla.` });
      }
    } else if (loaderType === 'Forge') {
      launchOpts.forge = true;
    }

    launchOpts.version = versionConfig;

    if (serverIp) {
      launchOpts.quickPlay = {
        type: 'multiplayer',
        identifier: serverIp
      };
    }

    setRPCActivity(`Playing as ${username || 'Player'}`, `${version} (${loaderType})`);

    mainWindow?.webContents.send('game-log', { text: `[Cinder] Initializing launch for Minecraft ${version} (${loaderType})...` });
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

// Auto-Updater Events
autoUpdater.on('update-available', () => {
  mainWindow?.webContents.send('update-message', 'Update available. Downloading...');
});

autoUpdater.on('update-downloaded', () => {
  mainWindow?.webContents.send('update-message', 'Update downloaded. Restarting...');
  setTimeout(() => autoUpdater.quitAndInstall(), 3000);
});
