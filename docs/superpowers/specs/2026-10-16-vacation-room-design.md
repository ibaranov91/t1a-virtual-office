# Vacation: a beach and mountains for people who are away — design

Owner: Andrii Butko · 2026-10-16 · status: v2, after a Codex spec review; product decisions made with Andrii in
brainstorming, the idea approved by Ivan. Built in one pass: everything below ships together.

**Shipped** in #109 (the shared Travel&Day-off calendar: #116).

## Goal

A new outdoor wing south of the Garden: **mountains** in the west, a **beach** with the sea along the bottom.
When someone is on vacation according to their **Google Calendar**, their avatar lives there: it sunbathes, gets a
cocktail, swims, climbs to the summit, fishes off the pier and swings in a hammock, in a loop of its own. Everyone
can see at a glance who is away and when they're back.

- The wing is part of the office: on the overview, walkable for everyone, its props are edit-mode furniture.
- Poses come from the place, not the person: anyone standing in the water swims, anyone on the trail climbs.
  Vacationers just do it by themselves.
- Only "on vacation" and the return date ever leave the server. Event titles never do.

## Decisions and why

| decision | why |
| --- | --- |
| Google Calendar is the only source: out-of-office events, plus all-day "vacation" events on calendars people connected | Andrii's call. OOO is the calendar's own notion of "away" with real dates; Slack status would need a new app installed by an admin |
| Colleagues who didn't connect their calendar are read through someone else's grant, out-of-office type only | Google returns status events to anyone with free/busy access (the t1a.com default). That covers everyone without asking 30 people to connect, and reveals no more than Calendar already shows them |
| Only the current vacation is public, as an end time and a return day | Andrii's call; "away until Mon 27" is what Slack's OOO status and Calendar's auto-decline show too |
| Online vacationers stay busy: knocks go to Later | Same as a calendar meeting: they're reachable by message, not by a tap on the shoulder |
| Opening the app on vacation wakes you up on the beach; closing it walks you back there | Andrii's call; the avatar is wherever you left it, as in Gather |
| The wing grows the office south, not east | On laptop screens the overview is width-limited, so extra rows barely shrink it |
| Terrain is generated; props are furniture | Terrain defines where swimming and climbing happen; loungers, palms and the bar should be arrangeable like the rest of the office |
| `vacation` is saved in `state.json` | A Google hiccup right after a deploy shouldn't empty the beach or let a vacationer walk in through the Lobby |
| No beach sound, no manual toggle, no upcoming list, no "back early" override | Andrii's calls in brainstorming |

## 1. The map (`scripts/gen-map.mjs`)

**Keep the building where it is.** Today every outer structure runs to `OFFICE_H`:
- the outer walls and the base wood floor;
- the Orangery|Garden divider (line ~146);
- the hedge (`OFFICE_H - 1`, line ~148);
- the Library and Book Club walls (lines ~149, ~153).

Add a constant `BUILDING_H = 34` and use it for all of these, so the building's bottom edge stays on row 33.
Then `OFFICE_H = 48` (rows 34–47 are the 14-row wing, row 47 the bottom edge). `dungeonRect.y = OFFICE_H + 2` moves the
dungeon down untouched. `MAP.office` (camera, overview, edit mode) grows with `OFFICE_H`. The wing is generated in
its own block after the building, with its own walls, floors and edges.

The beach and sea are smaller and calmer after Andrii's feedback. Mountains at x 1–24, rows 34–43 stay unchanged.

**Way in.** A 2-tile gate in the hedge, row 33, at x 50–51. Both tiles are `door_floor`; check that Garden row 32
is free there and pick the nearest free pair if not. The Orangery (x 0–15) and the Library/Book Club (x 64–84)
keep their walls on row 33. There is no other entrance.

**Rooms** (appended to `rooms`, data only):

| id | name | type | rect | knock | label |
| --- | --- | --- | --- | --- | --- |
| `mountains` | Mountains | `vacation` | x 1–24, y 34–46 | allow | `mountains · knock to talk` |
| `beach` | Beach | `vacation` | x 25–83, y 34–46 | allow | `beach · knock to talk` |

- There is no wall between the two rooms.
- Capacity is 30 each, and there is no open voice.
- The existing room rects still end at row 48; playable terrain ends at row 46 and row 47 is blocking sea.
- Each room gets 4–6 `stand(…)` spots: on the sand, at the trail foot, on the summit. Bots and `startBots` pick
  `room.spots` and must never see an empty list.

**Terrain** is generated tiles, never furniture. Floor tiles are walkable; walls-layer tiles block.

| terrain | layer | where |
| --- | --- | --- |
| `sand_0..2`, `sand_wet_0..2` | floor | beach sand rows 34–43; wet sand on row 44 |
| `water_shallow_0..2` | floor (walkable) | row 45, along the whole wing |
| `water_deep_0..2` | floor (walkable) | row 46 |
| `sea` | walls (blocks) | row 47 (the bottom edge) and the wing's outer corners: open sea |
| `rock`, `cliff` | walls (blocks) | the mountain massif |
| `trail_0..1` | floor | a switchback from the foot of the mountains (next to the beach) up to the summit, the only way up |
| `snow_0..1` | floor | the summit plateau (≈3×2) |
| `pier` | floor | x 62–63, rows 43–46; fishing ends (62,46) and (63,46) |

The wing's west and east edges are cliff or sea, not office walls.

**Room rects contain terrain walls (rock), by design.** `server/src/acoustics.test.ts` ("room rectangles contain
no wall tiles") exempts rooms of type `vacation`, with a comment. Nothing in the wing makes sound, and knock calls
don't depend on it.

**Map data for the loop.** gen-map writes a `vacation` block into `tilemap.json`, typed as `TileMap.vacation?` in
`shared/map.ts`:

```ts
vacation?: {
  gate: Tile;          // just inside the wing below the hedge gate: where vacationers appear and leave
  trailFoot: Tile;     // bottom of the trail
  summit: Tile;        // on the snow, beside the flag
  pierEnds: Tile[];    // 2 fishing spots at the end of the pier (they face down)
  swim: Tile[];        // x 28,33,38,43,48,53,58,68,73,78 on row 46
}
```

**Props.** Normal `obj(…)` calls **after the last existing `obj(…)` in the file** (currently the Book Club
block), so existing ids stay put. Admins can move them.

- Palms ×4 and pines ×4. Pines stand on the slopes, on walkable tiles off the trail.
- `lounger` ×4, each 2×1, `lie: true`, `dir: 'down'`, with an `umbrella` (1×1 decor) just above it.
- Palms: (29,35), (35,35) around the hammock, plus (57,35), (80,35).
- Loungers: x 30,46,62,78 at y 40; umbrellas at the same x, y 39.
- A `hammock`, 3×1, `lie: true`, `dir: 'down'`, between two palms.
- `beach_bar`, 3×1, `use: { kind: 'take', items: cocktail 🍹, coconut 🥥, icecream 🍦 }`.
- `vacation_sign`, 1×1 next to the gate, `use: { kind: 'vacations' }` (§5). It goes into `KEEP_TYPES`.
- `summit_flag`, decor on the summit; it blocks its own tile.
- Decor: a sandcastle, shells, a beach ball.

**New `lie` seats** (`shared/map.ts`). `sit` objects make every footprint tile a seat (`mapIndex`) and push
spots for the top row (`applyLayout`). A sofa works because its row faces the room. For a lounger or hammock that
would give 2–3 seats, with entries inside the footprint. So add `MapObject.lie?: boolean`:
- **One seat:** the top-row tile at `x = o.x + floor((o.w - 1) / 2)` (the lounger's left tile, the hammock's
  middle).
- **The rest of the footprint blocks** and is not a seat.
- **The entry** is the tile in front of the seat, by `dir`, as for sofas. `pathTo`'s `front()` already works from
  the seat.
- **Changes:** `mapIndex` indexes only the seat tile; `applyLayout` pushes exactly one spot; `layoutProblem`'s
  seat reachability covers it; the client's "sofa seat you clicked" picker maps any click on the object to its one
  seat.

**Atlas** (`scripts/map-atlas.mjs`). New terrain glyphs in the plans: `~` water, `^` rock, `=` pier,
`*` trail/snow. Where a glyph is already taken, pick another and keep the legend in sync. `npm run gen` regenerates
`tilemap.json`, `docs/MAP.md` and the art, and gen-map's own checks must pass.

**Art** (`scripts/gen-assets.mjs`): a new `// ---------- vacation: beach and mountains` block at the end, before the
atlas packer, with **no `rnd()` calls** (fixed pixels or a local hash). It draws:
- terrain: warm sand, wet sand, turquoise shallow and deeper blue water, sea; grey rock and cliff faces with
  highlights; a dusty trail; snow;
- props: pier planks, palm, pine, lounger, striped umbrella, hammock, a beach bar with a straw roof, the sign, the
  summit flag, a sandcastle, shells, a beach ball;
- overlays: a `suitcase` frame (§3), a `backpack` frame, a fishing rod with a float.

**Water animation** is client-side and cheap. In `engine.ts`, for on-screen water tiles only, draw thin foam lines
along the waterline and a few sparkles that shift every ~400 ms (deterministic by tile hash and time). It runs within
the existing 30/60 fps loop and must not mark the loop "busy" by itself.

## 2. Who is on vacation (`server/src/vacations.ts`)

A `Vacations` class modelled on `Meetings`. Calendar reading runs only when `googleEnabled`, i.e. on prod. The dev
sources below run only when Google is off.

**Polling.** Every 10 min, the first time 5 s after start, and again 5 s after anyone finishes Connect Google with
the calendar scope. Only one poll runs at a time, like `Meetings.poll`.

**What is read.** For every non-bot user with an `email`, over the window `now − 1 day … now + 30 days`. Future
events are read only so back-to-back periods can be merged; they are never sent.

- **Own calendar** (the user's `google.scopes` includes `CALENDAR_SCOPE`):
  `GET calendars/primary/events?eventTypes=outOfOffice&eventTypes=default&singleEvents=true&timeMin&timeMax&maxResults=250&fields=nextPageToken,timeZone,items(status,eventType,summary,start,end,attendees(self,responseStatus))`.
  - Keep `outOfOffice` items.
  - Keep **all-day** `default` items (`start.date`) whose summary matches
    `/отпуск|vacation|holiday|\bpto\b|\booo\b|out of office|urlop|відпустк|time\s*off|day[\s-]*off/i`.
  - Skip cancelled items, ones the user declined, and summaries matching `/business\s*trip|travel/i`.
- **Everyone else:**
  `GET calendars/<email>/events?eventTypes=outOfOffice&singleEvents=true&timeMin&timeMax&maxResults=250&fields=nextPageToken,timeZone,items(status,eventType,start,end)`,
  using a **reader**. The reader is the first `DECK_ADMINS` user (by email) with the calendar scope, else any user
  with it. A reader's own calendar is read as "own".
- **Pagination:** follow `nextPageToken`, up to 5 pages, before using a person's result.
- **403 or 404 for a calendar:** no data for that person. Log once per person per process.
- **`invalid_grant` for an own-calendar owner:** drop `u.google` (only if it's still the same grant object),
  `forgetAccess`, send `me`, exactly as `Meetings.poll`.
- **`invalid_grant` for a reader:** do the same for the reader, then retry that person with the next reader
  candidate in the same poll.
- **Any other error:** keep that person's last known result.

`google.ts` gets
`listAbsences(tokenOwnerId: string, link: GoogleLink, calendarId: 'primary' | string, own: boolean): Promise<{ timeZone: string; items: Absence[] }>`.
`Absence` is `{ start: number; end: number; allDay?: { endDate: string } }`. Timed items carry epoch ms. All-day
items are converted to epoch ms at midnight in the calendar's `timeZone` and keep their exclusive end date. The
keyword match happens inside `listAbsences`; summaries are never returned or stored. The access-token cache stays
keyed by `tokenOwnerId`.

**Team calendar.** Also read Travel&Day-off (`t1a.com_aoas0mu6l5d0hmrdhabm01rc0k@group.calendar.google.com`,
America/New_York) once per poll through the same admin-first readers. `VACATION_TEAM_CALENDAR` overrides the id;
an empty string disables it. On 403/404 or `invalid_grant`, try the next reader (drop revoked grants as above).
If all readers fail, keep the last successful team result and log once per process. Keep non-cancelled time-off,
vacation, day-off, holiday, PTO, отпуск, urlop and відпустк events, including declined attendees and transparent events.
Business Trip and travel do not count: those colleagues are working on the road. Match attendee emails or the creator
(excluding `t1a.api@t1a.com` and the calendar itself), else the name before the first " - " against the Deck name or
email local part with dots/underscores as spaces; names use NFD, stripped combining marks, lowercase and collapsed
whitespace. Merge matching items with the person's existing absences, even when only the team calendar is accessible.
Team all-day dates retain their exclusive end date and use the successful own/reader calendar timezone, else the
person's shared `tz`, else Europe/Warsaw. Summaries stay inside `listTeamAbsences`.

**Turning absences into a vacation** happens in pure `shared/vacation.ts`. Intervals are half-open
`[start, end)`, and "working time" means Mon–Fri 09:00–17:00 in the calendar's `timeZone`.

1. **Short items don't count.** Timed `outOfOffice` items shorter than **6 h** are dropped: a dentist visit isn't
   a vacation.
2. **Merge.** Sort by start. Merge an item into the previous one when the gap between them contains no working
   time; this also covers overlapping and touching items. Examples:
   - Fri 18:00 → Mon 09:00 merges;
   - an all-day Fri and an all-day Mon merge;
   - Mon and Wed with a working Tuesday between them don't.
3. **Current vacation.** The merged interval that contains `now`. `until` is its end; the end of the last item
   decides `back`.
4. **`back`** is a `YYYY-MM-DD` date, or `undefined`:
   - the last item is all-day → `back` = its exclusive end date, moved past Sat/Sun;
   - otherwise take `until` in the calendar's zone:
     - on a weekday inside 09:00–17:00 → `back` is `undefined` (the client shows a date and time);
     - otherwise → the first weekday whose 09:00 is at or after `until`.

**Public shape.** It is broadcast as `{ t: 'vacation', userId, vacation }` and is in `PublicUser` (so in `state`
snapshots):

```ts
vacation?: { until: number; back?: string } | null; // on vacation now, per their calendar
```

**Expiry doesn't wait for a poll.** A 15 s tick clears any `vacation` whose `until` has passed, then broadcasts.
A poll can extend or shorten it, or set it.

**Saving.** `vacation` is saved in `state.json` (`dump` → users). `load` drops a saved vacation whose `until` has
passed.

**Dev, test instances and `npm test` (Google off):**
- **Bots.** When bots are on, the last two bots are on vacation, one until now + 3 days and one until now + 9 days,
  renewed when they run out. The bot loop (`startBots`, including its "everyone online" reset at start) leaves them
  alone. While on vacation they are `presence: 'offline'`, exactly like a real vacationer. That way andr, var and
  iva show a live beach. `VACATION_BOTS=0` turns this off.
- **Named people.** `VACATION_FAKE="Kim:3,Lee:0.01"` puts the named people (case-insensitive) on vacation for that
  many days from server start, and picks up people who appear later. This is the test hook for human logins
  (`?as=Kim`). It is ignored when Google is on.

## 3. Avatars on the beach

**Who is on the map.** A shared helper `onMap(u) = u.presence !== 'offline' || !!u.vacation || u.door !== null`
(today an offline person never has a `door`) decides who is drawn. "On the beach" means offline with a vacation
and no `instance`. The server drives those people.

**States and transitions.** There is no new stored state: `presence`, `vacation` and `door` already say it all.

| from | event | what happens |
| --- | --- | --- |
| offline, hidden | vacation set by a poll or fake (not at boot) | put on `vacation.gate`, `door: 'arriving'` (carrying a suitcase), walk to the first activity, `door: null` on arrival |
| offline, saved with a vacation (boot) | server start | placed straight onto a random free activity spot or wing stand spot, with no parade |
| on the beach | vacation cleared (expiry or a poll) | `vacation` → `null` at once (public), `door: 'leaving'`, walk to the gate, 400 ms pause, `door: null` (now hidden) |
| on the beach, arriving or departing (offline, on the map) | opens a tab | **wakes in place:** the walk stops at the tile being entered (as in `stayAfterAll`), `door: null`, `presence: 'online'`, the loop releases them. No `comeIn` |
| online, any place | vacation set or cleared | only the 🌴 changes |
| online, last tab closes | grace (`thinking`) then leave | as today (knocks, call, instance, followers), but the walk goes to `vacation.gate` if `vacation` is set **when the walk starts**, else to `map.exit`. On arrival `door: null`, offline: on the beach if `vacation` is still set, otherwise hidden right there |
| leaving to the gate | reconnect | `stayAfterAll`, as today |

- **No path.** An arrival with no path is placed directly on its spot. A departure or leave with no path to the gate
  is hidden at once.
- **Following.** Following needs an online target (check `setFollowing`/`follow` and add the check if it's
  missing). The loop never walks anyone who follows or is followed: `startLeaving` already clears both directions.
- **The loop never moves** anyone online, anyone with an `instance`, or anyone mid-door.

**The loop** (`server/src/beach.ts`, wired from a `// ---------- vacation ----------` block in `world.ts`, ticking
once a second). Each walker has its own order of six activities, reshuffled each round from a hash of user id and
round number, so a crowd never moves in step:

| activity | what happens | stays |
| --- | --- | --- |
| lounger | walk to a free lounger seat and lie down | 60–120 s |
| bar | walk to the tile in front of the bar, pause 3 s, get a random item of the bar's `items` (`setHolding`, the usual hold), then go on to the next activity | — |
| swim | walk to the nearest `swim` tile, then 2–3 legs between `swim` tiles at most 12 apart, idling 8–15 s after each leg, then back onto the sand | — |
| mountain | walk to `trailFoot`, up to `summit` at **400 ms per tile**, stay 15–25 s, back down to `trailFoot` at 400 ms per tile | — |
| fishing | walk to a free `pierEnds` tile and face down | 45–90 s |
| hammock | walk to the hammock seat and lie down | 45–90 s |
| stroll (fallback) | walk to a random free sand tile and stand | 20–40 s |

**Spots and occupancy.**
- **Reserved, one walker at a time:** lounger and hammock seats, each `pierEnds` tile, the summit.
- **Not reserved, but never ended on an occupied tile** (`occupied()`): swim tiles, the trail, the bar's front tile.
- **On arrival:** if someone else (an online person) is standing there, the activity ends and the next one starts.
- **No spot available** (taken, or the furniture was removed) → skip the activity this round. If every activity is
  unavailable → stroll.
- **Only furniture inside the `beach`/`mountains` rects counts.** A lounger dragged into the Lobby is just
  furniture.
- **Layout changes.** Any layout change cancels every walker's plan and reservation; each starts its next activity.
  `stepAside` treats on-map offline people as present: it walks them aside with a broadcast instead of silently
  setting `tile = spawn`.
- **Shared filters.** `occupied()` and the creatures' `people`/`personTile` hooks use `onMap`. Animals may roam the
  wing.
- **Cancellation.** The loop's timers carry the walker's `walkSeq` and do nothing once it has changed. Leaving the
  beach (waking up, departing) releases that walker's reservation at once.

**Walk speed.** `world.walk(u, to, face?, now?, msPerTile?)`. When given, `msPerTile` replaces `walkMs(u.effects)`
everywhere in that call: the broadcast `ms`, `pathDuration`, arrival timers and callbacks.

**Knocks.**
- **Online vacationer:** they are busy with the **same precedence as a calendar meeting**. Add `to.vacation` to the
  chain that has `to.meeting` in `arrive`, with the reason "on vacation" ("`<name>` is on vacation — sent to
  Later"). Anything that beats a meeting today beats a vacation too: blocked rooms, a full call, a table you share
  while they're eating and open to talk. As with meetings, the person themself can still accept within the 1.4 s
  window.
- **Native app:** `client/src/native.ts` reports `busy` for a vacationer, so knocks only flap the icon.
- **Offline walkers** can't be knocked on, reacted to, followed or teleported to (the existing offline checks).
  Chat messages work as for anyone offline.

## 4. Drawing (client)

**Poses by place, for everyone.** `shared/beach.ts` gives
`terrainAt(map, x, y): 'sand' | 'shallow' | 'deep' | 'trail' | 'snow' | 'pier' | null` from the floor tile name.
The loop uses it too.

| where | pose |
| --- | --- |
| `shallow` | sprite clipped at the waist (bottom ~8 px hidden), a wavy waterline and a small ripple |
| `deep` | head and shoulders only, slow expanding ripple rings |
| `trail`, `snow` | a `backpack` overlay (from behind and the sides; straps from the front) |
| the `summit` tile, standing | a 2 px hop every 600 ms and a blinking 👋 above them |
| a `pierEnds` tile, standing, facing down | a rod with a line to a bobbing float; every ~25 s (deterministic per person and time) a 🐟 jumps out and back |
| a `lie` seat | lying: the sprite rotated 90° along the object, head at the seat end, no breathing bob |
| the hammock's seat | lying the same way, plus a ±1 px swing with a ~2 s period |

- **Items.** The cocktail, coconut and ice cream draw as held items, like coffee (icons from the bar's `items`).
- **Suitcase.** Anyone with `vacation` (or arriving or departing on the beach) draws `suitcase` instead of `bag`.

**Offline people on the map.** The rule: if it is about seeing or bumping into someone on the floor, use `onMap`;
if it is about interacting with a present person (knock, call, voice, follow, react, teleport), keep the offline
check. Audit every `presence === 'offline'` / `!== 'offline'` in `client/src` with that rule. Known sites:
- **Becomes `onMap`:**
  - `engine.ts` `visible()` (~621) and the tile-occupancy sets (~247, ~642);
  - `net.ts` ~191, ~230, ~313 where they mean "standing on the floor".
- **Stays as is, reviewed:**
  - `engine.ts` ~232 (focus), ~909 (dungeon);
  - `net.ts` ~416;
  - `App.tsx` ~1176, ~1200, ~1238, ~1374.
- **The action wheel** (`App.tsx` ~1459 returns null for offline people). For an on-map offline person, show the
  wheel with **Message** only.
- **GM panel selection** (~809): leave offline people out, as today.

## 5. Seeing who's away

- **Nameplate:** 🌴 before the name of anyone with `vacation`.
- **Tooltip** (hovering a person): `Maya · on vacation · back Mon 27 Oct`.
  - `back` is a date, formatted as a date with no time-zone conversion.
  - Without `back`: `back Wed 22 Oct, 14:00`, from `until` in the viewer's zone.
  - The viewer's locale either way.
- **People list:**
  - A group **On vacation** (count) lists every vacationer, online or not, sorted by `until`, each with `back …`
    and their presence dot.
  - Clicking a name does what it does elsewhere in the list (walk over / show me).
  - Vacationers are listed **only** there, not in a room group or under Offline.
  - The group is hidden when empty.
  - A Discord-style sidebar is being built in parallel; whatever groups people there gets this group too.
- **The sign by the gate** (`use.kind: 'vacations'`):
  - Shared wiring: add the kind to `ObjectUse` and `USE_KINDS` with no flags (`App.tsx` `e.onPick` opens a panel),
    plus a hover text: `On vacation · N away now`, or `On vacation · everyone's at work`.
  - The panel (`VacationPanel`, styled like the meetings board, `COMPACT`-friendly) lists the same people as the
    group. Clicking a name focuses the camera (`engine.focusUser`).
  - With nobody away it says "Everyone's at work 🏢".
- **Overview:** room tags for Beach and Mountains, like any room.

## 6. Edit mode and saved layouts

- **Props** are ordinary layout objects. The loop reads spots from the **current** layout (lie seats via `seatAt`,
  the bar's front tile via `besideObject`), limited to the wing's rects.
- **Terrain spots** in `map.vacation` are fixed.
- **`layoutProblem`** also refuses a layout that cuts `vacation.gate` off from `trailFoot`, `summit`, every
  `pierEnds` tile, or every `swim` tile. Use a reachability flood from the gate, like the one from spawn. The
  client ghost runs the same check.
- **Migrating saved layouts** (prod has one):
  - `STATE_VERSION` is 4 (version 3 added the wing; version 2 added the Music TV).
  - In `load`, when `data.version < 3`, `migrateBeach(saved, base, map)` (`shared/map.ts`) appends the base
    layout's objects that lie in the wing and keeps `uniqueIds`; a saved layout that already has furniture in the
    wing is left as it is. It runs **once**, next to
    `migrateBookClub`/`migrateLibrary`, before `withNewFixtures`.
  - After the `< 3` step, when `version < 4`, `resetBeach(saved, base, map)` performs a one-time
    reset: drop saved objects inside the beach/mountains rects, append the base wing objects, and keep ids unique.
    Office objects and rugs remain; version-4 wing edits are preserved.
  - Saved coordinates are absolute and the building doesn't move, so nothing else changes.
  - Saved user tiles are always office tiles (the dump moves underground people to the dungeon exit), and `load`'s existing walkability/seat check moves any invalid tile to spawn after the wing shrinks.
- **Names and catalog.** `objectName` gets the new types (Palm, Pine, Lounger, Umbrella, Hammock, Beach bar, Sign,
  Flag, Sandcastle, Shells, Beach ball). One of each new type is in the edit-mode catalog, like the others.
- **Merging with parallel branches.** Object ids are positional. When main gains new `obj(…)` lines first, merge
  the source order (theirs, then ours), `npm run gen`, and re-run the layout tests.

## 7. Tests and checks

**`server/src/vacations.test.ts`** (`npm test` runs `server/src/*.test.ts` and `client/src/*.test.ts`; the pure
`shared/vacation.ts` is tested from here):
- **Rules:**
  - the 6 h cutoff;
  - merging over a weekend (Fri 18:00 → Mon 09:00), touching and overlapping items, and no merge across a working
    Tuesday;
  - all-day keyword items with exclusive end dates in `Europe/Warsaw` and `Asia/Tokyo`;
  - `back` for an all-day end, Fri 18:00, Wed 14:00 (undefined) and Wed 07:00.
- **Polling with a stubbed `fetch`:**
  - own vs reader path, and admin-first reader choice;
  - pagination;
  - 403 → no data, logged once;
  - `invalid_grant` on a reader → its grant is dropped and the next reader is used in the same poll;
  - other errors → the last result is kept;
  - summaries never appear in any output.
- **Expiry and saving:** cleared at `until` without a poll; saved and loaded; expired ones dropped on load.

**`server/src/beach.test.ts`** drives `World` directly:
- an arrival from the gate;
- a boot with a saved vacation: placed with no parade;
- the loop over several rounds: never two walkers on one reserved spot, and the climb at 400 ms/tile;
- stroll when everything is taken;
- a layout change: plans cancelled, nobody silently teleported;
- departure at expiry: public `vacation` null at once, hidden after the gate;
- opening a tab on the beach, mid-arrival and mid-departure: wakes in place, no `comeIn`;
- closing it: walks to the gate and the loop resumes;
- vacation ending during the walk to the gate: hidden there;
- a knock on an online vacationer → Later with "on vacation", and a knock on a beach walker refused;
- `toPublic` gains only `vacation`;
- the dev vacation bots, and `VACATION_FAKE`;
- `lie` seats: one seat per lounger and hammock, reachable;
- `migrateBeach` runs once by version (< 3);
- `layoutProblem` refuses blocking the trail or the pier.

**Existing tests stay green.** Dungeon coordinates come from `map.dungeon`, and the acoustics invariant exempts
`vacation` rooms.

**Before handing over:** `npm run gen`, `npm test`, `npm run typecheck`, `npm run build -w client`.

**Silent headless check** (Playwright Chromium, `--mute-audio`, never the app pane), on a dev server with bots and
`VACATION_FAKE="Kim:3"` on free ports:
- the overview shows the wing;
- the two vacation bots go through the activities, with screenshots of the swim, lounger, summit and pier poses;
- the 🌴 nameplate and tooltip, the People group, the sign panel;
- `?as=Kim` once (so Kim exists), close it, and Kim arrives at the gate on the next poll;
- open `?as=Kim`: wakes on the beach;
- close it: walks back to the gate and the loop resumes;
- a knock from another tab goes to Later with "on vacation".

## Files

| file | change |
| --- | --- |
| `scripts/gen-map.mjs` | `BUILDING_H`, `OFFICE_H` 52, hedge gate, rooms and stand spots, terrain, `vacation` block, props at the end |
| `scripts/gen-assets.mjs`, `scripts/map-atlas.mjs` | the art block; the atlas glyphs |
| `shared/map.ts` | `TileMap.vacation`, `lie` seats, `'vacations'` use kind, `objectName`, `layoutProblem` reach, `migrateBeach` |
| `shared/beach.ts`, `shared/vacation.ts` | `terrainAt`, `onMap`; the interval and `back` rules |
| `shared/protocol.ts` | `PublicUser.vacation`, `{ t: 'vacation' }` |
| `server/src/google.ts` | `listAbsences` |
| `server/src/vacations.ts`, `server/src/beach.ts` | the poller and dev sources; the loop |
| `server/src/world.ts` | the vacation block: set/clear and expiry, connect/leave, knock reason, `occupied`, `stepAside`, creature hooks, `walk` ms, save/load, migration |
| `server/src/bots.ts` | the two vacation bots |
| `server/src/acoustics.test.ts` | exempt `vacation` rooms |
| `client/src/net.ts` | `case 'vacation'`, panel open/close, the `onMap` filters |
| `client/src/engine.ts` | visibility, poses, suitcase, water animation, the 🌴 nameplate, tooltips |
| `client/src/App.tsx`, `client/src/styles.css` | the People group, `VacationPanel`, the sign click, the Message-only wheel |
| `client/src/native.ts` | busy while on vacation |
| `AGENTS.md`, `docs/ADDING-A-FEATURE.md` | a "Vacation" paragraph under "How things work"; `lie` seats in the room/sprite notes |
