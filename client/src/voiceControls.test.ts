import assert from 'node:assert/strict';
import { test } from 'node:test';
import { voiceControlState } from './voiceControls';

const live = { muted: false, deafened: false, micError: null, mode: 'voice' as const };

test('deafening shows the microphone off and lets its button restore hearing', () => {
  const mic = voiceControlState('mic', { ...live, deafened: true });
  assert.equal(mic.off, true);
  assert.equal(mic.action, 'toggleDeafen');
  assert.equal(mic.label, 'Undeafen');
});

test('microphone and headphones have independent mute states', () => {
  const voice = { ...live, muted: true };
  assert.equal(voiceControlState('mic', voice).off, true);
  assert.equal(voiceControlState('mic', voice).action, 'toggleMute');
  assert.equal(voiceControlState('headphones', voice).off, false);
  assert.equal(voiceControlState('headphones', voice).action, 'toggleDeafen');
});

test('a blocked microphone is shown off without implying a mute click fixes permission', () => {
  const mic = voiceControlState('mic', { ...live, micError: 'Microphone blocked' });
  assert.equal(mic.off, true);
  assert.equal(mic.state, 'err');
  assert.equal(mic.label, 'Microphone unavailable');
  assert.equal(mic.title, 'Microphone blocked');
});

test('unavailable voice does not appear as a live microphone and retains saved deafen state', () => {
  assert.equal(voiceControlState('mic', null).off, true);
  assert.equal(voiceControlState('headphones', null, true).off, true);
});
