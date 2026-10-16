import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import type { TileMap, Tile } from '../../shared/map';
import { DRINKS, EMPTY_DROP_DRUNK_MS, EMPTY_DROP_MS } from '../../shared/drinks';
import type { ServerMsg } from '../../shared/protocol';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const COUNTER = { x: 30, y: 3 }; // a table tile in the Coffee room
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const w = new World(structuredClone(map));
  // small steps: a timer set inside a timer callback is scheduled from the end of the mocked tick
  const tick = (ms: number) => { for (let left = ms; left > 0; left -= 50) t.mock.timers.tick(Math.min(50, left)); };
  const person = (name: string, tile: Tile = { x: 32, y: 8 }) => {
    const u = w.addUser(name, false, tile); u.presence = 'online';
    const messages: ServerMsg[] = [], { socket } = w.connect(u.id, m => messages.push(m));
    return { u, messages, socket, send: (msg: Parameters<World['handle']>[1]) => w.handle(u, msg, socket) };
  };
  const machine = w.map.objects.find(o => o.type === 'coffee_machine')!;
  const bar = w.map.objects.find(o => o.type === 'beach_bar')!;
  return { w, tick, person, machine, bar };
}
const has = (u: { effects: { kind: string }[] }, kind: string) => u.effects.some(e => e.kind === kind);

test('coffee gives nothing on take; it sips itself after autoSipMs, then the buff and an empty cup', t => {
  const { w, tick, person, machine } = setup(t), a = person('A');
  w.use(a.u, machine.id); tick(10_000);
  assert.equal(a.u.holding, 'coffee');
  assert.equal(has(a.u, 'speed'), false, 'taking is not drinking');
  w.setHolding(a.u, 'coffee', machine.id); // restart the clock to time it exactly
  tick(DRINKS.coffee.autoSipMs! - 1);
  assert.equal(a.messages.some(m => m.t === 'holding' && m.phase === 'drinking'), false);
  tick(1);
  assert.ok(a.messages.some(m => m.t === 'holding' && m.userId === a.u.id && m.item === 'coffee' && m.phase === 'drinking'), 'everyone sees the sip');
  assert.equal(has(a.u, 'speed'), false, 'the buff comes when the sip ends');
  tick(DRINKS.coffee.sipMs);
  assert.equal(has(a.u, 'speed'), true);
  assert.equal(a.u.holding, 'empty:coffee');
});

test('a cocktail never sips itself; Drink makes you drunk and leaves the glass', t => {
  const { w, tick, person, bar } = setup(t), a = person('A', { x: bar.x, y: bar.y + bar.h });
  w.use(a.u, bar.id, 'cocktail'); tick(1250);
  assert.equal(a.u.holding, 'cocktail');
  tick(10 * 60_000);
  assert.equal(a.u.holding, 'cocktail', 'still carrying it: no auto-sip, no vanishing');
  assert.equal(has(a.u, 'drunk'), false);
  a.send({ t: 'drink' }); a.send({ t: 'drink' }); // a second Drink mid-sip does nothing
  tick(DRINKS.cocktail.sipMs);
  assert.equal(a.u.effects.find(e => e.kind === 'drunk')?.data?.level, 1);
  assert.equal(a.u.holding, 'empty:cocktail');
  a.send({ t: 'drink' }); tick(5000);
  assert.equal(a.u.effects.find(e => e.kind === 'drunk')?.data?.level, 1, 'an empty glass gives nothing');
});

test('handing a drink over mid-sip cancels the sip; empty cups cannot be handed over', t => {
  const { w, tick, person, machine } = setup(t), a = person('A'), b = person('B', { x: 33, y: 8 });
  w.setHolding(a.u, 'coffee', machine.id);
  a.send({ t: 'drink' }); tick(1000);
  w.give(a.u, b.u); tick(DRINKS.coffee.sipMs);
  assert.equal(has(a.u, 'speed'), false); assert.equal(has(b.u, 'speed'), false);
  assert.equal(b.u.holding, 'coffee', 'the new holder gets a fresh coffee with its own timer');
  tick(DRINKS.coffee.autoSipMs! + DRINKS.coffee.sipMs);
  assert.equal(has(b.u, 'speed'), true); assert.equal(b.u.holding, 'empty:coffee');
  w.give(b.u, a.u);
  assert.equal(a.u.holding, null); assert.equal(b.u.holding, 'empty:coffee');
});

test('an empty cup goes on a table, and your own cup comes back into your hand', t => {
  const { w, tick, person } = setup(t), a = person('A'), b = person('B', { x: 33, y: 8 });
  w.setHolding(a.u, 'empty:tea');
  a.send({ t: 'cup_put', tile: COUNTER }); tick(10_000);
  assert.equal(a.u.holding, null);
  const cup = w.creatures.cups.at(-1)!;
  assert.equal(cup.item, 'tea'); assert.equal(cup.by, a.u.id); assert.equal(cup.floor, undefined);
  a.u.tile = { x: 32, y: 8 }; a.u.move = null; a.u.path = null; // out of the way
  b.send({ t: 'cup_take', cupId: cup.id }); tick(10_000);
  assert.equal(b.u.holding, null, 'somebody else tidies it away');
  assert.equal(w.creatures.cups.some(c => c.id === cup.id), false);
  b.u.tile = { x: 33, y: 8 }; b.u.move = null; b.u.path = null;
  w.setHolding(a.u, 'empty:tea');
  a.send({ t: 'cup_put', tile: COUNTER }); tick(10_000);
  const mine = w.creatures.cups.at(-1)!;
  a.send({ t: 'cup_take', cupId: mine.id }); tick(10_000);
  assert.equal(a.u.holding, 'empty:tea', 'picked it back up');
  assert.equal(a.u.achievements.tidy, undefined, 'no praise for taking your own cup');
});

test('an empty cup slips to the floor where you stand after EMPTY_DROP_MS (sooner drunk); drop does it at once', t => {
  const { w, tick, person } = setup(t), a = person('A'), b = person('B', { x: 34, y: 8 });
  w.setHolding(a.u, 'empty:coffee');
  tick(EMPTY_DROP_MS - 1); assert.equal(a.u.holding, 'empty:coffee');
  tick(1);
  assert.equal(a.u.holding, null);
  const cup = w.creatures.cups.at(-1)!;
  assert.deepEqual({ tile: cup.tile, item: cup.item, floor: cup.floor, by: cup.by }, { tile: a.u.tile, item: 'coffee', floor: true, by: a.u.id });
  w.addEffect(b.u, 'drunk');
  w.setHolding(b.u, 'empty:beer');
  tick(EMPTY_DROP_DRUNK_MS); assert.equal(b.u.holding, null);
  assert.equal(w.creatures.cups.at(-1)?.item, 'beer');
  w.setHolding(a.u, 'empty:wine'); a.send({ t: 'drop' });
  assert.equal(a.u.holding, null);
  const wine = w.creatures.cups.at(-1)!;
  assert.equal(wine.item, 'wine'); assert.equal(wine.floor, true);
  assert.ok(Math.abs(wine.tile.x - a.u.tile.x) + Math.abs(wine.tile.y - a.u.tile.y) === 1, 'a cup was already under their feet: it rolls next to it');
  w.setHolding(a.u, 'empty:tea'); a.u.instance = 'meeting:x'; a.send({ t: 'drop' });
  assert.equal(a.u.holding, null); assert.notEqual(w.creatures.cups.at(-1)?.item, 'tea', 'no floor cups in a meeting room');
});

test('bots drink their bar cocktails by themselves (no Drink button), still without the drunk effect', t => {
  const { w, tick } = setup(t), bot = w.addUser('Bot', true, { x: 32, y: 8 });
  w.setHolding(bot, 'cocktail');
  tick(60_000);
  assert.equal(bot.holding, 'empty:cocktail'); assert.equal(has(bot, 'drunk'), false);
});

test('handing a full cocktail to someone makes you the designated driver', t => {
  const { w, person } = setup(t), a = person('A'), b = person('B', { x: 33, y: 8 });
  w.setHolding(a.u, 'cocktail'); w.give(a.u, b.u);
  assert.equal(b.u.holding, 'cocktail'); assert.ok(a.u.achievements.designated);
});
