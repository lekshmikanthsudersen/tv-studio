const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const HeartbeatWorker = require('../src/main/modules/heartbeatWorker');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function boot({ platform = 'win32', startGate, stopGate, stopFailure } = {}) {
  const ready = deferred();
  const calls = [];
  const errors = [];
  const windows = [];
  const handlers = new Map();
  const app = new EventEmitter();
  Object.assign(app, {
    quitCalls: 0,
    terminated: false,
    whenReady: () => ready.promise,
    quit() {
      this.quitCalls += 1;
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit('before-quit', event);
      if (!event.prevented) this.terminated = true;
      // Electron's explicit Quit path does not emit window-all-closed.
    }
  });
  class Window {
    constructor() {
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    loadFile() { return Promise.resolve(); }
    static getAllWindows() { return windows; }
  }
  class Service extends EventEmitter {}
  class Adb extends Service {
    async disconnect(serial) { calls.push(`adb:disconnect:${serial}`); }
    async cancelScreenshots() { calls.push('captures:cancel'); }
  }
  class Stream extends Service {
    async start() {
      calls.push('stream:start');
      if (startGate) await startGate.promise;
    }
    async stop() { calls.push('stream:stop'); }
  }
  class Discovery extends Service {
    async stop() {
      calls.push('discovery:stop');
      if (stopFailure) throw stopFailure;
    }
  }
  class Heartbeat extends Service { stop() { calls.push('heartbeat:stop'); } }
  class Scrcpy extends Service {
    async stopAll() {
      calls.push('scrcpy:stop');
      if (stopGate) await stopGate.promise;
    }
  }
  const modules = {
    path,
    electron: { app, BrowserWindow: Window, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, shell: {} },
    './modules/adbWrapper': Adb,
    './modules/deviceDiscovery': Discovery,
    './modules/streamDecoder': Stream,
    './modules/heartbeatWorker': Heartbeat,
    './modules/scrcpyController': Scrcpy
  };
  const filename = path.resolve(__dirname, '../src/main/main.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (name) => {
      assert.ok(name in modules, `Unexpected main dependency: ${name}`);
      return modules[name];
    },
    __dirname: path.dirname(filename),
    process: { platform, env: {} },
    console: { error: (...args) => errors.push(args) },
    setTimeout,
    clearTimeout
  }, { filename });
  ready.resolve();
  return { app, calls, errors, windows, handlers };
}

test('File Exit waits for cleanup exactly once, including repeated quit requests', async () => {
  const stopGate = deferred();
  const { app, calls } = boot({ stopGate });
  await tick();
  app.quit();
  app.quit();
  await tick();
  assert.equal(app.terminated, false, 'Native session must close before Electron exits');
  assert.equal(calls.filter((call) => call === 'scrcpy:stop').length, 1);
  assert.deepEqual(calls.slice(1), ['heartbeat:stop', 'captures:cancel', 'discovery:stop', 'scrcpy:stop', 'stream:stop']);
  stopGate.resolve();
  await tick();
  assert.equal(app.terminated, true);
  assert.equal(app.quitCalls, 3, 'Only the final guarded quit may proceed');
});

test('closing the last Windows window uses the same guarded cleanup', async () => {
  const { app, calls } = boot();
  await tick();
  app.emit('window-all-closed');
  await tick();
  assert.equal(app.terminated, true);
  assert.equal(calls.filter((call) => call === 'scrcpy:stop').length, 1);
});

test('Disconnect stops automatic reconnect before disconnecting ADB', async () => {
  const { calls, handlers } = boot();
  await tick();
  const response = await handlers.get('adb:disconnect')(null, { serial: 'sony:5555' });
  assert.equal(response.ok, true);
  assert.deepEqual(calls.slice(1), ['heartbeat:stop', 'adb:disconnect:sony:5555']);
});

test('a heartbeat already checking the TV cannot reconnect after it is stopped', async () => {
  const status = deferred();
  let reconnects = 0;
  const worker = new HeartbeatWorker({ adb: {
    getState: () => status.promise,
    connect: async () => { reconnects += 1; return { serial: 'sony:5555' }; }
  } });
  worker.device = { serial: 'sony:5555', address: 'sony', port: 5555 };
  worker.stopped = false;
  const checking = worker.tick();
  worker.stop();
  status.reject(new Error('Device disconnected'));
  await checking;
  assert.equal(reconnects, 0);
  assert.equal(worker.timer, null);
});

test('one cleanup failure neither skips other services nor strands the app', async () => {
  const { app, calls, errors } = boot({ stopFailure: new Error('Socket already closed') });
  await tick();
  app.quit();
  await tick();
  assert.equal(app.terminated, true);
  assert.ok(calls.includes('stream:stop'));
  assert.ok(calls.includes('scrcpy:stop'));
  assert.equal(errors.length, 1);
});

test('quitting during startup does not create a window after cleanup', async () => {
  const startGate = deferred();
  const { app, windows } = boot({ startGate });
  await tick();
  app.quit();
  await tick();
  startGate.resolve();
  await tick();
  assert.equal(app.terminated, true);
  assert.equal(windows.length, 0);
});

test('a startup failure still quits cleanly', async () => {
  const startGate = deferred();
  const { app, calls, windows } = boot({ startGate });
  await tick();
  startGate.reject(new Error('Local stream server unavailable'));
  await tick();
  assert.equal(app.terminated, true);
  assert.ok(calls.includes('scrcpy:stop'));
  assert.equal(windows.length, 0);
});

test('macOS close keeps app alive and subsequent close cleans up again', async () => {
  const { app, windows, calls } = boot({ platform: 'darwin' });
  await tick();
  windows.length = 0;
  app.emit('window-all-closed');
  await tick();
  assert.equal(app.quitCalls, 0);
  app.emit('activate');
  await tick();
  assert.equal(windows.length, 1);
  windows.length = 0;
  app.emit('window-all-closed');
  await tick();
  assert.equal(calls.filter((call) => call === 'scrcpy:stop').length, 2);
  assert.equal(app.terminated, false);
});
