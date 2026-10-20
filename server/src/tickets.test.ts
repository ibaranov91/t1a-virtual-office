import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { Tickets, TICKET_GAP_MS } from './tickets';
import { TICKET_OPEN_MAX, type ServerMsg, type Ticket } from '../../shared/protocol';
import { type TileMap, type Tile } from '../../shared/map';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const CTX = { ua: 'test', app: 'web' as const, build: 'dev', viewport: '800x600' };

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const terminal = w.map.objects.find(o => o.use?.kind === 'tickets')!;
  const add = (name: string, tile: Tile = { x: 7, y: 17 }, email?: string) => {
    const u = w.addUser(name, false, tile, email); u.presence = 'online';
    const messages: ServerMsg[] = [];
    const conn = w.connect(u.id, m => messages.push(m));
    const lists = () => messages.filter((m): m is Extract<ServerMsg, { t: 'tickets' }> => m.t === 'tickets');
    return { u, messages, lists, ...conn };
  };
  const front = { x: terminal.x, y: terminal.y + 1 };
  return { w, add, front, terminal, tick: (ms: number) => t.mock.timers.tick(ms) };
}
type P = { u: Parameters<World['handle']>[0]; socket: Parameters<World['handle']>[2] };
const file = (w: World, p: P, title = 'Jukebox skips') =>
  w.handle(p.u, { t: 'ticket_new', title, text: 'Every 20 s', context: CTX }, p.socket);

test('the suggestions board is in the Lobby and walking up opens it', t => {
  const { w, add, terminal, tick } = setup(t), kim = add('Kim');
  assert.equal(terminal.type, 'suggestions_board');
  w.handle(kim.u, { t: 'use', objectId: terminal.id }, kim.socket);
  for (let i = 0; i < 80 && !kim.messages.some(m => m.t === 'terminal_open'); i++) tick(250);
  assert.ok(kim.messages.some(m => m.t === 'terminal_open' && m.objectId === terminal.id));
});

test('filing needs you at the terminal; the author and admins see it, nobody else', t => {
  const { w, add, front } = setup(t);
  const kim = add('Kim', front), far = add('Far'), ivan = add('Ivan', { x: 7, y: 18 }, 'ivan.baranov@t1a.com'), bob = add('Bob', { x: 8, y: 18 });
  file(w, far);
  assert.equal(w.tickets.list.length, 0); assert.ok(far.messages.some(m => m.t === 'notice'));
  const before = bob.lists().length;
  file(w, kim);
  assert.equal(w.tickets.list.length, 1);
  const t1 = w.tickets.list[0];
  assert.equal(t1.context.room, 'lobby'); assert.deepEqual(t1.context.tile, front);
  assert.equal(kim.lists().at(-1)!.list.length, 1);
  assert.equal(ivan.lists().at(-1)!.list.length, 1);
  assert.ok(ivan.messages.some(m => m.t === 'notice' && m.text.includes('#0001')));
  assert.equal(bob.lists().length, before, 'a third person hears nothing');
  assert.equal(bob.lists().at(-1)!.list.length, 0);
});

test('replies, statuses and who may set them', t => {
  const { w, add, front } = setup(t);
  const kim = add('Kim', front), ivan = add('Ivan', { x: 7, y: 18 }, 'ivan.baranov@t1a.com'), bob = add('Bob', { x: 8, y: 18 });
  file(w, kim);
  const id = w.tickets.list[0].id, get = () => w.tickets.get(id)!;
  w.handle(bob.u, { t: 'ticket_reply', id, text: 'me too' }, bob.socket);
  w.handle(kim.u, { t: 'ticket_status', id, status: 'fixed' }, kim.socket);
  assert.equal(get().msgs.length, 1); assert.equal(get().status, 'open');
  w.handle(ivan.u, { t: 'ticket_reply', id, text: 'On it' }, ivan.socket);
  assert.equal(get().msgs[1].admin, true);
  assert.ok(kim.messages.some(m => m.t === 'notice' && m.text.includes('Reply')));
  w.handle(ivan.u, { t: 'ticket_status', id, status: 'fixed' }, ivan.socket);
  assert.equal(get().status, 'fixed'); assert.ok(kim.u.achievements.bughunter);
  w.handle(kim.u, { t: 'ticket_reply', id, text: 'still skips' }, kim.socket);
  assert.equal(get().status, 'open', "the author's reply reopens a fixed ticket");
  w.handle(kim.u, { t: 'ticket_status', id, status: 'closed' }, kim.socket);
  assert.equal(get().status, 'closed');
});

test('caps: open tickets per person, one per 30 s, text sizes', () => {
  const tk = new Tickets(), where = { room: 'lobby' };
  assert.equal(typeof tk.add('u', '', 'x', CTX, where, 0), 'string');
  assert.equal(typeof tk.add('u', 'x'.repeat(81), 'x', CTX, where, 0), 'string');
  assert.equal(typeof tk.add('u', 'ok', 'x'.repeat(2001), CTX, where, 0), 'string');
  assert.equal(typeof tk.add('u', 'one', 'x', CTX, where, 0), 'object');
  assert.equal(typeof tk.add('u', 'two', 'x', CTX, where, 1), 'string');
  for (let i = 1; i < TICKET_OPEN_MAX; i++) assert.equal(typeof tk.add('u', `n${i}`, 'x', CTX, where, i * TICKET_GAP_MS), 'object');
  assert.equal(typeof tk.add('u', 'over', 'x', CTX, where, 99 * TICKET_GAP_MS), 'string');
  assert.equal(typeof tk.add('v', 'other', 'x', CTX, where, 99 * TICKET_GAP_MS), 'object');
});

test('tickets survive a restart', () => {
  const a = new Tickets();
  const t1 = a.add('u', 'one', 'body\n\nwith lines', CTX, {}, 0) as Ticket;
  assert.equal(t1.msgs[0].text, 'body\n\nwith lines');
  const b = new Tickets(); b.load(JSON.parse(JSON.stringify(a.dump())));
  assert.equal(b.list.length, 1);
  const t2 = b.add('v', 'two', 'x', CTX, {}, 0) as Ticket;
  assert.equal(t2.id, 2);
});
