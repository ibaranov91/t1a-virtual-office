// Moving lights: how far (in tiles) a person lights up their surroundings, e.g. with a glow stick in hand.
import type { ClientUser } from './net';
import { itemDef } from '../../shared/items';

/** Radius in tiles of the light this person carries (the held item's `light`, e.g. a glow stick); 0 for none.
 *  The engine draws a soft additive glow for each person above 0 (cheap: a few at most). */
export function personLight(user: ClientUser): number {
  return itemDef(user.holding)?.light ?? 0;
}
