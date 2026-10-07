# ChronaSense Action API V1 — backend (Phase A1)

> **NOT DEPLOYED.** Phase A1 (TASK-005) is a locally tested candidate only. Deploying the function or the
> rules change is a separate, separately authorized step (rules first). Nothing here has run against
> production Firebase.

Firebase Functions v2 HTTPS function `chronasense_action_api` (export `chronasenseActionApi`) in `asia-southeast1`.
Contract: [`docs/CHRONASENSE_ACTION_API_V1.md`](../docs/CHRONASENSE_ACTION_API_V1.md). Phase A1 serves exactly one
read-only query, `get_brain_dump`, behind Worker→backend HMAC authentication. There is no write surface: every
other `kind` (other reads, every command) is rejected as `INVALID_INPUT`.

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
npm run test:rules-emulator               # real RTDB emulator: private-path denial, concurrent nonce claims,
                                          # indexed sweep, user-scoped + cross-account reads, end to end
```

`functions/node_modules` is only needed to load `index.js` (the Firebase entry); `src/` and its tests depend on
Node built-ins and the shared domain model only.

## Known open items (not Phase A1 scope)

- **Deploy packaging:** `src/brain-dump-query.js` imports the shared `brain-dump-model.js` (and its
  `plan-item-origin.js`) from the repository root, outside `functions/`. A deploy uploads only `functions/`, so a
  reviewed packaging step (e.g. vendoring with a parity check) is required before any deployment.
- **Invoker / rate limits / concurrency:** §13 per-principal and per-action rate limits and bounded concurrency
  are not implemented; the Cloud Run invoker policy is left at the platform default. Both are deploy-time
  decisions.
- **Response size:** §5's 64 KiB cap is enforced on request bodies. A very large Brain Dump could produce a larger
  `get_brain_dump` response; whether responses are capped/paginated is an open contract question.
- **Canonical path on the deployed URL:** the signed path is the request path the function sees (`/v1/query`).
  Phase B must verify it matches what the Worker signs for the deployed URL form.
