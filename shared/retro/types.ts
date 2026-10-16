import type { RetroGameId } from './games';
export interface RetroEntry { userId: string; name: string; score: number; time?: number; at: number }
export interface RetroBoard { all: Record<string, RetroEntry>; week: Record<string, RetroEntry> }
export interface RetroBoards { week: string; games: Record<RetroGameId, Record<string, RetroBoard>> }
export interface RetroResult { game: RetroGameId; track: string; score: number; time?: number; best: boolean; weekRank: number; allRank: number }
export interface RetroCabinet { cabinet: string; game: RetroGameId; player: string | null; watchers: number; broken?: true }
export type RetroView =
  | { kind: 'vacant'; cabinet: string; game: RetroGameId }
  | { kind: 'starting'; cabinet: string; game: RetroGameId; player: string }
  | { kind: 'playing'; cabinet: string; game: RetroGameId; runId: string; sync: number; player: string;
      role: 'player' | 'spectator'; save: string | null; snapshot: string | null; upto: number; bits: number; serverNow: number };
