import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BugStore, validateBug, validateErrors, recentErrors } from './reports';
import { DiagStore, DiagError } from './diag';
const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
test('validateBug trims, keeps the last 200 events and checks the screenshot', () => {
  const events = Array.from({ length: 300 }, (_, i) => ({ at: i, k: 'ev', s: `e${i}` }));
  assert.throws(() => validateBug({ note: '  ' }), DiagError);
  const r = validateBug({ note: ' hi ', events: events.slice(0, 400), versions: { web: 'a' }, screenshot: PNG });
  assert.equal(r.note, 'hi'); assert.equal(r.events.length, 200); assert.equal(r.events.at(-1)!.s, 'e299'); assert.equal(r.shot!.ext, 'png');
  assert.throws(() => validateBug({ note: 'x', screenshot: 'data:image/png;base64,AAAA' }), DiagError); // not a PNG
  assert.throws(() => validateBug({ note: 'x', screenshot: 'data:text/html;base64,AAAA' }), DiagError);
  assert.throws(() => validateBug({ note: 'x'.repeat(1001) }), DiagError);
});
test('validateErrors bounds every field', () => {
  assert.equal(validateErrors({ page: 'p', ua: 'u', records: [{ msg: 'boom', line: 3 }] }).records[0].msg, 'boom');
  assert.throws(() => validateErrors({ records: Array(51).fill({}) }), DiagError);
  assert.throws(() => validateErrors({ records: [{ msg: 'x'.repeat(501) }] }), DiagError);
});
test('bug reports are stored, rate limited, listed newest first, swept after 14 days', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deck-bugs-'));
  try {
    const s = new BugStore(dir), u = { id: 'u1', name: 'Kim' }, t = Date.parse('2026-10-18T10:00:00Z');
    const a = await s.submit(u, validateBug({ note: 'one', screenshot: PNG }), t);
    await assert.rejects(s.submit(u, validateBug({ note: 'two' }), t + 5000), (e: unknown) => (e as DiagError).code === 429);
    const b = await s.submit(u, validateBug({ note: 'two' }), t + 11_000);
    assert.deepEqual((await s.list()).map(x => x.id), [b, a]);
    assert.equal((await s.screenshot(a))!.type, 'image/png'); assert.equal(await s.screenshot(b), null); assert.equal(await s.screenshot('../../etc'), null);
    await mkdir(join(dir, '2026-09-01')); await s.sweep(t);
    assert.deepEqual((await readdir(dir)).sort(), ['2026-10-18']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('recentErrors reads what DiagStore wrote, newest first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deck-err-'));
  try {
    const d = new DiagStore(dir), t = Date.parse('2026-10-18T10:00:00Z');
    await d.append('u1', 'Kim', validateErrors({ page: 'p', ua: 'u', records: [{ msg: 'first' }] }), t);
    await d.append('u2', 'Lee', validateErrors({ page: 'p', ua: 'u', records: [{ msg: 'second' }] }), t + 1000);
    await writeFile(join(dir, '2026-10-18', 'bad.jsonl'), 'not json\n');
    assert.deepEqual((await recentErrors(dir)).map(r => r.msg), ['second', 'first']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
