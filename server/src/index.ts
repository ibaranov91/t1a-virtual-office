import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { TileMap } from '../../shared/map';
import type { ClientMsg } from '../../shared/protocol';
import { World } from './world';
import { startBots } from './bots';

const PORT = Number(process.env.DECK_PORT ?? 8787);
const TOKEN = process.env.DECK_TOKEN ?? 'deck'; // shared prototype token; Entra ID later
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

if (process.env.BOTS !== '0') startBots(world);

// ---------- REST ----------
const json = (res: import('node:http').ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
};
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true, users: world.users.size });
  if (req.method === 'POST' && req.url === '/api/login') {
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
        const session = randomUUID();
        sessions.set(session, user.id);
        json(res, 200, { session, userId: user.id });
      } catch { json(res, 400, { error: 'bad json' }); }
    });
    return;
  }
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

server.listen(PORT, () => console.log(`The Deck server on http://localhost:${PORT} (token: ${TOKEN === 'deck' ? 'deck' : '***'})`));
