import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Journal } from './journal';
import { World } from './world';
import { JOURNAL_MAX, type JournalEntry, type LaterItem, type ServerMsg } from '../../shared/protocol';
import type { TileMap } from '../../shared/map';

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));

test('journal caps per person, keeps newest, ignores empty entries', () => {
  const j = new Journal();
  for (let i = 0; i < JOURNAL_MAX + 25; i++) j.add('a', { kind: 'notice', text: `n${i}` }, 1000 + i);
  j.add('b', { kind: 'notice', text: 'b' }, 1);
  assert.equal(j.add('a', { kind: 'notice', text: '  ' }), null);
  assert.equal(j.list('a').length, JOURNAL_MAX);
  assert.equal(j.list('a')[0].text, 'n25');
  assert.equal(j.list('a').at(-1)!.text, `n${JOURNAL_MAX + 24}`);
  assert.equal(j.list('b').length, 1);
});

test('journal unread marker, persistence round trip and bad data', () => {
  const j = new Journal();
  j.add('a', { kind: 'call', text: 'one' }, 100);
  j.markRead('a', 150);
  j.add('a', { kind: 'call', text: 'two' }, 200);
  assert.equal(j.unread('a'), 1);
  const k = new Journal(); k.load(JSON.parse(JSON.stringify(j.dump())));
  assert.deepEqual(k.list('a').map(e => e.text), ['one', 'two']);
  assert.equal(k.unread('a'), 1);
  k.load({ x: { entries: [{ nope: 1 }, 'str'], readAt: 'x' }, y: 5 });
  assert.equal(k.list('x').length, 0);
});

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
const added = (msgs: ServerMsg[]) => msgs.filter((m): m is Extract<ServerMsg, { t: 'journal_add' }> => m.t === 'journal_add').map(m => m.entry as JournalEntry);

test('DND: knock goes to Later with no knock message; deafen still pops up; DND is public and cleared', (t: TestContext) => {
  const { w, people: [a, b, c] } = setup(t);
  w.handle(b.u, { t: 'dnd', on: true }, b.socket);
  assert.ok(a.msgs.some(m => m.t === 'dnd' && m.userId === b.u.id && m.on));
  assert.equal(b.u.dnd, true);
  const from = { ...a.u.tile };
  w.handle(a.u, { t: 'knock', targetId: b.u.id }, a.socket);
  assert.deepEqual(a.u.tile, from, 'no walk over');
  assert.ok(!b.msgs.some(m => m.t === 'knock'), 'no pop-up');
  assert.deepEqual(lastLater(b.msgs).map(i => i.fromId), [a.u.id]);
  assert.match(added(b.msgs).at(-1)!.text, /knocked/);
  assert.equal(added(b.msgs).at(-1)!.action, 'knock_back');
  // deafened is not DND
  w.handle(c.u, { t: 'dnd', on: false }, c.socket);
  c.u.deafened = true;
  w.handle(a.u, { t: 'knock', targetId: c.u.id }, a.socket);
  t.mock.timers.tick(5000);
  assert.ok(c.msgs.some(m => m.t === 'knock'), 'deafened people still get the pop-up');
  w.handle(b.u, { t: 'dnd', on: false }, b.socket);
  assert.equal(b.u.dnd, undefined);
  assert.equal(w.dump().users.find(u => u.id === b.u.id)!.dnd, undefined);
});

test('DND is saved with the user', (t: TestContext) => {
  const { w, people: [a] } = setup(t, 1);
  w.handle(a.u, { t: 'dnd', on: true }, a.socket);
  assert.equal(w.dump().users.find(u => u.id === a.u.id)!.dnd, true);
});

test('journal records a knock call start and end for both people, only sent to the owner', (t: TestContext) => {
  const { w, people: [a, b, c] } = setup(t);
  w.handle(a.u, { t: 'knock', targetId: b.u.id }, a.socket);
  t.mock.timers.tick(5000);
  const k = b.msgs.find(m => m.t === 'knock');
  assert.ok(k && k.t === 'knock');
  w.handle(b.u, { t: 'knock_reply', knockId: k.knockId, reply: 'accept' }, b.socket);
  assert.ok(added(a.msgs).some(e => e.kind === 'call' && /started with P1/.test(e.text)));
  assert.ok(added(b.msgs).some(e => e.kind === 'knock_in' && /answered/.test(e.text)));
  assert.equal(added(c.msgs).length, 0);
  t.mock.timers.tick(3 * 60_000);
  w.leaveCall(a.u);
  assert.ok(added(a.msgs).some(e => e.kind === 'call' && /ended \(3 min\)/.test(e.text)));
  assert.ok(added(b.msgs).some(e => e.kind === 'call' && /ended/.test(e.text)), 'the call dissolved for the other person too');
  assert.equal(w.journal.list(a.u.id).length, added(a.msgs).length);
});

test('journal_read marks everything read', (t: TestContext) => {
  const { w, people: [a] } = setup(t, 1);
  w.journal.add(a.u.id, { kind: 'notice', text: 'x' });
  assert.equal(w.journal.unread(a.u.id), 1);
  t.mock.timers.tick(10);
  w.handle(a.u, { t: 'journal_read' }, a.socket);
  assert.equal(w.journal.unread(a.u.id), 0);
});
