# TASK-018 performance remediation — review checkpoint

TASK-018 remains open for owner performance acceptance. The owner reports that the released functionality works in real use, but completion/Undo feels slow. This branch is review-only; no merge or deployment is authorized. Baseline: released main `ca2c90f822dc4f8648157fbc62b35324f73f5cca`. Draft PR: https://github.com/shinyamadasan/Time-audit/pull/9.

## Measured cause

Direct headless Playwright used the retained authenticated synthetic profile at 390×844. Exact canary UID and room were checked before mutation; network guards restricted writes to that room/self public-status path and completion requests to one existing synthetic task. Ten completion/Undo cycles were measured per client. The candidate's two client modules were intercepted at the production origin against the unchanged production backend; this is not a deployed candidate or owner acceptance. Both runs preserved all source wire content and prior receipts.

The released client calls inspect → mutate → inspect for every completion, even with fresh listener-valid inspection evidence. Inspections cost about 390 ms each. Undo already uses mutate → inspect. Existing server telemetry observes one full-room read per inspect and two per mutation (precondition/readback), plus one conditional PUT. Client token acquisition was near zero; UI/validation tails were small. The unnecessary pre-inspection is a measurable normal-completion bottleneck. Full-room/CAS/auth server work and network transit remain material.

Normal requests never used the recovery status endpoint in either benchmark (zero status calls). The misleading checking experience came from rendering every durably staged, not-yet-acknowledged command as uncertain while it was still saving. It was not evidence of confirmed operations being replayed.

## Before / after

Milliseconds, median / nearest-rank p95; n=10 per action/client. These are small sequential samples, not randomized load tests or SLA estimates. First feedback measures DOM mutation, not physical display paint. Operation latency includes API work and the retained post-action inspection/render path.

| Metric | Released client | Candidate |
|---|---:|---:|
| Completion | 1344.5 / 1517.4 | 955.1 / 1558.0 |
| Undo | 924.4 / 946.2 | 1013.7 / 1594.2 |
| First completion feedback | 5.0 / 7.0 | 8.3 / 11.5 |
| First Undo feedback | 8.6 / 10.2 | 12.7 / 17.8 |
| Completion mutation request | 522.1 / 625.5 | 536.5 / 1140.6 |
| Undo mutation request | 515.9 / 540.4 | 590.5 / 1183.3 |
| All inspection requests | approximately 390 | approximately 386 |
| Completion token acquisition | 0 / 5.3 | 0 / 0.2 |
| Undo token acquisition | 1.6 / 3.9 | 0 / 0.1 |
| Completion local tail after last request observation | 12.9 / 25.9 | 16.7 / 22.9 |
| Undo local tail after last request observation | 9.9 / 10.5 | 16.4 / 24.6 |
| API requests over 10 completion/Undo pairs | 51 | 40 |
| Normal checking wording | 20/20 actions | 0/20 actions |
| Recovery status calls during normal actions | 0 | 0 |

Completion median improved 29%; request count fell 22% in this sample (usual path 3→2 calls for completion, 2→2 for Undo; one extra baseline inspection was observed). Undo latency did not improve. Candidate p95s were worse, with longer mutation/server requests; no tail-latency improvement is claimed.

Existing sanitized server telemetry in the benchmark time windows observed inspect median/p95 314.5/348 ms before and 306/317 ms after; mutate 436/548 ms before and 463/1103 ms after. These are time-window samples, not operation-ID-correlated traces: privacy-safe logs intentionally omit IDs. The observed rows all confirmed and had no 5xx/unconfirmed writes. Server auth verification, full-room read duration and CPU are not separately instrumented, so their individual production latency cannot be claimed. No protected backend changes were made to obtain finer traces.

One additional bounded recovery measurement intentionally aborted an Undo before dispatch, reloaded, then resumed the same ID. Status 388.6 ms → mutation 542.3 ms → inspection 391.6 ms; Playwright interaction-to-recovered wall time 2289 ms (includes browser interaction/readiness). This is n=1, not a recovery p95. Natural reconnect after an intentionally failed offline inspection restored freshness in 421 ms without reload.

## Exact changes and safety argument

- `complete()` reuses an existing fresh, item-matching inspection and its account zone. Missing/stale evidence still requires inspection. Source/zone/revision/CAS checks remain enforced by the unchanged backend, including races before listener delivery. Post-action inspection and cryptographic receipt validation remain mandatory.
- An explicit offline new action refuses before staging. An already pending uncertain command remains UNKNOWN with the same ID, even offline. Interrupted online requests still retain their original recoverable command.
- Completion, Undo and resume share a per-identity in-flight guard. Repeated taps/recovery cannot allocate a second concurrent Undo or dispatch another command. The existing UI Undo guard remains.
- Starting an inspection consumes its scheduled debounce timer; invalidation during an in-flight read still requires another epoch-correct inspection. All source/authority/settings/resolution listeners and account generation checks remain.
- Normal operations immediately show Saving, with no recovery button while that operation is active. Separate unresolved operations stay visible. Settled UNKNOWN keeps checking/retry controls. CONFIRMED is still shown only after validated authoritative evidence.
- The two `www/` mirrors match. Backend, rules, IAM, schema, source-history stores and Firebase synchronization red zone are unchanged.

## Verification checkpoint

Local `npm test` passed (exit 0). Sync tests: 21/21. Existing affected browser regressions: 16 passed; added saving/offline cases pass after harness correction. A third regression checks global recovery targets an inactive uncertain command while another command is active. Full final browser/fence CI and exact-SHA independent review are required on the final PR head; their final observed results, exact candidate SHA and checksums are recorded in the private final evidence packet rather than inferred from this checkpoint.

Live candidate-over-production safety checks passed: completion, persistent Undo/44px target, double tap, deliberately interrupted Undo, reload/same-ID recovery, receipt retention, source-history preservation, explicit offline refusal, natural reconnect and zero page exceptions. Only the chosen existing canary resolution changed; authoritative snapshots are retained privately. Account-switch/newer-source/concurrent resolution/forged receipt/listener cancellation regressions remain covered locally/CI, not by signing into a real account in the canary browser.

Independent review found an offline retry that incorrectly downgraded an already UNKNOWN command to REJECTED; fixed and regression-tested before handoff. A new held-response browser test initially released before its request reached the hold, then expected a disabled Completed row after an authoritative listener had already restored Unfinished. Both harness assumptions were corrected; no safety check was removed. Earlier retained-profile timer overlays were suppressed visually by the harness without selecting a timer outcome or editing its history. Private failed attempts are retained.

Self-review/QA: surgical client/test changes; no timeline/timer/sync/history helpers changed; receipt/account/conditional-write checks retained; generated parity and diff checks pass; lint has no errors (48 existing warnings). Real-device feel remains pending. No new real-user writes, deployments or automatic rollback actions.

## Acceptance hold and limitations

Owner performance acceptance remains pending. O3 first-login legacy hydration/render delay remains deferred; the canary may require its documented reload. Other accepted release limitations remain: permission-cancelled listeners fail closed until rebind/reload, P3 recovered-completion wording, full-room inspection cost/date bounds, Android/APK acceptance and shared Artifact Registry cleanup policy. Warm token measurements do not establish expired-token/login performance. Larger-room tail performance and per-server-stage attribution remain unmeasured. The candidate has not been published to daily-use devices.

After separate release approval and guarded deployment, the owner should complete an ordinary real task, observe immediate Saving acknowledgement and eventual saved/date state, reload and exercise persistent Undo, try ordinary reconnect, and report device/browser plus whether responsiveness is acceptable. Do not simulate real-account writes to replace these observations. Keep TASK-018 in review until this performance feedback is resolved; do not start TASK-016 or O3 implementation.

Private evidence: primary workspace `release-verification/task-018/performance/` contains benchmark/harness source, timing traces, authoritative snapshots, recovery evidence, CI summaries and independent review. Do not commit profiles, screenshots, raw logs or account/task IDs. The final packet explicitly separates reused release evidence, new local/browser results and new production-backed canary results.
