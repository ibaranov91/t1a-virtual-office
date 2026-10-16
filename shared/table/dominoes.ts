import { shuffle } from '../arcade/rng';
import { nextActive, record, type RulesState } from './types';
export interface Domino { id: number; a: number; b: number }
export interface DominoMove { kind: 'play'; tile: number; end: 'left' | 'right' }
export interface DominoesState extends RulesState {
  hands: Domino[][]; boneyard: Domino[]; chain: Domino[]; active: boolean[]; passes: number; first: number;
}
export interface DominoesView extends RulesState { chain: Domino[]; counts: number[]; boneyard: number; active: boolean[]; hand?: Domino[]; legal?: DominoMove[] }
export function tiles(): Domino[] {
  const out: Domino[] = []; for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) out.push({ id: out.length, a, b }); return out;
}
export function init(seed: number, players: number): DominoesState {
  if (players < 2 || players > 4) throw new Error('Dominoes needs 2–4 players');
  const deck = shuffle({ rng: seed }, tiles()), hands = Array.from({ length: players }, () => deck.splice(0, 7));
  const dealt = hands.flat(), doubles = dealt.filter(t => t.a === t.b);
  const first = [...(doubles.length ? doubles : dealt)].sort((a, b) => b.a + b.b - a.a - a.b || b.b - a.b || b.a - a.a)[0].id;
  return { hands, boneyard: deck, chain: [], active: hands.map(() => true), passes: 0, first, turn: hands.findIndex(h => h.some(t => t.id === first)), ply: 0, result: null };
}
export function legalMoves(s: DominoesState, player = s.turn): DominoMove[] {
  if (s.result || player !== s.turn || !s.active[player]) return [];
  const first = s.chain[0], last = s.chain.at(-1), out: DominoMove[] = [];
  for (const t of s.hands[player]) {
    if (!first) { if (t.id === s.first) out.push({ kind: 'play', tile: t.id, end: 'right' }); continue; }
    if (t.a === first.a || t.b === first.a) out.push({ kind: 'play', tile: t.id, end: 'left' });
    if (t.a === last!.b || t.b === last!.b) out.push({ kind: 'play', tile: t.id, end: 'right' });
  }
  return out;
}
export function apply(s: DominoesState, player: number, raw: unknown): DominoesState | null {
  if (s.result || s.turn !== player || !s.active[player] || !record(raw)) return null;
  const moves = legalMoves(s), n = structuredClone(s);
  if (raw.kind === 'draw') {
    if (moves.length || !n.boneyard.length) return null;
    n.hands[player].push(n.boneyard.shift()!); return n;
  }
  if (raw.kind === 'pass') {
    if (moves.length || n.boneyard.length) return null;
    n.passes++; n.turn = nextActive(n.active, player); n.ply++;
    if (n.passes >= n.active.filter(Boolean).length) {
      const pips = n.hands.map((h, i) => n.active[i] ? h.reduce((v, t) => v + t.a + t.b, 0) : Infinity);
      const best = Math.min(...pips), winners = pips.flatMap((v, i) => v === best ? [i] : []);
      n.result = { winner: winners.length === 1 ? winners[0] : null, reason: 'Blocked game' };
    }
    return n;
  }
  const m = moves.find(m => m.tile === raw.tile && m.end === raw.end); if (raw.kind !== 'play' || !m) return null;
  const i = n.hands[player].findIndex(t => t.id === m.tile), tile = n.hands[player].splice(i, 1)[0];
  const flip = () => { [tile.a, tile.b] = [tile.b, tile.a]; };
  if (m.end === 'left') { if (tile.b !== n.chain[0].a) flip(); n.chain.unshift(tile); }
  else { if (n.chain.length && tile.a !== n.chain.at(-1)!.b) flip(); n.chain.push(tile); }
  n.passes = 0; n.turn = nextActive(n.active, player); n.ply++;
  if (!n.hands[player].length) n.result = { winner: player, reason: 'Empty hand' };
  return n;
}
export function leave(s: DominoesState, player: number): DominoesState {
  const n = structuredClone(s); if (!n.active[player] || n.result) return n;
  n.active[player] = false; n.passes = 0;
  const alive = n.active.flatMap((a, i) => a ? [i] : []);
  if (alive.length === 1) n.result = { winner: alive[0], reason: 'Last player' };
  if (n.turn === player) { n.turn = nextActive(n.active, player); n.ply++; }
  // The opening tile can leave before it is played. Select the best remaining dealt tile again.
  if (!n.chain.length) {
    const dealt = n.hands.flatMap((h, i) => n.active[i] ? h : []), doubles = dealt.filter(t => t.a === t.b);
    n.first = [...(doubles.length ? doubles : dealt)].sort((a, b) => b.a + b.b - a.a - a.b || b.b - a.b)[0]?.id ?? n.first;
    n.turn = n.hands.findIndex((h, i) => n.active[i] && h.some(t => t.id === n.first));
  }
  return n;
}
export const publicView = (s: DominoesState): DominoesView => ({ turn: s.turn, ply: s.ply, result: s.result && { ...s.result }, chain: structuredClone(s.chain), counts: s.hands.map(h => h.length), boneyard: s.boneyard.length, active: [...s.active] });
export function privateView(s: DominoesState, player: number): DominoesView {
  return { ...publicView(s), ...(s.active[player] ? { hand: structuredClone(s.hands[player]), legal: legalMoves(s, player) } : {}) };
}
