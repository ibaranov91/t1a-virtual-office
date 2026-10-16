import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import mapJson from '../../shared/tilemap.json';
import { doorwayTiles, roomAt, type TileMap } from '../../shared/map';
import { voiceSignPositions } from './roomSigns';
const { frames } = JSON.parse(readFileSync(new URL('../public/assets/atlas.json', import.meta.url), 'utf8'));

test('all 18 voice rooms have distinct visible signs clear of furniture and doorway strips', () => {
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
    const strip = doorwayTiles(map, room).flat().filter(p => p.x >= room.rect.x - 1 && p.x <= room.rect.x + room.rect.w && p.y >= room.rect.y - 1 && p.y <= room.rect.y + room.rect.h);
    for (const p of strip) assert.ok(s.x + s.w <= p.x * ts || s.x >= (p.x + 1) * ts || s.y + s.h <= p.y * ts || s.y >= (p.y + 1) * ts, `${s.roomId} sign covers an entrance`);
  }
});
