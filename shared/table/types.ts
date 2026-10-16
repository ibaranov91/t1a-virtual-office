import type { ChessView } from './chess';
import type { DraughtsView } from './draughts';
import type { DominoesView } from './dominoes';
import type { LastCardView } from './lastcard';
export const TABLE_GAMES = { chess: 'Chess', draughts: 'Checkers', dominoes: 'Dominoes', lastcard: 'Last Card' } as const;
export type TableGameId = keyof typeof TABLE_GAMES;
export interface Result { winner: number | null; reason: string }
export interface RulesState { turn: number; ply: number; result: Result | null }
export interface TableStatus { objectId: string; role: 'sitter' | 'watcher'; game: TableGameId | null; players: string[]; running: boolean }
export type GameView = { game: 'chess'; state: ChessView } | { game: 'draughts'; state: DraughtsView }
  | { game: 'dominoes'; state: DominoesView } | { game: 'lastcard'; state: LastCardView };
export interface TableView {
  objectId: string; sitters: string[]; watchers: string[]; host: string; pick: TableGameId | null;
  invitation: { game: TableGameId; invited: string[]; accepted: string[]; until: number; rematch: boolean } | null;
  match: ({ id: string; players: string[]; out: string[]; drawOffer: string | null } & GameView) | null;
  revision: number; turnDeadline: number | null; serverNow: number;
}
export function nextActive(active: readonly boolean[], turn: number, direction = 1): number {
  for (let i = 1; i <= active.length; i++) { const n = (turn + i * direction + active.length * 2) % active.length; if (active[n]) return n; }
  return turn;
}
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
