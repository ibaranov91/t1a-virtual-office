// Per-person effects: buffs, debuffs, hats. The server owns each person's list; clients only draw it.
import { WALK_MS_PER_TILE } from './map';
import type { Effect } from './protocol';

/** Who may put an effect on someone. self: on yourself (GMs on anyone); gm: office admins only;
 *  server: only the world itself hands it out (GMs may too, for demos). */
export type EffectWho = 'self' | 'gm' | 'server';
export interface EffectRule { who: EffectWho; label: string; icon: string; ms?: number; styles?: readonly string[] }

export const HAT_STYLES = ['top', 'party', 'wizard', 'cowboy', 'crown'] as const; // on the Lobby hat stand
/** Special hats: nobody finds them, an admin gifts them to a person (the GM panel). Odyssey-style, plus the old judge hat. */
export const SPECIAL_HATS = ['judge', 'laurel', 'winged', 'crested'] as const;
export const ADMIN_HAT = 'admin'; // the server puts this one in an office admin's pockets
export const BAT_HAT = 'bat';     // from catching the October bat
export const PRISON_HAT_STYLE = 'prison'; // put on a thief by the server; can't come off for two days (shared/items.ts PRISON_MS)
/** Achievement hats (decision 3): at 5, 10 and 15 achievements you pick one you don't own yet (shared/rewards.ts). */
export const ACHIEVEMENT_HATS = ['shark', 'catears', 'foxears', 'frog', 'onigiri', 'apple', 'coffeecup', 'mushroom'] as const;
/** Hats only the gacha machine gives (shared/gacha.ts). */
export const GACHA_HATS = ['capsule', 'tinycrown'] as const;
export const SEWN_HAT = 'handsewn'; // the sewing kit's hour of work (via the `sewn_hat` item)
export const ALL_HATS = [...HAT_STYLES, ...SPECIAL_HATS, ADMIN_HAT, BAT_HAT, PRISON_HAT_STYLE, ...ACHIEVEMENT_HATS, ...GACHA_HATS, SEWN_HAT] as const;
export const HAT_NAMES: Record<string, string> = { top: 'Top hat', party: 'Party hat', wizard: 'Wizard hat', cowboy: 'Cowboy hat', crown: 'Crown', judge: "Judge's hat", laurel: 'Laurel wreath', winged: 'Winged helmet', crested: 'Crested helmet', admin: 'Admin cap', bat: 'Bat hat', prison: 'Prison hat',
  shark: 'Shark hat', catears: 'Cat ears', foxears: 'Fox ears', frog: 'Frog hat', onigiri: 'Onigiri hat', apple: 'Apple hat', coffeecup: 'Coffee cup hat', mushroom: 'Mushroom hat',
  capsule: 'Capsule-shell hat', tinycrown: 'Tiny crown', handsewn: 'Hand-sewn beanie' };
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
  drunk: { who: 'server', label: 'Drunk', icon: '🥴', ms: 60_000 },
  refreshed: { who: 'server', label: 'Refreshed', icon: '🥥', ms: 60_000 },
  chilled: { who: 'server', label: 'Brain freeze', icon: '❄️', ms: 45_000 },
  unicorns: { who: 'gm', label: 'Unicorns', icon: '🦄', ms: 90_000 },
  // ---------- item content (v2): 7/11 goods, toys ----------
  freeze: { who: 'server', label: 'Shivering', icon: '🥶', ms: 6_000 },      // slurpee: a short shiver and a ❄ over you (stacks with chilled)
  crash: { who: 'server', label: 'Energy crash', icon: '😵', ms: 45_000 },   // after an energy drink wears off: slower
  confetti: { who: 'server', label: 'Confetti', icon: '🎉', ms: 4_000 },     // party popper
  bubble: { who: 'server', label: 'Bubble gum', icon: '🫧', ms: 9_000 },     // bubble gum: a pink bubble over your head
  snow: { who: 'server', label: 'Snow aura', icon: '☃️', ms: 10 * 60_000 },  // snowball
  sewing: { who: 'server', label: 'Sewing', icon: '🧵', ms: 3 * 3600_000 },  // sewing kit; the server ends it (timed, so never saved)
  driving: { who: 'server', label: 'Driving', icon: '🎮', ms: 3 * 3600_000 }, // remote car; data.car = the car's prop id
};
export const MAX_EFFECTS = 8;
export const BITE_MS = 2 * 60_000; // a vampire's bite turns you for this long (from now, whatever the biter has left)
export const DANCE_ROOM = 'berghain';
export const DANCE_BPM = 120; // everyone sways to the same Date.now()-based beat
/** The beat number at this time: Date.now()-based so everyone in the club moves together. */
export const danceBeat = (ms: number) => Math.floor((ms * DANCE_BPM) / 60_000);
export const dancePhase = (ms: number) => ((ms * DANCE_BPM) / 60_000) % 1; // 0 on the beat, rising to 1 before the next
export const RAVER_MS = 30 * 60_000; // total dancing for the `raver` achievement

export const SPEED_FACTOR = 1.6;  // coffee: tiles per second × this
export const ENERGY_FACTOR = 2.1; // energy drink (speed with data.boost): faster than coffee
export const ENERGY_MS = 5 * 60_000;
export const CRASH_FACTOR = 0.7;  // the crash after it
export const DRUNK_FACTOR = 0.8;  // a bit slower, a lot wobblier
export const DRUNK_MISWALK = 0.25;       // chance a drunk walk ends one tile off from where you clicked
export const DRUNK_MAX_LEVEL = 3;
export const DRUNK_MAX_MS = 3 * 60_000;
export const DRUNK_NAMES = ['Tipsy', 'Drunk', 'Wasted'] as const;
export const REFRESHMENT_HINTS: Record<string, string> = {
  cocktail: 'Get tipsy for 1 min · more rounds make you wobblier (max 3) · coconut sobers you up',
  coconut: 'Refresh yourself · removes one tipsy level and 1 min of wobble',
  icecream: 'Brain freeze for 45 sec · snowflakes and a cure for a fire aura',
};

/** Old GM effects have no level; they keep their original strength. */
export function drunkLevel(e: Effect | undefined): number {
  if (!e) return 0;
  const level = Number(e.data?.level ?? 1);
  return Math.max(1, Math.min(DRUNK_MAX_LEVEL, Number.isFinite(level) ? Math.floor(level) : 1));
}
export const effectName = (e: Effect) => e.kind === 'drunk' ? DRUNK_NAMES[drunkLevel(e) - 1] : EFFECTS[e.kind]?.label ?? e.kind;

export const effectOf = (effects: readonly Effect[] | undefined, kind: string) => effects?.find(e => e.kind === kind);
/** Milliseconds per tile for someone with these effects. Part of every move, so every client times the walk the same way. */
export const walkMs = (effects: readonly Effect[] | undefined) => {
  let f = 1;
  const speed = effectOf(effects, 'speed');
  if (speed) f *= speed.data?.boost ? ENERGY_FACTOR : SPEED_FACTOR;
  if (effectOf(effects, 'crash')) f *= CRASH_FACTOR;
  const drunk = drunkLevel(effectOf(effects, 'drunk'));
  if (drunk) f *= DRUNK_FACTOR - (drunk - 1) * 0.1;
  return Math.round(WALK_MS_PER_TILE / f);
};
