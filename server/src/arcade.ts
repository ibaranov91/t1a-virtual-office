import { LEVELS } from '../../shared/park/levels';
import { hashState, parkInit, parkStep, type ParkState } from '../../shared/park/sim';
import {
  PARK_INPUT_DELAY, PARK_MAX_PLAYERS, PARK_SERVER_LAG,
  type CabinetSummary, type ClientMsg, type GameClear, type GameEvent, type GameMember,
  type ParkRecords, type PublicSession, type PublicUser, type ServerMsg,
} from '../../shared/protocol';

type Gamer = Pick<PublicUser, 'id' | 'name' | 'bot' | 'game'>;
export interface Session {
  cabinet: string; epoch: number; phase: PublicSession['phase']; level: number; startAt: number;
  players: GameMember[]; spectators: string[]; events: GameEvent[]; sim: ParkState;
  teamSize: number; rosterChanged: boolean; clear?: GameClear; clearAt?: number; lastFrame: number[];
}
interface Options {
  now: () => number;
  send(userId: string, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
  user(userId: string): Gamer | undefined;
  timer?: boolean;
}
export class Arcade {
  readonly sessions = new Map<string, Session>();
  records: ParkRecords = {};
  private epochCounter = 0;
  private cheers = new Map<string, number[]>();
  constructor(private readonly api: Options) {
    if (api.timer !== false) setInterval(() => this.tick(this.api.now()), 50).unref();
  }
  summary(): CabinetSummary[] {
    return [...this.sessions.values()].map(s => ({ cabinet: s.cabinet, phase: s.phase, level: s.level,
      players: s.players.map(p => p.userId), spectators: s.spectators.length }));
  }
  private changed() { this.api.broadcast({ t: 'arcade', cabinets: this.summary() }); }
  private members(s: Session) { return [...s.players.map(p => p.userId), ...s.spectators]; }
  private send(s: Session, msg: ServerMsg) { for (const id of this.members(s)) this.api.send(id, msg); }
  private status(u: Gamer, game: PublicUser['game']) {
    u.game = game; this.api.broadcast({ t: 'game_status', userId: u.id, game });
  }
  private membership(s: Session) {
    this.send(s, { t: 'game_members', epoch: s.epoch, players: structuredClone(s.players), spectators: [...s.spectators] });
    this.changed();
  }
  session(u: Gamer): Session | undefined { return u.game ? this.sessions.get(u.game.cabinet) : undefined; }
  resend(u: Gamer) {
    const s = this.session(u);
    if (!s) return;
    const session: PublicSession = { cabinet: s.cabinet, epoch: s.epoch, phase: s.phase, level: s.level,
      startAt: s.startAt, serverNow: this.api.now(), players: s.players, spectators: s.spectators,
      teamSize: s.teamSize, clear: s.clear, snapshot: s.sim, events: s.events };
    this.api.send(u.id, { t: 'game_session', session: structuredClone(session) });
  }
  startEpoch(s: Session, level: number, startAt: number, selected = 1) {
    s.epoch = ++this.epochCounter; s.phase = level ? 'level' : 'lobby'; s.level = level; s.startAt = startAt;
    s.sim = parkInit(LEVELS[level], selected);
    s.events = [...s.players].sort((a, b) => a.slot - b.slot).map(p => [0, p.slot, 1, 0]);
    s.lastFrame = [0, 0, 0, 0]; s.clear = undefined; s.clearAt = undefined;
    s.teamSize = s.players.length; s.rosterChanged = false;
    for (const id of this.members(s)) { const u = this.api.user(id); if (u) this.resend(u); }
    this.changed();
  }
  private append(s: Session, ev: GameEvent, sender?: string, seq?: number) {
    if (ev[2] === 2 || ev[2] === 3) s.events = s.events.filter(e => !(e[1] === ev[1] && e[2] === 0 && e[0] >= ev[0]));
    s.events.push(ev);
    for (const id of this.members(s)) this.api.send(id, { t: 'game_event', epoch: s.epoch, ev: [...ev], ...(id === sender ? { seq } : {}) });
  }
  join(u: Gamer, cabinet: string) {
    if (u.bot) return;
    if (this.session(u)?.cabinet === cabinet) { this.resend(u); return; }
    this.leave(u);
    let s = this.sessions.get(cabinet);
    if (!s) {
      s = { cabinet, epoch: 0, phase: 'lobby', level: 0, startAt: 0, players: [{ userId: u.id, slot: 0 }], spectators: [],
        events: [], sim: parkInit(LEVELS[0]), teamSize: 1, rosterChanged: false, lastFrame: [0, 0, 0, 0] };
      this.sessions.set(cabinet, s); this.status(u, { cabinet, role: 'player' });
      this.startEpoch(s, 0, this.api.now(), 1); this.membership(s); return;
    }
    const player = s.phase === 'lobby' && s.players.length < PARK_MAX_PLAYERS;
    const slot = [0, 1, 2, 3].find(n => !s!.players.some(p => p.slot === n))!;
    if (player) s.players.push({ userId: u.id, slot }); else s.spectators.push(u.id);
    this.status(u, { cabinet, role: player ? 'player' : 'spectator' });
    this.resend(u);
    if (player) { s.lastFrame[slot] = s.sim.frame; this.append(s, [s.sim.frame, slot, 1, 0]); }
    this.membership(s);
  }
  leave(u: Gamer) {
    const s = this.session(u); if (!s) return;
    const p = s.players.find(p => p.userId === u.id);
    if (p) {
      this.append(s, [s.sim.frame, p.slot, 2, 0]);
      s.players = s.players.filter(p => p.userId !== u.id);
      if (s.phase === 'level') s.rosterChanged = true;
    } else s.spectators = s.spectators.filter(id => id !== u.id);
    this.status(u, null); this.cheers.delete(u.id);
    this.api.send(u.id, { t: 'game_session', session: null });
    if (!s.players.length) {
      for (const id of s.spectators) {
        const spectator = this.api.user(id); if (spectator) this.status(spectator, null);
        this.cheers.delete(id); this.api.send(id, { t: 'game_session', session: null, reason: 'empty' });
      }
      this.sessions.delete(s.cabinet); this.changed();
    } else this.membership(s);
  }
  reset(u: Gamer) {
    const s = this.session(u), p = s?.players.find(p => p.userId === u.id);
    if (s && p) { this.append(s, [s.sim.frame, p.slot, 3, 0]); s.lastFrame[p.slot] = s.sim.frame; }
  }
  handle(u: Gamer, msg: ClientMsg) {
    const s = this.session(u); if (!s) return;
    if (msg.t === 'game_leave') { this.leave(u); return; }
    if (msg.t === 'game_cheer') {
      if (![0, 1, 2].includes(msg.kind)) return;
      const now = this.api.now(), recent = (this.cheers.get(u.id) ?? []).filter(at => now - at < 1000);
      if (recent.length >= 2) return;
      this.cheers.set(u.id, [...recent, now]); this.send(s, { t: 'game_cheer', userId: u.id, kind: msg.kind }); return;
    }
    if (!('epoch' in msg) || !Number.isSafeInteger(msg.epoch) || msg.epoch !== s.epoch) return;
    if (msg.t === 'game_sync') { this.resend(u); return; }
    let p = s.players.find(p => p.userId === u.id);
    if (msg.t === 'game_play') {
      if (p || s.phase !== 'lobby' || s.players.length >= PARK_MAX_PLAYERS) return;
      const slot = [0, 1, 2, 3].find(n => !s.players.some(p => p.slot === n))!;
      p = { userId: u.id, slot }; s.players.push(p); s.spectators = s.spectators.filter(id => id !== u.id);
      s.lastFrame[slot] = s.sim.frame; this.status(u, { cabinet: s.cabinet, role: 'player' });
      this.append(s, [s.sim.frame, slot, 1, 0]); this.membership(s); return;
    }
    if (!p) return;
    if (msg.t === 'game_input') {
      if (!Number.isSafeInteger(msg.frame) || !Number.isSafeInteger(msg.seq) || typeof msg.bits !== 'number' || !Number.isFinite(msg.bits)) return;
      const at = Math.floor((this.api.now() - s.startAt) * 60 / 1000);
      let frame = msg.frame;
      if (frame > at + 60) frame = Math.max(at, 0) + PARK_INPUT_DELAY;
      frame = Math.max(frame, s.sim.frame, s.lastFrame[p.slot]); s.lastFrame[p.slot] = frame;
      this.append(s, [frame, p.slot, 0, msg.bits & 7], u.id, msg.seq);
    } else if (msg.t === 'game_menu' && s.phase === 'level') {
      if (msg.op === 'lobby') this.startEpoch(s, 0, this.api.now(), s.level);
      else if (msg.op === 'restart') this.startEpoch(s, s.level, this.api.now() + 3000);
    }
  }
  tick(now: number) {
    for (const s of this.sessions.values()) {
      if (s.phase === 'clear' && now - s.clearAt! >= 4000) { this.startEpoch(s, 0, now, Math.min(s.level + 1, 8)); continue; }
      while (s.sim.frame <= Math.floor((now - s.startAt) * 60 / 1000) - PARK_SERVER_LAG) {
        const epoch = s.epoch;
        parkStep(s.sim, LEVELS[s.level], s.events.filter(e => e[0] === s.sim.frame));
        s.events = s.events.filter(e => e[0] >= s.sim.frame);
        if (s.sim.frame % 60 === 0) this.send(s, { t: 'game_check', epoch, frame: s.sim.frame, hash: hashState(s.sim), serverNow: now });
        if (s.phase === 'lobby' && s.sim.startReady) this.startEpoch(s, s.sim.selected, now + 3000);
        else if (s.phase === 'level' && s.sim.cleared) {
          s.phase = 'clear'; s.clearAt = now;
          const frames = s.sim.clearedAt, coins = s.sim.coins, team = s.teamSize as 1 | 2 | 3 | 4;
          const old = this.records[s.level]?.[team];
          const record = !s.rosterChanged && (!old || frames < old.frames || (frames === old.frames && coins > old.coins));
          if (record) {
            (this.records[s.level] ??= {})[team] = { frames, coins, names: [...s.players].sort((a, b) => a.slot - b.slot).map(p => this.api.user(p.userId)?.name ?? ''), at: now };
            this.api.broadcast({ t: 'arcade_records', records: structuredClone(this.records) });
          }
          s.clear = { frames, coins, record }; this.send(s, { t: 'game_clear', epoch, ...s.clear }); this.changed();
        }
        if (s.epoch !== epoch) break;
      }
    }
  }
  dump() { return { records: structuredClone(this.records) }; }
  load(saved: unknown) {
    this.records = {};
    if (!saved || typeof saved !== 'object' || !('records' in saved) || !saved.records || typeof saved.records !== 'object') return;
    for (let level = 1; level <= 8; level++) for (const team of [1, 2, 3, 4] as const) {
      const r = (saved.records as ParkRecords)[level]?.[team];
      if (!r || !Number.isSafeInteger(r.frames) || r.frames < 0 || !Number.isSafeInteger(r.coins) || r.coins < 0 || !Number.isFinite(r.at)
        || !Array.isArray(r.names) || r.names.length !== team || !r.names.every(n => typeof n === 'string')) continue;
      (this.records[level] ??= {})[team] = structuredClone(r);
    }
  }
}
