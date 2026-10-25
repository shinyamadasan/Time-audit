# TASK-025 — Entry validation reliability PASS / LOCAL REVIEW

Owner-direct, 2026-10-24 America/Phoenix. Isolated branch `task-025`, based on
GitHub main `e7d8b87bb0059b1c08351a9f9dc24bc5adebb9b8`, verified at startup.
This is a separate local investigation after TASK-024. Earlier candidates and evidence
are preserved. No production entries were read by the agent.

## Confirmed causes

`autoTemplateEntryId()` and `autoLogDueTemplates()` intentionally persist deterministic
`tpllog_<sanitized-template-key>_<YYYY-MM-DD>` IDs. The numeric-only check in
`validateEntry()` incorrectly diagnosed these entries, including a synthetic 600-minute
scheduled auto-log produced by the actual source function. Editing historical entries
retains their ID even if the date, template or marker fields later change.

The owner's redacted summary reports 2,143 active entries, 50 failing the old numeric-only
ID predicate and four failing its duration predicate. Its sampled string ID is `tpllog_*`
with matching 600-minute timestamps. This confirms the sampled false positive, not that
all 50 strings have been inspected. Its sampled numeric-ID record has `blockIntervalMin: 0`
and 0.09 elapsed minutes (5.4 seconds), without retro/auto-log/scheduled/away markers.
That is a real rounded-zero stored duration, not evidence of an invented negative interval.
The summary cannot conclusively identify its producer or the other three duration records.

The actual `endBreak()` function reproduces that 5.4-second shape: it rounds elapsed minutes
to zero and stores the record without an immediate validation call. Account loading later
reports it. The actual `quickRetroLog()` also reproduces a distinct zero case: 23:00 to
00:00 splits into a 60-minute fragment and an empty next-day fragment. `saveRetroEntry()`
uses the same midnight split; rounded positive sub-30-second fragments can also be zero.
These are confirmed producer capabilities, not attribution of the owner's historical rows.

Producer trace also covers ordinary stop/switch/automatic/focus logs (rounded-duration guards),
common logs/repeat/away/task switches (minimum-one clamps already present), normal manual
save (configured interval), crash recovery (existing fallback), sleep (positive interval,
rounded minutes), scheduled templates (rounded configured slot), browser extension (60-second
minimum) and phone usage (120-second minimum). Display-only `tpl_*` hints and merged/clipped
display copies are not persisted scheduled-entry ID forms. Undo/restore retain original IDs.
No producer, minimum-duration policy, display helper or historical value was changed.

## Why warnings repeat; writes

`bindAccountLocalState()` validates each active entry on account binding, so reloads and A→B→A
repeat genuine diagnostics. The Firebase entry listener validates additions/replacements.
Equal-version rows converge through `resolveEntrySync()` without repeated validation; newer
malformed versions are diagnosed again. Duplicate aliases converge to one entry.

One malformed-history edge is independently reproduced: a remote row missing both a truthy
`ts` and `updatedAt` receives the existing current-time version fallback on each later event.
Three unchanged snapshots then yield three warnings. The callback still performs zero Firebase
entry writes. Changing this conflict-resolution policy would exceed the narrow correction.

`validateEntry()` neither mutates records nor requests sync. `persist()` writes local storage.
Explicit `syncEntries()` publishes the existing full entry map; its equal-version echo does
not trigger another sync. Startup and the existing reconnect logic may independently publish
the full map; that behavior is unchanged. Entry changes can also trigger the existing shared
accountability projection, which has a content-signature write guard; those are not entry-map
writes. No warning-driven or entry callback-feedback write loop was found. The real-page fixture
counts entry writes after startup: 20 repeated snapshots
and 125 seconds of idle reconciliation add zero writes and zero extra diagnostics.
This controlled observation is not a production network capture.

## Minimal correction

`storage.js` accepts finite positive numeric IDs and the existing anchored, sanitized
`tpllog_*_YYYY-MM-DD` grammar. Whitespace, arbitrary strings, display-hint IDs, invalid numeric
IDs and other malformed fields still warn. The finite-number check also rejects NaN/Infinity,
which the old numeric predicate accidentally accepted. No flags/current-template/date alignment
is required, preserving legitimate edited history.

The zero-minute warning remains active. Fabricating one minute, dropping records, silently
normalizing history or relaxing duration validation would violate the owner's constraints.
Changing sub-minute accounting or suppressing empty split fragments needs a separately scoped
data-integrity decision and is not bundled into this correction.

Other changes are new source-based Node and isolated browser regressions, npm wiring and the
governed runtime generation `20261024-task025-entry-validation-v1` with its expected-token tests
and generated `www/` mirror. There are no entry schema, sync protocol, Firebase rules or nudge
implementation changes. All production-rule artifacts remain identical to the merged base.

## Verification

| Check | Result |
|---|---|
| Pre-fix actual-source regressions, corrected fixture | 17 pass / 5 fail; retained expected regression failures |
| Same entry suite after correction | 22/22 pass |
| Focused entry/wiring/runtime-generation Node suites | 42/42 pass |
| Real-page mocked Firebase load/reload/account/idle regression | 1/1 pass |
| `npm test` | 2,297 Node passes, zero failures, one existing opt-in skip across 2,298 cases; legacy 455/455 |
| `npm run lint` | exit 0; zero errors, 48 pre-existing warnings |
| Generated rules / runtime mirror | pass; builder matches; 95 files byte-identical |
| Full browser QA, four workers | exit 0; 972 expected outcomes: 965 ordinary passes and seven existing annotated expected failures; zero unexpected failures |
| Exact scope / whitespace / introduced-secret scan | pass; 710 untouched base files preserved; exactly 13 intended paths |

No Firebase fence rerun is necessary for unchanged rules, builder, fence tests, nudge listener
and authorization paths; retained TASK-024 evidence is 157/157, not a fresh TASK-025 result.
Coverage was not measured. No hosted CI, production acceptance, native-device or Android build
was run. Existing seven annotated F-1–F-7 defects are not repaired by this task.

Initial Node spawn was blocked by the sandbox before assertions; authorized subprocess execution
then ran the suite. An initial test fixture lacked break timer globals; its raw result is retained,
and the corrected pre-fix run establishes the meaningful 17/5 baseline. The first browser fixture
expected the wrong order for the existing chronological sort; only fixture order was corrected,
with exact record equality assertions preserved. No application failure was hidden or counted as
passing. A patch-tool interpolation error occurred before mutation. Private raw logs/receipts
retain all these attempts.

Self-review Code Health passes: no new runtime state/helper, duplicate behavior, unrelated refactor,
new warning or dead code. Applicable AI QA traces preserve heartbeat/exit/device guards, display
copy semantics, restore order, schema and conflict resolution by exact base comparison. No handler,
input, style or UI structure changed. CODEMAP needs no structural update. Protected documentation
and historical task records remain unchanged; current owner-direct contract takes precedence over
generic QA requests to edit protected planning/status files. No commit or live Git pull is claimed.

Independent reviewer `/root/nudge_review` inspected the actual source, tests and causes and reported
implementation PASS with no must-fix. For its final exact-candidate verdict/binding, consult the
separate private `INDEPENDENT_ASSESSMENT.md`; this handoff does not replace that assessment.
The private packet is at `release-verification/task-025/` in the original workspace. It must not
be staged. `candidate-manifest.json` binds the retained uncommitted candidate's 13 files and base;
`scope-audit.json` records its SHA-256. TASK-025 is `review`, never approved/done.

## Remaining limits and release hold

This local correction removes the demonstrated scheduled-ID false positive. Genuine zero-minute
history continues to warn when validated, as does malformed timestamp history. Their accounting
policy and any historical cleanup remain unresolved and outside this correction. No claim is made
that all production warnings disappear or that every historical row has been classified.

No production data access/change/cleanup, push, PR, merge, Pages/Firebase deployment, auth/IAM or
AI Dev OS operation occurred. Publication/integration/deployment and production acceptance require
separate owner authority. A future code rollback should reverse only this validator/generation
delta from then-current main while preserving later changes and runtime parity; it needs no data
or rules rollback. Stop at the local independently reviewed candidate.
