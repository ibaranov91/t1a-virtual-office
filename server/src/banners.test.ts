import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BannerStore, BannerError, BANNER_MAX_BYTES, bannerName, validateBanner, validateImage } from './banners';
import { BANNER_PATTERNS } from '../../shared/protocol';
function png(w = 680, h = 240) {
  const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b;
}
function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X') {
  const b = Buffer.alloc(30); b.write('RIFF'); b.writeUInt32LE(22, 4); b.write('WEBP', 8); b.write(kind, 12); b.writeUInt32LE(10, 16);
  if (kind === 'VP8X') { b.writeUIntLE(679, 24, 3); b.writeUIntLE(239, 27, 3); }
  if (kind === 'VP8 ') { b.set([0x9d, 1, 0x2a], 23); b.writeUInt16LE(680, 26); b.writeUInt16LE(240, 28); }
  if (kind === 'VP8L') { b[20] = 0x2f; b.writeUInt32LE(679 | (239 << 14), 21); }
  return b;
}
test('banner messages accept only null, six-digit colors and listed patterns', () => {
  assert.equal(validateBanner(null), true);
  assert.equal(validateBanner({ kind: 'color', color: '#aAbB09' }), true);
  for (const pattern of BANNER_PATTERNS) assert.equal(validateBanner({ kind: 'pattern', pattern, color: '#123456' }), true);
  for (const value of [undefined, {}, [], '#123456', { kind: 'image', url: '/x' }, { kind: 'color', color: '#fff' }, { kind: 'color', color: 'red' }, { kind: 'pattern', pattern: 'x', color: '#123456' }]) assert.equal(validateBanner(value), false);
});
test('image headers identify PNG, JPEG and all three WEBP layouts', () => {
  assert.deepEqual(validateImage(png()), { ext: 'png', width: 680, height: 240 });
  const jpg = Buffer.from('ffd8ffe000040000ffc000110800f002a803011100021100031100ffd9', 'hex');
  assert.deepEqual(validateImage(jpg), { ext: 'jpg', width: 680, height: 240 });
  for (const kind of ['VP8 ', 'VP8L', 'VP8X'] as const) assert.deepEqual(validateImage(webp(kind)), { ext: 'webp', width: 680, height: 240 });
});
test('image bounds, byte limit, unsupported formats and truncated headers are rejected', () => {
  for (const [w, h] of [[300, 100], [1600, 800]]) assert.doesNotThrow(() => validateImage(png(w, h)));
  for (const b of [png(299), png(1601), png(680, 99), png(680, 801), Buffer.from('<svg/>'), Buffer.from('GIF89a'), Buffer.from('garbage'), png().subarray(0, 23), Buffer.from('ffd8ff', 'hex')]) assert.throws(() => validateImage(b), (e: unknown) => e instanceof BannerError && e.code === 400);
  assert.throws(() => validateImage(Buffer.alloc(BANNER_MAX_BYTES + 1)), (e: unknown) => e instanceof BannerError && e.code === 413);
  const exact = Buffer.alloc(BANNER_MAX_BYTES); png().copy(exact); assert.doesNotThrow(() => validateImage(exact));
});
test('hashed files replace the old banner, identical uploads survive, reset removes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-banners-')), store = new BannerStore(dir);
  try {
    const first = store.save('user_1', png(), null);
    assert.match(first.url, /^\/banners\/user_1-[0-9a-f]{12}\.png$/);
    assert.deepEqual(store.save('user_1', png(), first), first);
    assert.equal(readdirSync(dir).length, 1);
    const next = store.save('user_1', png(700), first);
    assert.notEqual(next.url, first.url); assert.deepEqual(readdirSync(dir), [next.url.slice(9)]);
    store.remove('other', next); assert.equal(readdirSync(dir).length, 1);
    store.remove('user_1', next); assert.deepEqual(readdirSync(dir), []);
    assert.throws(() => store.save('../escape', png(), null));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('static banner names reject traversal, encodings, queries and unknown extensions', () => {
  for (const name of ['a-012345abcdef.png', 'user_1-012345abcdef.jpg', 'u-x-012345abcdef.webp']) assert.equal(bannerName(name), true);
  for (const name of ['../a-012345abcdef.png', 'a-012345abcdef.svg', 'a-012345ABCDEf.png', 'a-012345abcdef.png?x', '%2fa-012345abcdef.png', 'a.png', '/a-012345abcdef.png']) assert.equal(bannerName(name), false);
});

test('world publishes sanitized public banners, persists them, and limits changes across upload and intents', async t => {
  const { World } = await import('./world');
  const { readFileSync } = await import('node:fs');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const map = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'deck-banner-world-'));
  try {
    const world = new World(map); world.banners = new BannerStore(dir);
    const u = world.addUser('Banner owner'), observer = world.addUser('Observer');
    u.email = 'private@example.com';
    const messages: import('../../shared/protocol').ServerMsg[] = [];
    world.connect(observer.id, m => messages.push(m));
    world.setBanner(u, { kind: 'color', color: '#123456', email: 'never broadcast' });
    assert.deepEqual(messages.at(-1), { t: 'banner', userId: u.id, banner: { kind: 'color', color: '#123456' } });
    world.setBanner(u, null); assert.equal(u.banner?.kind, 'color');
    assert.throws(() => world.uploadBanner(u, png()), (e: unknown) => e instanceof BannerError && e.code === 429);
    t.mock.timers.tick(2000);
    world.beginBannerUpload(u.id);
    assert.throws(() => world.beginBannerUpload(u.id), (e: unknown) => e instanceof BannerError && e.code === 429);
    const banner = world.uploadBanner(u, png());
    assert.deepEqual(world.dump().users.find(p => p.id === u.id)?.banner, banner);
    const restored = new World(map); restored.load(world.dump()); assert.deepEqual(restored.users.get(u.id)?.banner, banner);
    const snapshot = world.snapshot();
    assert.equal(snapshot.t, 'state');
    if (snapshot.t !== 'state') throw new Error('Expected state');
    const publicUser = snapshot.users.find(p => p.id === u.id)!;
    assert.deepEqual(publicUser.banner, banner); assert.equal('email' in publicUser, false);
    t.mock.timers.tick(2000);
    world.setBanner(u, { kind: 'image', url: '/banners/fake' }); assert.deepEqual(u.banner, banner);
    world.setBanner(u, { kind: 'pattern', pattern: 'dots', color: '#abcdef' }); assert.equal(world.dump().users.find(p => p.id === u.id)?.banner?.kind, 'pattern'); assert.deepEqual(readdirSync(dir), []);
    t.mock.timers.tick(8000); assert.doesNotThrow(() => world.beginBannerUpload(u.id));
    world.uploadBanner(u, png()); t.mock.timers.tick(2000); world.setBanner(u, null);
    assert.equal(u.banner, null); assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
