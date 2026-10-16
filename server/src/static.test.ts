import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic } from './static';
async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'deck-static-'));
  mkdirSync(join(dir, 'assets'));
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  writeFileSync(join(dir, 'assets', 'song-12345678.m4a'), bytes); writeFileSync(join(dir, 'index.html'), '<html>deck</html>');
  writeFileSync(join(dir, 'song.mp3'), bytes);
  writeFileSync(join(dir, 'assets', 'worker-12345678.mjs'), 'export {};'); writeFileSync(join(dir, 'emu.wasm'), bytes);
  const server = createServer((req, res) => serveStatic(dir, req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); rmSync(dir, { recursive: true }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const get = (range?: string, method = 'GET', path = '/assets/song-12345678.m4a') => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path, method, headers: range === undefined ? {} : { range } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
  return { get, bytes, dir, port: address.port };
}
test('static full files, MIME, immutable cache and fallback', async t => {
  const { get, bytes } = await setup(t), r = await get();
  assert.equal(r.status, 200); assert.equal(r.headers['accept-ranges'], 'bytes'); assert.equal(r.headers['content-length'], '256');
  assert.equal(r.headers['content-type'], 'audio/mp4'); assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable'); assert.deepEqual(r.body, bytes);
  assert.equal((await get(undefined, 'GET', '/song.mp3')).headers['content-type'], 'audio/mpeg');
  // module workers (pdf.js) only run when served as JavaScript; nosniff makes every type count
  assert.equal((await get(undefined, 'GET', '/assets/worker-12345678.mjs')).headers['content-type'], 'text/javascript');
  assert.equal((await get(undefined, 'GET', '/emu.wasm')).headers['content-type'], 'application/wasm');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  for (const path of ['/unknown', '/assets/', '/../../outside', '/%2e%2e/%2e%2e/outside', '/%zz']) {
    const r = await get(undefined, 'GET', path); assert.equal(r.status, 200); assert.equal(r.body.toString(), '<html>deck</html>'); assert.equal(r.headers['cache-control'], 'no-cache');
  }
});
test('single ranges return exactly the requested bytes', async t => {
  const { get, bytes } = await setup(t);
  for (const [range, start, end] of [['0-99', 0, 99], ['100-', 100, 255], ['-100', 156, 255], ['200-999', 200, 255], ['-999', 0, 255], ['0-0', 0, 0]] as const) {
    const r = await get(`bytes=${range}`); assert.equal(r.status, 206); assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.headers['content-range'], `bytes ${start}-${end}/256`); assert.equal(r.headers['content-length'], `${end - start + 1}`); assert.deepEqual(r.body, bytes.subarray(start, end + 1));
  }
});
test('unsatisfiable ranges return 416 and an empty body', async t => {
  const { get } = await setup(t);
  for (const range of ['256-', '5-2', '-0']) {
    const r = await get(`bytes=${range}`); assert.equal(r.status, 416); assert.equal(r.headers['content-range'], 'bytes */256'); assert.equal(r.headers['content-length'], '0'); assert.equal(r.body.length, 0);
  }
});
test('malformed, multiple and non-byte ranges are ignored', async t => {
  const { get, bytes } = await setup(t);
  for (const range of ['bytes=0-1,5-6', 'junk', 'items=0-1', 'bytes=-', 'bytes=x-y', 'bytes=1-2junk']) {
    const r = await get(range); assert.equal(r.status, 200); assert.equal(r.headers['content-range'], undefined); assert.deepEqual(r.body, bytes);
  }
});
test('HEAD ignores Range and has full headers without a body', async t => {
  const { get } = await setup(t);
  for (const range of [undefined, 'bytes=0-99', 'bytes=256-']) {
    const r = await get(range, 'HEAD'); assert.equal(r.status, 200); assert.equal(r.headers['content-length'], '256'); assert.equal(r.headers['accept-ranges'], 'bytes'); assert.equal(r.headers['content-range'], undefined); assert.equal(r.body.length, 0);
  }
});

test('aborted static streams close their file descriptors', async t => {
  const { dir, port } = await setup(t);
  writeFileSync(join(dir, 'large.m4a'), Buffer.alloc(4 * 1024 * 1024));
  const baseline = readdirSync('/dev/fd').length;
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/large.m4a', agent: false }, res => {
      res.once('data', () => { req.destroy(); resolve(); });
      res.on('error', () => {});
    });
    req.on('error', reject); req.end();
  });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(readdirSync('/dev/fd').length <= baseline + 1, 'aborted streams must release their fds');
});
test('missing fallback returns an empty 404', async t => {
  const { get, dir } = await setup(t);
  rmSync(join(dir, 'index.html'));
  const r = await get(undefined, 'GET', '/missing');
  assert.equal(r.status, 404); assert.equal(r.body.length, 0);
});
