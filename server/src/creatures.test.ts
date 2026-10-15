import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLEAN_MS, CUP_LINGER_MS, CUP_TTL_MS, Creatures, flightPath } from './creatures';
import { World } from './world';
import { isWalkable, type TileMap, type Tile } from '../../shared/map';
import { MAX_CUPS, type ServerMsg } from '../../shared/protocol';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const tables = map.objects.filter(o => ['table_big', 'table_round', 'table_long', 'desk'].includes(o.type));
const tableTiles = tables.flatMap(o => Array.from({ length: o.w * o.h }, (_, i) => ({ x: o.x + (i % o.w), y: o.y + Math.floor(i / o.w) })));

function setup() {
  const sent: ServerMsg[] = [];
  const c = new Creatures({ map: () => map, broadcast: m => sent.push(m), people: () => [] });
  return { c, sent };
}

test('cups only go on tables, one per tile, and never more than MAX_CUPS', () => {
  const { c } = setup();
  assert.equal(typeof c.addCup(map.spawn, 'coffee', 0), 'string'); // the floor isn't a table
  const first = c.addCup(tableTiles[0], 'coffee', 0);
  assert.equal(typeof first, 'object');
  assert.match(String(c.addCup(tableTiles[0], 'tea', 0)), /already/);
  for (const t of tableTiles.slice(1, MAX_CUPS)) assert.equal(typeof c.addCup(t, 'tea', 0), 'object');
  assert.equal(c.cups.length, MAX_CUPS);
  assert.match(String(c.addCup(tableTiles[MAX_CUPS], 'coffee', 0)), /full/);
  assert.equal(c.cups.length, MAX_CUPS);
});

test('cups vanish on their own after a while', () => {
  const { c } = setup();
  c.addCup(tableTiles[0], 'coffee', 0);
  c.tick(CUP_TTL_MS - 1, new Date(2026, 4, 1)); assert.equal(c.cups.length, 1);
  c.tick(CUP_TTL_MS + 1, new Date(2026, 4, 1)); assert.equal(c.cups.length, 0);
});

test('the cleaner walks to a settled cup by a path of walkable tiles, pauses, takes it, and goes home', () => {
  const { c, sent } = setup();
  const home = c.base(), may = new Date(2026, 4, 1);
  const lady = c.add('cleaner', 'Valentina', home);
  const cup = c.addCup(tableTiles[3], 'coffee', 0);
  assert.ok(typeof cup === 'object');
  c.tick(1000, may);
  assert.equal(lady.walk, null, 'a fresh cup is left alone for a moment');
  let now = CUP_LINGER_MS;
  c.tick(now, may);
  const walk = lady.walk!;
  assert.ok(walk, 'off to the cup');
  for (const p of walk.path) assert.ok(isWalkable(map, p.x, p.y), `walkable ${p.x},${p.y}`);
  for (let i = 1; i < walk.path.length; i++) assert.equal(Math.abs(walk.path[i].x - walk.path[i - 1].x) + Math.abs(walk.path[i].y - walk.path[i - 1].y), 1);
  const end = walk.path[walk.path.length - 1];
  assert.equal(Math.abs(end.x - cup.tile.x) + Math.abs(end.y - cup.tile.y), 1, 'stands right by the cup');
  now = walk.startedAt + (walk.path.length - 1) * walk.ms;
  c.tick(now, may);
  assert.equal(lady.pose, 'clean'); assert.equal(c.cups.length, 1, 'the cup stays while she wipes');
  c.tick(now + CLEAN_MS, may);
  assert.equal(c.cups.length, 0);
  assert.ok(sent.some(m => m.t === 'cups' && m.cups.length === 0));
  const back = lady.walk!;
  assert.deepEqual(back.path.at(-1), home, 'and home again');
});

test('the cleaner gives up on a cup that went before she got there', () => {
  const { c } = setup();
  const lady = c.add('cleaner', 'Valentina', c.base()), may = new Date(2026, 4, 1);
  const cup = c.addCup(tableTiles[0], 'tea', 0);
  assert.ok(typeof cup === 'object');
  c.tick(CUP_LINGER_MS, may);
  const walk = lady.walk!;
  c.removeCup(cup.id);
  c.tick(walk.startedAt + (walk.path.length - 1) * walk.ms, may);
  assert.notEqual(lady.pose, 'clean');
});

test('the bat only stays in October and flies straight over everything', () => {
  const { c } = setup();
  c.add('bat', 'Bat', { x: 20, y: 13 });
  c.tick(0, new Date(2026, 9, 15)); assert.ok(c.list.has('bat'));
  c.tick(60_000, new Date(2026, 10, 1)); assert.ok(!c.list.has('bat'));
  const path = flightPath({ x: 2, y: 3 }, { x: 5, y: 1 });
  assert.equal(path.length, 6); assert.deepEqual(path.at(-1), { x: 5, y: 1 });
});

test('putting a cup down: walk to the table, cup appears, hands empty; creatures never show up as users', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const u = w.addUser('A', false, { x: 32, y: 8 }); u.presence = 'online';
  const msgs: ServerMsg[] = [];
  const { socket } = w.connect(u.id, m => msgs.push(m));
  w.creatures.add('cat', 'Biscuit', { x: 30, y: 8 });
  const round = map.objects.find(o => o.type === 'table_round' && o.x === 30)!;
  const tile: Tile = { x: round.x, y: round.y };
  w.handle(u, { t: 'cup_put', tile }, socket);
  assert.equal(w.creatures.cups.length, 0, 'not holding anything');
  w.setHolding(u, 'coffee');
  w.handle(u, { t: 'cup_put', tile }, socket);
  t.mock.timers.tick(10_000);
  assert.equal(w.creatures.cups.length, 1);
  assert.equal(u.holding, null);
  const state = msgs.find(m => m.t === 'state');
  assert.ok(state && state.t === 'state' && state.users.every(p => p.name !== 'Biscuit'));
  assert.deepEqual(w.dump().cups.map(c => c.tile), [tile]);
});
