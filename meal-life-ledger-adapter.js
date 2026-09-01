import {
  deriveLifeLedgerKey,
  fingerprintLifeLedgerEvent,
  serializeLifeLedgerFacts,
  upsertLifeLedgerEvent,
  validateLifeLedgerEventDraft
} from './life-ledger-core.js';

export const MEAL_LIFE_LEDGER_ADAPTER_VERSION = 'meal-v1';
export const MEAL_PREPARED_RECORD_KIND = 'meal.cooked_meal';
export const MEAL_CONSUMED_RECORD_KIND = 'meal.consumption';
export const MEAL_DELETION_RECORD_KIND = 'meal.deletions.cookedMeals';

// Neither meal_prepared nor meal_consumed has trustworthy causal correction/version ordering:
// Meal's own sync model is last-write-wins-by-updatedAt across whole-document snapshots, not a
// per-field edit log, so a later snapshot disagreeing with an already-accepted fact is exactly
// as likely to be stale/reordered data as a genuine correction. Both event types therefore use
// the SAME immutable-after-first-acceptance policy workout_completed already established:
// identical canonical facts on retry are an idempotent no-op; changed facts under the same key
// are an explicit conflict, never a silent revision. See `resolveAndUpsert()` below, which
// mirrors importWorkoutBackup()'s existing-store comparison field for field.
//
// Meal's deletions.cookedMeals map (see app.js writeTombstone/recordLocalDeletions) is a real,
// explicit, per-record, guarded (MASS_DELETE_GUARD) deletion signal — genuinely stronger
// evidence than openGym ever supplied for workout_completed. This adapter therefore DOES
// support meal_prepared deletion when a snapshot supplies that map. Restore is still
// unsupported: Meal has no dedicated restore/undo marker, only a generic LWW "newer updatedAt
// beats the tombstone" reconciliation inside the source app itself — not adapter-visible
// explicit restore evidence — so this adapter never sets provenance.sourceOperation =
// 'restore', and life-ledger-core.js's own upsertLifeLedgerEvent() naturally refuses to
// resurrect a tombstoned event without it.
export const MEAL_LIFE_LEDGER_CAPABILITIES = Object.freeze({
  meal_prepared: Object.freeze({
    completion: 'validated-supplied-cooked-meal-record',
    correction: 'immutable-after-first-acceptance; changed-same-id-is-conflict',
    deletion: 'supported-when-source-deletion-map-present',
    restore: 'unsupported-without-explicit-source-evidence'
  }),
  meal_consumed: Object.freeze({
    completion: 'validated-supplied-append-only-consumption-record',
    correction: 'immutable-after-first-acceptance; changed-same-id-is-conflict',
    deletion: 'unsupported-no-source-deletion-path',
    restore: 'unsupported-no-source-deletion-path'
  })
});

const MAX_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 200;
const MAX_PORTIONS = 99; // mirrors Meal app.js's own PORTION_COUNT_MAX cap
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_PREPARATION_KINDS = new Set(['recipe', 'leftovers', 'takeout']);
// Meal's own source only ever proves "this source marked the record deleted" — absence from a
// live collection plus an explicit per-id deletion-map timestamp — never WHY (user intent vs.
// expiry vs. some other disposal path). 'user_delete' would overclaim agency this adapter does
// not have evidence for; 'source_marked_deleted' is the narrowest truthful reason.
const MEAL_TOMBSTONE_REASON = 'source_marked_deleted';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isUnsafeControlChar(code, allowWhitespace) {
  if (code === 0x7f) return true;
  if (code >= 0x20) return false;
  if (allowWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) return false;
  return true;
}

function hasUnsafeControlChars(value, allowWhitespace) {
  for (let i = 0; i < value.length; i++) {
    if (isUnsafeControlChar(value.charCodeAt(i), allowWhitespace)) return true;
  }
  return false;
}

function stableId(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.length > MAX_ID_LENGTH || hasUnsafeControlChars(value, false)) return null;
  return value;
}

// Returns null when `value` is acceptable bounded text, or a short reason string when not.
function textIssue(value, maxLength, allowWhitespace) {
  if (typeof value !== 'string') return 'must_be_string';
  if (!value.trim()) return 'required';
  if (value.length > maxLength) return 'too_long';
  if (hasUnsafeControlChars(value, allowWhitespace)) return 'unsafe_characters';
  return null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positivePortionCount(value) {
  const n = finiteNumber(value);
  if (n == null || !Number.isInteger(n) || n < 1 || n > MAX_PORTIONS) return null;
  return n;
}

function isoInstant(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function validTimezone(value) {
  if (typeof value !== 'string' || !value.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function inactiveTombstone() {
  return { active: false, deletedAt: null, reason: null, provenance: null };
}

function rejection(reason, details = {}) {
  return { ok: false, reason, ...details };
}

// ── Calendar-date validity ────────────────────────────────────────────────────
// Meal's cookedDate is a source-asserted YYYY-MM-DD with NO time-of-day component
// (including deliberately backdated manual leftovers/takeout entries). The Life Ledger
// temporal-precision redesign means this is published as a date-precision fact
// (`payload.preparedDate` / `temporalPrecision: 'date'`), never converted into a
// constructed instant (e.g. local midnight) — that would assert a time-of-day this data
// does not support. Rejects an impossible date (2026-02-30) via a Date.UTC() round-trip,
// not just YYYY-MM-DD shape.
function isValidCalendarDateKey(value) {
  if (typeof value !== 'string' || !DATE_KEY_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Purely derived from two existing, already-durable source fields — never guessed from
// the meal's free-text name (see Meal app.js's own "name is never read" protein rule,
// which this mirrors in spirit).
function sourcePreparationKind(meal) {
  if (meal.recipeId != null) return 'recipe';
  if (meal.source === 'leftovers' || meal.source === 'takeout') return meal.source;
  return null;
}

// ── meal_prepared ──────────────────────────────────────────────────────────

export function normalizeMealPrepared(meal, context = {}) {
  if (!isPlainObject(meal)) return rejection('cooked_meal_must_be_object');
  const sourceEntityId = stableId(meal.id);
  if (!sourceEntityId) return rejection('missing_source_entity_id');
  const nameIssue = textIssue(meal.name, MAX_NAME_LENGTH, true);
  if (nameIssue) {
    return rejection(nameIssue === 'required' ? 'missing_meal_name' : 'invalid_meal_name', { sourceEntityId });
  }
  if (!validTimezone(context.assertedTimezone)) {
    return rejection('invalid_timezone_assertion', { sourceEntityId });
  }
  const observedAt = isoInstant(context.observedAt);
  if (!observedAt) return rejection('invalid_observed_at', { sourceEntityId });

  if (!isValidCalendarDateKey(meal.cookedDate)) return rejection('invalid_cooked_date', { sourceEntityId });
  const preparedDate = meal.cookedDate;

  let portionsPrepared = null;
  if (meal.initialPortions != null) {
    portionsPrepared = positivePortionCount(meal.initialPortions);
    if (portionsPrepared == null) return rejection('invalid_initial_portions', { sourceEntityId });
  }

  let recipeId = null;
  if (meal.recipeId != null) {
    recipeId = stableId(meal.recipeId);
    if (!recipeId) return rejection('invalid_recipe_id', { sourceEntityId });
  }

  const preparationKind = sourcePreparationKind(meal);
  if (meal.source != null && !VALID_PREPARATION_KINDS.has(preparationKind)) {
    // meal.source carries an unrecognized value — do not silently coerce it away.
    return rejection('unrecognized_preparation_source', { sourceEntityId });
  }

  // `storage` (fridge/freezer) is deliberately NOT published: it is Meal's CURRENT, mutable
  // location for the batch, not a fact this preparation event proves — see
  // MEAL_PREPARED_SOURCE_ALLOWED_KEYS in life-ledger-core.js.
  const source = {
    cookedMealId: sourceEntityId,
    localDate: preparedDate,
    preparedDateBasis: 'source-local-date'
  };
  if (recipeId) source.recipeId = recipeId;
  if (preparationKind) source.preparationKind = preparationKind;

  const payload = { mealName: meal.name.trim(), preparedDate, source };
  if (portionsPrepared != null) payload.portionsPrepared = portionsPrepared;

  const provenance = {
    source: 'meal',
    sourceRecordKind: MEAL_PREPARED_RECORD_KIND,
    adapterVersion: MEAL_LIFE_LEDGER_ADAPTER_VERSION,
    observedAt,
    captureMethod: 'meal_app',
    evidence: [`meal.snapshot:cookedMeals/${sourceEntityId}`]
  };

  const draft = {
    schemaVersion: 1,
    sourceApp: 'meal',
    sourceEntityId,
    type: 'meal_prepared',
    // Date-precision fact: cookedDate proves a real calendar day, never a time-of-day, so
    // there is deliberately no occurredAt here — see the temporal-precision invariant.
    temporalPrecision: 'date',
    occurredDate: preparedDate,
    sourceTimezone: context.assertedTimezone,
    payload,
    provenance,
    confidence: { score: 0.85, basis: 'source-local-date-only-no-time-of-day-evidence' },
    tombstone: inactiveTombstone()
  };
  const validation = validateLifeLedgerEventDraft(draft);
  return validation.ok
    ? { ok: true, draft }
    : rejection('invalid_life_ledger_draft', { sourceEntityId, errors: validation.errors });
}

// ── meal_consumed ──────────────────────────────────────────────────────────

export function normalizeMealConsumed(record, context = {}) {
  if (!isPlainObject(record)) return rejection('consumption_record_must_be_object');
  const sourceEntityId = stableId(record.id);
  if (!sourceEntityId) return rejection('missing_source_entity_id');
  const nameIssue = textIssue(record.mealName, MAX_NAME_LENGTH, true);
  if (nameIssue) {
    return rejection(nameIssue === 'required' ? 'missing_meal_name' : 'invalid_meal_name', { sourceEntityId });
  }
  if (!validTimezone(context.assertedTimezone)) {
    return rejection('invalid_timezone_assertion', { sourceEntityId });
  }
  const observedAt = isoInstant(context.observedAt);
  if (!observedAt) return rejection('invalid_observed_at', { sourceEntityId });

  const consumedAt = isoInstant(record.consumedAt);
  if (!consumedAt) return rejection('invalid_consumed_at', { sourceEntityId });

  const portionCount = positivePortionCount(record.portionsConsumed);
  if (portionCount == null) return rejection('invalid_portions_consumed', { sourceEntityId });

  // Required: every real mealConsumption record durably captures cookedMealId (see Meal
  // app.js's recordMealConsumption(), which always sets it) — there is no trustworthy legacy
  // exception, so a record missing it is rejected rather than published without the linkage.
  const cookedMealId = stableId(record.cookedMealId);
  if (!cookedMealId) return rejection('missing_cooked_meal_id', { sourceEntityId });
  let recipeId = null;
  if (record.recipeId != null) {
    recipeId = stableId(record.recipeId);
    if (!recipeId) return rejection('invalid_recipe_id', { sourceEntityId });
  }

  const source = { consumptionId: sourceEntityId };
  if (recipeId) source.recipeId = recipeId;

  const payload = { mealName: record.mealName.trim(), consumedAt, portionCount, cookedMealId, source };

  const provenance = {
    source: 'meal',
    sourceRecordKind: MEAL_CONSUMED_RECORD_KIND,
    adapterVersion: MEAL_LIFE_LEDGER_ADAPTER_VERSION,
    observedAt,
    captureMethod: 'meal_app',
    evidence: [`meal.snapshot:mealConsumptions/${sourceEntityId}`]
  };

  const draft = {
    schemaVersion: 1,
    sourceApp: 'meal',
    sourceEntityId,
    type: 'meal_consumed',
    occurredAt: consumedAt,
    sourceTimezone: context.assertedTimezone,
    payload,
    provenance,
    // consumedAt is captured live by the source app at the moment of the "Used 1" tap —
    // a directly source-recorded fact, not derived.
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: inactiveTombstone()
  };
  const validation = validateLifeLedgerEventDraft(draft);
  return validation.ok
    ? { ok: true, draft }
    : rejection('invalid_life_ledger_draft', { sourceEntityId, errors: validation.errors });
}

// ── Shared batch normalization ────────────────────────────────────────────────
// One classification per physical input record (index): 'invalid' (failed
// normalization), 'conflict' (same key, differing facts, within this batch),
// 'duplicate' (exact repeat of an already-accepted row), or 'accepted' (the batch's
// canonical draft for its key). Mirrors normalizeWorkoutBackup()'s per-index outcome
// accounting exactly, generalized over the normalize function so meal_prepared and
// meal_consumed share one implementation instead of two near-identical copies.
function normalizeMealRecords(records, normalizeFn, context) {
  const groups = new Map();
  const rejected = [];
  const outcomeByIndex = new Map();

  records.forEach((record, index) => {
    const result = normalizeFn(record, context);
    if (!result.ok) {
      rejected.push({ index, ...result });
      outcomeByIndex.set(index, { index, status: 'invalid', reason: result.reason });
      return;
    }
    const key = deriveLifeLedgerKey(result.draft);
    // Group on canonical factual serialization, not the fingerprint: a 32-bit FNV-1a
    // fingerprint can collide for genuinely different canonical facts (see the
    // identical caution in workout-life-ledger-adapter.js), so two physically
    // different same-key records in one batch must never be mistaken for exact
    // duplicates merely because their fingerprints happened to match.
    const canonicalFacts = serializeLifeLedgerFacts(result.draft);
    const group = groups.get(key) || { key, canonicalFactsSeen: new Set(), drafts: [], indexes: [] };
    group.canonicalFactsSeen.add(canonicalFacts);
    group.drafts.push(result.draft);
    group.indexes.push(index);
    groups.set(key, group);
  });

  const drafts = [];
  [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).forEach(group => {
    if (group.canonicalFactsSeen.size > 1) {
      rejected.push({
        reason: 'conflicting_duplicate_source_id',
        sourceEntityId: group.drafts[0].sourceEntityId,
        indexes: group.indexes
      });
      group.indexes.forEach(index => {
        outcomeByIndex.set(index, { index, status: 'conflict', reason: 'conflicting_duplicate_source_id', key: group.key });
      });
      return;
    }
    drafts.push(group.drafts[0]);
    group.indexes.forEach((index, position) => {
      outcomeByIndex.set(index, position === 0
        ? { index, status: 'accepted', key: group.key }
        : { index, status: 'duplicate', key: group.key, duplicateOfIndex: group.indexes[0] });
    });
  });
  rejected.sort((a, b) => (a.index ?? a.indexes?.[0] ?? 0) - (b.index ?? b.indexes?.[0] ?? 0));
  const outcomes = records.map((_, index) => outcomeByIndex.get(index));
  return { drafts, rejected, outcomes, fatal: false };
}

// ── Snapshot-level normalization ──────────────────────────────────────────────
// `snapshot` is whatever Meal's exportData()/buildFirestorePayload() already produce
// (see feat/durable-meal-consumption-events) — only `.cookedMeals`, `.mealConsumptions`,
// and `.deletions.cookedMeals` are ever read; pantry/recipes/groceryList/etc. are
// ignored entirely, exactly as normalizeWorkoutBackup() only ever reads
// `backup.workouts` from a full openGym backup.
export function normalizeMealSnapshot(snapshot, context = {}) {
  if (!isPlainObject(snapshot)) return { fatal: true, reason: 'snapshot_must_be_object' };
  if (!Array.isArray(snapshot.cookedMeals)) return { fatal: true, reason: 'snapshot_cookedMeals_must_be_array' };
  const mealConsumptions = snapshot.mealConsumptions == null ? [] : snapshot.mealConsumptions;
  if (!Array.isArray(mealConsumptions)) return { fatal: true, reason: 'snapshot_mealConsumptions_must_be_array' };
  if (typeof context.observationClock !== 'function') return { fatal: true, reason: 'missing_observation_clock' };
  if (!validTimezone(context.assertedTimezone)) return { fatal: true, reason: 'invalid_timezone_assertion' };

  let observedAt;
  try {
    observedAt = isoInstant(context.observationClock());
  } catch {
    observedAt = null;
  }
  if (!observedAt) return { fatal: true, reason: 'invalid_observation_clock' };

  const recordContext = { assertedTimezone: context.assertedTimezone, observedAt };
  const mealPrepared = normalizeMealRecords(snapshot.cookedMeals, normalizeMealPrepared, recordContext);
  const mealConsumed = normalizeMealRecords(mealConsumptions, normalizeMealConsumed, recordContext);

  // Deletion evidence: an id explicitly marked in deletions.cookedMeals AND absent from
  // the current cookedMeals[] snapshot. Presence in deletions.cookedMeals ALONE is not
  // enough (Meal's own applyTombstones() may have already reconciled a newer local edit
  // as live again — see MEAL_LIFE_LEDGER_CAPABILITIES.restore); absence ALONE is never
  // enough either (see the Life Ledger contract's explicit-deletion-signal rule). Both
  // together is the same double-confirmation this contract already requires elsewhere.
  const deletionMap = isPlainObject(snapshot.deletions) && isPlainObject(snapshot.deletions.cookedMeals)
    ? snapshot.deletions.cookedMeals
    : null;
  const livePreparedIds = new Set(mealPrepared.drafts.map(draft => draft.sourceEntityId));
  const tombstoneCandidates = [];
  if (deletionMap) {
    Object.keys(deletionMap).forEach(id => {
      if (livePreparedIds.has(id)) return;
      const deletedAt = isoInstant(deletionMap[id]);
      if (!deletedAt) return; // malformed tombstone timestamp — no usable evidence
      tombstoneCandidates.push({ sourceEntityId: id, deletedAt });
    });
  }

  return {
    fatal: false,
    observedAt,
    mealPrepared,
    mealConsumed,
    tombstoneCandidates
  };
}

function buildMealPreparedTombstoneDraft(existingEvent, deletedAt, observedAt) {
  return {
    schemaVersion: existingEvent.schemaVersion,
    sourceApp: existingEvent.sourceApp,
    sourceEntityId: existingEvent.sourceEntityId,
    type: existingEvent.type,
    // meal_prepared is date-precision (see normalizeMealPrepared): occurredAt stays null/absent
    // and occurredDate/temporalPrecision must carry over unchanged — a tombstone flips ONLY the
    // tombstone lifecycle field, never the underlying preparation facts it describes.
    temporalPrecision: existingEvent.temporalPrecision,
    occurredDate: existingEvent.occurredDate,
    sourceTimezone: existingEvent.sourceTimezone,
    payload: existingEvent.payload,
    provenance: {
      ...existingEvent.provenance,
      adapterVersion: MEAL_LIFE_LEDGER_ADAPTER_VERSION,
      observedAt,
      sourceOperation: 'delete',
      evidence: [`meal.snapshot:deletions.cookedMeals/${existingEvent.sourceEntityId}`]
    },
    confidence: existingEvent.confidence,
    tombstone: {
      active: true,
      deletedAt,
      // Meal's source only proves "this source marked the record deleted", never WHY — see
      // MEAL_TOMBSTONE_REASON.
      reason: MEAL_TOMBSTONE_REASON,
      provenance: {
        sourceOperation: 'delete',
        sourceRecordKind: MEAL_DELETION_RECORD_KIND,
        evidence: [`meal.snapshot:deletions.cookedMeals/${existingEvent.sourceEntityId}`]
      }
    }
  };
}

// ── Import ─────────────────────────────────────────────────────────────────
export function importMealSnapshot(snapshot, options = {}) {
  const store = options.store;
  if (!store || typeof store.getByKey !== 'function') {
    throw new Error('A Life Ledger store with getByKey() is required');
  }
  const upsert = typeof store.upsertEvent === 'function'
    ? (draft => store.upsertEvent(draft, options.ledgerOptions || {}))
    : (typeof store.put === 'function'
      ? (draft => upsertLifeLedgerEvent(store, draft, options.ledgerOptions || {}))
      : null);
  if (!upsert) throw new Error('A Life Ledger store with upsertEvent() or put() is required');

  const normalized = normalizeMealSnapshot(snapshot, options);
  if (normalized.fatal) {
    return {
      status: 'rejected',
      mealPrepared: { actions: [], rejected: [{ reason: normalized.reason }], conflicts: [], outcomes: [] },
      mealConsumed: { actions: [], rejected: [{ reason: normalized.reason }], conflicts: [], outcomes: [] },
      tombstones: { actions: [], skipped: [] }
    };
  }

  function resolveAndUpsert(batch) {
    const outcomes = batch.outcomes.map(outcome => ({ ...outcome }));
    const acceptedOutcomeByKey = new Map(
      outcomes.filter(outcome => outcome.status === 'accepted').map(outcome => [outcome.key, outcome])
    );
    // Same immutable-after-first-acceptance policy as importWorkoutBackup(): before ever
    // calling upsert() (which would otherwise apply life-ledger-core.js's GENERIC "changed
    // fingerprint → new revision" rule), compare the incoming draft's actual canonical
    // factual serialization against whatever is already stored for this key. A 32-bit
    // FNV-1a fingerprint CAN collide for genuinely different canonical facts, so fingerprint
    // equality is never treated as sufficient proof of sameness here — only a direct
    // canonical-facts comparison is. Identical facts on retry are an idempotent no-op
    // (upsert() reports 'unchanged' on its own); different facts under the same key are
    // rejected as an explicit conflict and upsert() is never called, so the existing stored
    // fact is never revised, restored, or otherwise disturbed.
    const conflicts = [];
    const accepted = [];
    batch.drafts.forEach(draft => {
      const key = deriveLifeLedgerKey(draft);
      const existing = store.getByKey(key);
      // Only meal_prepared can ever be tombstoned by this adapter (see
      // MEAL_LIFE_LEDGER_CAPABILITIES). An already-tombstoned existing record reappearing
      // live is NOT a content conflict — it is the restore question, which
      // upsertLifeLedgerEvent() itself already answers correctly (rejects without explicit
      // restore evidence). Only compare canonical facts when the existing record is still
      // live, so that path is never pre-empted here.
      const existingIsTombstoned = existing && existing.event.tombstone && existing.event.tombstone.active === true;
      if (existing && !existingIsTombstoned) {
        const sameFacts = serializeLifeLedgerFacts(existing.event) === serializeLifeLedgerFacts(draft);
        if (!sameFacts) {
          conflicts.push({
            reason: 'immutable_meal_conflict',
            key,
            sourceEntityId: draft.sourceEntityId,
            acceptedFingerprint: existing.fingerprint,
            incomingFingerprint: fingerprintLifeLedgerEvent(draft)
          });
          const outcome = acceptedOutcomeByKey.get(key);
          if (outcome) { outcome.status = 'conflict'; outcome.reason = 'immutable_meal_conflict'; }
          return;
        }
      }
      accepted.push({ draft, key });
    });

    const actions = accepted.map(({ draft, key }) => {
      const action = upsert(draft);
      if (action.action === 'rejected') {
        const outcome = acceptedOutcomeByKey.get(key);
        if (outcome) { outcome.status = 'failed'; outcome.reason = action.reason; }
      }
      return action;
    });
    return { actions, conflicts, outcomes };
  }

  const preparedResult = resolveAndUpsert(normalized.mealPrepared);
  const consumedResult = resolveAndUpsert(normalized.mealConsumed);

  const tombstoneActions = [];
  const tombstoneSkipped = [];
  normalized.tombstoneCandidates.forEach(candidate => {
    const key = `meal:${candidate.sourceEntityId}:meal_prepared`;
    const existing = store.getByKey(key);
    if (!existing) {
      tombstoneSkipped.push({ sourceEntityId: candidate.sourceEntityId, reason: 'tombstone_without_prior_known_record' });
      return;
    }
    if (existing.event.tombstone && existing.event.tombstone.active === true) {
      return; // already tombstoned — idempotent no-op, nothing new to report
    }
    const draft = buildMealPreparedTombstoneDraft(existing.event, candidate.deletedAt, normalized.observedAt);
    const draftValidation = validateLifeLedgerEventDraft(draft);
    if (!draftValidation.ok) {
      tombstoneSkipped.push({ sourceEntityId: candidate.sourceEntityId, reason: 'invalid_tombstone_draft', errors: draftValidation.errors });
      return;
    }
    tombstoneActions.push(upsert(draft));
  });

  const hasIssues =
    normalized.mealPrepared.rejected.length > 0 ||
    normalized.mealConsumed.rejected.length > 0 ||
    preparedResult.conflicts.length > 0 ||
    consumedResult.conflicts.length > 0 ||
    preparedResult.actions.some(a => a.action === 'rejected') ||
    consumedResult.actions.some(a => a.action === 'rejected') ||
    tombstoneSkipped.length > 0 ||
    tombstoneActions.some(a => a.action === 'rejected');

  return {
    status: hasIssues ? 'partial' : 'ok',
    mealPrepared: {
      actions: preparedResult.actions,
      rejected: normalized.mealPrepared.rejected,
      conflicts: preparedResult.conflicts,
      outcomes: preparedResult.outcomes
    },
    mealConsumed: {
      actions: consumedResult.actions,
      rejected: normalized.mealConsumed.rejected,
      conflicts: consumedResult.conflicts,
      outcomes: consumedResult.outcomes
    },
    tombstones: {
      actions: tombstoneActions,
      skipped: tombstoneSkipped
    }
  };
}
