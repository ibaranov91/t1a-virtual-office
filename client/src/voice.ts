// Built-in voice for knock calls: audio-only WebRTC mesh between the people in my call.
// The server only relays signaling between members of the same call; audio goes browser to browser (DTLS-SRTP).
import type { RtcSignal } from '../../shared/protocol';
import type { Store } from './net';

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  pendingIce: RTCIceCandidateInit[];
  conn: string | null;       // the connection attempt this pc belongs to
  remoteInst: string | null; // which of their pages we're connected to (offerer side)
  awaiting: boolean;         // offer sent, answer not yet applied
}

const rid = () => Math.random().toString(36).slice(2, 10);

const SPEAK_ON = 0.018;   // RMS above this counts as talking
const TICK_MS = 80;

export class Voice {
  muted = false;
  micError: string | null = null;  // set when the mic is unavailable: we're listen-only
  needsGesture = false;            // browser blocked autoplay: a click resumes audio
  private callId: string | null = null;
  private ready = false;           // mic settled (granted or refused) for the current call
  private local: MediaStream | null = null;
  private peers = new Map<string, Peer>();
  private queued: { from: string; signal: RtcSignal }[] = [];
  private ctx: AudioContext | null = null;
  private meter: number | undefined;
  private speaking = false;
  private loudTicks = 0;
  private quietTicks = 0;
  private inst = rid();          // this page's voice session for the current call

  constructor(private store: Store, private iceServers: RTCIceServer[]) {
    store.onRtc = (from, signal) => this.onSignal(from, signal);
  }

  /** Call on every store change: start/stop with my call, connect to new members, drop leavers. */
  sync() {
    const me = this.store.users.get(this.store.me);
    const callId = me?.callId ?? null;
    if (callId !== this.callId) {
      // record the new call FIRST: stop() re-renders, which calls sync() again; with the old id still
      // recorded that re-entered stop() forever, and the next call never started (no sound on a re-call)
      const was = this.callId;
      this.callId = callId;
      if (was) this.stop();
      if (callId) void this.start(callId);
      return;
    }
    if (!callId || !this.ready || !me) return;
    const humans = this.store.callPeers(me).filter(u => !u.bot && u.presence !== 'offline').map(u => u.id);
    for (const id of humans) {
      if (this.peers.has(id)) continue;
      const p = this.createPeer(id);
      if (this.store.me < id) void this.offer(id, p); // lower id makes the offer: no glare
      else this.signal(id, { kind: 'hello', inst: this.inst }); // they may still hold a connection to my old page
    }
    for (const id of [...this.peers.keys()]) if (!humans.includes(id)) this.closePeer(id);
  }

  toggleMute() {
    this.muted = !this.muted;
    for (const t of this.local?.getAudioTracks() ?? []) t.enabled = !this.muted;
    this.store.send({ t: 'mute', muted: this.muted });
    if (this.muted) this.setSpeaking(false);
    this.store.changed();
  }

  /** After a click: retry playback the browser blocked. */
  resumeAudio() {
    void this.ctx?.resume();
    for (const p of this.peers.values()) void p.audio.play().catch(() => {});
    this.needsGesture = false;
    this.store.changed();
  }

  destroy() { this.stop(); this.store.onRtc = undefined; }

  // ---------- lifecycle ----------
  private async start(callId: string) {
    this.inst = rid();
    this.ready = false; this.muted = false; this.micError = null;
    let local: MediaStream | null = null, micError: string | null = null;
    try {
      local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      micError = (e as Error)?.name === 'NotAllowedError' ? 'Microphone blocked: you can listen but not talk' : 'No microphone: listen-only';
    }
    if (this.callId !== callId) { // left (or switched calls) while the permission prompt was open
      for (const t of local?.getTracks() ?? []) t.stop();
      return;
    }
    this.local = local; this.micError = micError;
    if (local) this.startMeter(local);
    else this.store.toast({ kind: 'info', text: micError!, expires: 6000 });
    this.ready = true;
    this.store.changed();
    this.sync();
    const q = this.queued; this.queued = [];
    for (const m of q) await this.onSignal(m.from, m.signal);
  }

  private stop() {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    for (const t of this.local?.getTracks() ?? []) t.stop();
    this.local = null;
    if (this.meter) clearInterval(this.meter);
    this.meter = undefined;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.speaking = false; this.loudTicks = 0; this.quietTicks = 0;
    this.ready = false; this.queued = []; this.muted = false; this.micError = null; this.needsGesture = false;
    this.store.changed();
  }

  // ---------- peers ----------
  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    if (this.local) for (const t of this.local.getAudioTracks()) pc.addTrack(t, this.local);
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    const audio = new Audio();
    audio.autoplay = true;
    const peer: Peer = { pc, audio, pendingIce: [], conn: null, remoteInst: null, awaiting: false };
    pc.onicecandidate = e => {
      if (peer.conn) this.signal(id, { kind: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null, conn: peer.conn });
    };
    pc.ontrack = e => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      audio.play().catch(() => { this.needsGesture = true; this.store.changed(); });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.store.me < id) { pc.restartIce(); void this.offer(id, peer); }
      this.store.changed();
    };
    this.peers.set(id, peer);
    return peer;
  }

  private closePeer(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    p.pc.close();
    p.audio.pause(); p.audio.srcObject = null;
    this.peers.delete(id);
  }

  private async offer(id: string, p: Peer) {
    // a data channel keeps the connection up even when nobody's mic is on (listen-only on both ends)
    if (!p.pc.sctp) p.pc.createDataChannel('deck');
    p.conn ??= rid();
    p.awaiting = true;
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    this.signal(id, { kind: 'offer', sdp: offer.sdp ?? '', conn: p.conn });
  }

  private signal(to: string, signal: RtcSignal) { this.store.send({ t: 'rtc', to, signal }); }

  private async onSignal(from: string, signal: RtcSignal) {
    if (!this.callId) return;
    if (!this.ready) { this.queued.push({ from, signal }); return; }
    const sender = this.store.users.get(from);
    if (!sender || sender.callId !== this.callId) return;
    let p = this.peers.get(from);
    try {
      if (signal.kind === 'hello') {
        if (this.store.me > from) return; // only the offerer acts on hellos
        // our offer is still on its way to their current page, or we're already connected to that page: nothing to do
        if (p && (p.awaiting || p.remoteInst === signal.inst)) return;
        this.closePeer(from); // connected to an old page of theirs (they reloaded): start over
        await this.offer(from, this.createPeer(from));
      } else if (signal.kind === 'offer') {
        if (p && p.conn && p.conn !== signal.conn) { this.closePeer(from); p = undefined; } // a new attempt from them
        p ??= this.createPeer(from);
        p.conn = signal.conn;
        await p.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        await this.flushIce(p);
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        this.signal(from, { kind: 'answer', sdp: answer.sdp ?? '', conn: signal.conn, inst: this.inst });
      } else if (signal.kind === 'answer') {
        // an answer to an older offer (or for a pc we've since replaced) would wire up mismatched credentials
        if (!p || p.conn !== signal.conn || p.pc.signalingState !== 'have-local-offer') return;
        await p.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        p.awaiting = false; p.remoteInst = signal.inst;
        await this.flushIce(p);
      } else {
        if (!p || p.conn !== signal.conn || !signal.candidate) return;
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(signal.candidate);
        else p.pendingIce.push(signal.candidate);
      }
    } catch (e) { console.warn('voice signaling', e); }
  }

  private async flushIce(p: Peer) {
    for (const c of p.pendingIce.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
  }

  // ---------- "am I talking?" for the bubbles ----------
  private startMeter(stream: MediaStream) {
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    this.meter = window.setInterval(() => {
      if (this.muted) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const loud = Math.sqrt(sum / buf.length) > SPEAK_ON;
      this.loudTicks = loud ? this.loudTicks + 1 : 0;
      this.quietTicks = loud ? 0 : this.quietTicks + 1;
      if (!this.speaking && this.loudTicks >= 2) this.setSpeaking(true);       // ~160 ms of voice
      else if (this.speaking && this.quietTicks >= 6) this.setSpeaking(false); // ~0.5 s of quiet
    }, TICK_MS);
  }

  private setSpeaking(on: boolean) {
    if (this.speaking === on) return;
    this.speaking = on;
    this.store.send({ t: 'speaking', on });
  }

  /** For the UI: how many people I'm actually connected to. */
  connectedCount() { return [...this.peers.values()].filter(p => p.pc.connectionState === 'connected').length; }
  peerCount() { return this.peers.size; }
}
