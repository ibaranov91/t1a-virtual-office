import test from 'node:test';
import assert from 'node:assert/strict';
import { init, apply, legalMoves, publicView, type DraughtsState } from './draughts';
function at(pieces: Record<number, number>, turn = 0): DraughtsState { const s = init(); s.board.fill(0); for (const [q,p] of Object.entries(pieces)) s.board[+q] = p; s.turn = turn; s.positions = []; return s; }
test('Russian draughts: white starts, men move forward but capture backward; captures are compulsory', () => {
  assert.equal(init().board.filter(Boolean).length, 24); assert.equal(legalMoves(init()).length, 7);
  const s = at({ 35:1, 44:-1, 1:-1, 56:1 });
  assert.deepEqual(legalMoves(s), [{ from:35, path:[53] }]);
  assert.equal(apply(s, 0, { from:56, path:[49] }), null);
  const n = apply(s, 0, { from:35, path:[53] })!; assert.equal(n.board[44], 0); assert.equal(s.board[44], -1);
  assert.equal(apply(s, 1, { from:35, path:[53] }), null);
});
test('Russian draughts: full multi-capture, any sequence, flying kings, captured pieces block until turn ends', () => {
  const s = at({ 49:1, 42:-1, 26:-1, 1:-1 });
  assert.equal(apply(s, 0, { from:49, path:[35] }), null);
  assert.ok(apply(s, 0, { from:49, path:[35,17] }));
  const flying = at({ 56:2, 42:-1, 1:-1 });
  assert.ok(legalMoves(flying).some(m => m.path[0] === 7));
  const barrier = at({ 35:2, 26:-1, 44:-1 });
  const moves = legalMoves(barrier); assert.ok(moves.length > 2); assert.ok(moves.every(m => m.path.length === 1));
  const choice = at({ 35:1, 26:-1, 28:-1, 10:-1, 1:-1 });
  const lengths = new Set(legalMoves(choice).map(m => m.path.length)); assert.ok(lengths.has(1)); assert.ok(lengths.has(2));
  for (const move of legalMoves(choice)) assert.ok(apply(choice, 0, move));
});
test('Russian draughts: promotion during capture continues as a flying king', () => {
  const s = at({ 17:1, 10:-1, 21:-1, 62:-1 });
  const legal = legalMoves(s); assert.ok(legal.some(m => m.path.join(',') === '3,30'));
  assert.equal(apply(s, 0, { from:17, path:[3] }), null);
  const n = apply(s, 0, { from:17, path:[3,30] })!; assert.equal(n.board[30], 2); assert.equal(n.board[10], 0); assert.equal(n.board[21], 0);
});
test('Russian draughts: no pieces/no moves win, king counter resets, third repetition draws', () => {
  const won = apply(at({ 35:1, 26:-1 }), 0, { from:35, path:[17] })!; assert.equal(won.result?.winner, 0);
  const blocked = apply(at({ 56:-1, 17:1 }), 0, { from:17, path:[8] })!; assert.equal(blocked.result?.winner, 0);
  const s = at({ 1:2, 62:-2 }); s.quietKings = 29;
  const move = legalMoves(s)[0], quiet = apply(s,0,move)!; assert.equal(quiet.result?.reason, '15 king moves each');
  const man = at({ 40:1, 7:-2 }); man.quietKings = 29; assert.equal(apply(man,0,{from:40,path:[33]})!.quietKings, 0);
  const repeated = at({ 1:2, 62:-2 }); const once = apply(repeated,0,legalMoves(repeated)[0])!;
  repeated.positions = [ `${once.turn}:${once.board.join(',')}`, `${once.turn}:${once.board.join(',')}` ];
  assert.equal(apply(repeated,0,legalMoves(repeated)[0])!.result?.reason, 'Threefold repetition');
  assert.equal('positions' in publicView(repeated), false);
});
