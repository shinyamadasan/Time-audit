# TASK-014 — Independent Review Handoff (Normal Tracking HUD V1)

For a fresh reviewer who did not build this task. The builder self-reviewed; that is not independent review.

- Branch `task-014`, base `origin/main` `cbd82fc463d6a48aa9e32949f95264a0a48f3528`. Not pushed, not merged.
- Confirm scope: `git diff --stat cbd82fc..task-014`.
- ID note: TASK-013's closure text proposed a different, unscheduled "TASK-014" (notification-tap quick log, blocked
  on owner decisions D-2/D-4). This owner-direct task took the id; that proposal needs a new id when scheduled.

## What changed (runtime)

| File | Change |
|---|---|
| `windows-hud-bridge.js` | Projects ONE session: Focus (pushed by focus-mode.js) first, else `getHudTrackingFields()`, else nothing. New `tracking-active` snapshot; every snapshot carries a title-free `sessionKey` and per-tab `claimedAt`. 1 s selector poll (only when a selector is supplied) sends on change only; 4 s heartbeat repeats; one `focus-ended` per clear. New page-internal `refresh()`. |
| `index.html` | `getHudTrackingFields()` (read-only selector) and `refreshHudTracking()` in the Timer section; one-line `refreshHudTracking()` after `_startTimer()`, `resetTimer()`, `startBreak()` and the Away stop block. Governed release token moved to `20261014-task014-normal-tracking-hud-v1` (storage.js changed). |
| `storage.js` | One read-only `refreshHudTracking()` call at the end of `detachTimerAwayRuntime()` (sign-out / account switch). |
| `windows-hud/ChronaSenseHud.ps1` | Accepts `tracking-active`; validates optional `claimedAt`/`sessionKey`; `Resolve-HudSnapshotUpdate` arbitration (202 = superseded, no body); TRACKING render with `Xm on task`; hide lasts until the hidden session kind is gone; hide wording follows the kind. |

No Firebase schema/rules, Action API, Worker, OAuth or Function change. No new write of any kind: the selector and
bridge read globals only; the companion answers with status codes only.

## Reproduce

```
npm ci --legacy-peer-deps
node --test windows-hud-bridge.test.js                         # 33
npx playwright test tests/normal-tracking-hud.spec.js --workers=1   # 14
pwsh -File windows-hud/Test-HudNormalTracking.ps1              # 56 assertions
pwsh -File windows-hud/Test-HudDogfoodPolish.ps1               # 30 assertions (pre-existing, unchanged)
npm test; npx playwright test --workers=2; npm run lint; npm run check:www-parity; npm run check:firebase-rules; npm run test:fence
```

Builder mutations (edit, run, `git checkout -- <file>`):

| Mutation | Caught by |
|---|---|
| M1 remove `refreshHudTracking()` from `resetTimer()` | spec "stop -> cleared at once" (1 fail) |
| M2 bridge prefers tracking over Focus | unit tests (3 fail); browser spec does not fail because the selector also rejects Focus state — two layers |
| M3 drop the device-owner check in the selector | spec "timer owned by another device" (1 fail) |
| M4 remove `refreshHudTracking()` from `detachTimerAwayRuntime()` | spec "sign-out" (1 fail) |
| M5 re-stamp `claimedAt` on every send | spec "two tabs" + "repeated identical" (2 fail) |

All five re-run on the final candidate: M1 2 fail, M2 3 unit fails (browser 14/14), M3 1, M4 1, M5 2. A `pomodoroWasPaused`
guard was tried and removed: every `startPomodoro()` path runs after `enterFocusMode()` has already stopped the normal
timer, so the guard could not fire (its mutation went uncaught).

## Please check specifically

1. **Selector truth** (`index.html`, `getHudTrackingFields`). It must return non-null only when ChronaSense itself
   says a normal timer runs on this device for this account. Attack: Focus, synced Focus mirror, break, Away,
   another device's timer, sign-out.
2. **Arbitration** (`Resolve-HudSnapshotUpdate`). Can any interleaving of two tabs leave a stopped session on
   screen, or permanently lock out a legitimate new session? The builder's argument: a stale tab only resends an
   old key with an older claim; ends only clear the shown key; floors rise only on acceptance. Clock-jump caveat in
   README Known gaps.
3. **Focus regression.** Focus field set and values are unchanged; `focus-ended` gained `sessionKey`/`claimedAt`.
   An old companion rejects `tracking-active` with 400 (Focus keeps working); a new companion accepts an old page.
4. **Red zone.** Four one-line calls in timer code plus one in `storage.js`; none mutates state. Hard rules 4
   (`_stopHeartbeat()` on clean exits) and 7 (`doPing()` device guard) are untouched.

## Finding H-1 (pre-existing; documented, not fixed)

After a Focus **break ends inside the Focus overlay** (no auto-start, Focus not exited), ChronaSense turns the Focus
timer into a normal running timer. Path (observed with the in-memory RTDB stub, stack trace captured during the
build): `syncFocusTimerState()` writes `rooms/{room}/timer` with `mode:'focus', running:true` → the local listener
echo runs `applyRemoteTimerState()`, which sets `running = true` and starts a normal ticker (`storage.js` ~1961)
→ when the break interval elapses, `doPing()` → `syncTimerState()` writes `mode: null` → the Today hero shows
"tracking · <Focus task> · pinging every 5 min" from the break's start. The HUD then shows `TRACKING · <Focus task>`
because that is what ChronaSense reports; it never projects it while Focus is active
(`tests/normal-tracking-hud.spec.js` "Focus break ends inside the overlay"). The real SDK also delivers local writes
to local listeners, but this was not reproduced against production.

**Bounded recommendation (separate task, owner approval, red zone):** make the non-auto-start branch of
`endPomodoroBreak()` end the shared Focus timer the way `finishLearningPlanFocusSession()` already does —
`_stopHeartbeat()`, `syncTimerState({ stopped: true, lastTask: null, mode: 'focus', ownerRoom })`,
`releaseTimerStateOwnership(ownerRoom)`, clear `timerOwnerDeviceId`/`currentTask` — so the echo leaves no normal
timer behind. Acceptance: after break-done, `running === false`, remote timer `stopped`, no `mode:null` timer
write, no extra entry, Focus "Start next session" still works. Not done here: it changes timer lifecycle, which
this brief excludes.

## Known limitations

See `windows-hud/README.md` → Known gaps (TASK-014 items): no tracking after Focus (entering Focus logs and stops
the normal block), breaks/Away clear the HUD, ≤1 s lag on unhooked timer paths (longer in a throttled background
tab), single-machine clock trust for arbitration, a stale lone tab is dropped not corrected, H-1 above. Windows
companion behavior was verified with AST-extracted functions and mocked WPF objects, not with a live window, real
browser Local Network Access prompt, or a real second Chrome tab against a running companion.

## Gate if accepted

Red-zone adjacent (timer call sites, storage.js, governed release token). Hold at `approved` (the owner merges);
no auto-merge.
