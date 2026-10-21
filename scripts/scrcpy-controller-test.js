const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const ScrcpyController = require('../src/main/modules/scrcpyController');

let nextPid = 1000;
class FakeChild extends EventEmitter {
  constructor(onKill) {
    super();
    this.pid = nextPid++;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
    this.onKill = onKill;
    this.closed = false;
  }

  kill(signal) {
    this.signals.push(signal);
    this.onKill?.(this);
    return true;
  }

  close(code = 0) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }
}

function fixture(t, options = {}) {
  const state = { calls: [], sessions: [], closeRequests: [], autoClose: true };
  const spawnProcess = (executable, args, spawnOptions) => {
    const child = new FakeChild((target) => {
      if (state.autoClose) queueMicrotask(() => target.close());
    });
    state.calls.push({ executable, args, options: spawnOptions, child });
    if (args.includes('--version')) {
      queueMicrotask(() => { child.stdout.write('scrcpy 4.1\n'); child.close(); });
    } else if (executable === 'taskkill.exe') {
      state.closeRequests.push(args);
      queueMicrotask(() => {
        if (state.autoClose) state.sessions.find((target) => String(target.pid) === args[1])?.close();
        child.close();
      });
    } else {
      state.sessions.push(child);
    }
    return child;
  };
  state.controller = new ScrcpyController({
    adb: { getAdbPath: () => 'bundled-adb', getState: async () => 'device' },
    spawnProcess, ...options
  });
  state.events = [];
  state.controller.on('event', (event) => state.events.push(event));
  t.after(async () => {
    for (const child of state.sessions) child.close();
    await state.controller.stopAll();
  });
  return state;
}

async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Expected asynchronous process action did not occur.');
}

function ready(child) { child.stderr.write('INFO: Texture: 1280x720\n'); }

async function startReady(state, serial = 'tv') {
  const count = state.sessions.length;
  const started = state.controller.start(serial);
  await until(() => state.sessions.length > count);
  const child = state.sessions[count];
  ready(child);
  await started;
  return child;
}

test('native companion uses SDK input and low-latency defaults, ignoring stale embedding options', async (t) => {
  const state = fixture(t);
  const start = state.controller.start('tv', { embed: true, inputMode: 'uhid', keyboard: 'uhid', mouse: 'uhid' });
  await until(() => state.sessions.length === 1);
  const call = state.calls.find(({ args }) => args.includes('--serial'));
  for (const flag of ['--keyboard=sdk', '--mouse=sdk', '--video-codec=h264', '--video-buffer=0', '--no-audio']) {
    assert.ok(call.args.includes(flag), flag);
  }
  for (const [flag, value] of [['--max-size', '1280'], ['--max-fps', '60'], ['--video-bit-rate', '5M']]) {
    assert.equal(call.args[call.args.indexOf(flag) + 1], value);
  }
  assert.ok(!call.args.some((arg) => /borderless|window-width|window-height|uhid/.test(arg)));
  assert.equal(call.options.env.ADB, 'bundled-adb');
  assert.equal(typeof state.controller.updateBounds, 'undefined');
  ready(state.sessions[0]);
  assert.equal((await start).embedded, false);
  assert.equal((await state.controller.getDiagnostics()).embeddedWindowSupported, false);
});

test('startup waits for video readiness and handles a log line split across chunks', async (t) => {
  const state = fixture(t);
  let resolved = false;
  const start = state.controller.start('tv').then((status) => { resolved = true; return status; });
  await until(() => state.sessions.length === 1);
  const child = state.sessions[0];
  child.stderr.write('INFO: Renderer: direct3d\nINFO: Tex');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(state.controller.getStatus('tv').state, 'starting');
  child.stderr.write('ture: 1280x720\n');
  assert.equal((await start).state, 'live');
  assert.deepEqual(state.events.filter((event) => event.type === 'scrcpy-status').map((event) => event.state), ['starting', 'live']);
});

test('an encoder error may recover before video starts', async (t) => {
  const state = fixture(t);
  const start = state.controller.start('tv');
  await until(() => state.sessions.length === 1);
  state.sessions[0].stderr.write('ERROR: Encoding error\nINFO: Retrying with a smaller size...\n');
  ready(state.sessions[0]);
  assert.equal((await start).state, 'live');
  assert.ok(!state.events.some((event) => event.state === 'error'));
});

test('startup exit reports the actual error and never reports live', async (t) => {
  const state = fixture(t);
  const rejection = assert.rejects(state.controller.start('tv'), /Could not connect to device/);
  await until(() => state.sessions.length === 1);
  state.sessions[0].stderr.write('ERROR: Could not connect to device\n');
  state.sessions[0].close(1);
  await rejection;
  assert.equal(state.controller.getStatus('tv').state, 'error');
  assert.equal(state.controller.getStatus('tv').running, false);
  assert.ok(!state.events.some((event) => event.state === 'live'));
});

test('a process spawn error rejects startup and remains visible after close', async (t) => {
  const state = fixture(t);
  const rejection = assert.rejects(state.controller.start('tv'), { code: 'ENOENT' });
  await until(() => state.sessions.length === 1);
  state.sessions[0].emit('error', Object.assign(new Error('Native executable disappeared'), { code: 'ENOENT' }));
  state.sessions[0].close(1);
  await rejection;
  assert.equal(state.controller.getStatus('tv').state, 'error');
});

test('unexpected exit after live retains an error instead of overwriting it with stopped', async (t) => {
  const state = fixture(t);
  const child = await startReady(state);
  child.stderr.write('ERROR: Device disconnected\n');
  child.close(1);
  assert.equal(state.controller.getStatus('tv').state, 'error');
  const statuses = state.events.filter((event) => event.type === 'scrcpy-status');
  assert.equal(statuses.at(-1).state, 'error');
  assert.match(statuses.at(-1).message, /Device disconnected/);
});

test('restart waits for the old process to close before creating its replacement', async (t) => {
  const state = fixture(t);
  const oldChild = await startReady(state);
  state.autoClose = false;
  const restart = state.controller.start('tv');
  await until(() => state.closeRequests.length || oldChild.signals.length);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.controller.getStatus('tv').state, 'stopping');
  if (process.platform === 'win32') {
    assert.deepEqual(state.closeRequests[0], ['/PID', String(oldChild.pid)]);
    assert.deepEqual(oldChild.signals, []);
  }
  oldChild.close();
  await until(() => state.sessions.length === 2);
  ready(state.sessions[1]);
  assert.equal((await restart).state, 'live');
});

test('stop cancels startup and waits for the native process to exit', async (t) => {
  const state = fixture(t);
  state.autoClose = false;
  const rejectedStart = assert.rejects(state.controller.start('tv'), { code: 'SCRCPY_START_CANCELLED' });
  await until(() => state.sessions.length === 1);
  let stopped = false;
  const stop = state.controller.stop('tv').then((status) => { stopped = true; return status; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  state.sessions[0].close();
  await rejectedStart;
  assert.equal((await stop).state, 'stopped');
});

test('stop during the readiness check cancels a pending start before it spawns', async (t) => {
  let entered = false;
  let resolveState;
  const state = fixture(t, { adb: {
    getAdbPath: () => 'bundled-adb',
    getState: () => { entered = true; return new Promise((resolve) => { resolveState = resolve; }); }
  } });
  const rejectedStart = assert.rejects(state.controller.start('tv'), { code: 'SCRCPY_START_CANCELLED' });
  await until(() => entered);
  const stopped = state.controller.stopAll();
  resolveState('device');
  await rejectedStart;
  await stopped;
  assert.equal(state.sessions.length, 0);
});

test('startup timeout cleans up the process and never reports live', async (t) => {
  const state = fixture(t, { startupTimeoutMs: 20, stopTimeoutMs: 20 });
  await assert.rejects(state.controller.start('tv'), { code: 'SCRCPY_START_TIMEOUT' });
  assert.equal(state.sessions[0].closed, true);
  assert.equal(state.controller.getStatus('tv').state, 'error');
  assert.ok(!state.events.some((event) => event.state === 'live'));
});

test('a process that cannot be stopped prevents a second native session', async (t) => {
  const state = fixture(t, { stopTimeoutMs: 5 });
  const child = await startReady(state);
  state.autoClose = false;
  await assert.rejects(state.controller.stop('tv'), { code: 'SCRCPY_STOP_TIMEOUT' });
  assert.ok(child.signals.includes('SIGKILL'));
  await assert.rejects(state.controller.start('tv'), { code: 'SCRCPY_STOP_TIMEOUT' });
  assert.equal(state.sessions.length, 1);
});
