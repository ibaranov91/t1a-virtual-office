import { body, fighter, move, overlaps, tile, TILE, SUB, PLAYER_H, PLAYER_W, type ArenaState, type Rect } from '../arena';
import { shuffle } from '../rng';
import type { GameDef } from '../types';
import { finishMatch, heatPoint, matchEvents, sides, teamed } from './match';
export const QUIVER_CAP = 9000, QUIVER_HEAT_CAP = 3600, QUIVER_SPIKES = 2400;
export const QUIVER_LAYOUTS = [
  [[0, 11, 4], [6, 11, 8], [16, 11, 4], [3, 8, 4], [13, 8, 4], [8, 5, 4], [1, 3, 3], [16, 3, 3]],
  [[0, 11, 8], [12, 11, 8], [1, 8, 5], [14, 8, 5], [7, 6, 6], [3, 3, 4], [13, 3, 4]],
  [[0, 11, 5], [7, 11, 6], [15, 11, 5], [6, 9, 8], [1, 6, 4], [15, 6, 4], [7, 3, 6]],
].map(layout => layout.map(([x, y, w]) => tile(x, y, w)));
export interface Arrow extends Rect { vx: number; vy: number; owner: number; age: number; stuck: boolean }
export interface QuiverState extends ArenaState { heatFrame: number; nextHeat: boolean; points: number[]; ammo: number[]; cooldown: number[]; arrows: Arrow[] }
function resetHeat(s: QuiverState) {
  const starts = shuffle(s, s.layout === 2 ? [1, 3, 16, 18] : [2, 7, 12, 17]);
  for (const [slot, p] of s.players.entries()) {
    const fresh = fighter(slot, s.roster, starts[slot] * TILE, 11 * TILE - PLAYER_H);
    Object.assign(p, fresh, { present: p.present, alive: p.present, stats: p.stats, bits: p.bits, prevBits: p.bits, facing: starts[slot] < 10 ? 1 : -1 });
  }
  s.heatFrame = 0; s.nextHeat = false; s.arrows = []; s.ammo.fill(3); s.cooldown.fill(0);
}
export const quiver: GameDef<QuiverState, { mode: string }> = {
  id: 'quiver', name: 'Quiver', goal: 'Fire, recover arrows, stomp heads. First to three heats wins.', controls: ['move', 'aim', 'jump', 'action'], players: [2, 4], modes: { ffa: [2, 3, 4], teams: true },
  init(seed, roster) {
    const s: QuiverState = { frame: 0, fx: [], outcome: null, rng: seed, layout: seed % 3, roster: structuredClone(roster), eliminated: [],
      players: Array.from({ length: 4 }, (_, slot) => fighter(slot, roster, 0, 0)), heatFrame: 0, nextHeat: false, points: [0, 0, 0, 0], ammo: [3, 3, 3, 3], cooldown: [0, 0, 0, 0], arrows: [] };
    resetHeat(s); return s;
  },
  step(s, events) {
    s.fx = []; if (!s.outcome && s.nextHeat) resetHeat(s); matchEvents(s, events);
    if (s.outcome) { s.frame++; return; }
    const touching = (a: Rect, b: Rect) => [0, -320 * SUB, 320 * SUB].some(x => (s.heatFrame < QUIVER_SPIKES ? [0, -192 * SUB, 192 * SUB] : [0]).some(y => overlaps(a, { ...b, x: b.x + x, y: b.y + y })));
    const solids = QUIVER_LAYOUTS[s.layout], old = s.players.map(p => ({ x: p.x, y: p.y })), killed = new Map<number, { killer: number; stomp: boolean }>();
    const enemy = (a: number, b: number) => !teamed(s) || s.players[a].team !== s.players[b].team;
    const kill = (victim: number, killer = -1, stomp = false) => { if (!killed.has(victim)) killed.set(victim, { killer, stomp }); };
    for (const [slot, p] of s.players.entries()) {
      if (!p.present || !p.alive) continue;
      if (s.cooldown[slot]) s.cooldown[slot]--;
      if ((p.bits & 32) && !(p.prevBits & 32) && !s.cooldown[slot] && s.ammo[slot]) {
        let dx = Number(!!(p.bits & 2)) - Number(!!(p.bits & 1)), dy = Number(!!(p.bits & 8)) - Number(!!(p.bits & 4));
        if (!dx && !dy) dx = p.facing;
        const speed = dx && dy ? 64 : 96;
        s.arrows.push({ x: p.x + Math.trunc(PLAYER_W / 2) - SUB, y: p.y + Math.trunc(PLAYER_H / 2) - SUB, w: 2 * SUB, h: 2 * SUB, vx: dx * speed, vy: dy * speed, owner: slot, age: 0, stuck: false });
        s.ammo[slot]--; s.cooldown[slot] = 12; s.fx.push({ frame: s.frame, slot, kind: 'arrow' });
      }
      const jumped = p.grounded && (p.bits & 16) && !(p.prevBits & 16);
      move(p, solids, [], undefined, 0, false, { x: true, y: s.heatFrame < QUIVER_SPIKES });
      if (!p.grounded) p.stats.airFrames = (p.stats.airFrames ?? 0) + 1;
      if (jumped) s.fx.push({ frame: s.frame, slot, kind: 'jump' });
      if (s.heatFrame >= QUIVER_SPIKES && p.y + PLAYER_H >= (192 - Math.trunc((s.heatFrame - QUIVER_SPIKES) / 4)) * SUB) kill(slot);
    }
    const wrap = (n: number, size: number) => (n % size + size) % size;
    const removed = new Set<Arrow>();
    for (const a of s.arrows) {
      if (a.stuck) {
        const slot = s.players.findIndex((p, slot) => p.present && p.alive && s.ammo[slot] < 6 && touching(body(p), a));
        if (slot >= 0 && s.ammo[slot] < 6) { s.ammo[slot]++; removed.add(a); s.fx.push({ frame: s.frame, slot, kind: 'pickup' }); }
        continue;
      }
      // One-pixel swept projectiles; walls win a collision at the same sub-pixel.
      const steps = Math.trunc(Math.max(Math.abs(a.vx), Math.abs(a.vy)) / SUB);
      for (let i = 0; i < steps && !removed.has(a) && !a.stuck; i++) {
        const x = wrap(a.x + Math.trunc(a.vx / steps), 320 * SUB), y = a.y + Math.trunc(a.vy / steps);
        const next = { ...a, x, y: s.heatFrame < QUIVER_SPIKES ? wrap(y, 192 * SUB) : y };
        if (solids.some(r => overlaps(next, r)) || s.heatFrame >= QUIVER_SPIKES && (y < 0 || y >= 192 * SUB)) { a.stuck = true; s.fx.push({ frame: s.frame, slot: a.owner, kind: 'arrowstick' }); break; }
        a.x = next.x; a.y = next.y;
        const victim = s.players.findIndex((p, slot) => p.present && p.alive && (slot !== a.owner || a.age >= 10) && (slot === a.owner || enemy(slot, a.owner)) && touching(body(p), a));
        if (victim >= 0) { kill(victim, a.owner); removed.add(a); }
      }
      a.age++;
    }
    s.arrows = s.arrows.filter(a => !removed.has(a));
    for (const [slot, p] of s.players.entries()) if (p.present && p.alive && p.vy > 0) for (const [victim, q] of s.players.entries()) {
      if (slot === victim || !q.present || !q.alive || !enemy(slot, victim)) continue;
      const oldY = (i: number) => old[i].y + (s.heatFrame < QUIVER_SPIKES ? s.players[i].y - old[i].y > 96 * SUB ? 192 * SUB : old[i].y - s.players[i].y > 96 * SUB ? -192 * SUB : 0 : 0);
      const stomped = [0, -320 * SUB, 320 * SUB].some(dx => (s.heatFrame < QUIVER_SPIKES ? [0, -192 * SUB, 192 * SUB] : [0]).some(dy =>
        oldY(slot) + PLAYER_H <= oldY(victim) + dy + Math.trunc(PLAYER_H / 2) && p.y + PLAYER_H >= q.y + dy && p.y + PLAYER_H <= q.y + dy + Math.trunc(PLAYER_H / 2) && p.x < q.x + dx + PLAYER_W && p.x + PLAYER_W > q.x + dx));
      if (stomped) kill(victim, slot, true);
    }
    for (const [victim, hit] of killed) {
      const p = s.players[victim]; p.alive = false; p.stats.deaths = (p.stats.deaths ?? 0) + 1;
      if (hit.killer >= 0 && hit.killer !== victim) {
        const killer = s.players[hit.killer]; killer.stats.kills = (killer.stats.kills ?? 0) + 1;
        if (hit.stomp) { killer.stats.stomps = (killer.stats.stomps ?? 0) + 1; p.stats.stomped = (p.stats.stomped ?? 0) + 1; }
      }
      s.fx.push({ frame: s.frame, slot: victim, kind: hit.stomp ? 'stomp' : 'death' });
    }
    const living = sides(s, true); s.heatFrame++; s.frame++;
    if (living.length <= 1 || s.heatFrame >= QUIVER_HEAT_CAP) { if (s.heatFrame < QUIVER_HEAT_CAP) heatPoint(s, living); s.nextHeat = true; }
    if (sides(s).length <= 1 || Math.max(...s.points) >= 3 || s.frame >= QUIVER_CAP) finishMatch(s, g => [Math.max(...g.map(slot => s.points[slot])), g.reduce((n, slot) => n + (s.players[slot].stats.kills ?? 0), 0)]);
  }, bits: (s, slot) => s.players[slot]?.bits ?? 0,
};
