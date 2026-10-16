import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import mapJson from '../../shared/tilemap.json';
import { doorwayTiles, roomAt, type TileMap } from '../../shared/map';
import { voiceSignPositions } from './roomSigns';
const { frames } = JSON.parse(readFileSync(new URL('../public/assets/atlas.json', import.meta.url), 'utf8'));

test('all 18 voice rooms have distinct visible signs clear of furniture, rugs and doorway strips', () => {
  const map = structuredClone(mapJson) as unknown as TileMap;
  for (const room of map.rooms) room.rules.voice = 'open';
  const signs = voiceSignPositions(map, frames), ts = map.tileSize;
  assert.equal(signs.length, 18);
  assert.equal(new Set(signs.map(s => s.roomId)).size, 18);
  for (const s of signs) {
    const owner = roomAt(map, Math.floor((s.x + s.w / 2) / ts), Math.floor((s.y + s.h / 2) / ts));
    assert.ok(!owner || owner.id === s.roomId, `${s.roomId} sign must not sit in ${owner?.name}`);
    assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= (map.office.x + map.office.w) * ts && s.y + s.h <= (map.office.y + map.office.h) * ts);
    for (const o of map.objects) {
      const f = frames[o.type]; if (!f) continue;
      const x = o.x * ts + (o.w * ts - f.w) / 2, y = o.wall ? o.y * ts : (o.y + o.h) * ts - f.h;
      assert.ok(s.x + s.w <= x || s.x >= x + f.w || s.y + s.h <= y || s.y >= y + f.h, `${s.roomId} sign overlaps ${o.type}`);
    }
    for (const other of signs) if (s !== other) assert.ok(s.x + s.w <= other.x || s.x >= other.x + other.w || s.y + s.h <= other.y || s.y >= other.y + other.h,
      `${s.roomId} and ${other.roomId} signs overlap`);
    const room = map.rooms.find(r => r.id === s.roomId)!;
    const { x, y, w, h } = room.rect;
    const wallCount = map.layers.walls[y - 1]?.slice(x, x + w).filter(Boolean).length ?? 0;
    if (wallCount > w / 2) assert.ok(s.x + s.w <= x * ts || s.x >= (x + w) * ts || s.y + s.h <= y * ts || s.y >= (y + h) * ts,
      `${s.roomId} indoor sign must stay outside the room`);
    for (const rug of map.rugs) assert.ok(s.x + s.w <= rug.x * ts || s.x >= (rug.x + rug.w) * ts || s.y + s.h <= rug.y * ts || s.y >= (rug.y + rug.h) * ts,
      `${s.roomId} sign overlaps rug ${rug.id}`);
    const strip = doorwayTiles(map, room).flat().filter(p => p.x >= room.rect.x - 1 && p.x <= room.rect.x + room.rect.w && p.y >= room.rect.y - 1 && p.y <= room.rect.y + room.rect.h);
    for (const p of strip) assert.ok(s.x + s.w <= p.x * ts || s.x >= (p.x + 1) * ts || s.y + s.h <= p.y * ts || s.y >= (p.y + 1) * ts, `${s.roomId} sign covers an entrance`);
  }
});


test('prod Music layout mounts its sign above the floor with a pixel of sprite clearance', () => {
  const map = structuredClone(mapJson) as unknown as TileMap;
  for (const room of map.rooms) room.rules.voice = room.id === 'music' ? 'open' : undefined;
  map.objects = map.objects.filter(o => o.x + o.w <= 54 || o.x >= 64 || o.y + o.h <= 1 || o.y >= 13);
  const layout: [string, number, number, number, number, boolean?][] = [
    ['jukebox', 54, 7, 2, 2], ['window', 55, 1, 2, 2, true],
    ['plant', 54, 3, 1, 1], ['plant', 63, 3, 1, 1], ['keyboard', 55, 4, 2, 1],
    ['drum_kit', 58, 4, 2, 2], ['bass_amp', 61, 4, 1, 1], ['lofi_tv', 59, 1, 4, 2, true],
    ['sofa', 59, 8, 3, 1], ['painting_small', 55, 12, 1, 1, true], ['records', 62, 12, 2, 1, true],
  ];
  map.objects.push(...layout.map(([type, x, y, w, h, wall], i) => ({ id: `prod-${i}`, type, x, y, w, h, wall })));
  map.rugs = [{ id: 'r8', color: 'orange', x: 55, y: 6, w: 8, h: 4 }];
  const [sign] = voiceSignPositions(map, frames);
  assert.ok(sign.y + sign.h <= 48, `Music sign must be above the floor, got ${sign.x},${sign.y}`);
  for (const o of map.objects) {
    const f = frames[o.type]; if (!f) continue;
    const x = o.x * 16 + (o.w * 16 - f.w) / 2, y = o.wall ? o.y * 16 : (o.y + o.h) * 16 - f.h;
    assert.ok(sign.x + sign.w + 1 <= x || sign.x - 1 >= x + f.w || sign.y + sign.h + 1 <= y || sign.y - 1 >= y + f.h,
      `Music sign needs 1 px clearance from ${o.type}`);
  }
});
