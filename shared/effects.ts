// Per-person effects: buffs, debuffs, hats. The server owns each person's list; clients only draw it.
import { WALK_MS_PER_TILE } from './map';
import type { Effect } from './protocol';

/** Who may put an effect on someone. self: on yourself (GMs on anyone); gm: office admins only;
 *  server: only the world itself hands it out (GMs may too, for demos). */
export type EffectWho = 'self' | 'gm' | 'server';
export interface EffectRule { who: EffectWho; label: string; icon: string; ms?: number; styles?: readonly string[] }

export const HAT_STYLES = ['top', 'party', 'wizard', 'cowboy', 'crown'] as const; // on the Lobby hat stand
export const JUDGE_HAT = 'judge'; // the server puts it in a judge's pockets
export const ADMIN_HAT = 'admin'; // and this one in an office admin's
export const ALL_HATS = [...HAT_STYLES, JUDGE_HAT, ADMIN_HAT] as const;
export const HAT_NAMES: Record<string, string> = { top: 'Top hat', party: 'Party hat', wizard: 'Wizard hat', cowboy: 'Cowboy hat', crown: 'Crown', judge: "Judge's hat", admin: 'Admin cap' };
/** Hats are inventory items: `hat:<style>`. You wear one of the hats in your pockets. */
export const hatItem = (style: string) => `hat:${style}`;
export const hatOf = (item: string) => (item.startsWith('hat:') ? item.slice(4) : null);

export const EFFECTS: Record<string, EffectRule> = {
  speed: { who: 'server', label: 'Caffeinated', icon: '⚡', ms: 2 * 60_000 },
  hat: { who: 'self', label: 'Hat', icon: '🎩', styles: ALL_HATS }, // self: only a hat from your pockets
  dance: { who: 'self', label: 'Dancing', icon: '🕺', ms: 3 * 60_000 }, // Berghain's floor only; the server ends it when you leave or sit
  vampire: { who: 'gm', label: 'Vampire', icon: '🧛', ms: 2 * 60_000 },
  fire_aura: { who: 'gm', label: 'Fire aura', icon: '🔥', ms: 2 * 60_000 },
  gum: { who: 'gm', label: 'Gum', icon: '🩲', ms: 60_000 },
  drunk: { who: 'gm', label: 'Drunk', icon: '🥴', ms: 60_000 },
  unicorns: { who: 'gm', label: 'Unicorns', icon: '🦄', ms: 90_000 },
};
export const MAX_EFFECTS = 8;
export const DANCE_ROOM = 'berghain';
export const DANCE_BPM = 120; // everyone sways to the same Date.now()-based beat
/** The beat number at this time: Date.now()-based so everyone in the club moves together. */
export const danceBeat = (ms: number) => Math.floor((ms * DANCE_BPM) / 60_000);
export const RAVER_MS = 30 * 60_000; // total dancing for the `raver` achievement

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
