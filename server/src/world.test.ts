import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, type User } from './world';
import { earshotDistance, pathDuration, roomAt, WALK_MS_PER_TILE, type TileMap, type Tile } from '../../shared/map';
import { ROOM_VOICE_MAX, type ServerMsg } from '../../shared/protocol';
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
  const settle = (u: User, tile: Tile) => { u.tile = tile; u.move = null; u.path = null; };
  const join = (u: User) => { w.walk(u, { x: 32, y: 8 }); settle(u, { x: 32, y: 8 }); };
  return { w, add, settle, join, tick: (ms: number) => t.mock.timers.tick(ms) };
}
test('walk joins flagged rooms, restores presence on demotion and preserves explicit choices', t => {
  const { w, add, join, tick } = setup(t), a = add('A'), b = add('B'); join(a.u); join(b.u);
  assert.equal(a.u.callId, 'room:coffee'); assert.equal(a.u.callRole, 'member'); assert.equal(a.u.presence, 'in_call');
  w.handle(a.u, { t: 'hand', up: true }, a.socket); w.handle(a.u, { t: 'deafen', on: true }, a.socket);
  w.walk(a.u, { x: 32, y: 13 });
  assert.equal(a.u.callRole, 'listener'); assert.equal(a.u.hand, false); assert.equal(a.u.deafened, true); assert.equal(a.u.presence, 'online');
  assert.ok(a.messages.some(m => m.t === 'speaking' && !m.on));
  tick(pathDuration(a.u.path!) - 1); assert.equal(a.u.callRole, 'listener'); tick(1); assert.equal(a.u.callId, null);
  join(a.u); w.handle(a.u, { t: 'presence', presence: 'away' }, a.socket); assert.equal(a.u.callRole, 'member');
  w.walk(a.u, { x: 32, y: 13 }); assert.equal(a.u.presence, 'away');
});
test('bots never join a room call', t => {
  const { add, join } = setup(t); const b = add('Bot', undefined, true); join(b.u); assert.equal(b.u.callId, null);
});
test('listener expires on the rounded step off last near tile; redirect uses future startedAt', t => {
  const { w, add, join, tick } = setup(t), a = add('A'), b = add('B'); join(a.u); join(b.u);
  w.walk(a.u, { x: 36, y: 18 });
  const i = a.u.path!.reduce((last, p, i) => earshotDistance(map, coffee, p.x, p.y) <= 5 ? i : last, -1);
  const expiry = a.u.move!.startedAt + (i + .5) * WALK_MS_PER_TILE;
  tick(100); w.walk(a.u, { x: 32, y: 13 }); assert.ok(a.u.move!.startedAt > Date.now());
  const end = a.u.move!.startedAt + pathDuration(a.u.path!); tick(end - Date.now() - 1); assert.equal(a.u.callRole, 'listener'); tick(1); assert.equal(a.u.callId, null);
  assert.ok(expiry > 100000);
  join(a.u); w.walk(a.u, { x: 36, y: 18 });
  const last = a.u.path!.reduce((last, p, i) => earshotDistance(map, coffee, p.x, p.y) <= 5 ? i : last, -1);
  assert.ok(last < a.u.path!.length - 1);
  const off = a.u.move!.startedAt + (last + .5) * WALK_MS_PER_TILE;
  tick(off - Date.now() - 1); assert.equal(a.u.callRole, 'listener'); tick(1); assert.equal(a.u.callId, null);
});
test('crossing Coffee listens only while walking and requires existing members', t => {
  const { w, add, join, tick } = setup(t), a = add('A'), b = add('B', { x: 24, y: 8 }); join(a.u);
  w.walk(b.u, { x: 36, y: 13 }); assert.ok(b.u.path!.some(p => roomAt(map, p.x, p.y)?.id === 'coffee')); assert.equal(b.u.callRole, 'listener');
  tick(pathDuration(b.u.path!)); assert.equal(b.u.callId, null);
  w.leaveCall(a.u); w.walk(b.u, { x: 24, y: 8 }); assert.equal(b.u.callId, null);
});
test('last member ends room immediately, removing all listeners', t => {
  const { w, add, join } = setup(t), a = add('A'), b = add('B'); join(a.u); w.walk(b.u, { x: 32, y: 13 });
  a.messages.length = 0;
  w.walk(a.u, { x: 32, y: 13 }); assert.equal(a.u.callId, null); assert.equal(b.u.callId, null);
  assert.equal(a.messages.some(m => m.t === 'call' && m.userId === a.u.id && m.role === 'listener'), false);
});
test('cap waits in order, replays private state, promotes before deletion, clears on walk and disconnect', t => {
  const { w, add, join } = setup(t); const members = Array.from({ length: ROOM_VOICE_MAX }, (_, i) => add(`M${i}`)); members.forEach(a => join(a.u));
  const a = add('wait1'), b = add('wait2'); join(a.u); join(b.u);
  assert.equal(a.u.callId, null); assert.ok(a.messages.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'));
  const replay: ServerMsg[] = []; w.connect(a.u.id, m => replay.push(m)); assert.ok(replay.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'));
  w.leaveCall(members[0].u); assert.equal(a.u.callRole, 'member'); assert.equal(b.u.callId, null);
  w.walk(b.u, { x: 36, y: 13 }); w.leaveCall(members[1].u); assert.equal(b.u.callRole, 'listener');
  assert.ok(b.messages.some(m => m.t === 'voice_wait' && m.roomId === null));
  for (const m of members.slice(2)) w.leaveCall(m.u); w.leaveCall(a.u); assert.equal(a.u.callId, null);
});
test('knock call is left on entering but retained when passing a voice room', t => {
  const { w, add, join } = setup(t), a = add('A'), b = add('B'), c = add('C');
  const call = w.connectCall(a.u, b.u); w.walk(a.u, { x: 36, y: 13 }); assert.equal(a.u.callId, call.id);
  join(c.u); join(a.u); assert.equal(a.u.callId, 'room:coffee'); assert.equal(b.u.callId, null);
});
test('leave_room and end_call walk home or to Lobby; unreachable exit leaves directly', t => {
  const { w, add, join, tick } = setup(t), a = add('A'), b = add('B'); join(a.u); join(b.u);
  a.u.homeDesk = { x: 17, y: 15 }; w.handle(a.u, { t: 'leave_room' }, a.socket); assert.deepEqual(a.u.move!.to, a.u.homeDesk); tick(20000); assert.equal(a.u.callId, null);
  join(a.u); a.u.homeDesk = null; w.handle(a.u, { t: 'end_call' }, a.socket); assert.equal(roomAt(map, a.u.move!.to.x, a.u.move!.to.y)?.id, 'lobby'); tick(20000); assert.equal(a.u.callId, null);
});
test('knock blocks a target in a voice room and a room member, with specified notices', t => {
  const { w, add, join } = setup(t), a = add('A', { x: 7, y: 17 }), b = add('B', { x: 8, y: 17 });
  const blocked = (reason: string) => assert.ok(a.messages.some(m => m.t === 'knock_reply' && m.reply === 'blocked' && m.reason === reason));
  b.u.tile = { x: 32, y: 8 }; w.knock(a.u, b.u); blocked('B is in Coffee — just walk in');
  b.u.tile = { x: 8, y: 17 }; join(a.u); w.knock(a.u, b.u); blocked("You're in Coffee voice — step out to knock");
});
test('knock guards recheck at arrival and accept; membership closes walking and pending knocks', t => {
  const { w, add, join, tick } = setup(t), a = add('A', { x: 7, y: 17 }), b = add('B', { x: 8, y: 17 });
  const home = { x: 8, y: 17 }, coffee = { x: 32, y: 8 };
  w.knock(a.u, b.u); const k = [...w.knocks.values()].at(-1)!; b.u.tile = coffee; tick(5000); assert.equal(k.state, 'blocked');
  b.u.tile = home; w.knock(a.u, b.u); tick(5000); const p = [...w.knocks.values()].at(-1)!; assert.equal(p.state, 'pending');
  b.u.tile = coffee; w.reply(b.u, p.id, 'accept'); assert.equal(p.state, 'blocked');
  b.u.tile = home; w.knock(a.u, b.u); tick(5000); const q = [...w.knocks.values()].at(-1)!; join(b.u); assert.equal(q.state, 'later');
  const c = add('C'); const call = w.connectCall(b.u, c.u); assert.notEqual(call.id, 'room:coffee');
});
test('stale listener expiry cannot end a later knock call', t => {
  const { w, add, join, tick } = setup(t), a = add('A'), b = add('B'), c = add('C'); join(a.u); join(b.u);
  w.walk(b.u, { x: 32, y: 13 }); w.leaveCall(b.u); const call = w.connectCall(b.u, c.u); tick(20000); assert.equal(b.u.callId, call.id);
});
test('ownership switches, owner-only relay and controls, member/listener eligibility', t => {
  const { w, add, join } = setup(t), a = add('A'), b = add('B'), c = add('C'); join(a.u); join(b.u);
  w.walk(b.u, { x: 32, y: 13 }); w.walk(c.u, { x: 32, y: 13 });
  const newer: ServerMsg[] = [], tab = w.connect(b.u.id, m => newer.push(m));
  assert.ok(b.messages.some(m => m.t === 'voice_owner' && !m.owner));
  const signal = { kind: 'hello', inst: 'test' } as const;
  b.messages.length = 0; newer.length = 0; w.handle(a.u, { t: 'rtc', to: b.u.id, signal }, a.socket);
  assert.equal(b.messages.filter(m => m.t === 'rtc').length, 0); assert.equal(newer.filter(m => m.t === 'rtc').length, 1);
  c.messages.length = 0; w.handle(b.u, { t: 'rtc', to: c.u.id, signal }, tab.socket); assert.equal(c.messages.filter(m => m.t === 'rtc').length, 0);
  for (const msg of [{ t: 'mute', muted: true }, { t: 'deafen', on: true }, { t: 'hand', up: true }, { t: 'speaking', on: true }] as const) w.handle(b.u, msg, b.socket);
  assert.equal(b.u.muted, false); assert.equal(b.u.deafened, false); assert.equal(b.u.hand, false);
  w.handle(b.u, { t: 'voice_claim' }, b.socket); assert.equal(b.messages.at(-1)?.t, 'voice_owner');
  w.handle(b.u, { t: 'deafen', on: true }, b.socket); assert.equal(b.u.deafened, true);
  w.handle(b.u, { t: 'voice_claim' }, tab.socket); tab.close(); assert.ok(b.messages.at(-1)?.t === 'voice_owner');
  w.handle(b.u, { t: 'mute', muted: true }, b.socket); assert.equal(b.u.muted, true);
});
test('last departing member promotes a waiter before deciding whether to end the call', t => {
  const { w, add, join } = setup(t);
  const members = Array.from({ length: ROOM_VOICE_MAX }, (_, i) => add(`M${i}`)); members.forEach(a => join(a.u));
  const waiter = add('waiter'); join(waiter.u);
  waiter.u.door = 'thinking';
  for (const m of members.slice(1)) w.leaveCall(m.u);
  waiter.u.door = null;
  w.walk(members[0].u, { x: 32, y: 13 });
  assert.equal(waiter.u.callRole, 'member'); assert.equal(members[0].u.callRole, 'listener');
});
test('final disconnect clears waiting and skips disconnected waiters during promotion', t => {
  const { w, add, join } = setup(t);
  const members = Array.from({ length: ROOM_VOICE_MAX }, (_, i) => add(`M${i}`)); members.forEach(a => join(a.u));
  const a = add('wait1'), b = add('wait2'); join(a.u); join(b.u); a.close();
  w.leaveCall(members[0].u); assert.equal(a.u.callId, null); assert.equal(b.u.callRole, 'member');
  const replay: ServerMsg[] = []; w.connect(a.u.id, m => replay.push(m));
  assert.ok(replay.some(m => m.t === 'voice_wait' && m.roomId === null));
  assert.equal(replay.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'), false);
});
test('leave_room falls back from an occupied home desk and leaves directly if unreachable', t => {
  const { w, add, join } = setup(t), a = add('A'), b = add('B', { x: 17, y: 15 }); join(a.u);
  a.u.homeDesk = b.u.tile; w.handle(a.u, { t: 'leave_room' }, a.socket);
  assert.equal(roomAt(map, a.u.move!.to.x, a.u.move!.to.y)?.id, 'lobby');
  join(a.u); a.u.homeDesk = { x: 2, y: 5 };
  const isolated = structuredClone(map); isolated.layers.walkable[5][2] = 0; w.map = isolated;
  w.handle(a.u, { t: 'leave_room' }, a.socket); assert.equal(a.u.callId, null);
});
test('room calls have no two-hour expiry; waiting and voice bookkeeping stay private', t => {
  const { w, add, join, tick } = setup(t), a = add('A'); join(a.u); tick(2 * 60 * 60_000 + 1);
  assert.equal(a.u.callRole, 'member');
  const state = w.snapshot(); assert.equal(state.t, 'state');
  if (state.t === 'state') for (const u of state.users) {
    assert.equal('presenceBeforeCall' in u, false); assert.equal('presencePicked' in u, false);
  }
});
test('membership cancels both walking and pending knocks in either direction', t => {
  const { w, add, join, tick } = setup(t), a = add('A', { x: 7, y: 17 }), b = add('B', { x: 8, y: 17 });
  w.knock(a.u, b.u); const walking = [...w.knocks.values()].at(-1)!; join(a.u);
  assert.equal(walking.state, 'later');
  assert.ok(a.messages.some(m => m.t === 'knock_reply' && m.reason === 'Knock cancelled — A walked into Coffee'));
  w.leaveCall(a.u); a.u.tile = { x: 7, y: 17 }; a.u.move = null; a.u.path = null;
  w.knock(a.u, b.u); tick(100); const pending = [...w.knocks.values()].at(-1)!; assert.equal(pending.state, 'pending');
  join(b.u); assert.equal(pending.state, 'later');
});
test('all new knock guards are rechecked at arrival and accept', t => {
  const { w, add, tick } = setup(t), a = add('A', { x: 7, y: 17 }), b = add('B', { x: 8, y: 17 });
  const reset = () => {
    for (const u of [a.u, b.u]) { w.leaveCall(u); u.move = null; u.path = null; u.tile = u === a.u ? { x: 7, y: 17 } : { x: 8, y: 17 }; }
  };
  for (const stage of ['arrival', 'accept']) for (const guard of ['destination', 'member']) {
    reset(); w.knock(a.u, b.u); const k = [...w.knocks.values()].at(-1)!;
    if (stage === 'accept') { tick(100); assert.equal(k.state, 'pending'); }
    if (guard === 'destination') b.u.tile = { x: 32, y: 8 };
    // Establish a room member without using walk's eager cancellation, to test the defensive recheck.
    if (guard === 'member') { const c = add('C'); w.walk(c.u, { x: 32, y: 8 }); a.u.callId = c.u.callId; a.u.callRole = 'member'; }
    if (stage === 'arrival') tick(100); else w.reply(b.u, k.id, 'accept');
    assert.equal(k.state, 'blocked', `${stage}: ${guard}`);
  }
});
test('relay is bidirectional for members/listeners, rejects absent peers and non-owner signals', t => {
  const { w, add, join } = setup(t), a = add('A'), b = add('B'); join(a.u); join(b.u); w.walk(b.u, { x: 32, y: 13 });
  const signal = { kind: 'hello', inst: 'x' } as const;
  a.messages.length = 0; w.handle(b.u, { t: 'rtc', to: a.u.id, signal }, b.socket);
  assert.ok(a.messages.some(m => m.t === 'rtc'));
  const tab = w.connect(b.u.id, () => {}); a.messages.length = 0;
  w.handle(b.u, { t: 'rtc', to: a.u.id, signal }, b.socket); assert.equal(a.messages.length, 0);
  b.u.door = 'thinking'; w.handle(b.u, { t: 'rtc', to: a.u.id, signal }, tab.socket); assert.equal(a.messages.length, 0);
  b.u.door = null; b.u.presence = 'offline'; w.handle(b.u, { t: 'rtc', to: a.u.id, signal }, tab.socket); assert.equal(a.messages.length, 0);
});
test('non-owner member controls cannot change state or broadcast speaking', t => {
  const { w, add, join } = setup(t), a = add('A'); join(a.u);
  w.connect(a.u.id, () => {}); a.messages.length = 0;
  for (const msg of [{ t: 'mute', muted: true }, { t: 'deafen', on: true }, { t: 'hand', up: true }, { t: 'speaking', on: true }] as const) w.handle(a.u, msg, a.socket);
  assert.equal(a.u.muted, false); assert.equal(a.u.deafened, false); assert.equal(a.u.hand, false);
  assert.equal(a.messages.length, 0);
});
test('redirecting a listener back into the room cancels expiry and broadcasts promotion', t => {
  const { w, add, join, tick } = setup(t), a = add('A'), b = add('B'); join(a.u); join(b.u);
  w.walk(a.u, { x: 32, y: 13 }); tick(100); a.messages.length = 0;
  w.walk(a.u, { x: 32, y: 8 }); tick(20000);
  assert.equal(a.u.callRole, 'member');
  assert.ok(a.messages.some(m => m.t === 'call' && m.userId === a.u.id && m.role === 'member'));
  assert.equal(a.messages.some(m => m.t === 'call' && m.userId === a.u.id && m.callId === null), false);
});
test('the radio has one shared volume knob: only next to it, clamped, 5% steps, broadcast to everyone, persisted', t => {
  const { w, add } = setup(t), b = add('B');
  const radio = map.objects.find(o => o.sound)!, lamp = map.objects.find(o => o.use?.kind === 'toggle' && !o.sound)!;
  const a = add('A', { x: radio.x, y: radio.y + 1 }); // standing right below the radio
  const seen = (m: ServerMsg[]) => m.filter(x => x.t === 'object' && x.id === radio.id).at(-1) as Extract<ServerMsg, { t: 'object' }> | undefined;
  w.handle(a.u, { t: 'object_volume', id: radio.id, volume: .42 }, a.socket);
  assert.equal(seen(b.messages)?.volume, .4); assert.equal(seen(b.messages)?.on, true); // everyone hears the change
  w.handle(a.u, { t: 'object_volume', id: radio.id, volume: 7 }, a.socket); assert.equal(seen(b.messages)?.volume, 1);
  w.handle(a.u, { t: 'object_volume', id: lamp.id, volume: .5 }, a.socket);
  assert.ok(!b.messages.some(x => x.t === 'object' && x.id === lamp.id));
  const far = add('Far', { x: 3, y: 20 }); // across the Lobby: the knob doesn't turn from here
  w.handle(far.u, { t: 'object_volume', id: radio.id, volume: 0 }, far.socket); assert.equal(seen(b.messages)?.volume, 1);
  w.walk(a.u, { x: 3, y: 18 }); w.handle(a.u, { t: 'object_volume', id: radio.id, volume: 0 }, a.socket); assert.equal(seen(b.messages)?.volume, 1); // walking away
  const restored = new World(map); restored.load(w.dump());
  const state = restored.snapshot() as Extract<ServerMsg, { t: 'state' }>;
  assert.equal(state.objects[radio.id].volume, 1); assert.equal(state.objects[lamp.id].volume, undefined);
});
