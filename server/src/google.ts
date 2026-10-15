// "Connect Google": OAuth (authorization code + PKCE, offline) so the server can make Meet rooms for calls.
// Refresh tokens stay on the server, encrypted with GOOGLE_TOKEN_KEY; access tokens live in memory only.
// More scopes (Calendar…) are asked for later, incrementally, on the same client.
import type { CalEvent } from '../../shared/protocol';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const KEY = Buffer.from(process.env.GOOGLE_TOKEN_KEY ?? '', 'base64');
const HD = process.env.GOOGLE_HD?.toLowerCase();  // only accounts of this Workspace domain, e.g. t1a.com
const REDIRECT = process.env.GOOGLE_REDIRECT_URI
  ?? (process.env.DECK_PUBLIC_URL ? `${process.env.DECK_PUBLIC_URL.replace(/\/+$/, '')}/api/google/callback` : '');
export const MEET_SCOPE = 'https://www.googleapis.com/auth/meetings.space.created';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly'; // asked for only when someone opens a calendar
const SCOPES = ['openid', 'email', MEET_SCOPE];

export const googleEnabled = !!(CLIENT_ID && CLIENT_SECRET && KEY.length === 32 && REDIRECT);
if ((CLIENT_ID || CLIENT_SECRET) && !googleEnabled)
  console.warn('google: off. Needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_KEY (32 bytes, base64) and GOOGLE_REDIRECT_URI or DECK_PUBLIC_URL');

/** What's saved per user. `refresh` is encrypted; never sent to any client. */
export interface GoogleLink { email: string; refresh: string; scopes: string[] }

const seal = (plain: string) => {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
};
const open = (sealed: string) => {
  const b = Buffer.from(sealed, 'base64'), d = createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
};
const b64url = (b: Buffer) => b.toString('base64url');

// state -> who started it. Single use, 10 minutes. No cookie needed, so the Mac app can finish sign-in in the system browser.
const pending = new Map<string, { userId: string; verifier: string; at: number }>();

/** The Google consent URL for this user. */
export const authUrl = (userId: string, loginHint?: string, extra: string[] = []) => {
  const now = Date.now();
  for (const [s, p] of pending) if (now - p.at > 10 * 60_000) pending.delete(s);
  const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(32));
  pending.set(state, { userId, verifier, at: now });
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: [...SCOPES, ...extra].join(' '), state,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  });
  if (loginHint) q.set('login_hint', loginHint);
  if (HD) q.set('hd', HD);
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
};

const tokenCall = async (params: Record<string, string>) => {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const j = await r.json().catch(() => ({})) as Record<string, string | number | undefined>;
  if (!r.ok) throw Object.assign(new Error(`google token: ${j.error ?? r.status}`), { code: j.error });
  return j;
};

const access = new Map<string, { token: string; exp: number }>(); // userId -> access token (memory only)

/** Finish the redirect: exchange the code. The id_token comes straight from Google over TLS, so its claims can be read as is. */
export const finish = async (state: string, code: string): Promise<{ userId: string; link: GoogleLink }> => {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.at > 10 * 60_000) throw new Error('This sign-in link expired. Start again from The Deck.');
  const j = await tokenCall({ code, code_verifier: p.verifier, grant_type: 'authorization_code', redirect_uri: REDIRECT });
  const claims = JSON.parse(Buffer.from(String(j.id_token ?? '').split('.')[1] ?? '', 'base64url').toString() || '{}');
  const email = String(claims.email ?? '').toLowerCase();
  if (!email || claims.email_verified === false) throw new Error('Google didn\'t share a verified email.');
  if (HD && claims.hd !== HD) throw new Error(`Use your ${HD} Google account.`);
  if (!j.refresh_token) throw new Error('Google didn\'t grant offline access. Try again.');
  access.set(p.userId, { token: String(j.access_token), exp: Date.now() + (Number(j.expires_in) - 60) * 1000 });
  return { userId: p.userId, link: { email, refresh: seal(String(j.refresh_token)), scopes: String(j.scope ?? '').split(' ').filter(Boolean) } };
};

/** A fresh access token. Throws with code 'invalid_grant' when the user revoked access. */
const token = async (userId: string, link: GoogleLink) => {
  const hit = access.get(userId);
  if (hit && hit.exp > Date.now()) return hit.token;
  const j = await tokenCall({ grant_type: 'refresh_token', refresh_token: open(link.refresh) });
  access.set(userId, { token: String(j.access_token), exp: Date.now() + (Number(j.expires_in) - 60) * 1000 });
  return String(j.access_token);
};

/** A new Meet room people in the host's domain join without "Ask to join". Returns its https://meet.google.com/… link. */
export const createSpace = async (userId: string, link: GoogleLink) => {
  const r = await fetch('https://meet.googleapis.com/v2/spaces', {
    method: 'POST',
    headers: { authorization: `Bearer ${await token(userId, link)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ config: { accessType: 'TRUSTED', entryPointAccess: 'ALL' } }),
  });
  const j = await r.json().catch(() => ({})) as { meetingUri?: string; error?: { message?: string } };
  if (!r.ok || !j.meetingUri) throw new Error(`meet spaces.create: ${r.status} ${j.error?.message ?? ''}`);
  return j.meetingUri;
};

/** Forget a user's grant on Google's side too (best effort). */
export const revoke = async (userId: string, link: GoogleLink) => {
  access.delete(userId);
  try { await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: open(link.refresh) }) }); }
  catch (e) { console.warn('google revoke failed', e); }
};
/** Your own events for a week from `from`, from your primary calendar. */
export const listEvents = async (userId: string, link: GoogleLink, from: Date): Promise<CalEvent[]> => {
  const q = new URLSearchParams({
    timeMin: from.toISOString(), timeMax: new Date(from.getTime() + 7 * 86_400_000).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '50',
  });
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { authorization: `Bearer ${await token(userId, link)}` } });
  const j = await r.json().catch(() => ({})) as { items?: GEvent[]; error?: { message?: string } };
  if (!r.ok) throw Object.assign(new Error(`calendar: ${r.status} ${j.error?.message ?? ''}`), { status: r.status });
  return (j.items ?? []).filter(e => e.status !== 'cancelled' && e.eventType !== 'workingLocation').map(e => ({
    id: String(e.id), title: e.summary || '(no title)', link: String(e.htmlLink ?? ''),
    start: e.start?.dateTime ?? e.start?.date ?? '', end: e.end?.dateTime ?? e.end?.date ?? '', allDay: !e.start?.dateTime,
    meet: e.hangoutLink, declined: e.attendees?.some(a => a.self && a.responseStatus === 'declined'),
  }));
};
interface GEvent {
  id?: string; status?: string; eventType?: string; summary?: string; htmlLink?: string; hangoutLink?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
}
export const forgetAccess = (userId: string) => access.delete(userId);
