import { useEffect, useRef, useState } from 'react';
import type { Assets } from '../assets';
import { MAP, type Store } from '../net';
import type { Voice } from '../voice';
import { needsGesture, resume } from '../audio';
import { prefs, savePrefs, type Category } from '../prefs';
import { MEET_LINK_RE, meetAs } from '../../../shared/protocol';
import { ExternalLink } from '../links';
import { PRESENCE_COLOR } from './model';
import { Avatar } from './Avatar';
import { overlayOpen } from './hooks';


export function EnableSound() {
  return needsGesture() ? <button onClick={() => void resume()}>Enable sound</button> : null;
}


/** "Within earshot" for the room tooltip. */
export function earshotLine(store: Store) {
  const me = store.users.get(store.me), room = store.roomCallOf(me);
  if (!me || !room) return me?.callId ? `Talking with ${store.names(store.callPeers(me))}` : '';
  const inside = !me.instance && store.roomOf(me)?.id === room.id;
  const near = store.callPeers(me).filter(u => !u.bot && u.presence !== 'offline' && inside && u.instance === me.instance && store.roomOf(u)?.id === room.id);
  return `In ${room.name} · ${near.length ? `within earshot: ${near.map(u => u.name.split(' ')[0]).join(', ')}` : 'nobody within earshot'}`;
}


const PRESENCES = [['online', 'Online'], ['away', 'Away'], ['in_call', 'In a call']] as const;

/** You, as one pill: presence dot (opens a presence menu), name, room (earshot tooltip) and status (opens the status popover). */
export function IdentityPill({ store, roomName, assets }: { store: Store; roomName?: string; assets?: Assets | null }) {
  const me = store.users.get(store.me);
  const [open, setOpen] = useState<'status' | 'presence' | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const close = (save: boolean) => {
    if (save && draftRef.current !== null) store.setStatus(draftRef.current);
    setDraft(null); setOpen(null);
  };
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target)) close(true); };
    const key = (e: KeyboardEvent) => { if (!overlayOpen(store) && e.key === 'Escape') { e.stopImmediatePropagation(); close(false); } };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [open]);
  if (!me) return null;
  const text = me.status ?? '';
  const shown = text.length > 24 ? `${text.slice(0, 23)}…` : text;
  const presence = me.presence === 'offline' ? 'online' : me.presence;
  return <div className="id-wrap" ref={ref}>
    <div className="chip id-pill">
      <button className="id-dot" aria-label={`Presence: ${PRESENCES.find(p => p[0] === presence)?.[1]}`} aria-haspopup="menu" aria-expanded={open === 'presence'}
        title="Change presence" onClick={() => (open === 'presence' ? close(true) : (close(true), setOpen('presence')))}>
        {assets !== undefined ? <Avatar assets={assets} user={me} size={28} /> : <i className="dot" style={{ background: PRESENCE_COLOR[me.presence] }} />}
      </button>
      <button className="id-main" aria-haspopup="dialog" aria-expanded={open === 'status'} aria-label={`Status: ${text || 'none'} · click to change`}
        onClick={() => (open === 'status' ? close(true) : setOpen('status'))}>
        <b>{me.name}</b>
        <span className="id-room" title={earshotLine(store)}>· {roomName ? `in ${roomName}` : 'in the hallway'}</span>
        <span className={`id-status${text ? '' : ' muted'}`} title={text ? `${text} · click to change` : 'Set a status (waters your plant)'}>{assets === undefined ? '· ' : ''}{shown || 'Set a status'}</span>
      </button>
    </div>
    {open === 'presence' && <div className="presence-pop" role="menu" aria-label="Presence">
      {PRESENCES.map(([id, label]) => <button key={id} role="menuitemradio" aria-checked={presence === id} className={presence === id ? 'on' : 'ghost'}
        onClick={() => { store.setPresence(id); setOpen(null); }}>
        <i className="dot" style={{ background: PRESENCE_COLOR[id] }} />{label}</button>)}
    </div>}
    {open === 'status' && <div className="status-pop" role="dialog" aria-label="Status">
      <form onSubmit={e => { e.preventDefault(); close(true); }}>
        <input autoFocus value={draft ?? text} maxLength={80} placeholder="What are you on? (waters your plant)" onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (!overlayOpen(store) && e.key === 'Escape') { e.stopPropagation(); close(false); } }} />
      </form>
      <div className="status-row">
        <button className="ghost" disabled={!text && !draft} onClick={() => { store.setStatus(''); close(false); }}>Clear</button>
      </div>
    </div>}
  </div>;
}

/** A toothed cog (Material "settings" outline), filled; the sun-like line gear read as a brightness control. */
export const COG = 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z';

/** One line-art icon set for the voice buttons, same stroke style as the hanger buttons. `off` draws the same icon crossed out. */
export function VIcon({ name, off }: { name: 'mic' | 'speaker' | 'hand' | 'gear' | 'swap'; off?: boolean }) {
  const d = {
    mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6',
    speaker: 'M4 10v4h3l5 4V6L7 10H4ZM15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10',
    hand: 'M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 5a1.5 1.5 0 0 1 3 0v6M14 6.5a1.5 1.5 0 0 1 3 0V12M8 12l-2-2.5a1.5 1.5 0 0 0-2.4 1.8L7 17.5c1.2 2 3 3.5 6 3.5 3.3 0 5.5-2.2 5.5-5.5V12',
    gear: '',
    swap: 'M4 7h11l-3-3M20 17H9l3 3',
  }[name];
  if (name === 'gear') return <svg viewBox="0 0 24 24" aria-hidden="true"> {/* sound settings: a speaker with a cog in the corner */}
    <path d="M2.5 8.5v5h3l4.5 3.5V5L5.5 8.5h-3ZM13.5 8.5a3 3 0 0 1 0 5" />
    <path className="cog" d={COG} transform="translate(12.5 12.5) scale(0.48)" />
  </svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} />{off && <path className="slash" d="M4 4l16 16" />}</svg>;
}

/** Mic, deafen, hand and sound settings as icon buttons (top bar; the dock on phones). */
export function VoiceIcons({ store, voice, dock, rail }: { store: Store; voice: Voice | null; dock?: boolean; rail?: boolean }) {
  const [pop, setPop] = useState<'settings' | 'claim' | null>(null);
  const settings = pop === 'settings';
  const ref = useRef<HTMLDivElement>(null);
  const me = store.users.get(store.me), room = store.roomCallOf(me), owner = store.connected && store.voiceOwner;
  const elsewhere = store.connected && !store.voiceOwner; // another tab has voice: same four slots, disabled, a badge on the mic
  useEffect(() => {
    if (!pop) return;
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target)) setPop(null); };
    const key = (e: KeyboardEvent) => { if (!overlayOpen(store) && e.key === 'Escape') { e.stopImmediatePropagation(); setPop(null); } };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [pop]);
  useEffect(() => { if (!elsewhere && pop === 'claim') setPop(null); }, [elsewhere]);
  const err = voice?.micError ?? null;
  const muted = voice?.muted ?? true, deaf = voice?.deafened ?? prefs.deafened, micOff = muted || deaf, ptt = (voice?.mode ?? prefs.mode) === 'ptt';
  const btn = (cls: string, icon: React.ReactNode, label: string, title: string, short: string, onClick: () => void, extra: { disabled?: boolean; pressed?: boolean; badge?: boolean } = {}) =>
    <button className="vbtn chip" data-state={cls} disabled={extra.disabled} aria-label={label} aria-pressed={extra.pressed} title={title} onClick={onClick}>
      {icon}{extra.badge && <b className="vbadge" aria-hidden="true" />}{dock && <small>{short}</small>}</button>;
  const waiting = store.voiceWait ? `Waiting for a spot in ${MAP.rooms.find(r => r.id === store.voiceWait)?.name ?? 'room'} voice` : null;
  const away = 'Voice is on in another tab';
  return <div className={`voice-icons${dock ? ' in-dock' : ''}${rail ? ' in-rail' : ''}`} ref={ref} role="group" aria-label="Your voice controls">
    {elsewhere
      ? btn('off elsewhere', <VIcon name="mic" off={micOff} />, 'Voice is in another tab', `${away} · click to use voice here`, 'Voice',
        () => setPop(p => (p === 'claim' ? null : 'claim')), { pressed: pop === 'claim', badge: true })
      : !me?.callId ? btn('idle', <VIcon name="mic" />, 'Microphone not in use', 'Mic not in use · knock on someone or walk into Coffee or the Arcade to talk', 'Mic', () => {}, { disabled: true })
      : btn(err ? 'err' : micOff ? 'muted' : 'live', <VIcon name="mic" off={micOff} />, deaf ? 'Hear again' : muted ? 'Unmute' : 'Mute',
        err ?? (deaf ? 'Deafened, so your mic is off · click to hear again' : muted ? 'Muted · click to unmute' : ptt ? 'Mic on · hold Space to talk (click to mute)' : 'Mic live · click to mute') + (ptt && muted ? ' · Space to talk once unmuted' : ''),
        deaf ? 'Deaf' : muted ? 'Unmute' : 'Mic', () => (deaf ? voice?.toggleDeafen() : voice?.toggleMute()), { disabled: !owner || !voice, pressed: micOff })}
    {btn(elsewhere ? 'off' : deaf ? 'off' : 'live', <VIcon name="speaker" off={deaf} />, deaf ? 'Undeafen' : 'Deafen', elsewhere ? away : deaf ? 'Deafened · click to hear again' : 'Hearing everyone · click to deafen',
      deaf ? 'Deaf' : 'Hear', () => voice?.toggleDeafen(), { disabled: !owner || !voice, pressed: deaf })}
    {(!rail || room) && btn(me?.hand && room ? 'live' : 'off', <VIcon name="hand" />, me?.hand ? 'Lower hand' : 'Raise hand',
      elsewhere ? away : !room ? 'Raise your hand (in a room call)' : me?.hand ? 'Lower your hand' : 'Raise your hand',
      'Hand', () => store.setHand(!me?.hand), { disabled: !owner || !room, pressed: !!me?.hand && !!room })}
    {btn(err ? 'err' : 'off', <VIcon name="gear" />, 'Sound settings', elsewhere ? away : 'Sound settings', 'Sound', () => setPop(p => (p === 'settings' ? null : 'settings')),
      { pressed: settings, disabled: elsewhere })}
    {pop === 'claim' && <div className="settings-pop" role="dialog" aria-label="Voice in another tab">
      <small>{away}.</small>
      <button onClick={() => { setPop(null); store.claimVoice(); }}>Use voice here</button>
    </div>}
    {settings && <div className="settings-pop" role="dialog" aria-label="Sound settings">
      <div className="rooms-head"><span>Sound settings</span><button className="ghost" aria-label="Close sound settings" onClick={() => setPop(null)}>×</button></div>
      {err && <small className="warn">{err}</small>}
      {waiting && <small>{waiting}</small>}
      <EnableSound />
      <label className="input-mode">Input mode<select value={voice?.mode ?? prefs.mode} disabled={!owner || !voice}
        onChange={e => { if (voice && e.target.value !== voice.mode) voice.toggleMode(); }}>
        <option value="voice">Voice activity</option><option value="ptt">Push-to-talk (hold Space)</option>
      </select></label>
      {(['voice', 'music', 'effects'] as Category[]).map(id => <label className="volume-control" key={id}>
        <span>{{ voice: 'Voices', music: 'Music', effects: 'Effects' }[id]}</span>
        <input type="range" min="0" max="100" step="5" value={Math.round(prefs.mix[id] * 100)} aria-label={`${id} volume`}
          onChange={e => { prefs.mix[id] = Number(e.target.value) / 100; savePrefs(); }} /><output>{Math.round(prefs.mix[id] * 100)}%</output>
      </label>)}
    </div>}
  </div>;
}

export function voiceState(voice: Voice | null) {
  if (!voice) return 'connecting…';
  if (voice.deafened) return 'deafened';
  if (voice.micError) return 'listen-only';
  if (voice.muted) return 'muted';
  if (voice.connectedCount() < voice.peerCount()) return 'connecting…';
  if (voice.mode === 'ptt') return 'hold Space to talk';
  return 'live';
}

/** Knock calls keep the shared Meet link. */
export function CallChip({ store, voice }: { store: Store; voice: Voice | null }) {
  const me = store.users.get(store.me); if (!me?.callId) return null;
  const state = voiceState(voice), peers = store.callPeers(me);
  const meet = store.callLink && MEET_LINK_RE.test(store.callLink) ? store.callLink : null;
  return <div className="desk-chip call-chip knock-panel">
    <span className={`dot ${state === 'live' ? 'live' : ''}`} />
    <span>Talking with {store.names(peers)} <small>· {state}</small></span>
    <button className="end" onClick={() => store.endCall()}>Leave</button>
    {meet && <ExternalLink href={meetAs(meet, store.meetAccount)} onOpen={() => store.moveToMeet()}>Move to Meet</ExternalLink>}
  </div>;
}

/** In an open-voice room: always say plainly whether the room can hear you, with the one button that changes it. */
export function RoomVoiceChip({ store, voice }: { store: Store; voice: Voice | null }) {
  const me = store.users.get(store.me), room = store.roomCallOf(me);
  if (!me || !room || !voice?.inRoomCall || !store.voiceOwner || me.instance || store.roomOf(me)?.id !== room.id) return null;
  const others = store.callPeers(me).filter(u => !u.bot && u.presence !== 'offline' && !u.instance && store.roomOf(u)?.id === room.id);
  const who = others.length ? others.map(u => u.name.split(' ')[0]).join(', ') : 'nobody yet';
  const [state, text] = voice.deafened ? ['off', `Deafened in ${room.name}`]
    : voice.micError ? ['off', `Listen-only in ${room.name}`]
    : voice.muted ? ['off', `Muted in ${room.name} · nobody hears you`]
    : voice.mode === 'ptt' ? voice.spaceHeld ? ['live', `Talking in ${room.name}`] : ['ptt', `Push-to-talk in ${room.name} · hold Space`]
    : ['live', `Live in ${room.name} · everyone here hears you`];
  return <div className={`desk-chip call-chip room-voice ${state}`} role="status">
    <span className={`dot ${state === 'live' ? 'live' : ''}`} />
    <span>{text} <small>· here: {who}</small></span>
    {voice.deafened ? <button className="ghost" onClick={() => voice.toggleDeafen()}>Hear again</button>
      : voice.micError ? null
      : voice.muted ? <button onClick={() => voice.setMuted(false)}>🎙 Unmute</button>
      : <button className="ghost" onClick={() => voice.setMuted(true)}>Mute</button>}
  </div>;
}


export function SelfPanel({ store, voice, assets }: { store: Store; voice: Voice | null; assets: Assets | null }) {
  const me = store.users.get(store.me), room = store.roomCallOf(me);
  const roomVoice = !!me && !!room && !!voice?.inRoomCall && store.voiceOwner && !me.instance && store.roomOf(me)?.id === room.id;
  const waitRoom = store.voiceWait ? MAP.rooms.find(r => r.id === store.voiceWait) : undefined; // a meeting room's line shows on its own chip
  return <div className="sb-self sb-up">
    <div className="sb-voice" title={earshotLine(store)}>
      {store.connected && !store.voiceOwner ? <div>Voice is on in another tab <button onClick={() => store.claimVoice()}>Use voice here</button></div>
        : me?.callId && !me.instance && !room && store.voiceOwner ? <CallChip store={store} voice={voice} />
        : roomVoice ? <RoomVoiceChip store={store} voice={voice} />
        : waitRoom && !me?.instance ? <div>Waiting for a spot in {waitRoom.name} voice</div> : null}
    </div>
    <div className="sb-identity"><IdentityPill store={store} assets={assets} /><VoiceIcons store={store} voice={voice} /></div>
  </div>;
}
