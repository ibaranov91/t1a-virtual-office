import { useEffect, useState } from 'react';
import type { Store, ClientUser } from './net';

const MAX_INVITES = 29;
const PRESENCE_RANK: Record<string, number> = { online: 0, away: 1, offline: 2 };

/** Start a private room (title + people) or, from inside one, invite more people. Bottom sheet on phones (CSS). */
export function RoomPopup({ store }: { store: Store }) {
  const inside = store.myAdhoc;
  const [title, setTitle] = useState(''), [q, setQ] = useState(''), [picked, setPicked] = useState<string[]>([]);
  const close = () => store.openRoom(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const people = [...store.users.values()]
    .filter(u => !u.bot && u.id !== store.me && u.presence !== 'offline')
    .sort((a, b) => (PRESENCE_RANK[a.presence] ?? 1) - (PRESENCE_RANK[b.presence] ?? 1) || a.name.localeCompare(b.name));
  const shown = people.filter(u => u.name.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string) => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : p.length < MAX_INVITES ? [...p, id] : p);
  const go = () => inside ? picked.length && store.inviteToRoom(picked) : store.createRoom(picked, title);
  const name = (id: string) => store.users.get(id)?.name.split(' ')[0] ?? '?';
  return <div className="modal-backdrop room-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
    <form className="meet-panel guided room-popup" role="dialog" aria-label={inside ? 'Invite to the private room' : 'Private room'} onSubmit={e => { e.preventDefault(); go(); }}>
      <div className="rooms-head"><span>🔒 {inside ? `Invite to ${inside.title}` : 'Private room'}</span><button type="button" className="ghost" aria-label="Close" onClick={close}>×</button></div>
      {!inside && <input autoFocus value={title} maxLength={60} onChange={e => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Room title" />}
      {picked.length > 0 && <div className="room-chips">{picked.map(id => <button type="button" key={id} className="chip" title="Remove" onClick={() => toggle(id)}>{name(id)} ×</button>)}</div>}
      <input autoFocus={!!inside} value={q} onChange={e => setQ(e.target.value)} placeholder="Find people…" aria-label="Find people" />
      <ul className="room-people">
        {shown.map(u => <PersonRow key={u.id} u={u} on={picked.includes(u.id)} full={picked.length >= MAX_INVITES} onToggle={() => toggle(u.id)} />)}
        {!shown.length && <li className="muted small">{people.length ? 'No one by that name' : 'No one else is around'}</li>}
      </ul>
      <div className="row">
        <button type="button" className="ghost" onClick={close}>Cancel</button>
        <button type="submit" disabled={inside ? !picked.length : false}>{inside ? `Invite ${picked.length || ''}`.trim() : picked.length ? `Start with ${picked.length}` : 'Start'}</button>
      </div>
    </form>
  </div>;
}

function PersonRow({ u, on, full, onToggle }: { u: ClientUser; on: boolean; full: boolean; onToggle: () => void }) {
  return <li><label className={on ? 'on' : ''}>
    <input type="checkbox" checked={on} disabled={!on && full} onChange={onToggle} />
    <span>{u.name}</span><small className="muted">{u.presence === 'online' ? '' : u.presence}</small>
  </label></li>;
}
