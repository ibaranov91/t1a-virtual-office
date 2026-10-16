import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPath, isWalkable, type TileMap } from '../../shared/map';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));

test('vacation wing extends the office and appends two terrain rooms', () => {
  assert.equal(map.office.h, 48);
  assert.deepEqual(map.rooms.slice(-2).map(r => [r.id, r.rect, r.type, r.capacity, r.rules]), [
    ['mountains', { x: 1, y: 34, w: 24, h: 13 }, 'vacation', 30, { knock: 'allow', label: 'mountains · knock to talk' }],
    ['beach', { x: 25, y: 34, w: 59, h: 13 }, 'vacation', 30, { knock: 'allow', label: 'beach · knock to talk' }],
  ]);
  for (const r of map.rooms.slice(-2)) {
    assert.ok(r.stand.length >= 4 && r.stand.length <= 6);
    for (const s of r.stand) assert.ok(findPath(map, map.spawn, s).length);
  }
});

test('the building keeps its bottom edge; the hedge has one gate and the wing furniture comes last', () => {
  const terrain = /^(sand|water|sea|rock|cliff|mtn_|trail|snow|pier)/;
  for (let y = 0; y < 34; y++) for (let x = 0; x < map.width; x++)
    for (const layer of ['floor', 'walls'] as const) assert.ok(!terrain.test(map.tiles[map.layers[layer][y][x]] ?? ''), `${layer} ${x},${y}`);
  const gate: number[] = [];
  for (let x = 16; x < 64; x++) {
    const wall = map.tiles[map.layers.walls[33][x]];
    if (wall === 'hedge') continue;
    assert.equal(map.tiles[map.layers.floor[33][x]], 'door_floor'); gate.push(x);
  }
  assert.deepEqual(gate, [50, 51]);
  for (const x of gate) { assert.ok(isWalkable(map, x, 32)); assert.ok(isWalkable(map, x, 33)); }
  const first = map.objects.findIndex(o => inWing(map, o.x, o.y));
  assert.ok(first > 0 && map.objects.slice(first).every(o => inWing(map, o.x, o.y)));
});

test('every fixed vacation destination is walkable and reachable from spawn', () => {
  assert.ok(map.vacation);
  const v = map.vacation;
  assert.deepEqual(v.pierEnds, [{ x: 62, y: 46 }, { x: 63, y: 46 }]);
  assert.deepEqual(v.swim, [28, 33, 38, 43, 48, 53, 58, 68, 73, 78].map(x => ({ x, y: 46 })));
  for (const [y, family] of [[44, 'sand_wet'], [45, 'water_shallow'], [46, 'water_deep']] as const)
    for (let x = 1; x < map.width - 1; x++)
      assert.ok(map.tiles[map.layers.floor[y][x]].startsWith(x >= 62 && x <= 63 && y >= 43 ? 'pier' : family));
  assert.equal(map.dungeon!.rect.y, map.office.h + 2);
  for (const type of ['palm', 'lounger', 'umbrella']) assert.equal(map.objects.filter(o => o.type === type && inWing(map, o.x, o.y)).length, 4);
  for (const t of [v.gate, v.trailFoot, v.summit, ...v.pierEnds, ...v.swim]) {
    assert.ok(isWalkable(map, t.x, t.y), JSON.stringify(t));
    assert.ok(findPath(map, map.spawn, t).length, JSON.stringify(t));
  }
  for (let y = 47; y <= 47; y++) for (let x = 0; x < map.width; x++) assert.equal(map.tiles[map.layers.walls[y][x]], 'sea');
});

test('the mountain has walkable terraces joined by stairs, with no shortcuts through cliff faces', () => {
  for (const [x, y] of [[12, 35], [12, 36], [12, 38], [12, 39], [12, 41], [17, 42]])
    assert.ok(isWalkable(map, x, y), `terrace ${x},${y}`);
  for (const [x, y] of [[12, 37], [12, 40], [24, 39], [22, 36]])
    assert.equal(isWalkable(map, x, y), false, `cliff ${x},${y}`);
  const route = findPath(map, map.vacation!.trailFoot, map.vacation!.summit);
  for (const [x, y] of [[22, 40], [8, 37]])
    assert.ok(route.some(t => t.x === x && t.y === y), `stairs ${x},${y}`);
  for (const t of route) assert.ok(isWalkable(map, t.x, t.y));
  // The grass alongside the massif is part of the playable valley too.
  for (const [x, y] of [[1, 34], [1, 43], [24, 34]])
    assert.ok(findPath(map, map.spawn, { x, y }).length, `valley ${x},${y}`);
});

import { terrainAt, inWing } from '../../shared/beach';
import { inRect, layoutProblem, migrateBeach, resetBeach, pathTo, seatAt, withLayout, type Layout } from '../../shared/map';

test('terrain helpers classify each family and restrict the wing to its room rectangles', () => {
  for (const [name, expected] of [['sand_0', 'sand'], ['sand_wet_2', 'sand'], ['water_shallow_1', 'shallow'], ['water_deep_2', 'deep'], ['trail_mtn_12_39', 'trail'], ['trail_mtn_8_37', 'trail'], ['snow_0', 'snow'], ['pier', 'pier']] as const) {
    const y = map.layers.floor.findIndex(row => row.some(i => map.tiles[i] === name));
    assert.ok(y >= 0, name);
    const x = map.layers.floor[y].findIndex(i => map.tiles[i] === name);
    assert.equal(terrainAt(map, x, y), expected);
  }
  assert.equal(terrainAt(map, map.spawn.x, map.spawn.y), null);
  assert.equal(terrainAt(map, -1, -1), null);
  for (const [x, y, expected] of [[1, 34, true], [24, 46, true], [25, 34, true], [83, 46, true], [0, 34, false], [84, 34, false], [50, 33, false], [50, 47, false]] as const) assert.equal(inWing(map, x, y), expected);
});

test('loungers and hammock each have one reachable lie seat; the remaining footprint blocks', () => {
  const lies = map.objects.filter(o => o.lie);
  assert.equal(lies.filter(o => o.type === 'lounger').length, 4);
  assert.equal(lies.filter(o => o.type === 'hammock').length, 1);
  for (const o of lies) {
    const seat = { x: o.x + Math.floor((o.w - 1) / 2), y: o.y };
    const spots = map.rooms.flatMap(r => r.spots).filter(s => inRect(o, s.x, s.y));
    assert.deepEqual(spots, [{ ...seat, dir: 'down' }]);
    for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) {
      assert.equal(isWalkable(map, x, y), false);
      assert.equal(!!seatAt(map, x, y), x === seat.x && y === seat.y);
    }
    const path = pathTo(map, map.spawn, seat);
    assert.ok(path.length); assert.deepEqual(path.at(-2), { x: seat.x, y: seat.y + 1 });
  }
  const o = lies[0], seatX = o.x + Math.floor((o.w - 1) / 2);
  const blocked = withLayout(map, { objects: [...map.objects, { id: 'seat-block', type: 'plant', x: seatX, y: o.y + 1, w: 1, h: 1 }], rugs: map.rugs });
  assert.match(layoutProblem(blocked)!, /cuts off a seat/);
});

test('layout validation protects the narrow trail and both fishing destinations', () => {
  assert.equal(layoutProblem(map), null);
  for (const t of [{ x: 22, y: 41 }, ...map.vacation!.pierEnds]) {
    const blocked = withLayout(map, { objects: [...map.objects, { id: 'block', type: 'plant', ...t, w: 1, h: 1 }], rugs: map.rugs });
    assert.equal(layoutProblem(blocked), 'that blocks the way to the beach');
  }
});

test('saved-layout migration appends wing objects and resolves ids across objects and rugs', () => {
  const base: Layout = { objects: map.objects, rugs: map.rugs };
  const wing = base.objects.filter(o => inWing(map, o.x, o.y));
  assert.ok(wing.length);
  const saved: Layout = { objects: base.objects.filter(o => !inWing(map, o.x, o.y)), rugs: [...base.rugs, { id: wing[0].id, x: 1, y: 1, w: 2, h: 2, color: 'blue' }] };
  const old = structuredClone(saved), result = migrateBeach(saved, base, map);
  assert.deepEqual(saved, old);
  assert.deepEqual(result.objects.filter(o => inWing(map, o.x, o.y)), wing);
  assert.deepEqual(result.objects.filter(o => !inWing(map, o.x, o.y)), saved.objects);
  const ids = [...result.objects, ...result.rugs].map(o => o.id);
  assert.equal(new Set(ids).size, ids.length);
  // A layout that already has wing furniture is left alone.
  assert.equal(migrateBeach(result, base, map), result);
});

test('one-time reset replaces wing furniture, preserves office and rugs, and resolves ids without mutating inputs', () => {
  const base: Layout = { objects: map.objects, rugs: map.rugs };
  const wing = base.objects.filter(o => inWing(map, o.x, o.y));
  const saved: Layout = { objects: [
    ...base.objects.filter(o => !inWing(map, o.x, o.y)),
    { ...wing[0], id: 'old-wing', x: 60, y: 48 },
  ], rugs: [...base.rugs, { id: wing[0].id, x: 26, y: 35, w: 2, h: 2, color: 'blue' }] };
  const before = structuredClone({ saved, base });
  const result = resetBeach(saved, base, map);
  assert.deepEqual({ saved, base }, before);
  assert.deepEqual(result.objects.filter(o => inWing(map, o.x, o.y)), wing);
  assert.deepEqual(result.objects.filter(o => !inWing(map, o.x, o.y)), saved.objects.filter(o => !inWing(map, o.x, o.y)));
  assert.deepEqual(result.rugs.map(({ id, ...r }) => r), saved.rugs.map(({ id, ...r }) => r));
  const ids = [...result.objects, ...result.rugs].map(o => o.id);
  assert.equal(new Set(ids).size, ids.length);
});
