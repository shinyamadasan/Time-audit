# ChronaSense Daily-Use Reliability Baseline V1 (TASK-013)

Base: `origin/main` `bc71f146a374edeafe141073adb8ce0d46330048` (TASK-012 closed `done`). Test-only task:
no production code, schema, rules, auth, Worker/Function or infrastructure change.

Critical loop under test: **start/resume -> interval ping -> log -> persist -> sync -> recover.**

## How the evidence was produced

`tests/daily-use-reliability.spec.js` (29 Playwright tests) drives the real `index.html` + `storage.js`
runtime in Chromium:

- **Firebase**: in-memory, room-partitioned stub. Its tree and network flags live in `localStorage`, so
  they survive a reload or a *simulated termination* (page closed without `beforeunload`, reopened in the
  same browser context). "Offline" = no data snapshots until reconnect and every write rejected.
- **Clock**: controlled `Date`, persisted the same way. Each `Date.now()` call advances 1 ms, so ids stay
  unique and time never runs backwards. Real-time waits are only for the app's own 1 s ticker and
  `setTimeout(0)` deliveries.
- **Known failures** use `test.fail()`. Each asserts the *existing* contract and is expected to fail
  today, so the default run stays green and turns red the moment the behavior changes. Raw failures:
  `T13_STRICT=1 npx playwright test tests/daily-use-reliability.spec.js --workers=1`.

Results on the candidate: default mode 29/29 (7 expected-fail), stable over `--repeat-each=3`. Strict mode:
22 passed, exactly the 7 known failures fail, each at its contract assertion.

## Reliability matrix

Result key: PASS (executed test) · FAIL = CONFIRMED_FAILURE · GAP = COVERAGE_GAP · UNVERIFIED =
PLATFORM_UNVERIFIED · DECISION = DESIGN_DECISION_NEEDED · KNOWN = KNOWN_ACCEPTED_LIMITATION.
"Existing" = covered by a pre-existing spec that passed in this run (863/863 baseline smoke).

| # | Subsystem | Scenario | Existing contract | Method | Result | Evidence | Remaining risk |
|---|---|---|---|---|---|---|---|
| 1 | Timer | Reload within interval keeps original start + activity; Stop logs once from it | Timer restore block (Hard Rule 8), PROP-004 | Reload, stop | PASS | `S1: running timer survives reload…` | — |
| 2 | Timer | Reload after an in-page ping keeps task start (block anchor moves to ping) | `restoreTimerAwayState()` restores `taskStartTime` | Ping, reload, stop | PASS | `S1: reload after an in-page ping…` | — |
| 3 | Timer | Termination within interval: recovery "intentional" logs once [start, last heartbeat], clears heartbeat, no duplicate on reopen | Heartbeat recovery; Hard Rule 4 | Kill, reopen, choose | PASS | `S1/S2: termination within the interval…` | — |
| 4 | Timer | Termination within interval: "accidental" keeps the original session | Modal: "Keep the timer running as if it never stopped" | Kill, reopen, choose | PASS | `S1: … "accidental" keeps the original session running` | — |
| 5 | Timer | Termination > 1 interval, reopened **online**: "accidental" keeps session | same | Kill, reopen online | PASS | `S1: termination longer than one interval, reopened ONLINE…` | Works only because the device's own remote timer copy is re-adopted |
| 6 | Timer | Termination > 1 interval, **offline** session: "accidental" | same + "never lose logged time" | Kill offline, reopen, choose, reconnect | **FAIL F-1** | `F-1 KNOWN FAILURE…` | Session permanently lost |
| 7 | Timer | Expired-timer recovery "intentional" logs exactly once | Recovery logs up to shutdown | Kill, reopen, choose | PASS | `S2: termination longer than one interval -> "intentional"…` | — |
| 8 | Timer | Expired recovery clears heartbeat (online PASS; **offline** FAIL) | Hard Rule 4 | Kill, choose, reopen | PASS / **FAIL F-2** | `S1: expired-timer recovery reopened ONLINE…`, `F-2…` | False prompt on every later open |
| 9 | Timer | Missed ping (throttled page), reopened < 2 min after last heartbeat (online PASS; **offline** FAIL) | Restore or recover, never drop | Suspend ticker, kill, reopen | PASS / **FAIL F-3** | `S1: reopened ONLINE within 2 min…`, `F-3…` | Silent loss, no prompt |
| 10 | Timer | Stopped block never duplicated by repeated reloads/termination (local, slot, remote) | Exactly-once entry | Stop, 3 reopens | PASS | `S2: a stopped and logged block is never duplicated…` | — |
| 11 | Timer | Pause / resume | No pause exists ("Pause removed": the main button opens Break while running) | Source | DECISION D-3 | `toggleTimer()` | Scope item "pause" maps to Break; single-account Break reload restore → GAP |
| 12 | Owner | Mirror device never pings, publishes or logs for another device's timer | `doPing()` device guard (Hard Rule 7, DECISIONS #17) | Remote owned timer, clock past interval | PASS | `S3: a mirror device never pings…` | — |
| 13 | Owner | Owner pings once per due interval, publishes itself as owner | same | Clock past interval | PASS | `S3: the owning device pings exactly once…` | — |
| 14 | Owner | Stop on one device logs once; other device resets on remote stop without logging; mirror stop logs once | `applyRemoteTimerState()` stopped branch | Remote stop / adopt + stop | PASS | `S3: stop on one device logs once…` | Near-simultaneous stops on two devices not tested (theoretical double log) |
| 15 | Owner | Takeover / transfer, stale remote snapshot rejected | Existing reconciliation | Existing | PASS (existing) | `smoke.spec.js` takeover + stale-snapshot tests; `focus-reload-recovery.spec.js` reconciliation | — |
| 16 | Ping | Ping delayed by long suspension fires once, fabricates no entry, keeps task start; visibility resume no double ping | `doPing()` writes no entry | Clock +75 min, visibilitychange | PASS | `S4: a ping delayed by long suspension…` | — |
| 17 | Ping→log | Notification-tap quick log after the ping describes the completed block | Notification copy "Time block complete — log it now"; CODEMAP "was this block…" | Ping, `openQuickLog()`, Continue | **FAIL F-4** | `F-4 KNOWN FAILURE…` | Every notification-driven log |
| 18 | Ping→log | Quick log stores a duration its instants support | Evidence contract: computed `blockIntervalMin` | same | **FAIL F-5** | `F-5 KNOWN FAILURE…` | Phantom minutes in `insights.js` aggregates |
| 19 | Ping | Foreground ping shows a log prompt | CODEMAP "sound + modal"; DECISIONS #17 "before logging a ping" | Source + git (`2f95922`) | DECISION D-1 | `doPing()`; banner removed in `2f95922` | Docs and code disagree; fix docs or behavior |
| 20 | Permission | Browser permission denied / request throws: timer starts, pings, logs, no page error | Graceful degradation | Fake `Notification` | PASS | `S5: browser notification permission denied…`, `S5: a permission request that throws…` | — |
| 21 | Permission | Native JS bridge with permission denied, rejected schedules | `initNativeNotifications()` returns on non-granted | Fake `LocalNotifications` ESM, `Capacitor.isNativePlatform` | PASS (JS level) | `S5: native (Capacitor JS bridge) permission denied…` | Real Android behavior UNVERIFIED |
| 22 | Ping | Quiet hours suppression | `isInQuietHours()` | — | GAP | — | Untested |
| 23 | Ping (web) | Background ping via service worker | `swSchedulePing()` → SW `setTimeout(delayMs)` | Source only | UNVERIFIED | `sw.js` | Browsers stop idle SWs (Chromium ~30 s), so a 30-min SW timer is likely not delivered; needs device check |
| 24 | Ping (Android) | Scheduled `LocalNotifications` delivery, Doze/exact-alarm, follow-up ping | `scheduleNativePing()`; follow-up is a WebView `setTimeout` | — | UNVERIFIED | — | Follow-up likely never fires when backgrounded/killed |
| 25 | Logging | Quick log during a running task, then Stop | No contract on double coverage | Ping, quick log, stop | PASS (invariant) + DECISION D-2 | `S2: quick log during a running task…` (annotation: 2 entries, 10 min covered twice) | Union totals correct; `blockIntervalMin` sums double count |
| 26 | Logging | Repeat-last ("Continue") | — | Exercised in #17/#25 | PASS (exercised) | same tests | — |
| 27 | Logging | Automatic tracking never rewrites an overlapping manual entry; stale remote copy cannot overwrite it | Manual precedence; `resolveEntrySync()` LWW | `autoLogBlock()` + stale remote write | PASS | `S8: automatic tracking never rewrites…` | Same-id edits on two devices = last writer wins (by design) |
| 28 | Logging | Template auto-log suppressed by manual coverage, deterministic ids, idempotent heartbeat | Scheduled auto-log contract | Existing | PASS (existing) | `smoke.spec.js` due-check / occurrence-ID / coverage tests | — |
| 29 | Logging | Two retro logs crossing the same midnight | Exactly-once, never lose logged time | `quickRetroLog()` ×2 | **FAIL F-6** | `F-6 KNOWN FAILURE…` | Remote loses a segment |
| 30 | Logging | Two retro logs ending in the same minute | same | `quickRetroLog()` ×2 | **FAIL F-7** | `F-7 KNOWN FAILURE…` | Remote loses an entry |
| 31 | Logging | Cross-midnight timer block keeps exact instants and splits 20/20 by day window | Instants are truth; grouping by authoritative day | Stop across Manila midnight | PASS | `S9: a timer block across local midnight…` | Stored `date` = stop day here, start day in `autoLogBlock()` (grouping uses instants; low impact) |
| 32 | Logging | Gap detection | `computeGaps()` anchor rules (Hard Rule 3) | Existing | PASS (existing) | `smoke.spec.js`, `analytics-truth.spec.js` | Not re-verified by new tests |
| 33 | Sync | Offline log kept locally, "saved locally" shown, pushed on reconnect | Reconnect handler pushes when `ta3-lv > ta3-last-sync` | Stub offline | PASS | `S6: an entry logged while offline…` | Real SDK offline queue not modeled |
| 34 | Sync | Offline log survives an offline reload, pushed on reconnect | same | Stub, reload offline | PASS | `S6: an offline entry survives a reload…` | Real SDK event ordering on reconnect unverified |
| 35 | Accounts | Account A's offline entry never reaches account B; reaches A on return | Account isolation | Offline, switch, reconnect | PASS | `S7: an offline entry of account A…` | — |
| 36 | Accounts | Timer/Away/Break and device-local isolation across switches | Isolation V1 suites | Existing | PASS (existing) | `timer-away-account-isolation.spec.js` (23), `device-local-account-isolation.spec.js` (12), `cross-store-account-isolation.spec.js` | — |
| 37 | Focus | Focus reload restore, exactly-once receipts, expired restore capped | Focus reload recovery | Existing | PASS (existing) | `focus-reload-recovery.spec.js` (27) | Historical pre-fix Focus entries not quarantined → KNOWN |

## Confirmed failures (reproduced, pre-existing, not fixed here)

All reproduce deterministically in Chromium. Surfaces: web app and the Android WebView (same
`index.html`/`storage.js` code); F-4/F-5 are the native-tap and service-worker-tap paths.

**F-1 — Offline session lost on "accidental" recovery after > 1 interval** (`handleRecovery(false)`).
Steps: start a timer with no connectivity; app terminated at +5 min; reopen offline at +45 min; tap
"No, it was accidental"; reconnect. Observed: `running=false`, no entry, `ta3-timer` record removed,
nothing to re-adopt. Cause: `restoreTimerAwayState()` restores only while `elapsed < totalSecs`, so the
expired branch calls `doPing()` with `running=false` and the next `persist()` deletes the timer record.

**F-2 — Expired recovery never clears the heartbeat (offline)**. Same setup, tap "Yes, I closed it
intentionally": the session is logged once, but `ta3-heartbeat-ts` stays because `_stopHeartbeat()`
resolves no owner room (timer never re-owned). Every later open shows the recovery prompt (Hard Rule 4).
Online this is masked by remote re-adoption.

**F-3 — Silent session drop after a missed ping (offline)**. Steps: the page is throttled so the due ping
never runs; heartbeat 30 s old; reopen 1 min later. Observed: no prompt (gap < 2 min), timer not restored
(elapsed ≥ interval), no entry, record deleted.

**F-4 — Notification-tap quick log is anchored at the ping instant.** Steps: timer started at T0; ping
fires at T0+30:05 (`doPing()` sets `blockStartTime = now`); notification tap → `openQuickLog()`; Continue
at T0+30:15. Observed entry `tsStart` = T0+30:05 (expected T0). The user's answer labels the seconds
after the ping, not the block it was asked about. Applies whenever the quick log is saved after the
interval elapsed, because the 1 s ticker runs `doPing()` before the user taps.

**F-5 — Fabricated 30-min duration.** Same steps: `blockIntervalMin` = 30 while `ts − tsStart` = 10 s
(`Math.round(...) || settings.intervalMin` in `_doQuickSave()`). `entryDurationMinutes()` shows 1 min, but
`insights.js` sums `blockIntervalMin` directly (hour buckets, activity/waste maps), adding phantom time.

**F-6 — Retro logs crossing the same midnight collide on id `midnight − 1`.** Steps: view 2026-10-13, log
"Movie 22:30–00:30" then "Sleep 23:45–07:00". Observed: locally 4 segments (two share an id); remotely
3 — `entries/e_<midnight−1>` holds Movie, Sleep's 15-min pre-midnight segment is gone.

**F-7 — Retro logs ending in the same minute collide on id `tsEnd`.** "Lunch 12:00–12:30" then
"Email 12:15–12:30": locally both (same id), remotely only Lunch. Another device, a reinstall or cleared
storage loses Email. Data Doctor's duplicate-id repair could also drop one locally (untested).

## Coverage gaps

- Quiet-hours ping suppression (#22).
- Single-account Break across reload/termination; corrupt `ta3-timer` JSON on restore.
- Near-simultaneous Stop on two devices (theoretical duplicate entry).
- Real Firebase SDK offline queue and reconnect ordering (stub-modeled only).

## Platform verification

| Platform | Verified here | Unverified (needs a device) |
|---|---|---|
| Windows desktop browser (Chromium) | Everything marked PASS/FAIL above (headless Chromium) | Real background-tab throttling, SW ping delivery, OS notification UI |
| Android Capacitor app | JS bridge behavior with denied permission (fake plugin) | Notification delivery timing, Doze/exact alarms, tap→app resume ordering, follow-up ping, offline cold start (ROADMAP Phase 12.0B not started), UsageStats auto-log |
| macOS browser (Chrome/Safari) | Not run (Chromium only) | Safari/WebKit storage, notifications, SW lifetime |
| iOS browser / PWA | Not run | No native app exists. Background pings need Home-Screen PWA + Web Push, which ChronaSense does not implement: **do not claim iOS ping support** |

## Design decisions needed

- **D-1** Foreground ping is sound-only since `2f95922` (banner "Log it" and in-page `Notification`
  removed). CODEMAP ("sound + modal") and DECISIONS #17 ("before logging a ping") describe the old
  behavior. Decide: restore an in-app prompt, or update the docs.
- **D-2** A quick log during a running task does not consume time from the task timer, so Stop covers the
  same minutes again (executed: 10 min covered twice). Decide whether a ping-tap log should advance the
  task anchor.
- **D-3** "Pause" is not a feature (the running-state button opens Break). Confirm Break is the intended
  pause.

## Known accepted limitations

- Historical expired-Focus entries are not retroactively quarantined (Evidence Contract, "Expired Focus").
- Phase 12.0B (Android runtime compatibility + offline cold start) is not started (ROADMAP).
- `npm test` keeps one environment-gated cross-repo control skip; `npm run lint` has 47 pre-existing warnings.

## Device acceptance checklist (manual)

Use a test account. Record pass/fail plus the entry's start/end and remote copy (second device or web).

| # | Check | Windows browser | Android app | macOS browser | iOS Safari/PWA |
|---|---|---|---|---|---|
| 1 | Start timer, reload at +10 min: same task and start time; Stop logs one entry from the original start | ☐ | ☐ (swipe-kill, reopen) | ☐ | ☐ |
| 2 | Leave in background 35 min with interval 30: a notification arrives within ~1 min of due | ☐ (tab hidden) | ☐ (screen off) | ☐ | Expected: none (unsupported) |
| 3 | Tap the notification, choose an activity: note the logged start/end (F-4/F-5 expected until fixed) | ☐ | ☐ | ☐ | n/a |
| 4 | Deny notification permission, start timer, log: no crash, entry saved | ☐ | ☐ | ☐ | ☐ |
| 5 | Airplane mode: stop a timer, reload, re-enable network: entry appears on the second device | ☐ | ☐ | ☐ | ☐ |
| 6 | Kill app mid-session, reopen after 45 min **offline**, choose "accidental" (F-1 expected until fixed) | ☐ | ☐ | ☐ | ☐ |
| 7 | Two devices, timer started on device A: only A pings; Stop on B logs exactly one entry | ☐ | ☐ | ☐ | ☐ |
| 8 | Sign out, sign in as another account: no timer, entry or plan from the first account | ☐ | ☐ | ☐ | ☐ |
| 9 | Timer across local midnight: one entry, timeline splits correctly on both days | ☐ | ☐ | ☐ | ☐ |

## Next recommended task (exactly one)

**TASK-014 — Notification-tap quick log records the completed block (fixes F-4 + F-5).**

Why this one: it sits on the critical loop itself and fires on every notification-driven log, which is
the main way the Android app is used during the day. Today each answer lands on the seconds after the
ping and may add 30 phantom minutes to insights. F-6/F-7 lose data but need specific retro-log
coincidences; F-1/F-3 need offline + termination. Same root area (`doPing()` / `_doQuickSave()`).

- **Scope**: Ping & Quick-Log section of `index.html` (`doPing()`, `openQuickLog()`, `_doQuickSave()`,
  `snoozeLog()`). `doPing()` keeps the completed block window (`prevBlockStart` is already computed and
  unused); a quick log opened for that ping logs `[prevBlockStart, ping]`. `blockIntervalMin` is always
  derived from the logged instants. If the window must survive a cold start from the notification tap,
  keep it in the local `ta3-timer` record only (`storage.js` `persist()` / `restoreTimerAwayState()`); no
  RTDB timer schema change.
- **Acceptance tests**: remove `test.fail` from F-4 and F-5 and make them pass; a quick log *before* any
  ping keeps today's behavior; tap → reload → log still logs the completed block; snooze path logs the
  completed block; every quick-log entry has `|blockIntervalMin − (ts − tsStart)| < 1 min`; full
  `npm test`, smoke, fence.
- **Dependencies**: owner decision on D-2 (whether the task anchor advances after a ping-tap log)
  before implementation; no other task.
- **Risk**: red-zone (timer state + entry creation, Hard Rules 7–9) → review gate `approved` (held, owner
  merges). Rollback is a revert; no data migration. Historical F-5 entries are not repaired.

Second in line: unique retro entry ids (F-6/F-7), then expired/offline recovery (F-1–F-3).
