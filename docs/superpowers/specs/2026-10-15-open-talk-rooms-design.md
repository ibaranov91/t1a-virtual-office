# Open talk rooms + sound physics — design

Owner: Andrii Butko · 2026-10-15 · status: v3, after two Codex spec reviews

## Goal

1. **Open talk rooms.** Walk into Coffee and you are in its voice channel, like clicking a voice channel in Discord:
   everyone in the room hears everyone, with mute, deafen, push-to-talk, per-person volume, raise hand, join/leave
   sounds and an AFK timeout. Walking past or through the room you hear the conversation fade in and out.
2. **Sound physics.** Everything you hear from the map (room voices, the radio, join/leave sounds) goes through
   one soundscape: loudness falls with the distance sound travels through doors (not through walls), sound from
   another room is muffled and comes from the doorway, stereo left/right, and every room has its own echo, so
   walking past a room you hear its echo drifting out.
3. **A radio** in the Lobby playing music, a shared sound source: anyone can switch it on/off and turn its one
   volume knob for everyone; you can only mute it for yourself. (A talking barista NPC was built and then removed
   at Andrii's request.)

Built in one pass: everything below ships together.

## Out of scope

- Physics for knock calls and distance falloff outside voice rooms (Ivan's "p2p conversations" task). The
  soundscape is written so that knock calls can be plugged in later; this change leaves them flat (gain 1, centre).
- A media server (SFU). Voice stays a browser-to-browser mesh; hence the speaker cap.
- Global push-to-talk while the tab is in the background (needs the Mac wrapper).
- Channel topic / status text. Libraries for spatial audio (plain Web Audio is enough; see "Why no library").

## 1. Voice rooms and roles

A room is a voice room when its data says so: `rules.voice: 'open'` in `scripts/gen-map.mjs` (then regenerate
`shared/tilemap.json` with `node scripts/gen-map.mjs`). Only Coffee gets it; its label becomes
`open voice — walk in to talk`. All code works for "any room with the flag", never for Coffee by name.

Every human has `callRole: 'member' | 'listener' | null` next to the existing `callId`.

- **member**: in the call, may send and receives audio. People in knock calls are members too.
- **listener**: only in a room call, only while walking past or through the room. Receives audio from members,
  never sends, is never asked for the microphone, and never connects to other listeners.

A room call has id `room:<roomId>` and no Meet link. It exists while it has at least one member. When the last
member leaves it ends at once: all its listeners leave too and nobody gets a listener phase (so the last person
walking out does not fade out — there is nobody left to hear). Before deciding the room is empty, promote a waiting
user (see the cap below).

Bots never join room calls and do not count toward the cap. Bots still wander in and out of Coffee.

## 2. Joining and leaving follow the walk

The server decides on every `walk()` of a human, from the accepted move (its `path` and `startedAt`, which is in
the future for a mid-walk redirect), before broadcasting it. Skip it for users whose `door` is `thinking` or
`leaving`.

1. **Destination inside a voice room** → member of that room's call from the start of the walk (audio is connected
   by arrival; their voice fades in for the room as they approach, see physics). Joining as member leaves any
   knock call or other room call first, and closes their pending knocks (section 4). Already a member of this room
   call → no change.
   - **Cap.** If the room call already has `ROOM_VOICE_MAX` (12) members, they are not joined: they still leave any
     knock call (walking into a voice room always ends a knock call), walk in, stand without voice and are marked
     waiting for that room (private state, see protocol). When a member leaves, the earliest waiting user whose
     destination is still inside the room, who has at least one socket and whose `door` is not
     `thinking`/`leaving`, is joined.
2. **Otherwise, the path comes within earshot of a voice room that has a call** (any path tile with
   `earshotDistance(room, tile) ≤ EARSHOT_TILES`, see section 6) → listener of that call. A member walking out
   becomes a listener this way (same `callId`, role changes) unless they were the last member (section 1).
   Someone in a knock call never becomes a listener (the knock call wins).
   - **Expiry.** Let `i` be the index of the last near tile on the path (`path[0]` is the start tile). If `i` is the
     last index (the destination itself is within earshot, i.e. standing just outside), they leave the call at
     arrival: `startedAt + pathDuration(path)`. Otherwise they leave at `startedAt + (i + 0.5) * WALK_MS_PER_TILE`:
     the moment the rounded pose (`sampleMove(...).tile`, which switches tiles half-way) steps off the last near
     tile. Listeners exist only while walking.
3. **Otherwise** → leave any room call. Knock calls are untouched by walking.

A new walk replaces the previous decision: clear the listener timer and the waiting mark.

**Timers are guarded.** Every listener timer is cancelled on any call exit, role change and call deletion, and its
callback re-checks a per-user voice generation number (incremented on every call/role change) and that the user is
still a listener of that call before doing anything. A stale timer must never hang up a later call.

**Other exits:** disconnect (existing `startLeaving` → `leaveCall`), `leave_room`, and `end_call` (treated as
`leave_room` when the call is a room call).

**`leave_room`**: walks the user to their home desk if it is free, else a free Lobby tile (the same choice as
`arrivalSpot` for a recent return, minus `lastSpot`). That walk makes them leave by rule 2/3. If no path exists,
they leave the call directly.

**Demotion member → listener** clears speaking (broadcast `speaking` off), lowers the hand (broadcast) and restores
presence to `presenceBeforeCall` unless the user picked a presence themselves while a member. Deafen is untouched.

**Presence.** Room members get presence `in_call` like knock calls; listeners' presence does not change. Choosing a
presence in the top bar while in a room call changes presence only (it does not leave the call) and counts as
"picked by themselves". No 2-hour hang-up timer for room calls (AFK covers it).

## 3. Voice ownership (one tab per person)

A person may have several tabs/sockets. Exactly one socket per user owns voice.

- Each socket gets an id on connect. The newest socket becomes the owner (covers page reloads). When the owner
  socket closes and others remain, the most recently connected remaining socket becomes owner. With no sockets
  left, the existing leaving flow runs.
- The server tells each socket of the user `{ t: 'voice_owner', owner }` on connect and on every change.
- `{ t: 'voice_claim' }` from a socket makes it the owner.
- `rtc` is delivered only to the target user's owner socket. `rtc`, `speaking`, `mute`, `deafen`, `hand` from a
  non-owner socket are ignored.
- A non-owner tab has no microphone and no peer connections. In a call it shows "Voice is on in another tab" with a
  "Use voice here" button (`voice_claim`). The soundscape (radio, sounds) still plays in every tab.

## 4. Knocks

Checked in `knock()` before walking, again at `arrive()`, and again on accept before `connectCall`:

- The target's destination is inside a voice room → blocked: "Leo is in Coffee — just walk in".
- The knocker is a room-call member → blocked: "You're in Coffee voice — step out to knock".

When someone becomes a room-call member, every walking/pending knock from or to them is closed as `later` with
reason "Knock cancelled — <name> walked into Coffee". `connectCall` reuses an existing call only when it is a knock
call, never a room call.

Clicking a person opens Ivan's action wheel; for someone in my room call it has a "Volume" item, and Knock is
disabled for anyone in a voice room. The hover tooltip says "in Coffee voice" / "passing Coffee".

## 5. Microphone, controls and prefs

### Connections (receive first, no renegotiation on role change)

My page makes connections only while it owns voice. It connects to every eligible peer: same `callId`, a human,
online, `door` not `thinking`/`leaving` (that covers the 5 s grace after their last socket closed), and at least one
of the two of us a member. The same rule decides peer creation, acceptance of incoming signals, pruning, and the
connection count in the UI, and is re-evaluated on every store change. (Whether the other person's page owns voice
is not visible to me and not needed: the server delivers `rtc` only to owner pages.)

Every peer connection has exactly one audio m-section, negotiated `sendrecv` for everyone, listeners included:
- **Offerer** (lower user id, as today): `pc.addTransceiver('audio', { direction: 'sendrecv' })` with no track, plus
  today's data channel, then the offer.
- **Answerer**: does not create a transceiver. After `setRemoteDescription(offer)` it takes the audio transceiver
  the offer created, sets `direction = 'sendrecv'`, then creates the answer — even without a microphone.
- Sending is switched with `transceiver.sender.replaceTrack(micTrack | null)` and `micTrack.enabled`. A role change
  never rebuilds or renegotiates a connection; `ontrack` fires during the first negotiation and the receiver track
  carries audio once the far side attaches its mic. A rejected `replaceTrack` is logged and retried on the next
  send-rule run.
- Receive setup never waits for the microphone: connections are made as soon as the role is known; the mic is
  attached when it arrives.

Signalling keeps today's glare rule (lower user id offers) and per-page `inst`, with two fixes:
- A fresh `inst` is generated every time this page acquires voice ownership or its WebSocket reconnects, so peers
  always treat it as a new page.
- A `hello` whose `inst` differs from the one we are connected or connecting to always restarts that peer (close +
  new offer), even while an offer is outstanding.

Ownership on the page: assume "not owner" until the server says otherwise. Losing ownership, or the WebSocket
closing, stops voice on this page at once: bump the mic-request token, stop the mic, close all peers. Regaining it
(`voice_owner: true`, which the server re-sends after every reconnect) starts fresh with a new `inst`.

### The send rule

One function decides what is sent, re-run after every change of role, ownership, mic, mute, deafen, mode or Space:

- `sender track = micTrack` when I am the owner, a member and have a mic; else `null`.
- `micTrack.enabled = owner && member && !muted && !deafened && (mode === 'voice' || spaceHeld)`.

The mic is requested when I become a member as owner and have none. Each request carries a token
(`++micRequest`); a result is used only if the token is current and I am still an owning member of the same call,
otherwise its tracks are stopped. Leaving the call bumps the token and stops the mic. A pending or refused prompt
leaves me receiving (refused → "Microphone blocked: you can listen but not talk", as today).

### Controls

Persisted per browser in `localStorage` key `deck.voice` (every access in try/catch; defaults when missing):
`{ muted, deafened, mode: 'voice' | 'ptt', volumes: { [userId]: number 0..2 }, localMuted: { [userId]: true } }`.

- **Mute**: as today. Saved; re-applied on every room-call join (knock calls keep today's behaviour: start unmuted).
- **Deafen**: hear nobody (soundscape master gain 0) and send nothing. Turning it off restores the mute state from
  before. Saved and re-applied on room-call join. Broadcast so others see it; still applies while a listener.
- **Mode**: voice activity (default) or push-to-talk on **Space**. `keydown` Space (not repeat) outside inputs,
  textareas, selects and contenteditable sets `spaceHeld` and calls `preventDefault`; `keyup` Space anywhere and
  window `blur` clear it. Works only while the tab is focused; the panel says "Hold Space to talk". Applies to all
  calls.
- **Per-person volume**: 0–200% slider (step 5%, default 100%) and "Mute for me", per user id, for call peers and
  people only. Applies everywhere. (The radio's volume is shared, see section 7.)
- **Raise hand ✋**: room-call members only. Toggle; ✋ over your head; other members hear `playHand()`. Lowers
  itself after 1.5 s of continuous speaking, on demotion and on leaving the call.
- **Leave**: sends `leave_room`.
- **AFK**: in the owner tab, while a member of a room call: no pointer/keyboard/wheel input in the tab and no
  speaking for `AFK_MS` (10 min) → send `leave_room` and toast "Left Coffee after 10 minutes of silence". Checked
  every 15 s; the clock restarts on join.

## 6. Sound physics (the soundscape)

### Why no library

Plain Web Audio has all the parts (StereoPannerNode, BiquadFilterNode, ConvolverNode, GainNode). Resonance Audio
(Google) models one shoebox room around the listener, has no occlusion on the web and its web SDK repository was
archived in April 2026; atmoky is pre-release; JSAmbisonics targets VR. What a multi-room map needs — sound
travelling through doors — is ours to write either way ("rooms and portals", as in Wwise/Steam Audio).

### Pure model: `shared/acoustics.ts` (deterministic, unit-tested)

Positions are tile coordinates as used by poses (fractional `x, y` of the tile origin). All geometry uses
centres: `centre = (x + 0.5, y + 0.5)` for both listener and source. "Which tile / which room" always uses the
rounded pose tile (`pose.tile`, as in `net.ts`). Constants: `SOUND_REF_TILES = 3`, `SOUND_ROLLOFF = 0.6`,
`SOUND_MAX_TILES = 18`, `ROOM_FILL = 0.4` (tuned after the first listen: the first version fell off too fast and
panned too hard).

- **Sound-passable tiles**: `walls[y][x] === 0` (furniture does not block sound; walls do; doorways are gaps).
- **Doorway tiles**: passable tiles outside every room rect (on this map exactly the door thresholds).
- **Field**: BFS (4-neighbour, neighbour order up, right, down, left) over passable tiles from the listener's tile,
  up to `SOUND_MAX_TILES`; other tiles `Infinity`. Computed once per update for all sources.
- **Path distance** `d`: field value at the source's tile. **Direct distance**: Euclidean between centres.

`soundModel(...)` returns `{ gain, cutoff, pan, send, apparent }` and is evaluated in this order:

1. **Voice-room override**: the source is a member of my room call and both our tiles are inside that room →
   `gain 1, cutoff 20000, pan clamp(dx / 14, −0.25, 0.25), send 0.12, apparent = source centre` (`dx` centre to
   centre). Inside the room everyone is clear, like Discord, however far apart.
2. **Out of range**: `d === Infinity` and not in the source's room → `gain 0, cutoff 20000, pan 0, send 0, apparent = source centre`.
3. Otherwise:
   - **Distance gain** `g = 1 / (1 + ROLLOFF·max(0, d − REF) / REF) × fade`, `fade = 1` for `d ≤ 0.7·MAX`, else
     `max(0, (MAX − d) / (0.3·MAX))`: a gentle inverse law (1, 0.625, 0.417 at 3, 6, 10 tiles), silent at 18.
   - **Room fill**: when listener and source stand in the same room, `g = max(ROOM_FILL, g)` — the room's
     reflections fill it, so you hear the radio from any corner of the Lobby. Also applies beyond the BFS range.
   - **Rooms and portals** (listener not in the source's room): rebuild the shortest path from the listener; the
     sound reaches you only through the doorways on it. `portal = doorSpread(k) × PORTAL_LOSS^(doorways − 1)`,
     where `k` = steps from the listener to the first doorway tile, `doorSpread(k) = max(0, 1 − k / (DOOR_SPREAD +
     1))` with `DOOR_SPREAD = 4`, and `PORTAL_LOSS = 0.35`. Gain and echo send are both multiplied by `portal`. So in
     the next room you hear a source only near the door it comes through, and two rooms away practically nothing.
   - **Occlusion**: sample the segment between the two centres every 0.2 tiles; occluded if any sample lies in a
     tile with `walls[y][x] !== 0`. Occluded → `gain = g × 0.6`, `cutoff = clamp(3000 − 200·(d − direct), 900,
     3000)` Hz. Clear → `gain = g`, `cutoff = 20000`.
   - **Apparent position**: clear → the source centre. Occluded → rebuild the shortest path from the listener to
     the source (walk downhill from the source tile, taking the first neighbour in order up, right, down, left whose
     field value is one less, then reverse) and take the centre of the first doorway tile on it after the
     listener's own tile; if there is none, the source centre. So sound from another room comes from the door.
   - **Pan**: `clamp((apparent.x − (listener.x + 0.5)) / 10, −0.35, 0.35)` (equal-power StereoPannerNode; kept narrow).
   - **Room echo send**: `send = level × g` (distance gain only, not the 0.55 occlusion factor), `level` 0.12 when
     the listener's tile is in the same room as the source's (or both outside every room), else 0.35. The send
     taps the signal after the occlusion low-pass, so echo from another room is muffled too but not attenuated
     by the wall: that is the echo spilling out of the door.
4. **Listener fade** (only for remote voices of the room call I am a listener of; never for emitters or anything
   else): multiply `gain` and `send` by `zoneGain(earshotDistance(room, me))`, where `zoneGain(0) = 1`,
   `zoneGain(k) = 1 − k / (EARSHOT_TILES + 1)` for `1 ≤ k ≤ EARSHOT_TILES`, else 0. Connections only exist inside
   earshot, so voices fade instead of popping in.
- **Earshot field** (for the listener role on the server and the fade above): BFS over **walkable** tiles from
  every walkable tile inside the room (distance 0), up to `EARSHOT_TILES = 5`; memoized per room.
- **Room reverb impulse response** (generated once per room and the hallway): stereo, length = RT60 seconds,
  `RT60 = clamp(0.3 + area / 120, 0.35, 1.2) × material` with `area = rect.w × rect.h` and material by floor:
  `tile_check` 1.3, `wood` 1.0, `wood_dark` 0.7; hallway RT60 0.6. Samples: independent white noise per channel
  × `exp(−6.91·t / RT60)`, plus six early-reflection impulses between 7 and 60 ms (amplitudes 0.5 down to 0.2,
  alternating channels), passed through a one-pole low-pass whose coefficient falls linearly from 0.6 to 0.15
  over the length (darker tail). Deterministic seed per room id.

Knock calls are flat: gain 1, centre, no filter, no echo (unchanged behaviour).

### Audio graph: `client/src/audio.ts` + `client/src/soundscape.ts`

- `audio.ts`: the one `AudioContext` for the app (also used by `sounds.ts`), resumed on the first
  `pointerdown`/`keydown`. `needsGesture` is true while the context is not `running` **or** any per-peer media
  element's `play()` has failed; `resume()` resumes the context and retries every failed element, and the flag
  clears only when both succeed.
- Per source: `input → BiquadFilter (lowpass) → dry GainNode → StereoPanner → master`, and
  `lowpass → send GainNode → room reverb bus (ConvolverNode → master)`. `master` is a GainNode (deafen = 0).
- Sources: remote voice peers (`createMediaStreamSource(stream)`; the stream must also be attached to a muted,
  playing `<audio>` element per peer, or Chrome feeds silence into WebAudio) and object emitters (the radio).
- Every 100 ms: compute the model for every source against my current pose and apply with
  `setTargetAtTime(v, now, 0.08)` (gains, pan, cutoff). Dry and send levels also × personal volume (0 when muted
  for me).
- One-shots (join/leave sounds) can be played at a tile: routed through a StereoPanner with the model's pan, gain 1.
- Dev builds expose `window.__soundscape.levels()` → `[{ id, gain, pan, cutoff, send }]` for tests.
- "Enable sound": shown in every voice chip and as a standalone chip "🔈 Click to enable sound" whenever the
  context is suspended and any source is audible (model gain > 0). Cleared only once the context is running.

## 7. Sound sources: the radio

A sound source is anything with a position that plays audio through the soundscape: a person's voice or a map
object. The two built-in emitters below are the reference cases (speech and music) and the pattern for the
music room later. Both loop a clip in sync with the server clock: start a looping `AudioBufferSourceNode` at offset
`(store.now() / 1000) % buffer.duration` (the decoded `AudioBuffer.duration`, also used for the envelope phase).
Restart — stopping and disconnecting the previous source node first — whenever the context resumes and whenever
the server clock offset (`store.offset`) changes by more than 250 ms. Per-person volume
does not apply: an object's level is its shared knob (`ObjectState.volume`, server-side, persisted, `object_volume`
message, 5% steps). Like the light switch, the knob only turns when you stand still right next to the object
(`besideObject`); the server ignores it otherwise, and the UI offers "Walk over". "Mute for me"
(`localMuted['obj:<id>']`) is the only personal control and works from anywhere.

### Radio (map object)

- `scripts/gen-map.mjs`: object `radio` at `(13, 14)`, right of the reception desk, 1×1, blocks walking, with
  `sound: { clip: 'radio', gain: 0.6 }` (new optional `MapObject.sound`). Add an assertion that the spawn, the exit
  and every spot are still reachable from each other after all objects are placed.
- `client/public/assets/sounds/radio.m4a`: 113 s piano track supplied by Andrii ("We Are!", piano cover), mono
  AAC; already in place. Loops like any song on repeat.
- `scripts/gen-assets.mjs`: a `radio` frame (16×16, small retro radio in the existing palette) and two tiny note
  frames `note_1`, `note_2`. The engine draws notes rising from the radio like the coffee steam, always on.
- Clicking the radio opens its volume row ("Radio") in the popover.

## 8. Sounds

Synthesized in `client/src/sounds.ts` (no files), honouring the existing sound toggle, through the shared context:
- `playJoin()`: soft two-tap "tok-tok", a touch higher and quieter than the knock.
- `playLeave()`: one lower tap with a falling pitch.
- `playHand()`: a short soft two-note chime.

Join/leave are played at the doorway tile through the soundscape (so they pan toward the door), only when I am a
member standing inside the room. Every 100 ms the client compares poses with the room: a member whose pose crosses
into the room is added to a local "admitted" set and plays join (also when that member is me); anyone in that set
whose pose crosses out plays leave and is removed — even if they were already demoted, removed or went offline.
The set is rebuilt silently from every `state` snapshot (no sounds on load or reconnect).

## 9. UI

- **Room voice panel** (in `.chips`; replaces `CallChip` when my call is a room call and I am a member;
  `CallChip` stays for knock calls): "🎙 Coffee · 4 in voice" + state (`connecting…`, `live`, `listen-only`,
  `muted`, `deafened`, or `hold Space to talk`); buttons Mute/Unmute (hidden when listen-only), Deafen/Undeafen,
  ✋, mode toggle (Voice activity / Push-to-talk), Leave, Enable sound when needed; an expandable list of the other
  members, then current listeners labelled "passing by": speaking dot,
  🔇/🎧/✋ icons, volume slider, "Mute for me". Clicking a sprite opens the list scrolled to that row (a
  `voiceFocus` id in the store); for the radio or a peer when I am not a member, the same row appears as a small
  popover above the chips.
- **Listener chip**: "🔈 Passing Coffee" + Enable sound when needed.
- **Waiting chip**: "Waiting for a spot in Coffee voice" while the private waiting state says so.
- **Other-tab chip**: "Voice is on in another tab" + "Use voice here".
- **Room list**: after each name in a voice room, 🎙 for members, plus 🔇 / 🎧 / ✋ when muted / deafened / hand up.
- **Over heads**: existing talk bubble for room members (speaking / quiet / muted). New frames `bubble_hand` (✋,
  shown above everything else while the hand is up) and `bubble_deaf` (crossed headphones, instead of the talk
  bubble while deafened), drawn in `scripts/gen-assets.mjs` in the existing bubble style; regenerate with
  `node scripts/gen-assets.mjs`. Listeners get no talk bubble.

## 10. Protocol (`shared/protocol.ts`)

```ts
export const ROOM_VOICE_MAX = 12;
export const EARSHOT_TILES = 5;
export const AFK_MS = 10 * 60_000;
export type CallRole = 'member' | 'listener';

PublicUser += { callRole: CallRole | null; deafened: boolean; hand: boolean }

ServerMsg +=
  | { t: 'call'; userId; callId: string | null; role?: CallRole; link?: string } // role added; sent on role change too
  | { t: 'deafen'; userId: string; on: boolean }
  | { t: 'hand'; userId: string; up: boolean }
  | { t: 'notice'; text: string }                      // personal info toast
  | { t: 'voice_wait'; roomId: string | null }         // private: waiting for a spot; replayed on connect
  | { t: 'voice_owner'; owner: boolean }               // per socket

ClientMsg +=
  | { t: 'deafen'; on: boolean }
  | { t: 'hand'; up: boolean }
  | { t: 'leave_room' }
  | { t: 'voice_claim' }
```

Waiting state is transient (not persisted); cleared on promotion, a new walk, `leave_room` and final disconnect.
`World.connect(userId, send)` returns `{ socket, close }`; `World.handle(user, msg, socket)` gets the socket id.

`shared/map.ts`: `Room.rules.voice?: 'open'`, `voiceRooms(m)`, `earshotDistance(m, room, x, y)`.

## 11. Code map

| File | Change |
|---|---|
| `scripts/gen-map.mjs`, `shared/tilemap.json` | `voice: 'open'` + label on Coffee; regenerate |
| `scripts/gen-assets.mjs`, `client/public/assets/*` | `bubble_hand`, `bubble_deaf`; regenerate |
| `client/public/assets/sounds/radio.m4a` | done already |
| `scripts/gen-map.mjs` (again) | `radio` object with `sound`, reachability assertion |
| `shared/map.ts` | voice flag, earshot field |
| `shared/acoustics.ts` | pure sound model (section 6) |
| `shared/protocol.ts` | section 10 |
| `server/src/world.ts` | room calls + roles, walk-driven join/leave, guarded timers, cap + waiting, ownership, `leave_room`, deafen/hand, knock rules, relay rule |
| `server/src/index.ts` | socket ids, pass socket to `handle` |
| `client/src/audio.ts`, `client/src/soundscape.ts` | shared context, audio graph, emitters, one-shots |
| `client/src/voice.ts` | eligibility rule, sendrecv transceivers, send rule, mic tokens, ownership, deafen, PTT, prefs, AFK, hand auto-lower |
| `client/src/net.ts` | new messages and private state, helpers (`roomCallOf`, `sameRoomCall`, `leaveRoom`, `setHand`, `setDeafen`, `claimVoice`, `voiceFocus`) |
| `client/src/sounds.ts` | join/leave/hand; use the shared context; optional output node |
| `client/src/App.tsx`, `client/src/styles.css` | panel, chips, popover, room list icons |
| `client/src/engine.ts` | bubbles, click-for-volume, tooltip, radio notes |
| `server/src/world.test.ts`, `shared/acoustics.test.ts`, root `package.json` | tests + `npm test` (`tsx --test`) |

## 12. Testing

`npm test` (node:test via tsx; fake timers with `mock.timers` for `setTimeout` and `Date`):
- **acoustics**: earshot 0 inside Coffee, `(32,13)` = 3, `(29,13)` beyond earshot; sound field goes through the
  Coffee door and not through walls; distance gain at d = 2, 4, 8, 10; occlusion true from `(31,13)` to `(31,9)`
  and false inside a room; listener `(32,14)`, source `(31,8)` → apparent centre `(32.5, 12.5)`; listener `(24,8)`,
  source `(27,8)` → apparent tile is a doorway tile in column 26; listener `(32,14)`, source `(32,4)` → clear, apparent `(32.5, 4.5)`;
  pan exactly 0 for a source straight above; pan sign left/right; out-of-range source → silent result; two
  Coffee members at `(28,4)` and `(37,9)` → override gain 1; listener zone gain applied to room voices only, not to
  the radio.
- **joining**: walking to a Coffee spot → member of `room:coffee`, presence `in_call`; bots never
  join.
- **walking out** → listener → removed when stepping off the last near tile; standing just outside within earshot
  → removed on arrival; a mid-walk redirect uses the new move's `startedAt`.
- **crossing**: `(24,8) → (36,13)` (assert the computed path enters Coffee) → listener only while walking; with no
  members nobody becomes a listener.
- **last member** walking out → call deleted, no listener phase; a waiter is promoted first if there is one.
- **knock calls**: walking into Coffee from a knock call ends it; a passer-by in a knock call stays out.
- **cap**: the 13th human is not joined, gets `voice_wait`, and is joined when a member leaves; a new walk clears it.
- **leave_room** walks to the home desk / Lobby and leaves; `end_call` in a room call does the same.
- **knocks**: all three blocks, rechecked at arrival and accept; becoming a member closes pending knocks;
  `connectCall` never reuses a room call.
- **timers**: a stale listener timer does not hang up a later call (leave, then join a knock call, advance time).
- **relay/ownership**: member↔listener relayed, listener↔listener not; `rtc` goes to the owner socket only; newest
  socket owns; ownership passes on close; `voice_claim`; non-owner `mute`/`hand`/`speaking` ignored; hand cleared on
  demotion.

Also `npm run typecheck` and `npm run build -w client`.

Browser (Playwright Chromium, and Firefox if installed, with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, dev server,
`?as=A` / `?as=B` / `?as=C`): A and B walk into Coffee and connect (non-zero received audio level); mute, deafen,
hand, volume and PTT change state on both sides; C walking through Coffee shows "Passing Coffee", hears with
rising then falling gain (`__soundscape.levels()`), and drops out; the radio's gain rises as C
approaches and pan flips sides as C walks past; Leave walks out. Safari is checked by hand on the `andr` instance (two MacBooks). Then try it with real people.

## 13. Implementation steps (for executors)

1. **Server + shared** (`shared/*`, `scripts/gen-map.mjs` + `shared/tilemap.json`, `server/src/*`, tests, root
   `package.json`): sections 1–4, 7 (radio object + `MapObject.sound`, shared radio volume), 10, the pure model of
   section 6, tests above. Client must still typecheck.
2. **Client** (`client/src/*`, `client/src/styles.css`, `scripts/gen-assets.mjs` + assets): sections 5, 6 (graph),
   7 (client part, radio/note frames), 8, 9.
