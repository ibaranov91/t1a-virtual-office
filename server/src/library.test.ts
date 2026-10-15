import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { Library } from './library';
import { BOOKWORM_READS, EDITOR_READERS, LIBRARY_MAX_ARTICLES, type ServerMsg } from '../../shared/protocol';
import type { TileMap, Tile } from '../../shared/map';
const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date', 'setInterval'], now: 100000 });
  const w = new World(map);
  const add = (name: string, tile: Tile = { x: 7, y: 7 }, email?: string) => {
    const u = w.addUser(name, false, tile, email); u.presence = 'online';
    const messages: ServerMsg[] = [];
    const conn = w.connect(u.id, m => messages.push(m));
    return { u, messages, ...conn };
  };
  return { w, add, tick: (ms: number) => t.mock.timers.tick(ms) };
}
const URL1 = 'https://example.com/a';

test('library validates links, titles and topics', () => {
  const lib = new Library();
  assert.equal(typeof lib.add('u', 'javascript:alert(1)', 'x', 'Data', 1), 'string');
  assert.equal(typeof lib.add('u', 'ftp://example.com/x', 'x', 'Data', 1), 'string');
  assert.equal(typeof lib.add('u', 'https://user:pw@example.com/', 'x', 'Data', 1), 'string');
  assert.equal(typeof lib.add('u', `https://example.com/${'a'.repeat(600)}`, 'x', 'Data', 1), 'string');
  assert.equal(typeof lib.add('u', URL1, 'x'.repeat(121), 'Data', 1), 'string');
  assert.equal(typeof lib.add('u', URL1, 'ok', 'Cooking', 1), 'string');
  assert.equal(typeof lib.add('u', URL1, '   ', 'Data', 1), 'string');
  assert.equal(typeof lib.add('u', URL1, 'ok', 'Data', 1), 'object');
  assert.equal(typeof lib.add('u', URL1, 'again', 'Data', 2), 'string'); // already on the shelf
});

test('over the cap the oldest unread article goes first', () => {
  const lib = new Library();
  const first = lib.add('u', 'https://example.com/0', 'first', 'Fun', 0) as { id: string };
  const second = lib.add('u', 'https://example.com/1', 'second', 'Fun', 1) as { id: string };
  lib.start('r', first.id, 2); lib.finish('r');
  for (let i = 2; i <= LIBRARY_MAX_ARTICLES; i++) lib.add('u', `https://example.com/${i}`, `n${i}`, 'Fun', i);
  assert.equal(lib.articles.length, LIBRARY_MAX_ARTICLES);
  assert.ok(lib.get(first.id), 'a read article outlives an unread one'); assert.equal(lib.get(second.id), undefined);
});

test('publish → take a book → sit → read → done, and the log follows', t => {
  const { w, add, tick } = setup(t), pub = add('Pub'), rd = add('Reader', { x: 4, y: 6 });
  w.handle(pub.u, { t: 'article_add', url: URL1, title: 'A good read', topic: 'Data' }, pub.socket);
  const article = w.library.articles[0]; assert.ok(article);
  assert.ok(rd.messages.some(m => m.t === 'library' && m.articles.length === 1));
  w.handle(rd.u, { t: 'read_start', articleId: article.id }, rd.socket);
  assert.equal(rd.u.reading, null, 'not reading until seated');
  let held = false;
  for (let i = 0; i < 80 && !rd.u.reading; i++) { tick(250); held ||= rd.u.holding === 'book'; }
  assert.ok(held, 'carried a book from the shelf');
  assert.equal(rd.u.reading, article.id); assert.equal(rd.u.holding, null);
  assert.ok(pub.messages.some(m => m.t === 'reading' && m.userId === rd.u.id && m.articleId === article.id));
  const seat = rd.u.tile; assert.ok(w['readingSeats']().some(s => s.x === seat.x && s.y === seat.y));
  w.handle(rd.u, { t: 'read_done' }, rd.socket);
  assert.equal(rd.u.reading, null);
  assert.deepEqual(w.library.state().reads.map(r => [r.userId, r.articleId, r.done]), [[rd.u.id, article.id, true]]);
  assert.ok(pub.messages.some(m => m.t === 'library' && m.reads.length === 1));
  w.handle(rd.u, { t: 'read_done' }, rd.socket); // nothing to end: no second read
  assert.equal(w.library.state().reads.length, 1);
});

test('knocks on a reader go to Later (Focus itself refuses knocks; the rule holds where they would land)', t => {
  const focus = map.rooms.find(r => r.id === 'focus')!, rule = focus.rules.knock;
  focus.rules.knock = 'allow'; t.after(() => { focus.rules.knock = rule; });
  const { w, add, tick } = setup(t), pub = add('Pub'), rd = add('Reader', { x: 4, y: 6 }), guest = add('Guest', { x: 20, y: 17 });
  w.handle(pub.u, { t: 'article_add', url: URL1, title: 'Long one', topic: 'Product' }, pub.socket);
  w.handle(rd.u, { t: 'read_start', articleId: w.library.articles[0].id }, rd.socket);
  for (let i = 0; i < 80 && !rd.u.reading; i++) tick(250);
  assert.ok(rd.u.reading);
  w.knock(guest.u, rd.u);
  for (let i = 0; i < 120; i++) tick(250);
  const reply = guest.messages.find(m => m.t === 'knock_reply');
  assert.ok(reply && reply.t === 'knock_reply');
  assert.equal(reply.reply, 'later', reply.reason); assert.match(reply.reason ?? '', /reading/);
});

test('walking away, reconnecting or leaving ends the read', t => {
  const { w, add, tick } = setup(t), pub = add('Pub'), rd = add('Reader', { x: 4, y: 6 });
  w.handle(pub.u, { t: 'article_add', url: URL1, title: 'Walkaway', topic: 'Fun' }, pub.socket);
  const id = w.library.articles[0].id, sit = () => { w.handle(rd.u, { t: 'read_start', articleId: id }, rd.socket); for (let i = 0; i < 80 && !rd.u.reading; i++) tick(250); assert.ok(rd.u.reading); };
  sit(); w.handle(rd.u, { t: 'move', to: { x: 4, y: 6 } }, rd.socket); assert.equal(rd.u.reading, null);
  rd.u.holding = null; sit(); w.connect(rd.u.id, () => {}); assert.equal(rd.u.reading, null); // a reloaded page
  assert.equal(w.library.articlesRead(rd.u.id), 1, 'the same article counts once');
});

test('a walk elsewhere on the way to the desk drops the book', t => {
  const { w, add, tick } = setup(t), pub = add('Pub'), rd = add('Reader', { x: 4, y: 6 });
  w.handle(pub.u, { t: 'article_add', url: URL1, title: 'Never mind', topic: 'Design' }, pub.socket);
  w.handle(rd.u, { t: 'read_start', articleId: w.library.articles[0].id }, rd.socket);
  for (let i = 0; i < 40 && rd.u.holding !== 'book'; i++) tick(250);
  assert.equal(rd.u.holding, 'book');
  w.handle(rd.u, { t: 'move', to: { x: 3, y: 6 } }, rd.socket);
  for (let i = 0; i < 40; i++) tick(250);
  assert.equal(rd.u.reading, null); assert.equal(rd.u.holding, null);
});

test('remove: author or admin only', t => {
  const { w, add } = setup(t), a = add('A'), b = add('B'), admin = add('Admin', undefined, 'ivan.baranov@t1a.com');
  w.handle(a.u, { t: 'article_add', url: URL1, title: 'Mine', topic: 'Fun' }, a.socket);
  const id = w.library.articles[0].id;
  w.handle(b.u, { t: 'article_remove', id }, b.socket); assert.equal(w.library.articles.length, 1);
  assert.equal(w.isAdmin(admin.u), true);
  w.handle(admin.u, { t: 'article_remove', id }, admin.socket); assert.equal(w.library.articles.length, 0);
  w.handle(a.u, { t: 'article_add', url: URL1, title: 'Mine', topic: 'Fun' }, a.socket);
  w.handle(a.u, { t: 'article_remove', id: w.library.articles[0].id }, a.socket); assert.equal(w.library.articles.length, 0);
});

test('bookworm after ten different articles, editor when five people read yours; library survives a save', t => {
  const { w, add } = setup(t), author = add('Author'), reader = add('Reader');
  for (let i = 0; i < BOOKWORM_READS; i++) w.library.add(author.u.id, `https://example.com/p${i}`, `P${i}`, 'Data', 100000 + i);
  for (const a of w.library.articles) { reader.u.reading = a.id; w.library.start(reader.u.id, a.id, Date.now()); w.stopReading(reader.u); }
  assert.ok(reader.u.achievements.bookworm);
  assert.equal(author.u.achievements.editor, undefined, 'one reader is not five');
  for (let i = 0; i < EDITOR_READERS - 1; i++) {
    const r = add(`R${i}`), a = w.library.articles[0];
    r.u.reading = a.id; w.library.start(r.u.id, a.id, Date.now()); w.stopReading(r.u);
  }
  assert.ok(author.u.achievements.editor);
  const saved = JSON.parse(JSON.stringify(w.library.dump())), lib = new Library(); lib.load(saved);
  assert.equal(lib.articles.length, BOOKWORM_READS); assert.equal(lib.state().reads.length, w.library.state().reads.length);
  const bad = new Library(); bad.load({ articles: [{ id: 'x', url: 'javascript:1', title: 't', topic: 'Data', by: 'u', at: 1 }], reads: [] });
  assert.equal(bad.articles.length, 0);
});
