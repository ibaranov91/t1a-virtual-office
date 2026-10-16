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
test('crumble: cracks stay solid for 30 frames; pound breaks centre and neighbours once', () => {
  const s = crumble.init(1, roster(2), { mode: 'ffa' });
  for (const p of s.players.filter(p => p.present)) p.x = 5 * TILE;
  crumble.step(s, joins(roster(2)));
  const t = s.tiles.find(t => t.x === 5 && t.y === 2)!; assert.equal(t.crackAt, 0);
  while (s.frame < 30) crumble.step(s, []); assert.equal(t.gone, false);
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
  assert.deepEqual(Object.keys(GAMES).sort(), ['crown', 'crumble', 'hub', 'park', 'vote']);
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
