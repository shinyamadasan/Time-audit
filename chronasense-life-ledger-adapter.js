import {
  deriveLifeLedgerKey,
  fingerprintLifeLedgerEvent,
  validateLifeLedgerEventDraft
} from './life-ledger-core.js';

export const CHRONASENSE_ADAPTER_VERSION = 'chronasense-v1';
export const CHRONASENSE_SOURCE_APP = 'chronasense';
export const CHRONASENSE_ENTRY_KIND = 'chronasense.entry';

const VALID_DELETION_REASONS = new Set([
  'user_delete',
  'bulk_clear',
  'merge_replaced',
  'data_doctor_repair'
]);

const AWAY_BUCKETS = {
  Sleep: 'recovery',
  Eat: 'recovery',
  Lunch: 'recovery',
  Dinner: 'recovery',
  Breakfast: 'recovery',
  Rest: 'recovery',
  Nap: 'recovery',
  Grooming: 'recovery',
  Shower: 'recovery',
  Cooking: 'recovery',
  Walk: 'exercise',
  Exercise: 'exercise',
  Gym: 'exercise',
  Run: 'exercise',
  Yoga: 'exercise',
  Commute: 'errands',
  Shopping: 'errands',
  Errand: 'errands',
  Appointment: 'errands',
  Personal: 'social',
  Family: 'social',
  Friends: 'social'
};

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function ok(draft) {
  return { ok: true, draft };
}

function rejected(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function normalizeIsoInstant(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function isIanaTimezone(value) {
  if (typeof value !== 'string' || !value.trim() || !value.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function sourceEntityIdFor(entry) {
  if (!entry || !hasOwn(entry, 'id')) return null;
  if (entry.id == null) return null;
  if (typeof entry.id === 'number' && !Number.isFinite(entry.id)) return null;
  const id = String(entry.id);
  return id.trim() ? id : null;
}

function normalizeEvidenceList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(items.map(item => String(item).trim()).filter(Boolean))].sort();
}

function sourceReferenceFor(sourceEntityId) {
  return [`chronasense.entry:${sourceEntityId}`];
}

function sourceOriginFor(entry, context) {
  return context.sourceOrigin || (entry.source === 'browser-extension' ? 'browser-extension' : null);
}

function sourcePathFor(sourceEntityId, origin, context) {
  if (typeof context.sourcePath === 'string' && context.sourcePath.trim()) {
    return context.sourcePath.trim();
  }
  if (origin === 'browser-extension') return `entries/${sourceEntityId}`;
  return null;
}

function physicalSourceEvidenceFor(sourceEntityId, entry, context) {
  const explicitEvidence = normalizeEvidenceList(context.sourceEvidence);
  if (explicitEvidence.length) return explicitEvidence;
  const origin = sourceOriginFor(entry, context);
  const path = sourcePathFor(sourceEntityId, origin, context);
  return path ? [path] : [];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeOperationalProvenance(items) {
  const sorted = items.slice().sort((a, b) => {
    const aText = JSON.stringify(a.draft);
    const bText = JSON.stringify(b.draft);
    return aText.localeCompare(bText) || a.index - b.index;
  });
  const draft = cloneJson(sorted[0].draft);
  const sourceEvidence = normalizeEvidenceList(items.flatMap(item => item.draft.provenance.sourceEvidence || []));
  const sourcePaths = normalizeEvidenceList(items.map(item => item.draft.provenance.sourcePath).filter(Boolean));
  const sourceOrigins = normalizeEvidenceList(items.map(item => item.draft.provenance.sourceOrigin).filter(Boolean));

  if (sourceEvidence.length) draft.provenance.sourceEvidence = sourceEvidence;
  else delete draft.provenance.sourceEvidence;

  delete draft.provenance.sourcePath;
  delete draft.provenance.sourcePaths;
  if (sourcePaths.length === 1) draft.provenance.sourcePath = sourcePaths[0];
  else if (sourcePaths.length > 1) draft.provenance.sourcePaths = sourcePaths;

  delete draft.provenance.sourceOrigin;
  delete draft.provenance.sourceOrigins;
  if (sourceOrigins.length === 1) draft.provenance.sourceOrigin = sourceOrigins[0];
  else if (sourceOrigins.length > 1) draft.provenance.sourceOrigins = sourceOrigins;

  const tombstoneEvidence = normalizeEvidenceList(
    items.flatMap(item => item.draft.tombstone?.provenance?.sourceEvidence || [])
  );
  if (draft.tombstone?.provenance) {
    if (tombstoneEvidence.length) draft.tombstone.provenance.sourceEvidence = tombstoneEvidence;
    else delete draft.tombstone.provenance.sourceEvidence;
  }

  return draft;
}

function durationMinutesFromInterval(startMs, endMs) {
  const duration = Math.round((endMs - startMs) / 60000);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function intervalFor(entry) {
  const endMs = Number(entry && entry.ts);
  if (!Number.isFinite(endMs) || endMs <= 0) return null;

  if (entry.tsStart != null) {
    const explicitStartMs = Number(entry.tsStart);
    if (Number.isFinite(explicitStartMs) && explicitStartMs > 0 && endMs > explicitStartMs) {
      const durationMinutes = durationMinutesFromInterval(explicitStartMs, endMs);
      return durationMinutes ? { startMs: explicitStartMs, endMs, durationMinutes } : null;
    }
    return null;
  }

  const storedDuration = Number(entry.blockIntervalMin);
  if (Number.isFinite(storedDuration) && storedDuration > 0) {
    const startMs = endMs - Math.round(storedDuration) * 60000;
    if (startMs > 0 && endMs > startMs) {
      return { startMs, endMs, durationMinutes: Math.round(storedDuration) };
    }
  }

  return null;
}

function bucketForChronaSenseEntry(entry) {
  switch (entry.energy) {
    case 'nine5': return 'nine5';
    case 'deep': return 'deep_work';
    case 'shallow': return 'shallow_work';
    case 'errands': return 'errands';
    case 'learning': return 'learning';
    case 'exercise': return 'exercise';
    case 'social': return 'social';
    case 'recovery': return 'recovery';
    case 'waste': return 'waste';
    case 'admin': return 'nine5';
    case 'distraction': return 'waste';
    case 'break': return 'recovery';
    case 'away': return AWAY_BUCKETS[entry.activity] || 'recovery';
    default: return null;
  }
}

function categoryFor(entry) {
  if (typeof entry.category === 'string' && entry.category.trim()) return entry.category.trim();
  return bucketForChronaSenseEntry(entry);
}

function captureMethodFor(entry) {
  if (entry.browserUsage || entry.source === 'browser-extension') return 'browser_usage';
  if (entry.phoneUsage) return 'phone_usage';
  if (entry.scheduledAutoLog) return 'scheduled_template';
  if (entry.walletReward) return 'reward_log';
  if (entry.retro) return 'retro_log';
  if (entry.quickLogged) return 'quick_log';
  return 'timer';
}

function deletionReasonFor(entry, context) {
  const reason = entry.deletionReason || entry.deleteReason || context.deletionReason || null;
  return VALID_DELETION_REASONS.has(reason) ? reason : null;
}

function sourceOperationForDeletionReason(reason) {
  if (reason === 'merge_replaced') return 'merge';
  if (reason === 'data_doctor_repair') return 'repair';
  return 'delete';
}

function buildPayload(entry, interval, category, captureMethod) {
  const payload = {
    activity: String(entry.activity).trim(),
    category,
    startedAt: normalizeIsoInstant(interval.startMs),
    endedAt: normalizeIsoInstant(interval.endMs),
    durationMinutes: interval.durationMinutes
  };

  if (typeof entry.energy === 'string' && entry.energy.trim()) payload.energy = entry.energy.trim();
  if (typeof entry.onPlan === 'boolean') payload.onPlan = entry.onPlan;
  if (typeof entry.project === 'string' && entry.project.trim()) payload.project = entry.project.trim();
  if (typeof entry.note === 'string' && entry.note.trim()) payload.note = entry.note.trim();
  payload.captureMethod = captureMethod;

  return payload;
}

function buildTombstone(entry, sourceEntityId, sourceRef, sourceEvidence, context) {
  if (!entry.deleted) {
    return ok({ active: false, deletedAt: null, reason: null, provenance: null });
  }

  const deletedAt = normalizeIsoInstant(entry.updatedAt);
  if (!deletedAt) return rejected('invalid_deletion_evidence', { sourceEntityId });
  const reason = deletionReasonFor(entry, context);
  if (!reason) return rejected('ambiguous_deletion_evidence', { sourceEntityId });

  return ok({
    active: true,
    deletedAt,
    reason,
    provenance: {
      sourceOperation: sourceOperationForDeletionReason(reason),
      sourceRecordKind: CHRONASENSE_ENTRY_KIND,
      evidence: sourceRef,
      marker: 'deleted:true',
      ...(sourceEvidence.length ? { sourceEvidence } : {})
    }
  });
}

export function normalizeChronaSenseEntry(entry, context = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return rejected('entry_must_be_object');
  }
  if (entry.missed || entry.template || entry.isGap) {
    return rejected('unsupported_chronasense_record', { sourceEntityId: sourceEntityIdFor(entry) });
  }

  const sourceEntityId = sourceEntityIdFor(entry);
  if (!sourceEntityId) return rejected('missing_source_id');

  const sourceTimezone = context.sourceTimezone || context.timezone;
  if (!isIanaTimezone(sourceTimezone)) {
    return rejected('missing_source_timezone', { sourceEntityId });
  }

  const observedAt = normalizeIsoInstant(
    typeof context.clock === 'function' ? context.clock() : context.observedAt
  );
  if (!observedAt) return rejected('missing_observed_at', { sourceEntityId });

  if (!entry.activity || typeof entry.activity !== 'string' || !entry.activity.trim()) {
    return rejected('missing_activity', { sourceEntityId });
  }

  const interval = intervalFor(entry);
  if (!interval) return rejected('invalid_interval', { sourceEntityId });

  const category = categoryFor(entry);
  if (!category) return rejected('missing_category', { sourceEntityId });

  const sourceRef = sourceReferenceFor(sourceEntityId);
  const sourceEvidence = physicalSourceEvidenceFor(sourceEntityId, entry, context);
  const sourceOrigin = sourceOriginFor(entry, context);
  const sourcePath = sourcePathFor(sourceEntityId, sourceOrigin, context);
  const tombstoneResult = buildTombstone(entry, sourceEntityId, sourceRef, sourceEvidence, context);
  if (!tombstoneResult.ok) return tombstoneResult;
  const tombstone = tombstoneResult.draft;

  const captureMethod = captureMethodFor(entry);
  const sourceOperation = tombstone.active ? tombstone.provenance.sourceOperation : null;
  const draft = {
    schemaVersion: 1,
    sourceApp: CHRONASENSE_SOURCE_APP,
    sourceEntityId,
    type: 'activity_logged',
    occurredAt: normalizeIsoInstant(interval.endMs),
    sourceTimezone,
    payload: buildPayload(entry, interval, category, captureMethod),
    provenance: {
      source: CHRONASENSE_SOURCE_APP,
      sourceRecordKind: CHRONASENSE_ENTRY_KIND,
      adapterVersion: CHRONASENSE_ADAPTER_VERSION,
      observedAt,
      captureMethod,
      evidence: sourceRef,
      ...(sourceEvidence.length ? { sourceEvidence } : {}),
      ...(sourceOrigin ? { sourceOrigin } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(sourceOperation ? { sourceOperation } : {})
    },
    confidence: {
      score: 1,
      basis: 'source-recorded'
    },
    tombstone
  };

  const validation = validateLifeLedgerEventDraft(draft);
  if (!validation.ok) {
    return rejected('invalid_life_ledger_draft', { sourceEntityId, errors: validation.errors });
  }

  return ok(draft);
}

export function normalizeChronaSenseEntries(entries, context = {}) {
  if (!Array.isArray(entries)) {
    return { drafts: [], rejected: [rejected('entries_must_be_array')] };
  }

  const drafts = [];
  const rejectedEntries = [];
  entries.forEach((entry, index) => {
    const result = normalizeChronaSenseEntry(entry, context);
    if (result.ok) drafts.push({ draft: result.draft, index });
    else rejectedEntries.push({ ...result, index });
  });

  const groups = new Map();
  drafts.forEach(item => {
    const key = deriveLifeLedgerKey(item.draft);
    const fingerprint = fingerprintLifeLedgerEvent(item.draft);
    const group = groups.get(key) || { key, fingerprints: new Map(), items: [] };
    if (!group.fingerprints.has(fingerprint)) group.fingerprints.set(fingerprint, item.draft);
    group.items.push({ ...item, fingerprint });
    groups.set(key, group);
  });

  const collapsedDrafts = [];
  [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).forEach(group => {
    if (group.fingerprints.size === 1) {
      collapsedDrafts.push(mergeOperationalProvenance(group.items));
      return;
    }
    rejectedEntries.push({
      ok: false,
      reason: 'conflicting_duplicate_physical_input',
      key: group.key,
      count: group.items.length,
      indexes: group.items.map(item => item.index).sort((a, b) => a - b)
    });
  });

  rejectedEntries.sort((a, b) => {
    const aKey = a.key || `${a.index ?? -1}:${a.reason}`;
    const bKey = b.key || `${b.index ?? -1}:${b.reason}`;
    return aKey.localeCompare(bKey);
  });

  return { drafts: collapsedDrafts, rejected: rejectedEntries };
}
