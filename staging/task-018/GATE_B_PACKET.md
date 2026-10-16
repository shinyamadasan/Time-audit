# TASK-018 Gate B — production approval packet (revised 2026-10-16; NOTHING applied to production)

Production: project `time-audit-3c3da`, RTDB `time-audit-3c3da-default-rtdb` (asia-southeast1), Pages = legacy `main:/`.
Candidate: `task-018-candidate` @ `08e9371` = reviewed `07f77d4` + monitoring (tree-identical to reviewed `ea10342`)
+ account-zone fix `0f762aa`/`7bf4961` (independently reviewed, PASS WITH NOTES) + docs + design files removed.
Evidence (isolated staging `chronasense-staging-t018`): API 53/53; browser 24/24 on the fix, zero production
requests; B0 build identity proven. `main` is now protected (required: `test`, `Firebase fence / rules integration`).

## What staging proved
| Item | Result |
|---|---|
| Runtime custom role (`firebasedatabase.instances.get`, `.update`, `firebaseauth.users.get`) | Sufficient: checkRevoked, export reads, conditional PUTs |
| Dedicated build SA (`cloudbuild.builds.builder`, `artifactregistry.writer`, `logging.logWriter`, `storage.objectViewer`) | Builds succeed; no Editor/Owner. Minimality NOT proven (builder may already cover the other three) |
| Build SA mechanism | Firebase CLI 15.2.1 has no build-SA option, but its update mask omits `buildConfig.serviceAccount`, so a value set via the Cloud Functions API is PRESERVED by later `firebase deploy` (observed: build ran as `chronasense-build`) |
| Default build identity | `gcloud builds get-default-service-account`: compute SA in BOTH projects. In production that SA holds Editor and is the live Action API runtime — do not modify it |
| Fresh-device zone | Fixed: completion uses `rooms/<uid>/settings/timezone`; device "UTC" vs account "Etc/UTC" now saves in the account zone |

## Preconditions (all required before B1)
- P1 PR CI green on the exact candidate SHA (Linux, Node 22). Owner reviews the PR. NOT merged (merge = Gate C).
- P2 Read-only snapshot immediately before B1: functions list, project IAM, RTDB rules export, Pages SHA.
- P3 Owner's real room has `settings.timezone` (read-only, owner's own data). If absent, completion refuses with
  `ACCOUNT_ZONE_UNAVAILABLE` until the app's Settings writes it — decide before Gate C.
- P4 Disposable deploy artifact outside every repo: `git archive <candidate SHA>`, `npm ci --prefix functions`,
  `node scripts/functions-shared.mjs`, `functions/.env.time-audit-3c3da` (RTDB URL, web API key, completion SA,
  and the EXISTING Action API owner params). **Missing tooling:** a production env gate (the staging gate refuses
  production by design) — to be written and reviewed; until then B2 is blocked.
- P5 **Missing:** alert-policy definitions + notification channel (only the 4 metric YAMLs exist, from
  `task-018-monitoring` ≥ `a48324a`, severity via `EXTRACT(severity)`) — to be written and reviewed before B3.
- P6 Canary identity: a NEW dedicated non-personal Google account (production Auth is Google-only; do not enable
  Email/Password). See "Production canary procedure".

## Identities (production; mirrors staging)
```
gcloud iam roles create chronasenseCompletionRuntime --project=time-audit-3c3da --title="ChronaSense completion runtime" --permissions=firebasedatabase.instances.get,firebasedatabase.instances.update,firebaseauth.users.get --stage=GA
gcloud iam service-accounts create chronasense-completion --project=time-audit-3c3da
gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-completion@time-audit-3c3da.iam.gserviceaccount.com --role=projects/time-audit-3c3da/roles/chronasenseCompletionRuntime --condition=None
gcloud iam service-accounts create chronasense-build --project=time-audit-3c3da
for R in roles/cloudbuild.builds.builder roles/artifactregistry.writer roles/logging.logWriter roles/storage.objectViewer; do gcloud projects add-iam-policy-binding time-audit-3c3da --member=serviceAccount:chronasense-build@time-audit-3c3da.iam.gserviceaccount.com --role=$R --condition=None; done
```
Invoker: `allUsers` → `roles/run.invoker` on `chronasensecompletionapi` only (Firebase CLI applies it for a new HTTPS
function). Never: Editor/Owner/TokenCreator/secret access for either SA; no change to `chronasenseActionApi` or the
compute SA. Known breadth: `instances.update` = whole-instance data + rules access.

**First-build caveat (owner decision):** a brand-new function's FIRST build cannot have the build SA preset via the
CLI. Recommended: B2 creates the function (one build by the existing default identity — the same one that builds
the Action API today, no new privilege), then immediately PATCH `buildConfig.serviceAccount` (as in B0) which
rebuilds with `chronasense-build`; all later CLI deploys preserve it. Alternative (unproven): create via
`gcloud functions deploy --build-service-account` — skips Firebase param/invoker handling; not recommended.

## Exact order (one command at a time; stop on any non-zero exit)
1. B1 Rules. Pre-check: re-export live rules; the diff vs the candidate builder output must be exactly
   `rooms/$roomId/taskCompletionResolutions/.write = false`, else STOP.
   `firebase deploy --project time-audit-3c3da --only database --non-interactive`; verify the export equals the builder output.
2. B2 Backend (from the P4 artifact): `firebase deploy --project time-audit-3c3da --only functions:chronasenseCompletionApi --non-interactive`
   → PATCH build SA (B0 procedure) → `firebase functions:artifacts:setpolicy --project time-audit-3c3da --location asia-southeast1`
   (note: this sets cleanup on the `gcf-artifacts` repo shared with the Action API; review its current policy first).
   Verify: function list = Action API + completion; Cloud Run SA = runtime SA; concurrency 1, max 1; invoker only on
   completion; whole-project IAM before/after diff = only the planned bindings; `chronasenseActionApi` revision unchanged.
3. B3 Monitoring: 4 log metrics + P5 alert policies → owner email: any `unconfirmedWrite` (group by `uncertain`);
   any `completion-unavailable`; any `sizeRefusal`; `CONTENDED` > 3/hour; handler p95 > 4 s over 15 min; 5xx > 0.
4. B4 Production canary (below). Stop on any failure.
5. Gate C (separate approval): merge PR → Pages publishes → owner real use → TASK-018 closure.

## Production canary procedure (prepared, not executed)
Backend-only canary while the old UI stays live. No privileged writes, no seeding, no personal data.
1. Day 0: in a fresh browser profile, serve the candidate `www` UNCHANGED (production config) at exactly
   `https://localhost` (reviewed CORS origin; production Auth already authorizes `localhost`). Sign in with the canary
   Google account; create 4 tasks named `Canary <date> 1..4` in today's plan. Sign out. Nothing else.
2. Day 1 (tasks are now unfinished history): sign in again (same profile) and run, with DevTools request log on:
   Done today on task 1 → Undo → Done earlier (yesterday) on task 2 → reload (task 2 stays resolved) → View all.
   Task 3: DevTools offline → click → "Not saved · SOURCE_UNAVAILABLE" → online. Task 4 left open.
3. Verify (read-only): canary room only (`rooms/uid_<canary>/taskCompletionResolutions`) holds the expected receipts;
   owner's room unchanged; logs: one `completion-request` per endpoint call, zero hits for canary uid/email/task text;
   no `unconfirmedWrite`, no 5xx; request log contains no non-production/staging hosts.
4. Stop conditions: any unexpected outcome, any write outside the canary room, any log leak, any alert.
   Then: function delete (rollback) and report. Canary data is retained as evidence.

## Rollback and receipt preservation
- Never delete or rewrite `taskCompletionResolutions` or client pending receipts.
- Backend: `firebase functions:delete chronasenseCompletionApi --region asia-southeast1 --project time-audit-3c3da`
  (interactive confirm; endpoint only; data intact; cached clients keep uncertain commands and recover later; a
  later redeploy re-applies the invoker).
- Rules: keep the deny. It is redundant with the root `.write: false` (rooms have no `.write`), so restoring the saved
  pre-B1 rules does not expose resolution records either.
- Frontend: forward revert on `main` (protected; never force-push). Old UI ignores resolution facts (proven, cf43080).

## Operating cost (staging-measured; production unmeasured)
- Per UI completion: ≥ 4 full-room reads (pre-inspection, server read, readback, post-confirm inspection; +1 per CAS
  retry) plus one full-room conditional PUT. Plus re-inspections on changes in 10 room namespaces (~38 endpoint calls
  in a staging browser session). Measure the owner's room size (read-only) before B2 and set an RTDB download alert.
- Staging totals so far: ~160 MB RTDB download (API run), ~300 function requests, 5 builds; estimated ≤ US$0.10.
- Existing production budgets ($2 and $5) are e-mail alerts only — no automated cap.

## Residual risks (owner must accept or defer)
1. Old-client edits flag resolved-or-undone tasks in the edited plan "Changed or ambiguous" (locked) — honest, noisy.
2. Public invoker without App Check/per-user rate limit: maxInstances 1 bounds compute, not authenticated RTDB read
   cost. Budget alerts do not cap spend.
3. Runtime RTDB permission is instance-wide (`instances.update`); the code's resolution-only lens is the boundary.
4. First production build runs under the default (Editor) identity unless the alternative path is chosen.
5. Web-only release: installed Android APKs keep the old UI (compatible); Android acceptance deferred.
6. A completion near midnight with device/server clock skew can be refused (safe, retry).
