const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const {
  normalizeMacAddress, buildMagicPacket, getBroadcastAddresses,
  resolveWakeDestinations, sendWakePackets
} = require('../src/main/modules/networkWake');

const macAddress = '02:11:22:33:44:55';
const interfaces = {
  Ethernet: [{ address: '192.0.2.20', netmask: '255.255.255.0', internal: false, family: 'IPv4' }],
  WiFi: [{ address: '192.0.2.30', netmask: '255.255.255.0', internal: false, family: 'IPv4' }],
  Other: [{ address: '198.51.100.5', netmask: '255.255.255.192', internal: false, family: 4 }]
};

function fakeSocket(options = {}) {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.closeCount = 0;
  socket.bind = () => {
    if (options.bindThrow) throw new Error('bind threw');
    if (options.bindError) queueMicrotask(() => socket.emit('error', new Error('bind failed')));
    else if (!options.bindStall) queueMicrotask(() => socket.emit('listening'));
  };
  socket.setBroadcast = (enabled) => {
    assert.equal(enabled, true);
    if (options.broadcastError) throw new Error('broadcast failed');
  };
  socket.send = (packet, port, address, callback) => {
    socket.sent.push({ packet, port, address });
    if (options.sendThrow === address) throw new Error('send threw');
    if (options.sendStall === address) return;
    queueMicrotask(() => callback(options.sendError === address ? new Error('send failed') : null));
  };
  socket.close = () => { socket.closeCount += 1; };
  return socket;
}

function sendWith(socket, options = {}) {
  return sendWakePackets({ macAddress, ...options }, {
    createSocket: () => socket,
    networkInterfaces: () => ({})
  });
}

test('magic packet has the exact synchronization header and sixteen MAC copies', () => {
  const packet = buildMagicPacket(macAddress);
  assert.equal(packet.length, 102);
  assert.deepEqual(packet.subarray(0, 6), Buffer.alloc(6, 255));
  for (let offset = 6; offset < 102; offset += 6) {
    assert.deepEqual(packet.subarray(offset, offset + 6), Buffer.from('021122334455', 'hex'));
  }
  assert.equal(normalizeMacAddress(' 02-11-22-aa-bb-cc '), '02:11:22:AA:BB:CC');
  assert.equal(normalizeMacAddress('021122aabbcc'), '02:11:22:AA:BB:CC');
  assert.equal(normalizeMacAddress('02:11:22:AA:BB:CC'), '02:11:22:AA:BB:CC');
});

test('malformed, multicast, empty and broadcast MACs fail before creating a socket', async () => {
  for (const value of ['', '02:11:22:33:44', '00:11-22:33:44:55', '02:11:22:33:44:GG',
    '00:00:00:00:00:00', '02:00:00:00:00:00', 'FF:FF:FF:FF:FF:FF', '01:11:22:33:44:55', '02:11:22:33:44:55; command', null]) {
    await assert.rejects(sendWakePackets({ macAddress: value }, {
      createSocket: () => assert.fail('Invalid MAC created a socket')
    }));
  }
});

test('directed broadcasts use actual subnet masks, deduplicate and skip unusable interfaces', () => {
  const actual = getBroadcastAddresses({
    ...interfaces,
    Loopback: [{ address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    IPv6: [{ address: '::1', netmask: 'ffff:ffff::', internal: false }],
    Invalid: [null, { address: '0.0.0.0', netmask: '255.255.255.0' },
      { address: '198.51.100.1', netmask: '255.0.255.0' },
      { address: '198.51.100.1', netmask: '255.255.255.254' },
      { address: '198.51.100.1', netmask: '255.255.255.255' },
      { address: '198.51.100.1', netmask: '0.0.0.0' }]
  });
  assert.deepEqual(actual, ['192.0.2.255', '198.51.100.63']);
  assert.deepEqual(resolveWakeDestinations({ host: '192.0.2.10', broadcastAddress: '192.0.2.255', interfaces }),
    ['255.255.255.255', '192.0.2.10', '192.0.2.255']);
  assert.deepEqual(resolveWakeDestinations({ interfaces }),
    ['255.255.255.255', '192.0.2.255', '198.51.100.63']);
});

test('addresses and limits reject hostnames, ports, injection and unsuitable ranges', async () => {
  for (const host of ['tv.local', '192.0.2.10:5555', '127.0.0.1', '0.0.0.0', '224.0.0.1', '192.0.2.10; command', null]) {
    assert.throws(() => resolveWakeDestinations({ host, interfaces: {} }));
  }
  for (const broadcastAddress of ['tv.local', '255.255.255.255:9', '127.0.0.1', '0.0.0.0', '224.0.0.1']) {
    assert.throws(() => resolveWakeDestinations({ broadcastAddress, interfaces: {} }));
  }
  for (const options of [{ port: 0 }, { port: 65536 }, { port: 9.5 }, { timeoutMs: 0 }, { timeoutMs: 10001 }, { repetitions: 0 }, { repetitions: 6 }]) {
    await assert.rejects(sendWith(fakeSocket(), options));
  }
  assert.throws(() => resolveWakeDestinations({ interfaces: {
    Virtual: Array.from({ length: 65 }, (_, index) => ({ address: `${index < 64 ? '192.0.2' : '198.51.100'}.${(index % 64) * 4 + 1}`, netmask: '255.255.255.252' }))
  } }), /Too many/);
});

test('successful sends enable broadcast, send correct bytes and close exactly once', async () => {
  const socket = fakeSocket();
  const result = await sendWith(socket, { host: '192.0.2.10', broadcastAddress: '192.0.2.255' });
  assert.equal(result.attempted, 9);
  assert.equal(result.sent, 9);
  assert.equal(socket.sent.length, 9);
  assert.equal(result.failed, 0);
  assert.equal(socket.closeCount, 1);
  for (const call of socket.sent) {
    assert.equal(call.port, 9);
    assert.deepEqual(call.packet, buildMagicPacket(macAddress));
  }
  assert.equal('poweredOn' in result, false);
  assert.equal('awake' in result, false);
});

test('a failed interface is reported while other destinations can still succeed', async () => {
  for (const failureType of ['sendError', 'sendThrow']) {
    const socket = fakeSocket({ [failureType]: '255.255.255.255' });
    const result = await sendWith(socket, { host: '192.0.2.10' });
    assert.equal(result.sent, 3);
    assert.equal(result.failed, 3);
    assert.equal(result.failures[0].address, '255.255.255.255');
    assert.equal(socket.closeCount, 1);
  }
});

test('binding and broadcast errors are bounded, reported and close the socket', async () => {
  for (const mode of ['bindThrow', 'bindError', 'broadcastError']) {
    const socket = fakeSocket({ [mode]: true });
    const result = await sendWith(socket);
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 3);
    assert.equal(socket.closeCount, 1);
  }
});

test('creation failure is reported without leaking a timeout', async () => {
  const result = await sendWakePackets({ macAddress }, {
    networkInterfaces: () => ({}), createSocket: () => { throw new Error('no socket'); }
  });
  assert.equal(result.sent, 0);
  assert.match(result.failures[0].error, /no socket/);
});

test('a stalled bind times out, closes and ignores late events', async () => {
  const socket = fakeSocket({ bindStall: true });
  const result = await sendWith(socket, { timeoutMs: 15 });
  assert.equal(result.sent, 0);
  assert.match(result.failures[0].error, /timed out/);
  assert.equal(socket.closeCount, 1);
  socket.emit('listening');
  socket.emit('error', new Error('late error'));
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.closeCount, 1);
});

test('a stalled send preserves partial success and closes on the deadline', async () => {
  const socket = fakeSocket({ sendStall: '255.255.255.255' });
  const result = await sendWith(socket, { host: '192.0.2.10', timeoutMs: 15 });
  assert.equal(result.sent, 3);
  assert.equal(result.failed, 3);
  assert.match(result.failures[0].error, /timed out/);
  assert.equal(socket.closeCount, 1);
});

test('a socket error after one send preserves that success and ignores late callbacks', async () => {
  const socket = fakeSocket();
  socket.send = (packet, port, address, callback) => {
    socket.sent.push({ packet, port, address });
    const first = socket.sent.length === 1;
    queueMicrotask(() => {
      callback(null);
      if (first) socket.emit('error', new Error('adapter disconnected'));
    });
  };
  const result = await sendWith(socket);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 2);
  assert.ok(result.failures.every(({ error }) => error === 'adapter disconnected'));
  assert.equal(socket.closeCount, 1);
});
