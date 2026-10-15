import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLevel, parkInit, parkStep, hashState, SUB, TILE, PLAYER_H, PLAYER_W, VIEW_W, JUMP_V, RESPAWN,
  type LevelDef, type LevelMeta, type ParkState, type Player } from '../../shared/park/sim';
import type { GameEvent } from '../../shared/park/types';

function fixture(items: [number, number, string][] = [], meta: Partial<LevelMeta> = {}): LevelDef {
  const rows: string[][] = Array.from({ length: 12 }, (_, y) => Array.from({ length: 40 }, () => y === 11 ? '#' : '.'));
  rows[10][1] = 'S'; rows[10][36] = 'K'; rows[10][38] = 'D';
  for (const [x, y, chars] of items) for (let i = 0; i < chars.length; i++) rows[y][x + i] = chars[i];
  return parseLevel({ id: 1, name: 'fixture', ...meta, rows: rows.map(r => r.join('')) });
}
function setup(l = fixture(), team = 1) {
  const s = parkInit(l); parkStep(s, l, Array.from({ length: team }, (_, slot) => [0, slot, 1, 0] as GameEvent));
  return s;
}
function step(s: ParkState, l: LevelDef, n = 1, inputs: [number, number][] = []) {
  for (let i = 0; i < n; i++) parkStep(s, l, i === 0 ? inputs.map(([slot, bits]) => [s.frame, slot, 0, bits]) : []);
}
function place(p: Player, x: number, bottom: number, bits = 0) {
  Object.assign(p, { x: x * SUB, y: bottom * SUB - PLAYER_H, vx: 0, vy: 0, bits, prevBits: 0, dead: false, entered: false, grounded: true });
}
const px = (s: ParkState) => s.players.map(p => [p.x / SUB, p.y / SUB]);

test('park determinism: seeded inputs for 10,000 frames, JSON round trips and integer state', () => {
  const l = fixture([[9, 10, 'X1'], [14, 10, 'a'], [18, 10, 'F'], [22, 9, 'M'], [26, 10, 'E'], [29, 9, 'st']], { movers: [{ dx: 3, dy: -2, period: 120 }] });
  const a = parkInit(l), b = parkInit(l); let seed = 19;
  for (let f = 0; f < 10000; f++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const events: GameEvent[] = f === 0 ? [0, 1, 2, 3].map(slot => [0, slot, 1, 0]) : [[f, seed % 4, 0, (seed >>> 8) & 7]];
    parkStep(a, l, events); parkStep(b, l, events);
    assert.equal(hashState(a), hashState(b));
    if (f % 100 === 0) Object.assign(b, JSON.parse(JSON.stringify(b)));
  }
  const visit = (v: unknown) => { if (typeof v === 'number') assert.ok(Number.isSafeInteger(v)); else if (v && typeof v === 'object') Object.values(v).forEach(visit); };
  visit(a);
});
test('park hash covers every state leaf except effects, with fixed field order', () => {
  const l = fixture([[4, 10, 'X1a'], [8, 9, 'LMstCE']], { lifts: [{ need: 2, dy: -2, speed: 1 }], movers: [{ dx: 2, dy: 0, period: 100 }] });
  const s = setup(l, 2), original = hashState(s);
  function visit(value: unknown, path: (string | number)[] = []) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      const copy = structuredClone(s); let target: any = copy;
      for (const k of path.slice(0, -1)) target = target[k];
      target[path.at(-1)!] = typeof value === 'number' ? value + 1 : !value;
      assert.notEqual(hashState(copy), original, path.join('.'));
    } else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (k !== 'fx') visit(v, [...path, k]);
  }
  visit(s);
  s.fx.push({ frame: 1, kind: 'jump', slot: 0 }); assert.equal(hashState(s), original);
  assert.equal(hashState(Object.fromEntries(Object.entries(s).reverse()) as unknown as ParkState), original);
});
test('park physics: recursive head carrying is bottom-up regardless of slot order', () => {
  for (const slots of [[0, 1, 2], [2, 0, 1]]) {
    const l = fixture(), s = setup(l, 3);
    slots.forEach((slot, i) => place(s.players[slot], 50, 176 - i * 20, i === 0 ? 2 : 0));
    const before = s.players.map(p => p.x);
    step(s, l, 1);
    slots.forEach(slot => assert.equal(s.players[slot].x - before[slot], 4));
    slots.forEach((slot, i) => assert.equal(s.players[slot].y + PLAYER_H, (176 - i * 20) * SUB));
  }
});
test('park physics: full jump cannot reach 3 tiles, a two-player stack can', () => {
  const l = fixture(); let heights: number[] = [];
  for (const team of [1, 2]) {
    const s = setup(l, team), jumper = team - 1;
    place(s.players[0], 64, 176);
    if (team === 2) place(s.players[1], 64, 156);
    let bottom = 176 * SUB;
    step(s, l, 1, [[jumper, 4]]);
    for (let f = 0; f < 40; f++) { bottom = Math.min(bottom, s.players[jumper].y + PLAYER_H); step(s, l); }
    heights.push((176 * SUB - bottom) / SUB);
  }
  assert.ok(heights[0] < 48 && heights[0] > 38, `${heights}`); assert.ok(heights[1] > 48, `${heights}`);
});
test('park physics: upward carrying stops the entire stack at a ceiling', () => {
  const l = fixture([[3, 6, 'BBBBBB']]), s = setup(l, 2);
  place(s.players[0], 70, 176); place(s.players[1], 70, 156);
  step(s, l, 12, [[0, 4]]);
  assert.ok(s.players[1].y >= 7 * TILE); assert.equal(s.players[0].y - s.players[1].y, PLAYER_H);
});
test('park physics: coyote, buffered jump, variable height and one-way platforms', () => {
  const l = fixture([[5, 8, '=====']]), s = setup(l);
  place(s.players[0], 84, 128); step(s, l, 2);
  assert.equal(s.players[0].y + PLAYER_H, 128 * SUB);
  place(s.players[0], 60, 176); step(s, l, 1, [[0, 4]]);
  let min = s.players[0].y;
  for (let i = 0; i < 20; i++) { step(s, l); min = Math.min(min, s.players[0].y); }
  assert.ok(min + PLAYER_H < 150 * SUB);
  const c = setup(l); place(c.players[0], 200, 145); c.players[0].coyote = 5;
  step(c, l, 1, [[0, 4]]); assert.ok(c.players[0].vy < 0);
  const b = setup(l); place(b.players[0], 200, 174); b.players[0].vy = 50;
  step(b, l, 1, [[0, 4]]); step(b, l, 2); assert.ok(b.players[0].vy < 0);
  const through = setup(l); place(through.players[0], 84, 165); through.players[0].vy = -JUMP_V;
  step(through, l, 12, [[0, 4]]); assert.ok(through.players[0].y + PLAYER_H < 8 * TILE);
});
test('park physics: camera edges block players and contain everyone', () => {
  const l = fixture(), s = setup(l, 2);
  place(s.players[0], 0, 176); place(s.players[1], 310, 176);
  step(s, l, 80, [[0, 1], [1, 2]]);
  for (const p of s.players.filter(p => p.present)) { assert.ok(p.x >= s.camX); assert.ok(p.x + PLAYER_W <= s.camX + VIEW_W); }
  assert.equal(s.players[0].x, 0); assert.equal(s.players[1].x + PLAYER_W, VIEW_W);
});
test('park elements: key ownership, death/leave home, door and all-player clear', () => {
  const l = fixture(), s = setup(l, 2);
  place(s.players[0], 576, 176); place(s.players[1], 556, 176); step(s, l);
  assert.equal(s.key.carrier, 0);
  parkStep(s, l, [[s.frame, 0, 2, 0]]); assert.equal(s.key.carrier, -1); assert.equal(s.key.x, s.key.homeX);
  const a = setup(l, 2); place(a.players[0], 576, 176); step(a, l); place(a.players[0], 576, 220); step(a, l);
  assert.ok(a.players[0].dead); assert.equal(a.key.carrier, -1);
  const b = setup(l, 2); place(b.players[0], 576, 176); place(b.players[1], 556, 176); step(b, l);
  place(b.players[0], 608, 176); step(b, l); assert.ok(b.doorOpen); assert.ok(b.players[0].entered); assert.ok(!b.cleared);
  place(b.players[1], 608, 176); step(b, l); assert.ok(b.cleared);
  const old = structuredClone(b); step(b, l, 20); assert.deepEqual({ ...b, frame: old.frame, fx: old.fx }, old);
});
test('park elements: weighted buttons count 1/2/4 stacks, latch and latchSolo', () => {
  for (const team of [1, 2, 4]) {
    const l = fixture([[5, 10, '1'], [12, 10, 'a']], { buttons: { '1': { need: 'all' } } }), s = setup(l, team);
    for (let slot = 0; slot < team; slot++) place(s.players[slot], 82, 176 - slot * 20);
    step(s, l); assert.ok(s.buttons[0].pressed); assert.ok(s.gates[0].open);
    place(s.players[team - 1], 120, 176); step(s, l); assert.ok(!s.buttons[0].pressed);
  }
  for (const latch of [{ latch: true }, { latchSolo: true }]) {
    const l = fixture([[5, 10, '1']], { buttons: { '1': { need: 1, ...latch } } }), s = setup(l);
    place(s.players[0], 82, 176); step(s, l); place(s.players[0], 120, 176); step(s, l);
    assert.ok(s.buttons[0].pressed && s.buttons[0].latched);
  }
});
test('park elements: button groups OR; open gate waits until no body overlaps', () => {
  const l = fixture([[5, 10, '1'], [10, 10, '1'], [15, 10, 'a']]), s = setup(l, 2);
  place(s.players[0], 162, 176); place(s.players[1], 200, 176); step(s, l); assert.ok(s.gates[0].open);
  place(s.players[0], 242, 176); step(s, l); assert.ok(s.gates[0].open);
  place(s.players[0], 270, 176); step(s, l); assert.ok(!s.gates[0].open);
});
test('park elements: heavy box chain push, opposite push blocks, pit bridge and leave drops need', () => {
  const l = fixture([[8, 10, 'X'], [10, 11, '..']], { boxes: [{ need: 'all' }] }), s = setup(l, 2);
  place(s.players[0], 118, 176, 2); place(s.players[1], 108, 176, 2);
  step(s, l); assert.equal(s.boxes[0].x, 128 * SUB + SUB);
  const a = setup(l, 2); place(a.players[0], 118, 176, 2); place(a.players[1], 144, 176, 1);
  step(a, l); assert.equal(a.boxes[0].x, 128 * SUB);
  a.players[1].bits = 0; parkStep(a, l, [[a.frame, 1, 2, 0]]); assert.equal(a.boxes[0].x, 129 * SUB);
  const pit = fixture([[8, 10, 'X'], [8, 11, '.']]), b = setup(pit);
  step(b, pit, 10); assert.ok(b.boxes[0].y > 160 * SUB);
});
test('park elements: lift counts stacked riders and carries; moving platform triangle wave and obstruction', () => {
  const l = fixture([[7, 10, 'L']], { lifts: [{ need: 'all', dy: -3, speed: 1 }] }), s = setup(l, 2);
  place(s.players[0], 120, 160); place(s.players[1], 120, 140); step(s, l, 8);
  assert.equal(s.lifts[0].offset, -8 * SUB); assert.equal(s.players[1].y + PLAYER_H, 132 * SUB);
  place(s.players[1], 180, 176); step(s, l); assert.equal(s.lifts[0].offset, -7 * SUB);
  const m = fixture([[7, 9, 'M']], { movers: [{ dx: 2, dy: 0, period: 64 }] }), a = setup(m);
  place(a.players[0], 120, 144); const before = a.movers[0].offset.x; step(a, m, 16);
  assert.equal(a.movers[0].offset.x - before, TILE); assert.equal(a.players[0].x, 136 * SUB);
  const blocked = fixture([[7, 9, 'M'], [10, 9, 'B']], { movers: [{ dx: 2, dy: 0, period: 64 }] }), b = setup(blocked);
  assert.equal(b.movers[0].phase, 0); step(b, blocked, 20); assert.equal(b.movers[0].phase, 0);
});
test('park elements: walkers turn at ledges; stomp bounces, side contact kills', () => {
  const l = fixture([[8, 10, 'E']]), s = setup(l);
  place(s.players[0], 128, 162); s.players[0].vy = 40; step(s, l);
  assert.ok(!s.enemies[0].alive); assert.equal(s.players[0].vy, -Math.trunc(JUMP_V * 3 / 5));
  const b = setup(l); place(b.players[0], 128, 176); step(b, l); assert.ok(b.players[0].dead);
  const edge = fixture([[8, 10, 'E'], [9, 11, '.']]), a = setup(edge);
  step(a, edge, 40); assert.ok(a.enemies[0].x < 144 * SUB);
});
test('park elements: respawn timer, total wipe and safe teammate candidates', () => {
  const l = fixture(), s = setup(l, 2);
  place(s.players[0], 100, 220); place(s.players[1], 120, 220); step(s, l);
  assert.equal(s.players[0].respawnIn, RESPAWN); step(s, l, RESPAWN);
  assert.ok(s.players.every(p => !p.present || !p.dead)); assert.ok(s.players[0].x >= s.camX);
  assert.ok(s.players[0].x !== s.players[1].x || s.players[0].y !== s.players[1].y);
  const a = setup(l, 2); place(a.players[0], 100, 220); place(a.players[1], 250, 176); a.checkpoint.x = 550 * SUB;
  step(a, l, RESPAWN + 1); assert.ok(!a.players[0].dead); assert.ok(a.players[0].x >= a.camX && a.players[0].x + PLAYER_W <= a.camX + VIEW_W);
});
test('park elements: s/t solidity waits for overlap to clear and follows membership', () => {
  const l = fixture([[5, 10, 's'], [8, 10, 't']]), s = setup(l, 2);
  place(s.players[0], 80, 176); parkStep(s, l, [[s.frame, 1, 2, 0]]); assert.ok(!s.sBlocks[0]);
  place(s.players[0], 180, 176); step(s, l); assert.ok(s.sBlocks[0]); assert.ok(!s.tBlocks[0]);
});

import { Runner } from '../../shared/park/runner';
import type { ParkIncoming, ParkOutgoing, PublicSession } from '../../shared/park/types';
class Sequencer {
  now = 0; startAt = 0; epoch = 1; level = fixture(); sim = parkInit(this.level);
  events: GameEvent[] = [[0, 0, 1, 0], [0, 1, 1, 0]];
  players = [{ userId: 'A', slot: 0 }, { userId: 'B', slot: 1 }];
  runners: Runner[] = []; out: { runner: Runner; msg: ParkOutgoing }[] = []; last = [0, 0, 0, 0];
  snapshot(): PublicSession { return { cabinet: 'cabinet', epoch: this.epoch, phase: 'level', level: 1, startAt: this.startAt, serverNow: this.now,
    players: structuredClone(this.players), spectators: ['watch'], teamSize: 2, snapshot: structuredClone(this.sim), events: this.events.filter(e => e[0] >= this.sim.frame) }; }
  runner(userId = 'A') {
    let r: Runner;
    r = new Runner({ userId, now: () => this.now, levels: [this.level, this.level], transport: { send: msg => this.out.push({ runner: r, msg }) } });
    this.runners.push(r); r.receive({ t: 'game_session', session: this.snapshot() }); return r;
  }
  event(ev: GameEvent, except?: Runner) {
    if (ev[2] === 2 || ev[2] === 3) this.events = this.events.filter(e => !(e[1] === ev[1] && e[2] === 0 && e[0] >= ev[0]));
    this.events.push(ev); for (const r of this.runners) if (r !== except) r.receive({ t: 'game_event', epoch: this.epoch, ev });
  }
  flush(retime = 0) {
    const out = this.out; this.out = [];
    for (const { runner, msg } of out) {
      if (msg.t === 'game_sync') { runner.receive({ t: 'game_session', session: this.snapshot() }); continue; }
      const slot = runner.slot!;
      const frame = Math.max(msg.frame + retime, this.sim.frame, this.last[slot]); this.last[slot] = frame;
      const ev: GameEvent = [frame, slot, 0, msg.bits]; this.events.push(ev);
      for (const r of this.runners) r.receive({ t: 'game_event', epoch: this.epoch, ev, ...(r === runner ? { seq: msg.seq } : {}) });
    }
  }
  advance(frames: number, tick = true) {
    this.now += frames * 1000 / 60;
    const target = Math.floor((this.now - this.startAt) * 60 / 1000) - 6;
    while (this.sim.frame <= target) parkStep(this.sim, this.level, this.events.filter(e => e[0] === this.sim.frame));
    if (tick) this.runners.forEach(r => r.tick());
  }
  assertSettled(r: Runner) {
    const f = Math.min(this.sim.frame, r.state!.frame);
    assert.equal(hashState(r.stateAt(f)!), hashState(this.sim), `frame ${f}`);
    assert.equal(r.provisionalCount, 0);
  }
}
test('park runner: late remote event rolls back, including fallback beyond 180-frame ring', () => {
  for (const late of [30, 220]) {
    const q = new Sequencer(), a = q.runner(); q.event([4, 1, 0, 2], a); q.advance(late);
    a.receive({ t: 'game_event', epoch: 1, ev: [4, 1, 0, 2] }); q.advance(20); a.tick(); q.assertSettled(a);
    assert.ok(a.debug.rollbacks > 0); assert.ok(a.debug.maxRollback >= late - 5);
  }
});
test('park runner: retimed own echo removes prediction and settles without duplicated fx', () => {
  const q = new Sequencer(), a = q.runner(); a.setLocalBits(6); a.tick(); q.advance(25);
  q.flush(12); a.setLocalBits(0); q.advance(30); q.flush(); q.advance(20); q.assertSettled(a);
  assert.ok(a.debug.rollbacks); assert.equal(a.debug.desyncs, 0);
  const fx = a.drainFx(); assert.equal(new Set(fx.map(f => `${f.frame}:${f.kind}:${f.slot}`)).size, fx.length);
});
test('park runner: reset and leave purge queued slot inputs before slot reuse', () => {
  for (const kind of [2, 3] as const) {
    const q = new Sequencer(), a = q.runner(); q.event([50, 1, 0, 2]);
    q.event([10, 1, kind, 0]);
    if (kind === 2) q.event([12, 1, 1, 0]);
    q.event([65, 1, 0, 1]); q.advance(85); q.assertSettled(a);
    assert.equal(a.stateAt(60)!.players[1].bits, 0);
  }
});
test('park runner: countdown input is sent at frame 2 and new session resends held buttons', () => {
  const q = new Sequencer(); q.startAt = 3000; const a = q.runner();
  a.setLocalBits(2); a.tick(); assert.equal(a.state!.frame, 0); assert.equal(a.presentation.countdown, 3);
  assert.equal(q.out[0].msg.t, 'game_input'); assert.equal((q.out[0].msg as Extract<ParkOutgoing, { t: 'game_input' }>).frame, 2);
  q.flush(); q.advance(210); q.assertSettled(a);
  a.receive({ t: 'game_session', session: q.snapshot() }); a.tick(); assert.equal(q.out.length, 0);
  const fresh = q.snapshot(); fresh.epoch++; fresh.snapshot = parkInit(q.level); fresh.events = [[0, 0, 1, 0], [0, 1, 1, 0]];
  a.receive({ t: 'game_session', session: fresh }); a.tick(); assert.ok(q.out.some(e => e.msg.t === 'game_input'));
});
test('park runner: >300 frames behind requests one sync and recovers on snapshot', () => {
  const q = new Sequencer(), a = q.runner(); q.advance(400, false); a.tick(); a.tick();
  assert.equal(a.debug.syncs, 1); q.flush(); q.advance(20); q.assertSettled(a);
});
test('park runner: spectator Joining state, delay and queued epoch messages', () => {
  const q = new Sequencer(); q.advance(60); const a = q.runner('watch');
  assert.ok(a.presentation.joining); assert.equal(a.presentation.state, null);
  q.advance(10); assert.ok(!a.presentation.joining); assert.ok(a.state!.frame <= a.targetFrame);
  const old = a.session!.epoch, next = q.snapshot(); next.epoch++; next.startAt = q.now + 3000; next.snapshot = parkInit(q.level); next.events = [[0, 0, 1, 0]];
  a.receive({ t: 'game_session', session: next });
  a.receive({ t: 'game_event', epoch: next.epoch, ev: [2, 0, 0, 2] });
  q.advance(8); assert.equal(a.session!.epoch, old);
  q.advance(2); assert.equal(a.session!.epoch, next.epoch); assert.equal(a.presentation.countdown, 3);
  q.advance(200); assert.equal(a.state!.players[0].bits, 2);
});
test('park runner: desync checks wait for echoes, mismatch/expired checks sync once', () => {
  const q = new Sequencer(), a = q.runner(); a.setLocalBits(2); a.tick(); q.advance(70);
  const check: ParkIncoming = { t: 'game_check', epoch: 1, frame: 60, hash: 123, serverNow: q.now };
  a.receive(check); assert.equal(a.debug.desyncs, 0); assert.equal(a.debug.syncs, 0);
  q.flush(10); a.tick(); assert.equal(a.debug.desyncs, 1); assert.equal(a.debug.syncs, 1);
  a.receive(check); assert.equal(a.debug.syncs, 1);
  q.flush(); q.advance(700); // an expired check is not silently ignored
  a.receive({ ...check, frame: 0 }); assert.ok(a.debug.desyncs >= 2);
});
test('park runner: clock uses best recent sample, slews 2 ms and jumps over 250 ms', () => {
  const q = new Sequencer(), a = q.runner();
  const before = a.targetFrame;
  a.receive({ t: 'game_check', epoch: 1, frame: 9999, hash: 0, serverNow: q.now + 200 }); a.tick();
  assert.ok(a.targetFrame - before <= 1);
  a.receive({ t: 'game_check', epoch: 1, frame: 9999, hash: 0, serverNow: q.now + 1000 }); a.tick();
  assert.ok(a.targetFrame >= before + 59);
});

import { LEVELS } from '../../shared/park/levels';
import { SOLUTIONS, LOBBY_SOLUTIONS, type RecordedSolution } from '../../shared/park/solutions';
function replay(l: LevelDef, team: number, script: RecordedSolution) {
  assert.ok(script.frames <= 7200 && script.frames > 0);
  let previous = -1;
  for (const [f, slot, bits] of script.inputs) {
    assert.ok(Number.isInteger(f) && f >= previous && f < script.frames); previous = f;
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot < team); assert.ok(Number.isInteger(bits) && bits >= 0 && bits <= 7);
  }
  const s = parkInit(l), selected = new Set<number>([s.selected]); let index = 0;
  const effects = new Map<string, number>(), pressed = new Set<number>(), ridden = new Set<number>();
  const liftTop = l.liftDefs.map(() => 0), furthest = Array(team).fill(l.spawn.x); let stacks = 0;
  for (let f = 0; f < script.frames; f++) {
    const events: GameEvent[] = f === 0 ? Array.from({ length: team }, (_, slot) => [f, slot, 1, 0]) : [];
    while (index < script.inputs.length && script.inputs[index][0] === f) {
      const [frame, slot, bits] = script.inputs[index++]; events.push([frame, slot, 0, bits]);
    }
    parkStep(s, l, events); selected.add(s.selected);
    s.fx.forEach(fx => effects.set(fx.kind, (effects.get(fx.kind) ?? 0) + 1));
    s.buttons.forEach((b, i) => { if (b.pressed) pressed.add(i); });
    s.lifts.forEach((v, i) => { liftTop[i] = Math.min(liftTop[i], v.offset); });
    for (const p of s.players.filter(p => p.present && !p.dead && !p.entered)) {
      if (s.players.some(q => q !== p && q.present && p.y + PLAYER_H === q.y && p.x < q.x + PLAYER_W && p.x + PLAYER_W > q.x)) stacks++;
      s.movers.forEach((m, i) => {
        const def = l.moverDefs[i];
        if (p.y + PLAYER_H === def.y + m.offset.y && p.x < def.x + m.offset.x + def.w && p.x + PLAYER_W > def.x + m.offset.x) ridden.add(i);
      });
    }
    for (const [slot, p] of s.players.entries()) {
      if (!p.present || p.dead || p.entered) continue;
      if (!l.lobby) {
        furthest[slot] = Math.max(furthest[slot], p.x);
        assert.ok(furthest[slot] - p.x <= 10 * TILE, `backtracking at ${f}: ${px(s)}`);
      }
      assert.ok(p.x >= s.camX && p.x + PLAYER_W <= s.camX + VIEW_W, `camera at ${f}: ${px(s)}`);
    }
  }
  return { s, selected, effects, pressed, ridden, liftTop, stacks };
}
test('park levels: level lint — compact forward routes, terrain, rewards and recovery', () => {
  assert.equal(LEVELS.length, 9);
  for (const l of LEVELS) {
    assert.deepEqual(parseLevel({ ...l }), l); assert.equal(l.rows.length, 12);
    assert.equal(l.rows.join('').split('S').length, 2);
    if (l.lobby) {
      assert.equal(l.width, 20);
      for (const c of ['K', 'D']) assert.ok(!l.rows.join('').includes(c));
      assert.ok(l.key.x < 0 && l.key.y < 0); assert.equal(l.door.w * l.door.h, 0);
      continue;
    }
    const label = `${l.id}: ${l.name}`;
    assert.ok(l.width >= 40 && l.width <= (l.id === 8 ? 100 : 90), label);
    for (const c of ['K', 'D']) assert.equal(l.rows.join('').split(c).length, 2, label);
    assert.ok(l.spawn.x / TILE < 4, label);
    assert.ok(l.door.x / TILE >= l.width - 12, label);
    assert.ok(l.key.x / TILE >= Math.floor(l.width / 3), label);
    assert.ok(l.key.x <= l.door.x + 10 * TILE, `${label}: key backtrack`);
    let empty = 0;
    for (let x = 0; x < l.width; x++) {
      empty = l.rows.slice(0, 11).every(row => row[x] === '.') && l.rows[11][x] === '#' ? empty + 1 : 0;
      assert.ok(empty <= 7, `${label}: empty stretch ending at ${x}`);
    }
    assert.ok([...l.solids, ...l.oneWays].some(r => r.y >= 3 * TILE && r.y <= 9 * TILE), `${label}: height`);
    assert.ok(l.oneWays.length || l.solids.some(r => r.y < 10 * TILE && !l.solids.some(b => b.x === r.x && b.y === r.y + TILE)), `${label}: platforms`);
    const pits = l.rows[11].match(/\.+/g) ?? [];
    assert.ok(pits.length > 0 && pits.every(pit => pit.length >= 2 && pit.length <= 3), `${label}: small death pits`);
    assert.ok(l.coinDefs.length >= 8 && l.coinDefs.length <= 15, `${label}: coins`);
    assert.ok(l.coinDefs.every(c => c.y <= 9 * TILE), `${label}: no floor coin line`);
    assert.ok(new Set(l.coinDefs.map(c => c.y)).size >= 2, `${label}: coin arcs`);
    if (l.width > 50) {
      // ~30 columns includes the approach and the last leg, not just flag-to-flag gaps.
      const recovery = [0, ...l.flags.map(f => f.x / TILE).sort((a, b) => a - b), l.width];
      assert.ok(l.flags.length > 0, `${label}: checkpoint`);
      for (let i = 1; i < recovery.length; i++) assert.ok(recovery[i] - recovery[i - 1] <= 34, `${label}: recovery gap`);
    }
  }
  assert.throws(() => parseLevel({ id: 1, name: 'bad', rows: ['S.K.D'] }));
  const noObjectives = { ...LEVELS[0], lobby: undefined };
  assert.throws(() => parseLevel(noObjectives), /one K/);
  for (const c of ['S', 'K', 'D']) {
    const rows = [...LEVELS[0].rows]; rows[0] = c + c + '.'.repeat(18);
    assert.throws(() => parseLevel({ ...LEVELS[0], rows }), new RegExp(`one ${c}`));
  }
});
test('park levels: teaching beats retain their cooperative mechanisms', () => {
  assert.deepEqual(LEVELS.slice(1).map(l => l.name), ['First Steps', 'Heavy Lifting', 'Going Up', 'Hold the Door', 'Human Tower', 'Spike Garden', 'Key Relay', 'Grand Finale']);
  assert.ok(LEVELS[1].sDefs.length >= 2);
  assert.equal(LEVELS[2].boxDefs.length, 2); assert.ok(LEVELS[2].boxDefs.every(b => b.need === 'all'));
  assert.equal(LEVELS[3].liftDefs[0].need, 'all'); assert.equal(LEVELS[3].enemyDefs.length, 2);
  const relay = LEVELS[4].buttonDefs.filter(b => b.group === 0);
  assert.equal(relay.length, 2); assert.ok(relay.some(b => b.latchSolo));
  assert.ok(LEVELS[4].buttonDefs.some(b => b.group === 1 && b.need === 2));
  assert.ok(LEVELS[5].sDefs.length && LEVELS[5].tDefs.length);
  assert.ok(LEVELS[6].moverDefs.some(m => m.dx && !m.dy)); assert.ok(LEVELS[6].moverDefs.some(m => m.dy && !m.dx));
  assert.ok(LEVELS[6].oneWays.length); assert.equal(LEVELS[6].flags.length, 2);
  const keyRelay = LEVELS[7], outside = keyRelay.buttonDefs.find(b => b.latchSolo)!;
  assert.ok(keyRelay.gateDefs[0].x - outside.x >= 8 * TILE);
  assert.ok(keyRelay.buttonDefs.some(b => b.x > keyRelay.gateDefs[0].x));
  const finale = LEVELS[8];
  assert.ok(finale.boxDefs.length && finale.liftDefs.length && finale.gateDefs.length && finale.moverDefs.length && finale.enemyDefs.length && finale.sDefs.length);
  assert.equal(finale.flags.length, 2);
});
for (let level = 1; level <= 8; level++) for (let team = 1; team <= 4; team++) {
  test(`park recorded solution: ${LEVELS[level].name}, ${team} player(s)`, () => {
    const l = LEVELS[level], { s, effects, pressed, ridden, liftTop, stacks } = replay(l, team, SOLUTIONS[level][team]);
    assert.equal(effects.get('death') ?? 0, 0, 'recordings must demonstrate the route without death shortcuts');
    assert.equal(pressed.size, l.buttonDefs.length, 'use every button in the puzzle');
    assert.equal(ridden.size, l.moverDefs.length, 'ride every moving platform');
    l.liftDefs.forEach((def, i) => assert.equal(liftTop[i], def.dy * TILE, 'fully raise every lift'));
    if (l.enemyDefs.length) assert.equal(effects.get('stomp'), l.enemyDefs.length, 'demonstrate walker stomps');
    if (team > 1 && [1, 4, 5, 8].includes(level)) assert.ok(stacks > 0, 'demonstrate head boosting');
    if (level === 2 || level === 8) l.boxDefs.forEach((def, i) => assert.ok(s.boxes[i].x - def.x >= TILE, 'push each heavy box'));
    if (team === 2) assert.ok(s.clearedAt >= 20 * 60 && s.clearedAt <= 75 * 60, 'two-player target: 20–75 seconds');
    assert.ok(s.cleared); assert.ok(s.clearedAt < SOLUTIONS[level][team].frames);
    assert.ok(s.players.filter(p => p.present).every(p => p.entered));
  });
}
for (let team = 1; team <= 4; team++) test(`park lobby recording: both selectors and START, ${team} player(s)`, () => {
  const { s, selected } = replay(LEVELS[0], team, LOBBY_SOLUTIONS[team]);
  assert.ok(selected.has(8) && selected.has(1)); assert.ok(s.startReady); assert.equal(s.startHold, 60);
  const old = structuredClone(s); step(s, LEVELS[0], 10); assert.deepEqual({ ...s, frame: old.frame, fx: old.fx }, old);
});

test('lobby EXIT door: half a second standing in it takes the player out; stepping out resets the hold', () => {
  const l = LEVELS[0], s = parkInit(l), exit = l.lobby!.exit;
  parkStep(s, l, [[0, 0, 1, 0], [0, 1, 1, 0]]);
  for (const [slot, x] of [[0, exit.x * 16 + 3], [1, 40]] as const) Object.assign(s.players[slot], { x: x * SUB, y: (exit.y + exit.h) * TILE - PLAYER_H, vx: 0, vy: 0 });
  for (let i = 0; i < 29; i++) parkStep(s, l, []);
  assert.equal(s.players[0].entered, false); assert.equal(s.players[0].exitHold, 29);
  s.players[0].x -= 3 * TILE; parkStep(s, l, []);
  assert.equal(s.players[0].exitHold, 0);
  s.players[0].x += 3 * TILE;
  for (let i = 0; i < 30; i++) parkStep(s, l, []);
  assert.equal(s.players[0].entered, true); assert.equal(s.players[1].entered, false);
  assert.equal(s.startReady, false);
});
