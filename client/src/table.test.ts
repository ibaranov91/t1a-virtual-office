import test from 'node:test';
import assert from 'node:assert/strict';
import { cellSquare, clock, draughtsMoves, draughtsTaken, fanStep, material, moveRows, sanMoves, squareIndex, squareName } from './table/model';

test('game table: black sees the board turned around, white sees a8 top left', () => {
  assert.equal(squareName(cellSquare(0, false)), 'a8'); assert.equal(squareName(cellSquare(63, false)), 'h1');
  assert.equal(squareName(cellSquare(0, true)), 'h1'); assert.equal(squareName(cellSquare(63, true)), 'a8');
  assert.equal(squareName(cellSquare(56, true)), 'h8');
  for (let q = 0; q < 64; q++) assert.equal(squareIndex(squareName(q)), q);
});

test('game table: move lists read like chess.com and draughts notation', () => {
  const san = sanMoves([{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }, { from: 'g1', to: 'f3' }]);
  assert.deepEqual(san, ['e4', 'e5', 'Nf3']);
  assert.deepEqual(moveRows(san), [[1, 'e4', 'e5'], [2, 'Nf3', undefined]]);
  assert.deepEqual(draughtsMoves([{ from: squareIndex('c3'), path: [squareIndex('d4')], capture: false },
    { from: squareIndex('c3'), path: [squareIndex('e5'), squareIndex('g3')], capture: true }]), ['c3-d4', 'c3:e5:g3']);
});

test('game table: captured pieces and material lead from the position', () => {
  const start = material('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.deepEqual(start, { byWhite: [], byBlack: [], lead: 0 });
  const m = material('rnb1kbnr/pppp1ppp/8/8/8/8/PPPPP1PP/RNBQKBNR w KQkq - 0 1');
  assert.deepEqual(m.byWhite, ['p', 'q']); assert.deepEqual(m.byBlack, ['p']); assert.equal(m.lead, 9);
  assert.deepEqual(draughtsTaken([1, 1, -1, ...Array(61).fill(0)]), { byWhite: 11, byBlack: 10 });
});

test('game table: turn clock and hand fan', () => {
  assert.equal(clock(120_000), '2:00'); assert.equal(clock(61_001), '1:02'); assert.equal(clock(-5), '0:00');
  assert.equal(fanStep(5, 80, 900), 88);                     // room to spare: cards sit side by side
  assert.equal(fanStep(20, 80, 700), (700 - 80) / 19);        // crowded: they overlap to fit
  assert.equal(fanStep(60, 80, 300), 80 * 0.28);              // never more than ~3/4 hidden
});
