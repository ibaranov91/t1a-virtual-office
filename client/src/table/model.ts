// Pure helpers for the game table screen, kept apart so tests can check them (table.test.ts).
import { Chess } from 'chess.js';
import type { Card } from '../../../shared/table/lastcard';
import type { DraughtsPlayed } from '../../../shared/table/draughts';

/** Board squares count a8 = 0 … h1 = 63 on both games. */
export const squareName = (q: number) => `${'abcdefgh'[q % 8]}${8 - (q / 8 | 0)}`;
export const squareIndex = (q: string) => (8 - Number(q[1])) * 8 + 'abcdefgh'.indexOf(q[0]);
/** The square drawn at display cell `cell` (0 = top left). Black sees the board turned around. */
export const cellSquare = (cell: number, flipped: boolean) => flipped ? 63 - cell : cell;

export const cardLabel = (c: Card) => `${c.colour ?? 'Wild'} ${c.symbol === 'two' ? 'draw two' : c.symbol === 'four' ? 'draw four' : c.symbol}`;

/** Turn clock text: 1:42, 0:07. */
export function clock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${s / 60 | 0}:${String(s % 60).padStart(2, '0')}`;
}

/** Chess moves in SAN, replayed from the start position. */
export function sanMoves(moves: { from: string; to: string; promotion?: string }[]): string[] {
  const c = new Chess(), out: string[] = [];
  for (const m of moves) { try { out.push(c.move(m).san); } catch { break; } }
  return out;
}

/** Draughts moves in the usual notation: c3-d4 for a step, c3:e5:g3 for a capture. */
export const draughtsMoves = (moves: DraughtsPlayed[]) => moves.map(m => [m.from, ...m.path].map(squareName).join(m.capture ? ':' : '-'));

/** Pairs half-moves into numbered rows: [[1, 'e4', 'e5'], [2, 'Nf3']]. */
export function moveRows(moves: string[]): [number, string, string?][] {
  const rows: [number, string, string?][] = [];
  for (let i = 0; i < moves.length; i += 2) rows.push([i / 2 + 1, moves[i], moves[i + 1]]);
  return rows;
}

const START: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 }, VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
/** What each side has taken, by piece type, and white's material lead (negative when black leads). */
export function material(fen: string) {
  const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 } as Record<string, number>, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } as Record<string, number> };
  for (const ch of fen.split(' ')[0]) { const t = ch.toLowerCase(); if (t in START) count[ch === t ? 'b' : 'w'][t]++; }
  const taken = (side: 'w' | 'b') => Object.keys(START).flatMap(t => Array<string>(Math.max(0, START[t] - count[side][t])).fill(t));
  const score = (side: 'w' | 'b') => Object.keys(START).reduce((v, t) => v + count[side][t] * VALUE[t], 0);
  // White's row of trophies is black's missing pieces, and the other way round.
  return { byWhite: taken('b'), byBlack: taken('w'), lead: score('w') - score('b') };
}

/** For draughts: how many of the other side's 12 pieces each side has taken. */
export function draughtsTaken(board: number[]) {
  const white = board.filter(p => p > 0).length, black = board.filter(p => p < 0).length;
  return { byWhite: 12 - black, byBlack: 12 - white };
}

/** How many cards overlap so a hand of `n` fits in `width`: the step between card left edges. */
export function fanStep(n: number, card: number, width: number, gap = 8) {
  if (n <= 1) return card + gap;
  return Math.max(card * 0.28, Math.min(card + gap, (width - card) / (n - 1)));
}
