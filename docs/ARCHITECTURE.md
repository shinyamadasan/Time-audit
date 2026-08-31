# Architecture

> Subsystems by **named entry point**, data flow, and where things live.
> Never reference line numbers — they rot. Name functions, DOM ids, storage keys, DB paths.

## Capability/Career V1

**Entry points:** `renderCapabilityCareer()` in `capability-career-ui.js`, `createCapabilityCareerRepository()` in `capability-career-repository.js`, and `analyzeCapabilityCareer()` in `capability-career-analytics.js`.

**Storage:** local-only `localStorage` key `ta3-capability-career-v1`. The value is a versioned envelope with one validated Capability/Career profile. There is no Firebase sync, no Obsidian export, and no Life Ledger snapshot inclusion for this data in V1.

**Entities:** Capability/Career owns skills, knowledge areas, tools, career targets, projects, portfolio artifacts, and evidence mappings. Stable IDs are generated once by the model layer; titles and names are editable labels, not identity.

**Life Ledger boundary:** Life Ledger remains factual history: "this happened." Capability/Career stores contextual interpretation: "this fact demonstrates this capability in this dimension." Evidence mappings may reference a Life Ledger `eventId` and logical key, but they do not copy, mutate, rewrite, or infer source events.

**Evidence semantics:** Evidence dimensions are explicit: `knowledge`, `practice`, `execution`, `shipping`, and `portfolio`. The UI requires the user to pick the dimension. No code path infers dimension from activity text, project title, or Life Ledger event title.

**Analytics:** `capability-career-analytics.js` centralizes V1 thresholds and rules. It uses an injected `now` for deterministic tests, classifies momentum as `no-evidence`, `active`, `growing`, or `stale`, detects conservative stalls, and returns one explainable next action with a reason string.

**Import:** `capability-career-import.js` accepts strict JSON only. Preview parses and validates references before persistence. Durable IDs are generated only when the preview is saved. Malformed input and missing references do not write partial data.

**Known V1 limits:** no external URL fetching, no GitHub/cloud integration, no Obsidian output, no AI interpretation, no destructive delete UI, and no automatic evidence tagging.
