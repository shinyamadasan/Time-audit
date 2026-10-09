# Tasks

> **Handoff document.** Claude writes tasks; Codex checks them off.
> Tasks must come from an approved item in `planning/BUILD_QUEUE.md` (`source: BQ-<id>`) **or** an
> explicit owner instruction (`source: owner-direct`, which Codex may also record — see CLAUDE.md
> § Owner-Direct Tasks). Never from an agent's own idea.
> One task = one atomic, independently testable unit.

## Status legend

`todo` -> `codex` -> `in-progress` -> `review` -> `approved` / `done`

- `done`     = approved AND reversible -> auto-merged to main (see CLAUDE.md Risk-gated merge)
- `approved` = approved BUT red-zone   -> HELD, human merges after a glance
- `blocked`  = Codex hit an ambiguity; Claude must resolve before work continues

---

### TASK-001 - Fix silent no-op rework retry + stuck crashed-review state
status: done
review: Claude implemented directly (tools/Dispatch-Commands.ps1, tools/Run-Codex-Build.ps1 -- Codex
  cannot commit under tools/, same reasoning as this file's own Hard Rules). Held at `approved` for
  human `/merge`, not auto-merged -- this touches the AI Dev OS itself, which this project's own
  Risk-gated merge section lists as red-zone. No independent second set of eyes on this specific
  diff (same-session build+review), mitigated by an isolated 9-case fixture harness giving
  independent-of-the-author verification of the actual behavior. Both changed files parse clean.
  Land with `/merge TASK-001` then `/merge TASK-001 yes` when ready.
source: ported directly from the Meal Prep app (sibling project, same tools/Dispatch-Commands.ps1 /
  tools/Run-Codex-Build.ps1 template) after that app hit this bug live and fixed it as its own
  TASK-032/DECISIONS D-051 -- confirmed byte-for-byte identical before this change, so the same bug
  was latent here too
owner: codex
priority: P1
depends-on: none
files: tools/Run-Codex-Build.ps1, tools/Dispatch-Commands.ps1, DECISIONS.md

context:
  A rework retry can flip a task's TASKS.md status from `codex` to `review` without Codex actually
  changing any code (confirmed live on the Meal Prep app: a retry commit changed nothing but
  TASKS.md itself, and a must-fix security patch from a prior review was never applied). Separately,
  when the auto-chained review engine crashes (a known, occasional `claude -p` flakiness), the
  autopilot's classifier had no case for "review engine crashed, not a verdict" -- it fell into the
  generic `else` branch and got marked `blocked` with a note that doesn't match either of its own
  auto-release patterns (`waiting on merge of` / `strike N/3`), so a task could get permanently
  stuck the moment a crash happened, with the note itself claiming otherwise.

acceptance:
  - [x] `Run-Codex-Build.ps1`: before auto-chaining a build that reached `status: review` into
        review, verify it touched `CHANGELOG.md` or `TEST_REPORT.md` (AGENTS.md's own mandated
        evidence steps). If not, mark it `blocked` with a clear "no-op" note and skip the review
        chain entirely.
  - [x] `Dispatch-Commands.ps1`: factor the build/review outcome classification into one shared
        `Resolve-ReviewOutcome` function used by both the build loop and a new pending-review-resume
        step, so the two call sites cannot drift apart.
  - [x] Add a case recognizing the review-engine-crash signal ("Left at status: review for automatic
        retry") that sets `status: review` on main (not `blocked`), with no strike cap.
  - [x] Add a case recognizing the "build NO-OP" signal, reusing the existing `strike N/3`
        bounded-retry idiom REWORK already has.
  - [x] Fix a latent bug found while consolidating the classifier: a red-zone "APPROVED but HELD"
        review message contains the literal word APPROVED, so the old inline classifier would have
        matched it and marked the task `done` on main even though the branch was never actually
        merged. Now checked before the generic APPROVED match and routed to `status: approved`.
  - [x] Add a pending-review-resume step to `Invoke-Autopilot` so a plain `/go` resumes a task stuck
        at `status: review`, taking priority over starting a new build and counting as that
        mission's one action.
  - [x] The `/go` summary says `RETRYING:` (not `NEEDS YOU:`) for a self-healing crash retry.
  - [x] `DECISIONS.md` gains a numbered entry (this project's own plain-number convention, not
        Meal Prep's `D-NNN` style).

constraints:
  - Automation/OS-surface change: solo, never chained.
  - Red-zone surface (per this project's own Risk-gated merge rules) -- held at `approved`, never
    auto-merged.
  - No strike cap on the pure engine-crash retry case (unlike REWORK and the new no-op case, which
    both must stay bounded at 3).

test steps:
  - [x] `[System.Management.Automation.Language.Parser]::ParseFile` on both changed `.ps1` files: no
        syntax errors.
  - [x] Isolated fixture harness against `Resolve-ReviewOutcome`, extracted from THIS repo's own
        copy of the file (not assumed from the source fix): 5 representative cases / 9 assertions,
        all pass -- real auto-merge -> `done`; APPROVED-but-HELD -> `approved` (not `done`); REWORK
        -> strike incremented from a prior note; crash signal -> `status: review`, no strike; no-op
        signal -> `blocked` with strike recorded.
  - [ ] Live (human-verified): the next real crashed review or real no-op rework retry in this
        project's own production use resolves itself on the next `/go` instead of getting stuck. Not
        safely reproducible without spawning real codex/claude CLI processes against a live branch.

---

### TASK-002 - Fix unbounded digest length + silent 2-hour stale-lock wait
status: done
review: Claude implemented directly (tools/Generate-Digest.ps1, tools/Dispatch-Commands.ps1 -- same
  reasoning as TASK-001, Codex cannot commit under tools/). Held at `approved` for human `/merge`.
  Digest fix verified against the real, live-failing planning/PROPOSALS.md data (12 pending
  proposals): output is 3911 chars, under Telegram's 4096 limit, keeping every Approve/Park item.
  Lock fix verified via an isolated 4-case fixture test of the exact decision branching (dead PID,
  live PID + fresh timestamp, live PID + stale timestamp, live PID + just-under-threshold
  timestamp). Both files parse clean. Land with `/merge TASK-002` then `/merge TASK-002 yes`.
source: found live in the same session as TASK-001, while investigating a real Telegram delivery
  failure ("Bad Request: message is too long") and the automation.lock incident that led to TASK-001
priority: P1
depends-on: none
files: tools/Generate-Digest.ps1, tools/Dispatch-Commands.ps1, DECISIONS.md

context:
  Two separate reliability bugs. (1) `Generate-Digest.ps1` had no cap on the digest's length --
  with enough pending proposals (12, each carrying full reasoning text), the generated message hit
  ~5000 characters and Telegram rejected the send outright with "Bad Request: message is too long."
  The human got NOTHING that morning, not a partial digest, just silence. (2) Separately,
  `Dispatch-Commands.ps1`'s stale-lock check waited a full 2 hours before self-healing, and even
  then cleared silently. Confirmed live: a genuinely hung process (0% CPU, no log output since
  before it started, no working child process) sat holding `automation.lock` for 48+ minutes,
  completely invisible, until a human happened to check Task Manager and killed it by hand -- the
  queued `/merge` commands for TASK-001 sat stuck behind it the whole time.

acceptance:
  - [x] `Generate-Digest.ps1` builds the digest message incrementally and stops adding
        proposal groups/items before a safe character threshold (3700, leaving headroom for the
        fixed footer), appending a "+N more waiting ... see planning/PROPOSALS.md" note when
        truncated, rather than truncating the final joined string (which could cut a Markdown
        entity in half and trade one delivery failure for a different one).
  - [x] `Dispatch-Commands.ps1`'s lock check reads the lock file's recorded PID and checks whether
        that process is still actually running -- if it has already exited, the lock is stale
        regardless of age, no waiting required.
  - [x] If the recorded PID is still running, the staleness wait is lowered from 2 hours to 45
        minutes (comfortably above the ~35-40 min worst-case legitimate run: Run-Codex-Build.ps1
        caps its build step at 20 min, Run-Merge.ps1 caps npm test at 10 min).
  - [x] Clearing a stale lock now sends a Telegram notice through the existing OUTBOX/reply relay
        (`Write-Reply` + `Invoke-CommitPushWithRetry`, same mechanism every other command reply
        uses) instead of clearing silently, so a stuck run and a quiet one no longer look identical
        from Telegram.
  - [x] Does NOT auto-kill the lingering process -- only clears the lock file. The notice mentions
        `/stop` (which already kills the lock-holding process by PID) as the explicit,
        human-triggered way to do that if it keeps happening.
  - [x] `DECISIONS.md` gains a numbered entry.

constraints:
  - Automation/OS-surface change: solo, never chained.
  - Red-zone surface -- held at `approved`, never auto-merged.
  - Digest truncation must stop at item boundaries, never mid-string, to avoid breaking Markdown
    parsing on the Telegram side.
  - The stale-lock fix must not auto-kill any process -- clearing the lock file only; killing stays
    a human's explicit call via `/stop`.

test steps:
  - [x] `[System.Management.Automation.Language.Parser]::ParseFile` on both changed `.ps1` files: no
        syntax errors.
  - [x] `Generate-Digest.ps1` run against the real (live-failing) `planning/PROPOSALS.md`: output
        3911 chars, all 5 Approve items and both Park items kept, only the lowest-priority Reject
        items truncated with a count note.
  - [x] Isolated fixture harness against the lock decision logic (extracted from this repo's own
        copy): 4 cases / 4 assertions, all pass -- dead PID clears regardless of age; live PID with
        a fresh timestamp stays busy; live PID with a 46-minute-old timestamp clears; live PID with
        a 44-minute-old timestamp (just under the new 45-min threshold) stays busy, confirming no
        false positive right at the boundary.
  - [ ] Live (human-verified): the next real oversized digest sends successfully with a truncation
        note, and the next real hung process self-clears within 45 minutes with a visible Telegram
        notice, instead of requiring manual intervention.

### TASK-003 - Per-task scope note: flag builds that touch files their own task never declared
status: done
review: Claude implemented directly (tools/Run-Codex-Build.ps1, tools/Run-Claude-Review.ps1 -- same
  reasoning as TASK-001/002, Codex cannot commit under tools/). Held at `approved` for human
  `/merge` -- touches the AI Dev OS itself. Deliberately a SOFT gate, not a hard block: an adjacent
  file can be a legitimate dependency, so this only surfaces the mismatch to the reviewer instead
  of silently trusting them to notice it in a raw diff. Ported from the Meal Prep app's TASK-034/
  D-053 -- confirmed via direct diff that both changed files were functionally identical to Meal
  Prep's pre-fix versions before porting (Run-Claude-Review.ps1 byte-identical; Run-Codex-Build.ps1
  differed only in two comment lines). Verified via the same fixture harness re-run against this
  app's own copy of the ported functions (8/8 assertions pass). Both files parse clean. Land with
  `/merge TASK-003` then `/merge TASK-003 yes`.
source: comparison against github.com/cathrynlavery/codex-build (a similar Claude-orchestrates/
  Codex-builds skill) surfaced its `check_scope.py` per-task allowlist enforcer as something
  neither app had -- Run-Codex-Build.ps1's existing `$deniedPatterns` is a repo-wide deny-list
  (blocks the OS/automation surface outright) but never checked whether a build stayed inside the
  specific files ITS OWN task declared. Built in Meal Prep first as TASK-034/D-053, then ported
  here since both apps share the identical template file.
priority: P2
depends-on: none
files: tools/Run-Codex-Build.ps1, tools/Run-Claude-Review.ps1, .gitignore

context:
  The existing commit-scope guard in Run-Codex-Build.ps1 is a repo-wide deny-list: it blocks
  Codex/Claude from ever touching tools/, docs/, CLAUDE.md, etc., regardless of which task is
  running. That's the right tool for "never touch the OS itself," but it says nothing about
  whether a build stayed within the app-code surface its OWN task actually declared in TASKS.md's
  `files:` field -- e.g. a task that says `files: app.js` but also edits `style.css` sails through
  the deny-list untouched (CSS is legitimate app-code surface) with nothing flagging that the
  touch was never requested. The reviewer sees the raw diff, but nothing prompts them to
  cross-check it against the task's own declared scope.

acceptance:
  - [x] New `Get-TaskBlockText`/`Get-TaskDeclaredFiles` helpers parse a task's `files:` field
        (single-line and multi-line-continuation forms), stripping `(new)` annotations, returning
        `@()` (never a false "everything is out of scope") when the field is missing/unparseable.
  - [x] After the existing deny-list guard passes, Run-Codex-Build.ps1 computes the union of
        declared files across every tracked task in this invocation, and flags any changed file
        that is neither declared nor a standard evidence file
        (CHANGELOG.md/TEST_REPORT.md/TASKS.md).
  - [x] This is a SOFT gate: a mismatch never blocks the build or marks it blocked. It only writes
        a task-ID-tagged note to a new gitignored `.scope-note.txt` handoff file when reaching
        `status: review`.
  - [x] Run-Claude-Review.ps1 reads `.scope-note.txt`, uses it ONLY if the task currently under
        review is one of the ID(s) the note names, and always deletes the file after reading
        regardless of match so nothing can leak into a later run.
  - [x] When present, the note is folded into the Claude reviewer's prompt as an explicit item.
        The Codex-as-reviewer fallback path does not receive this signal, consistent with its
        existing documented degraded-capability status.
  - [x] `.scope-note.txt` added to `.gitignore`, matching `.last-phase-result.txt`'s existing
        transient-handoff-file convention.

constraints:
  - Automation/OS-surface change: solo, never chained.
  - Red-zone surface -- held at `approved`, never auto-merged.
  - Must never become a hard block -- false positives (a legitimate adjacent-file touch) are
    expected and must not stall a real fix.

test steps:
  - [x] `[System.Management.Automation.Language.Parser]::ParseFile` on both changed `.ps1` files:
        no syntax errors.
  - [x] Direct diff against Meal Prep's pre-port versions confirmed both files were functionally
        identical before this change (Run-Claude-Review.ps1 byte-identical; Run-Codex-Build.ps1
        differed only in two comment lines referencing the other app's name).
  - [x] Fixture harness against `Get-TaskBlockText`/`Get-TaskDeclaredFiles`, re-run against this
        app's own copy of the ported functions: 8/8 assertions pass.
  - [ ] Live (human-verified): a real build that touches an undeclared file produces a visible
        scope note in a real REVIEW.md entry, in production.

---

### TASK-004 - Owner-direct task governance (docs-only)
status: done
review: Claude implemented directly (docs-only, Claude-owned files). Independent strict review PASSED
  on 4f5704ed0c8d28428e0992312c5da57d576d96bb (as reported by the owner); owner explicitly approved
  integration. Red-zone (touches the AI Dev OS itself), so held at `approved` for the human-confirmed
  /merge (tools/Run-Merge.ps1), which sets `done`. Until it is merged to main, TASK-005 is recorded
  but not yet actionable.
owner: claude
source: BQ-001
priority: P1
depends-on: none
files: CLAUDE.md, AGENTS.md, TASKS.md, planning/BUILD_QUEUE.md, WORKFLOW.md, AI-DEV-OS.md, SYSTEM-OVERVIEW.md, DECISIONS.md, tools/Task-Gating.ps1 (new), tools/Dispatch-Commands.ps1, tools/Run-Codex-Build.ps1, scripts/task-gating.test.js (new), scripts/firebase-rules-builder.mjs (parity-check line-ending fix only), scripts/firebase-rules-builder.test.js (new), package.json (test wiring only)

context:
  Integration-gate fix: `npm test`'s rules-parity step failed on a Windows (core.autocrlf=true) checkout
  because the builder compared raw strings (CRLF artifact vs LF output). The check now ignores ONLY
  CRLF-vs-LF; firebase.rules.json and the generated rules are unchanged.
  Review follow-up (GOV-001/GOV-002): the strict review found the manual builder skipped dependency
  checks and unattended /go could run owner-direct tasks; fixed by the shared tools/Task-Gating.ps1
  (execution gating only; see DECISIONS #35).
  Today every Codex task must originate from an approved `planning/BUILD_QUEUE.md` item, so an
  explicit, fully specified owner instruction still needs a manual Claude relay before work can
  start. Owner approved removing that bottleneck for owner-direct tasks only, while keeping the
  invariant that agents must not self-authorize work. Implemented directly by Claude (these files
  are Claude-owned; Codex may not edit CLAUDE.md, docs/ or planning/).

acceptance:
  - [x] CLAUDE.md, AGENTS.md, TASKS.md, planning/BUILD_QUEUE.md, WORKFLOW.md, AI-DEV-OS.md and
        SYSTEM-OVERVIEW.md support two valid task sources — approved BUILD_QUEUE item, or explicit
        owner-direct instruction — with no contradiction about who originates, who records, or the
        BUILD_QUEUE role. (DECISIONS #35 records the decision.)
  - [x] An agent cannot label its own idea owner-direct; ambiguous/under-specified requests stop and ask.
  - [x] Preflight, git safety, testing, review, risk-gated merge, deploy and destructive/production
        authorization rules are unchanged.

constraints:
  - Docs plus the bounded GOV-001/GOV-002 execution-gating fix in tools/: no product/runtime code, no
    deploy, no push, no Firebase/production mutation.
  - Red-zone (touches the AI Dev OS itself): held at `approved` for the human merge, never auto-merged.

test steps:
  - [x] `git diff --check`
  - [x] Re-read every modified governance file; confirm no contradiction.

---

### TASK-005 - ChronaSense Action API — Phase A1: backend/auth foundation + read-only `get_brain_dump`
status: done
owner: codex
source: owner-direct
priority: P1
depends-on: TASK-004
files: functions/ (new: Firebase Functions v2 HTTPS backend, its package.json, tests, README), scripts/firebase-rules-builder.mjs, firebase.rules.json (GENERATED via `npm run build:firebase-rules` only), firebase.json (functions entry only), package.json (only to wire new tests into `npm test` per npm-test-wiring.test.js), firebase-rules emulator/test files as needed for private-path denial proofs, CHANGELOG.md, TEST_REPORT.md

context:
  Owner-direct instruction (repository owner, 2026-10-06): establish ChronaSense Action API Phase A1.
  Base: integrated architecture at b936eae87cb92e1e71d2479f8878b9f5b780af97 (design/chronasense-action-api-v1
  == origin/main at the time). Authoritative contracts — follow them exactly, do not reinterpret:
  `docs/CHRONASENSE_ACTION_API_V1.md` (esp. §1–§7, §10 `get_brain_dump`, §12–§15),
  `contracts/CHRONASENSE_ACTION_PROVENANCE_V1.md`, `contracts/CHRONASENSE_EVIDENCE_CONTRACT_V1.md`
  (semantic authority; a read creates no life evidence and no command receipt). This is Phase A only of
  §14; phases B–E are separate tasks and not authorized here. Goal: a reviewable, locally tested
  backend foundation plus the first read-only vertical slice.

acceptance:
  - [ ] Firebase Functions v2 HTTPS backend foundation in `asia-southeast1` (not deployed).
  - [ ] HMAC-SHA-256 service authentication exactly per §2: canonical signing tuple, key ID,
        service identity `chronasense-plugin-worker-v1`, constant-time compare, body-hash check,
        300-second freshness, canonical-path / duplicate-header / unknown-key / unknown-service
        rejection; all failures reject before any domain read.
  - [ ] Exact owner subject → single configured Firebase UID binding; `roomId = "uid_" + firebaseUid`;
        no caller-supplied subject/UID/room/path/account is ever accepted or influences identity;
        missing/mismatched mapping fails closed.
  - [ ] Private request-nonce infrastructure (`serverRequestNonces/<service-or-owner>/<requestId>`):
        atomic create-if-absent after the freshness check, duplicate fails closed, ~10-minute
        retention/cleanup. Transport replay protection only.
  - [ ] Private receipt infrastructure FOUNDATION (`serverActionReceipts/<firebaseUid>/<actionId>`):
        storage module, canonical request hashing (RFC 8785 JCS, SHA-256) and state-machine types
        sufficient for later phases, claimed only by Admin-only infrastructure access. No command
        execution; reads create no receipt.
  - [ ] User-scoped Firebase domain access: Admin SDK only to validate the configured UID, mint the
        custom token, and manage nonces/receipts; domain reads go through the exchanged short-lived ID
        token via authenticated RTDB REST so existing rules stay enforced. No silent fallback to Admin
        domain access (else STOP — AUTHORITY BOUNDARY VIOLATED). Tokens never leave the backend.
  - [ ] `get_brain_dump` ONLY (scope `chronasense:read`): typed captures + allowed dispositions,
        revisions (`rev1:` opaque, with the documented field projection) and IDs; no claims/fence
        internals, no raw RTDB snapshot or path; typed errors per §12; a timeout/unknown is never
        reported as absent.
  - [ ] Envelope per §5: JSON/UTF-8, 64 KiB cap, unknown fields rejected, `contractVersion: 1`,
        response carries `requestId`, typed `result`, `authority`.
  - [ ] `scripts/firebase-rules-builder.mjs` gains explicit server-private nodes/denies for
        `serverActionReceipts` and `serverRequestNonces` (`.read = false`, `.write = false` for normal
        clients, no broader wildcard granting access); `firebase.rules.json` regenerated by the
        builder (never hand-edited); rules drift check passes; emulator/rules tests prove an
        authenticated owner client cannot read or write either path while the privileged server
        mechanism can.
  - [ ] Tests for every item above, including negative/attack cases (bad signature, replay, stale
        timestamp, body tamper, wrong subject, caller-supplied uid/room/path, Admin-fallback attempt),
        wired into `npm test`; `npm test` passes; documentation (functions README: config/secrets
        names, local run, test instructions, explicit "not deployed") and the CHANGELOG/TEST_REPORT
        evidence entries.

constraints:
  - Scope is EXACTLY the list above. Out of scope and forbidden: deployment of anything (functions or
    rules); any domain WRITE (only server-private nonce/receipt infrastructure writes are allowed);
    any Cloudflare/Worker/MCP/OAuth implementation; any generic/arbitrary Firebase API, tool, or path
    parameter; any other tool (`get_today`, `get_plan`, `get_item`) or any command (`brain_dump_*`,
    `plan_*`); actual-log/evidence writes; browser/app/www/runtime code changes; reading real secrets or
    production data; running anything against production Firebase (emulator/local only).
  - Do not broaden scope or invent tasks. An adjacent improvement you notice is reported in the
    CHANGELOG entry, never built.
  - Secrets never enter code, logs, fixtures or commits; use named config/secret references only.
  - Read CODEMAP.md first; never read index.html in full. Never hand-edit `firebase.rules.json`.
  - Stop (set `status: blocked` with the exact blocker) on any condition in
    `docs/CHRONASENSE_ACTION_API_V1.md` §15, or if a required Firebase operation cannot be expressed
    with user-authenticated RTDB REST semantics, or if satisfying the task seems to need a deploy, a
    domain write, or an Admin domain bypass.
  - Solo task: never chained. Red-zone (auth, security, Firebase rules): when reviewed, held at
    `approved` for the human merge — never auto-merged; deployment (rules first, then anything else)
    is a separate, separately authorized step.

test steps:
  - [ ] `npm test` (includes `node scripts/firebase-rules-builder.mjs` drift check and
        `npm-test-wiring.test.js`)
  - [ ] Emulator proof of owner-client denial on both private paths (`npm run test:rules-emulator` /
        project's existing emulator flow; if the emulator cannot run, say so in TEST_REPORT.md)
  - [ ] Functions package unit tests, run locally (no network to production)
  - [ ] `git diff --check`

---

### TASK-006 - ChronaSense Intelligence V1
status: done
owner: codex
source: owner-direct
priority: P1
depends-on: TASK-004
files: intelligence-read-model.js (new), intelligence-ui.js (new), intelligence-read-model.test.js (new), tests/intelligence.spec.js (new), personal-day-boundary-web-runtime.test.js (release generation only), tests/calendar-native-plan-identity.spec.js (release-token expectation only), scripts/runtime-mirror.mjs (versioned-import physical-path resolution only), scripts/runtime-mirror.test.js (regression for that blocker), index.html (Today read context/rendering and Intelligence mount/module include only), style.css (Intelligence styles only), storage.js (read surface account reset/refresh only if required), package.json (test wiring only), eslint.config.js (new module lint wiring only), CODEMAP.md (new Intelligence section only), www/ (generated runtime mirror only), CHANGELOG.md, TEST_REPORT.md, INTELLIGENCE_V1_HANDOFF.md (new)

context:
  Owner-direct authorization, 2026-10-07: the owner's ChronaSense Intelligence V1 Goal Mode
  instruction and explicit continuation authorize this complete bounded milestone. Current integrated
  base: 2a4863d3781f5fac45ab7bf3c4f98ff8988b237a, containing TASK-004 owner-direct governance.
  Interactive/manual only; no Execution: Chained header. Unattended /go and /build must refuse it.
  Goal: useful deterministic read-only intelligence from existing authoritative life records.
  Authority chain: Source -> Evidence -> Interpretation -> Validation -> Domain Authority ->
  Timeline / Intelligence. Derivations never become canonical life truth or a universal event store.
  Inspect live Plan Authority/calendar identity, Brain Dump, commitments, routines, Focus/timer,
  actual/evidence, existing reporting, account isolation, time helpers and tests before implementing.

acceptance:
  - [ ] Useful Today/Attention shows supported unresolved, overdue or slipping commitments and planned
        items lacking known actual evidence, without invented obligation semantics.
  - [ ] Plan-vs-actual distinguishes plans, explicit completion, known linked actuals, unplanned actuals
        and unknown/gap. Missing actual evidence never proves an item did not happen.
  - [ ] Open loops reflect existing unresolved Brain Dump, commitments and authoritative pending states;
        completed/resolved items are excluded, claim ambiguity remains visible.
  - [ ] At least one useful recent/longitudinal pattern is deterministically supported by actual records,
        with explicit window/thresholds and provenance; no fabricated incompletion or streak.
  - [ ] One small coherent read-only UI fits the existing product and distinguishes facts, derived
        statuses, unknown/gap and patterns where material. No whole-app redesign or second ranker.
  - [ ] Pure recomputable derivation and normalized read inputs are separate from UI handlers; no LLM,
        persistent intelligence truth, input mutation, canonical writes or arrival-order truth selection.
  - [ ] Stable IDs, deterministic ordering, equal-authority ambiguity and malformed/missing inputs fail
        safely. Existing account isolation, authoritative plan targets and timezone semantics are preserved.
  - [ ] Required gates pass; adversarial self-review is recorded; candidate is clean and committed;
        strict-review handoff includes exact base/candidate SHAs, files, contracts, time, checks, limitations
        and review hotspots. Candidate is not integrated automatically.

constraints:
  - Owner-defined stop conditions: genuine owner/product/architecture/authorization invariant requiring
    input; required external credential/service blockage; or session/quota end (leave a clean committed
    resumable checkpoint with exact SHAs, checks, remaining priorities and continuation prompt).
  - No deployment, production mutation, destructive migration, Cloudflare/Phase B, ChatGPT write tools,
    autonomous planning, closed Brain Dump promotion redesign, calendar identity redesign, or authority replacement.
  - Read CODEMAP before code; never read index.html in full. Reuse canonical date/time/account helpers.
  - Preserve all Hard Rules, existing domain writes and the current mechanical/Next recommendation authority.
  - Read-only life record selectors may expose provenance internally; absence is neither deletion nor failure.
  - Update only this owner-direct TASKS entry; no BUILD_QUEUE bootstrap or other governance edits.

verification:
  - [ ] Unit invariants: empty account, plans without actuals, actuals without plans, unresolved/resolved
        captures/commitments, deterministic ordering, duplicates/conflicts, malformed sources, account isolation,
        unknown vs negative fact, pattern thresholds, midnight/date/timezone/DST boundaries where applicable.
  - [ ] Browser checks: fact/derived/unknown/pattern UI, safe escaping, fresh record changes, account switch/signout
        clearing, no source writes from the Intelligence read, mobile layout.
  - [ ] npm test; npm run test:smoke; targeted and full relevant Playwright; npm run lint;
        npm run check:www-parity; npm run check:firebase-rules; npm run test:fence; git diff --check.
  - [ ] SELF_REVIEW.md Code Health and QA.md applicable AI gates; record human device checks as pending.

---

### TASK-007 - Make the Partner View scheduled auto-log smoke fixture day-stable
status: done
owner: codex
source: owner-direct
priority: P1
depends-on: none
files: tests/partner-view.spec.js, TASKS.md, CHANGELOG.md, TEST_REPORT.md

context:
  Owner-direct authorization, 2026-10-08: restore trustworthy hosted CI on current production main
  without changing Partner View semantics. GitHub Actions CI run 37811850639 on base
  8193a90c6eddebf6d9392d5ba2ac27c00315182e failed only
  tests/partner-view.spec.js — the scheduled auto-log Partner View smoke test expected "Scribe shift"
  but the current-day timeline was empty. At the failure time (about 2026-10-08 17:02 UTC), the
  Asia/Manila publisher day had crossed midnight; the fixture used Date.now()-60/120 minutes and
  seeded yesterday's entry. Fix test determinism only unless direct evidence establishes a product
  defect. Do not touch Intelligence V1 absent direct causation evidence.

acceptance:
  - [ ] Record the precise runner timezone, test/assertion, expected/actual, retries, and date-boundary
        root cause from the hosted run; distinguish runner timezone from account timezone.
  - [ ] Make the focused Partner View scheduled auto-log test deterministic under UTC runner settings
        and the reported Manila-midnight boundary using canonical date/time helpers.
  - [ ] Preserve the assertion and Partner View product semantics; do not skip, weaken, retry, or sleep.
  - [ ] Focused Partner View test passes repeatedly and under CI-equivalent timezone/time settings.
  - [ ] Relevant Partner View/unit/browser tests and full Playwright gate pass; no Intelligence V1
        regression; no deployment or backend changes.
  - [ ] Candidate is committed cleanly on task-007 and ready for review/integration.

constraints:
  - Use current origin/main at 8193a90c6eddebf6d9392d5ba2ac27c00315182e; inspect any base delta first.
  - Change test setup only unless evidence proves a smallest product defect; no Intelligence V1 changes
    without direct causal evidence.
  - No test skips, weakened assertions, arbitrary sleeps, retry increases, deployment, backend changes,
    or production mutations.
  - Owner-direct scope is limited to tests/partner-view.spec.js and this task's TASKS.md entry plus
    required CHANGELOG.md and TEST_REPORT.md evidence.

verification:
  - [ ] Re-run the exact focused test repeatedly, including controlled UTC / 00:52 Asia/Manila boundary.
  - [ ] Run the Partner View model and related accountability/browser tests.
  - [ ] Run npm test and npm run test:smoke (full required Playwright gate).
  - [ ] Run relevant additional QA checks and git diff --check; complete SELF_REVIEW.md and QA.md.
  - [ ] Obtain hosted GitHub Actions green on the candidate; if inaccessible, report exact external blocker
        after local CI-equivalent proof.

blocker:
  Resolved 2026-10-08: authenticated run 37811850639 logs confirmed the exact Partner View assertion
  (expected "Scribe shift", actual current-day timeline empty), one failure with no retries, and the
  UTC GitHub-hosted Ubuntu runner versus the account's Asia/Manila publisher day. The previous
  Date.now()-120m fixture started on the prior publisher day and was excluded by canonical tsStart
  day-keying. Candidate PR run 37853241261 passed on 3ad55dadfd91222ec9c8d1672ff1b9aa84d588f2;
  PR #1 merged as ff04347bf772bc67618b55fd2607da8102a99c4b. GitHub Pages deployment and signed-out
  production smoke succeeded; post-merge CI also passed.

---

### TASK-008 - CI stability sweep: pair-claim reload + wife-shared unlink smoke flakes
status: done
owner: codex
source: owner-direct
priority: P1
depends-on: none
files: tests/pair-accountability.spec.js, tests/wife-shared-accountability.spec.js, TASKS.md, CHANGELOG.md, TEST_REPORT.md

context:
  Owner-direct authorization, 2026-10-08/09 ("ChronaSense — CI STABILITY SWEEP", re-confirmed in the
  recovery instruction after an interrupted session): eliminate the two known unrelated hosted smoke
  flakes without changing product semantics, on production main
  e35ed20cc858ab4ccd1ea2ab439181a3661c4a43. Hosted CI run 37863426417 on e35ed20 failed only
  (1) tests/pair-accountability.spec.js:253 "F2 — pending claim survives a creator reload" (30.0s
  test timeout at the post-reload waitForFunction(_pendingPairClaim === 'bob'); it normally passes
  in ~3s), and (2) tests/wife-shared-accountability.spec.js:342 "unlink clears the partner card
  immediately" (partnerShared still held Alice's full payload when read; the same failure also
  occurred in run 36254429147). TASK-007 is done and is not reopened.
  Process note: the task-008 worktree (from origin/main e35ed20) and a temporary, uncommitted
  investigation spec (tests/zz-diag.spec.js) were created during the interrupted session BEFORE this
  entry was recorded; this entry was recorded on resumption. The diagnostic file is investigation-only
  and is removed (or folded into a canonical spec) before commit.

acceptance:
  - [x] Root cause of each flake established: the async/state transition involved, whether product
        behavior is correct, whether test synchronization is wrong, whether a real production race
        exists, and the deterministic completion signal the test should wait for.
  - [x] Each test waits for authoritative observable state, not elapsed time or rendered text that
        does not prove the state transition.
  - [x] Product semantics unchanged unless a real defect is proven (then smallest fix + regression test).
  - [x] Both focused tests pass repeatedly, including under the parallel load that reproduced them.
  - [x] Surrounding Partner View / shared-accountability suites, full Playwright smoke, npm test and the
        Firebase fence/rules gates pass; candidate hosted PR CI passes; clean committed candidate.

constraints:
  - No arbitrary sleeps, timeout increases or retries as the fix, no skips, no weakened assertions.
  - Do not change unlink semantics merely to satisfy the test.
  - No deployment, no production/Firebase mutations, no backend or rules changes.
  - Scope limited to the two spec files above (plus product code only if a real defect is proven),
    this task's TASKS.md entry, and required CHANGELOG.md / TEST_REPORT.md evidence.

verification:
  - [x] Focused tests with --repeat-each under multi-worker load (the reproducing configuration).
  - [x] Partner View / pair / wife-shared specs; npm test; npm run test:smoke; npm run test:fence.
  - [x] git diff --check; hosted GitHub Actions green on the candidate PR.

stop conditions:
  - STOP — PRODUCT DEFECT REQUIRES REVIEW if a real production race/defect is proven that needs more
    than the smallest fix; STOP — INVARIANT DIFFERED if base/governance state differs from the above.

---

### TASK-009 - Conversational Read V1
status: review
owner: codex
source: owner-direct
priority: P1
depends-on: TASK-005, TASK-006
files: functions/src/ (typed read queries and user-scoped collection allowlist), functions/shared/ (generated pure domain modules), functions/test/ (read adversarial tests), functions/README.md (read contract), scripts/functions-shared.mjs, workers/chronasense-conversational-bridge/ (new canonical read-only OAuth/MCP Worker and tests), .github/workflows/ci.yml (Worker test gate), TASKS.md, CHANGELOG.md, TEST_REPORT.md, CONVERSATIONAL_READ_V1_HANDOFF.md (new)

context:
  Owner-direct instruction, 2026-10-09: implement a read-only conversational milestone from live
  origin/main a32dae209d1a95a13d9df832a7177992cfff205a. Preserve TASK-005 authentication,
  identity, replay, response-limit and user-scoped read boundaries and TASK-006 interpretation semantics.
  Prepare the canonical Cloudflare Worker locally; an untracked local spike is reference only.

acceptance:
  - [x] Typed useful get_brain_dump, get_today, get_plan, get_item and get_intelligence read contracts, or a documented smaller coherent set based on actual source authority.
  - [x] Plan/calendar identity, account/time semantics, stable IDs, absence/unknown and provenance remain accurate; Intelligence interpretation is recomputed, never canonical truth.
  - [x] Worker exposes only read-only MCP tools with OAuth, Access subject binding, per-tool scope checks, HMAC to the existing Action API and no Firebase/path passthrough.
  - [x] Adversarial backend and Worker tests cover authentication, scope, replay, malformed and contradictory data, identity, time boundaries, deterministic ordering, Unicode/size and read-only boundaries.
  - [x] Required repo gates and available hosted CI pass; clean committed candidate and strict-review handoff. No integration or production mutation.

constraints:
  - No deployment, production config/secrets, Access mutation, RTDB mutation, write tools or generic data access.
  - CHRONASENSE_OWNER_SUBJECT must come from the real Access JWT sub during deployment; local fixtures only in tests.
  - User instruction controls this owner-direct task's scope; changes stay surgical and preserve existing source authority.

verification:
  - [x] Targeted backend and Worker tests, npm test, npm run test:smoke, npm run lint, npm run check:www-parity, npm run check:firebase-rules, npm run test:fence, git diff --check.
  - [x] SELF_REVIEW.md Code Health and QA.md applicable AI checks; hosted CI if available without production deployment.

---

<!-- Paste new tasks above this line. -->

<!-- TASK TEMPLATE -- copy and fill:

### TASK-001 - <short title>
status: codex
owner: codex
source: BQ-<id>   (or `owner-direct` for an explicit owner instruction; see CLAUDE.md)
priority: P2
depends-on: none
files: index.html (CODEMAP section: <name>), storage.js

context:
  <what exists today, which CODEMAP section, why this change>

acceptance:
  - [ ] criterion 1
  - [ ] criterion 2

constraints:
  - Read CODEMAP.md first; never read index.html in full
  - <hard-rule constraints that apply>

test steps:
  - [ ] npm test
  - [ ] SMOKETEST.md items touched by this change

-->
