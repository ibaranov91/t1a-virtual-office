import test from 'node:test';
import assert from 'node:assert/strict';
import { Jukebox } from './jukebox';
import type { Track } from '../../shared/music';
const tracks: Track[] = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, file: `${i}.m4a`, title: `${i}`, artist: 'Test', genre: 'Test', duration: 3000, page: '', license: 'CC0 1.0' }));
const opts = () => { let n = 0; return { rand: () => 0, id: () => `id${n++}` }; };
const make = (catalog = tracks) => new Jukebox(catalog, 10000, opts());
test('starts a track and advances once exactly at expiry', () => {
  assert.throws(() => make([]));
  const j = make(); assert.equal(j.state.track, 't0'); assert.equal(j.state.startedAt, 10000);
  assert.equal(j.advance(12999), false); assert.equal(j.advance(13000), true);
  assert.equal(j.state.track, 't1'); assert.equal(j.state.startedAt, 13000);
  j.advance(999999); assert.equal(j.state.track, 't2'); assert.equal(j.state.startedAt, 999999);
});
test('queue is FIFO with requester; duplicates, current track and limits are refused', () => {
  const j = make();
  assert.equal(j.act('a', { action: 'queue', track: 't0' }, 10000).notice, 'Already in the queue');
  assert.equal(j.act('a', { action: 'queue', track: 'missing' }, 10000).changed, false);
  for (let i = 1; i <= 3; i++) assert.equal(j.act('a', { action: 'queue', track: `t${i}` }, 10000).changed, true);
  assert.equal(j.act('b', { action: 'queue', track: 't1' }, 10000).notice, 'Already in the queue');
  assert.equal(j.act('a', { action: 'queue', track: 't4' }, 10000).notice, 'You have 3 tracks queued — wait for one to play');
  for (let i = 4; i <= 20; i++) j.act(`u${i}`, { action: 'queue', track: `t${i}` }, 10000);
  assert.equal(j.act('b', { action: 'queue', track: 't21' }, 10000).notice, 'The queue is full');
  j.advance(13000); assert.equal(j.state.track, 't1'); assert.equal(j.state.by, 'a');
  j.advance(16000); assert.equal(j.state.track, 't2'); assert.equal(j.state.queue.length, 18);
});
test('unqueue is own only; pause freezes, resume keeps position, paused skip plays', () => {
  const j = make(); j.act('a', { action: 'queue', track: 't2' }, 10000);
  const entry = j.state.queue[0].id;
  assert.equal(j.act('b', { action: 'unqueue', entry }, 10000).changed, false);
  assert.equal(j.act('a', { action: 'unqueue', entry: 'missing' }, 10000).changed, false);
  assert.equal(j.act('a', { action: 'unqueue', entry }, 10000).changed, true);
  const playId = j.state.playId;
  j.act('a', { action: 'pause', playId }, 11000); assert.equal(j.state.pausedAt, 1000);
  assert.equal(j.advance(20000), false);
  assert.equal(j.act('a', { action: 'pause', playId }, 20000).changed, false);
  j.act('b', { action: 'play', playId }, 20000); assert.equal(j.state.startedAt, 19000); assert.equal(j.state.pausedAt, null);
  assert.deepEqual(j.state.last, { kind: 'play', by: 'b', at: 20000 });
  j.act('a', { action: 'pause', playId }, 20500);
  j.act('b', { action: 'skip', playId }, 21000); assert.equal(j.state.pausedAt, null); assert.notEqual(j.state.playId, playId);
  assert.deepEqual(j.state.last, { kind: 'skip', by: 'b', at: 21000 });
});
test('shuffle excludes last five; small catalogs fall back without repeating current', () => {
  const j = make();
  for (let i = 1; i <= 7; i++) { j.advance(10000 + i * 3000); assert.ok(!j.history.slice(0, -1).includes(j.state.track)); }
  assert.equal(j.history.length, 5);
  const small = make(tracks.slice(0, 2)); small.advance(13000); small.advance(16000); assert.equal(small.state.track, 't0');
  const one = make(tracks.slice(0, 1)); assert.equal(one.advance(13000), true); assert.equal(one.state.track, 't0');
});
test('controls at expiry preserve the successor in either tick/action order', () => {
  for (const action of ['pause', 'play', 'skip'] as const) for (const at of [13000, 13001]) for (const tickFirst of [false, true]) {
    const j = make(), playId = j.state.playId;
    if (tickFirst) j.advance(at);
    const result = j.act('a', { action, playId }, at);
    assert.equal(result.changed, !tickFirst); assert.equal(j.state.track, 't1');
    assert.equal(j.state.pausedAt, null); assert.equal(j.state.last, null); assert.equal(j.state.startedAt, 13000); // the previous end
  }
  for (const action of ['pause', 'play', 'skip'] as const) {
    const j = make(), playId = j.state.playId;
    if (action === 'play') j.act('a', { action: 'pause', playId }, 12998);
    j.act('a', { action, playId }, 12999);
    assert.equal(j.state.last?.kind, action);
  }
});
test('persistence round trip, downtime advances only on first tick', () => {
  const j = make(); j.act('a', { action: 'queue', track: 't4' }, 11000);
  j.act('a', { action: 'pause', playId: j.state.playId }, 11000);
  assert.deepEqual(Jukebox.load(tracks, j.dump(), 20000, opts()).dump(), j.dump());
  j.act('a', { action: 'play', playId: j.state.playId }, 12000);
  const loaded = Jukebox.load(tracks, j.dump(), 90000, opts());
  assert.equal(loaded.state.track, 't0'); loaded.advance(90000); assert.equal(loaded.state.track, 't4'); assert.equal(loaded.state.startedAt, 90000);
});
test('load repairs malformed state, times, history and missing playback id without throwing', () => {
  for (const saved of [null, undefined, [], 42, 'bad', {}, { state: null }, { state: { track: 'unknown', pausedAt: 5 } }]) {
    const j = Jukebox.load(tracks, saved, 20000, opts()); assert.ok(tracks.some(t => t.id === j.state.track)); assert.equal(j.state.startedAt, 20000); assert.equal(j.state.pausedAt, null);
  }
  for (const startedAt of [NaN, Infinity, 'bad', 30000]) {
    const j = Jukebox.load(tracks, { state: { track: 't2', startedAt, pausedAt: Infinity, last: { kind: 'pause', by: 'a', at: NaN } } }, 20000, opts());
    assert.equal(j.state.startedAt, 20000); assert.equal(j.state.pausedAt, null); assert.equal(j.state.last, null); assert.ok(j.state.playId);
  }
  for (const [pausedAt, expected] of [[-50, 0], [4000, 3000]]) {
    const j = Jukebox.load(tracks, { state: { track: 't2', startedAt: 10000, pausedAt } }, 20000, opts()); assert.equal(j.state.pausedAt, expected);
  }
  for (const last of [{ kind: 'bad', by: 'a', at: 1 }, { kind: 'play', by: 3, at: 1 }, [], 'bad'])
    assert.equal(Jukebox.load(tracks, { state: { track: 't0', last } }, 20000, opts()).state.last, null);
  const j = Jukebox.load(tracks, { state: { track: 't0', playId: 'kept', by: 42, queue: {} }, history: ['bad', ...tracks.map(t => t.id)] }, 20000, opts());
  assert.equal(j.state.playId, 'kept'); assert.equal(j.state.by, null); assert.deepEqual(j.state.queue, []); assert.deepEqual(j.history, tracks.slice(-5).map(t => t.id));
});
test('load keeps oldest valid queue entries within all limits', () => {
  const queue = [null, { id: 2, by: 'a', track: 't1' }, { id: 'bad', by: 3, track: 't1' }, { id: 'x', by: 'a', track: 'unknown' }, { id: 'current', by: 'a', track: 't0' },
    { id: 'a', by: 'a', track: 't1' }, { id: 'a', by: 'b', track: 't2' }, { id: 'b', by: 'b', track: 't1' },
    ...tracks.slice(2).map((t, i) => ({ id: `q${i}`, by: i < 4 ? 'a' : `u${i}`, track: t.id }))];
  const j = Jukebox.load(tracks, { state: { track: 't0', queue } }, 10000, opts());
  assert.equal(j.state.queue.length, 20); assert.deepEqual(j.state.queue.slice(0, 3).map(e => e.track), ['t1', 't2', 't3']);
  assert.equal(j.state.queue.filter(e => e.by === 'a').length, 3); assert.equal(j.state.queue.some(e => e.track === 't4' || e.track === 't5'), false);
});
test('next is published ahead: the queue head, else a shuffle pick that then plays', () => {
  const j = make(); assert.equal(j.state.next, 't1');
  j.act('a', { action: 'queue', track: 't7' }, 10000); assert.equal(j.state.next, 't7');
  j.act('a', { action: 'queue', track: 't1' }, 10000); assert.equal(j.state.next, 't7');
  j.act('a', { action: 'unqueue', entry: j.state.queue[0].id }, 10000); assert.equal(j.state.next, 't1');
  j.act('a', { action: 'unqueue', entry: j.state.queue[0].id }, 10000); assert.equal(j.state.next, 't2'); // t1 was queued meanwhile: re-picked
  const next = j.state.next;
  j.act('a', { action: 'skip', playId: j.state.playId }, 11000); assert.equal(j.state.track, next);
  assert.ok(j.state.next && j.state.next !== j.state.track && !j.history.includes(j.state.next));
  const upcoming = j.state.next; j.advance(14000); assert.equal(j.state.track, upcoming);
});
test('the successor starts at the exact end unless the tick is a second or more late', () => {
  const j = make(); j.advance(13250); assert.equal(j.state.startedAt, 13000);
  j.advance(16999); assert.equal(j.state.startedAt, 16000);
  j.advance(20000); assert.equal(j.state.startedAt, 20000);
});
test('a saved next survives a restart; a stale one is re-picked', () => {
  const j = make(); const saved = j.dump();
  assert.equal(Jukebox.load(tracks, saved, 11000, opts()).state.next, j.state.next);
  const odd = Jukebox.load(tracks, { ...saved, state: { ...saved.state, next: 't9' } }, 11000, opts()); assert.equal(odd.state.next, 't9');
  for (const next of ['t0', 'missing', 42]) {
    const l = Jukebox.load(tracks, { ...saved, state: { ...saved.state, next } }, 11000, opts());
    assert.ok(l.state.next && l.state.next !== 't0' && tracks.some(t => t.id === l.state.next));
  }
});
