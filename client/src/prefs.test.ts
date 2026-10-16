import test from 'node:test';
import assert from 'node:assert/strict';

test('jukebox levels load safely, persist, and leave voices and other music alone', async t => {
  const stored = new Map([['deck.voice', JSON.stringify({ jukeboxVolumes: { music: .35, club: 0, high: 7, low: -1, invalid: 'loud' }, retroVolume: 3, retroMuted: 'yes' })]]);
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  };
  const events = new EventTarget();
  for (const [key, value] of [['localStorage', storage], ['window', events]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const { prefs, savePrefs } = await import('./prefs');
  assert.deepEqual(prefs.jukeboxVolumes, { music: .35, club: 0, high: 1, low: 0 });
  prefs.jukeboxVolumes.music = .6; savePrefs();
  assert.equal(JSON.parse(stored.get('deck.voice')!).jukeboxVolumes.music, .6);
  assert.equal(prefs.jukeboxVolumes.club, 0);
  assert.deepEqual(prefs.mix, { voice: 1, music: 1, effects: 1 });
  assert.deepEqual(prefs.volumes, {});
  assert.equal(prefs.retroVolume, 1); assert.equal(prefs.retroMuted, false); // clamped; only `true` mutes
  prefs.retroVolume = .25; prefs.retroMuted = true; savePrefs();
  assert.deepEqual([JSON.parse(stored.get('deck.voice')!).retroVolume, JSON.parse(stored.get('deck.voice')!).retroMuted], [.25, true]);
});
