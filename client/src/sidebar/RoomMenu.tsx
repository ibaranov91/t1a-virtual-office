import { ROOM_MODES, roomMode } from '../../../shared/roomModes';
import { Icon } from '../Icon';
import { MAP, type Store } from '../net';
import type { Engine } from '../engine';
import { underground } from '../../../shared/protocol';
import { roomThings } from './model';
import { useSurface } from './hooks';
export type RoomAnchor = { id: string; x: number; y: number };
export function RoomMenu({ store, engine, at, compact, onClose, onAction, onTv }: {
  store: Store; engine: Engine | null; at: RoomAnchor; compact: boolean; onClose: () => void; onAction: () => void; onTv: (id: string) => void;
}) {
  const surface = useSurface(store, at, compact, onClose);
  const room = MAP.rooms.find(r => r.id === at.id), me = store.users.get(store.me);
  if (!room) return null;
  const n = [...store.users.values()].filter(u => u.presence !== 'offline' && !u.instance && store.roomOf(u)?.id === room.id).length;
  const reason = me && underground(me) ? 'Find the way out first' : me?.instance ? 'Leave the meeting room first'
    : me && store.roomOf(me)?.id === room.id ? "You're here" : room.rules.access === 'admins' && !store.sysadmin ? 'Admins only' : null;
  const act = (fn: () => void) => { onAction(); fn(); };
  return <div {...surface} className={`sb-menu sb-surface${compact ? ' sb-surface-sheet' : ''}`} role="menu" aria-label={room.name}>
    <header>{compact ? <button className="ghost" onClick={onClose}>← Back</button> : <button className="ghost" onClick={onClose} aria-label="Close room menu"><Icon name="close" /></button>}<b>{room.name}</b><small>{room.rules.label}{n ? ` · ${n} here` : ''}</small></header>
    <div className="sb-surface-body">
      <button data-action role="menuitem" disabled={!!reason || !engine} onClick={() => act(() => engine?.walkToRoom(room.id))}>
        {room.rules.voice === 'open' ? 'Walk in and talk' : 'Walk here'}{reason && <small>{reason}</small>}</button>
      {roomThings(MAP, room).map(o => {
        const use = o.use!;
        const label = use.kind === 'jukebox' ? `${use.label.replace(/^./, c => c.toUpperCase())}: now playing` : use.kind === 'youtube' ? `TV: ${use.label}`
          : use.kind === 'records' ? 'Arcade records' : use.kind === 'meetings' ? 'Meetings on now'
          : use.kind === 'library' ? 'Library shelf' : use.kind === 'clock' ? 'Our time zones'
          : use.kind === 'achievements' ? (o.type === 'trophy_case' ? 'Trophy case: your achievements' : 'Employee Of the Month') : use.kind === 'calendar' ? 'Your calendar' : use.kind === 'tickets' ? 'Suggestions board: suggest or report a bug'
          : use.kind === 'room_start' ? 'Start a private room' : `Open the ${use.label}`;
        const run = () => {
          switch (use.kind) {
            case 'jukebox': return store.openJukebox(o.id);
            case 'youtube': return onTv(o.id);
            case 'records': return store.openRecords();
            case 'meetings': return store.openMeetings();
            case 'library': return store.openLibrary();
            case 'clock': return store.openClock();
            case 'achievements': return o.type === 'trophy_case' ? store.openAchievements(true) : store.openEmployeeBoard();
            case 'calendar': return store.openCalendar();
            case 'link': return store.openLink(use);
            case 'tickets': return store.use(o.id); // walks over; the screen opens on arrival
            case 'room_start': return store.use(o.id); // walks to the kiosk; the server opens the popup on arrival
          }
        };
        const why = use.kind === 'room_start' && me && (underground(me) || me.instance) ? reason : null; // the kiosk is a walk away
        return <button key={o.id} data-action role="menuitem" disabled={!!why} onClick={() => act(run)}>{label}{why && <small>{why}</small>}</button>;
      })}
      {store.admin && <div className="sb-room-modes" role="group" aria-label="Room mode">
        <b>Room mode</b>
        {ROOM_MODES.map(mode => <button key={mode.id} data-action role="menuitemradio" aria-checked={roomMode(room) === mode.id}
          disabled={!store.connected} onClick={() => store.setRoomMode(room.id, mode.id)}>
          <span>{mode.label}{roomMode(room) === mode.id && <Icon name="check" />}</span><small>{mode.hint}</small>
        </button>)}
      </div>}
    </div>
  </div>;
}
