import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagStore, DiagError, validateDiag, diagPath } from './diag';
const body = { page: 'page', ua: 'Safari', records: [{ t: 1, p: 2, seq: 1, type: 'env' }] };
test('diagnostics reject malformed envelopes and records', () => {
  assert.deepEqual(validateDiag(body), body);
  for (const value of [null, [], {}, { ...body, page: 1 }, { ...body, page: 'x'.repeat(41) }, { ...body, ua: 'x'.repeat(401) }, { ...body, records: {} }, { ...body, records: Array(2001).fill({}) }, { ...body, records: [null] }, { ...body, records: [[]] }])
    assert.throws(() => validateDiag(value), (e: unknown) => e instanceof DiagError && e.code === 400);
});
test('diagnostic paths use UTC dates and reject unsafe user IDs', () => {
  assert.equal(diagPath('/diag', 'user_1', Date.parse('2026-10-17T00:30:00+02:00')), '/diag/2026-10-16/user_1.jsonl');
  assert.throws(() => diagPath('/diag', '../escape', Date.now()));
});
test('retention removes only date directories outside the three UTC days', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deck-diag-'));
  try {
    for (const name of ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', 'notes', '2026-02-30']) await mkdir(join(dir, name));
    await writeFile(join(dir, '2026-10-12'), 'keep non-directory');
    await new DiagStore(dir).sweep(Date.parse('2026-10-16T12:00:00Z'));
    assert.deepEqual((await readdir(dir)).sort(), ['2026-02-30', '2026-10-12', '2026-10-14', '2026-10-15', '2026-10-16', 'notes']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('appends trusted metadata, UA on first line only, limits sessions and counts persisted bytes across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deck-diag-')), now = Date.parse('2026-10-16T12:00:00Z');
  try {
    const store = new DiagStore(dir);
    store.begin('session', now);
    assert.throws(() => store.begin('session', now + 999), (e: unknown) => e instanceof DiagError && e.code === 429);
    assert.doesNotThrow(() => store.begin('session', now + 1000));
    await store.append('u1', 'Name', { ...body, records: [{ ...body.records[0], user: 'spoof', ua: 'spoof' }, { type: 'sample' }] }, now);
    const file = join(dir, '2026-10-16/u1.jsonl');
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    assert.equal(lines[0].user, 'u1'); assert.equal(lines[0].ua, 'Safari'); assert.equal(lines[1].ua, undefined);
    assert.equal(lines[0].name, 'Name'); assert.equal(lines[0].srv, now);
    // Disk bytes, including server metadata, exhaust the quota even after restart and across sessions.
    await writeFile(file, Buffer.alloc(50 * 1024 * 1024 - 1));
    await assert.rejects(new DiagStore(dir).append('u1', 'Name', body, now), (e: unknown) => e instanceof DiagError && e.code === 413);
    await assert.doesNotReject(store.append('u1', 'Name', body, now + 86400_000));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
