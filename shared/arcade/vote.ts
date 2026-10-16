import { random } from './rng';
import type { BaseState, GameDef, GameId, RosterEntry } from './types';
export interface VoteCard { game: GameId | 'surprise'; resolves: GameId; opts: unknown }
export interface VoteOptions { ballot: VoteCard[]; closesAt: number }
export interface VoteState extends BaseState { rng: number; ballot: VoteCard[]; players: { present: boolean; cursor: number; confirmed: number; bits: number; prevBits: number }[] }
export const vote: GameDef<VoteState, VoteOptions> = {
  id: 'vote', name: 'Pick a game', goal: 'Move a cursor and jump to vote. Change your mind until time is up.', controls: ['move', 'jump'], players: [2, 4], modes: { ffa: [2, 3, 4], teams: true },
  init(seed, roster: RosterEntry[], opts) { return { frame: 0, fx: [], outcome: null, rng: seed, ballot: structuredClone(opts.ballot), players: Array.from({ length: 4 }, (_, slot) => ({ present: roster.some(p => p.slot === slot), cursor: 0, confirmed: -1, bits: 0, prevBits: 0 })) }; },
  step(s, events) {
    s.fx = [];
    for (const [, slot, kind, bits] of events) {
      const p = s.players[slot]; if (!p) continue;
      if (kind === 2) { p.present = false; p.bits = 0; p.confirmed = -1; }
      if (kind === 3) p.bits = p.prevBits = 0;
      if (kind === 0 && p.present) p.bits = bits & 63;
    }
    if (s.outcome) { s.frame++; return; }
    if (s.frame < 480) for (const [slot, p] of s.players.entries()) if (p.present) {
      const edge = p.bits & ~p.prevBits;
      if (edge & 3) { p.cursor = (p.cursor + (edge & 1 ? -1 : 1) + s.ballot.length) % s.ballot.length; s.fx.push({ frame: s.frame, slot, kind: 'select' }); }
      if (edge & 16) { p.confirmed = p.cursor; s.fx.push({ frame: s.frame, slot, kind: 'vote' }); }
      p.prevBits = p.bits;
    }
    if (++s.frame === 480) {
      const counts = s.ballot.map((_, i) => s.players.filter(p => p.present && p.confirmed === i).length), max = Math.max(...counts);
      const tied = counts.flatMap((n, i) => n === max ? [i] : []);
      s.outcome = { order: [], stats: {}, signal: { kind: 'vote', card: tied[random(s) % tied.length] } };
    }
  }, bits: (s, slot) => s.players[slot]?.bits ?? 0,
};
