// node life-feed-model.test.js
//
// Unified Life Feed model tests (Phase 6 V1). Exercises the feed projection against events
// that have been through the REAL life-ledger-core.js accept pipeline (buildLifeFeed only
// ever sees stored, validated events in production), plus deliberately hostile inputs.
//
// Deliverable trace:
//   13 — feed-model tests (mixed sequences of all six event types)
//   14 — temporal chaos (midnight, timezones, equal occurredAt, recordedAt≠occurredAt, DST)
//   15 — mixed-life chaos day
//   16 — legacy / unknown event policy
//   19 — Obsidian parity (facts, not formatting)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLifeLedgerMemoryStore,
  fingerprintLifeLedgerEvent,
  upsertLifeLedgerEvent
} from './life-ledger-core.js';
import { buildObsidianLifeLedgerExport } from './obsidian-life-ledger-renderer.js';
import {
  buildLifeFeed,
  filterLifeFeed,
  compareFeedItems,
  LIFE_FEED_FILTERS
} from './life-feed-model.js';

const TZ = 'America/Phoenix'; // no DST — a stable default
const NOW = new Date('2026-08-31T12:00:00.000Z');
const FEED_OPTS = { now: NOW, referenceTimeZone: TZ };

// ── deterministic id + clock injection ───────────────────────────────────────────────────
let idCounter = 0;
function nextId() {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}
function clockAt(iso) {
  return () => iso;
}

function makeStore() {
  return createLifeLedgerMemoryStore();
}

// Push a draft through the real accept pipeline and return the stored event.
function ingest(store, draft, { recordedAt } = {}) {
  const result = upsertLifeLedgerEvent(store, draft, {
    createId: nextId,
    clock: clockAt(recordedAt || draft.payload.completedAt || draft.occurredAt || `${draft.occurredDate}T12:00:00.000Z`)
  });
  assert.ok(
    ['created', 'revised', 'tombstoned', 'restored', 'unchanged'].includes(result.action),
    `ingest rejected: ${JSON.stringify(result)}`
  );
  return result.event;
}

const INACTIVE_TOMBSTONE = { active: false, deletedAt: null, reason: null, provenance: null };

function provenance(kind, evidenceId) {
  return {
    source: kind === 'workout' ? 'workout' : kind === 'meal' ? 'meal' : 'chronasense',
    sourceRecordKind: `${kind}.record`,
    adapterVersion: 'test-v1',
    observedAt: '2026-08-31T00:00:00.000Z',
    evidence: [`${kind}.evidence:${evidenceId}`]
  };
}

// ── per-type valid drafts ────────────────────────────────────────────────────────────────
function activityDraft(o = {}) {
  const startedAt = o.startedAt || '2026-08-30T16:00:00.000Z';
  const endedAt = o.endedAt || '2026-08-30T16:45:00.000Z';
  return {
    schemaVersion: 1, sourceApp: 'chronasense', sourceEntityId: o.id || 'act-1',
    type: 'activity_logged', occurredAt: endedAt, sourceTimezone: o.tz || TZ,
    payload: {
      activity: o.activity || 'Deep work — Client automation',
      category: o.category || 'deep',
      startedAt, endedAt,
      durationMinutes: o.durationMinutes ?? 45
    },
    provenance: provenance('chronasense', o.id || 'act-1'),
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: INACTIVE_TOMBSTONE
  };
}

function focusDraft(o = {}) {
  const startedAt = o.startedAt || '2026-08-30T10:00:00.000Z';
  const endedAt = o.endedAt || '2026-08-30T10:32:00.000Z';
  return {
    schemaVersion: 1, sourceApp: 'chronasense', sourceEntityId: o.id || 'focus-1',
    type: 'focus_session_completed', occurredAt: endedAt, sourceTimezone: o.tz || TZ,
    payload: {
      activity: o.activity || 'Focus session',
      startedAt, endedAt, durationMinutes: o.durationMinutes ?? 32,
      additiveForTimeTotals: false
    },
    provenance: provenance('chronasense', o.id || 'focus-1'),
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: INACTIVE_TOMBSTONE
  };
}

function planStepDraft(o = {}) {
  const completedAt = o.completedAt || '2026-08-30T15:00:00.000Z';
  const payload = {
    planDate: o.planDate || '2026-08-30',
    stepLabel: o.stepLabel || 'Build first webhook',
    completedAt
  };
  if (o.source !== null) {
    payload.source = o.source || { planTitle: 'AI Automation Roadmap', lessonTitle: 'Webhooks' };
  }
  return {
    schemaVersion: 1, sourceApp: 'chronasense', sourceEntityId: o.id || 'plan-1:step-a',
    type: 'plan_step_completed', occurredAt: completedAt, sourceTimezone: o.tz || TZ,
    payload,
    provenance: provenance('chronasense', o.id || 'plan-step-a'),
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: INACTIVE_TOMBSTONE
  };
}

function workoutDraft(o = {}) {
  const startedAt = o.startedAt || '2026-08-30T18:00:00.000Z';
  const endedAt = o.endedAt || (o.unknownDuration ? startedAt : '2026-08-30T18:42:00.000Z');
  const payload = { workoutName: o.workoutName || 'Upper Body', startedAt, endedAt };
  if (!o.unknownDuration) payload.durationMinutes = o.durationMinutes ?? 42;
  if (o.exercises) payload.exercises = o.exercises;
  if (o.source) payload.source = o.source;
  return {
    schemaVersion: 1, sourceApp: 'workout', sourceEntityId: o.id || 'wk-1',
    type: 'workout_completed', occurredAt: endedAt, sourceTimezone: o.tz || TZ,
    payload,
    provenance: provenance('workout', o.id || 'wk-1'),
    confidence: { score: 0.95, basis: 'validated-workouts-collection-membership' },
    tombstone: INACTIVE_TOMBSTONE
  };
}

function mealPreparedDraft(o = {}) {
  const date = o.preparedDate || '2026-08-30';
  const payload = { mealName: o.mealName || 'Chicken Rice Bowl', preparedDate: date };
  if (o.portionsPrepared != null) payload.portionsPrepared = o.portionsPrepared;
  return {
    schemaVersion: 1, sourceApp: 'meal', sourceEntityId: o.id || 'cm-1',
    type: 'meal_prepared', occurredDate: date, temporalPrecision: 'date', sourceTimezone: o.tz || TZ,
    payload,
    provenance: provenance('meal', o.id || 'cm-1'),
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: INACTIVE_TOMBSTONE
  };
}

function mealConsumedDraft(o = {}) {
  const consumedAt = o.consumedAt || '2026-08-30T13:15:00.000Z';
  return {
    schemaVersion: 1, sourceApp: 'meal', sourceEntityId: o.id || 'mc-1',
    type: 'meal_consumed', occurredAt: consumedAt, sourceTimezone: o.tz || TZ,
    payload: {
      mealName: o.mealName || 'Chicken Rice Bowl',
      consumedAt,
      portionCount: o.portionCount ?? 1,
      cookedMealId: o.cookedMealId || 'cm-1'
    },
    provenance: provenance('meal', o.id || 'mc-1'),
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: INACTIVE_TOMBSTONE
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────

console.log('\nUnified Life Feed — domain mapping');

test('every supported type maps to a stable user-facing domain', () => {
  const store = makeStore();
  ingest(store, activityDraft());
  ingest(store, focusDraft());
  ingest(store, planStepDraft());
  ingest(store, workoutDraft());
  ingest(store, mealPreparedDraft());
  ingest(store, mealConsumedDraft());
  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);
  const byType = Object.fromEntries(feed.items.map(i => [i.type, i]));
  assert.equal(byType.activity_logged.domain, 'time');
  assert.equal(byType.focus_session_completed.domain, 'time');
  assert.equal(byType.plan_step_completed.domain, 'learning');
  assert.equal(byType.workout_completed.domain, 'workout');
  assert.equal(byType.meal_prepared.domain, 'meal');
  assert.equal(byType.meal_consumed.domain, 'meal');
  assert.equal(byType.meal_prepared.domainLabel, 'Meal');
  assert.equal(byType.plan_step_completed.domainLabel, 'Learning');
  // Implementation type names are never the primary label.
  assert.ok(!feed.items.some(i => i.domainLabel.includes('_')));
  assert.deepEqual(feed.counts, { all: 6, time: 2, learning: 1, workout: 1, meal: 2 });
});

console.log('\nUnified Life Feed — chronological ordering');

test('instant events sort ascending by occurredAt regardless of insertion order', () => {
  const store = makeStore();
  ingest(store, focusDraft({ id: 'f-late', startedAt: '2026-08-30T20:00:00.000Z', endedAt: '2026-08-30T20:20:00.000Z' }));
  ingest(store, focusDraft({ id: 'f-early', startedAt: '2026-08-30T08:00:00.000Z', endedAt: '2026-08-30T08:20:00.000Z' }));
  ingest(store, focusDraft({ id: 'f-mid', startedAt: '2026-08-30T14:00:00.000Z', endedAt: '2026-08-30T14:20:00.000Z' }));
  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);
  assert.deepEqual(feed.items.map(i => i.occurredAt), [
    '2026-08-30T08:20:00.000Z',
    '2026-08-30T14:20:00.000Z',
    '2026-08-30T20:20:00.000Z'
  ]);
});

test('a date-only event sorts just before the same calendar day\'s timed events, with no fabricated time', () => {
  const store = makeStore();
  ingest(store, mealConsumedDraft({ id: 'mc-am', consumedAt: '2026-08-30T08:15:00.000Z' }));
  ingest(store, mealPreparedDraft({ id: 'cm-x', preparedDate: '2026-08-30' }));
  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);
  assert.equal(feed.items[0].type, 'meal_prepared');
  assert.equal(feed.items[0].displayTime, null);
  assert.equal(feed.items[0].displayTimeRange, null);
  assert.equal(feed.items[0].temporalPrecision, 'date');
  assert.equal(feed.items[0].occurredAt, null);
  assert.equal(feed.items[0].occurredDate, '2026-08-30');
  assert.equal(feed.items[0].dayKey, '2026-08-30');
  assert.equal(feed.items[1].type, 'meal_consumed');
  // one day group, both events on it
  assert.equal(feed.days.length, 1);
  assert.equal(feed.days[0].items.length, 2);
});

test('deterministic tie-breaking: equal occurredAt is stable across input shuffles', () => {
  const build = order => {
    const store = makeStore();
    const drafts = {
      a: () => activityDraft({ id: 'a', startedAt: '2026-08-30T09:00:00.000Z', endedAt: '2026-08-30T12:00:00.000Z' }),
      w: () => workoutDraft({ id: 'w', startedAt: '2026-08-30T11:30:00.000Z', endedAt: '2026-08-30T12:00:00.000Z' }),
      m: () => mealConsumedDraft({ id: 'm', consumedAt: '2026-08-30T12:00:00.000Z' })
    };
    order.forEach(k => ingest(store, drafts[k]()));
    return buildLifeFeed(store.listEvents(), FEED_OPTS).items.map(i => i.type);
  };
  const first = build(['a', 'w', 'm']);
  const second = build(['m', 'w', 'a']);
  const third = build(['w', 'm', 'a']);
  // equal occurredAt -> deterministic type-then-eventId order, identical across shuffles
  assert.deepEqual(first, ['activity_logged', 'meal_consumed', 'workout_completed']);
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
  // comparator is a total order (antisymmetric)
  const store = makeStore();
  const items = buildLifeFeed(
    [activityDraft({ id: 'a', startedAt: '2026-08-30T09:00:00.000Z', endedAt: '2026-08-30T12:00:00.000Z' })]
      .map(d => ingest(store, d)),
    FEED_OPTS
  ).items;
  assert.equal(compareFeedItems(items[0], items[0]), 0);
});

test('date-only ties fall through to recordedAt then eventId — never a fabricated time', () => {
  const store = makeStore();
  const laterRecorded = ingest(store, mealPreparedDraft({ id: 'cm-a', preparedDate: '2026-08-30' }), { recordedAt: '2026-08-31T02:00:00.000Z' });
  const earlierRecorded = ingest(store, mealPreparedDraft({ id: 'cm-b', preparedDate: '2026-08-30' }), { recordedAt: '2026-08-31T01:00:00.000Z' });
  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);
  // cm-b was recorded earlier -> orders first
  assert.deepEqual(feed.items.map(i => i.eventId), [earlierRecorded.eventId, laterRecorded.eventId]);
  assert.equal(feed.items[0].displayTime, null);
  assert.equal(feed.items[1].displayTime, null);
});

console.log('\nUnified Life Feed — tombstone & revision');

test('tombstoned events never appear as current factual activity', () => {
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'plan-1:keep' }));
  ingest(store, planStepDraft({ id: 'plan-1:drop' }));
  // tombstone the second identity
  const dropDraft = planStepDraft({ id: 'plan-1:drop' });
  dropDraft.provenance.sourceOperation = 'delete';
  dropDraft.tombstone = {
    active: true,
    deletedAt: '2026-08-30T16:00:00.000Z',
    reason: 'user_delete',
    provenance: { sourceOperation: 'delete', sourceRecordKind: 'chronasense.plan_step', evidence: ['chronasense.plan_step:drop:reopened'] }
  };
  const res = upsertLifeLedgerEvent(store, dropDraft, { createId: nextId, clock: clockAt('2026-08-30T16:00:00.000Z') });
  assert.equal(res.action, 'tombstoned');

  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].title, 'Completed: Build first webhook');
  assert.equal(feed.counts.learning, 1);
  assert.equal(feed.counts.all, 1);
  assert.ok(!feed.skipped.some(s => s.reason === 'tombstoned'));
});

test('a revised event shows the current revision once — no duplicate historical facts', () => {
  const store = makeStore();
  ingest(store, activityDraft({ id: 'a-rev', activity: 'Original title' }));
  const revised = activityDraft({ id: 'a-rev', activity: 'Corrected title' });
  const res = upsertLifeLedgerEvent(store, revised, { createId: nextId, clock: clockAt('2026-08-31T09:00:00.000Z') });
  assert.equal(res.action, 'revised');

  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].title, 'Corrected title');
  assert.equal(feed.items[0].revision, 2);
});

test('duplicate eventIds in a raw list collapse to one feed item', () => {
  const store = makeStore();
  const stored = ingest(store, focusDraft({ id: 'dup' }));
  const feed = buildLifeFeed([stored, structuredClone(stored), structuredClone(stored)], FEED_OPTS);
  assert.equal(feed.items.length, 1);
});

console.log('\nUnified Life Feed — event rendering by type');

test('activity: title is the activity, duration shown when known', () => {
  const store = makeStore();
  ingest(store, activityDraft({ activity: 'Deep work — Client automation', durationMinutes: 45 }));
  const [item] = buildLifeFeed(store.listEvents(), FEED_OPTS).items;
  assert.equal(item.title, 'Deep work — Client automation');
  assert.ok(item.detail.includes('45 min'));
  assert.equal(item.displayTimeRange, '09:00–09:45'); // 16:00Z in America/Phoenix (UTC-7)
});

test('workout with unknown duration: no minutes, no "duration unknown", no fabricated range', () => {
  const store = makeStore();
  ingest(store, workoutDraft({ unknownDuration: true, exercises: [{ exerciseId: 'e1', mode: 'reps', sets: [{ load: 20, repetitions: 10 }, { load: 20, repetitions: 8 }] }] }));
  const [item] = buildLifeFeed(store.listEvents(), FEED_OPTS).items;
  assert.ok(!/min/.test(item.detail), item.detail);
  assert.ok(!/unknown/i.test(item.detail));
  assert.ok(item.detail.includes('2 sets'));
  assert.ok(item.detail.includes('1 exercise'));
  assert.equal(item.displayTimeRange, null);
  assert.equal(typeof item.displayTime, 'string');
});

test('workout with unknown weight unit: feed never assumes kg or lb', () => {
  const store = makeStore();
  ingest(store, workoutDraft({
    id: 'wk-unit', source: { workoutId: 'wk-unit', weightUnitContext: { authority: 'unknown' } },
    exercises: [{ exerciseId: 'e1', mode: 'reps', sets: [{ load: 40, repetitions: 5 }] }]
  }));
  const [item] = buildLifeFeed(store.listEvents(), FEED_OPTS).items;
  assert.ok(!/kg|lb/.test(item.detail), item.detail);
  assert.ok(!/kg|lb/.test(item.title));
});

test('missing optional fields degrade to an empty detail, never a guess', () => {
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'p-nosrc', source: null }));
  ingest(store, mealPreparedDraft({ id: 'cm-noport' }));
  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);
  const plan = feed.items.find(i => i.type === 'plan_step_completed');
  const meal = feed.items.find(i => i.type === 'meal_prepared');
  assert.equal(plan.detail, '');
  assert.equal(meal.detail, '');
  assert.equal(plan.title, 'Completed: Build first webhook');
  assert.equal(meal.title, 'Prepared Chicken Rice Bowl');
});

test('meal_prepared never renders a clock time; meal_consumed does', () => {
  const store = makeStore();
  ingest(store, mealPreparedDraft());
  ingest(store, mealConsumedDraft({ id: 'mc-2', consumedAt: '2026-08-30T13:15:00.000Z' }));
  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);
  const prepared = feed.items.find(i => i.type === 'meal_prepared');
  const consumed = feed.items.find(i => i.type === 'meal_consumed');
  assert.equal(prepared.displayTime, null);
  assert.match(consumed.displayTime, /^\d{2}:\d{2}$/);
});

console.log('\nUnified Life Feed — unicode / hostile content');

test('unicode, markdown and HTML-like content is carried as plain text and collapsed to one line', () => {
  const store = makeStore();
  ingest(store, activityDraft({
    id: 'weird',
    activity: 'Deep\twork  **bold** <script>alert(1)</script> — 日本語 🚀\nsecond line',
    startedAt: '2026-08-30T09:00:00.000Z', endedAt: '2026-08-30T09:30:00.000Z'
  }));
  const [item] = buildLifeFeed(store.listEvents(), FEED_OPTS).items;
  assert.ok(!item.title.includes('\n'));
  assert.ok(!item.title.includes('\t'));
  assert.ok(item.title.includes('日本語'));
  assert.ok(item.title.includes('🚀'));
  // model does not HTML-escape — that is the UI's job — but it must not crash or drop text
  assert.ok(item.title.includes('<script>'));
});

test('very long titles are preserved verbatim (UI truncates, model does not lie)', () => {
  const store = makeStore();
  const long = 'A'.repeat(180);
  ingest(store, activityDraft({ id: 'long', activity: long }));
  const [item] = buildLifeFeed(store.listEvents(), FEED_OPTS).items;
  assert.equal(item.title, long);
});

console.log('\nUnified Life Feed — unknown / legacy events');

test('an unsupported event type is skipped with a reason, never reinterpreted, and does not crash the feed', () => {
  const store = makeStore();
  const good = ingest(store, focusDraft({ id: 'ok' }));
  const future = {
    ...good,
    eventId: '00000000-0000-4000-8000-ffffffffffff',
    type: 'sleep_logged',
    payload: { hours: 7 }
  };
  const feed = buildLifeFeed([good, future], FEED_OPTS);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].type, 'focus_session_completed');
  assert.equal(feed.skipped.length, 1);
  assert.equal(feed.skipped[0].type, 'sleep_logged');
  assert.equal(feed.skipped[0].reason, 'unsupported_type');
});

test('structurally broken records are skipped, not thrown', () => {
  const feed = buildLifeFeed([
    null,
    { type: 'activity_logged' },
    { type: 'focus_session_completed', eventId: 'x', sourceTimezone: 'not/a/zone', payload: {} },
    'nonsense'
  ], FEED_OPTS);
  assert.equal(feed.items.length, 0);
  assert.equal(feed.skipped.length, 4);
  assert.ok(feed.isEmpty);
});

console.log('\nUnified Life Feed — Today / Recent / History grouping');

test('day headers resolve Today / Yesterday / dated, newest day first', () => {
  const store = makeStore();
  ingest(store, focusDraft({ id: 'd0', startedAt: '2026-08-31T15:00:00.000Z', endedAt: '2026-08-31T15:20:00.000Z' }));
  ingest(store, focusDraft({ id: 'd1', startedAt: '2026-08-30T15:00:00.000Z', endedAt: '2026-08-30T15:20:00.000Z' }));
  ingest(store, focusDraft({ id: 'd7', startedAt: '2026-08-24T15:00:00.000Z', endedAt: '2026-08-24T15:20:00.000Z' }));
  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);
  assert.deepEqual(feed.days.map(d => d.dayKey), ['2026-08-31', '2026-08-30', '2026-08-24']);
  assert.equal(feed.days[0].label, 'Today');
  assert.equal(feed.days[0].isToday, true);
  assert.equal(feed.days[1].label, 'Yesterday');
  assert.match(feed.days[2].label, /Aug 24/);
});

console.log('\nUnified Life Feed — filtering');

test('filterLifeFeed narrows to a single domain and keeps pre-filter counts', () => {
  const store = makeStore();
  ingest(store, activityDraft());
  ingest(store, workoutDraft());
  ingest(store, mealConsumedDraft());
  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);

  const workoutOnly = filterLifeFeed(feed, 'workout');
  assert.equal(workoutOnly.items.length, 1);
  assert.ok(workoutOnly.items.every(i => i.domain === 'workout'));
  assert.deepEqual(workoutOnly.counts, feed.counts);
  assert.equal(workoutOnly.activeDomain, 'workout');
  assert.equal(workoutOnly.isEmpty, false);

  const learningOnly = filterLifeFeed(feed, 'learning');
  assert.equal(learningOnly.items.length, 0);
  assert.equal(learningOnly.isEmpty, true);
  assert.equal(learningOnly.days.length, 0);

  const all = filterLifeFeed(feed, 'all');
  assert.equal(all.items.length, 3);
  assert.equal(all.activeDomain, 'all');

  const bogus = filterLifeFeed(feed, 'nope');
  assert.equal(bogus.activeDomain, 'all');
  assert.deepEqual(LIFE_FEED_FILTERS, ['all', 'time', 'learning', 'workout', 'meal']);
});

console.log('\nUnified Life Feed — empty states');

test('an empty ledger produces an empty, non-crashing feed', () => {
  const feed = buildLifeFeed([], FEED_OPTS);
  assert.equal(feed.isEmpty, true);
  assert.deepEqual(feed.days, []);
  assert.deepEqual(feed.counts, { all: 0, time: 0, learning: 0, workout: 0, meal: 0 });
  assert.deepEqual(feed.skipped, []);
});

console.log('\nUnified Life Feed — data safety');

test('buildLifeFeed does not mutate its input events', () => {
  const store = makeStore();
  ingest(store, activityDraft());
  ingest(store, mealPreparedDraft());
  const events = store.listEvents();
  const snapshot = JSON.stringify(events);
  const frozen = events.map(e => Object.freeze(e));
  assert.doesNotThrow(() => buildLifeFeed(frozen, FEED_OPTS));
  assert.equal(JSON.stringify(events), snapshot);
});

console.log('\nUnified Life Feed — temporal chaos (Deliverable 14)');

test('instant events around midnight land on the correct source-local calendar day', () => {
  const store = makeStore();
  // 2026-08-30 23:50 America/New_York == 2026-08-31 03:50Z
  ingest(store, focusDraft({ id: 'before', tz: 'America/New_York', startedAt: '2026-08-31T03:40:00.000Z', endedAt: '2026-08-31T03:50:00.000Z' }));
  // 2026-08-31 00:10 America/New_York == 2026-08-31 04:10Z
  ingest(store, focusDraft({ id: 'after', tz: 'America/New_York', startedAt: '2026-08-31T04:05:00.000Z', endedAt: '2026-08-31T04:10:00.000Z' }));
  const feed = buildLifeFeed(store.listEvents(), { now: NOW, referenceTimeZone: 'America/New_York' });
  const days = Object.fromEntries(feed.days.map(d => [d.dayKey, d.items.map(i => i.eventId)]));
  assert.ok(days['2026-08-30']);
  assert.ok(days['2026-08-31']);
});

test('meal consumed shortly after midnight is filed on the new day', () => {
  const store = makeStore();
  ingest(store, mealConsumedDraft({ id: 'mc-midnight', tz: 'America/New_York', consumedAt: '2026-08-31T04:10:00.000Z' }));
  const feed = buildLifeFeed(store.listEvents(), { now: NOW, referenceTimeZone: 'America/New_York' });
  assert.equal(feed.items[0].dayKey, '2026-08-31');
});

test('recordedAt / revisedAt far from occurredAt never reorder instant history', () => {
  const store = makeStore();
  // earlier occurrence, but recorded LAST
  ingest(store, focusDraft({ id: 'occ-early', startedAt: '2026-08-30T08:00:00.000Z', endedAt: '2026-08-30T08:30:00.000Z' }), { recordedAt: '2026-08-31T23:00:00.000Z' });
  // later occurrence, recorded FIRST
  ingest(store, focusDraft({ id: 'occ-late', startedAt: '2026-08-30T20:00:00.000Z', endedAt: '2026-08-30T20:30:00.000Z' }), { recordedAt: '2026-08-30T06:00:00.000Z' });
  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);
  assert.deepEqual(feed.items.map(i => i.occurredAt), ['2026-08-30T08:30:00.000Z', '2026-08-30T20:30:00.000Z']);
});

test('multiple source timezones each group by their own local calendar day', () => {
  const store = makeStore();
  // same instant, different zones -> can be different local days
  ingest(store, focusDraft({ id: 'tokyo', tz: 'Asia/Tokyo', startedAt: '2026-08-30T15:30:00.000Z', endedAt: '2026-08-30T16:00:00.000Z' }));
  ingest(store, focusDraft({ id: 'la', tz: 'America/Los_Angeles', startedAt: '2026-08-30T15:30:00.000Z', endedAt: '2026-08-30T16:00:00.000Z' }));
  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);
  const tokyo = feed.items.find(i => i.eventId.endsWith('1') || i.sourceTimezone === 'Asia/Tokyo');
  const la = feed.items.find(i => i.sourceTimezone === 'America/Los_Angeles');
  assert.equal(tokyo.dayKey, '2026-08-31'); // 00:30 next day in Tokyo
  assert.equal(la.dayKey, '2026-08-30'); // 08:30 same day in LA
});

test('a DST-boundary instant derives a day and time without throwing', () => {
  const store = makeStore();
  // US spring-forward 2026-03-08 02:00 -> 03:00 America/New_York; 07:30Z is in the gap area
  ingest(store, focusDraft({ id: 'dst', tz: 'America/New_York', startedAt: '2026-03-08T07:00:00.000Z', endedAt: '2026-03-08T07:30:00.000Z' }));
  const feed = buildLifeFeed(store.listEvents(), { now: NOW, referenceTimeZone: 'America/New_York' });
  assert.equal(feed.items[0].dayKey, '2026-03-08');
  assert.match(feed.items[0].displayTime, /^\d{2}:\d{2}$/);
});

test('imported workout with equal start and end is treated as unknown-duration, single time', () => {
  const store = makeStore();
  ingest(store, workoutDraft({ id: 'wk-eq', unknownDuration: true, startedAt: '2026-08-30T18:00:00.000Z' }));
  const [item] = buildLifeFeed(store.listEvents(), FEED_OPTS).items;
  assert.equal(item.displayTimeRange, null);
  assert.equal(item.displayTime, '11:00'); // 18:00Z in America/Phoenix (UTC-7)
});

console.log('\nUnified Life Feed — mixed-life chaos day (Deliverable 15)');

test('a realistic mixed day: all facts appear once, correct domains, one day, deterministic order, filters preserve subsets', () => {
  const store = makeStore();
  // source-local America/Phoenix (UTC-7): pick UTC instants that map to the stated wall times on 2026-08-30
  ingest(store, mealConsumedDraft({ id: 'mix-mc', consumedAt: '2026-08-30T15:15:00.000Z' }));        // 08:15
  ingest(store, activityDraft({ id: 'mix-act', startedAt: '2026-08-30T16:00:00.000Z', endedAt: '2026-08-30T16:45:00.000Z' })); // 09:00
  ingest(store, focusDraft({ id: 'mix-focus', startedAt: '2026-08-30T17:00:00.000Z', endedAt: '2026-08-30T17:32:00.000Z' }));   // 10:00
  ingest(store, planStepDraft({ id: 'mix-plan', completedAt: '2026-08-30T17:35:00.000Z' }));          // 10:35
  ingest(store, workoutDraft({ id: 'mix-wk', startedAt: '2026-08-31T01:00:00.000Z', endedAt: '2026-08-31T01:42:00.000Z' }));    // 18:00
  ingest(store, mealPreparedDraft({ id: 'mix-prep', preparedDate: '2026-08-30' }));                    // date-only

  const feed = buildLifeFeed(store.listEvents(), FEED_OPTS);

  assert.equal(feed.items.length, 6);
  assert.equal(new Set(feed.items.map(i => i.eventId)).size, 6);
  assert.equal(feed.days.length, 1);
  assert.equal(feed.days[0].dayKey, '2026-08-30');
  assert.deepEqual(feed.days[0].items.map(i => i.type), [
    'meal_prepared',        // date-only sorts first
    'meal_consumed',        // 08:15
    'activity_logged',      // 09:00
    'focus_session_completed', // 10:00
    'plan_step_completed',  // 10:35
    'workout_completed'     // 18:00
  ]);
  assert.equal(feed.days[0].items[0].displayTime, null);
  assert.deepEqual(feed.counts, { all: 6, time: 2, learning: 1, workout: 1, meal: 2 });

  assert.equal(filterLifeFeed(feed, 'time').items.length, 2);
  assert.equal(filterLifeFeed(feed, 'meal').items.length, 2);
  assert.equal(filterLifeFeed(feed, 'learning').items.length, 1);
  assert.equal(filterLifeFeed(feed, 'workout').items.length, 1);
  assert.equal(filterLifeFeed(feed, 'meal').items.filter(i => i.displayTime === null).length, 1);

  // determinism: rebuild from reversed input
  const store2 = makeStore();
  [...store.listEvents()].reverse().forEach(e => {
    const r = upsertLifeLedgerEvent(store2, stripStoredFields(e), { createId: () => e.eventId, clock: clockAt(e.recordedAt) });
    assert.ok(r.action === 'created');
  });
  const feed2 = buildLifeFeed(store2.listEvents(), FEED_OPTS);
  assert.deepEqual(feed2.days[0].items.map(i => i.eventId), feed.days[0].items.map(i => i.eventId));
});

function stripStoredFields(event) {
  const copy = structuredClone(event);
  delete copy.eventId;
  delete copy.recordedAt;
  delete copy.revision;
  delete copy.revisedAt;
  return copy;
}

console.log('\nUnified Life Feed — large history (Deliverable R)');

test('thousands of events build quickly and stay sorted', () => {
  const store = makeStore();
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < 3000; i++) {
    const start = new Date(base + i * 37 * 60000).toISOString();
    const end = new Date(base + i * 37 * 60000 + 20 * 60000).toISOString();
    ingest(store, focusDraft({ id: `bulk-${i}`, startedAt: start, endedAt: end }));
  }
  const events = store.listEvents();
  const t0 = Date.now();
  const feed = buildLifeFeed(events, FEED_OPTS);
  const elapsed = Date.now() - t0;
  assert.equal(feed.counts.all, 3000);
  for (let i = 1; i < feed.items.length; i++) {
    assert.ok(feed.items[i - 1]._sortKey <= feed.items[i]._sortKey);
  }
  assert.ok(elapsed < 1500, `feed build took ${elapsed}ms`);
});

console.log('\nUnified Life Feed — Obsidian parity (Deliverable 19)');

test('feed and Obsidian renderer agree on facts: identity, day, tombstone exclusion, date precision', () => {
  const store = makeStore();
  ingest(store, activityDraft({ id: 'par-act', startedAt: '2026-08-30T16:00:00.000Z', endedAt: '2026-08-30T16:30:00.000Z' }));
  ingest(store, focusDraft({ id: 'par-focus', startedAt: '2026-08-30T17:00:00.000Z', endedAt: '2026-08-30T17:25:00.000Z' }));
  ingest(store, planStepDraft({ id: 'par-plan', completedAt: '2026-08-30T18:00:00.000Z' }));
  ingest(store, workoutDraft({ id: 'par-wk', startedAt: '2026-08-31T01:00:00.000Z', endedAt: '2026-08-31T01:40:00.000Z' }));
  ingest(store, mealPreparedDraft({ id: 'par-prep', preparedDate: '2026-08-29' }));
  ingest(store, mealConsumedDraft({ id: 'par-mc', consumedAt: '2026-08-30T20:00:00.000Z' }));
  // a tombstoned one that must appear in neither
  const drop = focusDraft({ id: 'par-drop' });
  ingest(store, drop);
  const dropT = focusDraft({ id: 'par-drop' });
  dropT.provenance.sourceOperation = 'delete';
  dropT.tombstone = { active: true, deletedAt: '2026-08-30T19:00:00.000Z', reason: 'user_delete', provenance: { sourceOperation: 'delete', sourceRecordKind: 'chronasense.record', evidence: ['x:y'] } };
  upsertLifeLedgerEvent(store, dropT, { createId: nextId, clock: clockAt('2026-08-30T19:00:00.000Z') });

  const events = store.listEvents();
  const feed = buildLifeFeed(events, FEED_OPTS);
  const { files } = buildObsidianLifeLedgerExport(events);

  // day -> set(eventId) from Obsidian markers
  const obsidianByDay = {};
  for (const file of files) {
    const match = file.relativePath.match(/Daily\/(\d{4}-\d{2}-\d{2})\.md$/);
    if (!match) continue;
    const ids = [...file.content.matchAll(/life-ledger:event:([0-9a-f-]+)/g)].map(m => m[1]);
    obsidianByDay[match[1]] = new Set(ids);
  }
  const feedByDay = Object.fromEntries(feed.days.map(d => [d.dayKey, new Set(d.items.map(i => i.eventId))]));

  assert.deepEqual(Object.keys(feedByDay).sort(), Object.keys(obsidianByDay).sort());
  for (const day of Object.keys(feedByDay)) {
    assert.deepEqual([...feedByDay[day]].sort(), [...obsidianByDay[day]].sort(), `day ${day} identity mismatch`);
  }
  // tombstoned id in neither
  const allFeedIds = new Set(feed.items.map(i => i.eventId));
  assert.ok(![...allFeedIds].some(id => feed.skipped.map(s => s.eventId).includes(id)));
  // date-only meal_prepared: no time in the feed, filed under its occurredDate
  const prep = feed.items.find(i => i.type === 'meal_prepared');
  assert.equal(prep.displayTime, null);
  assert.equal(prep.dayKey, '2026-08-29');
});
