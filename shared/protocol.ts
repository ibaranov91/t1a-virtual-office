import type { RoomMode, RoomModes } from './roomModes';
import type { TableView, TableGameId, TableStatus } from './table/types';
export type { TableView, TableGameId } from './table/types';
import type { RetroView, RetroCabinet, RetroBoards, RetroResult } from './retro/types';
export type { RetroView, RetroCabinet, RetroBoards, RetroResult, RetroBoard, RetroEntry } from './retro/types';
export type { RetroGameId } from './retro/games';
import type { GameRole, ArcadeIncoming, ArcadeOutgoing, ArcadeBoards } from './arcade/types';
export { PARK_FPS, PARK_INPUT_DELAY, PARK_SERVER_LAG, PARK_SPECTATOR_DELAY, PARK_MAX_PLAYERS } from './arcade/types';
export type { GameRole, GameEvent, GameMember, GameClear, PublicSession, ParkRecord, ParkRecords, CabinetSummary, ArcadeBoards } from './arcade/types';
import type { CabinetSummary } from './arcade/types';

import { inRect, type Dir, type Layout, type Move, type Tile } from './map';
import type { Eating } from './lunch';

export const NOTE_RATE = 40;
export const NOTE_BURST = 64;
export const NOTE_HELD_MAX = 32;
export const SEAT_CHANGES_PER_10S = 6;

export const JUKEBOX_QUEUE_MAX = 20;
export const JUKEBOX_PER_PERSON = 3;
export interface JukeboxEntry { id: string; track: string; by: string }
export interface JukeboxState {
  playId: string; track: string; by: string | null; startedAt: number; pausedAt: number | null;
  next?: string; // what plays after this one unless the queue changes (the queue's head, else a shuffle pick made ahead), for prefetching
  queue: JukeboxEntry[];
  last: { kind: 'pause' | 'play' | 'skip'; by: string; at: number } | null;
}
export type JukeboxAction =
  | { action: 'queue'; track: string }
  | { action: 'unqueue'; entry: string }
  | { action: 'pause' | 'play' | 'skip'; playId: string };
export const DUNGEON_INSTANCE = 'dungeon';
export const underground = (u: { instance: string | null }) => u.instance === DUNGEON_INSTANCE;
/** Packing up or walking out: not around any more, as far as knocks go. */
export const goingOut = (u: { door: Door }) => u.door === 'thinking' || u.door === 'leaving';

export const ROOM_VOICE_MAX = 12;
export const AFK_MS = 10 * 60_000;
export const AFK_GRACE_MS = 2 * 60_000;
export const CALL_SILENCE_MS = 2 * 60 * 60_000;
/** A toilet stall in Berghain: up to TOILET_CAPACITY people inside (`in`), the rest line up outside (`queue`), and
 *  how many visits since it was last cleaned. At TOILET_FULL it overflows: nobody gets in until it drains (one level per
 *  TOILET_DRAIN_MS). `shelf`: lines racked on its little shelf (cleared when it empties). */
export interface ToiletState { fill: number; in: string[]; queue: string[]; shelf: number }
export const TOILET_CAPACITY = 4;
export const TOILET_FULL = 8;
export const TOILET_USE_MS = 45_000;
export const TOILET_DRAIN_MS = 3 * 60_000;
export const TOILET_SHELF_MAX = 4;
/** What racking a line on the shelf takes from your inventory (the bouncer sells it). */
export const TOILET_SHELF_ITEM = 'drugs';
export const toiletFull = (s?: ToiletState) => !!s && s.fill >= TOILET_FULL;
/** A toggle object's shared state. */
export interface ObjectState { on: boolean }

/** The reading room: article links on the library shelf, grouped by topic. Server-owned, saved in state.json. */
export const LIBRARY_TOPICS = ['Engineering', 'Data', 'Product', 'Design', 'Fun'] as const;
export type LibraryTopic = typeof LIBRARY_TOPICS[number];
export const LIBRARY_TITLE_MAX = 120;
export const LIBRARY_URL_MAX = 500;
export const LIBRARY_MAX_ARTICLES = 200;
export const LIBRARY_WEEK_MS = 7 * 86_400_000;
// ---------- bug terminal ----------
export type TicketStatus = 'open' | 'fixed' | 'closed';
export const TICKET_TITLE_MAX = 80, TICKET_TEXT_MAX = 2000, TICKET_MSGS_MAX = 50, TICKET_OPEN_MAX = 5;
/** One line of a ticket's thread; `system` lines record status changes ("Marked fixed by Kim"). */
export interface TicketMsg { by: string; admin: boolean; text: string; at: number; system?: boolean }
/** Filled in by the reporter's page; the server adds where they stood. */
export interface TicketContext { ua: string; app: 'web' | 'mac'; build: string; viewport: string; room?: string; tile?: Tile }
export interface Ticket {
  id: number; by: string; title: string; status: TicketStatus; at: number; updated: number;
  context: TicketContext; msgs: TicketMsg[]; // msgs[0] is the report itself
  seen: Record<string, number>;              // userId → when they last read it
}
/** How a ticket is shown and said out loud: #0042. */
export const ticketNo = (id: number) => `#${String(id).padStart(4, '0')}`;
export interface Article { id: string; url: string; title: string; topic: LibraryTopic; by: string; at: number }
/** One finished (or ongoing) read, kept for the log. */
export interface LibraryRead { userId: string; articleId: string; at: number; done: boolean }
/** What everyone sees of the library: the shelf and the read log (reads that finished, plus who is reading now). */
export interface LibraryState { articles: Article[]; reads: LibraryRead[] }
export const BOOK_ITEM = 'book'; // what you carry from the shelf to the reading desk

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
export const BOOKWORM_READS = 10;
export const EDITOR_READERS = 5;
export const ACHIEVEMENTS: Achievement[] = [
  { id: 'tended', icon: '💧', title: 'Green fingers', how: 'Set a status on a new day. Each day you do, your plant grows one stage.' },
  { id: 'bloom', icon: '🌸', title: 'In bloom', how: `Grow your plant all the way: set a status on ${PLANT_STAGES.length - 1} more days, never ${PLANT_DIES_DAYS} days apart.` },
  { id: 'botanist', icon: '🌻', title: 'Botanist', how: `Bloom ${BOTANIST_KINDS} different flowers. A plant that withers is replanted as a new, random one.`, goal: BOTANIST_KINDS },
  { id: 'escape', icon: '🗝️', title: 'Escape artist', how: 'Found the way out of the place under the garden.', secret: 'Something about a corner of the garden isn\'t quite right.' },
  { id: 'raver', icon: '🪩', title: 'Raver', how: 'Dance for 30 minutes in total on the Berghain floor.' },
  { id: 'whisperer', icon: '🐾', title: 'Animal whisperer', how: 'Pet both the office cat and the office dog on the same day.' },
  { id: 'batcatcher', icon: '🦇', title: 'Bat catcher', how: 'Catch the October bat while it hangs about. Click it from right beneath: it usually lets itself be caught, but sometimes darts off.', secret: 'Something flutters in the rafters in October.' },
  { id: 'bookworm', icon: '📚', title: 'Bookworm', how: `Finish reading ${BOOKWORM_READS} articles from the library.`, goal: BOOKWORM_READS },
  { id: 'editor', icon: '📰', title: 'Editor', how: `Publish an article that ${EDITOR_READERS} different people read.`, goal: EDITOR_READERS },
  { id: 'bellringer', icon: '🛎️', title: 'Ding!', how: 'Ring the reception bell in the Lobby.' },
  { id: 'tidy', icon: '🧽', title: 'Tidy soul', how: 'Clear a cup off a table while the cleaner is in the room to see it.', secret: 'The cleaner notices who tidies up after themselves.' },
  { id: 'bughunter', icon: '🐛', title: 'Bug hunter', how: 'Report a bug at the Lobby terminal that gets marked fixed.' },
  { id: 'happy_hour', icon: '🍹', title: 'Happy hour', how: 'Get tipsy on a drink from the bar.', secret: 'The beach bar does more than coconuts.' },
  { id: 'closing_time', icon: '🥴', title: 'Closing time', how: 'Have three rounds and get properly wasted.', secret: 'One more round… and one more after that.' },
  { id: 'designated', icon: '🚗', title: 'Designated driver', how: 'Hand a full drink from the bar to someone else instead of drinking it.', secret: 'Not every cocktail is for you.' },
  { id: 'snoop', icon: '👀', title: 'Caught snooping', how: 'Open someone else\'s desk storage while somebody is in the room to see it.', secret: 'Some plants hide more than flowers.' },
  { id: 'event', icon: '🎉', title: 'Party person', how: 'Be in the office during an office event.', soon: true },
];

export interface Look { skin: string; hair: string; shirt: string; pants: string; eyes: string; shoes: string; glassesColor: string; hatColor: string; style: number; top: number; bottom: number; glasses: number; hat: number; beard: number; mustache: number }
/** The colours a character can wear; random new characters pick from the same lists. */
export const LOOK_COLORS = {
  skin: ['#f8dcc0', '#f2c79b', '#e2ad7f', '#c98d5e', '#a46a43', '#7c4f32'],
  hair: ['#2b1d1f', '#4f2b1a', '#6b3e26', '#a0603a', '#d8a050', '#ecd59a', '#b4473a', '#8c8a98', '#3e5a8a', '#c8789a'],
  eyes: ['#2b1d1f', '#4b2e1e', '#3e5a8a', '#4f7d45', '#6b9ac4', '#7a4c32'],
  shirt: ['#4a7ab0', '#b4534a', '#7a9a55', '#d0a040', '#8a5aa0', '#4f9a92', '#d8805a', '#e8e0d0', '#5a5a6e', '#c8607a', '#6a8ad0', '#9a7a50'],
  pants: ['#3d3a52', '#2c3e5a', '#5a4030', '#4a4a4a', '#6a5a7a', '#3a5a4a'],
  shoes: ['#4a3028', '#282832', '#68432e', '#85766b', '#b05b42', '#d0b58a'],
  glassesColor: ['#282832', '#4a3028', '#d0b58a', '#85766b', '#3e5a8a', '#b4473a', '#e8e0d0'],
  hatColor: ['#3e5a8a', '#b4534a', '#3a5a4a', '#282832', '#d0a040', '#e8e0d0', '#6b3e26'],
};

/** A buff, debuff or hat on a person (see shared/effects.ts). until: when it wears off (ms); absent = until removed. */
export interface Effect { kind: string; until?: number; data?: Record<string, unknown> }

export const BANNER_PATTERNS = ['stripes', 'checks', 'diamond', 'dots', 'zigzag', 'plaid'] as const;
export type Banner = { kind: 'color'; color: string } | { kind: 'pattern'; pattern: (typeof BANNER_PATTERNS)[number]; color: string } | { kind: 'image'; url: string };

export interface PublicUser {
  id: string; name: string; look: Look;
  banner?: Banner | null;
  lookSet: boolean;
  tile: Tile; dir: Dir; move: Move | null;
  presence: Presence; status: string; emote: Emote; bot: boolean; door: Door;
  tz?: string; // IANA time zone the person chose to share (memory only, never saved); absent when hidden
  homeDesk: Tile | null;
  callId: string | null;
  game: { cabinet: string; role: GameRole } | null;
  table?: TableStatus | null;
  deafened: boolean; hand: boolean;
  muted: boolean;        // mic muted in that call
  following: string | null; // walks along with this person
  holding: string | null;   // a UseItem id (coffee, snack…) in hand for a while
  listening?: 'lofi' | null; // an audible Lofi TV in one of this person's open pages; never persisted
  reading: string | null;   // library article id they're reading at a reading desk; knocks go to Later
  eating?: Eating;          // having lunch at a picnic table (see shared/lunch.ts)
  vacation?: { until: number; back?: string } | null; // on vacation now, per their calendar
  meeting: number | null;   // in a calendar meeting until then (ms); knocks go to Later
  instance: string | null;  // meeting room or dungeon: only people in the same instance see each other
  plant: Plant | null;      // on their home desk, or in the Orangery if they have none
  bloomed: string[];        // plant kinds they've grown to full bloom
  achievements: Record<string, number>; // achievement id → when it was earned (ms)
  effects: Effect[];        // buffs, debuffs, hats; the server adds, expires and broadcasts them
  dnd?: boolean;            // Do not disturb (public, saved): knocks skip the pop-up and wait in Later; deafen is separate
  afk?: boolean;            // no input for AFK_MS: dozing on the floor until they're back; memory only
}

/** Office animals and helpers. Not people: never in the user list, never knock, never counted.
 *  ms: milliseconds per tile of the current walk (they amble, fly or drift at their own pace). */
export type CreatureKind = 'cat' | 'dog' | 'bat' | 'cleaner';
export type CreaturePose = 'idle' | 'sit' | 'nap' | 'clean' | 'hang' | 'pet' | 'paw' | 'shake';
export interface Creature {
  id: string; kind: CreatureKind; name: string;
  tile: Tile; dir: Dir; pose: CreaturePose;
  walk: { path: Tile[]; startedAt: number; ms: number } | null;
  hum?: boolean; // the cleaner hums while she roams (a ♪ over her head)
  say?: string;  // and now and then says something short (a speech bubble for a few seconds)
}
/** A cup someone left on a table (or dropped on the floor: `floor`); the cleaner takes it away. by: who left it. */
/** A prop: anything placed in the world: a cup on a table, a thrown item on the floor. `by` is its owner; `ttl` (ms, from `at`) overrides the default lifetime. */
export interface Cup { id: string; tile: Tile; item: string; at: number; floor?: true; by?: string; ttl?: number; dir?: Dir } // dir: which way a remote car faces
export type Prop = Cup;
/** One entry of who took what from a desk storage (seen by its owner). */
export interface StorageTake { by: string; name: string; item: string; at: number }
export const MAX_CUPS = 12; // table and floor cups together; past it the oldest cup vanishes when one is dropped
export const CUP_ITEMS = ['coffee', 'tea', 'cocktail', 'beer', 'wine']; // drinks that leave a cup or glass behind (see shared/drinks.ts)
/** Furniture you can put a cup on. */
export const CUP_TABLES = ['table_long', 'table_round', 'table_big', 'desk', 'counter', 'table_picnic'];
export const cupTableAt = <O extends { type: string; x: number; y: number; w: number; h: number }>(objects: O[], t: Tile) =>
  objects.find(o => CUP_TABLES.includes(o.type) && inRect(o, t.x, t.y));
export type CreatureServerMsg =
  | { t: 'creatures'; creatures: Creature[] } // everyone, on connect and when one appears or leaves
  | { t: 'creature'; creature: Creature; by?: string }     // one of them set off, sat down, fell asleep…
  | { t: 'cups'; cups: Cup[] }
  | { t: 'car'; id: string; tile: Tile; dir: Dir }; // a remote car moved: only its prop changes (a stream of these while someone drives)

/** Quick reactions you can toss at someone; they float up over their head for everyone to see. */
export const REACTIONS = ['👋', '👍', '❤️', '😂', '🎉', '☕'] as const;
export type Reaction = typeof REACTIONS[number];

/** One event from your own Google Calendar. start/end: ISO date-time, or YYYY-MM-DD for all-day events. */
export interface CalEvent { id: string; title: string; start: string; end: string; allDay: boolean; link: string; meet?: string; declined?: boolean }

/** A calendar meeting with other people, now or within the hour. Sent only to its attendees (the title is theirs). */
export interface AgendaItem { key: string; instance: string; title: string; start: number; end: number; link?: string; left?: boolean; adhoc?: boolean; from?: string; host?: boolean } // adhoc: a private room someone started (from: host's name; host: it's mine, so I can end it); left: I left it for good (not busy, no heads-up)
/** A meeting room in use, for everyone: who's in it and until when, no title. */
export interface MeetingRoomInfo { id: string; until: number; members: string[]; voice: string[] } // voice: who is on the room's voice call (at most ROOM_VOICE_MAX; the rest wait in line or use Meet)
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

/** A knock that went to Later (kept per person, memory only): newest first, one per knocker. */
export interface LaterItem { id: string; fromId: string; at: number; why: string }
export const LATER_MAX = 20;

// ---- Event journal (owner only): the activity log reads it. Edit only in this block.
/** One thing that happened to you. `kind` is open-ended (knock_in, knock_out, call, meeting, room, notice, later: theft, gift, photo…). */
export interface JournalEntry { id: string; at: number; kind: string; text: string; otherId?: string; action?: 'knock_back' }
export const JOURNAL_MAX = 200; // per person
// ---- end journal

export interface Knock {
  id: string; fromId: string; toId: string;
  state: 'walking' | 'pending' | 'accept' | 'later' | 'blocked';
}

/** One change an office admin makes to the furniture or the rugs. `id` is an object's or a rug's. */
export type LayoutEdit =
  | { op: 'move'; id: string; x: number; y: number }
  | { op: 'add'; type: string; x: number; y: number }
  | { op: 'remove'; id: string }
  | { op: 'rotate'; id: string } // a chair or stool, a quarter turn clockwise
  | { op: 'rug_add'; x: number; y: number; color?: string; pattern?: string; w?: number; h?: number }
  | { op: 'rug'; id: string; color?: string; pattern?: string; w?: number; h?: number };

/** Presentation mode. The Meeting room's wall screen shows one thing at a time to everyone in its *scope*:
 *  the office floor (`OFFICE_SCOPE`) or one meeting instance (the instance id), each with its own single presenter.
 *  A show is either a deck of slide images from the presenter's own library, or their screen as a stream of JPEG frames. */
export const OFFICE_SCOPE = 'office';
export const presentScope = (instance: string | null | undefined) => instance ?? OFFICE_SCOPE;
/** A deck in someone's library. `key` is a random token in every slide URL, so viewers can load the slides and nobody can enumerate decks. */
export interface DeckInfo { id: string; title: string; count: number; ext: string[]; by: string; at: number; bytes: number; key: string } // ext: each slide's file extension
export interface LiveDeck {
  scope: string;            // OFFICE_SCOPE or a meeting instance id: only its members get `presentation` and `frame`
  presenter: string; objectId: string; room: string;
  away?: boolean;           // presenter disconnected, ends after PRESENT_AWAY_MS
  deck: DeckInfo | null;    // null: screen share (frames)
  slide: number;            // deck only
  seq?: number;             // screen share: the latest frame's sequence number
}
export const PRESENT_AWAY_MS = 60_000;
export const PRESENT_MAX_SLIDES = 60;
export const PRESENT_MAX_BYTES = 30 * 1024 * 1024; // one upload, all slides together
export const PRESENT_USER_QUOTA = 100 * 1024 * 1024; // a person's whole library (env PRESENT_USER_QUOTA_MB overrides)
export const PRESENT_TTL_MS = 24 * 3600_000;         // decks are swept this long after upload (env PRESENT_TTL_HOURS overrides)
export const FRAME_MAX_BYTES = 300 * 1024;  // one JPEG frame, decoded
export const FRAME_MIN_INTERVAL_MS = 400;    // the presenter sends at most this often; the server drops faster ones
export const FRAME_MAX_SIDE = 1280;          // frames are scaled so the longer side fits this
export const slideUrl = (d: DeckInfo, i: number) => `/api/present/${d.id}/${i + 1}.${d.ext[i]}?k=${d.key}`;
/** REST (all with the session in `x-deck-session`; errors are `{ error }`, a busy screen is 409 `{ error, presenter }`):
 *  GET  /api/present/decks                → DecksReply: my decks only, plus my usage
 *  POST /api/present/upload               { title, objectId, files: base64 PNG/JPG[] | [one PDF] } → { deck } and it starts, if the screen is free
 *  POST /api/present/start                { deck, objectId } → { deck }: show one of my decks
 *  DELETE /api/present/<deckId>           → {}: one of mine; stops it if it's live
 *  GET  /api/present/<deckId>/<n>.<ext>?k=<key>  a slide (no session needed, the key is the secret) */
export interface DecksReply { decks: DeckInfo[]; used: number; limit: number }

// server -> client
export type ServerMsg =
  | { t: 'banner'; userId: string; banner: Banner | null }
  | { t: 'listening'; userId: string; on: boolean }
  | { t: 'table'; view: TableView | null } // private: owner socket only
  | { t: 'table_status'; userId: string; table: TableStatus | null }
  | { t: 'retro_session'; view: RetroView | null; reason?: 'elsewhere' | 'ended' | 'idle' | 'cap' | 'broken' }
  | { t: 'retro_frames'; runId: string; from: number; upto: number; changes: [number, number][] }
  | { t: 'retro_result'; runId: string; frame: number; result: RetroResult }
  | { t: 'retro_cabinets'; cabinets: RetroCabinet[] }
  | { t: 'retro_boards'; boards: RetroBoards } // retro cabinets

  | ArcadeIncoming
  | CreatureServerMsg
  | { t: 'game_status'; userId: string; game: PublicUser['game'] }
  | { t: 'game_cheer'; userId: string; kind: number }
  | { t: 'arcade'; cabinets: CabinetSummary[] }
  | { t: 'arcade_boards'; boards: ArcadeBoards }
  | { t: 'instrument'; id: string; player: string | null }
  | { t: 'seat'; id: string | null }
  | { t: 'note'; id: string; by: string; note: number; on: boolean; vel: number; preset: number; at: number }
  | { t: 'room_modes'; modes: RoomModes; by: string } // admin changes: all room-mode overrides
  // the furniture and rugs: on connect, and to everyone after each admin edit. by: who made it; added: a new thing's id
  | { t: 'layout'; layout: Layout; by?: string; added?: string }
  | { t: 'hello'; you: string; serverTime: number; build?: string } // build: the client bundle the server serves (absent in dev)
  | { t: 'pong'; id: number; serverTime: number } // the answer to a clock ping, only to the socket that sent it
  | { t: 'state'; roomModes?: RoomModes; users: PublicUser[]; objects: Record<string, ObjectState>; toilets?: Record<string, ToiletState>; jukebox?: Record<string, JukeboxState>; instruments?: Record<string, string | null>; serverTime: number }
  | { t: 'move'; userId: string; from: Tile; to: Tile; startedAt: number; path?: Tile[]; face?: Dir; ms?: number } // ms: per tile, absent = WALK_MS_PER_TILE
  | { t: 'effects'; userId: string; effects: Effect[] }
  | { t: 'status'; userId: string; status: string }
  | { t: 'tz'; userId: string; tz: string | null }
  | { t: 'user'; user: PublicUser } // someone new joined the roster
  | { t: 'presence'; userId: string; presence: Presence }
  | { t: 'afk'; userId: string; afk: boolean }
  | { t: 'emote'; userId: string; emote: Emote }
  | { t: 'door'; userId: string; door: Door }
  | { t: 'knock'; knockId: string; fromId: string; toId: string }
  | { t: 'knock_reply'; knockId: string; fromId: string; toId: string; reply: 'accept' | 'later' | 'blocked'; link?: string; reason?: string; cancelled?: boolean; kept?: boolean /* in the target's Later list: no "missed" toast */ }
  // private settings, only to the user themselves. google: the connected Google account (null = not connected),
  // absent when this instance has no Google sign-in
  | { t: 'me'; meetLink: string; email?: string; google?: string | null; calendar?: boolean; admin?: boolean; sysadmin?: boolean; items?: string[]; prisonUntil?: number; hatDue?: number } // hatDue: achievement-hat picks waiting (shared/rewards.ts); calendar: Calendar access granted; admin: may rearrange the office; sysadmin: may also walk into the Admin room
  | { t: 'google_auth'; url: string; calendar?: boolean } // open this to connect Google (in the system browser from the Mac app)
  | { t: 'calendar'; events?: CalEvent[]; error?: string } // my own events, only to me
  | { t: 'agenda'; items: AgendaItem[] } // my calendar meetings now and soon, only to me
  | { t: 'dungeon'; key: Tile | null; hasKey: boolean; event?: 'fell' | 'key' | 'locked' | 'opening' | 'escaped' | 'gave_up' }
  | { t: 'vacation'; userId: string; vacation: { until: number; back?: string } | null } // current vacation only
  | { t: 'meeting'; userId: string; until: number | null }
  | { t: 'reading'; userId: string; articleId: string | null }
  | ({ t: 'library' } & LibraryState)
  | { t: 'instance'; userId: string; instance: string | null; tile: Tile; dir: Dir } // stepped into (or out of) a meeting room or the dungeon
  | { t: 'meetings'; rooms: MeetingRoomInfo[] } // running meeting rooms, for the board
  | { t: 'desk'; userId: string; desk: Tile | null }
  | { t: 'plant'; userId: string; plant: Plant | null; bloomed: string[]; achievements: Record<string, number> }
  | { t: 'call'; userId: string; callId: string | null; link?: string } // link: the call's Meet room, only to members
  | { t: 'call_moved'; userId: string; roomId: string }
  | { t: 'rtc'; from: string; signal: RtcSignal }
  | { t: 'speaking'; userId: string; on: boolean }
  | { t: 'mute'; userId: string; muted: boolean }
  | { t: 'room_meet'; instance: string; link: string | null } // the Meet room of the meeting room I'm in (only to its members; null: none yet / left)
  | { t: 'to_meet'; fromId: string } // someone in your call opened its Meet room; come along
  | { t: 'follow'; userId: string; targetId: string | null }
  | { t: 'eating'; userId: string; eating: Eating | null }
  | { t: 'holding'; userId: string; item: string | null; objectId?: string; fromId?: string; phase?: 'drinking' } // objectId: just taken; fromId: handed over; phase: sipping it now (the item stays until the sip ends)
  | { t: 'jukebox'; id: string; state: JukeboxState }
  | { t: 'object'; id: string; on: boolean; by: string }
  | { t: 'toilet'; id: string; state: ToiletState }
  | { t: 'bell'; userId: string; objectId: string } // someone rang a reception bell
  | { t: 'react'; fromId: string; toId: string; emoji: Reaction }
  | { t: 'chat'; msg: ChatMsg }
  | { t: 'chat_history'; withId: string; messages: ChatMsg[] }
  | { t: 'deafen'; userId: string; on: boolean }
  | { t: 'hand'; userId: string; up: boolean }
  | { t: 'gm_items'; targetId: string; items: string[]; prisonUntil?: number } // to the asking admin only (prisonUntil: the hat can't come off before then)
  // ---------- items & storage ----------
  // ---------- item content (v2) ----------
  | { t: 'popper'; userId: string; tile: Tile } // a party popper went off (everyone near hears it; the confetti is an effect on whoever was within 2 tiles)
  | { t: 'thrown'; fromId: string; toId: string; item: string; landed: 'pockets' | 'floor' } // an item flew from one person to another (everyone plays the arc)
  | { t: 'storage_warn'; ownerId: string } // opening someone else's storage: confirm first (they may be spotted)
  | { t: 'storage'; ownerId: string; items: string[]; log?: StorageTake[]; spotted?: boolean } // to the person looking: what the desk holds; log only for the owner
  | { t: 'storage_closed'; ownerId: string }
  | { t: 'teleport'; userId: string; from: Tile; to: Tile } // an admin stepped through a portal: everyone plays it (the server has already moved them)
  | { t: 'notice'; text: string }
  | { t: 'later'; items: LaterItem[] }  // only to the person knocked on: their kept Later list, on connect and on every change
  | { t: 'journal'; entries: JournalEntry[]; readAt: number } // only to its owner: the whole journal (oldest first) on connect
  | { t: 'journal_add'; entry: JournalEntry }                 // only to its owner: one new entry
  | { t: 'dnd'; userId: string; on: boolean }                 // someone's Do not disturb changed (public)
  | { t: 'later_nudge'; text: string; userId?: string } // their busy spell is over and knocks came in meanwhile (userId: the one knocker, for Knock back)
  | { t: 'room_open' } // you clicked the Meeting room's 'start private room' button: open the popup
  | { t: 'present_open'; objectId: string } // you walked up to the board: show the upload/present panel
  | { t: 'terminal_open'; objectId: string } // you walked up to the bug terminal: show its screen
  | { t: 'tickets'; list: Ticket[] } // only to you: your own tickets, or every ticket for an office admin; on connect and on every change
  | { t: 'voice_wait'; roomId: string | null }
  | { t: 'voice_owner'; owner: boolean }
  | { t: 'active' }
  | { t: 'look'; userId: string; look: Look; lookSet: boolean; name?: string }
  | { t: 'presentation'; live: LiveDeck | null } // to the scope's members only: what's on their screen (null: nothing). Re-sent when you change scope.
  | { t: 'frame'; scope: string; seq: number; data: string }; // screen share: one JPEG frame, base64, to the scope's members except the presenter

// client -> server
export type ClientMsg =
  | { t: 'banner'; banner: Banner | null }
  | { t: 'listening'; on: boolean }
  | { t: 'table_pick'; game: TableGameId; invite?: string[]; rematch?: boolean } // host invitations, or a rematch proposal
  | { t: 'table_start' } // invited sitter: Join; host: Start
  | { t: 'table_move'; matchId: string; revision: number; move: unknown }
  | { t: 'table_resign'; matchId: string }
  | { t: 'table_draw'; matchId: string; offer: boolean } // offer, accept opponent's offer, or decline (false)
  | { t: 'table_leave' }
  | { t: 'retro_frames'; runId: string; sync: number; from: number; upto: number; changes: [frame: number, bits: number][] }
  | { t: 'retro_leave' }
  | { t: 'retro_resync' } // retro cabinets

  | { t: 'crew_name'; name: string }
  | { t: 'game_predict'; epoch: number; userId: string }
  | { t: 'game_favourite'; epoch: number; userId: string }
  | ArcadeOutgoing
  | { t: 'lunch'; tile: Tile; open: boolean } // eat the food you're holding in this picnic chair; open: knocks from the table are welcome
  | { t: 'lunch_open'; open: boolean }       // change that while eating
  | { t: 'cup_put'; tile: Tile } // put the coffee or tea you're holding down on this table tile
  | { t: 'cup_take'; cupId: string } // walk over to a cup left on a table and clear it away
  | { t: 'pet'; creatureId: string } // pet the cat or dog, or try to catch the hanging bat (walks you over first)
  | { t: 'dev_bat' } // dev only (BAT=1): bring the bat out now
  | { t: 'game_play'; epoch: number }
  | { t: 'game_leave' }
  | { t: 'game_menu'; epoch: number; op: 'lobby' | 'restart' }
  | { t: 'game_cheer'; kind: 0 | 1 | 2 }
  | { t: 'instrument'; objectId: string; action: 'play' | 'leave' }
  | { t: 'note'; objectId: string; note: number; on: boolean; vel: number; preset: number; at: number }
  | ({ t: 'jukebox'; objectId: string } & JukeboxAction)
  | { t: 'ping'; id: number } // clock sync (NTP-style): the server answers with its time
  | { t: 'move'; to: Tile }
  | { t: 'status'; status: string }
  | { t: 'tz'; tz: string | null } // share (or hide, with null) my time zone
  | { t: 'presence'; presence: Exclude<Presence, 'offline'> }
  | { t: 'knock'; targetId: string }
  | { t: 'knock_reply'; knockId: string; reply: 'accept' | 'later' }
  | { t: 'later_dismiss'; id: string }
  | { t: 'later_clear' }
  | { t: 'dnd'; on: boolean }   // my Do not disturb
  | { t: 'journal_read' }       // I opened the activity log: everything so far is read
  | { t: 'knock_cancel'; knockId: string } // the knocker calls it back: closes the prompt for both
  | { t: 'meet_link'; link: string }
  | { t: 'google_connect'; calendar?: boolean } // asks for a google_auth URL; calendar: also ask for Calendar access
  | { t: 'calendar'; from: string } // my events for a week from `from` (ISO, the start of my local day)
  | { t: 'meeting_go'; key: string } // one click: into that meeting's room
  | { t: 'dungeon_leave' }
  | { t: 'article_add'; url: string; title: string; topic: string }
  | { t: 'article_remove'; id: string }  // the author, or an office admin
  | { t: 'ticket_new'; title: string; text: string; context: TicketContext } // standing at the bug terminal
  | { t: 'ticket_reply'; id: number; text: string }    // the author or an office admin
  | { t: 'ticket_status'; id: number; status: TicketStatus } // admins: anything; the author: close their own
  | { t: 'ticket_seen'; id: number }
  | { t: 'read_start'; articleId: string }
  | { t: 'read_done' }
  | { t: 'meeting_leave' }           // back to the office (still in the meeting: busy, knocks go to Later)
  | { t: 'room_create'; title?: string; invite: string[] } // start a private room in a copy of the Meeting room; invite = user ids
  | { t: 'room_invite'; userIds: string[] } // add people to the private room I'm in
  | { t: 'room_end'; key: string } // end a private room I started (or, for office admins, anyone's): everyone back to the office
  | { t: 'room_mode'; roomId: string; mode: RoomMode } // admins: change a room's voice and knock rules
  | { t: 'room_voice'; on: boolean } // join / leave the voice call of the meeting room I'm in (ad-hoc rooms join on entry, calendar meetings are opt-in)
  | { t: 'room_meet' } // 'Use Meet' in an ad-hoc room: make (or re-send) its Meet link for everyone in it
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
  | { t: 'drop' }                    // finish what you're holding (an empty cup: drop it on the floor where you stand)
  | { t: 'drink' }                   // drink what you're holding: the sip, then its effect (shared/drinks.ts), then an empty cup in hand
  | { t: 'give'; targetId: string } // pocketable item: throw it at someone (pockets, else the floor beside them); anything else: hand it to someone with empty hands
  // ---------- items & storage ----------
  | { t: 'take_out'; item: string }  // pockets -> hands (hands must be empty)
  | { t: 'stow' }                    // hands -> pockets
  | { t: 'storage_open'; ownerId: string; ack?: boolean } // open a desk storage (your own, or someone's: needs ack after the warning)
  | { t: 'storage_close' }
  | { t: 'storage_move'; ownerId: string; item: string; dir: 'in' | 'out' } // pockets <-> that desk's storage
  | { t: 'gm_give'; targetId: string; item: string } // office admins only: give anyone any registry item
  // ---------- item content (v2) ----------
  | { t: 'use_held' }                 // the wheel's Use on what you hold: its onUse (shared/items.ts), or the item's own action (sew, drive, wear)
  | { t: 'postcard_write'; text: string } // a blank postcard in your hands becomes `postcard:<text>`
  | { t: 'hat_pick'; item: string }   // choose your achievement hat (shared/rewards.ts); needs a pick due
  | { t: 'car_go'; to: Tile }         // driving: send the car to this tile (it takes the path, a tile per CAR_STEP_MS)
  | { t: 'car_dir'; dir: Dir }        // driving: one step with the arrow keys
  | { t: 'car_end'; pickup?: boolean } // End ride (pickup: and take the car back into your hands)
  | { t: 'sew_stop' }                 // stop sewing (the hour starts over)
  | { t: 'dev_time'; scale: number }  // dev only (World.devTools): speed up the sewing hour, and reset the gacha day (`dev_gacha`)
  | { t: 'dev_gacha' }
  | { t: 'prison_release'; targetId: string }  // office admins only: take the prison hat off
  | { t: 'bite'; targetId: string } // a vampire walks up to someone and bites: they're a vampire too, for BITE_MS
  | { t: 'deafen'; on: boolean }
  | { t: 'hand'; up: boolean }
  | { t: 'leave_room' }
  | { t: 'afk' }
  | { t: 'active' }
  | { t: 'voice_claim' }
  | { t: 'edit'; edit: LayoutEdit } // office admins only
  | { t: 'edit_reset' }              // office admins only: back to the generated layout
  | { t: 'ring'; objectId: string }  // ring a bell (walks you over first if you're not beside it)
  | { t: 'toilet_shelf'; objectId: string }  // inside with company and the item in your inventory: rack a line
  | { t: 'toilet_sniff'; objectId: string }  // inside, a line on the shelf: take it (and see unicorns)
  | { t: 'look'; look: Look; name?: string } // name: optional manual display name ("First Las")
  // put an effect on someone (on: true) or take it off. Yourself: 'self' effects; office admins (GMs): anyone, any effect.
  | { t: 'gm_items'; targetId: string } // office admins only: ask what someone carries in their pockets
  | { t: 'teleport'; targetId: string } // office admins only: step through a portal to stand beside someone
  | { t: 'rename'; targetId: string; name: string } // office admins only: give someone another name (if theirs was taken)
  | { t: 'gift_hat'; targetId: string; style: string } // office admins only: put a hat in someone's pockets and on their head
  | { t: 'effect'; targetId: string; kind: string; on: boolean; style?: string }
  | { t: 'present_slide'; slide: number } // presenter only
  | { t: 'present_share'; objectId: string } // beside the screen: start sharing my screen (a busy screen answers with a `notice`)
  | { t: 'present_frame'; seq: number; data: string } // presenter only, while sharing: one JPEG frame, base64 (≤ FRAME_MAX_BYTES decoded), at most every FRAME_MIN_INTERVAL_MS
  | { t: 'present_stop' };                // presenter only

/** An IANA zone name this runtime knows ('Europe/Warsaw'), so a client can't put arbitrary text on everyone's screen. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
