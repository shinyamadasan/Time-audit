# TASK-015 — Independent Review Handoff

Unified My Day + Brain Dump V1 (planning tray). For a reviewer who did not build this task. The builder
self-reviewed; that is not independent review.

- Branch `task-015`, base `origin/main` `cbd82fc` + planning commit `d29f508`. Not pushed, not merged, not deployed.
- Runs in parallel with TASK-014. Per the task, it must be reconciled onto origin/main after TASK-014 lands and
  re-tested before independent review. That has NOT been done here.
- Confirm scope: `git diff --stat cbd82fc..task-015`.

## What changed and why

- `brain-dump-ui.js`: the tray is rendered by this module, not a new one, so it shares `pendingPromotionIds`,
  the reconciler and the promotion path with the Brain Dump view.
  - `renderTray()` fills `#bd-plan-tray`. With 0 untriaged and 0 triaged captures the section is `hidden` and
    emptied, so it has zero height.
  - Collapsed header: "Brain Dump · N to plan · M to triage". The expanded state is stored per device in
    `ta3-bd-tray-open`, with try/catch. It is collapsed by default.
  - Expanded view: triaged rows sorted do-first > schedule > delegate > archive, then createdAt (stable sort).
    The first 5 rows show, then "Show all (N)" expands inline. Each row has a 2-line clamp, a quadrant chip and
    "Today · <date>" / "Tomorrow · <date>".
  - Untriaged preview: up to 3 texts, read-only. The "M to triage" button calls `showView('braindump')`.
  - Today calls the existing `doToday()`. Tomorrow calls the new DOM-free `scheduleTo(id, { dateKey, when,
    durationMinutes })`, which was extracted from `confirmSchedule()`. Both surfaces now use it.
  - Tomorrow is rendered only when `dayForScheduledDate(date, '')` resolves to `next(current()).id`. The date
    label comes from `trayDateHint()`, which mirrors `taskDateHint`.
  - Midnight guard (`trayPlace`): each button carries the today id, target id and date it was rendered for in
    `data-bdt-*`. On tap, the guard recomputes them. On any mismatch it shows "The day just changed — check
    where this goes.", re-renders and writes nothing. No `await` sits between the guard and the promotion's
    synchronous target resolution.
  - A pending id shows "Still confirming…" with no Today/Tomorrow buttons.
  - `render()` calls `renderTray()`. `refreshBrainDumpSurfaces` re-renders the tray when the Brain Dump view is
    not the active view, which covers remote changes and rebinds. `globalThis.refreshBrainDumpTray` is exposed.
- `index.html`: four changes, all in the regions the contract names:
  - the section after `#planning-continuity-section`;
  - `globalThis.refreshBrainDumpTray?.()` in `refreshAuthoritativePlanSurfaces()`;
  - a `brain-dump-tray.css` link;
  - Brain Dump token `20261012-brain-dump-action-attribution-v1` -> `20261015-task015-plan-tray-v1` (5 import-map
    entries and 2 entry tags). The governed token is unchanged.
- `brain-dump-tray.css` (new): scoped to `#bd-plan-tray` / `.bdt-*`. It uses `#bd-plan-tray .btn.sm.bdt-btn` so
  the 44px touch target at <=520px outranks style.css's `#view-today .btn.sm { min-height: 40px }`.
- `personal-day-boundary-web-runtime.test.js`: the `BRAIN_DUMP_RELEASE` pin moves to the new token, and the old
  token is added to the retired list. This is the only existing test edited, and the token bump requires it.
- `www/` mirror regenerated. Docs updated: CODEMAP.md, CHANGELOG.md, TEST_REPORT.md, TASKS.md (status only plus
  checkboxes).

No edits to the protected modules, rules, functions, workers, storage.js or timer/heartbeat code.

## Reproduce

```
npm ci --legacy-peer-deps            # plain npm ci fails ERESOLVE (pre-existing; CI uses the same flag)
npm test
npm run lint
npm run check:www-parity
npm run check:firebase-rules
git diff --check
npx playwright test tests/brain-dump-plan-tray.spec.js tests/brain-dump-eisenhower.spec.js tests/brain-dump-production-ux.spec.js tests/planning-continuity.spec.js tests/planning-continuity-fixes.spec.js tests/my-day-timeline.spec.js --workers=2
npm run test:smoke -- --workers=2
npm run test:fence
```

## Evidence (executed on the final sources, 2026-10-15)

| Command | Result |
|---|---|
| npm test | exit 0. node:test: 2179 total, 2178 pass, 0 fail, 1 env-gated skip. Legacy runner: 455/455. |
| npm run lint | exit 0. 0 errors, 47 warnings both before and after the change (delta 0). |
| check:www-parity | OK (92-file closure). |
| check:firebase-rules | "firebase.rules.json matches the builder". |
| git diff --check | clean. |
| new spec | 14/14. |
| targeted 6-spec run (2 workers) | 106/106. |
| full smoke (2 workers) | 906 passed, 0 failed, 18.8m. TASK-013's 7 declared `test.fail` cases behaved as declared. |
| test:fence | 80 + 20 + 37 passed. Not required, since there is no rules change. |

Mutation checks were temporary edits, reverted afterwards. Each one made its targeted test fail:

- dropping the midnight guard broke F8;
- dropping the Tomorrow round-trip check broke the F2 "omitted" test;
- dropping the tray's pending state broke F9.

Spec coverage map (`tests/brain-dump-plan-tray.spec.js`):

| Criterion | What the spec checks |
|---|---|
| F1 | `bdp1\|id` is in `items(current())` and not in `next`. The view stays My Day, and the row renders in `#timeline-anytime`. |
| F2 | The label is "Tomorrow · Fri, Oct 2", matching `scheduledDateForTarget(next)`. The item is in `items(next)` only. `#timeline-nav-next` shows it, and Recently handled says "Scheduled · Fri, Oct 2". A second test stubs `dayForScheduledDate` (wrong target, then failure) and checks that Tomorrow is omitted while Today stays. |
| F3 | A dblclick plus a stale re-tap give exactly one item. Two tabs share one localStorage-backed stub remote; the tray tab and the Brain Dump view tab tap together, then the tray tab taps again stale. Each case yields exactly one item and no false conflict toast. |
| F4 | 150 triaged + 12 untriaged: 5 rows, "Show all (150)", 3 preview rows, collapsed tray <=56px. Quadrant order holds after Show all. No nested scroller. The triage link opens the Brain Dump view. |
| F5 | Hidden with `offsetHeight` 0, both initially and after the last capture is archived. |
| F6 | A rejected claim transaction shows the existing offline toast. There is no plan item, no claim, and the capture stays triaged; checked for both Today and Tomorrow. |
| F7 | After `onAuthStateChanged(B)`, the tray is hidden with empty innerHTML. |
| F8 | Rendered at 23:59, then the clock change and the tap happen in one task. The tap is refused, nothing is written, the labels move to Fri/Sat, and the same holds for Tomorrow at the next midnight. A tap on the fresh render lands on exactly the labelled date (2026-10-04). |
| F9 | A held transaction shows "Still confirming…" with no buttons in the tray, and no Do today/Schedule in the Brain Dump view. After release there is exactly one item. |
| F10 | At 390x844: no horizontal overflow, all 13 tray buttons are >=44px tall and inside 390px, and the 2-line clamp holds. Screenshots are taken. |

The spec also checks that the expanded state survives a reload, and that the tray adds no duplicate ids (it has none).

Screenshots are gitignored and not committed. They are regenerated by every run of the F10 test:

- `playwright-report/task-015/tray-390x844.png`
- `playwright-report/task-015/tray-390-element.png`
- `playwright-report/task-015/tray-1920x1080.png`
- `playwright-report/task-015/tray-1920-element.png`

## Deviations / interpretations

- **F9 wording.** The Brain Dump view keeps its existing pending copy, "Still confirming a previous action…",
  because existing specs pin it and F11 forbids changing them. The tray says "Still confirming…". Both satisfy
  "no Today/Tomorrow while pending". If the exact string is required on both surfaces, that is a one-line copy
  change plus an edit to `brain-dump-production-ux.spec.js` test F.
- **F11 "unchanged".** One existing node test, `personal-day-boundary-web-runtime.test.js`, had its Brain Dump token
  pin updated. The mandated token bump requires this.
- **F6 "refused claim".** This is exercised as a definite transport rejection of the claim transaction, which is the
  path that produces the existing offline copy. A server-side arbitration refusal (`already-claimed` /
  `already-disposed`) shows different, pre-existing copy and was not separately tested from the tray.
- **Show all.** There is no "show less". Collapsing the tray resets it.

## Known limitations / not verified

- All browser tests use the legacy calendar-day store, like the other Brain Dump specs. Calendar-native and
  Personal Day boundary accounts are not exercised in the browser. There, the date label falls back to the
  target's start date, and Tomorrow is omitted whenever the round trip fails.
- The tray's date labels can go stale while the page sits open across midnight until something re-renders it. The
  guard makes a stale tap refuse rather than misplace. Nothing re-renders the tray on a timer.
- A real multi-device race and real Firebase are not tested. Neither is an Android/Capacitor build.
- `planning-continuity.css` references an undefined `--bd` variable (pre-existing). The tray uses `--border`
  instead. Noted, not changed.
- Not reconciled onto main after TASK-014. Both tasks touch index.html, so expect at least import-map/token-adjacent
  conflicts.
