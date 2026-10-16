import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { doorwayTiles, roomAt, type TileMap, type Tile } from '../../shared/map';
import type { ClientMsg, ServerMsg } from '../../shared/protocol';

const freshMap = (): TileMap => JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const w = new World(freshMap());
  const add = (name: string, tile: Tile = w.map.spawn, email?: string) => {
    const u = w.addUser(name, false, tile, email); u.presence = 'online';
    const messages: ServerMsg[] = [], conn = w.connect(u.id, m => messages.push(m));
    return { u, messages, ...conn };
  };
  const admin = add('Admin', w.map.spawn, 'andrii.butko@t1a.com');
  const set = (roomId: string, mode: string, by = admin) => w.handle(by.u, { t: 'room_mode', roomId, mode } as unknown as ClientMsg, by.socket);
  return { w, add, admin, set };
}

test('only admins can change room modes; invalid rooms and modes leave rules intact', t => {
  const { w, add, set } = setup(t), guest = add('Guest');
  const room = w.map.rooms.find(r => r.id === 'focus')!, before = structuredClone(room.rules);
  set('focus', 'voice', guest); set('missing', 'voice'); set('focus', '__proto__'); set('focus', '');
  assert.deepEqual(room.rules, before);
  set('focus', 'voice');
  assert.equal(room.rules.voice, 'open');
  assert.equal(room.rules.knock, 'allow');
});

test('changing an occupied room joins and leaves its voice without moving people', t => {
  const { w, add, set } = setup(t), room = w.map.rooms.find(r => r.id === 'focus')!;
  const a = add('Alice', room.stand[0]), b = add('Bob', room.spots[1]);
  const tile = { ...a.u.tile };
  set('focus', 'voice');
  assert.equal(a.u.callId, 'room:focus'); assert.equal(b.u.callId, 'room:focus');
  set('focus', 'quiet');
  assert.equal(a.u.callId, null); assert.equal(b.u.callId, null);
  assert.deepEqual(a.u.tile, tile);
  w.knock(a.u, b.u);
  assert.deepEqual([...w.knocks.values()].map(k => k.state), ['blocked'], 'quiet mode blocks knocks immediately');
  set('focus', 'knock');
  w.knock(a.u, b.u);
  assert.ok([...w.knocks.values()].some(k => k.state === 'walking'), 'knock mode allows conversations again');
});

test('mode updates reach existing clients, reconnects and saved state while keeping room access', t => {
  const { w, add, admin, set } = setup(t), guest = add('Guest');
  set('admin', 'voice'); set('library', 'voice');
  assert.equal(w.map.rooms.find(r => r.id === 'admin')!.rules.access, 'admins');
  assert.ok(guest.messages.some(m => m.t === 'room_modes'), 'broadcast to other clients');
  const saved = JSON.parse(JSON.stringify(w.dump()));
  const restored = new World(freshMap()); restored.load(saved);
  assert.equal(restored.map.rooms.find(r => r.id === 'library')!.rules.voice, 'open');
  assert.equal(restored.map.rooms.find(r => r.id === 'admin')!.rules.access, 'admins');
  const snapshot = restored.snapshot() as Extract<ServerMsg, { t: 'state' }> & { roomModes?: Record<string, string> };
  assert.equal(snapshot.roomModes?.library, 'voice');
  const messages: ServerMsg[] = [];
  restored.connect(admin.u.id, m => messages.push(m));
  assert.ok(messages.some(m => m.t === 'state' && (m as typeof snapshot).roomModes?.admin === 'voice'));
});

test('Busy restores postponed knocks and the room-specific occupant label', t => {
  const { w, add, set } = setup(t), room = w.map.rooms.find(r => r.id === 'library')!;
  const a = add('Alice', room.stand[0]), b = add('Bob', room.spots[1]);
  set('library', 'voice'); set('library', 'later');
  assert.equal(a.u.callId, null);
  assert.equal(room.rules.knock, 'later');
  assert.equal(room.rules.occupantLabel, 'reading');
  w.knock(a.u, b.u);
  assert.ok(b.messages.some(m => m.t === 'later' && m.items.length === 1));
});


test('a disabled full hall clears its waiting queue and every member', t => {
  const { w, add, set } = setup(t), room = w.map.rooms.find(r => r.id === 'coffee')!;
  const people = Array.from({ length: 13 }, (_, i) => add(`Person ${i}`, room.stand[0]));
  w.voiceTick();
  assert.equal(people.filter(p => p.u.callId === 'room:coffee').length, 12);
  assert.ok(people[12].messages.some(m => m.t === 'voice_wait' && m.roomId === 'coffee'));
  set('coffee', 'quiet');
  assert.ok(people.every(p => p.u.callId === null));
  assert.ok(people[12].messages.some(m => m.t === 'voice_wait' && m.roomId === null));
  w.voiceTick(); assert.ok(people.every(p => p.u.callId === null));
});

test('an admins-only room voice does not admit someone standing at its doorway', t => {
  const { w, add, set } = setup(t), room = w.map.rooms.find(r => r.id === 'admin')!;
  const outside = doorwayTiles(w.map, room).flat().find(p => roomAt(w.map, p.x, p.y)?.id !== room.id)!;
  assert.ok(outside);
  const guest = add('Guest', outside), sysadmin = add('Sysadmin', room.stand[0], 'ivan.baranov@t1a.com');
  set('admin', 'voice');
  assert.equal(sysadmin.u.callId, 'room:admin');
  assert.equal(guest.u.callId, null, 'access rules apply to room voice at the doorway too');
});

test('old saves use generated defaults and malformed saved modes are ignored', t => {
  const { w, set } = setup(t), old = w.dump();
  delete (old as Partial<typeof old>).roomModes;
  set('focus', 'voice');
  w.load({ ...old, roomModes: { focus: '__proto__', missing: 'voice' } } as unknown as typeof old);
  assert.equal(w.map.rooms.find(r => r.id === 'focus')!.rules.knock, 'disabled');
  assert.equal(w.map.rooms.find(r => r.id === 'coffee')!.rules.voice, 'open');
});

for (const mode of ['quiet', 'later'] as const) test(`${mode} closes pending knocks before an old Accept can start a call`, t => {
  const { w, add, set } = setup(t), room = w.map.rooms.find(r => r.id === 'lobby')!;
  const a = add('Alice', room.stand[0]), b = add('Bob', room.spots[1]);
  w.knock(a.u, b.u); t.mock.timers.tick(15000);
  const knock = [...w.knocks.values()].find(k => k.toId === b.u.id)!;
  assert.equal(knock.state, 'pending');
  set('lobby', mode);
  assert.equal(knock.state, mode === 'quiet' ? 'blocked' : 'later');
  w.reply(b.u, knock.id, 'accept');
  assert.equal(a.u.callId, null); assert.equal(b.u.callId, null);
  if (mode === 'later') assert.ok(b.messages.some(m => m.t === 'later' && m.items.length === 1));
});
