import { createServer, type IncomingMessage } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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
const TOKEN_LOGIN = process.env.TOKEN_LOGIN ? process.env.TOKEN_LOGIN === 'true' : !NETBIRD;
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

if (process.env.BOTS !== '0') startBots(world, Number(process.env.BOT_COUNT ?? 4));

// ---------- static client (production: client/dist) ----------
const STATIC_DIR = fileURLToPath(new URL('../../client/dist/', import.meta.url));
const STATIC = existsSync(join(STATIC_DIR, 'index.html'));
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
  if (req.method === 'GET' && req.url === '/api/config') return json(res, 200, { netbird: NETBIRD, tokenLogin: TOKEN_LOGIN, iceServers: ICE_SERVERS });
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
        if (token !== TOKEN) return json(res, 401, { error: 'bad token' });
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
  `The Deck server on :${PORT} · netbird=${NETBIRD} trusted=${TRUSTED_CIDRS.join(',')}${TRUSTED_PEER ? ` peer~${TRUSTED_PEER.source}` : ''} · token login=${TOKEN_LOGIN}${TOKEN_LOGIN ? ` (${TOKEN === 'deck' ? 'deck' : '***'})` : ''}`));
