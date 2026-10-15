import { randomUUID } from 'node:crypto';
import {
  adminOnly, applyEdit, stallDoor, stallLine, applyLayout, besideObject, playSpots, dirBetween, doorwayTiles, KEEP_TYPES, migrateEastWing, layoutProblem, objectName, voiceRooms, findPath, isWalkable, pathDuration, pathTo, roomAt, routes, sampleMove, seatAt, uniqueIds, withLayout, WALK_MS_PER_TILE,
  type MapObject, type Dir, type Layout, type Room, type Spot, type TileMap, type Tile,
} from '../../shared/map';
import {
  NOTE_RATE, NOTE_BURST, ITEMS_MAX, TOILET_SHELF_ITEM, toiletFull, NOTE_HELD_MAX, SEAT_CHANGES_PER_10S, DUNGEON_INSTANCE, underground, MAX_CALL_SIZE, MEETING_ROOM_ID, MAX_CHAT_LEN, normalizeMeetLink, REACTIONS, ROOM_VOICE_MAX,
  CUP_ITEMS, BOOK_ITEM, BOOKWORM_READS, EDITOR_READERS, dayNumber, isTimeZone, plantDead, BOTANIST_KINDS, PLANT_KINDS, PLANT_STAGES, type Plant,
  type ChatMsg, type ClientMsg, type Door, type Effect, type Knock, type LayoutEdit, type Look, type Presence, type PublicUser, type Reaction, type ServerMsg,
} from '../../shared/protocol';
import { FOOD_ITEMS, LUNCH_MS, PLATE_PREFIX, picnicSeat, type Eating } from '../../shared/lunch';
import { INSTRUMENTS, validNote } from '../../shared/instruments';
import { ADMIN_HAT, BAT_HAT, DANCE_ROOM, EFFECTS, HAT_NAMES, JUDGE_HAT, JUDGE_HATS, MAX_EFFECTS, RAVER_MS, hatItem, hatOf, isJudgeHat, walkMs } from '../../shared/effects';
import { TRACKS } from '../../shared/music';
import { Arcade } from './arcade';
import { Jukebox } from './jukebox';
import { Library } from './library';
import { migrateLibrary, readingSeats } from '../../shared/library';
import { Meetings } from './meetings';
import { BAT_COOLDOWN_MS, Creatures } from './creatures';
import type { Presenter } from './presentation';
import { Toilets } from './toilets';
import { authUrl, CALENDAR_SCOPE, createSpace, forgetAccess, googleEnabled, listEvents, revoke, type GoogleLink } from './google';

type DungeonEvent = Extract<ServerMsg, { t: 'dungeon' }>['event'];
interface DungeonTimer { seq: number; at: number; timer: NodeJS.Timeout; run: () => void }
export interface User extends PublicUser {
  walkSeq?: number;
  dungeon?: { key: Tile | null; hasKey: boolean };
  lastKeySpot?: Tile;
  dungeonTimers?: Partial<Record<'fall' | 'key' | 'door' | 'opening', DungeonTimer>>;
  path: Tile[] | null; // path of the current move (server-side bookkeeping)
  danced?: number;     // ms spent dancing in Berghain, in total (saved; toward the `raver` achievement)
  items: string[];     // inventory (what the bouncer sold you); only sent to the owner
  email?: string;       // identity from NetBird; never broadcast
  meetLink?: string;    // personal reusable Google Meet room; only shared with knock partners
  google?: GoogleLink;  // Connect Google: encrypted refresh token; never leaves the server
  returnTo?: Tile;      // where they were in the office before stepping into a meeting's room
  offlineAt?: number;   // when they walked out the door (not persisted)
  lastSpot?: Tile;      // where they were before heading out (not persisted)
  presenceBeforeCall?: Presence;
  prev?: { path: Tile[]; startedAt: number; ms?: number };
  afk?: boolean;
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
    shirt: SHIRTS[(h >>> 9) % SHIRTS.length], pants: PANTS[(h >>> 14) % PANTS.length], eyes: '#2b1d1f', shoes: '#4a3028',
    style: (h >>> 20) % 3, top: 0, bottom: 0, glasses: 0, hat: 0, glassesColor: '#282832', hatColor: '#3e5a8a',
  };
};

type Send = (msg: ServerMsg) => void;

const LEAVE_GRACE_MS = 5000; // a dropped tab or quick re-login shouldn't send anyone home
const DOOR_PAUSE_MS = 400;   // a beat at the door before vanishing
/** Packing up or walking out: not around any more, as far as knocks go. */
const goingOut = (u: User) => u.door === 'thinking' || u.door === 'leaving';
const MAX_JUDGES = 50;
const FOLLOW_LAG_MS = 300;   // followers set off a beat after the person they follow
const HOLD_MS = 3 * 60_000;  // a coffee lasts this long
const USE_MS = { take: 1200, toggle: 150, toilet: 300, dealer: 350, bell: 100 }; // brewing a coffee vs flicking a switch
const ARRIVAL_SLACK_MS = 50; // timers can fire a millisecond before the walk is over

/** Office admins rearrange the furniture: NetBird emails, or (only for name logins, so dev) plain names. */
const ADMINS = (process.env.DECK_ADMINS ?? 'ivan.baranov@t1a.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
/** Hackathon judges each wear their own hat, which an admin assigns in the Judges panel (kept in state.json). This list only
 *  seeds a fresh state with the first hats in turn; same rules as admins: emails, or plain names for name logins (dev). */
const JUDGE_SEED = (process.env.DECK_JUDGES ?? 'oleg.mikhov@t1a.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const listed = (list: string[], u: User) => !u.bot && list.some(a => (a.includes('@') ? a === u.email : !u.email && a === u.name.toLowerCase()));

/** Dev bots answer DMs and reactions so there's something to talk to when testing alone. */
export interface BotHooks { chat(bot: User, from: User, text: string): void; react(bot: User, from: User, emoji: Reaction): void }

export class World {
  users = new Map<string, User>();
  knocks = new Map<string, Knock & { timer?: NodeJS.Timeout }>();
  private sockets = new Map<string, Map<string, Send>>();
  private owners = new Map<string, string>();
  private waiting = new Map<string, string>();
  private listeners = new Set<Send>();
  private doorTimers = new Map<string, NodeJS.Timeout>();
  private callTimers = new Map<string, NodeJS.Timeout>(); // per member: when they hang up
  private holdTimers = new Map<string, NodeJS.Timeout>(); // per person: when the coffee's finished
  private lastRing = new Map<string, number>();            // per person: when they last rang a bell
  private errands = new Map<string, NodeJS.Timeout>();    // per person: walking over to use an object
  private seats = new Map<string, { user: string; socket: string; held: Set<number> }>();
  private pendingSeat = new Map<string, { objectId: string; socket: string; spot: Spot; timer: NodeJS.Timeout }>();
  private noteBuckets = new Map<string, { tokens: number; at: number }>();
  private seatChanges = new Map<string, number[]>();
  private jukeboxes = new Map<string, Jukebox>();
  library = new Library();
  private readPlans = new Map<string, { articleId: string; seat: Tile; seq: number }>(); // on the way to a reading desk
  private objectOn = new Map<string, boolean>();          // toggle objects (lamps)
  private chats = new Map<string, ChatMsg[]>();           // per pair of people, oldest first
  private lastJukeboxControl = new Map<string, number>();
  private lastReact = new Map<string, number>();
  toilets = new Toilets({
    change: (id, state) => { this.broadcast({ t: 'toilet', id, state }); this.lineUp(id); },
    admit: (id, userId) => { const o = this.map.objects.find(o => o.id === id), u = this.users.get(userId); if (o && u) this.toiletWalk(u, stallDoor(o)); },
    refuse: (_id, userIds) => { for (const id of userIds) this.sendTo(id, { t: 'notice', text: 'The toilet overflowed 🤢 — the line breaks up' }); },
  });
  private toiletWalks = new Set<string>(); // walks the toilets start themselves (into the stall, along the line): not walking off
  botHooks?: BotHooks;
  present?: Presenter; // slides on the Meeting room screen (index.ts sets it up with the data folder)

  arcade = new Arcade({ now: () => Date.now(), send: (id, msg) => this.sendOwner(id, msg),
    broadcast: msg => this.broadcast(msg), user: id => this.users.get(id) });

  creatures = new Creatures({ map: () => this.map, broadcast: msg => this.broadcast(msg),
    people: () => [...this.users.values()].filter(u => u.presence !== 'offline' && !u.instance).map(u => this.position(u).dest),
    personTile: id => { const p = this.users.get(id); return p && p.presence !== 'offline' && !p.instance ? this.position(p).dest : null; } });
  private petDays = new Map<string, { day: number; kinds: Set<string> }>(); // who has petted what today (memory only)
  private batTries = new Map<string, number>();                             // last try at the bat, per person
  build?: string; // sent in hello so open pages reload after a deploy
  private baseLayout: Layout;     // as generated, for Reset
  private judges: { who: string; hat: string }[] = JUDGE_SEED.map((who, i) => ({ who, hat: JUDGE_HATS[i % JUDGE_HATS.length] }));
  private layoutEdited = false;   // saved only once someone has changed it
  private editSeq = 0;
  constructor(public map: TileMap) {
    this.baseLayout = structuredClone({ objects: map.objects, rugs: map.rugs });
    for (const o of map.objects) if (o.use?.kind === 'toggle') this.objectOn.set(o.id, o.on ?? true);
    this.syncJukeboxes();
    setInterval(() => { const now = Date.now(); this.voiceTick(now); this.jukeboxTick(now); this.instrumentTick(now); this.effectsTick(now); this.lunchTick(now); this.toilets.tick(now); }, 250).unref();
  }

  // ---------- transport ----------
  broadcast(msg: ServerMsg) { for (const l of this.listeners) l(msg); }
  /** Private settings for the user themselves. */
  me(u: User): ServerMsg { return { t: 'me', meetLink: u.meetLink ?? '', email: u.email, google: googleEnabled ? u.google?.email ?? null : undefined, calendar: !!u.google?.scopes.includes(CALENDAR_SCOPE), admin: this.isAdmin(u) || undefined, judge: this.isJudge(u) || undefined, items: u.items.length ? u.items : undefined }; }
  isAdmin(u: User) { return listed(ADMINS, u); }
  judgeHat(u: User) { return this.judges.find(j => listed([j.who], u))?.hat; }
  isJudge(u: User) { return !!this.judgeHat(u); }
  private judgeList(): ServerMsg { return { t: 'judges', judges: this.judges.map(j => ({ ...j, name: [...this.users.values()].find(u => listed([j.who], u))?.name })) }; }
  hasItem(u: User, item: string) { return u.items.includes(item); }
  /** Put one in the inventory (at most ITEMS_MAX of a kind) and tell the owner. */
  addItem(u: User, item: string) {
    const max = hatOf(item) ? 1 : ITEMS_MAX;
    if (u.items.filter(i => i === item).length >= max) { this.sendTo(u.id, { t: 'notice', text: hatOf(item) ? 'You already have that hat' : 'Your pockets are full' }); return false; }
    u.items = [...u.items, item]; this.sendTo(u.id, this.me(u));
    return true;
  }
  takeItem(u: User, item: string) {
    const i = u.items.indexOf(item); if (i < 0) return false;
    u.items = u.items.filter((_, j) => j !== i); this.sendTo(u.id, this.me(u));
    return true;
  }
  layout(): Layout { return { objects: this.map.objects, rugs: this.map.rugs }; }
  sendTo(userId: string, msg: ServerMsg) { for (const s of this.sockets.get(userId)?.values() ?? []) s(msg); }
  private sendOwner(userId: string, msg: ServerMsg) {
    const owner = this.owners.get(userId);
    if (owner) this.sockets.get(userId)?.get(owner)?.(msg);
  }
  snapshot(): ServerMsg {
    const objects = Object.fromEntries([...this.objectOn.keys()].map(id => [id, this.objectState(id)]));
    return { t: 'state', serverTime: Date.now(), users: [...this.users.values()].map(this.toPublic), objects,
      toilets: this.toilets.snapshot(this.map.objects.filter(o => o.use?.kind === 'toilet').map(o => o.id)),
      instruments: Object.fromEntries(this.map.objects.filter(o => o.use?.kind === 'instrument').map(o => [o.id, this.seats.get(o.id)?.user ?? null])),
      jukebox: Object.fromEntries([...this.jukeboxes].map(([id, j]) => [id, j.state])) };
  }
  private toPublic = (u: User): PublicUser => {
    const { path: _p, email: _e, meetLink: _m, google: _g, offlineAt: _o, lastSpot: _l, presenceBeforeCall: _b, prev: _v, afk: _a, returnTo: _r, walkSeq: _s, dungeon: _d, lastKeySpot: _k, dungeonTimers: _t, ...pub } = u;
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
    this.grantHats(u);
    if (!u.plant && !u.bot) { u.plant = this.newPlant(u, dayNumber(Date.now()) - 1); this.plantChanged(u); } // a pot on your desk from day one; today's status already grows it
    if (u.presence === 'offline') this.comeIn(u);
    send({ t: 'layout', layout: this.layout() }); // before anyone's walk, which every client paths on this floor
    send(this.snapshot());
    send(this.me(u));
    if (this.isAdmin(u)) send(this.judgeList());
    if (underground(u) && u.dungeon) send({ t: 'dungeon', ...u.dungeon });
    if (u.reading) this.stopReading(u); // a fresh page has no overlay; the old read ends
    send({ t: 'meetings', rooms: this.meetingRooms() });
    send({ t: 'library', ...this.library.state() });
    send({ t: 'creatures', creatures: this.creatures.all() });
    send({ t: 'cups', cups: this.creatures.cups });
    send({ t: 'arcade', cabinets: this.arcade.summary() });
    send({ t: 'arcade_records', records: structuredClone(this.arcade.records) });
    for (const person of this.users.values()) send({ t: 'game_status', userId: person.id, game: person.game });
    if (!u.bot) this.meetings.sendAgenda(u, true);
    send({ t: 'voice_wait', roomId: this.waiting.get(userId) ?? null });
    send({ t: 'presentation', live: this.present?.live ?? null });
    this.present?.back(u.id);
    const call = u.callId ? this.calls.get(u.callId) : undefined; // a reloaded page gets its call's Meet link back
    if (call) send({ t: 'call', userId: u.id, callId: call.id, link: call.link });
    this.setOwner(userId, socket);
    return { socket, close: () => {
      this.listeners.delete(send);
      const set = this.sockets.get(userId)!; if (!set.delete(socket)) return;
      if (this.pendingSeat.get(userId)?.socket === socket) this.cancelSeatWalk(userId);
      for (const [id, seat] of this.seats) if (seat.socket === socket) this.endSeat(id);
      if (this.owners.get(userId) === socket) this.setOwner(userId, [...set.keys()].at(-1));
      if (set.size === 0 && !u.bot) { this.setWaiting(u, null); this.startLeaving(u); this.present?.gone(u.id); }
    } };
  }
  private setOwner(userId: string, socket?: string) {
    const old = this.owners.get(userId), u = this.users.get(userId);
    if (old === socket) return;
    if (u) this.arcade.reset(u);
    if (old && u?.game) this.sockets.get(userId)?.get(old)?.({ t: 'game_session', session: null, reason: 'elsewhere' });
    if (socket) this.owners.set(userId, socket); else this.owners.delete(userId);
    for (const [id, send] of this.sockets.get(userId) ?? []) send({ t: 'voice_owner', owner: id === socket });
    if (socket && u) this.arcade.resend(u);
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
    this.stopReading(u);
    this.doorTimer(u, () => {
      for (const k of this.knocks.values()) if (k.fromId === u.id && (k.state === 'walking' || k.state === 'pending')) this.closeKnock(k, 'later', 'Knock cancelled');
      this.leaveCall(u);
      if (u.instance) this.leaveInstance(u);
      this.setFollowing(u, null);
      for (const f of this.users.values()) if (f.following === u.id) this.setFollowing(f, null);
      this.setDoor(u, 'leaving');
      u.lastSpot = this.position(u).dest;
      const at = this.walk(u, this.map.exit, 'up') ?? Date.now();
      this.doorTimer(u, () => {
        this.setDoor(u, null);
        this.arcade.leave(u);
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
      id: randomUUID().slice(0, 8), name, look: lookFor(name), lookSet: false, tile: tile ?? { ...this.map.spawn }, dir: 'down',
      move: null, path: null, presence: bot ? 'online' : 'offline', status: '', emote: null, bot, homeDesk: null, door: null, callId: null, deafened: false, hand: false, muted: false,
      following: null, holding: null, meeting: null, reading: null, instance: null, game: null, plant: null, bloomed: [], achievements: {}, effects: [], items: [],
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
    const move = u.prev && now < u.move.startedAt ? u.prev : { path: u.path, startedAt: u.move.startedAt, ms: u.move.ms };
    const ms = move.ms ?? WALK_MS_PER_TILE;
    const s = sampleMove(move.path, move.startedAt, now, ms)!;
    if (s.done) return { tile: s.tile, next: s.tile, remainingMs: 0, dest: s.tile };
    const seg = Math.max(0, now - move.startedAt) / ms;
    return { tile: s.tile, next: s.next, remainingMs: (Math.ceil(seg) - seg) * ms, dest: u.move.to };
  }
  roomOf(u: User) { const p = this.position(u); return roomAt(this.map, p.tile.x, p.tile.y); }

  /** Start a walk. Mid-walk, the new path starts at the tile being entered, timed for when we get there. */
  walk(u: User, to: Tile, face?: Dir, now = Date.now()): number | null {
    const pos = this.position(u, now);
    const from = pos.next;
    const keepOut = !this.isAdmin(u); // admins-only rooms: everyone else's path goes around, and never in
    const path = pathTo(this.map, from, to, keepOut); // also sits down onto a sofa
    if (!path.length) return null; // nothing changes: the current walk (and its dungeon timers) goes on
    if (path.length > 1 && this.readPlans.get(u.id)?.seq !== this.walkingTo) this.stopReading(u);
    if (path.length > 1) { for (const [id, seat] of this.seats) if (seat.user === u.id) this.endSeat(id); if (!this.toiletWalks.has(u.id)) this.toilets.leave(u.id, now); this.endLunch(u); }
    // A due pickup belongs to the old walk even if its callback hasn't run yet.
    const keyTimer = u.dungeonTimers?.key;
    if (underground(u) && keyTimer && keyTimer.at <= now) keyTimer.run();
    this.bumpWalk(u);
    const startedAt = Math.round(now + pos.remainingMs);
    face ??= seatAt(this.map, to.x, to.y)?.dir; // sit facing the desk/table
    if (u.effects.some(e => e.kind === 'dance') && (roomAt(this.map, to.x, to.y)?.id !== DANCE_ROOM || seatAt(this.map, to.x, to.y))) this.removeEffect(u, 'dance', now);
    this.arcade.leave(u);
    u.prev = u.move && u.path && now < u.move.startedAt + pathDuration(u.path, u.move.ms) ? { path: u.path, startedAt: u.move.startedAt, ...(u.move.ms ? { ms: u.move.ms } : {}) } : undefined;
    const per = walkMs(u.effects), ms = per === WALK_MS_PER_TILE ? undefined : per; // the usual pace stays implicit
    u.move = { from, to, startedAt, face, ...(ms ? { ms } : {}) }; u.path = path; u.tile = to;
    if (face) u.dir = face;
    else if (path.length > 1) { const a = path[path.length - 2], b = path[path.length - 1]; u.dir = b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : 'up'; }
    this.broadcast({ t: 'move', userId: u.id, from, to, startedAt, face, ms, path: keepOut ? path : undefined }); // clients path without the lock
    for (const f of this.users.values()) if (f.following === u.id) this.trail(f, to, startedAt + FOLLOW_LAG_MS);
    const end = startedAt + pathDuration(path, per);
    if (underground(u) && u.dungeon && this.map.dungeon) {
      const key = u.dungeon.key, i = key ? path.findIndex(p => p.x === key.x && p.y === key.y) : -1;
      if (!u.dungeon.hasKey && i >= 0) this.dungeonTimer(u, 'key', startedAt + i * per, () => {
        if (!u.dungeon || !underground(u)) return;
        u.dungeon.hasKey = true; u.dungeon.key = null; this.sendDungeon(u, 'key');
      });
      if (this.sameTile(to, this.map.dungeon.doorFront)) this.dungeonTimer(u, 'door', end, () => {
        if (!underground(u) || !u.dungeon || !this.walkDone(u)) return;
        // When key and door share a deadline, always settle the pickup first.
        const pickup = u.dungeonTimers?.key;
        if (pickup && pickup.at <= Date.now()) pickup.run();
        if (!u.dungeon.hasKey) { this.sendDungeon(u, 'locked'); return; }
        this.sendDungeon(u, 'opening');
        this.dungeonTimer(u, 'opening', Date.now() + 900, () => {
          if (underground(u)) this.leaveDungeon(u, 'escaped');
        });
      });
    }
    return end;
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
      if (underground(u) || underground(target) || target.id === u.id || target.presence === 'offline' || goingOut(target) || goingOut(u) || target.instance !== u.instance) return;
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

  jukeboxTick(now = Date.now()) {
    for (const [id, j] of this.jukeboxes) if (j.advance(now)) this.broadcast({ t: 'jukebox', id, state: j.state });
  }

  // ---------- instruments ----------
  private cancelSeatWalk(user: string) {
    const pending = this.pendingSeat.get(user);
    if (pending) { clearTimeout(pending.timer); this.pendingSeat.delete(user); }
  }
  private instrumentEligible(u: User) {
    return !u.bot && u.presence !== 'offline' && !goingOut(u) && !u.instance && !!this.sockets.get(u.id)?.size;
  }
  private atInstrument(u: User, o: MapObject, now: number) {
    return (!u.move || !u.path || now >= u.move.startedAt + pathDuration(u.path, u.move.ms)) &&
      besideObject(this.map, o).some(s => s.x === u.tile.x && s.y === u.tile.y);
  }
  private recentSeatChanges(user: string, now: number) {
    const changes = (this.seatChanges.get(user) ?? []).filter(at => at > now - 10000);
    this.seatChanges.set(user, changes);
    return changes;
  }
  private takeSeat(u: User, o: MapObject, socket: string) {
    this.seats.set(o.id, { user: u.id, socket, held: new Set() });
    this.recentSeatChanges(u.id, Date.now()).push(Date.now());
    this.broadcast({ t: 'instrument', id: o.id, player: u.id });
    this.sockets.get(u.id)?.get(socket)?.({ t: 'seat', id: o.id });
  }
  private endSeat(id: string) {
    const seat = this.seats.get(id); if (!seat) return;
    this.seats.delete(id);
    this.recentSeatChanges(seat.user, Date.now()).push(Date.now());
    this.broadcast({ t: 'instrument', id, player: null });
    this.sockets.get(seat.user)?.get(seat.socket)?.({ t: 'seat', id: null });
  }
  private instrumentTick(now: number) {
    for (const [id, seat] of this.seats) {
      const u = this.users.get(seat.user), o = this.map.objects.find(o => o.id === id);
      if (!u || !this.instrumentEligible(u) || !this.sockets.get(seat.user)?.has(seat.socket) ||
          o?.use?.kind !== 'instrument' || !this.atInstrument(u, o, now)) this.endSeat(id);
    }
  }
  private seatTaken(u: User, o: MapObject) {
    const seat = this.seats.get(o.id);
    if (!seat || seat.user === u.id || o.use?.kind !== 'instrument') return false; // their own other tab hands it over
    const name = this.users.get(seat.user)?.name.split(/\s+/)[0] ?? 'Someone';
    this.sendTo(u.id, { t: 'notice', text: `${name} is playing the ${o.use.label}` });
    return true;
  }
  private instrument(u: User, msg: Extract<ClientMsg, { t: 'instrument' }>, socket: string) {
    if (typeof msg.objectId !== 'string' || (msg.action !== 'play' && msg.action !== 'leave')) return;
    const o = this.map.objects.find(o => o.id === msg.objectId);
    if (o?.use?.kind !== 'instrument') return;
    const seat = this.seats.get(o.id);
    if (msg.action === 'leave') { if (seat?.socket === socket) this.endSeat(o.id); return; }
    if (!this.instrumentEligible(u) || seat?.socket === socket) return;
    if (this.recentSeatChanges(u.id, Date.now()).length > SEAT_CHANGES_PER_10S) return;
    if (this.seatTaken(u, o)) return;
    for (const [id, held] of this.seats) if (held.user === u.id) this.endSeat(id);
    if (this.atInstrument(u, o, Date.now())) { this.takeSeat(u, o, socket); return; }
    this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id)); this.errands.delete(u.id);
    const here = this.position(u).next, occ = this.occupied();
    const spots = playSpots(this.map, o);
    let best: { spot: Spot; len: number } | null = null;
    for (const group of [spots.filter(s => s.dir === 'down'), spots.filter(s => s.dir !== 'down')]) {
      for (const spot of group) {
        const mine = spot.x === here.x && spot.y === here.y;
        if (!mine && occ.has(`${spot.x},${spot.y}`)) continue;
        const len = mine ? 0 : findPath(this.map, here, spot).length;
        if (!mine && !len) continue;
        if (!best || len < best.len) best = { spot, len };
      }
      if (best) break;
    }
    if (!best) { this.sendTo(u.id, { t: 'notice', text: `No room at the ${o.use.label}` }); return; }
    const spot = best.spot, at = this.walk(u, spot, spot.dir);
    if (at === null) return;
    const pending = { objectId: o.id, socket, spot, timer: setTimeout(() => {
      if (this.pendingSeat.get(u.id) !== pending) return;
      this.pendingSeat.delete(u.id);
      const current = this.map.objects.find(o => o.id === pending.objectId);
      if (!this.sockets.get(u.id)?.has(socket) || current?.use?.kind !== 'instrument' ||
          !this.instrumentEligible(u) || !this.atInstrument(u, current, Date.now())) return;
      if (this.seatTaken(u, current)) return;
      for (const [id, held] of this.seats) if (held.user === u.id) this.endSeat(id);
      this.takeSeat(u, current, socket);
    }, Math.max(0, at - Date.now()) + ARRIVAL_SLACK_MS) };
    this.pendingSeat.set(u.id, pending);
  }
  private note(u: User, msg: Extract<ClientMsg, { t: 'note' }>, socket: string) {
    if (typeof msg.objectId !== 'string' || !Number.isInteger(msg.note) || !Number.isInteger(msg.vel) ||
        !Number.isInteger(msg.preset) || typeof msg.on !== 'boolean' || !Number.isFinite(msg.at)) return;
    const seat = this.seats.get(msg.objectId), o = this.map.objects.find(o => o.id === msg.objectId);
    const now = Date.now();
    if (!seat || seat.socket !== socket || o?.use?.kind !== 'instrument' || !this.atInstrument(u, o, now)) return;
    const kind = o.use.instrument;
    if (!validNote(kind, msg.note)) return;
    if (msg.on) {
      if (msg.vel < 1 || msg.vel > 127 || msg.preset < 0 || msg.preset >= INSTRUMENTS[kind].presets.length) return;
      if (kind !== 'drums' && (seat.held.has(msg.note) || seat.held.size >= NOTE_HELD_MAX)) return;
      const bucket = this.noteBuckets.get(u.id) ?? { tokens: NOTE_BURST, at: now };
      bucket.tokens = Math.min(NOTE_BURST, bucket.tokens + (now - bucket.at) * NOTE_RATE / 1000); bucket.at = now;
      this.noteBuckets.set(u.id, bucket);
      if (bucket.tokens < 1) return;
      bucket.tokens--;
      if (kind !== 'drums') seat.held.add(msg.note);
    } else {
      if (kind === 'drums' || !seat.held.delete(msg.note)) return;
    }
    const relay: ServerMsg = { t: 'note', id: o.id, by: u.id, note: msg.note, on: msg.on,
      vel: msg.on ? msg.vel : 0, preset: msg.on ? msg.preset : 0, at: Math.max(now - 2000, Math.min(now + 500, msg.at)) };
    for (const [id, sockets] of this.sockets) {
      const listener = this.users.get(id);
      if (!listener || listener.bot || listener.instance) continue;
      for (const [key, send] of sockets) if (key !== seat.socket) send(relay);
    }
  }

  // ---------- objects ----------
  /** Walk over to an object and use it: take something from it, or flip it on/off. */
  use(u: User, objectId: string, itemId?: string) {
    this.cancelSeatWalk(u.id);
    const o = this.map.objects.find(o => o.id === objectId);
    if (!o || !routes(o.use, 'use') || goingOut(u) || u.instance || u.presence === 'offline' || (o.use.kind === 'arcade' && u.bot)) return;
    const item = o.use.kind === 'take' ? o.use.items.find(i => i.id === itemId) ?? o.use.items[0] : null;
    if (o.use.kind === 'toilet') return this.useToilet(u, o);
    this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    const here = this.position(u).next, occ = this.occupied();
    let best: { spot: Spot; len: number } | null = null;
    for (const s of besideObject(this.map, o)) {
      const mine = s.x === here.x && s.y === here.y;
      if (!mine && occ.has(`${s.x},${s.y}`)) continue;
      const len = mine ? 0 : (o.use.kind === 'arcade' ? pathTo(this.map, here, s) : findPath(this.map, here, s)).length;
      if (!mine && !len) continue;
      if (!best || len < best.len) best = { spot: s, len };
    }
    if (!best && o.use.kind === 'arcade') {
      const room = roomAt(this.map, o.x, o.y), candidates: Spot[] = [];
      if (room) for (let y = room.rect.y; y < room.rect.y + room.rect.h; y++) for (let x = room.rect.x; x < room.rect.x + room.rect.w; x++) {
        if (isWalkable(this.map, x, y)) candidates.push({ x, y, dir: dirBetween({ x, y }, { x: o.x, y: o.y + o.h }) });
      }
      const distance = (s: Spot) => Math.abs(s.x - o.x) + Math.abs(s.y - o.y - o.h);
      candidates.sort((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x);
      for (const spot of candidates) {
        if (occ.has(`${spot.x},${spot.y}`) && (spot.x !== here.x || spot.y !== here.y)) continue;
        const len = pathTo(this.map, here, spot).length;
        if (len) { best = { spot, len }; break; }
      }
    }
    if (!best) return; // crowded: nowhere to stand
    const spot = best.spot;
    const at = this.walk(u, spot, spot.dir) ?? Date.now();
    this.errands.set(u.id, setTimeout(() => {
      this.errands.delete(u.id);
      const d = this.position(u).dest;
      if (d.x !== spot.x || d.y !== spot.y || u.presence === 'offline' || goingOut(u) || u.instance) return; // wandered off on the way
      const current = this.map.objects.find(it => it.id === objectId);
      if (!current?.use || current.use.kind !== o.use!.kind) return;
      if (current.use.kind === 'arcade') { if (!u.bot && this.sockets.get(u.id)?.size) this.arcade.join(u, current.id); return; }
      if (current.use.kind === 'bell') this.ringBell(u, current);
      else if (o.use!.kind === 'toggle') this.setObject(o.id, !this.objectOn.get(o.id), u);
      else if (current.use.kind === 'dealer') {
        const want = itemId && current.use.items.includes(itemId) ? itemId : current.use.items[0];
        const hat = hatOf(want);
        if (this.addItem(u, want)) this.sendTo(u.id, { t: 'notice', text: hat ? `${HAT_NAMES[hat] ?? hat} · in your pockets 🎒` : 'The bouncer slips you something 💊' });
      }
      else if (item) {
        this.setHolding(u, item.id, o.id);
        if (o.type === 'coffee_machine') this.addEffect(u, 'speed'); // a fresh cup: quick on your feet for a while
      }
    }, Math.max(0, at - Date.now()) + (o.use.kind === 'arcade' ? 0 : USE_MS[o.use.kind])));
  }
  // ---------- the Library ----------
  private walkingTo = -1; // seq of the read plan whose own walk is under way (not a reason to stop reading)
  private libraryChanged() { this.broadcast({ t: 'library', ...this.library.state() }); }
  private addArticle(u: User, url: unknown, title: unknown, topic: unknown) {
    if (u.bot || u.presence === 'offline') return;
    const a = this.library.add(u.id, url, title, topic, Date.now());
    if (typeof a === 'string') return this.sendTo(u.id, { t: 'notice', text: a });
    this.libraryChanged();
    this.sendTo(u.id, { t: 'notice', text: `On the shelf: ${a.title} 📚` });
  }
  /** Click an article: fetch a book from the Library's shelf, sit at a free reading table, and only then is it "reading". */
  startReading(u: User, articleId: string) {
    const article = this.library.get(articleId), shelf = this.map.objects.find(o => o.use?.kind === 'library');
    if (!article || !shelf || u.bot || goingOut(u) || u.instance || u.presence === 'offline') return;
    const here = this.position(u).next, occ = this.occupied();
    const reserved = new Set([...this.readPlans].filter(([id]) => id !== u.id).map(([, p]) => `${p.seat.x},${p.seat.y}`));
    const free = readingSeats(this.map).filter(t => !reserved.has(`${t.x},${t.y}`) && (!occ.has(`${t.x},${t.y}`) || (t.x === here.x && t.y === here.y)));
    if (!free.length) return this.sendTo(u.id, { t: 'notice', text: 'All the reading seats are taken' });
    let at: { spot: Spot; len: number } | null = null;
    for (const s of besideObject(this.map, shelf)) {
      const mine = s.x === here.x && s.y === here.y;
      if (!mine && occ.has(`${s.x},${s.y}`)) continue;
      const len = mine ? 0 : findPath(this.map, here, s).length;
      if (!mine && !len) continue;
      if (!at || len < at.len) at = { spot: s, len };
    }
    if (!at) return this.sendTo(u.id, { t: 'notice', text: 'The shelf is crowded — try again in a moment' });
    const spot = at.spot;
    const seat = free.map(t => ({ t, len: t.x === spot.x && t.y === spot.y ? 0 : findPath(this.map, spot, t).length })).filter(p => p.len || (p.t.x === spot.x && p.t.y === spot.y)).sort((a, b) => a.len - b.len)[0]?.t;
    if (!seat) return this.sendTo(u.id, { t: 'notice', text: 'Nobody can reach the reading tables' });
    this.stopReading(u);
    this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    const seq = (this.readPlans.get(u.id)?.seq ?? 0) + 1 + Math.floor(Math.random() * 1e6);
    this.readPlans.set(u.id, { articleId, seat, seq });
    const alive = () => this.readPlans.get(u.id)?.seq === seq;
    const abort = () => { if (alive()) this.readPlans.delete(u.id); if (u.holding === BOOK_ITEM) this.setHolding(u, null); };
    const wait = (to: number) => Math.max(0, to - Date.now());
    const go = (to: Tile, dir: Dir | undefined) => { this.walkingTo = seq; try { return this.walk(u, to, dir); } finally { this.walkingTo = -1; } };
    const walked = go(spot, spot.dir);
    if (walked === null && (here.x !== spot.x || here.y !== spot.y)) return abort();
    const arrive = (to: Tile) => { const d = this.position(u).dest; return d.x === to.x && d.y === to.y && u.presence !== 'offline' && !goingOut(u) && !u.instance; };
    this.errands.set(u.id, setTimeout(() => {
      this.errands.delete(u.id);
      if (!alive() || !arrive(spot)) return abort();
      this.setHolding(u, BOOK_ITEM, shelf.id);
      this.errands.set(u.id, setTimeout(() => {
        this.errands.delete(u.id);
        if (!alive() || u.holding !== BOOK_ITEM) return abort();
        const sat = go(seat, undefined);
        if (sat === null && !arrive(seat)) return abort();
        this.errands.set(u.id, setTimeout(() => {
          this.errands.delete(u.id);
          if (!alive() || !arrive(seat) || !this.library.get(articleId)) return abort();
          this.readPlans.delete(u.id);
          this.setHolding(u, null);
          u.reading = articleId;
          this.library.start(u.id, articleId, Date.now());
          this.broadcast({ t: 'reading', userId: u.id, articleId });
        }, wait(sat ?? Date.now()) + 300));
      }, USE_MS.take));
    }, wait(walked ?? Date.now()) + USE_MS.take));
  }
  /** Done, closed the overlay, walked away or left: the read is finished and you're no longer reading. */
  stopReading(u: User) {
    const plan = this.readPlans.get(u.id);
    if (plan) { this.readPlans.delete(u.id); clearTimeout(this.errands.get(u.id)); this.errands.delete(u.id); if (u.holding === BOOK_ITEM) this.setHolding(u, null); }
    if (!u.reading) return;
    u.reading = null;
    this.broadcast({ t: 'reading', userId: u.id, articleId: null });
    const read = this.library.finish(u.id);
    if (!read) return;
    const now = Date.now(), author = this.users.get(this.library.get(read.articleId)?.by ?? '');
    this.libraryChanged();
    if (this.library.articlesRead(u.id) >= BOOKWORM_READS && !u.achievements.bookworm) { this.award(u, 'bookworm', now); this.plantChanged(u); }
    if (author && author.id !== u.id && !author.achievements.editor && this.library.readers(read.articleId).size >= EDITOR_READERS) { this.award(author, 'editor', now); this.plantChanged(author); }
  }
  /** Walk over to a table and put down the coffee or tea you're holding. */
  putCup(u: User, tile: Tile) {
    if (!u.holding || !CUP_ITEMS.includes(u.holding) || u.instance || goingOut(u) || u.presence === 'offline') return;
    const problem = this.creatures.cupProblem(tile);
    if (problem) { this.sendTo(u.id, { t: 'notice', text: problem }); return; }
    const here = this.position(u).next, occ = this.occupied();
    const spots = this.creatures.beside(tile).filter(s => (s.x === here.x && s.y === here.y) || !occ.has(`${s.x},${s.y}`))
      .map(s => ({ s, len: s.x === here.x && s.y === here.y ? 0 : findPath(this.map, here, s).length })).filter(p => p.s.x === here.x && p.s.y === here.y || p.len);
    spots.sort((a, b) => a.len - b.len);
    const spot = spots[0]?.s;
    if (!spot) return;
    this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    const at = this.walk(u, spot, dirBetween(spot, tile)) ?? Date.now();
    const item = u.holding;
    this.errands.set(u.id, setTimeout(() => {
      this.errands.delete(u.id);
      const d = this.position(u).dest;
      if (d.x !== spot.x || d.y !== spot.y || u.holding !== item || u.instance) return; // changed their mind
      const cup = this.creatures.addCup(tile, item, Date.now());
      if (typeof cup === 'string') this.sendTo(u.id, { t: 'notice', text: cup });
      else this.setHolding(u, null);
    }, Math.max(0, at - Date.now()) + 300));
  }
  // ---------- petting the cat and dog, catching the bat ----------
  /** Click on a creature: walk up to it (one tile away is enough), then pet it, or try to catch the bat while it hangs. */
  petCreature(u: User, creatureId: string) {
    const c = this.creatures.list.get(creatureId);
    if (!c || (c.kind !== 'cat' && c.kind !== 'dog' && c.kind !== 'bat') || u.presence === 'offline' || u.instance || goingOut(u)) return;
    if (c.kind === 'bat' && c.pose !== 'hang') return;
    const near = (t: Tile) => Math.max(Math.abs(t.x - c.tile.x), Math.abs(t.y - c.tile.y)) <= 1;
    const here = this.position(u).next;
    if (near(here)) { this.cancelSeatWalk(u.id); return this.touchCreature(u, c.id); }
    const occ = this.occupied();
    const spots = this.creatures.beside(c.tile).filter(s => !occ.has(`${s.x},${s.y}`))
      .map(s => ({ s, len: findPath(this.map, here, s).length })).filter(p => p.len);
    spots.sort((a, b) => a.len - b.len);
    const spot = spots[0]?.s;
    if (!spot) return;
    this.cancelSeatWalk(u.id); this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    const at = this.walk(u, spot, dirBetween(spot, c.tile)) ?? Date.now();
    this.errands.set(u.id, setTimeout(() => {
      this.errands.delete(u.id);
      const d = this.position(u).dest;
      if (d.x !== spot.x || d.y !== spot.y || u.instance) return; // changed their mind
      this.touchCreature(u, creatureId);
    }, Math.max(0, at - Date.now()) + 200));
  }
  private touchCreature(u: User, id: string) {
    const c = this.creatures.list.get(id), now = Date.now();
    if (!c || Math.max(Math.abs(this.position(u).dest.x - c.tile.x), Math.abs(this.position(u).dest.y - c.tile.y)) > 1) return;
    if (c.kind === 'bat') {
      if (now - (this.batTries.get(u.id) ?? 0) < BAT_COOLDOWN_MS) return;
      this.batTries.set(u.id, now);
      const r = this.creatures.tryBat(now);
      if (r === 'caught') {
        if (!this.hasItem(u, hatItem(BAT_HAT))) this.addItem(u, hatItem(BAT_HAT));
        this.award(u, 'batcatcher', now); this.plantChanged(u);
        this.broadcast({ t: 'notice', text: `${u.name} caught the bat 🦇` });
      } else if (r === 'missed') this.sendTo(u.id, { t: 'notice', text: 'It slipped away! 🦇' });
      return;
    }
    if (c.pose === 'pet') return;
    this.creatures.petBy(c, u.id, now);
    const day = dayNumber(now), seen = this.petDays.get(u.id)?.day === day ? this.petDays.get(u.id)! : { day, kinds: new Set<string>() };
    seen.kinds.add(c.kind); this.petDays.set(u.id, seen);
    if (seen.kinds.has('cat') && seen.kinds.has('dog') && !u.achievements.whisperer) { this.award(u, 'whisperer', now); this.plantChanged(u); }
  }
  // ---------- lunch on the terrace ----------
  /** Eat the food you're holding in this picnic chair: walk over, sit, and for LUNCH_MS you're eating (a plate on the table). */
  lunch(u: User, tile: Tile, open: boolean) {
    if (!u.holding || !FOOD_ITEMS.includes(u.holding) || u.instance || goingOut(u) || u.presence === 'offline') return;
    const spot = picnicSeat(this.map, tile);
    if (!spot) return this.sendTo(u.id, { t: 'notice', text: 'Eat at a chair by a picnic table' });
    const here = this.position(u).next, mine = here.x === tile.x && here.y === tile.y;
    if (!mine && this.occupied().has(`${tile.x},${tile.y}`)) return this.sendTo(u.id, { t: 'notice', text: 'Someone is sitting there' });
    this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    const at = mine ? Date.now() : this.walk(u, tile, spot.seat.dir);
    if (at === null) return this.sendTo(u.id, { t: 'notice', text: "Can't get to that chair" });
    const item = u.holding;
    this.errands.set(u.id, setTimeout(() => {
      this.errands.delete(u.id);
      const d = this.position(u).dest;
      if (d.x !== tile.x || d.y !== tile.y || u.holding !== item || u.instance || u.presence === 'offline' || goingOut(u)) return; // changed their mind
      this.setHolding(u, null);
      const now = Date.now();
      this.setEating(u, { item, until: now + LUNCH_MS, open });
      const { table, front } = spot, tiles = [front];
      for (let y = table.y; y < table.y + table.h; y++) for (let x = table.x; x < table.x + table.w; x++) tiles.push({ x, y });
      for (const t of tiles) if (typeof this.creatures.addCup(t, PLATE_PREFIX + item, now) !== 'string') break; // in front of you, else anywhere free on the table
    }, Math.max(0, at - Date.now()) + 300));
  }
  private setEating(u: User, eating: Eating | null) {
    if (eating) u.eating = eating; else delete u.eating;
    this.broadcast({ t: 'eating', userId: u.id, eating });
  }
  private endLunch(u: User) { if (u.eating) this.setEating(u, null); }
  lunchTick(now = Date.now()) { for (const u of this.users.values()) if (u.eating && u.eating.until <= now) this.endLunch(u); }
  private lunchOpen(u: User, open: boolean) { if (u.eating && u.eating.open !== open) this.setEating(u, { ...u.eating, open }); }
  /** Which picnic table someone is sitting at (not walking). */
  private tableOf(u: User) {
    const p = this.position(u);
    return p.tile.x === p.dest.x && p.tile.y === p.dest.y && !u.instance ? picnicSeat(this.map, p.tile)?.table.id ?? null : null;
  }
  private eatingNow(u: User) { return !!u.eating && u.eating.until > Date.now(); }

  // ---------- Berghain's toilets ----------
  /** Walk to the stall's door; there, go in or join the line. */
  private useToilet(u: User, o: MapObject) {
    if (this.toilets.inside(u.id) === o.id || this.toilets.waiting(u.id)?.id === o.id) return;
    this.removeEffect(u, 'dance');
    if (toiletFull(this.toilets.state(o.id))) return this.sendTo(u.id, { t: 'notice', text: 'Out of order — this stall is full 🤢' });
    this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    const door = stallDoor(o), here = this.position(u).next;
    const at = here.x === door.x && here.y === door.y ? Date.now() : this.walk(u, door, 'down');
    if (at === null) return;
    this.errands.set(u.id, setTimeout(() => {
      this.errands.delete(u.id);
      const d = this.position(u).dest;
      if (d.x !== door.x || d.y !== door.y || u.presence === 'offline' || goingOut(u) || u.instance) return; // wandered off on the way
      if (this.map.objects.find(it => it.id === o.id)?.use?.kind !== 'toilet') return;
      const r = this.toilets.arrive(o.id, u.id, Date.now());
      if (r === 'full') this.sendTo(u.id, { t: 'notice', text: 'Out of order — this stall is full 🤢' });
      if (r === 'queued') this.sendTo(u.id, { t: 'notice', text: `In line for the toilet · ${this.toilets.waiting(u.id)!.ahead + 1} ahead of you` });
    }, Math.max(0, at - Date.now()) + USE_MS.toilet));
  }
  private toiletWalk(u: User, to: Tile) {
    this.toiletWalks.add(u.id);
    try { return this.walk(u, to, 'down'); } finally { this.toiletWalks.delete(u.id); }
  }
  /** Everyone waiting for this stall stands in its line, in order. */
  private lineUp(id: string) {
    const o = this.map.objects.find(o => o.id === id), queue = this.toilets.state(id).queue;
    if (!o || !queue.length) return;
    const spots = stallLine(this.map, o, queue.length);
    queue.forEach((userId, i) => {
      const u = this.users.get(userId), d = u && this.position(u).dest;
      if (u && d && (d.x !== spots[i].x || d.y !== spots[i].y)) this.toiletWalk(u, { x: spots[i].x, y: spots[i].y });
    });
  }
  private toiletShelf(u: User, objectId: string) {
    const o = this.map.objects.find(o => o.id === objectId);
    if (o?.use?.kind !== 'toilet' || this.toilets.inside(u.id) !== o.id) return;
    if (!this.hasItem(u, TOILET_SHELF_ITEM)) return this.sendTo(u.id, { t: 'notice', text: 'You have nothing to put on the shelf' });
    if (this.toilets.state(o.id).in.length < 2) return this.sendTo(u.id, { t: 'notice', text: 'Not on your own — wait for company' });
    if (!this.toilets.shelf(o.id, u.id)) return this.sendTo(u.id, { t: 'notice', text: 'The shelf is full' });
    this.takeItem(u, TOILET_SHELF_ITEM);
  }
  private toiletSniff(u: User, objectId: string) {
    const o = this.map.objects.find(o => o.id === objectId);
    if (o?.use?.kind !== 'toilet' || this.toilets.inside(u.id) !== o.id) return;
    if (!this.toilets.sniff(o.id, u.id)) return this.sendTo(u.id, { t: 'notice', text: 'Nothing on the shelf' });
    this.addEffect(u, 'unicorns');
    this.sendTo(u.id, { t: 'notice', text: 'Whoa… are those unicorns? 🦄' });
  }
  /** Ring a bell: right away from beside it, else walk over first. One ring a second per person. */
  private ring(u: User, objectId: string) {
    const o = this.map.objects.find(o => o.id === objectId);
    if (o?.use?.kind !== 'bell' || u.bot || u.instance || u.presence === 'offline' || goingOut(u)) return;
    const t = this.position(u).next;
    if (Math.max(o.x - t.x, t.x - (o.x + o.w - 1), 0) <= 1 && Math.max(o.y - t.y, t.y - (o.y + o.h - 1), 0) <= 1) this.ringBell(u, o);
    else this.use(u, objectId);
  }
  private ringBell(u: User, o: MapObject) {
    const now = Date.now();
    if (u.bot || now - (this.lastRing.get(u.id) ?? 0) < 1000) return;
    this.lastRing.set(u.id, now);
    this.broadcast({ t: 'bell', userId: u.id, objectId: o.id });
  }
  private objectState(id: string) { return { on: this.objectOn.get(id) ?? true }; }
  private setObject(id: string, on: boolean, by: User) {
    this.objectOn.set(id, on);
    this.broadcast({ t: 'object', id, ...this.objectState(id), by: by.id });
  }
  give(u: User, to: User) {
    if (u.instance !== to.instance || !u.holding || to.id === u.id || to.holding || to.presence === 'offline' || goingOut(to)) return;
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

  // ---------- effects ----------
  /** Put an effect on someone (replacing one of the same kind), for its rule's duration unless `ms` says otherwise. */
  addEffect(u: User, kind: string, opts: { ms?: number; data?: Record<string, unknown> } = {}, now = Date.now()) {
    const rule = EFFECTS[kind]; if (!rule) return;
    const ms = opts.ms ?? rule.ms;
    const e: Effect = { kind, ...(ms ? { until: now + ms } : {}), ...(opts.data ? { data: opts.data } : {}) };
    u.effects = [...u.effects.filter(x => x.kind !== kind), e].slice(-MAX_EFFECTS);
    this.effectsChanged(u);
  }
  removeEffect(u: User, kind: string, now = Date.now()) {
    if (!u.effects.some(e => e.kind === kind)) return;
    if (kind === 'dance') this.danceTime(u, now);
    u.effects = u.effects.filter(e => e.kind !== kind);
    this.effectsChanged(u);
  }
  private effectsChanged(u: User) { this.broadcast({ t: 'effects', userId: u.id, effects: u.effects }); }
  // ---------- dancing ----------
  private danceSince = new Map<string, number>(); // when the dancing time was last counted (memory only)
  /** Count the time since we last looked, up to `until` (an expired dance counts to its end); the raver badge comes at 30 min. */
  private danceTime(u: User, now: number, until = now) {
    const from = this.danceSince.get(u.id);
    this.danceSince.delete(u.id);
    if (from === undefined || until <= from) return;
    u.danced = (u.danced ?? 0) + (until - from);
    if (u.danced >= RAVER_MS && !u.achievements.raver) { this.award(u, 'raver', now); this.plantChanged(u); }
  }
  /** Dancing needs the Berghain floor: standing in the club, not in a stall or its line, not in a meeting or on a chair. */
  private canDance(u: User) {
    return u.presence !== 'offline' && !u.instance && roomAt(this.map, u.tile.x, u.tile.y)?.id === DANCE_ROOM && !seatAt(this.map, u.tile.x, u.tile.y)
      && !this.toilets.inside(u.id) && !this.toilets.waiting(u.id);
  }
  startDance(u: User, now = Date.now()) {
    if (!this.canDance(u)) return;
    this.addEffect(u, 'dance', {}, now);
    this.danceSince.set(u.id, now);
  }
  effectsTick(now = Date.now()) {
    for (const u of this.users.values()) {
      const dance = u.effects.find(e => e.kind === 'dance');
      if (dance) {
        if (!this.danceSince.has(u.id)) this.danceSince.set(u.id, now);
        else this.danceTime(u, now, Math.min(now, dance.until ?? now)), this.danceSince.set(u.id, now);
      } else this.danceSince.delete(u.id);
      if (!u.effects.some(e => e.until !== undefined && e.until <= now)) continue;
      u.effects = u.effects.filter(e => e.until === undefined || e.until > now);
      this.effectsChanged(u);
    }
  }
  /** Judges find their own hat in their pockets (the one an admin picked), office admins the sysadmin cap (by sign-in email).
   *  The first time, it goes straight on; later they wear what they like. Someone no longer on the list loses the hat. */
  private grantHats(u: User) {
    let wearing = u.effects.find(e => e.kind === 'hat')?.data?.style, changed = false;
    const judge = this.judgeHat(u);
    for (const [style, should] of [[JUDGE_HAT, false], ...JUDGE_HATS.map(h => [h, judge === h] as const), [ADMIN_HAT, this.isAdmin(u)]] as const) {
      const item = hatItem(style), has = u.items.includes(item);
      if (should && !has) { u.items = [...u.items, item]; changed = true; if (!wearing) this.addEffect(u, 'hat', { data: { style } }); }
      if (!should && has) { u.items = u.items.filter(i => i !== item); changed = true; if (wearing === style) { this.removeEffect(u, 'hat'); wearing = undefined; } }
    }
    if (changed) this.sendTo(u.id, this.me(u));
  }
  /** An admin marks someone as a judge with one of the judge hats, or (hat null) takes the mark away. */
  private setJudge(u: User, msg: Extract<ClientMsg, { t: 'judge_set' }>) {
    if (!this.isAdmin(u)) return;
    const who = String(msg.who ?? '').trim().toLowerCase();
    if (!who || who.length > 120 || (msg.hat !== null && !isJudgeHat(msg.hat))) return;
    const at = this.judges.findIndex(j => j.who === who);
    if (msg.hat === null) { if (at < 0) return; this.judges.splice(at, 1); }
    else if (at >= 0) this.judges[at].hat = msg.hat;
    else if (this.judges.length < MAX_JUDGES) this.judges.push({ who, hat: msg.hat });
    else return;
    for (const p of this.users.values()) if (!p.bot && listed([who], p)) this.grantHats(p);
    for (const p of this.users.values()) if (this.isAdmin(p)) this.sendTo(p.id, this.judgeList());
  }
  /** A client asks for an effect on someone. Yourself: 'self' effects only; GMs (office admins): anything on anyone. */
  private requestEffect(u: User, msg: Extract<ClientMsg, { t: 'effect' }>) {
    const kind = String(msg.kind), rule = Object.prototype.hasOwnProperty.call(EFFECTS, kind) ? EFFECTS[kind] : undefined;
    const target = this.users.get(String(msg.targetId));
    if (!rule || !target || target.presence === 'offline') return;
    const gm = this.isAdmin(u);
    if (!gm && (target.id !== u.id || rule.who !== 'self')) return;
    if (!msg.on) return this.removeEffect(target, kind);
    let data: Record<string, unknown> | undefined;
    if (rule.styles) {
      const style = String(msg.style ?? '');
      if (!(rule.styles as readonly string[]).includes(style)) return;
      if (kind === 'hat' && !gm && !u.items.includes(hatItem(style))) return; // wear only what's in your pockets
      data = { style };
    }
    if (kind === 'dance') return void this.startDance(target);
    this.addEffect(target, kind, { data });
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
    if (u.status.trim()) this.tendPlant(u);
  }
  /** Setting a status tends your plant: one stage a day. A dead one (or none yet) is replanted. */
  tendPlant(u: User, now = Date.now()) {
    const today = dayNumber(now), p = u.plant && !plantDead(u.plant, now) ? u.plant : null;
    if (p?.care === today) return;
    if (!p) { u.plant = this.newPlant(u, today); return this.plantChanged(u); }
    const stage = Math.min(PLANT_STAGES.length - 1, p.stage + 1);
    u.plant = { ...p, stage, care: today };
    if (stage > p.stage) this.award(u, 'tended', now);
    if (stage === PLANT_STAGES.length - 1 && stage > p.stage) {
      const kind = p.kind ?? 'bush';
      if (!u.bloomed.includes(kind)) u.bloomed = [...u.bloomed, kind];
      this.award(u, 'bloom', now);
      if (u.bloomed.length >= BOTANIST_KINDS) this.award(u, 'botanist', now);
    }
    this.plantChanged(u);
  }
  /** A seedling of a random kind, preferring flowers this person hasn't bloomed yet. */
  private newPlant(u: User, care: number): Plant {
    const fresh = PLANT_KINDS.filter(k => !u.bloomed.includes(k) && k !== u.plant?.kind);
    const pool = fresh.length ? fresh : PLANT_KINDS.filter(k => k !== u.plant?.kind);
    return { stage: 0, care, kind: pool[Math.floor(Math.random() * pool.length)] };
  }
  private award(u: User, id: string, now: number) { if (!u.achievements[id]) u.achievements = { ...u.achievements, [id]: now }; }
  private plantChanged(u: User) { this.broadcast({ t: 'plant', userId: u.id, plant: u.plant, bloomed: u.bloomed, achievements: u.achievements }); }
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
        if (m?.callId === call.id) this.sendTo(id, { t: 'call', userId: id, callId: call.id, link: uri });
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
    // only on disconnect: revoking an old token from the same grant would also kill the new one (e.g. after adding Calendar)
    if (u.google && !link) void revoke(u.id, u.google);
    forgetAccess(u.id);
    const hadCalendar = !!u.google?.scopes.includes(CALENDAR_SCOPE);
    u.google = link;
    this.sendTo(u.id, this.me(u));
    if (!hadCalendar && link?.scopes.includes(CALENDAR_SCOPE)) void this.meetings.poll(); // their meetings show up now, not in 2 minutes
  }

  // ---------- the place under the garden ----------
  private sameTile(a: Tile, b: Tile) { return a.x === b.x && a.y === b.y; }
  private inDungeon(t: Tile) {
    const r = this.map.dungeon?.rect;
    return !!r && t.x >= r.x && t.x < r.x + r.w && t.y >= r.y && t.y < r.y + r.h;
  }
  private walkDone(u: User) { return !!u.move && !!u.path && Date.now() >= u.move.startedAt + pathDuration(u.path, u.move.ms); }
  private bumpWalk(u: User) {
    u.walkSeq = (u.walkSeq ?? 0) + 1;
    for (const t of Object.values(u.dungeonTimers ?? {})) clearTimeout(t.timer);
    u.dungeonTimers = undefined;
  }
  private dungeonTimer(u: User, kind: 'fall' | 'key' | 'door' | 'opening', at: number, fn: () => void) {
    const seq = u.walkSeq ?? 0;
    const run = () => {
      if (u.dungeonTimers?.[kind] !== entry) return;
      clearTimeout(entry.timer); delete u.dungeonTimers[kind];
      if (u.walkSeq === seq && Date.now() >= at) fn();
    };
    const entry: DungeonTimer = { seq, at, run, timer: setTimeout(run, Math.max(0, at - Date.now())) };
    clearTimeout(u.dungeonTimers?.[kind]?.timer);
    (u.dungeonTimers ??= {})[kind] = entry;
  }
  private sendDungeon(u: User, event?: DungeonEvent) {
    this.sendTo(u.id, { t: 'dungeon', key: u.dungeon?.key ?? null, hasKey: u.dungeon?.hasKey ?? false, ...(event ? { event } : {}) });
  }
  private stopFollowers(u: User) {
    this.setFollowing(u, null);
    for (const f of this.users.values()) if (f.following === u.id) this.setFollowing(f, null);
  }
  private fall(u: User) {
    const d = this.map.dungeon;
    if (!d) return;
    for (const k of this.knocks.values()) if ((k.fromId === u.id || k.toId === u.id) && (k.state === 'walking' || k.state === 'pending')) this.closeKnock(k, 'later', 'Knock cancelled', k.fromId === u.id);
    this.leaveCall(u); this.setWaiting(u, null);
    clearTimeout(this.errands.get(u.id)); this.errands.delete(u.id);
    this.stopFollowers(u);
    const choices = d.keySpots.filter(t => !u.lastKeySpot || !this.sameTile(t, u.lastKeySpot));
    const key = choices[Math.floor(Math.random() * choices.length)];
    u.instance = DUNGEON_INSTANCE; u.dungeon = { key: { ...key }, hasKey: false }; u.lastKeySpot = { ...key };
    const occ = this.occupied(DUNGEON_INSTANCE), queue = [d.landing], seen = new Set([`${d.landing.x},${d.landing.y}`]);
    let spot = d.landing;
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i];
      if (!occ.has(`${t.x},${t.y}`)) { spot = t; break; }
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const p = { x: t.x + dx, y: t.y + dy }, k = `${p.x},${p.y}`;
        if (this.inDungeon(p) && isWalkable(this.map, p.x, p.y) && !seen.has(k)) { seen.add(k); queue.push(p); }
      }
    }
    this.place(u, spot); this.sendDungeon(u, 'fell');
  }
  /** Only office tiles connected to spawn can be climb-out destinations in a saved layout. */
  private dungeonExit(escaped: boolean): Tile {
    const d = this.map.dungeon, occ = this.occupied();
    if (!d) return this.freeLobbyTile(occ);
    const target = escaped ? d.hatch : d.hole, reached = new Set<string>(), queue = [this.map.spawn];
    reached.add(`${this.map.spawn.x},${this.map.spawn.y}`);
    const office = this.map.office;
    const neighbours = (t: Tile) => [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([dx, dy]) => ({ x: t.x + dx, y: t.y + dy }))
      .filter(t => t.x >= office.x && t.y >= office.y && t.x < office.x + office.w && t.y < office.y + office.h && isWalkable(this.map, t.x, t.y));
    for (let i = 0; i < queue.length; i++) for (const p of neighbours(queue[i])) {
      const k = `${p.x},${p.y}`; if (!reached.has(k)) { reached.add(k); queue.push(p); }
    }
    if (!reached.has(`${target.x},${target.y}`)) return this.freeLobbyTile(occ);
    const exits = [target], seen = new Set([`${target.x},${target.y}`]);
    for (let i = 0; i < exits.length; i++) {
      const t = exits[i], k = `${t.x},${t.y}`;
      if ((escaped || !this.sameTile(t, d.hole)) && !occ.has(k)) return t;
      for (const p of neighbours(t)) {
        const k = `${p.x},${p.y}`;
        if (reached.has(k) && !seen.has(k)) { seen.add(k); exits.push(p); }
      }
    }
    return this.freeLobbyTile(occ);
  }
  private leaveDungeon(u: User, how: 'escaped' | 'gave_up' | 'quiet') {
    if (!underground(u)) return;
    this.stopFollowers(u);
    const exit = this.dungeonExit(how === 'escaped');
    this.bumpWalk(u); u.dungeon = undefined; u.instance = null;
    if (how === 'escaped') { this.award(u, 'escape', Date.now()); this.plantChanged(u); }
    if (how !== 'quiet') this.sendDungeon(u, how);
    this.place(u, exit);
  }
  private leaveInstance(u: User, announce = true) {
    if (underground(u)) this.leaveDungeon(u, 'quiet'); else if (u.instance) this.leaveMeeting(u, announce);
  }

  // ---------- calendar meetings ----------
  // A meeting's room is a copy of the Meeting room for its attendees only (instance). Everyone else sees
  // it on the board by the Meeting room; the people in it see only each other.
  meetings = new Meetings(this);
  private instances = new Map<string, { id: string; end: number; members: Set<string> }>();
  meetingRooms() {
    return [...this.instances.values()].map(i => ({ id: i.id, until: i.end, members: [...i.members] }));
  }
  private meetingRect() { return this.map.rooms.find(r => r.id === MEETING_ROOM_ID)!.rect; }
  private inMeetingRoom(t: Tile) { const r = this.meetingRect(); return t.x >= r.x && t.x < r.x + r.w && t.y >= r.y && t.y < r.y + r.h; }
  setMeeting(u: User, until: number | null) {
    if (u.meeting === until) return;
    u.meeting = until;
    this.broadcast({ t: 'meeting', userId: u.id, until });
  }
  /** Jump straight to a tile (into or out of a meeting's room); no walking between the two. */
  private place(u: User, tile: Tile) {
    this.bumpWalk(u); this.endLunch(u);
    u.tile = { ...tile }; u.move = null; u.path = null; u.prev = undefined;
    u.dir = seatAt(this.map, tile.x, tile.y)?.dir ?? 'down';
    this.broadcast({ t: 'instance', userId: u.id, instance: u.instance, tile: u.tile, dir: u.dir });
  }
  /** One click from the heads-up: into the meeting's room, at a free chair. */
  enterMeeting(u: User, key: string) {
    const m = this.meetings.events.get(key);
    if (!m || u.bot || u.presence === 'offline' || goingOut(u) || !this.meetings.canEnter(u, m) || u.instance === m.instance) return;
    if (u.instance) this.leaveInstance(u, false);
    for (const k of this.knocks.values()) if ((k.fromId === u.id || k.toId === u.id) && (k.state === 'walking' || k.state === 'pending')) this.closeKnock(k, 'later', 'Knock cancelled', k.fromId === u.id);
    this.stopReading(u);
    this.leaveCall(u); // a knock call or room voice: they're off to the meeting
    this.setWaiting(u, null);
    clearTimeout(this.errands.get(u.id));
    this.setFollowing(u, null);
    for (const f of this.users.values()) if (f.following === u.id) this.setFollowing(f, null);
    let inst = this.instances.get(m.instance);
    if (!inst) { inst = { id: m.instance, end: m.end, members: new Set() }; this.instances.set(inst.id, inst); }
    u.returnTo = this.position(u).dest;
    const occ = this.occupied(inst.id), r = this.meetingRect(), seats: Tile[] = [], floor: Tile[] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (occ.has(`${x},${y}`)) continue;
      if (seatAt(this.map, x, y)) seats.push({ x, y }); else if (isWalkable(this.map, x, y)) floor.push({ x, y });
    }
    const spot = seats[0] ?? floor[Math.floor(Math.random() * floor.length)];
    if (!spot) return;
    this.arcade.leave(u);
    inst.members.add(u.id);
    u.instance = inst.id;
    this.place(u, spot);
    this.broadcast({ t: 'meetings', rooms: this.meetingRooms() });
    this.meetings.rejoin(u, key); // Go after leaving for good: in the meeting again
  }
  /** Back to where they were in the office (or the Lobby if someone's there now). */
  leaveMeeting(u: User, announce = true) {
    if (!u.instance || underground(u)) return;
    const inst = u.instance ? this.instances.get(u.instance) : undefined;
    for (const f of this.users.values()) if (f.following === u.id) this.setFollowing(f, null);
    this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    u.instance = null;
    const occ = this.occupied(), back = u.returnTo && !occ.has(`${u.returnTo.x},${u.returnTo.y}`) ? u.returnTo : this.freeLobbyTile(occ);
    u.returnTo = undefined;
    this.place(u, back);
    if (inst) {
      inst.members.delete(u.id);
      if (!inst.members.size) this.instances.delete(inst.id);
    }
    if (announce) this.broadcast({ t: 'meetings', rooms: this.meetingRooms() });
  }
  /** Meetings that are over send everyone still inside back to the office. */
  endMeetings(now = Date.now()) {
    let changed = false;
    for (const inst of [...this.instances.values()]) {
      if (inst.end > now) continue;
      for (const id of [...inst.members]) {
        const u = this.users.get(id); if (!u) continue;
        this.leaveMeeting(u, false);
        this.sendTo(id, { t: 'notice', text: 'Meeting\'s over: back to the office' });
      }
      this.instances.delete(inst.id); changed = true;
    }
    if (changed) this.broadcast({ t: 'meetings', rooms: this.meetingRooms() });
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
  private joinCall(u: User, call: Call) {
    this.setWaiting(u, null);
    if (u.callId === call.id) return;
    this.leaveCall(u);
    call.members.add(u.id); u.callId = call.id;
    if (!call.room) {
      u.presenceBeforeCall = u.presence === 'in_call' ? 'online' : u.presence;
      this.setPresence(u, 'in_call');
    } else {
      for (const k of this.knocks.values()) if ((k.fromId === u.id || k.toId === u.id) && (k.state === 'walking' || k.state === 'pending'))
        this.closeKnock(k, 'later', `Knock cancelled — ${u.name} walked into ${call.room.name}`);
    }
    for (const [id] of this.sockets) this.sendTo(id, { t: 'call', userId: u.id, callId: call.id, link: call.members.has(id) ? call.link : undefined });
    if (call.room) return;
    const humansThere = [...call.members].some(id => !this.users.get(id)?.bot);
    const ms = !u.bot ? 2 * 60 * 60_000 : humansThere ? 120_000 + Math.random() * 180_000 : 30_000 + Math.random() * 60_000;
    this.callTimers.set(u.id, setTimeout(() => this.leaveCall(u), ms));
  }
  private hallEligible(u: User, room: Room, now: number) {
    if (u.bot || u.afk || u.instance || u.presence === 'offline' || goingOut(u) || !this.sockets.get(u.id)?.size) return false; // a meeting's own room is off the floor
    if (u.callId && !this.calls.get(u.callId)?.room) return false;
    const t = this.position(u, now).tile;
    return roomAt(this.map, t.x, t.y)?.id === room.id || doorwayTiles(this.map, room).some(g => g.some(p => p.x === t.x && p.y === t.y));
  }
  private maintainRoom(call: Call, now = Date.now()) {
    for (const [id, roomId] of this.waiting) {
      if (roomId !== call.room!.id) continue;
      const u = this.users.get(id);
      if (!u) { this.waiting.delete(id); continue; }
      if (!this.hallEligible(u, call.room!, now)) continue;
      if (call.members.size < ROOM_VOICE_MAX) this.joinCall(u, call);
    }
    if (!call.members.size) this.calls.delete(call.id);
  }
  voiceTick(now = Date.now()) {
    const rooms = voiceRooms(this.map);
    for (const u of this.users.values()) {
      if (u.bot || u.afk || u.presence === 'offline' || goingOut(u) || !this.sockets.get(u.id)?.size) { this.setWaiting(u, null); if (u.instance && this.calls.get(u.callId ?? '')?.room) this.leaveCall(u, now); continue; }
      const t = this.position(u, now).tile;
      const inside = rooms.find(r => t.x >= r.rect.x && t.x < r.rect.x + r.rect.w && t.y >= r.rect.y && t.y < r.rect.y + r.rect.h);
      const call = u.callId ? this.calls.get(u.callId) : undefined;
      if (call && !call.room) {
        this.setWaiting(u, null);
        if (!inside) continue;
        for (const id of call.members) if (id !== u.id) this.sendTo(id, { t: 'call_moved', userId: u.id, roomId: inside.id });
        this.leaveCall(u, now);
      }
      const room = rooms.find(r => this.hallEligible(u, r, now));
      if (!room) {
        this.setWaiting(u, null);
        if (u.callId) this.leaveCall(u, now);
        continue;
      }
      const id = `room:${room.id}`;
      if (u.callId === id) { this.setWaiting(u, null); continue; }
      if (u.callId) this.leaveCall(u, now);
      let hall = this.calls.get(id);
      if (hall) this.maintainRoom(hall, now);
      if (u.callId === id) continue;
      if (hall && hall.members.size >= ROOM_VOICE_MAX) { this.setWaiting(u, room.id); continue; }
      if (!hall) hall = { id, members: new Set(), fallback: false, room };
      this.calls.set(id, hall); this.joinCall(u, hall);
    }
  }
  callFull(u: User) { const c = u.callId ? this.calls.get(u.callId) : undefined; return !!c && !c.room && c.members.size >= MAX_CALL_SIZE; }
  leaveCall(u: User, now = Date.now()) {
    const call = u.callId ? this.calls.get(u.callId) : undefined;
    clearTimeout(this.callTimers.get(u.id)); this.callTimers.delete(u.id);
    if (!u.callId) return;
    this.broadcast({ t: 'speaking', userId: u.id, on: false }); this.lowerHand(u);
    if (call && !call.room) {
      this.setPresence(u, u.presenceBeforeCall ?? 'online'); u.presenceBeforeCall = undefined;
    }
    u.callId = null;
    call?.members.delete(u.id);
    this.broadcast({ t: 'call', userId: u.id, callId: null });
    if (!call || !this.calls.has(call.id)) return;
    if (call.room) this.maintainRoom(call, now);
    else if (call.members.size < 2) {
      this.calls.delete(call.id);
      for (const id of [...call.members]) { const m = this.users.get(id); if (m) this.leaveCall(m, now); }
    }
  }
  private leaveRoom(u: User) {
    this.setWaiting(u, null); this.setFollowing(u, null);
    u.afk = true; this.leaveCall(u);
    const occ = this.occupied(), home = u.homeDesk;
    const outside = (t: Tile) => voiceRooms(this.map).every(r => roomAt(this.map, t.x, t.y)?.id !== r.id && !doorwayTiles(this.map, r).some(g => g.some(p => p.x === t.x && p.y === t.y)));
    const free = (t: Tile) => !occ.has(`${t.x},${t.y}`) && outside(t);
    let to = home && free(home) ? home : undefined;
    if (!to) {
      const lobby = this.map.rooms.find(r => r.id === 'lobby');
      if (lobby) {
        const { x, y, w, h } = lobby.rect, tiles: Tile[] = [];
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++)
          if (isWalkable(this.map, xx, yy) && free({ x: xx, y: yy })) tiles.push({ x: xx, y: yy });
        to = tiles.length ? tiles[Math.floor(Math.random() * tiles.length)] : undefined;
      }
    }
    if (to) this.walk(u, to);
  }

  setEmote(u: User, emote: User['emote']) {
    u.emote = emote;
    this.broadcast({ t: 'emote', userId: u.id, emote });
  }

  // ---------- rearranging the office (admins) ----------
  edit(u: User, edit: LayoutEdit) {
    if (!this.isAdmin(u)) return;
    const used = new Set([...this.map.objects, ...this.map.rugs].map(o => o.id));
    let added: string; do added = `e${Date.now().toString(36)}${(this.editSeq++).toString(36)}`; while (used.has(added));
    const next = applyEdit(this.map, edit, () => added);
    if (typeof next === 'string') return this.sendTo(u.id, { t: 'notice', text: `Can't: ${next}` });
    this.setLayout(next, u, edit.op === 'add' || edit.op === 'rug_add' ? added : undefined);
  }
  /** A saved layout brought up to date with this build's one-of-a-kind objects: a new one (a release puts a vault
   *  door in the Lobby) goes at its generated spot when that's still free; one the admin already placed keeps its
   *  spot but takes the build's definition (a new link, say), unless its shape changed (the safe moved into the
   *  wall), when it goes back to the generated spot too. Matched by type and order (the second cabinet is the second
   *  cabinet), never by id: generated ids shift between builds. A new one may bring an id the saved layout already
   *  uses; `uniqueIds` sorts that out. */
  private withNewFixtures(saved: Layout): Layout {
    const out = { objects: [...saved.objects], rugs: saved.rugs }, seen = new Map<string, number>();
    for (const o of this.baseLayout.objects) {
      if (!KEEP_TYPES.has(o.type)) continue;
      const n = seen.get(o.type) ?? 0; seen.set(o.type, n + 1);
      const i = saved.objects.flatMap((s, j) => (s.type === o.type ? [j] : []))[n] ?? -1, have = i >= 0 ? out.objects[i] : undefined;
      if (have && !!have.wall === !!o.wall && have.w === o.w && have.h === o.h) { out.objects[i] = { ...structuredClone(o), id: have.id, x: have.x, y: have.y }; continue; }
      const next = { ...out, objects: have ? out.objects.map((s, j) => (j === i ? structuredClone(o) : s)) : [...out.objects, structuredClone(o)] };
      const problem = layoutProblem(withLayout(this.map, next), false);
      let placed = !problem;
      const room = roomAt(this.map, o.x, o.y);
      if (problem && !o.wall && room) {
        const positions: Tile[] = [], r = room.rect;
        for (let y = r.y; y + o.h <= r.y + r.h; y++) for (let x = r.x; x + o.w <= r.x + r.w; x++) {
          if (x !== o.x || y !== o.y) positions.push({ x, y });
        }
        positions.sort((a, b) => Math.abs(a.x - o.x) + Math.abs(a.y - o.y) - Math.abs(b.x - o.x) - Math.abs(b.y - o.y) || a.y - b.y || a.x - b.x);
        for (const pos of positions) {
          Object.assign(next.objects[next.objects.length - 1], pos);
          if (!layoutProblem(withLayout(this.map, next), false)) { placed = true; break; }
        }
      }
      if (!placed) console.warn(`${have ? 'reshaped' : 'new'} ${objectName(o.type)} not placed in the saved layout: ${problem}`);
      else out.objects = next.objects;
    }
    return out;
  }
  resetLayout(u: User) { if (this.isAdmin(u) && this.setLayout(structuredClone(this.baseLayout), u)) this.layoutEdited = false; }
  /** Check the whole floor, then put it in place for everyone: home desks go along with their chair, toggles
   *  get their state, and anyone the new furniture lands on (or whose way it blocks) steps aside. */
  private setLayout(next: Layout, by: User, added?: string) {
    const problem = layoutProblem(withLayout(this.map, next));
    if (problem) { this.sendTo(by.id, { t: 'notice', text: `Can't: ${problem}` }); return false; }
    const chairAt = (t: Tile) => this.map.objects.find(o => o.type === 'chair' && o.x === t.x && o.y === t.y)?.id;
    const deskChairs = [...this.users.values()].filter(o => o.homeDesk).map(o => ({ o, id: chairAt(o.homeDesk!) }));
    for (const [user, pending] of this.pendingSeat) {
      const before = this.map.objects.find(o => o.id === pending.objectId), after = next.objects.find(o => o.id === pending.objectId);
      if (!after || after.use?.kind !== 'instrument' || before?.x !== after.x || before?.y !== after.y) this.cancelSeatWalk(user);
    }
    applyLayout(this.map, next);
    this.instrumentTick(Date.now());
    this.syncToggles(); this.syncJukeboxes(true);
    this.layoutEdited = true;
    this.broadcast({ t: 'layout', layout: this.layout(), by: by.id, added });
    for (const { o, id } of deskChairs) {
      const chair = this.map.objects.find(c => c.id === id), seat = chair && seatAt(this.map, chair.x, chair.y);
      if (!seat?.homeDesk) this.setDesk(o, null);
      else if (seat.x !== o.homeDesk!.x || seat.y !== o.homeDesk!.y) this.setDesk(o, { x: seat.x, y: seat.y });
    }
    this.stepAside();
    return true;
  }
  /** Lamps added get switched on, lamps removed are forgotten. */
  /** One Jukebox per jukebox on the floor; an admin moving it keeps what's playing. */
  private syncJukeboxes(announce = false) {
    const ids = new Set(this.map.objects.filter(o => o.use?.kind === 'jukebox').map(o => o.id));
    for (const id of ids) if (!this.jukeboxes.has(id)) {
      const j = new Jukebox(TRACKS, Date.now()); this.jukeboxes.set(id, j);
      if (announce) this.broadcast({ t: 'jukebox', id, state: j.state });
    }
    for (const id of [...this.jukeboxes.keys()]) if (!ids.has(id)) this.jukeboxes.delete(id);
  }
  private syncToggles() {
    for (const o of this.map.objects) if (o.use?.kind === 'toggle' && !this.objectOn.has(o.id)) this.objectOn.set(o.id, o.on ?? true);
    for (const id of this.objectOn.keys()) if (!this.map.objects.some(o => o.id === id)) this.objectOn.delete(id);
  }
  private stepAside() {
    const ok = (t: Tile) => isWalkable(this.map, t.x, t.y) || !!seatAt(this.map, t.x, t.y);
    for (const u of this.users.values()) {
      if (u.presence === 'offline') { if (!ok(u.tile)) u.tile = { ...this.map.spawn }; continue; }
      const p = this.position(u);
      if (!ok(p.dest)) { for (const t of this.freeNear(p.dest, u.instance)) if (this.walk(u, t) !== null) break; }
      else if ((p.tile.x !== p.dest.x || p.tile.y !== p.dest.y) && u.path?.some(t => !ok(t))) this.walk(u, p.dest, u.move?.face);
    }
  }
  /** Free walkable tiles around `t`, nearest first. */
  private freeNear(t: Tile, instance: string | null) {
    const occ = this.occupied(instance), out: Tile[] = [];
    for (let r = 1; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = t.x + dx, y = t.y + dy;
      if (isWalkable(this.map, x, y) && !occ.has(`${x},${y}`)) out.push({ x, y });
    }
    return out.sort((a, b) => Math.abs(a.x - t.x) + Math.abs(a.y - t.y) - (Math.abs(b.x - t.x) + Math.abs(b.y - t.y)));
  }

  /** Tiles where nobody is standing or heading. */
  /** Tiles taken in the office, or in one meeting's room. */
  occupied(instance: string | null = null) {
    const s = new Set<string>();
    // `tile` is already where a walk ends (`walk` sets it to the destination), so no need to sample the move
    for (const u of this.users.values()) if (u.presence !== 'offline' && u.instance === instance) s.add(`${u.tile.x},${u.tile.y}`);
    return s;
  }

  // ---------- knock ----------
  private knockBlock(from: User, to: User) {
    if (underground(to)) return `${to.name} is somewhere underground 🕳`;
    if (underground(from)) return "You're underground — find the way out first";
    const dest = this.position(to).dest, target = roomAt(this.map, dest.x, dest.y);
    if (target?.rules.voice === 'open') return `${to.name} is in ${target.name} — just walk in`;
    const hall = to.callId ? this.calls.get(to.callId)?.room : undefined;
    if (hall) return `${to.name} is in ${hall.name} — just walk in`;
    if (to.instance) return `${to.name} is in a meeting`;
    if (from.instance) return 'You\'re in a meeting — leave it to knock';
    const room = from.callId ? this.calls.get(from.callId)?.room : undefined;
    if (room) return `You're in ${room.name} voice — step out to knock`;
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
    const shared = this.tableOf(from);
    if (shared && shared === this.tableOf(to)) return this.arrive(k); // already side by side at the table
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
    const table = this.tableOf(from);
    if (table && table === this.tableOf(to) && this.eatingNow(to) && to.eating!.open) return this.reply(to, k.id, 'accept'); // sharing a table with someone open to talk
    const stall = this.toilets.inside(to.id), lunch = this.eatingNow(to) && !to.eating!.open;
    if (room?.rules.knock === 'later' || (to.presence === 'in_call' && !to.callId) || to.meeting || to.reading || stall || lunch) {
      const why = stall ? 'on the toilet' : to.meeting ? 'in a meeting' : to.reading ? 'reading' : lunch ? 'at lunch' : room?.rules.occupantLabel ?? 'in a call';
      k.timer = setTimeout(() => this.closeKnock(k, 'later', `${to.name} is ${why} — sent to Later`), 1400);
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
    if (['move', 'use', 'follow', 'instrument'].includes(msg.t)) this.cancelSeatWalk(u.id);
    if (msg.t === 'voice_claim') { this.setOwner(u.id, socket); return; }
    if (typeof msg.t === 'string' && msg.t.startsWith('game_')) {
      if (this.owners.get(u.id) === socket) this.arcade.handle(u, msg);
      return;
    }
    if (['rtc', 'speaking', 'mute', 'deafen', 'hand'].includes(msg.t) && this.owners.get(u.id) !== socket) return;
    switch (msg.t) {
      case 'instrument': this.instrument(u, msg, socket); break;
      case 'note': this.note(u, msg, socket); break;
      case 'move': {
        u.afk = false;
        for (const k of this.knocks.values()) if (k.fromId === u.id && k.state === 'walking') this.closeKnock(k, 'later', 'Knock cancelled', true);
        if (u.door === 'arriving') { this.doorTimer(u, null); this.setDoor(u, null); } // off on their own way: bag's put away
        this.setFollowing(u, null);
        const to = { x: msg.to.x | 0, y: msg.to.y | 0 };
        if (underground(u) ? !this.inDungeon(to) : u.instance && !this.inMeetingRoom(to)) break;
        if (!this.isAdmin(u) && adminOnly(this.map, to.x, to.y)) { this.sendTo(u.id, { t: 'notice', text: `🔒 ${roomAt(this.map, to.x, to.y)?.name ?? 'That room'}: admins only` }); break; }
        const at = this.walk(u, to);
        const hole = this.map.dungeon?.hole;
        if (at !== null && hole && this.sameTile(to, hole)) this.dungeonTimer(u, 'fall', at, () => {
          if (!u.bot && u.presence !== 'offline' && this.sockets.get(u.id)?.size && !goingOut(u) && !u.instance &&
            this.walkDone(u) && this.sameTile(u.tile, hole)) this.fall(u);
        });
        break;
      }
      case 'status': this.setStatus(u, String(msg.status ?? '')); break;
      case 'effect': this.requestEffect(u, msg); break;
      case 'judge_set': this.setJudge(u, msg); break;
      case 'tz': {
        const tz = isTimeZone(msg.tz) ? msg.tz : undefined;
        if (tz === u.tz || (msg.tz != null && !tz)) break;
        if (tz) u.tz = tz; else delete u.tz;
        this.broadcast({ t: 'tz', userId: u.id, tz: tz ?? null });
        break;
      }
      case 'look': {
        const color = (v: unknown, fallback: string) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
        const int = (v: unknown, max: number) => Math.max(0, Math.min(max, Number.isInteger(v) ? Number(v) : 0));
        u.look = {
          skin: color(msg.look.skin, u.look.skin), hair: color(msg.look.hair, u.look.hair),
          shirt: color(msg.look.shirt, u.look.shirt), pants: color(msg.look.pants, u.look.pants),
          eyes: color(msg.look.eyes, u.look.eyes), shoes: color(msg.look.shoes, u.look.shoes),
          glassesColor: color(msg.look.glassesColor, u.look.glassesColor), hatColor: color(msg.look.hatColor, u.look.hatColor),
          style: int(msg.look.style, 2), top: int(msg.look.top, 2), bottom: int(msg.look.bottom, 2),
          glasses: int(msg.look.glasses, 2), hat: int(msg.look.hat, 2),
        };
        u.lookSet = true;
        this.broadcast({ t: 'look', userId: u.id, look: u.look, lookSet: true });
        break;
      }
      case 'claim_desk': this.claimDesk(u); break;
      case 'edit': if (msg.edit && typeof msg.edit === 'object') this.edit(u, msg.edit); break;
      case 'edit_reset': this.resetLayout(u); break;
      case 'ring': this.ring(u, String(msg.objectId)); break;
      case 'toilet_shelf': this.toiletShelf(u, String(msg.objectId)); break;
      case 'toilet_sniff': this.toiletSniff(u, String(msg.objectId)); break;
      case 'release_desk': this.releaseDesk(u); break;
      case 'meet_link': {
        const raw = String(msg.link ?? '');
        const link = raw.trim() ? normalizeMeetLink(raw) : '';
        if (link === null) break; // invalid: ignore, the client validates too
        u.meetLink = link || undefined;
        this.sendTo(u.id, this.me(u));
        break;
      }
      case 'google_connect': {
        if (!googleEnabled) break;
        const calendar = !!msg.calendar;
        this.sendTo(u.id, { t: 'google_auth', calendar, url: authUrl(u.id, u.google?.email ?? u.email, calendar ? [CALENDAR_SCOPE] : []) });
        break;
      }
      case 'meeting_go': this.enterMeeting(u, String(msg.key)); break;
      case 'meeting_leave': if (u.instance && !underground(u)) this.leaveMeeting(u); break;
      case 'dungeon_leave': this.leaveDungeon(u, 'gave_up'); break;
      case 'meeting_out': if (!u.bot) this.meetings.leave(u, String(msg.key)); break;
      case 'calendar': {
        const g = u.google;
        if (!g?.scopes.includes(CALENDAR_SCOPE)) { this.sendTo(u.id, { t: 'calendar', error: 'no_access' }); break; }
        const asked = new Date(String(msg.from)), now = Date.now();
        const from = Math.abs(asked.getTime() - now) < 2 * 86_400_000 ? asked : new Date(now); // the start of their local day
        listEvents(u.id, g, from).then(events => this.sendTo(u.id, { t: 'calendar', events })).catch(e => {
          console.warn(`google: calendar for ${u.name}:`, e.message);
          if (e.code === 'invalid_grant' && u.google === g) { u.google = undefined; forgetAccess(u.id); this.sendTo(u.id, this.me(u)); }
          this.sendTo(u.id, { t: 'calendar', error: e.status === 403 ? 'no_access' : 'failed' });
        });
        break;
      }
      case 'google_disconnect': this.setGoogle(u, undefined); break;
      case 'presence': {
        if (!['online', 'away', 'in_call'].includes(msg.presence)) break;
        if (!(u.callId && this.calls.get(u.callId)?.room) && msg.presence !== 'in_call') this.leaveCall(u); // switching away from "in a call" hangs up
        this.setPresence(u, msg.presence);
        break;
      }
      case 'leave_room': if ((u.callId && this.calls.get(u.callId)?.room) || this.waiting.has(u.id)) this.leaveRoom(u); break; // a stale AFK/Leave mustn't walk anyone else home
      case 'end_call': if (u.callId && this.calls.get(u.callId)?.room) this.leaveRoom(u); else this.leaveCall(u); break;
      case 'deafen': if (u.callId) { u.deafened = !!msg.on; this.broadcast({ t: 'deafen', userId: u.id, on: u.deafened }); } break;
      case 'hand': if (u.callId && this.calls.get(u.callId)?.room) { u.hand = !!msg.up; this.broadcast({ t: 'hand', userId: u.id, up: u.hand }); } break;
      case 'to_meet': {
        const call = u.callId ? this.calls.get(u.callId) : undefined;
        if (call && !call.fallback && !call.room) for (const id of call.members) if (id !== u.id) this.sendTo(id, { t: 'to_meet', fromId: u.id });
        break;
      }
      // voice: relay WebRTC signaling only between members of the same call
      case 'rtc': {
        const to = this.users.get(String(msg.to));
        if (u.callId && to?.callId === u.callId && to.id !== u.id && !u.bot && !to.bot && !goingOut(u) && !goingOut(to) && u.presence !== 'offline' && to.presence !== 'offline') {
          const owner = this.owners.get(to.id);
          if (owner) this.sockets.get(to.id)?.get(owner)?.({ t: 'rtc', from: u.id, signal: msg.signal });
        }
        break;
      }
      case 'speaking': if (u.callId) this.broadcast({ t: 'speaking', userId: u.id, on: !!msg.on }); break;
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
      case 'jukebox': {
        if (typeof msg.objectId !== 'string') break;
        switch (msg.action) {
          case 'queue': if (typeof msg.track !== 'string') return; break;
          case 'unqueue': if (typeof msg.entry !== 'string') return; break;
          case 'pause': case 'play': case 'skip': if (typeof msg.playId !== 'string') return; break;
          default: return;
        }
        const o = this.map.objects.find(o => o.id === msg.objectId && o.use?.kind === 'jukebox');
        const j = o && this.jukeboxes.get(o.id); if (!o || !j) break;
        const now = Date.now(), p = this.position(u, now).tile, room = roomAt(this.map, o.x, o.y);
        if (u.bot || u.presence === 'offline' || goingOut(u) || u.instance || !room || roomAt(this.map, p.x, p.y)?.id !== room.id) {
          this.sendTo(u.id, { t: 'notice', text: `Walk into ${room?.name ?? 'Music'} to pick music` }); break;
        }
        const control = msg.action === 'pause' || msg.action === 'play' || msg.action === 'skip';
        if (control && now - (this.lastJukeboxControl.get(u.id) ?? -Infinity) < 400) break;
        const last = j.state.last, result = j.act(u.id, msg, now);
        if (control && j.state.last !== last && j.state.last?.by === u.id && j.state.last.at === now) this.lastJukeboxControl.set(u.id, now);
        if (result.changed) this.broadcast({ t: 'jukebox', id: o.id, state: j.state });
        if (result.notice) this.sendTo(u.id, { t: 'notice', text: result.notice });
        break;
      }
      case 'article_add': this.addArticle(u, msg.url, msg.title, msg.topic); break;
      case 'article_remove': if (typeof msg.id === 'string' && this.library.remove(msg.id, u.id, this.isAdmin(u))) this.libraryChanged(); break;
      case 'read_start': if (typeof msg.articleId === 'string') this.startReading(u, msg.articleId); break;
      case 'read_done': this.stopReading(u); break;
      case 'use': this.use(u, String(msg.objectId), msg.item === undefined ? undefined : String(msg.item)); break;
      case 'drop': if (u.holding) this.setHolding(u, null); break;
      case 'pet': this.petCreature(u, String(msg.creatureId)); break;
      case 'dev_bat': if (this.creatures.batAlways) { this.creatures.batBackAt = 0; this.creatures.wantBat(Date.now()); } break;
      case 'lunch': if (msg.tile) this.lunch(u, { x: msg.tile.x | 0, y: msg.tile.y | 0 }, !!msg.open); break;
      case 'lunch_open': this.lunchOpen(u, !!msg.open); break;
      case 'cup_put': if (msg.tile) this.putCup(u, { x: msg.tile.x | 0, y: msg.tile.y | 0 }); break;
      case 'give': { const to = this.users.get(String(msg.targetId)); if (to) this.give(u, to); break; }
      case 'present_slide': this.present?.slide(u.id, msg.slide); break;
      case 'present_stop': this.present?.stop(u.id); break;
    }
  }

  // ---------- persistence ----------
  dump() {
    return {
      users: [...this.users.values()].map(u => {
        return { id: u.id, name: u.name, email: u.email, meetLink: u.meetLink, google: u.google, homeDesk: u.homeDesk, look: u.look, lookSet: u.lookSet, tile: underground(u) ? this.dungeonExit(false) : u.tile, dir: u.dir, status: u.status, presence: u.presence, bot: u.bot, plant: u.plant, bloomed: u.bloomed, achievements: u.achievements, effects: u.effects.filter(e => e.until === undefined), items: u.items, danced: u.danced };
      }),
      objects: Object.fromEntries(this.objectOn),
      jukebox: Object.fromEntries([...this.jukeboxes].map(([id, j]) => [id, j.dump()])),
      arcade: this.arcade.dump(),
      layout: this.layoutEdited ? this.layout() : undefined,
      chats: Object.fromEntries(this.chats),
      cups: this.creatures.cups,
      judges: this.judges,
      library: this.library.dump(),
    };
  }
  load(data: ReturnType<World['dump']>) {
    // saved in the radio days: the radio goes (withNewFixtures then brings in the jukebox)
    if (data.layout) data.layout = { ...data.layout, objects: data.layout.objects.filter(o => o.type !== 'radio') };
    if (data.layout) { // an admin rearranged the office; if it no longer fits the generated floor, start over from that
      const covers = (o: { x: number; y: number; w: number; h: number }) => this.map.dungeon &&
        [this.map.dungeon.hole, this.map.dungeon.hatch].some(t => t.x >= o.x && t.x < o.x + o.w && t.y >= o.y && t.y < o.y + o.h);
      const objects = data.layout.objects.filter(o => {
        if (!covers(o)) return true;
        console.warn(`saved ${objectName(o.type)} dropped: covers the hole or hatch`); return false;
      });
      const rugs = data.layout.rugs.filter(r => {
        if (!covers(r)) return true;
        console.warn(`saved ${r.color} rug dropped: covers the hole or hatch`); return false;
      });
      const merged = this.withNewFixtures(migrateLibrary(migrateEastWing({ objects, rugs }, this.baseLayout), this.baseLayout, this.map));
      // ids saved by an older build can clash with this one's (a plant and the safe were both o57): each gets its own,
      // and the next save keeps it
      const layout = uniqueIds(merged, this.baseLayout), was = [...merged.objects, ...merged.rugs].map(o => o.id);
      [...layout.objects, ...layout.rugs].forEach((o, i) => { if (o.id !== was[i]) console.warn(`saved layout: the ${'type' in o ? objectName(o.type) : 'rug'} at ${o.x},${o.y} shared id ${was[i]}, now ${o.id}`); });
      const problem = layoutProblem(withLayout(this.map, layout), false);
      if (problem) console.warn(`saved layout dropped: ${problem}`);
      else {
        applyLayout(this.map, layout); this.layoutEdited = true;
        this.syncToggles(); this.syncJukeboxes();
        if (this.map.dungeon) for (const k of ['hole', 'hatch'] as const)
          if (!findPath(this.map, this.map.spawn, this.map.dungeon[k]).length) console.warn(`saved layout blocks the ${k}; keeping layout`);
      }
    }
    for (const d of data.users ?? []) {
      const tile = this.inDungeon(d.tile) ? this.dungeonExit(false) : isWalkable(this.map, d.tile.x, d.tile.y) || seatAt(this.map, d.tile.x, d.tile.y) ? d.tile : { ...this.map.spawn };
      const legacy = lookFor(d.name);
      const look = { ...legacy, ...d.look, eyes: d.look?.eyes ?? legacy.eyes, shoes: d.look?.shoes ?? legacy.shoes, top: d.look?.top ?? 0, bottom: d.look?.bottom ?? 0, glasses: d.look?.glasses ?? 0, hat: d.look?.hat ?? 0, glassesColor: d.look?.glassesColor ?? legacy.glassesColor, hatColor: d.look?.hatColor ?? legacy.hatColor };
      this.users.set(d.id, { ...d, look, lookSet: d.lookSet ?? false, homeDesk: d.homeDesk ?? null, plant: d.plant ?? null, bloomed: d.bloomed ?? [], achievements: d.achievements ?? {}, items: Array.isArray(d.items) ? d.items.filter((i: unknown): i is string => typeof i === 'string') : [], effects: (d.effects ?? []).filter(e => Object.prototype.hasOwnProperty.call(EFFECTS, e.kind) && e.until === undefined), tile, move: null, path: null, emote: null, door: null, callId: null, deafened: false, hand: false, muted: false, following: null, holding: null, meeting: null, reading: null, instance: null, game: null, presence: d.bot ? d.presence : 'offline' });
    }
    for (const [id, on] of Object.entries(data.objects ?? {})) if (this.objectOn.has(id)) this.objectOn.set(id, !!on);
    this.arcade.load(data.arcade);
    const now = Date.now();
    for (const [id, saved] of Object.entries(data.jukebox ?? {})) if (this.jukeboxes.has(id)) this.jukeboxes.set(id, Jukebox.load(TRACKS, saved, now));
    for (const [key, msgs] of Object.entries(data.chats ?? {})) this.chats.set(key, msgs);
    this.creatures.cups = (data.cups ?? []).filter(c => this.creatures.tableAt(c.tile));
    if (Array.isArray(data.judges)) this.judges = data.judges.filter(j => j && typeof j.who === 'string' && isJudgeHat(j.hat)).slice(0, MAX_JUDGES);
    this.library.load(data.library);
  }
}
