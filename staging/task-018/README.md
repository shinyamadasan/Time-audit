# TASK-018 staging preparation (owner-direct, 2026-10-16)

Status: **prepared, not provisioned.** No cloud resource, billing, IAM, secret, rules, Functions or production
data was created or changed. Nothing was merged, pushed or published. Approved UI unchanged.

- Reviewed implementation: `07f77d4` (independent PASS WITH NOTES, unchanged).
- Monitoring delta: `9349963` + review fixes `ea10342` on branch `task-018-monitoring` (independent PASS).
- This kit: `staging/task-018/` (guard, disposable frontend, harness, thresholds, log metrics, log scan).
- Reference: `playwright-report/task-018-production/RELEASE_READINESS_2026-10-16.md` (task-018 worktree, ignored).

## 1. Staging project options

No ChronaSense staging project exists (readiness assessment, re-used, not re-queried). Options:

| Option | Verdict |
|---|---|
| A. **New dedicated project** `chronasense-staging-<suffix>` (Blaze, own billing budget) | **Recommended.** Only option giving separate Auth users, RTDB, IAM, logs and cost attribution. |
| B. Repurpose an unrelated existing Firebase project | Rejected: unknown IAM/data/billing history; isolation cannot be proven. |
| C. Second RTDB instance / function in production project | Rejected: shares Auth, IAM, billing and blast radius with production. |
| D. Emulators only | Already done (14/14). Cannot prove real Auth, IAM, CORS, TLS, latency or cost. |

`guard.mjs` refuses any projectId without `staging` in it, the production projectId/apiKey anywhere, and RTDB hosts
not belonging to the staging project.

## 2. Minimum IAM (staging)

| Identity | Grants | Not granted |
|---|---|---|
| Runtime SA `chronasense-completion@STAGING.iam.gserviceaccount.com` | Custom role `chronasenseCompletionRuntime`: `firebasedatabase.instances.get`, `firebasedatabase.instances.update`, `firebaseauth.users.get` (staging project only) | Owner/Editor, `iam.serviceAccounts.actAs`/token creator, Secret Manager, logging/monitoring admin, any production binding |
| Operator (owner's Google account) | Owner of the **staging** project only (creates it) | Nothing new on production |
| Function invoker | `allUsers` → `roles/run.invoker` on `chronasensecompletionapi` only (public HTTPS; Firebase ID-token auth inside is the boundary) | Invoker on anything else |
| Build | Project default build identity. **Verify** its roles after first deploy; if it holds Editor, replace with `roles/cloudbuild.builds.builder` (+ Artifact Registry writer, logging writer) before testing | — |

Known, accepted breadth (from readiness): `firebasedatabase.instances.update` is full RTDB data + rules access for the
instance; it is not path-scoped IAM. The resolution-only write lens in code is the path boundary.
**Unproven until staging:** whether the custom role is sufficient for RTDB REST with the metadata-server token and
for `verifyIdToken(checkRevoked)`. If not, the fallback (`roles/firebasedatabase.admin` + `roles/firebaseauth.viewer`)
is broader and needs explicit owner approval at that point; the harness fails with `UNAVAILABLE`/401 if it is
insufficient, so the gap cannot pass silently. Stdout logging needs no runtime grant on Cloud Run; S-MON verifies.

## 3. Isolated frontend

`node staging/task-018/frontend.mjs build --config STAGING_CONFIG.json --out D:\chronasense-staging\site`

- Copies the reviewed `www/` closure, replaces **only** the four public `firebaseConfig` values in `storage.js`
  (test proves exactly 4 lines differ; all other files byte-identical), refuses output inside the repo, writes a
  SHA-256 manifest, and runs the static verifier: zero production project/apiKey references or build fails.
- Completion endpoint derives from `projectId` → `asia-southeast1-STAGING.cloudfunctions.net`.
- Serve at exactly `https://localhost` (port 443, mkcert-trusted cert) — already in the reviewed CORS list. Use a
  **fresh browser profile per run** (service worker and localStorage are per-origin; never a profile that ever
  ran ChronaSense). Production static host `shinyamadasan.github.io` (sounds/share fallback; never data) is listed
  by the verifier and **blocked at runtime**.

### Proof that staging cannot reach production (layers)

1. Separate project, Auth tenant, RTDB, SA, credentials; no cross-project IAM. Read-only check before and after:
   `gcloud projects get-iam-policy time-audit-3c3da --format=json` contains no `STAGING` principal.
2. Static artifact verifier (above) — build fails on any production data-plane identifier.
3. Harness: every request goes through `guardedFetch` (https + exact staging host allowlist + production-marker
   refusal); tested against prod RTDB/functions/apiKey URLs, Pages and arbitrary hosts.
4. Browser runs: Playwright `context.route('**/*', …)` aborts and records any URL containing `time-audit-3c3da`,
   the production apiKey or `shinyamadasan.github.io`; run fails if the recorded list is non-empty. HAR retained.
5. Runtime SA exists only in staging; dotenv params point at staging RTDB; `assertStagingConfig` refuses mixes.

## 4. Automated staging tests

`harness.mjs` (API level, real endpoint, synthetic rooms, two dedicated email/password users A/B):

| Check | Proves |
|---|---|
| `auth:*` | missing/malformed/garbage (+ optional wrong-project, revoked) tokens → 401 before any read |
| `single:complete`, `latency:single` | 10 sequential completions on a 22-task room; p50/p95/max thresholds |
| `replay:same-operation` | same UUID twice → identical receipt |
| `unknown:recover-same-uuid` | discarded response → `status` CONFIRMED → uncertain retry CONFIRMED (never new UUID) |
| `compete:one-head` | two intents, same expected revision → exactly one CONFIRMED |
| `undo:exact-revision`, `undo:newer-source-refused` | conditional Undo; newer source refuses with no overwrite |
| `isolation:cross-account`, `isolation:direct-write-denied` | B cannot affect A; rules deny direct resolution writes |
| `concurrency:all-resolved` | 5 parallel completions, ≤3 rounds, zero UNKNOWN, siblings byte-identical |
| `heartbeat:explicit-contention` | sibling heartbeat during completions: no UNKNOWN, no sibling loss, contention explicit |
| `size:*`, `size:oversize-refused` | 0.5/2/8 MiB rooms meet p95; 16 MiB+64 KiB refused `ROOM_TOO_LARGE`, nothing written |
| `latency:no-near-timeout` | no call ≥ 15 s (client timeout 20 s) |

Self-test (`node --test staging/task-018/staging.test.js`, 5/5): guard, artifact isolation, synthetic rooms, all
scenarios against the real handler, **negative control** (lost-ack backend ⇒ NO-GO), log scanner.

**Seeding finding (local emulator, real rules):** an ordinary owner cannot write `calendarPlanAuthority`, fence
collections, `entries` or `brainDump` fixtures. The harness therefore seeds with the operator's short-lived staging
token (`STAGING_SEED_ACCESS_TOKEN`). Unverified: that RTDB REST accepts a gcloud user token's scopes; fallback is
`firebase database:set /rooms/uid_<A> room.json --project STAGING` with the same JSON.

Not automated here (manual, from readiness §ISOLATED_ACCEPTANCE_TEST): UI flows in the approved Refined A, released-
client merge replay (`fixtures/cf43080-client`), sign-out/account switch during a held response, backend-down UX
(block endpoint in DevTools), physical Android. Revoked token: operator revokes A's sessions in console mid-run.

Run order: `node staging/task-018/harness.mjs --config STAGING_CONFIG.json --report D:\chronasense-staging\report.json`
→ `gcloud logging read 'jsonPayload.component="chronasense-completion-api"' --project STAGING --freshness=2h --format=json > logs.json`
→ `node staging/task-018/scan-logs.mjs logs.json <uidA> <uidB> <emailA> <emailB> "Synthetic staging task" <runLabel>`.

## 5. Go/no-go thresholds (fixed before testing — `thresholds.json`)

| Area | GO requires |
|---|---|
| Single completion (22 tasks / 0.5 MiB, warm, client e2e) | p50 ≤ 1.5 s, p95 ≤ 4 s, max ≤ 8 s |
| Account sizes | 0.5 MiB p95 ≤ 4 s · 2 MiB p95 ≤ 6 s · 8 MiB p95 ≤ 12 s · >16 MiB refused, no write |
| Cold start | first request after ≥15 min idle ≤ 12 s (manual) |
| Any request | < 15 s (75 % of client timeout) |
| Concurrency (5 parallel) | zero UNKNOWN, zero 429/5xx, all resolved ≤ 3 rounds, siblings identical |
| Heartbeat contention | zero UNKNOWN, zero sibling loss, ≥ 60 % confirmed first pass, rest explicit `CONTENDED` |
| Retry / unknown | 100 % recovery with original UUID; never a new UUID |
| Undo | 100 % exact-revision success; 100 % refusal on newer source; zero overwrite |
| Auth / forbidden writes | 100 % 401 on bad tokens with `reads=0`; 100 % denial of direct writes and cross-account |
| Backend unavailable | UI never shows completed; command stays pending/unknown and recovers (manual) |
| Monitoring | exactly 1 event per request; 0 forbidden-string hits; outcome counts match harness |
| Transfer / cost | RTDB download per completion ≤ 3.5 × room size; ≤ 2 GB per run; ≤ US$5 per run |
| Isolation | 0 requests to production markers (harness + browser route log); 0 staging principals on production |

Any miss = NO-GO; thresholds change only by recorded owner decision. Size limits are never relaxed.

## 6. Cost, budget and monitoring

Expected per full run (estimate, not measured): ≈ 45 completions, < 250 MB RTDB download (8 MiB scenario dominates:
≈ 4 room reads × 3 completions), a few hundred function requests, 1–3 Cloud Build runs per deploy, one small
container image. Expected to stay inside no-cost usage quotas; the budget is the backstop.

- Budget: US$10/month on the staging project only, alerts at 50/90/100 % to the owner. **Alerts are not a cap.**
  Stop procedure: delete the staging function (`firebase functions:delete chronasenseCompletionApi --region
  asia-southeast1 --project STAGING`), or shut down the whole staging project — never touch production billing.
- Artifact Registry cleanup policy set at deploy (`firebase functions:artifacts:setpolicy --project STAGING`).
- Log metrics (`monitoring/*.yaml`): `completion_requests` (op/outcome/reason/severity/uncertain), `completion_latency`
  (distribution), `completion_cas_conflicts` (0–3 distribution), `completion_alerting_events`. Alerts for staging:
  any `unconfirmedWrite`, any size refusal outside the oversize test, `CONTENDED` > 0 outside contention tests,
  any `completion-unavailable`, latency p95 > 4 s. Group by `uncertain` (one client retry loop can repeat
  `unconfirmedWrite`). Platform: Cloud Run request count/latency/5xx and RTDB bandwidth/load dashboards.
  Verify the Cloud Run service name is `chronasensecompletionapi` on first deploy and fix the filters if not.

## 7. Exact provisioning actions (NOT run — require the approval in §8)

Placeholders: `STAGING` = `chronasense-staging-<suffix>`, `BILLING` = billing account ID, `D:\chronasense-staging` =
disposable directory outside every repo. Firebase CLI 15.2.1, Node 22.23.3.

```powershell
# 1 Project, billing, Firebase, APIs
gcloud projects create STAGING --name="ChronaSense Staging"
gcloud billing projects link STAGING --billing-account=BILLING
firebase projects:addfirebase STAGING
gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firebasedatabase.googleapis.com identitytoolkit.googleapis.com secretmanager.googleapis.com logging.googleapis.com monitoring.googleapis.com --project=STAGING
gcloud billing budgets create --billing-account=BILLING --display-name="chronasense-staging" --budget-amount=10USD --filter-projects=projects/STAGING --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
# 2 Console (no reliable CLI): RTDB default instance, asia-southeast1, locked mode; Auth: enable Email/Password;
#   add users A and B (generated passwords, stored only in the operator's password manager); confirm `localhost`
#   is an authorized domain. Web app:
firebase apps:create WEB chronasense-staging-web --project STAGING
firebase apps:sdkconfig WEB <APP_ID> --project STAGING      # -> D:\chronasense-staging\STAGING_CONFIG.json (4 fields)
# 3 Runtime identity (least privilege)
gcloud iam roles create chronasenseCompletionRuntime --project=STAGING --title="ChronaSense completion runtime" --permissions=firebasedatabase.instances.get,firebasedatabase.instances.update,firebaseauth.users.get --stage=GA
gcloud iam service-accounts create chronasense-completion --project=STAGING --display-name="ChronaSense completion runtime"
gcloud projects add-iam-policy-binding STAGING --member=serviceAccount:chronasense-completion@STAGING.iam.gserviceaccount.com --role=projects/STAGING/roles/chronasenseCompletionRuntime --condition=None
# 4 Shared-entrypoint bootstrap: staging-only dummy HMAC secret (Action API is NOT deployed; completion gets no access)
node -e "console.log(JSON.stringify({stg1:require('crypto').randomBytes(32).toString('hex')}))" | gcloud secrets create CHRONASENSE_WORKER_HMAC_KEYS --project=STAGING --replication-policy=automatic --data-file=-
# 5 Disposable deploy artifact from the reviewed monitoring SHA (outside the repo)
git -C "<repo>" archive ea10342 --prefix=src/ -o D:\chronasense-staging\src.tar; tar -xf D:\chronasense-staging\src.tar -C D:\chronasense-staging
#   D:\chronasense-staging\src\functions\.env.STAGING :
#     CHRONASENSE_OWNER_SUBJECT=staging-unused
#     CHRONASENSE_OWNER_FIREBASE_UID=staging-unused
#     CHRONASENSE_FIREBASE_WEB_API_KEY=<staging apiKey>
#     CHRONASENSE_RTDB_URL=https://STAGING-default-rtdb.asia-southeast1.firebasedatabase.app
#     CHRONASENSE_COMPLETION_SERVICE_ACCOUNT=chronasense-completion@STAGING.iam.gserviceaccount.com
cd D:\chronasense-staging\src; npm ci --prefix functions; node scripts/functions-shared.mjs
# 6 Deploy (rules first, then ONLY the completion function)
firebase deploy --project STAGING --only database --non-interactive
firebase deploy --project STAGING --only functions:chronasenseCompletionApi --non-interactive
firebase functions:artifacts:setpolicy --project STAGING
# 7 Post-deploy verification (read-only)
gcloud run services describe chronasensecompletionapi --region=asia-southeast1 --project=STAGING --format="value(spec.template.spec.serviceAccountName)"
gcloud run services get-iam-policy chronasensecompletionapi --region=asia-southeast1 --project=STAGING
gcloud secrets get-iam-policy CHRONASENSE_WORKER_HMAC_KEYS --project=STAGING     # must NOT list the completion SA
gcloud projects get-iam-policy STAGING --format=json                            # build identity: no Editor
gcloud functions list --project=STAGING                                         # exactly chronasenseCompletionApi
gcloud projects get-iam-policy time-audit-3c3da --format=json                   # no STAGING principal
# 8 Monitoring
foreach ($m in 'completion_requests','completion_latency','completion_cas_conflicts','completion_alerting_events') { gcloud logging metrics create $m --project=STAGING --config-from-file=staging/task-018/monitoring/$m.yaml }
# 9 Frontend + tests
node staging/task-018/frontend.mjs build --config D:\chronasense-staging\STAGING_CONFIG.json --out D:\chronasense-staging\site
node staging/task-018/harness.mjs --config D:\chronasense-staging\STAGING_CONFIG.json --report D:\chronasense-staging\report.json
# 10 Teardown after evidence is retained
firebase functions:delete chronasenseCompletionApi --region asia-southeast1 --project STAGING
gcloud projects delete STAGING          # optional; 30-day recoverable shutdown
```

Never: bare `firebase deploy`, `--force`, any `--project time-audit-3c3da` command, production secret copies.

## 8. Owner approval packet (one decision)

Approve, for the **staging project only**:

1. **Resource:** create project `chronasense-staging-<suffix>` with Firebase, default RTDB (asia-southeast1),
   Email/Password Auth, one web app, two synthetic test users, one dummy Secret Manager secret, 4 log metrics.
2. **Billing:** link a billing account (Blaze — required for Functions v2). Budget US$10/month, alerts 50/90/100 %.
   Expected spend ≈ US$0–2 per run; alerts are not a hard cap; stop = delete function/shutdown project.
3. **IAM:** create custom role + `chronasense-completion` runtime SA bound to it; public `run.invoker` on the
   completion service only; tighten build identity if it holds Editor. Conditional: broader RTDB/Auth roles only if
   the custom role is proven insufficient, with a second explicit approval.
4. **Secrets:** create a staging-only random `CHRONASENSE_WORKER_HMAC_KEYS` (never a production copy).
5. **Deploy to staging:** rules (`--only database`) and `functions:chronasenseCompletionApi` from `ea10342`.
6. **Data:** synthetic rooms only, seeded with the operator's short-lived staging token. Zero production data,
   zero production changes.

Not requested now: production rules/backend/frontend, merge, push, Pages publication, Android staging build.

## 9. Blockers / open items

- **Owner approval (§8)** — the only blocker to running staging.
- Custom-role sufficiency, seed-token scopes, Cloud Run service name and build identity roles are unverified until
  first deploy; each has a defined check and a fallback that requires approval rather than silent broadening.
- Physical Android rehearsal needs either a staging APK (Capacitor packaging decision) or a reviewed CORS origin
  for a staging hostname; neither is authorized. Desktop + Android-sized viewport only until decided.
- No hosted Linux Node 22 CI run for any candidate SHA (unchanged from readiness; requires a push decision).
- Monitoring commits (`9349963`, `ea10342`) and this kit are on local branch `task-018-monitoring`, not in `task-018`.
