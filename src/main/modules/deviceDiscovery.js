const dgram = require('dgram');
const EventEmitter = require('events');
const os = require('os');
const { isIPv4 } = require('net');

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const QUERY_INTERVAL_MS = 5000;
const DEVICE_TTL_MS = 45000;

const SERVICE_TYPES = [
  '_adb-tls-connect._tcp.local',
  '_adb-tls-pairing._tcp.local',
  '_androidtvremote2._tcp.local',
  '_androidtvremote._tcp.local',
  '_googlecast._tcp.local'
];

class DeviceDiscovery extends EventEmitter {
  constructor({ adb, logger = console } = {}) {
    super();
    this.adb = adb;
    this.logger = logger;
    this.socket = null;
    this.timer = null;
    this.expireTimer = null;
    this.devices = new Map();
    this.serviceRecords = new Map();
    this.hostAddresses = new Map();
    this.multicastInterfaces = new Set();
    this.querying = false;
  }

  async start() {
    if (this.socket) {
      this.query();
      return this.getDevices();
    }

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('message', (message) => {
      try {
        this.processPacket(message);
      } catch (error) {
        this.emit('error', error);
      }
    });

    this.socket.on('error', (error) => {
      this.emit('error', error);
    });

    await this.bindSocket();

    this.query();
    this.timer = setInterval(() => this.query(), QUERY_INTERVAL_MS);
    this.expireTimer = setInterval(() => this.expireOldDevices(), QUERY_INTERVAL_MS);
    return this.getDevices();
  }

  bindSocket() {
    return new Promise((resolve) => {
      let attemptedEphemeralFallback = false;

      const finishListening = () => {
        this.socket.off('error', handleBindError);
        try {
          this.socket.setMulticastTTL(255);
          this.socket.setMulticastLoopback(false);
          this.refreshMulticastInterfaces();
        } catch (error) {
          this.emit('error', error);
        }
        resolve();
      };

      const handleBindError = (error) => {
        this.socket.off('listening', finishListening);
        if (attemptedEphemeralFallback) {
          this.emit('error', error);
          resolve();
          return;
        }

        attemptedEphemeralFallback = true;
        this.emit('error', Object.assign(
          new Error('mDNS port 5353 is unavailable; falling back to an ephemeral query socket.'),
          { code: 'MDNS_PORT_UNAVAILABLE', cause: error }
        ));

        try {
          this.socket.close(() => {
            this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            this.socket.on('message', (message) => {
              try {
                this.processPacket(message);
              } catch (parseError) {
                this.emit('error', parseError);
              }
            });
            this.socket.on('error', (socketError) => this.emit('error', socketError));
            this.socket.once('listening', finishListening);
            this.socket.once('error', handleBindError);
            this.socket.bind(0);
          });
        } catch (closeError) {
          this.emit('error', closeError);
          resolve();
        }
      };

      this.socket.once('listening', finishListening);
      this.socket.once('error', handleBindError);
      this.socket.bind(MDNS_PORT);
    });
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.expireTimer) {
      clearInterval(this.expireTimer);
      this.expireTimer = null;
    }
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      this.multicastInterfaces.clear();
      await new Promise((resolve) => socket.close(resolve));
    }
  }

  refreshMulticastInterfaces() {
    const addresses = new Set(Object.values(os.networkInterfaces()).flat()
      .filter((entry) => entry && !entry.internal && isIPv4(entry.address) && entry.address !== '0.0.0.0')
      .map((entry) => entry.address));

    for (const address of this.multicastInterfaces) {
      if (!addresses.has(address)) {
        try {
          this.socket.dropMembership(MDNS_ADDRESS, address);
        } catch (_) {
          // A disconnected adapter can already have dropped its membership.
        }
        this.multicastInterfaces.delete(address);
      }
    }

    for (const address of addresses) {
      if (this.multicastInterfaces.has(address)) continue;
      try {
        this.socket.addMembership(MDNS_ADDRESS, address);
        this.multicastInterfaces.add(address);
      } catch (error) {
        // A VPN/virtual adapter may not support multicast; keep the LAN usable.
        this.logger.warn(`mDNS membership unavailable on ${address}: ${error.message}`);
      }
    }
  }

  async query() {
    if (!this.socket || this.querying) {
      return;
    }

    const socket = this.socket;
    const packet = buildPtrQuery(SERVICE_TYPES);
    this.querying = true;
    try {
      this.refreshMulticastInterfaces();
      const interfaces = this.multicastInterfaces.size ? [...this.multicastInterfaces] : ['0.0.0.0'];
      for (const address of interfaces) {
        if (this.socket !== socket) break;
        try {
          socket.setMulticastInterface(address);
          // send() resolves the destination asynchronously. Wait for each send
          // before switching interfaces, or all queries can use the last NIC.
          await new Promise((resolve, reject) => {
            socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDRESS, (error) => {
              if (error) reject(error);
              else resolve();
            });
          });
        } catch (error) {
          if (this.socket === socket) this.emit('error', error);
        }
      }
    } finally {
      this.querying = false;
    }
  }

  getDevices() {
    return Array.from(this.devices.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((device) => ({ ...device, services: { ...device.services } }));
  }

  processPacket(packet) {
    const records = parseDnsPacket(packet);
    const now = Date.now();
    let changed = false;

    for (const record of records) {
      if (record.type === 'A' || record.type === 'AAAA') {
        const host = normalizeName(record.name);
        const existing = this.hostAddresses.get(host) || {};
        this.hostAddresses.set(host, {
          ...existing,
          [record.type === 'A' ? 'ipv4' : 'ipv6']: record.address,
          lastSeen: now
        });
        changed = true;
      }
    }

    for (const record of records) {
      if (record.type === 'PTR' && SERVICE_TYPES.includes(normalizeName(record.name))) {
        const instance = normalizeName(record.ptr);
        this.serviceRecords.set(instance, {
          ...this.serviceRecords.get(instance),
          type: normalizeName(record.name),
          lastSeen: now
        });
        changed = true;
      } else if (record.type === 'SRV') {
        const existing = this.serviceRecords.get(normalizeName(record.name)) || {};
        this.serviceRecords.set(normalizeName(record.name), {
          ...existing,
          port: record.port,
          target: normalizeName(record.target),
          lastSeen: now
        });
        changed = true;
      } else if (record.type === 'TXT') {
        const existing = this.serviceRecords.get(normalizeName(record.name)) || {};
        this.serviceRecords.set(normalizeName(record.name), {
          ...existing,
          txt: record.txt,
          lastSeen: now
        });
        changed = true;
      }
    }

    if (changed) this.rebuildDevices(now);
  }

  rebuildDevices(now = Date.now()) {
    const devices = new Map();
    // Reconcile cached PTR, SRV, TXT and address records after every response:
    // TVs may publish these in separate packets or in a different order.
    for (const [instance, service] of this.serviceRecords) {
      const serviceType = service.type;
      if (!serviceType || now - service.lastSeen > DEVICE_TTL_MS) continue;

      const host = service.target || '';
      const addresses = this.hostAddresses.get(host);
      const address = addresses ? (addresses.ipv4 || addresses.ipv6 || '') : '';
      const deviceKey = address || host || instance;
      const displayName = cleanInstanceName(instance, serviceType);
      const current = devices.get(deviceKey) || {
        id: `mdns:${deviceKey}`,
        source: 'mdns',
        name: displayName,
        host,
        address,
        services: {},
        lastSeen: service.lastSeen
      };

      current.name = pickBetterName(current.name, displayName);
      current.host = host || current.host;
      current.address = address || current.address;
      current.lastSeen = Math.max(current.lastSeen, service.lastSeen);
      current.services[serviceName(serviceType)] = {
        type: serviceType,
        instance,
        port: service.port || defaultPortFor(serviceType),
        txt: service.txt || {}
      };

      devices.set(deviceKey, current);
    }

    this.devices = devices;
    this.emit('devices', this.getDevices());
  }

  expireOldDevices() {
    const now = Date.now();
    let changed = false;

    for (const cache of [this.serviceRecords, this.hostAddresses]) {
      for (const [key, record] of cache) {
        if (now - record.lastSeen > DEVICE_TTL_MS) {
          cache.delete(key);
          changed = true;
        }
      }
    }

    if (changed) {
      this.rebuildDevices(now);
    }
  }
}

function buildPtrQuery(names) {
  const encodedNames = names.map(encodeDnsName);
  const length = 12 + encodedNames.reduce((sum, name) => sum + name.length + 4, 0);
  const buffer = Buffer.alloc(length);
  let offset = 0;

  buffer.writeUInt16BE(0, offset); offset += 2;
  buffer.writeUInt16BE(0, offset); offset += 2;
  buffer.writeUInt16BE(names.length, offset); offset += 2;
  buffer.writeUInt16BE(0, offset); offset += 2;
  buffer.writeUInt16BE(0, offset); offset += 2;
  buffer.writeUInt16BE(0, offset); offset += 2;

  for (const encoded of encodedNames) {
    encoded.copy(buffer, offset);
    offset += encoded.length;
    buffer.writeUInt16BE(12, offset); offset += 2;
    buffer.writeUInt16BE(1, offset); offset += 2;
  }

  return buffer;
}

function encodeDnsName(name) {
  const labels = normalizeName(name).split('.');
  const parts = [];

  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([bytes.length]));
    parts.push(bytes);
  }
  parts.push(Buffer.from([0]));

  return Buffer.concat(parts);
}

function parseDnsPacket(packet) {
  if (packet.length < 12) {
    return [];
  }

  const qd = packet.readUInt16BE(4);
  const an = packet.readUInt16BE(6);
  const ns = packet.readUInt16BE(8);
  const ar = packet.readUInt16BE(10);
  let offset = 12;

  for (let i = 0; i < qd; i += 1) {
    const name = readName(packet, offset);
    offset = name.nextOffset + 4;
    if (offset > packet.length) {
      return [];
    }
  }

  const records = [];
  const total = an + ns + ar;

  for (let i = 0; i < total && offset < packet.length; i += 1) {
    const parsedName = readName(packet, offset);
    offset = parsedName.nextOffset;
    if (offset + 10 > packet.length) {
      break;
    }

    const type = packet.readUInt16BE(offset); offset += 2;
    const klass = packet.readUInt16BE(offset); offset += 2;
    const ttl = packet.readUInt32BE(offset); offset += 4;
    const rdLength = packet.readUInt16BE(offset); offset += 2;
    const rDataOffset = offset;
    const end = offset + rdLength;

    if (end > packet.length) {
      break;
    }

    const base = {
      name: normalizeName(parsedName.name),
      klass,
      ttl
    };

    if (type === 12) {
      records.push({ ...base, type: 'PTR', ptr: normalizeName(readName(packet, rDataOffset).name) });
    } else if (type === 33 && rdLength >= 6) {
      const port = packet.readUInt16BE(rDataOffset + 4);
      const target = readName(packet, rDataOffset + 6).name;
      records.push({ ...base, type: 'SRV', port, target });
    } else if (type === 1 && rdLength === 4) {
      records.push({ ...base, type: 'A', address: Array.from(packet.slice(rDataOffset, end)).join('.') });
    } else if (type === 28 && rdLength === 16) {
      const chunks = [];
      for (let cursor = rDataOffset; cursor < end; cursor += 2) {
        chunks.push(packet.readUInt16BE(cursor).toString(16));
      }
      records.push({ ...base, type: 'AAAA', address: chunks.join(':') });
    } else if (type === 16) {
      records.push({ ...base, type: 'TXT', txt: parseTxt(packet.slice(rDataOffset, end)) });
    }

    offset = end;
  }

  return records;
}

function readName(packet, offset, depth = 0) {
  if (depth > 10) {
    throw new Error('mDNS name compression loop detected');
  }

  const labels = [];
  let cursor = offset;
  let jumped = false;
  let nextOffset = offset;

  while (cursor < packet.length) {
    const length = packet[cursor];

    if (length === 0) {
      cursor += 1;
      if (!jumped) {
        nextOffset = cursor;
      }
      break;
    }

    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | packet[cursor + 1];
      const pointed = readName(packet, pointer, depth + 1);
      labels.push(pointed.name);
      cursor += 2;
      if (!jumped) {
        nextOffset = cursor;
      }
      jumped = true;
      break;
    }

    const start = cursor + 1;
    const end = start + length;
    labels.push(packet.slice(start, end).toString('utf8'));
    cursor = end;
    if (!jumped) {
      nextOffset = cursor;
    }
  }

  return {
    name: labels.filter(Boolean).join('.'),
    nextOffset
  };
}

function parseTxt(buffer) {
  const txt = {};
  let offset = 0;

  while (offset < buffer.length) {
    const length = buffer[offset];
    offset += 1;
    const value = buffer.slice(offset, offset + length).toString('utf8');
    offset += length;
    const separator = value.indexOf('=');
    if (separator >= 0) {
      txt[value.slice(0, separator)] = value.slice(separator + 1);
    } else if (value) {
      txt[value] = true;
    }
  }

  return txt;
}

function normalizeName(name) {
  return String(name || '').replace(/\.$/, '').toLowerCase();
}

function cleanInstanceName(instance, serviceType) {
  const suffix = `.${serviceType}`;
  const clean = instance.endsWith(suffix) ? instance.slice(0, -suffix.length) : instance;
  return clean
    .replace(/\\032/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pickBetterName(current, candidate) {
  if (!current || /^android|^tv|^unknown/i.test(current)) {
    return candidate || current;
  }
  return current;
}

function serviceName(serviceType) {
  if (serviceType.includes('adb-tls-connect')) {
    return 'adbConnect';
  }
  if (serviceType.includes('adb-tls-pairing')) {
    return 'adbPairing';
  }
  if (serviceType.includes('androidtvremote')) {
    return 'remote';
  }
  if (serviceType.includes('googlecast')) {
    return 'cast';
  }
  return 'unknown';
}

function defaultPortFor(serviceType) {
  if (serviceType.includes('adb-tls-connect')) {
    return 5555;
  }
  if (serviceType.includes('androidtvremote2')) {
    return 6467;
  }
  if (serviceType.includes('androidtvremote')) {
    return 6466;
  }
  return null;
}

module.exports = DeviceDiscovery;
