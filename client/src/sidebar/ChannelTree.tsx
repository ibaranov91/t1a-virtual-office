import type { Assets } from '../assets';
import { MAP, type Store } from '../net';
import { channelTree } from './model';
import { PersonRow, rowAnchor } from './PersonRow';
import type { PersonAnchor } from './PersonCard';
import type { RoomAnchor } from './RoomMenu';
export function ChannelTree({ store, assets, speaking, query, closed, onToggle, onPerson, onRoom, onAction }: {
  store: Store; assets: Assets | null; speaking: Set<string>; query: string; closed: string[];
  onToggle: (id: string) => void; onPerson: (at: PersonAnchor) => void; onRoom: (at: RoomAnchor) => void; onAction: () => void;
}) {
  const me = store.users.get(store.me), groups = channelTree(store, MAP, query);
  return <>{groups.map(g => {
    const open = !!query.trim() || !closed.includes(g.id);
    return <section className="sb-group" id={`sb-${g.id}`} key={g.id}>
      <button className="sb-group-head" aria-expanded={open} onClick={() => onToggle(g.id)}>
        <span>{open ? '▾' : '▸'}</span><b>{g.label}</b><small>{g.hint}</small><span className="sb-count">{g.count}</span>
      </button>
      {open && <>{g.rooms.map(({ room, people, count, subtitle }) => {
        const selected = !!me && !me.instance && store.roomOf(me)?.id === room.id;
        const openRoom = (el: HTMLElement) => onRoom({ id: room.id, ...rowAnchor(el) });
        return <div key={room.id} className="sb-channel">
          <button className={`sb-room${selected ? ' selected' : ''}${!count ? ' empty' : ''}`} title={`${room.name} · ${room.rules.label}`}
            onClick={e => openRoom(e.currentTarget)} onContextMenu={e => { e.preventDefault(); openRoom(e.currentTarget); }} aria-haspopup="menu">
            <span>{room.rules.access === 'admins' ? '🔒' : g.id === 'voice' ? '🔊' : g.id === 'knock' ? '#' : '🌙'}</span>
            <span className="sb-room-name">{room.name}</span>{subtitle && <small>{subtitle}</small>}
            {!!count && <span className="sb-count">{count}</span>}
          </button>
          <div className="sb-room-people">{people.map(u => <PersonRow key={u.id} store={store} user={u} assets={assets} speaking={speaking} onPerson={onPerson} onAction={onAction} />)}</div>
        </div>;
      })}{g.people.map(u => <PersonRow key={u.id} store={store} user={u} assets={assets} speaking={speaking} onPerson={onPerson} onAction={onAction} />)}</>}
    </section>;
  })}{!groups.length && <p className="sb-empty">No people or rooms found</p>}</>;
}
