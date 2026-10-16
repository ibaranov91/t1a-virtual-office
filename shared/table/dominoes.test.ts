import test from 'node:test';
import assert from 'node:assert/strict';
import { init, apply, legalMoves, leave, publicView, privateView, tiles, type DominoesState, type Domino } from './dominoes';
const tile = (a:number,b:number): Domino => tiles().find(t => t.a === a && t.b === b)!;
test('dominoes: deterministic double-six deal, highest double first and correct boneyard', () => {
  assert.equal(tiles().length, 28);
  for (const n of [2,3,4]) for (let seed=0;seed<30;seed++) {
    const s = init(seed,n); assert.deepEqual(s,init(seed,n)); assert.deepEqual(s.hands.map(h=>h.length),Array(n).fill(7)); assert.equal(s.boneyard.length,28-n*7);
    const doubles = s.hands.flat().filter(t=>t.a===t.b), dealt = s.hands.flat();
    const best = [...(doubles.length?doubles:dealt)].sort((a,b)=>b.a+b.b-a.a-a.b||b.b-a.b)[0];
    assert.equal(s.first,best.id); assert.deepEqual(legalMoves(s).map(m=>m.tile),[best.id]);
  }
  const noDouble = Array.from({length:10000},(_,i)=>init(i,2)).find(s=>!s.hands.flat().some(t=>t.a===t.b)); assert.ok(noDouble);
  assert.equal(noDouble.first,[...noDouble.hands.flat()].sort((a,b)=>b.a+b.b-a.a-a.b||b.b-a.b)[0].id);
});
function fixture(): DominoesState { return { hands:[[tile(1,3),tile(2,2)],[tile(3,5)]],boneyard:[tile(3,4)],chain:[tile(6,6)],active:[true,true],passes:0,first:27,turn:0,ply:0,result:null }; }
test('dominoes: only draw when stuck; draw one at a time, must play, endpoints orient, empty hand wins', () => {
  const s=fixture(); assert.equal(apply(s,0,{kind:'pass'}),null); const drawn=apply(s,0,{kind:'draw'})!; assert.equal(drawn.hands[0].length,3); assert.equal(drawn.turn,0);
  const match=fixture(); match.chain=[tile(3,3)]; assert.equal(apply(match,0,{kind:'draw'}),null); assert.equal(apply(match,0,{kind:'pass'}),null);
  const left=apply(match,0,{kind:'play',tile:tile(1,3).id,end:'left'})!; assert.equal(left.chain[0].b,3);
  const right=apply(match,0,{kind:'play',tile:tile(1,3).id,end:'right'})!; assert.equal(right.chain.at(-1)!.a,3);
  match.turn=1; assert.equal(apply(match,1,{kind:'play',tile:tile(3,5).id,end:'right'})!.result?.winner,1);
});
test('dominoes: blocked game lowest pips, ties draw; leavers retain private hands outside the boneyard', () => {
  const s=fixture(); s.boneyard=[];
  const n=apply(apply(s,0,{kind:'pass'})!,1,{kind:'pass'})!; assert.equal(n.result?.winner,null);
  s.hands[0]=[tile(0,1)]; assert.equal(apply(apply(s,0,{kind:'pass'})!,1,{kind:'pass'})!.result?.winner,0);
  s.hands[0]=[tile(0,3),tile(2,3)]; assert.equal(apply(apply(s,0,{kind:'pass'})!,1,{kind:'pass'})!.result?.winner,null);
  const three=init(42,3), hand=structuredClone(three.hands[1]), yard=three.boneyard.length, out=leave(three,1); assert.deepEqual(out.hands[1],hand); assert.equal(out.boneyard.length,yard);
  assert.equal('hands' in publicView(three),false); assert.equal('hand' in privateView(out,1),false); assert.deepEqual(privateView(three,0).hand,three.hands[0]);
});
