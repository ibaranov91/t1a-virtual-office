/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { pathTo, isWalkable, pathDuration, WALK_MS_PER_TILE, type Tile, type TileMap } from '../../shared/map';
import { DUNGEON_INSTANCE, type ServerMsg } from '../../shared/protocol';
import { DungeonView } from './dungeon';

// Canvas recording only: these tests run in Node and never start a browser or server.
const fills = new Map<string, string>();
Object.assign(globalThis, {
  window: { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 },
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { activeElement: null, createElement: () => ({ getContext: () => ({
    fillStyle: '', createRadialGradient: () => ({ addColorStop() {} }), clearRect() { fills.clear(); },
    save() {}, restore() {}, translate() {}, strokeRect() {},
    fillRect(this: { fillStyle: string }, x: number, y: number) { fills.set(`${x},${y}`, this.fillStyle); },
  }) }) },
});
const { Store, MAP } = await import('./net');
const { Engine } = await import('./engine');
test('open voice signs stay visible clear of furniture and interactive wall objects', () => {
  const signs: { x: number; y: number; w: number; h: number }[] = [];
  let x = 0, y = 0;
  const ctx = { save() {}, restore() {}, translate(a: number, b: number) { x = a; y = b; }, fillRect() {},
    strokeRect(a: number, b: number, w: number, h: number) { signs.push({ x: x + a, y: y + b, w, h }); } };
  (Engine.prototype as any).drawOpenVoiceSigns(ctx);
  assert.equal(signs.length, MAP.rooms.filter(r => r.rules.voice === 'open').length);
  const { frames } = JSON.parse(readFileSync(new URL('../public/assets/atlas.json', import.meta.url), 'utf8'));
  for (const s of signs) for (const o of MAP.objects.filter(o => !o.wall || o.use)) {
    const f = frames[o.type]; if (!f) continue;
    const ox = o.x * MAP.tileSize + (o.w * MAP.tileSize - f.w) / 2;
    const oy = o.wall ? o.y * MAP.tileSize : (o.y + o.h) * MAP.tileSize - f.h;
    assert.ok(s.x + s.w <= ox || s.x >= ox + f.w || s.y + s.h <= oy || s.y >= oy + f.h, `sign overlaps ${o.type} at ${o.x},${o.y}`);
  }
});
type ClientUser = import('./net').ClientUser;
const receive = (store: InstanceType<typeof Store>, msg: ServerMsg) => (store as any).onMessage(msg);
function fixture() {
  const map = structuredClone(MAP) as TileMap;
  map.width = 17; map.height = 5; map.tileSize = 16;
  map.layers.walls = Array.from({ length: 5 }, (_, y) => Array.from({ length: 17 }, (_, x) => y === 2 && x > 0 && x < 16 ? 0 : 1));
  map.dungeon = { ...map.dungeon!, rect: { x: 0, y: 0, w: 17, h: 5 }, landing: { x: 1, y: 2 }, torches: [{ x: 7, y: 1 }] };
  return map;
}
test('lantern lights blocking walls themselves, but never reveals tiles or torches past them', () => {
  const map = fixture(); map.layers.walls[2][4] = 1;
  const view = new DungeonView(map), seen = new Set<number>();
  view.update({ x: 1, y: 2 }, [{ x: 8, y: 2 }], seen);
  assert.ok(view.canSee({ x: 4, y: 2 }));
  assert.ok(!view.canSee({ x: 5, y: 2 }));
  assert.ok(!view.canSee({ x: 7, y: 1 }));
  assert.ok(!seen.has(2 * map.width + 8));
});
test('distant torch and visible companions illuminate straight corridors within ten tiles', () => {
  const map = fixture(), view = new DungeonView(map);
  view.update({ x: 1, y: 2 }, [{ x: 10, y: 2 }], new Set());
  assert.ok(view.canSee({ x: 7, y: 2 }));
  assert.ok(view.canSee({ x: 10, y: 2 }));
  assert.ok(!view.canSee({ x: 12, y: 2 }));
});
test('seen terrain persists dim and cool, undiscovered terrain is black, and stationary LOS is cached', t => {
  const map = fixture(), view = new DungeonView(map), seen = new Set<number>();
  view.update({ x: 1, y: 2 }, [], seen);
  view.update({ x: 12, y: 2 }, [], seen);
  assert.ok(!view.canSee({ x: 1, y: 2 })); assert.ok(seen.has(2 * map.width + 1));
  const los = t.mock.method(view as any, 'los');
  view.update({ x: 12, y: 2 }, [], seen);
  assert.equal(los.mock.callCount(), 0);
  view.draw({ drawImage() {} } as unknown as CanvasRenderingContext2D, 100);
  assert.equal(fills.get('16,32'), 'rgba(6,12,24,0.8)');
  assert.equal(fills.get('0,64'), '#000');
  view.update({ x: 12, y: 2 }, [], new Set());
  assert.ok(los.mock.callCount() > 0);
});
function user(instance: string | null = null): ClientUser {
  return { id: 'me', name: 'Dev', instance, tile: { ...MAP.dungeon!.landing }, dir: 'down', presence: 'online',
    move: null, path: null, prev: null, faceOverride: null, achievements: {}, plant: null, bloomed: [] } as unknown as ClientUser;
}
function storeFixture() {
  const store = new Store('', () => {}); store.me = 'me'; store.users.set('me', user());
  store.toast = toast => { store.toasts.push({ ...toast, id: store.toasts.length + 1 }); };
  return store;
}
test('private dungeon state follows instance snapshots, retains seen across key events, and resets on falls', () => {
  const store = storeFixture(), d = MAP.dungeon!;
  receive(store, { t: 'instance', userId: 'me', instance: DUNGEON_INSTANCE, tile: d.landing, dir: 'down' });
  receive(store, { t: 'dungeon', key: d.keySpots[0], hasKey: false, event: 'fell' });
  assert.equal(store.toasts.at(-1)?.text, '🕳 You fell through! Find the key and the way out.');
  const seen = store.dungeon!.seen; seen.add(42);
  receive(store, { t: 'dungeon', key: null, hasKey: true, event: 'key' });
  assert.equal(store.dungeon!.seen, seen); assert.ok(store.dungeon!.hasKey);
  receive(store, { t: 'dungeon', key: null, hasKey: true, event: 'opening' });
  assert.ok(store.dungeonOpening);
  receive(store, { t: 'dungeon', key: null, hasKey: false, event: 'escaped' });
  assert.equal(store.toasts.at(-1)?.text, '☀️ You made it out!');
  receive(store, { t: 'state', users: [user()], objects: {}, jukebox: {}, serverTime: Date.now() });
  assert.equal(store.dungeon, null); assert.equal(store.dungeonOpening, false);
  receive(store, { t: 'instance', userId: 'me', instance: DUNGEON_INSTANCE, tile: d.landing, dir: 'down' });
  receive(store, { t: 'dungeon', key: d.keySpots[1], hasKey: false, event: 'fell' });
  assert.notEqual(store.dungeon!.seen, seen); assert.equal(store.dungeon!.seen.size, 0);
  const toastCount = store.toasts.length;
  receive(store, { t: 'dungeon', key: null, hasKey: false, event: 'gave_up' });
  assert.equal(store.toasts.length, toastCount);
});
test('achievement-only plant messages do not claim that an unchanged plant grew', () => {
  const store = storeFixture(), me = store.users.get('me')!;
  me.plant = { kind: 'daisy', stage: 2, care: 1 } as any;
  receive(store, { t: 'plant', userId: 'me', plant: { ...me.plant! }, bloomed: [], achievements: { escape: 123 } });
  assert.deepEqual(store.toasts.map(t => t.text), ['🗝️ Achievement: Escape artist']);
});
function engineFixture() {
  const store = storeFixture(), me = store.users.get('me')!;
  me.instance = DUNGEON_INSTANCE;
  store.dungeon = { key: null, hasKey: false, seen: new Set() };
  const canvas = { getContext: () => (document.createElement('canvas').getContext('2d')), style: {},
    parentElement: { clientWidth: 800, clientHeight: 600 }, addEventListener() {}, removeEventListener() {} };
  const engine = new Engine(canvas as unknown as HTMLCanvasElement, store, { atlas: { frames: {} } } as any) as any;
  return { store, engine, me };
}
test('click routing requires the entire deterministic route to be seen; door redirects to its front', () => {
  const { store, engine, me } = engineFixture(), d = MAP.dungeon!;
  const route = pathTo(MAP, me.tile, d.doorFront);
  for (const t of route) store.dungeon!.seen.add(t.y * MAP.width + t.x);
  assert.deepEqual(engine.clickTarget(d.door), d.doorFront);
  const mid = route[Math.floor(route.length / 2)]; store.dungeon!.seen.delete(mid.y * MAP.width + mid.x);
  assert.equal(engine.clickTarget(d.door), null);
});
test('held walking sends once per step near arrival, can explore unseen tiles, and stops on release or blur', () => {
  const { store, engine, me } = engineFixture(); store.connected = true;
  let now = 1000; store.now = () => now;
  const direction = [[0, 1], [1, 0], [0, -1], [-1, 0]].find(([dx, dy]) => isWalkable(MAP, me.tile.x + dx * 2, me.tile.y + dy * 2) && isWalkable(MAP, me.tile.x + dx, me.tile.y + dy))!;
  assert.ok(direction); engine.held.set('w', direction);
  const sent: any[] = []; store.send = msg => { sent.push(msg); };
  engine.keyboardStep(); engine.keyboardStep(); assert.equal(sent.length, 1);
  receive(store, { t: 'move', userId: 'me', from: { ...me.tile }, to: sent[0].to, startedAt: now });
  engine.keyboardStep(); assert.equal(sent.length, 1);
  now += pathDuration(me.path!) - 61; engine.keyboardStep(); assert.equal(sent.length, 1);
  now++; engine.keyboardStep(); engine.keyboardStep(); assert.equal(sent.length, 2);
  engine.onKeyUp({ key: 'w' }); now += WALK_MS_PER_TILE; engine.keyboardStep(); assert.equal(sent.length, 2);
  engine.held.set('w', direction); engine.stopKeys(); engine.keyboardStep(); assert.equal(sent.length, 2);
});

test('area changes clear held input, selection and editing, refit zoom and snap the camera', () => {
  const { store, engine, me } = engineFixture();
  engine.editing = true; engine.placing = 'rug'; engine.selected = { kind: 'user', id: 'other' };
  engine.hoverUser = 'other'; engine.held.set('w', [0, -1]); engine.manualCam = true;
  receive(store, { t: 'state', users: [{ ...me, instance: null, tile: MAP.dungeon!.hatch }], objects: {}, jukebox: {}, serverTime: Date.now() });
  assert.equal(engine.area, MAP.office); assert.equal(engine.areaDown, false);
  assert.equal(engine.editing, false); assert.equal(engine.placing, null); assert.equal(engine.selected, null);
  assert.equal(engine.hoverUser, null); assert.equal(engine.held.size, 0); assert.equal(engine.manualCam, false);
  assert.equal(engine.glide, null);
  const expected = engine.clampCam((MAP.dungeon!.hatch.x * MAP.tileSize) + 8 - engine.viewW / 2, MAP.dungeon!.hatch.y * MAP.tileSize - engine.viewH / 2);
  assert.deepEqual(engine.cam, expected);
  const officeMin = engine.minPx;
  receive(store, { t: 'state', users: [{ ...me, instance: DUNGEON_INSTANCE, tile: MAP.dungeon!.landing }], objects: {}, jukebox: {}, serverTime: Date.now() });
  assert.equal(engine.area, MAP.dungeon!.rect); assert.ok(engine.minPx >= officeMin);
  engine.destroy();
});

test('own fall holds the office for sink and fade, then snaps underground; giving up during it still snaps back', t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const { store, engine, me } = engineFixture(), d = MAP.dungeon!;
  receive(store, { t: 'state', users: [{ ...me, instance: null, tile: d.hole }], objects: {}, jukebox: {}, serverTime: Date.now() });
  engine.held.set('w', [0, -1]); engine.editing = true;
  receive(store, { t: 'instance', userId: 'me', instance: DUNGEON_INSTANCE, tile: d.landing, dir: 'down' });
  assert.equal(engine.area, MAP.office); assert.ok(engine.falling());
  assert.equal(engine.held.size, 0); assert.equal(engine.editing, false);
  now += 899; engine.syncArea(); assert.equal(engine.area, MAP.office);
  now += 2; engine.syncArea(); assert.equal(engine.area, d.rect); assert.equal(engine.glide, null);
  receive(store, { t: 'instance', userId: 'me', instance: null, tile: d.hatch, dir: 'down' });
  now += 2000;
  receive(store, { t: 'instance', userId: 'me', instance: DUNGEON_INSTANCE, tile: d.landing, dir: 'down' });
  assert.equal(engine.area, MAP.office);
  engine.manualCam = true;
  receive(store, { t: 'instance', userId: 'me', instance: null, tile: d.hatch, dir: 'down' });
  assert.equal(engine.area, MAP.office); assert.equal(engine.manualCam, false);
  assert.deepEqual(engine.cam, engine.clampCam(d.hatch.x * MAP.tileSize + 8 - engine.viewW / 2, d.hatch.y * MAP.tileSize - engine.viewH / 2));
  engine.destroy();
});
