import { AFK_MS, type RtcSignal } from '../../shared/protocol';
import { audio, forgetMedia, playMedia, setAudioDeafened } from './audio';
import { voicePolicy, HINT_SPEECH_MS, HINT_COOLDOWN_MS } from './voicePolicy';
import { playMuteBlip, playDeafenBlip, playKnock } from './sounds';
import { prefs, savePrefs, subscribePrefs } from './prefs';
import type { ClientUser, Store } from './net';

interface Peer {
  pc: RTCPeerConnection; audio: HTMLAudioElement; transceiver?: RTCRtpTransceiver;
  pendingIce: RTCIceCandidateInit[]; conn: string | null; remoteInst: string | null;
  replacing: boolean; since: number;
}
const rid = () => Math.random().toString(36).slice(2, 10);
// A peer that hasn't connected within CONNECT_MS (longer on each retry), or dropped to disconnected for LOST_MS, is rebuilt.
const CONNECT_MS = 10_000, CONNECT_MAX_MS = 40_000, LOST_MS = 5_000;
const around = (u: ClientUser) => !u.bot && u.presence !== 'offline' && u.door !== 'thinking' && u.door !== 'leaving';

export class Voice {
  muted = true;
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
  private processing = prefs.processing;
  private meter: number | undefined;
  private meterSource: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private speaking = false;
  private loudTicks = 0;
  private quietTicks = 0;
  private handSince = 0;
  onMeet = false;
  timeScale = 1;
  private meetMuted = true;
  private meterTrack: MediaStreamTrack | null = null;
  private lastOwnSpeech = 0;
  private unmutedAt = Date.now();
  private aloneSince = Date.now();
  private company = '';
  private lastMode = this.mode;
  private wasAway = false;
  private idlePromptAt: number | null = null;
  private idleToast: number | null = null;
  private idleLeft = false;
  private idleLeftAt = 0;
  private lastActiveSent = 0;
  private switchedAway = document.hidden || !document.hasFocus();
  private hintSince = 0;
  private hintAt = -Infinity;
  private afk: number;
  private watchdog: number;
  private retries = new Map<string, number>();
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
    window.addEventListener('blur', this.blur);
    window.addEventListener('focus', this.focus);
    document.addEventListener('visibilitychange', this.visibility);
    this.poseTimer = window.setInterval(() => this.checkInside(), 100);
    this.afk = window.setInterval(() => this.checkPolicy(), 1000);
    this.watchdog = window.setInterval(() => this.checkPeers(), 2000);
    setAudioDeafened(this.deafened);
    this.unsub = subscribePrefs(() => {
      if (this.processing !== prefs.processing) { // reopen the mic with the new processing, if it's open
        this.processing = prefs.processing;
        if (this.local) { this.stopMic(); this.micAttempted = false; this.sendRule(); this.openMic(); }
      }
      const changed = this.deafened !== prefs.deafened || this.mode !== prefs.mode;
      if (this.deafened !== prefs.deafened) playDeafenBlip(prefs.deafened);
      this.deafened = prefs.deafened; this.mode = prefs.mode;
      if (!changed) return;
      this.spaceHeld = false; setAudioDeafened(this.deafened);
      if (this.owner && this.callId) {
        this.store.send({ t: 'mute', muted: this.muted }); this.store.setDeafen(this.deafened);
      }
      this.sendRule(); this.store.changed();
    });
  }

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
    if (this.idleLeft && this.store.activeAt > this.idleLeftAt) this.idleLeft = false;
    if (this.idlePromptAt !== null && Math.max(this.store.activeAt, this.lastOwnSpeech, this.store.heardAt) > this.idlePromptAt) this.clearPrompt();
    const wasOwner = this.owner;
    if (this.owner && this.callId && (newCall || !owner)) this.rememberCall();
    if (!owner || newCall) this.stopVoice();
    this.owner = owner; this.callId = callId;
    if (newOwner) this.inst = rid();
    if (owner && (newOwner || newCall)) {
      this.muted = !this.privateCall; this.deafened = prefs.deafened; this.mode = prefs.mode;
      const memory = this.privateCall ? this.readCalls()[callId!] : undefined;
      this.onMeet = !!memory?.meet; this.meetMuted = memory?.muted ?? false;
      this.muted = memory ? memory.meet || memory.muted : !this.privateCall;
      this.store.activeAt = this.unmutedAt = this.aloneSince = Date.now();
      this.lastOwnSpeech = 0; this.company = ''; this.clearPrompt();
      if (callId) {
        this.store.send({ t: 'mute', muted: this.muted }); this.store.setDeafen(this.deafened);
      }
    }
    if (newCall && !owner) this.onMeet = false;
    if (wasOwner && !owner) { this.spaceHeld = false; this.onMeet = false; this.clearPrompt(); }
    const away = me?.presence === 'away';
    const becameAway = away && !this.wasAway; this.wasAway = away;
    if (owner && callId?.startsWith('room:') && away && (becameAway || newCall || newOwner) && !this.muted) this.setMuted(true);
    const ids = new Set(this.eligiblePeers().map(u => u.id));
    for (const id of [...this.peers.keys()]) if (!ids.has(id)) this.closePeer(id);
    for (const id of [...this.retries.keys()]) if (!ids.has(id)) this.retries.delete(id);
    for (const id of ids) if (!this.peers.has(id)) {
      const p = this.createPeer(id);
      if (this.store.me < id) void this.offer(id, p).catch(e => console.warn('voice offer', e));
      else this.signal(id, { kind: 'hello', inst: this.inst });
    }
    this.checkInside(); this.sendRule();
    this.openMic();
  }
  private checkInside() {
    const me = this.store.users.get(this.store.me), room = this.store.roomCallOf(me);
    const inside = !!me && (me.instance ? this.store.inRoomVoice : !room || this.store.roomOf(me)?.id === room.id);
    if (inside === this.insideRect) return;
    this.insideRect = inside; this.sendRule(); this.store.changed();
  }
  private sendRule() {
    const track = this.owner && this.callId ? this.local?.getAudioTracks()[0] ?? null : null;
    const enabled = this.insideRect && this.owner && !!this.callId && !!this.local && !this.muted && !this.deafened && !this.onMeet && (this.mode === 'voice' || this.spaceHeld);
    for (const t of this.local?.getAudioTracks() ?? []) t.enabled = enabled;
    if (enabled || !this.muted || this.deafened || this.onMeet || this.mode !== 'voice') this.hintSince = 0;
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
      const on = this.processing;
      local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: on, noiseSuppression: on, autoGainControl: on } });
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
  /** Knock calls (not `room:`) start unmuted. Rooms start muted on every entry: walking in never puts you on air. */
  private get privateCall() { return !!this.callId && !this.callId.startsWith('room:'); }
  get inRoomCall() { return !this.privateCall && !!this.callId; }
  get transmitting() { return !!this.local?.getAudioTracks()[0]?.enabled; }
  private readCalls(): Record<string, { muted: boolean; meet: boolean; at: number }> {
    try {
      const value = JSON.parse(localStorage.getItem('deck.voice.calls') ?? '{}');
      return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => !!v && typeof v === 'object' &&
        typeof (v as { muted?: unknown }).muted === 'boolean' && typeof (v as { meet?: unknown }).meet === 'boolean' &&
        typeof (v as { at?: unknown }).at === 'number')) as Record<string, { muted: boolean; meet: boolean; at: number }>;
    } catch { return {}; }
  }
  private rememberCall() {
    if (!this.privateCall) return;
    try {
      const calls = this.readCalls();
      calls[this.callId!] = { muted: this.onMeet ? this.meetMuted : this.muted, meet: this.onMeet, at: Date.now() };
      localStorage.setItem('deck.voice.calls', JSON.stringify(Object.fromEntries(Object.entries(calls).sort((a, b) => b[1].at - a[1].at).slice(0, 20))));
    } catch { /* storage may be unavailable */ }
  }
  setOnMeet(on = true) {
    if (!this.owner || !this.callId || this.onMeet === on) return;
    if (on) { this.meetMuted = this.muted; this.onMeet = true; this.setMuted(true); }
    else { this.onMeet = false; this.setMuted(this.meetMuted); }
    for (const [id, p] of this.peers) {
      if (on) this.store.soundscape?.remove(id);
      else if (p.audio.srcObject) this.store.soundscape?.addVoice(id, p.audio.srcObject as MediaStream, p.audio);
    }
    this.clearPrompt(); this.rememberCall(); this.store.changed();
  }
  setMuted(muted: boolean) {
    if (!this.store.voiceOwner || !this.store.connected) return;
    if (!muted) {
      if (this.store.users.get(this.store.me)?.presence === 'away') this.store.setPresence('online');
      this.unmutedAt = Date.now();
      this.micAttempted = false;
    }
    if (this.muted !== muted) playMuteBlip(muted);
    this.muted = muted; this.rememberCall();
    this.store.send({ t: 'mute', muted: this.muted }); this.sendRule(); this.openMic(); this.store.changed();
  }
  /** Open only on unmute, so muted entry and restored On Meet never activate the device. */
  private openMic() {
    if (this.owner && this.callId && !this.muted && !this.onMeet && !this.local && !this.micAttempted) void this.requestMic(this.callId);
  }
  toggleMute() {
    this.setMuted(this.micError ? false : !this.muted);
  }
  toggleDeafen() {
    if (!this.store.voiceOwner || !this.store.connected) return;
    playDeafenBlip(!this.deafened);
    this.deafened = !this.deafened; prefs.deafened = this.deafened; savePrefs();
    setAudioDeafened(this.deafened); this.store.setDeafen(this.deafened); this.sendRule(); this.store.changed();
  }
  toggleMode() {
    if (!this.store.voiceOwner || !this.store.connected) return;
    this.mode = this.mode === 'voice' ? 'ptt' : 'voice'; prefs.mode = this.mode; savePrefs();
    this.releaseSpace(); this.sendRule(); this.store.changed();
  }
  private stopMic() {
    ++this.micRequest; this.micAttempted = false;
    for (const t of this.local?.getTracks() ?? []) t.stop(); this.local = null;
    this.meterTrack?.stop(); this.meterTrack = null; this.hintSince = 0;
    clearInterval(this.meter); this.meter = undefined;
    this.meterSource?.disconnect(); this.analyser?.disconnect(); this.meterSource = null; this.analyser = null;
    this.setSpeaking(false); this.loudTicks = 0; this.quietTicks = 0; this.handSince = 0;
  }
  private stopVoice() {
    this.stopMic();
    for (const id of [...this.peers.keys()]) this.closePeer(id);
  }
  destroy() {
    this.dead = true; this.unsub(); this.stopVoice(); clearInterval(this.afk); clearInterval(this.watchdog); clearInterval(this.poseTimer); this.store.onRtc = undefined;
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) window.removeEventListener(event, this.activity);
    window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp); window.removeEventListener('blur', this.blur); window.removeEventListener('focus', this.focus); document.removeEventListener('visibilitychange', this.visibility); this.clearPrompt();
  }

  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers }), el = new Audio();
    el.autoplay = true; el.muted = true;
    const p: Peer = { pc, audio: el, pendingIce: [], conn: null, remoteInst: null, replacing: false, since: Date.now() };
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
      el.srcObject = stream; void playMedia(el); if (!this.onMeet) this.store.soundscape?.addVoice(id, stream, el);
    };
    pc.onconnectionstatechange = () => {
      if (!this.current(id, p)) return;
      if (pc.connectionState === 'connected') this.retries.delete(id);
      else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') p.since = Date.now(); // the clock starts when it drops
      if (pc.connectionState === 'failed' && this.store.me < id) {
        pc.restartIce(); void this.offer(id, p).catch(e => console.warn('voice ICE restart', e));
      }
      this.store.changed();
    };
    this.sendRule(); return p;
  }
  /** The offering side (lower id) rebuilds a peer stuck short of connected; the other side follows the new offer's `conn`. */
  private checkPeers() {
    if (!this.owner || !this.store.connected) return;
    const now = Date.now();
    for (const [id, p] of [...this.peers]) {
      const state = p.pc.connectionState;
      if (this.store.me > id || state === 'connected') continue;
      const tries = this.retries.get(id) ?? 0;
      const wait = state === 'disconnected' ? LOST_MS : Math.min(CONNECT_MS * (tries + 1), CONNECT_MAX_MS);
      if (now - p.since < wait) continue;
      this.retries.set(id, tries + 1);
      console.info(`voice: ${state} with ${id} for ${Math.round((now - p.since) / 1000)} s, reconnecting (try ${tries + 1})`);
      this.closePeer(id);
      void this.offer(id, this.createPeer(id)).catch(e => console.warn('voice reconnect', e));
    }
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
    this.meterTrack = stream.getAudioTracks()[0].clone(); this.meterTrack.enabled = true;
    this.meterSource = audio().createMediaStreamSource(new MediaStream([this.meterTrack])); this.analyser = audio().createAnalyser();
    this.analyser.fftSize = 512; this.meterSource.connect(this.analyser);
    const buf = new Float32Array(this.analyser.fftSize);
    this.meter = window.setInterval(() => {
      this.analyser!.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const loud = Math.sqrt(sum / buf.length) > .018;
      const now = Date.now(), scale = this.policyScale;
      if (!this.transmitting) {
        if (loud && this.muted && !this.deafened && !this.onMeet && this.mode === 'voice' && !this.micError) {
          this.hintSince ||= now;
          if (now - this.hintSince >= HINT_SPEECH_MS * scale && now - this.hintAt >= HINT_COOLDOWN_MS * scale) {
            this.hintAt = now;
            const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⇧M' : 'Ctrl+Shift+M';
            const callId = this.callId;
            this.store.toast({ kind: 'info', text: `You're muted · click the mic or press ${shortcut}`, expires: 6000,
              actions: [{ label: 'Unmute', run: () => { if (this.owner && this.callId === callId) this.setMuted(false); } }] });
          }
        } else this.hintSince = 0;
        return;
      }
      this.hintSince = 0;
      this.loudTicks = loud ? this.loudTicks + 1 : 0; this.quietTicks = loud ? 0 : this.quietTicks + 1;
      if (loud) this.lastOwnSpeech = now;
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

  private clearPrompt() {
    this.idlePromptAt = null;
    const id = this.idleToast; this.idleToast = null;
    if (id !== null) this.store.dismiss(id);
  }
  private activity = () => {
    const now = Date.now(), urgent = this.idlePromptAt !== null || this.idleLeft || now - this.store.activeAt >= AFK_MS * this.policyScale;
    this.store.activeAt = now; this.idleLeft = false; this.clearPrompt();
    if (urgent || now - this.lastActiveSent >= 60_000) { this.lastActiveSent = now; this.store.send({ t: 'active' }); }
  };
  private keyDown = (e: KeyboardEvent) => {
    if (e.repeat || !this.owner || !this.callId) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('input, textarea, select, [contenteditable]')) return;
    if (e.shiftKey && (/Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey)) {
      if (e.code === 'KeyM') { e.preventDefault(); this.toggleMute(); return; }
      if (e.code === 'KeyD') { e.preventDefault(); this.toggleDeafen(); return; }
    }
    if (e.code !== 'Space' || this.mode !== 'ptt') return;
    e.preventDefault(); this.spaceHeld = true; this.sendRule(); this.store.changed();
  };
  private keyUp = (e: KeyboardEvent) => { if (e.code === 'Space') this.releaseSpace(); };
  private releaseSpace = () => { if (this.spaceHeld) { this.spaceHeld = false; this.sendRule(); this.store.changed(); } };
  private blur = () => { this.switchedAway = true; this.releaseSpace(); };
  private focus = () => { this.switchedAway = false; };
  private visibility = () => { this.switchedAway = document.hidden; if (document.hidden) this.releaseSpace(); };
  private get policyScale() { return import.meta.env.DEV && Number.isFinite(this.timeScale) && this.timeScale > 0 ? this.timeScale : 1; }
  private checkPolicy() {
    if (!this.owner || !this.callId || this.idleLeft) return;
    const now = Date.now(), peers = this.eligiblePeers(), company = peers.map(u => u.id).sort().join(',');
    if (peers.some(u => u.speaking)) this.store.heardAt = now;
    if (company !== this.company || this.mode !== this.lastMode) {
      this.company = company; this.lastMode = this.mode; this.aloneSince = this.unmutedAt = now;
    }
    if (this.idlePromptAt !== null && Math.max(this.store.activeAt, this.lastOwnSpeech, this.store.heardAt) > this.idlePromptAt) this.clearPrompt();
    const result = voicePolicy({ now, surface: this.inRoomCall ? 'shared' : 'knock', muted: this.muted,
      deafened: this.deafened, mode: this.mode, micError: this.micError, micOpen: !!this.local, onMeet: this.onMeet,
      alone: peers.length === 0, aloneSince: this.aloneSince, lastOwnSpeech: this.lastOwnSpeech, unmutedAt: this.unmutedAt,
      lastInput: this.store.activeAt, lastHeard: this.store.heardAt, switchedAway: this.switchedAway,
      idlePromptAt: this.idlePromptAt, timeScale: this.policyScale });
    if (result.mute) {
      this.setMuted(true);
      this.store.toast({ kind: 'info', text: `Muted: ${result.mute === 'away' ? 'you switched away' : result.mute === 'alone' ? 'you were quiet for a minute' : 'you were quiet for 5 minutes'}`, expires: 6000 });
    }
    const me = this.store.users.get(this.store.me), room = this.store.roomCallOf(me);
    if (result.prompt) {
      this.idlePromptAt = now; playKnock();
      this.store.toast({ kind: 'info', text: `Still here? You'll leave ${room?.name ?? (me?.instance ? 'Meeting' : 'the call')} in 2 minutes`,
        actions: [{ label: "I'm here", run: this.activity }] });
      this.idleToast = this.store.toasts.at(-1)?.id ?? null;
    }
    if (result.leave) {
      this.idleLeft = true; this.idleLeftAt = now; this.clearPrompt();
      const text = me?.instance ? 'Voice off' : this.inRoomCall ? `Left ${room?.name ?? 'the room'}` : `Left the call with ${this.store.names(peers)}`;
      this.store.send({ t: 'afk' });
      this.store.toast({ kind: 'info', text: `${text}: nothing happened for 10 minutes`, expires: 6000 });
    }
  }
}
