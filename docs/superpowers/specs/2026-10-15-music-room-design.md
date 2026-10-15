# Music room: a shared jukebox — design

Owner: Andrii Butko · 2026-10-15 · status: v2, after a Codex spec review; shipped. Since sound v3 (rooms are
sealed) the jukebox is heard only inside the Music room: the door leak described below no longer exists · builds on
`2026-10-15-open-talk-rooms-design.md` (soundscape, emitters) and `2026-10-15-sound-v2-design.md` (mixer: the Music
category). Only what changes is here.

## Goal

The Music room (east end, door from Desks) gets a **jukebox** instead of the looping radio:

- A library of free (CC0) tracks in several genres ships with the app. No streaming services, no copyright questions.
- **Everyone hears the same thing at the same moment**: playback is server state, timed by the server clock.
- **Anyone standing in the Music room** queues tracks, pauses/resumes and skips. With an empty queue the jukebox
  shuffles the library, so the room is never silent unless someone pauses it.
- The music is a sound source on the map like the radio was: it fills the Music room, is faint at its door into
  Desks, silent further away, and follows the personal **Music** slider in ⚙.
- **No open voice in the room** (it is not a hall room); knock calls work there as anywhere else.

Built in one pass: everything below ships together.

## Out of scope

- Uploading your own files, YouTube, internet radio (copyright; decided with Andrii).
- Voting, DJ roles, per-person fairness beyond the queue limits below.
- Better clock sync. Playback uses the existing `store.now()` (offset taken from `hello`/`state`, error = one-way
  delivery latency, well under the 0.3 s tolerance). Nobody in the room hears anyone else's playback (no voice there),
  so a few tens of ms between listeners are inaudible.

## 1. The library

**Tracks.** 18 instrumental tracks, all **CC0 1.0** (verified on the track's or album's own page: Free Music Archive,
archive.org), in six genres: `Lo-fi`, `Jazz & soul`, `Electronic`, `Chiptune` (3 each), `Acoustic & piano` (4),
`Ambient` (2); picked with Andrii, listed in `scripts/music.json`. 1:55–4:31 each.

**Pipeline** (`scripts/gen-music.mjs`, `npm run gen:music [-- --force]`, run by hand like the other generators):
- Input `scripts/music.json`: `[{ id, title, artist, genre, url, page, license }]` (`id`: `[a-z0-9-]+`, unique;
  `url`: direct download; `page`: where the license is stated).
- Downloads each missing original into `.music-src/<id>.<ext>` (gitignored).
- Converts with ffmpeg to AAC-LC 80 kbps stereo 44.1 kHz, `-movflags +faststart` (starts and seeks before the whole
  file is in), loudness-matched (two-pass `loudnorm`, I = −18 LUFS, TP = −1.5 dB, linear).
- **Content-hashed file names**: `client/public/assets/music/<id>-<sha1(bytes)[0..8]>.m4a`, so a re-encode never
  reuses a cached URL; stale files are deleted. The name matches the server's hashed-asset rule, so files are cached
  `immutable`.
- Measures each output with ffprobe and writes `shared/music.json`:
  `{ tracks: [{ id, file, title, artist, genre, duration /* ms, integer */, page, license }] }`, in input order.
- Writes `client/public/assets/music/CREDITS.md` (title, artist, license, page per track).
- Fails loudly on missing ffmpeg/ffprobe, a non-CC0 `license`, a duplicate id or a duration outside 60 s–6 min.

`shared/music.ts` imports `music.json` (like `tilemap.json`) and exports `TRACKS: Track[]`, `TRACK: Map<id, Track>`,
`GENRES` (first-seen order) and `trackUrl(track) = /assets/music/<file>`. The server throws at startup if `TRACKS` is
empty. About 36 MB in total.

**Removed:** `client/public/assets/sounds/radio.m4a` (a cover of someone else's song, prototype only) and the `radio`
frame. The clip-loop emitter in `soundscape.ts` stays for future clip objects; `MapObject.sound.clip` becomes optional.

## 2. The map

`scripts/gen-map.mjs`: the `obj('radio', 58, 4, …)` line becomes, **in the same position in the object list** (so
object ids stay put):

```js
// on the west wall beside the dance floor: fills the room and leaks faintly out of the Desks door
obj('jukebox', 54, 7, 2, 2, { sound: { gain: 0.8 }, use: { kind: 'jukebox', label: 'jukebox' } });
```

Measured with today's `soundModel` from source tile (54,7): Desks door (53,17) 0.23, (52,17) 0.17, (50,17) 0.06,
(48,17) 0; anywhere in the room ≥ 0.4 (room fill). From the old back-wall spot the door was already silent.

- `ObjectUse` gains `{ kind: 'jukebox'; label: string }`; `MapObject.sound` becomes `{ clip?: string; gain: number }`.
- The Music room label becomes `jukebox — walk in to pick music`.
- The reachability assertion must still pass; the stand spots stay. Regenerate `shared/tilemap.json`.

## 3. Server: `server/src/jukebox.ts`

A small class, pure apart from injected `now` values and `rand()`, unit-tested on its own. `World` owns one `Jukebox`
per map object with `use.kind === 'jukebox'`, keyed by object id (one exists on this map).

```ts
export interface JukeboxEntry { id: string; track: string; by: string }   // id: random, for removal
export interface JukeboxState {
  playId: string;             // one playback of one track; new on every advance/skip; controls must name it
  track: string;              // now playing; never empty
  by: string | null;          // who queued it; null = the jukebox's own pick
  startedAt: number;          // server ms at which position 0 of the track plays (moved on resume)
  pausedAt: number | null;    // position in ms while paused; null = playing
  queue: JukeboxEntry[];      // oldest first
  last: { kind: 'pause' | 'play' | 'skip'; by: string; at: number } | null; // for "Paused by Ivan"
}
```

**Position** = `pausedAt ?? now − startedAt`, clamped to `[0, duration]`.

**Advancing.** `advance(now)`: when playing and `now − startedAt ≥ duration`, start the next track: new `playId`,
`startedAt = now`, `pausedAt = null`. Next = the queue's head (removed from the queue; `by` = its requester), else a
**shuffle pick**: uniformly random among tracks not in the last 5 played and not queued (if that leaves nothing, any
track other than the current one). A paused track never advances.

**One clock per event.** `World` captures `now` once per incoming action and per 250 ms tick (its existing
interval). Every action first runs `advance(now)` with that `now`, then applies itself with the same `now`; so a
pause that arrives after the track ended (before the tick noticed) lands on the next track's `playId` check below.

**Actions** (a refusal sends a `notice` to that user only and changes nothing; silent ignores send nothing):

| action | rule |
|---|---|
| `queue track` | known track; not the current track and not already queued ("Already in the queue"); at most `JUKEBOX_PER_PERSON` (3) entries by this user ("You have 3 tracks queued — wait for one to play"); at most `JUKEBOX_QUEUE_MAX` (20) entries ("The queue is full") |
| `unqueue entry` | the entry exists and is this user's; otherwise silently ignored |
| `pause playId` | `playId` is current (else silently ignored) and playing → `pausedAt = position`; `last = pause` |
| `play playId` | `playId` is current (else ignored) and paused → `startedAt = now − pausedAt`, `pausedAt = null`; `last = play` |
| `skip playId` | `playId` is current (else ignored) → next track as in advancing, playing; `last = skip` |

The `playId` rule makes stale clicks harmless: a Skip pressed on a track that just ended never skips its successor.
Actor and time always come from the server.

**Who may act**: `objectId` resolves to a jukebox object (else ignored), and the user is a human (not a bot), online,
`door` not `thinking`/`leaving`, not in a meeting instance, whose **currently shown tile** (`position(u, now).tile`, as
`voiceTick` uses) is inside the room containing the jukebox (`roomAt` of its top-left tile). Otherwise notice "Walk
into Music to pick music". `World.use()` ignores jukebox objects (no walking over; the client opens the panel).

**Broadcast**: `{ t: 'jukebox', id, state }` after every change (action or advance).

**Persistence.** `dump()` adds `jukebox: Record<objectId, { state, history }>` (`history`: last 5 played track ids).
`load()` normalizes each entry independently and drops anything it can't repair:
- the object must still be a jukebox;
- `track` unknown → a shuffle pick, playing from 0 at load time (paused flag dropped);
- `startedAt` / `pausedAt` / `last.at` must be finite numbers; `startedAt` in the future → load time; `pausedAt`
  clamped to `[0, duration]`; a bad `last` → null;
- queue: entries need string `id`/`by` and a known `track`; drop duplicates (by track and by id), the current track,
  per-person overflow beyond 3 and anything beyond 20, keeping the oldest;
- history: known track ids only, at most 5; `playId` missing → a new one.

Time keeps running while the server is down: the first tick after start advances a track that ended meanwhile (one
advance starting at `now`; missed tracks are not replayed). Without saved state: a shuffle pick, playing from 0 at
construction.

## 4. Protocol (`shared/protocol.ts`)

```ts
export const JUKEBOX_QUEUE_MAX = 20;
export const JUKEBOX_PER_PERSON = 3;
export interface JukeboxEntry { … }  export interface JukeboxState { … }   // as in section 3
export type JukeboxAction =
  | { action: 'queue'; track: string }
  | { action: 'unqueue'; entry: string }
  | { action: 'pause' | 'play' | 'skip'; playId: string };

ServerMsg:
  | { t: 'state'; …; jukebox: Record<string, JukeboxState> }   // added
  | { t: 'jukebox'; id: string; state: JukeboxState }          // after every change, full state (small)
ClientMsg:
  | ({ t: 'jukebox'; objectId: string } & JukeboxAction)
```

The server checks at runtime that `objectId`, `track`, `entry` and `playId` are strings and `action` is one of the
five; anything else is ignored.

## 5. Serving audio: Range requests

Media elements stream and seek with HTTP Range requests (Safari in particular relies on them). Move the static file
code out of `server/src/index.ts` into `server/src/static.ts` (`serveStatic(dir, req, res)`), and route both `GET` and
`HEAD` to it in `index.ts` (today only GET reaches it).

- Every file response has `accept-ranges: bytes` and `content-length`.
- `GET` with a single `Range: bytes=…`:
  - `a-b` → `206` for `a..min(b, size−1)`; `a-` → `a..size−1`; `-n` (n > 0) → the last `min(n, size)` bytes;
  - `content-range: bytes start-end/size`, `content-length: end − start + 1`, only those bytes in the body;
  - `a ≥ size`, `b < a` or `-0` → `416` with `content-range: bytes */size`, empty body;
  - malformed, multi-range or non-`bytes` units → the Range header is ignored: `200`, whole file.
- `HEAD` ignores Range: `200` with the full-file headers, no body.
- MIME additions: `.m4a` → `audio/mp4`, `.mp3` → `audio/mpeg`.
- Cache rules unchanged (hashed music files hit the existing `immutable` rule).

Vite's dev server already handles ranges for `client/public`.

## 6. Client playback

### Sources (`client/src/soundscape.ts`)

Sources get an explicit `kind: 'voice' | 'clip' | 'jukebox'`; every branch that today tests `s.clip` to tell objects
from voices uses `kind` instead. Clip emitters are created only for objects with `sound.clip`; jukebox sources for
objects with `use.kind === 'jukebox'`. Both are in the **music** category at the object's tile, with the same model as
the radio had (distance, room fill, portals, occlusion, room echo, Music slider; no per-person volume).

A jukebox source owns, for the lifetime of the Soundscape, one `HTMLAudioElement` (`new Audio()`, `preload =
'auto'`, never in the DOM, never muted) and the one `MediaElementAudioSourceNode` made from it (an element can be
attached only once, so it is never recreated). Its sound reaches the speakers only through the graph, so the mixer and
deafen apply. `destroy()` pauses, unloads and disconnects it.

### Reconcile, not react

The jukebox source has one idempotent `reconcile(now)` that compares what **should** happen with what the element is
doing, called on every soundscape update (100 ms), and immediately when the store's jukebox state, `store.connected`
or `store.offset` changes. Inputs:

- `desired` = `store.jukebox[id]` (absent while disconnected, see below);
- `heard` = model gain (before the personal mix) > 0 now; `heardRecently` = it was > 0 within the last 3 s;
- `expected` = position in seconds = `(pausedAt ?? store.now() − startedAt) / 1000`.

Rules, in order:
1. No `desired`, or `desired` paused, or not `heardRecently` → `pause()` if playing. If not `heardRecently` or no
   `desired`: also unload (`removeAttribute('src')`, `load()`, `loadedUrl = null`), so nothing keeps downloading.
2. `expected ≥ duration` → `pause()`; wait for the server's next track.
3. Otherwise it should play (only once `heard`; within the 3 s tail it keeps playing):
   - `loadedUrl !== trackUrl(track)` → `gen++`, set `src`, `loadedUrl = url`; nothing else until `loadedmetadata`.
   - metadata ready (`readyState ≥ HAVE_METADATA`) and the element is paused, or `playId` differs from the one it
     last started → seek to a freshly computed `expected`, remember `playId`, `play()`.
   - playing: every 2 s (and right after an offset change) if `|currentTime − expected| > 0.3` and not `seeking` and
     `readyState ≥ HAVE_FUTURE_DATA` → `currentTime = expected`.
4. Every async continuation (`loadedmetadata`, a `play()` promise) carries the `gen` it was started with and does
   nothing if `gen` moved on; it then calls `reconcile` again rather than acting on stale values.

### Autoplay (`client/src/audio.ts`)

- `playMedia(el)` marks an element as **blocked** only when `play()` rejects with `NotAllowedError` (an `AbortError`
  from our own `pause()`/`load()` is not a gesture problem; network/decode errors are logged, not shown as "Enable
  sound"). New `forgetMedia` callers: the jukebox calls it on every pause and unload, so a later click never restarts
  intentionally stopped music.
- `resume()` (the first-gesture handler) calls `play()` on blocked elements **synchronously in the gesture handler**,
  before awaiting `AudioContext.resume()` (WebKit only honours playback started inside the gesture), then resumes
  the context. After a successful retry the jukebox reconciles, which re-seeks to the latest server position.
- `audible` (the "Enable sound" chip) counts the jukebox while it should play and is heard.

### Disconnects

On WebSocket close the store sets `jukebox = {}` (so playback pauses and controls disable); the next full `state`
snapshot replaces it wholesale. `jukebox` messages replace one entry wholesale. Reconciliation runs even when the
track id is unchanged.

### Dev hooks

- `window.__soundscape.jukebox()` → `[{ id, track, playId, active, paused, currentTime, expected, src, rms }]`, where
  `rms` comes from an `AnalyserNode` tapped after the source's lowpass (proves signal reaches the graph).
- `window.__audioRms()` → RMS of the master output via an `AnalyserNode` on `output()` (dev only), to prove Music 0
  and deafen silence both the dry signal and the echo.

## 7. UI

**Sprite.** `scripts/gen-assets.mjs`: `jukebox` frame, 32×32, a classic arched jukebox in the existing palette (wood
body, glowing arch with a few coloured lights, speaker grille, a small record window); the `radio` frame is removed.
Regenerate assets. The engine draws the rising notes from the jukebox's top centre **only while it is playing**.

**Clicks.** `engine.ts` today returns `onPick(null)` for any object with `sound` before it emits object picks; a
jukebox (it has `use`) must reach `onPick` like other interactive objects. `App.tsx` opens the panel for it like the
calendar shortcut (`use.kind === 'jukebox'` → `store.openJukebox(id)`).

**Hover tooltip**: `Jukebox · ♪ Title — Artist` / `Jukebox · paused`.

**Store** (`net.ts`): `jukebox: Record<string, JukeboxState>` from `state` and `jukebox` messages, cleared on close;
`jukeboxOpen: string | null`, `openJukebox(id)`, `closeJukebox()`, `jukeboxAction(id, action)`, `inJukeboxRoom(id)`
(my pose tile is in the jukebox's room), `walkToJukebox(id)` (move to the nearest free tile from `besideObject`).

**Now-playing chip** (in `.chips`, only while I stand in a jukebox's room and the state is known):
`♪ Title — Artist · 1:23 / 3:05`, ⏯, ⏭, `Queue · 2`; clicking the chip (not its buttons) opens the panel.

**Jukebox panel** (modal card like the Meetings panel; a bottom sheet on compact layouts):
- **Now playing**: title, artist, genre, a progress bar with times, "picked by Ivan" / "shuffle", and the `last` line
  for 10 s after it happened ("Paused by Ivan", "Skipped by Ivan"); ⏯ ⏭ (sent with the shown `playId`).
- **Up next**: the queue in order — title, artist, who queued it; ✕ on my own entries.
- **Library**, grouped by genre: title · artist · duration, a `+` button, disabled with a tooltip when the track is
  playing or queued, when I have 3 queued or when the queue is full. A tiny "CC0" link per track to its `page`.
- **Outside the room** the same panel is read-only: buttons disabled, a "Walk over" button (`walkToJukebox`) on top.
- While disconnected: "Reconnecting…", everything disabled.

**Room list**: the Music room's subtitle shows `♪ Title` while playing and `paused` while paused, instead of its label.

## 8. Testing

`npm test`:
- **jukebox.ts** (explicit `now`, seeded `rand`): first track at construction; `advance` exactly at the end, not
  before; queue FIFO and `by`; shuffle excludes the last 5 and queued tracks and falls back; limits (3 per person, 20
  total, duplicates, current track refused); unqueue own only; pause freezes, play resumes from the same position;
  skip while paused plays the next track; **expiry races**: pause/play/skip with the current `playId` just before the
  end, and with the old `playId` at and after the end (ignored; the successor is untouched), both orders of tick and
  action; persistence round trip and every normalization rule in section 3; ended-while-down advances once.
- **world.test.ts**: only someone standing in the Music room can act (outside, bot, instance, mid-walk out by shown
  tile → notice, no change); unknown `objectId` / malformed messages ignored; `state` carries the jukebox; `jukebox`
  broadcast on change; `use` on the jukebox does not walk; the old radio tests are replaced.
- **static.ts** (a real `http` server around `serveStatic` in the test): 200 + `accept-ranges` + length; `0-99`,
  `100-`, `-100`, an end past the file, a suffix longer than the file → 206 with the right `content-range`,
  `content-length` and bytes; `size-`, `5-2`, `-0` → 416; multi-range and junk → 200; HEAD with and without Range →
  200 headers, no body; `.m4a` MIME. `index.ts` routes HEAD.
- **acoustics.test.ts**: the jukebox plays in the Music room (≥ 0.4 everywhere inside), gain **> 0** at (53,17) and
  (52,17), **0** at (48,17) and anywhere in the Lobby; knock calls stay flat.
- `npm run typecheck`, `npm run build -w client`.

Browser (Playwright Chromium, dev server, `?as=A`, `?as=B`, autoplay allowed via a click first):
- A and B walk into Music: same track and `playId`; `__soundscape.jukebox()` `currentTime`s agree within 0.3 s and
  advance; `rms > 0`; `__audioRms() > 0`.
- A queues a track, B sees it in Up next; A skips → both switch to A's track; B pauses → both paused, panel says
  "Paused by B"; B plays → both resume at the same position. Rapid triple skip ends on one consistent track.
- B walks back to the Lobby: level fades, then the element pauses and drops its `src`; a page opened in the Lobby
  never requests `/assets/music/` (network log). B walks back in: playback resumes at the right position (same track).
- Music slider 0 → `__audioRms()` ≈ 0 (dry and echo); deafen likewise.
- Clicking the jukebox from the Lobby opens the read-only panel with "Walk over".
- Server restart mid-track (dev): clients resume at the right position after reconnect; while disconnected, playback
  pauses.
- Built server: `curl -r 0-99` → 206; `curl -I` → 200 with `accept-ranges`.

Safari by hand on the `andr` instance (Andrii, Safari + the Mac app's WKWebView): first click starts the music; a track
change happens by itself; pause/resume from another browser; leave and re-enter the room; rapid skips; reload mid-track;
sleep/wake the laptop.

## 9. Code map

| File | Change |
|---|---|
| `scripts/music.json`, `scripts/gen-music.mjs`, root `package.json` (`gen:music`), `.gitignore` (`.music-src/`) | library pipeline |
| `client/public/assets/music/*`, `shared/music.json`, `shared/music.ts` | tracks + catalog (generated) |
| `client/public/assets/sounds/radio.m4a` | deleted |
| `scripts/gen-map.mjs`, `shared/tilemap.json`, `shared/map.ts` | jukebox object, `ObjectUse` jukebox, optional `sound.clip`, room label |
| `scripts/gen-assets.mjs`, `client/public/assets/*` | `jukebox` frame, `radio` frame removed |
| `shared/protocol.ts` | section 4 |
| `server/src/jukebox.ts` (+ test) | section 3 |
| `server/src/world.ts` (+ test) | owns jukeboxes, tick, actions, room check, snapshot, persistence, `use` |
| `server/src/static.ts` (+ test), `server/src/index.ts` | Range serving, HEAD route |
| `client/src/audio.ts` | blocked-only-on-NotAllowedError, gesture retry order, dev output analyser |
| `client/src/soundscape.ts` | source kinds, jukebox source + reconcile |
| `client/src/net.ts` | jukebox state + actions, cleared on close |
| `client/src/engine.ts` | jukebox sprite, clickable, notes only while playing, tooltip |
| `client/src/App.tsx`, `client/src/styles.css` | chip, panel, room list subtitle, jukebox click |
| `server/src/acoustics.test.ts` | radio → jukebox, positive leak at the door |

## 10. Implementation steps (for executors)

0. **Library** (the supervisor, after Andrii's OK for the downloads): `scripts/music.json`, `gen-music.mjs`,
   generated audio + catalog.
1. **Server + shared**: sections 2–5, tests. Client must still typecheck.
2. **Client**: sections 6–7.
