import { body, fighter, move, overlaps, TILE, SUB, PLAYER_H, PLAYER_W, type ArenaState, type Rect } from '../arena';
import { random } from '../rng';
import type { GameDef } from '../types';
import { finishMatch, heatPoint, matchEvents, sides } from './match';
export const SCREENRUN_CAP = 9000, SCREENRUN_HEAT_CAP = 3600;
/** Surface row per column; -1 is a gap. All twelve join at row 10 on solid ground. */
export const SCREENRUN_CHUNKS: number[][] = [
  [10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10],
  [10,10,10,10,10,10,-1,-1,10,10,10,10,10,10,10,10,10,10,10,10],
  [10,10,10,10,10,10,9,9,9,9,10,10,10,10,10,10,10,10,10,10],
  [10,10,10,10,10,10,8,8,8,8,10,10,10,10,10,10,10,10,10,10],
  [10,10,10,10,-1,-1,10,10,10,10,10,10,10,-1,10,10,10,10,10,10],
  [10,10,10,10,9,9,9,10,10,10,10,10,10,8,8,8,10,10,10,10],
  [10,10,10,10,10,-1,-1,-1,10,10,10,10,10,10,10,10,10,10,10,10],
  [10,10,10,10,10,9,9,9,9,9,9,9,10,10,10,10,10,10,10,10],
  [10,10,10,10,10,8,8,8,10,10,10,10,10,10,-1,10,10,10,10,10],
  [10,10,10,10,-1,10,10,10,10,10,10,10,-1,-1,10,10,10,10,10,10],
  [10,10,10,10,10,10,10,8,8,8,8,8,8,10,10,10,10,10,10,10],
  [10,10,10,10,9,9,10,10,10,10,10,10,9,9,9,9,10,10,10,10],
];
export interface ScreenRunState extends ArenaState { heatFrame: number; nextHeat: boolean; points: number[]; course: number[]; chunks: number[]; camX: number; dash: number[]; cooldown: number[]; push: number[]; hit: number[][] }
export function courseSolids(course: number[], from: number, to: number): Rect[] {
  const out: Rect[] = [];
  for (let col = Math.max(0, from); col <= Math.min(course.length - 1, to); col++) if (course[col] >= 0) out.push({ x: col * TILE, y: course[col] * TILE, w: TILE, h: (12 - course[col]) * TILE });
  return out;
}
function resetHeat(s: ScreenRunState) {
  s.course = [...SCREENRUN_CHUNKS[0]]; s.chunks = [0]; s.heatFrame = 0; s.camX = 0; s.nextHeat = false;
  s.dash.fill(0); s.cooldown.fill(0); s.push.fill(0); s.hit = [[], [], [], []];
  s.players.forEach((p, slot) => Object.assign(p, fighter(slot, s.roster, (32 + slot * 14) * SUB, 10 * TILE - PLAYER_H), { present: p.present, alive: p.present, stats: p.stats, bits: p.bits, prevBits: p.bits }));
  // Consume a fresh course seed even when the first chunk is the safe starting grid.
  random(s);
}
export const screenrun: GameDef<ScreenRunState, { mode: string }> = {
  id: 'screenrun', name: 'Screen Run', goal: 'Stay on screen. Jump gaps and dash past rivals. Win three heats.', controls: ['move', 'jump', 'action'], players: [2, 4], modes: { ffa: [2, 3, 4], teams: true },
  init(seed, roster) {
    const s: ScreenRunState = { frame: 0, fx: [], outcome: null, rng: seed, layout: seed % 3, roster: structuredClone(roster), eliminated: [], players: Array.from({ length: 4 }, (_, slot) => fighter(slot, roster, 0, 0)),
      heatFrame: 0, nextHeat: false, points: [0, 0, 0, 0], course: [], chunks: [], camX: 0, dash: [0,0,0,0], cooldown: [0,0,0,0], push: [0,0,0,0], hit: [[],[],[],[]] };
    resetHeat(s); return s;
  },
  step(s, events) {
    s.fx = []; if (!s.outcome && s.nextHeat) resetHeat(s); matchEvents(s, events); if (s.outcome) { s.frame++; return; }
    const leader = Math.max(0, ...s.players.filter(p => p.present && p.alive).map(p => p.x));
    while (s.course.length * TILE < leader + 640 * SUB) { const id = random(s) % 12; s.chunks.push(id); s.course.push(...SCREENRUN_CHUNKS[id]); }
    for (const [slot, p] of s.players.entries()) {
      if (!p.present || !p.alive) continue;
      if (s.cooldown[slot]) s.cooldown[slot]--;
      if ((p.bits & 32) && !(p.prevBits & 32) && !s.cooldown[slot]) { s.dash[slot] = 8; s.cooldown[slot] = 120; s.hit[slot] = []; s.fx.push({ frame: s.frame, slot, kind: 'rundash' }); }
      const before = p.x, origin = p.x - 80 * SUB, col = Math.trunc(p.x / TILE);
      const solids = courseSolids(s.course, col - 2, col + 3).map(r => ({ ...r, x: r.x - origin }));
      const dir = (p.bits & 3) === 1 ? -1 : (p.bits & 3) === 2 ? 1 : p.facing;
      const forced = (s.dash[slot] ? dir * 96 : p.vx) + (s.push[slot] ? 80 : 0);
      p.x -= origin; move(p, solids, [], undefined, s.dash[slot] || s.push[slot] ? forced : 0, false, { x: true }); p.x += origin;
      if (s.push[slot]) s.push[slot]--;
      p.x = Math.max(0, p.x); p.stats.distance = (p.stats.distance ?? 0) + Math.max(0, p.x - before);
    }
    for (const [slot, p] of s.players.entries()) if (p.present && p.alive && s.dash[slot]) for (const [other, q] of s.players.entries()) {
      if (other === slot || !q.present || !q.alive || s.hit[slot].includes(other) || !overlaps(body(p), body(q))) continue;
      s.push[other] = 8; s.hit[slot].push(other); p.stats.shoves = (p.stats.shoves ?? 0) + 1; s.fx.push({ frame: s.frame, slot, kind: 'shove' });
    }
    const nextLeader = Math.max(0, ...s.players.filter(p => p.present && p.alive).map(p => p.x));
    s.camX = Math.max(s.camX, nextLeader - 120 * SUB);
    if (s.heatFrame >= 180) s.camX += Math.min(48, 16 + 4 * Math.trunc((s.heatFrame - 180) / 600));
    for (const [slot, p] of s.players.entries()) if (p.present && p.alive && (p.x < s.camX || p.y >= 192 * SUB)) {
      p.alive = false; p.stats.falls = (p.stats.falls ?? 0) + 1; s.fx.push({ frame: s.frame, slot, kind: 'death' });
    }
    for (let slot = 0; slot < 4; slot++) { if (s.dash[slot]) s.dash[slot]--; }
    const living = sides(s, true); s.heatFrame++; s.frame++;
    if (living.length <= 1 || s.heatFrame >= SCREENRUN_HEAT_CAP) {
      if (living.length <= 1) heatPoint(s, living);
      else {
        const farthest = Math.max(...living.flat().map(slot => s.players[slot].x));
        const leaders = living.flat().filter(slot => s.players[slot].x === farthest);
        if (leaders.length === 1) heatPoint(s, [[leaders[0]]]);
      }
      s.nextHeat = true;
    }
    if (sides(s).length <= 1 || Math.max(...s.points) >= 3 || s.frame >= SCREENRUN_CAP) finishMatch(s, g => [Math.max(...g.map(slot => s.points[slot])), g.reduce((n, slot) => n + (s.players[slot].stats.distance ?? 0), 0)]);
  }, bits: (s, slot) => s.players[slot]?.bits ?? 0,
};
