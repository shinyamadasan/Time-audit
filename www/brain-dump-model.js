// brain-dump-model.js
//
// Pure. The canonical model for a BRAIN DUMP CAPTURE — a fast, undated thought or
// task the owner wants to get out of their head before deciding where it belongs.
//
// ── why this is a new store and not a plan item ─────────────────────────────
// A plan item always belongs to an authoritative day (legacy/operational/calendar)
// and is reached through Plan Authority. A capture, by definition, does not yet
// belong anywhere — forcing it into a day at the moment of capture is exactly the
// planning friction this feature exists to remove. So capture is its own flat,
// day-less store; a day is only assigned later, explicitly, by promotion.
//
// ── lifecycle ─────────────────────────────────────────────────────────────────
//
//   untriaged -> triaged -> { promoted | archived | delegated }
//
// `promoted` / `archived` / `delegated` are TERMINAL dispositions: once set, the
// record is done being an actionable Brain Dump item. Nothing here ever deletes a
// capture — there is no "delete" action in V1 — so every record that has ever
// existed stays discoverable by its own id, with its full history on it. Absence
// is therefore trivially never deletion: no caller ever drops a key from the map.
//
// ── delegate is a disposition, not a destination (deliberate V1 scope) ──────
// This codebase has no existing model for handing work to another person — no
// commitment-to-someone-else, no assignee, no second task store. Building one here
// would be exactly the "second task-management system to satisfy a button label"
// the product brief forbids. So `delegate` records a terminal status plus an
// optional free-text `delegatedTo` note on the capture itself — the same shape of
// action as `archive`, with a different label and meaning. It creates nothing
// downstream and tracks nothing about the delegate. A real delegation destination
// is future product surface, not this phase's job.
//
// ── Eisenhower triage is advisory, never automatic ───────────────────────────
// `important`/`urgent` classify a capture; `quadrantOf()` turns that into a label
// for the UI. Classifying a capture NEVER changes its status or disposition by
// itself — the owner always chooses Do Today / Schedule / Archive / Delegate as a
// separate, explicit action, exactly as the product brief requires.
//
// ── identity ──────────────────────────────────────────────────────────────────
// Ids are minted the same way commitments-model.js's are: opaque, immutable, free
// of every Firebase-forbidden key character, and never derived from the text (the
// text is editable-adjacent in spirit even though V1 has no edit action — identity
// must not depend on content).

export const BRAIN_DUMP_SCHEMA_VERSION = 1;

export const BRAIN_DUMP_STATUSES = new Set(['untriaged', 'triaged', 'promoted', 'archived', 'delegated']);
/** Terminal: once a capture reaches one of these, it is no longer an actionable
 *  Brain Dump list item. Triage data may still be edited for record-keeping, but
 *  the status itself never reverts in V1 (there is no "undo" action). */
export const TERMINAL_STATUSES = new Set(['promoted', 'archived', 'delegated']);
export const PROMOTION_TYPES = new Set(['do-today', 'schedule']);

const MAX_TEXT = 1000;
const MAX_DELEGATED_TO = 200;
const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
/** The deterministic plan-item id namespace a promoted capture mints into. '|' is
 *  the separator (mirrors plan-authority.js's OPERATIONAL_CARRY_ID_PREFIX
 *  convention) because a minted capture id is restricted to ID_RE and can never
 *  itself contain '|', so the prefix can never collide with a bare capture id. */
export const BRAIN_DUMP_PLAN_ITEM_PREFIX = 'bdp1';

export function validBrainDumpId(value) {
  // Base36-ish and free of every Firebase-forbidden key character, exactly like
  // validCommitmentId — so the same string is usable verbatim as a remote key.
  return typeof value === 'string' && ID_RE.test(value);
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

function cleanDelegatedTo(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_DELEGATED_TO) : null;
}

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function writer(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200 ? value : null;
}

/** The deterministic plan-item id a capture promotes into. Deterministic (never
 *  minted fresh) so a retried promotion — after a crash, a network drop, or a
 *  second device racing the same action — always names the SAME plan item instead
 *  of creating a duplicate. Built from the capture's own immutable id only. */
export function brainDumpPlanItemId(captureId) {
  if (!validBrainDumpId(captureId)) throw new Error('A valid capture id is required.');
  return `${BRAIN_DUMP_PLAN_ITEM_PREFIX}|${captureId}`;
}

/** Builds a NEW untriaged capture. Capture is deliberately minimal: no time, no
 *  date, no category, no priority, no Eisenhower answers — just the thought.
 *  @returns {{ok:true, record:object} | {ok:false, reason:string, field?:string}} */
export function buildCapture(input = {}) {
  const { id, text, now, updatedBy } = input;
  if (!validBrainDumpId(id)) return { ok: false, reason: 'invalid-input', field: 'id' };
  const cleanedText = cleanText(text);
  if (!cleanedText) return { ok: false, reason: 'invalid-input', field: 'text' };
  const createdAt = timestamp(now);
  if (!createdAt) return { ok: false, reason: 'invalid-input', field: 'now' };
  const by = writer(updatedBy);
  if (!by) return { ok: false, reason: 'invalid-input', field: 'updatedBy' };
  return {
    ok: true,
    record: {
      schemaVersion: BRAIN_DUMP_SCHEMA_VERSION,
      id,
      text: cleanedText,
      createdAt,
      updatedAt: createdAt,
      updatedBy: by,
      status: 'untriaged',
      important: null,
      urgent: null,
      triagedAt: null,
      disposedAt: null,
      promotion: null,
      delegatedTo: null,
    },
  };
}

/** Records the Eisenhower classification. Atomic: both `important` and `urgent`
 *  are answered together, so there is no half-triaged state to reason about.
 *  Classifying NEVER changes a terminal disposition and never writes to any plan
 *  — it only ever moves `untriaged` -> `triaged`; a capture already promoted,
 *  archived or delegated keeps that status (re-classifying it is still allowed,
 *  for record-keeping, but it stays disposed of). */
export function triageCapture(current, patch = {}) {
  const base = normalizeCapture(current);
  if (!base) return { ok: false, reason: 'invalid-input', field: 'record' };
  if (typeof patch.important !== 'boolean') return { ok: false, reason: 'invalid-input', field: 'important' };
  if (typeof patch.urgent !== 'boolean') return { ok: false, reason: 'invalid-input', field: 'urgent' };
  const now = timestamp(patch.now);
  if (!now) return { ok: false, reason: 'invalid-input', field: 'now' };
  const by = writer(patch.updatedBy);
  if (!by) return { ok: false, reason: 'invalid-input', field: 'updatedBy' };
  return {
    ok: true,
    record: {
      ...base,
      important: patch.important,
      urgent: patch.urgent,
      triagedAt: now,
      status: TERMINAL_STATUSES.has(base.status) ? base.status : 'triaged',
      updatedAt: now,
      updatedBy: by,
    },
  };
}

function disposeCapture(current, status, extra, patch) {
  const base = normalizeCapture(current);
  if (!base) return { ok: false, reason: 'invalid-input', field: 'record' };
  const now = timestamp(patch.now);
  if (!now) return { ok: false, reason: 'invalid-input', field: 'now' };
  const by = writer(patch.updatedBy);
  if (!by) return { ok: false, reason: 'invalid-input', field: 'updatedBy' };
  // Idempotent guard: a capture already disposed of stays exactly as it is. The
  // caller (repository) uses this to recognize "already promoted" on a retry
  // without ever creating a second disposition for one capture.
  if (TERMINAL_STATUSES.has(base.status)) return { ok: false, reason: 'already-disposed', record: base };
  return { ok: true, record: { ...base, status, disposedAt: now, updatedAt: now, updatedBy: by, ...extra } };
}

/** Marks a capture promoted into an existing plan via Plan Authority.
 *  `promotion` is PROVENANCE ONLY (which plan target and item it became) — this
 *  function never touches a plan itself; the caller writes the plan item first
 *  (via Plan Authority) and only then calls this to record that it happened.
 *  @param {{type:'do-today'|'schedule', store:string, targetId:string, planItemId:string}} promotion */
export function promoteCapture(current, { promotion, now, updatedBy } = {}) {
  if (!promotion || !PROMOTION_TYPES.has(promotion.type)) return { ok: false, reason: 'invalid-input', field: 'promotion' };
  if (typeof promotion.store !== 'string' || !promotion.store) return { ok: false, reason: 'invalid-input', field: 'promotion.store' };
  if (typeof promotion.targetId !== 'string' || !promotion.targetId) return { ok: false, reason: 'invalid-input', field: 'promotion.targetId' };
  if (typeof promotion.planItemId !== 'string' || !promotion.planItemId) return { ok: false, reason: 'invalid-input', field: 'promotion.planItemId' };
  return disposeCapture(current, 'promoted', {
    promotion: {
      type: promotion.type,
      store: promotion.store,
      targetId: promotion.targetId,
      planItemId: promotion.planItemId,
      promotedAt: timestamp(now) || now,
    },
  }, { now, updatedBy });
}

/** Marks a capture archived. No plan is touched, nothing is deleted — the record
 *  simply leaves the active Brain Dump list with an explicit, later-inspectable
 *  reason, distinct from "still pending" and from a plan item having been made. */
export function archiveCapture(current, { now, updatedBy } = {}) {
  return disposeCapture(current, 'archived', {}, { now, updatedBy });
}

/** Marks a capture delegated. `delegatedTo` is an optional free-text note (who or
 *  where it was handed off to) — display-only provenance, not a tracked
 *  assignment. See the file banner: this is deliberately NOT a second task store. */
export function delegateCapture(current, { delegatedTo = null, now, updatedBy } = {}) {
  return disposeCapture(current, 'delegated', { delegatedTo: cleanDelegatedTo(delegatedTo) }, { now, updatedBy });
}

/** Validates and canonicalizes a stored/remote record. Returns null for anything
 *  that is not a well-formed capture — a malformed remote payload must never
 *  become a half-valid item on the list. */
export function normalizeCapture(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion !== BRAIN_DUMP_SCHEMA_VERSION) return null;
  if (!validBrainDumpId(value.id)) return null;
  const text = cleanText(value.text);
  if (!text) return null;
  if (!BRAIN_DUMP_STATUSES.has(value.status)) return null;
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const updatedBy = writer(value.updatedBy);
  if (!createdAt || !updatedAt || updatedAt < createdAt || !updatedBy) return null;
  if (value.important !== null && typeof value.important !== 'boolean') return null;
  if (value.urgent !== null && typeof value.urgent !== 'boolean') return null;
  // Triage fields are answered together — one set without the other is malformed.
  if ((value.important === null) !== (value.urgent === null)) return null;
  if (value.triagedAt !== null && !timestamp(value.triagedAt)) return null;
  if ((value.important === null) !== (value.triagedAt === null)) return null;
  if (value.status === 'untriaged' && value.important !== null) return null;

  const terminal = TERMINAL_STATUSES.has(value.status);
  if (terminal && !timestamp(value.disposedAt)) return null;
  if (!terminal && value.disposedAt !== null) return null;

  let promotion = null;
  if (value.status === 'promoted') {
    const p = value.promotion;
    if (!p || !PROMOTION_TYPES.has(p.type) || typeof p.store !== 'string' || !p.store) return null;
    if (typeof p.targetId !== 'string' || !p.targetId) return null;
    if (typeof p.planItemId !== 'string' || !p.planItemId) return null;
    if (!timestamp(p.promotedAt)) return null;
    promotion = { type: p.type, store: p.store, targetId: p.targetId, planItemId: p.planItemId, promotedAt: p.promotedAt };
  } else if (value.promotion !== null && value.promotion !== undefined) return null;

  let delegatedTo = null;
  if (value.status === 'delegated') {
    delegatedTo = cleanDelegatedTo(value.delegatedTo);
  } else if (value.delegatedTo !== null && value.delegatedTo !== undefined) return null;

  return {
    schemaVersion: BRAIN_DUMP_SCHEMA_VERSION,
    id: value.id,
    text,
    createdAt,
    updatedAt,
    updatedBy,
    status: value.status,
    important: value.important === true || value.important === false ? value.important : null,
    urgent: value.urgent === true || value.urgent === false ? value.urgent : null,
    triagedAt: timestamp(value.triagedAt) || null,
    disposedAt: timestamp(value.disposedAt) || null,
    promotion,
    delegatedTo,
  };
}

function compareStrings(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Per-record convergence. The same algorithm every other store in this codebase
 *  uses (plan items, commitments): highest updatedAt wins; an exact tie is broken
 *  by a canonical form of the record, so two devices racing a triage or a
 *  disposition in the same millisecond still agree, with no coordination. A
 *  disposition (promote/archive/delegate) is an ordinary later write by this
 *  rule — it can win or lose a race deterministically, but it can never be
 *  silently undone by a stale peer that simply never mentions it. */
export function mergeCaptureRecords(localValue, remoteValue) {
  const local = normalizeCapture(localValue);
  const remote = normalizeCapture(remoteValue);
  if (!local) return remote;
  if (!remote) return local;
  if (local.updatedAt !== remote.updatedAt) return remote.updatedAt > local.updatedAt ? remote : local;
  return compareStrings(canonical(local), canonical(remote)) >= 0 ? local : remote;
}

/** Merges two whole capture maps, record by record. Never a store-wide replace: a
 *  peer that has never seen a capture must not be able to make it disappear by
 *  simply not mentioning it — absence is not deletion (and V1 has no deletion). */
export function mergeCaptureMaps(localMap, remoteMap) {
  const out = {};
  const ids = new Set([...Object.keys(localMap || {}), ...Object.keys(remoteMap || {})]);
  for (const id of ids) {
    const merged = mergeCaptureRecords((localMap || {})[id], (remoteMap || {})[id]);
    if (merged && merged.id === id) out[id] = merged;
  }
  return out;
}

/** Deterministic ordering: creation time, oldest first, with the id as a stable
 *  tie-breaker. Arrival order from Firebase (or from `records`' own enumeration
 *  order) never decides truth. */
function orderedBy(records, matches) {
  const list = Array.isArray(records) ? records : Object.values(records || {});
  return list
    .map(normalizeCapture)
    .filter(record => record && matches(record))
    .sort((a, b) => a.createdAt - b.createdAt || compareStrings(a.id, b.id));
}

/** Normalized, validated captures in deterministic order, any status. */
export function allCaptures(records) {
  return orderedBy(records, () => true);
}

/** The actionable list: not yet classified. */
export function untriagedCaptures(records) {
  return orderedBy(records, record => record.status === 'untriaged');
}

/** Classified but not yet disposed of — still actionable, with triage visible. */
export function triagedCaptures(records) {
  return orderedBy(records, record => record.status === 'triaged');
}

/** Everything no longer actionable: promoted, archived or delegated. */
export function disposedCaptures(records) {
  return orderedBy(records, record => TERMINAL_STATUSES.has(record.status));
}

/** The Eisenhower quadrant label for a triaged capture — explanatory only. Never
 *  an instruction to act: the owner still explicitly picks Do Today / Schedule /
 *  Archive / Delegate regardless of which quadrant a capture landed in. */
export function quadrantOf(record) {
  const normalized = normalizeCapture(record);
  if (!normalized || normalized.important === null || normalized.urgent === null) return null;
  if (normalized.important && normalized.urgent) return 'do-first';
  if (normalized.important && !normalized.urgent) return 'schedule';
  if (!normalized.important && normalized.urgent) return 'delegate-candidate';
  return 'archive-candidate';
}

const api = {
  BRAIN_DUMP_SCHEMA_VERSION, BRAIN_DUMP_STATUSES, TERMINAL_STATUSES, PROMOTION_TYPES, BRAIN_DUMP_PLAN_ITEM_PREFIX,
  validBrainDumpId, brainDumpPlanItemId, buildCapture, triageCapture, promoteCapture, archiveCapture, delegateCapture,
  normalizeCapture, mergeCaptureRecords, mergeCaptureMaps, allCaptures, untriagedCaptures, triagedCaptures,
  disposedCaptures, quadrantOf,
};
globalThis.BrainDumpModel = api;
export default api;
