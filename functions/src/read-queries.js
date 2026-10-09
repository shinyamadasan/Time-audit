import '../shared/evidence-interpretation.js';
import { buildIntelligence, RECENT_DAYS } from '../shared/intelligence-read-model.js';
import { addCalendarDays } from '../shared/plan-tomorrow-model.js';
import { calendarPlanId, calendarPlanInterval } from '../shared/calendar-plan-model.js';
import { normalizeCapture } from '../shared/brain-dump-model.js';
import { normalizeCommitment } from '../shared/commitments-model.js';
import { validateCoarseEvidenceRecord } from '../shared/coarse-life-evidence-model.js';
import { getBrainDump } from './brain-dump-query.js';
import { ApiError } from './errors.js';
import { createPlanRead } from './plan-read.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const conflict = source => new ApiError('CONFLICT', `The ${source} source contains incompatible data.`, { reason: `malformed-${source}` });
const readAt = nowMs => new Date(nowMs).toISOString();

async function records(domain, identity, name, validate) {
  const store = await domain.readRoomCollection(identity, name);
  if (store !== null && !object(store)) throw conflict(name);
  const out = [];
  for (const [key, raw] of Object.entries(store || {})) {
    let value;
    try { value = validate(raw); } catch { throw conflict(name); }
    if (!value || value.id !== key) throw conflict(name);
    out.push(value);
  }
  return out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function entryRange(e, fallback) {
  if (!Number.isFinite(e?.ts)) return null;
  const segmentSeconds = Array.isArray(e.segments) ? e.segments.reduce((n, segment) => n + (Number(segment?.duration) || 0), 0) : 0;
  const minutes = segmentSeconds > 0 ? Math.max(1, Math.round(segmentSeconds / 60))
    : Number.isFinite(Number(e.blockIntervalMin)) && Number(e.blockIntervalMin) > 0 ? Math.round(Number(e.blockIntervalMin)) : fallback;
  const startMs = e.tsStart ? Number(e.tsStart) : e.ts - minutes * 60000;
  return Number.isFinite(startMs) && startMs < e.ts ? { startMs, endMs: e.ts } : null;
}

async function entries(domain, identity, fallback) {
  const store = await domain.readRoomCollection(identity, 'entries');
  if (store !== null && !object(store)) throw conflict('entries');
  const out = [];
  for (const [key, e] of Object.entries(store || {})) {
    if (!object(e) || (typeof e.id !== 'string' && typeof e.id !== 'number') || key !== `e_${e.id}`
        || (e.deleted !== undefined && e.deleted !== true)
        || (e.missed !== undefined && typeof e.missed !== 'boolean')) throw conflict('entries');
    if (e.deleted === true || e.missed === true) continue; // These markers assert no eligible interval.
    if (typeof e.activity !== 'string' || !e.activity.trim()) throw conflict('entries');
    const range = entryRange(e, fallback);
    if (!range) throw conflict('entries');
    out.push({ id: String(e.id), title: e.activity, ...range, planItemId: e.planItemId || null,
      eligible: !e.deleted && !e.missed && globalThis.hasConfirmedEnergyClassification(e) });
  }
  return out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function intelligencePlan(plan) {
  const { target } = plan;
  const evidenceEndMs = target.store === 'calendar'
    ? plan.items.reduce((end, item) => Math.max(end, item.endMs ?? item.startMs ?? end),
      calendarPlanInterval(addCalendarDays(target.date, 1), target.timezone).endMs) : target.endMs;
  return { id: target.id, date: target.date, timezone: target.timezone,
    startMs: target.startMs, endMs: target.endMs, evidenceEndMs,
    items: plan.items.map(item => ({ ...item, id: item.itemId })) };
}

async function intelligenceInput(identity, { domain, nowMs }) {
  const planReader = await createPlanRead(identity, { domain, nowMs });
  const plan = await planReader.read();
  const stale = await planReader.stale();
  const settings = await domain.readRoomCollection(identity, 'settings');
  const fallbackMinutes = Number.isFinite(settings?.intervalMin) && settings.intervalMin > 0 ? settings.intervalMin : 30;
  const days = Array.from({ length: RECENT_DAYS }, (_, n) => {
    const date = addCalendarDays(planReader.today, -n);
    return { date, ...calendarPlanInterval(date, planReader.timezone) };
  });
  const [rawEntries, captures, commitments, coarse] = await Promise.all([
    entries(domain, identity, fallbackMinutes),
    records(domain, identity, 'brainDump', normalizeCapture),
    records(domain, identity, 'commitments', normalizeCommitment),
    records(domain, identity, 'coarseLifeEvidence', value => { validateCoarseEvidenceRecord(value); return value; }),
  ]);
  const plans = [intelligencePlan(plan)];
  if (plan.target.store === 'calendar') {
    const previousDate = addCalendarDays(planReader.today, -1);
    try {
      const prior = await planReader.read({ store: 'calendar', id: calendarPlanId(previousDate) });
      const landing = prior.items.filter(item => item.startMs !== null
        && item.startMs >= days[0].startMs && item.startMs < days[0].endMs);
      if (landing.length) plans.push(intelligencePlan({ ...prior, items: landing }));
    } catch (error) {
      if (error?.code !== 'NOT_FOUND') throw error;
    }
  }
  return { plan, input: { owner: identity.roomId, contextOwner: identity.roomId, now: nowMs,
    timezone: planReader.timezone, today: planReader.today, days, entries: rawEntries, captures,
    commitments, coarse, plans, planAuthority: 'known', stale: stale.items, routines: null,
    notes: [...stale.notes, 'Device-local routine completion is not evaluated by this server read.',
      'Live timer state is not included in this server snapshot.'] } };
}

export async function getPlan(identity, { domain, nowMs, parameters }) {
  const reader = await createPlanRead(identity, { domain, nowMs });
  const plan = await reader.read(parameters.target);
  return { result: { plan }, authority: { authority: 'plan_authority', access: 'user_scoped',
    store: plan.target.store, targetId: plan.target.id, readAt: readAt(nowMs) } };
}

export async function getIntelligence(identity, deps) {
  const { input } = await intelligenceInput(identity, deps);
  const view = buildIntelligence(input);
  if (view.state !== 'ready') throw conflict('intelligence context');
  return { result: { view }, authority: { authority: 'intelligence_v1_derived',
    access: 'user_scoped', sources: ['plan_authority', 'entries', 'brainDump', 'commitments', 'coarseLifeEvidence'],
    readAt: readAt(deps.nowMs) } };
}

export async function getToday(identity, deps) {
  const { plan, input } = await intelligenceInput(identity, deps);
  const view = buildIntelligence(input);
  if (view.state !== 'ready') throw conflict('today context');
  return { result: { date: input.today, timezone: input.timezone, plan,
    attention: view.attention, notes: view.notes }, authority: {
    authority: 'today_attention_derived', access: 'user_scoped', targetId: plan.target.id,
    readAt: readAt(deps.nowMs) } };
}

export async function getItem(identity, { domain, nowMs, parameters }) {
  if (parameters.source === 'brain_dump') {
    const { result } = await getBrainDump(identity, { domain, nowMs });
    const item = result.captures.find(capture => capture.captureId === parameters.id);
    if (!item) throw new ApiError('NOT_FOUND', 'That capture does not exist.', { reason: 'capture-absent' });
    return { result: { source: 'brain_dump', item }, authority: { authority: 'brain_dump_capture',
      access: 'user_scoped', recordIds: [parameters.id], readAt: readAt(nowMs) } };
  }
  const reader = await createPlanRead(identity, { domain, nowMs });
  const plan = await reader.read(parameters.target);
  const item = plan.items.find(candidate => candidate.itemId === parameters.id);
  if (!item) {
    const inactive = await reader.inactiveItem(parameters.target, parameters.id);
    if (inactive) return { result: { source: 'plan', target: plan.target, ...inactive },
      authority: { authority: 'plan_authority', access: 'user_scoped', targetId: plan.target.id,
        recordIds: [parameters.id], readAt: readAt(nowMs) } };
    throw new ApiError('NOT_FOUND', 'That plan item does not exist.', { reason: 'plan-item-absent' });
  }
  return { result: { source: 'plan', target: plan.target, item }, authority: { authority: 'plan_authority',
    access: 'user_scoped', targetId: plan.target.id, recordIds: [item.itemId], readAt: readAt(nowMs) } };
}
