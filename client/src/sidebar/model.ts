import type { ClientUser, Store } from '../net';
import { roomAt, stallOfCall, tableOfCall, type Room, type TileMap, type MapObject, type ObjectUse } from '../../../shared/map';
import { OFFICE_SCOPE, underground, type JukeboxState, type LiveDeck } from '../../../shared/protocol';
import { EFFECTS, effectName } from '../../../shared/effects';
import { INSTRUMENTS } from '../../../shared/instruments';
import mapJson from '../../../shared/tilemap.json';
import { TRACK } from '../../../shared/music';
import { vacationReturnLabel } from '../Vacation';

export function splitStatus(status: string): { emoji: string | null; text: string } {
  const match = /^(\p{Extended_Pictographic}(?:️|⃣|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}️?)*)\s*/u.exec(status);
  return { emoji: match?.[1] ?? null, text: status.slice(match?.[0].length ?? 0).trim() };
}
export function joinStatus(emoji: string | null, text: string) {
  return (emoji ? `${emoji} ${text}`.trim() : text.trim()).slice(0, 80);
}
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
const ordered = (view: View, us: ClientUser[]) => us.sort((a, b) => Number(b.id === view.me) - Number(a.id === view.me) || Number(!!a.afk) - Number(!!b.afk) || a.name.localeCompare(b.name)); // idle people sink below the ones who are here
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
    : u.afk ? '💤 idle'
    : u.presence === 'away' ? 'away' : '';
  const status = splitStatus(u.status ?? '').text;
  return line ? `${line}${status ? ` · ${status}` : ''}` : status;
}
/** Minutes by which `tz` is ahead of `base` at a particular instant. Shared with ClockPanel. */
export function offsetOf(tz: string, base: string, at: Date) {
  const wall = (z: string) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(at).map(x => [x.type, +x.value])); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 60_000; };
  return wall(tz) - wall(base);
}
export interface HoverContext {
  now: number; zone: string; speaking: boolean; wheelOpen?: boolean;
  tableDescription: Store['tableDescription']; gameDescription: Store['gameDescription'];
  articleTitle(id: string): string | undefined;
  items: ReadonlyMap<string, { icon: string; label: string }>;
}
/** The floor's mini profile. All time and scene data are inputs so its copy is deterministic. */
export function hoverCard(view: View, u: ClientUser, ctx: HoverContext) {
  const mine = u.id === view.me, me = view.users.get(view.me), room = view.roomOf(u), voice = view.roomCallOf(u);
  const live = !u.vacation && (!!voice || !!u.callId || ctx.speaking);
  let presence = u.vacation ? `on vacation until ${vacationReturnLabel(u.vacation).replace(/^back /, '')}`
    : voice ? `in ${voice.name} voice`
    : u.callId ? `talking with ${view.names(view.callPeers(u))}`
    : u.door ? { thinking: 'packing up…', leaving: 'heading out', arriving: 'just arrived' }[u.door]
    : underground(u) ? 'somewhere underground' : u.instance ? 'in a meeting room'
    : u.meeting ? `in a meeting until ${view.clock(u.meeting)}`
    : u.eating ? `having lunch${u.eating.open ? ' · open to talk' : ''}`
    : u.presence === 'offline' ? 'offline' : u.afk ? 'idle' : u.presence === 'away' ? 'away' : 'around';
  if (room && voice?.name !== room.name) presence += ` · ${room.name}`;
  const { emoji, text: status } = splitStatus(u.status ?? ''), pills: string[] = [];
  if (u.table) pills.push(ctx.tableDescription(u.table.objectId, u.id));
  if (u.game) pills.push(ctx.gameDescription(u.game.cabinet, u.id));
  if (u.reading) pills.push(`reading ${ctx.articleTitle(u.reading) ?? 'an article'}`);
  const following = u.following && view.users.get(u.following);
  if (following) pills.push(`following ${following.name.split(' ')[0]}`);
  const item = u.holding && ctx.items.get(u.holding);
  if (item) pills.push(`holding ${item.icon} ${item.label}`);
  for (const e of u.effects ?? []) if (e.kind !== 'hat' && (e.until === undefined || e.until > ctx.now)) {
    pills.push(`${EFFECTS[e.kind]?.icon ?? ''} ${effectName(e)}${e.until === undefined ? '' : ` · ${Math.ceil((e.until - ctx.now) / 1000)}s`}`.trim());
  }
  let localTime = '';
  if (u.tz && !mine) {
    const now = new Date(ctx.now), offset = offsetOf(u.tz, me?.tz ?? ctx.zone, now);
    const time = new Intl.DateTimeFormat('en-US', { timeZone: u.tz, hour: 'numeric', minute: '2-digit' }).format(now);
    localTime = `${time} · ${u.tz.split('/').pop()!.replace(/_/g, ' ')} · ${offset ? `${Math.abs(offset) / 60}h ${offset > 0 ? 'ahead' : 'behind'}` : 'same time'}`;
  }
  const footer = ctx.wheelOpen ? '' : mine ? 'Click to react' : u.presence === 'offline' ? 'Click to message'
    : u.callId && u.callId === me?.callId ? 'Click for volume & more'
    : room?.rules.knock === 'disabled' ? `${room.name}: no knocking · click for more` : 'Click to knock, message or follow';
  return { name: u.name, emoji, you: mine ? '(you)' : '', presence, live, status, pills, localTime, footer };
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
  const group = (u: ClientUser) => u.vacation ? 'vacation' : u.presence === 'offline' ? 'offline' : u.callId ? 'p-voice' : u.presence === 'away' || u.afk ? 'p-away' : 'p-online';
  return [{ id: 'p-voice', label: 'In voice' }, { id: 'p-online', label: 'Online' }, { id: 'p-away', label: 'Away' }, { id: 'vacation', label: 'On vacation' }, { id: 'offline', label: 'Offline' }]
    .map(g => { const found = [...view.users.values()].filter(u => group(u) === g.id && (!q || matches(u.name, q) || matches(place(view, u), q))); return { ...g, people: g.id === 'vacation' ? byReturn(found) : ordered(view, found) }; })
    .filter(g => g.people.length);
}
const THINGS = new Set(['jukebox', 'youtube', 'records', 'meetings', 'library', 'clock', 'achievements', 'calendar', 'link', 'tickets', 'room_start']);
type ThingUse = Extract<ObjectUse, { kind: 'jukebox' | 'youtube' | 'records' | 'meetings' | 'library' | 'clock' | 'achievements' | 'calendar' | 'link' | 'tickets' | 'room_start' }>;
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

/** CSS shorthand keeps pixel patterns identical in previews and profile strips. */
export function bannerStyle(banner: import('../../../shared/protocol').Banner | null | undefined, look: Pick<import('../../../shared/protocol').Look, 'shirt'>): string {
  if (!banner) return look.shirt;
  if (banner.kind === 'image') return `url(${JSON.stringify(banner.url)}) center / cover`;
  if (banner.kind === 'color') return banner.color;
  const c = banner.color, d = `color-mix(in srgb, ${c} 70%, black)`;
  switch (banner.pattern) {
    case 'stripes': return `repeating-linear-gradient(45deg, ${d} 0 4px, transparent 4px 8px) 0 0 / 16px 16px ${c}`;
    case 'checks': return `repeating-conic-gradient(${d} 0 25%, transparent 0 50%) 0 0 / calc(8px * 2) calc(8px * 2) ${c}`;
    case 'diamond': return `linear-gradient(45deg, ${d} 25%, transparent 25% 75%, ${d} 75%) 0 0 / 16px 16px, linear-gradient(-45deg, ${d} 25%, transparent 25% 75%, ${d} 75%) 0 0 / 16px 16px ${c}`;
    case 'dots': return `radial-gradient(circle, ${d} 0 3px, transparent 3px) 0 0 / 12px 12px ${c}`;
    case 'zigzag': return `linear-gradient(135deg, ${d} 25%, transparent 25%) -8px 0 / 16px 16px, linear-gradient(225deg, ${d} 25%, transparent 25%) -8px 0 / 16px 16px, linear-gradient(315deg, ${d} 25%, transparent 25%) 0 0 / 16px 16px, linear-gradient(45deg, ${d} 25%, transparent 25%) 0 0 / 16px 16px ${c}`;
    case 'plaid': return `repeating-linear-gradient(0deg, ${d} 0 4px, transparent 4px 16px) 0 0 / 16px 16px, repeating-linear-gradient(90deg, ${d} 0 4px, transparent 4px 16px) 0 0 / 16px 16px ${c}`;
  }
}
