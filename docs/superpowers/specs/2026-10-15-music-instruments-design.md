# Music room: playable instruments — design

Owner: Andrii Butko · 2026-10-15 · status: v2, after a Codex spec review · builds on
`2026-10-15-music-room-design.md` (jukebox), `2026-10-15-sound-v2-design.md` (mixer, Music category) and
`2026-10-15-open-talk-rooms-design.md` (soundscape). Only what changes is here.

## Goal

«Put instruments in the Music room: you play them like in GarageBand, and whoever walks into the room hears you.»

- Three instruments on a little stage in the Music room: **keys**, **drums**, **bass**. One player each, so three
  people can jam.
- You click an instrument, walk over, stand behind it and play with the computer keyboard (GarageBand's "musical
  typing"). Esc or any step away stands you up.
- Everyone else hears you **in near real time through the soundscape**: the notes sound at the instrument and fill
  the Music room with its echo (gain ≥ 0.4 anywhere inside). Since sound v3 rooms are sealed, so nobody outside Music
  hears it, the Desks door included: you walk in to listen. The personal **Music** slider and deafen apply. No
  microphone, no WebRTC.
- All sound is **synthesized** in the browser (no audio files, no licenses). Keys and bass have several sounds.
- While anyone plays, the jukebox in that room **ducks** for everyone and comes back when they stop.

Built in one pass: everything below ships together.

## Out of scope

Recording, loops, a metronome or shared tempo; MIDI keyboards; on-screen keys you click or tap (the panel shows the
layout, but input is the keyboard only); compensating the network delay between people jamming (each hears the others
with the usual WebSocket latency); playing from phones (you can stand at an instrument, the panel says a keyboard is
needed).

## 1. Approach

A note is a tiny event (`instrument`, `note`, `velocity`, on/off, `preset`, the time it was played) sent over the
existing WebSocket. The server checks the sender is the instrument's current player, rate-limits, and relays it to
everyone else. Every client synthesizes the note itself into a soundscape source at the instrument's tile. The player
hears their own notes at once, locally, never through the server.

Rejected: streaming the player's synthesized audio over WebRTC (a mesh from the player to everyone in the room, the
voice cap, more CPU; no better latency).

## 2. Shared data: `shared/instruments.ts`

Pure, imported by server and client, unit-tested (`server/src/instruments.test.ts`).

```ts
export type InstrumentKind = 'keys' | 'drums' | 'bass';
export interface InstrumentInfo { name: string; icon: string; presets: string[]; octave?: { min: number; max: number; start: number } }
export const INSTRUMENTS: Record<InstrumentKind, InstrumentInfo> = {
  keys:  { name: 'Keys',  icon: '🎹', presets: ['E-piano', 'Organ', 'Synth lead'], octave: { min: 2, max: 6, start: 4 } },
  bass:  { name: 'Bass',  icon: '🎸', presets: ['Synth bass', 'Sub bass'],         octave: { min: 1, max: 3, start: 2 } },
  drums: { name: 'Drums', icon: '🥁', presets: ['Kit'] },
};
export const VELOCITIES = [40, 60, 80, 100, 127]; export const VELOCITY_START = 3; // index: 100
```

**Musical typing** (GarageBand's layout, by `KeyboardEvent.code`, so it works on any keyboard layout, Russian too):

| code | KeyA | KeyW | KeyS | KeyE | KeyD | KeyF | KeyT | KeyG | KeyY | KeyH | KeyU | KeyJ | KeyK | KeyO | KeyL | KeyP | Semicolon | Quote |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| semitone | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 |

- Note = `12 × (octave + 1) + semitone` (so KeyA at octave 4 is MIDI 60, C4).
- `KeyZ` / `KeyX`: octave down / up within `octave.min..max` (keys and bass only).
- `KeyC` / `KeyV`: velocity step down / up through `VELOCITIES`.
- `Digit1`…`Digit3`: preset (only as many as the instrument has).

**Drum pads** (General MIDI note numbers, one-shots, no note-off):

| code | KeyA | KeyS | KeyD | KeyF | KeyG | KeyH | KeyJ | KeyK | KeyL | Semicolon | KeyW | KeyE |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pad | Kick 36 | Snare 38 | Closed hat 42 | Open hat 46 | Clap 39 | Low tom 41 | Mid tom 45 | High tom 48 | Crash 49 | Ride 51 | Rim 37 | Cowbell 56 |

Exports: `keyNote(kind, code, octave): number | null`, `DRUM_PADS` (code → `{ note, name }`), `noteName(note)`
(`C4`, `F#2`), `validNote(kind, note)` (drums: one of the pads; keys/bass: an integer 0–127).

**`NoteClock`** — the per-sender playout clock (jitter buffer), pure:

```ts
export const CLOCK_WINDOW_MS = 2000, CLOCK_SPAN_MS = 250, CLOCK_DROP_MS = 1000;
export class NoteClock {
  /** at: when the sender played it (server ms, their estimate); now: server ms on arrival (my estimate).
   *  Returns when to play it (server ms, ≥ now), or null for a note-on too late to be musical. */
  schedule(at: number, now: number, on: boolean): number | null;
  reset(): void; // forget everything (a new player, stand-up, reconnect)
}
```

Exactly:

```
late = now − at            // transit + both clocks' estimate errors (constant, so they cancel out); may be negative
if on and late > CLOCK_DROP_MS: return null          // a stalled tab or a reconnect; state untouched
recent = (entries of (arrival, late) with arrival > now − CLOCK_WINDOW_MS) + (now, late)   // kept, oldest dropped
delay = min(max(recent.late), min(recent.late) + CLOCK_SPAN_MS)
t = max(at + delay, last, now); last = t; return t   // last: this sender's previous play time (−∞ after reset)
```

So within 2 s of each other a sender's notes keep their exact spacing as long as the jitter stays under 250 ms
(beyond that they play late and closer together), a hiccup costs extra latency for at most 2 s, a pause longer than
2 s starts afresh, one sender's notes never swap order, and note-offs are always scheduled.

## 3. The map

`scripts/gen-map.mjs`, appended **after the last object** (the Orangery/Garden block), so existing ids stay put:

```js
// Music room stage along the top wall, facing the dance floor; the player stands behind (row 3, facing down)
obj('keyboard', 55, 4, 2, 1, { use: { kind: 'instrument', instrument: 'keys', label: 'keys' } });
obj('drum_kit', 58, 4, 2, 2, { use: { kind: 'instrument', instrument: 'drums', label: 'drums' } });
obj('bass_amp', 61, 4, 1, 1, { use: { kind: 'instrument', instrument: 'bass', label: 'bass' } });
```

```
y3   🌿  ·  ·  ·  ·  ·  ·  ·  ·  🌿     players stand here, facing down
y4   ·  [keys ]  ·  [drums]  · [bass]  ·
y5   ·   ·   ·   ·  [kit  ]  ·   ·   ·
y6-9 ▒▒▒▒▒▒▒▒ dance floor rug ▒▒▒▒▒▒▒▒  (jukebox on the west wall at (54,7))
     x54 55 56 57 58 59 60 61 62 63
```

Row 3 stays reachable through the gaps at x = 57, 60 and 62.

`shared/map.ts`:
- `ObjectUse` gains `{ kind: 'instrument'; instrument: InstrumentKind; label: string }`.
- `KEEP_TYPES` gains `keyboard`, `drum_kit`, `bass_amp` (admins move them, can't remove or add more).
- `objectName`: `drum_kit` → `drum kit`, `bass_amp` → `bass amp`.
- `layoutProblem`: instruments join the "you walk over to these" reachability check (`take`/`toggle`/`instrument`).
- Code that switches on `use.kind` must handle the new kind: `World.use()` ignores instruments (like the jukebox;
  claims go through the `instrument` message), and the client's `ActionWheel` never opens for one.
- New `playSpots(m, o)`: `besideObject(m, o)` with the spots behind the object (`dir: 'down'`, the row above it) first,
  then the rest, each group in `besideObject` order. "Standing at the instrument" = standing (not walking) on any of
  `besideObject(m, o)`.

Regenerate `shared/tilemap.json`; the generator's assertions must pass.

**Saved layouts** (andr and prod may have one, which overrides the generator's furniture): the instruments are
`KEEP_TYPES`, so main's `World.withNewFixtures` brings missing ones in on load — at the generated position, else the
nearest free one in its room, else left out with a `console.warn`. One addition: a fixture whose generated id is
already taken in the saved layout gets a fresh `e…` id.

## 4. Protocol (`shared/protocol.ts`)

```ts
export const NOTE_RATE = 40;          // note-ons per second, sustained, per user
export const NOTE_BURST = 64;         // token bucket size
export const NOTE_HELD_MAX = 32;      // notes one player can hold at once (server-side)
export const SEAT_CHANGES_PER_10S = 6; // play/leave transitions per user

ServerMsg:
  | { t: 'state'; …; instruments: Record<string, string | null> }   // added: object id → player's user id
  | { t: 'instrument'; id: string; player: string | null }          // to everyone on every change
  | { t: 'seat'; id: string | null }                                // only to the one page (socket) that plays it
  | { t: 'note'; id: string; by: string; note: number; on: boolean; vel: number; preset: number; at: number }
ClientMsg:
  | { t: 'instrument'; objectId: string; action: 'play' | 'leave' }
  | { t: 'note'; objectId: string; note: number; on: boolean; vel: number; preset: number; at: number }
```

`at`: when the player pressed the key, in server ms (`store.now()`). For note-offs `vel` and `preset` are sent as 0
and ignored.

## 5. Server (`server/src/world.ts`)

**A seat belongs to one page.** `World` keeps, in memory only (a restart stands everyone up):
- `seats: Map<objectId, { user: string; socket: string; held: Set<number> }>` — who plays each instrument, from which
  socket (`handle()` already receives the socket id);
- `pendingSeat: Map<userId, { objectId; socket; spot; timer }>` — one walk-over in progress per user;
- per user (kept across seats, so leaving and re-sitting never refills it): the note token bucket and the timestamps
  of recent seat changes.

Only the seat's socket may send notes; the user's other tabs are listeners like anyone else (they hear the notes).
The seat's socket gets `{ t: 'seat', id }` when the seat is taken and `{ t: 'seat', id: null }` when it ends; only
that page shows the instrument panel.

**At the instrument** = `atInstrument(u, o, now)`: the user's current walk is complete
(`!u.move || !u.path || now >= u.move.startedAt + pathDuration(u.path)`, which also rules out the previous path of a
mid-walk redirect) and `u.tile` is one of `besideObject(map, o)`. Used for claims, notes and the tick.

**Play** (`instrument play`, `objectId` a string naming an instrument object; `action` must be exactly `'play'` or
`'leave'`, anything else ignored). Ignored unless the user is a human, online, not `thinking`/`leaving`, not in a
meeting instance. Then:
1. This socket already holds this seat → nothing (idempotent).
2. More than `SEAT_CHANGES_PER_10S` seat changes (takes + leaves) by this user in the last 10 s → ignored.
3. Someone else holds it → notice `"<first name> is playing the <label>"`. The same person from another tab → the
   seat moves to this tab (the old tab gets `seat: null`), no notice.
4. Cancel this user's pending walk-over, if any. If this user holds another seat (any socket), it ends first.
5. `atInstrument` already → take the seat now.
6. Else, as `use` does: stop following, cancel any `use` errand, walk to the nearest free reachable spot of
   `playSpots` (the "behind" group if any of it is reachable, else the rest), facing the object, and record the
   pending walk-over with a timer for the arrival time. No free reachable spot → notice `"No room at the <label>"`.
7. When the timer fires, the seat is taken only if all of these still hold: the pending entry is still this one, its
   socket is still connected, the object still exists and is an instrument, the user is still eligible (as above),
   `atInstrument` holds, and nobody holds the seat (else the notice from 3).

Taking a seat: record `{ user, socket, held: new Set() }`, broadcast `{ t: 'instrument', id, player }`, send
`{ t: 'seat', id }` to that socket.

**Ending a seat**: delete it, broadcast `{ t: 'instrument', id, player: null }`, send `{ t: 'seat', id: null }` to its
socket if still connected. It ends:
- at once on `instrument leave` from the seat's socket (from another socket of the same user: ignored);
- at once when its socket closes (a reload or a closed tab ends the seat immediately);
- at once in `walk()` when the seat holder starts a walk that leaves their tile (any `move`, follow, `use`, an admin
  stepping them aside, the AFK walk…);
- on the 250 ms tick (the existing interval) as a backstop: not `atInstrument`, offline, `thinking`/`leaving`, in an
  instance, or the object gone or no longer an instrument (also checked right after every layout change).

A pending walk-over is cancelled by the user's next `move`, `use`, `follow`, `instrument` message, by its socket
closing, and by a layout change that removes or moves its object.

**Notes** (`note`), all checks silent:
- types: `objectId` string, `note`/`vel`/`preset` integers, `on` boolean, `at` finite number;
- the seat for `objectId` exists, its socket is this socket, and `atInstrument` holds now;
- `validNote(kind, note)`; for note-ons `1 ≤ vel ≤ 127` and `0 ≤ preset < presets.length`;
- note-on: needs a token (bucket `NOTE_BURST`, refilled at `NOTE_RATE`/s, per user); keys/bass also need the note
  **not already in `held`** and `held.size < NOTE_HELD_MAX`, and add it to `held`;
- note-off: keys/bass only, and only for a note in `held` (removed); never needs a token, so a burst can't strand a
  held note; drum note-offs are ignored;
- `at` is clamped into `[now − 2000, now + 500]`.

Relayed as `{ t: 'note', id, by, note, on, vel, preset, at }` to every connected socket of every human not in a
meeting instance, **except the seat's own socket** (the user's other tabs get it). Bots never play. `snapshot()`
carries `instruments` (every instrument object, `null` when free).

## 6. Client sound

### Synthesis (`client/src/synth.ts`)

`startVoice(ctx, dest, kind, preset, note, vel, when): { release(when): void; stop(): void; done: Promise<void> }`,
pure Web Audio (oscillators, noise buffers, filters, gains), every node disconnected when the voice ends.

| Instrument | Preset | Sound |
|---|---|---|
| keys | E-piano | FM tine: sine carrier, sine modulator at ratio 1 with a decaying index, plus a short bell partial (ratio ~14); amplitude decays over ~2 s while held; release 0.3 s |
| keys | Organ | additive drawbars (sines at 1, 2, 3, 4, 6× the pitch), a short key click, gentle 6 Hz vibrato; sustains while held; release 0.08 s |
| keys | Synth lead | two saws detuned ±7 cents + a square an octave down, lowpass with a quick filter envelope; release 0.2 s |
| bass | Synth bass | saw + square one octave down, resonant lowpass with a fast decaying filter envelope; release 0.12 s |
| bass | Sub bass | sine + a little triangle, soft 10 ms attack; release 0.15 s |
| drums | Kit (808/909) | kick: sine 150→45 Hz drop; snare: 180 Hz tone + band-passed noise; closed/open hat: high-passed noise (0.05 s / 0.4 s, a closed hat chokes an open one); clap: three noise bursts + tail; toms: sine drops at three pitches; crash: high-passed noise ~1.5 s; ride: metallic square cluster ~1 s; rim: short click; cowbell: two squares (540/800 Hz) band-passed |

Velocity scales loudness (squared curve) and, for keys and bass, the filter/modulation brightness. Levels: one note at
velocity 100 peaks around −12 dBFS; each instrument source ends in a `DynamicsCompressor` (threshold −12 dB, ratio 4,
fast attack) so chords don't clip. Polyphony: 16 voices per instrument source; the oldest is stolen with a 10 ms fade.
A key held longer than 10 s is released automatically (a lost note-off never hangs). `stop()` works on a voice whose
start is still in the future too (it never sounds).

### Soundscape (`client/src/soundscape.ts`)

- Source kind `'instrument'` for every object with `use.kind === 'instrument'`, in the **music** category at the
  object's tile, created and moved like the jukebox source (edit mode). Its input is the compressor above; the rest of
  the chain (lowpass, dry, pan, room echo send, model gains) is the one every source has. Source gain 0.8.
- `playNote(objectId, by, note, on, vel, preset, atServerMs)`: converts the time to `AudioContext` time
  (`currentTime + max(0, at − store.now()) / 1000`). One voice per `${objectId}:${by}:${note}` (keys/bass): a note-on
  for a key that already has a voice stops that voice (10 ms fade) before starting the new one; a note-off releases it.
  A note-on starts a voice **only if the source's current model gain is > 0** (else it is skipped; the visuals and the
  duck still count it). Drums: every hit is a new voice (an open hat is choked by the next closed hat).
- `allOff(objectId, by?)` **stops** every voice of that instrument (from that player), including voices scheduled to
  start later, clears that instrument's held notes (see ducking) and resets the sender's `NoteClock`.
- Received notes are dropped unless `by` is the object's current player in the store; the rest go through one
  `NoteClock` per sender (reset when they stand up), then `playNote`. My own notes call `playNote` with `at = now`.
- When an object's player changes (an `instrument` message, or a `state` snapshot) the store calls `allOff` for the
  previous player of that object; on WebSocket close, `allOff` everywhere.

### Ducking the jukebox

Each instrument source tracks, from every note it is given (mine or received, audible or not), the set of held
keys/bass notes (added on note-on, removed on note-off, the 10 s timeout and `allOff`) and `lastActivity`
(`performance.now()` of the last note event). An instrument is **active** while it has held notes or
`now − lastActivity < 5 s`. A jukebox source whose room (`roomAt` of its tile) contains an active instrument gets
`duck = 0.25`, else `1`, multiplied into its dry and echo-send targets: down with time constant 0.1 s, back up with
0.5 s (≈ 1.5 s to full). Purely local; playback and the server are untouched. `__soundscape.jukebox()` reports `duck`.

### Dev hooks

`window.__soundscape.instruments()` → `[{ id, kind, player, voices, gain, lastNoteAt, rms }]` (`rms` from an
`AnalyserNode` after the source's lowpass, like the jukebox's).

## 7. Client UI

**Store** (`net.ts`): `instruments: Record<string, string | null>` from `state` and `instrument` messages (cleared on
close); `seat: string | null` from `seat` messages (cleared on close) — the instrument **this page** plays;
`playInstrument(id)`; `leaveInstrument()`; `sendNote(...)`;
`lastNote: Record<string, number>` (`performance.now()` of the last note-on per object, for the engine; updated
without `emit()`); `note` messages go straight to the soundscape (no re-render), like `rtc`.

**Clicks.** The engine passes instrument clicks to `onPick` (they have `use`, no `sound`); `App.tsx` sends
`playInstrument(id)` for them directly (no action wheel). Clicking the instrument this page plays does nothing.

**Instrument panel** (`App.tsx` + `styles.css`), shown while `store.seat` is set; a card at the bottom centre
(above the dock on compact layouts):
- Head: `🎹 Keys`, preset buttons with their number (`1 E-piano · 2 Organ · 3 Synth lead`), `Octave 4 (Z X)`,
  `Velocity 100 (C V)`, and `Esc — stand up` (a button too).
- Body: the musical-typing layout drawn as keys — white keys `A S D F G H J K L ; '` with note names under the
  letters (`C4 D4 …`), black keys `W E · T Y U · O P` above them; for drums, a grid of 12 pads (`A Kick`, `S Snare`, …).
  Keys light up while held. Display only: no click or touch input.
- On a touch-only device (`(hover: none) and (pointer: coarse)`), a line: "Plug in a keyboard to play".
- Octave, velocity and preset are per page, start at the instrument's defaults each time you sit down, and go with
  every note (listeners use the note's preset).

**Keyboard** (window `keydown`/`keyup`, only while `store.seat` is set):
- A **keydown** is ignored while focus is in `input, textarea, select, [contenteditable]`, with ⌘/Ctrl/Alt held, or
  with `e.repeat`. A **keyup** of a code that is holding a note is always handled, whatever the focus or modifiers.
- Mapped codes (notes, Z X C V, the preset digits) call `preventDefault()`; while playing the engine's own keys
  (`+ − 0 M`) are off too. Space (push-to-talk) keeps working.
- Held keys are tracked as `code → pitch`. keydown of a note key: if no other held key has that pitch, play it
  locally at once (`playNote` with `at = now`), then `sendNote`; if one does, just record the code (no new note).
  keyup: forget the code; if no other held code has that pitch, send/play its note-off. (The pitch is the one the
  key started with, even if the octave changed meanwhile.) Drum keys just hit on keydown.
- `Escape` → `leaveInstrument()` (unless an open dialog takes the Escape first).
- `blur`, `visibilitychange` to hidden, and the seat ending: release every held key (locally and with note-offs while
  the seat lasts).

**On the floor:**
- The player stands behind the instrument facing down (the server's walk faces them).
- Each note-on makes a ♪ rise from the instrument (the jukebox's note sprites), at most one new ♪ per 150 ms per
  instrument, each living 1.2 s.
- Hover tooltip: `Keys · Ivan is playing` / `Keys · click to play` / `Keys · you're playing · Esc to stand up` (this
  page holds the seat) / `Keys · you're playing in another tab`.
- People list: the player's name gets the instrument icon (`🎹`, `🥁`, `🎸`) next to the other user icons.

**Sprites** (`scripts/gen-assets.mjs`, existing palette, regenerate assets): `keyboard` 32×16 (a stage keyboard on an
X-stand, black and white keys visible), `drum_kit` 32×32 (bass drum front with a small logo, snare, two toms, a cymbal
on each side), `bass_amp` 16×24 (a small combo amp with a bass guitar leaning on it).

## 8. Testing

`npm test`:
- **instruments.test.ts**: `keyNote` for every code at a few octaves; drum pads; `validNote`; `noteName`.
  `NoteClock`: steady lateness keeps spacing exact; jitter under 250 ms within 2 s keeps spacing exact (all at
  `at + max late`); a spike over 250 ms above the window's minimum compresses (explicit expected times); after 2 s of
  arrivals without it the delay is back down; one sender's notes never swap order; negative lateness works; a
  note-on later than 1000 ms → null with state untouched, a note-off still scheduled; `reset()`.
- **world.test.ts** (mock timers, two sockets for one user where it matters): play when free walks to a behind spot
  and takes the seat on arrival, `seat` only to that socket, `instrument` to everyone; already there → at once; again
  from the same socket → nothing; taken → notice; pending walk-over cancelled by `move`, by the socket closing, by
  another `play`, and by the object being moved (no seat on arrival); walking away and back before the timer → the
  arrival guards decide; playing another instrument ends the first seat; a seat ends at once on `leave`, on its
  socket closing, and when `walk()` moves the holder; the tick backstop (offline, `thinking`, instance, object gone);
  `leave` from the user's other socket is ignored; the seat-change limit; bots and instance users can't play; bad
  `action`. Notes: from the user's other socket, from a non-player, mid-walk, bad types, invalid note/vel/preset →
  dropped; the bucket (burst, then the rate) survives leaving and re-sitting; a note-on for a held pitch → dropped;
  note-offs only for held notes and never rate-limited; drum note-offs dropped; `at` clamped; the relay reaches
  everyone, including the player's other tab, but not the seat's socket or instance users; `state` carries
  `instruments`; `World.use()` ignores instruments; layout migration adds missing instruments (also with an id clash
  and a blocked position).
- **layout.test.ts**: instruments can be moved but not removed or added; one placed so nobody can reach it is refused.
- **acoustics.test.ts**: from each instrument's tile the gain is ≥ 0.4 everywhere in Music and 0 in the Lobby, the
  Studio and at the Desks door (sealed rooms).
- `npm run typecheck`, `npm run build -w client`.

Browser (headless Playwright Chromium with `--mute-audio`, never the app pane: tests make no sound, audio is checked by
numbers only; dev server on free ports started with Bash; `?as=A` and `?as=B`, a click first for autoplay):
1. A clicks the keys: walks behind them, the panel opens; B sees A as the player (tooltip, people icon).
2. A plays a phrase with the keyboard (`keyboard.down('KeyA')`…): B, in Music, receives the notes,
   `__soundscape.instruments()` shows voices and `rms > 0`, `__audioRms() > 0`; A hears itself (rms > 0) before any
   echo could arrive.
3. B in the Lobby: notes arrive, no voices start (gain 0).
4. The jukebox's `duck` drops to 0.25 on both while A plays and returns to 1 about 5 s after.
5. Music slider 0 on B → `__audioRms()` ≈ 0 while A plays.
6. B clicks the keys → notice; B plays the drums at the same time; both are heard by a third page C.
7. A presets 2/3, octave Z/X, velocity C/V change what B's voices report; Russian layout is irrelevant (codes).
8. A holds a key and walks away (or closes the tab): the player is cleared and B's voice for that key stops.
9. Typing in the chat while seated plays nothing; holding a note, clicking into the chat and releasing the key still
   ends the note.
10. A second tab of A (same `?as=A`) gets no panel, hears A's notes, and its tooltip says "playing in another tab".
11. Holding K at octave 4, pressing X then A (both C5): one voice, released only after both keys are up.

Safari by hand on `andr` (Andrii): sit, play, a second browser hears it inside the room and not at the Desks door;
the Mac app's WKWebView.

## 9. Code map

| File | Change |
|---|---|
| `shared/instruments.ts` (+ `server/src/instruments.test.ts`) | kinds, presets, musical typing, pads, `NoteClock` |
| `shared/protocol.ts` | section 4 |
| `shared/map.ts`, `scripts/gen-map.mjs`, `shared/tilemap.json` | instrument objects, `ObjectUse`, `KEEP_TYPES`, `playSpots`, reachability |
| `server/src/world.ts` (+ `world.test.ts`, `layout.test.ts`, `acoustics.test.ts`) | players, play/leave, tick, note relay, snapshot, migration |
| `client/src/synth.ts` | voices |
| `client/src/soundscape.ts` | instrument sources, `playNote`/`allOff`, per-sender clocks, jukebox duck, dev hook |
| `client/src/net.ts` | instruments state, actions, note routing, `lastNote` |
| `client/src/engine.ts` | clicks, rising notes, tooltip, engine keys off while playing |
| `client/src/App.tsx`, `client/src/styles.css` | instrument panel, keyboard capture, people-list icon |
| `scripts/gen-assets.mjs`, `client/public/assets/*` | three sprites |

## 10. Implementation steps (for executors)

1. **Server + shared**: sections 2–5 and their tests; `npm run gen` (map). The client must still typecheck.
2. **Client**: sections 6–7, sprites, `npm run gen`.
