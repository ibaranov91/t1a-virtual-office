// Loads the sprite atlas and builds per-person palette-swapped character sheets.
import type { Look } from '../../shared/protocol';

export interface Frame { x: number; y: number; w: number; h: number }
export interface Atlas {
  image: string; tileSize: number; frames: Record<string, Frame>;
  character: {
    image: string; frameW: number; frameH: number; framesPerDir: number;
    dirs: string[]; styles: string[]; keys: Record<string, string>;
  };
}
export interface Assets { atlas: Atlas; world: HTMLImageElement; chars: HTMLImageElement; sheet(look: Look): HTMLCanvasElement }

const BASE = '/assets/';
const loadImage = (src: string) => new Promise<HTMLImageElement>((ok, fail) => {
  const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src;
});
const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const shade = (h: string, k = 0.78) => {
  const [r, g, b] = rgb(h);
  // shift shadows slightly toward warm purple, Stardew-ish
  return [Math.round(r * k * 0.95 + 6), Math.round(g * k * 0.92), Math.round(b * k + 10)].map(v => Math.max(0, Math.min(255, v)));
};

export async function loadAssets(): Promise<Assets> {
  const atlas: Atlas = await (await fetch(BASE + 'atlas.json')).json();
  const [world, chars] = await Promise.all([loadImage(BASE + atlas.image), loadImage(BASE + atlas.character.image)]);
  const c = atlas.character;
  const rowH = c.frameH * c.dirs.length;
  const cache = new Map<string, HTMLCanvasElement>();

  // read base sheet pixels once
  const base = document.createElement('canvas');
  base.width = chars.width; base.height = chars.height;
  const bctx = base.getContext('2d')!; bctx.drawImage(chars, 0, 0);

  const sheet = (look: Look) => {
    const key = JSON.stringify(look);
    const hit = cache.get(key); if (hit) return hit;
    const style = Math.max(0, Math.min(c.styles.length - 1, look.style | 0));
    const src = bctx.getImageData(0, style * rowH, base.width, rowH);
    const swap = new Map<number, number[]>();
    const put = (k: string, v: number[]) => { const [r, g, b] = rgb(c.keys[k]); swap.set((r << 16) | (g << 8) | b, v); };
    put('skin', rgb(look.skin)); put('skinShade', shade(look.skin, 0.86));
    put('hair', rgb(look.hair)); put('hairShade', shade(look.hair, 0.72));
    put('shirt', rgb(look.shirt)); put('shirtShade', shade(look.shirt));
    put('pants', rgb(look.pants)); put('pantsShade', shade(look.pants));
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const v = swap.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      if (v) { d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; }
    }
    const out = document.createElement('canvas');
    out.width = base.width; out.height = rowH;
    out.getContext('2d')!.putImageData(src, 0, 0);
    cache.set(key, out);
    return out;
  };
  return { atlas, world, chars, sheet };
}
