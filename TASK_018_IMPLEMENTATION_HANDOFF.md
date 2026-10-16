# TASK-018 implementation handoff

Target: REVIEW-READY ONLY. Base origin/main verified at `bb171a287ac67d76ae27634b5227bc24f66919de`.
Reviewed contract checkpoint: `df7c279ea730526314c2e97c7f6597674208b518`.
Approved visual direction: Refined A, `26e24b46214cf6ae12828d5bd8389171a5644b28`.
Current owner authorization: attachment `44332b2d-84ff-4e8f-a4f2-80178f0818f9/Pasted text.txt`.

## Implemented boundary

Dedicated `chronasenseCompletionApi` verifies the Firebase ID token with revocation checking, derives the UID
and room, and rejects Action API claim-bearing tokens. Only inspect, exact-operation status and completion/Undo
commands exist. Caller-supplied account, path, actor and assertion time are refused. No credentials are shipped
to the browser. Deployment requires an explicitly provisioned dedicated service account; none was provisioned.
The approved adapter's UID/path/schema/diff allowlist constrains its code, not the credential's database-wide
capability. Firebase IAM does not provide the proposed RTDB child-path isolation. A compromised service credential
would exceed this operation's scope; dedicated runtime/IAM review and real verified-auth tests remain release gates.

Facts live under `rooms/uid_<UID>/taskCompletionResolutions/r1_<account-and-identity-hash>`.
Identity binds original store, target, task ID, array/fence representation and origin/claim generation.
Records contain reported actual civil completion date/timezone, server assertion instant/actor, source hash,
revision, current resolution state and immutable operation receipts. No duplicate task, title, plan, activity
log, tracked duration, historical achievement, Review or streak fact is created.

The backend reads a single owner-room export and validates source/context and resolution together. Every write
requires that exact room ETag and an independently enforced one-resolution-only diff. It preserves all siblings
and existing receipts, retries contention at most three times, and never falls back to a blind write. Frozen
historical plans remain frozen. Any priority/export wrapper or room above 16 MiB refuses. Records whose next
acknowledgement would exceed 500 KiB refuse before CAS; HTTP responses are capped at 512 KiB.

Every exact operation UUID/body is stored in its owner's pending-command slot before dispatch. Local changes,
timeouts and listener cache values never count as durable completion. The client verifies the authoritative
receipt identity/operation/intent hash, then refreshes the current head and source. Unknown operations retain
the same receipt across reload, account switching and retry; absence alone cannot prove rejection. Pending
changes block competing secondary UI actions. A confirmed matching current head suppresses the task only in
Unfinished; source/history and all other completion classifications remain unchanged.

Undo appends an operation against the exact resolution revision, source hash and completion UUID. A changed
source/head refuses. Existing receipts are never erased. A late response whose Undo was already superseded by
a newer completion reports refreshed status without claiming the task is currently open. The temporary Undo
control pauses expiry while hovered/focused. Generic Check status remains available for unknown operations.

## UI evidence

Actual root production UI, synthetic 22-task backlog and valid populated Today timeline; no live account data.
Local evidence is in `playwright-report/task-018-production/` (ignored generated artifacts):

- `390-my-day.png`, `1440-my-day.png`: full My Day. These use an extended-height viewport at the requested width
  so fixed navigation rests at the document foot; no production elements/styles were removed for capture.
- `390-preview-viewport.png`, `1440-preview-viewport.png`: ordinary 390x844 / 1440x900 viewport, five-row preview.
- `<width>-backlog.png`, `<width>-search-long-title.png`, `<width>-menu.png`, `<width>-date.png`.
- `<width>-metrics.json`: measured section height **375px** at both widths, five ordinary rows, every checkbox,
  title and More target at least 44x44px. Preview has no permanent search box or pagination.

Final screenshots were recaptured with ignored `capture.config.mjs` / `capture.spec.mjs`: the unchanged two
production evidence cases passed again, with a 700ms pre-screenshot wait for existing smooth scroll to settle.
No production CSS/behavior or test assertion was changed by this evidence-only runner.

Complete today: one intentional checkbox action. Earlier date: More, Done earlier, date input, Save (four
controls; native picker taps vary). View all then type searches all 22 items; larger backlogs render 50 at a time
inside the bounded dialog with Show 50 more. Tapping/focusing a long title reveals it independently of completion.
The menu stays anchored and keyboard operable; modal focus survives refresh and completion. Timeline checkbox
styling matches Unfinished while its existing callback and historical meaning remain unchanged.

## Verification

Verified local gates (raw logs use the `task018-*.log` prefix):

- `npm test`: node:test **2250 total, 2249 passed, zero failed, one existing opt-in skip**; legacy harness
  **455/455 passed**. The skip is the cross-repository lower-case-drive negative control requiring
  `CROSS_REPO_COMPAT_CONTROL_PROOF=1`, not a completion proof obligation.
- New deterministic production contract/client/backend/cost proofs: **59/59 passed**, also independently rerun.
- `npm run test:fence`: **151/151 passed** (94 rules/emulator, 20 real-SDK fence, 37 rules mutation), including
  all **14/14** production completion adapter emulator cases. Synthetic loopback accounts only.
- Unchanged Conversational Worker CI gate: **32/32 passed**, local locked Wrangler 4.149.0 dry-run bundle passed;
  no upload. Initial missing-dependency run was superseded after locked offline installation; no lockfile changed.
- Generated rules/shared artifacts and **95-file** www runtime closure match; diff whitespace clean.
- Lint: **zero errors, 48 existing warnings**. No new completion/UI warning.
- Full Chromium gate: **947 expected outcomes = 940 passed + seven unchanged expected failures**, zero
  unexpected failures, skips or flaky outcomes. Console summary and JSON results both inspected. Command:
  `npx playwright test --workers=4 --reporter=list,json`; final log `task018-full-browser-review.log`, structured
  evidence `playwright-report/task-018-production/full-browser.json`.
- The seven TASK-013 reliability failures F-1 through F-7 remain reproduced and unchanged (offline session/
  heartbeat recovery, notification semantics, quick-log duration and retro-log collisions). They were not fixed
  or relabelled. Existing TASK-015 claim/false-conflict and Today-then-Tomorrow follow-ups remain outside scope.
- Settled-scroll evidence rerun: **2/2 passed**, `task018-settled-evidence-final.log`. The three harness-corrected
  regressions: **24/24 repeated checks passed**, then also passed in the final full gate.
- Independent verdict is delivered separately against the final implementation SHA; earlier preliminary
  review is not substituted for that exact-candidate review.

Earlier failed iterations are not release evidence: one emulator fixture omitted the new
CAS preimage argument; browser stub initially retained Firebase-pruned nulls; compact CSS initially lost to an
old ID-scoped row rule; screenshot fixtures initially omitted required timed-item timezone. All were corrected.
An earlier full browser run had 13 unexpected failures from stale UI selectors, the governed token assertion
and duplicate empty-candidate listeners. A subsequent run had nine failures from an accidentally removed
offline browser-service test helper plus one baseline smoke startup race. The helper was restored, targeted
checks passed and the entire browser gate was rerun. That run had two unexpected failures: another smoke form
hit the same baseline autofill sweep, and a double-click test clicked a detached ElementHandle after background
inspection rendered the section. Independent trace review confirmed the synchronous Undo handler never ran.
The double-click test now queries the connected control and clicks twice in one browser turn; it retains its
assertions and additionally checks the exact single revision increment and untouched sibling. Shared smoke
setup now waits for startup before opening forms. All three affected regressions passed eight repeats each
(24/24), followed by another entire browser gate against frozen runtime/test sources.
Static authority tests explicitly name the owner-approved adapter exception while forbidding existing Action
API modules from importing it. No expected-failure test was relabelled or claimed newly fixed.

The shared smoke setup now waits for the existing 800ms INIT autofill sweep before opening forms. An independent
isolated export of exact base `bb171a287ac67d76ae27634b5227bc24f66919de` reproduced
that sweep clearing a newly opened edit form; the production entry-editor and autofill blocks are unchanged.
This is a test-setup readiness correction with all assertions preserved, not a production fix. The underlying
startup draft-clear race remains an unrelated known limitation. All existing smoke assertions are preserved.

Independent review is supplied separately against the final local implementation SHA, so recording the verdict
does not change the candidate it reviews. No hosted CI or deployment is requested or implied by local gates.

## Exact implementation file manifest

45 files relative to contract checkpoint `df7c279ea730526314c2e97c7f6597674208b518`:

```text
CHANGELOG.md
CODEMAP.md
TASKS.md
TASK_018_IMPLEMENTATION_HANDOFF.md
TEST_REPORT.md
eslint.config.js
firebase.rules.json
functions/index.js
functions/shared/task-completion-model.js
functions/src/completion-api.js
functions/src/completion-domain.js
functions/test/authority-boundary.test.js
functions/test/completion-boundary.test.js
index.html
npm-test-wiring.test.js
package.json
personal-day-boundary-web-runtime.test.js
plan-authority.js
planning-continuity-ui.js
planning-continuity.css
scripts/firebase-rules-builder.mjs
scripts/functions-shared.mjs
storage.js
task-completion-emulator.test.js
task-completion-model.js
task-completion-performance.test.js
task-completion-repository.js
task-completion-sync.js
task-completion-sync.test.js
task-completion-test-support.js
task-completion.test.js
tests/calendar-native-plan-identity.spec.js
tests/planning-continuity-fixes.spec.js
tests/planning-continuity.spec.js
tests/smoke.spec.js
tests/task-completion.spec.js
tests/unfinished-ux.spec.js
www/index.html
www/plan-authority.js
www/planning-continuity-ui.js
www/planning-continuity.css
www/storage.js
www/task-completion-model.js
www/task-completion-repository.js
www/task-completion-sync.js
```

Pre-existing uncommitted `TASK_018_UX_PROPOSAL.html`, `design/task-018/A-REFINEMENT.md` and
`design/task-018/A-refined.css` are preserved separately and excluded. Prior contract/audit/mockup commits
remain intact. Generated screenshots/logs and disposable baseline reproductions are local ignored evidence.

## Cost and limits

Synthetic lower-bound observation, in-memory service/JSON work, not network latency, billing or live account fit:

| Tasks / room | Inspect room reads | Completion reads / PUT attempts with one sibling race | Total downloaded / attempted upload |
| --- | ---: | ---: | ---: |
|22 /0.5MiB |1 |3 /2 |2.10MB /1.05MB |
|100 /2MiB |1 |3 /2 |8.39MB /4.20MB |
|1000 /8MiB |10 |3 /2 |109.05MB /16.78MB |

The sibling race is preserved and the retry succeeds. Repeated contention refuses without partial writes.
Client inspection, verification refreshes and ten source/context listener namespaces add downloads beyond this
table. Resolved raw candidates remain observed so old-client aliases/edits can invalidate their projection.
Every later relevant plan/context event can inspect them again; the full-room cost is substantial at scale.

Other retained limitations:

- All14 pinned files belong to the single verified cf43080 release fixture, not14 distinct client releases.
  Its calendar/operational/legacy merge replay and real calendar SDK bridge cannot erase sibling resolutions.
  Old UIs still do not understand completion facts, and old-client edits may alter source evidence independently.
- Duplicates, moves/recovery aliases/locks, ambiguous origins, malformed authority, boundary/zone changes and
  unsupported representations refuse or surface needs-review. Ordinary byte-identical ID reuse remains an
  existing-model ambiguity. Conservative plan metadata changes can invalidate Undo or require review.
- Unseen remote edits cannot be predicted. Inspection/listener invalidation and CAS protect observed state;
  no background cache supplies independent completion authority. Cancelled source listeners refuse freshness
  until rebind/reload. Unsupported sparse/nested wire arrays may conservatively refuse source matching.
- Receipts are retained without pruning; eventual size/response refusal is explicit. Unknown writes may remain
  unresolved until an authoritative same-operation receipt is recovered; no false definite negative is invented.
- Existing Not doing/its session Undo retain TASK-017's legacy durability limits; this task adds no new dismissal
  persistence, deletion semantics or production cleanup. Brain Dump and Action API behavior remain unchanged.
- No deployed auth/IAM/revocation or service-account isolation proof, production traffic/cost measurement,
  physical Android/iOS testing, hosted CI or deployment verification. Functions dependencies were installed from
  the locked local cache; local Node24 differs from the declared deployed Node22 engine. SDK metadata import
  verified the dedicated service-account expression, region, maxInstances 1, concurrency 1 and 512 MiB memory.

Self-review/QA: code-health review passes for the bounded local implementation; no new planning authority;
historical/timer/entries algorithms untouched; new errors are explicit; title input/menu controls and mobile input
sizing verified. Required local functional/security/history/account/browser/emulator/generation/parity gates
pass as recorded above. Release remains ship-pending-human-review: physical-device usability, real-use acceptance,
deployment/IAM and live verified-auth review are unproved. These are recorded here under the owner's exact file
manifest rather than editing unrelated governance documents. Previous three dirty design
artifacts must remain unstaged. No merge, push, deployment, Firebase/IAM changes or real task writes are authorized.
