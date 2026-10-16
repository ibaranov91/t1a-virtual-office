import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, type User } from './world';
import { DeckStore, Presenter } from './presentation';
import { findPath, isWalkable, doorwayTiles, pathDuration, reindexMap, roomAt, sampleMove, seatAt, voiceRooms, WALK_MS_PER_TILE, type TileMap, type Tile } from '../../shared/map';
import { TRACK, TRACKS } from '../../shared/music';
import { ADMIN_HAT, EFFECTS, hatItem, SPEED_FACTOR, walkMs } from '../../shared/effects';
import { FRAME_MAX_BYTES, FRAME_MIN_INTERVAL_MS, PLANT_DIES_DAYS, PLANT_STAGES, plantDead, ROOM_VOICE_MAX, type ClientMsg, type ServerMsg } from '../../shared/protocol';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const coffee = map.rooms.find(r => r.id === 'coffee')!;
const memberTile = (m: TileMap, t: Tile, r = coffee) => roomAt(m, t.x, t.y)?.id === r.id || doorwayTiles(m, r).some(g => g.some(p => p.x === t.x && p.y === t.y));
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const add = (name: string, tile: Tile = { x: 32, y: 12 }, bot = false) => {
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
test('rect and every doorway tile join; the first step beyond leaves and deletes the empty call', t => {
  const { w, add, settle } = setup(t), a = add('A', { x: 32, y: 13 });
  w.voiceTick(); assert.equal(a.u.callId, null);
  for (const tile of [...doorwayTiles(map, coffee).flat(), { x: 32, y: 8 }]) {
    settle(a.u, tile); w.voiceTick(); assert.equal(a.u.callId, 'room:coffee');
    a.messages.length = 0; w.voiceTick(); assert.deepEqual(voiceChanges(a.messages), []);
    settle(a.u, { x: 32, y: 13 }); w.voiceTick(); assert.equal(a.u.callId, null);
    assert.equal(w['calls'].has('room:coffee'), false);
  }
});
test('walking joins and leaves from the current rounded pose, never the destination', t => {
  const { w, add } = setup(t), a = add('A', { x: 27, y: 13 });
  const start = Date.now(); w.walk(a.u, { x: 32, y: 8 }); assert.equal(a.u.callId, null);
  const path = a.u.path!, first = path.findIndex(p => memberTile(map, p));
  const entry = start + (first - .5) * WALK_MS_PER_TILE;
  w.voiceTick(entry - 1); assert.equal(a.u.callId, null); w.voiceTick(entry); assert.equal(a.u.callId, 'room:coffee');
  const arrived = start + pathDuration(path); w.walk(a.u, { x: 27, y: 13 }, undefined, arrived);
  const out = a.u.path!, last = out.reduce((last, p, i) => memberTile(map, p) ? i : last, -1);
  const exit = arrived + (last + .5) * WALK_MS_PER_TILE;
  w.voiceTick(exit - 1); assert.equal(a.u.callId, 'room:coffee'); w.voiceTick(exit); assert.equal(a.u.callId, null);
});
test('redirect samples the previous path until the future startedAt', t => {
  const { w, add } = setup(t), a = add('A', { x: 32, y: 13 });
  const start = Date.now(); w.walk(a.u, { x: 32, y: 8 });
  const old = a.u.path!; w.walk(a.u, { x: 27, y: 13 }, undefined, start + 50);
  assert.equal(a.u.move!.startedAt, start + 250); assert.deepEqual(a.u.prev, { path: old, startedAt: start });
  assert.deepEqual(w.position(a.u, start + 100).tile, sampleMove(old, start, start + 100)!.tile);
  w.voiceTick(start + 100); assert.equal(a.u.callId, null); // new path starts in the doorway; the old pose is still outside
  w.voiceTick(start + 130); assert.equal(a.u.callId, 'room:coffee');
  assert.deepEqual(w.position(a.u, start + 250).tile, a.u.move!.from);
});
test('sofa seats inside Coffee are inside the rect and retain hall voice', t => {
  const { w, add, settle } = setup(t), a = add('A');
  const sofas = map.objects.filter(o => o.sit && roomAt(map, o.x, o.y)?.id === coffee.id); assert.ok(sofas.length);
  for (const o of sofas) for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) {
    assert.ok(seatAt(map, x, y)); assert.equal(roomAt(map, x, y)?.id, coffee.id);
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
test('crossing Coffee creates a call without existing members and leaves past the doorway', t => {
  const { w, add } = setup(t), a = add('A', { x: 24, y: 8 });
  const start = Date.now(); w.walk(a.u, { x: 36, y: 13 });
  const path = a.u.path!, inside = path.findIndex(p => roomAt(map, p.x, p.y)?.id === coffee.id); assert.ok(inside >= 0);
  w.voiceTick(start + inside * WALK_MS_PER_TILE); assert.equal(a.u.callId, 'room:coffee');
  w.voiceTick(start + pathDuration(path)); assert.equal(a.u.callId, null);
});
test('cap waits inside rect or doorway in order, replays waiting, promotes without churn and retains waiting during a walk', t => {
  const { w, add, fill } = setup(t), members = fill(), a = add('wait1'), b = add('wait2'); w.voiceTick();
  assert.equal(a.u.callId, null); assert.ok(a.messages.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'));
  const replay: ServerMsg[] = []; w.connect(a.u.id, m => replay.push(m)); assert.ok(replay.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'));
  a.messages.length = 0; b.messages.length = 0; w.voiceTick(); assert.deepEqual(voiceChanges(a.messages), []); assert.deepEqual(voiceChanges(b.messages), []);
  w.walk(b.u, { x: 32, y: 13 }); w.voiceTick(); assert.deepEqual(voiceChanges(b.messages), []);
  w.leaveCall(members[0].u); assert.equal(a.u.callId, 'room:coffee'); assert.equal(b.u.callId, null);
  w.leaveCall(members[1].u); assert.equal(b.u.callId, 'room:coffee');
  assert.ok(b.messages.some(m => m.t === 'voice_wait' && m.roomId === null));
});
test('promotion shares eligibility: skips outside rect and doorway, knock-call, AFK, offline, bot, leaving and disconnected waiters', t => {
  const { w, add, fill, settle } = setup(t), members = fill();
  const waits = Array.from({ length: 9 }, (_, i) => add(`W${i}`)); w.voiceTick();
  settle(waits[0].u, { x: 32, y: 13 });
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
test('call_moved reaches only members left behind, even when a singleton ends or the hall is full', t => {
  for (const full of [false, true]) {
    const { w, add, settle, fill } = setup(t);
    if (full) fill();
    const a = add('Ivan', { x: 32, y: 12 }), b = add('B', { x: 7, y: 17 }), c = add('C', { x: 8, y: 17 }), outsider = add('Other', { x: 9, y: 17 });
    const call = w.connectCall(a.u, b.u); w.connectCall(b.u, c.u);
    for (const person of [a, b, c, outsider]) person.messages.length = 0;
    w.voiceTick(); assert.equal(a.u.callId, call.id);
    assert.equal(b.messages.some(m => m.t === 'call_moved'), false);
    settle(a.u, { x: 32, y: 10 }); w.voiceTick();
    const notice = { t: 'call_moved', userId: a.u.id, roomId: 'coffee' };
    assert.deepEqual(b.messages.filter(m => m.t === 'call_moved'), [notice]);
    assert.deepEqual(c.messages.filter(m => m.t === 'call_moved'), [notice]);
    for (const person of [a, outsider]) assert.equal(person.messages.some(m => m.t === 'call_moved'), false);
    assert.equal(b.u.callId, call.id); assert.equal(c.u.callId, call.id);
    assert.equal(a.u.callId, full ? null : 'room:coffee');
    if (full) assert.ok(a.messages.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'));
    b.messages.length = 0; c.messages.length = 0;
    settle(b.u, { x: 32, y: 10 }); w.voiceTick();
    assert.equal(c.u.callId, null);
    assert.deepEqual(c.messages.filter(m => m.t === 'call_moved'), [{ t: 'call_moved', userId: b.u.id, roomId: 'coffee' }]);
    assert.equal(b.messages.some(m => m.t === 'call_moved'), false);
    t.mock.timers.reset();
  }
});
test('meeting instances cannot join or wait for office hall voice', t => {
  const { w, add, join } = setup(t), a = add('A');
  a.u.instance = 'meeting:test'; w.voiceTick(); assert.equal(a.u.callId, null);
  a.u.instance = null; join(a.u); a.u.instance = 'meeting:test';
  w.voiceTick(); assert.equal(a.u.callId, null); assert.equal(w['waiting'].has(a.u.id), false);
});
test('AFK rejects homes on doorway tiles but accepts the former outside zone', t => {
  const { w, add, join } = setup(t), a = add('A'); join(a.u);
  a.u.homeDesk = { x: 32, y: 12 };
  w.handle(a.u, { t: 'leave_room' }, a.socket);
  assert.notDeepEqual(a.u.move!.to, a.u.homeDesk); assert.equal(memberTile(map, a.u.move!.to), false);
  a.u.afk = false; join(a.u); a.u.homeDesk = { x: 32, y: 15 };
  w.handle(a.u, { t: 'leave_room' }, a.socket); assert.deepEqual(a.u.move!.to, a.u.homeDesk);
});
test('AFK rejects a home in the rect, walks outside, stays excluded until an own move and keeps private state private', t => {
  const { w, add, join, settle, tick } = setup(t), a = add('A'); join(a.u);
  a.u.homeDesk = { x: 32, y: 8 };
  w.handle(a.u, { t: 'leave_room' }, a.socket);
  assert.notDeepEqual(a.u.move!.to, a.u.homeDesk); assert.equal(roomAt(map, a.u.move!.to.x, a.u.move!.to.y)?.id, 'lobby');
  assert.ok(voiceRooms(map).every(r => !memberTile(map, a.u.move!.to, r)));
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
const jukebox = map.objects.find(o => o.use?.kind === 'jukebox' && !o.use.genres)!;
const stateOf = (w: World) => (w.snapshot() as Extract<ServerMsg, { t: 'state' }>).jukebox![jukebox.id];
test('jukebox snapshot, actions, private refusals, broadcasts and tick', t => {
  const { w, add, tick } = setup(t), a = add('A', { x: 57, y: 7 }), b = add('B', { x: 60, y: 8 });
  const before = stateOf(w); assert.ok(TRACKS.some(t => t.id === before.track));
  const track = TRACKS.find(t => t.id !== before.track)!;
  a.messages.length = 0; b.messages.length = 0;
  w.handle(a.u, { t: 'jukebox', objectId: jukebox.id, action: 'queue', track: track.id }, a.socket);
  assert.equal(stateOf(w).queue[0].by, a.u.id);
  for (const person of [a, b]) assert.ok(person.messages.some(m => m.t === 'jukebox' && m.id === jukebox.id));
  a.messages.length = 0; b.messages.length = 0;
  w.handle(a.u, { t: 'jukebox', objectId: jukebox.id, action: 'queue', track: track.id }, a.socket);
  assert.deepEqual(a.messages, [{ t: 'notice', text: 'Already in the queue' }]); assert.equal(b.messages.length, 0);
  tick(TRACKS.find(t => t.id === before.track)!.duration + 250);
  assert.equal(stateOf(w).track, track.id); assert.equal(stateOf(w).by, a.u.id);
  assert.ok(b.messages.some(m => m.t === 'jukebox' && m.state.track === track.id));
});
test('jukebox requires a human online in its room, with no meeting instance or outgoing door', t => {
  const { w, add } = setup(t), a = add('A', { x: 57, y: 7 }), b = add('B');
  const before = structuredClone(stateOf(w)), original = { ...a.u };
  for (const patch of [{ tile: { x: 52, y: 17 } }, { bot: true }, { instance: 'meeting' }, { presence: 'offline' as const }, { door: 'thinking' as const }, { door: 'leaving' as const }]) {
    Object.assign(a.u, original, patch); a.messages.length = 0; b.messages.length = 0;
    w.handle(a.u, { t: 'jukebox', objectId: jukebox.id, action: 'pause', playId: before.playId }, a.socket);
    assert.deepEqual(stateOf(w), before); assert.deepEqual(a.messages, [{ t: 'notice', text: 'Walk into Music to pick music' }]); assert.equal(b.messages.length, 0);
  }
});
test('jukebox authorizes the shown mid-walk tile when entering and exiting', t => {
  const { w, add, settle } = setup(t), a = add('A', { x: 58, y: 10 });
  const start = Date.now(); w.walk(a.u, { x: 58, y: 11 });
  const playId = stateOf(w).playId;
  t.mock.timers.setTime(start + 124);
  w.handle(a.u, { t: 'jukebox', objectId: jukebox.id, action: 'pause', playId }, a.socket);
  assert.notEqual(stateOf(w).pausedAt, null);
  t.mock.timers.setTime(start + 126); a.messages.length = 0;
  w.handle(a.u, { t: 'jukebox', objectId: jukebox.id, action: 'play', playId }, a.socket);
  assert.notEqual(stateOf(w).pausedAt, null); assert.equal(a.messages.at(-1)?.t, 'notice');
  t.mock.timers.setTime(start + 524);
  settle(a.u, { x: 58, y: 11 }); w.walk(a.u, { x: 58, y: 9 });
  const entry = Date.now(); t.mock.timers.setTime(entry + 124); a.messages.length = 0;
  w.handle(a.u, { t: 'jukebox', objectId: jukebox.id, action: 'play', playId }, a.socket); assert.equal(a.messages.at(-1)?.t, 'notice');
  t.mock.timers.setTime(entry + 126);
  w.handle(a.u, { t: 'jukebox', objectId: jukebox.id, action: 'play', playId }, a.socket); assert.equal(stateOf(w).pausedAt, null);
});
test('unknown objects and malformed jukebox messages are silently ignored; use does not walk', t => {
  const { w, add } = setup(t), a = add('A', { x: 57, y: 7 });
  const before = structuredClone(stateOf(w)); a.messages.length = 0;
  const base = { t: 'jukebox', objectId: jukebox.id };
  for (const msg of [
    { ...base, action: 'pause', playId: before.playId, objectId: 'missing' },
    { ...base, action: 'pause', playId: before.playId, objectId: map.objects.find(o => o.use?.kind === 'toggle')!.id },
    { ...base, action: 'queue', track: 1 }, { ...base, action: 'unqueue', entry: null },
    ...['pause', 'play', 'skip'].map(action => ({ ...base, action, playId: {} })),
    { ...base, action: 'bad' }, { ...base, action: 'queue' }, { ...base, objectId: 1, action: 'skip', playId: before.playId },
  ]) w.handle(a.u, msg as ClientMsg, a.socket);
  assert.deepEqual(stateOf(w), before); assert.deepEqual(a.messages, []);
  w.use(a.u, jukebox.id); assert.equal(a.u.move, null);
});
test('jukebox dump/load preserves state, ignores removed objects and loads old saves', t => {
  const { w, add } = setup(t), a = add('A', { x: 57, y: 7 });
  w.handle(a.u, { t: 'jukebox', objectId: jukebox.id, action: 'pause', playId: stateOf(w).playId }, a.socket);
  assert.notEqual(stateOf(w).pausedAt, null);
  const saved = w.dump(); saved.jukebox.removed = saved.jukebox[jukebox.id];
  const restored = new World(map); restored.load(saved);
  assert.deepEqual(stateOf(restored), stateOf(w)); assert.deepEqual(Object.keys(restored.dump().jukebox).sort(), [jukebox.id, map.objects.find(o => o.type === 'dj_booth')!.id].sort());
  const old = { ...saved }; delete (old as Partial<typeof saved>).jukebox;
  restored.load(old); assert.ok(stateOf(restored).track);
});
test('lamp toggles still broadcast and persist', t => {
  const { w, add, tick } = setup(t), a = add('A', { x: 7, y: 17 });
  const lamp = map.objects.find(o => o.use?.kind === 'toggle')!;
  const before = w.snapshot() as Extract<ServerMsg, { t: 'state' }>;
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
test('a saved layout with plain world clocks gets their zones, where the admin left them', t => {
  const { w } = setup(t), clocks = map.objects.filter(o => o.type.startsWith('clock_'));
  assert.deepEqual(clocks.map(o => o.use?.kind === 'clock' && o.use.tz), ['America/New_York', 'Europe/Berlin', 'Europe/Moscow']);
  const r = new World(structuredClone(map));
  const objects = map.objects.map(o => (o.type === 'clock_berlin' ? { id: 'old', type: o.type, x: 30, y: o.y, w: 1, h: 1, wall: true } : o.type.startsWith('clock_') ? null : o)).filter((o): o is typeof map.objects[number] => !!o);
  r.load({ ...w.dump(), layout: structuredClone({ objects, rugs: map.rugs }) });
  const got = r.map.objects.filter(o => o.type.startsWith('clock_'));
  assert.equal(got.length, 3); // the missing ones come back at their generated spots
  const berlin = got.find(o => o.type === 'clock_berlin')!;
  assert.deepEqual([berlin.id, berlin.x, berlin.use], ['old', 30, clocks[1].use]);
});
test('a saved layout with a plain DJ booth gets its techno jukebox, where the admin left it', t => {
  const { w } = setup(t), booth = map.objects.find(o => o.type === 'dj_booth')!;
  const objects = map.objects.map(o => (o.id === booth.id ? { id: o.id, type: o.type, x: o.x, y: o.y + 1, w: o.w, h: o.h } : o));
  const r = new World(structuredClone(map));
  r.load({ ...w.dump(), layout: structuredClone({ objects, rugs: map.rugs }) });
  const got = r.map.objects.find(o => o.type === 'dj_booth')!;
  assert.deepEqual([got.y, got.use], [booth.y + 1, booth.use]);
  assert.ok(Object.keys((r.snapshot() as Extract<ServerMsg, { t: 'state' }>).jukebox!).includes(got.id));
});
// gen-map.mjs numbers objects in order, so a build that adds one shifts every id after it (the safe took o57 from a plant)
const olderBuild = (objects: TileMap['objects']) => objects.map(o => ({ ...structuredClone(o), id: `o${Number(o.id.slice(1)) + 1}` }));
const loadLayout = (w: World, objects: TileMap['objects']) => {
  const r = new World(structuredClone(map)); r.load({ ...w.dump(), layout: structuredClone({ objects, rugs: map.rugs }) }); return r;
};
const idsOf = (w: World) => [...w.layout().objects, ...w.layout().rugs].map(o => o.id);
const asAdmin = (w: World) => { const u = w.addUser('Admin', false, { x: 32, y: 12 }); u.email = 'ivan.baranov@t1a.com'; return u; };
test('a fixture new in this build never takes an id a saved layout already uses, and neither does an admin addition', t => {
  const { w } = setup(t), safe = map.objects.find(o => o.type === 'safe')!;
  const saved = olderBuild(map.objects.filter(o => o.type !== 'safe'));
  const holder = saved.find(o => o.id === safe.id)!, cabinets = saved.filter(o => o.type === 'arcade');
  cabinets[1].x = 57;
  const lastRun = { id: `e${Date.now().toString(36)}0`, type: 'plant', x: 3, y: 20, w: 1, h: 1 }; // an addition from before a restart
  const r = loadLayout(w, [...saved, lastRun]), ids = idsOf(r);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(r.map.objects.find(o => o.id === safe.id), safe);
  assert.deepEqual(r.map.objects.find(o => o.id === `${safe.id}-2`), { ...holder, id: `${safe.id}-2` });
  // the cabinets are matched by order, not by their (shifted) ids: three of them, where the admin left them
  assert.deepEqual(r.map.objects.filter(o => o.type === 'arcade').map(o => [o.id, o.x]), cabinets.map(o => [o.id, o.x]));
  assert.equal(r.map.objects.length, saved.length + 2);
  const admin = asAdmin(r);
  r.edit(admin, { op: 'add', type: 'plant', x: 62, y: 25 }); r.edit(admin, { op: 'add', type: 'plant', x: 20, y: 31 });
  const after = idsOf(r);
  assert.equal(after.length, ids.length + 2); assert.equal(new Set(after).size, after.length);
});
test('ids saved twice (prod: a plant and the safe were both o57) are repaired on load, the same way every time', t => {
  const { w } = setup(t), safe = map.objects.find(o => o.type === 'safe')!, plant = map.objects.find(o => o.type === 'plant' && o.x === 1 && o.y === 22)!;
  const saved = [{ ...plant, id: safe.id }, ...map.objects.filter(o => o.id !== plant.id)]; // the plant comes first
  const r = loadLayout(w, saved), ids = idsOf(r);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(r.map.objects.find(o => o.id === safe.id), safe); // the build's fixture keeps its id
  assert.deepEqual(r.map.objects.find(o => o.id === `${safe.id}-2`), { ...plant, id: `${safe.id}-2` });
  assert.equal(r.map.objects.length, saved.length);
  const dumped = r.dump(); assert.deepEqual(dumped.layout, r.layout()); // saved repaired
  const again = new World(structuredClone(map)); again.load(structuredClone(dumped)); assert.deepEqual(again.layout(), r.layout());
  assert.deepEqual(loadLayout(w, saved).layout(), r.layout());
  // edit mode reaches each by its own id
  const admin = asAdmin(r), notices: ServerMsg[] = []; r.connect(admin.id, m => notices.push(m));
  r.edit(admin, { op: 'remove', id: safe.id });
  assert.ok(notices.some(m => m.t === 'notice' && m.text.includes('needs its safe'))); assert.ok(r.map.objects.some(o => o.x === 1 && o.y === 22));
  r.edit(admin, { op: 'remove', id: `${safe.id}-2` });
  assert.equal(r.map.objects.some(o => o.x === 1 && o.y === 22), false); assert.deepEqual(r.map.objects.find(o => o.id === safe.id), safe);
});
test('the east-wing migration keeps every saved object outside the wing, whatever ids its build gave them', t => {
  const { w } = setup(t), key = (o: { type: string; x: number; y: number }) => `${o.type}@${o.x},${o.y}`;
  const inWing = (o: { x: number; y: number; w: number; h: number }) => o.x < 64 && o.x + o.w > 54 && o.y < 23 && o.y + o.h > 3;
  const saved = olderBuild(map.objects.filter(o => o.type !== 'arcade' && o.type !== 'records'));
  const r = loadLayout(w, saved), ids = idsOf(r), kept = new Set(r.map.objects.map(key));
  assert.deepEqual(saved.filter(o => !inWing(o) && !kept.has(key(o))).map(key), []);
  assert.deepEqual(r.map.objects.filter(inWing).map(key).sort(), map.objects.filter(inWing).map(key).sort());
  assert.equal(new Set(ids).size, ids.length);
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
test('leaving a meeting for good clears busy and lets knocks through; Go puts you back in', t => {
  const { w, add, tick } = setup(t), a = add('A', { x: 7, y: 17 }), b = add('B', { x: 8, y: 17 });
  b.u.email = 'b@t1a.com';
  const now = Date.now(), key = 'evt1';
  w.meetings.poll = async () => {}; // no Google here: the 5 s poll would wipe the injected meeting
  w.meetings.events.set(key, { key, title: 'Standup', start: now - 60_000, end: now + 30 * 60_000, emails: ['b@t1a.com'], instance: 'inst1', owners: new Set() });
  w.meetings.tick(); assert.equal(b.u.meeting, now + 30 * 60_000);
  assert.deepEqual(w.meetings.agendaOf(b.u).map(i => i.left), [undefined]);
  w.enterMeeting(b.u, key); assert.equal(b.u.instance, 'inst1');
  w.handle(b.u, { t: 'meeting_leave' }, b.socket); assert.equal(b.u.instance, null); assert.ok(b.u.meeting); // still in the meeting
  w.knock(a.u, b.u); for (let i = 0; i < 10; i++) tick(500); // A walks up, then B's Later timer runs (timers set mid-tick need another tick)
  assert.ok(a.messages.some(m => m.t === 'knock_reply' && m.reply === 'later' && /in a meeting/.test(m.reason ?? '')));
  a.messages.length = 0;
  w.handle(b.u, { t: 'meeting_out', key }, b.socket);
  assert.equal(b.u.meeting, null); assert.deepEqual(w.meetings.agendaOf(b.u).map(i => i.left), [true]);
  assert.ok(b.messages.some(m => m.t === 'agenda' && m.items[0]?.left));
  w.knock(a.u, b.u); for (let i = 0; i < 10; i++) tick(500);
  assert.ok(!a.messages.some(m => m.t === 'knock_reply' && m.reply === 'later'), 'knock stays pending: B is free');
  w.handle(b.u, { t: 'meeting_out', key }, b.socket); w.enterMeeting(b.u, key); // Go after leaving: in the meeting again, busy again
  assert.equal(b.u.instance, 'inst1'); assert.equal(b.u.meeting, now + 30 * 60_000); assert.deepEqual(w.meetings.agendaOf(b.u).map(i => i.left), [undefined]);
  w.handle(b.u, { t: 'meeting_out', key }, b.socket); // from inside the room: out of the room and not busy
  assert.equal(b.u.instance, null); assert.equal(b.u.meeting, null);
  tick(31 * 60_000); assert.equal(w.meetings['left'].get(b.u.id)?.has(key), false); // over: forgotten
});

test('jukebox playback controls throttle only accepted controls for 400 ms', t => {
  const { w, add, tick } = setup(t), a = add('A', { x: 57, y: 7 }), b = add('B', { x: 60, y: 8 });
  const skip = (playId = stateOf(w).playId) => w.handle(a.u, { t: 'jukebox', objectId: jukebox.id, action: 'skip', playId }, a.socket);
  const before = structuredClone(stateOf(w));
  skip('stale'); skip();
  const first = structuredClone(stateOf(w));
  assert.notEqual(first.track, before.track); assert.notEqual(first.playId, before.playId);
  tick(100); a.messages.length = 0; b.messages.length = 0;
  skip();
  assert.deepEqual(stateOf(w), first); assert.deepEqual(a.messages, []); assert.deepEqual(b.messages, []);
  const track = TRACKS.find(t => t.id !== first.track)!;
  w.handle(a.u, { t: 'jukebox', objectId: jukebox.id, action: 'queue', track: track.id }, a.socket);
  assert.equal(stateOf(w).queue[0].track, track.id);
  tick(500); skip();
  assert.equal(stateOf(w).track, track.id); assert.notEqual(stateOf(w).playId, first.playId);
});
test('own move falls only on arrival and sends the key privately', t => {
  const { w, add, tick } = setup(t), a = add('Explorer', { x: 63, y: 26 }), other = add('Observer');
  w.handle(a.u, { t: 'move', to: { x: 63, y: 25 } }, a.socket);
  tick(249); assert.equal(a.u.instance, null);
  tick(1); assert.equal(a.u.instance, 'dungeon');
  assert.deepEqual(a.u.tile, w.map.dungeon!.landing);
  const fell = a.messages.find(m => m.t === 'dungeon' && m.event === 'fell');
  assert.ok(fell?.t === 'dungeon' && w.map.dungeon!.keySpots.some(p => p.x === fell.key?.x && p.y === fell.key?.y));
  assert.equal(other.messages.some(m => m.t === 'dungeon'), false);
  assert.ok(other.messages.some(m => m.t === 'instance' && m.instance === 'dungeon'));
});


const dungeonMessages = (messages: ServerMsg[]) => messages.filter((m): m is Extract<ServerMsg, { t: 'dungeon' }> => m.t === 'dungeon');
function dungeonSetup(t: TestContext) {
  const ctx = setup(t); ctx.w.map = structuredClone(map);
  const a = ctx.add('Explorer', { x: 63, y: 26 });
  ctx.w.handle(a.u, { t: 'move', to: ctx.w.map.dungeon!.hole }, a.socket); ctx.tick(250);
  assert.equal(a.u.instance, 'dungeon');
  const move = (to: Tile) => ctx.w.handle(a.u, { t: 'move', to }, a.socket);
  const arrive = () => ctx.tick(Math.max(0, a.u.move!.startedAt + pathDuration(a.u.path!) - Date.now()));
  return { ...ctx, a, move, arrive, d: ctx.w.map.dungeon! };
}

test('second fall chooses a different key; reconnect replays only the owner state and public state stays clean', t => {
  const { w, a, d, settle, tick, move, add } = dungeonSetup(t);
  const first = a.u.dungeon!.key;
  const replay: ServerMsg[] = []; w.connect(a.u.id, m => replay.push(m));
  assert.deepEqual(dungeonMessages(replay), [{ t: 'dungeon', key: first, hasKey: false }]);
  const other = add('Observer');
  assert.equal(dungeonMessages(other.messages).length, 0);
  assert.deepEqual(w.meetingRooms(), []); w.endMeetings(Infinity); assert.equal(a.u.instance, 'dungeon');
  w.handle(a.u, { t: 'meeting_leave' }, a.socket); assert.equal(a.u.instance, 'dungeon');
  const snapshot = w.snapshot(); assert.ok(snapshot.t === 'state');
  const publicUser = snapshot.users.find(u => u.id === a.u.id)!;
  for (const key of ['walkSeq', 'dungeon', 'lastKeySpot', 'dungeonTimers']) {
    assert.equal(key in publicUser, false); assert.equal(key in w.dump().users.find(u => u.id === a.u.id)!, false);
  }
  w.handle(a.u, { t: 'dungeon_leave' }, a.socket);
  settle(a.u, { x: 63, y: 26 }); move(d.hole); tick(250);
  assert.equal(a.u.instance, 'dungeon'); assert.notDeepEqual(a.u.dungeon!.key, first);
});

test('landing chooses a free dungeon tile when another explorer is already there', t => {
  const { w, add, tick, a, d } = dungeonSetup(t), b = add('Second', { x: 63, y: 26 });
  w.handle(b.u, { t: 'move', to: d.hole }, b.socket); tick(250);
  assert.equal(b.u.instance, 'dungeon'); assert.notDeepEqual(b.u.tile, a.u.tile);
  assert.equal(Math.abs(b.u.tile.x - d.landing.x) + Math.abs(b.u.tile.y - d.landing.y), 1);
});

test('fall clears calls, knocks, waiting, errands and both directions of following', t => {
  const { w, add, tick } = setup(t), a = add('Explorer', { x: 63, y: 26 }), b = add('Partner');
  w.connectCall(a.u, b.u); b.u.following = a.u.id;
  w.knock(b.u, a.u); // closed on fall even if its arrival is still pending
  let used = false;
  w['errands'].set(a.u.id, setTimeout(() => { used = true; }, 1000));
  w.handle(a.u, { t: 'move', to: w.map.dungeon!.hole }, a.socket); tick(250);
  assert.equal(a.u.instance, 'dungeon'); assert.equal(a.u.callId, null); assert.equal(b.u.callId, null);
  assert.equal(b.u.following, null); assert.equal(w['waiting'].has(a.u.id), false);
  assert.ok([...w.knocks.values()].every(k => k.state !== 'walking' && k.state !== 'pending'));
  tick(1000); assert.equal(used, false);
});

for (const scenario of ['crossing', 'redirect', 'bot', 'knock', 'follow', 'stepAside', 'same-destination walk', 'place', 'disconnected', 'leaving'] as const) {
  test(`no accidental fall: ${scenario}`, t => {
    const { w, add, tick } = setup(t); w.map = structuredClone(map);
    const a = add('Explorer', scenario === 'follow' ? { x: 63, y: 26 } : { x: 61, y: 25 }, scenario === 'bot'), d = w.map.dungeon!;
    w.handle(a.u, { t: 'move', to: scenario === 'crossing' ? { x: 63, y: 26 } : d.hole }, a.socket);
    if (scenario === 'redirect') w.handle(a.u, { t: 'move', to: { x: 61, y: 27 } }, a.socket);
    if (scenario === 'knock' || scenario === 'follow') {
      const target = add('Target', { x: 63, y: 26 });
      if (scenario === 'knock') w.knock(a.u, target.u); else w.follow(a.u, target.u);
      if (scenario === 'follow') assert.deepEqual(a.u.tile, d.hole);
      assert.ok(a.u.walkSeq! > 1);
    }
    if (scenario === 'stepAside') {
      const admin = add('Admin'); admin.u.email = 'ivan.baranov@t1a.com';
      w.edit(admin.u, { op: 'add', type: 'plant', x: 62, y: 25 });
      assert.deepEqual(a.u.tile, d.hole); assert.ok(a.u.walkSeq! > 1);
    }
    if (scenario === 'same-destination walk') w.walk(a.u, d.hole);
    if (scenario === 'place') w['place'](a.u, d.hole);
    if (scenario === 'disconnected') a.close();
    if (scenario === 'leaving') a.u.door = 'leaving';
    tick(2000); assert.equal(a.u.instance, null); assert.equal(dungeonMessages(a.messages).length, 0);
  });
}

test('underground bounds, knock reasons, follow, use and cross-instance give are enforced; DMs still work', t => {
  const { w, add, a, d, move } = dungeonSetup(t), b = add('Office'), c = add('Below', d.doorFront);
  c.u.instance = 'dungeon';
  const before = a.u.tile; move(map.spawn); assert.deepEqual(a.u.tile, before); assert.equal(a.u.move, null);
  w.knock(b.u, a.u); w.knock(a.u, b.u);
  const replies = a.messages.filter(m => m.t === 'knock_reply');
  assert.ok(replies.some(m => m.t === 'knock_reply' && m.reason === 'Explorer is somewhere underground 🕳'));
  assert.ok(replies.some(m => m.t === 'knock_reply' && m.reason === "You're underground — find the way out first"));
  w.follow(a.u, c.u); w.follow(c.u, a.u); w.follow(b.u, a.u);
  assert.equal(a.u.following, null); assert.equal(c.u.following, null); assert.equal(b.u.following, null);
  w.setHolding(a.u, 'coffee'); w.give(a.u, b.u); assert.equal(a.u.holding, 'coffee'); assert.equal(b.u.holding, null);
  const machine = w.map.objects.find(o => o.type === 'coffee_machine')!;
  w.use(a.u, machine.id); assert.equal(a.u.move, null);
  w.chat(a.u, b.u, 'Still here'); assert.ok(b.messages.some(m => m.t === 'chat' && m.msg.text === 'Still here'));
  a.u.instance = 'meeting:test'; w.give(a.u, b.u); assert.equal(b.u.holding, null);
});

test('key is picked up at arrival and removed from the private state', t => {
  const { a, move, arrive, tick } = dungeonSetup(t), key = a.u.dungeon!.key!;
  move(key); const duration = pathDuration(a.u.path!); assert.ok(duration > 0);
  tick(duration - 1); assert.equal(a.u.dungeon!.hasKey, false);
  arrive(); assert.deepEqual(a.u.dungeon, { key: null, hasKey: true });
  assert.deepEqual(dungeonMessages(a.messages).at(-1), { t: 'dungeon', key: null, hasKey: true, event: 'key' });
});

test('walking from the key tile collects it at index zero', t => {
  const { w, a, settle, move, tick, d } = dungeonSetup(t), key = a.u.dungeon!.key!;
  settle(a.u, key); move(d.landing); tick(0);
  assert.equal(a.u.dungeon!.hasKey, true);
  assert.equal(dungeonMessages(a.messages).filter(m => m.event === 'key').length, 1);
  assert.ok(w.position(a.u).dest.x !== key.x || w.position(a.u).dest.y !== key.y);
});

test('redirect from the tile being entered waits for actual key arrival', t => {
  const { a, move, tick, d, arrive } = dungeonSetup(t), key = a.u.dungeon!.key!;
  move(key); tick(pathDuration(a.u.path!) - 60); move(d.landing);
  assert.equal(a.u.dungeon!.hasKey, false); tick(59); assert.equal(a.u.dungeon!.hasKey, false);
  tick(1); assert.equal(a.u.dungeon!.hasKey, true); arrive();
});

test('redirect well before reaching a key does not collect it', t => {
  const { a, move, tick, d, arrive } = dungeonSetup(t), key = a.u.dungeon!.key!;
  move(key); tick(100); move(d.landing); arrive();
  assert.equal(a.u.dungeon!.hasKey, false); assert.deepEqual(a.u.dungeon!.key, key);
});

test('a due but unfired key pickup is settled before a new walk invalidates its sequence', t => {
  const { a, move, d } = dungeonSetup(t);
  move(a.u.dungeon!.key!);
  t.mock.timers.setTime(a.u.move!.startedAt + pathDuration(a.u.path!)); // advance clock without executing callbacks
  move(d.landing);
  assert.equal(a.u.dungeon!.hasKey, true);
  assert.equal(dungeonMessages(a.messages).filter(m => m.event === 'key').length, 1);
});

test('early keyboard-style steps preserve key arrival across redirects', t => {
  const { w, a, move, tick } = dungeonSetup(t), key = a.u.dungeon!.key!;
  const path = findPath(w.map, a.u.tile, key);
  for (const p of path.slice(1)) {
    move(p); tick(Math.max(0, a.u.move!.startedAt + pathDuration(a.u.path!) - Date.now() - 60));
  }
  const previous = path[path.length - 2]; move(previous);
  tick(59); assert.equal(a.u.dungeon!.hasKey, false); tick(1); assert.equal(a.u.dungeon!.hasKey, true);
});

test('door without the key stays locked, then opens for 900ms and escapes with a once-only achievement', t => {
  const { w, a, move, arrive, tick, d, settle } = dungeonSetup(t);
  move(d.doorFront); arrive();
  assert.equal(dungeonMessages(a.messages).at(-1)?.event, 'locked'); assert.equal(a.u.instance, 'dungeon');
  move(a.u.dungeon!.key!); arrive(); move(d.doorFront); arrive();
  assert.equal(dungeonMessages(a.messages).at(-1)?.event, 'opening'); tick(899); assert.equal(a.u.instance, 'dungeon');
  a.messages.length = 0; tick(1);
  assert.equal(a.u.instance, null); assert.deepEqual(a.u.tile, d.hatch); assert.equal(a.u.dungeon, undefined);
  const earned = a.u.achievements.escape; assert.ok(earned);
  const escaped = a.messages.findIndex(m => m.t === 'dungeon' && m.event === 'escaped');
  const placed = a.messages.findIndex(m => m.t === 'instance' && m.instance === null);
  assert.ok(escaped >= 0 && placed > escaped);
  assert.ok(a.messages.some(m => m.t === 'plant' && m.achievements.escape === earned));
  settle(a.u, { x: 63, y: 26 }); move(d.hole); tick(250);
  move(a.u.dungeon!.key!); arrive(); move(d.doorFront); arrive(); tick(900);
  assert.equal(a.u.achievements.escape, earned); assert.equal(a.u.instance, null);
});

test('walking away or giving up during opening cancels the delayed escape', t => {
  const { w, a, move, arrive, tick, d } = dungeonSetup(t);
  move(a.u.dungeon!.key!); arrive(); move(d.doorFront); arrive();
  move(d.landing); tick(900); assert.equal(a.u.instance, 'dungeon'); assert.equal(a.u.achievements.escape, undefined);
  arrive(); move(d.doorFront); arrive();
  w.handle(a.u, { t: 'dungeon_leave' }, a.socket); tick(900);
  assert.equal(a.u.instance, null); assert.equal(a.u.achievements.escape, undefined);
});

test('give up exits beside the hole without achievement and chooses an unoccupied tile', t => {
  const { w, add, a, d } = dungeonSetup(t); add('At the exit', { x: 63, y: 26 });
  w.handle(a.u, { t: 'dungeon_leave' }, a.socket);
  assert.equal(a.u.instance, null); assert.notDeepEqual(a.u.tile, d.hole); assert.notDeepEqual(a.u.tile, { x: 63, y: 26 });
  assert.equal(Math.abs(a.u.tile.x - d.hole.x) + Math.abs(a.u.tile.y - d.hole.y), 1);
  assert.ok(findPath(w.map, w.map.spawn, a.u.tile).length); assert.equal(a.u.achievements.escape, undefined);
  assert.equal(dungeonMessages(a.messages).at(-1)?.event, 'gave_up'); assert.equal(a.u.dungeonTimers, undefined);
});

test('escape uses a nearby free tile if the hatch is occupied', t => {
  const { w, add, a, d, move, arrive, tick } = dungeonSetup(t); add('On the hatch', d.hatch);
  move(a.u.dungeon!.key!); arrive(); move(d.doorFront); arrive(); tick(900);
  assert.equal(a.u.instance, null); assert.notDeepEqual(a.u.tile, d.hatch);
  assert.equal(Math.abs(a.u.tile.x - d.hatch.x) + Math.abs(a.u.tile.y - d.hatch.y), 1);
});

test('disconnect keeps dungeon state for reload grace, then quietly exits before walking to the office door', t => {
  const { w, a, tick } = dungeonSetup(t); a.close(); tick(4999); assert.equal(a.u.instance, 'dungeon');
  const replay: ServerMsg[] = [], reload = w.connect(a.u.id, m => replay.push(m));
  assert.equal(dungeonMessages(replay).length, 1); assert.equal(a.u.instance, 'dungeon');
  reload.close(); tick(5000);
  assert.equal(a.u.instance, null); assert.equal(a.u.dungeon, undefined); assert.deepEqual(a.u.move!.to, map.exit);
  assert.equal(dungeonMessages(replay).some(m => m.event === 'gave_up'), false);
  assert.equal(a.u.achievements.escape, undefined); tick(pathDuration(a.u.path!) + 400); assert.equal(a.u.presence, 'offline');
});

test('meeting Go quietly leaves dungeon and enters only the meeting instances map', t => {
  const { w, a } = dungeonSetup(t), now = Date.now(); a.u.email = 'explorer@t1a.com';
  w.meetings.events.set('standup', { key: 'standup', title: 'Standup', start: now - 1000, end: now + 60000,
    emails: ['explorer@t1a.com'], instance: 'meeting:test', owners: new Set() });
  w.handle(a.u, { t: 'meeting_go', key: 'standup' }, a.socket);
  assert.equal(a.u.instance, 'meeting:test'); assert.equal(a.u.dungeon, undefined);
  assert.equal(roomAt(w.map, a.u.tile.x, a.u.tile.y)?.id, 'meeting');
  assert.deepEqual(w.meetingRooms().map(r => r.id), ['meeting:test']);
  assert.equal(dungeonMessages(a.messages).some(m => m.event === 'gave_up'), false);
});

const plantAt = (id: string, t: Tile) => ({ id, type: 'plant', ...t, w: 1, h: 1 });
test('dump and legacy underground saves relocate to the reachable gave-up exit without persisting dungeon state', t => {
  const { w, a, d } = dungeonSetup(t), data = w.dump(), saved = data.users.find(u => u.id === a.u.id)!;
  assert.notDeepEqual(saved.tile, d.hole); assert.ok(findPath(w.map, w.map.spawn, saved.tile).length);
  saved.tile = d.landing;
  const loaded = new World(structuredClone(map)); loaded.load(data);
  const u = loaded.users.get(a.u.id)!;
  assert.equal(u.instance, null); assert.equal(u.dungeon, undefined); assert.notDeepEqual(u.tile, d.hole);
  assert.ok(findPath(loaded.map, loaded.map.spawn, u.tile).length);
});

test('saved entrance-covering objects and rugs are removed by name, keeping the other furniture', t => {
  const { w, d } = dungeonSetup(t), data = w.dump(), warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.join(' ')));
  data.layout = { objects: [...structuredClone(map.objects), plantAt('oldPlant', d.hole)],
    rugs: [...structuredClone(map.rugs), { id: 'oldRug', color: 'green', ...d.hatch, w: 2, h: 1 }] };
  const loaded = new World(structuredClone(map)); loaded.load(data);
  assert.deepEqual(loaded.map.objects.map(o => o.id), map.objects.map(o => o.id)); assert.equal(loaded.map.rugs.length, map.rugs.length);
  assert.ok(warnings.some(w => /plant.*dropped/.test(w))); assert.ok(warnings.some(w => /green rug.*dropped/.test(w)));
  assert.ok(loaded.dump().layout);
});

for (const entrance of ['hole', 'hatch'] as const) {
  test(`saved layout that walls in the ${entrance} stays loaded; exit falls back to Lobby`, t => {
    const { w, a, d, move, arrive, tick, settle } = dungeonSetup(t), data = w.dump(), warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.join(' ')));
    const blockers = entrance === 'hole' ? [{ x: 62, y: 25 }, { x: 63, y: 26 }]
      : [{ x: 19, y: 32 }, { x: 20, y: 31 }, { x: 21, y: 32 }];
    data.layout = { objects: [...structuredClone(map.objects), ...blockers.map((p, i) => plantAt(`barrier${i}`, p))], rugs: structuredClone(map.rugs) };
    const loaded = new World(structuredClone(map)); loaded.load(data);
    assert.ok(loaded.dump().layout); assert.equal(loaded.map.objects.length, map.objects.length + blockers.length);
    assert.ok(warnings.some(w => w.includes(`blocks the ${entrance}`)));
    assert.equal(findPath(loaded.map, map.spawn, d[entrance]).length, 0);
    w.map = loaded.map;
    if (entrance === 'hatch') { move(a.u.dungeon!.key!); arrive(); move(d.doorFront); arrive(); tick(900); }
    else w.handle(a.u, { t: 'dungeon_leave' }, a.socket);
    assert.equal(roomAt(w.map, a.u.tile.x, a.u.tile.y)?.id, 'lobby');
    if (entrance === 'hole') {
      settle(a.u, map.spawn); move(d.hole); assert.equal(a.u.move, null); tick(1000); assert.equal(a.u.instance, null);
    }
  });
}

test('edits cannot leave the office, cover either entrance (even walkable objects), or isolate them', t => {
  const { w, add } = setup(t); w.map = structuredClone(map);
  const admin = add('Admin'); admin.u.email = 'ivan.baranov@t1a.com';
  const refused = (edit: Parameters<World['edit']>[1], reason: string) => {
    const before = JSON.stringify(w.layout()); admin.messages.length = 0; w.edit(admin.u, edit);
    assert.equal(JSON.stringify(w.layout()), before);
    assert.ok(admin.messages.some(m => m.t === 'notice' && m.text.includes(reason)), JSON.stringify(admin.messages));
  };
  refused({ op: 'add', type: 'plant', ...w.map.dungeon!.landing }, 'outside the office');
  refused({ op: 'rug_add', x: w.map.office.w - 1, y: 32, w: 2, h: 2 }, 'outside the office');
  for (const name of ['hole', 'hatch'] as const) {
    const p = w.map.dungeon![name];
    refused({ op: 'add', type: 'plant', ...p }, `covers the ${name}`);
    refused({ op: 'add', type: 'chair', ...p }, `covers the ${name}`);
    refused({ op: 'rug_add', x: p.x - 1, y: p.y, w: 2, h: 2 }, `covers the ${name}`);
  }
  w.edit(admin.u, { op: 'add', type: 'plant', x: 62, y: 25 });
  refused({ op: 'add', type: 'plant', x: 63, y: 26 }, 'blocks the hole');
  for (const p of [{ x: 19, y: 32 }, { x: 20, y: 31 }]) w.edit(admin.u, { op: 'add', type: 'plant', ...p });
  refused({ op: 'add', type: 'plant', x: 21, y: 32 }, 'blocks the hatch');
});

function instrumentSetup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(structuredClone(map));
  const objects = w.map.objects.filter(o => o.use?.kind === 'instrument');
  const add = (name: string, tile: Tile = { x: 57, y: 7 }, bot = false) => {
    const u = w.addUser(name, bot, tile); u.presence = 'online';
    const messages: ServerMsg[] = [], conn = w.connect(u.id, m => messages.push(m));
    return { u, messages, ...conn };
  };
  const state = () => (w.snapshot() as Extract<ServerMsg, { t: 'state' }>).instruments!;
  const play = (a: ReturnType<typeof add>, o = objects[0]) => w.handle(a.u, { t: 'instrument', objectId: o.id, action: 'play' }, a.socket);
  const leave = (a: ReturnType<typeof add>, o = objects[0]) => w.handle(a.u, { t: 'instrument', objectId: o.id, action: 'leave' }, a.socket);
  const note = (a: ReturnType<typeof add>, change: Partial<Extract<ClientMsg, { t: 'note' }>> = {}) => w.handle(a.u, { t: 'note', objectId: objects[0].id, note: 60, on: true, vel: 100, preset: 0, at: Date.now(), ...change }, a.socket);
  const tick = (ms = 10000) => t.mock.timers.tick(ms);
  return { w, objects, add, state, play, leave, note, tick };
}
const notes = (messages: ServerMsg[]) => messages.filter(m => m.t === 'note');
test('instrument walks behind, claims on arrival, socket-only seat, snapshot, idempotence and taken notice', t => {
  const { w, objects, add, state, play, tick } = instrumentSetup(t), a = add('Alice Smith'), b = add('Bob');
  const other: ServerMsg[] = []; w.connect(a.u.id, m => other.push(m));
  play(a); assert.equal(state()[objects[0].id], null); assert.equal(a.u.tile.y, 3); assert.equal(a.u.dir, 'down');
  tick(); assert.equal(state()[objects[0].id], a.u.id);
  assert.ok(a.messages.some(m => m.t === 'seat' && m.id === objects[0].id)); assert.equal(other.some(m => m.t === 'seat'), false);
  assert.ok(b.messages.some(m => m.t === 'instrument' && m.player === a.u.id));
  a.messages.length = 0; play(a); assert.equal(a.messages.length, 0);
  play(b); assert.ok(b.messages.some(m => m.t === 'notice' && m.text === 'Alice is playing the keys'));
});
test('instrument claims immediately beside it; other tab cannot leave; leave, walk and close end at once', t => {
  const { w, objects, add, state, play, leave } = instrumentSetup(t), a = add('A', { x: 55, y: 3 });
  const second = w.connect(a.u.id, () => {});
  play(a); assert.equal(state()[objects[0].id], a.u.id);
  leave({ ...a, socket: second.socket }); assert.equal(state()[objects[0].id], a.u.id);
  leave(a); assert.equal(state()[objects[0].id], null); assert.ok(a.messages.some(m => m.t === 'seat' && m.id === null));
  play(a); w.walk(a.u, { x: 57, y: 3 }); assert.equal(state()[objects[0].id], null);
  a.u.move = null; a.u.path = null; a.u.tile = { x: 55, y: 3 }; play(a); a.close(); assert.equal(state()[objects[0].id], null);
});
test('playing from another tab of the same person moves the seat there, without a notice', t => {
  const { w, objects, add, state, play } = instrumentSetup(t), a = add('A', { x: 55, y: 3 });
  const seconds: ServerMsg[] = [], second = w.connect(a.u.id, m => seconds.push(m));
  play(a); assert.equal(state()[objects[0].id], a.u.id);
  a.messages.length = 0; play({ ...a, socket: second.socket });
  assert.equal(w['seats'].get(objects[0].id)?.socket, second.socket); assert.equal(state()[objects[0].id], a.u.id);
  assert.ok(a.messages.some(m => m.t === 'seat' && m.id === null)); assert.ok(seconds.some(m => m.t === 'seat' && m.id === objects[0].id));
  assert.equal([...a.messages, ...seconds].some(m => m.t === 'notice'), false);
});
test('pending claims cancel on move, use, follow, another play and socket close', t => {
  const { w, objects, add, state, play, tick } = instrumentSetup(t), a = add('A');
  for (const msg of [{ t: 'move', to: { x: 57, y: 8 } }, { t: 'use', objectId: 'missing' }, { t: 'follow', targetId: null }] as ClientMsg[]) {
    a.u.tile = { x: 57, y: 7 }; a.u.move = null; a.u.path = null; play(a); w.handle(a.u, msg, a.socket); tick(); assert.equal(state()[objects[0].id], null);
  }
  play(a); play(a, objects[1]); tick(); assert.equal(state()[objects[0].id], null); assert.equal(state()[objects[1].id], a.u.id);
  w.walk(a.u, { x: 57, y: 7 }); tick(); play(a); a.close(); tick(); assert.equal(state()[objects[0].id], null);
});
test('claim arrival guards reject a redirect still walking and an ineligible user', t => {
  const { w, objects, add, state, play, tick } = instrumentSetup(t), a = add('A');
  play(a); const arrival = a.u.move!.startedAt + pathDuration(a.u.path!);
  tick(100); w.walk(a.u, { x: 62, y: 10 }); w.walk(a.u, { x: 55, y: 3 });
  tick(arrival - Date.now()); assert.equal(state()[objects[0].id], null);
  tick(); a.u.tile = { x: 57, y: 7 }; a.u.move = null; a.u.path = null; play(a); a.u.instance = 'meeting'; tick(); assert.equal(state()[objects[0].id], null);
});
test('switching seats ends previous; tick backstop rejects offline, thinking, instance and missing objects', t => {
  const { w, objects, add, state, play, tick } = instrumentSetup(t), a = add('A', { x: 55, y: 3 });
  play(a); play(a, objects[1]); assert.equal(state()[objects[0].id], null); tick(); assert.equal(state()[objects[1].id], a.u.id);
  // Separate users keep this independent of the per-user transition limit.
  for (const change of ['offline','thinking','instance','object'] as const) {
    const b = add(change, { x: 61, y: 3 }); play(b, objects[2]); assert.equal(state()[objects[2].id], b.u.id);
    if (change === 'offline') b.u.presence = 'offline';
    if (change === 'thinking') b.u.door = 'thinking';
    if (change === 'instance') b.u.instance = 'meeting';
    if (change === 'object') w.map.objects = w.map.objects.filter(o => o.id !== objects[2].id);
    tick(250); assert.equal(w['seats'].has(objects[2].id), false);
  }
});
test('seat transitions limited across seats; bots, instances and malformed actions ignored', t => {
  const { w, objects, add, state, play, leave, tick } = instrumentSetup(t), a = add('A', { x: 55, y: 3 });
  for (let i = 0; i < 3; i++) { play(a); leave(a); }
  play(a); assert.equal(state()[objects[0].id], a.u.id); // spec rejects more than six recent changes
  leave(a); play(a); assert.equal(state()[objects[0].id], null);
  tick(10001); play(a); assert.equal(state()[objects[0].id], a.u.id);
  leave(a);
  for (const b of [add('Bot', { x: 55, y: 3 }, true), add('Instance', { x: 55, y: 3 })]) { if (!b.u.bot) b.u.instance = 'meeting'; play(b); assert.equal(state()[objects[0].id], null); }
  w.handle(a.u, { t: 'instrument', objectId: objects[0].id, action: 'bad' } as unknown as ClientMsg, a.socket); assert.equal(state()[objects[0].id], null);
  w.use(a.u, objects[0].id); tick(); assert.equal(state()[objects[0].id], null);
});
test('notes validate socket, types, pitch, velocity, preset; relay to other tabs and humans outside instances', t => {
  const { w, add, play, note } = instrumentSetup(t), a = add('A', { x: 55, y: 3 }), b = add('B'), c = add('C'), bot = add('Bot', undefined, true);
  c.u.instance = 'meeting'; const other: ServerMsg[] = [], conn = w.connect(a.u.id, m => other.push(m)); play(a);
  const bad = [{ note: 1.5 }, { note: 128 }, { vel: 0 }, { vel: 128 }, { preset: 3 }, { at: Infinity }, { on: 1 }, { note: '60' }, { vel: 1.5 }, { preset: .5 }, { objectId: 1 }];
  for (const change of bad) note(a, change as never);
  note({ ...a, socket: conn.socket }); note(b); assert.equal(notes(b.messages).length, 0);
  note(a, { at: Date.now() - 10000 });
  assert.equal(notes(a.messages).length, 0); assert.equal(notes(other).length, 1); assert.equal(notes(b.messages).length, 1); assert.equal(notes(c.messages).length, 0); assert.equal(notes(bot.messages).length, 0);
  assert.equal(notes(b.messages)[0].at, Date.now() - 2000);
  note(a, { on: false, vel: -50, preset: -10, at: Date.now() + 10000 }); assert.equal(notes(b.messages).at(-1)!.at, Date.now() + 500);
  note(a, { on: false }); assert.equal(notes(b.messages).length, 2);
  a.u.move = { from: { x: 55, y: 3 }, to: a.u.tile, startedAt: Date.now() }; a.u.path = [{ x: 56, y: 3 }, a.u.tile];
  note(a); assert.equal(notes(b.messages).length, 2);
});
test('held notes bounded and deduplicated; offs bypass bucket; note bucket persists across seats and refills', t => {
  const { add, play, leave, note, tick } = instrumentSetup(t), a = add('A', { x: 55, y: 3 }), b = add('B'); play(a);
  note(a); note(a); assert.equal(notes(b.messages).length, 1);
  for (let n = 0; n < 32; n++) note(a, { note: n });
  assert.equal(notes(b.messages).length, 32);
  note(a, { on: false });
  for (let n = 0; n < 32; n++) note(a, { note: n, on: false });
  b.messages.length = 0;
  // Exactly 32 accepted ons have spent half the bucket.
  for (let i = 0; i < 32; i++) { note(a); note(a, { on: false }); }
  assert.equal(notes(b.messages).length, 64);
  leave(a); play(a); note(a); assert.equal(notes(b.messages).length, 64);
  tick(25); note(a); note(a, { on: false }); note(a); assert.equal(notes(b.messages).length, 66);
});
test('drums allow repeated hits, ignore offs and validate GM pads', t => {
  const { objects, add, play, note } = instrumentSetup(t), a = add('A', { x: 58, y: 3 }), b = add('B'); play(a, objects[1]);
  const hit = { objectId: objects[1].id, note: 36 };
  note(a, hit); note(a, hit); note(a, { ...hit, on: false }); note(a, { ...hit, note: 60 }); assert.equal(notes(b.messages).length, 2);
});

test('instrument arrival rechecks object existence, kind and every eligibility condition', t => {
  const { w, objects, add, state, play, tick } = instrumentSetup(t);
  for (const condition of ['offline', 'thinking', 'leaving', 'instance', 'bot', 'removed', 'kind'] as const) {
    const a = add(condition); play(a);
    const o = w.map.objects.find(o => o.id === objects[0].id)!, original = o.use;
    if (condition === 'offline') a.u.presence = 'offline';
    if (condition === 'thinking' || condition === 'leaving') a.u.door = condition;
    if (condition === 'instance') a.u.instance = 'meeting';
    if (condition === 'bot') a.u.bot = true;
    if (condition === 'removed') w.map.objects = w.map.objects.filter(p => p !== o);
    if (condition === 'kind') o.use = { kind: 'calendar', label: 'calendar' };
    tick(); assert.equal(w['seats'].has(o.id), false, condition); assert.equal(w['pendingSeat'].has(a.u.id), false);
    if (condition === 'removed') w.map.objects.push(o);
    o.use = original; a.u.presence = 'offline';
  }
  assert.equal(state()[objects[0].id], null);
});
test('another player winning during a walk gets the seat; arriving player gets a taken notice', t => {
  const { objects, add, state, play, tick } = instrumentSetup(t), a = add('A'), b = add('Bob Jones', { x: 56, y: 3 });
  play(a); play(b); tick(); assert.equal(state()[objects[0].id], b.u.id);
  assert.ok(a.messages.some(m => m.t === 'notice' && m.text === 'Bob is playing the keys'));
  assert.equal(a.messages.some(m => m.t === 'seat'), false);
});
test('layout moves cancel pending claims even if a player would still be beside the object', t => {
  const { w, objects, add, state, play, tick } = instrumentSetup(t), a = add('A'), admin = add('Ivan');
  admin.u.email = 'ivan.baranov@t1a.com'; play(a);
  const pending = w['pendingSeat'].get(a.u.id)!; assert.ok(pending);
  w.edit(admin.u, { op: 'move', id: objects[0].id, x: 56, y: 4 });
  assert.equal(w.map.objects.find(o => o.id === objects[0].id)!.x, 56);
  assert.equal(w['pendingSeat'].has(a.u.id), false); tick(); assert.equal(state()[objects[0].id], null);
});
test('layout removal cancels pending claims; unrelated edits preserve them; layout backstop ends invalid seats immediately', t => {
  const { w, objects, add, state, play, tick } = instrumentSetup(t), a = add('A'), admin = add('Ivan');
  admin.u.email = 'ivan.baranov@t1a.com'; play(a);
  w.edit(admin.u, { op: 'add', type: 'plant', x: 8, y: 17 }); assert.ok(w['pendingSeat'].has(a.u.id));
  const layout = structuredClone(w.layout()); layout.objects = layout.objects.filter(o => o.id !== objects[0].id);
  assert.ok(w['setLayout'](layout, admin.u)); assert.equal(w['pendingSeat'].has(a.u.id), false); tick(); assert.equal(w['seats'].size, 0);
  a.u.tile = { x: 58, y: 3 }; a.u.move = null; a.u.path = null; play(a, objects[1]); assert.equal(state()[objects[1].id], a.u.id);
  w.edit(admin.u, { op: 'move', id: objects[1].id, x: 58, y: 8 }); assert.equal(state()[objects[1].id], null);
  assert.ok(a.messages.some(m => m.t === 'seat' && m.id === null));
});
test('pending socket close cancels with another tab connected; closing another tab keeps a pending claim', t => {
  const { w, objects, add, state, play, tick } = instrumentSetup(t), a = add('A');
  const other = w.connect(a.u.id, () => {}); play(a); other.close(); tick(); assert.equal(state()[objects[0].id], a.u.id);
  w.walk(a.u, { x: 57, y: 7 }); tick(); const remaining = w.connect(a.u.id, () => {}); play(a); a.close();
  assert.equal(w['pendingSeat'].has(a.u.id), false); tick(); assert.equal(state()[objects[0].id], null); remaining.close();
});
test('away and back before the pending timer claims only once the redirected walk has completed', t => {
  const { w, objects, add, state, play, tick } = instrumentSetup(t), a = add('A', { x: 57, y: 15 });
  play(a); const arrival = a.u.move!.startedAt + pathDuration(a.u.path!);
  tick(100); w.walk(a.u, { x: 57, y: 10 }); tick(100); w.walk(a.u, { x: 56, y: 3 });
  assert.ok(a.u.move!.startedAt + pathDuration(a.u.path!) <= arrival);
  tick(arrival - Date.now() + 50); assert.equal(state()[objects[0].id], a.u.id); // + ARRIVAL_SLACK_MS
});
test('play chooses the nearest reachable behind spot, falls back to other sides, and reports a full instrument', t => {
  const { w, objects, add, state, play } = instrumentSetup(t), keys = objects[0];
  const a = add('A', { x: 56, y: 7 }); play(a); assert.equal(a.u.tile.x, 56); assert.equal(a.u.tile.y, 3);
  w.handle(a.u, { t: 'instrument', objectId: keys.id, action: 'leave' }, a.socket);
  a.u.tile = { x: 57, y: 7 }; a.u.move = null; a.u.path = null;
  add('behind1', { x: 55, y: 3 }); add('behind2', { x: 56, y: 3 });
  play(a); assert.notEqual(a.u.tile.y, 3); assert.equal(state()[keys.id], null);
  w.handle(a.u, { t: 'instrument', objectId: keys.id, action: 'leave' }, a.socket);
  a.u.tile = { x: 57, y: 7 }; a.u.move = null; a.u.path = null;
  for (const tile of [{ x: 55, y: 5 }, { x: 56, y: 5 }, { x: 54, y: 4 }, { x: 57, y: 4 }]) add('blocking', tile);
  play(a); assert.equal(w['pendingSeat'].has(a.u.id), false);
  assert.ok(a.messages.some(m => m.t === 'notice' && m.text === 'No room at the keys'));
});
test('instrument play stops following and cancels a use errand; plain use on an instrument has no effect', t => {
  const { w, objects, add, state, play, tick } = instrumentSetup(t), a = add('A');
  w.use(a.u, objects[0].id); assert.equal(a.u.move, null); assert.equal(w['errands'].size, 0); assert.equal(state()[objects[0].id], null);
  const lamp = w.map.objects.find(o => o.use?.kind === 'toggle')!;
  w.use(a.u, lamp.id); assert.ok(w['errands'].has(a.u.id));
  a.u.following = add('Leader').u.id; play(a); assert.equal(a.u.following, null); assert.equal(w['errands'].has(a.u.id), false);
  tick(); assert.equal(a.u.holding, null);
});
test('walks triggered by follow, use, AFK and admin displacement end a held seat immediately', t => {
  const { w, objects, add, state, play } = instrumentSetup(t);
  for (const action of ['follow', 'use', 'afk', 'admin'] as const) {
    const a = add(action, { x: 55, y: 3 }); play(a); assert.equal(state()[objects[0].id], a.u.id);
    if (action === 'follow') w.handle(a.u, { t: 'follow', targetId: add('Leader', { x: 57, y: 10 }).u.id }, a.socket);
    if (action === 'use') w.use(a.u, w.map.objects.find(o => o.type === 'coffee_machine')!.id);
    if (action === 'afk') w['leaveRoom'](a.u);
    if (action === 'admin') { const admin = add('Ivan'); admin.u.email = 'ivan.baranov@t1a.com'; w.edit(admin.u, { op: 'add', type: 'plant', x: 55, y: 3 }); }
    assert.equal(state()[objects[0].id], null, action);
  }
});
test('tick ends a seat after teleporting away, leaving or changing object kind', t => {
  const { w, objects, add, state, play, tick } = instrumentSetup(t);
  for (const condition of ['away', 'leaving', 'kind'] as const) {
    const a = add(condition, { x: 55, y: 3 }); play(a); assert.equal(state()[objects[0].id], a.u.id);
    if (condition === 'away') a.u.tile = { x: 57, y: 10 };
    if (condition === 'leaving') a.u.door = 'leaving';
    const o = w.map.objects.find(o => o.id === objects[0].id)!, use = o.use;
    if (condition === 'kind') o.use = { kind: 'calendar', label: 'calendar' };
    tick(250); assert.equal(w['seats'].size, 0); o.use = use;
  }
});
test('state lists every instrument and seats never persist across restart', t => {
  const { w, objects, add, play } = instrumentSetup(t), a = add('A', { x: 55, y: 3 });
  const before = w.snapshot() as Extract<ServerMsg, { t: 'state' }>;
  assert.deepEqual(before.instruments, Object.fromEntries(objects.map(o => [o.id, null])));
  play(a); const fresh = new World(structuredClone(map)); fresh.load(w.dump());
  assert.deepEqual((fresh.snapshot() as Extract<ServerMsg, { t: 'state' }>).instruments, before.instruments);
});
test('saved layout migration adds missing kinds at generated ids and positions and preserves existing instruments', t => {
  const { w, objects } = instrumentSetup(t);
  const existing = { ...objects[0], id: 'my-keys', x: 57, y: 8 };
  const saved = { ...w.dump(), layout: { ...structuredClone(w.layout()), objects: [...w.map.objects.filter(o => o.use?.kind !== 'instrument'), existing] } };
  const fresh = new World(structuredClone(map)); fresh.load(saved);
  const instruments = fresh.map.objects.filter(o => o.use?.kind === 'instrument');
  assert.deepEqual(instruments, [existing, objects[1], objects[2]]);
  assert.equal(fresh.dump().layout?.objects.find(o => o.id === 'my-keys')?.y, 8);
});
test('saved layout migration resolves id clashes and uses the first valid room position when generated tiles are blocked', t => {
  const { w, objects } = instrumentSetup(t);
  const layout = structuredClone(w.layout()); layout.objects = layout.objects.filter(o => o.use?.kind !== 'instrument');
  layout.objects.push({ id: objects[0].id, type: 'plant', x: 55, y: 4, w: 1, h: 1 });
  layout.objects.push({ id: 'e1', type: 'plant', x: 62, y: 20, w: 1, h: 1 });
  const fresh = new World(structuredClone(map)); fresh.load({ ...w.dump(), layout });
  const keys = fresh.map.objects.find(o => o.use?.kind === 'instrument' && o.use.instrument === 'keys')!;
  assert.equal(keys.id, objects[0].id); // uniqueIds: the generated object keeps its id, the plant moves on
  assert.deepEqual({ x: keys.x, y: keys.y }, { x: 55, y: 3 });
  assert.ok(fresh.map.objects.some(o => o.id === `${objects[0].id}-2` && o.type === 'plant'));
  assert.equal(new Set(fresh.map.objects.map(o => o.id)).size, fresh.map.objects.length);
});
test('migration leaves an instrument out with a warning when its room has no valid position', t => {
  const { w } = instrumentSetup(t), layout = structuredClone(w.layout()), r = w.map.rooms.find(r => r.id === 'music')!.rect;
  layout.objects = layout.objects.filter(o => o.use?.kind !== 'instrument');
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    if (!layout.objects.some(o => !o.wall && x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h))
      layout.objects.push({ id: `occupied-${x}-${y}`, type: 'plant', x, y, w: 1, h: 1, walkable: true });
  }
  const warn = t.mock.method(console, 'warn', () => {}), fresh = new World(structuredClone(map));
  fresh.load({ ...w.dump(), layout });
  assert.equal(fresh.map.objects.some(o => o.use?.kind === 'instrument'), false);
  assert.deepEqual(warn.mock.calls.map(c => c.arguments[0]), ['keyboard', 'drum kit', 'bass amp'].map(n => `new ${n} not placed in the saved layout: the ${n} overlaps the plant`));
  assert.ok(fresh.dump().layout); // the otherwise-valid saved layout survives
});
test('note bucket permits the burst then only the sustained rate, including after changing instruments', t => {
  const { objects, add, play, leave, note, tick } = instrumentSetup(t), a = add('A', { x: 58, y: 3 }), b = add('B'); play(a, objects[1]);
  for (let i = 0; i < 100; i++) note(a, { objectId: objects[1].id, note: 36 });
  assert.equal(notes(b.messages).length, 64);
  leave(a, objects[1]); a.u.tile = { x: 55, y: 3 }; play(a); note(a); assert.equal(notes(b.messages).length, 64);
  tick(1000);
  for (let i = 0; i < 41; i++) { note(a); note(a, { on: false }); }
  assert.equal(notes(b.messages).length, 144); // 40 ons + 40 offs
});

// ---------- effects ----------
const GM_EMAIL = 'ivan.baranov@t1a.com';
function people(t: TestContext) {
  const s = setup(t);
  const person = (name: string, email?: string, tile: Tile = { x: 32, y: 12 }) => {
    const u = s.w.addUser(name, false, tile, email); u.presence = 'online';
    const messages: ServerMsg[] = [];
    return { u, messages, ...s.w.connect(u.id, m => messages.push(m)) };
  };
  return { ...s, person };
}
const effect = (targetId: string, kind: string, on = true, style?: string): ClientMsg => ({ t: 'effect', targetId, kind, on, style });
const kinds = (u: User) => u.effects.map(e => e.kind).sort();

test('effects: GM debuffs anyone, they broadcast and wear off on time', t => {
  const { w, person, tick } = people(t), gm = person('Gm', GM_EMAIL), b = person('B', undefined, { x: 32, y: 8 });
  w.handle(gm.u, effect(b.u.id, 'drunk'), gm.socket);
  w.handle(gm.u, effect(b.u.id, 'unicorns'), gm.socket);
  assert.deepEqual(kinds(b.u), ['drunk', 'unicorns']);
  const sent = b.messages.filter(m => m.t === 'effects' && m.userId === b.u.id);
  assert.equal(sent.length, 2);
  assert.equal((w.snapshot() as Extract<ServerMsg, { t: 'state' }>).users.find(u => u.id === b.u.id)?.effects.length, 2);
  tick(EFFECTS.drunk.ms! - 1); assert.deepEqual(kinds(b.u), ['drunk', 'unicorns']);
  tick(250); assert.deepEqual(kinds(b.u), ['unicorns']);
  assert.deepEqual(b.messages.at(-1), { t: 'effects', userId: b.u.id, effects: b.u.effects });
  tick(EFFECTS.unicorns.ms!); assert.deepEqual(kinds(b.u), []);
  w.handle(gm.u, effect(b.u.id, 'vampire'), gm.socket); w.handle(gm.u, effect(b.u.id, 'vampire', false), gm.socket);
  assert.deepEqual(kinds(b.u), []);
});

test('effects: people only put hats on themselves; GM-only and server-only effects are refused', t => {
  const { w, person } = people(t), a = person('A'), b = person('B', undefined, { x: 32, y: 8 });
  for (const kind of ['vampire', 'fire_aura', 'gum', 'drunk', 'unicorns', 'speed', 'nope', '__proto__', 'constructor'])
    w.handle(a.u, effect(a.u.id, kind), a.socket);
  assert.deepEqual(kinds(a.u), []);
  w.handle(a.u, effect(b.u.id, 'hat', true, 'party'), a.socket); assert.deepEqual(kinds(b.u), []);
  w.handle(a.u, effect(a.u.id, 'hat', true, 'judge'), a.socket);
  w.handle(a.u, effect(a.u.id, 'hat', true, '<script>'), a.socket);
  w.handle(a.u, { t: 'effect', targetId: a.u.id, kind: 'hat', on: true } as ClientMsg, a.socket);
  assert.deepEqual(kinds(a.u), []);
  a.u.items = ['hat:wizard', 'hat:cowboy', 'hat:top']; // from the Lobby hat stand
  w.handle(a.u, effect(a.u.id, 'hat', true, 'wizard'), a.socket);
  assert.deepEqual(a.u.effects, [{ kind: 'hat', data: { style: 'wizard' } }]); // no end: worn until taken off
  w.handle(a.u, effect(a.u.id, 'hat', true, 'cowboy'), a.socket);
  assert.deepEqual(a.u.effects, [{ kind: 'hat', data: { style: 'cowboy' } }]); // replaced, not stacked
  w.handle(a.u, effect(a.u.id, 'hat', false), a.socket); assert.deepEqual(kinds(a.u), []);
  // the hat is saved; timed effects aren't
  w.handle(a.u, effect(a.u.id, 'hat', true, 'top'), a.socket); w.addEffect(a.u, 'speed');
  const saved = w.dump().users.find(u => u.id === a.u.id)!;
  assert.deepEqual(saved.effects, [{ kind: 'hat', data: { style: 'top' } }]);
  const w2 = new World(structuredClone(map)); w2.load(JSON.parse(JSON.stringify(w.dump())));
  assert.deepEqual(w2.users.get(a.u.id)!.effects, [{ kind: 'hat', data: { style: 'top' } }]);
  assert.deepEqual(w2.users.get(a.u.id)!.items, ['hat:wizard', 'hat:cowboy', 'hat:top'], 'pockets survive a restart');
});

test('effects: admins find their cap in their pockets, put on once, and everyone wears only what they own', t => {
  const { w, person } = people(t), judge = person('Oleg', 'oleg.mikhov@t1a.com', { x: 34, y: 8 }), gm = person('Gm', GM_EMAIL, { x: 32, y: 8 }), a = person('A', undefined, { x: 33, y: 8 });
  assert.deepEqual(judge.u.items, [], 'nobody finds a special hat on their own');
  const gift = (from: typeof gm, to: User, style: string): ClientMsg => ({ t: 'gift_hat', targetId: to.id, style });
  w.handle(a.u, gift(a, judge.u, 'laurel'), a.socket);
  assert.deepEqual(judge.u.items, [], 'only admins gift');
  w.handle(gm.u, gift(gm, judge.u, 'nonsense'), gm.socket);
  assert.deepEqual(judge.u.items, [], 'only real hats');
  w.handle(gm.u, gift(gm, judge.u, 'laurel'), gm.socket);
  assert.deepEqual(judge.u.items, [hatItem('laurel')], 'gifted: in the pockets');
  assert.deepEqual(judge.u.effects, [{ kind: 'hat', data: { style: 'laurel' } }], 'and on the head');
  assert.ok(judge.messages.some(m => m.t === 'me' && m.items?.includes(hatItem('laurel'))));
  assert.ok(judge.messages.some(m => m.t === 'notice' && m.text.includes('laurel')), 'the receiver is told');
  w.handle(gm.u, gift(gm, judge.u, 'winged'), gm.socket);
  assert.deepEqual(judge.u.items, [hatItem('laurel'), hatItem('winged')], 'a second gift adds to the pockets');
  assert.deepEqual(judge.u.effects, [{ kind: 'hat', data: { style: 'winged' } }], 'and replaces what is worn');
  w.handle(gm.u, gift(gm, judge.u, 'winged'), gm.socket);
  assert.deepEqual(judge.u.items, [hatItem('laurel'), hatItem('winged')], 'no duplicates');
  // the GM looks into pockets; nobody else does
  const looks = (who: typeof gm) => who.messages.filter(m => m.t === 'gm_items').length;
  w.handle(a.u, { t: 'gm_items', targetId: judge.u.id }, a.socket);
  assert.equal(looks(a), 0, 'only admins look');
  w.handle(gm.u, { t: 'gm_items', targetId: 'nobody' }, gm.socket);
  const before = looks(gm);
  w.handle(gm.u, { t: 'gm_items', targetId: judge.u.id }, gm.socket);
  assert.equal(looks(gm), before + 1);
  assert.deepEqual(gm.messages.filter(m => m.t === 'gm_items').at(-1), { t: 'gm_items', targetId: judge.u.id, items: [hatItem('laurel'), hatItem('winged')] });
  assert.ok(!JSON.stringify((w as any).toPublic(judge.u)).includes('hat:laurel'), 'pockets stay out of the public user');
  assert.deepEqual(gm.u.items, [hatItem(ADMIN_HAT)]);
  assert.deepEqual(gm.u.effects, [{ kind: 'hat', data: { style: ADMIN_HAT } }]);
  w.handle(judge.u, effect(judge.u.id, 'hat', false), judge.socket);
  assert.equal(judge.u.effects.length, 0, 'a judge may take the hat off');
  w.handle(judge.u, effect(judge.u.id, 'hat', true, 'party'), judge.socket);
  assert.equal(judge.u.effects.length, 0, 'not in the pockets');
  w.handle(judge.u, effect(judge.u.id, 'hat', true, 'laurel'), judge.socket);
  assert.deepEqual(judge.u.effects, [{ kind: 'hat', data: { style: 'laurel' } }]);
  w.handle(a.u, effect(a.u.id, 'hat', true, 'laurel'), a.socket);
  w.handle(a.u, effect(a.u.id, 'hat', true, 'top'), a.socket);
  assert.equal(a.u.effects.length, 0, 'no hats in the pockets, nothing to wear');
  const stand = w.map.objects.find(o => o.type === 'hat_rack')!;
  a.u.tile = { x: stand.x, y: stand.y + 1 };
  w.use(a.u, stand.id, 'hat:top'); t.mock.timers.tick(2000);
  assert.deepEqual(a.u.items, ['hat:top']);
  w.use(a.u, stand.id, 'hat:top'); t.mock.timers.tick(2000);
  assert.deepEqual(a.u.items, ['hat:top'], 'one of each');
  w.handle(a.u, effect(a.u.id, 'hat', true, 'top'), a.socket);
  assert.deepEqual(a.u.effects, [{ kind: 'hat', data: { style: 'top' } }]);
  w.handle(gm.u, effect(a.u.id, 'hat', true, 'crown'), gm.socket);
  assert.deepEqual(a.u.effects, [{ kind: 'hat', data: { style: 'crown' } }], 'a GM may put any hat on anyone');
});

test('effects: coffee makes you walk faster, timed the same on server and in the move message', t => {
  const { w, person, tick } = people(t), a = person('A', undefined, { x: 32, y: 12 });
  const machine = w.map.objects.find(o => o.type === 'coffee_machine')!;
  w.use(a.u, machine.id); tick(20_000);
  assert.equal(a.u.holding, 'coffee');
  const speed = a.u.effects.find(e => e.kind === 'speed')!;
  assert.ok(speed.until && speed.until > Date.now() && speed.until <= Date.now() + EFFECTS.speed.ms!);
  const ms = walkMs(a.u.effects);
  assert.equal(ms, Math.round(WALK_MS_PER_TILE / SPEED_FACTOR));
  a.messages.length = 0;
  const start = Date.now(), end = w.walk(a.u, { x: 32, y: 12 })!;
  const move = a.messages.find(m => m.t === 'move') as Extract<ServerMsg, { t: 'move' }>;
  assert.equal(move.ms, ms); assert.equal(a.u.move!.ms, ms);
  assert.equal(end - move.startedAt, pathDuration(a.u.path!, ms));
  assert.ok(end - start < pathDuration(a.u.path!)); // quicker than a plain walk
  const mid = move.startedAt + 2.5 * ms; // the server's idea of where they are follows the quicker pace
  assert.deepEqual(w.position(a.u, mid).tile, sampleMove(a.u.path!, move.startedAt, mid, ms)!.tile);
  tick(EFFECTS.speed.ms!); assert.equal(a.u.effects.some(e => e.kind === 'speed'), false);
  a.messages.length = 0; w.walk(a.u, { x: 32, y: 8 });
  assert.equal((a.messages.find(m => m.t === 'move') as Extract<ServerMsg, { t: 'move' }>).ms, undefined);
});

test('a shared time zone reaches everyone, is validated, can be hidden, and is never saved', t => {
  const { w, add } = setup(t), a = add('A'), b = add('B');
  w.handle(a.u, { t: 'tz', tz: 'Europe/Warsaw' }, a.socket);
  assert.deepEqual(b.messages.filter(m => m.t === 'tz'), [{ t: 'tz', userId: a.u.id, tz: 'Europe/Warsaw' }]);
  assert.equal((w.snapshot() as Extract<ServerMsg, { t: 'state' }>).users.find(u => u.id === a.u.id)!.tz, 'Europe/Warsaw');
  w.handle(a.u, { t: 'tz', tz: '<b>hi</b>' }, a.socket); assert.equal(a.u.tz, 'Europe/Warsaw'); // junk is ignored
  assert.equal(JSON.stringify(w.dump()).includes('Warsaw'), false);
  w.handle(a.u, { t: 'tz', tz: null }, a.socket);
  assert.equal(a.u.tz, undefined);
  assert.deepEqual(b.messages.filter(m => m.t === 'tz').pop(), { t: 'tz', userId: a.u.id, tz: null });
});
test('a clock ping is answered at once with the server time, only to the socket that sent it', t => {
  const { w, add } = setup(t), a = add('Ana');
  const other: ServerMsg[] = [], second = w.connect(a.u.id, m => other.push(m));
  a.messages.length = 0; other.length = 0;
  w.handle(a.u, { t: 'ping', id: 7 }, a.socket);
  assert.deepEqual(a.messages, [{ t: 'pong', id: 7, serverTime: Date.now() }]); assert.deepEqual(other, []);
  w.handle(a.u, { t: 'ping', id: NaN }, second.socket); assert.deepEqual(other, []);
});

test('the reception bell rings for everyone, once a second, from beside it, and only for real bells', t => {
  const { w, person } = people(t), bell = w.map.objects.find(o => o.use?.kind === 'bell')!;
  const a = person('A', undefined, { x: bell.x, y: bell.y + 1 }), b = person('B', undefined, { x: bell.x + 1, y: bell.y + 1 }), far = person('Far', undefined, { x: 40, y: 8 });
  const rings = (p: typeof a) => p.messages.filter(m => m.t === 'bell');
  w.handle(a.u, { t: 'ring', objectId: bell.id }, a.socket);
  assert.deepEqual(rings(b), [{ t: 'bell', userId: a.u.id, objectId: bell.id }]);
  w.handle(a.u, { t: 'ring', objectId: bell.id }, a.socket);
  assert.equal(rings(b).length, 1, 'one ring a second');
  t.mock.timers.tick(1100);
  w.handle(a.u, { t: 'ring', objectId: bell.id }, a.socket);
  assert.equal(rings(b).length, 2);
  w.handle(a.u, { t: 'ring', objectId: 'nope' }, a.socket);
  w.handle(b.u, { t: 'ring', objectId: w.map.objects.find(o => o.type === 'reception')!.id }, b.socket);
  assert.equal(rings(a).length, 2, 'only bells ring');
  w.handle(far.u, { t: 'ring', objectId: bell.id }, far.socket);
  assert.equal(rings(a).length, 2, 'too far away: it walks over first, no ring yet');
});

test('presenting needs standing at the board, walking over opens the panel, and walking away ends it', t => {
  const { w, person } = people(t), board = w.map.objects.find(o => o.use?.kind === 'presentation')!;
  w.present = new Presenter(new DeckStore('/nonexistent-decks'), w.map, { scopeOf: id => w.presentScopeOf(id), beside: (id, obj, settled) => w.isBeside(id, obj, settled), toScope: (s, m, x) => w.toScope(s, m, x), name: id => w.users.get(id)?.name ?? '?' });
  const a = person('A', undefined, { x: 40, y: 12 });
  assert.throws(() => w.present!.present(a.u.id, { deck: 'x', objectId: board.id }), /Walk up/, 'too far away');
  w.handle(a.u, { t: 'use', objectId: board.id }, a.socket);
  assert.equal(a.messages.filter(m => m.t === 'present_open').length, 0, 'not there yet');
  t.mock.timers.tick(60_000);
  assert.deepEqual(a.messages.filter(m => m.t === 'present_open'), [{ t: 'present_open', objectId: board.id }], 'panel opens on arrival');
  assert.ok(w.isBeside(a.u.id, board.id));
  const deck = { id: '0000bbbb-0000-0000-0000-000000000000', title: 'T', count: 1, ext: ['png'], by: a.u.id, at: 0, bytes: 1, key: 'k' };
  w.present.store.decks.set(deck.id, deck);
  w.present.present(a.u.id, { deck: deck.id, objectId: board.id });
  assert.ok(w.present.live);
  w.present.tick(); assert.ok(w.present.live, 'still at the board');
  const away = w.walk(a.u, { x: 20, y: 9 }); assert.notEqual(away, null, 'walk started');
  w.present.tick(); assert.equal(w.present.live, null, 'walking away ends it');
});

function presenting(t: TestContext) {
  const ctx = people(t), { w } = ctx, board = w.map.objects.find(o => o.use?.kind === 'presentation')!;
  w.present = new Presenter(new DeckStore('/nonexistent-decks'), w.map, { scopeOf: id => w.presentScopeOf(id), beside: (id, obj, settled) => w.isBeside(id, obj, settled), toScope: (s, m, x) => w.toScope(s, m, x), name: id => w.users.get(id)?.name ?? '?' });
  const beside = (u: User) => { const r = w.map.rooms.find(r => r.id === 'meeting')!.rect; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { u.tile = { x, y }; if (isWalkable(w.map, x, y) && w.isBeside(u.id, board.id)) return; } throw new Error('no spot beside the board'); };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
  const key = 'evt-p'; w.meetings.poll = async () => {};
  w.meetings.events.set(key, { key, title: 'Sync', start: Date.now() - 60_000, end: Date.now() + 30 * 60_000, emails: ['a@t1a.com', 'b@t1a.com'], instance: 'inst-p', owners: new Set() });
  return { ...ctx, board, beside, jpeg, key };
}
const frames = (p: { messages: ServerMsg[] }) => p.messages.filter(m => m.t === 'frame');
const lives = (p: { messages: ServerMsg[] }) => p.messages.filter((m): m is Extract<ServerMsg, { t: 'presentation' }> => m.t === 'presentation');

test('screen share relays frames to the scope, minus the presenter, with rate, size and type limits', t => {
  const { w, person, tick, board, beside, jpeg } = presenting(t);
  const a = person('A'), b = person('B'), c = person('C');
  beside(a.u); a.u.tile = { ...a.u.tile };
  w.handle(a.u, { t: 'present_share', objectId: board.id }, a.socket);
  assert.equal(w.present!.live?.deck, null); assert.equal(w.present!.live?.seq, 0);
  assert.ok(lives(b).at(-1)?.live?.presenter === a.u.id);
  beside(c.u); w.handle(c.u, { t: 'present_share', objectId: board.id }, c.socket);
  assert.match((c.messages.filter(m => m.t === 'notice').at(-1) as any).text, /A is presenting/);
  assert.equal(w.present!.live?.presenter, a.u.id);
  const send = (seq: number, data = jpeg) => w.handle(a.u, { t: 'present_frame', seq, data }, a.socket);
  send(1); assert.equal(frames(b).length, 1); assert.equal(frames(a).length, 0);
  assert.deepEqual(frames(b)[0], { t: 'frame', scope: 'office', seq: 1, data: jpeg });
  send(2); assert.equal(frames(b).length, 1, 'too fast');
  tick(FRAME_MIN_INTERVAL_MS + 1);
  send(2, Buffer.from('not a jpeg').toString('base64')); assert.equal(frames(b).length, 1, 'not a JPEG');
  send(2, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(FRAME_MAX_BYTES)]).toString('base64')); assert.equal(frames(b).length, 1, 'too big');
  send(1); assert.equal(frames(b).length, 1, 'old seq');
  send(2); assert.equal(frames(b).length, 2); assert.equal(w.present!.live?.seq, 2);
  w.handle(b.u, { t: 'present_frame', seq: 9, data: jpeg }, b.socket); assert.equal(w.present!.live?.seq, 2, 'only the presenter');
  const d = person('D'); assert.deepEqual(frames(d).at(-1), frames(b).at(-1), 'late joiner gets the last frame');
});

test('office and instance scopes are independent; entering one sends what is on; leaving as presenter stops it', t => {
  const { w, person, board, beside, jpeg, key } = presenting(t);
  const a = person('A', 'a@t1a.com'), b = person('B', 'b@t1a.com'), c = person('C');
  w.enterMeeting(b.u, key); assert.equal(b.u.instance, 'inst-p');
  beside(a.u); w.handle(a.u, { t: 'present_share', objectId: board.id }, a.socket);
  w.handle(a.u, { t: 'present_frame', seq: 1, data: jpeg }, a.socket);
  assert.equal(lives(b).at(-1)?.live, null, 'the office show is not seen in the meeting'); assert.equal(frames(b).length, 0);
  beside(b.u); w.handle(b.u, { t: 'present_share', objectId: board.id }, b.socket); // its own scope: no clash
  assert.equal(w.present!.lives.get('inst-p')?.presenter, b.u.id); assert.equal(w.present!.live?.presenter, a.u.id);
  w.handle(b.u, { t: 'present_frame', seq: 1, data: jpeg }, b.socket);
  assert.equal(frames(a).length, 0); assert.equal(frames(c).length, 1, 'office frame only');
  assert.ok(b.u.instance && w.isBeside(b.u.id, board.id), 'beside works inside a meeting');
  a.u.instance = null; w.enterMeeting(a.u, key); // A joins the meeting: sees B's show and frame; their own office show stops
  assert.equal(w.present!.live, null); assert.equal(lives(a).at(-1)?.live?.presenter, b.u.id); assert.equal(frames(a).length, 1);
  assert.equal(lives(c).at(-1)?.live, null);
  w.leaveMeeting(b.u); assert.equal(w.present!.lives.has('inst-p'), false, 'presenter left: stopped');
  assert.equal(lives(a).at(-1)?.live, null);
  w.leaveMeeting(a.u); assert.equal(w.present!.lives.size, 0);
});

test('a meeting ending takes its screen down, and a swept deck stops its show', async t => {
  const { w, person, board, beside, key } = presenting(t);
  const a = person('A', 'a@t1a.com');
  w.enterMeeting(a.u, key); beside(a.u); w.handle(a.u, { t: 'present_share', objectId: board.id }, a.socket);
  assert.ok(w.present!.lives.has('inst-p'));
  w.endMeetings(Date.now() + 3600_000);
  assert.equal(w.present!.lives.size, 0); assert.equal(a.u.instance, null);
  const deck = { id: '0000cccc-0000-0000-0000-000000000000', title: 'T', count: 1, ext: ['png'], by: a.u.id, at: 0, bytes: 1, key: 'k' };
  w.present!.store.decks.set(deck.id, deck); beside(a.u);
  w.present!.present(a.u.id, { deck: deck.id, objectId: board.id }); assert.ok(w.present!.live);
  await w.present!.sweep(Date.now() + 1e12); assert.equal(w.present!.live, null);
});

test('dancing works only on the Berghain floor and ends when you leave', t => {
  const { w, add, settle } = setup(t), a = add('A');
  const club = map.rooms.find(r => r.id === 'berghain')!, [s0, s1] = club.spots;
  const dancing = () => a.u.effects.some(e => e.kind === 'dance');
  w.handle(a.u, effect(a.u.id, 'dance'), a.socket);
  assert.equal(dancing(), false, 'not in the club');
  settle(a.u, s0); a.u.instance = 'meeting:x';
  w.handle(a.u, effect(a.u.id, 'dance'), a.socket);
  assert.equal(dancing(), false, 'instances do not count');
  a.u.instance = null;
  w.handle(a.u, effect(a.u.id, 'dance'), a.socket);
  assert.equal(dancing(), true);
  w.handle(a.u, effect(a.u.id, 'dance', false), a.socket);
  assert.equal(dancing(), false);
  w.handle(a.u, effect(a.u.id, 'dance'), a.socket);
  w.walk(a.u, s1);
  assert.equal(dancing(), true, 'moving inside the club keeps it');
  settle(a.u, s1);
  w.walk(a.u, { x: 32, y: 12 });
  assert.equal(dancing(), false, 'walking out ends it');
});

test('30 minutes of dancing earns the raver badge', t => {
  const { w, add, settle, tick } = setup(t), a = add('A');
  settle(a.u, map.rooms.find(r => r.id === 'berghain')!.spots[0]);
  for (let i = 0; i < 10; i++) {
    w.handle(a.u, effect(a.u.id, 'dance'), a.socket);
    assert.equal(a.u.achievements.raver, undefined);
    for (let k = 0; k < 720; k++) tick(250);
  }
  tick(250);
  assert.ok(a.u.achievements.raver);
});
test('the DJ booth plays only techno and the Music room jukebox never does', t => {
  const { w } = setup(t), booth = map.objects.find(o => o.type === 'dj_booth')!;
  const state = (w.snapshot() as Extract<ServerMsg, { t: 'state' }>).jukebox!;
  assert.equal(TRACK.get(state[booth.id].track)?.genre, 'Techno');
  assert.notEqual(TRACK.get(state[jukebox.id].track)?.genre, 'Techno');
});

test('ringing the bell the first time earns the bellringer achievement, once', t => {
  const { w, person } = people(t), bell = w.map.objects.find(o => o.use?.kind === 'bell')!;
  const a = person('A', undefined, { x: bell.x, y: bell.y + 1 });
  w.handle(a.u, { t: 'ring', objectId: bell.id }, a.socket);
  const earned = a.u.achievements.bellringer;
  assert.ok(earned);
  assert.ok(a.messages.some(m => m.t === 'plant' && m.userId === a.u.id && m.achievements.bellringer === earned), 'everyone hears about it');
  t.mock.timers.tick(1100);
  w.handle(a.u, { t: 'ring', objectId: bell.id }, a.socket);
  assert.equal(a.u.achievements.bellringer, earned, 'earned once, when first rung');
});

test('clicking a cup walks you over and clears it; the cleaner praises you (and you earn tidy) only from the same room', t => {
  const { w, person, tick } = people(t);
  const counter = { x: 30, y: 3 }, lobby = w.map.rooms.find(r => r.id === 'lobby')!;
  const a = person('A', undefined, { x: 32, y: 8 });
  const cupOn = (tile: Tile, item = 'coffee') => { const c = w.creatures.addCup(tile, item, Date.now()); assert.ok(typeof c === 'object'); return c; };
  const lady = w.creatures.add('cleaner', 'Valentina', lobby.stand[0]);

  const first = cupOn(counter);
  w.handle(a.u, { t: 'cup_take', cupId: first.id }, a.socket);
  assert.equal(w.creatures.cups.length, 1, 'still there until you get to it');
  tick(10_000);
  assert.equal(w.creatures.cups.length, 0, 'cleared away');
  assert.equal(a.u.holding, null, 'not picked up: tidied away');
  assert.ok(Math.max(Math.abs(a.u.tile.x - counter.x), Math.abs(a.u.tile.y - counter.y)) <= 1, 'walked over to it');
  assert.equal(lady.say, undefined, 'the cleaner was in the Lobby: nobody saw');
  assert.equal(a.u.achievements.tidy, undefined);

  w.creatures.list.get('cleaner')!.tile = w.map.rooms.find(r => r.id === 'coffee')!.stand[0];
  const second = cupOn({ x: 28, y: 3 });
  w.handle(a.u, { t: 'cup_take', cupId: second.id }, a.socket);
  tick(10_000);
  assert.equal(w.creatures.cups.length, 0);
  assert.ok(lady.say, 'she says something nice');
  assert.ok(a.u.achievements.tidy);
  assert.ok(a.messages.some(m => m.t === 'creature' && m.creature.kind === 'cleaner' && m.creature.say === lady.say), 'everyone sees her bubble');

  const plate = cupOn({ x: 29, y: 3 }, 'plate:pizza');
  w.handle(a.u, { t: 'cup_take', cupId: plate.id }, a.socket);
  w.handle(a.u, { t: 'cup_take', cupId: 'nope' }, a.socket);
  tick(10_000);
  assert.deepEqual(w.creatures.cups.map(c => c.id), [plate.id], 'plates stay: someone may still be eating');
});

test('a cup the cleaner takes first is simply gone when you arrive', t => {
  const { w, person, tick } = people(t), a = person('A', undefined, { x: 32, y: 8 });
  const cup = w.creatures.addCup({ x: 30, y: 3 }, 'tea', Date.now());
  assert.ok(typeof cup === 'object');
  w.handle(a.u, { t: 'cup_take', cupId: cup.id }, a.socket);
  w.creatures.removeCup(cup.id);
  tick(10_000);
  assert.equal(a.u.achievements.tidy, undefined);
  assert.equal(w.creatures.cups.length, 0);
});

test('walking onto the Berghain dance floor starts dancing on arrival; changing course or being a bot does not', t => {
  const { w, add, settle, tick } = setup(t), floor = map.objects.find(o => o.use?.kind === 'dance')!;
  const club = map.rooms.find(r => r.id === 'berghain')!, door = club.stand.find(s => !(s.x >= floor.x && s.x < floor.x + floor.w && s.y >= floor.y && s.y < floor.y + floor.h))!;
  const a = add('A'), bot = add('Bot', undefined, true);
  const dancing = (u: User) => u.effects.some(e => e.kind === 'dance');
  settle(a.u, door);
  w.handle(a.u, { t: 'move', to: { x: floor.x + 1, y: floor.y + 1 } }, a.socket);
  assert.equal(dancing(a.u), false, 'not until you get there');
  tick(10_000);
  assert.equal(dancing(a.u), true, 'on the floor: dancing');

  const b = add('B'); settle(b.u, door);
  w.handle(b.u, { t: 'move', to: { x: floor.x + 2, y: floor.y } }, b.socket);
  w.handle(b.u, { t: 'move', to: door }, b.socket); // changed their mind on the way
  tick(10_000);
  assert.equal(dancing(b.u), false);

  settle(bot.u, door);
  w.walk(bot.u, { x: floor.x + 3, y: floor.y + 2 });
  tick(10_000);
  assert.equal(dancing(bot.u), false, 'bots stay off the floor');
});

test('a broadcast is stringified once for wire listeners; a join sends one user, not the snapshot', t => {
  const { w, add } = setup(t), a = add('A'); a.messages.length = 0;
  const wired: string[] = [], other: string[] = [];
  w.connect(a.u.id, () => {}, j => wired.push(j)); w.connect(a.u.id, () => {}, j => other.push(j));
  a.messages.length = 0; wired.length = 0; other.length = 0;
  const b = w.addUser('B');
  assert.equal(wired.length, 1); assert.equal(wired[0], other[0]); // the same string to both
  assert.deepEqual(a.messages.map(m => m.t), ['user']);
  const msg = a.messages[0] as Extract<ServerMsg, { t: 'user' }>;
  assert.equal(msg.user.id, b.id); assert.ok(!('email' in msg.user));
});
