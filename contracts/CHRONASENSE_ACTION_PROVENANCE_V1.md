# ChronaSense Action Provenance V1

**Status:** contract proposal for strict review. It defines controller/action provenance only; no runtime schema or capture flow is implemented here.

This contract accompanies and does not replace [ChronaSense Evidence Contract V1](CHRONASENSE_EVIDENCE_CONTRACT_V1.md). Evidence describes what observations support. Action provenance describes who/controller requested a ChronaSense mutation and how the request reached the service.

## Meaning

An Action API command means **“the user/controller requested this action.”** It does not establish that the user performed the planned activity, that a Brain Dump item occurred, or that an actual was observed. Plan intent remains intent. A command receipt establishes only what ChronaSense accepted/applied.

Provenance may reference evidence that motivated an action. Evidence may itself have been captured before, during, or after an action. A transformed copy or summary is not independent evidence solely because it passed through this API. Do not duplicate it as new truth.

## `ActionProvenanceV1`

Required fields:

| Field | Meaning |
|---|---|
| `version` | Literal integer `1`. |
| `sourceKind` | `chatgpt_plugin` for this transport. Future values require a versioned extension. |
| `actionId` | Exact command action ID; must equal envelope `actionId`. |
| `actorRef` | `actor1:<base64url(SHA-256(UTF8("chronasense-action-actor-v1\n" + principalSubject)))>`; stable opaque reference to the verified external principal, not Firebase UID or room ID. Worker computes it from its verified subject; backend recomputes and rejects mismatch. |
| `capturedAt` | RFC 3339 UTC time when the trusted Worker formed the command, preserved across retry. |

Optional fields:

| Field | Meaning |
|---|---|
| `externalRequestId` | Opaque MCP/Worker invocation reference; per-attempt request IDs belong to transport auth and need not be repeated here. |
| `conversationRef` | Opaque conversation reference, only if available and policy permits; never required for identity, truth, replay or authorization. |
| `messageRef` | Opaque message reference, only if available; never raw prompt text. |
| `evidenceRefs` | Array of opaque authoritative evidence IDs or references, with source namespace when needed. References do not copy evidence payloads. |
| `interpretationRef` | Optional versioned interpretation/rule reference when interpretation materially shaped structured parameters. |

No raw ChatGPT prompt/transcript, universal confidence probability, guessed actor identity, or conversation-order idempotency is stored. The minimal references needed for audit are retained with the action receipt subject to its retention policy.

## Receipt relation

The server receipt links `actionId`, request hash, authority, affected record IDs, effective target, result, and provenance/evidence refs. Its `appliedAt` is server time for the accepted domain mutation, not proof of a real-world activity time. For reads, no action provenance receipt is created. See [Action API V1](../docs/CHRONASENSE_ACTION_API_V1.md) for authentication, idempotency and receipt lifecycle.
