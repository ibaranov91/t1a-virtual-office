import type { Bonus, BreakSet, GameId, Outcome, PublicRoundResult, RoundResult, SetPlayer, StatKey, Stats } from './types';
export const BONUS_POOL: StatKey[] = ['airFrames', 'kills', 'distance', 'height', 'holdFrames', 'coins', 'steals', 'spikes', 'tiles', 'stomps'];
export const BONUS_LABELS: Partial<Record<StatKey, string>> = { airFrames: 'Most airtime', kills: 'Most kills', distance: 'Most distance', height: 'Greatest height', holdFrames: 'Longest hold', coins: 'Most coins', steals: 'Most steals', spikes: 'Most spikes', tiles: 'Most tiles', stomps: 'Most stomps' };
export const placePoints = (n: number) => n === 4 ? [3, 2, 1, 0] : n === 3 ? [3, 1, 0] : n === 2 ? [3, 0] : [3];
export function scoreRound(game: GameId, outcome: Outcome, players: SetPlayer[], previous: PublicRoundResult | undefined, mode: 'ffa' | '2v2', final: boolean): RoundResult {
  const bySlot = new Map(players.map(p => [p.slot, p.userId]));
  const order = outcome.order.map(g => g.map(slot => bySlot.get(slot)!).filter(Boolean)).filter(g => g.length);
  const n = order.flat().length, points: Record<string, number> = {}, underdog: string[] = [];
  const last = previous?.order.at(-1), eligible = last?.length === 1 ? last[0] : null;
  let place = 0;
  for (const group of order) {
    for (const id of group) {
      points[id] = (mode === '2v2' ? place === 0 ? 3 : 0 : placePoints(n)[place] ?? 0) * (final ? 2 : 1);
      if (id === eligible && place < Math.trunc(n / 2) && !players.find(p => p.userId === id)?.left) { points[id]++; underdog.push(id); }
      if (outcome.signal?.kind === 'park' && outcome.signal.cleared) points[id]++;
    }
    place += group.length;
  }
  return { game, order, points, underdog, final, stats: Object.fromEntries(Object.entries(outcome.stats).map(([slot, stats]) => [bySlot.get(+slot)!, stats])), predictions: [] };
}
export function totals(set: Pick<BreakSet, 'rounds'>, id: string): Stats {
  const result: Stats = {};
  for (const r of set.rounds) for (const [key, value] of Object.entries(r.stats[id] ?? {})) result[key as StatKey] = (result[key as StatKey] ?? 0) + value;
  return result;
}
export function standings(set: Pick<BreakSet, 'players' | 'rounds' | 'points'>): string[][] {
  const third = set.rounds[2]?.order ?? [];
  const place = (id: string) => { const i = third.findIndex(g => g.includes(id)); return i < 0 ? 99 : i; };
  const sorted = set.players.filter(p => !p.left).sort((a, b) => (set.points[b.userId] ?? 0) - (set.points[a.userId] ?? 0) || place(a.userId) - place(b.userId) || a.slot - b.slot);
  const groups: string[][] = [];
  for (const p of sorted) {
    const previous = groups.at(-1)?.[0];
    if (previous !== undefined && set.points[previous] === set.points[p.userId] && place(previous) === place(p.userId)) groups.at(-1)!.push(p.userId);
    else groups.push([p.userId]);
  }
  return groups;
}
export function bonusStar(set: BreakSet): Bonus | null {
  const ids = set.players.filter(p => !p.left).map(p => p.userId);
  for (const category of set.bonus) {
    const value = Math.max(0, ...ids.map(id => totals(set, id)[category] ?? 0));
    if (value > 0) return { category, value, winners: ids.filter(id => totals(set, id)[category] === value) };
  }
  return null;
}
export function favouriteWinners(votes: Record<string, string>, candidates: string[]): string[] {
  const count = (id: string) => Object.values(votes).filter(v => v === id).length;
  const max = Math.max(0, ...candidates.map(count));
  return max ? candidates.filter(id => count(id) === max) : [];
}
