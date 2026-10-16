import { createGb, type Gb } from '../../../shared/retro/gb';
import { games } from '../../../shared/retro/games';
import type { RetroView, RetroResult, ServerMsg } from '../../../shared/protocol';
import type { Store } from '../net';
import { audio } from '../audio';
import { RetroAudio } from './audio';
import { RetroPlayer, type FrameBatch } from './player';
import { RetroWatcher } from './watcher';
const files = new Map<string, Promise<ArrayBuffer>>();
function fetchFile(url: string) {
  let file = files.get(url);
  if (!file) { file = fetch(url).then(r => { if (!r.ok) throw new Error('Retro download failed'); return r.arrayBuffer(); }); files.set(url, file); void file.catch(() => files.delete(url)); }
  return file;
}
const decode = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
type Frames = Extract<ServerMsg, { t: 'retro_frames' }>;
type Result = Extract<ServerMsg, { t: 'retro_result' }>;
export class RetroClient {
  view: RetroView | null = null;
  gb: Gb | null = null;
  player: RetroPlayer | null = null;
  watcher: RetroWatcher | null = null;
  loading = false;
  error = false;
  menu = false;
  notice: string | null = null;
  toast: string | null = null;
  departed: string | null = null;
  private generation = 0;
  private frames: { batch: Frames; at: number }[] = [];
  private results: Result[] = [];
  private sends: FrameBatch[] = [];
  private vacant: RetroView | null = null;
  private disconnected = false;
  get reconnecting() { return this.disconnected || !this.store.connected; }
  private toastTimer?: ReturnType<typeof setTimeout>;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private script: [number, number][] | null = null;
  private sound: RetroAudio;
  constructor(private store: Store) {
    this.sound = new RetroAudio(() => this.view ? store.soundscape?.retroInput(this.view.cabinet) ?? null : null);
    if (import.meta.env?.DEV && typeof window !== 'undefined') Object.assign(window, { __retro: {
      client: this, hash: () => this.gb?.hash() ?? null, frame: () => this.gb?.frame ?? null,
      feed: (changes: [number, number][] | null) => { this.script = changes; },
    } });
  }
  private teardown() {
    this.generation++; this.sound.stop(); this.gb?.destroy(); this.gb = null; this.player = null; this.watcher = null;
    this.frames = []; this.results = []; this.sends = []; this.vacant = null; this.loading = false; this.error = false;
  }
  session(view: RetroView | null, reason?: Extract<ServerMsg, { t: 'retro_session' }>['reason']) {
    clearTimeout(this.noticeTimer); this.notice = null;
    if (view?.kind === 'vacant' && view.cabinet === this.view?.cabinet && this.view?.kind === 'playing' && this.view.role === 'spectator' && !this.error) {
      this.departed = this.store.name(this.view.player); this.vacant = view;
      if (this.watcher) this.watcher.draining = true;
      return;
    }
    if (view?.kind === 'playing' || view?.cabinet !== this.view?.cabinet) this.departed = null;
    // A result committed as the session ended (settle) must not vanish with the overlay: hand it to the office toasts.
    for (const r of this.results) this.showResult(r.result);
    if (!view && this.toast) this.store.toast({ kind: 'info', text: this.toast, expires: 4000 });
    this.teardown(); this.view = view; this.menu = false; this.disconnected = !this.store.connected;
    clearTimeout(this.toastTimer); this.toast = null;
    if (!view && (reason === 'idle' || reason === 'cap')) {
      this.notice = reason === 'cap' ? 'Time for a break' : 'The cabinet closed after 10 minutes without a button change';
      // Retain the shell briefly so the notice is visible while the office is inert.
      this.view = this.lastView;
      this.noticeTimer = setTimeout(() => { this.view = null; this.notice = null; this.store.changed(); }, 4000);
    }
    if (view) this.lastView = view;
    if (view?.kind === 'playing') { this.loading = true; void this.load(view, this.generation); }
  }
  private lastView: RetroView | null = null;
  private async load(view: Extract<RetroView, { kind: 'playing' }>, gen: number) {
    let gb: Gb | null = null;
    try {
      const [wasm, rom] = await Promise.all([fetchFile('/retro/binjgb.wasm'), fetchFile(`/retro/${games[view.game].rom}`)]);
      if (gen !== this.generation) return;
      gb = await createGb({ wasm, rom: new Uint8Array(rom), save: view.save ? decode(view.save) : null, audioRate: audio().sampleRate, audio: true });
      if (gen !== this.generation) { gb.destroy(); return; }
      if (view.snapshot) {
        const stream = new Blob([decode(view.snapshot)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const state = new Uint8Array(await new Response(stream).arrayBuffer());
        if (gen !== this.generation) { gb.destroy(); return; }
        gb.restore(state, view.upto);
      }
      this.gb = gb; this.loading = false;
      if (view.role === 'player') this.player = new RetroPlayer(gb, view.runId, view.sync, batch => this.enqueue(batch));
      else {
        this.watcher = new RetroWatcher(gb, view.bits, performance.now());
        for (const { batch, at } of this.frames) this.watcher.receive(batch, at);
        this.frames = []; this.watcher.draining = !!this.vacant;
      }
      this.store.changed();
    } catch {
      gb?.destroy();
      if (gen !== this.generation) return;
      this.gb = null; this.player = null; this.watcher = null; this.sound.stop(); this.loading = false; this.error = true; this.store.changed();
    }
  }
  private enqueue(batch: FrameBatch) {
    this.sends.push(batch);
    while (this.sends.length && this.store.connected && !this.disconnected) {
      const next = this.sends.shift()!, v = this.view;
      if (v?.kind === 'playing' && v.runId === next.runId && v.sync === next.sync) this.store.retroFrames(next);
    }
  }
  receiveFrames(batch: Frames) {
    if (this.view?.kind !== 'playing' || this.view.runId !== batch.runId || this.view.role !== 'spectator') return;
    if (this.loading) this.frames.push({ batch, at: performance.now() });
    else try { this.watcher?.receive(batch, performance.now()); } catch { this.store.retroResync(); }
  }
  receiveResult(result: Result) {
    if (this.view?.kind !== 'playing' || this.view.runId !== result.runId) return;
    if (this.view.role === 'player') this.showResult(result.result);
    else this.results.push(result);
  }
  private showResult(result: RetroResult) {
    const track = games[result.game].tracks.find(t => t.id === result.track)!;
    this.toast = `${track.label} · ${result.score} ${track.unit}${result.best ? ' · new personal best' : ''} · #${result.weekRank} this week`;
    clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => { this.toast = null; this.store.changed(); }, 4000); this.store.changed();
  }
  socketLost() { this.disconnected = true; this.pause(); }
  pause() {
    // Send what was played before the pause, so the server (results) and watchers aren't left a few frames behind.
    if (this.store.connected && !this.disconnected) this.player?.flush();
    this.player?.pause(); this.watcher?.pause(); this.sound.stop(); this.gb?.audio();
  }
  setMenu(open: boolean) { this.menu = open; if (open) this.pause(); this.store.changed(); }
  tick(now: number, sample: () => number, draw: (gb: Gb) => void) {
    if (!this.gb || this.loading || this.error || this.notice) return;
    if (this.menu || document.hidden || !document.hasFocus() || !this.store.connected || this.disconnected) { this.pause(); return; }
    let count = 0, fast = false;
    if (this.player) count = this.player.tick(now, frame => {
      if (!this.script) return sample();
      let bits = 0; for (const change of this.script) { if (change[0] > frame) break; bits = change[1]; } return bits;
    });
    if (this.watcher) ({ count, fast } = this.watcher.tick(now));
    if (fast) { this.sound.stop(); this.gb.audio(); }
    else { this.sound.play(this.gb.audio()); if (count) draw(this.gb); }
    while (this.results.length && this.results[0].frame <= this.gb.frame) this.showResult(this.results.shift()!.result);
    if (this.vacant && this.watcher && this.gb.frame >= this.watcher.upto) {
      // Results the server confirmed while settling lie past the last relayed frame: show them now.
      for (const r of this.results) this.showResult(r.result);
      const vacant = this.vacant; this.teardown(); this.view = vacant; this.store.changed();
    }
  }
  destroy() {
    this.teardown(); clearTimeout(this.toastTimer); clearTimeout(this.noticeTimer); this.view = null;
    if (import.meta.env?.DEV && typeof window !== 'undefined') {
      const dev = window as unknown as { __retro?: { client: RetroClient } };
      if (dev.__retro?.client === this) delete dev.__retro;
    }
  }
  leave() { if (this.store.connected && !this.disconnected) this.player?.flush(); this.store.send({ t: 'retro_leave' }); this.session(null); this.store.changed(); }
}
