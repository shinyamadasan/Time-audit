# TASK-039 — integrated time acknowledgement lifecycle (acknowledged Undo)

**LOCAL integration candidate. Not pushed, merged or deployed. Guardian NOT RUN / NOT PASSED. Production NO-GO.**

Base: proof checkpoint `5e665bd6b6526b8121f3eb682d36692ed7b40fac` (branch `task-039-time-ack-integration`).
Runtime-final commit: `e058383`; this record is committed on top of it with no runtime change.

## Owner decisions (October 28 2026 session)
- Policy: Undo starts only while connected. While an Undo is PENDING/UNKNOWN, deliberate accounting commands are refused before local mutation; the timer keeps running; the operation survives reloads, reconciles automatically and is never discarded; Retry / Keep original only while the server still shows the before-state.
- Canonical `firebase.rules.json` unchanged. The gated entry+timer variant is proven in the emulator only.
- Lifecycle covers Undo only. Claude implemented; independent subagent reviewed the exact source.

## What changed
- `time-ack.js` (new classic script): an account-scoped durable record `ta3-time-ack:<room>` that is read back before any send. Phases intent → pending → accepted / refused / unknown. Operations `begin` (agreement read, stage, first send, all under one Web Lock), `recover`, `retry`, `abandon` and `finalize`. `_csWrite` revision stamps carry the operation id. ID-token REST transport: authoritative per-path GETs plus one multi-path PATCH, with echo validation and a 15 s deadline (the token fetch is inside the deadline). Acceptance means a server ack echoing the whole patch, every post-image observed, or the operation's own stamp observed on any patched path (the PATCH is atomic). Abandon waits 120 s after the last attempt.
- `index.html` Undo section:
  - Signed-in `undoLastAction()` routes to `requestAcknowledgedUndo()`. The unchanged tombstone/restore helpers run on copies; they only gained a target-list parameter.
  - The timer proposal comes from `buildTimerPublication()`.
  - `applyAcknowledgedUndo()` applies once. Every affected record and the cursor must still be the captured original, or already the accepted result delivered by a listener. Only the load-derived `category`/`originalLabel` fields may appear. Anything else makes the result "superseded".
  - The rewound cursor is republished after apply.
  - Barrier `timeAckBlocks()` covers: quick Save, Stop, Switch, retro/modal save, delete, quick retro, same-as-last, common log, Away, activity cleanup, sleep log, clear day/all, both Data Doctor repairs, start break, enter/leave Focus.
  - `#time-ack-status` shows Confirming / Not confirmed with Check now / Retry Undo / Keep original. Retry is refused if the local frame has moved on.
  - Signed out (no room) keeps the old local Undo.
- `storage.js`:
  - `buildTimerPublication()` is extracted verbatim from `syncTimerState()`, with the same Date.now() order.
  - Ordinary `syncTimerState`/`syncEntries`/`syncFocusRedemptions` defer paths held by an unresolved Undo, or by one still being prepared in this tab.
  - `.info/connected` triggers reconciliation.
  - The governed release token advances to `20261028-task039-time-ack-v1`.
- Tests:
  - New: `time-ack.test.js` (emulator, wired into `test:rules-emulator`), `tests/time-ack-undo.spec.js` (real SDK + emulator), and `tests/time-ack-test-server.js`.
  - Existing Undo specs got an acknowledging stub server; their assertions are unchanged except awaiting the async apply.
  - The SDK harness loads the extracted builder.
  - The strict seven F-1..F-7 are untouched.

## Not changed
- Time arithmetic, timestamps, device/owner guards, `_stopHeartbeat` sites, the heartbeat IIFE, the timer-restore order, timeline helpers, tombstone rules.
- `firebase.rules.json`, the rules builder, `functions/`, PR20, the gateway.
- No new backend: the transport is the same RTDB, reached through its REST API.

## Verification on e058383 (America/Phoenix, local only)
| Gate | Result |
|---|---|
| `npm test` | 2392 passed, 1 existing opt-in skip, 0 failed (2393); legacy 455/455 |
| `npm run test:fence` (incl. 28 new lifecycle cases) | 205/205, 0 skipped |
| Full Playwright, 2 workers | 1035 passed, 0 failed (25.2 m) |
| Strict seven F-1..F-7 ×3 | 21/21 |
| Focused `time-ack-undo.spec.js` (real SDK) | 7/7 |
| Original eight reproductions (unchanged harness, pristine 5e665bd checkout) | 8 scenarios, 0 failed/skipped; STOP reproduced on the old flow; results byte-identical apart from EOL |
| Lint | 0 errors, 48 existing warnings (no new ones) |
| www mirror (99 files), rules builder, functions/shared, `git diff --check` | pass |

Attempts disclosed:
- On `f422f96` the full browser run had 2 failures in `daily-routines-ui.spec.js` (:233, :333). This is the known UTC-midnight clock bug: those tests ran just before 00:00 UTC. They passed 10/10 on repeat and passed on baseline. The e058383 run is clean.
- An earlier `npm test` failed in the life-ledger lock-race test while the browser suite was running concurrently; it passed 3/3 alone.
- The first `npm test` on `f422f96` failed the governed release-token test. That was fixed by e058383, the generation bump.
- Logs: `review-artifacts/task-039-time-ack-integration/logs/`.

## Independent review
A subagent reviewed `7d1ed10` (REJECT: B1 permanent barrier, S1–S5), then `0d5dc14` (M1: break/Focus start, S5′ stale cross-tab timer flush), then `f422f96` (APPROVE, no must-fix items). Every must-fix item was resolved. Accepted residuals are listed below.

## Remaining release blockers / known limits
1. **Owner decision:** if a request that never landed is followed by a change to one of its records elsewhere, the operation stays UNKNOWN. Neither its stamp nor its before-image remains. The barrier then holds indefinitely, and only "Check now" is offered. An explicit exit (for example "keep server version") needs approval.
2. The rest of the stale-write contract integration is still blocked. That covers planning stores, Action API, bulk `syncEntries`, all timer writers and the browser extension's REST entry writes becoming revision-aware. The gated rules must not deploy until it is done.
3. Residual races (reviewed and accepted):
   - The preparing hold is per tab.
   - Nothing watches retired "abandoned" operations for a request arriving more than 120 s late.
   - Automatic paths (break expiry, auto-log, crash-recovery auto-log) are not barred. Their changes make the result "superseded" rather than lose time.
   - The cross-tab flush drops the other tab's deferred timer sync until its next natural sync.
4. Hosted exact-head/base CI, Guardian, live writer inventory, rollout fence/canaries and phone testing are all NOT RUN.
