import type { Dir, Move, Tile } from './map';

export type Presence = 'online' | 'away' | 'in_call' | 'offline';
export type Emote = 'knock' | null;
/** Coming and going through the exit door: arrive bag in hand; when disconnected, think for a moment
 *  (they may be back), then grab the bag and walk out. */
export type Door = 'arriving' | 'thinking' | 'leaving' | null;

/** A reusable Google Meet room link, e.g. https://meet.google.com/abc-defg-hij */
export const MEET_LINK_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
export const normalizeMeetLink = (raw: string) => {
  let s = raw.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(s)) s = `https://meet.google.com/${s}`;
  if (s.startsWith('meet.google.com/')) s = `https://${s}`;
  return MEET_LINK_RE.test(s) ? s : null;
};

/** A Meet link opened as this Google account. A bare link uses the browser's default account, and if that
 *  isn't the one that made the room (say a personal Gmail), Meet treats you as a guest: "Ask to join". */
export const meetAs = (link: string, email?: string | null) => {
  if (!email) return link;
  try {
    const u = new URL(link);
    if (u.hostname !== 'meet.google.com') return link;
    u.searchParams.set('authuser', email);
    return u.toString();
  } catch { return link; }
};

export interface Look { skin: string; hair: string; shirt: string; pants: string; style: number }

export interface PublicUser {
  id: string; name: string; look: Look;
  tile: Tile; dir: Dir; move: Move | null;
  presence: Presence; status: string; emote: Emote; bot: boolean; door: Door;
  homeDesk: Tile | null;
  callId: string | null; // in a knock-started call; everyone with the same callId is talking together
  muted: boolean;        // mic muted in that call
  following: string | null; // walks along with this person
  holding: string | null;   // a UseItem id (coffee, snack…) in hand for a while
}

/** Quick reactions you can toss at someone; they float up over their head for everyone to see. */
export const REACTIONS = ['👋', '👍', '❤️', '😂', '🎉', '☕'] as const;
export type Reaction = typeof REACTIONS[number];

/** A direct message. Only ever sent to the two people in the conversation. */
export interface ChatMsg { id: string; fromId: string; toId: string; text: string; at: number }
export const MAX_CHAT_LEN = 500;

/** Built-in voice calls are peer-to-peer; keep them small. Bigger groups go to Meet. */
export const MAX_CALL_SIZE = 5;

/** WebRTC signaling payload, relayed by the server between members of the same call. */
export type RtcSignal =
  // conn: one connection attempt (chosen by the offerer); inst: one page's voice session.
  // They let each side drop replies meant for an older attempt or an old page.
  | { kind: 'hello'; inst: string } // a fresh page joining (or rejoining) the call asks the offerer to (re)connect
  | { kind: 'offer'; sdp: string; conn: string }
  | { kind: 'answer'; sdp: string; conn: string; inst: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null; conn: string };

export interface Knock {
  id: string; fromId: string; toId: string;
  state: 'walking' | 'pending' | 'accept' | 'later' | 'blocked';
}

// server -> client
export type ServerMsg =
  | { t: 'hello'; you: string; serverTime: number; build?: string } // build: the client bundle the server serves (absent in dev)
  | { t: 'state'; users: PublicUser[]; objects: Record<string, { on: boolean }>; serverTime: number }
  | { t: 'move'; userId: string; from: Tile; to: Tile; startedAt: number; path?: Tile[]; face?: Dir }
  | { t: 'status'; userId: string; status: string }
  | { t: 'presence'; userId: string; presence: Presence }
  | { t: 'emote'; userId: string; emote: Emote }
  | { t: 'door'; userId: string; door: Door }
  | { t: 'knock'; knockId: string; fromId: string; toId: string }
  | { t: 'knock_reply'; knockId: string; fromId: string; toId: string; reply: 'accept' | 'later' | 'blocked'; link?: string; reason?: string; fallback?: boolean; cancelled?: boolean }
  | { t: 'me'; meetLink: string; email?: string } // private settings, only to the user themselves
  | { t: 'desk'; userId: string; desk: Tile | null }
  | { t: 'call'; userId: string; callId: string | null; link?: string } // link: the call's Meet room, only to members
  | { t: 'rtc'; from: string; signal: RtcSignal }
  | { t: 'speaking'; userId: string; on: boolean }
  | { t: 'mute'; userId: string; muted: boolean }
  | { t: 'to_meet'; fromId: string } // someone in your call opened its Meet room; come along
  | { t: 'follow'; userId: string; targetId: string | null }
  | { t: 'holding'; userId: string; item: string | null; objectId?: string; fromId?: string } // objectId: just taken; fromId: handed over
  | { t: 'object'; id: string; on: boolean; by: string }
  | { t: 'react'; fromId: string; toId: string; emoji: Reaction }
  | { t: 'chat'; msg: ChatMsg }
  | { t: 'chat_history'; withId: string; messages: ChatMsg[] };

// client -> server
export type ClientMsg =
  | { t: 'move'; to: Tile }
  | { t: 'status'; status: string }
  | { t: 'presence'; presence: Exclude<Presence, 'offline'> }
  | { t: 'knock'; targetId: string }
  | { t: 'knock_reply'; knockId: string; reply: 'accept' | 'later' }
  | { t: 'knock_cancel'; knockId: string } // the knocker calls it back: closes the prompt for both
  | { t: 'meet_link'; link: string }
  | { t: 'claim_desk' }   // the seat you're sitting on becomes your home desk
  | { t: 'release_desk' }
  | { t: 'end_call' }
  | { t: 'to_meet' } // I'm opening our call's Meet room: tell the others
  | { t: 'rtc'; to: string; signal: RtcSignal }
  | { t: 'speaking'; on: boolean }
  | { t: 'mute'; muted: boolean }
  | { t: 'follow'; targetId: string | null }
  | { t: 'react'; targetId: string; emoji: Reaction }
  | { t: 'chat'; toId: string; text: string }
  | { t: 'chat_history'; withId: string }
  | { t: 'use'; objectId: string; item?: string } // walk over to an object and use it
  | { t: 'drop' }                    // finish what you're holding
  | { t: 'give'; targetId: string }; // hand it to someone with empty hands
