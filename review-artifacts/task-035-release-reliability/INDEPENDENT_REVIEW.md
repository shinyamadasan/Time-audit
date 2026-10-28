# Independent source/contract review

Recorded from read-only reviewer `/root/task035_independent_review` messages, October 27, 2026.
Verdict: **PASS; no remaining must-fix in the reviewed source.** Formal release approval,
production state and physical-device acceptance are separate.

The reviewer confirmed the pre-existing F-1/F-2/F-3 ownership/expiry defects and compatible numeric
creation-only identity correction for F-6/F-7. Owner chose F-4 before implementation.

Review findings corrected before final gates:

- Restored publication must conditionally refuse newer server Stop/takeover, not trust the first
  cached SDK value or use a read followed by unconditional update.
- A held restore acknowledgement must not rewind a newer Quick Save. Exact full submitted scalar
  echo suppression and conditional catch-up now preserve the cursor. Independent execution of
  the actual functions produced two conditional publications and zero ordinary updates.
- A remote Focus takeover must not be republished by the older acknowledgement as an ordinary
  timer. Account/device/session/mode guards retain the new owner and mirror with zero follow-up writes.
- Undo matches its captured device, including permitted legacy null ownership, and cannot rewind
  a replacement timer. Valid expired restoration clears/replaces its ticker.
- Malformed countdown/start values are refused; Quick Save extension uses the same minimum-minute
  rounding as creation.

The final reviewer verified removal of storage.js's first-line ESLint global declaration gives
the previously reviewed functional source exactly. The entry-validation VM fixture now supplies
real Web Crypto and new state placeholders; original assertions are unchanged (32/32 passed).

Final reviewed SHA-256:

| File | SHA-256 |
| --- | --- |
| index.html | e6cee26364e94e42a5bb0773704e4b7ef3185f13dcaf6939d7edd437b0b8825d |
| storage.js | 2afe3c819560b7234813df1b2647103a32642d5cd3ca2e3e93ddddbf7a992240 |
| tests/daily-use-reliability.spec.js | 12b3dd89783ab5d24d2f30456c0f827c15bb7b55a7d1f1a7946878867dd66f15 |
| entry-reliability-sdk.test.js | 3d7b7773eabc449f20a51ef8766c55da8abe9d796a32941c33d30c8ad4272fae |
| entry-validation.test.js | 17daadc6672575ccb2ba034715c32f031527c8a7ce144103232a3ff6f846628e |

Reviewer saw 94 affected browser passes and six real-SDK passes, and confirmed both generated
runtime mirrors. The reviewer did not independently rerun the whole release gate. Its final
outcome is reported in the main closure handoff and gate JSON, not inferred from this review.

Inherited ordinary/Focus prompt coupling outside this diff was treated as advisory, not authorization
for a Focus redesign. No broader protection against every old writer or every concurrent offline
timer action is claimed. Existing Focus reconciliation remains unchanged.

## Full-gate test-source follow-up

First whole-browser gate: 1,001 actual passes / 13 failures, no skips/retries. Reviewer independently
classified its JSON: five old planner-title expectations, five clicks on secondary mobile destinations
now behind approved More, one count that included More as a ninth destination, and two fixtures
constructing unowned recovery/QuickSave state. The eleven presentation mismatches already exist in
approved ab0c601; no production change was needed.

Reviewer PASS for updated capability/career, cross-domain intelligence, learning-plan, personal-day,
calendar-identity, install-interruption and smoke specs. Tests now use the exact approved title,
visible More navigation, eight real destinations plus More, and actual owned timer/recovery helpers.
Original date/plan identity, overflow, view-state, deferred-install eligibility and canonicalization
assertions and timeouts remain. No forced-click/evaluate bypass of navigation, skips or expected
failures were introduced. Targeted corrections/neighbors: 16/16 actual passes. Production hashes
above remain unchanged. A fresh full gate is required and is reported separately.
