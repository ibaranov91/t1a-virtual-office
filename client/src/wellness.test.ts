import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceWellness, createWellness, reduceWellness, restoreWellness, wellnessRequests, pendingWellness } from './wellness';

test('reminders are opt-in; one overdue reminder survives a long sleep until answered', () => {
  let s = createWellness();
  assert.deepEqual(wellnessRequests(s), []);
  s = reduceWellness(s, { type: 'enable', kind: 'water', enabled: true }, 1_000);
  assert.equal(s.water.nextAt, 1_801_000);
  assert.deepEqual(pendingWellness(s, 1_800_999), []);
  assert.deepEqual(pendingWellness(s, 86_400_000), ['water']);
  s = advanceWellness(s, 86_400_000);
  assert.equal(wellnessRequests(s).length, 1);
  s = reduceWellness(s, { type: 'done', kind: 'water' }, 86_400_000);
  assert.equal(s.water.nextAt, 88_200_000);
  assert.deepEqual(pendingWellness(s, 86_400_000), []);
});

test('snooze, interval changes and disabling replace or cancel the scheduled alert', () => {
  let s = reduceWellness(createWellness(), { type: 'enable', kind: 'stretch', enabled: true }, 0);
  s = reduceWellness(s, { type: 'snooze', kind: 'stretch' }, 4_000_000);
  assert.equal(s.stretch.nextAt, 4_300_000);
  s = reduceWellness(s, { type: 'interval', kind: 'stretch', minutes: 45 }, 4_000_000);
  assert.equal(s.stretch.nextAt, 6_700_000);
  s = reduceWellness(s, { type: 'enable', kind: 'stretch', enabled: false }, 4_000_000);
  assert.deepEqual(wellnessRequests(s), []);
  s = reduceWellness(s, { type: 'done', kind: 'stretch' }, 4_100_000);
  assert.equal(s.stretch.nextAt, null);
});

test('Pomodoro pause/resume uses elapsed wall time and completes only once after sleep', () => {
  let s = reduceWellness(createWellness(), { type: 'start' }, 1_000);
  s = reduceWellness(s, { type: 'pause' }, 61_000);
  assert.equal(s.pomodoro.remainingMs, 1_440_000);
  assert.deepEqual(wellnessRequests(s), []);
  s = reduceWellness(s, { type: 'start' }, 3_000_000);
  assert.equal(s.pomodoro.endsAt, 4_440_000);
  s = advanceWellness(s, 9_000_000);
  assert.equal(s.pomodoro.status, 'finished');
  assert.equal(s.pomodoro.rounds, 1);
  assert.equal(advanceWellness(s, 10_000_000).pomodoro.rounds, 1);
  assert.deepEqual(pendingWellness(s, 10_000_000), ['pomodoro']);
  s = reduceWellness(s, { type: 'next' }, 10_000_000);
  assert.equal(s.pomodoro.phase, 'short');
  assert.equal(s.pomodoro.endsAt, 10_300_000);
});

test('the fourth completed focus session offers a long break; reset cancels the deadline', () => {
  let s = createWellness();
  for (let round = 0; round < 4; round++) {
    s = reduceWellness(s, { type: 'phase', phase: 'focus' }, 0);
    s = reduceWellness(s, { type: 'start' }, 0);
    s = advanceWellness(s, 1_500_000);
  }
  assert.equal(s.pomodoro.rounds, 4);
  s = reduceWellness(s, { type: 'next' }, 2_000_000);
  assert.equal(s.pomodoro.phase, 'long');
  assert.equal(s.pomodoro.endsAt, 2_900_000);
  s = reduceWellness(s, { type: 'reset' }, 2_000_001);
  assert.equal(s.pomodoro.remainingMs, 900_000);
  assert.deepEqual(wellnessRequests(s), []);
});

test('restore keeps deadlines across reloads, repairs corrupt storage, and rejects invalid durations', () => {
  let s = reduceWellness(createWellness(), { type: 'enable', kind: 'water', enabled: true }, 1_000);
  s = reduceWellness(s, { type: 'start' }, 1_000);
  const restored = restoreWellness(JSON.parse(JSON.stringify(s)), 2_000_000);
  assert.equal(restored.water.nextAt, 1_801_000);
  assert.equal(restored.pomodoro.status, 'finished');
  assert.equal(restored.pomodoro.rounds, 1);
  for (const invalid of [null, [], { version: 99 }, { version: 1, water: { enabled: true, intervalMin: -5, nextAt: 'bad' }, pomodoro: { status: 'running', endsAt: null } }]) {
    const recovered = restoreWellness(invalid, 1_000);
    for (const r of wellnessRequests(recovered)) assert.ok(Number.isFinite(r.at) && r.at > 0);
    assert.ok(recovered.pomodoro.remainingMs > 0);
  }
  const before = createWellness();
  for (const minutes of [0, -1, Infinity, NaN, 181]) {
    assert.deepEqual(reduceWellness(before, { type: 'interval', kind: 'water', minutes }, 0), before);
  }
});

test('receiving a running timer from another tab never rewrites its saved state just because time passed', () => {
  let s = reduceWellness(createWellness(), { type: 'start' }, 1_000);
  s = reduceWellness(s, { type: 'pause' }, 61_000);
  s = reduceWellness(s, { type: 'start' }, 100_000);
  const saved = JSON.stringify(s);
  assert.equal(JSON.stringify(restoreWellness(JSON.parse(saved), 200_000)), saved);
  assert.equal(JSON.stringify(restoreWellness(JSON.parse(saved), 300_000)), saved);
});
