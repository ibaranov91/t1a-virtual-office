import { createServer, type IncomingMessage } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { reverse as dnsReverse } from 'node:dns/promises';
import { WebSocketServer } from 'ws';
import type { TileMap } from '../../shared/map';
import type { ClientMsg } from '../../shared/protocol';
import { World } from './world';
import { startBots } from './bots';

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
const TOKEN_LOGIN = OPEN_LOGIN || (process.env.TOKEN_LOGIN ? process.env.TOKEN_LOGIN === 'true' : !NETBIRD);
const DATA = new URL('../../data/', import.meta.url);
const STATE_FILE = new URL('state.json', DATA);

const map: TileMap = JSON.parse(readFileSync(new URL('../../shared/tilemap.json', import.meta.url), 'utf8'));
const world = new World(map);
const sessions = new Map<string, string>(); // session id -> user id

if (existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    world.load(saved);
    for (const [s, u] of Object.entries(saved.sessions ?? {})) sessions.set(s, u as string);
    console.log(`loaded ${world.users.size} users`);
  } catch (e) { console.warn('could not load state:', e); }
}
const save = () => {
  mkdirSync(DATA, { recursive: true });
  const tmp = new URL('state.json.tmp', DATA);
  writeFileSync(tmp, JSON.stringify({ ...world.dump(), sessions: Object.fromEntries(sessions) }, null, 1));
  renameSync(tmp, STATE_FILE);
};
setInterval(save, 30_000);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { save(); process.exit(0); });

// Bots are opt-in (BOTS=1): npm run dev and the test instances set it, prod doesn't have it at all.
if (process.env.BOTS && process.env.BOTS !== '0') startBots(world, Number(process.env.BOT_COUNT ?? 4));
else for (const u of [...world.users.values()]) if (u.bot) world.users.delete(u.id); // bots saved before they were turned off

// ---------- macOS app (macos/dist, built by `macos/build.sh --dist` during deploy) ----------
// One-command install: curl -fsSL <base>/api/mac/install.sh | bash. curl doesn't quarantine what it
// downloads, so Gatekeeper never blocks the app. The instance's proxy (NetBird SSO / PIN) is the gate.
const MAC_DIR = fileURLToPath(new URL('../../macos/dist/', import.meta.url));
const MAC_ZIP = join(MAC_DIR, 'The-Deck.zip');
const macManifest = (() => {
  try { return JSON.parse(readFileSync(join(MAC_DIR, 'manifest.json'), 'utf8')) as { build: string; version: string; sha256: string }; }
  catch { return null; }
})();
const PUBLIC_URL = process.env.DECK_PUBLIC_URL;   // where the app should open (the instance's public URL)
const INSTALL_URL = process.env.DECK_INSTALL_URL; // where curl can reach us (PIN instances: the NetBird address)
/** The origin this request came in on (behind the proxy: its forwarded proto/host). */
const originOf = (req: IncomingMessage) => {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() === 'https' ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  return /^[\w.-]+(:\d+)?$/.test(host) ? `${proto}://${host}` : null; // also keeps the shell script below safe
};
const installScript = (base: string, appUrl: string, sha: string) => `#!/bin/bash
# Installs The Deck for macOS. Served by ${base}
set -euo pipefail
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
echo "→ Downloading The Deck…"
curl -fsSL '${base}/api/mac/The-Deck.zip' -o "$tmp/The-Deck.zip"
echo '${sha}  '"$tmp/The-Deck.zip" | shasum -a 256 -c - >/dev/null || { echo "Download is corrupted, try again." >&2; exit 1; }
ditto -x -k "$tmp/The-Deck.zip" "$tmp"
dest=/Applications; [ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
pkill -x Deck 2>/dev/null && sleep 1 || true
rm -rf "$dest/The Deck.app"
ditto "$tmp/The Deck.app" "$dest/The Deck.app"
defaults write io.t1a.deck url '${appUrl}'
open "$dest/The Deck.app"
echo "✓ The Deck is installed in $dest and running in your menu bar (the little person)."
`;

// ---------- static client (production: client/dist) ----------
const STATIC_DIR = fileURLToPath(new URL('../../client/dist/', import.meta.url));
const STATIC = existsSync(join(STATIC_DIR, 'index.html'));
// index.html names the hashed bundles, so its hash changes whenever the client does.
if (STATIC) world.build = createHash('sha1').update(readFileSync(join(STATIC_DIR, 'index.html'))).digest('hex').slice(0, 12);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const serveStatic = (url: string, res: import('node:http').ServerResponse) => {
  const rel = normalize(decodeURIComponent(url.split('?')[0])).replace(/^([/\\]|\.\.)+/, '');
  let file = join(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, 'index.html');
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': file.includes('/assets/') && /-[\w-]{8}\./.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
};

// ---------- NetBird trust gate ----------
const ip4 = (ip: string) => {
  const m = ip.replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return m ? ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0 : null;
};
const inCidr = (ip: string, cidr: string) => {
  const [base, bits = '32'] = cidr.split('/');
  const a = ip4(ip), b = ip4(base), n = Number(bits);
  if (a === null || b === null || !(n >= 0 && n <= 32)) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return (a & mask) === (b & mask);
};
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
  const raw = req.headers['x-netbird-user'];
  const email = (Array.isArray(raw) ? raw[0] : raw ?? '').trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email) ? email : null;
};
/** "ivan.baranov@t1a.com" -> "Ivan Baranov" */
const nameFromEmail = (email: string) =>
  email.split('@')[0].split(/[._+-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 24) || email;

const newSession = (userId: string) => { const s = randomUUID(); sessions.set(s, userId); return s; };

// ---------- REST ----------
const json = (res: import('node:http').ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body));
};
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true, users: world.users.size });
  if (req.method === 'GET' && req.url === '/api/config') return json(res, 200, { netbird: NETBIRD, tokenLogin: TOKEN_LOGIN, tokenRequired: !OPEN_LOGIN, iceServers: ICE_SERVERS });
  // Two-step NetBird login: GET only says who you are (so logout doesn't bounce you back in), POST signs in.
  if (req.url === '/api/auth/netbird' && (req.method === 'GET' || req.method === 'POST')) {
    const email = await netbirdEmail(req);
    if (!email) return json(res, 404, { error: 'not signed in via NetBird' });
    if (req.method === 'GET') return json(res, 200, { email, name: world.findByEmail(email)?.name ?? nameFromEmail(email) });
    const user = world.findByEmail(email) ?? world.addUser(nameFromEmail(email), false, undefined, email);
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
        const { name, token } = JSON.parse(body || '{}');
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
  if (req.method === 'GET' && req.url?.startsWith('/api/mac')) {
    const origin = originOf(req);
    if (!macManifest || !origin) return json(res, 404, { error: 'no mac app on this instance' });
    if (req.url === '/api/mac') return json(res, 200, { ...macManifest, install: `curl -fsSL ${INSTALL_URL ?? origin}/api/mac/install.sh | bash` });
    if (req.url === '/api/mac/install.sh') {
      res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(installScript(origin, PUBLIC_URL ?? origin, macManifest.sha256));
    }
    if (req.url === '/api/mac/The-Deck.zip' && existsSync(MAC_ZIP)) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': statSync(MAC_ZIP).size, 'cache-control': 'no-store' });
      return createReadStream(MAC_ZIP).pipe(res);
    }
    return json(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && STATIC) return serveStatic(req.url ?? '/', res);
  json(res, 404, { error: 'not found' });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const session = new URL(req.url ?? '', 'http://x').searchParams.get('session') ?? '';
  const userId = sessions.get(session);
  const user = userId ? world.users.get(userId) : undefined;
  if (!user) { ws.close(4001, 'unauthorized'); return; }
  const disconnect = world.connect(user.id, msg => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); });
  ws.on('message', raw => {
    try { world.handle(user, JSON.parse(String(raw)) as ClientMsg); } catch (e) { console.warn('bad message', e); }
  });
  ws.on('close', disconnect);
});

server.listen(PORT, process.env.DECK_HOST ?? '0.0.0.0', () => console.log(
  `The Deck server on :${PORT} · netbird=${NETBIRD} trusted=${TRUSTED_CIDRS.join(',')}${TRUSTED_PEER ? ` peer~${TRUSTED_PEER.source}` : ''} · ${OPEN_LOGIN ? 'open login (name only)' : `token login=${TOKEN_LOGIN}${TOKEN_LOGIN ? ` (${TOKEN === 'deck' ? 'deck' : '***'})` : ''}`}`));
