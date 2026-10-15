import type { Dir, Move, Tile } from './map';

export const ROOM_VOICE_MAX = 12;
export const EARSHOT_TILES = 5;
export const AFK_MS = 10 * 60_000;
export type CallRole = 'member' | 'listener';
/** A map object's shared state. volume: only for objects with a sound — one knob everybody hears (0..1). */
export interface ObjectState { on: boolean; volume?: number }

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
  callId: string | null;
  callRole: CallRole | null; deafened: boolean; hand: boolean;
  muted: boolean;        // mic muted in that call
  following: string | null; // walks along with this person
  holding: string | null;   // a UseItem id (coffee, snack…) in hand for a while
}

/** Quick reactions you can toss at someone; they float up over their head for everyone to see. */
export const REACTIONS = ['👋', '👍', '❤️', '😂', '🎉', '☕'] as const;
export type Reaction = typeof REACTIONS[number];

/** One event from your own Google Calendar. start/end: ISO date-time, or YYYY-MM-DD for all-day events. */
export interface CalEvent { id: string; title: string; start: string; end: string; allDay: boolean; link: string; meet?: string; declined?: boolean }

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
  | { t: 'state'; users: PublicUser[]; objects: Record<string, ObjectState>; serverTime: number }
  | { t: 'move'; userId: string; from: Tile; to: Tile; startedAt: number; path?: Tile[]; face?: Dir }
  | { t: 'status'; userId: string; status: string }
  | { t: 'presence'; userId: string; presence: Presence }
  | { t: 'emote'; userId: string; emote: Emote }
  | { t: 'door'; userId: string; door: Door }
  | { t: 'knock'; knockId: string; fromId: string; toId: string }
  | { t: 'knock_reply'; knockId: string; fromId: string; toId: string; reply: 'accept' | 'later' | 'blocked'; link?: string; reason?: string; fallback?: boolean; cancelled?: boolean }
  // private settings, only to the user themselves. google: the connected Google account (null = not connected),
  // absent when this instance has no Google sign-in
  | { t: 'me'; meetLink: string; email?: string; google?: string | null; calendar?: boolean } // calendar: Calendar access granted
  | { t: 'google_auth'; url: string; calendar?: boolean } // open this to connect Google (in the system browser from the Mac app)
  | { t: 'calendar'; events?: CalEvent[]; error?: string } // my own events, only to me
  | { t: 'desk'; userId: string; desk: Tile | null }
  | { t: 'call'; userId: string; callId: string | null; role?: CallRole; link?: string } // link: the call's Meet room, only to members
  | { t: 'rtc'; from: string; signal: RtcSignal }
  | { t: 'speaking'; userId: string; on: boolean }
  | { t: 'mute'; userId: string; muted: boolean }
  | { t: 'to_meet'; fromId: string } // someone in your call opened its Meet room; come along
  | { t: 'follow'; userId: string; targetId: string | null }
  | { t: 'holding'; userId: string; item: string | null; objectId?: string; fromId?: string } // objectId: just taken; fromId: handed over
  | { t: 'object'; id: string; on: boolean; volume?: number; by: string }
  | { t: 'react'; fromId: string; toId: string; emoji: Reaction }
  | { t: 'chat'; msg: ChatMsg }
  | { t: 'chat_history'; withId: string; messages: ChatMsg[] }
  | { t: 'deafen'; userId: string; on: boolean }
  | { t: 'hand'; userId: string; up: boolean }
  | { t: 'notice'; text: string }
  | { t: 'voice_wait'; roomId: string | null }
  | { t: 'voice_owner'; owner: boolean };

// client -> server
export type ClientMsg =
  | { t: 'move'; to: Tile }
  | { t: 'status'; status: string }
  | { t: 'presence'; presence: Exclude<Presence, 'offline'> }
  | { t: 'knock'; targetId: string }
  | { t: 'knock_reply'; knockId: string; reply: 'accept' | 'later' }
  | { t: 'knock_cancel'; knockId: string } // the knocker calls it back: closes the prompt for both
  | { t: 'meet_link'; link: string }
  | { t: 'google_connect'; calendar?: boolean } // asks for a google_auth URL; calendar: also ask for Calendar access
  | { t: 'calendar'; from: string } // my events for a week from `from` (ISO, the start of my local day)
  | { t: 'google_disconnect' }
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
  | { t: 'give'; targetId: string } // hand it to someone with empty hands
  | { t: 'deafen'; on: boolean }
  | { t: 'hand'; up: boolean }
  | { t: 'leave_room' }
  | { t: 'voice_claim' }
  | { t: 'object_volume'; id: string; volume: number } // a sound object's shared volume knob (the radio); only standing next to it;
