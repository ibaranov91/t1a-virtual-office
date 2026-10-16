import { standings, totals } from './scoring';
import type { AwardId, BreakSet } from './types';
export function awards(set: BreakSet): Record<string, AwardId[]> {
  const standing = standings(set), ids = standing.flat(), result: Record<string, AwardId[]> = Object.fromEntries(ids.map(id => [id, []]));
  const rank = (id: string) => standing.findIndex(g => g.includes(id));
  const before = Object.fromEntries(set.players.map(p => [p.userId, set.rounds.slice(0, 2).reduce((sum, r) => sum + (r.points[p.userId] ?? 0), 0)]));
  const lead = Math.max(0, ...Object.values(before)), leaders = Object.keys(before).filter(id => before[id] === lead);
  const top = standing[0] ?? [], second = standing[1]?.[0];
  const values = (id: string): [AwardId, number][] => {
    const s = totals(set, id);
    return [['MVP', set.points[id] ?? 0], ['Sharpshooter', s.kills ?? 0], ['Most Reckless', (s.deaths ?? 0) + (s.falls ?? 0)],
      ['Frequent Flyer', s.airFrames ?? 0], ['Hoarder', (s.coins ?? 0) + Math.trunc((s.holdFrames ?? 0) / 60)], ['Doormat', s.stomped ?? 0],
      ['First Out', set.rounds.filter(r => r.order.at(-1)?.length === 1 && r.order.at(-1)![0] === id).length],
      ['Comeback Kid', set.rounds.filter(r => r.underdog.includes(id)).length],
      ['Steak in Mouth', leaders.length === 1 && leaders[0] === id && !top.includes(id) ? 1 : 0],
      ['Photo Finish', top.includes(id) && (top.length > 1 || second && set.points[id] - set.points[second] <= 1) ? 1 : 0]];
  };
  const stats = Object.fromEntries(ids.map(id => [id, values(id)]));
  for (let category = 0; category < 10; category++) {
    const eligible = ids.filter(id => result[id].length < 2 && stats[id][category][1] > 0);
    eligible.sort((a, b) => stats[b][category][1] - stats[a][category][1] || rank(a) - rank(b) || set.players.find(p => p.userId === a)!.slot - set.players.find(p => p.userId === b)!.slot);
    if (eligible.length) result[eligible[0]].push(stats[eligible[0]][category][0]);
  }
  for (const id of ids) if (!result[id].length) result[id].push('Consolation Prize');
  return result;
}
