import { fighter, type ArenaState } from '../arena';
import { shuffle } from '../rng';
import type { GameDef } from '../types';
import { finishMatch, heatPoint, matchEvents, sides, teamed } from './match';
export const TRAILS_W = 64, TRAILS_H = 38, TRAILS_CELL = 5, TRAILS_CAP = 9000, TRAILS_HEAT_CAP = 1800;
export const TRAILS_STARTS = [
  [[10,9,0],[53,28,2],[10,28,3],[53,9,1]],
  [[8,8,0],[55,29,2],[8,29,3],[55,8,1]],
  [[16,6,1],[47,31,3],[16,31,0],[47,6,2]],
];
const DX = [1,0,-1,0], DY = [0,1,0,-1], TURN_BITS = [2,8,1,4];
export interface TrailsState extends ArenaState { grid: number[]; heatFrame: number; nextHeat: boolean; points: number[]; dir: number[]; turn: number[]; clock: number[]; boost: number[]; jump: boolean[]; cooldown: number[] }
function resetHeat(s: TrailsState) {
  s.grid.fill(0); s.heatFrame = 0; s.nextHeat = false; s.clock.fill(0); s.boost.fill(90); s.cooldown.fill(0); s.jump.fill(false);
  const starts = shuffle(s, TRAILS_STARTS[s.layout]);
  s.players.forEach((p, slot) => { const [x,y,dir] = starts[slot]; Object.assign(p, fighter(slot, s.roster, x, y), { present: p.present, alive: p.present, stats: p.stats, bits: p.bits, prevBits: p.bits }); s.dir[slot] = s.turn[slot] = dir; if (p.present) s.grid[y * TRAILS_W + x] = slot + 1; });
}
export const trails: GameDef<TrailsState, { mode: string }> = {
  id: 'trails', name: 'Trails', goal: 'Leave a light trail. Outlast rivals. Boost and jump to escape.', controls: ['move', 'jump', 'action'], players: [2,4], modes: { ffa: [2,3,4], teams: true },
  init(seed, roster) {
    const s: TrailsState = { frame: 0, fx: [], outcome: null, rng: seed, layout: seed % 3, roster: structuredClone(roster), eliminated: [], players: Array.from({ length: 4 }, (_, slot) => fighter(slot, roster, 0, 0)),
      grid: Array(TRAILS_W * TRAILS_H).fill(0), heatFrame: 0, nextHeat: false, points: [0,0,0,0], dir: [0,0,0,0], turn: [0,0,0,0], clock: [0,0,0,0], boost: [90,90,90,90], jump: [false,false,false,false], cooldown: [0,0,0,0] };
    resetHeat(s); return s;
  },
  step(s, events) {
    s.fx = []; if (!s.outcome && s.nextHeat) resetHeat(s);
    const wasAlive = s.players.map(p => p.present && p.alive);
    matchEvents(s, events); if (s.outcome) { s.frame++; return; }
    for (const [, slot, kind] of events) if (kind === 3 && s.players[slot]) { s.turn[slot] = s.dir[slot]; s.jump[slot] = false; }
    const proposals: { slot: number; x: number; y: number; fromX: number; fromY: number }[] = [];
    for (const [slot, p] of s.players.entries()) {
      if (!p.present || !p.alive) continue;
      p.stats.survivedFrames = (p.stats.survivedFrames ?? 0) + 1;
      const edge = p.bits & ~p.prevBits;
      // A held direction also works on the first frame; later presses replace the queued turn.
      const turn = TURN_BITS.findIndex(bit => !!(edge & bit));
      if (turn >= 0 && turn !== (s.dir[slot] + 2) % 4) s.turn[slot] = turn;
      if (s.cooldown[slot]) s.cooldown[slot]--;
      if ((edge & 16) && !s.cooldown[slot]) { s.jump[slot] = true; s.cooldown[slot] = 180; s.fx.push({ frame: s.frame, slot, kind: 'bikejump' }); }
      const boosting = !!(p.bits & 32) && s.boost[slot] > 0;
      if (boosting) { s.boost[slot]--; if (!(p.prevBits & 32)) s.fx.push({ frame: s.frame, slot, kind: 'bikeboost' }); }
      else if (s.frame % 2 === 0) s.boost[slot] = Math.min(90, s.boost[slot] + 1);
      if (++s.clock[slot] >= (boosting ? 2 : 3)) {
        s.clock[slot] = 0; s.dir[slot] = s.turn[slot]; const length = s.jump[slot] ? 2 : 1; s.jump[slot] = false;
        proposals.push({ slot, x: p.x + DX[s.dir[slot]] * length, y: p.y + DY[s.dir[slot]] * length, fromX: p.x, fromY: p.y });
      }
      p.prevBits = p.bits;
    }
    const outs = proposals.filter(a => a.x <= 0 || a.x >= TRAILS_W - 1 || a.y <= 0 || a.y >= TRAILS_H - 1 || s.grid[a.y * TRAILS_W + a.x] !== 0 || proposals.some(b => b.slot !== a.slot && (a.x === b.x && a.y === b.y || a.x === b.fromX && a.y === b.fromY && b.x === a.fromX && b.y === a.fromY))).map(a => a.slot);
    for (const a of proposals) { const p = s.players[a.slot]; p.x = a.x; p.y = a.y; if (a.x > 0 && a.x < TRAILS_W - 1 && a.y > 0 && a.y < TRAILS_H - 1) s.grid[a.y * TRAILS_W + a.x] = a.slot + 1; }
    for (const slot of outs) { const p = s.players[slot]; p.alive = false; p.stats.deaths = (p.stats.deaths ?? 0) + 1; s.fx.push({ frame: s.frame, slot, kind: 'bikecrash' }); }
    const departed = wasAlive.flatMap((alive, slot) => alive && !s.players[slot].present ? [slot] : []), lost = outs.length + departed.length;
    const living = sides(s, true);
    if (teamed(s)) { if (lost && living.length <= 1) heatPoint(s, living, 2); }
    else for (const slot of living.flat()) s.points[slot] += lost;
    s.heatFrame++; s.frame++;
    if (living.length <= 1 || s.heatFrame >= TRAILS_HEAT_CAP) s.nextHeat = true;
    if (sides(s).length <= 1 || Math.max(...s.points) >= 6 || s.frame >= TRAILS_CAP) finishMatch(s, g => [Math.max(...g.map(slot => s.points[slot]))]);
  }, bits: (s, slot) => s.players[slot]?.bits ?? 0,
};
