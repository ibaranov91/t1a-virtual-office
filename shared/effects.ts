// Per-person effects: buffs, debuffs, hats. The server owns each person's list; clients only draw it.
import { WALK_MS_PER_TILE } from './map';
import type { Effect } from './protocol';

/** Who may put an effect on someone. self: on yourself (GMs on anyone); gm: office admins only;
 *  server: only the world itself hands it out (GMs may too, for demos). */
export type EffectWho = 'self' | 'gm' | 'server';
export interface EffectRule { who: EffectWho; label: string; icon: string; ms?: number; styles?: readonly string[] }

export const HAT_STYLES = ['top', 'party', 'wizard', 'cowboy', 'crown'] as const;
export const JUDGE_HAT = 'judge'; // only the server hands this one out
export const HAT_NAMES: Record<string, string> = { top: 'Top hat', party: 'Party hat', wizard: 'Wizard hat', cowboy: 'Cowboy hat', crown: 'Crown', judge: "Judge's hat" };

export const EFFECTS: Record<string, EffectRule> = {
  speed: { who: 'server', label: 'Caffeinated', icon: '⚡', ms: 2 * 60_000 },
  hat: { who: 'self', label: 'Hat', icon: '🎩', styles: HAT_STYLES },
  vampire: { who: 'gm', label: 'Vampire', icon: '🧛', ms: 2 * 60_000 },
  fire_aura: { who: 'gm', label: 'Fire aura', icon: '🔥', ms: 2 * 60_000 },
  gum: { who: 'gm', label: 'Gum', icon: '🩲', ms: 60_000 },
  drunk: { who: 'gm', label: 'Drunk', icon: '🥴', ms: 60_000 },
  unicorns: { who: 'gm', label: 'Unicorns', icon: '🦄', ms: 90_000 },
};
export const MAX_EFFECTS = 8;

export const SPEED_FACTOR = 1.6;  // coffee: tiles per second × this
export const DRUNK_FACTOR = 0.8;  // a bit slower, a lot wobblier

export const effectOf = (effects: readonly Effect[] | undefined, kind: string) => effects?.find(e => e.kind === kind);
/** Milliseconds per tile for someone with these effects. Part of every move, so every client times the walk the same way. */
export const walkMs = (effects: readonly Effect[] | undefined) => {
  let f = 1;
  if (effectOf(effects, 'speed')) f *= SPEED_FACTOR;
  if (effectOf(effects, 'drunk')) f *= DRUNK_FACTOR;
  return Math.round(WALK_MS_PER_TILE / f);
};
