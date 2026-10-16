import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPath, isWalkable, type TileMap } from '../../shared/map';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));

test('vacation wing extends the office and appends two terrain rooms', () => {
  assert.equal(map.office.h, 52);
  assert.deepEqual(map.rooms.slice(-2).map(r => [r.id, r.rect, r.type, r.capacity, r.rules]), [
    ['mountains', { x: 1, y: 34, w: 24, h: 15 }, 'vacation', 30, { knock: 'allow', label: 'mountains · knock to talk' }],
    ['beach', { x: 25, y: 34, w: 59, h: 15 }, 'vacation', 30, { knock: 'allow', label: 'beach · knock to talk' }],
  ]);
  for (const r of map.rooms.slice(-2)) {
    assert.ok(r.stand.length >= 4 && r.stand.length <= 6);
    for (const s of r.stand) assert.ok(findPath(map, map.spawn, s).length);
  }
});

test('building floor and walls differ from the pre-wing map only at the two hedge gates', () => {
  const before: TileMap = JSON.parse(execFileSync('git', ['show', '7a7ce7e4e618ea13207840c272ba65406022eadd:shared/tilemap.json'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' }));
  for (const layer of ['floor', 'walls'] as const) {
    const changed: string[] = [];
    for (let y = 0; y < 34; y++) for (let x = 0; x < map.width; x++)
      if (map.tiles[map.layers[layer][y][x]] !== before.tiles[before.layers[layer][y][x]]) changed.push(`${x},${y}`);
    assert.deepEqual(changed, ['50,33', '51,33'], layer);
  }
  for (const x of [50, 51]) {
    assert.equal(map.tiles[map.layers.floor[33][x]], 'door_floor');
    assert.ok(isWalkable(map, x, 32)); assert.ok(isWalkable(map, x, 33));
  }
  assert.deepEqual(map.objects.slice(0, before.objects.length), before.objects);
});

test('every fixed vacation destination is walkable and reachable from spawn', () => {
  assert.ok(map.vacation);
  const v = map.vacation;
  assert.equal(v.pierEnds.length, 2); assert.equal(v.swim.length, 10);
  for (const t of [v.gate, v.trailFoot, v.summit, ...v.pierEnds, ...v.swim]) {
    assert.ok(isWalkable(map, t.x, t.y), JSON.stringify(t));
    assert.ok(findPath(map, map.spawn, t).length, JSON.stringify(t));
  }
  for (let y = 49; y <= 51; y++) for (let x = 0; x < map.width; x++) assert.equal(map.tiles[map.layers.walls[y][x]], 'sea');
});

import { terrainAt, inWing } from '../../shared/beach';
import { inRect, layoutProblem, migrateBeach, pathTo, seatAt, withLayout, type Layout } from '../../shared/map';

test('terrain helpers classify each family and restrict the wing to its room rectangles', () => {
  for (const [name, expected] of [['sand_0', 'sand'], ['sand_wet_2', 'sand'], ['water_shallow_1', 'shallow'], ['water_deep_2', 'deep'], ['trail_1', 'trail'], ['snow_0', 'snow'], ['pier', 'pier']] as const) {
    const y = map.layers.floor.findIndex(row => row.some(i => map.tiles[i] === name));
    assert.ok(y >= 0, name);
    const x = map.layers.floor[y].findIndex(i => map.tiles[i] === name);
    assert.equal(terrainAt(map, x, y), expected);
  }
  assert.equal(terrainAt(map, map.spawn.x, map.spawn.y), null);
  assert.equal(terrainAt(map, -1, -1), null);
  for (const [x, y, expected] of [[1, 34, true], [24, 48, true], [25, 34, true], [83, 48, true], [0, 34, false], [84, 34, false], [50, 33, false], [50, 49, false]] as const) assert.equal(inWing(map, x, y), expected);
});

test('loungers and hammock each have one reachable lie seat; the remaining footprint blocks', () => {
  const lies = map.objects.filter(o => o.lie);
  assert.equal(lies.filter(o => o.type === 'lounger').length, 6);
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
  // The caller owns the version gate: a second invocation deliberately appends again.
  assert.equal(migrateBeach(result, base, map).objects.length, result.objects.length + wing.length);
});
