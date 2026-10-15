import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TileMap } from '../../shared/map';
import { hallDistance, roomAt } from '../../shared/map';
import { distanceGain, doorSpread, field, ROOM_FILL, soundModel, hallLevel, hallVoiceGain, reverbImpulse } from '../../shared/acoustics';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const coffee = map.rooms.find(r => r.id === 'coffee')!;
const pose = (x: number, y: number) => ({ x, y, tile: { x: Math.round(x), y: Math.round(y) } });
const model = (a: ReturnType<typeof pose>, b: ReturnType<typeof pose>, flags = {}) => soundModel(map, field(map, a.tile), a, b, flags);
test('hall distance uses walkable tiles and seats through doors', () => {
  assert.equal(hallDistance(map, coffee, 32, 8), 0);
  assert.equal(hallDistance(map, coffee, 32, 13), 3);
  assert.equal(hallDistance(map, coffee, 29, 13), 6);
  assert.equal(hallDistance(map, coffee, 28, 13), 7);
  assert.equal(hallDistance(map, coffee, 27, 13), Infinity);
  for (const o of map.objects.filter(o => o.sit && roomAt(map, o.x, o.y)?.id === coffee.id))
    for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) assert.equal(hallDistance(map, coffee, x, y), 0);
});
test('sound field travels through doors, ignores furniture and never crosses walls', () => {
  const f = field(map, { x: 32, y: 14 });
  assert.equal(f[4][32], 10); assert.equal(f[11][31], Infinity); assert.equal(f[9][31], 6);
});
test('distance gain is a gentle inverse law: 1, .625, .417 at 3, 6, 10 tiles, fading out by 18', () => {
  for (const [d, gain] of [[0, 1], [3, 1], [6, .625], [10, 1 / 2.4], [15, 1 / 3.4 * (3 / 5.4)], [18, 0], [Infinity, 0]]) {
    assert.ok(Math.abs(distanceGain(d) - gain) < 1e-9, `d=${d}: ${distanceGain(d)} vs ${gain}`);
  }
});
test('the source room is filled: never below ROOM_FILL anywhere inside it', () => {
  const lobby = map.rooms.find(r => r.id === 'lobby')!, src = pose(13, 14); // a source by the Lobby reception
  const far = model(pose(lobby.rect.x, lobby.rect.y + lobby.rect.h - 1), src);
  assert.ok(far.gain >= ROOM_FILL - 1e-9, `gain ${far.gain}`);
  assert.ok(model(pose(30, 14), src).gain < ROOM_FILL); // next room: falls off normally
});
test('another room only hears a source near the doorway it comes through; a third room hears nothing', () => {
  const src = pose(13, 14); // a source by the Lobby reception
  assert.equal(model(pose(3, 5), src).gain, 0);            // deep in Focus
  assert.ok(model(pose(7, 10), src).gain > .1);            // Focus, one step from its door to the Lobby
  assert.ok(model(pose(16, 17), src).gain > .1);           // Co-working, next to the Lobby door
  assert.ok(model(pose(20, 17), src).gain === 0);          // Co-working, five steps from that door
  assert.ok(model(pose(20, 10), src).gain < .02);          // Meeting: two doorways away
  assert.equal(doorSpread(0), 1); assert.equal(doorSpread(1), .8); assert.equal(doorSpread(5), 0);
});
test('occlusion, doorway apparent position and a clear line down the door column', () => {
  assert.ok(model(pose(31, 13), pose(31, 9)).cutoff < 20000);
  assert.equal(model(pose(28, 4), pose(31, 4)).cutoff, 20000);
  assert.deepEqual(model(pose(32, 14), pose(31, 8)).apparent, { x: 32.5, y: 12.5 });
  const apparent = model(pose(24, 8), pose(27, 8)).apparent;
  assert.equal(apparent.x, 26.5); assert.equal(roomAt(map, apparent.x - .5, apparent.y - .5), undefined);
  const clear = model(pose(32, 14), pose(32, 4));
  assert.equal(clear.cutoff, 20000); assert.deepEqual(clear.apparent, { x: 32.5, y: 4.5 });
});
test('pan and silence', () => {
  assert.equal(model(pose(32, 8), pose(32, 4)).pan, 0);
  assert.ok(model(pose(32, 8), pose(31, 8)).pan < 0);
  assert.ok(model(pose(32, 8), pose(33, 8)).pan > 0);
  assert.deepEqual(model(pose(32, 4), pose(2, 20)), { gain: 0, cutoff: 20000, pan: 0, send: 0, apparent: { x: 2.5, y: 20.5 } });
});
test('hall levels fall to zero at six steps, including unreachable tiles', () => {
  for (const [x, d] of [[32, 3], [31, 4], [30, 5], [29, 6], [28, 7]])
    assert.equal(hallLevel(map, coffee, { x, y: 13 }), Math.max(0, 1 - d / 6));
  assert.equal(hallLevel(map, coffee, { x: 32, y: 8 }), 1);
  assert.equal(hallLevel(map, coffee, { x: 2, y: 20 }), 0);
});
test('hall voice gain is symmetric, clear inside and silent before disconnection', () => {
  const pairs = [[pose(27, 3), pose(21, 7)], [pose(32, 9), pose(32, 14)], [pose(31, 9), pose(31, 13)]];
  for (const [a, b] of pairs) {
    const product = hallLevel(map, coffee, a.tile) * hallLevel(map, coffee, b.tile);

    const gain = hallVoiceGain(map, coffee, a, b);
    assert.equal(gain, hallVoiceGain(map, coffee, b, a));
    assert.equal(gain, product * (model(a, b).cutoff < 20000 ? .8 : 1));
  }
  assert.ok(hallVoiceGain(map, coffee, pose(32, 9), pose(32, 14)) > 0);
  assert.ok(hallVoiceGain(map, coffee, pose(31, 9), pose(31, 13)) > 0);
  for (const a of [pose(31.4, 9.3), pose(32.1, 10.2)]) for (const b of [pose(30.8, 13.4), pose(32.2, 14.1)])
    assert.equal(hallVoiceGain(map, coffee, a, b), hallVoiceGain(map, coffee, b, a));
  for (const x of [29, 28, 27]) {
    assert.equal(hallVoiceGain(map, coffee, pose(32, 8), pose(x, 13)), 0);
    assert.equal(hallVoiceGain(map, coffee, pose(x, 13), pose(32, 8)), 0);
  }
  const a = pose(28, 4), b = pose(37, 9);
  assert.equal(hallVoiceGain(map, coffee, a, b), 1);
  assert.equal(model(a, b, { room: coffee, sourceMember: true }).gain, 1);
});
test('stereo reverb is deterministic with floor-dependent lengths and decaying tails', () => {
  for (const room of [coffee, map.rooms[0], map.rooms[1], null]) {
    const a = reverbImpulse(room, 48000), b = reverbImpulse(room, 48000);
    const material = room?.floor === 'tile_check' ? 1.3 : room?.floor === 'wood_dark' ? .7 : 1;
    const rt = room ? Math.max(.35, Math.min(1.2, .3 + room.rect.w * room.rect.h / 120)) * material : .6;
    assert.equal(a[0].length, Math.floor(rt * 48000)); assert.deepEqual(a, b);
    assert.notDeepEqual(a[0], a[1]);
    const energy = (x: Float32Array) => x.reduce((s, v) => s + v * v, 0);
    assert.ok(energy(a[0].slice(0, 1000)) > energy(a[0].slice(-1000)) * 100);
  }
});
test('jukebox fills Music, leaks through its door, is silent in Lobby; knock calls stay flat', () => {
  const jukebox = map.objects.find(o => o.use?.kind === 'jukebox')!, music = map.rooms.find(r => r.id === 'music')!;
  const src = pose(jukebox.x, jukebox.y);
  assert.equal(roomAt(map, jukebox.x, jukebox.y)?.id, 'music');
  for (const room of [music, map.rooms.find(r => r.id === 'lobby')!])
    for (let y = room.rect.y; y < room.rect.y + room.rect.h; y++) for (let x = room.rect.x; x < room.rect.x + room.rect.w; x++) {
      const gain = model(pose(x, y), src).gain;
      if (room === music) assert.ok(gain >= .4 - 1e-9, `${x},${y}: ${gain}`);
      else assert.equal(gain, 0);
    }
  for (const x of [53, 52]) assert.ok(model(pose(x, 17), src).gain > 0);
  assert.equal(model(pose(48, 17), src).gain, 0);
  assert.deepEqual(jukebox.sound, { gain: .8 }); assert.equal(map.layers.walkable[jukebox.y][jukebox.x], 0);
  assert.equal(music.rules.voice, undefined);
  assert.deepEqual(model(pose(2, 5), pose(37, 9), { knock: true }), {
    gain: 1, cutoff: 20000, pan: 0, send: 0, apparent: { x: 37.5, y: 9.5 },
  });
});

test('each instrument fills Music and is silent throughout Lobby and Studio; keys leak only near the Desks door', () => {
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
  const keys = instruments.find(o => o.type === 'keyboard')!, src = pose(keys.x, keys.y);
  assert.ok(model(pose(53, 17), src).gain > 0);
  assert.equal(model(pose(50, 17), src).gain, 0);
});
