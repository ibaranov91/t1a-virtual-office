import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTeachLead, clockStep, currentPlay, isAdvancing, learnLead, seekTarget, type ClockInput, type ClockAction } from './jukeboxSync';
import type { JukeboxState } from '../../shared/protocol';

test('seek targets stay before the catalog and element ends', () => {
  assert.equal(seekTarget(99.9, .4, 100, NaN), 99.95);
  assert.equal(seekTarget(99.9, .4, 100, Infinity), 99.95);
  assert.equal(seekTarget(90, .4, 100, 80), 79.95);
  assert.equal(seekTarget(-1, 0, 100, 100), 0);
  assert.equal(seekTarget(0, .4, .02, .02), 0);
});
test('lead learns a constant 0.4 s seek latency in one step', () => {
  const lead = learnLead(0, -.4);
  assert.equal(lead, .4); assert.equal(learnLead(lead, lead - .4), .4);
  assert.equal(learnLead(0, 2), 0); assert.equal(learnLead(0, -2), 1);
});
test('only buffered targets with at least half a second ahead teach lead', () => {
  const ranges: [number, number][] = [[0, 2], [5, 8]];
  assert.equal(canTeachLead(ranges, 1.5), true); assert.equal(canTeachLead(ranges, 5), true);
  for (const target of [-1, 1.51, 3, 7.6, 8]) assert.equal(canTeachLead(ranges, target), false);
  assert.equal(canTeachLead([], 0), false);
});

const clock: ClockInput = { phase: 'starting', advancingMs: 500, sinceStartMs: 1000, drift: 0, trusted: false, seeks: 0 };
const cases: [string, Partial<ClockInput>, ClockAction][] = [
  ['frozen starting clock', { advancingMs: 0, drift: -9 }, { kind: 'wait' }],
  ['frozen live clock', { phase: 'live', advancingMs: 0, drift: 9 }, { kind: 'wait' }],
  ['early behind clock (a stall\'s leftover)', { sinceStartMs: 300, drift: -.101, trusted: true, advancingMs: 200 }, { kind: 'seek', learn: false }],
  ['early slightly behind trusted clock opens', { sinceStartMs: 300, drift: -.1, trusted: true, advancingMs: 200 }, { kind: 'open', learn: false }],
  ['early far ahead clock', { sinceStartMs: 300, drift: 1.01 }, { kind: 'seek', learn: false }],
  ['silent seek limit opens', { sinceStartMs: 300, drift: -9, seeks: 3, advancingMs: 150 }, { kind: 'open', learn: false }],
  ['silent seek limit waits for motion', { sinceStartMs: 300, drift: 9, seeks: 3, advancingMs: 149 }, { kind: 'wait' }],
  ['WebKit early reading opens trusted gate', { sinceStartMs: 300, advancingMs: 200, drift: .37, trusted: true }, { kind: 'open', learn: false }],
  ['trusted start needs enough motion', { sinceStartMs: 300, advancingMs: 149, trusted: true }, { kind: 'wait' }],
  ['untrusted early start waits', { sinceStartMs: 300 }, { kind: 'wait' }],
  ['steady clock needs settling time', { sinceStartMs: 999 }, { kind: 'wait' }],
  ['settled time needs steady motion', { advancingMs: 499 }, { kind: 'wait' }],
  ['settled untrusted close start opens', { drift: .08 }, { kind: 'open', learn: true }],
  ['settled untrusted distant start seeks', { drift: -.081 }, { kind: 'seek', learn: true }],
  ['settled trusted close start opens', { trusted: true, drift: -.08 }, { kind: 'open', learn: true }],
  ['settled trusted distant start seeks (still silent)', { trusted: true, drift: .2 }, { kind: 'seek', learn: true }],
  ['settled seek limit opens', { seeks: 3, drift: -9 }, { kind: 'open', learn: true }],
  ['live early clock waits', { phase: 'live', sinceStartMs: 999, drift: 9 }, { kind: 'wait' }],
  ['live unsteady clock waits', { phase: 'live', advancingMs: 499, drift: -9 }, { kind: 'wait' }],
  ['live distant clock seeks', { phase: 'live', drift: -.101 }, { kind: 'seek', learn: true }],
  ['live close clock holds', { phase: 'live', drift: .1 }, { kind: 'hold', learn: true }],
  ['live aligned clock holds', { phase: 'live' }, { kind: 'hold', learn: true }],
];
for (const [name, input, expected] of cases) test(name, () => assert.deepEqual(clockStep({ ...clock, ...input }), expected));

test('advancing rejects freezes, backward time and jumps, accounting for playback rate', () => {
  const prev = { ct: 2, at: 1000 };
  assert.equal(isAdvancing(prev, 2.1, 1100, 1), true);
  assert.equal(isAdvancing(prev, 2.05, 1100, .5), true);
  assert.equal(isAdvancing(prev, 2, 1100, 1), false);
  assert.equal(isAdvancing(prev, 3, 1100, 1), false);
  assert.equal(isAdvancing(prev, 2.1, 1000, 1), false);
  assert.equal(isAdvancing(prev, 2.1, 900, 1), false);
  assert.equal(isAdvancing(prev, 1.9, 1100, 1), false);
  assert.equal(isAdvancing(prev, 2.02, 1100, 1), false);
});

const state: JukeboxState = { playId: 'p', track: 'a', by: null, startedAt: 1000, pausedAt: null, next: 'b', queue: [], last: null };
const duration = (id: string) => ({ a: 2000, b: 4000 })[id];
test('current play preserves paused position and has no end', () => {
  assert.deepEqual(currentPlay({ ...state, pausedAt: 700 }, duration, 9000), {
    key: 'a@paused', track: 'a', startedAt: 1000, paused: true, positionMs: 700, endsAt: Infinity, next: 'b', predicted: false,
  });
});
test('current play follows the server clock and clamps a future start', () => {
  assert.deepEqual(currentPlay(state, duration, 1500), {
    key: 'a@1000', track: 'a', startedAt: 1000, paused: false, positionMs: 500, endsAt: 3000, next: 'b', predicted: false,
  });
  assert.equal(currentPlay(state, duration, 500)?.positionMs, 0);
});
test('predicted successor shares the announced successor key', () => {
  const predicted = currentPlay(state, duration, 3100);
  assert.deepEqual(predicted, { key: 'b@3000', track: 'b', startedAt: 3000, paused: false, positionMs: 100, endsAt: 7000, next: undefined, predicted: true });
  assert.equal(predicted?.key, currentPlay({ ...state, track: 'b', startedAt: 3000 }, duration, 3100)?.key);
  assert.equal(currentPlay(state, duration, 3000)?.positionMs, 0);
  assert.equal(currentPlay(state, duration, 7000), null);
});
test('current play rejects missing or unknown tracks and successors', () => {
  assert.equal(currentPlay(undefined, duration, 1500), null);
  assert.equal(currentPlay({ ...state, track: 'unknown' }, duration, 1500), null);
  assert.equal(currentPlay({ ...state, next: undefined }, duration, 3000), null);
  assert.equal(currentPlay({ ...state, next: 'unknown' }, duration, 3000), null);
});
