/*
 * Android TV Zero-Friction Controller
 *
 * Initialization:
 *   1. npm install
 *   2. Provide ADB using one of:
 *      - ./platform-tools/adb(.exe)
 *      - ANDROID_TV_CONTROLLER_ADB=/absolute/path/to/adb
 *      - adb on PATH
 *   3. Provide FFmpeg for H.264 mirroring using one of:
 *      - ./bin/ffmpeg(.exe)
 *      - ANDROID_TV_CONTROLLER_FFMPEG=/absolute/path/to/ffmpeg
 *      - ffmpeg on PATH
 *   4. Enable Wireless debugging on Android TV, pair once, then connect.
 */

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const AdbWrapper = require('./modules/adbWrapper');
const DeviceDiscovery = require('./modules/deviceDiscovery');
const StreamDecoder = require('./modules/streamDecoder');
const HeartbeatWorker = require('./modules/heartbeatWorker');
const ScrcpyController = require('./modules/scrcpyController');

let mainWindow;
let adb;
let discovery;
let streamDecoder;
let heartbeat;
let scrcpy;
let quitting = false;
let quitReady = false;
let serviceCleanup = null;
const savedScreenshots = new Set();
const smokeMode = process.env.ANDROID_TV_CONTROLLER_SMOKE === '1';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: !smokeMode,
    backgroundColor: '#121212',
    title: 'Android TV Controller',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (smokeMode) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => app.exit(0), 100);
    });
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || 'UNKNOWN',
    details: error?.details || null,
    stderr: error?.stderr || '',
    stdout: error?.stdout || ''
  };
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: serializeError(error) };
    }
  });
}

function bindIpc() {
  handle('system:status', async () => ({
    adb: await adb.getDiagnostics(),
    ffmpeg: await streamDecoder.getDiagnostics(),
    scrcpy: await scrcpy.getDiagnostics(),
    streamBaseUrl: streamDecoder.baseUrl
  }));

  handle('discovery:start', async () => {
    await discovery.start();
    return discovery.getDevices();
  });

  handle('discovery:stop', async () => {
    await discovery.stop();
    return true;
  });

  handle('devices:list-adb', async () => adb.listDevices());

  handle('devices:mdns-adb', async () => adb.listMdnsServices());

  handle('adb:pair', async ({ host, port, code }) => adb.pair(host, port, code));

  handle('adb:connect', async ({ host, port }) => adb.connect(host, port));

  handle('adb:disconnect', async ({ serial }) => {
    heartbeat.stop();
    return adb.disconnect(serial);
  });

  handle('adb:reset-server', async () => adb.resetServer());

  handle('device:select', async (device) => {
    heartbeat.start(device);
    return adb.getDeviceInfo(device.serial);
  });

  handle('device:info', async ({ serial }) => adb.getDeviceInfo(serial));

  handle('device:screenshot', async ({ serial }) => {
    const outputDir = path.join(app.getPath('pictures'), 'AndroidTVController');
    const result = await adb.saveScreenshot(serial, outputDir);
    savedScreenshots.add(result.path);
    return result;
  });

  handle('device:open-screenshot', async ({ path: screenshotPath }) => {
    if (!savedScreenshots.has(screenshotPath)) {
      throw new Error('Capture a screenshot before opening it.');
    }
    const error = await shell.openPath(screenshotPath);
    if (error) throw new Error(error);
    return true;
  });

  handle('device:wake', async ({ serial }) => adb.wake(serial));

  handle('device:sleep', async ({ serial }) => adb.sleep(serial));

  handle('device:reboot', async ({ serial }) => adb.reboot(serial));

  handle('device:open-settings', async ({ serial, target }) => adb.openSettings(serial, target));

  handle('device:animations', async ({ serial, enabled }) => adb.setAnimationScale(serial, enabled));

  handle('input:key', async ({ serial, keyCode }) => adb.sendKey(serial, keyCode));

  handle('input:tap', async ({ serial, x, y }) => adb.tap(serial, x, y));

  handle('input:swipe', async ({ serial, x1, y1, x2, y2, durationMs }) =>
    adb.swipe(serial, x1, y1, x2, y2, durationMs)
  );

  handle('input:mouse-move', async ({ serial, x, y }) => adb.mouseMove(serial, x, y));

  handle('remote:key', async ({ serial, keyCode }) => adb.sendKey(serial, keyCode));

  handle('remote:tap', async ({ serial, x, y }) => adb.tap(serial, x, y));

  handle('remote:swipe', async ({ serial, x1, y1, x2, y2, durationMs }) =>
    adb.swipe(serial, x1, y1, x2, y2, durationMs)
  );

  handle('remote:text', async ({ serial, text }) => adb.sendText(serial, text));

  handle('apps:list', async ({ serial }) => adb.listLeanbackApps(serial));

  handle('apps:launch', async ({ serial, packageName, activity }) =>
    adb.launchApp(serial, packageName, activity)
  );

  handle('apps:force-stop', async ({ serial, packageName }) => adb.forceStopApp(serial, packageName));

  handle('apps:clear-data', async ({ serial, packageName }) => adb.clearAppData(serial, packageName));

  handle('apps:set-enabled', async ({ serial, packageName, enabled }) =>
    adb.setPackageEnabled(serial, packageName, enabled)
  );

  handle('apps:uninstall-user', async ({ serial, packageName }) => adb.uninstallForUser(serial, packageName));

  handle('apps:install-apk', async ({ serial }) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Install one or more APK packages',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Android APK', extensions: ['apk'] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const installed = [];
    const failed = [];
    for (let index = 0; index < result.filePaths.length; index += 1) {
      const apkPath = result.filePaths[index];
      send('packages:install-progress', {
        serial,
        state: 'installing',
        index: index + 1,
        total: result.filePaths.length,
        fileName: path.basename(apkPath)
      });
      try {
        installed.push(await adb.installApk(serial, apkPath));
      } catch (error) {
        failed.push({ apkPath, error: serializeError(error) });
      }
    }

    const summary = {
      serial,
      installed,
      failed,
      total: result.filePaths.length,
      message: `${installed.length} of ${result.filePaths.length} APK package(s) installed`
    };
    send('packages:install-progress', { ...summary, state: failed.length ? 'partial' : 'complete' });
    return summary;
  });

  handle('packages:list', async ({ serial, scope }) => adb.getPackages(serial, scope));

  handle('launcher:install-apk', async ({ serial }) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Install Custom UI / Launcher APK',
      properties: ['openFile'],
      filters: [{ name: 'Android APK', extensions: ['apk'] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const install = await adb.installApk(serial, result.filePaths[0]);
    const launchers = await adb.listHomeLaunchers(serial);
    return { ...install, launchers };
  });

  handle('launcher:list', async ({ serial }) => ({
    current: await adb.getCurrentHomeActivity(serial),
    launchers: await adb.listHomeLaunchers(serial)
  }));

  handle('launcher:set-home', async ({ serial, component }) => adb.setHomeActivity(serial, component));

  handle('launcher:restore', async ({ serial, component }) => adb.setHomeActivity(serial, component));

  handle('debloat:backup', async ({ serial }) => adb.createDebloatBackup(serial, getBackupDir()));

  handle('debloat:list-packages', async ({ serial, scope }) => adb.getPackages(serial, scope));

  handle('debloat:disable', async ({ serial, packageName }) => {
    const backup = await adb.createDebloatBackup(serial, getBackupDir());
    const result = await adb.setPackageEnabled(serial, packageName, false);
    return { backup, result };
  });

  handle('debloat:enable', async ({ serial, packageName }) => adb.setPackageEnabled(serial, packageName, true));

  handle('debloat:remove-user', async ({ serial, packageName }) => {
    const backup = await adb.createDebloatBackup(serial, getBackupDir());
    const result = await adb.uninstallForUser(serial, packageName);
    return { backup, result };
  });

  handle('debloat:clear-data', async ({ serial, packageName }) => {
    const backup = await adb.createDebloatBackup(serial, getBackupDir());
    const result = await adb.clearAppData(serial, packageName);
    return { backup, result };
  });

  handle('debloat:restore-backup', async ({ serial }) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Restore disabled packages from backup',
      properties: ['openFile'],
      filters: [{ name: 'Android TV Controller Backup', extensions: ['json'] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    return adb.restoreDisabledFromBackup(serial, result.filePaths[0]);
  });

  handle('stream:url', async ({ serial, options }) => streamDecoder.getStreamUrl(serial, options));

  handle('stream:snapshot-url', async ({ serial }) => streamDecoder.getSnapshotUrl(serial));

  handle('stream:status', async ({ serial }) => streamDecoder.getStreamStatus(serial));

  handle('scrcpy:start', async ({ serial, options }) => scrcpy.start(serial, options));

  handle('scrcpy:stop', async ({ serial }) => scrcpy.stop(serial));

  handle('scrcpy:status', async ({ serial }) => scrcpy.getStatus(serial));

}

function getBackupDir() {
  return path.join(app.getPath('documents'), 'AndroidTVController', 'backups');
}

async function bootstrap() {
  if (quitting) return;
  const appRoot = path.resolve(__dirname, '..', '..');

  adb = new AdbWrapper({ appRoot, logger: console });
  streamDecoder = new StreamDecoder({ adb, appRoot, logger: console });
  discovery = new DeviceDiscovery({ adb, logger: console });
  heartbeat = new HeartbeatWorker({ adb, logger: console });
  scrcpy = new ScrcpyController({
    adb,
    appRoot,
    logger: console
  });

  discovery.on('devices', (devices) => send('devices:discovered', devices));
  discovery.on('error', (error) => send('discovery:error', serializeError(error)));
  heartbeat.on('status', (status) => send('heartbeat:status', status));
  heartbeat.on('error', (error) => send('heartbeat:error', serializeError(error)));
  streamDecoder.on('event', (event) => send('stream:event', event));
  streamDecoder.on('error', (error) => send('stream:error', serializeError(error)));
  scrcpy.on('event', (event) => send('scrcpy:event', event));

  await streamDecoder.start();
  if (quitting) return;
  bindIpc();
  createWindow();
}

app.whenReady().then(bootstrap).catch((error) => {
  console.error(error);
  app.quit();
});

function stopServices() {
  if (serviceCleanup) return serviceCleanup;
  const stops = [
    () => heartbeat?.stop(),
    () => adb?.cancelScreenshots(),
    () => discovery?.stop(),
    () => scrcpy?.stopAll(),
    () => streamDecoder?.stop()
  ];
  serviceCleanup = Promise.allSettled(stops.map((stop) => Promise.resolve().then(stop)))
    .then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') console.error('TV Studio cleanup failed:', result.reason);
      }
    })
    .finally(() => { serviceCleanup = null; });
  return serviceCleanup;
}

// Explicit Quit (including File > Exit) skips window-all-closed in Electron.
// Hold both quit paths until scrcpy has closed its window and Android server.
app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  stopServices().finally(() => {
    quitReady = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
  else stopServices();
});

app.on('activate', async () => {
  if (serviceCleanup) await serviceCleanup;
  if (!quitting && BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
