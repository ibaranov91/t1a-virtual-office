import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { isWalkable, roomAt, type TileMap, type Tile } from '../../shared/map';
import type { LaterItem, ServerMsg } from '../../shared/protocol';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const hall = map.rooms.find(r => r.id === 'meeting')!;
const inHall: Tile = (() => {
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (roomAt(map, x, y)?.id === hall.id && isWalkable(map, x, y)) return { x, y };
  throw new Error('no meeting room tile');
})();

function setup(t: TestContext, n = 3) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const people = Array.from({ length: n }, (_, i) => {
    const u = w.addUser(`P${i}`, false, { x: 33 + i, y: 29 }); u.presence = 'online';
    const msgs: ServerMsg[] = [];
    const { socket } = w.connect(u.id, m => msgs.push(m));
    return { u, msgs, socket };
  });
  return { w, people };
}
const lastLater = (msgs: ServerMsg[]) => msgs.filter((m): m is Extract<ServerMsg, { t: 'later' }> => m.t === 'later').at(-1)?.items as LaterItem[];

test('a knock on someone in the Meeting room does not walk, does not knock, and lands in their Later list', (t: TestContext) => {
  const { w, people: [a, b] } = setup(t, 2);
  b.u.tile = { ...inHall };
  const from = { ...a.u.tile };
  w.handle(a.u, { t: 'knock', targetId: b.u.id }, a.socket);
  assert.deepEqual(a.u.tile, from, 'knocker stays put');
  assert.equal(b.u.emote, null);
  assert.ok(!b.msgs.some(m => m.t === 'knock'), 'no knock reaches the target');
  const reply = a.msgs.find(m => m.t === 'knock_reply');
  assert.ok(reply && reply.t === 'knock_reply' && reply.reply === 'later' && reply.kept && /left a knock/.test(reply.reason ?? ''));
  assert.deepEqual(lastLater(b.msgs).map(i => i.fromId), [a.u.id]);
});

test('a new knock from the same person replaces the old entry; the list is newest first', (t: TestContext) => {
  const { w, people: [a, b, c] } = setup(t);
  b.u.tile = { ...inHall };
  w.handle(a.u, { t: 'knock', targetId: b.u.id }, a.socket);
  t.mock.timers.tick(1000);
  w.handle(c.u, { t: 'knock', targetId: b.u.id }, c.socket);
  t.mock.timers.tick(1000);
  w.handle(a.u, { t: 'knock', targetId: b.u.id }, a.socket);
  assert.deepEqual(lastLater(b.msgs).map(i => i.fromId), [a.u.id, c.u.id]);
  w.handle(b.u, { t: 'later_dismiss', id: lastLater(b.msgs)[0].id }, b.socket);
  assert.deepEqual(lastLater(b.msgs).map(i => i.fromId), [c.u.id]);
  w.handle(b.u, { t: 'later_clear' }, b.socket);
  assert.deepEqual(lastLater(b.msgs), []);
});

test('knocking back, and being accepted, clears the entry', (t: TestContext) => {
  const { w, people: [a, b] } = setup(t, 2);
  b.u.meeting = Date.now() + 3600_000;
  w.handle(a.u, { t: 'knock', targetId: b.u.id }, a.socket);
  assert.equal(lastLater(b.msgs).length, 1);
  b.u.meeting = null;
  w.handle(b.u, { t: 'knock', targetId: a.u.id }, b.socket); // knocking on them answers their knock
  assert.deepEqual(lastLater(b.msgs), []);
  // the other path: they end up in a call together some other way
  b.u.meeting = Date.now() + 3600_000;
  w.handle(a.u, { t: 'knock', targetId: b.u.id }, a.socket);
  assert.equal(lastLater(b.msgs).length, 1);
  b.u.meeting = null;
  w.connectCall(a.u, b.u);
  t.mock.timers.tick(300);
  assert.deepEqual(lastLater(b.msgs), []);
});

test('the catch-up nudge fires once, after the meeting ends', (t: TestContext) => {
  const { w, people: [a, b, c] } = setup(t);
  b.u.meeting = Date.now() + 3600_000;
  t.mock.timers.tick(300); // busy spell begins
  w.handle(a.u, { t: 'knock', targetId: b.u.id }, a.socket);
  t.mock.timers.tick(300);
  assert.ok(!b.msgs.some(m => m.t === 'later_nudge'), 'nothing while still busy');
  b.u.meeting = null;
  t.mock.timers.tick(300);
  const nudges = () => b.msgs.filter((m): m is Extract<ServerMsg, { t: 'later_nudge' }> => m.t === 'later_nudge');
  assert.equal(nudges().length, 1);
  assert.equal(nudges()[0].userId, a.u.id);
  assert.match(nudges()[0].text, /While you were in a meeting: P0 knocked/);
  t.mock.timers.tick(5000);
  assert.equal(nudges().length, 1, 'once per spell');
  // two knockers
  b.u.meeting = Date.now() + 3600_000; t.mock.timers.tick(300);
  w.handle(a.u, { t: 'knock', targetId: b.u.id }, a.socket); w.handle(c.u, { t: 'knock', targetId: b.u.id }, c.socket);
  b.u.meeting = null; t.mock.timers.tick(300);
  assert.equal(nudges().length, 2);
  assert.match(nudges()[1].text, /and 1 other knocked/);
});
