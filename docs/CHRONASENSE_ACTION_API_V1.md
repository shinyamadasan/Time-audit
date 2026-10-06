# ChronaSense Action API V1

**Status:** architecture proposal for strict review. Documentation only; no endpoint, Worker, Firebase configuration, or runtime code is implemented by this document.

## 1. Boundary and platform

ChronaSense is browser-first today. The browser authenticates with Firebase Auth and accesses RTDB directly in the private room `uid_<FirebaseUID>`; there is no production HTTP/backend API. V1 adds a ChronaSense-owned API on **Firebase Functions v2 HTTPS in `asia-southeast1`**. Firebase adjacency preserves the existing identity and RTDB rule model. Cloudflare remains the already-proven private transport: ChatGPT Plugin → public HTTPS Worker → OAuth 2.1/CIMD/PKCE S256 → dedicated OAuth KV; Cloudflare Access protects only `/authorize`; MCP tools are forwarded to this backend. Do not change that transport absent new incompatibility evidence.

The Worker owns OAuth, MCP schemas, scope checks, transport validation and narrow forwarding. It does not own domain state, PlanAuthority, Brain Dump transitions, Firebase access, or duplicated business rules. The backend owns identity binding, API validation, receipts, adapter selection and domain authority invocation.

## 2. Identity and service authentication

V1 is single-owner. The Worker derives the stable Cloudflare Access `sub` from its verified Access JWT and forwards it as `principalSubject`. The backend compares it to an exact configured subject and maps it to one exact configured Firebase UID. It derives `roomId = "uid_" + firebaseUid`; neither UID, room ID, Firebase path, nor target path is accepted from a caller. Missing, changed, or mismatched mapping fails closed. Rotation requires coordinated Worker/backend configuration change and verification before old mapping removal. Unlink disables the mapping and all calls; it does not delete Firebase data. Multi-user linking is outside V1.

Worker-to-backend requests use a dedicated random HMAC-SHA-256 secret shared only by the Worker and backend, with a `keyId` for rotation. Do not reuse OAuth, Firebase, or deployment credentials. The Worker sends verified subject, sorted normalized granted scopes, a fresh request ID, UTC timestamp, HTTP method/path and exact request body. Headers carry service identity `chronasense-plugin-worker-v1`, key ID, request ID, timestamp, and hex HMAC. Canonical UTF-8 signing input is the newline-joined tuple:

```
chronasense-worker-auth-v1
<keyId>
<serviceIdentity>
<uppercaseMethod>
<canonicalPath>
<timestampSeconds>
<requestId>
<principalSubject>
<comma-joined lexically sorted scopes>
<lowercase hex SHA-256 of exact raw body bytes>
```

Reject noncanonical paths, malformed/duplicate headers, unknown key IDs, invalid signatures (constant-time compare), body-hash mismatch, unknown service identity, missing scopes, and timestamps more than **300 seconds** from backend time. Request IDs are UUIDv4 and unique per HTTP attempt. Backend atomically records `serverRequestNonces/<requestId>` before dispatch and rejects an existing ID; entries become eligible for cleanup after 10 minutes. Retries use a new request ID and timestamp but retain command `actionId`. This nonce store is service metadata, never domain truth. Secrets never enter logs.

## 3. Firebase authority strategy

Use Admin SDK only for server infrastructure: validate configured UID, mint a Firebase custom token for that UID, and manage private receipts/request nonces. For domain RTDB reads/writes, exchange the custom token through Firebase Auth `accounts:signInWithCustomToken` for a short-lived Firebase ID token, then use authenticated RTDB REST requests with that ID token. The resulting `auth.uid` is the configured owner UID, so existing rules continue to enforce `uid_<auth.uid>` and domain constraints. Discard refresh tokens; obtain a new custom token/ID token when needed. Never send custom or ID tokens to the Worker or ChatGPT.

This is smaller than shipping browser Firebase compat objects into Functions and retains RTDB rule enforcement. Server code must verify all REST responses and preserve transaction/ETag semantics; a timeout is unknown, not absent. If a required Firebase operation cannot be expressed with user-authenticated RTDB REST transaction semantics, stop. Any alternative Admin domain write needs an explicitly reviewed equivalent enforcement layer covering UID/room binding, schema, fences, revisions, and all existing domain invariants; V1 does not assume Admin bypass is safe.

## 4. Domain adapter boundary

`ChronaSenseActionServiceV1` receives only a validated typed request and immutable `IdentityContext { principalSubject, firebaseUid, roomId, scopes }`. Flow: HTTP validation → identity binding → receipt claim/replay check → typed query/command → server adapter → existing pure domain model / PlanAuthority or Brain Dump authority → user-scoped RTDB → authoritative result → terminal receipt. The service never accepts arbitrary paths or generic writes.

Reusable candidates: `plan-authority.js` `createPlanAuthority(deps)` and its pure target/item rules; calendar/operational/legacy plan models and repositories; `brain-dump-model.js` validation/merge/state helpers; `brain-dump-promotion.js` orchestration; `brain-dump-repository.js` transactional state; and `coarse-life-evidence-model.js` only as relevant semantic reference, not an actual-log API. Preserve the Brain Dump remote claim → PlanAuthority destination → finalize/reconcile protocol, `claimEpoch`, revoke/presence/recovery and fenced item rules. External API adds authenticated actor/provenance, action ID, receipt and typed outward result; it is never another promotion state.

Production adapters currently depend on browser facilities and must be replaced/injected for server use: localStorage; `window`/DOM/render callbacks; global `currentUser` and `roomCode`; listener lifecycle; Firebase compat objects; device timezone fallback; and UI notification. Server adapters use explicit auth-scoped REST transactions/reads and explicit timezone. No model logic is copied into the Worker.

## 5. Envelope and response conventions

All API bodies use JSON, UTF-8, maximum **64 KiB**, reject unknown fields at envelope and tool-parameter levels, and declare `contractVersion: 1`. Account is never a parameter. Dates are Gregorian `YYYY-MM-DD`; instants are RFC 3339 UTC; IANA timezone identifiers must validate against the server tz database. Responses include `contractVersion`, `requestId`, typed `result`, and `authority` metadata. Authority metadata identifies source authority and store, factual target/date/timezone, authoritative record IDs, opaque revision/generation where available, and relevant provenance. No raw RTDB snapshots, arbitrary paths, sync internals, or recovery primitives are exposed.

### Query envelope

```json
{ "contractVersion": 1, "requestId": "<uuidv4>", "kind": "get_plan", "parameters": { "target": { "store": "calendar", "id": "cal1:2026-10-06" } } }
```

`requestId` is a per-attempt transport identifier, not conversational state or write idempotency. Query response records are typed projections, not raw Firebase objects. A query may return `authority`, `target`, `recordIds`, `revision`, `factualDate`, `timezone`, `provenance`, and typed domain fields. A read creates no life evidence and no command receipt.

### Command envelope

```json
{
  "contractVersion": 1,
  "actionId": "act1_<uuidv4>",
  "kind": "plan_update_same_target",
  "parameters": { "target": { "store": "calendar", "id": "cal1:2026-10-06" }, "itemId": "<stable-id>", "changes": { "title": "..." } },
  "expectedRevision": "rev1:<base64url-sha256>",
  "actionProvenance": { "version": 1, "sourceKind": "chatgpt_plugin", "actionId": "act1_<uuidv4>", "actorRef": "<backend-derived-opaque-principal-ref>", "capturedAt": "<RFC3339>" }
}
```

Exactly one user-intended mutation per command. `actionId` is generated in the trusted Worker/MCP layer, once, and retained across retries; never derive it from conversation order, message text, or a ChatGPT conversation identifier. Grammar is `^act1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. UUIDv4 provides global uniqueness; owner scoping additionally isolates receipt paths. Reusing an ID for any semantically changed command is a conflict. `actorRef` is a stable opaque reference computed by the trusted Worker and backend as `actor1:<base64url(SHA-256(UTF8("chronasense-action-actor-v1\n" + principalSubject)))>`; backend recomputes it from the signed subject and rejects mismatch. The backend verifies provenance action ID and source kind against the authenticated request.

For creates, derive the domain ID from the UUID suffix without randomness: Brain Dump capture ID `bdc1_<uuid>`; plan item ID `api1_<uuid>`. Store the assigned ID in the `started` receipt before mutation. If a current validator/store cannot accept these stable IDs, stop for a compatibility decision; do not fall back to a fresh random ID on retry. A different record already occupying the deterministic ID is a conflict.

Canonical request hashing uses RFC 8785 JSON Canonicalization Scheme over the validated semantic command object (`contractVersion`, `actionId`, `kind`, normalized `parameters`, `expectedRevision` or explicit null, and normalized `actionProvenance`). Reject duplicate JSON keys, non-finite numbers and invalid Unicode. Hash UTF-8 canonical bytes with SHA-256. Object key order is immaterial; array order and all normalized values are material. Same owner + actionId + same hash returns the original result and marks `idempotentReplay: true`; same ID + different hash returns `CONFLICT/ACTION_ID_REUSE` and never executes.

## 6. Action receipts, failures and crash semantics

Persist receipts at `serverActionReceipts/<firebaseUid>/<actionId>` through Admin-only infrastructure access. Explicitly deny normal clients read and write in rules before enabling the API; no broader room wildcard may grant receipt access. Receipts are operational/audit linkage, not domain truth. Retain indefinitely in V1; no TTL/expiry that could make an old retry execute twice. Fields: `contractVersion`, `actionId`, `requestHash`, `kind`, `status`, `authority`, `recordIds`, `effectiveTarget` (including factual date/timezone where relevant), `resultingRevision`/generation, `createdAt`, `appliedAt`, `updatedAt`, response-derived `idempotentReplay`, `retryability`, `resultCode`, `authorizationContext` (opaque principal reference, granted/required scopes and service identity), optional `interactionContextRef` (opaque UX confirmation reference, never authority), `actionProvenanceRefs`, and safe bounded result projection. Persist a deterministic planned record ID in the started receipt before a create mutation so a crash cannot regenerate a different ID.

State machine: `started` (claim persisted before execution), `pending_unknown` (outcome cannot yet be established), `applied`, `conflict`, `rejected`, or `needs_user_decision`. Terminal states are immutable except a reconciliation transition from `pending_unknown` to a proven terminal state. Claiming is an atomic transaction: absent → started; existing same hash → replay/reconcile; existing different hash → conflict. An action receipt is authoritative only for what ChronaSense accepted/applied; never for what happened in real life.

Do not claim exactly-once execution. If death occurs after `started` but before mutation, a retry reconciles authoritative state, then safely executes or reports unknown. If mutation succeeds before terminal receipt, a retry must prove the mutation from deterministic identity/current state and finish the receipt; if proof is impossible, retain `pending_unknown`. If response networking fails, caller retries same action ID and canonical body with a new transport request ID. Unknown is never reported as absent or failed.

Creates use deterministic domain IDs derived from action ID where compatible with the existing store grammar; a collision with different content conflicts. Updates require exact target/item and expected revision. If the current authoritative state equals the requested post-state and receipt is nonterminal, reconcile as applied; if it remains at the expected prior revision, safely apply; if it differs materially, conflict or pending_unknown. Completion follows the same checks plus existing carryover/history behavior. Brain Dump promotion must call and reconcile the existing fenced promotion authority; no second claim or promotion record is introduced.

## 7. Opaque revision

`rev1:<base64url(sha256)>` is an API token over canonical authoritative state, not a new persisted field. Reads return it; writes requiring optimistic concurrency present it. Inside the authenticated authoritative transaction, reread and recompute before mutation. Missing, stale or uncomputable revisions fail closed; never substitute `updatedAt` alone.

For plan items include store, physical target key, target date, timezone where it governs interpretation, stable item ID, all authoritative item fields, deletion/tombstone state, and any relocation/generation/origin state. For Brain Dump captures include capture ID, normalized semantic fields used by the command, status, classification/disposition, claim identity and `claimEpoch`, promotion identity, revoke/recovery state, reopen generation, and tombstone if present. Include target identity and fence generation so same-looking records in another store/date or a stale generation cannot share a token. Hash only canonical authoritative state relevant to that command, but document the exact field projection in implementation tests.

## 8. Action provenance and evidence boundary

See companion [Action Provenance V1](../contracts/CHRONASENSE_ACTION_PROVENANCE_V1.md). A command records controller intent, not performed activity. A plan is intention, not actual evidence. Provenance can point to evidence, and evidence may motivate an action, but transformed copies do not become independent evidence. No raw prompt storage, confidence probability, or life-evidence write is added. See [Evidence Contract V1](../contracts/CHRONASENSE_EVIDENCE_CONTRACT_V1.md), which remains semantic authority.

## 9. Time contract

Natural language time is resolved before the domain write. V1 writes accept explicit factual `date`, an exact PlanAuthority target returned by a read, `HH:MM`, integer `whenDayOffset`, positive `durationMinutes` when timed, and explicit target/item IANA timezone where time meaning depends on it. No implicit device timezone or server-local fallback. A target is a store plus exact stable ID/key; backend resolves it through PlanAuthority and verifies destination identity.

`whenDayOffset` is relative to the target's factual date; `HH:MM` is wall time in the explicit target timezone. DST spring gaps are rejected with `AMBIGUOUS_TIME`; repeated fall times require an explicit `earlier`/`later` disambiguator resolved to a UTC instant while retaining wall fields and zone. Cross-midnight requires explicit day offset and duration and must remain within domain limits; no inferred overnight duration. Historical plan targets are immutable under existing PlanAuthority rules; completion cannot silently rewrite history. Any unresolved date, timezone, DST occurrence or target returns `NEEDS_USER_DECISION` (specialized `AMBIGUOUS_TIME` where applicable), without mutation.

## 10. V1 tools

All reads require `chronasense:read`:

| Tool | Typed result |
|---|---|
| `chronasense:get_today` | factual date/timezone, resolved PlanAuthority target, typed plan summary and authoritative IDs/revision |
| `chronasense:get_plan` | exact requested/resolved target and typed plan items, IDs, revision and provenance |
| `chronasense:get_brain_dump` | typed captures and allowed dispositions, revisions and IDs; no claims/fence internals |
| `chronasense:get_item` | exact typed item/capture by allowed store + stable record ID, authority and revision |

Do not expose raw Firebase, arbitrary target paths, sync internals, remote-presence or recovery tools. Defer `get_recent_actuals` until actual/evidence querying has a coherent authority contract.

Writes use the listed single-intent commands only:

| Tool | Required guard / outcome |
|---|---|
| `brain_dump_add` | `parameters.text` required; server assigns stable capture ID tied to actionId and creates the ordinary untriaged capture |
| `brain_dump_triage` | `captureId`, `expectedRevision`, and both explicit `important`/`urgent` booleans; one atomic classification |
| `brain_dump_promote` | `captureId`, `expectedRevision`, exact resolved target, and explicit promotion intent/time fields; existing claim/fence/finalize/reconcile path |
| `brain_dump_disposition` | `captureId`, `expectedRevision`, and one of archive/delegate/reopen; delegated disposition also requires explicit `delegatedTo`; promoted captures refuse this command |
| `plan_create` | explicit target/date/timezone, title, supported typed fields, and deterministic item identity tied to actionId |
| `plan_update_same_target` | exact target/item, expectedRevision, allowlisted changed fields, and physical target unchanged |
| `plan_complete` | exact target/item, expectedRevision, narrow completion only; existing history/carryover rules |

No V1 delete/tombstone, cross-target move/reschedule, calendar activation, Personal Day/boundary mutation, `actual_log`, arbitrary Firebase write, generic execute tool, or active Brain Dump edit. If active edit semantics are defined and reviewed later, add a separate command.

## 11. Scopes and authorization

Scopes are `chronasense:read`, `chronasense:brain-dump.write`, and `chronasense:plan.write`. Initial Plugin authorization requests read only. Each write invocation requires OAuth scope step-up for the matching write scope; Worker verifies token scope and backend independently verifies signed normalized grants. ChatGPT interactive confirmation is UX only. Backend relies on verified scope, exact identity binding, typed validation, revisions and domain rules, never `confirmed: true`.

## 12. Error contract

Responses have stable `code`, safe human-readable `message`, `retryability`, and optional `details` limited to typed fields. Map domain semantics as follows:

| Code | Meaning |
|---|---|
| `INVALID_INPUT` | malformed/unsupported envelope or typed parameters |
| `AUTH_REQUIRED` | missing/invalid OAuth or service authentication |
| `FORBIDDEN` | principal mismatch or insufficient scope |
| `NOT_FOUND` | authoritative absent target/record |
| `CONFLICT` | changed action body, identity collision, or incompatible state |
| `STALE_REVISION` | expected revision differs from authoritative state |
| `NEEDS_USER_DECISION` | underspecified target/action needing user choice |
| `PENDING_UNKNOWN` | remote/domain outcome cannot yet be established |
| `RETRYABLE_TRANSPORT` | transient failure with no known domain outcome |
| `ALREADY_APPLIED` | compatible prior result proven; normally returned as replayed receipt |
| `PAST_TARGET_IMMUTABLE` | existing PlanAuthority refuses historical mutation |
| `AMBIGUOUS_TIME` | unresolved timezone/DST/clock interpretation |
| `DOMAIN_LIMIT` | valid shape exceeds existing model/domain constraints |

Map malformed wire records to `CONFLICT` or `PENDING_UNKNOWN` according to whether authoritative state is known. Never collapse timeout/unknown into not-found or rejection. Preserve PlanAuthority and Brain Dump refusal semantics; do not invent success.

## 13. Security requirements

No caller UID/room/path; exact configured subject mapping; signed Worker identity, body hash and freshness; replay nonce plus stable command idempotency; narrow scopes and step-up; 64 KiB body cap; per-principal and per-action rate limits; bounded concurrency; private receipts; no secrets or raw prompts in logs; domain validation and revision checks; explicit time resolution; fail closed on identity, revision or state uncertainty; no arbitrary Firebase access. Worker is transport only. Receipt storage is metadata only. Service-account/Admin paths are limited to documented infrastructure. Every backend domain call uses the configured user's scoped Firebase ID token.

## 14. Implementation phases

1. **A — backend/auth skeleton:** Functions v2, subject→UID config, HMAC verifier, scoped ID-token exchange, private receipts/nonces, typed errors and read-only queries.
2. **B — read-only MCP:** Worker tools and OAuth read scope; accept live typed reads; verify no raw data leakage.
3. **C — Brain Dump writes:** receipts/reconciliation, existing promotion authority, strict review, write-scope step-up.
4. **D — Plan writes:** create/update/complete, deterministic IDs and revisions, strict concurrency review, write-scope step-up.
5. **E — actual/evidence:** only after a separate authority and evidence model is designed.

Each phase is separately reviewable and deployable; do not bundle into one implementation PR.

## 15. Stop conditions

Stop implementation if principal→UID binding is ambiguous; a caller controls room/path; domain writes require Admin bypass without reviewed equivalent enforcement; replay cannot be proven for a command; revision cannot be established; time target is ambiguous; a tool needs raw repository/Firebase mutation; browser-only authority cannot be safely adapted; or the API starts becoming a competing truth store. Stop on any unknown authoritative outcome until operation-specific reconciliation proves applied/absent/conflict.
