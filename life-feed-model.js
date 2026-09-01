// Unified Life Feed — canonical feed model (Phase 6 V1).
//
// A READ-ONLY projection over already-validated Life Ledger events (the records returned by
// life-ledger-runtime.js's `createLocalLifeLedgerStore().listEvents()`). This module never
// mutates a source event, never revises/tombstones/re-fingerprints anything, and never
// re-validates or re-normalizes source facts — it only *reads* the accepted factual history
// and derives a human-scannable timeline from it.
//
// Fact parity with obsidian-life-ledger-renderer.js is deliberate: the two disagree on
// formatting, never on facts (date, time presence/absence, event identity, tombstone
// exclusion, duration where factual, meal date precision, workout unknown-duration). See
// life-feed-model.test.js for the shared accept/exclude matrix.

const SUPPORTED_EVENT_TYPES = new Set([
  'activity_logged',
  'focus_session_completed',
  'plan_step_completed',
  'workout_completed',
  'meal_prepared',
  'meal_consumed'
]);

// Stable user-facing domains. Implementation type names (meal_prepared, …) are never shown
// as the primary label — `DOMAIN_LABELS` + per-type titles carry the human wording.
const DOMAIN_BY_TYPE = Object.freeze({
  activity_logged: 'time',
  focus_session_completed: 'time',
  plan_step_completed: 'learning',
  workout_completed: 'workout',
  meal_prepared: 'meal',
  meal_consumed: 'meal'
});
const DOMAIN_LABELS = Object.freeze({
  time: 'Time',
  learning: 'Learning',
  workout: 'Workout',
  meal: 'Meal'
});
export const LIFE_FEED_DOMAINS = Object.freeze(['time', 'learning', 'workout', 'meal']);
export const LIFE_FEED_FILTERS = Object.freeze(['all', ...LIFE_FEED_DOMAINS]);

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Display-only text hygiene: strip control characters and collapse any run of whitespace
// (including newlines) to a single space so a feed row always renders on one line. This does
// not change a fact — it mirrors the Obsidian renderer's `text()` normalization intent. HTML
// escaping is the UI layer's responsibility (textContent / escapeHtml), not this model's.
function cleanText(value, fallback = '') {
  const normalized = String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || fallback;
}

const timezoneValidityCache = new Map();

function isValidTimezone(value) {
  if (typeof value !== 'string' || !value.trim() || !value.includes('/')) return false;
  if (timezoneValidityCache.has(value)) return timezoneValidityCache.get(value);
  let valid;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    valid = true;
  } catch {
    valid = false;
  }
  timezoneValidityCache.set(value, valid);
  return valid;
}

function isIsoInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

// Constructing an Intl.DateTimeFormat is expensive; a personal history is thousands of
// events across only a handful of zones, so cache one formatter per (zone) and reuse it.
const dayFormatterCache = new Map();
const timeFormatterCache = new Map();

function dayFormatter(timeZone) {
  let formatter = dayFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function timeFormatter(timeZone) {
  let formatter = timeFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
    timeFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

// Calendar day (YYYY-MM-DD) an instant falls on in a given IANA zone. DST-safe: Intl resolves
// the wall-clock date in-zone, so an instant near local midnight lands on the right day.
function dayKeyForInstant(isoInstant, timeZone) {
  const parts = dayFormatter(timeZone).formatToParts(new Date(isoInstant));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

// Wall-clock HH:MM (24h) of an instant in a given zone. Never invented — only called for
// instant-precision facts that carry a real timestamp.
function wallClockTime(isoInstant, timeZone) {
  const parts = timeFormatter(timeZone).formatToParts(new Date(isoInstant));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.hour === '24' ? '00' : byType.hour}:${byType.minute}`;
}

function shiftDayKey(dayKey, deltaDays) {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function roundMinutes(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function joinDetail(parts) {
  return parts.filter(part => part != null && part !== '').join(' · ');
}

function portionText(count) {
  const rounded = roundMinutes(count);
  if (rounded == null || rounded <= 0) return null;
  return `${rounded} ${rounded === 1 ? 'portion' : 'portions'}`;
}

// ── Per-type human summaries ──────────────────────────────────────────────────────────────
// Each returns { title, detail }. Fields are read straight off the accepted payload; a
// missing optional value is omitted (never guessed — no assumed kg, no "duration unknown",
// no fabricated midnight).

function summarizeActivity(payload) {
  return {
    title: cleanText(payload.activity, 'Activity'),
    detail: joinDetail([
      roundMinutes(payload.durationMinutes) == null ? null : `${roundMinutes(payload.durationMinutes)} min`,
      cleanText(payload.category)
    ])
  };
}

function summarizeFocus(payload) {
  return {
    title: cleanText(payload.activity, 'Focus session'),
    detail: joinDetail([
      roundMinutes(payload.durationMinutes) == null ? null : `${roundMinutes(payload.durationMinutes)} min`
    ])
  };
}

function summarizePlanStep(payload) {
  const source = isPlainObject(payload.source) ? payload.source : {};
  return {
    title: `Completed: ${cleanText(payload.stepLabel, 'Learning step')}`,
    detail: joinDetail([cleanText(source.planTitle), cleanText(source.lessonTitle)])
  };
}

function summarizeWorkout(payload) {
  const exercises = Array.isArray(payload.exercises) ? payload.exercises : [];
  const setCount = exercises.reduce(
    (total, exercise) => total + (Array.isArray(exercise && exercise.sets) ? exercise.sets.length : 0),
    0
  );
  const duration = roundMinutes(payload.durationMinutes);
  return {
    title: cleanText(payload.workoutName, 'Workout'),
    detail: joinDetail([
      duration == null ? null : `${duration} min`,
      exercises.length ? `${exercises.length} ${exercises.length === 1 ? 'exercise' : 'exercises'}` : null,
      setCount ? `${setCount} ${setCount === 1 ? 'set' : 'sets'}` : null
    ])
  };
}

function summarizeMealPrepared(payload) {
  return {
    title: `Prepared ${cleanText(payload.mealName, 'meal')}`,
    detail: joinDetail([portionText(payload.portionsPrepared)])
  };
}

function summarizeMealConsumed(payload) {
  return {
    title: `Ate ${cleanText(payload.mealName, 'meal')}`,
    detail: joinDetail([portionText(payload.portionCount)])
  };
}

const SUMMARIZERS = Object.freeze({
  activity_logged: summarizeActivity,
  focus_session_completed: summarizeFocus,
  plan_step_completed: summarizePlanStep,
  workout_completed: summarizeWorkout,
  meal_prepared: summarizeMealPrepared,
  meal_consumed: summarizeMealConsumed
});

// Which payload field carries the representative instant, and whether the event is an
// interval. meal_prepared is intentionally absent: it is date-precision.
const POINT_TIME_FIELD = Object.freeze({
  plan_step_completed: 'completedAt',
  meal_consumed: 'consumedAt'
});
const RANGE_TIME_FIELDS = Object.freeze({
  activity_logged: ['startedAt', 'endedAt'],
  focus_session_completed: ['startedAt', 'endedAt'],
  workout_completed: ['startedAt', 'endedAt']
});

function deriveTimes(event) {
  if (event.temporalPrecision === 'date' || event.type === 'meal_prepared') {
    return { displayTime: null, displayTimeRange: null };
  }
  const payload = isPlainObject(event.payload) ? event.payload : {};
  const timeZone = event.sourceTimezone;
  const range = RANGE_TIME_FIELDS[event.type];
  if (range) {
    const startIso = isIsoInstant(payload[range[0]]) ? payload[range[0]] : event.occurredAt;
    const endIso = isIsoInstant(payload[range[1]]) ? payload[range[1]] : event.occurredAt;
    if (!isIsoInstant(startIso) || !isIsoInstant(endIso)) return { displayTime: null, displayTimeRange: null };
    const start = wallClockTime(startIso, timeZone);
    const end = wallClockTime(endIso, timeZone);
    return {
      displayTime: start,
      displayTimeRange: start === end ? null : `${start}–${end}`
    };
  }
  const field = POINT_TIME_FIELD[event.type];
  const iso = field && isIsoInstant(payload[field]) ? payload[field] : event.occurredAt;
  if (!isIsoInstant(iso)) return { displayTime: null, displayTimeRange: null };
  return { displayTime: wallClockTime(iso, timeZone), displayTimeRange: null };
}

// Structural guard — NOT re-validation. The runtime store only ever hands us events that
// already passed life-ledger-core.js. This only checks that the few fields the projection
// reads are shaped well enough to render; anything else is skipped (never reinterpreted,
// never crashes the feed). Mirrors the renderer's "fail closed", but skips instead of throws
// because a feed must stay usable.
function feedReadableProblem(event) {
  if (!isPlainObject(event)) return 'not_an_object';
  if (!SUPPORTED_EVENT_TYPES.has(event.type)) return 'unsupported_type';
  if (typeof event.eventId !== 'string' || !event.eventId) return 'missing_event_id';
  if (!isValidTimezone(event.sourceTimezone)) return 'invalid_source_timezone';
  if (!isPlainObject(event.payload)) return 'missing_payload';
  if (event.temporalPrecision === 'date' || event.type === 'meal_prepared') {
    if (!DATE_KEY_RE.test(String(event.occurredDate))) return 'invalid_occurred_date';
  } else if (!isIsoInstant(event.occurredAt)) {
    return 'invalid_occurred_at';
  }
  return null;
}

function buildFeedItem(event) {
  const isDateOnly = event.temporalPrecision === 'date' || event.type === 'meal_prepared';
  const domain = DOMAIN_BY_TYPE[event.type];
  const summary = SUMMARIZERS[event.type](isPlainObject(event.payload) ? event.payload : {});
  const times = deriveTimes(event);
  const dayKey = isDateOnly ? event.occurredDate : dayKeyForInstant(event.occurredAt, event.sourceTimezone);
  // Sort anchor: the factual occurrence value as a string. A bare YYYY-MM-DD is a
  // lexicographic prefix of any same-day YYYY-MM-DDTHH:mm:ssZ instant, so a date-only event
  // sorts just before that day's timed events with no fabricated time. Identical to
  // obsidian-life-ledger-renderer.js's sortKeyFor().
  const sortKey = isDateOnly ? String(event.occurredDate) : String(event.occurredAt);
  return {
    eventId: event.eventId,
    type: event.type,
    domain,
    domainLabel: DOMAIN_LABELS[domain],
    sourceApp: event.sourceApp,
    temporalPrecision: isDateOnly ? 'date' : 'instant',
    occurredAt: isDateOnly ? null : event.occurredAt,
    occurredDate: isDateOnly ? event.occurredDate : null,
    sourceTimezone: event.sourceTimezone,
    dayKey,
    displayTime: times.displayTime,
    displayTimeRange: times.displayTimeRange,
    title: summary.title,
    detail: summary.detail,
    revision: Number.isInteger(event.revision) ? event.revision : null,
    // Kept only for deterministic tie-breaking; never a display value and never a sort
    // primary. See compareFeedItems().
    _sortKey: sortKey,
    _isDateOnly: isDateOnly,
    _recordedAt: typeof event.recordedAt === 'string' ? event.recordedAt : ''
  };
}

// Deterministic chronological order, identical in spirit to the Obsidian renderer:
//   1. factual occurrence value (occurredAt for instants, occurredDate for date-only)
//   2. ONLY when a date-only event is involved and (1) ties: recordedAt — a clearly
//      technical anchor, never a fabricated time-of-day. Two instant events never fall
//      through to recordedAt, so instant history is never reordered by ingestion time.
//   3. type, then eventId — fully stable final tiebreak.
export function compareFeedItems(a, b) {
  const keyCompare = a._sortKey.localeCompare(b._sortKey);
  if (keyCompare !== 0) return keyCompare;
  if (a._isDateOnly || b._isDateOnly) {
    const recordedCompare = String(a._recordedAt).localeCompare(String(b._recordedAt));
    if (recordedCompare !== 0) return recordedCompare;
  }
  return String(a.type).localeCompare(String(b.type)) || String(a.eventId).localeCompare(String(b.eventId));
}

function referenceTimeZone(options) {
  if (isValidTimezone(options.referenceTimeZone)) return options.referenceTimeZone;
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isValidTimezone(resolved)) return resolved;
  } catch {
    // fall through
  }
  return 'Etc/UTC';
}

function dayLabel(dayKey, todayKey, yesterdayKey) {
  if (dayKey === todayKey) return 'Today';
  if (dayKey === yesterdayKey) return 'Yesterday';
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const sameYear = todayKey.slice(0, 4) === dayKey.slice(0, 4);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Etc/UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  }).format(date);
}

function absoluteDate(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Etc/UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function groupIntoDays(items, options) {
  const refZone = referenceTimeZone(options);
  const now = options.now instanceof Date ? options.now : new Date();
  const nowIso = Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
  const todayKey = dayKeyForInstant(nowIso, refZone);
  const yesterdayKey = shiftDayKey(todayKey, -1);

  const byDay = new Map();
  for (const item of items) {
    if (!byDay.has(item.dayKey)) byDay.set(item.dayKey, []);
    byDay.get(item.dayKey).push(item);
  }
  return {
    referenceTimeZone: refZone,
    generatedAt: nowIso,
    days: Array.from(byDay.keys())
      .sort((a, b) => b.localeCompare(a)) // newest calendar day first
      .map(dayKey => ({
        dayKey,
        label: dayLabel(dayKey, todayKey, yesterdayKey),
        absoluteDate: absoluteDate(dayKey),
        isToday: dayKey === todayKey,
        isYesterday: dayKey === yesterdayKey,
        items: byDay.get(dayKey).slice().sort(compareFeedItems)
      }))
  };
}

function emptyCounts() {
  return { all: 0, time: 0, learning: 0, workout: 0, meal: 0 };
}

// A usable revision is a positive integer (life-ledger-core.js's `revision must be a positive
// integer` invariant). Anything else ranks below every real revision so it can never win a
// duplicate-eventId contest.
function revisionRank(record) {
  return Number.isInteger(record.revision) && record.revision >= 1 ? record.revision : 0;
}

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

// The feed-relevant facts of a record. Two records that agree here are interchangeable for
// display; two that disagree AT THE SAME revision are contradictory (impossible under valid
// Ledger semantics) and the event is skipped as a conflict rather than guessed.
function factSignature(record) {
  return stableSerialize({
    type: record.type ?? null,
    occurredAt: record.occurredAt ?? null,
    occurredDate: record.occurredDate ?? null,
    temporalPrecision: record.temporalPrecision ?? null,
    sourceTimezone: record.sourceTimezone ?? null,
    recordedAt: record.recordedAt ?? null,
    tombstoneActive: isPlainObject(record.tombstone) && record.tombstone.active === true,
    payload: record.payload ?? null
  });
}

// Collapse duplicate raw records that share an eventId into ONE deterministic current record
// BEFORE any display item or tombstone decision:
//   • highest valid revision wins — input order never changes the outcome;
//   • records tied at the top revision must be equivalent (the exact-duplicate case);
//     if they contradict, the event is reported as a `revision_conflict` skip;
//   • the winner is then subject to the normal readable-guard and tombstone-exclusion checks,
//     so a newer tombstoned revision correctly supersedes an older active one.
// Never mutates input. Records with no usable eventId pass straight through to the per-record
// readable guard (which reports them as `missing_event_id`).
function resolveCurrentRecords(events) {
  const groups = new Map();
  const passthrough = [];
  for (const event of events) {
    if (!isPlainObject(event) || typeof event.eventId !== 'string' || !event.eventId) {
      passthrough.push(event);
      continue;
    }
    if (!groups.has(event.eventId)) groups.set(event.eventId, []);
    groups.get(event.eventId).push(event);
  }

  const resolved = [];
  const conflicts = [];
  for (const [eventId, records] of groups) {
    if (records.length === 1) {
      resolved.push(records[0]);
      continue;
    }
    let topRank = 0;
    for (const record of records) {
      const rank = revisionRank(record);
      if (rank > topRank) topRank = rank;
    }
    const tied = records.filter(record => revisionRank(record) === topRank);
    if (new Set(tied.map(factSignature)).size > 1) {
      const typed = records.find(record => record.type != null);
      conflicts.push({ eventId, type: typed ? String(typed.type) : null, reason: 'revision_conflict' });
      continue;
    }
    resolved.push(tied[0]);
  }
  return { resolved: [...resolved, ...passthrough], conflicts };
}

/**
 * Build the Unified Life Feed from stored Life Ledger events.
 *
 * @param {Array<object>} rawEvents  Output of `createLocalLifeLedgerStore().listEvents()`.
 * @param {object} [options]
 * @param {Date}   [options.now]                Reference "now" for Today/Yesterday labels.
 * @param {string} [options.referenceTimeZone]  IANA zone for the Today/Yesterday boundary.
 * @returns {{
 *   generatedAt: string, referenceTimeZone: string,
 *   items: object[], days: object[], counts: object,
 *   skipped: Array<{eventId: (string|null), type: (string|null), reason: string}>,
 *   isEmpty: boolean
 * }}
 */
export function buildLifeFeed(rawEvents, options = {}) {
  const events = Array.isArray(rawEvents) ? rawEvents : [];
  const skipped = [];
  const items = [];

  // Resolve any duplicate raw records (same eventId) to one deterministic current record
  // first — highest valid revision wins regardless of input order — so the tombstone and
  // readable-guard decisions below always act on current truth, not a stale revision.
  const { resolved, conflicts } = resolveCurrentRecords(events);
  skipped.push(...conflicts);

  for (const event of resolved) {
    const problem = feedReadableProblem(event);
    if (problem) {
      skipped.push({
        eventId: isPlainObject(event) && typeof event.eventId === 'string' ? event.eventId : null,
        type: isPlainObject(event) && event.type != null ? String(event.type) : null,
        reason: problem
      });
      continue;
    }
    // Tombstoned current record → not current factual history. Excluded, never resurrected.
    if (isPlainObject(event.tombstone) && event.tombstone.active === true) continue;
    items.push(buildFeedItem(event));
  }

  items.sort(compareFeedItems);

  const counts = emptyCounts();
  for (const item of items) {
    counts.all += 1;
    counts[item.domain] += 1;
  }

  const grouped = groupIntoDays(items, options);
  return {
    generatedAt: grouped.generatedAt,
    referenceTimeZone: grouped.referenceTimeZone,
    items,
    days: grouped.days,
    counts,
    skipped,
    isEmpty: items.length === 0
  };
}

/**
 * Narrow an already-built feed to a single domain (or 'all'). Pure: operates only on the
 * derived feed, never re-reads the ledger. `counts` stays the pre-filter totals so the UI
 * can say "No Workout events" while still showing the tab badges.
 */
export function filterLifeFeed(feed, domain, options = {}) {
  const activeDomain = LIFE_FEED_FILTERS.includes(domain) ? domain : 'all';
  if (activeDomain === 'all') {
    return { ...feed, activeDomain, filteredCount: feed.items.length, isEmpty: feed.items.length === 0 };
  }
  const items = feed.items.filter(item => item.domain === activeDomain);
  const grouped = groupIntoDays(items, {
    now: options.now instanceof Date ? options.now : new Date(feed.generatedAt),
    referenceTimeZone: feed.referenceTimeZone
  });
  return {
    ...feed,
    items,
    days: grouped.days,
    activeDomain,
    filteredCount: items.length,
    isEmpty: items.length === 0
  };
}

export const LIFE_FEED_DOMAIN_LABELS = DOMAIN_LABELS;
