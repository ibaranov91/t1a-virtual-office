import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { adminOnly, besideObject, findPath, layoutProblem, pathDuration, pathTo, roomAt, type TileMap, type Tile } from '../../shared/map';
import { TOILET_DRAIN_MS, TOILET_FULL, TOILET_USE_MS, type ServerMsg } from '../../shared/protocol';
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

test('a stall fills up with use, overflows at the threshold, drains slowly, and an admin can plunge it', t => {
  const { w, add, notices, tick } = setup(t);
  const kim = add('Kim', { x: 68, y: 18 }), ivan = add('Ivan', { x: 66, y: 20 }, 'ivan.baranov@t1a.com');
  const stall = toilets[0];
  const visit = () => {
    w.handle(kim.u, { t: 'use', objectId: stall.id }, kim.socket);
    tick(pathDuration(kim.u.path ?? []) + 400);
  };
  for (let i = 1; i <= TOILET_FULL; i++) {
    visit();
    assert.equal(w.toilets.state(stall.id).by, kim.u.id, `visit ${i} goes in`);
    assert.equal(w.toilets.state(stall.id).fill, i);
    assert.ok(besideObject(map, stall).some(s => s.x === kim.u.tile.x && s.y === kim.u.tile.y));
    tick(TOILET_USE_MS);
    assert.equal(w.toilets.state(stall.id).by, null, 'out again after the visit');
  }
  kim.messages.length = 0;
  visit();
  assert.equal(w.toilets.state(stall.id).by, null);
  assert.equal(w.toilets.state(stall.id).fill, TOILET_FULL);
  assert.ok(notices(kim.messages).some(n => n.includes('full')));
  // non-admins can't plunge; it drains one level after a while
  w.handle(kim.u, { t: 'toilet_plunge', objectId: stall.id }, kim.socket);
  assert.equal(w.toilets.state(stall.id).fill, TOILET_FULL);
  tick(TOILET_DRAIN_MS);
  assert.equal(w.toilets.state(stall.id).fill, TOILET_FULL - 1);
  w.handle(ivan.u, { t: 'toilet_plunge', objectId: stall.id }, ivan.socket);
  assert.equal(w.toilets.state(stall.id).fill, 0);
  assert.ok(kim.messages.some(m => m.t === 'toilet' && m.id === stall.id && m.state.fill === 0), 'everyone hears about it');
});

test('knocks on someone in a stall go to Later, and walking off frees the stall', t => {
  const { w, add, tick } = setup(t);
  const kim = add('Kim', { x: 68, y: 18 }), bo = add('Bo', { x: 66, y: 18 });
  const stall = toilets[1];
  w.handle(kim.u, { t: 'use', objectId: stall.id }, kim.socket);
  tick(pathDuration(kim.u.path ?? []) + 400);
  assert.equal(w.toilets.state(stall.id).by, kim.u.id);
  // someone else can't go in meanwhile
  w.handle(bo.u, { t: 'use', objectId: stall.id }, bo.socket);
  assert.ok(bo.messages.some(m => m.t === 'notice' && m.text.startsWith('Occupied')));
  w.handle(bo.u, { t: 'knock', targetId: kim.u.id }, bo.socket);
  tick(2500); tick(2000); // walk over, then the knock goes to Later
  const reply = bo.messages.find(m => m.t === 'knock_reply');
  assert.ok(reply?.t === 'knock_reply' && reply.reply === 'later' && reply.reason?.includes('toilet'));
  w.handle(kim.u, { t: 'move', to: { x: 68, y: 17 } }, kim.socket);
  assert.equal(w.toilets.state(stall.id).by, null);
});
