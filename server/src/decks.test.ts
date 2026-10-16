import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeckStore, PresentError, userDirName } from './decks';

const PNG = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n - 4)]).toString('base64');
const tmp = () => mkdtempSync(join(tmpdir(), 'decks-test-'));

test('list only shows my decks; used sums bytes', async () => {
  const s = new DeckStore(tmp());
  const a = await s.save('alice', 'A', [PNG(100), PNG(50)]);
  await s.save('bob', 'B', [PNG(70)]);
  assert.deepEqual(s.list('alice').map(d => d.id), [a.id]);
  assert.equal(s.used('alice'), 150);
  assert.equal(s.used('bob'), 70);
  assert.equal(s.list('nobody').length, 0);
});

test('quota refuses with how much is free', async () => {
  const s = new DeckStore(tmp(), 1000);
  await s.save('alice', 'A', [PNG(800)]);
  await assert.rejects(s.save('alice', 'B', [PNG(300)]), (e: PresentError) => e.code === 413 && /free/.test(e.message));
  await s.save('bob', 'C', [PNG(900)]); // quota is per person
});

test('delete removes files, entry and the empty user folder; only the owner may', async () => {
  const root = tmp(), s = new DeckStore(root);
  const d = await s.save('alice', 'A', [PNG(100)]);
  await assert.rejects(s.delete('bob', d.id), (e: PresentError) => e.code === 404);
  assert.ok(existsSync(s.slidePath(d, 1)));
  await s.delete('alice', d.id);
  assert.equal(s.get(d.id), undefined);
  assert.deepEqual(readdirSync(root), []);
});

test('sweep drops decks past the TTL and returns them', async () => {
  const root = tmp(), s = new DeckStore(root, 1e9, 1000);
  const old = await s.save('alice', 'old', [PNG(100)]);
  const now = Date.now();
  assert.deepEqual(await s.sweep(now), []);
  const gone = await s.sweep(now + 5000);
  assert.deepEqual(gone.map(d => d.id), [old.id]);
  assert.equal(s.list('alice').length, 0);
  assert.deepEqual(readdirSync(root), []);
});

test('files land in per-user folders and survive a restart', async () => {
  const root = tmp(), s = new DeckStore(root);
  const d = await s.save('alice', 'A', [PNG(100)]);
  assert.ok(existsSync(join(root, 'alice', d.id, 'deck.json')));
  assert.equal(new DeckStore(root).get(d.id)?.key, d.key);
});

test('user keys cannot escape the decks dir', async () => {
  for (const k of ['..', '.', '../x', 'a/b']) assert.ok(!/[\\/]/.test(userDirName(k)) && !['.', '..'].includes(userDirName(k)), k);
  assert.throws(() => userDirName(''), PresentError);
  assert.equal(userDirName('..'), '%2E.');
  const root = tmp(), s = new DeckStore(root);
  const d = await s.save('../evil', 'x', [PNG(10)]);
  assert.ok(existsSync(s.slidePath(d, 1)) && s.slidePath(d, 1).startsWith(root));
});

test('migrates the old flat layout and fills in bytes and key', () => {
  const root = tmp(), id = '11111111-2222-3333-4444-555555555555';
  mkdirSync(join(root, id));
  writeFileSync(join(root, id, '1.png'), Buffer.from(PNG(120), 'base64'));
  writeFileSync(join(root, id, '2.jpg'), Buffer.from(PNG(30), 'base64'));
  writeFileSync(join(root, id, 'deck.json'), JSON.stringify({ id, title: 'Old', count: 2, ext: ['png', 'jpg'], by: 'alice', at: 1 }));
  mkdirSync(join(root, '99999999-2222-3333-4444-555555555555')); // half-written: no deck.json
  const s = new DeckStore(root);
  const d = s.get(id)!;
  assert.equal(d.bytes, 150);
  assert.ok(d.key);
  assert.ok(!existsSync(join(root, id)));
  assert.ok(existsSync(s.slidePath(d, 2)) && s.slidePath(d, 2).startsWith(join(root, 'alice')));
  assert.equal(JSON.parse(readFileSync(join(root, 'alice', id, 'deck.json'), 'utf8')).key, d.key);
  assert.equal(new DeckStore(root).get(id)?.key, d.key); // second start: nothing to migrate, same key
});

test('corrupt deck.json does not crash startup', () => {
  const root = tmp();
  mkdirSync(join(root, 'alice', '11111111-2222-3333-4444-555555555555'), { recursive: true });
  writeFileSync(join(root, 'alice', '11111111-2222-3333-4444-555555555555', 'deck.json'), '{nope');
  assert.equal(new DeckStore(root).decks.size, 0);
});
