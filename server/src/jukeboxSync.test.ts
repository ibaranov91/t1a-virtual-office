import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTeachLead, learnLead, playbackRateFor, seekTarget } from '../../client/src/jukeboxSync';

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
test('playback rate has a dead zone and stays within five percent', () => {
  for (const drift of [-.029, 0, .029]) assert.equal(playbackRateFor(drift), 1);
  assert.equal(playbackRateFor(.1), .975); assert.equal(playbackRateFor(-.1), 1.025);
  assert.equal(playbackRateFor(10), .95); assert.equal(playbackRateFor(-10), 1.05);
});
test('only buffered targets with at least half a second ahead teach lead', () => {
  const ranges: [number, number][] = [[0, 2], [5, 8]];
  assert.equal(canTeachLead(ranges, 1.5), true); assert.equal(canTeachLead(ranges, 5), true);
  for (const target of [-1, 1.51, 3, 7.6, 8]) assert.equal(canTeachLead(ranges, target), false);
  assert.equal(canTeachLead([], 0), false);
});
