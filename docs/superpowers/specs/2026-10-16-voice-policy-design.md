# Voice policy: muted by default, auto-mute, idle and calls that end themselves

Status: approved by Andrii on 2026-10-16. Knock calls start live. Codex (read-only) checked the findings against the
code.

## Why

The Deck has five kinds of voice, and each grew its own rules. They all lack the one rule they should share:
**nobody is ever on air by accident.** Today a live mic in an empty Coffee room stays live for as long as you keep
clicking around the office. Then the next person who walks in hears your room. Nothing mutes you when you go quiet,
and nothing tells you when you talk into a muted mic. Meanwhile the idle rule that does exist kicks out the wrong
people: quiet listeners in a lively room.

## How other apps do it

Sources were checked on 2026-10-16. Help centers say little about idle behaviour; these are the documented timers.

| App | Mic on join | Alone | Idle |
|---|---|---|---|
| Gather | Off by default | — | Mutes you when you switch apps, unless you're connected to someone (on by default) |
| Kumospace | Muted automatically in the floor-wide range | — | — |
| Discord | Voice channels live (voice activity); Stage audience muted | Server channels: you stay | Moved to the AFK channel after 1–60 min (one setting per server) |
| Slack huddles | Live; "always join muted" is opt-in | Huddle stays until the last person leaves | Opt-in: leave when the computer locks |
| Google Meet | Live; muted on join in calls of 5+ | "Still there?" after 10 min alone, you leave 2 min later; on by default, "to avoid sharing audio by accident" | — |
| Teams | Your last choice; muted on join in calls of 5+ | Prompt 10 min after the scheduled end, ends 3 min later | Opt-in: mute on screen lock; "your mic is muted" banner |
| Zoom | Live unless the host or a setting mutes on entry | Ends 40 min after one person is left | Pop-up after 55 min idle, ends 5 min later; "you're muted" pop-up |
| SpatialChat / Cosmos | — | — | "Stay or Do Not Disturb?" after 40 min idle / Away after 10 min of system idle |
| Sococo | — | — | Mic and camera off after 3 min idle (feature later removed) |
| oVice | Space admin picks | — | Away is manual; turning the mic on sets you back to Available |

Patterns across these apps:
- Spatial offices start muted. Call apps start live, and switch to muted on join once a call gets big.
- "Alone" timers are a feature of calls, not rooms.
- Rooms rely on idle states and on muting you when you switch away.
- Removal is preceded by a "Still there?" prompt with a short grace period.

## Where voice lives today

| Surface | How you get on | Mic on join | Ends / you leave |
|---|---|---|---|
| Open halls: Coffee, Music, Arcade, Book club (`rules.voice: 'open'`, `room:<roomId>`, up to 12) | Stand in the room or its doorway | Muted | Walk out; 10 min idle → walked to your desk |
| Small rooms: toilet stall, picnic table with "Eat & chat" (`room:stall:*`, `room:table:*`) | Go in / sit down | Muted | Step out; 10 min idle → walked to your desk |
| Meeting rooms (`room:<instance>`): ad-hoc rooms join on entry, calendar meetings opt in | Go / Talk | Muted | Leave voice, meeting ends; 10 min idle → voice off |
| Knock calls (up to 5) | Accept a knock, or knock your way in | **Live** | Leave; ends below 2 people; each person is cut **2 h after joining** |
| Meet links (knock call "Move to Meet", meeting room "Join Meet / Join call") | Click | Deck voice stays as it was | — |

Code: `client/src/voice.ts` (mic, mute, meter, AFK), `client/src/net.ts` (`roomCallOf`, `speaking`, `to_meet`),
`server/src/world.ts` (`connect`/`setOwner`, `voiceTick`, `joinCall`, `leaveCall`, `leaveRoom`, `roomVoice`),
`client/src/sidebar/SelfPanel.tsx` and `App.tsx` (chips, Meet links), `client/src/native.ts` (Mac app status).

## Findings

1. **A live mic never mutes itself.** Once you unmute in a hall, it stays live until you mute, leave, or go 10 min
   without touching The Deck. If you're clicking around the office, that's never. ([voice.ts:253](../../../client/src/voice.ts), `checkAfk`)
2. **The idle rule kicks the wrong people.** AFK = 10 min with no input in The Deck and no speech of your own. Speech
   from other people is ignored, and a muted mic never registers speech, because the meter skips a disabled track.
   Muted is the default, so a quiet listener in a lively conversation, working in another app, gets walked out
   after 10 min.
3. **Walking past a hall opens your microphone.** Standing in a hall or its doorway joins voice, and the join calls
   `getUserMedia` even though you start muted. A first-timer crossing Coffee gets a permission prompt out of nowhere,
   and the mic device stays open the whole time you sit there muted.
4. **No "you're muted" hint.** Zoom, Meet, Teams and Slack all tell you when you talk into a muted mic. We don't.
   Rooms start muted, so this is how the first sentence most often gets lost.
5. **No mute shortcut.** Space is push-to-talk only. Discord has ⌘⇧M / ⌘⇧D; Slack has ⌘⇧Space.
6. **Mute and unmute make no sound.** An automatic mute that happens while you're in another app has to be audible.
7. **A reload unmutes you in a knock call.** A new voice owner resets `muted` from the call type, so a muted person
   comes back live.
8. **A new tab takes your voice.** Every new connection becomes the voice owner straight away (`connect` →
   `setOwner`), so opening The Deck in a second tab moves your mic there without asking. Closing that tab hands voice
   back. Both moves re-apply finding 7. Discord moves voice only when you press "join" on the other device.
9. **A blocked mic stays blocked until reload.** After a denial, `micError` stops every retry, across calls too, and
   the mic button is disabled. Allowing the mic in the browser settings doesn't help until you reload.
10. **Away doesn't touch voice.** Setting yourself Away while standing in a hall leaves you on its voice, mic state
    unchanged.
11. **Knock calls cut you at 2 h.** `joinCall` gives every human a `leaveCall` 2 h after they joined. A busy call
    loses people at 2 h. A forgotten silent call keeps everyone "in a call" for up to 2 h.
12. **Meet links leave Deck voice running.** Move to Meet (knock calls) and Join Meet / Join call (meeting rooms)
    only open the link. If the Deck mic is live, the same voice goes out twice, with echo once others are on Meet too.
13. **The Mac app's mic status can say "live" when nothing is being sent** (push-to-talk not held, standing in a
    doorway). Minor.
14. **Idle in a meeting room says "Left …" but only turns voice off.** The toast is wrong.

## Policy

The rule in one sentence: **you start muted wherever other people might walk in. The Deck takes the mic back when
you're clearly not using it. It takes you off voice only when nothing has happened around you for 10 minutes, and it
asks first.**

### 1. Mic state on join

- **Shared spaces** (halls, small rooms, meeting rooms): muted on every entry, as today.
  - **New:** the microphone opens only on your first unmute in that space, so walking through Coffee never prompts
    or lights the mic indicator.
  - From then on the device stays open until you leave the space, so the next unmute is instant and the "you're
    muted" hint works.
  - Leaving the space closes it, and coming back starts muted again.
- **Knock calls**: live on accept, for the people who accepted and for anyone who knocks their way in. Accepting means
  "I'm ready to talk now", like answering a phone, a Slack DM huddle or a Teams 1:1 call. This is the one exception to
  "muted everywhere"; see "Your call".
- **Same knock call, new owner** (reload, Use voice here): mute state and On Meet carry over, stored per call id in
  `localStorage` (`deck.voice.calls`, pruned to the last 20 calls). Shared spaces aren't stored, so a reload there
  comes back muted, the safe default.
- **A blocked or missing mic** doesn't lock the button. Clicking unmute tries again, and a denial shows how to allow
  the mic.

### 2. Auto-mute when you go quiet (shared spaces, voice-activity mode)

| You are | Mic mutes after |
|---|---|
| Alone on the space's voice | **1 min** of silence, counted from your last word or from the moment you became alone, whichever is later. **Immediately** if you switch to another app or tab (Gather's rule) |
| With other people | **5 min** of silence |

- "Alone" means no other eligible person on the same `callId`. Bots, offline or leaving people, people in other
  instances and your own other tabs don't count.
- When it fires, you hear the mute sound and see a toast: "Muted: you were quiet for a minute" (or "…for 5 minutes",
  or "…you switched away"). The self panel shows "Muted" as usual. If your effects volume is at 0, the toast is the
  fallback.
- It doesn't run in push-to-talk (nothing is sent unless Space is held), while deafened (you're already silent), with
  a mic error, or in knock calls (the other person is waiting on you).
- Timers start on unmute and on every change of mode or company, and they are checked by comparing timestamps, so a
  throttled background tab still mutes on time at its next tick.
- Why two numbers: alone, a live mic has nobody to talk to, and its only risk is the next person walking in. With
  people, going 3 minutes without a word is normal listening, and re-muting too eagerly turns every call into "sorry,
  I was muted". The "you're muted" hint covers that case.

### 3. "You're muted" hint

- When your mic is open but muted and you talk for about 1 s, show "You're muted · click the mic or press ⌘⇧M" with
  an **Unmute** button. At most once every 30 s.
- The meter reads an always-enabled clone of the mic track. That detection is local only: it is never sent as
  `speaking`, never counts as activity for others, and stops along with the mic.
- In shared spaces it only shows once the mic is open, after your first unmute there. That is exactly the case that
  matters: you were auto-muted and started talking again.
- Not while deafened, in push-to-talk, or with a mic error.

### 4. Shortcuts and sounds

- **⌘⇧M** (Ctrl+Shift+M) toggles mute and **⌘⇧D** (Ctrl+Shift+D) toggles deafen, as in Discord. They work anywhere
  except text fields, only while you're on voice and only in the tab that owns voice.
- Mute and unmute get two short synthesized blips in `sounds.ts`, on the effects channel. They play on every change,
  manual or automatic.

### 5. Idle: when nothing has happened around you

**You're idle after 10 minutes with all of these at once:**
- no input in The Deck, in any of your tabs;
- no speech of your own;
- nobody on your voice speaking.

The third condition is new, and it keeps quiet listeners in a live conversation. In an empty or silent room, nothing
changes.

- **First a prompt.** Meet, Teams, Zoom and SpatialChat all ask before acting. At 10 min you hear a soft sound and see
  "Still here? You'll leave Coffee in 2 minutes" with an **I'm here** button. Any input in The Deck counts as an
  answer.
- **After 2 more minutes, by surface:**
  - **Halls and small rooms:** off voice and walked to your desk (or the Lobby), as today: "Left Coffee: nothing
    happened for 10 minutes". This is The Deck's version of Discord's AFK channel, and it keeps the lounges honest.
  - **Meeting rooms:** voice turns off and you stay in the meeting: "Voice off: nothing happened for 10 minutes".
  - **Knock calls (new):** you leave the call ("Left the call with Kim: nothing happened for 10 minutes"), and a 1:1
    ends. This covers the forgotten call where both people walked away. You stay where you are, and a hall you're
    standing in doesn't pull you onto its voice until you're back.
- The jukebox and the Lofi TV don't count as activity. An idle listener alone in the Music room leaves after 12 min,
  much as today.

### 6. Away

Setting yourself Away mutes your mic. Unmuting sets you back to Online, as in oVice. You stay where you are, and auto
Away is still not built (see "Not changing").

### 7. Meet links

Opening any Meet link from a call or room puts Deck voice **On Meet** for that call. Those links are Move to Meet, the
"X moved to Meet" toast, and Join Meet / Join call in meeting rooms.

- On Meet, your mic is muted and the call's audio is silenced for you, and the idle rule in section 5 is off, because
  The Deck can't hear Meet.
- The chip says "On Meet", and its **Use Deck voice** button switches back, restoring your previous mute.
- On Meet is remembered per call id, so a reload keeps it.
- You stay on the call, so presence still says "in a call".

### 8. The 2-hour cap becomes a backstop

Each knock call gets one deadline instead of a timer per person. The deadline is pushed back whenever anyone in the
call starts or stops speaking, and it ends the call after **2 h of total silence**.

- Busy calls are never cut.
- The 10-minute idle rule ends ordinary forgotten calls.
- The backstop covers calls that moved to Meet, and pages that were suspended or crashed.

## Server and protocol

- **`{ t: 'afk' }`** (new): the client's idle verdict.
  - In a hall or small room: `leaveRoom`, as `leave_room` does today.
  - In a meeting room: `roomVoice(false)`.
  - In a knock call: leave the call, with `u.afk = true` so the hall you're standing in doesn't pick you up.
- **`{ t: 'active' }`** (new): every tab sends it at most once a minute while there's input, and right away on the
  first input after an idle prompt or leave. It clears `u.afk`. Today only a `move` clears it, so anyone who comes
  back without walking stays off voice. The server relays it to your other tabs (`{ t: 'active' }`), so the tab that
  owns voice doesn't go idle while you work in another one.
- **Voice ownership:** a new connection takes voice only when there's no owner, or when it's the same tab coming
  back, recognised by a per-tab id in `sessionStorage` sent with the WebSocket hello. Any other tab gets "Voice is on
  in another tab · Use voice here", as it does today after a hand-over.
- **Knock-call backstop:** one timer per call, reset on every `speaking` from a member; it fires after 2 h of
  silence.
- `PROTOCOL` additions go in `shared/protocol.ts` first, and the server validates them (`afk`/`active` carry
  no payload).

## Not changing

- Halls still join by position, with the 12-person cap and its waiting line. Knock calls stay capped at 5.
- Deafen still means muted too, and it's still remembered across sessions.
- **No automatic Away.** The browser only sees input inside The Deck. Most people work in other apps with The Deck
  open, so auto-Away would mark everyone away all day. Real away detection needs system idle time from the Mac app,
  which means a signed Mac build. It stays on REQUIREMENTS' "not now" list.
- Knock routing for people who are Away (the Mac card is quiet, the server still delivers) is outside this policy.

## Your call

Knock calls start **live**. You said muted should be the default everywhere. Every comparable app goes live when you
*answer* a call and muted when you *walk into* a shared space. Starting a 1:1 muted makes the first line of nearly
every call "you're muted". If you still want muted everywhere, it's one line (`muted = true` for knock calls too).
Everything else follows the research above.

## Build and test

- **Pure policy module** `client/src/voicePolicy.ts`: takes timestamps and state (alone, mode, deafened, micError,
  hidden, On Meet, surface) and returns `mute` / `hint` / `prompt` / `leave` / nothing. Unit tests cover every row
  above.
- **`voice.ts`:**
  - lazy mic in shared spaces, keeping the existing transceiver and `replaceTrack` path, and the cancellation of
    stale requests;
  - the clone meter;
  - auto-mute, the idle prompt and the leave;
  - per-call mute and On Meet memory;
  - the shortcuts;
  - mic retry;
  - Away muting;
  - stopping both tracks on exit.
- **Client chrome:**
  - toasts and the "Still here?" prompt;
  - the On Meet chip state in `SelfPanel.tsx` / `App.tsx`;
  - blips in `sounds.ts`;
  - `native.ts` reports `live` only when the track is actually sending.
- **Server:**
  - `afk` and `active` handling;
  - tab-aware ownership in `connect`;
  - one backstop timer per call;
  - tests in `call.test.ts` / `rooms.test.ts`.
- **QA:** headless Playwright, fake mics, `--mute-audio`, with timers shortened through a dev-only override.
  - **Two people in Coffee:**
    - no `getUserMedia` on entry or in the doorway;
    - unmute opens the mic;
    - auto-mute after 1 min alone, and at once on tab switch;
    - the muted-speech hint;
    - a muted listener stays while the other side talks;
    - prompt, then walk-out, once both go quiet.
  - **Knock call:**
    - live on accept;
    - reload keeps mute;
    - a second tab doesn't take voice;
    - Move to Meet silences Deck voice and Use Deck voice restores it;
    - the idle leave ends a 1:1.
  - The re-test from AGENTS.md: call, Leave, call again, reload each side mid-call.
