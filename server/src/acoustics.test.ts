import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyLayout, doorwayTiles, roomAt, withLayout, type TileMap } from '../../shared/map';
import { distanceGain, ROOM_FILL, soundModel, reverbImpulse } from '../../shared/acoustics';
import { roomDoors } from '../../client/src/doors';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const coffee = map.rooms.find(r => r.id === 'coffee')!;
const music = map.rooms.find(r => r.id === 'music')!;
const pose = (x: number, y: number) => ({ x, y, tile: { x: Math.round(x), y: Math.round(y) } });
const model = (a: ReturnType<typeof pose>, b: ReturnType<typeof pose>, flags = {}) => soundModel(map, a, b, flags);
const keys = (tiles: { x: number; y: number }[]) => tiles.map(t => `${t.x},${t.y}`).sort();
test('doorways are grouped connected non-room tiles, memoized and invalidated by layout', () => {
  for (const [room, expected] of [[coffee, [['26,6', '26,7'], ['32,11', '32,12', '33,11', '33,12']]],
    [music, [['58,11', '58,12', '59,11', '59,12']]]] as const) {
    const groups = doorwayTiles(map, room);
    assert.deepEqual(groups.map(keys).sort(), expected.map(g => [...g].sort()).sort());
    assert.equal(doorwayTiles(map, room), groups);
    for (const tile of groups.flat()) assert.equal(roomAt(map, tile.x, tile.y), undefined);
  }
  const copy = structuredClone(map), room = copy.rooms.find(r => r.id === coffee.id)!;
  const before = doorwayTiles(copy, room);
  applyLayout(copy, { objects: copy.objects, rugs: copy.rugs });
  assert.notEqual(doorwayTiles(copy, room), before); assert.deepEqual(doorwayTiles(copy, room), before);
});
test('room rectangles contain no wall tiles, so same-room distance is Manhattan', () => {
  for (const { rect: r } of map.rooms) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++)
    assert.equal(map.layers.walls[y][x], 0, `${x},${y}`);
});
test('distance gain is a gentle inverse law: 1, .625, .417 at 3, 6, 10 tiles, fading out by 18', () => {
  for (const [d, gain] of [[0, 1], [3, 1], [6, .625], [10, 1 / 2.4], [15, 1 / 3.4 * (3 / 5.4)], [18, 0], [Infinity, 0]])
    assert.ok(Math.abs(distanceGain(d) - gain) < 1e-9, `d=${d}: ${distanceGain(d)} vs ${gain}`);
});
test('same-room objects keep distance law, fill and direct pan', () => {
  const src = pose(32, 4);
  for (const a of [pose(32, 7), pose(32, 10), pose(37, 9)]) {
    const level = model(a, src), d = Math.abs(src.tile.x - a.tile.x) + Math.abs(src.tile.y - a.tile.y);
    assert.equal(level.gain, Math.max(ROOM_FILL, distanceGain(d)));
    assert.equal(level.send, .05 * level.gain);
  }
  const lobby = map.rooms.find(r => r.id === 'lobby')!;
  assert.ok(model(pose(lobby.rect.x, lobby.rect.y + lobby.rect.h - 1), pose(13, 14)).gain >= ROOM_FILL);
  assert.equal(model(pose(32, 8), pose(32, 4)).pan, 0);
  assert.ok(model(pose(32, 8), pose(31, 8)).pan < 0);
  assert.ok(model(pose(32, 8), pose(33, 8)).pan > 0);
});
test('different rooms and non-room tiles always silence dry and echo, including both sides of each door', () => {
  const jukebox = map.objects.find(o => o.sound)!, src = pose(jukebox.x, jukebox.y);
  for (const a of [pose(52, 17), pose(53, 17), pose(58, 24), pose(48, 17), pose(map.spawn.x, map.spawn.y)]) {
    assert.equal(model(a, src).gain, 0); assert.equal(model(a, src).send, 0);
  }
  for (const tile of doorwayTiles(map, coffee).flat()) for (const [a, b] of [[pose(tile.x, tile.y), pose(32, 8)], [pose(32, 8), pose(tile.x, tile.y)]]) {
    const level = model(a, b, { room: coffee });
    assert.equal(level.gain, 0); assert.equal(level.send, 0);
  }
  assert.equal(model(pose(26, 6), pose(26, 7)).gain, 0);
  assert.equal(model(pose(30, 14), pose(13, 14)).gain, 0);
});
test('hall voice is symmetric, full inside including seats, and silent on doorways or outside', () => {
  const a = pose(28, 4), b = pose(37, 9);
  const full = model(a, b, { room: coffee });
  assert.equal(full.gain, 1); assert.equal(full.send, .05); assert.equal(full.pan, .25);
  for (const o of map.objects.filter(o => o.sit && roomAt(map, o.x, o.y)?.id === coffee.id))
    for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++)
      assert.equal(model(a, pose(x, y), { room: coffee }).gain, 1);
  for (const tile of [...doorwayTiles(map, coffee).flat(), { x: 32, y: 13 }, { x: 21, y: 7 }]) {
    const b = pose(tile.x, tile.y);
    assert.equal(model(a, b, { room: coffee }).gain, 0); assert.equal(model(b, a, { room: coffee }).gain, 0);
  }
});
test('stereo reverb is deterministic, decaying and capped at .7 seconds times material', () => {
  for (const room of [...map.rooms, { ...coffee, rect: { x: 0, y: 0, w: 1, h: 1 } }]) {
    const a = reverbImpulse(room, 48000), b = reverbImpulse(room, 48000);
    const material = room.floor === 'tile_check' ? 1.15 : room.floor === 'wood_dark' ? .8 : 1;
    const rt = Math.max(.25, Math.min(.7, .2 + room.rect.w * room.rect.h / 200)) * material;
    assert.equal(a[0].length, Math.floor(rt * 48000)); assert.ok(a[0].length <= .7 * material * 48000); assert.deepEqual(a, b);
    assert.notDeepEqual(a[0], a[1]);
    const energy = (x: Float32Array) => x.reduce((s, v) => s + v * v, 0);
    assert.ok(energy(a[0].slice(0, 1000)) > energy(a[0].slice(-1000)) * 100);
  }
});
test('moving the jukebox moves its acoustic room and derived doors without adding map objects or catalog items', () => {
  const jukebox = map.objects.find(o => o.sound && o.use?.kind === 'jukebox' && !o.use.genres)!, ids = map.objects.map(o => o.id);
  const objects = structuredClone(map.objects), moved = objects.find(o => o.id === jukebox.id)!; moved.x = 4; moved.y = 4;
  const next = withLayout(map, { objects, rugs: map.rugs });
  const src = pose(moved.x, moved.y), me = pose(6, 6);
  assert.ok(soundModel(next, me, src).gain > 0);
  const oldRoom = pose(music.rect.x + 1, music.rect.y + 1);
  assert.equal(soundModel(next, oldRoom, src).gain, 0);
  assert.deepEqual(next.objects.map(o => o.id), ids); assert.deepEqual(next.catalog, map.catalog);
  assert.deepEqual([...new Set(roomDoors(next).map(d => d.room.id))].sort(), ['arcade', 'berghain', 'coffee', 'focus']);
  assert.deepEqual([...new Set(roomDoors(map).map(d => d.room.id))].sort(), ['arcade', 'berghain', 'coffee', 'music']);
  assert.equal(Object.keys(map.catalog).some(k => /^door_[hv]_/.test(k)), false);
});
test('the jukebox fills Music and nothing outside it, not even at the door; knock calls stay flat', () => {
  const jukebox = map.objects.find(o => o.use?.kind === 'jukebox' && !o.use.genres)!, src = pose(jukebox.x, jukebox.y);
  assert.equal(roomAt(map, jukebox.x, jukebox.y)?.id, 'music'); assert.equal(music.rules.voice, undefined);
  assert.deepEqual(jukebox.sound, { gain: .8 }); assert.equal(map.layers.walkable[jukebox.y][jukebox.x], 0);
  const lobby = map.rooms.find(r => r.id === 'lobby')!;
  for (const room of [music, lobby]) for (let y = room.rect.y; y < room.rect.y + room.rect.h; y++) for (let x = room.rect.x; x < room.rect.x + room.rect.w; x++) {
    const gain = model(pose(x, y), src).gain;
    if (room === music) assert.ok(gain >= ROOM_FILL - 1e-9, `${x},${y}: ${gain}`); else assert.equal(gain, 0);
  }
  for (const { x, y } of doorwayTiles(map, music).flat()) assert.equal(model(pose(x, y), src).gain, 0, `${x},${y}`);
  assert.deepEqual(model(pose(2, 5), pose(37, 9), { knock: true }), {
    gain: 1, pan: 0, send: 0,
  });
});

test('each instrument fills Music and is silent outside it, its doorway included (sealed rooms)', () => {
  const instruments = map.objects.filter(o => o.use?.kind === 'instrument'); assert.equal(instruments.length, 3);
  for (const o of instruments) {
    const src = pose(o.x, o.y);
    for (const id of ['music', 'lobby', 'studio']) {
      const r = map.rooms.find(r => r.id === id)!.rect;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
        const gain = model(pose(x, y), src).gain;
        if (id === 'music') assert.ok(gain >= .4 - 1e-9, `${o.type} at ${x},${y}: ${gain}`);
        else assert.equal(gain, 0, `${o.type} in ${id} at ${x},${y}`);
      }
    }
  }
  for (const o of instruments) for (const { x, y } of doorwayTiles(map, music).flat()) assert.equal(model(pose(x, y), pose(o.x, o.y)).gain, 0);
});
