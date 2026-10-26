# TASK-029 Handoff — second user (owner's wife) on the conversational MCP bridge

Merged to main `f6f18a5` (G1, 2026-10-25). Rollout progress:
- G0: PASS. The `/authorize` Allow policy names two emails: the owner's, and the wife's, which the owner added
  intentionally. This is an authorized early G4.1 (owner confirmation, 2026-10-25).
- G1: done.
- G2: done. Function `chronasenseactionapi-00008-wur`, owner canary PASS.
- G3 onward: not started. The second user is NOT active.
This document contains no real Access subject, Firebase UID, token or secret, and none may be added to it.

## What changes
- Worker: explicit allowlist = `CHRONASENSE_OWNER_SUBJECT` + optional `CHRONASENSE_SECOND_SUBJECT`. The verified Access
  `sub` must be allowlisted at `/authorize`, becomes the grant `userId` + `props.ownerSubject`, and on every MCP call the
  two must agree and still be allowlisted. Only that subject is HMAC-signed to the backend. The consent page names the
  signed-in person (Access email, display only).
- Backend: owner pair + optional `CHRONASENSE_SECOND_SUBJECT` / `CHRONASENSE_SECOND_FIREBASE_UID` -> own room `uid_<uid>`.
  Half-set, colliding or malformed config refuses every call (owner included).
- Unchanged: OAuth server, URLs, scopes, CIMD, PKCE, Access JWT checks, HMAC, idempotency. Managed OAuth stays OFF.
- With the second values unset the deployed behaviour is identical to today (owner only).

## Evidence summary (details: TEST_REPORT.md "TASK-029")
- Live Worker `ebdbbd1c` is byte-identical to origin/main; live Function `chronasenseactionapi-00007-mon` has
  identical identity/auth/data-access modules (checked 2026-10-25, values never printed).
- Unit/integration: Worker 42/42, backend 246/246, root npm test 2315 pass / 0 fail / 1 pre-existing skip; 5/5 mutants killed.
- Isolated real-OAuth run (real bundles + real workers-oauth-provider in local workerd; fake Access keys, client and
  backend stores; no network): 34/34, including the production-identical bundle issuing an owner grant that the
  candidate then accepts and refreshes; a negative-control mutant bundle fails exactly the revocation checks.

## Residual risks (accepted, non-blocking)
1. Shared browser: whoever's Cloudflare Access session is active at consent POST gets the grant. The consent page
   names that person; each person should connect from their own device/browser profile.
2. Shared ChatGPT account: a ChatGPT account holds one connector grant. Each person must use their OWN ChatGPT account.
3. Removing the second subject rejects her tokens at `/mcp` immediately but does not delete them; refresh still
   issues tokens (all rejected) and re-adding the same `sub` would revive them. The rollback deletes her KV records.
4. The second Firebase UID is trusted configuration: a wrong UID that belongs to another real account would expose
   that account. Step G4 verifies it from in-app records; G6 confirms with her own data.
5. Forwarded authorize links. Both people use ChatGPT, so the client name, domain and redirect host on the consent page
   are identical for both, and the page cannot tell "my ChatGPT" from "theirs". If one forwards an authorize link and the
   other approves it, the approver's data is granted to the sender. Rule: approve only a connection flow you started
   yourself in your own ChatGPT. This is bounded to the two allowlisted people.
6. Bearer tokens from this provider have the form `userId:grantId:secret`, so a connected client (ChatGPT) can see the
   holder's Access `sub`. This is already true for the owner. It is an identifier, not a secret.
7. Wrangler prints plaintext var values (including her `sub`) in its deploy and dry-run output. G3, G5.2 and R1.1 are run
   by the owner only, and that output is never pasted into chat, issues or agent sessions.

## Production configuration checks (read-only; prints names/booleans only)
Run from `workers/chronasense-conversational-bridge` with `CLOUDFLARE_API_TOKEN` set and `gcloud` authenticated.

```sh
# Worker: active version and binding NAMES/TYPES only
npx wrangler deployments list --name chronasense-conversational-bridge
npx wrangler versions view <active-version-id> --name chronasense-conversational-bridge --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).resources;console.log((r.bindings||[]).map(b=>b.name+":"+b.type).sort().join("\n"))})'
# Function: revision and env var NAMES only
gcloud functions describe chronasenseActionApi --region asia-southeast1 --project time-audit-3c3da --format=json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).serviceConfig;console.log(c.revision);console.log(Object.keys(c.environmentVariables).sort().join("\n"))})'
```

Value-equality check (prints only true/false). Save as a local, untracked file and run with `node`:

```js
import { execFileSync } from 'node:child_process';
const api = async p => (await fetch('https://api.cloudflare.com/client/v4' + p, { headers: { Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN } })).json();
const accounts = (await api('/accounts')).result;
if (accounts.length !== 1) throw new Error('expected exactly one Cloudflare account for this token');
const account = accounts[0].id;
const w = Object.fromEntries(((await api(`/accounts/${account}/workers/scripts/chronasense-conversational-bridge/settings`)).result.bindings || [])
  .filter(b => b.type === 'plain_text').map(b => [b.name, b.text]));
const f = JSON.parse(execFileSync('gcloud', ['functions', 'describe', 'chronasenseActionApi', '--region', 'asia-southeast1',
  '--project', 'time-audit-3c3da', '--format=json'], { encoding: 'utf8', shell: true })).serviceConfig.environmentVariables;
const S = /^[\x21-\x2b\x2d-\x7e]{1,256}$/, U = /^[A-Za-z0-9_-]{1,128}$/;
console.log({ ownerSubjectEqual: w.CHRONASENSE_OWNER_SUBJECT === f.CHRONASENSE_OWNER_SUBJECT,
  workerSecondSet: !!w.CHRONASENSE_SECOND_SUBJECT, functionSecondSubjectSet: !!f.CHRONASENSE_SECOND_SUBJECT,
  functionSecondUidSet: !!f.CHRONASENSE_SECOND_FIREBASE_UID,
  secondSubjectEqual: (w.CHRONASENSE_SECOND_SUBJECT ?? '') === (f.CHRONASENSE_SECOND_SUBJECT ?? ''),
  secondDiffersFromOwner: !w.CHRONASENSE_SECOND_SUBJECT || w.CHRONASENSE_SECOND_SUBJECT !== w.CHRONASENSE_OWNER_SUBJECT,
  secondUidShapeOk: !f.CHRONASENSE_SECOND_FIREBASE_UID || U.test(f.CHRONASENSE_SECOND_FIREBASE_UID),
  secondUidDiffersFromOwner: !f.CHRONASENSE_SECOND_FIREBASE_UID || f.CHRONASENSE_SECOND_FIREBASE_UID !== f.CHRONASENSE_OWNER_FIREBASE_UID,
  subjectsShapeOk: S.test(w.CHRONASENSE_OWNER_SUBJECT || '') && (!w.CHRONASENSE_SECOND_SUBJECT || S.test(w.CHRONASENSE_SECOND_SUBJECT)) });
```

Expected now (before G2): `ownerSubjectEqual: true`, every `*Set: false`, `secondSubjectEqual: true`.

## Staged deployment sequence (each gate needs its own explicit owner approval)
Any step that deploys the Worker (G3, G5.2, R1.1) or writes the second user's values (G5.1) is run by the owner personally.
Wrangler prints var values, so that output is never shared with an agent.
- **G0 Preflight (read-only).** Worker active version `ebdbbd1c`, 7 bindings (5 plain_text, 1 secret_text, OAUTH_KV),
  no `CHRONASENSE_SECOND_SUBJECT`. Function revision `chronasenseactionapi-00007-mon`, env names without `SECOND`.
  Equality check as above. Access app for `/authorize`: path `/authorize` only, Allow policy = owner only,
  Managed OAuth OFF (Advanced settings). Live `GET /authorize` -> 302 to Access, `GET /mcp` -> 401.
  Any drift -> STOP.
- **G1 Merge** `task-029` into `main` (owner).
- **G2 Backend, owner-only. No env change.** Use the same method that produced the live revision: a gcloud source-only
  update from a git-archive (CHANGELOG "TASK-012 — production rollout"). Do NOT use firebase-tools. It resolves params
  for the whole codebase and would stop on `CHRONASENSE_COMPLETION_SERVICE_ACCOUNT` (TASK-018, no default). It would
  also upload untracked files and re-apply function options. The new `SECOND` params default to empty, so the live env
  vars stay exactly as they are.
  1. Capture the predecessor (for diff and rollback):
     `gcloud functions describe chronasenseActionApi --region asia-southeast1 --project time-audit-3c3da --format=json > <private-dir>/pre.json`.
     This file contains values: keep it private and never share it.
  2. In the merged checkout, run `node scripts/functions-shared.mjs`; `git status` must be clean.
     Then `git archive <merged-sha> functions | tar -x -C <empty-dir>` (no node_modules, LF).
  3. `gcloud functions deploy chronasenseActionApi --gen2 --region asia-southeast1 --project time-audit-3c3da --source <empty-dir>/functions`,
     with no other flags. If gcloud asks for runtime, trigger, entry point or any other setting, STOP: do not guess.
  4. Verify:
     - New revision ACTIVE at 100%.
     - Compared with `pre.json`, only the revision, source, build and update-time fields differ. Service account,
       ingress, memory, CPU, concurrency, max instances, timeout, secret binding v1, env NAMES and values, and invoker
       must all be unchanged. Compare by hash; never print values.
     - Equality check: `ownerSubjectEqual: true` and every `*Set: false`.
     - Unauthenticated `POST /v1/query` and `/v1/command` return 401.
     - The owner's ChatGPT `get_today` works.
- **G3 Worker, owner-only.** `.deploy-vars.json` unchanged (5 keys, no `CHRONASENSE_SECOND_SUBJECT`).
  `npm run deploy` (plan) -> `npm run deploy -- --dry-run` -> `npm run deploy -- --confirm`.
  Verify: 7 bindings, no `SECOND`; `/authorize` -> Access; `/mcp` -> 401; owner ChatGPT `get_brain_dump` and `get_today`
  work on the EXISTING connection (no reconnect needed; proven against the production-identical bundle).
  Behaviour is now identical to today. Optional: use it normally for a day.
- **G4 Identify her identifiers (owner).**
  1. Owner adds her identity to the `/authorize` Access Allow policy (her own login method). Safe on its own: the
     Worker still refuses her (401) until G5. Managed OAuth stays OFF.
  2. Access `sub`: after she signs in once, read her user ID (UUID) from Zero Trust > Users. It is only a candidate
     until G6 step 1 proves it equals the Worker-verified `sub`; a wrong value fails closed (401), it never grants access.
  3. Firebase UID: take it from the accepted RTDB `pairs/<pairId>` record linking the owner's account and hers
     (`creator`/`partner`), and cross-check it in Firebase Console > Authentication against the account she signs in
     with. Never from email alone. It must differ from the owner UID.
- **G5 Activate (backend first, then Worker).**
  1. The owner runs this, with the values read from two private, untracked files into shell variables so they never
     appear in chat or history:
     `gcloud functions deploy chronasenseActionApi --gen2 --region asia-southeast1 --project time-audit-3c3da --source <same-dir>/functions --update-env-vars "CHRONASENSE_SECOND_SUBJECT=$SECOND_SUB,CHRONASENSE_SECOND_FIREBASE_UID=$SECOND_UID"`.
     `--update-env-vars` adds these two and keeps every other variable; never use `--set-env-vars` or `--env-vars-file`.
     Verify:
     - Diff against the G2 revision: only the two new env names, plus the revision fields, differ.
     - Equality check: `functionSecondSubjectSet: true`, `functionSecondUidSet: true`, `secondUidDiffersFromOwner: true`,
       `secondUidShapeOk: true`.
     - The owner still works.
     (The Worker still refuses her, so this gap is safe.)
  2. Add `CHRONASENSE_SECOND_SUBJECT` to `.deploy-vars.json`; `npm run deploy` (plan shows 6 `--var`, all redacted)
     -> `--dry-run` -> `--confirm`. Verify: 8 bindings; equality check `workerSecondSet: true`, `secondSubjectEqual: true`,
     `secondDiffersFromOwner: true`, `subjectsShapeOk: true`.
- **G6 Owner acceptance tests.**
  1. On HER device she opens `https://chronasense-conversational-bridge.shinyamadasan.workers.dev/authorize?identity=1`.
     It must render (not 401) and show exactly the configured subject (compare privately; do not share it).
  2. In HER ChatGPT account she adds the ChronaSense connector. The consent page must say "Signed in as" her email.
     Approve read only first.
  3. Her `get_brain_dump` and `get_today` show only her own data (she recognizes it; none of the owner's items).
  4. Owner's ChatGPT `get_brain_dump` / `get_today` still show only the owner's data.
  5. Optional write canary: she runs `brain_dump_add` "TASK-029 canary". It appears only in her ChronaSense Brain Dump,
     never the owner's. She then dismisses it in her app.
  6. Cloud Logging (`component: chronasense-action-api`) shows `ok` events with codes/request IDs only.
  Any failure -> rollback R1 immediately.

## Rollback
- **R1 Disable her (fast, no code rollback).**
  1. Remove `CHRONASENSE_SECOND_SUBJECT` from `.deploy-vars.json`; `npm run deploy -- --confirm`. Her next call fails.
  2. Delete only her OAuth records (KV namespace `41465c21d108494ca35271fdcd55e92a`). List first, with her exact subject
     in the prefix — never an empty or owner prefix:
     `npx wrangler kv key list --namespace-id 41465c21d108494ca35271fdcd55e92a --remote --prefix "grant:<her-sub>:"`
     and the same with `"token:<her-sub>:"`; then `npx wrangler kv key delete --namespace-id 41465c21d108494ca35271fdcd55e92a --remote "<key>"`
     for each listed key. Re-list: both prefixes should be empty and the owner prefixes unchanged. KV is eventually
     consistent, so deleted keys may still be listed for about 60 s. Step 1 already blocks her meanwhile; re-list again
     after a minute.
  3. Remove both `SECOND` env vars:
     `gcloud functions deploy chronasenseActionApi --gen2 --region asia-southeast1 --project time-audit-3c3da --source <same-dir>/functions --remove-env-vars CHRONASENSE_SECOND_SUBJECT,CHRONASENSE_SECOND_FIREBASE_UID`.
     Verify that the equality check shows every `*Set: false`.
  4. Remove her from the Access policy.
- **R2 Full code rollback.** Worker: `npx wrangler rollback` to `ebdbbd1c-418a-4123-ae8a-6dbf83a610bc` (restores its
  7 bindings), then verify bindings and `/authorize`. Function:
  `gcloud run services update-traffic chronasenseactionapi --region asia-southeast1 --project time-audit-3c3da --to-revisions=chronasenseactionapi-00007-mon=100`.
  Pinning Cloud Run traffic to `00007` leaves the Cloud Functions metadata describing a newer revision than the one
  serving. Before any later deploy, return traffic to latest
  (`gcloud run services update-traffic chronasenseactionapi --region asia-southeast1 --project time-audit-3c3da --to-latest`)
  or redeploy the reviewed source.
  Do R1.2 if she was ever active. No data migration exists; owner grants and data are untouched.
