const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class AdbError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'AdbError';
    this.code = code;
    Object.assign(this, details);
  }
}

const KEY_CODE_PATTERN = /^KEYCODE_[A-Z0-9_]+$/;

class AdbWrapper {
  constructor({ appRoot, logger = console } = {}) {
    this.appRoot = appRoot || process.cwd();
    this.logger = logger;
    this.adbPath = null;
    this.inputQueue = Promise.resolve();
    this.screenshotCaptures = new Map();
  }

  getAdbPath() {
    if (this.adbPath) {
      return this.adbPath;
    }

    const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
    const candidates = [
      process.env.ANDROID_TV_CONTROLLER_ADB,
      process.env.ADB,
      path.join(this.appRoot, 'platform-tools', executable),
      path.join(this.appRoot, 'scrcpy', executable),
      path.join(this.appRoot, 'bin', executable),
      path.join(this.appRoot, executable)
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        this.adbPath = candidate;
        return candidate;
      }
    }

    this.adbPath = 'adb';
    return this.adbPath;
  }

  spawnAdb(args, options = {}) {
    return spawn(this.getAdbPath(), args, {
      cwd: this.appRoot,
      windowsHide: true,
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
      env: process.env
    });
  }

  run(args, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15000;
    const maxBuffer = options.maxBuffer ?? 12 * 1024 * 1024;
    const allowNonZero = options.allowNonZero ?? false;

    return new Promise((resolve, reject) => {
      const child = this.spawnAdb(args, {
        stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
      });

      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutLength = 0;
      let stderrLength = 0;
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill('SIGTERM');
        reject(new AdbError(`ADB command timed out after ${timeoutMs}ms`, 'ADB_TIMEOUT', {
          args,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8')
        }));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdoutLength += chunk.length;
        if (stdoutLength <= maxBuffer) {
          stdoutChunks.push(chunk);
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrLength += chunk.length;
        if (stderrLength <= maxBuffer) {
          stderrChunks.push(chunk);
        }
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const code = error.code === 'ENOENT' ? 'ADB_MISSING' : 'ADB_SPAWN_FAILED';
        reject(new AdbError(
          code === 'ADB_MISSING'
            ? 'ADB binary was not found. Configure ANDROID_TV_CONTROLLER_ADB, add adb to PATH, or place it in platform-tools/.'
            : error.message,
          code,
          { cause: error, args }
        ));
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);

        const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

        if (code !== 0 && !allowNonZero) {
          reject(new AdbError(stderr || stdout || `ADB exited with code ${code}`, 'ADB_EXIT_NON_ZERO', {
            args,
            exitCode: code,
            stdout,
            stderr
          }));
          return;
        }

        resolve({ stdout, stderr, exitCode: code });
      });

      if (options.input) {
        child.stdin.end(options.input);
      }
    });
  }

  runBuffer(args, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15000;
    const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
    const allowNonZero = options.allowNonZero ?? false;
    const signal = options.signal;
    const abortError = () => new AdbError('ADB command cancelled.', 'ADB_ABORTED', { args });
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const child = this.spawnAdb(args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutLength = 0;
      let stderrLength = 0;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error, terminate = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (terminate) child.kill('SIGTERM');
        reject(error);
      };
      const onAbort = () => fail(abortError(), true);
      const timeout = setTimeout(() => {
        fail(new AdbError(`ADB command timed out after ${timeoutMs}ms`, 'ADB_TIMEOUT', {
          args,
          stderr: Buffer.concat(stderrChunks).toString('utf8')
        }), true);
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk) => {
        if (settled) return;
        stdoutLength += chunk.length;
        if (stdoutLength > maxBuffer) {
          fail(new AdbError('ADB binary output exceeded the capture limit.', 'ADB_OUTPUT_TOO_LARGE', { args }), true);
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr.on('data', (chunk) => {
        if (settled) return;
        stderrLength += chunk.length;
        if (stderrLength > maxBuffer) {
          fail(new AdbError('ADB error output exceeded the capture limit.', 'ADB_OUTPUT_TOO_LARGE', { args }), true);
          return;
        }
        stderrChunks.push(chunk);
      });

      child.on('error', (error) => {
        const code = error.code === 'ENOENT' ? 'ADB_MISSING' : 'ADB_SPAWN_FAILED';
        fail(new AdbError(
          code === 'ADB_MISSING'
            ? 'ADB binary was not found. Configure ANDROID_TV_CONTROLLER_ADB, add adb to PATH, or place it in platform-tools/.'
            : error.message,
          code,
          { cause: error, args }
        ));
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();

        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

        if (code !== 0 && !allowNonZero) {
          reject(new AdbError(stderr || `ADB exited with code ${code}`, 'ADB_EXIT_NON_ZERO', {
            args,
            exitCode: code,
            stdout,
            stderr
          }));
          return;
        }

        resolve({ stdout, stderr, exitCode: code });
      });
      // The signal may have changed while the process was being created.
      if (signal?.aborted) onAbort();
    });
  }

  async getDiagnostics() {
    try {
      const result = await this.run(['version'], { timeoutMs: 5000 });
      return {
        available: true,
        path: this.getAdbPath(),
        version: result.stdout.split(/\r?\n/)[0] || result.stdout
      };
    } catch (error) {
      return {
        available: false,
        path: this.getAdbPath(),
        error: error.message,
        code: error.code
      };
    }
  }

  async startServer() {
    return this.run(['start-server'], { timeoutMs: 10000 });
  }

  async resetServer() {
    const kill = await this.run(['kill-server'], {
      timeoutMs: 8000,
      allowNonZero: true
    }).catch((error) => ({
      stdout: '',
      stderr: error.message,
      exitCode: 1
    }));

    const start = await this.run(['start-server'], {
      timeoutMs: 15000,
      allowNonZero: true
    });
    const message = [kill.stdout, kill.stderr, start.stdout, start.stderr].filter(Boolean).join('\n');

    if (start.exitCode !== 0 || /failed|cannot|error/i.test(message)) {
      throw new AdbError(
        `ADB server reset failed.${message ? `\n${message}` : ''}`,
        'ADB_RESET_FAILED',
        {
          stdout: start.stdout,
          stderr: start.stderr
        }
      );
    }

    return {
      restarted: true,
      message: message || 'ADB server restarted.'
    };
  }

  async pair(host, port, code) {
    assertHost(host);
    assertPort(port);
    if (!String(code || '').trim()) {
      throw new AdbError('Pairing code is required.', 'PAIRING_CODE_REQUIRED');
    }

    const target = `${host}:${Number(port)}`;
    const result = await this.run(['pair', target, String(code).trim()], { timeoutMs: 45000 });
    return {
      target,
      paired: /success|paired/i.test(`${result.stdout}\n${result.stderr}`),
      message: [result.stdout, result.stderr].filter(Boolean).join('\n')
    };
  }

  async connect(host, port = 5555, options = {}) {
    assertHost(host);
    assertPort(port);
    const target = `${host}:${Number(port)}`;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(100, Math.min(30000, options.timeoutMs)) : 30000;
    const result = await this.run(['connect', target], { timeoutMs, allowNonZero: true });
    const message = [result.stdout, result.stderr].filter(Boolean).join('\n');

    if (/failed|unable|refused|cannot|error/i.test(message) || result.exitCode !== 0) {
      const hint = connectionHint(host, port, message);
      throw new AdbError(hint || message || `Unable to connect to ${target}`, 'ADB_CONNECT_FAILED', {
        stdout: result.stdout,
        stderr: result.stderr
      });
    }

    return {
      target,
      serial: target,
      connected: /connected|already connected/i.test(message),
      message
    };
  }

  async disconnect(serial) {
    assertSerial(serial);
    const result = await this.run(['disconnect', serial], { timeoutMs: 10000, allowNonZero: true });
    return {
      serial,
      message: [result.stdout, result.stderr].filter(Boolean).join('\n')
    };
  }

  async listDevices() {
    const result = await this.run(['devices', '-l'], { timeoutMs: 10000 });
    const lines = result.stdout.split(/\r?\n/).slice(1);

    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state, ...detailParts] = line.split(/\s+/);
        const details = {};

        for (const part of detailParts) {
          const index = part.indexOf(':');
          if (index > 0) {
            details[part.slice(0, index)] = part.slice(index + 1);
          }
        }

        return {
          id: `adb:${serial}`,
          source: 'adb',
          serial,
          state,
          authorized: state === 'device',
          unauthorized: state === 'unauthorized',
          offline: state === 'offline',
          model: details.model || '',
          product: details.product || '',
          device: details.device || '',
          transportId: details.transport_id || ''
        };
      });
  }

  async listMdnsServices() {
    const result = await this.run(['mdns', 'services'], {
      timeoutMs: 10000,
      allowNonZero: true
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    return parseAdbMdnsServices(output);
  }

  async getState(serial) {
    assertSerial(serial);
    const result = await this.run(['-s', serial, 'get-state'], { timeoutMs: 7000, allowNonZero: true });
    return (result.stdout || result.stderr || '').trim();
  }

  async shell(serial, commandParts, options = {}) {
    assertSerial(serial);
    if (!Array.isArray(commandParts) || commandParts.length === 0) {
      throw new AdbError('Shell command must be a non-empty argument array.', 'INVALID_SHELL_COMMAND');
    }

    return this.run(['-s', serial, 'shell', ...commandParts.map(String)], options);
  }

  async shellCommand(serial, command, options = {}) {
    assertSerial(serial);
    if (!command || typeof command !== 'string') {
      throw new AdbError('Shell command must be a string.', 'INVALID_SHELL_COMMAND');
    }

    return this.run(['-s', serial, 'shell', command], options);
  }

  async sendKey(serial, keyCode) {
    return this.queueInput(async () => {
      assertSerial(serial);
      if (!KEY_CODE_PATTERN.test(keyCode)) {
        throw new AdbError(`Invalid Android key code: ${keyCode}`, 'INVALID_KEY_CODE');
      }

      await this.shell(serial, ['input', 'keyevent', keyCode], { timeoutMs: 5000 });
      return { serial, keyCode };
    });
  }

  async tap(serial, x, y) {
    return this.queueInput(async () => {
      const point = normalizePoint(x, y);
      await this.shell(serial, ['input', 'tap', point.x, point.y], { timeoutMs: 5000 });
      return point;
    });
  }

  async swipe(serial, x1, y1, x2, y2, durationMs = 250) {
    return this.queueInput(async () => {
      const start = normalizePoint(x1, y1);
      const end = normalizePoint(x2, y2);
      const duration = clampInteger(durationMs, 16, 5000);

      await this.shell(serial, ['input', 'swipe', start.x, start.y, end.x, end.y, duration], {
        timeoutMs: 7000
      });

      return { x1: start.x, y1: start.y, x2: end.x, y2: end.y, durationMs: duration };
    });
  }

  async mouseMove(serial, x, y) {
    return this.queueInput(async () => {
      const point = normalizePoint(x, y);
      const result = await this.shell(serial, ['input', 'mouse', 'motionevent', 'MOVE', point.x, point.y], {
        timeoutMs: 3500,
        allowNonZero: true
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

      if (result.exitCode !== 0 || /unknown|invalid|error|usage/i.test(output)) {
        return {
          ...point,
          supported: false,
          message: output || 'This Android build did not accept mouse move events.'
        };
      }

      return {
        ...point,
        supported: true
      };
    });
  }

  queueInput(operation) {
    const task = this.inputQueue.catch(() => null).then(operation);
    this.inputQueue = task.catch(() => null);
    return task;
  }

  async sendText(serial, text) {
    assertSerial(serial);
    if (typeof text !== 'string' || text.length === 0) {
      throw new AdbError('Text cannot be empty.', 'EMPTY_TEXT');
    }

    const formatted = formatInputText(text);
    await this.shell(serial, ['input', 'text', formatted], { timeoutMs: 10000 });
    return { serial, length: text.length };
  }

  async captureScreenshot(serial, { signal } = {}) {
    assertSerial(serial);
    if (signal?.aborted) throw new AdbError('Screenshot cancelled.', 'ADB_ABORTED');

    let capture = this.screenshotCaptures.get(serial);
    if (!capture || capture.controller.signal.aborted) {
      capture = { controller: new AbortController(), users: 0, promise: null };
      const current = capture;
      const startedAt = Date.now();
      current.promise = this.runBuffer(['-s', serial, 'exec-out', 'screencap', '-p'], {
        timeoutMs: 12000,
        maxBuffer: 32 * 1024 * 1024,
        signal: current.controller.signal
      }).then((result) => {
        const dimensions = validateScreenshotPng(result.stdout);
        return {
          serial,
          png: result.stdout,
          bytes: result.stdout.length,
          captureMs: Date.now() - startedAt,
          ...dimensions
        };
      }).finally(() => {
        if (this.screenshotCaptures.get(serial) === current) this.screenshotCaptures.delete(serial);
      });
      this.screenshotCaptures.set(serial, current);
    }

    capture.users += 1;
    let onAbort;
    try {
      if (!signal) return await capture.promise;
      return await Promise.race([
        capture.promise,
        new Promise((_resolve, reject) => {
          onAbort = () => reject(new AdbError('Screenshot cancelled.', 'ADB_ABORTED'));
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        })
      ]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      capture.users -= 1;
      // Disconnecting a preview must not cancel a screenshot being saved by
      // another caller; stop the process only when nobody still needs it.
      if (capture.users === 0) capture.controller.abort();
    }
  }

  async cancelScreenshots() {
    const captures = [...this.screenshotCaptures.values()];
    for (const capture of captures) capture.controller.abort();
    await Promise.allSettled(captures.map((capture) => capture.promise));
  }

  async saveScreenshot(serial, outputDir) {
    assertSerial(serial);
    if (!outputDir || typeof outputDir !== 'string') {
      throw new AdbError('Screenshot output directory is required.', 'INVALID_OUTPUT_DIR');
    }

    const result = await this.captureScreenshot(serial);

    fs.mkdirSync(outputDir, { recursive: true });
    const fileName = `android-tv-${safeTimestamp()}.png`;
    const outputPath = path.join(outputDir, fileName);
    fs.writeFileSync(outputPath, result.png);

    return {
      path: outputPath,
      bytes: result.bytes,
      captureMs: result.captureMs,
      width: result.width,
      height: result.height
    };
  }

  async wake(serial) {
    await this.sendKey(serial, 'KEYCODE_WAKEUP');
    return { serial, action: 'wake' };
  }

  async sleep(serial) {
    await this.sendKey(serial, 'KEYCODE_SLEEP');
    return { serial, action: 'sleep' };
  }

  async reboot(serial) {
    assertSerial(serial);
    await this.run(['-s', serial, 'reboot'], { timeoutMs: 10000, allowNonZero: true });
    return { serial, action: 'reboot' };
  }

  async openSettings(serial, target = 'settings') {
    const actions = {
      settings: 'android.settings.SETTINGS',
      wifi: 'android.settings.WIFI_SETTINGS',
      apps: 'android.settings.APPLICATION_SETTINGS',
      developer: 'com.android.settings.APPLICATION_DEVELOPMENT_SETTINGS'
    };
    const action = actions[target] || actions.settings;

    const result = await this.shell(serial, ['am', 'start', '-a', action], {
      timeoutMs: 10000,
      allowNonZero: true
    });

    if (/Error|Exception|not found|unable/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new AdbError(result.stderr || result.stdout || `Unable to open ${target} settings.`, 'OPEN_SETTINGS_FAILED', {
        stdout: result.stdout,
        stderr: result.stderr
      });
    }

    return { serial, target, action };
  }

  async setAnimationScale(serial, enabled) {
    assertSerial(serial);
    const value = enabled ? '1.0' : '0.0';
    const keys = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];

    for (const key of keys) {
      await this.shell(serial, ['settings', 'put', 'global', key, value], { timeoutMs: 5000 });
    }

    return { serial, enabled, value };
  }

  async forceStopApp(serial, packageName) {
    assertSerial(serial);
    assertPackageName(packageName);
    await this.shell(serial, ['am', 'force-stop', packageName], { timeoutMs: 8000 });
    return { serial, packageName, action: 'force-stop' };
  }

  async clearAppData(serial, packageName) {
    assertSerial(serial);
    assertPackageName(packageName);
    const result = await this.shell(serial, ['pm', 'clear', packageName], {
      timeoutMs: 20000,
      allowNonZero: true
    });
    if (/failed|exception|not found/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new AdbError(result.stderr || result.stdout || `Unable to clear ${packageName}.`, 'CLEAR_APP_FAILED', {
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    return { serial, packageName, action: 'clear-data', message: result.stdout || result.stderr };
  }

  async setPackageEnabled(serial, packageName, enabled) {
    assertSerial(serial);
    assertPackageName(packageName);
    const command = enabled
      ? ['pm', 'enable', packageName]
      : ['pm', 'disable-user', '--user', '0', packageName];
    const result = await this.shell(serial, command, { timeoutMs: 12000, allowNonZero: true });

    if (/failed|exception|not allowed|security/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new AdbError(
        result.stderr || result.stdout || `Unable to ${enabled ? 'enable' : 'disable'} ${packageName}.`,
        'PACKAGE_STATE_FAILED',
        { stdout: result.stdout, stderr: result.stderr }
      );
    }

    return {
      serial,
      packageName,
      enabled,
      message: result.stdout || result.stderr
    };
  }

  async uninstallForUser(serial, packageName) {
    assertSerial(serial);
    assertPackageName(packageName);
    const result = await this.shell(serial, ['pm', 'uninstall', '--user', '0', packageName], {
      timeoutMs: 30000,
      allowNonZero: true
    });

    if (/failure|failed|exception/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new AdbError(result.stderr || result.stdout || `Unable to remove ${packageName}.`, 'UNINSTALL_FAILED', {
        stdout: result.stdout,
        stderr: result.stderr
      });
    }

    return {
      serial,
      packageName,
      action: 'uninstall-user',
      message: result.stdout || result.stderr
    };
  }

  async installApk(serial, apkPath) {
    assertSerial(serial);
    if (!apkPath || typeof apkPath !== 'string' || path.extname(apkPath).toLowerCase() !== '.apk') {
      throw new AdbError('Select a valid .apk file.', 'INVALID_APK');
    }
    if (!fs.existsSync(apkPath)) {
      throw new AdbError(`APK file was not found: ${apkPath}`, 'APK_NOT_FOUND');
    }

    const result = await this.run(['-s', serial, 'install', '-r', '-d', apkPath], {
      timeoutMs: 120000,
      allowNonZero: true
    });

    if (/failure|failed|exception/i.test(`${result.stdout}\n${result.stderr}`) || result.exitCode !== 0) {
      throw new AdbError(result.stderr || result.stdout || 'APK install failed.', 'APK_INSTALL_FAILED', {
        stdout: result.stdout,
        stderr: result.stderr
      });
    }

    return {
      serial,
      apkPath,
      message: result.stdout || result.stderr || 'Success'
    };
  }

  async listHomeLaunchers(serial) {
    assertSerial(serial);
    const result = await this.shell(serial, [
      'cmd',
      'package',
      'query-intent-activities',
      '--brief',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.HOME'
    ], { timeoutMs: 20000, allowNonZero: true });

    return parseActivityQuery(result.stdout)
      .map((launcher) => ({
        ...launcher,
        component: `${launcher.packageName}/${launcher.activity}`,
        name: commonAppName(launcher.packageName) || humanizePackageName(launcher.packageName),
        icon: makeFallbackIcon(launcher.packageName)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getCurrentHomeActivity(serial) {
    assertSerial(serial);
    const result = await this.shell(serial, [
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.HOME'
    ], { timeoutMs: 12000, allowNonZero: true });

    const apps = parseActivityQuery(result.stdout);
    if (apps.length > 0) {
      return {
        ...apps[0],
        component: `${apps[0].packageName}/${apps[0].activity}`,
        name: commonAppName(apps[0].packageName) || humanizePackageName(apps[0].packageName)
      };
    }

    return {
      packageName: '',
      activity: '',
      component: '',
      name: '',
      raw: result.stdout || result.stderr
    };
  }

  async setHomeActivity(serial, component) {
    assertSerial(serial);
    assertComponentName(component);
    const result = await this.shell(serial, [
      'cmd',
      'package',
      'set-home-activity',
      '--user',
      '0',
      component
    ], { timeoutMs: 15000, allowNonZero: true });

    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (/error|exception|failed|security|unknown|not allowed/i.test(output) || result.exitCode !== 0) {
      await this.openSettings(serial, 'apps').catch(() => null);
      return {
        serial,
        component,
        applied: false,
        fallbackOpened: true,
        message: output || 'The TV blocked direct launcher selection. Opened app settings as fallback.'
      };
    }

    return {
      serial,
      component,
      applied: true,
      fallbackOpened: false,
      message: output || 'Launcher selected'
    };
  }

  async createDebloatBackup(serial, outputDir) {
    assertSerial(serial);
    if (!outputDir || typeof outputDir !== 'string') {
      throw new AdbError('Backup output directory is required.', 'INVALID_OUTPUT_DIR');
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const [deviceInfo, allPackages, disabledPackages, homeLaunchers, currentHome] = await Promise.all([
      this.getDeviceInfo(serial),
      this.getPackages(serial, 'all'),
      this.getPackages(serial, 'disabled'),
      this.listHomeLaunchers(serial).catch(() => []),
      this.getCurrentHomeActivity(serial).catch(() => null)
    ]);

    const backup = {
      createdAt: new Date().toISOString(),
      serial,
      deviceInfo,
      allPackages,
      disabledPackages,
      homeLaunchers,
      currentHome
    };
    const fileName = `debloat-backup-${safeTimestamp()}.json`;
    const outputPath = path.join(outputDir, fileName);
    fs.writeFileSync(outputPath, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');

    return {
      path: outputPath,
      packageCount: allPackages.length,
      disabledCount: disabledPackages.length,
      backup
    };
  }

  async restoreDisabledFromBackup(serial, backupPath) {
    assertSerial(serial);
    if (!backupPath || typeof backupPath !== 'string' || !fs.existsSync(backupPath)) {
      throw new AdbError('Backup file was not found.', 'BACKUP_NOT_FOUND');
    }

    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const packages = Array.isArray(backup.disabledPackages)
      ? backup.disabledPackages.map((item) => item.packageName || item).filter(Boolean)
      : [];
    const results = [];

    for (const packageName of packages) {
      try {
        results.push(await this.setPackageEnabled(serial, packageName, true));
      } catch (error) {
        results.push({ packageName, enabled: false, error: error.message });
      }
    }

    return {
      serial,
      backupPath,
      attempted: packages.length,
      results
    };
  }

  async getPackages(serial, scope = 'thirdParty') {
    assertSerial(serial);
    const args = ['pm', 'list', 'packages'];
    if (scope === 'thirdParty') {
      args.push('-3');
    } else if (scope === 'system') {
      args.push('-s');
    } else if (scope === 'disabled') {
      args.push('-d');
    }

    const result = await this.shell(serial, args, { timeoutMs: 20000 });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/^package:/, '').trim())
      .filter(Boolean)
      .map((packageName) => ({
        packageName,
        name: commonAppName(packageName) || humanizePackageName(packageName)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getDisplaySize(serial) {
    const result = await this.shell(serial, ['wm', 'size'], { timeoutMs: 5000 });
    const override = result.stdout.match(/Override size:\s*(\d+)x(\d+)/i);
    const physical = result.stdout.match(/Physical size:\s*(\d+)x(\d+)/i);
    const match = override || physical;

    if (!match) {
      return { width: 1920, height: 1080, raw: result.stdout };
    }

    return {
      width: Number(match[1]),
      height: Number(match[2]),
      raw: result.stdout
    };
  }

  async getDeviceInfo(serial) {
    assertSerial(serial);
    const [state, size, model, brand, release, sdk] = await Promise.all([
      this.getState(serial).catch((error) => `error:${error.code || error.message}`),
      this.getDisplaySize(serial).catch(() => ({ width: 1920, height: 1080, raw: '' })),
      this.shell(serial, ['getprop', 'ro.product.model'], { timeoutMs: 5000 }).then((r) => r.stdout).catch(() => ''),
      this.shell(serial, ['getprop', 'ro.product.brand'], { timeoutMs: 5000 }).then((r) => r.stdout).catch(() => ''),
      this.shell(serial, ['getprop', 'ro.build.version.release'], { timeoutMs: 5000 }).then((r) => r.stdout).catch(() => ''),
      this.shell(serial, ['getprop', 'ro.build.version.sdk'], { timeoutMs: 5000 }).then((r) => r.stdout).catch(() => '')
    ]);

    return {
      serial,
      state,
      display: size,
      model,
      brand,
      androidRelease: release,
      sdk
    };
  }

  async listLeanbackApps(serial) {
    assertSerial(serial);
    const command = [
      'cmd',
      'package',
      'query-intent-activities',
      '--brief',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LEANBACK_LAUNCHER'
    ];

    let result = await this.shell(serial, command, { timeoutMs: 20000, allowNonZero: true });
    let apps = parseActivityQuery(result.stdout);

    if (apps.length === 0) {
      result = await this.shell(serial, ['pm', 'list', 'packages'], { timeoutMs: 20000 });
      apps = result.stdout
        .split(/\r?\n/)
        .map((line) => line.replace(/^package:/, '').trim())
        .filter(Boolean)
        .map((packageName) => ({ packageName, activity: '' }));
    }

    return apps
      .map((app) => ({
        ...app,
        name: commonAppName(app.packageName) || humanizePackageName(app.packageName),
        icon: makeFallbackIcon(app.packageName)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async launchApp(serial, packageName, activity = '') {
    assertSerial(serial);
    assertPackageName(packageName);

    if (activity) {
      const component = `${packageName}/${activity}`;
      const result = await this.shell(serial, ['am', 'start', '-n', component], {
        timeoutMs: 10000,
        allowNonZero: true
      });

      if (!/Error|Exception|not found|does not exist/i.test(`${result.stdout}\n${result.stderr}`)) {
        return { packageName, activity, launched: true, method: 'am start' };
      }
    }

    await this.shell(serial, ['monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], {
      timeoutMs: 10000
    });

    return { packageName, activity: '', launched: true, method: 'monkey' };
  }
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function validateScreenshotPng(png) {
  const invalid = () => new AdbError('TV returned an incomplete or invalid PNG screenshot.', 'SCREENSHOT_INVALID');
  if (!Buffer.isBuffer(png) || png.length === 0) {
    throw new AdbError('TV returned no screenshot image data.', 'SCREENSHOT_EMPTY');
  }
  if (png.length < 45 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw invalid();

  let width;
  let height;
  let imageBytes = 0;
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) throw invalid();
    const type = png.toString('ascii', offset + 4, offset + 8);
    let crc = 0xffffffff;
    for (let cursor = offset + 4; cursor < end - 4; cursor += 1) {
      crc = (crc >>> 8) ^ PNG_CRC_TABLE[(crc ^ png[cursor]) & 0xff];
    }
    if (((crc ^ 0xffffffff) >>> 0) !== png.readUInt32BE(end - 4)) throw invalid();

    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) throw invalid();
      width = png.readUInt32BE(offset + 8);
      height = png.readUInt32BE(offset + 12);
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw invalid();
    } else if (type === 'IHDR') {
      throw invalid();
    }
    if (type === 'IDAT') imageBytes += length;
    if (type === 'IEND') {
      if (length !== 0 || end !== png.length || imageBytes === 0) throw invalid();
      return { width, height };
    }
    offset = end;
  }
  throw invalid();
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function assertHost(host) {
  if (!host || typeof host !== 'string' || /[\s/\\]/.test(host)) {
    throw new AdbError(`Invalid host: ${host}`, 'INVALID_HOST');
  }
}

function assertPort(port) {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
    throw new AdbError(`Invalid port: ${port}`, 'INVALID_PORT');
  }
}

function assertSerial(serial) {
  if (!serial || typeof serial !== 'string' || /[\r\n]/.test(serial)) {
    throw new AdbError('A valid device serial is required.', 'INVALID_SERIAL');
  }
}

function assertPackageName(packageName) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(packageName)) {
    throw new AdbError(`Invalid package name: ${packageName}`, 'INVALID_PACKAGE');
  }
}

function assertComponentName(component) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+\/[a-zA-Z0-9_.$]+$/.test(component)) {
    throw new AdbError(`Invalid component name: ${component}`, 'INVALID_COMPONENT');
  }
}

function normalizePoint(x, y) {
  return {
    x: clampInteger(x, 0, 100000),
    y: clampInteger(y, 0, 100000)
  };
}

function clampInteger(value, min, max) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, numeric));
}

function formatInputText(text) {
  return text
    .replace(/%/g, '%25')
    .replace(/\s/g, '%s')
    .replace(/([\\&|;<>()$`"'\*\?\[\]#~={}!])/g, '\\$1');
}

function parseActivityQuery(stdout) {
  const seen = new Set();
  const apps = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('priority=') || trimmed.startsWith('No activities')) {
      continue;
    }

    const match = trimmed.match(/([a-zA-Z][\w]*(?:\.[\w]+)+)\/([^\s]+)/);
    if (!match) {
      continue;
    }

    const packageName = match[1];
    const activity = match[2];
    const key = `${packageName}/${activity}`;
    if (!seen.has(key)) {
      seen.add(key);
      apps.push({ packageName, activity });
    }
  }

  return apps;
}

function parseAdbMdnsServices(output) {
  const devices = new Map();

  for (const line of String(output || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^List of discovered/i.test(trimmed) || /daemon/i.test(trimmed)) {
      continue;
    }

    const match = trimmed.match(/^(.+?)\s+(_adb-tls-(?:connect|pairing)\._tcp\.?)\s+(.+):(\d+)$/i);
    if (!match) {
      continue;
    }

    const instance = match[1].trim();
    const type = match[2].replace(/\.$/, '').toLowerCase();
    const host = match[3].replace(/^\[|\]$/g, '');
    const port = Number(match[4]);
    if (!host || !Number.isInteger(port)) {
      continue;
    }

    const key = host;
    const current = devices.get(key) || {
      id: `adb-mdns:${host}`,
      source: 'adb-mdns',
      name: cleanMdnsInstance(instance),
      host,
      address: host,
      services: {},
      lastSeen: Date.now()
    };

    if (type.includes('connect')) {
      current.services.adbConnect = { type, instance, port, txt: {} };
    } else if (type.includes('pairing')) {
      current.services.adbPairing = { type, instance, port, txt: {} };
    }

    devices.set(key, current);
  }

  return Array.from(devices.values())
    .sort((a, b) => a.name.localeCompare(b.name));
}

function cleanMdnsInstance(instance) {
  return String(instance || 'Android TV')
    .replace(/\\032/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function connectionHint(host, port, message) {
  const text = String(message || '');
  if (Number(port) === 5555 && /refused|10061|actively refused/i.test(text)) {
    return [
      `Port 5555 is closed on ${host}.`,
      'Modern Android/Google TV Wireless debugging usually uses a random ADB connect port, not 5555.',
      'Open Wireless debugging on the TV, use the "IP address & Port" shown there for IP Connect, or use "Pair device with pairing code" first and then scan again.'
    ].join(' ');
  }

  if (/refused|10061|actively refused/i.test(text)) {
    return [
      `The TV refused ${host}:${port}.`,
      'Check that Wireless debugging is still enabled and that this is the ADB connect port, not the pairing port.'
    ].join(' ');
  }

  return '';
}

function humanizePackageName(packageName) {
  const lastMeaningfulPart = packageName
    .split('.')
    .filter((part) => !['android', 'google', 'com', 'tv', 'leanback', 'client', 'app'].includes(part))
    .pop() || packageName;

  return lastMeaningfulPart
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function commonAppName(packageName) {
  const known = new Map([
    ['com.google.android.youtube.tv', 'YouTube'],
    ['com.google.android.youtube.tvmusic', 'YouTube Music'],
    ['com.google.android.videos', 'Google TV'],
    ['com.google.android.apps.tv.launcherx', 'Google TV Home'],
    ['com.netflix.ninja', 'Netflix'],
    ['com.amazon.amazonvideo.livingroom', 'Prime Video'],
    ['com.disney.disneyplus', 'Disney+'],
    ['com.hulu.livingroomplus', 'Hulu'],
    ['com.hbo.hbonow', 'Max'],
    ['com.wbd.stream', 'Max'],
    ['com.plexapp.android', 'Plex'],
    ['org.xbmc.kodi', 'Kodi'],
    ['org.videolan.vlc', 'VLC'],
    ['com.spotify.tv.android', 'Spotify'],
    ['com.apple.atve.androidtv.appletv', 'Apple TV']
  ]);

  return known.get(packageName);
}

function makeFallbackIcon(packageName) {
  const name = commonAppName(packageName) || humanizePackageName(packageName);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');

  let hash = 0;
  for (const char of packageName) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  const hue = hash % 360;
  return {
    type: 'fallback',
    text: initials || packageName[0].toUpperCase(),
    background: `hsl(${hue} 74% 38%)`
  };
}

module.exports = AdbWrapper;
module.exports.AdbError = AdbError;
