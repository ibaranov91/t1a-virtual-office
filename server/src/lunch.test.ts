import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUP_LINGER_MS, CLEAN_MS, Creatures } from './creatures';
import { World, type User } from './world';
import { picnicSeat, LUNCH_MS, MAX_PLATES, isPlate } from '../../shared/lunch';
import type { TileMap, Tile } from '../../shared/map';
import { MAX_CUPS, type ServerMsg } from '../../shared/protocol';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const chairs = map.objects.filter(o => o.type === 'chair' && picnicSeat(map, o));
const table = picnicSeat(map, chairs[0])!.table;
const mine = chairs.filter(c => picnicSeat(map, c)!.table.id === table.id); // chairs of one table

function setup(t: TestContext, n = 2) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const people = Array.from({ length: n }, (_, i) => {
    const u = w.addUser(`P${i}`, false, { x: 33, y: 29 }); u.presence = 'online';
    const msgs: ServerMsg[] = [];
    const { socket } = w.connect(u.id, m => msgs.push(m));
    return { u, msgs, socket };
  });
  return { w, people };
}
const eating = (u: User) => u.eating; // a function, so earlier asserts don't narrow it
const eat = (t: TestContext, w: World, p: { u: User; socket: string }, chair: Tile, open: boolean, food = 'ramen') => {
  w.setHolding(p.u, food);
  w.handle(p.u, { t: 'lunch', tile: { x: chair.x, y: chair.y }, open }, p.socket);
  t.mock.timers.tick(15_000);
};

test('the terrace has picnic tables with chairs on both sides, a food cart with four dishes', () => {
  assert.ok(map.rooms.some(r => r.id === 'terrace'));
  const sides = new Set(mine.map(c => Math.sign(c.y - table.y)));
  assert.deepEqual([...sides].sort(), [-1, 1], 'chairs above and below the table');
  const cart = map.objects.find(o => o.type === 'food_cart')!;
  assert.deepEqual(cart.use && cart.use.kind === 'take' && cart.use.items.map(i => i.id), ['sandwich', 'ramen', 'salad', 'pizza']);
});

test('lunch: take food, sit at a picnic chair, a plate lands on the table and your hands are empty', (t: TestContext) => {
  const { w, people: [a] } = setup(t, 1);
  w.handle(a.u, { t: 'lunch', tile: mine[0], open: false }, a.socket);
  assert.equal(eating(a.u), undefined, 'not holding anything');
  const cart = map.objects.find(o => o.type === 'food_cart')!;
  w.handle(a.u, { t: 'use', objectId: cart.id, item: 'ramen' }, a.socket);
  t.mock.timers.tick(15_000);
  assert.equal(a.u.holding, 'ramen');
  w.handle(a.u, { t: 'lunch', tile: { x: 33, y: 29 }, open: false }, a.socket);
  assert.equal(a.u.holding, 'ramen', 'only picnic chairs will do');
  w.handle(a.u, { t: 'lunch', tile: { x: mine[0].x, y: mine[0].y }, open: true }, a.socket);
  t.mock.timers.tick(15_000);
  assert.equal(a.u.holding, null);
  assert.deepEqual(a.u.tile, { x: mine[0].x, y: mine[0].y });
  assert.equal(eating(a.u)?.item, 'ramen'); assert.equal(eating(a.u)?.open, true);
  assert.equal(eating(a.u)!.until - Date.now() <= LUNCH_MS, true);
  const plate = w.creatures.cups.find(c => isPlate(c.item))!;
  assert.equal(plate.item, 'plate:ramen');
  assert.deepEqual(plate.tile, picnicSeat(map, mine[0])!.front, 'right in front of you');
  const snap = w.snapshot();
  assert.ok(snap.t === 'state' && snap.users.find(p => p.id === a.u.id)?.eating?.item === 'ramen', 'public');
  // lunch ends by itself, the plate stays
  t.mock.timers.tick(LUNCH_MS);
  w.lunchTick();
  assert.equal(eating(a.u), undefined);
  assert.equal(w.creatures.cups.filter(c => isPlate(c.item)).length, 1);
});

test('standing up and walking away ends lunch; open can be toggled while eating', (t: TestContext) => {
  const { w, people: [a] } = setup(t, 1);
  eat(t, w, a, mine[0], false);
  assert.equal(eating(a.u)?.open, false);
  w.handle(a.u, { t: 'lunch_open', open: true }, a.socket);
  assert.equal(eating(a.u)?.open, true);
  assert.ok(a.msgs.some(m => m.t === 'eating' && m.eating?.open === true));
  w.handle(a.u, { t: 'move', to: { x: 33, y: 29 } }, a.socket);
  assert.equal(eating(a.u), undefined);
  assert.ok(a.msgs.some(m => m.t === 'eating' && m.eating === null));
});

test('knocks: a table mate is let in at once while you are open; closed means Later (at lunch)', (t: TestContext) => {
  const { w, people: [a, b] } = setup(t);
  eat(t, w, a, mine[0], true);
  eat(t, w, b, mine[1], false, 'pizza');
  w.knock(b.u, a.u);
  t.mock.timers.tick(100);
  assert.ok(a.u.callId && a.u.callId === b.u.callId, 'both in a call');
  w.leaveCall(a.u);
  // close the door: the same knock now goes to Later
  w.handle(a.u, { t: 'lunch_open', open: false }, a.socket);
  w.knock(b.u, a.u);
  t.mock.timers.tick(2000);
  const later = a.msgs.find(m => m.t === 'knock_reply' && m.reply === 'later' && m.reason?.includes('at lunch'));
  assert.ok(later, 'sent to Later: at lunch');
  assert.equal(a.u.callId, null);
});

test('plates are counted apart from cups and the cleaner clears them once lunch is over', () => {
  const sent: ServerMsg[] = [];
  const c = new Creatures({ map: () => map, broadcast: m => sent.push(m), people: () => [] });
  const tables = mine.map(ch => picnicSeat(map, ch)!.front);
  const others = map.objects.filter(o => ['table_big', 'table_round', 'table_long', 'desk'].includes(o.type))
    .flatMap(o => Array.from({ length: o.w * o.h }, (_, i) => ({ x: o.x + (i % o.w), y: o.y + Math.floor(i / o.w) })));
  for (const tile of others.slice(0, MAX_CUPS)) assert.equal(typeof c.addCup(tile, 'coffee', 0), 'object');
  assert.match(String(c.addCup(others[MAX_CUPS], 'tea', 0)), /full/, 'cups are used up');
  assert.equal(typeof c.addCup(tables[0], 'plate:salad', 0), 'object', 'a plate still fits');
  assert.match(String(c.addCup(tables[0], 'plate:pizza', 0)), /already/);
  assert.ok(MAX_PLATES >= 6, 'room for every seat');
  // cleaner: leaves a plate alone while its owner might still be eating, then takes it
  c.cups = []; c.addCup(tables[0], 'plate:ramen', 0);
  const lady = c.add('cleaner', 'Valentina', c.base()), may = new Date(2026, 4, 1);
  c.tick(CUP_LINGER_MS + 1, may); assert.equal(lady.walk, null);
  let now = LUNCH_MS + CUP_LINGER_MS;
  c.tick(now, may);
  const walk = lady.walk!; assert.ok(walk, 'off to the plate');
  now = walk.startedAt + (walk.path.length - 1) * walk.ms;
  c.tick(now, may); c.tick(now + CLEAN_MS, may);
  assert.equal(c.cups.length, 0);
});
