import { Icon } from './Icon';
// The reading room: the Library panel (shelf by topic, publish form, log) and the reading overlay.
import { useEffect, useState } from 'react';
import type { Store } from './net';
import { BOOKWORM_READS, EDITOR_READERS, LIBRARY_TITLE_MAX, LIBRARY_TOPICS, LIBRARY_URL_MAX, LIBRARY_WEEK_MS, type Article } from '../../shared/protocol';

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

/** The Focus room's shelf: pick an article by topic, publish one, see what's been read. */
export function LibraryPanel({ store }: { store: Store }) {
  const [tab, setTab] = useState<'shelf' | 'log'>('shelf');
  const [topic, setTopic] = useState<string>(() => LIBRARY_TOPICS.find(t => store.library.articles.some(a => a.topic === t)) ?? LIBRARY_TOPICS[0]);
  const [publishing, setPublishing] = useState(false);
  const [url, setUrl] = useState(''), [title, setTitle] = useState(''), [pubTopic, setPubTopic] = useState<string>(LIBRARY_TOPICS[0]);
  const close = () => store.openLibrary(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') store.openLibrary(false); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [store]);
  const me = store.users.get(store.me), { articles, reads } = store.library;
  const busy = !!me?.reading || !!store.fetching;
  const inTopic = articles.filter(a => a.topic === topic).sort((a, b) => b.at - a.at);
  const urlOk = /^https?:\/\/\S+$/i.test(url.trim()) && url.trim().length <= LIBRARY_URL_MAX;
  const publish = () => {
    store.publishArticle(url.trim(), title.trim(), pubTopic);
    setUrl(''); setTitle(''); setTopic(pubTopic); setPublishing(false);
  };
  const row = (a: Article) => {
    const n = store.readCount(a.id), mine = a.by === store.me;
    return <li key={a.id} className="library-row">
      <div className="library-main">
        <b>{a.title}</b>
        <small>{host(a.url)} · {mine ? 'you' : store.name(a.by)} · {n} read{n === 1 ? '' : 's'}</small>
      </div>
      {(mine || store.admin) && <button type="button" className="ghost" aria-label={`Take down ${a.title}`} title="Take down" onClick={() => store.removeArticle(a.id)}><Icon name="close" /></button>}
      <button type="button" disabled={!store.connected || busy} onClick={() => store.readArticle(a.id)}>Read</button>
    </li>;
  };

  // the log: most read, this week, and mine
  const since = store.now() - LIBRARY_WEEK_MS;
  const byId = new Map(articles.map(a => [a.id, a]));
  const top = articles.map(a => ({ a, n: store.readCount(a.id) })).filter(x => x.n > 0).sort((x, y) => y.n - x.n || y.a.at - x.a.at).slice(0, 5);
  const week = new Map<string, Article[]>();
  for (const r of [...reads].sort((x, y) => y.at - x.at)) {
    const a = byId.get(r.articleId); if (!a || r.at < since) continue;
    const list = week.get(r.userId) ?? []; if (!list.includes(a)) list.push(a); week.set(r.userId, list);
  }
  const mineRead = new Set(reads.filter(r => r.userId === store.me).map(r => r.articleId)).size;

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="meet-panel guided calendar-panel library-panel" role="dialog" aria-modal="true" aria-label="Library">
        <div className="rooms-head"><span><Icon name="book" /> Library</span><button type="button" className="ghost" aria-label="Close library" onClick={close}><Icon name="close" /></button></div>
        <div className="library-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'shelf'} className={tab === 'shelf' ? '' : 'ghost'} onClick={() => setTab('shelf')}>Shelf</button>
          <button type="button" role="tab" aria-selected={tab === 'log'} className={tab === 'log' ? '' : 'ghost'} onClick={() => setTab('log')}>Log</button>
        </div>
        {tab === 'shelf' && <>
          <div className="library-topics">
            {LIBRARY_TOPICS.map(t => <button type="button" key={t} className={t === topic ? '' : 'ghost'} onClick={() => setTopic(t)}>{t} · {articles.filter(a => a.topic === t).length}</button>)}
          </div>
          {busy && <p className="muted small">{me?.reading ? 'You are reading right now.' : 'Fetching a book…'}</p>}
          {inTopic.length ? <ul className="library-list">{inTopic.map(row)}</ul>
            : <p className="muted small">Nothing on the {topic} shelf yet.</p>}
          {publishing
            ? <form className="library-form" onSubmit={e => { e.preventDefault(); if (urlOk && title.trim()) publish(); }}>
                <input type="url" placeholder="https://…" aria-label="Article link" value={url} maxLength={LIBRARY_URL_MAX} onChange={e => setUrl(e.target.value)} autoFocus />
                <input type="text" placeholder="Title" aria-label="Article title" value={title} maxLength={LIBRARY_TITLE_MAX} onChange={e => setTitle(e.target.value)} />
                <select aria-label="Topic" value={pubTopic} onChange={e => setPubTopic(e.target.value)}>{LIBRARY_TOPICS.map(t => <option key={t}>{t}</option>)}</select>
                <div className="row">
                  <button type="submit" disabled={!urlOk || !title.trim() || !store.connected}>Put it on the shelf</button>
                  <button type="button" className="ghost" onClick={() => setPublishing(false)}>Cancel</button>
                </div>
              </form>
            : <div className="row"><button type="button" onClick={() => { setPubTopic(topic); setPublishing(true); }}>Publish an article</button></div>}
        </>}
        {tab === 'log' && <div className="library-log">
          <p className="small"><b>Your reading:</b> {mineRead} article{mineRead === 1 ? '' : 's'} finished · 📚 Bookworm at {BOOKWORM_READS}, 📰 Editor when {EDITOR_READERS} people read yours.</p>
          <h4>Most read</h4>
          {top.length ? <ol>{top.map(({ a, n }) => <li key={a.id}><a href={a.url} target="_blank" rel="noopener noreferrer">{a.title}</a> <small>{n} read{n === 1 ? '' : 's'}</small></li>)}</ol>
            : <p className="muted small">No reads yet.</p>}
          <h4>This week</h4>
          {week.size ? <ul>{[...week].map(([id, list]) => <li key={id}><b>{id === store.me ? 'You' : store.name(id)}</b> <small>{list.map(a => a.title).join(' · ')}</small></li>)}</ul>
            : <p className="muted small">Nobody has finished anything this week.</p>}
        </div>}
      </div>
    </div>
  );
}

/** What you read while sitting at a reading desk: the page in a frame, or a link when the site won't be framed. */
export function ReadingOverlay({ store, articleId }: { store: Store; articleId: string }) {
  const article = store.library.articles.find(a => a.id === articleId);
  // a refused frame still fires `load` (with an empty error page), so the hint stays up either way
  const [loaded, setLoaded] = useState(false), [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 3000); return () => clearTimeout(t); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') store.readDone(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [store]);
  if (!article) return null; // taken down while reading; standing up or Done still ends the read
  const done = () => store.readDone();
  return (
    <div className="reading-overlay" role="dialog" aria-modal="true" aria-label={`Reading ${article.title}`}>
      <div className="reading-bar">
        <span className="reading-title">📖 {article.title}</span>
        <a className="button-link" href={article.url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
        <button type="button" onClick={done}>Done</button>
      </div>
      {slow && <p className="reading-hint">Page blank? Many sites won't open inside The Deck — use “Open in a new tab”; you stay at your desk until you press Done.</p>}
      <div className="reading-body">
        <iframe title={article.title} src={article.url} sandbox="allow-scripts allow-same-origin allow-popups allow-forms" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} />
        {slow && !loaded && <div className="reading-fallback">
          <p><b>This page is taking its time, or won't open inside The Deck.</b></p>
          <p className="muted small">{host(article.url)}</p>
          <p><a className="button-link" href={article.url} target="_blank" rel="noopener noreferrer">Open “{article.title}” in a new tab</a></p>
          <button type="button" className="ghost" onClick={done}>I'm done</button>
        </div>}
      </div>
    </div>
  );
}
