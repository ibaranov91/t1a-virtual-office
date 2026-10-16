import { define, type GameId } from './types';
import { hub } from './hub';
import { vote } from './vote';
import { park } from './games/park';
import { crumble } from './games/crumble';
import { crown } from './games/crown';
import { quiver } from './games/quiver';
import { screenrun } from './games/screenrun';
import { volley } from './games/volley';
import { trails } from './games/trails';
import { skylanes } from './games/skylanes';
export const GAMES = { hub: define(hub), vote: define(vote), park: define(park), crumble: define(crumble), crown: define(crown), quiver: define(quiver), screenrun: define(screenrun), volley: define(volley), trails: define(trails), skylanes: define(skylanes) };
export function gameDef(id: GameId) { if (!(id in GAMES)) throw new Error(`Game not built: ${id}`); return GAMES[id as keyof typeof GAMES]; }
export function eligible(count: number, mode: 'ffa' | '2v2'): GameId[] {
  return Object.values(GAMES).filter(g => g.id !== 'hub' && g.id !== 'vote' && (mode === '2v2' ? count === 4 && g.modes.teams : g.modes.ffa.includes(count))).map(g => g.id);
}
