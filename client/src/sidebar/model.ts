import type { ClientUser } from '../net';
import { roomAt, type Room, type TileMap, type MapObject, type ObjectUse } from '../../../shared/map';
import { underground, type JukeboxState, type LiveDeck } from '../../../shared/protocol';
import { INSTRUMENTS } from '../../../shared/instruments';
import mapJson from '../../../shared/tilemap.json';
import { TRACK } from '../../../shared/music';

export const PRESENCE_COLOR: Record<string, string> = { online: '#7cc87c', away: '#e0b050', in_call: '#d86a5a', offline: '#666' };
export const GROUPS = [
  { id: 'voice', label: 'Voice', hint: 'walk in to talk' },
  { id: 'knock', label: 'Knock', hint: 'knock to talk' },
  { id: 'quiet', label: 'Quiet', hint: 'do not disturb' },
  { id: 'meetings', label: 'In meetings', hint: 'calendar meetings' },
  { id: 'underground', label: 'Underground', hint: 'somewhere underground' },
  { id: 'hall', label: 'Hallway', hint: 'passing through' },
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
const ordered = (view: View, us: ClientUser[]) => us.sort((a, b) => Number(b.id === view.me) - Number(a.id === view.me) || a.name.localeCompare(b.name));
const matches = (text: string, query: string) => text.toLocaleLowerCase().includes(query);
export function place(view: View, u: ClientUser) {
  return underground(u) ? 'Underground' : u.instance ? 'In a meeting' : view.roomOf(u)?.name ?? 'Hallway';
}
export function instrument(view: View, u: ClientUser) {
  const o = mapJson.objects.find(o => o.use?.kind === 'instrument' && view.instruments[o.id] === u.id);
  return o?.use?.kind === 'instrument' ? INSTRUMENTS[o.use.instrument as keyof typeof INSTRUMENTS] : undefined;
}
export function activityLine(view: View, u: ClientUser) {
  if (underground(u)) return 'somewhere underground';
  const playing = instrument(view, u);
  const line = u.door ? { arriving: 'just arrived', thinking: 'packing up…', leaving: 'heading out' }[u.door]
    : u.meeting ? `📅 in a meeting until ${view.clock(u.meeting)}`
    : u.callId && !view.roomCallOf(u) ? `📞 with ${view.names(view.callPeers(u))}`
    : u.game ? u.game.role === 'player' ? '🕹 playing Deck Park' : '👀 watching Deck Park'
    : u.reading ? '📖 reading'
    : u.eating ? `🍽 having lunch${u.eating.open ? ' · open to talk' : ''}`
    : playing ? `${playing.icon} playing ${playing.name}`
    : u.presence === 'away' ? 'away' : '';
  return line ? `${line}${u.status ? ` · ${u.status}` : ''}` : u.status || '';
}
export type ChannelRoom = { room: Room; people: ClientUser[]; count: number; full: boolean; subtitle: string };
export type ChannelGroup = { id: string; label: string; hint: string; count: number; rooms: ChannelRoom[]; people: ClientUser[] };
export function channelTree(view: View, map: TileMap, query = ''): ChannelGroup[] {
  const q = query.trim().toLocaleLowerCase(), users = [...view.users.values()];
  const special = (u: ClientUser) => u.presence === 'offline' ? 'offline' : underground(u) ? 'underground' : u.instance ? 'meetings' : !view.roomOf(u) ? 'hall' : null;
  return GROUPS.map(g => {
    const rooms = map.rooms.filter(r => roomGroup(r) === g.id).flatMap(room => {
      const all = ordered(view, users.filter(u => !special(u) && view.roomOf(u)?.id === room.id));
      const people = q && !matches(room.name, q) ? all.filter(u => matches(u.name, q)) : all;
      if (q && !matches(room.name, q) && !people.length) return [];
      const box = roomThings(map, room).find(o => o.use?.kind === 'jukebox'), state = box && view.jukebox[box.id];
      const subtitle = state ? state.pausedAt !== null ? 'paused' : `♪ ${TRACK.get(state.track)?.title ?? state.track}`
        : view.presentation?.room === room.id ? '📽 live' : '';
      return [{ room, people, count: all.length, full: all.length >= room.capacity, subtitle }];
    });
    const all = users.filter(u => special(u) === g.id);
    const people = ordered(view, all.filter(u => !q || matches(u.name, q)));
    const count = g.id === 'offline' ? people.length : rooms.reduce((n, r) => n + r.people.length, 0) + people.length;
    return { ...g, rooms, people, count };
  }).filter(g => g.rooms.length || g.people.length);
}
export function peopleGroups(view: View, query = '') {
  const q = query.trim().toLocaleLowerCase();
  const group = (u: ClientUser) => u.presence === 'offline' ? 'offline' : u.callId ? 'p-voice' : u.presence === 'away' ? 'p-away' : 'p-online';
  return [{ id: 'p-voice', label: 'In voice' }, { id: 'p-online', label: 'Online' }, { id: 'p-away', label: 'Away' }, { id: 'offline', label: 'Offline' }]
    .map(g => ({ ...g, people: ordered(view, [...view.users.values()].filter(u => group(u) === g.id && (!q || matches(u.name, q) || matches(place(view, u), q)))) }))
    .filter(g => g.people.length);
}
const THINGS = new Set(['jukebox', 'records', 'meetings', 'library', 'clock', 'achievements', 'calendar', 'link']);
type ThingUse = Extract<ObjectUse, { kind: 'jukebox' | 'records' | 'meetings' | 'library' | 'clock' | 'achievements' | 'calendar' | 'link' }>;
export function roomThings(map: TileMap, room: Room): (MapObject & { use: ThingUse })[] {
  const seen = new Set<string>();
  return map.objects.filter((o): o is MapObject & { use: ThingUse } => {
    if (!o.use || !THINGS.has(o.use.kind)) return false;
    const owner = roomAt(map, o.x, o.y) ?? roomAt(map, o.x, o.y + o.h) ?? roomAt(map, o.x, o.y + o.h + 1);
    const key = o.use.kind === 'jukebox' ? o.id : o.use.kind;
    if (owner?.id !== room.id || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
