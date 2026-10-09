# Conversational Read V1 — strict review handoff

Task: TASK-009. Base: `a32dae209d1a95a13d9df832a7177992cfff205a` (live `origin/main` when branched). Candidate: `task-009-conversational-read-v1`. This branch is a local, read-only deployment candidate; no service or production data was changed.

## Contract and authority

`get_brain_dump` keeps TASK-005 output. `get_plan` returns the current authoritative plan or an exact `{store,id}` target. `get_today` returns the current plan and derived attention. `get_item` requires a stable capture ID or a stable plan item ID plus exact plan target; known tombstone or relocation is explicit. `get_intelligence` recomputes shipped Intelligence V1 from server-readable evidence. Its fact, derived, unknown and pattern tags and source refs remain interpretations. Absence of linked actual work never means the work did not happen.

All five kinds use the existing HMAC envelope, subject→UID binding, nonce claim, user-scoped RTDB reader, strict error shape and 64 KiB response cap. The reader accepts only fixed room collections. No caller-controlled Firebase path, Admin domain read, command, receipt creation or write tool was added.

Plan targets preserve calendar-native `cal1:` IDs, personal-day operational IDs and legacy date IDs. The no-target read follows current routing; an exact target can still inspect a historical legacy record superseded by calendar cutover, so an open-loop item remains addressable. Calendar item instants use their frozen item timezone and day offset; plan home intervals use the plan's frozen timezone. Operational items and stale unfinished plans use the existing boundary and recovery models. Deterministic item ordering, revisions and source references make reads traceable. Device-local routine completion and live timer state are explicitly unevaluated in server Intelligence reads.

The fenced Brain Dump child wins over a stale same-ID plan-array copy under the shipped fence merge rule. ID-only deleted entry tombstones are recognized and excluded from actual evidence. Full fixed collections are read for these views; an oversized response is refused whole with `DOMAIN_LIMIT` rather than truncated into a misleading partial result.

## Worker

The canonical Worker is `workers/chronasense-conversational-bridge/`, with the dedicated `OAUTH_KV` namespace. OAuth uses CIMD, no dynamic registration endpoint, S256 PKCE for public clients, and exact `chronasense:read` scope and MCP resource. Cloudflare Access JWT verification is applied at `/authorize`; the verified `sub` must equal configured `CHRONASENSE_OWNER_SUBJECT`. MCP bearer auth, token audience and per-tool scope are checked on every read. The Worker signs one Action API request per tool call and performs no domain derivation.

The `ISSUER`/resource URL is pinned to the intended `workers.dev` hostname. Strict review should verify that this hostname is the actual one assigned at deployment before configuring ChatGPT. No Access team domain, audience, real owner subject, backend URL, Firebase UID or HMAC secret is in the repo.

## Review focus

- Check calendar cutover, frozen home and item zones, operational overnight routing, stale recovery and historical plan validation against PlanAuthority.
- Check that a malformed or contradictory authority snapshot fails closed, including fence records and duplicate stable IDs.
- Check OAuth resource and scope binding, Access JWT `sub` handling, public protocol routes and HMAC tuple compatibility.
- Check fixed MCP tool list, typed parameters, 64 KiB cap and absence of production deployment automation.
- Update `CODEMAP.md` during the owner/Claude documentation pass if the new Function and Worker area needs indexing; the repository's `AGENTS.md` ownership rule prevents Codex from editing that file in this task.

## Deployment requirements after strict review

Separately authorize and configure Firebase rules and Action API deployment in their required order; set the backend owner Firebase UID, exact Access JWT subject, RTDB URL, Web API key and HMAC key map. Configure Cloudflare Access for `/authorize` only, observe the real JWT `sub`, then set the same subject in Worker and backend. Configure the Worker Access team domain/audience, Action API URL and matching HMAC key. Deploy the dedicated Worker, verify OAuth discovery, consent, token grant and each read against the real owner account, then connect ChatGPT. These actions were not performed in TASK-009.

## Verification

Local and hosted gate results are recorded in `TEST_REPORT.md` and the TASK-009 entry in `TASKS.md` after completion. No real account data or production route was used by local tests.
