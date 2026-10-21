const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise renderer behavior without starting ADB or connecting to a TV.
const elements = new Map();
const timers = new Map();
const calls = { keys: [], frames: [], starts: [], captures: 0 };
let nextTimer = 1;
const document = {
  activeElement: null,
  body: {},
  getElementById(id) {
    if (!elements.has(id)) {
      const element = {
        id, value: '', disabled: false, checked: false, hidden: false,
        textContent: '', style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        focus() { document.activeElement = this; },
        closest() { return null; },
        removeAttribute() {}, load() {},
        play() { return Promise.resolve(); }
      };
      Object.defineProperty(element, 'src', {
        set(value) { if (id === 'snapshotImage') calls.frames.push(value); }
      });
      elements.set(id, element);
    }
    return elements.get(id);
  },
  querySelectorAll() { return []; }
};
const api = {
  inputKey(payload) { calls.keys.push(payload); return Promise.resolve(); },
  getSnapshotUrl() { return Promise.resolve('http://127.0.0.1/snapshot?serial=test'); },
  startScrcpy(payload) { calls.starts.push(payload); return Promise.resolve({ running: true, state: 'live' }); },
  stopScrcpy() { return Promise.resolve(); }
};
const context = vm.createContext({
  document,
  window: {
    androidTv: api,
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  },
  console, performance, Date
});
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/uiController.js'), 'utf8')
  .replace(/^init\(\)\.catch\(\(error\) => showError\(error\)\);$/m, '');
vm.runInContext(source, context);
const evaluate = (code) => vm.runInContext(code, context);
const element = (id) => document.getElementById(id);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function main() {
  evaluate("state.serial = 'test';");
  for (const name of ['select', 'button', 'input', 'summary']) {
    const event = { key: 'Enter', target: { closest: () => ({ tagName: name }) }, preventDefault() { assert.fail(`${name} keyboard was intercepted`); } };
    context.event = event;
    evaluate('handleGlobalKeyDown(event)');
  }
  assert.equal(calls.keys.length, 0);
  context.event = { key: 'ArrowRight', target: element('mirrorStage'), preventDefault() {} };
  evaluate('handleGlobalKeyDown(event)');
  assert.equal(calls.keys[0].keyCode, 'KEYCODE_DPAD_RIGHT');
  await new Promise((resolve) => setImmediate(resolve));

  const key = deferred();
  api.inputKey = (payload) => { calls.keys.push(payload); return key.promise; };
  const firstKey = evaluate("sendKey('KEYCODE_DPAD_UP')");
  for (let i = 0; i < 30; i++) evaluate("sendKey('KEYCODE_DPAD_UP')");
  assert.equal(calls.keys.length, 2, 'Repeated keys built an ADB backlog');
  key.resolve();
  await firstKey;
  assert.equal(evaluate('state.keyInFlight'), false);

  const command = deferred();
  context.operation = () => command.promise;
  const commandResult = evaluate("runCommand('test', operation)");
  element('textInput').focus();
  command.resolve();
  await commandResult;
  assert.equal(document.activeElement, element('textInput'), 'Command completion stole text focus');

  const text = deferred();
  api.sendText = () => text.promise;
  element('textInput').value = 'first text';
  const textResult = evaluate('sendTextBuffer()');
  element('textInput').value = 'new text';
  element('deviceSelect').focus();
  text.resolve();
  await textResult;
  assert.equal(element('textInput').value, 'new text');
  assert.equal(document.activeElement, element('deviceSelect'));

  await evaluate('startSnapshotFallback()');
  assert.equal(calls.frames.length, 1);
  evaluate('refreshSnapshot(); refreshSnapshot();');
  assert.equal(calls.frames.length, 1, 'Preview issued overlapping captures');
  assert.equal(timers.size, 0, 'Preview scheduled another capture before load');
  evaluate('finishSnapshot(true)');
  assert.equal(timers.size, 1);
  const [timerId, callback] = timers.entries().next().value;
  timers.delete(timerId);
  callback();
  assert.equal(calls.frames.length, 2);

  evaluate('state.scrcpyAvailable = true;');
  element('scrcpyQualitySelect').value = 'speed';
  const start = evaluate('startInteractiveControl()');
  await Promise.resolve();
  assert.equal(calls.starts.length, 0, 'Native video started while a preview capture was pending');
  evaluate('finishSnapshot(true)');
  await start;
  assert.equal(calls.starts.length, 1);
  assert.equal(calls.starts[0].options.maxSize, 1280);
  assert.equal(calls.starts[0].options.inputMode, 'compatibility');
  assert.equal(calls.starts[0].bounds, undefined);
  assert.equal(timers.size, 0, 'Preview continued after native control started');
  const framesBefore = calls.frames.length;
  await evaluate('handleStreamFailure(); startSnapshotFallback();');
  assert.equal(calls.frames.length, framesBefore, 'An obsolete video error restarted preview beside native control');

  const nativeStart = deferred();
  const nativeStop = deferred();
  api.startScrcpy = () => nativeStart.promise;
  api.stopScrcpy = () => {
    nativeStart.reject(Object.assign(new Error('Stopped during startup'), { code: 'SCRCPY_START_CANCELLED' }));
    return nativeStop.promise;
  };
  api.disconnectAdb = () => Promise.resolve();
  evaluate('renderApps = () => {}; renderPackageList = () => {}; renderLaunchers = () => {};');
  const preferred = evaluate('startPreferredMirror()');
  await new Promise((resolve) => setImmediate(resolve));
  const disconnected = evaluate('disconnect()');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.frames.length, framesBefore, 'Canceled startup restarted preview while disconnecting');
  assert.equal(evaluate('state.snapshotUrl'), '');
  nativeStop.resolve();
  await Promise.all([preferred, disconnected]);
  assert.equal(evaluate('state.serial'), '');
  assert.equal(evaluate('state.mirrorMode'), 'off');
  assert.equal(element('startScrcpyButton').disabled, false);

  const selection = deferred();
  api.selectDevice = () => selection.promise;
  const selecting = evaluate("selectDevice({ serial: 'stale' })");
  await evaluate('disconnect()');
  selection.resolve({ display: { width: 1920, height: 1080 } });
  await selecting;
  assert.equal(evaluate('state.serial'), '', 'A late device selection undid disconnect');

  const connecting = deferred();
  api.connectAdb = () => connecting.promise;
  element('manualHostInput').value = '192.0.2.1';
  const connection = evaluate('manualConnect()');
  await evaluate('disconnect()');
  connecting.resolve({ serial: 'stale' });
  await connection;
  assert.equal(evaluate('state.serial'), '', 'A late ADB connection undid disconnect');
  evaluate("state.serial = 'test';");

  api.startScrcpy = () => Promise.reject(Object.assign(new Error('Stopped during startup'), { code: 'SCRCPY_START_CANCELLED' }));
  await evaluate('startPreferredMirror()');
  assert.equal(evaluate('state.mirrorMode'), 'off', 'Intentional stop triggered preview fallback');
  assert.equal(calls.frames.length, framesBefore);

  const capture = deferred();
  api.captureScreenshot = () => { calls.captures++; return capture.promise; };
  const screenshot = evaluate('captureScreenshot()');
  await evaluate('captureScreenshot()');
  assert.equal(calls.captures, 1);
  assert.equal(element('screenshotButton').disabled, true);
  capture.resolve({ path: 'C:\\Screenshots\\tv.png', captureMs: 1200 });
  await screenshot;
  assert.equal(element('screenshotButton').disabled, false);
  assert.equal(element('openScreenshotButton').hidden, false);
  assert.match(element('screenshotMessage').textContent, /tv\.png.*1\.2s/);

  console.log('Renderer regression checks passed: control focus, bounded keys, single preview capture, native handoff/cancellation, screenshot feedback.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
