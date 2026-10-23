# Overnight ChronaSense result — PASS

2026-10-20, America/Phoenix. Review-ready only; no production changes.

## Completed

Fixed a remaining Windows HUD defect: after **Hide until tracking ends**, switching activities could keep the next activity hidden. Hiding now belongs to the authoritative tracking `startedAt`. A new activity shows again; a heartbeat/title change for the same activity stays hidden. Focus work/break hiding is preserved. Runtime diff: six added lines and one replaced line in the companion; no web timer or data changes.

The updated test failed against baseline at `ActivitySwitchLiftsHide`, then passed against the fix. It also covers rapid stop/start before an empty render and unchanged Focus phase suppression.

## Status investigation and isolation

- Actual repository: `<source-checkout>`.
- TASK-014: integrated and closed in its task history, with owner-reported normal tracking/Focus/Away/sign-out acceptance. Background throttling and the first browser Local Network Access prompt remain unverified there.
- TASK-015: separate Brain Dump planning tray; integrated, with real-use acceptance still held in its task history. Its worktree and files were not altered.
- Subsequent TASK-019 diagnosed the old Focus-only companion rejecting normal tracking. Its 2026-10-18 handoff records replacement with the approved TASK-014 companion and successful live loopback probes; interactive signed-in visual acceptance was not established. This pilot did not claim to reverify that installed process: the process inventory was denied in the sandbox and its escalation was interrupted. The original version-mismatch fix was therefore not duplicated.
- Isolated branch: `fix/hud-hidden-tracking-session`; worktree: `<isolated-pilot-worktree>`. Its separate Git repository is the sibling `repository.git`, cloned without hardlinks. Existing checkouts were not switched or edited.
- Baseline: `bb171a287ac67d76ae27634b5227bc24f66919de`. A read-only remote `main` lookup confirmed that exact SHA during this run. No fetch, push, merge or deployment was performed against the original repo.

## Evidence

Raw logs and the reviewed source diff are in `../evidence/`.

| Check | Actual result | Log |
|---|---|---|
| New regression against baseline | Expected exit 1, `ActivitySwitchLiftsHide` | `baseline-regression.log` |
| Companion normal tracking | 60 assertions passed | `companion-normal.log` |
| Companion dogfood/startup fixture | 30 assertions passed; fixture Startup directory only | `companion-dogfood.log` |
| HUD bridge | 33 passed | `hud-bridge.log` |
| HUD browser regressions | 14 passed, stubbed Firebase and companion | `hud-browser.log` |
| Full `npm test`, completed rerun | Exit 0: 2,190 Node passes, 0 failures, 1 existing opt-in skip; separate legacy harness 455/455 | `npm-test-complete.log` |
| Lint | Exit 0: 0 errors, 48 existing warnings; changed PowerShell separately parses in companion tests | `lint.log` |
| Runtime mirror | 92-file closure byte-identical | `check-www-parity.log` |
| Firebase rules builder parity | Match; rules untouched | `check-firebase-rules.log` |
| Build | Exit 0; repository explicitly has no build step | `build.log` |
| Whitespace/scope/self-review | `git diff --check` clean; only companion, its tests/documentation and pilot evidence records changed | Git diff |
| Independent review | Fresh agent `/root/hud_independent_review`: **ship**, no actionable findings; reran both companion suites | `PILOT_REVIEW.md` |

The independent review covers the unchanged three-file HUD diff; SHA-256 of the captured diff: `EFEA2038F5F1058466D90BCE5EDEBC9229D6E5FCDC625012AB0D6CACAB5489A1`. It is advisory evidence, not an approval-record edit or release authorization.

## Risks, skipped checks and decision

No implementation blocker remains. Live WPF visibility, dispatcher timing and tray interaction were not tested: the PowerShell suites extract real functions and use window stubs. Browser tests prove the unchanged projection/ownership flows, not a real Windows window. No screenshots are claimed; the reproducible before/after regression and logs are the evidence.

The full browser suite, emulator/fence suites, native Android build, physical devices and production services were not exercised. This patch only changes companion presentation suppression; no web runtime, timer/heartbeat/sync/auth/schema/rules or transport code changed. Focus hiding across a new Focus session without an empty render is pre-existing behavior and outside this tracking-only fix.

Existing TASK-014/TASK-015/TASK-018/TASK-019 task records, shared instructions/infrastructure, live companion/startup settings and Second Brain vault were left unchanged. No global-system improvement was applied.

**Next action:** review the patch, then validate it in a disposable Windows HUD test session: start normal activity A, hide, confirm a heartbeat keeps it hidden, switch to activity B and confirm it appears; repeat stop/start quickly and check Focus work/break still stays hidden. Any deployment or replacement of the everyday companion remains a separate owner decision.

## Autonomy and efficiency

Investigation, defect selection, reproduction, isolated implementation, test diagnosis, independent review and packaging required no product questions or implementation intervention. Tool approval handling was required; whether each approval involved a human is not exposed by the host and is not invented here.

Measurement snapshot at **2026-10-20 14:39:27 UTC / 07:39:27 Phoenix**: host goal counter **811 execution seconds** and **127,172 tokens**. Monetary cost is unavailable; subsequent packaging/handoff use is excluded from that snapshot. First clock observation was 06:14:21 UTC: wall elapsed to the snapshot was **8h 25m 06s**, including the long gap between turns, not continuous execution.

Six failed setup/check attempts were observed: optional Astral inspector launch, sandbox process inventory, sandbox Git clone, sandbox Node subprocess, full-suite missing `targaryen`, and plain npm CI peer resolution. One process-inventory escalation was interrupted. The expected baseline regression failure is not counted as a retry. Git/Node succeeded after permitted escalation; dependencies were installed offline with lifecycle scripts disabled using the repository's documented CI `--legacy-peer-deps` option; the full suite then passed. No manifests changed and no flaky-test retries were needed.

Reused procedures: CODEMAP-guided navigation, companion AST tests, focused Playwright tests, existing npm/CI checks, SELF_REVIEW/QA principles and independent advisory review. The optional Astral preflight could not launch its rollout inspector, so no verified Astral route is claimed. The direct owner instruction to execute the pilot governed the work; no new framework was installed.

Avoidable overhead: broad initial task-history reads and copying dependencies from the older root checkout, followed by a plain install before checking CI's known peer-conflict option. **One proposed improvement for later approval:** make the existing app-development preflight start with the locked dependency command used by CI, with the documented peer flag, before any test run. This would have prevented the missing-package run and peer-resolution retry. Do not change global routing or infrastructure for this pilot.
