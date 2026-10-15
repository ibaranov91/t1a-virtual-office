import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TileMap } from '../../shared/map';
import { earshotDistance, roomAt } from '../../shared/map';
import { distanceGain, doorSpread, field, ROOM_FILL, soundModel, zoneGain, reverbImpulse } from '../../shared/acoustics';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const coffee = map.rooms.find(r => r.id === 'coffee')!;
const pose = (x: number, y: number) => ({ x, y, tile: { x: Math.round(x), y: Math.round(y) } });
const model = (a: ReturnType<typeof pose>, b: ReturnType<typeof pose>, flags = {}) => soundModel(map, field(map, a.tile), a, b, flags);
test('earshot uses walkable door routes', () => {
  assert.equal(earshotDistance(map, coffee, 32, 8), 0);
  assert.equal(earshotDistance(map, coffee, 32, 13), 3);
  assert.equal(earshotDistance(map, coffee, 29, 13), Infinity);
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
  const lobby = map.rooms.find(r => r.id === 'lobby')!, radio = map.objects.find(o => o.type === 'radio')!;
  const far = model(pose(lobby.rect.x, lobby.rect.y + lobby.rect.h - 1), pose(radio.x, radio.y));
  assert.ok(far.gain >= ROOM_FILL - 1e-9, `gain ${far.gain}`);
  assert.ok(model(pose(30, 14), pose(radio.x, radio.y)).gain < ROOM_FILL); // next room: falls off normally
});
test('another room only hears a source near the doorway it comes through; a third room hears nothing', () => {
  const radio = map.objects.find(o => o.type === 'radio')!, src = pose(radio.x, radio.y);
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
test('room override and listener fade affect voices only', () => {
  assert.equal(model(pose(28, 4), pose(37, 9), { room: coffee, sourceMember: true }).gain, 1);
  const a = pose(32, 13), b = pose(32, 8);
  const dry = model(a, b), voice = model(a, b, { room: coffee, sourceMember: true, listener: true });
  assert.equal(voice.gain, dry.gain * zoneGain(3)); assert.equal(voice.send, dry.send * zoneGain(3));
  assert.deepEqual(model(a, b, { room: coffee, listener: true }), dry);
  assert.equal(zoneGain(0), 1); assert.equal(zoneGain(5), 1 - 5 / 6); assert.equal(zoneGain(6), 0);
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
test('radio never receives listener zone fade; knock calls stay flat', () => {
  const radio = map.objects.find(o => o.type === 'radio')!;
  assert.deepEqual(radio.sound, { clip: 'radio', gain: .8 }); assert.equal(map.layers.walkable[radio.y][radio.x], 0);
  const me = pose(14, 14), source = pose(radio.x, radio.y);
  const dry = model(me, source); assert.ok(dry.gain > 0);
  assert.deepEqual(model(me, source, { room: coffee, listener: true }), dry);
  assert.deepEqual(model(pose(2, 5), pose(37, 9), { knock: true }), {
    gain: 1, cutoff: 20000, pan: 0, send: 0, apparent: { x: 37.5, y: 9.5 },
  });
});
