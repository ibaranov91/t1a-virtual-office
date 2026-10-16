import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGb } from '../../shared/retro/gb';
import { normalize } from '../../shared/retro/buttons';
import { games } from '../../shared/retro/games';

const wasm = readFileSync(new URL('../../client/public/retro/binjgb.wasm', import.meta.url));
const rom = (game: keyof typeof games) => readFileSync(new URL(`../../client/public/retro/${games[game].rom}`, import.meta.url));
test('retro buttons cancel opposing directions', () => {
  assert.equal(normalize(255), 240); assert.equal(normalize(17), 17);
});
test('Gb snapshots survive 200 restores and continue identically at another audio rate', async () => {
  const a = await createGb({ wasm, rom: rom('lobster'), save: null, audioRate: 44100, audio: true });
  const b = await createGb({ wasm, rom: rom('lobster'), save: null, audioRate: 48000, audio: false });
  try {
    for (let i = 0; i < 120; i++) { a.step(0); b.step(0); }
    assert.equal(a.hash(), b.hash()); const snap = a.state(); b.restore(snap, a.frame);
    for (let i = 0; i < 200; i++) b.restore(b.state(), b.frame);
    for (let i = 0; i < 120; i++) { a.step(128); b.step(128); }
    assert.equal(a.hash(), b.hash()); assert.deepEqual(a.ext(), b.ext());
    assert.equal(a.screen().length, 160 * 144 * 4);
    const audio = a.audio(); assert.ok(audio.length > 1); assert.ok(audio.every(x => x.length === 4096));
    assert.equal(a.audio().length, 0); assert.equal(b.audio().length, 0);
  } finally { a.destroy(); b.destroy(); }
});

import { Retro } from './retro';
import type { PublicUser, ServerMsg } from '../../shared/protocol';
function transport(create?: typeof createGb) {
  let now = Date.UTC(2026, 9, 16), next = 0;
  const users = new Map<string, PublicUser>();
  const sent: { id: string; msg: ServerMsg }[] = [], broadcasts: ServerMsg[] = [];
  const retro = new Retro({ now: () => now, send: (id, msg) => sent.push({ id, msg }), broadcast: msg => broadcasts.push(msg), user: id => users.get(id), timer: false,
    roms: { tobu: rom('tobu'), lobster: rom('lobster') }, wasm, createGb: create, id: () => `run${++next}`, cabinets: [{ id: 't', game: 'tobu' }, { id: 'l', game: 'lobster' }] });
  const person = (id: string) => { const u = { id, name: id, presence: 'online', game: null } as PublicUser; users.set(id, u); return u; };
  return { retro, person, users, sent, broadcasts, advance: (ms: number) => now += ms };
}
test('Retro reserves before async creation, keeps watchers across vacancy and attaches to next player', async () => {
  const pending: ((g: Awaited<ReturnType<typeof createGb>>) => void)[] = [];
  const real = await createGb({ wasm, rom: rom('tobu'), save: null, audioRate: 48000, audio: false });
  const h = transport(() => new Promise(resolve => pending.push(resolve))), a = h.person('a'), b = h.person('b');
  const joining = h.retro.join(a, 't'); await h.retro.join(b, 't');
  assert.equal(h.retro.summary()[0].player, 'a'); assert.equal(b.game?.role, 'spectator');
  h.retro.leave(a); pending[0](real); await joining;
  assert.equal(h.retro.summary()[0].player, null); assert.equal(h.retro.summary()[0].watchers, 1);
  assert.throws(() => real.step(0), /destroyed/);
  const c = h.person('c'), joined = h.retro.join(c, 't');
  const gb = await createGb({ wasm, rom: rom('tobu'), save: null, audioRate: 48000, audio: false });
  pending[1](gb); await joined;
  assert.ok(h.sent.some(x => x.id === 'b' && x.msg.t === 'retro_session' && x.msg.view?.kind === 'playing'));
  h.retro.shutdown();
});
test('Retro streams reject gaps, require explicit first buttons, ignore other members and relay accepted frames', async () => {
  const h = transport(), a = h.person('a'), b = h.person('b');
  await h.retro.join(a, 'l'); await h.retro.join(b, 'l'); h.sent.length = 0;
  const batch = { t: 'retro_frames', runId: 'run1', sync: 0, from: 0, upto: 6, changes: [[0, 0]] } as const;
  h.advance(101); h.retro.handle(b, structuredClone(batch) as any); assert.equal(h.sent.length, 0);
  h.retro.handle(a, { ...batch, from: 1 } as any);
  assert.equal(h.sent.at(-1)?.msg.t, 'retro_session');
  h.sent.length = 0; h.retro.handle(a, structuredClone(batch) as any); assert.equal(h.sent.length, 0);
  h.retro.handle(a, { ...batch, sync: 1, changes: [] } as any); // no explicit change after resync
  assert.equal(h.sent.at(-1)?.msg.t, 'retro_session');
  h.sent.length = 0; h.retro.handle(a, { ...batch, sync: 2, changes: [[0, 255]] } as any);
  const relay = h.sent.find(x => x.id === 'b' && x.msg.t === 'retro_frames');
  assert.ok(relay); if (relay.msg.t === 'retro_frames') assert.deepEqual(relay.msg.changes, [[0, 240]]);
  h.retro.handover(a); const view = h.sent.at(-1)?.msg;
  assert.ok(view?.t === 'retro_session' && view.view?.kind === 'playing' && view.view.sync === 3 && view.view.upto === 6 && view.view.snapshot);
  h.retro.shutdown();
});

import { World } from './world';
import type { TileMap } from '../../shared/map';
test('World sends retro to the owner, gates other sockets, and clears the old owner on handover', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
  const w = new World(map, { wasm, roms: { tobu: rom('tobu'), lobster: rom('lobster') } });
  const u = w.addUser('Retro Owner', false, { x: 55, y: 16 }); u.presence = 'online';
  const old: ServerMsg[] = [], current: ServerMsg[] = [];
  const first = w.connect(u.id, m => old.push(m));
  await w.retro.join(u, map.objects.find(o => o.use?.kind === 'retro')!.id);
  const second = w.connect(u.id, m => current.push(m));
  assert.ok(old.some(m => m.t === 'retro_session' && m.view === null && m.reason === 'elsewhere'));
  const view = [...current].reverse().find(m => m.t === 'retro_session');
  assert.ok(view?.t === 'retro_session' && view.view?.kind === 'playing' && view.view.sync === 1);
  current.length = 0; w.handle(u, { t: 'retro_resync' }, first.socket); assert.equal(current.length, 0);
  w.handle(u, { t: 'retro_resync' }, second.socket);
  assert.ok(current.some(m => m.t === 'retro_session' && m.view?.kind === 'playing' && m.view.sync === 2));
  const dump = w.dump(); assert.ok(dump.retro); w.retro.shutdown(); first.close(); second.close();
});

interface Fixture {
  game: 'tobu' | 'lobster'; save: string | null; changes: [number, number][]; upto: number;
  expect: { results: { frame: number; track: string; score: number; time?: number }[]; hash: number; ext: string; settledExt?: string };
}
const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/retro/${name}.json`, import.meta.url), 'utf8'));
for (const name of ['l1', 'l2', 'l3c', 'h', 'lobster', 'portal-resume', 'portal-quit', 'heaven-quit', 'portal-cut', 'heaven-write-cut']) {
  test(`retro recorded inputs: ${name}, exact results/hash/cartridge and settle`, async () => {
    const f = fixture(name), h = transport(), a = h.person('a'), b = h.person('b');
    const cabinet = f.game === 'tobu' ? 't' : 'l';
    if (f.save) h.retro.load({ saves: { [f.game]: { a: f.save } }, boards: h.retro.boards() });
    await h.retro.join(a, cabinet); await h.retro.join(b, cabinet); h.sent.length = 0;
    try {
      for (let from = 0; from < f.upto; from += 100) {
        const upto = Math.min(from + 100, f.upto); h.advance(1700);
        const changes = f.changes.filter(([at]) => at >= from && at < upto);
        if (from === 0 && changes[0]?.[0] !== 0) changes.unshift([0, 0]);
        h.retro.handle(a, { t: 'retro_frames', runId: 'run1', sync: 0, from, upto, changes });
      }
      const session = h.retro.cabinets.get(cabinet)!.session!;
      assert.equal(session.upto, f.upto); assert.equal(session.gb.hash(), f.expect.hash);
      assert.equal(Buffer.from(session.gb.ext()).toString('base64'), f.expect.ext);
      const results = () => h.sent.filter(x => x.id === 'a' && x.msg.t === 'retro_result').map(x => {
        const m = x.msg as Extract<ServerMsg, { t: 'retro_result' }>;
        return { frame: m.frame, track: m.result.track, score: m.result.score, ...(m.result.time === undefined ? {} : { time: m.result.time }) };
      });
      assert.deepEqual(results(), f.expect.results.filter(r => r.frame <= f.upto));
      // Every visible result follows the frames that let its spectator reach it.
      for (const [i, x] of h.sent.entries()) if (x.id === 'b' && x.msg.t === 'retro_result') {
        const frame = x.msg.frame;
        assert.ok(h.sent.slice(0, i).some(y => y.id === 'b' && y.msg.t === 'retro_frames' && y.msg.upto >= frame));
      }
      if (name === 'heaven-write-cut') h.retro.shutdown(); else h.retro.leave(a);
      assert.deepEqual(results(), f.expect.results);
      assert.equal(h.retro.dump().saves[f.game].a, f.expect.settledExt ?? f.expect.ext);
      assert.equal(b.game?.role, 'spectator');
      assert.ok(h.sent.some(x => x.id === 'b' && x.msg.t === 'retro_session' && x.msg.view?.kind === 'vacant'));
      if (name === 'portal-cut') assert.equal(h.retro.boards().games.tobu.plains.all.a.score, 115);
      if (name === 'heaven-write-cut') assert.equal(h.retro.boards().games.tobu.heaven.all.a.score, 5);
    } finally { h.retro.shutdown(); }
  });
}
test('fixture expectations retain the approved independently verified scores and frames', () => {
  assert.deepEqual(['l1', 'l2', 'l3c', 'h'].map(n => fixture(n).expect.results), [
    [{ frame: 2681, track: 'plains', score: 115, time: 21 }], [{ frame: 3745, track: 'clouds', score: 71, time: 38 }],
    [{ frame: 4466, track: 'space', score: 61, time: 51 }], [{ frame: 6063, track: 'heaven', score: 5, time: 57 }],
  ]);
  assert.deepEqual(fixture('lobster').expect.results.map(r => r.score), [132, 141, 175, 231, 490]);
  assert.equal(fixture('portal-resume').expect.results.length, 1);
  assert.deepEqual(fixture('portal-quit').expect.results, []); assert.deepEqual(fixture('heaven-quit').expect.results, []);
});

function toy(options: { time?: number; kills?: number; writes?: number[] } = {}): Awaited<ReturnType<typeof createGb>> {
  let dirty = false, destroyed = false;
  const g = {
    frame: 0,
    step(_bits: number) { assert.equal(destroyed, false); g.frame++; dirty ||= (options.writes ?? [2]).includes(g.frame); },
    read(addr: number) {
      if (addr === 0xc0a5) return g.frame % 4 === 1 ? 4 : 6;
      if (addr === 0xc0a7) return 1;
      if (addr === 0xc0b3) return options.time ?? 20;
      if (addr === 0xc0b5) return options.kills ?? 3;
      return 0;
    },
    ext: () => new Uint8Array(8192).fill(g.frame & 255),
    takeExtWrite() { const value = dirty; dirty = false; return value; },
    state: () => new Uint8Array([g.frame & 255]), restore: (_s: Uint8Array, frame: number) => { g.frame = frame; },
    screen: () => new Uint8ClampedArray(160 * 144 * 4), audio: () => [], hash: () => g.frame,
    destroy() { destroyed = true; },
  };
  return g;
}
test('Retro boards replace only better runs, timed ties, shared ranks, rollover and sanitized persistence', async () => {
  let time = 20, kills = 3;
  const h = transport(async () => toy({ time, kills })), a = h.person('a'), b = h.person('b');
  async function run(u: PublicUser) {
    await h.retro.join(u, 't'); const s = h.retro.cabinets.get('t')!.session!;
    h.advance(100); h.retro.handle(u, { t: 'retro_frames', runId: s.runId, sync: 0, from: 0, upto: 4, changes: [[0, 0]] }); h.retro.leave(u);
  }
  await run(a); const original = h.retro.boards().games.tobu.plains.all.a; assert.equal(original.score, 111);
  await run(a); assert.deepEqual(h.retro.boards().games.tobu.plains.all.a, original);
  await run(b); const tied = h.sent.filter(x => x.id === 'b' && x.msg.t === 'retro_result').at(-1)!.msg;
  assert.ok(tied.t === 'retro_result' && tied.result.allRank === 1);
  // Same 111 points, one second quicker: shorter time wins the tie.
  time = 19; kills = 0; await run(b);
  assert.equal(h.retro.boards().games.tobu.plains.all.b.time, 19);
  time = 30; await run(a); assert.deepEqual(h.retro.boards().games.tobu.plains.all.a, original);
  const saved = h.retro.dump(), restored = transport(); restored.retro.load(saved); assert.deepEqual(restored.retro.dump(), saved);
  const before = h.broadcasts.length; h.advance(7 * 86400000); h.retro.dump();
  assert.ok(h.broadcasts.slice(before).some(m => m.t === 'retro_boards')); assert.deepEqual(h.retro.boards().games.tobu.plains.week, {});
  assert.deepEqual(h.retro.boards().games.tobu.plains.all.a, original);
  const corrupt: any = structuredClone(saved); corrupt.saves.tobu.bad = 'A'.repeat(20000); corrupt.saves.lobster.bad = 'not base64';
  corrupt.boards.games.tobu.plains.all.bad = { userId: 'bad', name: 'x', score: -1, at: 0, time: 0 };
  corrupt.boards.games.unknown = {}; corrupt.boards.games.tobu.unknown = {};
  const logs: unknown[] = [], warn = console.warn; console.warn = (...v) => logs.push(v);
  try {
    restored.retro.load(corrupt); assert.equal(logs.length, 1);
    assert.equal(restored.retro.dump().saves.tobu.bad, undefined); assert.equal(restored.retro.boards().games.tobu.plains.all.bad, undefined);
    for (const malformed of [null, 5, [], 'bad', { saves: [], boards: { games: { tobu: [] } } }]) assert.doesNotThrow(() => restored.retro.load(malformed));
  } finally { console.warn = warn; h.retro.shutdown(); restored.retro.shutdown(); }
});
test('idle and cap endings clear players, keep watchers, and timer never advances the emulator', async () => {
  const h = transport(async () => toy()), a = h.person('a'), b = h.person('b');
  await h.retro.join(a, 't'); await h.retro.join(b, 't');
  h.advance(599999); h.retro.tick(h.advance(0)); assert.equal(h.retro.cabinets.get('t')!.session!.gb.frame, 0);
  h.retro.tick(h.advance(1)); assert.equal(a.game, null); assert.equal(b.game?.role, 'spectator');
  assert.ok(h.sent.some(x => x.id === 'a' && x.msg.t === 'retro_session' && x.msg.reason === 'idle'));
  await h.retro.join(a, 't'); const s = h.retro.cabinets.get('t')!.session!; s.upto = s.gb.frame = 429999;
  h.advance(100); h.retro.handle(a, { t: 'retro_frames', runId: s.runId, sync: 0, from: s.upto, upto: 430000, changes: [[s.upto, 0]] });
  assert.ok(h.sent.some(x => x.id === 'a' && x.msg.t === 'retro_session' && x.msg.reason === 'cap')); assert.equal(a.game, null);
  h.retro.shutdown();
});
test('creation failure/cancellation, crowd limits, guards, watcher views and requested resync', async () => {
  const h = transport(async () => toy()), a = h.person('a'); await h.retro.join(a, 't');
  for (let i = 0; i < 8; i++) await h.retro.join(h.person(`w${i}`), 't');
  const ninth = h.person('ninth'); await h.retro.join(ninth, 't'); assert.equal(ninth.game, null);
  assert.ok(h.sent.some(x => x.id === 'ninth' && x.msg.t === 'notice' && x.msg.text.includes('crowded')));
  const b = h.users.get('w0')!; h.sent.length = 0; h.retro.handover(b);
  let view = h.sent.at(-1)!.msg; assert.ok(view.t === 'retro_session' && view.view?.kind === 'playing' && view.view.sync === 0);
  h.retro.leave(a); h.retro.handle(b, { t: 'retro_resync' }); view = h.sent.at(-1)!.msg;
  assert.ok(view.t === 'retro_session' && view.view?.kind === 'vacant');
  for (const [id, state] of [['bot', { bot: true }], ['instance', { instance: 'dungeon' }], ['offline', { presence: 'offline' }]] as const) {
    const u = h.person(id); Object.assign(u, state); await h.retro.join(u, 'l'); assert.equal(u.game, null);
  }
  h.retro.shutdown();
  const failed = transport(async () => { throw new Error('instantiate'); }), u = failed.person('a');
  await failed.retro.join(u, 't'); assert.equal(u.game, null); assert.equal(failed.retro.summary()[0].player, null);
  assert.ok(failed.sent.some(x => x.msg.t === 'notice' && x.msg.text === "The cabinet didn't start")); failed.retro.shutdown();
});
test('current-stream malformed batches resync; wrong run and old sync are silent', async () => {
  const h = transport(async () => toy()), a = h.person('a'); await h.retro.join(a, 't');
  const base = { t: 'retro_frames', runId: 'run1', sync: 0, from: 0, upto: 1, changes: [[0, 0]] } as const;
  h.sent.length = 0;
  for (const fields of [{ runId: 'wrong' }, { sync: -1 }]) h.retro.handle(a, { ...base, ...fields } as any);
  assert.equal(h.sent.length, 0); h.advance(10000);
  const malformed = [
    { from: -1 }, { from: 1 }, { upto: 0 }, { upto: 301 }, { upto: 2.5 }, { upto: Infinity },
    { changes: [[0, 256]] }, { changes: [[0, -1]] }, { changes: [[0, 1.5]] }, { changes: [[0, NaN]] },
    { changes: [[0, 0], [0, 1]] }, { upto: 3, changes: [[1, 0], [0, 1]] }, { changes: [[1, 0]] },
    { changes: null }, { changes: Array(301).fill([0, 0]) }, { changes: [[0]] }, { sync: '0' }, { changes: 'bad' },
  ];
  for (let sync = 0; sync < malformed.length; sync++) {
    h.sent.length = 0; h.retro.handle(a, { ...base, sync, ...malformed[sync] } as any);
    const m = h.sent.at(-1)?.msg; assert.ok(m?.t === 'retro_session' && m.view?.kind === 'playing' && m.view.sync === sync + 1);
    assert.equal(h.retro.cabinets.get('t')!.session!.upto, 0);
  }
  // Spend the capped 300 frames; a contiguous additional frame with no elapsed server time resyncs.
  const sync = malformed.length;
  h.retro.handle(a, { ...base, sync, upto: 300, changes: [[0, 0]] } as any); h.sent.length = 0;
  h.retro.handle(a, { ...base, sync, from: 300, upto: 301, changes: [] } as any);
  const m = h.sent.at(-1)?.msg; assert.ok(m?.t === 'retro_session' && m.view?.kind === 'playing' && m.view.sync === sync + 1);
  h.retro.shutdown();
});
