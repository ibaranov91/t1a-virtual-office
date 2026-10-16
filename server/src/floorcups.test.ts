import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLEAN_MS, CUP_LINGER_MS, Creatures } from './creatures';
import { findPath, isWalkable, type TileMap } from '../../shared/map';
import { MAX_CUPS, type Cup } from '../../shared/protocol';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const tables = map.objects.filter(o => ['table_big', 'table_round', 'table_long', 'desk'].includes(o.type));
const tableTiles = tables.flatMap(o => Array.from({ length: o.w * o.h }, (_, i) => ({ x: o.x + (i % o.w), y: o.y + Math.floor(i / o.w) })));
const lobby = map.rooms.find(r => r.id === 'lobby')!;
const floorTiles = map.rooms.flatMap(r => r.stand).filter(s => isWalkable(map, s.x, s.y)).map(s => ({ x: s.x, y: s.y }));

const setup = () => new Creatures({ map: () => map, broadcast: () => {}, people: () => [] });

test('litter first: a floor cup across the office beats an older table cup right beside her', () => {
  const c = setup();
  const lady = c.add('cleaner', 'Cleaning lady', c.base());
  const byDist = (t: { x: number; y: number }) => findPath(map, lady.tile, t).length || Infinity;
  const near = [...tableTiles].filter(t => c.beside(t).length).sort((a, b) => Math.min(...c.beside(a).map(byDist)) - Math.min(...c.beside(b).map(byDist)))[0];
  const far = floorTiles.filter(t => !lobby.stand.some(s => s.x === t.x && s.y === t.y)).sort((a, b) => byDist(b) - byDist(a)).find(t => byDist(t) < Infinity)!;
  const table = c.addCup(near, 'coffee', 0) as Cup;
  const floor = c.addCup(far, 'beer', 1000, { floor: true, by: 'u1' }) as Cup;
  assert.equal(typeof table, 'object'); assert.equal(typeof floor, 'object');
  assert.ok(floor.floor && floor.by === 'u1');
  const plan = c.planClean(lady.tile, 1000 + CUP_LINGER_MS)!;
  assert.equal(plan.cup.id, floor.id);
  assert.deepEqual(plan.spot, floor.tile, 'she stands on the litter itself');
  // and the table cup once the floor is clear
  c.removeCup(floor.id);
  assert.equal(c.planClean(lady.tile, 1000 + CUP_LINGER_MS)!.cup.id, table.id);
});

test('the cleaner walks onto a floor cup, wipes, and takes it', () => {
  const c = setup(), may = new Date(2026, 4, 1);
  const lady = c.add('cleaner', 'Cleaning lady', c.base());
  const spot = floorTiles.find(t => findPath(map, lady.tile, t).length > 3)!;
  const cup = c.addCup(spot, 'coffee', 0, { floor: true }) as Cup;
  let now = CUP_LINGER_MS;
  for (let i = 0; lady.cleaning !== cup.id && i < 20; i++) { now = Math.max(now, lady.until); c.tick(now, may); }
  assert.equal(lady.cleaning, cup.id);
  assert.deepEqual(lady.walk!.path.at(-1), spot);
  now = lady.until; c.tick(now, may);
  assert.equal(lady.pose, 'clean');
  c.tick(now + CLEAN_MS, may);
  assert.equal(c.cups.length, 0);
});

test('a full floor evicts the oldest cup instead of refusing the drop', () => {
  const c = setup();
  const tiles = floorTiles.slice(0, MAX_CUPS + 2);
  tiles.slice(0, MAX_CUPS).forEach((t, i) => assert.equal(typeof c.addCup(t, 'tea', i, { floor: true }), 'object'));
  const oldest = c.cups[0].id;
  const extra = c.addCup(tiles[MAX_CUPS], 'wine', 100, { floor: true });
  assert.equal(typeof extra, 'object');
  assert.equal(c.cups.length, MAX_CUPS);
  assert.ok(!c.cups.some(k => k.id === oldest));
  assert.match(String(c.addCup(tiles[MAX_CUPS], 'tea', 101, { floor: true })), /already/, 'still one per tile');
});
