import test from 'node:test';
import assert from 'node:assert/strict';
import { Arcade } from './arcade';
import { Runner } from '../../shared/arcade/runner';
import { hash } from '../../shared/arcade/hash';
import { ballot } from '../../shared/arcade/ballot';
import { awards } from '../../shared/arcade/awards';
import { BONUS_POOL, bonusStar, favouriteWinners, placePoints, scoreRound, standings } from '../../shared/arcade/scoring';
import { ADJECTIVES, NOUNS, autoName, balanceTeams, crewKey, crewName } from '../../shared/arcade/names';
import { emptyWeek, ranked, rollover, weekKey, weeklyTotal } from '../../shared/arcade/weeks';
import { PARTY_PAD, type HubState } from '../../shared/arcade/hub';
import type { CrownState } from '../../shared/arcade/games/crown';
import type { VoteOptions, VoteState } from '../../shared/arcade/vote';
import { TILE, PLAYER_H, SUB } from '../../shared/arcade/arena';
import type { ArcadeBoards, ArcadeIncoming, BreakSet, Outcome, RoundResult, SetPlayer } from '../../shared/arcade/types';
import type { ClientMsg, PublicUser, ServerMsg } from '../../shared/protocol';
const players = (n: number): SetPlayer[] => Array.from({ length: n }, (_, slot) => ({ slot, userId: String(slot), team: null, left: false }));
const outcome = (order: number[][]): Outcome => ({ order, stats: {} });
function setFixture(n = 4): BreakSet { return { id: 'set', round: 3, mode: 'ffa', crew: { key: 'crew', name: 'Test crew' }, players: players(n), points: Object.fromEntries(players(n).map(p => [p.userId, 0])), rounds: [], played: [], bonus: [...BONUS_POOL], predictions: {}, favourite: {} }; }
const result = (order: string[][], points: Record<string, number> = {}): RoundResult => ({ game: 'crumble', order, points, underdog: [], final: false, stats: {}, predictions: [] });
test('Break Set scoring: 2/3/4 places, tie example, final only doubles places, underdog thresholds, cleared Park +1', () => {
  assert.deepEqual([2, 3, 4].map(placePoints), [[3, 0], [3, 1, 0], [3, 2, 1, 0]]);
  assert.deepEqual(scoreRound('crumble', outcome([[0, 1], [2], [3]]), players(4), undefined, 'ffa', false).points, { 0: 3, 1: 3, 2: 1, 3: 0 });
  for (const n of [2, 3, 4]) {
    const previous = result([players(n).slice(0, -1).map(p => p.userId), [String(n - 1)]]);
    const o = outcome([[n - 1], ...Array.from({ length: n - 1 }, (_, i) => [i])]); o.signal = { kind: 'park', cleared: true };
    const r = scoreRound('park', o, players(n), previous, 'ffa', true); assert.equal(r.points[n - 1], 8); assert.deepEqual(r.underdog, [String(n - 1)]);
    const tiedLast = result([[String(n - 1)], players(n).slice(0, -1).map(p => p.userId)]);
    if (n > 2) assert.deepEqual(scoreRound('crumble', o, players(n), tiedLast, 'ffa', false).underdog, []);
  }
  const p = players(4), previous = result([['0'], ['1'], ['2'], ['3']]);
  assert.deepEqual(scoreRound('crumble', outcome([[0], [3], [1], [2]]), p, previous, 'ffa', false).underdog, ['3']);
  assert.deepEqual(scoreRound('crumble', outcome([[0], [1], [3], [2]]), p, previous, 'ffa', false).underdog, []);
  assert.deepEqual(scoreRound('crumble', outcome([[0, 2], [1, 3]]), p, undefined, '2v2', true).points, { 0: 6, 1: 0, 2: 6, 3: 0 });
  assert.deepEqual(scoreRound('crumble', outcome([[0, 1, 2, 3]]), p, undefined, '2v2', false).points, { 0: 3, 1: 3, 2: 3, 3: 3 });
});
test('standings, bonus and favourite: round-3 tiebreak, shared ties, secret first positive category, leavers excluded', () => {
  const s = setFixture(); s.points = { 0: 5, 1: 5, 2: 5, 3: 100 }; s.players[3].left = true;
  s.rounds = [result([['0'], ['1'], ['2'], ['3']]), result([['0'], ['1'], ['2'], ['3']]), result([['1', '2'], ['0'], ['3']])];
  assert.deepEqual(standings(s), [['1', '2'], ['0']]);
  s.rounds[0].stats = { 0: { holdFrames: 60 }, 1: { holdFrames: 120 }, 2: { holdFrames: 120 }, 3: { airFrames: 999 } };
  assert.deepEqual(bonusStar(s), { category: 'holdFrames', value: 120, winners: ['1', '2'] });
  s.rounds[0].stats = {}; assert.equal(bonusStar(s), null);
  assert.deepEqual(favouriteWinners({ a: '1', b: '2' }, ['0', '1', '2']), ['1', '2']); assert.deepEqual(favouriteWinners({}, ['0', '1']), []);
});
test('awards: category priority, standing then slot tiebreak, max two, consolation and derived categories', () => {
  const s = setFixture(); s.points = { 0: 9, 1: 8, 2: 0, 3: 0 };
  s.rounds = [result([['1'], ['0'], ['2'], ['3']], { 1: 3 }), result([['1'], ['0'], ['2'], ['3']], { 1: 3 }), result([['0'], ['1'], ['2'], ['3']], { 0: 6 })];
  s.rounds[0].stats = { 0: { kills: 5, airFrames: 200, holdFrames: 180 }, 1: { kills: 5, airFrames: 200, coins: 5 }, 2: { deaths: 2, falls: 1, stomped: 4 }, 3: {} };
  const a = awards(s); assert.deepEqual(a['0'], ['MVP', 'Sharpshooter']); assert.ok(a['1'].includes('Frequent Flyer')); assert.ok(a['2'].includes('Most Reckless'));
  assert.ok(Object.values(a).every(values => values.length >= 1 && values.length <= 2));
  const empty = setFixture(2); assert.deepEqual(awards(empty), { 0: ['Photo Finish'], 1: ['Consolation Prize'] });
  const derived = setFixture(3); derived.points = { 0: 5, 1: 4, 2: 2 }; derived.rounds = [result([['1'], ['2'], ['0']], { 1: 3 }), result([['1'], ['0'], ['2']], { 1: 3 }), result([['0'], ['1'], ['2']], { 0: 5 })];
  const d = awards(derived); assert.ok(d['1'].includes('Steak in Mouth')); assert.ok(d['0'].includes('Photo Finish'));
});
test('crews: stable sorted key, 40x40 office lists, reroll, Unicode names, validation and balanced 2v2', () => {
  assert.equal(crewKey(['b', 'a']), crewKey(['a', 'b'])); assert.equal(ADJECTIVES.length, 40); assert.equal(NOUNS.length, 40);
  assert.equal(autoName('a'), autoName('a')); assert.notEqual(autoName('a'), autoName('a', 1));
  assert.equal(crewName("  Їжа & cats!  "), 'Їжа & cats!');
  for (const raw of ['', 'abc🙂', '<script>', 'x'.repeat(21), 'fuck', 42]) assert.equal(crewName(raw), null);
  assert.deepEqual(balanceTeams(players(4), { 0: 30, 1: 20, 2: 10, 3: 0 }).map(p => p.team), [0, 1, 1, 0]);
});
test('weeks: Warsaw Monday midnight and DST boundaries use calendar dates; rollover archives every shared #1', () => {
  for (const [at, expected] of [['2026-03-29T21:59:59Z', '2026-03-23'], ['2026-03-29T22:00:00Z', '2026-03-30'], ['2026-10-25T22:59:59Z', '2026-10-19'], ['2026-10-25T23:00:00Z', '2026-10-26'], ['2027-01-03T23:00:00Z', '2027-01-04']]) assert.equal(weekKey(Date.parse(at)), expected);
  const boards: ArcadeBoards = { records: {}, hall: [], week: emptyWeek('2026-10-12') };
  boards.week.players = { a: { name: 'A', sets: [{ id: '1', total: 9 }] }, b: { name: 'B', sets: [{ id: '2', total: 9 }] } };
  assert.equal(rollover(boards, Date.parse('2026-10-19T00:00:00Z')), true); assert.deepEqual(boards.hall.map(h => h.userId), ['a', 'b']);
  rollover(boards, Date.parse('2026-11-02T00:00:00Z')); assert.equal(boards.hall.length, 2);
  assert.deepEqual(ranked({ a: 5, b: 5, c: 3 }).map(r => r.rank), [1, 1, 3]);
});
test('ballots: expanded eligible pool excludes the last two games and keeps Park out of 2v2', () => {
  const initial = ballot({ rng: 10 }, 4, 'ffa', []); assert.equal(initial.length, 3); assert.equal(initial[2].game, 'surprise');
  const second = ballot({ rng: 10 }, 4, 'ffa', ['crown']); assert.equal(second.length, 3); assert.ok(second.every(c => c.resolves !== 'crown'));
  const third = ballot({ rng: 10 }, 4, 'ffa', ['crown', 'crumble']); assert.equal(third.length, 3); assert.ok(third.every(c => c.resolves !== 'crumble' && c.resolves !== 'crown'));
  const teams = ballot({ rng: 10 }, 4, '2v2', ['crown']); assert.equal(teams.length, 3); assert.ok(teams.every(c => c.resolves !== 'park'));
});

type Gamer = Pick<PublicUser, 'id' | 'name' | 'bot' | 'game'>;
class Wire<T> {
  queue: { at: number; msg: T }[] = [];
  constructor(private clock: () => number, private delay: () => number, private deliver: (msg: T) => void) {}
  send(msg: T) { this.queue.push({ at: Math.max(this.clock() + this.delay(), this.queue.at(-1)?.at ?? 0), msg: structuredClone(msg) }); }
  flush() { while (this.queue.length && this.queue[0].at <= this.clock()) this.deliver(this.queue.shift()!.msg); }
}
function harness(n: number, teams: boolean, leave = false) {
  let frame = 0, seed = 10, ids = 0;
  const now = () => Date.parse('2026-10-16T12:00:00Z') + frame * 1000 / 60;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const users = new Map<string, Gamer>(), wires: { flush(): void }[] = [], checks = new Map<number, Map<number, number>>();
  const all: Runner[] = [], peers = new Map<string, { u: Gamer; runner: Runner; up: Wire<ClientMsg>; down: Wire<ArcadeIncoming>; active: boolean; delivered: Map<number, Map<number, number>> }>();
  const snapshots: Extract<ServerMsg, { t: 'game_session' }>[] = [], boards: ArcadeBoards[] = [], counts = new Map<number, number>();
  const arcade = new Arcade({ now, timer: false, seed: () => {
    // Keep the original reconnect/elimination coverage on the first two games as the ballot pool grows.
    let candidate = rand(); const session = [...arcade.sessions.values()][0], set = session?.set;
    if (set && set.round <= 2) {
      const wanted = set.round === 1 ? 'crumble' : 'crown';
      while (!ballot({ rng: candidate }, session.players.length, set.mode, set.played).some(card => card.resolves === wanted)) candidate = rand();
    }
    return candidate;
  }, id: () => `set-${++ids}`, user: id => users.get(id),
    broadcast(msg) { if (msg.t === 'arcade_boards') boards.push(structuredClone(msg.boards)); },
    send(id, msg) {
      if (msg.t === 'game_session') snapshots.push(structuredClone(msg));
      if (msg.t === 'game_check') { if (!checks.has(msg.epoch)) checks.set(msg.epoch, new Map()); checks.get(msg.epoch)!.set(msg.frame, msg.hash); }
      if (['game_session', 'game_event', 'game_members', 'game_check', 'game_clear'].includes(msg.t)) peers.get(id)?.down.send(msg as ArcadeIncoming);
    } });
  const connect = (id: string) => {
    const old = peers.get(id); if (old) old.active = false;
    const u = old?.u ?? { id, name: id.toUpperCase(), bot: false, game: null }; users.set(id, u);
    const peer = { u, active: true, delivered: new Map<number, Map<number, number>>() } as NonNullable<ReturnType<typeof peers.get>>;
    peer.up = new Wire(() => frame, () => rand() % 9, msg => { if (peer.active) arcade.handle(u, msg); });
    peer.runner = new Runner({ userId: id, now, transport: { send: msg => peer.up.send(msg) } }); all.push(peer.runner);
    peer.down = new Wire(() => frame, () => rand() % 9, msg => { if (peer.active) { peer.runner.receive(msg); if (msg.t === 'game_check') { if (!peer.delivered.has(msg.epoch)) peer.delivered.set(msg.epoch, new Map()); peer.delivered.get(msg.epoch)!.set(msg.frame, msg.hash); } } });
    peers.set(id, peer); wires.push(peer.up, peer.down);
    if (old) { arcade.reset(u); arcade.resend(u); } else arcade.join(u, 'one');
    return peer;
  };
  for (let i = 0; i < n; i++) connect(`p${i}`);
  const s = arcade.session(users.get('p0')!)!, screens = new Set<string>(), reconnected = new Set<string>(), games = new Set<string>();
  let armed = false, left = false, watch = false, handover = false, eliminatedReconnect = false, finish = false, common = 0;
  const compare = (peer: NonNullable<ReturnType<typeof peers.get>>) => {
    const r = peer.runner;
    const epoch = r.session?.epoch; if (epoch === undefined || r.provisionalCount) return;
    for (const [f, expected] of peer.delivered.get(epoch) ?? []) {
      const state = r.stateAt(f); if (state) { assert.equal(hash(state), expected, `epoch ${epoch}, frame ${f}`); common++; }
    }
  };
  for (; frame < 40000; frame++) {
    for (const w of wires) w.flush();
    if (!armed && frame === 30) {
      // Only place bodies for the hub ready condition; all rounds use the real shared simulation and inputs.
      const hub = s.sim as HubState; hub.teamMode = teams;
      s.players.forEach((m, i) => Object.assign(hub.players[m.slot], { x: (PARTY_PAD.x * 16 + i * 10) * SUB, y: PARTY_PAD.y * TILE - PLAYER_H, grounded: true, vx: 0, vy: 0 }));
      arcade.resend(users.get('p0')!); for (const p of s.players.slice(1)) arcade.resend(users.get(p.userId)!); armed = true;
    }
    arcade.tick(now());
    if (s.set && !watch && s.screen?.screen === 'title') { connect('watch-a'); connect('watch-b'); watch = true; }
    if (s.screen) {
      screens.add(s.screen.screen);
      const key = `${s.set?.round}:${s.screen.screen}`;
      if (!reconnected.has(key)) { connect('p0'); reconnected.add(key); }
      if (s.screen.screen === 'favourite') for (const id of ['watch-a', 'watch-b']) arcade.handle(users.get(id)!, { t: 'game_favourite', epoch: s.epoch, userId: 'p0' });
    } else if (s.set) {
      games.add(s.game);
      if (s.game === 'vote') {
        const options = s.opts as VoteOptions;
        if (users.has('watch-a')) arcade.handle(users.get('watch-a')!, { t: 'game_predict', epoch: s.epoch, userId: 'p0' });
        for (const peer of peers.values()) if (peer.active && peer.u.game?.role === 'player' && peer.runner.session?.epoch === s.epoch && peer.runner.state) {
          const state = peer.runner.state as VoteState, p = state.players[peer.runner.slot!];
          const wanted = options.ballot.findIndex(c => c.resolves === (s.set!.round === 1 ? 'crumble' : s.set!.round === 2 ? 'crown' : teams && !leave ? 'crumble' : 'park'));
          peer.runner.setLocalBits(frame % 30 === 0 ? wanted >= 0 && p.cursor !== wanted ? 2 : 16 : 0);
        }
      } else {
        if (s.game === 'crumble' && n >= 3 && !eliminatedReconnect) {
          const out = (s.sim as import('../../shared/arcade/games/crumble').CrumbleState).players.findIndex(p => p.present && !p.alive);
          const person = s.players.find(p => p.slot === out);
          if (person) { connect(person.userId); eliminatedReconnect = true; }
        }
        if (!handover && s.sim.frame > 20) { connect('p0'); handover = true; }
        if (leave && !left && s.sim.frame > 40) { arcade.leave(users.get(`p${n - 1}`)!); peers.get(`p${n - 1}`)!.active = false; left = true; }
        for (const peer of peers.values()) if (peer.active && peer.u.game?.role === 'player' && peer.runner.session?.epoch === s.epoch) {
          if (s.game === 'crown') { const p = (peer.runner.state as CrownState | null)?.players[peer.runner.slot!]; if (p) peer.runner.setLocalBits(Math.abs(p.x - 155 * SUB) < SUB ? 0 : p.x > 155 * SUB ? 1 : 2); }
          else peer.runner.setLocalBits(peer.u.id === 'p0' ? 0 : frame % 90 < 40 ? 2 : 1);
        }
      }
    }
    for (const peer of peers.values()) if (peer.active) { peer.runner.tick(); if (frame % 120 === 0) compare(peer); }
    for (const w of wires) w.flush();
    if (watch && !s.set && s.game === 'hub') { finish = true; if (frame > (counts.get(-1) ?? Infinity) + 30) break; if (!counts.has(-1)) counts.set(-1, frame); }
  }
  assert.ok(finish, `finished ${n} ${teams} ${leave}`);
  assert.deepEqual([...screens].sort(), ['awards', 'bonus', 'favourite', 'scores', 'title']); assert.ok(games.has('vote')); assert.ok(games.has('crumble')); assert.ok(games.has('crown'));
  assert.ok(handover); if (n >= 3) assert.ok(eliminatedReconnect, 'reconnect while eliminated and round still active'); assert.ok(reconnected.size >= 8); assert.ok(common > 10);
  assert.equal(all.reduce((n, r) => n + r.debug.desyncs, 0), 0);
  assert.ok(all.reduce((n, r) => n + r.debug.checks, 0) > 20);
  const data = arcade.dump(); assert.deepEqual(data.committed, ['set-1']); assert.equal(boards.length, 1);
  for (const [id, p] of Object.entries(data.week.players)) { assert.equal(p.sets.length, 1); assert.equal(p.sets[0].id, 'set-1'); if (left) assert.notEqual(id, `p${n - 1}`); }
  assert.equal(Object.keys(data.week.table).length, 0); assert.deepEqual(data.records, {});
  // No secret category or round stats are in a public set/screen before the bonus reveal.
  for (const msg of snapshots) if (msg.session?.set) { assert.equal('bonus' in msg.session.set, false); assert.equal('stats' in (msg.session.set.rounds[0] ?? {}), false); }
  const saved = arcade.dump(); arcade.tick(now() + 100); assert.deepEqual(arcade.dump().week, saved.week);
  const loaded = new Arcade({ now, timer: false, user: id => users.get(id), send() {}, broadcast() {} }); loaded.load(saved); assert.deepEqual(loaded.dump(), saved);
  return { arcade, s, users, snapshots, boards };
}
for (const [n, teams, leave] of [[2, false, false], [3, false, false], [4, false, false], [4, true, false], [4, true, true]] as const) test(`Break Set orchestration: delayed 0–8 frames, ${n}${teams ? ' 2v2' : ' FFA'}${leave ? ', leave mid-round' : ''}, reconnect every screen, one commit`, () => { harness(n, teams, leave); });

function direct(n = 3) {
  let now = Date.parse('2026-10-16T12:00:00Z'), seed = 7;
  const users = new Map<string, Gamer>(), messages: ServerMsg[] = [];
  const arcade = new Arcade({ now: () => now, timer: false, seed: () => ++seed, id: () => 'one-set', user: id => users.get(id), send(_id, m) { messages.push(structuredClone(m)); }, broadcast(m) { messages.push(structuredClone(m)); } });
  const add = (id: string) => { const u: Gamer = { id, name: id, game: null, bot: false }; users.set(id, u); arcade.join(u, 'cab'); return u; };
  const people = Array.from({ length: n }, (_, i) => add(String(i))), s = arcade.session(people[0])!;
  const tick = (ms = 100) => { now += ms; arcade.tick(now); };
  tick();
  const start = () => {
    const hub = s.sim as HubState; s.players.forEach((p, i) => Object.assign(hub.players[p.slot], { x: (PARTY_PAD.x * 16 + i * 10) * SUB, y: PARTY_PAD.y * TILE - PLAYER_H, grounded: true, vx: 0, vy: 0 }));
    hub.partyHold = 59; tick(); assert.equal(s.game, 'vote'); assert.ok(s.set);
  };
  return { arcade, people, s, users, messages, add, tick, start, time: (ms: number) => { now = ms; }, now: () => now };
}
test('Break Set commands: ignored screen inputs/menus, vote deadline, participant predictions refused, abort writes no boards', () => {
  const h = direct(2); h.start(); const watch = h.add('watch'), set = h.s.set!;
  h.arcade.handle(h.people[0], { t: 'game_predict', epoch: h.s.epoch, userId: '1' }); assert.deepEqual(set.predictions, {});
  h.arcade.handle(watch, { t: 'game_predict', epoch: h.s.epoch, userId: '0' }); assert.equal(set.predictions.watch, '0');
  h.time((h.s.opts as VoteOptions).closesAt); h.arcade.handle(watch, { t: 'game_predict', epoch: h.s.epoch, userId: '1' }); assert.equal(set.predictions.watch, '0');
  h.tick(100); assert.equal(h.s.screen?.screen, 'title');
  const epoch = h.s.epoch, snapshot = structuredClone(h.s.sim);
  h.arcade.handle(h.people[0], { t: 'game_input', epoch, seq: 5, frame: 0, bits: 63 });
  h.arcade.handle(h.people[0], { t: 'game_menu', epoch, op: 'lobby' }); h.arcade.handle(h.people[0], { t: 'game_menu', epoch, op: 'restart' });
  assert.equal(h.s.epoch, epoch); assert.deepEqual(h.s.sim, snapshot); assert.deepEqual(h.s.events, []);
  h.arcade.leave(h.people[1]); assert.equal(h.s.set, null); assert.equal(h.s.game, 'hub'); assert.deepEqual(h.arcade.dump().committed, []); assert.deepEqual(h.arcade.dump().week.players, {});
});
test('crew history: edit only in hub, reroll only once per confirmed bump, snapshotted crew survives leavers and edits', () => {
  const h = direct(); h.arcade.handle(h.people[0], { t: 'crew_name', name: 'Test Crew' }); const key = h.s.crew.key;
  assert.equal(h.s.crew.name, 'Test Crew'); assert.equal(h.arcade.dump().crews[key], 'Test Crew');
  (h.s.sim as HubState).crewBumps += 2; h.tick(); const rerolled = h.s.crew.name;
  assert.equal(rerolled, autoName(key, 2)); h.tick(); assert.equal(h.s.crew.name, rerolled);
  h.start(); assert.equal(h.s.set!.crew.name, rerolled);
  h.arcade.handle(h.people[0], { t: 'crew_name', name: 'Changed' }); assert.equal(h.s.set!.crew.name, rerolled);
  h.arcade.leave(h.people[2]); assert.equal(h.s.set!.crew.name, rerolled); assert.equal(h.s.crew.name, rerolled);
  const saved = h.arcade.dump(); h.arcade.load({ records: saved.records }); assert.deepEqual(h.arcade.records, saved.records); assert.deepEqual(h.arcade.dump().committed, []);
});
test('vote/title leave: rerun a now-ineligible selection and convert 2v2 at the next vote', () => {
  for (const title of [false, true]) {
    const h = direct(4); (h.s.sim as HubState).teamMode = true; h.start();
    if (title) h.tick(8200);
    // A future step-2 game may be 4-only: emulate that metadata on the current vote/title.
    const opts = h.s.opts as VoteOptions, old = h.s.epoch;
    if (title) h.s.screen!.data.game = 'volley';
    else opts.ballot[0].resolves = 'volley';
    h.arcade.leave(h.people[3]); assert.ok(h.s.epoch > old); assert.equal(h.s.game, 'vote'); assert.equal(h.s.screen, null); assert.equal(h.s.set?.mode, 'ffa');
    assert.ok((h.s.opts as VoteOptions).ballot.every(c => c.resolves !== 'volley')); assert.equal(h.s.set?.players[3].left, true);
  }
});
test('boards: best ten, all contributions idempotent by set id, commit week and rollover survive restart', () => {
  const h = direct(2), week = emptyWeek(weekKey(h.now()));
  week.players['0'] = { name: '0', sets: Array.from({ length: 10 }, (_, i) => ({ id: `old-${i}`, total: i })) };
  h.arcade.load({ week, committed: [], records: {} }); h.start();
  const set = h.s.set!;
  set.points = { 0: 20, 1: 4 }; set.rounds = [result([['0'], ['1']])]; set.rounds[0].predictions = ['oracle'];
  // Board commit is the end of the awards epoch. Drive that boundary, keeping the real commit code private.
  h.s.screen = { kind: 'screen', screen: 'awards', until: h.now(), data: {} }; h.tick();
  assert.equal(h.arcade.dump().week.players['0'].sets.length, 10); assert.equal(weeklyTotal(h.arcade.dump().week.players['0']), 65);
  assert.equal(h.arcade.dump().week.champions.crumble?.['0'], 1); assert.equal(h.arcade.dump().week.oracle.oracle, 1);
  h.s.set = structuredClone(set); h.s.screen = { kind: 'screen', screen: 'awards', until: h.now(), data: {} }; h.tick();
  assert.equal(h.arcade.dump().week.champions.crumble?.['0'], 1); assert.equal(h.arcade.dump().week.oracle.oracle, 1);
  const saved = h.arcade.dump(); h.arcade.load(saved); assert.deepEqual(h.arcade.dump(), saved);
  h.time(Date.parse('2026-10-19T00:00:00Z')); const boards = h.arcade.boards(); assert.deepEqual(h.arcade.dump().committed, []); assert.equal(boards.hall[0].points, 65);
  assert.equal(boards.week.key, '2026-10-19');
});
test('favourite: frozen eligible spectators, last vote wins, public counts, participant/leaver and late votes refused', () => {
  const h = direct(3); h.start(); const a = h.add('watch-a'), b = h.add('watch-b'); const set = h.s.set!;
  h.s.screen = { kind: 'screen', screen: 'favourite', until: h.now() + 8000, data: { candidates: ['0', '1', '2'], voters: [a.id, b.id], votes: {} } };
  const epoch = h.s.epoch;
  h.arcade.handle(a, { t: 'game_favourite', epoch, userId: '0' }); h.arcade.handle(a, { t: 'game_favourite', epoch, userId: '1' });
  h.arcade.handle(b, { t: 'game_favourite', epoch, userId: '1' }); assert.deepEqual(h.s.screen.data.votes, { 0: 0, 1: 2, 2: 0 });
  h.arcade.handle(h.people[0], { t: 'game_favourite', epoch, userId: '0' }); assert.equal(set.favourite['0'], undefined);
  const late = h.add('late'); h.arcade.handle(late, { t: 'game_favourite', epoch, userId: '0' }); assert.equal(set.favourite.late, undefined);
  h.time(h.s.screen.until); h.arcade.handle(a, { t: 'game_favourite', epoch, userId: '0' }); assert.equal(set.favourite[a.id], '1');
  h.tick(0); assert.equal(h.s.screen.screen, 'bonus'); assert.equal(set.points['1'], 1);
});

test('2v2 leave during vote/title reruns the vote as FFA even when both remaining games support 3-player FFA', () => {
  for (const title of [false, true]) {
    const h = direct(4); (h.s.sim as HubState).teamMode = true; h.start(); if (title) h.tick(8200);
    const old = h.s.epoch; h.arcade.leave(h.people[3]); assert.ok(h.s.epoch > old); assert.equal(h.s.game, 'vote'); assert.equal(h.s.set?.mode, 'ffa');
  }
});
