import { randomBytes, randomUUID } from 'node:crypto';
import type { ClientMsg, ServerMsg, PublicUser } from '../../shared/protocol';
import { TABLE_GAMES, type TableGameId, type TableView, type TableStatus } from '../../shared/table/types';
import * as rules from '../../shared/table/rules';
export const TABLE_TURN_MS = 120_000, TABLE_INVITE_MS = 30_000;
type Sitter = Pick<PublicUser, 'id' | 'bot' | 'table'>;
export interface Match { id: string; players: string[]; out: string[]; rules: rules.GameState; timeouts: number[]; drawOffer: string | null }
export interface Session {
  objectId: string; sitters: string[]; watchers: string[]; pick: TableGameId | null;
  invitation: TableView['invitation']; match: Match | null; revision: number; turnDeadline: number | null;
}
interface Options {
  now(): number; send(id: string, msg: ServerMsg): void; broadcast(msg: ServerMsg): void; user(id: string): Sitter | undefined;
  leaveCabinet(u: Sitter): void; commit(id: string, game: TableGameId, winner: string | null): void;
  timer?: boolean; seed?: () => number; id?: () => string;
}
export class Table {
  readonly sessions = new Map<string, Session>();
  constructor(private readonly api: Options) { if (api.timer !== false) setInterval(() => this.tick(this.api.now()), 250).unref(); }
  session(u: Sitter) { return u.table ? this.sessions.get(u.table.objectId) : undefined; }
  private members(s: Session) { return [...s.sitters, ...s.watchers]; }
  private status(u: Sitter, table: TableStatus | null) { u.table = table; this.api.broadcast({ t: 'table_status', userId: u.id, table }); }
  private publish(s: Session) {
    const m = s.match;
    for (const id of this.members(s)) {
      const u = this.api.user(id); if (!u) continue;
      this.status(u, { objectId: s.objectId, role: s.sitters.includes(id) ? 'sitter' : 'watcher', game: m?.rules.game ?? s.pick,
        players: m ? m.players.filter(id => !m.out.includes(id)) : [], running: !!m && !m.rules.state.result });
      this.resend(u);
    }
  }
  resend(u: Sitter) {
    const s = this.session(u);
    if (!s) { this.api.send(u.id, { t: 'table', view: null }); return; }
    const m = s.match;
    const view: TableView = { objectId: s.objectId, sitters: [...s.sitters], watchers: [...s.watchers], host: s.sitters[0], pick: s.pick,
      invitation: s.invitation && structuredClone(s.invitation), match: m ? { id: m.id, players: [...m.players], out: [...m.out], drawOffer: m.drawOffer,
        ...rules.view(m.rules, m.out.includes(u.id) ? -1 : m.players.indexOf(u.id)) } : null,
      revision: s.revision, turnDeadline: s.turnDeadline, serverNow: this.api.now() };
    this.api.send(u.id, { t: 'table', view });
  }
  join(u: Sitter, objectId: string) {
    if (u.bot) return;
    if (this.session(u)?.objectId === objectId) { this.resend(u); return; }
    this.api.leaveCabinet(u); this.leave(u);
    let s = this.sessions.get(objectId);
    if (!s) { s = { objectId, sitters: [], watchers: [], pick: null, invitation: null, match: null, revision: 0, turnDeadline: null }; this.sessions.set(objectId, s); }
    (s.sitters.length < 4 ? s.sitters : s.watchers).push(u.id); s.revision++; this.publish(s);
  }
  leave(u: Sitter) {
    const s = this.session(u); if (!s) return;
    this.expire(s, this.api.now());
    const m = s.match, player = m?.players.indexOf(u.id) ?? -1;
    if (m && player >= 0 && !m.out.includes(u.id) && !m.rules.state.result) this.forfeit(s, player, 'Player left');
    const host = s.sitters[0] === u.id;
    s.sitters = s.sitters.filter(id => id !== u.id); s.watchers = s.watchers.filter(id => id !== u.id);
    if (host) s.invitation = null;
    else if (s.invitation) {
      if (s.invitation.rematch && s.invitation.invited.includes(u.id)) s.invitation = null;
      else { s.invitation.invited = s.invitation.invited.filter(id => id !== u.id); s.invitation.accepted = s.invitation.accepted.filter(id => id !== u.id); }
    }
    this.status(u, null); this.api.send(u.id, { t: 'table', view: null }); s.revision++;
    if (!s.sitters.length) {
      for (const id of s.watchers) { const watcher = this.api.user(id); if (watcher) this.status(watcher, null); this.api.send(id, { t: 'table', view: null }); }
      this.sessions.delete(s.objectId);
    } else this.publish(s);
  }
  private finished(s: Session) {
    const m = s.match!; if (!m.rules.state.result) return;
    s.turnDeadline = null; m.drawOffer = null;
    const winner = m.rules.state.result.winner;
    this.api.commit(m.id, m.rules.game, winner === null ? null : m.players[winner]);
  }
  private forfeit(s: Session, player: number, reason: string) {
    const m = s.match!, ply = m.rules.state.ply;
    m.out.push(m.players[player]); m.drawOffer = null; m.rules = rules.leave(m.rules, player);
    if (m.rules.state.result) m.rules.state.result.reason = reason;
    else if (m.rules.state.ply !== ply) s.turnDeadline = this.api.now() + TABLE_TURN_MS;
    this.finished(s);
  }
  private expire(s: Session, now: number): boolean {
    let changed = false;
    if (s.invitation && now >= s.invitation.until) { s.invitation = null; s.revision++; changed = true; }
    const m = s.match;
    if (m && !m.rules.state.result && s.turnDeadline !== null && now >= s.turnDeadline) {
      const player = m.rules.state.turn;
      if (m.players.length === 2 || ++m.timeouts[player] >= 2) this.forfeit(s, player, 'Turn timed out');
      else { m.rules = rules.timeout(m.rules); m.drawOffer = null; this.finished(s); }
      if (!m.rules.state.result) s.turnDeadline = now + TABLE_TURN_MS;
      s.revision++; changed = true;
    }
    return changed;
  }
  tick(now: number) { for (const s of this.sessions.values()) if (this.expire(s, now)) this.publish(s); }
  handle(u: Sitter, msg: ClientMsg) {
    const s = this.session(u); if (!s) return;
    if (this.expire(s, this.api.now())) this.publish(s);
    if (msg.t === 'table_leave') { this.leave(u); return; }
    const host = s.sitters[0] === u.id, running = s.match && !s.match.rules.state.result;
    if (msg.t === 'table_pick') {
      if (!host || running || !Object.hasOwn(TABLE_GAMES, msg.game)) return;
      const rematch = msg.rematch === true;
      if (rematch && (!s.match || s.match.rules.game !== msg.game || !s.match.players.includes(u.id))) return;
      const invited = rematch ? s.match!.players.filter(id => id !== u.id) : msg.invite;
      if (!Array.isArray(invited) || invited.length < 1 || invited.length > (msg.game === 'chess' || msg.game === 'draughts' ? 1 : 3) ||
        new Set(invited).size !== invited.length || invited.some(id => typeof id !== 'string' || id === u.id || !s.sitters.includes(id))) return;
      s.pick = msg.game; s.invitation = { game: msg.game, invited: [...invited], accepted: [u.id], until: this.api.now() + TABLE_INVITE_MS, rematch };
      s.revision++; this.publish(s); return;
    }
    if (msg.t === 'table_start') {
      const inv = s.invitation; if (!inv || running) return;
      if (!host) {
        if (!inv.invited.includes(u.id) || inv.accepted.includes(u.id)) return;
        inv.accepted.push(u.id); s.revision++; this.publish(s); return;
      }
      const players = [u.id, ...s.sitters.filter(id => id !== u.id && inv.accepted.includes(id))];
      if (players.length < 2 || ((inv.game === 'chess' || inv.game === 'draughts') && players.length !== 2) || (inv.rematch && inv.invited.some(id => !players.includes(id)))) return;
      s.match = { id: this.api.id?.() ?? randomUUID(), players, out: [], timeouts: players.map(() => 0), drawOffer: null,
        rules: rules.init(inv.game, this.api.seed?.() ?? randomBytes(4).readUInt32LE(), players.length) };
      s.invitation = null; s.turnDeadline = this.api.now() + TABLE_TURN_MS; s.revision++; this.publish(s); return;
    }
    const m = s.match;
    if (!m || m.rules.state.result || !('matchId' in msg) || msg.matchId !== m.id) return;
    const player = m.players.indexOf(u.id); if (player < 0 || m.out.includes(u.id)) return;
    if (msg.t === 'table_resign') { this.forfeit(s, player, 'Resigned'); s.revision++; this.publish(s); return; }
    if (msg.t === 'table_draw') {
      if (m.rules.game !== 'chess' && m.rules.game !== 'draughts' || typeof msg.offer !== 'boolean') return;
      if (m.drawOffer && m.drawOffer !== u.id) {
        if (msg.offer) m.rules.state.result = { winner: null, reason: 'Draw agreed' };
        m.drawOffer = null;
      } else if (!m.drawOffer && msg.offer) m.drawOffer = u.id;
      else return;
      s.revision++; this.finished(s); this.publish(s); return;
    }
    if (msg.t !== 'table_move' || !Number.isSafeInteger(msg.revision) || msg.revision !== s.revision) { this.resend(u); return; }
    const ply = m.rules.state.ply, oldTurn = m.rules.state.turn;
    const next = rules.apply(m.rules, player, msg.move); if (!next) return;
    m.rules = next;
    // The catch window closes on any accepted action, including a draw offer/answer (handled above).
    if (m.drawOffer && m.drawOffer !== u.id) m.drawOffer = null;
    if (next.state.ply !== ply) { m.timeouts[oldTurn] = 0; s.turnDeadline = this.api.now() + TABLE_TURN_MS; }
    s.revision++; this.finished(s); this.publish(s);
  }
}
