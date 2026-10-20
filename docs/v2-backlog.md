# v2 backlog

Everything still to do for v2, split into tasks one person (or one agent session) can pick up. The plan and the decisions
behind the first two batches are in [docs/superpowers/specs/2026-10-17-v2-plan.md](superpowers/specs/2026-10-17-v2-plan.md).
What already shipped into `v2` is listed at the end.

## How to use this
- **Claim a task:** put your name in **Owner** and set **Status** to `doing`, in the same commit as your first change (or a tiny
  commit of its own), so others see it after they merge `v2`.
- **Status:** `todo` → `doing` → `review` (on your branch, waiting for a merge) → `done` (merged into `v2`). `blocked` / `idea`
  (needs a decision before anyone builds it) / `out` (decided against).
- **Size:** S ≈ an hour or two, M ≈ a day, L ≈ several days or needs a design first.
- **Depends on:** do those first, or coordinate with whoever owns them.
- **Work as AGENTS.md says:** branch off `v2` in a worktree, merge back into `v2`, never push until v2 is released. Many tasks
  touch `world.ts`, `App.tsx`, `engine.ts` and `gen-map.mjs`: keep additions in their own marked blocks
  (docs/ADDING-A-FEATURE.md, merge rules).
- **Testable here?** `local` = can be built and checked with `npm run dev` and the browser; `mac` = needs the Mac app;
  `voice` = needs two people with microphones; `google` = needs Google sign-in (prod only).
- Add new ideas at the bottom of the right group with the next free ID; never renumber.

## 1. Voice
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| VO-1 | Push to talk: choose your own key; show clearly in the sidebar strip and the voice/call pop-ups that PTT is on | todo | | M | | voice | plan group 1 |
| VO-2 | Voice past 12 people: polish the 12-speaker stage and the waiting line (state, step down, auto-promote) | todo | | M | | voice | decision 7 |
| VO-3 | Voice reconnects by itself after a dropped connection | todo | | M | CL-2 | voice | |
| VO-4 | Jukebox starts at 5–10% when you enter, with a volume slider in the top slot | todo | | S | | local | |
| VO-5 | No jukebox audio at all while deafened (macOS grabs AirPods when playback starts) | todo | | S | | local | |
| VO-6 | Meeting voice mode: the organizer picks Meet or Deck voice, else the first person in | todo | | M | | google, voice | decision 10 |

## 2. Mac app
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| MA-1 | Pinned window that stays on top of every window; drop "move desktop window", drag by a strip at the top | todo | | M | | mac | |
| MA-2 | Client version in the right-click menu | todo | | S | | mac | |
| MA-3 | DND toggle in the right-click menu, in sync with the page | todo | | S | | mac | |
| MA-4 | Meeting reminder card under the menu bar icon: Open Meet / Go to room / Both, with a setting to turn it off | todo | | M | | mac, google | |
| MA-5 | Native Settings window (⌘,): launch at login, instance, pin mode, notifications, meeting reminders | todo | | M | | mac | decision 11 |
| MA-6 | Launch at login | todo | | S | MA-5 | mac | |
| MA-7 | Local testing of Mac releases: separate dev bundle id, "Local" instance, `/api/mac` served by the dev server, a release checklist | todo | | M | | mac | |

## 3. Meetings, calendar, projects
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| ME-1 | Hovering a wall calendar shows your next meeting (from the `agenda` already sent) | todo | | S | | local (fake agenda), google | |
| ME-2 | Book real rooms for events (e.g. Book Club); being there 10+ min of the event gives a stack-of-books hat | todo | | L | EN-1 | local | |
| ME-3 | Rooms per project: instanced but permanent, attached to a Jira project code | idea | | L | | local | needs design: who creates, how to find them |
| ME-4 | Time attribution: meetings linked to Jira projects | idea | | L | ME-3 | google | needs Jira access design |
| ME-5 | Export your time log | idea | | M | ME-4 | local | |
| ME-6 | Meeting transcripts, Russian included | idea | | L | | voice | needs a speech-to-text choice and a privacy decision |

## 4. Photos, uploads, media
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| PH-1 | Camera button (always visible, works on phones) and your own photo folder: 10 MB, download, delete | todo | | M | | local | plan group 9 |
| PH-2 | Photo of the week: Lobby photo wall (replaces the "coming soon" wall), one vote each, Monday winner framed + achievement | todo | | M | PH-1 | local | decision 16 |
| PH-3 | The bouncer puts you outside the club if you take a photo in Berghain | todo | | S | PH-1 | local | |
| PH-4 | Screenshot uploads | idea | | M | PH-1 | local | where do they show? |
| PH-5 | People upload their own pixel art | idea | | M | AR-1 | local | moderation? |

## 5. Book Club and library
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| BK-1 | Shared reading: a leader opens a book and turns pages, everyone in the room sees it on half the screen | todo | | L | | local | plan group 9 |
| BK-2 | Book formats: EPUB, PDF (pdf.js), plain text; MOBI only if a small parser works | todo | | M | BK-1 | local | |
| BK-3 | Public-domain books (Project Gutenberg) on the shelves; pick one at the leader's chair | todo | | S | BK-1 | local | downloading books is approved |
| BK-4 | Scholar hat: 20 library articles read and 60 min spent in reading mode | todo | | S | EN-1 | local | |

## 6. NPCs and creatures
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| NP-1 | NPC routines as data: schedule (office time), steps, phrases, `onInteract` reward | todo | | M | | local | engine item 5 in the plan |
| NP-2 | The cleaning lady waters plants, trees and bushes now and then | todo | | S | NP-1 | local | |
| NP-3 | Ghost of Mazurkevich: 4–5 coffee breaks a day in the kitchen; greet him → achievement + ghost hat | todo | | M | NP-1 | local | |
| NP-4 | Make the cleaning lady walk slower | todo | | S | | local | |
| NP-5 | Fishing: click the float to catch a fish; feed it to the cat or dog, chance of a cat or dog hat; rare fish hats (shark, Nemo) | todo | | M | EN-1 | local | |
| NP-6 | Cat toys: the cat plays with them | todo | | M | | local | |
| NP-7 | A ball to play with the dog (throw it, he fetches) | todo | | M | | local | Throw is ball-only already |

## 7. Items, hats, inventory
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| IT-1 | Hat rules: each hat collected once, no inventory slots, can't be put in storage, can't be dropped, given away or lost (theft included) | todo | | S | | local | mostly true today: check storage and every remove path |
| IT-2 | Stickers: make them usable (on your banner, on your desk, or tradeable with a set achievement) | idea | | M | | local | pick one |
| IT-3 | Plant-disguise hat: you can't move while a plant; hovering still shows your card, no name tag under you | todo | | M | | local | |
| IT-4 | A separate pockets section for hats with special effects | todo | | S | IT-6 | local | |
| IT-5 | Plushies as items | todo | | S | | local | |
| IT-6 | Better inventory UI | todo | | M | | local | |
| IT-7 | Item powers: an `ability` on items with one simple use flow; first one a portal gun that teleports you to someone | todo | | M | EN-2 | local | temporary admin-like powers for everyone |
| IT-8 | More toys (see NP-6, NP-7) | idea | | | | | |
| IT-9 | You can't pick up (or be given, or take from the shop or gacha) an item you already have one of; refuse with a notice instead of letting a copy vanish | todo | | S | | local | today one-of-a-kind items can silently disappear |
| IT-10 | Admins can delete items lying on the floor (wheel action or GM panel) | todo | | S | | local | |

## 8. Events and social
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| SO-1 | Say bubble: Enter opens a one-line input over your character, ~10 s, seen by anyone who sees you | todo | | S | | local | decision 5 |
| SO-2 | Birthdays: kitchen decorations on the day; hover the flags to see whose birthday it is | todo | | M | | local | where do birthdays come from? |
| SO-3 | Birthday card on the table everyone can sign, with an achievement | todo | | M | SO-2 | local | |
| SO-4 | Birthday cake: two 2-hour windows (US and EU day); eating cake gives an achievement and a cake hat | todo | | M | SO-2, EN-1 | local | |
| SO-5 | Events for people who joined in the last 3 months | idea | | M | | local | |
| SO-6 | HR notice board | idea | | M | | local | |
| SO-7 | Real joint work: co-working sessions done properly | idea | | L | | local | needs design |
| SO-8 | Low-effort games to play together during meetings (e.g. a Diablo-style slasher) | idea | | L | | local | |
| SO-9 | Social room with bean bags | todo | | M | MP-1 | local | |

## 9. Secret cult room
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| CU-1 | Instanced room off the main map: stone statues along the walls, sacrificial altar, benches, a church feel | todo | | M | | local | |
| CU-2 | Entrance through a bookshelf: you can enter while holding the robe; for everyone else no button, just "looks sketchy" | todo | | S | CU-1 | local | |
| CU-3 | Cultist robe: anonymous black hooded look with hands in prayer, put on as you enter the room | todo | | M | CU-1 | local | |
| CU-4 | Robe puzzle, starting from a blood-stained note on the ground | todo | | L | EN-1 | local | puzzle steps need design |
| CU-5 | The altar records your name the first time you enter (click it to read the members) | todo | | S | CU-1 | local | |
| CU-6 | Ritual: with 2+ robed members in the room they can start it; the altar and a statue glow | todo | | M | CU-3 | local | |

## 10. Map and layout
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| MP-1 | New layout: work rooms in the middle, social and entertainment rooms around them | idea | | L | | local | big change: saved layouts, MAP.md, every room-based feature |
| MP-2 | Server-room lightboard driven by Kuma monitors; sysadmins click it for details | todo | | M | | local | needs the Kuma API |

## 11. Editors and art
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| AR-1 | Pixel-art editor | idea | | L | | local | for what: hats, items, uploads? |
| AR-2 | Improved layout editor | idea | | L | | local | list what's missing first |
| AR-3 | Better pixel art overall | idea | | L | | local | |

## 12. Admin, mobile, clients, reliability
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| CL-1 | Better GM UI | todo | | M | | local | |
| CL-2 | Losing the connection for a moment: the server keeps your place and call seat 30–60 s (resume token), "Reconnecting…" bar with retry | todo | | M | | local | plan group 5 |
| CL-3 | A deliberately limited mobile version: no editors | todo | | S | | local | |
| CL-4 | Terminal client: npx package served by the instance, device-code sign-in, chat and walking in the Terminal room, green sprites for others | todo | | L | | local | decision 18 |
| CL-5 | Final QA pass before release: end-to-end, docs, MAP.md, final build | todo | | M | everything | local | last |

## 13. Engine
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| EN-1 | Per-person progress store: flags, counters, timers and puzzle steps, saved with the user and described as data. Replaces ad-hoc state (Berghain lines, sewing time, reading counts) | todo | | M | | local | unblocks puzzles, scholar hat, birthdays, fishing |
| EN-2 | Item abilities: one use flow for items that do something (teleport, unlock, start a ritual) | todo | | M | | local | first user: IT-7 |

## 14. Possibly bad ideas
| ID | Task | Status | Owner | Size | Depends on | Test | Notes |
|---|---|---|---|---|---|---|---|
| X-1 | Integrate with Second Stack, as something to do while waiting for agents | idea | | ? | | | |

## Already in v2
Batch 1 (engine, diagnostics, items core, notifications, DND), batch 2 (7/11, places, item content, atmosphere), pixel art for
items, wheel actions, reactions and bubbles, soft fog, tidying (bring the cup back), give for everything with throw only for
balls, the bugs & suggestions terminal, click-to-drive car with a following camera and driven/parked rules, Pockets on your own
wheel. Details in `git log v2` and the v2 plan.
