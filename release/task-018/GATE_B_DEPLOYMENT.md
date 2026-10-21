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
> **Independent final-diff review.** The PASS recorded below is a claim carried in this runbook; no
> review artifact is archived in the repository and `REVIEW.md` has no TASK-018 entry. Treat it as
> reported, not re-verified.
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
