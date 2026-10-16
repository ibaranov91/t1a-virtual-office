import { GB_FPS, type Gb } from '../../../shared/retro/gb';
import type { ServerMsg } from '../../../shared/protocol';
type Batch = Extract<ServerMsg, { t: 'retro_frames' }>;
export class RetroWatcher {
  upto: number;
  private changes: [number, number][] = [];
  private bits: number;
  private receivedAt: number;
  private clock: number | null = null;
  private accumulated = 0;
  draining = false;
  constructor(readonly gb: Gb, bits: number, now: number) { this.upto = gb.frame; this.bits = bits; this.receivedAt = now; }
  receive(batch: Batch, now: number) {
    if (batch.upto <= this.upto) return;
    if (batch.from !== this.upto) throw new Error('Retro stream gap');
    this.changes.push(...batch.changes); this.upto = batch.upto; this.receivedAt = now;
  }
  pause() { this.clock = null; this.accumulated = 0; }
  tick(now: number) {
    const target = this.draining || now - this.receivedAt >= 250 ? this.upto : Math.max(this.gb.frame, this.upto - 15);
    const fast = this.upto - this.gb.frame > GB_FPS * 2;
    if (this.clock === null) this.clock = now;
    this.accumulated += Math.max(0, now - this.clock) * GB_FPS / 1000; this.clock = now;
    const count = Math.min(target - this.gb.frame, fast ? 600 : Math.floor(this.accumulated));
    this.accumulated -= Math.floor(this.accumulated);
    for (let i = 0; i < count; i++) {
      while (this.changes.length && this.changes[0][0] <= this.gb.frame) this.bits = this.changes.shift()![1];
      this.gb.step(this.bits);
    }
    return { count, fast };
  }
}
