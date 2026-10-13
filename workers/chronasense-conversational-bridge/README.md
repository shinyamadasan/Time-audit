# ChronaSense Conversational Actions Worker

This Worker preserves TASK-009's five read tools, TASK-010's Brain Dump create and TASK-011's `plan_create`, and adds the TASK-012 plan item mutation candidate (`plan_set_completion`, `plan_edit`, `plan_move`, `plan_delete`). It forwards fixed typed calls to the Firebase Functions `/v1/query` and `/v1/command` routes. Domain decisions stay in ChronaSense. Nothing in this directory deploys automatically.

## Routes and grants

- `/authorize` verifies a Cloudflare Access JWT (RS256, exact issuer/audience, `type=app`) and binds its `sub` to the configured owner subject. Email is never an identity key.
- `/authorize` consent POST reads at most 8,192 body bytes before parsing its form, using the same inclusive form bound as `/oauth/token`.
- `/mcp`, `/oauth/token`, and OAuth `.well-known` routes remain public to the OAuth protocol; the OAuth provider authenticates MCP bearer tokens. Reads require `chronasense:read`; each create also requires explicit step-up to its own write scope (`brain_dump_add`: `chronasense:brain-dump.write`; `plan_create`: `chronasense:plan.write`). A grant for one write scope never unlocks the other. The Worker signs only the one required scope to the backend.
- CIMD is enabled. No dynamic client registration endpoint is configured. The provider enforces S256 PKCE for public authorization-code clients.
- Tools: `get_brain_dump`, `get_today`, `get_plan`, `get_item`, `get_intelligence`, `brain_dump_add`, `plan_create` (one new task on an exact calendar-day plan) and, under the same `chronasense:plan.write` scope, `plan_set_completion`, `plan_edit`, `plan_move` and `plan_delete` (`destructiveHint: true`). Each mutation names one existing item by `target` + `itemId` and passes the `expectedRevision` a read returned; `STALE_REVISION` is definite and its text names the current revision. There is no generic write, patch or Firebase path input.
- A write with an unreadable response, timeout, or backend unknown status returns structured `outcome: unknown`, `mayHaveCommitted: true`, and exact retry arguments (`actionId`, `capturedAt`, `expectedRevision` for a mutation, the tool's own parameters, `newActionIdAllowed: false`). Definite backend rejections remain definite. The Function request is capped at 120 seconds; the Worker waits at most 130 seconds for its response. Reads retain their 10-second timeout.

## Deployment

Deploy only with `npm run deploy` (`scripts/deploy.mjs`), never a plain `wrangler deploy`: during the TASK-011 rollout a plain deploy deleted the five plaintext bindings below and `--keep-vars` did not restore them. The script reads them from an untracked `.deploy-vars.json` (gitignored; shape in `deploy-vars.example.json`, placeholders only), refuses a missing, malformed, unexpected or secret entry, passes all five explicitly as `--var`, and prints the plan with every value redacted. Without flags it only validates and prints; `--dry-run` compiles (`wrangler deploy --dry-run`, nothing uploaded); `--confirm` deploys and is an owner-authorized production action. After a real deploy, verify the five bindings on the new version and that `/authorize` renders. `CHRONASENSE_WORKER_HMAC_KEY_HEX` stays a Cloudflare secret (`wrangler secret put`), never in the vars file.

## Deployment configuration

The `OAUTH_KV` binding uses the dedicated `chronasense-conversational-bridge-oauth` namespace ID already supplied in `wrangler.jsonc`. Configure these values in Cloudflare at deployment time; no production value is stored here:

| Name | Meaning |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | Exact HTTPS Cloudflare Access team issuer. |
| `ACCESS_POLICY_AUD` | Access application audience for `/authorize`. |
| `CHRONASENSE_OWNER_SUBJECT` | The **real verified Access JWT `sub`**, also configured as the Action API owner subject. Never derive it from email. |
| `CHRONASENSE_ACTION_API_URL` | HTTPS Firebase Function URL ending exactly `/v1/query`; the command client derives the sibling `/v1/command` URL. |
| `CHRONASENSE_WORKER_HMAC_KEY_ID` | ID of a key in the backend's `CHRONASENSE_WORKER_HMAC_KEYS` map. |
| `CHRONASENSE_WORKER_HMAC_KEY_HEX` | Matching 32–128 random-byte lowercase hex key, stored as a secret. |

Cloudflare Access should protect `/authorize` only. Do not place Access in front of `/mcp`, `/oauth/token`, or `.well-known` discovery. The matching backend owner Firebase UID and RTDB URL are configured in Firebase separately. Production owner-sub discovery, secret setup, Access policy and deployment are outside this local milestone.

## Local checks

Run `npm ci`, `npm test`, and `npm run check:bundle` in this directory. The bundle check is a Wrangler dry run; it compiles without uploading or deploying. Tests use explicit fixture subjects and keys, exercise MCP tool routing/scope and HMAC compatibility with the existing Action API, and make no external calls.

`get_intelligence` recomputes the shipped deterministic model from server-readable plan, entries, Brain Dump, appointment and broad-evidence records. Device-local routine completion and live timer state are reported as unevaluated; the read does not infer their absence or convert derived interpretation into canonical truth.
