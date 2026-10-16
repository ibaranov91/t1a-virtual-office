import { randomBytes, randomUUID } from 'node:crypto';
import { gameDef, eligible } from '../../shared/arcade/registry';
import { hash } from '../../shared/arcade/hash';
import { ballot } from '../../shared/arcade/ballot';
import { awards } from '../../shared/arcade/awards';
import { BONUS_POOL, bonusStar, favouriteWinners, scoreRound, standings } from '../../shared/arcade/scoring';
import { autoName, balanceTeams, crewKey, crewName } from '../../shared/arcade/names';
import { shuffle } from '../../shared/arcade/rng';
import { emptyWeek, rollover, weekKey, weeklyTotal } from '../../shared/arcade/weeks';
import type { HubState } from '../../shared/arcade/hub';
import type { ParkGameState } from '../../shared/arcade/games/park';
import type { VoteOptions } from '../../shared/arcade/vote';
import { PARK_INPUT_DELAY, PARK_MAX_PLAYERS, PARK_SERVER_LAG, type ArcadeBoards, type BaseState, type BreakSet, type GameId,
  type GameEvent, type GameMember, type GameClear, type PublicSession, type RosterEntry, type ScreenData, type ScreenView, type SessionView, type ParkRecords } from '../../shared/arcade/types';
import type { CabinetSummary, ClientMsg, PublicUser, ServerMsg } from '../../shared/protocol';

type Gamer = Pick<PublicUser, 'id' | 'name' | 'bot' | 'game'>;
export interface Session<S extends BaseState = BaseState> {
  cabinet: string; epoch: number; phase: CabinetSummary['phase']; level: number; startAt: number;
  players: GameMember[]; spectators: string[]; events: GameEvent[]; sim: S; game: GameId; seed: number; opts: unknown; roster: RosterEntry[];
  screen: ScreenView | null; set: BreakSet | null; crew: { key: string; name: string }; crewBumps: number;
  teamSize: number; rosterChanged: boolean; clear?: GameClear; lastFrame: number[];
}
interface Options {
  now: () => number; send(userId: string, msg: ServerMsg): void; broadcast(msg: ServerMsg): void;
  user(userId: string): Gamer | undefined; timer?: boolean; seed?: () => number; id?: () => string;
}
export class Arcade {
  readonly sessions = new Map<string, Session>();
  records: ParkRecords = {};
  crews: Record<string, string> = {};
  private board: ArcadeBoards;
  private committed: string[] = [];
  private rerolls = new Map<string, number>();
  private epochCounter = 0;
  private cheers = new Map<string, number[]>();
  constructor(private readonly api: Options) {
    this.board = { records: this.records, week: emptyWeek(weekKey(api.now())), hall: [] };
    if (api.timer !== false) setInterval(() => this.tick(this.api.now()), 50).unref();
  }
  private seed() { return this.api.seed?.() ?? randomBytes(4).readUInt32LE(); }
  private rollover() { this.board.records = this.records; if (rollover(this.board, this.api.now())) this.committed = []; }
  boards(): ArcadeBoards { this.rollover(); return structuredClone(this.board); }
  private publishBoards() { this.api.broadcast({ t: 'arcade_boards', boards: this.boards() }); }
  summary(): CabinetSummary[] {
    return [...this.sessions.values()].map(s => ({ cabinet: s.cabinet, phase: s.phase, level: s.level, game: s.game,
      round: s.set?.round, players: s.players.map(p => p.userId), spectators: s.spectators.length }));
  }
  private changed() { this.api.broadcast({ t: 'arcade', cabinets: this.summary() }); }
  private members(s: Session) { return [...s.players.map(p => p.userId), ...s.spectators]; }
  private send(s: Session, msg: ServerMsg) { for (const id of this.members(s)) this.api.send(id, msg); }
  private status(u: Gamer, game: PublicUser['game']) { u.game = game; this.api.broadcast({ t: 'game_status', userId: u.id, game }); }
  private crew(s: Session) {
    if (s.set) { s.crew = { ...s.set.crew }; return; }
    const key = crewKey(s.players.map(p => p.userId));
    s.crew = { key, name: this.crews[key] ??= autoName(key, this.rerolls.get(key) ?? 0) };
  }
  private membership(s: Session) {
    this.crew(s);
    this.send(s, { t: 'game_members', epoch: s.epoch, players: structuredClone(s.players), spectators: [...s.spectators] });
    this.resendAll(s); this.changed();
  }
  session<S extends BaseState = BaseState>(u: Gamer): Session<S> | undefined { return (u.game ? this.sessions.get(u.game.cabinet) : undefined) as Session<S> | undefined; }
  private view(s: Session): SessionView {
    return s.screen ?? { kind: 'sim', game: s.game, seed: s.seed, opts: s.opts, roster: s.roster, startAt: s.startAt, snapshot: s.sim, events: s.events };
  }
  resend(u: Gamer) {
    const s = this.session(u); if (!s) return;
    const set = s.set;
    const session: PublicSession = { cabinet: s.cabinet, epoch: s.epoch, serverNow: this.api.now(), players: s.players, spectators: s.spectators, crew: s.crew,
      view: this.view(s), set: set ? { id: set.id, round: set.round, mode: set.mode, players: set.players, points: set.points,
        rounds: set.rounds.map(({ game, order, points, underdog, final }) => ({ game, order, points, underdog, final })) } : null };
    this.api.send(u.id, { t: 'game_session', session: structuredClone(session) });
  }
  private resendAll(s: Session) { for (const id of this.members(s)) { const u = this.api.user(id); if (u) this.resend(u); } }
  private startSim(s: Session, game: GameId, opts: unknown, startAt: number) {
    s.epoch = ++this.epochCounter; s.game = game; s.opts = opts; s.seed = this.seed(); s.screen = null; s.startAt = startAt;
    s.roster = [...s.players].sort((a, b) => a.slot - b.slot).map(p => ({ ...p, team: s.set?.mode === '2v2' ? s.set.players.find(q => q.userId === p.userId)!.team : null }));
    s.sim = gameDef(game).init(s.seed, s.roster, opts); s.events = s.roster.map(p => [0, p.slot, 1, 0]);
    s.lastFrame = [0, 0, 0, 0]; s.clear = undefined; s.teamSize = s.players.length; s.rosterChanged = false; s.crewBumps = 0;
    s.phase = s.set ? 'set' : game === 'hub' ? 'lobby' : 'level'; this.crew(s); this.resendAll(s); this.changed();
  }
  /** Standalone co-op entry, retained for the replay harness and restart/lobby menu. */
  startEpoch(s: Session, level: number, startAt: number, selected = 1) {
    this.startSim(s, level ? 'park' : 'hub', level ? { level, card: false } : { selected }, startAt); s.level = level;
    // level is office summary metadata; the simulation opts are the authority.
    this.changed();
  }
  private screen(s: Session, screen: ScreenView['screen'], ms: number, data: ScreenData, now: number) {
    s.epoch = ++this.epochCounter; s.events = []; s.lastFrame = [0, 0, 0, 0];
    s.screen = { kind: 'screen', screen, until: now + ms, data }; s.phase = s.set ? 'set' : 'clear';
    this.resendAll(s); this.changed();
  }
  private append(s: Session, ev: GameEvent, sender?: string, seq?: number) {
    if (ev[2] === 2 || ev[2] === 3) s.events = s.events.filter(e => !(e[1] === ev[1] && e[2] === 0 && e[0] >= ev[0]));
    s.events.push(ev);
    for (const id of this.members(s)) this.api.send(id, { t: 'game_event', epoch: s.epoch, ev: [...ev], ...(id === sender ? { seq } : {}) });
  }
  join(u: Gamer, cabinet: string) {
    if (u.bot) return;
    if (this.session(u)?.cabinet === cabinet) { this.resend(u); return; }
    this.leave(u); let s = this.sessions.get(cabinet);
    if (!s) {
      s = { cabinet, epoch: 0, phase: 'lobby', level: 0, startAt: 0, game: 'hub', opts: {}, seed: 0, roster: [], screen: null, set: null,
        crew: { key: '', name: '' }, crewBumps: 0, players: [{ userId: u.id, slot: 0 }], spectators: [], events: [], sim: gameDef('hub').init(0, [], {}), teamSize: 1, rosterChanged: false, lastFrame: [0, 0, 0, 0] };
      this.sessions.set(cabinet, s); this.status(u, { cabinet, role: 'player' }); this.startEpoch(s, 0, this.api.now(), 1); this.membership(s); return;
    }
    const player = !s.set && !s.screen && s.game === 'hub' && s.players.length < PARK_MAX_PLAYERS;
    const slot = [0, 1, 2, 3].find(n => !s!.players.some(p => p.slot === n))!;
    if (player) { s.players.push({ userId: u.id, slot }); s.roster.push({ userId: u.id, slot, team: null }); } else s.spectators.push(u.id);
    this.status(u, { cabinet, role: player ? 'player' : 'spectator' }); this.crew(s); this.resend(u);
    if (player) { s.lastFrame[slot] = s.sim.frame; this.append(s, [s.sim.frame, slot, 1, 0]); }
    this.membership(s);
  }
  leave(u: Gamer) {
    const s = this.session(u); if (!s) return;
    const p = s.players.find(p => p.userId === u.id);
    if (p) {
      if (!s.screen) this.append(s, [s.sim.frame, p.slot, 2, 0]);
      s.players = s.players.filter(p => p.userId !== u.id); s.rosterChanged = true;
      if (s.set) s.set.players.find(p => p.userId === u.id)!.left = true;
    } else s.spectators = s.spectators.filter(id => id !== u.id);
    this.status(u, null); this.cheers.delete(u.id); this.api.send(u.id, { t: 'game_session', session: null });
    if (!s.players.length) {
      for (const id of s.spectators) { const spectator = this.api.user(id); if (spectator) this.status(spectator, null); this.cheers.delete(id); this.api.send(id, { t: 'game_session', session: null, reason: 'empty' }); }
      this.sessions.delete(s.cabinet); this.changed(); return;
    }
    if (p && s.set) {
      if (s.players.length < 2) { s.set = null; this.startEpoch(s, 0, this.api.now()); }
      else if ((!s.screen && s.game === 'vote') || s.screen?.screen === 'title') {
        const mode = s.set!.mode;
        const choice = s.screen?.data.game;
        const cards = !s.screen && s.game === 'vote' ? (s.opts as VoteOptions).ballot.map(c => c.resolves) : choice ? [choice] : [];
        if (cards.some(id => !eligible(s.players.length, mode).includes(id))) this.startVote(s, this.api.now());
      }
    }
    if (p && s.screen?.screen === 'favourite') {
      s.screen.data.candidates = s.set!.players.filter(p => !p.left).map(p => p.userId);
      s.screen.data.votes = Object.fromEntries(s.screen.data.candidates.map(id => [id, Object.values(s.set!.favourite).filter(v => v === id).length]));
    }
    this.membership(s);
  }
  reset(u: Gamer) {
    const s = this.session(u), p = s?.players.find(p => p.userId === u.id);
    if (s && p && !s.screen) { this.append(s, [s.sim.frame, p.slot, 3, 0]); s.lastFrame[p.slot] = s.sim.frame; }
  }
  private startSet(s: Session, teamMode: boolean, now: number) {
    this.rollover(); this.crew(s);
    const points = Object.fromEntries(Object.entries(this.board.week.players).map(([id, p]) => [id, weeklyTotal(p)]));
    const roster = teamMode ? balanceTeams(s.players, points) : s.players.map(p => ({ ...p, team: null }));
    s.set = { id: this.api.id?.() ?? randomUUID(), round: 1, mode: teamMode ? '2v2' : 'ffa', crew: { ...s.crew }, players: roster.map(p => ({ ...p, left: false })),
      points: Object.fromEntries(s.players.map(p => [p.userId, 0])), rounds: [], played: [], bonus: shuffle({ rng: this.seed() }, BONUS_POOL), predictions: {}, favourite: {} };
    this.startVote(s, now);
  }
  private startVote(s: Session, now: number) {
    const set = s.set!;
    if (set.mode === '2v2' && s.players.length !== 4) { set.mode = 'ffa'; set.players.forEach(p => { p.team = null; }); }
    set.predictions = {};
    const cards = ballot({ rng: this.seed() }, s.players.length, set.mode, set.played);
    this.startSim(s, 'vote', { ballot: cards, closesAt: now + 8000 }, now);
  }
  handle(u: Gamer, msg: ClientMsg) {
    const s = this.session(u); if (!s) return;
    const p = s.players.find(p => p.userId === u.id);
    if (msg.t === 'game_leave') { this.leave(u); return; }
    if (msg.t === 'crew_name') {
      if (!p || s.set || s.screen || s.game !== 'hub') return;
      const name = crewName(msg.name);
      if (!name) { this.api.send(u.id, { t: 'notice', text: "Crew names: 1–20 letters, digits, spaces or -'!&." }); return; }
      this.crews[s.crew.key] = name; this.crew(s); this.resendAll(s); return;
    }
    if (msg.t === 'game_cheer') {
      if (![0, 1, 2].includes(msg.kind)) return;
      const now = this.api.now(), recent = (this.cheers.get(u.id) ?? []).filter(at => now - at < 1000);
      if (recent.length >= 2) return;
      this.cheers.set(u.id, [...recent, now]); this.send(s, { t: 'game_cheer', userId: u.id, kind: msg.kind }); return;
    }
    if (!('epoch' in msg) || !Number.isSafeInteger(msg.epoch)) return;
    // A terminal-check mismatch can request a sync after the server has already entered the next epoch.
    if (msg.t === 'game_sync') { this.resend(u); return; }
    if (msg.epoch !== s.epoch) return;
    if (msg.t === 'game_predict') {
      if (!s.set || s.screen || s.game !== 'vote' || p || s.set.players.some(p => p.userId === u.id) || this.api.now() >= (s.opts as VoteOptions).closesAt) return;
      if (typeof msg.userId === 'string' && s.players.some(p => p.userId === msg.userId)) s.set.predictions[u.id] = msg.userId;
      return;
    }
    if (msg.t === 'game_favourite') {
      const data = s.screen?.screen === 'favourite' ? s.screen.data : null;
      if (!data || !s.set || this.api.now() >= s.screen!.until || !data.voters?.includes(u.id) || typeof msg.userId !== 'string' || !data.candidates?.includes(msg.userId)) return;
      s.set.favourite[u.id] = msg.userId;
      data.votes = Object.fromEntries(data.candidates.map(id => [id, Object.values(s.set!.favourite).filter(v => v === id).length])); this.resendAll(s); return;
    }
    if (msg.t === 'game_play') {
      if (p || s.set || s.screen || s.game !== 'hub' || s.players.length >= PARK_MAX_PLAYERS) return;
      const slot = [0, 1, 2, 3].find(n => !s.players.some(p => p.slot === n))!;
      s.players.push({ userId: u.id, slot }); s.roster.push({ userId: u.id, slot, team: null }); s.spectators = s.spectators.filter(id => id !== u.id);
      s.lastFrame[slot] = s.sim.frame; this.status(u, { cabinet: s.cabinet, role: 'player' }); this.append(s, [s.sim.frame, slot, 1, 0]); this.membership(s); return;
    }
    if (!p || s.screen) return;
    if (msg.t === 'game_input') {
      if (!Number.isSafeInteger(msg.frame) || !Number.isSafeInteger(msg.seq) || typeof msg.bits !== 'number' || !Number.isFinite(msg.bits)) return;
      const at = Math.floor((this.api.now() - s.startAt) * 60 / 1000);
      let frame = msg.frame; if (frame > at + 60) frame = Math.max(at, 0) + PARK_INPUT_DELAY;
      frame = Math.max(frame, s.sim.frame, s.lastFrame[p.slot]); s.lastFrame[p.slot] = frame;
      this.append(s, [frame, p.slot, 0, msg.bits & 63], u.id, msg.seq);
    } else if (msg.t === 'game_menu' && !s.set && s.game === 'park') {
      if (msg.op === 'lobby') this.startEpoch(s, 0, this.api.now(), s.level);
      else if (msg.op === 'restart') this.startEpoch(s, s.level, this.api.now() + 3000);
    }
  }
  private finishRound(s: Session, now: number) {
    const set = s.set!, result = scoreRound(s.game, s.sim.outcome!, set.players, set.rounds.at(-1), set.mode, set.round === 3);
    result.predictions = Object.entries(set.predictions).filter(([, id]) => result.order[0]?.includes(id)).map(([id]) => id);
    for (const [id, n] of Object.entries(result.points)) set.points[id] = (set.points[id] ?? 0) + n;
    set.rounds.push(result); set.played.push(s.game);
    this.screen(s, 'scores', 6000, { result: { game: result.game, order: result.order, points: result.points, underdog: result.underdog, final: result.final }, predictions: result.predictions, totals: { ...set.points } }, now);
  }
  private reveal(s: Session, now: number) {
    const set = s.set!, candidates = set.players.filter(p => !p.left).map(p => p.userId), favourite = favouriteWinners(set.favourite, candidates);
    for (const id of favourite) set.points[id]++;
    const bonus = bonusStar(set); if (bonus) for (const id of bonus.winners) set.points[id] += 2;
    this.screen(s, 'bonus', 3000, { favourite, bonus, totals: { ...set.points } }, now);
  }
  private advanceScreen(s: Session, now: number) {
    const view = s.screen!;
    if (!s.set) { this.startEpoch(s, 0, now, Math.min(s.level + 1, 8)); return; }
    const set = s.set;
    if (view.screen === 'title') { this.startSim(s, view.data.game!, view.data.opts, now); return; }
    if (view.screen === 'scores') {
      if (set.round < 3) { set.round++; this.startVote(s, now); return; }
      const voters = s.spectators.filter(id => !set.players.some(p => p.userId === id));
      if (voters.length >= 2) this.screen(s, 'favourite', 8000, { candidates: set.players.filter(p => !p.left).map(p => p.userId), voters, votes: {} }, now);
      else this.reveal(s, now);
    } else if (view.screen === 'favourite') this.reveal(s, now);
    else if (view.screen === 'bonus') this.screen(s, 'awards', 10000, { standings: standings(set), awards: awards(set), totals: { ...set.points } }, now);
    else if (view.screen === 'awards') { this.commit(set); s.set = null; this.startEpoch(s, 0, now); }
  }
  private commit(set: BreakSet) {
    this.rollover(); if (this.committed.includes(set.id)) return;
    const standing = new Set(set.players.filter(p => !p.left).map(p => p.userId));
    if (standing.size < 2) return;
    for (const id of standing) {
      const p = this.board.week.players[id] ??= { name: this.api.user(id)?.name ?? id, sets: [] };
      p.name = this.api.user(id)?.name ?? p.name; p.sets = [...p.sets, { id: set.id, total: set.points[id] }].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id)).slice(0, 10);
    }
    for (const r of set.rounds) {
      const wins = this.board.week.champions[r.game] ??= {};
      for (const id of r.order[0] ?? []) if (standing.has(id)) wins[id] = (wins[id] ?? 0) + 1;
      for (const id of r.predictions) this.board.week.oracle[id] = (this.board.week.oracle[id] ?? 0) + 1;
    }
    this.committed.push(set.id); this.publishBoards();
  }
  tick(now: number) {
    for (const s of this.sessions.values()) {
      if (s.screen) { if (now >= s.screen.until) this.advanceScreen(s, now); continue; }
      while (s.sim.frame <= Math.floor((now - s.startAt) * 60 / 1000) - PARK_SERVER_LAG) {
        const epoch = s.epoch;
        gameDef(s.game).step(s.sim, s.events.filter(e => e[0] === s.sim.frame)); s.events = s.events.filter(e => e[0] >= s.sim.frame);
        if (s.sim.outcome || s.sim.frame % 60 === 0) this.send(s, { t: 'game_check', epoch, frame: s.sim.frame, hash: hash(s.sim), serverNow: now });
        if (s.game === 'hub') {
          const hub = s.sim as HubState;
          for (const p of [...s.players]) if (hub.players[p.slot]?.entered) { const u = this.api.user(p.userId); if (u) this.leave(u); }
          if (!this.sessions.has(s.cabinet)) break;
          while (s.crewBumps < hub.crewBumps) {
            s.crewBumps++; const n = (this.rerolls.get(s.crew.key) ?? 0) + 1; this.rerolls.set(s.crew.key, n);
            this.crews[s.crew.key] = autoName(s.crew.key, n); this.crew(s); this.resendAll(s);
          }
        }
        if (s.sim.outcome) {
          const signal = s.sim.outcome.signal;
          if (signal?.kind === 'hub') {
            if (signal.start === 'party' && s.players.length >= 2) this.startSet(s, signal.teamMode, now);
            else this.startEpoch(s, signal.level, now + 3000);
          } else if (signal?.kind === 'vote' && s.set) {
            const card = (s.opts as VoteOptions).ballot[signal.card];
            this.screen(s, 'title', 3000, { game: card.resolves, opts: card.opts, round: s.set.round }, now);
          } else if (s.set) this.finishRound(s, now);
          else if (s.game === 'park') {
            const park = s.sim as ParkGameState, frames = park.clearedAt, coins = park.coins, team = s.teamSize as 1 | 2 | 3 | 4, old = this.records[s.level]?.[team];
            const record = !s.rosterChanged && (!old || frames < old.frames || frames === old.frames && coins > old.coins);
            if (record) { (this.records[s.level] ??= {})[team] = { frames, coins, names: [...s.players].sort((a, b) => a.slot - b.slot).map(p => this.api.user(p.userId)?.name ?? ''), crew: s.crew.name, at: now }; this.publishBoards(); }
            s.clear = { frames, coins, record }; this.send(s, { t: 'game_clear', epoch, ...s.clear }); this.screen(s, 'scores', 4000, { clear: s.clear }, now);
          }
        }
        if (s.epoch !== epoch) break;
      }
    }
  }
  dump() { this.rollover(); return { records: structuredClone(this.records), crews: { ...this.crews }, week: structuredClone(this.board.week), hall: structuredClone(this.board.hall), committed: [...this.committed] }; }
  load(saved: unknown) {
    this.records = {}; this.crews = {}; this.committed = []; this.board = { records: this.records, week: emptyWeek(weekKey(this.api.now())), hall: [] };
    if (!saved || typeof saved !== 'object') return;
    const data = saved as Partial<ReturnType<Arcade['dump']>>;
    for (let level = 1; level <= 8; level++) for (const team of [1, 2, 3, 4] as const) {
      const r = data.records?.[level]?.[team];
      if (!r || !Number.isSafeInteger(r.frames) || r.frames < 0 || !Number.isSafeInteger(r.coins) || r.coins < 0 || !Number.isFinite(r.at) || !Array.isArray(r.names) || r.names.length !== team || !r.names.every(n => typeof n === 'string')) continue;
      (this.records[level] ??= {})[team] = structuredClone(r);
    }
    if (data.crews && typeof data.crews === 'object') this.crews = Object.fromEntries(Object.entries(data.crews).filter(([, name]) => typeof name === 'string'));
    if (data.week && /^\d{4}-\d{2}-\d{2}$/.test(data.week.key) && data.week.players && data.week.champions && data.week.oracle && data.week.table) this.board.week = structuredClone(data.week);
    if (Array.isArray(data.hall)) this.board.hall = structuredClone(data.hall).slice(-10);
    if (Array.isArray(data.committed)) this.committed = data.committed.filter(id => typeof id === 'string'); this.rollover();
  }
}
