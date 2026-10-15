// WebSocket client + the client-side mirror of server state.
import mapJson from '../../shared/tilemap.json';
import { besideObject, pathTo, roomAt, sampleMove, type Dir, type Tile, type TileMap } from '../../shared/map';
import { ROOM_VOICE_MAX, type ChatMsg, type ObjectState, type ClientMsg, type PublicUser, type Reaction, type RtcSignal, type ServerMsg } from '../../shared/protocol';
import { playHand, playKnock, playPop } from './sounds';
import type { Soundscape } from './soundscape';

export const MAP = mapJson as unknown as TileMap;

export interface ClientUser extends PublicUser {
  path: Tile[] | null;
  prev: { path: Tile[]; startedAt: number } | null; // walk in progress when a new move was issued
  faceOverride: Dir | null;
  speaking?: boolean; // live mic activity in a voice call (client-only)
}

export interface Toast {
  // knock_out: my knock is waiting (Cancel); knock_again: it didn't land, or I missed one (Knock again / back)
  id: number; kind: 'knock_in' | 'knock_out' | 'knock_again' | 'chat' | 'info' | 'link';
  text: string; link?: string; knockId?: string; expires?: number; hint?: string;
  userId?: string; // the other person, for knock_again and chat
}

/** A reaction in flight, timed with performance.now() like the render loop. */
export interface Flying { fromId: string; toId: string; emoji: string; at: number }

/** Item id -> what it looks like, from whatever the map's objects hand out. */
export const ITEMS = new Map(MAP.objects.flatMap(o => (o.use?.kind === 'take' ? o.use.items : [])).map(i => [i.id, i]));

export interface Pose { x: number; y: number; dir: Dir; walking: boolean; tile: Tile }

type Listener = () => void;

export class Store {
  users = new Map<string, ClientUser>();
  me = '';
  offset = 0; // serverTime - localTime
  toasts: Toast[] = [];
  connected = false;
  voiceOwner = false;
  voiceWait: string | null = null;
  voiceFocus: string | null = null;
  voiceFocusSeq = 0;
  soundscape?: Soundscape;
  meetLink: string | null = null; // null = not loaded yet, '' = not set
  build: string | undefined;  // the server's client build when this page loaded
  staleBuild = false;         // server now serves a newer build; reload when not in a call
  objects: Record<string, ObjectState> = {};
  chats = new Map<string, ChatMsg[]>(); // by the other person's id
  unread = new Map<string, number>();
  chatWith: string | null = null;       // open conversation
  reactions: Flying[] = [];             // the engine draws and prunes these
  objectFx: { objectId: string; at: number }[] = []; // someone just used it (coffee steam)
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
  /** Re-render after state that lives outside the store changed (e.g. voice). */
  changed() { this.emit(); }
  onRtc?: (from: string, signal: RtcSignal) => void;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(this.session)}`);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.emit(); };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      this.connected = false; this.voiceOwner = false; this.emit();
      if (e.code === 4001) return this.onUnauthorized();
      if (!this.closed) setTimeout(() => this.connect(), 1500);
    };
  }
  close() { this.closed = true; this.connected = false; this.voiceOwner = false; this.emit(); this.ws?.close(); }
  send(msg: ClientMsg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  // ---------- actions ----------
  moveTo(to: Tile) { this.send({ t: 'move', to }); }
  knock(targetId: string) { this.send({ t: 'knock', targetId }); }
  /** Knock, but first walk the user through setting up their Meet room if they have none. */
  pendingKnock: string | null = null;
  meetSetupSkipped = false; // "knock without a room" — don't nag again this session
  requestKnock(targetId: string) {
    const u = this.users.get(targetId);
    if (u && this.sameRoomCall(u)) this.focusVoice(targetId);
    else this.knock(targetId);
  }
  finishKnockSetup(action: 'saved' | 'skip' | 'cancel') {
    const id = this.pendingKnock; this.pendingKnock = null;
    if (action === 'skip') this.meetSetupSkipped = true;
    if (id && action !== 'cancel') this.knock(id); // after meet_link on the same socket, so the server has it
    this.emit();
  }
  cancelKnock(knockId: string) {
    this.send({ t: 'knock_cancel', knockId });
    this.toasts = this.toasts.filter(t => t.knockId !== knockId); this.emit();
  }
  follow(targetId: string | null) { this.send({ t: 'follow', targetId }); }
  react(targetId: string, emoji: Reaction) { this.send({ t: 'react', targetId, emoji }); }
  use(objectId: string, item?: string) { this.send({ t: 'use', objectId, item }); }
  drop() { this.send({ t: 'drop' }); }
  give(targetId: string) { this.send({ t: 'give', targetId }); }
  openChat(withId: string) {
    this.chatWith = withId; this.unread.delete(withId);
    this.toasts = this.toasts.filter(t => !(t.kind === 'chat' && t.userId === withId));
    this.send({ t: 'chat_history', withId });
    this.emit();
  }
  closeChat() { this.chatWith = null; this.emit(); }
  sendChat(toId: string, text: string) { if (text.trim()) this.send({ t: 'chat', toId, text }); }
  replyKnock(knockId: string, reply: 'accept' | 'later') {
    this.send({ t: 'knock_reply', knockId, reply });
    this.dismiss(this.toasts.find(t => t.knockId === knockId)?.id ?? -1);
  }
  setStatus(status: string) { this.send({ t: 'status', status }); }
  setPresence(presence: 'online' | 'away' | 'in_call') { this.send({ t: 'presence', presence }); }
  setMeetLink(link: string) { this.send({ t: 'meet_link', link }); }
  claimDesk() { this.send({ t: 'claim_desk' }); }
  releaseDesk() { this.send({ t: 'release_desk' }); }
  leaveRoom() { this.send({ t: 'leave_room' }); }
  setHand(up: boolean) { this.send({ t: 'hand', up }); }
  setDeafen(on: boolean) { this.send({ t: 'deafen', on }); }
  claimVoice() { this.send({ t: 'voice_claim' }); }
  setObjectVolume(id: string, volume: number) { this.send({ t: 'object_volume', id, volume }); }
  /** Standing still right next to this object (the radio's knob only turns from there). */
  besideObject(id: string) {
    const o = MAP.objects.find(o => o.id === id), me = this.users.get(this.me);
    if (!o || !me) return false;
    const p = this.pose(me);
    return !p.walking && besideObject(MAP, o).some(s => s.x === p.tile.x && s.y === p.tile.y);
  }
  /** Walk up to an object: the nearest free tile beside it. */
  walkToObject(id: string) {
    const o = MAP.objects.find(o => o.id === id), me = this.users.get(this.me);
    if (!o || !me) return;
    const here = this.pose(me).tile;
    const taken = new Set([...this.users.values()].filter(u => u.id !== this.me && u.presence !== 'offline').map(u => `${u.tile.x},${u.tile.y}`));
    const spots = besideObject(MAP, o).filter(s => !taken.has(`${s.x},${s.y}`))
      .map(s => ({ s, len: pathTo(MAP, here, s).length || Infinity })).sort((a, b) => a.len - b.len);
    if (spots[0] && spots[0].len < Infinity) this.moveTo({ x: spots[0].s.x, y: spots[0].s.y });
  }
  focusVoice(id: string | null) { this.voiceFocus = id; this.voiceFocusSeq++; this.emit(); }
  roomCallOf(u?: ClientUser) {
    return u?.callId?.startsWith('room:') ? MAP.rooms.find(r => r.id === u.callId!.slice(5)) : undefined;
  }
  sameRoomCall(u: ClientUser) {
    const me = this.users.get(this.me);
    return !!this.roomCallOf(me) && me?.callId === u.callId;
  }
  endCall() { this.send({ t: 'end_call' }); }
  callLink: string | null = null; // the Meet link for the call I'm in
  /** Everyone else in this person's call, in a stable order. */
  callPeers(u: ClientUser) {
    if (!u.callId) return [];
    return [...this.users.values()].filter(o => o.id !== u.id && o.callId === u.callId).sort((a, b) => a.id.localeCompare(b.id));
  }
  /** "Leo", "Leo and Maya", "Leo, Maya and 2 others" */
  names(us: ClientUser[]) {
    const n = us.map(u => u.name.split(' ')[0]);
    return n.length <= 2 ? n.join(' and ') : `${n.slice(0, 2).join(', ')} and ${n.length - 2} other${n.length > 3 ? 's' : ''}`;
  }

  toast(t: Omit<Toast, 'id'>) {
    const toast = { ...t, id: ++this.toastSeq };
    this.toasts = [...this.toasts, toast].slice(-4);
    if (t.expires) setTimeout(() => this.dismiss(toast.id), t.expires);
    this.emit();
  }
  dismiss(id: number) { this.toasts = this.toasts.filter(t => t.id !== id); this.emit(); }

  // ---------- state ----------
  private applyMove(u: ClientUser, m: { from: Tile; to: Tile; startedAt: number; path?: Tile[]; face?: Dir }) {
    const path = m.path ?? pathTo(MAP, m.from, m.to);
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
        this.me = msg.you; this.offset = msg.serverTime - Date.now();
        if (msg.build && this.build && msg.build !== this.build) this.staleBuild = true;
        this.build ??= msg.build;
        break;
      case 'state': {
        this.offset = msg.serverTime - Date.now();
        const next = new Map<string, ClientUser>();
        for (const p of msg.users) {
          const old = this.users.get(p.id);
          const u: ClientUser = { ...p, path: old?.path ?? null, prev: old?.prev ?? null, faceOverride: old?.faceOverride ?? null, speaking: p.callRole === 'member' && p.callId === old?.callId ? old?.speaking ?? false : false };
          if (p.move && (!old?.move || old.move.startedAt !== p.move.startedAt)) { u.move = null; this.applyMove(u, p.move); }
          next.set(p.id, u);
        }
        this.users = next;
        this.objects = msg.objects ?? {};
        this.soundscape?.resetAdmitted();
        break;
      }
      case 'follow': { const u = this.users.get(msg.userId); if (u) u.following = msg.targetId; break; }
      case 'holding': {
        const u = this.users.get(msg.userId); if (u) u.holding = msg.item;
        if (msg.objectId) this.objectFx = [...this.objectFx.filter(f => performance.now() - f.at < 4000), { objectId: msg.objectId, at: performance.now() }];
        const it = msg.item ? ITEMS.get(msg.item) : undefined;
        if (msg.fromId && it) { // handed over: the item hops across like a reaction
          this.reactions.push({ fromId: msg.fromId, toId: msg.userId, emoji: it.icon, at: performance.now() });
          if (msg.userId === this.me) { playPop(); this.toast({ kind: 'info', text: `${this.name(msg.fromId)} handed you ${it.label.toLowerCase()} ${it.icon}`, expires: 5000 }); }
        }
        break;
      }
      case 'object': this.objects = { ...this.objects, [msg.id]: { on: msg.on, volume: msg.volume } }; break;
      case 'react':
        this.reactions.push({ fromId: msg.fromId, toId: msg.toId, emoji: msg.emoji, at: performance.now() });
        if (msg.toId === this.me && msg.fromId !== this.me) playPop();
        return; // drawn by the engine; no re-render needed
      case 'chat': {
        const m = msg.msg, other = m.fromId === this.me ? m.toId : m.fromId;
        const list = this.chats.get(other) ?? [];
        if (!list.some(x => x.id === m.id)) this.chats.set(other, [...list, m]);
        if (m.fromId !== this.me && this.chatWith !== other) {
          this.unread.set(other, (this.unread.get(other) ?? 0) + 1);
          this.toasts = this.toasts.filter(t => !(t.kind === 'chat' && t.userId === other));
          this.toast({ kind: 'chat', userId: other, text: `${this.name(other)}: ${m.text}`, expires: 10000 });
          playPop();
        }
        break;
      }
      case 'chat_history': this.chats.set(msg.withId, msg.messages); break;
      case 'move': { const u = this.users.get(msg.userId); if (u) this.applyMove(u, msg); break; }
      case 'me': this.meetLink = msg.meetLink; break;
      case 'desk': { const u = this.users.get(msg.userId); if (u) u.homeDesk = msg.desk; break; }
      case 'call': {
        const u = this.users.get(msg.userId);
        if (u) {
          if (u.callId !== msg.callId && !msg.callId?.startsWith('room:')) u.muted = false;
          u.callId = msg.callId; u.callRole = msg.callId ? msg.role ?? 'member' : null;
          if (u.callRole !== 'member') { u.speaking = false; u.hand = false; }
        }
        if (msg.userId === this.me) this.callLink = msg.callId && !msg.callId.startsWith('room:') ? msg.link ?? this.callLink : null;
        break;
      }
      case 'voice_owner': this.voiceOwner = msg.owner; break;
      case 'voice_wait': {
        const was = this.voiceWait; this.voiceWait = msg.roomId;
        if (!was && msg.roomId) this.toast({ kind: 'info', text: `${MAP.rooms.find(r => r.id === msg.roomId)?.name ?? 'Room'} voice is full (${ROOM_VOICE_MAX}) — you'll join when someone leaves`, expires: 6000 });
        break;
      }
      case 'notice': this.toast({ kind: 'info', text: msg.text, expires: 6000 }); break;
      case 'deafen': { const u = this.users.get(msg.userId); if (u) { u.deafened = msg.on; if (msg.on) u.speaking = false; } break; }
      case 'hand': {
        const u = this.users.get(msg.userId), me = this.users.get(this.me);
        if (u) {
          if (msg.up && !u.hand && u.id !== this.me && me?.callRole === 'member' && this.sameRoomCall(u)) playHand();
          u.hand = msg.up;
        }
        break;
      }
      case 'rtc': this.onRtc?.(msg.from, msg.signal); return; // no re-render needed
      case 'speaking': { const u = this.users.get(msg.userId); if (u) u.speaking = msg.on; break; }
      case 'mute': { const u = this.users.get(msg.userId); if (u) { u.muted = msg.muted; if (msg.muted) u.speaking = false; } break; }
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
        if (msg.toId === this.me) playKnock();
        if (msg.toId === this.me) this.toast({ kind: 'knock_in', knockId: msg.knockId, text: this.users.get(this.me)?.callId ? `${this.name(msg.fromId)} wants to join your call` : `${this.name(msg.fromId)} is knocking` });
        else if (msg.fromId === this.me) this.toast({ kind: 'knock_out', knockId: msg.knockId, text: `Knocking on ${this.name(msg.toId)}…` });
        break;
      }
      case 'knock_reply': {
        const mine = msg.fromId === this.me, forMe = msg.toId === this.me;
        if (!mine && !forMe) break;
        this.toasts = this.toasts.filter(t => t.knockId !== msg.knockId);
        if (msg.cancelled) break; // called back: the prompt just goes away on both sides
        const otherId = mine ? msg.toId : msg.fromId, other = this.name(otherId);
        if (msg.reply === 'accept') {
          this.callLink = msg.link ?? this.callLink;
          this.toast({ kind: 'info', text: `🎙 Voice call with ${other} — you're live`, expires: 4000 });
        }
        else if (mine && msg.reply === 'blocked') this.toast({ kind: 'info', text: msg.reason ?? `Can't knock on ${other} now`, expires: 5000 });
        else if (mine) this.toast({ kind: 'knock_again', userId: otherId, text: msg.reason ?? `${other} said later`, expires: 12000 });
        else if (forMe && msg.reason) this.toast({ kind: 'knock_again', userId: otherId, text: `Missed a knock from ${other}`, expires: 30000 });
        break;
      }
    }
    this.emit();
    // A deploy happened while this page was open: reload into the new build, but never mid-call.
    if (this.staleBuild && !this.users.get(this.me)?.callId) location.reload();
  }
}
