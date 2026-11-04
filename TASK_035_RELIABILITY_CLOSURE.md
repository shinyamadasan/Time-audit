# TASK-035 — bounded release reliability closure

Owner authorization: October 27, 2026 America/Phoenix. Local development and testing only.
Base: approved visual `ab0c601745c0471a84feb44deeb6b38214b25383`.
Worktree/branch: `.worktrees/task-035-release-reliability` / `task-035-release-reliability`.
No push, merge, production rules/data access, deployment or publication is authorized.

## Classification and approved contract

All four affected source sections (`restoreTimerAwayState`, `doPing`, `_doQuickSave`,
`quickRetroLog`) match protected TASK-028 `17608cd`; these defects predate TASK-033.
TASK-034's exact JSON/logs were read before mutation. Fresh before-fix reproduction in this
worktree: **0 passed, 7 failed, no skips/retries**, with strict handling enabled.

| Case / original assertion | Reproduction and affected path | Classification | Smallest repair / decision |
| --- | --- | --- | --- |
| F-1: `sessionKept(s)` is true | Start offline, terminate after five minutes, reopen after 45 minutes and choose accidental; expired `restoreTimerAwayState` skipped ownership, then `persist` erased the timer. | Existing data-loss defect. | Restore valid expired sessions and original accounting anchors; account/session-bind recovery. No product decision. |
| F-2: heartbeat is null; recovery hidden | Same offline expired session, intentional recovery then reload; `_stopHeartbeat` had no owner. | Existing cleanup/recovery defect. | Restore owner before recovery; preserve clean-exit cleanup and exactly-once logging. No product decision. |
| F-3: recovery visible or session retained | Missed due ping, offline reopen with recent heartbeat; the two-minute prompt threshold combined with skipped expired restore. | Existing data-loss defect. | Restore session independently of whether a prompt is due. No threshold change or product decision. |
| F-6: two remote Sleep segments and unique local IDs | Two retro logs cross the same midnight; `quickRetroLog` assigned both first segments `midnight - 1`. | Existing deterministic remote overwrite. | New creation-only numeric identities independent of interval endpoints; never re-ID existing records. No product decision. |
| F-7: remote activities equal Email and Lunch | Two retro logs end in the same minute and share `tsEnd` as ID; `syncEntries` addresses one child per ID. | Existing deterministic remote overwrite. | Same numeric identity correction, including independent-client proof. No product decision. |
| F-5: stored/measured duration difference below one minute | Save shortly after a ping; `_doQuickSave` rounded to zero then substituted the configured 30-minute interval. | Existing evidence corruption. | Retain exact instants and use established minimum-one-minute rounding in creation and extension. No product decision. |
| F-4: created `tsStart` equals original start | Ping advanced the block anchor before notification-tap Save, while copy implied the preceding block. | Existing product-contract ambiguity, not a test-only defect. | Owner explicitly chose pending block through Save, including response delay; then advance the accounting anchor so Stop cannot duplicate it. Decision received before implementation. |

The seven original contract assertions and setup checks are retained. Expected-failure annotations
are removed; default and strict runs now demand actual passes. Notification delivery timing on
physical devices is not inferred from the synthetic browser harness.

## Bounded source changes

- `storage.js` / Timer restore: finite positive saved countdown/start validation; restore expired
  sessions with original owned anchors; one ticker; read original heartbeat before restarting it.
- `index.html` / Recovery: in-memory account/device/session-bound recovery snapshot and guarded
  delayed modal/action. Account changes, replacement sessions and accepted Stop/takeover invalidate
  ordinary recovery. Existing two-minute prompt threshold and Focus reconciliation remain.
- Existing timer write boundary: first restored-normal publication is a conditional transaction
  against its saved sync stamp. A newer server Stop/takeover refuses it, including a stale SDK
  cached value followed by server retry. Exact submitted echoes cannot rewind a newer Quick Save;
  any required catch-up uses that same conditional boundary. Account/session guards make stale
  completions inert. Existing Focus reconciliation is separate.
- Quick Save advances the existing serialized `taskStartTime` and `blockStartTime` accounting
  fields through Save. This survives older whole-timer writers. Optional presentation-only
  `trackingStartedAt` on the same timer keeps hero/HUD start and elapsed display stable; legacy
  records fall back to their existing start. No new recorded-time authority or migration.
- Entry Undo carries the pre/post accounting cursor and rewinds only the same active account,
  device and session. Both creation and extension Undo are covered; replacement/remote Focus
  cannot be rewound. Stop and repeated Save do not double-count the saved interval.
- `newEntryId` supplies positive cryptographic safe-integer IDs for new quick-retro records,
  rejecting zero and locally present IDs, including tombstones. Existing numeric IDs, template
  string IDs and all actual `tsStart`/`ts` timestamps remain unchanged. Cross-device random-ID
  collision probability is negligible, not a global reservation guarantee. Historical collisions
  are not retroactively migrated or repaired; no production records are accessed.
- `tests/daily-use-reliability.spec.js`: original seven assertions plus bounded regression cases.
  `entry-reliability-sdk.test.js`: real local SDK two-client/conditional-write proof, registered in
  the existing fence SDK gate through `package.json` and `npm-test-wiring.test.js`.
- Directly affected test fixtures: `entry-validation.test.js` supplies real Web Crypto to its VM;
  install/smoke tests create an actual owned timer before recovery or QuickSave. Full-gate tests
  use the already-approved planner title and mobile More path (capability/career, cross-domain
  intelligence, learning plans, Personal Day/calendar identity). Domain/overflow/date assertions
  and timeouts remain. No production design change was made to satisfy these older expectations.
- Governed runtime generation: `20261027-task035-release-reliability-v1`; Brain Dump remains
  `20261026-task031-source-guard-v1`. Generation-only expectations and generated `www/` follow.

No Firebase rules, promotion protocol, Plan Authority, entry sync merge law, visual stylesheet,
navigation design, font, planning behavior or direct Eisenhower insertion changes are included.
The source-protection guard and all protected baselines remain intact.

## Verification and review

Evidence is retained under `review-artifacts/task-035-release-reliability/`.

| Gate | Actual result |
| --- | --- |
| Before-fix exact seven, strict | 0 passed / 7 failed / no skips or retries. |
| First repaired exact seven, strict | 7/7 passed; original expected-failure handling was then removed. |
| Final seven repeated three times, strict | **21/21 actual passes**, no expected failures, skips or retries. |
| Affected reliability/Focus/account/entry browser | **94/94 actual passes**, no skips/retries. |
| Real local SDK reliability proof | **6/6 passed**, included in the full fence gate. |
| `npm test` | **2,321 passed, zero failed, one existing opt-in diagnostic skip**; legacy **455/455**. |
| `npm run test:fence` | **167/167 passed**, no skips, including real RTDB emulator/SDK and mutation checks. |
| Worker tests and bundle | **32/32 passed**; Wrangler 4.149.0 bundle `--dry-run` exit 0, no upload/deploy. |
| Lint | Zero errors, original **48 warnings**. |
| Runtime/shared/rules parity | **98 mirrored files byte-identical**; shared sources and generated rules match. |
| Independent source/contract review | **PASS, no remaining must-fix**, bound to the final source/test hashes. |
| First full browser | **1,001 actual passes / 13 failures**; no expected failures, skips or retries. |
| Full-gate fixture/approved-UI corrections | **16/16 actual passes**, original domain assertions/timeouts preserved. |
| Final full browser | **1,014/1,014 actual passes**, 21.4 minutes, zero failures/expected failures/skips/retries. |

The first full-run failures were independently classified: five old planner-title expectations,
five direct clicks on mobile destinations now behind approved More, one count treating More as a
ninth destination, and two fixtures constructing unowned recovery/QuickSave state. The eleven
presentation mismatches are already present in approved ab0c601. Only test setup/expectations changed;
the repaired production source stayed frozen. The earlier 1,001/13 result is retained, not erased.

The first full Node attempt stopped because the VM harness for entry-validation did not supply
browser Web Crypto. Supplying real Web Crypto and new global placeholders restored its unchanged
32 assertions; the complete Node rerun passed. Earlier lint briefly included undeclared new classic
script globals; an explicit declaration restored the original warning count. No production logic
changed for either fixture/tooling correction. No timeout was increased or retry introduced.

Local environment: Windows, Node 24.19.0, Chromium and RTDB emulator 4.11.2. Hosted CI uses Node 22
and remains separate. The existing skipped lower-case-drive diagnostic requires
`CROSS_REPO_COMPAT_CONTROL_PROOF=1`; no application failure is hidden as a skip. Coverage is unmeasured.

Source/contract proof: `SOURCE_VERIFICATION.json` checks all seven original test bodies unchanged
apart from expected-failure removal; 25 visual assets/adapters unchanged; markup unchanged apart
from coherent generation; 22 domain/safety files unchanged. `HARD_RULES.json` confirms exact approved
overlap/merge/gap/device-ping implementations. `PROTECTED_VERIFICATION.json` confirms all 5,512 hashes
across seven protected worktrees unchanged, including the original dirty audit and TASK-034 evidence.
Final source and reviewed test hashes match `INDEPENDENT_REVIEW.md`.

The failure-to-resolution outcome is **strict PASS for each of F-1 through F-7**, three consecutive
executions each, plus their ordinary required passes in the complete suite. Source review and the
test-only full-gate corrections both received independent PASS with no remaining must-fix.
Machine-readable counts: [GATE_RESULTS.json](review-artifacts/task-035-release-reliability/GATE_RESULTS.json).
Exact reviewed source/test hashes and design preservation:
[SOURCE_VERIFICATION.json](review-artifacts/task-035-release-reliability/SOURCE_VERIFICATION.json).
Independent verdict: [review record](review-artifacts/task-035-release-reliability/INDEPENDENT_REVIEW.md).
Every earlier attempt and final output is preserved in deterministic gzip archives indexed by
`ARTIFACT_MANIFEST.json`; raw logs, JSON and failed-run traces also remain locally.

Code-health and applicable automated QA pass. TASK-035 is `review`, never `done`/self-approved.
The local implementation/evidence handoff is complete. No automatic chaining or release action follows.

## Release boundary

**GO for local reliability closure and owner real-device acceptance. Production release remains
NO-GO pending those device/external gates and explicit production authorization.** The seven strict
reliability blockers from TASK-034 are closed in this local candidate; they are not waived or hidden.

Production publication remains held. TASK-034's rules-first preflight, live-rules drift/backup,
compatibility, rollback, hosted exact-head/base CI/formal review, real-device acceptance and explicit
publication/rules/integration approvals still apply. This task does not exercise those production
steps. Native notification/background/keyboard behavior and Android distribution remain separate.

Short device acceptance remains pending, using disposable test data and this exact generation:

- Preserve an offline session across termination beyond one interval and a recent-heartbeat reopen;
  accidental recovery retains its start, intentional recovery logs once and leaves no repeat prompt.
- Trigger more than one reminder, tap the real notification, Save, then Stop: recorded intervals
  join without duplicate coverage; elapsed/HUD origin remains stable. Test fast sub-minute Save too.
- Undo a new and extended Quick Save; then Stop. Replaced/remote-taken-over sessions must not rewind.
- Create same-end and midnight-crossing retro records on separate devices; reconnect, reload and
  verify both records/segments, chronology, edit/delete/Undo and unchanged account ownership.
- Verify the already-approved My Day/planner/More design on the owner's phone, actual keyboard,
  native zoom and screen reader. Native Android build/install/distribution is separately authorized.

Remaining execution permissions are separate: remote publication/PR, exact production rules
deployment and authorized test-account canaries, exact integration/hosting publication, and native
distribution if requested. Visual approval and local reliability closure grant none of those actions.
Keep TASK-031's source-preservation rules first; verify live before releasing the client. On a later
authorized UI rollback retain the source guard and user data; never clear captures, replay plans,
revert tombstones or restore a data snapshot to undo a frontend release.
