import { randomUUID } from 'node:crypto';
import {
  findPath, isWalkable, pathDuration, roomAt, sampleMove, WALK_MS_PER_TILE,
  type Dir, type TileMap, type Tile,
} from '../../shared/map';
import type { ClientMsg, Door, Knock, Look, Presence, PublicUser, ServerMsg } from '../../shared/protocol';

export interface User extends PublicUser {
  path: Tile[] | null; // path of the current move (server-side bookkeeping)
  email?: string;       // identity from NetBird; never broadcast
}

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

const LEAVE_GRACE_MS = 5000; // a dropped tab or quick re-login shouldn't send anyone home
const DOOR_PAUSE_MS = 400;   // a beat at the door before vanishing
/** Packing up or walking out: not around any more, as far as knocks go. */
const goingOut = (u: User) => u.door === 'thinking' || u.door === 'leaving';

export class World {
  users = new Map<string, User>();
  knocks = new Map<string, Knock & { timer?: NodeJS.Timeout }>();
  private sockets = new Map<string, Set<Send>>();
  private listeners = new Set<Send>();
  private doorTimers = new Map<string, NodeJS.Timeout>();

  constructor(public map: TileMap) {}

  // ---------- transport ----------
  broadcast(msg: ServerMsg) { for (const l of this.listeners) l(msg); }
  sendTo(userId: string, msg: ServerMsg) { for (const s of this.sockets.get(userId) ?? []) s(msg); }
  snapshot(): ServerMsg {
    return { t: 'state', serverTime: Date.now(), users: [...this.users.values()].map(this.toPublic) };
  }
  private toPublic = (u: User): PublicUser => {
    const { path: _p, email: _e, ...pub } = u;
    return pub;
  };

  connect(userId: string, send: Send) {
    const u = this.users.get(userId);
    if (!u) throw new Error('unknown user');
    if (!this.sockets.has(userId)) this.sockets.set(userId, new Set());
    this.sockets.get(userId)!.add(send);
    this.listeners.add(send);
    send({ t: 'hello', you: userId, serverTime: Date.now() });
    this.stayAfterAll(u);
    if (u.presence === 'offline') this.comeIn(u);
    send(this.snapshot());
    return () => {
      this.listeners.delete(send);
      const set = this.sockets.get(userId)!; set.delete(send);
      if (set.size === 0 && !u.bot) this.startLeaving(u);
    };
  }

  // ---------- arriving & leaving ----------
  /** Back from offline: step in through the exit door, bag in hand, and walk to the lobby. */
  private comeIn(u: User) {
    const to = this.freeLobbyTile(); // before going online, so their own old tile doesn't count as taken
    u.tile = { ...this.map.exit }; u.move = null; u.path = null; u.dir = 'down';
    this.setDoor(u, 'arriving');
    this.setPresence(u, 'online');
    const at = this.walk(u, to) ?? Date.now();
    this.doorTimer(u, () => this.setDoor(u, null), Math.max(0, at - Date.now()));
  }
  /** A random free Lobby tile, kept clear of the doorway; the spawn point if the Lobby is packed. */
  private freeLobbyTile(): Tile {
    const lobby = this.map.rooms.find(r => r.id === 'lobby');
    if (!lobby) return this.map.spawn;
    const occ = this.occupied(), { exit } = this.map, { x: rx, y: ry, w, h } = lobby.rect;
    const free: Tile[] = [];
    for (let y = ry; y < ry + h; y++) for (let x = rx; x < rx + w; x++) {
      if (!isWalkable(this.map, x, y) || occ.has(`${x},${y}`)) continue;
      if (Math.abs(x - exit.x) + Math.abs(y - exit.y) < 2) continue;
      free.push({ x, y });
    }
    return free.length ? free[Math.floor(Math.random() * free.length)] : this.map.spawn;
  }
  /** Last socket closed: think it over for a moment, then grab the bag and head out. */
  private startLeaving(u: User) {
    this.setDoor(u, 'thinking');
    this.doorTimer(u, () => {
      for (const k of this.knocks.values()) if (k.fromId === u.id && (k.state === 'walking' || k.state === 'pending')) this.closeKnock(k, 'later', 'Knock cancelled');
      this.setDoor(u, 'leaving');
      const at = this.walk(u, this.map.exit, 'up') ?? Date.now();
      this.doorTimer(u, () => {
        this.setDoor(u, null);
        this.setPresence(u, 'offline');
      }, Math.max(0, at - Date.now()) + DOOR_PAUSE_MS);
    }, LEAVE_GRACE_MS);
  }
  /** Reconnected before they were out the door: put the bag down and stay where they are. */
  private stayAfterAll(u: User) {
    if (!goingOut(u)) return; // e.g. a second tab while still walking in
    this.doorTimer(u, null);
    if (u.door === 'leaving' && u.move) this.walk(u, this.position(u).next);
    this.setDoor(u, null);
  }
  /** One pending door step per person; a new one (or null) replaces it. */
  private doorTimer(u: User, fn: (() => void) | null, ms = 0) {
    clearTimeout(this.doorTimers.get(u.id));
    this.doorTimers.delete(u.id);
    if (fn) this.doorTimers.set(u.id, setTimeout(() => { this.doorTimers.delete(u.id); fn(); }, ms));
  }
  private setDoor(u: User, door: Door) {
    if (u.door === door) return;
    u.door = door;
    this.broadcast({ t: 'door', userId: u.id, door });
  }

  // ---------- users ----------
  addUser(name: string, bot = false, tile?: Tile, email?: string): User {
    const u: User = {
      email,
      id: randomUUID().slice(0, 8), name, look: lookFor(name), tile: tile ?? { ...this.map.spawn }, dir: 'down',
      move: null, path: null, presence: bot ? 'online' : 'offline', status: '', emote: null, bot, door: null,
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
    u.move = { from, to, startedAt, face }; u.path = path; u.tile = to;
    if (face) u.dir = face;
    else if (path.length > 1) { const a = path[path.length - 2], b = path[path.length - 1]; u.dir = b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : 'up'; }
    this.broadcast({ t: 'move', userId: u.id, from, to, startedAt, face });
    return startedAt + pathDuration(path);
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
    if (from.id === to.id || to.presence === 'offline' || goingOut(from)) return;
    for (const k of this.knocks.values()) if (k.fromId === from.id && (k.state === 'walking' || k.state === 'pending')) this.closeKnock(k, 'later');
    const k: Knock & { timer?: NodeJS.Timeout } = { id: randomUUID().slice(0, 8), fromId: from.id, toId: to.id, state: 'walking' };
    this.knocks.set(k.id, k);
    const room = this.roomOf(to);
    if (goingOut(to)) return this.closeKnock(k, 'blocked', `${to.name} is heading out`);
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
    if (goingOut(to)) return this.closeKnock(k, 'blocked', `${to.name} is heading out`);
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
    let link: string | undefined;
    if (reply === 'accept' && to) {
      const room = this.roomOf(to) ?? this.map.rooms.find(r => r.id === 'lobby')!;
      link = room.meeting.url;
    }
    this.broadcast({ t: 'knock_reply', knockId: k.id, fromId: k.fromId, toId: k.toId, reply, link, reason });
    setTimeout(() => this.knocks.delete(k.id), 60_000);
  }

  // ---------- client messages ----------
  handle(u: User, msg: ClientMsg) {
    switch (msg.t) {
      case 'move': {
        for (const k of this.knocks.values()) if (k.fromId === u.id && k.state === 'walking') this.closeKnock(k, 'later', 'Knock cancelled');
        if (u.door === 'arriving') { this.doorTimer(u, null); this.setDoor(u, null); } // off on their own way: bag's put away
        this.walk(u, { x: msg.to.x | 0, y: msg.to.y | 0 });
        break;
      }
      case 'status': this.setStatus(u, String(msg.status ?? '')); break;
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
        return { id: u.id, name: u.name, email: u.email, look: u.look, tile: p, dir: u.dir, status: u.status, presence: u.presence, bot: u.bot };
      }),
    };
  }
  load(data: ReturnType<World['dump']>) {
    for (const d of data.users ?? []) {
      const tile = isWalkable(this.map, d.tile.x, d.tile.y) ? d.tile : { ...this.map.spawn };
      this.users.set(d.id, { ...d, tile, move: null, path: null, emote: null, door: null, presence: d.bot ? d.presence : 'offline' });
    }
  }
}
