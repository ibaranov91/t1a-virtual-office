import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import type { Tile, TileMap } from '../../shared/map';
import type { ClientMsg, ServerMsg } from '../../shared/protocol';
import { scheduledWeather } from '../../shared/weather';
import { itemDef } from '../../shared/items';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const GM_EMAIL = 'ivan.baranov@t1a.com';
const DESK: Tile = { x: 32, y: 12 };

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: Date.UTC(2026, 9, 18, 10, 0) });
  const w = new World(map);
  const add = (name: string, email?: string) => {
    const u = w.addUser(name, false, DESK, email); u.presence = 'online';
    const messages: ServerMsg[] = [];
    return { u, messages, ...w.connect(u.id, m => messages.push(m)) };
  };
  return { w, add, tick: (ms: number) => t.mock.timers.tick(ms) };
}
const weathers = (m: ServerMsg[]) => m.flatMap(x => (x.t === 'weather' ? [x.weather] : []));
const send = (w: World, p: { u: ReturnType<World['addUser']>; socket: string }, msg: ClientMsg) => w.handle(p.u, msg, p.socket);

test('a new connection learns the sky; the schedule moves it by itself', t => {
  const { w, add, tick } = setup(t);
  const a = add('Ann');
  const snap = a.messages.find((m): m is Extract<ServerMsg, { t: 'state' }> => m.t === 'state')!;
  assert.deepEqual(snap.weather, { kind: scheduledWeather(Date.now()), forced: false });
  assert.deepEqual(w.weatherState(), snap.weather);
  // find the next block with a different sky and run the clock there
  const start = Date.now();
  let step = 0;
  while (scheduledWeather(start + step * 600_000) === w.weatherState().kind && step < 200) step++;
  assert.ok(step < 200, 'the sky changes within a couple of days');
  a.messages.length = 0;
  tick(step * 600_000 + 11_000);
  assert.equal(weathers(a.messages).at(-1)?.kind, scheduledWeather(Date.now()));
});

test('only office admins force the weather; auto goes back to the schedule', t => {
  const { w, add } = setup(t);
  const gm = add('Ivan', GM_EMAIL), pleb = add('Pat');
  send(w, pleb, { t: 'gm_weather', weather: 'fog' });
  assert.equal(w.weatherState().forced, false, 'a normal person cannot');
  gm.messages.length = 0;
  send(w, gm, { t: 'gm_weather', weather: 'rain' });
  assert.deepEqual(weathers(gm.messages).at(-1), { kind: 'rain', forced: true });
  assert.deepEqual(weathers(pleb.messages).at(-1), { kind: 'rain', forced: true }, 'everyone gets it');
  send(w, gm, { t: 'gm_weather', weather: 'nonsense' as never });
  assert.equal(w.weatherState().kind, 'rain');
  send(w, gm, { t: 'gm_weather', weather: 'auto' });
  assert.deepEqual(w.weatherState(), { kind: scheduledWeather(Date.now()), forced: false });
});

test('a forced sky survives a restart, the schedule alone saves nothing', t => {
  const { w, add } = setup(t);
  const gm = add('Ivan', GM_EMAIL);
  assert.equal(w.dump().weather, undefined);
  send(w, gm, { t: 'gm_weather', weather: 'fog' });
  const saved = JSON.parse(JSON.stringify(w.dump()));
  assert.equal(saved.weather, 'fog');
  const w2 = new World(map); w2.load(saved);
  assert.deepEqual(w2.weatherState(), { kind: 'fog', forced: true });
});

test('an umbrella in the pockets is public (it opens in the rain); the rest of the pockets are not', t => {
  const { w, add } = setup(t);
  const a = add('Ann'), b = add('Bob');
  a.u.items = ['umbrella', 'drugs'];
  const pub = (w.snapshot() as Extract<ServerMsg, { t: 'state' }>).users.find(u => u.id === a.u.id)!;
  assert.equal(pub.umbrella, true);
  assert.equal('items' in pub, false);
  assert.equal(((w.snapshot() as Extract<ServerMsg, { t: 'state' }>).users.find(u => u.id === b.u.id)!).umbrella, undefined);
  if (itemDef('umbrella')) { // once the 7/11 items are merged: taking and stowing one tells everyone
    b.messages.length = 0;
    a.u.items = [];
    assert.equal(w.moveItem('umbrella', { kind: 'void' }, { kind: 'pockets', id: a.u.id }, null), null);
    assert.deepEqual(b.messages.filter(m => m.t === 'umbrella'), [{ t: 'umbrella', userId: a.u.id, on: true }]);
    assert.equal(w.moveItem('umbrella', { kind: 'pockets', id: a.u.id }, { kind: 'void' }, a.u), null);
    assert.equal(b.messages.filter(m => m.t === 'umbrella').at(-1)?.on, false);
  }
});

test('windows are toggles: closed to start, the beach has its flag', () => {
  const windows = map.objects.filter(o => o.type === 'window' && o.use);
  assert.ok(windows.length >= 4);
  for (const o of windows) { assert.equal(o.use?.kind, 'toggle'); assert.equal(o.on, false); }
  assert.ok(map.objects.some(o => o.type === 'beach_flag'));
});
