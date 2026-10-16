import type { BaseState, GameEvent, Outcome, RosterEntry, Stats } from './types';
export const SUB = 16, TILE = 16 * SUB, PLAYER_W = 10 * SUB, PLAYER_H = 20 * SUB, VIEW_W = 320 * SUB;
export const RUN_MAX = 32, ACCEL_GROUND = 4, ACCEL_AIR = 3, FRICTION = 6, JUMP_V = 92;
export const GRAVITY_HELD = 6, GRAVITY = 10, MAX_FALL = 88;
export const COYOTE = 6, JUMP_BUFFER = 6, CORNER = 4 * SUB;
export interface Point { x: number; y: number }
export interface Rect extends Point { w: number; h: number }
export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export interface Fighter { present: boolean; alive: boolean; x: number; y: number; vx: number; vy: number; bits: number; prevBits: number; grounded: boolean; facing: number; coyote: number; buffer: number; team: 0 | 1 | null; stats: Stats }
export interface ArenaState extends BaseState { players: Fighter[]; roster: RosterEntry[]; rng: number; layout: number; eliminated: number[][] }
export const body = (p: { x: number; y: number }): Rect => ({ x: p.x, y: p.y, w: PLAYER_W, h: PLAYER_H });
export const tile = (x: number, y: number, w = 1): Rect => ({ x: x * TILE, y: y * TILE, w: w * TILE, h: TILE });
export function fighter(slot: number, roster: RosterEntry[], x: number, y: number): Fighter {
  return { present: roster.some(p => p.slot === slot), alive: roster.some(p => p.slot === slot), x, y, vx: 0, vy: 0, bits: 0, prevBits: 0, grounded: false, facing: 1, coyote: 0, buffer: 0, team: roster.find(p => p.slot === slot)?.team ?? null, stats: {} };
}
export function arenaEvents(s: ArenaState, events: GameEvent[], leave?: (slot: number) => void) {
  const outs: number[] = [];
  for (const [, slot, kind, bits] of events) {
    const p = s.players[slot]; if (!p) continue;
    if (kind === 1 && !s.outcome && !s.roster.some(r => r.slot === slot)) continue; // running rosters are frozen
    if (kind === 2) { if (p.present && p.alive) outs.push(slot); p.present = false; p.alive = false; p.bits = 0; leave?.(slot); }
    if (kind === 3) { p.bits = p.prevBits = p.buffer = 0; }
    if (kind === 0 && p.present) p.bits = bits & 63;
  }
  if (!s.outcome && outs.length) s.eliminated.push(outs);
}
export function move(p: Fighter, solids: Rect[], platforms: Rect[], speed = RUN_MAX, dash = 0, pound = false, wrap: { x?: boolean; y?: boolean } = {}): boolean {
  const rect = body(p), beforeBottom = p.y + PLAYER_H;
  const wrapped = (n: number, size: number) => (n % size + size) % size;
  const blocked = (x: number, y: number, dy: number) => {
    if (!wrap.x && (x < 0 || x + PLAYER_W > 320 * SUB) || !wrap.y && y < 0) return true;
    const r = { ...rect, x: wrap.x ? wrapped(x, 320 * SUB) : x, y: wrap.y ? wrapped(y, 192 * SUB) : y };
    return solids.some(t => overlaps(r, t)) || dy > 0 && platforms.some(t => beforeBottom <= t.y && overlaps(r, t));
  };
  p.grounded = blocked(p.x, p.y + 1, 1); p.coyote = p.grounded ? COYOTE : Math.max(0, p.coyote - 1);
  p.buffer = (p.bits & 16) && !(p.prevBits & 16) ? JUMP_BUFFER : Math.max(0, p.buffer - 1);
  const dir = (p.bits & 3) === 1 ? -1 : (p.bits & 3) === 2 ? 1 : 0;
  if (dir) { p.vx = Math.max(-speed, Math.min(speed, p.vx + dir * (p.grounded ? ACCEL_GROUND : ACCEL_AIR))); p.facing = dir; }
  else if (p.grounded) p.vx -= Math.max(-FRICTION, Math.min(FRICTION, p.vx));
  p.vx = Math.max(-speed, Math.min(speed, p.vx));
  if (p.buffer && p.coyote && !pound) { p.vy = -JUMP_V; p.buffer = p.coyote = 0; p.grounded = false; }
  p.vy = pound ? MAX_FALL : Math.min(MAX_FALL, p.vy + ((p.bits & 16) && p.vy < 0 ? GRAVITY_HELD : GRAVITY));
  const axis = (key: 'x' | 'y', amount: number) => {
    let done = 0;
    while (done !== amount) {
      const d = Math.sign(amount) * Math.min(SUB, Math.abs(amount - done));
      let safe = d;
      while (safe && blocked(p.x + (key === 'x' ? safe : 0), p.y + (key === 'y' ? safe : 0), key === 'y' ? safe : 0)) safe -= Math.sign(d);
      p[key] += safe; if (wrap[key]) p[key] = wrapped(p[key], (key === 'x' ? 320 : 192) * SUB); done += safe;
      if (safe !== d) break;
    }
    return done === amount;
  };
  if (!axis('x', dash || p.vx)) p.vx = 0;
  const falling = p.vy > 0, landed = !axis('y', p.vy) && falling;
  if (landed) p.grounded = true;
  if (landed || p.vy < 0 && blocked(p.x, p.y - 1, -1)) p.vy = 0;
  p.prevBits = p.bits; return landed;
}
export function stats(s: ArenaState): Outcome['stats'] { return Object.fromEntries(s.roster.map(r => [r.slot, { ...s.players[r.slot].stats }])); }
export function byValue(s: ArenaState, value: (p: Fighter) => number): number[][] {
  const sorted = s.roster.filter(r => s.players[r.slot].present).map(r => r.slot).sort((a, b) => value(s.players[b]) - value(s.players[a]) || a - b), groups: number[][] = [];
  for (const slot of sorted) if (groups.length && value(s.players[groups.at(-1)![0]]) === value(s.players[slot])) groups.at(-1)!.push(slot); else groups.push([slot]);
  return [...groups, ...s.eliminated.slice().reverse()];
}
export function teamOrder(s: ArenaState, order: number[][], value?: (p: Fighter) => number): number[][] {
  if (!s.roster.some(r => r.team !== null)) return order;
  const teams = [0, 1].map(team => s.roster.filter(r => r.team === team).map(r => r.slot));
  const score = (slots: number[]) => value ? slots.filter(slot => s.players[slot].present).reduce((n, slot) => n + value(s.players[slot]), 0) : -Math.min(...slots.map(slot => order.findIndex(g => g.includes(slot))));
  const a = score(teams[0]), b = score(teams[1]);
  return a === b ? [[...teams[0], ...teams[1]].sort()] : a > b ? teams : teams.reverse();
}
