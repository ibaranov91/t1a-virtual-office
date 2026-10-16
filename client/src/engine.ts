import { INSTRUMENTS } from '../../shared/instruments';
// The floor: one <canvas>, one requestAnimationFrame loop.
// Order: static tilemap → y-sorted furniture + sprites → nameplates & bubbles → ambient tint → UI hints.
import { adminOnly, applyEdit, FIXED_TYPES, findPath, pathTo, sampleMove, pathDuration, WALK_MS_PER_TILE, isWalkable, layoutProblem, objectById, objectName, roomAt, seatAt, withLayout, type MapObject, type Rect, type Rug, type Tile } from '../../shared/map';
import { FOOD_ITEMS, picnicSeat } from '../../shared/lunch';
import { DungeonView } from './dungeon';
import { danceBeat, dancePhase } from '../../shared/effects';
import { drawEffects, effectLook, effectSway } from './effects';
import { CreatureLayer } from './creatures';
import { lockedDoors, roomDoors, type RoomDoor } from './doors';
import type { Assets, Frame } from './assets';
import { drawText, textWidth } from './font';
import { TRACK } from '../../shared/music';
import { TOILET_CAPACITY, toiletFull, cupTableAt, CUP_ITEMS, underground, MEETING_ROOM_ID, PLANT_REVEAL, PLANT_STAGES, plantDead, plantName, type Cup, type LayoutEdit } from '../../shared/protocol';
import { ITEMS, MAP, type ClientUser, type Pose, type Store, type DungeonFx } from './net';

const TS = MAP.tileSize;
/** "🕒 14:35 · Warsaw", plus "tomorrow"/"yesterday" when their date isn't mine. */
function localTime(tz: string) {
  const now = new Date(), day = (z?: string) => new Intl.DateTimeFormat('en-CA', { timeZone: z }).format(now), theirs = day(tz), mine = day();
  const time = new Intl.DateTimeFormat([], { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(now);
  return `🕒 ${time}${theirs === mine ? '' : theirs > mine ? ' tomorrow' : ' yesterday'} · ${tz.split('/').pop()!.replace(/_/g, ' ')}`;
}
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

type BubbleKind = 'bubble_game' | 'bubble_watch' | 'bubble_bang' | 'bubble_headset' | 'bubble_zzz' | 'bubble_meeting' | 'bubble_think' | 'bubble_talk' | 'bubble_hand' | 'bubble_deaf' | 'bubble_mute_deaf';
// where the bag hangs when carried, per facing; behind = drawn before the body
const BAG_HAND: Record<string, { dx: number; behind: boolean }> = {
  down: { dx: 10, behind: false }, up: { dx: -3, behind: false }, left: { dx: 7, behind: true }, right: { dx: -1, behind: true },
};

/** What a click landed on; the action wheel opens for it. */
export type Pick = { kind: 'user' | 'object'; id: string };
/** Something an admin can pick up in edit mode: a piece of furniture or a rug. */
type Item = { id: string; x: number; y: number; w: number; h: number; type?: string; wall?: boolean; dir?: string; color?: string };

// item id -> icon, from whatever the map's objects hand out
const ITEM_ICON = new Map([...ITEMS].map(([id, i]) => [id, i.icon]));
const ITEM_HAND: Record<string, { dx: number; dy: number }> = { down: { dx: 13, dy: -9 }, up: { dx: 3, dy: -10 }, left: { dx: 3, dy: -9 }, right: { dx: 13, dy: -9 } };

const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

export class Engine {
  private dungeonView = new DungeonView(MAP);
  private area: Rect = MAP.office;
  private areaDown = false;
  private actualDown = false;
  private held = new Map<string, [number, number]>();
  private stepPending: { to: Tile; at: number } | null = null;
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
  private hoverUser: string | null = null;
  private hoverObject: MapObject | null = null;
  private interactive: MapObject[];
  private boards: MapObject[]; // meetings boards: a badge when meetings are on
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
  private steamers: MapObject[];
  private noteSeen = new Map<string, number>();
  private instrumentNotes: { id: string; at: number }[] = [];
  private sounders: MapObject[];
  private statusSeen = new Map<string, { text: string; at: number }>();
  private placedPlates: { x: number; y: number; w: number }[] = [];
  private snapped = false;
  private slots: Tile[] = [];
  private layoutSeen = -1;
  private doors: RoomDoor[] = [];
  private deniedAt = new Map<string, number>(); // room id → when a locked door last turned someone away (it shakes)
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
    this.staticLayer = this.furniture = this.lights = this.steamers = this.sounders = this.interactive = this.boards = null!;
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
    if (r.rules.access && !this.store.admin) { this.focusRoom(id); return this.denyDoor(r.rect.x, r.rect.y); }
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
    return new Set([...this.store.users.values()].filter(u => u.id !== this.store.me && u.presence !== 'offline' && u.instance === this.myInstance()).map(u => `${u.tile.x},${u.tile.y}`));
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
    this.doors = [...roomDoors(MAP), ...lockedDoors(MAP)];
    this.staticLayer = this.buildStatic();
    this.furniture = MAP.objects.filter(o => !o.wall && !o.walkable && this.f(o.type)).map(o => {
      const fr = this.f(o.type);
      return { o, x: o.x * TS + (o.w * TS - fr.w) / 2, y: (o.y + o.h) * TS - fr.h, base: (o.y + o.h) * TS - 0.5, off: !!this.f(`${o.type}_off`) };
    }).sort((a, b) => a.base - b.base);
    this.lights = MAP.objects.filter(o => o.light);
    this.steamers = MAP.objects.filter(o => o.steam);
    this.sounders = MAP.objects.filter(o => o.sound);
    this.plantsVersion = -1; // shelves may have moved
    this.interactive = MAP.objects.filter(o => o.use || o.sit);
    this.boards = MAP.objects.filter(o => o.use?.kind === 'meetings');
    this.slots = MAP.rooms.flatMap(r => r.plantSlots ?? []);
    if (this.editSel && !this.item(this.editSel)) this.editSel = null;
    if (this.store.added) { this.editSel = this.store.added; this.store.added = null; }
    this.ghost = null;
    this.onEditChange?.();
  }

  // ---------- frames ----------
  private f(name: string): Frame { return this.assets.atlas.frames[name]; }
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
    return c;
  }
  private drawRug(ctx: CanvasRenderingContext2D, r: Rug) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const v = y === r.y ? 'n' : y === r.y + r.h - 1 ? 's' : '', h = x === r.x ? 'w' : x === r.x + r.w - 1 ? 'e' : '';
      this.blit(ctx, `rug_${r.color}_${(v + h) || 'c'}`, x * TS, y * TS);
    }
  }
  /** A piece of furniture's sprite and where it goes: centred on its footprint, standing on its bottom edge (decor hangs from the top). */
  private sprite(o: Item) {
    const name = o.dir && this.f(`${o.type}_${o.dir}`) ? `${o.type}_${o.dir}` : o.type!; // chairs face their desk
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
      const { h, m } = zoneHM(o.use.tz), cx = s.x + 8, cy = s.y + 7;
      const hand = (turns: number, len: number, color: string) => {
        ctx.fillStyle = color;
        const a = turns * Math.PI * 2;
        for (let r = 0; r <= len; r += 0.5) ctx.fillRect(Math.round(cx + Math.sin(a) * r), Math.round(cy - Math.cos(a) * r), 1, 1);
      };
      hand(((h % 12) + m / 60) / 12, 2.5, '#3a2a2a'); hand(m / 60, 4, '#3a2a2a');
      ctx.fillStyle = '#b4534a'; ctx.fillRect(cx, cy, 1, 1);
      ctx.font = 'bold 4px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; // the zone's name under the face
      ctx.fillStyle = 'rgba(40,20,20,0.7)'; ctx.fillText(o.use.label, cx + 0.3, s.y + 15.3);
      ctx.fillStyle = '#ffe9c4'; ctx.fillText(o.use.label, cx, s.y + 15);
    }
  }
  private drawItem(ctx: CanvasRenderingContext2D, o: Item) {
    if (o.color) return this.drawRug(ctx, o as Rug);
    const s = this.sprite(o); if (s) this.blit(ctx, s.name, s.x, s.y);
  }

  // ---------- layout ----------
  private resize() {
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
  private get tapZooms() { return this.overview && this.minPx / this.dpr < 1.5; }
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
    if (!this.store.admin && adminOnly(MAP, t.x, t.y)) return false; // the server would refuse it too
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
    if (!u || u.presence === 'offline' || u.instance !== this.myInstance()) return false;
    if (!this.areaDown && this.inStall(u.id) && !this.store.pose(u).walking) return false; // behind the stall door (their head peeks over it)
    return !this.areaDown || u.id === this.store.me || !!this.store.dungeon && this.dungeonView.canSee(this.store.pose(u).tile);
  }
  private myInstance() { return this.falling() ? null : this.store.users.get(this.store.me)?.instance ?? null; }
  private userAt(wx: number, wy: number): string | null {
    const t = this.store.now();
    let best: { id: string; base: number } | null = null;
    for (const u of this.store.users.values()) {
      if (!this.visible(u)) continue;
      const p = this.store.pose(u, t);
      const sx = p.x * TS, sy = p.y * TS + TS - 24;
      if (wx >= sx + 2 && wx < sx + 14 && wy >= sy && wy < sy + 26) {
        const base = sy + 24;
        if (!best || base > best.base) best = { id: u.id, base };
      }
    }
    return best?.id ?? null;
  }
  /** The sofa seat you clicked, or the nearest free one on that sofa if someone's sitting there. */
  private freeSeat(o: MapObject, x: number) {
    const taken = new Set([...this.store.users.values()].filter(u => u.presence !== 'offline' && u.id !== this.store.me).map(u => `${u.tile.x},${u.tile.y}`));
    const seats = Array.from({ length: o.w }, (_, i) => ({ x: o.x + i, y: o.y })).filter(t => !taken.has(`${t.x},${t.y}`));
    seats.sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x));
    return seats[0] ?? { x: Math.max(o.x, Math.min(o.x + o.w - 1, x)), y: o.y };
  }
  /** Sprite of an object you can use under this point. */
  /** Holding a coffee or tea over a free table tile in the office: that's where it can go. */
  private cupTarget(t: Tile): Tile | null {
    const me = this.store.users.get(this.store.me);
    if (!me?.holding || !CUP_ITEMS.includes(me.holding) || me.instance || this.areaDown || !cupTableAt(MAP.objects, t)) return null;
    return this.store.cups.some(c => c.tile.x === t.x && c.tile.y === t.y) ? null : t;
  }
  /** Holding food over a chair at a picnic table: that's where lunch happens. */
  private lunchChair(t: Tile): MapObject | null {
    const me = this.store.users.get(this.store.me);
    if (!me?.holding || !FOOD_ITEMS.includes(me.holding) || me.instance || this.areaDown || !picnicSeat(MAP, t)) return null;
    return MAP.objects.find(o => o.type === 'chair' && o.x === t.x && o.y === t.y) ?? null;
  }
  private objectAt(wx: number, wy: number): MapObject | null {
    let best: MapObject | null = null;
    for (const o of this.interactive) {
      const fr = this.f(o.type); if (!fr) continue;
      const x = o.x * TS + (o.w * TS - fr.w) / 2, y = (o.y + o.h) * TS - fr.h;
      if (wx >= x + 1 && wx < x + fr.w - 1 && wy >= y + 1 && wy < y + fr.h && (!best || o.y + o.h > best.y + best.h)) best = o;
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
    if (this.store.seat || this.store.gameOpen) return;
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
  /** Edit mode keys: arrows nudge (shift+arrows resize a rug), Delete removes, Esc lets go. */
  private onEditKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && (this.placing || this.editSel)) { if (this.placing) this.setPlacing(null); else this.select(null); return true; }
    const sel = this.editSel ? this.item(this.editSel) : undefined;
    if (!sel) return false;
    const step = ({ ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[e.key];
    if (step && e.shiftKey && sel.color) this.store.edit({ op: 'rug', id: sel.id, w: sel.w + step[0], h: sel.h + step[1] });
    else if (step) this.store.edit({ op: 'move', id: sel.id, x: sel.x + step[0], y: sel.y + step[1] });
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
    this.hoverObject = this.hoverUser || this.hoverCup || inside ? null : this.objectAt(w.x, w.y);
    this.hoverPlant = this.hoverUser || this.hoverObject || inside ? null
      : this.plants.find(p => w.x >= p.x - 5 && w.x < p.x + 5 && w.y >= p.y - 18 && w.y < p.y) ?? null;
    const tx = Math.floor(w.x / TS), ty = Math.floor(w.y / TS);
    this.hoverTile = this.clickTarget({ x: tx, y: ty });
    this.hoverCritter = this.hoverUser || this.hoverObject || inside || this.areaDown ? null : this.critters.at(w.x, w.y, this.store.now());
    this.cupTile = this.hoverUser || this.hoverObject || this.hoverCup ? null : this.cupTarget({ x: tx, y: ty });
    this.lunchTile = this.hoverUser || this.hoverObject || inside || !this.lunchChair({ x: tx, y: ty }) ? null : { x: tx, y: ty };
    this.canvas.style.cursor = this.tapZooms ? 'zoom-in' : this.hoverUser || this.hoverObject || this.hoverCup || this.cupTile || this.lunchTile || this.hoverCritter?.id ? 'pointer' : this.hoverTile ? 'crosshair' : 'default';
  };
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
    const hit = this.userAt(w.x, w.y);
    if (hit) return this.onPick?.({ kind: 'user', id: hit });
    const inside = this.myInstance();
    const critter = inside || this.areaDown ? null : this.critters.at(w.x, w.y, this.store.now());
    if (critter?.id) { this.onPick?.(null); this.manualCam = false; return this.store.pet(critter.id); }
    const cupHit = inside || this.areaDown ? null : this.critters.cupAt(w.x, w.y);
    if (cupHit) { this.onPick?.(null); this.manualCam = false; return this.store.takeCup(cupHit.id); }
    const obj = inside ? null : this.objectAt(w.x, w.y);
    if (obj?.sit) { this.onPick?.(null); this.manualCam = false; return this.store.moveTo(this.freeSeat(obj, Math.floor(w.x / TS))); }
    if (obj?.sound && obj.use?.kind !== 'jukebox') return this.onPick?.(null);
    if (obj) return this.onPick?.({ kind: 'object', id: obj.id });
    this.onPick?.(null);
    const tx = Math.floor(w.x / TS), ty = Math.floor(w.y / TS);
    const cup = this.cupTarget({ x: tx, y: ty });
    if (cup) { this.manualCam = false; return this.store.putCup(cup); }
    const chair = this.lunchChair({ x: tx, y: ty });
    if (chair) { this.manualCam = false; return this.onPick?.({ kind: 'object', id: chair.id }); }
    const target = this.clickTarget({ x: tx, y: ty });
    if (target) this.walkTo(target);
    else if (!this.store.admin && !this.areaDown && adminOnly(MAP, tx, ty)) this.denyDoor(tx, ty);
  };
  /** A locked room turned me away: its door shakes and says why. */
  private denyDoor(tx: number, ty: number) {
    const room = roomAt(MAP, tx, ty); if (!room) return;
    this.deniedAt.set(room.id, performance.now());
    this.store.toast({ kind: 'info', text: `🔒 ${room.name}: admins only`, expires: 3000 });
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
  /** Cap the redraw rate: 60 fps while anything moves or the user is interacting (ProMotion would otherwise draw 120), 30 when the floor is still. */
  private skipFrame(ms: number) {
    const busy = this.glide || this.editing || ms - this.lastInput < 1500 || [...this.store.users.values()].some(u => u.move && this.store.pose(u, this.store.now()).walking);
    const gap = ms - this.lastDraw;
    if (gap < (busy ? 15 : 31)) return true;
    this.lastDraw = ms;
    return false;
  }
  private frame = (ms: number) => {
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden || this.skipFrame(ms)) return;
    if (this.layoutSeen !== this.store.layoutVersion) this.refreshLayout();
    this.syncArea(); this.keyboardStep();
    const ctx = this.ctx, t = this.store.now();
    const me = this.store.users.get(this.store.me);
    if (this.areaDown && me && this.store.dungeon) {
      const others = [...this.store.users.values()].filter(u => u.id !== me.id && underground(u) && u.presence !== 'offline').map(u => this.store.pose(u, t).tile);
      this.dungeonView.update(this.store.pose(me, t).tile, others, this.store.dungeon.seen);
      if (this.hoverUser && !this.visible(this.store.users.get(this.hoverUser))) this.hoverUser = null;
      if (this.selected?.kind === 'user' && !this.visible(this.store.users.get(this.selected.id))) { this.selected = null; this.onPick?.(null); }
      if (this.hoverTile && !this.canWalk(this.hoverTile)) this.hoverTile = null;
    }
    const users = [...this.store.users.values()].filter(u => this.visible(u));
    const poses = new Map<string, Pose>(users.map(u => [u.id, this.store.pose(u, t)]));

    if (this.glide) { // zooming: the anchor point stays put while the scale eases to the next crisp level
      const g = this.glide, f = Math.min(1, (performance.now() - g.at) / 140);
      this.px = f >= 1 ? this.targetPx : g.from + (this.targetPx - g.from) * (1 - (1 - f) ** 3);
      if (f >= 1) this.glide = null;
      this.layoutView();
      this.cam = this.clampCam(g.wx - g.sx / this.px, g.wy - g.sy / this.px);
    }
    // camera follows me unless the user dragged
    else if (me && !this.manualCam && poses.get(me.id)) {
      const p = poses.get(me.id)!;
      const target = me.instance && !this.areaDown // a meeting's room: keep the room in the middle
        ? this.clampCam((MEETING.x + MEETING.w / 2) * TS - this.viewW / 2, (MEETING.y + MEETING.h / 2) * TS - this.viewH / 2)
        : this.clampCam(p.x * TS + 8 - this.viewW / 2, p.y * TS - this.viewH / 2);
      const k = this.snapped ? 0.12 : 1; this.snapped = true;
      this.cam.x += (target.x - this.cam.x) * k; this.cam.y += (target.y - this.cam.y) * k;
    }
    const camX = Math.round(this.cam.x * this.px) / this.px, camY = Math.round(this.cam.y * this.px) / this.px;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1b1418'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = this.px < 1;
    ctx.setTransform(this.px, 0, 0, this.px, -camX * this.px, -camY * this.px);
    ctx.save();
    ctx.beginPath(); ctx.rect(this.area.x * TS, this.area.y * TS, this.area.w * TS, this.area.h * TS); ctx.clip();
    ctx.drawImage(this.staticLayer, this.area.x * TS, this.area.y * TS, this.area.w * TS, this.area.h * TS,
      this.area.x * TS, this.area.y * TS, this.area.w * TS, this.area.h * TS);
    if (this.areaDown) this.drawDungeon(ms); else { this.drawDanceFloor(ctx, poses); this.drawClockHands(ctx); }

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

    // y-sorted drawables: furniture is sorted per layout (refreshLayout); people and plants are sorted here and merged in
    if (this.plantsVersion !== this.store.version) { this.plants = me?.instance ? [] : this.placePlants(); this.plantsVersion = this.store.version; }
    type D = { base: number; u?: ClientUser; p?: Pose; plant?: PlacedPlant; door?: RoomDoor; fx?: DungeonFx; draw?: () => void };
    const ds: D[] = [];
    if (!this.areaDown && !me?.instance) for (const c of this.critters.placed(t, ms)) ds.push(c);
    for (const door of this.areaDown ? [] : this.doors) ds.push({ base: (door.y + door.h) * TS - .5, door });
    for (const u of users) { const p = poses.get(u.id)!; ds.push({ base: p.y * TS + TS, u, p }); }
    if (!this.areaDown) for (const fx of this.store.dungeonFx) if (fx.kind === 'fall' && ms >= fx.at && ms - fx.at < 500) ds.push({ base: (fx.tile.y + 1) * TS, fx });
    for (const plant of this.plants) ds.push({ base: plant.base, plant });
    ds.sort((a, b) => a.base - b.base);
    const drawD = (d: D) => {
      if (d.draw) return d.draw();
      if (d.fx) return this.drawDungeonFx(d.fx, ms);
      if (d.u) {
        const fx = this.store.dungeonFx.find(f => f.user.id === d.u!.id && f.kind !== 'fall' && ms >= f.at && ms - f.at < 650 && (this.areaDown === (f.kind === 'land')));
        return fx ? this.drawDungeonFx(fx, ms) : this.drawSprite(d.u, d.p!, ms);
      }
      if (d.door) { // open while someone stands in or right next to the doorway; a locked one stays shut for non-admins
        const door = d.door, open = [...poses.values()].some(p => door.tiles.some(t => Math.abs(t.x - p.tile.x) + Math.abs(t.y - p.tile.y) <= 1));
        const locked = door.locked && !this.store.admin, age = ms - (this.deniedAt.get(door.room.id) ?? -1e9);
        const shake = locked && age < 450 ? Math.round(Math.sin(age / 22) * 2) : 0;
        const name = `door_${door.horizontal ? 'h' : 'v'}_${locked ? 'locked' : open ? 'open' : 'closed'}`, fr = this.f(name);
        return void (fr && this.blit(ctx, name, door.x * TS + (door.w * TS - fr.w) / 2 + shake, (door.y + door.h) * TS - fr.h));
      }
      const p = d.plant!, pl = p.u.plant!, kinded = pl.kind && pl.stage >= PLANT_REVEAL;
      this.blit(ctx, plantDead(pl, t) ? 'pot_dead' : kinded ? `pot_${pl.kind}_${pl.stage}` : `pot_${pl.stage}`, p.x - 6, p.y - 20);
    };
    let di = 0;
    for (const f of this.areaDown ? [] : this.furniture) {
      while (di < ds.length && ds[di].base <= f.base) drawD(ds[di++]);
      this.blit(ctx, f.o.type === 'arcade' && this.store.cabinets.some(c => c.cabinet === f.o.id) ? `arcade_on_${1 + Math.floor(ms / 320) % 2}` : f.o.use?.kind === 'toilet' ? this.toiletFrame(f.o.id)
        : f.o.type === 'bell' ? this.bellFrame(f.o.id, ms) : f.o.type === 'hat_rack' ? this.hatRackFrame(f.o, ms) : f.o.type === 'reading_table' && this.flickers(f.o, ms) ? 'reading_table_1'
        : f.o.type === 'server_rack' && Math.floor(ms / 500 + f.o.x * 3 + f.o.y) % 2 ? 'server_rack_1' : f.off && !this.isOn(f.o) ? `${f.o.type}_off` : f.o.type, f.x, f.y);
      if (f.o.use?.kind === 'toilet') this.drawStall(ctx, f.o, f.x, f.y);
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

    for (const o of this.areaDown ? [] : this.sounders) if (o.use?.kind === 'jukebox' && this.store.connected && this.store.jukebox[o.id]?.pausedAt === null) for (let i = 0; i < 3; i++) {
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

    if (!me?.instance) { this.drawBoardBadges(ctx, ms); this.drawLiveScreen(ctx, ms); }

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
    for (const u of sorted) this.drawOverlay(u, poses.get(u.id)!, ms);
    this.drawReactions(poses, ms);
    if (!this.areaDown && !me?.instance) this.drawClub(ctx, ms);
    if (!this.areaDown) this.drawAmbient(ctx, camX, camY, ms);
    // labels switch the canvas to screen space, so everything drawn in world space (the tint above) comes first
    if (!this.areaDown && !me?.instance) { this.drawBellDings(poses, camX, camY, ms); this.drawHatNudge(me, poses, camX, camY, ms); }
    if (this.editing) this.drawEdit(ctx, camX, camY, ms);
    if (this.overview && !me?.instance) this.drawRoomTags(users, poses, camX, camY);
    // one of my meetings is on: say so over the board, readable at any zoom
    const goable = me && !me.instance && this.hoverObject?.use?.kind !== 'meetings'
      ? this.store.agenda.find(a => a.start - 10 * 60_000 <= this.store.now() && a.end > this.store.now()) : undefined;
    if (goable) for (const o of this.boards) {
      const title = goable.title.length > 22 ? `${goable.title.slice(0, 21)}…` : goable.title;
      this.drawLabel(`📅 ${title} · click to go`, (o.x + 0.5) * TS, o.y * TS - 6 - Math.round((Math.sin(ms / 220) + 1)), camX, camY);
    }

    ctx.restore();
    // hover tooltip in screen space
    if (this.tapZooms || this.editing) { /* overview: room tags only; edit mode: its own labels */ }
    else if (this.hoverUser) this.drawTooltip(this.hoverUser, poses, camX, camY);
    else if (this.hoverObject && !this.selected) {
      const o = this.hoverObject, fr = this.f(o.type)!;
      const jukebox = this.store.jukebox[o.id], track = jukebox && TRACK.get(jukebox.track);
      const player = this.store.instruments[o.id];
      const instrumentTip = o.use?.kind === 'instrument' ? `${INSTRUMENTS[o.use.instrument].name} · ${this.store.seat === o.id ? "you're playing · Esc to stand up" : player === this.store.me ? "you're playing in another tab" : player ? `${this.store.name(player).split(' ')[0]} is playing` : 'click to play'}` : '';
      const what = instrumentTip || (o.use?.kind === 'arcade' ? this.store.gameDescription(o.id) : o.use?.kind === 'records' ? 'Deck Park · team records' : o.use?.kind === 'jukebox' ? !jukebox ? 'Jukebox · Reconnecting…' : jukebox.pausedAt !== null ? 'Jukebox · paused' : `Jukebox · ♪ ${track?.title ?? jukebox.track} — ${track?.artist ?? ''}` : o.use?.kind === 'toggle' ? `${o.use.label[0].toUpperCase()}${o.use.label.slice(1)} · ${this.isOn(o) ? 'on' : 'off'}`
        : o.use?.kind === 'calendar' ? 'Calendar · your week' : o.use?.kind === 'achievements' ? 'Notice board · your plant and achievements' : o.use?.kind === 'link' ? `Vault 13 · click to open the ${o.use.label}` : o.use?.kind === 'meetings' ? `Meetings · ${this.store.meetingRooms.length || 'none'} on now`
        : o.use?.kind === 'presentation' ? (this.store.presentation?.objectId === o.id ? `Screen · LIVE: ${this.store.presentation.deck.title}` : 'Screen · click to present slides') : o.use?.kind === 'clock' ? `Clock · ${o.use.city}, ${zoneTime(o.use.tz)} · click for all our cities` : o.sit ? `${o.type === 'bench' ? 'Bench' : 'Sofa'} · click to sit` : o.type === 'coffee_machine' ? 'Coffee machine' : o.type === 'fridge' ? 'Fridge' : o.use?.kind === 'toilet' ? this.toiletTip(o.id) : o.use?.kind === 'bell' ? 'Reception bell · click to ring' : o.type === 'reading_table' || o.type === 'reading_desk' ? 'Reading table · take a book from the shelf' : o.use?.kind === 'library' ? 'Library shelf · publish or borrow an article' : o.use?.kind === 'dealer' ? (o.type === 'bouncer' ? 'Bouncer · knows a guy' : 'Hat stand · pick a hat for your pockets') : objectName(o.type));
      this.drawLabel(what, (o.x + o.w / 2) * TS, (o.y + o.h) * TS - fr.h + 4, camX, camY);
    }
    else if (this.hoverCup && this.store.cups.some(c => c.id === this.hoverCup!.id)) { // gone: the label goes with it
      const { x, y } = this.hoverCup.tile;
      this.drawLabel(`${this.hoverCup.item === 'tea' ? '🍵' : '☕'} Someone left this here · click to clear it away`, x * TS + 8, y * TS - 2, camX, camY);
    }
    else if (this.cupTile) {
      const held = me?.holding ? ITEMS.get(me.holding) : undefined;
      this.drawLabel(`${held?.icon ?? '☕'} Put your ${held?.label.toLowerCase() ?? 'cup'} down here`, this.cupTile.x * TS + 8, this.cupTile.y * TS + 4, camX, camY);
    }
    else if (this.lunchTile) this.drawLabel(`${ITEMS.get(me?.holding ?? '')?.icon ?? '🍽'} Eat lunch here`, this.lunchTile.x * TS + 8, this.lunchTile.y * TS + 4, camX, camY);
    else if (this.hoverCritter) this.drawLabel(this.hoverCritter.text, this.hoverCritter.x, this.hoverCritter.y, camX, camY);
    else if (this.hoverPlant) {
      const { u, x, y } = this.hoverPlant, mine = u.id === this.store.me, p = u.plant!;
      const state = plantDead(p, t) ? (mine ? 'withered · set a status to replant' : 'withered') : PLANT_STAGES[p.stage] + (mine ? ' · set a status each day' : '');
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
  };

  private drawSprite(u: ClientUser, p: Pose, ms: number) {
    const ctx = this.ctx, c = this.assets.atlas.character;
    const sheet = this.assets.sheet(u.effects?.length ? effectLook(u.look, u.effects) : u.look);
    const x = Math.round(p.x * TS), baseY = Math.round(p.y * TS) + TS;
    const seat = p.walking ? null : seatAt(MAP, p.tile.x, p.tile.y);
    // shadow (a seated sprite's shadow is the chair's)
    if (!seat) {
      ctx.fillStyle = 'rgba(40,20,25,0.28)';
      ctx.beginPath(); ctx.ellipse(x + 8, baseY - 1.5, 5.5, 2, 0, 0, Math.PI * 2); ctx.fill();
    }
    let frame = 0, bob = 0;
    if (p.walking) frame = 1 + (Math.floor((ms / 1000) * WALK_FPS * WALK_MS_PER_TILE / (u.move?.ms ?? WALK_MS_PER_TILE)) % 4); // quicker steps when quicker
    else if (seat) { frame = SIT_FRAME; p = { ...p, dir: seat.dir }; }
    else if (this.store.presentation?.presenter === u.id && !this.store.presentation.away) p = { ...p, dir: 'down' }; // presenting: face the room, back to the board
    else {
      const phase = (ms + hash(u.id) * 37) % 1800;
      bob = u.presence === 'away' ? (phase < 900 ? 1 : 0) : phase < 300 ? 1 : 0; // tiny breathing bob
    }
    const row = DIR_ROW[p.dir] ?? 0;
    const walkBob = p.walking && (frame === 2 || frame === 4) ? -1 : 0;
    // the bag: in hand walking in and out, on the floor while they think about leaving
    const hand = BAG_HAND[p.dir] ?? BAG_HAND.down;
    const swing = p.walking && frame % 2 ? 1 : 0;
    const carrying = u.door === 'arriving' || u.door === 'leaving';
    const drawBag = () => this.blit(ctx, 'bag', x + hand.dx, baseY - 13 + swing);
    if (u.door === 'thinking') this.blit(ctx, 'bag', x + 11, baseY - 9);
    if (carrying && hand.behind) drawBag();
    // effects: a sway for the whole figure, then layers behind and in front of the body (see effects.ts)
    const fx = u.effects?.length ? u.effects : null, seed = hash(u.id);
    const sway = fx ? effectSway(fx, ms, seed, p) : null;
    if (sway && (sway.dx || sway.rot || sway.dy)) { ctx.save(); ctx.translate(x + 8 + sway.dx, baseY + sway.dy); ctx.rotate(sway.rot); ctx.translate(-x - 8, -baseY); }
    const top = baseY - c.frameH + bob + walkBob - 1 + (seat ? 2 : 0);
    const fxCtx = fx && { ctx, x, top, baseY, ms, seed, p, blit: (n: string, bx: number, by: number) => this.blit(ctx, n, Math.round(bx), Math.round(by)), has: (n: string) => !!this.f(n) };
    if (fxCtx) drawEffects('back', fxCtx, fx);
    // at the door: already half out
    ctx.globalAlpha = u.door === 'leaving' && !p.walking ? 0.45 : u.presence === 'away' ? 0.8 : 1;
    ctx.drawImage(sheet, frame * c.frameW, row * c.frameH, c.frameW, c.frameH, x, baseY - c.frameH + bob + walkBob - 1, c.frameW, c.frameH);
    if (carrying && !hand.behind) drawBag();
    ctx.globalAlpha = 1;
    if (fxCtx) drawEffects('front', fxCtx, fx);
    if (sway && (sway.dx || sway.rot || sway.dy)) ctx.restore();
    const icon = u.holding && !carrying ? ITEM_ICON.get(u.holding) : undefined;
    if (icon) {
      const ih = seat ? ITEM_HAND.down : ITEM_HAND[p.dir] ?? ITEM_HAND.down;
      ctx.fillStyle = '#000'; ctx.font = '7px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; // emoji take the fill alpha
      ctx.fillText(icon, x + ih.dx, baseY + ih.dy + bob + (p.walking ? swing : 0));
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }
    if (u.reading && seat && this.f('reading_book')) this.blit(ctx, 'reading_book', Math.round(x + 2), Math.round(baseY - 16 + bob)); // holding up the book
    if (u.eating && seat) { // fork down to the plate and up to the mouth; 💬 when they don't mind company
      const up = Math.floor(ms / 450) % 2, fx = seat.dir === 'left' ? x + 4 : seat.dir === 'right' ? x + 11 : x + 11;
      if (seat.dir !== 'up') { ctx.fillStyle = '#e8e8f0'; ctx.fillRect(fx, baseY - (up ? 11 : 7), 1, 3); ctx.fillStyle = '#6a6a76'; ctx.fillRect(fx, baseY - (up ? 8 : 4), 1, 1); }
      if (u.eating.open) { ctx.font = '7px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#000'; ctx.fillText('💬', x + 14, top + 2); ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; }
    }
    // facing a desk: the chair's backrest is in front of the sitter
    if (seat?.dir === 'up' && seat.type === 'chair' && this.f('chair_up_back')) {
      this.blit(ctx, 'chair_up_back', seat.x * TS, seat.y * TS);
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

  private bubbleFor(u: ClientUser, p: Pose): BubbleKind | null {
    if (u.hand) return 'bubble_hand';
    if (u.door === 'thinking') return 'bubble_think';
    if (u.door === 'leaving') return null;
    if (u.emote === 'knock') return 'bubble_bang';
    // in the Arcade's open voice everyone is in the room call: show the joystick/eyes unless they're talking
    if (u.game && !u.speaking && (!u.callId || u.callId.startsWith('room:'))) return u.game.role === 'player' ? 'bubble_game' : 'bubble_watch';
    if (u.callId) return u.deafened ? u.muted ? 'bubble_mute_deaf' : 'bubble_deaf' : 'bubble_talk';
    if (!underground(u) && (u.instance || u.meeting)) return 'bubble_meeting'; // a real calendar meeting, not just standing in the Meeting room; beats a manual "In a call"
    if (u.presence === 'in_call') return 'bubble_headset';
    if (u.presence === 'away') return 'bubble_zzz';
    return null;
  }

  private drawOverlay(u: ClientUser, p: Pose, ms: number) {
    const ctx = this.ctx;
    const x = Math.round(p.x * TS), baseY = Math.round(p.y * TS) + TS;
    // nameplate
    const isMe = u.id === this.store.me;
    const key = `${u.name}|${isMe}`;
    let plate = this.nameplates.get(key);
    if (!plate) {
      const label = u.name.split(/\s+/)[0].slice(0, 10);
      const w = textWidth(label) + 4;
      plate = document.createElement('canvas'); plate.width = w; plate.height = 8;
      const pc = plate.getContext('2d')!;
      pc.fillStyle = isMe ? 'rgba(90,50,20,0.85)' : 'rgba(30,18,22,0.72)';
      pc.fillRect(1, 0, w - 2, 8); pc.fillRect(0, 1, w, 6);
      drawText(pc, label, 2, 1, isMe ? '#ffe08a' : '#fff4e0');
      this.nameplates.set(key, plate);
    }
    // neighbours side by side: stagger plates so names stay readable
    const px = x + 8 - Math.floor(plate.width / 2);
    let py = baseY + 1;
    for (let tries = 0; tries < 4; tries++) {
      const hit = this.placedPlates.some(r => px < r.x + r.w + 1 && px + plate!.width + 1 > r.x && Math.abs(py - r.y) < 8);
      if (!hit) break;
      py += 8;
    }
    this.placedPlates.push({ x: px, y: py, w: plate.width });
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

    // emote bubble with a 2-frame pop
    const kind = this.bubbleFor(u, p);
    const st = this.bubbleState.get(u.id);
    if (!st || st.kind !== kind) this.bubbleState.set(u.id, { kind, at: ms });
    if (!kind) return;
    const age = ms - (this.bubbleState.get(u.id)?.at ?? 0);
    let dy = age < 70 ? -3 : age < 140 ? 1 : 0;
    if (kind === 'bubble_talk') {
      const speaking = this.isSpeaking(u);
      const frame = u.muted ? 'bubble_muted' : speaking ? (Math.floor(ms / 140) % 2 ? 'bubble_talk_1' : 'bubble_talk_2') : 'bubble_talk_0';
      this.blit(ctx, frame, x + 9, baseY - 24 - 12 + dy + (speaking ? -(Math.floor(ms / 280) % 2) : 0));
      return;
    }
    if (kind === 'bubble_bang') dy += Math.floor(ms / 180) % 2 ? -1 : 0;
    else dy += Math.floor((ms + hash(u.id) * 13) / 600) % 2 ? 0 : -1;
    this.blit(ctx, kind, x + (kind === 'bubble_mute_deaf' ? 4 : 9), baseY - 24 - 12 + dy); // the wide bubble shifts left so its tail stays over the head
  }

  /** Fake turn-taking for two people on a call, from server time so every viewer sees the same conversation. */
  private isSpeaking(u: ClientUser) {
    if (!u.callId || u.muted || u.deafened) return false;
    if (!u.bot) return !!u.speaking; // real people: their actual mic activity (voice calls)
    const members = [u, ...this.store.callPeers(u)].map(m => m.id).sort();
    const turn = Math.floor(this.store.now() / 1800); // ~1.8 s turns
    const h = hash(`${u.callId}|${turn}`);
    if (h % 6 === 0) return false; // a beat of silence now and then
    return members[(h >> 3) % members.length] === u.id;
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
      ctx.fillText(r.emoji, Math.round(x), Math.round(y));
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
  private drawAmbient(ctx: CanvasRenderingContext2D, camX: number, camY: number, ms: number) {
    const now = new Date(); const h = now.getHours() + now.getMinutes() / 60;
    // [hour, r,g,b, alpha] keyframes for a multiply tint
    const K: [number, number, number, number, number][] = [
      [0, 40, 50, 110, 0.5], [5.5, 40, 50, 110, 0.5], [7, 255, 190, 170, 0.18], [9, 255, 255, 255, 0],
      [16.5, 255, 255, 255, 0], [18.5, 255, 170, 90, 0.22], [20.5, 60, 60, 130, 0.42], [24, 40, 50, 110, 0.5],
    ];
    let i = 0; while (i < K.length - 2 && h >= K[i + 1][0]) i++;
    const [h0, ...a] = K[i], [h1, ...b] = K[i + 1];
    const f = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
    const mix = a.map((v, j) => v + (b[j] - v) * f);
    const alpha = mix[3];
    ctx.save();
    if (alpha >= 0.01) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgba(${mix[0] | 0},${mix[1] | 0},${mix[2] | 0},${alpha.toFixed(3)})`;
      ctx.fillRect(camX, camY, this.viewW + 1, this.viewH + 1);
    }
    // lamps that are on glow: softly by day, warmly in the evening
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.max(0.1, alpha * 0.55);
    const day = ctx.globalAlpha;
    for (const o of this.lights) {
      if (!this.isOn(o)) continue;
      if (o.type === 'reading_table') { // the banker's lamp sits mid-table, its pool on the top and a little beyond
        ctx.globalAlpha = Math.max(0.18, day) * (this.flickers(o, ms) ? 0.6 : 1);
        ctx.drawImage(this.greenGlow, (o.x + o.w / 2) * TS - 28, (o.y + o.h) * TS - 14 - 28);
        ctx.globalAlpha = day;
      } else ctx.drawImage(this.glow, o.x * TS + 8 - 40, (o.y + o.h) * TS - 26 - 40);
    }
    ctx.restore();
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
  private bellFrame(id: string, ms: number) {
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
  private drawBellDings(poses: Map<string, Pose>, camX: number, camY: number, ms: number) {
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

  private drawLabel(text: string, wx: number, wy: number, camX: number, camY: number, alpha = 1, accent = false) {
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 12px ui-rounded, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 14;
    const sx = ((wx - camX) * this.px) / dpr - w / 2, sy = ((wy - camY) * this.px) / dpr - 26;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = accent ? 'rgba(90,50,20,0.96)' : 'rgba(33,22,26,0.94)'; ctx.strokeStyle = accent ? '#f2b45a' : '#8a5a3c'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(sx, sy, w, 22, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = accent ? '#ffe08a' : '#ffe9c4'; ctx.fillText(text, sx + 7, sy + 15);
    ctx.globalAlpha = 1;
  }

  private drawTooltip(id: string, poses: Map<string, Pose>, camX: number, camY: number) {
    const u = this.store.users.get(id), p = poses.get(id);
    if (!u || !p) return;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const room = roomAt(MAP, p.tile.x, p.tile.y);
    const voiceRoom = this.store.roomCallOf(u);
    const presence = voiceRoom ? `in ${voiceRoom.name} voice` : u.door === 'thinking' ? 'packing up…' : u.door === 'leaving' ? 'heading out' : u.door === 'arriving' ? 'just arrived'
      : underground(u) ? 'somewhere underground' : u.instance ? 'in the meeting' : u.meeting ? `in a meeting until ${this.store.clock(u.meeting)}`
      : u.eating ? `eating ${ITEMS.get(u.eating.item)?.label.toLowerCase() ?? 'lunch'}${u.eating.open ? ' · open to talk' : ''}` : u.callId ? `talking with ${this.store.names(this.store.callPeers(u))}` : u.presence === 'in_call' ? 'in a call' : u.presence === 'away' ? 'away' : room?.rules.occupantLabel ?? 'around';
    const lines = [`${u.name}${u.id === this.store.me ? ' (you)' : ''} · ${presence}`];
    if (u.game) lines.push(this.store.gameDescription(u.game.cabinet, u.id));
    if (u.status) lines.push(`“${u.status}”`);
    if (u.tz && u.id !== this.store.me) lines.push(localTime(u.tz));
    const extra = [u.following && `following ${this.store.name(u.following).split(' ')[0]}`, u.holding && ITEM_ICON.get(u.holding)].filter(Boolean).join(' · ');
    if (extra) lines.push(extra);
    if (u.reading) lines.push(`📖 reading ${this.store.library.articles.find(a => a.id === u.reading)?.title ?? 'an article'}`);
    if (this.selected?.id !== id) lines.push(u.id === this.store.me ? 'click to react'
      : this.store.sameRoomCall(u) ? 'click for volume & more' : room?.rules.knock === 'disabled' ? `${room.name}: no knocking · click for more` : 'click for actions');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 12px ui-rounded, system-ui, sans-serif';
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16, lh = 16, hgt = lines.length * lh + 10;
    const sx = ((p.x * TS + 8 - camX) * this.px) / dpr, sy = ((p.y * TS + TS - 40 - camY) * this.px) / dpr;
    const cssW = this.canvas.width / dpr;
    const bx = Math.max(6, Math.min(cssW - w - 6, sx - w / 2)), by = Math.max(6, sy - hgt);
    ctx.fillStyle = 'rgba(33,22,26,0.94)'; ctx.strokeStyle = '#8a5a3c'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(bx, by, w, hgt, 6); ctx.fill(); ctx.stroke();
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? '#ffe9c4' : i === 1 && u.status ? '#d8c8b0' : '#a89080';
      if (i > 0) ctx.font = i === 1 && u.status ? 'italic 12px system-ui, sans-serif' : '11px system-ui, sans-serif';
      ctx.fillText(l, bx + 8, by + 17 + i * lh);
    });
  }
}
