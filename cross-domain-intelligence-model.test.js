// node cross-domain-intelligence-model.test.js
//
// Cross-Domain Intelligence model tests (Phase 8 V1). Exercises buildCrossDomainIntelligence()
// over a REAL Life Character Sheet (built from events that passed the real life-ledger-core.js
// accept pipeline), real learning plans, and real Capability profiles — plus deliberately
// hostile inputs.
//
// Deliverable trace:
//   30/32 — scenario matrix A–L (candidate generation, ranking, dedupe, abstention,
//           coverage blocking, stale-import behaviour, conflicting signals)
//   31    — determinism (same facts, any array order → identical output)
//   33    — explanation tests (assert WHY, not only WHAT)
//   34    — Character Sheet parity
//   35    — Capability analyzer parity (no second analyzer)
//   36    — Learning parity (established next-step, no independent traversal)
//   37/38 — tombstone / revision / temporal chaos
//   43    — no raw value trusted as structure (model output stays plain data)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createLifeLedgerMemoryStore, upsertLifeLedgerEvent } from './life-ledger-core.js';
import { buildLifeFeed } from './life-feed-model.js';
import { analyzeCapabilityCareer, CAPABILITY_CAREER_ANALYTICS_RULES } from './capability-career-analytics.js';
import {
  createLearningPlan, addPhase, addLesson, addStep, completeStep
} from './learning-plan-model.js';
import { buildLifeCharacterSheet } from './life-character-sheet-model.js';
import {
  buildCrossDomainIntelligence,
  rankCandidates,
  dedupeCandidates,
  CDI_EVIDENCE_STRENGTH,
  CDI_PRIORITY_CLASS
} from './cross-domain-intelligence-model.js';

const TZ = 'America/Phoenix'; // no DST — stable default
const NOW = new Date('2026-08-31T18:00:00.000Z'); // 2026-08-31 11:00 in Phoenix
const NOW_ISO = NOW.toISOString();
const OPTS = { now: NOW, referenceTimeZone: TZ };

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, '0')}`;
}
function clockAt(iso) { return () => iso; }
function makeStore() { return createLifeLedgerMemoryStore(); }

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

function focusDraft(o = {}) {
  const startedAt = o.startedAt || '2026-08-31T15:00:00.000Z';
  const endedAt = o.endedAt || '2026-08-31T15:30:00.000Z';
  return {
    schemaVersion: 1, sourceApp: 'chronasense', sourceEntityId: o.id || 'focus-1',
    type: 'focus_session_completed', occurredAt: endedAt, sourceTimezone: o.tz || TZ,
    payload: { activity: o.activity || 'Focus session', startedAt, endedAt, durationMinutes: o.durationMinutes ?? 30, additiveForTimeTotals: false },
    provenance: provenance('chronasense', o.id || 'focus-1'),
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: o.tombstone || INACTIVE_TOMBSTONE
  };
}

function planStepDraft(o = {}) {
  const completedAt = o.completedAt || '2026-08-31T16:00:00.000Z';
  const payload = { planDate: o.planDate || '2026-08-31', stepLabel: o.stepLabel || 'Build first webhook', completedAt };
  if (o.source !== null) payload.source = o.source || { planId: 'plan-a', planTitle: 'AI Automation Roadmap', lessonTitle: 'Webhooks', stepId: o.stepId || 'step-x' };
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
  const endedAt = o.endedAt || '2026-08-30T18:45:00.000Z';
  return {
    schemaVersion: 1, sourceApp: 'workout', sourceEntityId: o.id || 'wk-1',
    type: 'workout_completed', occurredAt: endedAt, sourceTimezone: o.tz || TZ,
    payload: { workoutName: o.workoutName || 'Upper Body', startedAt, endedAt, durationMinutes: o.durationMinutes ?? 45 },
    provenance: provenance('workout', o.id || 'wk-1'),
    confidence: { score: 0.95, basis: 'validated-workouts-collection-membership' },
    tombstone: o.tombstone || INACTIVE_TOMBSTONE
  };
}

function mealConsumedDraft(o = {}) {
  const consumedAt = o.consumedAt || '2026-08-31T13:15:00.000Z';
  return {
    schemaVersion: 1, sourceApp: 'meal', sourceEntityId: o.id || 'mc-1',
    type: 'meal_consumed', occurredAt: consumedAt, sourceTimezone: o.tz || TZ,
    payload: { mealName: o.mealName || 'Chicken Rice Bowl', consumedAt, portionCount: o.portionCount ?? 1, cookedMealId: o.cookedMealId || 'cm-1' },
    provenance: provenance('meal', o.id || 'mc-1'),
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: o.tombstone || INACTIVE_TOMBSTONE
  };
}

const PLAN_OPTS = { idGenerator: nextId, clock: clockAt('2026-07-01T00:00:00.000Z') };
function isoAtDay(dayOffset) {
  const d = new Date(Date.UTC(2026, 6, 1, 12, 0, 0)); // 2026-07-01T12:00:00Z
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString();
}
function samplePlan(o = {}) {
  let plan = createLearningPlan({ title: o.title || 'AI Automation Roadmap' }, { ...PLAN_OPTS, clock: clockAt(o.createdAt || '2026-07-01T00:00:00.000Z') });
  plan = { ...plan, id: o.id || plan.id };
  plan = addPhase(plan, { title: o.phaseTitle || 'Phase 1' }, PLAN_OPTS);
  const phaseId = plan.phases[0].id;
  plan = addLesson(plan, phaseId, { title: o.lessonTitle || 'Webhooks' }, PLAN_OPTS);
  const lessonId = plan.phases[0].lessons[0].id;
  const stepCount = o.stepCount ?? 4;
  for (let i = 0; i < stepCount; i += 1) plan = addStep(plan, lessonId, { title: `Step ${i + 1}` }, PLAN_OPTS);
  const complete = o.completeSteps ?? 0;
  for (let i = 0; i < complete; i += 1) {
    const stepId = plan.phases[0].lessons[0].steps[i].id;
    plan = completeStep(plan, stepId, { ...PLAN_OPTS, clock: clockAt(isoAtDay(i)) });
  }
  plan = { ...plan, updatedAt: o.updatedAt || plan.updatedAt };
  return plan;
}

// ── Capability profile fixtures (all valid against capability-career-model.js) ────────────
const T0 = '2026-06-01T00:00:00.000Z';
function profile(o = {}) {
  return {
    schemaVersion: 1,
    skills: o.skills || [],
    knowledgeAreas: [],
    tools: [],
    careerTargets: o.careerTargets || [],
    projects: o.projects || [],
    artifacts: o.artifacts || [],
    evidence: o.evidence || [],
    createdAt: T0,
    updatedAt: T0
  };
}
function skill(id, name, status = 'active') {
  return { id, name, category: 'ai', status, createdAt: T0, updatedAt: T0 };
}
function target(id, title, skillIds) {
  return { id, title, objective: 'Ship things', skillIds, priority: 'primary', status: 'active', createdAt: T0, updatedAt: T0 };
}
function project(id, title, skillIds, portfolioStatus = 'candidate', careerTargetIds = []) {
  return { id, title, summary: '', status: 'active', skillIds, toolIds: [], careerTargetIds, portfolioStatus, artifactIds: [], createdAt: T0, updatedAt: T0 };
}
function ev(id, skillId, dimension, observedAt, extra = {}) {
  return { id, skillId, dimension, source: 'manual', summary: `evidence ${id}`, observedAt, createdAt: T0, updatedAt: T0, ...extra };
}
function ledgerEv(id, skillId, dimension, observedAt, lifeLedgerEventId) {
  return { id, skillId, dimension, source: 'life-ledger', summary: `ledger evidence ${id}`, observedAt, lifeLedgerEventId, lifeLedgerKey: 'k', createdAt: T0, updatedAt: T0 };
}

function sheetFrom({ events = [], plans = [], profile: prof = null } = {}) {
  return buildLifeCharacterSheet({ ledgerEvents: events, learningPlans: plans, capabilityProfile: prof, ...OPTS });
}
function intelFrom({ events = [], plans = [], profile: prof = null } = {}) {
  const cs = sheetFrom({ events, plans, profile: prof });
  return buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: events, learningPlans: plans, capabilityProfile: prof });
}

// One live plan-step completion mapping to `planId` — makes that plan "actively tracked" so a
// non-heuristic learning candidate can exist (a plan picked only by recency never can).
function trackedCompletion(planId, o = {}) {
  return planStepDraft({
    id: `${planId}:${o.stepId || 'tracked-s1'}`,
    stepId: o.stepId || 'tracked-s1',
    completedAt: o.completedAt || '2026-08-29T12:00:00.000Z',
    source: { planId, planTitle: o.planTitle || 'tracked', stepId: o.stepId || 'tracked-s1' }
  });
}
function ledgerWithTracked(planId, o = {}) {
  const store = makeStore();
  ingest(store, trackedCompletion(planId, o));
  return store.listEvents();
}

// ═════════════════════════════════════════════════════════════════════════════════════════
console.log('\nCross-Domain Intelligence — SCENARIO MATRIX');

test('A. career target + incomplete aligned plan → concrete learning candidate, HIGH strength', () => {
  const store = makeStore();
  // completion of plan-a step s1, linked to the plan
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1', stepLabel: 'Ship webhook', completedAt: '2026-08-30T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'AI Automation Roadmap', stepId: 's1' } }));
  const events = store.listEvents();
  const planStepEventId = events[0].eventId;
  const plan = samplePlan({ id: 'plan-a', stepCount: 5, completeSteps: 2 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [
      ev('e1', 'sk1', 'execution', '2026-08-20T00:00:00.000Z'),
      ledgerEv('e2', 'sk1', 'practice', '2026-08-30T17:00:00.000Z', planStepEventId)
    ]
  });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan], profile: prof }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof
  });

  assert.equal(intel.abstained, false);
  assert.equal(intel.recommendedAction.sourceKind, 'learning-plan-step');
  assert.equal(intel.recommendedAction.sourceId, 'plan-a::' + plan.phases[0].lessons[0].steps[2].id);
  assert.equal(intel.recommendedAction.aligned, true);
  assert.equal(intel.recommendedAction.evidenceStrength, CDI_EVIDENCE_STRENGTH.HIGH);
  assert.equal(intel.recommendedAction.priorityClass, CDI_PRIORITY_CLASS.ADVANCE_ALIGNED_COMMITTED_WORK);
  assert.match(intel.recommendedAction.action, /Complete "Step 3"/);
  // WHY names the plan, the progress and the target link — all traceable
  assert.ok(intel.recommendedAction.why.some(r => /next unfinished step/.test(r) && /2 of 5 steps complete/.test(r)));
  assert.ok(intel.recommendedAction.why.some(r => /Automation Specialist/.test(r)));
});

test('B. career target + shipping stall + explicit shippable project → shipping candidate beats aligned learning', () => {
  const store = makeStore();
  ingest(store, trackedCompletion('plan-a', { stepId: 's1' }));
  const events = store.listEvents();
  const planStepEventId = events[0].eventId;
  const plan = samplePlan({ id: 'plan-a', stepCount: 5, completeSteps: 1 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    projects: [project('pr1', 'Webhook Demo', ['sk1'], 'candidate', ['ct1'])],
    evidence: [
      ev('e1', 'sk1', 'execution', '2026-08-20T00:00:00.000Z', { projectId: 'pr1' }),
      ev('e2', 'sk1', 'execution', '2026-08-22T00:00:00.000Z', { projectId: 'pr1' }),
      ev('e3', 'sk1', 'shipping', '2026-08-24T00:00:00.000Z', { projectId: 'pr1' }),
      // recent link → the learning candidate is genuinely target-aligned (HIGH / tier 2)
      ledgerEv('e4', 'sk1', 'practice', '2026-08-28T00:00:00.000Z', planStepEventId)
    ]
  });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan], profile: prof }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof
  });

  const learning = intel.candidates.find(c => c.sourceKind === 'learning-plan-step');
  assert.ok(learning && learning.aligned === true, 'learning is genuinely aligned here');
  assert.equal(learning.priorityClass, CDI_PRIORITY_CLASS.ADVANCE_ALIGNED_COMMITTED_WORK);

  // ...and the anchored shipping/portfolio action still outranks it
  assert.equal(intel.recommendedAction.sourceKind, 'capability-next-action');
  assert.equal(intel.recommendedAction.priorityClass, CDI_PRIORITY_CLASS.RESOLVE_STALL_WITH_CONCRETE_PROJECT);
  assert.equal(intel.recommendedAction.evidenceStrength, CDI_EVIDENCE_STRENGTH.HIGH);
  assert.match(intel.recommendedAction.action, /Webhook Demo/);
  assert.equal(intel.alternatives.length, 1);
  assert.equal(intel.alternatives[0].sourceKind, 'learning-plan-step');
  assert.ok(intel.alternatives[0].outrankedBy.reason.length > 0);
});

test('C. shipping stall but NO explicit project action → shipping is an attention SIGNAL, actively tracked learning is recommended, no task invented', () => {
  const events = ledgerWithTracked('plan-a');
  const plan = samplePlan({ id: 'plan-a', stepCount: 5, completeSteps: 1 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [
      ev('e1', 'sk1', 'execution', '2026-08-20T00:00:00.000Z'),
      ev('e2', 'sk1', 'execution', '2026-08-22T00:00:00.000Z')
    ]
  });
  const intel = intelFrom({ events, plans: [plan], profile: prof });

  // no capability candidate — the shipping stall has nothing concrete to point at
  assert.ok(!intel.candidates.some(c => c.sourceKind === 'capability-next-action'));
  assert.equal(intel.recommendedAction.sourceKind, 'learning-plan-step');
  assert.equal(intel.recommendedAction.evidenceStrength, CDI_EVIDENCE_STRENGTH.MEDIUM);
  // shipping stall is present as an attention signal
  assert.ok(intel.signals.some(s => s.id.startsWith('capability-stall::shipping-stall') && s.severity === 'attention'));
});

test('D. no career target + learning plan → learning candidate, lower confidence, and a "set a target" attention signal', () => {
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-08-30T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'AI Automation Roadmap', stepId: 's1' } }));
  const events = store.listEvents();
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 1 });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan] }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: null
  });

  assert.equal(intel.recommendedAction.sourceKind, 'learning-plan-step');
  assert.equal(intel.recommendedAction.aligned, false);
  assert.equal(intel.recommendedAction.evidenceStrength, CDI_EVIDENCE_STRENGTH.MEDIUM);
  assert.equal(intel.recommendedAction.priorityClass, CDI_PRIORITY_CLASS.ADVANCE_LEARNING_PLAN);
});

test('E. no target + no plan + no actionable capability state → abstain (nothing invented)', () => {
  const intel = intelFrom({ profile: profile({}) });
  assert.equal(intel.abstained, true);
  assert.equal(intel.recommendedAction, null);
  assert.equal(intel.explanation.confidence, CDI_EVIDENCE_STRENGTH.INSUFFICIENT);
  // setup is surfaced as an attention signal, never a recommendation
  assert.ok(intel.signals.some(s => s.id === 'no-career-target'));
  assert.ok(!intel.candidates.length);
});

test('F. workout absent because not connected → no workout recommendation, workout is "not evaluated"', () => {
  const plan = samplePlan({ id: 'plan-a', stepCount: 3, completeSteps: 1 });
  const intel = intelFrom({ plans: [plan] });
  assert.ok(!intel.candidates.some(c => c.domain === 'workout'));
  assert.ok(!intel.signals.some(s => s.domain === 'workout'));
  const blocked = intel.blockedDomains.find(d => d.domain === 'workout');
  assert.ok(blocked && blocked.evaluated === false);
  assert.equal(intel.coverage.workout.state, 'not-connected');
});

test('G. meal absent because not connected → no meal recommendation', () => {
  const intel = intelFrom({ plans: [samplePlan({ id: 'p', stepCount: 2, completeSteps: 0 })] });
  assert.ok(!intel.candidates.some(c => c.domain === 'meal'));
  assert.ok(!intel.signals.some(s => s.domain === 'meal'));
  assert.ok(intel.blockedDomains.some(d => d.domain === 'meal' && d.evaluated === false));
});

test('H. old imported workout → no "you haven\'t worked out" recommendation or signal', () => {
  const store = makeStore();
  // a workout six months before "now", present in the ledger as an import
  ingest(store, workoutDraft({ id: 'wk-old', startedAt: '2026-02-01T18:00:00.000Z', endedAt: '2026-02-01T18:45:00.000Z' }), { recordedAt: '2026-02-01T19:00:00.000Z' });
  const events = store.listEvents();
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [samplePlan({ id: 'p', stepCount: 2 })] }),
    ledgerEvents: events, learningPlans: [samplePlan({ id: 'p', stepCount: 2 })], capabilityProfile: null
  });
  const blob = JSON.stringify(intel).toLowerCase();
  assert.ok(!/workout/.test(blob) || intel.blockedDomains.some(d => d.domain === 'workout'));
  assert.ok(!/haven'?t (worked out|exercised)/.test(blob));
  assert.ok(!/months? (ago|old)/.test(blob));
  assert.equal(intel.coverage.workout.state, 'loaded-not-live');
  assert.ok(intel.blockedDomains.some(d => d.domain === 'workout' && d.coverage === 'loaded-not-live'));
});

test('I. no focus session today → no productivity/moral recommendation or attention signal', () => {
  const store = makeStore();
  // focus history exists, but nothing today (Phoenix 2026-08-31)
  ingest(store, focusDraft({ id: 'f-old', startedAt: '2026-08-27T15:00:00.000Z', endedAt: '2026-08-27T15:30:00.000Z' }));
  const events = store.listEvents();
  const plan = samplePlan({ id: 'plan-a', stepCount: 3, completeSteps: 1 });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan] }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: null
  });
  assert.ok(!intel.candidates.some(c => c.domain === 'focus'));
  assert.ok(!intel.signals.some(s => s.domain === 'focus' && s.severity === 'attention'));
  const focusSignal = intel.signals.find(s => s.id === 'focus-context');
  assert.ok(focusSignal && focusSignal.severity === 'info');
  const blob = JSON.stringify(intel).toLowerCase();
  assert.ok(!/should focus|need to focus|be more productive|lazy|behind/.test(blob));
});

test('J. tombstoned / revised evidence → only current truth drives the result', () => {
  const store = makeStore();
  // a LIVE completion of step s2 keeps the plan actively tracked
  ingest(store, trackedCompletion('plan-a', { stepId: 's2', completedAt: '2026-08-28T16:00:00.000Z' }));
  // step s1 completed then reopened (tombstone) — must not count as a live completion
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-08-30T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'Roadmap', stepId: 's1' } }));
  ingest(store, {
    ...planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-08-30T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'Roadmap', stepId: 's1' } }),
    provenance: { ...provenance('chronasense', 'plan-a:s1'), sourceOperation: 'delete' },
    tombstone: { active: true, deletedAt: '2026-08-31T09:00:00.000Z', reason: 'user_delete', provenance: { sourceOperation: 'delete', sourceRecordKind: 'chronasense.plan_step', evidence: ['chronasense.plan_step:s1:reopened'] } }
  });
  const events = store.listEvents();
  const tombstonedEventId = events.find(e => e.tombstone && e.tombstone.active).eventId;
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 0 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [
      ev('e1', 'sk1', 'knowledge', '2026-08-10T00:00:00.000Z'),
      // recent, target-linked — but points at the TOMBSTONED step event
      ledgerEv('e2', 'sk1', 'practice', '2026-08-30T17:00:00.000Z', tombstonedEventId)
    ]
  });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan], profile: prof }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof
  });
  // the plan is actively tracked (live s2 completion) so a candidate exists…
  const learningCandidate = intel.candidates.find(c => c.sourceKind === 'learning-plan-step');
  assert.ok(learningCandidate);
  // …but the tombstoned completion cannot make it "aligned" → MEDIUM, not HIGH
  assert.equal(learningCandidate.aligned, false);
  assert.equal(learningCandidate.evidenceStrength, CDI_EVIDENCE_STRENGTH.MEDIUM);
});

test('K. duplicate candidates collapse deterministically (stable provenance, not display text)', () => {
  const c = {
    candidateId: 'learning-plan-step::p1::s1', sourceKind: 'learning-plan-step', sourceId: 'p1::s1',
    domain: 'learning', priorityClass: 4, evidenceStrength: 'MEDIUM',
    alignment: { aligned: false, evidence: [] }
  };
  const cDupDifferentText = { ...c, action: 'A COMPLETELY DIFFERENT LABEL' };
  const c2 = { ...c, candidateId: 'capability-next-action::execute-skill', sourceKind: 'capability-next-action', sourceId: 'execute-skill', domain: 'capability', priorityClass: 3 };
  const deduped = dedupeCandidates(rankCandidates([c, cDupDifferentText, c2]));
  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped.map(x => x.candidateId).sort(), ['capability-next-action::execute-skill', 'learning-plan-step::p1::s1']);
});

test('L. multiple valid candidates rank deterministically by explicit tier then evidence strength', () => {
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-08-30T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'Roadmap', stepId: 's1' } }));
  const events = store.listEvents();
  const plan = samplePlan({ id: 'plan-a', stepCount: 5, completeSteps: 1 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [
      ev('e1', 'sk1', 'knowledge', '2026-08-20T00:00:00.000Z'),
      ev('e2', 'sk1', 'practice', '2026-08-22T00:00:00.000Z')
    ]
  });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan], profile: prof }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof
  });
  // execute-skill stall (class 3) outranks a non-aligned but actively tracked learning step (class 4)
  assert.equal(intel.recommendedAction.sourceKind, 'capability-next-action');
  assert.equal(intel.recommendedAction.priorityClass, CDI_PRIORITY_CLASS.RESOLVE_STALL);
  assert.equal(intel.alternatives[0].sourceKind, 'learning-plan-step');
  assert.equal(intel.alternatives[0].evidenceStrength, CDI_EVIDENCE_STRENGTH.MEDIUM);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
console.log('\nCross-Domain Intelligence — SCENARIOS M / N / O (recommendation honesty)');

test('M. a recency-fallback plan (no mapped completion, no alignment, old updatedAt) is NEVER a candidate — abstain, signal stays', () => {
  const planOld = samplePlan({ id: 'plan-old', title: 'Old Plan', stepCount: 5, completeSteps: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
  // no ledgerEvents, no capabilityProfile → nothing maps to plan-old, no target
  const intel = intelFrom({ plans: [planOld] });

  assert.equal(intel.abstained, true);
  assert.equal(intel.recommendedAction, null);
  assert.ok(!intel.candidates.some(c => c.sourceKind === 'learning-plan-step'));
  assert.equal(intel.explanation.confidence, CDI_EVIDENCE_STRENGTH.INSUFFICIENT);
  // the factual attention signal remains and still identifies plan + progress + next step
  const signal = intel.signals.find(s => s.id === 'learning-plan-incomplete::plan-old');
  assert.ok(signal && signal.severity === 'attention');
  assert.ok(signal.summary.includes('Old Plan') && signal.summary.includes('1 of 5 steps complete'));
  assert.ok(/next unfinished step/i.test(signal.detail));
});

test('M2. multiple recency-fallback plans → still no candidate, still abstain', () => {
  const a = samplePlan({ id: 'plan-a', title: 'Plan A', stepCount: 4, completeSteps: 0, updatedAt: '2026-02-01T00:00:00.000Z' });
  const b = samplePlan({ id: 'plan-b', title: 'Plan B', stepCount: 6, completeSteps: 2, updatedAt: '2026-03-01T00:00:00.000Z' });
  const intel = intelFrom({ plans: [a, b] });
  assert.equal(intel.abstained, true);
  assert.ok(!intel.candidates.length);
});

test('N. metadata-only updatedAt bump makes the Character Sheet pick Plan B, but Phase 8 must NOT recommend a Plan B step', () => {
  // Plan A: older updatedAt. Plan B: updatedAt bumped "today" by a title edit; NO Ledger completion maps to B.
  const planA = samplePlan({ id: 'plan-a', title: 'Plan A', stepCount: 5, completeSteps: 1, updatedAt: '2026-08-01T00:00:00.000Z' });
  const planB = samplePlan({ id: 'plan-b', title: 'Plan B (renamed today)', stepCount: 5, completeSteps: 1, updatedAt: NOW_ISO });
  const cs = sheetFrom({ plans: [planA, planB] });
  // Character Sheet's heuristic picks the most-recently-updated plan…
  assert.equal(cs.learning.activePlan.id, 'plan-b');
  assert.equal(cs.learning.activePlan.title, 'Plan B (renamed today)');

  const intel = buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: [], learningPlans: [planA, planB], capabilityProfile: null });
  // …but Phase 8 refuses to escalate that guess into a recommendation
  assert.equal(intel.abstained, true);
  assert.equal(intel.recommendedAction, null);
  assert.ok(!JSON.stringify(intel.candidates).includes('plan-b'));
  // Plan B still appears as factual "most recent plan" context in the attention signal only
  const signal = intel.signals.find(s => s.id === 'learning-plan-incomplete::plan-b');
  assert.ok(signal && signal.summary.includes('Plan B (renamed today)'));
  assert.ok(/picked only by recency/i.test(intel.abstentionReason));
});

test('N2. flipping which plan updatedAt is newest does not change the (abstained) outcome — no recommendation churn from metadata', () => {
  const mk = (aUpdated, bUpdated) => {
    const planA = samplePlan({ id: 'plan-a', title: 'Plan A', stepCount: 5, completeSteps: 1, updatedAt: aUpdated });
    const planB = samplePlan({ id: 'plan-b', title: 'Plan B', stepCount: 5, completeSteps: 1, updatedAt: bUpdated });
    return intelFrom({ plans: [planA, planB] });
  };
  const aNewer = mk('2026-08-31T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  const bNewer = mk('2026-08-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
  assert.equal(aNewer.abstained, true);
  assert.equal(bNewer.abstained, true);
  assert.equal(aNewer.recommendedAction, null);
  assert.equal(bNewer.recommendedAction, null);
});

test('O. an OLD target-linked completion link → candidate stays (plan is tracked) but MEDIUM, not HIGH; explanation does not imply current alignment', () => {
  const store = makeStore();
  // a CURRENT tracked completion keeps the plan actionable
  ingest(store, trackedCompletion('plan-a', { stepId: 's9', completedAt: '2026-08-28T12:00:00.000Z' }));
  // a target-linkable completion whose linking evidence is OLD
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-05-01T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'Roadmap', stepId: 's1' } }));
  const events = store.listEvents();
  const oldLinkedEventId = events.find(e => e.sourceEntityId === 'plan-a:s1').eventId;
  const plan = samplePlan({ id: 'plan-a', stepCount: 6, completeSteps: 1 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [
      ev('e1', 'sk1', 'execution', '2026-05-02T00:00:00.000Z'),
      // observedAt is ~120 days before NOW → older than CAPABILITY_CAREER_ANALYTICS_RULES.recentDays (30)
      ledgerEv('e2', 'sk1', 'practice', '2026-05-02T00:00:00.000Z', oldLinkedEventId)
    ]
  });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan], profile: prof }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof
  });
  const learning = intel.candidates.find(c => c.sourceKind === 'learning-plan-step');
  assert.ok(learning, 'the plan is actively tracked, so a candidate remains');
  assert.equal(learning.evidenceStrength, CDI_EVIDENCE_STRENGTH.MEDIUM);
  assert.equal(learning.aligned, false);
  assert.equal(learning.priorityClass, CDI_PRIORITY_CLASS.ADVANCE_LEARNING_PLAN);
  // explanation must not claim current target alignment
  const whyBlob = learning.why.join(' ');
  assert.ok(!/links? .*to the career target/i.test(whyBlob));
  assert.ok(/actively tracked plan/i.test(whyBlob));
});

// ═════════════════════════════════════════════════════════════════════════════════════════
console.log('\nCross-Domain Intelligence — ALIGNMENT RECENCY BOUNDARY');

const RECENT_DAYS_MS = CAPABILITY_CAREER_ANALYTICS_RULES.recentDays * 86400000;

test('the alignment recency window is the Career analyzer recentDays (no independent magic number)', () => {
  assert.equal(typeof CAPABILITY_CAREER_ANALYTICS_RULES.recentDays, 'number');
  assert.ok(CAPABILITY_CAREER_ANALYTICS_RULES.recentDays > 0);
});

function alignmentBoundaryIntel(linkObservedAt) {
  const store = makeStore();
  // current tracked completion → candidate is always actionable
  ingest(store, trackedCompletion('plan-a', { stepId: 's9', completedAt: '2026-08-20T12:00:00.000Z' }));
  // the completion the capability evidence links to
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-07-15T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'Roadmap', stepId: 's1' } }));
  const events = store.listEvents();
  const linkedId = events.find(e => e.sourceEntityId === 'plan-a:s1').eventId;
  const plan = samplePlan({ id: 'plan-a', stepCount: 6, completeSteps: 1 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [
      ev('e1', 'sk1', 'execution', '2026-07-01T00:00:00.000Z'),
      ledgerEv('e2', 'sk1', 'practice', linkObservedAt, linkedId)
    ]
  });
  return buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan], profile: prof }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof
  });
}

test('observedAt exactly at the lower bound (generatedAt - recentDays) → qualifies → HIGH', () => {
  const lowerBound = new Date(NOW.getTime() - RECENT_DAYS_MS).toISOString();
  const intel = alignmentBoundaryIntel(lowerBound);
  const learning = intel.candidates.find(c => c.sourceKind === 'learning-plan-step');
  assert.equal(learning.aligned, true);
  assert.equal(learning.evidenceStrength, CDI_EVIDENCE_STRENGTH.HIGH);
});

test('observedAt 1 ms before the lower bound → does NOT qualify → MEDIUM (tracked)', () => {
  const justOutside = new Date(NOW.getTime() - RECENT_DAYS_MS - 1).toISOString();
  const intel = alignmentBoundaryIntel(justOutside);
  const learning = intel.candidates.find(c => c.sourceKind === 'learning-plan-step');
  assert.equal(learning.aligned, false);
  assert.equal(learning.evidenceStrength, CDI_EVIDENCE_STRENGTH.MEDIUM);
});

test('observedAt after generatedAt (future) → does NOT qualify → MEDIUM (tracked)', () => {
  const future = new Date(NOW.getTime() + 1).toISOString();
  const intel = alignmentBoundaryIntel(future);
  const learning = intel.candidates.find(c => c.sourceKind === 'learning-plan-step');
  assert.equal(learning.aligned, false);
  assert.equal(learning.evidenceStrength, CDI_EVIDENCE_STRENGTH.MEDIUM);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
console.log('\nCross-Domain Intelligence — ABSTENTION');

test('a completed learning plan is not a candidate (nothing left to do)', () => {
  const intel = intelFrom({ plans: [samplePlan({ id: 'p', stepCount: 3, completeSteps: 3 })] });
  assert.equal(intel.abstained, true);
  assert.ok(!intel.candidates.length);
});

test('only disconnected domains → abstain, and the reason names them as not-evaluated', () => {
  const store = makeStore();
  ingest(store, workoutDraft({ id: 'w1' }));
  ingest(store, mealConsumedDraft({ id: 'm1' }));
  const events = store.listEvents();
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events }), ledgerEvents: events, learningPlans: [], capabilityProfile: null
  });
  assert.equal(intel.abstained, true);
  assert.deepEqual(intel.explanation.notEvaluated.sort(), ['Logged activity', 'Meals', 'Workout']);
});

test('abstention with an open attention area says so without inventing a step', () => {
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [
      ev('e1', 'sk1', 'execution', '2026-08-20T00:00:00.000Z'),
      ev('e2', 'sk1', 'execution', '2026-08-22T00:00:00.000Z')
    ]
  });
  // shipping stall, no project, no learning plan → no candidate at all
  const intel = intelFrom({ profile: prof });
  assert.equal(intel.abstained, true);
  assert.match(intel.abstentionReason, /attention areas/i);
  assert.ok(intel.signals.some(s => s.id.startsWith('capability-stall::shipping-stall')));
});

// ═════════════════════════════════════════════════════════════════════════════════════════
console.log('\nCross-Domain Intelligence — PARITY');

test('Character Sheet parity: coverage states are copied, never re-judged', () => {
  const store = makeStore();
  ingest(store, workoutDraft({ id: 'w1' }));
  const events = store.listEvents();
  const cs = sheetFrom({ events, plans: [samplePlan({ id: 'p', stepCount: 2 })] });
  const intel = buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: events, learningPlans: [], capabilityProfile: null });
  for (const domain of Object.keys(cs.coverage)) {
    assert.equal(intel.coverage[domain].state, cs.coverage[domain].state, domain);
  }
  const blob = JSON.stringify(intel).toLowerCase();
  for (const forbidden of ['inactive', 'on track', 'off track', 'unhealthy', 'healthy', 'low priority']) {
    assert.ok(!blob.includes(forbidden), `must not say "${forbidden}"`);
  }
});

test('Character Sheet parity: step counts Phase 8 reports equal the sheet exactly (never off by one)', () => {
  // A recency-only plan (no Ledger completion, no target) is NOT a recommendation — but the
  // factual attention signal still carries the plan progress, and it must match the sheet.
  const plan = samplePlan({ id: 'plan-a', stepCount: 10, completeSteps: 6 });
  const cs = sheetFrom({ plans: [plan] });
  const intel = buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: [], learningPlans: [plan], capabilityProfile: null });
  assert.equal(cs.learning.activePlan.completedSteps, 6);
  assert.equal(intel.abstained, true);
  assert.equal(intel.recommendedAction, null);
  const signal = intel.signals.find(s => s.id === 'learning-plan-incomplete::plan-a');
  assert.ok(signal, 'the learning-plan-incomplete attention signal remains');
  assert.ok(signal.summary.includes('6 of 10 steps complete'));
  assert.ok(signal.evidence.some(e => e.value === '6/10'));
  assert.ok(!JSON.stringify(intel).includes('5 of 10') && !JSON.stringify(intel).includes('5/10'));
});

test('Character Sheet parity: an actively tracked plan reports the sheet count in the recommendation why', () => {
  const events = ledgerWithTracked('plan-a');
  const plan = samplePlan({ id: 'plan-a', stepCount: 10, completeSteps: 6 });
  const cs = sheetFrom({ events, plans: [plan] });
  const intel = buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: events, learningPlans: [plan], capabilityProfile: null });
  assert.equal(cs.learning.activePlan.completedSteps, 6);
  assert.equal(intel.recommendedAction.sourceKind, 'learning-plan-step');
  assert.ok(intel.recommendedAction.why.some(r => r.includes('6 of 10 steps complete')));
  assert.ok(!JSON.stringify(intel).includes('5 of 10'));
});

test('Capability analyzer parity: stalls / target / dimensionTotals match a fresh analyzeCapabilityCareer', () => {
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-08-30T16:00:00.000Z' }));
  const events = store.listEvents();
  const prof = profile({
    skills: [skill('sk1', 'Automation'), skill('sk2', 'Writing')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    projects: [project('pr1', 'Demo', ['sk1'], 'candidate', ['ct1'])],
    evidence: [
      ev('e1', 'sk1', 'execution', '2026-08-20T00:00:00.000Z', { projectId: 'pr1' }),
      ev('e2', 'sk1', 'execution', '2026-08-22T00:00:00.000Z', { projectId: 'pr1' }),
      ev('e3', 'sk1', 'knowledge', '2026-08-24T00:00:00.000Z')
    ]
  });
  const cs = sheetFrom({ events, plans: [], profile: prof });
  const intel = buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: events, learningPlans: [], capabilityProfile: prof });
  const fresh = analyzeCapabilityCareer(prof, { now: cs.generatedAt, lifeLedgerEvents: events });

  assert.deepEqual(intel.capability.dimensionTotals, fresh.dimensionTotals);
  assert.equal(intel.capability.target.title, fresh.target.title);
  assert.equal(intel.capability.nextActionKind, fresh.nextAction.kind);
  // Character Sheet also consumed the same analyzer → its dimensionEvidence must match too
  assert.deepEqual(cs.capability.dimensionEvidence, fresh.dimensionTotals);
  // stall set (by identity) matches, regardless of order
  const key = s => `${s.type}:${s.skillId || s.projectId || ''}`;
  assert.deepEqual(
    intel.capability.stalls.map(key).sort(),
    [...new Set(fresh.stalls.map(key))].sort()
  );
});

test('Learning parity: the recommended step is exactly the Character Sheet next step (no independent traversal)', () => {
  const events = ledgerWithTracked('plan-a');
  const plan = samplePlan({ id: 'plan-a', stepCount: 6, completeSteps: 2 });
  const cs = sheetFrom({ events, plans: [plan] });
  const intel = buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: events, learningPlans: [plan], capabilityProfile: null });
  assert.equal(intel.recommendedAction.sourceId, `${plan.id}::${cs.learning.activePlan.nextStep.stepId}`);
  assert.equal(intel.recommendedAction.title, cs.learning.activePlan.nextStep.stepTitle);
});

test('Capability parity: the capability candidate names the same stall analyzeCapabilityCareer acted on', () => {
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    projects: [project('pr1', 'Webhook Demo', ['sk1'], 'candidate', ['ct1'])],
    evidence: [
      ev('e1', 'sk1', 'execution', '2026-08-20T00:00:00.000Z', { projectId: 'pr1' }),
      ev('e2', 'sk1', 'execution', '2026-08-22T00:00:00.000Z', { projectId: 'pr1' }),
      ev('e3', 'sk1', 'shipping', '2026-08-24T00:00:00.000Z', { projectId: 'pr1' })
    ]
  });
  const cs = sheetFrom({ profile: prof });
  const intel = buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: [], learningPlans: [], capabilityProfile: prof });
  const fresh = analyzeCapabilityCareer(prof, { now: cs.generatedAt, lifeLedgerEvents: [] });
  assert.equal(intel.recommendedAction.sourceKind, 'capability-next-action');
  assert.equal(intel.recommendedAction.action, fresh.nextAction.title); // reused verbatim
  assert.equal(intel.recommendedAction.rationaleKind, fresh.nextAction.kind);
});

test('a portfolio/shipping action whose project is NOT linked to the target → attention signal, no candidate', () => {
  const prof = profile({
    skills: [skill('sk1', 'Automation'), skill('sk2', 'Design')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    // pr1 is a real, actionable, not-portfolio-ready project — but linked to sk2, not the target skill
    projects: [project('pr1', 'Unrelated Side Project', ['sk2'], 'candidate', [])],
    evidence: [
      ev('e1', 'sk1', 'knowledge', '2026-08-10T00:00:00.000Z'),
      ev('e2', 'sk2', 'execution', '2026-08-12T00:00:00.000Z', { projectId: 'pr1' }),
      ev('e3', 'sk2', 'execution', '2026-08-14T00:00:00.000Z', { projectId: 'pr1' })
    ]
  });
  const events = ledgerWithTracked('plan-a');
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 1 });
  const intel = intelFrom({ events, plans: [plan], profile: prof });
  assert.ok(!intel.candidates.some(c => c.sourceKind === 'capability-next-action' && /Unrelated Side Project/.test(c.action)));
  assert.ok(intel.signals.some(s => s.id.startsWith('capability-stall::portfolio-stall')));
  // the actively tracked learning plan remains the recommendation; nothing about the unrelated project is invented
  assert.equal(intel.recommendedAction.sourceKind, 'learning-plan-step');
});

// ═════════════════════════════════════════════════════════════════════════════════════════
console.log('\nCross-Domain Intelligence — DETERMINISM');

test('same facts in different event order → identical signals, candidates, recommendation, alternatives', () => {
  const drafts = [
    () => focusDraft({ id: 'f1', startedAt: '2026-08-31T15:00:00.000Z', endedAt: '2026-08-31T15:20:00.000Z' }),
    () => planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-08-30T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'Roadmap', stepId: 's1' } }),
    () => workoutDraft({ id: 'w1' }),
    () => mealConsumedDraft({ id: 'mc1' })
  ];
  const plan = samplePlan({ id: 'plan-a', stepCount: 5, completeSteps: 1 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [ev('e1', 'sk1', 'knowledge', '2026-08-20T00:00:00.000Z'), ev('e2', 'sk1', 'practice', '2026-08-22T00:00:00.000Z')]
  });
  const run = order => {
    const store = makeStore();
    order.forEach(i => ingest(store, drafts[i]()));
    const events = store.listEvents();
    const cs = sheetFrom({ events, plans: [plan], profile: prof });
    return JSON.stringify(buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof }));
  };
  const a = run([0, 1, 2, 3]);
  assert.equal(a, run([3, 2, 1, 0]));
  assert.equal(a, run([2, 0, 3, 1]));
});

test('reordering skills / evidence / projects in the profile does not change the recommendation', () => {
  const plan = samplePlan({ id: 'plan-a', stepCount: 5, completeSteps: 1 });
  const base = {
    skills: [skill('sk1', 'Automation'), skill('sk2', 'Writing'), skill('sk3', 'Design')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    projects: [project('pr1', 'Demo A', ['sk1'], 'candidate', ['ct1']), project('pr2', 'Demo B', ['sk1'], 'candidate', ['ct1'])],
    evidence: [
      ev('e1', 'sk1', 'execution', '2026-08-20T00:00:00.000Z', { projectId: 'pr1' }),
      ev('e2', 'sk1', 'execution', '2026-08-21T00:00:00.000Z', { projectId: 'pr1' }),
      ev('e3', 'sk1', 'shipping', '2026-08-22T00:00:00.000Z', { projectId: 'pr1' })
    ]
  };
  const forward = intelFrom({ plans: [plan], profile: profile(base) });
  const reversed = intelFrom({ plans: [plan], profile: profile({
    skills: base.skills.slice().reverse(),
    careerTargets: base.careerTargets,
    projects: base.projects.slice().reverse(),
    evidence: base.evidence.slice().reverse()
  }) });
  assert.equal(JSON.stringify(forward.recommendedAction), JSON.stringify(reversed.recommendedAction));
  assert.equal(JSON.stringify(forward.candidates), JSON.stringify(reversed.candidates));
});

test('rankCandidates is a pure stable sort with a full deterministic tie-break', () => {
  const mk = (id, cls, strength) => ({ candidateId: id, domain: 'capability', priorityClass: cls, evidenceStrength: strength });
  const input = [mk('z', 3, 'LOW'), mk('a', 3, 'LOW'), mk('m', 1, 'MEDIUM'), mk('b', 1, 'HIGH')];
  const out = rankCandidates(input).map(c => c.candidateId);
  assert.deepEqual(out, ['b', 'm', 'a', 'z']);
  // input not mutated
  assert.deepEqual(input.map(c => c.candidateId), ['z', 'a', 'm', 'b']);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
console.log('\nCross-Domain Intelligence — TEMPORAL CHAOS');

test('an old recordedAt with a recent occurrence still counts by occurrence (import timing is irrelevant)', () => {
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-08-30T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'Roadmap', stepId: 's1' } }), { recordedAt: '2026-12-01T00:00:00.000Z' });
  const events = store.listEvents();
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 1 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [ev('e1', 'sk1', 'execution', '2026-08-10T00:00:00.000Z'), ledgerEv('e2', 'sk1', 'practice', '2026-08-30T17:00:00.000Z', events[0].eventId)]
  });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan], profile: prof }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof
  });
  assert.equal(intel.recommendedAction.aligned, true);
});

test('a revised plan step is read at its current facts: a revision that re-points the planId breaks a stale alignment', () => {
  const store = makeStore();
  // a live completion of a different step keeps plan-a actively tracked
  ingest(store, trackedCompletion('plan-a', { stepId: 's9', completedAt: '2026-08-27T12:00:00.000Z' }));
  // rev 1 completes step s1, attributed to plan-a
  ingest(store, planStepDraft({ id: 'ps1', stepId: 's1', completedAt: '2026-08-30T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'Roadmap', stepId: 's1' } }));
  const eventId = store.listEvents().find(e => e.sourceEntityId === 'ps1').eventId;
  // rev 2 (same identity) corrects the plan it belonged to -> now plan-b
  ingest(store, planStepDraft({ id: 'ps1', stepId: 's1', completedAt: '2026-08-30T16:00:00.000Z', source: { planId: 'plan-b', planTitle: 'Other Roadmap', stepId: 's1' } }));
  const events = store.listEvents();
  const planA = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 0, updatedAt: '2026-08-29T00:00:00.000Z' });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    // recent, target-linked — but points at the event whose CURRENT truth now belongs to plan-b
    evidence: [ev('e1', 'sk1', 'execution', '2026-08-10T00:00:00.000Z'), ledgerEv('e2', 'sk1', 'practice', '2026-08-30T17:00:00.000Z', eventId)]
  });
  const cs = sheetFrom({ events, plans: [planA], profile: prof });
  const intel = buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: events, learningPlans: [planA], capabilityProfile: prof });
  const learningCandidate = intel.candidates.find(c => c.sourceKind === 'learning-plan-step');
  assert.ok(learningCandidate, 'plan-a is still actively tracked via its live s9 completion');
  assert.equal(learningCandidate.aligned, false);
  assert.equal(learningCandidate.evidenceStrength, CDI_EVIDENCE_STRENGTH.MEDIUM);
});

test('a future-dated capability evidence record cannot create alignment', () => {
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-08-30T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'Roadmap', stepId: 's1' } }));
  const events = store.listEvents();
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 1 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [
      ev('e1', 'sk1', 'execution', '2026-08-10T00:00:00.000Z'),
      ledgerEv('e2', 'sk1', 'practice', '2027-01-01T00:00:00.000Z', events[0].eventId) // future
    ]
  });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan], profile: prof }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof
  });
  const learningCandidate = intel.candidates.find(c => c.sourceKind === 'learning-plan-step');
  assert.equal(learningCandidate.aligned, false);
});

test('timezone: alignment holds when the plan step occurred in a different source zone', () => {
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-08-31T16:00:00.000Z', tz: 'Asia/Tokyo', source: { planId: 'plan-a', planTitle: 'Roadmap', stepId: 's1' } }));
  const events = store.listEvents();
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 1 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [ev('e1', 'sk1', 'execution', '2026-08-10T00:00:00.000Z'), ledgerEv('e2', 'sk1', 'practice', '2026-08-31T18:00:00.000Z', events[0].eventId)]
  });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan], profile: prof }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof
  });
  assert.equal(intel.recommendedAction.aligned, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
console.log('\nCross-Domain Intelligence — COVERAGE CHAOS');

test('workout+meal events present but not live → still not evaluated, still no health advice', () => {
  const store = makeStore();
  ingest(store, workoutDraft({ id: 'w1' }));
  ingest(store, mealConsumedDraft({ id: 'm1' }));
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1', completedAt: '2026-08-30T16:00:00.000Z', source: { planId: 'plan-a', planTitle: 'Roadmap', stepId: 's1' } }));
  const events = store.listEvents();
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 1 });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan] }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: null
  });
  assert.equal(intel.coverage.workout.state, 'loaded-not-live');
  assert.equal(intel.coverage.workout.evaluated, false);
  assert.equal(intel.coverage.meal.evaluated, false);
  assert.ok(!intel.candidates.some(c => c.domain === 'workout' || c.domain === 'meal'));
  const blob = JSON.stringify(intel).toLowerCase();
  assert.ok(!/nutrition|calorie|protein|diet|exercise more|work out more/.test(blob));
});

test('capability profile that throws in the analyzer → capability not evaluated, an actively tracked learning plan still works', () => {
  const events = ledgerWithTracked('plan-a');
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 1 });
  const brokenProfile = { schemaVersion: 1, skills: [{ id: 'x' }], knowledgeAreas: [], tools: [], careerTargets: [], projects: [], artifacts: [], evidence: [], createdAt: T0, updatedAt: T0 };
  const cs = buildLifeCharacterSheet({ ledgerEvents: events, learningPlans: [plan], capabilityProfile: brokenProfile, ...OPTS });
  const intel = buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: events, learningPlans: [plan], capabilityProfile: brokenProfile });
  assert.equal(intel.capability.readable, false);
  assert.ok(intel.signals.some(s => s.id === 'capability-unreadable'));
  assert.equal(intel.recommendedAction.sourceKind, 'learning-plan-step');
  assert.equal(intel.recommendedAction.evidenceStrength, CDI_EVIDENCE_STRENGTH.MEDIUM);
});

test('malformed / empty character sheet input throws a clear error', () => {
  assert.throws(() => buildCrossDomainIntelligence({ characterSheet: null }), /Life Character Sheet/);
  assert.throws(() => buildCrossDomainIntelligence({}), /Life Character Sheet/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
console.log('\nCross-Domain Intelligence — READ-ONLY & SAFETY');

test('buildCrossDomainIntelligence does not mutate any input', () => {
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1' }));
  const events = store.listEvents();
  const plan = samplePlan({ id: 'plan-a', stepCount: 4, completeSteps: 1 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [ev('e1', 'sk1', 'knowledge', '2026-08-20T00:00:00.000Z'), ev('e2', 'sk1', 'practice', '2026-08-21T00:00:00.000Z')]
  });
  const cs = sheetFrom({ events, plans: [plan], profile: prof });
  const snapEvents = JSON.stringify(events);
  const snapPlan = JSON.stringify(plan);
  const snapProfile = JSON.stringify(prof);
  const snapSheet = JSON.stringify(cs);
  buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof });
  assert.equal(JSON.stringify(events), snapEvents);
  assert.equal(JSON.stringify(plan), snapPlan);
  assert.equal(JSON.stringify(prof), snapProfile);
  assert.equal(JSON.stringify(cs), snapSheet);
});

test('hostile text in a plan / target / project name stays inert plain data (no structure injected)', () => {
  const evil = '<img src=x onerror=alert(1)>"</script>';
  const plan = samplePlan({ id: 'plan-a', title: evil, stepCount: 3, completeSteps: 1, lessonTitle: evil });
  const prof = profile({
    skills: [skill('sk1', evil)],
    careerTargets: [target('ct1', evil, ['sk1'])],
    projects: [project('pr1', evil, ['sk1'], 'candidate', ['ct1'])],
    evidence: [
      ev('e1', 'sk1', 'execution', '2026-08-20T00:00:00.000Z', { projectId: 'pr1' }),
      ev('e2', 'sk1', 'execution', '2026-08-21T00:00:00.000Z', { projectId: 'pr1' }),
      ev('e3', 'sk1', 'shipping', '2026-08-22T00:00:00.000Z', { projectId: 'pr1' })
    ]
  });
  const intel = intelFrom({ plans: [plan], profile: prof });
  // the evil string is carried verbatim as a string value, never parsed or expanded
  assert.ok(JSON.stringify(intel).includes(evil.replace(/"/g, '\\"')));
  assert.equal(typeof intel.recommendedAction.action, 'string');
  // control characters are stripped from rationale text (recommendation why + attention signals)
  const plan2 = samplePlan({ id: 'p2', title: 'Line1\nLine2\tTab', stepCount: 2, completeSteps: 0 });
  const intel2 = intelFrom({ events: ledgerWithTracked('p2'), plans: [plan2] });
  assert.ok(!/[\n\t]/.test(intel2.recommendedAction.why.join(' ')));
  assert.ok(!/[\n\t]/.test(JSON.stringify(intel2.signals)));
});

test('language stays neutral — never "failed" / "lazy" / "behind"', () => {
  const store = makeStore();
  ingest(store, planStepDraft({ id: 'plan-a:s1', stepId: 's1' }));
  const events = store.listEvents();
  const plan = samplePlan({ id: 'plan-a', stepCount: 8, completeSteps: 1 });
  const prof = profile({
    skills: [skill('sk1', 'Automation')],
    careerTargets: [target('ct1', 'Automation Specialist', ['sk1'])],
    evidence: [ev('e1', 'sk1', 'knowledge', '2026-08-10T00:00:00.000Z'), ev('e2', 'sk1', 'practice', '2026-08-11T00:00:00.000Z')]
  });
  const intel = buildCrossDomainIntelligence({
    characterSheet: sheetFrom({ events, plans: [plan], profile: prof }),
    ledgerEvents: events, learningPlans: [plan], capabilityProfile: prof
  });
  const blob = JSON.stringify(intel).toLowerCase();
  for (const word of ['you failed', 'lazy', "you're behind", 'you are behind', 'slacking', 'disappointing']) {
    assert.ok(!blob.includes(word), `must not say "${word}"`);
  }
});

test('performance: a large ledger + profile still builds quickly', () => {
  const store = makeStore();
  ingest(store, trackedCompletion('plan-a')); // one plan-step completion among many events
  for (let i = 0; i < 1500; i += 1) {
    const day = 10 + (i % 18);
    ingest(store, focusDraft({ id: `f-${i}`, startedAt: `2026-08-${String(day).padStart(2, '0')}T14:00:00.000Z`, endedAt: `2026-08-${String(day).padStart(2, '0')}T14:25:00.000Z` }));
  }
  const events = store.listEvents();
  const plan = samplePlan({ id: 'plan-a', stepCount: 20, completeSteps: 8 });
  const cs = sheetFrom({ events, plans: [plan] });
  const start = Date.now();
  const intel = buildCrossDomainIntelligence({ characterSheet: cs, ledgerEvents: events, learningPlans: [plan], capabilityProfile: null });
  assert.ok(Date.now() - start < 1000, 'should build in well under 1s');
  assert.equal(intel.recommendedAction.sourceKind, 'learning-plan-step');
});
