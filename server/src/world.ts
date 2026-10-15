import { randomUUID } from 'node:crypto';
import {
  findPath, isWalkable, pathDuration, roomAt, sampleMove, seatAt, WALK_MS_PER_TILE,
  type Dir, type TileMap, type Tile,
} from '../../shared/map';
import { normalizeMeetLink, type ClientMsg, type Knock, type Look, type Presence, type PublicUser, type ServerMsg } from '../../shared/protocol';

export interface User extends PublicUser {
  path: Tile[] | null; // path of the current move (server-side bookkeeping)
  email?: string;       // identity from NetBird; never broadcast
  meetLink?: string;    // personal reusable Google Meet room; only shared with knock partners
  offlineAt?: number;   // when the last socket closed (not persisted)
}

const WALK_HOME_AFTER_MS = 5 * 60_000; // a quick reload keeps you where you were

const SKINS = ['#f8dcc0', '#f2c79b', '#e2ad7f', '#c98d5e', '#a46a43', '#7c4f32'];
const HAIRS = ['#2b1d1f', '#4f2b1a', '#6b3e26', '#a0603a', '#d8a050', '#ecd59a', '#b4473a', '#8c8a98', '#3e5a8a', '#c8789a'];
const SHIRTS = ['#4a7ab0', '#b4534a', '#7a9a55', '#d0a040', '#8a5aa0', '#4f9a92', '#d8805a', '#e8e0d0', '#5a5a6e', '#c8607a', '#6a8ad0', '#9a7a50'];
const PANTS = ['#3d3a52', '#2c3e5a', '#5a4030', '#4a4a4a', '#6a5a7a', '#3a5a4a'];

const hashStr = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
export const lookFor = (name: string): Look => {
  const h = hashStr(name.toLowerCase());
  return {
    skin: SKINS[h % SKINS.length], hair: HAIRS[(h >>> 4) % HAIRS.length],
    shirt: SHIRTS[(h >>> 9) % SHIRTS.length], pants: PANTS[(h >>> 14) % PANTS.length], style: (h >>> 20) % 3,
  };
};

type Send = (msg: ServerMsg) => void;

export class World {
  users = new Map<string, User>();
  knocks = new Map<string, Knock & { timer?: NodeJS.Timeout }>();
  private sockets = new Map<string, Set<Send>>();
  private listeners = new Set<Send>();

  constructor(public map: TileMap) {}

  // ---------- transport ----------
  broadcast(msg: ServerMsg) { for (const l of this.listeners) l(msg); }
  sendTo(userId: string, msg: ServerMsg) { for (const s of this.sockets.get(userId) ?? []) s(msg); }
  snapshot(): ServerMsg {
    return { t: 'state', serverTime: Date.now(), users: [...this.users.values()].map(this.toPublic) };
  }
  private toPublic = (u: User): PublicUser => {
    const { path: _p, email: _e, meetLink: _m, ...pub } = u;
    return pub;
  };

  connect(userId: string, send: Send) {
    const u = this.users.get(userId);
    if (!u) throw new Error('unknown user');
    if (!this.sockets.has(userId)) this.sockets.set(userId, new Set());
    this.sockets.get(userId)!.add(send);
    this.listeners.add(send);
    send({ t: 'hello', you: userId, serverTime: Date.now() });
    if (u.presence === 'offline') {
      u.presence = 'online'; this.broadcast({ t: 'presence', userId, presence: 'online' });
      if (u.homeDesk && (!u.offlineAt || Date.now() - u.offlineAt > WALK_HOME_AFTER_MS)) this.walkHome(u);
    }
    send(this.snapshot());
    send({ t: 'me', meetLink: u.meetLink ?? '' });
    return () => {
      this.listeners.delete(send);
      const set = this.sockets.get(userId)!; set.delete(send);
      if (set.size === 0 && !u.bot) { u.presence = 'offline'; u.offlineAt = Date.now(); this.broadcast({ t: 'presence', userId, presence: 'offline' }); }
    };
  }

  // ---------- users ----------
  addUser(name: string, bot = false, tile?: Tile, email?: string): User {
    const u: User = {
      email,
      id: randomUUID().slice(0, 8), name, look: lookFor(name), tile: tile ?? { ...this.map.spawn }, dir: 'down',
      move: null, path: null, presence: bot ? 'online' : 'offline', status: '', emote: null, bot, homeDesk: null,
    };
    this.users.set(u.id, u);
    this.broadcast(this.snapshot());
    return u;
  }
  findByEmail(email: string) { return [...this.users.values()].find(u => u.email === email.toLowerCase()); }
  findByName(name: string) { return [...this.users.values()].find(u => u.name.toLowerCase() === name.toLowerCase()); }

  /** Where the user is right now (tile they occupy / are entering) and where they're going. */
  position(u: User, now = Date.now()) {
    if (!u.move || !u.path) return { tile: u.tile, next: u.tile, remainingMs: 0, dest: u.tile };
    const s = sampleMove(u.path, u.move.startedAt, now)!;
    if (s.done) return { tile: s.tile, next: s.tile, remainingMs: 0, dest: s.tile };
    const seg = Math.max(0, now - u.move.startedAt) / WALK_MS_PER_TILE;
    return { tile: s.tile, next: s.next, remainingMs: (Math.ceil(seg) - seg) * WALK_MS_PER_TILE, dest: u.move.to };
  }
  roomOf(u: User) { const p = this.position(u); return roomAt(this.map, p.tile.x, p.tile.y); }

  /** Start a walk. Mid-walk, the new path starts at the tile being entered, timed for when we get there. */
  walk(u: User, to: Tile, face?: Dir, now = Date.now()): number | null {
    if (!isWalkable(this.map, to.x, to.y)) return null;
    const pos = this.position(u, now);
    const from = pos.next;
    const path = findPath(this.map, from, to);
    if (!path.length) return null;
    const startedAt = Math.round(now + pos.remainingMs);
    face ??= seatAt(this.map, to.x, to.y)?.dir; // sit facing the desk/table
    u.move = { from, to, startedAt, face }; u.path = path; u.tile = to;
    if (face) u.dir = face;
    else if (path.length > 1) { const a = path[path.length - 2], b = path[path.length - 1]; u.dir = b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : 'up'; }
    this.broadcast({ t: 'move', userId: u.id, from, to, startedAt, face });
    return startedAt + pathDuration(path);
  }

  // ---------- home desks ----------
  deskOwner(t: Tile) { return [...this.users.values()].find(o => o.homeDesk?.x === t.x && o.homeDesk?.y === t.y); }
  claimedDesks() { const s = new Set<string>(); for (const o of this.users.values()) if (o.homeDesk) s.add(`${o.homeDesk.x},${o.homeDesk.y}`); return s; }
  private setDesk(u: User, desk: Tile | null) {
    u.homeDesk = desk;
    this.broadcast({ t: 'desk', userId: u.id, desk });
  }
  claimDesk(u: User) {
    const p = this.position(u);
    if (p.remainingMs > 0 || p.dest.x !== p.tile.x || p.dest.y !== p.tile.y) return; // must be sitting, not walking
    const seat = seatAt(this.map, p.tile.x, p.tile.y);
    if (!seat?.homeDesk) return;
    const owner = this.deskOwner(seat);
    if (owner && owner.id !== u.id) return;
    this.setDesk(u, { x: seat.x, y: seat.y });
  }
  releaseDesk(u: User) { if (u.homeDesk) this.setDesk(u, null); }
  /** Arrive through the Lobby and walk to your desk. */
  private walkHome(u: User) {
    const d = u.homeDesk!;
    const someoneThere = [...this.users.values()].some(o => o.id !== u.id && o.presence !== 'offline' && (() => { const p = this.position(o).dest; return p.x === d.x && p.y === d.y; })());
    if (someoneThere) return;
    u.move = null; u.path = null; u.tile = { ...this.map.spawn };
    this.walk(u, d);
  }

  setStatus(u: User, status: string) {
    u.status = status.slice(0, 80);
    this.broadcast({ t: 'status', userId: u.id, status: u.status });
  }
  setPresence(u: User, presence: Presence) {
    if (u.presence === presence) return;
    u.presence = presence;
    this.broadcast({ t: 'presence', userId: u.id, presence });
  }
  setEmote(u: User, emote: User['emote']) {
    u.emote = emote;
    this.broadcast({ t: 'emote', userId: u.id, emote });
  }

  /** Tiles where nobody is standing or heading. */
  occupied() {
    const s = new Set<string>();
    for (const u of this.users.values()) if (u.presence !== 'offline') { const d = this.position(u).dest; s.add(`${d.x},${d.y}`); }
    return s;
  }

  // ---------- knock ----------
  knock(from: User, to: User) {
    if (from.id === to.id || to.presence === 'offline') return;
    for (const k of this.knocks.values()) if (k.fromId === from.id && (k.state === 'walking' || k.state === 'pending')) this.closeKnock(k, 'later');
    const k: Knock & { timer?: NodeJS.Timeout } = { id: randomUUID().slice(0, 8), fromId: from.id, toId: to.id, state: 'walking' };
    this.knocks.set(k.id, k);
    const room = this.roomOf(to);
    if (room?.rules.knock === 'disabled') {
      return this.closeKnock(k, 'blocked', `${to.name} is in ${room.name} — ${room.rules.label ?? 'no knocking'}`);
    }
    // walk next to them (nearest free neighbouring tile)
    const target = this.position(to).dest;
    const here = this.position(from).next;
    const occ = this.occupied();
    let best: { tile: Tile; len: number } | null = null;
    for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) {
      const t = { x: target.x + dx, y: target.y + dy };
      if (!isWalkable(this.map, t.x, t.y)) continue;
      const mine = here.x === t.x && here.y === t.y;
      if (!mine && occ.has(`${t.x},${t.y}`)) continue;
      const len = mine ? 0 : findPath(this.map, here, t).length;
      if (!mine && !len) continue;
      if (!best || len < best.len) best = { tile: t, len };
    }
    const arriveAt = best && best.len > 0 ? this.walk(from, best.tile) ?? Date.now() : Date.now();
    k.timer = setTimeout(() => this.arrive(k), Math.max(0, arriveAt - Date.now()) + 50);
  }

  private arrive(k: Knock & { timer?: NodeJS.Timeout }) {
    const from = this.users.get(k.fromId), to = this.users.get(k.toId);
    if (!from || !to || k.state !== 'walking') return;
    const room = this.roomOf(to);
    if (room?.rules.knock === 'disabled') return this.closeKnock(k, 'blocked', `${to.name} moved into ${room.name} — no knocking`);
    // face the person
    const a = this.position(from).tile, b = this.position(to).tile;
    from.dir = b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : 'up';
    k.state = 'pending';
    this.setEmote(to, 'knock');
    this.broadcast({ t: 'knock', knockId: k.id, fromId: from.id, toId: to.id });
    if (room?.rules.knock === 'later' || to.presence === 'in_call') {
      k.timer = setTimeout(() => this.closeKnock(k, 'later', `${to.name} is ${room?.rules.occupantLabel ?? 'in a call'} — sent to Later`), 1400);
    } else {
      k.timer = setTimeout(() => this.closeKnock(k, 'later', `${to.name} didn't answer — sent to Later`), 30_000);
      if (to.bot) setTimeout(() => this.reply(to, k.id, Math.random() < 0.65 ? 'accept' : 'later'), 1500 + Math.random() * 2500);
    }
  }

  reply(by: User, knockId: string, reply: 'accept' | 'later') {
    const k = this.knocks.get(knockId);
    if (!k || k.toId !== by.id || k.state !== 'pending') return;
    this.closeKnock(k, reply);
  }

  private closeKnock(k: Knock & { timer?: NodeJS.Timeout }, reply: 'accept' | 'later' | 'blocked', reason?: string) {
    if (k.timer) clearTimeout(k.timer);
    const wasPending = k.state === 'pending';
    k.state = reply;
    const to = this.users.get(k.toId);
    if (to && wasPending && to.emote === 'knock') this.setEmote(to, null);
    const base = { t: 'knock_reply', knockId: k.id, fromId: k.fromId, toId: k.toId, reply, reason } as const;
    if (reply === 'accept' && to) {
      // the knocker's own Meet room, so both land in the same call; else the room's generic link
      const from = this.users.get(k.fromId);
      const room = this.roomOf(to) ?? this.map.rooms.find(r => r.id === 'lobby')!;
      const link = from?.meetLink ?? room.meeting.url;
      const fallback = !from?.meetLink;
      // the link goes only to the two people involved; everyone else just learns the knock is over
      const pair = new Set([k.fromId, k.toId]);
      for (const id of pair) this.sendTo(id, { ...base, link, fallback });
      for (const [id] of this.sockets) if (!pair.has(id)) this.sendTo(id, base);
    } else this.broadcast(base);
    setTimeout(() => this.knocks.delete(k.id), 60_000);
  }

  // ---------- client messages ----------
  handle(u: User, msg: ClientMsg) {
    switch (msg.t) {
      case 'move': {
        for (const k of this.knocks.values()) if (k.fromId === u.id && k.state === 'walking') this.closeKnock(k, 'later', 'Knock cancelled');
        this.walk(u, { x: msg.to.x | 0, y: msg.to.y | 0 });
        break;
      }
      case 'status': this.setStatus(u, String(msg.status ?? '')); break;
      case 'claim_desk': this.claimDesk(u); break;
      case 'release_desk': this.releaseDesk(u); break;
      case 'meet_link': {
        const raw = String(msg.link ?? '');
        const link = raw.trim() ? normalizeMeetLink(raw) : '';
        if (link === null) break; // invalid: ignore, the client validates too
        u.meetLink = link || undefined;
        this.sendTo(u.id, { t: 'me', meetLink: link });
        break;
      }
      case 'presence': if (['online', 'away', 'in_call'].includes(msg.presence)) this.setPresence(u, msg.presence); break;
      case 'knock': { const to = this.users.get(msg.targetId); if (to) this.knock(u, to); break; }
      case 'knock_reply': this.reply(u, msg.knockId, msg.reply === 'accept' ? 'accept' : 'later'); break;
    }
  }

  // ---------- persistence ----------
  dump() {
    return {
      users: [...this.users.values()].map(u => {
        const p = this.position(u).dest;
        return { id: u.id, name: u.name, email: u.email, meetLink: u.meetLink, homeDesk: u.homeDesk, look: u.look, tile: p, dir: u.dir, status: u.status, presence: u.presence, bot: u.bot };
      }),
    };
  }
  load(data: ReturnType<World['dump']>) {
    for (const d of data.users ?? []) {
      const tile = isWalkable(this.map, d.tile.x, d.tile.y) ? d.tile : { ...this.map.spawn };
      this.users.set(d.id, { ...d, homeDesk: d.homeDesk ?? null, tile, move: null, path: null, emote: null, presence: d.bot ? d.presence : 'offline' });
    }
  }
}
