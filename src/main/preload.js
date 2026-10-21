const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, payload) {
  const response = await ipcRenderer.invoke(channel, payload);
  if (!response.ok) {
    const error = new Error(response.error.message);
    Object.assign(error, response.error);
    throw error;
  }

  return response.data;
}

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('androidTv', {
  getSystemStatus: () => invoke('system:status'),
  startDiscovery: () => invoke('discovery:start'),
  stopDiscovery: () => invoke('discovery:stop'),
  listAdbDevices: () => invoke('devices:list-adb'),
  listAdbMdnsServices: () => invoke('devices:mdns-adb'),
  pairAdb: (payload) => invoke('adb:pair', payload),
  connectAdb: (payload) => invoke('adb:connect', payload),
  disconnectAdb: (payload) => invoke('adb:disconnect', payload),
  resetAdbServer: () => invoke('adb:reset-server'),
  selectDevice: (payload) => invoke('device:select', payload),
  getDeviceInfo: (payload) => invoke('device:info', payload),
  captureScreenshot: (payload) => invoke('device:screenshot', payload),
  openScreenshot: (payload) => invoke('device:open-screenshot', payload),
  wakeDevice: (payload) => invoke('device:wake', payload),
  sleepDevice: (payload) => invoke('device:sleep', payload),
  rebootDevice: (payload) => invoke('device:reboot', payload),
  openDeviceSettings: (payload) => invoke('device:open-settings', payload),
  setAnimations: (payload) => invoke('device:animations', payload),
  inputKey: (payload) => invoke('input:key', payload),
  inputTap: (payload) => invoke('input:tap', payload),
  inputSwipe: (payload) => invoke('input:swipe', payload),
  inputMouseMove: (payload) => invoke('input:mouse-move', payload),
  sendKey: (payload) => invoke('remote:key', payload),
  tap: (payload) => invoke('remote:tap', payload),
  swipe: (payload) => invoke('remote:swipe', payload),
  sendText: (payload) => invoke('remote:text', payload),
  listApps: (payload) => invoke('apps:list', payload),
  launchApp: (payload) => invoke('apps:launch', payload),
  forceStopApp: (payload) => invoke('apps:force-stop', payload),
  clearAppData: (payload) => invoke('apps:clear-data', payload),
  setAppEnabled: (payload) => invoke('apps:set-enabled', payload),
  uninstallAppForUser: (payload) => invoke('apps:uninstall-user', payload),
  installApk: (payload) => invoke('apps:install-apk', payload),
  listPackages: (payload) => invoke('packages:list', payload),
  installLauncherApk: (payload) => invoke('launcher:install-apk', payload),
  listLaunchers: (payload) => invoke('launcher:list', payload),
  setHomeLauncher: (payload) => invoke('launcher:set-home', payload),
  restoreHomeLauncher: (payload) => invoke('launcher:restore', payload),
  createDebloatBackup: (payload) => invoke('debloat:backup', payload),
  listDebloatPackages: (payload) => invoke('debloat:list-packages', payload),
  disablePackage: (payload) => invoke('debloat:disable', payload),
  enablePackage: (payload) => invoke('debloat:enable', payload),
  removePackageForUser: (payload) => invoke('debloat:remove-user', payload),
  clearPackageData: (payload) => invoke('debloat:clear-data', payload),
  restoreDebloatBackup: (payload) => invoke('debloat:restore-backup', payload),
  getStreamUrl: (payload) => invoke('stream:url', payload),
  getSnapshotUrl: (payload) => invoke('stream:snapshot-url', payload),
  getStreamStatus: (payload) => invoke('stream:status', payload),
  startScrcpy: (payload) => invoke('scrcpy:start', payload),
  stopScrcpy: (payload) => invoke('scrcpy:stop', payload),
  getScrcpyStatus: (payload) => invoke('scrcpy:status', payload),
  onDiscoveredDevices: (callback) => subscribe('devices:discovered', callback),
  onDiscoveryError: (callback) => subscribe('discovery:error', callback),
  onHeartbeatStatus: (callback) => subscribe('heartbeat:status', callback),
  onHeartbeatError: (callback) => subscribe('heartbeat:error', callback),
  onStreamEvent: (callback) => subscribe('stream:event', callback),
  onStreamError: (callback) => subscribe('stream:error', callback),
  onScrcpyEvent: (callback) => subscribe('scrcpy:event', callback),
  onPackageInstallProgress: (callback) => subscribe('packages:install-progress', callback)
});
