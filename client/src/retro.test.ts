import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { RetroPlayer, type FrameBatch } from './retro/player';
import { RetroWatcher } from './retro/watcher';
import { createGb, type Gb } from '../../shared/retro/gb';
import type { Store } from './net';
import type { RetroView } from '../../shared/protocol';
function fake(frame = 0) {
  const inputs: number[] = [];
  const gb = { frame, step(bits: number) { inputs.push(bits); gb.frame++; } } as Gb;
  return { gb, inputs };
}
test('retro player records normalized changes at the pre-step frame and flushes contiguous batches', () => {
  const { gb, inputs } = fake(42), batches: FrameBatch[] = [];
  const player = new RetroPlayer(gb, 'run', 3, b => batches.push(b));
  player.tick(0, () => 0); player.tick(101, frame => frame < 44 ? 3 : 16);
  assert.equal(gb.frame, 46); assert.deepEqual(inputs, [0, 0, 16, 16]);
  assert.deepEqual(batches, [{ t: 'retro_frames', runId: 'run', sync: 3, from: 42, upto: 46, changes: [[42, 0], [44, 16]] }]);
  player.tick(120, () => 16); player.flush();
  assert.equal(batches[1].from, 46); assert.equal(batches[1].upto, 47); assert.deepEqual(batches[1].changes, []);
  player.flush(); assert.equal(batches.length, 2);
});
test('retro player drops lag above four steps and resets time on pause', () => {
  const { gb } = fake(), batches: FrameBatch[] = [], player = new RetroPlayer(gb, 'a', 0, b => batches.push(b));
  player.tick(0, () => 1); player.tick(10000, () => 1); assert.equal(gb.frame, 4);
  player.tick(10001, () => 1); assert.equal(gb.frame, 4);
  player.pause(); player.tick(90000, () => 1); assert.equal(gb.frame, 4);
  player.tick(90020, () => 1); assert.equal(gb.frame, 5);
});
test('each new player stream starts with explicit input even when the held bits are neutral', () => {
  const { gb } = fake(50), batches: FrameBatch[] = [];
  for (const sync of [0, 1]) {
    const player = new RetroPlayer(gb, 'run', sync, b => batches.push(b));
    player.tick(0, () => 0); player.tick(20, () => 0); player.flush();
  }
  assert.deepEqual(batches.map(b => [b.sync, b.from, b.changes]), [[0, 50, [[50, 0]]], [1, 51, [[51, 0]]]]);
});
test('retro watcher buffers fifteen frames then drains after 250 ms without exceeding confirmation', () => {
  const { gb, inputs } = fake(), watcher = new RetroWatcher(gb, 0, 0);
  watcher.receive({ t: 'retro_frames', runId: 'r', from: 0, upto: 20, changes: [[0, 1], [3, 16]] }, 0);
  watcher.tick(0); watcher.tick(200); assert.equal(gb.frame, 5);
  watcher.tick(251); assert.equal(gb.frame, 8);
  watcher.tick(1000); assert.equal(gb.frame, 20);
  watcher.tick(2000); assert.equal(gb.frame, 20);
  assert.deepEqual(inputs.slice(0, 5), [1, 1, 1, 16, 16]);
});
test('retro watcher fast forwards at most 600 frames and a vacancy drains the final buffer', () => {
  const { gb } = fake(), watcher = new RetroWatcher(gb, 0, 0);
  watcher.receive({ t: 'retro_frames', runId: 'r', from: 0, upto: 1000, changes: [[0, 32], [600, 0]] }, 0);
  assert.deepEqual(watcher.tick(0), { count: 600, fast: true });
  assert.equal(watcher.tick(16).count, 385); assert.equal(gb.frame, 985);
  watcher.draining = true; watcher.tick(300); assert.equal(gb.frame, 1000);
});
test('retro watcher rejects a stream gap, ignores duplicate batches and preserves snapshot-held bits', () => {
  const { gb, inputs } = fake(100), watcher = new RetroWatcher(gb, 16, 0);
  assert.throws(() => watcher.receive({ t: 'retro_frames', runId: 'r', from: 101, upto: 110, changes: [] }, 0));
  const batch = { t: 'retro_frames' as const, runId: 'r', from: 100, upto: 102, changes: [] };
  watcher.receive(batch, 0); watcher.receive(batch, 10); watcher.tick(0); watcher.tick(300);
  assert.deepEqual(inputs, [16, 16]); assert.equal(gb.frame, 102);
});
test('real player batches replay identically in a watcher, including a snapshot restore', async () => {
  const root = new URL('../../', import.meta.url);
  const [wasm, rom] = await Promise.all([readFile(new URL('client/public/retro/binjgb.wasm', root)), readFile(new URL('client/public/retro/shocklobster.gb', root))]);
  const playerGb = await createGb({ wasm, rom, save: null, audioRate: 44100, audio: true });
  const watcherGb = await createGb({ wasm, rom, save: null, audioRate: 48000, audio: true });
  try {
    const watcher = new RetroWatcher(watcherGb, 0, 0), batches: FrameBatch[] = [];
    const player = new RetroPlayer(playerGb, 'fixture', 2, b => { batches.push(b); watcher.receive(b, 0); });
    const fixture = JSON.parse(await readFile(new URL('server/src/fixtures/retro/lobster.json', root), 'utf8')) as { changes: [number, number][]; upto: number; expect: { hash: number } };
    let at = 0, bits = 0;
    const sample = (frame: number) => { while (at < fixture.changes.length && fixture.changes[at][0] <= frame) bits = fixture.changes[at++][1]; return bits; };
    player.tick(0, sample);
    for (let now = 1; playerGb.frame < fixture.upto; now++) player.tick(now, sample);
    assert.equal(playerGb.hash(), fixture.expect.hash);
    player.flush(); watcher.draining = true;
    let clock = 0;
    while (watcherGb.frame < playerGb.frame) { watcher.tick(clock); clock += 17; }
    assert.equal(watcherGb.hash(), playerGb.hash()); assert.equal(batches[0].changes[0][0], 0);
    const state = playerGb.state(); watcherGb.restore(state, playerGb.frame);
    for (let i = 0; i < 100; i++) { playerGb.step(0); watcherGb.step(0); }
    assert.equal(watcherGb.hash(), playerGb.hash());
  } finally { playerGb.destroy(); watcherGb.destroy(); }
});

test('retro controller queues loading frames, delays watcher results and vacancy, and discards replaced streams', async t => {
  const root = new URL('../../', import.meta.url);
  let release!: () => void;
  const downloads = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', (async (url: string) => {
    await downloads;
    return new Response(await readFile(new URL(`client/public${url}`, root)));
  }) as typeof fetch);
  const oldContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext'), oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {} } });
  const sources: { startAt?: number; stops: number; disconnected: boolean; buffer: AudioBuffer | null }[] = [];
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class {
    sampleRate = 48000; currentTime = 5; state = 'running'; addEventListener() {}
    createBuffer(channels: number, frames: number, rate: number) { const data = Array.from({ length: channels }, () => new Float32Array(frames)); return { duration: frames / rate, getChannelData: (i: number) => data[i] }; }
    createBufferSource() {
      const node = { buffer: null as AudioBuffer | null, stops: 0, disconnected: false, startAt: undefined as number | undefined,
        onended: null as (() => void) | null, connect() {}, disconnect() { node.disconnected = true; }, start(at: number) { node.startAt = at; }, stop() { node.stops++; } };
      sources.push(node); return node;
    }
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, hasFocus: () => true } });
  t.after(() => {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldContext) Object.defineProperty(globalThis, 'AudioContext', oldContext); else Reflect.deleteProperty(globalThis, 'AudioContext');
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  });
  let changed = () => {};
  const sent: unknown[] = [];
  const store = { connected: true, changed: () => changed(), name: () => 'Ivan', send: (m: unknown) => sent.push(m), retroFrames: (m: unknown) => sent.push(m), retroResync: () => sent.push('resync') } as unknown as Store;
  const { RetroClient } = await import('./retro/client');
  const { RetroAudio } = await import('./retro/audio');
  await t.test('audio converts interleaved unsigned samples and stops scheduled nodes without changing the shared context', () => {
    const sound = new RetroAudio(() => ({} as AudioNode));
    sound.play([new Uint8Array([0, 255, 128, 128])]);
    assert.deepEqual([...sources[0].buffer!.getChannelData(0)], [-1, 0]);
    assert.deepEqual([...sources[0].buffer!.getChannelData(1)], [127 / 128, 0]);
    assert.equal(sources[0].startAt, 5.1);
    sound.stop(); assert.equal(sources[0].stops, 1); assert.equal(sources[0].disconnected, true);
    sound.play([new Uint8Array([128, 128])]); assert.equal(sources[1].startAt, 5.1); sound.stop();
  });
  const client = new RetroClient(store);
  const view = { kind: 'playing', cabinet: 'cab', game: 'lobster', runId: 'old', sync: 0, player: 'ivan', role: 'spectator', save: null, snapshot: null, upto: 0, bits: 0, serverNow: 0 } satisfies RetroView;
  try {
    client.session(view);
    client.receiveFrames({ t: 'retro_frames', runId: 'old', from: 0, upto: 100, changes: [[0, 128]] });
    client.session({ ...view, runId: 'new', sync: 1 });
    client.receiveFrames({ t: 'retro_frames', runId: 'old', from: 100, upto: 110, changes: [] });
    client.receiveFrames({ t: 'retro_frames', runId: 'new', from: 0, upto: 20, changes: [[0, 0]] });
    client.receiveResult({ t: 'retro_result', runId: 'new', frame: 20, result: { game: 'lobster', track: 'medium', score: 132, best: true, weekRank: 2, allRank: 2 } });
    client.session({ kind: 'vacant', cabinet: 'cab', game: 'lobster' });
    assert.equal(client.toast, null); assert.equal(client.view?.kind, 'playing');
    const loaded = new Promise<void>(resolve => { changed = () => { if (!client.loading) resolve(); }; });
    release(); await loaded;
    assert.equal(client.watcher?.upto, 20);
    const snapshot = Buffer.from(deflateRawSync(client.gb!.state())).toString('base64');
    client.tick(0, () => 0, () => {}); client.tick(1000, () => 0, () => {});
    assert.equal(client.view?.kind, 'vacant'); assert.equal(client.gb, null);
    assert.equal(client.toast, 'Medium · 132 points · new personal best · #2 this week');
    assert.deepEqual(sent, []);
    const restored = new Promise<void>(resolve => { changed = () => { if (!client.loading) resolve(); }; });
    client.session({ ...view, runId: 'player', sync: 2, role: 'player', snapshot }); await restored;
    client.tick(0, () => 16, () => {}); client.tick(101, () => 16, () => {});
    assert.equal(client.player?.gb.frame, 4);
    assert.deepEqual((sent[0] as FrameBatch).changes, [[0, 16]]);
    client.socketLost(); client.tick(10000, () => 16, () => {}); assert.equal(client.player?.gb.frame, 4);
    assert.equal(client.reconnecting, true);
    const resumed = new Promise<void>(resolve => { changed = () => { if (!client.loading) resolve(); }; });
    client.session({ ...view, runId: 'player', sync: 3, role: 'player', snapshot }); await resumed;
    client.tick(20000, () => 0, () => {}); client.tick(20101, () => 0, () => {});
    assert.equal((sent[1] as FrameBatch).sync, 3); assert.deepEqual((sent[1] as FrameBatch).changes, [[0, 0]]);
    client.leave(); assert.deepEqual(sent.at(-1), { t: 'retro_leave' }); assert.equal(client.view, null);
  } finally { client.destroy(); }
});
