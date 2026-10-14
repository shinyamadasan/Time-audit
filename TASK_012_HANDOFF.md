# TASK-012 — Expanded Conversational Plan Actions (review handoff)

Candidate: branch `task-012` (local only, not pushed), base `origin/main` `2dfa1df9c0c4a5f8304c64b42f1aa1e7745ed3fa`.
The exact candidate SHA is the branch tip reported in the builder report. Nothing was deployed, pushed or written to
production. This is a builder self-review, not an independent PASS.

## What it adds

Four semantic write tools under the existing `chronasense:plan.write` scope (DECISIONS #38): `plan_set_completion`
(`completed: true|false`), `plan_edit` (`title` / `time {when, whenTz, whenDayOffset?}` / `durationMinutes` /
`clearSchedule: true`; absence = unchanged), `plan_move` (`destination` calendar plan, optional `time`/`durationMinutes`)
and `plan_delete`. Each names one existing item by `target` (calendar only) + stable `itemId` + `expectedRevision` (the
`rev1:` item revision get_plan/get_item return). Five reads, `brain_dump_add` and `plan_create` are unchanged. No client
change. Rules change only to let an `api1_` item relocate through one atomic multi-path update (gap closure on top of
`400c770`).

## Item-type matrix

| item | complete / uncomplete | edit title / time / duration | cross-day move | delete |
|---|---|---|---|---|
| ordinary array item | SUPPORTED | SUPPORTED | SUPPORTED (same id + relocationRevision, source tombstone, ONE atomic write) | SUPPORTED (tombstone) |
| `bdp1|` fenced Brain Dump item | SUPPORTED (fence child; rules re-authorize via capture) | SUPPORTED | REFUSED BY DOMAIN (`DOMAIN_LIMIT`; its capture promotion names its location) | SUPPORTED |
| `api1_` ChatGPT item | SUPPORTED (marker pinned) | SUPPORTED | SUPPORTED (same id + relocationRevision at the destination fence child, source move tombstone, ONE atomic multi-path update; not back onto a day it left) | SUPPORTED (monotonic) |
| carryover (prior-day item landing today) | SUPPORTED via the existing completion exception only | REFUSED (`PAST_TARGET_IMMUTABLE`) | REFUSED | REFUSED |
| stale-recovered copy (`carriedFrom*`) | SUPPORTED | SUPPORTED | REFUSED (`DOMAIN_LIMIT`; Unfinished flow owns it) | SUPPORTED |
| completed item | uncomplete SUPPORTED; complete = no-op success | SUPPORTED | SUPPORTED (array) | SUPPORTED |
| tombstoned item | REFUSED (STALE / CONFLICT) | REFUSED | REFUSED | REFUSED (no second tombstone) |

## Highest-risk files

`scripts/firebase-rules-builder.mjs` `actionPlanItemRules` (`moveIn`/`moveOut`/`actionRelocationImmutable`) and generated
`firebase.rules.json`; `functions/src/plan-mutation-action.js` (receipt intent, observe/proof/precondition/write loop,
`planMutation`, `mergedRecord`, `readMove`, the `fenceMove` path), `relocateActionPlanItem` + `plan_move` claims, `functions/src/user-scoped-rtdb.js` (four new pinned owner-token primitives),
`functions/src/envelope.js` (`planMutationParameters`), `workers/chronasense-conversational-bridge/src/mcp.js`,
`workers/chronasense-conversational-bridge/scripts/deploy.mjs`.

## Known limitations (accepted in this candidate, not hidden)

- `bdp1|` Brain Dump tasks still cannot change day. A ChatGPT task cannot move BACK onto a day it already left (its move
  tombstone holds that child; reviving it safely needs a client merge-law change). The app's own editor still does not
  move ChatGPT tasks (only `plan_move` does).
- The `api1_` move's commit-time staleness guard is the source's writer stamp (`updatedAt` + `updatedBy`), checked by the
  rules; the Function checks the full revision just before. Two different contents with the identical stamp would need
  the same device to write twice in the same millisecond.
- An action whose earlier attempt recorded an intent and whose item was then edited stays PENDING_UNKNOWN indefinitely
  (whether it applied before the edit is unprovable). ETag CAS is content-addressed: a byte-exact pre-image restoration
  could re-admit a paused earlier write of the identical planned post-state.
- A move writes the whole `calendarPlans` collection under one ETag: any concurrent plan write anywhere retries it
  (bounded, then PENDING_UNKNOWN), it is bounded by the existing 1 MiB read cap, and an unauthorized pre-fence `bdp1|`
  item on ANY calendar day would make every move FORBIDDEN (rules validate every written item; not expected in production).
- Scope reuse: an OAuth grant already issued for `chronasense:plan.write` (consented as "add one new task ... cannot
  edit, move, complete or delete") gains these mutations when the Worker ships. If the owner wants consent to match,
  revoke and re-grant after rollout; no new scope was added (owner instruction preferred reuse).
- Array-item tombstones remain client last-writer-wins (pre-existing); fence tombstones are server-monotonic.
- Not proven locally: production IAM/custom-token signing, the deployed `/v1/command` route, Android build, a real
  Wrangler deploy through `scripts/deploy.mjs --confirm` (only its validation, redaction and `--dry-run` were exercised).

## Release order (owner-authorized, not done here)

No client release. Reviewed rules FIRST (backward compatible), then the Function (the new kinds are unreachable until the Worker exposes them), then the Worker
via `npm run deploy -- --confirm` with the five bindings in an untracked `.deploy-vars.json`; verify the five bindings and
`/authorize` on the new version. The OAuth consent text for `chronasense:plan.write` changes; existing grants keep working.
