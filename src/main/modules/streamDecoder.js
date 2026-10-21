const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');

class StreamDecoder extends EventEmitter {
  constructor({ adb, appRoot, logger = console } = {}) {
    super();
    this.adb = adb;
    this.appRoot = appRoot || process.cwd();
    this.logger = logger;
    this.server = null;
    this.port = null;
    this.ffmpegPath = null;
    this.streamStates = new Map();
    this.activePipelines = new Set();
  }

  get baseUrl() {
    return this.port ? `http://127.0.0.1:${this.port}` : '';
  }

  async start() {
    if (this.server) {
      return this.baseUrl;
    }

    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        if (response.destroyed) return;
        this.emit('error', error);
        if (!response.headersSent) {
          response.writeHead(error.httpStatus || 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        }
        response.end(JSON.stringify({ error: error.message, code: error.code || 'STREAM_ERROR' }));
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        this.port = this.server.address().port;
        resolve();
      });
    });

    return this.baseUrl;
  }

  async stop() {
    for (const pipeline of Array.from(this.activePipelines)) {
      pipeline.close();
    }
    this.activePipelines.clear();

    if (!this.server) {
      return;
    }

    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.port = null;
  }

  getFfmpegPath() {
    if (this.ffmpegPath) {
      return this.ffmpegPath;
    }

    const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const candidates = [
      process.env.ANDROID_TV_CONTROLLER_FFMPEG,
      process.env.FFMPEG,
      path.join(this.appRoot, 'bin', executable),
      path.join(this.appRoot, 'ffmpeg', 'bin', executable),
      path.join(this.appRoot, executable)
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        this.ffmpegPath = candidate;
        return candidate;
      }
    }

    this.ffmpegPath = 'ffmpeg';
    return this.ffmpegPath;
  }

  async getDiagnostics() {
    try {
      const version = await this.probeFfmpeg();
      return {
        available: true,
        path: this.getFfmpegPath(),
        version,
        baseUrl: this.baseUrl,
        status: 'ffmpeg-ok'
      };
    } catch (error) {
      return {
        available: false,
        path: this.getFfmpegPath(),
        error: error.message,
        code: error.code || 'FFMPEG_UNAVAILABLE',
        baseUrl: this.baseUrl,
        status: 'ffmpeg-missing'
      };
    }
  }

  getStreamStatus(serial) {
    if (serial && this.streamStates.has(serial)) {
      return this.streamStates.get(serial);
    }

    return {
      serial: serial || '',
      state: 'idle',
      reason: '',
      at: Date.now()
    };
  }

  setStreamStatus(serial, state, reason = '', extra = {}) {
    const status = {
      serial,
      state,
      reason,
      at: Date.now(),
      ...extra
    };
    this.streamStates.set(serial, status);
    this.emit('event', { type: 'stream-status', ...status });
    return status;
  }

  probeFfmpeg() {
    return new Promise((resolve, reject) => {
      const child = spawn(this.getFfmpegPath(), ['-version'], {
        cwd: this.appRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(Object.assign(new Error('FFmpeg probe timed out.'), { code: 'FFMPEG_TIMEOUT' }));
      }, 5000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(Object.assign(
          new Error('FFmpeg binary was not found. Configure ANDROID_TV_CONTROLLER_FFMPEG, add ffmpeg to PATH, or place it in bin/.'),
          { code: error.code === 'ENOENT' ? 'FFMPEG_MISSING' : 'FFMPEG_SPAWN_FAILED', cause: error }
        ));
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(Object.assign(new Error(stderr || stdout || `FFmpeg exited with code ${code}`), {
            code: 'FFMPEG_EXIT_NON_ZERO'
          }));
          return;
        }
        resolve(stdout.split(/\r?\n/)[0] || 'ffmpeg');
      });
    });
  }

  async getStreamUrl(serial, options = {}) {
    assertSerial(serial);
    if (!this.server) {
      await this.start();
    }

    this.setStreamStatus(serial, 'starting', 'stream URL requested');

    const query = new URLSearchParams({
      serial,
      size: options.size || '1280x720',
      bitrate: String(options.bitrate || 4000000),
      fps: String(options.fps || 30)
    });

    return `${this.baseUrl}/stream?${query.toString()}`;
  }

  async getSnapshotUrl(serial) {
    assertSerial(serial);
    if (!this.server) {
      await this.start();
    }

    this.setStreamStatus(serial, 'snapshot-fallback', 'snapshot endpoint requested');

    const query = new URLSearchParams({ serial });
    return `${this.baseUrl}/snapshot?${query.toString()}`;
  }

  async handleRequest(request, response) {
    const url = new URL(request.url, this.baseUrl || 'http://127.0.0.1');

    if (url.pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/snapshot') {
      await this.handleSnapshot(url, response);
      return;
    }

    if (url.pathname === '/stream') {
      await this.handleStream(url, request, response);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
  }

  async handleSnapshot(url, response) {
    const serial = url.searchParams.get('serial');
    assertSerial(serial);

    const controller = new AbortController();
    const onClose = () => controller.abort();
    const pipeline = {
      close: () => {
        controller.abort();
        response.destroy();
      }
    };
    this.activePipelines.add(pipeline);
    response.once('close', onClose);
    this.setStreamStatus(serial, 'snapshot-fallback', 'capturing PNG snapshot');

    try {
      const capture = await this.adb.captureScreenshot(serial, { signal: controller.signal });
      if (response.destroyed || controller.signal.aborted) return;
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': capture.bytes,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'X-Capture-Duration-Ms': String(capture.captureMs)
      });
      response.end(capture.png);
      this.setStreamStatus(serial, 'snapshot-fallback', 'PNG snapshot ready', {
        captureMs: capture.captureMs,
        width: capture.width,
        height: capture.height
      });
    } catch (error) {
      if (response.destroyed || controller.signal.aborted) return;
      this.setStreamStatus(serial, 'error', error.message, { code: error.code });
      error.httpStatus = error.code === 'ADB_TIMEOUT' ? 504 : 502;
      throw error;
    } finally {
      response.off('close', onClose);
      this.activePipelines.delete(pipeline);
    }
  }

  async handleStream(url, request, response) {
    const serial = url.searchParams.get('serial');
    assertSerial(serial);
    const size = sanitizeSize(url.searchParams.get('size') || '1280x720');
    const bitrate = sanitizeInteger(url.searchParams.get('bitrate'), 250000, 25000000, 4000000);

    try {
      await this.probeFfmpeg();
    } catch (error) {
      this.setStreamStatus(serial, 'error', error.message, { code: error.code || 'FFMPEG_UNAVAILABLE' });
      throw error;
    }

    const adbArgs = [
      '-s',
      serial,
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      '--bit-rate',
      String(bitrate),
      '--size',
      size,
      '-'
    ];

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-f',
      'h264',
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'copy',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1'
    ];

    const adbProcess = this.adb.spawnAdb(adbArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const ffmpegProcess = spawn(this.getFfmpegPath(), ffmpegArgs, {
      cwd: this.appRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    response.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Connection': 'close',
      'X-Accel-Buffering': 'no'
    });

    this.setStreamStatus(serial, 'starting', 'screenrecord and FFmpeg pipeline started', { size, bitrate });
    this.emit('event', { type: 'stream-started', serial, size, bitrate });
    adbProcess.stdout.pipe(ffmpegProcess.stdin);
    ffmpegProcess.stdout.pipe(response);

    ffmpegProcess.stdout.once('data', () => {
      this.setStreamStatus(serial, 'live', 'video bytes flowing', { size, bitrate });
    });

    let closed = false;
    const pipeline = { close: null };
    const closeAll = () => {
      if (closed) return;
      closed = true;
      this.activePipelines.delete(pipeline);
      adbProcess.kill('SIGTERM');
      ffmpegProcess.kill('SIGTERM');
      if (!response.destroyed) response.destroy();
    };
    pipeline.close = closeAll;
    this.activePipelines.add(pipeline);

    request.on('close', closeAll);
    response.on('close', closeAll);

    adbProcess.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8');
      this.setStreamStatus(serial, 'error', message);
      this.emit('event', { type: 'adb-stream-stderr', serial, message });
    });
    ffmpegProcess.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8');
      this.setStreamStatus(serial, 'error', message);
      this.emit('event', { type: 'ffmpeg-stderr', serial, message });
    });
    adbProcess.on('error', (error) => this.emit('error', error));
    ffmpegProcess.on('error', (error) => this.emit('error', error));
    adbProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.setStreamStatus(serial, 'error', `screenrecord closed with code ${code}`, { code });
      }
      this.emit('event', { type: 'adb-stream-closed', serial, code });
    });
    ffmpegProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.setStreamStatus(serial, 'error', `FFmpeg closed with code ${code}`, { code });
      }
      this.emit('event', { type: 'ffmpeg-closed', serial, code });
    });
  }
}

function assertSerial(serial) {
  if (!serial || /[\r\n]/.test(serial)) {
    const error = new Error('A valid device serial is required for streaming.');
    error.code = 'INVALID_SERIAL';
    throw error;
  }
}

function sanitizeSize(size) {
  const match = String(size).match(/^(\d{3,5})x(\d{3,5})$/);
  if (!match) {
    return '1280x720';
  }
  const width = Math.max(320, Math.min(3840, Number(match[1])));
  const height = Math.max(240, Math.min(2160, Number(match[2])));
  return `${width}x${height}`;
}

function sanitizeInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

module.exports = StreamDecoder;
