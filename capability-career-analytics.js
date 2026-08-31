import {
  CAPABILITY_EVIDENCE_DIMENSIONS,
  hydrateCapabilityProfile
} from './capability-career-model.js';

export const CAPABILITY_CAREER_ANALYTICS_RULES = Object.freeze({
  recentDays: 30,
  staleDays: 45,
  shippingStaleDays: 60,
  portfolioStaleDays: 90,
  minimumEvidenceForStall: 2
});

function nowMs(options = {}) {
  const raw = typeof options.now === 'function' ? options.now() : options.now;
  const value = raw || new Date().toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('now must be a valid timestamp');
  return parsed;
}

function daysBetween(laterMs, iso) {
  return Math.floor((laterMs - Date.parse(iso)) / 86400000);
}

function activeItems(items) {
  return items.filter(item => item.status !== 'archived' && item.status !== 'paused');
}

function actionableProject(project) {
  return project.status !== 'archived' && project.status !== 'paused';
}

function primaryTarget(profile) {
  return profile.careerTargets.find(target => target.status === 'active' && target.priority === 'primary')
    || profile.careerTargets.find(target => target.status === 'active')
    || null;
}

function evidenceForSkill(evidence, skillId) {
  return evidence.filter(item => item.skillId === skillId);
}

function dimensionCounts(evidence) {
  return CAPABILITY_EVIDENCE_DIMENSIONS.reduce((out, dimension) => {
    out[dimension] = evidence.filter(item => item.dimension === dimension).length;
    return out;
  }, {});
}

function recentEvidence(evidence, now, days) {
  const windowMs = days * 86400000;
  return evidence.filter(item => {
    const ageMs = now - Date.parse(item.observedAt);
    return ageMs >= 0 && ageMs <= windowMs;
  });
}

function latestEvidenceDate(evidence) {
  return evidence.reduce((latest, item) => !latest || item.observedAt > latest ? item.observedAt : latest, '');
}

function lifeLedgerEventMap(options = {}) {
  const events = Array.isArray(options.lifeLedgerEvents) ? options.lifeLedgerEvents : [];
  return new Map(events.map(event => [event.eventId, event]));
}

function currentEvidenceScope(profile, now, options = {}) {
  const ledgerEvents = lifeLedgerEventMap(options);
  const current = [];
  const excluded = [];
  profile.evidence.forEach(evidence => {
    const observedMs = Date.parse(evidence.observedAt);
    let reason = '';
    if (!Number.isFinite(observedMs) || observedMs > now) reason = 'future';
    if (!reason && evidence.source === 'life-ledger') {
      const event = ledgerEvents.get(evidence.lifeLedgerEventId);
      if (!event) reason = 'life-ledger-unavailable';
      else if (event.tombstone?.active) reason = 'life-ledger-tombstoned';
    }
    if (reason) excluded.push({ evidence, reason });
    else current.push(evidence);
  });
  return { current, excluded };
}

function capabilitySignal(evidenceScope, skill, options = {}) {
  const rules = options.rules || CAPABILITY_CAREER_ANALYTICS_RULES;
  const now = options.nowMs;
  const evidence = evidenceForSkill(evidenceScope, skill.id);
  const recent = recentEvidence(evidence, now, rules.recentDays);
  const counts = dimensionCounts(evidence);
  const recentCounts = dimensionCounts(recent);
  const latest = latestEvidenceDate(evidence);
  let momentum = 'no-evidence';
  let momentumReason = 'No explicit evidence has been linked yet.';
  if (recent.length >= 2 && (recentCounts.execution || recentCounts.shipping || recentCounts.portfolio)) {
    momentum = 'growing';
    momentumReason = `${recent.length} evidence records in the last ${rules.recentDays} days, including execution/proof.`;
  } else if (recent.length > 0) {
    momentum = 'active';
    momentumReason = `${recent.length} evidence record${recent.length === 1 ? '' : 's'} in the last ${rules.recentDays} days.`;
  } else if (evidence.length > 0) {
    momentum = 'stale';
    momentumReason = `Most recent evidence is ${daysBetween(now, latest)} days old.`;
  }
  return {
    skillId: skill.id,
    skillName: skill.name,
    status: skill.status,
    counts,
    recentCounts,
    totalEvidence: evidence.length,
    latestEvidenceAt: latest || null,
    momentum,
    momentumReason
  };
}

function classifyLearningHeavy(signal) {
  return (signal.counts.knowledge + signal.counts.practice) >= 2
    && signal.counts.execution === 0
    && signal.counts.shipping === 0;
}

function hasRecentDimension(signal, dimension) {
  return (signal.recentCounts[dimension] || 0) > 0;
}

function detectSkillStalls(signal, isTargetSkill, options = {}) {
  const rules = options.rules || CAPABILITY_CAREER_ANALYTICS_RULES;
  const stalls = [];
  if (!isTargetSkill || signal.totalEvidence < rules.minimumEvidenceForStall) return stalls;
  if (signal.momentum === 'stale') {
    stalls.push({
      type: 'knowledge-stall',
      skillId: signal.skillId,
      severity: 'medium',
      message: `${signal.skillName} has no recent learning or practice evidence.`,
      reason: signal.momentumReason
    });
  }
  if (classifyLearningHeavy(signal)) {
    stalls.push({
      type: 'application-stall',
      skillId: signal.skillId,
      severity: 'medium',
      message: `${signal.skillName} evidence is learning-focused; no execution evidence is linked yet.`,
      reason: `${signal.counts.knowledge + signal.counts.practice} learning/practice records, 0 execution or shipping records.`
    });
  }
  if ((signal.counts.practice > 0 || signal.counts.knowledge > 0) && signal.counts.execution === 0 && signal.counts.shipping === 0) {
    stalls.push({
      type: 'execution-stall',
      skillId: signal.skillId,
      severity: 'medium',
      message: `${signal.skillName} has practice/learning evidence but no real-work execution proof yet.`,
      reason: 'Execution and shipping dimensions are both empty.'
    });
  }
  if (signal.counts.execution >= 2 && signal.counts.shipping === 0) {
    stalls.push({
      type: 'shipping-stall',
      skillId: signal.skillId,
      severity: 'medium',
      message: `${signal.skillName} has execution evidence but no shipping evidence.`,
      reason: `${signal.counts.execution} execution records are linked without shipping evidence.`
    });
  }
  if ((signal.counts.execution > 0 || signal.counts.shipping > 0) && signal.counts.portfolio === 0) {
    stalls.push({
      type: 'portfolio-stall',
      skillId: signal.skillId,
      severity: 'medium',
      message: `${signal.skillName} has work evidence but no portfolio proof.`,
      reason: 'Portfolio dimension is empty.'
    });
  }
  if (hasRecentDimension(signal, 'execution') && !hasRecentDimension(signal, 'shipping') && signal.counts.shipping > 0) {
    stalls.push({
      type: 'shipping-stall',
      skillId: signal.skillId,
      severity: 'low',
      message: `${signal.skillName} execution is recent; shipping evidence has not kept pace.`,
      reason: `No shipping evidence in the last ${rules.recentDays} days.`
    });
  }
  return stalls;
}

function projectSignals(profile, evidenceScope) {
  return profile.projects.map(project => {
    const projectEvidence = evidenceScope.filter(item => item.projectId === project.id);
    const counts = dimensionCounts(projectEvidence);
    const artifactCount = profile.artifacts.filter(item => item.projectId === project.id).length;
    return {
      projectId: project.id,
      title: project.title,
      status: project.status,
      actionable: actionableProject(project),
      portfolioStatus: project.portfolioStatus,
      skillIds: project.skillIds,
      toolIds: project.toolIds,
      artifactCount,
      evidenceCount: projectEvidence.length,
      counts
    };
  });
}

function detectCareerAlignmentStall(evidenceScope, targetSkillIds, target, signals) {
  if (!target) return [];
  if (targetSkillIds.size === 0) return [];
  const allEvidence = evidenceScope.length;
  if (allEvidence < 4) return [];
  const alignedEvidence = evidenceScope.filter(item => targetSkillIds.has(item.skillId)).length;
  if (alignedEvidence >= Math.ceil(allEvidence / 3)) return [];
  const activeTargetSkillSignals = signals.filter(signal => targetSkillIds.has(signal.skillId));
  if (activeTargetSkillSignals.some(signal => signal.totalEvidence > 0)) return [];
  return [{
    type: 'career-alignment-stall',
    severity: 'medium',
    message: 'Recent capability evidence is not connected to the active career target.',
    reason: `${alignedEvidence} of ${allEvidence} evidence records support target capabilities.`
  }];
}

function portfolioProjectStalls(projects) {
  return projects
    .filter(project => project.actionable && (project.counts.execution > 0 || project.counts.shipping > 0 || project.artifactCount > 0) && ['none', 'candidate'].includes(project.portfolioStatus))
    .map(project => ({
      type: 'portfolio-stall',
      projectId: project.projectId,
      severity: 'medium',
      message: `${project.title} has progress but is not portfolio-ready.`,
      reason: `Portfolio status is ${project.portfolioStatus}; artifacts linked: ${project.artifactCount}.`
    }));
}

function weakestTargetSkill(targetSkillIds, signals) {
  if (!targetSkillIds.size) return null;
  const byId = new Map(signals.map(signal => [signal.skillId, signal]));
  return Array.from(targetSkillIds)
    .map(id => byId.get(id))
    .filter(Boolean)
    .sort((a, b) => {
      const aProof = a.counts.execution + a.counts.shipping + a.counts.portfolio;
      const bProof = b.counts.execution + b.counts.shipping + b.counts.portfolio;
      if (aProof !== bProof) return aProof - bProof;
      if (a.totalEvidence !== b.totalEvidence) return a.totalEvidence - b.totalEvidence;
      return a.skillName.localeCompare(b.skillName);
    })[0] || null;
}

function chooseNextAction(target, targetSkillIds, currentTargetEvidence, signals, stalls, projects) {
  if (!target) {
    return {
      kind: 'setup-target',
      title: 'Define one active career target',
      reason: 'Career recommendations need an explicit target; ChronaSense will not infer one from activity history.',
      confidence: 'low'
    };
  }
  if (targetSkillIds.size === 0) {
    return {
      kind: 'map-target-skills',
      title: 'Map active capabilities to the career target',
      reason: `${target.title} has no linked active capability map yet.`,
      confidence: 'low'
    };
  }
  if (currentTargetEvidence.length === 0) {
    return {
      kind: 'setup-evidence',
      title: 'Add one explicit evidence record for a target skill',
      reason: `No current evidence supports the active skills linked to ${target.title}.`,
      confidence: 'low'
    };
  }

  const priority = ['portfolio-stall', 'shipping-stall', 'execution-stall', 'application-stall', 'knowledge-stall', 'career-alignment-stall'];
  const chosenStall = stalls.slice().sort((a, b) => {
    const byPriority = priority.indexOf(a.type) - priority.indexOf(b.type);
    if (byPriority !== 0) return byPriority;
    return (a.skillId || a.projectId || '').localeCompare(b.skillId || b.projectId || '');
  })[0];
  if (chosenStall?.type === 'portfolio-stall') {
    const project = chosenStall.projectId ? projects.find(item => item.projectId === chosenStall.projectId) : null;
    return {
      kind: 'portfolio-proof',
      title: project ? `Turn ${project.title} into presentable proof` : `Add portfolio proof for ${signals.find(s => s.skillId === chosenStall.skillId)?.skillName || 'a target skill'}`,
      reason: chosenStall.reason,
      confidence: 'medium'
    };
  }
  if (chosenStall?.type === 'shipping-stall') {
    return {
      kind: 'ship-project',
      title: `Ship or document completion for ${signals.find(s => s.skillId === chosenStall.skillId)?.skillName || 'a target capability'}`,
      reason: chosenStall.reason,
      confidence: 'medium'
    };
  }
  if (chosenStall?.type === 'execution-stall' || chosenStall?.type === 'application-stall') {
    return {
      kind: 'execute-skill',
      title: `Use ${signals.find(s => s.skillId === chosenStall.skillId)?.skillName || 'a target capability'} in a real project block`,
      reason: chosenStall.reason,
      confidence: 'medium'
    };
  }
  if (chosenStall?.type === 'knowledge-stall') {
    return {
      kind: 'refresh-skill',
      title: `Practice ${signals.find(s => s.skillId === chosenStall.skillId)?.skillName || 'a target capability'} again`,
      reason: chosenStall.reason,
      confidence: 'medium'
    };
  }

  const weak = weakestTargetSkill(targetSkillIds, signals);
  if (weak && weak.counts.portfolio === 0 && (weak.counts.execution > 0 || weak.counts.shipping > 0)) {
    return {
      kind: 'portfolio-proof',
      title: `Add portfolio evidence for ${weak.skillName}`,
      reason: `${weak.skillName} has execution/shipping evidence but no portfolio dimension yet.`,
      confidence: 'medium'
    };
  }
  if (weak && weak.totalEvidence === 0) {
    return {
      kind: 'setup-evidence',
      title: `Add first evidence for ${weak.skillName}`,
      reason: `${weak.skillName} is linked to ${target.title}, but has no evidence yet.`,
      confidence: 'low'
    };
  }
  return {
    kind: 'continue',
    title: 'Keep converting learning into shipped proof',
    reason: 'Target skills have evidence across multiple dimensions and no conservative stall was detected.',
    confidence: 'medium'
  };
}

export function analyzeCapabilityCareer(profileValue, options = {}) {
  const profile = hydrateCapabilityProfile(profileValue);
  const now = nowMs(options);
  const analysisOptions = { ...options, nowMs: now };
  const target = primaryTarget(profile);
  const activeSkillIds = new Set(activeItems(profile.skills).map(skill => skill.id));
  const targetSkillIds = new Set((target?.skillIds || []).filter(id => activeSkillIds.has(id)));
  const evidenceScope = currentEvidenceScope(profile, now, options);
  const currentTargetEvidence = evidenceScope.current.filter(evidence => targetSkillIds.has(evidence.skillId));
  const signals = activeItems(profile.skills).map(skill => capabilitySignal(evidenceScope.current, skill, analysisOptions));
  const projects = projectSignals(profile, evidenceScope.current);
  const stalls = [
    ...signals.flatMap(signal => detectSkillStalls(signal, targetSkillIds.has(signal.skillId), analysisOptions)),
    ...portfolioProjectStalls(projects),
    ...detectCareerAlignmentStall(evidenceScope.current, targetSkillIds, target, signals)
  ];
  const dimensionTotals = CAPABILITY_EVIDENCE_DIMENSIONS.reduce((out, dimension) => {
    out[dimension] = evidenceScope.current.filter(item => item.dimension === dimension).length;
    return out;
  }, {});
  return {
    target,
    targetSkillIds: Array.from(targetSkillIds),
    skills: signals,
    projects,
    stalls,
    dimensionTotals,
    currentEvidenceCount: evidenceScope.current.length,
    excludedEvidence: evidenceScope.excluded.map(item => ({
      evidenceId: item.evidence.id,
      source: item.evidence.source,
      reason: item.reason,
      lifeLedgerEventId: item.evidence.lifeLedgerEventId || null
    })),
    nextAction: chooseNextAction(target, targetSkillIds, currentTargetEvidence, signals, stalls, projects),
    insufficientData: !target || targetSkillIds.size === 0 || currentTargetEvidence.length === 0
  };
}
