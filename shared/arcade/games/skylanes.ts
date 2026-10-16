import { fighter, SUB, PLAYER_H, PLAYER_W, type ArenaState } from '../arena';
import { random } from '../rng';
import type { GameDef } from '../types';
import { finishMatch, matchEvents, sides } from './match';
export const SKYLANES_CAP = 5400, SKYLANES_WIDTH = 80 * SUB;
export type SkyKind = 'normal' | 'moving' | 'breaking' | 'spring';
export interface SkyPlatform { x: number; y: number; kind: SkyKind; dir: number }
export interface SkyLanesState extends ArenaState { platforms: SkyPlatform[]; cams: number[]; broken: number[][]; moving: number[]; directions: number[] }
/** Columns extend upwards; breaking platforms require a safe neighbour in the same height band. */
export function generateSkyPlatforms(seed: number, count = 96, top = 176 * SUB, previous?: SkyPlatform): { rng: number; platforms: SkyPlatform[] } {
  const rng = { rng: seed }, platforms: SkyPlatform[] = []; let y = top, last = previous;
  const band = (height: number) => Math.trunc((176 * SUB - height) / (64 * SUB));
  for (let i = 0; i < count; i++) {
    y -= (24 + random(rng) % 41) * SUB;
    const kinds: SkyKind[] = last?.kind === 'breaking' ? ['normal','moving','spring'] : ['normal','moving','breaking','spring'];
    let kind = kinds[random(rng) % kinds.length];
    if (kind === 'breaking' && (!last || last.kind === 'breaking' || band(last.y) !== band(y))) kind = 'normal';
    const platform: SkyPlatform = { x: (random(rng) % 57) * SUB, y, kind, dir: random(rng) % 2 ? 1 : -1 };
    platforms.push(platform); last = platform;
  }
  return { rng: rng.rng, platforms };
}
export const skylanes: GameDef<SkyLanesState, { mode: string }> = {
  id: 'skylanes', name: 'Sky Lanes', goal: 'Bounce up your own lane. Steer onto platforms. Highest climb wins.', controls: ['move'], players: [2,4], modes: { ffa: [2,3,4], teams: true },
  init(seed, roster) {
    const generated = generateSkyPlatforms(seed);
    return { frame: 0, fx: [], outcome: null, rng: generated.rng, layout: seed % 3, roster: structuredClone(roster), eliminated: [],
      players: Array.from({ length: 4 }, (_, slot) => fighter(slot, roster, 35 * SUB, 176 * SUB - PLAYER_H)), platforms: generated.platforms,
      cams: [0,0,0,0], broken: [[],[],[],[]], moving: generated.platforms.map(p => p.x), directions: generated.platforms.map(p => p.dir) };
  },
  step(s, events) {
    s.fx = []; matchEvents(s, events); if (s.outcome) { s.frame++; return; }
    const highest = Math.min(...s.players.filter(p => p.present && p.alive).map(p => p.y));
    while (s.platforms.at(-1)!.y > highest - 192 * SUB) {
      const last = s.platforms.at(-1)!, more = generateSkyPlatforms(s.rng, 16, last.y, last);
      s.rng = more.rng;
      for (const t of more.platforms) { s.platforms.push(t); s.moving.push(t.x); s.directions.push(t.dir); }
    }
    // All lanes share the exact same moving column; broken state and cameras are per lane.
    for (const [i, t] of s.platforms.entries()) if (t.kind === 'moving') {
      s.moving[i] += s.directions[i] * 8;
      if (s.moving[i] < 0 || s.moving[i] > 56 * SUB) { s.moving[i] = Math.max(0, Math.min(56 * SUB, s.moving[i])); s.directions[i] *= -1; }
    }
    for (const [slot, p] of s.players.entries()) {
      if (!p.present || !p.alive) continue;
      const dir = Number(!!(p.bits & 2)) - Number(!!(p.bits & 1)); p.vx = Math.max(-40, Math.min(40, p.vx + dir * 4));
      if (dir) p.facing = dir;
      p.x = ((p.x + p.vx) % SKYLANES_WIDTH + SKYLANES_WIDTH) % SKYLANES_WIDTH;
      const bottom = p.y + PLAYER_H; p.vy += 4; const nextBottom = bottom + p.vy;
      let landing = -1, landingY = 176 * SUB;
      const hits = (x: number) => [p.x, p.x - SKYLANES_WIDTH].some(px => px < x + 24 * SUB && px + PLAYER_W > x);
      if (p.vy >= 0) for (const [i, t] of s.platforms.entries()) if (!s.broken[slot].includes(i) && bottom <= t.y && nextBottom >= t.y && hits(s.moving[i]) && (landing < 0 || t.y < landingY)) { landing = i; landingY = t.y; }
      const floor = p.vy >= 0 && bottom <= 176 * SUB && nextBottom >= 176 * SUB;
      if (landing >= 0 || floor) {
        p.y = (landing >= 0 ? landingY : 176 * SUB) - PLAYER_H;
        const kind = landing >= 0 ? s.platforms[landing].kind : 'normal'; p.vy = kind === 'spring' ? -160 : -104;
        if (kind === 'breaking') s.broken[slot].push(landing);
        s.fx.push({ frame: s.frame, slot, kind: kind === 'spring' ? 'skyspring' : kind === 'breaking' ? 'skybreak' : 'skybounce' });
      } else p.y += p.vy;
      p.grounded = false; p.prevBits = p.bits; p.stats.airFrames = (p.stats.airFrames ?? 0) + 1;
      p.stats.height = Math.max(p.stats.height ?? 0, 176 * SUB - p.y - PLAYER_H);
      s.cams[slot] = Math.min(s.cams[slot], p.y - 64 * SUB);
      if (s.frame >= 300) s.cams[slot] -= Math.min(16, 4 + 4 * Math.trunc((s.frame - 300) / 900));
      if (p.y >= s.cams[slot] + 192 * SUB) { p.alive = false; s.fx.push({ frame: s.frame, slot, kind: 'death' }); }
    }
    s.frame++;
    if (!sides(s, true).length || sides(s).length <= 1 || s.frame >= SKYLANES_CAP) finishMatch(s, g => [g.filter(slot => s.players[slot].present).reduce((n, slot) => n + (s.players[slot].stats.height ?? 0), 0)]);
  }, bits: (s, slot) => s.players[slot]?.bits ?? 0,
};
