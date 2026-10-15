import type { GameRole, ParkIncoming, ParkOutgoing } from './park/types';
export { PARK_FPS, PARK_INPUT_DELAY, PARK_SERVER_LAG, PARK_SPECTATOR_DELAY, PARK_MAX_PLAYERS } from './park/types';
export type { GameRole, GameEvent, GameMember, GameClear, PublicSession } from './park/types';

export interface ParkRecord { frames: number; coins: number; names: string[]; at: number }
export type ParkRecords = Record<number, Partial<Record<1 | 2 | 3 | 4, ParkRecord>>>;
export interface CabinetSummary { cabinet: string; phase: 'lobby' | 'level' | 'clear'; level: number; players: string[]; spectators: number }

import type { Dir, Layout, Move, Tile } from './map';

export const NOTE_RATE = 40;
export const NOTE_BURST = 64;
export const NOTE_HELD_MAX = 32;
export const SEAT_CHANGES_PER_10S = 6;

export const JUKEBOX_QUEUE_MAX = 20;
export const JUKEBOX_PER_PERSON = 3;
export interface JukeboxEntry { id: string; track: string; by: string }
export interface JukeboxState {
  playId: string; track: string; by: string | null; startedAt: number; pausedAt: number | null;
  queue: JukeboxEntry[];
  last: { kind: 'pause' | 'play' | 'skip'; by: string; at: number } | null;
}
export type JukeboxAction =
  | { action: 'queue'; track: string }
  | { action: 'unqueue'; entry: string }
  | { action: 'pause' | 'play' | 'skip'; playId: string };
export const DUNGEON_INSTANCE = 'dungeon';
export const underground = (u: { instance: string | null }) => u.instance === DUNGEON_INSTANCE;

export const ROOM_VOICE_MAX = 12;
export const AFK_MS = 10 * 60_000;
/** A toilet stall in Berghain: up to TOILET_CAPACITY people inside (`in`), the rest line up outside (`queue`), and
 *  how many visits since it was last cleaned. At TOILET_FULL it overflows: nobody gets in until it drains (one level per
 *  TOILET_DRAIN_MS) or an admin plunges it. `shelf`: lines racked on its little shelf (cleared when it empties). */
export interface ToiletState { fill: number; in: string[]; queue: string[]; shelf: number }
export const TOILET_CAPACITY = 4;
export const TOILET_FULL = 8;
export const TOILET_USE_MS = 45_000;
export const TOILET_DRAIN_MS = 3 * 60_000;
export const TOILET_SHELF_MAX = 4;
/** What racking a line on the shelf takes from your inventory (the bouncer sells it). */
export const TOILET_SHELF_ITEM = 'drugs';
export const ITEMS_MAX = 3; // of one kind in your inventory
export const toiletFull = (s?: ToiletState) => !!s && s.fill >= TOILET_FULL;
/** A toggle object's shared state. */
export interface ObjectState { on: boolean }

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

/** Everyone's desk plant. It grows one stage on each day you set a status and withers after a week without one.
 *  care: the last day (UTC day number) it was tended. kind: which flower it turns into (random when planted);
 *  absent on plants from before kinds existed, which grow into the original flowering bush. */
export interface Plant { stage: number; care: number; kind?: PlantKind }
export const PLANT_STAGES = ['just planted', 'sprouting', 'growing', 'leafy', 'budding', 'in bloom'] as const;
export const PLANT_DIES_DAYS = 7;
export const PLANT_KINDS = ['tulip_red', 'tulip_yellow', 'tulip_pink', 'daisy', 'sunflower', 'cactus', 'lavender'] as const;
export type PlantKind = typeof PLANT_KINDS[number];
const KIND_NAMES: Record<PlantKind | 'bush', string> = {
  bush: 'flowering bush', tulip_red: 'red tulip', tulip_yellow: 'yellow tulip', tulip_pink: 'pink tulip',
  daisy: 'daisy', sunflower: 'sunflower', cactus: 'cactus', lavender: 'lavender',
};
export const PLANT_REVEAL = 3; // every plant is the same seedling until this stage: what it becomes is a surprise
export const plantName = (p: Plant) => (p.stage >= PLANT_REVEAL ? KIND_NAMES[p.kind ?? 'bush'] : 'seedling');
export const kindName = (k: string) => KIND_NAMES[k as PlantKind] ?? k;
export const dayNumber = (ms: number) => Math.floor(ms / 86_400_000);
export const plantDead = (p: Plant, now: number) => dayNumber(now) - p.care >= PLANT_DIES_DAYS;

/** Badges, shown on the Achievements board. Earned ones are kept per person with when they were earned.
 *  soon: announced but not earnable yet. */
export interface Achievement { id: string; icon: string; title: string; how: string; goal?: number; soon?: boolean; secret?: string }
export const BOTANIST_KINDS = 3;
export const ACHIEVEMENTS: Achievement[] = [
  { id: 'tended', icon: '💧', title: 'Green fingers', how: 'Set a status on a new day. Each day you do, your plant grows one stage.' },
  { id: 'bloom', icon: '🌸', title: 'In bloom', how: `Grow your plant all the way: set a status on ${PLANT_STAGES.length - 1} more days, never ${PLANT_DIES_DAYS} days apart.` },
  { id: 'botanist', icon: '🌻', title: 'Botanist', how: `Bloom ${BOTANIST_KINDS} different flowers. A plant that withers is replanted as a new, random one.`, goal: BOTANIST_KINDS },
  { id: 'escape', icon: '🗝️', title: 'Escape artist', how: 'Found the way out of the place under the garden.', secret: 'Something about a corner of the garden isn\'t quite right.' },
  { id: 'event', icon: '🎉', title: 'Party person', how: 'Be in the office during an office event.', soon: true },
];

export interface Look { skin: string; hair: string; shirt: string; pants: string; eyes: string; shoes: string; glassesColor: string; hatColor: string; style: number; top: number; bottom: number; glasses: number; hat: number }

/** A buff, debuff or hat on a person (see shared/effects.ts). until: when it wears off (ms); absent = until removed. */
export interface Effect { kind: string; until?: number; data?: Record<string, unknown> }

export interface PublicUser {
  id: string; name: string; look: Look;
  lookSet: boolean;
  tile: Tile; dir: Dir; move: Move | null;
  presence: Presence; status: string; emote: Emote; bot: boolean; door: Door;
  homeDesk: Tile | null;
  callId: string | null;
  game: { cabinet: string; role: GameRole } | null;
  deafened: boolean; hand: boolean;
  muted: boolean;        // mic muted in that call
  following: string | null; // walks along with this person
  holding: string | null;   // a UseItem id (coffee, snack…) in hand for a while
  meeting: number | null;   // in a calendar meeting until then (ms); knocks go to Later
  instance: string | null;  // meeting room or dungeon: only people in the same instance see each other
  plant: Plant | null;      // on their home desk, or in the Orangery if they have none
  bloomed: string[];        // plant kinds they've grown to full bloom
  achievements: Record<string, number>; // achievement id → when it was earned (ms)
  effects: Effect[];        // buffs, debuffs, hats; the server adds, expires and broadcasts them
}

/** Office animals and helpers. Not people: never in the user list, never knock, never counted.
 *  ms: milliseconds per tile of the current walk (they amble, fly or drift at their own pace). */
export type CreatureKind = 'cat' | 'dog' | 'bat' | 'cleaner';
export type CreaturePose = 'idle' | 'sit' | 'nap' | 'clean' | 'hang';
export interface Creature {
  id: string; kind: CreatureKind; name: string;
  tile: Tile; dir: Dir; pose: CreaturePose;
  walk: { path: Tile[]; startedAt: number; ms: number } | null;
}
/** A cup someone left on a table; the cleaner takes it away. */
export interface Cup { id: string; tile: Tile; item: string; at: number }
export const MAX_CUPS = 12;
export const CUP_ITEMS = ['coffee', 'tea'];
/** Furniture you can put a cup on. */
export const CUP_TABLES = ['table_long', 'table_round', 'table_big', 'desk', 'counter'];
export const cupTableAt = <O extends { type: string; x: number; y: number; w: number; h: number }>(objects: O[], t: Tile) =>
  objects.find(o => CUP_TABLES.includes(o.type) && t.x >= o.x && t.x < o.x + o.w && t.y >= o.y && t.y < o.y + o.h);
export type CreatureServerMsg =
  | { t: 'creatures'; creatures: Creature[] } // everyone, on connect and when one appears or leaves
  | { t: 'creature'; creature: Creature }     // one of them set off, sat down, fell asleep…
  | { t: 'cups'; cups: Cup[] };

/** Quick reactions you can toss at someone; they float up over their head for everyone to see. */
export const REACTIONS = ['👋', '👍', '❤️', '😂', '🎉', '☕'] as const;
export type Reaction = typeof REACTIONS[number];

/** One event from your own Google Calendar. start/end: ISO date-time, or YYYY-MM-DD for all-day events. */
export interface CalEvent { id: string; title: string; start: string; end: string; allDay: boolean; link: string; meet?: string; declined?: boolean }

/** A calendar meeting with other people, now or within the hour. Sent only to its attendees (the title is theirs). */
export interface AgendaItem { key: string; instance: string; title: string; start: number; end: number; link?: string; left?: boolean } // left: I left it for good (not busy, no heads-up)
/** A meeting room in use, for everyone: who's in it and until when, no title. */
export interface MeetingRoomInfo { id: string; until: number; members: string[] }
/** Meeting rooms are copies of this room on the map. */
export const MEETING_ROOM_ID = 'meeting';

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

/** One change an office admin makes to the furniture or the rugs. `id` is an object's or a rug's. */
export type LayoutEdit =
  | { op: 'move'; id: string; x: number; y: number }
  | { op: 'add'; type: string; x: number; y: number }
  | { op: 'remove'; id: string }
  | { op: 'rug_add'; x: number; y: number; color?: string; w?: number; h?: number }
  | { op: 'rug'; id: string; color?: string; w?: number; h?: number };

/** Presentation mode: a deck of slide images shown on a screen object to everyone in its room. */
export interface DeckInfo { id: string; title: string; count: number; ext: string[]; by: string; at: number } // ext: each slide's file extension
export interface LiveDeck { deck: DeckInfo; slide: number; presenter: string; objectId: string; room: string; away?: boolean } // away: presenter disconnected, ends after PRESENT_AWAY_MS
export const PRESENT_AWAY_MS = 60_000;
export const PRESENT_MAX_SLIDES = 60;
export const PRESENT_MAX_BYTES = 30 * 1024 * 1024; // one upload, all slides together
export const slideUrl = (d: DeckInfo, i: number) => `/api/present/${d.id}/${i + 1}.${d.ext[i]}`;

// server -> client
export type ServerMsg =
  | ParkIncoming
  | CreatureServerMsg
  | { t: 'game_status'; userId: string; game: PublicUser['game'] }
  | { t: 'game_cheer'; userId: string; kind: number }
  | { t: 'arcade'; cabinets: CabinetSummary[] }
  | { t: 'arcade_records'; records: ParkRecords }
  | { t: 'instrument'; id: string; player: string | null }
  | { t: 'seat'; id: string | null }
  | { t: 'note'; id: string; by: string; note: number; on: boolean; vel: number; preset: number; at: number }
  // the furniture and rugs: on connect, and to everyone after each admin edit. by: who made it; added: a new thing's id
  | { t: 'layout'; layout: Layout; by?: string; added?: string }
  | { t: 'hello'; you: string; serverTime: number; build?: string } // build: the client bundle the server serves (absent in dev)
  | { t: 'state'; users: PublicUser[]; objects: Record<string, ObjectState>; toilets?: Record<string, ToiletState>; jukebox?: Record<string, JukeboxState>; instruments?: Record<string, string | null>; serverTime: number }
  | { t: 'move'; userId: string; from: Tile; to: Tile; startedAt: number; path?: Tile[]; face?: Dir; ms?: number } // ms: per tile, absent = WALK_MS_PER_TILE
  | { t: 'effects'; userId: string; effects: Effect[] }
  | { t: 'status'; userId: string; status: string }
  | { t: 'presence'; userId: string; presence: Presence }
  | { t: 'emote'; userId: string; emote: Emote }
  | { t: 'door'; userId: string; door: Door }
  | { t: 'knock'; knockId: string; fromId: string; toId: string }
  | { t: 'knock_reply'; knockId: string; fromId: string; toId: string; reply: 'accept' | 'later' | 'blocked'; link?: string; reason?: string; fallback?: boolean; cancelled?: boolean }
  // private settings, only to the user themselves. google: the connected Google account (null = not connected),
  // absent when this instance has no Google sign-in
  | { t: 'me'; meetLink: string; email?: string; google?: string | null; calendar?: boolean; admin?: boolean; judge?: boolean; items?: string[] } // calendar: Calendar access granted; admin: may rearrange the office
  | { t: 'google_auth'; url: string; calendar?: boolean } // open this to connect Google (in the system browser from the Mac app)
  | { t: 'calendar'; events?: CalEvent[]; error?: string } // my own events, only to me
  | { t: 'agenda'; items: AgendaItem[] } // my calendar meetings now and soon, only to me
  | { t: 'dungeon'; key: Tile | null; hasKey: boolean; event?: 'fell' | 'key' | 'locked' | 'opening' | 'escaped' | 'gave_up' }
  | { t: 'meeting'; userId: string; until: number | null }
  | { t: 'instance'; userId: string; instance: string | null; tile: Tile; dir: Dir } // stepped into (or out of) a meeting room or the dungeon
  | { t: 'meetings'; rooms: MeetingRoomInfo[] } // running meeting rooms, for the board
  | { t: 'desk'; userId: string; desk: Tile | null }
  | { t: 'plant'; userId: string; plant: Plant | null; bloomed: string[]; achievements: Record<string, number> }
  | { t: 'call'; userId: string; callId: string | null; link?: string } // link: the call's Meet room, only to members
  | { t: 'call_moved'; userId: string; roomId: string }
  | { t: 'rtc'; from: string; signal: RtcSignal }
  | { t: 'speaking'; userId: string; on: boolean }
  | { t: 'mute'; userId: string; muted: boolean }
  | { t: 'to_meet'; fromId: string } // someone in your call opened its Meet room; come along
  | { t: 'follow'; userId: string; targetId: string | null }
  | { t: 'holding'; userId: string; item: string | null; objectId?: string; fromId?: string } // objectId: just taken; fromId: handed over
  | { t: 'jukebox'; id: string; state: JukeboxState }
  | { t: 'object'; id: string; on: boolean; by: string }
  | { t: 'toilet'; id: string; state: ToiletState }
  | { t: 'react'; fromId: string; toId: string; emoji: Reaction }
  | { t: 'chat'; msg: ChatMsg }
  | { t: 'chat_history'; withId: string; messages: ChatMsg[] }
  | { t: 'deafen'; userId: string; on: boolean }
  | { t: 'hand'; userId: string; up: boolean }
  | { t: 'notice'; text: string }
  | { t: 'voice_wait'; roomId: string | null }
  | { t: 'voice_owner'; owner: boolean }
  | { t: 'look'; userId: string; look: Look; lookSet: boolean }
  | { t: 'presentation'; live: LiveDeck | null };

// client -> server
export type ClientMsg =
  | ParkOutgoing
  | { t: 'cup_put'; tile: Tile } // put the coffee or tea you're holding down on this table tile
  | { t: 'game_play'; epoch: number }
  | { t: 'game_leave' }
  | { t: 'game_menu'; epoch: number; op: 'lobby' | 'restart' }
  | { t: 'game_cheer'; kind: 0 | 1 | 2 }
  | { t: 'instrument'; objectId: string; action: 'play' | 'leave' }
  | { t: 'note'; objectId: string; note: number; on: boolean; vel: number; preset: number; at: number }
  | ({ t: 'jukebox'; objectId: string } & JukeboxAction)
  | { t: 'move'; to: Tile }
  | { t: 'status'; status: string }
  | { t: 'presence'; presence: Exclude<Presence, 'offline'> }
  | { t: 'knock'; targetId: string }
  | { t: 'knock_reply'; knockId: string; reply: 'accept' | 'later' }
  | { t: 'knock_cancel'; knockId: string } // the knocker calls it back: closes the prompt for both
  | { t: 'meet_link'; link: string }
  | { t: 'google_connect'; calendar?: boolean } // asks for a google_auth URL; calendar: also ask for Calendar access
  | { t: 'calendar'; from: string } // my events for a week from `from` (ISO, the start of my local day)
  | { t: 'meeting_go'; key: string } // one click: into that meeting's room
  | { t: 'dungeon_leave' }
  | { t: 'meeting_leave' }           // back to the office (still in the meeting: busy, knocks go to Later)
  | { t: 'meeting_out'; key: string } // leave the meeting for good: not busy any more, knocks come through again
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
  | { t: 'edit'; edit: LayoutEdit } // office admins only
  | { t: 'edit_reset' }              // office admins only: back to the generated layout
  | { t: 'toilet_plunge'; objectId: string } // office admins only: a full stall is clean again
  | { t: 'toilet_shelf'; objectId: string }  // inside with company and the item in your inventory: rack a line
  | { t: 'toilet_sniff'; objectId: string }  // inside, a line on the shelf: take it (and see unicorns)
  | { t: 'look'; look: Look }
  // put an effect on someone (on: true) or take it off. Yourself: 'self' effects; office admins (GMs): anyone, any effect.
  | { t: 'effect'; targetId: string; kind: string; on: boolean; style?: string }
  | { t: 'present_slide'; slide: number } // presenter only
  | { t: 'present_stop' };                // presenter only
