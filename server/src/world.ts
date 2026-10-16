import { isRoomMode, roomMode, rulesForMode, type RoomModes } from '../../shared/roomModes';
import { BannerStore, BannerError, validateBanner } from './banners';
import { ticketNo, type Banner, type Ticket } from '../../shared/protocol';
import { randomUUID } from 'node:crypto';
import {
  adminOnly, applyEdit, inRect, stallDoor, stallLine, stallVoiceId, tableVoiceId, applyLayout, besideObject, playSpots, dirBetween, doorwayTiles, KEEP_TYPES, migrateBeach, resetBeach, migrateEastWing, layoutProblem, objectName, voiceRooms, findPath, isWalkable, pathDuration, pathTo, roomAt, routes, sampleMove, seatAt, uniqueIds, withLayout, WALK_MS_PER_TILE,
  type MapObject, type Dir, type Layout, type Room, type Spot, type TileMap, type Tile,
} from '../../shared/map';
import {
  NOTE_RATE, NOTE_BURST, ITEMS_MAX, TOILET_SHELF_ITEM, toiletFull, NOTE_HELD_MAX, SEAT_CHANGES_PER_10S, DUNGEON_INSTANCE, goingOut, LOOK_COLORS, underground, MAX_CALL_SIZE, LATER_MAX, MEETING_ROOM_ID, MAX_CHAT_LEN, normalizeMeetLink, REACTIONS, ROOM_VOICE_MAX,
  CUP_ITEMS, BOOK_ITEM, BOOKWORM_READS, EDITOR_READERS, dayNumber, isTimeZone, plantDead, BOTANIST_KINDS, PLANT_KINDS, PLANT_STAGES, presentScope, type Plant,
  type ChatMsg, type ClientMsg, type Door, type Effect, type Knock, type LaterItem, type LayoutEdit, type Look, type Presence, type PublicUser, type Reaction, type RtcSignal, type ServerMsg,
} from '../../shared/protocol';
import { FOOD_ITEMS, LUNCH_MS, PLATE_PREFIX, picnicSeat, type Eating } from '../../shared/lunch';
import { INSTRUMENTS, validNote } from '../../shared/instruments';
import { phrase } from '../../shared/phrases';
import { ADMIN_HAT, ALL_HATS, BAT_HAT, BITE_MS, DANCE_ROOM, DRUNK_MAX_LEVEL, DRUNK_MAX_MS, DRUNK_NAMES, EFFECTS, HAT_NAMES, MAX_EFFECTS, RAVER_MS, drunkLevel, effectOf, hatItem, hatOf, walkMs } from '../../shared/effects';
import { tracksFor } from '../../shared/music';
import { Arcade } from './arcade';
import { Table } from './table';
import { Retro } from './retro';
import { Jukebox } from './jukebox';
import { Library } from './library';
import { Tickets } from './tickets';
import { migrateBookClub, migrateLibrary, readingSeats } from '../../shared/library';
import { onMap } from '../../shared/beach';
import type { Vacation } from '../../shared/vacation';
import { Vacations } from './vacations';
import { Beach } from './beach';
import { Meetings } from './meetings';
import { BAT_COOLDOWN_MS, Creatures } from './creatures';
import { PresentError, type Presenter } from './presentation';
import { Toilets } from './toilets';
import { authUrl, CALENDAR_SCOPE, createSpace, forgetAccess, googleEnabled, listEvents, revoke, type GoogleLink } from './google';

type DungeonEvent = Extract<ServerMsg, { t: 'dungeon' }>['event'];
interface DungeonTimer { seq: number; at: number; timer: NodeJS.Timeout; run: () => void }
export interface User extends PublicUser {
  nameSet?: boolean;    // the person typed their name themselves; sign-in no longer rewrites it from the email (saved)
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
  resume?: boolean;     // in the office when the server last stopped: back on that spot, no walk in from the door
  presenceBeforeCall?: Presence;
  prev?: { path: Tile[]; startedAt: number; ms?: number };
  afk?: boolean;
}

interface Call { id: string; members: Set<string>; link?: string; fallback: boolean; room?: Room; instance?: string; small?: string } // room: open-voice hall; instance: set when the hall is a meeting room's own (id `room:<instance>`, room = the Meeting room); small: a toilet stall's or a picnic table's own (id `room:stall:<object>` / `room:table:<object>`, room = the room it stands in)
const knockCall = (c?: Call) => !!c && !c.room;
interface Instance { id: string; end: number; members: Set<string>; talk: Set<string>; out: Set<string>; meet?: string; meetBusy?: boolean } // talk: on the room's voice (private rooms: everyone, calendar meetings: who opted in); out: left it on purpose; meet: the room's shared Meet link

// data/state.json format; bump it with a migration in load that checks data.version
export const STATE_VERSION = 5;
const WALK_HOME_AFTER_MS = 5 * 60_000; // back within this: return to where you were, else your home desk

const { skin: SKINS, hair: HAIRS, shirt: SHIRTS, pants: PANTS } = LOOK_COLORS;

const hashStr = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
export const lookFor = (name: string): Look => {
  const h = hashStr(name.toLowerCase());
  return {
    skin: SKINS[h % SKINS.length], hair: HAIRS[(h >>> 4) % HAIRS.length],
    shirt: SHIRTS[(h >>> 9) % SHIRTS.length], pants: PANTS[(h >>> 14) % PANTS.length], eyes: '#2b1d1f', shoes: '#4a3028',
    style: (h >>> 20) % 5, top: 0, bottom: 0, glasses: 0, hat: 0, beard: 0, mustache: 0, glassesColor: '#282832', hatColor: '#3e5a8a',
  };
};

type Send = (msg: ServerMsg) => void;
/** Gets a broadcast already serialized, so it's stringified once however many clients are connected. */
type Wire = (json: string) => void;

const LEAVE_GRACE_MS = 5000; // a dropped tab or quick re-login shouldn't send anyone home
const DOOR_PAUSE_MS = 400;   // a beat at the door before vanishing
const FOLLOW_LAG_MS = 300;   // followers set off a beat after the person they follow
const HOLD_MS = 3 * 60_000;  // a coffee lasts this long
const USE_MS = { take: 1200, toggle: 150, toilet: 300, dealer: 350, bell: 100, presentation: 100, room_start: 100, tickets: 100 }; // brewing a coffee vs flicking a switch
const ARRIVAL_SLACK_MS = 50; // timers can fire a millisecond before the walk is over

/** Office admins rearrange the furniture: NetBird emails, or (only for name logins, so dev) plain names. */
const ADMINS = (process.env.DECK_ADMINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
/** Sysadmins are the admins who also get into the Admin room (and its servers). */
const SYSADMINS = (process.env.DECK_SYSADMINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const listed = (list: string[], u: User) => !u.bot && list.some(a => (a.includes('@') ? a === u.email : !u.email && a === u.name.toLowerCase()));

/** Dev bots answer DMs and reactions so there's something to talk to when testing alone. */
export interface BotHooks { chat(bot: User, from: User, text: string): void; react(bot: User, from: User, emoji: Reaction): void }

/** A WebRTC signal worth relaying: one of the four kinds, and no bigger than an SDP with its candidates gets. */
const RTC_SIGNAL_MAX = 64 * 1024;
const rtcSignal = (s: unknown): s is RtcSignal =>
  !!s && typeof s === 'object' && ['hello', 'offer', 'answer', 'ice'].includes(String((s as { kind?: unknown }).kind)) &&
  JSON.stringify(s).length <= RTC_SIGNAL_MAX;

export class World {
  users = new Map<string, User>();
  knocks = new Map<string, Knock & { timer?: NodeJS.Timeout }>();
  private sockets = new Map<string, Map<string, Send>>();
  private owners = new Map<string, string>();
  private waiting = new Map<string, string>();
  private listeners = new Set<{ send: Send; wire?: Wire }>();
  private doorTimers = new Map<string, NodeJS.Timeout>();
  private callTimers = new Map<string, NodeJS.Timeout>(); // per member: when they hang up
  private holdTimers = new Map<string, NodeJS.Timeout>(); // per person: when the coffee's finished
  private lastRing = new Map<string, number>();            // per person: when they last rang a bell
  private errands = new Map<string, NodeJS.Timeout>();    // per person: walking over to use an object
  private seats = new Map<string, { user: string; socket: string; held: Set<number> }>();
  private pendingSeat = new Map<string, { objectId: string; socket: string; spot: Spot; timer: NodeJS.Timeout }>();
  private noteBuckets = new Map<string, { tokens: number; at: number }>();
  private seatChanges = new Map<string, number[]>();
  private lofiListeners = new Map<string, Set<string>>();
  private jukeboxes = new Map<string, Jukebox>();
  library = new Library();
  tickets = new Tickets();
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
  /** Presentation scope: the office floor, a meeting instance, or null (offline, or underground: no screen there). */
  presentScopeOf(userId: string): string | null {
    const u = this.users.get(userId);
    if (!u || u.presence === 'offline' || underground(u)) return null;
    return presentScope(u.instance);
  }
  /** What's on the screen in `u`'s scope now (and the last frame of a screen share): on connect and whenever they change scope. */
  private syncPresentation(u: User, send: (m: ServerMsg) => void = m => this.sendTo(u.id, m)) {
    if (!this.present) return send({ t: 'presentation', live: null });
    send({ t: 'presentation', live: this.present.liveFor(u.id) });
    const frame = this.present.frameFor(u.id); if (frame) send(frame);
  }
  /** Everyone in a presentation scope (office floor or one meeting instance), except one person. */
  toScope(scope: string, msg: ServerMsg, except?: string) {
    for (const u of this.users.values()) {
      if (u.id === except || u.presence === 'offline' || presentScope(u.instance) !== scope) continue;
      this.sendTo(u.id, msg);
    }
  }

  arcade = new Arcade({ now: () => Date.now(), send: (id, msg) => this.sendOwner(id, msg),
    broadcast: msg => this.broadcast(msg), user: id => this.users.get(id) });

  table = new Table({ now: () => Date.now(), send: (id, msg) => this.sendOwner(id, msg),
    broadcast: msg => this.broadcast(msg), user: id => this.users.get(id),
    leaveCabinet: u => this.arcade.leave(this.users.get(u.id)!), commit: (id, game, winner) => this.arcade.commitTable(id, game, winner) });

  retro: Retro;

  creatures = new Creatures({ map: () => this.map, broadcast: msg => this.broadcast(msg),
    people: () => [...this.users.values()].filter(u => onMap(u) && !u.instance).map(u => this.position(u).dest),
    personTile: id => { const p = this.users.get(id); return p && onMap(p) && !p.instance ? this.position(p).dest : null; },
    drunkPeople: now => [...this.users.values()].filter(u => !u.bot && u.presence !== 'offline' && !u.instance && !goingOut(u) && !this.toilets.inside(u.id)
      && u.effects.some(e => e.kind === 'drunk' && (e.until === undefined || e.until > now))).map(u => ({ id: u.id, tile: this.position(u, now).tile })),
    fullStalls: () => this.toilets.fullEmpty(Date.now()).flatMap(id => { const o = this.map.objects.find(o => o.id === id); return o ? [{ id, door: stallDoor(o) }] : []; }),
    cleanStall: id => this.toilets.clean(id, Date.now()) });
  private petDays = new Map<string, { day: number; kinds: Set<string> }>(); // who has petted what today (memory only)
  private batTries = new Map<string, number>();                             // last try at the bat, per person
  build?: string; // sent in hello so open pages reload after a deploy
  private roomModes: RoomModes = {};
  private baseRoomRules: Record<string, Room['rules']>;
  private baseLayout: Layout;     // as generated, for Reset
  private layoutEdited = false;   // saved only once someone has changed it
  private editSeq = 0;
  banners?: BannerStore;
  private bannerChanges = new Map<string, number>();
  private bannerUploads = new Map<string, number>();
  beginBannerUpload(userId: string) {
    const now = Date.now();
    if (now - (this.bannerUploads.get(userId) ?? -Infinity) < 10_000) throw new BannerError(429, 'Wait 10 seconds between uploads.');
    this.bannerUploads.set(userId, now);
  }
  uploadBanner(u: User, bytes: Buffer) {
    if (!this.banners) throw new BannerError(500, 'Banner storage unavailable.');
    this.checkBannerRate(u.id);
    const banner = this.banners.save(u.id, bytes, u.banner);
    this.publishBanner(u, banner);
    return banner;
  }
  private checkBannerRate(userId: string) {
    if (Date.now() - (this.bannerChanges.get(userId) ?? -Infinity) < 2000) throw new BannerError(429, 'Wait 2 seconds between banner changes.');
  }
  private publishBanner(u: User, banner: Banner | null) {
    u.banner = banner;
    this.bannerChanges.set(u.id, Date.now());
    this.broadcast({ t: 'banner', userId: u.id, banner });
  }
  setBanner(u: User, value: unknown) {
    if (!validateBanner(value)) return;
    try { this.checkBannerRate(u.id); } catch { return; }
    this.banners?.remove(u.id, u.banner);
    // Copy only validated public fields; never broadcast arbitrary client properties.
    const banner = value === null ? null : value.kind === 'color' ? { kind: 'color' as const, color: value.color }
      : { kind: 'pattern' as const, pattern: value.pattern, color: value.color };
    this.publishBanner(u, banner);
  }

  constructor(public map: TileMap, retroFiles: Pick<ConstructorParameters<typeof Retro>[0], 'roms' | 'wasm'> = { roms: {}, wasm: new Uint8Array() }) {
    this.retro = new Retro({ ...retroFiles, now: () => Date.now(), send: (id, msg) => this.sendOwner(id, msg),
      broadcast: msg => this.broadcast(msg), user: id => this.users.get(id),
      cabinets: map.objects.flatMap(o => o.use?.kind === 'retro' ? [{ id: o.id, game: o.use.game }] : []) });
    this.baseRoomRules = Object.fromEntries(map.rooms.map(r => [r.id, { ...r.rules }]));
    this.baseLayout = structuredClone({ objects: map.objects, rugs: map.rugs });
    for (const o of map.objects) if (o.use?.kind === 'toggle') this.objectOn.set(o.id, o.on ?? true);
    this.syncJukeboxes();
    setInterval(() => this.beach.tick(), 1000).unref();
    setInterval(() => { const now = Date.now(); this.voiceTick(now); this.jukeboxTick(now); this.instrumentTick(now); this.effectsTick(now); this.lunchTick(now); this.laterTick(now); this.toilets.tick(now); this.present?.tick(); }, 250).unref();
  }

  // ---------- transport ----------
  broadcast(msg: ServerMsg) {
    let json: string | undefined;
    for (const l of this.listeners) { if (l.wire) l.wire(json ??= JSON.stringify(msg)); else l.send(msg); }
  }
  /** Private settings for the user themselves. */
  me(u: User): ServerMsg { return { t: 'me', meetLink: u.meetLink ?? '', email: u.email, google: googleEnabled ? u.google?.email ?? null : undefined, calendar: !!u.google?.scopes.includes(CALENDAR_SCOPE), admin: this.isAdmin(u) || undefined, sysadmin: this.isSysadmin(u) || undefined, items: u.items.length ? u.items : undefined }; }
  isAdmin(u: User) { return listed(ADMINS, u); }
  /** Only sysadmins may walk into the Admin room (access: 'admins'); the other office admins are locked out like everyone else. */
  isSysadmin(u: User) { return listed(SYSADMINS, u); }
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
    return { t: 'state', roomModes: { ...this.roomModes }, serverTime: Date.now(), users: [...this.users.values()].map(this.toPublic), objects,
      toilets: this.toilets.snapshot(this.map.objects.filter(o => o.use?.kind === 'toilet').map(o => o.id)),
      instruments: Object.fromEntries(this.map.objects.filter(o => o.use?.kind === 'instrument').map(o => [o.id, this.seats.get(o.id)?.user ?? null])),
      jukebox: Object.fromEntries([...this.jukeboxes].map(([id, j]) => [id, j.state])) };
  }
  private toPublic = (u: User): PublicUser => {
    const { path: _p, email: _e, meetLink: _m, google: _g, offlineAt: _o, lastSpot: _l, resume: _rs, presenceBeforeCall: _b, prev: _v, afk: _a, returnTo: _r, walkSeq: _s, dungeon: _d, lastKeySpot: _k, dungeonTimers: _t, items: _i, ...pub } = u;
    return pub;
  };

  /** `wire`, when given, receives broadcasts as one shared JSON string instead of `send` getting the object. */
  connect(userId: string, send: Send, wire?: Wire) {
    const u = this.users.get(userId);
    if (!u) throw new Error('unknown user');
    if (!this.sockets.has(userId)) this.sockets.set(userId, new Map());
    const socket = randomUUID();
    this.sockets.get(userId)!.set(socket, send);
    const listener = { send, wire };
    this.listeners.add(listener);
    send({ t: 'hello', you: userId, serverTime: Date.now(), build: this.build });
    if (u.presence === 'offline' && onMap(u)) this.wakeVacation(u);
    this.stayAfterAll(u);
    this.grantHats(u);
    if (!u.plant && !u.bot) { u.plant = this.newPlant(u, dayNumber(Date.now()) - 1); this.plantChanged(u); } // a pot on your desk from day one; today's status already grows it
    if (u.presence === 'offline') this.comeIn(u);
    send({ t: 'layout', layout: this.layout() }); // before anyone's walk, which every client paths on this floor
    send(this.snapshot());
    send(this.me(u));
    if (!u.bot) send({ t: 'later', items: this.laterList.get(userId) ?? [] });
    if (underground(u) && u.dungeon) send({ t: 'dungeon', ...u.dungeon });
    if (u.reading) this.stopReading(u); // a fresh page has no overlay; the old read ends
    send({ t: 'meetings', rooms: this.meetingRooms() });
    send({ t: 'library', ...this.library.state() });
    if (!u.bot) send({ t: 'tickets', list: this.tickets.visibleTo(u.id, this.isAdmin(u)) });
    send({ t: 'creatures', creatures: this.creatures.all() });
    send({ t: 'cups', cups: this.creatures.cups });
    send({ t: 'arcade', cabinets: this.arcade.summary() });
    send({ t: 'arcade_boards', boards: this.arcade.boards() });
    send({ t: 'retro_cabinets', cabinets: this.retro.summary() });
    send({ t: 'retro_boards', boards: this.retro.boards() });
    if (!this.retro.has(u)) send({ t: 'retro_session', view: null }); // an overlay left from before a restart closes
    for (const person of this.users.values()) send({ t: 'game_status', userId: person.id, game: person.game });
    if (!u.bot) this.meetings.sendAgenda(u, true);
    send({ t: 'voice_wait', roomId: this.waiting.get(userId) ?? null });
    this.syncPresentation(u, send);
    this.present?.back(u.id);
    const call = u.callId ? this.calls.get(u.callId) : undefined; // a reloaded page gets its call's Meet link back
    if (call) send({ t: 'call', userId: u.id, callId: call.id, link: call.link });
    const inst = u.instance ? this.instances.get(u.instance) : undefined;
    if (inst?.meet) send({ t: 'room_meet', instance: inst.id, link: inst.meet });
    this.setOwner(userId, socket);
    return { socket, close: () => {
      this.listeners.delete(listener);
      const set = this.sockets.get(userId)!; if (!set.delete(socket)) return;
      this.setLofiListening(u, socket, false);
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
    if (old && u?.table) this.sockets.get(userId)?.get(old)?.({ t: 'table', view: null });
    if (old && u && this.retro.has(u)) this.sockets.get(userId)?.get(old)?.({ t: 'retro_session', view: null, reason: 'elsewhere' });
    if (socket) this.owners.set(userId, socket); else this.owners.delete(userId);
    for (const [id, send] of this.sockets.get(userId) ?? []) send({ t: 'voice_owner', owner: id === socket });
    if (socket && u) { this.arcade.resend(u); if (u.table) this.table.resend(u); this.retro.handover(u); }
  }

  // ---------- arriving & leaving ----------
  /** Back from offline: step in through the exit door, bag in hand, and walk to their spot. */
  private comeIn(u: User) {
    const to = this.arrivalSpot(u); // before going online, so their own old tile doesn't count as taken
    const resume = u.resume && to.x === u.tile.x && to.y === u.tile.y;
    u.resume = undefined;
    if (resume) { u.move = null; u.path = null; this.setPresence(u, 'online'); return; } // a restart under them: still right there
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
      this.beach.release(u);
      this.setDoor(u, 'leaving');
      u.lastSpot = this.position(u).dest;
      const vacationExit = !!u.vacation && !!this.map.vacation;
      const exit = vacationExit ? this.map.vacation!.gate : this.map.exit;
      const at = this.walk(u, exit, 'up');
      this.doorTimer(u, () => {
        this.setDoor(u, null);
        this.arcade.leave(u); this.table.leave(u); this.retro.leave(u);
        u.offlineAt = Date.now();
        this.setPresence(u, 'offline');
      }, at === null && vacationExit ? 0 : Math.max(0, (at ?? Date.now()) - Date.now()) + DOOR_PAUSE_MS);
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

  // ---------- vacation ----------
  beach = new Beach(this);
  vacations = new Vacations(this);
  setVacation(u: User, vacation: Vacation | null) {
    const old = u.vacation;
    if ((old ?? null) === vacation || old && vacation && old.until === vacation.until && old.back === vacation.back) return;
    u.vacation = vacation;
    this.broadcast({ t: 'vacation', userId: u.id, vacation });
    if (u.presence !== 'offline' || u.instance || !this.map.vacation) return;
    if (vacation && !old) {
      this.beach.release(u); this.doorTimer(u, null);
      this.bumpWalk(u); u.tile = { ...this.map.vacation.gate }; u.move = null; u.path = null; u.prev = undefined; u.resume = undefined;
      this.setDoor(u, 'arriving');
      this.beach.arrive(u, () => this.setDoor(u, null));
    } else if (!vacation && old) {
      this.beach.release(u); this.doorTimer(u, null);
      this.setDoor(u, 'leaving');
      const at = this.walk(u, this.map.vacation.gate, 'up');
      this.vacationGoneAt(u, at);
    }
  }
  private vacationGoneAt(u: User, at: number | null) {
    if (at === null) { this.bumpWalk(u); u.move = null; u.path = null; u.prev = undefined; this.setDoor(u, null); return; }
    const seq = u.walkSeq;
    this.doorTimer(u, () => { if (u.walkSeq === seq) this.setDoor(u, null); }, Math.max(0, at - Date.now()) + DOOR_PAUSE_MS);
  }
  private wakeVacation(u: User) {
    this.beach.release(u); this.doorTimer(u, null);
    if (u.move) this.walk(u, this.position(u).next);
    this.setDoor(u, null); u.resume = undefined;
    this.setPresence(u, 'online');
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
    this.broadcast({ t: 'user', user: this.toPublic(u) });
    if (!bot) this.vacations.syncDev();
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
  /** Standing beside the object (or heading to a tile beside it, with `settled` false). */
  isBeside(userId: string, objectId: string, settled = true) {
    const u = this.users.get(userId), o = this.map.objects.find(o => o.id === objectId);
    if (!u || !o || (u.instance && (underground(u) || o.use?.kind !== 'presentation')) || u.presence === 'offline') return false; // a meeting has its own copy of the board
    const p = this.position(u), t = settled ? p.next : p.dest;
    if (settled && (p.next.x !== p.dest.x || p.next.y !== p.dest.y)) return false;
    return Math.max(o.x - t.x, t.x - (o.x + o.w - 1), 0) <= 1 && Math.max(o.y - t.y, t.y - (o.y + o.h - 1), 0) <= 1;
  }
  roomOf(u: User) { const p = this.position(u); return roomAt(this.map, p.tile.x, p.tile.y); }

  /** Start a walk. Mid-walk, the new path starts at the tile being entered, timed for when we get there. */
  walk(u: User, to: Tile, face?: Dir, now = Date.now(), msPerTile?: number): number | null {
    const pos = this.position(u, now);
    const from = pos.next;
    const keepOut = !this.isSysadmin(u); // admins-only rooms: everyone else's path goes around, and never in
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
    this.arcade.leave(u); this.table.leave(u); this.retro.leave(u);
    u.prev = u.move && u.path && now < u.move.startedAt + pathDuration(u.path, u.move.ms) ? { path: u.path, startedAt: u.move.startedAt, ...(u.move.ms ? { ms: u.move.ms } : {}) } : undefined;
    const per = msPerTile ?? walkMs(u.effects), ms = per === WALK_MS_PER_TILE ? undefined : per; // the usual pace stays implicit
    u.move = { from, to, startedAt, face, ...(ms ? { ms } : {}) }; u.path = path; u.tile = to;
    if (face) u.dir = face;
    else if (path.length > 1) { const a = path[path.length - 2], b = path[path.length - 1]; u.dir = b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : 'up'; }
    this.broadcast({ t: 'move', userId: u.id, from, to, startedAt, face, ms, path: keepOut ? path : undefined }); // clients path without the lock
    for (const f of this.users.values()) if (f.following === u.id) this.trail(f, to, startedAt + FOLLOW_LAG_MS);
    if (!u.bot && !u.effects.some(e => e.kind === 'dance') && this.onDanceFloor(to)) { // walked onto the floor: dance once there
      const seq = u.walkSeq;
      setTimeout(() => { if (u.walkSeq === seq) this.startDance(u); }, Math.max(0, startedAt + pathDuration(path, per) - now));
    }
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
    if (id && this.users.get(id)?.presence === 'offline') return;
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
    if (!o || !routes(o.use, 'use') || goingOut(u) || (u.instance && (underground(u) || o.use.kind !== 'presentation')) || u.presence === 'offline' || ((o.use.kind === 'arcade' || o.use.kind === 'table' || o.use.kind === 'retro' || o.use.kind === 'presentation' || o.use.kind === 'room_start' || o.use.kind === 'tickets') && u.bot)) return;
    const item = o.use.kind === 'take' ? (itemId === undefined ? o.use.items[0] : o.use.items.find(i => i.id === itemId)) : null;
    if (o.use.kind === 'take' && !item) return;
    if (o.use.kind === 'toilet') return this.useToilet(u, o);
    this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    const here = this.position(u).next, occ = this.occupied(u.instance);
    let best: { spot: Spot; len: number } | null = null;
    for (const s of besideObject(this.map, o)) {
      const mine = s.x === here.x && s.y === here.y;
      if (!mine && occ.has(`${s.x},${s.y}`)) continue;
      const len = mine ? 0 : ((o.use.kind === 'arcade' || o.use.kind === 'table' || o.use.kind === 'retro') ? pathTo(this.map, here, s) : findPath(this.map, here, s)).length;
      if (!mine && !len) continue;
      if (!best || len < best.len) best = { spot: s, len };
    }
    if (!best && (o.use.kind === 'arcade' || o.use.kind === 'table' || o.use.kind === 'retro')) {
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
      if (d.x !== spot.x || d.y !== spot.y || u.presence === 'offline' || goingOut(u) || (u.instance && o.use!.kind !== 'presentation')) return; // wandered off on the way
      const current = this.map.objects.find(it => it.id === objectId);
      if (!current?.use || current.use.kind !== o.use!.kind) return;
      if (current.use.kind === 'table') { if (!u.bot && this.sockets.get(u.id)?.size) { this.retro.leave(u); this.table.join(u, current.id); } return; }
      if (current.use.kind === 'arcade') { if (!u.bot && this.sockets.get(u.id)?.size) { this.retro.leave(u); this.arcade.join(u, current.id); } return; }
      if (current.use.kind === 'retro') { if (!u.bot && this.sockets.get(u.id)?.size) { this.arcade.leave(u); this.table.leave(u); void this.retro.join(u, current.id); } return; }
      if (current.use.kind === 'bell') this.ringBell(u, current);
      else if (current.use.kind === 'presentation') { if (!u.bot) this.sendTo(u.id, { t: 'present_open', objectId: current.id }); }
      else if (current.use.kind === 'room_start') { if (!u.bot) this.sendTo(u.id, { t: 'room_open' }); }
      else if (current.use.kind === 'tickets') { if (!u.bot) this.sendTo(u.id, { t: 'terminal_open', objectId: current.id }); }
      else if (o.use!.kind === 'toggle') this.setObject(o.id, !this.objectOn.get(o.id), u);
      else if (current.use.kind === 'dealer') {
        const want = itemId && current.use.items.includes(itemId) ? itemId : current.use.items[0];
        const hat = hatOf(want);
        if (this.addItem(u, want)) this.sendTo(u.id, { t: 'notice', text: hat ? `${HAT_NAMES[hat] ?? hat} · in your pockets 🎒` : phrase('bouncer', 'deal') });
      }
      else if (item) {
        if (current.use.kind !== 'take' || !current.use.items.some(i => i.id === item.id)) return;
        this.setHolding(u, item.id, o.id);
        if (o.type === 'coffee_machine') this.addEffect(u, 'speed'); // a fresh cup: quick on your feet for a while
        this.refreshment(u, item.id);
      }
    }, Math.max(0, at - Date.now()) + (o.use.kind === 'arcade' || o.use.kind === 'table' || o.use.kind === 'retro' ? 0 : USE_MS[o.use.kind])));
  }
  // ---------- bug terminal ----------
  /** Everyone who can see this ticket (its author and every office admin) gets their fresh list. */
  private ticketsChanged(t: Ticket) {
    for (const p of this.users.values()) if (!p.bot && (p.id === t.by || this.isAdmin(p)) && this.sockets.get(p.id)?.size) this.sendTo(p.id, { t: 'tickets', list: this.tickets.visibleTo(p.id, this.isAdmin(p)) });
  }
  private tellAdmins(text: string, except: string) { for (const p of this.users.values()) if (p.id !== except && !p.bot && this.isAdmin(p)) this.sendTo(p.id, { t: 'notice', text }); }
  private atTerminal(u: User) {
    const here = this.position(u).dest;
    return !u.instance && this.map.objects.some(o => o.use?.kind === 'tickets' && besideObject(this.map, o).some(s => s.x === here.x && s.y === here.y));
  }
  private ticketNew(u: User, msg: Extract<ClientMsg, { t: 'ticket_new' }>) {
    if (u.bot) return;
    if (!this.atTerminal(u)) return this.sendTo(u.id, { t: 'notice', text: 'File bugs at the terminal in the Lobby' });
    const p = this.position(u).dest;
    const t = this.tickets.add(u.id, msg.title, msg.text, msg.context, { room: roomAt(this.map, p.x, p.y)?.id, tile: { x: p.x, y: p.y } }, Date.now());
    if (typeof t === 'string') return this.sendTo(u.id, { t: 'notice', text: t });
    this.ticketsChanged(t);
    this.tellAdmins(`📟 New bug ${ticketNo(t.id)} from ${u.name}: ${t.title}`, u.id);
  }
  private ticketReply(u: User, id: number, text: unknown) {
    if (u.bot) return;
    const admin = this.isAdmin(u), t = this.tickets.reply(id, u.id, admin, text, Date.now());
    if (!t) return;
    if (typeof t === 'string') return this.sendTo(u.id, { t: 'notice', text: t });
    this.ticketsChanged(t);
    if (t.by === u.id) this.tellAdmins(`📟 ${u.name} replied on ${ticketNo(t.id)}`, u.id);
    else this.sendTo(t.by, { t: 'notice', text: `📟 Reply on your bug ${ticketNo(t.id)}: read it at the Lobby terminal` });
  }
  private ticketStatus(u: User, id: number, status: unknown) {
    if (u.bot) return;
    const t = this.tickets.setStatus(id, u.id, this.isAdmin(u), status, Date.now());
    if (!t) return;
    this.ticketsChanged(t);
    const author = this.users.get(t.by);
    if (author && author.id !== u.id) {
      this.sendTo(author.id, { t: 'notice', text: `📟 Your bug ${ticketNo(t.id)} was marked ${t.status}` });
      if (t.status === 'fixed' && !author.achievements.bughunter) { this.award(author, 'bughunter', Date.now()); this.plantChanged(author); }
    }
  }
  private ticketSeen(u: User, id: number) {
    const t = this.tickets.seen(id, u.id, this.isAdmin(u), Date.now());
    if (t) this.sendTo(u.id, { t: 'tickets', list: this.tickets.visibleTo(u.id, this.isAdmin(u)) });
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
    const item = u.holding;
    this.atTable(u, tile, () => {
      if (u.holding !== item) return; // changed their mind
      const cup = this.creatures.addCup(tile, item, Date.now());
      if (typeof cup === 'string') this.sendTo(u.id, { t: 'notice', text: cup });
      else this.setHolding(u, null);
    });
  }
  /** Walk over to a cup someone left and clear it away. The cleaner, if she's in the room, is delighted. Plates stay:
   *  someone may still be eating. */
  takeCup(u: User, cupId: string) {
    const cup = this.creatures.cups.find(c => c.id === cupId);
    if (!cup || !CUP_ITEMS.includes(cup.item) || u.bot || u.instance || goingOut(u) || u.presence === 'offline') return;
    this.atTable(u, cup.tile, () => {
      if (!this.creatures.cups.some(c => c.id === cupId)) return; // the cleaner (or someone) got there first
      const now = Date.now();
      this.creatures.removeCup(cupId);
      if (this.creatures.praise(this.roomOf(u)?.id, now) && !u.achievements.tidy) { this.award(u, 'tidy', now); this.plantChanged(u); }
    });
  }
  /** Walk to the nearest free spot beside a table tile, face it, then (if still there) do `then`. */
  private atTable(u: User, tile: Tile, then: () => void) {
    const here = this.position(u).next, occ = this.occupied();
    const spots = this.creatures.beside(tile).filter(s => (s.x === here.x && s.y === here.y) || !occ.has(`${s.x},${s.y}`))
      .map(s => ({ s, len: s.x === here.x && s.y === here.y ? 0 : findPath(this.map, here, s).length })).filter(p => p.s.x === here.x && p.s.y === here.y || p.len);
    spots.sort((a, b) => a.len - b.len);
    const spot = spots[0]?.s;
    if (!spot) return;
    this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    const at = this.walk(u, spot, dirBetween(spot, tile)) ?? Date.now();
    this.errands.set(u.id, setTimeout(() => {
      this.errands.delete(u.id);
      const d = this.position(u).dest;
      if (d.x !== spot.x || d.y !== spot.y || u.instance) return; // wandered off on the way
      then();
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
    if (!u.achievements.bellringer) { this.award(u, 'bellringer', now); this.plantChanged(u); }
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
  private refreshment(u: User, item: string, now = Date.now()) {
    if (u.bot) return;
    const drunk = effectOf(u.effects, 'drunk');
    const active = drunk && (drunk.until === undefined || drunk.until > now) ? drunk : undefined;
    if (item === 'cocktail') {
      const level = Math.min(DRUNK_MAX_LEVEL, drunkLevel(active) + 1);
      const remaining = active?.until === undefined ? 0 : Math.max(0, active.until - now);
      this.addEffect(u, 'drunk', { ms: Math.min(DRUNK_MAX_MS, remaining + EFFECTS.drunk.ms!), data: { level } }, now);
      this.sendTo(u.id, { t: 'notice', text: `🍹 ${DRUNK_NAMES[level - 1]} · round ${level}/${DRUNK_MAX_LEVEL}. Coconut takes the wobble down.` });
    } else if (item === 'coconut') {
      const level = drunkLevel(active), remaining = (active?.until ?? now + EFFECTS.drunk.ms!) - now - EFFECTS.drunk.ms!;
      if (level > 1 && remaining > 0) this.addEffect(u, 'drunk', { ms: remaining, data: { level: level - 1 } }, now);
      else this.removeEffect(u, 'drunk', now);
      this.addEffect(u, 'refreshed', {}, now);
      this.sendTo(u.id, { t: 'notice', text: level ? '🥥 A little clearer. One less round of wobble.' : '🥥 Fresh coconut. Beach mode: restored.' });
    } else if (item === 'icecream') {
      const burning = !!effectOf(u.effects, 'fire_aura');
      this.removeEffect(u, 'fire_aura', now);
      this.addEffect(u, 'chilled', {}, now);
      this.sendTo(u.id, { t: 'notice', text: burning ? '🍦 Fire extinguished. Brain freeze activated.' : '🍦 Brain freeze! A tiny snow day on the beach.' });
    }
  }
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
  private onDanceFloor(t: Tile) { return this.map.objects.some(o => o.use?.kind === 'dance' && inRect(o, t.x, t.y)); }
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
  /** Office admins find the sysadmin cap in their pockets (by sign-in email). The first time, it goes straight on; later they
   *  wear what they like. Someone no longer an admin loses it. */
  private grantHats(u: User) {
    const wearing = u.effects.find(e => e.kind === 'hat')?.data?.style, item = hatItem(ADMIN_HAT), has = u.items.includes(item), should = this.isAdmin(u);
    if (should && !has) { u.items = [...u.items, item]; if (!wearing) this.addEffect(u, 'hat', { data: { style: ADMIN_HAT } }); this.sendTo(u.id, this.me(u)); }
    if (!should && has) { u.items = u.items.filter(i => i !== item); if (wearing === ADMIN_HAT) this.removeEffect(u, 'hat'); this.sendTo(u.id, this.me(u)); }
  }
  // ---------- renaming people (admins) ----------
  /** An admin renames a person (someone took another's name). Names stay unique, and can't be a plain-name admin entry (that would make them an admin on name logins). */
  private rename(u: User, msg: Extract<ClientMsg, { t: 'rename' }>) {
    const target = this.users.get(String(msg.targetId)), say = (text: string) => this.sendTo(u.id, { t: 'notice', text });
    if (!this.isAdmin(u) || !target || target.bot) return;
    const name = String(msg.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!name) return say('✏️ A name can\'t be empty');
    if (name === target.name) return;
    const clash = this.findByName(name);
    if (clash && clash.id !== target.id) return say(`✏️ "${clash.name}" is taken`);
    if ([...ADMINS, ...SYSADMINS].some(a => !a.includes('@') && a === name.toLowerCase())) return say('✏️ That name is reserved');
    const was = target.name;
    target.name = name;
    this.broadcast(this.snapshot());
    say(`✏️ ${was} is now ${name}`);
    if (target.id !== u.id) this.sendTo(target.id, { t: 'notice', text: `✏️ ${u.name} renamed you to ${name}` });
  }

  // ---------- teleport (admins) ----------
  /** An admin steps through a portal to stand beside anyone on the floor. The server jumps them at once; every client plays the portals (`teleport`). */
  private teleport(u: User, targetId: string) {
    const target = this.users.get(targetId), say = (text: string) => this.sendTo(u.id, { t: 'notice', text });
    if (!this.isAdmin(u) || u.presence === 'offline' || !target || target.id === u.id || target.presence === 'offline') return;
    if (u.instance || target.instance || goingOut(u)) return say('🌀 No portal from here: you or they are in a meeting, underground or on the way out');
    const there = this.position(target).dest;
    if (!this.isSysadmin(u) && adminOnly(this.map, there.x, there.y)) return say('🔒 Admin room: sysadmins only');
    const taken = new Set([...this.users.values()].filter(p => p.presence !== 'offline' && !p.instance && p.id !== u.id).map(p => { const d = this.position(p).dest; return `${d.x},${d.y}`; }));
    let to: Tile | null = null;
    for (let r = 1; r <= 3 && !to; r++) { // the nearest free tile around them, front first
      for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [0, 2], [2, 0], [-2, 0], [0, -2], [2, 2], [-2, 2], [2, -2], [-2, -2], [0, 3], [3, 0], [-3, 0], [0, -3]]) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const t = { x: there.x + dx, y: there.y + dy };
        if (!isWalkable(this.map, t.x, t.y) || taken.has(`${t.x},${t.y}`) || seatAt(this.map, t.x, t.y)) continue;
        if (!this.isSysadmin(u) && adminOnly(this.map, t.x, t.y)) continue;
        if (roomAt(this.map, t.x, t.y)?.id !== roomAt(this.map, there.x, there.y)?.id) continue; // not through a wall into the next room
        to = t; break;
      }
    }
    if (!to) return say('🌀 No room to step out next to them');
    const from = this.position(u).tile;
    for (const k of this.knocks.values()) if ((k.fromId === u.id || k.toId === u.id) && (k.state === 'walking' || k.state === 'pending')) this.closeKnock(k, 'later', 'Knock cancelled', k.fromId === u.id);
    this.stopReading(u); this.leaveCall(u); this.setFollowing(u, null);
    for (const [id, seat] of this.seats) if (seat.user === u.id) this.endSeat(id);
    this.toilets.leave(u.id, Date.now()); this.arcade.leave(u); this.table.leave(u); this.retro.leave(u);
    if (u.effects.some(e => e.kind === 'dance') && roomAt(this.map, to.x, to.y)?.id !== DANCE_ROOM) this.removeEffect(u, 'dance');
    this.place(u, to);
    u.dir = dirBetween(to, there); this.broadcast({ t: 'instance', userId: u.id, instance: u.instance, tile: u.tile, dir: u.dir });
    this.broadcast({ t: 'teleport', userId: u.id, from, to });
  }
  /** An admin looks into someone's pockets (never part of the public user). */
  private gmItems(u: User, msg: Extract<ClientMsg, { t: 'gm_items' }>) {
    const target = this.users.get(String(msg.targetId));
    if (!this.isAdmin(u) || !target) return;
    this.sendTo(u.id, { t: 'gm_items', targetId: target.id, items: target.items });
  }
  /** An admin gifts a hat: it goes into the person's pockets (even offline) and straight onto their head. */
  private giftHat(u: User, msg: Extract<ClientMsg, { t: 'gift_hat' }>) {
    const target = this.users.get(String(msg.targetId)), style = String(msg.style ?? '');
    if (!this.isAdmin(u) || !target || target.bot || !(ALL_HATS as readonly string[]).includes(style)) return;
    const item = hatItem(style);
    if (!target.items.includes(item)) { target.items = [...target.items, item]; this.sendTo(target.id, this.me(target)); }
    this.addEffect(target, 'hat', { data: { style } });
    this.sendTo(u.id, { t: 'gm_items', targetId: target.id, items: target.items });
    if (target.id !== u.id) this.sendTo(target.id, { t: 'notice', text: `🎁 ${u.name} gave you the ${(HAT_NAMES[style] ?? style).toLowerCase()}` });
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

  // ---------- vampire bite ----------
  /** A vampire clicks Bite: walk up beside them (one tile away is enough), then bite. They turn for BITE_MS, so it spreads.
   *  If they walked off meanwhile, give chase a few more times. */
  private bite(u: User, targetId: string, chase = 4) {
    const target = this.users.get(targetId);
    const ok = () => !!target && !!u.effects.some(e => e.kind === 'vampire') && target.id !== u.id && onMap(u) && u.presence !== 'offline' && target.presence !== 'offline'
      && u.instance === target.instance && !goingOut(u) && !goingOut(target) && !target.effects.some(e => e.kind === 'vampire');
    if (!ok()) return;
    const near = (t: Tile) => { const d = this.position(target!).dest; return Math.max(Math.abs(t.x - d.x), Math.abs(t.y - d.y)) <= 1; };
    const sink = () => {
      if (!ok() || !near(this.position(u).dest)) return;
      this.addEffect(target!, 'vampire', { ms: BITE_MS });
      u.dir = dirBetween(this.position(u).dest, this.position(target!).dest);
      this.broadcast({ t: 'instance', userId: u.id, instance: u.instance, tile: u.tile, dir: u.dir });
      this.sendTo(target!.id, { t: 'notice', text: `🧛 ${u.name} bit you! You're a vampire for 2 minutes: go bite someone` });
      this.sendTo(u.id, { t: 'notice', text: `🧛 You bit ${target!.name}` });
    };
    const here = this.position(u).next;
    if (near(here)) { this.cancelSeatWalk(u.id); return sink(); }
    const there = this.position(target!).dest, occ = this.occupied(u.instance);
    const spots = [{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: -1 }].map(d => ({ x: there.x + d.x, y: there.y + d.y }))
      .filter(s => isWalkable(this.map, s.x, s.y) && !occ.has(`${s.x},${s.y}`) && !seatAt(this.map, s.x, s.y))
      .map(s => ({ s, len: findPath(this.map, here, s, !this.isSysadmin(u)).length })).filter(p => p.len).sort((a, b) => a.len - b.len);
    const spot = spots[0]?.s;
    if (!spot) return this.sendTo(u.id, { t: 'notice', text: `🧛 Can't get close enough to ${target!.name}` });
    this.cancelSeatWalk(u.id); this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    const at = this.walk(u, spot, dirBetween(spot, there)) ?? Date.now();
    this.errands.set(u.id, setTimeout(() => {
      this.errands.delete(u.id);
      const d = this.position(u).dest;
      if (d.x !== spot.x || d.y !== spot.y) return; // changed their mind
      if (near(d)) sink(); else if (chase > 0) this.bite(u, targetId, chase - 1);
    }, Math.max(0, at - Date.now()) + 200));
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
    const existing = [to, from].map(u => u.callId ? this.calls.get(u.callId) : undefined).find(knockCall);
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
    if (!hadCalendar && link?.scopes.includes(CALENDAR_SCOPE)) { this.vacations.soon(); void this.meetings.poll(); } // their meetings show up now, not in 2 minutes
  }

  // ---------- the place under the garden ----------
  private sameTile(a: Tile, b: Tile) { return a.x === b.x && a.y === b.y; }
  private inDungeon(t: Tile) {
    const r = this.map.dungeon?.rect;
    return !!r && inRect(r, t.x, t.y);
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
  private instances = new Map<string, Instance>();
  meetingRooms() {
    return [...this.instances.values()].map(i => ({ id: i.id, until: i.end, members: [...i.members], voice: [...(this.calls.get(`room:${i.id}`)?.members ?? [])] }));
  }
  private meetingRect() { return this.map.rooms.find(r => r.id === MEETING_ROOM_ID)!.rect; }
  private inMeetingRoom(t: Tile) { return inRect(this.meetingRect(), t.x, t.y); }
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
    this.present?.moved(u.id); this.syncPresentation(u); // a new scope has its own screen
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
    if (!inst) { inst = { id: m.instance, end: m.end, members: new Set(), talk: new Set(), out: new Set() }; this.instances.set(inst.id, inst); }
    u.returnTo = this.position(u).dest;
    const occ = this.occupied(inst.id), r = this.meetingRect(), seats: Tile[] = [], floor: Tile[] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (occ.has(`${x},${y}`)) continue;
      if (seatAt(this.map, x, y)) seats.push({ x, y }); else if (isWalkable(this.map, x, y)) floor.push({ x, y });
    }
    const spot = seats[0] ?? floor[Math.floor(Math.random() * floor.length)];
    if (!spot) return;
    this.arcade.leave(u); this.table.leave(u); this.retro.leave(u);
    inst.members.add(u.id);
    u.instance = inst.id;
    this.place(u, spot);
    if (inst.meet) this.sendTo(u.id, { t: 'room_meet', instance: inst.id, link: inst.meet });
    if (m.adhoc) this.roomVoice(u, true, true); // private rooms start with voice on; calendar meetings have their own call, so it's opt-in
    this.broadcast({ t: 'meetings', rooms: this.meetingRooms() });
    this.meetings.rejoin(u, key); // Go after leaving for good: in the meeting again
  }
  /** Valid invitees: existing humans other than the sender, deduped, at most 29. */
  private inviteList(u: User, ids: unknown): string[] {
    if (!Array.isArray(ids)) return [];
    const out = new Set<string>();
    for (const id of ids) { const o = typeof id === 'string' ? this.users.get(id) : undefined; if (o && !o.bot && o.id !== u.id) out.add(o.id); }
    return [...out].slice(0, 29);
  }
  private canHost(u: User) { return !u.bot && u.presence !== 'offline' && !goingOut(u) && !underground(u); }
  /** Start a private room (a Meeting-room copy for the invited) and step the host in. */
  roomCreate(u: User, title: unknown, invite: unknown) {
    if (!this.canHost(u)) return;
    const name = (typeof title === 'string' ? title.trim().slice(0, 40) : '') || 'Private room';
    const m = this.meetings.createAdhoc(u, name, new Set(this.inviteList(u, invite)));
    this.enterMeeting(u, m.key);
    if (u.instance !== m.instance) { this.meetings.events.delete(m.key); return; } // no free spot: nothing started
    this.meetings.notify(m);
  }
  /** Add people to the private room the sender is in. */
  roomInvite(u: User, ids: unknown) {
    const m = this.meetings.adhocOf(u);
    if (!m?.adhoc || !this.canHost(u)) return;
    const add = this.inviteList(u, ids).filter(id => !m.adhoc!.invited.has(id)).slice(0, Math.max(0, 30 - m.adhoc.invited.size));
    if (!add.length) return;
    for (const id of add) m.adhoc.invited.add(id);
    this.meetings.notify(m);
  }
  private instanceOf(u: User) { return u.instance && !underground(u) ? this.instances.get(u.instance) : undefined; }
  /** A meeting room's voice is a hall like Coffee's, scoped to the instance (`room:<instance>`, ROOM_VOICE_MAX).
   *  Private rooms put everyone on it when they step in; calendar meetings (which have their own call link) are opt-in.
   *  Past the cap you wait in line for a place (`voice_wait`), and Meet is there for everyone. */
  roomVoice(u: User, on: boolean, entering = false) {
    const inst = this.instanceOf(u);
    if (!inst || u.bot || u.presence === 'offline' || goingOut(u)) return;
    if (!on) {
      inst.talk.delete(u.id); inst.out.add(u.id); this.setWaiting(u, null);
      if (u.callId === `room:${inst.id}`) this.leaveCall(u);
      return;
    }
    if (entering && inst.out.has(u.id)) return; // left the voice on purpose: coming back doesn't put them on air
    inst.out.delete(u.id); inst.talk.add(u.id);
    this.joinInstanceHall(u, inst);
  }
  private instEligible(u: User, inst: Instance) {
    return !u.bot && !u.afk && u.presence !== 'offline' && !goingOut(u) && u.instance === inst.id && inst.talk.has(u.id) && !!this.sockets.get(u.id)?.size;
  }
  private joinInstanceHall(u: User, inst: Instance) {
    const id = `room:${inst.id}`;
    if (u.callId === id) return;
    let call = this.calls.get(id);
    if (call) this.maintainRoom(call);
    if (u.callId === id) return;
    if (call && call.members.size >= ROOM_VOICE_MAX) {
      this.setWaiting(u, inst.id);
      return this.sendTo(u.id, { t: 'notice', text: `Voice here is full (${ROOM_VOICE_MAX}): you're in line, or use Meet` });
    }
    if (!call) call = { id, members: new Set(), fallback: false, room: this.map.rooms.find(r => r.id === MEETING_ROOM_ID)!, instance: inst.id };
    this.calls.set(id, call); this.joinCall(u, call);
  }
  /** "Use Meet" in a private room: one Meet link for everyone in it now and later (members only). The host's
   *  Google makes a fresh room; without Google it falls back to a personal link. Calendar meetings keep the event's own. */
  roomMeet(u: User) {
    const inst = this.instanceOf(u), m = this.meetings.adhocOf(u);
    if (!inst || !m?.adhoc || u.bot || inst.meetBusy) return;
    if (inst.meet) return this.sendTo(u.id, { t: 'room_meet', instance: inst.id, link: inst.meet });
    const host = this.users.get(m.adhoc.host), people = [host, u].filter((p): p is User => !!p && !p.bot);
    const personal = people.find(p => p.meetLink)?.meetLink, google = people.find(p => p.google);
    const share = (link: string) => { inst.meet = link; for (const id of inst.members) this.sendTo(id, { t: 'room_meet', instance: inst.id, link }); };
    if (!google?.google) return personal ? share(personal) : this.sendTo(u.id, { t: 'notice', text: 'No Meet link: set your own Meet link or connect Google first' });
    inst.meetBusy = true;
    const link = google.google;
    createSpace(google.id, link).then(share).catch(e => {
      console.warn(`google: no Meet room for ${google.name}:`, e.message);
      if (e.code === 'invalid_grant' && google.google === link) { google.google = undefined; forgetAccess(google.id); this.sendTo(google.id, this.me(google)); }
      if (personal) share(personal); else this.sendTo(u.id, { t: 'notice', text: 'Couldn\'t create a Meet room: try again in a moment' });
    }).finally(() => { inst.meetBusy = false; });
  }
  /** Back to where they were in the office (or the Lobby if someone's there now). */
  leaveMeeting(u: User, announce = true) {
    if (!u.instance || underground(u)) return;
    const inst = u.instance ? this.instances.get(u.instance) : undefined;
    for (const f of this.users.values()) if (f.following === u.id) this.setFollowing(f, null);
    this.setFollowing(u, null);
    clearTimeout(this.errands.get(u.id));
    this.setWaiting(u, null);
    if (inst && u.callId === `room:${inst.id}`) this.leaveCall(u);
    inst?.out.delete(u.id); inst?.talk.delete(u.id);
    u.instance = null;
    this.sendTo(u.id, { t: 'room_meet', instance: inst?.id ?? '', link: null });
    const occ = this.occupied(), back = u.returnTo && !occ.has(`${u.returnTo.x},${u.returnTo.y}`) ? u.returnTo : this.freeLobbyTile(occ);
    u.returnTo = undefined;
    this.place(u, back);
    if (inst) {
      inst.members.delete(u.id);
      if (!inst.members.size) { this.instances.delete(inst.id); this.present?.endScope(inst.id); }
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
      this.instances.delete(inst.id); this.present?.endScope(inst.id); changed = true;
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
    if (knockCall(call)) {
      u.presenceBeforeCall = u.presence === 'in_call' ? 'online' : u.presence;
      this.setPresence(u, 'in_call');
    } else if (call.room) {
      for (const k of this.knocks.values()) if ((k.fromId === u.id || k.toId === u.id) && (k.state === 'walking' || k.state === 'pending'))
        this.closeKnock(k, 'later', `Knock cancelled — ${u.name} walked into ${call.room.name}`);
    }
    for (const [id] of this.sockets) this.sendTo(id, { t: 'call', userId: u.id, callId: call.id, link: call.members.has(id) ? call.link : undefined });
    if (call.instance) this.broadcast({ t: 'meetings', rooms: this.meetingRooms() }); // the board's voice list follows every join, whoever caused it
    if (!knockCall(call)) return;
    const humansThere = [...call.members].some(id => !this.users.get(id)?.bot);
    const ms = !u.bot ? 2 * 60 * 60_000 : humansThere ? 120_000 + Math.random() * 180_000 : 30_000 + Math.random() * 60_000;
    this.callTimers.set(u.id, setTimeout(() => this.leaveCall(u), ms));
  }
  private hallEligible(u: User, room: Room, now: number) {
    if (room.rules.access === 'admins' && !this.isSysadmin(u)) return false;
    if (u.bot || u.afk || u.instance || u.presence === 'offline' || goingOut(u) || !this.sockets.get(u.id)?.size) return false; // a meeting's own room is off the floor
    if (u.callId && !this.calls.get(u.callId)?.room) return false;
    for (const k of this.knocks.values()) if (k.fromId === u.id && (k.state === 'walking' || k.state === 'pending')) { // knocking on someone in this hall: don't join its voice and cancel it
      const to = this.users.get(k.toId), d = to && this.position(to, now).dest;
      if (d && roomAt(this.map, d.x, d.y)?.id === room.id) return false;
    }
    const t = this.position(u, now).tile;
    return roomAt(this.map, t.x, t.y)?.id === room.id || doorwayTiles(this.map, room).some(g => g.some(p => p.x === t.x && p.y === t.y));
  }
  /** The hall (or stall's room) someone stands in, by position only: where hanging up a direct talk would put them on voice. */
  private hallIdAt(u: User, now = Date.now()): string | undefined {
    const stall = this.toilets.inside(u.id);
    if (stall) { const o = this.map.objects.find(o => o.id === stall); return o && roomAt(this.map, o.x, o.y - 1)?.id; }
    const table = this.chatTable(u);
    if (table) { const o = this.map.objects.find(o => o.id === table); return o && roomAt(this.map, o.x, o.y)?.id; }
    const t = this.position(u, now).tile;
    return voiceRooms(this.map).find(r => roomAt(this.map, t.x, t.y)?.id === r.id || doorwayTiles(this.map, r).some(g => g.some(p => p.x === t.x && p.y === t.y)))?.id;
  }
  private endKnockCall(u: User, call: Call) {
    const roomId = this.hallIdAt(u);
    if (roomId) for (const id of call.members) if (id !== u.id) this.sendTo(id, { t: 'call_moved', userId: u.id, roomId });
    this.leaveCall(u);
  }
  private maintainRoom(call: Call, now = Date.now()) {
    if (call.small) { if (!call.members.size) this.calls.delete(call.id); return; } // never more there than voice holds: no line
    for (const [id, roomId] of this.waiting) {
      if (roomId !== (call.instance ?? call.room!.id)) continue;
      const u = this.users.get(id);
      if (!u) { this.waiting.delete(id); continue; }
      const inst = call.instance ? this.instances.get(call.instance) : undefined;
      if (call.instance ? !inst || !this.instEligible(u, inst) : !this.hallEligible(u, call.room!, now)) continue;
      if (call.members.size < ROOM_VOICE_MAX) this.joinCall(u, call);
    }
    if (!call.members.size) this.calls.delete(call.id);
  }
  private canListenToLofi(u: User, now = Date.now()) {
    const tile = this.position(u, now).tile;
    return !u.bot && !u.instance && !goingOut(u) && u.presence !== 'offline' && !u.deafened && roomAt(this.map, tile.x, tile.y)?.id === 'music';
  }
  private setLofiListening(u: User, socket: string, on: boolean) {
    const pages = this.lofiListeners.get(u.id) ?? new Set<string>();
    if (on && this.canListenToLofi(u)) pages.add(socket); else pages.delete(socket);
    if (pages.size) this.lofiListeners.set(u.id, pages); else this.lofiListeners.delete(u.id);
    const next = pages.size ? 'lofi' : null;
    if ((u.listening ?? null) !== next) { u.listening = next; this.broadcast({ t: 'listening', userId: u.id, on: !!next }); }
  }
  voiceTick(now = Date.now()) {
    const rooms = voiceRooms(this.map);
    for (const u of this.users.values()) {
      if (u.listening && !this.canListenToLofi(u, now)) {
        this.lofiListeners.delete(u.id); u.listening = null; this.broadcast({ t: 'listening', userId: u.id, on: false });
      }
      if (u.bot || u.afk || u.presence === 'offline' || goingOut(u) || !this.sockets.get(u.id)?.size) { this.setWaiting(u, null); if (u.instance) { const c = this.calls.get(u.callId ?? ''); if (c?.instance) this.leaveCall(u, now); } continue; }
      const call = u.callId ? this.calls.get(u.callId) : undefined;
      if (u.instance) { // a meeting room's voice lives only inside that room, and sits outside the floor's halls
        const inst = this.instanceOf(u);
        if (call && call.instance !== u.instance) this.leaveCall(u, now);
        if (inst && inst.talk.has(u.id) && u.callId !== `room:${inst.id}` && this.waiting.get(u.id) !== inst.id) this.joinInstanceHall(u, inst);
        continue;
      }
      if (call?.instance) this.leaveCall(u, now);
      const stall = this.toilets.inside(u.id);
      if (call && knockCall(call)) { this.setWaiting(u, null); continue; } // a direct talk stays put in halls and stalls; hanging up hands them to the hall's voice
      if (stall) { this.setWaiting(u, null); this.joinSmall(u, stallVoiceId(stall), stall, 'the stall', 0, -1); continue; }
      const table = this.chatTable(u);
      if (table) { this.setWaiting(u, null); this.joinSmall(u, tableVoiceId(table), table, 'the lunch table', 0, 0); continue; }
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
  /** A small voice room on an object: behind a stall's door, or eating & chatting at a picnic table. Everyone there
   *  talks, one call per object; joining leaves any other room voice. (dx, dy): the tile whose room it belongs to. */
  private joinSmall(u: User, id: string, objectId: string, name: string, dx: number, dy: number) {
    if (u.callId === id) return;
    const o = this.map.objects.find(o => o.id === objectId), room = o && roomAt(this.map, o.x + dx, o.y + dy);
    if (!room) return;
    let hall = this.calls.get(id);
    if (!hall) this.calls.set(id, hall = { id, members: new Set(), fallback: false, room: { ...room, name }, small: objectId });
    this.joinCall(u, hall);
  }
  /** The picnic table someone eats at with "Eat & chat" on, sitting down. */
  private chatTable(u: User) { return u.eating?.open && this.eatingNow(u) ? this.tableOf(u) : null; }
  callFull(u: User) { const c = u.callId ? this.calls.get(u.callId) : undefined; return knockCall(c) && c!.members.size >= MAX_CALL_SIZE; }
  leaveCall(u: User, now = Date.now()) {
    const call = u.callId ? this.calls.get(u.callId) : undefined;
    clearTimeout(this.callTimers.get(u.id)); this.callTimers.delete(u.id);
    if (!u.callId) return;
    this.broadcast({ t: 'speaking', userId: u.id, on: false }); this.lowerHand(u);
    if (call ? knockCall(call) : u.presenceBeforeCall) { // a dissolved knock call is already gone from this.calls
      this.setPresence(u, u.presenceBeforeCall ?? 'online'); u.presenceBeforeCall = undefined;
    }
    u.callId = null;
    call?.members.delete(u.id);
    this.broadcast({ t: 'call', userId: u.id, callId: null });
    if (call?.instance) this.broadcast({ t: 'meetings', rooms: this.meetingRooms() });
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
    const beachArrivals = this.beach.cancelAll();
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
    for (const { u, entry } of beachArrivals) this.beach.arrive(u, entry);
    return true;
  }
  /** Lamps added get switched on, lamps removed are forgotten. */
  /** One Jukebox per jukebox on the floor; an admin moving it keeps what's playing. */
  private syncJukeboxes(announce = false) {
    const boxes = new Map(this.map.objects.filter(o => o.use?.kind === 'jukebox').map(o => [o.id, o.use?.kind === 'jukebox' ? o.use.genres : undefined]));
    const ids = new Set(boxes.keys());
    for (const id of ids) if (!this.jukeboxes.has(id)) {
      const j = new Jukebox(tracksFor(boxes.get(id)), Date.now()); this.jukeboxes.set(id, j);
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
      if (!onMap(u)) { if (!ok(u.tile)) u.tile = { ...this.map.spawn }; continue; }
      const p = this.position(u);
      const reroute = (to: Tile, face?: Dir) => {
        const at = this.walk(u, to, face);
        if (u.presence === 'offline' && !u.vacation && u.door === 'leaving') this.vacationGoneAt(u, at);
        return at;
      };
      if (!ok(p.dest)) { for (const t of this.freeNear(p.dest, u.instance)) if (reroute(t) !== null) break; }
      else if ((p.tile.x !== p.dest.x || p.tile.y !== p.dest.y) && u.path?.some(t => !ok(t))) reroute(p.dest, u.move?.face);
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
    for (const u of this.users.values()) if (onMap(u) && u.instance === instance) s.add(`${u.tile.x},${u.tile.y}`);
    return s;
  }

  // ---------- knock ----------
  private knockBlock(from: User, to: User) {
    if (underground(to)) return `${to.name} is somewhere underground 🕳`;
    if (underground(from)) return "You're underground — find the way out first";
    const dest = this.position(to).dest, target = roomAt(this.map, dest.x, dest.y);
    if (target?.rules.voice === 'open' && !knockCall(to.callId ? this.calls.get(to.callId) : undefined)) return `${to.name} is in ${target.name} — just walk in`;
    const call = to.callId ? this.calls.get(to.callId) : undefined, hall = call?.room;
    if (call?.small && call.id === tableVoiceId(call.small)) return `${to.name} is chatting at lunch — sit at their table and pick Eat & chat`;
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
    this.clearLater(from, to.id); // knocking on them is the answer to their knock
    const shared = this.tableOf(from);
    if (shared && shared === this.tableOf(to)) return this.arrive(k); // already side by side at the table
    const why = this.laterWhy(to);
    if (why) return this.keepLater(k, from, to, why, `${to.name} is ${why} — ${why === 'on vacation' ? 'sent to Later' : 'left a knock'}`); // no point walking over
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
    const why = this.laterWhy(to);
    if (why) return this.keepLater(k, from, to, why, `${to.name} is ${why} — ${why === 'on vacation' ? 'sent to Later' : 'left a knock'}`); // got busy during the walk
    k.state = 'pending';
    this.setEmote(to, 'knock');
    this.broadcast({ t: 'knock', knockId: k.id, fromId: from.id, toId: to.id });
    k.timer = setTimeout(() => this.closeKnock(k, 'later', `${to.name} didn't answer — sent to Later`), 30_000);
    if (to.bot) setTimeout(() => this.reply(to, k.id, Math.random() < 0.65 ? 'accept' : 'later'), 1500 + Math.random() * 2500);
  }

  /** Why a knock on this person goes to Later right now (null: they can answer). */
  private laterWhy(to: User): string | null {
    const room = this.roomOf(to), stall = this.toilets.inside(to.id), lunch = this.eatingNow(to) && !to.eating!.open;
    if (!(room?.rules.knock === 'later' || (to.presence === 'in_call' && !to.callId) || to.meeting || to.vacation || to.reading || stall || lunch)) return null;
    return stall ? 'on the toilet' : to.meeting ? 'in a meeting' : to.vacation ? 'on vacation' : to.reading ? 'reading' : lunch ? 'at lunch' : room?.rules.occupantLabel ?? 'in a call';
  }

  // ---------- Later list ----------
  // Knocks on someone busy are kept per person (memory only), newest first, one per knocker.
  private laterList = new Map<string, LaterItem[]>();
  /** When each person's current busy spell began (and what it is), to tell them who knocked once it's over. */
  private busy = new Map<string, { since: number; why: string }>();
  private sendLater(id: string) { this.sendTo(id, { t: 'later', items: this.laterList.get(id) ?? [] }); }
  private keepLater(k: Knock & { timer?: NodeJS.Timeout }, from: User, to: User, why: string, reason: string) {
    const items = (this.laterList.get(to.id) ?? []).filter(i => i.fromId !== from.id);
    items.unshift({ id: randomUUID().slice(0, 8), fromId: from.id, at: Date.now(), why });
    this.laterList.set(to.id, items.slice(0, LATER_MAX));
    this.sendLater(to.id);
    this.closeKnock(k, 'later', reason, false, true);
  }
  /** Drop what `fromId` left in this person's list (all of it without an id). */
  private clearLater(u: User, fromId?: string) {
    const items = this.laterList.get(u.id);
    if (!items?.length) return;
    const rest = fromId ? items.filter(i => i.fromId !== fromId) : [];
    if (rest.length === items.length) return;
    this.laterList.set(u.id, rest);
    this.sendLater(u.id);
  }
  private laterTick(now: number) {
    for (const u of this.users.values()) {
      if (u.bot) continue;
      const online = u.presence !== 'offline' && !!this.sockets.get(u.id)?.size;
      const items = this.laterList.get(u.id);
      if (u.callId && items?.some(i => this.users.get(i.fromId)?.callId === u.callId)) { // talking with them now, however it came about
        this.laterList.set(u.id, items.filter(i => this.users.get(i.fromId)?.callId !== u.callId)); this.sendLater(u.id);
      }
      const why = online ? this.laterWhy(u) : null, was = this.busy.get(u.id);
      if (why && !was) this.busy.set(u.id, { since: now, why });
      else if (!why && was) {
        this.busy.delete(u.id);
        const news = (this.laterList.get(u.id) ?? []).filter(i => i.at >= was.since);
        if (online && news.length) {
          const first = this.users.get(news[0].fromId)?.name ?? 'Someone';
          this.sendTo(u.id, { t: 'later_nudge', userId: news.length === 1 ? news[0].fromId : undefined,
            text: `While you were ${was.why}: ${news.length === 1 ? `${first} knocked` : `${first} and ${news.length - 1} other${news.length > 2 ? 's' : ''} knocked`}` });
        }
      } else if (why && was) was.why = why;
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

  private closeKnock(k: Knock & { timer?: NodeJS.Timeout }, reply: 'accept' | 'later' | 'blocked', reason?: string, cancelled?: boolean, kept?: boolean) {
    if (k.timer) clearTimeout(k.timer);
    const wasPending = k.state === 'pending';
    k.state = reply;
    const to = this.users.get(k.toId);
    if (to && wasPending && to.emote === 'knock') this.setEmote(to, null);
    const base = { t: 'knock_reply', knockId: k.id, fromId: k.fromId, toId: k.toId, reply, reason, cancelled, kept } as const;
    if (reply === 'accept' && to) {
      // join (or start) the call; whoever they knocked, everyone in it shares the same Meet link
      const from = this.users.get(k.fromId);
      const call = from ? this.connectCall(from, to) : null;
      if (from) { this.clearLater(to, from.id); this.clearLater(from, to.id); }
      // the link goes only to the two people involved; everyone else just learns the knock is over
      const pair = new Set([k.fromId, k.toId]);
      for (const id of pair) this.sendTo(id, { ...base, link: call?.link });
      for (const [id] of this.sockets) if (!pair.has(id)) this.sendTo(id, base);
    } else this.broadcast(base);
    setTimeout(() => this.knocks.delete(k.id), 60_000);
  }

  // ---------- client messages ----------
  handle(u: User, msg: ClientMsg, socket: string) {
    if (!this.sockets.get(u.id)?.has(socket)) return;
    if (['move', 'use', 'follow', 'instrument'].includes(msg.t)) this.cancelSeatWalk(u.id);
    if (msg.t === 'voice_claim') { this.setOwner(u.id, socket); return; }
    if (msg.t === 'ping') { // answered at once: the client times the round trip to estimate the server clock
      if (Number.isFinite(msg.id)) this.sockets.get(u.id)?.get(socket)?.({ t: 'pong', id: msg.id, serverTime: Date.now() });
      return;
    }
    if (typeof msg.t === 'string' && msg.t.startsWith('table_')) {
      if (this.owners.get(u.id) === socket) this.table.handle(u, msg);
      return;
    }
    if (typeof msg.t === 'string' && msg.t.startsWith('retro_')) {
      if (this.owners.get(u.id) === socket) this.retro.handle(u, msg);
      return;
    }
    if (typeof msg.t === 'string' && (msg.t.startsWith('game_') || msg.t === 'crew_name')) {
      if (this.owners.get(u.id) === socket) this.arcade.handle(u, msg);
      return;
    }
    if (['rtc', 'speaking', 'mute', 'deafen', 'hand'].includes(msg.t) && this.owners.get(u.id) !== socket) return;
    switch (msg.t) {
      case 'listening': this.setLofiListening(u, socket, msg.on === true); break;
      case 'instrument': this.instrument(u, msg, socket); break;
      case 'note': this.note(u, msg, socket); break;
      case 'move': {
        if (!msg.to || typeof msg.to !== 'object') break; // checked before anything changes
        const to = { x: msg.to.x | 0, y: msg.to.y | 0 };
        u.afk = false;
        for (const k of this.knocks.values()) if (k.fromId === u.id && k.state === 'walking') this.closeKnock(k, 'later', 'Knock cancelled', true);
        if (u.door === 'arriving') { this.doorTimer(u, null); this.setDoor(u, null); } // off on their own way: bag's put away
        this.setFollowing(u, null);
        if (underground(u) ? !this.inDungeon(to) : u.instance && !this.inMeetingRoom(to)) break;
        if (!this.isSysadmin(u) && adminOnly(this.map, to.x, to.y)) { this.sendTo(u.id, { t: 'notice', text: `🔒 ${roomAt(this.map, to.x, to.y)?.name ?? 'That room'}: sysadmins only` }); break; }
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
      case 'gm_items': this.gmItems(u, msg); break;
      case 'teleport': this.teleport(u, String(msg.targetId)); break;
      case 'rename': this.rename(u, msg); break;
      case 'gift_hat': this.giftHat(u, msg); break;
      case 'tz': {
        const tz = isTimeZone(msg.tz) ? msg.tz : undefined;
        if (tz === u.tz || (msg.tz != null && !tz)) break;
        if (tz) u.tz = tz; else delete u.tz;
        this.broadcast({ t: 'tz', userId: u.id, tz: tz ?? null });
        break;
      }
      case 'banner': this.setBanner(u, msg.banner); break;
      case 'look': {
        if (!msg.look || typeof msg.look !== 'object') break;
        const color = (v: unknown, fallback: string) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
        const int = (v: unknown, max: number) => Math.max(0, Math.min(max, Number.isInteger(v) ? Number(v) : 0));
        u.look = {
          skin: color(msg.look.skin, u.look.skin), hair: color(msg.look.hair, u.look.hair),
          shirt: color(msg.look.shirt, u.look.shirt), pants: color(msg.look.pants, u.look.pants),
          eyes: color(msg.look.eyes, u.look.eyes), shoes: color(msg.look.shoes, u.look.shoes),
          glassesColor: color(msg.look.glassesColor, u.look.glassesColor), hatColor: color(msg.look.hatColor, u.look.hatColor),
          style: int(msg.look.style, 4), top: int(msg.look.top, 2), bottom: int(msg.look.bottom, 2),
          glasses: int(msg.look.glasses, 2), hat: int(msg.look.hat, 2),
          beard: int(msg.look.beard, 1), mustache: int(msg.look.mustache, 1),
        };
        u.lookSet = true;
        const name = typeof msg.name === 'string' ? msg.name.replace(/\s+/g, ' ').trim().slice(0, 24) : '';
        if (name && name !== u.name) {
          const other = this.findByName(name);
          if (other && other !== u) this.sendTo(u.id, { t: 'notice', text: `The name "${name}" is taken, so you keep ${u.name}` });
          else { u.name = name; u.nameSet = true; }
        }
        this.broadcast({ t: 'look', userId: u.id, look: u.look, lookSet: true, name: u.name });
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
      case 'room_create': this.roomCreate(u, msg.title, msg.invite); break;
      case 'room_invite': this.roomInvite(u, msg.userIds); break;
      case 'room_mode': this.setRoomMode(u, String(msg.roomId), msg.mode); break;
      case 'room_voice': this.roomVoice(u, !!msg.on); break;
      case 'room_meet': this.roomMeet(u); break;
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
        if (!(u.callId && !knockCall(this.calls.get(u.callId))) && msg.presence !== 'in_call') this.leaveCall(u); // switching away from "in a call" hangs up
        this.setPresence(u, msg.presence);
        break;
      }
      case 'leave_room': if (u.instance) { if (this.calls.get(u.callId ?? '')?.instance || this.waiting.has(u.id)) this.roomVoice(u, false); break; } if ((u.callId && this.calls.get(u.callId)?.room) || this.waiting.has(u.id)) this.leaveRoom(u); break; // a stale AFK/Leave mustn't walk anyone else home
      case 'end_call': if (u.instance && this.calls.get(u.callId ?? '')?.instance) this.roomVoice(u, false); else if (u.callId && this.calls.get(u.callId)?.room) this.leaveRoom(u); else { const c = u.callId ? this.calls.get(u.callId) : undefined; if (c && knockCall(c)) this.endKnockCall(u, c); else this.leaveCall(u); } break;
      case 'deafen': if (u.callId) { u.deafened = !!msg.on; this.broadcast({ t: 'deafen', userId: u.id, on: u.deafened }); } break;
      case 'hand': if (u.callId && this.calls.get(u.callId)?.room) { u.hand = !!msg.up; this.broadcast({ t: 'hand', userId: u.id, up: u.hand }); } break;
      case 'to_meet': {
        const call = u.callId ? this.calls.get(u.callId) : undefined;
        if (call && knockCall(call) && !call.fallback) for (const id of call.members) if (id !== u.id) this.sendTo(id, { t: 'to_meet', fromId: u.id });
        break;
      }
      // voice: relay WebRTC signaling only between members of the same call
      case 'rtc': {
        const to = this.users.get(String(msg.to));
        if (!rtcSignal(msg.signal)) break; // relayed as is, so at least its shape and size
        if (u.callId && to?.callId === u.callId && to.id !== u.id && !u.bot && !to.bot && !goingOut(u) && !goingOut(to) && u.presence !== 'offline' && to.presence !== 'offline') {
          const owner = this.owners.get(to.id);
          if (owner) this.sockets.get(to.id)?.get(owner)?.({ t: 'rtc', from: u.id, signal: msg.signal });
        }
        break;
      }
      case 'speaking': if (u.callId) this.broadcast({ t: 'speaking', userId: u.id, on: !!msg.on }); break;
      case 'mute': if (u.callId) { u.muted = !!msg.muted; this.broadcast({ t: 'mute', userId: u.id, muted: u.muted }); } break;
      case 'knock': { const to = this.users.get(msg.targetId); if (to) this.knock(u, to); break; }
      case 'later_dismiss': { const id = String(msg.id); const i = this.laterList.get(u.id)?.find(x => x.id === id); if (i) this.clearLater(u, i.fromId); break; }
      case 'later_clear': this.clearLater(u); break;
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
      case 'ticket_new': this.ticketNew(u, msg); break;
      case 'ticket_reply': this.ticketReply(u, Number(msg.id), msg.text); break;
      case 'ticket_status': this.ticketStatus(u, Number(msg.id), msg.status); break;
      case 'ticket_seen': this.ticketSeen(u, Number(msg.id)); break;
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
      case 'cup_take': this.takeCup(u, String(msg.cupId)); break;
      case 'give': { const to = this.users.get(String(msg.targetId)); if (to) this.give(u, to); break; }
      case 'bite': this.bite(u, String(msg.targetId)); break;
      case 'present_slide': this.present?.slide(u.id, msg.slide); break;
      case 'present_share': if (!u.bot) try { this.present?.share(u.id, msg.objectId); } catch (e) { if (e instanceof PresentError) this.sendTo(u.id, { t: 'notice', text: e.message }); else throw e; } break;
      case 'present_frame': this.present?.frame(u.id, msg.seq, msg.data); break;
      case 'present_stop': this.present?.stop(u.id); break;
    }
  }

  /** An admin changes the real room rules, then reconciles voice for everyone already on the floor. */
  private setRoomMode(by: User, roomId: string, mode: unknown) {
    if (!this.isAdmin(by)) return this.sendTo(by.id, { t: 'notice', text: 'Only admins can change room modes' });
    const room = this.map.rooms.find(r => r.id === roomId);
    if (!room || !isRoomMode(mode)) return this.sendTo(by.id, { t: 'notice', text: 'Unknown room or room mode' });
    if (roomMode(room) === mode) return;
    this.roomModes[room.id] = mode;
    room.rules = rulesForMode(this.baseRoomRules[room.id], mode);
    this.broadcast({ t: 'room_modes', modes: { ...this.roomModes }, by: by.id });
    if (mode === 'quiet' || mode === 'later') for (const k of this.knocks.values()) {
      if (k.state !== 'walking' && k.state !== 'pending') continue;
      const from = this.users.get(k.fromId), to = this.users.get(k.toId);
      if (!to || to.instance || this.roomOf(to)?.id !== room.id) continue;
      if (mode === 'later' && from) this.keepLater(k, from, to, this.laterWhy(to) ?? 'busy', `${room.name}: knocks wait for later`);
      else this.closeKnock(k, 'blocked', `${room.name}: no knocking`);
    }
    // Clear waiting first: leaving a full hall must not re-admit its queue after voice is disabled.
    if (mode !== 'voice') for (const [id, waitingRoom] of this.waiting) {
      const u = this.users.get(id); if (waitingRoom === room.id && u && !u.instance) this.setWaiting(u, null);
    }
    this.voiceTick();
  }

  // ---------- persistence ----------
  dump() {
    return {
      version: STATE_VERSION,
      roomModes: { ...this.roomModes },
      users: [...this.users.values()].map(u => {
        return { id: u.id, name: u.name, nameSet: u.nameSet, email: u.email, meetLink: u.meetLink, google: u.google, vacation: u.vacation, homeDesk: u.homeDesk, look: u.look, banner: u.banner, lookSet: u.lookSet, tile: underground(u) ? this.dungeonExit(false) : u.tile, dir: u.dir, status: u.status, presence: u.presence, bot: u.bot, plant: u.plant, bloomed: u.bloomed, achievements: u.achievements, effects: u.effects.filter(e => e.until === undefined), items: u.items, danced: u.danced,
          resume: (!u.bot && u.presence !== 'offline' && !goingOut(u) && !u.instance && !this.toilets.inside(u.id)) || undefined }; // meetings and stalls don't survive a restart
      }),
      objects: Object.fromEntries(this.objectOn),
      jukebox: Object.fromEntries([...this.jukeboxes].map(([id, j]) => [id, j.dump()])),
      arcade: this.arcade.dump(),
      retro: this.retro.dump(),
      layout: this.layoutEdited ? this.layout() : undefined,
      chats: Object.fromEntries(this.chats),
      cups: this.creatures.cups,
      library: this.library.dump(),
      tickets: this.tickets.dump(),
    };
  }
  load(data: ReturnType<World['dump']>) {
    // files from before versioning have none (0); new migrations should key on this, not on the content
    const version = data.version ?? 0;
    this.roomModes = {};
    for (const room of this.map.rooms) {
      const mode = data.roomModes?.[room.id];
      if (isRoomMode(mode)) this.roomModes[room.id] = mode;
      room.rules = rulesForMode(this.baseRoomRules[room.id], this.roomModes[room.id]);
    }
    if (version > STATE_VERSION) console.warn(`state.json is version ${version}, newer than this build (${STATE_VERSION}); unknown fields are dropped on the next save`);
    // saved in the radio days: the radio goes (withNewFixtures then brings in the jukebox)
    // ... and the Meeting room's whiteboard: the screen is its one board now (withNewFixtures then reshapes the screen into its spot)
    if (data.layout) data.layout = { ...data.layout, objects: data.layout.objects.filter(o => o.type !== 'radio' && o.type !== 'whiteboard') };
    // The Music TV replaces the right window, keeping all other saved furniture in place.
    if (version < 2 && data.layout) {
      const objects = data.layout.objects.filter(o => !(o.type === 'window' && o.x === 60 && o.y === 1));
      const ivySpace = !objects.some(o => o.x <= 63 && o.x + o.w > 63 && o.y <= 2 && o.y + o.h > 2);
      data.layout = { ...data.layout, objects: objects.flatMap(o =>
        o.type === 'wall_ivy' && o.x === 62 && o.y === 2 ? ivySpace ? [{ ...o, x: 63 }] : [] : [o]) };
    }
    if (data.layout) { // an admin rearranged the office; if it no longer fits the generated floor, start over from that
      const covers = (o: { x: number; y: number; w: number; h: number }) => this.map.dungeon &&
        [this.map.dungeon.hole, this.map.dungeon.hatch].some(t => inRect(o, t.x, t.y));
      const objects = data.layout.objects.filter(o => {
        if (!covers(o)) return true;
        console.warn(`saved ${objectName(o.type)} dropped: covers the hole or hatch`); return false;
      });
      const rugs = data.layout.rugs.filter(r => {
        if (!covers(r)) return true;
        console.warn(`saved ${r.color} rug dropped: covers the hole or hatch`); return false;
      });
      let migrated = migrateBookClub(migrateLibrary(migrateEastWing({ objects, rugs }, this.baseLayout), this.baseLayout, this.map), this.baseLayout, this.map);
      if (version < 3) migrated = migrateBeach(migrated, this.baseLayout, this.map);
      if (version < 4) migrated = resetBeach(migrated, this.baseLayout, this.map);
      if (version < 5) migrated = resetBeach(migrated, this.baseLayout, this.map);
      const merged = this.withNewFixtures(migrated);
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
    const now = Date.now();
    for (const d of data.users ?? []) {
      const tile = this.inDungeon(d.tile) ? this.dungeonExit(false) : isWalkable(this.map, d.tile.x, d.tile.y) || seatAt(this.map, d.tile.x, d.tile.y) ? d.tile : { ...this.map.spawn };
      const legacy = lookFor(d.name);
      const look = { ...legacy, ...d.look, eyes: d.look?.eyes ?? legacy.eyes, shoes: d.look?.shoes ?? legacy.shoes, top: d.look?.top ?? 0, bottom: d.look?.bottom ?? 0, glasses: d.look?.glasses ?? 0, hat: d.look?.hat ?? 0, beard: d.look?.beard ?? 0, mustache: d.look?.mustache ?? 0, glassesColor: d.look?.glassesColor ?? legacy.glassesColor, hatColor: d.look?.hatColor ?? legacy.hatColor };
      this.users.set(d.id, { ...d, vacation: d.vacation && d.vacation.until > now ? d.vacation : null, look, lookSet: d.lookSet ?? false, homeDesk: d.homeDesk ?? null, plant: d.plant ?? null, bloomed: d.bloomed ?? [], achievements: d.achievements ?? {}, items: Array.isArray(d.items) ? d.items.filter((i: unknown): i is string => typeof i === 'string') : [], effects: (d.effects ?? []).filter(e => Object.prototype.hasOwnProperty.call(EFFECTS, e.kind) && e.until === undefined), tile, move: null, path: null, emote: null, door: null, callId: null, deafened: false, hand: false, muted: false, following: null, holding: null, meeting: null, reading: null, listening: null, instance: null, game: null, table: null, presence: d.bot ? d.presence : 'offline' });
      // back within WALK_HOME_AFTER_MS of the restart (a reconnect takes seconds): their spot, not their desk
      const u = this.users.get(d.id)!;
      if (d.resume && !d.bot && tile === d.tile) { u.lastSpot = { ...tile }; u.offlineAt = now; u.resume = true; } else u.resume = undefined;
    }
    for (const u of this.users.values()) if (u.vacation) { u.presence = 'offline'; u.resume = undefined; this.beach.boot(u); }
    for (const [id, on] of Object.entries(data.objects ?? {})) if (this.objectOn.has(id)) this.objectOn.set(id, !!on);
    this.arcade.load(data.arcade);
    this.retro.load(data.retro);
    for (const [id, saved] of Object.entries(data.jukebox ?? {})) {
      const o = this.map.objects.find(o => o.id === id);
      if (this.jukeboxes.has(id) && o?.use?.kind === 'jukebox') this.jukeboxes.set(id, Jukebox.load(tracksFor(o.use.genres), saved, now));
    }
    for (const [key, msgs] of Object.entries(data.chats ?? {})) this.chats.set(key, msgs);
    this.creatures.cups = (data.cups ?? []).filter(c => this.creatures.tableAt(c.tile));
    this.library.load(data.library);
    this.tickets.load(data.tickets);
  }
}
