const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const AdmZip = require('adm-zip');
const msmc = require('msmc');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { autoUpdater } = require('electron-updater');
const DiscordRPC = require('discord-rpc');

let mainWindow;
const launcher = new Client();
const cinderRoot = path.join(app.getPath('appData'), '.cinder');
const modsDir = path.join(cinderRoot, 'mods');
const configDir = path.join(cinderRoot, 'config');
const runtimesDir = path.join(cinderRoot, 'runtime');
const authFile = path.join(cinderRoot, 'auth.json');

// Ensure system directories exist
[cinderRoot, modsDir, configDir, runtimesDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Discord Rich Presence Setup
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
    icon: path.join(__dirname, 'icon.ico'),
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

// Window Control IPC Handlers
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.on('open-external', (e, url) => { if (url) shell.openExternal(url); });
ipcMain.on('open-game-folder', () => shell.openPath(cinderRoot));

// Microsoft Authentication Handlers
ipcMain.handle('login-microsoft', async () => {
  try {
    const authManager = new msmc.Auth("select_account");
    const xboxManager = await authManager.launch("electron");
    const token = await xboxManager.getMinecraft();

    if (!token || !token.mclc()) {
      return { success: false, error: 'Could not obtain Minecraft Java token. Account may not own Minecraft.' };
    }

    const mclcAuth = token.mclc();
    fs.writeFileSync(authFile, JSON.stringify(mclcAuth, null, 2), 'utf-8');

    return {
      success: true,
      profile: {
        name: mclcAuth.name,
        uuid: mclcAuth.uuid,
        type: 'microsoft'
      }
    };
  } catch (err) {
    return { success: false, error: err.message || 'Authentication cancelled or failed.' };
  }
});

ipcMain.handle('logout-account', async () => {
  try {
    if (fs.existsSync(authFile)) fs.unlinkSync(authFile);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Helper for Modrinth File Installation
function fetchAndSaveMod(projectId, version, loader) {
  return new Promise((resolve) => {
    const url = `https://api.modrinth.com/v2/project/${projectId}/version?loaders=["${loader.toLowerCase()}"]&game_versions=["${version}"]`;

    https.get(url, { headers: { 'User-Agent': 'CinderClient/1.1.3' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const versions = JSON.parse(data);
          if (!versions || versions.length === 0) {
            return resolve({ success: false, mod: projectId, error: 'No compatible release' });
          }
          const primaryFile = versions[0].files.find(f => f.primary) || versions[0].files[0];
          const destPath = path.join(modsDir, primaryFile.filename);
          const fileStream = fs.createWriteStream(destPath);

          https.get(primaryFile.url, (fileRes) => {
            fileRes.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              resolve({ success: true, filename: primaryFile.filename });
            });
          }).on('error', (err) => resolve({ success: false, mod: projectId, error: err.message }));
        } catch (e) {
          resolve({ success: false, mod: projectId, error: e.message });
        }
      });
    }).on('error', (e) => resolve({ success: false, mod: projectId, error: e.message }));
  });
}

// 1-Click FPS Optimization Bundle Installer
ipcMain.handle('install-fps-bundle', async (event, { version, loader }) => {
  if (loader !== 'Fabric') {
    return { success: false, error: 'FPS Bundles are optimized for Fabric loader.' };
  }

  // Essential performance mods: Sodium, Lithium, FerriteCore, Entity Culling
  const fpsProjects = ['AANobbSp', 'gvQqBUqZ', 'uXXizFIs', 'NNAgCjsB'];
  const results = [];

  for (const proj of fpsProjects) {
    const res = await fetchAndSaveMod(proj, version, loader);
    results.push(res);
  }

  const installedCount = results.filter(r => r.success).length;
  return {
    success: installedCount > 0,
    count: installedCount,
    total: fpsProjects.length
  };
});

// Modrinth API Handlers
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

    https.get(url, { headers: { 'User-Agent': 'CinderClient/1.1.3' } }, (res) => {
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
  return fetchAndSaveMod(projectId, version, loader);
});

// ZIP Integrity Sanitizer
function cleanCorruptedJars(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      cleanCorruptedJars(fullPath);
    } else if (file.endsWith('.jar')) {
      try {
        const zip = new AdmZip(fullPath);
        zip.getEntries();
      } catch (e) {
        mainWindow?.webContents.send('game-log', { text: `[Sanitizer] Removed broken archive: ${file}` });
        try { fs.unlinkSync(fullPath); } catch (err) {}
      }
    }
  }
}

// Java Runtime Resolver & Clean Extractor
function getRequiredJavaVersion(mcVersion) {
  const parts = mcVersion.split('.').map(n => parseInt(n, 10));
  const major = parts[0];
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;

  if (major === 1) {
    if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
    if (minor >= 17) return 17;
    return 8;
  }
  return 21;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CinderClient/1.1.3' } }, (res) => {
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
  const cleanExe = path.join(javaDir, 'bin', 'javaw.exe');
  
  if (fs.existsSync(cleanExe)) {
    return cleanExe;
  }

  if (fs.existsSync(javaDir)) {
    try { fs.rmSync(javaDir, { recursive: true, force: true }); } catch (e) {}
  }
  fs.mkdirSync(javaDir, { recursive: true });

  mainWindow?.webContents.send('game-status', { stage: 'downloading', text: `Downloading Java ${targetJavaMajor}...`, percent: 20 });
  mainWindow?.webContents.send('game-log', { text: `[Java Engine] Downloading portable OpenJDK ${targetJavaMajor}...` });

  const apiUrl = `https://api.adoptium.net/v3/binary/latest/${targetJavaMajor}/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk`;
  const zipPath = path.join(runtimesDir, `temp-java-${targetJavaMajor}.zip`);

  await downloadFile(apiUrl, zipPath);

  mainWindow?.webContents.send('game-status', { stage: 'downloading', text: `Extracting Java ${targetJavaMajor}...`, percent: 60 });
  mainWindow?.webContents.send('game-log', { text: `[Java Engine] Unpacking Java runtime into clean path...` });
  
  const zip = new AdmZip(zipPath);
  const zipEntries = zip.getEntries();

  zipEntries.forEach((entry) => {
    const entryPath = entry.entryName;
    const parts = entryPath.split('/');
    parts.shift();
    const targetSubPath = parts.join(path.sep);

    if (targetSubPath) {
      const fullDestPath = path.join(javaDir, targetSubPath);
      if (entry.isDirectory) {
        fs.mkdirSync(fullDestPath, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(fullDestPath), { recursive: true });
        fs.writeFileSync(fullDestPath, entry.getData());
      }
    }
  });

  try { fs.unlinkSync(zipPath); } catch (e) {}

  if (!fs.existsSync(cleanExe)) {
    const fallbackExe = path.join(javaDir, 'bin', 'java.exe');
    if (fs.existsSync(fallbackExe)) return fallbackExe;
    throw new Error(`Java extraction completed but bin/javaw.exe not found.`);
  }

  mainWindow?.webContents.send('game-log', { text: `[Java Engine] Java ${targetJavaMajor} ready.` });
  return cleanExe;
}

// In-Launcher Process Killswitch
ipcMain.on('stop-game', () => {
  if (launcher && launcher.client) {
    launcher.client.kill();
    mainWindow?.webContents.send('game-status', { stage: 'closed', text: 'Launch Minecraft', percent: 0 });
    mainWindow?.webContents.send('game-log', { text: '[Cinder] Game instance terminated by user.' });
  }
});

// Game Launch Handler
ipcMain.on('launch-game', async (event, config) => {
  const { username, authType, version, loaderType, memoryMax, fpsBoost, serverIp, inGameConfig } = config;

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
    mainWindow?.webContents.send('game-status', { stage: 'loading', text: 'Checking Java Runtime...', percent: 10 });
    
    const targetJavaVer = getRequiredJavaVersion(version);
    const resolvedJavaPath = await ensureJavaRuntime(targetJavaVer);

    mainWindow?.webContents.send('game-status', { stage: 'loading', text: 'Verifying Library Integrity...', percent: 25 });
    cleanCorruptedJars(path.join(cinderRoot, 'libraries'));

    // Sync Launcher HUD Toggles to In-Game Mod JSON
    const hudConfigFile = path.join(configDir, 'cinder_hud.json');
    const hudConfigData = inGameConfig || {
      fpsCounter: true,
      cpsCounter: true,
      keystrokes: true,
      customCrosshair: false,
      fullbright: true
    };
    fs.writeFileSync(hudConfigFile, JSON.stringify(hudConfigData, null, 2), 'utf-8');

    let authPayload;
    if (authType === 'microsoft' && fs.existsSync(authFile)) {
      authPayload = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    } else {
      authPayload = Authenticator.getAuth(username || 'Player');
    }

    const launchOpts = {
      authorization: authPayload,
      root: cinderRoot,
      javaPath: resolvedJavaPath,
      version: versionConfig,
      memory: {
        max: `${memoryMax || 4096}M`,
        min: "2048M"
      },
      customArgs: customArgs
    };

    if (loaderType === 'Fabric') {
      try {
        mainWindow?.webContents.send('game-status', { stage: 'loading', text: 'Resolving Fabric Profile...', percent: 35 });
        mainWindow?.webContents.send('game-log', { text: `[Fabric] Resolving Fabric Loader for Minecraft ${version}...` });

        const loadersData = await new Promise((resolve, reject) => {
          https.get(`https://meta.fabricmc.net/v2/versions/loader/${version}`, { headers: { 'User-Agent': 'CinderClient/1.1.3' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
          }).on('error', reject);
        });

        if (!loadersData || loadersData.length === 0) {
          throw new Error(`No compatible Fabric Loader release found for ${version}`);
        }

        const loaderVer = loadersData[0].loader.version;
        const customVersionName = `fabric-loader-${loaderVer}-${version}`;
        const versionDir = path.join(cinderRoot, 'versions', customVersionName);
        const versionJsonPath = path.join(versionDir, `${customVersionName}.json`);

        if (!fs.existsSync(versionJsonPath)) {
          fs.mkdirSync(versionDir, { recursive: true });

          const profileJson = await new Promise((resolve, reject) => {
            https.get(`https://meta.fabricmc.net/v2/versions/loader/${version}/${loaderVer}/profile/json`, { headers: { 'User-Agent': 'CinderClient/1.1.3' } }, (res) => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => resolve(data));
            }).on('error', reject);
          });

          fs.writeFileSync(versionJsonPath, profileJson, 'utf-8');
        }

        versionConfig.custom = customVersionName;
      } catch (e) {
        mainWindow?.webContents.send('game-log', { text: `[Fabric Warning] ${e.message}. Launching standard Vanilla.` });
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

    const activeUser = authPayload.name || username || 'Player';
    setRPCActivity(`Playing as ${activeUser}`, `${version} (${loaderType})`);

    mainWindow?.webContents.send('game-status', { stage: 'loading', text: 'Initializing Minecraft Engine...', percent: 45 });
    mainWindow?.webContents.send('game-log', { text: `[Cinder] Initializing launch for Minecraft ${version} (${loaderType})...` });
    
    launcher.launch(launchOpts);

    launcher.on('debug', (e) => mainWindow?.webContents.send('game-log', { text: e }));

    launcher.on('progress', (e) => {
      const percent = e.total > 0 ? Math.round((e.task / e.total) * 100) : 0;
      mainWindow?.webContents.send('download-progress', {
        type: e.type,
        task: e.task,
        total: e.total,
        percent: percent
      });
      mainWindow?.webContents.send('game-status', { 
        stage: 'downloading', 
        text: `Downloading ${e.type} (${percent}%)`, 
        percent 
      });
    });

    launcher.on('data', (e) => {
      mainWindow?.webContents.send('game-log', { text: e });
      mainWindow?.webContents.send('game-status', { stage: 'launched', text: 'Minecraft is Running', percent: 100 });
    });

    launcher.on('close', () => {
      mainWindow?.webContents.send('game-status', { stage: 'closed', text: 'Launch Minecraft', percent: 0 });
      setRPCActivity('Idle in Launcher', 'Home');
    });

  } catch (err) {
    mainWindow?.webContents.send('game-log', { text: `[ERROR]: ${err.message}` });
    mainWindow?.webContents.send('game-status', { stage: 'closed', text: 'Launch Failed', percent: 0 });
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
