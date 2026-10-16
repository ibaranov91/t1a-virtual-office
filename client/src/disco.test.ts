/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { roomAt, type TileMap } from '../../shared/map';
import { dance, discos, evening, type DanceStep } from './disco';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));

test('the evening comes with the sunset tint and goes at dawn', () => {
  for (const [h, k] of [[12, 0], [17.5, 0], [18, 0.5], [18.5, 1], [21, 1], [0, 1], [3, 1], [6, 1], [6.5, 0.5], [7, 0], [9, 0]]) {
    assert.equal(evening(h), k, `${h}h`);
  }
});

test('the Music room has a disco ball over its floor, lighting the room and its back wall', () => {
  const [d, ...rest] = discos(map), music = map.rooms.find(r => r.id === 'music')!, ts = map.tileSize;
  assert.equal(rest.length, 0);
  assert.equal(roomAt(map, Math.floor(d.x / ts), Math.floor(d.y / ts))?.id, 'music');
  assert.deepEqual(d.clip, { x: music.rect.x * ts, y: (music.rect.y - 2) * ts, w: music.rect.w * ts, h: (music.rect.h + 2) * ts });
  assert.equal(d.jukebox?.use?.kind, 'jukebox');
});

test('dancers dip on the beat; seated people only nod', () => {
  const step: DanceStep = { dx: 0, dy: 0, turn: 0 };
  for (let seed = 0; seed < 6; seed++) {
    assert.equal(dance(0, seed, false, step).dy, 1, 'on the beat');
    assert.equal(dance(300, seed, false, step).dy, 0, 'between beats');
    for (let ms = 0; ms < 8000; ms += 50) {
      const s = dance(ms, seed, true, step);
      assert.ok(s.dx === 0 && s.turn === 0 && (s.dy === 0 || s.dy === 1), 'seated');
    }
  }
  const sways = new Set<number>(), turns = new Set<number>();
  for (let seed = 0; seed < 6; seed++) for (let ms = 0; ms < 8000; ms += 50) {
    const s = dance(ms, seed, false, step); sways.add(s.dx); turns.add(s.turn);
    assert.ok(Math.abs(s.dx) <= 1, 'a little sway, never a step');
  }
  assert.deepEqual([...sways].sort(), [-1, 0, 1]);
  assert.deepEqual([...turns].sort(), [-1, 0, 1]);
});
