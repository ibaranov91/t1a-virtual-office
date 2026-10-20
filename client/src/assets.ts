// Loads the sprite atlas and builds per-person palette-swapped character sheets.
import type { Look } from '../../shared/protocol';
import { setItemArt } from './ItemSprite';

export interface Frame { x: number; y: number; w: number; h: number }
export interface Atlas {
  image: string; tileSize: number; frames: Record<string, Frame>;
  character: {
    image: string; frameW: number; frameH: number; framesPerDir: number;
    dirs: string[]; styles: string[]; keys: Record<string, string>;
    tops: string[]; bottoms: string[];
    accessories: { image: string; frameW: number; frameH: number; items: string[]; keys: Record<string, string> };
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
  const [world, chars, accessoryImage] = await Promise.all([
    loadImage(BASE + atlas.image), loadImage(BASE + atlas.character.image), loadImage(BASE + atlas.character.accessories.image),
  ]);
  const c = atlas.character;
  const topCount = c.tops?.length ?? 1, bottomCount = c.bottoms?.length ?? 1;
  const rowH = c.frameH * c.dirs.length * c.styles.length * topCount * bottomCount;
  const cache = new Map<string, HTMLCanvasElement>();

  // read base sheet pixels once
  const base = document.createElement('canvas');
  base.width = chars.width; base.height = chars.height;
  const bctx = base.getContext('2d')!; bctx.drawImage(chars, 0, 0);
  const accessoryBase = document.createElement('canvas');
  accessoryBase.width = accessoryImage.width; accessoryBase.height = accessoryImage.height;
  const accessoryCtx = accessoryBase.getContext('2d')!; accessoryCtx.drawImage(accessoryImage, 0, 0);
  const tintedAccessories = new Map<string, HTMLCanvasElement>();
  const accessorySheet = (item: string, color: string) => {
    const cacheKey = `${item}:${color}`;
    const cached = tintedAccessories.get(cacheKey); if (cached) return cached;
    const itemIndex = c.accessories.items.indexOf(item);
    if (itemIndex < 0) return null;
    const y = itemIndex * c.accessories.frameH * c.dirs.length;
    const pixels = accessoryCtx.getImageData(0, y, c.accessories.frameW, c.accessories.frameH * c.dirs.length);
    const primary = rgb(c.accessories.keys.primary), highlight = rgb(c.accessories.keys.highlight), replacement = rgb(color);
    const primaryKey = (primary[0] << 16) | (primary[1] << 8) | primary[2];
    const highlightKey = (highlight[0] << 16) | (highlight[1] << 8) | highlight[2];
    for (let i = 0; i < pixels.data.length; i += 4) {
      if (!pixels.data[i + 3]) continue;
      const key = (pixels.data[i] << 16) | (pixels.data[i + 1] << 8) | pixels.data[i + 2];
      if (key === primaryKey || key === highlightKey) {
        const shadeColor = item === 'sunglasses'
          ? key === highlightKey ? [255, 255, 255] : [12, 12, 15]
          : key === highlightKey
            ? item === 'round_glasses' ? [255, 255, 255] : shade(color, 1.12)
            : replacement;
        pixels.data[i] = shadeColor[0]; pixels.data[i + 1] = shadeColor[1]; pixels.data[i + 2] = shadeColor[2];
      }
    }
    const tinted = document.createElement('canvas');
    tinted.width = accessoryBase.width; tinted.height = c.accessories.frameH * c.dirs.length;
    tinted.getContext('2d')!.putImageData(pixels, 0, 0);
    tintedAccessories.set(cacheKey, tinted);
    return tinted;
  };

  const sheet = (look: Look) => {
    const key = JSON.stringify(look);
    const hit = cache.get(key); if (hit) return hit;
    const style = Math.max(0, Math.min(c.styles.length - 1, look.style | 0));
    const top = Math.max(0, Math.min(topCount - 1, look.top | 0));
    const bottom = Math.max(0, Math.min(bottomCount - 1, look.bottom | 0));
    const row = (style * topCount + top) * bottomCount + bottom;
    const src = bctx.getImageData(0, row * c.frameH * c.dirs.length, base.width, c.frameH * c.dirs.length);
    const swap = new Map<number, number[]>();
    const put = (k: string, v: number[]) => { const [r, g, b] = rgb(c.keys[k]); swap.set((r << 16) | (g << 8) | b, v); };
    put('skin', rgb(look.skin)); put('skinShade', shade(look.skin, 0.86));
    put('hair', rgb(look.hair)); put('hairShade', shade(look.hair, 0.72));
    put('shirt', rgb(look.shirt)); put('shirtShade', shade(look.shirt));
    put('pants', rgb(look.pants)); put('pantsShade', shade(look.pants));
    put('eyes', rgb(look.eyes)); put('shoes', rgb(look.shoes));
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const v = swap.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      if (v) { d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; }
    }
    const out = document.createElement('canvas');
    out.width = base.width; out.height = rowH;
    const outCtx = out.getContext('2d')!;
    outCtx.putImageData(src, 0, 0);
    outCtx.imageSmoothingEnabled = false;
    const applyAccessory = (sprite: HTMLCanvasElement | null) => {
      if (!sprite) return;
      for (let s = 0; s < c.styles.length; s++) for (let t = 0; t < topCount; t++) for (let b = 0; b < bottomCount; b++) {
        for (let dir = 0; dir < c.dirs.length; dir++) {
          const row = ((s * topCount + t) * bottomCount + b) * c.dirs.length + dir;
          for (let f = 0; f < c.framesPerDir; f++) {
            outCtx.drawImage(sprite, 0, dir * c.frameH, c.frameW, c.frameH,
              f * c.frameW, row * c.frameH, c.frameW, c.frameH);
          }
        }
      }
    };
    applyAccessory(look.glasses ? accessorySheet(look.glasses === 1 ? 'round_glasses' : 'sunglasses', look.glassesColor) : null);
    applyAccessory(look.beard ? accessorySheet('beard', look.hair) : null);
    applyAccessory(look.mustache ? accessorySheet('mustache', look.hair) : null);
    applyAccessory(look.hat ? accessorySheet(look.hat === 1 ? 'cap' : 'bowler', look.hatColor) : null);
    cache.set(key, out);
    return out;
  };
  const assets = { atlas, world, chars, sheet };
  setItemArt(assets); // item art for page UI (ItemSprite.tsx)
  return assets;
}
