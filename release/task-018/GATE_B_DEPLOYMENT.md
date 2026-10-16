# TASK-018 Gate B — production deployment procedure (prepared 2026-10-16; NOT executed)

Supersedes `staging/task-018/GATE_B_PACKET.md` for execution. Production project `time-audit-3c3da`.
Candidate: PR #7 @ `08e9371be7c56961a0c074e1041962adef4eac0c` (hosted CI green; independent final-diff review PASS).
Operator: the owner account (existing Owner). Firebase CLI 15.2.1, Node 22.23.3. Run ONE command at a time and
stop on any non-zero exit. Every command names `--project=time-audit-3c3da`; nothing uses a default project.

## 0. Immutable artifact + preflight (read-only; already PASSED 23/23 on 2026-10-16)
```
git -C <repo> -c core.autocrlf=false archive 08e9371be7c56961a0c074e1041962adef4eac0c --prefix=src/ -o D:\chronasense-prod-artifact\src.tar
tar -xf src.tar   (run inside D:\chronasense-prod-artifact)
# functions/.env.time-audit-3c3da: 5 keys; shared Action API params copied from the LIVE Action API config (never printed)
node release/task-018/prod-preflight.mjs --phase before-identities --repo <repo> --sha 08e9371be7c56961a0c074e1041962adef4eac0c --artifact D:\chronasense-prod-artifact\src
```
`core.autocrlf=false` is mandatory: the preflight compares every file byte-for-byte with the reviewed blobs.
Re-run the preflight immediately before each step below; any FAIL = STOP.

## 1. Identities (IAM — needs approval)
```
gcloud iam roles create chronasenseCompletionRuntime --project=time-audit-3c3da --title="ChronaSense completion runtime" --permissions=firebasedatabase.instances.get,firebasedatabase.instances.update,firebaseauth.users.get --stage=GA
gcloud iam service-accounts create chronasense-completion --project=time-audit-3c3da --display-name="ChronaSense completion runtime"
gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-completion@time-audit-3c3da.iam.gserviceaccount.com --role=projects/time-audit-3c3da/roles/chronasenseCompletionRuntime --condition=None
gcloud iam service-accounts create chronasense-build --project=time-audit-3c3da --display-name="ChronaSense completion build"
gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-build@time-audit-3c3da.iam.gserviceaccount.com --role=roles/cloudbuild.builds.builder --condition=None
gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-build@time-audit-3c3da.iam.gserviceaccount.com --role=roles/artifactregistry.writer --condition=None
gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-build@time-audit-3c3da.iam.gserviceaccount.com --role=roles/logging.logWriter --condition=None
gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-build@time-audit-3c3da.iam.gserviceaccount.com --role=roles/storage.objectViewer --condition=None
node release/task-018/prod-preflight.mjs --phase before-b2 ...        # must PASS: exactly these grants, nothing else
```

## 2. Rules first (B1)
```
curl (operator token) GET https://time-audit-3c3da-default-rtdb.asia-southeast1.firebasedatabase.app/.settings/rules.json > rules-backup-<UTC>.json
firebase deploy --project time-audit-3c3da --only database --non-interactive        (from D:\chronasense-prod-artifact\src)
```
Verify: live export now equals the artifact's `firebase.rules.json` (the only delta is
`rooms/$roomId/taskCompletionResolutions/.write = false`, pre-verified by the preflight). Old clients are unaffected.

## 3. Backend with the one-time first-build exception (B2)
**Explicit exception, not least privilege:** the Firebase CLI cannot set a build identity, so the FIRST build of the
new function runs as the project's default build identity, the compute SA `548433155531-compute@…`, which holds
`roles/editor` and already builds and runs the Action API. No new privilege is granted; the build runs the
byte-verified reviewed artifact; the exception ends at step 3c.
```
3a npm ci --prefix functions                       (artifact dir; adds only node_modules)
3b firebase deploy --project time-audit-3c3da --only functions:chronasenseCompletionApi --non-interactive
3c PATCH https://cloudfunctions.googleapis.com/v2/projects/time-audit-3c3da/locations/asia-southeast1/functions/chronasenseCompletionApi?updateMask=buildConfig.serviceAccount
     body {"buildConfig":{"serviceAccount":"projects/time-audit-3c3da/serviceAccounts/chronasense-build@time-audit-3c3da.iam.gserviceaccount.com"}}
   (poll the returned operation until done; this rebuilds the SAME uploaded source with chronasense-build)
3d gcloud builds list --project=time-audit-3c3da --region=asia-southeast1 --limit=1 --format="value(status,serviceAccount)"   # SUCCESS + chronasense-build
```
Verify after 3d: `gcloud functions describe … --format="value(state,buildConfig.serviceAccount,serviceConfig.serviceAccountEmail,serviceConfig.maxInstanceCount,serviceConfig.maxInstanceRequestConcurrency)"`
= ACTIVE, chronasense-build, chronasense-completion, 1, 1; invoker policy = `allUsers` on `chronasensecompletionapi` only;
`chronasenseActionApi` revision unchanged; whole-project IAM diff vs pre-step-1 = only the step-1 bindings; secret IAM unchanged;
unauthenticated POST returns `401 {"outcome":"REJECTED","reason":"UNAUTHENTICATED"}`. Later CLI deploys preserve the build
SA (proven in staging B0). Artifact cleanup policy: inspect the existing `gcf-artifacts` policy first (shared with the
Action API); only then `firebase functions:artifacts:setpolicy --project time-audit-3c3da --location asia-southeast1`.
No narrow-build-first alternative is offered: `gcloud functions deploy --build-service-account` is unproven here and
bypasses the Firebase param/invoker handling.

## 4. Monitoring (B3)
```
gcloud logging metrics create <m> --project=time-audit-3c3da --config-from-file=staging/task-018/monitoring/<m>.yaml   (4 metrics)
gcloud beta monitoring channels create --project=time-audit-3c3da --channel-content-from-file=release/task-018/alerts/channel-email.json   (OWNER_EMAIL filled locally)
gcloud alpha monitoring policies create --project=time-audit-3c3da --policy-from-file=<policy with NOTIFICATION_CHANNEL replaced>   (6 policies)
```
All six definitions were accepted by the Cloud Monitoring API in staging (created without channels, then deleted).

## 5. Production canary (B4) — synthetic records only
Preconditions: steps 1–4 verified; Pages still serves the OLD UI (PR not merged); a NEW dedicated non-personal Google
account; owner's room checked read-only (`rooms/uid_<owner>/taskCompletionResolutions.json?shallow=true` = null).
1. Day 0: fresh browser profile; serve the candidate `www` UNCHANGED (production config) at exactly `https://localhost`
   (reviewed CORS origin; `localhost` is an authorized Auth domain). Sign in as the canary; add `Canary <date> 1..4` to today.
2. Day 1: same profile. Confirm the endpoint identity in DevTools: requests go only to
   `asia-southeast1-time-audit-3c3da.cloudfunctions.net/chronasenseCompletionApi` with a Bearer ID token.
   - Task 1: Done today → "Completion saved" → Undo → "Completion undone" → Done today again.
   - Task 2: Done earlier (yesterday) → reload → still resolved; open a second fresh profile, same account → resolved.
   - Task 3: DevTools offline → click → "Not saved · SOURCE_UNAVAILABLE" → online; nothing written.
   - Task 4: left open (control).
3. Verify read-only: canary receipts exist only under `rooms/uid_<canary>/taskCompletionResolutions` with the expected
   revisions/dates and the canary's account zone; owner's resolutions node still null; logs: one `completion-request`
   per endpoint call, zero hits for canary uid/email/task text, no `unconfirmedWrite`/`completion-unavailable`/5xx alerts.
4. STOP on: any unexpected outcome or toast, any write outside the canary room, any log leak, any alert, any latency
   > 15 s. Then roll back (below) and report. Canary records are retained as evidence.

## 6. Rollback (receipts always preserved)
- Never delete or rewrite `taskCompletionResolutions` or client pending receipts.
- Backend: `firebase functions:delete chronasenseCompletionApi --region asia-southeast1 --project time-audit-3c3da` (interactive
  confirm; removes the endpoint only; cached clients keep uncertain commands and recover later).
- Rules: keep the deny; it is redundant with the root `.write: false`, so even restoring the backup cannot expose records.
- Identities: may stay (unused) or be removed with explicit approval; removing them does not touch data.
- Frontend (only after Gate C): forward revert on protected `main`, never force-push.

## 7. Gate C (separate approval)
Squash-merge PR #7 (keeps historical design blobs and local paths off `main`) → Pages publishes → owner real use.
