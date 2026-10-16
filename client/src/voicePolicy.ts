import { AFK_MS, AFK_GRACE_MS } from '../../shared/protocol';

export const ALONE_MUTE_MS = 60_000;
export const GROUP_MUTE_MS = 5 * 60_000;
export const HINT_SPEECH_MS = 1_000;
export const HINT_COOLDOWN_MS = 30_000;
export const KNOCK_CONSENT_MS = 5 * 60_000;
export const RESUME_MS = 10 * 60_000;
export const MUTED_RELEASE_MS = 2 * 60_000;
export interface CallMemory { muted: boolean; meet: boolean; at: number }
export function knockCallStart({ now, consentAt, memory }: { now: number; consentAt?: number; memory?: CallMemory }) {
  if (consentAt !== undefined && now >= consentAt && now - consentAt <= KNOCK_CONSENT_MS)
    return { muted: false, meet: false, consumed: true };
  if (memory && now >= memory.at && now - memory.at <= RESUME_MS)
    return { muted: memory.muted || memory.meet, meet: memory.meet, consumed: false };
  return { muted: true, meet: false, consumed: false };
}
export function shouldReleaseMic({ now, mutedSince, timeScale = 1 }: { now: number; mutedSince: number | null; timeScale?: number }) {
  return mutedSince !== null && now - mutedSince >= MUTED_RELEASE_MS * timeScale;
}
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
