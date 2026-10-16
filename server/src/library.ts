import { randomUUID } from 'node:crypto';
import { LIBRARY_MAX_ARTICLES, LIBRARY_TITLE_MAX, LIBRARY_TOPICS, LIBRARY_URL_MAX, type Article, type LibraryRead, type LibraryState, type LibraryTopic } from '../../shared/protocol';

const READS_KEPT = 1000; // finished reads in the log; older ones drop off
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The link as stored: http(s) only, no credentials, or null. */
export function cleanUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > LIBRARY_URL_MAX || /\s/.test(s)) return null;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}
export const cleanTitle = (raw: unknown) => typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
export const isTopic = (t: unknown): t is LibraryTopic => (LIBRARY_TOPICS as readonly string[]).includes(t as string);

export class Library {
  articles: Article[] = [];
  /** Open reads (done: false) are in memory only; they never outlive a restart. */
  reads: LibraryRead[] = [];

  /** Add a link, or say why not. Over the cap the oldest article nobody has finished goes first, else the oldest. */
  add(by: string, url: unknown, title: unknown, topic: unknown, now: number): Article | string {
    const link = cleanUrl(url), name = cleanTitle(title);
    if (!link) return 'That link needs to be a web address (http or https)';
    if (!name) return 'Give the article a title';
    if (name.length > LIBRARY_TITLE_MAX) return `Keep the title under ${LIBRARY_TITLE_MAX} characters`;
    if (!isTopic(topic)) return 'Pick a topic';
    if (this.articles.some(a => a.url === link)) return 'Already on the shelf';
    const article: Article = { id: randomUUID().slice(0, 8), url: link, title: name, topic, by, at: now };
    this.articles.push(article);
    while (this.articles.length > LIBRARY_MAX_ARTICLES) {
      const gone = this.articles.find(a => a.id !== article.id && !this.reads.some(r => r.articleId === a.id && r.done))
        ?? this.articles.find(a => a.id !== article.id)!;
      this.drop(gone.id);
    }
    return article;
  }
  private drop(id: string) {
    this.articles = this.articles.filter(a => a.id !== id);
    this.reads = this.reads.filter(r => r.articleId !== id);
  }
  /** Take an article down: its author, or an admin. */
  remove(id: string, userId: string, admin: boolean) {
    const a = this.articles.find(a => a.id === id);
    if (!a || (a.by !== userId && !admin)) return false;
    this.drop(id); return true;
  }
  get(id: string) { return this.articles.find(a => a.id === id); }

  start(userId: string, articleId: string, now: number) {
    this.reads = this.reads.filter(r => r.done || r.userId !== userId);
    this.reads.push({ userId, articleId, at: now, done: false });
  }
  /** Close my open read; returns it (now done), or null if I had none. */
  finish(userId: string): LibraryRead | null {
    const r = this.reads.find(r => !r.done && r.userId === userId);
    if (!r) return null;
    r.done = true;
    const done = this.reads.filter(r => r.done);
    if (done.length > READS_KEPT) { const drop = new Set(done.slice(0, done.length - READS_KEPT)); this.reads = this.reads.filter(r => !drop.has(r)); }
    return r;
  }
  /** Different articles this person has finished. */
  articlesRead(userId: string) { return new Set(this.reads.filter(r => r.done && r.userId === userId).map(r => r.articleId)).size; }
  /** Different people (not the author) who finished this article. */
  readers(articleId: string) {
    const by = this.get(articleId)?.by;
    return new Set(this.reads.filter(r => r.done && r.articleId === articleId && r.userId !== by).map(r => r.userId));
  }

  /** What everyone sees: the shelf and the finished reads. */
  state(): LibraryState { return { articles: this.articles, reads: this.reads.filter(r => r.done) }; }
  dump(): LibraryState { return structuredClone(this.state()); }
  load(saved: unknown) {
    const d = record(saved), ids = new Set<string>(), urls = new Set<string>();
    this.articles = []; this.reads = [];
    for (const raw of Array.isArray(d.articles) ? d.articles : []) {
      const a = record(raw), url = cleanUrl(a.url), title = cleanTitle(a.title);
      if (typeof a.id !== 'string' || !url || !title || title.length > LIBRARY_TITLE_MAX || !isTopic(a.topic) || typeof a.by !== 'string' || !finite(a.at)
        || ids.has(a.id) || urls.has(url) || this.articles.length >= LIBRARY_MAX_ARTICLES) continue;
      ids.add(a.id); urls.add(url);
      this.articles.push({ id: a.id, url, title, topic: a.topic, by: a.by, at: a.at });
    }
    for (const raw of Array.isArray(d.reads) ? d.reads : []) {
      const r = record(raw);
      if (typeof r.userId === 'string' && typeof r.articleId === 'string' && ids.has(r.articleId) && finite(r.at)) this.reads.push({ userId: r.userId, articleId: r.articleId, at: r.at, done: true });
    }
  }
}
