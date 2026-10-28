# Proposed bounded quick-log Save repair — not implemented

Candidate: `6fcee74`. Product code and approved baselines remain unchanged.

Owner reported Save Entry did not save after opening the Android notification. The actual test
account had zero recorded entries, correct account/device ownership and `quickLogBusy === true`.
Both quick-activity and recent-activity callbacks set that flag before invoking `_doQuickSave`,
whose first guard returns when the flag is true. A later manual Save also returns while locked.
The activity field was empty at inspection; no claim is made that a valid manual form submission
alone fails. This is a confirmed caller/saver contract defect, consistent with the observed lock.

Read-only actual-source reproduction: **2 FAIL**. Both callbacks return before even reaching the
ownership/accounting boundary. Removing only their two premature assignments in an isolated VM
allows both paths to reach that boundary. This proposal-only check is not a repaired product pass.

Baseline comparison: visual `ab0c601` had the caller assignments without the central busy guard.
Reliability `9aaf021` introduced the central guard while retaining those assignments; `6fcee74`
inherits that incompatible combination. This is a TASK-035 regression exposed by device acceptance.
Earlier direct-saver strict tests passed but did not exercise these UI callback adapters.

Smallest product diff in `openQuickLog`:

```diff
 renderQuickActionGrid('ql-quick-actions', option => {
   if (quickLogBusy) return;
-  quickLogBusy = true;
   _doQuickSave(option.activity, option.energy);
 });
 renderRecentTaskGrid('ql-recent-tasks', 'ql-recent-wrap', item => {
   if (quickLogBusy) return;
-  quickLogBusy = true;
   _doQuickSave(item.activity, item.energy);
 });
```

Retain the central busy guard and its assignment, account/device guards, accounting logic, source
protection, UI and recorded-time schema. Required generated mirrors/generation metadata only.
Add strict actual-UI regressions for both adapters, repeat-tap deduplication, valid manual form Save,
ownership refusal and Save followed by Stop without overlapping time; run affected and required
local release gates, obtain independent review. Automate verification; do not require another long
owner walkthrough. No push, merge, rules deployment, production access or publication.

Stop if the two caller changes are insufficient or any new accounting, ownership, data or UI contract
change is required. The existing TASK-037 contract restricts index changes to notification scheduling
and cancellation and requires stopping for additional application paths, so owner scope authorization
is needed before implementation. This document is a concrete proposal, not authorization.

Test-time preservation: automated normal Stop retained the original start `1793144577092` through
`1793145063158` as exactly one remote record (8 rounded minutes). No tracking start was discarded or
overwritten. Save acceptance remains FAIL and automatic Stop does not substitute for that check.
Evidence: SAVE_ACTION_STRICT_REPRO.json, SAVE_FORM_DIAGNOSTIC.json,
SAVE_FAILURE_BASELINE_AND_PRESERVATION.json and SAVE_FAILURE_SAFE_STOP.json.
