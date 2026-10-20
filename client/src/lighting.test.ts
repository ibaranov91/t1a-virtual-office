import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { roomAt, type TileMap } from '../../shared/map';
import { gloomy, hourBucket, indoorDark, lightsByRoom, lightWeight, nightAt, outdoorDark, tileDarkness } from './lighting';
import { personLight } from './personLight';
import type { ClientUser } from './net';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));

test('the sky: day is bright, dusk eases in, the small hours are the darkest', () => {
  assert.equal(nightAt(12).night, 0);
  assert.equal(nightAt(8).night > 0 && nightAt(8).night < 0.36, true);
  assert.ok(nightAt(19).night > nightAt(18).night);
  assert.equal(nightAt(3).night, 1);
  assert.equal(nightAt(27).night, 1, 'hours wrap');
  assert.ok(gloomy(0, 'rain') > gloomy(0, 'fog') && gloomy(0, 'fog') > gloomy(0, 'clear'));
  assert.ok(gloomy(1, 'rain') <= 1);
});

test('rooms: no lights is very dark, each light eases it, a lit room is never bright, outside is darker than lit rooms', () => {
  const n = 1;
  assert.ok(indoorDark(n, 0) > outdoorDark(n), 'an unlit room is darker than the night outside');
  assert.ok(indoorDark(n, 1) < indoorDark(n, 0) && indoorDark(n, 2) < indoorDark(n, 1) && indoorDark(n, 6) < indoorDark(n, 2));
  assert.ok(indoorDark(n, 100) >= 0.3, 'never bright');
  assert.ok(outdoorDark(n) > indoorDark(n, 2), 'darker outside than in a room with two lights');
  assert.equal(indoorDark(0, 0), 0, 'by day nothing is dark');
});

test('light counting per room: lamps and lit objects, switches that are off count nothing', () => {
  const on = lightsByRoom(map), off = lightsByRoom(map, o => o.use?.kind !== 'toggle');
  assert.ok((on.get('focus') ?? 0) >= 2, 'the Focus room has two lamps');
  assert.ok((off.get('focus') ?? 0) < (on.get('focus') ?? 0), 'lamps switched off give no light');
  assert.ok((on.get('arcade') ?? 0) > 0, 'cabinets glow');
  const lamp = map.objects.find(o => o.type === 'lamp')!;
  assert.equal(lightWeight(lamp), 1);
  assert.equal(lightWeight(lamp, () => false), 0);
  assert.equal(lightWeight(map.objects.find(o => o.type === 'window')!), 0);
  assert.equal([...on.keys()].every(id => map.rooms.some(r => r.id === id)), true);
});

test('per-tile darkness follows the room, outside is open sky, walls take their neighbours', () => {
  const lights = lightsByRoom(map), d = tileDarkness(map, 1, lights), W = map.width;
  const mid = (id: string) => { const r = map.rooms.find(r => r.id === id)!.rect; return d[(r.y + 2) * W + r.x + 2]; };
  assert.ok(Math.abs(mid('beach') - outdoorDark(1)) < 1e-6);
  assert.ok(Math.abs(mid('focus') - indoorDark(1, lights.get('focus') ?? 0)) < 1e-6);
  assert.ok(mid('orangery') > 0, 'every room is darker at night');
  assert.ok(Math.min(...d) >= 0 && Math.max(...d) <= 1);
  const wall = d[11 * W + 5]; // the wall between Focus and Lobby
  assert.ok(wall > 0 && wall < 1);
  assert.equal(roomAt(map, 5, 11), undefined);
  assert.equal(tileDarkness(map, 0, lights).every(v => v === 0), true, 'daylight: no dark anywhere');
});

test('the lightmap cache key changes with the hour bucket only every two minutes', () => {
  assert.equal(hourBucket(21.0), hourBucket(21.01));
  assert.notEqual(hourBucket(21.0), hourBucket(21.1));
});

test('moving lights: a glow stick in hand is a light, empty hands are not', () => {
  assert.equal(personLight({ id: 'x', holding: 'glow_stick' } as unknown as ClientUser), 3);
  assert.equal(personLight({ id: 'y' } as unknown as ClientUser), 0);
});
