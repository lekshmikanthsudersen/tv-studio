const fs = require('node:fs');
const path = require('node:path');
const { isIPv4 } = require('node:net');
const networkWake = require('./networkWake');

const MAX_PROFILES = 32;
const MAX_FILE_BYTES = 64 * 1024;
const TIMINGS = { adbMs: 3000, powerMs: 1500, packetMs: 1500, verifyDelayMs: 300, pollMs: 1000, totalMs: 20000 };
const SAFE_INTERFACE = /^(?:wlan|eth)\d{1,2}$/;

function invalid(message, code = 'INVALID_WAKE_PROFILE') {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unwrapProfilePayload(payload) {
  if (!isRecord(payload)) throw invalid('Choose a saved TV or enter its network address.');
  // ADB's device metadata contains a string named "device" (for example BRAVIA_VU3).
  // Only actual record wrappers may replace the selected device payload.
  if (isRecord(payload.device)) return payload.device;
  if (isRecord(payload.profile)) return payload.profile;
  return payload;
}

function normalizeHost(value) {
  const host = String(value || '').trim().toLowerCase();
  const validName = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
    && host.split('.').every((part) => part.length > 0 && part.length <= 63 && !part.startsWith('-') && !part.endsWith('-'));
  if (!isIPv4(host) && (!validName || /^[\d.]+$/.test(host))) {
    throw invalid('Enter the TV’s IPv4 address or network hostname.');
  }
  if (isIPv4(host) && (Number(host.split('.')[0]) === 0 || Number(host.split('.')[0]) >= 224 || host === '255.255.255.255')) {
    throw invalid('Enter the TV’s address, not a broadcast or multicast address.');
  }
  return host;
}

function normalizeProfile(input, existing) {
  if (!isRecord(input)) throw invalid('Choose a saved TV or enter its network address.');
  const serialMatch = typeof input.serial === 'string' && input.serial.match(/^([^:\s]+):(\d+)$/);
  const host = normalizeHost(input.host || input.address || serialMatch?.[1] || existing?.host);
  const port = Number(input.port ?? serialMatch?.[2] ?? existing?.port ?? 5555);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('Enter an ADB port from 1 to 65535.');
  const serial = `${host}:${port}`;
  // A UI selection must never resolve one TV’s host to another TV’s ADB transport.
  if (input.serial && input.serial !== serial) throw invalid('The selected TV’s address and ADB connection do not match.');
  const sameAddress = existing?.host === host && existing?.port === port;
  const rawMac = Object.hasOwn(input, 'macAddress') ? input.macAddress : sameAddress ? existing.macAddress : '';
  const macAddress = rawMac ? networkWake.normalizeMacAddress(rawMac) : '';
  const name = String(input.name || input.model || (sameAddress && existing.name) || host).trim().slice(0, 120);
  return { id: `wake:${serial}`, name: name || host, host, port, serial, macAddress };
}

function activeInterface(addressOutput, host) {
  const interfaces = [];
  for (const line of String(addressOutput || '').split(/\r?\n/)) {
    const match = line.match(/^\d+:\s+([^\s:@]+)(?:@[^\s]+)?\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/\d+\b/);
    if (match && SAFE_INTERFACE.test(match[1]) && isIPv4(match[2])) interfaces.push({ name: match[1], address: match[2] });
  }
  return interfaces.find((item) => item.address === host)?.name
    || (!isIPv4(host) && interfaces.length === 1 ? interfaces[0].name : '');
}

function macFromLinks(output, interfaceName) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\d+:\s+([^\s:@]+)(?:@[^\s]+)?:\s+.*?\blink\/ether\s+([\da-f:]+)/i);
    if (match?.[1] === interfaceName) {
      try { return networkWake.normalizeMacAddress(match[2]); } catch { return ''; }
    }
  }
  return '';
}

function macFromWifiStatus(output, host) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const ip = line.match(/(?:^|,\s*)IP:\s*\/?(\d+\.\d+\.\d+\.\d+)(?:,|\s|$)/);
    const mac = line.match(/(?:^|,\s*)MAC:\s*([\da-f:]+)(?:,|\s|$)/i);
    if (ip?.[1] === host && mac) {
      try { return networkWake.normalizeMacAddress(mac[1]); } catch { return ''; }
    }
  }
  return '';
}

function checkedResult(result) {
  if (!result || (result.exitCode !== undefined && result.exitCode !== 0)) throw invalid('The TV did not accept the command.', 'WAKE_ADB_FAILED');
  return result;
}

class WakeController {
  constructor({ adb, filePath, logger = console, sendWakePackets = networkWake.sendWakePackets, now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timings = {} } = {}) {
    if (!adb || !filePath) throw new Error('WakeController requires adb and a profile file path.');
    this.adb = adb;
    this.filePath = filePath;
    this.logger = logger;
    this.sendWakePackets = sendWakePackets;
    this.now = now;
    this.sleep = sleep;
    this.timings = { ...TIMINGS, ...timings };
    this.profiles = new Map();
    this.pending = new Map();
    this.stopped = false;
    this.loadProfiles();
  }

  loadProfiles() {
    let descriptor;
    try {
      descriptor = fs.openSync(this.filePath, 'r');
      const stats = fs.fstatSync(descriptor);
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) throw new Error('Saved TV profiles exceed the size limit.');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      if (bytes > MAX_FILE_BYTES) throw new Error('Saved TV profiles exceed the size limit.');
      const data = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
      if (data.version !== 1 || !Array.isArray(data.profiles)) throw new Error('Saved TV profile format is invalid.');
      for (const item of data.profiles.slice(0, MAX_PROFILES)) {
        try {
          const profile = normalizeProfile(item);
          this.profiles.set(profile.id, profile);
        } catch { /* Ignore invalid entries without preventing the other TVs from loading. */ }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn?.('Could not load saved TV wake profiles:', error.message);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  getProfiles() { return [...this.profiles.values()].map((profile) => ({ ...profile })); }

  resolveProfile(payload = {}) {
    if (typeof payload === 'string') payload = { profileId: payload };
    const input = unwrapProfilePayload(payload);
    const profileId = payload.profileId || input.profileId || input.id;
    const existing = this.profiles.get(profileId);
    if (existing && !input.host && !input.address && !input.serial) return { ...existing };
    const profile = normalizeProfile(input, existing);
    return normalizeProfile(input, this.profiles.get(profile.id) || existing);
  }

  saveProfile(payload) {
    const input = unwrapProfilePayload(payload);
    const existing = this.profiles.get(payload?.profileId || input?.profileId || input?.id);
    const candidate = normalizeProfile(input, existing);
    const profile = normalizeProfile(input, this.profiles.get(candidate.id) || existing);
    const next = new Map(this.profiles);
    next.delete(profile.id);
    next.set(profile.id, profile);
    while (next.size > MAX_PROFILES) next.delete(next.keys().next().value);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, profiles: [...next.values()] }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch { /* The atomic write may not have created a temporary file. */ }
      throw error;
    }
    this.profiles = next;
    return { ...profile };
  }

  async rememberDevice(device, info = {}) {
    let profile;
    try { profile = this.resolveProfile({ ...device, name: info.model || device.name || device.model }); }
    catch { return null; } // USB devices cannot be woken over the network.
    try {
      const [links, addresses] = await Promise.allSettled([
        this.adb.shell(profile.serial, ['ip', '-o', 'link', 'show'], { timeoutMs: this.timings.adbMs, maxBuffer: MAX_FILE_BYTES }),
        this.adb.shell(profile.serial, ['ip', '-o', '-4', 'addr', 'show'], { timeoutMs: this.timings.adbMs, maxBuffer: MAX_FILE_BYTES })
      ]);
      const interfaceName = addresses.status === 'fulfilled' && activeInterface(addresses.value.stdout, profile.host);
      if (interfaceName) {
        let macAddress = links.status === 'fulfilled' ? macFromLinks(links.value.stdout, interfaceName) : '';
        if (!macAddress) {
          try {
            const result = await this.adb.shell(profile.serial, ['cat', `/sys/class/net/${interfaceName}/address`], {
              timeoutMs: this.timings.adbMs, maxBuffer: 1024
            });
            macAddress = networkWake.normalizeMacAddress(result.stdout.trim());
          } catch { /* Some Android versions hide sysfs even from the authorized ADB shell. */ }
        }
        if (!macAddress && interfaceName.startsWith('wlan')) {
          const result = await this.adb.shell(profile.serial, ['cmd', 'wifi', 'status'], {
            timeoutMs: this.timings.adbMs, maxBuffer: MAX_FILE_BYTES
          });
          // Keep only this interface's MAC; never save or log SSIDs, BSSIDs or the raw output.
          macAddress = macFromWifiStatus(result.stdout, profile.host);
        }
        if (macAddress) profile.macAddress = macAddress;
      }
    } catch { /* Retain a manually configured MAC when Android hides its network details. */ }
    try { return this.saveProfile(profile); }
    catch (error) {
      this.logger.warn?.('Could not save the connected TV for waking:', error.message);
      return profile;
    }
  }

  wake(payload) {
    let profile;
    try { this.assertActive(); profile = this.resolveProfile(payload); }
    catch (error) { return Promise.reject(error); }
    if (this.pending.has(profile.id)) return this.pending.get(profile.id);
    const promise = this.performWake(profile).finally(() => this.pending.delete(profile.id));
    this.pending.set(profile.id, promise);
    return promise;
  }

  stop() { this.stopped = true; }

  assertActive() {
    if (this.stopped) throw invalid('The wake request was cancelled because TV Studio is closing.', 'WAKE_CANCELLED');
  }

  async wakeThroughAdb(profile, deadline) {
    const budget = (maximum) => Math.max(1, Math.min(maximum, deadline - this.now()));
    this.assertActive();
    checkedResult(await this.adb.shell(profile.serial, ['input', 'keyevent', 'KEYCODE_WAKEUP'], { timeoutMs: budget(this.timings.adbMs) }));
    this.assertActive();
    let awakeConfirmed = false;
    for (let attempt = 0; attempt < 2 && this.now() < deadline; attempt += 1) {
      try {
        this.assertActive();
        const result = checkedResult(await this.adb.shell(profile.serial, ['dumpsys', 'power'], {
          timeoutMs: budget(this.timings.powerMs), maxBuffer: 256 * 1024
        }));
        awakeConfirmed = /^\s*mWakefulness=Awake\s*$/m.test(result.stdout);
      } catch (error) { this.assertActive(); break; }
      if (awakeConfirmed || attempt === 1) break;
      await this.sleep(Math.min(this.timings.verifyDelayMs, Math.max(0, deadline - this.now())));
    }
    this.assertActive();
    return { connected: true, requestSent: true, awakeConfirmed };
  }

  async performWake(profile) {
    const started = this.now();
    const deadline = started + this.timings.totalMs;
    let requestSent = false;
    let network;
    let lastError = '';
    const result = (details) => ({ profile: { ...profile }, serial: profile.serial, elapsedMs: this.now() - started, ...details });
    const connectedResult = (state, method) => result({
      ...state, method, network, status: state.awakeConfirmed ? 'awake' : 'connected',
      message: state.awakeConfirmed ? `${profile.name} is awake and connected.`
        : `${profile.name} accepted the wake command. Its display state could not be confirmed.`
    });
    try { return connectedResult(await this.wakeThroughAdb(profile, deadline), 'adb'); }
    catch (error) { lastError = error.message; }
    this.assertActive();

    if (profile.macAddress && this.now() < deadline) {
      try {
        network = await this.sendWakePackets({
          macAddress: profile.macAddress, host: isIPv4(profile.host) ? profile.host : undefined,
          timeoutMs: Math.min(this.timings.packetMs, deadline - this.now())
        });
        requestSent = Number(network.sent) > 0;
      } catch (error) { lastError = error.message; }
    }

    while (this.now() < deadline) {
      this.assertActive();
      try {
        const connection = await this.adb.connect(profile.host, profile.port, {
          timeoutMs: Math.min(this.timings.adbMs, deadline - this.now())
        });
        this.assertActive();
        if (connection.connected && this.now() < deadline) {
          return connectedResult(await this.wakeThroughAdb(profile, deadline), requestSent ? 'network' : 'reconnect');
        }
      } catch (error) { lastError = error.message; }
      this.assertActive();
      if (this.now() < deadline) await this.sleep(Math.min(this.timings.pollMs, deadline - this.now()));
    }

    this.assertActive();

    return result({
      method: requestSent ? 'network' : 'reconnect', network, requestSent, connected: false, awakeConfirmed: false,
      status: requestSent ? 'sent' : profile.macAddress ? 'unreachable' : 'setup-required',
      message: requestSent
        ? 'Wake packets sent. The TV has not connected yet. Check Remote start/network standby on the TV and that both devices are on the same network.'
        : !profile.macAddress
          ? 'The TV is offline and no network MAC address is saved. Turn it on once to capture its address, or enter the TV’s MAC address in wake settings.'
          : 'The TV could not be reached. Check that it has power, is on the same network, and has Remote start/network standby enabled.',
      error: lastError
    });
  }
}

module.exports = WakeController;
module.exports.normalizeProfile = normalizeProfile;
module.exports.activeInterface = activeInterface;
module.exports.macFromLinks = macFromLinks;
module.exports.macFromWifiStatus = macFromWifiStatus;
