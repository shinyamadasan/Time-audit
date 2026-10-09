# ChronaSense Action API V1 — read backend

> **NOT DEPLOYED.** TASK-005 and TASK-009 are locally tested candidates only. Deploying the function or the
> rules change is a separate, separately authorized step (rules first). Nothing here has run against
> production Firebase.

Firebase Functions v2 HTTPS function `chronasenseActionApi` in `asia-southeast1`.
Contract foundation: [`docs/CHRONASENSE_ACTION_API_V1.md`](../docs/CHRONASENSE_ACTION_API_V1.md). TASK-009 extends
the same Worker→backend HMAC query pipeline with five fixed read kinds. Every command and unknown kind remains
`INVALID_INPUT`; there is no write surface.

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

`POST /v1/query`, `Content-Type: application/json`, body ≤ 64 KiB:

```json
{ "contractVersion": 1, "requestId": "<uuidv4>", "kind": "get_brain_dump", "parameters": {} }
```

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
`chronasense:read` → replay nonce → user-scoped read. Nothing touches Firebase until every earlier check passed.

## Authority split

| Concern | Mechanism | Module |
|---|---|---|
| Owner binding | signed subject == `CHRONASENSE_OWNER_SUBJECT` → `CHRONASENSE_OWNER_FIREBASE_UID` → room `uid_<uid>` | `src/identity.js` |
| UID validation + custom token | Admin SDK `getUser` / `createCustomToken` | `src/user-scoped-rtdb.js` |
| Domain reads | custom token → `accounts:signInWithCustomToken` → ID token → RTDB REST `?auth=`; existing rules enforce `auth.uid` | `src/user-scoped-rtdb.js` |
| Nonces / receipts | Admin credential access token → RTDB REST, allowlisted to `serverRequestNonces/` and `serverActionReceipts/` only | `src/infra-rtdb.js` |

No module falls back from user-scoped to privileged domain access (`STOP — AUTHORITY BOUNDARY VIOLATED`);
`test/authority-boundary.test.js` guards this statically and at runtime. Tokens never leave the backend; the
refresh token is discarded unread.

Replay nonce: `serverRequestNonces/chronasense-plugin-worker-v1/<requestId>`, created with an RTDB conditional
`PUT` (`if-match: null_etag`), kept 660 s (the 600 s worst-case replay window + 60 s skew margin) and removed by a
bounded sweep (≤ 50 per request, indexed on `expiresAt`). Receipts (`serverActionReceipts/<uid>/<actionId>`):
storage, RFC 8785 request hash and state machine only — no command executes and reads create no receipt.

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
npm run test:rules-emulator               # real RTDB emulator: private-path denial, concurrent nonce claims,
                                          # indexed sweep, user-scoped + cross-account reads, end to end
```

`functions/node_modules` is only needed to load `index.js` (the Firebase entry); `src/` and its tests depend on
Node built-ins and the packaged shared domain model only.

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

## Response size

Each user-scoped RTDB collection response is also limited to 1 MiB of UTF-8 source bytes, measured while
streaming and before JSON parsing. This fixed read model needs complete collections to resolve plan and
recovery authority; a larger collection fails whole with `DOMAIN_LIMIT` (`reason: source-too-large`,
`details.limitBytes: 1048576`). The source cap bounds one fetch independently of the API response cap and
can be revised if the read model changes. No collection is truncated.

§5's 64 KiB maximum applies to responses as well as requests, inclusively (65,536 bytes allowed). It is measured in
UTF-8 bytes of the exact JSON payload `index.js` sends. A complete result that does not fit is refused whole with
`DOMAIN_LIMIT` (HTTP 422, `details.limitBytes: 65536`, not retryable) — never truncated into a partial list.

## Known open items (not Phase A1 scope)

- **Invoker / rate limits / concurrency:** §13 per-principal and per-action rate limits and bounded concurrency
  are not implemented; the Cloud Run invoker policy is left at the platform default. Both are deploy-time
  decisions.
- **Large Brain Dumps:** a Brain Dump whose complete projection exceeds 64 KiB is currently unreadable through
  the API (`DOMAIN_LIMIT`); pagination/filtering would be a separate contract change.
- **Canonical path on the deployed URL:** the signed path is the request path the function sees (`/v1/query`).
  Phase B must verify it matches what the Worker signs for the deployed URL form.
