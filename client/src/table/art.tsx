// Vector art for the game table: chess and checkers pieces, dominoes and Last Card cards.
// Chess pieces are the cburnett set by Colin M.L. Burnett (Wikimedia Commons, BSD licence), as on lichess.
import type { Card, Colour } from '../../../shared/table/lastcard';
import type { Domino } from '../../../shared/table/dominoes';

const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45">${body}</svg>`)}`;
const G = 'fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const W = '#fff', B = '#000';
const king = (f: string, l: string) => `<g ${G}><path d="M22.5 11.63V6M20 8h5" stroke-linejoin="miter"/><path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5" fill="${f}" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M12.5 37c5.5 3.5 14.5 3.5 20 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-2.5-7.5-12-10.5-16-4-3 6 6 10.5 6 10.5v7" fill="${f}"/>${f === B ? '<path d="M32 29.5s8.5-4 6.03-9.65C34.15 14 25 18 22.5 24.5v2.1-2.1C20 18 10.85 14 6.97 19.85 4.5 25.5 13 29.5 13 29.5" stroke="#fff"/>' : ''}<path d="M12.5 30c5.5-3 14.5-3 20 0m-20 3.5c5.5-3 14.5-3 20 0m-20 3.5c5.5-3 14.5-3 20 0" stroke="${l}"/></g>`;
const queen = (f: string) => `<g fill="${f}" stroke="#000" stroke-width="1.5" stroke-linejoin="round"><path d="M9 26c8.5-1.5 21-1.5 27 0l2.5-12.5L31 25l-.3-14.1-5.2 13.6-3-14.5-3 14.5-5.2-13.6L14 25 6.5 13.5 9 26z" stroke-linecap="butt"/><path d="M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1 2.5-1 2.5-1.5 1.5 0 2.5 0 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z"/>${f === W ? '<path d="M11.5 30c3.5-1 18.5-1 22 0M12 33.5c6-1 15-1 21 0" fill="none"/>' : ''}<circle cx="6" cy="12" r="2"/><circle cx="14" cy="9" r="2"/><circle cx="22.5" cy="8" r="2"/><circle cx="31" cy="9" r="2"/><circle cx="39" cy="12" r="2"/>${f === B ? '<path d="M11 38.5a35 35 1 0 0 23 0" fill="none" stroke="#000" stroke-linecap="butt"/><g fill="none" stroke="#fff"><path d="M11 29a35 35 1 0 1 23 0M12.5 31.5h20M11.5 34.5a35 35 1 0 0 22 0M10.5 37.5a35 35 1 0 0 24 0"/></g>' : ''}</g>`;
const rook = (f: string, l: string) => `<g fill="${f}" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 .3)"><path d="M9 39h27v-3H9v3zM12.5 32l1.5-2.5h17l1.5 2.5h-20zM12 36v-4h21v4H12z" stroke-linecap="butt"/><path d="M14 29.5v-13h17v13H14z" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M14 16.5L11 14h23l-3 2.5H14zM11 14V9h4v2h5V9h5v2h5V9h4v5H11z" stroke-linecap="butt"/>${f === B ? '<path d="M12 35.5h21M13 31.5h19M14 29.5h17M14 16.5h17M11 14h23" fill="none" stroke="#fff" stroke-width="1" stroke-linejoin="miter"/>' : `<path d="M11 14h23" fill="none" stroke="${l}" stroke-linejoin="miter"/>`}</g>`;
const bishop = (f: string, l: string) => `<g fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 .6)"><g fill="${f}" stroke-linecap="butt"><path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.35.49-2.32.47-3-.5 1.35-1.46 3-2 3-2z"/><path d="M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z"/><path d="M25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z"/></g><path d="M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5" stroke="${l}" stroke-linejoin="miter"/></g>`;
const knight = (f: string, l: string) => `<g fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 .3)"><path d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21" fill="${f}"/><path d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.042-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4.003 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.994-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-1.992 2.5-3c1 0 1 3 1 3" fill="${f}"/><path d="M9.5 25.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0zm5.433-9.75a.5 1.5 30 1 1-.866-.5.5 1.5 30 1 1 .866.5z" fill="${l}" stroke="${l}"/>${f === B ? '<path d="M24.55 10.4l-.45 1.45.5.15c3.15 1 5.65 2.49 7.9 6.75S35.75 29.06 35.25 39l-.05.5h2.25l.05-.5c.5-10.06-.88-16.85-3.25-21.34-2.37-4.49-5.79-6.64-9.19-7.16l-.51-.1z" fill="#fff" stroke="none"/>' : ''}</g>`;
const pawn = (f: string) => `<path d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03C15.41 27.09 11 31.58 11 39.5h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z" fill="${f}" stroke="#000" stroke-width="1.5" stroke-linecap="round"/>`;
const draw: Record<string, (f: string, l: string) => string> = { k: king, q: queen, r: rook, b: bishop, n: knight, p: pawn };
// Checkers: a disc with a rim; a king carries an amber crown.
const disc = (face: string, rim: string, ring: string, crowned: boolean) => `<ellipse cx="22.5" cy="25.5" rx="17" ry="16" fill="${rim}" stroke="#1a1214" stroke-width="1.5"/><circle cx="22.5" cy="22" r="17" fill="${face}" stroke="#1a1214" stroke-width="1.5"/><circle cx="22.5" cy="22" r="11.5" fill="none" stroke="${ring}" stroke-width="1.5"/>${crowned ? '<path d="M14.5 27.5l-1.5-9 5 3.5 4.5-7 4.5 7 5-3.5-1.5 9z" fill="#f2b45a" stroke="#1a1214" stroke-width="1.4" stroke-linejoin="round"/>' : ''}`;

export const PIECES: Record<string, string> = {};
for (const t of Object.keys(draw)) { PIECES[`w${t}`] = svg(draw[t](W, B)); PIECES[`b${t}`] = svg(draw[t](B, W)); }
PIECES.wman = svg(disc('#f4ead8', '#c7b493', '#cdbb9b', false)); PIECES.wking = svg(disc('#f4ead8', '#c7b493', '#cdbb9b', true));
PIECES.bman = svg(disc('#3b2e33', '#191214', '#5a4850', false)); PIECES.bking = svg(disc('#3b2e33', '#191214', '#5a4850', true));
export const PIECE_NAMES: Record<string, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn', man: 'piece', king: 'king' };

const SPOTS: number[][][] = [[], [[0, 0]], [[-1, -1], [1, 1]], [[-1, -1], [0, 0], [1, 1]], [[-1, -1], [1, 1], [-1, 1], [1, -1]],
  [[-1, -1], [1, 1], [-1, 1], [1, -1], [0, 0]], [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]]];
/** A domino, horizontal (a on the left) or upright (a on top). `back` draws it face down. */
export function DominoTile({ tile, upright = false, back = false }: { tile?: Domino; upright?: boolean; back?: boolean }) {
  const half = (n: number, i: number) => SPOTS[n].map(([u, v], k) => {
    const x = upright ? 25 + v * 12 : 25 + i * 50 + u * 12, y = upright ? 25 + i * 50 + u * 12 : 25 + v * 12;
    return <circle key={`${i}${k}`} cx={x} cy={y} r="4.6" />;
  });
  return <svg className="gt-domino" viewBox={upright ? '0 0 50 100' : '0 0 100 50'} aria-hidden="true">
    <rect x="1.5" y="1.5" width={upright ? 47 : 97} height={upright ? 97 : 47} rx="7" className={back ? 'back' : 'face'} />
    {!back && tile && <><path d={upright ? 'M8 50h34' : 'M50 8v34'} className="split" /><g className="pips">{half(tile.a, 0)}{half(tile.b, 1)}</g></>}
    {back && <path d={upright ? 'M14 30h22M14 50h22M14 70h22' : 'M30 14v22M50 14v22M70 14v22'} className="weave" />}
  </svg>;
}

export const CARD_COLOURS: Record<Colour, string> = { red: '#cf4150', yellow: '#e9b23a', green: '#2f9461', blue: '#3c6fca' };
const WILD = ['red', 'blue', 'yellow', 'green'] as const;
function Mark({ c, x, y, s, fill }: { c: Card; x: number; y: number; s: number; fill: string }) {
  const at = `translate(${x} ${y}) scale(${s})`;
  if (c.symbol === 'skip') return <g transform={at} fill="none" stroke={fill} strokeWidth="4"><circle r="10" /><path d="M-7 7 7-7" /></g>;
  if (c.symbol === 'reverse') return <g transform={at} fill="none" stroke={fill} strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round"><path d="M-10-4H8l-5-5M10 4H-8l5 5" /></g>;
  if (c.symbol === 'wild') return <g transform={at}>{WILD.map((w, i) => <path key={w} d={['M0 0V-11A11 11 0 0 1 11 0Z', 'M0 0H11A11 11 0 0 1 0 11Z', 'M0 0V11A11 11 0 0 1-11 0Z', 'M0 0H-11A11 11 0 0 1 0-11Z'][i]} fill={CARD_COLOURS[w]} />)}</g>;
  const text = c.symbol === 'two' ? '+2' : c.symbol === 'four' ? '+4' : c.symbol;
  return <text transform={at} textAnchor="middle" dominantBaseline="central" fill={fill} stroke="#1e1418" strokeWidth={s < 1 ? 0 : 1.2} paintOrder="stroke"
    fontSize={text.length > 1 ? 24 : 30} fontWeight="900">{text}</text>;
}
/** A Last Card card face, 60×84 units. Colourless cards are wild. */
export function PlayingCard({ card }: { card: Card }) {
  const colour = card.colour ? CARD_COLOURS[card.colour] : '#2b2228', ink = card.colour ?? 'wild';
  return <svg className="gt-card" viewBox="0 0 60 84" aria-hidden="true" data-colour={ink}>
    <rect x=".75" y=".75" width="58.5" height="82.5" rx="6.5" fill="#f6ecd9" stroke="#1e1418" strokeWidth="1.5" />
    <rect x="4" y="4" width="52" height="76" rx="4" fill={colour} />
    <ellipse cx="30" cy="42" rx="20" ry="31" transform="rotate(28 30 42)" fill={card.colour ? '#fbf3e4' : '#1e1418'} />
    {!card.colour && card.symbol === 'four' && <Mark c={{ ...card, symbol: 'wild' }} x={30} y={42} s={1.5} fill="" />}
    <Mark c={card} x={30} y={42} s={card.colour ? 1 : card.symbol === 'four' ? 0.95 : 1.55} fill={card.colour ? colour : '#fbf3e4'} />
    <Mark c={card} x={11.5} y={13} s={0.42} fill="#fbf3e4" />
    <Mark c={card} x={48.5} y={71} s={0.42} fill="#fbf3e4" />
  </svg>;
}
export function CardBack() {
  return <svg className="gt-card" viewBox="0 0 60 84" aria-hidden="true">
    <rect x=".75" y=".75" width="58.5" height="82.5" rx="6.5" fill="#f6ecd9" stroke="#1e1418" strokeWidth="1.5" />
    <rect x="4" y="4" width="52" height="76" rx="4" fill="#3a2b31" />
    <ellipse cx="30" cy="42" rx="17" ry="28" transform="rotate(28 30 42)" fill="#f2b45a" />
    <text x="30" y="42" transform="rotate(-28 30 42)" textAnchor="middle" dominantBaseline="central" fill="#2a1a10" fontSize="10" fontWeight="900" letterSpacing=".5">DECK</text>
  </svg>;
}
