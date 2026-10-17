// Moving lights: how far (in tiles) a person lights up their surroundings, e.g. with a glow stick in hand.
import type { ClientUser } from './net';

/**
 * Radius in tiles of the light this person carries; 0 for none. The engine draws a soft additive glow for each person
 * above 0 (cheap: a few at most). Not wired yet: the glow stick's `ITEMS[held]?.light` plugs in here once the item
 * content lands, e.g. `return ITEMS.get(user.holding ?? '')?.light ?? 0`.
 */
export function personLight(_user: ClientUser): number {
  return 0;
}
