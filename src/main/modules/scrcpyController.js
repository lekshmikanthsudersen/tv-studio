const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');

class ScrcpyController extends EventEmitter {
  constructor({ adb, appRoot, spawnProcess = spawn, startupTimeoutMs = 15000, stopTimeoutMs = 5000 } = {}) {
    super();
    this.adb = adb;
    this.appRoot = appRoot || process.cwd();
    this.spawnProcess = spawnProcess;
    this.startupTimeoutMs = startupTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.scrcpyPath = null;
    this.sessions = new Map();
    this.lastStatus = new Map();
    this.operation = Promise.resolve();
    this.stopGeneration = 0;
  }

  getScrcpyPath() {
    if (this.scrcpyPath) return this.scrcpyPath;
    const executable = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';
    const candidates = [
      process.env.ANDROID_TV_CONTROLLER_SCRCPY,
      process.env.SCRCPY,
      path.join(this.appRoot, 'scrcpy', executable),
      path.join(this.appRoot, 'bin', executable),
      path.join(this.appRoot, executable)
    ].filter(Boolean);
    this.scrcpyPath = candidates.find((candidate) => fs.existsSync(candidate)) || executable;
    return this.scrcpyPath;
  }

  async getDiagnostics() {
    try {
      return {
        available: true,
        path: this.getScrcpyPath(),
        version: await this.probe(),
        status: 'scrcpy-ok',
        embeddedWindowSupported: false
      };
    } catch (error) {
      return {
        available: false,
        path: this.getScrcpyPath(),
        error: error.message,
        code: error.code || 'SCRCPY_UNAVAILABLE',
        status: 'scrcpy-missing',
        embeddedWindowSupported: false
      };
    }
  }

  spawn(args) {
    return this.spawnProcess(this.getScrcpyPath(), args, {
      cwd: path.dirname(this.getScrcpyPath()),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ADB: this.adb.getAdbPath() }
    });
  }

  probe() {
    return new Promise((resolve, reject) => {
      const child = this.spawn(['--version']);
      let output = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        finish(failure('scrcpy probe timed out.', 'SCRCPY_TIMEOUT'));
      }, 5000);
      const collect = (chunk) => { output = `${output}${chunk.toString('utf8')}`.slice(-12000); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (error) => finish(failure(
        'scrcpy was not found. Install the bundled runtime from Settings or set ANDROID_TV_CONTROLLER_SCRCPY.',
        error.code === 'ENOENT' ? 'SCRCPY_MISSING' : 'SCRCPY_SPAWN_FAILED'
      )));
      child.on('close', (code) => {
        const text = cleanOutput(output);
        if (code !== 0) finish(failure(text || `scrcpy exited with code ${code}`, 'SCRCPY_EXIT_NON_ZERO'));
        else finish(null, text.split(/\r?\n/)[0] || 'scrcpy');
      });
    });
  }

  enqueue(operation) {
    const task = this.operation.then(operation);
    this.operation = task.catch(() => null);
    return task;
  }

  async start(serial, options = {}) {
    assertSerial(serial);
    const generation = this.stopGeneration;
    return this.enqueue(async () => {
      await this.probe();
      const state = await this.adb.getState(serial);
      if (state !== 'device') {
        throw failure(`TV is not ready for control (ADB state: ${state || 'unknown'}).`, 'DEVICE_NOT_READY');
      }
      if (generation !== this.stopGeneration) throw failure('Interactive session start cancelled.', 'SCRCPY_START_CANCELLED');
      await this.stopSessions();
      if (generation !== this.stopGeneration) throw failure('Interactive session start cancelled.', 'SCRCPY_START_CANCELLED');

      const normalized = normalizeOptions(options);
      const child = this.spawn(buildArgs(serial, normalized));
      const session = {
        serial, child, pid: child.pid, options: normalized,
        state: 'starting', startedAt: Date.now(), stdout: '', stderr: '',
        closed: false, stopRequested: false, readySettled: false, failure: null
      };
      session.ready = new Promise((resolve, reject) => {
        session.resolveReady = resolve;
        session.rejectReady = reject;
      });
      session.exited = new Promise((resolve) => { session.resolveExited = resolve; });
      this.sessions.set(serial, session);
      child.stdout.on('data', (chunk) => this.handleOutput(session, chunk, false));
      child.stderr.on('data', (chunk) => this.handleOutput(session, chunk, true));
      child.on('error', (error) => this.failSession(session, failure(error.message, error.code || 'SCRCPY_PROCESS_ERROR')));
      child.on('close', (code) => {
        session.closed = true;
        if (!session.stopRequested && (!session.readySettled || code !== 0)) {
          this.failSession(session, failure(
            session.lastError || (session.readySettled ? `scrcpy exited with code ${code}.` : 'scrcpy closed before video was ready.'),
            session.readySettled ? 'SCRCPY_RUNTIME_ERROR' : 'SCRCPY_START_FAILED'
          ));
        }
        session.state = session.failure ? 'error' : 'stopped';
        if (this.sessions.get(serial) === session) this.sessions.delete(serial);
        this.lastStatus.set(serial, this.publicStatus(session));
        if (!session.failure) this.emitStatus(session, 'Interactive session stopped');
        session.resolveExited();
      });
      session.startupTimer = setTimeout(() => {
        this.failSession(session, failure('scrcpy did not produce video before the startup timeout.', 'SCRCPY_START_TIMEOUT'));
      }, this.startupTimeoutMs);
      this.emitStatus(session, 'Opening the interactive TV window');
      try {
        return await session.ready;
      } catch (error) {
        await this.stopSession(session);
        throw error;
      }
    });
  }

  finishStartup(session, error) {
    if (session.readySettled) return;
    session.readySettled = true;
    clearTimeout(session.startupTimer);
    if (error) session.rejectReady(error);
    else {
      session.state = 'live';
      this.emitStatus(session, 'Interactive TV window is ready');
      session.resolveReady(this.publicStatus(session));
    }
  }

  failSession(session, error) {
    if (session.failure || session.stopRequested) return;
    session.failure = error;
    session.state = 'error';
    this.finishStartup(session, error);
    this.emitStatus(session, error.message, { code: error.code });
  }

  requestStop(session) {
    if (session.closed || session.stopRequested) return;
    session.stopRequested = true;
    if (!session.failure) {
      session.state = 'stopping';
      this.emitStatus(session, 'Stopping interactive session');
    }
    this.finishStartup(session, failure('Interactive session start cancelled.', 'SCRCPY_START_CANCELLED'));
    if (process.platform === 'win32' && Number.isInteger(session.pid)) {
      // Node's SIGTERM is forceful on Windows. A non-forced taskkill lets the
      // native window close normally, so scrcpy can stop its Android server.
      session.closeRequest = this.spawnProcess('taskkill.exe', ['/PID', String(session.pid)], {
        windowsHide: true, stdio: 'ignore'
      });
      session.closeRequest.on('error', () => {}); // The bounded fallback below still applies.
      session.closeRequest.on('close', () => { session.closeRequest = null; });
    } else {
      session.child.kill('SIGTERM');
    }
  }

  async stopSession(session) {
    this.requestStop(session);
    if (await waitForExit(session, this.stopTimeoutMs)) return;
    session.closeRequest?.kill('SIGTERM');
    session.child.kill('SIGKILL');
    if (await waitForExit(session, this.stopTimeoutMs)) return;
    throw failure('scrcpy did not exit. Close its window before starting another session.', 'SCRCPY_STOP_TIMEOUT');
  }

  async stopSessions() {
    for (const session of this.sessions.values()) await this.stopSession(session);
  }

  async stop(serial) {
    assertSerial(serial);
    this.stopGeneration += 1;
    const current = this.sessions.get(serial);
    if (current) this.requestStop(current);
    return this.enqueue(async () => {
      const session = this.sessions.get(serial);
      if (session) await this.stopSession(session);
      return this.getStatus(serial);
    });
  }

  async stopAll() {
    this.stopGeneration += 1;
    for (const session of this.sessions.values()) this.requestStop(session);
    return this.enqueue(() => this.stopSessions());
  }

  getStatus(serial) {
    const session = this.sessions.get(serial);
    return session ? this.publicStatus(session) : this.lastStatus.get(serial) || {
      serial: serial || '', state: 'stopped', running: false, embedded: false
    };
  }

  handleOutput(session, chunk, isError) {
    const text = chunk.toString('utf8');
    const key = isError ? 'stderr' : 'stdout';
    session[key] = `${session[key]}${text}`.slice(-12000);
    const errors = cleanOutput(session[key]).split(/\r?\n/).filter((line) => /ERROR:/i.test(line));
    if (errors.length) session.lastError = errors[errors.length - 1];
    // scrcpy can recover from encoder errors by retrying at a smaller resolution.
    // Its first Texture log confirms the native video renderer has a frame size.
    if (/\bTexture:\s+\d+x\d+\r?\n/.test(session[key])) {
      session.lastError = null;
      session.stdout = '';
      session.stderr = '';
      if (session.state === 'starting') this.finishStartup(session);
    }
    this.emit('event', {
      type: 'scrcpy-log', serial: session.serial,
      level: isError ? 'stderr' : 'stdout', message: cleanOutput(text)
    });
  }

  emitStatus(session, message, extra = {}) {
    this.emit('event', { type: 'scrcpy-status', ...this.publicStatus(session), message, ...extra });
  }

  publicStatus(session) {
    return {
      serial: session.serial, pid: session.pid, state: session.state,
      running: !session.closed && ['starting', 'live'].includes(session.state),
      embedded: false, startedAt: session.startedAt, options: session.options,
      ...(session.failure ? { code: session.failure.code, message: session.failure.message } : {})
    };
  }
}

function buildArgs(serial, options) {
  const args = [
    '--serial', serial,
    '--window-title', 'TV Studio — Live control',
    '--max-size', String(options.maxSize),
    '--max-fps', String(options.maxFps),
    '--video-bit-rate', `${options.videoBitrate}M`,
    '--video-codec=h264', '--video-buffer=0', '--keyboard=sdk', '--mouse=sdk',
    '--stay-awake', '--disable-screensaver'
  ];
  if (!options.audio) args.push('--no-audio');
  return args;
}

function normalizeOptions(options) {
  return {
    maxSize: clampInteger(options.maxSize, 640, 3840, 1280),
    maxFps: clampInteger(options.maxFps, 15, 120, 60),
    videoBitrate: clampInteger(options.videoBitrate, 1, 50, 5),
    audio: Boolean(options.audio), keyboard: 'sdk', mouse: 'sdk'
  };
}

function clampInteger(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Math.round(Number(value));
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
}

function assertSerial(serial) {
  if (!serial || typeof serial !== 'string' || /[\r\n]/.test(serial)) {
    throw failure('A valid device serial is required.', 'INVALID_SERIAL');
  }
}

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

function waitForExit(session, timeoutMs) {
  if (session.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    session.exited.then(() => { clearTimeout(timeout); resolve(true); });
  });
}

function cleanOutput(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
}

module.exports = ScrcpyController;
