// The gacha machine: one capsule per person per office day (on top of the 7/11's daily goods).
// Usually a sticker, sometimes one of the daily toys, rarely a hat only the gacha gives. Pure: the server passes the dice.
import { GACHA_HATS, hatItem } from './effects';

export const STICKERS = ['star', 'heart', 'cat', 'rocket', 'ghost', 'pizza'] as const;
export const stickerItem = (design: string) => `sticker_${design}`;
export const STICKER_ICONS: Record<(typeof STICKERS)[number], string> = { star: '⭐', heart: '💖', cat: '🐱', rocket: '🚀', ghost: '👻', pizza: '🍕' };
/** The daily toys a capsule can hold (the same ones that spawn around the office). */
export const GACHA_TOYS = ['snowball', 'train', 'remote_car', 'sewing_kit'] as const;
export const GACHA_ODDS = { hat: 0.05, toy: 0.2 } as const; // the rest (75%) are stickers

export interface GachaPrize { kind: 'hat' | 'toy' | 'sticker'; item: string }
/** Roll a capsule. `owned`: what the person has in pockets (hats and stickers are one of each, so a repeat falls through to
 *  the next kind). `rng`: 0..1 dice. Returns null only when someone owns every sticker and hat and … never: a toy always works. */
export function rollGacha(rng: () => number, owned: readonly string[]): GachaPrize {
  const r = rng();
  const hats = GACHA_HATS.map(hatItem).filter(i => !owned.includes(i));
  if (r < GACHA_ODDS.hat && hats.length) return { kind: 'hat', item: hats[Math.floor(rng() * hats.length)] };
  const toy = (): GachaPrize => ({ kind: 'toy', item: GACHA_TOYS[Math.floor(rng() * GACHA_TOYS.length)] });
  if (r < GACHA_ODDS.hat + GACHA_ODDS.toy) return toy();
  const stickers = STICKERS.map(stickerItem).filter(i => !owned.includes(i));
  return stickers.length ? { kind: 'sticker', item: stickers[Math.floor(rng() * stickers.length)] } : toy();
}
