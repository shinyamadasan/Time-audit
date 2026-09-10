# ChronaSense — Changelog

## Plan Linkage + Up Next Ordering V1 — targeted fixes from independent review (same candidate) — 2026-09-10

An independent review verdict of **FIX FIRST** (architecture accepted, four confirmed defects)
was addressed before landing:

1. **UP NEXT could contradict the plan strip's own chronological order before anything was due**
   (e.g. at 08:00 with `13:00` typed before `09:00`, UP NEXT recommended the 13:00 item).
   `getNextPlanItem()` no longer requires an item to be "due" for its own scheduled time to
   matter — among not-done, unworked candidates it now reuses `planDisplayOrder()` (earliest
   parseable time first, then everything else in stable order) instead of raw array/insertion
   order. `dueTimedPlanItem()` (the separate, still due-gated check that decides whether a timed
   one-off outranks a due-now routine) is unaffected in its own due-gating, only in tie-breaking.
2. **An already-worked-on-but-not-done morning item could permanently block a newly-due
   afternoon item** from ever reaching UP NEXT. Both `getNextPlanItem()` and `dueTimedPlanItem()`
   now rank unworked candidates (`planTrackedMin === 0`) ahead of worked-on ones (new
   `unworkedPlanItems()`/`workedOnPlanItems()` helpers) — restores the two-tier preference the
   pre-linkage fallback always had, which the due-time fast path had silently dropped.
3. **The `when` input was freeform text with a content-free placeholder**, so a normal `9am` /
   `9:00` / `09:00 AM` entry silently produced no due-time behavior at all. `#plan-when` is now a
   native `type="time"` input (the same convention already used in eleven other places in this
   app), guaranteeing canonical `HH:MM` output for new entries with no natural-language parsing
   added. Historical free-text `when` values already stored are untouched and still display
   safely (never migrated, never rewritten).
4. **The plain (non-Focus) running timer's plan link did not survive a page reload**, while every
   other piece of that timer's state — task, elapsed time, even the cross-device owner id —
   already did. `persist()`/`load()` (`storage.js`) now write/restore `planItemId` in the
   `ta3-timer` blob alongside the existing fields; a pre-migration blob with no `planItemId` key
   restores with `null` (no fabricated linkage), matching every other optional-field migration in
   this codebase.

Not changed: the accepted architecture (optional `planItemId`, id-preferred/text-fallback
matching, no fuzzy matching, no new completion states, no Timeline layer, no new user action, no
settings toggle for the routine-vs-priority precedence).

tests: 9 new regressions in `tests/plan-linkage-up-next.spec.js` (before-first-due ordering,
worked-on stickiness, plain-timer reload incl. a pre-migration-blob compatibility check, Focus
reload, two switch-no-leak adversarial cases, the multiple-overdue tie-break pinned as
intentional, and the `type="time"` input change). 3 pre-existing tests in `tests/plan.spec.js`
were updated (not weakened) for the `type="time"` change — they used free-text `when` values
(`"first block"`, `"after lunch"`) that a native time input can no longer accept on entry;
historical free-text display itself stays covered by the new spec's own test. Full `npm test`
(451), `npm run lint` (0 errors; 33 warnings — 31 prior + 2 new `no-undef` on
`currentTaskPlanItemId` referenced in `storage.js`, same expected cross-script-file class as
before), full `npx playwright test` (428/428, 0 failures this run), `node
scripts/runtime-mirror.mjs --check` (clean after `--write`).

## Plan Linkage + Up Next Ordering V1 (feat/plan-linkage-up-next-v1, candidate, uncommitted) — 2026-09-10

Closes the two real gaps a Plan-to-Actual daily-loop audit found in an otherwise-shipped
feature: plan-to-actual matching was pure text equality (a rename between planning and starting
silently misclassified real work as "not done"), and UP NEXT ignored a planned item's own time,
letting a due-now routine pre-empt a deliberately-scheduled priority. No new UI, no new
completion states, no Timeline change, no structured-duration schema — both fixes are additive
and backward-compatible.

added (`index.html`):
  - `currentTaskPlanItemId` — parallels `currentTask`; set only by a plan-linked
    `_startTimer()`/`switchToTask()` call (i.e. `startPlanItem()`), reset to `null` by every other
    start path and by `resetTimer()`. Consumed by every site that logs the block it names
    (`stopAndLog`, `switchToTask`, `switchTaskMidBlock`, `startBreak`→`autoLogBlock`,
    `enterFocusMode`'s pre-Focus auto-log), stamping the resulting entry's optional `planItemId`.
  - `parsePlanItemTime(when)` — bounded parser: only an unambiguous zero-padded 24h `HH:MM`
    (`09:00`, `13:30`) is ever treated as a real time; anything else (blank, "after lunch",
    "9am") is left unparsed.
  - `dueTimedPlanItem(items, dateKey)` — the earliest not-done one-off whose parseable `when` is
    at/before right now, or `null`. Ties resolve to the earlier scheduled time.
  - `planDisplayOrder(items)` — display-only projection for the plan strip (timed items first,
    earliest first, then everything else in its existing stable order); never rewrites the
    persisted item array.

changed (`index.html`):
  - `planTrackedMin(task, dateKey, planItemId)` — prefers an exact `planItemId` match; unlinked
    entries (no `planItemId`) still fall back to the legacy normalized-text match. An entry
    linked to a *different* plan item never counts, even on a text coincidence. Callers
    (`renderTodayPlan`, `getNextPlanItem`, `renderReviewPlanVsActual`) now pass the item's id.
  - `isPlanTaskActive`/`getPlanItemStatus`/`getActivePlanItem` — same id-preferred, text-fallback
    rule, so a mid-run rename doesn't lose "In progress" status.
  - `getNextPlanItem()` — checks `dueTimedPlanItem()` before its existing tracked-minutes
    ordering.
  - `todayGuidedAction()` — new precedence: remote → Focus/break/away/running → **a due timed
    one-off** → due-now routine → next remaining one-off → anytime routine → free-text fallback.
    A due timed priority now outranks a due-now routine (previously the routine always won,
    undocumented anywhere as a deliberate choice).
  - `startPlanItem(id)` passes the item's id into `_startTimer`/`switchToTask`.
  - `renderReviewPlanVsActual()`'s "unplanned" bucket now also excludes entries whose
    `planItemId` matches a planned item (previously text-only), so a renamed-but-linked entry is
    never double-counted as both "worked on" and "unplanned".

changed (`focus-mode.js`):
  - `pendingFocusPlanItemId`/`activeFocusPlanItemId` — mirror the existing
    `pendingFocusLearningPlan`/`activeFocusLearningPlan` pending→active→cleared lifecycle.
    `enterFocusMode({planItemId})` (only `focusTodayAction()` ever passes one, from
    `todayGuidedAction()`'s `state.planItemId`) → `startPomodoro()` commits it → `logFocusSession()`
    stamps it on the completion entry. Persisted/restored across reload alongside the learning-plan
    context. A daily-routine-linked Focus session never receives one.
  - The pre-Focus auto-log in `enterFocusMode()` (when entering Focus while a plain-timer block
    was already running) now also stamps that outgoing entry from `currentTaskPlanItemId`.

not built (deliberately out of scope): structured time/duration fields, any Timeline plan layer,
PC-time fragment collapsing, the mid-day-add-not-in-preparation edge case, any new completion
state, any change to Plan Tomorrow's routine section, cross-device sync/persistence of
`currentTaskPlanItemId` itself (an in-progress, not-yet-logged plain-timer block's linkage is
best-effort and resets on reload — only the Focus-session linkage is reload-durable, matching how
`activeFocusLearningPlan` already behaves).

tests: 18 new scenarios in `tests/plan-linkage-up-next.spec.js` (A–R from the milestone spec:
linkage survives Start/Focus/rename, legacy text-match preserved, unplanned work never
double-counted, Done stays independent of tracked time, removed items still show Removed, the
`when` parser and due-time precedence including routine-vs-priority, a routine-linked Focus never
picks up a stray plan item id). Full `npm test` (465), `npm run lint` (0 errors; 31 warnings — the
29 pre-existing plus 2 new `no-undef` on `currentTaskPlanItemId` in `focus-mode.js`, the same
class of expected cross-script-file warning already present for `updateTimerTaskLabel`/
`cancelNativePing`/etc. in this codebase), full `npx playwright test` (419/419), `node
scripts/runtime-mirror.mjs --check` (clean after `--write`).

## Coarse Evidence Durability V1 — independent-review fix pass (same candidate) — 2026-09-10

Three findings from an independent review, fixed before landing (no rebuild, same architecture):
- `coarse-life-evidence-repository.js` `save()` now stamps `undoRestoredAt` when a save lands on
  a tombstoned identity (plain Add or a rename/date-move onto a free identity) — without it, a
  resurrection (delete then re-add) never propagated to a device that already held the tombstone,
  since `resolveCoarseEvidenceSync`'s guard requires that marker. Mirrors the existing `entries[]`
  precedent (`restoreUndoEntries()` in `index.html`).
- `coarse-life-evidence-sync.js` `pushAllLocal()` now diffs against the last remote snapshot the
  bridge observed instead of unconditionally rewriting every local record on every `attach()` —
  fixes both a redundant-write-on-every-reload issue and a narrow window where a stale local
  tombstone could be re-broadcast over a newer remote value on reattach.
- `storage.js`'s existing `.info/connected` reconnect handler now also calls
  `CoarseLifeEvidenceSync.pushAllLocal()` (a no-op once converged, per the diff above), so a push
  that failed while offline is retried on reconnect instead of only on the next edit to that
  record — matching the CHANGELOG's original "syncs later" claim.

Not fixed (documented, deferred): `resolveCoarseEvidenceSync` remains a hand-duplicated copy of
`storage.js`'s `resolveEntrySync` rather than a shared helper — low risk, tracked for a future
consolidation pass, not required to close the durability gate.

tests: 2 new regressions in `coarse-life-evidence-sync.test.js` (cross-device resurrection now
converges instead of staying stuck deleted; reattach with no local changes issues zero redundant
writes) + 2 new in `coarse-life-evidence.test.js` (`undoRestoredAt` stamped on resurrection, not
stamped on an ordinary edit). Full `npm test` (465 cases), `npm run lint` (0 errors, 29
pre-existing warnings), full `npx playwright test` (400/401; the one failure, an unrelated
auto-logged-schedule smoke test, reproduced clean 3/3 in isolation — a pre-existing parallel-run
flake, not a regression from this pass), `node scripts/runtime-mirror.mjs --check` (clean after
`--write`).

## Coarse Evidence Durability V1 (feat/coarse-evidence-durability-v1, uncommitted) — 2026-09-10

Closes the pre-dogfood durability gate: coarse life evidence (Phase 6H) was local-only
(`ta3-coarse-life-evidence-v1`), so another browser/device never saw it and clearing browser
storage destroyed it. Adds an account-scoped durable remote copy — no sharing, no export/import,
no new daily user action, no UI change to Today/Review/Plan Tomorrow. Reuses the identical
record-level `updatedAt`-last-write-wins pattern `storage.js` already runs live for
`entries`/`reviews`/`plans`; not a new sync architecture.

added:
  - `coarse-life-evidence-sync.js` — dependency-injected Firebase sync bridge
    (`createCoarseEvidenceSyncBridge`). Subscribes to `rooms/<roomCode>/coarseLifeEvidence`
    (same private per-user room every other collection syncs through — no `firebase.rules.json`
    change). On first connect, merges remote into local, then bootstrap-pushes any local-only
    records once (migrates a pre-durability install automatically, no user action). After that,
    each save/remove pushes just that one changed record, best-effort and non-blocking.
  - `coarse-life-evidence-sync.test.js` — bridge lifecycle, offline safety, and a two-client
    chaos simulation (concurrent create/edit, and the key resurrection test: a client offline
    during a delete must not resurrect it on reconnect).

changed:
  - `coarse-life-evidence-model.js`: new pure `resolveCoarseEvidenceSync(local, remote, nowTs)` —
    the deterministic conflict rule (last-write-wins by `updatedAt`, with a tombstone-resurrection
    guard requiring an explicit `undoRestoredAt` to override a local delete). New
    `COARSE_LIFE_EVIDENCE_REMOTE_PATH` constant. `validateCoarseEvidenceRecord()` now tolerates
    (and validates) the optional `deleted`/`undoRestoredAt` sync markers.
  - `coarse-life-evidence-repository.js`: `remove()` now tombstones (`deleted: true`) instead of
    erasing the row, so a stale remote/device echo cannot resurrect it — ordinary reads
    (`list()`/`listForDate()`/`get()`) still treat it as gone. New sync-only `getRaw()` /
    `listAllRaw()` (see tombstones) and `mergeRemoteSnapshot()` (record-level remote merge, never
    a collection replace). The rename/date-move collision guard now treats a tombstoned identity
    as free, and a rename tombstones the vacated old identity instead of deleting it outright, so
    a durable remote copy of the old id also converges to "deleted."
  - `coarse-life-evidence-ui.js`: pushes the saved/removed record (and, on a rename, the
    old-identity tombstone) through the sync bridge after every local write; new
    `refreshCoarseEvidenceListIfMounted()`, called by the sync bridge so an open Review reflects
    another device's edit (no-op when Review isn't open).
  - `storage.js`: exposes `globalThis.getChronaSenseRoomRef` (one-line accessor so the sync
    module, an ES module, can read this classic script's `fbRoomRef`) and attaches/detaches the
    sync bridge alongside every other room listener (`startSync()`, sign-out,
    `teardownRoomListeners()`).
  - `contracts/CHRONASENSE_EVIDENCE_CONTRACT_V1.md`: durability implementation-status entry
    added; gate (1) of the pre-Wife/Shared/dogfood list marked satisfied.
  - `tests/coarse-life-evidence.spec.js`: the two `remove()` assertions updated for the tombstone
    contract (still asserts "gone" from every ordinary read; the raw envelope now retains one
    tombstoned row instead of zero).

tests: `npm test` (451 cases incl. the two new/extended coarse-evidence suites), full
`npx playwright test` (401 cases), `npm run lint` (0 errors), `node scripts/runtime-mirror.mjs
--check` (clean after `--write`). No production Firebase writes made or required by any test —
sync tests use an in-memory fake Firebase room ref.

not built (deliberately out of scope): Wife/Shared, export/import, Life Ledger projection of
coarse evidence, a sync-status widget, a "Sync now" action, onboarding rewrite, Focus Wallet /
streak decision.


## Phase 6I/J — Day-to-day UX correction pass (same candidate — feat/review-reconciliation-v1, uncommitted) — 2026-09-10

A REMOVE / HIDE / QUIETEN pass over the 6I/J candidate — no rebuild, no new persistence,
no new daily action. Net default UI decreased. Technical architecture unchanged
(`reviews[dateKey].reconciliation`, `unloggedOk` compat, `computeGaps`/`getCloseoutGaps`,
selected-date ownership, Plan Tomorrow detour, generic Today gap removal all preserved).

changed (`index.html` + `style.css`, mirrored to `www/`):
  - **Reconciliation prompt retoned + re-ranked.** `.rv-gap-check` lost its amber-alarm
    styling for a calm neutral surface. Un-acknowledged: one primary action —
    **Looks about right** — with **Add broad activity** and **Leave unknown** as equal
    secondary ghost buttons and **Log time** demoted to a small text link (`.rv-gap-link`,
    shown only when a >=30m diagnostic gap exists). Acknowledged: the box is gone — a single
    quiet `✓ Looks about right` / `✓ Left unknown` line with two small links, **Add activity**
    and **Change** (was: a bordered box with a sentence and three buttons incl. Revisit/Log
    time). Reconciliation stays available every daily Review (no auto-hide — there is no
    truthful deterministic "whole day known" criterion; `computeGaps()==[]` ≠ complete) but
    is now visually secondary.
  - **`#th-unlogged` removed.** The "Xh Ym unlogged" debt figure is gone from Today Health
    (`computeTodayHealth` no longer computes it; the element and its `.warn` CSS are
    deleted). Raw gaps remain in Timeline, Review's Full analysis, and the Week view.
  - **Generic meal/chore check-ins removed.** `ROUTINE_PROMPTS` (breakfast / lunch / dinner /
    evening) and the whole prompt chain (`getRoutinePromptCandidate`, `routinePromptWindow`,
    `routinePromptAlreadyLogged`, `getDismissedRoutinePrompts`, `markRoutinePromptDismissed`,
    `routinePromptStorageKey`, `quickLogRoutinePrompt`, `dismissRoutinePrompt`) deleted;
    `renderRoutinePrompt()` reduced to "hide `#routine-prompt`"; the `.routine-prompt` /
    `.routine-chip` / … CSS block removed. The passive **Daily basics** quick-log grid and
    all **explicit user routines** / routine errors are untouched.
  - **Close Day copy neutralised**: "Review today, name the leak, pick tomorrow." →
    "Review today, then prepare tomorrow."
  - **"Reflect" nav tab renamed to "Trends"** (nav button text + `#view-reflect` page title
    only — routing, view id, and function names unchanged).

tests: `tests/review-reconciliation.spec.js` +6 UX-pass cases (button hierarchy, neutral
  surface, quiet acknowledged state, no `#th-unlogged`, no meal/chore prompt, neutral Close
  Day copy, "Trends" rename, concrete sleep signal preserved); the two `tests/smoke.spec.js`
  routine-prompt tests replaced by one "generic meal/chore prompts gone; Daily basics still
  works" test; the two `#th-unlogged` smoke tests reworked to assert the stat is absent;
  `tests/review-simplification.spec.js` gap-detour tests now click **Change** before
  **Log time** (acknowledged state has no Log time button).

## Phase 6I/J — Review reconciliation + Today gap replacement V1 (candidate — feat/review-reconciliation-v1, uncommitted) — 2026-09-10

Base `2948e2e2e591e18d7f40bade92c531338b77885a` (origin/main, verified). Isolated worktree;
primary worktree (dirty `README.md` on `docs/phase12-personal-intelligence-design`) untouched;
Meal and Workout source apps untouched. No commit/push/merge/deploy; no Firebase or Obsidian
writes; no historical data migrated.

Scope: the minimum end-of-day reconciliation flow that replaces generic daytime gap nagging
without turning Review into a time-sheet. Reworks Review's existing unlogged-decision block
into one small optional "Anything important missing?" prompt (not gated on gap size), then —
only once that works — removes the generic Today "first gap >= 30m → Needs You / fill gap"
interruption. `computeGaps()` and all raw-gap diagnostics are preserved.

changed (`index.html`, mirrored to `www/`):
  - `renderReviewUnloggedDecision()` — reworked from a gap-gated ("`unloggedMin < 30` → hide")
    two-button block into the always-available (until acknowledged) whole-day reconciliation
    prompt: header "Anything important missing?", helper "Food, care, household time, travel,
    people, or downtime …", and up to four actions — **Log time** (only when a >=30m diagnostic
    gap exists; unchanged gap-jump to the retro editor), **Add broad activity**
    (`openCoarseEvidenceEditor(dateKey)` — the 6H editor, for Review's selected date),
    **Leave unknown**, **Looks about right**. Once acknowledged, reopening shows a compact
    "Looks about right" / "Left unknown" line with **Add broad activity** + **Revisit**, not
    the full prompt.
  - new state var `_reviewReconciliation` (`null` | `'reviewed_ok'` | `'left_unknown'`); loaded
    in `openReview()` from `reviews[k].reconciliation`, with a backward-compat inference:
    a pre-6I record with `unloggedOk: true` and no `reconciliation` field reads as
    `'left_unknown'` (never rewritten).
  - `markReviewUnloggedIntentional()` now also sets `_reviewReconciliation = 'left_unknown'`
    (keeps setting `_reviewUnloggedOk = true` exactly as before). New `markReviewReconciliationOk()`
    (`'reviewed_ok'`) and `resetReviewReconciliation()` (explicit Revisit only).
  - `saveReview()` — persists `reconciliation: _reviewReconciliation || null` through the
    existing durable Review path. `unloggedOk` unchanged (still `unloggedMin >= 30`-gated).
  - `renderGapRecoveryInbox()` — reduced to "always hide `#gap-recovery`". The generic Today
    gap interruption is gone.
  - `renderCloseoutCta()` — dropped the "Fill or mark missing time, then pick tomorrow."
    sub-copy branch (same gap-based pressure).

removed (orphaned by the Today-gap-interruption removal):
  - `GAP_RECOVERY_OPTIONS`, `currentGapRecoveryRange()`, `fillGapRecovery()`,
    `openGapRecoveryOther()`, `logGapRecoveryActivity()`.

retained deliberately:
  - `getGapRecoveryCandidate()` — now a pure diagnostic (no production UI consumer), kept for
    debugging and regression tests per Evidence Contract §16.
  - `computeGaps()`, `getCloseoutGaps()`, Review's factual summary, Full analysis "Unlogged
    intervals", Today Health's quiet `unlogged` stat — all unchanged.
  - concrete Needs You signals (sleep reminder, routine due/error, Focus reload recovery).

tests:
  - new `tests/review-reconciliation.spec.js` (13 cases): prompt appears / is optional / Save
    works untouched; "Looks about right" and "Leave unknown" persist and fabricate/close
    nothing; reopen shows a calm summary without re-nagging; pre-6I `unloggedOk` record is not
    re-nagged; "Add broad activity" opens the 6H editor prefilled to the review date and stores
    it there; adding coarse evidence after acknowledgment keeps the acknowledgment;
    after-midnight review owns the prior day; empty historical day reconciles with no
    completeness claim; Today raises no Needs You for 35m / 5h / multiple gaps while the raw
    gaps still compute and Full analysis still lists them; today's future time is not treated
    as missing.
  - updated: `tests/smoke.spec.js` (the two `today gap recovery …` tests replaced by one
    "Today no longer interrupts for a generic timeline gap" test), `tests/today-simplification.spec.js`
    ("Needs You respects acknowledged unknown …" and "action polish … missing-time affordances"
    reworked to the no-nag behavior), `tests/plan.spec.js` (one copy assertion:
    "Needs you" → "Anything important missing?").

not done (out of scope / smaller truthful behavior chosen): whole-day coverage model /
coverage %, combined exact+estimated allocation, coarse-evidence durability / cross-device
sync, Life Ledger projection, export/import, Wife/Shared, Personal Model/Advisor. **Durability
is still required before Wife/Shared or serious dogfood.**

## Phase 6H — Coarse life evidence V1 (candidate — feat/coarse-life-evidence-v1, uncommitted) — 2026-09-09

Base `3c4678a7cd1688476b9b0b35849c25b7fd26d479` (origin/main, verified). Isolated worktree;
`main`, Meal and Workout source apps untouched. No commit/push/merge/deploy; no Firebase or
Obsidian writes; no historical data migrated.

Scope: the first implementation of the Evidence Contract's "duration without placement"
positive evidence form — a day-scoped ESTIMATED activity duration with no start/end time
(e.g. "Cooking / eating — about 1h 20m today"). Adds the smallest truthful storage form, a
deterministic replace-not-append identity model, and a reusable capture/edit UI mounted as
one small optional access point inside Review. Does not build daily reconciliation, does not
touch the generic Today gap prompt, does not touch the timeline/gap engine, and never
contributes to deep/waste/streak/Wallet/attention analytics.

added:
  - `coarse-life-evidence-model.js` (new module) — pure model: `validDate()`, `normalizeLabel()`,
    `coarseEvidenceId()` (deterministic identity = `date::normalized-label`),
    `createCoarseEvidenceRecord()`, `validateCoarseEvidenceRecord()`, and the day read model
    `getCoarseEvidenceForDate(records, date)` (§27 of the milestone spec — reusable by a later
    Review reconciliation milestone without redesign). Record fields: `id`, `date`, `timezone`,
    `label`, `estimatedMinutes`, `resolution: 'duration_without_placement'`,
    `measurement: 'estimated'`, `provenance: 'user_assertion'`, `createdAt`, `updatedAt`. No
    `tsStart`/`tsEnd`/`start`/`end` field is ever legal on this record — validated and enforced.
  - `coarse-life-evidence-repository.js` (new module) — local-only versioned repository
    (`ta3-coarse-life-evidence-v1`), following the same established local-storage-envelope
    pattern as `daily-routines-repository.js` / `capability-career-repository.js` (Learning
    Plans, Daily Routines and Capability/Career are all local-only in this app — not
    Firebase-synced — so this is the precedented, not a new, persistence pattern).
    Deterministic replace-not-append `save()`: saving the same (date, normalized label) identity
    again — unchanged or with an edited duration — updates that one record; it never appends an
    additive duplicate. `previousId` lets an edit that changes the label merge cleanly into the
    new identity.
  - `coarse-life-evidence-ui.js` (new module) — the reusable "what broad thing? / roughly how
    long?" capture/edit modal (`#coarse-evidence-overlay`) plus a read-only list mounted inside
    Review's existing optional-details section (`#rv-coarse-evidence`, rendered by
    `renderCoarseEvidenceList()`, called from `openReview()`) — the one small, optional access
    point the milestone spec allows there. Hours+minutes duration input, a free-text activity
    field with a small suggested-label datalist (Food/cooking, Household, Care/pets, Errands,
    Family/social, Entertainment, Travel, Recovery/downtime, Other), and an explicit date field
    defaulting to the day Review is open on — never fabricated from `Date.now()`. Renders "~1h
    20m · Approx." — never a timeline block. No new top-level nav tab, no mandatory daily card,
    no recurring prompt.
  - `coarse-life-evidence.test.js` — 16 `node:test` cases: model validation (malformed duration
    incl. zero/negative/non-integer/>1440min, empty label, malformed date, placement-field
    rejection), deterministic identity, the day read model, and repository persistence/edit/
    delete/non-additive-dedup/storage-corruption behavior.
  - `tests/coarse-life-evidence.spec.js` — 7 Playwright end-to-end cases: add with no start/end
    time written, edit replaces (80→100 stays 100, not 180), reopen-unchanged does not
    duplicate, remove touches only the coarse record, a same-category exact interval and a
    coarse estimate render separately without being summed into one "actual" total, malformed
    input is rejected without saving, and an evidence-only day never fabricates a timeline block
    or enters `computeDailySummary()`'s deep/waste math.

Deferred / not built this milestone (see contract implementation-status below for why):
  - Life Ledger projection — no new Ledger event type or store change.
  - Cross-device sync — local-only, matching the existing Learning Plans/Daily
    Routines/Capability precedent; not wired into the CSV export or the Life Ledger snapshot
    export (neither is a centralized "export everything" backup surface today).
  - Daily Review reconciliation flow, the generic Today gap prompt, combined exact+estimated
    allocation, Wife/Shared, Personal Model/Advisor — all explicitly out of scope for 6H.

### Phase 6H — targeted independent-review fix pass (same candidate, still uncommitted) — 2026-09-09

Independent review verdict was FIX FIRST on three implementation defects; storage
architecture, record semantics, capture model, analytics/gap/timeline isolation, and Review
scope all passed unchanged. This pass fixes only the three required findings — no redesign,
no 6I, no sync/backup work.

FIXED:
  - **Destructive ID-collision on rename/date-edit** — `coarse-life-evidence-repository.js`
    `save()`: when `previousId` is supplied and differs from the newly-computed identity, and
    that identity already belongs to a different existing record, `save()` now throws a
    descriptive error ("An activity named "X" already exists for `date`. Edit that activity
    instead, or choose a different label.") instead of silently overwriting the other record.
    The UI's existing `catch` in `saveCoarseEvidenceEditor()` already surfaced repository
    errors into `#cle-error`, so this required no separate UI change to display. Normal update
    semantics (same-id duration edits, rename/date-move onto a *free* identity, repeated
    unchanged saves, case/whitespace-only same-identity edits) are unaffected — the guard only
    fires when `previousId` names a genuinely different record than the target identity.
  - **Inline-`onclick` id injection** — `coarse-life-evidence-ui.js`
    `renderCoarseEvidenceList()`: the record `id` (derived from free-text label) is no longer
    interpolated into an inline `onclick="...('${r.id}')"` JS-string context, where a label
    containing a quote could break out and execute arbitrary script on click. Edit/Remove
    buttons now carry the id in a `data-cle-id` HTML attribute (escaped the same way the
    visible label already was) and a single delegated `root.onclick` handler
    (`handleCoarseEvidenceListClick`) dispatches the click — assigned as a property, so
    re-rendering the list never accumulates duplicate listeners.
  - **Corrupted store could block Review from opening** — `renderCoarseEvidenceList()` now
    wraps its `repository().listForDate(dateKey)` call in a `try`/`catch`; on failure it shows
    "Approximate activities unavailable on this device." for just that widget instead of
    letting the exception propagate up through `openReview()` and prevent the whole Review
    modal from opening. The repository itself is unchanged and still throws on a corrupted
    envelope (correct in isolation, unit-tested) — the fix is containment at the widget
    boundary, not softer validation. The corrupted store is never auto-repaired or wiped.

DEFERRED (reviewed, not required to land):
  - Same-label "+ Add" silently updating an existing day's estimate — this is the documented,
    intended one-estimate-per-identity behavior (see §13 of the milestone spec), not a defect;
    the existing list already renders above the "+ Add" button so the duplicate is visible
    before Save in the common case.
  - "Approximate activities: ~X total" wording nuance around possible category overlap — minor
    copy-polish, not touched.

ROADMAP GATE (recorded, not implemented here): coarse-life-evidence durability — either
cross-device sync or export/backup — **must** be addressed before Wife/Shared or serious
dogfood use. Local-only storage remains acceptable through 6I.

Tests: 6 new unit cases (`coarse-life-evidence.test.js`, now 22 total) covering the rejected
rename/date-edit collisions, the still-working free-identity rename/move, the still-working
same-identity case/whitespace edit, and normal update semantics unaffected by the guard. 5 new
Playwright cases (`tests/coarse-life-evidence.spec.js`, now 12 total): the UI-level rename
rejection with both records surviving, a label containing `'`/`"`/`<`/`>`/`&`/the exact
`x');...//` breakout pattern proven inert through both Edit and Remove with the correct record
still targeted, and three corrupted-store variants (invalid JSON, unsupported schemaVersion, a
structurally invalid record) each proving Review still opens and stays usable.

## Phase 6G.2 — Deterministic analytics truth fixes V1 (candidate — feat/analytics-truth-fixes-v1, uncommitted) — 2026-09-09

Base `9db74858a8da9c6f44a2a51e9c6cc26619cb8302` (origin/main, verified). Isolated worktree;
`main`, Meal and Workout source apps untouched. No commit/push/merge/deploy; no Firebase or
Obsidian writes; no historical data touched.

Scope: the follow-up to 6G.1 — where 6G.1 stopped ChronaSense from manufacturing a bad fact,
6G.2 stops existing analytics from turning a real-but-partial fact into a stronger conclusion
than the evidence supports. Today, Review, weekly Insights, attention signals and Focus Wallet
now distinguish a confirmed classification (a user assertion, or a timer + chosen label) from a
passive site/app default, a schedule assumption, or "PC Time" computer-session context — and
stop counting the latter as confirmed deep work or confirmed waste. No new tracking burden, no
coarse-life storage, no Review reconciliation, no generic Today-gap redesign.

added:
  - `evidence-interpretation.js` (new module) — the one shared, bounded predicate every touched
    consumer needed: `hasConfirmedEnergyClassification(entry)`, built from
    `isPassiveObservationEntry()`, `isScheduledAssumptionEntry()` and `isComputerSessionEntry()`.
    Reads existing markers only (`browserUsage`, `phoneUsage`, `source`, `scheduledAutoLog`,
    `captureMethod`, "PC Time"/"Screen time" + `autoLogged`/`quickLogged`) — no new schema, no
    confidence score. Classic-script IIFE attaching to `globalThis`, mirroring
    `focus-wallet.js`'s existing pattern. `evidence-interpretation.test.js` (predicate matrix).
  - `tests/analytics-truth.spec.js` — 13 end-to-end Playwright cases (5 from the original
    candidate + 8 added in the targeted independent-review fix pass below).

changed:
  - `index.html` `computeDailySummary()` — summarises only
    `dayEntries.filter(hasConfirmedEnergyClassification)`; fixes the common overlap case where a
    passive browser/phone observation layered over a confirmed work block pushed deep% + waste%
    past 100%. `computeCloseoutSummary()` — Review "Day details" Deep/Waste minutes are
    confirmed-only. `computeCleanStreak()` — unchanged detection, relabelled "days clean" →
    "days, no waste logged". `renderHonestSummary()` — "clean week" → "No confirmed waste logged
    this week" / "`N` of confirmed waste logged this week"; "sharpest at `X`" → "most deep blocks
    started around `X`". Review-history rows now show "of `N` recorded" alongside the percentage.
    "Peak focus hour" relabelled "Deep blocks start" everywhere it appears (Today pulse, weekly
    Insights, Reflect stats) — the calculation (bucket by block start hour) is unchanged; only
    the label now matches what it measures. **Targeted independent-review fix pass:**
    `computeStreak()` (Today "Deep streak days" / `#s-streak`, also the Streaks widget and Week
    view) and the `renderToday()` "Deep blocks today" (`#s-deep`) `deepCount` were both missed by
    the original candidate and still counted scheduled/passive/PC-Time 'deep' entries as
    confirmed — both now gate on `hasConfirmedEnergyClassification()`, mirroring
    `computeDailySummary()`. `buildWeekShareSummary()` (the "Share week" export) had the same
    unfiltered-energy pattern (flagged Low, deferred at first pass) — deep/waste minutes,
    category lines and the "Best day" deep-hours figure now use the same confirmed-only filter;
    "Logged" total, "Where my time went" activity breakdown and unlogged-gap minutes are
    unchanged (those are presence/duration facts, not energy-classification claims).
  - `insights.js` `_insightMinutes()`/`_insightEnergyMinutes()` — pre-filter to confirmed
    entries, so `analyzeBehavior`, `renderAwarenessSignal`, `computeInsights`,
    `checkEscalation()` (punitive focus-lock/penalty-mode escalation) and the weekly worst-waste
    / deep-start-hour buckets all inherit the correction. Denominator copy "of today"/"of your
    day" → "of tracked time" (`getDailySummaryInsight`, `renderAwarenessSignal`,
    `generateInsights` — the last currently unwired, fixed for consistency). "Reactive mode"
    phrasing tied only to elapsed time since the last deep block (not a logged distraction)
    softened to factual "no deep work logged for `X`".
  - `focus-wallet.js` `computeFocusWallet()` — deep-work points and waste costs now gate on
    `hasConfirmedEnergyClassification()` (falls back to "confirmed" if the helper isn't loaded).
    Sports-session scoring is unaffected.
  - `attention-signals.js` `classifyEntry()` — a passive observation or scheduled-template entry
    classifies `'neutral'`, never focus or distraction, from energy alone (markers inlined to
    stay dependency-free). `attentionSignalLines()` — "Recovered from drift" → "Refocused after a
    break" (an idle gap is unlogged time, not established drift; a logged distraction is only a
    break in the record). `ATTENTION_SIGNALS_VERSION` 1 → 2. 3 new regression cases, 2 existing
    label assertions updated; 1 existing case (`browser-extension` "waste" observation asserting
    a confirmed attention break) rewritten to assert the corrected neutral behaviour, with a new
    positive-control case alongside it proving a user-asserted waste block is unaffected.
    **Targeted independent-review fix pass:** `isUnconfirmedEnergyEntry()`'s inlined predicate
    reproduced the passive-observation and schedule-assumption markers but omitted the
    computer-session ("PC Time" / "Screen Time" + `autoLogged`/`quickLogged`) marker the shared
    `evidence-interpretation.js` helper carries — so a real auto-logged PC Time entry with
    `energy: 'deep'` could still classify `'focus'` and feed a coherent stretch, a refocus/
    recovery claim, or the attention interpretation layer. Added the same computer-session check
    `isComputerSessionEntry()` uses. 5 new regression cases (PC Time and Screen Time auto/quick-
    logged deep entries stay neutral; a PC-Time block does not extend an adjacent real focus
    stretch; PC Time alone after a real break does not manufacture a recovery; positive control —
    a non-auto-logged deep entry still counts as confirmed focus).
  - `www/*` — byte-identical mirror of every changed/added file above (`runtime-mirror --check`
    passes, 41-file closure).

unchanged: raw entries, their durations, provenance markers and timeline rendering; scheduling
functionality and plan-v-actual/intent use of scheduled entries; the PC-Time `|| 'deep'`
fallback itself (still can't distinguish inherited real context from the pure fallback — both
are excluded from confirmed metrics the same way, as documented rather than guessed);
`chronasense-life-ledger-adapter.js`, `life-ledger-core.js`, `life-ledger-runtime.js`,
`life-feed-model.js`, `life-character-sheet-model.js`, `capability-career-analytics.js`,
`cross-domain-intelligence-model.js`, `life-ledger-transport.js`,
`obsidian-life-ledger-renderer.js` — none consume the new helper. The generic ≥30-minute Today
gap prompt, coverage/completeness language (audited — none existed to fix), Review
reconciliation, coarse-life storage, Wife/Shared and Personal Model/Advisor are all untouched.

historical: not repaired. Historical Focus entries potentially inflated by the pre-6G.1 defect
remain unidentified and unmodified — this milestone changes how currently computed metrics
interpret entries going forward, not which past entries were affected.

tests: `evidence-interpretation.test.js` (predicate matrix). `attention-signals.test.js` 34
cases (was 26): 3 new (original pass) + 5 new PC-Time/Screen-Time regressions (targeted fix
pass) + 2 label updates + 1 rewritten. `test.js` 451/451 (+5 Focus Wallet gating cases from the
original pass; unchanged by the targeted fix pass). `tests/analytics-truth.spec.js` 13/13 (5
from the original pass + 8 from the targeted fix pass: 6 Today `#s-deep`/`#s-streak` DOM
regressions covering scheduled/browser-passive/phone-passive/PC-Time/genuine-confirmed/mixed
evidence, + 2 `buildWeekShareSummary()` regressions). Full `npm test` green (0 failures across
every runner in the chain, 27 suites). `node scripts/runtime-mirror.mjs --check` OK (41 files,
byte-identical). `npm run lint` 0 errors (29 pre-existing warnings, unchanged count — none in
changed hunks). `git diff --check` clean. `node --check` on every touched/added executable JS
file (`evidence-interpretation.js`, `attention-signals.js` + `www/` mirror,
`evidence-interpretation.test.js`, `attention-signals.test.js`, `tests/analytics-truth.spec.js`,
`test.js`).

Playwright — corrected finding (this replaces the original candidate's flake claim, which named
a `smoke.spec.js` failure that was not the actual reproducible evidence): the independent
reviewer reported 363/365 with 2 reproducible failures in `daily-routines-ui.spec.js`. Targeted
reproduction attempt in this fix pass: `tests/daily-routines-ui.spec.js` alone, 3 consecutive
runs on the candidate — 14/14 passed every time. Full suite on the candidate, 2 consecutive runs
— 373/373 passed both times (373 = 365 + 8 new cases added in this fix pass), 0 failures. For
comparison, `tests/daily-routines-ui.spec.js` alone against a clean checkout of the exact base
commit (`9db74858a8da9c6f44a2a51e9c6cc26619cb8302`, the existing registered `main` worktree, left
otherwise untouched) — 3 consecutive runs, 14/14 passed every time; full suite once — 360/360
passed (360 = 373 candidate total minus the 13 `tests/analytics-truth.spec.js` cases the base
commit doesn't have). Total: 9 runs across candidate and base, 0 failures anywhere. The
reviewer's 2 failures could not be reproduced on either side, so no daily-routines production or
test file was touched — there is no reproduced regression to fix, and nothing here supports
calling it a confirmed pre-existing defect either. Recorded as: not reproducible in 9/9 attempts,
environment/timing-sensitive rather than a demonstrated candidate regression.

status: uncommitted candidate, ready for targeted independent re-review after the FIX FIRST
findings (PC-Time attention-signals parity, Today `#s-deep`/`#s-streak` confirmed-energy
boundary, and this corrected Playwright finding). Not a queued task — direct user milestone,
TASKS.md unchanged.

## Phase 6G.1 — Deterministic source truth fixes V1: expired Focus completion boundary (candidate — feat/source-truth-fixes-v1, uncommitted) — 2026-09-09

Base `c47f1e5227c0a9993bf1c004b6939b7ce332cb71` (origin/main, verified). Isolated
worktree; `main`, Meal and Workout source apps untouched. One production file changed
(`focus-mode.js`, mirrored to `www/focus-mode.js`). No commit/push/merge/deploy; no
Firebase or Obsidian writes; no historical data touched.

Scope: only the one deterministic case where ChronaSense itself creates evidence claiming
more than the source establishes and the fix is self-contained — a short Focus work
session restored long after its planned end logging through `Date.now()` and producing
hours of apparent deep work. Today, Review, analytics copy, reconciliation, coarse life
estimates and the passive-observation / PC-Time / schedule-vs-actual interpretation layer
are explicitly deferred to 6G.2.

changed:
  - `focus-mode.js` `endWorkSession()` — end timestamp is now the planned endpoint
    (`focusStartTime`, or `pomodoroPhaseStartedAt` as fallback, plus configured work
    minutes) instead of `Date.now()`. `endWorkSession()` is only ever reached by a work
    phase that ran to its configured length (`tickPomodoro()` at zero, or
    `restoreFocusSession()` after the planned end already passed), so the planned endpoint
    is the truthful end for every caller. A delayed restore no longer asserts work
    continued until reopen time; time after the planned endpoint stays unobserved.
  - `focus-mode.js` `restoreFocusSession()` — after concluding an expired work phase, the
    following break's real remaining is re-derived from the wall clock; if that window
    also fully elapsed it is concluded once through the existing `endPomodoroBreak()`,
    otherwise the break resumes with its true remaining rather than a full fresh
    countdown.
  - `focus-mode.js` `logFocusSession()` — exactly-once guard. The planned-end timestamp
    is deterministic, so a repeat restoration, a second tab, or a page/HUD race recompute
    the same entry `id`; the function now returns the existing entry instead of appending
    a duplicate when one with the same `id`/`tsStart`/`energy: deep` is already present.
    Downstream Daily-Routine and Learning-Plan hooks are keyed by that entry id and
    converge.
  - `www/focus-mode.js` — byte-identical mirror (runtime-mirror `--check` passes).

unchanged: manual Focus exit (`saveActiveFocusSession()`) still logs real elapsed time and
stays authoritative; `restoreFocusSession()` corrupt/incomplete/absent-record safety, the
multi-device reconciliation window, HUD projection, break/skip flow, and the Learning-Plan
linkage all behave as before. No adapter, Ledger, storage-schema, Today, Review, insights,
attention-signals or Focus-Wallet change. No new screen, prompt, field, setting, badge,
score or daily interaction.

historical: not repaired and not attempted. Stored fields still cannot deterministically
distinguish a legitimate long timer/manual session from an old inflated restored one, so
no history scan, blind cap, deletion or manufactured restoration metadata was added
(consistent with the Evidence Contract "no reliable retrospective quarantine" finding).

tests: `tests/focus-reload-recovery.spec.js` +6 deterministic regressions (40-min reopen
capped at 25; 5-hour reopen produces no 5-hour deep entry; repeated reopen exactly once;
reopen exactly at the endpoint; manual Stop stays real-elapsed; delayed expired restore
crossing midnight dates to the planned end). Full `npm test` green; full Playwright suite
360/360; `node scripts/runtime-mirror.mjs --check` OK; `npm run lint` 0 errors;
`git diff --check` clean; `node --check` on both touched files.

status: uncommitted candidate for one independent review. Not a queued task — direct user
milestone, TASKS.md unchanged.

## Phase 12.0A — Static root↔www runtime parity + safe tooling (integrated to main — 922297d) — 2026-09-06

Infrastructure-only slice ahead of Phase 12 (Personal Intelligence). Split out of
the original 12.0 per design review so Android runtime work stays independently
reviewable from tooling safety; deterministic v1 itself is unbuilt (12.1+).

added:
  - `scripts/runtime-mirror.mjs` — computes the browser-runtime dependency closure
    live from root `index.html` (`<script src>`, `<script type="module" src>`,
    `<link rel="stylesheet">`, `navigator.serviceWorker.register(...)`, plus
    transitive local `import`/`export ... from`/`import()`), not a hand-maintained
    file list or a blind `*.js` glob. `--check` (default): verifies every closure
    file exists in `www/` and is byte-identical to root, flags any dev-only file
    that leaked into the closure or any stale file in `www/` outside the closure,
    performs zero writes, non-zero exit on drift. `--write`: mirrors the closure
    into `www/` and removes stale copies.
  - `scripts/runtime-mirror.test.js` — 14 contract/negative tests (resolution,
    fixture-based drift/missing-file detection, dev-file exclusion, ordering
    independence, external/CDN URL exclusion, check-mode-zero-writes, and
    static assertions that `sync.bat`/`sync.sh`/`deploy-release.ps1` contain no
    git mutation or `cap sync` path).
  - `scripts/deploy-release.ps1` — the only script that runs `npx cap sync
    android`. Refuses to run on `main`, dry-run by default (`-Confirm` required),
    runs the parity check first, performs no git add/commit/merge/push. Not run
    yet.
  - `www/`: the 7 previously-missing module entrypoints (`learning-plan-ui.js`,
    `capability-career-ui.js`, `life-feed-ui.js`, `cross-domain-intelligence-ui.js`,
    `life-character-sheet-ui.js`, `life-ledger-export-ui.js`,
    `life-ledger-sync-status-ui.js`) plus 15 transitive modules and
    `capability-career.css` — all of Learn / Career / Life / Next / Life-Ledger
    export+sync-status were previously absent from the Capacitor Android bundle.

changed:
  - `sync.bat` / `sync.sh` reduced to thin wrappers around `runtime-mirror.mjs`.
    Removed: `npx cap sync android`, `git add`/`git commit`/`git push origin
    main` (the old pipeline could publish to production main unconditionally on
    every run); `sync.sh`'s `<!-- DO NOT EDIT -->` header injection (which made
    byte-identical parity impossible) is gone.
  - `www/focus-mode.js`, `www/style.css` resynced to byte-identical (had drifted
    behind root).
  - `test.js`: the hardcoded 3-file parity block (`index.html`, `storage.js`,
    `focus-wallet.js`) replaced with two closure-derived live guards that pick up
    new `<script>` tags/imports automatically.
  - `package.json`: `check:www-parity` / `mirror:www` scripts; parity test wired
    into `npm test`; lint covers `scripts/runtime-mirror.mjs`.
  - `.github/workflows/ci.yml`: explicit "Check www/ runtime parity" step on
    every push/PR to `main`.

removed:
  - `www/eslint.config.js`, `www/playwright.config.js`, `www/test.js` — stale
    dev-only files that had no business being mirrored to the Android bundle.

Not done here (12.0B / later): Android runtime compatibility, `showDirectoryPicker`
feature-detection, APK build/smoke, Personal Intelligence code.

## Phase 11.8 — Minimal distraction signals (integrated to main — bc552ca; independent-review fix 254ab57) — 2026-09-05

A thin, mostly-automatic attention-awareness layer derived from data ChronaSense already
captures. Not a new tracking product: no new collector, tab, dashboard, score, daemon, blocker,
Firebase subsystem, or Life Ledger coupling. Awareness Signal, Focus Wallet, streaks, Focus Mode
KEEP unchanged; penalty/escalation stays FREEZE.

added:
  - `attention-signals.js` / `www/attention-signals.js` — new pure computation module.
    `deriveAttentionSignals(entries, options)` and `attentionSignalLines(signals)`. ESM with a
    `globalThis` attach (mirrors `focus-wallet.js`). No DOM, no `Date.now()`, no mutation of
    inputs, no network, no ML/AI — deterministic: same input → same output. Loaded from
    `index.html` as `<script type="module">`.
    - **Context class per block:** `focus` (energy `deep`/`learning`, or the activity matches a
      Today Plan task), `distraction` (energy `waste`/`distraction`), else `neutral` (`shallow`,
      `nine5`, `errands`, `exercise`, `recovery`, `social`, `admin`). Classification is by the
      block's own label — never by app/site/window — so switching VS Code → Claude → GitHub →
      docs while all logged `deep` stays ONE coherent stretch.
    - **Longest coherent stretch:** wall-clock span of the longest run of focus blocks. A run
      must reach `minStretchMin` (10) focused minutes to count. It ends only on: a distracting
      block ≥ `debounceMin` (10 min); an untracked gap ≥ `idleGapMin` (25 min); or an unbroken
      non-focus run ≥ `contextShiftMin` (30 min). A context-shift trims trailing neutral time
      and is NOT a break. Because a stretch can hold short neutral runs and sub-debounce
      distraction dips, the line renders as `N min span · M min focused` whenever the classified
      focus minutes are below the span, and the concise `N min` only when the whole span is
      focus — the span can never be misread as actual focused time.
    - **Attention breaks:** count of stretch-ending events that are a sustained distraction or a
      long idle gap. A distraction shorter than `debounceMin` is a within-stretch dip, not a
      break (rapid-noise debounce). A budding run below `minStretchMin` broken by real drift
      produces no break.
    - **Likely distraction:** `~N min` = sum of distraction-class block minutes, surfaced only
      when ≥ `distractionSupportMin` (15); withheld (null) below that rather than forced.
    - **Recovery:** each break matched to the next coherent stretch beginning within
      `recoveryWindowMin` (60). `medianRecoveryMin` reported only with ≥ 2 recoveries.
    - Returns supporting metadata (`segments`, `stretches`, `breaks`, `config`, `meta`) so the
      computation is inspectable. Phase 12 may interpret the outputs; it must not change them.
  - `attention-signals.test.js` — 26 deterministic tests over synthetic timelines (incl. the
    span-vs-focused-minutes display case). Wired into `npm test` and `npm run test:attention-signals`.
  - `insights.js` / `www/insights.js` — `renderReviewAttention(dateKey, selfRating)`. Formats the
    derived signals into the existing `.rv-closeout` card style and hosts the three optional
    rating buttons. Only data-supported metrics render (progressive disclosure). Copy is hedged.
  - `index.html` / `www/index.html` — an **"Attention today"** block (`#rv-attention`) in the
    end-of-day review modal, between the closeout summary and the win/waste fields. New review
    field `reviews[dateKey].focusRating` (`'focused' | 'mixed' | 'distracted' | null`), toggled
    by `setReviewFocusRating()`, loaded in `openReview()`, persisted in `saveReview()`, synced
    through the existing `rooms/<code>/reviews` last-writer-wins merge. No schema migration —
    `reviews` is raw JSON and the field is optional.
  - `eslint.config.js` — `attention-signals.js` moved to the module-sourceType group; new app
    globals registered for `insights.js`.
  - `package.json` — `attention-signals.test.js` added to `test`; new `test:attention-signals`
    script; `attention-signals.js` added to `lint`.

not done (deliberately):
  - No Awareness Signal ("Today's Signal") line and no weekly Reflect surface — kept to the
    single daily-review host to stay minimal. Both are natural follow-ups.
  - No persistence of the derived numbers — recomputable from `entries`; only the subjective
    `focusRating` is stored.
  - `focus-mode.js` NOT touched — the module reads finished `entries`, so the known root/www
    `focus-mode.js` Learning-Plan drift is not widened here.
  - PROP-014 (DST date-window) untouched — not on the derivation path (the module is
    timestamp-only and day-agnostic; the caller owns the date window).

## Phase 11.7 — Bloat consolidation / UX simplification (integrated to main — b1b0fa0) — 2026-09-05
A simplification phase, not a feature phase. Reduces two genuine conceptual duplications without
weakening the core behavioral loop (capture → understand → interrupt → review → improve) and
without splitting the app. Small, high-confidence, reversible changes only; everything else
audited and deferred (see `planning/ROADMAP.md`). Focus Mode, Awareness Signal, streaks, Focus
Wallet, and the daily/weekly/missed-recovery review surfaces are unchanged. Penalty/escalation
stays FREEZE — audited as already quiet (two toasts on a 5+ waste streak, no dedicated UI or
settings), so no change was warranted.

removed:
  - index.html / www/index.html — **Identity level** (`computeIdentityScore()`,
    `getIdentityLevelWithEmoji()`, the `#s-identity` / `#s-identity-sub` stat tile, and the
    ~17-line tier/colour render block in `renderToday()`). The tile had been `display:none` since
    2026-07-10 (`21af9cc` "Simplify daily driver view"); this finishes that removal. Its only
    input was today's deep-block count — identical to the `#s-deep` "Deep blocks" tile beside it —
    bucketed into four labels (Drifting/Trying/Builder/Operator). It gated no behaviour, unlocked
    nothing, and persisted no data (computed live from the entries array each render), so there is
    nothing to migrate. The Awareness Signal already gives the honest deep/waste read the label
    was gesturing at.
  - test.js — the `computeIdentityScore()` / `getIdentityLevelWithEmoji()` unit blocks (their
    local test copy had already drifted from production: it filtered `onPlan === true && energy
    === 'deep'` where production filtered only `energy === 'deep'`).
  - CODEMAP.md — the two removed functions dropped from the `[Statistics & Scoring]` map.

changed:
  - DECISIONS.md — declared the **canonical decision log**. The repo had two parallel decision
    records (root `DECISIONS.md`, 22 numbered architecture entries; `docs/DECISIONS.md`, an
    ADR-lite scaffold whose `D-001` was never filled in, plus three real entries
    D-002/D-003/D-004). D-002/D-003/D-004 were migrated verbatim into the root log as entries
    23/24/25 with their original `D-0NN` ids retained as aliases — no decision history lost.
  - docs/DECISIONS.md — replaced with a pointer stub: canonical log is `../DECISIONS.md`, plus a
    migration table and a note that the file is retained (not deleted) because
    `tools/Verify-Decisions.ps1` and `tools/Check-DocsConsistency.ps1` still read that exact path.
    Rewiring those scripts is deferred (they touch the `tools/` red zone).
  - PROMPTS.md (P6), AGENTS.md (task-read step, escalation policy) — decision-log pointers now
    name the root `DECISIONS.md`.
  - APP_CONTEXT.md — motivation-layer inventory: Identity level row marked REMOVED (Phase 11.7);
    penalty/escalation row and Known Live Bugs section de-staled (Phase 11.6 restored
    `triggerPenaltyMode()`); decision-log duplication marked resolved.
  - STATUS.md, planning/ROADMAP.md — Phase 11.7 recorded; stale "(built, NOT integrated)" wording
    on the Phase 11.6 line corrected where touched.

## Phase 11.6 — Core-loop bug cleanup (integrated to main 2026-09-04, commits f3887db + dbbbc31) (branch: fix/core-loop-bugs-v1) — 2026-09-04
Live-verified the five historical bug candidates from `planning/PROPOSALS.md` (PROP-004, 007,
008, 009, 013) against current source and fixed the three that were confirmed active,
data/correctness-affecting bugs. No feature work, no motivation-system redesign, no UI
consolidation — see `APP_CONTEXT.md`'s Phase 11.5 product boundary and Known Live Bugs section,
which this phase resolves.
changed:
  - index.html — `triggerPenaltyMode()` (PROP-007) is now defined. `checkEscalation()` in
    `insights.js` called it on a 5+ consecutive waste/missed streak, but it only ever existed in
    dead prototype HTML files and as an ESLint `readonly` global — every call threw a silent
    `ReferenceError`, which also skipped `checkBudget()` on the same call path (two of three
    `checkEscalation()` call sites call `checkBudget()` immediately after). Fixed by defining it
    next to `startSprint()`, reusing the same safe pattern (adjust `totalSecs`/`remaining` for an
    already-running block via `syncTimerState()`, otherwise queue the 60-min duration for the next
    start via `settings.intervalMin`/the interval input) rather than the prototype's force-start
    approach, which depends on `intention` being set and can't run unattended from escalation.
    Penalty/escalation remains FREEZE per Phase 11.5 — this is a correctness fix, not an
    expansion: no new mechanism, no forced-start behavior beyond what the exit-delay lock already
    did.
  - storage.js — `persist()`/`load()` (PROP-004) now round-trip `blockStartTime` through the
    `ta3-timer` localStorage record. It was the only running-timer field never saved or restored:
    `running`, `timerStartedAt`, `currentTask`, etc. all survived an app close/reopen but
    `blockStartTime` silently reset to `null`. Confirmed live: reopening with a timer running and
    then entering Focus Mode (`enterFocusMode()`'s `if (running && blockStartTime …)` auto-log
    guard) silently dropped the pre-reopen block with no log entry and left `running: true`
    stuck — a genuine silent time-loss bug, not just a display issue. `load()` now restores
    `blockStartTime = saved.blockStartTime || saved.timerStartedAt` (old saved sessions without
    the field fall back to the block starting when the current ping interval did).
  - focus-wallet.js — `isFocusWalletSportsEntry()` (PROP-009) now requires a left word boundary
    before a sports keyword match instead of plain substring `includes()`. `'transport'.includes
    ('sport')` was `true`, so any "Public transport" / "Transport to office" activity silently
    consumed a free Focus Wallet sports-session slot and could incur real point costs. Fixed with
    a boundary-anchored regex per keyword (`sport` still matches `sport`/`sports`, no longer
    matches `transport`/`transportation`).
added:
  - tests/smoke.spec.js — "a 5-waste-streak escalation does not throw…" (PROP-007): drives
    `checkEscalation()` with 5 seeded waste entries through a real page, asserting no `pageerror`
    and that the recovery duration is truthfully set. Fails with
    `ReferenceError: triggerPenaltyMode is not defined` before the fix.
  - tests/smoke.spec.js — "reopening the app with a running block preserves blockStartTime…"
    (PROP-004): starts a real timer, rewinds it 5 minutes, reloads the page (simulating close +
    reopen) without wiping localStorage, then enters Focus Mode and asserts the block is logged
    instead of silently dropped. Fails (`blockStartTime: null`, 0 entries logged) before the fix.
  - test.js — "transport activities are not misclassified as sports sessions" and
    `"sport"`/`"sports"` still-match coverage (PROP-009) for `isFocusWalletSportsEntry()` via
    `computeFocusWallet()`.
not fixed (see reconciliation below):
  - PROP-013 (unlogged-day navigation off-by-one) — live-verified, could not reproduce on the
    original reported symptom. Traced the full chain (`renderUnloggedHours()` → `setViewDate()`
    → `getViewingDateKey()` → `getEntriesForDateWindow()` → `tzParseTime()`/`getDateInTZ()`) and
    empirically reproduced the exact repro shape (viewing Friday, clicking Wednesday from the
    unlogged-hours list, entries seeded on both Wednesday and Thursday) against a real
    negative-UTC-offset timezone (America/New_York, non-DST date) both by calling the click
    handler directly and by dispatching a real DOM click — both correctly showed Wednesday's data
    in the header and the timeline body. Classified STALE / CANNOT REPRODUCE; not fixed. **Correction
    (2026-09-04 www-parity review):** this is not a claim that the date-window logic is
    universally timezone-correct — a separate, pre-existing DST-transition defect in
    `tzParseTime()` was found in the same review pass (see PROP-014 below) and was not the
    mechanism behind PROP-013's original symptom. See `planning/PROPOSALS.md` PROP-013/PROP-014
    for both.
  - PROP-008 (Focus Mode auto-log has no undo) — confirmed live (`enterFocusMode()` calls
    `showToast()` instead of the `rememberCreatedUndo()` + `showUndoToast()` pattern every other
    logging path uses), but classified UX debt, not a correctness/data-safety bug: the auto-
    logged entry is not irreversible — it remains editable/deletable from the timeline exactly
    like any other entry, only without the 1-tap undo convenience. Deferred to Phase 11.7 or a
    dedicated UX pass, per this phase's scope boundary.

### Phase 11.6 review fix — Capacitor www runtime parity — 2026-09-04
Independent review of the Phase 11.6 commit above passed all three source fixes but found one
blocking gap: Capacitor's `webDir` is `"www"` (`capacitor.config.json`), so `www/*.js` /
`www/index.html` are what an Android build actually ships, not a stale reference copy — and
nothing regenerates them automatically (`sync.bat` does, but it also commits and pushes to
`origin main`, so it isn't something this fix pass runs). The three fixed root files had drifted
from their `www/` mirrors before this phase even started, so PROP-007/004/009 shipped fixed on
web/PWA but would still have shipped broken on a current Android build.
changed:
  - www/index.html, www/storage.js, www/focus-wallet.js — synchronized to be byte-identical to
    the reviewed root files (sha256-verified), mirroring exactly what `sync.bat`'s own copy step
    does. No fix was re-edited a second time; this is a straight file copy of the already-reviewed
    root source.
added:
  - test.js — "Capacitor www runtime mirror parity": asserts `www/index.html`, `www/storage.js`,
    and `www/focus-wallet.js` are byte-identical to their root counterparts. Fails (3/3) if any of
    the three mirrors goes stale again; verified failing before this fix and passing after.
not run:
  - `npx cap sync android` — attempted in the feature worktree to determine necessity per the
    review's instruction; failed immediately with `[error] android platform has not been added
    yet.` The real native `android/` project is gitignored (`.gitignore`: `android/`) and exists
    only in the authoritative main working directory outside this worktree/branch, so it produces
    no tracked diff in this repo regardless of whether or when it's run — that step belongs to an
    actual Android build, which remains out of scope (no build, install, or deploy was performed).
    `git status` before and after the attempt was identical (only the three `www/*` files above).
  - `sync.bat` — read, not executed: besides the file copy, it also runs `git commit` and
    `git push origin main` unconditionally, which this bounded review-fix pass must not do.
deferred (found during this review pass, not fixed):
  - Focus Wallet sports-keyword matching still lets compound activities like `"sports-car"` /
    `"sportscar"` count as a sports session (the left-word-boundary fix from PROP-009 only
    guarantees "sport"/"sports" match while "transport" doesn't — it doesn't define compound-word
    semantics either way). No existing spec settles this; recorded as a non-blocking follow-up on
    PROP-009 in `planning/PROPOSALS.md` rather than inventing new matching rules.
  - PROP-014 (new) — `tzParseTime()` in `storage.js` collapses to a zero-width day window on a
    DST spring-forward date (verified: `America/New_York`, `2026-03-08`). Pre-existing, unrelated
    to and not caused by Phase 11.6, and not the mechanism behind PROP-013's original symptom.
    Logged in `planning/PROPOSALS.md` as its own entry for a future date/timezone bug pass.

## Phase 11 — Review fix pass (built, NOT integrated) (branch: feat/life-ledger-production-hardening-v1) — 2026-09-04
Fixes for seven confirmed findings from an independent adversarial review of the Phase 11
commit below. Built and tested entirely against disposable fixtures; the real scheduler, worker
config, outbox, backups root, and vault were never mutated during this fix pass.
changed:
  - scripts/life-ledger-sync-retention.mjs (Finding 1) — a CORRUPT (present but unparseable)
    intervention latch now blocks ALL run-log and receipt pruning outright
    (`retentionBlocked: true, retentionBlockedReason: 'corrupt_intervention_latch'`), not merely
    the count-floor fallback it silently relied on before. Lock-tombstone cleanup is unaffected
    (always-orphaned, never references incident evidence). Resumes normal pruning once a human
    clears the corrupt latch via the already-reviewed `--clear-intervention`.
  - scripts/life-ledger-sync-restore.mjs (Findings 2, 3, 5) — an existing file whose bytes differ
    from a receipt's pre-incident backup is no longer auto-overwritten: this system keeps no
    durable evidence of the expected post-incident bytes (`written[]`/`failedRelativePath` are
    paths only, never content or hashes, and the in-memory plan is gone once the failed process
    exits), so such a difference could be the failed apply's own write OR a later human edit, and
    the two are indistinguishable from evidence this system actually keeps. Now classified
    `ambiguous_current_state` with full diagnostic detail (current/pre-incident sha256, backup
    source path) and left completely untouched. A file CREATEd by an apply that later failed
    (absent from that apply's own pre-incident backup by construction) is classified
    `residual_created_file` — write-only restore cannot remove it, and its presence always forces
    the result to `manual_review_required`, never a false "restored successfully". Every
    preview/apply result now carries a `completeness` field
    (`noop` / `exact_restore_possible` / `exact_restore_complete` / `manual_review_required`).
    `applyRestore` no longer accepts/requires `--backups-root` (nothing is ever overwritten, so
    there is nothing to copy aside as evidence — the untouched file already is the evidence).
    `planFingerprint` trust semantics documented precisely: shape-validated only, never compared
    against a freshly re-derived plan (that would require the original outbox snapshot bytes,
    not guaranteed to still exist); the bindings actually verified are live vault/root identity
    and backup content-integrity hash reproduction (integrity, explicitly not authentication).
  - scripts/life-ledger-sync-health.mjs (Finding 4) — the current outbox snapshot's sha256 and
    the worker's last-*processed* outbox sha256 (`backupsRoot/status.json`'s `outboxSha256`) were
    both already computed but never compared. Now compared and surfaced as
    `facts.outboxProcessed`: a mismatch (or no worker status yet, given a snapshot exists) is
    PENDING, not HEALTHY; a malformed `status.json` is UNAVAILABLE (worker status genuinely
    unknown). No wall-clock "stale evidence" threshold was added on the Node side — documented
    reason: no reliable cadence context is available there (the scheduling interval lives only in
    the Windows Task Scheduler trigger, which this module cannot read).
  - setup-life-ledger-sync-scheduler.ps1 (Finding 7) — `-Action RunOnce` gained an optional
    `-ConfigPath`, forwarded to the worker's own `--config` flag.
  - scripts/test-life-ledger-sync-scheduler-install.ps1 (Finding 7) — Part D's `Invoke-RealRunOnce`
    previously moved the REAL `scripts/life-ledger-sync-worker.config.json` aside, copied a
    disposable config over that exact path, ran RunOnce, then restored it — a real-production-
    config risk this project's own rules forbid, and the root cause of a harness/environment
    discrepancy a reviewer observed (a fragile swap, not a worker regression). Rewritten to use
    `-ConfigPath` directly; the real config path is never read, written, or moved by this harness
    now. Two new regression checks added (C.4 static, D.4 dynamic — the real config path's
    presence/bytes are proven identical before and after Part D). Reproducibly 27/27 across
    repeated runs, independent of working directory.
  - docs/PHASE11_PRODUCTION_HARDENING.md — corrected per Finding 6: corrupt- vs healthy-latch
    retention behavior, restore ambiguity/human-edit/residual-file behavior in full, the
    integrity-vs-authentication distinction, `planFingerprint` trust semantics, Health's
    outbox-processed comparison, and the harness-isolation fix.
added:
  - scripts/life-ledger-sync-restore.test.js — REQUIRED end-to-end scenarios using a REAL injected
    partial-apply failure (not simulated): a human edit made to an already-owned file after the
    failure is never overwritten (Finding 2), and a file CREATEd just before the failure is a
    named residual that restore never claims to have fully resolved (Finding 3). Plus unit-level
    ambiguous/residual/malformed-receipt/no-delete-capability coverage.
  - scripts/life-ledger-sync-retention.test.js — corrupt latch + old evidence far outside the
    min-keep floor + many newer entries -> zero run/receipt pruning; lock tombstones still prune;
    normal pruning resumes after an explicit human clear.
  - scripts/life-ledger-sync-health.test.js — outbox hash mismatch -> PENDING; malformed
    status.json -> UNAVAILABLE; snapshot with no worker status yet -> PENDING; matching hashes
    contribute to HEALTHY.
  - scripts/life-ledger-sync-chaos.test.js — CORRUPT-LATCH UNDER LOAD: many real cycles, a real
    latch made corrupt afterward, retention blocks ALL run/receipt pruning (not just the one
    receipt the latch used to reference).
verification: full suite re-run — see the fix-pass final report for exact counts.

## Phase 11 — Production hardening (built, NOT integrated) (branch: feat/life-ledger-production-hardening-v1) — 2026-09-04
Operational hardening for the now-live Phase 10 background sync, built entirely against
disposable fixtures — the real scheduler, worker config, outbox, backups root, and vault were
never mutated during this Builder pass (read-only inspection only, confirmed before and after).
No product features, no architecture changes.
added:
  - scripts/life-ledger-sync-retention.mjs — age-with-a-count-floor bounded retention for
    `runs/*.json`, `receipts/<runId>/`, and `life-ledger-sync-worker.lock.stale-*` tombstones
    under one worker's backupsRoot. Dry-run by default, idempotent, reparse-safe (lstat +
    realpath containment on every entry), and never prunes the run log or receipt an active
    intervention latch depends on.
  - scripts/life-ledger-sync-tmp-cleanup.mjs — cleanup for the two exact, fully-known orphaned
    `.tmp` atomic-write artifacts the worker can leave behind after a hard kill
    (`intervention-required.json.tmp`, the outbox status `.tmp`). Gated on both an age threshold
    and the worker lock not currently being live, so a possibly-in-progress write is never
    touched. Per-vault-content-file `.tmp` cleanup (inside the managed `Life Ledger/` subtree) is
    explicitly out of scope — see the Phase 11 final report.
  - scripts/life-ledger-sync-restore.mjs — human-authorized recovery assistant
    (inspect -> verify -> preview -> explicit `--apply-restore`) for a Phase 9/10 rollback
    receipt. Write-only: restores exactly the files a verified receipt backed up back to their
    exact backed-up bytes; never deletes anything. Preserves the pre-restore bytes of anything
    it overwrites before touching it.
  - scripts/life-ledger-sync-health.mjs — one read-only health command classifying the worker as
    HEALTHY / PENDING / BLOCKED / ACTION_REQUIRED / UNAVAILABLE from config validity, outbox
    state, last-run status, the intervention latch, current vault ownership, and backup-root
    storage footprint / pruning-due state.
  - setup-life-ledger-sync-scheduler.ps1 -Action Health — merges the Scheduled Task's own
    state/LastTaskResult with the Node health script's classification (always the worse of the
    two), so the owner has one command to run without understanding hashes or receipts.
  - scripts/life-ledger-sync-{retention,tmp-cleanup,restore,health,chaos}.test.js,
    scripts/life-ledger-sync-intervention-latch-recovery.test.js — new coverage, all against
    disposable temp vaults/backups roots.
changed:
  - scripts/life-ledger-sync-worker.mjs — `--clear-intervention` now succeeds even when
    `intervention-required.json` is corrupt/unparseable JSON (previously it threw and could not
    clear itself): it now inspects the exact latch path directly, refuses anything that isn't a
    plain file, and — on corrupt JSON — renames the file aside (preserving the bytes as evidence)
    instead of requiring a parseable latch to clear one. Healthy-latch clearing is unchanged.
    Also exports `isBackupsRootLockLive()`, reused by the tmp-cleanup tool.
verification: `npm test` (426 checks, 0 failures, including all new Phase 11 suites), `npm run
  lint` (0 errors, 0 new warnings), `node --check` on every changed/new file, `git diff --check`
  clean, `scripts/test-life-ledger-sync-scheduler-install.ps1` (26/26, unchanged), strict
  cross-repo compatibility gate PASS.

## Phase 10 — RunOnce argument fix (built, NOT activated) (branch: feat/life-ledger-background-automation-v1) — 2026-09-04
The retry of the disposable Windows Task Scheduler proof PASSED (Install, exact
task registration, live task properties, finite repetition, scheduler-fired
`--apply` execution, idempotent later cycles, intervention latch,
ClearIntervention, and Uninstall all verified live). It also surfaced one new,
narrowly-isolated defect: `setup-life-ledger-sync-scheduler.ps1 -Action RunOnce -Apply`
failed with `Unknown argument: -`. Root cause: `$applyArgs = if ($Apply) { @('--apply') } else { @() }`
— capturing an `if`/`else` statement's output collapses a one-element array
literal to its bare scalar element in PowerShell, and splatting that scalar
with `@` then expands it character-by-character. This was isolated to
`RunOnce` — the `Install` branch's argument string (built by plain string
concatenation, never an array/splat) was unaffected, and so was the actual
registered scheduled task's arguments (both proven correct in the disposable
proof).
changed:
  - setup-life-ledger-sync-scheduler.ps1 — `RunOnce` now builds
    `[string[]]$applyArgs = @()` then conditionally `$applyArgs += '--apply'`,
    an explicit typed-array accumulation that never goes through the
    collapsing assignment pattern. No other action, no scheduling semantics
    (interval/repetition/`IgnoreNew`/`StartWhenAvailable`/logged-on-only/
    no-elevation/task naming), and no worker CLI behavior changed.
  - scripts/test-life-ledger-sync-scheduler-install.ps1 — added Part C
    (AST-based static checks: no collapsing `if/else` assignment to
    `$applyArgs`, the typed-array initializer is present, the `+=`
    accumulation is present — correctly written against the AST rather than
    raw text, since the fix's own explanatory comment quotes the buggy
    pattern as a documentation example and would otherwise false-positive a
    plain text search) and Part D (dynamic: runs the real `RunOnce` action
    against a disposable owned vault + outbox, no Task Scheduler involved,
    proving `--apply` forwards as exactly one argument, no-`-Apply` forwards
    zero worker flags, the worker script path survives intact despite
    containing spaces, exit 0 propagates on success, and a genuine business
    failure — missing vault — propagates non-zero without ever being confused
    with the argument-parsing bug). 26/26 checks pass.
verification: PowerShell AST parser clean; the harness reports 26/26 checks
  passed; live-repro-style check against a disposable config (temporary
  gitignored `scripts/life-ledger-sync-worker.config.json`, removed after)
  confirmed both `RunOnce` and `RunOnce -Apply` now complete with no
  "Unknown argument" and exit 0; `npm test` (node:test aggregate) 374/375
  pass, 0 fail, 1 pre-existing env-gated skip — unchanged, no JS touched;
  `npm run lint` 0 errors, same 19 pre-existing warnings; STRICT
  `npm run test:cross-repo-compat` (explicit MEAL_REPO_PATH /
  OPENGYM_REPO_PATH) PASS ChronaSense / PASS Meal / PASS Workout 29/29, zero
  leg skips, exit 0; `git diff --check` clean. Playwright not re-run (no
  browser-facing code changed). Real vault
  (`C:\Users\Admin\OneDrive\2nd Brain\Life Ledger`) hashes verified
  byte-identical before and after. No real or disposable scheduled task
  exists afterward. Sibling repos and the authoritative main ChronaSense
  checkout unmodified.

## Phase 10 — scheduler installer fail-safe fix (built, NOT activated) (branch: feat/life-ledger-background-automation-v1) — 2026-09-04
An owner-authorized disposable Windows Task Scheduler proof found that
`setup-life-ledger-sync-scheduler.ps1 -Action Install` printed "Task registered"
success text even though no task was ever created. Root cause (confirmed by an
isolated repro): PowerShell variable names are case-insensitive, and the
script's own `-Action` parameter (`[ValidateSet('Install','Uninstall','Status',
'RunOnce','ClearIntervention')] [string]$Action`) collided with a local
`$action` variable the `Install` branch used to hold the `New-ScheduledTaskAction`
CIM object — the assignment failed its inherited validation set, the
subsequent `Register-ScheduledTask` call received a stale string instead of a
real action object, and because neither failure was caught (no terminating-
error handling anywhere in that branch), execution fell through to the
hardcoded success messages regardless. No task was ever registered; the real
vault and all other tasks were unaffected — see the disposable-proof
transcript for full verification.
changed:
  - setup-life-ledger-sync-scheduler.ps1 — renamed the colliding local variable
    to `$taskAction`; audited every other branch for the same case-insensitive
    collision pattern against all four parameters (`$Action`/`$TaskName`/
    `$IntervalMinutes`/`$Apply`) — none found. Wrapped `New-ScheduledTaskAction`
    / `New-ScheduledTaskTrigger` / `New-ScheduledTaskSettingsSet` /
    `Register-ScheduledTask` in a `try`/`catch` with `-ErrorAction Stop` on
    each, so a real failure now throws instead of being silently swallowed.
    Added an independent `Get-ScheduledTask -ErrorAction Stop` verification
    inside that same `try` block immediately after registration — the
    "Task registered" success text can now only ever print after the exact
    task has been confirmed to actually exist. A failure at any step now
    prints a clear error and exits non-zero; documented that a failed
    replacement can leave no task registered under that name until Install
    is re-run (no transactional rollback built — out of scope for Phase 10).
    No change to interval/repetition/`IgnoreNew`/`StartWhenAvailable`/user-
    elevation semantics.
  - scripts/test-life-ledger-sync-scheduler-install.ps1 (new) — 14-check
    regression harness, no new test framework: static AST checks (no `$action`
    collision, `$taskAction` present, `Register-ScheduledTask` inside a `try`
    with `-ErrorAction Stop`, `Get-ScheduledTask` verification inside the same
    `try`, success text ordered strictly after verification) plus three
    dynamic scenarios that run the real `Install` branch in a disposable child
    `pwsh` process with all six `ScheduledTasks` cmdlets replaced by mock
    functions (success; `Register-ScheduledTask` throws; `Register-ScheduledTask`
    "succeeds" but `Get-ScheduledTask` finds nothing) — proving the exact false-
    success regression this fix closes can never recur, without ever touching
    a real scheduled task. (Along the way, confirmed empirically that `exit N`
    inside a dot-sourced/called nested script only sets `$LASTEXITCODE` in the
    caller's scope — the caller must itself re-`exit $LASTEXITCODE` for a real
    process exit code; documented inline in the harness.)
verification: PowerShell AST parser clean on both files; the new harness
  itself reports 14/14 checks passed (0 real/mock tasks left behind — confirmed
  via `Get-ScheduledTask` before and after); `npm test` (node:test aggregate)
  374/375 pass, 0 fail, 1 pre-existing env-gated skip — unchanged from before
  this fix, since no JS/browser file was touched; `npm run lint` 0 errors,
  same 19 pre-existing warnings; STRICT `npm run test:cross-repo-compat`
  (explicit MEAL_REPO_PATH / OPENGYM_REPO_PATH) PASS ChronaSense / PASS Meal /
  PASS Workout 29/29, zero leg skips, exit 0; `git diff --check` clean.
  Playwright not re-run (no browser-facing code changed). Real vault
  (`C:\Users\Admin\OneDrive\2nd Brain\Life Ledger`) hashes verified byte-
  identical before and after. No real or disposable scheduled task exists
  afterward (`ChronaSense Claude Overnight` / `ChronaSense Command Dispatcher`
  — the two pre-existing unrelated tasks — confirmed untouched throughout).
  Sibling repos and the authoritative main ChronaSense checkout unmodified.

## Phase 10 review-fix pass — intervention latch, serialized mirror writes, lock hardening (built, NOT activated) (branch: feat/life-ledger-background-automation-v1) — 2026-09-04
Closes four findings from the independent adversarial review of Phase 10 (architecture approved,
bounded hardening requested). No redesign — every fix composes on top of the existing modules.
Real scheduler activation and real-vault writes remain explicitly out of scope for this pass.
changed:
  - scripts/life-ledger-sync-worker.mjs — **persisted intervention latch** (Finding 1): a real
    (`--apply`) cycle result of `outcome === 'intervention_required'` now writes
    `<backupsRoot>/intervention-required.json` (schema version, `createdAt`, `runId`, outcome/
    category/reason/message, `planFingerprint`, `outboxSha256`, `receiptPath`, `written`,
    `failedRelativePath` — no vault contents, no secrets). Every later `--apply` invocation checks
    for the latch BEFORE calling the cycle at all and, if present, is refused outright: zero
    rollback-artifact preparation, zero backup copy, zero managed write, zero new receipt-
    directory churn no matter how many times the scheduler fires. New `--clear-intervention` flag
    (also exposed as `setup-life-ledger-sync-scheduler.ps1 -Action ClearIntervention`) removes
    only the latch file, touches nothing else, reports what was cleared, and is idempotent when
    nothing is latched. Dry runs may still observe/report the same underlying state while latched
    but never create or clear the latch. — **atomic stale-lock takeover** (Finding 3): breaking a
    stale lock is now a rename-to-a-unique-tombstone (`fs.rename`, atomic on a shared source path)
    instead of an unconditional `rm` + `open('wx')`; two contenders racing the same stale lock now
    resolve to exactly one winner, with the loser getting a clean `ENOENT` and backing off as
    "already running" rather than an unhandled exception or a double-acquisition. —
    **liveness-over-age lock semantics** (Finding 4): a lock with a parsable, confirmed-alive PID
    is now held regardless of age (previously a live-owner lock older than 30 minutes was
    incorrectly stolen); a confirmed-dead PID remains immediately reclaimable regardless of age;
    only a lock with no usable PID at all falls back to the 30-minute age ceiling, documented as a
    conservative last resort.
  - life-ledger-sync-bridge.js — **serialized mirror writes** (Finding 2): `writeOutboxSnapshotIfEnabled()`
    is now a strict FIFO promise queue (`enqueueWrite()`) — each call's snapshot is captured only
    when its task actually starts executing, and a later call's task cannot begin until every
    call enqueued before it has fully settled. This guarantees disk-commit order always matches
    call order and the final on-disk content always reflects the state at the time of the LAST
    call to actually execute, even when an earlier call's I/O is slower. A failed write resolves
    (never throws), so one failure never blocks the queue for later calls. `enable()`/`resume()`
    now route through the same queue. Also adds a best-effort **self-healing mirror refresh**
    (soft requirement): `getStatus()` compares the current canonical hash against the hash of what
    this bridge instance last successfully wrote and, on mismatch, schedules exactly one refresh
    through the same queue — never an aggressive retry loop — so a failed last-action mirror can
    recover the next time Settings is opened or the app reloads, without needing an unrelated new
    Ledger event.
  - life-ledger-sync-status-ui.js — `worker.outcome === 'intervention_required'` with
    `category === 'latched'` now renders distinct "paused pending manual review — clear the
    intervention latch" wording (still tone `error`), so the UI accurately implies automation has
    stopped pending a human action rather than the generic "needs attention" phrasing.
  - setup-life-ledger-sync-scheduler.ps1 — added `-Action ClearIntervention`; replaced
    `-RepetitionDuration ([TimeSpan]::MaxValue)` with a documented 10-year finite `TimeSpan`
    (some Windows Task Scheduler builds have been reported to handle a near-int64-max repetition
    duration inconsistently); `-Action Status` now surfaces whether the intervention latch is
    set; added explicit documentation that the registered task runs only while the owner is
    logged on and requires no elevation (intentional for this single-user desktop setup, not an
    oversight) — no scheduling-behavior change, comments/description text only plus the TimeSpan
    fix. Still not run with `-Action Install` in this pass.
  - docs/PHASE10_BACKGROUND_AUTOMATION.md — new "Persisted intervention latch" section; failure
    taxonomy table updated to reflect latch behavior (previously said a partial-write failure was
    just "never auto-retried" without mentioning the durable cross-invocation block this pass
    adds); new "Mirror write serialization" and "Self-healing mirror refresh" notes; documented
    run-log/receipt/backup retention as unbounded except where the latch itself prevents a fault
    loop from creating new receipts; documented Task Scheduler logged-on/no-elevation behavior and
    the TimeSpan fix; recorded orphaned-`.tmp`-file cleanup as Phase 11 info (pre-existing
    Phase-9-level characteristic, not a Phase 10 gap — no automatic deletion of unrecognized files
    was added).
  - CODEMAP.md — updated the four changed-module entries with the new latch/lock/queue behavior.
  - Test additions: life-ledger-sync-worker.test.js +9 (two-contender atomic takeover; latch
    scenarios A/B+C/D/E/E-idempotent/F/G per the review's required list), life-ledger-sync-bridge.test.js
    +8 (delayed-older-write ordering, three rapid writes, failure-does-not-poison-queue, revision,
    tombstone, focus+plan-step back-to-back, two self-healing tests), life-ledger-sync-status-ui.test.js
    +1 (latched wording). One existing worker test (`an old lock ... is broken even if the PID
    happens to be reused`) was rewritten to assert the CORRECTED Finding-4 behavior (a live-PID
    lock is now held, not broken, regardless of age) plus a new companion test for the
    malformed-lock age-fallback path.
verification: `node obsidian-life-ledger-sync.test.js` 66/66 unchanged; `npm test` (node:test
  aggregate) 374/375 pass, 0 fail, 1 pre-existing env-gated skip; `npm run lint` 0 errors (same
  19 pre-existing warnings, none in files this phase touched); STRICT `npm run test:cross-repo-compat`
  (explicit MEAL_REPO_PATH / OPENGYM_REPO_PATH) PASS ChronaSense / PASS Meal / PASS Workout 29/29,
  zero leg skips, exit 0; `npx playwright test` 214/214 unchanged; `git diff --check` clean;
  `node --check` clean on every Phase 10 JS/MJS file; PowerShell AST parser clean on the updated
  scheduler script. Real vault (`C:\Users\Admin\OneDrive\2nd Brain\Life Ledger`) hashes verified
  byte-identical before and after this fix pass. Sibling repos (Meal prep app, openGym-longevity)
  and the authoritative main ChronaSense checkout were not modified.
  `OBSIDIAN_PRODUCTION_SYNC_ENABLED` untouched at `true`. Real Windows Task Scheduler registration
  and any real-vault write were both explicitly NOT performed.

## Phase 10 — Life Ledger background sync automation (built, NOT activated) (branch: feat/life-ledger-background-automation-v1) — 2026-09-03
Removes the manual "export JSON, run the sync CLI by hand" step from the proven Phase 9 flow.
Adds a browser-side durable outbox mirror, a one-shot Windows background worker, and an
existing-root safe sync transaction (fresh rollback artifact per changing cycle, fail-closed on
any conflict, no blind retry after a partial write). All Phase 9 write-path safety logic
(ownership sentinel, manifest binding, preflight precondition re-check, production authorization
chain) is reused unchanged — Phase 10 is transport and scheduling around it, not a rewrite of it.
The real Windows scheduled task was never registered and the real OneDrive vault was never
written to during this build; see `docs/PHASE10_BACKGROUND_AUTOMATION.md` for the full design and
the post-review activation steps.
changed:
  - life-ledger-sync-cycle.js (new) — `runLifeLedgerSyncCycle()`: parses an outbox snapshot,
    plans (read-only), classifies into `no_source` / `unchanged` / `would_sync` (dry run) /
    `conflict` / `synced` / `intervention_required` / `error`, and — only for safe changes —
    prepares a fresh `prepareObsidianRollbackArtifact()`, verifies it, applies, and re-plans to
    verify the resulting state. Refuses to auto-acknowledge a first-run state
    (`unexpected_first_run_state`) — recreating a managed root stays a human-only decision via
    the existing `--first-run-ack` CLI path. `summarizeCycleResultForOutbox()` trims a result to
    a small, path-free subset safe for the browser-writable outbox folder.
  - scripts/life-ledger-sync-worker.mjs (new) — one-shot CLI: config resolution (flags override
    `scripts/life-ledger-sync-worker.config.json`, gitignored), a single-instance lock file with
    stale-lock detection (dead PID or >30min old), reads the outbox snapshot, calls the cycle
    (dry run unless `--apply`), writes a run log + `status.json` under `backupsRoot`, and writes
    a truthful status file back into the outbox folder.
  - life-ledger-sync-bridge.js (new) — browser-side durable transport: a one-time
    `showDirectoryPicker()` grant (persisted in IndexedDB) lets every successful Life Ledger
    write mirror the exact deterministic `exportLifeLedgerSnapshotJson()` envelope into a local
    outbox file, with no manual export click. Never throws into the caller; never auto-prompts
    for a lapsed permission (only an explicit user-gesture `resume()` re-requests it). Fully
    dependency-injected for testing (fake handle store / picker / digest).
  - life-ledger-sync-status-ui.js (new) — Settings UI wiring plus the pure, DOM-free
    `describeLifeLedgerSyncStatus()`: only ever renders "Life Ledger synced." when the worker's
    own reported outcome AND its recorded outbox hash match the CURRENT local snapshot — local
    persistence alone is never treated as proof of sync.
  - learning-plan-ui.js — added `mirrorLifeLedgerToOutbox()` (fire-and-forget, swallows its own
    errors) called after each of the five existing successful Life Ledger record paths (manual
    complete, manual reopen, focus-session-completed, plan-step-completed, and the retry-queue
    success path). No existing function signature changed.
  - index.html — added the Background Sync button/status elements under Settings → Data, and the
    `life-ledger-sync-status-ui.js` module script include. No existing markup removed or altered.
  - setup-life-ledger-sync-scheduler.ps1 (new) — `-Action Install|Uninstall|Status|RunOnce`
    Windows Task Scheduler install/start/stop/diagnostic interface, mirroring the existing
    `setup-task-scheduler.ps1` registration pattern (`MultipleInstances = IgnoreNew`). `Install`
    defaults to dry-run-only scheduled cycles unless `-Apply` is passed. Not run against the real
    task name during this Builder phase.
  - scripts/life-ledger-sync-worker.config.example.json (new) — committed placeholder shape;
    the real, machine-specific config file is gitignored.
  - eslint.config.js — added the three new browser-facing `.js` files to the ESM file list (and
    its `sourceType:'script'` fallback block's `ignores`), matching the existing pattern for
    every other `import`/`export`-using root file.
  - package.json — wired the four new test files (`life-ledger-sync-cycle.test.js`,
    `life-ledger-sync-bridge.test.js`, `life-ledger-sync-status-ui.test.js`,
    `scripts/life-ledger-sync-worker.test.js`) into the aggregate `test` script plus individual
    `test:life-ledger-sync-*` shortcuts, added `life-ledger-sync:run-once`, and added the four
    new source files to `lint`.
  - .gitignore — ignores the real (non-example) worker config file.
  - CODEMAP.md — five new module entries; corrected two stale "production sync is hard-disabled
    (`OBSIDIAN_PRODUCTION_SYNC_ENABLED = false`)" claims left over from before Phase 9B enabled
    it, found while documenting the module Phase 10 builds directly on top of.
  - docs/PHASE10_BACKGROUND_AUTOMATION.md (new) — full architecture writeup: transport authority,
    worker model, existing-root transaction, rollback-artifact lifecycle, failure taxonomy, status
    truthfulness contract, install/start/stop, what's automated vs. manual, known limitations.
  - New test files: life-ledger-sync-cycle.test.js (19), life-ledger-sync-bridge.test.js (14),
    life-ledger-sync-status-ui.test.js (11), scripts/life-ledger-sync-worker.test.js (9),
    tests/life-ledger-background-sync-ui.spec.js (2, Playwright) — 53 new node:test cases + 2 new
    Playwright tests, all against disposable temp vaults/dirs; the real vault was never touched
    by any test. [Corrected 2026-09-04: the original count here said 20/54 — off by one on the
    cycle suite; see the review-fix entry above this one.]
verification: `npm test` (node:test aggregate across all suites) 356/357 pass, 0 fail (the one
  skip is the pre-existing env-gated cross-repo control test, same as baseline); `npm run lint`
  0 errors (same 19 pre-existing warnings in files this phase did not touch); `npx playwright
  test` 214/214, all 214 pre-existing-plus-new tests counted together (not 216 as originally and
  incorrectly stated — see the correction above); STRICT `npm run test:cross-repo-compat`
  (explicit MEAL_REPO_PATH / OPENGYM_REPO_PATH)
  PASS ChronaSense / PASS Meal / PASS Workout 29/29, zero leg skips, exit 0. Real vault
  (`C:\Users\Admin\OneDrive\2nd Brain\Life Ledger`) hashes verified byte-identical before and
  after this entire build. Sibling repos (Meal prep app, openGym-longevity) and the authoritative
  main ChronaSense checkout were not modified. `OBSIDIAN_PRODUCTION_SYNC_ENABLED` left
  untouched at `true`. Real Windows Task Scheduler registration and any real-vault write were
  both explicitly NOT performed — see `docs/PHASE10_BACKGROUND_AUTOMATION.md`'s Activation
  section for the deliberate post-review steps.

## Phase 9B — receipt activation-path hardening (pre-production, still disabled) (branch: fix/phase9b-receipt-activation-hardening) — 2026-09-03
Small hardening slice closing the two activation-path findings from the independent review of
the approved first-run rollback receipt. No production enablement, no real-vault write, no
receipt modification. `OBSIDIAN_PRODUCTION_SYNC_ENABLED` stays `false`. One local commit; not
pushed, not integrated. Stops for independent hardening review.
changed:
  - obsidian-life-ledger-sync.js — FIX 1: `verifyObsidianRollbackReceipt()` now requires
    `receipt.backup === null` (strict) whenever `receipt.managedRootExistedBefore === false`.
    A first-run receipt carrying any backup payload is structurally wrong and is rejected
    before the pre-state check. The existing-root path (`managedRootExistedBefore === true`)
    is untouched — it still requires a present, byte-verified backup.
  - scripts/sync-life-ledger-to-obsidian.mjs — FIX 2: `--rollback-receipt` is now loaded via
    `loadRollbackReceiptFromDisk()` (exported), which resolves/canonicalises the path, reads
    the exact on-disk bytes, `JSON.parse`s them, and attaches runtime-only `receiptPath`
    (resolved path) + `receiptSha256` (SHA-256 of the live bytes — never a caller-supplied
    hash) to the in-memory object only. Nothing is written back to the receipt JSON. Fails
    closed on a missing / unreadable receipt, invalid JSON, or non-object JSON. The previous
    bare `JSON.parse(readFile(...))` (which never attached the runtime metadata the verifier
    needs) is replaced.
  - obsidian-life-ledger-sync.test.js — +13 tests: first-run receipt backup:null valid;
    backup:{...} / backup:"anything" / backup:{} / backup:undefined invalid; non-first-run
    semantics preserved (real backup valid, backup:null rejected); first-run managed root
    appears -> invalid; CLI loader reads real bytes / computes SHA-256 / attaches
    receiptPath+receiptSha256 / does not mutate the file; post-load byte change rejected;
    reloaded-modified receipt still rejected on plan binding; missing receipt / malformed
    JSON fail closed; planFingerprint mismatch and canonical-vault mismatch fail closed; CLI
    production --apply with a real receipt path stays `production_sync_disabled` and never
    rewrites the receipt.
verification: `node obsidian-life-ledger-sync.test.js` 63/63; `npm test` all green (0 fail;
  the single skip is the pre-existing env-gated cross-repo control test); `npm run lint` 0
  errors (19 pre-existing warnings); STRICT `npm run test:cross-repo-compat` PASS ChronaSense
  / PASS Meal / PASS Workout 29/29, zero leg skips, exit 0; `git diff --check` clean;
  `node --check` on all three changed files OK; non-ASCII scan clean (em-dash only, matching
  the file). Real approved receipt (Phase9B-FirstRun-Receipt-20260903-102747), READ-ONLY:
  disk SHA-256 still cb5dea254938e7cfa9da9c7a1906c3b5eda6192b2c4c48bd264f2f141168763f; the
  CLI loader enriches it (receiptPath resolved, receiptSha256 = live-byte hash, file
  unmodified); `verifyObsidianRollbackReceipt()` returns true against a plan carrying the
  approved fingerprint 10cb4dc2326674ebc141c1ff2c358b108cb63690341aaf9ad90d00251a153286
  (the approved plan's source snapshot is live-only and not persisted, so the plan was
  reconstructed from the receipt's own bindings — the receipt→planFingerprint binding is the
  generic mechanism). Real vault `C:\Users\Admin\OneDrive\2nd Brain\Life Ledger` absent
  before and after. Authoritative main unchanged at 90ea1f0 (M README.md / ?? APP_CONTEXT.md
  intact, protected hashes unchanged).
future work (NOT in this slice):
  - No `delete_managed_root` rollback executor exists. Any future one MUST call
    `inspectManagedRoot`, require `state === 'owned'`, verify the sentinel↔manifest binding,
    and never blindly `rm -rf` an unverified subtree. Separately reviewed change.

## Phase 9 — Obsidian ownership + rollback hardening (post independent review) (branch: feat/real-obsidian-integration-v1) — 2026-09-02
FIX FIRST pass. Architecture unchanged (Ledger → renderer → planner → authorization → apply);
one consolidated filesystem/ownership hardening pass, one local fix commit. Still no push, no
merge, no production enablement, no real-vault write. Ready for targeted independent re-review.
changed:
  - obsidian-life-ledger-sync.js — 12 hardening fixes; the plan/apply architecture is intact:
    - FIX 1 NO SENTINEL-ONLY OWNERSHIP: a root counts as owned ONLY when a schema-v2 sentinel
      validates, manifest.json exists and validates, AND `sha256(manifest bytes)` equals the
      sentinel's `manifestSha256`. Sentinel-valid + manifest-absent → BLOCK
      `missing_manifest_baseline`. Legacy v1 sentinel (no binding) → BLOCK
      `legacy_sentinel_migration_required` — old Phase-1-pass content is never silently adopted.
    - FIX 2 SENTINEL↔MANIFEST BINDING: sentinel schema advanced to v2 with a required
      `manifestSha256: <sha-256>` field. Manifest bytes edited → mismatch → BLOCK
      `manifest_integrity_mismatch`. Sentinel prose edited → `sentinelContent()` is fully
      deterministic given its hash, so any deviation → BLOCK `sentinel_content_mismatch`.
      Manifest present + sentinel missing → BLOCK. (Not called cryptographic authentication —
      integrity detection for hand edits, OneDrive conflict copies, partial applies.)
    - FIX 3 PER-FILE BASELINE REQUIRED: deleted the `adopting_sentinel_owned_file` UPDATE
      branch. An existing generated file: byte-identical → UNCHANGED; differs + no sentinel
      marker → CONFLICT `unowned_collision`; differs + marker + NO trusted manifest baseline →
      CONFLICT `missing_manifest_baseline` (never UPDATE); differs + baseline ≠ disk → CONFLICT
      `human_modified_owned_file`; differs + baseline == disk → UPDATE `content_drift`.
    - FIX 4 WINDOWS-NORMALIZED MANIFEST KEYS: `manifestKeyIdentity()` lowercases + slash-
      normalizes for identity/dedup only; the stored/rendered path stays the code-owned
      canonical form. Case-only and slash-vs-backslash duplicates reject the whole manifest.
    - FIX 5 MANIFEST ALLOWLIST: every manifest entry must be a known generated CONTENT path
      (`System/README.md` or `Daily/YYYY-MM-DD.md`), 64-hex sha256, Windows-safe. Unknown /
      absolute / traversal / duplicate entries reject the manifest → BLOCK.
    - FIX 6 UNCHANGED TOCTOU: apply preflight now re-hashes EVERY operation (UNCHANGED and
      STALE included), not just CREATE/UPDATE. Any drift → `precondition_changed`, zero writes.
    - FIX 7 PER-WRITE LINK RECHECK: `guardedAtomicWrite()` re-resolves the destination and
      re-runs containment + `assertNoLinkEscape` + `assertSafeExistingLeaf` immediately before
      each write, and again after `mkdir` so a junction inserted for a not-yet-existing parent
      is caught.
    - FIX 8 CONTENT HASH ASSERTION: `sha256(operation.content) === operation.contentSha256`
      is asserted before each write → `invalid_plan_content`, zero further writes.
    - FIX 9 EXPLICIT APPLY ORDER: operations carry a `phase` (0 content, 1 manifest, 2
      sentinel). Apply writes strictly by phase — content, then manifest, then sentinel LAST —
      never by filename sort. A valid on-disk sentinel therefore implies a matching manifest
      and complete content.
    - FIX 10 PARTIAL-APPLY RECOVERY: a mid-apply failure throws `partial_apply_failure` with
      the written list; a fresh plan afterward always fails closed (sentinel missing, or
      `manifest_integrity_mismatch`) — partial state is never auto-adopted.
    - FIX 11 REAL ROLLBACK ARTIFACT API: `prepareObsidianRollbackArtifact({ target, plan,
      backupRoot })` → frozen receipt bound to canonical vault + managed root + plan
      fingerprint + `managedRootExistedBefore`. First run: a pre-state receipt (managed root
      must still be absent at verify time). Existing root: copies ONLY the `Life Ledger/`
      subtree, hashes every file, invalidates on backup mutation. Refuses a `backupRoot`
      inside the vault; never overwrites an existing artifact.
      `verifyObsidianRollbackReceipt()` re-checks all bindings + the on-disk receipt hash +
      the backup bytes.
    - FIX 12 WINDOWS PATH HARDENING: `assertSyncRelativePath()` also rejects any `:` in a
      segment, trailing dot/space, and reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9).
    - PRODUCTION AUTH: `evaluateProductionAuthorization()` now requires `rollbackReceiptValid`
      (verified receipt) before the first-run token. `OBSIDIAN_PRODUCTION_SYNC_ENABLED` stays
      false; `applyObsidianSync` still throws `production_sync_disabled` before any receipt
      check.
  - scripts/sync-life-ledger-to-obsidian.mjs — `--first-run-backup-confirmed` replaced by
    `--rollback-receipt <path>` (reads a receipt JSON); summary carries `blockState` +
    `planFingerprint`.
  - obsidian-life-ledger-sync.test.js — rewritten: 50 tests including the review's A–I
    ownership-chaos matrix, J–M file-baseline matrix, N–Q manifest-identity matrix, R–T TOCTOU
    matrix, explicit apply-order assertion (rename order instrumented), sentinel↔manifest
    binding, rollback-artifact first-run + existing-root + tamper cases, production hard-block
    with a valid receipt, and the CLI surface.
  - obsidian-life-ledger-writer.js — no further change (still additive exports only from the
    first pass). `writeFileAtomically` is no longer imported by the sync module (it uses
    `guardedAtomicWrite`).
  - CODEMAP.md — sync-module + CLI entries updated for the v2 schema and rollback API.
verification: `node obsidian-life-ledger-sync.test.js` 50/50; `node test.js` 448/448; `npm test`
  721 (0 fail, 0 skip); `npm run test:adapter-contracts` PASS; `npm run lint` 0 errors (19
  pre-existing warnings); Playwright NOT run (no UI change). Test-vault E2E proof
  (Second-Brain-Test-Vault): v1 pass-1 fixture correctly BLOCKED
  `legacy_sentinel_migration_required` → Phase-9 test artifacts reset (authorized) → 5-file
  CREATE → apply → schema-v2 sentinel with a matching `manifestSha256` binding, manifest lists
  content files only → second plan all UNCHANGED → human edit → CONFLICT
  `human_modified_owned_file`, apply refused, edit preserved → manifest byte appended → BLOCK
  `manifest_integrity_mismatch` → clean restore. Real active vault
  (C:\Users\Admin\OneDrive\2nd Brain): READ-ONLY; `Life Ledger/` absent before and after; git
  HEAD d265b96 and 35-line status unchanged before and after; test mode → `denied_vault_root`,
  production with every flag → `production_sync_disabled`, zero writes. `node --check` all
  changed files OK; `git diff --check` clean; UTF-8/control-byte scan clean (only non-ASCII is
  the em-dash, matching the renderer). STRICT `npm run test:cross-repo-compat`: ChronaSense +
  Meal legs PASS; Workout leg STILL FAILS via the spawnSync path with the SAME pre-existing
  Windows environment artifact ("Cannot read properties of undefined (reading 'config')" at
  workout-ledger-source-contract.test.js:69) — reproduces identically on unmodified main and
  when this Builder runs the compat script directly; the workout suite passes 29/29 invoked
  directly and the Meal leg (also vitest) passes via the identical spawn path; NOT a Phase 9
  regression; per review instruction the compat runner and the Workout repo were NOT modified.

## Phase 9 — Real Obsidian Integration V1 (production-safe, real-write-DISABLED) (branch: feat/real-obsidian-integration-v1) — 2026-09-02
FIRST-PASS builder milestone. No commit beyond one local feature commit; no push, no merge, no
real-vault write. Production apply is hard-blocked pending independent adversarial review.
added:
  - obsidian-life-ledger-sync.js (new — the production-capable Obsidian sync planner/applier,
    deliberately separate from obsidian-life-ledger-writer.js because that writer is
    test-vault-only by design and its own tests assert it unconditionally blocks both real
    vaults):
    - TARGET MODEL: `createObsidianSyncTarget({ vaultPath, managedRoot:'Life Ledger',
      mode:'test'|'production', allowApply:false })` — frozen, validated; managedRoot must be
      exactly 'Life Ledger' (an arbitrary caller string can never pick the filesystem target).
    - IDENTITY CHECK: `verifyObsidianVaultIdentity()` — read-only, never throws for an ordinary
      "not safe" outcome (returns `{ ok:false, reason }`). Canonical realpath; rejects a
      missing path, a non-directory, a symlink/junction vault root, the stale Desktop vault
      (always), the real OneDrive vault (test mode), the test vault (production mode), and a
      vault path inside a supplied known-repo-root list. Production mode additionally requires
      an exact `expectedCanonicalVaultPath` match — it never auto-discovers a vault. Soft
      signals: `.obsidian` presence, OneDrive-path heuristic.
    - OWNERSHIP SENTINEL: `Life Ledger/System/MANAGED-BY-CHRONASENSE.md` — deterministic
      machine-readable frontmatter (owner + schemaVersion + managedRoot), no volatile fields.
      Presence alone is NOT ownership proof; it is one signal.
    - MANIFEST: `Life Ledger/System/manifest.json` — deterministic (sorted, SHA-256 per file,
      schema version, relative managed paths only, duplicate entries reject the whole
      manifest). Drives human-edit drift detection. manifest.json is treated as pure
      operational metadata (always safe to rewrite once the sentinel proves the root owned).
    - PLAN / APPLY SPLIT: `planObsidianSync()` returns a frozen plan of
      `CREATE|UPDATE|UNCHANGED|CONFLICT|BLOCKED|STALE` ops (sorted by relativePath, each with
      contentSha256 + previousSha256) plus `rollbackPlan`. `applyObsidianSync(plan,
      authorization)` re-verifies every writable target's precondition hash against the plan
      (TOCTOU) with ZERO writes if anything changed, then two-phase preflight-then-write.
    - OWNERSHIP MODEL (safest coherent V1): only code-allowlisted generated paths
      (`System/README.md`, `System/MANAGED-BY-CHRONASENSE.md`, `System/manifest.json`,
      `Daily/YYYY-MM-DD.md`) are app-owned. An existing `Life Ledger/` without a valid
      sentinel (INCLUDING an empty dir, and INCLUDING the pre-Phase-9 old-schema test-vault
      folder) is classified `unmanaged_conflict` and never auto-adopted or merged. A
      sentinel-bearing generated file whose on-disk SHA-256 ≠ its last manifest hash is a
      `human_modified_owned_file` CONFLICT — never silently overwritten. Any CONFLICT blocks
      the entire apply.
    - NO DELETION BY ABSENCE: a manifested Daily file absent from a later snapshot is reported
      `STALE` and left on disk (this new module supersedes the legacy writer's stale-Daily
      cleanup for production-capable flows; the legacy CLI/writer behavior is unchanged).
    - PARTIAL FAILURE: a mid-apply write error throws `partial_apply_failure` carrying the
      list of files already written — never a bare fs error that looks like "nothing
      happened", never a false success.
    - PRODUCTION HARD BLOCK: `OBSIDIAN_PRODUCTION_SYNC_ENABLED = false` — every production
      apply throws `production_sync_disabled` before any other check, regardless of flags or
      tokens. `evaluateProductionAuthorization()` is the pure, separately-testable second
      layer (mode + allowApply + apply + exact canonical-path match + path-bound
      `FIRST-RUN-CONFIRMED:<path>` token + first-run backup acknowledgement) for when the
      constant is deliberately flipped after review.
  - scripts/sync-life-ledger-to-obsidian.mjs (new — production-capable CLI parallel to the
    untouched export-life-ledger-to-obsidian.mjs. `--mode test|production` required, no
    default; plans + previews always; writes only with `--apply`; production needs
    `--expected-vault` / `--first-run-ack` / `--first-run-backup-confirmed` and is still
    refused by the build constant).
  - obsidian-life-ledger-sync.test.js (new — 54 tests: target-model validation, denied/stale
    vault rejection in both modes, exact canonical-path binding, known-repo-root rejection,
    unmanaged-root conflict (incl. empty dir), valid/invalid sentinel, malformed manifest,
    unowned collision, manifest-drift human-edit conflict, block-entire-apply-on-conflict,
    idempotency, deterministic ordering + byte-identical plan content, STALE-not-delete,
    TOCTOU abort with zero writes, symlink-after-plan abort, manifest shape (SHA-256, sorted,
    no dupes, relative paths), production hard-block via applyObsidianSync even with perfect
    auth, second-layer authorization via evaluateProductionAuthorization, rollback artifact,
    partial-failure honesty, preview format (no absolute paths leaked), plus 10 CLI tests).
changed:
  - obsidian-life-ledger-writer.js — additive `export` keywords only on the denylist-agnostic
    containment primitives (assertRelativePath, assertNoLinkEscape, assertSafeExistingLeaf,
    pathEqualsOrContains, isLinkStats, realPathOrResolved, readTextIfExists, writeFileAtomically,
    defaultFsAdapter) + a read-only `OBSIDIAN_LIFE_LEDGER_DENIED_VAULT_ROOTS` alias. Zero logic
    or behavior change; existing 448 test.js tests unaffected.
  - package.json — `test` chains `node obsidian-life-ledger-sync.test.js`; new
    `test:obsidian-sync` script; `lint` covers the two new files.
  - eslint.config.js — obsidian-life-ledger-sync.js added to both file lists (scripts/**/*.mjs
    glob already covered the new CLI).
  - CODEMAP.md — entries for obsidian-life-ledger-sync.js and scripts/sync-life-ledger-to-obsidian.mjs.
verification: `node obsidian-life-ledger-sync.test.js` 54/54; `npm test` 725 model/unit
  (0 fail, 0 skip — test.js 448 + workout-adapter 33 + meal-adapter 45 + meal-cross-repo 10 +
  temporal 20 + life-feed 36 + life-character-sheet 34 + cross-domain 45 + obsidian-sync 54);
  `npm run test:adapter-contracts` PASS; `npm run lint` 0 errors (19 pre-existing warnings);
  Playwright NOT run (no UI change). Strict `npm run test:cross-repo-compat`: ChronaSense +
  Meal legs PASS; Workout leg FAILS via the spawnSync path with a pre-existing Windows
  nested-npm/vitest environment artifact ("Cannot read properties of undefined (reading
  'config')") that reproduces IDENTICALLY on unmodified main and is NOT a Phase 9 regression —
  the workout source-contract suite itself passes 29/29 when invoked directly. `node --check`
  on all changed/new files OK; `git diff --check` clean; UTF-8/control-byte scan clean.
  Test-vault E2E proof (real Second-Brain-Test-Vault): old-schema fixture correctly BLOCKED as
  unmanaged_conflict → fixture reset (authorized by TEST-VAULT.md + spec §22) → CREATE plan →
  authorized test apply (4 files) → second plan all UNCHANGED → human edit → CONFLICT + apply
  refused + edit preserved on disk → reset to a clean Phase-9 managed subtree. Real active
  vault (C:\Users\Admin\OneDrive\2nd Brain): READ-ONLY inspection only; `Life Ledger/` absent
  before and after; git status 29 lines and HEAD d265b96 unchanged before and after; test
  mode → denied_vault_root, production mode with every correct flag → production_sync_disabled,
  zero writes.

## Phase 8 — recommendation-honesty fixes (post independent review) (branch: feat/cross-domain-intelligence-v1) — 2026-09-02
changed:
  - cross-domain-intelligence-model.js — two bounded fixes from the independent review; no
    redesign, no UI code change:
    - BLOCKER 1 (bare recency-fallback plan): `learningCandidate()` now returns null when the
      active plan is neither target-aligned nor actively tracked. The Character Sheet's
      active-plan pick can fall back to `updatedAt` (a metadata-only edit can flip it) — that
      heuristic alone must never become a top-level recommendation. The
      `learning-plan-incomplete` attention signal still carries plan title + progress + next
      step; the engine abstains (`recommendedAction: null`, confidence INSUFFICIENT). "Actively
      tracked" = ≥1 current-truth `plan_step_completed` maps to the plan (derived from the feed,
      not the `latestCompletedStep` proxy).
    - BLOCKER 2 (plan-level historical alignment): `learningAlignment()` now imports
      `CAPABILITY_CAREER_ANALYTICS_RULES` and requires a linking evidence record within
      `recentDays` of `generatedAt` (identical temporal test to `analytics.recentEvidence()` —
      no new magic number). An old historical link no longer grants HIGH / tier 2 indefinitely;
      it falls through to non-aligned logic (MEDIUM when the plan is actively tracked).
    - explanation: HIGH now says recent evidence links *past completed steps* to the target
      "— not the next step itself"; MEDIUM (tracked, unaligned) states factual tracking only;
      the recency-fallback abstention reason names the plan as "picked only by recency".
  - cross-domain-intelligence-model.test.js — 45 model tests (was 35): scenarios M / M2 / N /
    N2 / O added; alignment recency-boundary tests (observedAt at the lower bound / 1 ms before
    / in the future); the "Character Sheet parity: step counts" test split into an abstention
    variant + a tracked-plan variant; B / C / J / L / analyzer-throw / hostile-text /
    performance / revised-planId / non-target-project fixtures updated to seed an actively
    tracked completion where a candidate is genuinely expected (they previously encoded the
    now-removed bare-LOW behavior).
  - tests/cross-domain-intelligence-ui.spec.js — 13 tests (was 12): a new "recency-only plan
    is not recommended" abstention-rendering test; the shipping-beats-learning fixture now
    seeds a tracked completion so learning is a valid alternative; the "aligned learning" test
    renamed to "actively tracked learning" and asserts the MEDIUM strength tag exactly.
verification: `node cross-domain-intelligence-model.test.js` 45/45; `npm test` 671 model/unit
  (0 fail, 0 skip); `npm run test:adapter-contracts` PASS; `npm run lint` 0 errors (19
  pre-existing warnings); Playwright full suite 208/208; strict `npm run test:cross-repo-compat`
  3/3 legs PASS, no skips, exit 0; `node --check`, `git diff --check`, control-byte scan (0).

## Phase 8 — Cross-Domain Intelligence / Highest-Leverage Next Action V1 (branch: feat/cross-domain-intelligence-v1) — 2026-09-01
added:
  - cross-domain-intelligence-model.js (new — the pure, deterministic, rule-based engine that
    answers "what deserves my attention next, and what is the single highest-leverage next
    action I can actually take?". `buildCrossDomainIntelligence({ characterSheet, ledgerEvents,
    learningPlans, capabilityProfile })` → { coverage, capability, signals[], candidates[],
    recommendedAction, alternatives[], blockedDomains[], abstained, abstentionReason,
    explanation }. No LLM. Never persisted as a new truth store; never mutates its inputs;
    order-independent. FOUR LAYERS kept separate: FACT (read off the Character Sheet /
    analyzer) → SIGNAL (a factual condition that may deserve attention, no step implied) →
    CANDIDATE (a bounded thing the system could recommend, with stable provenance) →
    RECOMMENDATION (the single highest-ranked justified candidate + a fully traceable "why").)
  - COVERAGE-AWARE REASONING: a domain participates only when its Character Sheet coverage is
    `active` or `no-events-yet` (a truthful live zero). Workout / Meal / free-form activity are
    reported in `blockedDomains` as "not evaluated" — never inactive / healthy / unhealthy /
    on-track / off-track / behind. An old imported workout never becomes "you haven't worked
    out"; no focus session today never becomes a productivity verdict. Missing data is never
    turned into a negative signal.
  - CANDIDATE SOURCES (V1): (a) `learning-plan-step` — the Character Sheet's active-plan next
    unfinished step (reused verbatim, not re-traversed); (b) `capability-next-action` — the
    analyzer's own `nextAction`, but only when it is stall-driven AND (for ship / portfolio
    kinds) points at an explicit target-linked project. Setup states and bare shipping stalls
    with nothing concrete to act on stay SIGNALS — no task is invented to fill the slot.
  - ALIGNMENT CHAIN (explicit ids only, no keyword matching): a learning candidate is "aligned"
    iff there is capability evidence (source: life-ledger, not future-dated) that points at a
    plan_step_completed event of the active plan AND is attached to a skill linked to the
    active career target — plan step → Ledger event → evidence → target skill → career target.
  - RANKING: four discrete transparent tiers — (1) resolve a stall with a concrete
    target-linked project, (2) advance target-aligned committed work, (3) resolve a bare
    stall, (4) advance the learning plan — then evidence strength (HIGH / MEDIUM / LOW), then
    a stable domain / candidateId tie-break. No fake points or percentages. First-time career
    setup is an attention signal, never a candidate.
  - ABSTENTION is a feature: `recommendedAction: null` + a plain-language reason when there is
    no active plan step and no explicit career action. The engine never forces a recommendation
    to fill the UI.
  - cross-domain-intelligence-ui.js (new — renders the read-only "Next" view into
    #cross-domain-intelligence-root. Reads the Life Ledger runtime, Learning Plan repository
    and Capability profile ONCE per render, builds the pure Character Sheet, hands it to the
    pure engine, and paints: recommendation (headline + "why this" + evidence + strength tag) →
    other valid options → what's driving attention (signals) → data not evaluated. The only
    control is a plain `showView()` navigation link — no plan-step completion, no focus start,
    no writes. Semantic headings, textual (not colour-only) confidence, keyboard-operable,
    escaped rendering.)
  - cross-domain-intelligence-model.test.js (new — 35 model tests: scenario matrix A–L,
    abstention, Character Sheet / Capability analyzer / Learning parity, driving-stall parity,
    non-target-linked project → signal-not-candidate, determinism under event & profile
    reordering, temporal chaos (stale import, future evidence, cross-zone step), coverage
    chaos (imported-not-live, analyzer throw, malformed sheet), read-only,
    hostile-text-stays-inert, neutral-language, performance.)
  - tests/cross-domain-intelligence-ui.spec.js (new — 12 Playwright tests: third "Next"
    sub-tab with still-7 bottom-nav, honest empty state, aligned recommendation with traceable
    why + evidence, shipping-beats-learning with learning as alternative, data-not-evaluated
    explained in words, "Open in Learning Plans" navigates with zero writes, byte-level
    read-only proof across tab switches, keyboard operability, hostile-HTML escaping,
    aria-live, no-horizontal-overflow on a 390px phone, no moral/productivity language.)
changed:
  - life-character-sheet-model.js (learning section now also exposes stable ids —
    `activePlan.id`, `activePlan.nextStep.{stepId,lessonId,phaseId}`,
    `latestCompletedStep.planId`. Additive only; ids are facts. Phase 8 consumes these for
    candidate provenance and to reuse the exact active plan / next step the sheet already
    picked, guaranteeing learning parity by construction. No change to any existing field.)
  - life-character-sheet-model.test.js (2 new tests covering the exposed ids.)
  - life-character-sheet-ui.js (the Life sub-navigation is now three-way — Character Sheet ·
    Timeline · Next. `showLifeSubview()` / `initialSubview()` handle the third view and call
    `window.renderCrossDomainIntelligence()`; the stored `ta3-life-subview` preference accepts
    `next`. No change to the Character Sheet render itself.)
  - index.html (#view-life gains a third `.life-subnav` button (`#life-subnav-next`) and a
    `#cross-domain-intelligence-root` mount that starts hidden; new module `<script>` include.
    Still 7 bottom-nav items — no 8th.)
  - style.css (appended `.cdi-*` block — committed dark theme, reuses existing tokens; strength
    tag is bordered text, never colour-only.)
  - package.json (test script runs cross-domain-intelligence-model.test.js; new
    test:cross-domain-intelligence script; lint covers the two new modules.)
  - eslint.config.js (registers cross-domain-intelligence-model.js + -ui.js.)
verification: npm test (661 model/unit — test.js 448 + 35 new intelligence + 2 new Character
  Sheet id tests + the existing suites), test:adapter-contracts, strict test:cross-repo-compat
  (3/3 legs, no skips, exit 0), lint (0 errors, 19 pre-existing warnings), Playwright smoke /
  learning-plan-ui / capability-career-ui / plan / life-feed-ui / life-character-sheet-ui /
  cross-domain-intelligence-ui (207/207), node --check, git diff --check, control-byte scan (0).

## Phase 7 — Life Character Sheet V1 (branch: feat/life-character-sheet-v1) — 2026-09-01
added:
  - life-character-sheet-model.js (new — the canonical, UI-independent "where am I right now?"
    projection. `buildLifeCharacterSheet({ ledgerEvents, learningPlans, capabilityProfile, now,
    referenceTimeZone, liveIngestedTypes })` → a pure derived snapshot with focus / time /
    learning / capability / workout / meal / coverage sections. Never persisted as a new truth
    store; never mutates its inputs. Feed parity by construction: every Ledger-derived fact is
    read off the item set produced by buildLifeFeed() (same accept / tombstone / revision /
    day-bucketing rules), then joined back to the raw event only for a numeric payload value.
    Capability facts come straight from analyzeCapabilityCareer() (tombstone-aware evidence
    scope, no title/keyword inference). Learning progress + next step reuse
    getLearningPlanProgress() and findNextLearningPlanStep().)
  - life-character-sheet-ui.js (new — renders the snapshot into #life-character-sheet-root and
    owns the new Life view sub-navigation (Character Sheet ⇄ Timeline). Reads the Life Ledger
    runtime store, Learning Plan repository, and Capability profile ONCE per render; never
    writes to any of them. <progress> element for bounded plan progress; semantic headings;
    no color-only status; factual copy only — no scores, no advice, no red/yellow/green.)
  - life-character-sheet-model.test.js (new — 32 model tests: focus today/7-day counts &
    minutes, midnight/timezone/DST, learning active-plan selection + progress + next step,
    workout unknown-duration vs zero, meal date-only prep, capability explicit-evidence-only,
    coverage chaos A–F, Feed/Learning/Capability parity, revision & tombstone truth,
    order-independence, read-only, performance.)
  - tests/life-character-sheet-ui.spec.js (new — 10 Playwright tests: default-to-sheet, honest
    empty state with no faked zeros, real focus/learning render with bounded progress bar,
    imported-Workout "not updating automatically" coverage line, capability mirror,
    sub-nav keyboard operability, no-coaching-language scan, byte-level read-only proof,
    hostile-HTML escaping, aria-live.)
  - ZERO vs UNKNOWN: `liveIngestedTypes` (default focus_session_completed + plan_step_completed)
    controls when a domain may state a literal 0. Focus/Learning report a truthful 0 when live
    and empty; Workout/Meal/activity_logged report "Not connected to the Life Ledger yet" (or
    "loaded from an import · not updating automatically" when snapshot events exist) — an
    absent adapter is never rendered as behavioural zero.
changed:
  - index.html (#view-life restructured: adds .life-subnav with Character Sheet / Timeline
    buttons, #life-character-sheet-root mount, #life-feed-root now starts hidden. showView('life')
    now calls window.renderLifeView() (falls back to renderLifeFeed). New module <script> include.
    No 8th bottom-nav button — still 7 items.)
  - life-feed-ui.js (now resolves a reference timezone the same way the Character Sheet does —
    an explicit 'UTC' setting maps to 'Etc/UTC' — and passes it to buildLifeFeed so the two Life
    surfaces bucket "today" identically for the same events. No change to the feed model.)
  - style.css (appended .life-subnav + .lcs-* block — committed dark theme, matches existing
    tokens; <progress> styled for the plan bar.)
  - package.json (test script runs life-character-sheet-model.test.js; new
    test:life-character-sheet script; lint covers the two new modules.)
  - eslint.config.js (registers life-character-sheet-model.js + life-character-sheet-ui.js.)
  - tests/life-feed-ui.spec.js (openLife() now selects the Timeline sub-tab, since the Life
    view opens on the Character Sheet.)
verification: npm test (219 model/unit incl. 32 new), test:adapter-contracts, strict
  test:cross-repo-compat (no SKIPs, exit 0), lint (0 errors), Playwright 195 (life-character-sheet
  10 + life-feed 9 + smoke/learning-plan/career/plan), node --check, git diff --check,
  UTF-8/control-byte scan — all pass. Original main untouched.

## Phase 6 — Unified Life Feed V1: targeted review fixes (branch: feat/unified-life-feed-v1) — 2026-09-01
changed:
  - life-feed-model.js (BLOCKER 1 — revision/tombstone-aware raw dedupe. `buildLifeFeed` now
    resolves duplicate raw records that share an eventId into ONE deterministic current record
    BEFORE any display or tombstone decision, via `resolveCurrentRecords()`: highest valid
    `revision` wins regardless of input array order; records tied at the top revision must be
    equivalent (exact-duplicate case) or the event is reported as a `revision_conflict` skip;
    the winner then passes through the normal readable-guard + tombstone-exclusion checks, so a
    newer tombstoned revision correctly supersedes an older active one. Replaces the previous
    first-seen `seenEventIds` guard, which let output depend on array order and let a discarded
    tombstone fail to supersede an older active revision. No Ledger-store redesign; no mutation
    of input; comparison scoped to feed-relevant facts via a small `stableSerialize`.)
  - life-feed-ui.js (BLOCKER 2 — honest empty state: "Nothing here yet. Finish a learning step
    or a focus session and it shows up on your timeline." — no longer implies time logging /
    workouts / meals populate the feed today. BLOCKER 3 — reason-neutral skipped footnote:
    "N Ledger events could not be displayed." replaces "... not shown (unrecognized type)".
    The model still preserves detailed `reason` codes.)
  - index.html (BLOCKER 2 — honest Life tab subtitle: "Your timeline from the Life Ledger.
    Learning steps and focus sessions appear now; time, workouts and meals join as their
    integrations are connected.")
  - life-feed-model.test.js (+6 tests: rev1/rev2 order-independence with byte-equal output,
    newer-tombstone-supersedes-older-active in either order, older-active-never-wins,
    same-revision contradiction → conflict skip, no input mutation, per-skip reason codes)
  - tests/life-feed-ui.spec.js (empty-state test rewritten to assert honesty + absence of
    over-promised domains; new subtitle-honesty test; note explaining the skipped footnote is
    defensive-only and unreachable through the runtime store)
verification: npm test, test:adapter-contracts, strict test:cross-repo-compat (no SKIPs,
  exit 0), lint (0 errors), Playwright (life-feed 9, smoke + learning-plan 141, career + plan
  35), node --check, git diff --check, UTF-8/control-byte scan — all pass.

## Phase 6 — Unified Life Feed V1 (branch: feat/unified-life-feed-v1) — 2026-09-01
added:
  - life-feed-model.js (new — the canonical, UI-independent Unified Life Feed projection. Pure
    read over stored Life Ledger events: `buildLifeFeed(events, {now, referenceTimeZone})` →
    `{ items, days, counts, skipped, isEmpty }`, plus `filterLifeFeed(feed, domain)` and the
    exported `compareFeedItems` comparator. Domain mapping: activity_logged/focus_session_completed
    → Time, plan_step_completed → Learning, workout_completed → Workout,
    meal_prepared/meal_consumed → Meal. Ordering mirrors obsidian-life-ledger-renderer.js's
    sortEvents() exactly — occurredAt (instant) / occurredDate (date-only, a lexicographic prefix
    that sorts before the same day's timed events) as the primary key, recordedAt as a tiebreak
    ONLY when a date-only event is involved, then type + eventId. Never fabricates a time for a
    date-only meal_prepared, never assumes a weight unit, omits unknown durations rather than
    printing "unknown". Tombstoned events excluded; unsupported/unreadable events collected into
    `skipped[]` (never thrown, never reinterpreted). Intl.DateTimeFormat instances are cached per
    zone so a multi-thousand-event history builds in well under a second.)
  - life-feed-model.test.js (new — 30 tests: domain mapping, instant ordering, date-only handling,
    deterministic ties, tombstone exclusion, revision/current-fact, unknown duration, unknown
    workout unit, missing optional fields, unicode/HTML-like/long titles, unknown-event policy,
    Today/Yesterday grouping, filtering, empty feed, no-input-mutation, temporal chaos (midnight,
    multi-timezone, recordedAt≠occurredAt, DST boundary, equal start/end), the mixed-life chaos
    day, a 3000-event performance check, and Obsidian fact-parity.)
  - life-feed-ui.js (new — the Life tab renderer. Reads the runtime Life Ledger store once, builds
    the feed with a cheap event-signature cache, renders date-grouped scannable rows with domain
    filter chips + counts, domain-aware empty states, and an "N events not shown" footnote for
    unrecognized types. role="tablist" filters, aria-selected state, keyboard-operable chips,
    aria-live feed region, domain conveyed by text label + left border (not colour alone).
    Strictly read-only w.r.t. the Life Ledger, Meal, and Workout.)
  - tests/life-feed-ui.spec.js (new — 8 Playwright tests: empty state, mixed-life day render + order
    + domains through the product, filter subsetting + aria state, zero-match domain empty message,
    tombstone exclusion, hostile-HTML-is-text, read-only ledger after view/filter, keyboard filters.)
  - index.html (new `#nav-life` bottom-nav button + `#view-life` container with `#life-feed-root`;
    `showView('life')` calls `window.renderLifeFeed()`; `life-feed-ui.js` module script include)
  - style.css (appended `.life-feed-*` block — mobile-first compact rows, sticky day headers,
    filter chips, focus-visible outlines, per-domain left-border accents)
  - eslint.config.js / package.json (new module files added to lint + module-config lists; new
    `test:life-feed` script; `life-feed-model.test.js` added to `npm test`)
  - CODEMAP.md (new life-feed-model.js / life-feed-ui.js stubs + "HTML — Unified Life Feed View")
verification:
  - npm test — all suites pass (test.js 448, node:test groups incl. life-feed-model 30/30)
  - npm run test:adapter-contracts — pass
  - npm run test:cross-repo-compat (STRICT, MEAL_REPO_PATH + OPENGYM_REPO_PATH set) — all legs
    executed and passed, no SKIPs
  - npm run lint — 0 errors (pre-existing warnings only)
  - npx playwright test — smoke 64, learning-plan/career 85, plan 27, life-feed 8 — all pass
  - node --check on all new/changed JS + eslint.config.js; git diff --check clean;
    UTF-8/no-BOM/zero-control-byte scan clean on all changed files
notes:
  - The live app currently only writes plan_step_completed / focus_session_completed into the
    runtime Life Ledger (via learning-plan-ui.js). activity_logged / workout_completed /
    meal_prepared / meal_consumed have adapters + contracts but are not yet wired into the
    ChronaSense runtime store — that wiring is source-adapter integration work, out of Phase 6
    scope. The feed model + tests fully support and exercise all six types today.


## Workout → Life Ledger Adapter V1 — third targeted fix pass (branch: feat/workout-life-ledger-adapter-v1) — 2026-08-31
changed:
  - obsidian-life-ledger-renderer.js (the previous pass's renderer/core "field-for-field mirror" claim
    was incomplete: it did not cover the `startedAt`/`endedAt`/`durationMinutes` time-and-interval
    contract at all, so the renderer still accepted and rendered a workout_completed event with a
    missing `startedAt`/`endedAt`, `durationMinutes: 0`, an end before its start, or an `endedAt` that
    disagreed with the top-level `occurredAt` — all cases the shared core already rejected. Added an
    independent time-facts guard mirroring `life-ledger-core.js`'s `PAYLOAD_RULES.workout_completed`
    time/duration contract exactly (required valid ISO instants, positive-duration-or-omitted-with-
    zero-interval, occurredAt/endedAt agreement), and removed the `event.payload?.startedAt ||
    event.occurredAt` silent fallback from the rendered line — a missing/invalid workout timestamp now
    fails validation before any Markdown is generated, instead of rendering a fabricated time)
  - workout-life-ledger-adapter.js (fixed a genuine correctness defect, not merely a theoretical one:
    a 32-bit FNV-1a fingerprint collision — reproduced end-to-end through this adapter's own
    normalization pipeline — could cause a changed same-ID workout's `note` to be silently treated as
    an idempotent unchanged retry instead of an `immutable_workout_conflict`, discarding the incoming
    change without any conflict signal. Both places in the adapter that compare "is this the same
    workout" — the within-batch duplicate/conflict grouping in `normalizeWorkoutBackup()`, and the
    against-existing-stored-record check in `importWorkoutBackup()` — now compare the actual canonical
    factual serialization (`serializeLifeLedgerFacts()`) directly rather than trusting fingerprint
    equality as sufficient proof. The shared fingerprint algorithm in `life-ledger-core.js` itself is
    unchanged; this is scoped entirely to the workout adapter's own conflict/duplicate comparisons.
    `life-ledger-core.js`'s generic `upsertManyLifeLedgerEvents()` duplicate-physical-input check
    still compares by fingerprint only — that generic path is out of this bounded fix's scope and is
    called out as a remaining risk, not silently left undocumented)
  - docs/LIFE_LEDGER_CONTRACT.md (corrected the "Immutable-after-first-acceptance conflict policy"
    section, which previously described the comparison as fingerprint-based; it now documents the
    canonical-factual-content comparison and explicitly notes the fingerprint collision risk that
    motivated it. Expanded "Optional duration" to state the full time/interval contract explicitly and
    that both validators enforce it identically)
  - test.js and workout-life-ledger-adapter.test.js (expanded `WORKOUT_PARITY_FIXTURES` with 9 new
    time/interval cases — missing/invalid startedAt or endedAt, end before start, zero duration, a
    duration claimed against a zero interval, occurredAt/endedAt disagreement, and the valid
    unknown-duration case — all proven to reject/accept identically in both validators; added a
    verified real fingerprint-collision regression proving `immutable_workout_conflict` still fires,
    the original event/eventId/revision/note are preserved unchanged, no duplicate event is created,
    and a separate test confirming a true identical-facts retry still resolves to `unchanged`)
tests:
  - `npm run test:workout-adapter` — 33 passed
  - `npm test` — 471 passed (438 ChronaSense/core/export tests + 33 adapter tests)
blockers: none
deviations: same as the entries below — openGym remained read-only, deletion/restore remain
  unsupported, and no commit/push/merge/deploy/production write occurred in this fix pass either. The
  reviewer's own example note-value collision pair (`n1v5w5xb15ui35j` / `n1h9c8k30sht75r`) could not
  be reproduced against this repo's specific canonical fixture shape and was not used verbatim; an
  equivalent genuine collision (`n6vl8` / `nnpd6`, both hashing to `fnv1a32:9ce28ae5`) was found by
  direct search against this adapter's real serialization/hash output, independently re-verified
  end-to-end before being committed to the regression test, and proves the identical class of defect.

## Workout → Life Ledger Adapter V1 — second targeted fix pass (branch: feat/workout-life-ledger-adapter-v1) — 2026-08-31
changed:
  - life-ledger-core.js (the `workout_completed` payload shape validator is now a fully allowlisted
    schema, not a type-check that tolerates arbitrary extra keys: `program` and a top-level `sets`
    field are removed from the allowed payload keys and now rejected outright rather than passing
    through unchecked; `payload.source`, `exercises[]`, `exercises[].sets[]`, and
    `exercises[].prescription` each reject any key outside their documented allowlist;
    `payload.source.timezoneContext`/`weightUnitContext` reject extra nested keys, and a
    `weightUnitContext` of `{ authority: 'unknown', unit: 'lb' }` — a contradictory combination — is
    now rejected instead of silently accepted; `recordOrigin` and `completionBasis` are now enum-locked
    to the exact values the adapter produces instead of accepting any non-empty string, so an
    overclaiming value such as `definitely_native` or `cryptographically_verified` is rejected.
    Scoped entirely to `event.type === 'workout_completed'`; no other event type's validation changed)
  - obsidian-life-ledger-renderer.js (the renderer's independent workout_completed payload guard is
    now a field-for-field, allowlist-for-allowlist mirror of the core validator above — closing a
    semantic-drift gap where the renderer previously accepted payloads the core rejected: missing
    `exerciseId`, missing/invalid `mode` paired with an unchecked `sets` array, an empty `sets` array,
    out-of-range `rir`/`rpe`, an entirely unvalidated `prescription` object, and a `bodyWeight` with
    extra fields. `test.js`'s `WORKOUT_PARITY_FIXTURES` matrix now runs every fixture against both
    validators and asserts they agree, acting as an ongoing drift guard between the two independent
    copies)
  - workout-life-ledger-adapter.js (a fatal batch/context rejection — missing observation clock,
    invalid timezone/weight-unit assertion — now returns one `invalid` outcome per physical input
    record, once the physical record count is known from a confirmed `backup.workouts` array, instead
    of an empty `outcomes: []` that understated what was actually in the batch. A backup that isn't a
    well-formed object, or whose `.workouts` isn't an array, still returns `outcomes: []` since no
    coherent physical record set exists to enumerate in that case)
  - docs/LIFE_LEDGER_CONTRACT.md (documented the exact allowlisted `workout_completed` payload shape —
    per-mode set fields, prescription fields, the full `payload.source` enum/shape table — and the
    complete top-level `importWorkoutBackup()` status matrix, including fatal-context outcome
    accounting)
  - test.js and workout-life-ledger-adapter.test.js (added the shared core/renderer parity matrix and
    regression coverage for every case above, plus fatal-context outcome proofs for 3-record and
    0-record batches and re-confirmed all previously approved source-authority behaviors)
tests:
  - `npm run test:workout-adapter` — 30 passed
  - `npm test` — 468 passed (438 ChronaSense/core/export tests + 30 adapter tests)
  - `npx playwright test` — 176 passed
  - `node --check` on the adapter, adapter tests, core, runtime, transport, renderer, CLI export
    script, and `test.js` — passed
  - `git diff --check` — passed
  - control-byte/UTF-8 round-trip scan over every changed file — passed
  - ESLint — 0 errors; 19 pre-existing warnings outside the adapter/core/renderer
blockers: none
deviations: same as the entry below — openGym remained read-only, deletion/restore remain
  unsupported, and no commit/push/merge/deploy/production write occurred in this fix pass either.

## Workout → Life Ledger Adapter V1 — final consolidated fix pass (branch: feat/workout-life-ledger-adapter-v1) — 2026-08-31
changed:
  - workout-life-ledger-adapter.js (new deterministic openGym backup normalization/import boundary;
    first-valid immutable acceptance; explicit same-ID conflicts; stable ID mapping; source-compatible
    native/CSV fixtures; unknown duration; asserted timezone/optional weight-unit context; strength,
    timed, cardio, bw, topW, rating, note, PR, and prescription facts; record-level partial results;
    no inferred deletion or restore. Fix pass: bounded/control-character-safe text and identifier
    validation (workout/exercise name, exercise/routine/PR IDs, progression rule, note); malformed
    exercise-name values are now rejected instead of silently dropped; an explicit per-physical-record
    outcome — `accepted` / `duplicate` / `conflict` / `invalid` / `failed` — for every backup row, so
    identical duplicate rows are never silently collapsed without a trace; top-level `importWorkoutBackup()`
    `status` now also reflects individual ledger-upsert rejections, not only normalization/conflict
    counts; `iw`-prefixed records are now labeled `csv_import_path_compatible` with
    `confidence.basis: 'validated-supplied-backup-record'` instead of the overclaiming
    `csv_imported_history` / `validated-imported-history-record` labels)
  - life-ledger-core.js (allows `workout_completed` to omit duration only for equal start/end instants;
    removed the rejected generic source-snapshot watermark behavior. Fix pass: added a `workout_completed`-
    only deep payload shape validator — reachable through `validateLifeLedgerEvent`/`validateLifeLedgerEventDraft`
    for any caller, not only the adapter — so a hand-built or corrupted event with a wrong-typed
    `workoutName`/`exercises`/`bodyWeight`/`rating`/`note`/nested set no longer passes shared validation.
    Scoped to `event.type === 'workout_completed'` only; no other event type's validation changed)
  - obsidian-life-ledger-renderer.js (deterministic compact Workout section for mixed Ledger exports.
    Fix pass: added a self-contained `workout_completed` payload guard — mirroring the core validator's
    checks without importing it, keeping the renderer dependency-free — so a malformed workout event
    handed to the renderer directly throws an explicit error instead of producing a plausible-looking
    fabricated line such as `Workout **[object Object]** · 0 exercises`)
  - workout-life-ledger-adapter.test.js and test.js (source-compatible, adversarial, core-contract,
    mixed-renderer, hostile-input, retry, conflict, and fail-closed coverage, plus fix-pass regression
    coverage: malformed-payload rejection at the shared-validation and renderer layers, oversized/control-
    character text and identifier rejection, per-record duplicate/conflict outcome classification with
    reversed input order, forced ledger-upsert-rejection status proof, and a forged `iw`-prefixed record)
  - package.json and eslint.config.js (included the adapter in focused/full test and lint tooling)
  - CODEMAP.md (documented the adapter authority model and renderer support)
  - docs/LIFE_LEDGER_CONTRACT.md (rewrote the `workout_completed` section to document the actual
    reviewed V1 contract: stable source-owned identity, optional duration, the adapter-enforced
    immutable-after-first-acceptance conflict policy as a documented exception to the general revision
    rule, no `_ts` causal versioning, unit/timezone/observation-time assertion semantics, `payload.source`
    field meanings, `iw`-prefix provenance uncertainty, unsupported deletion/restore, and per-record
    malformed-input outcomes)
tests:
  - `npm run test:workout-adapter` — 27 passed
  - `npm test` — 464 passed (437 ChronaSense/core/export tests + 27 adapter tests)
  - `npx playwright test` — 176 passed
  - `node --check` on the adapter, adapter tests, core, runtime, transport, renderer, CLI export
    script, and `test.js` — passed
  - `git diff --check` — passed
  - ESLint — 0 errors; 19 pre-existing warnings outside the adapter/core/renderer
blockers: none
deviations: openGym remained read-only. Its backup supplies stable workout IDs, but no durable
  per-workout version or historical unit; global `_ts` and current `unit` are therefore not authority.
  Backup JSON cannot prove whether a structurally valid record was native, restored, or injected, so
  provenance says supplied backup plus validation rather than claiming native origin. Deletion/restore
  remain unsupported. No TASKS/status workflow file was changed because this was the user-directed
  Goal Mode milestone. No commit, push, merge, deploy, production/Firebase/Obsidian write, Meal change,
  openGym mutation, or real user-data import was performed.

## Capability/Career V1 reviewer fix packet — ready (branch: feat/capability-career-v1) — 2026-08-31
changed:
  - capability-career-analytics.js (filters current evidence to exclude future timestamps and
    unavailable/tombstoned Life Ledger references; treats active targets with no linked active
    skills as setup; prevents archived/paused project portfolio stalls and project next actions)
  - capability-career-model.js (repository/hydration validation now enforces the same string caps as
    constructors for names, titles, summaries, notes, references, and evidence fields)
  - capability-career-ui.js and capability-career.css (Life Ledger picker only offers live events,
    dashboard shows held-aside historical evidence, analytics receives full Ledger availability, and
    actionable projects can be explicitly marked portfolio-ready)
  - test.js and tests/capability-career-ui.spec.js (regressions for archived/paused projects,
    target-skill mapping, future evidence boundaries, Ledger tombstone/restore, portfolio-ready UI
    resolution, and oversized durable strings)
tests:
  - `npm test` — 424 passed, 0 failed
  - `npx playwright test tests/capability-career-ui.spec.js` — 8 passed
  - `npx playwright test tests/learning-plan-ui.spec.js` — 77 passed
  - `npm run test:smoke` — 176 passed
  - `npm run lint` — 0 errors; 19 pre-existing warnings outside Career files
  - `node --check capability-career-model.js capability-career-repository.js capability-career-import.js capability-career-analytics.js capability-career-ui.js test.js tests/capability-career-ui.spec.js` — passed
  - `git diff --check` — passed; only existing LF/CRLF normalization warnings on touched files
blockers: none
deviations: no TASKS.md status was changed because this was a bounded reviewer fix packet, not an
  active TASKS.md Codex task; no commit, push, merge, deploy, Firebase write, Obsidian write, or
  external data access was performed.

## Capability/Career V1 — milestone ready (branch: feat/capability-career-v1) — 2026-08-31
changed:
  - capability-career-model.js (new local profile schema, constructors, validation, archival, and
    mutation helpers for explicit skills, targets, projects, artifacts, and evidence)
  - capability-career-repository.js (new versioned localStorage repository at
    `ta3-capability-career-v1`, with read/write validation and corruption-safe errors)
  - capability-career-import.js (new strict JSON preview/import pipeline with name/title references,
    no caller-supplied durable IDs, and no partial persistence on invalid imports)
  - capability-career-analytics.js (new deterministic, non-LLM stall and next-action analysis over
    explicit evidence dimensions)
  - capability-career-ui.js and capability-career.css (new Career dashboard, progressive setup,
    import preview, Life Ledger evidence picker, project/proof/artifact flows, and mobile-safe
    styling)
  - index.html (wired the Career view, nav entry, stylesheet, module script, and render hook)
  - test.js and tests/capability-career-ui.spec.js (new model/repository/import/analytics unit
    coverage and browser workflow coverage)
  - package.json and eslint.config.js (included new Career modules in lint/test tooling)
  - CODEMAP.md, docs/ARCHITECTURE.md, docs/DECISIONS.md (documented the new Career module map,
    storage boundary, Life Ledger read-only evidence rule, and deterministic analytics rule)
tests:
  - `npm test` — 412 passed, 0 failed
  - `npm run lint` — 0 errors; 19 pre-existing warnings outside the Career files
  - `npx playwright test tests/capability-career-ui.spec.js` — 7 passed
  - `npx playwright test tests/learning-plan-ui.spec.js` — 77 passed
  - `npm run test:smoke` — 175 passed
  - `node --check capability-career-model.js capability-career-repository.js capability-career-import.js capability-career-analytics.js capability-career-ui.js` — passed
  - `git diff --check` — passed; only existing LF/CRLF normalization warnings on touched files
blockers: none
deviations: no TASKS.md status was changed because this was a bounded Goal Mode milestone, not an
  active TASKS.md Codex task; no commit, push, merge, deploy, Firebase write, or Obsidian write was
  performed.

## TASK-003 — approved, held for /merge (branch: task-003) — 2026-07-21
changed:
  - tools/Run-Codex-Build.ps1 (new `Get-TaskBlockText`/`Get-TaskDeclaredFiles` helpers; after the
    existing deny-list guard, computes changed files not declared by any tracked task and not a
    standard evidence file; writes a task-ID-tagged note to gitignored `.scope-note.txt` on
    mismatch, soft -- never blocks the build)
  - tools/Run-Claude-Review.ps1 (reads `.scope-note.txt`, uses it only if it names the task
    currently under review, always deletes it after reading; folds it into the Claude reviewer
    prompt as an explicit item to address in REVIEW.md)
  - .gitignore (added `.scope-note.txt`, same transient-handoff-file convention as
    `.last-phase-result.txt`)
tests: `[System.Management.Automation.Language.Parser]::ParseFile` on both changed files (pass);
  direct diff against Meal Prep's pre-port versions confirmed both files were functionally
  identical beforehand; fixture harness against the ported file/scope-parsing helpers, re-run
  against this app's own copy (8/8 assertions pass)
blockers: none
deviations: ported from the sibling Meal Prep app (its TASK-034/D-053), which built this first
  after comparing the shared AI Dev OS template against github.com/cathrynlavery/codex-build; no
  live end-to-end run in either app -- disclosed as unverified-live in TEST_REPORT.md
→ status set to `approved` in TASKS.md (red-zone automation surface, held for human /merge)

## TASK-002 — approved, held for /merge (branch: task-002) — 2026-07-21
changed:
  - tools/Generate-Digest.ps1 (builds the digest incrementally, stops before a safe char threshold,
    appends a "+N more" note instead of truncating the raw string)
  - tools/Dispatch-Commands.ps1 (stale-lock check now verifies the recorded PID is actually still
    running; lowered the still-running staleness wait from 2 hours to 45 min; sends a Telegram
    notice via the existing OUTBOX relay when it clears a stale lock instead of clearing silently)
tests: `[System.Management.Automation.Language.Parser]::ParseFile` on both files (pass); digest fix
  run against the real, live-failing planning/PROPOSALS.md (12 proposals) -- output 3911 chars,
  under Telegram's 4096 limit, all Approve/Park items kept; isolated 4-case fixture test of the
  stale-lock decision logic (dead PID, live+fresh, live+46min, live+44min-boundary), all pass
blockers: none
deviations: found live in the same session as TASK-001 -- a real Telegram digest-delivery failure
  ("message is too long") led to investigating why the queued TASK-001 /merge commands sat
  unprocessed, which led to discovering the hung-process/2-hour-stale-lock gap. The emergency
  DIGEST.md content regeneration already landed on main directly, ahead of this branch, since it's
  a data refresh rather than automation-surface code
→ status set to `approved` in TASKS.md (red-zone automation surface, held for human /merge)

## TASK-001 — approved, held for /merge (branch: task-001) — 2026-07-20
changed:
  - tools/Run-Codex-Build.ps1 (before auto-chaining a status:-review build into review, requires the
    build touched CHANGELOG.md or TEST_REPORT.md; blocks as a no-op with a clear note otherwise)
  - tools/Dispatch-Commands.ps1 (factored build/review classification into a shared
    Resolve-ReviewOutcome; added crashed-review-retry and no-op-retry cases; fixed a HELD-vs-APPROVED
    false-positive; added a pending-review-resume step to Invoke-Autopilot so plain /go resumes a
    stuck review; RETRYING vs NEEDS YOU summary wording)
tests: `[System.Management.Automation.Language.Parser]::ParseFile` on both files (pass); isolated
  fixture harness against Resolve-ReviewOutcome, extracted from this repo's own copy of the code (5
  cases / 9 assertions, all pass)
blockers: none
deviations: ported directly from the Meal Prep app (sibling project, sharing this exact
  tools/Dispatch-Commands.ps1 / tools/Run-Codex-Build.ps1 template) after that app found and fixed
  this bug live as its own TASK-032/D-051; full live end-to-end verification (a real crashed review,
  a real no-op retry) not attempted here either -- not safely reproducible without spawning real
  codex/claude CLI processes against a live branch
→ status set to `approved` in TASKS.md (red-zone automation surface, held for human /merge)

## [0.4.0] — 2026-04-19
### Added
- **Phone usage auto-tracking (Android)** — detects Instagram, YouTube, TikTok, Facebook, Twitter/X, Reddit, Snapchat, Pinterest, Netflix, Google Meet, Telegram, WhatsApp, Chrome and more via Android UsageStats API. Sessions logged automatically every 15 minutes.
- **Browser extension (Chrome/Edge)** — silent background tracker logs active browser tabs to your account. Supports YouTube, Reddit, LinkedIn, Notion, GitHub, Figma, Slack and more. Sign in with Google once, works for multiple users each with their own account.
- **URL scheme shortcuts** — `chronasense://start?task=X` starts the timer, `chronasense://quicklog?task=X&energy=Y` instantly logs a past block. Use with home screen launchers or Tasker.
- **PC Time auto-start** — timer starts automatically as "PC Time" when Edge/Chrome opens, so no time is lost before you set a task.
- **2-way full sync** — timer start/stop/task name, Away state, Settings, Reviews, and Weekly Plans all sync instantly across all devices via Firebase.
- **Edit buttons on entries** — pencil icon on Today timeline and Week all-entries list to edit past logs.
- **Unlogged hours card** — stacked bar below Top Activities showing unlogged time per day this week.
- **Timer block details** — shows start time, current time, and elapsed in h+m format.
- **Onboarding updated** — new steps covering phone tracking, browser extension, and URL shortcuts.

### Fixed
- Phone auto-logs skip time windows already covered by manual entries (manual always wins)
- Stop syncs correctly as full reset (not pause) across devices
- Away state syncs to other devices in real time
- Settings sync now applies all fields, not just timezone
- Reviews and weekly plans sync bidirectionally by timestamp

---

## [0.3.0] — 2026-04-09
### Added
- Pomodoro focus mode (25/5 default, adjustable work/break durations)
- Auto-logs work session on pomodoro completion
- Session dots showing completed pomodoros
- Deep work progress bar in focus mode
- Editable task input in focus mode (instead of showing today's intention)
- Current task label shown above timer when running
- Editable timeline entries — tap any entry to edit time, activity, energy

### Fixed
- Switch task button now skips "Still on" — opens form pre-filled with current task
- Focus mode "Switch task" calls correct function (no more duplicate log)
- Two timers conflicting when main timer + pomodoro both running
- End early break button broken (endBreak name collision with pomodoro)
- Untracked blocks removed — gap detection handles missed pings instead
- "YOU SAID" bar removed from ping modal (redundant with "Still on" button)
- Sync pill removed from header (always synced when signed in)

### Changed
- Week view day tabs redesigned to two-row layout with actual dates
- Elapsed time on ping modal shows actual block time, not hardcoded interval

### Renamed
- App renamed from "Time Audit" to "ChronaSense"
- New icon applied to all Android densities + splash screens

---

## [0.2.0] — 2026-04-08
### Added
- Google sign-in via Firebase Auth
- Break timer with auto-resume
- Gap detection — auto-detects unlogged time between entries
- Retro log (Past block) — log anything with custom start/end time
- Away stamper — mark gaps as Sleep, Commute, Break, Offline
- Recent activity chips in log modal
- Quick log redesigned as bottom sheet with chips and energy grid
- Activity colors — 32 curated palette + HSL golden-angle overflow
- Timeline bucketed in 30-min windows, expandable to micro detail
- Week view redesign — day detail, month view, energy split, top activities
- "YOU SAID" context bar in ping modal showing committed task
- Switch task mid-block — logs current, opens pre-commit for new task
- Capacitor Android setup with local notifications for background pings
- Settings tab black space fixed

---

## [0.1.0] — 2026-04-06
### Initial version
- Ping timer with adjustable interval (default 30 min)
- Log modal — activity, energy type, on-plan flag
- Firebase Realtime Database for persistence
- Today's timeline view
- Basic week view
- Settings tab
- Daily review — win, waste, tomorrow's focus
- Live cost tracker ($x drifting)

## Date-scoped ChronaSense Life Ledger read V1 — ready for review — 2026-09-07

- Added `readChronaSenseLifeLedgerForDate()` to the existing adapter. It validates the
  query date, delegates source selection to the injected existing date reader, and calls
  `normalizeChronaSenseEntries()` unchanged.
- Returns contract-valid drafts and existing rejection outcomes without creating durable
  event IDs or accessing a Ledger store, localStorage, Firebase, or Obsidian.
- Added 15 regression tests and included them in `npm test`; API usage and precise date,
  observation-context, error, and transport boundaries are documented in `CODEMAP.md`.
- Base: `059a5ce204a12ff1c425e635f491b677fd706f5c`; branch:
  `feat/date-scoped-life-ledger-export-v1`. Implementation left uncommitted for independent review.
- Scope follows the explicit user request; no unrelated TASKS status or Phase 5C machinery changed.

## Date-scoped ChronaSense export V1 — bounded review fixes — 2026-09-07

- Bound export selection and normalization to the same explicit validated `sourceTimezone`.
  `getEntriesForDate(date, { sourceTimezone })` overrides settings for that read; existing
  one-argument callers retain their behavior. Updated the required `www/storage.js` mirror.
- Missing/invalid export timezone now throws before source reading, even for empty dates;
  the existing normalizer, canonical drafts, identity, fingerprints and dedup remain unchanged.
- Added the exact Tokyo/Phoenix omitted-day regression and invalid-context cases. Replaced
  the misleading device fallback test with successful explicit-timezone export coverage.
  Added physical-split versus unsplit midnight coverage; the date suite now has 21 tests.
- Clarified source-record ownership versus clipped UI daily accounting in CODEMAP.
- Remains uncommitted for targeted re-review; no Meal/Workout or Phase 5C changes.

## Phase 6 — Daily Operating Loop V1 (branch: feat/daily-operating-loop-v1)

Added Today reusable routines, a compact editor, hybrid cues, deterministic daily identities, local persistence, manual correction, source completion matching, and calendar streak/count. Reused existing Learning and Focus; added bounded full-session hooks and local launch linkage. Updated browser/Capacitor runtime parity. Added focused model/browser tests and narrow documentation. No merge/deploy or external production writes. Execution contract: explicit user Phase 6 brief; legacy TASKS.md has no Phase 6 task and remains unchanged. Independent review required; see docs/DAILY_OPERATING_LOOP_V1.md and TEST_REPORT.md.


## Phase 6 — bounded independent-review fixes (feat/daily-operating-loop-v1)

Require strong Workout routine linkage and unique eligible facts, with agreeing
source/start dates; fail closed on unlinked or ambiguous evidence. Bind Learning
only from Next Step and retain the pin. Gate streak history on current occurrence
and enabled state. Preserve existing identity, Focus/manual/timezone/persistence
architecture. Add adversarial domain/browser regressions, update runtime mirrors,
and correct policy/friction/count documentation. See TEST_REPORT.md for green
regressions and docs/DAILY_OPERATING_LOOP_V1.md for final semantics. No push.


## Phase 6C — Guided Measurement Loop V1 (branch: feat/guided-measurement-loop-v1)

Today now leads with the next executable action and passes known task context into tracking/Focus.
Priorities and prepared empty days no longer trigger Morning Startup. Review saves independently
and links to Plan Tomorrow with draft preservation. Routine configuration is secondary; scheduled
Learning can start from Today and returns after its outcome decision. Auto-Review and sleep setup
popups are removed, sleep reminders are passive, and redundant success toasts are reduced.
Review includes unplanned tracked activity while retaining routine/priority intent matching.

Data/storage/source contracts and HUD controls are preserved. Tests and evidence are recorded in
TEST_REPORT.md. User-supplied Phase 6C contract supersedes the historical task-queue workflow;
TASKS.md is unchanged. Candidate intentionally left uncommitted/unpushed for independent review.


## Phase 6C — Bounded review fixes · 2026-09-09

Fixed the two independent-review blockers only: Review appends unplanned activity once after
the planned rows, and install eligibility is deferred/suppressed during auth, recovery,
execution and onboarding. The install gate also hides an already-visible banner and retains
the browser event for later use. Existing installation and iOS help remain supported.
Direct browser regressions cover uniqueness, outcome denominators, data preservation, real
install events, timer/Focus recovery, first-visit onboarding and deferred availability.
The approved architecture and low-severity visual hierarchy remain unchanged. No commit/push.


## Phase 6D — Today Surface Simplification V1 (uncommitted review candidate)

- Consolidated Today around Up Next, compact commitments, conditional Needs You, and So Far.
- Kept the Phase 6C action precedence and existing execution controls. Routine action discovery
  now uses model state and a shared identity-checked handler instead of rendered card buttons.
- Moved logging, timeline/corrections, wallet, and accountability behind intentional access.
- Respected Review's date-scoped unknown-time acknowledgement, including immediate attention
  refresh after Review save and configured sleep resolution.
- Preserved models, repositories, sync, Focus internals, and primary navigation; mirrored runtime files.
- Validation and A–AS milestone handoff: see the Phase 6D entry in TEST_REPORT.md.
- No TASKS.md status changed: this milestone was directly authorized by the user, outside the
  historical completed task queue. No commit, push, merge, deployment, or independent review performed.

## Phase 6D.1 - Today action visibility polish (uncommitted candidate)
changed:
  - style.css and www/style.css: Today-scoped primary, neutral secondary, and underlined tertiary treatments; hover, pressed, focus-visible and disabled states. No layout or application logic changes.
  - tests/today-simplification.spec.js: Phase 6D height-preservation baseline and idle/missing-time/focus-ring screenshots.
tests: 97 focused browser tests passed; runtime mirror and static checks passed.
blockers: none
deviations: explicit user brief is the contract; TASKS.md left unchanged. No commit or push.


## Phase 6E — Review Simplification V1 (branch: feat/review-simplification-v1)
changed:
  - index.html: compact factual summary, independent feeling/win, optional legacy fields,
    separate full analysis, bounded gap-editor return, explicit historical planning destination,
    no-save Close and primary Save reflection; remove active Reality Score and waste prefill.
  - insights.js: retain automatic attention analysis/caveat; move feeling into Review itself.
  - style.css: scoped compact Review disclosures, wrapping, 16px fields and reachable Save.
  - www/index.html, www/insights.js, www/style.css: generated runtime mirrors.
  - tests/review-simplification.spec.js: data, detour, sync, offline, chaos and responsive coverage.
  - tests/guided-measurement-loop.spec.js, tests/plan.spec.js, tests/plan-tomorrow-ui.spec.js:
    adapt presentation assertions to the intentional new labels/disclosures.
  - CODEMAP.md: describe Review entry points and bounded return behavior.
verification: see the Phase 6E entry in TEST_REPORT.md.
blockers: none.
deviations: direct user-approved Phase 6E request is the execution contract; no unrelated
TASKS.md status changed. Historical planning date semantics deliberately remain unchanged.
Candidate remains uncommitted and unpushed for one independent milestone review.


## Phase 6E — bounded keyboard focus rework
- Confirmed feeling activation removed the focused button by rebuilding its group.
- `setReviewFocusRating` now updates existing button pressed states and existing classes
  in place; `renderReviewFeeling` supplies stable button values. No styling, wording,
  layout, persistence, analytics, or other product semantics changed.
- Generated only the corresponding `www/index.html` mirror update.
- Added three actual keyboard selection/clear/Tab cases and historical mouse save/restore
  coverage. Review suite: 36 passed; directly relevant Review regressions: 14 passed.
- Candidate remains uncommitted and unpushed for targeted re-review.

## Evidence contract V1 - candidate (feat/evidence-contract-v1)
changed:
  - Added contracts/CHRONASENSE_EVIDENCE_CONTRACT_V1.md as canonical semantic authority, with CODEMAP and Ledger confidence pointers.
  - currentEvidenceScope() excludes explicit scheduled_template Ledger assumptions from current capability proof; source/profile records remain intact.
  - Mirrored the two-line production guard in www/capability-career-analytics.js.
tests: two regression cases in test.js (three provenance variants and three positive capture variants); full npm test passes.
limits: no universal runtime fitness gate; Focus detection/repair and other documented deviations remain deferred. Existing capability outputs can change for schedule-backed mappings, with no new UI or user burden.
status: uncommitted candidate for independent review; TASKS.md unchanged because this is a direct user milestone, not a queued task.

## Evidence contract V1 - bounded notice review fix
changed:
  - renderExcludedEvidenceNotice() counts explicit unavailable/tombstoned reasons separately from schedule assumptions on the existing notice surface; runtime mirror updated.
  - Added six rendered-browser regression cases for zero, single/multiple schedule, unavailable, tombstoned and mixed exclusions.
unchanged: currentEvidenceScope(), evidence filtering, source/Ledger records and all later truth-fix milestones.
status: uncommitted and unpushed; required Medium finding addressed, pending targeted re-review.
deferred Low findings: explicit unloggedOk missingness wording; accounting boundaries versus sleep/wake/planning boundaries.
