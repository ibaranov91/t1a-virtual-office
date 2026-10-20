import { onMap, terrainAt } from '../../shared/beach';
import { INSTRUMENTS } from '../../shared/instruments';
// The floor: one <canvas>, one requestAnimationFrame loop.
// Order: static tilemap → y-sorted furniture + sprites → nameplates & bubbles → ambient tint → UI hints.
import { adminOnly, applyEdit, FIXED_TYPES, inRect, SEAT_TYPES, findPath, pathTo, sampleMove, pathDuration, WALK_MS_PER_TILE, isWalkable, layoutProblem, objectById, objectName, roomAt, rugFrame, seatAt, withLayout, type MapObject, type Rect, type Rug, type Tile } from '../../shared/map';
import { FOOD_ITEMS, KITCHEN_TABLES, kitchenSpot, picnicSeat } from '../../shared/lunch';
import { DungeonView } from './dungeon';
import { DANCE_ROOM, danceBeat, dancePhase } from '../../shared/effects';
import { DRINKS, emptyDrink, isEmpty } from '../../shared/drinks';
import { drawEffects, effectLook, effectSway, HAT_H } from './effects';
import { CreatureLayer, creaturePose } from './creatures';
import { lockedDoors, roomDoors, glassDoors, type RoomDoor } from './doors';
import { voiceSignPositions } from './roomSigns';
import { drawBeachSign } from './beachSign';
import { dance, discos, drawDisco, evening, type DanceStep, type Disco } from './disco';
import type { Assets, Frame } from './assets';
import { drawText, plateLines, textWidth } from './font';
import { TRACK } from '../../shared/music';
import { TOILET_CAPACITY, toiletFull, cupTableAt, CUP_ITEMS, underground, MEETING_ROOM_ID, PLANT_REVEAL, PLANT_STAGES, plantDead, plantName, type Cup, type LayoutEdit } from '../../shared/protocol';
import { isCovered } from './native';
import { itemDef } from '../../shared/items';
import { fogHides, isOutdoor } from '../../shared/weather';
import { hourBucket, lightmapKey, lightWeight, LM, paintLightmap } from './lighting';
import { personLight } from './personLight';
import { REACTION_FRAME } from './reactionArt';
import { WeatherFx } from './weatherFx';
import { ITEMS, MAP, PORTAL_MS, type ClientUser, type Pose, type PortalFx, type Store, type DungeonFx } from './net';

const TS = MAP.tileSize;
/** An admin's portal trip, by age in ms: portal opens at the start (0-400), they step in (400-900), it closes (1000-1400); one opens at the end (1000-1400), they step out (1400-1900), it closes (1900-2200). */
const ease = (k: number) => 1 - (1 - Math.min(1, Math.max(0, k))) ** 2;
const portalStage = (age: number) => ({
  from: age < 400 ? ease(age / 400) : age < 1000 ? 1 : 1 - ease((age - 1000) / 400),
  to: age < 1000 ? 0 : age < 1400 ? ease((age - 1000) / 400) : age < 1900 ? 1 : 1 - ease((age - 1900) / 300),
  size: age < 400 ? 1 : age < 900 ? 1 - ease((age - 400) / 500) : age < 1400 ? 0 : age < 1900 ? ease((age - 1400) / 500) : 1,
  atFrom: age < 900, hidden: age >= 900 && age < 1400,
});
/** 3x5 pixel digits for the world clocks, one row per number (bit 4 is the left column). */
const DIGITS = [[7, 5, 5, 5, 7], [2, 6, 2, 2, 7], [7, 1, 7, 4, 7], [7, 1, 7, 1, 7], [5, 5, 7, 1, 1], [7, 4, 7, 1, 7], [7, 4, 7, 5, 7], [7, 1, 1, 1, 1], [7, 5, 7, 5, 7], [7, 5, 7, 1, 7]];
const zoneFmt = new Map<string, Intl.DateTimeFormat>();
/** Hour and minute on the wall in an IANA zone, right now. */
function zoneHM(tz: string) {
  let f = zoneFmt.get(tz); if (!f) zoneFmt.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }));
  const p = f.formatToParts(new Date());
  return { h: +p.find(x => x.type === 'hour')!.value, m: +p.find(x => x.type === 'minute')!.value };
}
function zoneTime(tz: string) { const { h, m } = zoneHM(tz); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }
const MW = MAP.width * TS, MH = MAP.height * TS;
const MEETING = MAP.rooms.find(r => r.id === MEETING_ROOM_ID)!.rect;
const inMeetingRoom = (x: number, y: number) => x >= MEETING.x && x < MEETING.x + MEETING.w && y >= MEETING.y && y < MEETING.y + MEETING.h;
const DIR_ROW: Record<string, number> = { down: 0, left: 1, right: 2, up: 3 };
const WALK_FPS = 8; // 4 frames per tile at 4 tiles/s
const SIT_FRAME = 5;

/** Someone's plant where it stands: x = pot centre, y = pot bottom, base = y-sort key (just after its desk or shelf). */
type PlacedPlant = { u: ClientUser; x: number; y: number; base: number };
const FRONT: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

const BUBBLE_DX = 6;      // bubbles float beside the head, not centred on it
const BUBBLE_SCALE = 0.75; // bubble pixels are about ¾ of an art pixel, rounded to whole screen pixels so they stay crisp
type BubbleKind = 'bubble_tomato' | 'bubble_dots' | 'bubble_game' | 'bubble_watch' | 'bubble_bang' | 'bubble_headset' | 'bubble_zzz' | 'bubble_meeting' | 'bubble_think' | 'bubble_talk' | 'bubble_phone' | 'bubble_hand' | 'bubble_deaf' | 'bubble_mute_deaf';
// where the bag hangs when carried, per facing; behind = drawn before the body
const BAG_HAND: Record<string, { dx: number; behind: boolean }> = {
  down: { dx: 10, behind: false }, up: { dx: -3, behind: false }, left: { dx: 7, behind: true }, right: { dx: -1, behind: true },
};

/** What a click landed on; the action wheel opens for it. */
export type Pick = { kind: 'user' | 'object'; id: string };
/** Something an admin can pick up in edit mode: a piece of furniture or a rug. */
type Item = { id: string; x: number; y: number; w: number; h: number; type?: string; wall?: boolean; dir?: string; color?: string; pattern?: string };

// item id -> icon, from whatever the map's objects hand out
const ITEM_ICON = new Map([...ITEMS].map(([id, i]) => [id, i.icon]));
const ITEM_HAND: Record<string, { dx: number; dy: number }> = { down: { dx: 13, dy: -9 }, up: { dx: 3, dy: -10 }, left: { dx: 3, dy: -9 }, right: { dx: 13, dy: -9 } };

const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

let waterMask: boolean[][] | undefined; // the floor never changes, so which tiles are water is worked out once
const FAST_MS = 33; // the top redraw rate: ~30 fps
export class Engine {
  private dungeonView = new DungeonView(MAP);
  private area: Rect = MAP.office;
  private areaDown = false;
  private actualDown = false;
  private held = new Map<string, [number, number]>();
  private stepPending: { to: Tile; at: number } | null = null;
  private lastCarKey = 0; // performance.now() of the last arrow-key steer of a remote car
  private areaUnsub: () => void;
  private ctx: CanvasRenderingContext2D;
  private staticLayer: HTMLCanvasElement;
  private raf = 0;
  private lastDraw = 0;
  private lastInput = 0;
  private px = 2;         // art pixels -> device pixels; whole numbers keep the art crisp (fractional only mid-glide)
  private dpr = 1;
  private minPx = 1;      // the whole floor fits
  private maxPx = 8;      // 4 css pixels per art pixel
  private targetPx = 0;   // the level we're at or gliding to (0 until the first layout)
  private prevPx = 0;     // where the overview goes back to
  private glide: { from: number; at: number; sx: number; sy: number; wx: number; wy: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; px: number; x: number; y: number } | null = null;
  private gesture: { px: number; at: number } | null = null; // Safari trackpad pinch
  private wheelAcc = 0;
  /** Zoom level or overview changed (the chrome's buttons follow it). */
  onZoom?: () => void;
  private cam = { x: 0, y: 0 };
  private manualCam = false;
  private viewW = 0; private viewH = 0;
  hoverUser: string | null = null;
  private hoverObject: MapObject | null = null;
  private interactive: MapObject[];
  private boards: MapObject[]; // meetings boards: a badge when meetings are on
  private kiosks: MapObject[]; // the Meeting room's booking kiosk: its screen breathes
  /** The wheel's target, ringed on the floor. */
  selected: Pick | null = null;
  onPick?: (p: Pick | null) => void;
  private hoverTile: { x: number; y: number } | null = null;
  private hoverPlant: PlacedPlant | null = null;
  private hoverCritter: { text: string; x: number; y: number; id?: string } | null = null;
  private lunchTile: Tile | null = null; // a picnic chair I can eat my food at, under the pointer
  private cupTile: Tile | null = null; // a table I can put my cup down on, under the pointer
  private hoverCup: Cup | null = null;  // a cup someone left, under the pointer: click to clear it away
  critters: CreatureLayer;
  private plants: PlacedPlant[] = [];
  private plantsVersion = -1; // store.version the plants were placed for
  private glow: HTMLCanvasElement; // one lamp's halo at full strength; drawn with alpha per frame
  private greenGlow: HTMLCanvasElement; // a banker's lamp on a reading table: a smaller, green pool
  private drag: { x: number; y: number; camX: number; camY: number; moved: boolean } | null = null;
  private bubbleState = new Map<string, { kind: BubbleKind | null; at: number }>();
  private nameplates = new Map<string, HTMLCanvasElement>();
  private ro: ResizeObserver;
  private furniture: { o: MapObject; x: number; y: number; base: number; off: boolean }[]; // y-sorted on each layout; x,y = sprite origin
  private lights: MapObject[];
  // ---- atmosphere: lighting, weather, windows, roof ----
  /** Dev: pretend it is this local hour (0-24) for the lighting. */
  devHour: number | null = null;
  private fx = new WeatherFx(MAP);
  private lightmap = document.createElement('canvas');
  private lightmapKey = '';
  private litObjects: MapObject[] = []; // everything that gives light, for the cache key
  private windows: MapObject[] = [];
  private roofAlpha = -1; private roofAt = 0; // 1 = Berghain's roof is on; eased, -1 until the first frame
  private rainClock = 0; private rainLastMs = 0; // the rain's own clock: it stands still while the rain is paused
  private steamers: MapObject[];
  private noteSeen = new Map<string, number>();
  private instrumentNotes: { id: string; at: number }[] = [];
  private sounders: MapObject[];
  private statusSeen = new Map<string, { text: string; at: number }>();
  private placedPlates: { x: number; y: number; w: number; h: number }[] = [];
  private snapped = false;
  private slots: Tile[] = [];
  private layoutSeen = -1;
  private doors: RoomDoor[] = [];
  private deniedAt = new Map<string, number>(); // room id → when a locked door last turned someone away (it shakes)
  private discos: Disco[] = [];
  private jukeboxes: { o: MapObject; room?: string }[] = [];
  private parties: string[] = []; // rooms whose jukebox is playing, this frame: people there dance
  private dancer: DanceStep = { dx: 0, dy: 0, turn: 0 }; // reused every frame
  // ---- edit mode (office admins) ----
  editing = false;
  /** Selected furniture or rug. */
  editSel: string | null = null;
  /** A catalog type (or 'rug') to put down with the next click. */
  placing: string | null = null;
  onEditChange?: () => void;
  private editHover: Item | null = null;
  private editDrag: { item: Item; gx: number; gy: number; x: number; y: number; moved: boolean } | null = null;
  private ghost: { item: Item; problem: string | null } | null = null;

  constructor(private canvas: HTMLCanvasElement, private store: Store, private assets: Assets) {
    this.ctx = canvas.getContext('2d', { alpha: false })!; // opaque: the frame starts with a full fill, so the compositor can skip blending
    this.staticLayer = this.furniture = this.lights = this.steamers = this.sounders = this.interactive = this.boards = this.kiosks = null!;
    this.critters = new CreatureLayer(store, () => this.ctx, n => this.f(n), (n, x, y) => this.blit(this.ctx, n, x, y));
    this.refreshLayout();
    this.glow = document.createElement('canvas'); this.glow.width = this.glow.height = 80;
    const gc = this.glow.getContext('2d')!, g = gc.createRadialGradient(40, 40, 2, 40, 40, 40);
    g.addColorStop(0, 'rgba(255,200,110,1)'); g.addColorStop(1, 'rgba(255,200,110,0)');
    gc.fillStyle = g; gc.fillRect(0, 0, 80, 80);
    this.greenGlow = document.createElement('canvas'); this.greenGlow.width = this.greenGlow.height = 56;
    const lc = this.greenGlow.getContext('2d')!, lg = lc.createRadialGradient(28, 28, 2, 28, 28, 28);
    lg.addColorStop(0, 'rgba(170,240,150,1)'); lg.addColorStop(0.5, 'rgba(120,200,110,0.45)'); lg.addColorStop(1, 'rgba(90,170,90,0)');
    lc.fillStyle = lg; lc.fillRect(0, 0, 56, 56);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement!);
    this.resize();
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('gesturestart', this.onGesture);
    canvas.addEventListener('gesturechange', this.onGesture);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.stopKeys);
    for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'gesturechange']) window.addEventListener(ev, this.touched, { passive: true });
    this.areaUnsub = store.subscribe(() => this.syncArea());
    this.syncArea();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf); this.ro.disconnect(); this.areaUnsub();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onCancel);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('gesturestart', this.onGesture);
    this.canvas.removeEventListener('gesturechange', this.onGesture);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'gesturechange']) window.removeEventListener(ev, this.touched);
    window.removeEventListener('blur', this.stopKeys);
  }

  /** Pan the camera to a person (from the room list). */
  focusUser(id: string) {
    const u = this.store.users.get(id); if (!u) return;
    if (u.instance !== this.myInstance() || (this.areaDown && !this.dungeonView.canSee(this.store.pose(u).tile))) return;
    const p = this.store.pose(u);
    this.lookAt(p.x * TS + 8, p.y * TS);
  }
  /** Pan to a room (from the room list), out of the overview if we're in it. */
  focusRoom(id: string) {
    if (this.areaDown) return;
    const r = MAP.rooms.find(r => r.id === id)?.rect; if (!r) return;
    this.lookAt((r.x + r.w / 2) * TS, (r.y + r.h / 2) * TS);
  }
  /** Walk into a room (from the list): the free tile nearest its middle, plain floor before a seat. */
  walkToRoom(id: string) {
    const r = MAP.rooms.find(r => r.id === id), me = this.store.users.get(this.store.me); if (!r || !me) return;
    if (underground(me)) return this.blockDungeon();
    if (me.instance || roomAt(MAP, me.tile.x, me.tile.y)?.id === id) return this.focusRoom(id); // a meeting's room has no way out but Leave
    if (r.rules.access && !this.store.sysadmin) { this.focusRoom(id); return this.denyDoor(r.rect.x, r.rect.y); }
    const { x, y, w, h } = r.rect, cx = x + (w - 1) / 2, cy = y + (h - 1) / 2, taken = this.taken();
    let best: { t: Tile; score: number } | null = null;
    for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) {
      if (!isWalkable(MAP, tx, ty) || taken.has(`${tx},${ty}`)) continue;
      const score = Math.abs(tx - cx) + Math.abs(ty - cy) + (seatAt(MAP, tx, ty) ? 100 : 0);
      if (!best || score < best.score) best = { t: { x: tx, y: ty }, score };
    }
    if (best) this.walkTo(best.t); else this.focusRoom(id);
  }
  /** Walk up beside someone (from the list): the free neighbouring tile with the shortest path. */
  walkToUser(id: string) {
    const me = this.store.users.get(this.store.me), u = this.store.users.get(id);
    if (me && u && (underground(u) && !underground(me) || underground(me) && !underground(u))) return this.blockDungeon(u);
    if (!me || !u || u.id === me.id || u.presence === 'offline' || u.instance !== me.instance) return this.focusUser(id);
    const taken = this.taken(), inside = !!me.instance, d = u.tile;
    let best: { t: Tile; len: number } | null = null;
    for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) {
      const t = { x: d.x + dx, y: d.y + dy };
      if (t.x === me.tile.x && t.y === me.tile.y) return this.walkTo(t); // already there
      if (!isWalkable(MAP, t.x, t.y) || taken.has(`${t.x},${t.y}`) || (inside && !this.inArea(t))) continue;
      if (!this.canWalk(t)) continue;
      const len = findPath(MAP, me.tile, t).length;
      if (len && (!best || len < best.len)) best = { t, len };
    }
    if (best) this.walkTo(best.t); else this.focusUser(id);
  }
  /** Tiles other people stand on or are heading to, in my instance. */
  private taken() {
    return new Set([...this.store.users.values()].filter(u => u.id !== this.store.me && onMap(u) && u.instance === this.myInstance()).map(u => `${u.tile.x},${u.tile.y}`));
  }
  private blockDungeon(u?: ClientUser) {
    const text = this.store.dungeonReason(u); if (text) this.store.toast({ kind: 'info', text, expires: 5000 });
  }
  private walkTo(t: Tile) { if (!this.canWalk(t)) return; this.onPick?.(null); this.manualCam = false; if (this.overview) this.zoomTo(this.backPx()); this.store.moveTo(t); }
  private lookAt(wx: number, wy: number) {
    this.manualCam = true;
    if (this.overview) return this.zoomTo(this.backPx(), { sx: this.canvas.width / 2, sy: this.canvas.height / 2 }, { wx, wy });
    this.cam = this.clampCam(wx - this.viewW / 2, wy - this.viewH / 2);
  }
  recenter() { this.manualCam = false; if (this.overview) this.zoomTo(this.backPx()); }
  /** CSS-pixel position of a user's sprite centre (debug/tests). */
  screenPos(id: string) {
    const u = this.store.users.get(id); if (!u) return null;
    const p = this.store.pose(u); const r = this.canvas.getBoundingClientRect(); const k = this.px / (this.canvas.width / r.width);
    return { x: r.left + (p.x * TS + 8 - this.cam.x) * k, y: r.top + (p.y * TS + 4 - this.cam.y) * k };
  }

  /** CSS-pixel centre of what the wheel points at and how far its sprite reaches from there, or null if it's gone. */
  anchor(p: Pick) {
    const k = this.px / (this.canvas.width / this.canvas.getBoundingClientRect().width);
    if (p.kind === 'user') { const s = this.screenPos(p.id); return s && { ...s, r: 13 * k }; }
    const o = objectById(MAP, p.id), fr = o && this.f(o.type);
    if (!o || !fr) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((o.x + o.w / 2) * TS - this.cam.x) * k, y: r.top + ((o.y + o.h) * TS - fr.h / 2 - this.cam.y) * k, r: (Math.max(fr.w, fr.h) / 2) * k };
  }

  // ---------- edit mode (office admins) ----------
  setEditing(on: boolean) {
    on = on && !this.areaDown && !this.falling();
    this.editing = on; this.editSel = this.placing = null; this.editDrag = this.ghost = this.editHover = null;
    this.hoverTile = null; this.hoverUser = null; this.hoverObject = null;
    this.manualCam = on; // the floor holds still under the pointer; Done follows me again
    this.onPick?.(null); this.onEditChange?.();
  }
  setPlacing(type: string | null) { this.placing = type; this.editSel = null; this.ghost = null; this.onEditChange?.(); }
  select(id: string | null) { this.editSel = id; this.placing = null; this.onEditChange?.(); }
  item(id: string): Item | undefined { return MAP.objects.find(o => o.id === id) ?? MAP.rugs.find(r => r.id === id); }
  /** What's under this point in edit mode: the front-most sprite, else a rug. */
  private itemAt(wx: number, wy: number): Item | null {
    let best: MapObject | null = null, bestKey = -Infinity;
    for (const o of MAP.objects) {
      const s = this.sprite(o);
      const [x, y, w, h] = s ? [s.x, s.y, s.fr.w, s.fr.h] : [o.x * TS, o.y * TS, o.w * TS, o.h * TS];
      if (wx < x || wx >= x + w || wy < y || wy >= y + h) continue;
      const key = (o.wall ? -1000 : 0) + (o.y + o.h) * 2 + (o.walkable ? 0 : 1); // in front wins, decor last
      if (key > bestKey) { best = o; bestKey = key; }
    }
    if (best) return best;
    const tx = Math.floor(wx / TS), ty = Math.floor(wy / TS);
    return MAP.rugs.find(r => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) ?? null;
  }
  /** What clicking this tile would put down, centred under the pointer. */
  private placeItem(tx: number, ty: number): Item {
    const t = this.placing === 'rug' ? { w: 3, h: 2, color: 'green' } : MAP.catalog[this.placing!];
    return { ...t, id: '', x: tx - Math.floor((t.w - 1) / 2), y: ty - Math.floor((t.h - 1) / 2) };
  }
  private placeEdit(it: Item): LayoutEdit { return it.color ? { op: 'rug_add', x: it.x, y: it.y } : { op: 'add', type: it.type!, x: it.x, y: it.y }; }
  /** Why the server would turn this edit down, or null: the same checks, run here first so the ghost can say. */
  private check(edit: LayoutEdit) {
    const next = applyEdit(MAP, edit, () => '');
    return typeof next === 'string' ? next : layoutProblem(withLayout(MAP, next));
  }

  /** The furniture changed (an admin moved something): redraw the floor and re-sort what's where. */
  private refreshLayout() {
    this.layoutSeen = this.store.layoutVersion;
    this.doors = [...roomDoors(MAP), ...lockedDoors(MAP), ...glassDoors(MAP)];
    this.discos = discos(MAP);
    this.jukeboxes = MAP.objects.filter(o => o.use?.kind === 'jukebox').map(o => ({ o, room: roomAt(MAP, o.x, o.y)?.id }));
    this.staticLayer = this.buildStatic();
    this.furniture = MAP.objects.filter(o => !o.wall && !o.walkable && this.f(o.type)).map(o => {
      const fr = this.f(o.type);
      return { o, x: o.x * TS + (o.w * TS - fr.w) / 2, y: (o.y + o.h) * TS - fr.h, base: (o.y + o.h) * TS - 0.5, off: !!this.f(`${o.type}_off`) };
    }).sort((a, b) => a.base - b.base);
    this.lights = MAP.objects.filter(o => o.light);
    this.litObjects = MAP.objects.filter(o => lightWeight(o));
    this.windows = MAP.objects.filter(o => o.type === 'window' && o.use?.kind === 'toggle');
    this.lightmapKey = '';
    this.steamers = MAP.objects.filter(o => o.steam);
    this.sounders = MAP.objects.filter(o => o.sound);
    this.plantsVersion = -1; // shelves may have moved
    this.interactive = MAP.objects.filter(o => o.use || o.sit || o.lie);
    this.boards = MAP.objects.filter(o => o.use?.kind === 'meetings');
    this.kiosks = MAP.objects.filter(o => o.use?.kind === 'room_start');
    this.slots = MAP.rooms.flatMap(r => r.plantSlots ?? []);
    if (this.editSel && !this.item(this.editSel)) this.editSel = null;
    if (this.store.added) { this.editSel = this.store.added; this.store.added = null; }
    this.ghost = null;
    this.onEditChange?.();
  }

  // ---------- frames ----------
  private f(name: string): Frame { return this.assets.atlas.frames[name]; }
  /** A bubble drawn with its own whole-number pixel size (about BUBBLE_SCALE of an art pixel; at most 1), anchored at its
   *  tail tip: (tx, ty) is where the tail touches, column 5 of the frame, below its last row. */
  private blitBubble(ctx: CanvasRenderingContext2D, name: string, tx: number, ty: number) {
    const fr = this.f(name); if (!fr) return;
    const z = Math.max(1, Math.round(this.px)), s = Math.max(1, Math.round(BUBBLE_SCALE * z)) / z; // art pixels per bubble pixel
    ctx.drawImage(this.assets.world, fr.x, fr.y, fr.w, fr.h, Math.round(tx) - 5 * s, Math.round(ty) - fr.h * s, fr.w * s, fr.h * s);
  }
  private blit(ctx: CanvasRenderingContext2D, name: string, x: number, y: number) {
    const fr = this.f(name); if (!fr) return;
    ctx.drawImage(this.assets.world, fr.x, fr.y, fr.w, fr.h, Math.round(x), Math.round(y), fr.w, fr.h);
  }

  private buildStatic() {
    const c = document.createElement('canvas'); c.width = MW; c.height = MH;
    const ctx = c.getContext('2d')!;
    const { floor, walls } = MAP.layers;
    for (let y = 0; y < MAP.height; y++) for (let x = 0; x < MAP.width; x++) {
      if (floor[y][x]) this.blit(ctx, MAP.tiles[floor[y][x]], x * TS, y * TS);
    }
    for (const r of MAP.rugs) this.drawRug(ctx, r);
    // soft shadows on the floor below wall faces and to the right of caps
    ctx.fillStyle = 'rgba(40,20,20,0.22)';
    for (let y = 1; y < MAP.height; y++) for (let x = 0; x < MAP.width; x++) {
      if (walls[y][x]) continue;
      const above = MAP.tiles[walls[y - 1][x]] ?? '';
      if (above.startsWith('wall_face')) { ctx.fillRect(x * TS, y * TS, TS, 3); ctx.fillStyle = 'rgba(40,20,20,0.1)'; ctx.fillRect(x * TS, y * TS + 3, TS, 2); ctx.fillStyle = 'rgba(40,20,20,0.22)'; }
      const left = MAP.tiles[walls[y][x - 1]] ?? '';
      if (left === 'wall_cap') ctx.fillRect(x * TS, y * TS, 2, TS);
    }
    for (let y = 0; y < MAP.height; y++) for (let x = 0; x < MAP.width; x++) {
      if (walls[y][x]) this.blit(ctx, MAP.tiles[walls[y][x]], x * TS, y * TS);
    }
    for (const o of MAP.dungeon?.decor ?? []) this.blit(ctx, o.type, o.x * TS, o.y * TS);
    // wall decor + floor-level furniture (chairs) are static
    for (const o of MAP.objects) if ((o.wall || o.walkable) && o.type !== 'dance_floor') this.drawItem(ctx, o); // the dance floor animates: see drawDanceFloor
    this.drawOpenVoiceSigns(ctx);
    return c;
  }
  /** Neon signs are rebuilt with the interior whenever room rules or furniture change. */
  private drawOpenVoiceSigns(ctx: CanvasRenderingContext2D) {
    for (const { x, y } of voiceSignPositions(MAP, this.assets.atlas.frames)) {
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = '#111c29'; ctx.fillRect(0, 0, 30, 17);
      ctx.fillStyle = '#243d49'; ctx.fillRect(2, 17, 28, 2);
      ctx.shadowColor = '#40f5df'; ctx.shadowBlur = 7;
      ctx.strokeStyle = '#40f5df'; ctx.lineWidth = 1;
      ctx.strokeRect(1.5, 1.5, 27, 14);
      ctx.fillStyle = '#ff81cf';
      ctx.fillRect(3, 5, 3, 4); ctx.fillRect(4, 9, 1, 2); ctx.fillRect(3, 11, 3, 1);
      drawText(ctx, 'OPEN', 10, 3, '#b5fff2');
      ctx.shadowBlur = 0;
      drawText(ctx, 'VOICE', 8, 9, '#ffb0df');
      ctx.restore();
    }
  }
  private drawRug(ctx: CanvasRenderingContext2D, r: Rug) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const v = y === r.y ? 'n' : y === r.y + r.h - 1 ? 's' : '', h = x === r.x ? 'w' : x === r.x + r.w - 1 ? 'e' : '';
      this.blit(ctx, rugFrame(r, (v + h) || 'c'), x * TS, y * TS);
    }
  }
  /** A piece of furniture's sprite and where it goes: centred on its footprint, standing on its bottom edge (decor hangs from the top). */
  private sprite(o: Item) {
    const name = o.dir && this.f(`${o.type}_${o.dir}`) ? `${o.type}_${o.dir}` : o.type === 'window' && this.windowOpen(o as MapObject) && this.f('window_open') ? 'window_open' : o.type!; // chairs face their desk; windows open
    const fr = this.f(name);
    return fr && { name, fr, x: o.x * TS + (o.w * TS - fr.w) / 2, y: o.wall ? o.y * TS : (o.y + o.h) * TS - fr.h };
  }
  /** Berghain's floor: two checkered neon frames on the beat, a colour wave of light across the tiles that pulses with the beat, a sweeping spotlight, and a hotter glow under dancers. */
  private drawDanceFloor(ctx: CanvasRenderingContext2D, poses: Map<string, Pose>) {
    const now = Date.now(), beat = danceBeat(now), ph = dancePhase(now), pulse = Math.pow(1 - ph, 2);
    const COLORS = ['255,94,200', '94,240,255', '248,224,112', '154,255,122'];
    for (const o of MAP.objects) {
      if (o.type !== 'dance_floor') continue;
      const name = `dance_floor_${beat % 2}`, fr = this.f(name) ?? this.f(o.type);
      if (fr) this.blit(ctx, this.f(name) ? name : o.type, o.x * TS, (o.y + o.h) * TS - fr.h);
      const dancing = new Set<string>();
      for (const u of this.store.users.values()) {
        const p = poses.get(u.id);
        if (!p || p.walking || !u.effects?.some(e => e.kind === 'dance') || p.tile.x < o.x || p.tile.x >= o.x + o.w || p.tile.y < o.y || p.tile.y >= o.y + o.h) continue;
        dancing.add(`${p.tile.x},${p.tile.y}`);
      }
      const sweep = (now / 1500) % (o.w + 2) - 1; // a spotlight crossing the floor left to right
      for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) {
        const wave = COLORS[(beat + (x - o.x) + (y - o.y)) % COLORS.length];
        ctx.fillStyle = `rgba(${wave},${(0.1 + pulse * 0.22).toFixed(2)})`; // the whole floor throbs
        ctx.fillRect(x * TS, y * TS, TS, TS);
        if (dancing.has(`${x},${y}`)) {
          ctx.fillStyle = `rgba(${COLORS[(beat + x + y) % 2]},${(0.3 + pulse * 0.3).toFixed(2)})`;
          ctx.fillRect(x * TS, y * TS, TS, TS);
          ctx.fillStyle = 'rgba(255,255,255,0.55)'; // bright rim on the beat
          if (ph < 0.2) { ctx.fillRect(x * TS, y * TS, TS, 1); ctx.fillRect(x * TS, (y + 1) * TS - 1, TS, 1); ctx.fillRect(x * TS, y * TS, 1, TS); ctx.fillRect((x + 1) * TS - 1, y * TS, 1, TS); }
        }
        const near = 1 - Math.min(1, Math.abs(x - o.x + 0.5 - sweep));
        if (near > 0) { ctx.fillStyle = `rgba(255,255,255,${(near * 0.16).toFixed(2)})`; ctx.fillRect(x * TS, y * TS, TS, TS); }
      }
    }
  }
  /** The world clocks' hands, from the real time in each one's zone. */
  private drawClockHands(ctx: CanvasRenderingContext2D) {
    for (const o of MAP.objects) {
      if (o.use?.kind !== 'clock') continue;
      const s = this.sprite(o); if (!s) continue;
      // e-ink: HH:MM in gray 3x5 pixel digits on the off-white panel (the sprite is 24 wide, 22 of it screen)
      const { h, m } = zoneHM(o.use.tz), cx = s.x + s.fr.w / 2;
      const digits = [h / 10 | 0, h % 10, m / 10 | 0, m % 10], colon = true; // e-ink doesn't blink
      ctx.fillStyle = '#55554f';
      let dx = s.x + 4;
      digits.forEach((d, i) => {
        if (i === 2) { if (colon) { ctx.fillRect(dx + 1, s.y + 6, 1, 1); ctx.fillRect(dx + 1, s.y + 8, 1, 1); } dx += 3; }
        DIGITS[d].forEach((row, y) => { for (let x = 0; x < 3; x++) if (row & (4 >> x)) ctx.fillRect(dx + x, s.y + 5 + y, 1, 1); });
        dx += 4;
      });
      ctx.font = 'bold 4px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; // the zone's name under the face
      ctx.fillStyle = 'rgba(40,20,20,0.7)'; ctx.fillText(o.use.label, cx + 0.3, s.y + 15.3);
      ctx.fillStyle = '#ffe9c4'; ctx.fillText(o.use.label, cx, s.y + 15);
    }
  }
  private drawItem(ctx: CanvasRenderingContext2D, o: Item) {
    if (o.color) return this.drawRug(ctx, o as Rug);
    const s = this.sprite(o); if (s) this.blit(ctx, s.name, s.x, s.y);
    if (s && o.type === 'out_of_office_sign') drawBeachSign(ctx, s.x, s.y);
  }

  // ---------- layout ----------
  private resize() {
    this.lastInput = performance.now(); // redraw promptly at the new size
    const parent = this.canvas.parentElement!;
    const w = parent.clientWidth, h = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.dpr) { // moved to a screen with other density: keep the same css size
      this.targetPx *= dpr / this.dpr; this.prevPx *= dpr / this.dpr; this.dpr = dpr;
    }
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    // zoom levels are whole device pixels per art pixel: crisp at every step, and on Retina that includes 1.5x, 2.5x…
    // a phone can't fit the floor even at 1: then the overview is a smoothed fraction, the one level that isn't crisp
    const fit = Math.min(this.canvas.width / (this.area.w * TS), this.canvas.height / (this.area.h * TS));
    this.minPx = fit < 1 ? fit : Math.floor(fit);
    this.maxPx = Math.max(this.minPx, Math.round(4 * dpr));
    this.px = this.targetPx = this.clampPx(this.targetPx || this.savedPx());
    this.glide = null;
    this.layoutView();
    this.cam = this.clampCam(this.cam.x, this.cam.y);
    this.onZoom?.();
  }
  private layoutView() { this.viewW = this.canvas.width / this.px; this.viewH = this.canvas.height / this.px; }
  private clampPx(px: number) { return Math.max(this.minPx, Math.min(this.maxPx, px < 1 ? this.minPx : Math.round(px))); }
  /** A comfortable level: 2-4 css pixels per art pixel, as big as the floor allows. */
  private defaultPx() {
    const fit = Math.floor(Math.min(this.canvas.width / (this.area.w * TS), this.canvas.height / (this.area.h * TS)) / this.dpr);
    return this.clampPx(Math.max(2, Math.min(4, fit)) * this.dpr);
  }
  private savedPx() {
    try { const s = Number(localStorage.getItem('deck.zoom')); if (s > 0) return s * this.dpr; } catch { /* default */ }
    return this.defaultPx();
  }
  private backPx() { return this.prevPx > this.minPx ? this.prevPx : Math.max(this.defaultPx(), this.minPx + 1); }
  private step() { return Math.max(1, Math.round(this.dpr / 2)); }
  /** Zoomed all the way out and the floor is smaller than a comfortable size: room tags show. */
  get overview() { return this.targetPx === this.minPx && this.minPx < this.defaultPx(); }
  /** So small that a tap zooms in rather than walking you somewhere. */
  get tapZooms() { return this.overview && this.minPx / this.dpr < 1.5; }
  get zoom() { return { scale: this.targetPx / this.dpr, overview: this.overview, canIn: this.targetPx < this.maxPx, canOut: this.targetPx > this.minPx }; }
  zoomIn() { this.zoomTo(this.targetPx + this.step()); }
  zoomOut() { this.zoomTo(this.targetPx - this.step()); }
  resetZoom() { this.zoomTo(this.defaultPx()); }
  toggleOverview() { this.zoomTo(this.overview ? this.backPx() : this.minPx); }
  /** css pixels per art pixel (debug/screenshots). */
  setZoom(scale: number) { this.zoomTo(scale * this.dpr); }
  /**
   * Glide to a level, keeping one point still: the given screen point (device px), or me while the camera follows me.
   * With a world point too, that point ends up at the screen point.
   */
  private zoomTo(px: number, at?: { sx: number; sy: number }, world?: { wx: number; wy: number }) {
    px = this.clampPx(px);
    if (px === this.targetPx && !world) return;
    if (this.targetPx > this.minPx) this.prevPx = this.targetPx;
    const me = !this.manualCam && this.store.users.get(this.store.me);
    const mp = me ? this.store.pose(me) : null;
    const s = at ?? (mp ? { sx: (mp.x * TS + 8 - this.cam.x) * this.px, sy: (mp.y * TS - this.cam.y) * this.px } : { sx: this.canvas.width / 2, sy: this.canvas.height / 2 });
    const w = world ?? { wx: this.cam.x + s.sx / this.px, wy: this.cam.y + s.sy / this.px };
    this.glide = { from: this.px, at: performance.now(), ...s, ...w };
    this.targetPx = px;
    if (px > this.minPx || !this.overview) try { localStorage.setItem('deck.zoom', String(px / this.dpr)); } catch { /* ignore */ }
    this.onZoom?.();
  }
  /** Device-pixel point in the canvas under a pointer. */
  private devicePoint(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect(), k = this.canvas.width / r.width;
    return { sx: (e.clientX - r.left) * k, sy: (e.clientY - r.top) * k };
  }
  private clampCam(x: number, y: number) {
    const r = this.area, w = r.w * TS, h = r.h * TS, left = r.x * TS, top = r.y * TS;
    const cx = w <= this.viewW ? left - (this.viewW - w) / 2 : Math.max(left, Math.min(left + w - this.viewW, x));
    const cy = h <= this.viewH ? top - (this.viewH - h) / 2 : Math.max(top, Math.min(top + h - this.viewH, y));
    return { x: cx, y: cy };
  }
  private toWorld(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / r.width;
    return { x: ((e.clientX - r.left) * dpr) / this.px + this.cam.x, y: ((e.clientY - r.top) * dpr) / this.px + this.cam.y };
  }

  private falling() {
    const me = this.store.users.get(this.store.me);
    return me && underground(me) ? this.store.dungeonFx.find(f => f.user.id === me.id && f.kind === 'fall' && performance.now() - f.at < 900) : undefined;
  }
  private clearAreaInput() {
    this.stopKeys(); this.manualCam = false; this.hoverUser = this.hoverObject = this.hoverTile = this.hoverPlant = this.hoverCup = null;
    this.selected = null; this.onPick?.(null); this.setEditing(false);
    this.drag = this.pinch = this.gesture = null; this.pointers.clear(); this.wheelAcc = 0;
    this.canvas.style.cursor = 'default';
  }
  private syncArea() {
    const me = this.store.users.get(this.store.me), down = !!me && underground(me);
    const changed = down !== this.actualDown;
    if (changed) { this.actualDown = down; this.clearAreaInput(); }
    const showDungeon = down && !this.falling();
    const area = showDungeon && MAP.dungeon ? MAP.dungeon.rect : MAP.office;
    if (area === this.area && !(changed && !this.falling())) return;
    this.area = area; this.areaDown = showDungeon;
    this.clearAreaInput(); this.targetPx = this.prevPx = 0; this.resize();
    if (me) {
      const p = this.store.pose(me);
      this.cam = this.clampCam(p.x * TS + 8 - this.viewW / 2, p.y * TS - this.viewH / 2);
    }
    this.snapped = true;
  }
  private inArea(t: Tile) {
    const r = this.area;
    return t.x >= r.x && t.y >= r.y && t.x < r.x + r.w && t.y < r.y + r.h;
  }
  /** Match the server's mid-walk starting tile (the tile we're entering). */
  private routeStart(u: ClientUser) {
    const prev = u.prev && this.store.now() < (u.move?.startedAt ?? 0) ? u.prev : null;
    return prev ? sampleMove(prev.path, prev.startedAt, this.store.now(), prev.ms)?.next ?? u.tile
      : u.move && u.path ? sampleMove(u.path, u.move.startedAt, this.store.now(), u.move.ms)?.next ?? u.tile : u.tile;
  }
  private canWalk(t: Tile) {
    if (this.falling() || !this.inArea(t) || !isWalkable(MAP, t.x, t.y)) return false;
    if (!this.store.sysadmin && adminOnly(MAP, t.x, t.y)) return false; // the server would refuse it too
    if (!this.areaDown) return !this.myInstance() || inMeetingRoom(t.x, t.y);
    const me = this.store.users.get(this.store.me), seen = this.store.dungeon?.seen;
    if (!me || !seen) return false;
    const path = pathTo(MAP, this.routeStart(me), t);
    return path.length > 0 && path.every(p => seen.has(p.y * MAP.width + p.x));
  }
  private clickTarget(t: Tile) {
    const d = MAP.dungeon;
    const target = this.areaDown && d && t.x === d.door.x && t.y === d.door.y ? d.doorFront : t;
    return this.canWalk(target) ? target : null;
  }
  private keyDirection(key: string): [number, number] | undefined {
    return ({ arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] } as Record<string, [number, number]>)[key.toLowerCase()];
  }
  private stopKeys = () => { this.held.clear(); this.stepPending = null; };
  private onKeyUp = (e: KeyboardEvent) => { this.held.delete(e.key.toLowerCase()); };
  private keyboardStep() {
    if (!this.areaDown || !this.held.size || this.falling() || !this.store.connected) return;
    if (document.activeElement?.closest('input, textarea, select, [contenteditable]')) return this.stopKeys();
    const me = this.store.users.get(this.store.me); if (!me) return;
    if (this.store.driving) { // arrow keys steer the car, not me
      const now = performance.now(), [kx, ky] = [...this.held.values()].at(-1)!;
      if (now - this.lastCarKey < 110) return;
      this.lastCarKey = now; this.store.carDir(kx < 0 ? 'left' : kx > 0 ? 'right' : ky < 0 ? 'up' : 'down');
      return;
    }
    if (this.stepPending) {
      if (me.move?.to.x === this.stepPending.to.x && me.move.to.y === this.stepPending.to.y && me.move.startedAt >= this.stepPending.at - 100) this.stepPending = null;
      else if (this.store.now() - this.stepPending.at < WALK_MS_PER_TILE * 2) return;
      else this.stepPending = null;
    }
    if (me.move && me.path && me.move.startedAt + pathDuration(me.path, me.move.ms) - this.store.now() > 60) return;
    const [dx, dy] = [...this.held.values()].at(-1)!, from = me.move?.to ?? me.tile;
    const to = { x: from.x + dx, y: from.y + dy };
    if (!this.inArea(to) || !isWalkable(MAP, to.x, to.y)) return;
    this.stepPending = { to, at: this.store.now() };
    this.manualCam = false; this.onPick?.(null); this.store.moveTo(to);
  }

  private drawDungeon(ms: number) {
    const d = MAP.dungeon; if (!d) return;
    const ctx = this.ctx;
    if (this.store.dungeonOpening) this.blit(ctx, 'dungeon_door_open', d.door.x * TS, d.door.y * TS);
    for (const t of d.torches) this.blit(ctx, `torch_${Math.floor(ms / 160 + t.x + t.y) % 3}`, t.x * TS, t.y * TS);
    const key = this.store.dungeon?.key;
    if (key && this.dungeonView.canSee(key)) {
      this.blit(ctx, 'key', key.x * TS, key.y * TS);
      const phase = (ms / 1200) % 1;
      if (phase < .35) {
        const x = key.x * TS + 11, y = key.y * TS + 5, size = phase < .17 ? 2 : 1;
        ctx.fillStyle = '#fff4bb'; ctx.fillRect(x - size, y, size * 2 + 1, 1); ctx.fillRect(x, y - size, 1, size * 2 + 1);
      }
    }
  }
  private drawDungeonFx(fx: DungeonFx, ms: number) {
    const ctx = this.ctx, age = ms - fx.at, duration = fx.kind === 'fall' ? 500 : 650, f = Math.min(1, age / duration);
    const x = fx.tile.x * TS, y = fx.tile.y * TS;
    if (fx.kind === 'climb' && MAP.dungeon && fx.tile.x === MAP.dungeon.hatch.x && fx.tile.y === MAP.dungeon.hatch.y) this.blit(ctx, 'hatch_open', x, y);
    ctx.save();
    if (fx.kind !== 'land') { ctx.beginPath(); ctx.rect(x - 2, y - 24, TS + 4, 24 + TS / 2); ctx.clip(); }
    const dy = fx.kind === 'fall' ? f * 28 : fx.kind === 'land' ? -((1 - f) ** 2) * 32 : (1 - f) * 28;
    ctx.translate(0, dy);
    this.drawSprite(fx.user, { ...fx.tile, tile: fx.tile, dir: fx.user.dir, walking: false }, ms);
    ctx.restore();
    if (f > .3) for (let i = 0; i < 5; i++) {
      ctx.globalAlpha = (1 - f) * .7; ctx.fillStyle = '#b5a08a';
      ctx.fillRect(x + 7 + Math.cos(i * 2.4) * f * 12, y + 9 + Math.sin(i * 2.4) * f * 5 - f * 3, 2, 2);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- input ----------
  /** In a meeting's own room you see only its people; in the office, nobody who's in one. */
  private visible(u: ClientUser | undefined) {
    if (!u || !onMap(u) || u.instance !== this.myInstance()) return false;
    if (!this.areaDown && this.inStall(u.id) && !this.store.pose(u).walking) return false; // behind the stall door (their head peeks over it)
    if (u.id !== this.store.me && this.atmosphereHides(u)) return false;
    return !this.areaDown || u.id === this.store.me || !!this.store.dungeon && this.dungeonView.canSee(this.store.pose(u).tile);
  }

  // ---------- atmosphere ----------
  private clubRect = MAP.rooms.find(r => r.id === 'berghain')?.rect; // found by id: the room moves between releases
  /** Standing in the club (or its doorways on the sides): the roof is off. */
  private inClub(t: Tile) { const c = this.clubRect; return !!c && inRect({ x: c.x - 1, y: c.y, w: c.w + 2, h: c.h }, t.x, t.y); }
  /** Under Berghain's roof while I'm outside, or swallowed by fog: not drawn. */
  private atmosphereHides(u: ClientUser) {
    if (this.areaDown) return false;
    const club = this.clubRect;
    if (club && this.roofAlpha > 0.5 && inRect(club, this.store.pose(u).tile.x, this.store.pose(u).tile.y)) return true;
    if (this.store.sky === 'fog' && !this.tapZooms) {
      const me = this.store.users.get(this.store.me);
      if (me && me.instance === u.instance) return fogHides(MAP, 'fog', this.store.pose(me).tile, this.store.pose(u).tile);
    }
    return false;
  }
  private windowOpen(o: MapObject) { return o.use?.kind === 'toggle' && this.isOn(o); }
  /** Rain is falling on something in view and the page is being used: it animates (and asks for ~30 fps). */
  private rainLive(ms: number) {
    if (this.store.sky !== 'rain' || this.areaDown || this.myInstance() || this.px < 1) return false;
    if (!document.hasFocus() || ms - this.lastInput > 10 * 60_000) return false; // idle or in the background: the rain stands still
    return this.fx.skyInView(this.vis) || this.windows.some(o => this.windowOpen(o) && this.onScreen(o.x * TS, o.y * TS, o.w * TS, o.h * TS));
  }
  private roofMoving = false;
  private windowSig = '';
  private drawRoof(ctx: CanvasRenderingContext2D) {
    const c = this.clubRect; if (!c || this.roofAlpha <= 0.01 || !this.onScreen(c.x * TS, c.y * TS, c.w * TS, c.h * TS)) return;
    const x = c.x * TS, y = c.y * TS, w = c.w * TS, h = c.h * TS;
    ctx.save(); ctx.globalAlpha = Math.min(1, this.roofAlpha);
    ctx.fillStyle = '#3b3340'; ctx.fillRect(x, y, w, h);
    for (let row = 0; row * 6 < h; row++) { // shingles
      ctx.fillStyle = row % 2 ? '#443a49' : '#352d3a'; ctx.fillRect(x, y + row * 6 + 4, w, 2);
      ctx.fillStyle = '#2b2430'; for (let col = (row % 2) * 8; col < w; col += 16) ctx.fillRect(x + col, y + row * 6, 1, 4);
    }
    ctx.fillStyle = '#5c4b63'; ctx.fillRect(x, y, w, 2); ctx.fillRect(x, y + h - 2, w, 2); ctx.fillRect(x, y, 2, h); ctx.fillRect(x + w - 2, y, 2, h); // eaves
    const label = 'BERGHAIN', tw = textWidth(label), lx = Math.round(x + w / 2 - tw / 2), ly = Math.round(y + h / 2 - 3);
    ctx.fillStyle = 'rgba(255,79,168,0.25)'; ctx.fillRect(lx - 3, ly - 3, tw + 6, 13); // neon halo
    drawText(ctx, label, lx, ly, '#ff7ac4');
    ctx.restore();
  }
  /** How many pixels a hat stands above the head: the umbrella opens above it, never through it. */
  private hatLift(u: ClientUser) {
    const hat = u.effects?.find(e => e.kind === 'hat');
    return hat ? HAT_H[String(hat.data?.style)] ?? 10 : u.look.hat ? 3 : 0;
  }
  private umbrellaSprites = new Map<number, HTMLCanvasElement>();
  /** An open umbrella over the head: a round striped dome with dark ribs and a scalloped rim (cached per colour). The pole is
   *  drawn behind the person (see drawSprite), so it only shows in the gap above a hat. */
  private drawUmbrella(ctx: CanvasRenderingContext2D, u: ClientUser, x: number, top: number) {
    const PAL = [['#d9534f', '#f4978b', '#a23834'], ['#3f7fbf', '#86b8ea', '#2b5688'], ['#e0b13a', '#f8dc7e', '#a8791c'], ['#4f9d6b', '#8dd3a6', '#34704a']];
    const k = hash(u.id) % PAL.length;
    let sprite = this.umbrellaSprites.get(k);
    if (!sprite) {
      const [main, light, dark] = PAL[k], W = 23, C = 11, widths = [5, 11, 15, 19, 21, 23], OUT = '#2a1f26';
      const c = document.createElement('canvas'); c.width = W; c.height = 8;
      const g = c.getContext('2d')!, px = (cx: number, cy: number, col: string) => { g.fillStyle = col; g.fillRect(cx, cy, 1, 1); };
      widths.forEach((w, r) => {
        const x0 = C - (w >> 1);
        for (let i = 0; i < w; i++) {
          const cx = x0 + i, rib = r > 0 && (cx === C || cx === C - 5 || cx === C + 5 || (r < 3 && false)), panel = cx < C - 5 ? 0 : cx < C ? 1 : cx < C + 5 ? 2 : 3;
          px(cx, r, r === 0 || i === 0 || i === w - 1 ? OUT : rib ? dark : panel % 2 ? light : main);
        }
        if (r >= 1 && r <= 3) px(x0 + 2, r, light); // a highlight on the left shoulder
      });
      for (let cx = 0; cx < W; cx++) px(cx, 6, cx % 4 === 1 || cx % 4 === 2 ? (cx < C - 5 || (cx > C && cx < C + 5) ? main : light) : OUT); // scallops: a coloured flap between dark notches
      for (let cx = 0; cx < W; cx++) if (cx % 4 === 1 || cx % 4 === 2) px(cx, 7, OUT);
      this.umbrellaSprites.set(k, sprite = c);
    }
    ctx.drawImage(sprite, x + 8 - 11, top - 6);
  }
  private myInstance() { return this.falling() ? null : this.store.users.get(this.store.me)?.instance ?? null; }
  private userAt(wx: number, wy: number): string | null {
    const t = this.store.now();
    let best: { id: string; base: number } | null = null;
    for (const u of this.store.users.values()) {
      if (!this.visible(u)) continue;
      const p = this.store.pose(u, t);
      const sx = p.x * TS, sy = p.y * TS + TS - 24;
      const lie = !p.walking && seatAt(MAP, p.tile.x, p.tile.y) && MAP.objects.find(o => o.lie && o.y === p.tile.y && o.x + Math.floor((o.w - 1) / 2) === p.tile.x);
      const hit = lie ? Math.abs(wx - (lie.x + lie.w / 2) * TS) <= 12 && wy >= lie.y * TS && wy < lie.y * TS + TS
        : wx >= sx + 2 && wx < sx + 14 && wy >= sy && wy < sy + 26;
      if (hit) {
        const base = sy + 24;
        if (!best || base > best.base) best = { id: u.id, base };
      }
    }
    return best?.id ?? null;
  }
  /** The sofa seat you clicked, or the nearest free one on that sofa if someone's sitting there. */
  private freeSeat(o: MapObject, x: number) {
    if (o.lie) return { x: o.x + Math.floor((o.w - 1) / 2), y: o.y };
    const taken = new Set([...this.store.users.values()].filter(u => onMap(u) && u.id !== this.store.me).map(u => `${u.tile.x},${u.tile.y}`));
    const seats = Array.from({ length: o.w }, (_, i) => ({ x: o.x + i, y: o.y })).filter(t => !taken.has(`${t.x},${t.y}`));
    seats.sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x));
    return seats[0] ?? { x: Math.max(o.x, Math.min(o.x + o.w - 1, x)), y: o.y };
  }
  /** Sprite of an object you can use under this point. */
  /** Holding a drink with a cup (full or empty) over a free table tile in the office: that's where it can go. */
  private cupTarget(t: Tile): Tile | null {
    const me = this.store.users.get(this.store.me), cup = emptyDrink(me?.holding) ?? me?.holding;
    if (!me || !cup || !CUP_ITEMS.includes(cup) || me.instance || this.areaDown || !cupTableAt(MAP.objects, t)) return null;
    return this.store.cups.some(c => c.tile.x === t.x && c.tile.y === t.y) ? null : t;
  }
  /** Holding food over a chair at a picnic table: that's where lunch happens. */
  private lunchChair(t: Tile): MapObject | null {
    const me = this.store.users.get(this.store.me);
    if (!me?.holding || !FOOD_ITEMS.includes(me.holding) || me.instance || this.areaDown || !picnicSeat(MAP, t)) return null;
    return MAP.objects.find(o => o.type === 'chair' && o.x === t.x && o.y === t.y) ?? null;
  }
  /** Holding food beside a kitchen table, or on the table itself: eat it standing there (no chair needed). */
  private kitchenEat(t: Tile): Tile | null {
    const me = this.store.users.get(this.store.me);
    if (!me?.holding || !FOOD_ITEMS.includes(me.holding) || me.instance || this.areaDown) return null;
    const onTable = MAP.objects.some(o => KITCHEN_TABLES.includes(o.type) && t.x >= o.x && t.x < o.x + o.w && t.y >= o.y && t.y < o.y + o.h && roomAt(MAP, o.x, o.y)?.type === 'coffee');
    return onTable || kitchenSpot(MAP, t) ? t : null;
  }
  /** What a click at this point can use: inside a meeting's room only the wall screen (it has a show per room). */
  private pickable(wx: number, wy: number, inside: string | null): MapObject | null {
    const o = this.objectAt(wx, wy);
    return o && (!inside || o.use?.kind === 'presentation') ? o : null;
  }
  private objectAt(wx: number, wy: number): MapObject | null {
    let best: MapObject | null = null;
    for (const o of this.interactive) {
      const fr = this.f(o.type); if (!fr) continue;
      const x = o.x * TS + (o.w * TS - fr.w) / 2, y = (o.y + o.h) * TS - fr.h;
      const hit = o.lie ? wx >= o.x * TS && wx < (o.x + o.w) * TS && wy >= o.y * TS && wy < (o.y + o.h) * TS
        : wx >= x + 1 && wx < x + fr.w - 1 && wy >= y + 1 && wy < y + fr.h;
      if (hit && (!best || o.y + o.h > best.y + best.h)) best = o;
    }
    return best;
  }
  private onDown = (e: PointerEvent) => {
    // A cancelled pointerdown means no compatibility mouse events after a touch: iOS would otherwise send a click
    // at the same spot a moment later, landing on whatever the tap just opened (a panel's backdrop closes on it).
    if (e.pointerType === 'touch') e.preventDefault();
    if (this.falling()) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer (tests) */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) { // second finger: a pinch, never a tap or a drag
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, px: this.targetPx, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.drag = null; this.manualCam = true;
      return;
    }
    if (this.pointers.size > 2) return;
    if (this.editing && !this.placing && !this.tapZooms) { // grab a piece of furniture (the floor still pans)
      const w = this.toWorld(e), it = this.itemAt(w.x, w.y);
      if (it && !(it.type && FIXED_TYPES.has(it.type))) {
        this.editDrag = { item: { ...it }, gx: Math.floor(w.x / TS) - it.x, gy: Math.floor(w.y / TS) - it.y, x: it.x, y: it.y, moved: false };
        return;
      }
    }
    this.drag = { x: e.clientX, y: e.clientY, camX: this.cam.x, camY: this.cam.y, moved: false };
  };
  private onPinch() {
    const [a, b] = [...this.pointers.values()], pin = this.pinch!;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const at = this.devicePoint({ clientX: mid.x, clientY: mid.y });
    const k = this.canvas.width / this.canvas.getBoundingClientRect().width;
    // the floor under the fingers moves with them
    if (this.glide) { this.glide.sx = at.sx; this.glide.sy = at.sy; }
    else this.cam = this.clampCam(this.cam.x - ((mid.x - pin.x) * k) / this.px, this.cam.y - ((mid.y - pin.y) * k) / this.px);
    pin.x = mid.x; pin.y = mid.y;
    this.zoomTo(pin.px * (Math.hypot(a.x - b.x, a.y - b.y) / pin.dist), at);
  }
  private onCancel = (e: PointerEvent) => { this.pointers.delete(e.pointerId); if (this.pointers.size < 2) this.pinch = null; this.drag = null; this.editDrag = null; this.ghost = null; };
  private onLeave = (e: PointerEvent) => { this.hoverUser = null; this.hoverObject = null; this.hoverTile = null; if (!this.pointers.has(e.pointerId)) this.drag = null; };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { // a trackpad pinch arrives as ctrl+wheel; ⌘/ctrl + mouse wheel too
      if (this.gesture && performance.now() - this.gesture.at < 300) return; // Safari sent it as a gesture already
      this.wheelAcc += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      if (Math.abs(this.wheelAcc) < 40) return;
      this.manualCam = true;
      this.zoomTo(this.targetPx + (this.wheelAcc < 0 ? 1 : -1) * this.step(), this.devicePoint(e));
      this.wheelAcc = 0;
      return;
    }
    // two-finger scroll (or a plain wheel) pans, like a design tool
    const k = (this.canvas.width / this.canvas.getBoundingClientRect().width) * (e.deltaMode === 1 ? 16 : 1);
    this.manualCam = true;
    if (this.glide) { this.glide.wx += (e.deltaX * k) / this.px; this.glide.wy += (e.deltaY * k) / this.px; }
    else this.cam = this.clampCam(this.cam.x + (e.deltaX * k) / this.px, this.cam.y + (e.deltaY * k) / this.px);
  };
  /** Safari (and the Mac app's web view) report trackpad and iOS pinches as gesture events, with a running scale. */
  private onGesture = (ev: Event) => {
    ev.preventDefault(); // also stops iOS zooming the whole page
    if (this.pointers.size >= 2) return; // touch pinch: pointer events already handle it
    const e = ev as Event & { scale: number; clientX: number; clientY: number };
    if (ev.type === 'gesturestart' || !this.gesture) this.gesture = { px: this.targetPx, at: 0 };
    this.gesture.at = performance.now();
    this.manualCam = true;
    this.zoomTo(this.gesture.px * e.scale, this.devicePoint(e));
  };
  private onKey = (e: KeyboardEvent) => {
    if (this.store.seat || this.store.gameOpen || this.store.table) return;
    const t = e.target;
    if (this.falling()) return;
    if (e.metaKey || e.ctrlKey || e.altKey || (t instanceof Element && t.closest('input, textarea, select, [contenteditable]'))) return;
    const direction = this.keyDirection(e.key);
    if (this.areaDown && direction) {
      e.preventDefault();
      if (!e.repeat) this.held.set(e.key.toLowerCase(), direction);
      this.keyboardStep(); return;
    }
    if (this.editing && this.onEditKey(e)) return e.preventDefault();
    if (e.key === '+' || e.key === '=') this.zoomIn();
    else if (e.key === '-' || e.key === '_') this.zoomOut();
    else if (e.key === '0') this.resetZoom();
    else if (e.key === 'm' || e.key === 'M') this.toggleOverview();
    else return;
    e.preventDefault();
  };
  /** Edit mode keys: arrows nudge (shift+arrows resize a rug), R turns a chair, Delete removes, Esc lets go. */
  private onEditKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && (this.placing || this.editSel)) { if (this.placing) this.setPlacing(null); else this.select(null); return true; }
    const sel = this.editSel ? this.item(this.editSel) : undefined;
    if (!sel) return false;
    const step = ({ ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[e.key];
    if (step && e.shiftKey && sel.color) this.store.edit({ op: 'rug', id: sel.id, w: sel.w + step[0], h: sel.h + step[1] });
    else if (step) this.store.edit({ op: 'move', id: sel.id, x: sel.x + step[0], y: sel.y + step[1] });
    else if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey) { if (!SEAT_TYPES.has(sel.type ?? '')) return false; this.store.edit({ op: 'rotate', id: sel.id }); }
    else if (e.key === 'Delete' || e.key === 'Backspace') this.store.edit({ op: 'remove', id: sel.id });
    else return false;
    return true;
  }
  private onMove = (e: PointerEvent) => {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size >= 2) return this.onPinch();
    if (this.drag) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) this.drag.moved = true;
      if (this.drag.moved) {
        const k = this.canvas.width / this.canvas.getBoundingClientRect().width / this.px;
        this.manualCam = true;
        this.cam = this.clampCam(this.drag.camX - dx * k, this.drag.camY - dy * k);
      }
    }
    const w = this.toWorld(e);
    if (this.editing) return this.onEditMove(w);
    this.hoverUser = this.userAt(w.x, w.y);
    const inside = this.myInstance();
    this.hoverCup = this.hoverUser || inside || this.areaDown ? null : this.critters.cupAt(w.x, w.y);
    this.hoverObject = this.hoverUser || this.hoverCup ? null : this.pickable(w.x, w.y, inside);
    this.hoverPlant = this.hoverUser || this.hoverObject || inside ? null : this.plantAt(w.x, w.y);
    const tx = Math.floor(w.x / TS), ty = Math.floor(w.y / TS);
    this.hoverTile = this.clickTarget({ x: tx, y: ty });
    this.hoverCritter = this.hoverUser || this.hoverObject || inside || this.areaDown ? null : this.critters.at(w.x, w.y, this.store.now());
    this.cupTile = this.hoverUser || this.hoverObject || this.hoverCup ? null : this.cupTarget({ x: tx, y: ty });
    this.lunchTile = this.hoverUser || this.hoverObject || inside ? null : this.lunchChair({ x: tx, y: ty }) ? { x: tx, y: ty } : this.kitchenEat({ x: tx, y: ty });
    this.canvas.style.cursor = this.tapZooms ? 'zoom-in' : this.hoverUser || this.hoverObject || this.hoverCup || this.cupTile || this.lunchTile || this.hoverCritter?.id || (this.hoverPlant && this.nearDesk(this.hoverPlant.u)) ? 'pointer' : this.hoverTile ? 'crosshair' : 'default';
  };
  private plantAt(wx: number, wy: number) { return this.plants.find(p => wx >= p.x - 5 && wx < p.x + 5 && wy >= p.y - 18 && wy < p.y) ?? null; }
  /** Close enough to a person's desk (the server uses the same 4 tiles) for its plant to open their storage. */
  private nearDesk(owner: ClientUser) {
    const me = this.store.users.get(this.store.me), d = owner.homeDesk;
    return !!me && !!d && onMap(me) && Math.max(Math.abs(me.tile.x - d.x), Math.abs(me.tile.y - d.y)) <= 4;
  }
  private onEditMove(w: { x: number; y: number }) {
    const tx = Math.floor(w.x / TS), ty = Math.floor(w.y / TS), d = this.editDrag;
    if (d) {
      const x = tx - d.gx, y = ty - d.gy;
      if (x !== d.x || y !== d.y) {
        d.x = x; d.y = y; d.moved = true;
        this.ghost = { item: { ...d.item, x, y }, problem: this.check({ op: 'move', id: d.item.id, x, y }) };
      }
    } else if (this.placing && !this.tapZooms) {
      const it = this.placeItem(tx, ty);
      if (!this.ghost || this.ghost.item.x !== it.x || this.ghost.item.y !== it.y || this.ghost.item.type !== it.type) this.ghost = { item: it, problem: this.check(this.placeEdit(it)) };
    }
    this.editHover = this.placing || d ? null : this.itemAt(w.x, w.y);
    this.canvas.style.cursor = this.tapZooms ? 'zoom-in' : d ? 'grabbing' : this.placing ? 'copy' : this.editHover ? 'grab' : 'default';
  }
  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; return; }
    const ed = this.editDrag; this.editDrag = null;
    if (ed) { // dropped (or just clicked): select it, and move it if it went somewhere
      this.ghost = null;
      if (ed.moved) this.store.edit({ op: 'move', id: ed.item.id, x: ed.x, y: ed.y });
      return this.select(ed.item.id);
    }
    const d = this.drag; this.drag = null;
    if (!d || d.moved) return;
    const w = this.toWorld(e);
    if (this.tapZooms) { // overview: a tap zooms in right there
      this.manualCam = true; this.onPick?.(null);
      return this.zoomTo(this.backPx(), this.devicePoint(e), { wx: w.x, wy: w.y });
    }
    if (this.editing) {
      if (this.placing) this.store.edit(this.placeEdit(this.placeItem(Math.floor(w.x / TS), Math.floor(w.y / TS))));
      else this.select(this.itemAt(w.x, w.y)?.id ?? null);
      return;
    }
    if (this.store.driving) return this.store.carGo({ x: Math.floor(w.x / TS), y: Math.floor(w.y / TS) }); // the controller is in my hands: the floor steers the car
    const hit = this.userAt(w.x, w.y);
    if (hit) return this.onPick?.({ kind: 'user', id: hit });
    const inside = this.myInstance();
    const plant = inside || this.areaDown ? null : this.plantAt(w.x, w.y);
    if (plant && this.nearDesk(plant.u)) { this.onPick?.(null); this.manualCam = false; return this.store.openStorage(plant.u.id); } // the desk plant is the storage
    const critter = inside || this.areaDown ? null : this.critters.at(w.x, w.y, this.store.now());
    if (critter?.id) { this.onPick?.(null); this.manualCam = false; return this.store.pet(critter.id); }
    const cupHit = inside || this.areaDown ? null : this.critters.cupAt(w.x, w.y);
    if (cupHit) { this.onPick?.(null); this.manualCam = false; return this.store.takeCup(cupHit.id); }
    const obj = this.pickable(w.x, w.y, inside);
    if (obj?.sit || obj?.lie) { this.onPick?.(null); this.manualCam = false; return this.store.moveTo(this.freeSeat(obj, Math.floor(w.x / TS))); }
    if (obj?.sound && obj.use?.kind !== 'jukebox') return this.onPick?.(null);
    if (obj) return this.onPick?.({ kind: 'object', id: obj.id });
    this.onPick?.(null);
    const tx = Math.floor(w.x / TS), ty = Math.floor(w.y / TS);
    const cup = this.cupTarget({ x: tx, y: ty });
    if (cup) { this.manualCam = false; return this.store.putCup(cup); }
    const chair = this.lunchChair({ x: tx, y: ty });
    if (chair) { this.manualCam = false; return this.onPick?.({ kind: 'object', id: chair.id }); }
    const eat = this.kitchenEat({ x: tx, y: ty });
    if (eat) { this.manualCam = false; return this.store.lunch(eat, false); }
    const target = this.clickTarget({ x: tx, y: ty });
    if (target) this.walkTo(target);
    else if (!this.store.sysadmin && !this.areaDown && adminOnly(MAP, tx, ty)) this.denyDoor(tx, ty);
  };
  /** A locked room turned me away: its door shakes and says why. */
  private denyDoor(tx: number, ty: number) {
    const room = roomAt(MAP, tx, ty); if (!room) return;
    this.deniedAt.set(room.id, performance.now());
    this.store.toast({ kind: 'info', text: `🔒 ${room.name}: sysadmins only`, expires: 3000 });
  }

  /** Plants stand on their owner's home desk, or on an Orangery shelf if they have none. On the desk it goes to the
   *  far end from the chair along the edge you sit at (a desk's other end, a shared table's back corner on your side),
   *  pushed to the outer edge so it clears the monitor or laptops. */
  private placePlants(): PlacedPlant[] {
    const out: PlacedPlant[] = [], shelved: ClientUser[] = [];
    for (const u of this.store.users.values()) {
      if (!u.plant) continue;
      const seat = u.homeDesk && seatAt(MAP, u.homeDesk.x, u.homeDesk.y);
      const [dx, dy] = FRONT[seat ? seat.dir : 'up'], fx = (seat?.x ?? 0) + dx, fy = (seat?.y ?? 0) + dy;
      const desk = seat && MAP.objects.find(o => !o.walkable && !o.wall && fx >= o.x && fx < o.x + o.w && fy >= o.y && fy < o.y + o.h);
      if (!seat || !desk) { shelved.push(u); continue; }
      const far = (lo: number, n: number, from: number) => (Math.abs(lo - from) > Math.abs(lo + n - 1 - from) ? lo : lo + n - 1);
      const tx = dx ? fx : far(desk.x, desk.w, seat.x), ty = dy ? fy : far(desk.y, desk.h, seat.y);
      const side = Math.sign(tx + 0.5 - (desk.x + desk.w / 2)) || 1;
      out.push({ u, x: tx * TS + 8 + side * 4, y: ty * TS + (desk.h > 1 ? 11 : 7), base: (desk.y + desk.h) * TS - 0.25 }); // a big table: inside its top edge
    }
    shelved.sort((a, b) => a.id.localeCompare(b.id));
    const slots = this.slots;
    shelved.slice(0, slots.length).forEach((u, i) => out.push({ u, x: slots[i].x * TS + 8, y: slots[i].y * TS + 6, base: (slots[i].y + 1) * TS - 0.25 }));
    return out;
  }

  // ---------- render ----------
  private touched = () => { this.lastInput = performance.now(); };
  /**
   * Render on demand. Redraw gaps by what the floor is doing: ~30 fps (pixel art needs no more) while something moves, animates
   * smoothly (effects, dancing, speech, floating reactions) or the user interacts, ~8 when only ambient loops run (water, blinking
   * racks, breathing: all of them step in 120+ ms), and 2 when the window is out of focus or covered. A hidden tab draws nothing.
   */
  private skipFrame(ms: number) {
    const gap = ms - this.lastDraw;
    if (gap < 30) return true;
    const need = this.cadence(ms);
    if (gap < need - 1) return true;
    this.lastDraw = ms;
    this.stats.push(ms); if (this.stats.length > 600) this.stats.shift();
    return false;
  }
  private cadence(ms: number) {
    if (isCovered()) return 500;
    if (this.glide || this.editing || ms - this.lastInput < 1500 || this.store.version !== this.drawnVersion) return FAST_MS;
    if (ms - this.cadAt > 100) { this.cadAt = ms; this.cadSlow = this.slowCadence(ms); }
    return this.cadSlow;
  }
  private cadAt = -1e9; private cadSlow = 16;
  private slowCadence(ms: number) {
    const now = this.store.now(), users = [...this.store.users.values()];
    const near = (x: number, y: number) => this.onScreen(x * TS - TS, y * TS - TS, 3 * TS, 3 * TS);
    if (this.store.portalFx.some(f => ms - f.at < PORTAL_MS)) return FAST_MS;
    if ([...this.store.carFx.values()].some(f => performance.now() - f.at < 200)) return FAST_MS; // a remote car gliding to its next tile
    if (users.some(u => { if (!u.move) return false; const p = this.store.pose(u, now); return p.walking && this.visible(u) && near(p.x, p.y); })) return FAST_MS;
    if (!this.areaDown && !this.store.users.get(this.store.me)?.instance && [...this.store.creatures.values()].some(c => { if (!c.walk) return false; const p = creaturePose(c, now); return p.walking && near(p.x, p.y); })) return FAST_MS;
    if (this.roofMoving || this.rainLive(ms)) return FAST_MS; // Berghain's roof fading; rain on something in view
    if (this.areaDown || this.store.reactions.length || this.instrumentNotes.length || this.partyOnScreen() || this.store.dungeonFx.some(f => ms - f.at < 700)
      || this.store.objectFx.some(f => performance.now() - f.at < 4000)
      || users.some(u => this.visible(u) && (u.effects?.some(e => e.kind !== 'hat' && e.kind !== 'sewing' && e.kind !== 'driving') || u.speaking))) return FAST_MS; // sewing and driving only step every 300+ ms: the ambient rate is enough
    return document.hasFocus() ? 124 : 499;
  }
  /** A room with its jukebox playing (disco ball, notes, dancers) is in view. */
  private partyOnScreen() {
    return this.parties.some(id => { const r = MAP.rooms.find(r => r.id === id)?.rect; return !!r && this.onScreen(r.x * TS, r.y * TS, r.w * TS, r.h * TS); });
  }
  private stats: number[] = [];
  /** Dev counter: how many frames were drawn in the last `windowMs` (default 10 s). */
  frameStats(windowMs = 10_000) {
    const t = performance.now(), n = this.stats.filter(x => t - x <= windowMs).length;
    return { frames: n, windowMs, perSecond: +(n / (windowMs / 1000)).toFixed(2), cadenceMs: Math.round(this.cadSlow) };
  }
  private drawnVersion = -1;
  private lastFrameMs = 0;
  /** Visible world rect (a tile of margin): anything wholly outside it is not drawn. */
  private vis = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
  private onScreen(x: number, y: number, w: number, h: number) {
    const v = this.vis; return x < v.x1 && x + w > v.x0 && y < v.y1 && y + h > v.y0;
  }
  private frame = (ms: number) => {
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) return;
    if (this.captureResolve) this.lastDraw = -1e9; // a screenshot is waiting: draw now
    if (this.skipFrame(ms)) return;
    this.draw(ms);
    if (this.captureResolve) { // toDataURL must run in the task that drew the frame, or the canvas can read back blank
      const done = this.captureResolve; this.captureResolve = null;
      try { done(this.canvas.toDataURL('image/jpeg', 0.7)); } catch { done(null); }
    }
  };
  private captureResolve: ((url: string | null) => void) | null = null;
  /** The floor as a JPEG data URL (for bug reports); null when the tab is hidden or the canvas can't be read. */
  captureFrame(): Promise<string | null> {
    if (document.hidden) return Promise.resolve(null);
    return new Promise(resolve => { this.captureResolve = resolve; setTimeout(() => { if (this.captureResolve === resolve) { this.captureResolve = null; resolve(null); } }, 2000); });
  }
  private draw(ms: number) {
    const prevMs = this.lastFrameMs; this.lastFrameMs = ms;
    if (this.layoutSeen !== this.store.layoutVersion) this.refreshLayout();
    const wsig = this.windows.map(o => (this.windowOpen(o) ? 1 : 0)).join('');
    if (wsig !== this.windowSig) { this.windowSig = wsig; this.staticLayer = this.buildStatic(); } // a window opened or closed
    this.syncArea(); this.keyboardStep();
    const ctx = this.ctx, t = this.store.now(), now = new Date(), hour = this.devHour ?? now.getHours() + now.getMinutes() / 60; // the viewer's own clock: your evening looks like evening
    const me = this.store.users.get(this.store.me);
    if (this.areaDown && me && this.store.dungeon) {
      const others = [...this.store.users.values()].filter(u => u.id !== me.id && underground(u) && u.presence !== 'offline').map(u => this.store.pose(u, t).tile);
      this.dungeonView.update(this.store.pose(me, t).tile, others, this.store.dungeon.seen);
      if (this.hoverUser && !this.visible(this.store.users.get(this.hoverUser))) this.hoverUser = null;
      if (this.selected?.kind === 'user' && !this.visible(this.store.users.get(this.selected.id))) { this.selected = null; this.onPick?.(null); }
      if (this.hoverTile && !this.canWalk(this.hoverTile)) this.hoverTile = null;
    }
    {
      const mePose = me && this.store.pose(me, t), want = !this.clubRect || this.areaDown || this.editing || me?.instance || !mePose || this.inClub(mePose.tile) ? 0 : 1;
      const dt = Math.min(100, ms - this.roofAt); this.roofAt = ms;
      this.roofAlpha = this.roofAlpha < 0 ? want : this.roofAlpha + Math.max(-dt / 300, Math.min(dt / 300, want - this.roofAlpha)); // eases over 300 ms
      this.roofMoving = Math.abs(want - this.roofAlpha) > 0.001;
      if (this.rainLive(ms)) this.rainClock += Math.min(100, ms - this.rainLastMs);
      this.rainLastMs = ms;
    }
    // admins mid-portal: they stay at the origin until they've stepped in, are gone while the far portal opens, then stand at the destination
    const trips = new Map<string, { fx: PortalFx; age: number }>();
    if (!this.areaDown) for (const fx of this.store.portalFx) if (ms >= fx.at && ms - fx.at < PORTAL_MS) trips.set(fx.userId, { fx, age: ms - fx.at });
    const users = [...this.store.users.values()].filter(u => this.visible(u) && !(trips.has(u.id) && portalStage(trips.get(u.id)!.age).hidden));
    const poses = new Map<string, Pose>(users.map(u => {
      const trip = trips.get(u.id);
      return [u.id, trip && portalStage(trip.age).atFrom ? { x: trip.fx.from.x, y: trip.fx.from.y, dir: 'down', walking: false, tile: trip.fx.from } : this.store.pose(u, t)];
    }));

    if (this.glide) { // zooming: the anchor point stays put while the scale eases to the next crisp level
      const g = this.glide, f = Math.min(1, (performance.now() - g.at) / 140);
      this.px = f >= 1 ? this.targetPx : g.from + (this.targetPx - g.from) * (1 - (1 - f) ** 3);
      if (f >= 1) this.glide = null;
      this.layoutView();
      this.cam = this.clampCam(g.wx - g.sx / this.px, g.wy - g.sy / this.px);
    }
    // camera follows me unless the user dragged
    else if (me && !this.manualCam && (poses.get(me.id) || trips.has(me.id))) {
      const trip = trips.get(me.id); // mid-portal: the camera heads for the far side early
      const p = trip && trip.age >= 700 ? { ...this.store.pose(me, t), x: trip.fx.to.x, y: trip.fx.to.y } : poses.get(me.id) ?? this.store.pose(me, t);
      const target = me.instance && !this.areaDown // a meeting's room: keep the room in the middle
        ? this.clampCam((MEETING.x + MEETING.w / 2) * TS - this.viewW / 2, (MEETING.y + MEETING.h / 2) * TS - this.viewH / 2)
        : this.clampCam(p.x * TS + 8 - this.viewW / 2, p.y * TS - this.viewH / 2);
      const dt = Math.min(100, ms - prevMs), k = this.snapped ? 1 - Math.pow(0.88, dt / 16.7) : 1; this.snapped = true; // 0.12 per 60 fps frame, whatever the frame rate
      this.cam.x += (target.x - this.cam.x) * k; this.cam.y += (target.y - this.cam.y) * k;
    }
    const camX = Math.round(this.cam.x * this.px) / this.px, camY = Math.round(this.cam.y * this.px) / this.px;
    this.vis = { x0: camX - TS, y0: camY - TS, x1: camX + this.viewW + TS, y1: camY + this.viewH + TS };
    this.drawnVersion = this.store.version;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1b1418'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = this.px < 1;
    ctx.setTransform(this.px, 0, 0, this.px, -camX * this.px, -camY * this.px);
    ctx.save();
    ctx.beginPath(); ctx.rect(this.area.x * TS, this.area.y * TS, this.area.w * TS, this.area.h * TS); ctx.clip();
    {
      const a = this.area, v = this.vis;
      const sx = Math.max(a.x * TS, Math.floor(v.x0 / TS) * TS), sy = Math.max(a.y * TS, Math.floor(v.y0 / TS) * TS);
      const ex = Math.min((a.x + a.w) * TS, Math.ceil(v.x1 / TS) * TS), ey = Math.min((a.y + a.h) * TS, Math.ceil(v.y1 / TS) * TS);
      if (ex > sx && ey > sy) ctx.drawImage(this.staticLayer, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
    }
    if (this.areaDown) this.drawDungeon(ms); else { this.drawWater(ctx, t, this.store.sky === 'rain'); this.drawDanceFloor(ctx, poses); this.drawClockHands(ctx); }

    // hover tile + my destination marker
    if (this.hoverTile && !this.hoverUser && !this.tapZooms && !this.editing) {
      ctx.strokeStyle = 'rgba(255,240,200,0.55)'; ctx.lineWidth = 1;
      ctx.strokeRect(this.hoverTile.x * TS + 0.5, this.hoverTile.y * TS + 0.5, TS - 1, TS - 1);
    }
    const myPose = me && poses.get(me.id);
    if (me?.move && myPose?.walking) {
      const bounce = Math.round(Math.sin(ms / 120) * 1.5);
      this.blit(ctx, 'marker', me.move.to.x * TS + 3, me.move.to.y * TS + 2 + bounce);
    }

    if (this.selected) this.drawSelection(this.selected, poses, ms);

    // home-desk name tags on empty claimed chairs
    const deskOwners = new Map<string, ClientUser>();
    for (const u of this.store.users.values()) if (!this.areaDown && u.homeDesk) deskOwners.set(`${u.homeDesk.x},${u.homeDesk.y}`, u);
    for (const [key, owner] of deskOwners) {
      const [dx, dy] = key.split(',').map(Number);
      const op = poses.get(owner.id);
      if (op && !op.walking && op.tile.x === dx && op.tile.y === dy) continue; // they're sitting on it
      this.drawDeskTag(owner, dx, dy);
    }

    this.parties.length = 0;
    if (!this.areaDown) for (const j of this.jukeboxes) if (j.room && this.playing(j.o)) this.parties.push(j.room);

    // y-sorted drawables: furniture is sorted per layout (refreshLayout); people and plants are sorted here and merged in
    if (this.plantsVersion !== this.store.version) { this.plants = me?.instance ? [] : this.placePlants(); this.plantsVersion = this.store.version; }
    type D = { base: number; u?: ClientUser; p?: Pose; plant?: PlacedPlant; door?: RoomDoor; fx?: DungeonFx; draw?: () => void };
    const ds: D[] = [];
    if (!this.areaDown && !me?.instance) for (const c of this.critters.placed(t, ms)) ds.push(c);
    for (const door of this.areaDown ? [] : this.doors) ds.push({ base: (door.y + door.h) * TS - .5, door });
    for (const u of users) { const p = poses.get(u.id)!; ds.push({ base: p.y * TS + TS, u, p }); }
    if (!this.areaDown) for (const fx of this.store.dungeonFx) if (fx.kind === 'fall' && ms >= fx.at && ms - fx.at < 500) ds.push({ base: (fx.tile.y + 1) * TS, fx });
    for (const plant of this.plants) ds.push({ base: plant.base, plant });
    for (const { fx, age } of trips.values()) { // the two portals sit on their tiles, just behind whoever stands there
      const st = portalStage(age);
      ds.push({ base: (fx.from.y + 1) * TS - 1, draw: () => this.drawPortal(fx.from, st.from, ms) }, { base: (fx.to.y + 1) * TS - 1, draw: () => this.drawPortal(fx.to, st.to, ms) });
    }
    ds.sort((a, b) => a.base - b.base);
    const drawD = (d: D) => {
      if (d.draw) return d.draw();
      if (d.fx) return this.drawDungeonFx(d.fx, ms);
      if (d.u) {
        const fx = this.store.dungeonFx.find(f => f.user.id === d.u!.id && f.kind !== 'fall' && ms >= f.at && ms - f.at < 650 && (this.areaDown === (f.kind === 'land')));
        if (fx) return this.drawDungeonFx(fx, ms);
        if (!this.onScreen(d.p!.x * TS - TS, d.p!.y * TS - 2 * TS, 3 * TS, 4 * TS)) return;
        const trip = trips.get(d.u.id), size = trip ? portalStage(trip.age).size : 1;
        if (size >= 1) return this.drawSprite(d.u, d.p!, ms);
        const cx = d.p!.tile.x * TS + 8, cy = (d.p!.tile.y + 1) * TS - 9; // shrinking into (or growing out of) the middle of the portal
        ctx.save(); ctx.translate(cx, cy); ctx.scale(size, size); ctx.translate(-cx, -cy);
        this.drawSprite(d.u, d.p!, ms);
        return void ctx.restore();
      }
      if (d.door) { // open while someone stands in or right next to the doorway; a locked one stays shut for non-admins
        const door = d.door, reach = 1, open = [...poses.values()].some(p => door.tiles.some(t => Math.abs(t.x - p.tile.x) + Math.abs(t.y - p.tile.y) <= reach));
        const locked = door.locked && !this.store.sysadmin, age = ms - (this.deniedAt.get(door.room.id) ?? -1e9);
        const shake = locked && age < 450 ? Math.round(Math.sin(age / 22) * 2) : 0;
        const name = door.glass ? `door_v_glass_${open ? 'open' : 'closed'}` : `door_${door.horizontal ? 'h' : 'v'}_${locked ? 'locked' : open ? 'open' : 'closed'}`, fr = this.f(name);
        if (!fr || !this.onScreen(door.x * TS + (door.w * TS - fr.w) / 2 - 2, (door.y + door.h) * TS - fr.h, fr.w + 6, fr.h)) return;
        return void this.blit(ctx, name, door.x * TS + (door.w * TS - fr.w) / 2 + shake, (door.y + door.h) * TS - fr.h);
      }
      const p = d.plant!, pl = p.u.plant!;
      if (!this.onScreen(p.x - 16, p.y - 24, 32, 32)) return;
      const kinded = pl.kind && pl.stage >= PLANT_REVEAL;
      this.blit(ctx, plantDead(pl, t) ? 'pot_dead' : kinded ? `pot_${pl.kind}_${pl.stage}` : `pot_${pl.stage}`, p.x - 6, p.y - 20);
    };
    let di = 0;
    for (const f of this.areaDown ? [] : this.furniture) {
      while (di < ds.length && ds[di].base <= f.base) drawD(ds[di++]);
      const ff = this.f(f.o.type);
      if (!this.onScreen(f.x - 2, f.y - 2, ff.w + 4, ff.h + 4)) continue;
      this.blit(ctx, f.o.type === 'beach_flag' && this.store.sky === 'rain' && this.f('beach_flag_black') ? 'beach_flag_black' : f.o.use?.kind === 'retro' && this.store.retroCabinets.some(c => c.cabinet === f.o.id && c.player) ? `${f.o.type}_on` : f.o.type === 'game_table' && [...this.store.users.values()].some(u => u.table?.objectId === f.o.id && u.table.running) ? 'game_table_on' : f.o.type === 'arcade' && this.store.cabinets.some(c => c.cabinet === f.o.id) ? `arcade_on_${1 + Math.floor(ms / 320) % 2}` : f.o.use?.kind === 'tickets' && this.store.ticketsUnread() && Math.floor(ms / 600) % 2 ? 'terminal_on' : f.o.use?.kind === 'toilet' ? this.toiletFrame(f.o.id)
        : f.o.type === 'bell' ? this.bellFrame(f.o.id) : f.o.type === 'hat_rack' ? this.hatRackFrame(f.o, ms) : f.o.type === 'reading_table' && this.flickers(f.o, ms) ? 'reading_table_1'
        : f.o.type === 'server_rack' && Math.floor(ms / 500 + f.o.x * 3 + f.o.y) % 2 ? 'server_rack_1' : f.off && !this.isOn(f.o) ? `${f.o.type}_off` : f.o.type, f.x, f.y);
      if (f.o.use?.kind === 'toilet') this.drawStall(ctx, f.o, f.x, f.y);
      if (f.o.type === 'out_of_office_sign') drawBeachSign(ctx, f.x, f.y);
    }
    while (di < ds.length) drawD(ds[di++]);
    if (!this.areaDown && !me?.instance) this.critters.drawAbove(t, ms);

    // coffee steam when someone is in the Coffee room
    const coffeeBusy = users.some(u => roomAt(MAP, poses.get(u.id)!.tile.x, poses.get(u.id)!.tile.y)?.type === 'coffee');
    if (coffeeBusy) for (const o of this.steamers) this.drawSteam(o, ms);
    // fresh steam (or fridge chill) right after someone used it
    for (const fx of this.areaDown ? [] : this.store.objectFx) {
      if (ms - fx.at > 3000) continue;
      const o = objectById(MAP, fx.objectId);
      if (o && !(coffeeBusy && o.steam)) this.drawSteam(o, ms);
    }

    // evening in the Music room: it dims, and a disco ball turns while the jukebox plays
    if (!this.areaDown && !me?.instance) { const dusk = evening(hour); for (const d of this.discos) drawDisco(ctx, this.assets, d, ms, dusk, this.playing(d.jukebox)); }

    for (const o of this.areaDown ? [] : this.sounders) if (o.use?.kind === 'jukebox' && this.playing(o)) for (let i = 0; i < 3; i++) {
      const phase = (ms / 2200 + i / 3) % 1;
      ctx.globalAlpha = 1 - phase;
      this.blit(ctx, i % 2 ? 'note_1' : 'note_2', (o.x + o.w / 2) * TS - 4 + Math.round(Math.sin(phase * 6 + i) * 4), o.y * TS - Math.round(phase * 18));
    }
    for (const [id, at] of Object.entries(this.store.lastNote)) {
      const seen = this.noteSeen.get(id) ?? -Infinity;
      if (at > seen && at - seen >= 150) { this.noteSeen.set(id, at); this.instrumentNotes.push({ id, at }); }
    }
    this.instrumentNotes = this.instrumentNotes.filter(n => ms - n.at < 1200);
    for (const n of this.instrumentNotes) {
      const o = MAP.objects.find(o => o.id === n.id); if (!o) continue;
      const phase = (ms - n.at) / 1200;
      ctx.globalAlpha = 1 - phase;
      this.blit(ctx, 'note_1', (o.x + o.w / 2) * TS - 4 + Math.round(Math.sin(phase * 6) * 4), o.y * TS - Math.round(phase * 18));
    }
    ctx.globalAlpha = 1;

    if (!me?.instance) { this.drawBoardBadges(ctx, ms); this.drawKiosks(ctx, ms); }
    if (!me?.instance) this.drawTerminalBadge(ctx, ms);
    this.drawLiveScreen(ctx, ms); // the store only holds the show of my own scope
    if (!this.areaDown && !me?.instance) this.drawSky(ctx, poses, me, ms);

    // a meeting's own room: the rest of the office fades away
    if (me?.instance && !this.areaDown && !this.falling()) {
      ctx.fillStyle = 'rgba(20,13,16,0.9)';
      ctx.beginPath(); ctx.rect(-MW, -MH, MW * 3, MH * 3);
      ctx.rect((MEETING.x - 1) * TS, (MEETING.y - 2) * TS, (MEETING.w + 2) * TS, (MEETING.h + 3) * TS);
      ctx.fill('evenodd');
    }

    if (this.areaDown) {
      if (this.store.dungeon) this.dungeonView.draw(ctx, ms);
      else { ctx.fillStyle = '#000'; ctx.fillRect(this.area.x * TS, this.area.y * TS, this.area.w * TS, this.area.h * TS); }
    }
    // overlays: nameplates + bubbles (never occluded)
    const sorted = users.slice().sort((a, b) => poses.get(a.id)!.y - poses.get(b.id)!.y);
    this.placedPlates = [];
    for (const u of sorted) { const p = poses.get(u.id)!; if (this.onScreen(p.x * TS - 2 * TS, p.y * TS - 3 * TS, 5 * TS, 5 * TS)) this.drawOverlay(u, p, ms); }
    this.drawReactions(poses, ms);
    if (!this.areaDown && !me?.instance) { if (this.roofAlpha < 0.99) this.drawClub(ctx, ms); this.drawRoof(ctx); }
    if (!this.areaDown) this.drawAmbient(ctx, ms, hour, users, poses);
    // labels switch the canvas to screen space, so everything drawn in world space (the tint above) comes first
    if (!this.areaDown && !me?.instance) { this.drawBellDings(poses, camX, camY); this.drawHatNudge(me, poses, camX, camY, ms); }
    if (this.editing) this.drawEdit(ctx, camX, camY, ms);
    if (this.overview && !me?.instance) this.drawRoomTags(users, poses, camX, camY);
    // one of my meetings is on: say so over the board, readable at any zoom
    const goable = me && !me.instance && this.hoverObject?.use?.kind !== 'meetings'
      ? this.store.agenda.find(a => a.start - 10 * 60_000 <= this.store.now() && a.end > this.store.now()) : undefined;
    // first time in the Meeting room: point at the kiosk until it's been used once
    if (me && !me.instance && !this.store.kioskSeen && !this.tapZooms && this.hoverObject?.use?.kind !== 'room_start') {
      const room = this.store.roomOf(me)?.id;
      for (const o of this.kiosks) if (room && roomAt(MAP, o.x, o.y)?.id === room)
        this.drawLabel('+ Private room', (o.x + 0.5) * TS, (o.y + 1) * TS - 32 - Math.round((Math.sin(ms / 260) + 1)), camX, camY, 1, true, 10);
    }
    if (goable) for (const o of this.boards) {
      const title = goable.title.length > 16 ? `${goable.title.slice(0, 15)}…` : goable.title;
      this.drawLabel(`📅 ${title} · go`, (o.x + 0.5) * TS, o.y * TS - 4 - Math.round((Math.sin(ms / 220) + 1)), camX, camY, 1, false, 10); // a small nudge: the heads-up toast says the rest
    }

    ctx.restore();
    // hover tooltip in screen space
    if (this.tapZooms || this.editing || this.hoverUser) { /* person hover is DOM; overview/edit mode have their own labels */ }
    else if (this.hoverObject && !this.selected) {
      const o = this.hoverObject, fr = this.f(o.type)!;
      const jukebox = this.store.jukebox[o.id], track = jukebox && TRACK.get(jukebox.track);
      const player = this.store.instruments[o.id];
      const instrumentTip = o.use?.kind === 'instrument' ? `${INSTRUMENTS[o.use.instrument].name} · ${this.store.seat === o.id ? "you're playing · Esc to stand up" : player === this.store.me ? "you're playing in another tab" : player ? `${this.store.name(player).split(' ')[0]} is playing` : 'click to play'}` : '';
      const retro = o.use?.kind === 'retro' ? this.store.retroCabinets.find(c => c.cabinet === o.id) : null;
      const retroTip = o.use?.kind === 'retro' ? retro?.broken ? 'Out of order' : `${o.use.label} · ${retro?.player ? `${this.store.name(retro.player)} is playing · ${retro.watchers} watching` : 'free'}` : '';
      const awayCount = o.use?.kind === 'vacations' ? [...this.store.users.values()].filter(u => u.vacation).length : 0;
      const what = retroTip || instrumentTip || (o.use?.kind === 'shop' ? 'Shelves · everything free, 3 a day' : o.use?.kind === 'cashier' ? 'Keiko · the 7/11 cashier' : o.use?.kind === 'kettle' ? 'Kettle · fills cup noodles' : o.use?.kind === 'mirror' ? 'Mirror · edit your look' : o.use?.kind === 'photos' ? 'Photo wall · coming soon' : o.use?.kind === 'gacha' ? 'Gacha machine' : o.use?.kind === 'tickets' ? this.store.terminalTip() : o.use?.kind === 'wellness' ? `${o.use.label} · your personal reminders` : o.use?.kind === 'table' ? this.store.tableDescription(o.id) : o.use?.kind === 'arcade' ? this.store.gameDescription(o.id) : o.use?.kind === 'records' ? 'Arcade boards · weekly scores and records' : o.use?.kind === 'jukebox' ? !jukebox ? 'Jukebox · Reconnecting…' : jukebox.pausedAt !== null ? 'Jukebox · paused' : `Jukebox · ♪ ${track?.title ?? jukebox.track} — ${track?.artist ?? ''}` : o.use?.kind === 'toggle' ? `${o.use.label[0].toUpperCase()}${o.use.label.slice(1)} · ${o.type === 'window' ? (this.isOn(o) ? 'open' : 'closed') : this.isOn(o) ? 'on' : 'off'}`
        : o.use?.kind === 'vacations' ? `On vacation · ${awayCount ? `${awayCount} away now` : "everyone's at work"}`
        : o.use?.kind === 'calendar' ? 'Calendar · your week' : o.use?.kind === 'achievements' ? (o.type === 'trophy_case' ? 'Trophy case · your achievements' : 'Employee Of the Month') : o.use?.kind === 'link' ? `Vault 13 · click to open the ${o.use.label}` : o.use?.kind === 'meetings' ? `Meetings · ${this.store.meetingRooms.length || 'none'} on now`
        : o.use?.kind === 'youtube' ? `${o.use.label} · click to watch`
        : o.use?.kind === 'room_start' ? 'Start a private room · click to walk over'
        : o.use?.kind === 'presentation' ? (this.store.presentation?.objectId === o.id ? `Screen · LIVE: ${this.store.presentation.deck?.title ?? `${this.store.name(this.store.presentation.presenter).split(' ')[0]}'s screen`}` : 'Screen · click to present slides') : o.use?.kind === 'clock' ? `Clock · ${o.use.city}, ${zoneTime(o.use.tz)} · click for all our cities` : o.sit ? `${o.type === 'bench' ? 'Bench' : 'Sofa'} · click to sit` : o.type === 'coffee_machine' ? 'Coffee machine' : o.type === 'fridge' ? 'Fridge' : o.use?.kind === 'toilet' ? this.toiletTip(o.id) : o.use?.kind === 'bell' ? 'Reception bell · click to ring' : o.type === 'reading_table' || o.type === 'reading_desk' ? 'Reading table · take a book from the shelf' : o.use?.kind === 'library' ? 'Library shelf · publish or borrow an article' : o.use?.kind === 'dealer' ? (o.type === 'bouncer' ? 'Bouncer · knows a guy' : 'Hat stand · pick a hat for your pockets') : objectName(o.type));
      this.drawLabel(what, (o.x + o.w / 2) * TS, (o.y + o.h) * TS - fr.h + 4, camX, camY);
    }
    else if (this.hoverCup && this.store.cups.some(c => c.id === this.hoverCup!.id)) { // gone: the label goes with it
      const { x, y } = this.hoverCup.tile;
      this.drawLabel(this.critters.cupLabel(this.hoverCup), x * TS + 8, y * TS - 2, camX, camY);
    }
    else if (this.cupTile) {
      const held = me?.holding ? ITEMS.get(me.holding) : undefined;
      this.drawLabel(`${held?.icon ?? '☕'} Put your ${held?.label.toLowerCase() ?? 'cup'} down here`, this.cupTile.x * TS + 8, this.cupTile.y * TS + 4, camX, camY);
    }
    else if (this.lunchTile) this.drawLabel(`${ITEMS.get(me?.holding ?? '')?.icon ?? '🍽'} Eat lunch here`, this.lunchTile.x * TS + 8, this.lunchTile.y * TS + 4, camX, camY);
    else if (this.hoverCritter) this.drawLabel(this.hoverCritter.text, this.hoverCritter.x, this.hoverCritter.y, camX, camY);
    else if (this.hoverPlant) {
      const { u, x, y } = this.hoverPlant, mine = u.id === this.store.me, p = u.plant!;
      const state = plantDead(p, t) ? (mine ? 'withered · set a status to replant' : 'withered') : PLANT_STAGES[p.stage] + (mine ? ' · set a status each day' : '') + (this.nearDesk(u) ? ' · click: desk storage' : '');
      this.drawLabel(`${mine ? 'Your' : `${u.name.split(' ')[0]}'s`} ${plantDead(p, t) ? 'plant' : plantName(p)} · ${state}`, x, y - 18, camX, camY);
    }
    else if (this.hoverTile) {
      const owner = deskOwners.get(`${this.hoverTile.x},${this.hoverTile.y}`);
      if (owner) this.drawLabel(owner.id === this.store.me ? 'Your desk' : `${owner.name}'s desk`, this.hoverTile.x * TS + 8, this.hoverTile.y * TS, camX, camY);
    }
    const fall = this.falling();
    if (fall) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(0,0,0,${Math.max(0, Math.min(1, (ms - fall.at - 500) / 400))})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.store.dungeonFx = this.store.dungeonFx.filter(f => ms - f.at < 1600);
  }

  /** A swirling violet portal standing on a tile; `s` is how far open it is (0 shut, 1 full). */
  private drawPortal(tile: Tile, s: number, ms: number) {
    if (s <= 0.03) return;
    const ctx = this.ctx, cx = tile.x * TS + 8, cy = (tile.y + 1) * TS - 9, rx = 7 * s, ry = 11 * s;
    ctx.save();
    ctx.fillStyle = 'rgba(150,110,255,0.22)'; ctx.beginPath(); ctx.ellipse(cx, cy, rx + 3, ry + 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1d0f45'; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8f6cff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 14; i++) { // specks spiralling into the middle
      const k = (i / 14 + ms / 900) % 1, a = k * Math.PI * 5 + i, r = 1 - k;
      ctx.fillStyle = i % 3 ? '#b89cff' : '#efe6ff';
      ctx.fillRect(Math.round(cx + Math.cos(a) * rx * r * 0.85), Math.round(cy + Math.sin(a) * ry * r * 0.85), 1, 1);
    }
    const n = Math.max(8, Math.round(26 * s)); // a bright crawling rim
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ms / 500;
      ctx.fillStyle = (i + Math.floor(ms / 120)) % 2 ? '#7a5cff' : '#d8c8ff';
      ctx.fillRect(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), 1, 1);
    }
    ctx.restore();
  }
  /** Ambient water is drawn only in the viewport; it never contributes to skipFrame's busy flag. */
  private drawWater(ctx: CanvasRenderingContext2D, now: number, rough = false) {
    const v = this.vis, a = this.area, phase = Math.floor(now / (rough ? 220 : 400)); // rain stirs the sea: quicker waves, more foam
    const mask = waterMask ??= MAP.layers.floor.map(row => row.map(i => /^(water_(shallow|deep)_[0-2]|sea)$/.test(MAP.tiles[i] ?? '')));
    const water = (x: number, y: number) => !!mask[y]?.[x];
    ctx.save(); ctx.lineWidth = 0.5;
    for (let y = Math.max(a.y, Math.floor(v.y0 / TS)); y < Math.min(a.y + a.h, Math.ceil(v.y1 / TS)); y++) {
      for (let x = Math.max(a.x, Math.floor(v.x0 / TS)); x < Math.min(a.x + a.w, Math.ceil(v.x1 / TS)); x++) {
        if (!water(x, y)) continue;
        const seed = (x * 73856093 ^ y * 19349663) >>> 0, px = x * TS, py = y * TS;
        ctx.strokeStyle = 'rgba(228,250,245,0.3)'; ctx.beginPath();
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          if (water(x + dx, y + dy)) continue;
          const offset = 1 + (phase + seed) % 2;
          if (dx) { const sx = px + (dx < 0 ? offset : TS - offset); ctx.moveTo(sx, py + 1); ctx.lineTo(sx + 0.5, py + 8); ctx.lineTo(sx, py + TS - 1); }
          else { const sy = py + (dy < 0 ? offset : TS - offset); ctx.moveTo(px + 1, sy); ctx.lineTo(px + 8, sy + 0.5); ctx.lineTo(px + TS - 1, sy); }
        }
        ctx.stroke();
        if ((seed + phase) % (rough ? 5 : 13) === 0) {
          const sx = px + 2 + (seed + phase * 3) % 12, sy = py + 2 + ((seed >>> 5) + phase) % 12;
          ctx.fillStyle = 'rgba(230,255,250,0.4)'; ctx.fillRect(sx, sy, 2, 1); ctx.fillRect(sx, sy - 1, 1, 3);
        }
      }
    }
    ctx.restore();
  }

  private drawSwim(ctx: CanvasRenderingContext2D, x: number, baseY: number, deep: boolean, ms: number) {
    const lineY = baseY - (deep ? 16 : 8);
    ctx.save(); ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(220,250,248,0.7)';
    ctx.beginPath();
    for (let i = 0; i <= 16; i += 2) {
      const y = lineY + Math.sin(i / 2 + ms / 450) * 0.7;
      if (!i) ctx.moveTo(x + i, y); else ctx.lineTo(x + i, y);
    }
    ctx.stroke();
    for (let i = 0; i < (deep ? 2 : 1); i++) {
      const phase = ((ms / (deep ? 2600 : 1600) + i / 2) % 1);
      ctx.globalAlpha = 0.5 * (1 - phase); ctx.beginPath();
      ctx.ellipse(x + 8, lineY + 1, 7 + phase * (deep ? 9 : 4), 2 + phase * 3, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  private drawFishing(ctx: CanvasRenderingContext2D, x: number, baseY: number, now: number) {
    const fy = baseY + 10 + Math.sin(now / 600), fx = x + 27;
    ctx.save(); this.blit(ctx, 'fishing_rod', x + 11, baseY - 18);
    ctx.strokeStyle = 'rgba(240,240,225,0.8)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(x + 22, baseY - 17); ctx.lineTo(fx, fy); ctx.stroke();
    ctx.fillStyle = '#ec705b'; ctx.fillRect(fx - 1, Math.round(fy), 2, 2);
    ctx.fillStyle = '#fff3d0'; ctx.fillRect(fx - 1, Math.round(fy) - 1, 2, 1);
    const jump = now % 25000;
    if (jump < 1400) {
      const phase = jump / 1400;
      this.blit(ctx, 'icon_fish', Math.round(fx + 2 - phase * 12), Math.round(fy - Math.sin(phase * Math.PI) * 14)); // a koi jumps
    }
    ctx.restore();
  }

  /** Walking past a toy train: chugging arms and a "choo choo" over the head. Same for everyone who sees it. */
  private drawChooChoo(u: ClientUser, x: number, top: number, ms: number) {
    const ctx = this.ctx, k = Math.floor(ms / 170) % 2, label = Math.floor(ms / 680) % 2 ? 'CHOO CHOO' : 'CHOO';
    ctx.fillStyle = u.look.skin;
    ctx.fillRect(x + (k ? 0 : 1), top + 10 + k, 3, 2); ctx.fillRect(x + (k ? 12 : 13), top + 11 - k, 3, 2); // forearms pumping like pistons
    const w = textWidth(label) + 4, bx = x + 8 - Math.floor(w / 2), by = top - 10;
    ctx.fillStyle = '#513b36'; ctx.fillRect(bx - 1, by - 1, w + 2, 9);
    ctx.fillStyle = '#fff4e0'; ctx.fillRect(bx, by, w, 7);
    drawText(ctx, label, bx + 2, by + 1, '#513b36');
  }
  private drawSprite(u: ClientUser, p: Pose, ms: number) {
    const ctx = this.ctx, c = this.assets.atlas.character;
    const x = Math.round(p.x * TS), baseY = Math.round(p.y * TS) + TS;
    const seat = p.walking ? null : seatAt(MAP, p.tile.x, p.tile.y);
    const lie = seat && MAP.objects.find(o => o.lie && o.y === seat.y && o.x + Math.floor((o.w - 1) / 2) === seat.x);
    const terrain = terrainAt(MAP, p.tile.x, p.tile.y), water = terrain === 'shallow' || terrain === 'deep';
    const summit = !p.walking && !seat && MAP.vacation?.summit.x === p.tile.x && MAP.vacation.summit.y === p.tile.y;
    const fishing = !p.walking && !seat && p.dir === 'down' && MAP.vacation?.pierEnds.some(t => t.x === p.tile.x && t.y === p.tile.y);
    // shadow (a seated sprite's shadow is the chair's)
    if (!seat && !water) {
      ctx.fillStyle = 'rgba(40,20,25,0.28)';
      ctx.beginPath(); ctx.ellipse(x + 8, baseY - 1.5, 5.5, 2, 0, 0, Math.PI * 2); ctx.fill();
    }
    const rainy = this.store.sky === 'rain' && !lie && !water && !this.areaDown && isOutdoor(MAP, p.tile.x, p.tile.y);
    const sheet = this.assets.sheet(u.effects?.length ? effectLook(u.look, u.effects) : u.look);
    let frame = 0, bob = 0, dx = 0;
    const presenting = this.store.presentation?.presenter === u.id && !this.store.presentation.away;
    const dozing = this.dozing(u, p);
    const step = !p.walking && !presenting && !dozing && u.presence !== 'away' && !u.door && this.dancing(u, p.tile) ? dance(Date.now(), hash(u.id), !!seat, this.dancer) : null;
    if (p.walking) frame = 1 + (Math.floor((ms / 1000) * WALK_FPS * WALK_MS_PER_TILE / (u.move?.ms ?? WALK_MS_PER_TILE)) % 4); // quicker steps when quicker
    else if (seat) { frame = lie ? 0 : SIT_FRAME; p = { ...p, dir: seat.dir }; }
    else if (presenting) p = { ...p, dir: 'down' }; // presenting: face the room, back to the board
    if (step) { // the jukebox is on: dance a little
      bob = step.dy; dx = step.dx;
      if (step.turn && !seat && (p.dir === 'down' || p.dir === 'up')) p = { ...p, dir: step.turn < 0 ? 'left' : 'right' };
    } else if (!p.walking && !seat && !presenting) {
      const phase = (ms + hash(u.id) * 37) % 1800;
      bob = u.presence === 'away' ? (phase < 900 ? 1 : 0) : phase < 300 ? 1 : 0; // tiny breathing bob
    }
    if (dozing) { const t = (ms + hash(u.id) * 37) % 3200; bob = t < 2400 ? 1 : t < 2550 ? -1 : 0; } // nodding off, a jerk awake, and off again
    if (summit) bob = (ms + hash(u.id)) % 600 < 180 ? -2 : 0;
    if (lie) { bob = 0; dx = 0; }
    const row = DIR_ROW[p.dir] ?? 0;
    const walkBob = p.walking && (frame === 2 || frame === 4) ? -1 : 0;
    // the bag: in hand walking in and out, on the floor while they think about leaving
    const hand = BAG_HAND[p.dir] ?? BAG_HAND.down;
    const swing = p.walking && frame % 2 ? 1 : 0;
    const carrying = u.door === 'arriving' || u.door === 'leaving';
    const bag = u.vacation || u.presence === 'offline' && u.door ? 'suitcase' : 'bag';
    const drawBag = () => this.blit(ctx, bag, x + dx + hand.dx, baseY - 13 + swing);
    if (u.door === 'thinking') this.blit(ctx, bag, x + 11, baseY - 9);
    if (carrying && hand.behind) drawBag();
    ctx.save();
    if (water) { ctx.beginPath(); ctx.rect(x - 16, baseY - c.frameH - 8, 48, c.frameH + 8 - (terrain === 'deep' ? 16 : 8)); ctx.clip(); }
    if (lie) {
      const swing = lie.type === 'hammock' ? Math.round(Math.sin(ms * Math.PI / 1000)) : 0;
      ctx.translate((lie.x + lie.w / 2) * TS + 12, lie.y * TS + 8 + swing);
      ctx.rotate(-Math.PI / 2); ctx.translate(-x - 8, -baseY + 1);
    }
    // effects: a sway for the whole figure, then layers behind and in front of the body (see effects.ts)
    const fx = u.effects?.length ? u.effects : null, seed = hash(u.id);
    const sway = fx && !lie ? effectSway(fx, ms, seed, p) : null;
    if (sway && (sway.dx || sway.rot || sway.dy)) { ctx.save(); ctx.translate(x + 8 + sway.dx, baseY + sway.dy); ctx.rotate(sway.rot); ctx.translate(-x - 8, -baseY); }
    const top = baseY - c.frameH + bob + walkBob - 1 + (seat ? 2 : 0);
    const fxCtx = fx && { ctx, x: x + dx, top, baseY, ms, seed, p, blit: (n: string, bx: number, by: number) => this.blit(ctx, n, Math.round(bx), Math.round(by)), has: (n: string) => !!this.f(n) };
    if (fxCtx) drawEffects('back', fxCtx, fx);
    const backpack = terrain === 'trail' || terrain === 'snow';
    const drawBackpack = () => this.blit(ctx, 'backpack', x + dx + (p.dir === 'left' ? 7 : p.dir === 'right' ? -1 : 3), top + 8);
    if (backpack && p.dir === 'down') drawBackpack();
    // at the door: already half out
    ctx.globalAlpha = u.door === 'leaving' && !p.walking ? 0.45 : dozing ? 0.72 : u.presence === 'away' ? 0.8 : 1;
    if (rainy && u.umbrella) { const lift = this.hatLift(u); ctx.fillStyle = '#2a1f26'; ctx.fillRect(x + dx + 8, top - lift + 1, 1, lift + 14); } // the pole, behind the person
    ctx.drawImage(sheet, frame * c.frameW, row * c.frameH, c.frameW, c.frameH, x + dx, baseY - c.frameH + bob + walkBob - 1, c.frameW, c.frameH);
    if (backpack && p.dir !== 'down') drawBackpack();
    if (backpack && p.dir === 'down') { ctx.fillStyle = '#8b613d'; ctx.fillRect(x + dx + 4, top + 10, 1, 5); ctx.fillRect(x + dx + 11, top + 10, 1, 5); }
    if (carrying && !hand.behind) drawBag();
    ctx.globalAlpha = 1;
    if (fxCtx) drawEffects('front', fxCtx, fx);
    if (rainy && u.umbrella) this.drawUmbrella(ctx, u, x + dx, top - this.hatLift(u)); // over the hat
    if (sway && (sway.dx || sway.rot || sway.dy)) ctx.restore();
    if (p.walking && this.store.cups.some(c => c.item === 'train' && Math.max(Math.abs(c.tile.x - p.tile.x), Math.abs(c.tile.y - p.tile.y)) <= 1)) this.drawChooChoo(u, x, top, ms); // passing a toy train
    if (u.holding === 'glow_stick') { // a small green glow around the stick in their hand
      const ih = ITEM_HAND[p.dir] ?? ITEM_HAND.down, gx = x + dx + ih.dx, gy = baseY + ih.dy + bob, g = ctx.createRadialGradient(gx, gy, 0, gx, gy, 9);
      g.addColorStop(0, 'rgba(120,255,150,0.45)'); g.addColorStop(1, 'rgba(120,255,150,0)');
      ctx.fillStyle = g; ctx.fillRect(gx - 9, gy - 9, 18, 18);
    }
    const icon = u.holding && !carrying ? ITEM_ICON.get(u.holding) ?? itemDef(u.holding)?.icon : undefined;
    if (icon) {
      const ih = seat ? ITEM_HAND.down : ITEM_HAND[p.dir] ?? ITEM_HAND.down;
      // a sip: the cup goes up to the mouth and tips twice, with a little "sip" over the head
      const sipT = u.sipping !== undefined ? (performance.now() - u.sipping) / (DRINKS[u.holding!]?.sipMs ?? 2500) : 1;
      const sip = sipT >= 0 && sipT < 1 ? Math.sin(Math.PI * Math.min(1, sipT * 4, (1 - sipT) * 4) / 2) : 0;
      const ix = x + dx + ih.dx + (8 - ih.dx) * 0.4 * sip, iy = baseY + ih.dy + bob + (p.walking ? swing : 0) - 5 * sip + (sip === 1 ? Math.round(Math.sin(sipT * Math.PI * 4)) : 0);
      ctx.fillStyle = '#000'; ctx.font = '7px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; // emoji take the fill alpha
      if (isEmpty(u.holding)) ctx.globalAlpha = 0.45; // an empty cup: dimmed
      const spr = itemDef(emptyDrink(u.holding) ?? u.holding)?.sprite, sf = spr ? this.f(spr) : undefined; // a registry sprite (an empty cup uses its drink's), else the emoji
      if (spr && sf) this.blit(ctx, spr, Math.round(ix - sf.w / 2), Math.round(iy - sf.h / 2)); else ctx.fillText(icon, ix, iy);
      ctx.globalAlpha = 1;
      if (sip) { ctx.font = 'bold 5px system-ui, sans-serif'; ctx.lineWidth = 2; ctx.strokeStyle = '#2a1e1a'; ctx.strokeText('sip', x - 2, top + 7); ctx.fillStyle = '#fff'; ctx.fillText('sip', x - 2, top + 7); }
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }
    if (u.reading && seat && this.f('reading_book')) this.blit(ctx, 'reading_book', Math.round(x + 2), Math.round(baseY - 16 + bob)); // holding up the book
    if (u.eating && seat) { // fork down to the plate and up to the mouth; 💬 when they don't mind company
      const up = Math.floor(ms / 450) % 2, fx = seat.dir === 'left' ? x + 4 : seat.dir === 'right' ? x + 11 : x + 11;
      if (seat.dir !== 'up') { ctx.fillStyle = '#e8e8f0'; ctx.fillRect(fx, baseY - (up ? 11 : 7), 1, 3); ctx.fillStyle = '#6a6a76'; ctx.fillRect(fx, baseY - (up ? 8 : 4), 1, 1); }
    }
    ctx.restore();
    if (water) this.drawSwim(ctx, x, baseY, terrain === 'deep', ms + hash(u.id));
    if (fishing) this.drawFishing(ctx, x, baseY, this.store.now() + hash(u.id));

    // facing a desk: the chair's backrest is in front of the sitter
    if (seat?.dir === 'up' && (seat.type === 'chair' || seat.type === 'leader_chair') && this.f(`${seat.type}_up_back`)) {
      this.blit(ctx, `${seat.type}_up_back`, seat.x * TS, seat.y * TS);
    }
  }


  private drawDeskTag(owner: ClientUser, x: number, y: number) {
    const ctx = this.ctx;
    const label = owner.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const w = textWidth(label) + 4;
    const px = x * TS + 8 - Math.floor(w / 2), py = y * TS + 5;
    ctx.fillStyle = 'rgba(30,18,22,0.8)'; ctx.fillRect(px - 1, py - 1, w + 2, 9);
    ctx.fillStyle = owner.look.shirt; ctx.fillRect(px, py, w, 7);
    drawText(ctx, label, px + 2, py + 1, '#fff8e8');
  }

  private apartCache = new Map<string, boolean>(); private apartAt = -1;
  /** A direct talk (knock call, not a 'room:' hall) whose members stand in different places: shown with a phone. */
  private apartTalk(u: ClientUser): boolean {
    const id = u.callId; if (!id || id.startsWith('room:')) return false;
    const now = this.store.now();
    if (now !== this.apartAt) { this.apartAt = now; this.apartCache.clear(); }
    const hit = this.apartCache.get(id); if (hit !== undefined) return hit;
    const places = new Set<string>();
    for (const m of this.store.users.values()) {
      if (m.callId !== id || m.presence === 'offline') continue;
      let place: string;
      if (m.instance) place = `i:${m.instance}`;
      else {
        const stall = Object.entries(this.store.toilets).find(([, s]) => s.in.includes(m.id));
        if (stall) place = `stall:${stall[0]}`;
        else { const t = this.store.pose(m).tile; place = `r:${roomAt(MAP, t.x, t.y)?.id ?? 'none'}`; }
      }
      places.add(place);
    }
    const r = places.size > 1; this.apartCache.set(id, r); return r;
  }

  /** Idle (`afk`) and standing or sitting still: they doze, with z's drifting up instead of a bubble. */
  private dozing(u: ClientUser, p: Pose) { return !!u.afk && !p.walking && u.presence !== 'offline' && !u.door && !u.vacation; }

  /** Three z's rising from the head, growing and fading, staggered so one is always on its way. */
  private drawZs(x: number, top: number, ms: number, seed: number) {
    const ctx = this.ctx;
    for (let i = 0; i < 3; i++) {
      const t = ((ms + seed * 53) / 2700 + i / 3) % 1, n = t < 0.4 ? 3 : 4;
      const zx = Math.round(x + 11 + t * 7 + Math.sin(t * Math.PI * 2) * 1.5), zy = Math.round(top - 2 - t * 13);
      ctx.globalAlpha = Math.sin(Math.PI * t);
      const glyph = (dx: number, dy: number, w: number, color: string) => {
        ctx.fillStyle = color;
        ctx.fillRect(zx + dx, zy + dy, n + w, 1 + w); ctx.fillRect(zx + dx, zy + dy + n - 1, n + w, 1 + w);
        for (let k = 1; k < n - 1; k++) ctx.fillRect(zx + dx + n - 1 - k, zy + dy + k, 1 + w, 1 + w);
      };
      glyph(-1, -1, 2, 'rgba(40,24,40,0.55)'); glyph(0, 0, 0, '#e8ecff');
    }
    ctx.globalAlpha = 1;
  }

  private bubbleFor(u: ClientUser): BubbleKind | null {
    const v = MAP.vacation?.summit, p = v && this.store.pose(u);
    if (p && !p.walking && p.tile.x === v.x && p.tile.y === v.y) return 'bubble_bang'; // hello from the summit
    if (u.hand) return 'bubble_hand';
    if (u.door === 'thinking') return 'bubble_think';
    if (u.door === 'leaving') return null;
    if (u.emote === 'knock') return 'bubble_bang';
    // in the Arcade's open voice everyone is in the room call: show the joystick/eyes unless they're talking
    if (u.table && !u.speaking && (!u.callId || u.callId.startsWith('room:'))) return u.table.role === 'watcher' || u.table.running && !u.table.players.includes(u.id) ? 'bubble_watch' : 'bubble_game';
    if (u.game && !u.speaking && (!u.callId || u.callId.startsWith('room:'))) return u.game.role === 'player' ? 'bubble_game' : 'bubble_watch';
    if (u.callId) return u.deafened ? u.muted ? 'bubble_mute_deaf' : 'bubble_deaf' : this.apartTalk(u) ? 'bubble_phone' : 'bubble_talk';
    if (!underground(u) && (u.instance || u.meeting)) return 'bubble_meeting'; // a real calendar meeting, not just standing in the Meeting room; beats a manual "In a call"
    if (u.pomodoro?.phase === 'focus') return 'bubble_tomato'; // a personal pomodoro is running
    if (u.eating?.open) return 'bubble_dots';                   // eating, and glad of company
    if (u.presence === 'in_call') return 'bubble_headset';
    if (u.presence === 'away') return 'bubble_zzz';
    return null;
  }

  private drawOverlay(u: ClientUser, p: Pose, ms: number) {
    const ctx = this.ctx;
    const x = Math.round(p.x * TS), baseY = Math.round(p.y * TS) + TS;
    // nameplate
    const isMe = u.id === this.store.me;
    const mark = u.vacation ? '🌴' : u.dnd ? '🌙' : ''; // DND (v2): a moon, like the vacation palm
    const key = `${u.name}|${isMe}|${mark}`;
    let plate = this.nameplates.get(key);
    if (!plate) {
      const lines = plateLines(u.name);
      const prefix = mark ? 10 : 0;
      const w = Math.max(...lines.map(textWidth)) + 4 + prefix, h = Math.max(lines.length * 7 + 1, prefix);
      plate = document.createElement('canvas'); plate.width = w; plate.height = h;
      const pc = plate.getContext('2d')!;
      pc.fillStyle = isMe ? 'rgba(90,50,20,0.85)' : 'rgba(30,18,22,0.72)';
      pc.fillRect(1, 0, w - 2, h); pc.fillRect(0, 1, w, h - 2);
      const mf = prefix ? this.f(u.vacation ? 'mark_palm' : 'mark_moon') : undefined; // a pixel palm (vacation) or moon (DND)
      if (mf) pc.drawImage(this.assets.world, mf.x, mf.y, mf.w, mf.h, 0, Math.floor((h - mf.h) / 2), mf.w, mf.h);
      else if (prefix) { pc.font = '8px system-ui, sans-serif'; pc.fillText(mark, 1, 7); }
      lines.forEach((l, i) => drawText(pc, l, prefix + Math.floor((w - prefix - textWidth(l)) / 2), 1 + i * 7, isMe ? '#ffe08a' : '#fff4e0'));
      this.nameplates.set(key, plate);
    }
    // neighbours side by side: stagger plates so names stay readable
    const px = x + 8 - Math.floor(plate.width / 2);
    let py = baseY + 1;
    for (let tries = 0; tries < 4; tries++) {
      const hit = this.placedPlates.some(r => px < r.x + r.w + 1 && px + plate!.width + 1 > r.x && py < r.y + r.h && py + plate!.height > r.y);
      if (!hit) break;
      py += plate.height;
    }
    this.placedPlates.push({ x: px, y: py, w: plate.width, h: plate.height });
    ctx.drawImage(plate, px, py);

    // a status that just changed: a small note fades up for a few seconds (the hover card keeps the text)
    const seen = this.statusSeen.get(u.id), cur = u.status ?? '';
    if (!seen) this.statusSeen.set(u.id, { text: cur, at: -1e9 });
    else if (seen.text !== cur) { seen.text = cur; seen.at = cur ? ms : -1e9; }
    const sAge = ms - (this.statusSeen.get(u.id)?.at ?? -1e9);
    if (sAge >= 0 && sAge < 4000) {
      const a = sAge < 3000 ? 1 : 1 - (sAge - 3000) / 1000, nx = px + plate.width - 2, ny = py - 7 - Math.floor(sAge / 700);
      ctx.save(); ctx.globalAlpha = a;
      ctx.fillStyle = '#fff4e0'; ctx.fillRect(nx, ny, 7, 5); ctx.fillRect(nx + 1, ny + 5, 2, 1);
      ctx.fillStyle = '#7a5a50'; ctx.fillRect(nx + 1, ny + 1, 5, 1); ctx.fillRect(nx + 1, ny + 3, 3, 1);
      ctx.restore();
    }

    if (u.listening === 'lofi') {
      const w = 51, bx = x + 8 - Math.floor(w / 2), by = baseY - 55;
      ctx.fillStyle = '#513b36'; ctx.fillRect(bx - 1, by - 1, w + 2, 17);
      ctx.fillStyle = '#281f26'; ctx.fillRect(bx, by, w, 15);
      drawText(ctx, 'LISTENING TO', bx + 4, by + 2, '#d9bfa4');
      ctx.fillStyle = '#e33a47'; ctx.fillRect(bx + 3, by + 8, 8, 5);
      ctx.fillStyle = '#fff4e0'; ctx.fillRect(bx + 6, by + 9, 1, 3); ctx.fillRect(bx + 7, by + 10, 1, 1);
      drawText(ctx, 'LOFI GIRL', bx + 13, by + 8, '#fff4e0');
    }

    // emote bubble with a 2-frame pop; dozing: z's instead of the Away bubble
    const doze = this.dozing(u, p);
    if (doze) this.drawZs(x, baseY - 24, ms, hash(u.id));
    let kind = this.bubbleFor(u);
    if (doze && kind === 'bubble_zzz') kind = null;
    const st = this.bubbleState.get(u.id);
    if (!st || st.kind !== kind) this.bubbleState.set(u.id, { kind, at: ms });
    if (!kind) return;
    const age = ms - (this.bubbleState.get(u.id)?.at ?? 0);
    let dy = age < 70 ? -3 : age < 140 ? 1 : 0;
    const tx = x + BUBBLE_DX + 5, ty = baseY - 23 - this.hatLift(u); // where the tail touches: just above the head (and any hat), right of centre
    if (kind === 'bubble_talk' || kind === 'bubble_phone') {
      const speaking = this.isSpeaking(u);
      const pre = kind === 'bubble_phone' && this.f('bubble_phone_0') ? 'bubble_phone' : 'bubble_talk'; // talk frames until the phone art lands
      const frame = u.muted ? (pre === 'bubble_phone' ? 'bubble_phone_muted' : 'bubble_muted') : speaking ? (Math.floor(ms / 140) % 2 ? `${pre}_1` : `${pre}_2`) : `${pre}_0`;
      this.blitBubble(ctx, frame, tx, ty + dy + (speaking ? -(Math.floor(ms / 280) % 2) : 0));
      return;
    }
    if (kind === 'bubble_bang') dy += Math.floor(ms / 180) % 2 ? -1 : 0;
    else dy += Math.floor((ms + hash(u.id) * 13) / 600) % 2 ? 0 : -1;
    this.blitBubble(ctx, kind, tx, ty + dy); // up and to the right of the head; every bubble's tail is on its left, over the head
  }

  /** Fake turn-taking for two people on a call, from server time so every viewer sees the same conversation. */
  isSpeaking(u: ClientUser) {
    if (!u.callId || u.muted || u.deafened) return false;
    if (!u.bot) return !!u.speaking; // real people: their actual mic activity (voice calls)
    const members = [u, ...this.store.callPeers(u)].map(m => m.id).sort();
    const turn = Math.floor(this.store.now() / 1800); // ~1.8 s turns
    const h = hash(`${u.callId}|${turn}`);
    if (h % 6 === 0) return false; // a beat of silence now and then
    return members[(h >> 3) % members.length] === u.id;
  }

  private playing(o?: MapObject) { return !!o && this.store.connected && this.store.jukebox[o.id]?.pausedAt === null; }
  /** In a room whose jukebox plays; not Berghain's floor, where the `dance` effect has its own routine. */
  private dancing(u: ClientUser, t: Tile) {
    if (!this.parties.length || u.effects?.some(e => e.kind === 'dance')) return false;
    const r = roomAt(MAP, t.x, t.y); return !!r && r.id !== DANCE_ROOM && this.parties.includes(r.id);
  }

  private isOn(o: MapObject) { return o.use?.kind !== 'toggle' || (this.store.objects[o.id]?.on ?? o.on ?? true); }

  /** A soft pulsing ring under whatever the action wheel is open for. */
  private drawSelection(sel: Pick, poses: Map<string, Pose>, ms: number) {
    const ctx = this.ctx;
    let cx: number, cy: number, rx: number;
    if (sel.kind === 'user') {
      const p = poses.get(sel.id); if (!p) return;
      cx = p.x * TS + 8; cy = p.y * TS + TS - 1.5; rx = 7;
    } else {
      const o = objectById(MAP, sel.id); if (!o) return;
      cx = (o.x + o.w / 2) * TS; cy = (o.y + o.h) * TS - 1; rx = o.w * 8 + 1;
    }
    const k = 1 + Math.sin(ms / 180) * 0.12;
    ctx.strokeStyle = 'rgba(255,224,138,0.9)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx * k, 3 * k, 0, 0, Math.PI * 2); ctx.stroke();
  }

  /** Reactions: hop from the sender to the receiver, then float up over their head and fade. */
  private drawReactions(poses: Map<string, Pose>, ms: number) {
    const ctx = this.ctx, FLY = 450, FLOAT = 1800;
    this.store.reactions = this.store.reactions.filter(r => ms - r.at < FLY + FLOAT);
    const head = (id: string) => { const p = poses.get(id); return p && { x: p.x * TS + 8, y: p.y * TS + TS - 30 }; };
    ctx.fillStyle = '#000'; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const stack = new Map<string, number>(); // several at once fan out sideways
    for (const r of this.store.reactions) {
      const to = head(r.toId); if (!to) continue;
      const from = r.fromId !== r.toId ? head(r.fromId) : undefined;
      const age = ms - r.at, n = stack.get(r.toId) ?? 0; stack.set(r.toId, n + 1);
      const fly = from ? FLY : 0;
      let x: number, y: number, a = 1;
      if (age < fly) {
        const f = age / fly;
        x = from!.x + (to.x - from!.x) * f; y = from!.y + (to.y - from!.y) * f - Math.sin(f * Math.PI) * 14;
      } else {
        const f = Math.min(1, (age - fly) / FLOAT);
        x = to.x + ((n % 3) - 1) * 7 + Math.sin(f * 9 + n) * 1.5; y = to.y - 4 - f * 16; a = f < 0.7 ? 1 : 1 - (f - 0.7) / 0.3;
      }
      ctx.globalAlpha = Math.max(0, a);
      const art = r.item ? itemDef(emptyDrink(r.item) ?? r.item)?.sprite ?? 'item_box' : REACTION_FRAME[r.emoji], af = art ? this.f(art) : undefined; // pixel art, else the emoji
      if (af) this.blit(ctx, art!, Math.round(x - af.w / 2), Math.round(y - af.h / 2));
      else ctx.fillText(r.emoji, Math.round(x), Math.round(y));
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }

  private drawSteam(o: MapObject, ms: number) {
    const ctx = this.ctx;
    const cx = o.x * TS + 8, top = (o.y + o.h) * TS - 32;
    for (let i = 0; i < 6; i++) {
      const ph = ((ms / 1400) + i / 6) % 1;
      const x = cx + Math.round(Math.sin(ph * 7 + i * 1.7) * 2) - 1;
      const y = top - Math.round(ph * 14);
      ctx.fillStyle = `rgba(255,252,245,${(0.75 * (1 - ph)).toFixed(2)})`;
      const s = ph < 0.5 ? 1 : 2;
      ctx.fillRect(x, y, s, s);
    }
  }

  /** Edit mode: a tile grid, what's under the pointer, the selection, and where a dragged or new thing would land. */
  private drawEdit(ctx: CanvasRenderingContext2D, camX: number, camY: number, ms: number) {
    const x0 = Math.max(MAP.office.x, Math.floor(camX / TS)), x1 = Math.min(MAP.office.x + MAP.office.w, Math.ceil((camX + this.viewW) / TS));
    const y0 = Math.max(MAP.office.y, Math.floor(camY / TS)), y1 = Math.min(MAP.office.y + MAP.office.h, Math.ceil((camY + this.viewH) / TS));
    ctx.strokeStyle = 'rgba(255,240,200,0.2)'; ctx.lineWidth = 1 / this.px;
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) { ctx.moveTo(x * TS, y0 * TS); ctx.lineTo(x * TS, y1 * TS); }
    for (let y = y0; y <= y1; y++) { ctx.moveTo(x0 * TS, y * TS); ctx.lineTo(x1 * TS, y * TS); }
    ctx.stroke();
    // the footprint shaded, the whole sprite outlined
    const outline = (it: Item, color: string, fill: string, dash: boolean) => {
      const s = it.color ? null : this.sprite(it);
      const x = Math.min(it.x * TS, s?.x ?? Infinity), y = Math.min(it.y * TS, s?.y ?? Infinity);
      const r = Math.max((it.x + it.w) * TS, s ? s.x + s.fr.w : 0), b = Math.max((it.y + it.h) * TS, s ? s.y + s.fr.h : 0);
      ctx.fillStyle = fill; ctx.fillRect(it.x * TS, it.y * TS, it.w * TS, it.h * TS);
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dash ? [2, 2] : []);
      ctx.strokeRect(Math.round(x) - 0.5, Math.round(y) - 0.5, Math.round(r - x) + 1, Math.round(b - y) + 1); ctx.setLineDash([]);
    };
    const hover = this.editHover && this.editHover.id !== this.editSel ? this.editHover : null;
    if (hover) outline(hover, 'rgba(255,255,255,0.85)', 'rgba(255,255,255,0.1)', true);
    const sel = this.editSel ? this.item(this.editSel) : undefined;
    if (sel) outline(sel, `rgba(255,214,110,${(0.8 + Math.sin(ms / 180) * 0.2).toFixed(2)})`, 'rgba(255,214,110,0.22)', false);
    const g = this.ghost;
    if (g) {
      ctx.globalAlpha = 0.7; this.drawItem(ctx, g.item); ctx.globalAlpha = 1;
      ctx.fillStyle = g.problem ? 'rgba(220,60,50,0.38)' : 'rgba(90,200,110,0.3)';
      ctx.fillRect(g.item.x * TS, g.item.y * TS, g.item.w * TS, g.item.h * TS);
    }
    // labels last: they draw in screen space
    if (g?.problem) this.drawLabel(g.problem, (g.item.x + g.item.w / 2) * TS, g.item.y * TS, camX, camY);
    else if (hover) this.drawLabel(hover.type ? objectName(hover.type) : 'rug', (hover.x + hover.w / 2) * TS, hover.y * TS, camX, camY);
  }

  private toiletTip(id: string) {
    const s = this.store.toilets[id];
    if (toiletFull(s)) return 'Toilet · out of order 🤢';
    const names = (ids: string[]) => ids.map(id => this.store.name(id).split(' ')[0]).join(', ');
    const line = s?.queue.length ? ` · ${s.queue.length} in line` : '';
    if (s?.in.includes(this.store.me)) return `Toilet · you're in here${s.in.length > 1 ? ` with ${names(s.in.filter(id => id !== this.store.me))}` : ''}`;
    if (s?.in.length) return `Toilet · ${s.in.length}/${TOILET_CAPACITY} inside (${names(s.in)})${line}`;
    return `Toilet · ${s?.fill ? `used ${s.fill}× · ` : ''}click to use`;
  }
  private toiletFrame(id: string) {
    const s = this.store.toilets[id];
    return toiletFull(s) ? 'toilet_full' : s?.in.length ? 'toilet_busy' : 'toilet';
  }
  private inStall(id: string) { for (const s of Object.values(this.store.toilets)) if (s.in.includes(id)) return true; return false; }
  /** Over a stall's sprite: the lines and the card on its shelf, and the heads of whoever's inside, over the half door. */
  private drawStall(ctx: CanvasRenderingContext2D, o: MapObject, x: number, y: number) {
    const s = this.store.toilets[o.id]; if (!s) return;
    for (let i = 0; i < s.shelf; i++) { ctx.fillStyle = '#f4f2f8'; ctx.fillRect(x + 18, y + 6 + i, 5, 1); }
    if (s.shelf) { ctx.fillStyle = '#e8c840'; ctx.fillRect(x + 24, y + 7, 4, 2); ctx.fillStyle = '#8a6a20'; ctx.fillRect(x + 24, y + 8, 4, 1); }
    s.in.forEach((id, i) => {
      const u = this.store.users.get(id); if (!u || (this.store.pose(u).walking)) return;
      const hx = x + 4 + i * 6, hy = y + 11;
      ctx.fillStyle = u.look.skin; ctx.fillRect(hx, hy + 1, 5, 4);
      ctx.fillStyle = u.look.hair; ctx.fillRect(hx, hy, 5, 2); ctx.fillRect(hx, hy + 2, 1, 2);
      ctx.fillStyle = '#2a2433'; ctx.fillRect(hx + 1, hy + 3, 1, 1); ctx.fillRect(hx + 3, hy + 3, 1, 1);
    });
  }
  /** Berghain: slow neon washes and a strobe now and then, over the club's own floor. */
  private drawClub(ctx: CanvasRenderingContext2D, ms: number) {
    for (const r of MAP.rooms) {
      if (r.type !== 'club') continue;
      const x = r.rect.x * TS, y = (r.rect.y - 1) * TS, w = r.rect.w * TS, h = (r.rect.h + 1) * TS;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) { // three coloured spots drifting around the room
        const a = ms / (2600 + i * 700) + i * 2.1, cx = x + w / 2 + Math.cos(a) * w * 0.32, cy = y + h / 2 + Math.sin(a * 1.3) * h * 0.3;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 40);
        g.addColorStop(0, ['rgba(255,60,200,0.28)', 'rgba(60,220,255,0.24)', 'rgba(150,80,255,0.26)'][i]); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
      }
      const beat = ms % 2400; // a quick double flash every couple of seconds
      if (beat < 60 || (beat > 140 && beat < 190)) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x, y, w, h); }
      ctx.restore();
    }
  }
  /** Weather on the floor: rain through open windows and over the open sky, fog around you. Drawn before the labels. */
  private drawSky(ctx: CanvasRenderingContext2D, poses: Map<string, Pose>, me: ClientUser | undefined, ms: number) {
    const sky = this.store.sky;
    if (sky === 'clear') return;
    const v = this.vis;
    for (const o of this.windows) {
      if (!this.windowOpen(o) || !this.onScreen(o.x * TS, o.y * TS, o.w * TS, o.h * TS)) continue;
      const gx = o.x * TS + 8, gy = o.y * TS + 5; // the gap between the folded sashes
      if (sky === 'rain') this.fx.drawWindowRain(ctx, gx, gy, 16, 18, this.rainClock);
      else { ctx.fillStyle = 'rgba(196,206,214,0.55)'; ctx.fillRect(gx, gy, 16, 18); }
    }
    if (sky === 'rain' && this.px >= 1) this.fx.drawRain(ctx, v, this.rainClock);
    const p = me && poses.get(me.id);
    if (sky === 'fog' && p && !this.tapZooms && this.fx.skyInView(v)) this.fx.drawFog(ctx, v, p.x * TS + 8, p.y * TS + 8, ms);
  }

  /** The night: one cached lightmap (rebuilt only when the hour, the weather, a light switch or the layout changes), warm glows on the lamps, and moving lights. */
  private lightInfo = { night: 0, raw: 0 };
  private drawAmbient(ctx: CanvasRenderingContext2D, ms: number, h: number, users: ClientUser[], poses: Map<string, Pose>) {
    const key = lightmapKey({ hourBucket: hourBucket(h), weather: this.store.sky, lights: this.litObjects.map(o => (this.isOn(o) ? 1 : 0)).join(''), layout: this.store.layoutVersion });
    if (key !== this.lightmapKey) { this.lightmapKey = key; this.lightInfo = paintLightmap(this.lightmap, MAP, h, this.store.sky, o => this.isOn(o)); }
    const { night, raw } = this.lightInfo, v = this.vis;
    ctx.save();
    if (night > 0.01) {
      const sx = Math.max(0, Math.floor(v.x0 / TS * LM)), sy = Math.max(0, Math.floor(v.y0 / TS * LM));
      const ex = Math.min(this.lightmap.width, Math.ceil(v.x1 / TS * LM)), ey = Math.min(this.lightmap.height, Math.ceil(v.y1 / TS * LM));
      ctx.globalAlpha = this.editing ? 0.3 : 1; // edit mode stays readable
      ctx.imageSmoothingEnabled = true;
      if (ex > sx && ey > sy) ctx.drawImage(this.lightmap, sx, sy, ex - sx, ey - sy, sx * TS / LM, sy * TS / LM, (ex - sx) * TS / LM, (ey - sy) * TS / LM);
    }
    // lamps that are on glow: softly by day, warmly in the evening
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.max(0.1, raw * 0.5 * 0.55);
    const day = ctx.globalAlpha;
    for (const o of this.lights) {
      if (!this.isOn(o)) continue;
      if (o.type === 'reading_table') { // the banker's lamp sits mid-table, its pool on the top and a little beyond
        ctx.globalAlpha = Math.max(0.18, day) * (this.flickers(o, ms) ? 0.6 : 1);
        ctx.drawImage(this.greenGlow, (o.x + o.w / 2) * TS - 28, (o.y + o.h) * TS - 14 - 28);
        ctx.globalAlpha = day;
      } else ctx.drawImage(this.glow, o.x * TS + 8 - 40, (o.y + o.h) * TS - 26 - 40);
    }
    if (night > 0.05) for (const u of users) { // moving lights: whoever carries one (see personLight.ts)
      const r = personLight(u); if (r <= 0) continue;
      const p = poses.get(u.id)!, cx = p.x * TS + 8, cy = p.y * TS + 4;
      ctx.globalAlpha = Math.min(0.8, night); ctx.drawImage(this.glow, cx - r * TS, cy - r * TS, r * TS * 2, r * TS * 2);
    }
    ctx.restore();
    const dusk = evening(h);
    if (dusk && !this.store.users.get(this.store.me)?.instance) for (const f of this.furniture) {
      if (f.o.type === 'out_of_office_sign' && this.onScreen(f.x - 12, f.y - 12, 136, 72)) drawBeachSign(ctx, f.x, f.y, dusk);
    }
  }

  /** The meetings board says when something's on: a count badge, bouncing and glowing when one is yours to Go to. */
  private drawBoardBadges(ctx: CanvasRenderingContext2D, ms: number) {
    const count = this.store.meetingRooms.length, now = this.store.now();
    const mine = this.store.agenda.some(a => a.start - 10 * 60_000 <= now && a.end > now);
    if (!count && !mine) return;
    const text = count ? String(count) : '!', color = mine ? '#f2b45a' : '#7cc87c';
    const pulse = mine ? (Math.sin(ms / 220) + 1) / 2 : 0;
    for (const o of this.boards) {
      const bx = o.x * TS, by = o.y * TS;
      if (mine) { // a soft glow around the board
        ctx.strokeStyle = `rgba(242,180,90,${0.35 + 0.45 * pulse})`; ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, by + 1.5, TS - 1, TS - 3);
      }
      const w = textWidth(text) + 4, h = 7;
      const x = Math.round(bx + TS - w / 2 - 1), y = Math.round(by - 4 - (mine ? Math.round(pulse * 2) : 0));
      ctx.fillStyle = '#3a2329'; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
      ctx.fillStyle = color; ctx.fillRect(x, y, w, h);
      drawText(ctx, text, x + 2, y + 1, '#2a1f24');
    }
  }

  /** Admins: how many tickets are open, over the bug terminal's screen; amber and bobbing while some wait on an admin. */
  private drawTerminalBadge(ctx: CanvasRenderingContext2D, ms: number) {
    if (!this.store.admin) return;
    const open = this.store.tickets.filter(t => t.status === 'open');
    if (!open.length) return;
    const waiting = open.some(t => this.store.ticketUnread(t)), text = String(open.length);
    const bob = waiting ? Math.round((Math.sin(ms / 220) + 1)) : 0;
    for (const o of MAP.objects) {
      if (o.use?.kind !== 'tickets') continue;
      const fr = this.f(o.type), top = (o.y + o.h) * TS - (fr?.h ?? TS);
      const w = textWidth(text) + 4, h = 7;
      const x = Math.round(o.x * TS + o.w * TS / 2 + 6), y = top - 5 - bob;
      ctx.fillStyle = '#3a2329'; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
      ctx.fillStyle = waiting ? '#f2b45a' : '#7cc87c'; ctx.fillRect(x, y, w, h);
      drawText(ctx, text, x + 2, y + 1, '#2a1f24');
    }
  }

  /** The booking kiosk's screen breathes, so it reads as something to press rather than decor. */
  private drawKiosks(ctx: CanvasRenderingContext2D, ms: number) {
    const glow = 0.1 + 0.16 * (Math.sin(ms / 600) + 1) / 2;
    for (const o of this.kiosks) {
      const x = o.x * TS + (o.w * TS - 16) / 2, y = (o.y + o.h) * TS - 28; // the sprite's own box (16×28, bottom-aligned)
      ctx.fillStyle = `rgba(170,255,210,${glow})`; ctx.fillRect(x + 3, y + 4, 10, 9);
    }
  }

  /** Slides are up: the screen glows and flashes a LIVE tag, so people outside the room notice. */
  private drawLiveScreen(ctx: CanvasRenderingContext2D, ms: number) {
    const live = this.store.presentation, o = live && MAP.objects.find(o => o.id === live.objectId);
    if (!o) return;
    const pulse = (Math.sin(ms / 260) + 1) / 2, x = o.x * TS, y = o.y * TS, w = o.w * TS;
    ctx.fillStyle = `rgba(120,230,255,${0.25 + 0.25 * pulse})`; ctx.fillRect(x + 4, y + 6, w - 8, 14); // the picture lights up
    for (let i = 0; i < 3; i++) { // a soft halo
      ctx.strokeStyle = `rgba(255,80,200,${(0.5 - i * 0.15) * (0.6 + 0.4 * pulse)})`; ctx.lineWidth = 1;
      ctx.strokeRect(x + 1.5 - i, y + 3.5 - i, w - 3 + i * 2, 20 + i * 2);
    }
    const text = 'LIVE', tw = textWidth(text) + 4, tx = Math.round(x + w / 2 - tw / 2), ty = Math.round(y - 3 - Math.round(pulse * 2));
    ctx.fillStyle = '#3a2329'; ctx.fillRect(tx - 1, ty - 1, tw + 2, 9);
    ctx.fillStyle = Math.floor(ms / 500) % 2 ? '#ff4fa8' : '#ffe14f'; ctx.fillRect(tx, ty, tw, 7);
    drawText(ctx, text, tx + 2, ty + 1, '#2a1f24');
  }

  /** Overview: each room's name and headcount on its floor, and a pin over me. */
  private drawRoomTags(users: ClientUser[], poses: Map<string, Pose>, camX: number, camY: number) {
    const count = new Map<string, number>();
    for (const u of users) { const p = poses.get(u.id)!, r = roomAt(MAP, p.tile.x, p.tile.y); if (r) count.set(r.id, (count.get(r.id) ?? 0) + 1); }
    for (const r of MAP.rooms) {
      const n = count.get(r.id) ?? 0;
      this.drawLabel(n ? `${r.name} · ${n}` : r.name, (r.rect.x + r.rect.w / 2) * TS, (r.rect.y + r.rect.h / 2) * TS + 13 / this.px * this.dpr, camX, camY, n ? 1 : 0.6);
    }
    const mp = poses.get(this.store.me);
    if (mp) this.drawLabel('You', mp.x * TS + 8, mp.y * TS + TS - 26, camX, camY, 1, true);
  }

  /** Two frames: the bell dips a pixel for the first ~300 ms after a ring. */
  private bellFrame(id: string) {
    const ring = this.store.bells[id], age = ring ? performance.now() - ring.at : Infinity;
    return age < 300 && Math.floor(age / 100) % 2 === 0 ? 'bell_1' : 'bell';
  }
  /** A reading table's lamp dips for a moment now and then (offset per table so they don't flicker together). */
  private flickers(o: MapObject, ms: number) {
    const t = (ms + hash(o.id) * 1301) % 7000;
    return t < 90 || (t > 180 && t < 240);
  }
  /** Two frames: every few seconds one hat swings for a moment (offset per rack so several don't sync). */
  private hatRackFrame(o: MapObject, ms: number) {
    return (ms + hash(o.id) * 997) % 4500 < 450 ? 'hat_rack_1' : 'hat_rack';
  }
  /** A small "ding" over whoever rang a bell, for about a second. */
  private drawBellDings(poses: Map<string, Pose>, camX: number, camY: number) {
    const now = performance.now();
    for (const ring of Object.values(this.store.bells)) {
      const age = now - ring.at, p = poses.get(ring.userId);
      if (age > 1000 || !p) continue;
      this.drawLabel('ding!', p.x * TS + 8, p.y * TS - 18 - Math.round(age / 120), camX, camY, age < 700 ? 1 : 1 - (age - 700) / 300);
    }
  }
  /** Once per device: walking within two tiles of the hat rack with nothing in your pockets suggests a hat. */
  private hatNudgeAt: number | null = null;
  private drawHatNudge(me: ClientUser | undefined, poses: Map<string, Pose>, camX: number, camY: number, ms: number) {
    const p = me && poses.get(me.id);
    if (!p || !this.store.connected || this.store.items.some(i => i.startsWith('hat:'))) return;
    const rack = MAP.objects.find(o => o.type === 'hat_rack'); if (!rack) return;
    const near = Math.max(rack.x - p.tile.x, p.tile.x - (rack.x + rack.w - 1), 0) <= 2 && Math.max(rack.y - p.tile.y, p.tile.y - (rack.y + rack.h - 1), 0) <= 2;
    if (this.hatNudgeAt === null) {
      if (!near) return;
      try { if (localStorage.getItem('deck.hatNudge')) { this.hatNudgeAt = -Infinity; return; } localStorage.setItem('deck.hatNudge', '1'); } catch { /* private mode: nudge once per page */ }
      this.hatNudgeAt = ms;
    }
    const age = ms - this.hatNudgeAt;
    if (age > 5000) return;
    this.drawLabel('Grab a hat? 🎩', (rack.x + rack.w / 2) * TS, rack.y * TS - 8 - Math.round((Math.sin(ms / 220) + 1)), camX, camY, age > 4000 ? 5 - age / 1000 : 1, true);
  }

  private drawLabel(text: string, wx: number, wy: number, camX: number, camY: number, alpha = 1, accent = false, size = 12) {
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `600 ${size}px ui-rounded, system-ui, sans-serif`;
    const w = ctx.measureText(text).width + size * 1.17, h = Math.round(size * 1.83);
    const sx = ((wx - camX) * this.px) / dpr - w / 2, sy = ((wy - camY) * this.px) / dpr - h - 4;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = accent ? 'rgba(90,50,20,0.96)' : 'rgba(33,22,26,0.94)'; ctx.strokeStyle = accent ? '#f2b45a' : '#8a5a3c'; ctx.lineWidth = size < 12 ? 1.5 : 2;
    ctx.beginPath(); ctx.roundRect(sx, sy, w, h, size < 12 ? 5 : 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = accent ? '#ffe08a' : '#ffe9c4'; ctx.fillText(text, sx + size * 0.58, sy + h * 0.68);
    ctx.globalAlpha = 1;
  }
}
