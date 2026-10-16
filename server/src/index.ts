import { BannerStore, BannerError, BANNER_MAX_BYTES } from './banners';
import { createServer, type IncomingMessage } from 'node:http';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { reverse as dnsReverse } from 'node:dns/promises';
import { WebSocketServer } from 'ws';
import type { TileMap } from '../../shared/map';
import { FRAME_MAX_BYTES, PRESENT_MAX_BYTES, type ClientMsg, type DecksReply } from '../../shared/protocol';
import { USER_QUOTA } from './decks';
import { World } from './world';
import { LofiLive } from './lofi';
import { serveStatic } from './static';
import { cleanEmail, inCidr, nameFromEmail, netbirdUserEmail } from './auth';
import { startBots } from './bots';
import { startCreatures } from './creatures';
import { DECK_ID_RE, DeckStore, PresentError, Presenter } from './presentation';
import { finish as finishGoogle, googleEnabled, revoke as revokeGoogle } from './google';

const PORT = Number(process.env.DECK_PORT ?? 8787);
const TOKEN = process.env.DECK_TOKEN ?? 'deck'; // shared dev token
// NetBird SSO: the NetBird reverse proxy authenticates the user and sets X-NetBird-User.
// We trust that header ONLY from NETBIRD_TRUSTED_CIDR. Default trusts nobody (TEST-NET address).
const NETBIRD = process.env.NETBIRD_AUTH === 'true';
const TRUSTED_CIDRS = (process.env.NETBIRD_TRUSTED_CIDR ?? '192.0.2.1/32').split(',').map(s => s.trim()).filter(Boolean);
// Optional second gate: the caller's NetBird DNS name (reverse lookup) must match this, e.g.
// ^proxy-[a-z0-9]+-\d+-\d+\.nb\.t1a\.internal\.?$ — the proxy's IP changes on restart but its name pattern doesn't.
const TRUSTED_PEER = process.env.NETBIRD_TRUSTED_PEER ? new RegExp(process.env.NETBIRD_TRUSTED_PEER, 'i') : null;
// Name+token login: on by default in dev, off when NetBird is on unless explicitly allowed.
// Voice: browsers on NetBird usually connect directly; STUN helps otherwise, TURN (e.g. coturn) via DECK_ICE_SERVERS JSON.
const ICE_SERVERS = (() => {
  try { return process.env.DECK_ICE_SERVERS ? JSON.parse(process.env.DECK_ICE_SERVERS) : [{ urls: 'stun:stun.l.google.com:19302' }]; }
  catch { console.warn('bad DECK_ICE_SERVERS, using STUN only'); return [{ urls: 'stun:stun.l.google.com:19302' }]; }
})();
// OPEN_LOGIN: pick any name, no token. Only for instances already gated in front (e.g. a NetBird PIN on a
// public reverse proxy, where NetBird sign-in can't pass identity). Anyone past the gate can be any name.
const OPEN_LOGIN = process.env.OPEN_LOGIN === 'true';
// EMAIL_LOGIN: type your email, no confirmation; the user is found or created by that email (the demo instance).
// Anyone can claim any email, so such an instance must not list DECK_ADMINS / DECK_SYSADMINS someone could guess.
const EMAIL_LOGIN = process.env.EMAIL_LOGIN === 'true';
const TOKEN_LOGIN = OPEN_LOGIN || EMAIL_LOGIN || (process.env.TOKEN_LOGIN ? process.env.TOKEN_LOGIN === 'true' : !NETBIRD);
const DATA = new URL('../../data/', import.meta.url);
const STATE_FILE = new URL('state.json', DATA);

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const retroRoms: import('../../shared/retro/games').RetroGameId[] = ['tobu', 'lobster'];
const roms: Partial<Record<import('../../shared/retro/games').RetroGameId, Uint8Array>> = {};
for (const game of retroRoms) {
  try { roms[game] = readFileSync(new URL(`../../client/public/retro/${game === 'tobu' ? 'tobudx.gb' : 'shocklobster.gb'}`, import.meta.url)); }
  catch { /* Retro logs the missing ROM once and marks its cabinet broken. */ }
}
const world = new World(map, { roms, wasm: readFileSync(new URL('../../client/public/retro/binjgb.wasm', import.meta.url)) });
world.banners = new BannerStore(fileURLToPath(new URL('banners/', DATA)));
const DECKS_DIR = fileURLToPath(new URL('decks/', DATA));
world.present = new Presenter(new DeckStore(DECKS_DIR), map, {
  scopeOf: id => world.presentScopeOf(id),
  beside: (id, obj, settled) => world.isBeside(id, obj, settled),
  toScope: (scope, msg, except) => world.toScope(scope, msg, except),
  name: id => world.users.get(id)?.name ?? 'Someone',
});
// Expired decks go at startup and hourly (and any live show of one comes down).
const sweepDecks = () => world.present!.sweep().catch(e => console.warn('deck sweep failed:', e));
void sweepDecks();
setInterval(sweepDecks, 3600_000).unref();
const sessions = new Map<string, string>(); // session id -> user id

const BACKUPS = new URL('backups/', DATA);
// One copy a day (the first save of the day), the last BACKUP_DAYS kept. Snapshots from deploy.sh
// (state-predeploy-*) share the folder and are pruned by deploy.sh itself.
const BACKUP_DAYS = 7;
const backup = () => {
  try {
    if (!existsSync(STATE_FILE)) return;
    const file = `state-${new Date().toISOString().slice(0, 10)}.json`;
    mkdirSync(BACKUPS, { recursive: true });
    if (existsSync(new URL(file, BACKUPS))) return;
    copyFileSync(STATE_FILE, new URL(file, BACKUPS));
    const daily = readdirSync(BACKUPS).filter(f => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of daily.slice(0, -BACKUP_DAYS)) unlinkSync(new URL(f, BACKUPS));
  } catch (e) { console.warn('could not back up state:', e); }
};

if (existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    world.load(saved);
    for (const [s, u] of Object.entries(saved.sessions ?? {})) sessions.set(s, u as string);
    console.log(`loaded ${world.users.size} users`);
    backup();
  } catch (e) {
    // Keep running (an office that won't start is worse than an empty one), but move the file aside first so
    // the next save can't overwrite it. To restore: stop the service, copy this file or one from backups/ to
    // state.json, start it again.
    const bad = new URL(`state.json.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`, DATA);
    renameSync(STATE_FILE, bad);
    console.error(`could not load state, moved it to ${fileURLToPath(bad)}; starting empty (backups in ${fileURLToPath(BACKUPS)}):`, e);
  }
}
// Written only when something changed; the periodic save goes through the async fs so it never stalls the event loop.
let lastSaved = '';
const serialize = () => JSON.stringify({ ...world.dump(), sessions: Object.fromEntries(sessions) });
const save = () => {
  const json = serialize(); if (json === lastSaved) return;
  mkdirSync(DATA, { recursive: true });
  const tmp = new URL('state.json.tmp', DATA);
  writeFileSync(tmp, json); renameSync(tmp, STATE_FILE); lastSaved = json;
  backup();
};
let saving = false;
const saveAsync = async () => {
  if (saving) return;
  const json = serialize(); if (json === lastSaved) return;
  saving = true;
  try {
    await mkdir(DATA, { recursive: true });
    const tmp = new URL('state.json.tmp', DATA);
    await writeFile(tmp, json); await rename(tmp, STATE_FILE); lastSaved = json;
    backup();
  } catch (e) { console.warn('could not save state:', e); }
  finally { saving = false; }
};
setInterval(() => void saveAsync(), 30_000);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { world.retro.shutdown(); save(); process.exit(0); });

// Bots are opt-in (BOTS=1): npm run dev and the test instances set it, prod doesn't have it at all.
if (process.env.BOTS && process.env.BOTS !== '0') startBots(world, Number(process.env.BOT_COUNT ?? 4));
else for (const u of [...world.users.values()]) if (u.bot) world.users.delete(u.id); // bots saved before they were turned off
// The cat, the dog, the October bat and the cleaner run everywhere, prod included, unless PETS=0.
startCreatures(world.creatures, process.env.PETS !== '0', process.env.BAT === '1');

// ---------- macOS app (macos/dist, built by `macos/build.sh --dist` during deploy) ----------
// One-command install: curl -fsSL <base>/api/mac/install.sh | bash. curl doesn't quarantine what it
// downloads, so Gatekeeper never blocks the app. The instance's proxy (NetBird SSO / PIN) is the gate.
const MAC_DIR = fileURLToPath(new URL('../../macos/dist/', import.meta.url));
const MAC_ZIP = join(MAC_DIR, 'The-Deck.zip');
const macManifest = (() => {
  try {
    const m = JSON.parse(readFileSync(join(MAC_DIR, 'manifest.json'), 'utf8')) as { build: string; version: string; sha256: string; app?: string; bundleId?: string };
    const app = m.app ?? 'The Deck', bundleId = m.bundleId ?? 'io.t1a.deck';
    // these go into a shell script below: allow only what build.sh produces
    return /^[\w .()-]+$/.test(app) && /^[\w.-]+$/.test(bundleId) && /^[0-9a-f]{64}$/.test(m.sha256) ? { ...m, app, bundleId } : null;
  } catch { return null; }
})();
const PUBLIC_URL = process.env.DECK_PUBLIC_URL;   // where the app should open (the instance's public URL)
const INSTALL_URL = process.env.DECK_INSTALL_URL; // where curl can reach us (PIN instances: the NetBird address)
/** The origin this request came in on (behind the proxy: its forwarded proto/host). */
const originOf = (req: IncomingMessage) => {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() === 'https' ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  return /^[\w.-]+(:\d+)?$/.test(host) ? `${proto}://${host}` : null; // also keeps the shell script below safe
};
const installScript = (base: string, appUrl: string, m: { sha256: string; app: string; bundleId: string }) => `#!/bin/bash
# Installs ${m.app} for macOS. Served by ${base}
set -euo pipefail
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
echo "→ Downloading ${m.app}…"
curl -fsSL '${base}/api/mac/The-Deck.zip' -o "$tmp/The-Deck.zip"
echo '${m.sha256}  '"$tmp/The-Deck.zip" | shasum -a 256 -c - >/dev/null || { echo "Download is corrupted, try again." >&2; exit 1; }
ditto -x -k "$tmp/The-Deck.zip" "$tmp"
dest=/Applications; [ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
pkill -f '/${m.app.replace(/[().]/g, '\\$&')}.app/Contents/MacOS/Deck' 2>/dev/null && sleep 1 || true # only this instance's app
rm -rf "$dest/${m.app}.app"
ditto "$tmp/${m.app}.app" "$dest/${m.app}.app"
defaults write ${m.bundleId} url '${appUrl}'
open "$dest/${m.app}.app"
echo "✓ ${m.app} is installed in $dest and running in your menu bar (the little person)."
`;

// ---------- static client (production: client/dist) ----------
const STATIC_DIR = fileURLToPath(new URL('../../client/dist/', import.meta.url));
const STATIC = existsSync(join(STATIC_DIR, 'index.html'));
// index.html names the hashed bundles, so its hash changes whenever the client does.
if (STATIC) world.build = createHash('sha1').update(readFileSync(join(STATIC_DIR, 'index.html'))).digest('hex').slice(0, 12);
// ---------- NetBird trust gate ----------
const peerCache = new Map<string, { ok: boolean; at: number }>();
const isProxyPeer = async (ip: string) => {
  if (!TRUSTED_PEER) return true;
  const hit = peerCache.get(ip);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  const v4 = ip.replace(/^::ffff:/, '').split('.');
  const names = await dnsReverse(ip.replace(/^::ffff:/, '')).catch(() => [] as string[]);
  // the proxy's name ends in its own last two IP octets: proxy-<id>-131-36.nb.t1a.internal
  const ok = names.some(n => TRUSTED_PEER.test(n) && n.includes(`-${v4[2]}-${v4[3]}.`));
  if (!ok) console.warn(`netbird: untrusted caller ${ip} (${names.join(',') || 'no PTR'})`);
  peerCache.set(ip, { ok, at: Date.now() });
  return ok;
};
/** The NetBird-authenticated email for this request, or null if it didn't come through the trusted proxy. */
const netbirdEmail = async (req: IncomingMessage): Promise<string | null> => {
  if (!NETBIRD) return null;
  const src = req.socket.remoteAddress ?? '';
  if (!TRUSTED_CIDRS.some(c => inCidr(src, c))) return null;
  if (!(await isProxyPeer(src))) return null;
  return netbirdUserEmail(req.headers['x-netbird-user']);
};
/** Sign in by email (NetBird or typed): find or create that person, with the name the email gives. */
const emailUser = (email: string) => {
  const user = world.findByEmail(email) ?? world.addUser(nameFromEmail(email), false, undefined, email);
  if (!user.nameSet && user.name !== nameFromEmail(email)) user.name = nameFromEmail(email);
  return user;
};
/** The name an email sign-in shows: a name the person set themselves wins. */
const emailName = (email: string) => { const u = world.findByEmail(email); return u?.nameSet ? u.name : nameFromEmail(email); };

const newSession = (userId: string) => { const s = randomUUID(); sessions.set(s, userId); return s; };

const lofiLive = new LofiLive();

// ---------- REST ----------
const json = (res: import('node:http').ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body));
};
const server = createServer((req, res) => {
  route(req, res).catch(e => { // a bug in one route answers 500 instead of taking the process down
    console.warn(`${req.method} ${req.url} failed:`, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' }); else res.destroy();
  });
});
async function route(req: IncomingMessage, res: import('node:http').ServerResponse) {
  if (req.method === 'GET' && req.url === '/api/lofi') return json(res, 200, await lofiLive.get());
  if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true, users: world.users.size });
  if (req.method === 'GET' && req.url === '/api/config') return json(res, 200, { netbird: NETBIRD, tokenLogin: TOKEN_LOGIN, tokenRequired: !OPEN_LOGIN && !EMAIL_LOGIN, emailLogin: EMAIL_LOGIN, iceServers: ICE_SERVERS });
  // Two-step NetBird login: GET only says who you are (so logout doesn't bounce you back in), POST signs in.
  if (req.url === '/api/auth/netbird' && (req.method === 'GET' || req.method === 'POST')) {
    const email = await netbirdEmail(req);
    if (!email) return json(res, 404, { error: 'not signed in via NetBird' });
    if (req.method === 'GET') return json(res, 200, { email, name: emailName(email) });
    const user = emailUser(email);
    return json(res, 200, { session: newSession(user.id), userId: user.id });
  }
  if (req.method === 'POST' && req.url?.startsWith('/api/logout')) {
    const s = new URL(req.url, 'http://x').searchParams.get('session');
    if (s) sessions.delete(s);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/api/login') {
    if (!TOKEN_LOGIN) return json(res, 403, { error: 'password login disabled — use NetBird' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, token, email } = JSON.parse(body || '{}');
        if (EMAIL_LOGIN) {
          const clean = cleanEmail(email);
          if (!clean) return json(res, 400, { error: 'that doesn’t look like an email' });
          const user = emailUser(clean);
          return json(res, 200, { session: newSession(user.id), userId: user.id });
        }
        if (!OPEN_LOGIN && token !== TOKEN) return json(res, 401, { error: 'bad token' });
        const clean = String(name ?? '').trim().slice(0, 24);
        if (!clean) return json(res, 400, { error: 'name required' });
        const existing = world.findByName(clean);
        if (existing?.bot) return json(res, 409, { error: 'that name belongs to a bot' });
        const user = existing ?? world.addUser(clean);
        json(res, 200, { session: newSession(user.id), userId: user.id });
      } catch { json(res, 400, { error: 'bad json' }); }
    });
    return;
  }
  // Connect Google: Google sends the browser back here. `state` says who started it (no cookie needed), so this
  // also works when the Mac app opened the sign-in in the system browser; the app's page hears about it over its socket.
  if (req.method === 'GET' && req.url?.startsWith('/api/google/callback')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const page = (title: string, text: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      const esc = (t: string) => t.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
      res.end(`<!doctype html><meta name=viewport content="width=device-width"><title>The Deck</title><body style="font:16px system-ui;max-width:28em;margin:20vh auto;padding:0 16px;text-align:center"><h2>${esc(title)}</h2><p>${esc(text)}</p>`);
    };
    if (!googleEnabled) return page('Google isn\'t set up here', 'This instance has no Google sign-in.');
    if (q.get('error')) return page('Not connected', q.get('error') === 'access_denied' ? 'You cancelled. Nothing changed.' : `Google said: ${q.get('error')}`);
    try {
      const { userId, link } = await finishGoogle(q.get('state') ?? '', q.get('code') ?? '');
      const user = world.users.get(userId);
      if (!user) throw new Error('Unknown Deck user.');
      // signed in through NetBird: the Google account must be the same person
      if (user.email && user.email !== link.email) {
        void revokeGoogle(userId, link);
        throw new Error(`You're ${user.email} in The Deck. Pick that Google account.`);
      }
      world.setGoogle(user, link);
      return page(`Connected as ${link.email}`, 'Calls you start now get their own Meet room. You can close this tab.');
    } catch (e) { return page('Not connected', (e as Error).message); }
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && req.url?.startsWith('/banners/')) {
    return world.banners!.serve(req.url.slice(9), req, res);
  }
  if (req.method === 'POST' && req.url === '/api/banner') {
    const userId = sessions.get(String(req.headers['x-deck-session'] ?? ''));
    const user = userId && world.users.get(userId);
    if (!user) return json(res, 401, { error: 'sign in first' });
    try { world.beginBannerUpload(user.id); }
    catch (e) { return json(res, (e as BannerError).code, { error: (e as Error).message }); }
    const chunks: Buffer[] = []; let size = 0, tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BANNER_MAX_BYTES) { tooBig = true; chunks.length = 0; }
      else if (!tooBig) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return json(res, 413, { error: 'Image must be at most 1 MB.' });
      try { const banner = world.uploadBanner(user, Buffer.concat(chunks)); json(res, 200, { ok: true, banner }); }
      catch (e) {
        if (e instanceof BannerError) return json(res, e.code, { error: e.message });
        console.warn('banner upload failed:', e);
        json(res, 500, { error: 'Upload failed.' });
      }
    });
    return;
  }
  // ---------- presentation mode ----------
  const present = world.present!, store = present.store;
  const slide = req.method === 'GET' ? req.url?.match(/^\/api\/present\/([0-9a-f-]{36})\/(\d{1,3})\.(png|jpg)\?k=([A-Za-z0-9_-]{8,32})$/) : null;
  if (slide) { // the key in the URL is the only credential: viewers' <img> tags can't send the session header
    const deck = store.get(slide[1]), n = Number(slide[2]);
    if (!deck || !DECK_ID_RE.test(deck.id) || n < 1 || n > deck.count || deck.ext[n - 1] !== slide[3] || deck.key !== slide[4]) return json(res, 404, { error: 'not found' });
    const file = store.slidePath(deck, n);
    res.writeHead(200, { 'content-type': slide[3] === 'png' ? 'image/png' : 'image/jpeg', 'content-length': statSync(file).size, 'cache-control': 'private, max-age=31536000, immutable' });
    return createReadStream(file).pipe(res);
  }
  if (req.url?.startsWith('/api/present/')) {
    const userId = sessions.get(String(req.headers['x-deck-session'] ?? ''));
    if (!userId || !world.users.has(userId)) return json(res, 401, { error: 'sign in first' });
    if (req.method === 'GET' && req.url === '/api/present/decks') {
      const reply: DecksReply = { decks: store.list(userId), used: store.used(userId), limit: USER_QUOTA };
      return json(res, 200, reply);
    }
    const del = req.method === 'DELETE' ? req.url.match(/^\/api\/present\/([0-9a-f-]{36})$/) : null;
    if (del) {
      return present.remove(userId, del[1]).then(() => json(res, 200, {}), e => json(res, e instanceof PresentError ? e.code : 400, { error: e instanceof PresentError ? e.message : 'Delete failed.' }));
    }
    if (req.method !== 'POST' || !['/api/present/upload', '/api/present/start'].includes(req.url)) return json(res, 404, { error: 'not found' });
    const chunks: Buffer[] = []; let size = 0, tooBig = false;
    req.on('data', (c: Buffer) => { size += c.length; if (size > PRESENT_MAX_BYTES * 1.4) tooBig = true; else chunks.push(c); });
    req.on('end', async () => {
      if (tooBig) return json(res, 413, { error: `Too big: ${Math.round(PRESENT_MAX_BYTES / 1024 / 1024)} MB at most.` });
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const deck = req.url === '/api/present/upload' ? await world.present!.upload(userId, body) : world.present!.present(userId, body);
        json(res, 200, { deck });
      } catch (e) {
        if (e instanceof PresentError) return json(res, e.code, { error: e.message, ...e.extra });
        console.warn('presentation upload failed:', e);
        json(res, 400, { error: 'Upload failed.' });
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/mac')) {
    const origin = originOf(req);
    if (!macManifest || !origin) return json(res, 404, { error: 'no mac app on this instance' });
    if (req.url === '/api/mac') return json(res, 200, { ...macManifest, install: `curl -fsSL ${INSTALL_URL ?? origin}/api/mac/install.sh | bash` });
    if (req.url === '/api/mac/install.sh') {
      res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(installScript(origin, PUBLIC_URL ?? origin, macManifest));
    }
    if (req.url === '/api/mac/The-Deck.zip' && existsSync(MAC_ZIP)) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': statSync(MAC_ZIP).size, 'cache-control': 'no-store' });
      return createReadStream(MAC_ZIP).pipe(res);
    }
    return json(res, 404, { error: 'not found' });
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && STATIC) return serveStatic(STATIC_DIR, req, res);
  json(res, 404, { error: 'not found' });
}

// ---------- WebSocket ----------
// The biggest thing a client sends is one screen-share frame (base64); ws would otherwise accept 100 MiB per message.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: Math.ceil(FRAME_MAX_BYTES * 4 / 3) + 64 * 1024 });
wss.on('connection', (ws, req) => {
  const session = new URL(req.url ?? '', 'http://x').searchParams.get('session') ?? '';
  const userId = sessions.get(session);
  const user = userId ? world.users.get(userId) : undefined;
  if (!user) { ws.close(4001, 'unauthorized'); return; }
  if (user.email && !user.nameSet && user.name !== nameFromEmail(user.email)) user.name = nameFromEmail(user.email); // sessions outlive sign-in: bring old "Ivan Baranov" names to the current rule
  const { socket, close } = world.connect(user.id,
    msg => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
    json => { if (ws.readyState === ws.OPEN) ws.send(json); });
  ws.on('message', raw => {
    try {
      const msg: unknown = JSON.parse(String(raw));
      if (msg && typeof msg === 'object' && 't' in msg && typeof msg.t === 'string') world.handle(user, msg as ClientMsg, socket);
    } catch (e) { console.warn('bad message', e); }
  });
  ws.on('close', close);
});

server.listen(PORT, process.env.DECK_HOST ?? '0.0.0.0', () => console.log(
  `The Deck server on :${PORT} · netbird=${NETBIRD} trusted=${TRUSTED_CIDRS.join(',')}${TRUSTED_PEER ? ` peer~${TRUSTED_PEER.source}` : ''} · ${EMAIL_LOGIN ? 'email login (unconfirmed)' : OPEN_LOGIN ? 'open login (name only)' : `token login=${TOKEN_LOGIN}${TOKEN_LOGIN ? ` (${TOKEN === 'deck' ? 'deck' : '***'})` : ''}`}`));
