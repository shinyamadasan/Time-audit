// node life-character-sheet-model.test.js
//
// Life Character Sheet model tests (Phase 7 V1). Exercises buildLifeCharacterSheet() against
// events that have been through the REAL life-ledger-core.js accept pipeline, real learning
// plans built through learning-plan-model.js, and real Capability profiles — plus deliberately
// hostile inputs.
//
// Deliverable trace:
//   24 — model tests (focus / learning / workout / meal / capability / cross-domain)
//   25 — temporal chaos (midnight, timezones, DST, date-only meal prep, revised, tombstone)
//   26 — coverage chaos (learning+focus only / +workout fixture / +meal / none / tombstoned-only / malformed)
//   27 — Life Feed parity
//   28 — Learning / Capability parity
//   29 — read-only guarantee (pure function; inputs never mutated)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createLifeLedgerMemoryStore, upsertLifeLedgerEvent } from './life-ledger-core.js';
import { buildLifeFeed } from './life-feed-model.js';
import {
  createLearningPlan, addPhase, addLesson, addStep, completeStep
} from './learning-plan-model.js';
import { getLearningPlanProgress } from './learning-plan-model.js';
import { findNextLearningPlanStep } from './learning-plan-next-action.js';
import { createEmptyCapabilityProfile } from './capability-career-model.js';
import { analyzeCapabilityCareer } from './capability-career-analytics.js';
import { buildLifeCharacterSheet } from './life-character-sheet-model.js';

const TZ = 'America/Phoenix'; // no DST — stable default
const NOW = new Date('2026-08-31T18:00:00.000Z'); // 2026-08-31 11:00 in Phoenix
const OPTS = { now: NOW, referenceTimeZone: TZ };

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, '0')}`;
}
function clockAt(iso) { return () => iso; }

function makeStore() { return createLifeLedgerMemoryStore(); }

function ingest(store, draft, { recordedAt } = {}) {
  const result = upsertLifeLedgerEvent(store, draft, {
    createId: nextId,
    clock: clockAt(recordedAt || draft.payload.completedAt || draft.payload.consumedAt || draft.occurredAt || `${draft.occurredDate}T12:00:00.000Z`)
  });
  assert.ok(
    ['created', 'revised', 'tombstoned', 'restored', 'unchanged'].includes(result.action),
    `ingest rejected: ${JSON.stringify(result)}`
  );
  return result.event;
}

const INACTIVE_TOMBSTONE = { active: false, deletedAt: null, reason: null, provenance: null };
function provenance(kind, id) {
  return {
    source: kind === 'workout' ? 'workout' : kind === 'meal' ? 'meal' : 'chronasense',
    sourceRecordKind: `${kind}.record`,
    adapterVersion: 'test-v1',
    observedAt: '2026-08-31T00:00:00.000Z',
    evidence: [`${kind}.evidence:${id}`]
  };
}

function focusDraft(o = {}) {
  const startedAt = o.startedAt || '2026-08-31T15:00:00.000Z';
  const endedAt = o.endedAt || '2026-08-31T15:30:00.000Z';
  return {
    schemaVersion: 1, sourceApp: 'chronasense', sourceEntityId: o.id || 'focus-1',
    type: 'focus_session_completed', occurredAt: endedAt, sourceTimezone: o.tz || TZ,
    payload: {
      activity: o.activity || 'Focus session',
      startedAt, endedAt, durationMinutes: o.durationMinutes ?? 30,
      additiveForTimeTotals: false
    },
    provenance: provenance('chronasense', o.id || 'focus-1'),
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: o.tombstone || INACTIVE_TOMBSTONE
  };
}

function activityDraft(o = {}) {
  const startedAt = o.startedAt || '2026-08-31T12:00:00.000Z';
  const endedAt = o.endedAt || '2026-08-31T13:00:00.000Z';
  return {
    schemaVersion: 1, sourceApp: 'chronasense', sourceEntityId: o.id || 'act-1',
    type: 'activity_logged', occurredAt: endedAt, sourceTimezone: o.tz || TZ,
    payload: {
      activity: o.activity || 'Deep work', category: o.category || 'deep',
      startedAt, endedAt, durationMinutes: o.durationMinutes ?? 60
    },
    provenance: provenance('chronasense', o.id || 'act-1'),
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: INACTIVE_TOMBSTONE
  };
}

function planStepDraft(o = {}) {
  const completedAt = o.completedAt || '2026-08-31T16:00:00.000Z';
  const payload = {
    planDate: o.planDate || '2026-08-31',
    stepLabel: o.stepLabel || 'Build first webhook',
    completedAt
  };
  if (o.source !== null) payload.source = o.source || { planId: 'plan-a', planTitle: 'AI Automation Roadmap', lessonTitle: 'Webhooks' };
  return {
    schemaVersion: 1, sourceApp: 'chronasense', sourceEntityId: o.id || 'plan-a:step-a',
    type: 'plan_step_completed', occurredAt: completedAt, sourceTimezone: o.tz || TZ,
    payload,
    provenance: provenance('chronasense', o.id || 'plan-step-a'),
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: o.tombstone || INACTIVE_TOMBSTONE
  };
}

function workoutDraft(o = {}) {
  const startedAt = o.startedAt || '2026-08-30T18:00:00.000Z';
  const endedAt = o.endedAt || (o.unknownDuration ? startedAt : '2026-08-30T18:45:00.000Z');
  const payload = { workoutName: o.workoutName || 'Upper Body', startedAt, endedAt };
  if (!o.unknownDuration) payload.durationMinutes = o.durationMinutes ?? 45;
  return {
    schemaVersion: 1, sourceApp: 'workout', sourceEntityId: o.id || 'wk-1',
    type: 'workout_completed', occurredAt: endedAt, sourceTimezone: o.tz || TZ,
    payload,
    provenance: provenance('workout', o.id || 'wk-1'),
    confidence: { score: 0.95, basis: 'validated-workouts-collection-membership' },
    tombstone: o.tombstone || INACTIVE_TOMBSTONE
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
    tombstone: o.tombstone || INACTIVE_TOMBSTONE
  };
}

function mealConsumedDraft(o = {}) {
  const consumedAt = o.consumedAt || '2026-08-31T13:15:00.000Z';
  return {
    schemaVersion: 1, sourceApp: 'meal', sourceEntityId: o.id || 'mc-1',
    type: 'meal_consumed', occurredAt: consumedAt, sourceTimezone: o.tz || TZ,
    payload: {
      mealName: o.mealName || 'Chicken Rice Bowl', consumedAt,
      portionCount: o.portionCount ?? 1, cookedMealId: o.cookedMealId || 'cm-1'
    },
    provenance: provenance('meal', o.id || 'mc-1'),
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: o.tombstone || INACTIVE_TOMBSTONE
  };
}

const PLAN_OPTS = { idGenerator: nextId, clock: clockAt('2026-08-20T00:00:00.000Z') };
function samplePlan(o = {}) {
  let plan = createLearningPlan({ title: o.title || 'AI Automation Roadmap' }, { ...PLAN_OPTS, clock: clockAt(o.createdAt || '2026-08-20T00:00:00.000Z') });
  plan = { ...plan, id: o.id || plan.id };
  plan = addPhase(plan, { title: 'Phase 1' }, PLAN_OPTS);
  const phaseId = plan.phases[0].id;
  plan = addLesson(plan, phaseId, { title: 'Webhooks' }, PLAN_OPTS);
  const lessonId = plan.phases[0].lessons[0].id;
  const stepCount = o.stepCount ?? 4;
  for (let i = 0; i < stepCount; i += 1) plan = addStep(plan, lessonId, { title: `Step ${i + 1}` }, PLAN_OPTS);
  const complete = o.completeSteps ?? 0;
  for (let i = 0; i < complete; i += 1) {
    const stepId = plan.phases[0].lessons[0].steps[i].id;
    plan = completeStep(plan, stepId, { ...PLAN_OPTS, clock: clockAt(`2026-08-2${5 + i}T12:00:00.000Z`) });
  }
  plan = { ...plan, updatedAt: o.updatedAt || plan.updatedAt };
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\nLife Character Sheet — FOCUS');

test('focus today / last-7-days counts and minutes use factual occurrence day', () => {
  const store = makeStore();
  // today (Phoenix 2026-08-31): two sessions
  ingest(store, focusDraft({ id: 'f1', startedAt: '2026-08-31T15:00:00.000Z', endedAt: '2026-08-31T15:25:00.000Z', durationMinutes: 25 }));
  ingest(store, focusDraft({ id: 'f2', startedAt: '2026-08-31T17:00:00.000Z', endedAt: '2026-08-31T17:40:00.000Z', durationMinutes: 40 }));
  // 3 days ago
  ingest(store, focusDraft({ id: 'f3', startedAt: '2026-08-28T15:00:00.000Z', endedAt: '2026-08-28T15:30:00.000Z', durationMinutes: 30 }));
  // 20 days ago — outside the week window
  ingest(store, focusDraft({ id: 'f4', startedAt: '2026-08-11T15:00:00.000Z', endedAt: '2026-08-11T15:30:00.000Z', durationMinutes: 30 }));

  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), ...OPTS });
  assert.equal(sheet.focus.status, 'data');
  assert.deepEqual(sheet.focus.today, { sessions: 2, minutes: 65 });
  assert.deepEqual(sheet.focus.last7Days, { sessions: 3, minutes: 95, dayCount: 7 });
  assert.equal(sheet.focus.allTime.sessions, 4);
  assert.equal(sheet.focus.latest.occurredAt, '2026-08-31T17:40:00.000Z');
  assert.equal(sheet.focus.latest.minutes, 40);
});

test('no focus events → no-data, not a misleading zero, and coverage says no-events-yet', () => {
  const sheet = buildLifeCharacterSheet({ ledgerEvents: [], ...OPTS });
  assert.equal(sheet.focus.status, 'no-data');
  assert.equal(sheet.focus.latest, null);
  assert.equal(sheet.coverage.focus.state, 'no-events-yet');
  assert.equal(sheet.coverage.focus.live, true);
});

test('a focus session recorded just before local midnight lands on the right day', () => {
  const store = makeStore();
  // 2026-08-31 23:50 Phoenix == 2026-09-01 06:50Z
  ingest(store, focusDraft({ id: 'fmid', startedAt: '2026-09-01T06:20:00.000Z', endedAt: '2026-09-01T06:50:00.000Z', tz: TZ }));
  const atMidnight = new Date('2026-09-01T06:55:00.000Z'); // still 2026-08-31 in Phoenix
  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), now: atMidnight, referenceTimeZone: TZ });
  assert.equal(sheet.todayKey, '2026-08-31');
  assert.equal(sheet.focus.today.sessions, 1);
});

test('focus source-local day is used even when the reference zone differs', () => {
  const store = makeStore();
  // event in Tokyo; 2026-08-31T16:00Z == 2026-09-01 01:00 Tokyo
  ingest(store, focusDraft({ id: 'ftok', startedAt: '2026-08-31T15:30:00.000Z', endedAt: '2026-08-31T16:00:00.000Z', tz: 'Asia/Tokyo' }));
  const feed = buildLifeFeed(store.listEvents(), { now: NOW, referenceTimeZone: TZ });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), ...OPTS });
  // parity: the sheet buckets the event on the same day the feed does
  assert.equal(feed.items[0].dayKey, '2026-09-01');
  assert.equal(sheet.focus.latest.dayKey, '2026-09-01');
});

// ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\nLife Character Sheet — LEARNING');

test('no plans → status no-plans, but ledger completion facts still surface', () => {
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'p:s', stepLabel: 'Ship webhook', completedAt: '2026-08-31T16:00:00.000Z' }));
  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), learningPlans: [], ...OPTS });
  assert.equal(sheet.learning.status, 'no-plans');
  assert.equal(sheet.learning.activePlan, null);
  assert.equal(sheet.learning.latestCompletedStep.stepLabel, 'Ship webhook');
  assert.equal(sheet.learning.recentCompletions7d, 1);
});

test('active plan: progress, next unfinished step, completion state', () => {
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 2 });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: [], learningPlans: [plan], ...OPTS });
  assert.equal(sheet.learning.status, 'data');
  assert.equal(sheet.learning.planCount, 1);
  assert.equal(sheet.learning.activePlan.title, 'AI Automation Roadmap');
  assert.equal(sheet.learning.activePlan.totalSteps, 4);
  assert.equal(sheet.learning.activePlan.completedSteps, 2);
  assert.equal(sheet.learning.activePlan.completionPercent, 50);
  assert.equal(sheet.learning.activePlan.isComplete, false);
  assert.equal(sheet.learning.activePlan.nextStep.stepTitle, 'Step 3');
});

test('a fully completed plan reports isComplete and a null next step', () => {
  const plan = samplePlan({ id: 'plan-done', stepCount: 3, completeSteps: 3 });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: [], learningPlans: [plan], ...OPTS });
  assert.equal(sheet.learning.activePlan.isComplete, true);
  assert.equal(sheet.learning.activePlan.nextStep, null);
});

test('active plan is chosen by the most recent ledger completion, not array order', () => {
  const planA = samplePlan({ id: 'plan-a', title: 'Plan A', stepCount: 3, completeSteps: 1, updatedAt: '2026-08-21T00:00:00.000Z' });
  const planB = samplePlan({ id: 'plan-b', title: 'Plan B', stepCount: 3, completeSteps: 0, updatedAt: '2026-08-20T00:00:00.000Z' });
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'plan-b:s1', stepLabel: 'B step', completedAt: '2026-08-31T10:00:00.000Z', source: { planId: 'plan-b', planTitle: 'Plan B' } }));
  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), learningPlans: [planA, planB], ...OPTS });
  assert.equal(sheet.learning.activePlan.title, 'Plan B');
});

test('with no completions the active plan falls back to most recently updated', () => {
  const planA = samplePlan({ id: 'plan-a', title: 'Plan A', updatedAt: '2026-08-21T00:00:00.000Z' });
  const planB = samplePlan({ id: 'plan-b', title: 'Plan B', updatedAt: '2026-08-29T00:00:00.000Z' });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: [], learningPlans: [planA, planB], ...OPTS });
  assert.equal(sheet.learning.activePlan.title, 'Plan B');
  assert.equal(sheet.learning.planCount, 2);
});

test('learning parity: sheet progress equals getLearningPlanProgress / findNextLearningPlanStep', () => {
  const plan = samplePlan({ id: 'plan-a', stepCount: 5, completeSteps: 3 });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: [], learningPlans: [plan], ...OPTS });
  const progress = getLearningPlanProgress(plan);
  const next = findNextLearningPlanStep(plan);
  assert.equal(sheet.learning.activePlan.completedSteps, progress.completedSteps);
  assert.equal(sheet.learning.activePlan.totalSteps, progress.totalSteps);
  assert.equal(sheet.learning.activePlan.completionPercent, progress.completionPercent);
  assert.equal(sheet.learning.activePlan.nextStep.stepTitle, next.stepTitle);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\nLife Character Sheet — WORKOUT');

test('no workout ingestion → not-connected, never "0 workouts this week"', () => {
  const sheet = buildLifeCharacterSheet({ ledgerEvents: [], ...OPTS });
  assert.equal(sheet.workout.status, 'not-connected');
  assert.equal(sheet.workout.live, false);
  assert.equal(sheet.workout.latest, null);
  assert.equal(sheet.coverage.workout.state, 'not-connected');
});

test('supplied workout events → data, latest workout, 7-day count, known-duration total', () => {
  const store = makeStore();
  ingest(store, workoutDraft({ id: 'w1', startedAt: '2026-08-30T18:00:00.000Z', endedAt: '2026-08-30T18:45:00.000Z', durationMinutes: 45 }));
  ingest(store, workoutDraft({ id: 'w2', startedAt: '2026-08-27T18:00:00.000Z', endedAt: '2026-08-27T18:30:00.000Z', durationMinutes: 30 }));
  ingest(store, workoutDraft({ id: 'w3', unknownDuration: true, startedAt: '2026-08-26T18:00:00.000Z', workoutName: 'Mystery session' }));
  ingest(store, workoutDraft({ id: 'w-old', startedAt: '2026-07-01T18:00:00.000Z', endedAt: '2026-07-01T18:45:00.000Z', durationMinutes: 45 }));

  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), ...OPTS });
  assert.equal(sheet.workout.status, 'data');
  assert.equal(sheet.workout.last7Days.count, 3);
  assert.equal(sheet.workout.allTime.count, 4);
  assert.equal(sheet.workout.latest.workoutName, 'Upper Body');
  assert.equal(sheet.workout.latest.dayKey, '2026-08-30');
  // unknown duration is NOT counted as zero
  assert.equal(sheet.workout.duration.workoutsWithKnownDuration, 3);
  assert.equal(sheet.workout.duration.workoutsTotal, 4);
  assert.equal(sheet.workout.duration.knownDurationMinutes, 120);
  assert.equal(sheet.coverage.workout.state, 'loaded-not-live');
});

test('a tombstoned workout is excluded (Feed parity)', () => {
  const store = makeStore();
  const created = ingest(store, workoutDraft({ id: 'w1', workoutName: 'Real session' }));
  ingest(store, {
    ...workoutDraft({ id: 'w1', workoutName: 'Real session' }),
    provenance: { ...provenance('workout', 'w1'), sourceOperation: 'delete' },
    tombstone: {
      active: true, deletedAt: '2026-08-31T00:00:00.000Z', reason: 'user_delete',
      provenance: { sourceOperation: 'delete', sourceRecordKind: 'workout.record', evidence: ['workout.evidence:w1:deleted'] }
    }
  });
  const events = store.listEvents();
  const sheet = buildLifeCharacterSheet({ ledgerEvents: events, ...OPTS });
  const feed = buildLifeFeed(events, { now: NOW, referenceTimeZone: TZ });
  assert.equal(feed.counts.workout, 0);
  assert.equal(sheet.workout.allTime.count, 0);
  assert.equal(sheet.workout.status, 'not-connected');
  assert.ok(created.eventId);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\nLife Character Sheet — MEAL');

test('no meal ingestion → not-connected, never "0 meals eaten"', () => {
  const sheet = buildLifeCharacterSheet({ ledgerEvents: [], ...OPTS });
  assert.equal(sheet.meal.status, 'not-connected');
  assert.equal(sheet.meal.latestPrepared, null);
  assert.equal(sheet.meal.latestConsumed, null);
});

test('date-only preparation stays on its calendar date; consumption keeps its instant', () => {
  const store = makeStore();
  ingest(store, mealPreparedDraft({ id: 'cm-1', preparedDate: '2026-08-30', mealName: 'Overnight Oats', portionsPrepared: 4 }));
  ingest(store, mealConsumedDraft({ id: 'mc-1', consumedAt: '2026-08-31T13:15:00.000Z', mealName: 'Overnight Oats', portionCount: 2, cookedMealId: 'cm-1' }));
  ingest(store, mealConsumedDraft({ id: 'mc-2', consumedAt: '2026-08-29T12:00:00.000Z', mealName: 'Salad', portionCount: 1, cookedMealId: 'cm-1' }));

  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), ...OPTS });
  assert.equal(sheet.meal.status, 'data');
  assert.equal(sheet.meal.latestPrepared.preparedDate, '2026-08-30');
  assert.equal(sheet.meal.latestPrepared.mealName, 'Overnight Oats');
  assert.equal(sheet.meal.latestConsumed.mealName, 'Overnight Oats');
  assert.equal(sheet.meal.latestConsumed.consumedAt, '2026-08-31T13:15:00.000Z');
  assert.deepEqual(sheet.meal.last7Days, { prepared: 1, consumed: 2, portionsConsumed: 3, dayCount: 7 });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\nLife Character Sheet — CAPABILITY / CAREER');

test('empty capability profile → no-data with zeroed dimensions (no inference)', () => {
  const profile = createEmptyCapabilityProfile({ clock: clockAt('2026-08-01T00:00:00.000Z') });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: [], capabilityProfile: profile, ...OPTS });
  assert.equal(sheet.capability.status, 'no-data');
  assert.equal(sheet.capability.careerTarget, null);
  assert.deepEqual(sheet.capability.dimensionEvidence, { knowledge: 0, practice: 0, execution: 0, shipping: 0, portfolio: 0 });
  assert.equal(sheet.capability.totalEvidence, 0);
});

test('null capability profile → no-data, never throws', () => {
  const sheet = buildLifeCharacterSheet({ ledgerEvents: [], capabilityProfile: null, ...OPTS });
  assert.equal(sheet.capability.status, 'no-data');
  assert.equal(sheet.coverage.capability.hasProfile, false);
});

test('capability parity: target / dimensions / evidence match analyzeCapabilityCareer', () => {
  const profile = buildProfileWithEvidence();
  const nowIso = NOW.toISOString();
  const analysis = analyzeCapabilityCareer(profile, { now: nowIso, lifeLedgerEvents: [] });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: [], capabilityProfile: profile, ...OPTS });
  assert.equal(sheet.capability.careerTarget.title, analysis.target.title);
  assert.deepEqual(sheet.capability.dimensionEvidence, analysis.dimensionTotals);
  assert.equal(sheet.capability.totalEvidence, analysis.currentEvidenceCount);
  assert.equal(sheet.capability.status, 'data');
});

test('life-ledger evidence pointing at a tombstoned event is excluded (parity with analytics scope)', () => {
  const store = makeStore();
  const created = ingest(store, focusDraft({ id: 'f-ev' }));
  ingest(store, {
    ...focusDraft({ id: 'f-ev' }),
    provenance: { ...provenance('chronasense', 'f-ev'), sourceOperation: 'delete' },
    tombstone: {
      active: true, deletedAt: '2026-08-31T17:00:00.000Z', reason: 'user_delete',
      provenance: { sourceOperation: 'delete', sourceRecordKind: 'chronasense.record', evidence: ['chronasense.evidence:f-ev:deleted'] }
    }
  });
  const events = store.listEvents();
  const profile = buildProfileWithEvidence({ lifeLedgerEventId: created.eventId, lifeLedgerKey: events[0] && events[0].sourceEntityId });
  const analysis = analyzeCapabilityCareer(profile, { now: NOW.toISOString(), lifeLedgerEvents: events });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: events, capabilityProfile: profile, ...OPTS });
  assert.deepEqual(sheet.capability.dimensionEvidence, analysis.dimensionTotals);
});

function buildProfileWithEvidence(o = {}) {
  const t = '2026-08-10T00:00:00.000Z';
  return {
    schemaVersion: 1,
    skills: [
      { id: 'sk-1', name: 'Prompt Engineering', category: 'ai', status: 'active', createdAt: t, updatedAt: t },
      { id: 'sk-2', name: 'Old Skill', category: 'misc', status: 'archived', createdAt: t, updatedAt: t }
    ],
    knowledgeAreas: [],
    tools: [],
    careerTargets: [
      { id: 'ct-1', title: 'AI Automation Engineer', objective: 'Ship automations', skillIds: ['sk-1'], priority: 'primary', status: 'active', createdAt: t, updatedAt: t }
    ],
    projects: [
      { id: 'pr-1', title: 'Webhook Pipeline', summary: '', status: 'active', skillIds: ['sk-1'], toolIds: [], careerTargetIds: ['ct-1'], portfolioStatus: 'candidate', artifactIds: [], createdAt: t, updatedAt: t }
    ],
    artifacts: [
      { id: 'af-1', projectId: 'pr-1', type: 'repository', label: 'repo', reference: 'https://example.test/repo', createdAt: t, updatedAt: t }
    ],
    evidence: [
      { id: 'ev-1', skillId: 'sk-1', dimension: 'knowledge', source: 'manual', summary: 'Read docs', observedAt: '2026-08-12T00:00:00.000Z', createdAt: t, updatedAt: t },
      { id: 'ev-2', skillId: 'sk-1', dimension: 'execution', source: 'manual', summary: 'Built pipeline', observedAt: '2026-08-20T00:00:00.000Z', createdAt: t, updatedAt: t },
      ...(o.lifeLedgerEventId
        ? [{ id: 'ev-3', skillId: 'sk-1', dimension: 'practice', source: 'life-ledger', summary: 'Focus block', observedAt: '2026-08-25T00:00:00.000Z', lifeLedgerEventId: o.lifeLedgerEventId, lifeLedgerKey: o.lifeLedgerKey || 'k', createdAt: t, updatedAt: t }]
        : [])
    ],
    createdAt: t,
    updatedAt: t
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\nLife Character Sheet — CROSS-DOMAIN + COVERAGE CHAOS');

test('A. only learning + focus runtime data: workout/meal read not-connected, focus/learning real', () => {
  const store = makeStore();
  ingest(store, focusDraft({ id: 'f1' }));
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 1 });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), learningPlans: [plan], ...OPTS });
  assert.equal(sheet.focus.status, 'data');
  assert.equal(sheet.learning.status, 'data');
  assert.equal(sheet.workout.status, 'not-connected');
  assert.equal(sheet.meal.status, 'not-connected');
  assert.equal(sheet.coverage.workout.state, 'not-connected');
  assert.equal(sheet.coverage.meal.state, 'not-connected');
});

test('B/C. learning + workout + meal supplied: every domain reports data', () => {
  const store = makeStore();
  ingest(store, focusDraft({ id: 'f1' }));
  ingest(store, planStepDraft({ id: 'p:s1' }));
  ingest(store, workoutDraft({ id: 'w1' }));
  ingest(store, mealConsumedDraft({ id: 'mc1' }));
  ingest(store, mealPreparedDraft({ id: 'cm1' }));
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 1 });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), learningPlans: [plan], ...OPTS });
  for (const d of ['focus', 'learning', 'workout', 'meal']) assert.equal(sheet[d].status, 'data', d);
  assert.equal(sheet.coverage.workout.state, 'loaded-not-live');
  assert.equal(sheet.coverage.meal.state, 'loaded-not-live');
});

test('D. no ledger events at all: nothing crashes, every domain honest', () => {
  const sheet = buildLifeCharacterSheet({ ledgerEvents: [], learningPlans: [], capabilityProfile: null, ...OPTS });
  assert.equal(sheet.focus.status, 'no-data');
  assert.equal(sheet.learning.status, 'no-plans');
  assert.equal(sheet.workout.status, 'not-connected');
  assert.equal(sheet.meal.status, 'not-connected');
  assert.equal(sheet.capability.status, 'no-data');
});

test('E. a domain with only a tombstoned event reads exactly like no data', () => {
  const store = makeStore();
  ingest(store, workoutDraft({ id: 'w1' }));
  ingest(store, {
    ...workoutDraft({ id: 'w1' }),
    provenance: { ...provenance('workout', 'w1'), sourceOperation: 'delete' },
    tombstone: {
      active: true, deletedAt: '2026-08-31T00:00:00.000Z', reason: 'user_delete',
      provenance: { sourceOperation: 'delete', sourceRecordKind: 'workout.record', evidence: ['workout.evidence:w1:x'] }
    }
  });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), ...OPTS });
  assert.equal(sheet.workout.allTime.count, 0);
  assert.equal(sheet.workout.status, 'not-connected');
});

test('F. malformed / unsupported events never become misleading facts', () => {
  const events = [
    null,
    { type: 'unknown_type', eventId: 'x', payload: {} },
    { type: 'focus_session_completed' }, // missing everything
    123
  ];
  const sheet = buildLifeCharacterSheet({ ledgerEvents: events, ...OPTS });
  assert.equal(sheet.focus.status, 'no-data');
  assert.equal(sheet.focus.today.sessions, 0);
});

test('deterministic regardless of event order', () => {
  const drafts = [
    () => focusDraft({ id: 'f1', startedAt: '2026-08-31T15:00:00.000Z', endedAt: '2026-08-31T15:20:00.000Z' }),
    () => workoutDraft({ id: 'w1' }),
    () => mealConsumedDraft({ id: 'mc1' }),
    () => planStepDraft({ id: 'p:s1' })
  ];
  const run = order => {
    const store = makeStore();
    order.forEach(i => ingest(store, drafts[i]()));
    return JSON.stringify(buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), ...OPTS }));
  };
  const a = run([0, 1, 2, 3]);
  const b = run([3, 2, 1, 0]);
  const c = run([2, 0, 3, 1]);
  assert.equal(a, b);
  assert.equal(a, c);
});

test('T. one mixed factual snapshot proof', () => {
  const store = makeStore();
  ingest(store, focusDraft({ id: 'f1', startedAt: '2026-08-31T15:00:00.000Z', endedAt: '2026-08-31T15:45:00.000Z', durationMinutes: 45 }));
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepLabel: 'Ship webhook', completedAt: '2026-08-31T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'AI Automation Roadmap' } }));
  ingest(store, workoutDraft({ id: 'w1', startedAt: '2026-08-30T18:00:00.000Z', endedAt: '2026-08-30T18:45:00.000Z', workoutName: 'Upper Body', durationMinutes: 45 }));
  ingest(store, mealPreparedDraft({ id: 'cm1', preparedDate: '2026-08-31', mealName: 'Chili', portionsPrepared: 5 }));
  const plan = samplePlan({ id: 'plan-a', stepCount: 6, completeSteps: 3 });
  const profile = buildProfileWithEvidence();

  const events = store.listEvents();
  const sheet = buildLifeCharacterSheet({ ledgerEvents: events, learningPlans: [plan], capabilityProfile: profile, ...OPTS });
  const feed = buildLifeFeed(events, { now: NOW, referenceTimeZone: TZ });

  assert.equal(sheet.focus.today.minutes, 45);
  assert.equal(sheet.learning.activePlan.completionPercent, 50);
  assert.equal(sheet.learning.latestCompletedStep.stepLabel, 'Ship webhook');
  assert.equal(sheet.workout.latest.workoutName, 'Upper Body');
  assert.equal(sheet.meal.latestPrepared.mealName, 'Chili');
  assert.equal(sheet.capability.careerTarget.title, 'AI Automation Engineer');

  // Feed parity: same accepted-event counts by domain.
  assert.equal(feed.counts.workout, sheet.workout.allTime.count);
  assert.equal(feed.counts.meal, sheet.meal.allTime.prepared + sheet.meal.allTime.consumed);
  assert.equal(feed.counts.learning, 1);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\nLife Character Sheet — TEMPORAL + REVISION');

test('a revised focus event is counted once, at its current facts', () => {
  const store = makeStore();
  ingest(store, focusDraft({ id: 'f1', startedAt: '2026-08-31T15:00:00.000Z', endedAt: '2026-08-31T15:20:00.000Z', durationMinutes: 20 }));
  // revise: same identity, longer duration
  ingest(store, focusDraft({ id: 'f1', startedAt: '2026-08-31T15:00:00.000Z', endedAt: '2026-08-31T15:50:00.000Z', durationMinutes: 50 }));
  const events = store.listEvents();
  const sheet = buildLifeCharacterSheet({ ledgerEvents: events, ...OPTS });
  assert.equal(sheet.focus.today.sessions, 1);
  assert.equal(sheet.focus.today.minutes, 50);
});

test('an old recordedAt with a recent occurrence still lands by occurrence day', () => {
  const store = makeStore();
  // occurred today, but "recorded" months later — occurrence wins
  ingest(store, workoutDraft({ id: 'w-import', startedAt: '2026-08-31T12:00:00.000Z', endedAt: '2026-08-31T12:45:00.000Z' }), { recordedAt: '2026-12-01T00:00:00.000Z' });
  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), ...OPTS });
  assert.equal(sheet.workout.last7Days.count, 1);
  assert.equal(sheet.workout.latest.dayKey, '2026-08-31');
});

test('DST-boundary instant derives a day without throwing', () => {
  const store = makeStore();
  ingest(store, focusDraft({ id: 'fdst', startedAt: '2026-03-08T09:30:00.000Z', endedAt: '2026-03-08T10:00:00.000Z', tz: 'America/New_York' }));
  const sheet = buildLifeCharacterSheet({ ledgerEvents: store.listEvents(), now: new Date('2026-03-08T18:00:00.000Z'), referenceTimeZone: 'America/New_York' });
  assert.equal(sheet.focus.allTime.sessions, 1);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(sheet.focus.latest.dayKey));
});

// ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\nLife Character Sheet — READ-ONLY');

test('buildLifeCharacterSheet does not mutate its inputs', () => {
  const store = makeStore();
  ingest(store, focusDraft({ id: 'f1' }));
  ingest(store, workoutDraft({ id: 'w1' }));
  const events = store.listEvents();
  const plan = samplePlan({ id: 'plan-a', stepCount: 3, completeSteps: 1 });
  const profile = buildProfileWithEvidence();
  const snapshotEvents = JSON.stringify(events);
  const snapshotPlan = JSON.stringify(plan);
  const snapshotProfile = JSON.stringify(profile);

  buildLifeCharacterSheet({ ledgerEvents: events, learningPlans: [plan], capabilityProfile: profile, ...OPTS });

  assert.equal(JSON.stringify(events), snapshotEvents);
  assert.equal(JSON.stringify(plan), snapshotPlan);
  assert.equal(JSON.stringify(profile), snapshotProfile);
});

test('the same event set is deterministic across repeated calls', () => {
  const store = makeStore();
  ingest(store, focusDraft({ id: 'f1' }));
  const events = store.listEvents();
  const one = JSON.stringify(buildLifeCharacterSheet({ ledgerEvents: events, ...OPTS }));
  const two = JSON.stringify(buildLifeCharacterSheet({ ledgerEvents: events, ...OPTS }));
  assert.equal(one, two);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\nLife Character Sheet — PERFORMANCE');

test('thousands of events build quickly', () => {
  const store = makeStore();
  for (let i = 0; i < 1200; i += 1) {
    const day = 10 + (i % 18);
    ingest(store, focusDraft({
      id: `f-${i}`,
      startedAt: `2026-08-${String(day).padStart(2, '0')}T14:00:00.000Z`,
      endedAt: `2026-08-${String(day).padStart(2, '0')}T14:25:00.000Z`
    }));
  }
  const events = store.listEvents();
  const start = Date.now();
  const sheet = buildLifeCharacterSheet({ ledgerEvents: events, ...OPTS });
  assert.ok(Date.now() - start < 1500, 'should build in well under 1.5s');
  assert.equal(sheet.focus.allTime.sessions, 1200);
});
