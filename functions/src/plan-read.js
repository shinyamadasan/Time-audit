// Read-only server projection of the same calendar/legacy/operational routing facts used by PlanAuthority.
// Every collection name is fixed here and enforced again by user-scoped-rtdb.js. No request supplies a path.
import { createHash } from 'node:crypto';

import { calendarAuthorityForDate, calendarItemInstants, calendarPlanId, calendarPlanInterval, mergeCalendarPlanRecords,
  effectiveActivation, parseCalendarPlanId, validateActivationFact, validateCalendarPlanItem } from '../shared/calendar-plan-model.js';
import { activeBoundaryRevision, legacyBoundaryRevision, normalizeBoundaryRevisionHistory,
  operationalDayContaining, operationalDayId, operationalDayInterval, parseOperationalDayId } from '../shared/personal-day-boundary-model.js';
import { mergeOperationalPlanRecords, resolvePlanAuthority, validateOperationalPlanItemRange } from '../shared/operational-plan-model.js';
import { localPlanDate, mergeDatePlans, validPlanDate, validPlanTimezone } from '../shared/plan-tomorrow-model.js';
import { captureIdOfPlanItem, isFencedItem, mergeFencedItem, physicalTargetKey } from '../shared/plan-item-origin.js';
import { canonicalPlanItemRelocations, normalizePlanItemRelocation, planItemIsActiveInDay } from '../shared/plan-item-relocation.js';
import { collectRecoveryConflicts, collectStaleUnfinished } from '../shared/stale-plan-recovery-model.js';
import { canonicalize } from './canonical-json.js';
import { ApiError } from './errors.js';

const malformed = what => new ApiError('CONFLICT', `The ${what} authority contains incompatible data.`, { reason: `malformed-${what.replaceAll(' ', '-')}` });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const revision = value => `rev1:${createHash('sha256').update(canonicalize(value), 'utf8').digest('base64url')}`;
const validDate = value => { try { return validPlanDate(value); } catch { return false; } };

async function collection(domain, identity, name) {
  const value = await domain.readRoomCollection(identity, name);
  if (value !== null && !object(value)) throw malformed(name);
  return value || {};
}

function rawPlanItems(record, fences, store, targetId, targetKey) {
  const raw = record?.items ?? [];
  if (!Array.isArray(raw) && !object(raw)) throw malformed('plan items');
  const byId = new Map();
  for (const item of Object.values(raw)) {
    if (item === null) continue; // Firebase prunes empty array slots.
    if (!object(item) || typeof item.id !== 'string' || !item.id || typeof item.task !== 'string' || !item.task.trim()
        || (item.done !== undefined && typeof item.done !== 'boolean') || (item.deleted !== undefined && typeof item.deleted !== 'boolean')) throw malformed('plan items');
    if (byId.has(item.id)) throw malformed('plan item identity');
    byId.set(item.id, item);
  }
  if (fences !== undefined) {
    if (!object(fences)) throw malformed('plan fences');
    for (const [id, item] of Object.entries(fences)) {
      if (!object(item) || item.id !== id || !isFencedItem(item) || item.brainDumpOrigin.store !== store
          || item.brainDumpOrigin.targetKey !== targetKey) throw malformed('plan fences');
      const old = byId.get(id);
      const choose = (a, b) => (store === 'calendar' ? mergeCalendarPlanRecords({ items: [a] }, { items: [b] }, targetId)
        : store === 'operational' ? mergeOperationalPlanRecords({ items: [a] }, { items: [b] }, targetId)
          : mergeDatePlans({ items: [a] }, { items: [b] }, targetId)).items[0];
      byId.set(id, old ? mergeFencedItem(old, item, choose) : item);
    }
  }
  return [...byId.values()];
}

function planItems(rawItems, canonical, targetId, store, targetKey, date, ref, history) {
  const projected = [];
  for (const item of rawItems) {
    let instants = null;
    if (store === 'calendar') {
      if (!validateCalendarPlanItem(date, item).ok) throw malformed('calendar plan item');
      const result = calendarItemInstants(date, item);
      if (result.timed) instants = { startMs: result.startMs, endMs: result.endMs };
    } else if (store === 'operational') {
      const result = validateOperationalPlanItemRange(ref, item, history);
      if (!result.ok) throw malformed('operational plan item');
      if (Number.isFinite(result.startMs)) instants = { startMs: result.startMs, endMs: result.endMs ?? null };
    }
    if (!planItemIsActiveInDay(item, targetId, canonical)) continue;
    projected.push({ itemId: item.id, task: item.task, kind: item.kind || 'priority', done: item.done === true,
      when: item.when || null, whenDayOffset: item.whenDayOffset || 0, whenTz: item.whenTz || null,
      durationMinutes: item.durationMinutes ?? null, startMs: instants?.startMs ?? null, endMs: instants?.endMs ?? null,
      sourceCaptureId: isFencedItem(item) ? captureIdOfPlanItem(item.id) : null,
      revision: revision({ v: 1, store, targetKey, item }) });
  }
  return projected.sort((a, b) => compare(a.itemId, b.itemId));
}

function validateRelocations(dayRecords) {
  const validDay = id => validDate(id) || !!parseCalendarPlanId(id) || !!parseOperationalDayId(id);
  const claims = new Map();
  for (const [dayId, record] of Object.entries(dayRecords)) {
    for (const item of record.items) {
      if (!Object.hasOwn(item, 'relocationRevision')) continue;
      const relocation = normalizePlanItemRelocation(item);
      if (!relocation || !validDay(relocation.fromDayId) || !validDay(relocation.toDayId)
          || (dayId !== relocation.fromDayId && dayId !== relocation.toDayId)
          || (item.movedToDayId !== undefined && item.movedToDayId !== relocation.toDayId)
          || (item.carriedFromDayId !== undefined && item.carriedFromDayId !== relocation.fromDayId)) {
        throw malformed('plan relocation');
      }
      if (dayId === relocation.fromDayId && !dayRecords[relocation.toDayId]?.items.some(candidate =>
        candidate.id === item.id && normalizePlanItemRelocation(candidate))) throw malformed('plan relocation');
      if (dayId === relocation.toDayId && !dayRecords[relocation.fromDayId]?.items.some(candidate =>
        candidate.id === (item.carriedFromId || item.id))) throw malformed('plan relocation');
      const current = claims.get(item.id);
      if (!current || relocation.sequence > current.sequence) claims.set(item.id, {
        sequence: relocation.sequence, fromDayId: relocation.fromDayId, toDayId: relocation.toDayId, conflict: false });
      else if (relocation.sequence === current.sequence &&
          (relocation.fromDayId !== current.fromDayId || relocation.toDayId !== current.toDayId)) current.conflict = true;
    }
  }
  if ([...claims.values()].some(claim => claim.conflict)) throw malformed('plan relocation');
}

export async function createPlanRead(identity, { domain, nowMs }) {
  const settings = await collection(domain, identity, 'settings');
  const timezone = settings.timezone;
  if (!validPlanTimezone(timezone)) throw new ApiError('CONFLICT', 'The account timezone is unavailable.', { reason: 'timezone-unknown' });
  const facts = await collection(domain, identity, 'calendarPlanAuthority');
  for (const [key, fact] of Object.entries(facts)) if (key !== fact?.id || !validateActivationFact(fact)) throw malformed('calendar activation');
  const activation = effectiveActivation(Object.values(facts));
  const storedHistory = await collection(domain, identity, 'dayBoundaryRevisions');
  for (const [key, value] of Object.entries(storedHistory)) if (key !== value?.id) throw malformed('day boundary');
  let history;
  try { history = normalizeBoundaryRevisionHistory(Object.keys(storedHistory).length
    ? Object.values(storedHistory) : [legacyBoundaryRevision(timezone)]); }
  catch { throw malformed('day boundary'); }
  const today = localPlanDate(nowMs, timezone);
  let dayRecordsPromise;

  function resolveCurrent() {
    if (calendarAuthorityForDate(today, activation) === 'calendar') return { store: 'calendar', id: calendarPlanId(today), date: today };
    const ref = operationalDayContaining(nowMs, history);
    const authority = resolvePlanAuthority(ref, history);
    return authority.store === 'legacy'
      ? { store: 'legacy', id: authority.dateKey, date: authority.dateKey, ref }
      : { store: 'operational', id: authority.operationalDayId, date: ref.boundaryStartDate, ref };
  }

  function resolveExact(target) {
    if (!object(target) || Object.keys(target).sort().join(',') !== 'id,store' || typeof target.id !== 'string') throw new ApiError('INVALID_INPUT', 'An exact plan target is required.', { reason: 'plan-target' });
    if (target.store === 'calendar') {
      const date = parseCalendarPlanId(target.id);
      if (!date || calendarAuthorityForDate(date, activation) !== 'calendar') throw new ApiError('NOT_FOUND', 'That plan target is not authoritative.', { reason: 'plan-target' });
      return { store: 'calendar', id: target.id, date };
    }
    if (target.store === 'operational') {
      const ref = parseOperationalDayId(target.id);
      if (!ref) throw new ApiError('INVALID_INPUT', 'Invalid operational plan identity.', { reason: 'plan-target' });
      try {
        const interval = operationalDayInterval(ref, history);
        if (resolvePlanAuthority(ref, history).store !== 'operational' || operationalDayId(ref) !== target.id
            || !Number.isFinite(interval.startMs)) throw new Error('wrong authority');
      } catch { throw new ApiError('NOT_FOUND', 'That plan target is not authoritative.', { reason: 'plan-target' }); }
      return { store: 'operational', id: target.id, date: ref.boundaryStartDate, ref };
    }
    if (target.store === 'legacy' && validDate(target.id)) {
      return { store: 'legacy', id: target.id, date: target.id };
    }
    throw new ApiError('INVALID_INPUT', 'Unsupported plan target.', { reason: 'plan-target' });
  }

  function loadDayRecords() {
    if (dayRecordsPromise) return dayRecordsPromise;
    dayRecordsPromise = (async () => {
    const [allLegacy, allOperational, allCalendar,
      allLegacyFences, allOperationalFences, allCalendarFences] = await Promise.all([
      collection(domain, identity, 'plans'), collection(domain, identity, 'operationalPlans'),
      collection(domain, identity, 'calendarPlans'), collection(domain, identity, 'planFences'),
      collection(domain, identity, 'operationalPlanFences'), collection(domain, identity, 'calendarPlanFences'),
    ]);
    const stores = { legacy: allLegacy, operational: allOperational, calendar: allCalendar };
    const fences = { legacy: allLegacyFences, operational: allOperationalFences, calendar: allCalendarFences };
    const dayRecords = {};
    for (const [kind, stored, fenced] of [
      ['legacy', stores.legacy, fences.legacy], ['operational', stores.operational, fences.operational],
      ['calendar', stores.calendar, fences.calendar],
    ]) {
      for (const physicalKey of new Set([...Object.keys(stored), ...Object.keys(fenced)])) {
        let id = physicalKey;
        if (kind === 'operational') {
          try { id = Buffer.from(physicalKey, 'base64url').toString('utf8'); } catch { throw malformed('operational plan identity'); }
          if (!parseOperationalDayId(id) || physicalTargetKey(kind, id) !== physicalKey) throw malformed('operational plan identity');
        } else if (kind === 'calendar' ? !parseCalendarPlanId(id) : !validDate(id)) throw malformed('plan identity');
        if (stored[physicalKey] !== undefined && !object(stored[physicalKey])) throw malformed('plan record');
        dayRecords[id] = { items: rawPlanItems(stored[physicalKey], fenced[physicalKey], kind, id, physicalKey) };
      }
    }
    validateRelocations(dayRecords);
    if (collectRecoveryConflicts(dayRecords).length) throw malformed('plan recovery');
    const canonical = canonicalPlanItemRelocations(dayRecords);
    return { stores, fences, dayRecords, canonical };
    })();
    return dayRecordsPromise;
  }

  async function read(targetParameter) {
    const target = targetParameter ? resolveExact(targetParameter) : resolveCurrent();
    const key = physicalTargetKey(target.store, target.id);
    if (!key) throw malformed('plan target');
    const { stores, fences: allFences, canonical } = await loadDayRecords();
    const records = stores[target.store];
    const fences = allFences[target.store];
    const record = records[key] ?? null;
    if (record !== null && !object(record)) throw malformed('plan record');
    const homeZone = target.store === 'calendar' ? record?.timezone || timezone : target.ref?.timezone || timezone;
    if (!validPlanTimezone(homeZone)) throw malformed('plan timezone');
    let interval;
    try { interval = target.store === 'operational'
      ? operationalDayInterval(target.ref, history) : calendarPlanInterval(target.date, homeZone); }
    catch { throw malformed('plan interval'); }
    const items = planItems(rawPlanItems(record, fences[key], target.store, target.id, key), canonical,
      target.id, target.store, key, target.date, target.ref, history);
    return { target: { store: target.store, id: target.id, date: target.date, timezone: homeZone,
      startMs: interval.startMs, endMs: interval.endMs,
      boundaryTime: target.store === 'operational' ? activeBoundaryRevision(history, interval.startMs).boundaryTime : '00:00' },
      items, state: record === null && fences[key] === undefined ? 'absent' : 'present',
      revision: revision({ v: 1, store: target.store, targetKey: key, record, fences: fences[key] ?? null }) };
  }

  async function stale() {
    const { dayRecords, canonical, stores } = await loadDayRecords();
    const days = [];
    for (const [id, record] of Object.entries(dayRecords)) {
      let store, dateKey, homeZone, interval;
      if (parseCalendarPlanId(id)) {
        store = 'calendar'; dateKey = parseCalendarPlanId(id);
        homeZone = stores.calendar[id]?.timezone || timezone;
        if (!validPlanTimezone(homeZone)) throw malformed('plan timezone');
        interval = calendarPlanInterval(dateKey, homeZone);
        if (record.items.some(item => !validateCalendarPlanItem(dateKey, item).ok)) throw malformed('calendar plan item');
      } else if (parseOperationalDayId(id)) {
        store = 'operational';
        const ref = parseOperationalDayId(id);
        dateKey = ref.boundaryStartDate; homeZone = ref.timezone;
        try { interval = operationalDayInterval(ref, history); } catch { throw malformed('operational plan interval'); }
        if (record.items.some(item => !validateOperationalPlanItemRange(ref, item, history).ok)) throw malformed('operational plan item');
      } else {
        store = 'legacy'; dateKey = id; homeZone = timezone;
        interval = calendarPlanInterval(dateKey, homeZone);
      }
      const target = { id, store, dateKey, timezone: homeZone, ...interval,
        ...(store !== 'calendar' && activation ? { supersededAtMs: activation.activatedAtMs } : {}) };
      days.push({ target, record: { items: record.items.filter(item => item.deleted || planItemIsActiveInDay(item, id, canonical)) } });
    }
    const result = collectStaleUnfinished({ nowMs, days,
      dayRecords: Object.fromEntries(days.map(day => [day.target.id, day.record])),
      itemEndMs: (target, item) => {
        if (target.store !== 'calendar') return null;
        const instant = calendarItemInstants(target.dateKey, item);
        if (!instant.ok) throw malformed('calendar plan item');
        return instant.timed ? instant.endMs ?? instant.startMs : null;
      } });
    return { items: result.items.map(({ item, target }) => ({ id: `${target.id}:${item.id}`,
      itemId: item.id, planId: target.id, task: item.task, date: target.dateKey })),
    notes: result.unresolvable.length ? ['Some unfinished plans have unresolved day boundaries.'] : [] };
  }

  async function inactiveItem(targetParameter, itemId) {
    const target = resolveExact(targetParameter);
    const { dayRecords, canonical } = await loadDayRecords();
    const raw = dayRecords[target.id]?.items.find(item => item.id === itemId);
    if (!raw) return null;
    if (raw.deleted === true) return { state: 'tombstoned', itemId };
    const selected = canonical.get(itemId)?.relocationRevision;
    if (selected && selected.toDayId !== target.id) return { state: 'relocated', itemId, destinationTargetId: selected.toDayId };
    return { state: 'inactive', itemId };
  }

  return { today, timezone, read, stale, inactiveItem };
}
