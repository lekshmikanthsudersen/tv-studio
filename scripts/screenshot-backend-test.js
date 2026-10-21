const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { deflateSync } = require('node:zlib');
const AdbWrapper = require('../src/main/modules/adbWrapper');
const StreamDecoder = require('../src/main/modules/streamDecoder');

function pngChunk(type, bytes) {
  const chunk = Buffer.alloc(bytes.length + 12);
  chunk.writeUInt32BE(bytes.length);
  chunk.write(type, 4, 'ascii');
  bytes.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

const header = Buffer.from('00000001000000010806000000', 'hex');
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  pngChunk('IHDR', header),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30, 255]))),
  pngChunk('IEND', Buffer.alloc(0))
]);

function fakeAdb() {
  const adb = new AdbWrapper();
  const children = [];
  const events = new EventEmitter();
  adb.spawnAdb = (args) => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kills: 0, args });
    child.kill = () => {
      child.kills += 1;
      setImmediate(() => child.emit('close', null));
      return true;
    };
    child.finish = (bytes = PNG, code = 0) => {
      child.stdout.write(bytes.subarray(0, 20));
      child.stdout.write(bytes.subarray(20));
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code);
    };
    children.push(child);
    events.emit('spawn', child);
    return child;
  };
  return { adb, children, events };
}

function get(url) {
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
  return { request, result };
}

async function withServer(adb, operation) {
  const decoder = new StreamDecoder({ adb });
  decoder.on('error', () => {});
  await decoder.start();
  try { await operation(decoder, await decoder.getSnapshotUrl('sony:5555')); }
  finally { await decoder.stop(); }
}

test('overlapping preview and save share one valid capture and return useful metadata', async () => {
  const { adb, children } = fakeAdb();
  const tempRoot = path.resolve(os.tmpdir());
  const outputDir = fs.mkdtempSync(path.join(tempRoot, 'tv-studio-screenshot-test-'));
  try {
    const preview = adb.captureScreenshot('sony:5555');
    const saved = adb.saveScreenshot('sony:5555', outputDir);
    assert.equal(children.length, 1);
    assert.deepEqual(children[0].args, ['-s', 'sony:5555', 'exec-out', 'screencap', '-p']);
    children[0].finish();
    const [image, file] = await Promise.all([preview, saved]);
    assert.deepEqual(image.png, PNG);
    assert.deepEqual(fs.readFileSync(file.path), PNG);
    assert.equal(image.width, 1);
    assert.equal(file.height, 1);
    assert.equal(file.bytes, PNG.length);
    assert.ok(file.captureMs >= 0);
    assert.equal(adb.screenshotCaptures.size, 0);
    assert.equal(children[0].kills, 0);
  } finally {
    assert.equal(path.dirname(path.resolve(outputDir)), tempRoot);
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('bad or truncated image output is rejected rather than saved as PNG', async () => {
  const corrupted = Buffer.from(PNG);
  corrupted[corrupted.length - 18] ^= 1;
  const hugeChunk = Buffer.from(PNG);
  hugeChunk.writeUInt32BE(0xffffffff, 8);
  for (const bytes of [Buffer.alloc(0), Buffer.from('screencap failed'), PNG.subarray(0, -3), corrupted, hugeChunk, Buffer.concat([PNG, Buffer.from('junk')])]) {
    const { adb, children } = fakeAdb();
    const capture = adb.captureScreenshot('sony:5555');
    children[0].finish(bytes);
    await assert.rejects(capture, (error) => ['SCREENSHOT_EMPTY', 'SCREENSHOT_INVALID'].includes(error.code));
    assert.equal(adb.screenshotCaptures.size, 0);
  }
});

test('binary overflow, timeout and cancellation terminate their processes', async () => {
  const oversized = fakeAdb();
  const overflow = oversized.adb.runBuffer(['capture'], { maxBuffer: 4 });
  oversized.children[0].stdout.write(Buffer.alloc(5));
  await assert.rejects(overflow, { code: 'ADB_OUTPUT_TOO_LARGE' });
  assert.equal(oversized.children[0].kills, 1);

  const timed = fakeAdb();
  await assert.rejects(timed.adb.runBuffer(['capture'], { timeoutMs: 20 }), { code: 'ADB_TIMEOUT' });
  assert.equal(timed.children[0].kills, 1);

  const cancelled = fakeAdb();
  const controller = new AbortController();
  const capture = cancelled.adb.captureScreenshot('sony:5555', { signal: controller.signal });
  controller.abort();
  await assert.rejects(capture, { code: 'ADB_ABORTED' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled.children[0].kills, 1);
  assert.equal(cancelled.adb.screenshotCaptures.size, 0);
  await assert.rejects(cancelled.adb.captureScreenshot('sony:5555', { signal: controller.signal }), { code: 'ADB_ABORTED' });
  assert.equal(cancelled.children.length, 1, 'Already-cancelled requests must not start another child');
});

test('one cancelled consumer does not cancel another consumer or reuse a cancelled capture', async () => {
  const { adb, children } = fakeAdb();
  const controller = new AbortController();
  const first = adb.captureScreenshot('sony:5555', { signal: controller.signal });
  const second = adb.captureScreenshot('sony:5555');
  controller.abort();
  await assert.rejects(first, { code: 'ADB_ABORTED' });
  assert.equal(children[0].kills, 0);
  children[0].finish();
  assert.deepEqual((await second).png, PNG);
  const next = adb.captureScreenshot('sony:5555');
  assert.equal(children.length, 2, 'Completed frames must not be reused as fresh captures');
  children[1].finish();
  await next;
});

test('app shutdown cancels standalone captures as well as shared preview captures', async () => {
  const { adb, children } = fakeAdb();
  const first = adb.captureScreenshot('sony:5555');
  const shared = adb.captureScreenshot('sony:5555');
  const second = adb.captureScreenshot('other-tv:5555');
  const rejected = [first, shared, second].map((capture) => assert.rejects(capture, { code: 'ADB_ABORTED' }));
  await adb.cancelScreenshots();
  await Promise.all(rejected);
  assert.equal(children.length, 2);
  assert.deepEqual(children.map((child) => child.kills), [1, 1]);
  assert.equal(adb.screenshotCaptures.size, 0);
});

test('HTTP waits for a full PNG and returns bytes and capture duration', async () => {
  const { adb, children, events } = fakeAdb();
  await withServer(adb, async (_decoder, url) => {
    const spawned = once(events, 'spawn');
    const { request, result } = get(url);
    let headersSent = false;
    request.on('response', () => { headersSent = true; });
    await Promise.race([spawned, result]);
    assert.equal(headersSent, false, 'Do not return 200 before a capture is validated');
    children[0].finish();
    const response = await result;
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(Number(response.headers['content-length']), PNG.length);
    assert.ok(Number(response.headers['x-capture-duration-ms']) >= 0);
    assert.deepEqual(response.body, PNG);
  });
});

test('HTTP returns an error for invalid or timed-out screenshots', async () => {
  const { adb, children, events } = fakeAdb();
  await withServer(adb, async (_decoder, url) => {
    const spawned = once(events, 'spawn');
    const { result } = get(url);
    await Promise.race([spawned, result]);
    children[0].finish(Buffer.alloc(0));
    const response = await result;
    assert.equal(response.status, 502);
    assert.equal(JSON.parse(response.body).code, 'SCREENSHOT_EMPTY');
  });
  await withServer({ captureScreenshot: async () => { throw Object.assign(new Error('Capture timed out'), { code: 'ADB_TIMEOUT' }); } }, async (_decoder, url) => {
    const response = await get(url).result;
    assert.equal(response.status, 504);
    assert.equal(JSON.parse(response.body).code, 'ADB_TIMEOUT');
  });
});

test('closing a preview or stopping the HTTP server cleans up pending capture processes', async () => {
  for (const stopServer of [false, true]) {
    const { adb, children, events } = fakeAdb();
    await withServer(adb, async (decoder, url) => {
      const spawned = once(events, 'spawn');
      const { request, result } = get(url);
      const ended = result.catch(() => null);
      await Promise.race([spawned, result]);
      if (stopServer) await decoder.stop();
      else request.destroy();
      await ended;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(children[0].kills, 1);
      assert.equal(adb.screenshotCaptures.size, 0);
      assert.equal(decoder.activePipelines.size, 0);
    });
  }
});
