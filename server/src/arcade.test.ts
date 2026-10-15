import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Arcade } from './arcade';
import { World } from './world';
import { Runner } from '../../shared/park/runner';
import { LEVELS } from '../../shared/park/levels';
import { SOLUTIONS } from '../../shared/park/solutions';
import { hashState, PLAYER_H, TILE } from '../../shared/park/sim';
import { besideObject, findPath, isWalkable, layoutProblem, migrateEastWing, pathDuration, roomAt, withLayout,
  type Layout, type Tile, type TileMap } from '../../shared/map';
import type { ClientMsg, ParkRecord, PublicUser, ServerMsg } from '../../shared/protocol';
import type { ParkIncoming } from '../../shared/park/types';
const base: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const cabinets = base.objects.filter(o => o.type === 'arcade');
type Gamer = Pick<PublicUser, 'id' | 'name' | 'bot' | 'game'>;
function setup() {
  let now = 100000;
  const users = new Map<string, Gamer>(), messages = new Map<string, ServerMsg[]>(), broadcasts: ServerMsg[] = [];
  const a = new Arcade({ now: () => now, timer: false, user: id => users.get(id),
    send: (id, msg) => messages.get(id)!.push(structuredClone(msg)), broadcast: msg => broadcasts.push(structuredClone(msg)) });
  const add = (id: string, cabinet = 'one') => {
    const u: Gamer = { id, name: id.toUpperCase(), bot: false, game: null }; users.set(id, u); messages.set(id, []); a.join(u, cabinet); return u;
  };
  return { a, users, messages, broadcasts, add, now: () => now, time: (ms: number) => { now = ms; }, tick: (ms: number) => { now = ms; a.tick(now); } };
}
function worldSetup(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const w = new World(structuredClone(base));
  const add = (name: string, tile: Tile = { x: 55, y: 16 }) => {
    const u = w.addUser(name, false, tile); u.presence = 'online';
    const messages: ServerMsg[] = [], connection = w.connect(u.id, msg => messages.push(structuredClone(msg)));
    return { u, messages, ...connection };
  };
  return { w, add, tick: (ms: number) => t.mock.timers.tick(ms) };
}
test('arcade sessions: four players, spectators, lobby promotion, slot reuse, membership event order and empty close', () => {
  const { a, add, messages } = setup(), players = ['a', 'b', 'c', 'd'].map(id => add(id)), spectator = add('e');
  const s = a.session(players[0])!;
  assert.deepEqual(s.players.map(p => p.slot), [0, 1, 2, 3]); assert.deepEqual(s.spectators, ['e']);
  assert.equal(spectator.game?.role, 'spectator');
  const bMessages = messages.get('b')!;
  assert.ok(bMessages.findIndex(m => m.t === 'game_session') < bMessages.findIndex(m => m.t === 'game_event'));
  a.handle(spectator, { t: 'game_play', epoch: s.epoch }); assert.equal(s.players.length, 4);
  a.handle(players[1], { t: 'game_input', epoch: s.epoch, seq: 1, frame: 50, bits: 2 });
  a.leave(players[1]); a.handle(spectator, { t: 'game_play', epoch: s.epoch });
  assert.equal(s.players.find(p => p.userId === 'e')?.slot, 1);
  assert.equal(s.events.some(e => e[1] === 1 && e[2] === 0), false);
  assert.deepEqual(s.events.slice(-2), [[0, 1, 2, 0], [0, 1, 1, 0]]);
  const watcher = add('watch');
  for (const p of [players[0], players[2], players[3], spectator]) a.leave(p);
  assert.equal(a.sessions.size, 0); assert.equal(watcher.game, null);
  assert.ok(messages.get('watch')!.some(m => m.t === 'game_session' && m.reason === 'empty'));
  const bot: Gamer = { id: 'bot', name: 'Bot', game: null, bot: true }; a.join(bot, 'one'); assert.equal(a.sessions.size, 0);
});
test('arcade epochs: global ids, countdown, sync, stale commands, player-only level menus and reset', () => {
  const { a, add, tick, now, messages } = setup(), u = add('a'), other = add('b', 'two'), s = a.session(u)!;
  assert.notEqual(s.epoch, a.session(other)!.epoch);
  const old = s.epoch; a.startEpoch(s, 3, now() + 3000);
  const watcher = add('watch'); assert.equal(watcher.game?.role, 'spectator');
  a.handle(watcher, { t: 'game_play', epoch: s.epoch }); assert.equal(watcher.game?.role, 'spectator');
  a.handle(watcher, { t: 'game_menu', epoch: s.epoch, op: 'lobby' }); assert.equal(s.level, 3);
  a.handle(u, { t: 'game_menu', epoch: old, op: 'lobby' }); assert.equal(s.level, 3);
  a.handle(u, { t: 'game_input', epoch: s.epoch, seq: 1, frame: 2, bits: 6 });
  tick(now() + 2999); assert.equal(s.sim.frame, 0);
  a.reset(u); assert.equal(s.lastFrame[0], 0); assert.equal(s.events.some(e => e[2] === 0), false);
  tick(now() + 200); assert.equal(s.sim.players[0].bits, 0);
  const count = messages.get('a')!.filter(m => m.t === 'game_session').length;
  a.handle(u, { t: 'game_sync', epoch: s.epoch }); assert.equal(messages.get('a')!.filter(m => m.t === 'game_session').length, count + 1);
  const epoch = s.epoch; a.handle(u, { t: 'game_menu', epoch, op: 'restart' });
  assert.ok(s.epoch > epoch); assert.equal(s.startAt, now() + 3000); assert.equal(s.sim.frame, 0);
  a.handle(u, { t: 'game_menu', epoch: s.epoch, op: 'lobby' }); assert.equal(s.phase, 'lobby'); assert.equal(s.sim.selected, 3);
  a.join(u, 'two'); assert.equal(a.sessions.has('one'), false); assert.equal(a.session(u), a.session(other));
});
test('arcade sequencing: every safe input echoed, late and far-ahead frames clamped, reset purges, seq private', () => {
  const { a, add, tick, now, messages } = setup(), u = add('a'), v = add('b'), s = a.session(u)!;
  tick(now() + 1000);
  for (const frame of [-50, s.sim.frame + 10, -1, 999999]) a.handle(u, { t: 'game_input', epoch: s.epoch, seq: frame, frame, bits: 15 });
  const own = messages.get('a')!.filter((m): m is Extract<ServerMsg, { t: 'game_event' }> => m.t === 'game_event' && m.seq !== undefined);
  assert.equal(own.length, 4);
  assert.deepEqual(own.map(m => m.ev[0]), [s.sim.frame, s.sim.frame + 10, s.sim.frame + 10, s.sim.frame + 10]);
  assert.ok(own.every(m => m.ev[3] === 7));
  assert.ok(messages.get('b')!.filter(m => m.t === 'game_event').every(m => m.seq === undefined));
  const count = s.events.length;
  for (const patch of [{ frame: NaN }, { frame: 1.5 }, { seq: Infinity }, { bits: '2' }, { epoch: s.epoch - 1 }])
    a.handle(u, { t: 'game_input', epoch: s.epoch, seq: 1, frame: 0, bits: 2, ...patch } as ClientMsg);
  assert.equal(s.events.length, count);
  a.reset(u); assert.equal(s.events.some(e => e[1] === 0 && e[2] === 0), false);
  a.handle(u, { t: 'game_input', epoch: s.epoch, seq: 10, frame: -1, bits: 2 });
  assert.deepEqual(s.events.at(-1), [s.sim.frame, 0, 0, 2]);
  a.leave(u); const before = s.events.length;
  a.handle(u, { t: 'game_input', epoch: s.epoch, seq: 11, frame: 500, bits: 2 }); assert.equal(s.events.length, before);
  assert.equal(a.session(v), s);
});
test('arcade tick: exact single-step lobby transition, all crossed checks, terminal clear then four-second lobby', () => {
  const { a, add, tick, now, messages } = setup(), u = add('a'), s = a.session(u)!;
  tick(now() + 10000);
  assert.deepEqual(messages.get('a')!.filter(m => m.t === 'game_check').map(m => m.frame), Array.from({ length: 9 }, (_, i) => (i + 1) * 60));
  const lobby = LEVELS[0].lobby!, p = s.sim.players[0];
  p.x = lobby.start.x * TILE; p.y = lobby.start.y * TILE - PLAYER_H; p.vx = p.vy = p.bits = 0; p.grounded = true;
  s.sim.startHold = 59;
  const epoch = s.epoch; tick(now() + 500);
  assert.ok(s.epoch > epoch); assert.equal(s.level, 1); assert.equal(s.sim.frame, 0); assert.equal(s.startAt, now() + 3000);
  // Inject a terminal state to isolate session transitions from the separately tested physics.
  tick(s.startAt + 100); s.sim.cleared = true; s.sim.clearedAt = s.sim.frame - 1;
  const levelEpoch = s.epoch; tick(now() + 100); assert.equal(s.phase, 'clear'); assert.equal(s.epoch, levelEpoch);
  const frame = s.sim.frame; tick(now() + 3999); assert.equal(s.phase, 'clear'); assert.ok(s.sim.frame > frame);
  tick(now() + 1); assert.equal(s.phase, 'lobby'); assert.equal(s.sim.selected, 2);
});
test('arcade records: real clear stores once per team size, time/coin ties, roster changes disqualify, persistence', () => {
  const h = setup(), u = h.add('a'), s = h.a.session(u)!;
  h.a.startEpoch(s, 1, h.now());
  for (const [frame, slot, bits] of SOLUTIONS[1][1].inputs) { s.events.push([frame, slot, 0, bits]); }
  h.tick(h.now() + 20000); assert.equal(s.phase, 'clear'); assert.equal(s.clear?.record, true);
  const record = structuredClone(h.a.records[1][1]!);
  assert.deepEqual(record.names, ['A']); assert.equal(record.frames, s.sim.clearedAt);
  const writes = () => h.broadcasts.filter(m => m.t === 'arcade_records').length;
  const count = writes(); h.tick(h.now() + 100); assert.equal(writes(), count);
  const finish = (frames: number, coins: number, rosterChanged = false) => {
    h.a.startEpoch(s, 1, h.now()); s.rosterChanged = rosterChanged;
    s.sim.cleared = true; s.sim.clearedAt = frames; s.sim.coins = coins; h.tick(h.now() + 150);
    return s.clear!.record;
  };
  assert.equal(finish(record.frames + 1, 999), false); assert.equal(finish(record.frames, record.coins), false);
  assert.equal(finish(record.frames, record.coins + 1), true); assert.equal(finish(record.frames - 1, 0), true);
  assert.equal(finish(1, 999, true), false);
  h.a.startEpoch(s, 1, h.now()); const spectator = h.add('watch'); h.a.leave(spectator); assert.equal(s.rosterChanged, false);
  h.a.startEpoch(s, 0, h.now()); const partner = h.add('b'); h.a.startEpoch(s, 1, h.now()); h.a.leave(partner);
  assert.equal(s.teamSize, 2); assert.equal(s.rosterChanged, true);
  const loaded = setup().a; loaded.load(h.a.dump()); assert.deepEqual(loaded.dump(), h.a.dump());
  for (const bad of [null, [], 42, { records: { 1: { 1: { ...record, frames: -1 } } } }]) { loaded.load(bad); assert.deepEqual(loaded.records, {}); }
});
test('arcade cheers: sliding second allows at most two per user and only session members receive them', () => {
  const { a, add, time, messages } = setup(), u = add('a'), v = add('b'), other = add('c', 'two');
  for (let i = 0; i < 5; i++) a.handle(u, { t: 'game_cheer', kind: 1 });
  assert.equal(messages.get(v.id)!.filter(m => m.t === 'game_cheer').length, 2);
  assert.equal(messages.get(other.id)!.filter(m => m.t === 'game_cheer').length, 0);
  time(100999); a.handle(u, { t: 'game_cheer', kind: 2 });
  assert.equal(messages.get(v.id)!.filter(m => m.t === 'game_cheer').length, 2);
  time(101000); a.handle(u, { t: 'game_cheer', kind: 0 });
  a.handle(u, { t: 'game_cheer', kind: '1' } as unknown as ClientMsg);
  assert.equal(messages.get(v.id)!.filter(m => m.t === 'game_cheer').length, 3);
});
test('arcade world: use walks to shortest neighbour then room fallback; records never create errands', t => {
  const { w, add, tick } = worldSetup(t), a = add('A'), cabinet = cabinets[0];
  for (const [i, tile] of besideObject(w.map, cabinet).entries()) add(`Block${i}`, tile);
  w.use(a.u, cabinet.id);
  assert.ok(a.u.move); assert.equal(besideObject(w.map, cabinet).some(p => p.x === a.u.tile.x && p.y === a.u.tile.y), false);
  assert.equal(roomAt(w.map, a.u.tile.x, a.u.tile.y)?.id, 'arcade');
  const duration = pathDuration(a.u.path!); assert.equal(a.u.game, null); tick(duration + 1);
  assert.deepEqual(a.u.game, { cabinet: cabinet.id, role: 'player' });
  const before = a.u.move; w.use(a.u, w.map.objects.find(o => o.type === 'records')!.id);
  assert.equal(a.u.move, before); assert.ok(a.u.game);
  const b = add('B', { x: 56, y: 16 }); w.use(b.u, cabinets[1].id);
  assert.deepEqual({ x: b.u.tile.x, y: b.u.tile.y }, { x: 56, y: 15 }); tick(pathDuration(b.u.path!) + 1); assert.ok(b.u.game);
});
test('arcade world: arrival rejects offline, outgoing, instanced, bot, removed and repurposed cabinets', t => {
  const { w, add, tick } = worldSetup(t);
  for (const condition of ['offline', 'outgoing', 'instance', 'bot', 'removed', 'repurposed', 'wandered']) {
    const a = add(condition, { x: 55, y: 16 }), cabinet = w.map.objects.find(o => o.id === cabinets[0].id)!;
    w.use(a.u, cabinet.id); const duration = pathDuration(a.u.path!);
    const original = structuredClone(cabinet);
    if (condition === 'offline') a.u.presence = 'offline';
    if (condition === 'outgoing') a.u.door = 'thinking';
    if (condition === 'instance') a.u.instance = 'meeting';
    if (condition === 'bot') a.u.bot = true;
    if (condition === 'removed') w.map.objects = w.map.objects.filter(o => o.id !== cabinet.id);
    if (condition === 'repurposed') cabinet.use = { kind: 'records', label: 'records' };
    if (condition === 'wandered') w.walk(a.u, { x: 58, y: 16 });
    tick(duration + 1); assert.equal(a.u.game, null, condition);
    if (condition === 'removed') w.map.objects.push(original); else Object.assign(cabinet, original);
    a.u.presence = 'offline';
  }
});
test('arcade world: accepted walks and errands leave; rejected walks retain membership; explicit leave', t => {
  const { w, add } = worldSetup(t), a = add('A');
  w.arcade.join(a.u, cabinets[0].id);
  assert.equal(w.walk(a.u, { x: 0, y: 0 }), null); assert.ok(a.u.game);
  assert.notEqual(w.walk(a.u, { x: 58, y: 16 }), null); assert.equal(a.u.game, null);
  w.arcade.join(a.u, cabinets[0].id); w.use(a.u, w.map.objects.find(o => o.type === 'coffee_machine')!.id); assert.equal(a.u.game, null);
  w.arcade.join(a.u, cabinets[0].id); w.handle(a.u, { t: 'game_leave' }, a.socket); assert.equal(a.u.game, null);
});
test('arcade world: meeting entry, layout step-aside and final door flow leave', t => {
  const { w, add, tick } = worldSetup(t), a = add('Ivan'); a.u.email = 'ivan.baranov@t1a.com';
  const meeting = { key: 'm', instance: 'm-room', start: Date.now(), end: Date.now() + 60000,
    title: 'test', emails: [a.u.email], owners: new Set([a.u.id]) };
  w.meetings.events.set(meeting.key, meeting); w.arcade.join(a.u, cabinets[0].id); w.enterMeeting(a.u, 'm');
  assert.equal(a.u.instance, 'm-room'); assert.equal(a.u.game, null); w.leaveMeeting(a.u);
  a.u.tile = { x: 55, y: 16 }; a.u.move = null; a.u.path = null;
  w.arcade.join(a.u, cabinets[0].id); w.edit(a.u, { op: 'add', type: 'plant', x: 55, y: 16 });
  assert.ok(a.u.move); assert.equal(a.u.game, null);
  w.arcade.join(a.u, cabinets[0].id); a.close(); assert.ok(a.u.game); tick(5000);
  assert.equal(a.u.game, null); tick(pathDuration(a.u.path!) + 401); assert.equal(a.u.presence, 'offline');
  // Even an unpathable door must clear the session at the final step.
  const b = add('B'); w.arcade.join(b.u, cabinets[0].id);
  w.map.exit = { x: 0, y: 0 }; b.close(); tick(5000); assert.ok(b.u.game); tick(400); assert.equal(b.u.game, null);
});
test('arcade world: owner-only commands and game delivery, handover resets queued input, disconnect and reconnect', t => {
  const { w, add, tick } = worldSetup(t), a = add('A'), b = add('B'), cabinet = cabinets[0].id;
  w.arcade.join(a.u, cabinet); w.arcade.join(b.u, cabinet);
  const s = w.arcade.session(a.u)!, secondMessages: ServerMsg[] = [];
  w.handle(a.u, { t: 'game_input', epoch: s.epoch, seq: 1, frame: 50, bits: 2 }, a.socket);
  const second = w.connect(a.u.id, m => secondMessages.push(structuredClone(m)));
  assert.ok(a.messages.some(m => m.t === 'game_session' && m.reason === 'elsewhere'));
  assert.ok(secondMessages.some(m => m.t === 'game_session' && m.session?.epoch === s.epoch));
  assert.equal(s.events.some(e => e[1] === 0 && e[2] === 0), false);
  a.messages.length = secondMessages.length = 0;
  w.handle(a.u, { t: 'game_input', epoch: s.epoch, seq: 2, frame: 0, bits: 2 }, a.socket);
  w.handle(a.u, { t: 'game_leave' }, a.socket); assert.ok(a.u.game);
  assert.equal(secondMessages.length, 0);
  w.handle(b.u, { t: 'game_input', epoch: s.epoch, seq: 2, frame: 0, bits: 1 }, b.socket);
  assert.equal(a.messages.some(m => m.t === 'game_event'), false); assert.ok(secondMessages.some(m => m.t === 'game_event'));
  w.handle(a.u, { t: 'voice_claim' }, a.socket);
  assert.ok(secondMessages.some(m => m.t === 'game_session' && m.reason === 'elsewhere'));
  second.close();
  w.handle(a.u, { t: 'game_input', epoch: s.epoch, seq: 3, frame: 50, bits: 2 }, a.socket);
  a.close(); assert.equal(s.events.at(-1)?.[2], 3); assert.equal(s.lastFrame[0], s.sim.frame);
  tick(1000); assert.equal(s.sim.players[0].bits, 0); assert.ok(a.u.game);
  const reconnectMessages: ServerMsg[] = [], reconnect = w.connect(a.u.id, m => reconnectMessages.push(structuredClone(m)));
  assert.ok(reconnectMessages.some(m => m.t === 'game_session' && m.session?.epoch === s.epoch));
  for (const type of ['arcade', 'arcade_records', 'game_status']) assert.ok(reconnectMessages.some(m => m.t === type));
  w.handle(a.u, { t: 'game_input', epoch: s.epoch, seq: 4, frame: s.sim.frame, bits: 2 }, reconnect.socket);
  tick(100); assert.equal(s.sim.players[0].bits, 2);
});
test('arcade world: records persist, membership does not; east-wing migration precedes fixture refresh', t => {
  const { w, add } = worldSetup(t), a = add('A'); w.arcade.join(a.u, cabinets[0].id);
  const record: ParkRecord = { frames: 100, coins: 5, names: ['A'], at: Date.now() };
  w.arcade.records = { 1: { 1: record } };
  const saved = w.dump(); assert.equal('game' in saved.users[0], false);
  const oldLayout: Layout = { objects: structuredClone(base.objects.filter(o => o.type !== 'arcade' && o.type !== 'records')), rugs: structuredClone(base.rugs) };
  oldLayout.objects.push({ id: 'old-table', type: 'table_round', x: 56, y: 13, w: 1, h: 1 }); saved.layout = oldLayout;
  const next = new World(structuredClone(base)); next.load(saved);
  assert.deepEqual(next.arcade.records, w.arcade.records); assert.equal(next.users.get(a.u.id)!.game, null);
  assert.equal(next.arcade.sessions.size, 0); assert.deepEqual(next.map.objects.filter(o => o.type === 'arcade'), cabinets);
  assert.equal(layoutProblem(next.map), null);
  // On a subsequent load the three protected cabinets must retain their separate identities and edits.
  saved.layout = structuredClone({ objects: base.objects, rugs: base.rugs }); saved.layout.objects.find(o => o.id === cabinets[1].id)!.x = 57;
  next.load(saved); assert.deepEqual(next.map.objects.filter(o => o.type === 'arcade').map(o => o.x), [54, 57, 61]);
});
test('arcade map: room rects, divider thresholds, clear Music approach, cabinets/decor/standing spots and stable ids', () => {
  assert.deepEqual(base.rooms.find(r => r.id === 'music')!.rect, { x: 54, y: 3, w: 10, h: 8 });
  const arcade = base.rooms.find(r => r.id === 'arcade')!;
  assert.deepEqual(arcade.rect, { x: 54, y: 13, w: 10, h: 10 }); assert.equal(arcade.rules.voice, 'open');
  assert.deepEqual(cabinets.map(o => [o.x, o.y, o.w, o.h]), [[54, 13, 1, 2], [56, 13, 1, 2], [61, 13, 1, 2]]);
  for (const o of cabinets) assert.ok(besideObject(base, o).some(t => findPath(base, base.spawn, t).length));
  for (const y of [11, 12]) for (let x = 54; x <= 63; x++) {
    assert.equal(!!base.layers.walls[y][x], x !== 58 && x !== 59);
    if (x === 58 || x === 59) { assert.equal(base.tiles[base.layers.floor[y][x]], 'door_floor'); assert.ok(findPath(base, base.spawn, { x, y }).length); }
  }
  for (let y = 13; y <= 15; y++) for (let x = 57; x <= 60; x++) assert.ok(isWalkable(base, x, y));
  assert.deepEqual(base.objects.filter(o => o.type === 'records').map(o => [o.x, o.y, o.w, o.h, o.wall]), [[62, 12, 2, 1, true]]);
  assert.ok(base.rugs.some(r => r.color === 'teal' && r.x === 56 && r.y === 16 && r.w === 6 && r.h === 3));
  assert.ok(base.objects.some(o => o.type === 'plant' && o.x === 63 && o.y === 20));
  assert.deepEqual(arcade.stand, [{ x: 55, y: 16, dir: 'up' }, { x: 61, y: 16, dir: 'up' }, { x: 58, y: 19, dir: 'up' }]);
  assert.equal(Number(base.objects.find(o => o.type === 'sofa' && o.x === 55 && o.y === 21)!.id.slice(1)) - Number(cabinets[0].id.slice(1)), 6);
  const c = cabinets[0], neighbours = besideObject(base, c);
  const objects = [...base.objects, ...neighbours.map((p, i) => ({ id: `block${i}`, type: 'plant', ...p, w: 1, h: 1 }))];
  assert.equal(layoutProblem(withLayout(base, { objects, rugs: base.rugs })), 'nobody could reach the arcade');
});
test('arcade map: pure migration handles moved-out, moved-in, admin-added and boundary-touching footprints, unique ids and idempotence', () => {
  const layout = structuredClone({ objects: base.objects, rugs: base.rugs });
  const saved = structuredClone(layout); saved.objects = saved.objects.filter(o => o.type !== 'arcade');
  const movedOut = saved.objects.find(o => o.type === 'jukebox')!; movedOut.x = 4; movedOut.y = 4;
  const movedIn = saved.objects.find(o => o.type === 'bookshelf')!; movedIn.x = 58; movedIn.y = 17;
  saved.objects.push({ id: 'admin-in', type: 'plant', x: 63, y: 20, w: 1, h: 1 }, { id: 'admin-out', type: 'plant', x: 3, y: 20, w: 1, h: 1 },
    { id: 'touch', type: 'desk', x: 52, y: 10, w: 3, h: 1 });
  saved.rugs.find(r => r.id === 'r8')!.x = 2;
  saved.rugs.push({ id: 'admin-rug', color: 'red', x: 53, y: 15, w: 2, h: 2 });
  const before = structuredClone(saved), migrated = migrateEastWing(saved, layout);
  assert.deepEqual(saved, before); assert.notEqual(migrated, saved);
  assert.deepEqual(migrated.objects.find(o => o.id === movedOut.id), layout.objects.find(o => o.id === movedOut.id));
  for (const id of [movedIn.id, 'admin-in', 'touch']) assert.equal(migrated.objects.some(o => o.id === id), false, id);
  assert.ok(migrated.objects.some(o => o.id === 'admin-out')); assert.equal(migrated.rugs.some(r => r.id === 'admin-rug'), false);
  assert.deepEqual(migrated.rugs.find(r => r.id === 'r8'), layout.rugs.find(r => r.id === 'r8'));
  for (const entries of [migrated.objects, migrated.rugs]) assert.equal(new Set(entries.map(o => o.id)).size, entries.length);
  assert.equal(migrateEastWing(migrated, layout), migrated);
  migrated.objects.find(o => o.id === movedOut.id)!.x = 1; assert.notDeepEqual(migrated.objects, layout.objects);
});

// Each direction of each connection is FIFO. Delays are in frames, sampled separately for every message.
class Wire<T> {
  private queue: { at: number; msg: T }[] = [];
  constructor(private clock: () => number, private delay: () => number, private deliver: (msg: T) => void) {}
  send(msg: T) {
    const at = Math.max(this.clock() + this.delay(), this.queue.at(-1)?.at ?? 0);
    this.queue.push({ at, msg: structuredClone(msg) });
  }
  flush() { while (this.queue.length && this.queue[0].at <= this.clock()) this.deliver(this.queue.shift()!.msg); }
  get size() { return this.queue.length; }
}
for (const [level, team] of [[1, 2], [3, 3], [6, 2]] as const) test(`arcade netcode: level ${level}, ${team} players + spectator, seeded FIFO 0–8 frame delays for 10,000 frames`, () => {
  let frame = 0, seed = 0xabcdef + level;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const now = () => 100000 + frame * 1000 / 60;
  const users = new Map<string, Gamer>();
  type Peer = { u: Gamer; runner: Runner; up: Wire<ClientMsg>; down: Wire<ParkIncoming>; active: boolean; stalled: boolean };
  const peers = new Map<string, Peer>(), wires: { flush(): void; size: number }[] = [];
  const sent = new Map<string, number>();
  let retimed = 0, resets = 0, countdownInputs = 0, syncRequests = 0;
  const arcade = new Arcade({ now, timer: false, user: id => users.get(id), broadcast() {},
    send(id, msg) {
      if (msg.t === 'game_event') {
        if (msg.ev[2] === 3) resets++;
        if (msg.seq !== undefined && sent.get(`${id}:${msg.seq}`) !== msg.ev[0]) retimed++;
      }
      if (['game_session', 'game_event', 'game_members', 'game_check', 'game_clear'].includes(msg.t)) peers.get(id)?.down.send(msg as ParkIncoming);
    },
  });
  const connect = (id: string, existing?: Gamer) => {
    const old = peers.get(id); if (old) old.active = false;
    const u: Gamer = existing ?? { id, name: id, bot: false, game: null }; users.set(id, u);
    const peer = { u, active: true, stalled: false } as Peer;
    peer.up = new Wire(() => frame, () => rand() % 9, msg => { if (peer.active) arcade.handle(u, msg); });
    peer.runner = new Runner({ userId: id, now, transport: { send(msg) {
      if (msg.t === 'game_input') {
        sent.set(`${id}:${msg.seq}`, msg.frame);
        if (now() < arcade.session(u)!.startAt) countdownInputs++;
      } else syncRequests++;
      peer.up.send(msg);
    } } });
    peer.down = new Wire(() => frame, () => rand() % 9, msg => { if (peer.active) peer.runner.receive(msg); });
    peers.set(id, peer); wires.push(peer.up, peer.down);
    if (existing) { arcade.reset(u); arcade.resend(u); } else arcade.join(u, 'one');
    return peer;
  };
  const initial = Array.from({ length: team }, (_, i) => connect(`p${i}`));
  const s = arcade.session(initial[0].u)!; arcade.startEpoch(s, level, now() + 3000);
  const pump = (tickServer = true) => {
    for (const wire of wires) wire.flush();
    if (tickServer) arcade.tick(now());
    for (const p of peers.values()) if (p.active && !p.stalled) p.runner.tick();
    for (const wire of wires) wire.flush();
  };
  for (; frame < 10000; frame++) {
    if (frame === 800) connect('watch');
    if (frame === 1800) connect('p0', users.get('p0'));
    // A player leaves, then a lobby epoch lets a replacement reuse their slot.
    if (frame === 3000) {
      const p = peers.get('p1')!; arcade.leave(p.u); p.active = false;
      arcade.startEpoch(s, 0, now()); connect('replacement'); arcade.startEpoch(s, level, now() + 3000);
    }
    if (frame === 4200) peers.get('p0')!.stalled = true;
    if (frame === 4420) peers.get('p0')!.stalled = false;
    if (frame === 5200) peers.get('p0')!.stalled = true;
    if (frame === 5550) peers.get('p0')!.stalled = false;
    if (frame === 6500) { arcade.reset(users.get('p0')!); arcade.resend(users.get('p0')!); }
    for (const p of peers.values()) if (p.active && !p.stalled && p.u.game?.role === 'player' && rand() % 7 === 0) p.runner.setLocalBits((rand() >>> 8) & 7);
    pump();
  }
  for (const p of peers.values()) p.runner.setLocalBits(0);
  // Stop inputs, drain both FIFO directions, then freeze the authoritative common frame.
  for (let n = 0; n < 120; n++, frame++) pump();
  assert.equal(wires.reduce((n, w) => n + w.size, 0), 0);
  const F = s.sim.frame, expected = hashState(s.sim);
  for (let n = 0; n < 40; n++, frame++) pump(false);
  pump(false);
  for (const p of peers.values()) if (p.active) {
    const state = p.runner.stateAt(F);
    assert.ok(state, `${p.u.id} has common frame ${F}; current=${p.runner.state?.frame}`);
    assert.equal(hashState(state), expected, `${p.u.id} at F=${F}`);
    assert.equal(p.runner.provisionalCount, 0, p.u.id);
    assert.ok(p.runner.state!.frame >= p.runner.targetFrame, `${p.u.id} is not stuck`);
  }
  assert.ok([...peers.values()].some(p => p.runner.debug.rollbacks > 0));
  assert.ok(retimed > 0, 'own input retimed by server'); assert.ok(countdownInputs > 0);
  assert.ok(resets > 0, 'owner/reconnect neutral reset'); assert.ok(syncRequests > 0, '>300 frame stall requested sync');
  assert.equal(peers.get('watch')!.u.game?.role, 'spectator');
});
