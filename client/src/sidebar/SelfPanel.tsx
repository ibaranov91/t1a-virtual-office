import { useEffect, useRef, useState } from 'react';
import type { Assets } from '../assets';
import { MAP, type Store } from '../net';
import type { Voice } from '../voice';
import { needsGesture, resume } from '../audio';
import { prefs, savePrefs, type Category } from '../prefs';
import { MEET_LINK_RE, meetAs } from '../../../shared/protocol';
import { ExternalLink } from '../links';
import { PRESENCE_COLOR, splitStatus, joinStatus } from './model';
import { Avatar } from './Avatar';
import { overlayOpen } from './hooks';
import { Icon, IconButton } from '../Icon';
import { VoiceToggle } from '../VoiceToggle';
import { BuildLine } from './BuildLine';
import { REACH_TITLE, reachLabel } from '../voiceReach';
import { pomodoroClock, pomodoroLeft } from '../../../shared/pomodoro';


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


const STATUS_EMOJI = ['💬', '🗓️', '🚌', '🤒', '🌴', '🏠', '🍔', '🎧', '☕', '💻', '📚', '🎯', '🔥', '✅', '🚀', '🎉', '😴', '🤔', '👀', '💡', '🛠️', '🧪', '📞', '✈️', '🏃', '🍕', '🍜', '🥗', '🎮', '🎵', '🌧️', '☀️', '🐶', '🐱', '🌱', '💪', '🙏', '❤️', '😎', '🤝'];
const STATUS_PRESETS = [
  ['🗓️', 'In a meeting'], ['🚌', 'Commuting'], ['🤒', 'Out sick'], ['🌴', 'On vacation'],
  ['🏠', 'Working remotely'], ['🍔', 'Out for lunch'], ['🎧', 'Heads down'], ['☕', 'Coffee break'],
];
export const PRESENCES = [['online', 'Online'], ['away', 'Away'], ['in_call', 'In a call']] as const;

/** Both identity targets open the same profile surface. */
export function IdentityPill({ store, roomName, assets, inVoice, onProfile }: { store: Store; roomName?: string; assets?: Assets | null; inVoice?: boolean; onProfile: (opener: HTMLButtonElement) => void }) {
  const me = store.users.get(store.me);
  if (!me) return null;
  const text = me.status ?? '', status = splitStatus(text);
  const open = (e: React.MouseEvent<HTMLButtonElement>) => { if (!overlayOpen(store)) onProfile(e.currentTarget); };
  return <div className="id-wrap"><div className="chip id-pill">
    <button className="id-dot" aria-label="Your profile" title="Your profile" aria-haspopup="dialog" disabled={overlayOpen(store)} onClick={open}>
      {assets !== undefined ? <Avatar assets={assets} user={me} size={40} /> : <i className="dot" style={{ background: PRESENCE_COLOR[me.presence] }} />}
    </button>
    <button className="id-main" aria-label={`${me.name} · Your profile`} aria-haspopup="dialog" disabled={overlayOpen(store)} onClick={open}>
      <b title={me.name}>{me.name}{assets !== undefined && status.emoji && <span className="sb-status-emoji">{status.emoji}</span>}</b>
      <span className="id-room" title={earshotLine(store)}>· {roomName ? `in ${roomName}` : 'in the hallway'}</span>
      {inVoice ? <span className="id-status in-voice"><Icon name="volume" />In voice</span>
        : <span className={`id-status${text ? '' : ' muted'}`} title={text || 'Set a status'}>{assets === undefined ? '· ' : ''}{(assets === undefined ? text : status.text) || 'Set a status'}</span>}
    </button>
  </div></div>;
}

export function StatusEditor({ store, onClose }: { store: Store; onClose: (restore: boolean) => void }) {
  const me = store.users.get(store.me)!;
  const [draftEmoji, setDraftEmoji] = useState<string | null>(splitStatus(me.status ?? '').emoji), [draftText, setDraftText] = useState(splitStatus(me.status ?? '').text);
  const [picker, setPicker] = useState(false), [emojiIndex, setEmojiIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), grid = useRef<HTMLDivElement>(null);
  const draftRef = useRef<string | null>(null);
  draftRef.current = joinStatus(draftEmoji, draftText);
  const close = (save: boolean, restore = true) => {
    if (save && draftRef.current !== null) store.setStatus(draftRef.current);
    setPicker(false); onClose(restore);
  };
  const pick = (emoji: string | null) => {
    setDraftEmoji(emoji);
    setDraftText(text => text.slice(0, 80 - (emoji ? emoji.length + 1 : 0)));
    setPicker(false); input.current?.focus();
  };
  const escape = () => { if (picker) { setPicker(false); input.current?.focus(); } else close(false); };
  useEffect(() => {
    if (picker) grid.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
  }, [picker]);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!overlayOpen(store) && e.target instanceof Node && !ref.current?.contains(e.target)) close(true, false); };
    const key = (e: KeyboardEvent) => { if (!overlayOpen(store) && e.key === 'Escape') { e.stopImmediatePropagation(); escape(); } };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [picker]);
  const text = me.status ?? '';
  return <div ref={ref} className="status-pop" role="dialog" aria-label="Set a status"
      onKeyDown={e => { if (!overlayOpen(store) && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); escape(); } }}>
      <div className="rooms-head"><strong>Set a status</strong><IconButton icon="close" label="Close status editor" className="ghost" onClick={() => close(false)} /></div>
      <form onSubmit={e => { e.preventDefault(); close(true); }}>
        <div className="status-input-row">
          <IconButton icon="smile" label="Pick an emoji" className={`status-emoji-button${draftEmoji ? ' has-emoji' : ''}`}
            aria-expanded={picker} onClick={() => { setEmojiIndex(Math.max(0, STATUS_EMOJI.indexOf(draftEmoji ?? ''))); setPicker(p => !p); }}>
            {draftEmoji && <span>{draftEmoji}</span>}
          </IconButton>
          <input ref={input} autoFocus value={draftText} maxLength={80 - (draftEmoji ? draftEmoji.length + 1 : 0)}
            aria-label="Status text" placeholder="What's your status?" onChange={e => setDraftText(e.target.value)} />
        </div>
        {picker && <div className="status-picker">
          <div className="status-emoji-grid" ref={grid} role="group" aria-label="Status emoji">
            {STATUS_EMOJI.map((emoji, i) => <button type="button" className="ghost" key={emoji} aria-label={emoji} aria-pressed={draftEmoji === emoji}
              tabIndex={emojiIndex === i ? 0 : -1} onFocus={() => setEmojiIndex(i)} onClick={() => pick(emoji)}
              onKeyDown={e => {
                const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 }[e.key];
                if (offset === undefined) return;
                e.preventDefault(); e.stopPropagation();
                const next = (i + offset + STATUS_EMOJI.length) % STATUS_EMOJI.length;
                setEmojiIndex(next); grid.current?.querySelectorAll('button')[next]?.focus();
              }}>{emoji}</button>)}
          </div>
          <button type="button" className="ghost" onClick={() => pick(null)}>No emoji</button>
        </div>}
        {!draftText && <div className="status-suggestions"><small>Suggestions</small>
          {STATUS_PRESETS.map(([emoji, label]) => <button type="button" className="ghost" key={label}
            onClick={() => { setDraftEmoji(emoji); setDraftText(label); setPicker(false); input.current?.focus(); }}><span>{emoji}</span>{label}</button>)}
        </div>}
        <div className="status-row">
          <button type="button" className="ghost" disabled={!text && !draftEmoji && !draftText} onClick={() => { store.setStatus(''); close(false); }}>Clear</button>
          <button type="submit">Save</button>
        </div>
      </form>
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
    {hand && room && <IconButton icon="hand" label={me?.hand ? 'Lower hand' : 'Raise hand'} title={elsewhere ? away : !room ? 'Raise your hand in a room call' : me?.hand ? 'Lower hand' : 'Raise hand'}
      className="vbtn chip" data-state={me?.hand && room ? 'active' : 'ready'} disabled={!owner || !room} aria-pressed={!!me?.hand && !!room}
      onClick={() => store.setHand(!me?.hand)}>{dock && <small>Hand</small>}</IconButton>}
    <IconButton icon="settings" label="Voice settings" className="vbtn chip" data-state="ready" disabled={elsewhere}
      aria-haspopup="dialog" aria-expanded={pop === 'settings'} aria-controls={pop === 'settings' ? id : undefined}
      onClick={e => open('settings', e.currentTarget)}>{dock && <small>Sound</small>}</IconButton>
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
        {(pop === 'input' || pop === 'settings') && <label className="voice-processing"><input type="checkbox" checked={prefs.processing}
          onChange={e => { prefs.processing = e.target.checked; savePrefs(); }} /> Echo cancellation
          <small>Turn off with headphones if others sound choppy while you're unmuted (Safari, Mac app).</small></label>}
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
  if (voice.onMeet) return 'On Meet';
  if (voice.deafened) return 'deafened';
  if (voice.micError) return 'listen-only';
  if (voice.muted) return 'muted';
  if (voice.peerCount() > 0 && voice.connectedCount() === 0) return 'connecting…'; // one unreachable peer is named, not a whole call shown as connecting
  if (voice.mode === 'ptt') return 'hold Space to talk';
  return 'live';
}

/** "Can't reach Kim" once the call is live but a peer never connected; polled, since the grace period passes without an event. */
function useUnreachable(store: Store, voice: Voice | null) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 2000); return () => clearInterval(t); }, []);
  if (!voice || voice.onMeet || voice.connectedCount() === 0) return '';
  return reachLabel(voice.unreachable().map(id => store.name(id)));
}

/** Knock calls keep the shared Meet link. */
export function CallChip({ store, voice, compact = false }: { store: Store; voice: Voice | null; compact?: boolean }) {
  const me = store.users.get(store.me), unreachable = useUnreachable(store, voice);
  if (!me?.callId) return null;
  const state = voiceState(voice), peers = store.callPeers(me);
  const meet = store.callLink && MEET_LINK_RE.test(store.callLink) ? store.callLink : null;
  const text = `Talking with ${store.names(peers)} · ${state}`;
  return <div className={`${compact ? 'now-row' : 'desk-chip'} call-chip knock-panel`}>
    <span className={`dot ${state === 'live' ? 'live' : ''}`} />
    <span className={compact ? 'now-text' : undefined} title={unreachable ? `${text} · ${unreachable}` : text}>{text}{!compact && unreachable && <small className="cant-reach" title={REACH_TITLE}>{unreachable}</small>}</span>
    {!compact && <><VoiceToggle kind="mic" voice={voice} disabled={!store.connected || !store.voiceOwner} /><VoiceToggle kind="headphones" voice={voice} disabled={!store.connected || !store.voiceOwner} savedDeafened={prefs.deafened} /></>}
    {voice?.onMeet && <button onClick={() => voice.setOnMeet(false)}>Use Deck voice</button>}
    {meet && <ExternalLink href={meetAs(meet, store.meetAccount)} onOpen={() => { voice?.setOnMeet(); store.moveToMeet(); }}>Move to Meet</ExternalLink>}
    <IconButton icon="disconnect" label="Leave call" className="end" onClick={() => store.endCall()} />
  </div>;
}

/** The room voice surface is shown only by its owning tab, while physically in the room. */
export function roomVoiceOf(store: Store, voice: Voice | null) {
  const me = store.users.get(store.me), room = store.roomCallOf(me);
  return me && room && voice?.inRoomCall && store.voiceOwner && !me.instance && store.roomOf(me)?.id === room.id ? room : null;
}

/** Shared copy for the full voice chip and the compact dock row. */
export function roomVoiceStatus(store: Store, voice: Pick<Voice, 'onMeet' | 'deafened' | 'micError' | 'muted' | 'mode' | 'spaceHeld'>,
  room: NonNullable<ReturnType<Store['roomCallOf']>>, { short = false }: { short?: boolean } = {}) {
  const me = store.users.get(store.me);
  const others = me ? store.callPeers(me).filter(u => !u.bot && u.presence !== 'offline' && !u.instance && store.roomOf(u)?.id === room.id) : [];
  const who = others.length ? others.map(u => u.name.split(' ')[0]).join(', ') : 'nobody yet';
  const [state, label, suffix] = voice.onMeet ? ['off', 'On Meet', ''] : voice.deafened ? ['off', `Deafened in ${room.name}`, '']
    : voice.micError ? ['off', `Listen-only in ${room.name}`, '']
    : voice.muted ? ['off', `Muted in ${room.name}`, ' · nobody hears you']
    : voice.mode === 'ptt' ? voice.spaceHeld ? ['live', `Talking in ${room.name}`, ''] : ['ptt', `Push-to-talk in ${room.name}`, ' · hold Space']
    : ['live', `Live in ${room.name}`, ' · everyone here hears you'];
  const title = `${label}${suffix} · here: ${who}`;
  return { state, text: short ? `${label} · ${who}` : title, title, who };
}

/** In an open-voice room: say whether the room can hear you. */
export function RoomVoiceChip({ store, voice, compact = false }: { store: Store; voice: Voice | null; compact?: boolean }) {
  const room = roomVoiceOf(store, voice);
  if (!room || !voice) return null;
  const { state, text, title } = roomVoiceStatus(store, voice, room, { short: compact });
  return <div className={`${compact ? 'now-row' : 'desk-chip'} call-chip room-voice ${state}`} role="status">
    <span className={`dot ${state === 'live' ? 'live' : ''}`} />
    <span className={compact ? 'now-text' : undefined} title={title}>{text}</span>
    {voice.onMeet && <button onClick={() => voice.setOnMeet(false)}>Use Deck voice</button>}
    {!compact && <><VoiceToggle kind="mic" voice={voice} disabled={!store.connected} />
      <VoiceToggle kind="headphones" voice={voice} disabled={!store.connected} savedDeafened={prefs.deafened} /></>}
    <IconButton icon="disconnect" label={`Leave ${room.name}`} title={`Leave ${room.name}: stop talking and step out`} className="end" onClick={() => store.leaveRoom()} />
  </div>;
}


/** Your personal pomodoro (25 min focus, 5 min break): start it here; while it runs everyone sees a 🍅 over you. */
export function PomodoroRow({ store }: { store: Store }) {
  const me = store.users.get(store.me), p = me?.pomodoro, [, tick] = useState(0);
  useEffect(() => { if (!p) return; const i = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(i); }, [p?.until]);
  if (!me || me.instance) return null;
  if (!p) return <div className="sb-pomo"><button className="sb-voice-action" title="25 minutes of focus, then a 5 minute break. Everyone sees a tomato over you while it runs." onClick={() => store.startPomodoro()}>🍅 Start a pomodoro</button></div>;
  return <div className="sb-pomo running" role="timer" aria-label={`Pomodoro ${p.phase === 'focus' ? 'focus' : 'break'}`}>
    <span className="sb-pomo-icon" aria-hidden>{p.phase === 'focus' ? '🍅' : '☕'}</span>
    <div className="sb-voice-text"><strong>{pomodoroClock(pomodoroLeft(p, store.now()))}</strong><small>{p.phase === 'focus' ? `Focus · ${p.rest} min break next` : 'Break'}</small></div>
    <button className="sb-voice-action" onClick={() => store.stopPomodoro()}>Stop</button>
  </div>;
}

export function SelfPanel({ store, voice, assets, onProfile }: { store: Store; voice: Voice | null; assets: Assets | null; onProfile: (opener: HTMLButtonElement) => void }) {
  const me = store.users.get(store.me), room = store.roomCallOf(me), unreachable = useUnreachable(store, voice);
  const roomVoice = !!roomVoiceOf(store, voice);
  const waitRoom = store.voiceWait ? MAP.rooms.find(r => r.id === store.voiceWait) : undefined;
  const meet = store.callLink && MEET_LINK_RE.test(store.callLink) ? store.callLink : null;
  const state = voiceState(voice);
  const others = me && room ? store.callPeers(me).filter(u => !u.bot && u.presence !== 'offline' && !u.instance && store.roomOf(u)?.id === room.id) : [];
  const who = others.length ? others.map(u => u.name.split(' ')[0]).join(', ') : 'nobody yet';
  const line = me?.callId && !room ? `with ${store.names(store.callPeers(me))} · ${state}` : room ? `${room.name} · here: ${who}` : '';
  const elsewhere = store.connected && !store.voiceOwner, knockCall = !!me?.callId && !room && store.voiceOwner;
  const connecting = state === 'connecting…';
  // Discord's "Voice Connected" panel: a status tile, where you are, Disconnect; the room's extras on a row below
  const connected = (where: string, title: string, leave: () => void, leaveLabel: string, extras: React.ReactNode) => <>
    <div className="sb-voice-top">
      <span className={`sb-voice-tile${connecting ? ' connecting' : ''}`}><Icon name="signal" /></span>
      <div className="sb-voice-text" title={title}><strong className={connecting ? 'connecting' : ''}>{voice?.onMeet ? 'On Meet' : connecting ? 'Connecting…' : 'Voice Connected'}</strong><small>{where}</small>{unreachable && <small className="cant-reach" title={REACH_TITLE}>{unreachable}</small>}</div>
      <IconButton icon="disconnect" label={leaveLabel} title={leaveLabel} className="sb-disconnect" onClick={leave} />
    </div>
    {(extras || voice?.onMeet) && <div className="sb-voice-actions">{voice?.onMeet && <button onClick={() => voice.setOnMeet(false)}>Use Deck voice</button>}{extras}</div>}
  </>;
  let section: React.ReactNode = null; // MeetingChip owns a meeting room's voice, so nothing here inside one
  if (me?.instance) section = null;
  else if (elsewhere) section = <div className="sb-voice-top">
    <span className="sb-voice-text" title="Voice is on in another tab">Voice is on in another tab</span><button onClick={() => store.claimVoice()}>Use voice here</button>
  </div>;
  else if (knockCall) section = connected(`Call with ${store.names(store.callPeers(me!))}`, line, () => store.endCall(), 'Disconnect',
    meet && <ExternalLink className="sb-voice-action" href={meetAs(meet, store.meetAccount)} onOpen={() => { voice?.setOnMeet(); store.moveToMeet(); }}><Icon name="monitor" />Move to Meet</ExternalLink>);
  else if (roomVoice) section = connected(`${room!.name} · here: ${who}`, earshotLine(store), () => store.leaveRoom(), `Disconnect: leave ${room!.name}`,
    <button className={`sb-voice-action${me?.hand ? ' on' : ''}`} aria-pressed={!!me?.hand} onClick={() => store.setHand(!me?.hand)}><Icon name="hand" />{me?.hand ? 'Lower hand' : 'Raise hand'}</button>);
  else if (waitRoom) section = <div className="sb-voice-top"><span className="sb-voice-text" title={`Waiting for a spot in ${waitRoom.name} voice`}>Waiting for a spot in {waitRoom.name} voice</span></div>;
  return <div className="sb-self sb-up">
    {section && <div className="sb-voice" role="status">{section}</div>}
    <PomodoroRow store={store} />
    <div className="sb-identity"><IdentityPill onProfile={onProfile} store={store} assets={assets} inVoice={knockCall || roomVoice} /><VoiceIcons store={store} voice={voice} hand={false} /></div>
    <BuildLine store={store} />
  </div>;
}
