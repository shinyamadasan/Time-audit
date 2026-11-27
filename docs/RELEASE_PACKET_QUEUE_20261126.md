# Release packet — QUEUE-20261126 (TASK-041 accounting + TASK-045 durability on Household main)

Status: **ready for owner review. NOT approved, NOT pushed, NOT merged, NOT deployed.**
Prepared 2026-11-26 by Claude (TASK-048). The docs in this packet were written from raw evidence that was
read back directly. Where no raw evidence was found, the claim is marked **UNVERIFIED** and kept in.

This release is **not storage-safe**. See §3.1 before you approve anything.

Evidence root used throughout: `$E` = `D:/ChronaSenseQualificationEvidence/20261126-queue`.
Worktree: `$W` = `C:/Users/DevLabs-Test/.t3/worktrees/Time-audit/task-044-durability-integration`.

---

## 1. Candidate

| Item | Value |
|---|---|
| Branch | `task-044-durability-integration` (local only; upstream is configured as `origin/main`, so never run a bare `git push`) |
| Candidate SHA (qualified) | `da5c4d493af5908cd2c7e27547eba0519b3e149f` |
| Runtime/artifact SHA | `120dba59365330233f7ee95d8defbe9ff6caca3e` (release artifacts were built from this commit) |
| Base | `origin/main` `0ff39ec10508b283aa5bd2b3c608080a6b4fc08c` (Merge PR #27, Household My Day). `git ls-remote origin refs/heads/main` returned this SHA on 2026-11-26. It is also the merge-base of the candidate. |
| Commits since base | 27 (list below) |
| Branch head after this packet | da5c4d4 plus docs-only TASK-048 commits (see §4b) |

### 1.1 The runtime is byte-identical between the artifact build (120dba5) and the candidate (da5c4d4)

`git diff --stat 120dba5 da5c4d4` touches only these files:
`.github/workflows/ci.yml` (TASK-046 pins), `CHANGELOG.md`, `CODEMAP.md`, `DECISIONS.md`, `REVIEW.md`, `TASKS.md`,
`TEST_REPORT.md`, `scripts/life-ledger-sync-worker.mjs`, `scripts/life-ledger-sync-worker.test.js` and
`tests/accounting-staged-effects.spec.js`.

`git diff --stat 120dba5 da5c4d4 -- www android capacitor.config.json firebase.json firebase.rules.json '*.html' '*.js' '*.css' sw.js ':!tests' ':!scripts' ':!workers'`
prints nothing (exit 0). So `www/`, every root runtime file, `capacitor.config.json`, `firebase.json` and
`firebase.rules.json` are unchanged.

`scripts/life-ledger-sync-worker.mjs` is a local scheduled script on the PC. It is not in `www/`, so it is
not in the web bundle or the APK. The web bundle and APK built at 120dba5 therefore still represent the
candidate. **No packet blocker from runtime drift.**

### 1.2 What changes for the user (relative to live main 0ff39ec)

Relative to 0ff39ec, the runtime diff covers only `accounting-command.js` and `index.html`, plus their
`www/` mirrors. `storage.js`, the rules, the service worker and the Household files are unchanged.

- **Household My Day: already live on main.** It stays opt-in at `?household=1`, and this release does not
  change it. Meal Prep activation is not included.
- **Accounting recovery (TASK-041, DECISIONS #44).** Some devices hold an old "orphan heartbeat" record that
  points at a Start saved only in local intake. Today that state blocks accounting. The new code repairs this
  one known case under the account lock and keeps every original fact. The page may stay paused until reload
  or sign-in. Files: `accounting-command.js` (+56/−2 lines).
- **Storage durability (TASK-045, DECISIONS #45).**
  - Settled ordinary Start/Stop and read-only hydrate history is archived to IndexedDB once the local
    accounting store passes 3 Mi characters. A record leaves the store only after its archived copy has been
    read back and matches.
  - When storage is full, the app no longer says "kept safely on this device" unless that is true. Changes
    held only in the open page show their real count: "N accounting change(s) is/are held in this page.
    Keep this page open while storage recovers."
  - In a browser, leaving the page triggers a "leave site?" warning. The app retries the held change with its
    original id, input and time.
  - Files: `accounting-command.js` (+10/−2 lines) and `index.html` (+53/−22 lines).
- **Focus test fix (TASK-047).** Test only, with no app change. A required-CI Focus test raced a ~90 ms UI
  window. It now holds the Stop before it reaches the server.
- **Life Ledger lock fix (TASK-049, DECISIONS #46).** This is the local PC sync worker, not the app. Two
  scheduled runs could both take the stale-lock "authority" at once. Locks are now published by hard link
  and removed only after an identity check.

### 1.3 Commits since base (oldest first)

```
1fd669e test(accounting): TASK-041 checkpoint blocked recovery investigation
b18cc52 fix(accounting): TASK-041 recover historical orphan observations under owner lock
2ff79d9 test(task-042): reconcile fixture paths and retained quota expectations
835f182 test(task-042): stabilize qualification fixtures and refresh artifact expectations
cbdb472 docs(task-042): record qualified gates and Android toolchain boundary
c7c6eb9 docs(task-042): close baseline quota attribution without waiving CI
a5de93e docs(task-042): November26 real APK qualification, superseding Stop attribution, NO-GO record
9eb6cf2 merge(task-044): integrate TASK-041 runtime + TASK-042 qualification (a5de93e) onto Household main 0ff39ec
48d9c92 docs(queue): record owner-authorized QUEUE-20261126 (TASK-044..048)
6029be3 docs(task-044): combined-tree baseline passes; queue dependency rule; TASK-045 ready
21daca4 docs(accounting): record TASK-045 quota diagnosis and preservation approach
c2b6f95 fix(accounting): preserve captures at local storage quota (TASK-045)
120dba5 review(task-045): independent APPROVE WITH NOTES, held approved; record archive-scope limit; TASK-046 ready
0dc2a07 ci(task-046): refresh release-artifact pins and wider count for the combined TASK-044/045 tree
fc29b2c docs(task-046): combined-tree qualification evidence; TASK-046 to review
8e8ece9 review(task-046): independent APPROVE, held approved; Focus flake pre-existing, routed to TASK-047
3d8c9f9 test(task-047): hold the Focus terminal Stop before it reaches the emulator
c18bb2a docs(task-047): required-CI reproduction, Focus flake proof, archive warm-up correction; TASK-047 blocked
b227889 docs(queue): TASK-049 Life Ledger worker stale-lock race (unblocks TASK-047)
015c298 fix(life-ledger-worker): a stale-lock takeover removes only the generation it judged (TASK-049)
806854c docs(task-049): evidence for the stale-lock fix; TASK-049 to review
cd2032f review(task-049): round 1 changes required
14aeefc fix(life-ledger-worker): a lock or claim never exists empty, and removal checks file identity (TASK-049 r2)
50d909b docs(task-049): round-2 evidence; TASK-049 to review
49907ae review(task-047): independent APPROVE WITH NOTES for the Focus Stop test fix
9db0bf5 review(task-049): round 2 independent APPROVE, held approved; correct DECISIONS #46 identity wording
da5c4d4 test(task-047): unit job green x3 on 9db0bf5 after TASK-049; TASK-047 approved (held); TASK-048 ready
```

### 1.4 Artifacts (built from 120dba5)

| Artifact | Value | Raw evidence |
|---|---|---|
| Debug APK | `$E/task-046/release-02/chronasense-debug.apk`, SHA-256 `f99b5a80d1ae879df0e711586f5ae05f6d9abb38e18f42fcff69c5a17eaf8dd6`, 5,967,177 bytes (re-hashed for this packet with `sha256sum`) | the file itself; `$E/task-046/release-02/release-manifest.json` |
| Release manifest | SHA-256 `74ade476802991fd4e927e8767d99c917c6476b6ea45cd9e4e3a41e2f041505b`, `"commit": "120dba59…"` | `$E/task-046/release-02/release-manifest.json` |
| Web tree | `bf81c9e5a021283fe158eb2ee8290da7bda9ef55b0f6dfa3554c421659ee1dfe` (111 files) | `$E/task-047/gates/packaged-pins-r2.log`, `$E/task-046/review/VERDICT.md` §1 |
| Android bundle tree | `6c73eb28dafbcf96bfff878e94f158ac1433f723b413d4eed4a884870188c275` | same |
| Rules SHA-256 | `93f0a77424e730aa5996825af4183e0d42d5f29251260b8f85eea3756645be00` (unchanged from main) | same |
| Signer | one v2 "Android Debug" signer; cert SHA-1 `d2458c8b7ed318c55b821aa8b6b0ea47897b1913` | `$E/task-046/apk-signature.log`, `$E/task-046/review/apksigner.log` |

The APK hash is specific to this build environment and debug key. It cannot be reproduced from Git alone.

---

## 2. Gate table

"Tree" is the commit each gate ran on (c2b6f95, 120dba5, fc29b2c, 3d8c9f9, 50d909b or 9db0bf5). Every one of these
has the same runtime as da5c4d4 (§1.1; c2b6f95→120dba5 and 120dba5→fc29b2c change only docs and CI pins). The only non-doc changes after 3d8c9f9 are the Life Ledger worker and its test.
The unit job reran on 9db0bf5 and covers both. 9db0bf5 → da5c4d4 changes only `TASKS.md` and `TEST_REPORT.md`.

| # | Gate | Tree | Result | Raw evidence |
|---|---|---|---|---|
| 1 | `npm test` (unit job), 3 consecutive runs after TASK-049 | 9db0bf5 | **PASS ×3**: exit 0 each. Node runner 2,567 passed, 0 failed, 1 existing opt-in skip. Custom 455 passed, 0 failed. (Summed from the `ℹ pass/fail/skipped` lines in each log for this packet.) | `$E/task-047/unit-rerun-9db0bf5/npm-test-{1,2,3}.{log,exit}`, `head.txt` |
| 1a | Rest of the unit job: www-parity/mirror, lint, rules builder, functions-shared | 9db0bf5 | PASS (exit 0). Lint has 0 errors and 172 baseline warnings. | `$E/task-047/unit-rerun-9db0bf5/{mirror,lint,rules-builder,functions-shared}.{log,exit}` |
| 1b | `npm test` before TASK-049 (history) | 3d8c9f9 | Failed 1 of 3 runs on the Life Ledger lock race. That race was fixed by TASK-049 (#11). | `$E/task-047/gates/npm-test{,-r2,-r3}.log`, `gates.meta` |
| 2 | Mandatory accounting 490 (10 specs, 3 shards, one worker, quiet) | 3d8c9f9 | **PASS 490/490 in 5 of 5 classifier combinations**, 0 skipped, 0 flaky. Shard 1: 186/186. Shard 2: 264/264 ×5. Shard 3: 40/40. | `$E/task-047/quiet/mandatory-required-490-r{1..5}.{log,exit}`, `mandatory-{1,2-r1..r5,3}.json` |
| 2a | 490 on the TASK-046 tree (history) | fc29b2c | Not clean: 489/1 on the Focus terminal flake. The flake was fixed by TASK-047 (#2). | `$E/task-046/claude-mandatory-required-490.log`, `-r2.log` |
| 3 | Wider regression, 1,107 tests in 4 shards, against `scripts/ci-known-failures.json` | 3d8c9f9 | **PASS (aggregate classifier exit 0):** ran 1107, passed 808, 297 known-baseline failures, 2 history-only, **0 outside the baseline**, 17 baseline tests now passing. Ran with one worker; see §3.6. | `$E/task-047/wider/wider-aggregate.{log,exit}`, `wider-{1..4}.json`, `run.meta` |
| 4 | Household My Day (opt-in, 11 tests) | 120dba5 runtime (fc29b2c) | **PASS 11/11** on HEAD (45.2 s) and on pre-TASK-045 (42.3 s). Reviewer rerun: 11/11 (44.2 s). | `$E/task-046/claude-household-{head,pre045}.log`, `$E/task-046/review/rerun-household-head.{log,exit}` |
| 5 | Packaged (real release bundles, 31 web + 31 Android) plus byte pins | 3d8c9f9 against release-02 | **PASS 62/62**, required-62 classifier PASS. Web, bundle and rules pins OK. | `$E/task-047/gates/packaged.{log,json}`, `packaged-classifier.log`, `packaged-pins-r2.log`; release dir set in `$E/task-047/run-gates.sh` (`REL=…/task-046/release-02`) |
| 5a | Packaged, independent rerun | 120dba5 | PASS 62/62 | `$E/task-046/review/packaged-review.{log,json}`, `packaged-review-classifier.log` |
| 6 | `zz-perf-profile` (unchanged blob `8de432f1…`; E=2489, PERF_OPS=0,40; one worker) | 120dba5 | **PASS 1/1** (8.2 min). Also passed inside wider shard 4. Independent TASK-045 reviewer: 1/1 (4.4 min). | `$E/task-046/perf-standalone.{log,json,exit}`, `perf-profile-standalone.json`; `$E/task-045/perf.log`; `D:/ChronaSenseQualificationEvidence/20261126-queue/preserved-scratch/rev045/perf.log` (see †) |
| 7 | Durability spec (`accounting-storage-durability.spec.js`: Path A, Path B, archive) | 120dba5 | **PASS 3/3** three times (TASK-045 final, TASK-046, TASK-046 reviewer). Red before the fix: 1 passed, 2 failed. | `$E/task-045/focused-{red,green,final}.{log,json}`; `$E/task-046/storage-durability.log`; `$E/task-046/review/storage-durability-review.log` |
| 8 | Accounting node regressions (orphan recovery, wall observation, history cut, storage-full, capability, staged-effects, growth, gates, native projection) | c2b6f95 | PASS 195/195 | `$E/task-045/accounting-unit.log` |
| 9 | Mixed-workload headroom probe (measurement only) | 120dba5 | **About 7 day-equivalents** from seed to the 5,242,880-character wall (6.93 using days 2–6, 7.03 using days 3–6). See §3.1. | `$E/task-046/mixed-projection.json`, `mixed-settled-run.json`, `mixed-headroom-settled.json`, `mixed-settled.log` |
| 10 | Rules, fences, mutation, superseded-node | 3d8c9f9 | **PASS**: rules suites 142/142, fences 23/23, mutation 43/43. Tombstone and reliability required cases pass (exit 0). Their 4 and 5 pre-existing superseded failures are reported by design. | `$E/task-047/gates/{rules-suites,fences,mutation,tombstone,reliability,provision}.{log,exit}` |
| 11 | Life Ledger worker tests (TASK-049) | 50d909b / 9db0bf5 | **PASS**: 24/24 in each of 200 consecutive runs (implementer). Reviewer: 150/150 consecutive runs. Round-2 regressions red on the 806854c worker (21 pass/3 fail), green after the fix. Sibling suites pass. | `$E/task-049/round2/loop-200.log`, `red-on-806854c-worker.log`, `mutants.log`; `$E/task-049/review2/{rerun-loop-150.log,red-on-806854c-worker.log,green-50d909b.log,rerun-siblings.summary}` |
| 12 | Conversational-bridge Worker (Cloudflare) plus bundle | 3d8c9f9 | **PASS** 55/55. Wrangler dry-run bundle passed. | `$E/task-047/gates/worker-test.{log,exit}`, `worker-bundle.{log,exit}` |
| 13 | Release bytes: raw-blob parity | 120dba5 | **PASS**: all 111 runtime files match the raw Git blobs at both root and `www/`. The APK adds 2 empty Cordova files. No `server.url`. | `$E/task-046/independent-apk-raw-blobs.log`, `independent-apk-byte-check.json`; reviewer: `$E/task-046/review/indep-bytes.json`, `VERDICT.md` §1 |
| 14 | APK signature and badging | 120dba5 | **PASS**: v2 scheme, 1 Android Debug signer. Package `com.timeaudit.app`, minSdk 24, target/compile SDK 36. | `$E/task-046/apk-signature.log`, `apk-badging.log`; `$E/task-046/review/apksigner.log` |
| 15 | Runtime mirror (root ↔ www) | 9db0bf5 | PASS (111 files) | `$E/task-047/unit-rerun-9db0bf5/mirror.log` |
| 16 | **Hosted CI** on the candidate | — | **NOT RUN.** It needs the owner push in §4b. | none (owner action) |
| 17 | **Physical device** (Android APK, phone web) | — | **NOT RUN.** T3 device access is disabled; see §5. | none (owner action) |

† `D:/ChronaSenseQualificationEvidence/20261126-queue/preserved-scratch/rev045/` is a copy, made 2026-11-26, of the TASK-045 reviewer's scratch folder `D:/t/rev045/`, preserved under the evidence root
together with the TASK-041 and TASK-042 temp-folder evidence (`preserved-scratch/`).

### 2.1 Independent review verdicts

| Task | Verdict | Gate | Raw evidence |
|---|---|---|---|
| TASK-041 (runtime b18cc52) | APPROVE (fresh-context implementation QA, cycle 2). It was not a release authorization. | — (TASK-041 entry stays `blocked` for its original pre-queue reasons, superseded by this queue) | `TEST_REPORT.md` "TASK-041 … owner-decision implementation qualification"; probes at `D:/ChronaSenseQualificationEvidence/20261126-queue/preserved-scratch/chronasense-task041-evidence-20261124/independent-qa-cycle2/probe.log`. The verdict text exists only in TEST_REPORT; there is no standalone verdict file. |
| TASK-044 (integration merge 9eb6cf2) | **UNVERIFIED: no separate independent review is recorded.** TASK-044 was a conflict-resolution merge approved by the Tech Lead. Its byte claims (accounting runtime equals b18cc52, Household equals 0ff39ec) are recorded only in TEST_REPORT. The TASK-046 reviewer later re-derived the full web/APK trees from raw blobs (`review/indep-bytes.json`), which covers the combined result but not the merge step itself. | approved (held) | `$E/task-044/{mirror.log,npm-test-longtmp.log}` |
| TASK-045 | APPROVE WITH NOTES: 1 MAJOR (archive scope, §3.1), 4 MINOR, 1 NIT; no blocker | approved (held) | `REVIEW.md` "TASK-045 · Capture durability…"; reviewer outputs `D:/ChronaSenseQualificationEvidence/20261126-queue/preserved-scratch/rev045/` (†), probe `D:/ChronaSenseQualificationEvidence/20261126-queue/preserved-scratch/rev045/probe/eligible.probe.cjs` |
| TASK-046 | APPROVE. Release bytes, pins and packaged approved separately (`VERDICT.md`, whose blocking documentation finding F1, the unreported day 0–1 `ta3-entries` write failures, was fixed in TEST_REPORT before close). The Focus flake was ruled pre-existing and routed to TASK-047. | approved (held) | `$E/task-046/review/VERDICT.md`, `review/rerun-*`, `review/probe-*` |
| TASK-047 | APPROVE WITH NOTES (N1–N4, §3.7) | approved (held) | `$E/task-047/review/VERDICT.md`, `review/rev-*` |
| TASK-049 round 1 | CHANGES REQUIRED. Empty-generation ABA reproduced 5/5. | — | `$E/task-049/review/probe-empty-generation-aba.log` |
| TASK-049 round 2 | APPROVE, with non-blocking notes 1–4 (§3.4) | approved (held) | `$E/task-049/review2/` |
| TASK-048 (this packet) | **Pending.** It needs an independent reviewer to confirm that every claim here links to raw evidence. | review | — |

---

## 3. Known risks and limits

### 3.1 Storage headroom: about 7 day-equivalents. The release is NOT storage-safe.

- **Mixed-use measurement** (TASK-046 probe, E=2489 seeded entries). The probe ran a realistic day of 19
  actions: Start/Stop ×4, heartbeat and pings, an automatic log, a break, an away interval, Focus and an edit.
  - Storage grew about 122K characters per day-equivalent after the first archive cut.
  - The ~5.24M-character Chromium/WebView wall is projected at **6.93 to 7.03 day-equivalents** from a
    fresh seed. Peak observed: 5,144,900 characters.
  - Evidence: `$E/task-046/mixed-projection.json`.
  - The projection is linear and specific to this workload. It used synthetic entries of about 676
    characters, a compressed clock, and assumed a Chromium quota.
- **Why it is still bounded.** Automatic archiving covers only ordinary Start/Stop and read-only hydrate
  records. Pings, automatic logs, edits, Focus, break/away, undo, the committed entries and the physical
  records all still grow without limit (TASK-045 review MAJOR; DECISIONS #45 "Known limit").
- **Entries are stored three times.**
  - At E=2489 the accounting envelope holds committed entries (1,421,345 characters) and physical records
    (1,443,811). Before the first automatic archive cut it also holds the first hydrate frame (~1.44M), a
    third copy (`$E/task-045/diagnosis.log`).
  - The separate `ta3-entries` compatibility cache (~1.42-1.43M) is another copy. In the mixed probe its write
    **failed on days 0–1** (9 failures, then 29; `$E/task-046/mixed-projection.json` `errors`). At the day-2
    cut the hydrate frame left the envelope (envelope 4,541,238 → 3,208,659 characters) and the cache then fit.
    So in steady state the three copies are: envelope committed entries, envelope physical records, and the
    `ta3-entries` cache.
  - No accounting write failure appeared in the probe's error window. That window is a rolling record of the
    last 400 writes, so earlier failures would not be visible (TASK-046 review limitation; TEST_REPORT).
- **At the wall, archiving cannot free space for a page-held capture.** Recovery needs space freed outside
  accounting (TASK-045 review MINOR).
- **The rollback target is worse, not safer.** Live main 0ff39ec failed the required perf profile in hosted
  CI. It still shows the misleading "kept safely" toast on the page-held path. Evidence: `TEST_REPORT.md`
  "TASK-041/042 November26 completion" (hosted runs 45722193000 and 45118304375). T3 snapshots are under
  `D:/ChronaSenseQualificationEvidence/20261126-queue/preserved-scratch/chronasense-task042-qualification-20261126/`.
- **Owner decision pending (§4a).** Either (A) widen archive eligibility to the other settled kinds, or
  (B) stop storing entries three times (in steady state: envelope committed entries + envelope physical
  records + the `ta3-entries` cache, ~1.42-1.44M characters each; before the first archive cut the hydrate frame
  is an additional envelope copy).
  Neither option is designed or scheduled. Both are recorded with their evidence and the PM recommendation (A before
  release, B as the next project) in `planning/PROPOSALS.md` "Storage headroom after TASK-045"; DECISIONS #45 records
  the archive-scope limit.

- **Pre-existing known failures include time-loss scenarios.** The 297 known-baseline wider failures also fail
  on live main. They include time-loss-shaped scenarios, e.g. daily-use-reliability F-1, F-2 and F-3 ("in an
  OFFLINE session … must not lose the session"). This release neither fixes nor worsens them
  (`$E/task-046` and `$E/task-047/wider` classifiers; `scripts/ci-known-failures.json`; unchanged on prior production main b0bbc6f per TEST_REPORT TASK-043).

### 3.2 Page-held captures are lost on forced close

A capture that could not be written even to intake exists only in page memory (Path B). The browser warns
before unload and retries while the page is open. **A forced close, process kill, OS reclaim or crash loses
it** (DECISIONS #45). On Android WebView/Capacitor, `beforeunload` shows no dialog, so the APK gives no
protection (TASK-045 review). The app tells the truth about it ("held in this page"), but it is not durable.

### 3.3 TASK-041 accepted limit

After a successful locked recovery, the affected page can stay paused until reload or sign-in. At full
storage it stays paused until the observation intake fits (DECISIONS #44).

### 3.4 Life Ledger worker (TASK-049 review notes)

1. **`lock_unsupported_filesystem`.** If `backupsRoot` is moved to FAT/exFAT (USB) or to a NAS/SMB share
   without hard links, every cycle exits 1 before taking the lock and writes no status. The default
   Desktop/OneDrive location is NTFS and was probed OK. `EPERM` maps to "unsupported", so an ACL denial would
   show a misleading message.
2. DECISIONS #46 wording was corrected in 9db0bf5.
3. The CODEMAP phrase was corrected in 9db0bf5.
4. Known residue: orphan `.claim-*` files are not pruned, and `isBackupsRootLockLive()` is out of scope.

The scheduler has never been registered (docs/PHASE10), so no existing setup changes. Neither the scheduler
installer nor `--apply` was run.

### 3.5 Hosted CI has not run

Every gate in §2 ran locally on Windows with Node 24.19.0. Hosted CI uses ubuntu-latest and Node 22
(`.github/workflows/ci.yml:46-52`). Some hosted-only steps were not reproduced: `npm ci`,
`playwright install --with-deps`, artifact upload/download, and the online Gradle build (`npx cap add android`
+ `build-release-artifacts.mjs --gradle-online`). The APK is the local offline D: toolchain build.
Every local gate after the TASK-045 review ran on a shared node_modules restored with `npm ci --offline`, with the
protobufjs and sharp install scripts skipped (REVIEW.md TASK-045 incident). Hosted `npm ci` is the check for that.

### 3.6 The regression job ran with one worker locally

The local wider run added `--workers=1`. Hosted CI uses Playwright's default worker count
(`TEST_REPORT.md` TASK-047 table). Load-sensitive tests can behave differently there. Several wider
outside-ledger results in TASK-046 were environmental load or timing effects that passed on quiet reruns
(O1, owner-stall teardown, planning-continuity).

### 3.7 TASK-047 review notes

- **N1.** No `focus-learning-finish` case covers "server applied the Stop, reply lost across reload". The
  same path is covered elsewhere (optional follow-up).
- **N2.** The original/reloaded split uses a `reloaded` flag, not the request origin (theoretical).
- **N3.** "4/4 without the pause" has no raw log. It is **UNVERIFIED** as stated, but covered by the reviewer
  reruns (`$E/task-047/review/rev-*`).
- **N4.** Hosted CI has not run (§3.5).

### 3.8 TASK-045 review minors still open

- The page-held toast has no throttle, so it can repeat every 30 s. The copy is truthful.
- The committed tests do not exercise the automatic `eligible` predicate or the `minEnvelopeChars` gate. A
  reviewer probe did.
- A stale `ta3-entries` cache past an archived record could raise a false legacy-recovery prompt. That fails
  safe.
- NIT: `verifiedByOwner` keeps archived copies in memory, and each reload re-puts the first batch.

### 3.9 Other limits

- **Rollback data compatibility is UNVERIFIED.** DECISIONS #45 says the candidate uses the existing
  envelope and archive formats, and the TASK-045 review found the archive has no app reader. That suggests 0ff39ec can read state the
  candidate wrote, but no downgrade test was run.
- **Native Google sign-in with this debug APK is UNVERIFIED.** The APK is signed with a fresh debug key
  (SHA-1 `d2458c8b…1913`). Native Google sign-in usually works only if that SHA-1 is registered for the
  Android app in the Firebase project, and registering it is an owner-only production config change.
- **Physical-device behavior is NOT VERIFIED**: real quota, unload, WebView lifecycle, notifications and
  iOS Safari.
- **Test environment notes.** C: is about 100% full. Tests need TMP/TEMP on a long D: path; the 8.3 alias
  makes 23 Obsidian fixtures fail, which is environmental (`$E/task-044/npm-test.log` vs
  `npm-test-longtmp.log`).
- **Deferred housekeeping (QUEUE-20261126):**
  - the TASK-043 entry still says `approved` although it is merged;
  - the local `main` checkout (b0bbc6f) is behind origin/main 0ff39ec;
  - HANDOFF.md is stale.

---

## 4. Owner actions, in order

### (a) Decide the storage direction (before release, or explicitly accept §3.1)

Pick one, and record it in DECISIONS.md:

- **A. Widen archive eligibility** to the other settled kinds: ping, automatic log, save-entry, Focus,
  break/away, undo. This extends the existing mechanism, but every new kind needs a dependency and receipt
  audit.
- **B. Stop storing entries three times** (envelope committed + envelope physical + the `ta3-entries` cache in
  steady state). For example, drop or derive the `ta3-entries` compatibility cache or the duplicated
  committed/physical views. This saves about 1.4M characters per copy at E=2489. It is red
  zone, because it touches entry storage and sync.
- Or accept roughly 7 day-equivalents of headroom under heavy mixed use, as a known limit for this release.

Either A or B is a new task, delegated, reviewed and held, and it needs full requalification. Neither one is
in this candidate.

### (b) Run hosted CI on a new branch (never main)

The branch's upstream is `origin/main`. **Never run a bare `git push`.**

Run these three steps in order. Do not push until step 2 is clean.

1. Read the branch head and note the printed SHA:
   ```
   git -C C:/Users/DevLabs-Test/.t3/worktrees/Time-audit/task-044-durability-integration rev-parse refs/heads/task-044-durability-integration
   ```
2. Confirm everything after the qualified candidate `da5c4d4…` is docs only. The output must list only `.md`
   files (root, `docs/`, `planning/`). If any other file appears, **stop**:
   ```
   git -C C:/Users/DevLabs-Test/.t3/worktrees/Time-audit/task-044-durability-integration diff --name-only da5c4d493af5908cd2c7e27547eba0519b3e149f <printed SHA>
   ```
3. Push **that exact SHA** (not the branch name, which could have moved) to a new branch:
   ```
   git -C C:/Users/DevLabs-Test/.t3/worktrees/Time-audit/task-044-durability-integration push origin <printed SHA>:refs/heads/release/queue-20261126-rc
   ```

- To push exactly the qualified commit instead (skips steps 1-2):
  ```
  git -C <worktree> push origin da5c4d493af5908cd2c7e27547eba0519b3e149f:refs/heads/release/queue-20261126-rc
  ```
- `ci.yml` runs on push to `release/**`. On 2026-11-26, `git ls-remote` showed no
  `release/queue-20261126-rc` branch.
- Before TASK-049, the `unit` job could fail about 1 run in 10 on the lock race. TASK-049 fixed that.
- Look for differences caused by the hosted default worker count (§3.6) and by Node 22.

### (c) Physical-device checklist (§5)

Run it on a dedicated empty device or profile, and record results in the template in §5.6.

### (d) Merge and deploy (described here, not executed)

Do this only after (a), (b) green and (c) pass. All queue tasks (TASK-044/045/046/047/049) are held at
`approved`. A single merge lands them together.

1. In the main checkout:
   ```
   git fetch origin
   git checkout main
   git pull --ff-only
   ```
   Local main is currently b0bbc6f, behind origin. Confirm that `git rev-parse origin/main` is still
   `0ff39ec…`. If main has moved, **stop and requalify**.
2. Merge, naming the exact reviewed SHA:
   ```
   git merge --no-ff <reviewed SHA from (b)>
   ```
   Then `git diff <reviewed SHA> HEAD` must be empty. main is an ancestor of the candidate, so the merge tree
   is the candidate tree.
3. Run `sync.bat --check`. It wraps `scripts/runtime-mirror.mjs --check` (parity only; it does not build or
   push). Then run `npm test` with long-path TMP/TEMP on D:.
4. Run `SMOKETEST.md` in full: page load, timer, quick-log, timeline, Focus, Settings, persistence, Firebase
   sync, console.
5. `git push origin main`. This **is** the web deploy: GitHub Pages republishes in about 1–2 minutes. Never
   force-push.
6. Android is separate. `scripts/deploy-release.ps1` refuses to run on `main`, so run
   `-Confirm` from a release branch. Then build in Android Studio. Never uninstall a real-data install to get
   past a signing-key mismatch.
7. After deploy: repeat §5 W1–W3 on the production URL using a test account, then mark TASK-044..049
   `done` with the merge SHA.

### (e) Rollback target and how

- **Target:** `0ff39ec10508b283aa5bd2b3c608080a6b4fc08c`, which is live main today, as served by GitHub
  Pages.
- **Web:**
  ```
  git revert --no-edit -m 1 <merge commit>
  ```
  Then `sync.bat --check` and `git push origin main`. Pages republishes in about 1–2 minutes. Household stays,
  because it is in 0ff39ec.
- **Data after rollback:**
  - Logged time and RTDB data are untouched: there is no schema or rules change.
  - Records archived to IndexedDB stay there unread, by both versions.
  - Downgrade reading is **UNVERIFIED** (§3.9).
  - The rolled-back app brings back the known storage-wall and "kept safely" toast defects (§3.1).
- **Android:** reinstall the previous APK only with the same signing key. Never uninstall or clear a
  real-data install.
- **Life Ledger worker:** the revert restores the old script. The scheduler is not registered, so nothing
  else is needed.

---

## 5. Physical-device checklist (owner-run; T3 device access is disabled)

### 5.0 Ground rules (read first)

- **Use a dedicated device with no real-data ChronaSense install in any user profile.** The package id is
  `com.timeaudit.app`. A separate Android user profile is **not** isolation: `adb install` installs for all
  users by default and app code is shared across profiles, so a real-data install in any profile would be
  updated in place (same key) or block the install (different key). If the package is installed in **any** user
  profile on that device, **STOP**.
  - Do not uninstall, clear data or override a signing mismatch (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). That
    could erase unsynced time.
- **Sign in with a dedicated test Google account, never the real-data account.** The build talks to the
  production Firebase project, so this writes test data under that test account's uid in production RTDB.
  That is your authorization to give.
- **Storage-full steps (S, R) only on the test device or test origin.** They deliberately fill storage.
- **Record for every run:**
  - device model, Android version, Chrome/WebView version;
  - APK SHA-256 (`f99b5a80…8dd6`);
  - candidate SHA;
  - test account (alias only);
  - local time of each step.

### 5.1 Setup

| Step | Action | Expected | Record |
|---|---|---|---|
| P0 | Pre-check on the PC: `adb devices`; `adb shell pm list users`; then for **each** user id `adb shell pm list packages --user <id> com.timeaudit.app` | Every listing is empty. If any user lists `com.timeaudit.app`, **STOP**; do not install. | command output |
| P1 | On the PC: `adb install D:/ChronaSenseQualificationEvidence/20261126-queue/task-046/release-02/chronasense-debug.apk` (device B = Android APK) | `Success`. No existing-install conflict. | adb output |
| P2 | Open the app, sign in with the test account | Signed in, My Day shown, no crash-recovery modal. **If Google sign-in fails** (for example code 10 / DEVELOPER_ERROR), stop the APK signed-in steps and record it. The debug SHA-1 `d2458c8b7ed318c55b821aa8b6b0ea47897b1913` is probably not registered, and registering it is a separate owner decision. | screenshot, error text |
| P3 | Web on the phone (device A = phone Chrome). On the PC: `python -m http.server 8000 --bind 127.0.0.1 --directory C:/Users/DevLabs-Test/.t3/worktrees/Time-audit/task-044-durability-integration/www` then `adb reverse tcp:8000 tcp:8000`. On the phone, open `http://localhost:8000/`. | App loads. Sign-in works, because `localhost` is a default Firebase authorized domain. **If you see `auth/unauthorized-domain`, stop; do not add domains.** The localhost origin has its own storage, separate from the production site's. | URL, screenshot |
| P4 | Remote inspection: on the PC, open `chrome://inspect`. Both the phone Chrome tab and the debug APK's WebView should be listed. | Both inspectable. If the WebView is not listed, do the S/R steps on web only and record that. | which targets are listed |

### 5.2 Start/Stop (W1 web, A1 APK)

| Step | Action | Expected | Record |
|---|---|---|---|
| W1/A1 | Start a task, wait at least 2 min, Stop | Exactly one entry with the right start/end. The status settles to confirmed, with no lasting "pending" or "unconfirmed". | entry times; status text |
| W2/A2 | Reload (web) or swipe away and reopen (APK) | Entry still there, **no false crash-recovery modal**, no duplicate entry | screenshot |
| W3/A3 | Start, then reload while running, then Stop | The timer restores as running with the original start time. One entry. | start time before/after |

### 5.3 Storage-full honesty (S), test profile only

| Step | Action | Expected | Record |
|---|---|---|---|
| S1 | In the inspected page's DevTools console, fill storage: `(()=>{let i=0,j=0;const b='x'.repeat(262144),s='x'.repeat(1024);try{for(;;)localStorage.setItem('zz-device-test-fill-'+(i++),b)}catch(e){}try{for(;;)localStorage.setItem('zz-device-test-fill-s'+(j++),s)}catch(e){}return{big:i-1,small:j-1}})()` | Returns counts, so storage is now at quota | returned counts |
| S2 | Press Start on a task | The app **never** says "kept safely" or claims the change was saved. You will see one of three outcomes:<br>• a durable-intake path that later imports normally;<br>• a page-held status, "N accounting change(s) is/are held in this page. Keep this page open while storage recovers.", with a real count (press Stop too: the count should increase);<br>• or the toast "This device's storage is full. Use Check now to retry accounting when space is available." | exact status and toast text; the count |
| S3 | Clear the filler: `Object.keys(localStorage).filter(k=>k.startsWith('zz-device-test-fill-')).forEach(k=>localStorage.removeItem(k))`, then press **Check now** (or wait up to about 30 s) | The held count drops to 0. The Start/Stop land **exactly once**, with the original times (no new timestamp and no second press needed). The entry appears once on the other device. | before/after count; entry times; any duplicate |

### 5.4 Reload with a page-held capture (R)

| Step | Action | Expected | Record |
|---|---|---|---|
| R1 (web) | Repeat S1–S2 until the page-held count is at least 1, then tap reload or close the tab | Chrome shows a "Leave site?" warning. Mobile Chrome may suppress it without a recent user gesture; if so, record that. | whether the warning appeared |
| R2 (web) | Choose **Cancel** (stay), then clear the filler (S3) | Change flushes once, original time | entry |
| R3 (web) | Repeat S1–S2, then choose **Leave** (or force-close Chrome) | **Documented limit (§3.2):** the held change is lost. After reload, the app must not show it as saved and must not show a phantom entry. | what was lost; any false claim |
| R4 (APK) | Repeat S1–S2 in the WebView, then swipe the app away | **No warning is expected on WebView** (§3.2). The held change is lost. On reopen, no false "saved" claim and no false crash modal. | observed behavior |
| R5 | Clean up: run the S3 removal snippet on every page you filled | Filler keys gone | confirm |

### 5.5 Cross-device Stop (X) and Household (H)

| Step | Action | Expected | Record |
|---|---|---|---|
| X1 | Start on device B (APK), then watch device A (web) | A shows the same running timer within a few seconds | delay |
| X2 | Stop on device A | B shows stopped. **Exactly one entry** on both devices. B does not log a second copy. | entries on each device |
| X3 | Start on A and wait until a heartbeat or ping is due (or about 1 interval). Press Stop on B immediately after A's ping prompt. | One entry. No refusal loop. A waited Stop either completes or tells the truth. | outcome text |
| X4 | Reopen both apps | No false crash-recovery modal on either | screenshot |
| H1 | Web: open `http://localhost:8000/?household=1` | Household My Day: today's tasks column. The partner card is read-only (or reads "isn't sharing their full daily list"). Food reads "Meal Prep is not connected on this device yet." | screenshot |
| H2 | Start then Stop a task from the Household view, and mark one Done | One entry, logged once. Done state persists after reload. | entries |
| H3 | Open `http://localhost:8000/` without the flag | Normal My Day, unchanged. On the APK, Household is not shown (it is web-only behind the flag). | screenshot |

### 5.5a Cleanup after testing

On the phone, for `http://localhost:8000`: unregister its service worker and clear that origin's site data
(Chrome → Settings → Site settings → All sites → localhost:8000 → Clear & reset). Then `adb reverse --remove tcp:8000`
and stop the local `http.server`. Leave the test APK installed or uninstall it **only** on the dedicated device.

### 5.6 Result record (copy, fill in, and attach to TASK-048)

```
device/OS/browser|WebView:            APK sha256:                 candidate SHA:
test account alias:                   date/time zone:
P1 P2 P3 P4 | W1 W2 W3 | A1 A2 A3 | S1 S2 S3 | R1 R2 R3 R4 R5 | X1 X2 X3 X4 | H1 H2 H3
each: PASS / FAIL / BLOCKED + exact on-screen text + screenshot file name
any "kept safely" or durable claim while storage was full:  yes/no (yes = release blocker)
any duplicate or lost entry other than the documented R3/R4 loss: yes/no (yes = release blocker)
```

Afterwards: run the S3 cleanup, sign out of the test account, stop the PC `http.server`, and
`adb reverse --remove tcp:8000`. Leave the test install in place, or remove it only if it is on the dedicated
test device and holds no real data.
