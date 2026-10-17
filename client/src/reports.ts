// Client side of logging: a ring buffer of recent intents and server events, uncaught-error reports and the bug report.
import { webBuild } from './buildInfo';

export interface RecentEvent { at: number; k: string; s: string }
const RING = 200, QUIET = new Set(['pong', 'ping', 'rtc', 'speaking', 'retro_frames', 'game_input', 'tz', 'active', 'jukebox', 'creatures', 'creature', 'move_ack']);
const ring: RecentEvent[] = [];
/** Remember an intent ('out') or a server message ('in'); chatty kinds are skipped, text is cut short. */
export function recordEvent(k: 'out' | 'in', msg: { t?: string }) {
  const t = msg?.t ?? '?';
  if (QUIET.has(t)) return;
  let s = t;
  try { const { t: _t, ...rest } = msg as Record<string, unknown>; const body = JSON.stringify(rest, (_k, v) => typeof v === 'string' && v.length > 60 ? `${v.slice(0, 60)}…` : v); if (body !== '{}') s = `${t} ${body}`; } catch { /* keep the type */ }
  ring.push({ at: Date.now(), k, s: s.slice(0, 280) });
  if (ring.length > RING) ring.shift();
}
export const recentEvents = () => ring.slice();

export interface ErrorRecord { kind: string; msg: string; stack: string; src: string; line: number; col: number; at: number; count: number }
/** Same error seen again within the batch counts up instead of repeating. */
export function addError(batch: ErrorRecord[], e: Omit<ErrorRecord, 'count'>, max = 20) {
  const same = batch.find(b => b.kind === e.kind && b.msg === e.msg && b.src === e.src && b.line === e.line);
  if (same) same.count++; else if (batch.length < max) batch.push({ ...e, count: 1 });
}

let installed = false;
/** window.onerror + unhandledrejection → one POST every few seconds at most, session-authenticated. */
export function installErrorReporting(session: () => string) {
  if (installed) return; installed = true;
  let batch: ErrorRecord[] = [], timer = 0, sent = 0;
  const flush = () => {
    timer = 0;
    const records = batch; batch = [];
    if (!records.length || sent >= 30) return; // a broken page can't flood the server
    sent++;
    void fetch('/api/client-errors', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-deck-session': session() },
      body: JSON.stringify({ page: webBuild.sha, build: `${webBuild.version}+${webBuild.sha}`, ua: navigator.userAgent.slice(0, 400), records }) }).catch(() => {});
  };
  const queue = (e: Omit<ErrorRecord, 'count'>) => { addError(batch, e); timer ||= window.setTimeout(flush, 3000); };
  window.addEventListener('error', ev => queue({ kind: 'error', msg: String(ev.message).slice(0, 500), stack: String(ev.error?.stack ?? '').slice(0, 2000), src: String(ev.filename ?? '').slice(0, 300), line: ev.lineno, col: ev.colno, at: Date.now() }));
  window.addEventListener('unhandledrejection', ev => {
    const r = ev.reason;
    queue({ kind: 'promise', msg: String(r?.message ?? r).slice(0, 500), stack: String(r?.stack ?? '').slice(0, 2000), src: '', line: 0, col: 0, at: Date.now() });
  });
  window.addEventListener('pagehide', flush);
}

export interface BugContext { session: string; capture: () => Promise<string | null>; versions: () => Record<string, string> }
/** Send a bug report: your note, the last ~200 events, versions and a screenshot of the floor. Resolves to an error text or null. */
export async function reportBug(ctx: BugContext, note: string, screenshot = true): Promise<string | null> {
  const shot = screenshot ? await ctx.capture().catch(() => null) : null;
  try {
    const r = await fetch('/api/bug', { method: 'POST', headers: { 'content-type': 'application/json', 'x-deck-session': ctx.session },
      body: JSON.stringify({ note, events: recentEvents(), versions: { web: `${webBuild.version}+${webBuild.sha}`, ...ctx.versions() }, page: webBuild.sha, ua: navigator.userAgent.slice(0, 400), screenshot: shot ?? undefined }) });
    return r.ok ? null : (await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`;
  } catch { return 'Could not reach the server'; }
}
