import type { Dir, Move, Tile } from './map';

export type Presence = 'online' | 'away' | 'in_call' | 'offline';
export type Emote = 'knock' | null;

export interface Look { skin: string; hair: string; shirt: string; pants: string; style: number }

export interface PublicUser {
  id: string; name: string; look: Look;
  tile: Tile; dir: Dir; move: Move | null;
  presence: Presence; status: string; emote: Emote; bot: boolean;
}

export interface Knock {
  id: string; fromId: string; toId: string;
  state: 'walking' | 'pending' | 'accept' | 'later' | 'blocked';
}

// server -> client
export type ServerMsg =
  | { t: 'hello'; you: string; serverTime: number }
  | { t: 'state'; users: PublicUser[]; serverTime: number }
  | { t: 'move'; userId: string; from: Tile; to: Tile; startedAt: number; path?: Tile[]; face?: Dir }
  | { t: 'status'; userId: string; status: string }
  | { t: 'presence'; userId: string; presence: Presence }
  | { t: 'emote'; userId: string; emote: Emote }
  | { t: 'knock'; knockId: string; fromId: string; toId: string }
  | { t: 'knock_reply'; knockId: string; fromId: string; toId: string; reply: 'accept' | 'later' | 'blocked'; link?: string; reason?: string };

// client -> server
export type ClientMsg =
  | { t: 'move'; to: Tile }
  | { t: 'status'; status: string }
  | { t: 'presence'; presence: Exclude<Presence, 'offline'> }
  | { t: 'knock'; targetId: string }
  | { t: 'knock_reply'; knockId: string; reply: 'accept' | 'later' };
