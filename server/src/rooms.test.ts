import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, type User } from './world';
import { adminOnly, findPath, layoutProblem, pathDuration, pathTo, roomAt, type TileMap, type Tile } from '../../shared/map';
import { stallDoor, stallLine } from '../../shared/map';
import { ITEMS_MAX, TOILET_CAPACITY, TOILET_DRAIN_MS, TOILET_FULL, TOILET_USE_MS, type ServerMsg } from '../../shared/protocol';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const admin = map.rooms.find(r => r.id === 'admin')!, club = map.rooms.find(r => r.id === 'berghain')!;
const inside = { x: admin.rect.x + 6, y: admin.rect.y + 6 }; // free floor by the door
const toilets = map.objects.filter(o => o.use?.kind === 'toilet');

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const add = (name: string, tile: Tile = { x: 68, y: 18 }, email?: string) => {
    const u = w.addUser(name, false, tile, email); u.presence = 'online';
    const messages: ServerMsg[] = [];
    const conn = w.connect(u.id, m => messages.push(m));
    return { u, messages, ...conn };
  };
  const notices = (m: ServerMsg[]) => m.flatMap(x => (x.t === 'notice' ? [x.text] : []));
  return { w, add, notices, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('the generated floor has an admins-only room behind the club and three stalls in Berghain', () => {
  assert.equal(admin.rules.access, 'admins');
  assert.equal(club.rules.access, undefined);
  assert.equal(toilets.length, 3);
  for (const o of toilets) assert.equal(roomAt(map, o.x, o.y)?.id, 'berghain');
  assert.equal(layoutProblem(map), null);
  assert.ok(adminOnly(map, inside.x, inside.y) && !adminOnly(map, 68, 18));
});

test('A* keeps non-admins out of the Admin room but lets them walk out of it', () => {
  assert.ok(findPath(map, map.spawn, inside).length);
  assert.deepEqual(findPath(map, map.spawn, inside, true), []);
  assert.deepEqual(pathTo(map, map.spawn, inside, true), []);
  const out = findPath(map, inside, map.spawn, true);
  assert.ok(out.length, 'someone already inside can leave');
  // everywhere else is reached the same way, without ever crossing the room
  for (const r of map.rooms) for (const s of r.stand) {
    if (r.id === 'admin') continue;
    const p = findPath(map, map.spawn, s, true);
    assert.ok(p.length, `${r.name} reachable`);
    assert.ok(!p.some(t => adminOnly(map, t.x, t.y)), `${r.name} path avoids the Admin room`);
  }
});

test('the server walks admins in and turns everyone else away at the door', t => {
  const { w, add, notices } = setup(t);
  const kim = add('Kim'), ivan = add('Ivan', { x: 70, y: 18 }, 'ivan.baranov@t1a.com');
  const before = kim.u.tile;
  w.handle(kim.u, { t: 'move', to: inside }, kim.socket);
  assert.deepEqual(kim.u.tile, before); assert.equal(kim.u.move, null);
  assert.ok(notices(kim.messages).some(n => n.includes('admins only')));
  w.handle(ivan.u, { t: 'move', to: inside }, ivan.socket);
  assert.deepEqual(ivan.u.tile, inside);
  // a non-admin's move carries its path, so clients (which path without the lock) draw the same walk
  w.handle(kim.u, { t: 'move', to: { x: 58, y: 18 } }, kim.socket);
  const move = [...kim.messages].reverse().find(m => m.t === 'move' && m.userId === kim.u.id);
  assert.ok(move?.t === 'move' && move.path?.length && !move.path.some(p => adminOnly(map, p.x, p.y)));
});

const walkIn = (w: World, a: { u: User; socket: string }, objectId: string, tick: (ms: number) => void) => {
  w.handle(a.u, { t: 'use', objectId }, a.socket);
  tick(pathDuration(a.u.path ?? []) + 400);
};

test('four fit in a stall; the rest line up outside and move in as places come free', t => {
  const { w, add, notices, tick } = setup(t);
  const stall = toilets[0], door = stallDoor(stall);
  const people = ['A', 'B', 'C', 'D', 'E', 'F'].map((n, i) => add(n, { x: 66 + (i % 3), y: 15 + Math.floor(i / 3) }));
  for (const p of people) walkIn(w, p, stall.id, tick);
  const s = () => w.toilets.state(stall.id);
  assert.deepEqual(s().in, people.slice(0, TOILET_CAPACITY).map(p => p.u.id));
  assert.deepEqual(s().queue, people.slice(TOILET_CAPACITY).map(p => p.u.id));
  assert.ok(notices(people[4].messages).some(n => n.startsWith('In line')));
  tick(3000);
  const line = stallLine(map, stall, 2);
  people.slice(TOILET_CAPACITY).forEach((p, i) => assert.deepEqual(p.u.tile, { x: line[i].x, y: line[i].y }, `${p.u.name} stands in line`));
  // one walks out: the first in line walks in, the next steps up
  w.handle(people[1].u, { t: 'move', to: { x: 66, y: 15 } }, people[1].socket);
  assert.deepEqual(s().in, [people[0], people[2], people[3], people[4]].map(p => p.u.id));
  assert.deepEqual(s().queue, [people[5].u.id]);
  tick(3000);
  assert.deepEqual(people[4].u.tile, door);
  assert.deepEqual(people[5].u.tile, { x: line[0].x, y: line[0].y });
  // leaving the line is just walking off
  w.handle(people[5].u, { t: 'move', to: { x: 66, y: 16 } }, people[5].socket);
  assert.deepEqual(s().queue, []);
  // visits end on their own
  tick(TOILET_USE_MS);
  assert.deepEqual(s().in, []);
});

test('the shelf takes company inside and the item in your inventory, and clears when the stall empties', t => {
  const { w, add, notices, tick } = setup(t);
  const stall = toilets[1], a = add('A', { x: 70, y: 16 }), b = add('B', { x: 71, y: 16 });
  walkIn(w, a, stall.id, tick);
  w.handle(a.u, { t: 'toilet_shelf', objectId: stall.id }, a.socket);
  assert.equal(w.toilets.state(stall.id).shelf, 0);
  assert.ok(notices(a.messages).some(n => n.includes('nothing to put')), 'no inventory, nothing to rack');
  t.mock.method(w, 'hasItem', () => true);
  w.handle(a.u, { t: 'toilet_shelf', objectId: stall.id }, a.socket);
  assert.ok(notices(a.messages).some(n => n.includes('company')));
  walkIn(w, b, stall.id, tick);
  w.handle(a.u, { t: 'toilet_shelf', objectId: stall.id }, a.socket);
  w.handle(b.u, { t: 'toilet_shelf', objectId: stall.id }, b.socket);
  assert.equal(w.toilets.state(stall.id).shelf, 2);
  w.handle(a.u, { t: 'move', to: { x: 70, y: 16 } }, a.socket);
  assert.equal(w.toilets.state(stall.id).shelf, 2, 'still someone inside');
  w.handle(b.u, { t: 'move', to: { x: 71, y: 16 } }, b.socket);
  assert.equal(w.toilets.state(stall.id).shelf, 0);
});

test('a stall overflows after enough visits, sends its line home, and drains slowly', t => {
  const { w, add, notices, tick } = setup(t);
  const stall = toilets[2], kim = add('Kim', { x: 72, y: 16 });
  for (let i = 1; i <= TOILET_FULL; i++) {
    walkIn(w, kim, stall.id, tick);
    assert.equal(w.toilets.state(stall.id).fill, i);
    w.handle(kim.u, { t: 'move', to: { x: 72, y: 16 } }, kim.socket); tick(2000);
  }
  kim.messages.length = 0;
  walkIn(w, kim, stall.id, tick);
  assert.deepEqual(w.toilets.state(stall.id).in, []);
  assert.ok(notices(kim.messages).some(n => n.includes('full')));
  tick(TOILET_DRAIN_MS);
  assert.equal(w.toilets.state(stall.id).fill, TOILET_FULL - 1);
  assert.ok(kim.messages.some(m => m.t === 'toilet' && m.id === stall.id && m.state.fill === TOILET_FULL - 1), 'everyone hears about it');
});

test('knocks on someone in a stall go to Later', t => {
  const { w, add, tick } = setup(t);
  const kim = add('Kim', { x: 68, y: 16 }), bo = add('Bo', { x: 66, y: 18 });
  walkIn(w, kim, toilets[0].id, tick);
  assert.deepEqual(w.toilets.state(toilets[0].id).in, [kim.u.id]);
  w.handle(bo.u, { t: 'knock', targetId: kim.u.id }, bo.socket);
  tick(2500); tick(2000); // walk over, then the knock goes to Later
  const reply = bo.messages.find(m => m.t === 'knock_reply');
  assert.ok(reply?.t === 'knock_reply' && reply.reply === 'later' && reply.reason?.includes('toilet'));
});

test('the bouncer sells drugs into the inventory (at most ITEMS_MAX); racking spends one; sniffing takes a line and shows unicorns', t => {
  const { w, add, notices, tick } = setup(t);
  const bouncer = map.objects.find(o => o.type === 'bouncer')!;
  const stall = toilets[1], a = add('A', { x: 66, y: 16 }), b = add('B', { x: 67, y: 16 });
  const me = (m: ServerMsg[]) => m.filter(x => x.t === 'me').at(-1) as Extract<ServerMsg, { t: 'me' }> | undefined;
  for (let i = 0; i < ITEMS_MAX + 1; i++) walkIn(w, a, bouncer.id, tick);
  assert.deepEqual(a.u.items, Array(ITEMS_MAX).fill('drugs'));
  assert.deepEqual(me(a.messages)?.items, Array(ITEMS_MAX).fill('drugs'));
  assert.ok(notices(a.messages).some(n => n.includes('pockets are full')));
  walkIn(w, a, stall.id, tick); walkIn(w, b, stall.id, tick);
  w.handle(b.u, { t: 'toilet_sniff', objectId: stall.id }, b.socket);
  assert.ok(notices(b.messages).some(n => n.includes('Nothing on the shelf')));
  assert.ok(!b.u.effects.some(e => e.kind === 'unicorns'));
  w.handle(a.u, { t: 'toilet_shelf', objectId: stall.id }, a.socket);
  assert.equal(w.toilets.state(stall.id).shelf, 1);
  assert.equal(a.u.items.length, ITEMS_MAX - 1, 'racking spends one');
  w.handle(b.u, { t: 'toilet_shelf', objectId: stall.id }, b.socket);
  assert.equal(w.toilets.state(stall.id).shelf, 1, 'B has nothing to rack');
  w.handle(b.u, { t: 'toilet_sniff', objectId: stall.id }, b.socket);
  assert.equal(w.toilets.state(stall.id).shelf, 0);
  assert.ok(b.u.effects.some(e => e.kind === 'unicorns'), 'sniffing shows unicorns');
  w.handle(b.u, { t: 'toilet_sniff', objectId: stall.id }, b.socket);
  assert.equal(w.toilets.state(stall.id).shelf, 0);
});

test('a cleaned stall is back in order once it has sat empty', t => {
  const { w } = setup(t), stall = toilets[2];
  for (let i = 1; i <= TOILET_FULL; i++) { w.toilets.arrive(stall.id, `u${i}`, i); w.toilets.leave(`u${i}`, i); }
  assert.equal(w.toilets.state(stall.id).fill, TOILET_FULL);
  assert.deepEqual(w.toilets.fullEmpty(1e9), [stall.id]);
  w.toilets.clean(stall.id, 1e9);
  assert.equal(w.toilets.state(stall.id).fill, 0);
  assert.deepEqual(w.toilets.fullEmpty(2e9), []);
});
