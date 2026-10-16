import test from 'node:test';
import assert from 'node:assert/strict';
import { bestOffset, clockSample, CLOCK_SAMPLES } from './clockSync';

test('a sample puts the server reading at the middle of the round trip', () => {
  assert.deepEqual(clockSample(1000, 100, 5050), { rtt: 100, offset: 4000 });
  for (const rtt of [-1, 10_001, NaN]) assert.equal(clockSample(1000, rtt, 5000), null);
  assert.equal(clockSample(1000, 10, NaN), null);
});
test('the offset comes from the shortest round trip among the recent samples', () => {
  assert.equal(bestOffset([]), null);
  assert.equal(bestOffset([{ rtt: 300, offset: 120 }, { rtt: 40, offset: 7 }, { rtt: 90, offset: 30 }]), 7);
  const old = { rtt: 1, offset: 999 }, recent = Array.from({ length: CLOCK_SAMPLES }, (_, i) => ({ rtt: 50 + i, offset: i }));
  assert.equal(bestOffset([old, ...recent]), 0); // a stale best reading ages out (clocks drift)
});
