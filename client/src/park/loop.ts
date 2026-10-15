import { Runner } from '../../../shared/park/runner';
import type { ParkIncoming, ParkOutgoing } from '../../../shared/park/types';
import { playPark } from '../sounds';

/** One runner per page, retained across overlay mounts and reconnects (including its input sequence). */
export class ParkLoop {
  readonly runner: Runner;
  private raf = 0;
  private stopFrame: (() => void) | null = null;
  constructor(userId: string, send: (msg: ParkOutgoing) => void) {
    this.runner = new Runner({ userId, transport: { send }, now: () => performance.now() });
    if (import.meta.env.DEV) Object.assign(window, { __park: this.runner.debug });
  }
  receive(msg: ParkIncoming) { this.runner.receive(msg); }
  start(sample: () => number, draw: () => void) {
    this.stop();
    let active = true;
    const frame = () => {
      if (!active) return;
      this.runner.setLocalBits(sample());
      this.runner.tick();
      for (const fx of this.runner.drainFx()) playPark(fx.kind);
      draw();
      this.raf = requestAnimationFrame(frame);
    };
    const stop = () => { active = false; cancelAnimationFrame(this.raf); this.runner.setLocalBits(0); };
    this.stopFrame = stop;
    this.raf = requestAnimationFrame(frame);
    return () => { stop(); if (this.stopFrame === stop) this.stopFrame = null; };
  }
  stop() { this.stopFrame?.(); this.stopFrame = null; }
}
