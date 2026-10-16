// WebSocket client + the client-side mirror of server state.
import mapJson from '../../shared/tilemap.json';
import { applyLayout, besideObject, doorwayTiles, isWalkable, objectById, pathTo, roomAt, sampleMove, type Dir, type Tile, type TileMap } from '../../shared/map';
import { FOOD_ITEMS } from '../../shared/lunch';
import { ACHIEVEMENTS, underground, DUNGEON_INSTANCE, PLANT_STAGES, plantName, ROOM_VOICE_MAX, type JukeboxState, type JukeboxAction, type AgendaItem, type LayoutEdit, type CalEvent, type MeetingRoomInfo, type ChatMsg, type LiveDeck, presentScope, type ObjectState, type ToiletState, type ClientMsg, type PublicUser, type Reaction, type RtcSignal, type ServerMsg, type Creature, type Cup, CUP_ITEMS, type LibraryState } from '../../shared/protocol';
import { ParkLoop } from './park/loop';
import type { CabinetSummary, ParkRecords } from '../../shared/protocol';
import { playPark, playHand, playKnock, playPop, playDungeon, playPet } from './sounds';
import type { Soundscape } from './soundscape';
import { bestOffset, clockSample, CLOCK_SAMPLES, type ClockSample } from './clockSync';

export const MAP = mapJson as unknown as TileMap;

export interface ClientUser extends PublicUser {
  path: Tile[] | null;
  prev: { path: Tile[]; startedAt: number; ms?: number } | null; // walk in progress when a new move was issued
  faceOverride: Dir | null;
  speaking?: boolean; // live mic activity in a voice call (client-only)
}

export interface Toast {
  // knock_out: my knock is waiting (Cancel); knock_again: it didn't land, or I missed one (Knock again / back)
  id: number; kind: 'knock_in' | 'knock_out' | 'knock_again' | 'chat' | 'info' | 'link' | 'meeting' | 'call_moved';
  text: string; link?: string; knockId?: string; expires?: number; hint?: string;
  roomId?: string;
  actions?: { label: string; run: () => void; ghost?: boolean }[]; // extra buttons (the one-time mute prompt)
  meetingKey?: string; // meeting: one-click Go into its room
  userId?: string; // the other person, for knock_again and chat
}

/** A reaction in flight, timed with performance.now() like the render loop. */
export interface Flying { fromId: string; toId: string; emoji: string; at: number }

/** Item id -> what it looks like, from whatever the map's objects hand out. */
export const ITEMS = new Map(MAP.objects.flatMap(o => (o.use?.kind === 'take' ? o.use.items : [])).map(i => [i.id, i]));

/** An admin's portal trip: a portal opens at `from`, they step in, one opens at `to`, they step out (timeline in engine.ts). `at` is performance.now(). */
export const PORTAL_MS = 2200; // the whole trip, see engine.ts
export interface PortalFx { userId: string; from: Tile; to: Tile; at: number }
export interface DungeonFx { kind: 'fall' | 'land' | 'climb'; user: ClientUser; tile: Tile; at: number }

export interface Pose { x: number; y: number; dir: Dir; walking: boolean; tile: Tile }

type Listener = () => void;
const SCENE_ONLY = new Set<ServerMsg['t']>(['move', 'speaking', 'emote', 'react', 'creatures', 'creature', 'cups']);

export class Store {
  users = new Map<string, ClientUser>();
  me = '';
  offset = 0; // serverTime - localTime
  private clockSync = { samples: [] as ClockSample[], pings: new Map<number, { at: number; perf: number }>(), id: 0, timers: [] as number[], synced: false };
  toasts: Toast[] = [];
  connected = false;
  voiceOwner = false;
  voiceWait: string | null = null;
  soundscape?: Soundscape;
  meetLink: string | null = null; // null = not loaded yet, '' = not set
  email: string | null = null;    // my sign-in (NetBird) email; Meet links open as this Google account
  google: string | null | undefined; // my connected Google account; null = not connected, undefined = no Google here
  googleAuthUrl: string | null = null; // ready before the click, so the sign-in opens straight from it (no popup blocker)
  calendarAccess = false;               // Google Calendar access granted
  calendarAuthUrl: string | null = null; // same, but also asking for Calendar
  calendarOpen = false;
  calendarEvents: CalEvent[] | null = null; // null = loading
  calendarError: string | null = null;
  agenda: AgendaItem[] = [];               // my calendar meetings now and soon
  meetingRooms: MeetingRoomInfo[] = [];    // meeting rooms in use (the board)
  meetingsOpen = false;
  private headsUp = new Set<string>();     // meetings I've had a heads-up for
  build: string | undefined;  // the server's client build when this page loaded
  staleBuild = false;         // server now serves a newer build; reload when not in a call
  objects: Record<string, ObjectState> = {};
  toilets: Record<string, ToiletState> = {}; // Berghain's stalls
  jukebox: Record<string, JukeboxState> = {};
  instruments: Record<string, string | null> = {};
  seat: string | null = null;
  lastNote: Record<string, number> = {};
  jukeboxOpen: string | null = null;
  private jukeboxReady = false;
  park: ParkLoop | null = null;
  gameOpen = false;
  cabinets: CabinetSummary[] = [];
  arcadeRecords: ParkRecords = {};
  recordsOpen = false;
  gameCheers = new Map<string, { kind: 0 | 1 | 2; at: number }>();
  chats = new Map<string, ChatMsg[]>(); // by the other person's id
  unread = new Map<string, number>();
  chatWith: string | null = null;       // open conversation
  reactions: Flying[] = [];             // the engine draws and prunes these
  bells: Record<string, { userId: string; at: number }> = {}; // the last ring of each bell (the engine bounces it and shows a ding)
  objectFx: { objectId: string; at: number }[] = []; // someone just used it (coffee steam)
  dungeon: { key: Tile | null; hasKey: boolean; seen: Set<number> } | null = null;
  dungeonOpening = false;
  dungeonFx: DungeonFx[] = [];
  creatures = new Map<string, Creature>(); // the office animals and the cleaner (never people)
  cups: Cup[] = [];                        // left on tables
  version = 0;    // bumps on any change, including scene-only ones (the engine reads the store every frame)
  uiVersion = 0;  // bumps only when React chrome has something new to show
  admin = false;      // may rearrange the office (and is a GM: may put effects on anyone)
  sysadmin = false;   // may also walk into the Admin room
  portalFx: PortalFx[] = [];
  items: string[] = []; // my inventory (what the bouncer sold me)
  layoutVersion = 0;  // bumps whenever the furniture changes; the engine redraws the floor
  added: string | null = null; // the thing I just added, to select it
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private toastSeq = 0;
  private closed = false;

  constructor(private session: string, private onUnauthorized: () => void) {}

  now() { return Date.now() + this.offset; }
  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.uiVersion;
  private emit() { this.version++; this.uiVersion++; for (const l of this.listeners) l(); }
  /** Re-render after state that lives outside the store changed (e.g. voice). */
  changed() { this.emit(); }
  onRtc?: (from: string, signal: RtcSignal) => void;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(this.session)}`);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.emit(); };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      this.stopClock(); this.clearInstruments(); this.park?.runner.setLocalBits(0); this.cabinets = []; this.connected = false; this.voiceOwner = false; this.jukebox = {}; this.jukeboxReady = false; this.soundscape?.resetCrossings(); this.emit();
      if (e.code === 4001) return this.onUnauthorized();
      if (!this.closed) setTimeout(() => this.connect(), 1500);
    };
  }
  close() { this.closed = true; this.stopClock(); this.clearInstruments(); this.park?.runner.setLocalBits(0); this.cabinets = []; this.connected = false; this.voiceOwner = false; this.jukebox = {}; this.jukeboxReady = false; this.soundscape?.resetCrossings(); this.emit(); this.ws?.close(); }
  send(msg: ClientMsg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
  /** NTP-style clock sync (clockSync.ts): a burst of pings on connect, then one every 20 s to follow drift. Everything timed by
   *  the server (walks, notes, the jukebox) runs on now(), so listeners on slow links hear the jukebox where others do. */
  private syncClock() {
    this.stopClock(); this.clockSync.samples = []; this.clockSync.synced = false;
    const ping = () => {
      const id = ++this.clockSync.id, at = Date.now();
      for (const [old, p] of this.clockSync.pings) if (at - p.at > 10_000) this.clockSync.pings.delete(old);
      this.clockSync.pings.set(id, { at, perf: performance.now() }); this.send({ t: 'ping', id });
    };
    for (const ms of [0, 150, 300, 450, 600]) this.clockSync.timers.push(window.setTimeout(ping, ms));
    this.clockSync.timers.push(window.setInterval(ping, 20_000));
  }
  private stopClock() { for (const t of this.clockSync.timers) { clearTimeout(t); clearInterval(t); } this.clockSync.timers = []; this.clockSync.pings.clear(); }

  private clearInstruments() {
    for (const id of Object.keys(this.instruments)) this.soundscape?.allOff(id);
    this.instruments = {}; this.seat = null; this.lastNote = {};
  }
  private setInstruments(next: Record<string, string | null>) {
    for (const [id, player] of Object.entries(this.instruments)) if (player && next[id] !== player) this.soundscape?.allOff(id, player);
    this.instruments = next;
  }
  playInstrument(id: string) { if (this.seat !== id) this.send({ t: 'instrument', objectId: id, action: 'play' }); }
  leaveInstrument() { if (this.seat) this.send({ t: 'instrument', objectId: this.seat, action: 'leave' }); }
  sendNote(note: number, on: boolean, vel = 0, preset = 0) {
    if (!this.seat) return;
    const at = this.now();
    this.soundscape?.playNote(this.seat, this.me, note, on, vel, preset, at);
    this.send({ t: 'note', objectId: this.seat, note, on, vel, preset, at });
  }
  // ---------- actions ----------
  openRecords(open = true) { this.recordsOpen = open; this.emit(); }
  gamePlay() { const s = this.park?.runner.session; if (s) this.send({ t: 'game_play', epoch: s.epoch }); }
  gameLeave() {
    this.send({ t: 'game_leave' }); this.park?.receive({ t: 'game_session', session: null });
    this.gameOpen = false; this.gameCheers.clear(); this.emit();
  }
  gameMenu(op: 'lobby' | 'restart') {
    const s = this.park?.runner.session; if (s) this.send({ t: 'game_menu', epoch: s.epoch, op });
  }
  gameCheer(kind: 0 | 1 | 2) { if (this.gameOpen && this.connected) this.send({ t: 'game_cheer', kind }); }
  gameDescription(cabinet: string, userId?: string) {
    const s = this.cabinets.find(s => s.cabinet === cabinet);
    if (userId && this.users.get(userId)?.game?.role === 'spectator') return 'Watching Deck Park';
    if (!s) return 'Deck Park · click to play';
    if (s.phase === 'lobby') return 'In the Deck Park lobby';
    const peers = s.players.filter(id => id !== userId).map(id => this.users.get(id)).filter((u): u is ClientUser => !!u);
    return `Playing Deck Park · level ${s.level}${peers.length ? ` with ${this.names(peers)}` : ''}`;
  }
  moveTo(to: Tile) { this.send({ t: 'move', to }); }
  joinRoom(roomId: string) {
    const me = this.users.get(this.me), room = MAP.rooms.find(r => r.id === roomId);
    if (!me || me.instance || !room) return;
    const pose = this.pose(me), doors = doorwayTiles(MAP, room);
    const distance = (t: Tile, p: Tile) => Math.abs(t.x - p.x) + Math.abs(t.y - p.y);
    const door = doors.slice().sort((a, b) => Math.min(...a.map(t => distance(t, pose))) - Math.min(...b.map(t => distance(t, pose))))[0];
    if (!door) return;
    const occupied = new Set([...this.users.values()].filter(u => u.id !== me.id && u.presence !== 'offline' && u.instance === me.instance)
      .map(u => { const t = u.move?.to ?? u.tile; return `${t.x},${t.y}`; }));
    const tiles: Tile[] = [], { x, y, w, h } = room.rect;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++)
      if (isWalkable(MAP, xx, yy) && !occupied.has(`${xx},${yy}`)) tiles.push({ x: xx, y: yy });
    tiles.sort((a, b) => Math.min(...door.map(t => distance(a, t))) - Math.min(...door.map(t => distance(b, t))) || distance(a, pose) - distance(b, pose));
    const tile = tiles.find(t => pathTo(MAP, pose.tile, t).length);
    if (tile) this.moveTo(tile);
  }
  knock(targetId: string) { this.send({ t: 'knock', targetId }); }
  /** Knock, but first walk the user through setting up their Meet room if they have none. */
  pendingKnock: string | null = null;
  meetSetupSkipped = false; // "knock without a room" — don't nag again this session
  requestKnock(targetId: string) {
    this.knock(targetId);
  }
  finishKnockSetup(action: 'saved' | 'skip' | 'cancel') {
    const id = this.pendingKnock; this.pendingKnock = null;
    if (action === 'skip') this.meetSetupSkipped = true;
    if (id && action !== 'cancel') this.knock(id); // after meet_link on the same socket, so the server has it
    this.emit();
  }
  cancelKnock(knockId: string) {
    this.send({ t: 'knock_cancel', knockId });
    this.toasts = this.toasts.filter(t => t.knockId !== knockId); this.emit();
  }
  follow(targetId: string | null) { this.send({ t: 'follow', targetId }); }
  react(targetId: string, emoji: Reaction) { this.send({ t: 'react', targetId, emoji }); }
  ring(objectId: string) { this.send({ t: 'ring', objectId }); }
  use(objectId: string, item?: string) { this.send({ t: 'use', objectId, item }); }
  rackLine(objectId: string) { this.send({ t: 'toilet_shelf', objectId }); }
  get dancing() { return !!this.users.get(this.me)?.effects?.some(e => e.kind === 'dance'); }
  /** Dance in Berghain: on the dance floor object, walk onto a free tile of it first. Dancing already: stop. */
  dance(floorId?: string) {
    const me = this.users.get(this.me);
    if (!me) return;
    if (this.dancing) return this.setEffect(this.me, 'dance', false);
    const o = floorId ? MAP.objects.find(o => o.id === floorId && o.use?.kind === 'dance') : undefined;
    if (o) {
      const taken = new Set([...this.users.values()].filter(u => u.id !== this.me && u.presence !== 'offline' && !u.instance).map(u => `${u.tile.x},${u.tile.y}`));
      const tiles: Tile[] = [];
      for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) if (!taken.has(`${x},${y}`)) tiles.push({ x, y });
      const mine = tiles.find(t => t.x === me.tile.x && t.y === me.tile.y);
      const dist = (t: Tile) => Math.abs(t.x - me.tile.x) + Math.abs(t.y - me.tile.y);
      const to = mine ?? tiles.sort((a, b) => dist(a) - dist(b))[0];
      if (!to) return this.toast({ kind: 'info', text: 'The dance floor is packed 🕺', expires: 3000 });
      if (!mine) this.moveTo(to);
    }
    this.setEffect(this.me, 'dance', true);
  }
  sniffLine(objectId: string) { this.send({ t: 'toilet_sniff', objectId }); }
  drop() { this.send({ t: 'drop' }); }
  putCup(tile: Tile) { this.send({ t: 'cup_put', tile }); }
  takeCup(cupId: string) { this.send({ t: 'cup_take', cupId }); }
  pet(creatureId: string) { this.send({ t: 'pet', creatureId }); }
  devBat() { this.send({ t: 'dev_bat' }); }
  lunch(tile: Tile, open: boolean) { this.send({ t: 'lunch', tile, open }); }
  lunchOpen(open: boolean) { this.send({ t: 'lunch_open', open }); }
  give(targetId: string) { this.send({ t: 'give', targetId }); }
  openChat(withId: string) {
    this.chatWith = withId; this.unread.delete(withId);
    this.toasts = this.toasts.filter(t => !(t.kind === 'chat' && t.userId === withId));
    this.send({ t: 'chat_history', withId });
    this.emit();
  }
  closeChat() { this.chatWith = null; this.emit(); }
  sendChat(toId: string, text: string) { if (text.trim()) this.send({ t: 'chat', toId, text }); }
  replyKnock(knockId: string, reply: 'accept' | 'later') {
    this.send({ t: 'knock_reply', knockId, reply });
    this.dismiss(this.toasts.find(t => t.knockId === knockId)?.id ?? -1);
  }
  edit(edit: LayoutEdit) { this.send({ t: 'edit', edit }); }
  resetLayout() { this.send({ t: 'edit_reset' }); }
  /** My time zone, shown to colleagues in the hover card; on unless switched off (kept on this device only). */
  get shareTz() { try { return localStorage.getItem('deck.shareTz') !== 'off'; } catch { return true; } }
  setShareTz(on: boolean) { try { localStorage.setItem('deck.shareTz', on ? 'on' : 'off'); } catch { /* storage unavailable */ } this.sendTz(); this.emit(); }
  /** The zone the browser reports, and the one picked by hand instead (null = follow the browser). */
  detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  get pickedTz(): string | null { try { return localStorage.getItem('deck.tz'); } catch { return null; } }
  setPickedTz(tz: string | null) { try { if (tz) localStorage.setItem('deck.tz', tz); else localStorage.removeItem('deck.tz'); } catch { /* storage unavailable */ } this.sendTz(); this.emit(); }
  private sendTz() { this.send({ t: 'tz', tz: this.shareTz ? this.pickedTz ?? this.detectedTz : null }); }
  setStatus(status: string) { this.send({ t: 'status', status }); }
  setLook(look: PublicUser['look'], name?: string) { this.send({ t: 'look', look, name }); }
  /** Put an effect on someone (yourself, or anyone if you're a GM), or take it off. */
  gmItems = new Map<string, string[]>(); // GM only: pockets of the people I looked at
  requestGmItems(targetId: string) { this.send({ t: 'gm_items', targetId }); }
  teleport(targetId: string) { this.send({ t: 'teleport', targetId }); }
  rename(targetId: string, name: string) { this.send({ t: 'rename', targetId, name }); }
  giftHat(targetId: string, style: string) { this.send({ t: 'gift_hat', targetId, style }); }
  setEffect(targetId: string, kind: string, on: boolean, style?: string) { this.send({ t: 'effect', targetId, kind, on, style }); }
  setPresence(presence: 'online' | 'away' | 'in_call') { this.send({ t: 'presence', presence }); }
  setMeetLink(link: string) { this.send({ t: 'meet_link', link }); }
  /** The Google account Meet links should open as. */
  get meetAccount() { return this.email ?? this.google ?? null; }
  prepareGoogle() { this.googleAuthUrl = null; if (this.google === null) this.send({ t: 'google_connect' }); }
  disconnectGoogle() { this.send({ t: 'google_disconnect' }); }
  /** A wall calendar was clicked: show my week, or how to connect Calendar. */
  openCalendar() {
    this.calendarOpen = true;
    if (this.calendarAccess) this.loadCalendar();
    else this.prepareCalendarAuth();
    this.emit();
  }
  closeCalendar() { this.calendarOpen = false; this.emit(); }
  openMeetings() { this.meetingsOpen = true; this.emit(); }
  openJukebox(id: string) { this.jukeboxOpen = id; this.emit(); }
  closeJukebox() { this.jukeboxOpen = null; this.emit(); }
  jukeboxAction(id: string, action: JukeboxAction) {
    if (this.connected && this.jukebox[id]) this.send({ t: 'jukebox', objectId: id, ...action });
  }
  jukeboxRoom(id: string) {
    const o = MAP.objects.find(o => o.id === id && o.use?.kind === 'jukebox');
    return o ? roomAt(MAP, o.x, o.y) : undefined;
  }
  inJukeboxRoom(id: string) {
    const me = this.users.get(this.me), room = this.jukeboxRoom(id);
    return !!me && !me.instance && !!room && this.roomOf(me)?.id === room.id;
  }
  walkToJukebox(id: string) {
    const o = MAP.objects.find(o => o.id === id && o.use?.kind === 'jukebox'), me = this.users.get(this.me);
    if (!o || !me || me.instance || !this.connected) return;
    const pose = this.pose(me), taken = new Set([...this.users.values()]
      .filter(u => u.id !== me.id && u.presence !== 'offline' && !u.instance)
      .flatMap(u => [u.tile, this.pose(u).tile].map(t => `${t.x},${t.y}`)));
    const tiles = besideObject(MAP, o).filter(t => !taken.has(`${t.x},${t.y}`));
    tiles.sort((a, b) => Math.hypot(a.x - pose.x, a.y - pose.y) - Math.hypot(b.x - pose.x, b.y - pose.y));
    const to = tiles.find(t => pathTo(MAP, pose.tile, t).length);
    if (to) this.moveTo({ x: to.x, y: to.y });
  }
  achievementsOpen = false;
  library: LibraryState = { articles: [], reads: [] };
  libraryOpen = false;
  fetching: string | null = null; // the article I picked, until I'm sitting down with it
  private fetchTimer?: ReturnType<typeof setTimeout>;
  openLibrary(open = true) { this.libraryOpen = open; this.emit(); }
  publishArticle(url: string, title: string, topic: string) { this.send({ t: 'article_add', url, title, topic }); }
  removeArticle(id: string) { this.send({ t: 'article_remove', id }); }
  readArticle(id: string) {
    this.fetching = id; this.libraryOpen = false; this.emit();
    clearTimeout(this.fetchTimer); this.fetchTimer = setTimeout(() => { this.fetching = null; this.emit(); }, 20_000);
    this.send({ t: 'read_start', articleId: id });
  }
  readDone() { this.fetching = null; this.send({ t: 'read_done' }); }
  /** Distinct people who finished this article (not its author). */
  readCount(articleId: string) {
    const by = this.library.articles.find(a => a.id === articleId)?.by;
    return new Set(this.library.reads.filter(r => r.articleId === articleId && r.userId !== by).map(r => r.userId)).size;
  }
  openAchievements(open = true) { this.achievementsOpen = open; this.emit(); }
  closeMeetings() { this.meetingsOpen = false; this.emit(); }
  goToMeeting(key: string) {
    this.send({ t: 'meeting_go', key });
    this.toasts = this.toasts.filter(t => t.meetingKey !== key); this.meetingsOpen = false; this.emit();
  }
  dungeonLeave() { this.send({ t: 'dungeon_leave' }); }
  leaveMeeting() { this.send({ t: 'meeting_leave' }); }
  /** Out of the meeting for good: not busy, knocks come through again (Go puts you back in). */
  leaveMeetingForGood(key: string) { this.send({ t: 'meeting_out', key }); this.toasts = this.toasts.filter(t => t.meetingKey !== key); this.emit(); }
  /** The calendar meeting I'm in right now while out of its room (busy: knocks go to Later). */
  get myBusyMeeting() { const now = this.now(); return this.agenda.find(a => a.start <= now && a.end > now && !a.left) ?? null; }
  /** A server timestamp as local "10:30". */
  clock(serverMs: number) { return new Date(serverMs - this.offset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  /** The calendar meeting whose room I'm in. */
  get myMeeting() { const id = this.users.get(this.me)?.instance; return id ? this.agenda.find(a => a.instance === id) ?? null : null; }
  /** A minute before a meeting (or on load, if it's already on): a heads-up with Go and the event's own link. */
  checkAgenda() {
    const now = this.now(), mine = this.users.get(this.me)?.instance;
    for (const a of this.agenda) {
      if (a.left || this.headsUp.has(a.key) || now < a.start - 60_000 || now >= a.end || a.instance === mine) continue;
      this.headsUp.add(a.key);
      const soon = a.start > now ? `starts at ${this.clock(a.start)}` : 'is on now';
      this.toast({ kind: 'meeting', meetingKey: a.key, link: a.link, text: a.adhoc ? `🔒 ${a.title}` : `📅 ${a.title} ${soon}`, hint: a.adhoc && a.from ? `${a.from.split(' ')[0]} invited you: step into the private room` : 'Go: step into its room with the others', expires: a.end - now });
      playKnock();
    }
  }
  prepareCalendarAuth() { this.calendarAuthUrl = null; if (this.google !== undefined) this.send({ t: 'google_connect', calendar: true }); }
  loadCalendar() {
    const from = new Date(); from.setHours(0, 0, 0, 0); // my local day, so "Today" starts at midnight here
    this.calendarEvents = null; this.calendarError = null;
    this.send({ t: 'calendar', from: from.toISOString() });
  }
  claimDesk() { this.send({ t: 'claim_desk' }); }
  releaseDesk() { this.send({ t: 'release_desk' }); }
  leaveRoom() { this.send({ t: 'leave_room' }); }
  setHand(up: boolean) { this.send({ t: 'hand', up }); }
  setDeafen(on: boolean) { this.send({ t: 'deafen', on }); }
  claimVoice() { this.send({ t: 'voice_claim' }); }
  /** The vault door: a panel with the link, which works from a tap anywhere (a tap on the floor can't open a tab on a phone). */
  clockOpen = false;
  openClock() { this.clockOpen = true; this.emit(); }
  closeClock() { this.clockOpen = false; this.emit(); }
  linkOpen: { label: string; url: string } | null = null;
  presentation: LiveDeck | null = null; // slides on a screen right now
  roomMeetLink: { instance: string; link: string } | null = null; // the Meet room of the meeting room I'm in (members only)
  roomOpen = false;                     // the private-room popup (start one, or invite into mine)
  openRoom(on: boolean) { this.roomOpen = on; this.emit(); }
  createRoom(invite: string[], title?: string) { this.send({ t: 'room_create', title: title?.trim() || undefined, invite }); this.roomOpen = false; this.emit(); }
  inviteToRoom(userIds: string[]) { this.send({ t: 'room_invite', userIds }); this.roomOpen = false; this.emit(); }
  roomVoice(on: boolean) { this.send({ t: 'room_voice', on }); }
  useRoomMeet() { this.send({ t: 'room_meet' }); }
  /** Is my voice on this meeting room's call? */
  get inRoomVoice() { const me = this.users.get(this.me); return !!me?.instance && me.callId === `room:${me.instance}`; }
  /** An ad-hoc private room I'm standing in (the agenda item whose instance is mine). */
  get myAdhoc() { const a = this.myMeeting; return a?.adhoc ? a : null; }
  /** Can I take this person into a private room right now? */
  roomReason(u: ClientUser) {
    const me = this.users.get(this.me);
    return u.bot || u.presence === 'offline' ? 'Not around' : me?.instance || u.instance || underground(u) || (me && underground(me)) ? 'Not from a meeting or the dungeon' : null;
  }
  presentOpen: string | null = null;    // the screen whose upload panel is open
  slidesHidden = true;                  // not watching: viewers sit down and say Watch (or use the Live chip)
  openPresent(id: string | null) { this.presentOpen = id; this.emit(); }
  presentSlide(slide: number) { if (this.presentation?.presenter === this.me) this.send({ t: 'present_slide', slide }); }
  presentStop() { this.send({ t: 'present_stop' }); }
  presentShare(objectId: string) { this.send({ t: 'present_share', objectId }); }
  presentFrame(seq: number, data: string) { this.send({ t: 'present_frame', seq, data }); }
  frame: { seq: number; url: string } | null = null; // screen share: the latest frame (a data: URL)
  hideSlides(hidden: boolean) { this.slidesHidden = hidden; this.emit(); }
  /** For REST calls made as me (uploading slides). */
  get sessionId() { return this.session; }
  /** I'm presenting, or I'm in the screen's room (not in a meeting's copy of it). */
  inPresentationRoom() {
    const l = this.presentation, me = this.users.get(this.me);
    return !!l && !!me && (l.presenter === me.id || (presentScope(me.instance) === l.scope && (!!me.instance || this.roomOf(me)?.id === l.room)));
  }
  openLink(use: { label: string; url: string }) { this.linkOpen = use; this.emit(); }
  closeLink() { this.linkOpen = null; this.emit(); }
  roomCallOf(u?: ClientUser) {
    return u?.callId?.startsWith('room:') ? MAP.rooms.find(r => r.id === u.callId!.slice(5)) : undefined;
  }
  sameRoomCall(u: ClientUser) {
    const me = this.users.get(this.me);
    return !!this.roomCallOf(me) && me?.callId === u.callId;
  }
  dungeonReason(u?: ClientUser) {
    if (u && underground(u)) return `${u.name} is somewhere underground 🕳`;
    const me = this.users.get(this.me);
    return me && underground(me) ? "You're underground — find the way out first" : null;
  }
  knockReason(u: ClientUser) {
    const me = this.users.get(this.me), room = this.roomOf(u), hall = this.roomCallOf(u), mine = this.roomCallOf(me);
    const dungeon = this.dungeonReason(u);
    if (dungeon) return dungeon;
    if (u.id === this.me) return 'This is you';
    if (u.presence === 'offline') return 'Offline';
    if (me?.callId && me.callId === u.callId) return 'Already talking';
    if (u.door === 'thinking' || u.door === 'leaving') return 'Heading out';
    if (hall || room?.rules.voice === 'open') return `In ${(hall ?? room)!.name} — just walk in`;
    if (mine) return `You're in ${mine.name} voice — step out to knock`;
    return room?.rules.knock === 'disabled' ? `${room.name}: ${room.rules.label}` : null;
  }
  endCall() { this.send({ t: 'end_call' }); }
  moveToMeet() { this.send({ t: 'to_meet' }); }
  callLink: string | null = null; // the Meet link for the call I'm in
  /** Everyone else in this person's call, in a stable order. */
  callPeers(u: ClientUser) {
    if (!u.callId) return [];
    return [...this.users.values()].filter(o => o.id !== u.id && o.callId === u.callId).sort((a, b) => a.id.localeCompare(b.id));
  }
  /** "Leo", "Leo and Maya", "Leo, Maya and 2 others" */
  names(us: ClientUser[]) {
    const n = us.map(u => u.name.split(' ')[0]);
    return n.length <= 2 ? n.join(' and ') : `${n.slice(0, 2).join(', ')} and ${n.length - 2} other${n.length > 3 ? 's' : ''}`;
  }

  toast(t: Omit<Toast, 'id'>) {
    const toast = { ...t, id: ++this.toastSeq };
    this.toasts = [...this.toasts, toast].slice(-4);
    if (t.expires) setTimeout(() => this.dismiss(toast.id), t.expires);
    this.emit();
  }
  dismiss(id: number) { this.toasts = this.toasts.filter(t => t.id !== id); this.emit(); }

  // ---------- state ----------
  private applyMove(u: ClientUser, m: { from: Tile; to: Tile; startedAt: number; path?: Tile[]; face?: Dir; ms?: number }) {
    const path = m.path ?? pathTo(MAP, m.from, m.to);
    const t = this.now();
    if (u.move && u.path && t < m.startedAt) u.prev = { path: u.path, startedAt: u.move.startedAt, ms: u.move.ms };
    else u.prev = null;
    u.move = { from: m.from, to: m.to, startedAt: m.startedAt, face: m.face, ms: m.ms };
    u.path = path.length ? path : [m.to];
    u.tile = m.to;
    u.faceOverride = null;
  }

  pose(u: ClientUser, t = this.now()): Pose {
    if (u.move && u.path) {
      const usePrev = u.prev && t < u.move.startedAt;
      const s = usePrev ? sampleMove(u.prev!.path, u.prev!.startedAt, t, u.prev!.ms) : sampleMove(u.path, u.move.startedAt, t, u.move.ms);
      if (s) {
        const walking = usePrev ? true : !s.done;
        const dir = !walking ? (u.faceOverride ?? u.move.face ?? s.dir) : s.dir;
        return { x: s.x, y: s.y, dir, walking, tile: s.tile };
      }
    }
    return { x: u.tile.x, y: u.tile.y, dir: u.faceOverride ?? u.dir, walking: false, tile: u.tile };
  }
  roomOf(u: ClientUser) { const p = this.pose(u); return roomAt(MAP, p.tile.x, p.tile.y); }
  name(id: string) { return this.users.get(id)?.name ?? 'someone'; }

  private onMessage(msg: ServerMsg) {
    switch (msg.t) {
      case 'pong': {
        const sent = this.clockSync.pings.get(msg.id); if (!sent) break;
        this.clockSync.pings.delete(msg.id);
        const sample = clockSample(sent.at, performance.now() - sent.perf, msg.serverTime); if (!sample) break;
        this.clockSync.samples = [...this.clockSync.samples, sample].slice(-CLOCK_SAMPLES);
        const offset = bestOffset(this.clockSync.samples)!, moved = Math.abs(offset - this.offset) > 1;
        this.offset = offset; this.clockSync.synced = true;
        if (moved) this.emit();
        break;
      }
      case 'hello':
        this.me = msg.you;
        this.park ??= new ParkLoop(this.me, msg => this.send(msg));
        this.offset = msg.serverTime - Date.now(); this.syncClock();
        if (msg.build && this.build && msg.build !== this.build) this.staleBuild = true;
        this.build ??= msg.build;
        this.sendTz();
        break;
      case 'game_session':
        if (msg.session) { this.gameOpen = true; this.gameCheers.clear(); }
        else {
          this.gameOpen = false; this.gameCheers.clear();
          if (msg.reason) this.toast({ kind: 'info', text: msg.reason === 'empty' ? 'Everyone left' : 'Playing in another tab', expires: 6000 });
        }
        this.park?.receive(msg);
        break;
      case 'game_event': case 'game_check':
        this.park?.receive(msg); return;
      case 'game_members': case 'game_clear':
        this.park?.receive(msg); break;
      case 'game_status': { const u = this.users.get(msg.userId); if (u) u.game = msg.game; break; }
      case 'game_cheer':
        if (msg.kind >= 0 && msg.kind <= 2) {
          this.gameCheers.set(msg.userId, { kind: msg.kind as 0 | 1 | 2, at: performance.now() });
          if (this.gameOpen) playPark('cheer');
        }
        return;
      case 'arcade': this.cabinets = msg.cabinets; break;
      case 'arcade_records': this.arcadeRecords = msg.records; break;
      case 'call_moved':
        this.toast({ kind: 'call_moved', roomId: msg.roomId, text: `${this.name(msg.userId).split(' ')[0]} went into ${MAP.rooms.find(r => r.id === msg.roomId)?.name ?? msg.roomId}`, expires: 15000 });
        break;
      case 'state': {
        // until the clock pings answer: a message can't arrive before it was sent, so each reading is a lower bound, and the
        // big snapshot takes longer on a slow link than the hello just before it, so keep the tighter one
        if (!this.clockSync.synced) this.offset = Math.max(this.offset, msg.serverTime - Date.now());
        const next = new Map<string, ClientUser>();
        for (const p of msg.users) {
          const old = this.users.get(p.id);
          const u: ClientUser = { ...p, game: p.game ?? null, path: old?.path ?? null, prev: old?.prev ?? null, faceOverride: old?.faceOverride ?? null, speaking: !!p.callId && p.callId === old?.callId ? old?.speaking ?? false : false };
          if (p.move && (!old?.move || old.move.startedAt !== p.move.startedAt)) { u.move = null; this.applyMove(u, p.move); }
          next.set(p.id, u);
        }
        this.users = next;
        this.setInstruments(msg.instruments ?? {});
        this.objects = msg.objects ?? {};
        this.toilets = msg.toilets ?? {};
        this.jukebox = msg.jukebox ?? {}; this.jukeboxReady = true;
        this.soundscape?.resetCrossings();
        break;
      }
      case 'user': {
        const p = msg.user;
        this.users.set(p.id, { ...p, game: p.game ?? null, path: null, prev: null, faceOverride: null, speaking: false });
        break;
      }
      case 'follow': { const u = this.users.get(msg.userId); if (u) u.following = msg.targetId; break; }
      case 'eating': { const u = this.users.get(msg.userId); if (u) { if (msg.eating) u.eating = msg.eating; else delete u.eating; } break; }
      case 'holding': {
        const u = this.users.get(msg.userId); if (u) u.holding = msg.item;
        if (msg.objectId) this.objectFx = [...this.objectFx.filter(f => performance.now() - f.at < 4000), { objectId: msg.objectId, at: performance.now() }];
        const it = msg.item ? ITEMS.get(msg.item) : undefined;
        if (msg.fromId && it) { // handed over: the item hops across like a reaction
          this.reactions.push({ fromId: msg.fromId, toId: msg.userId, emoji: it.icon, at: performance.now() });
          if (msg.userId === this.me) { playPop(); this.toast({ kind: 'info', text: `${this.name(msg.fromId)} handed you ${it.label.toLowerCase()} ${it.icon}`, expires: 5000 }); }
        }
        if (msg.objectId && it && msg.userId === this.me && CUP_ITEMS.includes(it.id)) this.toast({ kind: 'info', text: `${it.icon} Click a table to put your cup down`, expires: 5000 });
        if (msg.objectId && it && msg.userId === this.me && FOOD_ITEMS.includes(it.id)) this.toast({ kind: 'info', text: `${it.icon} Click a chair at a picnic table to eat`, expires: 5000 });
        break;
      }
      case 'creatures': this.creatures = new Map(msg.creatures.map(c => [c.id, c])); break;
      case 'creature': {
        const was = this.creatures.get(msg.creature.id), c = msg.creature;
        if (c.pose === 'pet' && was?.pose !== 'pet' && msg.by === this.me) playPet(c.kind === 'dog');
        this.creatures.set(c.id, c); break;
      }
      case 'cups': this.cups = msg.cups; break;
      case 'instrument': this.setInstruments({ ...this.instruments, [msg.id]: msg.player }); break;
      case 'seat': this.seat = msg.id; break;
      case 'note': this.soundscape?.receiveNote(msg.id, msg.by, msg.note, msg.on, msg.vel, msg.preset, msg.at); return;
      case 'jukebox': if (this.jukeboxReady) this.jukebox = { ...this.jukebox, [msg.id]: msg.state }; break;
      case 'object': this.objects = { ...this.objects, [msg.id]: { on: msg.on } }; break;
      case 'room_open': this.roomOpen = true; break;
      case 'present_open': this.presentOpen = msg.objectId; break;
      case 'bell': {
        const me = this.users.get(this.me), by = this.users.get(msg.userId);
        if (me?.instance || by?.instance) break;
        this.bells = { ...this.bells, [msg.objectId]: { userId: msg.userId, at: performance.now() } };
        const o = objectById(MAP, msg.objectId);
        if (o) this.soundscape?.ringBell(o);
        break;
      }
      case 'toilet': this.toilets = { ...this.toilets, [msg.id]: msg.state }; break;
      case 'react':
        this.reactions.push({ fromId: msg.fromId, toId: msg.toId, emoji: msg.emoji, at: performance.now() });
        if (msg.toId === this.me && msg.fromId !== this.me) playPop();
        return; // drawn by the engine; no re-render needed
      case 'chat': {
        const m = msg.msg, other = m.fromId === this.me ? m.toId : m.fromId;
        const list = this.chats.get(other) ?? [];
        if (!list.some(x => x.id === m.id)) this.chats.set(other, [...list, m]);
        if (m.fromId !== this.me && this.chatWith !== other) {
          this.unread.set(other, (this.unread.get(other) ?? 0) + 1);
          this.toasts = this.toasts.filter(t => !(t.kind === 'chat' && t.userId === other));
          this.toast({ kind: 'chat', userId: other, text: `${this.name(other)}: ${m.text}`, expires: 10000 });
          playPop();
        }
        break;
      }
      case 'chat_history': this.chats.set(msg.withId, msg.messages); break;
      case 'move': {
        const u = this.users.get(msg.userId); if (u) this.applyMove(u, msg);
        if (msg.userId === this.me) this.dungeonOpening = false;
        break;
      }
      case 'layout':
        applyLayout(MAP, msg.layout); this.layoutVersion++;
        if (msg.by === this.me && msg.added) this.added = msg.added;
        break;
      case 'me': {
        if (this.google === null && msg.google) this.toast({ kind: 'info', text: `Google connected as ${msg.google}`, hint: 'Calls you start now get their own Meet room', expires: 6000 });
        if (!this.calendarAccess && msg.calendar && this.google) this.toast({ kind: 'info', text: 'Google Calendar connected', expires: 4000 });
        const calendarNow = !!msg.calendar && !this.calendarAccess;
        this.meetLink = msg.meetLink; this.email = msg.email ?? null; this.google = msg.google; this.calendarAccess = !!msg.calendar; this.admin = !!msg.admin; this.sysadmin = !!msg.sysadmin; this.items = msg.items ?? [];
        if (msg.google !== null) this.googleAuthUrl = null;
        if (this.calendarAccess) this.calendarAuthUrl = null;
        if (calendarNow && this.calendarOpen) this.loadCalendar(); // just granted from the open panel
        break;
      }
      case 'gm_items': this.gmItems.set(msg.targetId, msg.items); break;
      case 'teleport': {
        const at = performance.now();
        this.portalFx = [...this.portalFx.filter(f => at - f.at < PORTAL_MS && f.userId !== msg.userId), { userId: msg.userId, from: msg.from, to: msg.to, at }];
        break;
      }
      case 'agenda': {
        this.agenda = msg.items;
        const keys = new Set(msg.items.map(a => a.key)); // cancelled or declined: drop its heads-up
        this.toasts = this.toasts.filter(t => !t.meetingKey || keys.has(t.meetingKey));
        this.checkAgenda();
        break;
      }
      case 'meeting': { const u = this.users.get(msg.userId); if (u) u.meeting = msg.until; break; }
      case 'meetings': this.meetingRooms = msg.rooms; break;
      case 'library': this.library = { articles: msg.articles, reads: msg.reads }; break;
      case 'reading': {
        const u = this.users.get(msg.userId); if (u) u.reading = msg.articleId;
        if (msg.userId === this.me) { this.fetching = null; clearTimeout(this.fetchTimer); }
        break;
      }
      case 'dungeon': {
        const me = this.users.get(this.me);
        if (me && underground(me)) {
          this.dungeon = { key: msg.key, hasKey: msg.hasKey, seen: msg.event === 'fell' ? new Set() : this.dungeon?.seen ?? new Set() };
          if (!msg.event || msg.event === 'fell') this.dungeonOpening = false;
          if (msg.event === 'opening') this.dungeonOpening = true;
        }
        const text = msg.event === 'fell' ? '🕳 You fell through! Find the key and the way out.'
          : msg.event === 'key' ? '🗝️ You found a key!'
          : msg.event === 'locked' ? '🔒 Locked. There must be a key somewhere down here.'
          : msg.event === 'escaped' ? '☀️ You made it out!' : null;
        if (text) this.toast({ kind: 'info', text, expires: 6000 });
        if (msg.event && msg.event !== 'gave_up') playDungeon(msg.event);
        break;
      }
      case 'instance': {
        const u = this.users.get(msg.userId);
        if (u && underground(u) !== (msg.instance === DUNGEON_INSTANCE)) {
          const at = performance.now(), user = { ...u }, fell = msg.instance === DUNGEON_INSTANCE;
          this.dungeonFx = this.dungeonFx.filter(f => at - f.at < 2200);
          if (fell) {
            this.dungeonFx.push({ kind: 'fall', user, tile: { ...this.pose(u).tile }, at });
            this.dungeonFx.push({ kind: 'land', user, tile: msg.tile, at: at + (u.id === this.me ? 900 : 0) });
          } else if (msg.instance === null) this.dungeonFx.push({ kind: 'climb', user, tile: msg.tile, at });
        }
        if (u) { u.instance = msg.instance; u.tile = msg.tile; u.dir = msg.dir; u.move = null; u.path = null; u.prev = null; u.faceOverride = null; }
        this.soundscape?.resetCrossings(msg.userId === this.me ? undefined : msg.userId);
        if (msg.userId === this.me && msg.instance) this.toasts = this.toasts.filter(t => !(t.kind === 'meeting' && this.agenda.find(a => a.key === t.meetingKey)?.instance === msg.instance));
        break;
      }
      case 'google_auth': if (msg.calendar) this.calendarAuthUrl = msg.url; else this.googleAuthUrl = msg.url; break;
      case 'calendar': {
        this.calendarEvents = msg.events ?? [];
        this.calendarError = msg.error ?? null;
        if (msg.error === 'no_access') { this.calendarAccess = false; this.prepareCalendarAuth(); }
        break;
      }
      case 'desk': { const u = this.users.get(msg.userId); if (u) u.homeDesk = msg.desk; break; }
      case 'plant': {
        const u = this.users.get(msg.userId); if (!u) break;
        const was = u.plant, earned = u.achievements;
        u.plant = msg.plant; u.bloomed = msg.bloomed; u.achievements = msg.achievements;
        if (u.id !== this.me) break;
        const p = msg.plant;
        if (p && was && (p.stage !== was.stage || p.kind !== was.kind || p.care !== was.care)) this.toast({ kind: 'info', expires: 5000,
          text: p.stage === 0 ? '🌱 You planted a new seedling' : `🌱 Your ${plantName(p)} grew: ${PLANT_STAGES[p.stage]}`,
          hint: p.stage === 0 ? 'The old one withered after a week without a status' : 'It grows once a day you set a status' });
        for (const a of ACHIEVEMENTS) if (msg.achievements[a.id] && !earned[a.id]) {
          playPop(); this.toast({ kind: 'info', expires: 8000, text: `${a.icon} Achievement: ${a.title}`, hint: 'See all on the notice board in the Lobby' });
        }
        break;
      }
      case 'to_meet': {
        if (!this.callLink) break;
        this.toasts = this.toasts.filter(t => t.kind !== 'link');
        this.toast({ kind: 'link', link: this.callLink, text: `${this.name(msg.fromId).split(' ')[0]} moved to Meet`, hint: 'Join them in the call\'s Meet room', expires: 60000 });
        playKnock();
        break;
      }
      case 'call': {
        const u = this.users.get(msg.userId);
        if (u) {
          if (u.callId !== msg.callId) { u.speaking = false; u.hand = false; }
          u.callId = msg.callId;
        }
        if (msg.userId === this.me) this.callLink = msg.callId && !msg.callId.startsWith('room:') ? msg.link ?? this.callLink : null;
        break;
      }
      case 'room_meet': this.roomMeetLink = msg.link ? { instance: msg.instance, link: msg.link } : null; break;
      case 'voice_owner': this.voiceOwner = msg.owner; break;
      case 'voice_wait': {
        const was = this.voiceWait; this.voiceWait = msg.roomId;
        if (!was && msg.roomId) this.toast({ kind: 'info', text: `${MAP.rooms.find(r => r.id === msg.roomId)?.name ?? 'Room'} voice is full (${ROOM_VOICE_MAX}) — you'll join when someone leaves`, expires: 6000 });
        break;
      }
      case 'notice': this.toast({ kind: 'info', text: msg.text, expires: 6000 }); break;
      case 'deafen': { const u = this.users.get(msg.userId); if (u) { u.deafened = msg.on; if (msg.on) u.speaking = false; } break; }
      case 'hand': {
        const u = this.users.get(msg.userId), me = this.users.get(this.me);
        if (u) {
          if (msg.up && !u.hand && u.id !== this.me && !!me?.callId && this.sameRoomCall(u)) playHand();
          u.hand = msg.up;
        }
        break;
      }
      case 'rtc': this.onRtc?.(msg.from, msg.signal); return; // no re-render needed
      case 'speaking': { const u = this.users.get(msg.userId); if (u) u.speaking = msg.on; break; }
      case 'mute': { const u = this.users.get(msg.userId); if (u) { u.muted = msg.muted; if (msg.muted) u.speaking = false; } break; }
      case 'status': { const u = this.users.get(msg.userId); if (u) u.status = msg.status; break; }
      case 'presentation': {
        if (msg.live?.deck?.id !== this.presentation?.deck?.id || msg.live?.presenter !== this.presentation?.presenter) this.slidesHidden = msg.live?.presenter !== this.me; // viewers are asked first (LiveChip)
        if (!msg.live || msg.live.presenter !== this.presentation?.presenter || msg.live.deck?.id !== this.presentation.deck?.id) this.frame = null;
        this.presentation = msg.live; break;
      }
      case 'frame': {
        const me = this.users.get(this.me);
        if (!this.presentation || msg.scope !== this.presentation.scope || msg.scope !== presentScope(me?.instance) || msg.seq <= (this.frame?.seq ?? -1)) return;
        this.frame = { seq: msg.seq, url: `data:image/jpeg;base64,${msg.data}` }; break;
      }
      case 'tz': { const u = this.users.get(msg.userId); if (u) { if (msg.tz) u.tz = msg.tz; else delete u.tz; } break; }
      case 'look': { const u = this.users.get(msg.userId); if (u) { u.look = msg.look; u.lookSet = msg.lookSet; if (msg.name) u.name = msg.name; } break; }
      case 'effects': { const u = this.users.get(msg.userId); if (u) u.effects = msg.effects; break; }
      case 'presence': { const u = this.users.get(msg.userId); if (u) u.presence = msg.presence; break; }
      case 'emote': { const u = this.users.get(msg.userId); if (u) u.emote = msg.emote; break; }
      case 'door': { const u = this.users.get(msg.userId); if (u) u.door = msg.door; break; }
      case 'knock': {
        const from = this.users.get(msg.fromId), to = this.users.get(msg.toId);
        if (from && to) { // knocker turns to face the person
          const a = this.pose(from).tile, b = this.pose(to).tile;
          from.faceOverride = b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : 'up';
        }
        if (msg.toId === this.me) playKnock();
        if (msg.toId === this.me) this.toast({ kind: 'knock_in', knockId: msg.knockId, text: this.users.get(this.me)?.callId ? `${this.name(msg.fromId)} wants to join your call` : `${this.name(msg.fromId)} is knocking` });
        else if (msg.fromId === this.me) this.toast({ kind: 'knock_out', knockId: msg.knockId, text: `Knocking on ${this.name(msg.toId)}…` });
        break;
      }
      case 'knock_reply': {
        const mine = msg.fromId === this.me, forMe = msg.toId === this.me;
        if (!mine && !forMe) break;
        this.toasts = this.toasts.filter(t => t.knockId !== msg.knockId);
        if (msg.cancelled) break; // called back: the prompt just goes away on both sides
        const otherId = mine ? msg.toId : msg.fromId, other = this.name(otherId);
        if (msg.reply === 'accept') {
          this.callLink = msg.link ?? this.callLink;
          this.toast({ kind: 'info', text: `🎙 Voice call with ${other}`, expires: 4000 });
        }
        else if (mine && msg.reply === 'blocked') this.toast({ kind: 'info', text: msg.reason ?? `Can't knock on ${other} now`, expires: 5000 });
        else if (mine) this.toast({ kind: 'knock_again', userId: otherId, text: msg.reason ?? `${other} said later`, expires: 12000 });
        else if (forMe && msg.reason) this.toast({ kind: 'knock_again', userId: otherId, text: `Missed a knock from ${other}`, expires: 30000 });
        break;
      }
    }
    const me = this.users.get(this.me);
    if (!me || !underground(me)) { this.dungeon = null; this.dungeonOpening = false; }
    // Walking, talking and emotes only move pixels on the canvas; the React chrome needn't re-render for them.
    // (The People list follows walkers on its own 1 s tick.)
    if (SCENE_ONLY.has(msg.t)) this.version++; else this.emit();
    // A deploy happened while this page was open: reload into the new build, but never mid-call.
    if (this.staleBuild && !this.users.get(this.me)?.callId) location.reload();
  }
}
