import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { adminOnly, type TileMap, type Tile } from '../../shared/map';
import type { ServerMsg } from '../../shared/protocol';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const admin = map.rooms.find(r => r.id === 'admin')!;
const inside = { x: admin.rect.x + 6, y: admin.rect.y + 6 }; // free floor in the Admin room

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const add = (name: string, tile: Tile, email?: string) => {
    const u = w.addUser(name, false, tile, email); u.presence = 'online';
    const messages: ServerMsg[] = [];
    return { u, messages, ...w.connect(u.id, m => messages.push(m)) };
  };
  const notices = (m: ServerMsg[]) => m.flatMap(x => (x.t === 'notice' ? [x.text] : []));
  return { w, add, notices };
}

test('other office admins are admins but not sysadmins: no Admin room, while the sysadmin gets in', t => {
  const { w, add, notices } = setup(t);
  const varvara = add('Varvara', { x: 68, y: 18 }, 'varvara.tikhonova@t1a.com'), andrii = add('Andrii', { x: 70, y: 18 }, 'andrii.butko@t1a.com'), ivan = add('Ivan', { x: 66, y: 18 }, 'ivan.baranov@t1a.com');
  for (const a of [varvara, andrii, ivan]) assert.ok(w.isAdmin(a.u), a.u.name);
  assert.deepEqual([varvara, andrii, ivan].map(a => w.isSysadmin(a.u)), [false, false, true]);
  w.handle(varvara.u, { t: 'move', to: inside }, varvara.socket);
  assert.ok(notices(varvara.messages).some(n => n.includes('sysadmins only')));
  assert.ok(!adminOnly(map, varvara.u.tile.x, varvara.u.tile.y));
  w.handle(ivan.u, { t: 'move', to: inside }, ivan.socket);
  assert.deepEqual(ivan.u.tile, inside);
  const me = w.me(varvara.u); assert.ok(me.t === 'me' && me.admin && !me.sysadmin);
  const mine = w.me(ivan.u); assert.ok(mine.t === 'me' && mine.admin && mine.sysadmin);
});

test('admins teleport next to anyone: both ends are announced, the admin is moved at once, and only admins may', t => {
  const { w, add, notices } = setup(t);
  const kim = add('Kim', { x: 20, y: 18 }), ivan = add('Ivan', { x: 5, y: 15 }, 'ivan.baranov@t1a.com'), varvara = add('Varvara', { x: 6, y: 16 }, 'varvara.tikhonova@t1a.com');
  w.handle(kim.u, { t: 'teleport', targetId: ivan.u.id }, kim.socket);
  assert.deepEqual(kim.u.tile, { x: 20, y: 18 }, 'not an admin: nothing happens');
  const from = { ...ivan.u.tile };
  w.handle(ivan.u, { t: 'teleport', targetId: kim.u.id }, ivan.socket);
  const to = ivan.u.tile;
  assert.ok(Math.max(Math.abs(to.x - 20), Math.abs(to.y - 18)) <= 1 && (to.x !== 20 || to.y !== 18), `beside Kim: ${JSON.stringify(to)}`);
  assert.equal(ivan.u.move, null);
  for (const who of [kim, ivan, varvara]) assert.ok(who.messages.some(m => m.t === 'teleport' && m.userId === ivan.u.id && m.from.x === from.x && m.from.y === from.y && m.to.x === to.x && m.to.y === to.y), `${who.u.name} sees it`);
  // an admin who is not a sysadmin can't follow someone into the Admin room
  const inner = add('Inner', inside, 'ivan.baranov@t1a.com'), before = { ...varvara.u.tile };
  w.handle(varvara.u, { t: 'teleport', targetId: inner.u.id }, varvara.socket);
  assert.deepEqual(varvara.u.tile, before);
  assert.ok(notices(varvara.messages).some(n => n.includes('sysadmins only')));
  // a sysadmin may, and lands inside it
  w.handle(ivan.u, { t: 'teleport', targetId: inner.u.id }, ivan.socket);
  assert.ok(adminOnly(map, ivan.u.tile.x, ivan.u.tile.y));
});
