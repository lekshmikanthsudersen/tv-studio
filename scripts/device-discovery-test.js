const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const dgram = require('node:dgram');
const os = require('node:os');
const DeviceDiscovery = require('../src/main/modules/deviceDiscovery');

// All unicast IPv4 addresses below are reserved documentation fixtures.
const type = '_androidtvremote2._tcp.local';
const instance = `bravia vu3.${type}`;
const host = 'bravia-vu3.local';
function dnsName(name) {
  return Buffer.concat([...name.split('.').map((label) => {
    const data = Buffer.from(label);
    return Buffer.concat([Buffer.from([data.length]), data]);
  }), Buffer.from([0])]);
}
function record(name, recordType, data) {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(recordType, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt32BE(120, 4);
  header.writeUInt16BE(data.length, 8);
  return Buffer.concat([dnsName(name), header, data]);
}
function packet(...records) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records]);
}
function srv(port = 6467) {
  const header = Buffer.alloc(6);
  header.writeUInt16BE(port, 4);
  return record(instance, 33, Buffer.concat([header, dnsName(host)]));
}
const ptr = () => record(type, 12, dnsName(instance));
const a = () => record(host, 1, Buffer.from([192, 0, 2, 32]));
const aaaa = () => record(host, 28, Buffer.from('fe800000000000000102030405060708', 'hex'));

function testPackets() {
  const discovery = new DeviceDiscovery();
  const updates = [];
  discovery.on('devices', (devices) => updates.push(devices));
  discovery.processPacket(packet(ptr()));
  assert.equal(discovery.getDevices()[0].address, '');
  discovery.processPacket(packet(srv()));
  assert.equal(discovery.getDevices()[0].host, host);
  discovery.processPacket(packet(aaaa()));
  assert.match(discovery.getDevices()[0].address, /^fe80:/);
  discovery.processPacket(packet(a()));
  assert.equal(discovery.getDevices().length, 1, 'Partial DNS records must not leave duplicate devices');
  assert.equal(discovery.getDevices()[0].address, '192.0.2.32');
  discovery.processPacket(packet(aaaa(), srv(6543)));
  assert.equal(discovery.getDevices()[0].address, '192.0.2.32', 'Later AAAA must not replace IPv4');
  assert.equal(discovery.getDevices()[0].services.remote.port, 6543, 'SRV update without PTR must refresh port');
  assert.equal(updates.length, 5, 'Each later DNS record should update the UI');

  const reversed = new DeviceDiscovery();
  reversed.processPacket(packet(a(), aaaa(), srv()));
  assert.equal(reversed.getDevices().length, 0);
  reversed.processPacket(packet(ptr()));
  assert.equal(reversed.getDevices()[0].address, '192.0.2.32', 'Records before PTR must also resolve');

  for (const value of discovery.serviceRecords.values()) value.lastSeen -= 50000;
  for (const value of discovery.hostAddresses.values()) value.lastSeen -= 50000;
  discovery.expireOldDevices();
  assert.equal(discovery.getDevices().length, 0, 'Expired cached records must not revive stale devices');
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.joined = [];
    this.dropped = [];
    this.sent = [];
  }
  bind() { setImmediate(() => this.emit('listening')); }
  addMembership(group, address) {
    assert.equal(group, '224.0.0.251');
    if (address === '203.0.113.2') throw new Error('VPN cannot multicast');
    this.joined.push(address);
  }
  dropMembership(_group, address) { this.dropped.push(address); }
  setMulticastTTL(value) { assert.equal(value, 255); }
  setMulticastLoopback(value) { assert.equal(value, false); }
  setMulticastInterface(address) { this.outgoing = address; }
  send(data, offset, length, port, group, callback) {
    assert.equal(data.readUInt16BE(4), 5, 'Query all TV/ADB service types');
    assert.equal(port, 5353);
    assert.equal(group, '224.0.0.251');
    setImmediate(() => {
      this.sent.push(this.outgoing);
      callback(null);
    });
  }
  close(callback) { setImmediate(callback); }
}

async function waitForQuery(discovery) {
  while (discovery.querying) await new Promise((resolve) => setImmediate(resolve));
}

async function testInterfaces() {
  const originalSocket = dgram.createSocket;
  const originalInterfaces = os.networkInterfaces;
  const socket = new FakeSocket();
  let interfaces = {
    loopback: [{ address: '127.0.0.1', internal: true }],
    wifi: [{ address: '192.0.2.22', internal: false }, { address: 'fe80::1', internal: false }],
    virtualBox: [{ address: '198.51.100.1', internal: false }],
    vpn: [{ address: '203.0.113.2', internal: false }],
    duplicate: [{ address: '192.0.2.22', internal: false }]
  };
  const discovery = new DeviceDiscovery({ logger: { warn() {} } });
  const errors = [];
  discovery.on('error', (error) => errors.push(error));
  try {
    dgram.createSocket = () => socket;
    os.networkInterfaces = () => interfaces;
    await discovery.start();
    await waitForQuery(discovery);
    assert.deepEqual(socket.joined, ['192.0.2.22', '198.51.100.1']);
    assert.deepEqual(socket.sent, ['192.0.2.22', '198.51.100.1'], 'Each delayed send must use its own interface');
    assert.equal(errors.length, 0, 'Unsupported VPN must not prevent LAN discovery');
    interfaces = { wifi: [{ address: '192.0.2.22', internal: false }] };
    await discovery.query();
    assert.deepEqual(socket.dropped, ['198.51.100.1']);
    assert.equal(socket.sent.at(-1), '192.0.2.22');
  } finally {
    await discovery.stop();
    dgram.createSocket = originalSocket;
    os.networkInterfaces = originalInterfaces;
  }
}

(async () => {
  testPackets();
  await testInterfaces();
  console.log('PASS: split/out-of-order DNS packets, IPv4 preference, SRV refresh, cache expiry, per-interface multicast sends and adapter changes');
})().catch((error) => { console.error(error); process.exitCode = 1; });
