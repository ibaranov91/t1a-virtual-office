import { games } from './games';
import type { RetroBoards, RetroEntry } from './types';
export const compareScore = (a: RetroEntry, b: RetroEntry) => b.score - a.score || (a.time ?? 0) - (b.time ?? 0);
export const ranked = (entries: Record<string, RetroEntry>) => Object.values(entries).sort((a, b) => compareScore(a, b) || a.at - b.at || a.userId.localeCompare(b.userId)).map((entry, i, all) => ({ ...entry, rank: 1 + all.filter(other => compareScore(other, entry) < 0).length }));
export function emptyBoards(week: string): RetroBoards {
  return { week, games: {
    tobu: Object.fromEntries(games.tobu.tracks.map(t => [t.id, { all: Object.create(null), week: Object.create(null) }])),
    lobster: Object.fromEntries(games.lobster.tracks.map(t => [t.id, { all: Object.create(null), week: Object.create(null) }])),
  } };
}
