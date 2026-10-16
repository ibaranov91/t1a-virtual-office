import { Chess } from 'chess.js';
import type { Assets } from '../assets';
import { drawText, textWidth } from '../font';
import type { GameView } from '../../../shared/table/types';
import type { Domino } from '../../../shared/table/dominoes';
import type { Card, Colour } from '../../../shared/table/lastcard';
export const INK = '#2b2534', PAPER = '#fff0d3';
export const CARD_COLOURS: Record<Colour, string> = { red: '#a93645', yellow: '#e8b953', green: '#286954', blue: '#305797' };
export const cardLabel = (c: Card) => `${c.colour ?? 'Wild'} ${c.symbol === 'two' ? '+2' : c.symbol === 'four' ? '+4' : c.symbol}`;
export const squareName = (q: number) => `${'abcdefgh'[q % 8]}${8 - (q / 8 | 0)}`;
export const squareIndex = (q: string) => (8 - Number(q[1])) * 8 + 'abcdefgh'.indexOf(q[0]);
const text = (c: CanvasRenderingContext2D, s: string, x: number, y: number, colour = PAPER) => drawText(c, s, x - textWidth(s) / 2, y, colour);
export function board(ctx: CanvasRenderingContext2D, assets: Assets, v: GameView, selected: number | null, targets: number[], path: number[]) {
  ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, 256, 256);
  const chess = v.game === 'chess' ? new Chess(v.state.fen).board().flat() : null;
  for (let q = 0; q < 64; q++) {
    const x = q % 8 * 32, y = (q / 8 | 0) * 32;
    ctx.fillStyle = (q % 8 + (q / 8 | 0)) % 2 ? '#56766a' : '#e6d6af'; ctx.fillRect(x, y, 32, 32);
    if (selected === q || path.includes(q)) { ctx.fillStyle = '#d49d49'; ctx.fillRect(x + 1, y + 1, 30, 30); }
    if (targets.includes(q)) { ctx.fillStyle = '#f7d27b'; ctx.fillRect(x + 12, y + 12, 8, 8); }
    const p = chess?.[q], d = v.game === 'draughts' ? v.state.board[q] : 0;
    const name = p ? `chess_${p.color}_${p.type}` : d ? `checkers_${d > 0 ? 'w' : 'b'}_${Math.abs(d) === 2 ? 'king' : 'man'}` : '';
    const f = assets.atlas.frames[name];
    if (f) ctx.drawImage(assets.world, f.x, f.y, f.w, f.h, x + 4, y + 2, 24, 24);
    if (q >= 56) drawText(ctx, 'abcdefgh'[q % 8], x + 2, y + 25, INK);
    if (q % 8 === 7) drawText(ctx, String(8 - (q / 8 | 0)), x + 26, y + 2, INK);
  }
}
export function domino(ctx: CanvasRenderingContext2D, tile: Domino, x = 0, y = 0, vertical = false) {
  ctx.save(); ctx.translate(x, y); if (vertical) { ctx.translate(24, 0); ctx.rotate(Math.PI / 2); }
  ctx.fillStyle = INK; ctx.fillRect(0, 0, 44, 24); ctx.fillStyle = PAPER; ctx.fillRect(1, 1, 42, 22);
  ctx.fillStyle = '#9c856e'; ctx.fillRect(21, 2, 1, 20);
  for (const [i, n] of [tile.a, tile.b].entries()) {
    const spots = n === 0 ? [] : n === 1 ? [[0, 0]] : n === 2 ? [[-1,-1],[1,1]] : n === 3 ? [[-1,-1],[0,0],[1,1]] : n === 4 ? [[-1,-1],[1,1],[-1,1],[1,-1]] : n === 5 ? [[-1,-1],[1,1],[-1,1],[1,-1],[0,0]] : [[-1,-1],[-1,0],[-1,1],[1,-1],[1,0],[1,1]];
    ctx.fillStyle = INK; for (const [dx, dy] of spots) ctx.fillRect(9 + i * 22 + dx * 5, 10 + dy * 6, 3, 3);
  }
  ctx.restore();
}
export function card(ctx: CanvasRenderingContext2D, c: Card) {
  ctx.fillStyle = INK; ctx.fillRect(0, 0, 48, 68); ctx.fillStyle = PAPER; ctx.fillRect(1, 1, 46, 66);
  ctx.fillStyle = c.colour ? CARD_COLOURS[c.colour] : '#514269'; ctx.fillRect(3, 3, 42, 62);
  if (!c.colour) ['red','yellow','green','blue'].forEach((colour, i) => { ctx.fillStyle = CARD_COLOURS[colour as Colour]; ctx.fillRect(6 + i * 9, 46, 9, 9); });
  const label = c.symbol === 'two' ? '+2' : c.symbol === 'four' ? '+4' : c.symbol === 'reverse' ? 'REV' : c.symbol === 'skip' ? 'SKIP' : c.symbol === 'wild' ? 'WILD' : c.symbol;
  text(ctx, label, 24, 29, c.colour === 'yellow' ? INK : PAPER);
  text(ctx, c.colour?.slice(0, 1).toUpperCase() ?? '*', 11, 9, c.colour === 'yellow' ? INK : PAPER);
}
