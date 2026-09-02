// Life Character Sheet — canonical projection model (Phase 7 V1).
//
// Answers ONE question: "Where am I right now?" — a compact, factual snapshot of current
// state across life domains. This is NOT the Unified Life Feed ("what happened?"), NOT a
// coach, NOT a scorecard. It shows facts and it is honest about what it cannot know.
//
// A PURE, READ-ONLY projection. It never mutates the Life Ledger, learning plans, the
// Capability profile, or any source app. Given the same inputs it returns the same output
// regardless of event order.
//
// Authoritative sources (never duplicated here):
//   • Life Ledger events           → focus / time / workout / meal / learning-completion facts
//   • Learning plans (repository)  → plan progress + next unfinished step
//   • Capability/Career profile    → career target, tracked skills, evidence by dimension
//
// Feed parity is enforced by construction: every Ledger-derived fact is read off the item
// set produced by buildLifeFeed() (same accept / tombstone / revision / day-bucketing
// rules), then joined back to the raw event only to read a numeric payload value the feed
// does not expose. See life-character-sheet-model.test.js for the parity matrix.
//
// ── ZERO vs UNKNOWN (the highest-risk semantic in Phase 7) ────────────────────────────────
// A domain is only allowed to state "0" when the producing source is actually live in the
// runtime AND we therefore have adequate coverage to count. `liveIngestedTypes` says which
// event types the caller's runtime actually ingests today. Everything else reports
// "not connected yet" or "loaded from an import, not auto-updating" — never a misleading 0.

import { buildLifeFeed } from './life-feed-model.js';
import { analyzeCapabilityCareer } from './capability-career-analytics.js';
import { findNextLearningPlanStep } from './learning-plan-next-action.js';
import { getLearningPlanProgress } from './learning-plan-model.js';

// The event types ChronaSense actually writes to the runtime Life Ledger today. Workout,
// Meal, and free-form activity_logged adapters exist but are not wired into the live runtime
// (see Phase 7 brief) — their absence must never read as behavioural zero.
export const LIFE_CHARACTER_SHEET_LIVE_INGESTED_TYPES = Object.freeze([
  'focus_session_completed',
  'plan_step_completed'
]);

export const LIFE_CHARACTER_SHEET_MODEL_V1 = Object.freeze({
  windows: Object.freeze(['today', 'last7Days', 'currentPlan', 'allTimeProfile']),
  coverageStates: Object.freeze([
    'active',                 // live source + at least one accepted event
    'no-events-yet',          // live source, zero accepted events (a truthful zero)
    'loaded-not-live',        // events present from an import, source not auto-updating
    'not-connected'           // source not ingested and no events supplied
  ])
});

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function roundMinutes(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function isIsoInstant(value) {
  return typeof value === 'string' && ISO_INSTANT_RE.test(value) && Number.isFinite(Date.parse(value));
}

// ── day-key helpers (identical rule to life-feed-model.js / life-ledger-runtime.js) ───────
const dayFormatterCache = new Map();
function dayFormatter(timeZone) {
  let formatter = dayFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}
function dayKeyForInstant(isoInstant, timeZone) {
  const parts = dayFormatter(timeZone).formatToParts(new Date(isoInstant));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}
function shiftDayKey(dayKey, deltaDays) {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

// Highest-revision raw record per eventId. buildLifeFeed() already decides WHICH events are
// current truth (and excludes tombstones / revision conflicts); this map only exists to read
// a numeric payload field off that same winning record. A positive integer revision wins;
// anything else ranks below every real revision (life-ledger-core invariant).
function rawEventsById(rawEvents) {
  const byId = new Map();
  const rank = record => (Number.isInteger(record.revision) && record.revision >= 1 ? record.revision : 0);
  for (const event of rawEvents) {
    if (!isPlainObject(event) || typeof event.eventId !== 'string' || !event.eventId) continue;
    const existing = byId.get(event.eventId);
    if (!existing || rank(event) >= rank(existing)) byId.set(event.eventId, event);
  }
  return byId;
}

function payloadOf(rawById, item) {
  const raw = rawById.get(item.eventId);
  return raw && isPlainObject(raw.payload) ? raw.payload : {};
}

// Display text hygiene mirroring life-feed-model.js cleanText(): one line, no control bytes.
function cleanText(value, fallback) {
  const normalized = String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || fallback;
}

function mealName(payload) {
  return cleanText(payload.mealName, 'meal');
}

// A feed item's factual occurrence value for display ("when"), never fabricated.
function occurrenceOf(item) {
  return {
    occurredAt: item.occurredAt || null,
    occurredDate: item.occurredDate || null,
    dayKey: item.dayKey
  };
}

function windowKeys(todayKey, days) {
  const keys = new Set();
  for (let i = 0; i < days; i += 1) keys.add(shiftDayKey(todayKey, -i));
  return keys;
}

// ── Focus / Time (activity_logged) ───────────────────────────────────────────────────────
function summariseInstantActivity(items, rawById, todayKey, last7, typeLabelField) {
  const today = items.filter(item => item.dayKey === todayKey);
  const week = items.filter(item => last7.has(item.dayKey));
  const minutesFor = list => list.reduce((total, item) => {
    const mins = roundMinutes(payloadOf(rawById, item).durationMinutes);
    return total + (mins != null && mins > 0 ? mins : 0);
  }, 0);
  const latestItem = items.length ? items[items.length - 1] : null;
  return {
    hasEvents: items.length > 0,
    today: { sessions: today.length, minutes: minutesFor(today) },
    last7Days: { sessions: week.length, minutes: minutesFor(week), dayCount: 7 },
    allTime: { sessions: items.length },
    latest: latestItem
      ? {
        ...occurrenceOf(latestItem),
        title: latestItem.title,
        minutes: roundMinutes(payloadOf(rawById, latestItem).durationMinutes)
      }
      : null,
    _typeLabelField: typeLabelField
  };
}

// ── Learning ─────────────────────────────────────────────────────────────────────────────
function planCompletionEvents(items, rawById) {
  // plan_step_completed feed items, oldest→newest, joined to their planId where present.
  return items.map(item => {
    const payload = payloadOf(rawById, item);
    const source = isPlainObject(payload.source) ? payload.source : {};
    return {
      item,
      stepLabel: typeof payload.stepLabel === 'string' ? payload.stepLabel : null,
      planId: typeof source.planId === 'string' && source.planId ? source.planId : null,
      planTitle: typeof source.planTitle === 'string' && source.planTitle ? source.planTitle : null,
      completedAt: isIsoInstant(payload.completedAt) ? payload.completedAt : (item.occurredAt || null)
    };
  });
}

// The active plan: the plan whose id matches the most recent accepted plan_step_completed
// event. If no completion maps to a known plan, fall back to the most recently updated plan.
// Deterministic final tiebreak: plan id.
function pickActivePlan(plans, completions) {
  if (!plans.length) return null;
  for (let i = completions.length - 1; i >= 0; i -= 1) {
    const planId = completions[i].planId;
    if (!planId) continue;
    const match = plans.find(plan => plan.id === planId);
    if (match) return match;
  }
  return plans
    .slice()
    .sort((a, b) => {
      const byUpdated = String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      return byUpdated !== 0 ? byUpdated : String(a.id).localeCompare(String(b.id));
    })[0];
}

function buildLearning(plans, planItems, rawById, last7) {
  const completions = planCompletionEvents(planItems, rawById);
  const recentCompletions = completions.filter(entry => last7.has(entry.item.dayKey)).length;
  const latest = completions.length ? completions[completions.length - 1] : null;
  const latestCompletedStep = latest
    ? {
      stepLabel: latest.stepLabel,
      planTitle: latest.planTitle,
      completedAt: latest.completedAt,
      dayKey: latest.item.dayKey
    }
    : null;

  if (!plans.length) {
    return {
      status: 'no-plans',
      planCount: 0,
      activePlan: null,
      latestCompletedStep,
      recentCompletions7d: recentCompletions
    };
  }

  const active = pickActivePlan(plans, completions);
  let activePlan = null;
  if (active) {
    const progress = getLearningPlanProgress(active);
    const next = findNextLearningPlanStep(active);
    activePlan = {
      title: active.title,
      totalSteps: progress.totalSteps,
      completedSteps: progress.completedSteps,
      completionPercent: progress.completionPercent,
      isComplete: progress.totalSteps > 0 && progress.completedSteps === progress.totalSteps,
      hasSteps: progress.totalSteps > 0,
      nextStep: next
        ? { stepTitle: next.stepTitle, lessonTitle: next.lessonTitle, phaseTitle: next.phaseTitle }
        : null
    };
  }
  return {
    status: 'data',
    planCount: plans.length,
    activePlan,
    latestCompletedStep,
    recentCompletions7d: recentCompletions
  };
}

// ── Capability / Career ──────────────────────────────────────────────────────────────────
function trackedSkills(profile) {
  const skills = Array.isArray(profile.skills) ? profile.skills : [];
  return skills
    .filter(skill => isPlainObject(skill) && skill.status !== 'archived' && skill.status !== 'paused')
    .map(skill => ({ name: String(skill.name || 'Skill'), status: String(skill.status || 'active') }));
}

function buildCapability(profile, ledgerEvents, nowIso) {
  const empty = {
    status: 'no-data',
    careerTarget: null,
    activeCareerTargetCount: 0,
    trackedSkills: [],
    trackedSkillCount: 0,
    dimensionEvidence: { knowledge: 0, practice: 0, execution: 0, shipping: 0, portfolio: 0 },
    totalEvidence: 0,
    trackedProjectCount: 0,
    portfolioArtifactCount: 0
  };
  if (!isPlainObject(profile)) return empty;

  let analysis;
  try {
    analysis = analyzeCapabilityCareer(profile, { now: nowIso, lifeLedgerEvents: ledgerEvents });
  } catch {
    return { ...empty, status: 'unreadable' };
  }

  const skills = trackedSkills(profile);
  const activeTargets = (Array.isArray(profile.careerTargets) ? profile.careerTargets : [])
    .filter(target => isPlainObject(target) && target.status === 'active');
  const artifacts = Array.isArray(profile.artifacts) ? profile.artifacts : [];
  const trackedProjectCount = analysis.projects.filter(project => project.actionable).length;
  const hasAnything = skills.length > 0
    || activeTargets.length > 0
    || analysis.currentEvidenceCount > 0
    || trackedProjectCount > 0
    || artifacts.length > 0;

  return {
    status: hasAnything ? 'data' : 'no-data',
    careerTarget: analysis.target ? { title: analysis.target.title } : null,
    activeCareerTargetCount: activeTargets.length,
    trackedSkills: skills,
    trackedSkillCount: skills.length,
    dimensionEvidence: { ...analysis.dimensionTotals },
    totalEvidence: analysis.currentEvidenceCount,
    trackedProjectCount,
    portfolioArtifactCount: artifacts.length
  };
}

// ── Coverage / freshness ─────────────────────────────────────────────────────────────────
function coverageState(hasEvents, isLive) {
  if (isLive && hasEvents) return 'active';
  if (isLive && !hasEvents) return 'no-events-yet';
  if (!isLive && hasEvents) return 'loaded-not-live';
  return 'not-connected';
}

function domainCoverage(items, isLive) {
  const hasEvents = items.length > 0;
  const latest = hasEvents ? items[items.length - 1] : null;
  return {
    state: coverageState(hasEvents, isLive),
    eventCount: items.length,
    live: isLive,
    lastEventDayKey: latest ? latest.dayKey : null,
    lastEventAt: latest ? (latest.occurredAt || null) : null
  };
}

/**
 * Build the Life Character Sheet snapshot.
 *
 * @param {object}  input
 * @param {Array}   input.ledgerEvents        Output of createLocalLifeLedgerStore().listEvents().
 * @param {Array}   [input.learningPlans]     Output of learningPlanRepository.listPlans().
 * @param {object}  [input.capabilityProfile] Output of capabilityCareerRepository.loadProfile().
 * @param {Date|string} [input.now]
 * @param {string}  [input.referenceTimeZone] IANA zone for the Today / last-7-days boundary.
 * @param {string[]} [input.liveIngestedTypes] Ledger event types the runtime actually ingests.
 * @returns {object} A pure derived snapshot. Never persisted as a new truth store.
 */
export function buildLifeCharacterSheet(input = {}) {
  const ledgerEvents = Array.isArray(input.ledgerEvents) ? input.ledgerEvents : [];
  const learningPlans = Array.isArray(input.learningPlans) ? input.learningPlans : [];
  const capabilityProfile = isPlainObject(input.capabilityProfile) ? input.capabilityProfile : null;
  const liveTypes = new Set(
    Array.isArray(input.liveIngestedTypes) && input.liveIngestedTypes.length
      ? input.liveIngestedTypes
      : LIFE_CHARACTER_SHEET_LIVE_INGESTED_TYPES
  );
  const now = input.now instanceof Date && Number.isFinite(input.now.getTime())
    ? input.now
    : (isIsoInstant(input.now) ? new Date(input.now) : new Date());

  // Single canonical projection — same accept / tombstone / order rules as the Life Feed.
  const feed = buildLifeFeed(ledgerEvents, { now, referenceTimeZone: input.referenceTimeZone });
  const rawById = rawEventsById(ledgerEvents);
  const generatedAt = feed.generatedAt;
  const referenceTimeZone = feed.referenceTimeZone;
  const todayKey = dayKeyForInstant(generatedAt, referenceTimeZone);
  const last7 = windowKeys(todayKey, 7);

  const itemsByType = type => feed.items.filter(item => item.type === type);
  const focusItems = itemsByType('focus_session_completed');
  const activityItems = itemsByType('activity_logged');
  const workoutItems = itemsByType('workout_completed');
  const mealPreparedItems = itemsByType('meal_prepared');
  const mealConsumedItems = itemsByType('meal_consumed');
  const planStepItems = itemsByType('plan_step_completed');

  // Focus (live in runtime today).
  const focusSummary = summariseInstantActivity(focusItems, rawById, todayKey, last7, 'activity');
  const focus = {
    status: focusSummary.hasEvents ? 'data' : 'no-data',
    live: liveTypes.has('focus_session_completed'),
    today: focusSummary.today,
    last7Days: focusSummary.last7Days,
    allTime: focusSummary.allTime,
    latest: focusSummary.latest
  };

  // Free-form time / activity_logged (adapter exists, not wired into live runtime).
  const activitySummary = summariseInstantActivity(activityItems, rawById, todayKey, last7, 'activity');
  const time = {
    status: activitySummary.hasEvents
      ? 'data'
      : (liveTypes.has('activity_logged') ? 'no-data' : 'not-connected'),
    live: liveTypes.has('activity_logged'),
    today: activitySummary.today,
    last7Days: activitySummary.last7Days,
    allTime: activitySummary.allTime,
    latest: activitySummary.latest
  };

  // Learning.
  const learning = buildLearning(learningPlans, planStepItems, rawById, last7);

  // Capability / Career.
  const capability = buildCapability(capabilityProfile, ledgerEvents, generatedAt);

  // Workout (adapter exists, not wired into live runtime).
  const workoutWeek = workoutItems.filter(item => last7.has(item.dayKey));
  let workoutsWithKnownDuration = 0;
  let workoutKnownDurationMinutes = 0;
  for (const item of workoutItems) {
    const mins = roundMinutes(payloadOf(rawById, item).durationMinutes);
    if (mins != null && mins > 0) {
      workoutsWithKnownDuration += 1;
      workoutKnownDurationMinutes += mins;
    }
  }
  const latestWorkout = workoutItems.length ? workoutItems[workoutItems.length - 1] : null;
  const workoutLive = liveTypes.has('workout_completed');
  const workout = {
    status: workoutItems.length
      ? 'data'
      : (workoutLive ? 'no-data' : 'not-connected'),
    live: workoutLive,
    last7Days: { count: workoutWeek.length, dayCount: 7 },
    allTime: { count: workoutItems.length },
    latest: latestWorkout
      ? { ...occurrenceOf(latestWorkout), workoutName: latestWorkout.title }
      : null,
    duration: {
      workoutsWithKnownDuration,
      workoutsTotal: workoutItems.length,
      knownDurationMinutes: workoutKnownDurationMinutes
    }
  };

  // Meal (adapter exists, not wired into live runtime).
  const preparedWeek = mealPreparedItems.filter(item => last7.has(item.dayKey));
  const consumedWeek = mealConsumedItems.filter(item => last7.has(item.dayKey));
  const portionsConsumed7d = consumedWeek.reduce((total, item) => {
    const count = roundMinutes(payloadOf(rawById, item).portionCount);
    return total + (count != null && count > 0 ? count : 0);
  }, 0);
  const latestPrepared = mealPreparedItems.length ? mealPreparedItems[mealPreparedItems.length - 1] : null;
  const latestConsumed = mealConsumedItems.length ? mealConsumedItems[mealConsumedItems.length - 1] : null;
  const mealLive = liveTypes.has('meal_prepared') && liveTypes.has('meal_consumed');
  const mealHasEvents = mealPreparedItems.length > 0 || mealConsumedItems.length > 0;
  const meal = {
    status: mealHasEvents ? 'data' : (mealLive ? 'no-data' : 'not-connected'),
    live: mealLive,
    last7Days: {
      prepared: preparedWeek.length,
      consumed: consumedWeek.length,
      portionsConsumed: portionsConsumed7d,
      dayCount: 7
    },
    allTime: { prepared: mealPreparedItems.length, consumed: mealConsumedItems.length },
    latestPrepared: latestPrepared
      ? {
        mealName: mealName(payloadOf(rawById, latestPrepared)),
        preparedDate: latestPrepared.occurredDate
      }
      : null,
    latestConsumed: latestConsumed
      ? {
        mealName: mealName(payloadOf(rawById, latestConsumed)),
        consumedAt: latestConsumed.occurredAt,
        dayKey: latestConsumed.dayKey
      }
      : null
  };

  const coverage = {
    focus: domainCoverage(focusItems, liveTypes.has('focus_session_completed')),
    learning: domainCoverage(planStepItems, liveTypes.has('plan_step_completed')),
    time: domainCoverage(activityItems, liveTypes.has('activity_logged')),
    workout: domainCoverage(workoutItems, workoutLive),
    meal: domainCoverage([...mealPreparedItems, ...mealConsumedItems], mealLive),
    capability: {
      state: capability.status === 'data' ? 'active'
        : capability.status === 'unreadable' ? 'unreadable'
          : 'no-events-yet',
      live: true,
      hasProfile: capabilityProfile != null
    }
  };

  return {
    generatedAt,
    referenceTimeZone,
    todayKey,
    window: { last7DayKeys: Array.from(last7).sort() },
    focus,
    time,
    learning,
    capability,
    workout,
    meal,
    coverage,
    skippedLedgerEvents: feed.skipped.length
  };
}
