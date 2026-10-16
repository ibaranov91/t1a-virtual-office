import { arenaEvents, fighter, move, stats, teamOrder, tile, TILE, SUB, PLAYER_H, PLAYER_W, type ArenaState } from '../arena';
import { shuffle } from '../rng';
import type { GameDef } from '../types';
export const CRUMBLE_DELAY = 45; // frames a cracked tile holds before it drops
export interface CrumbleState extends ArenaState { tiles: { x: number; y: number; crackAt: number; owner: number; gone: boolean }[]; pounding: boolean[] }
export const crumble: GameDef<CrumbleState, { mode: string }> = {
  id: 'crumble', name: 'Crumble Tower', goal: 'Keep moving. The floor disappears. Be the last one standing.', controls: ['move', 'jump', 'action'], players: [2, 4], modes: { ffa: [2, 3, 4], teams: true },
  init(seed, roster) {
    const rand = { rng: seed }, starts = shuffle(rand, [2, 7, 12, 17]);
    return { frame: 0, fx: [], outcome: null, rng: rand.rng, layout: seed % 3, roster: structuredClone(roster), eliminated: [],
      players: Array.from({ length: 4 }, (_, slot) => fighter(slot, roster, starts[slot] * TILE, 2 * TILE - PLAYER_H)),
      tiles: [2, 5, 8, 11].flatMap(y => Array.from({ length: 18 }, (_, i) => ({ x: i + 1, y, crackAt: -1, owner: -1, gone: false }))), pounding: [false, false, false, false] };
  },
  step(s, events) {
    s.fx = []; arenaEvents(s, events); if (s.outcome) { s.frame++; return; }
    const breakTile = (i: number, slot: number) => {
      const t = s.tiles[i]; if (!t || t.gone) return; t.gone = true;
      if (slot >= 0) s.players[slot].stats.tiles = (s.players[slot].stats.tiles ?? 0) + 1;
      s.fx.push({ frame: s.frame, slot, kind: 'crack' });
    };
    s.tiles.forEach((t, i) => { if (t.crackAt >= 0 && s.frame >= t.crackAt + CRUMBLE_DELAY) breakTile(i, t.owner); });
    const outs: number[] = [];
    for (const [slot, p] of s.players.entries()) {
      if (!p.present || !p.alive) continue;
      p.stats.survivedFrames = (p.stats.survivedFrames ?? 0) + 1;
      p.grounded = s.tiles.some(t => !t.gone && p.y + PLAYER_H === t.y * TILE && p.x < (t.x + 1) * TILE && p.x + PLAYER_W > t.x * TILE);
      if (!p.grounded && (p.bits & 32) && !(p.prevBits & 32)) s.pounding[slot] = true;
      const platforms = s.tiles.filter(t => !t.gone).map(t => tile(t.x, t.y));
      const landed = move(p, [], platforms, undefined, 0, s.pounding[slot]);
      const under = s.tiles.findIndex(t => !t.gone && p.y + PLAYER_H === t.y * TILE && p.x + Math.trunc(PLAYER_W / 2) >= t.x * TILE && p.x + Math.trunc(PLAYER_W / 2) < (t.x + 1) * TILE);
      if (p.grounded) for (const t of s.tiles) if (!t.gone && t.crackAt < 0 && p.y + PLAYER_H === t.y * TILE && p.x < (t.x + 1) * TILE && p.x + PLAYER_W > t.x * TILE) { t.crackAt = s.frame; t.owner = slot; }
      if (under >= 0 && p.grounded) {
        const t = s.tiles[under];
        if (landed && s.pounding[slot]) for (const [i, q] of s.tiles.entries()) if (q.y === t.y && Math.abs(q.x - t.x) <= 1) breakTile(i, slot);
      }
      if (landed) s.pounding[slot] = false;
      if (p.y >= 192 * SUB) { p.alive = false; p.stats.falls = (p.stats.falls ?? 0) + 1; outs.push(slot); s.fx.push({ frame: s.frame, slot, kind: 'death' }); }
    }
    if (outs.length) s.eliminated.push(outs);
    const living = s.roster.filter(r => s.players[r.slot].present && s.players[r.slot].alive), teams = new Set(living.map(r => r.team));
    s.frame++;
    if (living.length <= 1 || s.roster.some(r => r.team !== null) && teams.size <= 1 || s.frame >= 5400) {
      const order = [...(living.length ? [living.map(r => r.slot)] : []), ...s.eliminated.slice().reverse()];
      s.outcome = { order: teamOrder(s, order), stats: stats(s) };
    }
  }, bits: (s, slot) => s.players[slot]?.bits ?? 0,
};
