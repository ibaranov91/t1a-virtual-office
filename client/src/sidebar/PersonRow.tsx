import type { Assets } from '../assets';
import type { Store, ClientUser } from '../net';
import { prefs } from '../prefs';
import { Avatar } from './Avatar';
import { activityLine, instrument, place } from './model';
import type { PersonAnchor } from './PersonCard';
export const rowAnchor = (el: HTMLElement) => {
  const row = el.getBoundingClientRect(), sidebar = el.closest('.sidebar')?.getBoundingClientRect();
  return { x: (sidebar?.right ?? row.right) + 8, y: row.top };
};
export function PersonRow({ store, user: u, assets, speaking, people, onPerson, onAction }: {
  store: Store; user: ClientUser; assets: Assets | null; speaking: Set<string>; people?: boolean;
  onPerson: (at: PersonAnchor) => void; onAction: () => void;
}) {
  const offline = u.presence === 'offline', activity = activityLine(store, u);
  const line = people ? [place(store, u), activity].filter(Boolean).join(' · ') : activity;
  const open = (el: HTMLElement) => onPerson({ id: u.id, ...rowAnchor(el) });
  const playing = instrument(store, u), volume = Math.round((prefs.volumes[u.id] ?? 1) * 100);
  const unread = store.unread.get(u.id);
  return <div className={`sb-person${offline ? ' off' : ''}${!offline && line ? ' two-lines' : ''}`}>
    <button className={`sb-person-main${u.id === store.me ? ' me' : ''}`} onClick={e => open(e.currentTarget)}
      onContextMenu={e => { e.preventDefault(); open(e.currentTarget); }} aria-haspopup="dialog">
      {!offline && <Avatar assets={assets} user={u} size={22} ring={speaking.has(u.id)} />}
      <span className="sb-person-text"><span>{u.name}{!offline && u.id === store.me ? ' (you)' : ''}</span>
        {!offline && line && <small>{line}</small>}</span>
    </button>
    {!offline && <span className="sb-marks">
      {u.callId && u.muted && <span className="sb-danger" title="Mic off">🔇</span>}
      {u.callId && u.deafened && <span className="sb-crossed" title="Deafened">🎧</span>}
      {u.hand && store.roomCallOf(u) && <span title="Hand raised">✋</span>}
      {u.game && <span>{u.game.role === 'player' ? '🕹' : '👀'}</span>}
      {playing && <span title={playing.name}>{playing.icon}</span>}
    </span>}
    {!!unread && <button className="sb-unread" aria-label={`Message ${u.name}, ${unread} unread`} onClick={() => { onAction(); store.openChat(u.id); }}>💬 {unread}</button>}
    {!offline && (prefs.localMuted[u.id] ? <span className="sb-volume">🔕</span> : volume !== 100 && <span className="sb-volume">{volume}%</span>)}
  </div>;
}
