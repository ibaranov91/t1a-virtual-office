import { body, fighter, move, overlaps, tile, SUB, PLAYER_H, type ArenaState, type Rect } from '../arena';
import type { GameDef } from '../types';
import { finishMatch, matchEvents, sides } from './match';
export const VOLLEY_CAP = 7200, VOLLEY_REGULATION = 5400;
export const VOLLEY_SERVE_HOLD = 60;
export const VOLLEY_NET = { x: 158 * SUB, y: 128 * SUB, w: 4 * SUB, h: 48 * SUB };
export interface VolleyState extends ArenaState { sides: number[]; points: number[]; ball: Rect & { vx: number; vy: number }; touches: number[]; lastSide: number; lastToucher: number; overlap: boolean[]; cooldown: number[]; serve: number; hold: number }
const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));
function serve(s: VolleyState, side: number) {
  // like Slime Volleyball: the ball hangs over the server's half for a second, then drops, so players can get under it
  s.ball = { x: (side ? 236 : 76) * SUB, y: 48 * SUB, w: 8 * SUB, h: 8 * SUB, vx: 0, vy: 0 };
  s.touches = [0, 0]; s.lastSide = side; s.lastToucher = -1; s.overlap.fill(false); s.cooldown.fill(0); s.serve = side; s.hold = VOLLEY_SERVE_HOLD;
}
const over = (s: VolleyState) => sides(s).length <= 1 || s.points.some(n => n >= 7) || s.frame >= VOLLEY_CAP || s.frame >= VOLLEY_REGULATION && s.points[0] !== s.points[1];
function point(s: VolleyState, winner: number) {
  s.points[winner]++;
  if (s.lastToucher >= 0 && s.sides[s.lastToucher] === winner) { const p = s.players[s.lastToucher]; p.stats.points = (p.stats.points ?? 0) + 1; }
  s.fx.push({ frame: s.frame, slot: s.lastToucher, kind: 'volleypoint' }); serve(s, 1 - winner);
}
export const volley: GameDef<VolleyState, { mode: string }> = {
  id: 'volley', name: 'Office Volley', goal: 'Keep the ball up. Three touches per side. First to seven.', controls: ['move', 'jump', 'action'], players: [2, 4], modes: { ffa: [2], teams: true },
  init(seed, roster) {
    const s: VolleyState = { frame: 0, fx: [], outcome: null, rng: seed, layout: seed % 3, roster: structuredClone(roster), eliminated: [],
      sides: Array.from({ length: 4 }, (_, slot) => roster.find(r => r.slot === slot)?.team ?? (roster.findIndex(r => r.slot === slot) === 0 ? 0 : 1)),
      players: Array.from({ length: 4 }, (_, slot) => fighter(slot, roster, 0, 0)), points: [0, 0], ball: { x: 0, y: 0, w: 128, h: 128, vx: 0, vy: 0 }, touches: [0, 0], lastSide: 0, lastToucher: -1, overlap: [false,false,false,false], cooldown: [0,0,0,0], serve: 0, hold: 0 };
    s.players.forEach((p, slot) => { const peers = roster.filter(r => s.sides[r.slot] === s.sides[slot]), index = peers.findIndex(r => r.slot === slot); p.x = ((s.sides[slot] ? 194 : 48) + index * 40) * SUB; p.y = 176 * SUB - PLAYER_H; });
    serve(s, seed % 2); return s;
  },
  step(s, events) {
    s.fx = []; matchEvents(s, events); if (s.outcome) { s.frame++; return; }
    for (const [slot, p] of s.players.entries()) {
      if (!p.present) continue;
      const walls = [tile(0, 11, 20), VOLLEY_NET, { x: s.sides[slot] ? -320 * SUB : 162 * SUB, y: 0, w: s.sides[slot] ? 478 * SUB : 320 * SUB, h: 192 * SUB }];
      move(p, walls, []);
      if (s.cooldown[slot]) s.cooldown[slot]--;
    }
    if (s.hold > 0) { // serve pause: players move, the ball waits
      s.hold--; s.frame++;
      if (over(s)) finishMatch(s, g => [s.points[s.sides[g[0]]]]);
      return;
    }
    const b = s.ball; b.vy = Math.min(128, b.vy + 4);
    const axis = (key: 'x' | 'y', amount: number) => {
      let remaining = amount;
      while (remaining) {
        const step = Math.sign(remaining) * Math.min(SUB, Math.abs(remaining)), next = { ...b, [key]: b[key] + step };
        if (next.x < 0 || next.x + b.w > 320 * SUB || next.y < 0 || overlaps(next, VOLLEY_NET)) { b[key === 'x' ? 'vx' : 'vy'] *= -1; return; }
        b[key] += step; remaining -= step;
      }
    };
    axis('x', b.vx); axis('y', b.vy);
    const side = b.x + Math.trunc(b.w / 2) < 160 * SUB ? 0 : 1;
    if (side !== s.lastSide) { s.touches = [0, 0]; s.lastSide = side; }
    const nowOverlap = s.players.map(p => p.present && overlaps(body(p), b));
    let fault = false;
    for (const [slot, touching] of nowOverlap.entries()) if (touching && !s.overlap[slot] && !s.cooldown[slot]) {
      const p = s.players[slot], ps = s.sides[slot]; s.cooldown[slot] = 6; s.touches[ps]++;
      if (s.touches[ps] > 3) { point(s, 1 - ps); fault = true; break; }
      s.lastToucher = slot;
      if (!p.grounded && (p.bits & 32)) { b.vy = 96; b.vx = ps ? -128 : 128; p.stats.spikes = (p.stats.spikes ?? 0) + 1; s.fx.push({ frame: s.frame, slot, kind: 'volleyspike' }); }
      else { b.vy = -112; b.vx = clamp(Math.trunc((b.x + 4 * SUB - p.x - 5 * SUB) * 6 / SUB), 112); s.fx.push({ frame: s.frame, slot, kind: 'volleyhit' }); }
    }
    if (!fault) { s.overlap = nowOverlap; if (b.y + b.h >= 176 * SUB) point(s, 1 - side); }
    s.frame++;
    if (over(s)) finishMatch(s, g => [s.points[s.sides[g[0]]]]);
  }, bits: (s, slot) => s.players[slot]?.bits ?? 0,
};
