import { useEffect, useRef } from 'react';
import type { Vacation } from '../../shared/vacation';
import type { Store } from './net';
import type { Engine } from './engine';

/** `back` is a calendar date; only timed returns follow the viewer's time zone. */
export function vacationReturnLabel(vacation: Vacation, locale?: string, timeZone?: string) {
  const date = vacation.back ? Date.parse(`${vacation.back}T12:00:00Z`) : vacation.until;
  return `back ${new Intl.DateTimeFormat(locale, {
    weekday: 'short', day: 'numeric', month: 'short',
    ...(vacation.back ? { timeZone: 'UTC' } : { timeZone, hour: '2-digit', minute: '2-digit' }),
  }).format(date)}`;
}

export function vacationPeople<T extends { vacation?: Vacation | null }>(users: Iterable<T>): (T & { vacation: Vacation })[] {
  return [...users].filter((u): u is T & { vacation: Vacation } => !!u.vacation)
    .sort((a, b) => a.vacation.until - b.vacation.until);
}

export function VacationPanel({ store, engine }: { store: Store; engine: Engine | null }) {
  const armed = useRef(false), people = vacationPeople(store.users.values());
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (!store.gameOpen && e.key === 'Escape') { e.stopPropagation(); store.closeVacations(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [store]);
  return <div className="modal-backdrop" onPointerDown={e => { armed.current = e.target === e.currentTarget; }}
    onClick={e => { if (armed.current && e.target === e.currentTarget) store.closeVacations(); armed.current = false; }}>
    <div className="meet-panel guided calendar-panel vacation-panel" role="dialog" aria-modal="true" aria-label="On vacation">
      <div className="rooms-head"><span>🌴 On vacation · {people.length}</span><button type="button" className="ghost" aria-label="Close" onClick={() => store.closeVacations()}>×</button></div>
      {!people.length && <p className="muted small">Everyone's at work 🏢</p>}
      <ul className="meeting-list">{people.map(u => <li key={u.id}>
        <i className={`pdot vacation-dot ${u.presence}`} aria-label={u.presence} />
        <button className="ghost vacation-person" onClick={() => { engine?.focusUser(u.id); store.closeVacations(); }}>
          <b>{u.name}</b><small className="muted">{vacationReturnLabel(u.vacation)}</small>
        </button>
      </li>)}</ul>
    </div>
  </div>;
}
