import type { ClientUser } from '../net';
import { roomAt, stallOfCall, tableOfCall, type Room, type TileMap, type MapObject, type ObjectUse } from '../../../shared/map';
import { OFFICE_SCOPE, underground, type JukeboxState, type LiveDeck } from '../../../shared/protocol';
import { INSTRUMENTS } from '../../../shared/instruments';
import mapJson from '../../../shared/tilemap.json';
import { TRACK } from '../../../shared/music';
import { vacationReturnLabel } from '../Vacation';

export const PRESENCE_COLOR: Record<string, string> = { online: '#7cc87c', away: '#e0b050', in_call: '#d86a5a', offline: '#666' };
export const GROUPS = [
  { id: 'voice', label: 'Voice', hint: 'walk in to talk' },
  { id: 'knock', label: 'Knock', hint: 'knock to talk' },
  { id: 'quiet', label: 'Quiet', hint: 'do not disturb' },
  { id: 'meetings', label: 'In meetings', hint: 'meetings and private rooms' },
  { id: 'underground', label: 'Underground', hint: 'somewhere underground' },
  { id: 'hall', label: 'Hallway', hint: 'passing through' },
  { id: 'vacation', label: 'On vacation', hint: 'away per their calendar' },
  { id: 'offline', label: 'Offline', hint: '' },
] as const;
export interface View {
  users: Map<string, ClientUser>; me: string;
  roomOf(u: ClientUser): Room | undefined; roomCallOf(u?: ClientUser): Room | undefined;
  callPeers(u: ClientUser): ClientUser[]; names(us: ClientUser[]): string; clock(ms: number): string;
  instruments: Record<string, string | null>; jukebox: Record<string, JukeboxState>;
  presentation: LiveDeck | null; sysadmin: boolean;
}
export const roomGroup = (room: Room) => room.rules.voice === 'open' ? 'voice' : room.rules.knock === 'allow' ? 'knock' : 'quiet';
/** Vacationers come back soonest first; everyone else by name, me on top. */
const byReturn = (us: ClientUser[]) => us.sort((a, b) => (a.vacation?.until ?? 0) - (b.vacation?.until ?? 0) || a.name.localeCompare(b.name));
const ordered = (view: View, us: ClientUser[]) => us.sort((a, b) => Number(b.id === view.me) - Number(a.id === view.me) || a.name.localeCompare(b.name));
const matches = (text: string, query: string) => text.toLocaleLowerCase().includes(query);
export function place(view: View, u: ClientUser) {
  return underground(u) ? 'Underground' : u.instance ? 'In a meeting room' : view.roomOf(u)?.name ?? 'Hallway';
}
export function instrument(view: View, u: ClientUser) {
  const o = mapJson.objects.find(o => o.use?.kind === 'instrument' && view.instruments[o.id] === u.id);
  return o?.use?.kind === 'instrument' ? INSTRUMENTS[o.use.instrument as keyof typeof INSTRUMENTS] : undefined;
}
export function activityLine(view: View, u: ClientUser) {
  if (u.vacation) return `🌴 on vacation · ${vacationReturnLabel(u.vacation)}`;
  if (underground(u)) return 'somewhere underground';
  const playing = instrument(view, u);
  const line = u.door ? { arriving: 'just arrived', thinking: 'packing up…', leaving: 'heading out' }[u.door]
    : u.meeting ? `📅 in a meeting until ${view.clock(u.meeting)}`
    : u.callId && !view.roomCallOf(u) ? `📞 with ${view.names(view.callPeers(u))}`
    : tableOfCall(u.callId) ? `🍽 at the lunch table${view.callPeers(u).length ? ` with ${view.names(view.callPeers(u))}` : ' · open to talk'}` // a table's or stall's own voice: say who's in it
    : stallOfCall(u.callId) ? `🚽 in a stall${view.callPeers(u).length ? ` with ${view.names(view.callPeers(u))}` : ''}`
    : u.game ? u.game.role === 'player' ? '🕹 playing Deck Park' : '👀 watching Deck Park'
    : u.reading ? '📖 reading'
    : u.eating ? `🍽 having lunch${u.eating.open ? ' · open to talk' : ''}`
    : playing ? `${playing.icon} playing ${playing.name}`
    : u.listening === 'lofi' ? '🎧 listening to Lofi Girl'
    : u.presence === 'away' ? 'away' : '';
  return line ? `${line}${u.status ? ` · ${u.status}` : ''}` : u.status || '';
}
export type ChannelRoom = { room: Room; people: ClientUser[]; count: number; subtitle: string };
export type ChannelGroup = { id: string; label: string; hint: string; count: number; rooms: ChannelRoom[]; people: ClientUser[] };
export function channelTree(view: View, map: TileMap, query = ''): ChannelGroup[] {
  const q = query.trim().toLocaleLowerCase(), users = [...view.users.values()];
  const special = (u: ClientUser) => u.vacation ? 'vacation' : u.presence === 'offline' ? 'offline' : underground(u) ? 'underground' : u.instance ? 'meetings' : !view.roomOf(u) ? 'hall' : null;
  return GROUPS.map(g => {
    const rooms = map.rooms.filter(r => roomGroup(r) === g.id).flatMap(room => {
      const all = ordered(view, users.filter(u => !special(u) && view.roomOf(u)?.id === room.id));
      const people = q && !matches(room.name, q) ? all.filter(u => matches(u.name, q)) : all;
      if (q && !matches(room.name, q) && !people.length) return [];
      const box = roomThings(map, room).find(o => o.use?.kind === 'jukebox'), state = box && view.jukebox[box.id];
      const subtitle = state ? state.pausedAt !== null ? 'paused' : `♪ ${TRACK.get(state.track)?.title ?? state.track}`
        : view.presentation?.scope === OFFICE_SCOPE && view.presentation.room === room.id ? '📽 live' : ''; // a meeting room's own show stays inside it
      return [{ room, people, count: all.length, subtitle }];
    });
    const all = users.filter(u => special(u) === g.id);
    const found = all.filter(u => !q || matches(u.name, q)), people = g.id === 'vacation' ? byReturn(found) : ordered(view, found);
    const count = g.id === 'offline' || g.id === 'vacation' ? people.length : rooms.reduce((n, r) => n + r.people.length, 0) + people.length;
    return { ...g, rooms, people, count };
  }).filter(g => g.rooms.length || g.people.length);
}
export function peopleGroups(view: View, query = '') {
  const q = query.trim().toLocaleLowerCase();
  const group = (u: ClientUser) => u.vacation ? 'vacation' : u.presence === 'offline' ? 'offline' : u.callId ? 'p-voice' : u.presence === 'away' ? 'p-away' : 'p-online';
  return [{ id: 'p-voice', label: 'In voice' }, { id: 'p-online', label: 'Online' }, { id: 'p-away', label: 'Away' }, { id: 'vacation', label: 'On vacation' }, { id: 'offline', label: 'Offline' }]
    .map(g => { const found = [...view.users.values()].filter(u => group(u) === g.id && (!q || matches(u.name, q) || matches(place(view, u), q))); return { ...g, people: g.id === 'vacation' ? byReturn(found) : ordered(view, found) }; })
    .filter(g => g.people.length);
}
const THINGS = new Set(['jukebox', 'youtube', 'records', 'meetings', 'library', 'clock', 'achievements', 'calendar', 'link']);
type ThingUse = Extract<ObjectUse, { kind: 'jukebox' | 'youtube' | 'records' | 'meetings' | 'library' | 'clock' | 'achievements' | 'calendar' | 'link' }>;
export function roomThings(map: TileMap, room: Room): (MapObject & { use: ThingUse })[] {
  const seen = new Set<string>();
  return map.objects.filter((o): o is MapObject & { use: ThingUse } => {
    if (!o.use || !THINGS.has(o.use.kind)) return false;
    const owner = o.use.kind === 'youtube' ? map.rooms.find(r => r.id === (o.use as { room: string }).room)
      : roomAt(map, o.x, o.y) ?? roomAt(map, o.x, o.y + o.h) ?? roomAt(map, o.x, o.y + o.h + 1);
    const key = o.use.kind === 'jukebox' || o.use.kind === 'youtube' ? o.id : o.use.kind;
    if (owner?.id !== room.id || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
