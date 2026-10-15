// The Music room after dark: the room dims and a disco ball comes out over the dance floor. While the jukebox plays
// the ball turns and throws coloured spots around the room, and people in a room with music dance at any hour.
import { roomAt, type MapObject, type Rect, type TileMap } from '../../shared/map';
import { danceBeat, dancePhase } from '../../shared/effects';
import type { Assets } from './assets';

/** 0 by day to 1 at night: in with the sunset tint (17:30–18:30), out at dawn (6–7). */
export const evening = (h: number) => h < 6 ? 1 : h < 7 ? 7 - h : h < 17.5 ? 0 : h < 18.5 ? h - 17.5 : 1;

/** A room's disco, in art pixels: the area it lights (the room and its back wall) and the floor point under the ball. */
export interface Disco { clip: Rect; x: number; y: number; jukebox?: MapObject }
export function discos(m: TileMap): Disco[] {
  const ts = m.tileSize;
  return m.rooms.filter(r => r.disco).map(r => {
    let top = r.rect.y;
    while (top > 0 && (m.tiles[m.layers.walls[top - 1][r.rect.x]] ?? '').startsWith('wall_face')) top--;
    return {
      clip: { x: r.rect.x * ts, y: top * ts, w: r.rect.w * ts, h: (r.rect.y + r.rect.h - top) * ts },
      x: r.disco!.x * ts, y: r.disco!.y * ts,
      jukebox: m.objects.find(o => o.use?.kind === 'jukebox' && roomAt(m, o.x, o.y)?.id === r.id),
    };
  });
}

export interface DanceStep { dx: number; dy: number; turn: -1 | 0 | 1 }
/** Where a dancer is on this beat, into `out` (drawn every frame): everyone dips on the beat; by `seed` some sway
 *  side to side and some turn to look around. Seated people only nod. `now` is Date.now(): the office's one beat, Berghain's too. */
export function dance(now: number, seed: number, seated: boolean, out: DanceStep): DanceStep {
  const beat = danceBeat(now);
  out.dy = dancePhase(now) < 0.3 ? 1 : 0; out.dx = 0; out.turn = 0;
  if (seated) return out;
  const style = seed % 3;
  if (style === 0) out.dx = (beat >> 1) % 2 ? 1 : -1;
  else if (style === 1) out.turn = beat % 4 === 2 ? -1 : beat % 4 === 3 ? 1 : 0;
  else { out.dx = beat % 2 ? 1 : 0; out.turn = beat % 8 === 6 ? 1 : beat % 8 === 7 ? -1 : 0; }
  return out;
}

const HANG = 27;      // the ball's centre above its floor point: near the ceiling
const TURN = 260;     // ms per frame of the ball's turn
const DIM = 'rgb(80,60,170)', DIM_ALPHA = 0.45, HAZE = 'rgb(70,40,140)', HAZE_ALPHA = 0.22;
// spots: a radius (in room half-widths) and a start angle each; they circle the ball's floor point as it turns
const SPOT_R = [0.3, 0.5, 0.62, 0.75, 0.86, 0.97, 1.08, 1.16, 0.42, 1.25];
const SPOT_A = [0.4, 2.6, 4.9, 1.3, 3.7, 5.8, 0.9, 3.1, 5.4, 2.1];
const SPOT_SPEED = (Math.PI * 2) / 16000; // one lap in 16 s
const SPOT = [0, 1, 2, 3, 4].map(i => `disco_spot_${i}`), BALL = [0, 1, 2, 3].map(i => `disco_${i}`);
const GLINT_X = [-3, 2, 3, -1, -4, 1], GLINT_Y = [-2, -4, 1, 3, 1, -1];

function blit(ctx: CanvasRenderingContext2D, assets: Assets, name: string, cx: number, cy: number) {
  const fr = assets.atlas.frames[name];
  if (fr) ctx.drawImage(assets.world, fr.x, fr.y, fr.w, fr.h, Math.round(cx - fr.w / 2), Math.round(cy - fr.h / 2), fr.w, fr.h);
}

/** The room's darkness, ball and spots: over the furniture and people, under nameplates. */
export function drawDisco(ctx: CanvasRenderingContext2D, assets: Assets, d: Disco, ms: number, dusk: number, playing: boolean) {
  if (dusk <= 0) return;
  const { clip } = d;
  ctx.save();
  ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip();
  ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = DIM_ALPHA * dusk; ctx.fillStyle = DIM;
  ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
  ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = HAZE_ALPHA * dusk; ctx.fillStyle = HAZE; // a violet haze, not just dark
  ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
  if (playing) {
    const rx = Math.min(d.x - clip.x, clip.x + clip.w - d.x), ry = rx * 0.8;
    for (let i = 0; i < SPOT_R.length; i++) {
      const a = SPOT_A[i] - ms * SPOT_SPEED;
      ctx.globalAlpha = dusk * (0.75 + 0.25 * Math.sin(ms / 340 + i * 1.7));
      blit(ctx, assets, SPOT[i % SPOT.length], d.x + Math.cos(a) * rx * SPOT_R[i], d.y + Math.sin(a) * ry * SPOT_R[i]);
    }
  }
  // the ball hangs over everything, at ceiling height, on a string that fades up into the dark
  ctx.restore(); ctx.save(); ctx.globalAlpha = dusk;
  const by = d.y - HANG;
  blit(ctx, assets, 'disco_string', d.x, by - 14);
  blit(ctx, assets, BALL[playing ? Math.floor(ms / TURN) % 4 : 0], d.x, by);
  if (playing) {
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 2; k++) {
      const t = ms / 420 + k * 0.5, n = Math.floor(t), g = (n * 5 + k * 3) % GLINT_X.length;
      ctx.globalAlpha = dusk * (1 - Math.abs((t - n) * 2 - 1));
      blit(ctx, assets, 'disco_glint', d.x + GLINT_X[g], by + GLINT_Y[g]);
    }
  }
  ctx.restore();
}
