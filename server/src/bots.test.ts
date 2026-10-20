import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { botNames, seedBots } from './bots';
import type { TileMap } from '../../shared/map';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));

test('botNames: the first N names, suffixed when BOT_NAME_SUFFIX-style text is given', () => {
  assert.deepEqual(botNames(2, ''), ['Maya', 'Leo']);
  assert.deepEqual(botNames(2, '(BOT)'), ['Maya (BOT)', 'Leo (BOT)']);
  assert.equal(botNames(99, '').length, 12);
  assert.deepEqual(botNames(0, ''), []);
});

test('seedBots: a changed suffix replaces the persisted bots instead of adding to them', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 }); // World's intervals must not keep the runner alive
  const w = new World(map);
  seedBots(w, botNames(3, ''));
  const bots = () => [...w.users.values()].filter(u => u.bot).map(u => u.name).sort();
  assert.deepEqual(bots(), ['Leo', 'Maya', 'Priya']);
  const person = w.addUser('Kim');
  seedBots(w, botNames(2, '(BOT)'));
  assert.deepEqual(bots(), ['Leo (BOT)', 'Maya (BOT)']);
  assert.ok(w.users.has(person.id), 'people are never touched');
  for (const u of w.users.values()) if (u.bot) assert.ok(u.tile.x >= 0 && u.tile.y >= 0);
});
