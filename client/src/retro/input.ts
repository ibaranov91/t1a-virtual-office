const KEYS: Record<string, number> = { ArrowLeft: 2, KeyA: 2, ArrowRight: 1, KeyD: 1, ArrowUp: 4, KeyW: 4, ArrowDown: 8, KeyS: 8, Space: 16, KeyZ: 16, KeyJ: 16, KeyX: 32, KeyK: 32, Enter: 128, ShiftLeft: 64, ShiftRight: 64 };
const textField = (target: EventTarget | null) => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]');

export class RetroInput {
  private held = new Set<string>();
  private blocked = new Set<string>();
  private touches = new Map<number, number>();
  private open = false;
  constructor(private root: HTMLElement, private options: {
    enabled(): boolean; ptt(): boolean; menu(): void; spectator(): boolean;
  }) {
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
    if (!(e.code in KEYS)) return;
    e.preventDefault();
    if (!e.repeat && !this.blocked.has(e.code)) this.held.add(e.code);
  };
  private up = (e: KeyboardEvent) => { this.held.delete(e.code); this.blocked.delete(e.code); };
  touch(pointer: number, bits: number) { if (bits) this.touches.set(pointer, bits); else this.touches.delete(pointer); }
  sample() {
    this.refresh();
    if (!this.open || this.options.spectator()) return 0;
    let bits = 0;
    for (const key of this.held) if (key !== 'Space' || !this.options.ptt()) bits |= KEYS[key];
    for (const touch of this.touches.values()) bits |= touch;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad || pad.mapping !== 'standard') continue;
      if (pad.buttons[14]?.pressed || pad.axes[0] < -.35) bits |= 2;
      if (pad.buttons[15]?.pressed || pad.axes[0] > .35) bits |= 1;
      if (pad.buttons[12]?.pressed || pad.axes[1] < -.35) bits |= 4;
      if (pad.buttons[13]?.pressed || pad.axes[1] > .35) bits |= 8;
      if (pad.buttons[8]?.pressed) bits |= 64;
      if (pad.buttons[9]?.pressed) bits |= 128;
      if (pad.buttons[0]?.pressed) bits |= 16;
      if (pad.buttons[1]?.pressed || pad.buttons[2]?.pressed) bits |= 32;
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
