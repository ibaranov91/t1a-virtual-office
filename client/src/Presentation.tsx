import { Icon } from './Icon';
// Presentation mode: the screen's upload panel, the slides as a 90s games-magazine page, and the Live chip.
import { useEffect, useRef, useState } from 'react';
import { drawText, textWidth } from './font';
import { MAP, type Store } from './net';
import { startShare } from './share';
import { PdfError, renderPdf } from './pdfSlides';
import { PRESENT_AWAY_MS, PRESENT_MAX_BYTES, PRESENT_MAX_SLIDES, slideUrl, type DecksReply, type DeckInfo } from '../../shared/protocol';

/** Chunky text in the office's own 3×5 pixel font, with a hard drop shadow. */
export function PixelText({ text, scale = 3, color = '#fff', shadow = '#1a0f2e', className }: { text: string; scale?: number; color?: string; shadow?: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = textWidth(text) + 1, h = 6;
  useEffect(() => {
    const c = ref.current, ctx = c?.getContext('2d'); if (!c || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.scale(scale, scale);
    if (shadow) drawText(ctx, text, 1, 1, shadow);
    drawText(ctx, text, 0, 0, color);
  }, [text, scale, color, shadow]);
  return <canvas ref={ref} className={`pixel-text${className ? ` ${className}` : ''}`} width={w * scale} height={h * scale} role="img" aria-label={text} />;
}

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const readBase64 = (f: Blob) => new Promise<string>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = () => fail(r.error);
  r.readAsDataURL(f);
});

const mb = (n: number) => (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0);
const age = (at: number) => { const m = Math.max(0, Math.round((Date.now() - at) / 60_000)); return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`; };
/** The screen's panel: slides (images or a PDF), my deck library, and screen share. */
export function PresentPanel({ store, id }: { store: Store; id: string }) {
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [lib, setLib] = useState<DecksReply | null>(null);
  const live = store.presentation, mine = live?.presenter === store.me, taken = !!live && !mine;
  const close = () => store.openPresent(null);
  const headers = { 'x-deck-session': store.sessionId };
  const refresh = () => fetch('/api/present/decks', { headers }).then(r => r.json()).then(d => setLib({ decks: d.decks ?? [], used: d.used ?? 0, limit: d.limit ?? 0 })).catch(() => setLib({ decks: [], used: 0, limit: 0 }));
  useEffect(() => { void refresh(); }, [store]); // once per store: refresh is a new function every render
  const call = async (path: string, body: object) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ objectId: id, ...body }) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409) { void refresh(); return setErr(d.error ?? 'Someone else is presenting.'); }
      if (!r.ok) return setErr(d.error ?? `Failed (${r.status})`);
      if (!d.deck) return;
      store.hideSlides(false); close();
    } catch { setErr('Network error. Try again.'); } finally { setBusy(false); }
  };
  const remove = async (d: DeckInfo) => {
    setErr(null);
    const r = await fetch(`/api/present/${d.id}`, { method: 'DELETE', headers }).catch(() => null);
    if (!r?.ok) setErr('Couldn\'t delete that deck.');
    void refresh();
  };
  const shareScreen = async () => {
    setErr(null);
    const e = await startShare(store, id);
    if (e) return setErr(e);
    store.hideSlides(false); close();
  };
  const upload = async () => {
    const size = files.reduce((n, f) => n + f.size, 0);
    if (size > PRESENT_MAX_BYTES) return setErr(`Too big: ${Math.round(PRESENT_MAX_BYTES / 1024 / 1024)} MB at most.`);
    const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    setBusy(true); setErr(null);
    let slides: Blob[] = sorted;
    if (sorted.length === 1 && isPdf(sorted[0])) { // pages become images here, so any server can show them
      try { slides = await renderPdf(sorted[0], PRESENT_MAX_SLIDES, (n, total) => setProgress(`Rendering page ${n}/${total}…`)); }
      catch (e) { setProgress(''); setBusy(false); return setErr(e instanceof PdfError ? e.message : 'Couldn\'t read that PDF.'); }
      setProgress('');
      if (slides.reduce((n, b) => n + b.size, 0) > PRESENT_MAX_BYTES) { setBusy(false); return setErr(`Those pages come to more than ${Math.round(PRESENT_MAX_BYTES / 1024 / 1024)} MB. Use a shorter PDF.`); }
    }
    if (slides.length > PRESENT_MAX_SLIDES) { setBusy(false); return setErr(`At most ${PRESENT_MAX_SLIDES} slides.`); }
    const data = await Promise.all(slides.map(readBase64)).catch(() => null);
    if (!data) { setBusy(false); return setErr('Couldn\'t read those files.'); }
    await call('/api/present/upload', { title: title || sorted[0].name.replace(/\.[^.]+$/, ''), files: data });
    void refresh();
  };
  const watch = () => { store.hideSlides(false); close(); };
  return (
    <div className="modal-backdrop present-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="meet-panel guided present-panel" role="dialog" aria-label="Present slides">
        <div className="rooms-head"><span><Icon name="monitor" /> Screen</span><button type="button" className="ghost" onClick={close} aria-label="Close"><Icon name="close" /></button></div>
        {live && <div className="present-live">
          <span>{taken ? <><b>{store.name(live.presenter)}</b> is presenting <b>{live.deck?.title ?? 'their screen'}</b></> : <>LIVE: <b>{live.deck?.title ?? 'Your screen'}</b> · you're presenting</>}</span>
          {mine ? <button onClick={() => { store.presentStop(); close(); }}>Stop</button> : <button className="ghost" onClick={watch}>Watch</button>}
        </div>}
        <div className="present-tabs">
          <span className="present-tab-label">Slides</span>
          <button className="present-share" disabled={taken || busy} onClick={() => void shareScreen()}><Icon name="monitor" /> Share screen</button>
        </div>
        <p className="small muted">Put slides up for everyone {store.users.get(store.me)?.instance ? 'in this meeting' : `in the ${MAP.rooms.find(r => r.id === (live?.room ?? 'meeting'))?.name ?? 'Meeting'} room`}. PNG or JPG images (one per slide, in file-name order) or one PDF.{taken && ' Uploads are saved to your decks until the screen is free.'}</p>
        <form className="present-form" onSubmit={e => { e.preventDefault(); if (files.length && !busy) void upload(); }}>
          <label>Title <input value={title} maxLength={60} placeholder="Sprint demo" onChange={e => setTitle(e.target.value)} /></label>
          <label className="present-file">Slides <input type="file" multiple accept="image/png,image/jpeg,application/pdf,.pdf" onChange={e => setFiles([...(e.target.files ?? [])])} /></label>
          {files.length > 0 && <span className="small muted">{files.length} file{files.length > 1 ? 's' : ''} · {mb(files.reduce((n, f) => n + f.size, 0))} MB</span>}
          <div className="row"><button type="submit" disabled={!files.length || busy}>{busy ? (progress || 'Uploading…') : taken ? 'Upload to my decks' : 'Upload & present'}</button></div>
        </form>
        {err && <p className="err">{err}</p>}
        {lib && <div className="present-decks">
          <span className="small muted">My decks (they expire after 24 h)</span>
          {lib.decks.length === 0 && <span className="small muted">Nothing here yet.</span>}
          {lib.decks.map(d => <div key={d.id} className="row">
            <span className="present-deck-title" title={d.title}>{d.title}<span className="muted small"> · {d.count} slide{d.count > 1 ? 's' : ''} · {mb(d.bytes)} MB · {age(d.at)}</span></span>
            <button className="ghost" disabled={taken || busy} onClick={() => void call('/api/present/start', { deck: d.id })}>Present</button>
            <button className="ghost" aria-label={`Delete ${d.title}`} onClick={() => void remove(d)}><Icon name="trash" /></button>
          </div>)}
          {lib.limit > 0 && <div className="present-usage" title="Library space used"><div style={{ width: `${Math.min(100, lib.used / lib.limit * 100)}%` }} /><span>{mb(lib.used)} / {mb(lib.limit)} MB</span></div>}
        </div>}
      </div>
    </div>
  );
}

/** The slides as a page out of a 90s games magazine. The presenter turns pages with ← →. */
export function SlideOverlay({ store }: { store: Store }) {
  const live = store.presentation!, mine = live.presenter === store.me;
  const shared = !live.deck, deck = live.deck ?? { id: '', title: 'Screen share', count: 1, ext: [], by: live.presenter, at: Date.now(), bytes: 0, key: '' };
  const n = live.slide + 1, total = deck.count;
  const [awaySince, setAwaySince] = useState<number | null>(null);
  useEffect(() => { setAwaySince(live.away ? Date.now() : null); }, [live.away]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !mine && !(e.target instanceof Element && e.target.closest('input, textarea, select'))) return store.hideSlides(true);
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable], [role="dialog"]'))) return;
      const step = mine && !shared ? ({ ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 } as Record<string, number>)[e.key] : undefined;
      if (step) { e.preventDefault(); store.presentSlide(live.slide + step); }
      else if (mine && !shared && e.key === 'Home') { e.preventDefault(); store.presentSlide(0); }
      else if (mine && !shared && e.key === 'End') { e.preventDefault(); store.presentSlide(total - 1); }
      else if (e.key === 'Escape' && !mine) store.hideSlides(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, mine, shared, live.slide, total]);
  useEffect(() => { if (!shared && n < total) new Image().src = slideUrl(deck, n); }, [deck, n, total, shared]); // the next page, ahead of time
  const presenter = store.name(live.presenter).split(' ')[0];
  const left = awaySince === null ? 0 : Math.max(0, Math.ceil((PRESENT_AWAY_MS - (Date.now() - awaySince)) / 1000));
  const issue = String(new Date(deck.at).getMonth() + 1).padStart(2, '0');
  if (!mine) return (
    <div className="modal-backdrop watch-backdrop" onClick={e => { if (e.target === e.currentTarget) store.hideSlides(true); }}>
      <div className="watch-modal" role="dialog" aria-label={`Slides: ${deck.title}`}>
        <div className="watch-head">
          <span><b className="live-dot">● LIVE</b>{shared ? ' screen' : ` ${deck.title}`} · {presenter}</span>
          <button type="button" className="ghost" onClick={() => store.hideSlides(true)} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="watch-slide">
          {shared ? (store.frame ? <img src={store.frame.url} alt={`${presenter}'s screen`} draggable={false} /> : <span className="watch-wait">waiting for the first frame…</span>)
            : <img key={n} src={slideUrl(deck, live.slide)} alt={`Slide ${n} of ${total}`} draggable={false} />}
        </div>
        <div className="watch-foot">
          {live.away && <span className="mag-away">{presenter} lost connection · ends in {left}s</span>}
          {!shared && <span className="mag-page">{n} / {total}</span>}
        </div>
      </div>
    </div>
  );
  if (shared) return (
    <div className="desk-chip live-chip share-card" role="region" aria-label="Sharing your screen">
      <span><b className="live-dot">● LIVE</b> You're sharing your screen</span>
      <button className="mag-stop" onClick={() => store.presentStop()}>Stop</button>
    </div>
  );
  return (
    <div className="mag-wrap" role="region" aria-label={`Slides: ${deck.title}`}>
      <div className="mag">
        <header className="mag-mast">
          <div className="mag-logo"><PixelText text="DECK POWER" scale={5} color="#ffe14f" shadow="#ff2d95" /></div>
          <div className="mag-issue"><span>ISSUE #{issue}</span><span>T1A · FREE!</span></div>
        </header>
        <div className="mag-strip"><span>EXCLUSIVE!</span><PixelText text={deck.title} scale={2} color="#fff" shadow="#000" /><span className="mag-strip-by">BY {presenter.toUpperCase()}</span></div>
        <div className="mag-body">
          <figure className="mag-slide">
            <div className="mag-new" aria-hidden><span>NEW!</span></div>
            <img key={n} src={slideUrl(deck, live.slide)} alt={`Slide ${n} of ${total}`} draggable={false} />
            <figcaption>PAGE {n} · {deck.title}</figcaption>
          </figure>
        </div>
        <footer className="mag-foot">
          {live.away && <span className="mag-away">{presenter} lost connection · ends in {left}s</span>}
          {mine ? <>
            <button onClick={() => store.presentSlide(live.slide - 1)} disabled={live.slide === 0} aria-label="Previous slide"><Icon name="chevron-left" /></button>
            <span className="mag-page">{n} / {total}</span>
            <button onClick={() => store.presentSlide(live.slide + 1)} disabled={n === total} aria-label="Next slide"><Icon name="chevron-right" /></button>
            <button className="mag-stop" onClick={() => store.presentStop()}>Stop</button>
          </> : <>
            <span className="mag-page">{n} / {total}</span>
            <button className="ghost" onClick={() => store.hideSlides(true)}>Hide</button>
          </>}
        </footer>
      </div>
      <div className="mag-crt" aria-hidden />
    </div>
  );
}

/** One chip for slides I'm not looking at: in the screen's room it asks once per deck (Watch / Not now), then offers Show;
 *  elsewhere it takes me there. Leaving the room closes the slides. */
export function LiveChip({ store, onGo }: { store: Store; onGo: (room: string) => void }) {
  const [ask, setAsk] = useState(false);
  const asked = useRef<string | null>(null);
  useEffect(() => {
    const tick = () => {
      const live = store.presentation, me = store.users.get(store.me);
      if (!live || !me || me.bot || live.presenter === me.id) { asked.current = null; setAsk(false); return; }
      if (store.inPresentationRoom()) {
        if (!store.pose(me).walking && asked.current !== (live.deck?.id ?? live.presenter)) { asked.current = live.deck?.id ?? live.presenter; if (store.slidesHidden) setAsk(true); }
      } else {
        if (!store.slidesHidden) store.hideSlides(true);
        asked.current = null; setAsk(false);
      }
    };
    tick();
    const t = setInterval(tick, 400);
    return () => clearInterval(t);
  }, [store]);
  const live = store.presentation;
  if (!live) return null;
  const here = store.inPresentationRoom();
  if (here && !store.slidesHidden) return null;
  if (!here && store.users.get(store.me)?.instance) return null; // a meeting's screen can't be walked to from elsewhere
  const who = store.name(live.presenter).split(' ')[0];
  const show = () => { setAsk(false); store.hideSlides(false); };
  if (ask && here) return (
    <div className="desk-chip live-chip watch-ask" role="dialog" aria-label="Watch the presentation?">
      <span><b className="live-dot">● LIVE</b> {live.deck ? `${who} is presenting '${live.deck.title}'. Watch?` : `${who} is sharing their screen. Watch?`}</span>
      <button onClick={show}>Watch</button>
      <button className="ghost" onClick={() => setAsk(false)}>Not now</button>
    </div>
  );
  const go = () => (here ? show() : onGo(live.room));
  return (
    <div className="desk-chip live-chip" onClick={go}>
      <span><b className="live-dot">● LIVE</b> {live.deck ? `${live.deck.title} · ${who}` : `${who} is sharing their screen`}</span>
      <button onClick={e => { e.stopPropagation(); go(); }}>{here ? 'Show' : 'Go watch'}</button>
    </div>
  );
}
