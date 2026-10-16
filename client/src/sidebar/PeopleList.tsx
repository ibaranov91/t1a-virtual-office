import { Icon } from '../Icon';
import type { Assets } from '../assets';
import type { Store } from '../net';
import { peopleGroups } from './model';
import { PersonRow } from './PersonRow';
import type { PersonAnchor } from './PersonCard';
export function PeopleList({ store, assets, speaking, query, closed, onToggle, onPerson, onAction }: {
  store: Store; assets: Assets | null; speaking: Set<string>; query: string; closed: string[];
  onToggle: (id: string) => void; onPerson: (at: PersonAnchor) => void; onAction: () => void;
}) {
  const groups = peopleGroups(store, query);
  return <>{groups.map(g => {
    const open = !!query.trim() || !closed.includes(g.id);
    return <section className="sb-group" key={g.id}>
      <button className="sb-group-head" aria-expanded={open} onClick={() => onToggle(g.id)}><span><Icon name={open ? "chevron-down" : "chevron-right"} /></span><b>{g.label}</b><span className="sb-count">{g.people.length}</span></button>
      {open && g.people.map(u => <PersonRow key={u.id} store={store} user={u} assets={assets} speaking={speaking} people onPerson={onPerson} onAction={onAction} />)}
    </section>;
  })}{!groups.length && <p className="sb-empty">No people found</p>}</>;
}
