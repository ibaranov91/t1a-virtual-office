import { Chess, type Square } from 'chess.js';
import { record, type RulesState } from './types';
export interface ChessMove { from: string; to: string; promotion?: string }
export interface ChessState extends RulesState { moves: ChessMove[] }
export interface ChessView extends RulesState { fen: string; check: boolean; moves: ChessMove[]; legal: ChessMove[] }
export function position(s: ChessState): Chess {
  const c = new Chess();
  for (const m of s.moves) c.move({ from: m.from, to: m.to, promotion: m.promotion });
  return c;
}
export function init(_seed = 0): ChessState { return { moves: [], turn: 0, ply: 0, result: null }; }
export function outcome(c: Chess): ChessState['result'] {
  if (c.isCheckmate()) return { winner: c.turn() === 'w' ? 1 : 0, reason: 'Checkmate' };
  if (c.isStalemate()) return { winner: null, reason: 'Stalemate' };
  if (c.isInsufficientMaterial()) return { winner: null, reason: 'Insufficient material' };
  if (c.isThreefoldRepetition()) return { winner: null, reason: 'Threefold repetition' };
  if (c.isDrawByFiftyMoves()) return { winner: null, reason: '50-move rule' };
  return null;
}
export function apply(s: ChessState, player: number, raw: unknown): ChessState | null {
  if (s.result || player !== s.turn || !record(raw) || typeof raw.from !== 'string' || typeof raw.to !== 'string' ||
    (raw.promotion !== undefined && !['q', 'r', 'b', 'n'].includes(String(raw.promotion)))) return null;
  const c = position(s);
  try {
    const m = c.move({ from: raw.from, to: raw.to, promotion: raw.promotion as string | undefined });
    const move: ChessMove = { from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion } : {}) };
    return { moves: [...s.moves, move], turn: c.turn() === 'w' ? 0 : 1, ply: s.ply + 1, result: outcome(c) };
  } catch { return null; }
}
export function publicView(s: ChessState): ChessView {
  const c = position(s);
  return { turn: s.turn, ply: s.ply, result: s.result && { ...s.result }, fen: c.fen(), check: c.isCheck(), moves: structuredClone(s.moves),
    legal: s.result ? [] : c.moves({ verbose: true }).map(m => ({ from: m.from as Square, to: m.to, ...(m.promotion ? { promotion: m.promotion } : {}) })) };
}
export const privateView = (s: ChessState, _player: number) => publicView(s);
