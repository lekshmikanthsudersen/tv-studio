const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const WakeController = require('../src/main/modules/wakeController');
const AdbWrapper = require('../src/main/modules/adbWrapper');
const { activeInterface, macFromLinks, macFromWifiStatus } = WakeController;

const TV = { host: '192.0.2.10', port: 5555, name: 'Sony TV', macAddress: '02:11:22:33:44:55' };
const AWAKE = { stdout: '  mWakefulness=Awake\n  mWakefulnessChanging=false', exitCode: 0 };

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-studio-wake-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = { time: 0, shells: [], connects: [], packets: [], warnings: [], filePath: path.join(directory, 'tv-wake.json') };
  const adb = {
    shell: async (...args) => { state.shells.push(args); return args[1][0] === 'dumpsys' ? AWAKE : { stdout: '', exitCode: 0 }; },
    connect: async (...args) => { state.connects.push(args); return { connected: true }; },
    ...overrides.adb
  };
  state.options = {
    adb, filePath: state.filePath, now: () => state.time, sleep: async (ms) => { state.time += ms; },
    logger: { warn: (...args) => state.warnings.push(args) },
    sendWakePackets: async (payload) => { state.packets.push(payload); return { sent: 3, attempted: 3, failed: 0 }; },
    ...overrides, adb
  };
  state.controller = new WakeController(state.options);
  return state;
}

test('saved network TV survives restart and returned profiles cannot mutate the store', (t) => {
  const state = fixture(t);
  const profile = state.controller.saveProfile(TV);
  assert.equal(profile.serial, '192.0.2.10:5555');
  assert.equal(profile.id, 'wake:192.0.2.10:5555');
  const copy = state.controller.getProfiles();
  copy[0].host = '192.0.2.99';
  assert.equal(state.controller.getProfiles()[0].host, TV.host);
  assert.deepEqual(new WakeController(state.options).getProfiles(), [profile]);
  assert.equal(fs.readdirSync(path.dirname(state.filePath)).length, 1, 'atomic write must not leave temporary files');
});

test('manual MAC update supports saved profile ID and explicitly clearing the MAC', (t) => {
  const { controller } = fixture(t);
  const first = controller.saveProfile({ host: TV.host });
  const updated = controller.saveProfile({ profileId: first.id, macAddress: TV.macAddress });
  assert.equal(updated.macAddress, TV.macAddress);
  assert.equal(controller.saveProfile({ profileId: first.id, macAddress: '' }).macAddress, '');
});

test('raw adb devices metadata supports saving, remembering and waking the selected Sony TV', async (t) => {
  const parser = new AdbWrapper();
  parser.run = async () => ({ stdout: 'List of devices attached\n192.0.2.10:5555 device product:BRAVIA_VU3 model:BRAVIA_VU3 device:BRAVIA_VU3 transport_id:1\n' });
  const [device] = await parser.listDevices();
  assert.equal(device.device, 'BRAVIA_VU3');
  const state = fixture(t);
  const saved = state.controller.saveProfile({ ...device, macAddress: TV.macAddress });
  assert.equal(saved.serial, device.serial);
  assert.equal(saved.name, 'BRAVIA_VU3');
  const remembered = await state.controller.rememberDevice(device);
  assert.equal(remembered.serial, device.serial);
  assert.equal(remembered.macAddress, TV.macAddress);
  const result = await state.controller.wake(device);
  assert.equal(result.status, 'awake');
  assert.equal(result.serial, device.serial);
  assert.ok(state.shells.every(([serial]) => serial === device.serial));
});

test('only record-valued wrappers replace profile payloads', async (t) => {
  const { controller } = fixture(t);
  for (const metadata of ['BRAVIA_VU3', [], new Date(), null, 42]) {
    const saved = controller.saveProfile({ ...TV, device: metadata, profile: metadata });
    assert.equal(saved.host, TV.host);
    assert.equal((await controller.wake({ ...TV, device: metadata, profile: metadata })).status, 'awake');
  }
  assert.equal(controller.saveProfile({ device: { ...TV } }).host, TV.host);
  assert.equal(controller.saveProfile({ profile: Object.assign(Object.create(null), TV) }).host, TV.host);
  assert.equal((await controller.wake({ device: { ...TV } })).status, 'awake');
  assert.equal((await controller.wake({ profile: { ...TV } })).status, 'awake');
  for (const invalid of [null, [], new Date(), { device: 'BRAVIA_VU3' }, { profile: [] }]) {
    assert.throws(() => controller.saveProfile(invalid), { code: 'INVALID_WAKE_PROFILE' });
    await assert.rejects(controller.wake(invalid), { code: 'INVALID_WAKE_PROFILE' });
  }
});

test('rejects malformed hosts, ports, USB fallbacks, multicast/placeholder MACs and mismatched transports', (t) => {
  const { controller } = fixture(t);
  for (const input of [
    { host: '192.0.2.10;echo' }, { host: '-target' }, { host: '999.1.2.3' },
    { host: '192.0.2.1', port: 0 }, { host: '239.1.1.1' }, { serial: 'usb-serial' },
    { ...TV, serial: '192.0.2.99:5555' }, { ...TV, macAddress: '01:22:33:44:55:66' },
    { ...TV, macAddress: '00:00:00:00:00:00' }, { ...TV, macAddress: '02:00:00:00:00:00' }
  ]) assert.throws(() => controller.saveProfile(input));
  assert.deepEqual(controller.getProfiles(), []);
});

test('changing TV address does not inherit a different TV’s MAC', (t) => {
  const { controller } = fixture(t);
  const old = controller.saveProfile(TV);
  const other = controller.saveProfile({ profileId: old.id, host: '192.0.2.99' });
  assert.equal(other.macAddress, '');
  assert.equal(other.serial, '192.0.2.99:5555');
});

test('corrupt or oversized persistence is ignored safely', (t) => {
  const state = fixture(t);
  fs.writeFileSync(state.filePath, '{not-json');
  assert.deepEqual(new WakeController(state.options).getProfiles(), []);
  fs.writeFileSync(state.filePath, Buffer.alloc(65537));
  assert.deepEqual(new WakeController(state.options).getProfiles(), []);
  assert.equal(state.warnings.length, 2);
});

test('invalid entries do not prevent valid profiles loading; profile count is bounded', (t) => {
  const state = fixture(t);
  fs.writeFileSync(state.filePath, JSON.stringify({ version: 1, profiles: [{ host: 'bad;host' }, TV] }));
  const controller = new WakeController(state.options);
  assert.equal(controller.getProfiles().length, 1);
  for (let i = 1; i <= 40; i += 1) controller.saveProfile({ host: `198.51.100.${i}` });
  assert.equal(controller.getProfiles().length, 32);
});

test('discovers the MAC only for the interface that owns the selected TV IP', (t) => {
  const state = fixture(t, { adb: { shell: async (_serial, command) => ({ stdout: command.includes('link')
    ? '2: eth0: <UP> mtu 1500 link/ether 02:AA:BB:CC:DD:EE brd ff:ff:ff:ff:ff:ff\n3: wlan0: <UP> mtu 1500 link/ether 02:11:22:33:44:55 brd ff:ff:ff:ff:ff:ff'
    : '2: eth0    inet 192.0.2.44/24 brd 192.0.2.255 scope global eth0\n3: wlan0    inet 192.0.2.10/24 brd 192.0.2.255 scope global wlan0' }) } });
  return state.controller.rememberDevice({ serial: '192.0.2.10:5555', model: 'BRAVIA' }).then((profile) => {
    assert.equal(profile.macAddress, TV.macAddress);
    assert.equal(profile.name, 'BRAVIA');
  });
});

test('safe sysfs fallback uses only the active Ethernet/Wi-Fi interface', async (t) => {
  const commands = [];
  const state = fixture(t, { adb: { shell: async (_serial, command) => {
    commands.push(command);
    if (command.includes('link')) throw new Error('Permission denied');
    return { stdout: command[0] === 'cat' ? TV.macAddress : '3: wlan0    inet 192.0.2.10/24 scope global wlan0' };
  } } });
  assert.equal((await state.controller.rememberDevice({ serial: '192.0.2.10:5555' })).macAddress, TV.macAddress);
  assert.deepEqual(commands[2], ['cat', '/sys/class/net/wlan0/address']);
  assert.equal(activeInterface('3: ../../data    inet 192.0.2.10/24 scope global', TV.host), '');
});

test('Sony wifi-status fallback saves only TV MAC and never the router BSSID or SSID', async (t) => {
  const commands = [];
  const state = fixture(t, { adb: { shell: async (_serial, command) => {
    commands.push(command);
    if (command.includes('link') || command[0] === 'cat') throw new Error('Permission denied');
    if (command[0] === 'cmd') return { stdout: 'WifiInfo: SSID: Private Network Name, BSSID: 02:AA:BB:CC:DD:EE, MAC: 02:11:22:33:44:55, IP: /192.0.2.10, Security type: 2' };
    return { stdout: '3: wlan0    inet 192.0.2.10/24 scope global wlan0' };
  } } });
  assert.equal((await state.controller.rememberDevice({ serial: '192.0.2.10:5555' })).macAddress, TV.macAddress);
  assert.deepEqual(commands[3], ['cmd', 'wifi', 'status']);
  const saved = fs.readFileSync(state.filePath, 'utf8');
  assert.doesNotMatch(saved, /Private Network|BSSID|02:AA:BB:CC:DD:EE/);
  assert.equal(macFromWifiStatus('WifiInfo: BSSID: 02:AA:BB:CC:DD:EE, IP: /192.0.2.10', TV.host), '');
  assert.equal(macFromWifiStatus(`WifiInfo: SSID: x, MAC: ${TV.macAddress}, IP: /192.0.2.99`, TV.host), '');
});

test('hidden Android MAC preserves a manual address and USB remember does not persist', async (t) => {
  const state = fixture(t, { adb: { shell: async () => { throw new Error('Permission denied'); } } });
  state.controller.saveProfile(TV);
  assert.equal((await state.controller.rememberDevice({ serial: '192.0.2.10:5555' })).macAddress, TV.macAddress);
  assert.equal(await state.controller.rememberDevice({ serial: 'usb-device' }), null);
  assert.equal(state.controller.getProfiles().length, 1);
});

test('connected wake is idempotent, verifies Awake, and never sends a power toggle or WOL', async (t) => {
  const state = fixture(t);
  const profile = state.controller.saveProfile(TV);
  const result = await state.controller.wake({ profileId: profile.id });
  assert.equal(result.status, 'awake');
  assert.equal(result.awakeConfirmed, true);
  assert.equal(result.connected, true);
  assert.equal(result.method, 'adb');
  assert.equal(state.packets.length, 0);
  assert.equal(state.connects.length, 0);
  assert.deepEqual(state.shells[0][1], ['input', 'keyevent', 'KEYCODE_WAKEUP']);
  assert.equal(state.shells[0][2].timeoutMs, 3000);
  assert.ok(state.shells.every(([serial]) => serial === '192.0.2.10:5555'));
});

test('ADB acceptance alone never claims that the display is awake', async (t) => {
  const state = fixture(t, { adb: { shell: async () => ({ stdout: 'mWakefulness=Asleep\nDisplay Power: state=ON', exitCode: 0 }) } });
  const result = await state.controller.wake(TV);
  assert.equal(result.status, 'connected');
  assert.equal(result.awakeConfirmed, false);
  assert.equal(result.requestSent, true);
  assert.equal(state.packets.length, 0);
});

test('offline TV gets wake packets, bounded reconnect, then verified wake on the exact saved TV', async (t) => {
  const calls = [];
  let available = false;
  const state = fixture(t, { adb: {
    shell: async (serial, command, options) => {
      calls.push({ serial, command, options });
      if (!available) throw new Error('device offline');
      return command[0] === 'dumpsys' ? AWAKE : { stdout: '' };
    },
    connect: async (host, port, options) => { calls.push({ host, port, options }); available = true; return { connected: true }; }
  } });
  const profile = state.controller.saveProfile(TV);
  const result = await new WakeController(state.options).wake({ profileId: profile.id });
  assert.equal(result.method, 'network');
  assert.equal(result.awakeConfirmed, true);
  assert.equal(state.packets.length, 1);
  assert.deepEqual(state.packets[0], { macAddress: TV.macAddress, host: TV.host, timeoutMs: 1500 });
  assert.deepEqual(calls[1], { host: TV.host, port: 5555, options: { timeoutMs: 3000 } });
  assert.ok(calls.filter((item) => item.serial).every((item) => item.serial === '192.0.2.10:5555'));
});

test('unreachable TV stops at deadline and reports packets sent, never awake', async (t) => {
  const state = fixture(t, { adb: {
    shell: async () => { throw new Error('offline'); },
    connect: async () => { throw new Error('refused'); }
  } });
  const result = await state.controller.wake(TV);
  assert.equal(state.time, 20000);
  assert.equal(result.status, 'sent');
  assert.equal(result.awakeConfirmed, false);
  assert.equal(result.connected, false);
  assert.equal(result.requestSent, true);
});

test('no saved MAC can still reconnect, but an offline TV receives actionable setup guidance', async (t) => {
  const state = fixture(t, { adb: {
    shell: async () => { throw new Error('offline'); }, connect: async () => ({ connected: false })
  } });
  const result = await state.controller.wake({ host: TV.host });
  assert.equal(result.status, 'setup-required');
  assert.equal(result.requestSent, false);
  assert.equal(state.packets.length, 0);
});

test('hostname ADB profiles remain usable without passing a hostname to IPv4 wake transport', async (t) => {
  const state = fixture(t, { adb: { shell: async () => { throw new Error('offline'); }, connect: async () => ({ connected: false }) } });
  await state.controller.wake({ ...TV, host: 'sony-tv.local' });
  assert.equal(state.packets[0].host, undefined);
});

test('concurrent wake calls for the same TV coalesce', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const state = fixture(t, { adb: { shell: async () => { count += 1; await gate; return AWAKE; } } });
  const first = state.controller.wake(TV);
  const second = state.controller.wake(TV);
  assert.equal(first, second);
  release();
  await first;
  assert.equal(count, 2);
  assert.equal(state.controller.pending.size, 0);
});

test('closing the app prevents further retries and new wake requests', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let connects = 0;
  const state = fixture(t, { adb: {
    shell: async () => { await gate; throw new Error('offline'); },
    connect: async () => { connects += 1; return { connected: true }; }
  } });
  const request = state.controller.wake(TV);
  state.controller.stop();
  release();
  await assert.rejects(request, { code: 'WAKE_CANCELLED' });
  await assert.rejects(state.controller.wake(TV), { code: 'WAKE_CANCELLED' });
  assert.equal(connects, 0);
  assert.equal(state.packets.length, 0);
});

test('network send failure is not misreported as successful wake', async (t) => {
  const state = fixture(t, {
    adb: { shell: async () => { throw new Error('offline'); }, connect: async () => ({ connected: false }) },
    sendWakePackets: async () => { throw new Error('Network unavailable'); }
  });
  const result = await state.controller.wake(TV);
  assert.equal(result.status, 'unreachable');
  assert.equal(result.requestSent, false);
  assert.equal(result.awakeConfirmed, false);
});

test('link parsing excludes inactive interfaces and multicast MACs', () => {
  assert.equal(macFromLinks('2: eth0: <UP> link/ether 01:22:33:44:55:66 brd ff:ff:ff:ff:ff:ff', 'eth0'), '');
  assert.equal(macFromLinks('2: eth0: <UP> link/ether 02:AA:BB:CC:DD:EE brd ff:ff:ff:ff:ff:ff', 'wlan0'), '');
});
