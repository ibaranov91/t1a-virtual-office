import { AFK_MS, AFK_GRACE_MS } from '../../shared/protocol';

export const ALONE_MUTE_MS = 60_000;
export const GROUP_MUTE_MS = 5 * 60_000;
export const HINT_SPEECH_MS = 1_000;
export const HINT_COOLDOWN_MS = 30_000;
export interface VoicePolicyState {
  now: number; surface: 'shared' | 'knock' | 'none'; muted: boolean; deafened: boolean;
  mode: 'voice' | 'ptt'; micError: string | null; micOpen: boolean; onMeet: boolean;
  alone: boolean; aloneSince: number; lastOwnSpeech: number; unmutedAt: number;
  lastInput: number; lastHeard: number; switchedAway: boolean; idlePromptAt: number | null;
  timeScale?: number;
}
export function voicePolicy(s: VoicePolicyState) {
  const result: { mute?: 'alone' | 'group' | 'away'; prompt?: true; leave?: true } = {};
  const scale = s.timeScale ?? 1;
  if (s.surface === 'shared' && s.mode === 'voice' && !s.muted && !s.deafened && !s.micError) {
    if (s.alone && s.switchedAway) result.mute = 'away';
    else if (s.now - Math.max(s.lastOwnSpeech, s.unmutedAt, s.alone ? s.aloneSince : 0) >= (s.alone ? ALONE_MUTE_MS : GROUP_MUTE_MS) * scale)
      result.mute = s.alone ? 'alone' : 'group';
  }
  const activity = Math.max(s.lastInput, s.lastOwnSpeech, s.lastHeard);
  if (s.surface !== 'none' && !s.onMeet && s.now - activity >= AFK_MS * scale) {
    if (s.idlePromptAt === null || activity > s.idlePromptAt) result.prompt = true;
    else if (s.now - s.idlePromptAt >= AFK_GRACE_MS * scale) result.leave = true;
  }
  return result;
}
