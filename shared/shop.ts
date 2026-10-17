// The 7/11: everything on the shelves is free, but each person takes at most SHOP_DAILY_MAX things per office day
// (shared/officeTime.ts). Pure rules here; the server keeps the count (`User.shop`) and moves the item with moveItem.
import { itemDef, type ItemDef } from './items';
import { officeDay } from './officeTime';

export const SHOP_STOCK = ['onigiri', 'cup_noodles', 'slurpee', 'energy_drink', 'party_popper', 'glow_stick', 'umbrella', 'postcard', 'bubble_gum'] as const;
export const SHOP_DAILY_MAX = 3;
/** What one person has taken from the shelves, and on which office day. */
export interface ShopTaken { day: string; taken: string[] }

/** The shelves' items that exist in the item registry (the rest are added by their own sessions and show up by themselves). */
export const shopStock = (): ItemDef[] => SHOP_STOCK.flatMap(id => { const d = itemDef(id); return d ? [d] : []; });
/** What this person took today (nothing once the office day has changed). */
export const takenToday = (s: ShopTaken | undefined, now = Date.now()): string[] => (s && s.day === officeDay(now) ? s.taken : []);
/** How many more they may take today. */
export const shopLeft = (s: ShopTaken | undefined, now = Date.now()) => Math.max(0, SHOP_DAILY_MAX - takenToday(s, now).length);
/** Why this can't be taken, or null. An item with its own `daily` limit (ItemDef.daily) is held to that as well. */
export function shopProblem(s: ShopTaken | undefined, item: string, now = Date.now()): string | null {
  const def = itemDef(item);
  if (!def || !(SHOP_STOCK as readonly string[]).includes(item)) return 'Not on the shelves';
  const taken = takenToday(s, now);
  if (taken.length >= SHOP_DAILY_MAX) return 'That is your last one today. See you tomorrow';
  if (def.daily !== undefined && taken.filter(i => i === item).length >= def.daily) return `Only ${def.daily} ${def.label.toLowerCase()} a day`;
  return null;
}
/** The record after taking `item` (a new day starts a fresh list). */
export const shopTake = (s: ShopTaken | undefined, item: string, now = Date.now()): ShopTaken => ({ day: officeDay(now), taken: [...takenToday(s, now), item] });
