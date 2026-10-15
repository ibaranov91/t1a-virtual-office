# The dungeon under the garden: an easter egg — design

Owner: Andrii Butko · 2026-10-15 · status: v2, after a Codex spec review · branch `andr/dungeon`

## Goal

A small secret in the Garden. In a corner there is a hole in the grass, half hidden under a tree. Walk onto it and
you **fall through** into a dark stone **maze**. You find a **key** somewhere in it, walk to the locked **door**, it
opens, you climb a ladder and **pop out of a trapdoor** elsewhere in the Garden. Two to five minutes of fun, not a game
system: no score, no inventory beyond "I have the key", no levels.

- **Not too easy:** it's dark. You see only what's lit and in your line of sight, and you can only walk along tiles
  you've already seen. The key lies in a far dead end, a different one from your last visit.
- **Not too hard:** tiles you've seen stay faintly visible (you can't get lost in the same corridor twice), the maze
  has a few loops, and there's always a **Give up** button that climbs you back out.
- **Never by accident:** you fall only when **your own walk ends on the hole**. Walking past or across it does nothing,
  bots never fall, knock/follow/use walks never fall. It's a tool for work first: nobody gets dropped out of a call by
  crossing the lawn.
- People in the office don't see you while you're underground (like a meeting's own room). People underground at the
  same time see each other when they meet.
- Escaping the first time earns a secret achievement on the Lobby notice board.

Built in one pass: everything below ships together.

## Out of scope

- Several levels, monsters, traps, timers, leaderboards, a shared key or door.
- Voice underground (no knocks into or out of the dungeon; DMs still work).
- Editing the dungeon in edit mode. Server-side enforcement of "only walk where you've seen" (it's a client rule; an
  easter egg doesn't need anti-cheat).

## 1. The map (`scripts/gen-map.mjs`, `shared/map.ts`)

**One grid, two areas.** The dungeon lives on the same tile grid as the office, as a block **below the garden**,
separated by empty rows and **not connected** to the office by any walkable tile. A*, `walk`, `pathTo`, `sampleMove`
and move broadcasting stay exactly as they are, and every client still computes the same path from the same map.
Nobody can walk between the two areas; you only get there by falling (`place`).

- The office stays 65×34. Introduce `OFFICE_H = 34` in the generator and use it wherever it meant the office's bottom
  edge (outer walls, the hedge rows, the right-hand hedge). `H` grows to fit the dungeon block.
- Every tile that is neither office nor dungeon is a **wall that draws nothing** (a `void` wall tile name with no
  frame; the engine skips it). `applyLayout` treats "no wall" as walkable, so empty tiles must never be wall-less.
- New `TileMap` fields:
  ```ts
  office: Rect;                 // { x: 0, y: 0, w: 65, h: 34 }: what the office camera, overview and edit mode see
  dungeon?: {
    rect: Rect;                 // the whole dungeon block, outer stone wall included
    hole: Tile;                 // in the Garden: end your own walk here and you fall
    hatch: Tile;                // in the Garden: where you climb out after escaping
    landing: Tile;              // underground, under the hole: where you land
    door: Rect;                 // the locked door, set in the dungeon's outer wall (1×1 wall tile)
    doorFront: Tile;            // the floor tile in front of the door: arrive here to try it
    keySpots: Tile[];           // dead ends where the key may lie (≥ 6)
    torches: Tile[];            // wall tiles with a torch (light + flicker)
    decor: { type: string; x: number; y: number }[]; // bones, cobwebs, puddles, rubble, the leaf pile under the hole
  }
  ```
  (`Rect` = `{ x, y, w, h }`; add the type if there isn't one.)
- **The maze**, in this order, with a fixed seed (mulberry32 or similar) so it's the same for everyone until someone
  regenerates the map:
  1. Recursive backtracker on **15×9 cells** → 31×19 tiles, 1-tile corridors and walls.
  2. Knock out ~10 random interior walls (loops).
  3. **Landing chamber:** a 3×3 open area around a cell near one short end, `landing` in its middle.
  4. Measure path distances from `landing` **on the final floor**. **Door:** in the outer wall, next to the
     *boundary* cell (first/last row or column) farthest from the landing; `doorFront` is that cell's tile. Widen the
     space in front of it into a 3×2 chamber so the door reads as a destination.
  5. Re-measure. **Key spots:** the remaining dead ends (exactly one walkable neighbour) at ≥ 40 % of the farthest
     distance, outside the door chamber; at least 6, or the generator throws (change the seed until it passes).
  Key spots are dead ends on purpose: a path can only start or end on one, never pass through it.
- **Torches:** 6–8 on wall tiles that face a corridor, spread out (not next to the door or the landing).
- **Decor:** a dozen floor decals (bones, cobwebs in corners, puddles, rubble), never on `landing`, `doorFront` or a key
  spot. Drawn into the static layer; they don't block.
- **In the Garden:** the `hole` is a floor tile (not furniture, not part of `Layout`) at **(63, 25)**: the far-east
  corner, half under the crown of the tree at (62, 26), off every path and standing spot. The `hatch` is a floor tile in
  the open grass in the west part of the garden, clearly visible, off paths and spots (suggestion: (20, 32); the
  implementer checks it's free in the generated layout). Both are in the `floor` layer.
- **Generator checks** (throw on failure): the dungeon block is unreachable from `spawn`; `landing` reaches every key
  spot and `doorFront`; `hole` and `hatch` are walkable, inside the Garden, reachable from `spawn`, not standing spots
  and not under furniture.
- **Edit mode** (`layoutProblem`, so the client's red/green ghost agrees): refuse any object or rug whose footprint
  leaves `office` ("that's outside the office"); any object (floor-standing or not walkable-through) or rug on `hole`
  or `hatch` ("that covers the hole" / "…the hatch"); and any layout in which `hole` or `hatch` isn't reachable from
  `spawn` ("that blocks the hole" / "…the hatch").
- **Saved layouts** (`World.load`, next to `withNewFixtures`): a layout saved before this feature may cover or wall in
  the new tiles, and a failing `layoutProblem` would drop the whole saved layout. So before validating a loaded layout,
  **drop the objects and rugs that cover `hole` or `hatch`** (warn with their names; none of the one-of-a-kind types
  stand in the garden). The reachability rule for the two tiles is **not** applied on load (only to edits): if a saved
  layout still walls one in, keep the layout and warn; the server copes (below: falling just can't happen, and the
  climb-out spot falls back to the Lobby).

## 2. Protocol (`shared/protocol.ts`)

```ts
export const DUNGEON_INSTANCE = 'dungeon';
export const underground = (u: { instance: string | null }) => u.instance === DUNGEON_INSTANCE;
// server → client, only to that person, only while they're underground (and with the event that takes them out):
| { t: 'dungeon'; key: Tile | null; hasKey: boolean; event?: 'fell' | 'key' | 'locked' | 'opening' | 'escaped' | 'gave_up' }
// client → server:
| { t: 'dungeon_leave' } // give up: climb back out of the hole
```

- Underground people have `instance: 'dungeon'`, so "you only see people with the same instance" does the hiding.
  The dungeon is **not** in the server's meeting `instances` map, so the meetings board, `meetings` messages and
  `endMeetings` never see it.
- `key` (where *your* key lies; `null` once you hold it) is private: never in `PublicUser` or a broadcast. The server
  sends `dungeon` on falling in, on every change, and on (re)connect while underground.
- **The client's source of truth for "am I underground" is my user's `instance`** (from `state` snapshots and
  `instance` messages), not the event stream: whenever my user isn't underground, the client drops its dungeon state.
  So a departure that happened while disconnected is picked up from the next snapshot.
- New achievement in `ACHIEVEMENTS`: `{ id: 'escape', icon: '🗝️', title: 'Escape artist', how: 'Found the way out of
  the place under the garden.', secret: 'Something about a corner of the garden isn\'t quite right.' }`. Add an optional
  `secret?: string` to `Achievement`: until earned, the board shows `???` as the title and the `secret` text as the
  hint; once earned, the real title and `how`.

## 3. Server (`server/src/world.ts`)

**Walk identity.** Every `walk()` and every `place()` bumps a server-only `u.walkSeq`. A walk is **done** when
`now >= move.startedAt + pathDuration(path)`. Every dungeon timer (fall, key, door) records the `walkSeq` it was set
for and does nothing if `walkSeq` has changed by the time it fires. So any later walk (a new click, a follow, a knock
walk, `stepAside`) or a placement cancels it, whoever caused it.

**Falling in.** Only in the `move` intent handler: if the destination is `hole` and the walk was accepted, set a fall
timer for the walk's end. When it fires (same `walkSeq`, walk done, still at `hole`), and the person is a human,
online, not going out and in no instance: `fall(u)`.

`fall(u)` does what `enterMeeting` does before moving someone (close their knocks, `leaveCall`, `setWaiting(null)`,
clear errands, stop following and stop followers), then:
- `u.instance = DUNGEON_INSTANCE`; `u.dungeon = { key, hasKey: false }` where `key` is a random key spot other than
  this person's previous one (`u.lastKeySpot`, memory only). `u.dungeon` and `u.lastKeySpot` are stripped in `toPublic`
  and not persisted.
- `place(u, landing)`, or the nearest free dungeon tile to it (`occupied(DUNGEON_INSTANCE)`, BFS over walkable tiles);
- send `dungeon` with `event: 'fell'`.

Refactor the existing `if (u.instance) this.leaveMeeting(u)` call sites into one `leaveInstance(u)` that dispatches to
`leaveMeeting` or `leaveDungeon(u, 'quiet')`; `meeting_leave` must only ever leave a meeting.

**Walking underground.** Underground, a `move` is accepted only if its destination is inside `dungeon.rect` (anything
else is ignored, like a meeting's room). On each accepted underground walk:
1. **Settle the old key timer first:** if it is due (its time ≤ now) but hasn't fired yet, run it now. A late timer
   must never lose a key that was already stepped on.
2. **Key:** if you don't hold it and the new path contains your key tile at index `i` (only ever the first or last
   tile, since key spots are dead ends), set a key timer for `startedAt + i × WALK_MS_PER_TILE`. Firing (same
   `walkSeq`, or run by step 1): `hasKey = true`, `key = null`, send `dungeon` `event: 'key'`.
3. **Door:** if the walk ends on `doorFront`, set a door timer for the walk's end. Firing (same `walkSeq`, walk done):
   without the key send `event: 'locked'` (you stay); with it send `event: 'opening'`, and 900 ms later (same
   `walkSeq`, still underground) `leaveDungeon(u, 'escaped')`.

**Leaving.** `leaveDungeon(u, how)`: stop followers, clear the dungeon timers and `u.dungeon` (remember
`lastKeySpot`), `instance = null`, then `place` at an **exit spot**: the nearest unoccupied office tile to a target,
found by BFS over walkable tiles **that are reachable from `spawn`**, falling back to `freeLobbyTile`:
- `'escaped'`: target `hatch` (the hatch itself if free); `award(u, 'escape')` + `plantChanged(u)` (that's how
  achievements go out today); send `dungeon` `event: 'escaped'` before the placement's `instance` broadcast.
- `'gave_up'` (from `dungeon_leave`): target `hole`, but never the hole itself; send `event: 'gave_up'`.
- `'quiet'` (disconnect via `startLeaving`, or `meeting_go` while underground): like gave up, no event.

**Everything else underground:**
- `knockBlock`: target underground → `${name} is somewhere underground 🕳`; knocker underground → `You're underground —
  find the way out first`. These come before the generic "in a meeting" checks.
- `follow`: refuse if either side is underground. `give`: refuse across different instances (fixes meetings too).
- `use` already refuses inside any instance. Bots never send `move`, so they never fall.
- **Reconnect** while underground (a second tab, a reload within the grace period): send the current `dungeon` state
  (no event) on `connect`. A reload during the 900 ms of `opening` shows the door closed for that moment; accepted.
- **Persistence:** `dump` writes the gave-up exit spot for anyone underground (instances are memory-only), and `load`
  moves anyone whose saved tile is inside `dungeon.rect` to that spot too (older dumps, crashes).

## 4. Client

**Store (`net.ts`).** `dungeon: { key: Tile | null; hasKey: boolean; seen: Set<number> } | null` for me, cleared
whenever my user isn't underground (§2). On `dungeon`: update it; on events show a toast and play a sound (§5):
`fell` → "🕳 You fell through! Find the key and the way out." · `key` → "🗝️ You found a key!" · `locked` → "🔒 Locked.
There must be a key somewhere down here." · `escaped` → "☀️ You made it out!" (+ the usual achievement toast the first
time) · `gave_up` → nothing. `seen` starts empty on each fall; a reload underground starts it empty again (accepted).
`dungeonLeave()` sends `dungeon_leave`.

**Plant toast fix:** the `plant` handler shows the "your plant grew / new seedling" toast only when the plant actually
changed (stage, kind or care), so an achievement-only `plant` message shows just the achievement toast.

**Every place that assumes "instance = meeting"** gets a dungeon branch (check each use of `instance` on the client):
- `MeetingChip` renders only for meeting instances. A new **DungeonChip** in the same place and style while I'm
  underground: "🕳 **Underground** · find the key, then the door" → once I hold it "🗝️ **You have the key** · find
  the door", with a **Give up** button.
- People list: underground people go under an **Underground** group that only appears while someone is down there
  (not "In meetings"). Tooltip/status: "somewhere underground". No meeting bubble for them.
- `walkToUser` / `walkToRoom` from the office to an underground person: the knock-blocked reason instead of walking.
  Underground → another underground person: walk to the nearest free tile beside them in the dungeon (not the Meeting
  room's tiles). Client-side knock reasons (`net.ts`) match the server's.
- Action menus (the wheel and the people list): Knock, Follow and Give are hidden or disabled when either side is
  underground, with the same reasons.

**Area transitions.** "Area" = `MAP.office`, or `MAP.dungeon.rect` while I'm underground. When my area changes (fall,
escape, give up, a snapshot that moves me): recompute zoom bounds (`minPx`/`defaultPx` fit the current area), snap the
camera onto me with no glide, clear `manualCam`, hover, selection, the action wheel and placing, **leave edit mode**,
and stop any held movement keys. The edit-mode pencil is hidden while I'm underground.

**Engine (`engine.ts`):**
- **Camera and zoom:** `clampCam`, the overview fit and centering use the current area instead of the whole map. The
  camera follows me underground (no fixed centering like a meeting room).
- **Drawing:** the static layer covers the whole grid, but each frame draws only the current area (clip to it), so the
  dungeon never shows from the office, the office never shows from the dungeon, and the void never shows at all. Room
  tags, board badges, plants and the meeting fade are office-only.
- **Darkness underground**, drawn after the sprites and before nameplates/bubbles. Two separate things:
  - **Light** comes from my lantern (radius ~3.5 tiles: full to ~2, fading to 0), each other underground person's
    lantern (~3), each torch (~3, gently flickering per tile) and a soft light shaft on the landing (~2). Light spreads
    per tile with line of sight from its source (walls block it; a wall tile next to a lit floor tile is lit too).
  - **What I see**: a tile is **visible** if it is lit *and* in **my** line of sight within 10 tiles. Only visible
    tiles are drawn at their light level and get added to `seen`. Seen-but-not-visible tiles are drawn faintly (~20 %
    brightness, cooler tint); never-seen tiles are black. So a torch down a long straight corridor shows up, a torch
    behind a wall doesn't, and another person (and their lantern's glow) shows only when visible to me.
  - The chunky per-tile falloff suits the pixel art. Compute light and visibility once per tile change (mine or
    anyone's), not every frame; only the flicker animates.
- **Moving underground:** a click/tap on a walkable tile computes the normal A* route (`pathTo`, unchanged) and goes
  only if **every tile on that route is in `seen`**; otherwise nothing happens. The hover highlight shows only where a
  click would go. A click on the door walks to `doorFront` (same rule). **Arrow keys / WASD** step one tile at a time
  (the next tile must be walkable; it doesn't have to be seen: stepping is how you explore). Holding a key keeps
  walking: send the next step when the current one is nearly done (~60 ms left), never on every key repeat; a held
  key stops on keyup, blur, or an area change. Keyboard walking is underground-only; in the office keys keep their
  current meaning.
- **The key** (mine only) lies on its tile with a small glint, drawn only while that tile is visible; it disappears
  when the server says I have it. **The door** is closed for everyone, and shows open only for me after `opening`.
- **Effects** (a store-side list like `objectFx`, triggered by `instance` messages using the user's tile before the
  update): **fall** (office viewers, incl. me: the sprite sinks into the hole, clipped at its edge, ~0.5 s, a puff of
  dust), then for me a ~0.4 s fade to black before the dungeon appears; **land** (dungeon viewers, incl. me: drops in
  from above, dust); **climb** (office viewers, incl. me: rises out of the hatch, dust, the hatch lid flips open for a
  moment). Leaving through the door or giving up shows nothing special underground.

## 5. Art and sound

**`scripts/gen-assets.mjs`** (procedural, same style and outline as the rest; `npm run gen` and commit the output):
- Dungeon: `dungeon_floor_0..2` (dark, uneven cobblestones), `dungeon_wall` (top of a stone block) and
  `dungeon_wall_face` (a block whose south face shows, used where floor lies below), `dungeon_door_closed` /
  `dungeon_door_open` (iron-banded wood in a stone arch; open shows a ladder going up into light), `torch_0..2`
  (wall sconce with flame frames), `key` (small, gold, readable at 1×), decals `bones`, `cobweb`, `puddle`, `rubble`,
  `leaves`.
- Garden: `hole` (a dark, irregular hole with ragged grass edges and a root or two: noticeable if you look, not a
  neon sign), `hatch` (a small weathered wooden trapdoor set in the grass) and `hatch_open` for the climb effect.

**`client/src/sounds.ts`** (synthesized, short and quiet like the existing ones, only for me): `fall` (a falling
whistle and a soft thud), `key` (two bright chimes), `locked` (a short metallic rattle), `unlock` (a click and a low
creak, on `opening`), `escape` (three rising notes, on `escaped`).

## 6. Tests

`server/src/world.test.ts` (fake timers, like the existing tests):
1. A human's own `move` ending on the hole → after arrival: `instance === 'dungeon'`, at the landing, a private
   `dungeon` `fell` message whose `key` is one of `keySpots`; everyone gets the `instance` broadcast; nobody else gets
   the key. A second fall never gets the same key spot as the first.
2. No fall when: passing over the hole to a tile beyond it; a new move before arrival; a bot; a knock walk, a follow
   or `stepAside` ending on the hole after an earlier move there (the `walkSeq` guard); the hole walled in by a saved
   layout (no route, no fall).
3. Underground: a move outside the dungeon is ignored; knocks both ways are blocked with the underground reasons;
   follow and give are refused.
4. Key: arriving on the key tile → `hasKey`; starting a new walk from the key tile picks it up at index 0; a redirect
   before reaching it doesn't; a due-but-unfired key timer is settled by the next move; consecutive early keyboard-style
   steps don't lose the key. Door without key → `locked`, still underground; with key → `opening`, then after 900 ms
   out at the hatch, `escape` earned, `escaped` sent; walking away during the 900 ms cancels it; a second escape keeps
   the first timestamp.
5. `dungeon_leave` → beside the hole (not on it), no achievement. Exit spots fall back to the Lobby when the hatch's
   surroundings are cut off. Disconnect while underground → leaves quietly before walking out. `meeting_go` while
   underground → leaves the dungeon, enters the meeting.
6. `dump` while underground saves the exit spot; `load` with a tile inside the dungeon moves it there; `load` of a saved
   layout with a plant on the hole drops that plant and keeps the rest.
7. Edits whose footprint leaves the office, that cover the hole or the hatch, or that cut either off are refused.

Generator checks (§1) cover the maze's connectivity. Browser QA: headless Playwright only, muted: fall in, explore,
click an unseen route (nothing), take the key, try the door with and without it, escape, give up, a second tab in the
office not seeing the dungeon, reload while underground.

## 7. Docs

`AGENTS.md`, "How things work": one short bullet for the dungeon (one grid with two unconnected areas, `instance:
'dungeon'`, the fall rule and `walkSeq`, private key state, `MAP.office` for camera/overview/edit mode).
