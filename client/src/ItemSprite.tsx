// An item's pixel art (shared/items.ts `sprite`, drawn by scripts/gen-assets.mjs) in page UI: the action wheel, pockets,
// storage, the shop and the GM panel. Items without art (stickers) keep their emoji.
import { useEffect, useRef } from 'react';
import type { Assets } from './assets';
import { itemDef } from '../../shared/items';
import { emptyDrink } from '../../shared/drinks';

let art: Assets | null = null;
/** loadAssets hands the atlas over once it has loaded. */
export function setItemArt(a: Assets) { art = a; }

/** The art for an item id (an empty cup uses its drink's), or null when it has none. */
export function itemFrame(id: string | null | undefined) {
  const name = itemDef(emptyDrink(id) ?? id)?.sprite, f = name ? art?.atlas.frames[name] : undefined;
  return f ? { name, f } : null;
}

export function ItemSprite({ item, fallback, scale = 2, dim }: { item: string | null | undefined; fallback?: string; scale?: number; dim?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null), fr = itemFrame(item);
  useEffect(() => {
    const c = ref.current; if (!c || !fr || !art) return;
    const g = c.getContext('2d')!; g.imageSmoothingEnabled = false; g.clearRect(0, 0, c.width, c.height);
    g.drawImage(art.world, fr.f.x, fr.f.y, fr.f.w, fr.f.h, 0, 0, fr.f.w * scale, fr.f.h * scale);
  }, [fr?.name, scale]);
  if (!fr) return <span style={dim ? { opacity: 0.45 } : undefined}>{fallback ?? itemDef(item)?.icon ?? '📦'}</span>;
  return <canvas ref={ref} width={fr.f.w * scale} height={fr.f.h * scale} className="item-sprite" style={dim ? { opacity: 0.45 } : undefined} aria-hidden="true" />;
}
