import test from 'node:test';
import assert from 'node:assert/strict';
import { init, cards, apply, leave, timeout, publicView, privateView, type LastCardState, type Card, type Colour, type Symbol } from './lastcard';
const c = (colour:Colour|null,symbol:Symbol):Card => cards().find(c=>c.colour===colour&&c.symbol===symbol)!;
function fixture(n=3):LastCardState {
  const s=init(42,n); s.hands=Array.from({length:n},(_,i)=>[c('red',String(i+1) as Symbol),c('blue','9')]);
  s.pile=[c('yellow','5'),c('green','6'),c('blue','3'),c('green','8'),c('yellow','8'),c('blue','7')]; s.discards=[c('red','0')]; s.colour='red'; s.turn=0; s.direction=1; s.drawn=null; s.catchable=null; return s;
}
const play = (s:LastCardState,card:Card,extra={}) => apply(s,s.turn,{kind:'play',card:card.id,...extra});
test('Last Card: 108-card deterministic deal, number opening, no hidden information in public view', () => {
  assert.equal(cards().length,108); assert.equal(new Set(cards().map(c=>c.id)).size,108);
  for (const n of [2,3,4]) for(let seed=0;seed<20;seed++) {
    const s=init(seed,n); assert.deepEqual(s,init(seed,n)); assert.ok(/^\d$/.test(s.discards.at(-1)!.symbol)); assert.ok(s.hands.every(h=>h.length===7));
    assert.equal(s.pile.length+s.discards.length+s.hands.flat().length,108);
    assert.equal('hands' in publicView(s),false); assert.equal('rng' in publicView(s),false); assert.deepEqual(privateView(s,1).hand,s.hands[1]);
  }
});
test('Last Card: matches colour or symbol; wild colour required; +4 always allowed; no stacking', () => {
  const s=fixture(); s.hands[0]=[c('blue','0'),c(null,'wild'),c(null,'four')];
  assert.ok(play(s,c('blue','0'))); assert.equal(play(s,c(null,'wild')),null); assert.equal(play(s,c(null,'wild'),{colour:'purple'}),null);
  assert.equal(play(s,c(null,'wild'),{colour:'green'})!.colour,'green');
  const four=play(s,c(null,'four'),{colour:'blue'})!; assert.equal(four.turn,2); assert.equal(four.hands[1].length,6);
  assert.equal(apply(four,1,{kind:'play',card:c('red','2').id}),null);
});
test('Last Card: Skip, Reverse (including two players), Draw Two and final special without effect', () => {
  for (const [symbol,turn,direction,growth] of [['skip',2,1,0],['reverse',2,-1,0],['two',2,1,2]] as const) {
    const s=fixture(); s.hands[0]=[c('red',symbol),c('blue','9')]; const n=play(s,s.hands[0][0])!;
    assert.equal(n.turn,turn); assert.equal(n.direction,direction); assert.equal(n.hands[1].length,2+growth);
  }
  const two=fixture(2); two.hands[0]=[c('red','reverse'),c('blue','9')]; assert.equal(play(two,two.hands[0][0])!.turn,0);
  const last=fixture(); last.hands[0]=[c('red','two')]; const won=play(last,last.hands[0][0])!; assert.equal(won.result?.winner,0); assert.equal(won.hands[1].length,2);
});
test('Last Card: draw once; playable draw may be played or passed, other cards are forbidden; unplayable passes', () => {
  const s=fixture(); s.pile.unshift(c('red','7')); const n=apply(s,0,{kind:'draw'})!; assert.equal(n.turn,0); assert.equal(n.drawn,c('red','7').id);
  assert.equal(apply(n,0,{kind:'draw'}),null); assert.equal(play(n,c('red','1')),null); assert.ok(play(n,c('red','7')));
  assert.equal(apply(n,0,{kind:'pass'})!.turn,1); assert.equal(apply(s,0,{kind:'pass'}),null);
  assert.equal(apply(fixture(),0,{kind:'draw'})!.turn,1);
  assert.equal(privateView(n,1).drawn,null);
});
test('Last Card: reshuffle except top; deterministic state, finite empty pile, leavers never reshuffled', () => {
  const s=fixture(); s.pile=[]; s.discards=[c('yellow','7'),c('blue','8'),c('red','0')];
  const a=apply(s,0,{kind:'draw'})!, b=apply(s,0,{kind:'draw'})!; assert.deepEqual(a,b); assert.deepEqual(a.discards,[c('red','0')]);
  assert.equal(a.hands[0].length,3); assert.equal(a.pile.length,1);
  const out=leave(s,1); assert.deepEqual(out.hands[1],s.hands[1]); assert.equal('hand' in privateView(out,1),false);
  assert.equal(apply(out,1,{kind:'catch'}),null); const empty=fixture(); empty.pile=[]; assert.equal(apply(empty,0,{kind:'draw'})!.turn,1);
});
test('Last Card: catch is free but only before the next accepted action; declaration and winner prevent catch', () => {
  const s=fixture(), n=play(s,s.hands[0][0])!; assert.equal(n.catchable,0);
  assert.equal(apply(n,0,{kind:'catch'}),null); assert.equal(apply(n,1,{kind:'play',card:-1}),null); assert.equal(n.catchable,0);
  const caught=apply(n,2,{kind:'catch'})!; assert.equal(caught.turn,n.turn); assert.equal(caught.hands[0].length,3); assert.equal(caught.catchable,null);
  assert.equal(apply(caught,1,{kind:'catch'}),null);
  const passed=apply(n,1,{kind:'draw'})!; assert.equal(passed.catchable,null);
  assert.equal(play(s,s.hands[0][0],{lastCard:true})!.catchable,null);
  const final=fixture(); final.hands[0]=[final.hands[0][0]]; assert.equal(play(final,final.hands[0][0])!.catchable,null);
  assert.equal(timeout(s).hands[0].length,3); assert.equal(timeout(s).turn,1);
});
