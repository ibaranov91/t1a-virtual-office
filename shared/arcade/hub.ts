import { LEVELS } from '../park/levels';
import { parkInit, parkStep, TILE, PLAYER_H, PLAYER_W, type ParkState, type LevelDef } from '../park/sim';
import type { GameDef } from './types';
export const HUB_LEVEL: LevelDef = { ...LEVELS[0], name: 'Arcade', lobby: { ...LEVELS[0].lobby!, start: { x: 11, y: 11, w: 3, h: 1 }, selectors: [
  ...LEVELS[0].lobby!.selectors,
  { x: 9, y: 7, w: 2, h: 1, delta: 0, kind: 'crew' },
  { x: 16, y: 7, w: 1, h: 1, delta: 0, kind: 'mode' },
] } };
export const PARTY_PAD = { x: 6, y: 11, w: 3, h: 1 }, COOP_PAD = HUB_LEVEL.lobby!.start;
export interface HubState extends ParkState { partyHold: number }
export const hub: GameDef<HubState, { selected?: number }> = {
  id: 'hub', name: 'Arcade hub', goal: 'All on PARTY for a Break Set, or CO-OP for Deck Park.', controls: ['move', 'jump'], players: [1, 4], modes: { ffa: [1, 2, 3, 4], teams: false },
  init(_seed, _roster, opts) { return { ...parkInit(HUB_LEVEL, opts.selected ?? 1), partyHold: 0 }; },
  step(s, events) {
    const terminal = !!s.outcome;
    // The mode block only exists with four occupants, including on the join frame.
    const present = new Set(s.players.flatMap((p, slot) => p.present ? [slot] : []));
    for (const [, slot, kind] of events) { if (kind === 1) present.add(slot); if (kind === 2) present.delete(slot); }
    const level = present.size === 4 ? HUB_LEVEL : { ...HUB_LEVEL, lobby: { ...HUB_LEVEL.lobby!, selectors: HUB_LEVEL.lobby!.selectors.filter(r => r.kind !== 'mode') } };
    parkStep(s, level, events); if (terminal) return;
    const players = s.players.filter(p => p.present), pad = PARTY_PAD;
    const ready = players.length >= 2 && players.every(p => !p.dead && !p.entered && p.grounded && p.y + PLAYER_H === pad.y * TILE && p.x < (pad.x + pad.w) * TILE && p.x + PLAYER_W > pad.x * TILE);
    s.partyHold = ready ? s.partyHold + 1 : 0;
    if (s.startReady || s.partyHold >= 60) s.outcome = { order: [], stats: {}, signal: { kind: 'hub', start: s.startReady ? 'coop' : 'party', level: s.selected, teamMode: players.length === 4 && s.teamMode } };
  }, bits: (s, slot) => s.players[slot]?.bits ?? 0,
};
