const EventEmitter = require('events');

const BASE_DELAY_MS = 1200;
const MAX_DELAY_MS = 30000;
const HEALTHY_DELAY_MS = 3000;

class HeartbeatWorker extends EventEmitter {
  constructor({ adb, logger = console } = {}) {
    super();
    this.adb = adb;
    this.logger = logger;
    this.device = null;
    this.timer = null;
    this.stopped = true;
    this.failures = 0;
  }

  start(device) {
    this.stop();
    this.device = normalizeDevice(device);
    this.stopped = false;
    this.failures = 0;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  schedule(delay) {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => this.tick(), delay);
  }

  async tick() {
    if (this.stopped || !this.device?.serial) {
      return;
    }

    const device = this.device;
    try {
      const state = await this.adb.getState(device.serial);
      if (this.stopped || this.device !== device) return;
      if (state === 'device') {
        this.failures = 0;
        this.emit('status', {
          serial: this.device.serial,
          state: 'connected',
          delayMs: HEALTHY_DELAY_MS,
          at: Date.now()
        });
        this.schedule(HEALTHY_DELAY_MS);
        return;
      }

      throw new Error(`Device state is ${state || 'unknown'}`);
    } catch (error) {
      if (this.stopped || this.device !== device) return;
      this.failures += 1;
      const delayMs = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.failures, 6));
      this.emit('status', {
        serial: this.device.serial,
        state: 'reconnecting',
        failures: this.failures,
        delayMs,
        message: error.message,
        at: Date.now()
      });

      await this.tryReconnect();
      this.schedule(delayMs + Math.round(Math.random() * 500));
    }
  }

  async tryReconnect() {
    if (!this.device.host && !this.device.address) {
      return;
    }

    const host = this.device.address || this.device.host;
    const port = this.device.port || 5555;

    try {
      const result = await this.adb.connect(host, port);
      this.device.serial = result.serial;
      this.emit('status', {
        serial: this.device.serial,
        state: 'reconnected',
        failures: this.failures,
        at: Date.now()
      });
    } catch (error) {
      this.emit('error', error);
    }
  }
}

function normalizeDevice(device) {
  const services = device?.services || {};
  const adbConnect = services.adbConnect || {};
  return {
    serial: device?.serial,
    host: device?.host,
    address: device?.address,
    port: device?.port || adbConnect.port || serialPort(device?.serial)
  };
}

function serialPort(serial) {
  const match = String(serial || '').match(/:(\d+)$/);
  return match ? Number(match[1]) : 5555;
}

module.exports = HeartbeatWorker;
