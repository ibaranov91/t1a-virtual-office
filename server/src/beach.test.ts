import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { startBots } from './bots';
import { inWing, onMap, terrainAt } from '../../shared/beach';
import { pathDuration, seatAt, pathTo, layoutProblem, withLayout, reindexMap, type TileMap } from '../../shared/map';
import type { ServerMsg } from '../../shared/protocol';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
function people(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const w = new World(structuredClone(map));
  const observer = w.addUser('Observer'); observer.presence = 'online';
  const messages: ServerMsg[] = []; w.connect(observer.id, m => messages.push(m)); messages.length = 0;
  const u = w.addUser('Kim');
  const tick = (ms: number) => { for (let i = 0; i < ms; i += 100) t.mock.timers.tick(Math.min(100, ms - i)); };
  return { w, u, messages, tick };
}
test('offline arrival starts at gate, becomes a beach walker, then departs on clearing', t => {
  const { w, u, messages, tick } = people(t);
  w.setVacation(u, { until: Date.now() + 86400000 });
  assert.equal(u.door, 'arriving'); assert.deepEqual(u.move?.from, map.vacation!.gate); assert.ok(onMap(u));
  tick(90000); assert.equal(u.door, null); assert.equal(u.presence, 'offline'); assert.ok(inWing(w.map, u.tile.x, u.tile.y));
  w.setVacation(u, null); assert.equal(u.vacation, null); assert.equal(u.door, 'leaving');
  assert.ok(messages.some(m => m.t === 'vacation' && m.vacation === null));
  tick(90000); assert.equal(u.door, null); assert.equal(onMap(u), false); assert.deepEqual(u.tile, map.vacation!.gate);
});
test('saved vacation boots in wing without a parade', t => {
  const { w, u } = people(t); w.setVacation(u, { until: Date.now() + 86400000 });
  const next = new World(structuredClone(map)); next.load(w.dump());
  const b = next.users.get(u.id)!; assert.equal(b.door, null); assert.equal(b.move, null); assert.ok(inWing(next.map, b.tile.x, b.tile.y));
});
for (const phase of ['arrival', 'beach', 'departure']) test(`opening a tab during ${phase} wakes at tile being entered`, t => {
  const { w, u, tick } = people(t); w.setVacation(u, { until: Date.now() + 86400000 });
  if (phase !== 'arrival') tick(90000);
  if (phase === 'departure') w.setVacation(u, null);
  tick(110); const next = w.position(u).next;
  w.connect(u.id, () => {});
  assert.equal(u.presence, 'online'); assert.equal(u.door, null); assert.deepEqual(u.move?.to ?? u.tile, next);
  tick(1000); assert.deepEqual(w.position(u).tile, next);
});
test('last tab closes toward vacation gate, expiry on the way hides there', t => {
  const { w, u, tick } = people(t); w.setVacation(u, { until: Date.now() + 86400000 }); tick(90000);
  const c = w.connect(u.id, () => {}); w.walk(u, map.spawn); tick(60000); c.close(); tick(10000);
  assert.equal(u.door, 'leaving'); assert.deepEqual(u.move?.to, map.vacation!.gate);
  w.setVacation(u, null); tick(90000); assert.equal(onMap(u), false); assert.deepEqual(u.tile, map.vacation!.gate);
});
test('custom walk speed sets broadcast and arrival duration', t => {
  const { w, u, messages } = people(t); u.presence = 'offline'; u.tile = map.vacation!.trailFoot;
  const at = w.walk(u, map.vacation!.summit, undefined, Date.now(), 400);
  assert.equal(at, Date.now() + pathDuration(u.path!, 400)); assert.equal(u.move?.ms, 400);
  assert.ok(messages.some(m => m.t === 'move' && m.userId === u.id && m.ms === 400));
});

test('loop runs several rounds without sharing reserved destinations and climbs at 400 ms/tile', t => {
  const { w, u, messages, tick } = people(t);
  const walkers = [u, ...Array.from({ length: 5 }, (_, i) => w.addUser(`Away${i}`))];
  for (const a of walkers) w.setVacation(a, { until: Date.now() + 86400000 });
  const reserved = new Set([...map.vacation!.pierEnds, map.vacation!.summit, ...map.objects.filter(o => o.lie).map(o => ({ x: o.x + Math.floor((o.w - 1) / 2), y: o.y }))].map(s => `${s.x},${s.y}`));
  const seen = new Set<string>();
  for (let i = 0; i < 1200; i++) {
    tick(1000);
    const taken = new Set<string>();
    for (const a of walkers) {
      const k = `${a.tile.x},${a.tile.y}`; seen.add(k);
      if (!reserved.has(k)) continue;
      assert.ok(!taken.has(k), `shared reserved spot ${k}`); taken.add(k);
    }
  }
  for (const t of [map.vacation!.summit, ...map.vacation!.pierEnds]) assert.ok(seen.has(`${t.x},${t.y}`));
  const climbs = messages.filter(m => m.t === 'move' && m.to.x === map.vacation!.summit.x && m.to.y === map.vacation!.summit.y);
  assert.ok(climbs.length >= 2); assert.ok(climbs.every(m => m.t === 'move' && m.ms === 400));
  assert.ok(messages.some(m => m.t === 'holding' && ['cocktail', 'coconut', 'icecream'].includes(m.item ?? '')));
});
test('stroll is used when all activities are occupied or removed', t => {
  const { w, u, tick } = people(t);
  const empty = { objects: w.map.objects.filter(o => !o.lie && o.type !== 'beach_bar'), rugs: w.map.rugs };
  w['setLayout'](empty, w.users.values().next().value!);
  for (const [i, tile] of [map.vacation!.summit, ...map.vacation!.pierEnds, ...map.vacation!.swim].entries()) {
    const b = w.addUser(`Taken${i}`, false, tile); b.presence = 'online';
  }
  w.setVacation(u, { until: Date.now() + 86400000 }); tick(30000);
  assert.equal(terrainAt(w.map, u.tile.x, u.tile.y), 'sand'); assert.equal(seatAt(w.map, u.tile.x, u.tile.y), null);
});
test('layout changes cancel plans and broadcast a walk aside for offline people under new furniture', t => {
  const { w, u, messages, tick } = people(t); w.setVacation(u, { until: Date.now() + 86400000 }); tick(90000);
  w.beach.release(u); u.tile = { x: 58, y: 40 }; u.move = null; u.path = null;
  const furniture = w.map.objects.find(o => o.type === 'sandcastle')!;
  const next = structuredClone(w.layout()); const o = next.objects.find(o => o.id === furniture.id)!; o.x = u.tile.x; o.y = u.tile.y;
  messages.length = 0; assert.equal(w['setLayout'](next, w.users.values().next().value!), true);
  assert.ok(messages.some(m => m.t === 'move' && m.userId === u.id));
  assert.notDeepEqual(u.tile, w.map.spawn); assert.equal(u.presence, 'offline');
  tick(120000); assert.equal(u.door, null); assert.ok(onMap(u));
});
test('a layout edit mid-arrival cannot leave someone stuck carrying a suitcase', t => {
  const { w, u, tick } = people(t); w.setVacation(u, { until: Date.now() + 86400000 }); tick(100);
  assert.equal(w['setLayout'](structuredClone(w.layout()), w.users.values().next().value!), true);
  tick(120000); assert.equal(u.door, null); assert.equal(u.presence, 'offline');
});
test('online vacation changes only the badge; offline walkers cannot be knocked on or followed', t => {
  const { w, u, messages } = people(t), observer = w.findByName('Observer')!;
  u.presence = 'online'; const tile = { ...u.tile };
  w.setVacation(u, { until: Date.now() + 86400000 }); assert.deepEqual(u.tile, tile); assert.equal(u.door, null);
  w.knock(observer, u);
  assert.ok(messages.some(m => m.t === 'knock_reply' && m.reply === 'later' && m.reason?.includes('on vacation — sent to Later')));
  messages.length = 0; u.presence = 'offline'; w.knock(observer, u); w.follow(observer, u);
  assert.equal(observer.following, null); assert.ok(!messages.some(m => m.t === 'knock' || m.t === 'knock_reply'));
  const snapshot = w.snapshot(); assert.equal(snapshot.t, 'state');
  if (snapshot.t === 'state') {
    const pub = snapshot.users.find(p => p.id === u.id)!;
    assert.deepEqual(pub.vacation, u.vacation);
    for (const privateKey of ['email', 'google', 'items', 'path', 'walkSeq']) assert.ok(!(privateKey in pub));
  }
  w.setVacation(u, null);
});
test('closing the last tab walks to the gate and resumes offline activities; reconnect cancels leaving', t => {
  const { w, u, tick } = people(t); w.setVacation(u, { until: Date.now() + 86400000 }); tick(90000);
  const c = w.connect(u.id, () => {}); c.close(); tick(5100);
  const spot = w.position(u).next; const back = w.connect(u.id, () => {});
  assert.equal(u.presence, 'online'); assert.equal(u.door, null); tick(1000); assert.deepEqual(w.position(u).tile, spot);
  back.close(); tick(90000); assert.equal(u.presence, 'offline'); assert.equal(u.door, null); assert.ok(inWing(w.map, u.tile.x, u.tile.y));
});
test('dev vacation bots stay offline through the startup reset, wander loop and renewal', t => {
  const { w, tick } = people(t); startBots(w, 4);
  const bots = [...w.users.values()].filter(u => u.bot), away = bots.slice(-2);
  assert.ok(bots.slice(0, 2).every(u => !u.vacation));
  for (const [i, b] of away.entries()) { assert.equal(b.presence, 'offline'); assert.equal(b.vacation?.until, Date.now() + (i === 0 ? 3 : 9) * 86400000); }
  tick(120000); assert.ok(away.every(b => b.presence === 'offline'));
  away[0].vacation!.until = Date.now(); w.vacations.tick(); assert.ok(away[0].vacation!.until > Date.now()); assert.equal(away[0].presence, 'offline');
});
test('VACATION_BOTS=0 disables fake bot vacations', t => {
  const old = process.env.VACATION_BOTS; process.env.VACATION_BOTS = '0';
  t.after(() => { if (old === undefined) delete process.env.VACATION_BOTS; else process.env.VACATION_BOTS = old; });
  const { w } = people(t); startBots(w, 4); assert.ok([...w.users.values()].filter(u => u.bot).every(u => !u.vacation));
});
test('VACATION_FAKE is case-insensitive, fractional, start-relative and picks up later arrivals', t => {
  const old = process.env.VACATION_FAKE; process.env.VACATION_FAKE = 'kIM:0.01,Lee:3';
  t.after(() => { if (old === undefined) delete process.env.VACATION_FAKE; else process.env.VACATION_FAKE = old; });
  const { w, u, tick } = people(t); const started = Date.now();
  assert.equal(u.vacation?.until, started + .01 * 86400000); tick(10000);
  const lee = w.addUser('LEE'); assert.equal(lee.vacation?.until, started + 3 * 86400000);
});
test('lie furniture has one reachable seat per object', () => {
  for (const o of map.objects.filter(o => o.lie)) {
    let seats = 0;
    for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) if (seatAt(map, x, y)) {
      seats++; assert.ok(pathTo(map, map.vacation!.gate, { x, y }).length);
    }
    assert.equal(seats, 1);
  }
});
test('version 1 migrates wing furniture once; version 2 preserves removed and moved props', t => {
  const { w } = people(t), old = w.dump(); old.version = 1;
  old.layout = { objects: old.layout?.objects ?? w.layout().objects.filter(o => !inWing(w.map, o.x, o.y)), rugs: w.map.rugs };
  const migrated = new World(structuredClone(map)); migrated.load(old);
  assert.equal(migrated.map.objects.filter(o => o.type === 'lounger').length, 6);
  const next = migrated.dump(); assert.equal(next.version, 2);
  next.layout!.objects = next.layout!.objects.filter(o => o.type !== 'hammock');
  const restored = new World(structuredClone(map)); restored.load(next);
  assert.equal(restored.map.objects.filter(o => o.type === 'lounger').length, 6);
  assert.equal(restored.map.objects.some(o => o.type === 'hammock'), false);
});
test('layouts cannot block trail or pier access', () => {
  for (const tile of [map.vacation!.trailFoot, map.vacation!.pierEnds[0]]) {
    const layout = { objects: [...structuredClone(map.objects), { id: 'block', type: 'sandcastle', w: 1, h: 1, ...tile }], rugs: map.rugs };
    assert.ok(layoutProblem(withLayout(map, layout)));
  }
});

test('bots created outside startBots are not automatically put on vacation', t => {
  const { w, tick } = people(t); const b = w.addUser('TestBot', true);
  tick(16000); assert.equal(b.vacation ?? null, null); assert.equal(b.presence, 'online');
});

test('a layout reroute during departure still hides the expired vacationer at the gate', t => {
  const { w, u, tick } = people(t); u.vacation = { until: Date.now() + 86400000 }; u.tile = { x: 58, y: 40 };
  w.setVacation(u, null);
  const tile = u.path!.find(p => p.x === 58 && p.y === 38)!; assert.ok(tile);
  const layout = structuredClone(w.layout()), castle = layout.objects.find(o => o.type === 'sandcastle')!;
  castle.x = tile.x; castle.y = tile.y;
  assert.equal(w['setLayout'](layout, w.findByName('Observer')!), true);
  tick(120000); assert.equal(u.door, null); assert.equal(onMap(u), false); assert.deepEqual(u.tile, map.vacation!.gate);
});

test('no path places an arrival directly and hides a cleared vacation immediately', t => {
  const { w, u, tick, messages } = people(t), gate = w.map.vacation!.gate;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) w.map.layers.walkable[gate.y + dy][gate.x + dx] = 0;
  reindexMap(w.map);
  w.setVacation(u, { until: Date.now() + 86400000 }); tick(1);
  assert.equal(u.door, null); assert.ok(inWing(w.map, u.tile.x, u.tile.y)); assert.notDeepEqual(u.tile, gate);
  assert.ok(messages.some(m => m.t === 'move' && m.userId === u.id && m.from.x === m.to.x && m.from.y === m.to.y));
  w.setVacation(u, null); assert.equal(u.door, null); assert.equal(onMap(u), false);
});

test('bar pauses three seconds, takes a current bar item and goes straight to the next activity', t => {
  const { w, u, tick } = people(t);
  w.beach['rounds'].set(u.id, { round: 0, order: ['bar', 'fishing'] });
  w.setVacation(u, { until: Date.now() + 86400000 });
  const at = u.move!.startedAt + pathDuration(u.path!, u.move!.ms); tick(at - Date.now());
  tick(2999); assert.equal(u.holding, null); tick(1);
  assert.ok(['cocktail', 'coconut', 'icecream'].includes(u.holding!));
  assert.ok(map.vacation!.pierEnds.some(t => t.x === u.move?.to.x && t.y === u.move?.to.y));
});
