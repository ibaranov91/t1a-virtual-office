import Binjgb from '../../vendor/binjgb/binjgb.mjs';
import { normalize } from './buttons';
export const FRAME_TICKS = 70224, GB_FPS = 4194304 / FRAME_TICKS;
export interface Gb {
  frame: number;
  step(bits: number): void;
  read(addr: number): number;
  ext(): Uint8Array;
  takeExtWrite(): boolean;
  state(): Uint8Array;
  restore(s: Uint8Array, frame: number): void;
  screen(): Uint8ClampedArray;
  audio(): Uint8Array[];
  hash(): number;
  destroy(): void;
}
export async function createGb(opts: { wasm: ArrayBuffer | Uint8Array; rom: Uint8Array; save: Uint8Array | null; audioRate: number; audio: boolean }): Promise<Gb> {
  const m = await Binjgb({ wasmBinary: new Uint8Array(opts.wasm), print: () => {}, printErr: () => {} });
  const size = Math.ceil(opts.rom.length / 32768) * 32768, ptr = m._malloc(size);
  let e = 0, joy = 0, state = 0, ext = 0, dead = false;
  const buffers: Uint8Array[] = [];
  const alive = () => { if (dead) throw new Error('Gb is destroyed'); };
  const destroy = () => {
    if (dead) return; dead = true; buffers.length = 0;
    if (state) m._file_data_delete(state);
    if (ext) m._file_data_delete(ext);
    if (joy) m._joypad_delete(joy);
    if (e) m._emulator_delete(e);
    if (ptr) m._free(ptr);
  };
  const copy = (fd: number) => m.HEAPU8.slice(m._get_file_data_ptr(fd), m._get_file_data_ptr(fd) + m._get_file_data_size(fd));
  const load = (fd: number, bytes: Uint8Array) => {
    if (bytes.length !== m._get_file_data_size(fd)) throw new Error('Invalid Gb file size');
    m.HEAPU8.set(bytes, m._get_file_data_ptr(fd));
  };
  try {
    m.HEAPU8.fill(0, ptr, ptr + size); m.HEAPU8.set(opts.rom, ptr);
    e = m._emulator_new_simple(ptr, size, opts.audioRate, 2048, 0);
    if (!e) throw new Error('Invalid Game Boy ROM');
    joy = m._joypad_new(); m._emulator_set_default_joypad_callback(e, joy);
    state = m._state_file_data_new(e); ext = m._ext_ram_file_data_new(e);
    if (opts.save) { load(ext, opts.save); if (m._emulator_read_ext_ram(e, ext)) throw new Error('Invalid cartridge'); }
    const gb: Gb = {
      frame: 0,
      step(bits) {
        alive(); bits = normalize(bits);
        ['right', 'left', 'up', 'down', 'A', 'B', 'select', 'start'].forEach((name, i) => m[`_set_joyp_${name}`](e, (bits >> i) & 1));
        let flags: number;
        do {
          flags = m._emulator_run_until_f64(e, (gb.frame + 1) * FRAME_TICKS);
          if (opts.audio && (flags & 2)) {
            const p = m._get_audio_buffer_ptr(e), n = 2048 * 2;
            buffers.push(m.HEAPU8.slice(p, p + n));
          }
        } while (!(flags & 4));
        gb.frame++;
      },
      read(addr) { alive(); return m._emulator_read_mem(e, addr); },
      ext() { alive(); m._emulator_write_ext_ram(e, ext); return copy(ext); },
      takeExtWrite() { alive(); return !!m._emulator_was_ext_ram_updated(e); },
      state() { alive(); m._emulator_write_state(e, state); return copy(state); },
      restore(s, frame) {
        alive(); if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('Invalid Gb frame');
        load(state, s); if (m._emulator_read_state(e, state)) throw new Error('Invalid Gb state');
        gb.frame = frame; buffers.length = 0;
      },
      screen() { alive(); return new Uint8ClampedArray(m.HEAPU8.buffer, m._get_frame_buffer_ptr(e), 160 * 144 * 4); },
      audio() { alive(); return buffers.splice(0); },
      hash() {
        alive(); let h = 2166136261;
        for (let addr = 0xc000; addr <= 0xdfff; addr++) h = Math.imul(h ^ gb.read(addr), 16777619);
        for (let addr = 0xff80; addr <= 0xfffe; addr++) h = Math.imul(h ^ gb.read(addr), 16777619);
        return h >>> 0;
      },
      destroy,
    };
    return gb;
  } catch (error) { destroy(); throw error; }
}
