import test from 'node:test';
import assert from 'node:assert/strict';
import { addError, recentEvents, recordEvent } from './reports';
test('the event ring keeps 200, skips chatty kinds and shortens long text', () => {
  for (let i = 0; i < 260; i++) recordEvent('out', { t: 'move', i } as { t: string });
  recordEvent('in', { t: 'speaking' }); recordEvent('out', { t: 'chat', text: 'x'.repeat(100) } as { t: string });
  const ev = recentEvents();
  assert.equal(ev.length, 200); assert.ok(!ev.some(e => e.s.startsWith('speaking')));
  assert.ok(ev.at(-1)!.s.length < 100 && ev.at(-1)!.s.includes('…'));
});
test('repeated errors count up, and a batch is capped', () => {
  const batch: Parameters<typeof addError>[0] = [], e = { kind: 'error', msg: 'boom', stack: '', src: 'a.js', line: 1, col: 1, at: 0 };
  addError(batch, e); addError(batch, e); assert.equal(batch.length, 1); assert.equal(batch[0].count, 2);
  for (let i = 0; i < 30; i++) addError(batch, { ...e, msg: `m${i}` }, 5);
  assert.equal(batch.length, 5);
});
