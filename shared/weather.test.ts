import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { officeDay, officeMinutes } from './officeTime';
import type { TileMap } from './map';
import { FOG_CLEAR, FOG_FULL, FOG_HIDE, FOG_MAX_ALPHA, fogAlpha, fogHides, isOutdoor, isWeather, scheduledWeather, WEATHER_BLOCK_MIN } from './weather';

const map: TileMap = JSON.parse(readFileSync(new URL('./tilemap.json', import.meta.url), 'utf8'));

test('office time is Europe/Berlin, summer and winter', () => {
  const summer = Date.UTC(2026, 6, 1, 22, 30); // 00:30 on 2 July in Berlin (UTC+2)
  assert.equal(officeDay(summer), '2026-07-02');
  assert.equal(officeMinutes(summer), 30);
  const winter = Date.UTC(2026, 0, 15, 22, 59); // 23:59 on 15 January (UTC+1)
  assert.equal(officeDay(winter), '2026-01-15');
  assert.equal(officeMinutes(winter), 23 * 60 + 59);
  assert.equal(officeMinutes(Date.UTC(2026, 9, 18, 12, 0)), 14 * 60); // CEST
});

test('the schedule is the same for everyone, steady inside a block and different between days', () => {
  const day = Date.UTC(2026, 9, 18, 0, 0) - 2 * 3600_000; // office midnight
  const blocks = 24 * 60 / WEATHER_BLOCK_MIN;
  for (let b = 0; b < blocks; b++) {
    const start = day + b * WEATHER_BLOCK_MIN * 60_000, w = scheduledWeather(start + 1000);
    assert.equal(scheduledWeather(start + WEATHER_BLOCK_MIN * 60_000 - 1000), w, `block ${b} holds`);
    assert.ok(isWeather(w));
  }
  const sky = (d: number) => Array.from({ length: blocks }, (_, b) => scheduledWeather(Date.UTC(2026, 9, d, 0, 0) - 2 * 3600_000 + b * WEATHER_BLOCK_MIN * 60_000 + 1000)).join();
  assert.notEqual(sky(18), sky(19), 'another day, another sky');
  assert.equal(sky(18), sky(18));
});

test('over a few months most blocks are clear, some rain, some fog (more of it in the morning)', () => {
  const n = { clear: 0, rain: 0, fog: 0 }, morning = { fog: 0, all: 0 };
  for (let d = 0; d < 120; d++) for (let b = 0; b < 12; b++) {
    const w = scheduledWeather(Date.UTC(2026, 0, 1 + d, b * 2, 30) - 3600_000);
    n[w]++; if (b < 5) { morning.all++; if (w === 'fog') morning.fog++; }
  }
  assert.ok(n.clear > n.rain && n.rain > 0 && n.fog > 0, JSON.stringify(n));
  assert.ok(morning.fog / morning.all > n.fog / (n.clear + n.rain + n.fog), 'fog favours the early hours');
});

test('outdoors: the beach, garden, terrace and mountains; not the rooms or their walls', () => {
  for (const id of ['beach', 'garden', 'terrace', 'mountains']) {
    const r = map.rooms.find(r => r.id === id)!.rect;
    assert.ok(isOutdoor(map, r.x + 1, r.y + 1), id);
  }
  for (const id of ['lobby', 'coffee', 'berghain', 'bookclub']) {
    const r = map.rooms.find(r => r.id === id)!.rect;
    assert.ok(!isOutdoor(map, r.x + 1, r.y + 1), id);
  }
  assert.ok(!isOutdoor(map, 0, 0), 'the building wall is not sky');
});

test('fog: clear near you, thickening to the maximum, and people past the limit outdoors vanish', () => {
  assert.equal(fogAlpha(0), 0);
  assert.equal(fogAlpha(FOG_CLEAR), 0);
  assert.ok(fogAlpha((FOG_CLEAR + FOG_FULL) / 2) > 0 && fogAlpha((FOG_CLEAR + FOG_FULL) / 2) < FOG_MAX_ALPHA);
  assert.equal(fogAlpha(FOG_FULL), FOG_MAX_ALPHA);
  assert.equal(fogAlpha(40), FOG_MAX_ALPHA);
  const beach = map.rooms.find(r => r.id === 'beach')!.rect, me = { x: beach.x + 2, y: beach.y + 3 };
  const at = (dx: number) => ({ x: me.x + dx, y: me.y });
  assert.equal(fogHides(map, 'fog', me, at(8)), true, '8 tiles away is gone');
  assert.equal(fogHides(map, 'fog', me, at(FOG_HIDE - 0.5)), false);
  assert.equal(fogHides(map, 'fog', me, at(3)), false);
  assert.equal(fogHides(map, 'clear', me, at(8)), false);
  assert.equal(fogHides(map, 'rain', me, at(8)), false);
  const lobby = map.rooms.find(r => r.id === 'lobby')!.rect;
  assert.equal(fogHides(map, 'fog', { x: lobby.x + 1, y: lobby.y + 1 }, { x: lobby.x + 10, y: lobby.y + 1 }), false, 'indoors, nothing is outside to hide');
  assert.equal(fogHides(map, 'fog', { x: lobby.x + 1, y: lobby.y + 1 }, { x: beach.x + 3, y: beach.y + 3 }), true, 'a distant person outside is lost in it');
});
