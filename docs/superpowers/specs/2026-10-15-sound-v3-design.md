# Sound v3: sealed rooms and doors — design

Owner: Andrii Butko · 2026-10-15 · delta on top of `2026-10-15-sound-v2-design.md` (shipped in PR #15). Only the
differences are written here; everything not mentioned stays as in v2.

**Shipped** in #29 (leftovers of earlier versions removed in #43).

## Why

v2 let a hall room's voices fade out past its doors, so walking near Coffee could put you into a call you didn't
ask for. Andrii's rule: **if you didn't walk into the room, you don't want to hear it.** A door makes the moment you
join obvious. The echo was also too much.

## 1. Sealed rooms

- A sound source is heard **only by listeners standing inside the same room rect** (rect incl. its seats). This
  covers hall voices and sound objects (the radio). Nothing leaks through doors or walls; there is no fade outside.
- Inside a room the physics stays: hall voices at full gain with the gentle pan (`dx / 14`, ±0.25); sound objects
  with the distance law and `ROOM_FILL`.
- `shared/acoustics.ts`: `soundModel` returns silence (`gain 0, send 0`) whenever the listener's room ≠ the source's
  room (or either is outside every room). Remove the portal code (`doorSpread`, `PORTAL_LOSS`, `DOOR_SPREAD`, the
  path rebuild, occlusion/cutoff for different rooms — same-room sources are never occluded, so `cutoff` is always
  20000) and `hallLevel`'s outside fade: `hallVoiceGain` = 1 when both are inside the room rect, else 0.
- **Hard edges.** Crossing out of a room silences it within ~100 ms: dry gains move with a short time constant
  (0.02 s) when they drop to 0, and each room's reverb return is gated by a per-room gain that is 1 only while I stand
  inside that room — so the echo tail is cut too. (Fades inside a room keep the normal 0.08 s.)
- **Meeting instances** are not the office: while I'm in an instance I hear no sound objects and no door sounds, and
  crossings by people in other instances are ignored (voice in instances stays off, as before).
- **Movable sound objects:** the radio is part of the editable `Layout`. Every soundscape update re-reads each
  emitter's current position from the live map objects (and its room from that), so a moved radio is heard in its
  new room in every open tab; the set of rooms that get doors is recomputed on every layout update.
- **Softer echo:** echo send inside a room 0.05 (was 0.12); `RT60 = clamp(0.2 + area / 200, 0.25, 0.7) × material`
  with material `tile_check` 1.15, `wood` 1.0, `wood_dark` 0.8. The hallway bus is no longer used.

## 2. Doors and hall membership

- **Doorway tiles of a room**: passable tiles outside every room rect, reachable from the room rect through passable
  non-room tiles only (BFS). On today's map Coffee has `(26,6) (26,7)` and `(32..33, 11..12)`; Music has
  `(53,17) (53,18)` and `(58..59, 23..24)`. `shared/map.ts` exports `doorwayTiles(m, room)` (memoized).
- **Hall voice membership** (server `voiceTick`, replaces the 6/7 zone): you are a member while your current tile is
  inside the room rect **or on one of its doorway tiles** (so the connection is up before you step in); you leave as
  soon as you're on neither. `ZONE_IN_TILES`, `ZONE_OUT_TILES` and `hallDistance` go. Knock priority, cap, waiting,
  AFK, instances and presence rules from v2 stay, with "zone" read as "rect or doorway". AFK walks you to a tile
  outside the rect and its doorways.
- **Mic only inside**: the send rule gains `insideRect` — in a hall call your mic transmits only while your tile is
  inside the rect. In the doorway you're connected but silent and hear nothing (gain 0 both ways). `voice.ts`
  re-evaluates this every 100 ms from the current interpolated pose (`store.pose`, which already handles a redirect's
  previous path), independent of store messages, and re-runs the send rule when it flips.
- "Within earshot" in the self panel lists hall members inside the rect, and only while you're inside too.

## 3. A visible door with sound

- **Doors are not map objects** (furniture and rugs are an editable `Layout` since #23; doors must not be movable,
  added from the catalog or shift object ids). The engine derives them: for every hall room and every room with a
  sound object, each connected group of its `doorwayTiles` is one door — a 2×2 gap in a horizontal wall is a
  horizontal door, a 1×2 gap in a vertical wall a vertical one — and draws it in the y-sorted pass. They never block
  walking. `layoutProblem` already keeps doorways clear.
- **Open/closed** is client-side from poses: a door is open while any visible person's tile is on its doorway tiles or
  one step away from them; else closed. New frames in `scripts/gen-assets.mjs`: `door_h_closed`, `door_h_open`,
  `door_v_closed`, `door_v_open`, in the existing pixel style (a warm wooden door; open = swung panel showing the
  floor).
- **Sounds** (`sounds.ts`, effects bus): `playDoorOpen()` — a short soft creak (filtered noise with a rising pitch,
  ~0.35 s) — and `playDoorClose()` — a soft wooden click/thud (~0.15 s).
- **Crossing tracker** (replaces v2's hall-admission join/leave tracker, which is removed): every 100 ms, for each
  visible person in my instance, compare their current tile's place (inside a door room's rect / on one of that room's
  doorway groups / elsewhere) with the last tick. Doorway → rect is an enter through that doorway group, rect →
  doorway an exit. Play open/close **at that door** for me if I'm inside that room or I'm the one crossing. Pan is
  computed from the door's centre relative to me (`clamp((door.x − (me.x + .5)) / 10, −.35, .35)`), not through the
  sealed `soundModel`. Initialise silently on the first tick, on every `state` snapshot, on reconnect, on my instance
  change, and for anyone whose tile jumps by more than one step (teleports, arrivals through the exit door).

## 4. Knock calls and hall rooms

- **One voice at a time** (unchanged): no knocking out of a hall call; a knock on someone in one is blocked with
  "… is in Coffee — just walk in".
- **A knock call walking in together**: each member who steps into the hall rect moves to the hall call (unchanged).
  The conversation carries on in the kitchen; expect a reconnect of about a second while each of you crosses the door
  (the creak covers it). No peer-reuse machinery.
- **Someone left behind**: when a member leaves a knock call by walking into a hall room, everyone still in that knock
  call gets `ServerMsg { t: 'call_moved'; userId; roomId }`; the client shows a toast "Ivan went into Coffee" with a
  **Join them** button that walks you to a free tile inside that room. If only one person is left, the knock call
  ends as today (the toast still shows).

## Protocol changes

- Add `ServerMsg call_moved { userId: string; roomId: string }`.
- Remove `ZONE_IN_TILES`, `ZONE_OUT_TILES`; `hallDistance` → `doorwayTiles`.

## Testing

- Acoustics: different rooms → 0 (radio from Desks right at the Music door, Coffee voice from the doorway); same room
  → distance law + fill; reverb lengths ≤ 0.7 s × material; doorway tiles for Coffee and Music as listed.
- Server: member on doorway tiles and inside the rect, not one step further out; leave immediately past the doorway;
  knock-call member stepping in moves and the remaining members get `call_moved`; AFK destination outside rect and
  doorways; no new map objects (object ids unchanged).
- Browser (Playwright, fake mics): A inside Coffee, B walks up — B in the doorway is connected with gain 0 and A hears
  nothing from B; B steps in → gain 1 and real audio; B steps out to the doorway → silent within ~100 ms (dry and echo); the door frame is
  open while someone is at it and the creak/click play (count calls through a dev hook); radio silent outside Music;
  two people in a knock call walk into Coffee and are talking again within ~2 s of the second one stepping in;
  a third gets the "went into Coffee · Join them" toast.
