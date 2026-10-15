// The floor: one <canvas>, one requestAnimationFrame loop.
// Order: static tilemap → y-sorted furniture + sprites → nameplates & bubbles → ambient tint → UI hints.
import { findPath, isWalkable, roomAt, seatAt, type MapObject, type Tile } from '../../shared/map';
import type { Assets, Frame } from './assets';
import { drawText, textWidth } from './font';
import { MEETING_ROOM_ID } from '../../shared/protocol';
import { ITEMS, MAP, type ClientUser, type Pose, type Store } from './net';

const TS = MAP.tileSize;
const MW = MAP.width * TS, MH = MAP.height * TS;
const MEETING = MAP.rooms.find(r => r.id === MEETING_ROOM_ID)!.rect;
const inMeetingRoom = (x: number, y: number) => x >= MEETING.x && x < MEETING.x + MEETING.w && y >= MEETING.y && y < MEETING.y + MEETING.h;
const DIR_ROW: Record<string, number> = { down: 0, left: 1, right: 2, up: 3 };
const WALK_FPS = 8; // 4 frames per tile at 4 tiles/s
const SIT_FRAME = 5;

type BubbleKind = 'bubble_bang' | 'bubble_headset' | 'bubble_zzz' | 'bubble_meeting' | 'bubble_dots' | 'bubble_think' | 'bubble_talk' | 'bubble_hand' | 'bubble_deaf';
// where the bag hangs when carried, per facing; behind = drawn before the body
const BAG_HAND: Record<string, { dx: number; behind: boolean }> = {
  down: { dx: 10, behind: false }, up: { dx: -3, behind: false }, left: { dx: 7, behind: true }, right: { dx: -1, behind: true },
};

/** What a click landed on; the action wheel opens for it. */
export type Pick = { kind: 'user' | 'object'; id: string };

// item id -> icon, from whatever the map's objects hand out
const ITEM_ICON = new Map([...ITEMS].map(([id, i]) => [id, i.icon]));
const ITEM_HAND: Record<string, { dx: number; dy: number }> = { down: { dx: 13, dy: -9 }, up: { dx: 3, dy: -10 }, left: { dx: 3, dy: -9 }, right: { dx: 13, dy: -9 } };

const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

export class Engine {
  private ctx: CanvasRenderingContext2D;
  private staticLayer: HTMLCanvasElement;
  private raf = 0;
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
  private drag: { x: number; y: number; camX: number; camY: number; moved: boolean } | null = null;
  private bubbleState = new Map<string, { kind: BubbleKind | null; at: number }>();
  private nameplates = new Map<string, HTMLCanvasElement>();
  private ro: ResizeObserver;
  private dynamicObjects: MapObject[];
  private lights: MapObject[];
  private steamers: MapObject[];
  private placedPlates: { x: number; y: number; w: number }[] = [];
  private snapped = false;

  constructor(private canvas: HTMLCanvasElement, private store: Store, private assets: Assets) {
    this.ctx = canvas.getContext('2d')!;
    this.staticLayer = this.buildStatic();
    this.dynamicObjects = MAP.objects.filter(o => !o.wall && !o.walkable);
    this.lights = MAP.objects.filter(o => o.light);
    this.steamers = MAP.objects.filter(o => o.steam);
    this.interactive = MAP.objects.filter(o => o.use || o.sit || o.sound);
    this.boards = MAP.objects.filter(o => o.use?.kind === 'meetings');
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
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf); this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onCancel);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('gesturestart', this.onGesture);
    this.canvas.removeEventListener('gesturechange', this.onGesture);
    window.removeEventListener('keydown', this.onKey);
  }

  /** Pan the camera to a person (from the room list). */
  focusUser(id: string) {
    const u = this.store.users.get(id); if (!u) return;
    const p = this.store.pose(u);
    this.lookAt(p.x * TS + 8, p.y * TS);
  }
  /** Pan to a room (from the room list), out of the overview if we're in it. */
  focusRoom(id: string) {
    const r = MAP.rooms.find(r => r.id === id)?.rect; if (!r) return;
    this.lookAt((r.x + r.w / 2) * TS, (r.y + r.h / 2) * TS);
  }
  /** Walk into a room (from the list): the free tile nearest its middle, plain floor before a seat. */
  walkToRoom(id: string) {
    const r = MAP.rooms.find(r => r.id === id), me = this.store.users.get(this.store.me); if (!r || !me) return;
    if (me.instance || roomAt(MAP, me.tile.x, me.tile.y)?.id === id) return this.focusRoom(id); // a meeting's room has no way out but Leave
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
    if (!me || !u || u.id === me.id || !this.visible(u)) return this.focusUser(id);
    const taken = this.taken(), inside = !!me.instance, d = u.tile;
    let best: { t: Tile; len: number } | null = null;
    for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) {
      const t = { x: d.x + dx, y: d.y + dy };
      if (t.x === me.tile.x && t.y === me.tile.y) return this.walkTo(t); // already there
      if (!isWalkable(MAP, t.x, t.y) || taken.has(`${t.x},${t.y}`) || (inside && !inMeetingRoom(t.x, t.y))) continue;
      const len = findPath(MAP, me.tile, t).length;
      if (len && (!best || len < best.len)) best = { t, len };
    }
    if (best) this.walkTo(best.t); else this.focusUser(id);
  }
  /** Tiles other people stand on or are heading to, in my office or meeting room. */
  private taken() {
    return new Set([...this.store.users.values()].filter(u => u.id !== this.store.me && this.visible(u)).map(u => `${u.tile.x},${u.tile.y}`));
  }
  private walkTo(t: Tile) { this.onPick?.(null); this.manualCam = false; if (this.overview) this.zoomTo(this.backPx()); this.store.moveTo(t); }
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
    const o = MAP.objects.find(o => o.id === p.id), fr = o && this.f(o.type);
    if (!o || !fr) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((o.x + o.w / 2) * TS - this.cam.x) * k, y: r.top + ((o.y + o.h) * TS - fr.h / 2 - this.cam.y) * k, r: (Math.max(fr.w, fr.h) / 2) * k };
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
    // wall decor + floor-level furniture (chairs) are static
    for (const o of MAP.objects) {
      if (!o.wall && !o.walkable) continue;
      const name = o.dir && this.f(`${o.type}_${o.dir}`) ? `${o.type}_${o.dir}` : o.type; // chairs face their desk
      const fr = this.f(name); if (!fr) continue;
      const x = o.x * TS + (o.w * TS - fr.w) / 2;
      const y = o.wall ? o.y * TS : (o.y + o.h) * TS - fr.h;
      this.blit(ctx, name, x, y);
    }
    return c;
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
    const fit = Math.min(this.canvas.width / MW, this.canvas.height / MH);
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
    const fit = Math.floor(Math.min(this.canvas.width / MW, this.canvas.height / MH) / this.dpr);
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
    const cx = MW <= this.viewW ? -(this.viewW - MW) / 2 : Math.max(0, Math.min(MW - this.viewW, x));
    const cy = MH <= this.viewH ? -(this.viewH - MH) / 2 : Math.max(0, Math.min(MH - this.viewH, y));
    return { x: cx, y: cy };
  }
  private toWorld(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / r.width;
    return { x: ((e.clientX - r.left) * dpr) / this.px + this.cam.x, y: ((e.clientY - r.top) * dpr) / this.px + this.cam.y };
  }

  // ---------- input ----------
  /** In a meeting's own room you see only its people; in the office, nobody who's in one. */
  private visible(u: ClientUser) { return u.presence !== 'offline' && u.instance === this.myInstance(); }
  private myInstance() { return this.store.users.get(this.store.me)?.instance ?? null; }
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
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer (tests) */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) { // second finger: a pinch, never a tap or a drag
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, px: this.targetPx, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.drag = null; this.manualCam = true;
      return;
    }
    if (this.pointers.size > 2) return;
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
  private onCancel = (e: PointerEvent) => { this.pointers.delete(e.pointerId); if (this.pointers.size < 2) this.pinch = null; this.drag = null; };
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
    const t = e.target;
    if (e.metaKey || e.ctrlKey || e.altKey || (t instanceof Element && t.closest('input, textarea, select, [contenteditable]'))) return;
    if (e.key === '+' || e.key === '=') this.zoomIn();
    else if (e.key === '-' || e.key === '_') this.zoomOut();
    else if (e.key === '0') this.resetZoom();
    else if (e.key === 'm' || e.key === 'M') this.toggleOverview();
    else return;
    e.preventDefault();
  };
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
    this.hoverUser = this.userAt(w.x, w.y);
    const inside = this.myInstance();
    this.hoverObject = this.hoverUser || inside ? null : this.objectAt(w.x, w.y);
    const tx = Math.floor(w.x / TS), ty = Math.floor(w.y / TS);
    this.hoverTile = isWalkable(MAP, tx, ty) && (!inside || inMeetingRoom(tx, ty)) ? { x: tx, y: ty } : null;
    this.canvas.style.cursor = this.tapZooms ? 'zoom-in' : this.hoverUser || this.hoverObject ? 'pointer' : this.hoverTile ? 'crosshair' : 'default';
  };
  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; return; }
    const d = this.drag; this.drag = null;
    if (!d || d.moved) return;
    const w = this.toWorld(e);
    if (this.tapZooms) { // overview: a tap zooms in right there
      this.manualCam = true; this.onPick?.(null);
      return this.zoomTo(this.backPx(), this.devicePoint(e), { wx: w.x, wy: w.y });
    }
    const hit = this.userAt(w.x, w.y);
    if (hit) return this.onPick?.({ kind: 'user', id: hit });
    const inside = this.myInstance();
    const obj = inside ? null : this.objectAt(w.x, w.y);
    if (obj?.sit) { this.onPick?.(null); this.manualCam = false; return this.store.moveTo(this.freeSeat(obj, Math.floor(w.x / TS))); }
    if (obj?.sound) return this.onPick?.(null);
    if (obj) return this.onPick?.({ kind: 'object', id: obj.id });
    this.onPick?.(null);
    const tx = Math.floor(w.x / TS), ty = Math.floor(w.y / TS);
    if (isWalkable(MAP, tx, ty) && (!inside || inMeetingRoom(tx, ty))) { this.store.moveTo({ x: tx, y: ty }); this.manualCam = false; }
  };

  // ---------- render ----------
  private frame = (ms: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const ctx = this.ctx, t = this.store.now();
    const users = [...this.store.users.values()].filter(u => this.visible(u));
    const poses = new Map<string, Pose>(users.map(u => [u.id, this.store.pose(u, t)]));

    const me = this.store.users.get(this.store.me);
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
      const target = me.instance // a meeting's room: keep the room in the middle
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
    ctx.drawImage(this.staticLayer, 0, 0);

    // hover tile + my destination marker
    if (this.hoverTile && !this.hoverUser && !this.tapZooms) {
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
    for (const u of this.store.users.values()) if (u.homeDesk) deskOwners.set(`${u.homeDesk.x},${u.homeDesk.y}`, u);
    for (const [key, owner] of deskOwners) {
      const [dx, dy] = key.split(',').map(Number);
      const op = poses.get(owner.id);
      if (op && !op.walking && op.tile.x === dx && op.tile.y === dy) continue; // they're sitting on it
      this.drawDeskTag(owner, dx, dy);
    }

    // y-sorted drawables
    type D = { base: number; draw: () => void };
    const ds: D[] = [];
    for (const o of this.dynamicObjects) {
      const fr = this.f(o.type); if (!fr) continue;
      const x = o.x * TS + (o.w * TS - fr.w) / 2, y = (o.y + o.h) * TS - fr.h;
      const name = this.isOn(o) || !this.f(`${o.type}_off`) ? o.type : `${o.type}_off`;
      ds.push({ base: (o.y + o.h) * TS - 0.5, draw: () => this.blit(ctx, name, x, y) });
    }
    for (const u of users) {
      const p = poses.get(u.id)!;
      ds.push({ base: p.y * TS + TS, draw: () => this.drawSprite(u, p, ms) });
    }
    ds.sort((a, b) => a.base - b.base);
    for (const d of ds) d.draw();

    // coffee steam when someone is in the Coffee room
    const coffeeBusy = users.some(u => roomAt(MAP, poses.get(u.id)!.tile.x, poses.get(u.id)!.tile.y)?.type === 'coffee');
    if (coffeeBusy) for (const o of this.steamers) this.drawSteam(o, ms);
    // fresh steam (or fridge chill) right after someone used it
    for (const fx of this.store.objectFx) {
      if (ms - fx.at > 3000) continue;
      const o = MAP.objects.find(o => o.id === fx.objectId);
      if (o && !(coffeeBusy && o.steam)) this.drawSteam(o, ms);
    }

    for (const o of MAP.objects.filter(o => o.sound)) for (let i = 0; i < 3; i++) {
      const phase = (ms / 2200 + i / 3) % 1;
      ctx.globalAlpha = 1 - phase;
      this.blit(ctx, i % 2 ? 'note_1' : 'note_2', o.x * TS + 5 + Math.round(Math.sin(phase * 6 + i) * 4), o.y * TS - Math.round(phase * 18));
    }
    ctx.globalAlpha = 1;

    if (!me?.instance) this.drawBoardBadges(ctx, ms);

    // a meeting's own room: the rest of the office fades away
    if (me?.instance) {
      ctx.fillStyle = 'rgba(20,13,16,0.9)';
      ctx.beginPath(); ctx.rect(-MW, -MH, MW * 3, MH * 3);
      ctx.rect((MEETING.x - 1) * TS, (MEETING.y - 2) * TS, (MEETING.w + 2) * TS, (MEETING.h + 3) * TS);
      ctx.fill('evenodd');
    }

    // overlays: nameplates + bubbles (never occluded)
    const sorted = users.slice().sort((a, b) => poses.get(a.id)!.y - poses.get(b.id)!.y);
    this.placedPlates = [];
    for (const u of sorted) this.drawOverlay(u, poses.get(u.id)!, ms);
    this.drawReactions(poses, ms);

    this.drawAmbient(ctx, camX, camY);
    if (this.overview && !me?.instance) this.drawRoomTags(users, poses, camX, camY);
    // one of my meetings is on: say so over the board, readable at any zoom
    const goable = me && !me.instance && this.hoverObject?.use?.kind !== 'meetings'
      ? this.store.agenda.find(a => a.start - 10 * 60_000 <= this.store.now() && a.end > this.store.now()) : undefined;
    if (goable) for (const o of this.boards) {
      const title = goable.title.length > 22 ? `${goable.title.slice(0, 21)}…` : goable.title;
      this.drawLabel(`📅 ${title} · click to go`, (o.x + 0.5) * TS, o.y * TS - 6 - Math.round((Math.sin(ms / 220) + 1)), camX, camY);
    }

    // hover tooltip in screen space
    if (this.tapZooms) { /* overview: room tags only */ }
    else if (this.hoverUser) this.drawTooltip(this.hoverUser, poses, camX, camY);
    else if (this.hoverObject && !this.selected) {
      const o = this.hoverObject, fr = this.f(o.type)!;
      const what = o.sound ? 'Radio · music volume in ⚙' : o.use?.kind === 'toggle' ? `${o.use.label[0].toUpperCase()}${o.use.label.slice(1)} · ${this.isOn(o) ? 'on' : 'off'}`
        : o.use?.kind === 'calendar' ? 'Calendar · your week' : o.use?.kind === 'meetings' ? `Meetings · ${this.store.meetingRooms.length || 'none'} on now` : o.sit ? 'Sofa · click to sit' : o.type === 'coffee_machine' ? 'Coffee machine' : o.type === 'fridge' ? 'Fridge' : o.type;
      this.drawLabel(what, (o.x + o.w / 2) * TS, (o.y + o.h) * TS - fr.h + 4, camX, camY);
    }
    else if (this.hoverTile) {
      const owner = deskOwners.get(`${this.hoverTile.x},${this.hoverTile.y}`);
      if (owner) this.drawLabel(owner.id === this.store.me ? 'Your desk' : `${owner.name}'s desk`, this.hoverTile.x * TS + 8, this.hoverTile.y * TS, camX, camY);
    }
  };

  private drawSprite(u: ClientUser, p: Pose, ms: number) {
    const ctx = this.ctx, c = this.assets.atlas.character;
    const sheet = this.assets.sheet(u.look);
    const x = Math.round(p.x * TS), baseY = Math.round(p.y * TS) + TS;
    const seat = p.walking ? null : seatAt(MAP, p.tile.x, p.tile.y);
    // shadow (a seated sprite's shadow is the chair's)
    if (!seat) {
      ctx.fillStyle = 'rgba(40,20,25,0.28)';
      ctx.beginPath(); ctx.ellipse(x + 8, baseY - 1.5, 5.5, 2, 0, 0, Math.PI * 2); ctx.fill();
    }
    let frame = 0, bob = 0;
    if (p.walking) frame = 1 + (Math.floor((ms / 1000) * WALK_FPS) % 4);
    else if (seat) { frame = SIT_FRAME; p = { ...p, dir: seat.dir }; }
    else {
      const phase = (ms + hash(u.id) * 37) % 1800;
      bob = u.presence === 'away' ? (phase < 900 ? 1 : 0) : phase < 300 ? 1 : 0; // tiny breathing bob
    }
    const row = DIR_ROW[p.dir] ?? 0;
    // the bag: in hand walking in and out, on the floor while they think about leaving
    const hand = BAG_HAND[p.dir] ?? BAG_HAND.down;
    const swing = p.walking && frame % 2 ? 1 : 0;
    const carrying = u.door === 'arriving' || u.door === 'leaving';
    const drawBag = () => this.blit(ctx, 'bag', x + hand.dx, baseY - 13 + swing);
    if (u.door === 'thinking') this.blit(ctx, 'bag', x + 11, baseY - 9);
    if (carrying && hand.behind) drawBag();
    // at the door: already half out
    ctx.globalAlpha = u.door === 'leaving' && !p.walking ? 0.45 : u.presence === 'away' ? 0.8 : 1;
    ctx.drawImage(sheet, frame * c.frameW, row * c.frameH, c.frameW, c.frameH, x, baseY - c.frameH + bob - 1, c.frameW, c.frameH);
    if (carrying && !hand.behind) drawBag();
    ctx.globalAlpha = 1;
    const icon = u.holding && !carrying ? ITEM_ICON.get(u.holding) : undefined;
    if (icon) {
      const ih = seat ? ITEM_HAND.down : ITEM_HAND[p.dir] ?? ITEM_HAND.down;
      ctx.fillStyle = '#000'; ctx.font = '7px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; // emoji take the fill alpha
      ctx.fillText(icon, x + ih.dx, baseY + ih.dy + bob + (p.walking ? swing : 0));
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }
    // facing a desk: the chair's backrest is in front of the sitter
    if (seat?.dir === 'up' && this.f('chair_up_back') && MAP.objects.some(o => o.type === 'chair' && o.x === seat.x && o.y === seat.y)) {
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
    if (u.callId) return u.deafened ? 'bubble_deaf' : 'bubble_talk';
    if (u.presence === 'in_call') return 'bubble_headset';
    if (u.presence === 'away') return 'bubble_zzz';
    if (u.instance || u.meeting) return 'bubble_meeting'; // a real calendar meeting, not just standing in the Meeting room
    if (u.status) return 'bubble_dots';
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
    this.blit(ctx, kind, x + 9, baseY - 24 - 12 + dy);
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
      const o = MAP.objects.find(o => o.id === sel.id); if (!o) return;
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

  private drawAmbient(ctx: CanvasRenderingContext2D, camX: number, camY: number) {
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
    const glow = Math.max(0.1, alpha * 0.55);
    for (const o of this.lights) {
      if (!this.isOn(o)) continue;
      const lx = o.x * TS + 8, ly = (o.y + o.h) * TS - 26;
      const g = ctx.createRadialGradient(lx, ly, 2, lx, ly, 40);
      g.addColorStop(0, `rgba(255,200,110,${glow.toFixed(3)})`); g.addColorStop(1, 'rgba(255,200,110,0)');
      ctx.fillStyle = g; ctx.fillRect(lx - 40, ly - 40, 80, 80);
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
      : u.instance ? 'in the meeting' : u.meeting ? `in a meeting until ${this.store.clock(u.meeting)}`
      : u.callId ? `talking with ${this.store.names(this.store.callPeers(u))}` : u.presence === 'in_call' ? 'in a call' : u.presence === 'away' ? 'away' : room?.rules.occupantLabel ?? 'around';
    const lines = [`${u.name}${u.id === this.store.me ? ' (you)' : ''} · ${presence}`];
    if (u.status) lines.push(`“${u.status}”`);
    const extra = [u.following && `following ${this.store.name(u.following).split(' ')[0]}`, u.holding && ITEM_ICON.get(u.holding)].filter(Boolean).join(' · ');
    if (extra) lines.push(extra);
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
