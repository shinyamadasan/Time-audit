// Cross-Domain Intelligence — canonical derived model (Phase 8 V1).
//
// Answers ONE question: "What deserves my attention next — and what is the single
// highest-leverage next action I can actually take?"
//
// It is NOT a new truth store, NOT a coach, NOT a scorecard, and NOT an LLM. It is a PURE,
// DETERMINISTIC, RULE-BASED projection that CONSUMES already-derived facts:
//
//   • Life Character Sheet  (buildLifeCharacterSheet)  → "where am I now?" per domain + coverage
//   • Capability analyzer   (analyzeCapabilityCareer)  → career target, stalls, nextAction, projects
//   • Life Feed             (buildLifeFeed)            → current-truth event set for the alignment chain
//   • Learning plans / Capability profile              → explicit IDs + the plan→evidence→target chain
//
// Given the same factual inputs in any array order it returns the same signals, the same
// candidates, the same recommendation and the same alternatives. It never calls Date.now(),
// never mutates an input, and never writes to any store.
//
// ── FOUR LAYERS, NEVER COLLAPSED ─────────────────────────────────────────────────────────
//   FACT            an observable state read off the Character Sheet / analyzer
//   SIGNAL          a factual condition that MAY deserve attention (no concrete step implied)
//   CANDIDATE       something the system COULD recommend (bounded, explicit provenance)
//   RECOMMENDATION  the single highest-ranked justified candidate (+ traceable explanation)
//
// ── COVERAGE-AWARE REASONING (the core invariant) ────────────────────────────────────────
// Absence of Ledger events means different things depending on coverage. A domain whose
// source is not live (Workout, Meal, free-form activity) is reported as "not evaluated" —
// never inactive / healthy / unhealthy / on-track / off-track / low-priority. Missing data
// is never turned into a negative signal, and no recommendation is ever generated from
// UNKNOWN as though it were ZERO.
//
// ── NO INVENTED GOALS ────────────────────────────────────────────────────────────────────
// Recommendations align only to EXPLICIT structures already in the models: an active career
// target, an active learning plan, a capability stall the analyzer already detected, an
// explicit project. A workout/meal/focus event never implies that fitness / nutrition /
// "work more" is a goal. When a stall exists but no concrete action does, the stall is
// surfaced as an attention SIGNAL — a task is never fabricated to fill the slot.

import { buildLifeFeed } from './life-feed-model.js';
import { analyzeCapabilityCareer } from './capability-career-analytics.js';

// ── Public vocabulary (documented, frozen) ───────────────────────────────────────────────

// Evidence strength — factual categories, never fake percentages.
export const CDI_EVIDENCE_STRENGTH = Object.freeze({
  HIGH: 'HIGH',                 // explicit plan / analyzer output AND an explicit target link
  MEDIUM: 'MEDIUM',             // explicit plan or analyzer stall, weak or no target link
  LOW: 'LOW',                   // limited evidence — e.g. a plan picked only by recency, no mapped completion
  INSUFFICIENT: 'INSUFFICIENT'  // the engine should not recommend — maps to abstention
});

// Priority classes — discrete, transparent tiers (lower number = higher priority). The
// hierarchy is derived from the actual models: a concrete shipping/portfolio action that
// turns real work into visible proof outranks advancing a plan that is already explicitly
// tied to the target, which outranks a bare stall with no concrete action, which outranks
// plain plan progress. First-time career setup is not a candidate at all in V1 — it is
// surfaced as an attention signal instead.
export const CDI_PRIORITY_CLASS = Object.freeze({
  RESOLVE_STALL_WITH_CONCRETE_PROJECT: 1,
  ADVANCE_ALIGNED_COMMITTED_WORK: 2,
  RESOLVE_STALL: 3,
  ADVANCE_LEARNING_PLAN: 4
});

const PRIORITY_CLASS_LABEL = Object.freeze({
  1: 'Turn committed work into visible proof',
  2: 'Advance work already tied to your target',
  3: 'Address a career-capital stall',
  4: 'Advance your active learning plan'
});

export const CDI_MODEL_V1 = Object.freeze({
  evidenceStrength: Object.freeze(Object.keys(CDI_EVIDENCE_STRENGTH)),
  priorityClasses: Object.freeze(Object.keys(CDI_PRIORITY_CLASS)),
  candidateSourceKinds: Object.freeze(['learning-plan-step', 'capability-next-action']),
  // Character Sheet coverage states that let a domain participate in reasoning at all.
  evaluableCoverageStates: Object.freeze(['active', 'no-events-yet']),
  domainLabels: Object.freeze({
    focus: 'Focus', learning: 'Learning', time: 'Logged activity',
    workout: 'Workout', meal: 'Meals', capability: 'Capability & Career'
  })
});

// Capability nextAction kinds, grouped by how Phase 8 treats them.
const SETUP_KINDS = new Set(['setup-target', 'map-target-skills', 'setup-evidence']);
const STALL_DRIVEN_KINDS = new Set(['portfolio-proof', 'ship-project', 'execute-skill', 'refresh-skill']);

// Analyzer stall types in the same priority order the analyzer itself uses in
// chooseNextAction — so Phase 8's ordering is parity, not an independent opinion.
const STALL_TYPE_ORDER = Object.freeze([
  'portfolio-stall', 'shipping-stall', 'execution-stall',
  'application-stall', 'knowledge-stall', 'career-alignment-stall'
]);

const STALL_HUMAN = Object.freeze({
  'portfolio-stall': 'a portfolio stall',
  'shipping-stall': 'a shipping stall',
  'execution-stall': 'an execution stall',
  'application-stall': 'an application stall',
  'knowledge-stall': 'a knowledge stall',
  'career-alignment-stall': 'a career-alignment stall'
});

const STRENGTH_RANK = Object.freeze({ HIGH: 0, MEDIUM: 1, LOW: 2, INSUFFICIENT: 3 });
const DOMAIN_TIEBREAK = Object.freeze({ learning: 0, capability: 1, focus: 2, time: 3, workout: 4, meal: 5 });

// ── tiny helpers ─────────────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
function isIsoInstant(value) {
  return typeof value === 'string' && ISO_INSTANT_RE.test(value) && Number.isFinite(Date.parse(value));
}

// One-line, control-byte-free text for a rationale string. HTML escaping is the UI's job.
function clean(value, fallback = '') {
  const normalized = String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || fallback;
}

function quoted(value, fallback) {
  return `"${clean(value, fallback)}"`;
}

function stepsPhrase(done, total) {
  return `${done} of ${total} ${total === 1 ? 'step' : 'steps'} complete`;
}

// Highest-revision raw record per eventId — identical rule to life-character-sheet-model.js
// rawEventsById(): a positive-integer revision wins; input order never changes the winner.
function highestRevisionById(rawEvents) {
  const byId = new Map();
  const rank = record => (Number.isInteger(record.revision) && record.revision >= 1 ? record.revision : 0);
  for (const event of asArray(rawEvents)) {
    if (!isPlainObject(event) || typeof event.eventId !== 'string' || !event.eventId) continue;
    const existing = byId.get(event.eventId);
    if (!existing || rank(event) >= rank(existing)) byId.set(event.eventId, event);
  }
  return byId;
}

// ── Coverage → evaluability ──────────────────────────────────────────────────────────────

function coverageView(characterSheet) {
  const source = isPlainObject(characterSheet.coverage) ? characterSheet.coverage : {};
  const out = {};
  for (const domain of Object.keys(source)) {
    const state = source[domain] && typeof source[domain].state === 'string' ? source[domain].state : 'not-connected';
    out[domain] = {
      state,
      // A domain can only participate if its producing source is actually live (active, or a
      // truthful live zero). loaded-not-live / not-connected / unreadable → not evaluated.
      evaluated: CDI_MODEL_V1.evaluableCoverageStates.includes(state)
    };
  }
  return out;
}

function blockedDomains(coverage) {
  const out = [];
  for (const domain of ['time', 'workout', 'meal', 'capability']) {
    const cov = coverage[domain];
    if (!cov || cov.evaluated) continue;
    out.push({
      domain,
      label: CDI_MODEL_V1.domainLabels[domain] || domain,
      coverage: cov.state,
      evaluated: false,
      note: cov.state === 'loaded-not-live'
        ? 'Loaded from an import — not updating live, so it does not drive a current recommendation.'
        : cov.state === 'unreadable'
          ? 'Stored data could not be read — not evaluated.'
          : 'Not connected to the Life Ledger — not evaluated.'
    });
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain));
}

// ── Capability analyzer: consume, sort, dedupe (never re-derive) ──────────────────────────

function sortStalls(stalls) {
  return asArray(stalls).slice().sort((a, b) => {
    const t = STALL_TYPE_ORDER.indexOf(a.type) - STALL_TYPE_ORDER.indexOf(b.type);
    if (t !== 0) return t;
    const severityRank = s => (s === 'medium' ? 0 : s === 'low' ? 1 : 2);
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) return sev;
    return String(a.skillId || a.projectId || '').localeCompare(String(b.skillId || b.projectId || ''));
  });
}

function dedupeStalls(sortedStalls) {
  const seen = new Set();
  const out = [];
  for (const stall of sortedStalls) {
    const key = `${stall.type}::${stall.skillId || stall.projectId || 'general'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(stall);
  }
  return out;
}

function runCapabilityAnalysis(capabilityProfile, generatedAt, ledgerEvents) {
  if (!isPlainObject(capabilityProfile)) {
    return { readable: true, present: false, analysis: null };
  }
  try {
    // EXACT parity with life-character-sheet-model.js buildCapability(): same profile, same
    // `now` (the Character Sheet's generatedAt), same lifeLedgerEvents array. Passing anything
    // else here would silently change the tombstone-aware evidence scope and diverge.
    const analysis = analyzeCapabilityCareer(capabilityProfile, {
      now: generatedAt,
      lifeLedgerEvents: ledgerEvents
    });
    return { readable: true, present: true, analysis };
  } catch {
    return { readable: false, present: true, analysis: null };
  }
}

// The exact stall analytics.chooseNextAction() acted on: same priority order (STALL_TYPE_ORDER),
// same id tie-break. Re-derived here so Phase 8 explains / anchors the SAME thing the analyzer
// chose, never an independent guess.
function drivingStall(analysis) {
  return asArray(analysis && analysis.stalls).slice().sort((a, b) => {
    const byPriority = STALL_TYPE_ORDER.indexOf(a.type) - STALL_TYPE_ORDER.indexOf(b.type);
    if (byPriority !== 0) return byPriority;
    return String(a.skillId || a.projectId || '').localeCompare(String(b.skillId || b.projectId || ''));
  })[0] || null;
}

// The concrete project a shipping / portfolio action points at — the project the analyzer's
// own driving stall named, but ONLY when one of that project's skills is explicitly linked to
// the active target. No target link → not a concrete anchor (instruction 18: explicit
// relationships only, never keyword matching).
function anchorProject(analysis) {
  if (!analysis || !analysis.target) return null;
  const stall = drivingStall(analysis);
  if (!stall || !stall.projectId) return null;
  const project = asArray(analysis.projects).find(item => item.projectId === stall.projectId);
  if (!project || !project.actionable) return null;
  const targetSkillIds = new Set(asArray(analysis.targetSkillIds));
  return asArray(project.skillIds).some(id => targetSkillIds.has(id)) ? project : null;
}

// ── The learning alignment chain (explicit IDs only) ─────────────────────────────────────
// aligned  ⇔  there is capability evidence (source: 'life-ledger', dimension counted as
// current) that points at a plan_step_completed event of THIS active plan AND is attached to
// a skill that is linked to the active career target. This is a real chain of explicit ids:
//   plan step → Ledger event → capability evidence → target skill → career target.
function learningAlignment(activePlanId, feed, rawById, capabilityProfile, analysis) {
  const empty = { aligned: false, evidence: [] };
  if (!activePlanId || !analysis || !analysis.target) return empty;
  const targetSkillIds = new Set(asArray(analysis.targetSkillIds));
  if (!targetSkillIds.size) return empty;

  // current-truth plan_step_completed eventIds for the active plan
  const planStepEventIds = new Set();
  for (const item of asArray(feed.items)) {
    if (item.type !== 'plan_step_completed') continue;
    const raw = rawById.get(item.eventId);
    const source = raw && isPlainObject(raw.payload) && isPlainObject(raw.payload.source) ? raw.payload.source : null;
    if (source && source.planId === activePlanId) planStepEventIds.add(item.eventId);
  }
  if (!planStepEventIds.size) return empty;

  const generatedMs = Date.parse(feed.generatedAt);
  const links = asArray(capabilityProfile && capabilityProfile.evidence).filter(evidence =>
    isPlainObject(evidence)
    && evidence.source === 'life-ledger'
    && planStepEventIds.has(evidence.lifeLedgerEventId)
    && targetSkillIds.has(evidence.skillId)
    && isIsoInstant(evidence.observedAt)
    && Date.parse(evidence.observedAt) <= generatedMs
  );
  if (!links.length) return empty;
  return {
    aligned: true,
    evidence: [{
      label: 'Plan → target link',
      value: `${links.length} capability evidence record${links.length === 1 ? '' : 's'} tie this plan's completed steps to ${quoted(analysis.target.title, 'the career target')}`,
      source: 'Capability profile'
    }]
  };
}

// ── Candidate generation ─────────────────────────────────────────────────────────────────

function learningCandidate(characterSheet, alignment) {
  const learning = characterSheet.learning;
  if (!learning || learning.status !== 'data') return null;
  const plan = learning.activePlan;
  if (!plan || !plan.hasSteps || plan.isComplete || !plan.nextStep || !plan.id || !plan.nextStep.stepId) {
    return null;
  }
  const next = plan.nextStep;
  const context = [next.lessonTitle, next.phaseTitle].map(v => clean(v)).filter(Boolean);
  const activelyTracked = !!(learning.latestCompletedStep && learning.latestCompletedStep.planId === plan.id);

  const evidenceStrength = alignment.aligned
    ? CDI_EVIDENCE_STRENGTH.HIGH
    : (activelyTracked ? CDI_EVIDENCE_STRENGTH.MEDIUM : CDI_EVIDENCE_STRENGTH.LOW);
  const priorityClass = alignment.aligned
    ? CDI_PRIORITY_CLASS.ADVANCE_ALIGNED_COMMITTED_WORK
    : CDI_PRIORITY_CLASS.ADVANCE_LEARNING_PLAN;

  return {
    candidateId: `learning-plan-step::${plan.id}::${next.stepId}`,
    sourceKind: 'learning-plan-step',
    sourceId: `${plan.id}::${next.stepId}`,
    domain: 'learning',
    action: `Complete ${quoted(next.stepTitle, 'the next learning step')}`,
    title: clean(next.stepTitle, 'the next learning step'),
    context,
    planTitle: clean(plan.title, 'your learning plan'),
    rationaleKind: alignment.aligned ? 'advances-aligned-plan' : 'advances-plan',
    priorityClass,
    evidenceStrength,
    alignment,
    homeView: 'learning',
    _facts: {
      completedSteps: plan.completedSteps,
      totalSteps: plan.totalSteps,
      activelyTracked
    }
  };
}

function capabilityCandidate(analysisState, coverage) {
  if (!analysisState.analysis) return null;
  if (!coverage.capability || !coverage.capability.evaluated) return null;
  const analysis = analysisState.analysis;
  const nextAction = isPlainObject(analysis.nextAction) ? analysis.nextAction : null;
  if (!nextAction || nextAction.kind === 'continue') return null;

  // Setup states are surfaced as SIGNALS, never as "the highest-leverage next action".
  if (analysis.insufficientData || SETUP_KINDS.has(nextAction.kind)) return null;
  if (!STALL_DRIVEN_KINDS.has(nextAction.kind)) return null;

  const anchor = anchorProject(analysis);
  const shippingKind = nextAction.kind === 'ship-project' || nextAction.kind === 'portfolio-proof';

  // Scenario C / instruction 9: a shipping or portfolio action must point at an explicit
  // project — "ship / add portfolio proof for <skill>" with nothing concrete to act on is an
  // attention SIGNAL (the underlying stall is already in analysis.stalls), never a fabricated
  // task. Execution / practice actions describe a work block and stay actionable without one.
  if (shippingKind && !anchor) return null;

  // Tier 1 (turn committed work into visible proof) is reserved for a shipping/portfolio
  // action anchored to a real project. Execution / practice actions are tier 3 regardless.
  const concrete = shippingKind && !!anchor;
  const priorityClass = concrete
    ? CDI_PRIORITY_CLASS.RESOLVE_STALL_WITH_CONCRETE_PROJECT
    : CDI_PRIORITY_CLASS.RESOLVE_STALL;
  const evidenceStrength = concrete
    ? CDI_EVIDENCE_STRENGTH.HIGH
    : (nextAction.confidence === 'medium' ? CDI_EVIDENCE_STRENGTH.MEDIUM : CDI_EVIDENCE_STRENGTH.LOW);

  // Only an anchor that actually shapes the recommendation (a concrete shipping/portfolio
  // action) contributes to identity and display — a stray non-concrete match does not.
  const effectiveAnchor = concrete ? anchor : null;
  const sourceId = `${nextAction.kind}${effectiveAnchor ? `::${effectiveAnchor.projectId}` : ''}`;
  return {
    candidateId: `capability-next-action::${sourceId}`,
    sourceKind: 'capability-next-action',
    sourceId,
    domain: 'capability',
    action: clean(nextAction.title, 'Advance a target capability'),
    title: clean(nextAction.title, 'Advance a target capability'),
    context: effectiveAnchor ? [clean(effectiveAnchor.title)] : [],
    rationaleKind: nextAction.kind,
    priorityClass,
    evidenceStrength,
    alignment: {
      aligned: true,
      evidence: [{ label: 'Career signal', value: 'the analyzer detected this on a target capability', source: 'Capability profile' }]
    },
    homeView: 'career',
    _facts: {
      analyzerReason: clean(nextAction.reason),
      anchorTitle: effectiveAnchor ? clean(effectiveAnchor.title) : null,
      targetTitle: analysis.target ? clean(analysis.target.title) : null
    }
  };
}

// Collapse candidates that share a candidateId (stable provenance, not display text).
// Deterministic: keep the first occurrence in the already-ranked list.
export function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of asArray(candidates)) {
    if (!candidate || typeof candidate.candidateId !== 'string') continue;
    if (seen.has(candidate.candidateId)) continue;
    seen.add(candidate.candidateId);
    out.push(candidate);
  }
  return out;
}

export function rankCandidates(candidates) {
  return asArray(candidates).slice().sort((a, b) => {
    if (a.priorityClass !== b.priorityClass) return a.priorityClass - b.priorityClass;
    const strength = STRENGTH_RANK[a.evidenceStrength] - STRENGTH_RANK[b.evidenceStrength];
    if (strength !== 0) return strength;
    const domain = (DOMAIN_TIEBREAK[a.domain] ?? 9) - (DOMAIN_TIEBREAK[b.domain] ?? 9);
    if (domain !== 0) return domain;
    return String(a.candidateId).localeCompare(String(b.candidateId));
  });
}

// ── Signals ──────────────────────────────────────────────────────────────────────────────

function buildSignals(characterSheet, analysisState, coverage) {
  const signals = [];
  const learning = characterSheet.learning || {};
  const plan = learning.activePlan;

  if (learning.status === 'data' && plan && plan.hasSteps && !plan.isComplete) {
    signals.push({
      id: `learning-plan-incomplete::${plan.id}`,
      domain: 'learning',
      severity: 'attention',
      summary: `${quoted(plan.title, 'Your learning plan')} is ${stepsPhrase(plan.completedSteps, plan.totalSteps)}.`,
      detail: plan.nextStep ? `Next unfinished step: ${clean(plan.nextStep.stepTitle)}.` : '',
      evidence: [{ label: 'Plan progress', value: `${plan.completedSteps}/${plan.totalSteps}`, source: 'Life Character Sheet' }]
    });
  } else if (learning.status === 'no-plans' && learning.latestCompletedStep) {
    signals.push({
      id: 'learning-plan-absent-with-history',
      domain: 'learning',
      severity: 'info',
      summary: 'There is a record of past learning-step completions, but no learning plan is loaded — so there is no next step to advance.',
      detail: '',
      evidence: [{ label: 'Last step completed', value: clean(learning.latestCompletedStep.stepLabel), source: 'Life Character Sheet' }]
    });
  }

  const analysis = analysisState.analysis;
  if (!analysisState.readable) {
    signals.push({
      id: 'capability-unreadable',
      domain: 'capability',
      severity: 'info',
      summary: 'The Capability profile could not be read, so career guidance is not evaluated.',
      detail: '',
      evidence: []
    });
  } else if (analysis) {
    if (analysis.insufficientData) {
      const nextAction = isPlainObject(analysis.nextAction) ? analysis.nextAction : null;
      signals.push({
        id: !analysis.target ? 'no-career-target'
          : (asArray(analysis.targetSkillIds).length === 0 ? 'career-map-incomplete' : 'career-evidence-missing'),
        domain: 'capability',
        severity: 'attention',
        summary: !analysis.target
          ? 'No active career target is set — career guidance stays factual only until one exists.'
          : (asArray(analysis.targetSkillIds).length === 0
            ? 'The active career target has no capabilities mapped to it yet.'
            : 'No current evidence supports the capabilities linked to the active career target.'),
        detail: nextAction ? `Suggested setup step: ${clean(nextAction.title)}.` : '',
        evidence: analysis.target
          ? [{ label: 'Career target', value: clean(analysis.target.title), source: 'Capability profile' }]
          : []
      });
    }

    for (const stall of dedupeStalls(sortStalls(analysis.stalls))) {
      signals.push({
        id: `capability-stall::${stall.type}::${stall.skillId || stall.projectId || 'general'}`,
        domain: 'capability',
        severity: 'attention',
        summary: clean(stall.message),
        detail: clean(stall.reason),
        evidence: [{ label: 'Career signal', value: stall.type, source: 'Capability profile' }]
      });
    }

    const nextAction = isPlainObject(analysis.nextAction) ? analysis.nextAction : null;
    if (nextAction && nextAction.kind === 'continue') {
      signals.push({
        id: 'capability-momentum-ok',
        domain: 'capability',
        severity: 'info',
        summary: clean(nextAction.reason, 'Target skills have evidence across multiple dimensions and no conservative stall was detected.'),
        detail: '',
        evidence: []
      });
    }
  }

  // Focus is live, so it may add CONTEXT — never a productivity verdict. Only emitted when
  // there is real focus history; "no focus session today" is never an attention signal.
  const focus = characterSheet.focus || {};
  if (focus.status === 'data' && coverage.focus && coverage.focus.evaluated) {
    const week = focus.last7Days || {};
    signals.push({
      id: 'focus-context',
      domain: 'focus',
      severity: 'info',
      summary: `${week.sessions || 0} focus ${(week.sessions || 0) === 1 ? 'session' : 'sessions'} recorded in the last 7 days (ChronaSense).`,
      detail: (focus.today && focus.today.sessions)
        ? `${focus.today.sessions} today.`
        : 'No ChronaSense focus session recorded today — this is context only, not a judgement.',
      evidence: [{ label: 'Focus, last 7 days', value: String(week.sessions || 0), source: 'Life Character Sheet' }]
    });
  }

  return signals.sort((a, b) => {
    const severityRank = s => (s === 'attention' ? 0 : 1);
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) return sev;
    const domain = (DOMAIN_TIEBREAK[a.domain] ?? 9) - (DOMAIN_TIEBREAK[b.domain] ?? 9);
    if (domain !== 0) return domain;
    return String(a.id).localeCompare(String(b.id));
  });
}

// ── Explanation (every sentence traceable to a model fact) ────────────────────────────────

function decorate(candidate, analysisState) {
  const analysis = analysisState.analysis;
  const why = [];
  const evidence = [];

  if (candidate.sourceKind === 'learning-plan-step') {
    why.push(`It is the next unfinished step in ${quoted(candidate.planTitle, 'your active learning plan')} (${stepsPhrase(candidate._facts.completedSteps, candidate._facts.totalSteps)}).`);
    evidence.push({ label: 'Active learning plan', value: `${candidate.planTitle} — ${stepsPhrase(candidate._facts.completedSteps, candidate._facts.totalSteps)}`, source: 'Life Character Sheet' });
    evidence.push({ label: 'Next unfinished step', value: candidate.title, source: 'findNextLearningPlanStep' });
    if (candidate.alignment.aligned) {
      why.push(`Your Capability profile links completed steps of this plan to the career target ${quoted(analysis && analysis.target && analysis.target.title, 'you set')}.`);
      evidence.push(...candidate.alignment.evidence);
    } else if (analysis && !analysis.target) {
      why.push('No active career target is set, so this ranks as plan progress rather than target-aligned work.');
    } else if (!candidate._facts.activelyTracked) {
      why.push('This plan was selected as the most recently updated one; no recent Ledger completion maps to it, so confidence is lower.');
    }
  } else if (candidate.sourceKind === 'capability-next-action') {
    if (candidate._facts.analyzerReason) why.push(candidate._facts.analyzerReason);
    if (candidate._facts.anchorTitle) {
      why.push(`It points at ${quoted(candidate._facts.anchorTitle)}, which has work evidence but is not portfolio-ready.`);
      evidence.push({ label: 'Project', value: candidate._facts.anchorTitle, source: 'Capability profile' });
    }
    // the exact stall analyzeCapabilityCareer() acted on to produce this nextAction
    const stall = analysis ? drivingStall(analysis) : null;
    if (stall && STALL_HUMAN[stall.type]) {
      why.push(`The Career profile currently flags ${STALL_HUMAN[stall.type]} on a target capability.`);
      evidence.push({ label: 'Career signal', value: stall.type, source: 'analyzeCapabilityCareer' });
    }
    if (candidate._facts.targetTitle) {
      evidence.push({ label: 'Career target', value: candidate._facts.targetTitle, source: 'Capability profile' });
    }
  }

  return {
    candidateId: candidate.candidateId,
    sourceKind: candidate.sourceKind,
    sourceId: candidate.sourceId,
    domain: candidate.domain,
    action: candidate.action,
    title: candidate.title,
    context: candidate.context,
    rationaleKind: candidate.rationaleKind,
    priorityClass: candidate.priorityClass,
    priorityClassLabel: PRIORITY_CLASS_LABEL[candidate.priorityClass] || '',
    evidenceStrength: candidate.evidenceStrength,
    aligned: candidate.alignment.aligned,
    homeView: candidate.homeView,
    why: why.filter(Boolean).slice(0, 3),
    evidence
  };
}

function outrankReason(winner, other) {
  if (winner.priorityClass !== other.priorityClass) {
    return `${winner.priorityClassLabel} (tier ${winner.priorityClass}) outranks ${other.priorityClassLabel || 'tier ' + other.priorityClass} (tier ${other.priorityClass}).`;
  }
  if (STRENGTH_RANK[winner.evidenceStrength] !== STRENGTH_RANK[other.evidenceStrength]) {
    return `Same priority tier, but the recommended action has ${winner.evidenceStrength} evidence strength vs ${other.evidenceStrength}.`;
  }
  return 'Same priority tier and evidence strength; ordered by a stable domain / identifier tie-break.';
}

// ── Public entry point ───────────────────────────────────────────────────────────────────

/**
 * Build the Cross-Domain Intelligence snapshot.
 *
 * @param {object}  input
 * @param {object}  input.characterSheet      Output of buildLifeCharacterSheet() — REQUIRED.
 * @param {Array}   [input.ledgerEvents]      The SAME raw events the Character Sheet was built from.
 * @param {object}  [input.capabilityProfile] capabilityCareerRepository.loadProfile().
 * @param {Array}   [input.learningPlans]     Accepted for call-site symmetry; the active plan
 *                                            and next step are read off the Character Sheet.
 * @returns {object} A pure derived snapshot. Never persisted as a new truth store.
 */
export function buildCrossDomainIntelligence(input = {}) {
  const characterSheet = input.characterSheet;
  if (!isPlainObject(characterSheet)
    || typeof characterSheet.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(characterSheet.generatedAt))) {
    throw new Error('buildCrossDomainIntelligence requires a Life Character Sheet snapshot');
  }
  const ledgerEvents = asArray(input.ledgerEvents);
  const capabilityProfile = isPlainObject(input.capabilityProfile) ? input.capabilityProfile : null;

  const generatedAt = characterSheet.generatedAt;
  const referenceTimeZone = characterSheet.referenceTimeZone || 'Etc/UTC';
  const todayKey = characterSheet.todayKey || null;

  const coverage = coverageView(characterSheet);

  // Same canonical current-truth projection the Character Sheet used internally — rebuilt
  // from the same inputs, so it is parity, not a competing derivation.
  const feed = buildLifeFeed(ledgerEvents, { now: new Date(generatedAt), referenceTimeZone });
  const rawById = highestRevisionById(ledgerEvents);

  // Same analyzer call, same arguments the Character Sheet used → guaranteed parity.
  const analysisState = runCapabilityAnalysis(capabilityProfile, generatedAt, ledgerEvents);
  const analysis = analysisState.analysis;

  const activePlanId = characterSheet.learning
    && characterSheet.learning.activePlan
    && characterSheet.learning.activePlan.id
    ? characterSheet.learning.activePlan.id
    : null;
  const alignment = learningAlignment(activePlanId, feed, rawById, capabilityProfile, analysis);

  const rawCandidates = [
    learningCandidate(characterSheet, alignment),
    capabilityCandidate(analysisState, coverage)
  ].filter(Boolean);

  const ranked = dedupeCandidates(rankCandidates(rawCandidates));
  const decorated = ranked.map(candidate => decorate(candidate, analysisState));
  const recommendedAction = decorated.length ? decorated[0] : null;
  const alternatives = decorated.slice(1, 3).map(alt => ({
    ...alt,
    outrankedBy: recommendedAction
      ? { candidateId: recommendedAction.candidateId, reason: outrankReason(recommendedAction, alt) }
      : null
  }));

  const signals = buildSignals(characterSheet, analysisState, coverage);
  const blocked = blockedDomains(coverage);

  let abstentionReason = null;
  if (!recommendedAction) {
    const attentionSignals = signals.filter(s => s.severity === 'attention');
    abstentionReason = attentionSignals.length
      ? 'There are attention areas below, but no bounded next action is explicitly defined yet. Nothing is being invented to fill the slot.'
      : 'No active learning plan step and no explicit career action are available, so there is no cross-domain recommendation yet.';
  }

  const explanation = recommendedAction
    ? {
      headline: recommendedAction.action,
      reasons: recommendedAction.why,
      evidence: recommendedAction.evidence,
      notEvaluated: blocked.map(d => d.label),
      confidence: recommendedAction.evidenceStrength
    }
    : {
      headline: 'No cross-domain recommendation yet',
      reasons: [abstentionReason],
      evidence: [],
      notEvaluated: blocked.map(d => d.label),
      confidence: CDI_EVIDENCE_STRENGTH.INSUFFICIENT
    };

  return {
    generatedAt,
    referenceTimeZone,
    todayKey,
    coverage,
    capability: analysis
      ? {
        readable: true,
        present: analysisState.present,
        target: analysis.target ? { title: clean(analysis.target.title) } : null,
        targetSkillIds: asArray(analysis.targetSkillIds).slice(),
        stalls: dedupeStalls(sortStalls(analysis.stalls)).map(s => ({
          type: s.type, severity: s.severity, skillId: s.skillId || null, projectId: s.projectId || null,
          message: clean(s.message), reason: clean(s.reason)
        })),
        nextActionKind: isPlainObject(analysis.nextAction) ? analysis.nextAction.kind : null,
        dimensionTotals: { ...analysis.dimensionTotals },
        insufficientData: !!analysis.insufficientData
      }
      : { readable: analysisState.readable, present: analysisState.present, target: null, targetSkillIds: [], stalls: [], nextActionKind: null, dimensionTotals: null, insufficientData: true },
    signals,
    candidates: decorated,
    recommendedAction,
    alternatives,
    blockedDomains: blocked,
    abstained: !recommendedAction,
    abstentionReason,
    explanation
  };
}
