# TASK-018 Gate B — production approval packet (prepared 2026-10-16; NOTHING applied)

Target: production project `time-audit-3c3da` (RTDB `time-audit-3c3da-default-rtdb`, asia-southeast1).
Candidate: branch `task-018-candidate` @ `60b471a` = reviewed `07f77d4` + monitoring `9349963`/`ea10342` (tree-identical
to reviewed `ea10342`) + doc clarification. Staging evidence: API 53/53, browser 22/22, zero production requests.

## Preconditions (all required before B1)
- P1 Hosted CI green on the candidate PR (Node 22, `npm test`, smoke, Firebase fence). No push has happened yet.
- P2 **Build-identity proof in staging (B0)**: a deploy of the completion function in `chronasense-staging-t018`
  succeeds using a dedicated build SA (staging compute SA no longer has Editor, so this is a clean test). Until the
  mechanism (Firebase CLI vs `gcloud functions deploy --build-service-account`) is proven, B2 cannot run without
  the production compute SA's Editor — which must NOT be removed: it is the existing Action API runtime.
- P3 Read-only production snapshot (functions list, IAM policy, RTDB rules) saved; prior Pages SHA recorded.
- P4 Production deploy env values prepared in a disposable artifact outside the repo; a production variant of the
  env gate (the staging gate deliberately refuses production) checks RTDB URL/SA/apiKey against production.
- P5 Canary identity = a NEW dedicated, non-personal **Google** account (production has only Google sign-in;
  do not enable Email/Password in production). Synthetic tasks only, created through the UI.

## Identities (least privilege; mirrors what staging proved)
| Identity | Grant | Proven |
|---|---|---|
| Runtime `chronasense-completion@time-audit-3c3da` | custom role `chronasenseCompletionRuntime` = `firebasedatabase.instances.get`, `firebasedatabase.instances.update`, `firebaseauth.users.get` | Yes (staging: checkRevoked, export reads, CAS writes) |
| Build `chronasense-build@time-audit-3c3da` | `roles/cloudbuild.builds.builder`, `roles/artifactregistry.writer`, `roles/logging.logWriter`, `roles/storage.objectViewer` | **No — B0** |
| Deployer (owner user, existing Owner) | `iam.serviceAccountUser` scoped to the two SAs above (Owner already implies it) | n/a |
| Invoker | `allUsers` → `roles/run.invoker` on `chronasensecompletionapi` ONLY | Yes (staging: 401 + reads=0 for bad/revoked tokens) |
Never: Owner/Editor/TokenCreator/Secret access for the runtime SA; no change to the Action API or its SA; no
production HMAC secret access for completion. Known breadth: `instances.update` = whole-instance data + rules.

## Exact order (each step one command, stop on any non-zero exit)
1. B1 Rules: `firebase deploy --project time-audit-3c3da --only database --non-interactive` (adds only the explicit
   resolution write-deny). Verify: rules hash = candidate builder output; production smoke of ordinary writes.
2. B2 Backend: `firebase deploy --project time-audit-3c3da --only functions:chronasenseCompletionApi --non-interactive`
   from the disposable artifact; `firebase functions:artifacts:setpolicy --project time-audit-3c3da --location asia-southeast1`.
   Verify: function list = existing Action API + completion only; Cloud Run SA = runtime SA; concurrency 1, max 1;
   invoker only on completion; secret IAM unchanged; `chronasenseActionApi` revision unchanged.
3. B3 Monitoring: create the 4 log metrics (`staging/task-018/monitoring/*.yaml`, severity via `EXTRACT(severity)`)
   and alert policies → owner email: any `unconfirmedWrite`; any `completion-unavailable`; any `sizeRefusal`;
   `CONTENDED` > 3 per hour; handler latency p95 > 4 s over 15 min; 5xx > 0. Group alerts by `uncertain`.
4. B4 Canary (backend only, old UI still live): canary account completes/undoes synthetic tasks via a reviewed
   production-canary procedure; log scan = one event per request, zero forbidden strings.
5. Gate C (separate approval): merge candidate PR → Pages publishes → canary UI pass → owner real use.

## Rollback and receipt preservation
- Resolution records and client pending receipts are NEVER deleted or rewritten by any rollback.
- Backend stop: `firebase functions:delete chronasenseCompletionApi --region asia-southeast1 --project time-audit-3c3da`
  (endpoint only; data intact; cached clients keep uncertain commands and recover when it returns).
- Rules: keep the deny (harmless to old clients). Restore saved rules only on a proven rules regression.
- Frontend: forward revert on `main` (never force-push); old UI ignores resolution facts (proven with cf43080).

## Operating cost (staging measurements; production unmeasured)
- Per completion ≈ 3 full-room reads by the function (inspect + read + readback): 0.5 MiB room ≈ 1.5 MiB, 8 MiB ≈ 24 MiB.
- Client re-inspects on changes in 10 room namespaces (150 ms debounce); a staging browser session used ~38 calls.
  Each inspect is a full room read → read volume scales with room size × edit frequency. Measure the owner's real
  room size read-only before B2 and set the RTDB download alert accordingly (10 GB/month no-cost quota).
- Staging full cycle: ~160 MB RTDB download, ~100 function requests, 1 build — estimated ≤ US$0.05.
- Budget alerts (existing $2/$5 production budgets) are notifications only; neither has an automated cap.

## Residual risks (owner must accept or defer)
1. Fresh-device zone mismatch: in-app zone `UTC` vs account `Etc/UTC` did not converge in 15 s; server refuses with
   `ACCOUNT_ZONE_CHANGED` (safe, nothing written) and the UI shows "Not saved · ACCOUNT_ZONE_CHANGED". Real users
   whose device zone name differs from the account setting cannot complete until settings match.
2. Old-client edits flag every resolved-or-undone task in the edited plan as "Changed or ambiguous" (locked) — honest,
   conservative, possibly noisy.
3. Public invoker without App Check / per-user rate limit; maxInstances 1 bounds compute, not RTDB read cost from an
   authenticated abuser. Budget alerts do not cap spend.
4. `main` is unprotected and Pages publishes on every push; TASK-018 design/prototype files in the candidate become
   publicly served.
5. Runtime RTDB permission is instance-wide (`instances.update`); the code lens is the only path boundary.
