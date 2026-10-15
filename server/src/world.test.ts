import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, type User } from './world';
import { hallDistance, pathDuration, reindexMap, roomAt, sampleMove, seatAt, voiceRooms, WALK_MS_PER_TILE, type TileMap, type Tile } from '../../shared/map';
import { PLANT_DIES_DAYS, PLANT_STAGES, plantDead, ROOM_VOICE_MAX, type ServerMsg } from '../../shared/protocol';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const coffee = map.rooms.find(r => r.id === 'coffee')!;
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const add = (name: string, tile: Tile = { x: 32, y: 14 }, bot = false) => {
    const u = w.addUser(name, bot, tile); u.presence = 'online';
    const messages: ServerMsg[] = [];
    const conn = w.connect(u.id, m => messages.push(m));
    return { u, messages, ...conn };
  };
  const settle = (u: User, tile: Tile) => { u.tile = tile; u.move = null; u.path = null; u.prev = undefined; };
  const join = (u: User) => { settle(u, { x: 32, y: 8 }); w.voiceTick(); };
  const fill = () => Array.from({ length: ROOM_VOICE_MAX }, (_, i) => { const a = add(`M${i}`); join(a.u); return a; });
  return { w, add, settle, join, fill, tick: (ms: number) => t.mock.timers.tick(ms) };
}
const voiceChanges = (messages: ServerMsg[]) => messages.filter(m => m.t === 'call' || m.t === 'voice_wait');
test('250 ms tick joins standing humans outside the door without changing presence or churning', t => {
  const { w, add, tick, settle } = setup(t), a = add('A'); a.u.presence = 'away';
  tick(249); assert.equal(a.u.callId, null); tick(1); assert.equal(a.u.callId, 'room:coffee');
  assert.equal(a.u.presence, 'away'); a.messages.length = 0; tick(2000); assert.deepEqual(voiceChanges(a.messages), []);
  w.handle(a.u, { t: 'presence', presence: 'online' }, a.socket);
  assert.equal(a.u.callId, 'room:coffee');
  w.handle(a.u, { t: 'hand', up: true }, a.socket); w.handle(a.u, { t: 'deafen', on: true }, a.socket);
  settle(a.u, { x: 27, y: 13 }); w.voiceTick();
  assert.equal(a.u.callId, null); assert.equal(a.u.hand, false); assert.equal(a.u.deafened, true); assert.equal(a.u.presence, 'online');
  assert.ok(a.messages.some(m => m.t === 'speaking' && !m.on));
  a.messages.length = 0; tick(1000); assert.deepEqual(voiceChanges(a.messages), []);
});
test('zone hysteresis: join at 6, stay at 7, leave beyond 7; an empty room call is deleted', t => {
  const { w, add, settle } = setup(t), a = add('A', { x: 28, y: 13 });
  assert.equal(hallDistance(map, coffee, 28, 13), 7); w.voiceTick(); assert.equal(a.u.callId, null);
  settle(a.u, { x: 29, y: 13 }); w.voiceTick(); assert.equal(a.u.callId, 'room:coffee');
  settle(a.u, { x: 28, y: 13 }); a.messages.length = 0; w.voiceTick(); assert.equal(a.u.callId, 'room:coffee'); assert.deepEqual(voiceChanges(a.messages), []);
  settle(a.u, { x: 27, y: 13 }); w.voiceTick(); assert.equal(a.u.callId, null); assert.equal(w['calls'].has('room:coffee'), false);
});
test('walking joins and leaves from the current rounded pose, never the destination', t => {
  const { w, add } = setup(t), a = add('A', { x: 27, y: 13 });
  const start = Date.now(); w.walk(a.u, { x: 32, y: 8 }); assert.equal(a.u.callId, null);
  const path = a.u.path!, first = path.findIndex(p => hallDistance(map, coffee, p.x, p.y) <= 6);
  const entry = start + (first - .5) * WALK_MS_PER_TILE;
  w.voiceTick(entry - 1); assert.equal(a.u.callId, null); w.voiceTick(entry); assert.equal(a.u.callId, 'room:coffee');
  const arrived = start + pathDuration(path); w.walk(a.u, { x: 27, y: 13 }, undefined, arrived);
  const out = a.u.path!, last = out.reduce((last, p, i) => hallDistance(map, coffee, p.x, p.y) <= 7 ? i : last, -1);
  const exit = arrived + (last + .5) * WALK_MS_PER_TILE;
  w.voiceTick(exit - 1); assert.equal(a.u.callId, 'room:coffee'); w.voiceTick(exit); assert.equal(a.u.callId, null);
});
test('redirect samples the previous path until the future startedAt', t => {
  const { w, add } = setup(t), a = add('A', { x: 28, y: 13 });
  const start = Date.now(); w.walk(a.u, { x: 32, y: 8 });
  const old = a.u.path!; w.walk(a.u, { x: 27, y: 13 }, undefined, start + 50);
  assert.equal(a.u.move!.startedAt, start + 250); assert.deepEqual(a.u.prev, { path: old, startedAt: start });
  assert.deepEqual(w.position(a.u, start + 100).tile, sampleMove(old, start, start + 100)!.tile);
  w.voiceTick(start + 100); assert.equal(a.u.callId, null); // new path starts at distance 6, old pose is still at 7
  w.voiceTick(start + 130); assert.equal(a.u.callId, 'room:coffee');
  assert.deepEqual(w.position(a.u, start + 250).tile, a.u.move!.from);
});
test('sofa seats inside Coffee are distance zero and retain hall voice', t => {
  const { w, add, settle } = setup(t), a = add('A');
  const sofas = map.objects.filter(o => o.sit && roomAt(map, o.x, o.y)?.id === coffee.id); assert.ok(sofas.length);
  for (const o of sofas) for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) {
    assert.ok(seatAt(map, x, y)); assert.equal(hallDistance(map, coffee, x, y), 0);
    settle(a.u, { x, y }); w.voiceTick(); assert.equal(a.u.callId, 'room:coffee');
  }
});
test('bots, offline humans, disconnected humans and users heading out never join', t => {
  const { w, add, tick } = setup(t);
  const bot = add('Bot', undefined, true), offline = add('Offline'), gone = add('Gone'), thinking = add('Thinking'), leaving = add('Leaving');
  offline.u.presence = 'offline'; gone.close(); thinking.u.door = 'thinking'; leaving.u.door = 'leaving';
  tick(250); for (const a of [bot, offline, gone, thinking, leaving]) assert.equal(a.u.callId, null);
  assert.equal(w['calls'].has('room:coffee'), false);
});
test('crossing Coffee creates a call without existing members and stays joined outside within the zone', t => {
  const { w, add } = setup(t), a = add('A', { x: 24, y: 8 });
  const start = Date.now(); w.walk(a.u, { x: 36, y: 13 });
  const path = a.u.path!, inside = path.findIndex(p => roomAt(map, p.x, p.y)?.id === coffee.id); assert.ok(inside >= 0);
  w.voiceTick(start + inside * WALK_MS_PER_TILE); assert.equal(a.u.callId, 'room:coffee');
  w.voiceTick(start + pathDuration(path)); assert.equal(a.u.callId, 'room:coffee');
});
test('cap waits by zone in order, replays waiting, promotes without churn and retains waiting during a walk', t => {
  const { w, add, fill } = setup(t), members = fill(), a = add('wait1'), b = add('wait2'); w.voiceTick();
  assert.equal(a.u.callId, null); assert.ok(a.messages.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'));
  const replay: ServerMsg[] = []; w.connect(a.u.id, m => replay.push(m)); assert.ok(replay.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'));
  a.messages.length = 0; b.messages.length = 0; w.voiceTick(); assert.deepEqual(voiceChanges(a.messages), []); assert.deepEqual(voiceChanges(b.messages), []);
  w.walk(b.u, { x: 32, y: 13 }); w.voiceTick(); assert.deepEqual(voiceChanges(b.messages), []);
  w.leaveCall(members[0].u); assert.equal(a.u.callId, 'room:coffee'); assert.equal(b.u.callId, null);
  w.leaveCall(members[1].u); assert.equal(b.u.callId, 'room:coffee');
  assert.ok(b.messages.some(m => m.t === 'voice_wait' && m.roomId === null));
});
test('promotion shares eligibility: skips out-of-zone, knock-call, AFK, offline, bot, leaving and disconnected waiters', t => {
  const { w, add, fill, settle } = setup(t), members = fill();
  const waits = Array.from({ length: 9 }, (_, i) => add(`W${i}`)); w.voiceTick();
  settle(waits[0].u, { x: 28, y: 13 }); // distance 7 is only for existing members
  const other = add('Other', { x: 7, y: 17 }); const knock = w.connectCall(waits[1].u, other.u);
  assert.ok(waits[1].messages.some(m => m.t === 'voice_wait' && m.roomId === null));
  waits[2].u.afk = true; waits[3].u.presence = 'offline'; waits[4].u.bot = true; waits[5].u.door = 'leaving'; waits[6].close();
  w.leaveCall(members[0].u); assert.equal(waits[7].u.callId, 'room:coffee'); assert.equal(waits[8].u.callId, null);
  assert.equal(waits[1].u.callId, knock.id);
  for (const i of [0, 2, 3, 4, 5, 6]) assert.equal(waits[i].u.callId, null);
});
test('last departing member promotes a waiter before deleting the call; final disconnect clears waiting', t => {
  const { w, add, fill } = setup(t), members = fill(), a = add('wait1'), b = add('wait2'); w.voiceTick();
  a.close(); for (const m of members.slice(1)) { m.u.door = 'thinking'; }
  b.u.door = 'thinking'; for (const m of members.slice(1)) w.leaveCall(m.u);
  b.u.door = null; w.leaveCall(members[0].u); assert.equal(b.u.callId, 'room:coffee');
  const replay: ServerMsg[] = []; w.connect(a.u.id, m => replay.push(m));
  assert.ok(replay.some(m => m.t === 'voice_wait' && m.roomId === null)); assert.equal(replay.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'), false);
});
test('a tick that promotes its current waiter does not mark that member waiting again', t => {
  const { w, add, fill } = setup(t), members = fill(), a = add('waiter'); w.voiceTick();
  // A slot opens before the next tick gets to this waiter.
  w['calls'].get('room:coffee')!.members.delete(members[0].u.id); members[0].u.callId = null; members[0].u.afk = true;
  a.messages.length = 0; w.voiceTick(); assert.equal(a.u.callId, 'room:coffee');
  assert.equal(a.messages.filter(m => m.t === 'voice_wait' && m.roomId === null).length, 1);
  assert.equal(a.messages.some(m => m.t === 'voice_wait' && m.roomId !== null), false);
  a.messages.length = 0; w.voiceTick(); assert.deepEqual(voiceChanges(a.messages), []);
});
test('knock call wins outside the rect, then yields inside even when the hall is full', t => {
  const { w, add, settle, fill } = setup(t), a = add('A'), b = add('B', { x: 7, y: 17 });
  const knock = w.connectCall(a.u, b.u); w.voiceTick(); assert.equal(a.u.callId, knock.id);
  w.walk(a.u, { x: 32, y: 8 }); w.voiceTick(); assert.equal(a.u.callId, knock.id);
  settle(a.u, { x: 32, y: 8 }); w.voiceTick(); assert.equal(a.u.callId, 'room:coffee'); assert.equal(b.u.callId, null);
  settle(a.u, { x: 32, y: 14 }); w.leaveCall(a.u); fill();
  const second = w.connectCall(a.u, b.u); w.voiceTick(); assert.equal(a.u.callId, second.id);
  settle(a.u, { x: 32, y: 8 }); w.voiceTick(); assert.equal(a.u.callId, null); assert.equal(b.u.callId, null);
  assert.ok(a.messages.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'));
});
test('AFK rejects a home in the zone, walks outside, stays excluded until an own move and keeps private state private', t => {
  const { w, add, join, settle, tick } = setup(t), a = add('A'); join(a.u);
  a.u.homeDesk = { x: 32, y: 15 }; assert.equal(hallDistance(map, coffee, 32, 15), 5);
  w.handle(a.u, { t: 'leave_room' }, a.socket);
  assert.notDeepEqual(a.u.move!.to, a.u.homeDesk); assert.equal(roomAt(map, a.u.move!.to.x, a.u.move!.to.y)?.id, 'lobby');
  assert.ok(voiceRooms(map).every(r => hallDistance(map, r, a.u.move!.to.x, a.u.move!.to.y) > 7));
  assert.equal(a.u.afk, true); assert.equal(a.u.callId, null); tick(20000); assert.equal(a.u.callId, null);
  settle(a.u, { x: 32, y: 8 }); w.voiceTick(); assert.equal(a.u.callId, null);
  w.walk(a.u, { x: 32, y: 9 }); w.voiceTick(); assert.equal(a.u.afk, true); assert.equal(a.u.callId, null);
  w.handle(a.u, { t: 'move', to: { x: 32, y: 8 } }, a.socket); w.voiceTick(); assert.equal(a.u.afk, false); assert.equal(a.u.callId, 'room:coffee');
  const state = w.snapshot(); assert.equal(state.t, 'state');
  if (state.t === 'state') for (const u of state.users) for (const key of ['afk', 'prev', 'path', 'presenceBeforeCall', 'callRole']) assert.equal(key in u, false);
  for (const u of w.dump().users) { assert.equal('afk' in u, false); assert.equal('prev' in u, false); }
});
test('leave_room uses a free home outside every hall; end_call falls back from an occupied home to Lobby', t => {
  const { w, add, join } = setup(t), a = add('A'); join(a.u); a.u.homeDesk = { x: 17, y: 15 };
  w.handle(a.u, { t: 'leave_room' }, a.socket); assert.deepEqual(a.u.move!.to, a.u.homeDesk); assert.equal(a.u.afk, true);
  a.u.afk = false; join(a.u); add('Occupant', a.u.homeDesk);
  w.handle(a.u, { t: 'end_call' }, a.socket); assert.equal(roomAt(map, a.u.move!.to.x, a.u.move!.to.y)?.id, 'lobby'); assert.equal(a.u.callId, null);
});
test('AFK with no destination or no path stays put, leaves immediately and cannot rejoin', t => {
  for (const noTile of [true, false]) {
    const { w, add, join } = setup(t), a = add(`A${noTile}`); join(a.u);
    const isolated = structuredClone(map);
    if (noTile) isolated.rooms = isolated.rooms.filter(r => r.id !== 'lobby');
    else for (let y = 0; y < isolated.height; y++) for (let x = 0; x < isolated.width; x++)
      if (roomAt(isolated, x, y)?.id !== coffee.id) isolated.layers.walkable[y][x] = 0;
    reindexMap(isolated); w.map = isolated; const before = w.position(a.u).tile;
    w.handle(a.u, { t: 'leave_room' }, a.socket);
    assert.equal(a.u.callId, null); assert.equal(a.u.afk, true); assert.equal(a.u.move, null); assert.deepEqual(w.position(a.u).tile, before);
    w.voiceTick(); assert.equal(a.u.callId, null);
    t.mock.timers.reset();
  }
});
test('stale leave_room cannot walk a knock-call member home', t => {
  const { w, add } = setup(t), a = add('A'), b = add('B'); const call = w.connectCall(a.u, b.u);
  w.handle(a.u, { t: 'leave_room' }, a.socket); assert.equal(a.u.callId, call.id); assert.equal(a.u.move, null); assert.equal(a.u.afk, undefined);
});
test('knocks block into a destination or hall member and out of hall voice', t => {
  const { w, add, join, settle } = setup(t), a = add('A', { x: 7, y: 17 }), b = add('B', { x: 8, y: 17 });
  const blocked = (reason: string) => assert.ok(a.messages.some(m => m.t === 'knock_reply' && m.reply === 'blocked' && m.reason === reason));
  settle(b.u, { x: 32, y: 8 }); w.knock(a.u, b.u); blocked('B is in Coffee — just walk in');
  join(b.u); settle(b.u, { x: 32, y: 14 }); w.knock(a.u, b.u); blocked('B is in Coffee — just walk in');
  w.leaveCall(b.u); settle(b.u, { x: 8, y: 17 }); join(a.u); w.knock(a.u, b.u); blocked("You're in Coffee voice — step out to knock");
});
test('all knock guards are rechecked at arrival and accept', t => {
  for (const stage of ['arrival', 'accept']) for (const guard of ['destination', 'source', 'target']) {
    const { w, add, tick, join } = setup(t), a = add('A', { x: 7, y: 17 }), b = add('B', { x: 8, y: 17 }), c = add('C'); join(c.u);
    w.knock(a.u, b.u); const k = [...w.knocks.values()].at(-1)!;
    if (stage === 'accept') { tick(100); assert.equal(k.state, 'pending'); }
    if (guard === 'destination') b.u.tile = { x: 32, y: 8 };
    // Set the identity directly so eager knock cancellation doesn't hide the defensive recheck.
    else (guard === 'source' ? a.u : b.u).callId = c.u.callId;
    if (stage === 'arrival') tick(100); else w.reply(b.u, k.id, 'accept');
    assert.equal(k.state, 'blocked', `${stage}: ${guard}`);
    t.mock.timers.reset();
  }
});
test('joining hall voice cancels walking and pending knocks in either direction; connectCall never reuses it', t => {
  const { w, add, join, tick, settle } = setup(t), a = add('A', { x: 7, y: 17 }), b = add('B', { x: 8, y: 17 });
  w.knock(a.u, b.u); const walking = [...w.knocks.values()].at(-1)!; join(a.u); assert.equal(walking.state, 'later');
  assert.ok(a.messages.some(m => m.t === 'knock_reply' && m.reason === 'Knock cancelled — A walked into Coffee'));
  w.leaveCall(a.u); settle(a.u, { x: 7, y: 17 }); w.knock(a.u, b.u); tick(100);
  const pending = [...w.knocks.values()].at(-1)!; assert.equal(pending.state, 'pending'); join(b.u); assert.equal(pending.state, 'later');
  const c = add('C', { x: 7, y: 17 }), call = w.connectCall(b.u, c.u); assert.notEqual(call.id, 'room:coffee');
});
test('relay is bidirectional within one call, owner-only, and rejects absent, bot and other-call peers', t => {
  const { w, add, join } = setup(t), a = add('A'), b = add('B'), c = add('C', { x: 7, y: 17 }); join(a.u); join(b.u);
  const signal = { kind: 'hello', inst: 'x' } as const;
  a.messages.length = 0; w.handle(b.u, { t: 'rtc', to: a.u.id, signal }, b.socket); assert.ok(a.messages.some(m => m.t === 'rtc'));
  const newer: ServerMsg[] = [], tab = w.connect(b.u.id, m => newer.push(m)); b.messages.length = 0;
  w.handle(a.u, { t: 'rtc', to: b.u.id, signal }, a.socket); assert.equal(b.messages.filter(m => m.t === 'rtc').length, 0); assert.equal(newer.filter(m => m.t === 'rtc').length, 1);
  a.messages.length = 0; w.handle(b.u, { t: 'rtc', to: a.u.id, signal }, b.socket); assert.equal(a.messages.length, 0);
  for (const state of ['thinking', 'leaving', 'offline', 'bot']) {
    b.u.door = state === 'thinking' || state === 'leaving' ? state : null; b.u.presence = state === 'offline' ? 'offline' : 'online'; b.u.bot = state === 'bot';
    w.handle(b.u, { t: 'rtc', to: a.u.id, signal }, tab.socket); assert.equal(a.messages.length, 0);
  }
  c.messages.length = 0; w.handle(a.u, { t: 'rtc', to: c.u.id, signal }, a.socket); assert.equal(c.messages.length, 0);
});
test('ownership transfers on claim and close; non-owner controls are ignored; mute survives calls', t => {
  const { w, add, join, settle } = setup(t), a = add('A'), b = add('B', { x: 7, y: 17 }); join(a.u);
  const tab = w.connect(a.u.id, () => {}); a.messages.length = 0;
  for (const msg of [{ t: 'mute', muted: true }, { t: 'deafen', on: true }, { t: 'hand', up: true }, { t: 'speaking', on: true }] as const) w.handle(a.u, msg, a.socket);
  assert.equal(a.u.muted, false); assert.equal(a.u.deafened, false); assert.equal(a.u.hand, false); assert.equal(a.messages.length, 0);
  w.handle(a.u, { t: 'voice_claim' }, a.socket); w.handle(a.u, { t: 'deafen', on: true }, a.socket); assert.equal(a.u.deafened, true);
  w.handle(a.u, { t: 'voice_claim' }, tab.socket); tab.close(); assert.ok(a.messages.at(-1)?.t === 'voice_owner');
  w.handle(a.u, { t: 'mute', muted: true }, a.socket); w.leaveCall(a.u); settle(a.u, { x: 8, y: 17 });
  const call = w.connectCall(a.u, b.u); assert.equal(a.u.muted, true); assert.equal(a.u.deafened, true);
  w.handle(a.u, { t: 'end_call' }, a.socket); assert.equal(w['calls'].has(call.id), false); assert.equal(a.u.muted, true);
});
test('room calls have no two-hour expiry; disconnect retains grace then leaves', t => {
  const { w, add, join, tick } = setup(t), a = add('A'); join(a.u); tick(2 * 60 * 60_000 + 1); assert.equal(a.u.callId, 'room:coffee');
  a.close(); tick(4999); assert.equal(a.u.callId, 'room:coffee'); tick(1); assert.equal(a.u.callId, null); assert.equal(w['calls'].has('room:coffee'), false);
});
test('radio is always on without a shared knob; lamp toggles still broadcast and persist', t => {
  const { w, add, tick } = setup(t), a = add('A', { x: 7, y: 17 });
  const radio = map.objects.find(o => o.sound)!, lamp = map.objects.find(o => o.use?.kind === 'toggle')!;
  assert.equal(radio.use, undefined); assert.equal(radio.on, undefined);
  w.use(a.u, radio.id); assert.equal(a.u.move, null);
  const before = w.snapshot() as Extract<ServerMsg, { t: 'state' }>; assert.equal(radio.id in before.objects, false);
  w.use(a.u, lamp.id); tick(20000);
  const changed = a.messages.find(m => m.t === 'object' && m.id === lamp.id); assert.ok(changed); assert.equal('volume' in changed, false);
  const saved = w.dump(); assert.equal('objectVolumes' in saved, false);
  const restored = new World(map); restored.load(saved);
  const after = restored.snapshot() as Extract<ServerMsg, { t: 'state' }>; assert.deepEqual(after.objects[lamp.id], { on: !before.objects[lamp.id].on });
});
test('a saved layout is brought up to date with the vault door: added, moved into the wall, kept where the admin put it', t => {
  const { w } = setup(t), safe = map.objects.find(o => o.type === 'safe')!, url = (o: { use?: unknown }) => (o.use as { url: string }).url;
  const load = (objects: typeof map.objects) => { const r = new World(structuredClone(map)); r.load({ ...w.dump(), layout: structuredClone({ objects, rugs: map.rugs }) }); return r.map.objects; };
  const without = map.objects.filter(o => o.type !== 'safe');
  // from before the safe: it appears at its generated spot
  let got = load(without).find(o => o.type === 'safe')!;
  assert.deepEqual([got.x, got.y, got.wall, got.use], [safe.x, safe.y, true, safe.use]);
  // the old floor safe (a box by reception): reshaped, so it goes into the wall where the build puts it
  got = load([...without, { id: 'old', type: 'safe', x: 13, y: 14, w: 1, h: 1, use: { kind: 'link', label: 'vault', url: 'https://old/' } }]).find(o => o.type === 'safe')!;
  assert.deepEqual([got.x, got.y, got.w, got.wall, url(got)], [safe.x, safe.y, 2, true, url(safe)]);
  assert.equal(load(without).some(o => o.id === 'old'), false);
  // the admin moved the door along the wall: it stays there, with the build's link
  got = load([...without, { ...safe, id: 'mine', x: 4, use: { kind: 'link', label: 'vault', url: 'https://old/' } }]).find(o => o.type === 'safe')!;
  assert.deepEqual([got.id, got.x, got.y, url(got)], ['mine', 4, safe.y, url(safe)]);
  // a painting hangs where the door would go: the rest of the layout still loads, without a door
  const painting = without.find(o => o.type === 'painting_small')!;
  const blocked = without.map(o => (o.id === painting.id ? { ...o, x: safe.x, y: safe.y } : o));
  const objects = load(blocked);
  assert.equal(objects.some(o => o.type === 'safe'), false);
  assert.equal(objects.find(o => o.id === painting.id)!.x, safe.x);
});
test('a pot on first login; a status a day grows it, blooms earn badges, a week without one kills it', t => {
  const { w, add, tick } = setup(t), a = add('A'), DAY = 86_400_000, stage = () => a.u.plant?.stage;
  assert.equal(stage(), 0); assert.ok(a.u.plant?.kind); // planted on connect
  const kind = a.u.plant!.kind!;
  w.handle(a.u, { t: 'status', status: '' }, a.socket); assert.equal(stage(), 0); // clearing it isn't tending
  w.handle(a.u, { t: 'status', status: 'hi' }, a.socket); assert.equal(stage(), 1); // today counts already
  assert.ok(a.u.achievements.tended);
  w.handle(a.u, { t: 'status', status: 'again' }, a.socket); assert.equal(stage(), 1); // once a day
  for (let i = 0; i < 8; i++) { tick(DAY); w.handle(a.u, { t: 'status', status: `day ${i + 2}` }, a.socket); }
  assert.equal(stage(), PLANT_STAGES.length - 1); assert.equal(a.u.plant?.kind, kind); // stays in bloom, same flower
  assert.ok(a.u.achievements.bloom); assert.deepEqual(a.u.bloomed, [kind]); assert.equal(a.u.achievements.botanist, undefined);
  tick(PLANT_DIES_DAYS * DAY); assert.ok(plantDead(a.u.plant!, Date.now()));
  w.handle(a.u, { t: 'status', status: 'back' }, a.socket); assert.equal(stage(), 0);
  assert.notEqual(a.u.plant?.kind, kind); // replanted as something new
  assert.ok(a.messages.some(m => m.t === 'plant' && m.achievements.bloom));
});
