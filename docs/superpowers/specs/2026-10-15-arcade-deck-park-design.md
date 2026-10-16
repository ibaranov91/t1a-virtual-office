# Arcade: Deck Park, a co-op platformer — design

Owner: Andrii Butko · 2026-10-15 · status: v3, after two Codex spec reviews · builds on `2026-10-15-music-room-design.md`
(PR #28: the Music room shrinks here) and the hall-voice rules (`rules.voice: 'open'`). Only what changes is written here.

**Shipped** in #38. Deck Park is now the CO-OP mode behind the Arcade hub of the party pack (#91).

## Goal

The hackathon task "Gaming room: people can login together, choose a game, game opens in overlay", the way Andrii
wants it: like the arcade machines in GTA San Andreas, but a game you play **together with arrow keys**, like Mario or
PICO PARK.

- A new room, **Arcade**, with three arcade cabinets. Click a cabinet: you walk to it and its screen opens over the
  office (overlay). Inside is **Deck Park**, our own co-op platformer for **1–4 players**, where everyone plays as
  their own Deck avatar.
- The game starts in a **lobby that is itself a tiny level**: players run around, pick the level by bumping ◀ ▶ blocks
  from below, and start by all standing on the big **START** button.
- Anyone who comes later, or when the cabinet is full, watches from the **balcony**: a strip above the game screen
  where the spectators' avatars stand, visible to the players, and cheer.
- **No input lag for your own character**: a deterministic simulation shared by server and clients, inputs sequenced
  by the server, prediction + rollback on the client (the model Rune, GGPO and Photon Quantum use).
- Team **records** per level and team size, on a board in the Arcade and in the lobby.

Built in one pass: everything below ships together.

## Out of scope

- Other games. Cabinets carry `game: 'park'` so another game could be added as data, but only Deck Park exists.
- Peer-to-peer game traffic. Inputs go over the existing WebSocket through the server (~36 ms RTT from Andrii's
  machine), which also handles NAT and spectators.
- Voice rules. The Arcade is a hall room (`rules.voice: 'open'`); how hall voice works is owned by the hall-voice work in
  progress elsewhere, and this change adds nothing to it.
- Game music. Only sound effects (Effects bus).

## 1. The map

`scripts/gen-map.mjs` (then `node --import tsx scripts/gen-map.mjs`), starting from the PR #28 version:

- **Music** shrinks to the top half: `rect: { x: 54, y: 3, w: 10, h: 8 }`. Its jukebox (54,7), dance-floor rug (55,6
  8×4), windows, plants (54,3), (63,3) and standing spots stay as in PR #28.
- **Arcade**, inserted right after Music in the rooms list: `{ id: 'arcade', name: 'Arcade', type: 'arcade', rect: { x:
  54, y: 13, w: 10, h: 10 }, capacity: 12, floor: 'wood_dark', rug: 'teal', rules: { voice: 'open', knock: 'allow',
  label: 'arcade · open voice · walk in to talk' }, meeting: { provider: 'meet', url: 'https://meet.google.com/new' } }`.
- **Divider**: the horizontal divider (cap row 11, short face row 12) now also runs over x 54–63, with a door at x 58–59
  (thresholds get `door_floor`). Music is reached through the Arcade. The Arcade keeps the old Music doors: from Desks
  (x 53, y 17–18) and to the Garden (x 58–59, row 23).
- Old bottom-half furniture: the two round tables with their stools at row 13 are **replaced in place in the object
  list** (so later object ids stay put) by the three cabinets, the records board, the rug-free decor below and padding
  as needed; sofas (55,21), (60,21) and lamps (54,22), (63,22) stay.
- **Cabinets**: three `arcade` objects, 1×2, front-facing, on rows 13–14 at **x 54, 56 and 61**:
  `obj('arcade', x, 13, 1, 2, { use: { kind: 'arcade', label: 'Deck Park', game: 'park' } })`.
  Columns 57–60 of rows 13–14 stay free (the Music door). Nothing else stands in rows 13–15 of the Arcade.
- **Records board**: wall decor on the divider face, `obj('records', 62, 12, 2, 1, { wall: true, use: { kind: 'records',
  label: 'records' } })`.
- A teal rug in the middle (56,16 6×3); a plant at (63,20).
- Standing spots: `stand('arcade', [[55, 16, 'up'], [61, 16, 'up'], [58, 19, 'up']])`.
- Generator asserts: every cabinet has at least one reachable neighbouring tile, and the Music door is reachable from
  the spawn.
- `shared/map.ts`: `KEEP_TYPES` gets `arcade` and `records`. `layoutProblem` treats `arcade` like `take`/`toggle`
  (at least one neighbouring tile reachable, else "nobody could reach the arcade").

### Saved layouts (edit mode)

A layout saved by an admin replaces all furniture, so it would keep the old Music tables and miss the cabinets. Pure
helper `migrateEastWing(saved: Layout, base: Layout): Layout` in `shared/map.ts`, called by `World.load` before
`withNewFixtures`:

- If `saved` already has an `arcade` object → return it unchanged (so it runs once).
- Else let `area = { x: 54, y: 3, w: 10, h: 20 }` and `baseIn` = base objects/rugs whose footprint touches `area`.
  Drop from `saved` every object/rug whose footprint touches `area` **or** whose id equals the id of something in
  `baseIn`; then append `baseIn` (cloned). Ids stay unique because every id of `baseIn` was removed first.
- Then the existing `withNewFixtures` + `layoutProblem` path runs as today (and drops the saved layout entirely if it
  still doesn't fit).

## 2. Sessions on the server (`server/src/arcade.ts`)

One **session** per cabinet, created by the first join, in memory only.

```ts
interface Session {
  cabinet: string;                 // object id
  epoch: number;                   // from one server-wide counter: unique across cabinets and sessions
  phase: 'lobby' | 'level' | 'clear';
  level: number;                   // 0 = the lobby, 1..8 = levels
  startAt: number;                 // server ms of frame 0 of this epoch
  players: { userId: string; slot: 0 | 1 | 2 | 3 }[];
  spectators: string[];            // user ids, join order
  events: GameEvent[];             // events of this epoch at frames >= sim.frame (older ones are in `sim`)
  teamSize: number;                // players at frame 0 of a level epoch (records category)
  rosterChanged: boolean;          // someone left during this level epoch (no record)
  clear?: { frames: number; coins: number; record: boolean };
  sim: ParkState;                  // the server's simulation; sim.frame = frames stepped so far
}
type GameEvent = [frame: number, slot: number, kind: 0 | 1 | 2 | 3, bits: number];
// 0 input, 1 join, 2 leave, 3 reset (the slot's input events at frames >= frame are dropped, then bits = 0)
```

### Frames and the clock
- `state.frame` is the number of frames stepped. "The state at frame f" is the state *before* stepping frame f.
- `frameAt(now) = Math.floor((now - startAt) * 60 / 1000)` (negative before `startAt`).
- The server's tick (50 ms interval, `unref`'d; tests call `arcade.tick(now)`) steps `sim` while
  `sim.frame <= frameAt(now) - PARK_SERVER_LAG` (6 frames, 100 ms). Nothing at a frame below `sim.frame` can change any
  more: every event the server accepts gets a frame ≥ `sim.frame`.
- Every time `sim.frame` reaches a multiple of 60 (each one crossed, also within one catch-up), members get
  `game_check { epoch, frame: sim.frame, hash: hashState(sim), serverNow }`.

### Who sends and receives
- A user takes part through their **voice-owning socket** only (the existing `owners` map: newest socket, or the one that
  sent `voice_claim`). Game messages go to that socket; `game_*` messages from other sockets are ignored. When ownership
  moves, the new owner socket gets `game_session` (below) and the old one `game_session` with `session: null` (its
  overlay closes and shows "Playing in another tab").
- Arcade state for the office (everyone): `arcade { cabinets: { cabinet, phase, level, players: userId[], spectators:
  number }[] }` on connect and on every change. `PublicUser.game: { cabinet, role } | null` with `game_status`.

### Joining
Clicking a cabinet sends the existing `use { objectId }`. For `arcade` objects `World.use` picks the stand spot
differently: the free, reachable tile with the shortest path among (a) the cabinet's neighbouring tiles, then (b) any
walkable tile of the cabinet's room ordered by Manhattan distance to the tile in front of the cabinet (ties: smaller y,
then smaller x). Arrival check (same as other errands, plus): user online, not going out, not in a meeting instance,
the object still exists and is an `arcade`. Then `arcade.join(u, cabinet)`:
- Already a member of this session → resend `game_session`. Member of another → leave it first.
- `phase === 'lobby'` and fewer than 4 players → **player** in the lowest free slot; append `[sim.frame, slot, 1, 0]`.
- Otherwise → **spectator**. A spectator becomes a player with `game_play { epoch }` while the phase is `lobby` and a
  slot is free.
- Bots never join.

### Leaving
`arcade.leave(u)` runs on: `game_leave`; **any accepted** `World.walk` of that user after they joined (one call in
`walk` after the path is found, right before the move is committed; a walk that fails changes nothing), so errands,
follow, `leave_room`, AFK and the door walk all count; entering a meeting instance; the layout
moving the user aside; the final step of the door flow. A player's leave appends `[sim.frame, slot, 2, 0]`; a spectator
is just removed. When the last player leaves, the session is deleted: spectators get `game_session { session: null,
reason: 'empty' }`.

When a player's **last socket closes** (the door grace starts) or their **owner socket changes**, the server appends a
reset `[sim.frame, slot, 3, 0]` (their queued inputs are dropped, their character stops), and `lastFrame[slot] =
sim.frame`; the new owner socket (or the reconnected one, within the grace) gets `game_session` and sends its own
buttons from there.

### Inputs
`game_input { epoch, seq, frame, bits }` from a player's owner socket in the current epoch (else ignored):
- `frame` and `seq` must be safe integers (`Number.isSafeInteger`), else the message is ignored; `bits &= 7`. `seq`
  is the page's own counter; the server only echoes it.
- If `frame > frameAt(now) + 60` → `frame = Math.max(frameAt(now), 0) + PARK_INPUT_DELAY`.
- Then `frame = Math.max(frame, sim.frame, lastFrame[slot])` (late input moves forward as in Rune, never rejected;
  frames per slot never go backwards). Before `startAt` this gives frame 0 at the earliest.
- Append `[frame, slot, 0, bits]`; send `game_event { epoch, ev }` to every member, with `seq` added only in the copy
  for the sender. **Every** input is echoed; none is dropped.

### Membership events on the wire
Joins and leaves go out the same way as inputs: `game_event { epoch, ev }` to every member (also to the one joining,
after their `game_session`), plus `game_members { epoch, players, spectators }`. All members see events in one order
(the WebSocket keeps order).

**Slot reuse.** A leave (or reset) of slot s at frame f **removes every input event of s at frames ≥ f that came
before it in the log** (server, and each client when it receives it). The server stops accepting inputs from the user who left. A later join of s is
appended after the leave, so only the new occupant's inputs follow it.

### Simulation and transitions
Each tick the server steps `sim` with the logged events (`parkStep`, section 4). Transitions are checked after each
single step (not once per batch), so the frame they happen at is exact.

Every new epoch goes through one initializer, `startEpoch(session, level, startAt, selected)`: `epoch = ++epochCounter`,
`phase = level ? 'level' : 'lobby'`, `sim = parkInit(LEVELS[level], selected)`, `events` = a join `[0, slot, 1, 0]` per
current player in slot order, `lastFrame` all 0, `clear` cleared, `teamSize = players.length`, `rosterChanged = false`,
then `game_session` to every member. Players start every epoch with no buttons held; their pages resend what is held.

| From | When | To |
|---|---|---|
| (none) | first join | `startEpoch(0, now, 1)` (the joiner is already a player) |
| lobby | `sim.startReady` | `startEpoch(sim.selected, now + 3000)` (3-2-1) |
| level | a player leaves | same epoch, `rosterChanged = true` |
| level | `sim.cleared` | **same epoch**, `phase = 'clear'`: the sim keeps stepping frames but nothing changes (section 4, terminal state); `clear = { frames: sim.clearedAt, coins: sim.coins, record }`; `game_clear` to members |
| clear | 4 s later | `startEpoch(0, now, min(level + 1, 8))` |
| level | `game_menu { epoch, op: 'lobby' }` from a player of that epoch | `startEpoch(0, now, level)` |
| level | `game_menu { epoch, op: 'restart' }` | `startEpoch(level, now + 3000)` |
| any | last player leaves | session deleted |

A new epoch sends `game_session` to every member. Stale `epoch` on any command → ignored.

### `game_session`
`{ cabinet, epoch, phase, level, startAt, serverNow, players, spectators, teamSize, clear?, snapshot: ParkState, events }`
where `snapshot` is `sim` and `events` are the logged events (all at frames ≥ `snapshot.frame`). Sent on join, new
epoch, owner-socket change, reconnect, and in reply to `game_sync { epoch }`.

## 3. Netcode on the client

The logic lives in **`shared/park/runner.ts`** (no DOM, so tests can drive it); `client/src/park/` adds the animation
loop, input devices and drawing.

### Clock
The runner keeps its own server clock: `serverTime() = performance.now() + offset`. Every `game_session` and
`game_check` carries `serverNow`; a sample is `serverNow - performance.now()` at receipt. `offset` = the largest sample
of the last 10 s (latency only ever makes a sample smaller), applied gradually (at most 2 ms per animation frame) unless
it is off by more than 250 ms (then at once). `performance.now()` is monotonic, so a wall-clock jump can't freeze it.

### Stepping
- Target frame = `frameAt(serverTime())` for players, minus `PARK_SPECTATOR_DELAY` (9) for spectators.
- Each animation frame the runner steps from `state.frame` towards the target for at most 8 ms (at least 20 steps).
  Below frame 0 it doesn't step (countdown). Progress carries over between animation frames.
- More than 300 frames behind (e.g. a tab that was hidden) → it sends `game_sync` once and keeps stepping; the reply's
  snapshot replaces the state (it is at most ~6 frames old).
- **Spectator presentation**: a spectator draws only states at or before its target. With a snapshot newer than its
  target (on joining) it shows "Joining…" until the target reaches it. A `game_session` for a new epoch is applied
  `PARK_SPECTATOR_DELAY` frames (150 ms) after it arrives, so the end of the old one is shown first.

### Local input
- Sampled once per animation frame. On a change the runner adds a **provisional** event at `frame = max(state.frame, 0)
  + PARK_INPUT_DELAY` (2) with a new `seq` (per page, increasing) and sends `game_input`.
- **Echo**: when `game_event` with that `seq` arrives, remove the provisional event and insert the server's; roll back
  to `min(provisional frame, echoed frame)` if that is below `state.frame`.
- **Input gate**: the page, the window and the overlay must have focus, the menu must be closed and no text field
  focused; otherwise the sampled bits are 0 (sent once as a change). When the gate reopens, keyboard keys that were
  already down count only after they are released and pressed again (the held set is cleared when the gate closes);
  gamepad and touch count at once.
- On every `game_session` (new epoch, sync, reconnect) the runner drops all provisional events; if its current bits
  differ from its slot's bits in the snapshot/log, it sends a new input.

### Prediction and rollback
- `ParkState` holds each player's current bits (section 4), so a snapshot is self-contained. Events change bits at the
  start of their frame; between events the bits stay ("no news" means "same buttons").
- The state at each of the last 180 frames is kept (`structuredClone`). An event (remote input, echo, join, leave, reset)
  at frame f < `state.frame` → restore the state at frame f and re-step to where it was. Older than the ring → restore
  the last `game_session` snapshot and re-step with the log since.
- **Effects** (sounds, particles) come from `state.fx` of each step; a set of `(frame, kind, slot)` already played keeps
  re-stepped frames from playing them twice.

### Desync check
A `game_check { frame F, hash }` is compared with `hashState` of the local state at frame F once (a) the runner has
reached F and (b) none of its provisional events is at a frame < F (all of them have been echoed — the server would
have moved any later one to ≥ F). Until then it is queued; hashes at multiples of 60 are kept for the last 10 s (updated
on re-step). A mismatch, or a check older than what is kept, sends `game_sync { epoch }` once. Dev handle `window.__park`
= `{ frame, desyncs, rollbacks, maxRollback, syncs }`.

## 4. The game (`shared/park/*`)

Pure, deterministic TypeScript used by the server, every client and the tests.

### API
```ts
parkInit(level: LevelDef, selected?: number): ParkState      // frame 0, no players
parkStep(state: ParkState, level: LevelDef, events: GameEvent[]): void // exactly one frame; events = this frame's, in log order
hashState(state: ParkState): number                          // FNV-1a, 32-bit
LEVELS: LevelDef[]                                           // index 0 = lobby
```
Input bits: `1` left, `2` right, `4` jump.

### Determinism rules
- All positions and velocities are **integers in sub-pixels** (1 px = 16 sub); only `+ - *`, comparisons, `Math.trunc`
  for every division (`Math.trunc(a / b)`), `Math.min/max/abs`. No `Math.random`, `Date`, trig, `pow`, `sqrt`, no float
  ever stored. Percentages are integer ratios (stomp bounce = `Math.trunc(JUMP_V * 3 / 5)`).
- `ParkState` is a plain JSON-serializable object holding **everything** that affects the future: frame; per slot
  `{ present, x, y, vx, vy, bits, prevBits, grounded, coyote, buffer, jumpHeld, facing, dead, respawnIn, entered }`;
  key `{ x, y, homeX, homeY, carrier }`; `doorOpen`; buttons `{ pressed, latched }[]`; gates `{ open }[]`; boxes
  `{ x, y, vy }[]`; lifts `{ offset }[]`; moving platforms `{ phase, offset }[]`; `sBlocks/tBlocks` solidity `boolean[]`; coins taken `boolean[]`; enemies
  `{ x, y, dir, alive }[]`; `checkpoint`; `camX`; `coins`; `cleared`, `clearedAt`; lobby `{ selected, startHold,
  startReady }`; `fx`. Arrays in reading order of the level (top-to-bottom, left-to-right), players by slot.
- `hashState` walks a fixed list of fields in a fixed order (not `JSON.stringify`); `fx` is not hashed.

### One frame, in order
1. **Events**: in log order: join (player appears at the spawn, slot offset 12 px, bits 0), leave (player removed; if
   they carried the key it goes home), input (set `bits`).
2. **Camera**: over players present, alive and not entered (none → `camX` unchanged):
   `target = clamp(Math.trunc((minLeft + maxRight) / 2) - 160px, 0, levelWidth - 320px)`, then clamped into
   `[maxRight - 320px, minLeft]` so nobody is outside (if that interval is empty, which the rules below never allow,
   `camX = minLeft`). The screen edges `camX` and `camX + 320px` are walls for players in step 4. Invariant: every
   present, alive, not-entered player is inside `[camX, camX + 320px]`.
3. **Supports**, from the positions at the start of the frame: body p (player or box) stands on q (player, box, lift
   or platform) when p's bottom equals q's top and they overlap horizontally by ≥ 1 sub; for several candidates the one
   with the most overlap, then players before boxes before lifts before platforms, then the lowest slot/index. The
   **riders** of q are everything standing on it, directly or through a stack.
4. **Moves**, every body moving X then Y in 1-px steps; a blocked step stops that axis. Obstacles: solid tiles,
   one-way platforms from above, closed gates, solid `s`/`t` blocks, boxes, lifts/platforms, other players, and for
   players the screen edges; a body never collides with its own riders. **A body's own displacement this frame is
   added to all its riders' displacement** (carrying, both axes), and an **upward** move of a body with riders is
   limited so that every rider fits above (a ceiling over the top rider stops the whole stack). Order:
   1. lifts and moving platforms (rules below; a mover whose move doesn't fit doesn't move, nor advance its phase),
   2. boxes in reading order (push and gravity, rules below),
   3. players **bottom-up**: by y descending, ties by slot; velocity from input (accel / friction), jump (coyote,
      buffer, variable height), gravity; displacement = carried + own.
5. **Interactions** in slot order: coins, key pickup (the first slot touching it),
   checkpoint, door (carrier touching it opens it; a present player touching an open door enters), spikes/enemies
   (death), stomps, buttons and gates (from the bodies standing on them now; used from the next frame), `s`/`t` blocks.
6. **Clear**: when every present player has entered and `cleared` is false → `cleared = true`, `clearedAt = frame`.
7. `frame += 1`.

Once `cleared` is true (and in the lobby once `startReady` is true), a step only applies events and does `frame += 1`:
nothing else changes (terminal state).

### Feel (60 fps, tiles 16 px)
Player hitbox 10×20 px (sprite 16×24, feet aligned). Starting values, tuned in review before levels are recorded:

| Constant | sub/frame |
|---|---|
| RUN_MAX | 32 (2.0 px) |
| ACCEL ground / air | 4 / 3 |
| FRICTION (no input, ground) | 6 |
| JUMP_V | 92 (5.75 px) |
| GRAVITY while jump held and rising / otherwise | 6 / 10 |
| MAX_FALL | 88 (5.5 px) |

A full jump is ~44 px (2.75 tiles), a tap ~26 px; a 2-player stack reaches a 3-tile ledge, one player can't. Coyote
time 6 frames, jump buffer 6 frames, corner correction up to 4 px when the head clips a corner while rising. A support
(head, box, lift) counts as ground for all of these. Players block each other sideways (no shoving).

### Level elements
Levels are ASCII, 12 rows (192 px, no vertical scrolling), 20–160 columns, plus meta.

| Char | Element |
|---|---|
| `.` | empty |
| `#` | ground (drawn as grass-top or dirt by neighbours) |
| `B` | brick (solid) |
| `=` | one-way platform (solid only from above, for a body whose bottom was at or above it at the start of the frame) |
| `^` | spikes (bottom half of the tile kills) |
| `S` | spawn |
| `K` | key |
| `D` | exit door, 2 tiles tall (`D` is the bottom tile) |
| `C` | coin |
| `F` | checkpoint flag |
| `E` | walker enemy |
| `s` | block solid only for **1** player |
| `t` | block solid only for **2+** players |
| `X` | heavy box, 1 tile |
| `1`–`4` | button of group n |
| `a`–`d` | gate of group a…d (a ↔ 1 …) |
| `L` | lift, 3 tiles wide from here to the right |
| `M` | moving platform, 3 tiles wide |

Meta: `{ id, name, rows, boxes?: Need[], buttons?: Record<'1'|'2'|'3'|'4', Need & { latch?: boolean; latchSolo?:
boolean }>, lifts?: (Need & { dy: number; speed: number })[], movers?: { dx: number; dy: number; period: number }[] }`,
lists in reading order; `Need = { need: number | 'all' }`; `period` even.

**Team size.** `players` = present players right now. Every requirement is `min(need, players)`, `'all'` = `players`. So
every level can be played by 1–4; alone it's easier. When someone leaves, requirements drop at once.

- **Key**: the first slot to touch it carries it (drawn floating behind them). The carrier touching the door opens it
  for good (the key is used up). Carrier death or leave → the key returns to `home`.
- **Door**: once open, a present, alive player touching it enters (vanishes, input ignored). Cleared when every present
  player has entered.
- **Buttons**: weight = players standing on it directly or through a stack on it, plus boxes on it (1 each). Pressed
  while weight ≥ requirement; `latch` stays pressed once pressed; `latchSolo` latches while `players === 1`.
- **Gates**: group a opens while **any** button of group 1 is pressed (OR). A gate closes only when no body overlaps it
  (it stays open until clear).
- **Heavy box**: pushers in a direction = players whose input points that way and who touch the box's side, directly
  or through a row of touching players all pressing the same way. It moves 1 px that frame iff pushers that way ≥
  requirement and nobody pushes the other way, and the move isn't blocked (boxes don't push boxes). Gravity like a
  player, max fall 4 px/frame; lands on anything solid, players included. A box in a pit is a bridge.
- **Lift**: riders = players supported by it directly or through a stack. Moves `dy` tiles at `speed` px/frame towards
  its end while riders ≥ requirement, else back towards its start at the same speed. Doesn't move a frame in which the
  move or a rider's ride would hit something solid.
- **Moving platform**: `phase` advances by 1 each frame it moves; its offset is an integer triangle wave of the phase:
  `p = phase % period`, `h = period / 2`, `t = p < h ? p : period - p`, `offset = Math.trunc(total * t / h)` per axis
  (total in sub). A frame whose move doesn't fit (step 4) leaves `phase` and `offset` unchanged.
- **`s`/`t` blocks**: solidity follows `players`, but a block only switches while no body overlaps it.
- **Coins**: collected on touch; `coins` in the HUD and the records.
- **Walker enemy**: 8 sub/frame, turns at walls and ledges. A player falling onto its top half kills it and bounces
  (`vy = -Math.trunc(JUMP_V * 3 / 5)`); any other touch kills the player.
- **Death** (spikes, enemy, falling below the level): the player is gone for 45 frames, then respawns (slot order when
  several do, each avoiding the earlier ones):
  1. Nobody else present is alive and not entered → at the checkpoint (last touched `F`, else `S`); the camera follows.
  2. Else, candidates inside the camera window: the checkpoint first if it is inside, then x positions from the living,
     not-entered teammate closest to the checkpoint, at the top of the screen (y = 0), stepping 12 px right then left,
     at most 26 candidates, all with the full 10×20 hitbox inside the window. The first whose hitbox overlaps no solid,
     body, spike or enemy wins.
  3. None → the whole team still present respawns at the checkpoint (a group reset; key back home if carried).

### The lobby (level 0)
One screen (20×12): a floor, the **START** pad (4 tiles) in the middle, and two blocks ◀ ▶ hanging above its left and
right. Bumping a block from below changes `selected` (1…8, wrapping). `startHold` counts frames in which every present
player stands on START (any frame without → 0); at 60, `startReady = true`. The client draws the selected level's
number, name and record above START.

### The levels
Eight levels, easy to hard. Nothing needs more than a 2-player stack; solo gets `s` steps or `latchSolo` where a puzzle
would need two people.

1. **First Steps** — run, jump small gaps, coins, a key on a ledge three tiles up (stack, or `s` steps alone).
2. **Heavy Lifting** — a heavy box (`need: 'all'`) blocks the corridor; push it into a pit to cross.
3. **Going Up** — a lift (`need: 'all'`) to the upper floor with the key; walkers on the ground floor.
4. **Hold the Door** — a button outside opens a gate while pressed; whoever is through presses a second button of the
   same group inside so the holder can follow (`latchSolo` on the outside one).
5. **Human Tower** — a high wall with ledges reached by stacking (`t`/`s` blocks shape the route by team size).
6. **Spike Garden** — moving platforms over spikes, checkpoints, coins.
7. **Key Relay** — the key sits behind a gate whose button is far back; the team splits up and meets again.
8. **Grand Finale** — a long mix of everything, two checkpoints.

### Recorded solutions
`shared/park/solutions.ts`: for every level and every team size **1, 2, 3 and 4**, a script
`{ frames: number; inputs: [frame: number, slot: number, bits: number][] }` (absolute frames, sorted). The test plays it
from `parkInit` with joins at frame 0 and asserts `cleared` by `frames` (≤ 7200, 2 minutes). `scripts/park-replay.mjs
<level> <team> [--every 30]` runs a script and prints positions, key, door and deaths over time, to write and debug the
scripts. Physics constants are fixed **before** recording; changing them later means re-recording.

## 5. The overlay (client)

`client/src/park/ArcadeOverlay.tsx` (React) + `loop.ts` (rAF around the runner) + `render.ts` (canvas) + `input.ts`.

- Opens when this page receives a `game_session` for the user, closes on `session: null` ("Everyone left" /
  "Playing in another tab") or leave.
- **Layout**: a full-window layer above the office: a header bar (title "DECK PARK", 🎙 mute and 🎧 deafen toggles that
  drive the same store state as the self panel, ⏸ menu, ✕ leave), the canvas area, and (touch or `COMPACT` only) a
  touch-controls bar. The self panel is covered while the overlay is open; its mute/deafen live in the header.
- **Canvas**: 320×216 art pixels: the 24 px balcony on top, the 320×192 game view below. Scale = the largest integer
  that fits the canvas area (if < 1, fit with smoothing off). `image-rendering: pixelated`, in a pixel cabinet frame.
- **Drawing**: tiles from new `park_*` atlas frames; players from `assets.sheet(look)` (left/right walk frames, frame 1
  while airborne), name tag over each; the key floating behind its carrier; the door showing how many are still outside;
  HUD: level name, timer `m:ss.t`, coins. Lobby: the selected level's number, name and record above START. Countdown
  3-2-1 before `startAt`; "CLEAR! 1:23.4 · 12 coins · New record!" when the local state is cleared and `game_clear`
  has come.
- **Balcony**: a railing with the spectators' avatars (front frames), up to 12, then "+N". Spectators press 1–3 or the
  👏 🔥 😂 buttons → `game_cheer` (server: at most 2 per second per user) → a bubble over that spectator for 1.5 s on
  every member's screen.
- **Input ownership**: game keys are read from `window` key events unless a text field/contenteditable has focus. ←/→ or
  A/D; jump ↑, W, Z or Space. While the voice mode is push-to-talk, Space is never a game key and its events are left
  alone for `Voice`. While the overlay is open, `Engine.onKey` and App shortcuts (zoom, `M`, …) do nothing (a
  `store.gameOpen` flag). Gamepad (standard mapping): d-pad / left stick, A or B to jump. Touch: ◀ ▶ ⤒ buttons.
- **Menu** (Esc or ⏸, opening it sends neutral input): players during a level: "Back to lobby", "Restart level",
  "Leave"; in the lobby and for spectators: "Leave", plus "Play" for a spectator in the lobby with a free slot.
- **Sounds** (synthesized in `sounds.ts`, Effects bus): jump, coin, key, door opens, button, stomp, death, respawn,
  clear fanfare, cheer pop.

## 6. Records

`state.json` gets `arcade: { records: Record<level, Partial<Record<1|2|3|4, ParkRecord>>> }`,
`ParkRecord = { frames, coins, names: string[], at: number }`. On clear, if `rosterChanged` is false: the run is a record
for `teamSize` when `frames` is lower than the stored one (ties: more coins). `arcade_records { records }` goes to
everyone on connect and on every change. The records board (click: popover, no walking) shows levels × team sizes:
time, coins, names; the lobby shows the current team size's record of the selected level.

## 7. In the office

- `PublicUser.game: { cabinet: string; role: 'player' | 'spectator' } | null` (initialized to `null`, not persisted),
  broadcast with `game_status { userId, game }`.
- Over heads: new bubble frames `bubble_game` (a joystick, players) and `bubble_watch` (eyes, spectators), below the
  meeting/call bubbles in priority. Hover tooltip from the `arcade` summary: "Playing Deck Park · level 3 with Ivan" /
  "In the Deck Park lobby" / "Watching Deck Park". The people list shows 🕹 / 👀 after the name.
- Cabinets: the screen of a cabinet whose session exists glows (an `arcade_on` frame, 2-frame flicker).
- Clicking a cabinet calls `use` directly (no action wheel); clicking the records board opens its popover.

## 8. Protocol (`shared/protocol.ts`)

```ts
export const PARK_FPS = 60, PARK_INPUT_DELAY = 2, PARK_SERVER_LAG = 6, PARK_SPECTATOR_DELAY = 9, PARK_MAX_PLAYERS = 4;
export type GameRole = 'player' | 'spectator';
export type GameEvent = [frame: number, slot: number, kind: 0 | 1 | 2 | 3, bits: number]; // input, join, leave, reset
PublicUser += { game: { cabinet: string; role: GameRole } | null }

ClientMsg +=
  | { t: 'game_play'; epoch: number }
  | { t: 'game_leave' }
  | { t: 'game_input'; epoch: number; seq: number; frame: number; bits: number }
  | { t: 'game_menu'; epoch: number; op: 'lobby' | 'restart' }
  | { t: 'game_cheer'; kind: 0 | 1 | 2 }
  | { t: 'game_sync'; epoch: number }

ServerMsg +=
  | { t: 'game_status'; userId: string; game: PublicUser['game'] }
  | { t: 'game_session'; session: PublicSession | null; reason?: 'empty' | 'elsewhere' }
  | { t: 'game_event'; epoch: number; ev: GameEvent; seq?: number }
  | { t: 'game_members'; epoch: number; players: { userId: string; slot: number }[]; spectators: string[] }
  | { t: 'game_check'; epoch: number; frame: number; hash: number; serverNow: number }
  | { t: 'game_clear'; epoch: number; frames: number; coins: number; record: boolean }
  | { t: 'game_cheer'; userId: string; kind: number }
  | { t: 'arcade'; cabinets: CabinetSummary[] }
  | { t: 'arcade_records'; records: ParkRecords }
```

`ObjectUse += { kind: 'arcade'; label: string; game: 'park' } | { kind: 'records'; label: string }`.

## 9. Code map

| File | Change |
|---|---|
| `shared/park/sim.ts`, `levels.ts`, `solutions.ts`, `runner.ts` | the game and the rollback runner (sections 3, 4) |
| `scripts/park-replay.mjs` | solution debugging tool |
| `scripts/gen-map.mjs`, `shared/tilemap.json` | Music shrinks, Arcade, divider + door, cabinets, records board; regenerate |
| `shared/map.ts` | `ObjectUse` kinds, `KEEP_TYPES`, `layoutProblem` access for `arcade`, `migrateEastWing` |
| `shared/protocol.ts` | section 8 |
| `server/src/arcade.ts` | sessions, sequencing, server sim, records (sections 2, 6) |
| `server/src/world.ts`, `server/src/index.ts` | `use` → join with the arcade stand spot, leave hooks, owner-socket routing, `game_*` messages, `PublicUser.game`, persistence, migration |
| `scripts/gen-assets.mjs`, `client/public/assets/*` | `arcade` cabinet (16×32) + `arcade_on`, `records` board, `bubble_game`, `bubble_watch`, `park_*` tiles and sprites (ground/grass, brick, one-way, spikes, key, door closed/open, button up/down, START, ◀ ▶ blocks, box, lift, platform, gate, `s`/`t` blocks solid/ghost, coin ×4, walker ×2, flag down/up, balcony railing); regenerate |
| `client/src/park/*` | overlay, loop, renderer, input (section 5) |
| `client/src/net.ts`, `App.tsx`, `engine.ts`, `styles.css`, `sounds.ts` | messages, overlay mount, `gameOpen`, direct cabinet click, bubbles/tooltip/people list, records popover, sounds |
| `server/src/park.test.ts`, `server/src/arcade.test.ts` | tests |
| `AGENTS.md` | a short "Arcade" paragraph under "How things work" |

## 10. Testing

`npm test`:
- **Determinism**: the same events give the same `hashState` every run; `hashState` changes when any hashed field does.
- **Netcode harness** (`arcade.test.ts`): an in-process `Arcade` and 2–4 `Runner`s connected by a fake transport with
  per-message delays (0–8 frames, seeded), driven by mock time, with random inputs for 10,000 frames on several levels.
  Covers: remote inputs arriving late (rollback), the sender's own input retimed by the server, a player leaving and
  their slot reused by a new player, inputs sent during the countdown, a reconnect (fresh `game_session`), a runner
  stalled for more than 180 frames, a spectator joining mid-level. At the end: stop new input, deliver everything in
  flight (each fake connection is FIFO), tick the server and every runner (spectators included) past a common frame F
  that the server has stepped, then assert every runner's state at F hashes equal to the server's, no provisional
  events are left, and no runner is stuck. Also: an owner change and a disconnect insert a reset that stops queued
  movement; the 300-frames-behind path recovers through `game_sync`.
- **Physics**: standing on a head and being carried (recursively, bottom-up, regardless of slot order); a stack of two
  reaches a 3-tile ledge, one player can't; carrying into a ceiling stops; coyote time and jump buffer; one-way
  platforms; the camera never leaves anyone outside and the edges block.
- **Elements**: key pickup, carrier death/leave returns it, door opens, clear only when all present entered; buttons
  with 1/2/4 players and stacks counted, `latch`, `latchSolo`, gate OR and staying open while overlapped; box pushers
  (chain counts, opposing push blocks), falls into a pit; lift rises only with enough riders (stacks count) and
  carries; moving platform; walker stomp vs. side hit; respawn rules incl. total wipe; `s`/`t` blocks switching only
  when free; requirements drop when someone leaves.
- **Levels**: all parse (12 rows, one `S`, one `K`, one `D`); every recorded solution for 1, 2, 3 and 4 players clears
  its level.
- **Sessions**: players up to 4, then spectators; `game_play` in the lobby only; arcade stand spots beyond the cabinet's
  neighbours; leave on walk/meeting/door/`game_leave`; neutral input when the last socket closes; owner-socket routing;
  transition table incl. stale epochs; records stored once per eligible clear, none after a roster change.
- **Map**: Music and Arcade rects, divider door, cabinets reachable, `layoutProblem` refuses a boxed-in cabinet,
  `migrateEastWing` (moved-out, moved-in and admin-added objects; idempotent).

Also `npm run typecheck` and `npm run build -w client`.

**Browser** (headless Playwright Chromium, `--mute-audio`, never a visible window, no sound anywhere): pages `?as=A`,
`?as=B`, `?as=C`. A and B click cabinet 1 and see the lobby with two players; both stand on START → countdown → level
1; A's key presses move A at once on A's screen and within ~10 frames on B's; C clicks the same cabinet → balcony, sees
both players, C's cheer shows on A; `window.__park.desyncs === 0` on all three after a minute of random input; Esc →
Leave closes the overlay and the 🕹 bubble disappears for the others.

## 11. Implementation steps (for executors, one after another)

1. **Game core** (`shared/park/sim.ts`, `levels.ts`, `solutions.ts`, `runner.ts`, `scripts/park-replay.mjs`,
   `server/src/park.test.ts`; `GameEvent` type local to `shared/park` and re-exported later): section 4 and the runner
   of section 3 against an abstract transport. Order inside the step: physics + elements + their tests, then freeze the
   constants, then levels + recorded solutions.
2. **Server + map + protocol** (`shared/protocol.ts`, `shared/map.ts`, `scripts/gen-map.mjs` + `shared/tilemap.json`,
   `server/src/*`, `server/src/arcade.test.ts`, plus the minimal client edits that keep `npm run typecheck` green:
   `PublicUser.game` handling in `net.ts`, `ObjectUse` narrowing in `App.tsx`): sections 1, 2, 6, 7 (server side) and
   the netcode harness test.
3. **Client + assets** (`client/src/*`, `scripts/gen-assets.mjs` + `client/public/assets/*`, `AGENTS.md`): sections 3
   (loop, clock, input), 5, 6 (board), 7.
