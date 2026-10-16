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
import { Icon, IconButton } from '../Icon';
import { VoiceToggle } from '../VoiceToggle';


export function EnableSound() {
  return needsGesture() ? <button onClick={() => void resume()}><Icon name="volume" /> Enable sound</button> : null;
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
export function IdentityPill({ store, roomName, assets, inVoice }: { store: Store; roomName?: string; assets?: Assets | null; inVoice?: boolean }) {
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
        {assets !== undefined ? <Avatar assets={assets} user={me} size={40} /> : <i className="dot" style={{ background: PRESENCE_COLOR[me.presence] }} />}
      </button>
      <button className="id-main" aria-haspopup="dialog" aria-expanded={open === 'status'} aria-label={`Status: ${text || 'none'} · click to change`}
        onClick={() => (open === 'status' ? close(true) : setOpen('status'))}>
        <b title={me.name}>{me.name}</b>
        <span className="id-room" title={earshotLine(store)}>· {roomName ? `in ${roomName}` : 'in the hallway'}</span>
        {inVoice ? <span className="id-status in-voice" title={text ? `In voice · ${text}` : 'In voice'}><Icon name="volume" />In voice</span>
          : <span className={`id-status${text ? '' : ' muted'}`} title={text ? `${text} · click to change` : 'Set a status (waters your plant)'}>{assets === undefined ? '· ' : ''}{(assets === undefined ? shown : text) || 'Set a status'}</span>}
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

export function VoiceIcons({ store, voice, dock, rail, hand = true }: { store: Store; voice: Voice | null; dock?: boolean; rail?: boolean; hand?: boolean }) {
  const [pop, setPop] = useState<'input' | 'output' | 'settings' | 'claim' | null>(null);
  const ref = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
  const me = store.users.get(store.me), room = store.roomCallOf(me), owner = store.connected && store.voiceOwner;
  const elsewhere = store.connected && !store.voiceOwner;
  const id = dock ? 'dock-voice-options' : rail ? 'rail-voice-options' : 'sidebar-voice-options';
  const open = (next: NonNullable<typeof pop>, button: HTMLButtonElement) => { trigger.current = button; setPop(p => p === next ? null : next); };
  useEffect(() => {
    if (!pop) return;
    popup.current?.querySelector<HTMLElement>('select, input, button')?.focus();
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target)) { setPop(null); trigger.current?.focus(); } };
    const key = (e: KeyboardEvent) => { if (!overlayOpen(store) && e.key === 'Escape') { e.stopImmediatePropagation(); setPop(null); trigger.current?.focus(); } };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [pop]);
  useEffect(() => { if (!elsewhere && pop === 'claim') { setPop(null); trigger.current?.focus(); } }, [elsewhere]);
  const err = voice?.micError ?? null;
  const micOff = (voice?.muted ?? true) || (voice?.deafened ?? prefs.deafened) || !!err;
  const waiting = store.voiceWait ? `Waiting for a spot in ${MAP.rooms.find(r => r.id === store.voiceWait)?.name ?? 'room'} voice` : null;
  const away = 'Voice is on in another tab';
  const options = (kind: 'input' | 'output') => <IconButton icon={pop === kind ? 'chevron-up' : 'chevron-down'}
    label={kind === 'input' ? 'Input options' : 'Output options'} className="voice-options"
    aria-haspopup="dialog" aria-expanded={pop === kind} aria-controls={pop === kind ? id : undefined}
    disabled={elsewhere} onClick={e => open(kind, e.currentTarget)} />;
  return <div className={`voice-icons${dock ? ' in-dock' : ''}${rail ? ' in-rail' : ''}`} ref={ref} role="group" aria-label="Your voice controls">
    <div className="voice-split">
      {elsewhere ? <IconButton icon="mic" off={micOff} label="Voice is in another tab" title={`${away} · click to use voice here`}
        className="vbtn chip" data-state="elsewhere" aria-haspopup="dialog" aria-expanded={pop === 'claim'}
        onClick={e => open('claim', e.currentTarget)}><b className="vbadge" aria-hidden="true" />{dock && <small>Voice</small>}</IconButton>
        : !me?.callId ? <IconButton icon="mic" label="Microphone not in use" title="Knock on someone or enter an open voice room to talk"
          className="vbtn chip" data-state="idle" disabled>{dock && <small>Mic</small>}</IconButton>
        : <VoiceToggle kind="mic" voice={voice} disabled={!owner} caption={dock} />}
      {!rail && options('input')}
    </div>
    <div className="voice-split"><VoiceToggle kind="headphones" voice={voice} disabled={!owner} savedDeafened={prefs.deafened} caption={dock} />{!rail && options('output')}</div>
    {hand && (dock || room) && <IconButton icon="hand" label={me?.hand ? 'Lower hand' : 'Raise hand'} title={elsewhere ? away : !room ? 'Raise your hand in a room call' : me?.hand ? 'Lower hand' : 'Raise hand'}
      className="vbtn chip" data-state={me?.hand && room ? 'active' : 'ready'} disabled={!owner || !room} aria-pressed={!!me?.hand && !!room}
      onClick={() => store.setHand(!me?.hand)}>{dock && <small>Hand</small>}</IconButton>}
    <IconButton icon="settings" label="Voice settings" className="vbtn chip" data-state="ready" disabled={elsewhere}
      aria-haspopup="dialog" aria-expanded={pop === 'settings'} aria-controls={pop === 'settings' ? id : undefined}
      onClick={e => open('settings', e.currentTarget)}>{dock && <small>Settings</small>}</IconButton>
    {pop && <div ref={popup} id={id} className="settings-pop voice-pop" role="dialog" aria-label={pop === 'input' ? 'Input options' : pop === 'output' ? 'Output options' : pop === 'claim' ? away : 'Voice settings'}>
      <div className="rooms-head"><strong>{pop === 'input' ? 'Microphone' : pop === 'output' ? 'Audio output' : pop === 'claim' ? 'Voice in another tab' : 'Voice settings'}</strong>
        <IconButton icon="close" label="Close voice options" className="ghost" onClick={() => { setPop(null); trigger.current?.focus(); }} /></div>
      {pop === 'claim' ? <><small>{away}.</small><button onClick={() => { setPop(null); trigger.current?.focus(); store.claimVoice(); }}>Use voice here</button></> : <>
        {err && pop !== 'output' && <small className="warn">{err}</small>}
        {waiting && <small>{waiting}</small>}
        <EnableSound />
        {(pop === 'input' || pop === 'settings') && <label className="input-mode">Input mode<select value={voice?.mode ?? prefs.mode} disabled={!owner || !voice}
          onChange={e => { if (voice && e.target.value !== voice.mode) voice.toggleMode(); }}>
          <option value="voice">Voice activity</option><option value="ptt">Push-to-talk (hold Space)</option>
        </select></label>}
        {(pop === 'output' || pop === 'settings') && <div className="voice-mix">
          {(['voice', 'music', 'effects'] as Category[]).map(category => <label className="volume-control" key={category}>
            <span><Icon name={category === 'voice' ? 'headphones' : category === 'music' ? 'music' : 'volume'} />{{ voice: 'Voices', music: 'Music', effects: 'Effects' }[category]}</span>
            <input type="range" min="0" max="100" step="5" value={Math.round(prefs.mix[category] * 100)} aria-label={`${category} volume`}
              onChange={e => { prefs.mix[category] = Number(e.target.value) / 100; savePrefs(); }} /><output>{Math.round(prefs.mix[category] * 100)}%</output>
          </label>)}
        </div>}
        {pop !== 'settings' && <button className="ghost voice-settings-link" onClick={() => setPop('settings')}><Icon name="settings" />Voice settings</button>}
      </>}
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
    <VoiceToggle kind="mic" voice={voice} disabled={!store.connected || !store.voiceOwner} /><VoiceToggle kind="headphones" voice={voice} disabled={!store.connected || !store.voiceOwner} savedDeafened={prefs.deafened} /><IconButton icon="disconnect" label="Leave call" className="end" onClick={() => store.endCall()} />
    {meet && <ExternalLink href={meetAs(meet, store.meetAccount)} onOpen={() => store.moveToMeet()}>Move to Meet</ExternalLink>}
  </div>;
}

/** In an open-voice room: say whether the room can hear you, with the shared voice controls. */
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
    <VoiceToggle kind="mic" voice={voice} disabled={!store.connected} />
    <VoiceToggle kind="headphones" voice={voice} disabled={!store.connected} savedDeafened={prefs.deafened} />
    <IconButton icon="disconnect" label={`Leave ${room.name}`} title={`Leave ${room.name}: stop talking and step out`} className="end" onClick={() => store.leaveRoom()} />
  </div>;
}


export function SelfPanel({ store, voice, assets }: { store: Store; voice: Voice | null; assets: Assets | null }) {
  const me = store.users.get(store.me), room = store.roomCallOf(me);
  const roomVoice = !!me && !!room && !!voice?.inRoomCall && store.voiceOwner && !me.instance && store.roomOf(me)?.id === room.id;
  const waitRoom = store.voiceWait ? MAP.rooms.find(r => r.id === store.voiceWait) : undefined;
  const meet = store.callLink && MEET_LINK_RE.test(store.callLink) ? store.callLink : null;
  const state = voiceState(voice);
  const roomState = voice?.deafened ? 'Deafened' : voice?.micError ? 'Listen-only' : voice?.muted ? 'Muted' : 'Voice connected';
  const others = me && room ? store.callPeers(me).filter(u => !u.bot && u.presence !== 'offline' && !u.instance && store.roomOf(u)?.id === room.id) : [];
  const who = others.length ? others.map(u => u.name.split(' ')[0]).join(', ') : 'nobody yet';
  const line = me?.callId && !room ? `with ${store.names(store.callPeers(me))} · ${state}` : room ? `${room.name} · here: ${who}` : '';
  const elsewhere = store.connected && !store.voiceOwner, knockCall = !!me?.callId && !room && store.voiceOwner;
  const connecting = state === 'connecting…';
  // Discord's "Voice Connected" panel: a status tile, where you are, Disconnect; the room's extras on a row below
  const connected = (where: string, title: string, leave: () => void, leaveLabel: string, extras: React.ReactNode) => <>
    <div className="sb-voice-top">
      <span className={`sb-voice-tile${connecting ? ' connecting' : ''}`}><Icon name="signal" /></span>
      <div className="sb-voice-text" title={title}><strong className={connecting ? 'connecting' : ''}>{connecting ? 'Connecting…' : 'Voice Connected'}</strong><small>{where}</small></div>
      <IconButton icon="disconnect" label={leaveLabel} title={leaveLabel} className="sb-disconnect" onClick={leave} />
    </div>
    {extras && <div className="sb-voice-actions">{extras}</div>}
  </>;
  let section: React.ReactNode = null; // MeetingChip owns a meeting room's voice, so nothing here inside one
  if (me?.instance) section = null;
  else if (elsewhere) section = <div className="sb-voice-top">
    <span className="sb-voice-text" title="Voice is on in another tab">Voice is on in another tab</span><button onClick={() => store.claimVoice()}>Use voice here</button>
  </div>;
  else if (knockCall) section = connected(`Call with ${store.names(store.callPeers(me!))}`, line, () => store.endCall(), 'Disconnect',
    meet && <ExternalLink className="sb-voice-action" href={meetAs(meet, store.meetAccount)} onOpen={() => store.moveToMeet()}><Icon name="monitor" />Move to Meet</ExternalLink>);
  else if (roomVoice) section = connected(`${room!.name} · here: ${who}`, earshotLine(store), () => store.leaveRoom(), `Disconnect: leave ${room!.name}`,
    <button className={`sb-voice-action${me?.hand ? ' on' : ''}`} aria-pressed={!!me?.hand} onClick={() => store.setHand(!me?.hand)}><Icon name="hand" />{me?.hand ? 'Lower hand' : 'Raise hand'}</button>);
  else if (waitRoom) section = <div className="sb-voice-top"><span className="sb-voice-text" title={`Waiting for a spot in ${waitRoom.name} voice`}>Waiting for a spot in {waitRoom.name} voice</span></div>;
  return <div className="sb-self sb-up">
    {section && <div className="sb-voice" role="status">{section}</div>}
    <div className="sb-identity"><IdentityPill store={store} assets={assets} inVoice={knockCall || roomVoice} /><VoiceIcons store={store} voice={voice} hand={false} /></div>
  </div>;
}
