# Personal breaks

Open your profile and choose **Breaks and Pomodoro**, or click:

- the water cooler in Coffee, at tile 37,3;
- the stretching mat in the Garden, at 20,30;
- the tomato timer on the Focus desk, at 3,4.

Water and stretch reminders are off initially. Enable either and choose an interval from 1 to 180 minutes
(defaults: water 30, stretch 60). **Done** starts a new interval; **In 5 minutes** replaces the deadline.
Stretch reminders rotate through reaching up, squats and heel raises.

Pomodoro defaults to 25 minutes of focus, a 5-minute short break and a 15-minute long break. Durations can
be changed while idle. Pause/resume preserves time left; Reset cancels the current timer. Completing four
focus sessions offers a long break. Every next session starts explicitly. A compact chip keeps the running
or paused timer accessible after closing the panel.

Settings and deadlines live in `deck.wellness.<userId>` in localStorage: private to the signed-in person,
this browser/app and this instance. Tabs share changes. Reloading keeps a timer; sleeping does not accumulate
missed repeats. Only one reminder of each kind waits for an answer. Leaving the office cancels native requests;
signing back in restores saved deadlines. These settings do not change presence, calls or other people's state.

## Mac notifications

The updated app schedules a single macOS notification for each deadline via `UNUserNotificationCenter`.
The system owns those deadlines even when the web view is hidden. When The Deck is in front, it shows the
in-app reminder instead of a second system banner. Clicking a system notification opens its settings panel;
reloads queue that destination until the signed-in page is ready. Changing timers, signing out or switching
instances cancels/replaces the appropriate requests. An expired deadline is never rescheduled just by reloading.

The first enable/start action requests notification permission. If denied, in-app reminders still work and
the panel offers **Open notification settings**. An older Mac app offers an update hint. A browser uses in-app
reminders while its page is open; it does not request browser notification permission.

Build with the existing `macos/build.sh --dist <instance>` workflow. Distribution still requires the shared
T1A signing identity described in AGENTS.md. Do not ship the ad-hoc `wellness` test build as a production update.

## Verification

- `npm run gen`, `npm run typecheck`, `npm test`, `npm run build -w client`.
- `macos/build.sh --dist wellness` creates a separate test app and ZIP.
- Browser: enable, snooze and complete each reminder; start/pause/resume and reload Pomodoro; check two tabs
  for stable storage and shared actions. Check reminders above reading/arcade and at a narrow viewport.
- Native: grant notifications to the test app, start a one-minute timer and hide its window. Confirm one
  banner, click through to the correct panel, then test reset/disable and a reload. Denial must show a
  recoverable settings link. System banner delivery needs real macOS permission; compilation alone does not
  verify delivery.
