import { GB_FPS, type Gb } from '../../../shared/retro/gb';
import { normalize } from '../../../shared/retro/buttons';
import type { ClientMsg } from '../../../shared/protocol';
export type FrameBatch = Extract<ClientMsg, { t: 'retro_frames' }>;
export class RetroPlayer {
  private clock: number | null = null;
  private accumulated = 0;
  private sentAt: number | null = null;
  private from: number;
  private bits = -1;
  private changes: [number, number][] = [];
  constructor(readonly gb: Gb, private runId: string, private sync: number, private send: (batch: FrameBatch) => void) { this.from = gb.frame; }
  pause() { this.clock = null; this.accumulated = 0; }
  tick(now: number, sample: (frame: number) => number) {
    if (this.clock === null) { this.clock = now; this.sentAt ??= now; return 0; }
    this.accumulated += Math.max(0, now - this.clock) * GB_FPS / 1000; this.clock = now;
    const count = Math.min(4, Math.floor(this.accumulated)); this.accumulated -= Math.floor(this.accumulated);
    for (let i = 0; i < count; i++) {
      const bits = normalize(sample(this.gb.frame));
      if (bits !== this.bits) { this.changes.push([this.gb.frame, bits]); this.bits = bits; }
      this.gb.step(bits);
    }
    if (now - (this.sentAt ?? now) >= 100 && this.gb.frame > this.from) { this.flush(); this.sentAt = now; }
    return count;
  }
  flush() {
    if (this.gb.frame === this.from) return;
    this.send({ t: 'retro_frames', runId: this.runId, sync: this.sync, from: this.from, upto: this.gb.frame, changes: this.changes });
    this.from = this.gb.frame; this.changes = [];
  }
}
