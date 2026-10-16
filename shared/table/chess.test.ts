import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { apply, init, publicView, position, outcome, type ChessState } from './chess';
function play(moves: string[]): ChessState {
  let s = init(); for (const uci of moves) { const next = apply(s, s.turn, { from: uci.slice(0,2), to: uci.slice(2,4), promotion: uci[4] }); assert.ok(next, uci); s = next; } return s;
}
test('chess.js imports under tsx: legal moves, immutable history, turn validation and mate', () => {
  assert.equal(new Chess().moves().length, 20);
  const start = init(); assert.equal(apply(start, 1, { from: 'e2', to: 'e4' }), null); assert.equal(apply(start, 0, { from: 'e2', to: 'e5' }), null);
  const s = play(['f2f3','e7e5','g2g4','d8h4']); assert.deepEqual(s.result, { winner: 1, reason: 'Checkmate' });
  assert.equal(apply(s, 0, { from: 'a2', to: 'a3' }), null); assert.deepEqual(start.moves, []);
  assert.equal(position(s).isCheckmate(), true); assert.deepEqual(publicView(s).legal, []);
});
test('chess: castling, en passant, explicit promotion and replayed repetition', () => {
  const castle = play(['e2e4','e7e5','g1f3','b8c6','f1c4','g8f6','e1g1']); assert.equal(position(castle).get('f1')?.type, 'r');
  const ep = play(['e2e4','a7a6','e4e5','d7d5','e5d6']); assert.equal(position(ep).get('d5'), undefined);
  const promotion = play(['a2a4','h7h5','a4a5','h5h4','a5a6','h4h3','a6b7','h3g2']);
  assert.equal(apply(promotion, 0, { from:'b7', to:'a8' }), null);
  assert.equal(position(apply(promotion, 0, { from:'b7', to:'a8', promotion:'n' })!).get('a8')?.type, 'n');
  const repeat = play(['g1f3','g8f6','f3g1','f6g8','g1f3','g8f6','f3g1','f6g8']); assert.equal(repeat.result?.reason, 'Threefold repetition');
});
test('chess: automatic stalemate, insufficient material and fifty-move rule', () => {
  assert.equal(outcome(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'))?.reason, 'Stalemate');
  assert.equal(outcome(new Chess('7k/8/6K1/8/8/8/8/8 w - - 0 1'))?.reason, 'Insufficient material');
  assert.equal(outcome(new Chess('7k/8/6K1/8/8/8/8/R7 w - - 100 51'))?.reason, '50-move rule');
});
