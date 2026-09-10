// ChronaSense Coarse Life Evidence V1 (Phase 6H) — pure model.
//
// Day-scoped ESTIMATED activity duration without timestamp placement — the "duration
// without placement" positive evidence form from
// contracts/CHRONASENSE_EVIDENCE_CONTRACT_V1.md. A record answers "roughly how much?",
// never "exactly when?": no tsStart, no tsEnd, no fabricated clock placement.
//
// Identity is deterministic: (accounting date, normalized activity label). Saving the
// same label on the same date again — whether unchanged or with an edited duration —
// updates that one record in place. It never appends an additive duplicate (§4/§13 of
// the milestone spec). A different label, or the same label on a different date, is an
// independent record.

export const COARSE_LIFE_EVIDENCE_KEY = 'ta3-coarse-life-evidence-v1';
export const COARSE_LIFE_EVIDENCE_SCHEMA_VERSION = 1;

// Resolution/measurement/provenance vocabulary matches the canonical evidence contract
// terms verbatim (Resolution table, Provenance table) rather than inventing new ones.
export const COARSE_LIFE_EVIDENCE_RESOLUTION = 'duration_without_placement';
export const COARSE_LIFE_EVIDENCE_MEASUREMENT = 'estimated';
export const COARSE_LIFE_EVIDENCE_PROVENANCE = 'user_assertion';

// A single day-scoped record can never truthfully exceed one calendar day's elapsed
// minutes. This reuses the existing 1440-minute day-length constant already present
// elsewhere in the codebase (index.html timeline math) rather than inventing a new bound.
const MAX_ESTIMATED_MINUTES = 1440;
const MAX_LABEL_LENGTH = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return false;
  const d = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** Collapse whitespace, trim, and cap length. Case is preserved for display. */
export function normalizeLabel(label) {
  const trimmed = typeof label === 'string' ? label.replace(/\s+/g, ' ').trim() : '';
  return trimmed.slice(0, MAX_LABEL_LENGTH);
}

/** Deterministic identity key: (date, case-insensitive normalized label). */
export function coarseEvidenceId(date, label) {
  if (!validDate(date)) throw new Error('Invalid coarse evidence date.');
  const identity = normalizeLabel(label).toLowerCase();
  if (!identity) throw new Error('Coarse evidence needs an activity label.');
  return `${date}::${identity}`;
}

export function validateCoarseEvidenceRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Invalid coarse evidence record.');
  }
  if (!validDate(record.date)) throw new Error('Invalid coarse evidence date.');
  if (typeof record.timezone !== 'string' || !record.timezone.trim()) {
    throw new Error('Invalid coarse evidence timezone.');
  }
  const label = normalizeLabel(record.label);
  if (!label || label !== record.label) throw new Error('Invalid coarse evidence label.');
  if (record.id !== coarseEvidenceId(record.date, label)) {
    throw new Error('Coarse evidence id does not match its date/label identity.');
  }
  if (!Number.isInteger(record.estimatedMinutes) || record.estimatedMinutes < 1 ||
      record.estimatedMinutes > MAX_ESTIMATED_MINUTES) {
    throw new Error(`Approximate duration must be a whole number of minutes between 1 and ${MAX_ESTIMATED_MINUTES}.`);
  }
  if (record.resolution !== COARSE_LIFE_EVIDENCE_RESOLUTION) throw new Error('Invalid coarse evidence resolution.');
  if (record.measurement !== COARSE_LIFE_EVIDENCE_MEASUREMENT) throw new Error('Invalid coarse evidence measurement.');
  if (record.provenance !== COARSE_LIFE_EVIDENCE_PROVENANCE) throw new Error('Invalid coarse evidence provenance.');
  if (!Number.isFinite(record.createdAt) || record.createdAt <= 0) throw new Error('Invalid coarse evidence createdAt.');
  if (!Number.isFinite(record.updatedAt) || record.updatedAt < record.createdAt) {
    throw new Error('Invalid coarse evidence updatedAt.');
  }
  // No tsStart/tsEnd/start/end field is ever legal here — this form does not carry
  // placement. Reject a record that tries to smuggle one in (e.g. from a bad merge).
  if ('tsStart' in record || 'tsEnd' in record || 'start' in record || 'end' in record) {
    throw new Error('Coarse evidence must not carry timeline placement fields.');
  }
  return record;
}

export function createCoarseEvidenceRecord({ date, timezone, label, estimatedMinutes, now = Date.now() }) {
  const cleanLabel = normalizeLabel(label);
  return validateCoarseEvidenceRecord({
    id: coarseEvidenceId(date, cleanLabel),
    date,
    timezone,
    label: cleanLabel,
    estimatedMinutes,
    resolution: COARSE_LIFE_EVIDENCE_RESOLUTION,
    measurement: COARSE_LIFE_EVIDENCE_MEASUREMENT,
    provenance: COARSE_LIFE_EVIDENCE_PROVENANCE,
    createdAt: now,
    updatedAt: now
  });
}

// Minimal day read model (§27) — pure, reusable by later Review reconciliation (6I)
// without redesign. Deliberately carries no Review/reconciliation policy: just the
// stable records for a date and their estimated total.
export function getCoarseEvidenceForDate(records, date) {
  const forDate = (records || [])
    .filter(r => r.date === date)
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label));
  const totalEstimatedMinutes = forDate.reduce((sum, r) => sum + r.estimatedMinutes, 0);
  return { date, records: forDate, totalEstimatedMinutes };
}

// A small broad starting vocabulary offered as suggestions only — the label input
// remains free text (§5/§7 of the milestone spec: "should also be able to enter a
// useful broad label"). Not an enum; not validated against.
export const COARSE_LIFE_EVIDENCE_SUGGESTED_LABELS = Object.freeze([
  'Food / cooking',
  'Household',
  'Care / pets',
  'Errands',
  'Family / social',
  'Entertainment',
  'Travel',
  'Recovery / downtime',
  'Other'
]);

export const COARSE_LIFE_EVIDENCE_MODEL_V1 = Object.freeze({
  schemaVersion: COARSE_LIFE_EVIDENCE_SCHEMA_VERSION,
  key: COARSE_LIFE_EVIDENCE_KEY,
  resolution: COARSE_LIFE_EVIDENCE_RESOLUTION,
  measurement: COARSE_LIFE_EVIDENCE_MEASUREMENT,
  provenance: COARSE_LIFE_EVIDENCE_PROVENANCE,
  maxEstimatedMinutes: MAX_ESTIMATED_MINUTES
});
