# ChronaSense Daily-Use Reliability Baseline V1 (TASK-013)

Base: `origin/main` `bc71f146a374edeafe141073adb8ce0d46330048` (TASK-012 closed `done`). Test-only task:
no production code, schema, rules, auth, Worker/Function or infrastructure change.

Critical loop under test: **start/resume -> interval ping -> log -> persist -> sync -> recover.**

Revision: FIX FIRST rework R1–R3 (independent review of `6d9dbb9`). F-4 is reclassified as
DESIGN_DECISION_NEEDED; the F-5 frequency claim is withdrawn; harness limits are now stated.

## How the evidence was produced

`tests/daily-use-reliability.spec.js` (29 Playwright tests) drives the real `index.html` + `storage.js`
runtime in headless Chromium.

### Firebase stub

- An in-memory, room-partitioned stub. Its tree and network flags live in `localStorage`, so they
  survive a reload or a *simulated termination*: the page is closed without `beforeunload` and reopened
  in the same browser context.
- "Offline" in the stub means two things: data listeners get no snapshot until reconnect, and every
  write is **rejected immediately**.

It differs from the real Firebase SDK in ways that matter here:

| Behavior | Stub | Real SDK (web, no disk persistence) |
|---|---|---|
| Offline `once()` | Resolves at once with the stored tree value | Waits for the server for uncached data, so it may not resolve while offline |
| Offline write | Promise **rejects** at once; nothing is applied; no local event | Promise stays **pending**; the write fires local events, is retried by the SDK while the page lives, resolves on reconnect, and is lost if the page reloads first |
| Reconnect order | `.info/connected` first, then deferred data snapshots | Not verified |

As a result:
- The S6 assertion that the "Sync failed — saved locally" toast appears is **stub-dependent**. With the
  real SDK an offline write does not reject, so the toast would not appear.
- S6/S7 prove the app's own retry path: it re-pushes local entries on reconnect when `ta3-lv` >
  `ta3-last-sync`. They do not prove the SDK queue.

### Clock

`Date` is controlled. `Date.now()` and argument-less `new Date()` each advance 1 ms per call, so ids stay
unique within a page. Only an explicit `set()` stores the clock in `localStorage`. A reopened page
resumes from the last *set* value, not the last observed one, so the harness always moves the clock
forward before reopening.

A normal reload moves the live clock too, so `beforeunload` stamps the heartbeat at the reload instant.
A termination moves only the stored clock, so the closed page's last heartbeat stays old. The only
real-time waits are for the app's own 1 s ticker and `setTimeout(0)` deliveries.

### Forced session-start flag

The harness sets `sessionStorage['ta3-session-started'] = '1'` on **every** page, including reopened ones.
This disables the app's open-time auto-start: desktop "PC Time" after up to 5 s, and the mobile/native
auto-start. Every reopen scenario therefore runs without auto-start. On a real desktop browser, a new
session with no running timer would start "PC Time" by itself. That path is untested; see Coverage gaps.

### Expected failures

- Expected failures use `test.fail()`. The annotation is applied only **immediately before the contract
  assertion**, after all setup and preconditions (UI present, entries created locally, sync reached the
  remote) have passed. Broken setup therefore fails the test for real.
- Raw failures: `T13_STRICT=1 npx playwright test tests/daily-use-reliability.spec.js --workers=1`.
- Mutation evidence:
  - **M2** (quick save suppressed: `_doQuickSave()` returns at once) makes F-4, F-5 and D-2 fail for real.
  - **M3** (retro logging suppressed: `quickRetroLog()` returns at once) makes F-6 and F-7 fail for real,
    at their local-creation preconditions.
  - `index.html` was restored from git after each mutation.

### Results on the rework candidate

- Default mode: 29/29 report expected outcomes (22 pass; 7 expected-fail).
- Six workers × `--repeat-each=3`: 87/87.
- Strict mode: 22 passed; exactly the 7 designated tests fail, each on the line right after
  `knownFailure()`.

## Reliability matrix

Result key:
- PASS: verified by an executed test
- FAIL: CONFIRMED_FAILURE
- GAP: COVERAGE_GAP
- UNVERIFIED: PLATFORM_UNVERIFIED
- DECISION: DESIGN_DECISION_NEEDED
- KNOWN: KNOWN_ACCEPTED_LIMITATION
- "existing": covered by a pre-existing spec that passed in the baseline smoke run (863/863)

| # | Subsystem | Scenario | Existing contract | Method | Result | Evidence | Remaining risk |
|---|---|---|---|---|---|---|---|
| 1 | Timer | Reload within interval keeps original start + activity; Stop logs once from it | Timer restore block (Hard Rule 8), PROP-004 | Reload, stop | PASS | `S1: running timer survives reload…` | — |
| 2 | Timer | Reload after an in-page ping keeps task start (block anchor moves to ping) | `restoreTimerAwayState()` restores `taskStartTime` | Ping, reload, stop | PASS | `S1: reload after an in-page ping…` | — |
| 3 | Timer | Termination within interval: recovery "intentional" logs once [start, last heartbeat], clears heartbeat, no duplicate on reopen | Heartbeat recovery; Hard Rule 4 | Kill, reopen, choose | PASS | `S1/S2: termination within the interval…` | Auto-start disabled by harness flag |
| 4 | Timer | Termination within interval: "accidental" keeps the original session | Modal: "Keep the timer running as if it never stopped" | Kill, reopen, choose | PASS | `S1: … "accidental" keeps the original session running` | same |
| 5 | Timer | Termination > 1 interval, reopened **online**: "accidental" keeps session | same | Kill, reopen online | PASS | `S1: termination longer than one interval, reopened ONLINE…` | Works only because the device's own remote timer copy is re-adopted |
| 6 | Timer | Termination > 1 interval, **offline** session: "accidental" | same + "never lose logged time" | Kill offline, reopen, choose, reconnect | **FAIL F-1** | `F-1 KNOWN FAILURE…` | Session permanently lost |
| 7 | Timer | Expired-timer recovery "intentional" logs exactly once | Recovery logs up to shutdown | Kill, reopen, choose | PASS | `S2: termination longer than one interval -> "intentional"…` | — |
| 8 | Timer | Expired recovery clears heartbeat (online PASS; **offline** FAIL) | Hard Rule 4 | Kill, choose, reopen | PASS / **FAIL F-2** | `S1: expired-timer recovery reopened ONLINE…`, `F-2…` | False prompt on every later open |
| 9 | Timer | Missed ping (throttled page), reopened < 2 min after last heartbeat (online PASS; **offline** FAIL) | Restore or recover, never drop | Suspend ticker, kill, reopen | PASS / **FAIL F-3** | `S1: reopened ONLINE within 2 min…`, `F-3…` | Silent loss, no prompt |
| 10 | Timer | Stopped block never duplicated by repeated reloads/termination (local, slot, remote) | Exactly-once entry | Stop, 3 reopens | PASS | `S2: a stopped and logged block is never duplicated…` | — |
| 11 | Timer | Pause / resume | No pause exists ("Pause removed": the main button opens Break while running) | Source | DECISION D-3 | `toggleTimer()` | Single-account Break reload restore → GAP |
| 12 | Timer | Reopen with the app's own auto-start active | Desktop "PC Time" / mobile auto-start on a new session | — | GAP | Harness forces `ta3-session-started` | Auto-start interaction with recovery/restore untested |
| 13 | Owner | Mirror device never pings, publishes or logs for another device's timer | `doPing()` device guard (Hard Rule 7, DECISIONS #17) | Remote-owned timer, clock past interval | PASS | `S3: a mirror device never pings…` | — |
| 14 | Owner | Owner pings once per due interval, publishes itself as owner | same | Clock past interval | PASS | `S3: the owning device pings exactly once…` | — |
| 15 | Owner | Stop on one device logs once; other device resets on remote stop without logging; mirror stop logs once | `applyRemoteTimerState()` stopped branch | Remote stop / adopt + stop | PASS | `S3: stop on one device logs once…` | Near-simultaneous stops on two devices untested |
| 16 | Owner | Takeover / transfer, stale remote snapshot rejected | Existing reconciliation | Existing | PASS (existing) | `smoke.spec.js` takeover + stale-snapshot tests; `focus-reload-recovery.spec.js` reconciliation | — |
| 17 | Ping | Ping delayed by long suspension fires once, fabricates no entry, keeps task start; visibility resume no double ping | `doPing()` writes no entry | Clock +75 min, visibilitychange | PASS | `S4: a ping delayed by long suspension…` | — |
| 18 | Ping→log | Which interval a notification-tap quick log covers | **Conflicting**: notification copy vs quick-log UI (see D-4) | Ping, `openQuickLog()`, Continue | DECISION D-4 (F-4) | `F-4 EXPECTED FAILURE (DESIGN_DECISION_NEEDED)…` | Labels may land on the seconds after the ping |
| 19 | Ping→log | Quick log stores a duration its instants support | Evidence Contract: computed `blockIntervalMin` | same | **FAIL F-5** | `F-5 KNOWN FAILURE…` | Phantom minutes in `insights.js`; real-device frequency UNVERIFIED |
| 20 | Ping | Foreground ping shows a log prompt | CODEMAP "sound + modal"; DECISIONS #17 "before logging a ping" | Source + git (`2f95922`) | DECISION D-1 | `doPing()`; banner removed in `2f95922` | Docs and code disagree |
| 21 | Permission | Browser permission denied / request throws: timer starts, pings, logs, no page error | Graceful degradation | Fake `Notification` | PASS | `S5: browser notification permission denied…`, `S5: a permission request that throws…` | — |
| 22 | Permission | Native JS bridge with permission denied: schedule still called, rejection absorbed | `initNativeNotifications()` returns on non-granted | Fake `LocalNotifications` ESM, `Capacitor.isNativePlatform` | PASS (JS level) | `S5: native (Capacitor JS bridge) permission denied…` (asserts `requestPermissions` and `schedule` calls) | Real Android behavior UNVERIFIED |
| 23 | Ping | Quiet-hours suppression | `isInQuietHours()` | — | GAP | — | Untested |
| 24 | Ping (web) | Background ping via service worker | `swSchedulePing()` → SW `setTimeout(delayMs)` | Source only | UNVERIFIED | `sw.js` | Browsers stop idle SWs (Chromium ~30 s), so a 30-min SW timer may never fire; needs a device check |
| 25 | Ping (Android) | Scheduled `LocalNotifications` delivery, Doze/exact alarms, follow-up ping | `scheduleNativePing()`; follow-up is a WebView `setTimeout` | — | UNVERIFIED | — | Follow-up may not fire when backgrounded/killed |
| 26 | Logging | Quick log during a running task, then Stop | No contract on double coverage | Ping, quick log (asserted created), stop | PASS (invariant) + DECISION D-2 | `S2: quick log during a running task…` (annotation: 2 entries, 10 min covered twice) | Union totals correct; `blockIntervalMin` sums double count |
| 27 | Logging | Repeat-last ("Continue") creates one entry with the last activity | — | Asserted in #18/#26 setup | PASS | same tests | — |
| 28 | Logging | Automatic tracking never rewrites an overlapping manual entry; stale remote copy cannot overwrite it | Manual precedence; `resolveEntrySync()` LWW | `autoLogBlock()` + stale remote write | PASS | `S8: automatic tracking never rewrites…` | Same-id edits on two devices = last writer wins (by design) |
| 29 | Logging | Template auto-log suppressed by manual coverage, deterministic ids, idempotent heartbeat | Scheduled auto-log contract | Existing | PASS (existing) | `smoke.spec.js` due-check / occurrence-ID / coverage tests | — |
| 30 | Logging | Two retro logs crossing the same midnight | Exactly-once, never lose logged time | `quickRetroLog()` ×2 (local creation asserted) | **FAIL F-6** | `F-6 KNOWN FAILURE…` | Remote loses a segment |
| 31 | Logging | Two retro logs ending in the same minute | same | `quickRetroLog()` ×2 (local creation asserted) | **FAIL F-7** | `F-7 KNOWN FAILURE…` | Remote loses an entry |
| 32 | Logging | Cross-midnight timer block keeps exact instants and splits 20/20 by day window | Instants are truth; grouping by authoritative day | Stop across Manila midnight | PASS | `S9: a timer block across local midnight…` | Stored `date` = stop day here, start day in `autoLogBlock()` (grouping uses instants; low impact) |
| 33 | Logging | Gap detection | `computeGaps()` anchor rules (Hard Rule 3) | Existing | PASS (existing) | `smoke.spec.js`, `analytics-truth.spec.js` | Not re-verified by new tests |
| 34 | Sync | Offline log kept locally, pushed on reconnect ("saved locally" toast is stub-dependent) | Reconnect handler pushes when `ta3-lv > ta3-last-sync` | Stub offline | PASS (stub) | `S6: an entry logged while offline…` | Real SDK offline queue not modeled |
| 35 | Sync | Offline log survives an offline reload, pushed on reconnect | same | Stub, reload offline | PASS (stub) | `S6: an offline entry survives a reload…` | Real SDK reconnect ordering unverified |
| 36 | Accounts | Account A's offline entry never reaches account B; reaches A on return | Account isolation | Offline, switch, reconnect | PASS (stub) | `S7: an offline entry of account A…` | — |
| 37 | Accounts | Timer/Away/Break and device-local isolation across switches | Isolation V1 suites | Existing | PASS (existing) | `timer-away-account-isolation.spec.js` (23), `device-local-account-isolation.spec.js` (12), `cross-store-account-isolation.spec.js` | — |
| 38 | Focus | Focus reload restore, exactly-once receipts, expired restore capped | Focus reload recovery | Existing | PASS (existing) | `focus-reload-recovery.spec.js` (27) | Historical pre-fix Focus entries not quarantined → KNOWN |

## Confirmed failures (reproduced, pre-existing, not fixed here)

All of these reproduce deterministically in Chromium. Affected surfaces: the web app and the Android
WebView, which run the same `index.html`/`storage.js` code.

**F-1: Offline session lost on "accidental" recovery after more than one interval**
(`handleRecovery(false)`).
- Steps: start a timer with no connectivity (no remote timer copy exists); the app is terminated at
  +5 min; reopen offline at +45 min; tap "No, it was accidental"; reconnect.
- Observed: `running=false`, no entry, `ta3-timer` record removed, nothing to re-adopt.
- Cause: `restoreTimerAwayState()` restores only while `elapsed < totalSecs`. The expired branch then
  calls `doPing()` with `running=false`, and the next `persist()` deletes the timer record.

**F-2: Expired recovery never clears the heartbeat (offline).**
- Steps: same setup, but tap "Yes, I closed it intentionally".
- Observed: the session is logged once, but `ta3-heartbeat-ts` stays, because `_stopHeartbeat()` resolves
  no owner room (the timer was never re-owned). Every later open shows the recovery prompt (Hard Rule 4).
- Online, remote re-adoption masks this.

**F-3: Silent session drop after a missed ping (offline).**
- Steps: the page is throttled, so the due ping never runs; the heartbeat is 30 s old; reopen 1 min later.
- Observed: no prompt (gap < 2 min), timer not restored (elapsed ≥ interval), no entry, record deleted.

**F-5: Quick log stores a duration its instants do not support.**
- In `_doQuickSave()`, `blockIntervalMin = Math.round((now − tsStart) / 60000) || settings.intervalMin`.
- Trigger: a quick log saved less than 30 s after its anchor (`blockStartTime`). The rounding gives 0, so
  the field falls back to the interval (30). In the test, the save is 10 s after `doPing()` reset the
  anchor: `blockIntervalMin` = 30 while `ts − tsStart` = 10 s.
- Display is unaffected (`entryDurationMinutes()` uses the instants and shows 1 min). But `insights.js`
  sums `blockIntervalMin` directly (hour buckets, activity/waste maps), which adds phantom minutes.
- **Frequency is unverified.** It depends on real-device timing: how soon after a notification-driven
  resume `doPing()` runs, and how fast the user taps. Neither has been measured on Android or in the
  service-worker path.

**F-6: Retro logs crossing the same midnight collide on id `midnight − 1`.**
- Steps: view 2026-10-13; log "Movie 22:30–00:30", then "Sleep 23:45–07:00".
- Observed: all 4 segments exist locally, in memory and in the account slot, but two share an id.
  Remotely only 3 exist: `entries/e_<midnight−1>` holds Movie, and Sleep's 15-min pre-midnight segment
  is gone.

**F-7: Retro logs ending in the same minute collide on id `tsEnd`.**
- Steps: log "Lunch 12:00–12:30", then "Email 12:15–12:30".
- Observed: both exist locally (same id); remotely only Lunch. Another device, a reinstall or cleared
  storage loses Email.
- Data Doctor's duplicate-id repair could also drop one locally (untested).

## Design decisions needed

**D-1: The foreground ping is sound-only since `2f95922`.**
The banner's "Log it" button and the in-page `Notification` were removed. CODEMAP ("sound + modal") and
DECISIONS #17 ("before logging a ping") still describe the old behavior; QA.md also quotes an outdated
`doPing()` guard line. Decide: restore an in-app prompt, or update the docs.

**D-2: A quick log during a running task doesn't consume time from the task timer.**
Stop covers the same minutes again (executed: 10 min covered twice). Decide whether a ping-tap log should
advance the task anchor.

**D-3: "Pause" is not a feature.**
The running-state button opens Break. Confirm that Break is the intended pause.

**D-4 (was F-4): Which interval should a notification-tap quick log cover?**
- Executed fact: after the ping, the log covers `[ping instant, save]`, not the completed block. In the
  test, the entry's `tsStart` = T0+30:05, not T0.
- The two contracts conflict:
  - The notification copy ("⏱ Time block complete — log it now" / "You were on: …"; SW: "What were you
    doing?") and CODEMAP's "was this block one of your planned items?" imply the **completed block**.
  - The quick-log UI header, from source `openQuickLog()`, reads "PING #n · Last <minutes since
    `blockStartTime`>". It truthfully shows the post-ping span it will log.
- Decide which contract is authoritative. The F-4 test stays expected-fail against the notification-copy
  reading until then.

## Coverage gaps

- Quiet-hours ping suppression (#23).
- **Reopen with the app's auto-start active (#12).** The harness forces `ta3-session-started`, so desktop
  "PC Time" and mobile auto-start never run on reopen, including after F-1/F-3.
- Single-account Break across reload/termination; corrupt `ta3-timer` JSON on restore.
- Near-simultaneous Stop on two devices (theoretical duplicate entry).
- Real Firebase SDK behavior: pending (not rejected) offline writes, offline `once()`, reconnect ordering.

## Platform verification

| Platform | Verified here | Unverified (needs a device) |
|---|---|---|
| Windows desktop browser (Chromium) | Every PASS/FAIL row above (headless Chromium, stub Firebase) | Real background-tab throttling, SW ping delivery, OS notification UI, real SDK offline behavior |
| Android Capacitor app | JS bridge behavior with denied permission (fake plugin) | Notification delivery timing, Doze/exact alarms, tap→resume event ordering (governs D-4/F-5 frequency), follow-up ping, offline cold start (ROADMAP Phase 12.0B not started), UsageStats auto-log |
| macOS browser (Chrome/Safari) | Not run (Chromium only) | Safari/WebKit storage, notifications, SW lifetime |
| iOS browser / PWA | Not run | No native app exists. Background pings need Home-Screen PWA + Web Push, which ChronaSense does not implement: **do not claim iOS ping support** |

## Known accepted limitations

- Historical expired-Focus entries are not retroactively quarantined (Evidence Contract, "Expired Focus").
- Phase 12.0B (Android runtime compatibility + offline cold start) is not started (ROADMAP).
- `npm test` keeps one environment-gated cross-repo control skip. `npm run lint` has 47 pre-existing
  warnings.

## Device acceptance checklist (manual)

Use a test account. For each check, record pass/fail, the entry's start and end, and whether the remote
copy appears (on a second device or the web).

| # | Check | Windows browser | Android app | macOS browser | iOS Safari/PWA |
|---|---|---|---|---|---|
| 1 | Start a timer; reload at +10 min. Expect the same task and start time; Stop logs one entry from the original start | ☐ | ☐ (swipe-kill, reopen) | ☐ | ☐ |
| 2 | Leave in the background 35 min with interval 30. Expect a notification within ~1 min of due | ☐ (tab hidden) | ☐ (screen off) | ☐ | Expected: none (unsupported) |
| 3 | Tap the notification and choose an activity, once quickly (< 30 s) and once slowly. Record the logged start/end and stored duration (measures D-4/F-5 on the device) | ☐ | ☐ | ☐ | n/a |
| 4 | Deny notification permission, start a timer, log. Expect no crash and the entry saved | ☐ | ☐ | ☐ | ☐ |
| 5 | Airplane mode: stop a timer, reload, re-enable the network. Expect the entry on the second device | ☐ | ☐ | ☐ | ☐ |
| 6 | Kill the app mid-session, reopen after 45 min **offline**, choose "accidental". F-1 expected until fixed; also note whether auto-start fires | ☐ | ☐ | ☐ | ☐ |
| 7 | Two devices, timer started on device A. Expect only A to ping; Stop on B logs exactly one entry | ☐ | ☐ | ☐ | ☐ |
| 8 | Sign out, sign in as another account. Expect no timer, entry or plan from the first account | ☐ | ☐ | ☐ | ☐ |
| 9 | Run a timer across local midnight. Expect one entry and a correct timeline split on both days | ☐ | ☐ | ☐ | ☐ |

## Next recommended task (exactly one)

**TASK-014: notification-tap quick log records the completed block, with a measured duration (F-5 +
D-4/F-4).**

**Why.** It sits on the critical loop itself (ping → log). F-5 is a confirmed defect in the stored
evidence. F-4 is a confirmed behavior whose contract is disputed.

**Caveats.** How often this happens on real devices is **unverified** (checklist #3 measures it). The
other candidates:
- F-6/F-7: deterministic remote loss, but needs specific retro-log coincidences.
- F-1/F-3: needs offline plus termination.

**Unresolved dependencies (must be settled before implementation):**
- **D-4**: which interval a ping-tap log covers. The F-4 half of the task exists only if the owner picks
  "completed block".
- **D-2**: whether the task anchor advances after a ping-tap log. Logging the completed block without
  advancing it doubles the D-2 overlap from seconds to a full interval.
- **D-1**: whether a foreground ping prompts at all. That decides whether the same completed-block path
  must also serve an in-app prompt.

The F-5 half (duration always derived from the logged instants) is decision-independent.

**Potential red-zone reach.**
- Always: `index.html` Ping & Quick-Log (`doPing()`, `openQuickLog()`, `_doQuickSave()`, `snoozeLog()`).
- If the completed-block window must survive a cold start from the notification tap: `storage.js`
  `persist()` / `restoreTimerAwayState()` and the local `ta3-timer` record (timer restore, Hard Rule 8).
- If D-2 advances the task anchor: `stopAndLog()` / the timer core.
- If other devices must see the window: `syncTimerState()` and the RTDB `timer` object (sync red zone;
  excluded unless separately decided).
- Every variant creates entries, so Hard Rules 7–9 apply.

**Acceptance tests.**
- Remove `test.fail` from F-5 (and from F-4 if D-4 = completed block) and make them pass.
- A quick log *before* any ping keeps today's behavior.
- Tap → reload → log still logs the agreed interval.
- The snooze path follows the same rule.
- Every quick-log entry satisfies `|blockIntervalMin − (ts − tsStart)| < 1 min`.
- The D-2 behavior matches the decision.
- Full `npm test`, smoke and fence pass.

**Risk.** Red-zone → review gate `approved` (held; the owner merges). Rollback is a revert; no data
migration; historical F-5 entries are not repaired.

**If the owner cannot settle D-2/D-4 first**, the decision-free alternative is unique retro entry ids
(F-6/F-7).
