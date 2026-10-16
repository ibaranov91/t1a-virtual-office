# Build log

The Deck was built during the T1A Cyprus Odyssey hackathon coding window, **Oct 15–16, 2026**. The kickoff was
10:00 CEST on Oct 15. The team settled on the virtual office idea at 10:27 CEST, and the first commit, `b1e24ad`,
landed at 11:16 CEST with the kickoff token in its message. No code was written before kickoff. Times below are CEST. Each item is a merged pull request (`#n`) or a direct commit to `main`; the
full list is in `git log --first-parent main`.

## Day 1: Thursday, Oct 15

| Time | What landed |
| --- | --- |
| 11:16 | First prototype: Node + `ws` server, shared A* map, bots, canvas client (`b1e24ad`) |
| 11:41–13:36 | Deployed to the vOffice box behind NetBird SSO; exit door, home desks; knock → built-in voice calls; per-person test instances; AGENTS.md |
| 14:37–15:49 | macOS menu bar app with one-command install and self-update (#2, #3, #5, #6, #9); action wheel (#7) |
| 15:50 | Open talk rooms in Coffee, a soundscape with distance and walls, shared radio (#8) |
| 16:30–17:10 | Connect Google: own Meet room per call, wall calendars, calendar meetings in their own room instance (#10–#14) |
| 17:21–17:50 | Sound v2 (#15); crisp zoom and overview (#16); people panel (#19); character appearance (#20) |
| 18:10–19:57 | Desk plants and Garden (#21, #22); office edit mode (#23); performance pass (#25); phone layout (#26); the Lobby vault (#27–#33) |
| 19:21–21:33 | Sound v3: sealed rooms and doors (#29); dungeon easter egg (#36); Music room jukebox, CC0 only (#28); Arcade with Deck Park, a rollback-netcode co-op platformer (#38); playable instruments (#41) |

## Night: Oct 15 → 16

| Time | What landed |
| --- | --- |
| 00:22–01:11 | Company time zones on the Lobby clock (#45, #46); hats and pockets, creatures, Admin room, Berghain club, presentation mode (#47); Lobby bell, Library, Terrace lunch (#49) |
| 01:26 | Agent guide: map atlas, feature-wiring checklist, `npm run where`, the `USE_KINDS` routing table (#51) |
| 01:32–03:45 | Top bar redesign (#52); judges' Odyssey hats (#53–#56); PDF slides rendered in the browser (#59); state backups and a versioned dump (#60); QA sweep (#70); render loop capped at 60/30 fps (#75) |

## Day 2: Friday, Oct 16

| Time | What landed |
| --- | --- |
| 09:45–10:07 | Name rule and teleport (#76, #77); broadcast serialisation and viewport culling (#78–#80); Book Club (#83); sound cleanup with no behaviour change (#43) |
| 11:32–12:12 | Jukebox starts cleanly (#48); Music room evenings with a disco ball (#42); creatures talk (#88); presentation redesign with screen share (#89) |
| 12:33–13:04 | Private instanced rooms (#92); Knock / Later redesign (#95); the Mac menu bar mirrors mute and deafen (#97–#101); restart keeps people in place (#98) |
| 13:22–14:14 | Music lounge with Lofi Girl TV (#103, #106); Arcade party pack: Break Set, seven versus games, a game table with chess, draughts, dominoes and Last Card (#91); Discord-style sidebar (#105); Game Boy homebrew cabinets with server-verified scores (#108, #111); vacation wing fed by Google Calendar (#109, #116) |
| 14:05 | Prod deploys only from the head of `main`, one at a time from any machine (#110) |
| 14:17–15:05 | Direct talk across rooms (#113); lunch tables as small voice rooms (#117); one type scale and `docs/UI.md` (#120); open-voice neon signs (#121) |
| 15:05–15:34 | Cocktails and a judgmental cat on the beach (#122); snowcapped peaks and walkable terraces (#123, #126); status emoji and a Discord-style profile popout (#124); an any-email demo instance for the judges (#125); a smaller vacation wing (#127); a trophy screen and an unlock moment for achievements (#128) |
| afternoon | Hackathon audit: README write-up, this log, the feature map, CI, docs checked against the code, small fixes |

## How we worked

- **Three people:** Ivan Baranov (core office, voice, Google, Mac app, prod), Andrii Butko (sound, music, arcade,
  sidebar, vacation, deploy rules), Varya Tikhonova (characters and appearance). `git shortlog -sn` shows the split.
- **Coding agents wrote most of the code:** Claude Code and Codex, often several at once in separate git worktrees.
  The humans chose the features, wrote or approved a spec for each bigger one (`docs/superpowers/specs/`), reviewed
  the code and tested it in two browsers and on phones.
- **Pull requests:** from the afternoon of day 1, changes went through pull requests (over 120 merged in about 28
  hours; a few small fixes were pushed to `main` directly). `npm test` (600+ tests), `npm run typecheck` and
  `npm run build -w client` run before each merge, and CI runs them too (`.github/workflows/ci.yml`).
- **Prod is always the head of `main`.** `scripts/deploy.sh` refuses anything else, and it holds a lock on the box,
  so parallel agents can't overwrite each other's deploys.
