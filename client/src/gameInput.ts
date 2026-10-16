// Keyboard, touch and gamepad input for the arcade overlays (Deck Park, party games, Game Boy cabinets), as one
// bitmask sampled per frame. Keys only count while the overlay has focus, so typing elsewhere never moves anyone.

/** The bit each control sets. Each game picks its own layout: the Game Boy swaps left and right and adds Select/Start. */
export interface ButtonBits { left: number; right: number; up: number; down: number; a: number; b: number; select?: number; start?: number }

const textField = (target: EventTarget | null) => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]');

const keyMap = (bits: ButtonBits): Record<string, number> => {
  const keys: Record<string, number> = {
    ArrowLeft: bits.left, KeyA: bits.left, ArrowRight: bits.right, KeyD: bits.right, ArrowUp: bits.up, KeyW: bits.up,
    ArrowDown: bits.down, KeyS: bits.down, Space: bits.a, KeyZ: bits.a, KeyJ: bits.a, KeyX: bits.b, KeyK: bits.b,
    ShiftLeft: bits.select ?? bits.b, ShiftRight: bits.select ?? bits.b,
  };
  if (bits.start) keys.Enter = bits.start;
  return keys;
};

export class GameInput {
  private keys: Record<string, number>;
  private held = new Set<string>();
  private blocked = new Set<string>();
  private touches = new Map<number, number>();
  private open = false;
  constructor(private root: HTMLElement, private bits: ButtonBits, private options: {
    enabled(): boolean; ptt(): boolean; menu(): void; spectator(): boolean;
    cheer?(kind: 0 | 1 | 2): void; // spectators cheer with 1, 2 and 3
  }) {
    this.keys = keyMap(bits);
    window.addEventListener('keydown', this.down);
    window.addEventListener('keyup', this.up);
    window.addEventListener('blur', this.refresh);
    document.addEventListener('visibilitychange', this.refresh);
    document.addEventListener('focusin', this.refresh);
    document.addEventListener('focusout', this.focusOut);
    this.refresh();
  }
  private gate() {
    return this.options.enabled() && !document.hidden && document.hasFocus() &&
      this.root.contains(document.activeElement) && !textField(document.activeElement);
  }
  refresh = () => {
    const open = this.gate();
    if (!open) { for (const code of this.held) this.blocked.add(code); this.held.clear(); this.touches.clear(); }
    this.open = open;
  };
  private focusOut = () => { queueMicrotask(this.refresh); };
  private down = (e: KeyboardEvent) => {
    // Voice owns both Space events in PTT mode, including default handling.
    if (e.code === 'Space' && this.options.ptt()) return;
    if (textField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && !e.repeat && document.hasFocus() && this.root.contains(document.activeElement)) {
      e.preventDefault(); this.options.menu(); this.refresh(); return;
    }
    this.refresh();
    if (!this.open) return;
    const cheer = this.options.cheer;
    if (cheer && this.options.spectator() && ['Digit1', 'Digit2', 'Digit3'].includes(e.code)) {
      e.preventDefault(); if (!e.repeat) cheer((Number(e.code.slice(-1)) - 1) as 0 | 1 | 2); return;
    }
    if (!(e.code in this.keys)) return;
    e.preventDefault();
    if (!e.repeat && !this.blocked.has(e.code)) this.held.add(e.code);
  };
  private up = (e: KeyboardEvent) => { this.held.delete(e.code); this.blocked.delete(e.code); };
  touch(pointer: number, bits: number) { if (bits) this.touches.set(pointer, bits); else this.touches.delete(pointer); }
  sample() {
    this.refresh();
    if (!this.open || this.options.spectator()) return 0;
    const b = this.bits;
    let bits = 0;
    for (const key of this.held) if (key !== 'Space' || !this.options.ptt()) bits |= this.keys[key];
    for (const touch of this.touches.values()) bits |= touch;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad || pad.mapping !== 'standard') continue;
      if (pad.buttons[14]?.pressed || pad.axes[0] < -.35) bits |= b.left;
      if (pad.buttons[15]?.pressed || pad.axes[0] > .35) bits |= b.right;
      if (pad.buttons[12]?.pressed || pad.axes[1] < -.35) bits |= b.up;
      if (pad.buttons[13]?.pressed || pad.axes[1] > .35) bits |= b.down;
      if (b.select && pad.buttons[8]?.pressed) bits |= b.select;
      if (b.start && pad.buttons[9]?.pressed) bits |= b.start;
      if (pad.buttons[0]?.pressed) bits |= b.a;
      if (pad.buttons[1]?.pressed || pad.buttons[2]?.pressed) bits |= b.b;
    }
    return bits;
  }
  destroy() {
    window.removeEventListener('keydown', this.down); window.removeEventListener('keyup', this.up);
    window.removeEventListener('blur', this.refresh); document.removeEventListener('visibilitychange', this.refresh);
    document.removeEventListener('focusin', this.refresh); document.removeEventListener('focusout', this.focusOut);
    this.held.clear(); this.touches.clear();
  }
}
