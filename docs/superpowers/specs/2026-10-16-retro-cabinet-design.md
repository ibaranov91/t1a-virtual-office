# Retro cabinets: Game Boy homebrew in the Arcade — design

Owner: Andrii Butko · 2026-10-16 · status: draft · builds on `2026-10-16-arcade-party-pack-design.md` (Arcade boards
popover, weeks) and `2026-10-15-sound-v3-design.md` (sealed rooms). Branch `andr/retro-cabinet`, cut from
`andr/arcade-party` step 1 (`e6c4630`).

## Why

Andrii wants known, polished 8-bit games in the Arcade without writing them from scratch, with their scores on the
office boards. Commercial games (Pac-Man & co.) can't be hosted, so we embed an emulator and ship freely licensed
homebrew.

Decisions taken with him:

- **Platform: Game Boy / Game Boy Color**, emulator **binjgb** (MIT, C → WebAssembly, 88 KB).
- **Games**: **Tobu Tobu Girl Deluxe** (Tangram Games; code MIT, assets CC BY 4.0) and **Shock Lobster** (Dave VanEe;
  zlib). One cabinet each.
- **Honest scores**: the player's browser sends its button changes stamped with frame numbers; the server runs the same
  emulator on the same inputs and reads the score from emulator memory itself. The same input stream lets others watch
  the game live.
- **Your own cartridge**: each person's save (unlocked levels, skills, pearls) lives on the server and is loaded every
  time they play.
- Scores land in **Arcade boards** (a new Retro tab): this week and all time.

Built in one pass (section 13 splits it into two executor steps, each leaving the app working).

## Out of scope

- Other games or platforms; uploading ROMs; any commercial ROM.
- Multiplayer Game Boy (link cable), Break Set integration, cheers/predictions for retro games.
- A live mini-screen on the cabinet sprite for people who aren't watching (the cabinet only glows).
- Policing slow motion: a modified client could run the emulator slower than real time. The server only refuses
  frames from the future (section 5). Faked scores are impossible; a slowed-down run is an accepted residual risk.
- A retro Hall of Fame (weekly winners stay Break Set only).

## 1. Emulator, ROMs and the catalogue

**Vendored files** (committed, with their licences):

- `vendor/binjgb/binjgb.mjs` = upstream `docs/binjgb.js` (binji/binjgb `16621111ed0ee73bcc45c912a823bcebedcffc0f`)
  with one line appended: `export default Binjgb;`. `vendor/binjgb/binjgb.wasm` = upstream `docs/binjgb.wasm`.
  `vendor/binjgb/LICENSE` (MIT, © 2016 Ben Smith).
- `client/public/retro/binjgb.wasm` is a copy of the wasm (the client fetches it; the server reads the vendor copy).
- `client/public/retro/tobudx.gb` (262144 bytes) and `client/public/retro/shocklobster.gb` (32768 bytes), taken
  unchanged from the gbdev/database repo (`entries/tobutobugirldeluxe/tobudx.gb`, `entries/shock-lobster/shocklobster.gb`);
  `client/public/retro/LICENSES.md` with both licences and credits (section 9).
- The server reads ROMs from `client/public/retro/` (deploy rsyncs the working copy, so the files are there).

**Catalogue** `shared/retro/games.ts`:

```ts
export type RetroGameId = 'tobu' | 'lobster';
export interface RetroGame {
  id: RetroGameId; title: string; rom: string; sha256: string; bytes: number;   // file under /retro/
  tracks: { id: string; label: string; unit: string }[];                       // one board per track
  controls: string;                                                           // one line shown under the screen
  credits: string[]; licence: string; links: { label: string; url: string }[];
  probe: Probe;                                                               // section 4
}
```

The server checks the sha256 of each ROM at startup and refuses to open a cabinet whose ROM is missing or different
(logs once; the cabinet tooltip says "Out of order").

**Emulator wrapper** `shared/retro/gb.ts` (used by the server, the player and watchers; no DOM):

```ts
export const FRAME_TICKS = 70224, GB_FPS = 4194304 / 70224;   // ≈ 59.7275
export interface Gb {
  frame: number;                        // frames stepped since power-on
  step(bits: number): number;           // set buttons, run exactly one frame; returns binjgb event flags seen
  read(addr: number): number;           // _emulator_read_mem
  ext(): Uint8Array;                    // cartridge RAM (via _ext_ram_file_data_new / _emulator_write_ext_ram)
  extChanged(): boolean;                // _emulator_was_ext_ram_updated
  state(): Uint8Array; restore(s: Uint8Array, frame: number): void;   // save states (~200 KB)
  screen(): Uint8ClampedArray;          // 160×144 RGBA view of the frame buffer
  audio(): Uint8Array | null;           // the stereo u8 buffer when the last step filled it, else null
  hash(): number;                       // FNV-1a over WRAM (0xC000–0xDFFF) + HRAM (0xFF80–0xFFFE)
  destroy(): void;
}
export async function createGb(opts: { wasm: ArrayBuffer | Uint8Array; rom: Uint8Array; save: Uint8Array | null; audioRate: number }): Promise<Gb>;
```

- One Emscripten module instance per `Gb` (each is cheap); `Binjgb({ wasmBinary })` works in Node although the build
  says `ENVIRONMENT=web` (verified).
- ROM buffer: `_malloc` rounded up to 32 KB, copied in; `_emulator_new_simple(ptr, size, audioRate, 2048, 0)`;
  `_joypad_new()` + `_emulator_set_default_joypad_callback`.
- `step(bits)`: write all eight `_set_joyp_*` from `bits`, then call `_emulator_run_until_f64(e, (frame + 1) * FRAME_TICKS)`
  in a loop until the result has the UNTIL_TICKS flag (4), collecting the AUDIO_BUFFER_FULL flag (2); `frame += 1`.
  The joypad state is static inside binjgb, so it must be set right before every step (two emulators in one process
  never interleave inside a step: Node is single-threaded).
- A save, when present, is written into cartridge RAM right after creation, before frame 0. binjgb's names are the
  reverse of what you'd guess: `_emulator_read_ext_ram(e, fd)` **loads** file data into the emulator,
  `_emulator_write_ext_ram(e, fd)` **dumps** the emulator's cartridge RAM into file data. No save → binjgb's own
  power-on fill (fixed seed, deterministic; both games then write a fresh save at frame ~100).
- Replays depend on the exact starting save (Shock Lobster seeds its RNG from the saved high scores), which is why the
  save always comes from the server (section 6).
- **Determinism (verified in the spike):** the WRAM+HRAM hash after 3000 frames of the same inputs is identical at
  44.1 kHz and 48 kHz audio rates, and a state saved at frame 1700 and restored into a fresh emulator continues to the
  same hash at frame 3000. Speed in Node: 6000–8000 frames/s (~100× real time), so a running cabinet costs the server
  about 1 % of a core.

**Buttons** (`shared/retro/buttons.ts`): `1` right, `2` left, `4` up, `8` down, `16` A, `32` B, `64` Select, `128` Start.
`normalize(bits)` drops both of a pair pressed together (left+right, up+down); the client normalizes before recording
and the server normalizes again before applying, so both sides step the same bits.

## 2. Cabinets in the Arcade

- Two new objects in `scripts/gen-map.mjs`, appended at the end (object ids stay stable), on the Arcade's top wall
  either side of the Music doorway, in line with the three Deck Park cabinets: type `retro_tobu` at (57,13) and type
  `retro_lobster` at (60,13), each 1×2, `use: { kind: 'retro', label: 'Tobu Tobu Girl' | 'Shock Lobster', game }`.
  The doorway column (58–59) stays clear; `gen-map.mjs`'s "unreachable cabinet" check covers `retro` too.
- `ObjectUse += { kind: 'retro'; label: string; game: RetroGameId }`; `USE_KINDS.retro = { use: true, reach: true }`;
  both types go into `KEEP_TYPES` so `withNewFixtures` brings them into saved layouts and edit mode can't delete them.
- Art (`gen-assets.mjs`): two upright cabinets in the existing pixel style, different from Deck Park's — a grey
  Game Boy-like body, a small green screen, a marquee in the game's colour (pink/blue for Tobu, red for the lobster);
  a `_on` frame each (screen lit) drawn while someone plays. Hover tooltip: "Tobu Tobu Girl · free", "Shock Lobster ·
  Ivan is playing · 2 watching", "Out of order" (ROM check failed).

## 3. Sessions, players and watchers

**Server module** `server/src/retro.ts`, class `Retro` (shape like `Arcade`: injected `now/send/broadcast/user`,
`dump()/load()`), owned by `World`.

- **Joining**: clicking a retro cabinet walks you to its front tile (`world.use` → `USE_MS` path like `arcade`); on
  arrival `retro.join(u, cabinetId)`. A free cabinet → you are its **player** and a new session starts. A busy one →
  you **watch** (at most 8 watchers). Bots, people in instances/the dungeon and offline people can't join (same guard
  as `arcade` in `world.use`).
- **One activity at a time**: joining a retro cabinet first leaves any Arcade session and vice versa. Everywhere
  `world.ts` calls `this.arcade.leave(u)`, `this.arcade.reset(u)` or `this.arcade.resend(u)`, it also calls the retro
  equivalent (walking anywhere, the exit door after going offline, instances, meetings, teleports, owner-tab change).
- **Status**: retro reuses `PublicUser.game = { cabinet, role: 'player' | 'spectator' }` and the `game_status`
  broadcast, so bubbles, the 🕹/👀 marks in the people list and tooltips work unchanged; the client's
  `gameDescription(cabinet)` first checks retro cabinets: "Playing Shock Lobster", "Watching Ivan play Tobu Tobu Girl".
- **Owner tab**: only the user's owner socket plays (messages from other sockets are ignored, like `game_*`). When the
  owner tab changes, the session moves: the old tab gets `retro_session null` (reason `elsewhere`), the new one a fresh
  `retro_session` with a snapshot (below).
- **Leaving** (Leave button, walking away, …): the session ends (settle, then the save is copied: section 6); watchers
  stay in the overlay on a "Ivan left · Play" screen — **Play** sends `use` on the cabinet (whoever's arrival comes
  first gets it; the others watch the new player). Watchers who leave just close their overlay.
- **Idle and cap**: a session ends by itself after 10 minutes without a button change (reason `idle`: both games'
  pause and game-over screens wait forever) or after 2 hours of frames (430 000, reason `cap`, "Time for a break").
- A ninth watcher gets the notice "The Shock Lobster cabinet is crowded" and isn't added.
- Cabinet summaries for the office: `retro_cabinets { cabinets: RetroCabinet[] }` with
  `RetroCabinet = { cabinet: string; game: RetroGameId; player: string | null; watchers: number; broken?: true }`,
  broadcast on change and sent on connect.

**Session state (server)**: `{ cabinet, game, runId (uuid), player, watchers[], gb: Gb, frame, startAt (ms), bits,
changes: [frame, bits][], committed: Set<number>, lastExtWrite }`.

## 4. Score probes (reading results from memory)

Results are read **only by the server**, from its own emulator, after every frame it steps. Clients never detect
results; they show what `retro_result` says (it arrives ~0.1–0.2 s after the game shows its game-over screen). The
probe's state lives in the server session and never goes through a snapshot. This is how RetroAchievements
leaderboards work: a few memory addresses per game define start, end and value.

```ts
// shared/retro/probes.ts (pure; tested in Node)
export type Reader = (addr: number) => number;              // Gb.read
export interface ProbeResult { track: string; score: number; time?: number }
export interface Probe {
  start(): unknown;                                          // fresh probe state for a session
  step(state: unknown, read: Reader): ProbeResult | null;     // after each frame
  settle: { press: number; maxFrames: number };              // section 6
}
```

The addresses below were found by RAM search against the shipped ROMs and checked against their sources (reports and
scripts: `side-session-notes/…/retro-probes/`). A result whose bytes are out of their documented range is invalid
(logged, not committed).

### Shock Lobster

ROM header version $00 = the 2021 compo release (source commit `8eee745d`, not GitHub HEAD). Scores use H. Mulder's
HiScore format, `digits(a)`: 8 bytes, one decimal digit per byte, most significant first, `$80` = blank leading digit;
value = Σ (byte & $7F)·10^(7−i); any other byte value is invalid.

| Address | Meaning |
|---|---|
| `$FFAA` `hGameMode` | 0 credits, 1 title, 2 battle, 3 loadout |
| `$FF80` `hMessageBoxActive` (reused on other screens, can be 4 on the title: read it only while `$FFAA`=2) | 0 running, 1 start items, 2 final items, 3 "Impending defeat…", 4 Game Over |
| `$C8F0–$C8F7` `wBattleDamage` | current score, `digits` |
| `$CB80–$CB81` (u16 LE), `$CB82` | damage/pearls not yet added to the score |
| `$CD0A` `wGameSpeed` | 1 slow, 2 medium, 3 fast |

- **Rule**: arm when `$FFAA`=2 and `$FF80`∈{0,1}. When armed and `$FFAA`=2 and `$FF80`=4: disarm and mark "ending";
  on the first frame (that one or later) with `$CB80–$CB82` all zero, return `{ track: slow|medium|fast (from $CD0A),
  score: digits($C8F0) }`. It re-arms only when the next battle starts.
- Verified: fires exactly once in 420 runs (scripted and seeded-random input including pauses, revives and items),
  always with the score the game shows. Pause, the Second Wind revive and the "Impending defeat" panel never fire it.
- Use `wBattleDamage`, never the game's own high-score slot: the game copies the high score one hit too early (194 on
  screen, 191 saved).
- **Tracks**: the game keeps a separate high score per speed, so the board does too: Slow / Medium / Fast (unit
  "points").
- **Saving quirk**: this ROM writes its save at battle start and when the Game Over panel is closed, not at defeat.
  `settle = { press: Start, maxFrames: 60 }`: leaving on the Game Over panel still saves that run's pearls.
- The Game Over and pause screens wait forever for input (hence the idle rule in section 3).

### Tobu Tobu Girl Deluxe

ROM runs in Game Boy Color mode (binjgb picks it from the header). Addresses match `tobudx.sym` in the game's repo.

| Address | Meaning |
|---|---|
| `$C0A5` `gamestate` | 3 level select, 4 in a level (the pause menu runs inside 4), 6 win screen, 7 high scores, 10 ending |
| `$C0A6` `scene_state` (read together with `gamestate`; other screens reuse it) | in a level: 0 active, 1 dead, 2 completed (portal), 3 quit |
| `$C0A7` `level` | 1 Plains, 2 Clouds, 3 Space, 4 Dream, 5 Heaven (endless) |
| `$C0B3` `elapsed_time` (u16 LE) | seconds in this level/run |
| `$C0B5` `kills` (u16 LE) | stomps |
| `$C0B7` `wave` (u16 LE) | Heaven wave, 0-based |

- **Rule**: arm on any frame with `gamestate`=4 and `scene_state`=0. While armed, fire when `scene_state` is non-zero
  and has the same value on two consecutive frames (one game-loop pass can write "dead" and then "portal"; the second
  sample absorbs it; `gamestate` may already be 3 on a quit). Then disarm until the next arm. At the firing frame:
  - `scene_state`=2 and `level` 1–4 → a cleared level: `{ track: plains|clouds|space|dream, score, time: elapsed_time }`;
  - `scene_state`=1 and `level`=5 → the Heaven run is over: `{ track: heaven, score: wave + 1, time: elapsed_time }`;
  - anything else (a death in levels 1–4 — the game restarts the level itself —, a Heaven wave cleared, a quit) → no
    result.
- **Score**: the game's own formula is `3 × (level_max_time − elapsed) + kills` with `level_max_time` = 56, 56, 64, 64,
  kept in **one byte**, so a clear slower than `level_max_time` wraps (60 s on Plains → 254, the best possible score).
  Our boards use the intended value without the wrap: `3 × max(0, level_max_time − elapsed_time) + kills`. It equals the
  game's number in every normal case (the game shows it ×100: "11500" for 115); only slow clears differ, where the
  game's own screen shows the wrapped number. Heaven's score is the wave count shown on its RETRY screen.
- **Tracks**: Plains, Clouds, Space, Dream (unit "points", tiebreak: shorter time) and Heaven (unit "waves",
  tiebreak: shorter time). Levels unlock as in the game: the player's cartridge remembers them.
- **Saving**: the game writes its high-score table — which is also how it remembers unlocked levels — 309 frames after
  the portal on Plains and Clouds, 213 on Space, 51 after a Heaven death (the generic settle rule in section 6 covers
  someone leaving in between; `settle = { press: 0, maxFrames: 400 }`).
- Verified with real inputs and no memory pokes: Plains 21 s / 10 stomps → 115, Clouds 38 s / 17 → 71, Space 51 s / 22
  → 61, Heaven 4 waves cleared then death → 5 (each from the previous run's save); a time-out, a fall and a pause-quit
  each detected once as "no result". Dream isn't verified (the probe bot ran out of time there); it follows the same
  rule.

## 5. Protocol and lockstep

```ts
// ClientMsg
| { t: 'retro_frames'; runId: string; upto: number; changes: [frame: number, bits: number][] }  // player only
| { t: 'retro_leave' }
// ServerMsg
| { t: 'retro_session'; session: RetroView | null; reason?: 'elsewhere' | 'ended' | 'idle' | 'cap' | 'broken' }
| { t: 'retro_frames'; runId: string; upto: number; changes: [number, number][] }   // relayed to watchers
| { t: 'retro_result'; runId: string; result: RetroResult }                          // player + watchers
| { t: 'retro_cabinets'; cabinets: RetroCabinet[] }
| { t: 'retro_boards'; boards: RetroBoards }
interface RetroView {
  cabinet: string; game: RetroGameId; runId: string; player: string; role: 'player' | 'spectator';
  save: string | null;                       // base64 cartridge RAM at power-on (null = blank cartridge)
  snapshot: { frame: number; state: string } | null;   // base64 deflate-raw save state; null = start from power-on
  upto: number; bits: number;                // the server's confirmed frame and the buttons held after it
  serverNow: number; startAt: number;
}
```

- **Frame numbers**: `upto` is the number of frames stepped since power-on (`gb.frame` after stepping). A change
  `[f, bits]` means: these buttons are held from the step that takes `gb.frame` from `f` to `f + 1` onward, until the
  next change. The buttons before the first change are 0.
- **The player's loop** (`client/src/retro/player.ts`): the emulator advances by real time at `GB_FPS` (driven by
  `requestAnimationFrame`, at most 4 frames per animation frame; when the page lags it slows down instead of skipping,
  since the game's time is its frame count). Before each step it samples the controls and normalizes them; if the bits
  differ from the previous step's, it records `[gb.frame, bits]`. Every 100 ms (and before `retro_leave`) it sends
  `retro_frames { upto: gb.frame, changes recorded since the last send }`.
- **Pause**: the overlay menu, a hidden tab or a blurred window stops stepping (and mutes the game). Nothing is sent
  in between; the game simply continues from the same frame afterwards (both games also have their own pause on
  Start).
- **Server validation** (anything else is ignored, not an error): sender is the session's player on the owner socket;
  `runId` matches; `upto` is an integer > the session's `upto` and ≤ `upto + 240`; `upto` ≤ the real-time frame count
  since `startAt` + 60 (no running ahead of the wall clock by more than 1 s); `changes` sorted, frames in
  `[previous upto, upto)`, unique, at most 240, bits integers 0–255; at most 20 messages a second.
- **Server stepping**: on an accepted message the server steps its `Gb` from the previous `upto` to the new one,
  applying each change at its frame, runs the probe after every frame (section 4), writes the save when the cartridge RAM changed
  (section 6), then relays the same message to watchers. A run that only the server could see end (e.g. the player's
  tab closed mid-run) simply has no result.
- **Snapshots**: a `retro_session` for a watcher, a reconnecting player or a new owner tab carries the server's current
  emulator state (`gb.state()`, deflate-raw, base64, ~215 KB) at its `upto`; the client restores it and continues from
  there (a reconnecting player loses at most the frames the server hadn't confirmed, ~0.1–0.3 s). A brand-new session
  has `snapshot: null` and starts at power-on from `save`.
- **Watchers** (`client/src/retro/watcher.ts`) play the relayed changes 15 frames (250 ms) behind the newest `upto` they
  received, so they always have the inputs for the frame they show. If they fall more than 2 s behind (a hidden tab,
  a slow machine) they fast-forward without drawing or sound, up to 600 frames per animation frame, then resume.
  Watchers never send frames.
- **Dev hook**: `window.__retro = { player, watcher, hash(), frame }` in dev builds only, for the browser check.

## 6. Your cartridge (saves)

- `state.json → retro.saves: Record<RetroGameId, Record<userId, string>>`: base64 of the cartridge RAM (8 KB for both
  games → ~11 KB each). Rejected on load if the decoded size isn't the ROM's cartridge RAM size (from the ROM header).
- The save is always the **server's** emulator cartridge RAM, never data from a client. After a step in which
  `extChanged()` was true the server copies `gb.ext()` into `saves` (at most once a second per session) and marks the
  world dirty, so the next 30 s state save includes it.
- **Settle**: both games save a moment *after* the result (Tobu after its portal animation, Shock Lobster only when its
  Game Over panel is closed). So when a session ends for any reason and the last committed result came after the last
  cartridge write, the server keeps stepping its emulator: one frame with the game's `settle.press`, then frames with no
  buttons, until the game writes its cartridge RAM or `settle.maxFrames` pass. Then it copies the cartridge RAM one
  last time. Nobody sees these frames.
- A new player's first session starts with a blank cartridge (`save: null`).
- No reset button of our own: both games have their own (Shock Lobster: "Reset Save" in the loadout details; Tobu:
  Down+Select+B on the title screen). An admin can drop a save from `state.json` by hand.

## 7. Boards

```ts
interface RetroEntry { userId: string; name: string; score: number; time?: number; at: number }  // time: seconds (Tobu tiebreak)
interface RetroResult { game: RetroGameId; track: string; score: number; time?: number; best: boolean; weekRank: number; allRank: number }
interface RetroBoard { all: Record<string, RetroEntry>; week: Record<string, RetroEntry> }   // userId → their best
interface RetroBoards { week: string; games: Record<RetroGameId, Record<string, RetroBoard>> }  // game → track → board
```

- `state.json → retro.boards` (all fields optional; old saves load unchanged).
- A committed result replaces the person's entry on its `(game, track)` board when it is better: higher score, then
  lower `time`, then (equal) the earlier one stays. Everyone's best is kept (≈30 people, a few KB), so ranks are exact.
- Shown like an arcade high-score table: the top 10, plus your own row under a divider when you're below 10th. Order:
  score descending, `time` ascending, earlier `at`; equal score and time share a rank.
- **Weeks**: the same Warsaw-Monday key as the Arcade (`weekKey` from `shared/arcade/weeks.ts`); when the key changes,
  every `week` list empties (lazily on the next read or write) and `week` takes the new key.
- `retro_boards` is sent on connect and broadcast after every commit.
- **Retro tab** in the Arcade boards popover (after the existing tabs): a game switch (Tobu Tobu Girl / Shock Lobster),
  a **This week** / **All time** switch, then one table per track: rank, name, score (+ time for Tobu). Empty:
  "Play the Tobu Tobu Girl cabinet to get on the board."
- `retro_result` to the player and watchers after a commit (`best`: it became the player's all-time entry; ranks are
  after the commit, 1-based); the overlay shows a toast: "Plains · 87 points · new personal best · #2 this week".
- The `committed` set in the session holds the frames of results already committed, so a result is never written
  twice even if a probe misbehaves.

## 8. The overlay

`client/src/retro/RetroOverlay.tsx`, opened while `store.retro` holds a session (you play or watch); built on the
same modal shell, focus handling and `COMPACT` rules as `ArcadeOverlay`.

- **Layout**: header — game title, "Playing" or "Watching Ivan", your best on the current track for that game,
  Boards (opens the popover on the Retro tab), Menu, Leave. Centre — a dark bezel with the 160×144 canvas at the
  largest whole-number scale that fits (at least 2×, `image-rendering: pixelated`). Under it — the game's controls
  line and the key legend. Controls lines: Tobu — "←/→ move · A dash (with a direction) · B jetpack · Start pause";
  Shock Lobster — "A/B use the selected skill pair · D-pad picks the pair · Start pause · Select shows details".
- **Controls**: D-pad — arrows / WASD; A — Z, J, or Space (Space only when voice isn't in push-to-talk mode, as in
  Deck Park); B — X, K; Start — Enter; Select — Shift. Gamepad (standard mapping): d-pad or left stick, A = button 0,
  B = buttons 1/2, Select = 8, Start = 9. Touch devices (or `COMPACT`): an on-screen D-pad, A, B, Start, Select under
  the screen. Keys reach the game only while the overlay has focus and no text field is focused (the `ParkInput`
  gate); Esc opens the menu.
- **Menu**: Resume · Controls · Credits & licences · Leave. The game is paused while the menu is
  open.
- **Watchers** see the same screen without controls; their header says "Watching Ivan · Tobu Tobu Girl" with Leave.
- **Credits & licences** screen: for each game its title, authors, licence with a link, source repository, where the
  ROM came from; plus binjgb (MIT). Texts in section 9.

## 9. Credits

- **Tobu Tobu Girl Deluxe** — © 2017 Tangram Games. Code: MIT License. Graphics, text, sound and music: Creative Commons
  Attribution 4.0 International. Sound by potato-tan. Source: github.com/SimonLarsen/tobutobugirl-dx · tangramgames.dk.
- **Shock Lobster** — © 2021 Dave VanEe. zlib License. Uses gb-starter-kit and gb-vwf (ISSOtm), hUGEDriver
  (SuperDisk), sound effect driver and BCD routines by PinoBatch, HiScore library by H. Mulder. Source:
  github.com/tbsp/shock-lobster.
- **binjgb** — © 2016 Ben Smith. MIT License. github.com/binji/binjgb.
- ROM files from Homebrew Hub (hh.gbdev.io), unchanged.

## 10. Sound

- Each client that runs an emulator (the player and every watcher) plays its audio as a soundscape source
  `retro:<cabinet>` of a new kind `'retro'` at the cabinet's tile, category `music` (the Music slider in the mixer),
  `clipGain` 0.6, so the sealed-room law applies: heard only inside the Arcade, quieter a few tiles away. People in the
  Arcade who aren't watching don't run the emulator and hear nothing from it.
- Audio path: when a step fills binjgb's buffer (2048 stereo u8 frames at the AudioContext's rate), convert to float
  (`(v - 128) / 128`), schedule it as an `AudioBufferSourceNode` into the source's input 100 ms ahead; on an underrun
  or after a pause, restart the schedule at now + 100 ms. Paused or fast-forwarding → no audio.
- The server creates its emulators with the audio rate 48 000 and discards the audio.

## 11. Disconnects, reloads and restarts

- **Reload / reconnect / new owner tab**: the session is still there (until the person walks out the exit door after
  going offline, exactly as for Deck Park); the new socket gets `retro_session` with a snapshot and the game continues.
- **Server restart**: sessions are memory-only and vanish; saves and boards come back from `state.json` (progress
  made in the last ≤ 30 s may be lost). Clients get `retro_session null` on reconnect (no session).
- **A ROM fails its checksum**: that cabinet is broken (tooltip "Out of order", join refused with a notice).

## 12. Tests

- **Recorded runs** (`server/src/fixtures/retro/*.json`: `{ game, save: string | null, changes: [frame, bits][], upto,
  expect: { results: RetroResult[], hash: number } }`), produced by the probe scripts with plain button inputs (no
  memory pokes), converted to bits, from `retro-probes/`:
  - Shock Lobster `lobster/verify-inputlog.json`: 3721 frames from a blank cartridge, five runs at medium speed scoring
    132, 141, 175, 231, 490;
  - Tobu `tobu/runs/`: `l1.json` from a blank cartridge (Plains 115, 21 s) → its save `after-l1.bin` → `l2.json`
    (Clouds 71, 38 s) → `after-l2.bin` → `l3c.json` (Space 61, 51 s) → `after-l3.bin` → `h.json` (Heaven 5 waves,
    57 s). Each fixture stores its starting save and the expected save after it (the next fixture's start).
- `server/src/retro.test.ts` (Node, `node --import tsx --test`, silent):
  - each fixture: the results and the final hash match, the probe fires exactly once per run;
  - the same fixture at 44.1 and 48 kHz → same hash; snapshot at a middle frame + restore → same continuation;
  - `Retro` with fake transport: join/watch/leave, one activity at a time, owner change, frames validation (stale,
    duplicate, unsorted, too many, future frames, wrong runId, non-player), watcher relay order, results committed
    exactly once and boards updated, week rollover, saves written from the server emulator and loaded on the next
    session, save size check on load, `dump()`/`load()` round trip, ROM checksum failure → broken cabinet.
- **Browser check** (headless Playwright, `--mute-audio`, Chromium and WebKit, never the in-app browser pane): two
  people; A plays the Lobster fixture through the real client (feed the recorded changes via `__retro`), B watches;
  A's and B's emulator hashes match the server's at common frames; the result toast and the Retro board show the
  fixture's score; B reloads mid-run and catches up from the snapshot; the game's audio reaches the soundscape source
  (analyser RMS > 0, measured upstream of the muted output).
- `npm test`, `npm run typecheck`, `npm run build -w client`.

## 13. Implementation steps (one executor at a time; each leaves the app working)

1. **Engine and server**: vendored files and ROMs, `shared/retro/{gb,buttons,games,probes}.ts`, map objects and art,
  `server/src/retro.ts` + World wiring + protocol + persistence, fixtures and `retro.test.ts`.
2. **Client**: `client/src/retro/*` (overlay, player, watcher, input, audio), store/net handling, cabinet tooltips and
  glow, Retro boards tab, credits screen, the browser check.
