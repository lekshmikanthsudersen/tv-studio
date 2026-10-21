const dgram = require('dgram');
const os = require('os');
const { isIPv4 } = require('net');

const LIMITED_BROADCAST = '255.255.255.255';
const MAX_DESTINATIONS = 64;

function normalizeMacAddress(value) {
  if (typeof value !== 'string') throw new Error('Enter the TV network adapter MAC address.');
  const mac = value.trim();
  if (!/^(?:[\da-f]{12}|(?:[\da-f]{2}:){5}[\da-f]{2}|(?:[\da-f]{2}-){5}[\da-f]{2})$/i.test(mac)) {
    throw new Error('Use a MAC address such as 00:11:22:33:44:55.');
  }
  const bytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
  if ((bytes[0] & 1) || bytes.every((byte) => byte === 0)) {
    throw new Error('Use the TV network adapter MAC address, not a multicast or empty address.');
  }
  if (bytes.equals(Buffer.from('020000000000', 'hex'))) {
    throw new Error('Android hid the TV MAC address. Enter its actual Wi-Fi or Ethernet MAC from network settings.');
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(':').toUpperCase();
}

function buildMagicPacket(macAddress) {
  const mac = Buffer.from(normalizeMacAddress(macAddress).replace(/:/g, ''), 'hex');
  const packet = Buffer.alloc(102, 0xff);
  for (let offset = 6; offset < packet.length; offset += mac.length) mac.copy(packet, offset);
  return packet;
}

function isUsableAddress(address, allowBroadcast = false) {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  if (allowBroadcast && address === LIMITED_BROADCAST) return true;
  const first = Number(address.split('.')[0]);
  return first > 0 && first !== 127 && first < 224;
}

function ipv4ToNumber(address) {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function numberToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function getBroadcastAddresses(interfaces = os.networkInterfaces(), host) {
  if (host !== undefined && !isUsableAddress(host)) throw new Error('The TV address must be an IPv4 address without a port.');
  const addresses = new Set();
  for (const entry of Object.values(interfaces || {}).flat()) {
    if (!entry || entry.internal || !isUsableAddress(entry.address) || !isIPv4(entry.netmask || '')) continue;
    const mask = ipv4ToNumber(entry.netmask);
    const hostBits = (~mask) >>> 0;
    // A contiguous mask with at least two host bits has a usable broadcast.
    // /0, /31 and /32 interfaces must not become accidental destinations.
    if (!mask || hostBits < 3 || ((hostBits & (hostBits + 1)) >>> 0) !== 0) continue;
    // Avoid spraying unrelated VPN/virtual networks when the TV address is known.
    if (host && ((ipv4ToNumber(host) & mask) >>> 0) !== ((ipv4ToNumber(entry.address) & mask) >>> 0)) continue;
    const broadcast = numberToIpv4((ipv4ToNumber(entry.address) | hostBits) >>> 0);
    if (isUsableAddress(broadcast, true)) addresses.add(broadcast);
  }
  return [...addresses];
}

function resolveWakeDestinations({ host, broadcastAddress, interfaces } = {}) {
  const addresses = new Set([LIMITED_BROADCAST]);
  if (host !== undefined && host !== '') {
    if (!isUsableAddress(host)) throw new Error('The TV address must be an IPv4 address without a port.');
    addresses.add(host);
  }
  if (broadcastAddress !== undefined && broadcastAddress !== '') {
    if (!isUsableAddress(broadcastAddress, true)) throw new Error('The broadcast address must be a valid IPv4 address.');
    addresses.add(broadcastAddress);
  }
  for (const address of getBroadcastAddresses(interfaces, host || undefined)) addresses.add(address);
  if (addresses.size > MAX_DESTINATIONS) throw new Error('Too many network interfaces for a wake request.');
  return [...addresses];
}

async function sendWakePackets(options = {}, dependencies = {}) {
  const { macAddress, host, broadcastAddress, port = 9, repetitions = 3, timeoutMs = 1500 } = options;
  const mac = normalizeMacAddress(macAddress);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The wake port must be between 1 and 65535.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('The wake timeout must be between 1 and 10000 milliseconds.');
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('Send between 1 and 5 wake packets per destination.');
  const getInterfaces = dependencies.networkInterfaces || os.networkInterfaces;
  const destinations = resolveWakeDestinations({ host, broadcastAddress, interfaces: getInterfaces() });
  const packet = buildMagicPacket(mac);
  const requests = Array.from({ length: repetitions }, (_, index) =>
    destinations.map((address) => ({ address, attempt: index + 1 }))).flat();
  const createSocket = dependencies.createSocket || dgram.createSocket;

  return new Promise((resolve) => {
    const results = new Map();
    let socket;
    let finished = false;
    let timer;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (let index = 0; index < requests.length; index += 1) {
        if (!results.has(index)) results.set(index, error || new Error('Wake packet was not sent.'));
      }
      // Closing is best effort: bind failures can leave an unbound socket.
      try { socket?.close(); } catch (_) { /* Socket already closed or never bound. */ }
      const failures = [...results].filter(([, failure]) => failure)
        .map(([index, failure]) => ({ ...requests[index], error: failure.message || String(failure) }));
      resolve({
        macAddress: mac,
        destinations,
        attempted: requests.length,
        sent: requests.length - failures.length,
        failed: failures.length,
        failures
      });
    };
    timer = setTimeout(() => finish(new Error('Wake packet send timed out.')), timeoutMs);
    try {
      socket = createSocket({ type: 'udp4' });
      // Keep the error handler attached through close so a late socket error
      // cannot become an unhandled EventEmitter error after a timeout.
      socket.on('error', finish);
      socket.once('listening', () => {
        if (finished) return;
        try {
          socket.setBroadcast(true);
          for (let index = 0; index < requests.length; index += 1) {
            if (finished) break;
            const { address } = requests[index];
            try {
              socket.send(packet, port, address, (error) => {
                if (finished || results.has(index)) return;
                results.set(index, error || null);
                if (results.size === requests.length) finish();
              });
            } catch (error) {
              results.set(index, error);
            }
          }
          if (results.size === requests.length) finish();
        } catch (error) {
          finish(error);
        }
      });
      socket.bind(0);
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = {
  normalizeMacAddress,
  buildMagicPacket,
  getBroadcastAddresses,
  resolveWakeDestinations,
  sendWakePackets
};
