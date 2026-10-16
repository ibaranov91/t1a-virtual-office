import { LEVELS } from '../../park/levels';
import { parkInit, parkStep, type LevelDef, type ParkState } from '../../park/sim';
import type { GameDef, GameEvent, RosterEntry } from '../types';
export interface ParkOptions { level: number; card: boolean }
export interface ParkGameState extends ParkState { level: number; card: boolean; roster: RosterEntry[]; departed: number[][] }
export function parkDefinition(levels: LevelDef[] = LEVELS): GameDef<ParkGameState, ParkOptions> {
  return {
    id: 'park', name: 'Deck Park', goal: 'Work together. Collect coins, carry the key, reach the door.', controls: ['move', 'jump'], players: [1, 4], modes: { ffa: [1, 2, 3, 4], teams: false },
    init(_seed, roster, opts) { return { ...parkInit(levels[opts.level]), level: opts.level, card: opts.card, roster: structuredClone(roster), departed: [] }; },
    step(s, events) {
      if (!s.outcome) {
        const left = events.filter(e => e[2] === 2 && s.players[e[1]]?.present).map(e => e[1]);
        if (left.length) s.departed.push(left);
      }
      parkStep(s, levels[s.level], events);
      if (s.outcome || !s.cleared && (!s.card || s.frame < 7200)) return;
      const slots = s.roster.map(r => r.slot).filter(slot => s.players[slot].present);
      const personal = (slot: number) => (s.stats[slot].coins ?? 0) + 2 * (s.stats[slot].stomps ?? 0) + 5 * s.keyDoor[slot] - 2 * (s.stats[slot].deaths ?? 0);
      slots.sort((a, b) => personal(b) - personal(a) || a - b);
      const order: number[][] = [];
      for (const slot of slots) if (order.length && personal(order.at(-1)![0]) === personal(slot)) order.at(-1)!.push(slot); else order.push([slot]);
      s.outcome = { order: [...order, ...s.departed.slice().reverse()], stats: Object.fromEntries(s.roster.map(r => [r.slot, { ...s.stats[r.slot], personal: personal(r.slot) }])), signal: { kind: 'park', cleared: s.cleared } };
    },
    bits: (s, slot) => s.players[slot]?.bits ?? 0,
  };
}
export const park = parkDefinition();
export const joins = (roster: RosterEntry[]): GameEvent[] => [...roster].sort((a, b) => a.slot - b.slot).map(p => [0, p.slot, 1, 0]);
