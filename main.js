// Auto Java Downloader & Clean Extractor
async function ensureJavaRuntime(targetJavaMajor) {
  const javaDir = path.join(runtimesDir, `java-${targetJavaMajor}`);
  const cleanExe = path.join(javaDir, 'bin', 'javaw.exe');
  
  if (fs.existsSync(cleanExe)) {
    return cleanExe;
  }

  // If broken folder exists, wipe it first
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

  // Strip the top-level directory (e.g. "jdk-21.0.x+1/") so paths stay clean without '+' characters
  zipEntries.forEach((entry) => {
    const entryPath = entry.entryName;
    const parts = entryPath.split('/');
    parts.shift(); // Remove top level jdk-... folder
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
    // Fallback to java.exe if javaw.exe is absent
    const fallbackExe = path.join(javaDir, 'bin', 'java.exe');
    if (fs.existsSync(fallbackExe)) return fallbackExe;
    throw new Error(`Java extraction completed but bin/javaw.exe not found.`);
  }

  mainWindow?.webContents.send('game-log', { text: `[Java Engine] Java ${targetJavaMajor} installed cleanly.` });
  return cleanExe;
}
