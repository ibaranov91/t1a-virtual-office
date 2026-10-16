export const PARK_FPS = 60, PARK_INPUT_DELAY = 2, PARK_SERVER_LAG = 6, PARK_SPECTATOR_DELAY = 9, PARK_MAX_PLAYERS = 4;
export type GameId = 'hub' | 'vote' | 'park' | 'quiver' | 'screenrun' | 'volley' | 'crumble' | 'crown' | 'trails' | 'skylanes';
export type GameRole = 'player' | 'spectator';
export type GameEvent = [frame: number, slot: number, kind: 0 | 1 | 2 | 3, bits: number];
export interface GameMember { userId: string; slot: number }
export interface RosterEntry extends GameMember { team: 0 | 1 | null }
export interface Fx { frame: number; kind: string; slot: number }
export interface BaseState { frame: number; fx: Fx[]; outcome: Outcome | null }
export type StatKey = 'kills' | 'deaths' | 'falls' | 'stomped' | 'stomps' | 'airFrames' | 'distance' | 'holdFrames' | 'coins' | 'steals' | 'points' | 'height' | 'tiles' | 'survivedFrames' | 'shoves' | 'spikes' | 'personal';
export type Stats = Partial<Record<StatKey, number>>;
export type Signal = { kind: 'hub'; start: 'party' | 'coop'; level: number; teamMode: boolean } | { kind: 'vote'; card: number } | { kind: 'park'; cleared: boolean };
export interface Outcome { order: number[][]; stats: Record<number, Stats>; signal?: Signal }
export interface GameDef<S extends BaseState, O = unknown> {
  id: GameId; name: string; goal: string; controls: ('move' | 'aim' | 'jump' | 'action')[];
  players: [number, number]; modes: { ffa: number[]; teams: boolean };
  init(seed: number, roster: RosterEntry[], opts: O): S;
  step(s: S, events: GameEvent[]): void;
  bits(s: S, slot: number): number;
}
/** Type-erased boundary used by the registry; simulations retain concrete state types inside their modules. */
export type AnyGameDef = GameDef<BaseState>;
export function define<S extends BaseState, O>(def: GameDef<S, O>): AnyGameDef {
  return { ...def, init: (seed, roster, opts) => def.init(seed, roster, opts as O),
    step: (s, ev) => def.step(s as S, ev), bits: (s, slot) => def.bits(s as S, slot) };
}
export interface GameClear { frames: number; coins: number; record: boolean }
export interface ParkRecord { frames: number; coins: number; names: string[]; at: number; crew?: string }
export type ParkRecords = Record<number, Partial<Record<1 | 2 | 3 | 4, ParkRecord>>>;
export interface PublicRoundResult { game: GameId; order: string[][]; points: Record<string, number>; underdog: string[]; final: boolean }
export interface RoundResult extends PublicRoundResult { stats: Record<string, Stats>; predictions: string[] }
export interface SetPlayer extends RosterEntry { left: boolean }
export interface PublicBreakSet { id: string; round: number; mode: 'ffa' | '2v2'; players: SetPlayer[]; points: Record<string, number>; rounds: PublicRoundResult[] }
export interface BreakSet extends Omit<PublicBreakSet, 'rounds'> {
  crew: { key: string; name: string }; rounds: RoundResult[]; played: GameId[]; bonus: StatKey[];
  predictions: Record<string, string>; favourite: Record<string, string>;
}
export type AwardId = 'MVP' | 'Sharpshooter' | 'Most Reckless' | 'Frequent Flyer' | 'Hoarder' | 'Doormat' | 'First Out' | 'Comeback Kid' | 'Steak in Mouth' | 'Photo Finish' | 'Consolation Prize';
export interface Bonus { category: StatKey; winners: string[]; value: number }
export interface ScreenData {
  game?: GameId; opts?: unknown; round?: number; result?: PublicRoundResult; predictions?: string[];
  totals?: Record<string, number>; candidates?: string[]; voters?: string[]; votes?: Record<string, number>;
  bonus?: Bonus | null; favourite?: string[]; standings?: string[][]; awards?: Record<string, AwardId[]>;
  clear?: GameClear;
}
export interface SimView<S extends BaseState = BaseState> { kind: 'sim'; game: GameId; seed: number; opts: unknown; roster: RosterEntry[]; startAt: number; snapshot: S; events: GameEvent[] }
export interface ScreenView { kind: 'screen'; screen: 'title' | 'scores' | 'favourite' | 'bonus' | 'awards'; until: number; data: ScreenData }
export type SessionView<S extends BaseState = BaseState> = SimView<S> | ScreenView;
export interface PublicSession<S extends BaseState = BaseState> {
  cabinet: string; epoch: number; serverNow: number; players: GameMember[]; spectators: string[];
  crew: { key: string; name: string }; view: SessionView<S>; set: PublicBreakSet | null;
}
export interface CabinetSummary { cabinet: string; phase: 'lobby' | 'level' | 'clear' | 'set'; level: number; game: GameId; round?: number; players: string[]; spectators: number }
export interface Week {
  key: string; players: Record<string, { name: string; sets: { id: string; total: number }[] }>;
  champions: Partial<Record<GameId, Record<string, number>>>; oracle: Record<string, number>; table: Record<string, Record<string, number>>;
}
export interface ArcadeBoards { records: ParkRecords; week: Week; hall: { week: string; userId: string; name: string; points: number }[] }
export type ArcadeIncoming =
  | { t: 'game_session'; session: PublicSession | null; reason?: 'empty' | 'elsewhere' }
  | { t: 'game_event'; epoch: number; ev: GameEvent; seq?: number }
  | { t: 'game_members'; epoch: number; players: GameMember[]; spectators: string[] }
  | { t: 'game_check'; epoch: number; frame: number; hash: number; serverNow: number }
  | ({ t: 'game_clear'; epoch: number } & GameClear);
export type ArcadeOutgoing = { t: 'game_input'; epoch: number; seq: number; frame: number; bits: number } | { t: 'game_sync'; epoch: number };
