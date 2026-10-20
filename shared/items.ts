// The item registry: one `ItemDef` per thing a person can hold, carry or wear. Drinks, snacks, books, drugs and hats are
// all here; a new item is one entry (plus a frame in scripts/gen-assets.mjs if it has art beyond its emoji).
// What lives where: `User.items` are pockets (strings), `holding` is the hands, `User.storage` is the desk
// storage, and a thing put down in the world is a prop (`Cup` in protocol.ts, the saved `cups` layer).
import type { DrinkRule } from './drinks';
import { ALL_HATS, ENERGY_MS, HAT_NAMES, hatItem, hatOf } from './effects';
import { STICKERS, STICKER_ICONS, stickerItem } from './gacha';

export type ItemKind = 'hat' | 'held' | 'placeable' | 'consumable' | 'throwable';
/** What the action wheel may offer for a held item. */
export type ItemAction = 'drink' | 'drop' | 'stow' | 'throw' | 'give' | 'put_down' | 'use' | 'write';
/** How an item counts in pockets: toward the limit, free (hats), or never carried there (drinks, books, meals). */
export type PocketRule = 'counts' | 'free' | 'no';
/** Data instead of code for `onUse` / `onHit`: apply an effect (shared/effects.ts) to whoever used it or was hit. */
export interface ItemEffect { effect: string; ms?: number; on: 'self' | 'target' | 'both'; radius?: number; data?: Record<string, unknown> } // radius (onUse): also everyone within that many tiles

export interface ItemDef {
  id: string;
  label: string;
  icon: string;               // emoji: drawn in the hand, on the wheel and in lists
  kind: ItemKind;
  pocket: PocketRule;
  stack?: number;             // at most this many of it in pockets (default: only the pocket limit)
  daily?: number;             // per person per day (the 7/11); enforcement comes with the shelves
  sprite?: string;            // world-atlas frame drawn as the held layer / world prop instead of the emoji
  actions: readonly ItemAction[];
  drink?: DrinkRule;          // sipping it: shared/drinks.ts derives DRINKS from this
  onUse?: readonly ItemEffect[];  // 'use' on the wheel (and the end of a sip for drinks with `effect: 'use'`): World.useHeld applies these
  onHit?: readonly ItemEffect[]; // when thrown at someone and it lands
  useLabel?: string;          // the wheel's word for 'use' (default "Use")
  light?: number;             // held or placed, it is a small light of this radius in tiles (the atmosphere pass reads it)
  toy?: true;                 // a toy: lies on the floor until picked up (owner kept), never tidied by the cleaner
}

export const POCKET_MAX = 6;       // items in pockets; hats don't count
export const STORAGE_LOG_MAX = 50; // who took what, per container
export const PRISON_HAT = 'prison';
export const PRISON_MS = 2 * 24 * 3600_000; // the thief's hat can't come off for this long (only an office admin can take it off)
export const PRISON_NOTE = 'Taken from a desk · only an admin can take this off';

const drinkItem = (id: string, label: string, icon: string, drink: DrinkRule): ItemDef =>
  ({ id, label, icon, kind: 'consumable', pocket: 'no', actions: ['drink'], drink }); // empty cups are 'drop' (heldActions)
const plain = (id: string, label: string, icon: string): ItemDef => ({ id, label, icon, kind: 'held', pocket: 'no', actions: ['drop', 'give'] });

/** Toys the cleaner leaves alone; they persist on the floor (long ttl) and don't count against the cup limit. */
const toy = (d: ItemDef): ItemDef => ({ ...d, toy: true });
const sticker = (design: string): ItemDef => ({ id: stickerItem(design), label: `${design[0].toUpperCase()}${design.slice(1)} sticker`, icon: STICKER_ICONS[design as keyof typeof STICKER_ICONS], kind: 'held', pocket: 'free', stack: 1, actions: [] });
export const POSTCARD = 'postcard';
export const POSTCARD_PREFIX = `${POSTCARD}:`;
export const POSTCARD_MAX = 80;
/** A written postcard is its text in the id: `postcard:<text>`. Cleans a line a person typed (control characters out, one line, capped); null if empty. */
export function postcardText(raw: unknown): string | null {
  const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, POSTCARD_MAX).trim();
  return text || null;
}
export const postcardItem = (text: string) => `${POSTCARD_PREFIX}${text}`;
export const postcardOf = (item: string | null | undefined) => (item?.startsWith(POSTCARD_PREFIX) ? item.slice(POSTCARD_PREFIX.length) : null);
const POSTCARD_DEF = { label: 'Postcard', icon: '💌', kind: 'throwable', pocket: 'counts', actions: ['stow', 'throw', 'drop'] } as const satisfies Partial<ItemDef>;

const DEFS: ItemDef[] = [
  drinkItem('coffee', 'Coffee', '☕', { effect: 'speed', sipMs: 2500, autoSipMs: 60_000, cup: true }),
  drinkItem('tea', 'Tea', '🍵', { effect: 'speed', sipMs: 2500, autoSipMs: 60_000, cup: true }),
  drinkItem('cocktail', 'Cocktail', '🍹', { effect: 'refreshment', sipMs: 2500, alcohol: true, glass: true, cup: true }),
  drinkItem('beer', 'Beer', '🍺', { effect: 'refreshment', sipMs: 2500, alcohol: true, glass: true, cup: true }),
  drinkItem('wine', 'Wine', '🍷', { effect: 'refreshment', sipMs: 2500, alcohol: true, glass: true, cup: true }),
  drinkItem('coconut', 'Coconut', '🥥', { effect: 'refreshment', sipMs: 2500, autoSipMs: 60_000 }),
  drinkItem('icecream', 'Ice cream', '🍦', { effect: 'refreshment', sipMs: 2500, autoSipMs: 60_000 }),
  plain('juice', 'Juice', '🧃'), plain('snack', 'Snack', '🥪'),
  plain('sandwich', 'Sandwich', '🥪'), plain('ramen', 'Ramen', '🍜'), plain('salad', 'Salad', '🥗'), plain('pizza', 'Pizza', '🍕'),
  { id: 'book', label: 'Book', icon: '📖', kind: 'held', pocket: 'no', actions: ['drop'] },
  { id: 'drugs', label: 'Drugs', icon: '💊', kind: 'throwable', pocket: 'counts', actions: ['stow', 'throw', 'drop'] },
  // cup noodles (7/11): dry in your pockets or hands -> fill at the kitchen kettle -> hot noodles, eaten at a table (shared/lunch.ts)
  { id: 'cup_noodles', label: 'Cup noodles', icon: '🥡', kind: 'throwable', pocket: 'counts', actions: ['stow', 'throw', 'drop'] },
  plain('hot_noodles', 'Hot noodles', '🍜'),
  // ---------- 7/11 goods (v2) ----------
  { ...plain('onigiri', 'Onigiri', '🍙'), actions: ['use', 'drop', 'give'], useLabel: 'Eat', onUse: [] },
  { ...drinkItem('slurpee', 'Slurpee', '🥤', { effect: 'use', sipMs: 2500 }), onUse: [{ effect: 'freeze', on: 'self' }, { effect: 'chilled', on: 'self' }] },
  { ...drinkItem('energy_drink', 'Energy drink', '🥫', { effect: 'use', sipMs: 1800 }), onUse: [{ effect: 'speed', ms: ENERGY_MS, on: 'self', data: { boost: 2 } }] },
  { id: 'party_popper', label: 'Party popper', icon: '🎉', kind: 'held', pocket: 'counts', actions: ['use', 'stow', 'drop'], useLabel: 'Pop it', onUse: [{ effect: 'confetti', on: 'self', radius: 2 }] },
  { id: 'glow_stick', label: 'Glow stick', icon: '🟢', kind: 'held', pocket: 'counts', sprite: 'glow_stick', actions: ['stow', 'drop', 'throw'], light: 3 },
  { id: 'umbrella', label: 'Umbrella', icon: '☂️', kind: 'throwable', pocket: 'counts', stack: 1, actions: ['stow', 'throw', 'drop'] },
  { id: POSTCARD, ...POSTCARD_DEF, kind: 'held', actions: ['write', 'stow', 'drop'], useLabel: 'Write' },
  { id: 'bubble_gum', label: 'Bubble gum', icon: '🫧', kind: 'held', pocket: 'counts', actions: ['use', 'stow', 'drop'], useLabel: 'Blow a bubble', onUse: [{ effect: 'bubble', on: 'self' }] },
  // ---------- daily toys and what they make (v2) ----------
  toy({ id: 'snowball', label: 'Snowball', icon: '❄️', kind: 'throwable', pocket: 'counts', sprite: 'toy_snowball', actions: ['stow', 'throw', 'drop'], onHit: [{ effect: 'snow', on: 'both' }] }),
  toy({ id: 'train', label: 'Choo-choo train', icon: '🚂', kind: 'placeable', pocket: 'counts', sprite: 'toy_train', actions: ['stow', 'drop'] }),
  toy({ id: 'remote_car', label: 'Remote car', icon: '🏎️', kind: 'placeable', pocket: 'counts', sprite: 'toy_car', actions: ['use', 'stow', 'drop'], useLabel: 'Drive' }),
  toy({ id: 'sewing_kit', label: 'Sewing kit', icon: '🧵', kind: 'held', pocket: 'counts', sprite: 'toy_sewing', actions: ['use', 'stow', 'drop'], useLabel: 'Sit and sew' }),
  { id: 'sewn_hat', label: 'Hand-sewn beanie', icon: '🧶', kind: 'throwable', pocket: 'counts', actions: ['use', 'stow', 'throw', 'drop'], useLabel: 'Wear it' },
  ...STICKERS.map(sticker),
  ...ALL_HATS.map((style): ItemDef => ({ id: hatItem(style), label: HAT_NAMES[style] ?? style, icon: '🎩', kind: 'hat', pocket: 'free', stack: 1, actions: [] })),
];

// Pixel art for what people hold and drop (scripts/gen-assets.mjs, `item_<id>`); anything else (stickers) stays an emoji.
const ITEM_ART = ['coffee', 'tea', 'cocktail', 'beer', 'wine', 'coconut', 'icecream', 'juice', 'snack', 'sandwich', 'ramen', 'salad', 'pizza', 'onigiri',
  'cup_noodles', 'hot_noodles', 'slurpee', 'energy_drink', 'party_popper', 'umbrella', 'postcard', 'bubble_gum', 'book', 'drugs', 'sewn_hat'];
for (const d of DEFS) if (!d.sprite && ITEM_ART.includes(d.id)) d.sprite = `item_${d.id}`;
export const ITEM_DEFS: Record<string, ItemDef> = Object.fromEntries(DEFS.map(d => [d.id, d]));
/** Registry lookup; hats of any style are found even when the style isn't listed yet. */
export function itemDef(id: string | null | undefined): ItemDef | undefined {
  if (!id) return undefined;
  if (Object.prototype.hasOwnProperty.call(ITEM_DEFS, id)) return ITEM_DEFS[id];
  if (id.startsWith(POSTCARD_PREFIX)) return { id, ...POSTCARD_DEF, label: 'Postcard' };
  const style = hatOf(id);
  return style ? { id, label: HAT_NAMES[style] ?? style, icon: '🎩', kind: 'hat', pocket: 'free', stack: 1, actions: [] } : undefined;
}
export const isHatItem = (id: string) => itemDef(id)?.kind === 'hat';
export const isToy = (id: string) => !!itemDef(id)?.toy;
/** Can this go in pockets / desk storage at all? */
export const canCarry = (id: string) => { const d = itemDef(id); return !!d && d.pocket !== 'no'; };

/** Items in pockets that count toward the limit. */
export const pocketCount = (items: readonly string[]) => items.filter(i => itemDef(i)?.pocket === 'counts').length;

/** Why `item` can't go into pockets holding `items`, or null. Hats: one of each, never counted. */
export function pocketProblem(items: readonly string[], item: string): string | null {
  const d = itemDef(item);
  if (!d || d.pocket === 'no') return 'That doesn\'t fit in your pockets';
  if (d.pocket === 'free') return items.includes(item) ? (d.kind === 'hat' ? 'You already have that hat' : 'You already have that one') : null;
  if (pocketCount(items) >= POCKET_MAX) return 'Your pockets are full';
  if (d.stack !== undefined && items.filter(i => i === item).length >= d.stack) return 'Your pockets are full';
  return null;
}

/** What a held item offers on its owner's wheel. `empty`: an empty cup or glass. */
export function heldActions(id: string | null | undefined, empty = false): ItemAction[] {
  if (!id) return [];
  if (empty) return ['drop'];
  return [...(itemDef(id)?.actions ?? ['drop'])];
}
/** Can it be thrown (and so land in pockets)? Anything else is handed over. */
export const isThrowable = (id: string) => { const d = itemDef(id); return !!d && d.pocket === 'counts' && d.actions.includes('throw'); };

/** A pocketable item in hand stays until you put it away or drop it; the rest fade after a while (server HOLD_MS). */
export const holdsForever = (id: string) => itemDef(id)?.pocket === 'counts';

// ---------- containers ----------
/** A thing that holds items and remembers who took what. Personal desk storage is one; shelves and the trophy case use the same. */
export interface ItemContainer { items: string[]; log: TakeRecord[] }
export interface TakeRecord { by: string; name: string; item: string; at: number }
export const newContainer = (): ItemContainer => ({ items: [], log: [] });
export type ContainerRef =
  | { kind: 'pockets'; id: string }  // a person's pockets
  | { kind: 'hands'; id: string }    // what a person holds
  | { kind: 'desk'; id: string }     // a person's desk storage (id: owner)
  | { kind: 'shelf'; id: string }    // any other container by id
  | { kind: 'void' };                // nowhere: items an admin conjures, or consumed
