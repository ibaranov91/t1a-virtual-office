import test from 'node:test';
import assert from 'node:assert/strict';
import { DRUM_PADS, INSTRUMENTS, keyNote, noteName, validNote, NoteClock, VELOCITIES, VELOCITY_START } from '../../shared/instruments';

test('musical typing uses physical codes at every supported octave', () => {
  const codes = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ', 'KeyK', 'KeyO', 'KeyL', 'KeyP', 'Semicolon', 'Quote'];
  for (const kind of ['keys', 'bass'] as const) for (let octave = INSTRUMENTS[kind].octave!.min; octave <= INSTRUMENTS[kind].octave!.max; octave++)
    codes.forEach((code, i) => assert.equal(keyNote(kind, code, octave), 12 * (octave + 1) + i));
  assert.equal(keyNote('keys', 'KeyZ', 4), null); assert.equal(keyNote('keys', 'a', 4), null);
  assert.equal(VELOCITIES[VELOCITY_START], 100);
});
test('GM pads, validation and note names', () => {
  const codes = ['KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL','Semicolon','KeyW','KeyE'];
  const notes = [36,38,42,46,39,41,45,48,49,51,37,56];
  codes.forEach((code, i) => { assert.equal(DRUM_PADS[code].note, notes[i]); assert.equal(keyNote('drums', code, 4), notes[i]); assert.ok(validNote('drums', notes[i])); });
  assert.equal(keyNote('drums', 'Quote', 4), null);
  for (const kind of ['keys','bass'] as const) { for (const n of [0,60,127]) assert.ok(validNote(kind, n)); for (const n of [-1,128,1.5,NaN]) assert.equal(validNote(kind, n), false); }
  for (const n of [60,36.5,-1,128]) assert.equal(validNote('drums', n), false);
  assert.equal(noteName(60), 'C4'); assert.equal(noteName(42), 'F#2'); assert.equal(noteName(0), 'C-1');
});
test('NoteClock steady delay, jitter, spikes and arrival-window expiry', () => {
  const c = new NoteClock();
  assert.equal(c.schedule(0,100,true),100); assert.equal(c.schedule(100,200,true),200);
  assert.equal(c.schedule(200,400,true),400); assert.equal(c.schedule(300,410,true),500);
  assert.equal(c.schedule(400,1000,true),1000); // min 100 + span 250; now wins
  assert.equal(c.schedule(500,1010,true),1010); // compressed behind the spike
  assert.equal(c.schedule(1000,1100,true),1350);
  assert.equal(c.schedule(3000,3100,true),3100); // every older arrival expired
  c.reset(); assert.equal(c.schedule(0,100,true),100);
});
test('NoteClock preserves order, negative lateness, drops late ons without changing state', () => {
  const c = new NoteClock();
  assert.equal(c.schedule(500,400,true),400); assert.equal(c.schedule(510,405,true),410);
  assert.equal(c.schedule(0,2000,true),null);
  assert.equal(c.schedule(520,410,true),420); // dropped note did not touch last or recent
  assert.equal(c.schedule(0,1500,false),1500); // offs always scheduled
  assert.equal(c.schedule(530,1510,true),1510);
  c.reset(); assert.equal(c.schedule(100,0,true),0);
});
test('NoteClock keeps exact spacing within the jitter span and uses arrival time at the strict window boundary', () => {
  const c = new NoteClock();
  assert.equal(c.schedule(100,300,true),300);
  assert.equal(c.schedule(200,310,true),400);
  assert.equal(c.schedule(300,350,true),500);
  assert.equal(c.schedule(400,410,true),600);
  c.reset();
  assert.equal(c.schedule(0,500,true),500);
  assert.equal(c.schedule(2100,2200,true),2450); // arrival 500 is still in the 2 s window, despite at=0
  c.reset(); c.schedule(0,500,true);
  assert.equal(c.schedule(2500,2500,true),2500); // arrival exactly now-2000 is excluded
});
