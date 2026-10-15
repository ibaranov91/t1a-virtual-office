import { randomUUID } from 'node:crypto';
import {
  besideObject, dirBetween, earshotDistance, voiceRooms, findPath, isWalkable, pathDuration, pathTo, roomAt, sampleMove, seatAt, WALK_MS_PER_TILE,
  type Dir, type Room, type Spot, type TileMap, type Tile,
} from '../../shared/map';
import {
  EARSHOT_TILES, MAX_CALL_SIZE, MAX_CHAT_LEN, normalizeMeetLink, REACTIONS, ROOM_VOICE_MAX,
  type CallRole, type ChatMsg, type ClientMsg, type Door, type Knock, type Look, type Presence, type PublicUser, type Reaction, type ServerMsg,
} from '../../shared/protocol';
import { authUrl, createSpace, forgetAccess, googleEnabled, revoke, type GoogleLink } from './google';

export interface User extends PublicUser {
  path: Tile[] | null; // path of the current move (server-side bookkeeping)
  email?: string;       // identity from NetBird; never broadcast
  meetLink?: string;    // personal reusable Google Meet room; only shared with knock partners
  google?: GoogleLink;  // Connect Google: encrypted refresh token; never leaves the server
  offlineAt?: number;   // when they walked out the door (not persisted)
  lastSpot?: Tile;      // where they were before heading out (not persisted)
  presenceBeforeCall?: Presence;
  presencePicked?: boolean;
}

interface Call { id: string; members: Set<string>; link?: string; fallback: boolean; room?: Room }

const WALK_HOME_AFTER_MS = 5 * 60_000; // back within this: return to where you were, else your home desk

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
const FOLLOW_LAG_MS = 300;   // followers set off a beat after the person they follow
const HOLD_MS = 3 * 60_000;  // a coffee lasts this long
const USE_MS = { take: 1200, toggle: 150 }; // brewing a coffee vs flicking a switch

/** Dev bots answer DMs and reactions so there's something to talk to when testing alone. */
export interface BotHooks { chat(bot: User, from: User, text: string): void; react(bot: User, from: User, emoji: Reaction): void }

export class World {
  users = new Map<string, User>();
  knocks = new Map<string, Knock & { timer?: NodeJS.Timeout }>();
  private sockets = new Map<string, Map<string, Send>>();
  private owners = new Map<string, string>();
  private waiting = new Map<string, string>();
  private voiceTimers = new Map<string, NodeJS.Timeout>();
  private voiceGeneration = new Map<string, number>();
  private listeners = new Set<Send>();
  private doorTimers = new Map<string, NodeJS.Timeout>();
  private callTimers = new Map<string, NodeJS.Timeout>(); // per member: when they hang up
  private holdTimers = new Map<string, NodeJS.Timeout>(); // per person: when the coffee's finished
  private errands = new Map<string, NodeJS.Timeout>();    // per person: walking over to use an object
  private objectOn = new Map<string, boolean>();          // toggle objects (lamps)
  private objectVolume = new Map<string, number>();      // sound objects (the radio): one shared knob
  private chats = new Map<string, ChatMsg[]>();           // per pair of people, oldest first
  private lastReact = new Map<string, number>();
  botHooks?: BotHooks;

  build?: string; // sent in hello so open pages reload after a deploy
  constructor(public map: TileMap) {
    for (const o of map.objects) if (o.use?.kind === 'toggle') this.objectOn.set(o.id, o.on ?? true);
    for (const o of map.objects) if (o.sound) this.objectVolume.set(o.id, o.sound.gain);
  }

  // ---------- transport ----------
  broadcast(msg: ServerMsg) { for (const l of this.listeners) l(msg); }
  /** Private settings for the user themselves. */
  me(u: User): ServerMsg { return { t: 'me', meetLink: u.meetLink ?? '', email: u.email, google: googleEnabled ? u.google?.email ?? null : undefined }; }
  sendTo(userId: string, msg: ServerMsg) { for (const s of this.sockets.get(userId)?.values() ?? []) s(msg); }
  snapshot(): ServerMsg {
    const objects = Object.fromEntries([...new Set([...this.objectOn.keys(), ...this.objectVolume.keys()])].map(id => [id, this.objectState(id)]));
    return { t: 'state', serverTime: Date.now(), users: [...this.users.values()].map(this.toPublic), objects };
  }
  private toPublic = (u: User): PublicUser => {
    const { path: _p, email: _e, meetLink: _m, google: _g, offlineAt: _o, lastSpot: _l, presenceBeforeCall: _b, presencePicked: _c, ...pub } = u;
    return pub;
  };

  connect(userId: string, send: Send) {
    const u = this.users.get(userId);
    if (!u) throw new Error('unknown user');
    if (!this.sockets.has(userId)) this.sockets.set(userId, new Map());
    const socket = randomUUID();
    this.sockets.get(userId)!.set(socket, send);
    this.listeners.add(send);
    send({ t: 'hello', you: userId, serverTime: Date.now(), build: this.build });
    this.stayAfterAll(u);
    if (u.presence === 'offline') this.comeIn(u);
    send(this.snapshot());
    send(this.me(u));
    send({ t: 'voice_wait', roomId: this.waiting.get(userId) ?? null });
    const call = u.callId ? this.calls.get(u.callId) : undefined; // a reloaded page gets its call's Meet link back
    if (call) send({ t: 'call', userId: u.id, callId: call.id, role: u.callRole ?? undefined, link: call.link });
    this.setOwner(userId, socket);
    return { socket, close: () => {
      this.listeners.delete(send);
      const set = this.sockets.get(userId)!; if (!set.delete(socket)) return;
      if (this.owners.get(userId) === socket) this.setOwner(userId, [...set.keys()].at(-1));
      if (set.size === 0 && !u.bot) { this.setWaiting(u, null); this.startLeaving(u); }
    } };
  }
  private setOwner(userId: string, socket?: string) {
    if (socket) this.owners.set(userId, socket); else this.owners.delete(userId);
    for (const [id, send] of this.sockets.get(userId) ?? []) send({ t: 'voice_owner', owner: id === socket });
  }

  // ---------- arriving & leaving ----------
  /** Back from offline: step in through the exit door, bag in hand, and walk to their spot. */
  private comeIn(u: User) {
    const to = this.arrivalSpot(u); // before going online, so their own old tile doesn't count as taken
    u.tile = { ...this.map.exit }; u.move = null; u.path = null; u.dir = 'down';
    this.setDoor(u, 'arriving');
    this.setPresence(u, 'online');
    const at = this.walk(u, to) ?? Date.now();
    this.doorTimer(u, () => this.setDoor(u, null), Math.max(0, at - Date.now()));
  }
  /** Where you were if you're back soon, else your home desk, else a free Lobby tile — whichever is free. */
  private arrivalSpot(u: User): Tile {
    const occ = this.occupied();
    const free = (t?: Tile | null) => (t && !occ.has(`${t.x},${t.y}`) ? t : null);
    const recent = u.offlineAt !== undefined && Date.now() - u.offlineAt < WALK_HOME_AFTER_MS;
    return (recent && free(u.lastSpot)) || free(u.homeDesk) || this.freeLobbyTile(occ);
  }
  /** A random free Lobby tile, kept clear of the doorway; the spawn point if the Lobby is packed. */
  private freeLobbyTile(occ: Set<string>): Tile {
    const lobby = this.map.rooms.find(r => r.id === 'lobby');
    if (!lobby) return this.map.spawn;
    const { exit } = this.map, { x: rx, y: ry, w, h } = lobby.rect;
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
      this.leaveCall(u);
      this.setFollowing(u, null);
      for (const f of this.users.values()) if (f.following === u.id) this.setFollowing(f, null);
      this.setDoor(u, 'leaving');
      u.lastSpot = this.position(u).dest;
      const at = this.walk(u, this.map.exit, 'up') ?? Date.now();
      this.doorTimer(u, () => {
        this.setDoor(u, null);
        u.offlineAt = Date.now();
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
      move: null, path: null, presence: bot ? 'online' : 'offline', status: '', emote: null, bot, homeDesk: null, door: null, callId: null, callRole: null, deafened: false, hand: false, muted: false,
      following: null, holding: null,
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
    const pos = this.position(u, now);
    const from = pos.next;
    const path = pathTo(this.map, from, to); // also sits down onto a sofa
    if (!path.length) return null;
    const startedAt = Math.round(now + pos.remainingMs);
    face ??= seatAt(this.map, to.x, to.y)?.dir; // sit facing the desk/table
    u.move = { from, to, startedAt, face }; u.path = path; u.tile = to;
    if (face) u.dir = face;
    else if (path.length > 1) { const a = path[path.length - 2], b = path[path.length - 1]; u.dir = b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : 'up'; }
    if (!u.bot && !goingOut(u)) this.walkVoice(u, path, startedAt);
    this.broadcast({ t: 'move', userId: u.id, from, to, startedAt, face });
    for (const f of this.users.values()) if (f.following === u.id) this.trail(f, to, startedAt + FOLLOW_LAG_MS);
    return startedAt + pathDuration(path);
  }

  /** Nearest free tile beside `target` for someone at `from` (their own tile counts as free). */
  private nextTo(target: Tile, from: Tile): Tile | null {
    const occ = this.occupied();
    let best: { tile: Tile; len: number } | null = null;
    for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) {
      const t = { x: target.x + dx, y: target.y + dy };
      if (!isWalkable(this.map, t.x, t.y)) continue;
      const mine = from.x === t.x && from.y === t.y;
      if (!mine && occ.has(`${t.x},${t.y}`)) continue;
      const len = mine ? 0 : findPath(this.map, from, t).length;
      if (!mine && !len) continue;
      if (!best || len < best.len) best = { tile: t, len };
    }
    return best?.tile ?? null;
  }

  // ---------- follow ----------
  follow(u: User, target: User | null) {
    if (target) {
      if (target.id === u.id || target.presence === 'offline' || goingOut(target) || goingOut(u)) return;
      for (let t: User | undefined = target; t; t = t.following ? this.users.get(t.following) : undefined) if (t.id === u.id) return; // no circles
    }
    this.setFollowing(u, target?.id ?? null);
    if (target) this.trail(u, this.position(target).dest);
  }
  private setFollowing(u: User, id: string | null) {
    if (u.following === id) return;
    u.following = id;
    this.broadcast({ t: 'follow', userId: u.id, targetId: id });
  }
  /** Walk up beside where the leader is heading, facing them. A conga line follows on by itself (walk → trail). */
  private trail(f: User, to: Tile, now = Date.now()) {
    const spot = this.nextTo(to, this.position(f, now).next);
    if (spot) this.walk(f, spot, dirBetween(spot, to), now);
  }

  // ---------- objects ----------
  /** Walk over to an object and use it: take something from it, or flip it on/off. */
  use(u: User, objectId: string, itemId?: string) {
    const o = this.map.objects.find(o => o.id === objectId);
    if (!o?.use || goingOut(u)) return;
    const item = o.use.kind === 'take' ? o.use.items.find(i => i.id === itemId) ?? o.use.items[0] : null;
    this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    const here = this.position(u).next, occ = this.occupied();
    let best: { spot: Spot; len: number } | null = null;
    for (const s of besideObject(this.map, o)) {
      const mine = s.x === here.x && s.y === here.y;
      if (!mine && occ.has(`${s.x},${s.y}`)) continue;
      const len = mine ? 0 : findPath(this.map, here, s).length;
      if (!mine && !len) continue;
      if (!best || len < best.len) best = { spot: s, len };
    }
    if (!best) return; // crowded: nowhere to stand
    const spot = best.spot;
    const at = this.walk(u, spot, spot.dir) ?? Date.now();
    this.errands.set(u.id, setTimeout(() => {
      this.errands.delete(u.id);
      const d = this.position(u).dest;
      if (d.x !== spot.x || d.y !== spot.y) return; // wandered off on the way
      if (o.use!.kind === 'toggle') this.setObject(o.id, !this.objectOn.get(o.id), u);
      else if (item) this.setHolding(u, item.id, o.id);
    }, Math.max(0, at - Date.now()) + USE_MS[o.use.kind]));
  }
  private objectState(id: string) { return { on: this.objectOn.get(id) ?? true, volume: this.objectVolume.get(id) }; }
  private setObject(id: string, on: boolean, by: User) {
    this.objectOn.set(id, on);
    this.broadcast({ t: 'object', id, ...this.objectState(id), by: by.id });
  }
  /** Turn a sound object's shared volume knob; everyone hears the change. Like a real radio: only standing next to it. */
  setObjectVolume(u: User, id: string, raw: number) {
    const o = this.map.objects.find(o => o.id === id);
    if (!o || !this.objectVolume.has(id) || !Number.isFinite(raw)) return;
    const p = this.position(u);
    if (p.remainingMs > 0 || p.dest.x !== p.tile.x || p.dest.y !== p.tile.y) return; // still walking
    if (!besideObject(this.map, o).some(s => s.x === p.tile.x && s.y === p.tile.y)) return;
    const volume = Math.round(Math.max(0, Math.min(1, raw)) * 20) / 20;
    if (this.objectVolume.get(id) === volume) return;
    this.objectVolume.set(id, volume);
    this.broadcast({ t: 'object', id, ...this.objectState(id), by: u.id });
  }
  give(u: User, to: User) {
    if (!u.holding || to.id === u.id || to.holding || to.presence === 'offline' || goingOut(to)) return;
    const item = u.holding;
    this.setHolding(u, null);
    this.setHolding(to, item, undefined, u.id);
  }
  setHolding(u: User, item: string | null, objectId?: string, fromId?: string) {
    clearTimeout(this.holdTimers.get(u.id)); this.holdTimers.delete(u.id);
    if (item) this.holdTimers.set(u.id, setTimeout(() => this.setHolding(u, null), HOLD_MS));
    u.holding = item;
    this.broadcast({ t: 'holding', userId: u.id, item, objectId, fromId });
  }

  // ---------- reactions & chat ----------
  react(u: User, to: User, emoji: string) {
    if (!(REACTIONS as readonly string[]).includes(emoji) || to.presence === 'offline') return;
    const now = Date.now();
    if (now - (this.lastReact.get(u.id) ?? 0) < 400) return; // no confetti cannons
    this.lastReact.set(u.id, now);
    this.broadcast({ t: 'react', fromId: u.id, toId: to.id, emoji: emoji as Reaction });
    if (to.bot && !u.bot) this.botHooks?.react(to, u, emoji as Reaction);
  }
  private pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  chat(u: User, to: User, raw: string) {
    const text = raw.trim().slice(0, MAX_CHAT_LEN);
    if (!text || to.id === u.id) return;
    const msg: ChatMsg = { id: randomUUID().slice(0, 8), fromId: u.id, toId: to.id, text, at: Date.now() };
    const key = this.pairKey(u.id, to.id);
    this.chats.set(key, [...(this.chats.get(key) ?? []), msg].slice(-100));
    this.sendTo(u.id, { t: 'chat', msg });
    this.sendTo(to.id, { t: 'chat', msg });
    if (to.bot && !u.bot) this.botHooks?.chat(to, u, text);
  }
  private chatHistory(u: User, withId: string) {
    this.sendTo(u.id, { t: 'chat_history', withId, messages: this.chats.get(this.pairKey(u.id, withId)) ?? [] });
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

  setStatus(u: User, status: string) {
    u.status = status.slice(0, 80);
    this.broadcast({ t: 'status', userId: u.id, status: u.status });
  }
  setPresence(u: User, presence: Presence) {
    if (u.presence === presence) return;
    u.presence = presence;
    this.broadcast({ t: 'presence', userId: u.id, presence });
  }
  // ---------- calls ----------
  // A knock-started conversation. Anyone can knock their way in (except in the Meeting room);
  // everyone in it shares one Meet link. Ends when fewer than two people are left.
  private calls = new Map<string, Call>();

  /** An accepted knock: join the call either of them is already in, or start a new one. Returns the call. */
  connectCall(from: User, to: User): Call {
    const existing = [to, from].map(u => u.callId ? this.calls.get(u.callId) : undefined).find(c => c && !c.room);
    if (existing) {
      for (const u of [from, to]) this.joinCall(u, existing);
      return existing;
    }
    // new call: the knocker's own Meet room, else the other person's, so everyone lands in the same place;
    // with neither, the room's generic link (and no Move to Meet button)
    const room = this.roomOf(to) ?? this.map.rooms.find(r => r.id === 'lobby')!;
    const own = from.meetLink ?? to.meetLink;
    const call: Call = { id: randomUUID().slice(0, 8), members: new Set(), link: own ?? room.meeting.url, fallback: !own };
    this.calls.set(call.id, call);
    for (const u of [from, to]) this.joinCall(u, call);
    this.freshRoom(call, from, to);
    return call;
  }
  /** With Google connected (the knocker's, else the other person's), the call gets its own new Meet room that
   *  anyone in the domain joins without asking. Arrives a moment after the call starts; until then (or if it
   *  fails) the call keeps the link it started with. */
  private freshRoom(call: Call, ...people: User[]) {
    const host = people.find(u => u.google && !u.bot);
    if (!host?.google) return;
    const link = host.google;
    createSpace(host.id, link).then(uri => {
      if (this.calls.get(call.id) !== call) return; // already over
      call.link = uri; call.fallback = false;
      for (const id of call.members) {
        const m = this.users.get(id);
        if (m?.callId === call.id) this.sendTo(id, { t: 'call', userId: id, callId: call.id, role: m.callRole ?? undefined, link: uri });
      }
    }).catch(e => {
      console.warn(`google: no Meet room for ${host.name}:`, e.message);
      if (e.code === 'invalid_grant' && host.google === link) { // they revoked access in their Google account
        host.google = undefined; forgetAccess(host.id); this.sendTo(host.id, this.me(host));
      }
    });
  }
  /** OAuth came back for this user (index.ts checked the account). */
  setGoogle(u: User, link: GoogleLink | undefined) {
    if (u.google && u.google.refresh !== link?.refresh) void revoke(u.id, u.google);
    u.google = link;
    this.sendTo(u.id, this.me(u));
  }
  private clearVoiceTimer(u: User) {
    clearTimeout(this.voiceTimers.get(u.id)); this.voiceTimers.delete(u.id);
  }
  private changeVoice(u: User) {
    this.clearVoiceTimer(u);
    this.voiceGeneration.set(u.id, (this.voiceGeneration.get(u.id) ?? 0) + 1);
  }
  private setWaiting(u: User, roomId: string | null) {
    if ((this.waiting.get(u.id) ?? null) === roomId) return;
    if (roomId) this.waiting.set(u.id, roomId); else this.waiting.delete(u.id);
    this.sendTo(u.id, { t: 'voice_wait', roomId });
  }
  private lowerHand(u: User) {
    if (!u.hand) return;
    u.hand = false; this.broadcast({ t: 'hand', userId: u.id, up: false });
  }
  private stopMember(u: User) {
    this.broadcast({ t: 'speaking', userId: u.id, on: false }); this.lowerHand(u);
    if (!u.presencePicked) this.setPresence(u, u.presenceBeforeCall ?? 'online');
    u.presenceBeforeCall = undefined; u.presencePicked = undefined;
  }
  private joinCall(u: User, call: Call, role: CallRole = 'member') {
    if (u.callId === call.id && u.callRole === role) return;
    if (u.callId !== call.id) this.leaveCall(u);
    else if (u.callRole === 'member') {
      if (call.room && role === 'listener' && this.memberCount(call) === 1) {
        this.maintainRoom(call);
        if (this.memberCount(call) === 1) { this.leaveCall(u); return; }
      }
      this.stopMember(u);
    }
    this.changeVoice(u);
    call.members.add(u.id);
    u.callId = call.id; u.callRole = role;
    if (!call.room) u.muted = false;
    if (role === 'member') {
      u.presenceBeforeCall = u.presence === 'in_call' ? 'online' : u.presence;
      u.presencePicked = false; this.setPresence(u, 'in_call');
      if (call.room) {
        this.setWaiting(u, null);
        for (const k of this.knocks.values()) if ((k.fromId === u.id || k.toId === u.id) && (k.state === 'walking' || k.state === 'pending'))
          this.closeKnock(k, 'later', `Knock cancelled — ${u.name} walked into ${call.room.name}`);
      }
    }
    for (const [id] of this.sockets) this.sendTo(id, { t: 'call', userId: u.id, callId: call.id, role, link: call.members.has(id) ? call.link : undefined });
    if (call.room) { this.maintainRoom(call); return; }
    const humansThere = [...call.members].some(id => !this.users.get(id)?.bot);
    const ms = !u.bot ? 2 * 60 * 60_000 : humansThere ? 120_000 + Math.random() * 180_000 : 30_000 + Math.random() * 60_000;
    this.callTimers.set(u.id, setTimeout(() => this.leaveCall(u), ms));
  }
  private memberCount(call: Call) { return [...call.members].filter(id => this.users.get(id)?.callRole === 'member').length; }
  private maintainRoom(call: Call) {
    for (const [id, roomId] of this.waiting) {
      if (roomId !== call.room!.id || this.memberCount(call) >= ROOM_VOICE_MAX) continue;
      const u = this.users.get(id);
      if (!u || u.bot || !this.sockets.get(id)?.size || goingOut(u)) continue;
      const dest = this.position(u).dest;
      if (roomAt(this.map, dest.x, dest.y)?.id !== roomId) continue;
      this.setWaiting(u, null); this.joinCall(u, call);
    }
    if (this.memberCount(call)) return;
    this.calls.delete(call.id);
    for (const id of [...call.members]) { const u = this.users.get(id); if (u) this.leaveCall(u); }
  }
  callFull(u: User) { const c = u.callId ? this.calls.get(u.callId) : undefined; return !!c && !c.room && c.members.size >= MAX_CALL_SIZE; }
  leaveCall(u: User) {
    const call = u.callId ? this.calls.get(u.callId) : undefined;
    this.changeVoice(u);
    clearTimeout(this.callTimers.get(u.id)); this.callTimers.delete(u.id);
    if (!u.callId) return;
    if (u.callRole === 'member') this.stopMember(u);
    u.callId = null; u.callRole = null; u.muted = false; this.lowerHand(u);
    call?.members.delete(u.id);
    this.broadcast({ t: 'call', userId: u.id, callId: null });
    if (!call || !this.calls.has(call.id)) return;
    if (call.room) this.maintainRoom(call);
    else if (call.members.size < 2) {
      this.calls.delete(call.id);
      for (const id of [...call.members]) { const m = this.users.get(id); if (m) this.leaveCall(m); }
    }
  }
  private walkVoice(u: User, path: Tile[], startedAt: number) {
    this.clearVoiceTimer(u); this.setWaiting(u, null);
    const dest = path[path.length - 1], rooms = voiceRooms(this.map);
    const room = rooms.find(r => roomAt(this.map, dest.x, dest.y)?.id === r.id);
    if (room) {
      const id = `room:${room.id}`;
      if (u.callId === id && u.callRole === 'member') return;
      if (u.callId !== id) this.leaveCall(u);
      let call = this.calls.get(id);
      if (call && this.memberCount(call) >= ROOM_VOICE_MAX) { this.setWaiting(u, room.id); return; }
      if (!call) { call = { id, members: new Set(), fallback: false, room }; this.calls.set(id, call); }
      this.joinCall(u, call); return;
    }
    if (u.callId && !this.calls.get(u.callId)?.room) return;
    for (const r of rooms) {
      const call = this.calls.get(`room:${r.id}`);
      if (!call) continue;
      let i = -1;
      for (let j = 0; j < path.length; j++) if (earshotDistance(this.map, r, path[j].x, path[j].y) <= EARSHOT_TILES) i = j;
      if (i < 0) continue;
      this.joinCall(u, call, 'listener');
      if (u.callId !== call.id) return; // demoting the last member deletes the call
      const generation = this.voiceGeneration.get(u.id);
      const at = startedAt + (i === path.length - 1 ? pathDuration(path) : (i + .5) * WALK_MS_PER_TILE);
      if (at <= Date.now()) { this.leaveCall(u); return; }
      this.voiceTimers.set(u.id, setTimeout(() => {
        if (this.voiceGeneration.get(u.id) === generation && u.callId === call.id && u.callRole === 'listener') this.leaveCall(u);
      }, at - Date.now()));
      return;
    }
    this.leaveCall(u);
  }
  private leaveRoom(u: User) {
    this.setWaiting(u, null);
    const occ = this.occupied(), home = u.homeDesk;
    const to = home && !occ.has(`${home.x},${home.y}`) ? home : this.freeLobbyTile(occ);
    if (this.walk(u, to) === null) this.leaveCall(u);
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
  private knockBlock(from: User, to: User) {
    const dest = this.position(to).dest, target = roomAt(this.map, dest.x, dest.y);
    if (target?.rules.voice === 'open') return `${to.name} is in ${target.name} — just walk in`;
    const room = from.callId ? this.calls.get(from.callId)?.room : undefined;
    if (room && from.callRole === 'member') return `You're in ${room.name} voice — step out to knock`;
  }
  knock(from: User, to: User) {
    if (from.id === to.id || to.presence === 'offline' || goingOut(from)) return;
    if (from.callId && from.callId === to.callId) return; // already talking
    this.setFollowing(from, null);
    for (const k of this.knocks.values()) if (k.fromId === from.id && (k.state === 'walking' || k.state === 'pending')) this.closeKnock(k, 'later');
    const k: Knock & { timer?: NodeJS.Timeout } = { id: randomUUID().slice(0, 8), fromId: from.id, toId: to.id, state: 'walking' };
    this.knocks.set(k.id, k);
    const reason = this.knockBlock(from, to);
    if (reason) return this.closeKnock(k, 'blocked', reason);
    const room = this.roomOf(to);
    if (goingOut(to)) return this.closeKnock(k, 'blocked', `${to.name} is heading out`);
    if (this.callFull(to)) return this.closeKnock(k, 'blocked', `${to.name}'s call is full (${MAX_CALL_SIZE}) — try Meet`);
    if (room?.rules.knock === 'disabled') {
      return this.closeKnock(k, 'blocked', `${to.name} is in ${room.name} — ${room.rules.label ?? 'no knocking'}`);
    }
    // walk next to them (nearest free neighbouring tile)
    const here = this.position(from).next;
    const spot = this.nextTo(this.position(to).dest, here);
    const arriveAt = spot && (spot.x !== here.x || spot.y !== here.y) ? this.walk(from, spot) ?? Date.now() : Date.now();
    k.timer = setTimeout(() => this.arrive(k), Math.max(0, arriveAt - Date.now()) + 50);
  }

  private arrive(k: Knock & { timer?: NodeJS.Timeout }) {
    const from = this.users.get(k.fromId), to = this.users.get(k.toId);
    if (!from || !to || k.state !== 'walking') return;
    const reason = this.knockBlock(from, to);
    if (reason) return this.closeKnock(k, 'blocked', reason);
    const room = this.roomOf(to);
    if (goingOut(to)) return this.closeKnock(k, 'blocked', `${to.name} is heading out`);
    if (room?.rules.knock === 'disabled') return this.closeKnock(k, 'blocked', `${to.name} moved into ${room.name} — no knocking`);
    // face the person
    const a = this.position(from).tile, b = this.position(to).tile;
    from.dir = b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : 'up';
    k.state = 'pending';
    this.setEmote(to, 'knock');
    this.broadcast({ t: 'knock', knockId: k.id, fromId: from.id, toId: to.id });
    if (room?.rules.knock === 'later' || (to.presence === 'in_call' && !to.callId)) {
      k.timer = setTimeout(() => this.closeKnock(k, 'later', `${to.name} is ${room?.rules.occupantLabel ?? 'in a call'} — sent to Later`), 1400);
    } else {
      k.timer = setTimeout(() => this.closeKnock(k, 'later', `${to.name} didn't answer — sent to Later`), 30_000);
      if (to.bot) setTimeout(() => this.reply(to, k.id, Math.random() < 0.65 ? 'accept' : 'later'), 1500 + Math.random() * 2500);
    }
  }

  reply(by: User, knockId: string, reply: 'accept' | 'later') {
    const k = this.knocks.get(knockId);
    if (!k || k.toId !== by.id || k.state !== 'pending') return;
    if (reply === 'accept') {
      const from = this.users.get(k.fromId);
      const reason = from && this.knockBlock(from, by);
      if (reason) return this.closeKnock(k, 'blocked', reason);
    }
    this.closeKnock(k, reply);
  }

  private closeKnock(k: Knock & { timer?: NodeJS.Timeout }, reply: 'accept' | 'later' | 'blocked', reason?: string, cancelled?: boolean) {
    if (k.timer) clearTimeout(k.timer);
    const wasPending = k.state === 'pending';
    k.state = reply;
    const to = this.users.get(k.toId);
    if (to && wasPending && to.emote === 'knock') this.setEmote(to, null);
    const base = { t: 'knock_reply', knockId: k.id, fromId: k.fromId, toId: k.toId, reply, reason, cancelled } as const;
    if (reply === 'accept' && to) {
      // join (or start) the call; whoever they knocked, everyone in it shares the same Meet link
      const from = this.users.get(k.fromId);
      const call = from ? this.connectCall(from, to) : null;
      // the link goes only to the two people involved; everyone else just learns the knock is over
      const pair = new Set([k.fromId, k.toId]);
      for (const id of pair) this.sendTo(id, { ...base, link: call?.link, fallback: call?.fallback });
      for (const [id] of this.sockets) if (!pair.has(id)) this.sendTo(id, base);
    } else this.broadcast(base);
    setTimeout(() => this.knocks.delete(k.id), 60_000);
  }

  // ---------- client messages ----------
  handle(u: User, msg: ClientMsg, socket: string) {
    if (!this.sockets.get(u.id)?.has(socket)) return;
    if (msg.t === 'voice_claim') { this.setOwner(u.id, socket); return; }
    if (['rtc', 'speaking', 'mute', 'deafen', 'hand'].includes(msg.t) && this.owners.get(u.id) !== socket) return;
    switch (msg.t) {
      case 'move': {
        for (const k of this.knocks.values()) if (k.fromId === u.id && k.state === 'walking') this.closeKnock(k, 'later', 'Knock cancelled', true);
        if (u.door === 'arriving') { this.doorTimer(u, null); this.setDoor(u, null); } // off on their own way: bag's put away
        this.setFollowing(u, null);
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
        this.sendTo(u.id, this.me(u));
        break;
      }
      case 'google_connect': if (googleEnabled) this.sendTo(u.id, { t: 'google_auth', url: authUrl(u.id, u.google?.email ?? u.email) }); break;
      case 'google_disconnect': this.setGoogle(u, undefined); break;
      case 'presence': {
        if (!['online', 'away', 'in_call'].includes(msg.presence)) break;
        if (u.callId && this.calls.get(u.callId)?.room) u.presencePicked = true;
        else if (msg.presence !== 'in_call') this.leaveCall(u); // switching away from "in a call" hangs up
        this.setPresence(u, msg.presence);
        break;
      }
      case 'leave_room': if ((u.callId && this.calls.get(u.callId)?.room) || this.waiting.has(u.id)) this.leaveRoom(u); break; // a stale AFK/Leave mustn't walk anyone else home
      case 'end_call': if (u.callId && this.calls.get(u.callId)?.room) this.leaveRoom(u); else this.leaveCall(u); break;
      case 'deafen': if (u.callId) { u.deafened = !!msg.on; this.broadcast({ t: 'deafen', userId: u.id, on: u.deafened }); } break;
      case 'hand': if (u.callRole === 'member' && u.callId && this.calls.get(u.callId)?.room) { u.hand = !!msg.up; this.broadcast({ t: 'hand', userId: u.id, up: u.hand }); } break;
      case 'to_meet': {
        const call = u.callId ? this.calls.get(u.callId) : undefined;
        if (call && !call.fallback && !call.room) for (const id of call.members) if (id !== u.id) this.sendTo(id, { t: 'to_meet', fromId: u.id });
        break;
      }
      // voice: relay WebRTC signaling only between members of the same call
      case 'rtc': {
        const to = this.users.get(String(msg.to));
        if (u.callId && to?.callId === u.callId && to.id !== u.id && !u.bot && !to.bot && !goingOut(u) && !goingOut(to) && u.presence !== 'offline' && to.presence !== 'offline' && (u.callRole === 'member' || to.callRole === 'member')) {
          const owner = this.owners.get(to.id);
          if (owner) this.sockets.get(to.id)?.get(owner)?.({ t: 'rtc', from: u.id, signal: msg.signal });
        }
        break;
      }
      case 'speaking': if (u.callRole === 'member') this.broadcast({ t: 'speaking', userId: u.id, on: !!msg.on }); break;
      case 'mute': if (u.callId) { u.muted = !!msg.muted; this.broadcast({ t: 'mute', userId: u.id, muted: u.muted }); } break;
      case 'knock': { const to = this.users.get(msg.targetId); if (to) this.knock(u, to); break; }
      case 'knock_reply': this.reply(u, msg.knockId, msg.reply === 'accept' ? 'accept' : 'later'); break;
      case 'knock_cancel': {
        const k = this.knocks.get(String(msg.knockId));
        if (k?.fromId === u.id && (k.state === 'walking' || k.state === 'pending')) this.closeKnock(k, 'later', 'Knock cancelled', true);
        break;
      }
      case 'follow': {
        const to = msg.targetId ? this.users.get(String(msg.targetId)) : null;
        if (to !== undefined) this.follow(u, to);
        break;
      }
      case 'react': { const to = this.users.get(String(msg.targetId)); if (to) this.react(u, to, String(msg.emoji)); break; }
      case 'chat': { const to = this.users.get(String(msg.toId)); if (to) this.chat(u, to, String(msg.text ?? '')); break; }
      case 'chat_history': this.chatHistory(u, String(msg.withId)); break;
      case 'object_volume': this.setObjectVolume(u, String(msg.id), Number(msg.volume)); break;
      case 'use': this.use(u, String(msg.objectId), msg.item === undefined ? undefined : String(msg.item)); break;
      case 'drop': if (u.holding) this.setHolding(u, null); break;
      case 'give': { const to = this.users.get(String(msg.targetId)); if (to) this.give(u, to); break; }
    }
  }

  // ---------- persistence ----------
  dump() {
    return {
      users: [...this.users.values()].map(u => {
        const p = this.position(u).dest;
        return { id: u.id, name: u.name, email: u.email, meetLink: u.meetLink, google: u.google, homeDesk: u.homeDesk, look: u.look, tile: p, dir: u.dir, status: u.status, presence: u.presence, bot: u.bot };
      }),
      objects: Object.fromEntries(this.objectOn),
      objectVolumes: Object.fromEntries(this.objectVolume),
      chats: Object.fromEntries(this.chats),
    };
  }
  load(data: ReturnType<World['dump']>) {
    for (const d of data.users ?? []) {
      const tile = isWalkable(this.map, d.tile.x, d.tile.y) || seatAt(this.map, d.tile.x, d.tile.y) ? d.tile : { ...this.map.spawn };
      this.users.set(d.id, { ...d, homeDesk: d.homeDesk ?? null, tile, move: null, path: null, emote: null, door: null, callId: null, callRole: null, deafened: false, hand: false, muted: false, following: null, holding: null, presence: d.bot ? d.presence : 'offline' });
    }
    for (const [id, on] of Object.entries(data.objects ?? {})) if (this.objectOn.has(id)) this.objectOn.set(id, !!on);
    for (const [id, v] of Object.entries(data.objectVolumes ?? {})) if (this.objectVolume.has(id) && Number.isFinite(v)) this.objectVolume.set(id, Math.max(0, Math.min(1, v)));
    for (const [key, msgs] of Object.entries(data.chats ?? {})) this.chats.set(key, msgs);
  }
}
