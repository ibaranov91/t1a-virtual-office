# The Deck — virtual office for T1A (prototype)

## What it is
A persistent virtual office for a ~30-person fully remote consultancy. One cozy
pixel-art floor; every teammate is a little sprite in a room. The point is ambient
awareness (who's around, what they're on) and zero-friction "tap on the shoulder".
It should feel like a warm Stardew Valley interior, but it is a tool, not a game:
no inventory, no quests, no score. Hackathon prototype; iterate in this session.

## Core concepts
- **Floor**: one 2D top-down tilemap, 16 px tiles, ~40×24 tiles, fixed layout.
  Source of truth is `tilemap.json` (2D arrays: floor, walls/furniture, walkable mask).
  Rooms are named rectangles over the map, ~5 rooms:
  Lobby, Focus (quiet, no knocking), Co-working (open mic), Coffee (social), Meeting.
  Each room has: name, type, capacity, and a list of "spots" (tiles where sprites settle).
- **Avatar**: 16×24 pixel sprite, 4 directions, 4-frame walk cycle, idle frame.
  One base body; hair/shirt/skin are palette swaps so 30 people look distinct.
  Below the sprite: small nameplate (first name or initials). Above: emote bubble
  (zzz = away, headset = in call, "!" = knock, "…" = has status text, shown on hover).
- **Walking**: click a walkable tile → your sprite paths there via A* on the walkable
  mask, ~4 tiles/s, 4-frame animation. Server sends `move {userId, from, to, startedAt}`;
  every client computes the same path from the same map and interpolates from
  `startedAt`, so everyone sees the same walk. No per-frame streaming.
- **Room membership**: derived from the tile you stand on, not from the click.
- **Presence**: online / away / in call / offline. Status text set manually.
  Away detection is deferred; bots simulate it.
- **Knock**: click someone → your sprite walks next to them, "!" pops over their
  head, they get a toast with Accept / Later. On accept both get a meeting link
  (Google Meet / Teams, configurable per room). No built-in audio/video.
- **Room rules** (data, not code): Focus = knocks disabled; Meeting = occupants
  shown as "in a meeting", knocks go to Later automatically.

## Architecture
- **Server**: Node/TypeScript, single process. WebSocket (`ws`) for realtime, tiny
  REST for login/config. State in memory, dumped to a JSON file every ~30 s
  (users, last tile, status). Auth: shared token for the prototype; Entra ID later.
- **Protocol**: server is source of truth. Events: `hello`, `state` (full snapshot),
  `move {userId, from, to, startedAt, path?}`, `status`, `presence`, `emote`,
  `knock`, `knock_reply`. `path` is optional and reserved for server-computed paths
  if client/server maps ever diverge.
- **Web client**: React + TypeScript + Vite. Floor rendered on a single `<canvas>`
  with one `requestAnimationFrame` loop: tilemap → sprites sorted by y → bubbles
  and nameplates. Integer scale (2× or 3×), `image-rendering: pixelated`.
  React handles only chrome (toasts, status input, room list). Must work at
  ≥ 360 px wide.
- **Assets**: start with a CC0 pack (Kenney or similar) for tiles and a base
  character; replace later. Put everything under `client/public/assets/`. Loaded
  via a sprite atlas JSON so swapping packs doesn't touch code.
- **macOS**: Tauri wrapper around the web client, two modes: menu-bar popover
  (full floor) and a floating always-on-top strip (NSPanel, `.floating`,
  non-activating) showing each room as a tiny pixel icon with sprite heads.
  Web client first; Mac wrapper is the last step.
- **Dev data**: seed 12 fake users with bots that wander between spots, idle,
  change status and presence, so the floor looks alive when testing alone.

## Design
Cute, warm, cozy pixel art in the Stardew Valley interior style.
- Palette: warm wood floors, rugs per room, muted but saturated colors, soft
  dark outlines. Dark UI chrome around the canvas so the floor is the focus.
- Room character: Coffee has a machine that steams when occupied; Focus has desks
  and a lamp; Meeting has a long table; Lobby has a plant and a notice board.
- Subtle day/night ambient tint based on the viewer's local time.
- Motion: smooth walking, tiny idle bob, bubbles pop in with a 2-frame bounce.
- No clicking regions or abstract dashboard widgets; everything lives on the map.

## Not now (design for it, don't build it)
Slack/Teams status sync,
built-in audio, custom floor editor, mobile, real away detection, magic-link auth,
SQLite. Keep tilemap / room / spot / presence as data so these can be added
without a rewrite.

## Plan
1. Server + protocol + tilemap + bots walking on the grid.
2. Canvas client: tilemap, sprites, A* walking, nameplates, emote bubbles.
3. Knock flow with the "!" animation and toast.
4. Polish: day/night tint, coffee steam, room props, small-window layout.
5. Mac wrapper: menu bar + floating strip.

Start with 1 and 2; show a running demo before polish.
