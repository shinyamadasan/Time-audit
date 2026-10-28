# TASK-037 — small Save-action repair

Branch: `task-037-save-action-repair`, from reviewed `6fcee74`, retaining approved reliability
`9aaf021` and visual `ab0c601`. Owner explicitly authorized the two-line proposal on October 27,
2026 America/Phoenix and directed the release focus back to planning, Eisenhower, Brain Dump and
reminders. No new feature, redesign, production action or current-main integration is authorized.

## What changed

Only the quick/recent activity adapters inside `openQuickLog` no longer pre-set `quickLogBusy`
before calling `_doQuickSave`. The saver retains the central busy assignment/guard, account/device
ownership guards and all accounting/sync behavior. Repeated button events are still refused.
Required generation metadata is `20261027-task037-save-action-repair-v2`; www/index is generated
from the root. Two existing generation assertions track it. Static UI/markup/styles are unchanged.

The regression began in TASK-035 when the central guard was added without changing the existing
callers. The owner saw notification delivery, then Save failed. The inspected form was busy with
no entry. Normal Stop preserved the entire original test span as exactly one remote record.
That device checkpoint is archived; no new owner walkthrough is requested.

## Verification

**Local repair: GO for repository review. Production: NO-GO.**

- Complete browser gate: **1,024/1,024 actual passes**, zero failures, skips or expected failures,
  19.8 minutes. Planning, Brain Dump/Eisenhower, reminders and account-safety suites are included.
- Complete `npm test`: **2,342 passed / 1 existing opt-in diagnostic skip**, zero failures; legacy
  harness **455/455**. Skip: lower-case-drive diagnostic needing CROSS_REPO_COMPAT_CONTROL_PROOF=1.

- Strict pre-repair UI run: 4 failures / 2 passes. Both adapters failed to save, both owner-refusal
  paths got stuck busy. Valid manual Save and already-busy rejection passed. No expected failures.
- Final real-SDK UI checks: **21/21**, seven cases repeated three times. Both adapters save once,
  repeated events do not duplicate time, a categorized manual Save persists, account/device refusal
  records nothing, Save→Stop records exact contiguous spans and two reloads preserve them.
- Independent review: **PASS**, no must-fix findings; separate actual **7/7** SDK/UI run. Hashes bind
  exact source/tests. The central saver and every other runtime path are unchanged after generation
  normalization. Independent stdout was tool-captured, not saved as a standalone log; its Playwright
  passed marker is archived.
- Original seven strict scenarios: **21/21**, unchanged test file. Firebase rules/fence/SDK/mutation:
  **170/170**. Worker **32/32** and bundle **dry-run only** passed. Lint: **0 errors / 48 existing warnings**.
- Runtime closure: **98 files**, byte-identical www mirror; generated shared/rules parity passed.
- Preservation: **5,512 protected hashes across seven historical trees**, reviewed 6fcee74 tracked
  checkout and all **four** existing test time records unchanged. Source verification permits exactly
  the two caller removals after generation normalization.

Initial fixture attempts are retained as attempts, not passes: the new checkout needed its pinned
local dependencies; the start must be awaited; the existing canonical label is "Deep work"; seeded
recent entries use canonical `e_<id>` keys and updatedAt. Exact entry-count, chronology, ownership and
no-duplicate assertions were retained. No product code beyond the two removals was needed.

## Self review / QA

Code health passes: two redundant assignments removed; existing centralized behavior reused; no new
helper/state, dead code, formatting/refactor or UI change. Would ship this bounded repair as a local
repository-review candidate: yes; required local gates completed, formal repository review pending.
The original seven-scenario file, storage, Plan Authority, fences/rules, Brain Dump, notification
worker and core saver remain unchanged. No schema, migration, valid-record deletion or guard bypass.

## Productivity and release focus

Keep the existing approved workflow: capture in Brain Dump, prioritize in Eisenhower, prepare/save
the day, and receive reminders. Planner owner Save/reload and physical Android notification delivery
passed on 6fcee74; the relevant model/scheduler remain unchanged here and automatic regressions cover
the repaired Save adapters. A fresh owner phone Save/Stop pass is not claimed. Direct Eisenhower
insertion remains deferred. Worker/process termination still prevents a guarantee of always-on
browser reminders; this repair does not introduce new notification architecture.

The full passing browser gate includes **32 Plan Tomorrow**, **15 Brain Dump/Eisenhower**, **10 Brain
Dump production UX**, **28 Brain Dump plan-tray**, and **53 planning-continuity** cases. These are
subsets of the 1,024 total, not additional unique passes. The 170-case fence gate retains source
protection. No new productivity feature or promotion contract is introduced.

Production remains **NO-GO** pending separately authorized current-main/TASK-032 integration, hosted
`test` and `Firebase fence / rules integration`, formal exact-head/base repository review, captured
live compatibility/rollback artifacts and explicit rules-first/client-release authorization. After
reviewed rules deploy, verify live guard plus older/newer-client canaries before separately authorized
client publication. Main auto-publishes Pages; no merge/push is authorized. Rollback preserves recorded
data and source fences; rules rollback requires separate review and authorization.

All original candidates/worktrees/test records are preserved. The existing phone test instance remains
on 6fcee74; this local candidate has not been published to that instance. Gate-generated screenshots
were archived, then only this new checkout's historical baseline-output copies were restored.
Exact gate results, reviewed hashes and compressed attempt/success logs are in
`review-artifacts/task-037-save-action-repair/`. Nothing was pushed, merged or deployed.
