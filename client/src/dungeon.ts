import type { Tile, TileMap } from '../../shared/map';

/** Tile lighting and discovery; the engine owns drawing order and controls. */
export class DungeonView {
  readonly visible = new Set<number>();
  private light: Float32Array;
  private fire: Float32Array;
  private signature = '';
  private seen: Set<number> | null = null;
  private overlay: HTMLCanvasElement;
  private flicker = -1;

  constructor(private map: TileMap) {
    this.light = new Float32Array(map.width * map.height);
    this.fire = new Float32Array(this.light.length);
    this.overlay = document.createElement('canvas');
    const r = map.dungeon?.rect;
    this.overlay.width = (r?.w ?? 0) * map.tileSize; this.overlay.height = (r?.h ?? 0) * map.tileSize;
  }
  private id(t: Tile) { return t.y * this.map.width + t.x; }
  private wall(x: number, y: number) { return !!this.map.layers.walls[y]?.[x]; }
  /** Bresenham: test intervening walls, including neither source nor destination. */
  private los(a: Tile, b: Tile) {
    let x = a.x, y = a.y;
    const dx = Math.abs(b.x - x), dy = -Math.abs(b.y - y), sx = x < b.x ? 1 : -1, sy = y < b.y ? 1 : -1;
    let err = dx + dy;
    while (x !== b.x || y !== b.y) {
      const e = err * 2;
      if (e >= dy) { err += dy; x += sx; }
      if (e <= dx) { err += dx; y += sy; }
      if (x === b.x && y === b.y) return true;
      if (this.wall(x, y)) return false;
    }
    return true;
  }
  update(me: Tile, others: Tile[], seen: Set<number>) {
    const d = this.map.dungeon; if (!d) return;
    const signature = [me, ...others].map(t => `${t.x},${t.y}`).join(';');
    if (this.signature === signature && this.seen === seen) return;
    this.signature = signature; this.seen = seen; this.flicker = -1;
    this.light.fill(0); this.fire.fill(0); this.visible.clear();
    const r = d.rect, tiles: Tile[] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) tiles.push({ x, y });
    const source = (at: Tile, radius: number, full: number, strength: number, out: Float32Array) => {
      for (const t of tiles) {
        const distance = Math.hypot(t.x - at.x, t.y - at.y);
        if (distance >= radius || !this.los(at, t)) continue;
        const value = strength * Math.min(1, (radius - distance) / (radius - full)), k = this.id(t);
        out[k] = Math.max(out[k], value);
      }
    };
    source(me, 3.5, 2, 1, this.light);
    for (const t of others) if (Math.hypot(t.x - me.x, t.y - me.y) <= 10 && this.los(me, t)) source(t, 3, 1.5, .9, this.light);
    source(d.landing, 2, .5, .65, this.light);
    for (const t of d.torches) source(t, 3, 1, .9, this.fire);
    // A stone face beside a lit floor catches its light too; it never transmits it onward.
    for (const t of tiles) if (this.wall(t.x, t.y)) {
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const x = t.x + dx, y = t.y + dy;
        if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h || this.wall(x, y)) continue;
        const k = this.id(t), n = y * this.map.width + x;
        this.light[k] = Math.max(this.light[k], this.light[n] * .8);
        this.fire[k] = Math.max(this.fire[k], this.fire[n] * .8);
      }
    }
    for (const t of tiles) if (Math.max(this.light[this.id(t)], this.fire[this.id(t)]) > 0 &&
      Math.hypot(t.x - me.x, t.y - me.y) <= 10 && this.los(me, t)) {
      this.visible.add(this.id(t)); seen.add(this.id(t));
    }
  }
  canSee(t: Tile) { return this.visible.has(this.id(t)); }
  draw(ctx: CanvasRenderingContext2D, ms: number) {
    const d = this.map.dungeon; if (!d || !this.seen) return;
    const tick = Math.floor(ms / 90);
    if (tick !== this.flicker) {
      this.flicker = tick;
      const c = this.overlay.getContext('2d')!, r = d.rect, ts = this.map.tileSize;
      c.clearRect(0, 0, this.overlay.width, this.overlay.height);
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const k = (y + r.y) * this.map.width + x + r.x;
        if (this.visible.has(k)) {
          const fire = this.fire[k] * (.94 + .06 * Math.sin(ms / 230 + k * 1.7));
          const light = Math.max(this.light[k], fire);
          c.fillStyle = `rgba(0,0,0,${1 - light})`;
        } else c.fillStyle = this.seen.has(k) ? 'rgba(6,12,24,0.8)' : '#000';
        c.fillRect(x * ts, y * ts, ts, ts);
      }
    }
    ctx.drawImage(this.overlay, d.rect.x * this.map.tileSize, d.rect.y * this.map.tileSize);
  }
}
