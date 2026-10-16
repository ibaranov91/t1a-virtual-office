import test from 'node:test';
import assert from 'node:assert/strict';
import { crumble, type CrumbleState } from '../../shared/arcade/games/crumble';
import { crown, type CrownState } from '../../shared/arcade/games/crown';
import { park } from '../../shared/arcade/games/park';
import { hub, HUB_LEVEL, PARTY_PAD, COOP_PAD } from '../../shared/arcade/hub';
import { vote } from '../../shared/arcade/vote';
import { GAMES, gameDef } from '../../shared/arcade/registry';
import { hash } from '../../shared/arcade/hash';
import { Runner } from '../../shared/arcade/runner';
import { SUB, TILE, PLAYER_H, PLAYER_W } from '../../shared/arcade/arena';
import type { BaseState, GameEvent, GameId, PublicSession, RosterEntry } from '../../shared/arcade/types';
import { SOLUTIONS } from '../../shared/park/solutions';
const roster = (n: number, teams = false): RosterEntry[] => Array.from({ length: n }, (_, slot) => ({ slot, userId: `p${slot}`, team: teams ? slot % 2 as 0 | 1 : null }));
const joins = (r: RosterEntry[]): GameEvent[] => r.map(p => [0, p.slot, 1, 0]);
function checkIntegers(v: unknown) { if (typeof v === 'number') assert.ok(Number.isSafeInteger(v)); else if (v && typeof v === 'object') Object.values(v).forEach(checkIntegers); }
function bots(game: 'crumble' | 'crown', s: CrumbleState | CrownState): GameEvent[] {
  return s.players.flatMap((p, slot): GameEvent[] => {
    if (!p.present || !p.alive) return [];
    if (game === 'crumble') return [[s.frame, slot, 0, (s.frame + slot * 13) % 120 < 60 ? 2 | (s.frame % 90 < 20 ? 16 : 0) : 1 | (s.frame % 90 === 30 ? 32 : 0)]];
    const target = 155 * SUB, dx = target - p.x;
    return [[s.frame, slot, 0, (Math.abs(dx) < 2 * SUB ? 0 : dx < 0 ? 1 : 2) | (s.frame % (90 + slot * 7) < 18 ? 16 : 0) | (slot && s.frame % 120 === 0 ? 32 : 0)]];
  });
}
for (const id of ['crumble', 'crown'] as const) for (const [n, teams] of [[2, false], [3, false], [4, false], [4, true]] as const) {
  test(`${id}: seeded ${n}${teams ? ' 2v2' : ' FFA'} bots, JSON determinism, integer state and terminal outcome`, () => {
    const def = gameDef(id), r = roster(n, teams), a = def.init(89, r, { mode: teams ? '2v2' : 'ffa' }) as CrumbleState | CrownState;
    let b = structuredClone(a);
    while (!a.outcome && a.frame < 5400) {
      const events = [...(a.frame === 0 ? joins(r) : []), ...bots(id, a)];
      def.step(a, events); def.step(b, events);
      if (a.frame % 30 === 0) { assert.equal(hash(a), hash(b)); b = JSON.parse(JSON.stringify(b)); }
    }
    assert.ok(a.outcome); assert.ok(a.frame <= 5400); assert.deepEqual(a.outcome.order.flat().sort(), r.map(p => p.slot));
    if (teams) assert.ok(a.outcome.order.length <= 2);
    checkIntegers(a);
    const outcome = structuredClone(a.outcome), before = structuredClone(a);
    def.step(a, [[a.frame, 0, 3, 0]]); assert.deepEqual(a.outcome, outcome);
    assert.equal(a.frame, before.frame + 1); assert.equal(def.bits(a, 0), 0);
    assert.equal(a.players[0].x, before.players[0].x);
  });
  test(`${id}: ${n}${teams ? ' 2v2' : ' FFA'} delayed input rolls back to the authoritative hash`, () => {
    const r = roster(n, teams), def = gameDef(id), initial = def.init(91, r, { mode: teams ? '2v2' : 'ffa' });
    let now = 0;
    const runner = new Runner({ userId: 'watch', now: () => now, transport: { send() {} } });
    const session: PublicSession = { cabinet: 'a', epoch: 1, serverNow: 0, players: r, spectators: ['watch'], crew: { key: 'r', name: 'Test' }, set: null,
      view: { kind: 'sim', game: id, seed: 91, opts: {}, roster: r, startAt: 0, snapshot: structuredClone(initial), events: joins(r) } };
    runner.receive({ t: 'game_session', session });
    const log: GameEvent[] = [...joins(r), [3, 0, 0, 2 | 16], [40, 1, 0, 1 | 32], [90, 0, 3, 0], [100, 0, 0, 16]];
    for (let frame = 0; frame < 240; frame++) {
      now = frame * 1000 / 60;
      def.step(initial, log.filter(e => e[0] === frame));
      for (const ev of log.filter(e => e[2] !== 1 && e[0] + 22 === frame)) runner.receive({ t: 'game_event', epoch: 1, ev });
      runner.tick();
    }
    const common = runner.state!.frame, sim = def.init(91, r, {});
    while (sim.frame < common) def.step(sim, log.filter(e => e[0] === sim.frame));
    assert.equal(hash(runner.state), hash(sim)); assert.ok(runner.debug.rollbacks > 0); assert.equal(runner.debug.desyncs, 0);
  });
}
test('crumble: cracks stay solid for CRUMBLE_DELAY frames; pound breaks centre and neighbours once', async () => {
  const s = crumble.init(1, roster(2), { mode: 'ffa' });
  for (const p of s.players.filter(p => p.present)) p.x = 5 * TILE;
  crumble.step(s, joins(roster(2)));
  const t = s.tiles.find(t => t.x === 5 && t.y === 2)!; assert.equal(t.crackAt, 0);
  const { CRUMBLE_DELAY } = await import('../../shared/arcade/games/crumble');
  while (s.frame < CRUMBLE_DELAY) crumble.step(s, []); assert.equal(t.gone, false);
  crumble.step(s, []); assert.equal(t.gone, true);
  const q = crumble.init(3, roster(2), { mode: 'ffa' }), p = q.players[0]; p.x = 8 * TILE; p.y = 3 * TILE; p.grounded = false; p.vy = 0;
  crumble.step(q, [[0, 0, 0, 32]]);
  while (p.y + PLAYER_H < 5 * TILE && !q.outcome) crumble.step(q, []);
  assert.equal(q.tiles.filter(t => t.y === 5 && [7, 8, 9].includes(t.x) && t.gone).length, 3);
  assert.ok((p.stats.tiles ?? 0) >= 3); assert.equal(q.pounding[0], false);
});
test('crumble: same-frame falls tie; a leaving team loses at once; resets preserve positions and stats', () => {
  const s = crumble.init(0, roster(3), { mode: 'ffa' }); s.players[0].y = s.players[1].y = 200 * SUB;
  crumble.step(s, []); assert.deepEqual(s.outcome!.order, [[2], [0, 1]]);
  const q = crumble.init(0, roster(4, true), { mode: '2v2' });
  crumble.step(q, [[0, 0, 2, 0], [0, 2, 2, 0]]); assert.deepEqual(q.outcome!.order[0], [1, 3]);
  const before = structuredClone(q.players[1]); crumble.step(q, [[q.frame, 1, 3, 0]]);
  assert.deepEqual(q.players[1].stats, before.stats); assert.equal(q.players[1].x, before.x);
});
test('crown: deterministic lowest-slot steal, stun, invulnerability, holder speed and no holder tackle', () => {
  const s = crown.init(0, roster(3), { mode: 'ffa' });
  s.players.forEach(p => { p.x = 155 * SUB; p.y = 8 * TILE - PLAYER_H; p.grounded = true; });
  crown.step(s, []); assert.equal(s.holder, 0);
  crown.step(s, [[1, 0, 0, 2 | 32], [1, 1, 0, 32], [1, 2, 0, 32]]);
  assert.equal(s.holder, 1); assert.equal(s.stun[0], 30); assert.equal(s.immune, 30); assert.equal(s.dash[0], 0); assert.equal(s.players[1].stats.steals, 1);
  const old = s.holder; crown.step(s, []); assert.equal(s.holder, old);
  for (let i = 0; i < 20; i++) crown.step(s, [[s.frame, 1, 0, 2 | 32]]);
  assert.ok(s.players[1].vx <= Math.trunc(32 * 85 / 100)); assert.equal(s.dash[1], 0);
});
test('crown: fall respawns after 60 frames with buttons; leave drops stapler; teams sum time and cap draws', () => {
  const s = crown.init(2, roster(2), { mode: 'ffa' }); s.holder = 0; s.players[0].y = 200 * SUB;
  crown.step(s, [[0, 0, 0, 2]]); assert.equal(s.holder, -1); assert.equal(s.returnIn, 60); assert.equal(s.respawn[0], 60);
  for (let i = 0; i < 59; i++) crown.step(s, []); assert.equal(s.players[0].alive, false);
  crown.step(s, []); assert.equal(s.players[0].alive, true); assert.equal(s.players[0].bits, 2);
  s.holder = 0; crown.step(s, [[s.frame, 0, 2, 0]]); assert.equal(s.holder, -1); assert.equal(s.outcome!.order[0][0], 1);
  const t = crown.init(1, roster(4, true), { mode: '2v2' }); t.players[0].stats.holdFrames = 600; t.players[2].stats.holdFrames = 599; t.holder = 2;
  crown.step(t, []); assert.deepEqual(t.outcome!.order[0], [0, 2]);
  const cap = crown.init(0, roster(2), { mode: 'ffa' }); cap.frame = 5399; crown.step(cap, []); assert.deepEqual(cap.outcome!.order, [[0, 1]]);
});
test('hub: two pads need every player for 60 frames, solo PARTY disabled, mode and crew counters, EXIT retained', () => {
  assert.deepEqual(Object.keys(GAMES).sort(), ['crown', 'crumble', 'hub', 'park', 'quiver', 'screenrun', 'skylanes', 'trails', 'volley', 'vote']);
  for (const [n, pad, start] of [[1, COOP_PAD, 'coop'], [2, PARTY_PAD, 'party'], [4, PARTY_PAD, 'party']] as const) {
    const s = hub.init(0, roster(n), {}); hub.step(s, joins(roster(n)));
    s.players.forEach((p, i) => { if (p.present) Object.assign(p, { x: (pad.x * 16 + i * 10) * SUB, y: pad.y * TILE - PLAYER_H, grounded: true, vx: 0, vy: 0 }); });
    for (let i = 0; i < 59; i++) hub.step(s, []); assert.equal(s.outcome, null);
    hub.step(s, []); assert.equal((s as BaseState).outcome?.signal?.kind, 'hub'); assert.equal(((s as BaseState).outcome?.signal as { start: string }).start, start);
  }
  const s = hub.init(0, roster(1), {}); hub.step(s, joins(roster(1))); Object.assign(s.players[0], { x: PARTY_PAD.x * TILE, y: PARTY_PAD.y * TILE - PLAYER_H });
  for (let i = 0; i < 90; i++) hub.step(s, []); assert.equal(s.partyHold, 0); assert.equal(s.outcome, null);
  assert.ok(HUB_LEVEL.lobby!.exit);
});
test('vote: 480 frames, changed confirmation, reset clears edges, seed tie pick, terminal immutable', () => {
  const cards = [{ game: 'crumble', resolves: 'crumble', opts: {} }, { game: 'crown', resolves: 'crown', opts: {} }] as const;
  const s = vote.init(20, roster(2), { ballot: [...cards], closesAt: 8000 });
  vote.step(s, [[0, 0, 0, 16]]); vote.step(s, [[1, 0, 0, 2]]); vote.step(s, [[2, 0, 0, 16]]);
  assert.equal(s.players[0].confirmed, 1);
  while (s.frame < 479) vote.step(s, []); assert.equal(s.outcome, null); vote.step(s, []); assert.deepEqual((s as BaseState).outcome?.signal, { kind: 'vote', card: 1 });
  vote.step(s, [[480, 0, 0, 17]]); assert.deepEqual((s as BaseState).outcome?.signal, { kind: 'vote', card: 1 });
  const single = vote.init(0, roster(2), { ballot: [cards[0]], closesAt: 8000 });
  for (let i = 0; i < 480; i++) vote.step(single, []); assert.equal(single.outcome?.signal?.kind, 'vote');
});
test('park card: recorded clear computes personal stats, capped timeout, six-bit jump equals Up', () => {
  for (const n of [1, 2, 3, 4]) {
    const r = roster(n), s = park.init(0, r, { level: 1, card: true }), recording = SOLUTIONS[1][n];
    while (!s.outcome && s.frame < recording.frames) { const f = s.frame; park.step(s, [...(f ? [] : joins(r)), ...recording.inputs.filter(e => e[0] === f).map(([frame, slot, bits]): GameEvent => [frame, slot, 0, bits & 4 ? bits & ~4 | 16 : bits])]); }
    assert.ok(s.outcome); assert.deepEqual(s.outcome.order.flat().sort(), r.map(p => p.slot)); assert.deepEqual(s.outcome.signal, { kind: 'park', cleared: true });
    for (const [slot, stat] of Object.entries(s.outcome.stats)) assert.equal(stat.personal, (stat.coins ?? 0) + 2 * (stat.stomps ?? 0) + 5 * s.keyDoor[+slot] - 2 * (stat.deaths ?? 0));
  }
  const s = park.init(0, roster(2), { level: 1, card: true }); park.step(s, joins(roster(2))); s.frame = 7199; park.step(s, []); assert.deepEqual((s as BaseState).outcome?.signal, { kind: 'park', cleared: false });
});

test('generic hash: sorted keys, every JSON type, arrays and PRNG included, only effects skipped', () => {
  const state = { frame: 3, fx: [], outcome: null, rng: 5, names: ['A', 'Б'], alive: true };
  const h = hash(state); assert.equal(hash(Object.fromEntries(Object.entries(state).reverse())), h);
  assert.equal(hash({ ...state, fx: [{ frame: 1, slot: 0, kind: 'jump' }] }), h);
  for (const patch of [{ frame: 4 }, { rng: 6 }, { names: ['A', 'B'] }, { alive: false }, { outcome: {} }, { names: ['A', 'Б', 'C'] }]) assert.notEqual(hash({ ...state, ...patch }), h);
  assert.notEqual(hash([1, 23]), hash([12, 3])); assert.notEqual(hash(false), hash(0)); assert.notEqual(hash(null), hash('null'));
});
for (const id of ['crumble', 'crown'] as const) test(`${id}: three seed variants deterministically reach outcome with all four slots`, () => {
  const def = gameDef(id), variants = new Set<number>();
  for (const seed of [0, 1, 2]) {
    const a = def.init(seed, roster(4), { mode: 'ffa' }) as CrumbleState | CrownState, b = structuredClone(a); variants.add(a.layout);
    while (!a.outcome) { const ev = bots(id, a); def.step(a, ev); def.step(b, ev); }
    assert.equal(hash(a), hash(b)); assert.deepEqual(a.outcome.order.flat().sort(), [0, 1, 2, 3]);
  }
  assert.equal(variants.size, 3);
});

test('arena helpers: swept dash stops at a thin wall, one-way platforms pass upward, optional wrapping is deterministic', async () => {
  const { fighter, move } = await import('../../shared/arcade/arena');
  const p = fighter(0, roster(2), 0, 40 * SUB); p.grounded = false;
  move(p, [{ x: 14 * SUB, y: 0, w: SUB, h: 192 * SUB }], [], 32, 80); assert.equal(p.x + PLAYER_W, 14 * SUB);
  const q = fighter(0, roster(2), 40 * SUB, 70 * SUB); q.vy = -92; q.bits = 16;
  move(q, [], [{ x: 0, y: 80 * SUB, w: 320 * SUB, h: SUB }]); assert.ok(q.y < 70 * SUB);
  const w = fighter(0, roster(2), 319 * SUB, 40 * SUB); move(w, [], [], 32, 80, false, { x: true }); assert.equal(w.x, 4 * SUB);
});

// Step 2: these bots send ordinary inputs only; they never edit a running match.
const MORE_GAMES = ['quiver', 'screenrun', 'volley', 'trails', 'skylanes'] as const;
type MoreId = typeof MORE_GAMES[number];
function moreBots(id: MoreId, s: any): GameEvent[] {
  return s.players.flatMap((p: any, slot: number): GameEvent[] => {
    if (!p.present || !p.alive) return [];
    let bits = 0;
    if (id === 'quiver') {
      const target = s.players.find((q: any, i: number) => i !== slot && q.present && q.alive && (p.team === null || p.team !== q.team));
      if (target) bits = (target.x < p.x ? 1 : 2) | (Math.abs(target.y - p.y) > 12 * SUB ? target.y < p.y ? 4 : 8 : 0);
      if ((s.frame + slot * 3) % 16 === 0) bits |= 32;
      if ((s.frame + slot * 31) % 100 < 18) bits |= 16;
    } else if (id === 'screenrun') {
      bits = 2;
      const col = Math.trunc((p.x + PLAYER_W - 1) / TILE), next = s.course[col + 1] ?? 10, here = s.course[col] ?? 10;
      if (p.grounded && (next < 0 && p.x + PLAYER_W >= (col + 1) * TILE - 2 * SUB || next >= 0 && next < here) || p.vy < 0 && (p.bits & 16)) bits |= 16;
      if ((s.frame + slot * 29) % (120 + slot * 7) === 0 && s.course.slice(col + 1, col + 7).every((row: number) => row === here)) bits |= 32;
      // Different reaction times: later slots occasionally miss a gap jump.
      if (slot && (Math.trunc(s.heatFrame / 120) + slot) % 3 === 0) bits &= ~16;
    } else if (id === 'volley') {
      const side = s.sides[slot], target = Math.max(side ? 169 : 8, Math.min(side ? 302 : 141, Math.trunc(s.ball.x / SUB) - 1));
      bits = Math.abs(p.x / SUB - target) < 2 ? 0 : p.x / SUB > target ? 1 : 2;
      if (s.ball.y < p.y && Math.abs(s.ball.x - p.x) < 30 * SUB && (s.frame + slot * 7) % 50 < 20) bits |= 16;
      if (!p.grounded && s.ball.y > p.y) bits |= 32;
    } else if (id === 'trails') {
      const turn = Math.trunc((s.frame + slot * 37) / (42 + slot * 6)) % 4;
      bits = [2, 8, 1, 4][turn] | ((s.frame + slot * 7) % 180 < 50 ? 32 : 0) | (s.frame % (181 + slot * 7) === 0 ? 16 : 0);
    } else {
      bits = (s.frame + slot * 17) % 130 < 65 ? 1 : 2;
    }
    return [[s.frame, slot, 0, bits]];
  });
}
for (const id of MORE_GAMES) for (const [n, teams] of [[2, false], [3, false], [4, false], [4, true]] as const) {
  if (id === 'volley' && n !== 2 && !teams) continue;
  test(`${id}: seeded ${n}${teams ? ' 2v2' : ' FFA'} bots finish before cap, deterministic JSON and complete order`, () => {
    const def = gameDef(id), r = roster(n, teams), cap = id === 'volley' ? 7200 : id === 'skylanes' ? 5400 : 9000;
    for (const seed of [0, 1, 2, 89]) {
      const a = def.init(seed, r, { mode: teams ? '2v2' : 'ffa' }) as any;
      let b = structuredClone(a);
      while (!a.outcome && a.frame < cap) {
        const ev = [...(a.frame === 0 ? joins(r) : []), ...moreBots(id, a)]; def.step(a, ev); def.step(b, ev);
        if (a.frame % 60 === 0) { assert.equal(hash(a), hash(b)); b = JSON.parse(JSON.stringify(b)); }
      }
      assert.ok(a.outcome, `seed ${seed}`); assert.ok(a.frame < cap, `seed ${seed}: reached cap ${a.frame}`);
      assert.deepEqual(a.outcome.order.flat().sort(), r.map(p => p.slot)); checkIntegers(a);
      if (teams) for (const group of a.outcome.order) for (const team of [0, 1]) {
        const members = r.filter(p => p.team === team).map(p => p.slot); assert.ok(members.every(slot => group.includes(slot)) || members.every(slot => !group.includes(slot)));
      }
      const before = structuredClone(a); def.step(a, [[a.frame, 0, 3, 0]]);
      assert.deepEqual(a.outcome, before.outcome); assert.equal(a.frame, before.frame + 1); assert.equal(def.bits(a, 0), 0); assert.equal(a.players[0].x, before.players[0].x);
    }
  });
  test(`${id}: ${n}${teams ? ' 2v2' : ' FFA'} delayed input rollback agrees at common and terminal frames`, () => {
    const r = roster(n, teams), def = gameDef(id), opts = { mode: teams ? '2v2' : 'ffa' }, seed = 91;
    const authoritative = def.init(seed, r, opts); let now = 0;
    const runner = new Runner({ userId: 'watch', now: () => now, transport: { send() {} } });
    runner.receive({ t: 'game_session', session: { cabinet: 'a', epoch: 1, serverNow: 0, players: r, spectators: ['watch'], crew: { key: 'r', name: 'Test' }, set: null,
      view: { kind: 'sim', game: id, seed, opts, roster: r, startAt: 0, snapshot: structuredClone(authoritative), events: joins(r) } } });
    const log = new Map<number, GameEvent[]>(), hashes = new Map<number, number>(); let terminal = -1;
    for (let frame = 0; frame < 9200; frame++) {
      now = frame * 1000 / 60;
      if (!authoritative.outcome) {
        const ev = moreBots(id, authoritative).filter(e => def.bits(authoritative, e[1]) !== e[3]); log.set(frame, ev); def.step(authoritative, ev); hashes.set(authoritative.frame, hash(authoritative));
        if (authoritative.outcome) terminal = authoritative.frame;
      }
      for (const ev of log.get(frame - 22) ?? []) runner.receive({ t: 'game_event', epoch: 1, ev });
      runner.tick();
      const common = frame - 40, checked = runner.stateAt(common);
      if (frame > 60 && frame % 60 === 0 && checked && hashes.has(common)) assert.equal(hash(checked), hashes.get(common));
      if (terminal >= 0 && frame > terminal + 40) break;
    }
    assert.ok(terminal >= 0); const checked = runner.stateAt(terminal); assert.ok(checked); assert.equal(hash(checked), hashes.get(terminal));
    assert.ok(runner.debug.rollbacks > 0); assert.equal(runner.debug.desyncs, 0);
  });
}
test('more games: registry eligibility matches FFA counts and 2v2, volley is sides only', async () => {
  const { eligible } = await import('../../shared/arcade/registry');
  for (const id of MORE_GAMES) {
    assert.ok(eligible(2, 'ffa').includes(id)); assert.ok(eligible(4, '2v2').includes(id));
    assert.equal(eligible(3, 'ffa').includes(id), id !== 'volley'); assert.equal(eligible(4, 'ffa').includes(id), id !== 'volley');
    assert.equal(eligible(1, 'ffa').includes(id), false);
  }
});

test('Screen Run: every 20-column template is crossed by the reference right/jump bot', async () => {
  const { SCREENRUN_CHUNKS, courseSolids } = await import('../../shared/arcade/games/screenrun');
  const { fighter, move } = await import('../../shared/arcade/arena');
  assert.equal(SCREENRUN_CHUNKS.length, 12);
  for (const [id, chunk] of SCREENRUN_CHUNKS.entries()) {
    assert.equal(chunk.length, 20); assert.equal(chunk[0], 10); assert.equal(chunk[19], 10);
    const course = [...Array(4).fill(10), ...chunk, ...Array(8).fill(10)], p = fighter(0, roster(2), 2 * TILE, 10 * TILE - PLAYER_H);
    for (let frame = 0; frame < 400 && p.x < 24 * TILE; frame++) {
      const col = Math.trunc((p.x + PLAYER_W - 1) / TILE), next = course[col + 1], here = course[col];
      const jump = p.grounded && (next < 0 && p.x + PLAYER_W >= (col + 1) * TILE - 2 * SUB || next >= 0 && next < here) || p.vy < 0 && !!(p.bits & 16);
      p.bits = 2 | (jump ? 16 : 0);
      const origin = p.x - 80 * SUB, solids = courseSolids(course, col - 3, col + 4).map(r => ({ ...r, x: r.x - origin }));
      p.x -= origin; move(p, solids, [], undefined, 0, false, { x: true }); p.x += origin;
      assert.ok(p.y < 192 * SUB, `template ${id}, x ${p.x / SUB}`);
    }
    assert.ok(p.x >= 24 * TILE, `template ${id}: crossed`);
  }
});
test('Sky Lanes: seeded columns obey widths, 24–64 px gaps, break safety and motion bounds', async () => {
  const { generateSkyPlatforms, skylanes } = await import('../../shared/arcade/games/skylanes');
  for (let seed = 0; seed < 100; seed++) {
    const { platforms } = generateSkyPlatforms(seed, 160); let lastY = 176 * SUB;
    for (const [i, p] of platforms.entries()) {
      assert.ok(p.x >= 0 && p.x <= 56 * SUB);
      if (p.y !== lastY) { assert.ok(lastY - p.y >= 24 * SUB && lastY - p.y <= 64 * SUB); lastY = p.y; }
      if (p.kind === 'breaking') {
        assert.notEqual(platforms[i - 1]?.kind, 'breaking');
        assert.ok(platforms.some(q => q !== p && q.kind !== 'breaking' && Math.trunc((176 * SUB - q.y) / (64 * SUB)) === Math.trunc((176 * SUB - p.y) / (64 * SUB))));
      }
    }
    assert.deepEqual(generateSkyPlatforms(seed, 160).platforms, platforms);
  }
  const s = skylanes.init(3, roster(4), { mode: 'ffa' });
  for (let i = 0; i < 200; i++) { skylanes.step(s, []); for (const x of s.moving) assert.ok(x >= 0 && x <= 56 * SUB); }
});
test('quiver: eight-way fire, cooldown, max ammo pickup, owner grace, walls and friendly fire', async () => {
  const { quiver } = await import('../../shared/arcade/games/quiver');
  const s = quiver.init(0, roster(4, true), { mode: '2v2' });
  s.players.forEach((p, i) => Object.assign(p, { x: (30 + 60 * i) * SUB, y: 70 * SUB }));
  quiver.step(s, [[0,0,0,2 | 4 | 32]]); assert.equal(s.ammo[0], 2); assert.equal(s.arrows[0].vx, 64); assert.equal(s.arrows[0].vy, -64);
  quiver.step(s, [[1,0,0,0]]); quiver.step(s, [[2,0,0,32]]); assert.equal(s.ammo[0], 2);
  const q = quiver.init(0, roster(4, true), { mode: '2v2' }); q.players.forEach((p,i) => Object.assign(p, { x: (30 + 60 * i) * SUB, y: 70 * SUB }));
  const arrow = (slot: number, owner: number, age: number, stuck = false) => ({ x: q.players[slot].x + 2 * SUB, y: q.players[slot].y + 4 * SUB, w: 2 * SUB, h: 2 * SUB, vx: 96, vy: 0, owner, age, stuck });
  q.arrows = [arrow(0,0,0), arrow(2,0,20)]; quiver.step(q, []); assert.ok(q.players[0].alive); assert.ok(q.players[2].alive);
  q.arrows = [arrow(1,0,20)]; quiver.step(q, []); assert.equal(q.players[1].alive, false); assert.equal(q.players[0].stats.kills, 1);
  q.arrows = [arrow(0,0,10)]; quiver.step(q, []); assert.equal(q.players[0].alive, false);
  const t = quiver.init(0, roster(3), { mode: 'ffa' }); t.players[0].x = 30 * SUB; t.players[0].y = 70 * SUB; t.ammo[0] = 5;
  t.arrows = [{ x: 33 * SUB, y: 74 * SUB, w: 32, h: 32, vx: 0, vy: 0, owner: 1, age: 20, stuck: true }];
  quiver.step(t, []); assert.equal(t.ammo[0], 6); assert.equal(t.arrows.length, 0);
  t.arrows = [{ x: 33 * SUB, y: 74 * SUB, w: 32, h: 32, vx: 0, vy: 0, owner: 1, age: 20, stuck: true }];
  quiver.step(t, []); assert.equal(t.ammo[0], 6); assert.equal(t.arrows.length, 1);
  t.arrows = [{ x: 30 * SUB, y: 174 * SUB, w: 32, h: 32, vx: 0, vy: 96, owner: 1, age: 20, stuck: false }];
  quiver.step(t, []); assert.equal(t.arrows[0].stuck, true); assert.ok(t.arrows[0].y + t.arrows[0].h <= 176 * SUB);
});
test('quiver: stomps, simultaneous kills, spikes, heat cap and points/kills match tiebreak', async () => {
  const { quiver } = await import('../../shared/arcade/games/quiver');
  const s = quiver.init(0, roster(3), { mode: 'ffa' });
  Object.assign(s.players[0], { x: 120 * SUB, y: 50 * SUB, vy: 60 }); Object.assign(s.players[1], { x: 120 * SUB, y: 72 * SUB });
  quiver.step(s, []); assert.equal(s.players[1].alive, false); assert.equal(s.players[0].stats.stomps, 1); assert.equal(s.players[1].stats.stomped, 1);
  const q = quiver.init(0, roster(2), { mode: 'ffa' }); q.players.forEach((p,i) => { p.x = (30 + i * 50) * SUB; p.y = 70 * SUB; });
  q.arrows = q.players.slice(0,2).map((p,i) => ({ x: p.x + 2 * SUB, y: p.y + 4 * SUB, w: 32, h: 32, vx: 96, vy: 0, owner: 1 - i, age: 20, stuck: false }));
  quiver.step(q, []); assert.deepEqual(q.points, [0,0,0,0]); assert.ok(q.nextHeat);
  quiver.step(q, []); assert.ok(q.players[0].alive && q.players[1].alive); assert.equal(q.ammo[0], 3);
  q.heatFrame = 2404; q.players[0].y = 172 * SUB; quiver.step(q, []); assert.equal(q.players[0].alive, false); assert.equal(q.points[1], 1);
  const cap = quiver.init(1, roster(3), { mode: 'ffa' }); cap.heatFrame = 3599; quiver.step(cap, []); assert.deepEqual(cap.points, [0,0,0,0]);
  cap.nextHeat = false; cap.frame = 8999; cap.points = [1,2,2,0]; cap.players[1].stats.kills = 2; cap.players[2].stats.kills = 3;
  quiver.step(cap, []); assert.deepEqual(cap.outcome!.order, [[2],[1],[0]]);
});
test('screenrun: swept eight-frame dash and shove, camera acceleration, heat and distance ties', async () => {
  const { screenrun } = await import('../../shared/arcade/games/screenrun');
  const s = screenrun.init(0, roster(3), { mode: 'ffa' }); s.players[0].x = 30 * SUB; s.players[1].x = 42 * SUB;
  screenrun.step(s, [[0,0,0,2 | 32]]); assert.equal(s.dash[0], 7); assert.equal(s.players[0].x, 36 * SUB); assert.equal(s.players[0].stats.shoves, 1);
  assert.ok(s.push[1] > 0); const before = s.players[1].x; screenrun.step(s, []); assert.ok(s.players[1].x - before >= 80);
  const q = screenrun.init(0, roster(3), { mode: 'ffa' }); q.heatFrame = 180; q.players.forEach(p => p.x = 110 * SUB); screenrun.step(q, []); assert.equal(q.camX, 16);
  q.heatFrame = 780; q.camX = 0; screenrun.step(q, []); assert.equal(q.camX, 20);
  q.heatFrame = 3599; q.players[0].x = 200 * SUB; q.players[1].x = 201 * SUB; q.players[2].x = 202 * SUB;
  screenrun.step(q, []); assert.equal(q.points[2], 1);
  q.nextHeat = false; q.frame = 8999; q.players.forEach(p => p.x = 200 * SUB); q.points = [1,1,0,0]; q.players[0].stats.distance = 20; q.players[1].stats.distance = 30;
  screenrun.step(q, []); assert.deepEqual(q.outcome!.order, [[1],[0],[2]]);
});
test('volley: contact edges, six-frame immunity, fourth-touch fault, crossing reset and air spike', async () => {
  const { volley } = await import('../../shared/arcade/games/volley');
  const s = volley.init(0, roster(2), { mode: 'ffa' }), p = s.players[0]; p.y = 100 * SUB; s.hold = 0;
  const contact = () => Object.assign(s.ball, { x: p.x + 3 * SUB, y: p.y + 4 * SUB, vx: 0, vy: 0 });
  contact(); volley.step(s, []); assert.equal(s.touches[0], 1); assert.equal(s.ball.vy, -112);
  contact(); volley.step(s, []); assert.equal(s.touches[0], 1);
  s.overlap[0] = false; contact(); volley.step(s, []); assert.equal(s.touches[0], 1);
  s.cooldown[0] = 0; s.overlap[0] = false; s.touches[0] = 3; contact(); volley.step(s, []); assert.equal(s.points[1], 1); assert.equal(s.serve, 0); assert.deepEqual(s.touches, [0,0]);
  s.hold = 0; s.touches[0] = 2; Object.assign(s.ball, { x: 200 * SUB, y: 40 * SUB, vx: 0, vy: 0 }); volley.step(s, []); assert.deepEqual(s.touches, [0,0]);
  s.cooldown[0] = 0; s.overlap[0] = false; s.lastSide = 0; contact(); volley.step(s, [[s.frame,0,0,32]]); assert.equal(s.ball.vy, 96); assert.equal(s.ball.vx, 128); assert.equal(p.stats.spikes, 1);
});
test('volley: losing side serves, last scorer stats, seven points, regulation, golden point and draw caps', async () => {
  const { volley } = await import('../../shared/arcade/games/volley');
  const s = volley.init(0, roster(2), { mode: 'ffa' }); s.hold = 0; s.points[0] = 6; s.lastToucher = 0; Object.assign(s.ball, { x: 290 * SUB, y: 170 * SUB, vx: 0, vy: 80 });
  volley.step(s, []); assert.equal(s.points[0], 7); assert.equal(s.players[0].stats.points, 1); assert.equal(s.serve, 1); assert.deepEqual(s.outcome!.order, [[0],[1]]);
  const reg = volley.init(0, roster(2), { mode: 'ffa' }); reg.frame = 5399; reg.points = [2,1]; volley.step(reg, []); assert.deepEqual(reg.outcome!.order, [[0],[1]]);
  const golden = volley.init(0, roster(2), { mode: 'ffa' }); golden.frame = 5399; volley.step(golden, []); assert.equal(golden.outcome, null);
  golden.frame = 7199; volley.step(golden, []); assert.deepEqual(golden.outcome!.order, [[0,1]]);
});
test('trails: simultaneous head-on, swap and trail deaths score only survivors; jump leaves the skipped cell clear', async () => {
  const { trails } = await import('../../shared/arcade/games/trails');
  const s = trails.init(0, roster(3), { mode: 'ffa' }); s.grid.fill(0);
  Object.assign(s.players[0], { x: 10, y: 10 }); Object.assign(s.players[1], { x: 12, y: 10 }); Object.assign(s.players[2], { x: 30, y: 30 });
  s.dir = s.turn = [0,2,0,0]; s.clock = [2,2,2,0]; trails.step(s, []);
  assert.equal(s.players[0].alive, false); assert.equal(s.players[1].alive, false); assert.equal(s.points[2], 2); assert.equal(s.points[0], 0);
  const q = trails.init(0, roster(3), { mode: 'ffa' }); q.grid.fill(0); Object.assign(q.players[0], { x: 10, y: 10 }); Object.assign(q.players[1], { x: 11, y: 10 });
  q.dir = q.turn = [0,2,0,0]; q.clock = [2,2,2,0]; trails.step(q, []); assert.ok(!q.players[0].alive && !q.players[1].alive);
  const j = trails.init(0, roster(3), { mode: 'ffa' }); j.grid.fill(0); Object.assign(j.players[0], { x: 10, y: 10 }); j.dir[0] = j.turn[0] = 0; j.clock[0] = 2; j.grid[10 * 64 + 11] = 2;
  trails.step(j, [[0,0,0,16]]); assert.equal(j.players[0].x, 12); assert.equal(j.grid[10 * 64 + 11], 2); assert.equal(j.cooldown[0], 180);
});
test('trails: queued no-reverse turn, boost drain/refill, team points, first six and heat cap', async () => {
  const { trails } = await import('../../shared/arcade/games/trails');
  const s = trails.init(0, roster(3), { mode: 'ffa' }); s.dir[0] = s.turn[0] = 0; s.clock[0] = 0;
  trails.step(s, [[0,0,0,1]]); assert.equal(s.turn[0], 0);
  trails.step(s, [[1,0,0,4 | 32]]); assert.equal(s.dir[0], 3); assert.equal(s.boost[0], 89);
  trails.step(s, [[2,0,0,0]]); assert.equal(s.boost[0], 90);
  const t = trails.init(0, roster(4,true), { mode: '2v2' }); t.grid.fill(0); t.points = [4,0,4,0];
  for (const slot of [1,3]) { t.players[slot].x = 1; t.dir[slot] = t.turn[slot] = 2; t.clock[slot] = 2; }
  trails.step(t, []); assert.equal(t.points[0], 6); assert.deepEqual(t.outcome!.order, [[0,2],[1,3]]);
  const cap = trails.init(0, roster(2), { mode: 'ffa' }); cap.heatFrame = 1799; trails.step(cap, []); assert.ok(cap.nextHeat); assert.deepEqual(cap.points, [0,0,0,0]);
});
test('skylanes: floor bounce, wrapping, one-use breaking, spring and independent cameras/heights', async () => {
  const { skylanes } = await import('../../shared/arcade/games/skylanes');
  const s = skylanes.init(0, roster(3), { mode: 'ffa' }); skylanes.step(s, []); assert.equal(s.players[0].vy, -104);
  s.players[0].x = 0; s.players[0].vx = -40; skylanes.step(s, [[s.frame,0,0,1]]); assert.equal(s.players[0].x, 80 * SUB - 40);
  const q = skylanes.init(0, roster(3), { mode: 'ffa' }); q.platforms = [{ x: 20 * SUB, y: 100 * SUB, kind: 'breaking', dir: 1 }]; q.moving = [20 * SUB]; q.directions = [1];
  Object.assign(q.players[0], { x: 24 * SUB, y: 80 * SUB - 1, vy: 20 }); skylanes.step(q, []); assert.equal(q.players[0].vy, -104); assert.deepEqual(q.broken[0], [0]); assert.deepEqual(q.broken[1], []);
  q.platforms[0].kind = 'spring'; q.broken[0] = []; Object.assign(q.players[0], { y: 80 * SUB - 1, vy: 20 }); skylanes.step(q, []); assert.equal(q.players[0].vy, -160);
  q.players[0].y = -80 * SUB; skylanes.step(q, []); assert.ok(q.cams[0] < q.cams[1]); assert.ok(q.players[0].stats.height! > q.players[1].stats.height!);
  q.frame = 5399; skylanes.step(q, []); assert.deepEqual(q.outcome!.order[0], [0]);
});
for (const id of MORE_GAMES) test(`${id}: leaving is final even while eliminated, resets do not respawn, empty team loses`, () => {
  const def = gameDef(id), s = def.init(2, roster(4,true), { mode: '2v2' }) as any;
  s.players[0].alive = false; s.players[0].stats.deaths = 3;
  def.step(s, [[0,0,3,0]]); assert.equal(s.players[0].alive, false); assert.equal(s.players[0].stats.deaths, 3);
  def.step(s, [[1,0,2,0], [1,2,2,0]]); assert.deepEqual(s.outcome.order, [[1,3],[0,2]]);
});
test('quiver: three equal nonzero kill totals share one group at cap', async () => {
  const { quiver } = await import('../../shared/arcade/games/quiver'); const s = quiver.init(0, roster(3), { mode: 'ffa' });
  s.frame = 8999; s.players.forEach(p => p.stats.kills = 2); quiver.step(s, []); assert.deepEqual(s.outcome!.order, [[0,1,2]]);
});
test('screenrun: a shove lasts eight full future movement frames', async () => {
  const { screenrun } = await import('../../shared/arcade/games/screenrun'); const s = screenrun.init(0, roster(3), { mode: 'ffa' });
  s.players[0].x = 30 * SUB; s.players[1].x = 42 * SUB; screenrun.step(s, [[0,0,0,2 | 32]]); assert.equal(s.push[1], 8);
  for (let i = 0; i < 8; i++) screenrun.step(s, []); assert.equal(s.push[1], 0);
});
test('skylanes: columns extend above the highest lane without changing existing seeded platforms', async () => {
  const { skylanes } = await import('../../shared/arcade/games/skylanes'); const s = skylanes.init(0, roster(2), { mode: 'ffa' }), old = structuredClone(s.platforms);
  s.players[0].y = s.platforms.at(-1)!.y - 100 * SUB; s.cams[0] = s.players[0].y - 64 * SUB;
  skylanes.step(s, []); assert.ok(s.platforms.at(-1)!.y < s.players[0].y - 192 * SUB); assert.deepEqual(s.platforms.slice(0, old.length), old);
});
for (const id of ['quiver','screenrun','trails'] as const) test(`${id}: a new heat keeps held buttons without retriggering action edges`, () => {
  const def = gameDef(id), s = def.init(0,roster(3),{ mode:'ffa' }) as any; s.players[0].bits = s.players[0].prevBits = 2 | 32; s.nextHeat = true;
  def.step(s,[]); assert.equal(def.bits(s,0),2 | 32); assert.equal(s.players[0].prevBits,2 | 32);
});
test('Sky Lanes: every consecutive platform has a positive 24–64 px gap', async () => {
  const { generateSkyPlatforms } = await import('../../shared/arcade/games/skylanes');
  for (let seed = 0; seed < 50; seed++) {
    let last = 176 * SUB;
    for (const p of generateSkyPlatforms(seed).platforms) { assert.ok(last - p.y >= 24 * SUB && last - p.y <= 64 * SUB); last = p.y; }
  }
});
test('quiver: a full quiver does not prevent another overlapping archer picking up an arrow', async () => {
  const { quiver } = await import('../../shared/arcade/games/quiver'); const s = quiver.init(0,roster(3),{mode:'ffa'});
  for (const p of s.players.slice(0,2)) Object.assign(p,{x:120*SUB,y:70*SUB}); s.ammo[0]=6; s.ammo[1]=3;
  s.arrows=[{x:123*SUB,y:74*SUB,w:32,h:32,vx:0,vy:0,owner:2,age:20,stuck:true}];
  quiver.step(s,[]); assert.equal(s.ammo[1],4); assert.equal(s.arrows.length,0);
});
test('quiver: top and bottom wrap through the arena gaps before spikes', async () => {
  const { quiver } = await import('../../shared/arcade/games/quiver'); const s = quiver.init(0,roster(3),{mode:'ffa'});
  Object.assign(s.players[0],{x:80*SUB,y:0,vy:-64,bits:16}); quiver.step(s,[]); assert.ok(s.players[0].y > 176*SUB);
  let wrapped=false; for(let i=0;i<80;i++){ quiver.step(s,[]); if(s.players[0].y<30*SUB){ wrapped=true; break; } } assert.ok(wrapped);
});
test('quiver: arrows touch across the horizontal wrap seam', async () => {
  const { quiver } = await import('../../shared/arcade/games/quiver'); const s=quiver.init(0,roster(3),{mode:'ffa'});
  Object.assign(s.players[0],{x:0,y:70*SUB}); s.arrows=[{x:313*SUB,y:74*SUB,w:32,h:32,vx:96,vy:0,owner:1,age:20,stuck:false}];
  quiver.step(s,[]); assert.equal(s.players[0].alive,false);
});
test('volley: normal hits retain subpixel centre offset before the integer division', async () => {
  const { volley }=await import('../../shared/arcade/games/volley'); const s=volley.init(0,roster(2),{mode:'ffa'}),p=s.players[0]; p.y=100*SUB; s.hold=0;
  Object.assign(s.ball,{x:p.x+SUB+8,y:p.y+4*SUB,vx:0,vy:0}); volley.step(s,[]); assert.equal(s.ball.vx,3);
});
test('trails: leaving an alive bike awards survivor points once; already dead departures do not score twice', async () => {
  const { trails }=await import('../../shared/arcade/games/trails'); const s=trails.init(0,roster(4),{mode:'ffa'});
  trails.step(s,[[0,0,2,0]]); assert.equal(s.points[1],1); assert.equal(s.points[2],1); assert.equal(s.points[3],1);
  s.players[1].alive=false; trails.step(s,[[1,1,2,0]]); assert.equal(s.points[2],1);
});
test('quiver: every seeded spawn has a solid floor and clear body space', async () => {
  const { quiver,QUIVER_LAYOUTS }=await import('../../shared/arcade/games/quiver'); const {body,overlaps}=await import('../../shared/arcade/arena');
  for(const seed of [0,1,2]){const s=quiver.init(seed,roster(4),{mode:'ffa'});for(const p of s.players){assert.ok(!QUIVER_LAYOUTS[s.layout].some(r=>overlaps(body(p),r)),`layout ${s.layout}, x ${p.x/SUB}`);assert.ok(QUIVER_LAYOUTS[s.layout].some(r=>overlaps({...body(p),y:p.y+1},r)));}}
});
test('quiver: stomps resolve across both wrap seams, including a falling body wrapping its origin', async () => {
  const { quiver }=await import('../../shared/arcade/games/quiver');
  for(const [ax,ay,bx,by] of [[319,50,0,72],[80,170,80,0],[80,191,80,20]]){
    const s=quiver.init(0,roster(3),{mode:'ffa'}); Object.assign(s.players[0],{x:ax*SUB,y:ay*SUB,vy:60}); Object.assign(s.players[1],{x:bx*SUB,y:by*SUB});
    quiver.step(s,[]); assert.equal(s.players[1].alive,false,`${ax},${ay} onto ${bx},${by}`); assert.equal(s.players[0].stats.stomps,1);
  }
});
