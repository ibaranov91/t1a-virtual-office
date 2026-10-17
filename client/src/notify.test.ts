import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knockOverflow, localEntry, logsOnExit, mergeLog, overflow, slotOf, unreadCount, KNOCK_POPUPS_MAX, OVER_MAX, TOP_MAX, type Queued } from './notify';

const q = (id: number, kind: string, extra: Partial<Queued> = {}): Queued => ({ id, kind, ...(kind === 'knock_in' ? { knockId: `k${id}` } : {}), ...extra });

test('at most two knock pop-ups: the oldest beyond that are retired', () => {
  const queue = [q(1, 'knock_in'), q(2, 'info'), q(3, 'knock_in'), q(4, 'knock_in')];
  assert.deepEqual(knockOverflow(queue).map(t => t.id), [1]);
  assert.equal(knockOverflow(queue.slice(0, 3)).length, 0);
  assert.equal(KNOCK_POPUPS_MAX, 2);
  const five = Array.from({ length: 5 }, (_, i) => q(i, 'knock_in'));
  assert.deepEqual(knockOverflow(five).map(t => t.id), [0, 1, 2]);
});

test('top slot caps by priority then age and never drops a knock', () => {
  const queue = [q(1, 'knock_in'), q(2, 'info'), q(3, 'chat'), q(4, 'link'), q(5, 'info'), q(6, 'knock_in')];
  const drop = overflow(queue).map(t => t.id);
  assert.equal(queue.length - drop.length, TOP_MAX);
  assert.deepEqual(drop, [2, 3]); // lowest priority, oldest first; the link and knocks stay
  assert.ok(!drop.includes(1) && !drop.includes(6));
});

test('over-character notices keep the newest few', () => {
  const queue = Array.from({ length: OVER_MAX + 2 }, (_, i) => q(i + 1, 'info', { slot: 'over' }));
  assert.deepEqual(overflow(queue).map(t => t.id), [1, 2]);
  assert.equal(slotOf(q(1, 'info')), 'top');
  assert.equal(slotOf(q(1, 'info', { slot: 'over' })), 'over');
});

test('what gets logged on leaving a slot', () => {
  assert.equal(logsOnExit({ kind: 'info' }), true);
  assert.equal(logsOnExit({ kind: 'achievement' }), true);
  assert.equal(logsOnExit({ kind: 'knock_in' }), false, 'the server journals knocks');
  assert.equal(logsOnExit({ kind: 'knock_again' }), false);
  assert.equal(logsOnExit({ kind: 'chat' }), false);
  assert.equal(logsOnExit({ kind: 'chat', log: true }), true);
  assert.equal(logsOnExit({ kind: 'info', log: false }), false);
});

test('merged log is newest first and unread counts the newer ones', () => {
  const server = [{ id: 'a', at: 10, kind: 'call', text: 'x' }, { id: 'b', at: 30, kind: 'call', text: 'y' }];
  const merged = mergeLog(server, [localEntry(1, 'You got a hat', 20)]);
  assert.deepEqual(merged.map(e => e.id), ['b', 'c1', 'a']);
  assert.equal(unreadCount(merged, 15), 2);
  assert.equal(unreadCount(merged, 30), 0);
});
