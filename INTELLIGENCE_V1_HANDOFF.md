# ChronaSense Intelligence V1 — STRICT review handoff

BASE_SHA: 2a4863d3781f5fac45ab7bf3c4f98ff8988b237a
CANDIDATE_SHA: the committed task-006 tip, pinned by the final session handoff (`git rev-parse task-006`).
BRANCH: task-006
TASK: TASK-006, source: owner-direct, interactive/manual only, depends on integrated TASK-004.

## Authority map

| Source | Authoritative model | Existing derivation reused | Intelligence UI |
| --- | --- | --- | --- |
| Calendar / operational / legacy plans and immutable calendar activation facts | PlanAuthority targets and repositories | current, items, evidenceWindow, reviewEvidenceWindow, itemInstants, calendarCarryoverFor, staleUnfinished, recoveryConflicts | Plan vs actual; open state; source-owned unfinished recovery |
| Room-scoped Brain Dump captures | BrainDumpRepository / normalizeCapture | Explicit triage/disposition and promotion-claim state | Unresolved captures; pending promotion remains unknown |
| Room-scoped appointments | CommitmentsRepository / normalizeCommitment | Authored instant, precision, timezone, tombstone | Schedule facts; elapsed schedule with unknown outcome |
| Account-scoped interval entries | Existing entries + entryTimeRange | hasConfirmedEnergyClassification excludes schedule assumptions, passive observations and PC context | Exact-linked work; separately recorded actuals; repeated log labels |
| Account-scoped broad activity evidence | CoarseEvidenceRepository / validateCoarseEvidenceRecord | Date-scoped approximate assertion | Approximate actual, without task attribution or placement |
| Account-scoped routine definitions/assertions/Focus receipts | DailyRoutineRepository | generateInstances, matchCompletion, scheduleState; source-owned scheduler timezone | Explicit manual assertion, Focus completion, skipped/worked/unknown state |
| Current timer / Away / Break | Existing runtime state and owner guards | timerStateOwnedByCurrentAccount, awayStateOwnedByCurrentAccount, breakStateOwnedByCurrentAccount | Live factual state, never a finished interval |

## Architecture and contracts

`getIntelligenceAppContext` -> `collectIntelligenceInput` -> `buildIntelligence` -> My Day disclosure.
Two small runtime modules; no new truth store, cache, ranker, recommendation producer or LLM.
Existing Next and the mechanical Today action remain their original authorities.

- Every positive claim carries source record IDs internally; plan provenance includes the owner target ID.
- `done` means explicitly marked done. Exact linked intervals mean recorded work, never completion.
  Title equality does not establish a task link. An unresolved link stays unresolved, not absent.
- Missing actual evidence is UNKNOWN/GAP. Unresolved plan flags describe record state, not what happened.
- Active Brain Dump captures are unresolved captures, not automatically obligations. Archived/delegated/
  promoted captures are excluded; a pending claim is not promoted by the reader.
- Appointments have no completion field. This surface never calls one missed, failed, or completed.
- Same-identity equal-content copies deduplicate. Conflicting copies are excluded with an unknown note;
  no input-order winner. Malformed/unavailable inputs are omitted or abstained with coverage notes.
- All readers are synchronous local authority/cache snapshots. They neither refresh remote authority nor
  prove remote completeness. Absence never triggers writes or a negative fact.
- Account mismatch/sign-out abstains. Account rebind clears even hidden DOM before authority invalidation;
  the existing subsequent Today render recomputes. Live sessions require their own existing owner proof.

## Time semantics

Calendar today/date windows reuse getDateInTZ, tzParseTime and _dateKeyPlusDays with the account zone.
Intervals use existing entryTimeRange; plan attribution uses the target's existing evidence window,
including frozen-home-zone/calendar next-day extension. Plan date, item zone and day offset remain visible.
Routine date/soft timing comes from its source-owned scheduler timezone, never a new account day rule.
Timed appointments retain authored instants. Date-only elapsed status changes at midnight in the
appointment's authored zone, never at its noon anchor or another zone's midnight.
Patterns: independent eligible activity records with repeated normalized labels on >=3 distinct dates
in the current and six previous calendar dates. Each record is attributed exactly once via
`localPlanDate(record.startMs, accountTimezone)`; crossing midnight never creates repeated evidence. They assert neither habit consistency nor missing days.

## Verification

- `npm test`: exit 0; node:test summaries 2,011 total / 2,010 passed / 0 failed / 1 skipped;
  the legacy runner also reported 455 passed / 0 failed. New model: 40/40 passed.
- `npm run test:smoke -- --workers=2`: exit 0, 856/856 passed, 0 failed (15.9m).
  Final focused Intelligence production-browser run: 10/10 passed, including collector account mismatch.
- `npm run test:fence`: exit 0, 94/94 local RTDB emulator / real-SDK / mutation cases passed.
- `npm run lint`: exit 0, 0 errors / 47 existing warnings; none in the new modules.
- `npm run check:www-parity`: 90-file runtime closure byte-identical; no stale mirror.
- `npm run check:firebase-rules`: builder parity clean. `git diff --check`: clean.
- The existing cross-repo control proof (`CROSS_REPO_COMPAT_CONTROL_PROOF=1`, Windows/sibling-repo
  dependent) is explicitly skipped. It is not counted as passed; coverage percentage not measured.
- The earlier 3-worker full browser run had 854 passes / 1 known recurring-schedule editor failure.
  Its unchanged test passed in isolation, then the complete 2-worker gate passed all 856. No retries,
  skips, weakened expectations, or product fixes were added for that unrelated flake.

Self-review: smallest read-only derivation, no source writes, stable IDs/order/conflict handling,
account reset and source/session owner gates traced, evidence exclusions reused, Hard Rules unchanged.
QA: new DOM references and handlers resolve; no new inputs/raw colors; mobile width checked; parity,
generation and source boundary checks retained. Would I ship the bounded read surface: yes; required gates passed.
Earlier attempts exposed a closed-disclosure CSS rule, fixture clock/casing, and an obsolete browser
release-token expectation; all corrected without relaxing assertions. The first full browser attempt was
interrupted after its retired-token failure; the complete final gate is recorded above.

## Files and review hotspots

Runtime: intelligence-read-model.js, intelligence-ui.js, index.html read/mount/render bridge,
style.css scoped styles, storage.js one account-reset hook, generated www/ copies.
Tests/wiring: new model/browser suites; package.json and ESLint wiring; existing release-token
expectations updated and previous token retired. CODEMAP describes the new surface.
The mirror closure required one supporting correction: strip URL query/fragment before resolving a
physical imported filename, reusing normalizeSpec; a regression covers import/export/dynamic imports.

Review hotspots: exact entry links across frozen plan windows; ambiguity/absence semantics; date-only
appointment timezone boundary; scoped routine/Focus readers and hidden DOM clearing; release-generation
separation (Intelligence's own pinned model import; Brain Dump generation unchanged); mirror query fix.

## Known limitations

- The Life Ledger runtime cache has no account ownership proof. External workout/Learning routine
  completion is deliberately unevaluated and visibly explained; scoped manual/Focus facts still work.
- Appointments do not support completion/overdue obligation semantics or evidence linking.
- Readable local snapshots may be incomplete offline or while syncing. No negative fact follows absence.
- Pattern grouping is by normalized log label, not immutable activity taxonomy; no streak or habit claim.
- Browser checks include 390px width. Physical Android/iOS behavior, feel and production connectivity
  remain human checks; no device build or deployment occurred. Coverage percentage was not measured.
- The existing env-gated cross-repo control proof is skipped, not claimed passed.

Deployments: none. Production mutations: none. Integrations/pushes/merges: none.
Review the base..candidate range; no automatic integration is authorized.


## TASK-006 INT-001 targeted re-review (2026-10-08)

Previous reviewed tip: b5ece25e573795cc8fc6d440638d2ed9d9f396b0. No rebase or main refresh.
Only recent-pattern date attribution changes: unique eligible source records each contribute their
canonical start date, converted by the already imported localPlanDate helper in the account zone.
The normalized interval projection has start/end instants, no separate source-owned date. This matches
the existing start-date attribution in analytics (getDateInTZ(tsStart || ts)); canonical entryTimeRange
still supplies interval starts. The threshold, seven-calendar-date window and wording are unchanged.

Other Intelligence semantics: unchanged. Actuals and plan-vs-actual continue to use interval overlaps;
Attention, open loops, quarantine, account guards, PlanAuthority and all domain writes are unchanged.
Intelligence's independent model/UI cache generation is 20261008-intelligence-int001. The governed
20261007-intelligence-v1 token and Brain Dump generation remain unchanged. www/ is generated only.

Verification: focused model 46/46 (6 new INT-001 cases); focused browser 11/11 (1 new INT-001 case).
Full Playwright 857/857 passed, 0 failed (15.8m, 2 workers, no retries). npm test exit 0:
2,017 node:test cases, 2,016 passed, 0 failed, 1 existing optional cross-repo control skip;
legacy runner 455 passed. Firebase fence 94/94 passed. Lint 0 errors / 47 pre-existing warnings;
90-file mirror parity, generated rules parity and git diff --check clean. No gate weakened.
Self-review: the functional diff changes only three lines inside pattern grouping. Independent record
IDs are deduplicated before grouping; each contributes one start date. Other overlap consumers and
Intelligence sections are untouched. Cache URL changes prevent stale reviewed code; no UI redesign.
No deployment, production mutation, persistent data change, main refresh, rebase, push or merge.

Review hotspot: one record -> one pattern date, and distinct-date set cardinality requires independent
source IDs because source records are already deduplicated/conflict-excluded before pattern grouping.
