// 7. Minecraft Launch Handler
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

  // Automatically fetch Fabric JSON profile
  if (loaderType === 'Fabric') {
    try {
      mainWindow?.webContents.send('game-log', { text: `Resolving Fabric metadata for ${version}...` });
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
      mainWindow?.webContents.send('game-log', { text: `Fabric fetch failed, fallback to vanilla: ${e.message}` });
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

  setRPCActivity(`Playing as ${username}`, `${version} (${loaderType})`);

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
      setRPCActivity('Idle in Launcher', 'Menu');
    });

  } catch (err) {
    mainWindow?.webContents.send('game-log', { text: `[ERROR]: ${err.message}` });
    mainWindow?.webContents.send('game-status', 'closed');
  }
});
