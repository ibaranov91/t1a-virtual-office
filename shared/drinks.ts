// Drinks: what happens when you drink what you're holding. Taking a drink gives nothing; drinking it does.
// Coffee and tea sip themselves after a while (people who never click still get their buff); alcohol only on
// a deliberate `drink`, so carrying a cocktail to a friend never gets you drunk by accident.

export interface DrinkRule {
  effect: 'speed' | 'refreshment'; // when the sip ends: the coffee buff, or World.refreshment (drunk levels, coconut, ice cream)
  sipMs: number;              // how long drinking takes (the sip animation)
  autoSipMs?: number;         // drink by yourself after holding this long; absent: only on `drink`
  alcohol?: true;             // a round of `drunk` (World.refreshment)
  glass?: true;               // a glass, not a cup: drunk people drop it sooner and it shatters
  cup?: true;                 // leaves an empty cup or glass in hand (CUP_ITEMS); without it the drink is just gone
}

export const DRINKS: Record<string, DrinkRule> = {
  coffee: { effect: 'speed', sipMs: 2500, autoSipMs: 60_000, cup: true },
  tea: { effect: 'speed', sipMs: 2500, autoSipMs: 60_000, cup: true },
  cocktail: { effect: 'refreshment', sipMs: 2500, alcohol: true, glass: true, cup: true },
  beer: { effect: 'refreshment', sipMs: 2500, alcohol: true, glass: true, cup: true },
  wine: { effect: 'refreshment', sipMs: 2500, alcohol: true, glass: true, cup: true },
  coconut: { effect: 'refreshment', sipMs: 2500, autoSipMs: 60_000 },
  icecream: { effect: 'refreshment', sipMs: 2500, autoSipMs: 60_000 },
};
export const DRINK_ITEMS = Object.keys(DRINKS);
export const ALCOHOL_ITEMS = DRINK_ITEMS.filter(id => DRINKS[id].alcohol);

/** An empty cup or glass in hand: `empty:<drink>`. */
export const EMPTY_PREFIX = 'empty:';
export const emptyOf = (drink: string) => `${EMPTY_PREFIX}${drink}`;
/** The drink this empty cup held, or null if it's not an empty cup. */
export const emptyDrink = (holding: string | null | undefined) => (holding?.startsWith(EMPTY_PREFIX) ? holding.slice(EMPTY_PREFIX.length) : null);
export const isEmpty = (holding: string | null | undefined) => !!emptyDrink(holding);

export const EMPTY_DROP_MS = 5 * 60_000;       // an empty cup slips out of your hand after this long
export const EMPTY_DROP_DRUNK_MS = 2 * 60_000; // sooner when drunk (and a glass shatters)
