// Notification center (v2): the bottom slot (modes), the over-character slot, the activity log and the DND toggle.
// The top slot is `Toasts` in App.tsx. Rules in notify.ts and docs/UI.md "Notifications".
import { useEffect, useRef } from 'react';
import type { Engine } from './engine';
import { Icon, IconButton } from './Icon';
import type { Mode } from './notify';
import { slotOf } from './notify';
import type { Store } from './net';

/** Bottom slot: a mode you are in, with its exit. `extra` are modes derived from state (the dungeon) rather than pushed with `store.setMode`. */
export function ModeBar({ store, extra = [] }: { store: Store; extra?: Mode[] }) {
  const modes = [...store.modes, ...extra].slice(-2);
  if (!modes.length) return null;
  return <div className="modes" role="status">
    {modes.map(m => <div key={m.id} className="desk-chip call-chip mode-chip">
      <span>{m.icon && `${m.icon} `}<b>{m.text}</b>{m.hint && <small> · {m.hint}</small>}</span>
      {m.actions?.map(a => <button key={a.label} onClick={a.run}>{a.label}</button>)}
      <button className="end" onClick={m.exit.run}>{m.exit.label}</button>
    </div>)}
  </div>;
}

/** Over-character slot: brief notices floating above my own sprite, game-style. */
export function OverNotices({ store, engine }: { store: Store; engine: Engine | null }) {
  const box = useRef<HTMLDivElement>(null);
  const items = store.toasts.filter(t => slotOf(t) === 'over');
  const count = items.length;
  useEffect(() => {
    if (!count || !engine) return;
    let raf = 0;
    const tick = () => {
      const el = box.current, stage = el?.parentElement, a = engine.anchor({ kind: 'user', id: store.me });
      if (el && stage && a) {
        const b = stage.getBoundingClientRect(), x = a.x - b.left, y = a.y - b.top - a.r - 24;
        el.style.transform = `translate(${Math.max(8, Math.min(b.width - el.offsetWidth - 8, x - el.offsetWidth / 2))}px, ${Math.max(8, y - el.offsetHeight)}px)`;
        el.style.visibility = 'visible';
      } else if (el) el.style.visibility = 'hidden';
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [count, engine, store]);
  if (!count) return null;
  return <div className="over-notices" ref={box} role="status" aria-live="polite">
    {items.map(t => <div key={t.id} className="over-notice">{t.text}</div>)}
  </div>;
}

const KIND_ICON: Record<string, string> = { knock_in: '✊', knock_out: '✊', call: '📞', meeting: '📅', room: '🔒', notice: '✨' };
const when = (at: number, now: number) => {
  const m = Math.floor((now - at) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** Activity log: the event journal (plus this page's own notices), newest first, with what was new when you opened it. */
export function ActivityPanel({ store }: { store: Store }) {
  const readAt = useRef(store.journalReadAt).current, now = store.now();
  const entries = store.activity;
  const close = () => store.openActivity(false);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="meet-panel guided activity-panel" role="dialog" aria-label="Activity">
      <div className="rooms-head">
        <span>Activity</span>
        <button aria-label="Close" type="button" className="ghost" onClick={close}><Icon name="close" /></button>
      </div>
      {entries.length ? <ul className="later-list activity-list">
        {entries.map(e => {
          const other = e.otherId ? store.users.get(e.otherId) : undefined;
          return <li key={e.id} className={e.at > readAt ? 'new' : ''}>
            <span aria-hidden="true">{KIND_ICON[e.kind] ?? '•'}</span>
            <span className="txt">{e.text}<small className="hint">{when(e.at, now)}{e.at > readAt ? ' · new' : ''}</small></span>
            {e.action === 'knock_back' && other && other.presence !== 'offline' && other.id !== store.me && <button onClick={() => { store.knock(other.id); close(); }}>Knock back</button>}
          </li>;
        })}
      </ul> : <p className="muted">Nothing yet. Knocks, calls and meetings show up here.</p>}
    </div>
  </div>;
}

/** Top bar: the moon (Do not disturb) and the activity log with its unread count. */
export function PresenceButtons({ store }: { store: Store }) {
  const me = store.users.get(store.me), n = store.activityUnread;
  if (!me) return null;
  return <>
    <IconButton icon="activity" label={n ? `Activity · ${n} new` : 'Activity'} className={`chip activity-btn${store.activityOpen ? ' on' : ''}`}
      aria-haspopup="dialog" aria-expanded={store.activityOpen} onClick={() => store.openActivity(!store.activityOpen)}>
      {n > 0 && <b className="badge">{n > 99 ? '99+' : n}</b>}
    </IconButton>
    <IconButton icon="moon" label={me.dnd ? 'Do not disturb is on: knocks wait in Later' : 'Do not disturb'} className={`chip dnd-btn${me.dnd ? ' on' : ''}`}
      aria-pressed={!!me.dnd} onClick={() => store.setDnd(!me.dnd)} />
  </>;
}
