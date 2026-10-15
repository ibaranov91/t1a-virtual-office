import type { ParkState } from './sim';

export const PARK_FPS = 60, PARK_INPUT_DELAY = 2, PARK_SERVER_LAG = 6, PARK_SPECTATOR_DELAY = 9, PARK_MAX_PLAYERS = 4;
export type GameRole = 'player' | 'spectator';
export type GameEvent = [frame: number, slot: number, kind: 0 | 1 | 2 | 3, bits: number];
export interface GameMember { userId: string; slot: number }
export interface GameClear { frames: number; coins: number; record: boolean }
export interface PublicSession {
  cabinet: string; epoch: number; phase: 'lobby' | 'level' | 'clear'; level: number;
  startAt: number; serverNow: number; players: GameMember[]; spectators: string[];
  teamSize: number; clear?: GameClear; snapshot: ParkState; events: GameEvent[];
}
export type ParkIncoming =
  | { t: 'game_session'; session: PublicSession | null; reason?: 'empty' | 'elsewhere' }
  | { t: 'game_event'; epoch: number; ev: GameEvent; seq?: number }
  | { t: 'game_members'; epoch: number; players: GameMember[]; spectators: string[] }
  | { t: 'game_check'; epoch: number; frame: number; hash: number; serverNow: number }
  | ({ t: 'game_clear'; epoch: number } & GameClear);
export type ParkOutgoing =
  | { t: 'game_input'; epoch: number; seq: number; frame: number; bits: number }
  | { t: 'game_sync'; epoch: number };
