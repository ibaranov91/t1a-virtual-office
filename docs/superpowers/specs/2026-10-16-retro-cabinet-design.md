# Retro cabinets: Game Boy homebrew in the Arcade — design

Owner: Andrii Butko · 2026-10-16 · status: v3, after two Codex spec reviews · builds on
`2026-10-16-arcade-party-pack-design.md` (Arcade boards popover, weeks) and `2026-10-15-sound-v3-design.md` (sealed
rooms). Branch `andr/retro-cabinet`, cut from `andr/arcade-party` step 1 (`e6c4630`).

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
- Routine choices follow how arcade high-score tables, RetroAchievements leaderboards and emulator front-ends do it;
  simplicity and reliability first.

Built in one pass (section 13 splits it into two executor steps, each leaving the app working).

## Out of scope

- Other games or platforms; uploading ROMs; any commercial ROM.
- Multiplayer Game Boy (link cable), Break Set integration, cheers/predictions for retro games.
- A live mini-screen on the cabinet sprite for people who aren't watching (the cabinet only lights up).
- Policing slow motion: a modified client could run the emulator slower than real time. Faked scores are impossible;
  a slowed-down run is an accepted residual risk. The server only limits how fast frames may arrive (section 5).
- Our own save-reset button (both games have one, section 6) and a retro Hall of Fame.

## 1. Emulator, ROMs and the catalogue

**Vendored files** (committed, with their licences):

- `vendor/binjgb/binjgb.mjs` = upstream `docs/binjgb.js` (binji/binjgb `16621111ed0ee73bcc45c912a823bcebedcffc0f`)
  with one line appended: `export default Binjgb;`. `vendor/binjgb/binjgb.wasm` = upstream `docs/binjgb.wasm`.
  `vendor/binjgb/LICENSE` (MIT, © 2016 Ben Smith).
- `client/public/retro/binjgb.wasm` is a copy of the wasm (the client fetches it; the server reads the vendor copy).
- ROMs, unchanged from the gbdev/database repo, in `client/public/retro/`:
  - `tobudx.gb` (262144 bytes, sha256 `0a0e8018dbbc8d7f8cd99f05e7cdc7b4cc9e358ecfe9377ebfb2291a84c6e310`,
    from `entries/tobutobugirldeluxe/tobudx.gb`);
  - `shocklobster.gb` (32768 bytes, sha256 `f14efd0340903b1b00d7e8b4b39687d4bc33355ac7742267ccfddfe92f54a611`,
    from `entries/shock-lobster/shocklobster.gb`);
  - `LICENSES.md` with both licences and the credits (section 9).
- The server reads the ROMs from `client/public/retro/` (deploy rsyncs the working copy, so the files are there) and
  checks their sha256 at startup. A missing or different ROM makes that cabinet **out of order** (logged once; tooltip
  "Out of order"; joining it gives the notice "This cabinet is out of order").

**Catalogue** `shared/retro/games.ts`:

```ts
export type RetroGameId = 'tobu' | 'lobster';
export interface RetroGame {
  id: RetroGameId; title: string; rom: string; sha256: string; bytes: number;   // file under /retro/
  tracks: { id: string; label: string; unit: 'points' | 'waves'; timed: boolean }[];  // one board per track
  controls: string;                                                           // one line shown under the screen
  credits: string[]; licence: string; links: { label: string; url: string }[];
  probe: Probe;                                                               // section 4
}
```

**Emulator wrapper** `shared/retro/gb.ts` (used by the server, the player and watchers; no DOM):

```ts
export const FRAME_TICKS = 70224, GB_FPS = 4194304 / 70224;   // ≈ 59.7275
export interface Gb {
  frame: number;                        // frames stepped since power-on
  step(bits: number): void;             // set buttons, run exactly one frame
  read(addr: number): number;           // _emulator_read_mem
  ext(): Uint8Array;                    // copy of the cartridge RAM
  takeExtWrite(): boolean;              // _emulator_was_ext_ram_updated (reading it clears binjgb's flag)
  state(): Uint8Array; restore(s: Uint8Array, frame: number): void;   // save states (~200 KB)
  screen(): Uint8ClampedArray;          // 160×144 RGBA view of the frame buffer
  audio(): Uint8Array[];                // drains the stereo u8 buffers completed since the last call
  hash(): number;                       // FNV-1a over WRAM (0xC000–0xDFFF) + HRAM (0xFF80–0xFFFE)
  destroy(): void;
}
export async function createGb(opts: { wasm: ArrayBuffer | Uint8Array; rom: Uint8Array; save: Uint8Array | null;
  audioRate: number; audio: boolean }): Promise<Gb>;
```

- One Emscripten module instance per `Gb`. `Binjgb({ wasmBinary })` works in Node although the build says
  `ENVIRONMENT=web` (verified). `createGb` is async (module instantiation); everything after it is synchronous.
- ROM buffer: `_malloc` rounded up to 32 KB, copied in; `_emulator_new_simple(ptr, size, audioRate, 2048, 0)`;
  `_joypad_new()` + `_emulator_set_default_joypad_callback`.
- **Buffers are allocated once per `Gb`**: one state FileData (`_state_file_data_new`) and one cartridge FileData
  (`_ext_ram_file_data_new`), created with the emulator, reused for every `state()`/`restore()`/`ext()`, freed in
  `destroy()`. (Allocating and deleting a state FileData per snapshot runs the module out of memory after ~78 cycles.)
- `step(bits)`: write all eight `_set_joyp_*` from `bits`, then call `_emulator_run_until_f64(e, (frame + 1) * FRAME_TICKS)`
  in a loop until the result has the UNTIL_TICKS flag (4); `frame += 1`. **Whenever a call returns the
  AUDIO_BUFFER_FULL flag (2), copy the audio buffer right away**, before the next `run_until` (binjgb reuses it), into
  the queue `audio()` drains; with `audio: false` (the server) nothing is copied. The joypad state is static inside
  binjgb, so it is set right before every step (Node is single-threaded, so two emulators never interleave inside a
  step).
- A save, when present, is loaded into cartridge RAM right after creation, before frame 0. binjgb's names are the
  reverse of what you'd guess: `_emulator_read_ext_ram(e, fd)` **loads** file data into the emulator,
  `_emulator_write_ext_ram(e, fd)` **dumps** the emulator's cartridge RAM into file data. No save → binjgb's own
  power-on fill (fixed seed, deterministic; both games then format a fresh save in their first ~100 frames).
- Replays depend on the exact starting save (Shock Lobster seeds its RNG from the saved high scores), which is why the
  save always comes from the server (section 6).
- **Determinism (verified):** the same inputs give the same WRAM+HRAM hash at 44.1 and 48 kHz; a state saved at one
  rate and restored at the other continues to the same hash. Speed in Node: 6000–8000 frames/s (~100× real time).

**Buttons** (`shared/retro/buttons.ts`): `1` right, `2` left, `4` up, `8` down, `16` A, `32` B, `64` Select, `128` Start.
`normalize(bits)` drops both of a pair pressed together (left+right, up+down); the client normalizes before recording
and the server normalizes again before applying, so both sides step the same bits.

## 2. Cabinets in the Arcade

- Two new objects in `scripts/gen-map.mjs`, appended at the end (object ids stay stable), on the Arcade's top wall
  right of the Deck Park cabinets, under the records board: type `retro_tobu` at (62,13) and type `retro_lobster` at
  (63,13), each 1×2 with 16×32 art, `use: { kind: 'retro', label: 'Tobu Tobu Girl' | 'Shock Lobster', game }`. The
  Music approach (57–60 × 13–15) stays clear, as the Arcade's existing map tests require; `gen-map.mjs`'s
  "unreachable cabinet" check covers `retro` too.
- `ObjectUse += { kind: 'retro'; label: string; game: RetroGameId }`; `USE_KINDS.retro = { use: true, reach: true }`;
  both types go into `KEEP_TYPES` so `withNewFixtures` brings them into saved layouts and edit mode can't delete them.
  Admins can still move them (also to another room); sound follows the cabinet (section 10).
- Art (`gen-assets.mjs`): two upright cabinets in the existing pixel style, different from Deck Park's — a grey
  Game Boy-like body, a small green screen, a marquee in the game's colour (pink/blue for Tobu, red for the lobster);
  a `_on` frame each (screen lit) drawn while someone plays. Hover tooltip: "Tobu Tobu Girl · free", "Shock Lobster ·
  Ivan is playing · 2 watching", "Out of order".

## 3. Cabinets, players and watchers (server)

**Server module** `server/src/retro.ts`, class `Retro` (shape like `Arcade`: injected `now/send/broadcast/user`,
`dump()/load()`, plus `shutdown()`), owned by `World`.

```ts
interface Cabinet { id: string; game: RetroGameId; watchers: string[]; broken: boolean;
  starting: { token: number; player: string } | null;   // reserved while the emulator is being created
  session: Session | null }
interface Session { runId: string; sync: number; player: string; gb: Gb; upto: number; bits: number;
  credit: number; creditAt: number; probe: unknown; lastResultFrame: number; lastWriteFrame: number;
  extDirty: boolean; lastChangeAt: number; startAt: number }
```

- **Joining**: clicking a retro cabinet goes through `world.use` exactly like `arcade` — the same stand-spot choice
  (neighbouring tiles first, then any free tile in the room, `pathTo`, seated departures, immediate arrival when already
  there) and `USE_MS` 0. On arrival `retro.join(u, cabinetId)`:
  - the cabinet is out of order → notice, nothing else;
  - free (no session, nothing starting) → you are its **player**: the cabinet is reserved
    (`starting = { token: ++n, player }`) *before* `createGb` is awaited; when it resolves, a session starts only if the
    token is still current and you are still there; otherwise the new `Gb` is destroyed. If creation fails: destroy
    what was made, clear `starting`, notice "The cabinet didn't start".
  - busy or starting → you **watch** (at most 8 watchers per cabinet; a ninth gets the notice "The Shock Lobster
    cabinet is crowded").
  - Bots, people in instances or the dungeon, and offline people can't join (the `arcade` guard in `world.use`).
- **Watchers belong to the cabinet, not the session.** When the player leaves, the cabinet becomes vacant and its
  watchers stay, seeing the vacant view ("Ivan left · Play"); when the next person starts playing, every watcher gets
  the new session automatically. **Play** sends `use` on the cabinet (whoever arrives first plays; the others keep
  watching). Leaving (Leave, walking away, …) removes a watcher and clears their status.
- **One activity at a time**: joining a retro cabinet first leaves any Arcade session and vice versa. Everywhere
  `world.ts` calls `this.arcade.leave(u)` it also calls `this.retro.leave(u)` (walking anywhere, the exit door after
  going offline, instances, meetings, teleports). The `reset`/`resend` hooks are in "Owner tab" below.
- **Status**: retro reuses `PublicUser.game = { cabinet, role: 'player' | 'spectator' }` and the `game_status`
  broadcast, so bubbles, the 🕹/👀 marks in the people list and tooltips work unchanged; the client's
  `gameDescription(cabinet)` first checks retro cabinets: "Playing Shock Lobster", "Watching Ivan play Tobu Tobu Girl",
  "At the Tobu Tobu Girl cabinet" (a watcher of a vacant cabinet).
- **Owner tab**: only the user's owner socket plays or watches (messages from other sockets are ignored, like
  `game_*`). `world.setOwner` calls `retro.handover(u)`: the old tab gets `retro_session null` (reason `elsewhere`)
  and stops. If `u` is the cabinet's **player**, the server keeps its emulator and buttons as they are (no neutral
  event), sets `sync + 1` and sends the new owner tab a `playing` view with a snapshot (section 5). If `u` is a
  **watcher**, nothing changes for the session: the new tab gets the cabinet's current view (`vacant`, `starting` or
  `playing` with a snapshot and the current `sync`).
- **Connect**: a reconnecting member gets their cabinet's current view as above (a player gets `sync + 1`); a user
  with no retro membership gets an explicit `retro_session null`, so an overlay left over from before a server
  restart closes.
- **Disconnect** (client side): when the socket drops, the player's loop stops stepping and the overlay shows
  "Reconnecting…"; it only continues from the view the server sends after the reconnect.
- **Resync on request**: `retro_resync` (from a member's owner socket) re-sends the cabinet's current view without
  walking or touching membership; for the player it is a resync (`sync + 1`). The overlay's **Retry** after a load
  failure uses it.
- **A session ends** when the player leaves, after 10 minutes without a button change (reason `idle`: both games'
  pause and game-over screens wait forever) or after 2 hours of frames (430 000, reason `cap`, "Time for a break").
  Always the same steps: settle (results confirmed while settling are committed and sent), copy the cartridge
  (section 6), destroy the `Gb`. Then the player gets `retro_session null` with the reason (their overlay shows a
  notice for `idle`/`cap` and closes; their status clears; on `idle`/`cap` they stay where they are), and every
  watcher gets the `vacant` view. A watcher's client first plays out the frames and results it already has (up to the
  last confirmed `upto`), then shows the vacant screen.
- Cabinet summaries for the office: `retro_cabinets { cabinets: RetroCabinet[] }` with
  `RetroCabinet = { cabinet: string; game: RetroGameId; player: string | null; watchers: number; broken?: true }`,
  broadcast on change and sent on connect.

## 4. Score probes (reading results from memory)

Results are read **only by the server**, from its own emulator, after every frame it steps. Clients never detect
results; they show what `retro_result` says. The probe's state lives in the server session and never goes through a
snapshot. This is how RetroAchievements leaderboards work: a few memory addresses per game define start, end and
value.

```ts
// shared/retro/probes.ts (pure; tested in Node)
export type Reader = (addr: number) => number;              // Gb.read
export interface ProbeResult { track: string; score: number; time?: number }
export interface Probe {
  start(): unknown;                                          // fresh probe state for a session
  step(state: unknown, read: Reader): ProbeResult | null;     // after each frame; fires once per run by construction
  pending(state: unknown, read: Reader): boolean;              // a run is ending and its result may still come
  settle: { press: number; maxFrames: number };              // section 6
}
```

The addresses below were found by RAM search against the shipped ROMs and checked against their sources; the review
replayed every fixture and got the same numbers. Reports and scripts: `side-session-notes/…/retro-probes/`. A result
whose bytes are out of their documented range is invalid (logged, not committed).

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
- **Tracks**: the game keeps a separate high score per speed, so the board does too: Slow / Medium / Fast (points).
- **Saving quirk**: this ROM writes its save at battle start and when the Game Over panel is closed, not at defeat.
  `pending` = "ending" (Game Over shown, score not yet read); `settle = { press: Start, maxFrames: 60 }`: leaving on
  the Game Over panel still saves that run's pearls. A battle abandoned mid-run is not pending: no settle, no result.
- The Game Over and pause screens wait forever for input (hence the idle rule in section 3).

### Tobu Tobu Girl Deluxe

The ROM runs in Game Boy Color mode (binjgb picks it from the header). Addresses match `tobudx.sym` in the game's repo.

| Address | Meaning |
|---|---|
| `$C0A5` `gamestate` | 3 level select, 4 in a level (the pause menu runs inside 4), 6 win screen, 7 high scores, 10 ending |
| `$C0A6` `scene_state` (read together with `gamestate`; other screens reuse it) | in a level: 0 active, 1 dead, 2 completed (portal), 3 quit |
| `$C0A7` `level` | 1 Plains, 2 Clouds, 3 Space, 4 Dream, 5 Heaven (endless) |
| `$C0B3` `elapsed_time` (u16 LE) | seconds in this level/run |
| `$C0B5` `kills` (u16 LE) | stomps |
| `$C0B7` `wave` (u16 LE) | Heaven wave, 0-based |
| `$FF40` LCDC | `& $A0` = `$A0` while the screen and window are on (off while the pause menu loads) |

- **Rule** (compares each frame with the previous one; the probe state keeps the previous frame's values and a death
  latch):
  - **level cleared**: `gamestate` goes 4 → 6 (win screen) or 4 → 10 (the ending, after Space) with `level` 1–4 →
    `{ track: plains|clouds|space|dream, score, time: elapsed_time }`. This is the frame the game writes its
    high-score table (~310 frames after the portal, ~212 on Space), and only a real clear gets there;
  - **Heaven over**: `gamestate`=4, `level`=5, `scene_state`=1 and LCDC `& $A0` = `$A0` on two consecutive frames →
    `{ track: heaven, score: wave + 1, time: elapsed_time }`, once; the latch clears when `scene_state` ≠ 1;
  - no result for: the same death condition on levels 1–4 (the game restarts the level by itself), a quit (4 → 3), a
    Heaven wave cleared (`scene_state`=2 on level 5), leaving Heaven's RETRY screen (4 → 6 with `level`=5).
  - Why not "scene_state changed": the game runs its pause check after the death and portal checks in the same pass,
    so Start pressed on the exact death or portal frame opens the pause menu while `scene_state` still reads 1 or 2;
    Resume then cancels the death or the clear, Quit writes 3. A `scene_state` rule then reports phantom clears,
    phantom Heaven scores and double clears (reproduced in the second probe); this rule gets all four cases right
    because a clear is only confirmed by `gamestate` leaving 4, and the pause menu turns the LCD/window off while a
    real death keeps them on for 48 frames.
- **Score**: the game's own formula is `3 × (level_max_time − elapsed) + kills` with `level_max_time` = 56, 56, 64, 64,
  kept in **one byte**, so a clear slower than `level_max_time` wraps (60 s on Plains → 254, the best possible score).
  Our boards use the intended value without the wrap: `3 × max(0, level_max_time − elapsed_time) + kills`. It equals the
  game's number in every normal case (the game shows it ×100: "11500" for 115); only slow clears differ, where the
  game's own screen shows the wrapped number. Heaven's score is the wave count shown on its RETRY screen.
- **Tracks**: Plains, Clouds, Space, Dream (points) and Heaven (waves), each with time as the tiebreak (shorter wins).
  Levels unlock as in the game: the player's cartridge remembers them.
- **Saving**: the game writes its high-score table — which is also how it remembers unlocked levels — on the clear's
  result frame, and over two frames ~50 after a Heaven death (6112 and 6113 in the fixture).
  `pending` = `gamestate`=4, `level` 1–4 and `scene_state`=2 (the portal is touched; the clear is confirmed ~310 frames
  later), so leaving during the portal animation still counts the clear and saves the unlock:
  `settle = { press: 0, maxFrames: 400 }`. If the portal frame opened the pause menu, neutral frames keep it paused,
  the clear is never confirmed and nothing is committed — as in the game.
- Verified with real inputs and no memory pokes (first probe's logs, this rule): Plains 21 s / 10 stomps → 115 at frame
  2681, Clouds 38 s / 17 → 71 at 3745, Space 51 s / 22 → 61 at 4466, Heaven 4 waves cleared then death → 5 waves,
  57 s, at 6063 (each from the previous run's save; the second probe's bot also cleared Plains for 127). Time-outs,
  falls, pause-quits and Start on the death/portal frame (Resume and Quit) were checked in the second probe. Clouds to
  Dream clears by real play are only covered by these logs and memory-poke tests; Dream follows the same rule.

## 5. Protocol and lockstep

```ts
// ClientMsg
| { t: 'retro_frames'; runId: string; sync: number; from: number; upto: number; changes: [frame: number, bits: number][] }
| { t: 'retro_leave' }
| { t: 'retro_resync' }                                     // re-send my cabinet's view (section 3)
// ServerMsg
| { t: 'retro_session'; view: RetroView | null; reason?: 'elsewhere' | 'ended' | 'idle' | 'cap' | 'broken' }
| { t: 'retro_frames'; runId: string; from: number; upto: number; changes: [number, number][] }   // to watchers
| { t: 'retro_result'; runId: string; frame: number; result: RetroResult }                       // player + watchers
| { t: 'retro_cabinets'; cabinets: RetroCabinet[] }
| { t: 'retro_boards'; boards: RetroBoards }
type RetroView =
  | { kind: 'vacant'; cabinet: string; game: RetroGameId }                       // watchers of a free cabinet
  | { kind: 'starting'; cabinet: string; game: RetroGameId; player: string }      // emulator being created
  | { kind: 'playing'; cabinet: string; game: RetroGameId; runId: string; sync: number; player: string;
      role: 'player' | 'spectator';
      save: string | null;                       // base64 cartridge RAM at power-on (null = blank); with a snapshot: null
      snapshot: string | null;                   // base64 deflate-raw save state at `upto`; null = start from power-on
      upto: number; bits: number;                // the server's confirmed frame count and the buttons held after it
      serverNow: number };
```

- **Frame numbers**: `upto` is the number of frames stepped since power-on (`gb.frame`). A change `[f, bits]` means:
  these buttons are held from the step that takes `gb.frame` from `f` to `f + 1` onward, until the next change. The
  buttons before the first change of a session are 0.
- **Contiguous batches**: the player's batches chain: each `from` equals the previous batch's `upto`; the first batch
  after receiving a `playing` view starts at the view's `upto` and **always** begins with an explicit change at
  `from` carrying the buttons sampled then (even if they equal `bits`), so a new owner tab or a resync never inherits
  stale buttons. `runId` + `sync` identify the stream; batches with an older `sync` are dropped by the server, and the
  client drops everything it queued for an older `sync`.
- **The player's loop** (`client/src/retro/player.ts`): the emulator advances by real time at `GB_FPS` (driven by
  `requestAnimationFrame`, at most 4 frames per animation frame; when the page lags it slows down instead of skipping,
  since the game's time is its frame count). Before each step it samples the controls and normalizes them; if the bits
  differ from the previous step's, it records `[gb.frame, bits]`. Every 100 ms (and before `retro_leave`) it sends the
  batch since the last send.
- **Pause**: the overlay menu, a hidden tab or a blurred window stops stepping (and silences the game). Nothing is sent
  in between; the game simply continues from the same frame afterwards (both games also have their own pause on
  Start).
- **Server validation**, in this order:
  1. **Ignored** (no reply): the sender isn't the session's player on their owner socket, `runId` isn't the
     session's, or `sync` is older than the session's.
  2. **Resync** (the current player's current stream, but the batch can't be applied): `from` ≠ the session's `upto`;
     `upto − from` not 1–300; `changes` not sorted/unique, outside `[from, upto)`, more than 300, or bits not integers
     0–255; or the **frame budget** doesn't allow it (`credit` grows at `GB_FPS` of server time, capped at 300 frames =
     5 s; each batch spends `upto − from`). The server sets `sync += 1` and sends the player a fresh `playing` view with
     a snapshot; they lose at most the unconfirmed fraction of a second. Nothing is dropped silently while a stream
     continues.
- **Server stepping**: for an accepted batch the server steps its `Gb` from `from` to `upto`, applying each change at
  its frame and running the probe after every frame (section 4); then it relays the batch to the watchers, then sends
  any results (with the frame they fired on), then handles the cartridge copy (section 6).
- **Snapshots**: a `playing` view for a watcher, a reconnecting player, a new owner tab or a resync carries the
  server's current emulator state at its `upto` (`gb.state()`, deflate-raw, base64, ~215 KB) and `save: null`; the
  client creates its `Gb` and restores it. A brand-new session has `snapshot: null` and the player's `save`.
- **Watchers** (`client/src/retro/watcher.ts`) run their own `Gb`. Jitter buffer: while batches keep arriving (one in
  the last 250 ms) they play up to `newest upto − 15` (250 ms behind); when no batch has come for 250 ms they drain to
  the newest `upto`; never beyond the confirmed `upto`. After a snapshot they start at its frame and begin playing once
  15 frames are buffered or 250 ms passed. More than 2 s behind (a hidden tab, a slow machine) → fast-forward without
  drawing or sound, up to 600 frames per animation frame. A result toast shows when the watcher reaches the result's
  frame. Watchers never send frames.
- **Client loading**: while its `Gb` is being created or restored, the client queues `retro_frames` for the current
  `runId` and drops those for any other; the overlay shows "Inserting cartridge…" with Leave available. A creation or
  restore failure shows "The game didn't load" with Leave and **Retry** (`retro_resync`).
- **Dev hook**: `window.__retro = { player, watcher, hash(), frame }` in dev builds only, for the browser check.

## 6. Your cartridge (saves)

- `state.json → retro.saves: Record<RetroGameId, Record<userId, string>>`: base64 of the cartridge RAM (8 KB for both
  games → ~11 KB each; 60 cartridges ≈ 640 KB).
- The save is always the **server's** emulator cartridge RAM, never data from a client.
- **Dirty latch**: after every server step where `gb.takeExtWrite()` is true: `extDirty = true`,
  `lastWriteFrame = frame`. After each accepted batch and at the end of a session (after settling), a dirty cartridge
  is copied into `saves` and the world marked dirty for the 30 s state save; copying clears `extDirty`. (Two cabinets
  copying 8 KB per 100 ms batch is nothing; no throttle.)
- **Settle**: both games save a moment *after* the result (Tobu after its portal animation, Shock Lobster only when its
  Game Over panel is closed), Tobu confirms a clear only ~310 frames after the portal, and a write can span two frames
  (Tobu's Heaven table: 6112 and 6113). So when a session ends for any reason, the server settles if the probe is
  `pending`, a result is still unsaved (`lastResultFrame > lastWriteFrame`) or a write happened in the last two frames:
  it keeps stepping its emulator — the first frame with the game's `settle.press` when a result is unsaved, all others
  with no buttons, the probe running as usual — until the probe isn't pending, no result is unsaved **and** two
  consecutive frames passed without a write, or `settle.maxFrames` pass. Results the probe confirms meanwhile are
  committed like any other (only the game's own confirmation counts; settle frames never press anything that could
  score). Then the cartridge is copied one last time. Nobody sees these frames.
- A new player's first session starts with a blank cartridge (`save: null`).
- Both games have their own save reset (Shock Lobster: "Reset Save" in the loadout details; Tobu: Down+Select+B on the
  title screen). An admin can drop a save from `state.json` by hand.

## 7. Boards

```ts
interface RetroEntry { userId: string; name: string; score: number; time?: number; at: number }  // time: seconds
interface RetroBoard { all: Record<string, RetroEntry>; week: Record<string, RetroEntry> }   // userId → their best
interface RetroBoards { week: string; games: Record<RetroGameId, Record<string, RetroBoard>> }  // game → track → board
interface RetroResult { game: RetroGameId; track: string; score: number; time?: number;
  best: boolean; weekRank: number; allRank: number }   // best: became the all-time entry; ranks 1-based, after commit
```

- A committed result replaces the person's entry on its `(game, track)` board when it is better: higher score, then
  lower `time`, then (equal) the earlier one stays. Everyone's best is kept (≈30 people, a few KB), so ranks are exact.
- Shown like an arcade high-score table: the top 10, plus your own row under a divider when you're below 10th. Order:
  score descending, `time` ascending, earlier `at`; equal score and time share a rank.
- **Weeks**: the same Warsaw-Monday key as the Arcade (`weekKey` from `shared/arcade/weeks.ts`). A result belongs to
  the week it is committed in. The key is checked on every commit, on connect and in `dump()`; when it changes, every
  `week` board empties, `week` takes the new key and `retro_boards` is broadcast.
- `retro_boards` is sent on connect and broadcast after every commit and rollover.
- **Retro tab** in the Arcade boards popover (after the existing tabs): a game switch (Tobu Tobu Girl / Shock Lobster),
  a **This week** / **All time** switch, then one table per track: rank, name, score (+ time for timed tracks). Empty:
  "Play the Tobu Tobu Girl cabinet to get on the board." The popover is opened from the records board on the wall, as
  today; the game overlay doesn't open it.
- After a commit the overlay shows a toast: "Plains · 87 points · new personal best · #2 this week".

## 8. The overlay

`client/src/retro/RetroOverlay.tsx`, open while `store.retro` holds a view (you play or watch); built on the same
modal shell, focus handling and `COMPACT` rules as `ArcadeOverlay`. Each overlay mounts from its own state: the
existing flag that `game_session` sets and clears becomes `store.arcadeOpen` (it mounts `ArcadeOverlay`, and
`game_session null` clears only it), `RetroOverlay` mounts from `store.retro`, and `store.gameOpen` becomes a getter
(`arcadeOpen || !!retro`) used everywhere it is used today (inert office chrome, suppressed office keys).

- **Layout**: header — game title, "Playing" or "Watching Ivan", Menu, Leave. Centre — a dark bezel with the 160×144
  canvas at the largest whole-number scale that fits (at least 1×; `image-rendering: pixelated`). Under it — the game's
  controls line: Tobu — "←/→ move · A dash (with a direction) · B jetpack · Start pause"; Shock Lobster — "A/B use the
  selected skill pair · D-pad picks the pair · Start pause · Select shows details"; and the key legend.
- **Controls**: D-pad — arrows / WASD; A — Z, J, or Space (Space only when voice isn't in push-to-talk mode, as in
  Deck Park); B — X, K; Start — Enter; Select — Shift. Gamepad (standard mapping): d-pad or left stick, A = button 0,
  B = buttons 1/2, Select = 8, Start = 9. Touch devices (or `COMPACT`): an on-screen D-pad, A, B, Start, Select under
  the screen. Keys reach the game only while the overlay has focus and no text field is focused (the `ParkInput`
  gate); Esc opens the menu.
- **Menu**: Resume · Controls · Credits & licences · Leave. The game is paused while the menu is open.
- **States**: `starting` and loading — "Inserting cartridge…"; `vacant` (watchers) — "Ivan left · the cabinet is free"
  with **Play**; `playing` as a watcher — the same screen without controls, header "Watching Ivan · Tobu Tobu Girl";
  load failure — "The game didn't load" with **Retry** and Leave; disconnected — "Reconnecting…" (the game is
  paused); the player's session ended by `idle`/`cap` — a notice, then the overlay closes (watchers go to the vacant
  screen instead, section 3).
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
  `retro:<cabinet>` of a new kind `'retro'`, category `music` (the Music slider in the mixer), `clipGain` 0.6, placed at
  the cabinet's **current** tile from the live layout and reconciled on every soundscape update like the jukebox and
  instruments (an admin moving the cabinet moves the sound; the source goes when the object or the view goes). The
  sealed-room law applies: heard only inside the cabinet's room, quieter a few tiles away. People in the room who
  aren't watching don't run the emulator and hear nothing from it.
- Audio path: each buffer from `gb.audio()` (2048 stereo u8 frames at the AudioContext's rate) is converted to float
  (`(v - 128) / 128`) and scheduled as an `AudioBufferSourceNode` into the source's input 100 ms ahead; scheduled nodes
  are tracked and stopped on pause, restore, fast-forward and teardown; after an underrun or a pause the schedule
  restarts at now + 100 ms. The shared AudioContext (voice uses it too) is never suspended or closed for this.
- The server creates its emulators with `audio: false` at 48 000.

## 11. Disconnects, reloads and restarts

- **Reload / reconnect / new owner tab**: the session stays (until the person walks out the exit door after going
  offline, exactly as for Deck Park); the new owner socket gets a `playing` view with a snapshot and the game continues.
- **Shutdown** (`SIGINT`/`SIGTERM` in `server/src/index.ts`): `world.retro.shutdown()` runs before the final `save()`:
  it settles every session, copies their cartridges and destroys the emulators (all synchronous). Sessions are memory
  only: after the restart the cabinets are free and clients get `retro_session null` on reconnect.
- **Crash**: up to 30 s of copied progress can be lost, plus whatever the game hadn't written to its cartridge yet.
- **Load** (`Retro.load(unknown)`) never throws: it keeps only catalogue games and tracks, entries with a string
  `userId`/`name`, finite non-negative integer `score`/`at` (and `time` where the track is timed), base64 saves whose
  length is checked before decoding and whose decoded size equals the ROM's cartridge RAM size; everything else is
  skipped with one log line. `dump()` writes only `saves` and `boards`.

## 12. Tests

- **Recorded runs** (`server/src/fixtures/retro/*.json`), produced by the probe scripts with plain button inputs (no
  memory pokes), converted to bits, from `retro-probes/`:
  `{ game, save: string | null, changes: [frame, bits][], upto, expect: { results: { frame, track, score, time? }[],
  hash, ext: string, settledExt?: string } }` — `ext` is the cartridge after replaying to `upto`, `settledExt` after a
  settle at `upto`.
  - Shock Lobster `lobster/verify-inputlog.json`: 3721 frames from a blank cartridge, five runs at medium speed scoring
    132, 141, 175, 231, 490;
  - Tobu `tobu/runs/` (per-frame button logs): `l1.json` from a blank cartridge (Plains 115, 21 s, frame 2681) →
    `after-l1.bin` → `l2.json` (Clouds 71, 38 s, frame 3745) → `after-l2.bin` → `l3c.json` (Space 61, 51 s, frame
    4466) → `after-l3.bin` → `h.json` (Heaven 5 waves, 57 s, frame 6063; the cartridge write spans frames 6112–6113);
  - Tobu pause edge cases from the second probe (`edge-pause-death.mjs`, `edge-pause-portal.mjs` and the Heaven
    pause-on-death run): Start on the death or portal frame, then Resume or Quit → the expected single result or none.
- `server/src/retro.test.ts` (Node, `node --import tsx --test`, silent):
  - each fixture: results (frames, tracks, scores, times), final hash and `ext` match; each probe fires exactly once
    per run;
  - Heaven regression: a session ending at frame 6112 still saves the Heaven score after settle (two-frame write);
  - portal regression: a Plains session ending at frame 2400 (portal touched, clear not yet confirmed) commits the
    clear (115) during settle and saves the unlock; with Start pressed on the portal frame it commits nothing;
  - 44.1 vs 48 kHz → same hash; snapshot mid-run + restore at the other rate → same continuation; 200 snapshot/restore
    cycles on one `Gb` without running out of memory; audio buffers copied on flag 2 are complete;
  - `Retro` with fake transport: join (free/busy/starting/crowded/out of order), reservation and cancelled async
    creation, watchers kept across a vacancy and attached to the next session, one activity at a time, owner handover
    of the player (`sync + 1`, explicit first change) and of a watcher (sync unchanged; vacant and starting views),
    `retro_resync`, batch validation (non-player, other socket, wrong runId, old sync → ignored and no snapshot sent;
    gap, overlap, unsorted, too many, over budget → resync), watcher relay order (frames before results), session
    endings (players get null + reason, watchers get vacant), results committed once
    and boards updated (best-only, tiebreaks), week rollover broadcast, dirty latch + settle + copy on leave, idle and
    cap endings, `shutdown()` settles and copies, `load()` skipping bad records without throwing, `dump()`/`load()`
    round trip.
- **Browser check** (headless Playwright, `--mute-audio`, Chromium and WebKit, never the in-app browser pane): two
  people; A plays the Lobster fixture through the real client (feed the recorded changes via `__retro`), B watches;
  A's and B's emulator hashes match the server's at common frames; the result toast and the Retro board show the
  fixture's scores; B reloads mid-run and catches up from the snapshot; A's tab is replaced by a second tab mid-run
  (handover) and the run continues; the game's audio reaches the soundscape source (analyser RMS > 0, measured
  upstream of the muted output).
- `npm test`, `npm run typecheck`, `npm run build -w client`.

## 13. Implementation steps (one executor at a time; each leaves the app working)

1. **Engine and server**: vendored files and ROMs, `shared/retro/{gb,buttons,games,probes}.ts`, map objects and art,
  `server/src/retro.ts` + World wiring + protocol + persistence + shutdown, fixtures and `retro.test.ts`.
2. **Client**: `client/src/retro/*` (overlay, player, watcher, input, audio), store/net handling, cabinet tooltips and
  lit frames, Retro boards tab, credits screen, the browser check.
