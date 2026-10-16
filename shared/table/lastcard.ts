import { shuffle } from '../arcade/rng';
import { nextActive, record, type RulesState } from './types';
export const COLOURS = ['red', 'yellow', 'green', 'blue'] as const;
export type Colour = typeof COLOURS[number];
export type Symbol = `${number}` | 'skip' | 'reverse' | 'two' | 'wild' | 'four';
export interface Card { id: number; colour: Colour | null; symbol: Symbol }
export interface LastCardState extends RulesState {
  rng: number; hands: Card[][]; pile: Card[]; discards: Card[]; colour: Colour; direction: number;
  active: boolean[]; drawn: number | null; catchable: number | null;
}
export interface LastCardView extends RulesState {
  top: Card; colour: Colour; direction: number; counts: number[]; pile: number; active: boolean[];
  catchable: number | null; hand?: Card[]; playable?: number[]; drawn?: number | null;
}
export function cards(): Card[] {
  const out: Card[] = [], add = (colour: Colour | null, symbol: Symbol) => out.push({ id: out.length, colour, symbol });
  for (const c of COLOURS) {
    add(c, '0');
    for (const symbol of ['1','2','3','4','5','6','7','8','9','skip','reverse','two'] as Symbol[]) { add(c, symbol); add(c, symbol); }
  }
  for (let i = 0; i < 4; i++) { add(null, 'wild'); add(null, 'four'); }
  return out;
}
export function init(seed: number, players: number): LastCardState {
  if (players < 2 || players > 4) throw new Error('Last Card needs 2–4 players');
  const rng = { rng: seed }, pile = shuffle(rng, cards()), hands = Array.from({ length: players }, () => pile.splice(0, 7)), discards: Card[] = [];
  do { discards.push(pile.shift()!); } while (!/^\d$/.test(discards.at(-1)!.symbol));
  return { ...rng, hands, pile, discards, colour: discards.at(-1)!.colour!, direction: 1, active: hands.map(() => true), drawn: null, catchable: null, turn: 0, ply: 0, result: null };
}
export const playable = (s: LastCardState, card: Card) => !card.colour || card.colour === s.colour || card.symbol === s.discards.at(-1)!.symbol;
function draw(s: LastCardState, player: number, count: number): Card[] {
  const got: Card[] = [];
  for (let i = 0; i < count; i++) {
    if (!s.pile.length && s.discards.length > 1) { const top = s.discards.pop()!; s.pile = shuffle(s, s.discards); s.discards = [top]; }
    const c = s.pile.shift(); if (!c) break;
    s.hands[player].push(c); got.push(c);
  }
  return got;
}
function advance(s: LastCardState, count = 1) {
  for (let i = 0; i < count; i++) s.turn = nextActive(s.active, s.turn, s.direction);
  s.drawn = null; s.ply++;
}
export function apply(s: LastCardState, player: number, raw: unknown): LastCardState | null {
  if (s.result || !s.active[player] || !record(raw)) return null;
  const n = structuredClone(s); n.catchable = null;
  if (raw.kind === 'catch') {
    if (s.catchable === null || s.catchable === player || !s.active[s.catchable]) return null;
    draw(n, s.catchable, 2); return n;
  }
  if (s.turn !== player) return null;
  if (raw.kind === 'draw') {
    if (s.drawn !== null) return null;
    const [c] = draw(n, player, 1);
    if (c && playable(n, c)) n.drawn = c.id; else advance(n);
    return n;
  }
  if (raw.kind === 'pass') { if (s.drawn === null) return null; advance(n); return n; }
  if (raw.kind !== 'play' || !Number.isInteger(raw.card)) return null;
  const i = n.hands[player].findIndex(c => c.id === raw.card), c = n.hands[player][i];
  if (!c || !playable(n, c) || (s.drawn !== null && c.id !== s.drawn) || (!c.colour && !COLOURS.includes(raw.colour as Colour))) return null;
  n.hands[player].splice(i, 1); n.discards.push(c); n.colour = c.colour ?? raw.colour as Colour;
  if (!n.hands[player].length) { n.result = { winner: player, reason: 'Empty hand' }; n.ply++; n.drawn = null; return n; }
  if (n.hands[player].length === 1 && raw.lastCard !== true) n.catchable = player;
  let skip = c.symbol === 'skip' ? 2 : 1;
  if (c.symbol === 'reverse') { n.direction *= -1; if (n.active.filter(Boolean).length === 2) skip = 2; }
  if (c.symbol === 'two' || c.symbol === 'four') { draw(n, nextActive(n.active, player, n.direction), c.symbol === 'two' ? 2 : 4); skip = 2; }
  advance(n, skip); return n;
}
export function timeout(s: LastCardState): LastCardState {
  const n = structuredClone(s); n.catchable = null;
  if (n.drawn === null) draw(n, n.turn, 1);
  advance(n); return n;
}
export function leave(s: LastCardState, player: number): LastCardState {
  const n = structuredClone(s); if (!n.active[player] || n.result) return n;
  n.active[player] = false; n.catchable = null;
  const alive = n.active.flatMap((a, i) => a ? [i] : []);
  if (alive.length === 1) n.result = { winner: alive[0], reason: 'Last player' };
  if (n.turn === player) advance(n);
  return n;
}
export const publicView = (s: LastCardState): LastCardView => ({ turn: s.turn, ply: s.ply, result: s.result && { ...s.result }, top: { ...s.discards.at(-1)! }, colour: s.colour, direction: s.direction, counts: s.hands.map(h => h.length), pile: s.pile.length, active: [...s.active], catchable: s.catchable });
export function privateView(s: LastCardState, player: number): LastCardView {
  return { ...publicView(s), ...(s.active[player] ? { hand: structuredClone(s.hands[player]), drawn: player === s.turn ? s.drawn : null,
    playable: player === s.turn && !s.result ? s.hands[player].filter(c => playable(s, c) && (s.drawn === null || c.id === s.drawn)).map(c => c.id) : [] } : {}) };
}
