import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { WALK_MS_PER_TILE, type TileMap } from '../../shared/map';
import { walkMs } from '../../shared/effects';
import type { ServerMsg } from '../../shared/protocol';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const w = new World(structuredClone(map)), bar = w.map.objects.find(o => o.type === 'beach_bar')!;
  const u = w.addUser('Beach guest', false, { x: bar.x, y: bar.y + bar.h });
  u.presence = 'online';
  const messages: ServerMsg[] = [], { socket } = w.connect(u.id, m => messages.push(m));
  const take = (item: string) => { w.use(u, bar.id, item); t.mock.timers.tick(1250); };
  const drunk = () => u.effects.find(e => e.kind === 'drunk');
  return { w, u, bar, messages, socket, take, drunk, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('a cocktail gives an ordinary visitor a shared, temporary drunk effect and slower moves', t => {
  const { w, u, bar, messages, take, drunk, tick } = setup(t);
  take('cocktail');
  assert.equal(u.holding, 'cocktail');
  assert.equal(drunk()?.data?.level, 1);
  assert.ok(messages.some(m => m.t === 'effects' && m.effects.some(e => e.kind === 'drunk')));
  w.walk(u, { x: bar.x + 3, y: bar.y + bar.h });
  const move = messages.filter(m => m.t === 'move').at(-1) as Extract<ServerMsg, { t: 'move' }>;
  assert.ok(move.ms! > WALK_MS_PER_TILE, 'every client receives the slower pace');
  assert.equal(w.dump().users.find(x => x.id === u.id)!.effects.some(e => e.kind === 'drunk'), false);
  tick(60_250); assert.equal(drunk(), undefined);
});

test('repeated cocktails strengthen the wobble and slow the walk, with capped strength and duration', t => {
  const { u, take, drunk } = setup(t);
  take('cocktail'); const tipsy = walkMs(u.effects);
  take('cocktail'); const drunkPace = walkMs(u.effects);
  take('cocktail'); const wasted = walkMs(u.effects);
  take('cocktail');
  assert.ok(tipsy < drunkPace && drunkPace < wasted, 'each round slows the shared walking pace');
  assert.equal(walkMs(u.effects), wasted, 'further rounds cannot make walking slower');
  assert.equal(drunk()?.data?.level, 3);
  assert.equal(u.effects.filter(e => e.kind === 'drunk').length, 1);
  assert.ok(drunk()!.until! - Date.now() <= 180_000);
  assert.ok(drunk()!.until! - Date.now() > 170_000);
});

test('a coconut removes one drunk level and one minute, then the last level entirely', t => {
  const { u, take, drunk } = setup(t);
  take('cocktail'); take('cocktail');
  const until = drunk()!.until!;
  take('coconut');
  assert.equal(drunk()?.data?.level, 1);
  assert.equal(drunk()?.until, until - 60_000);
  assert.ok(u.effects.some(e => e.kind === 'refreshed'));
  take('coconut'); assert.equal(drunk(), undefined);
});

test('ice cream extinguishes the fire aura and gives temporary cooling without removing unrelated effects', t => {
  const { w, u, take, tick } = setup(t);
  w.addEffect(u, 'fire_aura'); w.addEffect(u, 'unicorns');
  take('icecream');
  assert.equal(u.effects.some(e => e.kind === 'fire_aura'), false);
  assert.ok(u.effects.some(e => e.kind === 'chilled'));
  assert.ok(u.effects.some(e => e.kind === 'unicorns'));
  tick(45_250); assert.equal(u.effects.some(e => e.kind === 'chilled'), false);
});

test('refreshments cannot be forged from another dispenser or an unknown menu item', t => {
  const { w, u, bar, socket, take, tick } = setup(t);
  take('made-up-cocktail'); assert.equal(u.effects.length, 0); assert.equal(u.holding, null);
  const fridge = w.map.objects.find(o => o.type === 'fridge')!;
  u.tile = { x: fridge.x, y: fridge.y + fridge.h }; u.move = null; u.path = null;
  w.use(u, fridge.id, 'cocktail'); tick(2000);
  assert.equal(u.effects.length, 0); assert.equal(u.holding, null);
  u.tile = { x: bar.x, y: bar.y + bar.h };
  for (const kind of ['drunk', 'chilled', 'refreshed']) w.handle(u, { t: 'effect', targetId: u.id, kind, on: true }, socket);
  assert.equal(u.effects.length, 0, 'effects must come from a real interaction');
});

test('walking away before service cancels the cocktail effect', t => {
  const { w, u, bar, drunk, tick } = setup(t);
  w.use(u, bar.id, 'cocktail');
  w.walk(u, { x: bar.x + 4, y: bar.y + bar.h }); tick(3000);
  assert.equal(drunk(), undefined); assert.equal(u.holding, null);
});
