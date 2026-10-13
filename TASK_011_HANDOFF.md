# TASK-011 — Plan Authority + Conversational Scheduling V1 (review handoff)

Candidate: branch `task-011` (local only, not pushed), base `origin/main` `327e0cbd52bf3cb740cb55c1ed5d4a9944e05819`.
The exact candidate SHA is the branch tip reported in the builder report. Nothing was deployed, pushed or written to
production. This is a builder self-review; it is not an independent PASS.

## What it adds

ONE write tool, `plan_create` ("Add gym tomorrow at 6 PM"), behind `chronasense:plan.write`. The controller resolves
language; the tool receives `target {store:'calendar', id:'cal1:YYYY-MM-DD'}`, `title`, and optionally `when` (HH:MM)
+ `whenTz` (canonical IANA) + `whenDayOffset` (0|1) + `durationMinutes` (1–720). Five reads and `brain_dump_add` are
behaviorally unchanged (two Worker tests that pinned "only one write tool / two scopes" were updated to the new
surface; every Brain Dump behaviour test is untouched and passes).

## Architecture (DECISIONS #37)

- No migration, no second store. The item `api1_<uuid>` (+ immutable `creationActionId`) lives at its keyed child
  `rooms/<room>/calendarPlanFences/<planId>/api1_<uuid>` — the location-bound representation #33 already uses for
  fenced Brain Dump items. The item never enters the plan record's `items` array; the only plan-record write is the
  existing canonical origin (createdAt + home timezone) for a plan that has none (R011-02), via
  `mergeCalendarPlanRecords` under an ETag CAS with the ordinary owner token.
- Rules: CREATE only by an action token whose claims (`chronasenseActionId`, `chronasenseActionKind:'plan_create'`,
  `chronasenseActionTarget`) bind item id, marker and path; child absent; calendar activation fact present. UPDATE only
  by an ordinary owner token, marker pinned (id must derive from it), tombstone monotonic, no relocation, no delete, no
  parent overwrite. Plan arrays reserve `api1_` and refuse markers; a plan token cannot create a Brain Dump capture.
- Function: pre-claim structured validation (incl. DST gap / plan extent) → receipt claim/replay/takeover → exact-child
  read (marker = proof) → Plan Authority server read (calendar-authoritative, frozen home zone, not past, id unused) →
  origin freeze → `if-match: null_etag` create → exact readback → applied. A definite refusal is REJECTED only on the
  action's first attempt; any takeover stays PENDING_UNKNOWN until the child proves it (R011-01). A rules refusal is
  re-checked against the child before it is reported.
- Client: `plan-item-origin.js` counts action items as fenced (split/fold/merge, tombstone monotonic); cross-day move
  refused (Plan Authority, editor, rules); the `saveItems` funnel never introduces one into a plan. Governed import-map
  generation moved to `20261012-task011-plan-action-items-v1`.

## Highest-risk files

`scripts/firebase-rules-builder.mjs` (`actionPlanItemRules`, `actionCaptureKind`, `arrayActionRefused`) and generated
`firebase.rules.json`; `functions/src/plan-create-action.js`; `functions/src/user-scoped-rtdb.js` (token claims, pinned
URL); `functions/src/envelope.js`; `functions/src/plan-read.js` (read compatibility); `plan-item-origin.js`;
`plan-authority.js`; `workers/chronasense-conversational-bridge/src/{mcp,index,action-client}.js`.

## Known limitations (accepted in this candidate, not hidden)

Calendar store only (legacy/operational targets: `DOMAIN_LIMIT`; unactivated account: `NOT_FOUND`). Always an "Other
task" (`kind:'task'`). Action-created tasks cannot be moved to another day yet (same V1 rule as Brain Dump tasks; stale
recovery still copies them as ordinary `ocarry1|` items). A client predating this change does not display action items
until it updates (visibility gap, not corruption). Rules check that an activation fact exists, not the date >= activation
date (the Function enforces date routing). No domain-side writer fence exists, so an action whose earlier attempt
died before writing, and whose takeover then meets a definite refusal, stays PENDING_UNKNOWN indefinitely (never
REJECTED); the controller must not mint a new action ID for it. Not proven locally: production custom-token signing/IAM (the TASK-010
Auth-emulator proof covers only claim propagation), the deployed `/v1/command` route, Android build.

## Release order (owner-authorized, not done here)

Web client (+ Android build if applicable) and reviewed rules first (backward compatible), then the Function, then the
Worker scope/tool. Verify a stale-client device updates before relying on visibility.
