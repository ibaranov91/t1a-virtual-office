# Sound v2: frictionless hall voice, a self panel and a personal mixer — design

Owner: Andrii Butko · 2026-10-15 · status: v2 after a Codex spec review · builds on
`2026-10-15-open-talk-rooms-design.md` (v3, shipped in PR #8). Only the differences are written here; everything not
mentioned stays as in the v3 spec.

## Why

Trying v3 on the andr instance showed friction:
- Walking out of Coffee cut your voice at once, and **Leave** muted the room instantly. In a real room you keep
  talking while you walk out and fade away; you start being heard as you walk up to the door.
- Mute/deafen lived in a panel that only appears inside a call. Discord keeps them in one place, always.
- Per-person volume popped up at the top of the screen; in Discord it's a right click on the person.
- The radio's volume was a shared knob you had to walk to. Music volume is a personal setting.

## 1. Hall voice by current position (replaces walk-driven roles)

A "hall" room is a room with `rules.voice: 'open'` (Coffee).

**Hall distance** `hallDistance(m, room, x, y)` (shared/map.ts, replaces `earshotDistance`): BFS from every tile of
the room rect that is walkable **or a seat** (`seatAt`, so sofa seats count) at distance 0, expanding over tiles that
are walkable or seats, up to `ZONE_OUT_TILES` (7); others `Infinity`. Memoized per room.

**Zone:** `hallDistance ≤ ZONE_IN_TILES` (6) to join, `> ZONE_OUT_TILES` (7) to leave (hysteresis).

**Server tick.** `World.voiceTick(now = Date.now())` runs every 250 ms (interval started in the constructor and
`unref`'d; tests drive it with mock timers). For every online human not in `door` `thinking`/`leaving` and not a bot:

1. Take the tile they are **currently shown on**: `position(u, now).tile`. On a mid-walk redirect the client keeps
   drawing the previous path until the new move's `startedAt`; the server must do the same — keep the previous
   `{ path, startedAt }` on redirect and sample it while `now < move.startedAt` (mirror `net.ts` `pose`).
2. Eligibility and priority, in this order:
   - In a **knock call** and standing **inside the room rect** → leave the knock call, then join (or wait, if full).
   - In a knock call and not inside the rect → keep the knock call, skip hall voice (and clear any waiting mark).
   - Otherwise: zone rule above — join when `≤ 6`, stay while `≤ 7`, leave when `> 7`.
   - Users flagged `afk` (see AFK) are skipped until their next own `move`.
3. Joining uses the existing room call `room:<id>` (created on demand). Members of one call connect to each other,
   exactly like knock calls. **The listener role, `callRole`, listener timers, voice generations and `walkVoice`
   are removed.**
4. **Cap**: at most `ROOM_VOICE_MAX` (12) members; others in the zone wait (`voice_wait`, as now). Promotion uses the
   same eligibility predicate (still in the zone, not in a knock call, not afk, has a socket). Starting a knock call
   clears the waiting mark.

**Other rules**
- Presence is **not** changed by hall voice (no `in_call` while passing a door); the 🎙 icon shows it.
- Knock rules stay (blocked into/out of/inside hall voice; becoming a member closes pending knocks).
- The room call is deleted when its last member leaves.
- **AFK** (client, as now: 10 min of no input and no speaking while in hall voice) sends `leave_room`. The server
  walks the user to their home desk only if its `hallDistance > ZONE_OUT_TILES` for every hall room, else to a free
  Lobby tile with that property; then marks them `afk` (private, server-side) so the tick ignores them until their
  next `move`. If there's no such tile or no path, they stay put, are marked `afk` and leave the call at once.
- The **Leave** button is removed from hall voice. `end_call` on a room call behaves as `leave_room`.

## 2. Global mic and the self panel

- **Mute and deafen are global and persistent** (`deck.voice` prefs) and apply to every call — hall voice and knock
  calls (knock calls no longer force unmuted). Send rule unchanged otherwise:
  `owner && inCall && mic && !muted && !deafened && (mode === 'voice' || spaceHeld)`.
- The mic is requested the first time this page joins any call as the voice owner; refused → listen-only.
- **Self panel**, bottom-left, always visible (like Discord's user panel): your name + presence dot, 🎙 Mute/Unmute,
  🎧 Deafen/Undeafen, ✋ (only while in hall voice), ⚙ settings. Status line: `In Coffee · within earshot: Ivan,
  Varya` / `In Coffee · nobody within earshot` / `Not in voice`. "Within earshot" is pure geometry: members of my
  call with `hallLevel(me) × hallLevel(them) > 0.02` (section 3) — it does not claim they actually hear me.
  "Enable sound" appears here when audio is blocked; in push-to-talk the mic button reads "Hold Space".
- **Ownership:** only the voice-owning tab can change mute/deafen/mode/hand. In a non-owner tab the panel shows
  "Voice is on in another tab" with "Use voice here" (`voice_claim`) instead of those buttons. Every tab listens to
  `storage` events on `deck.voice` and re-reads prefs, so deafen and the mixer apply in all tabs.
- **⚙ settings popover**: input mode (Voice activity / Push-to-talk) and the **mixer**: Voices, Music, Effects, each
  0–100% (`mix: { voice, music, effects }`, default 1, 1, 1; 0 = off).
- The in-call chips shrink: the hall voice panel goes away (self panel + room list cover it). The knock-call chip
  keeps "Talking with …", "Move to Meet" and Leave; its mute button goes.
- The 🔔 knock-sound toggle in the top bar is removed; Effects replaces it. On load, if `deck.sounds` is `off`, set
  effects to 0 once and delete `deck.sounds`; the `soundsOn()` gate is removed from every sound function.

## 3. Hearing hall voices: a symmetric zone level

For a voice whose source is a member of **my** hall call (I am a member too):

- `hallLevel(t) = 1` if `hallDistance(t) === 0`, else `max(0, 1 − hallDistance(t) / ZONE_IN_TILES)` (1, 0.83, …,
  0 at 6 steps out).
- **gain** = `1` if both tiles are inside the room rect (the v3 override, unchanged); otherwise
  `hallLevel(me) × hallLevel(source) × (occluded ? 0.8 : 1)`. Symmetric by construction (it only depends on the
  two positions' distances from the room), and always 0 before the connection drops (zone out is 7).
- **cutoff, pan, apparent position, echo send**: from the existing `soundModel` (occlusion muffling, the doorway
  the sound comes through, room reverb), with the echo send scaled by the same product.

Everything else in `soundModel` stays for non-call sources (the radio): distance law, room fill, portals,
occlusion. `zoneGain`, `flags.listener` and the listener fade are removed. Knock calls stay flat.

## 4. Personal mixer and the radio

- Three category buses in the soundscape — **voice** (remote peers), **music** (sound objects: the radio),
  **effects** (all of `sounds.ts`: knock, pop, join, leave, hand) — each a GainNode from the mixer, all into the
  master (deafen = master 0). **Reverb is per room and per category** (voice and music each get their own
  convolver per room), each convolver's output going to its category bus, so a category at 0 silences its echo
  too. Join/leave one-shots go panner → effects bus. Nothing connects to `destination` except the master.
- The radio always plays: remove its `use` toggle and `on` in `gen-map.mjs`, the shared knob (`ObjectState.volume`,
  `ServerMsg object.volume` and its consumer in `net.ts`, `ClientMsg object_volume`, server `setObjectVolume`,
  `objectVolume` and its persistence) and the radio "Walk over" UI (`Store.besideObject` / `Store.walkToObject`;
  the shared `besideObject` helper in `shared/map.ts` stays — coffee, fridge and lamps use it). Hover tooltip:
  "Radio · music volume in ⚙". On load, delete legacy `volumes['obj:*']` and `localMuted['obj:*']` prefs.

## 5. Per-person volume in the people list

- Right click on a person in the right-hand people list (or a "⋯" button shown on hover/focus, for touch) opens a
  small menu: name, **Volume** 0–200% (per user id, prefs as now), **Mute for me**, and Message / Follow / Knock
  (existing store actions; Knock disabled with the same reasons as in the wheel).
- The action wheel's 🔊 Volume item (for people in my call) opens the same menu anchored near the wheel.
- The top volume popover and the `voiceFocus` popover path are removed.

## Protocol changes (relative to main)

- Remove: `CallRole`, `PublicUser.callRole`, `ServerMsg call.role`, `ObjectState.volume`, `ServerMsg object.volume`,
  `ClientMsg object_volume`.
- Keep: `deafened`, `hand`, `voice_wait`, `voice_owner`, `voice_claim`, `leave_room`, `deafen`, `hand`.
- Constants: `ZONE_IN_TILES = 6`, `ZONE_OUT_TILES = 7` replace `EARSHOT_TILES`; `hallDistance` replaces
  `earshotDistance`.

## Testing

Server (`npm test`):
- Zone join at ≤ 6 and leave at > 7 from the current pose during a walk; hysteresis at 6/7; standing outside the
  door counts; a tick during a redirect samples the previous path (the client-visible tile).
- Sofa seats inside Coffee are distance 0 and keep you in the call.
- Knock priority: in a knock call outside the rect → hall skipped, waiting cleared; walking into the rect → knock
  call left, then join or wait when full. Promotion skips knock-call members.
- AFK: a home desk inside the zone (e.g. the cowork desk at `(32,15)`, distance 5) is not used; the user walks to a
  tile outside the zone, is flagged and not re-admitted until their next move; no-path case leaves at once.
- Cap + waiting by zone; presence untouched; knock blocks; relay only within one call; no `callRole` anywhere.

Acoustics:
- `hallLevel` values; hall-voice gain is symmetric for pairs across the Coffee door (e.g. `(27,3)` ↔ `(21,7)`,
  `(32,9)` ↔ `(32,14)`) and 0 for any member 6+ steps out; both inside → 1.
- Existing distance / fill / portal / occlusion tests for the radio still pass.

Browser (Playwright, fake mics): A stays in Coffee, B walks out — A's received level for B falls smoothly to 0 before
the connection closes; B walking back is heard again from the door; mute in the self panel persists across reload
and applies to a knock call; non-owner tab shows "Use voice here"; Music 0 silences the radio and its echo; Effects 0
silences knocks; right-click volume in the people list changes that person's level.
