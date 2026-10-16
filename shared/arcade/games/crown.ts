import { arenaEvents, body, byValue, fighter, move, overlaps, stats, teamOrder, tile, TILE, SUB, PLAYER_H, RUN_MAX, type ArenaState } from '../arena';
import { shuffle } from '../rng';
import type { GameDef } from '../types';
export const CROWN_LAYOUTS = [
  [[1, 11, 7], [12, 11, 7], [4, 9, 3], [13, 9, 3], [7, 8, 6], [3, 6, 4], [13, 6, 4], [2, 5, 4], [14, 5, 4]],
  [[1, 11, 6], [13, 11, 6], [5, 10, 3], [12, 10, 3], [7, 9, 6], [3, 7, 4], [13, 7, 4], [6, 5, 3], [11, 5, 3], [8, 3, 4]],
  [[1, 11, 7], [12, 11, 7], [5, 9, 3], [12, 9, 3], [7, 8, 6], [3, 6, 3], [14, 6, 3], [1, 5, 5], [14, 5, 5], [6, 4, 3], [11, 4, 3], [8, 4, 4]],
].map(layout => layout.map(([x, y, w]) => tile(x, y, w)));
export interface CrownState extends ArenaState { holder: number; returnIn: number; immune: number; dash: number[]; cooldown: number[]; stun: number[]; respawn: number[] }
const home = { x: 155 * SUB, y: 8 * TILE - PLAYER_H };
const holding = (p: { stats: { holdFrames?: number } }) => p.stats.holdFrames ?? 0;
export const crown: GameDef<CrownState, { mode: string }> = {
  id: 'crown', name: 'Crown Keep-Away', goal: 'Grab the golden stapler. Hold it for 20 seconds. Tackle to steal.', controls: ['move', 'jump', 'action'], players: [2, 4], modes: { ffa: [2, 3, 4], teams: true },
  init(seed, roster) { return { frame: 0, fx: [], outcome: null, rng: seed, roster: structuredClone(roster), layout: seed % 3, eliminated: [],
    players: Array.from({ length: 4 }, (_, slot) => fighter(slot, roster, (40 + slot * 76) * SUB, 2 * TILE)),
    holder: -1, returnIn: 0, immune: 0, dash: [0, 0, 0, 0], cooldown: [0, 0, 0, 0], stun: [0, 0, 0, 0], respawn: [0, 0, 0, 0] }; },
  step(s, events) {
    s.fx = []; arenaEvents(s, events, slot => { if (s.holder === slot && !s.outcome) { s.holder = -1; s.returnIn = 60; } });
    if (s.outcome) { s.frame++; return; }
    if (s.returnIn > 0) s.returnIn--; if (s.immune > 0) s.immune--;
    for (const [slot, p] of s.players.entries()) {
      if (!p.present) continue;
      if (s.respawn[slot] > 0) {
        if (--s.respawn[slot] === 0) {
          const spots = shuffle(s, [32, 155, 278]).map(x => ({ x: x * SUB, y: 2 * TILE }));
          const spot = spots.find(pos => !s.players.some((q, i) => i !== slot && q.present && q.alive && overlaps(body(pos), body(q))));
          if (spot) { Object.assign(p, spot, { alive: true, vx: 0, vy: 0, grounded: false, coyote: 0, buffer: 0, prevBits: p.bits }); s.fx.push({ frame: s.frame, slot, kind: 'respawn' }); }
          else s.respawn[slot] = 1;
        }
        continue;
      }
      if (s.cooldown[slot] > 0) s.cooldown[slot]--;
      const stunned = s.stun[slot] > 0; if (stunned) s.stun[slot]--;
      if (!stunned && s.holder !== slot && !s.cooldown[slot] && (p.bits & 32) && !(p.prevBits & 32)) { s.dash[slot] = 10; s.cooldown[slot] = 45; s.fx.push({ frame: s.frame, slot, kind: 'tackle' }); }
      const buttons = p.bits;
      if (stunned) { p.bits = 0; p.vx = 0; s.dash[slot] = 0; }
      move(p, [], CROWN_LAYOUTS[s.layout], s.holder === slot ? Math.trunc(RUN_MAX * 85 / 100) : RUN_MAX, s.dash[slot] ? p.facing * 80 : 0);
      p.bits = buttons; p.prevBits = buttons;
      if (p.y >= 192 * SUB) {
        p.alive = false; s.respawn[slot] = 60; s.dash[slot] = 0;
        if (s.holder === slot) { s.holder = -1; s.returnIn = 60; }
        s.fx.push({ frame: s.frame, slot, kind: 'death' });
      }
    }
    const available = s.players.flatMap((p, slot) => p.present && p.alive ? [slot] : []);
    if (s.holder < 0 && !s.returnIn) {
      const slot = available.find(slot => overlaps(body(s.players[slot]), body(home)));
      if (slot !== undefined) { s.holder = slot; s.dash[slot] = 0; s.fx.push({ frame: s.frame, slot, kind: 'crown' }); }
    } else if (s.holder >= 0 && !s.immune) {
      const holder = s.players[s.holder], robber = available.find(slot => slot !== s.holder && s.dash[slot] > 0 && overlaps(body(s.players[slot]), body(holder)));
      if (robber !== undefined) {
        s.stun[s.holder] = 30; s.holder = robber; s.dash[robber] = 0; s.immune = 30;
        s.players[robber].stats.steals = (s.players[robber].stats.steals ?? 0) + 1; s.fx.push({ frame: s.frame, slot: robber, kind: 'steal' });
      }
    }
    for (let slot = 0; slot < 4; slot++) if (s.dash[slot] > 0) s.dash[slot]--;
    if (s.holder >= 0) s.players[s.holder].stats.holdFrames = holding(s.players[s.holder]) + 1;
    const teamed = s.roster.some(r => r.team !== null), present = s.roster.filter(r => s.players[r.slot].present);
    const times = teamed ? [0, 1].map(team => s.roster.filter(r => r.team === team && s.players[r.slot].present).reduce((n, r) => n + holding(s.players[r.slot]), 0)) : present.map(r => holding(s.players[r.slot]));
    s.frame++;
    if (s.frame >= 5400 || times.some(n => n >= 1200) || present.length <= 1 || teamed && new Set(present.map(r => r.team)).size <= 1) {
      let order = teamOrder(s, byValue(s, holding), holding);
      // An empty team loses immediately even when it had more holding time before leaving.
      if (teamed && new Set(present.map(r => r.team)).size === 1) order = [s.roster.filter(r => r.team === present[0].team).map(r => r.slot), s.roster.filter(r => r.team !== present[0].team).map(r => r.slot)];
      s.outcome = { order, stats: stats(s) };
    }
  }, bits: (s, slot) => s.players[slot]?.bits ?? 0,
};
