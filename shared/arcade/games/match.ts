import { arenaEvents, stats, type ArenaState } from '../arena';
import type { GameEvent } from '../types';
/** Multi-heat games keep departures separate from deaths, which are reset each heat. */
export function matchEvents(s: ArenaState, events: GameEvent[], leave?: (slot: number) => void) {
  const present = s.players.map(p => p.present), before = s.eliminated.length;
  arenaEvents(s, events, leave);
  if (!s.outcome) {
    s.eliminated.length = before;
    const left = present.flatMap((was, slot) => was && !s.players[slot].present ? [slot] : []);
    if (left.length) s.eliminated.push(left);
  }
}
export const teamed = (s: ArenaState) => s.roster.some(r => r.team !== null);
export function sides(s: ArenaState, alive = false): number[][] {
  const slots = s.roster.filter(r => s.players[r.slot].present && (!alive || s.players[r.slot].alive));
  return teamed(s) ? [0, 1].map(team => slots.filter(r => r.team === team).map(r => r.slot)).filter(g => g.length) : slots.map(r => [r.slot]);
}
export function heatPoint(s: ArenaState & { points: number[] }, living: number[][], amount = 1) {
  if (living.length !== 1) return;
  const winner = living[0][0], team = s.players[winner].team;
  for (const r of s.roster) if (team === null ? r.slot === winner : r.team === team) s.points[r.slot] += amount;
  s.fx.push({ frame: s.frame, slot: winner, kind: 'heat' });
}
/** Lexicographic metrics, with whole teams sharing a group and an empty team losing immediately. */
export function finishMatch(s: ArenaState, metrics: (slots: number[]) => number[]) {
  const groups = teamed(s) ? [0, 1].map(team => s.roster.filter(r => r.team === team).map(r => r.slot)) : sides(s);
  const value = (g: number[]) => [g.some(slot => s.players[slot].present) ? 1 : 0, ...metrics(g)];
  const compare = (a: number[], b: number[]) => { const av = value(a), bv = value(b); for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return bv[i] - av[i]; return 0; };
  groups.sort((a, b) => compare(a, b) || a[0] - b[0]);
  const order: number[][] = []; let previous: number[] | null = null;
  for (const g of groups) { if (previous && compare(previous, g) === 0) order.at(-1)!.push(...g); else order.push([...g]); previous = g; }
  if (!teamed(s)) order.push(...s.eliminated.slice().reverse());
  s.outcome = { order, stats: stats(s) };
}
