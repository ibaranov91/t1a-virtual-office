import type { BaseState, GameEvent, Stats } from '../arcade/types';
import { hash } from '../arcade/hash';
export { PARK_FPS, PARK_INPUT_DELAY, PARK_SERVER_LAG, PARK_SPECTATOR_DELAY, PARK_MAX_PLAYERS } from './types';
export type { GameEvent } from './types';

import { SUB, TILE, PLAYER_W, PLAYER_H, VIEW_W, RUN_MAX, ACCEL_GROUND, ACCEL_AIR, FRICTION, JUMP_V,
  GRAVITY_HELD, GRAVITY, MAX_FALL, COYOTE, JUMP_BUFFER, CORNER, overlaps, type Point, type Rect } from '../arcade/arena';
export { SUB, TILE, PLAYER_W, PLAYER_H, VIEW_W, RUN_MAX, ACCEL_GROUND, ACCEL_AIR, FRICTION, JUMP_V,
  GRAVITY_HELD, GRAVITY, MAX_FALL, COYOTE, JUMP_BUFFER, CORNER, overlaps, type Point, type Rect } from '../arcade/arena';
export const BOX_MAX_FALL = 64, RESPAWN = 45, EXIT_HOLD = 30;
export interface Need { need: number | 'all' }
export interface LevelMeta {
  id: number; name: string; rows: string[];
  boxes?: Need[];
  buttons?: Partial<Record<'1' | '2' | '3' | '4', Need & { latch?: boolean; latchSolo?: boolean }>>;
  lifts?: (Need & { dy: number; speed: number })[];
  movers?: { dx: number; dy: number; period: number }[];
  lobby?: { start: Rect; exit: Rect; selectors: (Rect & { delta: number; kind?: 'crew' | 'mode' })[] }; // tile coordinates
}
export interface LevelDef extends LevelMeta {
  width: number; spawn: Point; key: Point; door: Rect;
  solids: Rect[]; oneWays: Rect[]; spikes: Rect[]; flags: Point[]; coinDefs: Rect[];
  boxDefs: (Rect & Need)[]; buttonDefs: (Rect & Need & { group: number; latch?: boolean; latchSolo?: boolean })[];
  gateDefs: (Rect & { group: number })[]; liftDefs: (Rect & Need & { dy: number; speed: number })[];
  moverDefs: (Rect & { dx: number; dy: number; period: number })[];
  sDefs: Rect[]; tDefs: Rect[]; enemyDefs: Point[];
}
export interface Player {
  present: boolean; x: number; y: number; vx: number; vy: number; bits: number; prevBits: number;
  grounded: boolean; coyote: number; buffer: number; jumpHeld: boolean; facing: number;
  dead: boolean; respawnIn: number; entered: boolean;
  exitHold: number; // lobby: frames standing in the EXIT door
}
export type FxKind = 'jump' | 'coin' | 'key' | 'door' | 'button' | 'stomp' | 'death' | 'respawn' | 'clear' | 'select';
export interface ParkFx { frame: number; kind: FxKind; slot: number }
export interface ParkState extends BaseState {
  frame: number; players: Player[];
  key: Point & { homeX: number; homeY: number; carrier: number }; doorOpen: boolean;
  buttons: { pressed: boolean; latched: boolean }[]; gates: { open: boolean }[];
  boxes: (Point & { vy: number })[]; lifts: { offset: number }[]; movers: { phase: number; offset: Point }[];
  sBlocks: boolean[]; tBlocks: boolean[]; coinsTaken: boolean[]; enemies: (Point & { dir: number; alive: boolean })[];
  checkpoint: Point; camX: number; coins: number; cleared: boolean; clearedAt: number;
  stats: Stats[]; keyDoor: number[]; crewBumps: number; teamMode: boolean;
  selected: number; startHold: number; startReady: boolean; fx: ParkFx[];
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));
const tileRect = (x: number, y: number, w = 1, h = 1): Rect => ({ x: x * TILE, y: y * TILE, w: w * TILE, h: h * TILE });
const playerRect = (p: Point): Rect => ({ ...p, w: PLAYER_W, h: PLAYER_H });
export function parseLevel(meta: LevelMeta): LevelDef {
  const width = meta.rows[0]?.length;
  if (meta.rows.length !== 12 || width < 20 || width > 160 || meta.rows.some(r => r.length !== width)) throw new Error('level must be rectangular, 20–160 × 12');
  for (const c of ['S', 'K', 'D']) {
    const count = meta.rows.join('').split(c).length - 1;
    if (count !== 1 && !(meta.lobby && c !== 'S' && count === 0)) throw new Error(`level needs one ${c}`);
  }
  const l: LevelDef = { ...meta, width, spawn: { x: 0, y: 0 }, key: { x: -TILE, y: -TILE }, door: { ...tileRect(-1, -1), w: 0, h: 0 },
    solids: [], oneWays: [], spikes: [], flags: [], coinDefs: [], boxDefs: [], buttonDefs: [], gateDefs: [],
    liftDefs: [], moverDefs: [], sDefs: [], tDefs: [], enemyDefs: [] };
  for (let y = 0; y < 12; y++) for (let x = 0; x < width; x++) {
    const c = meta.rows[y][x], r = tileRect(x, y);
    if (!'.#B=^SKDCFEstX1234abcdLM'.includes(c)) throw new Error(`unknown tile ${c}`);
    if (c === '#' || c === 'B') l.solids.push(r);
    if (c === '=') l.oneWays.push(r);
    if (c === '^') l.spikes.push({ ...r, y: r.y + Math.trunc(TILE / 2), h: Math.trunc(TILE / 2) });
    if (c === 'S') l.spawn = { x: r.x, y: r.y + TILE - PLAYER_H };
    if (c === 'K') l.key = { x: r.x, y: r.y };
    if (c === 'D') l.door = tileRect(x, y - 1, 1, 2);
    if (c === 'C') l.coinDefs.push(r);
    if (c === 'F') l.flags.push({ x: r.x, y: r.y + TILE - PLAYER_H });
    if (c === 's') l.sDefs.push(r);
    if (c === 't') l.tDefs.push(r);
    if (c === 'E') l.enemyDefs.push({ x: r.x, y: r.y });
    if (c === 'X') l.boxDefs.push({ ...r, ...(meta.boxes?.[l.boxDefs.length] ?? { need: 'all' }) });
    if ('1234'.includes(c)) l.buttonDefs.push({ ...r, group: Number(c) - 1, ...(meta.buttons?.[c as '1'] ?? { need: 1 }) });
    if ('abcd'.includes(c)) l.gateDefs.push({ ...r, group: c.charCodeAt(0) - 97 });
    if (c === 'L') {
      const m = meta.lifts?.[l.liftDefs.length];
      if (!m || !Number.isInteger(m.dy) || !Number.isInteger(m.speed) || m.speed <= 0) throw new Error('lift needs integer dy/speed');
      l.liftDefs.push({ ...tileRect(x, y, 3), ...m });
    }
    if (c === 'M') {
      const m = meta.movers?.[l.moverDefs.length];
      if (!m || !Number.isInteger(m.period) || m.period < 2 || m.period % 2 || !Number.isInteger(m.dx) || !Number.isInteger(m.dy)) throw new Error('mover needs integer dx/dy and even period');
      l.moverDefs.push({ ...tileRect(x, y, 3), ...m });
    }
  }
  return l;
}
const freshPlayer = (l: LevelDef, slot: number): Player => ({ present: false, x: l.spawn.x + slot * 12 * SUB, y: l.spawn.y,
  vx: 0, vy: 0, bits: 0, prevBits: 0, grounded: false, coyote: 0, buffer: 0, jumpHeld: false, facing: 1,
  dead: false, respawnIn: 0, entered: false, exitHold: 0 });
export function parkInit(l: LevelDef, selected = 1): ParkState {
  return { frame: 0, outcome: null, stats: Array.from({ length: 4 }, () => ({})), keyDoor: [0, 0, 0, 0], crewBumps: 0, teamMode: false, players: Array.from({ length: 4 }, (_, slot) => freshPlayer(l, slot)),
    key: { ...l.key, homeX: l.key.x, homeY: l.key.y, carrier: -1 }, doorOpen: false,
    buttons: l.buttonDefs.map(() => ({ pressed: false, latched: false })), gates: l.gateDefs.map(() => ({ open: false })),
    boxes: l.boxDefs.map(r => ({ x: r.x, y: r.y, vy: 0 })), lifts: l.liftDefs.map(() => ({ offset: 0 })),
    movers: l.moverDefs.map(() => ({ phase: 0, offset: { x: 0, y: 0 } })),
    sBlocks: l.sDefs.map(() => false), tBlocks: l.tDefs.map(() => false), coinsTaken: l.coinDefs.map(() => false),
    enemies: l.enemyDefs.map(r => ({ ...r, dir: 1, alive: true })), checkpoint: { ...l.spawn }, camX: 0,
    coins: 0, cleared: false, clearedAt: -1, selected, startHold: 0, startReady: false, fx: [] };
}
interface Body extends Rect { kind: 'player' | 'box' | 'lift' | 'mover'; index: number }
const alive = (p: Player) => p.present && !p.dead && !p.entered;
function bodies(s: ParkState, l: LevelDef): Body[] {
  return [
    ...s.players.flatMap((p, index): Body[] => alive(p) ? [{ ...playerRect(p), kind: 'player', index }] : []),
    ...s.boxes.map((b, index): Body => ({ ...b, w: TILE, h: TILE, kind: 'box', index })),
    ...s.lifts.map((v, index): Body => ({ ...l.liftDefs[index], y: l.liftDefs[index].y + v.offset, kind: 'lift', index })),
    ...s.movers.map((v, index): Body => ({ ...l.moverDefs[index], x: l.moverDefs[index].x + v.offset.x, y: l.moverDefs[index].y + v.offset.y, kind: 'mover', index })),
  ];
}
function supports(bs: Body[]): Map<Body, Body> {
  const result = new Map<Body, Body>();
  for (const b of bs) {
    let best: Body | undefined, overlap = 0;
    for (const q of bs) {
      const n = Math.min(b.x + b.w, q.x + q.w) - Math.max(b.x, q.x);
      if (q !== b && b.y + b.h === q.y && n > overlap) { best = q; overlap = n; }
    }
    if (best) result.set(b, best);
  }
  return result;
}
function tiles(s: ParkState, l: LevelDef): Rect[] {
  return [...l.solids, ...l.gateDefs.filter((_, i) => !s.gates[i].open),
    ...l.sDefs.filter((_, i) => s.sBlocks[i]), ...l.tDefs.filter((_, i) => s.tBlocks[i]),
    ...(l.lobby?.selectors.map(r => tileRect(r.x, r.y, r.w, r.h)) ?? [])];
}
const required = (n: Need, count: number) => n.need === 'all' ? count : Math.min(n.need, count);
const homeKey = (s: ParkState) => { s.key.x = s.key.homeX; s.key.y = s.key.homeY; s.key.carrier = -1; };
const effect = (s: ParkState, kind: FxKind, slot: number) => s.fx.push({ frame: s.frame, kind, slot });
export function parkStep(s: ParkState, l: LevelDef, events: GameEvent[]): void {
  s.fx = [];
  for (const [, slot, kind, bits] of events) {
    const p = s.players[slot];
    if (!p) continue;
    if (kind === 1) s.players[slot] = { ...freshPlayer(l, slot), present: true };
    if (kind === 2) { p.present = false; p.bits = 0; if (s.key.carrier === slot) homeKey(s); }
    if (kind === 3) { p.bits = 0; p.prevBits = 0; p.buffer = 0; p.jumpHeld = false; }
    if (kind === 0 && p.present && !p.entered) p.bits = bits & 63;
  }
  if (s.outcome || s.cleared || s.startReady) { s.frame++; return; }
  const count = s.players.filter(p => p.present).length;
  const living = s.players.filter(alive);
  if (living.length) {
    const left = Math.min(...living.map(p => p.x)), right = Math.max(...living.map(p => p.x + PLAYER_W));
    const target = clamp(Math.trunc((left + right) / 2) - Math.trunc(VIEW_W / 2), 0, l.width * TILE - VIEW_W);
    s.camX = right - VIEW_W > left ? left : clamp(target, right - VIEW_W, left);
  }
  const bs = bodies(s, l), sup = supports(bs), staticTiles = tiles(s, l);
  const startBottom = new Map(bs.map(b => [b, b.y + b.h]));
  const riders = (root: Body) => {
    const group = new Set<Body>([root]);
    for (let n = 0; n < bs.length; n++) for (const b of bs) if (sup.has(b) && group.has(sup.get(b)!)) group.add(b);
    return [...group];
  };
  const blocked = (b: Body, x: number, y: number, group: Body[], dy: number) => {
    const r = { ...b, x, y };
    if (b.kind === 'player' && (x < s.camX || x + b.w > s.camX + VIEW_W)) return true;
    if (x < 0 || x + b.w > l.width * TILE || y < 0) return true;
    if (staticTiles.some(t => overlaps(r, t))) return true;
    if (dy > 0 && l.oneWays.some(t => startBottom.get(b)! <= t.y && overlaps(r, t))) return true;
    return bs.some(q => !group.includes(q) && overlaps(r, q));
  };
  const moveAxis = (root: Body, amount: number, axis: 'x' | 'y', atomic = false): number => {
    const group = riders(root), before = group.map(b => ({ x: b.x, y: b.y }));
    let done = 0;
    while (done !== amount) {
      let step = amount > done ? Math.min(SUB, amount - done) : Math.max(-SUB, amount - done);
      const fits = (d: number) => !group.some(b => blocked(b, b.x + (axis === 'x' ? d : 0), b.y + (axis === 'y' ? d : 0), group, axis === 'y' ? d : 0));
      if (!fits(step)) {
        const sign = step > 0 ? 1 : -1;
        while (step && !fits(step)) step -= sign;
        group.forEach(b => { b[axis] += step; }); done += step;
        if (atomic) { group.forEach((b, i) => Object.assign(b, before[i])); return 0; }
        break;
      }
      group.forEach(b => { b[axis] += step; }); done += step;
    }
    return done;
  };
  const moveMover = (b: Body, dx: number, dy: number) => {
    const group = riders(b), before = group.map(q => ({ x: q.x, y: q.y }));
    if (moveAxis(b, dx, 'x', true) !== dx || moveAxis(b, dy, 'y', true) !== dy) {
      group.forEach((q, i) => Object.assign(q, before[i])); return false;
    }
    return true;
  };
  for (const b of bs.filter(b => b.kind === 'lift' || b.kind === 'mover')) {
    if (b.kind === 'lift') {
      const def = l.liftDefs[b.index], v = s.lifts[b.index];
      const loaded = riders(b).filter(q => q.kind === 'player').length >= required(def, count) && count > 0;
      const end = loaded ? def.dy * TILE : 0, next = v.offset + clamp(end - v.offset, -def.speed * SUB, def.speed * SUB);
      if (moveMover(b, 0, next - v.offset)) v.offset = next;
    } else {
      const def = l.moverDefs[b.index], v = s.movers[b.index], phase = (v.phase + 1) % def.period;
      const half = Math.trunc(def.period / 2), t = phase < half ? phase : def.period - phase;
      const offset = { x: Math.trunc(def.dx * TILE * t / half), y: Math.trunc(def.dy * TILE * t / half) };
      if (moveMover(b, offset.x - v.offset.x, offset.y - v.offset.y)) { v.phase = phase; v.offset = offset; }
    }
  }
  for (const b of bs.filter(b => b.kind === 'box')) {
    const pushers = (dir: number) => {
      const row = new Set<Body>();
      for (let n = 0; n < 4; n++) for (const p of bs.filter(q => q.kind === 'player')) {
        const bits = s.players[p.index].bits;
        if ((bits & 3) !== (dir > 0 ? 2 : 1)) continue;
        if ([b, ...row].some(q => p.y < q.y + q.h && p.y + p.h > q.y && (dir > 0 ? p.x + p.w === q.x : p.x === q.x + q.w))) row.add(p);
      }
      return row.size;
    };
    const right = pushers(1), left = pushers(-1), need = required(l.boxDefs[b.index], count);
    if (right >= need && !left && right) moveAxis(b, SUB, 'x');
    if (left >= need && !right && left) moveAxis(b, -SUB, 'x');
    const v = s.boxes[b.index]; v.vy = Math.min(v.vy + GRAVITY, BOX_MAX_FALL);
    if (moveAxis(b, v.vy, 'y') !== v.vy) v.vy = 0;
  }
  const order = bs.filter(b => b.kind === 'player').sort((a, b) => b.y - a.y || a.index - b.index);
  for (const b of order) {
    const p = s.players[b.index];
    const grounded = blocked(b, b.x, b.y + 1, riders(b), 1);
    p.grounded = grounded; p.coyote = grounded ? COYOTE : Math.max(0, p.coyote - 1);
    p.buffer = (p.bits & 20) && !(p.prevBits & 20) ? JUMP_BUFFER : Math.max(0, p.buffer - 1);
    const dir = (p.bits & 3) === 1 ? -1 : (p.bits & 3) === 2 ? 1 : 0;
    if (dir) { p.vx = clamp(p.vx + dir * (grounded ? ACCEL_GROUND : ACCEL_AIR), -RUN_MAX, RUN_MAX); p.facing = dir; }
    else if (grounded) p.vx -= clamp(p.vx, -FRICTION, FRICTION);
    if (p.buffer && p.coyote) { p.vy = -JUMP_V; p.buffer = 0; p.coyote = 0; p.grounded = false; effect(s, 'jump', b.index); }
    p.jumpHeld = Boolean(p.bits & 20);
    p.vy = Math.min(p.vy + (p.jumpHeld && p.vy < 0 ? GRAVITY_HELD : GRAVITY), MAX_FALL);
    if (moveAxis(b, p.vx, 'x') !== p.vx) p.vx = 0;
    let moved = moveAxis(b, p.vy, 'y');
    if (moved !== p.vy && p.vy < 0) {
      const remainder = p.vy - moved, group = riders(b);
      for (let correction = SUB; correction <= CORNER && moved !== p.vy; correction += SUB) for (const sign of [-1, 1]) {
        if (group.some(q => blocked(q, q.x + correction * sign, q.y, group, 0) || blocked(q, q.x + correction * sign, q.y + remainder, group, remainder))) continue;
        group.forEach(q => { q.x += correction * sign; q.y += remainder; }); moved = p.vy; break;
      }
      if (moved !== p.vy && l.lobby) for (const r of l.lobby.selectors) {
        if (overlaps({ ...b, y: b.y - SUB }, tileRect(r.x, r.y, r.w, r.h))) {
          if (r.kind === 'crew') s.crewBumps++;
          else if (r.kind === 'mode') { if (count === 4) s.teamMode = !s.teamMode; }
          else s.selected = ((s.selected - 1 + r.delta + 8) % 8) + 1; effect(s, 'select', b.index);
        }
      }
    }
    if (moved !== p.vy) { if (p.vy > 0) p.grounded = true; p.vy = 0; }
    p.prevBits = p.bits;
  }
  for (const b of bs) {
    if (b.kind === 'player') Object.assign(s.players[b.index], { x: b.x, y: b.y });
    if (b.kind === 'box') Object.assign(s.boxes[b.index], { x: b.x, y: b.y });
  }
  const die = (slot: number) => {
    const p = s.players[slot]; if (!alive(p)) return;
    p.dead = true; p.respawnIn = RESPAWN; p.vx = 0; p.vy = 0;
    if (s.key.carrier === slot) homeKey(s);
    s.stats[slot].deaths = (s.stats[slot].deaths ?? 0) + 1; effect(s, 'death', slot);
  };
  const safe = (r: Rect, ignore: number) => !tiles(s, l).some(t => overlaps(r, t)) &&
    !bodies(s, l).some(b => !(b.kind === 'player' && b.index === ignore) && overlaps(r, b)) &&
    !l.spikes.some(t => overlaps(r, t)) && !s.enemies.some(e => e.alive && overlaps(r, { ...e, w: TILE, h: TILE }));
  const respawn = (slot: number, pos: Point) => {
    const p = s.players[slot], bits = p.bits;
    Object.assign(p, freshPlayer(l, slot), pos, { present: true, bits, prevBits: bits }); effect(s, 'respawn', slot);
  };
  for (let slot = 0; slot < 4; slot++) {
    const p = s.players[slot];
    if (!p.present) continue;
    if (p.dead) {
      if (--p.respawnIn > 0) continue;
      const others = s.players.filter(alive);
      if (!others.length) { respawn(slot, s.checkpoint); s.camX = clamp(s.checkpoint.x - Math.trunc(VIEW_W / 2), 0, l.width * TILE - VIEW_W); continue; }
      const candidates: Point[] = [];
      if (s.checkpoint.x >= s.camX && s.checkpoint.x + PLAYER_W <= s.camX + VIEW_W) candidates.push(s.checkpoint);
      const near = [...others].sort((a, b) => Math.abs(a.x - s.checkpoint.x) - Math.abs(b.x - s.checkpoint.x))[0];
      for (let i = 0; i < 26; i++) {
        const x = near.x + (i % 2 ? -1 : 1) * Math.trunc((i + 1) / 2) * 12 * SUB;
        if (x >= s.camX && x + PLAYER_W <= s.camX + VIEW_W) candidates.push({ x, y: 0 });
      }
      const pos = candidates.find(pos => safe(playerRect(pos), slot));
      if (pos) respawn(slot, pos);
      else { homeKey(s); s.players.forEach((q, i) => { if (q.present) respawn(i, { x: s.checkpoint.x + i * 12 * SUB, y: s.checkpoint.y }); }); s.camX = clamp(s.checkpoint.x - Math.trunc(VIEW_W / 2), 0, l.width * TILE - VIEW_W); }
      continue;
    }
    if (p.entered) continue;
    const r = playerRect(p);
    l.coinDefs.forEach((c, i) => { if (!s.coinsTaken[i] && overlaps(r, c)) { s.coinsTaken[i] = true; s.coins++; s.stats[slot].coins = (s.stats[slot].coins ?? 0) + 1; effect(s, 'coin', slot); } });
    if (!l.lobby && !s.doorOpen && s.key.carrier < 0 && overlaps(r, { ...s.key, w: TILE, h: TILE })) { s.key.carrier = slot; effect(s, 'key', slot); }
    l.flags.forEach(f => { if (overlaps(r, { ...f, w: TILE, h: PLAYER_H })) s.checkpoint = { ...f }; });
    if (!l.lobby && overlaps(r, l.door)) {
      if (s.key.carrier === slot) { s.keyDoor[slot] = 1; s.doorOpen = true; s.key.carrier = -2; effect(s, 'door', slot); }
      if (s.doorOpen) { p.entered = true; p.bits = 0; p.vx = 0; p.vy = 0; }
    }
    if (p.entered) continue;
    if (p.y >= 12 * TILE || l.spikes.some(t => overlaps(r, t))) { die(slot); continue; }
    for (const e of s.enemies) if (e.alive && overlaps(r, { ...e, w: TILE, h: TILE })) {
      if (p.vy > 0 && p.y + PLAYER_H <= e.y + Math.trunc(Math.trunc(TILE / 2))) { e.alive = false; p.vy = -Math.trunc(JUMP_V * 3 / 5); s.stats[slot].stomps = (s.stats[slot].stomps ?? 0) + 1; effect(s, 'stomp', slot); }
      else die(slot);
    }
  }
  // Walkers move after contacts; they turn before crossing an edge.
  const obstacles = [...tiles(s, l), ...l.oneWays, ...bodies(s, l).filter(b => b.kind !== 'player')];
  for (const e of s.enemies) if (e.alive) {
    const dx = e.dir * 8, next = { ...e, x: e.x + dx, w: TILE, h: TILE };
    const foot = { x: e.dir > 0 ? next.x + TILE - 1 : next.x, y: e.y + TILE, w: 1, h: 1 };
    if (next.x < 0 || next.x + TILE > l.width * TILE || obstacles.some(t => overlaps(next, t)) || !obstacles.some(t => overlaps(foot, t))) e.dir = -e.dir;
    else e.x += dx;
  }
  if (s.key.carrier >= 0) { const p = s.players[s.key.carrier]; s.key.x = p.x; s.key.y = p.y; }
  const nowBodies = bodies(s, l), nowSupports = supports(nowBodies);
  l.buttonDefs.forEach((def, i) => {
    const roots = nowBodies.filter(b => b.y + b.h === def.y + TILE && b.x < def.x + def.w && b.x + b.w > def.x);
    const on = new Set(roots);
    for (let n = 0; n < nowBodies.length; n++) for (const b of nowBodies) if (nowSupports.has(b) && on.has(nowSupports.get(b)!)) on.add(b);
    const weight = [...on].filter(b => b.kind === 'player' || b.kind === 'box').length;
    const button = s.buttons[i], pressed = count > 0 && weight >= required(def, count);
    if (pressed && (def.latch || (def.latchSolo && count === 1))) button.latched = true;
    const next = pressed || button.latched;
    if (next && !button.pressed) effect(s, 'button', i);
    button.pressed = next;
  });
  l.gateDefs.forEach((g, i) => {
    if (l.buttonDefs.some((b, n) => b.group === g.group && s.buttons[n].pressed)) s.gates[i].open = true;
    else if (!nowBodies.some(b => overlaps(b, g))) s.gates[i].open = false;
  });
  for (const [defs, values, solid] of [[l.sDefs, s.sBlocks, count === 1], [l.tDefs, s.tBlocks, count >= 2]] as const)
    defs.forEach((r, i) => { if (!nowBodies.some(b => overlaps(b, r))) values[i] = solid; });
  if (l.lobby) {
    const pad = tileRect(l.lobby.start.x, l.lobby.start.y, l.lobby.start.w, l.lobby.start.h);
    const ready = count > 0 && s.players.filter(p => p.present).every(p => alive(p) && p.grounded && p.y + PLAYER_H === pad.y && p.x < pad.x + pad.w && p.x + PLAYER_W > pad.x);
    s.startHold = ready ? s.startHold + 1 : 0;
    if (s.startHold >= 60) s.startReady = true;
    // standing in the EXIT door for half a second takes you out of the game (the server sees `entered` and lets you go)
    const exit = tileRect(l.lobby.exit.x, l.lobby.exit.y, l.lobby.exit.w, l.lobby.exit.h);
    s.players.forEach((p, slot) => {
      if (!alive(p)) return;
      p.exitHold = p.grounded && overlaps(playerRect(p), exit) ? p.exitHold + 1 : 0;
      if (p.exitHold >= EXIT_HOLD) { p.entered = true; p.bits = 0; p.vx = 0; effect(s, 'door', slot); }
    });
  } else if (count > 0 && s.players.filter(p => p.present).every(p => p.entered)) {
    s.cleared = true; s.clearedAt = s.frame; effect(s, 'clear', -1);
  }
  for (const [slot, p] of s.players.entries()) if (alive(p) && !p.grounded) s.stats[slot].airFrames = (s.stats[slot].airFrames ?? 0) + 1;
  s.frame++;
}

export const hashState = hash;
