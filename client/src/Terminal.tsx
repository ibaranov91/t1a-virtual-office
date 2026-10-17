import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Store } from './net';
import { TICKET_TEXT_MAX, TICKET_TITLE_MAX, ticketNo, type Ticket } from '../../shared/protocol';

/** The Lobby's suggestions board (it was the bug terminal): a green phosphor screen. Everyone posts and reads their own suggestions and bug tickets; admins get the queue; "Report a bug" sends the session report. */
type View = { at: 'menu' } | { at: 'new' } | { at: 'list'; queue: boolean } | { at: 'ticket'; id: number; back: 'mine' | 'queue' };

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const ago = (at: number) => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

export function TerminalPanel({ store }: { store: Store }) {
  const [view, setView] = useState<View>({ at: 'menu' });
  const [sel, setSel] = useState(0);
  const close = () => store.openTerminal(null);
  const me = store.users.get(store.me), admin = store.admin;
  const mine = store.tickets.filter(t => t.by === store.me).sort((a, b) => b.updated - a.updated);
  const queue = store.tickets.filter(t => t.status === 'open').sort((a, b) => a.at - b.at);
  const unreadMine = mine.filter(t => store.ticketUnread(t)).length;
  const menu: { label: string; note?: string; go: () => void }[] = [
    { label: 'New suggestion', go: () => setView({ at: 'new' }) },
    { label: 'Report a bug', go: () => { close(); store.openBugReport(true); } },
    { label: `My suggestions (${mine.length})`, note: unreadMine ? `* ${unreadMine} new repl${unreadMine === 1 ? 'y' : 'ies'}` : undefined, go: () => setView({ at: 'list', queue: false }) },
    ...admin ? [{ label: `Open queue (${queue.length})`, note: queue.some(t => store.ticketUnread(t)) ? '* waiting' : undefined, go: () => setView({ at: 'list', queue: true }) }] : [],
  ];
  const rows = view.at === 'list' ? (view.queue ? queue : mine) : view.at === 'menu' ? mine.slice(0, 3) : [];
  const open = (t: Ticket, back: 'mine' | 'queue') => setView({ at: 'ticket', id: t.id, back });
  const back = () => {
    if (view.at === 'ticket') setView({ at: 'list', queue: view.back === 'queue' });
    else if (view.at === 'menu') close();
    else setView({ at: 'menu' });
  };
  useEffect(() => setSel(0), [view.at]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); back(); return; }
      if (typing(e)) return;
      if (view.at === 'menu') {
        const n = Number(e.key);
        if (n >= 1 && n <= menu.length) { e.preventDefault(); menu[n - 1].go(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSel(s => (s + (e.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length); }
        else if (e.key === 'Enter') { e.preventDefault(); menu[sel]?.go(); }
      } else if (view.at === 'list' && rows.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSel(s => (s + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length); }
        else if (e.key === 'Enter') { e.preventDefault(); open(rows[sel], view.queue ? 'queue' : 'mine'); }
      }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });

  const where = view.at === 'menu' ? 'Main menu' : view.at === 'new' ? 'New suggestion' : view.at === 'list' ? (view.queue ? 'Open queue' : 'My suggestions') : ticketNo(view.id);
  let body: ReactNode, hint = '';
  if (view.at === 'menu') {
    body = <>
      {menu.map((m, i) => <button key={m.label} type="button" className={`crt-item${sel === i ? ' sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={m.go}>
        <span>[{i + 1}] {m.label}</span>{m.note && <span className="crt-note">{m.note}</span>}
      </button>)}
      <button type="button" className="crt-item" onClick={close}><span>[Esc] Log off</span></button>
      {rows.length > 0 && <><div className="crt-rule" /><TicketRows store={store} rows={rows} onOpen={t => open(t, 'mine')} /></>}
    </>;
    hint = `1-${menu.length} or ↑↓ Enter`;
  } else if (view.at === 'new') {
    body = <NewTicket store={store} onFiled={t => open(t, 'mine')} />;
    hint = '⌘/Ctrl+Enter sends · Esc back';
  } else if (view.at === 'list') {
    body = rows.length ? <TicketRows store={store} rows={rows} sel={sel} onSel={setSel} onOpen={t => open(t, view.queue ? 'queue' : 'mine')} showBy={view.queue} />
      : <p className="crt-dim">{view.queue ? 'Queue empty. All quiet.' : 'Nothing yet. Choose [1] on the main menu to post one.'}</p>;
    hint = '↑↓ Enter · Esc back';
  } else {
    const t = store.tickets.find(t => t.id === view.id);
    body = t ? <TicketView store={store} t={t} /> : <p className="crt-dim">Ticket not found.</p>;
    hint = 'Esc back';
  }
  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="crt" role="dialog" aria-modal="true" aria-label="Suggestions board">
        <div className="crt-screen">
          <div className="crt-head"><span>T1A Deck Suggestions v1.0 · {where}</span><span>{(me?.name ?? '').split(' ')[0]} · {clock(Date.now())}</span></div>
          <div className="crt-rule" />
          <div className="crt-body" key={JSON.stringify(view)}>{body}</div>
          <div className="crt-rule" />
          <div className="crt-foot"><span>&gt; <span className="crt-cursor">█</span></span><span className="crt-dim">{hint}</span></div>
        </div>
        <button type="button" className="crt-power" aria-label="Log off" title="Log off" onClick={close} />
      </div>
    </div>
  );
}

function TicketRows({ store, rows, sel, onSel, onOpen, showBy }: { store: Store; rows: Ticket[]; sel?: number; onSel?: (i: number) => void; onOpen: (t: Ticket) => void; showBy?: boolean }) {
  return <div className="crt-rows">
    {rows.map((t, i) => <button key={t.id} type="button" className={`crt-row${sel === i ? ' sel' : ''}`} onMouseEnter={() => onSel?.(i)} onClick={() => onOpen(t)}>
      <span>{ticketNo(t.id)}</span><span className={`crt-st ${t.status}`}>{t.status}</span>
      <span className="crt-title">{showBy ? `${store.name(t.by).split(' ')[0]}: ` : ''}{t.title}</span>
      <span className="crt-dim">{ago(t.updated)}</span><span>{store.ticketUnread(t) ? '*' : ' '}</span>
    </button>)}
  </div>;
}

function NewTicket({ store, onFiled }: { store: Store; onFiled: (t: Ticket) => void }) {
  const [title, setTitle] = useState(''), [text, setText] = useState(''), [err, setErr] = useState('');
  const sent = useRef<{ count: number; at: number } | null>(null);
  const mineIds = store.tickets.filter(t => t.by === store.me).map(t => t.id);
  useEffect(() => { // the server answers with a fresh list holding the new ticket (or a notice saying why not)
    const s = sent.current;
    if (!s || mineIds.length <= s.count) return;
    const t = store.tickets.find(t => t.id === Math.max(...mineIds));
    sent.current = null; if (t) onFiled(t);
  });
  const send = () => {
    if (!title.trim()) return setErr('Give it a title.');
    if (!text.trim()) return setErr('Describe what happened.');
    setErr(''); sent.current = { count: mineIds.length, at: Date.now() };
    store.fileTicket(title.trim(), text.trim());
  };
  const keys = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } };
  return <form className="crt-form" onSubmit={e => { e.preventDefault(); send(); }}>
    <label>Title&gt; <input autoFocus maxLength={TICKET_TITLE_MAX} value={title} onChange={e => { setTitle(e.target.value); setErr(''); }} onKeyDown={keys} placeholder="More plants in the Studio" /></label>
    <label>Say more&gt; <textarea rows={6} maxLength={TICKET_TEXT_MAX} value={text} onChange={e => { setText(e.target.value); setErr(''); }} onKeyDown={keys} placeholder="What would make the office better? (Found a bug? Use Report a bug.)" /></label>
    <p className="crt-dim">Attached: {navigator.userAgent.match(/(Firefox|Edg|Chrome|Safari)\/[\d.]+/)?.[0] ?? 'browser'} · {innerWidth}×{innerHeight} · build {store.build?.slice(0, 7) ?? '?'}</p>
    {err && <p className="crt-err">{err}</p>}
    <div><button type="submit" className="crt-btn">[Send]</button></div>
  </form>;
}

function TicketView({ store, t }: { store: Store; t: Ticket }) {
  const [text, setText] = useState('');
  const admin = store.admin, end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (store.ticketUnread(t)) store.seeTicket(t.id); const body = end.current?.closest('.crt-body'); if (body) body.scrollTop = body.scrollHeight; }, [t.msgs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = () => { if (text.trim()) { store.replyTicket(t.id, text.trim()); setText(''); } };
  const status = (s: Ticket['status']) => <button type="button" className="crt-btn" onClick={() => store.setTicketStatus(t.id, s)}>[{s === 'open' ? 'Reopen' : s === 'fixed' ? 'Mark fixed' : 'Close'}]</button>;
  return <div className="crt-ticket">
    <p><b>{ticketNo(t.id)}</b> <span className={`crt-st ${t.status}`}>{t.status}</span> {t.title}</p>
    {admin && <p className="crt-dim">From {store.name(t.by)} · {t.context.app} · {t.context.viewport} · build {t.context.build.slice(0, 7) || '?'} · at {t.context.room ?? '?'} {t.context.tile ? `${t.context.tile.x},${t.context.tile.y}` : ''}<br />{t.context.ua}</p>}
    <div className="crt-thread">
      {t.msgs.map((m, i) => m.system
        ? <p key={i} className="crt-dim">— {store.name(m.by).split(' ')[0]} {m.text} · {clock(m.at)}</p>
        : <div key={i} className="crt-msg"><p className="crt-who">{m.admin ? 'Admin·' : ''}{m.by === store.me ? 'You' : store.name(m.by).split(' ')[0]} {clock(m.at)}</p><p className="crt-text">{m.text}</p></div>)}
      <div ref={end} />
    </div>
    <label className="crt-reply">Reply&gt; <textarea rows={2} maxLength={TICKET_TEXT_MAX} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} /></label>
    <div className="crt-actions">
      <button type="button" className="crt-btn" onClick={send}>[Send]</button>
      {admin && t.status !== 'fixed' && status('fixed')}
      {(admin || t.by === store.me) && t.status !== 'closed' && status('closed')}
      {admin && t.status !== 'open' && status('open')}
    </div>
  </div>;
}
