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
//   untriaged -> triaged -> [claimed] -> { promoted | archived | delegated }
//
// `promoted` / `archived` / `delegated` are TERMINAL dispositions: once set, the
// record is done being an actionable Brain Dump item. Nothing here ever deletes a
// capture — there is no "delete" action in V1 — so every record that has ever
// existed stays discoverable by its own id, with its full history on it. Absence
// is therefore trivially never deletion: no caller ever drops a key from the map.
//
// ── the promote/archive/delegate arbitration (FIX FIRST) ────────────────────
// Promotion is the only disposition with an external, irreversible side effect (a
// real plan item, via Plan Authority) that this module must never try to undo —
// there is no safe authoritative deletion contract for a plan item. Archive and
// delegate have no side effect at all: they are a status flag, nothing more. That
// asymmetry is why "last write wins" (fine for an ordinary field edit) is UNSAFE
// for terminal dispositions: a later archive could otherwise discard a capture's
// only record that a real plan item already exists, stranding it with no
// provenance (exactly the contradiction this phase closes).
//
// The fix is a one-field claim, written BEFORE the plan write:
//   promotionClaim: { type, store, targetId, planItemId, claimedAt, claimedBy } | null
// A claim is recorded on a non-terminal capture the instant a promotion begins —
// before Plan Authority is ever touched — so the "decide the winner" step happens
// first, and only the winning path's side effect may proceed:
//   - archiveCapture()/delegateCapture() refuse outright (fail closed) whenever a
//     promotionClaim is present, regardless of which arrived "first" by clock time.
//   - a claim, once finalized (promoteCapture()), clears to null; the terminal
//     `promoted` status and its `promotion` provenance are what survive from then on.
// Per-record convergence (mergeCaptureRecords) ranks authority instead of using
// plain recency: promoted (3) > claimed (2) > archived/delegated (1) > active (0).
// A higher rank always wins the merge outright, REGARDLESS of updatedAt — so a
// late-arriving stale archive/delegate can never resurrect over an already-claimed
// or already-promoted truth, and a promotion claim can never be silently discarded
// by a peer that simply raced an archive/delegate against it. Within the same rank,
// the existing LWW + canonical tie-break still applies (two claims: earliest
// claimedAt wins, so only one target is ever authoritative for one capture).
//
// ── FIX FIRST round 2: a BRAND NEW claim must be established against the
// AUTHORITATIVE REMOTE record, not merely written to local cache ──────────────
// The rank rule above protects an ALREADY-ESTABLISHED claim/promotion from a
// stale archive/delegate (there may already be a real plan item to protect).
// It must NOT let a client that still sees TRIAGED locally — because it is
// stale or offline — mint a BRAND NEW claim that outranks a remote archive/
// delegate that has ALREADY become authoritative: nothing has been protected
// yet from THIS claim's point of view (it has created no plan item), so there
// is nothing to weigh by rank. arbitratePromotionClaim() is the gate a NEW
// claim attempt must pass, evaluated against the CURRENT remote value inside a
// real Firebase transaction (brain-dump-sync.js's claimPromotionRemote) BEFORE
// Plan Authority is ever touched — never against local cache alone:
//   - remote already TERMINAL (promoted/archived/delegated): refuse outright,
//     no write at all — the new claim loses unconditionally, regardless of rank.
//   - remote has its OWN outstanding (non-terminal) claim: two claims racing to
//     be established, genuinely concurrent, NEITHER has a side effect yet —
//     falls through to the ordinary rank+tie-break merge (earliest wins).
//   - remote is untriaged/triaged with no claim: safe to establish ours.
// mergeCaptureRecords itself is unchanged and still governs every ORDINARY
// sync merge (archive/delegate's own push, finalize's push, inbound snapshots)
// — those still correctly let an already-won claim/promotion beat a stale
// archive/delegate, exactly as round 1 fixed.
//
// ── edit + reopen on handled items (Production UX Correction V1) ────────────
// Handled is not immutable forever. An ARCHIVED or DELEGATED capture may have
// its text (and, if delegated, delegatedTo) corrected in place: it stays
// handled, and the ordinary same-rank LWW decides between two such edits.
// It may also be explicitly REOPENED back into triage (reopenCapture): status
// returns to triaged (or untriaged if it was never classified), Important/
// Urgent are kept, disposedAt and delegatedTo clear (delegatedTo describes
// the CURRENT disposition, and a reopened capture is no longer delegated).
// A PROMOTED capture is never editable or reopenable here: it has a live plan
// item, and reopening it would allow a second promotion. Its plan item is
// edited through Plan Authority instead.
//
// The rank rule alone would let a stale archived/delegated snapshot (rank 1)
// beat a newer reopened record (rank 0) and silently re-dispose it. So every
// reopen bumps `reopenCount` (absent on older records = 0), and among records
// below claim rank, the HIGHER reopenCount wins outright: a reopen supersedes
// every disposition from before it. Claimed (2) and promoted (3) still beat
// everything regardless of reopenCount, so a reopen can never invalidate a
// promotion claim that is already authoritative remotely. A reopen pushed
// against such a claim simply loses the merge and converges to the promotion.
//
// ── rollout: an old client must never undo a reopen ─────────────────────────
// A client from before reopen existed normalizes reopenCount away and ranks
// archived/delegated above active, so a stale one would push its old
// disposition straight back over a reopen. So a reopen also upgrades that ONE
// record to schemaVersion 2 (BRAIN_DUMP_REOPEN_SCHEMA_VERSION), and the generation
// is monotonic: mergeCaptureRecords keeps the higher of the two, and
// firebase.rules.json refuses any write that lowers a record's schemaVersion.
// An old client cannot normalize a generation-2 record (it ignores it) and
// cannot write over one (the server refuses it). Every record that has never
// been reopened stays generation 1 and fully writable by old clients: the
// upgrade is lazy and per record, never a bulk migration.
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
/** The reopen-aware record generation (see the file banner's rollout section).
 *  BRAIN_DUMP_SCHEMA_VERSION stays the storage-envelope version and the
 *  generation of every record that has never been reopened. */
export const BRAIN_DUMP_REOPEN_SCHEMA_VERSION = 2;
const RECORD_SCHEMA_VERSIONS = new Set([BRAIN_DUMP_SCHEMA_VERSION, BRAIN_DUMP_REOPEN_SCHEMA_VERSION]);

export const BRAIN_DUMP_STATUSES = new Set(['untriaged', 'triaged', 'promoted', 'archived', 'delegated']);
/** Terminal: once a capture reaches one of these, it is no longer an actionable
 *  Brain Dump list item. Archived/delegated may be explicitly reopened
 *  (reopenCapture); promoted never reverts. */
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
      promotionClaim: null,
      promotion: null,
      delegatedTo: null,
      reopenCount: 0,
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

function validPromotion(promotion) {
  if (!promotion || !PROMOTION_TYPES.has(promotion.type)) return false;
  if (typeof promotion.store !== 'string' || !promotion.store) return false;
  if (typeof promotion.targetId !== 'string' || !promotion.targetId) return false;
  if (typeof promotion.planItemId !== 'string' || !promotion.planItemId) return false;
  // Optional, round-3: carried on the CLAIM so a reconciler that never saw the
  // original UI action (a different device, or the same device after a
  // restart) can still build the EXACT intended item — see reconcilePromotionClaim
  // in brain-dump-promotion.js. Absent (do-today is always untimed) or a valid
  // "HH:MM" reading; never required.
  if (promotion.when !== undefined && typeof promotion.when !== 'string') return false;
  if (promotion.durationMinutes !== undefined && promotion.durationMinutes !== null && !(Number.isInteger(promotion.durationMinutes) && promotion.durationMinutes > 0)) return false;
  return true;
}

/** A capture's current arbitration authority. Higher always wins a merge outright
 *  (see mergeCaptureRecords) — this is the ranking, not the tie-break within it. */
function captureAuthorityRank(record) {
  if (record.status === 'promoted') return 3;
  if (record.promotionClaim) return 2;
  if (record.status === 'archived' || record.status === 'delegated') return 1;
  return 0;
}

/** Archive/delegate (no side effect, so a single atomic write is safe). Refuses
 *  outright — fail closed — whenever the capture is already disposed of OR a
 *  promotion claim is outstanding: a promotion that has already started (even if
 *  its plan write has not happened yet) always wins. See the file banner. */
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
  // A promotion claim, even an unfinished one, always wins — see the file banner.
  if (base.promotionClaim) return { ok: false, reason: 'promotion-claimed', record: base };
  return { ok: true, record: { ...base, status, disposedAt: now, updatedAt: now, updatedBy: by, ...extra } };
}

/** PHASE 1 of promotion: records intent BEFORE Plan Authority is ever touched, so
 *  the winner of a promote-vs-archive/delegate race is decided before either
 *  side's effect becomes real. Does not change `status` — the capture stays
 *  `triaged` (still visibly actionable) until finalizePromotion() lands.
 *  Idempotent: re-claiming the SAME (store, targetId, planItemId) — a retry after
 *  a crash, or this device's own repeated attempt — is a no-op success. A
 *  DIFFERENT claim already in progress refuses with 'already-claimed', so only one
 *  target is ever authoritative for one capture (never two independently
 *  authoritative promotion attempts).
 *  @param {{type:'do-today'|'schedule', store:string, targetId:string, planItemId:string}} promotion */
export function claimPromotion(current, { promotion, now, updatedBy } = {}) {
  const base = normalizeCapture(current);
  if (!base) return { ok: false, reason: 'invalid-input', field: 'record' };
  if (!validPromotion(promotion)) return { ok: false, reason: 'invalid-input', field: 'promotion' };
  const at = timestamp(now);
  if (!at) return { ok: false, reason: 'invalid-input', field: 'now' };
  const by = writer(updatedBy);
  if (!by) return { ok: false, reason: 'invalid-input', field: 'updatedBy' };
  if (TERMINAL_STATUSES.has(base.status)) return { ok: false, reason: 'already-disposed', record: base };
  const existing = base.promotionClaim;
  if (existing) {
    const same = samePromotionIntent(existing, promotion);
    if (same) return { ok: true, record: base };
    return { ok: false, reason: 'already-claimed', record: base };
  }
  return {
    ok: true,
    record: {
      ...base,
      promotionClaim: {
        type: promotion.type, store: promotion.store, targetId: promotion.targetId, planItemId: promotion.planItemId,
        when: typeof promotion.when === 'string' ? promotion.when : '',
        durationMinutes: Number.isFinite(promotion.durationMinutes) ? promotion.durationMinutes : null,
        claimedAt: at, claimedBy: by,
      },
      updatedAt: at,
      updatedBy: by,
    },
  };
}

/** PHASE 2 of promotion: finalizes using the capture's OWN recorded claim — never
 *  a freshly-passed promotion object — so finalizing can never diverge from what
 *  was actually claimed (and, by the time this runs, actually created). Idempotent:
 *  an already-promoted capture is reported, never re-finalized. */
export function finalizePromotion(current, { now, updatedBy } = {}) {
  const base = normalizeCapture(current);
  if (!base) return { ok: false, reason: 'invalid-input', field: 'record' };
  const at = timestamp(now);
  if (!at) return { ok: false, reason: 'invalid-input', field: 'now' };
  const by = writer(updatedBy);
  if (!by) return { ok: false, reason: 'invalid-input', field: 'updatedBy' };
  if (TERMINAL_STATUSES.has(base.status)) return { ok: false, reason: 'already-disposed', record: base };
  if (!base.promotionClaim) return { ok: false, reason: 'no-claim', record: base };
  const claim = base.promotionClaim;
  return {
    ok: true,
    record: {
      ...base,
      status: 'promoted',
      // when/durationMinutes persist so the finalized promotion still records
      // the exact intent (see samePromotionIntent).
      promotion: { type: claim.type, store: claim.store, targetId: claim.targetId, planItemId: claim.planItemId, intentRecorded: true, when: claim.when, durationMinutes: claim.durationMinutes, promotedAt: at },
      promotionClaim: null,
      disposedAt: at,
      updatedAt: at,
      updatedBy: by,
    },
  };
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

function intentWhen(value) {
  return typeof value === 'string' ? value : '';
}

function intentDuration(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Two promotion intents (a claim, a finalized promotion, or a caller's fresh
 *  request) are the same only when EVERY field that shapes the resulting plan
 *  item matches: type, store, targetId, planItemId, when and durationMinutes.
 *  The deterministic planItemId alone is not enough. Do Today and an untimed
 *  or 15:00 Schedule on the same day share it, and treating them as one would
 *  silently drop the losing caller's time. */
export function samePromotionIntent(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type || a.store !== b.store || a.targetId !== b.targetId || a.planItemId !== b.planItemId) return false;
  const left = knownTiming(a);
  const right = knownTiming(b);
  // Unknown historical timing is never PROVABLY equal to anything.
  return !!left && !!right && left.when === right.when && left.durationMinutes === right.durationMinutes;
}

/** The provable when/durationMinutes of an intent, or null when it is unknown. A
 *  claim or a caller's request always carries its timing. A promotion finalized
 *  before intentRecorded existed does not, except a Do Today, which every shipped
 *  path builds untimed (no time, no duration), so its timing is provable by
 *  construction. A legacy Schedule's time was never persisted: unknown. */
function knownTiming(intent) {
  if (intent.intentRecorded === false) {
    return intent.type === 'do-today' ? { when: '', durationMinutes: null } : null;
  }
  return { when: intentWhen(intent.when), durationMinutes: intentDuration(intent.durationMinutes) };
}

/** True iff `record` is already promoted with exactly this intent. Lets a
 *  foreground promotion recognize that its OWN claim was finished first (by the
 *  reconciler that observed it), instead of mistaking that for a competing
 *  actor, without ever mistaking a DIFFERENT intent for its own success. */
export function promotedTo(record, intent) {
  return !!record && record.status === 'promoted' && samePromotionIntent(record.promotion, intent);
}

const HANDLED_EDITABLE = new Set(['archived', 'delegated']);

/** Corrects an archived/delegated capture IN PLACE: `text` and (delegated only)
 *  `delegatedTo`. Never changes status — editing a handled item never reopens
 *  it. Promoted captures refuse ('promoted'): their plan item is the thing to
 *  edit, through Plan Authority. Active captures refuse ('not-handled'). */
export function editHandledCapture(current, patch = {}) {
  const base = normalizeCapture(current);
  if (!base) return { ok: false, reason: 'invalid-input', field: 'record' };
  const now = timestamp(patch.now);
  if (!now) return { ok: false, reason: 'invalid-input', field: 'now' };
  const by = writer(patch.updatedBy);
  if (!by) return { ok: false, reason: 'invalid-input', field: 'updatedBy' };
  if (base.status === 'promoted') return { ok: false, reason: 'promoted', record: base };
  if (!HANDLED_EDITABLE.has(base.status)) return { ok: false, reason: 'not-handled', record: base };
  const next = { ...base };
  if (patch.text !== undefined) {
    const text = cleanText(patch.text);
    if (!text) return { ok: false, reason: 'invalid-input', field: 'text' };
    next.text = text;
  }
  if (patch.delegatedTo !== undefined) {
    if (base.status !== 'delegated') return { ok: false, reason: 'invalid-input', field: 'delegatedTo' };
    next.delegatedTo = cleanDelegatedTo(patch.delegatedTo);
  }
  if (next.text === base.text && next.delegatedTo === base.delegatedTo) return { ok: true, record: base, unchanged: true };
  return { ok: true, record: { ...next, updatedAt: now, updatedBy: by } };
}

/** Explicitly returns an archived/delegated capture to the active triage
 *  workflow — same id, Important/Urgent kept. Bumps reopenCount so this reopen
 *  supersedes every earlier archive/delegate in a merge (see the file banner).
 *  Promoted refuses ('promoted'); an already-active capture refuses
 *  ('not-handled') so a double-click never bumps the generation twice. */
export function reopenCapture(current, patch = {}) {
  const base = normalizeCapture(current);
  if (!base) return { ok: false, reason: 'invalid-input', field: 'record' };
  const now = timestamp(patch.now);
  if (!now) return { ok: false, reason: 'invalid-input', field: 'now' };
  const by = writer(patch.updatedBy);
  if (!by) return { ok: false, reason: 'invalid-input', field: 'updatedBy' };
  if (base.status === 'promoted') return { ok: false, reason: 'promoted', record: base };
  if (!HANDLED_EDITABLE.has(base.status)) return { ok: false, reason: 'not-handled', record: base };
  return {
    ok: true,
    record: {
      ...base,
      status: base.important === null ? 'untriaged' : 'triaged',
      disposedAt: null,
      delegatedTo: null,
      reopenCount: base.reopenCount + 1,
      // A reopen is the one write an old client cannot represent: from here on
      // this record is reopen-aware, and the rules refuse any older generation.
      schemaVersion: BRAIN_DUMP_REOPEN_SCHEMA_VERSION,
      updatedAt: now,
      updatedBy: by,
    },
  };
}

/** Firebase RTDB never stores a null: writing `{ disposedAt: null }` REMOVES the
 *  key (at every nesting level), so a record read back from the wire simply lacks
 *  every field that was null. For an optional nullable field, absent therefore
 *  means exactly what null means. Required fields are never read this way. */
function wireNullable(value) {
  return value === undefined ? null : value;
}

/** Validates and canonicalizes a stored/remote record. Returns null for anything
 *  that is not a well-formed capture — a malformed remote payload must never
 *  become a half-valid item on the list.
 *
 *  Accepts both representations of the same record: the local logical object
 *  (explicit nulls, as localStorage keeps them) and its Firebase-pruned wire form
 *  (those keys absent). Optional nullable fields (important, urgent, triagedAt,
 *  disposedAt, promotionClaim, promotion, delegatedTo, and inside a claim
 *  `when`/`durationMinutes`) read absent as null. reopenCount reads absent as 0.
 *  Required fields (schemaVersion, id, text, status, createdAt, updatedAt,
 *  updatedBy, a terminal record's disposedAt, a promoted record's promotion and
 *  every claim/promotion identity field) are still required. A missing capture
 *  NODE is a different thing: callers never pass one here (it is absence, never
 *  a record). */
export function normalizeCapture(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!RECORD_SCHEMA_VERSIONS.has(value.schemaVersion)) return null;
  if (!validBrainDumpId(value.id)) return null;
  const text = cleanText(value.text);
  if (!text) return null;
  if (!BRAIN_DUMP_STATUSES.has(value.status)) return null;
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const updatedBy = writer(value.updatedBy);
  if (!createdAt || !updatedAt || updatedAt < createdAt || !updatedBy) return null;
  const important = wireNullable(value.important);
  const urgent = wireNullable(value.urgent);
  const triagedAt = wireNullable(value.triagedAt);
  const disposedAt = wireNullable(value.disposedAt);
  if (important !== null && typeof important !== 'boolean') return null;
  if (urgent !== null && typeof urgent !== 'boolean') return null;
  // Triage fields are answered together — one set without the other is malformed.
  if ((important === null) !== (urgent === null)) return null;
  if (triagedAt !== null && !timestamp(triagedAt)) return null;
  if ((important === null) !== (triagedAt === null)) return null;
  if (value.status === 'untriaged' && important !== null) return null;

  const terminal = TERMINAL_STATUSES.has(value.status);
  if (terminal && !timestamp(disposedAt)) return null;
  if (!terminal && disposedAt !== null) return null;

  // A promotion claim only ever exists on a non-terminal capture — once finalized
  // (or if ever archived/delegated, which refuses while a claim is outstanding —
  // see disposeCapture), the claim is cleared. A terminal record carrying one is malformed.
  let promotionClaim = null;
  if (value.promotionClaim !== null && value.promotionClaim !== undefined) {
    if (terminal) return null;
    const c = value.promotionClaim;
    if (!validPromotion(c)) return null;
    if (!timestamp(c.claimedAt)) return null;
    const claimedBy = writer(c.claimedBy);
    if (!claimedBy) return null;
    promotionClaim = {
      type: c.type, store: c.store, targetId: c.targetId, planItemId: c.planItemId,
      when: typeof c.when === 'string' ? c.when : '',
      durationMinutes: Number.isFinite(c.durationMinutes) ? c.durationMinutes : null,
      claimedAt: c.claimedAt, claimedBy,
    };
  }

  let promotion = null;
  if (value.status === 'promoted') {
    const p = value.promotion;
    if (!p || !PROMOTION_TYPES.has(p.type) || typeof p.store !== 'string' || !p.store) return null;
    if (typeof p.targetId !== 'string' || !p.targetId) return null;
    if (typeof p.planItemId !== 'string' || !p.planItemId) return null;
    if (!timestamp(p.promotedAt)) return null;
    if (p.when !== undefined && p.when !== null && typeof p.when !== 'string') return null;
    if (p.durationMinutes !== undefined && p.durationMinutes !== null && !(Number.isInteger(p.durationMinutes) && p.durationMinutes > 0)) return null;
    if (p.intentRecorded !== undefined && p.intentRecorded !== null && typeof p.intentRecorded !== 'boolean') return null;
    // A promotion finalized before exact intent was recorded has NO intentRecorded
    // marker: its when/durationMinutes are UNKNOWN (null here), never "untimed".
    // The marker is required because the wire cannot say "no duration" any other
    // way: a null durationMinutes is pruned to absent, same as never recorded.
    const intentRecorded = p.intentRecorded === true;
    promotion = {
      type: p.type, store: p.store, targetId: p.targetId, planItemId: p.planItemId, intentRecorded,
      when: intentRecorded ? intentWhen(p.when) : null,
      durationMinutes: intentRecorded ? intentDuration(p.durationMinutes) : null,
      promotedAt: p.promotedAt,
    };
  } else if (value.promotion !== null && value.promotion !== undefined) return null;

  let delegatedTo = null;
  if (value.status === 'delegated') {
    delegatedTo = cleanDelegatedTo(value.delegatedTo);
  } else if (value.delegatedTo !== null && value.delegatedTo !== undefined) return null;

  // Absent on every record written before reopen existed — those are generation 0.
  let reopenCount = 0;
  if (value.reopenCount !== undefined && value.reopenCount !== null) {
    if (!Number.isInteger(value.reopenCount) || value.reopenCount < 0) return null;
    reopenCount = value.reopenCount;
  }
  // A reopened record is always reopen-aware: a generation-1 record claiming a
  // reopen is malformed (an old client could not have written it).
  if (reopenCount > 0 && value.schemaVersion < BRAIN_DUMP_REOPEN_SCHEMA_VERSION) return null;

  return {
    schemaVersion: value.schemaVersion,
    id: value.id,
    text,
    createdAt,
    updatedAt,
    updatedBy,
    status: value.status,
    important,
    urgent,
    triagedAt: timestamp(triagedAt) || null,
    disposedAt: timestamp(disposedAt) || null,
    promotionClaim,
    promotion,
    delegatedTo,
    reopenCount,
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

/** Per-record convergence. Unlike an ordinary field edit (where highest updatedAt
 *  wins, as everywhere else in this codebase), a terminal disposition is ranked by
 *  AUTHORITY first (captureAuthorityRank: promoted > claimed > archived/delegated >
 *  active) — a higher rank wins the merge outright, regardless of updatedAt. This
 *  is what makes the promote-vs-archive/delegate race deterministic and safe: a
 *  real plan item, once it exists, can never be stranded by a merge that happens to
 *  pick a "later" archive/delegate write instead (see the file banner).
 *  Within the SAME rank, ties are broken deterministically:
 *    - two outstanding claims: the EARLIEST claimedAt wins, so only one target is
 *      ever authoritative for one capture (an exact tie falls through to the
 *      canonical tie-break, same as everywhere else);
 *    - every other same-rank case (two actives, two promoted, two archived/delegated):
 *      highest updatedAt wins, exact tie broken by a canonical form of the record —
 *      the same algorithm plan items and commitments already use, so two devices
 *      racing an ordinary edit in the same millisecond still agree, with no
 *      coordination. Deterministic independent of arrival order either way. */
export function mergeCaptureRecords(localValue, remoteValue) {
  const local = normalizeCapture(localValue);
  const remote = normalizeCapture(remoteValue);
  if (!local) return remote;
  if (!remote) return local;
  const winner = pickCaptureWinner(local, remote);
  // The record generation is monotonic: once either side is reopen-aware, the
  // merged record is too, whichever side won. Otherwise a new client's own
  // claim or edit could carry a generation-1 copy back over a generation-2
  // record (refused by the rules) — see the file banner's rollout section.
  const schemaVersion = Math.max(local.schemaVersion, remote.schemaVersion);
  return winner.schemaVersion === schemaVersion ? winner : { ...winner, schemaVersion };
}

function pickCaptureWinner(local, remote) {
  const localRank = captureAuthorityRank(local);
  const remoteRank = captureAuthorityRank(remote);
  // Below claim rank, a later reopen supersedes any earlier archive/delegate
  // (see the file banner's "edit + reopen" section). Claimed/promoted are never
  // out-voted by reopenCount.
  if (localRank < 2 && remoteRank < 2 && local.reopenCount !== remote.reopenCount) {
    return remote.reopenCount > local.reopenCount ? remote : local;
  }
  if (localRank !== remoteRank) return remoteRank > localRank ? remote : local;
  if (localRank === 2) {
    const a = local.promotionClaim.claimedAt;
    const b = remote.promotionClaim.claimedAt;
    if (a !== b) return a < b ? local : remote;
  } else if (local.updatedAt !== remote.updatedAt) {
    return remote.updatedAt > local.updatedAt ? remote : local;
  }
  return compareStrings(canonical(local), canonical(remote)) >= 0 ? local : remote;
}

/** The gate a BRAND NEW promotion claim must pass against the AUTHORITATIVE
 *  REMOTE record — see the file banner's "FIX FIRST round 2" section. Returns
 *  the record to write, or `undefined` to mean "refuse: write nothing" (the
 *  caller feeds this straight into a Firebase `.transaction()` update
 *  function, where returning `undefined` aborts the transaction with zero
 *  writes — exactly the "no fake authoritative success" contract). */
export function arbitratePromotionClaim(remoteValue, candidate) {
  const remote = normalizeCapture(remoteValue);
  if (remote && TERMINAL_STATUSES.has(remote.status)) return undefined;
  return mergeCaptureRecords(remote, candidate);
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
  BRAIN_DUMP_SCHEMA_VERSION, BRAIN_DUMP_REOPEN_SCHEMA_VERSION, BRAIN_DUMP_STATUSES, TERMINAL_STATUSES, PROMOTION_TYPES, BRAIN_DUMP_PLAN_ITEM_PREFIX,
  validBrainDumpId, brainDumpPlanItemId, buildCapture, triageCapture, claimPromotion, finalizePromotion,
  archiveCapture, delegateCapture, samePromotionIntent, promotedTo, editHandledCapture, reopenCapture, normalizeCapture, mergeCaptureRecords, arbitratePromotionClaim,
  mergeCaptureMaps, allCaptures, untriagedCaptures, triagedCaptures, disposedCaptures, quadrantOf,
};
globalThis.BrainDumpModel = api;
export default api;
