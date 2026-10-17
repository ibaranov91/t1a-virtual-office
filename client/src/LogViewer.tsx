// v2 logging UI (temporary entry points live in the GM panel): the bug report form and the admin log viewer.
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import type { Store } from './net';
import { reportBug } from './reports';
import { webBuild } from './buildInfo';

/** Send a bug report from the current session; `store` supplies the session, versions and a screenshot of the floor. */
export const sendBugReport = (store: Store, note: string, capture: () => Promise<string | null>, screenshot = true) =>
  reportBug({ session: store.sessionId, capture, versions: () => ({ me: store.me, connected: String(store.connected), screen: `${innerWidth}x${innerHeight}@${devicePixelRatio}` }) }, note, screenshot);

export function BugReportForm({ store, capture, onClose }: { store: Store; capture: () => Promise<string | null>; onClose: () => void }) {
  const [note, setNote] = useState(''), [shot, setShot] = useState(true), [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle'), [error, setError] = useState('');
  const submit = async () => {
    setState('sending'); setError('');
    const err = await sendBugReport(store, note.trim(), capture, shot);
    if (err) { setError(err); setState('idle'); } else setState('sent');
  };
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="meet-panel guided report-panel" role="dialog" aria-label="Report a bug">
      <div className="rooms-head"><span>Report a bug</span><button type="button" className="ghost" aria-label="Close" onClick={onClose}><Icon name="close" /></button></div>
      {state === 'sent' ? <p className="muted">Thanks, it's on its way to the admins.</p> : <>
        <textarea value={note} maxLength={1000} rows={4} placeholder="What went wrong?" aria-label="What went wrong" autoFocus onChange={e => setNote(e.target.value)} />
        <label className="hint"><input type="checkbox" checked={shot} onChange={e => setShot(e.target.checked)} /> Attach a screenshot of the floor</label>
        <p className="hint">Includes your last ~200 actions and the versions you run (page {webBuild.sha}).</p>
        {error && <p className="hint report-error" role="alert">{error}</p>}
        <button disabled={!note.trim() || state === 'sending'} onClick={() => void submit()}>{state === 'sending' ? 'Sending…' : 'Send report'}</button>
      </>}
    </div>
  </div>;
}

interface ErrorRow { srv: number; name: string; kind: string; msg: string; stack: string; src: string; line: number; build: string; count: number; ua?: string }
interface BugRow { id: string; at: number; name: string; note: string; versions: Record<string, string>; events: { at: number; k: string; s: string }[]; shot: 'png' | 'jpg' | null }
const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

/** The screenshot comes through fetch so the session stays in a header, never in a URL. */
function Shot({ store, id }: { store: Store; id: string }) {
  const [url, setUrl] = useState<string | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let made = '', live = true;
    fetch(`/api/admin/reports/${id}/shot`, { headers: { 'x-deck-session': store.sessionId } })
      .then(r => r.ok ? r.blob() : Promise.reject(new Error(String(r.status))))
      .then(b => { if (live) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => live && setFailed(true));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [store, id]);
  return failed ? <p className="hint">Screenshot unavailable.</p> : url ? <img src={url} alt="Screenshot of the floor" className="log-shot" /> : <p className="hint">Loading screenshot…</p>;
}

export function LogViewer({ store, onClose }: { store: Store; onClose: () => void }) {
  const [data, setData] = useState<{ errors: ErrorRow[]; bugs: BugRow[] } | null>(null), [error, setError] = useState(''), [tab, setTab] = useState<'bugs' | 'errors'>('bugs'), [open, setOpen] = useState<string | null>(null);
  const load = () => {
    setError('');
    fetch('/api/admin/reports', { headers: { 'x-deck-session': store.sessionId } })
      .then(async r => r.ok ? setData(await r.json()) : setError((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`))
      .catch(() => setError('Could not reach the server'));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="meet-panel guided report-panel log-viewer" role="dialog" aria-label="Logs and reports">
      <div className="rooms-head"><span>Logs and reports</span>
        <span><button type="button" className="ghost" onClick={load}>Refresh</button> <button type="button" className="ghost" aria-label="Close" onClick={onClose}><Icon name="close" /></button></span></div>
      <div className="log-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'bugs'} className={tab === 'bugs' ? '' : 'ghost'} onClick={() => setTab('bugs')}>Bug reports{data ? ` (${data.bugs.length})` : ''}</button>
        <button role="tab" aria-selected={tab === 'errors'} className={tab === 'errors' ? '' : 'ghost'} onClick={() => setTab('errors')}>Client errors{data ? ` (${data.errors.length})` : ''}</button>
      </div>
      {error && <p className="hint report-error" role="alert">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && tab === 'bugs' && (data.bugs.length === 0 ? <p className="muted">No bug reports in the last 14 days.</p> : <ul className="log-list">
        {data.bugs.map(b => <li key={b.id}>
          <button className="ghost log-row" aria-expanded={open === b.id} onClick={() => setOpen(open === b.id ? null : b.id)}>
            <b>{b.name}</b> <small className="muted">{ago(b.at)} · {b.versions.web ?? ''}</small><span>{b.note}</span></button>
          {open === b.id && <div className="log-detail">
            {b.shot && <Shot store={store} id={b.id} />}
            <p className="hint">{Object.entries(b.versions).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
            <pre className="log-events">{b.events.map(e => `${new Date(e.at).toLocaleTimeString()} ${e.k === 'out' ? '→' : '←'} ${e.s}`).join('\n') || 'no events'}</pre>
          </div>}
        </li>)}
      </ul>)}
      {data && tab === 'errors' && (data.errors.length === 0 ? <p className="muted">No client errors in the last 3 days.</p> : <ul className="log-list">
        {data.errors.map((e, i) => <li key={i}>
          <button className="ghost log-row" aria-expanded={open === `e${i}`} onClick={() => setOpen(open === `e${i}` ? null : `e${i}`)}>
            <b>{e.name}</b> <small className="muted">{ago(e.srv)} · {e.build}{e.count > 1 ? ` · ×${e.count}` : ''}</small><span>{e.msg}</span></button>
          {open === `e${i}` && <pre className="log-events">{e.stack || `${e.src}:${e.line}`}</pre>}
        </li>)}
      </ul>)}
    </div>
  </div>;
}
