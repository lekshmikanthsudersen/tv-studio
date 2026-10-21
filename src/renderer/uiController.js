const api = window.androidTv;

const state = {
  discoveredDevices: [],
  adbDevices: [],
  wakeProfiles: [],
  wakeInFlight: false,
  wakeTargetKey: '',
  selectedOption: null,
  selectedDevice: null,
  serial: '',
  connectionGeneration: 0,
  display: { width: 1920, height: 1080 },
  apps: [],
  packages: [],
  launchers: [],
  mode: 'dpad',
  mirrorMode: 'off',
  scrcpyAvailable: false,
  scrcpyRunning: false,
  streamFailures: 0,
  snapshotTimer: null,
  snapshotUrl: '',
  snapshotToken: 0,
  snapshotPending: null,
  screenshotPath: '',
  keyInFlight: false,
  liveWatchdogTimer: null,
  liveStreamToken: 0,
  streamOptions: {
    size: '1280x720',
    fps: 30,
    bitrate: 4000000
  }
};

const els = {
  statusPill: document.getElementById('statusPill'),
  deviceSelect: document.getElementById('deviceSelect'),
  scanButton: document.getElementById('scanButton'),
  connectButton: document.getElementById('connectButton'),
  disconnectButton: document.getElementById('disconnectButton'),
  resetAdbButton: document.getElementById('resetAdbButton'),
  connectionMessage: document.getElementById('connectionMessage'),
  manualHostInput: document.getElementById('manualHostInput'),
  manualPortInput: document.getElementById('manualPortInput'),
  manualConnectButton: document.getElementById('manualConnectButton'),
  pairHostInput: document.getElementById('pairHostInput'),
  pairPortInput: document.getElementById('pairPortInput'),
  pairCodeInput: document.getElementById('pairCodeInput'),
  pairButton: document.getElementById('pairButton'),
  screenshotButton: document.getElementById('screenshotButton'),
  screenshotMessage: document.getElementById('screenshotMessage'),
  openScreenshotButton: document.getElementById('openScreenshotButton'),
  wakeButton: document.getElementById('wakeButton'),
  wakeMessage: document.getElementById('wakeMessage'),
  wakeMacInput: document.getElementById('wakeMacInput'),
  saveWakeButton: document.getElementById('saveWakeButton'),
  sleepButton: document.getElementById('sleepButton'),
  settingsButton: document.getElementById('settingsButton'),
  devSettingsButton: document.getElementById('devSettingsButton'),
  rebootButton: document.getElementById('rebootButton'),
  animOffButton: document.getElementById('animOffButton'),
  animOnButton: document.getElementById('animOnButton'),
  installApkButton: document.getElementById('installApkButton'),
  refreshLaunchersButton: document.getElementById('refreshLaunchersButton'),
  installLauncherButton: document.getElementById('installLauncherButton'),
  setLauncherButton: document.getElementById('setLauncherButton'),
  launcherSelect: document.getElementById('launcherSelect'),
  launcherMessage: document.getElementById('launcherMessage'),
  packageInput: document.getElementById('packageInput'),
  packageSearchInput: document.getElementById('packageSearchInput'),
  packageScopeSelect: document.getElementById('packageScopeSelect'),
  loadPackagesButton: document.getElementById('loadPackagesButton'),
  backupButton: document.getElementById('backupButton'),
  restoreBackupButton: document.getElementById('restoreBackupButton'),
  packageList: document.getElementById('packageList'),
  forceStopButton: document.getElementById('forceStopButton'),
  disablePackageButton: document.getElementById('disablePackageButton'),
  enablePackageButton: document.getElementById('enablePackageButton'),
  removePackageButton: document.getElementById('removePackageButton'),
  clearDataButton: document.getElementById('clearDataButton'),
  refreshAppsButton: document.getElementById('refreshAppsButton'),
  appGrid: document.getElementById('appGrid'),
  mirrorStage: document.getElementById('mirrorStage'),
  mirrorVideo: document.getElementById('mirrorVideo'),
  snapshotImage: document.getElementById('snapshotImage'),
  trackSurface: document.getElementById('trackSurface'),
  emptyState: document.getElementById('emptyState'),
  mirrorHintTitle: document.getElementById('mirrorHintTitle'),
  mirrorHintText: document.getElementById('mirrorHintText'),
  textInput: document.getElementById('textInput'),
  sendTextButton: document.getElementById('sendTextButton'),
  autoTypeToggle: document.getElementById('autoTypeToggle'),
  selectedDeviceLabel: document.getElementById('selectedDeviceLabel'),
  ffmpegStatusLabel: document.getElementById('ffmpegStatusLabel'),
  commandStatusLabel: document.getElementById('commandStatusLabel'),
  streamStatusPill: document.getElementById('streamStatusPill'),
  mirrorModeSelect: document.getElementById('mirrorModeSelect'),
  streamSizeSelect: document.getElementById('streamSizeSelect'),
  streamFpsSelect: document.getElementById('streamFpsSelect'),
  mouseMoveToggle: document.getElementById('mouseMoveToggle'),
  restartMirrorButton: document.getElementById('restartMirrorButton'),
  scrcpyStatusPill: document.getElementById('scrcpyStatusPill'),
  scrcpyQualitySelect: document.getElementById('scrcpyQualitySelect'),
  scrcpyAudioToggle: document.getElementById('scrcpyAudioToggle'),
  startScrcpyButton: document.getElementById('startScrcpyButton'),
  stopScrcpyButton: document.getElementById('stopScrcpyButton')
};

const dpadMap = new Map([
  ['ArrowUp', 'KEYCODE_DPAD_UP'],
  ['ArrowDown', 'KEYCODE_DPAD_DOWN'],
  ['ArrowLeft', 'KEYCODE_DPAD_LEFT'],
  ['ArrowRight', 'KEYCODE_DPAD_RIGHT'],
  ['Enter', 'KEYCODE_DPAD_CENTER'],
  ['Escape', 'KEYCODE_BACK'],
  ['Backspace', 'KEYCODE_DEL']
]);

let pointerStart = null;
let lastMouseMoveAt = 0;
let mouseMoveInFlight = false;
let mouseMoveUnsupported = false;

const LIVE_STREAM_TIMEOUT_MS = 7000;
const MOUSE_MOVE_INTERVAL_MS = 120;

init().catch((error) => showError(error));

async function init() {
  bindEvents();
  renderDeviceOptions();
  renderApps([]);
  renderLaunchers([]);
  setStatus('Idle', 'idle');
  setStreamStatus('Stream idle');
  setCommandStatus('No command yet');

  api.onDiscoveredDevices((devices) => {
    state.discoveredDevices = devices;
    renderDeviceOptions();
  });
  api.onDiscoveryError((error) => setMessage(error.message, 'warn'));
  api.onHeartbeatStatus((status) => handleHeartbeat(status));
  api.onHeartbeatError((error) => setMessage(error.message, 'warn'));
  api.onStreamEvent((event) => handleStreamEvent(event));
  api.onStreamError((error) => {
    setStreamStatus('Stream error');
    setMessage(error.message, 'warn');
  });
  api.onScrcpyEvent((event) => handleScrcpyEvent(event));
  api.onPackageInstallProgress((event) => {
    if (event.serial && state.serial && event.serial !== state.serial) return;
    if (event.state === 'installing') {
      setCommandStatus(`Installing ${event.index}/${event.total}: ${event.fileName}`);
    } else {
      setCommandStatus(event.message || 'Package installation finished');
    }
  });

  await Promise.all([loadSystemStatus(), loadWakeProfiles()]);
  await scanDevices();
}

function bindEvents() {
  els.scanButton.addEventListener('click', () => scanDevices().catch(showError));
  els.connectButton.addEventListener('click', () => connectSelected().catch(showError));
  els.manualConnectButton.addEventListener('click', () => manualConnect().catch(showError));
  els.disconnectButton.addEventListener('click', () => disconnect().catch(showError));
  els.resetAdbButton.addEventListener('click', () => resetAdbServer().catch(showError));
  els.pairButton.addEventListener('click', () => pair().catch(showError));
  els.screenshotButton.addEventListener('click', () => captureScreenshot().catch(showError));
  els.openScreenshotButton.addEventListener('click', () => {
    api.openScreenshot({ path: state.screenshotPath }).catch((error) => {
      els.screenshotMessage.textContent = `Couldn't open image: ${error.message || error}`;
    });
  });
  els.wakeButton.addEventListener('click', () => wakeSelectedTv().catch(showError));
  els.saveWakeButton.addEventListener('click', () => saveWakeSettings().catch(showError));
  els.sleepButton.addEventListener('click', () => runDeviceAction(() => api.sleepDevice({ serial: state.serial }), 'Sleep sent').catch(showError));
  els.settingsButton.addEventListener('click', () => runDeviceAction(() => api.openDeviceSettings({ serial: state.serial, target: 'settings' }), 'Settings opened').catch(showError));
  els.devSettingsButton.addEventListener('click', () => runDeviceAction(() => api.openDeviceSettings({ serial: state.serial, target: 'developer' }), 'Developer settings opened').catch(showError));
  els.rebootButton.addEventListener('click', () => rebootDevice().catch(showError));
  els.animOffButton.addEventListener('click', () => runDeviceAction(() => api.setAnimations({ serial: state.serial, enabled: false }), 'Animations disabled').catch(showError));
  els.animOnButton.addEventListener('click', () => runDeviceAction(() => api.setAnimations({ serial: state.serial, enabled: true }), 'Animations restored').catch(showError));
  els.installApkButton.addEventListener('click', () => installApk().catch(showError));
  els.refreshLaunchersButton.addEventListener('click', () => refreshLaunchers().catch(showError));
  els.installLauncherButton.addEventListener('click', () => installLauncherApk().catch(showError));
  els.setLauncherButton.addEventListener('click', () => setSelectedLauncher().catch(showError));
  els.loadPackagesButton.addEventListener('click', () => loadPackages().catch(showError));
  els.packageScopeSelect.addEventListener('change', () => loadPackages().catch(showError));
  els.packageSearchInput.addEventListener('input', () => renderPackageList(state.packages));
  els.backupButton.addEventListener('click', () => createDebloatBackup().catch(showError));
  els.restoreBackupButton.addEventListener('click', () => restoreDebloatBackup().catch(showError));
  els.forceStopButton.addEventListener('click', () => packageAction('force-stop').catch(showError));
  els.disablePackageButton.addEventListener('click', () => packageAction('disable').catch(showError));
  els.enablePackageButton.addEventListener('click', () => packageAction('enable').catch(showError));
  els.removePackageButton.addEventListener('click', () => packageAction('remove').catch(showError));
  els.clearDataButton.addEventListener('click', () => packageAction('clear').catch(showError));
  els.refreshAppsButton.addEventListener('click', () => refreshApps().catch(showError));
  els.sendTextButton.addEventListener('click', () => sendTextBuffer().catch(showError));
  els.textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendTextBuffer().catch(showError);
    }
  });

  els.deviceSelect.addEventListener('change', () => {
    state.connectionGeneration += 1;
    state.selectedOption = findSelectedOption();
    hydratePairInputs(state.selectedOption);
    hydrateWakeSettings();
    els.wakeMessage.textContent = '';
  });

  document.querySelectorAll('.mode-button').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  document.querySelectorAll('.media-button, .dpad-button, .remote-button').forEach((button) => {
    button.addEventListener('click', () => {
      els.mirrorStage.focus({ preventScroll: true });
      sendKey(button.dataset.key).catch(showError);
    });
  });

  els.mirrorModeSelect.addEventListener('change', () => {
    state.mirrorMode = els.mirrorModeSelect.value;
    startMirror().catch(showError);
  });

  els.restartMirrorButton.addEventListener('click', () => startMirror().catch(showError));
  els.startScrcpyButton.addEventListener('click', () => startInteractiveControl().catch(showError));
  els.stopScrcpyButton.addEventListener('click', () => stopInteractiveControl().catch(showError));
  for (const control of [els.scrcpyQualitySelect, els.scrcpyAudioToggle]) {
    control.addEventListener('change', () => {
      if (state.scrcpyRunning) startInteractiveControl().catch(showError);
    });
  }

  els.streamSizeSelect.addEventListener('change', () => {
    state.streamOptions.size = els.streamSizeSelect.value;
    startMirror().catch(showError);
  });

  els.streamFpsSelect.addEventListener('change', () => {
    state.streamOptions.fps = Number(els.streamFpsSelect.value);
    startMirror().catch(showError);
  });

  els.mouseMoveToggle.addEventListener('change', () => {
    mouseMoveUnsupported = false;
    syncMirrorInteractionClass();
    els.mirrorStage.focus();
  });

  document.addEventListener('keydown', handleGlobalKeyDown);
  els.trackSurface.addEventListener('pointerdown', handlePointerDown);
  els.trackSurface.addEventListener('pointermove', handlePointerMove);
  els.trackSurface.addEventListener('pointerup', handlePointerUp);
  els.trackSurface.addEventListener('pointercancel', () => {
    pointerStart = null;
  });

  els.mirrorVideo.addEventListener('error', () => handleStreamFailure());
  els.mirrorVideo.addEventListener('stalled', () => handleStreamFailure());
  els.mirrorVideo.addEventListener('playing', () => {
    if (state.mirrorMode !== 'h264' || state.scrcpyRunning) return;
    clearLiveWatchdog();
    state.streamFailures = 0;
    setStreamStatus('Stream live');
    els.emptyState.classList.add('hidden');
    els.snapshotImage.style.display = 'none';
    stopSnapshotFallback();
  });
  els.snapshotImage.addEventListener('load', () => finishSnapshot(true));
  els.snapshotImage.addEventListener('error', () => finishSnapshot(false));
}

async function loadSystemStatus() {
  const status = await api.getSystemStatus();
  if (!status.adb.available) {
    setStatus('ADB', 'error');
    setMessage(status.adb.error, 'error');
    return;
  }
  if (!status.ffmpeg.available) {
    els.ffmpegStatusLabel.textContent = 'Fallback: snapshots only';
  } else {
    els.ffmpegStatusLabel.textContent = 'Fallback engine ready';
  }

  state.scrcpyAvailable = Boolean(status.scrcpy?.available);
  if (state.scrcpyAvailable) {
    setScrcpyStatus('Interactive engine ready', 'ready');
    els.ffmpegStatusLabel.textContent = `${status.scrcpy.version} · fallback ready`;
  } else {
    setScrcpyStatus('Interactive engine missing', 'error');
    els.ffmpegStatusLabel.textContent = `scrcpy missing · ${els.ffmpegStatusLabel.textContent}`;
    setMessage('Low-latency control runtime is missing. The compatibility mirror will be used.', 'warn');
  }
}

async function scanDevices() {
  setStatus('Scan', 'warn');
  const [discovered, adbMdnsDevices, adbDevices] = await Promise.all([
    api.startDiscovery(),
    api.listAdbMdnsServices().catch((error) => {
      setMessage(error.message, 'warn');
      return [];
    }),
    api.listAdbDevices().catch((error) => {
      setMessage(error.message, 'warn');
      return [];
    })
  ]);

  state.discoveredDevices = mergeDiscoveredDevices(adbMdnsDevices, discovered);
  state.adbDevices = adbDevices;
  renderDeviceOptions();
  setStatus(state.serial ? 'Online' : 'Ready', state.serial ? 'ok' : 'idle');
}

function renderDeviceOptions() {
  const previous = els.deviceSelect.value;
  const previousTarget = selectedWakeTarget();
  const options = [
    ...state.adbDevices.map((device) => ({
      id: device.id,
      label: formatAdbDeviceLabel(device),
      kind: 'adb',
      device
    })),
    ...state.discoveredDevices.map((device) => ({
      id: device.id,
      label: formatDiscoveredDeviceLabel(device),
      kind: 'mdns',
      device
    })),
    ...state.wakeProfiles.filter((profile) =>
      !state.adbDevices.some((device) => device.serial === profile.serial) &&
      !state.discoveredDevices.some((device) => (device.address || device.host) === profile.host)
    ).map((device) => ({
      id: device.id, label: `${device.name || device.host} · saved for wake`, kind: 'wake', device
    }))
  ];

  els.deviceSelect.innerHTML = '';

  if (options.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No devices found';
    els.deviceSelect.appendChild(option);
    state.selectedOption = null;
    hydrateWakeSettings();
    return;
  }

  for (const item of options) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    els.deviceSelect.appendChild(option);
  }

  if (previous && options.some((item) => item.id === previous)) {
    els.deviceSelect.value = previous;
  } else if (previousTarget?.serial) {
    const sameTv = options.find((item) => wakeTargetForDevice(item.device).serial === previousTarget.serial);
    if (sameTv) els.deviceSelect.value = sameTv.id;
  }

  state.selectedOption = findSelectedOption();
  hydratePairInputs(state.selectedOption);
  hydrateWakeSettings();
}

function findSelectedOption() {
  const id = els.deviceSelect.value;
  const adbDevice = state.adbDevices.find((device) => device.id === id);
  if (adbDevice) {
    return { id, kind: 'adb', device: adbDevice };
  }

  const discovered = state.discoveredDevices.find((device) => device.id === id);
  if (discovered) {
    return { id, kind: 'mdns', device: discovered };
  }

  const saved = state.wakeProfiles.find((profile) => profile.id === id);
  if (saved) return { id, kind: 'wake', device: saved };

  return null;
}

function mergeDiscoveredDevices(primary, secondary) {
  const merged = new Map();
  for (const device of [...primary, ...secondary]) {
    const key = device.address || device.host || device.id;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, device);
      continue;
    }

    merged.set(key, {
      ...existing,
      ...device,
      name: existing.name || device.name,
      services: {
        ...(device.services || {}),
        ...(existing.services || {})
      }
    });
  }

  return Array.from(merged.values());
}

function hydratePairInputs(option) {
  if (!option || option.kind !== 'mdns') {
    return;
  }

  const device = option.device;
  const pairing = device.services?.adbPairing;
  els.pairHostInput.value = device.address || device.host || '';
  els.manualHostInput.value = device.address || device.host || '';
  if (pairing?.port) {
    els.pairPortInput.value = pairing.port;
  }
  if (device.services?.adbConnect?.port) {
    els.manualPortInput.value = device.services.adbConnect.port;
  }
}

async function manualConnect() {
  const host = els.manualHostInput.value.trim();
  const port = Number(els.manualPortInput.value || 5555);
  if (!host) {
    throw new Error('Enter the TV IP first.');
  }

  setStatus('Link', 'warn');
  setMessage('');
  const generation = ++state.connectionGeneration;
  const result = await api.connectAdb({ host, port });
  if (generation !== state.connectionGeneration) return;
  await selectDevice({
    serial: result.serial,
    host,
    address: host,
    port
  });
}

async function loadWakeProfiles() {
  state.wakeProfiles = await api.getWakeProfiles();
  renderDeviceOptions();
}

function selectedWakeTarget() {
  const selected = state.selectedOption || findSelectedOption();
  const device = selected?.device || state.selectedDevice;
  if (!device) return null;
  return wakeTargetForDevice(device);
}

function wakeTargetForDevice(device) {
  const host = device.address || device.host || hostFromSerial(device.serial || '');
  const saved = state.wakeProfiles.find((profile) => profile.serial === device.serial || profile.host === host);
  const serialPort = String(device.serial || '').match(/:(\d+)$/)?.[1];
  const port = device.services?.adbConnect?.port || device.port || Number(serialPort) || saved?.port || 5555;
  return { ...saved, ...device, host, port, serial: device.serial || (host ? `${host}:${port}` : ''),
    macAddress: device.macAddress || saved?.macAddress || '' };
}

function hydrateWakeSettings(force = false) {
  const target = selectedWakeTarget();
  const key = target?.serial || target?.host || '';
  if (force || key !== state.wakeTargetKey) {
    els.wakeMacInput.value = target?.macAddress || '';
    state.wakeTargetKey = key;
  }
  els.wakeButton.disabled = state.wakeInFlight || !target;
  els.saveWakeButton.disabled = !target || state.wakeInFlight;
}

async function saveWakeSettings() {
  const target = selectedWakeTarget();
  if (!target) throw new Error('Select a TV or connect to it once before saving wake settings.');
  const profile = await api.saveWakeProfile({ ...target, macAddress: els.wakeMacInput.value.trim() });
  state.wakeProfiles = [profile, ...state.wakeProfiles.filter((p) => p.id !== profile.id)];
  renderDeviceOptions();
  hydrateWakeSettings(true);
  els.wakeMessage.textContent = 'TV remembered. Wake TV remains available when it goes offline.';
  els.wakeMessage.className = 'message';
}

async function wakeSelectedTv() {
  if (state.wakeInFlight) return;
  const target = selectedWakeTarget();
  if (!target) throw new Error('Select a saved TV or connect to it once while it is on.');
  const generation = ++state.connectionGeneration;
  let completionGeneration = generation;
  state.wakeInFlight = true;
  hydrateWakeSettings();
  els.wakeButton.textContent = 'Waking…';
  els.wakeMessage.textContent = 'Waking the TV and waiting for it to reconnect…';
  els.wakeMessage.className = 'message';
  try {
    const result = await api.wakeDevice(target);
    if (generation !== state.connectionGeneration || selectedWakeTarget()?.serial !== target.serial) return;
    if (result.connected && result.profile) {
      completionGeneration = generation + 1;
      await selectDevice({ ...result.profile, address: result.profile.host }, { startControl: false });
      if (state.connectionGeneration !== generation + 1) return;
    }
    els.wakeMessage.textContent = result.message;
    els.wakeMessage.className = `message ${result.awakeConfirmed ? '' : 'warn'}`.trim();
    setCommandStatus(result.awakeConfirmed ? 'TV awake' : 'Wake request finished');
  } catch (error) {
    if (completionGeneration !== state.connectionGeneration) return;
    els.wakeMessage.textContent = error.message || String(error);
    els.wakeMessage.className = 'message error';
    throw error;
  } finally {
    state.wakeInFlight = false;
    els.wakeButton.textContent = 'Wake TV';
    hydrateWakeSettings();
  }
}

async function connectSelected() {
  const selected = state.selectedOption || findSelectedOption();
  if (!selected) {
    throw new Error('Select a device first.');
  }

  setStatus('Link', 'warn');
  setMessage('');

  if (selected.kind === 'adb') {
    const device = selected.device;
    if (device.unauthorized) {
      setStatus('Auth', 'warn');
      setMessage('Authorize ADB on the TV screen or pair with the Wireless debugging code.', 'warn');
      return;
    }
    if (device.offline) {
      throw new Error('ADB reports this device as offline.');
    }
    await selectDevice({ serial: device.serial, host: hostFromSerial(device.serial), port: portFromSerial(device.serial) });
    return;
  }

  const device = selected.device;
  const host = device.address || device.host;
  const service = device.services?.adbConnect;
  const port = service?.port || device.port || 5555;
  if (!host) {
    throw new Error('Discovered device did not publish an address.');
  }

  const generation = ++state.connectionGeneration;
  const result = await api.connectAdb({ host, port });
  if (generation !== state.connectionGeneration) return;
  await selectDevice({
    serial: result.serial,
    host: device.host,
    address: device.address,
    port,
    services: device.services
  });
}

async function selectDevice(device, { startControl = true } = {}) {
  const generation = ++state.connectionGeneration;
  const previousSerial = state.serial;
  const switchingWakeTarget = !startControl && previousSerial && previousSerial !== device.serial;
  if (switchingWakeTarget) {
    // A wake can select another TV without starting scrcpy, so explicitly
    // retire the old TV's native and compatibility sessions before retargeting.
    els.mirrorModeSelect.value = 'off';
    await startMirror();
    if (generation !== state.connectionGeneration) return;
    await api.stopScrcpy({ serial: previousSerial });
    if (generation !== state.connectionGeneration) return;
    state.scrcpyRunning = false;
    setControlOptionsDisabled(false);
    setScrcpyStatus(state.scrcpyAvailable ? 'Interactive engine ready' : 'Interactive engine missing');
  }
  const info = await api.selectDevice(device);
  if (generation !== state.connectionGeneration) return;
  state.selectedDevice = device;
  state.serial = device.serial;
  state.display = info.display || state.display;
  els.emptyState.classList.add('hidden');
  setStatus('Online', 'ok');
  els.selectedDeviceLabel.textContent = `${device.serial} - ${state.display.width}x${state.display.height}`;
  setMessage(deviceLabel(info));
  if (!startControl && !state.scrcpyRunning && state.mirrorMode === 'off') {
    setMirrorHint('TV ready for control', 'Choose Start control to open this TV, or use the remote buttons and tools.');
  }
  if (info.wakeProfile) {
    state.wakeProfiles = [info.wakeProfile, ...state.wakeProfiles.filter((p) => p.id !== info.wakeProfile.id)];
    renderDeviceOptions();
    hydrateWakeSettings(true);
  }
  await Promise.all([
    startControl ? startPreferredMirror() : Promise.resolve(),
    refreshApps(),
    refreshLaunchers().catch(() => null)
  ]);
}

async function disconnect() {
  const generation = ++state.connectionGeneration;
  els.wakeMessage.textContent = '';
  const serial = state.serial;
  state.mirrorMode = 'off';
  state.liveStreamToken += 1;
  clearLiveWatchdog();
  await stopSnapshotFallback();
  if (generation !== state.connectionGeneration) return;
  if (serial) {
    await api.stopScrcpy({ serial }).catch(() => null);
    if (generation !== state.connectionGeneration) return;
    await api.disconnectAdb({ serial }).catch(() => null);
  }
  if (generation !== state.connectionGeneration) return;
  state.serial = '';
  state.selectedDevice = null;
  state.scrcpyRunning = false;
  setControlOptionsDisabled(false);
  els.selectedDeviceLabel.textContent = 'No device';
  els.mirrorVideo.removeAttribute('src');
  els.mirrorVideo.load();
  els.snapshotImage.removeAttribute('src');
  els.snapshotImage.style.display = 'none';
  renderApps([]);
  renderPackageList([]);
  renderLaunchers([]);
  els.emptyState.classList.remove('hidden');
  setMirrorHint('Connect your Android TV', 'Live control opens in its own TV window. Keep this panel nearby for remote buttons and tools.');
  setStreamStatus('Stream idle');
  setScrcpyStatus(state.scrcpyAvailable ? 'Interactive engine ready' : 'Interactive engine missing');
  setCommandStatus('No command yet');
  setStatus('Idle', 'idle');
  setMessage('');
}

async function resetAdbServer() {
  els.resetAdbButton.disabled = true;
  setStatus('ADB', 'warn');
  setCommandStatus('Resetting ADB server');
  try {
    const result = await api.resetAdbServer();
    setStatus(state.serial ? 'Online' : 'Ready', state.serial ? 'ok' : 'idle');
    setMessage(result.message || 'ADB server restarted.');
    setCommandStatus('ADB server restarted');
    await scanDevices().catch(() => null);
  } finally {
    els.resetAdbButton.disabled = false;
  }
}

async function pair() {
  const host = els.pairHostInput.value.trim();
  const port = Number(els.pairPortInput.value);
  const code = els.pairCodeInput.value.trim();

  setStatus('Pair', 'warn');
  const result = await api.pairAdb({ host, port, code });
  setMessage(result.message || `Paired with ${result.target}`);
  await scanDevices();
}

async function startPreferredMirror() {
  const serial = state.serial;
  const generation = state.connectionGeneration;
  if (state.scrcpyAvailable) {
    try {
      await startInteractiveControl();
      return;
    } catch (error) {
      if (error.code === 'SCRCPY_START_CANCELLED' || generation !== state.connectionGeneration || serial !== state.serial) return;
      setMessage(`Interactive control could not start: ${error.message}. Using compatibility view.`, 'warn');
    }
  }

  if (!serial || generation !== state.connectionGeneration || serial !== state.serial) return;
  els.mirrorModeSelect.value = 'snapshot';
  await startMirror();
}

async function startInteractiveControl() {
  requireSerial();
  const serial = state.serial;
  const generation = state.connectionGeneration;
  if (!state.scrcpyAvailable) {
    throw new Error('The scrcpy interactive runtime is not installed.');
  }

  setControlOptionsDisabled(true);
  setScrcpyStatus('Starting control', 'starting');
  setCommandStatus('Starting low-latency TV control');

  try {
    els.mirrorModeSelect.value = 'off';
    await startMirror();
    if (generation !== state.connectionGeneration || serial !== state.serial) return { running: false, state: 'stopped' };
    const result = await api.startScrcpy({
      serial,
      options: getScrcpyOptions()
    });
    if (generation !== state.connectionGeneration || serial !== state.serial) return { running: false, state: 'stopped' };
    state.scrcpyRunning = Boolean(result.running);
    setMirrorHint('Control the TV in its own window', 'Click the TV window to control it. Move the pointer out or use Alt+Tab to return. For remote-only menus such as Free My TV, use arrows and Enter.');
    setScrcpyStatus(result.state === 'live' ? 'TV window live' : 'Starting TV window', result.state);
    setCommandStatus(result.state === 'live' ? 'TV window ready; click it to control your TV' : 'Opening the TV control window');
    return result;
  } catch (error) {
    if (error.code === 'SCRCPY_START_CANCELLED' || generation !== state.connectionGeneration || serial !== state.serial) {
      return { running: false, state: 'stopped' };
    }
    throw error;
  } finally {
    if (generation === state.connectionGeneration) setControlOptionsDisabled(false);
  }
}

function setControlOptionsDisabled(disabled) {
  els.startScrcpyButton.disabled = disabled;
  els.scrcpyQualitySelect.disabled = disabled;
  els.scrcpyAudioToggle.disabled = disabled;
}

async function stopInteractiveControl() {
  if (!state.serial) return;
  els.stopScrcpyButton.disabled = true;
  try {
    await api.stopScrcpy({ serial: state.serial });
    state.scrcpyRunning = false;
    setScrcpyStatus('Interactive control stopped');
    setCommandStatus('Interactive control stopped');
    setMirrorHint('TV control is stopped', 'Choose Start control to open the TV window, or select a compatibility mirror below.');
  } finally {
    els.stopScrcpyButton.disabled = false;
  }
}

function getScrcpyOptions() {
  const profiles = {
    speed: { maxSize: 1280, maxFps: 60, videoBitrate: 5 },
    balanced: { maxSize: 1920, maxFps: 60, videoBitrate: 8 },
    quality: { maxSize: 2560, maxFps: 60, videoBitrate: 14 }
  };
  const profile = profiles[els.scrcpyQualitySelect.value] || profiles.speed;
  return {
    ...profile,
    inputMode: 'compatibility',
    audio: els.scrcpyAudioToggle.checked
  };
}

function setMirrorHint(title, text) {
  els.mirrorHintTitle.textContent = title;
  els.mirrorHintText.textContent = text;
  els.emptyState.classList.remove('hidden');
}

async function startMirror() {
  if (!state.serial) {
    return;
  }

  state.mirrorMode = els.mirrorModeSelect.value;
  const token = ++state.liveStreamToken;
  if (state.mirrorMode === 'off') {
    clearLiveWatchdog();
    await stopSnapshotFallback();
    if (token !== state.liveStreamToken) return;
    els.mirrorVideo.removeAttribute('src');
    els.mirrorVideo.load();
    els.mirrorVideo.style.display = 'none';
    els.snapshotImage.removeAttribute('src');
    els.snapshotImage.style.display = 'none';
    setStreamStatus('Mirror off');
    return;
  }

  if (state.scrcpyRunning) await stopInteractiveControl();

  if (state.mirrorMode === 'snapshot') {
    await startSnapshotFallback('Reliable view');
    return;
  }

  await restartH264Stream();
}

async function restartH264Stream() {
  if (!state.serial) {
    return;
  }

  const token = state.liveStreamToken + 1;
  state.liveStreamToken = token;
  stopSnapshotFallback();
  clearLiveWatchdog();
  els.snapshotImage.style.display = 'none';
  els.mirrorVideo.style.display = 'block';
  state.streamFailures = 0;
  setStreamStatus('Stream starting');

  try {
    const url = await api.getStreamUrl({
      serial: state.serial,
      options: state.streamOptions
    });

    if (token !== state.liveStreamToken || state.mirrorMode !== 'h264') {
      return;
    }

    els.mirrorVideo.src = `${url}&t=${Date.now()}`;
    els.mirrorVideo.load();
    armLiveWatchdog(token);
    await els.mirrorVideo.play().catch(() => null);
  } catch (error) {
    if (token !== state.liveStreamToken || state.mirrorMode !== 'h264' || state.scrcpyRunning) return;
    setMessage(error.message || String(error), 'warn');
    await switchToSnapshot('H.264 failed; using Reliable View');
  }
}

async function handleStreamFailure() {
  if (!state.serial || state.mirrorMode !== 'h264' || state.scrcpyRunning) {
    return;
  }

  clearLiveWatchdog();
  state.streamFailures += 1;
  setStreamStatus(`Stream retry ${state.streamFailures}`);
  if (state.mirrorMode === 'h264' && state.streamFailures < 2) {
    const token = state.liveStreamToken;
    window.setTimeout(() => {
      if (token === state.liveStreamToken && state.mirrorMode === 'h264' && !state.scrcpyRunning) {
        restartH264Stream().catch(showError);
      }
    }, 800 * state.streamFailures);
    return;
  }

  els.mirrorModeSelect.value = 'snapshot';
  state.mirrorMode = 'snapshot';
  await startSnapshotFallback('H.264 failed; using reliable view');
}

async function startSnapshotFallback(reason = 'Snapshot fallback') {
  if (!state.serial || state.scrcpyRunning) {
    return;
  }

  clearLiveWatchdog();
  stopSnapshotFallback();
  const token = state.snapshotToken;
  els.mirrorModeSelect.value = 'snapshot';
  state.mirrorMode = 'snapshot';
  els.mirrorVideo.removeAttribute('src');
  els.mirrorVideo.load();
  const snapshotUrl = await api.getSnapshotUrl({ serial: state.serial });
  if (token !== state.snapshotToken || state.mirrorMode !== 'snapshot' || state.scrcpyRunning) return;
  state.snapshotUrl = snapshotUrl;
  setStreamStatus(reason);
  els.mirrorVideo.style.display = 'none';
  els.snapshotImage.style.display = 'block';
  refreshSnapshot();
}

function refreshSnapshot() {
  state.snapshotTimer = null;
  if (state.snapshotPending || !state.snapshotUrl || state.mirrorMode !== 'snapshot' || state.scrcpyRunning) return;
  const pending = { token: state.snapshotToken };
  pending.promise = new Promise((resolve) => { pending.resolve = resolve; });
  state.snapshotPending = pending;
  els.snapshotImage.src = `${state.snapshotUrl}&t=${Date.now()}`;
}

function finishSnapshot(loaded) {
  const pending = state.snapshotPending;
  if (!pending) return;
  state.snapshotPending = null;
  pending.resolve();
  if (!state.snapshotUrl || state.mirrorMode !== 'snapshot' || state.scrcpyRunning) return;
  if (pending.token === state.snapshotToken) {
    setStreamStatus(loaded ? 'Reliable view live' : 'Snapshot error; retrying');
    if (loaded) els.emptyState.classList.add('hidden');
  }
  // Wait for the TV to finish the current capture before scheduling another.
  state.snapshotTimer = window.setTimeout(refreshSnapshot, loaded ? 800 : 1500);
}

function stopSnapshotFallback() {
  state.snapshotToken += 1;
  state.snapshotUrl = '';
  if (state.snapshotTimer) {
    window.clearTimeout(state.snapshotTimer);
    state.snapshotTimer = null;
  }
  return state.snapshotPending?.promise || Promise.resolve();
}

function armLiveWatchdog(token) {
  clearLiveWatchdog();
  state.liveWatchdogTimer = window.setTimeout(() => {
    if (!state.serial || token !== state.liveStreamToken || state.mirrorMode !== 'h264') {
      return;
    }

    switchToSnapshot('Live H.264 timed out; using Reliable View').catch(showError);
  }, LIVE_STREAM_TIMEOUT_MS);
}

function clearLiveWatchdog() {
  if (state.liveWatchdogTimer) {
    window.clearTimeout(state.liveWatchdogTimer);
    state.liveWatchdogTimer = null;
  }
}

async function switchToSnapshot(reason) {
  clearLiveWatchdog();
  state.liveStreamToken += 1;
  els.mirrorModeSelect.value = 'snapshot';
  state.mirrorMode = 'snapshot';
  setMessage(reason, 'warn');
  await startSnapshotFallback(reason);
}

async function refreshApps() {
  if (!state.serial) {
    renderApps([]);
    return;
  }

  els.refreshAppsButton.disabled = true;
  try {
    const apps = await api.listApps({ serial: state.serial });
    state.apps = apps;
    renderApps(apps);
  } finally {
    els.refreshAppsButton.disabled = false;
  }
}

function renderApps(apps) {
  els.appGrid.innerHTML = '';

  if (!apps.length) {
    const empty = document.createElement('div');
    empty.className = 'message';
    empty.textContent = state.serial ? 'No leanback apps returned' : 'Connect a device';
    els.appGrid.appendChild(empty);
    return;
  }

  for (const app of apps) {
    const tile = document.createElement('div');
    tile.className = 'app-tile';
    tile.title = app.packageName;
    const launch = document.createElement('button');
    launch.className = 'app-launch';
    launch.type = 'button';
    launch.addEventListener('click', () => {
      api.launchApp({
        serial: state.serial,
        packageName: app.packageName,
        activity: app.activity
      }).catch(showError);
    });

    const icon = document.createElement('div');
    icon.className = 'app-icon';
    icon.textContent = app.icon?.text || app.name.slice(0, 1);
    icon.style.background = app.icon?.background || '#2457d6';

    const name = document.createElement('div');
    name.className = 'app-name';
    name.textContent = app.name;

    launch.append(icon, name);

    const actions = document.createElement('div');
    actions.className = 'app-actions';

    const useButton = document.createElement('button');
    useButton.className = 'mini-button';
    useButton.type = 'button';
    useButton.textContent = 'Pkg';
    useButton.title = app.packageName;
    useButton.addEventListener('click', () => setPackageInput(app.packageName));

    const stopButton = document.createElement('button');
    stopButton.className = 'mini-button';
    stopButton.type = 'button';
    stopButton.textContent = 'Stop';
    stopButton.addEventListener('click', () => {
      api.forceStopApp({ serial: state.serial, packageName: app.packageName })
        .then(() => setMessage(`Stopped ${app.name}`))
        .catch(showError);
    });

    actions.append(useButton, stopButton);
    tile.append(launch, actions);
    els.appGrid.appendChild(tile);
  }
}

async function captureScreenshot() {
  requireSerial();
  if (els.screenshotButton.disabled) return;
  els.screenshotButton.disabled = true;
  els.screenshotButton.textContent = 'Capturing…';
  els.openScreenshotButton.hidden = true;
  els.screenshotMessage.textContent = 'Capturing the TV screen…';
  setCommandStatus('Capturing screenshot');
  try {
    const result = await api.captureScreenshot({ serial: state.serial });
    state.screenshotPath = result.path;
    const name = result.path.split(/[\\/]/).pop();
    const timing = Number.isFinite(result.captureMs) ? ` (${(result.captureMs / 1000).toFixed(1)}s)` : '';
    els.screenshotMessage.textContent = `Saved ${name}${timing}`;
    els.screenshotMessage.title = result.path;
    els.openScreenshotButton.hidden = false;
    setCommandStatus(`Screenshot saved${timing}`);
  } catch (error) {
    els.screenshotMessage.textContent = `Screenshot failed: ${error.message || error}`;
    throw error;
  } finally {
    els.screenshotButton.disabled = false;
    els.screenshotButton.textContent = 'Screenshot';
  }
}

async function runDeviceAction(action, successMessage) {
  requireSerial();
  els.wakeMessage.textContent = '';
  await action();
  setMessage(successMessage);
}

async function rebootDevice() {
  requireSerial();
  if (!window.confirm('Reboot the TV now?')) {
    return;
  }
  await api.rebootDevice({ serial: state.serial });
  setMessage('Reboot requested');
}

async function installApk() {
  requireSerial();
  const result = await api.installApk({ serial: state.serial });
  if (result.canceled) {
    return;
  }
  setMessage(result.message || 'APK installation finished', result.failed?.length ? 'warn' : '');
  if (result.failed?.length) {
    setCommandStatus(`${result.failed.length} package(s) failed to install`);
  }
  await refreshApps();
}

async function installLauncherApk() {
  requireSerial();
  const result = await api.installLauncherApk({ serial: state.serial });
  if (result.canceled) {
    return;
  }
  setLauncherMessage(result.message || 'Launcher APK installed');
  state.launchers = result.launchers || [];
  renderLaunchers(state.launchers);
  await refreshApps().catch(() => null);
}

async function refreshLaunchers() {
  requireSerial();
  els.refreshLaunchersButton.disabled = true;
  try {
    const result = await api.listLaunchers({ serial: state.serial });
    state.launchers = result.launchers || [];
    renderLaunchers(state.launchers, result.current?.component);
    setLauncherMessage(result.current?.component ? `Current: ${result.current.component}` : 'Launcher list loaded');
  } finally {
    els.refreshLaunchersButton.disabled = false;
  }
}

function renderLaunchers(launchers, currentComponent = '') {
  els.launcherSelect.innerHTML = '';
  if (!launchers.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = state.serial ? 'No HOME launchers found' : 'Connect a device';
    els.launcherSelect.appendChild(option);
    return;
  }

  for (const launcher of launchers) {
    const option = document.createElement('option');
    option.value = launcher.component;
    option.textContent = `${launcher.name} - ${launcher.component}`;
    els.launcherSelect.appendChild(option);
  }

  if (currentComponent && launchers.some((launcher) => launcher.component === currentComponent)) {
    els.launcherSelect.value = currentComponent;
  }
}

async function setSelectedLauncher() {
  requireSerial();
  const component = els.launcherSelect.value;
  if (!component) {
    throw new Error('Select a launcher first.');
  }
  if (!window.confirm(`Set ${component} as the TV home launcher?`)) {
    return;
  }

  const result = await api.setHomeLauncher({ serial: state.serial, component });
  setLauncherMessage(result.message || (result.applied ? 'Launcher selected' : 'Launcher settings opened'));
}

function setLauncherMessage(text) {
  els.launcherMessage.textContent = text || '';
}

async function loadPackages() {
  requireSerial();
  els.loadPackagesButton.disabled = true;
  try {
    const packages = await api.listDebloatPackages({
      serial: state.serial,
      scope: els.packageScopeSelect.value
    });
    state.packages = packages;
    renderPackageList(packages);
  } finally {
    els.loadPackagesButton.disabled = false;
  }
}

function renderPackageList(packages) {
  els.packageList.innerHTML = '';
  const query = els.packageSearchInput.value.trim().toLowerCase();
  const visiblePackages = query
    ? packages.filter((item) =>
      item.packageName.toLowerCase().includes(query) ||
      String(item.name || '').toLowerCase().includes(query)
    )
    : packages;

  if (!visiblePackages.length) {
    const empty = document.createElement('div');
    empty.className = 'message';
    empty.textContent = state.serial ? 'No matching packages' : 'Connect a device';
    els.packageList.appendChild(empty);
    return;
  }

  for (const item of visiblePackages.slice(0, 100)) {
    const row = document.createElement('div');
    row.className = 'package-item';

    const name = document.createElement('div');
    name.className = 'package-name';
    name.textContent = item.packageName;
    name.title = item.name;

    const useButton = document.createElement('button');
    useButton.className = 'mini-button';
    useButton.type = 'button';
    useButton.textContent = 'Use';
    useButton.addEventListener('click', () => setPackageInput(item.packageName));

    row.append(name, useButton);
    els.packageList.appendChild(row);
  }
}

async function createDebloatBackup() {
  requireSerial();
  const backup = await api.createDebloatBackup({ serial: state.serial });
  setMessage(`Backup saved: ${backup.path}`);
}

async function restoreDebloatBackup() {
  requireSerial();
  if (!window.confirm('Restore disabled packages from a backup JSON?')) {
    return;
  }

  const result = await api.restoreDebloatBackup({ serial: state.serial });
  if (result.canceled) {
    return;
  }

  setMessage(`Restore attempted for ${result.attempted} packages`);
  await Promise.all([
    refreshApps().catch(() => null),
    loadPackages().catch(() => null)
  ]);
}

function setPackageInput(packageName) {
  els.packageInput.value = packageName;
  els.packageInput.focus();
}

async function packageAction(action) {
  requireSerial();
  const packageName = els.packageInput.value.trim();
  if (!isPackageName(packageName)) {
    throw new Error('Enter a valid package name.');
  }

  if (action === 'force-stop') {
    await api.forceStopApp({ serial: state.serial, packageName });
    setMessage(`Stopped ${packageName}`);
    return;
  }

  if (action === 'enable') {
    await api.enablePackage({ serial: state.serial, packageName });
    setMessage(`Enabled ${packageName}`);
    await loadPackages().catch(() => null);
    return;
  }

  const prompts = {
    disable: `Disable ${packageName} for this TV user?`,
    remove: `Remove ${packageName} for this TV user?`,
    clear: `Clear all app data for ${packageName}?`
  };

  if (!window.confirm(prompts[action])) {
    return;
  }

  if (action === 'disable') {
    const result = await api.disablePackage({ serial: state.serial, packageName });
    setMessage(`Disabled ${packageName}; backup saved: ${result.backup.path}`);
  } else if (action === 'remove') {
    const result = await api.removePackageForUser({ serial: state.serial, packageName });
    setMessage(`Removed ${packageName}; backup saved: ${result.backup.path}`);
  } else if (action === 'clear') {
    const result = await api.clearPackageData({ serial: state.serial, packageName });
    setMessage(`Cleared ${packageName}; backup saved: ${result.backup.path}`);
  }

  await Promise.all([
    refreshApps().catch(() => null),
    loadPackages().catch(() => null)
  ]);
}

async function sendTextBuffer() {
  if (!state.serial) {
    throw new Error('Connect a device first.');
  }

  if (els.sendTextButton.disabled) return;

  const text = els.textInput.value;
  if (!text) {
    return;
  }

  els.sendTextButton.disabled = true;
  const initiatingControl = document.activeElement;
  setCommandStatus(`Sending text (${text.length} chars)`);
  try {
    await api.sendText({ serial: state.serial, text });
    if (els.textInput.value === text) els.textInput.value = '';
    setCommandStatus(`OK text (${text.length} chars)`);
    if (document.activeElement === initiatingControl) {
      if (els.autoTypeToggle.checked) els.textInput.focus();
      else els.mirrorStage.focus();
    }
  } finally {
    els.sendTextButton.disabled = false;
  }
}

async function sendKey(keyCode) {
  if (!state.serial) {
    throw new Error('Connect a device first.');
  }
  if (state.keyInFlight) return;
  state.keyInFlight = true;
  const buttons = document.querySelectorAll('.media-button, .dpad-button, .remote-button');
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await runCommand(keyCode, () => api.inputKey({ serial: state.serial, keyCode }));
  } finally {
    state.keyInFlight = false;
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function handleGlobalKeyDown(event) {
  if (event.defaultPrevented || isInteractiveTarget(event.target)) return;
  if (event.altKey && ['1', '2', '3'].includes(event.key)) {
    event.preventDefault();
    setMode(event.key === '1' ? 'dpad' : event.key === '2' ? 'trackpad' : 'media');
    return;
  }

  if (!state.serial || state.mode !== 'dpad' || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }

  const keyCode = dpadMap.get(event.key);
  if (!keyCode) {
    return;
  }

  event.preventDefault();
  sendKey(keyCode).catch(showError);
}

function setMode(mode) {
  state.mode = mode;
  els.mirrorStage.classList.remove('mode-dpad', 'mode-trackpad', 'mode-media');
  els.mirrorStage.classList.add(`mode-${mode}`);
  syncMirrorInteractionClass();

  document.querySelectorAll('.mode-button').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });

  els.mirrorStage.focus();
}

function syncMirrorInteractionClass() {
  els.mirrorStage.classList.toggle(
    'mouse-move-enabled',
    state.mode === 'trackpad' && Boolean(els.mouseMoveToggle.checked)
  );
}

function handlePointerDown(event) {
  if (!state.serial || state.mode !== 'trackpad') {
    return;
  }

  pointerStart = {
    point: toDevicePoint(event.clientX, event.clientY),
    at: performance.now()
  };
  els.trackSurface.setPointerCapture(event.pointerId);
}

function handlePointerMove(event) {
  if (
    !state.serial ||
    state.mode !== 'trackpad' ||
    !els.mouseMoveToggle.checked ||
    mouseMoveInFlight ||
    event.buttons !== 0 ||
    mouseMoveUnsupported
  ) {
    return;
  }

  const now = performance.now();
  if (now - lastMouseMoveAt < MOUSE_MOVE_INTERVAL_MS) {
    return;
  }

  const point = toDevicePoint(event.clientX, event.clientY);
  if (!point) {
    return;
  }

  lastMouseMoveAt = now;
  mouseMoveInFlight = true;
  api.inputMouseMove({ serial: state.serial, x: point.x, y: point.y })
    .then((result) => {
      if (result?.supported === false) {
        mouseMoveUnsupported = true;
        els.mouseMoveToggle.checked = false;
        syncMirrorInteractionClass();
        setCommandStatus('Mouse move not supported on this TV build');
        if (result.message) {
          setMessage(result.message, 'warn');
        }
        return;
      }

      setCommandStatus(`mouse ${point.x},${point.y}`);
    })
    .catch((error) => {
      mouseMoveUnsupported = true;
      els.mouseMoveToggle.checked = false;
      syncMirrorInteractionClass();
      setCommandStatus(`Mouse move failed: ${error.message || error}`);
    })
    .finally(() => {
      mouseMoveInFlight = false;
    });
}

function handlePointerUp(event) {
  if (!state.serial || state.mode !== 'trackpad' || !pointerStart) {
    return;
  }

  const end = toDevicePoint(event.clientX, event.clientY);
  const start = pointerStart.point;
  const duration = Math.max(80, Math.round(performance.now() - pointerStart.at));
  pointerStart = null;

  if (!start || !end) {
    return;
  }

  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance < 18) {
    runCommand(`tap ${end.x},${end.y}`, () =>
      api.inputTap({ serial: state.serial, x: end.x, y: end.y })
    )
      .then(() => focusTextAfterTrackpadTap())
      .catch(showError);
    return;
  }

  runCommand(`swipe ${start.x},${start.y} -> ${end.x},${end.y}`, () => api.inputSwipe({
    serial: state.serial,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    durationMs: duration
  })).catch(showError);
}

function focusTextAfterTrackpadTap() {
  if (!els.autoTypeToggle.checked || ![els.mirrorStage, els.trackSurface, document.body].includes(document.activeElement)) {
    return;
  }

  els.textInput.focus();
  setCommandStatus('Tap sent; type here and press Enter');
}

function toDevicePoint(clientX, clientY) {
  const rect = els.mirrorStage.getBoundingClientRect();
  const display = state.display || { width: 1920, height: 1080 };
  const aspect = display.width / display.height;
  let visibleWidth = rect.width;
  let visibleHeight = visibleWidth / aspect;

  if (visibleHeight > rect.height) {
    visibleHeight = rect.height;
    visibleWidth = visibleHeight * aspect;
  }

  const offsetX = (rect.width - visibleWidth) / 2;
  const offsetY = (rect.height - visibleHeight) / 2;
  const localX = clientX - rect.left - offsetX;
  const localY = clientY - rect.top - offsetY;

  if (localX < 0 || localY < 0 || localX > visibleWidth || localY > visibleHeight) {
    return null;
  }

  return {
    x: Math.round((localX / visibleWidth) * display.width),
    y: Math.round((localY / visibleHeight) * display.height)
  };
}

function handleHeartbeat(status) {
  if (!state.serial || status.serial !== state.serial) {
    return;
  }

  if (status.state === 'connected' || status.state === 'reconnected') {
    setStatus('Online', 'ok');
    return;
  }

  if (status.state === 'reconnecting') {
    setStatus('Retry', 'warn');
    setMessage(`Reconnecting in ${Math.ceil(status.delayMs / 1000)}s`, 'warn');
  }
}

function setStatus(text, level) {
  els.statusPill.textContent = text;
  els.statusPill.className = `status-pill status-${level}`;
}

function setMessage(text, level = '') {
  els.connectionMessage.textContent = text || '';
  els.connectionMessage.className = `message ${level}`.trim();
}

function showError(error) {
  setStatus('Error', 'error');
  setMessage(error.message || String(error), 'error');
  setCommandStatus(`Error: ${error.message || String(error)}`);
}

async function runCommand(label, operation) {
  setCommandStatus(`Sending ${label}`);
  try {
    const result = await operation();
    setCommandStatus(`OK ${label}`);
    return result;
  } catch (error) {
    setCommandStatus(`Failed ${label}: ${error.message || error}`);
    throw error;
  }
}

function setCommandStatus(text) {
  if (els.commandStatusLabel) {
    els.commandStatusLabel.textContent = text || '';
  }
}

function setStreamStatus(text) {
  if (els.streamStatusPill) {
    els.streamStatusPill.textContent = text || 'Stream idle';
  }
}

function setScrcpyStatus(text, level = '') {
  if (!els.scrcpyStatusPill) return;
  els.scrcpyStatusPill.textContent = text || 'Interactive idle';
  els.scrcpyStatusPill.dataset.level = level;
}

function handleScrcpyEvent(event) {
  if (event.serial && state.serial && event.serial !== state.serial) return;
  if (event.type !== 'scrcpy-status') return;

  const labels = {
    starting: 'Starting control',
    live: 'TV window live',
    stopping: 'Stopping control',
    stopped: 'Interactive control stopped',
    error: 'Control error'
  };
  setScrcpyStatus(labels[event.state] || event.message || event.state, event.state);
  state.scrcpyRunning = ['starting', 'live'].includes(event.state);

  if (event.state === 'live') {
    setMirrorHint('Control the TV in its own window', 'Click the TV window to control it. Move the pointer out or use Alt+Tab to return. For remote-only menus such as Free My TV, use arrows and Enter.');
    setStatus('Live', 'ok');
    setCommandStatus('Mouse and keyboard control is active in the TV window');
  } else if (event.state === 'error') {
    setMessage(event.message || 'Interactive control failed.', 'warn');
    setCommandStatus(`Control error: ${event.message || 'unknown error'}`);
    setMirrorHint('TV control could not start', event.message || 'Try Start control again, or choose a compatibility mirror below.');
  } else if (event.state === 'stopped' && state.serial) {
    state.scrcpyRunning = false;
    if (state.mirrorMode === 'off') {
      setMirrorHint('TV control is stopped', 'Choose Start control to open the TV window, or select a compatibility mirror below.');
    }
  }
}

function handleStreamEvent(event) {
  if (event.serial && state.serial && event.serial !== state.serial) {
    return;
  }

  if (event.type === 'stream-status') {
    if (state.mirrorMode === 'snapshot' && event.state !== 'snapshot-fallback') {
      return;
    }

    const labels = {
      idle: 'Stream idle',
      starting: 'Stream starting',
      live: 'Stream live',
      'snapshot-fallback': 'Snapshot fallback',
      error: 'Stream error'
    };
    setStreamStatus(labels[event.state] || event.state || event.type);
    if (event.reason && event.state === 'error') {
      setMessage(event.reason, 'warn');
      if (state.mirrorMode === 'h264') {
        handleStreamFailure().catch(showError);
      }
    }
  } else if (event.type === 'stream-started') {
    if (state.mirrorMode !== 'h264') {
      return;
    }

    setStreamStatus('Stream starting');
  }
}

function requireSerial() {
  if (!state.serial) {
    throw new Error('Connect a device first.');
  }
}

function isPackageName(value) {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(value);
}

function isInteractiveTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, button, summary, a[href], [contenteditable]:not([contenteditable="false"])'));
}

function formatAdbDeviceLabel(device) {
  const name = device.model || device.product || device.serial;
  return `${name} - ${device.state}`;
}

function formatDiscoveredDeviceLabel(device) {
  const parts = [device.name || 'Android TV'];
  const adb = device.services?.adbConnect;
  const pairing = device.services?.adbPairing;
  if (device.address) {
    parts.push(device.address);
  }
  if (adb?.port) {
    parts.push(`ADB ${adb.port}`);
  } else if (pairing?.port) {
    parts.push(`Pair ${pairing.port}`);
  }
  return parts.join(' - ');
}

function hostFromSerial(serial) {
  return String(serial || '').includes(':') ? serial.split(':')[0] : '';
}

function portFromSerial(serial) {
  const match = String(serial || '').match(/:(\d+)$/);
  return match ? Number(match[1]) : 5555;
}

function deviceLabel(info) {
  const model = [info.brand, info.model].filter(Boolean).join(' ');
  const android = info.androidRelease ? `Android ${info.androidRelease}` : '';
  const size = info.display ? `${info.display.width}x${info.display.height}` : '';
  return [model, android, size].filter(Boolean).join(' - ');
}
