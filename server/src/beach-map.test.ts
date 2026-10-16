import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPath, isWalkable, type TileMap } from '../../shared/map';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));

test('vacation wing extends the office and appends two terrain rooms', () => {
  assert.equal(map.office.h, 44);
  assert.deepEqual(map.rooms.slice(-2).map(r => [r.id, r.rect, r.type, r.capacity, r.rules]), [
    ['mountains', { x: 1, y: 34, w: 24, h: 9 }, 'vacation', 30, { knock: 'allow', label: 'mountains · knock to talk' }],
    ['beach', { x: 25, y: 34, w: 59, h: 9 }, 'vacation', 30, { knock: 'allow', label: 'beach · knock to talk' }],
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
  assert.deepEqual(v.pierEnds, [{ x: 62, y: 42 }, { x: 63, y: 42 }]);
  assert.deepEqual(v.swim, [28, 33, 38, 43, 48, 53, 58, 68, 73, 78].map(x => ({ x, y: 42 })));
  for (const [y, family] of [[40, 'sand_wet'], [41, 'water_shallow'], [42, 'water_deep']] as const)
    for (let x = 1; x < map.width - 1; x++)
      assert.ok(map.tiles[map.layers.floor[y][x]].startsWith(x >= 62 && x <= 63 && y >= 39 ? 'pier' : family));
  assert.equal(map.dungeon!.rect.y, map.office.h + 2);
  for (const type of ['palm', 'lounger', 'umbrella']) assert.equal(map.objects.filter(o => o.type === type && inWing(map, o.x, o.y)).length, 4);
  for (const t of [v.gate, v.trailFoot, v.summit, ...v.pierEnds, ...v.swim]) {
    assert.ok(isWalkable(map, t.x, t.y), JSON.stringify(t));
    assert.ok(findPath(map, map.spawn, t).length, JSON.stringify(t));
  }
  for (let y = 43; y <= 43; y++) for (let x = 0; x < map.width; x++) assert.equal(map.tiles[map.layers.walls[y][x]], 'sea');
});

const trail = [
  ...Array.from({ length: 13 }, (_, i) => ({ x: 21 - i, y: 38 })),
  { x: 9, y: 37 },
  ...Array.from({ length: 5 }, (_, i) => ({ x: 9 + i, y: 36 })),
  { x: 13, y: 35 }, { x: 13, y: 34 }, { x: 12, y: 34 },
];
const key = (t: { x: number; y: number }) => `${t.x},${t.y}`;
const trailKeys = new Set(trail.map(key));
const spans = [[12, 13], [10, 15], [8, 17], [6, 19], [4, 21], [3, 22]];

test('one mountain blocks its silhouette except for the switchback and summit', () => {
  for (let y = 34; y <= 39; y++) for (let x = 1; x <= 24; x++) {
    const [lo, hi] = spans[y - 34], inside = x >= lo && x <= hi;
    const floor = map.tiles[map.layers.floor[y][x]], wall = map.tiles[map.layers.walls[y][x]];
    if (trailKeys.has(`${x},${y}`)) {
      assert.equal(wall, '');
      assert.match(floor, y === 34 ? /^snow_[01]$/ : new RegExp(`^trail_mtn_${x}_${y}$`));
      // The summit flag alone occupies the second snow tile.
      assert.equal(isWalkable(map, x, y), !(x === 12 && y === 34));
    } else if (inside || y <= 35) {
      assert.equal(wall, `mtn_${x}_${y}`);
      assert.equal(isWalkable(map, x, y), false);
    } else {
      assert.equal(wall, ''); assert.equal(floor, `grass_mtn_${x}_${y}`);
      assert.equal(isWalkable(map, x, y), !map.objects.some(o => inRect(o, x, y)));
    }
  }
  assert.deepEqual(map.vacation!.trailFoot, { x: 22, y: 38 });
  assert.deepEqual(map.vacation!.summit, { x: 13, y: 34 });
  const route = findPath(map, map.vacation!.trailFoot, map.vacation!.summit);
  assert.deepEqual(route, [map.vacation!.trailFoot, ...trail.slice(0, -1)]);
  for (const t of [{ x: 9, y: 37 }, { x: 13, y: 35 }]) assert.ok(route.some(p => key(p) === key(t)));
});

test('meadow reaches only the foot end of the trail; removing it cuts off the summit', () => {
  const cut = structuredClone(map);
  for (const t of trail) cut.layers.walkable[t.y][t.x] = 0;
  const seen = new Set<string>(), queue = [map.vacation!.trailFoot], entries = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i]; if (seen.has(key(t))) continue; seen.add(key(t));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: t.x + dx, y: t.y + dy };
      if (trailKeys.has(key(n))) { entries.add(key(n)); continue; }
      if (isWalkable(cut, n.x, n.y) && !seen.has(key(n))) queue.push(n);
    }
  }
  assert.deepEqual([...entries].sort(), ['20,38', '21,38']);
  assert.equal(findPath(cut, map.vacation!.trailFoot, map.vacation!.summit).length, 0);
  for (const t of trail.slice(0, -1)) {
    const blocked = structuredClone(map); blocked.layers.walkable[t.y][t.x] = 0;
    // First two tiles have the explicitly allowed meadow entries above them.
    if (t.y === 38 && t.x >= 20 || t.y === 34) continue;
    assert.equal(findPath(blocked, map.vacation!.trailFoot, map.vacation!.summit).length, 0, key(t));
  }
});

test('wing props use the compact sand and leave mountain destinations clear', () => {
  const positions = (type: string) => map.objects.filter(o => o.type === type && inWing(map, o.x, o.y)).map(o => [o.x, o.y]);
  assert.deepEqual(positions('pine'), [[2, 37], [1, 39], [23, 36]]);
  assert.deepEqual(positions('summit_flag'), [[12, 34]]);
  assert.deepEqual(positions('palm'), [[29, 35], [35, 35], [57, 35], [80, 35]]);
  assert.deepEqual(positions('lounger'), [30, 46, 62, 78].map(x => [x, 37]));
  assert.deepEqual(positions('umbrella'), [30, 46, 62, 78].map(x => [x, 36]));
  for (const [type, x, y] of [['hammock', 31, 35], ['beach_bar', 65, 35], ['vacation_sign', 52, 34], ['sandcastle', 40, 39], ['shells', 59, 40], ['beach_ball', 75, 38]] as const)
    assert.deepEqual(positions(type), [[x, y]]);
  for (const s of map.rooms.find(r => r.id === 'mountains')!.stand) assert.ok(isWalkable(map, s.x, s.y));
});

import { terrainAt, inWing } from '../../shared/beach';
import { inRect, layoutProblem, migrateBeach, resetBeach, pathTo, seatAt, withLayout, type Layout } from '../../shared/map';

test('terrain helpers classify each family and restrict the wing to its room rectangles', () => {
  for (const [name, expected] of [['sand_0', 'sand'], ['sand_wet_2', 'sand'], ['water_shallow_1', 'shallow'], ['water_deep_2', 'deep'], ['trail_mtn_12_36', 'trail'], ['trail_mtn_9_37', 'trail'], ['snow_0', 'snow'], ['pier', 'pier']] as const) {
    const y = map.layers.floor.findIndex(row => row.some(i => map.tiles[i] === name));
    assert.ok(y >= 0, name);
    const x = map.layers.floor[y].findIndex(i => map.tiles[i] === name);
    assert.equal(terrainAt(map, x, y), expected);
  }
  assert.equal(terrainAt(map, map.spawn.x, map.spawn.y), null);
  assert.equal(terrainAt(map, -1, -1), null);
  for (const [x, y, expected] of [[1, 34, true], [24, 42, true], [25, 34, true], [83, 42, true], [0, 34, false], [84, 34, false], [50, 33, false], [50, 43, false]] as const) assert.equal(inWing(map, x, y), expected);
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
  for (const t of [{ x: 9, y: 37 }, ...map.vacation!.pierEnds]) {
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
  // the office stays; an old wing's furniture on rows that are sea now goes too
  assert.deepEqual(result.objects.filter(o => !inWing(map, o.x, o.y)), saved.objects.filter(o => o.y < 34));
  assert.deepEqual(result.rugs.map(({ id, ...r }) => r), saved.rugs.map(({ id, ...r }) => r));
  const ids = [...result.objects, ...result.rugs].map(o => o.id);
  assert.equal(new Set(ids).size, ids.length);
});
