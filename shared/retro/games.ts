import { lobsterProbe, tobuProbe, type Probe } from './probes';
export type RetroGameId = 'tobu' | 'lobster';
export interface RetroGame {
  id: RetroGameId; title: string; rom: string; sha256: string; bytes: number;
  tracks: { id: string; label: string; unit: 'points' | 'waves'; timed: boolean }[];
  controls: string; credits: string[]; licence: string; links: { label: string; url: string }[]; probe: Probe;
}
export const games: Record<RetroGameId, RetroGame> = {
  tobu: {
    id: 'tobu', title: 'Tobu Tobu Girl Deluxe', rom: 'tobudx.gb', bytes: 262144,
    sha256: '0a0e8018dbbc8d7f8cd99f05e7cdc7b4cc9e358ecfe9377ebfb2291a84c6e310',
    tracks: ['Plains', 'Clouds', 'Space', 'Dream', 'Heaven'].map(label => ({ id: label.toLowerCase(), label, unit: label === 'Heaven' ? 'waves' : 'points', timed: true })),
    controls: '←/→ move · A dash (with a direction) · B jetpack · Start pause',
    credits: ['© 2017 Tangram Games', 'Sound by potato-tan', 'ROM from Homebrew Hub (hh.gbdev.io), unchanged'],
    licence: 'Code: MIT. Graphics, text, sound and music: CC BY 4.0.',
    links: [{ label: 'Source', url: 'https://github.com/SimonLarsen/tobutobugirl-dx' }, { label: 'Tangram Games', url: 'https://tangramgames.dk' }, { label: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }], probe: tobuProbe,
  },
  lobster: {
    id: 'lobster', title: 'Shock Lobster', rom: 'shocklobster.gb', bytes: 32768,
    sha256: 'f14efd0340903b1b00d7e8b4b39687d4bc33355ac7742267ccfddfe92f54a611',
    tracks: ['Slow', 'Medium', 'Fast'].map(label => ({ id: label.toLowerCase(), label, unit: 'points', timed: false })),
    controls: 'A/B use the selected skill pair · D-pad picks the pair · Start pause · Select shows details',
    credits: ['© 2021 Dave VanEe', 'gb-starter-kit and gb-vwf (ISSOtm)', 'hUGEDriver (SuperDisk)', 'Sound effect driver and BCD routines by PinoBatch', 'HiScore library by H. Mulder', 'ROM from Homebrew Hub (hh.gbdev.io), unchanged'],
    licence: 'zlib License', links: [{ label: 'Source', url: 'https://github.com/tbsp/shock-lobster' }, { label: 'zlib License', url: 'https://opensource.org/license/zlib' }], probe: lobsterProbe,
  },
};
