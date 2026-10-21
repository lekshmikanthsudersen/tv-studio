const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sony = { id: 'wake:192.0.2.10:5555', host: '192.0.2.10', port: 5555,
  serial: '192.0.2.10:5555', name: 'Sony TV', macAddress: '02:11:22:33:44:55' };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(profiles = [sony], { realSelection = false } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const node = { id, value: '', textContent: '', disabled: false, children: [], style: {}, dataset: {},
        classList: { add() {}, remove() {} },
        removeAttribute(name) { delete this[name]; }, load() {},
        appendChild(child) { this.children.push(child); if (!this.value) this.value = child.value; } };
      Object.defineProperty(node, 'innerHTML', { set() { this.children = []; this.value = ''; } });
      elements.set(id, node);
    }
    return elements.get(id);
  }
  const api = { getWakeProfiles: async () => profiles };
  const context = vm.createContext({ window: { androidTv: api, setTimeout, clearTimeout },
    document: { getElementById: element, createElement: () => ({ value: '', textContent: '' }) }, console });
  const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/uiController.js'), 'utf8')
    .replace(/^init\(\)\.catch\(\(error\) => showError\(error\)\);$/m, '');
  vm.runInContext(source, context);
  const run = (code) => vm.runInContext(code, context);
  if (realSelection) run('refreshApps = async () => {}; refreshLaunchers = async () => {};');
  else run('globalThis.selections = []; selectDevice = async (device, options) => { state.connectionGeneration++; state.serial = device.serial; selections.push({device, options}); };');
  return { api, run, element, context };
}

test('saved offline TV is selectable after startup without an active connection', async () => {
  const h = harness();
  await h.run('loadWakeProfiles()');
  assert.equal(h.element('deviceSelect').value, sony.id);
  assert.equal(h.element('wakeButton').disabled, false);
  assert.equal(h.element('wakeMacInput').value, sony.macAddress);
  assert.equal(h.run('state.serial'), '');
});

test('waking survives saved TV being rediscovered under a new option ID', async () => {
  const h = harness();
  await h.run('loadWakeProfiles()');
  const gate = deferred();
  let count = 0;
  h.api.wakeDevice = () => { count++; return gate.promise; };
  const waking = h.run('wakeSelectedTv()');
  await h.run('wakeSelectedTv()');
  assert.equal(count, 1);
  assert.equal(h.element('wakeButton').disabled, true);
  h.run("state.discoveredDevices = [{id:'mdns:sony',name:'Sony',address:'192.0.2.10',services:{adbConnect:{port:5555}}}]; renderDeviceOptions();");
  assert.equal(h.element('deviceSelect').value, 'mdns:sony');
  gate.resolve({ connected: true, awakeConfirmed: true, profile: sony, message: 'Sony TV is awake and connected.' });
  await waking;
  assert.equal(h.run('selections.length'), 1);
  assert.equal(h.run('selections[0].options.startControl'), false);
  assert.equal(h.run('state.serial'), sony.serial);
  assert.match(h.element('wakeMessage').textContent, /awake and connected/);
  assert.equal(h.element('wakeButton').disabled, false);
});

test('wake targets the selected TV instead of a previously connected one', async () => {
  const h = harness();
  await h.run('loadWakeProfiles()');
  h.run("state.serial='192.0.2.99:5555'; state.selectedDevice={serial:state.serial,host:'192.0.2.99'};");
  let sent;
  h.api.wakeDevice = async (target) => { sent = target; return { connected: false, awakeConfirmed: false, message: 'Wake packets sent; no response yet.' }; };
  await h.run('wakeSelectedTv()');
  assert.equal(sent.serial, sony.serial);
  assert.equal(h.run('selections.length'), 0);
  assert.match(h.element('wakeMessage').textContent, /no response/);
  assert.match(h.element('wakeMessage').className, /warn/);
});

test('late wake response does not switch back after the user changes TV', async () => {
  const h = harness();
  await h.run('loadWakeProfiles()');
  const gate = deferred();
  h.api.wakeDevice = () => gate.promise;
  const waking = h.run('wakeSelectedTv()');
  h.run("state.connectionGeneration++; state.selectedOption={device:{serial:'192.0.2.11:5555',host:'192.0.2.11'}};");
  gate.resolve({ connected: true, awakeConfirmed: true, profile: sony, message: 'awake' });
  await waking;
  assert.equal(h.run('selections.length'), 0);
  assert.equal(h.run('state.wakeInFlight'), false);
});

test('changed wireless debugging port takes precedence over saved port', async () => {
  const h = harness();
  await h.run('loadWakeProfiles()');
  h.run("state.selectedOption={kind:'adb',device:{serial:'192.0.2.10:39271'}};");
  assert.equal(h.run('selectedWakeTarget().port'), 39271);
  assert.equal(h.run('selectedWakeTarget().macAddress'), sony.macAddress);
});

test('obsolete wake errors do not overwrite the newly selected TV status', async () => {
  const h = harness();
  await h.run('loadWakeProfiles()');
  const gate = deferred();
  h.api.wakeDevice = () => gate.promise;
  const waking = h.run('wakeSelectedTv().catch(showError)');
  h.run("state.connectionGeneration++; setStatus('Online','ok'); setMessage('Other TV');");
  gate.reject(new Error('Old TV failed'));
  await waking;
  assert.equal(h.element('statusPill').textContent, 'Online');
  assert.equal(h.element('connectionMessage').textContent, 'Other TV');
});

test('waking another TV closes the old native session before changing the active TV', async () => {
  const h = harness([sony], { realSelection: true });
  await h.run('loadWakeProfiles()');
  h.run("state.serial='192.0.2.99:5555'; state.scrcpyRunning=true; state.scrcpyAvailable=true;");
  h.element('scrcpyStatusPill').textContent = 'TV window live';
  h.api.wakeDevice = async () => ({ connected: true, awakeConfirmed: true, profile: sony, message: 'Sony TV is awake.' });
  const stopped = deferred();
  const operations = [];
  h.api.stopScrcpy = ({ serial }) => { operations.push(`stop:${serial}`); return stopped.promise; };
  h.api.selectDevice = async ({ serial }) => { operations.push(`select:${serial}`); return { display: { width: 1920, height: 1080 } }; };
  const waking = h.run('wakeSelectedTv()');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(operations, ['stop:192.0.2.99:5555']);
  assert.equal(h.run('state.serial'), '192.0.2.99:5555');
  stopped.resolve();
  await waking;
  assert.deepEqual(operations, ['stop:192.0.2.99:5555', `select:${sony.serial}`]);
  assert.equal(h.run('state.serial'), sony.serial);
  assert.equal(h.run('state.scrcpyRunning'), false);
  assert.equal(h.run('state.mirrorMode'), 'off');
  assert.equal(h.element('scrcpyStatusPill').textContent, 'Interactive engine ready');
  assert.equal(h.element('mirrorHintTitle').textContent, 'TV ready for control');
});

test('waking the active TV preserves its live native session', async () => {
  const h = harness([sony], { realSelection: true });
  await h.run('loadWakeProfiles()');
  h.context.sony = sony;
  h.run('state.serial=sony.serial; state.scrcpyRunning=true; state.scrcpyAvailable=true;');
  h.element('scrcpyStatusPill').textContent = 'TV window live';
  h.api.wakeDevice = async () => ({ connected: true, awakeConfirmed: true, profile: sony, message: 'Sony TV is awake.' });
  h.api.stopScrcpy = async () => assert.fail('Same-TV wake stopped its live control');
  h.api.selectDevice = async () => ({ display: { width: 1920, height: 1080 } });
  await h.run('wakeSelectedTv()');
  assert.equal(h.run('state.scrcpyRunning'), true);
  assert.equal(h.element('scrcpyStatusPill').textContent, 'TV window live');
});

test('a changed selection while the old control closes cancels wake retargeting', async () => {
  const h = harness([sony], { realSelection: true });
  await h.run('loadWakeProfiles()');
  h.run("state.serial='192.0.2.99:5555'; state.scrcpyRunning=true;");
  h.api.wakeDevice = async () => ({ connected: true, awakeConfirmed: true, profile: sony, message: 'Sony TV is awake.' });
  const stopped = deferred();
  h.api.stopScrcpy = () => stopped.promise;
  h.api.selectDevice = async () => assert.fail('A stale wake switched the active TV');
  const waking = h.run('wakeSelectedTv()');
  await new Promise((resolve) => setImmediate(resolve));
  h.run("state.connectionGeneration++; state.selectedOption={device:{serial:'192.0.2.11:5555',host:'192.0.2.11'}};");
  stopped.resolve();
  await waking;
  assert.equal(h.run('state.serial'), '192.0.2.99:5555');
  assert.equal(h.run('state.wakeInFlight'), false);
});

test('switching through wake drains the old snapshot and removes old media before retargeting', async () => {
  const h = harness([sony], { realSelection: true });
  await h.run('loadWakeProfiles()');
  h.context.capture = deferred();
  h.run("state.serial='192.0.2.99:5555'; state.mirrorMode='snapshot'; state.snapshotUrl='old-tv'; state.snapshotPending=capture;");
  h.element('snapshotImage').src = 'old-snapshot';
  h.element('mirrorVideo').src = 'old-stream';
  h.api.wakeDevice = async () => ({ connected: true, awakeConfirmed: true, profile: sony, message: 'Sony TV is awake.' });
  const stops = [];
  h.api.stopScrcpy = async ({ serial }) => stops.push(serial);
  h.api.selectDevice = async () => ({ display: { width: 1920, height: 1080 } });
  const waking = h.run('wakeSelectedTv()');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.run('state.serial'), '192.0.2.99:5555');
  assert.equal(h.run('state.snapshotUrl'), '');
  assert.equal(h.run('state.mirrorMode'), 'off');
  assert.deepEqual(stops, []);
  h.run('finishSnapshot(false)');
  await waking;
  assert.equal(h.run('state.serial'), sony.serial);
  assert.deepEqual(stops, ['192.0.2.99:5555']);
  assert.equal(h.element('snapshotImage').src, undefined);
  assert.equal(h.element('mirrorVideo').src, undefined);
  assert.equal(h.run('state.snapshotPending'), null);
  assert.equal(h.run('state.snapshotTimer'), null);
});
