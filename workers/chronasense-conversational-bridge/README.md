# ChronaSense Conversational Read Worker

This is the canonical, read-only Cloudflare OAuth/MCP Worker for `TASK-009`. It forwards five fixed tools to the existing Firebase Functions `/v1/query` Action API. Domain reads and Intelligence V1 derivation stay in ChronaSense. Nothing in this directory deploys automatically.

## Routes and grants

- `/authorize` verifies a Cloudflare Access JWT (RS256, exact issuer/audience, `type=app`) and binds its `sub` to the configured owner subject. Email is never an identity key.
- `/authorize` consent POST reads at most 8,192 body bytes before parsing its form, using the same inclusive form bound as `/oauth/token`.
- `/mcp`, `/oauth/token`, and OAuth `.well-known` routes remain public to the OAuth protocol; the OAuth provider authenticates MCP bearer tokens. The `chronasense:read` scope is required on every tool call and signed again to the backend.
- CIMD is enabled. No dynamic client registration endpoint is configured. The provider enforces S256 PKCE for public authorization-code clients.
- Tools: `get_brain_dump`, `get_today`, `get_plan`, `get_item`, `get_intelligence`. There are no write tools or generic Firebase path inputs.

## Deployment configuration (pending authorization)

The `OAUTH_KV` binding uses the dedicated `chronasense-conversational-bridge-oauth` namespace ID already supplied in `wrangler.jsonc`. Configure these values in Cloudflare at deployment time; no production value is stored here:

| Name | Meaning |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | Exact HTTPS Cloudflare Access team issuer. |
| `ACCESS_POLICY_AUD` | Access application audience for `/authorize`. |
| `CHRONASENSE_OWNER_SUBJECT` | The **real verified Access JWT `sub`**, also configured as the Action API owner subject. Never derive it from email. |
| `CHRONASENSE_ACTION_API_URL` | HTTPS Firebase Function URL ending exactly `/v1/query`. |
| `CHRONASENSE_WORKER_HMAC_KEY_ID` | ID of a key in the backend's `CHRONASENSE_WORKER_HMAC_KEYS` map. |
| `CHRONASENSE_WORKER_HMAC_KEY_HEX` | Matching 32–128 random-byte lowercase hex key, stored as a secret. |

Cloudflare Access should protect `/authorize` only. Do not place Access in front of `/mcp`, `/oauth/token`, or `.well-known` discovery. The matching backend owner Firebase UID and RTDB URL are configured in Firebase separately. Production owner-sub discovery, secret setup, Access policy and deployment are outside this local milestone.

## Local checks

Run `npm ci`, `npm test`, and `npm run check:bundle` in this directory. The bundle check is a Wrangler dry run; it compiles without uploading or deploying. Tests use explicit fixture subjects and keys, exercise MCP tool routing/scope and HMAC compatibility with the existing Action API, and make no external calls.

`get_intelligence` recomputes the shipped deterministic model from server-readable plan, entries, Brain Dump, appointment and broad-evidence records. Device-local routine completion and live timer state are reported as unevaluated; the read does not infer their absence or convert derived interpretation into canonical truth.
