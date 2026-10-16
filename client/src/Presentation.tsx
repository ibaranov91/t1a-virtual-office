// Presentation mode: the screen's upload panel, the slides as a 90s games-magazine page, and the Live chip.
import { useEffect, useRef, useState } from 'react';
import { drawText, textWidth } from './font';
import { MAP, type Store } from './net';
import { PdfError, renderPdf } from './pdfSlides';
import { PRESENT_AWAY_MS, PRESENT_MAX_BYTES, PRESENT_MAX_SLIDES, slideUrl, type DeckInfo } from '../../shared/protocol';

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

/** The screen's panel: PIN, slides (images or a PDF), and decks shown before. */
export function PresentPanel({ store, id }: { store: Store; id: string }) {
  const [pin, setPin] = useState('');
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [decks, setDecks] = useState<DeckInfo[] | null>(null);
  const live = store.presentation, mine = live?.presenter === store.me;
  const close = () => store.openPresent(null);
  useEffect(() => {
    fetch('/api/present/decks', { headers: { 'x-deck-session': store.sessionId } }).then(r => r.json()).then(d => setDecks(d.decks ?? [])).catch(() => setDecks([]));
  }, [store]);
  const call = async (path: string, body: object) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-deck-session': store.sessionId }, body: JSON.stringify({ pin, objectId: id, ...body }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setErr(d.error ?? `Failed (${r.status})`);
      store.hideSlides(false); close();
    } catch { setErr('Network error. Try again.'); } finally { setBusy(false); }
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
  };
  const pinOk = /^\d{4}$/.test(pin);
  return (
    <div className="modal-backdrop present-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="meet-panel guided present-panel" role="dialog" aria-label="Present slides">
        <div className="rooms-head"><span>📺 Screen</span><button type="button" className="ghost" onClick={close} aria-label="Close">×</button></div>
        {live && <div className="present-live">
          <span>LIVE: <b>{live.deck.title}</b> · {mine ? 'you\'re presenting' : store.name(live.presenter)}</span>
          {mine ? <button onClick={() => { store.presentStop(); close(); }}>Stop</button>
            : <button className="ghost" onClick={() => { store.hideSlides(false); close(); }}>Watch</button>}
        </div>}
        <p className="small muted">Put slides up for everyone in the {MAP.rooms.find(r => r.id === (live?.room ?? 'meeting'))?.name ?? 'Meeting'} room. PNG or JPG images (one per slide, in file-name order) or one PDF.</p>
        <form className="present-form" onSubmit={e => { e.preventDefault(); if (pinOk && files.length && !busy) void upload(); }}>
          <label>PIN <input inputMode="numeric" autoComplete="off" maxLength={4} value={pin} placeholder="••••" onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} autoFocus /></label>
          <label>Title <input value={title} maxLength={60} placeholder="Sprint demo" onChange={e => setTitle(e.target.value)} /></label>
          <label className="present-file">Slides <input type="file" multiple accept="image/png,image/jpeg,application/pdf,.pdf" onChange={e => setFiles([...(e.target.files ?? [])])} /></label>
          {files.length > 0 && <span className="small muted">{files.length} file{files.length > 1 ? 's' : ''} · {(files.reduce((n, f) => n + f.size, 0) / 1024 / 1024).toFixed(1)} MB</span>}
          {err && <p className="err">{err}</p>}
          <div className="row"><button type="submit" disabled={!pinOk || !files.length || busy}>{busy ? (progress || 'Uploading…') : 'Upload & present'}</button></div>
        </form>
        {!!decks?.length && <div className="present-decks">
          <span className="small muted">Shown before{pinOk ? '' : ' (enter the PIN first)'}</span>
          {decks.map(d => <div key={d.id} className="row">
            <span className="present-deck-title" title={d.title}>{d.title} · {d.count} slide{d.count > 1 ? 's' : ''}</span>
            <button className="ghost" disabled={!pinOk || busy} onClick={() => void call('/api/present/start', { deck: d.id })}>Present</button>
          </div>)}
        </div>}
      </div>
    </div>
  );
}

/** The slides as a page out of a 90s games magazine. The presenter turns pages with ← →. */
export function SlideOverlay({ store }: { store: Store }) {
  const live = store.presentation!, deck = live.deck, mine = live.presenter === store.me;
  const n = live.slide + 1, total = deck.count;
  const [awaySince, setAwaySince] = useState<number | null>(null);
  useEffect(() => { setAwaySince(live.away ? Date.now() : null); }, [live.away]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !mine && !(e.target instanceof Element && e.target.closest('input, textarea, select'))) return store.hideSlides(true);
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable], [role="dialog"]'))) return;
      const step = mine ? ({ ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 } as Record<string, number>)[e.key] : undefined;
      if (step) { e.preventDefault(); store.presentSlide(live.slide + step); }
      else if (mine && e.key === 'Home') { e.preventDefault(); store.presentSlide(0); }
      else if (mine && e.key === 'End') { e.preventDefault(); store.presentSlide(total - 1); }
      else if (e.key === 'Escape' && !mine) store.hideSlides(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, mine, live.slide, total]);
  useEffect(() => { if (n < total) new Image().src = slideUrl(deck, n); }, [deck, n, total]); // the next page, ahead of time
  const presenter = store.name(live.presenter).split(' ')[0];
  const left = awaySince === null ? 0 : Math.max(0, Math.ceil((PRESENT_AWAY_MS - (Date.now() - awaySince)) / 1000));
  const issue = String(new Date(deck.at).getMonth() + 1).padStart(2, '0');
  if (!mine) return (
    <div className="modal-backdrop watch-backdrop" onClick={e => { if (e.target === e.currentTarget) store.hideSlides(true); }}>
      <div className="watch-modal" role="dialog" aria-label={`Slides: ${deck.title}`}>
        <div className="watch-head">
          <span><b className="live-dot">● LIVE</b> {deck.title} · {presenter}</span>
          <button type="button" className="ghost" onClick={() => store.hideSlides(true)} aria-label="Close">×</button>
        </div>
        <div className="watch-slide">
          <img key={n} src={slideUrl(deck, live.slide)} alt={`Slide ${n} of ${total}`} draggable={false} />
        </div>
        <div className="watch-foot">
          {live.away && <span className="mag-away">{presenter} lost connection · ends in {left}s</span>}
          <span className="mag-page">{n} / {total}</span>
        </div>
      </div>
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
            <button onClick={() => store.presentSlide(live.slide - 1)} disabled={live.slide === 0} aria-label="Previous slide">◀</button>
            <span className="mag-page">{n} / {total}</span>
            <button onClick={() => store.presentSlide(live.slide + 1)} disabled={n === total} aria-label="Next slide">▶</button>
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
        if (!store.pose(me).walking && asked.current !== live.deck.id) { asked.current = live.deck.id; if (store.slidesHidden) setAsk(true); }
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
  const who = store.name(live.presenter).split(' ')[0];
  const show = () => { setAsk(false); store.hideSlides(false); };
  if (ask && here) return (
    <div className="desk-chip live-chip watch-ask" role="dialog" aria-label="Watch the presentation?">
      <span><b className="live-dot">● LIVE</b> {who} is presenting '{live.deck.title}'. Watch?</span>
      <button onClick={show}>Watch</button>
      <button className="ghost" onClick={() => setAsk(false)}>Not now</button>
    </div>
  );
  const go = () => (here ? show() : onGo(live.room));
  return (
    <div className="desk-chip live-chip" onClick={go}>
      <span><b className="live-dot">● LIVE</b> {live.deck.title} · {who}</span>
      <button onClick={e => { e.stopPropagation(); go(); }}>{here ? 'Show' : 'Go watch'}</button>
    </div>
  );
}
