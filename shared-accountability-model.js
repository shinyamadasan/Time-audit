// shared-accountability-model.js
//
// Wife / Shared Accountability V1 — the allowlist boundary for what a securely-linked
// partner is ever shown. Every function here is pure (no DOM, no Firebase, no globals
// read) so the privacy contract can be tested directly: build a payload from arbitrary
// input and assert only these fields ever come out.
//
// Consumed by storage.js (publish side, via getPlanItems/planTrackedMin/PlanTomorrowModel
// already canonical in index.html) and by the partner-card render in index.html (read
// side, via validateSharedPayload — never trust a remote node's shape, even one written
// by the same client code, without re-checking it here).

const MAX_SHARED_PRIORITIES = 3; // mirrors the app's own PLAN_MAX; enforced again here as a hard privacy belt
const STATUS_VALUES = new Set(['planned', 'worked-on', 'done']);
const PREP_VALUES = new Set(['prepared', 'open-day', 'not-prepared']);
const SCHEMA_VERSION = 1;

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

/** Today status semantics (spec-mandated): minutes alone can never imply Done. */
export function deriveTodayItemStatus(item, trackedMinutes) {
  if (item && item.done === true) return 'done';
  return Number(trackedMinutes) > 0 ? 'worked-on' : 'planned';
}

/** Tomorrow prep semantics: explicit confirmed prep vs. explicit Open Day vs. neither. */
export function deriveTomorrowPrepStatus(preparation) {
  if (!preparation || typeof preparation !== 'object') return 'not-prepared';
  return preparation.intentionalBlank === true ? 'open-day' : 'prepared';
}

const _dateKeyFmtCache = new Map();
/** Calendar date, in an explicit timezone, from a UTC instant. Never reads any ambient
 *  "current user" timezone — the whole point is evaluating the PUBLISHER's zone from a
 *  viewer who may be anywhere. */
export function dateKeyInTimezone(nowMs, timezone) {
  let fmt = _dateKeyFmtCache.get(timezone);
  if (!fmt) { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }); _dateKeyFmtCache.set(timezone, fmt); }
  return fmt.format(new Date(nowMs));
}

/** Is a published `today` block still describing the publisher's actual current day?
 *  `publisherTimezone` comes from a REMOTE, untrusted `/shared` node — a syntactically
 *  present-but-invalid IANA zone (corrupted sync data, direct Firebase tampering) must
 *  fail CLOSED to "not fresh," never throw and never fall back to the viewer's own
 *  timezone: an invalid publisher timezone means the publisher's current day cannot be
 *  established, which is itself a reason to treat the payload as not current. */
export function isSharedTodayFresh(nowMs, publisherTimezone, sharedTodayDateKey) {
  if (typeof publisherTimezone !== 'string' || !publisherTimezone) return false;
  if (typeof sharedTodayDateKey !== 'string' || !sharedTodayDateKey) return false;
  try {
    return dateKeyInTimezone(nowMs, publisherTimezone) === sharedTodayDateKey;
  } catch {
    return false; // invalid IANA timezone — cannot establish the publisher's current day
  }
}

/** Calm, coarse freshness copy — never second-by-second, never presence/"last seen". */
export function formatFreshness(nowMs, updatedAt) {
  if (!Number.isFinite(updatedAt)) return '';
  const diffMs = Math.max(0, nowMs - updatedAt);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 15) return 'Updated recently';
  if (mins < 60) return `Updated ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Updated ${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `Updated ${days}d ago`;
}

/**
 * Builds the exact `/shared` payload — allowlist-constructed field by field, never by
 * spreading an existing internal object. Anything not explicitly read here cannot leak.
 */
export function buildSharedPayload({ displayName, timezone, dateKey, updatedAt, todayItems, tomorrowDateKey, tomorrowPrepStatus } = {}) {
  if (typeof timezone !== 'string' || !timezone) throw new Error('A publisher timezone is required.');
  if (typeof dateKey !== 'string' || !dateKey) throw new Error('A publisher dateKey is required.');
  if (!Number.isFinite(updatedAt)) throw new Error('A publish timestamp is required.');

  const priorities = (Array.isArray(todayItems) ? todayItems : [])
    .slice(0, MAX_SHARED_PRIORITIES)
    .map(item => ({
      title: cleanText(item && item.title, 200),
      status: STATUS_VALUES.has(item && item.status) ? item.status : 'planned'
    }))
    .filter(item => item.title);

  const prepStatus = PREP_VALUES.has(tomorrowPrepStatus) ? tomorrowPrepStatus : 'not-prepared';

  const publisher = { timezone, dateKey, updatedAt: Math.trunc(updatedAt) };
  const name = cleanText(displayName, 80);
  if (name) publisher.displayName = name;

  return {
    schemaVersion: SCHEMA_VERSION,
    publisher,
    today: { dateKey, priorities },
    tomorrow: {
      dateKey: typeof tomorrowDateKey === 'string' && tomorrowDateKey ? tomorrowDateKey : dateKey,
      prepStatus
    }
  };
}

/** Content-only signature for write dedupe — deliberately excludes updatedAt so a
 *  timestamp alone can never force a repeated write; only a real change to what the
 *  partner would actually see triggers one. */
export function sharedPayloadSignature(payload) {
  if (!payload) return '';
  return JSON.stringify({
    publisher: {
      timezone: payload.publisher?.timezone || '',
      dateKey: payload.publisher?.dateKey || '',
      displayName: payload.publisher?.displayName || ''
    },
    today: payload.today,
    tomorrow: payload.tomorrow
  });
}

/**
 * Re-validates an incoming (untrusted) `/shared` node before it is ever rendered.
 * Strips anything outside the allowlist and coerces unknown status/prep values to
 * their safest default, so a malformed or legacy node can never surface a stray field.
 * Returns null when the node is missing or not this schema.
 */
export function validateSharedPayload(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== SCHEMA_VERSION) return null;
  const publisher = value.publisher;
  if (!publisher || typeof publisher !== 'object') return null;
  if (typeof publisher.timezone !== 'string' || !publisher.timezone) return null;
  if (typeof publisher.dateKey !== 'string' || !publisher.dateKey) return null;
  if (!Number.isFinite(publisher.updatedAt)) return null;

  const today = value.today;
  if (!today || typeof today !== 'object' || typeof today.dateKey !== 'string' || !today.dateKey) return null;
  // Firebase RTDB has no concept of an empty array/object as a persisted value — a node
  // with zero children is indistinguishable from one that was never written, so a
  // genuinely-published `priorities: []` reads back here as `undefined`, not `[]`. Zero
  // priorities is a valid, current, accountability-relevant state (not a broken payload),
  // so a missing/pruned array must default to empty rather than invalidate the whole node.
  const priorities = (Array.isArray(today.priorities) ? today.priorities : [])
    .slice(0, MAX_SHARED_PRIORITIES)
    .map(p => ({
      title: cleanText(p && p.title, 200),
      status: STATUS_VALUES.has(p && p.status) ? p.status : 'planned'
    }))
    .filter(p => p.title);

  const tomorrow = value.tomorrow && typeof value.tomorrow === 'object' ? value.tomorrow : {};
  const prepStatus = PREP_VALUES.has(tomorrow.prepStatus) ? tomorrow.prepStatus : 'not-prepared';

  const out = {
    schemaVersion: SCHEMA_VERSION,
    publisher: { timezone: publisher.timezone, dateKey: publisher.dateKey, updatedAt: publisher.updatedAt },
    today: { dateKey: today.dateKey, priorities },
    tomorrow: { dateKey: typeof tomorrow.dateKey === 'string' && tomorrow.dateKey ? tomorrow.dateKey : today.dateKey, prepStatus }
  };
  const name = cleanText(publisher.displayName, 80);
  if (name) out.publisher.displayName = name;
  return out;
}

const api = {
  deriveTodayItemStatus, deriveTomorrowPrepStatus, dateKeyInTimezone, isSharedTodayFresh,
  formatFreshness, buildSharedPayload, sharedPayloadSignature, validateSharedPayload
};
globalThis.SharedAccountabilityModel = api;
