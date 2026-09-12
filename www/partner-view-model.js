// partner-view-model.js
//
// Partner View V1 — the allowlist boundary for the deeper, reciprocal "see my
// whole Today" partner projection. Sibling to shared-accountability-model.js,
// which stays untouched and keeps owning the quick-glance summary card: this
// module owns only the `/shared/partnerView` sub-tree. Every function here is
// pure (no DOM, no Firebase, no globals read) so the boundary is testable
// directly: build a projection from arbitrary/hostile input and assert only
// this allowlist survives.
//
// Written by the SAME publishSharedAccountability() call (storage.js) that
// writes the summary card, as a sibling key on the same object, in the same
// single `.set()` — so a summary-only or partnerView-only change can never
// wipe the other half of `/shared`.
//
// Consumed by index.html/storage.js on the publish side (classification of
// canonical Today Timeline items into display-ready {kind, activity, energy,
// evidenceLabel, tsStart, tsEnd} objects happens THERE, against the SAME
// assembleTodayTimeline()/computeTodayHealth() the owner's own Today screen
// renders — this module never recomputes Timeline/So-Far truth itself, only
// allowlists it) and on the read side (validatePartnerViewProjection — never
// trust a remote node's shape, even one written by the same client code,
// without re-checking it here).

const MAX_PRIORITIES = 3; // mirrors the app's own PLAN_MAX
const MAX_TIMELINE_ITEMS = 150; // bounded — a pathological day must not distort payload size or an ordinary day
const STATUS_LABELS = new Set(['Done', 'In progress', 'Logged', 'Not started']);
const KIND_VALUES = new Set(['actual', 'observed', 'template', 'gap']);
const EVIDENCE_LABELS = new Set(['TIMER', 'OBSERVED']);
const ENERGY_VALUES = new Set([
  'deep', 'shallow', 'nine5', 'errands', 'learning', 'exercise', 'social',
  'recovery', 'waste', 'admin', 'distraction', 'break', 'away'
]);

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

function cleanNum(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function cleanEnergy(value) {
  return ENERGY_VALUES.has(value) ? value : null;
}

/** One Today/Tomorrow priority row, display-ready and allowlisted. */
export function buildPartnerViewPriority(input) {
  if (!input || typeof input !== 'object') return null;
  const title = cleanText(input.title, 200);
  if (!title) return null;
  const out = { title, done: input.done === true };
  const plannedTime = cleanText(input.plannedTime, 20);
  if (plannedTime) out.plannedTime = plannedTime;
  out.statusLabel = STATUS_LABELS.has(input.statusLabel) ? input.statusLabel : (out.done ? 'Done' : 'Not started');
  return out;
}

function buildPriorities(items) {
  return (Array.isArray(items) ? items : [])
    .slice(0, MAX_PRIORITIES)
    .map(buildPartnerViewPriority)
    .filter(Boolean);
}

/**
 * One Timeline row, display-ready and allowlisted. Mirrors canonical Timeline
 * item kinds exactly — actual / observed / template / gap — and never invents
 * a second Timeline algorithm: the caller is expected to have already
 * classified the item from the SAME assembleTodayTimeline() output the
 * owner's own Today screen renders. This function only allowlists fields.
 * A gap never carries activity/energy/evidence (gap ≠ waste — no energy at
 * all, so it can never be misread as a confirmed classification).
 */
export function buildPartnerViewTimelineItem(item) {
  if (!item || typeof item !== 'object') return null;
  const kind = KIND_VALUES.has(item.kind) ? item.kind : null;
  if (!kind) return null;
  const tsEnd = cleanNum(item.tsEnd);
  if (tsEnd === null) return null;
  const out = { kind, tsEnd };
  const tsStart = cleanNum(item.tsStart);
  if (tsStart !== null) out.tsStart = tsStart;
  if (kind === 'gap') return out;

  const activity = cleanText(item.activity, 200);
  if (activity) out.activity = activity;
  const energy = cleanEnergy(item.energy);
  if (energy) out.energy = energy;
  // TEMPLATE HINT != ACTUAL: a template hint is a schedule assumption, never
  // stamped with an evidence label (that would imply it was observed/timed).
  if (kind !== 'template' && EVIDENCE_LABELS.has(item.evidenceLabel)) out.evidenceLabel = item.evidenceLabel;
  if (kind === 'template') out.autoLog = item.autoLog === true;
  return out;
}

function buildTimeline(items) {
  return (Array.isArray(items) ? items : [])
    .slice(0, MAX_TIMELINE_ITEMS)
    .map(buildPartnerViewTimelineItem)
    .filter(Boolean);
}

/**
 * Builds the exact `/shared/partnerView` payload — allowlist-constructed
 * field by field, never by spreading an existing internal object. Anything
 * not explicitly read here cannot leak. Returns null when the minimum
 * required shape (a publisher today dateKey) is missing, so a broken build
 * can never publish a half-formed projection.
 */
export function buildPartnerViewProjection({ dateKey, priorities, soFar, timelineItems, tomorrowDateKey, tomorrowPriorities } = {}) {
  if (typeof dateKey !== 'string' || !dateKey) return null;
  const deepMin = Number.isFinite(soFar && soFar.deepMin) ? Math.max(0, Math.trunc(soFar.deepMin)) : 0;
  const wasteMin = Number.isFinite(soFar && soFar.wasteMin) ? Math.max(0, Math.trunc(soFar.wasteMin)) : 0;

  return {
    today: {
      dateKey,
      priorities: buildPriorities(priorities),
      soFar: { deepMin, wasteMin },
      timeline: buildTimeline(timelineItems)
    },
    tomorrow: {
      dateKey: typeof tomorrowDateKey === 'string' && tomorrowDateKey ? tomorrowDateKey : dateKey,
      priorities: buildPriorities(tomorrowPriorities)
    }
  };
}

/** Content-only signature for write dedupe. There is no `updatedAt` anywhere
 *  in this sub-tree (freshness is read from the sibling `publisher` block
 *  written by the same call) — the whole serialized object IS the signature,
 *  so an unchanged projection never forces a repeated write. */
export function partnerViewSignature(partnerView) {
  if (!partnerView) return '';
  return JSON.stringify(partnerView);
}

/**
 * Re-validates an incoming (untrusted) `/shared/partnerView` node before it
 * is ever rendered. Strips anything outside the allowlist. Returns null when
 * missing or malformed — the caller then shows a calm "no current update"
 * state rather than a stale or half-formed view.
 */
export function validatePartnerViewProjection(value) {
  if (!value || typeof value !== 'object') return null;
  const today = value.today;
  if (!today || typeof today !== 'object' || typeof today.dateKey !== 'string' || !today.dateKey) return null;

  const soFarIn = today.soFar && typeof today.soFar === 'object' ? today.soFar : {};
  const soFar = {
    deepMin: Number.isFinite(soFarIn.deepMin) ? Math.max(0, Math.trunc(soFarIn.deepMin)) : 0,
    wasteMin: Number.isFinite(soFarIn.wasteMin) ? Math.max(0, Math.trunc(soFarIn.wasteMin)) : 0
  };

  const tomorrow = value.tomorrow && typeof value.tomorrow === 'object' ? value.tomorrow : {};
  const tomorrowDateKey = typeof tomorrow.dateKey === 'string' && tomorrow.dateKey ? tomorrow.dateKey : today.dateKey;

  return {
    today: {
      dateKey: today.dateKey,
      priorities: buildPriorities(today.priorities),
      soFar,
      timeline: buildTimeline(today.timeline)
    },
    tomorrow: {
      dateKey: tomorrowDateKey,
      priorities: buildPriorities(tomorrow.priorities)
    }
  };
}

const api = {
  buildPartnerViewPriority, buildPartnerViewTimelineItem, buildPartnerViewProjection,
  partnerViewSignature, validatePartnerViewProjection
};
globalThis.PartnerViewModel = api;
