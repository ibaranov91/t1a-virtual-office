import { hash as hashState } from './hash';
import { gameDef } from './registry';
import { type AnyGameDef, type BaseState, type Fx, type GameId } from './types';
import { PARK_INPUT_DELAY, PARK_SPECTATOR_DELAY, type GameEvent, type ArcadeIncoming, type ArcadeOutgoing, type PublicSession } from './types';

interface Logged { ev: GameEvent; seq?: number }
export interface RunnerOptions {
  userId: string; transport: { send(msg: ArcadeOutgoing): void }; now: () => number; games?: Partial<Record<GameId, AnyGameDef>>;
}
export class Runner<S extends BaseState = BaseState> {
  state: S | null = null;
  session: PublicSession<S> | null = null;
  reason?: 'empty' | 'elsewhere';
  readonly debug = { frame: 0, desyncs: 0, rollbacks: 0, maxRollback: 0, syncs: 0, checks: 0 };
  private samples: { at: number; offset: number }[] = [];
  private offset = 0;
  private clockReady = false;
  private log: Logged[] = [];
  private base: S | null = null;
  private history = new Map<number, S>();
  private hashes = new Map<number, number>();
  private checks: { frame: number; hash: number }[] = [];
  private played = new Set<string>();
  private effects: Fx[] = [];
  private seq = 0;
  private bits = 0;
  private sampled: number | null = null;
  private syncing = false;
  private replayTo = 0;
  private pending: { session: PublicSession<S>; at: number; messages: ArcadeIncoming[] } | null = null;
  constructor(private readonly options: RunnerOptions) {}
  private definition() { const id = this.session!.view; if (id.kind !== 'sim') throw new Error('Screen has no game'); return this.options.games?.[id.game] ?? gameDef(id.game); }
  get serverNow() { return this.options.now() + this.offset; }
  get slot(): number | undefined { return this.session?.players.find(p => p.userId === this.options.userId)?.slot; }
  get provisionalCount(): number { return this.log.filter(e => e.seq !== undefined).length; }
  get targetFrame(): number {
    const view = this.session?.view; if (!view || view.kind !== 'sim') return -1;
    return Math.floor((this.serverNow - view.startAt) * 60 / 1000) - (this.slot === undefined ? PARK_SPECTATOR_DELAY : 0);
  }
  get presentation() {
    const view = this.session?.view;
    const joining = this.slot === undefined && !!this.state && this.state.frame > this.targetFrame;
    return { state: joining ? null : this.state, joining,
      countdown: view?.kind === 'sim' ? Math.max(0, Math.ceil((view.startAt - this.serverNow) / 1000)) : 0 };
  }
  setLocalBits(bits: number): void { this.bits = bits & 63; }
  drainFx(): Fx[] { const result = this.effects; this.effects = []; return result; }
  stateAt(frame: number): S | undefined { const s = this.history.get(frame); return s && structuredClone(s); }
  private sample(serverNow: number): void {
    const now = this.options.now();
    this.samples.push({ at: now, offset: serverNow - now });
    this.samples = this.samples.filter(s => now - s.at <= 10000);
    if (!this.clockReady) { this.offset = serverNow - now; this.clockReady = true; }
  }
  private requestSync(): void {
    if (!this.session || this.syncing) return;
    this.syncing = true; this.debug.syncs++;
    this.options.transport.send({ t: 'game_sync', epoch: this.session.epoch });
  }
  private insert(ev: GameEvent, seq?: number): void {
    if (ev[2] === 2 || ev[2] === 3) {
      this.log = this.log.filter(e => !(e.ev[1] === ev[1] && e.ev[2] === 0 && e.ev[0] >= ev[0]));
    }
    this.log.push({ ev: [...ev], seq });
  }
  private apply(session: PublicSession<S>): void {
    const changed = this.session?.epoch !== session.epoch;
    this.session = structuredClone(session);
    const view = session.view;
    this.state = view.kind === 'sim' ? structuredClone(view.snapshot) : null; this.base = this.state && structuredClone(this.state);
    this.log = []; if (view.kind === 'sim') for (const ev of view.events) this.insert(ev);
    this.history.clear(); this.hashes.clear(); this.checks = []; this.effects = [];
    if (changed) this.played.clear();
    if (this.state) { this.history.set(this.state.frame, structuredClone(this.state)); this.hashes.set(this.state.frame, hashState(this.state)); }
    this.syncing = false; this.replayTo = this.state?.frame ?? 0; this.sampled = null;
    this.debug.frame = this.state?.frame ?? 0;
  }
  receive(msg: ArcadeIncoming): void {
    if (msg.t === 'game_session') {
      if (!msg.session) {
        this.session = null; this.state = null; this.base = null; this.pending = null; this.log = [];
        this.effects = []; this.reason = msg.reason; this.debug.frame = 0; return;
      }
      this.sample(msg.session.serverNow);
      const next = msg.session as PublicSession<S>;
      if (this.session && this.session.epoch !== next.epoch) {
        // FIFO puts every accepted echo before the terminal check/new epoch. Anything still provisional was
        // overtaken by the epoch boundary and will never be echoed; remove it before verifying the final hash.
        const own = this.log.filter(e => e.seq !== undefined);
        if (own.length) {
          this.log = this.log.filter(e => e.seq === undefined);
          const from = Math.min(...own.map(e => e.ev[0]));
          if (this.state && from < this.state.frame) this.rollback(from);
        }
      }
      const spectator = !msg.session.players.some(p => p.userId === this.options.userId);
      if (this.pending?.session.epoch === next.epoch && !this.syncing) { this.pending.session = structuredClone(next); this.pending.messages = []; return; }
      if (!this.syncing && ((spectator && (this.session ? this.session.epoch !== next.epoch : next.view.kind === 'screen')) || this.session && this.session.epoch !== next.epoch && this.checks.length > 0)) {
        this.pending = { session: structuredClone(next), at: this.options.now() + (spectator ? 150 : 0), messages: [] }; return;
      }
      this.pending = null; this.reason = undefined; this.apply(next); return;
    }
    if (this.pending && msg.epoch === this.pending.session.epoch) { this.pending.messages.push(structuredClone(msg)); return; }
    if (!this.session || msg.epoch !== this.session.epoch) return;
    if (msg.t === 'game_members') {
      this.session.players = structuredClone(msg.players); this.session.spectators = [...msg.spectators]; this.sampled = null;
    } else if (msg.t === 'game_clear') { /* standalone clear arrives before its scores screen */ }
    else if (msg.t === 'game_check') { this.sample(msg.serverNow); this.checks.push({ frame: msg.frame, hash: msg.hash }); }
    else {
      if (!this.state) return;
      let from = msg.ev[0];
      if (msg.seq !== undefined) {
        const own = this.log.find(e => e.seq === msg.seq);
        if (own) { from = Math.min(from, own.ev[0]); this.log = this.log.filter(e => e !== own); }
      }
      this.insert(msg.ev);
      if (from < this.state.frame) this.rollback(from);
    }
    this.check();
  }
  private rollback(from: number): void {
    if (!this.state || !this.base) return;
    const old = Math.max(this.state.frame, this.replayTo), saved = this.history.get(from) ?? this.base;
    if (from < saved.frame) { this.requestSync(); return; }
    this.debug.rollbacks++; this.debug.maxRollback = Math.max(this.debug.maxRollback, old - from);
    this.state = structuredClone(saved); this.replayTo = old;
    for (const f of this.history.keys()) if (f > saved.frame) this.history.delete(f);
    for (const f of this.hashes.keys()) if (f > saved.frame) this.hashes.delete(f);
  }
  private localInput(): void {
    if (!this.session || !this.state || this.slot === undefined || this.pending && this.pending.session.epoch !== this.session.epoch) return;
    if (this.sampled === null) {
      let bits = this.definition().bits(this.state, this.slot);
      for (const e of this.log) if (e.ev[1] === this.slot) {
        if (e.ev[2] === 0) bits = e.ev[3]; else bits = 0;
      }
      this.sampled = bits;
    }
    if (this.sampled === this.bits) return;
    this.sampled = this.bits;
    const seq = ++this.seq, frame = Math.max(this.state.frame, 0) + PARK_INPUT_DELAY;
    this.insert([frame, this.slot, 0, this.bits], seq);
    this.options.transport.send({ t: 'game_input', epoch: this.session.epoch, seq, frame, bits: this.bits });
  }
  private check(): void {
    if (!this.state) return;
    this.checks = this.checks.filter(c => {
      if (c.frame > this.state!.frame || this.log.some(e => e.seq !== undefined && e.ev[0] < c.frame)) return true;
      const hash = this.hashes.get(c.frame);
      if (hash !== c.hash) { this.debug.desyncs++; this.requestSync(); } else this.debug.checks++;
      return false;
    });
  }
  tick(): void {
    const now = this.options.now();
    this.samples = this.samples.filter(s => now - s.at <= 10000);
    if (this.samples.length) {
      const desired = Math.max(...this.samples.map(s => s.offset)), delta = desired - this.offset;
      this.offset += Math.abs(delta) > 250 ? delta : Math.max(-2, Math.min(2, delta));
    }
    if (this.pending && now >= this.pending.at && this.checks.length === 0 && !this.syncing) {
      const pending = this.pending; this.pending = null; this.apply(pending.session);
      for (const msg of pending.messages) this.receive(msg);
    }
    if (!this.state || !this.session) return;
    this.localInput();
    const target = this.targetFrame;
    if (target - this.state.frame > 300) this.requestSync();
    const end = Math.max(target, this.replayTo), start = this.options.now();
    let steps = 0;
    while (this.state && this.state.frame < end && (steps < 20 || this.options.now() - start < 8)) {
      const s = this.state;
      this.definition().step(s, this.log.filter(e => e.ev[0] === s.frame).map(e => e.ev));
      this.history.set(s.frame, structuredClone(s));
      this.hashes.set(s.frame, hashState(s));
      for (const f of this.history.keys()) if (f < s.frame - 180) this.history.delete(f);
      for (const f of this.hashes.keys()) if (f < s.frame - 600) this.hashes.delete(f);
      for (const fx of s.fx) {
        const key = `${fx.frame}:${fx.kind}:${fx.slot}`;
        if (!this.played.has(key)) { this.played.add(key); this.effects.push({ ...fx }); }
      }
      steps++;
    }
    this.replayTo = 0; this.debug.frame = this.state.frame; this.check();
  }
}
