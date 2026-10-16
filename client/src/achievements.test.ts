import test from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS, dayNumber, type LibraryState } from '../../shared/protocol';
import { progressOf, rarityOf, summary, sections, type AchievementContext } from './achievements';
const now = Date.UTC(2026, 9, 16), a = (id: string) => ACHIEVEMENTS.find(a => a.id === id)!;
function context(): AchievementContext {
  return { now, me: { id: 'me', achievements: {}, bloomed: [], plant: null }, library: { articles: [], reads: [] } };
}
test('plant progress requires a live plant; botanist counts distinct kinds', () => {
  const ctx = context();
  assert.equal(progressOf(a('bloom'), ctx), null);
  ctx.me.plant = { stage: 3, care: dayNumber(now), kind: 'daisy' };
  assert.deepEqual(progressOf(a('bloom'), ctx), { n: 3, goal: 5 });
  ctx.me.plant.care -= 7;
  assert.equal(progressOf(a('bloom'), ctx), null);
  ctx.me.bloomed = ['daisy', 'daisy', 'cactus'];
  assert.deepEqual(progressOf(a('botanist'), ctx), { n: 2, goal: 3 });
  ctx.me.achievements.botanist = now;
  assert.equal(progressOf(a('botanist'), ctx), null);
  assert.equal(progressOf(a('tended'), ctx), null);
});
test('bookworm counts distinct finished articles, including the author’s own reads', () => {
  const ctx = context();
  ctx.library.articles = [{ id: 'mine', by: 'me', url: '', title: '', topic: 'Engineering', at: now }] as LibraryState['articles'];
  ctx.library.reads = [
    { userId: 'me', articleId: 'mine', done: true, at: now },
    { userId: 'me', articleId: 'mine', done: true, at: now },
    { userId: 'me', articleId: 'other', done: true, at: now },
    { userId: 'me', articleId: 'unfinished', done: false, at: now },
    { userId: 'you', articleId: 'another', done: true, at: now },
  ];
  assert.deepEqual(progressOf(a('bookworm'), ctx), { n: 2, goal: 10 });
});
test('editor uses the largest distinct finished readership of one of my articles, excluding me', () => {
  const ctx = context();
  ctx.library.articles = ['one', 'two', 'foreign'].map(id => ({ id, by: id === 'foreign' ? 'you' : 'me', url: '', title: '', topic: 'Engineering', at: now })) as LibraryState['articles'];
  ctx.library.reads = [
    ...['me', 'a', 'a', 'b'].map(userId => ({ userId, articleId: 'one', done: true, at: now })),
    { userId: 'c', articleId: 'one', done: false, at: now },
    { userId: 'd', articleId: 'two', done: true, at: now },
    ...['a', 'b', 'c'].map(userId => ({ userId, articleId: 'foreign', done: true, at: now })),
  ];
  assert.deepEqual(progressOf(a('editor'), ctx), { n: 2, goal: 5 });
});
test('rarity includes offline humans, excludes bots, requires three humans and rounds percent', () => {
  const human = (got: boolean): { bot: boolean; achievements: Record<string, number> } => ({ bot: false, achievements: got ? { bloom: now } : {} });
  assert.equal(rarityOf('bloom', [human(true), human(false), { bot: true, achievements: {} }]), null);
  assert.deepEqual(rarityOf('bloom', [human(true), human(false), human(false), { bot: true, achievements: { bloom: now } }]), { has: 1, total: 3, pct: 33 });
  assert.deepEqual(rarityOf('bloom', new Map([['a', human(true)], ['b', human(true)], ['c', human(false)]])), { has: 2, total: 3, pct: 67 });
});
test('summary excludes soon, chooses latest and highest progress with map-order ties', () => {
  const ctx = context();
  assert.equal(summary(ctx.me, ctx).latest, null);
  ctx.me.achievements = { tended: now - 100, raver: now };
  ctx.me.plant = { stage: 0, care: dayNumber(now) };
  let s = summary(ctx.me, ctx);
  assert.equal(s.total, ACHIEVEMENTS.filter(a => !a.soon).length);
  assert.equal(s.unlocked, 2);
  assert.deepEqual(s.latest, { a: a('raver'), at: now });
  assert.equal(s.next?.a.id, 'bloom');
  ctx.me.bloomed = ['daisy'];
  s = summary(ctx.me, ctx);
  assert.equal(s.next?.a.id, 'botanist');
});
test('sections sort unlocks newest first, then progress, no progress, secrets, soon', () => {
  const ctx = context();
  ctx.me.achievements = { tended: now - 100, raver: now };
  ctx.me.plant = { stage: 4, care: dayNumber(now) };
  ctx.me.bloomed = ['daisy'];
  const [unlocked, locked] = sections(ctx.me, ctx);
  assert.equal(unlocked.id, 'unlocked');
  assert.deepEqual(unlocked.items.map(a => a.id), ['raver', 'tended']);
  assert.equal(locked.id, 'locked');
  assert.deepEqual(locked.items.map(a => a.id), ['bloom', 'botanist', 'bookworm', 'editor', 'whisperer', 'bellringer', 'escape', 'batcatcher', 'tidy', 'event']);
});
