# ChronaSense Action API V1 — reads, Brain Dump create and plan create candidate

> TASK-009 reads and TASK-010 Brain Dump create are deployed (see TASKS.md closures). TASK-011 `plan_create` and its
> rule change are a local candidate only: nothing here deploys the Function, Worker, OAuth scope or rules, or writes
> production data.

Firebase Functions v2 HTTPS function `chronasenseActionApi` in `asia-southeast1`.
Contract foundation: [`docs/CHRONASENSE_ACTION_API_V1.md`](../docs/CHRONASENSE_ACTION_API_V1.md). TASK-009 uses
five fixed read kinds. TASK-010 adds `brain_dump_add` and TASK-011 adds `plan_create` on a separate signed command
route; unsupported commands and unknown kinds remain `INVALID_INPUT`.

| Kind | Parameters | Result |
|---|---|---|
| `get_brain_dump` | `{}` | Unchanged TASK-005 capture list and revisions. |
| `get_today` | `{}` | Current authoritative plan target plus derived attention and explicit unknowns. |
| `get_plan` | `{}` or `{ "target": { "store": "calendar", "id": "<exact plan ID>" } }` (store may also be `legacy` or `operational`) | Current or exact authoritative plan, stable item IDs, frozen calendar times, record state and revision. |
| `get_item` | `{ "source": "brain_dump", "id": "<capture ID>" }` or `{ "source": "plan", "id": "<item ID>", "target": { "store": "...", "id": "<exact plan ID>" } }` | One capture or plan item; known tombstone/relocation is distinct from `NOT_FOUND`. |
| `get_intelligence` | `{}` | Recomputed Intelligence V1: attention, plan versus actual, recorded actuals, open loops and recent patterns, each with evidence refs. |

The target ID is returned by `get_today` or `get_plan`. No parameter names an account, Firebase path or arbitrary
collection. Missing actual evidence stays unknown. Device-local routine completion and live timer state are
unevaluated by server reads and appear in notes. Derived Intelligence is an interpretation, not persisted truth.

## Request

Reads use `POST /v1/query`, `Content-Type: application/json`, body ≤ 64 KiB:

```json
{ "contractVersion": 1, "requestId": "<uuidv4>", "kind": "get_brain_dump", "parameters": {} }
```

Brain Dump create uses `POST /v1/command` with `actionId`, `kind: "brain_dump_add"`,
`parameters: {"text":"..."}`, `expectedRevision: null` and the exact `ActionProvenanceV1` fields.
The Worker requires one stable UUIDv4 action ID and captured-at UTC time across retries, but signs a new
transport `requestId` on each attempt. Its OAuth grant must include `chronasense:brain-dump.write`.

Plan create (TASK-011, DECISIONS #37) uses the same route with `kind: "plan_create"` and requires
`chronasense:plan.write`. Parameters: `target` `{ "store": "calendar", "id": "cal1:YYYY-MM-DD" }`, `title` (1-200
characters) and, for a timed task, `when` (`HH:MM`) + `whenTz` (canonical IANA) with optional `whenDayOffset` (0|1)
and `durationMinutes` (1-720); an untimed task sends none of those. Shape, wall time, DST gap and the plan's two-date
extent are refused before any receipt (`INVALID_INPUT`, `NONEXISTENT_TIME`, `DOMAIN_LIMIT`); the target is then
resolved through Plan Authority's server read (`NOT_FOUND` when not calendar-authoritative, `PAST_TARGET_IMMUTABLE`
once its plan day has ended). The item `api1_<uuid>` is conditionally created at
`rooms/uid_<uid>/calendarPlanFences/<planId>/api1_<uuid>` with an ID token whose custom claims bind the action, kind
and target (`src/plan-create-action.js`, `src/user-scoped-rtdb.js`); applied only after exact readback of the
attributed child. For a plan that has no canonical origin yet, its origin (createdAt + home timezone) is frozen first,
through `mergeCalendarPlanRecords` under an ETag compare-and-set on `calendarPlans/<planId>` with the ordinary owner
token. REJECTED is recorded only by an action's first attempt; a takeover stays `PENDING_UNKNOWN` until the exact child
proves the outcome. The receipt and result carry IDs, target, schedule and revision, never the title.

Signed headers (each exactly once; any other `x-chronasense-*` header is refused):

| Header | Value |
|---|---|
| `x-chronasense-service` | `chronasense-plugin-worker-v1` |
| `x-chronasense-key-id` | key ID present in `CHRONASENSE_WORKER_HMAC_KEYS` |
| `x-chronasense-request-id` | lowercase UUIDv4, equal to the body `requestId`, unique per HTTP attempt |
| `x-chronasense-timestamp` | integer UTC seconds, within ±300 s of backend time |
| `x-chronasense-subject` | the Worker-verified Access `sub` |
| `x-chronasense-scopes` | granted scopes, comma-joined, lexically sorted, unique (may be empty) |
| `x-chronasense-signature` | lowercase hex HMAC-SHA-256 over the §2 tuple |

The §2 doc lists the signed values but not which carry subject and scopes; with unknown envelope fields refused,
the subject and scopes travel in these two signed headers (an interpretation recorded for review).

Check order: method/path → headers → service → key → freshness → HMAC over the raw body bytes → strict envelope
(duplicate keys, unknown fields, `contractVersion`, `requestId` match, known kind) → owner binding → scope
`chronasense:read`, or the command kind's own write scope (`chronasense:brain-dump.write` / `chronasense:plan.write`)
→ replay nonce → user-scoped domain operation.
No domain data is accessed until authentication, envelope, owner binding, scope and nonce checks pass.

## Authority split

| Concern | Mechanism | Module |
|---|---|---|
| Owner binding | signed subject == `CHRONASENSE_OWNER_SUBJECT` → `CHRONASENSE_OWNER_FIREBASE_UID` → room `uid_<uid>` | `src/identity.js` |
| UID validation + custom token | Admin SDK `getUser` / `createCustomToken` | `src/user-scoped-rtdb.js` |
| Domain reads | custom token → `accounts:signInWithCustomToken` → ID token → RTDB REST `?auth=`; existing rules enforce `auth.uid` | `src/user-scoped-rtdb.js` |
| Brain Dump create | action-scoped custom claim → owner ID token → conditional REST create at `bdc1_<uuid>` → exact user-scoped readback; rules require immutable `creationActionId` | `src/user-scoped-rtdb.js`, `src/brain-dump-action.js` |
| Nonces / receipts | Admin credential access token → RTDB REST, allowlisted to `serverRequestNonces/` and `serverActionReceipts/` only | `src/infra-rtdb.js` |

No module falls back from user-scoped to privileged domain access (`STOP — AUTHORITY BOUNDARY VIOLATED`);
`test/authority-boundary.test.js` guards this statically and at runtime. Tokens never leave the backend; the
refresh token is discarded unread.

Replay nonce: `serverRequestNonces/chronasense-plugin-worker-v1/<requestId>`, created with an RTDB conditional
`PUT` (`if-match: null_etag`), kept 660 s (the 600 s worst-case replay window + 60 s skew margin) and removed by a
bounded sweep (≤ 50 per request, indexed on `expiresAt`). Brain Dump creates claim
`serverActionReceipts/<uid>/<actionId>` before any domain write. Same ID with a different canonical hash is
`IDEMPOTENCY_CONFLICT`; uncertain outcomes stay `pending_unknown` until the guarded deterministic create and
attributed readback prove the result. ETag compare-and-set protects receipt transitions. Reads create no receipt.

## Configuration (names only — values never enter the repository)

| Name | Kind | Meaning |
|---|---|---|
| `CHRONASENSE_WORKER_HMAC_KEYS` | Secret Manager secret | JSON `{"<keyId>":"<lowercase hex, 32–128 random bytes>"}`; two entries only during rotation |
| `CHRONASENSE_OWNER_SUBJECT` | param | the one allowed Cloudflare Access `sub` |
| `CHRONASENSE_OWNER_FIREBASE_UID` | param | the one Firebase UID it maps to |
| `CHRONASENSE_RTDB_URL` | param | `https://<db>.firebaseio.com` or `https://<db>.<region>.firebasedatabase.app` |
| `CHRONASENSE_FIREBASE_WEB_API_KEY` | param | the project's public Web API key (for the token exchange) |

Any missing or malformed value fails closed (every call refused).

## Tests (local only, no network to production)

```
npm test                                  # from the repo root: includes functions/test/*.test.js
node --test functions/test/*.test.js      # just this package (needs no functions/node_modules)
cd workers/chronasense-conversational-bridge && npm ci && npm test  # thin OAuth/MCP Worker
npm run test:rules-emulator               # real RTDB emulator: private paths, protected capture attribution,
                                          # conditional create, receipt ETags, user-scoped reads
```

`functions/node_modules` is only needed to load `index.js` (the Firebase entry); `src/` and its tests depend on
Node built-ins and the packaged shared domain model only.

The standalone `npm run test:auth-claim-proof` gate (from `functions/`) requires the local Firebase Auth emulator
on `127.0.0.1:9099` with project `demo-chronasense-task010`, started using
`test/auth-emulator.firebase.json` and `firebase emulators:start --only auth --project demo-chronasense-task010 --config test/auth-emulator.firebase.json`.
Set `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099` for the proof process. It uses an ephemeral local RSA key,
the real Admin SDK `createCustomToken` and Auth emulator exchange, verifies the resulting ID-token claim,
then presents that ID token to the real RTDB emulator rules. It asserts marked create, missing/wrong claim denial,
and the action-token unrelated-path denial. It prints no tokens and contacts no production project. The Auth emulator
does not verify custom-token signatures, so this is claim-propagation and rule-observation proof, not production IAM proof.

## Packaging the shared domain model

A deploy uploads only `functions/`. The backend needs the Brain Dump, plan, calendar and Intelligence domain models,
whose ONLY authority is the corresponding repository-root modules. `functions/shared/` holds
byte-identical GENERATED copies — never edit them; edit the root file, then regenerate:

```
npm run build:functions-shared            # (root) copy the authoritative files into functions/shared/
npm run check:functions-shared            # (root) parity check; also run by npm test, by `npm test` in
                                          # functions/, and by the firebase.json functions predeploy hook
```

The check fails on any drift: a copy differing from its root source (only CRLF vs LF is tolerated), a missing
copy, an unexpected/stale file in `functions/shared/`, or an authoritative module importing a file that is not
packaged. `test/packaging.test.js` also proves a clean copy of `functions/` (no `node_modules`, no tests, no
repository root) resolves and runs.

The local Firebase predeploy hook checks root-to-package parity before upload. Cloud Build then runs the
package-local `npm run build` syntax check, which does not depend on repository-root files outside `functions/`.

## Response size

Each user-scoped RTDB collection response is also limited to 1 MiB of UTF-8 source bytes, measured while
streaming and before JSON parsing. This fixed read model needs complete collections to resolve plan and
recovery authority; a larger collection fails whole with `DOMAIN_LIMIT` (`reason: source-too-large`,
`details.limitBytes: 1048576`). The source cap bounds one fetch independently of the API response cap and
can be revised if the read model changes. No collection is truncated.

§5's 64 KiB maximum applies to responses as well as requests, inclusively (65,536 bytes allowed). It is measured in
UTF-8 bytes of the exact JSON payload `index.js` sends. A complete result that does not fit is refused whole with
`DOMAIN_LIMIT` (HTTP 422, `details.limitBytes: 65536`, not retryable) — never truncated into a partial list.

## Known open items

- **Invoker / rate limits / concurrency:** §13 per-principal and per-action rate limits and bounded concurrency
  are not implemented; the Cloud Run invoker policy is left at the platform default. Both are deploy-time
  decisions.
- **Large Brain Dumps:** a Brain Dump whose complete projection exceeds 64 KiB is currently unreadable through
  the API (`DOMAIN_LIMIT`); pagination/filtering would be a separate contract change.
- **Command route on the deployed URL:** `/v1/command` is tested locally and signed by the Worker. Verify the
  deployed Function URL forwards that exact path before enabling the write tool in production.
