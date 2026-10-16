// Screen share, presenter side: capture the screen, send JPEG frames over the WebSocket (contract: shared/protocol.ts).
import { FRAME_MAX_BYTES, FRAME_MAX_SIDE, FRAME_MIN_INTERVAL_MS } from '../../shared/protocol';
import type { Store } from './net';

let stop: (() => void) | null = null;
export const sharing = () => !!stop;
export const stopShare = () => stop?.();

const decodedBytes = (b64: string) => Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

async function run(store: Store, objectId: string, stream: MediaStream) {
  stopShare();
  const video = document.createElement('video');
  video.muted = true; video.srcObject = stream;
  await video.play().catch(() => {});
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
  let seq = 0, last = '', timer = 0, done = false, started = false;
  const end = () => {
    if (done) return; done = true;
    clearInterval(timer); stream.getTracks().forEach(t => t.stop()); video.srcObject = null;
    window.removeEventListener('pagehide', end); unsub(); stop = null;
    if (store.presentation?.presenter === store.me) store.presentStop();
  };
  const unsub = store.subscribe(() => { // the show ended (stopped here, replaced, or the screen went away)
    const mine = store.presentation?.presenter === store.me && !store.presentation.deck;
    if (mine) started = true; else if (started) end();
  });
  stop = end;
  window.addEventListener('pagehide', end);
  stream.getVideoTracks()[0]?.addEventListener('ended', end);
  store.presentShare(objectId);
  window.setTimeout(() => { if (!started) end(); }, 5000); // refused (busy, not beside the screen): don't keep capturing
  timer = window.setInterval(() => {
    if (!video.videoWidth || !started) return; // wait until the server has accepted the share
    const k = Math.min(1, FRAME_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * k); canvas.height = Math.round(video.videoHeight * k);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    let data = '';
    for (let q = 0.7; q >= 0.2; q -= 0.1) {
      data = canvas.toDataURL('image/jpeg', q).slice(23); // after "data:image/jpeg;base64,"
      if (decodedBytes(data) <= FRAME_MAX_BYTES) break;
    }
    if (data === last || decodedBytes(data) > FRAME_MAX_BYTES) return;
    last = data; store.presentFrame(++seq, data);
  }, FRAME_MIN_INTERVAL_MS);
}

/** Ask the browser for a screen (or tab) and start sharing it on the screen object `objectId`. Resolves with an error text, or null. */
export async function startShare(store: Store, objectId: string): Promise<string | null> {
  if (!navigator.mediaDevices?.getDisplayMedia) return 'This browser can\'t share a screen.';
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
  catch { return 'Screen sharing was cancelled.'; }
  await run(store, objectId, stream);
  return null;
}

/** Dev only: a moving test pattern instead of a real screen. */
export async function fakeShare(store: Store, objectId?: string) {
  const id = objectId ?? store.presentOpen ?? store.presentation?.objectId ?? '';
  const c = document.createElement('canvas'); c.width = 960; c.height = 540;
  const g = c.getContext('2d')!;
  const draw = () => {
    const t = Date.now();
    g.fillStyle = '#123'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#ff2d95'; g.fillRect((t / 5) % c.width, 200, 120, 120);
    g.fillStyle = '#fff'; g.font = '48px monospace'; g.fillText(`fake screen ${new Date(t).toLocaleTimeString()}`, 40, 80);
  };
  draw(); setInterval(draw, 100);
  await run(store, id, c.captureStream(10));
}
