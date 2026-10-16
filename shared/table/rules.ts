import * as chess from './chess';
import * as draughts from './draughts';
import * as dominoes from './dominoes';
import * as lastcard from './lastcard';
import type { GameView, TableGameId } from './types';
export type GameState = { game: 'chess'; state: chess.ChessState } | { game: 'draughts'; state: draughts.DraughtsState }
  | { game: 'dominoes'; state: dominoes.DominoesState } | { game: 'lastcard'; state: lastcard.LastCardState };
export function init(game: TableGameId, seed: number, players: number): GameState {
  switch (game) {
    case 'chess': return { game, state: chess.init(seed) };
    case 'draughts': return { game, state: draughts.init(seed) };
    case 'dominoes': return { game, state: dominoes.init(seed, players) };
    case 'lastcard': return { game, state: lastcard.init(seed, players) };
  }
}
export function apply(s: GameState, player: number, move: unknown): GameState | null {
  switch (s.game) {
    case 'chess': { const state = chess.apply(s.state, player, move); return state && { game: s.game, state }; }
    case 'draughts': { const state = draughts.apply(s.state, player, move); return state && { game: s.game, state }; }
    case 'dominoes': { const state = dominoes.apply(s.state, player, move); return state && { game: s.game, state }; }
    case 'lastcard': { const state = lastcard.apply(s.state, player, move); return state && { game: s.game, state }; }
  }
}
export function view(s: GameState, player: number): GameView {
  switch (s.game) {
    case 'chess': return { game: s.game, state: chess.publicView(s.state) };
    case 'draughts': return { game: s.game, state: draughts.publicView(s.state) };
    case 'dominoes': return { game: s.game, state: player >= 0 ? dominoes.privateView(s.state, player) : dominoes.publicView(s.state) };
    case 'lastcard': return { game: s.game, state: player >= 0 ? lastcard.privateView(s.state, player) : lastcard.publicView(s.state) };
  }
}
export function leave(s: GameState, player: number): GameState {
  if (s.state.result) return s;
  if (s.game === 'dominoes') return { ...s, state: dominoes.leave(s.state, player) };
  if (s.game === 'lastcard') return { ...s, state: lastcard.leave(s.state, player) };
  return { ...s, state: { ...s.state, result: { winner: 1 - player, reason: 'Opponent left' } } } as GameState;
}
export function timeout(s: GameState): GameState {
  if (s.game === 'lastcard') return { ...s, state: lastcard.timeout(s.state) };
  if (s.game === 'dominoes') {
    let state = s.state, moves = dominoes.legalMoves(state);
    while (!moves.length && state.boneyard.length) { state = dominoes.apply(state, state.turn, { kind: 'draw' })!; moves = dominoes.legalMoves(state); }
    return { ...s, state: dominoes.apply(state, state.turn, moves[0] ?? { kind: 'pass' })! };
  }
  return { ...s, state: { ...s.state, result: { winner: 1 - s.state.turn, reason: 'Turn timed out' } } } as GameState;
}
