// Observation only: this module never creates an audio graph or controls media playback.
type Data = Record<string, unknown>;
type RecordEntry = Data & { t: number; p: number; seq: number; type: string };
type Session = { connected: boolean; readonly sessionId: string };
export const shortHash = (value: string) => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
};
const rounded = (value: number) => Math.round(value * 10000) / 10000;
const message = (value: unknown) => {
  try { return value instanceof Error ? `${value.name}: ${value.message}` : typeof value === 'string' ? value : JSON.stringify(value) ?? String(value); }
  catch { return '[unprintable]'; }
};
export function trackInfo(track: MediaStreamTrack) {
  try {
    const settings = track.getSettings();
    let caps: MediaTrackCapabilities | undefined;
    try { caps = track.getCapabilities?.(); } catch { /* Some WebKit versions expose an unsupported method. */ }
    const redact = (v: object | undefined) => v && Object.fromEntries(Object.entries(v).map(([k, x]) =>
      [k, /^(deviceId|groupId)$/.test(k) && typeof x === 'string' ? shortHash(x) : x]));
    return { label: track.label, id: track.id, enabled: track.enabled, muted: track.muted, readyState: track.readyState,
      settings: redact(settings), capabilities: redact(caps) };
  } catch (e) { return { error: message(e) }; }
}
const statFields: Record<string, string[]> = {
  'inbound-rtp': 'packetsReceived packetsLost jitter jitterBufferDelay jitterBufferTargetDelay jitterBufferEmittedCount totalSamplesReceived concealedSamples silentConcealedSamples concealmentEvents insertedSamplesForDeceleration removedSamplesForAcceleration audioLevel totalAudioEnergy totalSamplesDuration bytesReceived'.split(' '),
  'outbound-rtp': ['packetsSent', 'bytesSent'],
  'media-source': ['audioLevel', 'totalAudioEnergy'],
  'remote-inbound-rtp': ['roundTripTime', 'fractionLost', 'packetsLost'],
};
export async function peerStats(pc: RTCPeerConnection) {
  const report = await pc.getStats(), stats: Data[] = [];
  report.forEach(s => {
    if ((s.kind ?? s.mediaType) !== 'audio' || !statFields[s.type]) return;
    const item: Data = { type: s.type, id: s.id };
    for (const key of statFields[s.type]) if (typeof s[key] === 'number') item[key] = rounded(s[key]);
    stats.push(item);
  });
  const selected = new Set<string>();
  report.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) selected.add(s.selectedCandidatePairId); });
  report.forEach(s => {
    if (s.type !== 'candidate-pair' || !(selected.has(s.id) || s.selected || (selected.size === 0 && s.nominated && s.state === 'succeeded'))) return;
    stats.push({ type: s.type, currentRoundTripTime: s.currentRoundTripTime, availableOutgoingBitrate: s.availableOutgoingBitrate,
      localCandidateType: report.get(s.localCandidateId)?.candidateType, remoteCandidateType: report.get(s.remoteCandidateId)?.candidateType });
  });
  return stats;
}
class Recorder {
  private records: RecordEntry[] = [];
  private seq = 0;
  private envRecorded = false;
  private dropped = 0;
  private page = typeof crypto !== 'undefined' ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  private store?: Session;
  private environment?: () => Data;
  private sample?: () => Promise<Data>;
  private ctx: AudioContext | null = null;
  private call: string | null = null;
  private sampling = false;
  private uploading = false;
  private timer?: number;
  private previous?: { p: number; time: number };
  private expected = 0;
  private elements = new WeakMap<HTMLAudioElement, string>();
  constructor() {
    if (typeof window === 'undefined' || typeof window.setInterval !== 'function' || typeof document === 'undefined') return;
    Object.assign(window, { __voiceDiag: this });
    window.setInterval(() => { void this.flush(); }, 3000);
    for (const type of ['focus', 'blur', 'online', 'offline', 'pageshow', 'pagehide']) window.addEventListener(type, () => {
      this.event(type, { visibility: document.visibilityState, focus: document.hasFocus() });
      if (type === 'pagehide') void this.flush(true);
    });
    document.addEventListener('visibilitychange', () => this.event('visibilitychange', { visibility: document.visibilityState, focus: document.hasFocus() }));
    navigator.mediaDevices?.addEventListener('devicechange', () => { void this.devices().then(devices => this.event('devicechange', { devices })); });
    for (const level of ['warn', 'error'] as const) {
      const original = console[level];
      console[level] = (...args: unknown[]) => { original.apply(console, args); this.event('console', { level, message: args.map(message).join(' ').slice(0, 300) }); };
    }
    window.addEventListener('error', e => this.event('error', { message: e.message.slice(0, 300), stack: String(e.error?.stack ?? '').slice(0, 300) }));
    window.addEventListener('unhandledrejection', e => this.event('unhandledrejection', { message: message(e.reason).slice(0, 300), stack: String(e.reason?.stack ?? '').slice(0, 300) }));
  }
  event(type: string, data: Data = {}) {
    try {
      // Copy now: preference objects and other live values must not rewrite past events.
      const record = JSON.parse(JSON.stringify({ ...data, t: Date.now(), p: Math.round(performance.now()), seq: ++this.seq, type }, (_key, value) => typeof value === 'number' && !Number.isInteger(value) ? rounded(value) : value)) as RecordEntry;
      this.records.push(record);
      if (this.records.length > 2000) { this.dropped += this.records.length - 2000; this.records.splice(0, this.records.length - 2000); }
    } catch { /* Diagnostics must never interrupt the observed code. */ }
  }
  dump(): RecordEntry[] { return JSON.parse(JSON.stringify(this.records)); }
  bind(store: Session, environment: () => Data, sample: () => Promise<Data>) {
    this.store = store; this.environment = environment; this.sample = sample;
    if (!this.envRecorded) { this.envRecorded = true; queueMicrotask(() => { void this.env(); }); }
    return () => { if (this.store === store) { this.setCall(null); this.store = undefined; this.sample = undefined; this.environment = undefined; } };
  }
  observeContext(ctx: AudioContext) {
    this.ctx = ctx;
    this.event('context', { event: 'created', ...this.context() });
    ctx.addEventListener('statechange', () => this.event('context', { state: ctx.state, currentTime: rounded(ctx.currentTime) }));
  }
  private context() {
    const c = this.ctx;
    return c ? { state: c.state, sampleRate: c.sampleRate, baseLatency: c.baseLatency, outputLatency: c.outputLatency, currentTime: rounded(c.currentTime) } : null;
  }
  private async devices() {
    try { return (await navigator.mediaDevices?.enumerateDevices() ?? []).map(d => ({ kind: d.kind, label: d.label, deviceId: shortHash(d.deviceId), groupId: shortHash(d.groupId) })); }
    catch (e) { return { error: message(e) }; }
  }
  private async env() {
    const data = { ...this.environment?.(), callId: this.call, ua: navigator.userAgent, ctx: this.context(), visibility: document.visibilityState,
      focus: document.hasFocus(), devicePixelRatio, hardwareConcurrency: navigator.hardwareConcurrency };
    this.event('env', { ...data, devices: await this.devices() });
  }
  setCall(call: string | null) {
    if (call === this.call) return;
    this.call = call; clearInterval(this.timer); this.previous = undefined;
    if (call) {
      // Defer enumeration and snapshots until after the existing synchronous call setup.
      queueMicrotask(() => { void this.env(); });
      this.expected = performance.now() + 1000;
      this.timer = window.setInterval(() => { void this.tick(); }, 1000);
    }
  }
  private async tick() {
    const now = performance.now(), lag = Math.round(Math.max(0, now - this.expected)); this.expected = now + 1000;
    if (this.sampling || !this.call || !this.sample) return;
    this.sampling = true;
    const callId = this.call, ctx = this.context();
    const ctxRate = this.ctx && this.previous ? rounded((this.ctx.currentTime - this.previous.time) / ((now - this.previous.p) / 1000)) : null;
    if (this.ctx) this.previous = { p: now, time: this.ctx.currentTime };
    try { const data = await this.sample(); this.event('sample', { ...data, callId, ctx: ctx && { ...ctx, ctxRate }, lag }); }
    catch (e) { this.event('sample_error', { message: message(e) }); }
    finally { this.sampling = false; }
  }
  watchElement(id: string, el: HTMLAudioElement) {
    this.elements.set(el, id); let lastVolume = -Infinity;
    for (const type of ['play', 'playing', 'pause', 'waiting', 'stalled', 'suspend', 'emptied', 'ended', 'error', 'canplay', 'loadedmetadata', 'ratechange', 'volumechange']) el.addEventListener(type, () => {
      if (type === 'volumechange') { const now = performance.now(); if (now - lastVolume < 1000) return; lastVolume = now; }
      this.event('element', { id, event: type, volume: rounded(el.volume), muted: el.muted, playbackRate: el.playbackRate,
        ...(el.error ? { code: el.error.code, message: el.error.message } : {}) });
    });
  }
  mediaResult(el: HTMLAudioElement, result: string) { const id = this.elements.get(el); if (id) this.event('playMedia', { id, result }); }
  async flush(keepalive = false) {
    const store = this.store;
    if (this.uploading || !store?.connected || !this.records.length) return;
    this.uploading = true;
    // Keep batches below both the endpoint's byte limit and fetch keepalive's 64 KiB budget.
    const records: RecordEntry[] = [], dropped = this.dropped;
    let bytes = 0;
    for (const record of this.records) {
      const size = new TextEncoder().encode(JSON.stringify(record)).length;
      if (bytes + size > 48 * 1024) break;
      records.push(record); bytes += size + 1;
    }
    if (!records.length) { this.records.shift(); this.dropped++; this.uploading = false; return; }
    try {
      const response = await fetch('/api/diag', { method: 'POST', headers: { 'content-type': 'application/json', 'x-deck-session': store.sessionId },
        body: JSON.stringify({ page: this.page, ua: navigator.userAgent.slice(0, 400), records: records.map((r, i) => i === 0 && dropped ? { ...r, dropped } : r) }), keepalive });
      if (response.ok) { const last = records.at(-1)!.seq; this.records = this.records.filter(r => r.seq > last); this.dropped -= dropped; }
    } catch { /* Keep records, within the same cap, for the next attempt. */ }
    finally { this.uploading = false; }
  }
}
export const diag = new Recorder();
declare global { interface Window { __voiceDiag: typeof diag } }
