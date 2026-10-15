export type InstrumentKind = 'keys' | 'drums' | 'bass';
export interface InstrumentInfo { name: string; icon: string; presets: string[]; octave?: { min: number; max: number; start: number } }
export const INSTRUMENTS: Record<InstrumentKind, InstrumentInfo> = {
  keys: { name: 'Keys', icon: '🎹', presets: ['E-piano', 'Organ', 'Synth lead'], octave: { min: 2, max: 6, start: 4 } },
  bass: { name: 'Bass', icon: '🎸', presets: ['Synth bass', 'Sub bass'], octave: { min: 1, max: 3, start: 2 } },
  drums: { name: 'Drums', icon: '🥁', presets: ['Kit'] },
};
export const VELOCITIES = [40, 60, 80, 100, 127];
export const VELOCITY_START = 3;
const KEY_CODES = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ', 'KeyK', 'KeyO', 'KeyL', 'KeyP', 'Semicolon', 'Quote'];
export const DRUM_PADS: Record<string, { note: number; name: string }> = {
  KeyA: { note: 36, name: 'Kick' }, KeyS: { note: 38, name: 'Snare' },
  KeyD: { note: 42, name: 'Closed hat' }, KeyF: { note: 46, name: 'Open hat' },
  KeyG: { note: 39, name: 'Clap' }, KeyH: { note: 41, name: 'Low tom' },
  KeyJ: { note: 45, name: 'Mid tom' }, KeyK: { note: 48, name: 'High tom' },
  KeyL: { note: 49, name: 'Crash' }, Semicolon: { note: 51, name: 'Ride' },
  KeyW: { note: 37, name: 'Rim' }, KeyE: { note: 56, name: 'Cowbell' },
};
export function keyNote(kind: InstrumentKind, code: string, octave: number): number | null {
  if (kind === 'drums') return Object.hasOwn(DRUM_PADS, code) ? DRUM_PADS[code].note : null;
  const semitone = KEY_CODES.indexOf(code);
  return semitone < 0 ? null : 12 * (octave + 1) + semitone;
}
export const noteName = (note: number) => `${['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][note % 12]}${Math.floor(note / 12) - 1}`;
export const validNote = (kind: InstrumentKind, note: number) => Number.isInteger(note) && (kind === 'drums'
  ? Object.values(DRUM_PADS).some(p => p.note === note) : note >= 0 && note <= 127);

export const CLOCK_WINDOW_MS = 2000, CLOCK_SPAN_MS = 250, CLOCK_DROP_MS = 1000;
export class NoteClock {
  private recent: { arrival: number; late: number }[] = [];
  private last = -Infinity;
  schedule(at: number, now: number, on: boolean): number | null {
    const late = now - at;
    if (on && late > CLOCK_DROP_MS) return null;
    this.recent = this.recent.filter(e => e.arrival > now - CLOCK_WINDOW_MS);
    this.recent.push({ arrival: now, late });
    const lates = this.recent.map(e => e.late);
    const delay = Math.min(Math.max(...lates), Math.min(...lates) + CLOCK_SPAN_MS);
    return this.last = Math.max(at + delay, this.last, now);
  }
  reset() { this.recent = []; this.last = -Infinity; }
}
