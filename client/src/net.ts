// WebSocket client + the client-side mirror of server state.
import mapJson from '../../shared/tilemap.json';
import { findPath, roomAt, sampleMove, type Dir, type Tile, type TileMap } from '../../shared/map';
import type { ClientMsg, PublicUser, ServerMsg } from '../../shared/protocol';

export const MAP = mapJson as unknown as TileMap;

export interface ClientUser extends PublicUser {
  path: Tile[] | null;
  prev: { path: Tile[]; startedAt: number } | null; // walk in progress when a new move was issued
  faceOverride: Dir | null;
}

export interface Toast {
  id: number; kind: 'knock_in' | 'info' | 'link';
  text: string; link?: string; knockId?: string; expires?: number;
}

export interface Pose { x: number; y: number; dir: Dir; walking: boolean; tile: Tile }

type Listener = () => void;

export class Store {
  users = new Map<string, ClientUser>();
  me = '';
  offset = 0; // serverTime - localTime
  toasts: Toast[] = [];
  connected = false;
  version = 0;
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private toastSeq = 0;
  private closed = false;

  constructor(private session: string, private onUnauthorized: () => void) {}

  now() { return Date.now() + this.offset; }
  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;
  private emit() { this.version++; for (const l of this.listeners) l(); }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(this.session)}`);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.emit(); };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      this.connected = false; this.emit();
      if (e.code === 4001) return this.onUnauthorized();
      if (!this.closed) setTimeout(() => this.connect(), 1500);
    };
  }
  close() { this.closed = true; this.ws?.close(); }
  send(msg: ClientMsg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  // ---------- actions ----------
  moveTo(to: Tile) { this.send({ t: 'move', to }); }
  knock(targetId: string) { this.send({ t: 'knock', targetId }); }
  replyKnock(knockId: string, reply: 'accept' | 'later') {
    this.send({ t: 'knock_reply', knockId, reply });
    this.dismiss(this.toasts.find(t => t.knockId === knockId)?.id ?? -1);
  }
  setStatus(status: string) { this.send({ t: 'status', status }); }
  setPresence(presence: 'online' | 'away' | 'in_call') { this.send({ t: 'presence', presence }); }

  toast(t: Omit<Toast, 'id'>) {
    const toast = { ...t, id: ++this.toastSeq };
    this.toasts = [...this.toasts, toast].slice(-4);
    if (t.expires) setTimeout(() => this.dismiss(toast.id), t.expires);
    this.emit();
  }
  dismiss(id: number) { this.toasts = this.toasts.filter(t => t.id !== id); this.emit(); }

  // ---------- state ----------
  private applyMove(u: ClientUser, m: { from: Tile; to: Tile; startedAt: number; path?: Tile[]; face?: Dir }) {
    const path = m.path ?? findPath(MAP, m.from, m.to);
    const t = this.now();
    if (u.move && u.path && t < m.startedAt) u.prev = { path: u.path, startedAt: u.move.startedAt };
    else u.prev = null;
    u.move = { from: m.from, to: m.to, startedAt: m.startedAt, face: m.face };
    u.path = path.length ? path : [m.to];
    u.tile = m.to;
    u.faceOverride = null;
  }

  pose(u: ClientUser, t = this.now()): Pose {
    if (u.move && u.path) {
      const usePrev = u.prev && t < u.move.startedAt;
      const s = usePrev ? sampleMove(u.prev!.path, u.prev!.startedAt, t) : sampleMove(u.path, u.move.startedAt, t);
      if (s) {
        const walking = usePrev ? true : !s.done;
        const dir = !walking ? (u.faceOverride ?? u.move.face ?? s.dir) : s.dir;
        return { x: s.x, y: s.y, dir, walking, tile: s.tile };
      }
    }
    return { x: u.tile.x, y: u.tile.y, dir: u.faceOverride ?? u.dir, walking: false, tile: u.tile };
  }
  roomOf(u: ClientUser) { const p = this.pose(u); return roomAt(MAP, p.tile.x, p.tile.y); }
  name(id: string) { return this.users.get(id)?.name ?? 'someone'; }

  private onMessage(msg: ServerMsg) {
    switch (msg.t) {
      case 'hello':
        this.me = msg.you; this.offset = msg.serverTime - Date.now(); break;
      case 'state': {
        this.offset = msg.serverTime - Date.now();
        const next = new Map<string, ClientUser>();
        for (const p of msg.users) {
          const old = this.users.get(p.id);
          const u: ClientUser = { ...p, path: old?.path ?? null, prev: old?.prev ?? null, faceOverride: old?.faceOverride ?? null };
          if (p.move && (!old?.move || old.move.startedAt !== p.move.startedAt)) { u.move = null; this.applyMove(u, p.move); }
          next.set(p.id, u);
        }
        this.users = next; break;
      }
      case 'move': { const u = this.users.get(msg.userId); if (u) this.applyMove(u, msg); break; }
      case 'status': { const u = this.users.get(msg.userId); if (u) u.status = msg.status; break; }
      case 'presence': { const u = this.users.get(msg.userId); if (u) u.presence = msg.presence; break; }
      case 'emote': { const u = this.users.get(msg.userId); if (u) u.emote = msg.emote; break; }
      case 'door': { const u = this.users.get(msg.userId); if (u) u.door = msg.door; break; }
      case 'knock': {
        const from = this.users.get(msg.fromId), to = this.users.get(msg.toId);
        if (from && to) { // knocker turns to face the person
          const a = this.pose(from).tile, b = this.pose(to).tile;
          from.faceOverride = b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : 'up';
        }
        if (msg.toId === this.me) this.toast({ kind: 'knock_in', knockId: msg.knockId, text: `${this.name(msg.fromId)} is knocking` });
        else if (msg.fromId === this.me) this.toast({ kind: 'info', text: `Knocked on ${this.name(msg.toId)}…`, expires: 4000 });
        break;
      }
      case 'knock_reply': {
        const mine = msg.fromId === this.me, forMe = msg.toId === this.me;
        if (forMe) this.toasts = this.toasts.filter(t => t.knockId !== msg.knockId);
        if (!mine && !forMe) break;
        const other = this.name(mine ? msg.toId : msg.fromId);
        if (msg.reply === 'accept') this.toast({ kind: 'link', text: `Meeting with ${other}`, link: msg.link, expires: 30000 });
        else if (mine) this.toast({ kind: 'info', text: msg.reason ?? `${other} said later`, expires: 5000 });
        else if (forMe && msg.reason) this.toast({ kind: 'info', text: `Missed a knock from ${other}`, expires: 5000 });
        break;
      }
    }
    this.emit();
  }
}
