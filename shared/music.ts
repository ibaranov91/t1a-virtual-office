import type { JukeboxState } from './protocol';
import data from './music.json';

export interface Track {
  id: string; file: string; title: string; artist: string; genre: string;
  duration: number; page: string; license: string;
}
export const TRACKS: Track[] = data.tracks;
export const TRACK = new Map(TRACKS.map(t => [t.id, t]));
export const GENRES = [...new Set(TRACKS.map(t => t.genre))];
export const trackUrl = (track: Track) => `/assets/music/${track.file}`;

export const jukeboxPosition = (state: JukeboxState, durationMs: number, now: number) =>
  Math.max(0, Math.min(durationMs, state.pausedAt ?? now - state.startedAt));
