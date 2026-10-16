import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BIT, BOOT, bitAt, makePlan, split, sweepAt, walkerAt, type Layout } from './logo';

// "The Deck"-shaped stand-in: 7 letters, 4×6 bits each, a word gap after the third
const letters = Array.from({ length: 7 }, (_, i) => ({ x: 12 + i * 10 + (i > 2 ? 4 : 0), w: 9 }));
const L: Layout = {
  w: 150, h: 42, floor: 42, letters,
  bits: letters.flatMap((l, li) => Array.from({ length: 24 }, (_, k) => ({ sx: 0, sy: 0, x: l.x + (k % 4) * BIT, y: 16 + Math.floor(k / 4) * BIT, letter: li }))),
  ink: { x0: 12, x1: 90, y0: 16, y1: 28 }, cursor: { x: 12, y: 29 },
};
const p = makePlan(L, 42);

test('the letters split into contiguous groups of similar work', () => {
  assert.deepEqual(split([18, 22, 20, 24, 20, 16, 22], 3), [[0, 1], [2, 3, 4], [5, 6]]);
  assert.deepEqual(split([5, 5], 3), [[0], [1]]);
  assert.deepEqual(split([1, 1, 1, 1, 1, 1], 3), [[0, 1], [2, 3], [4, 5]]);
  assert.deepEqual(p.walkers.flatMap(w => w.letters).sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test('every bit is tossed by the crew member standing under its letter, and lands before the ta-da', () => {
  L.bits.forEach((b, i) => {
    const s = p.tosses[i];
    assert.ok(s.at >= BOOT && s.land > s.at && s.land <= p.buildEnd && p.buildEnd < p.tada);
    const w = p.walkers.findIndex(w => w.letters.includes(b.letter)), pose = walkerAt(p, L, w, s.at);
    assert.equal(pose?.dir, 'up', `bit ${i}`);
    assert.ok(Math.abs(pose!.x - (L.letters[b.letter].x + L.letters[b.letter].w / 2)) <= 1);
    for (let t = s.at; t < s.land; t += 40) { // in the air, it stays on the canvas
      const f = bitAt(p, L, i, t);
      assert.equal(f.state, 'fly');
      assert.ok(f.y >= 0 && f.y <= L.floor && f.x >= 0 && f.x <= L.w);
    }
  });
});

test('the crew faces the room for the ta-da, then leaves; the logo rests whole with nobody on stage', () => {
  for (let i = 0; i < p.walkers.length; i++) assert.equal(walkerAt(p, L, i, p.tada + 100)?.dir, 'down');
  assert.ok(p.code - p.exitEnd >= 60_000 && p.code - p.exitEnd <= 90_000);
  for (const t of [p.exitEnd, (p.exitEnd + p.code) / 2, p.code - 1]) {
    for (let i = 0; i < p.walkers.length; i++) assert.equal(walkerAt(p, L, i, t), null);
    L.bits.forEach((b, i) => assert.deepEqual(bitAt(p, L, i, t), { x: b.x, y: b.y, state: 'set', alpha: 1 }));
  }
});

test('the code sweeps left to right, and nothing is left when the cycle ends', () => {
  assert.ok(sweepAt(p, p.code + 10) && !sweepAt(p, p.code - 1));
  L.bits.forEach((a, i) => L.bits.forEach((b, j) => {
    if (b.x - a.x > 6) assert.ok(p.falls[i].hit < p.falls[j].hit, `${i} before ${j}`);
  }));
  for (let t = p.code; t < p.end; t += 50) L.bits.forEach((_, i) => assert.ok(bitAt(p, L, i, t).y <= L.floor - BIT + 1e-9));
  L.bits.forEach((_, i) => assert.equal(bitAt(p, L, i, p.end - 1).state, 'off'));
});

test('a plan is a pure function of layout and seed', () => {
  assert.deepEqual(makePlan(L, 42), p);
  assert.notDeepEqual(makePlan(L, 43).tosses, p.tosses);
});
