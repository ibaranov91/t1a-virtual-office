import { eligible } from './registry';
import { shuffle, type RandomState } from './rng';
import type { GameId } from './types';
import type { VoteCard } from './vote';
export function ballot(rng: RandomState, count: number, mode: 'ffa' | '2v2', played: GameId[]): VoteCard[] {
  const all = eligible(count, mode);
  let pool = all.filter(id => !played.slice(-2).includes(id));
  if (pool.length < 2) pool = all.filter(id => id !== played.at(-1));
  if (pool.length < 2) pool = all;
  const picks = shuffle(rng, pool);
  const card = (game: GameId, surprise = false): VoteCard => ({ game: surprise ? 'surprise' : game, resolves: game, opts: game === 'park' ? { level: 1 + (shuffle(rng, [0, 1, 2, 3, 4, 5, 6, 7])[0]), card: true } : { mode } });
  return [...picks.slice(0, 2).map(id => card(id)), ...(picks.length > 2 ? [card(picks[2], true)] : [])];
}
