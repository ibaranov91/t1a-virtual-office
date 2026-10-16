import { useEffect, useRef, useState } from 'react';
import { IconButton } from './Icon';
import type { Store } from './net';
import { inNativeApp, openNotificationSettings, requestWellnessPermission, syncWellnessNative } from './native';
import { advanceWellness, EXERCISES, nextPhase, pendingWellness, PHASE_NAMES, reduceWellness, remainingTime, restoreWellness, wellnessRequests,
  type ReminderKind, type WellnessAction, type WellnessKind, type WellnessState } from './wellness';

const LABELS: Record<WellnessKind, string> = { water: 'Water', stretch: 'Stretch', pomodoro: 'Pomodoro' };
const clock = (ms: number) => { const s = Math.ceil(Math.max(0, ms) / 1000); return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`; };

export function Wellness({ store, userId }: { store: Store; userId: string }) {
  const key = `deck.wellness.${userId}`;
  const [saved, setSaved] = useState(true);
  const [state, setState] = useState<WellnessState>(() => {
    try { return restoreWellness(JSON.parse(localStorage.getItem(key) ?? 'null'), Date.now()); }
    catch { return restoreWellness(null, Date.now()); }
  });
  const [now, setNow] = useState(Date.now);
  const [permission, setPermission] = useState('checking');
  const panelRef = useRef<HTMLElement>(null);
  const open = store.wellnessOpen;
  const p = state.pomodoro, left = remainingTime(p, now);
  const pending = pendingWellness(state, now), first = pending[0];
  const dispatch = (action: WellnessAction) => {
    if (inNativeApp() && ((action.type === 'enable' && action.enabled) || action.type === 'start' || action.type === 'next')) requestWellnessPermission();
    setState(s => reduceWellness(s, action, Date.now())); setNow(Date.now());
  };
  useEffect(() => {
    const tick = () => { const t = Date.now(); setNow(t); setState(s => advanceWellness(s, t)); };
    const interval = window.setInterval(tick, 1000);
    const storage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage || (e.key !== key && e.key !== null)) return;
      try { setState(restoreWellness(JSON.parse(localStorage.getItem(key) ?? 'null'), Date.now())); } catch { /* keep current settings */ }
    };
    const nativeStatus = (e: Event) => setPermission(String((e as CustomEvent).detail));
    window.addEventListener('storage', storage); window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick); window.addEventListener('deck:wellness-permission', nativeStatus);
    const olderApp = window.setTimeout(() => setPermission(s => s === 'checking' ? 'unavailable' : s), 4000);
    return () => {
      clearInterval(interval); clearTimeout(olderApp);
      window.removeEventListener('storage', storage); window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick); window.removeEventListener('deck:wellness-permission', nativeStatus);
      syncWellnessNative('', []); // leaving the office cancels this person's system reminders
    };
  }, [key]);
  useEffect(() => {
    try { const value = JSON.stringify(state); if (localStorage.getItem(key) !== value) localStorage.setItem(key, value); setSaved(true); }
    catch { setSaved(false); }
    syncWellnessNative(`${location.origin}/${userId}`, wellnessRequests(state));
  }, [key, userId, state]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); store.openWellness(null); } };
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('keydown', escape, true); previous?.focus(); };
  }, [!!open, store]);

  const alert = (kind: WellnessKind, floating = false) => {
    const exercise = EXERCISES[state.exercise % EXERCISES.length];
    return <section className={`wellness-alert${floating ? ' floating' : ''}`} role="status" aria-live="polite" aria-label={`${LABELS[kind]} reminder`}>
      <h3>{kind === 'water' ? 'Time for water' : kind === 'stretch' ? 'Time to stretch' : p.phase === 'focus' ? 'Focus session complete' : 'Break is over'}</h3>
      <p>{kind === 'water' ? 'Take a moment to drink some water.' : kind === 'stretch' ? exercise.text : p.phase === 'focus' ? 'Nice work. Take a break when you are ready.' : 'Ready for another focus session?'}</p>
      {kind === 'stretch' && <small>Move comfortably; skip anything that does not feel right.</small>}
      <div className="wellness-actions">
        {kind === 'pomodoro' ? <><button onClick={() => dispatch({ type: 'next' })}>Start {PHASE_NAMES[nextPhase(p)].toLowerCase()}</button><button className="ghost" onClick={() => dispatch({ type: 'reset' })}>Dismiss</button></>
          : <><button onClick={() => dispatch({ type: 'done', kind })}>Done</button><button className="ghost" onClick={() => dispatch({ type: 'snooze', kind })}>In 5 minutes</button></>}
        {floating && <button className="ghost" onClick={() => store.openWellness(kind)}>Settings</button>}
      </div>
      {floating && pending.length > 1 && <small>{pending.length - 1} more reminder{pending.length > 2 ? 's' : ''} waiting</small>}
    </section>;
  };
  const reminder = (kind: ReminderKind) => <div className="wellness-reminder">
    <p>{kind === 'water' ? 'Your own quiet nudge to take a water break.' : 'A little movement between stretches of desk work.'}</p>
    <label className="wellness-toggle"><input type="checkbox" checked={state[kind].enabled} onChange={e => dispatch({ type: 'enable', kind, enabled: e.target.checked })} /> Remind me to {kind === 'water' ? 'drink water' : 'stretch'}</label>
    <label className="wellness-interval">Every <input aria-label={`${LABELS[kind]} reminder interval in minutes`} type="number" min="1" max="180" value={state[kind].intervalMin}
      onChange={e => dispatch({ type: 'interval', kind, minutes: e.target.valueAsNumber })} /> minutes</label>
    <p className="wellness-note">{!state[kind].enabled ? 'Off until you turn it on.' : state[kind].nextAt! <= now ? 'Your reminder is ready below.' : `Next reminder in ${Math.ceil((state[kind].nextAt! - now) / 60_000)} min.`}</p>
    {kind === 'stretch' && <p className="wellness-note">Rotates through reaching up, squats and heel raises.</p>}
  </div>;

  return <div className="wellness-layer" onKeyDown={e => { if (open) e.stopPropagation(); }}>
    {p.status !== 'idle' && !open && <button className="chip wellness-timer-chip" onClick={() => store.openWellness('pomodoro')} aria-label={`Pomodoro: ${PHASE_NAMES[p.phase]}, ${p.status === 'finished' ? 'complete' : clock(left)}`}>
      <span>{PHASE_NAMES[p.phase]}</span><b>{p.status === 'finished' ? 'Done' : clock(left)}</b>{p.status === 'paused' && <span>Paused</span>}
    </button>}
    {open && <section className="wellness-panel" role="dialog" aria-labelledby="wellness-title" tabIndex={-1} ref={panelRef}>
      <header><h2 id="wellness-title">A little breather</h2><IconButton className="ghost" label="Close reminders" icon="close" onClick={() => store.openWellness(null)} /></header>
      <nav aria-label="Reminder settings">{(['water', 'stretch', 'pomodoro'] as const).map(kind => <button key={kind} className={open === kind ? 'on' : 'ghost'} aria-pressed={open === kind} onClick={() => store.openWellness(kind)}>{LABELS[kind]}</button>)}</nav>
      {open !== 'pomodoro' ? reminder(open) : <div className="wellness-pomodoro">
        <div className="wellness-phases" aria-label="Timer phase">{(['focus', 'short', 'long'] as const).map(phase => <button key={phase} className={p.phase === phase ? 'on' : 'ghost'} aria-pressed={p.phase === phase}
          disabled={p.status === 'running' || p.status === 'paused'} onClick={() => dispatch({ type: 'phase', phase })}>{PHASE_NAMES[phase]}</button>)}</div>
        <output className="wellness-countdown" aria-label={`${PHASE_NAMES[p.phase]} time remaining`}>{clock(left)}</output>
        <p className="wellness-note">{p.status === 'paused' ? 'Paused. Pick up where you left off.' : p.status === 'running' ? `${PHASE_NAMES[p.phase]} in progress` : p.status === 'finished' ? 'All done. The next session starts when you choose.' : 'Make room for one thing at a time.'}</p>
        <div className="wellness-actions">{p.status !== 'finished' && <button onClick={() => dispatch({ type: p.status === 'running' ? 'pause' : 'start' })}>{p.status === 'running' ? 'Pause' : p.status === 'paused' ? 'Resume' : 'Start'}</button>}
          <button className="ghost" onClick={() => dispatch({ type: 'reset' })}>Reset</button></div>
        <div className="wellness-durations">{(['focus', 'short', 'long'] as const).map(phase => <label key={phase}>{PHASE_NAMES[phase]}<input aria-label={`${PHASE_NAMES[phase]} minutes`} type="number" min="1" max="180" disabled={p.status !== 'idle'} value={p.durations[phase]}
          onChange={e => dispatch({ type: 'duration', phase, minutes: e.target.valueAsNumber })} /><span>min</span></label>)}</div>
        <p className="wellness-note">{p.rounds} focus session{p.rounds === 1 ? '' : 's'} completed · a long break after every 4.</p>
      </div>}
      {pending.includes(open) && alert(open)}
      <footer><p>Just for you, on this device. Settings stay when you reload.</p>
        {!inNativeApp() ? <p>Browser reminders work while this page is open. The Mac app can notify you in the background.</p>
          : permission === 'granted' ? <p>Mac notifications are on, including when the window is hidden.</p>
          : permission === 'denied' ? <><p>Mac notifications are blocked. In-app reminders still work.</p><button className="ghost" onClick={openNotificationSettings}>Open notification settings</button></>
          : permission === 'unavailable' ? <p>Update the Mac app to enable background notifications.</p>
          : permission === 'error' ? <><p>Mac could not schedule a notification. In-app reminders still work.</p><button className="ghost" onClick={requestWellnessPermission}>Retry notifications</button></>
          : <><p>Allow Mac notifications to get reminders while the window is hidden.</p><button className="ghost" onClick={requestWellnessPermission}>Enable Mac notifications</button></>}
        {!saved && <p className="err">Settings could not be saved. They will last until this page closes.</p>}
      </footer>
    </section>}
    {first && !pending.includes(open!) && alert(first, true)}
  </div>;
}
