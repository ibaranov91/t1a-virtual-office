# Sidebar: rooms as channels, people, and your own voice strip

Date: 2026-10-16 · Owner: Andrii Butko · Status: approved design, ready for implementation

## Why

Today the right-side "People" panel (`RoomList` in `client/src/App.tsx`) floats over the floor and shows every room as
an equal line, empty or not. You only learn where you can talk from a grey label ("open voice"), people have no
avatar, call state is a tail of emoji after the name, and nobody can see who is speaking. Your own mic, deafen and
settings sit in the top bar, your status pill top-left, and the call and room-voice chips float over the map.
Per-person volume hides behind the ⋯ menu.

The new sidebar works like Discord's: rooms are channels grouped by how you talk there, people sit under the room
they stand in, one click on a person opens their card (volume included), and your own voice controls live at the
bottom of the panel.

## Decisions (made with Andrii)

1. **One tree with a view switch**: `Rooms` (groups → rooms → people inside) and `People` (everyone, grouped by
   state). No second column.
2. **Docked on the left, full height under the top bar; the floor shrinks** instead of being covered.
3. **Groups come from room rules** (data, so a new room lands in the right group by itself):
   *Voice* (`rules.voice === 'open'`: Coffee, Music, Arcade, Book Club), *Knock* (`rules.knock === 'allow'` and not open voice:
   Lobby, Co-working, Desks, Orangery, Garden, Admin, Berghain, Terrace), *Quiet* (`knock` is `'disabled'` or
   `'later'`: Focus, Meeting, Studio, Library). Live groups, shown only when someone is in them: *In meetings*,
   *Underground*, *Hallway*. *Offline* last, collapsed by default.
4. **A click on a room opens the room menu**: the go action and the room's things (jukebox, records…). No "peek".
5. **A click on a person opens the person card** (Discord profile popout): who, where, what, their time, actions,
   voice volume and Mute for me. Right-click does the same.
6. **Collapse to a rail** (56 px): group counts, the people in your call, mic, deafen, hang up, settings.
7. **Phones: a bottom sheet** from the dock's 👥 button, half or full height; the person card and room menu open as
   their own bottom sheet above it with "← Back".
8. **Knock calls are a mark on the person's row** ("📞 with Leo"); people stay under the room they stand in.
9. The status pill and the voice buttons leave the top bar (desktop) for the sidebar's bottom card. The call and
   room-voice chips stay on the floor on every layout for quick mic and headphones control; the sidebar's voice
   section is the compact status. "People" leaves the top bar's ⋯ menu. Nothing else in the top bar changes.
10. **No server or protocol change.** Everything shown is already on the client.

UI copy stays English like the rest of the app (strings below are exact).

## Layout

```
┌ topbar (unchanged except: no IdentityPill / VoiceIcons / "People" on desktop) ─────────────┐
├ aside.sidebar ──────┬ .stage (canvas, chips, panels, zoom… exactly as today) ──────────────┤
│ [Rooms|People]  «   │                                                                     │
│ 🔍 Find a person…   │                                                                     │
│ ▾ VOICE · walk in…  │                                                                     │
│   🔊 Coffee     2   │                                                                     │
│     (◎) Maya        │                                                                     │
│ ▾ KNOCK · knock to… │                                                                     │
│   # Co-working  3   │                                                                     │
│ …                   │                                                                     │
├─────────────────────┤                                                                     │
│ voice block         │                                                                     │
│ (●) Andrii  🎙🎧✋⚙ │                                                                     │
└─────────────────────┴─────────────────────────────────────────────────────────────────────┘
```

- `Office` renders `TopBar`, then a new `div.workspace` (`display:flex; flex:1; min-height:0; position:relative`)
  holding `<Sidebar>` and the existing `div.stage` (now `flex:1; min-width:0`). The engine already re-fits on resize
  (`ResizeObserver` in `engine.ts`).
- **Modes** (pick by media query, re-evaluated live with a `matchMedia` listener):
  - `compact` = the existing `COMPACT` query (`(max-width: 560px), (max-height: 500px)`): no in-flow sidebar; a bottom
    sheet (below).
  - `narrow` = not compact and `(max-width: 899px)` (the Mac popover, small windows): the rail is in flow and the
    page always starts on the rail; expanding shows the full panel **over** the stage (absolute, `left:0; top:0;
    bottom:0; z-index:8`, a right border and shadow) and Esc, the « button or a pointerdown on the stage closes it
    back to the rail. The narrow expanded state is never persisted.
  - `wide` = everything else: the panel is in flow; collapsed means the rail.
- **Width**: 264 px default, drag the 6 px handle on the panel's right edge (pointer capture), clamped 220–380,
  double-click the handle resets to 264. Saved on pointerup.
- **Persistence**: `localStorage['deck.sidebar']` = `{ width: number, collapsed: boolean, view: 'rooms' | 'people',
  closed: string[] }` (`closed` = collapsed group ids, default `['offline']`). Every read and write in try/catch;
  bad or missing values fall back to defaults.
- The old `showRooms` state (`useState(() => window.innerWidth > 900)`) goes away for desktop; on compact it becomes
  "sheet open" and starts closed.

## Rooms view

**Header**: a two-segment toggle `Rooms` | `People` (`role="tablist"`, the segments `role="tab"`, `aria-selected`),
then the collapse button `chevron-left` (`aria-label="Collapse sidebar"`; hidden on compact, where the sheet has `close`).

**Search**: an input under the header, placeholder `Find a person or room`, `type="search"`. Case-insensitive
substring on person names and room names. In Rooms view a room stays if its name matches (then with all its people,
or as its empty line) or any of its people match (then only the matching people); a group is hidden only when no row
of it is left to show (a matching empty room keeps its group); a collapsed group that has matches shows them while a
query is set. In People view a person stays when their name or their shown place matches. Esc clears a non-empty query, and blurs the input when it is already empty.
No global shortcut (the instruments own the keyboard).

**Group header**: chevron, label in small caps, the group's hint, and the number of online people in the group on the
right. Click (or Enter/Space) toggles collapse (`aria-expanded`). Labels and hints:

| id | label | hint |
|---|---|---|
| `voice` | Voice | walk in to talk |
| `knock` | Knock | knock to talk |
| `quiet` | Quiet | do not disturb |
| `meetings` | In meetings | meetings and private rooms |
| `underground` | Underground | somewhere underground |
| `hall` | Hallway | passing through |
| `offline` | Offline | — (just the count) |

Group order: voice, knock, quiet, meetings, underground, hall, offline. Rooms keep `MAP.rooms` order inside a group.
Live groups (`meetings`, `underground`, `hall`) and `offline` hold people directly (no room rows) and are hidden when
empty.

**Room row** (a `button`, the whole row):
- Shared `Icon` by group: voice `volume`, knock text `#`, quiet `moon`; admins-only rooms use `lock`. Row icons are 14 px; rail icons are 20 px.
- name; the subtitle on the same line, muted and ellipsized: for a room with a jukebox, `♪ <track title>` while
  playing or `paused`; for the room of a live office-scope presentation, `📽 live` (a meeting room's own show stays inside it); otherwise nothing.
- count on the right: the number of online people in it outside any instance. Hidden when 0. No capacity: main
  dropped the `n/capacity` count from the people list (it was never enforced).
- your room gets the selected background (`--panel2`) and the accent name color.
- an empty room is one dimmed line (muted text); an occupied room lists its people under it, indented.
- `title`: `<name> · <rules.label>`.
- click or right-click (preventDefault) opens the room menu anchored to the row.

**Person row**: a non-interactive row (`div`) holding sibling buttons — the main one (avatar, name, second line)
opens the card; the unread badge is its own button. Never a button inside a button. Avatar 22 px (head of their sprite, see Avatar), the presence dot on it, the speaking
ring around it while they talk. Name (you: `<name> (you)`, accent color). Second line (muted, one line, ellipsized)
from `activityLine` below. Right side, in this order and only when true: mic off (`mic` off, red) when in a call and
muted; deafened (`headphones` off, red) when in a call and deafened; hand `hand` when `u.hand` and in a room call; game `🕹` /
`👀`; the instrument they play (today's `instrumentIcon(store, u.id)`, independent of the second line, so it shows
during a call too); the unread badge `message` + count (the sibling button: opens that chat); your local volume when it is
not 100% (`60%`, muted text) or `volume` off when you muted them. Offline rows are dimmed and show only the name and the
unread badge (no second line, no other marks). Order inside a room or group: you first, then by name (`localeCompare`), never by activity
(rows must not jump).

**`activityLine(u)`** — the first match, then ` · ` + status text when there is one and the match wasn't the status:
1. `underground(u)` → `somewhere underground` (and nothing else: no status)
2. `u.door`: `arriving` → `just arrived`, `thinking` → `packing up…`, `leaving` → `heading out`
3. `u.meeting` → `📅 in a meeting until <store.clock(u.meeting)>`
4. a knock call (`u.callId` and not a room call) → `📞 with <store.names(callPeers(u))>`
5. `u.game` → `🕹 playing Deck Park` (player) / `👀 watching Deck Park` (spectator)
6. `u.reading` → `📖 reading`
7. `u.eating` → `🍽 having lunch` + (`u.eating.open` ? ` · open to talk` : '')
8. playing an instrument (`store.instruments[objectId] === u.id`) → `<INSTRUMENTS[kind].icon> playing <INSTRUMENTS[kind].name>`
9. an audible Lofi TV (`u.listening === 'lofi'`) → `🎧 listening to Lofi Girl` (like Discord's "Listening to")
10. presence `away` → `away`
11. nothing matched → the status text alone, or empty.

So `Tomas` away with a status reads `away · debugging a flaky pipeline`; `Andrii` in a knock call reads `📞 with Ines`.

**Presence dot colors**: reuse `PRESENCE_COLOR` (move it into the sidebar model and import it in App.tsx):
online `#7cc87c`, away `#e0b050`, in_call `#d86a5a`, offline `#666`.

## People view

Same header and search. Groups: `In voice` (online people with a `callId`), `Online` (presence online or in_call,
no call), `Away`, `Offline` (collapsed by default, shares the `offline` collapse id). Same person rows; the second line
is `<place> · <activityLine>` where place is the room name, `In a meeting room` (an instance that isn't the dungeon:
a calendar meeting or a private room),
`Underground` or `Hallway`. Order: you first, then by name. Group ids for collapse: `p-voice`, `p-online`, `p-away`,
`offline`.

## Room menu

A small popover anchored beside the row (desktop: its left edge 8 px right of the sidebar, top = row top, clamped to
the viewport, the same clamp as today's `PersonMenu`), `role="menu"`. Esc and a pointerdown outside close it and give
focus back to the row.

- Header: room name; under it `<rules.label>` and ` · <n> here` when someone is in it.
- First item, the go action:
  - voice room → `Walk in and talk`; other rooms → `Walk here`;
  - disabled with the reason as its visible second line, first match wins: you're underground →
    `Find the way out first`; you're in a meeting's room (`me.instance`, not the dungeon) →
    `Leave the meeting room first`; you're already in it → `You're here`; admins-only room and not `store.sysadmin` →
    `Admins only`;
  - runs `engine.walkToRoom(room.id)`.
- Then the room's things, one item each (dedupe by kind; jukeboxes are per object), from `roomThings(MAP, room)`:

| use.kind | label | action |
|---|---|---|
| `jukebox` | `<label, first letter upper>: now playing` (`Jukebox: now playing`, `DJ booth: now playing`) | `store.openJukebox(o.id)` |
| `youtube` | `TV: <label>` (Music's Lofi Girl TV; its room is `use.room`) | opens `LofiTV`, like a click on the TV |
| `records` | `Arcade records` | `store.openRecords()` |
| `meetings` | `Meetings on now` | `store.openMeetings()` |
| `library` | `Library shelf` | `store.openLibrary()` |
| `clock` | `Our time zones` | `store.openClock()` |
| `achievements` | `Achievements board` | `store.openAchievements()` |
| `calendar` | `Your calendar` | `store.openCalendar()` |
| `link` | `Open the <label>` | `store.openLink(o.use)` |

  An object belongs to the first room found at `(x, y)`, then `(x, y + h)`, then `(x, y + h + 1)` (wall objects sit
  on the wall row above their room). Every item closes the menu first (see "Closing after an action"). Today that gives Music → jukebox and its TV; Berghain → DJ booth; Arcade → records;
  Co-working → meetings board, the three clocks (one item), calendar; Coffee → calendar; Lobby → achievements board,
  vault; Library → shelf. `presentation`, `arcade`, `instrument`, `dance`, `take`, `toggle`, `toilet`, `dealer`,
  `bell` are not listed (they need you there).

## Person card

Replaces `PersonMenu`. Opened from a person row (anchored like the room menu), from the rail's call avatars, and from
the action wheel's existing `Volume` item (at the wheel's point, as today). Same Esc/outside-click/focus-return
behavior as `PersonMenu`. `role="dialog"`, `aria-label="<name>"`.

- **Header**: avatar 48 px with dot and speaking ring; name; line 1: `<Online|Away|In a call|Offline> · <place>`
  (place as in People view); line 2 when they share a zone (`u.tz`): `<hh:mm> their time`.
- **Activity**: `activityLine(u)` without truncation (wraps), when not empty.
- **Voice**, when they're in a call: `In <room> voice` (room call) or `On a call with <names>` (knock call), plus
  ` · mic off` / ` · deafened` when true.
- **Actions** (2-column grid of buttons):
  - `Knock` → `store.requestKnock(u.id)`; disabled when `store.knockReason(u)` is set;
  - `Message` → `store.openChat(u.id)` (works offline too);
  - `Walk over` → `engine.walkToUser(u.id)`; disabled, first match wins: offline → `Offline`;
    `store.dungeonReason(u)`; you're in a meeting's room → `Leave the meeting room first`; they're in one (instances
    differ) → `<first name> is in a meeting room`;
  - `Follow` / `Unfollow` → `store.follow(…)`, active when following; disabled when away (`door` thinking/leaving),
    offline or dungeon (same rule as today's `PersonMenu`);
  - `Private room` → `store.createRoom([u.id])` when `store.roomReason(u)` is empty and they aren't heading out (the
    action wheel's "Take to private room");
  - admins only, same conditions as the action wheel: `Teleport` → `store.teleport(u.id)` (Rename lives in the GM panel only, like the wheel since #114).
  - Each action closes the card (see "Closing after an action"), except Follow, which toggles in place.
  - **Reasons are text, not tooltips**: when Knock (or Walk over/Follow) is disabled, the first reason shows as a
    muted line under the grid (`In Coffee — just walk in`, `Offline`…), because touch has no tooltips.
- **Volume** (humans only: not for bots, not for yourself): `Voice volume` range 0–200 step 5 with `<n>%`, writing
  `prefs.volumes[u.id]` + `savePrefs()` exactly as `PersonMenu` does; a `Mute for me` / `Unmute for me` toggle
  writing `prefs.localMuted`. Re-render on `subscribePrefs` so the row's `60%` / `🔕` updates live.
- **Your own card**: header and activity, then `Find me` (`engine.recenter()`) and `Change look` (opens the
  appearance menu, the same handler as the top bar button). No knock, no volume.

## Your strip (bottom of the panel)

**One bottom card**, full sidebar width minus its margins: `margin: 8px; padding: 10px 10px 10px 12px`,
`border-radius: 12px`, `background: var(--bg)`, `border: 1px solid var(--line)`,
`box-shadow: 0 -2px 12px rgba(0,0,0,.25)`. Nothing wraps. The rail keeps its compact controls, without a card.

**Voice section** — compact status above the identity row, separated by a 1 px `--line` divider, only when there is
something to say (first match):
1. `store.connected && !store.voiceOwner` → `Voice is on in another tab` + button `Use voice here` (`store.claimVoice()`).
2. a knock call (`me.callId && !me.instance && !store.roomCallOf(me) && store.voiceOwner`) → first line
   `Voice connected` in `--accent2` with a small `volume` signal icon; second line muted
   `with <names> · <voiceState>`. On the right, `Move to Meet` when there is a Meet link, then a red `disconnect`
   icon button, `Leave call` (`store.endCall()`).
3. room voice (today's `RoomVoiceChip` condition) → first line `Voice connected` in green, or `Muted` / `Deafened` /
   `Listen-only` in `--danger`; second line muted `<room name> · here: <first names or nobody yet>`.
   No mute or leave button here: the identity row controls the mic, and walking out leaves room voice.
4. `store.voiceWait` naming an office room → `Waiting for a spot in <room> voice`.

Both lines ellipsize; `title` keeps the full text, plus `earshotLine(store)` for room voice.
Inside a meeting room or private room (`me.instance`) the section stays empty: its voice lives on `MeetingChip`.

`CallChip` and `RoomVoiceChip` stay on the floor on **every layout**, with their existing texts and conditions,
mic and headphones `VoiceToggle` controls, and a red `disconnect` button for knock calls. The sidebar's section
is their compact status, not a second floating chip. `voiceState` and `earshotLine` stay shared in the sidebar module.

**Identity row**: one flex row, centered, `gap: 10px`. Your 40 px avatar (32 px crisp sprite head) has a 12 px presence
dot; clicking it opens Online / Away / In a call (`presence-pop`, upward). Your name is 15 px, weight 800,
`--text`, ellipsized; the status below is 12 px `--muted`, ellipsized, or `Set a status`. No room name here.
Name and status are one button opening `status-pop` upward: input with `maxLength=80`, Enter saves, Esc cancels,
outside click saves, `Clear`.

On the right (`margin-left:auto`): mic split (`VoiceToggle` + input chevron), headphones split (`VoiceToggle` +
output chevron), hand only in a room call, then settings. Buttons are 36×36, icons 22 px, radius 8 px, hover
`--panel2`. One voice popover has input / output / settings / claim views, opens upward and right-aligned to the
card, moves focus inside on opening and back to its trigger on closing. Escape respects `overlayOpen(store)`.

## Rail (collapsed)

56 px wide, in flow (wide and narrow modes). Top to bottom, each a button with an `aria-label`:
- `chevron-right` expand (`Show sidebar`).
- one button for each of the three room groups (`voice` 🔊, `knock` #, `quiet` 🌙) that has people, its online count
  under the icon; a click switches to Rooms view, expands the panel, opens that group and scrolls it into view. The
  live groups and Offline have no rail button.
- `💬 n` when there are unread chats: opens the oldest unread (`store.openChat([...store.unread.keys()][0])`).
- a divider, then the people in your call (`callPeers(me)` that are present), 28 px avatars with speaking rings, at
  most 5 then `+n`; a click opens their card anchored to the rail.
- bottom: `VoiceIcons` in a vertical `rail` variant (mic, deafen, settings; the hand only in a room call), then a
  hang-up button (`Leave call`, red) only in a knock call (`store.endCall()`), then your avatar (click: expand).

## Phones (compact)

- The dock keeps its buttons; `👥 People` toggles the sheet (replaces the old `RoomList` toggle).
- **Sheet**: `position:absolute` inside `.stage`, `left: env(safe-area-inset-left)`, `right: env(safe-area-inset-right)`,
  `bottom: calc(68px + env(safe-area-inset-bottom))` (above the dock), `z-index:8`, rounded top, a 32×4 grab handle.
  Two heights set by `top`: half `top: 45%`, full `top: 8px` (so it never leaves the stage). Tap the handle to switch;
  dragging the handle down more than 80 px closes, up more than 40 px goes full. Header: the same toggle, `×` close.
  Body: search + the same tree/list, the only scrolling part.
  No rail, no identity strip in the sheet (the dock has the voice buttons; the top bar keeps `IdentityPill` on compact).
- **Person card and room menu** render as their own bottom sheet (the anchor rules don't apply): same left/right/bottom
  as the sheet, `max-height: calc(100% - 16px)`, scrolling body, `z-index:9`, header `← Back` that closes just that
  sheet. The pinned Mac desktop window (640×420) is compact by height, so it gets this layout too.
- Floating `CallChip` and `RoomVoiceChip` stay on the floor on every layout (the sheet is usually closed on compact).
  They offer mic/headphones controls and a red disconnect for knock calls; on wide and narrow the bottom card also
  shows the compact voice status.
- The top bar on compact keeps `IdentityPill` (today's look). On wide and narrow, `IdentityPill` and the top bar
  `VoiceIcons` are not rendered.

## Closing after an action

Every card or menu action that walks or opens something closes that card or menu first. In compact mode it also
closes the sheet; in narrow mode it also closes the expanded overlay (otherwise they would cover the chat or the panel
that just opened: those sit at `z-index:7`). Volume, Mute for me and Follow change state in place and close nothing.

## Keyboard and focus

- Window key handlers stay as they are: push-to-talk Space, instrument keys and the floor's `+ − 0 M` keep working
  while a sidebar button has focus (like Discord's global push-to-talk); text fields are already excluded by those
  handlers. Only Escape is owned by the sidebar surfaces.
- **Escape**, innermost first, handled once (`stopPropagation` after handling): the status/presence/sound popovers →
  the card or room menu → the search field (clears, then blurs) → the narrow overlay or compact sheet (closes). The
  card and menu handle it in their own `onKeyDown`; the overlay/sheet close listens on `window` and acts only when no
  card, menu or popover is open. All of these do nothing while `store.gameOpen` or `store.table` (the arcade and the game table own the keyboard).
- **Focus**: opening the card focuses its first enabled action; opening the room menu focuses its first enabled item.
  Closing either (Escape, outside click, an action) returns focus to the element that opened it when it is still in the
  document, else to the search field on wide/narrow and to nothing on compact. Opening the compact sheet doesn't move
  focus (no keyboard pops up on phones).
- Everything stays inside `.office-chrome`, so the arcade overlay's `inert` covers the sidebar too.

## Avatar

`Avatar({ assets, user, size, ring?, dot? })`: a `<canvas>` with the head of the person's sprite: from
`assets.sheet(user.look)` take the down-facing idle frame (`x 0, y 0, 16×24`), crop its top 16×16 (hair + face), draw
scaled by the largest integer that fits `size` (crisp, `imageSmoothingEnabled = false`), centered on a
`--panel2` rounded square (`border-radius: 6px`). Keep a module-level cache of the 16×16 head canvases keyed by
`JSON.stringify(look)`. Before `assets` load, show the first letter of the name. Presence dot: 9 px (12 px on the
card) at bottom-right with a 2 px `--panel` border. Speaking ring: `box-shadow: 0 0 0 2px var(--accent2)`. Hats
(effects) are not drawn.

**Speaking**: `speaking` messages are scene-only (`SCENE_ONLY` in net.ts), so React doesn't re-render on them. A hook
`useSpeaking(store, engine)` polls every 150 ms while the sidebar (or rail) is mounted and returns a `Set` of ids,
calling `setState` only when the set changes. A person speaks when `engine.isSpeaking(u)` (make that method public;
it already fakes turn-taking for bots and reads `u.speaking` for people) — or, with no engine yet,
`!!u.speaking && !u.muted && !u.deafened`.

## Code layout

New folder `client/src/sidebar/`:
- `model.ts` — pure, no DOM, no import of `net.ts` values (type-only imports are fine): `PRESENCE_COLOR`,
  `roomGroup(room)`, `channelTree(view, map, query)`, `peopleGroups(view, query)`, `activityLine(view, u)`,
  `place(view, u)`, `roomThings(map, room)`, `GROUPS` (ids, labels, hints). `view` is a small interface the Store
  satisfies: `users`, `me`, `roomOf`, `roomCallOf`, `callPeers`, `names`, `clock`, `instruments`, `jukebox`,
  `presentation`, `sysadmin`.
- `Sidebar.tsx` — mode, width, persistence, panel/rail/sheet frames, resize handle, header, search, view switch.
- `ChannelTree.tsx`, `PeopleList.tsx`, `PersonRow.tsx` (shared row), `RoomMenu.tsx`, `PersonCard.tsx`, `Rail.tsx`.
- `SelfPanel.tsx` — voice block, identity row, and the moved `IdentityPill`, `VoiceIcons`,
  `CallChip`, `RoomVoiceChip`, `voiceState`, `earshotLine`, `EnableSound` (exported for App.tsx's `Dock` and the
  compact top bar).
- `Avatar.tsx` — `Avatar` + `useSpeaking`.

`App.tsx` loses `RoomList`, `PersonMenu` (card replaces it), and the moved components above; `Office` gains the
workspace wrapper, the card/menu state (`personMenu` keeps its `{ id, x, y }` shape so `ActionWheel`'s `onPerson`
keeps working), and passes `store`, `voice`, `engine`, `assets` to `Sidebar`. The `dialogOpen` list on
`InstrumentPanel` includes the room menu and the card. `ChatPanel` imports `PRESENCE_COLOR` from the model.

`styles.css`: a `/* sidebar */` block for `.workspace`, `.sidebar`, `.sidebar.rail`, `.sidebar.over` (narrow
expanded), `.sb-*` rows, the sheet, the card and the menu, in the existing palette (`--panel`, `--panel2`, `--line`,
`--text`, `--muted`, `--accent`, `--accent2`, `--danger`), rows 28 px tall (person rows with a second line 36 px), 13 px
text, 11 px second lines. Remove the old `.rooms …` rules only where nothing else uses them (`.rooms-head` is shared by
many panels: keep it). `.stage.editing .canvas-wrap { left: 280px }` keeps working: the edit panel lives in the stage.

## What stays exactly as it was

Everything the old panel did, now in the new one: walk to a room, open a person's actions, unread badge opening the
chat, game and instrument marks, meeting/door/underground/status lines, the special groups, Offline. The ⋯ menu keeps
Meet, Mac app and Leave; the hangers (🏆, ✏️, ✨, 🎒, appearance) and `UnreadButton` stay in the top bar. The
action wheel, toasts, the remaining chips (meeting, live, now playing, dungeon, desk), the zoom cluster, the chat
panel and every other panel are untouched.

## Checks

- `client/src/sidebar.test.ts` (Node, beside the other client tests so `npm test` picks it up) covering the model with
  a fake view and the real `tilemap.json`: room groups for all 16 rooms as listed above; group order; live groups
  only when non-empty; you first then by name; search (room match keeps all its people, person match keeps only
  them, empty groups gone, offline matches shown while searching); every `activityLine` branch and the ` · status`
  join; `roomThings` for Music, Co-working (clocks deduped), Lobby, Arcade, Library and Focus (none); count/full.
- `npm test`, `npm run typecheck`, `npm run build -w client`.
- Silent headless browser pass (Playwright, `--mute-audio`, fake mic), dev server with bots: wide expanded and
  collapsed (rail), resize and reload keeps the width, narrow 800 px (rail, expand over the map, Esc back), phone
  390×844 (sheet half/full, card as a sheet), Rooms/People switch, search, room menu on Music opens the jukebox,
  person card volume moves `prefs.volumes`, two tabs in a knock call show `📞 with …` and the voice block, and bots
  in a call show the speaking ring.
