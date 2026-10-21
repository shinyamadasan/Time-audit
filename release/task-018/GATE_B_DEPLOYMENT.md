# TASK-018 Gate B — production deployment procedure (prepared 2026-10-16; steps 0-4 EXECUTED, B4 Day 1 OUTSTANDING)

> ## Execution status — reconciled 2026-10-21 against live production (read-only)
>
> **The "NOT executed" title below was stale.** Steps 0-4 and the monitoring step were applied to
> `time-audit-3c3da` on 2026-10-16, roughly 20 minutes after this runbook was committed. Re-verified
> independently on 2026-10-21 by querying production directly; do **not** re-run steps 0-4.
>
> | Step | Status | Independently verified 2026-10-21 |
> |---|---|---|
> | 0 Artifact + baselines | DONE | `D:\chronasense-prod-evidence\{before,after-b2}`; preflight 0/b1/b2 all `pass:true`, 24/27/27 checks, 0 failed, each pinning `08e9371` |
> | 1 Identities (IAM) | DONE | Exactly the 5 planned bindings present; custom role GA with the 3 intended permissions; no Editor/Owner on either SA |
> | 2 Monitoring | DONE | 4 log metrics, 6 alert policies (all enabled), 1 email channel |
> | 3 Rules (B1) | DONE | Live rules byte-identical to the candidate builder output; delta vs `before` is exactly `taskCompletionResolutions/.write=false` |
> | 4 Backend (B2) | DONE | `chronasensecompletionapi-00002-vin` ACTIVE, nodejs22, runtime SA `chronasense-completion`, build SA `chronasense-build`, maxInstances 1, concurrency 1, 512Mi; invoker `allUsers` only. 4b exited non-zero exactly as predicted (cleanup policy), log contains "Successful create operation" |
> | Blast radius | CLEAN | `before` vs `after-b2`: Action API snapshot IDENTICAL (`chronasenseactionapi-00007-mon`, unchanged since 2026-10-14), secret IAM IDENTICAL |
> | Unauthenticated probe | PASS | POST -> `401 {"outcome":"REJECTED","reason":"UNAUTHENTICATED"}`; GET -> 405; cross-origin preflight returns no `access-control-allow-origin` |
> | 5 Canary **Day 0** | DONE 2026-10-16 | Canary Google account signed in once at `20:54:59Z`; `rooms/uid_<canary>` holds `plans/2026-10-16` + `settings.timezone="America/Phoenix"`; `taskCompletionResolutions` is **null** |
> | 5 Canary **Day 1** | **NOT RUN** | Canary `lastRefreshAt` is unchanged since Day 0 and the endpoint has served **zero** authenticated requests. Every production log entry since deploy is `op:"unparsed"` (the Day 0 smoke probe and the 2026-10-21 re-probe). No completion or Undo has ever executed in production. |
> | Artifact cleanup policy | **UNDECIDED** | `gcf-artifacts` (asia-southeast1) still has `cleanupPolicies: null`; repository is 267.8 MB and growing. Owner decision, because the repo is shared with the Action API |
>
> **Day 1 date drift.** Day 0 tasks sit in `plans/2026-10-16`, now 5 days old rather than "yesterday".
> Day 1 remains valid (these are genuinely unfinished history, which is the feature's actual subject),
> but the step-2 "Done earlier (yesterday)" instruction must be read as an explicit earlier date, and
> the owner should confirm the drift is acceptable rather than re-running Day 0.
>
> **Independent final-diff review — RESOLVED 2026-10-21.** The unsupported PASS claim recorded below
> has been replaced by a real archived review: see `REVIEW.md`, "Review TASK-018". An independent
> reviewer that did not build the task read the final diff `df7c279..08e9371`, re-ran the local gates
> (npm test 2260/2261 with one known opt-in skip; completion suite 99/99; www parity 15/15;
> authority-boundary 15/15), compared live production rules against this candidate's generated output
> (byte-identical), and killed 5/5 injected mutations of the security-critical invariants (Action-API
> claim tokens, token revocation, account-zone enforcement, receipt acknowledgement, UNKNOWN honesty).
> Verdict: PASS WITH NOTES, `approved` (red-zone), held — explicitly conditional on the Day 1 canary.
> Three non-blocking notes (N1 completion-date has no lower bound, N2 the UNKNOWN state depends on the
> UI keeping "Check status", N3 per-completion full-room read cost) are recorded there.

> ### Day 1 canary — EXECUTED 2026-10-21. ALL CHECKS PASSED.
>
> Owner authorised the run and personally signed in as the canary (`shinsightblog@gmail.com`,
> uid `FakeKvcRkDVbpzXHBa64CyPwzfu1`); no credential was shared with or stored by the agent. The
> unchanged byte-verified `08e9371` artifact was served read-only at `http://localhost` (in the
> function's reviewed CORS allowlist; plain HTTP avoids a self-signed-cert interstitial breaking the
> OAuth redirect, and `localhost` is a secure context). Interactions were driven through the real UI
> in a fresh-profile Chrome. Nothing was redeployed and Day 0 was not re-run.
>
> | Check | Result | Evidence |
> |---|---|---|
> | Done today (Canary 1) | PASS | CONFIRMED, rev 1, receipt `date=2026-10-21`, `tz=America/Phoenix` — the ACCOUNT zone, not the device's |
> | Undo (Canary 3) | PASS | CONFIRMED, state back to `open`, rev 2, **2 operations** — the completion receipt was retained, not erased |
> | Done earlier (Canary 2) | PASS | CONFIRMED, rev 1, receipt `date=2026-10-16` — the explicit 5-day-old plan date |
> | Reload durability | PASS | After reload, Unfinished = 2 (Canary 3, 4); Canary 1 and 2 stayed resolved |
> | Offline refusal (Canary 3) | PASS | Request never left the browser (`ERR_INTERNET_DISCONNECTED`); UI showed **"Not saved · SOURCE_UNAVAILABLE"**; nothing written |
> | Untouched control (Canary 4) | PASS | No resolution record exists for it at all |
> | Original history preserved | PASS | All four source items in `plans/2026-10-16` remain `done:false`; resolutions are siblings and rewrote no history |
> | Owner's room | PASS | `rooms/uid_<owner>/taskCompletionResolutions` is still **null** |
> | Log privacy | PASS | 17 `completion-request` events; scan of raw log JSON for canary uid, canary e-mail, task text, item ids, dates and timezone found **zero** occurrences — only bucketed counts and enums |
> | Errors / alerts | PASS | 0 × 5xx, 0 unconfirmed writes, 0 WARNING+ entries, no alert fired |
> | Hosts contacted | PASS | Completion traffic only to `asia-southeast1-time-audit-3c3da.cloudfunctions.net`; no staging or non-production host; 0 page errors |
>
> Final ledger: C1 `completed` rev1 (2026-10-21) · C2 `completed` rev1 (2026-10-16) ·
> C3 `open` rev2 holding BOTH its complete and undo receipts · C4 no record.
> Evidence: `ChronaSense-TASK018-prod-evidence-backup/<ts>/day1-canary/` (request log, production log
> export, final resolutions, final source plan, SHA-256 manifest).
>
> **Observations (neither is a data-safety defect; both are UX):**
> - **O1. Undo is reachable only while the temporary notice is shown.** `planning-continuity-ui.js:592`
>   renders Undo only when `state.completionReceipt` is set. Once the notice expires the task is
>   suppressed from Unfinished and there is no other path to undo it — the backend supports undo
>   indefinitely, but the UI does not expose it. First completion in this run became effectively
>   permanent within seconds. Worth a durable affordance (e.g. Undo from the completed item).
> - **O2. A transient network drop leaves the section degraded until reload.** While offline every row,
>   including already-resolved ones, showed "Changed or ambiguous · refresh before resolving", and it
>   did not self-heal on reconnect; a reload cleared it fully. Fail-closed and documented behaviour
>   ("cancelled source listeners refuse freshness until rebind/reload"), but a reconnect-triggered
>   rebind would avoid a stuck state.
> - **O3.** The Unfinished section did not render at all until a reload after first sign-in.
>
> ### Git history remediation (Option A) — DONE 2026-10-21, with residual exposure
>
> The first push of this branch published the owner's personal Google account inside
> `release/task-018/prod-preflight.mjs`. `shinyamadasan/Time-audit` is PUBLIC. Commit `48aedd3`
> removed it from the branch TIP only; four pushed commits (`c6d1035`, `da96b25`, `1e3177f`,
> `e079508`) still carried it in their trees.
>
> **Safeguards checked before rewriting:** no PR referenced the branch (open or closed); no other
> local or remote branch contained those commits; only this worktree had it checked out;
> `main` and `task-018-candidate` were unaffected.
>
> **Backup first:** tag `backup/task-018-monitoring-pre-scrub` at `94a846d`, plus a verified bundle
> at `ChronaSense-TASK018-prod-evidence-backup/git-backup/task-018-monitoring-pre-scrub.bundle`
> (`git bundle verify`: "The bundle records a complete history", okay).
>
> **Rewrite:** `git-filter-repo --replace-text` in an ISOLATED clone (so no other ref could be
> touched), replacing the literal address with `OPERATOR_EMAIL_REDACTED`. Then
> `git push --force-with-lease=task-018-monitoring:94a846d…` for that one branch.
>
> **Verification:** `git log --all -S<address>` returns nothing; a single pass over all 3247 blobs
> finds 0 occurrences; all 861 commits are preserved; the HEAD tree is byte-identical
> (`ecfbd062a673576eaa595960867f6ee4ce83fc71` before and after), so no content changed.
> `main` is still `bb171a2` and `task-018-candidate` still `08e9371`.
>
> **Residual exposure — NOT purged, do not claim otherwise:**
> - The pre-rewrite commits remain retrievable from GitHub by direct SHA. Verified today:
>   `GET /repos/.../commits/94a846d…` still resolves, and
>   `GET /repos/.../contents/release/task-018/prod-preflight.mjs?ref=c6d1035` still returns a blob
>   that CONTAINS the address. They are unreferenced, not deleted; GitHub keeps such objects until
>   its own GC, and only GitHub Support can force their removal. The branch listing itself now
>   shows only the rewritten, clean commits.
> - Separately and pre-existing: the address appears as the commit AUTHOR/COMMITTER e-mail on 1697
>   commits across the whole repository, including `main`. `--replace-text` rewrites blobs, not
>   commit metadata. Changing that would mean rewriting `main`, which was not authorised and is not
>   recommended. Git author e-mails on a public repo are inherently public.
> - Practical read: the marginal exposure added by the push is now small, because the same address
>   was already public as commit metadata — but it is not zero, and it is not gone.
>
> ### O3 — DEFERRED as a follow-up, with evidence (2026-10-21)
>
> **Symptom.** After the first sign-in the Unfinished section stays empty and hidden; it only
> appears after a page reload. Observed live on the canary during Day 1.
>
> **Evidence that the data layer is fine.** With the section still empty and
> `#unfinished-recovery-section` carrying `hidden` and the correct `data-pc-owner`,
> `PlanAuthority.staleUnfinished()` already returned all four canary tasks with correct targets and
> `endedMs`. So discovery works; only the re-render is missing. A reload rendered "Unfinished · 4"
> immediately.
>
> **Root cause located, deliberately not fixed.** The planning-continuity surface re-renders from
> `globalThis.refreshCommitmentSurfaces`, which `index.html`'s `refreshAuthoritativePlanSurfaces()`
> calls "after an operational write and after an inbound remote merge". For a LEGACY-store account
> (this canary: `PlanAuthority.authorityState() === 'legacy'`, no calendar authority, no boundary)
> the first inbound merge after sign-in lands through `storage.js` -> `writeDatePlanLocal()`, and
> that path does not reach the same refresh signal, so nothing re-renders when the plan data first
> arrives.
>
> **Why it is deferred rather than fixed now.** The fix belongs in the sign-in / inbound-merge
> ordering inside `index.html` + `storage.js` — the Firebase sync path, which Hard Rule 9 and the
> risk gate treat as red zone, and `index.html` is the large navigate-by-CODEMAP file. Changing
> plan-surface refresh ordering to cure a cosmetic one-reload delay is exactly the "architectural
> change for a minor UI problem" the task scope rules out. It loses no data, misreports nothing,
> and self-corrects on any reload.
>
> **Suggested follow-up task.** Make the legacy inbound-merge path call
> `refreshAuthoritativePlanSurfaces()` (or at minimum `refreshCommitmentSurfaces()`) once the first
> post-sign-in plan snapshot has been applied, with a regression test that asserts Unfinished
> renders after sign-in without a reload. Red-zone: needs its own owner-approved task.
>
> Deviation recorded: the canary is a pre-existing Google account of the owner's rather than the
> "NEW dedicated non-personal" account section 5 specified. Its ChronaSense room contains only
> `plans/2026-10-16` and `settings` and never held real data, so the contamination risk that
> precondition guards against is absent.
>
> ### Day 1 canary — drift-corrected procedure (as executed)
>
> Day 0 ran 2026-10-16; its tasks are in `plans/2026-10-16`, now 5 days old. Verified immediately
> before writing this: function ACTIVE on `chronasensecompletionapi-00002-vin`, Action API still
> `chronasenseactionapi-00007-mon`, 6 alert policies enabled, canary room = `{plans, settings}` with
> `plans/2026-10-16` and `settings.timezone="America/Phoenix"`, `taskCompletionResolutions` **null**,
> unauthenticated POST -> 401. Do NOT re-run Day 0 and do NOT redeploy B1/B2.
>
> Substitutions for the five-day drift — everywhere section 5 step 2 says a relative day, use an
> explicit historical date:
>
> | Runbook wording | Use instead |
> |---|---|
> | "tasks are now unfinished history" | true, and more so: they are 5 days stale, which is the real subject of this feature |
> | Task 2 "Done earlier (yesterday)" | **Done earlier -> explicitly pick 2026-10-16**, the task's own plan date (the most defensible assertion, and it exercises a 5-day-old date rather than an off-by-one) |
> | "reload (task 2 stays resolved)" | unchanged |
> | expected receipt `date` | `2026-10-16` for task 2; today's account-zone date for task 1 |
> | account zone in every receipt | `America/Phoenix` |
>
> Expected outcomes, stated in advance so a surprise is recognisable:
> - Task 1 Done today -> `CONFIRMED`, receipt `date` = today in **America/Phoenix** (not the device zone).
> - Task 1 Undo -> `CONFIRMED`, state back to `open`, the completion receipt **retained**, revision +1.
> - Task 2 Done earlier 2026-10-16 -> `CONFIRMED`, survives reload and a second fresh profile.
> - Task 3 offline -> refusal toast `SOURCE_UNAVAILABLE`, and **nothing written** (verify the node).
> - Task 4 untouched -> remains absent from `taskCompletionResolutions`.
> - Throughout: `rooms/uid_<owner>` unchanged; zero log entries containing the canary uid, e-mail or
>   task text; no `unconfirmedWrite`, no 5xx, no alert.
>
> **Authentication is the blocker, and it is deliberate.** Production Auth is Google-only, the canary
> is a `google.com` account, and no canary credential is stored anywhere in the repo or the evidence
> directory. The session can only be established by a human signing in as the canary. Minting a token
> for that UID out of band was considered and rejected: it is credential exploration, it would need an
> IAM grant this packet explicitly forbids (TokenCreator), and it would prove the backend while
> bypassing the very UI path the canary exists to exercise.
>
> Nothing in this reconciliation changed production. Gate C (merge of PR #7) has **not** been taken.


Supersedes `staging/task-018/GATE_B_PACKET.md` for execution. Production project `time-audit-3c3da`.
- Release candidate: PR #7 @ `08e9371be7c56961a0c074e1041962adef4eac0c` (hosted CI green; independent final-diff review PASS).
- Tooling: run `release/task-018/*` and `staging/task-018/monitoring/*` from branch `task-018-monitoring` at the tooling
  commit named in the approval packet (the preflight pins the candidate SHA and the live Action API revision).
- Operator: owner account (existing Owner); Firebase CLI 15.2.1; Node 22.23.3. `WT` = the task-018-monitoring worktree,
  `REPO` = any clone containing the candidate SHA, `ART` = `D:\chronasense-prod-artifact\src` (outside every repo).
- Run ONE command at a time; stop on any unexpected non-zero exit. Every command names `time-audit-3c3da`.

## 0. Artifact, env and baselines (read-only)
```
git -C REPO -c core.autocrlf=false archive 08e9371be7c56961a0c074e1041962adef4eac0c --prefix=src/ -o D:\chronasense-prod-artifact\src.tar
tar -xf src.tar                                                  (inside D:\chronasense-prod-artifact)
node WT\release\task-018\prod-ops.mjs env --artifact ART            (keys printed, values never)
node WT\release\task-018\prod-ops.mjs snapshot --out D:\chronasense-prod-evidence\before
node WT\release\task-018\prod-preflight.mjs --phase before-identities --repo REPO --sha 08e9371be7c56961a0c074e1041962adef4eac0c --artifact ART --report D:\chronasense-prod-evidence\preflight-0.json
```
`core.autocrlf=false` is mandatory (byte-exact comparison). Preflight PASSED 24/24 on 2026-10-16 (owner timezone present).

## 1. Identities (IAM)
```
gcloud iam roles create chronasenseCompletionRuntime --project=time-audit-3c3da --title="ChronaSense completion runtime" --permissions=firebasedatabase.instances.get,firebasedatabase.instances.update,firebaseauth.users.get --stage=GA
gcloud iam service-accounts create chronasense-completion --project=time-audit-3c3da --display-name="ChronaSense completion runtime"
gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-completion@time-audit-3c3da.iam.gserviceaccount.com --role=projects/time-audit-3c3da/roles/chronasenseCompletionRuntime --condition=None
gcloud iam service-accounts create chronasense-build --project=time-audit-3c3da --display-name="ChronaSense completion build"
gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-build@time-audit-3c3da.iam.gserviceaccount.com --role=roles/cloudbuild.builds.builder --condition=None
gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-build@time-audit-3c3da.iam.gserviceaccount.com --role=roles/artifactregistry.writer --condition=None
gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-build@time-audit-3c3da.iam.gserviceaccount.com --role=roles/logging.logWriter --condition=None
gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-build@time-audit-3c3da.iam.gserviceaccount.com --role=roles/storage.objectViewer --condition=None
node WT\release\task-018\prod-preflight.mjs --phase before-b1 ...    (exactly these grants; no impersonation bindings; rules not yet deployed)
```

## 2. Monitoring before any backend exists (no cost; no false gaps)
```
gcloud logging metrics create completion_requests --project=time-audit-3c3da --config-from-file=WT\staging\task-018\monitoring\completion_requests.yaml
gcloud logging metrics create completion_latency --project=time-audit-3c3da --config-from-file=WT\staging\task-018\monitoring\completion_latency.yaml
gcloud logging metrics create completion_cas_conflicts --project=time-audit-3c3da --config-from-file=WT\staging\task-018\monitoring\completion_cas_conflicts.yaml
gcloud logging metrics create completion_alerting_events --project=time-audit-3c3da --config-from-file=WT\staging\task-018\monitoring\completion_alerting_events.yaml
gcloud beta monitoring channels create --project=time-audit-3c3da --channel-content-from-file=<copy of WT\release\task-018\alerts\channel-email.json with OWNER_EMAIL filled locally>
gcloud alpha monitoring policies create --project=time-audit-3c3da --policy-from-file=<copy of each alerts\0N-*.json with NOTIFICATION_CHANNEL = the channel name>   (6 times)
```
All six policy definitions were accepted by the Cloud Monitoring API in staging (created without channels, deleted).

## 3. Rules (B1)
First confirm the Firebase CLI identity (separate from gcloud): `firebase login:list` must show only the owner account.
```
firebase deploy --project time-audit-3c3da --only database --non-interactive        (run inside ART)
node WT\release\task-018\prod-preflight.mjs --phase before-b2 ...    (now requires live rules == candidate)
```
Rollback copy: `D:\chronasense-prod-evidence\before\rules-*.json` (from step 0). Old clients are unaffected.

## 4. Backend with the one-time first-build exception (B2)
**Explicit exception, not least privilege.** The Firebase CLI cannot set a build identity, so the FIRST build of the new
function runs as the project's default build identity, the compute SA `548433155531-compute@…`, which holds `roles/editor`
and already builds and runs the Action API. No new privilege is granted; it builds only the byte-verified reviewed
artifact; the exception ends at 4c. No narrow-build-first alternative is offered (`gcloud functions deploy
--build-service-account` is unproven here and bypasses Firebase param/invoker handling).
```
4a npm ci --prefix functions                                         (inside ART; adds only node_modules)
4b firebase deploy --project time-audit-3c3da --only functions:chronasenseCompletionApi --non-interactive   (inside ART)
4c node WT\release\task-018\prod-ops.mjs patch-build-sa --confirm-production
4d gcloud builds list --project=time-audit-3c3da --region=asia-southeast1 --limit=1 --format="value(status,serviceAccount)"
```
- 4b expected exit: production `gcf-artifacts` has NO cleanup policy (checked 2026-10-16), so the CLI deploys and then exits
  non-zero with "Functions successfully deployed but could not set up cleanup policy" (seen identically in staging). Proceed to
  4c ONLY if the output also contains "Successful create operation" for `chronasenseCompletionApi`; any other failure = STOP.
  Setting a cleanup policy on the shared repo is a separate owner decision (it also prunes Action API images).
- 4c PATCHes only `buildConfig.serviceAccount`, rebuilds the same uploaded source as `chronasense-build`, and verifies
  state ACTIVE + build SA + runtime SA. 4d must show SUCCESS and `chronasense-build`.
- Then verify: `gcloud functions describe chronasenseCompletionApi --region=asia-southeast1 --project=time-audit-3c3da
  --format="value(state,buildConfig.serviceAccount,serviceConfig.serviceAccountEmail,serviceConfig.maxInstanceCount,serviceConfig.maxInstanceRequestConcurrency)"`
  = ACTIVE, chronasense-build, chronasense-completion, 1, 1;
  `gcloud run services get-iam-policy chronasensecompletionapi --region=asia-southeast1 --project=time-audit-3c3da` = allUsers invoker only;
  `node WT\release\task-018\prod-ops.mjs snapshot --out D:\chronasense-prod-evidence\after-b2` and diff vs `before`:
  project IAM = only the step-1 bindings; secret IAM identical; Action API revision `chronasenseactionapi-00007-mon` unchanged;
  unauthenticated POST to the endpoint returns `401 {"outcome":"REJECTED","reason":"UNAUTHENTICATED"}`.
- If 4c errors (e.g. a network blip while polling): do not re-run blindly — run 4d and the describe command above. If the
  build SA is set and ACTIVE, continue; if the switch never happened, re-run 4c once; if the function is unhealthy or the
  switch keeps failing, STOP and roll back with §6 (delete the function; the compute-SA-built version must not stay live).
Later CLI deploys preserve the build SA (proven in staging B0).

## 5. Production canary (B4) — synthetic records only, old UI still live
Preconditions: steps 0–4 verified; PR #7 NOT merged; a NEW dedicated non-personal Google account; owner's
`rooms/uid_<owner>/taskCompletionResolutions` is null (read-only shallow GET).
1. Day 0: fresh browser profile; serve the candidate `www` UNCHANGED (production config) at exactly `https://localhost`
   (reviewed CORS origin; `localhost` is an authorized Auth domain). Sign in as the canary; add `Canary <date> 1..4` to today.
2. Day 1, same profile, DevTools network log on. Confirm requests go only to
   `asia-southeast1-time-audit-3c3da.cloudfunctions.net/chronasenseCompletionApi` with a Bearer ID token.
   - Task 1: Done today → "Completion saved" → Undo → "Completion undone" → Done today again.
   - Task 2: Done earlier (yesterday) → reload → still resolved; second fresh profile, same account → resolved.
   - Task 3: DevTools offline → click → "Not saved · SOURCE_UNAVAILABLE" → online; nothing written.
   - Task 4: left open (control).
3. Verify read-only: receipts only under `rooms/uid_<canary>/taskCompletionResolutions` (expected revisions, dates, the
   canary's account zone); owner's node still null; logs = one `completion-request` per endpoint call, zero hits for canary
   uid/email/task text; no `unconfirmedWrite`, `completion-unavailable` or 5xx alerts.
4. STOP on any unexpected outcome or toast, any write outside the canary room, any log leak, any alert, any latency > 15 s;
   then roll back (§6) and report. Canary records are retained as evidence.

## 6. Rollback (receipts always preserved)
- Never delete or rewrite `taskCompletionResolutions` or client pending receipts.
- Backend: `firebase functions:delete chronasenseCompletionApi --region asia-southeast1 --project time-audit-3c3da`
  (interactive confirm; removes the endpoint only; cached clients keep uncertain commands and recover later).
- Rules: keep the deny; it is redundant with the root `.write: false`, so restoring the step-0 backup cannot expose records.
- Identities, metrics and policies may stay (unused) or be removed with explicit approval; none touches data.
- Frontend (only after Gate C): forward revert on protected `main`, never force-push.

## 7. Gate C (separate approval)
Squash-merge PR #7 (keeps historical design blobs and local paths off `main`) → Pages publishes → owner real use.
