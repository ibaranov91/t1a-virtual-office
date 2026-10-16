# UI rules (must follow)

## Principles
The floor is the product. Chrome is quiet, warm and readable; it supports the floor without competing with it.
Use Discord's sizes and patterns for lists, voice and the user panel. Keep one way to do each thing.

## Tokens
Use the variables in `client/src/styles.css`, including in new rules. No raw font sizes: `client/src/styles.test.ts`
enforces `var(--fs-…)`. A display exception needs `/* ui-exception: <reason> */` on the declaration's line.
Allowed exceptions are arcade/party pixel headings and touch arrows, presentation's 90s magazine slide styles,
instrument typing keys and drum pads, the Lofi TV logo and the login brand h1. Do not use exceptions for ordinary chrome.

| Type token | Size | Use |
| --- | --- | --- |
| `--fs-xs` | 12px | Badges, counters, tiny captions under icons |
| `--fs-sm` | 13px | Secondary text, hints, meta, small labels, group headers, timestamps |
| `--fs-md` | 15px | Body, buttons, inputs, selects, menus, list rows, chips |
| `--fs-lg` | 16px | Names, rooms, card and section titles, Voice Connected |
| `--fs-xl` | 18px | Panel, dialog and popover titles |
| `--fs-2xl` | 22px | Page headings, appearance dialog h2, login h1 (unless branded display) |

| Token | Value | Use |
| --- | --- | --- |
| `--fw-regular` | 400 | Body and secondary copy |
| `--fw-medium` | 500 | List names and labels |
| `--fw-bold` | 700 | Buttons and emphasized text |
| `--fw-heavy` | 800 | Titles and the self card name |
| `--lh` | 1.4 | Default line height |
| `--icon-sm` / `--icon-md` / `--icon-lg` / `--icon-xl` | 16 / 18 / 20 / 24px | Shared `.ui-icon` sizes |
| `--control-h` | 36px | Minimum control target height |
| `--radius-sm` / `--radius-md` / `--radius-lg` | 6 / 8 / 12px | Controls, popovers, larger cards |

| Color token | Use |
| --- | --- |
| `--bg` | App background and inset surfaces |
| `--panel` | Chrome, panels and popovers |
| `--panel2` | Raised, hovered and selected surfaces |
| `--line` | Quiet borders and separators |
| `--wood` | Warm structural borders, floor-related surfaces |
| `--text` | Titles, body and form labels |
| `--muted` | Secondary copy, hints, timestamps |
| `--accent` | Selection, you, primary buttons and links |
| `--accent2` | Live, connected and speaking states |
| `--danger` | Muted mic, destructive actions and hang-up hover |

## Text roles
- Panel/dialog/popover title: `.rooms-head`, its title `span`/`strong`, and `.voice-pop .rooms-head` use
  `--fs-xl`, `--fw-heavy`, `--text`. Appearance h2 uses `--fs-2xl`.
- Form-control and slider labels (Input mode, Voices/Music/Effects, Volume for me, Voice volume):
  `--fs-md`, `--text`. Percentage outputs: `--fs-sm`, `--muted`, tabular numbers.
- Floor chips (`.desk-chip`, call, meeting, now-playing, live, dungeon, desk): `--fs-md`, including buttons;
  `small` parts use `--fs-sm`.
- Toast text: `--fs-md`; hint: `--fs-sm`.
- Top bar: identity name `--fs-md`, bold; chips and buttons `--fs-md`; brand `--fs-lg`.
- Dock and rail captions under icons: `--fs-xs`.
- Badges/counters (`.badge`, `.sb-unread`, `.vbadge`, unread/later numbers): `--fs-xs`.
- Sidebar reference: room rows `--fs-lg`, person names/search/tabs `--fs-md`, second lines and group headers
  `--fs-sm`, rail captions and unread badges `--fs-xs`. Bottom card name and Voice Connected: `--fs-lg`.
- Other body copy, menu items and list rows: `--fs-md`. Names and section/card titles: `--fs-lg`.
  Hints, meta, small labels and timestamps: `--fs-sm`.

## Color roles
Titles and body use `--text`; secondary copy uses `--muted`. Reserve `--accent` for selection, you, primary
buttons and links. Use `--accent2` for live / connected / speaking; `--danger` for muted mic, destructive
controls and hang-up hover. Do not color a settings title orange.

## Controls
- Default `button` is primary. Use `button.ghost` for quiet secondary actions and `.danger` for destructive actions.
- Use `IconButton` + `Icon` from `Icon.tsx` for every icon control. Require an `aria-label`; `title` equals the label.
- Use `VoiceToggle` for mic/headphones everywhere, so state and behavior stay consistent.
- No emoji or text glyphs (×, ⋯, ▶, 🎙, 🎧) as controls. Emoji are content only: activity lines, reactions and items.

## Surfaces

Hover card: the mini profile over a person on the floor (DOM, pointer-events none, never covers the sprite, hidden on touch).

Achievements: the trophy modal (summary ring, plant hero, unlocked/locked card grid, rarity) and the Xbox-style unlock toast; new achievements need only an entry in ACHIEVEMENTS (and a progress rule in client/src/achievements.ts if they have a goal).

Your profile popout: the one place to manage yourself (look, pockets, achievements,
status, presence, sign out). Don't add self-management buttons to the top bar.
The banner editor is part of the profile popout: Color, Pattern and Image tabs replace its menu area, with a live
strip preview, Reset to default and Save. Escape discards the draft and returns focus to Edit banner.
Use the existing surface before inventing another. Escape closes the innermost open surface. Opening a surface
moves focus inside; closing it restores focus to its trigger (or the nearest remaining sensible control).

| Surface | Class | When and behavior |
| --- | --- | --- |
| Floor chip | `.desk-chip` family | Brief contextual state or action over the floor; keep its text short and let phone actions wrap. |
| Popover | `.settings-pop` / `.voice-pop` | A small setting at its trigger; focus a control on open, Escape closes and returns focus. |
| Panel/dialog | `.meet-panel.guided` + `.modal-backdrop`, title `.rooms-head` | A focused task needing more space; move focus in and back, close the innermost dialog first. |
| Sidebar row/card | `.sb-room`, `.sb-person`, `.sb-card.sb-surface`, `.sb-menu.sb-surface` | Browse people/rooms and open their actions; keep rows scannable and return focus after closing the card/menu. |
| Phone bottom sheet | `COMPACT`, `.sb-sheet`, `.sb-surface-sheet`, panel media rules | Replace desktop floating surfaces on short/narrow screens; stay above the dock, close on Escape and restore focus. |

Stacking order on the floor: chips 7, sidebar overlay/sheet 8, cards/menus 9. Modal backdrops/dialogs sit above these
at 10; full-screen activities retain their own layers.

## Layout
- Wide (900px and up, outside `COMPACT`): sidebar docks left, collapses to a rail, floor uses the remaining space.
- Narrow (under 900px, outside `COMPACT`): start with the rail; expanded sidebar overlays the floor.
- `COMPACT` is `(max-width: 560px), (max-height: 500px)`: thumb dock and bottom sheets replace desktop chrome.
- Respect `env(safe-area-inset-*)` on phones, including the space below sheets and the dock.
- Minimum touch target: 36px; 44px in the dock. Keep controls usable with the larger type before changing spacing.

## Copy
Status emoji is content: the leading emoji of the status string, picked in the status editor and shown after the name in lists.

English UI, sentence case, verb-first buttons. Keep labels short. Put short reasons under disabled actions as
visible text: touch has no tooltips.

## Before a PR that touches UI
- Tokens only for type; every display exception has a same-line reason.
- Use `Icon` / `IconButton` and shared `VoiceToggle` controls.
- Check compact layout, long text and safe-area spacing.
- Take a silent headless screenshot (`--mute-audio`).
- Run `npm test` (includes the styles test).
