# ChronaSense Conversational Actions Worker

This Worker preserves TASK-009's five read tools, TASK-010's Brain Dump create and TASK-011's `plan_create`, and adds the TASK-012 plan item mutation candidate (`plan_set_completion`, `plan_edit`, `plan_move`, `plan_delete`). It forwards fixed typed calls to the Firebase Functions `/v1/query` and `/v1/command` routes. Domain decisions stay in ChronaSense. Nothing in this directory deploys automatically.

## Routes and grants

- `/authorize` verifies a Cloudflare Access JWT (RS256, exact issuer/audience, `type=app`) and admits its `sub` only if it is on the explicit allowlist: `CHRONASENSE_OWNER_SUBJECT`, plus `CHRONASENSE_SECOND_SUBJECT` when set (TASK-029). Email is never an identity key. The grant's `userId` and `props.ownerSubject` (the subject that owns the grant) are both that verified `sub`. Every MCP call re-checks that they agree and are still allowlisted, then signs exactly that subject to the backend. Removing the second subject from config (and redeploying) therefore makes every `/mcp` call with that user's existing tokens fail. This rejects the tokens but does not revoke them. Their grant and refresh token stay in `OAUTH_KV` (refresh TTL 14 days), and would work again if the same `sub` were re-allowlisted. When removing a user, also delete that subject's grant and token records from `OAUTH_KV`. List the keys first and check the prefix; never delete owner keys.
- `/authorize` consent POST reads at most 8,192 body bytes before parsing its form, using the same inclusive form bound as `/oauth/token`.
- `/mcp`, `/oauth/token`, and OAuth `.well-known` routes remain public to the OAuth protocol; the OAuth provider authenticates MCP bearer tokens. Reads require `chronasense:read`; each create also requires explicit step-up to its own write scope (`brain_dump_add`: `chronasense:brain-dump.write`; `plan_create`: `chronasense:plan.write`). A grant for one write scope never unlocks the other. The Worker signs only the one required scope to the backend.
- CIMD is enabled. No dynamic client registration endpoint is configured. The provider enforces S256 PKCE for public authorization-code clients.
- Tools: `get_brain_dump`, `get_today`, `get_plan`, `get_item`, `get_intelligence`, `brain_dump_add`, `plan_create` (one new task on an exact calendar-day plan) and, under the same `chronasense:plan.write` scope, `plan_set_completion`, `plan_edit`, `plan_move` and `plan_delete` (`destructiveHint: true`). Each mutation names one existing item by `target` + `itemId` and passes the `expectedRevision` a read returned (`plan_move` also moves ChatGPT-created `api1_` tasks; Brain Dump tasks stay on their day); `STALE_REVISION` is definite and its text names the current revision. There is no generic write, patch or Firebase path input.
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
| `CHRONASENSE_SECOND_SUBJECT` | Optional (TASK-029). The second user's real verified Access JWT `sub`. It must differ from the owner's and equal the backend's `CHRONASENSE_SECOND_SUBJECT`. It is passed only when present in `.deploy-vars.json`; a deploy without it removes it (owner only). It is deliberately absent from `deploy-vars.example.json`, so that a copied placeholder can never allowlist anyone. |
| `CHRONASENSE_ACTION_API_URL` | HTTPS Firebase Function URL ending exactly `/v1/query`; the command client derives the sibling `/v1/command` URL. |
| `CHRONASENSE_WORKER_HMAC_KEY_ID` | ID of a key in the backend's `CHRONASENSE_WORKER_HMAC_KEYS` map. |
| `CHRONASENSE_WORKER_HMAC_KEY_HEX` | Matching 32–128 random-byte lowercase hex key, stored as a secret. |

Cloudflare Access should protect `/authorize` only, with an Allow policy naming exactly the allowlisted people. Keep Cloudflare Managed OAuth **off**: this Worker is its own OAuth server. Do not place Access in front of `/mcp`, `/oauth/token`, or `.well-known` discovery. The matching backend owner Firebase UID and RTDB URL are configured in Firebase separately. Production owner-sub discovery, secret setup, Access policy and deployment are outside this local milestone.

## Local checks

Run `npm ci`, `npm test`, and `npm run check:bundle` in this directory. The bundle check is a Wrangler dry run; it compiles without uploading or deploying. Tests use explicit fixture subjects and keys, exercise MCP tool routing/scope and HMAC compatibility with the existing Action API, and make no external calls.

`get_intelligence` recomputes the shipped deterministic model from server-readable plan, entries, Brain Dump, appointment and broad-evidence records. Device-local routine completion and live timer state are reported as unevaluated; the read does not infer their absence or convert derived interpretation into canonical truth.

## ChatGPT OAuth renewal

This Worker advertises `offline_access` so ChatGPT can request refresh-token renewal in addition to the narrowly scoped ChronaSense permissions. The token endpoint, Cloudflare OAuth provider and dedicated `OAUTH_KV` remain unchanged: access tokens expire after 15 minutes, and refresh tokens after 14 days. `offline_access` grants **no** ChronaSense data-write permission; tool calls must still satisfy `chronasense:read` and the specific write scope when applicable.

After an **explicitly approved** Worker deployment, verify live `.well-known/oauth-authorization-server` metadata advertises `offline_access`, then validate the authorization-code response includes a refresh token, and test a `grant_type=refresh_token` exchange against `/oauth/token` using a test account. Never log token values. Recreate/reconnect the private ChatGPT connection if it cached old discovery metadata. Run a read-only tool call, allow the 15-minute access token to expire, and run another; confirm it succeeds without a new login. Custom MCP mobile support is not guaranteed, so test the mobile surface separately. Do not deploy as part of this documentation change.

## Grant coexistence

Every ChatGPT surface that connects gets its own grant: web, mobile, and each reconnect. A new authorization no longer revokes the subject's other grants (`revokeExistingGrants: false`). Before `/authorize` adds a grant, it revokes that subject's oldest live grants for the same client, redirect and resource. At most `MAX_GRANTS_PER_CLIENT` (5) stay live, the new one included. Pending grants (approved, code not yet exchanged) are not counted. They expire after 10 minutes. The 15-minute access and 14-day refresh lifetimes are unchanged. A client's own revocation (RFC 7009 on `/oauth/token` with a refresh token) removes only that grant. Grants are listed and revoked only under the subject's own `grant:<sub>:` prefix, so one user's connections never affect the other's. To sign out every holder of a subject, delete all of that subject's `grant:<sub>:*` and `token:<sub>:*` keys from `OAUTH_KV`. List the keys first, and never touch the other subject's keys.
