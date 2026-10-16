import { Icon } from '../Icon';
import type { Assets } from '../assets';
import { MAP, type Store } from '../net';
import type { Voice } from '../voice';
import { Avatar } from './Avatar';
import { channelTree } from './model';
import { VoiceIcons, roomVoiceOf } from './SelfPanel';
import { rowAnchor } from './PersonRow';
import type { PersonAnchor } from './PersonCard';
export function Rail({ store, voice, assets, speaking, onExpand, onGroup, onPerson, onAction }: {
  store: Store; voice: Voice | null; assets: Assets | null; speaking: Set<string>; onExpand: () => void;
  onGroup: (id: string) => void; onPerson: (at: PersonAnchor) => void; onAction: () => void;
}) {
  const me = store.users.get(store.me), peers = me ? store.callPeers(me).filter(u => u.presence !== 'offline') : [];
  const roomVoice = roomVoiceOf(store, voice);
  const total = [...store.unread.values()].reduce((a, b) => a + b, 0);
  return <aside className="sidebar rail" aria-label="Office sidebar">
    <button aria-label="Show sidebar" onClick={onExpand}><Icon name="chevron-right" /></button>
    {channelTree(store, MAP).filter(g => ['voice', 'knock', 'quiet'].includes(g.id) && g.count).map(g =>
      <button key={g.id} aria-label={`${g.label}, ${g.count} people`} onClick={() => onGroup(g.id)}><span>{g.id === 'knock' ? '#' : <Icon name={g.id === 'voice' ? 'volume' : 'moon'} />}</span><small>{g.count}</small></button>)}
    {!!total && <button aria-label={`${total} unread messages`} onClick={() => { onAction(); store.openChat([...store.unread.keys()][0]); }}><Icon name="message" /> {total}</button>}
    <div className="sb-rail-peers">{peers.slice(0, 5).map(u => <button key={u.id} aria-label={`Actions for ${u.name}`} onClick={e => onPerson({ id: u.id, ...rowAnchor(e.currentTarget) })}>
      <Avatar assets={assets} user={u} size={28} ring={speaking.has(u.id)} /></button>)}{peers.length > 5 && <span>+{peers.length - 5}</span>}</div>
    <div className="sb-rail-bottom sb-right"><VoiceIcons store={store} voice={voice} rail />
      {me?.callId && !me.instance && !store.roomCallOf(me) && <button className="sb-danger" aria-label="Leave call" onClick={() => store.endCall()}><Icon name="disconnect" /></button>}
      {roomVoice && <button className="sb-danger" aria-label={`Leave ${roomVoice.name}`} onClick={() => store.leaveRoom()}><Icon name="disconnect" /></button>}
      {me && <button aria-label="Show sidebar" onClick={onExpand}><Avatar assets={assets} user={me} size={28} /></button>}
    </div>
  </aside>;
}
