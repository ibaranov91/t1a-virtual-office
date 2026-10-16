import { createHash, randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { createGb, GB_FPS, type Gb } from '../../shared/retro/gb';
import { games, type RetroGameId } from '../../shared/retro/games';
import { normalize } from '../../shared/retro/buttons';
import { compareScore, emptyBoards, ranked } from '../../shared/retro/boards';
import { weekKey } from '../../shared/arcade/weeks';
import type { ProbeResult } from '../../shared/retro/probes';
import type { ClientMsg, PublicUser, RetroBoards, RetroCabinet, RetroEntry, RetroResult, RetroView, ServerMsg } from '../../shared/protocol';

type Gamer = Pick<PublicUser, 'id' | 'name' | 'bot' | 'game' | 'presence' | 'instance'>;
export interface Session {
  runId: string; sync: number; player: string; gb: Gb; upto: number; bits: number; credit: number; creditAt: number;
  probe: unknown; lastResultFrame: number; lastWriteFrame: number; extDirty: boolean; lastChangeAt: number; startAt: number;
  first: boolean;
}
interface Cabinet {
  id: string; game: RetroGameId; watchers: string[]; broken: boolean;
  starting: { token: number; player: string } | null; session: Session | null;
}
interface Options {
  now(): number; send(userId: string, msg: ServerMsg): void; broadcast(msg: ServerMsg): void;
  user(userId: string): Gamer | undefined; timer?: boolean;
  roms: Partial<Record<RetroGameId, Uint8Array>>; wasm: Uint8Array; createGb?: typeof createGb; id?: () => string;
  cabinets: { id: string; game: RetroGameId }[];
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const brokenLogged = new Set<RetroGameId>();
export class Retro {
  readonly cabinets = new Map<string, Cabinet>();
  private saves: Record<RetroGameId, Record<string, string>> = { tobu: Object.create(null), lobster: Object.create(null) };
  private board: RetroBoards;
  private token = 0;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly api: Options) {
    this.board = emptyBoards(weekKey(api.now()));
    const broken = new Set<RetroGameId>();
    for (const { game } of api.cabinets) {
      const rom = api.roms[game];
      if (!rom || rom.length !== games[game].bytes || createHash('sha256').update(rom).digest('hex') !== games[game].sha256) {
        broken.add(game);
        if (!brokenLogged.has(game)) { console.warn(`Retro ${game}: ROM missing or SHA-256 mismatch; cabinet out of order`); brokenLogged.add(game); }
      }
    }
    for (const c of api.cabinets) this.cabinets.set(c.id, { ...c, watchers: [], broken: broken.has(c.game), starting: null, session: null });
    if (api.timer !== false) this.timer = setInterval(() => this.tick(api.now()), 50).unref();
  }
  summary(): RetroCabinet[] {
    return [...this.cabinets.values()].map(c => ({ cabinet: c.id, game: c.game, player: c.session?.player ?? c.starting?.player ?? null, watchers: c.watchers.length, ...(c.broken ? { broken: true as const } : {}) }));
  }
  private changed() { this.api.broadcast({ t: 'retro_cabinets', cabinets: this.summary() }); }
  private rollover() {
    const key = weekKey(this.api.now()); if (key === this.board.week) return;
    for (const game of Object.values(this.board.games)) for (const board of Object.values(game)) board.week = Object.create(null);
    this.board.week = key; this.publishBoards();
  }
  boards(): RetroBoards { this.rollover(); return structuredClone(this.board); }
  private publishBoards() { this.api.broadcast({ t: 'retro_boards', boards: structuredClone(this.board) }); }
  has(u: Gamer) { return !!this.member(u); }
  private member(u: Gamer) { return [...this.cabinets.values()].find(c => c.session?.player === u.id || c.starting?.player === u.id || c.watchers.includes(u.id)); }
  private status(u: Gamer, game: PublicUser['game']) { u.game = game; this.api.broadcast({ t: 'game_status', userId: u.id, game }); }
  private notice(u: Gamer, text: string) { this.api.send(u.id, { t: 'notice', text }); }
  private view(c: Cabinet, id: string, save?: string | null): RetroView {
    const s = c.session;
    if (!s) return c.starting ? { kind: 'starting', cabinet: c.id, game: c.game, player: c.starting.player } : { kind: 'vacant', cabinet: c.id, game: c.game };
    return { kind: 'playing', cabinet: c.id, game: c.game, runId: s.runId, sync: s.sync, player: s.player,
      role: id === s.player ? 'player' : 'spectator', save: save ?? null,
      snapshot: save === undefined ? deflateRawSync(s.gb.state()).toString('base64') : null,
      upto: s.upto, bits: s.bits, serverNow: this.api.now() };
  }
  private sendView(c: Cabinet, id: string, save?: string | null) { this.api.send(id, { t: 'retro_session', view: this.view(c, id, save) }); }
  private watchers(c: Cabinet) { for (const id of c.watchers) this.sendView(c, id); }
  handover(u: Gamer) {
    const c = this.member(u);
    if (!c) return;
    if (c.session?.player === u.id) { c.session.sync++; c.session.first = true; }
    this.sendView(c, u.id);
  }
  async join(u: Gamer, cabinet: string) {
    const c = this.cabinets.get(cabinet);
    if (!c || this.closed || u.bot || u.instance || u.presence === 'offline') return;
    if (c.broken) { this.notice(u, 'This cabinet is out of order'); return; }
    const old = this.member(u);
    if (old === c && (c.session || c.starting)) { if (c.session?.player === u.id) this.handover(u); else this.sendView(c, u.id); return; }
    if ((c.session || c.starting) && c.watchers.length >= 8) { this.notice(u, `The ${games[c.game].title} cabinet is crowded`); return; }
    if (old && old !== c) this.leave(u);
    if (c.session || c.starting) {
      c.watchers.push(u.id); this.status(u, { cabinet, role: 'spectator' }); this.sendView(c, u.id); this.changed(); return;
    }
    c.watchers = c.watchers.filter(id => id !== u.id);
    const token = ++this.token; c.starting = { token, player: u.id };
    this.status(u, { cabinet, role: 'player' }); this.sendView(c, u.id); this.watchers(c); this.changed();
    const save = this.saves[c.game][u.id] ?? null;
    let gb: Gb | undefined;
    try {
      gb = await (this.api.createGb ?? createGb)({ wasm: this.api.wasm, rom: this.api.roms[c.game]!, save: save === null ? null : Buffer.from(save, 'base64'), audioRate: 48000, audio: false });
      if (this.closed || c.starting?.token !== token || this.member(u) !== c || this.api.user(u.id)?.presence === 'offline' || !this.api.user(u.id) || u.instance) {
        gb.destroy();
        if (c.starting?.token === token) this.leave(u);
        return;
      }
      const now = this.api.now(); c.starting = null;
      c.session = { runId: this.api.id?.() ?? randomUUID(), sync: 0, player: u.id, gb, upto: 0, bits: 0, credit: 0, creditAt: now,
        probe: games[c.game].probe.start(), lastResultFrame: -Infinity, lastWriteFrame: -Infinity, extDirty: false, lastChangeAt: now, startAt: now, first: true };
      this.sendView(c, u.id, save); this.watchers(c); this.changed();
    } catch {
      gb?.destroy();
      if (c.starting?.token !== token) return;
      c.starting = null; this.status(u, null); this.api.send(u.id, { t: 'retro_session', view: null, reason: 'broken' });
      this.notice(u, "The cabinet didn't start"); this.watchers(c); this.changed();
    }
  }
  private copy(c: Cabinet, s: Session) {
    if (!s.extDirty) return;
    this.saves[c.game][s.player] = Buffer.from(s.gb.ext()).toString('base64'); s.extDirty = false;
  }
  private step(c: Cabinet, s: Session, bits: number): { frame: number; result: ProbeResult } | null {
    s.gb.step(bits); s.upto = s.gb.frame;
    const result = games[c.game].probe.step(s.probe, s.gb.read);
    if (result) s.lastResultFrame = s.upto;
    if (s.gb.takeExtWrite()) { s.extDirty = true; s.lastWriteFrame = s.upto; }
    return result ? { frame: s.upto, result } : null;
  }
  private commit(c: Cabinet, s: Session, ev: { frame: number; result: ProbeResult }) {
    const { result: r, frame } = ev;
    const track = games[c.game].tracks.find(t => t.id === r.track);
    if (!track || !integer(r.score) || (track.timed && !integer(r.time))) { console.warn('Invalid retro result; skipped'); return; }
    this.rollover();
    const board = this.board.games[c.game][r.track], entry: RetroEntry = { userId: s.player, name: this.api.user(s.player)?.name ?? s.player, score: r.score, ...(track.timed ? { time: r.time } : {}), at: this.api.now() };
    const best = !board.all[s.player] || compareScore(entry, board.all[s.player]) < 0;
    if (best) board.all[s.player] = entry;
    if (!board.week[s.player] || compareScore(entry, board.week[s.player]) < 0) board.week[s.player] = entry;
    const result: RetroResult = { game: c.game, ...r, best, weekRank: ranked(board.week).find(e => e.userId === s.player)!.rank, allRank: ranked(board.all).find(e => e.userId === s.player)!.rank };
    for (const id of [s.player, ...c.watchers]) this.api.send(id, { t: 'retro_result', runId: s.runId, frame, result });
    this.publishBoards();
  }
  private settle(c: Cabinet, s: Session) {
    const probe = games[c.game].probe;
    const pending = () => probe.pending(s.probe, s.gb.read) || s.lastResultFrame > s.lastWriteFrame || s.upto - s.lastWriteFrame < 2;
    for (let i = 0; i < probe.settle.maxFrames && pending(); i++) {
      const ev = this.step(c, s, i === 0 && s.lastResultFrame > s.lastWriteFrame ? probe.settle.press : 0);
      if (ev) this.commit(c, s, ev);
    }
    this.copy(c, s);
  }
  private end(c: Cabinet, reason: 'ended' | 'idle' | 'cap') {
    const s = c.session; if (!s) return;
    this.settle(c, s); s.gb.destroy(); c.session = null;
    const u = this.api.user(s.player); if (u) this.status(u, null);
    this.api.send(s.player, { t: 'retro_session', view: null, reason });
    this.watchers(c); this.changed();
  }
  leave(u: Gamer) {
    const c = this.member(u); if (!c) return;
    if (c.session?.player === u.id) { this.end(c, 'ended'); return; }
    if (c.starting?.player === u.id) c.starting = null;
    else c.watchers = c.watchers.filter(id => id !== u.id);
    this.status(u, null); this.api.send(u.id, { t: 'retro_session', view: null, reason: 'ended' }); this.watchers(c); this.changed();
  }
  handle(u: Gamer, msg: ClientMsg) {
    // World has already checked the owner socket for every retro intent.
    if (msg.t === 'retro_leave') { this.leave(u); return; }
    if (msg.t === 'retro_resync') { this.handover(u); return; }
    if (msg.t !== 'retro_frames') return;
    const c = this.member(u), s = c?.session;
    if (!c || !s || s.player !== u.id || msg.runId !== s.runId || (typeof msg.sync === 'number' && msg.sync < s.sync)) return;
    const now = this.api.now(); s.credit = Math.min(300, s.credit + Math.max(0, now - s.creditAt) * GB_FPS / 1000); s.creditAt = now;
    const { from, upto, changes } = msg, count = upto - from;
    const valid = msg.sync === s.sync && integer(from) && integer(upto) && from === s.upto && count >= 1 && count <= 300 && count <= s.credit &&
      Array.isArray(changes) && changes.length <= 300 && (!s.first || changes[0]?.[0] === from) && changes.every((v, i) => Array.isArray(v) && v.length === 2 && integer(v[0]) && v[0] >= from && v[0] < upto && (i === 0 || v[0] > changes[i - 1][0]) && integer(v[1]) && v[1] <= 255);
    if (!valid) { this.handover(u); return; }
    s.credit -= count; s.first = false;
    const normalized: [number, number][] = changes.map(([f, b]) => [f, normalize(b)]), results: { frame: number; result: ProbeResult }[] = [];
    let at = 0;
    while (s.upto < upto) {
      if (normalized[at]?.[0] === s.upto) {
        const bits = normalized[at++][1]; if (bits !== s.bits) s.lastChangeAt = now; s.bits = bits;
      }
      const ev = this.step(c, s, s.bits); if (ev) results.push(ev);
    }
    for (const id of c.watchers) this.api.send(id, { t: 'retro_frames', runId: s.runId, from, upto, changes: normalized });
    for (const ev of results) this.commit(c, s, ev);
    this.copy(c, s);
    if (s.upto >= 430000) this.end(c, 'cap');
  }
  tick(now: number) {
    for (const c of this.cabinets.values()) if (c.session && now - c.session.lastChangeAt >= 600000) this.end(c, 'idle');
  }
  shutdown() {
    this.closed = true; clearInterval(this.timer);
    for (const c of this.cabinets.values()) {
      if (c.session) this.end(c, 'ended');
      if (c.starting) { const u = this.api.user(c.starting.player); if (u) this.leave(u); else c.starting = null; }
    }
  }
  dump() { this.rollover(); return { saves: structuredClone(this.saves), boards: structuredClone(this.board) }; }
  load(saved: unknown) {
    this.saves = { tobu: Object.create(null), lobster: Object.create(null) }; this.board = emptyBoards(weekKey(this.api.now()));
    if (saved === undefined || saved === null) return;
    const data = record(saved), saves = record(data.saves), boards = record(data.boards), gameBoards = record(boards.games);
    let bad = Object.keys(data).some(k => k !== 'saves' && k !== 'boards') || Object.keys(saves).some(k => !(k === 'tobu' || k === 'lobster')) || Object.keys(gameBoards).some(k => !(k === 'tobu' || k === 'lobster'));
    if (typeof boards.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(boards.week)) this.board.week = boards.week;
    else bad = true;
    for (const game of Object.keys(games) as RetroGameId[]) {
      for (const [id, save] of Object.entries(record(saves[game]))) {
        // Both catalogue ROMs have 8 KB cartridge RAM. Bound before decoding.
        if (typeof save !== 'string' || save.length !== 10924 || !/^[A-Za-z0-9+/]{10923}=$/.test(save) || Buffer.from(save, 'base64').length !== 8192) { bad = true; continue; }
        this.saves[game][id] = save;
      }
      const tracks = record(gameBoards[game]);
      if (Object.keys(tracks).some(k => !games[game].tracks.some(t => t.id === k))) bad = true;
      for (const track of games[game].tracks) for (const scope of ['all', 'week'] as const) {
        for (const [id, value] of Object.entries(record(record(tracks[track.id])[scope]))) {
          const e = record(value);
          if (typeof e.userId !== 'string' || e.userId !== id || typeof e.name !== 'string' || !integer(e.score) || !integer(e.at) || (track.timed && !integer(e.time))) { bad = true; continue; }
          this.board.games[game][track.id][scope][id] = { userId: id, name: e.name, score: e.score, at: e.at, ...(track.timed ? { time: e.time as number } : {}) };
        }
      }
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) bad = true;
    if (bad) console.warn('Retro load: invalid or unknown records skipped');
    this.rollover();
  }
}
