import { record, type RulesState } from './types';
// a8=0, h1=63. Positive pieces are white; magnitude 2 is a flying king.
export interface DraughtsMove { from: number; path: number[] }
/** A move as played, for the move list and the last-move highlight. */
export interface DraughtsPlayed extends DraughtsMove { capture: boolean }
export interface DraughtsState extends RulesState { board: number[]; positions: string[]; quietKings: number; moves: DraughtsPlayed[] }
export interface DraughtsView extends RulesState { board: number[]; legal: DraughtsMove[]; quietKings: number; moves: DraughtsPlayed[] }
const dirs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
const square = (x: number, y: number) => x >= 0 && x < 8 && y >= 0 && y < 8 ? y * 8 + x : -1;
const key = (s: Pick<DraughtsState, 'board' | 'turn'>) => `${s.turn}:${s.board.join(',')}`;
const crown = (p: number, at: number) => Math.abs(p) === 1 && (p > 0 ? at < 8 : at >= 56) ? p * 2 : p;
interface Capture extends DraughtsMove { taken: number[]; piece: number }
function captures(board: number[], from: number, at = from, piece = board[from], taken: number[] = [], path: number[] = []): Capture[] {
  const out: Capture[] = [], king = Math.abs(piece) === 2;
  for (const [dx, dy] of dirs) {
    let x = at % 8 + dx, y = (at / 8 | 0) + dy, victim = -1;
    while (square(x, y) >= 0) {
      const q = square(x, y), p = q === from ? 0 : board[q];
      if (p) {
        if (victim >= 0 || Math.sign(p) === Math.sign(piece) || taken.includes(q)) break;
        victim = q;
      } else if (victim >= 0) {
        const nextPiece = crown(piece, q), nextTaken = [...taken, victim], nextPath = [...path, q];
        const more = captures(board, from, q, nextPiece, nextTaken, nextPath);
        out.push(...(more.length ? more : [{ from, path: nextPath, taken: nextTaken, piece: nextPiece }]));
        if (!king) break;
      } else if (!king) break;
      x += dx; y += dy;
    }
  }
  return out;
}
function choices(s: DraughtsState): Capture[] {
  const own = s.turn === 0 ? 1 : -1, hits: Capture[] = [], steps: Capture[] = [];
  for (let from = 0; from < 64; from++) {
    const p = s.board[from]; if (Math.sign(p) !== own) continue;
    hits.push(...captures(s.board, from));
    for (const [dx, dy] of dirs) {
      if (Math.abs(p) === 1 && dy !== -own) continue;
      let x = from % 8 + dx, y = (from / 8 | 0) + dy;
      while (square(x, y) >= 0 && !s.board[square(x, y)]) {
        const q = square(x, y); steps.push({ from, path: [q], taken: [], piece: crown(p, q) });
        if (Math.abs(p) === 1) break;
        x += dx; y += dy;
      }
    }
  }
  return hits.length ? hits : steps;
}
export const legalMoves = (s: DraughtsState): DraughtsMove[] => s.result ? [] : choices(s).map(({ from, path }) => ({ from, path }));
export function init(_seed = 0): DraughtsState {
  const board = Array.from({ length: 64 }, (_, i) => ((i % 8 + (i / 8 | 0)) % 2 === 1 ? i < 24 ? -1 : i >= 40 ? 1 : 0 : 0));
  const s: DraughtsState = { board, turn: 0, ply: 0, positions: [], quietKings: 0, moves: [], result: null }; s.positions.push(key(s)); return s;
}
export function apply(s: DraughtsState, player: number, raw: unknown): DraughtsState | null {
  if (s.result || player !== s.turn || !record(raw) || !Number.isInteger(raw.from) || !Array.isArray(raw.path) || raw.path.length > 24 || !raw.path.every(Number.isInteger)) return null;
  const m = choices(s).find(m => m.from === raw.from && JSON.stringify(m.path) === JSON.stringify(raw.path)); if (!m) return null;
  const n = structuredClone(s), before = n.board[m.from]; n.board[m.from] = 0;
  for (const q of m.taken) n.board[q] = 0;
  n.board[m.path.at(-1)!] = m.piece; n.turn = 1 - n.turn; n.ply++;
  n.moves.push({ from: m.from, path: [...m.path], capture: m.taken.length > 0 });
  n.quietKings = Math.abs(before) === 2 && !m.taken.length ? n.quietKings + 1 : 0;
  n.positions.push(key(n));
  if (!choices(n).length) n.result = { winner: player, reason: 'No legal move' };
  else if (n.positions.filter(p => p === key(n)).length >= 3) n.result = { winner: null, reason: 'Threefold repetition' };
  else if (n.quietKings >= 30) n.result = { winner: null, reason: '15 king moves each' };
  return n;
}
export const publicView = (s: DraughtsState): DraughtsView => ({ board: [...s.board], turn: s.turn, ply: s.ply, result: s.result && { ...s.result }, quietKings: s.quietKings, moves: structuredClone(s.moves), legal: legalMoves(s) });
export const privateView = (s: DraughtsState, _player: number) => publicView(s);
