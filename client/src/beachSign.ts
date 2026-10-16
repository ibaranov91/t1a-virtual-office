import { drawText, textWidth } from './font';

/** Lettering shares the floor's pixel font; only the tubes are redrawn after the night tint. */
export function drawBeachSign(ctx: CanvasRenderingContext2D, x: number, y: number, glow = 0) {
  ctx.save();
  ctx.translate(x, y);
  if (glow) {
    ctx.globalAlpha = glow;
    ctx.shadowBlur = 9;
    ctx.shadowColor = '#52f5dd';
  }
  ctx.strokeStyle = glow ? '#8affec' : '#57b9b0'; ctx.lineWidth = 1;
  ctx.strokeRect(4.5, 4.5, 103, 28);
  ctx.save(); ctx.scale(2, 2);
  drawText(ctx, 'OUT OF OFFICE', (56 - textWidth('OUT OF OFFICE')) / 2, 5, glow ? '#c8fff4' : '#a1e5d2');
  ctx.restore();
  if (glow) ctx.shadowColor = '#ff79bb';
  drawText(ctx, 'VACATION · PTO · OFFLINE', (112 - textWidth('VACATION · PTO · OFFLINE')) / 2, 25, glow ? '#ffd0e7' : '#e9a8bf');
  ctx.restore();
}
