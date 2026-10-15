import { AFK_MS, type RtcSignal } from '../../shared/protocol';
import { audio, forgetMedia, needsGesture, playMedia, resume, setAudioDeafened } from './audio';
import { prefs, savePrefs, subscribePrefs } from './prefs';
import type { ClientUser, Store } from './net';

interface Peer {
  pc: RTCPeerConnection; audio: HTMLAudioElement; transceiver?: RTCRtpTransceiver;
  pendingIce: RTCIceCandidateInit[]; conn: string | null; remoteInst: string | null;
  replacing: boolean;
}
const rid = () => Math.random().toString(36).slice(2, 10);
const around = (u: ClientUser) => !u.bot && u.presence !== 'offline' && u.door !== 'thinking' && u.door !== 'leaving';

export class Voice {
  muted = prefs.muted;
  deafened = prefs.deafened;
  mode = prefs.mode;
  spaceHeld = false;
  micError: string | null = null;
  private callId: string | null = null;
  private owner = false;
  private local: MediaStream | null = null;
  private peers = new Map<string, Peer>();
  private micRequest = 0;
  private micAttempted = false;
  private meter: number | undefined;
  private meterSource: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private speaking = false;
  private loudTicks = 0;
  private quietTicks = 0;
  private handSince = 0;
  private lastActivity = Date.now();
  private afk: number;
  private poseTimer: number;
  private insideRect = false;
  private inst = rid();
  private dead = false;
  private unsub: () => void;

  constructor(private store: Store, private iceServers: RTCIceServer[]) {
    store.onRtc = (from, signal) => { void this.onSignal(from, signal); };
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) window.addEventListener(event, this.activity, { passive: true });
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.releaseSpace);
    this.poseTimer = window.setInterval(() => this.checkInside(), 100);
    this.afk = window.setInterval(() => this.checkAfk(), 15000);
    setAudioDeafened(this.deafened);
    this.unsub = subscribePrefs(() => {
      const muted = this.privateCall ? this.muted : prefs.muted; // a knock call keeps its own unmute
      const changed = this.muted !== muted || this.deafened !== prefs.deafened || this.mode !== prefs.mode;
      this.muted = muted; this.deafened = prefs.deafened; this.mode = prefs.mode;
      if (!changed) return;
      this.spaceHeld = false; setAudioDeafened(this.deafened);
      if (this.owner && this.callId) {
        this.store.send({ t: 'mute', muted: this.muted }); this.store.setDeafen(this.deafened);
      }
      this.sendRule(); this.store.changed();
    });
  }
  get needsGesture() { return needsGesture(); }
  resumeAudio() { void resume(); }

  // Used for creation, incoming signals, pruning and both UI counts.
  private eligible(u: ClientUser) {
    const me = this.store.users.get(this.store.me);
    return !!me && this.owner && this.store.connected && around(me) && around(u) && u.id !== me.id && !!me.callId && me.callId === u.callId;
  }
  eligiblePeers() { return [...this.store.users.values()].filter(u => this.eligible(u)); }
  sync() {
    if (this.dead) return;
    const me = this.store.users.get(this.store.me), owner = this.store.connected && this.store.voiceOwner;
    const callId = me?.callId ?? null;
    const newOwner = owner && !this.owner, newCall = callId !== this.callId;
    const wasOwner = this.owner;
    this.owner = owner; this.callId = callId;
    if (!owner || newCall) this.stopVoice();
    if (newOwner) this.inst = rid();
    if (owner && (newOwner || newCall)) {
      this.muted = this.privateCall ? false : prefs.muted; this.deafened = prefs.deafened; this.mode = prefs.mode;
      this.lastActivity = Date.now();
      if (callId) {
        this.store.send({ t: 'mute', muted: this.muted }); this.store.setDeafen(this.deafened);
      }
      if (owner && callId?.startsWith('room:') && !prefs.voiceAsked && this.muted) this.askAboutMute();
    }
    if (wasOwner && !owner) this.spaceHeld = false;
    const ids = new Set(this.eligiblePeers().map(u => u.id));
    for (const id of [...this.peers.keys()]) if (!ids.has(id)) this.closePeer(id);
    for (const id of ids) if (!this.peers.has(id)) {
      const p = this.createPeer(id);
      if (this.store.me < id) void this.offer(id, p).catch(e => console.warn('voice offer', e));
      else this.signal(id, { kind: 'hello', inst: this.inst });
    }
    this.checkInside(); this.sendRule();
    if (owner && callId && !this.local && !this.micAttempted) void this.requestMic(callId);
  }
  private checkInside() {
    const me = this.store.users.get(this.store.me), room = this.store.roomCallOf(me);
    const inside = !!me && !me.instance && (!room || this.store.roomOf(me)?.id === room.id);
    if (inside === this.insideRect) return;
    this.insideRect = inside; this.sendRule(); this.store.changed();
  }
  private sendRule() {
    const track = this.owner && this.callId ? this.local?.getAudioTracks()[0] ?? null : null;
    const enabled = this.insideRect && this.owner && !!this.callId && !!this.local && !this.muted && !this.deafened && (this.mode === 'voice' || this.spaceHeld);
    for (const t of this.local?.getAudioTracks() ?? []) t.enabled = enabled;
    if (!enabled) { this.loudTicks = 0; this.quietTicks = 0; this.handSince = 0; this.setSpeaking(false); }
    for (const p of this.peers.values()) {
      const sender = p.transceiver?.sender;
      if (!sender || p.replacing || sender.track === track) continue;
      p.replacing = true;
      void sender.replaceTrack(track).then(() => {
        p.replacing = false;
        if (p.pc.signalingState !== 'closed') this.sendRule();
      }).catch(e => { p.replacing = false; console.warn('voice replaceTrack', e); });
    }
  }
  private async requestMic(callId: string) {
    this.micAttempted = true;
    const token = ++this.micRequest;
    let local: MediaStream | null = null, error: string | null = null;
    try {
      local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      error = (e as Error)?.name === 'NotAllowedError' ? 'Microphone blocked: you can listen but not talk' : 'No microphone: listen-only';
    }
    if (token !== this.micRequest || !this.owner || this.callId !== callId || this.dead) {
      for (const t of local?.getTracks() ?? []) t.stop(); return;
    }
    this.local = local; this.micError = error;
    this.sendRule();
    if (local) this.startMeter(local);
    else this.store.toast({ kind: 'info', text: error!, expires: 6000 });
    this.store.changed();
  }
  /** Knock calls (not `room:`) start unmuted; the saved choice is for rooms and comes back when the call ends. */
  private get privateCall() { return !!this.callId && !this.callId.startsWith('room:'); }
  /** Public spaces start muted: say so once, with a way out. */
  private askAboutMute() {
    const room = this.store.roomCallOf(this.store.users.get(this.store.me));
    const pick = (muted: boolean) => { prefs.voiceAsked = true; this.setMuted(muted); };
    this.store.toast({ kind: 'info', text: `You're on mute in ${room?.name ?? 'this room'}`, expires: 30000, actions: [
      { label: '🎙 Unmute', run: () => pick(false) }, { label: 'Stay muted', run: () => pick(true), ghost: true }] });
  }
  private setMuted(muted: boolean) {
    this.muted = muted;
    if (!this.privateCall) { prefs.muted = muted; prefs.voiceAsked = true; }
    savePrefs();
    this.store.send({ t: 'mute', muted: this.muted }); this.sendRule(); this.store.changed();
  }
  toggleMute() {
    if (!this.store.voiceOwner || !this.store.connected) return;
    this.setMuted(!this.muted);
  }
  toggleDeafen() {
    if (!this.store.voiceOwner || !this.store.connected) return;
    this.deafened = !this.deafened; prefs.deafened = this.deafened; savePrefs();
    setAudioDeafened(this.deafened); this.store.setDeafen(this.deafened); this.sendRule(); this.store.changed();
  }
  toggleMode() {
    if (!this.store.voiceOwner || !this.store.connected) return;
    this.mode = this.mode === 'voice' ? 'ptt' : 'voice'; prefs.mode = this.mode; savePrefs();
    this.releaseSpace(); this.sendRule(); this.store.changed();
  }
  private stopMic() {
    ++this.micRequest; if (!this.micError) this.micAttempted = false;
    for (const t of this.local?.getTracks() ?? []) t.stop(); this.local = null;
    clearInterval(this.meter); this.meter = undefined;
    this.meterSource?.disconnect(); this.analyser?.disconnect(); this.meterSource = null; this.analyser = null;
    this.setSpeaking(false); this.loudTicks = 0; this.quietTicks = 0; this.handSince = 0;
  }
  private stopVoice() {
    this.stopMic();
    for (const id of [...this.peers.keys()]) this.closePeer(id);
  }
  destroy() {
    this.dead = true; this.unsub(); this.stopVoice(); clearInterval(this.afk); clearInterval(this.poseTimer); this.store.onRtc = undefined;
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) window.removeEventListener(event, this.activity);
    window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp); window.removeEventListener('blur', this.releaseSpace);
  }

  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers }), el = new Audio();
    el.autoplay = true; el.muted = true;
    const p: Peer = { pc, audio: el, pendingIce: [], conn: null, remoteInst: null, replacing: false };
    if (this.store.me < id) {
      p.transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      pc.createDataChannel('deck');
    }
    this.peers.set(id, p);
    pc.onicecandidate = e => {
      if (this.current(id, p) && p.conn) this.signal(id, { kind: 'ice', candidate: e.candidate?.toJSON() ?? null, conn: p.conn });
    };
    pc.ontrack = e => {
      if (!this.current(id, p)) return;
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      el.srcObject = stream; void playMedia(el); this.store.soundscape?.addVoice(id, stream);
    };
    pc.onconnectionstatechange = () => {
      if (!this.current(id, p)) return;
      if (pc.connectionState === 'failed' && this.store.me < id) {
        pc.restartIce(); void this.offer(id, p).catch(e => console.warn('voice ICE restart', e));
      }
      this.store.changed();
    };
    this.sendRule(); return p;
  }
  private current(id: string, p: Peer) { return this.peers.get(id) === p && p.pc.signalingState !== 'closed'; }
  private closePeer(id: string) {
    const p = this.peers.get(id); if (!p) return;
    this.peers.delete(id); p.pc.close(); p.audio.pause(); p.audio.srcObject = null;
    this.store.soundscape?.remove(id); forgetMedia(p.audio);
  }
  private async offer(id: string, p: Peer) {
    p.conn ??= rid();
    const offer = await p.pc.createOffer(); if (!this.current(id, p)) return;
    await p.pc.setLocalDescription(offer); if (!this.current(id, p)) return;
    this.signal(id, { kind: 'offer', sdp: offer.sdp ?? '', conn: p.conn });
  }
  private signal(to: string, signal: RtcSignal) { if (this.owner) this.store.send({ t: 'rtc', to, signal }); }
  private async onSignal(from: string, signal: RtcSignal) {
    const u = this.store.users.get(from); if (!u || !this.eligible(u)) return;
    let p = this.peers.get(from);
    try {
      if (signal.kind === 'hello') {
        if (this.store.me > from || p?.remoteInst === signal.inst) return;
        this.closePeer(from); p = this.createPeer(from); p.remoteInst = signal.inst;
        await this.offer(from, p);
      } else if (signal.kind === 'offer') {
        if (this.store.me < from) return;
        if (p?.conn && p.conn !== signal.conn) { this.closePeer(from); p = undefined; }
        p ??= this.createPeer(from); p.conn = signal.conn;
        await p.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp }); if (!this.current(from, p)) return;
        p.transceiver = p.pc.getTransceivers().find(t => t.receiver.track.kind === 'audio');
        if (!p.transceiver) throw new Error('Missing audio transceiver');
        p.transceiver.direction = 'sendrecv'; this.sendRule(); await this.flushIce(p);
        const answer = await p.pc.createAnswer(); if (!this.current(from, p)) return;
        await p.pc.setLocalDescription(answer); if (!this.current(from, p)) return;
        this.signal(from, { kind: 'answer', sdp: answer.sdp ?? '', conn: signal.conn, inst: this.inst });
      } else if (signal.kind === 'answer') {
        if (!p || p.conn !== signal.conn || p.pc.signalingState !== 'have-local-offer') return;
        await p.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp }); if (!this.current(from, p)) return;
        p.remoteInst = signal.inst; await this.flushIce(p); this.sendRule();
      } else {
        if (!p || p.conn !== signal.conn || !signal.candidate) return;
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(signal.candidate);
        else p.pendingIce.push(signal.candidate);
      }
    } catch (e) { console.warn('voice signaling', e); }
  }
  private async flushIce(p: Peer) { for (const c of p.pendingIce.splice(0)) await p.pc.addIceCandidate(c).catch(() => {}); }

  private startMeter(stream: MediaStream) {
    this.meterSource = audio().createMediaStreamSource(stream); this.analyser = audio().createAnalyser();
    this.analyser.fftSize = 512; this.meterSource.connect(this.analyser);
    const buf = new Float32Array(this.analyser.fftSize);
    this.meter = window.setInterval(() => {
      if (!this.local?.getAudioTracks()[0]?.enabled) return;
      this.analyser!.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const loud = Math.sqrt(sum / buf.length) > .018;
      this.loudTicks = loud ? this.loudTicks + 1 : 0; this.quietTicks = loud ? 0 : this.quietTicks + 1;
      if (loud) this.lastActivity = Date.now();
      if (!this.speaking && this.loudTicks >= 2) this.setSpeaking(true);
      else if (this.speaking && this.quietTicks >= 6) this.setSpeaking(false);
      const me = this.store.users.get(this.store.me);
      if (this.speaking && me?.hand && this.store.roomCallOf(me)) {
        this.handSince ||= Date.now();
        if (Date.now() - this.handSince >= 1500) { this.store.setHand(false); this.handSince = 0; }
      } else this.handSince = 0;
    }, 80);
  }
  private setSpeaking(on: boolean) {
    if (this.speaking === on) return;
    this.speaking = on;
    if (this.owner) this.store.send({ t: 'speaking', on });
  }
  connectedCount() { return this.eligiblePeers().filter(u => this.peers.get(u.id)?.pc.connectionState === 'connected').length; }
  peerCount() { return this.eligiblePeers().length; }

  private activity = () => { this.lastActivity = Date.now(); };
  private keyDown = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || e.repeat || this.mode !== 'ptt' || !this.owner || !this.callId) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault(); this.spaceHeld = true; this.sendRule(); this.store.changed();
  };
  private keyUp = (e: KeyboardEvent) => { if (e.code === 'Space') this.releaseSpace(); };
  private releaseSpace = () => { if (this.spaceHeld) { this.spaceHeld = false; this.sendRule(); this.store.changed(); } };
  private checkAfk() {
    const me = this.store.users.get(this.store.me), room = this.store.roomCallOf(me);
    if (!this.owner || !room || Date.now() - this.lastActivity < AFK_MS) return;
    this.lastActivity = Date.now(); this.store.leaveRoom();
    this.store.toast({ kind: 'info', text: `Left ${room.name} after 10 minutes of silence`, expires: 6000 });
  }
}
