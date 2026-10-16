import { useEffect, useState } from 'react';
import type { Store } from '../net';
import type { Engine } from '../engine';
import type { Assets } from '../assets';
import { prefs, savePrefs, subscribePrefs } from '../prefs';
import { activityLine, place } from './model';
import { Avatar, useSpeaking } from './Avatar';
import { useSurface } from './hooks';
export type PersonAnchor = { id: string; x: number; y: number };
export function PersonCard({ store, engine, assets, at, compact, onClose, onAction, onAppearance }: {
  store: Store; engine: Engine | null; assets: Assets | null; at: PersonAnchor; compact: boolean;
  onClose: () => void; onAction: () => void; onAppearance: () => void;
}) {
  const surface = useSurface(store, at, compact, onClose), speaking = useSpeaking(store, engine);
  const [, tick] = useState(0);
  useEffect(() => subscribePrefs(() => tick(n => n + 1)), []);
  const u = store.users.get(at.id), me = store.users.get(store.me);
  if (!u) return null;
  const mine = u.id === store.me, room = store.roomCallOf(u), activity = activityLine(store, u);
  const offline = u.presence === 'offline', away = u.door === 'thinking' || u.door === 'leaving';
  const knock = store.knockReason(u), dungeon = store.dungeonReason(u);
  const walk = offline ? 'Offline' : dungeon || (me?.instance ? 'Leave the meeting room first' : u.instance && u.instance !== me?.instance ? `${u.name.split(' ')[0]} is in a meeting room` : null);
  const follow = offline ? 'Offline' : away ? 'Heading out' : dungeon;
  const following = me?.following === u.id, value = Math.round((prefs.volumes[u.id] ?? 1) * 100);
  const reason = knock || walk || follow;
  const act = (fn: () => void) => { onAction(); fn(); };
  return <div {...surface} className={`sb-card sb-surface${compact ? ' sb-surface-sheet' : ''}`} role="dialog" aria-label={u.name}>
    <header>{compact ? <button className="ghost" onClick={onClose}>← Back</button> : <button className="ghost" onClick={onClose} aria-label="Close person card">×</button>}
      <div className="sb-card-head"><Avatar assets={assets} user={u} size={48} ring={speaking.has(u.id)} />
        <div><b>{u.name}</b><small>{{ online: 'Online', away: 'Away', in_call: 'In a call', offline: 'Offline' }[u.presence]} · {place(store, u)}</small>
          {u.tz && <small>{new Intl.DateTimeFormat([], { timeZone: u.tz, hour: '2-digit', minute: '2-digit' }).format(new Date())} their time</small>}</div></div>
    </header>
    <div className="sb-surface-body">
      {activity && <p>{activity}</p>}
      {u.callId && <p>{room ? `In ${room.name} voice` : `On a call with ${store.names(store.callPeers(u))}`}{u.muted ? ' · mic off' : ''}{u.deafened ? ' · deafened' : ''}</p>}
      <div className="sb-actions">
        {mine ? <><button data-action disabled={!engine} onClick={() => act(() => engine?.recenter())}>Find me</button><button data-action onClick={() => act(onAppearance)}>Change look</button></> : <>
          <button data-action disabled={!!knock} onClick={() => act(() => store.requestKnock(u.id))}>Knock</button>
          <button data-action onClick={() => act(() => store.openChat(u.id))}>Message</button>
          <button data-action disabled={!!walk || !engine} onClick={() => act(() => engine?.walkToUser(u.id))}>Walk over</button>
          <button data-action className={following ? 'on' : ''} aria-pressed={following} disabled={!!follow} onClick={() => store.follow(following ? null : u.id)}>{following ? 'Unfollow' : 'Follow'}</button>
          {!away && !store.roomReason(u) && <button data-action title={`Take ${u.name.split(' ')[0]} to a private room`} onClick={() => act(() => store.createRoom([u.id]))}>Private room</button>}
          {store.admin && me && !me.instance && !u.instance && !away && !offline && <button data-action onClick={() => act(() => store.teleport(u.id))}>Teleport</button>}
          {store.admin && !u.bot && <button data-action onClick={() => act(() => { const v = window.prompt(`New name for ${u.name}`, u.name); if (v?.trim()) store.rename(u.id, v); })}>Rename</button>}
        </>}
      </div>
      {!mine && reason && <p className="sb-reason">{reason}</p>}
      {!mine && !u.bot && <>
        <label className="volume-control sb-volume-control"><span>Voice volume</span><input type="range" min="0" max="200" step="5" value={value} aria-label={`${u.name} voice volume`}
          onChange={e => { prefs.volumes[u.id] = Number(e.target.value) / 100; savePrefs(); }} /><output>{value}%</output></label>
        <button className={prefs.localMuted[u.id] ? 'muted-btn' : 'ghost'} aria-pressed={!!prefs.localMuted[u.id]}
          onClick={() => { if (prefs.localMuted[u.id]) delete prefs.localMuted[u.id]; else prefs.localMuted[u.id] = true; savePrefs(); }}>{prefs.localMuted[u.id] ? 'Unmute for me' : 'Mute for me'}</button>
      </>}
    </div>
  </div>;
}
