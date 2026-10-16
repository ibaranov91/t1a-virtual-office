import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AFK_MS, AFK_GRACE_MS } from '../../shared/protocol';
import { voicePolicy, knockCallStart, shouldReleaseMic, ALONE_MUTE_MS, GROUP_MUTE_MS, type VoicePolicyState } from './voicePolicy';

const base: VoicePolicyState = { now: 0, surface: 'shared', muted: false, deafened: false, mode: 'voice', micError: null, micOpen: true, onMeet: false, alone: true, aloneSince: 0, lastOwnSpeech: 0, unmutedAt: 0, lastInput: 0, lastHeard: 0, switchedAway: false, idlePromptAt: null };
const run = (s: Partial<VoicePolicyState>) => voicePolicy({ ...base, ...s });
test('alone silence boundary and switching away', () => {
  assert.deepEqual(run({ now: ALONE_MUTE_MS - 1 }), {});
  assert.equal(run({ now: ALONE_MUTE_MS }).mute, 'alone');
  assert.equal(run({ switchedAway: true }).mute, 'away');
  for (const key of ['lastOwnSpeech', 'aloneSince', 'unmutedAt'] as const)
    assert.deepEqual(run({ now: ALONE_MUTE_MS, [key]: 1 }), {});
});
test('company uses five minutes and speech/unmute reset its timer', () => {
  assert.deepEqual(run({ alone: false, now: GROUP_MUTE_MS - 1 }), {});
  assert.equal(run({ alone: false, now: GROUP_MUTE_MS, switchedAway: true }).mute, 'group');
  for (const key of ['lastOwnSpeech', 'unmutedAt'] as const)
    assert.deepEqual(run({ alone: false, now: GROUP_MUTE_MS, [key]: 1 }), {});
});
test('mute exemptions include knock, no call, PTT, deafened, error and already muted', () => {
  for (const exemption of [{ surface: 'knock' }, { surface: 'none' }, { mode: 'ptt' }, { deafened: true }, { micError: 'blocked' }, { muted: true }] as Partial<VoicePolicyState>[])
    assert.equal(run({ now: GROUP_MUTE_MS, switchedAway: true, ...exemption }).mute, undefined);
});
test('idle prompts once on either call surface, regardless of mic mode or availability', () => {
  for (const surface of ['shared', 'knock'] as const) {
    assert.equal(run({ surface, now: AFK_MS - 1 }).prompt, undefined);
    assert.equal(run({ surface, now: AFK_MS, mode: 'ptt', deafened: true, micError: 'blocked', micOpen: false }).prompt, true);
    assert.equal(run({ surface, now: AFK_MS + 1, idlePromptAt: AFK_MS }).prompt, undefined);
  }
});
test('input in any tab, own speech and other speech postpone idle and cancel an old prompt', () => {
  for (const key of ['lastInput', 'lastOwnSpeech', 'lastHeard'] as const) {
    assert.equal(run({ now: AFK_MS, [key]: 1 }).prompt, undefined);
    assert.equal(run({ now: AFK_MS + AFK_GRACE_MS, idlePromptAt: AFK_MS, [key]: AFK_MS + 1 }).leave, undefined);
  }
});
test('leave only after the entire prompt grace and no newer activity', () => {
  assert.equal(run({ now: AFK_MS + AFK_GRACE_MS - 1, idlePromptAt: AFK_MS }).leave, undefined);
  assert.equal(run({ now: AFK_MS + AFK_GRACE_MS, idlePromptAt: AFK_MS }).leave, true);
});
test('Meet and no call skip idle entirely', () => {
  for (const exemption of [{ onMeet: true }, { surface: 'none' }] as Partial<VoicePolicyState>[])
    assert.deepEqual(run({ muted: true, now: AFK_MS * 10, idlePromptAt: AFK_MS, ...exemption }), {});
});
test('time scale multiplies mute, idle and grace durations', () => {
  assert.equal(run({ now: ALONE_MUTE_MS / 2, timeScale: .5 }).mute, 'alone');
  assert.equal(run({ now: GROUP_MUTE_MS / 2, alone: false, timeScale: .5 }).mute, 'group');
  assert.equal(run({ now: AFK_MS / 2, timeScale: .5 }).prompt, true);
  assert.equal(run({ now: (AFK_MS + AFK_GRACE_MS) / 2, idlePromptAt: AFK_MS / 2, timeScale: .5 }).leave, true);
});

test('fresh local knock consent starts live and is consumed, including at five minutes', () => {
  for (const consentAt of [1_000_000, 700_000])
    assert.deepEqual(knockCallStart({ now: 1_000_000, consentAt }), { muted: false, meet: false, consumed: true });
});
test('stale, absent or future consent cannot start a private call live', () => {
  for (const consentAt of [undefined, 699_999, 1_000_001])
    assert.deepEqual(knockCallStart({ now: 1_000_000, consentAt }), { muted: true, meet: false, consumed: false });
});
test('recent call memory restores live, muted and Meet state for ten minutes', () => {
  for (const [muted, meet, wantMuted] of [[false, false, false], [true, false, true], [false, true, true]] as const)
    assert.deepEqual(knockCallStart({ now: 1_000_000, memory: { at: 400_000, muted, meet } }),
      { muted: wantMuted, meet, consumed: false });
});
test('expired or future call memory cannot resume live or On Meet', () => {
  for (const at of [399_999, 1_000_001])
    assert.deepEqual(knockCallStart({ now: 1_000_000, memory: { at, muted: false, meet: true } }),
      { muted: true, meet: false, consumed: false });
});
test('a new local knock overrides old call memory', () => {
  assert.deepEqual(knockCallStart({ now: 1_000_000, consentAt: 1_000_000, memory: { at: 999_999, muted: true, meet: true } }),
    { muted: false, meet: false, consumed: true });
});
test('mic release waits for two continuous muted minutes and respects time scale', () => {
  assert.equal(shouldReleaseMic({ now: 120_999, mutedSince: 1_000 }), false);
  assert.equal(shouldReleaseMic({ now: 121_000, mutedSince: 1_000 }), true);
  assert.equal(shouldReleaseMic({ now: 500_000, mutedSince: null }), false);
  assert.equal(shouldReleaseMic({ now: 4_000, mutedSince: 1_000, timeScale: .025 }), true);
  assert.equal(shouldReleaseMic({ now: 3_999, mutedSince: 1_000, timeScale: .025 }), false);
  assert.equal(shouldReleaseMic({ now: 240_000, mutedSince: 150_000 }), false);
});
