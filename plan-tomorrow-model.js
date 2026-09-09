const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = new Set(['normal', 'rescue']);

export function validPlanDate(value) {
  return typeof value === 'string' && DATE.test(value)
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

export function validPlanTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function localPlanDate(now, timezone) {
  if (!validPlanTimezone(timezone)) throw new Error('A valid planning timezone is required.');
  const value = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(value.getTime())) throw new Error('A valid planning time is required.');
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(value);
}

export function addCalendarDays(date, amount) {
  if (!validPlanDate(date) || !Number.isInteger(amount)) throw new Error('A valid calendar date and whole-day offset are required.');
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function planTomorrowTargetDate(now, timezone) {
  return addCalendarDays(localPlanDate(now, timezone), 1);
}

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function mergeTimestamp(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}

function writer(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200 ? value : null;
}

function compareStrings(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

function ids(value) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id || id.length > 500)) return null;
  return [...new Set(value)].sort();
}

export function normalizePreparation(value, expectedTargetDate) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return null;
  if (!validPlanDate(value.targetDate) || (expectedTargetDate && value.targetDate !== expectedTargetDate)) return null;
  if (!validPlanTimezone(value.timezone) || !MODES.has(value.firstPreparedMode) || !MODES.has(value.lastPreparedMode)) return null;
  const firstPreparedAt = timestamp(value.firstPreparedAt);
  const lastPreparedAt = timestamp(value.lastPreparedAt);
  const updatedBy = writer(value.updatedBy);
  const routineInstanceIds = ids(value.routineInstanceIds);
  const oneOffItemIds = ids(value.oneOffItemIds);
  if (!firstPreparedAt || !lastPreparedAt || lastPreparedAt < firstPreparedAt || !updatedBy || !routineInstanceIds || !oneOffItemIds || typeof value.intentionalBlank !== 'boolean') return null;
  const normalized = {
    schemaVersion: 1,
    targetDate: value.targetDate,
    timezone: value.timezone,
    firstPreparedAt,
    firstPreparedMode: value.firstPreparedMode,
    lastPreparedAt,
    lastPreparedMode: value.lastPreparedMode,
    updatedBy,
    intentionalBlank: value.intentionalBlank,
    routineInstanceIds,
    oneOffItemIds
  };
  const firstPreparedBy = writer(value.firstPreparedBy);
  if (firstPreparedBy) normalized.firstPreparedBy = firstPreparedBy;
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function firstPreparationKey(value) {
  return `${writer(value.firstPreparedBy) || ''}\u0000${canonical({
    firstPreparedMode: value.firstPreparedMode,
    timezone: value.timezone
  })}`;
}

function latestPreparationKey(value) {
  return `${value.updatedBy}\u0000${canonical({
    intentionalBlank: value.intentionalBlank,
    lastPreparedMode: value.lastPreparedMode,
    oneOffItemIds: value.oneOffItemIds,
    routineInstanceIds: value.routineInstanceIds
  })}`;
}

function earlierPreparation(a, b) {
  if (a.firstPreparedAt !== b.firstPreparedAt) return a.firstPreparedAt < b.firstPreparedAt ? a : b;
  return compareStrings(firstPreparationKey(a), firstPreparationKey(b)) >= 0 ? a : b;
}

function laterPreparation(a, b) {
  if (a.lastPreparedAt !== b.lastPreparedAt) return a.lastPreparedAt > b.lastPreparedAt ? a : b;
  return compareStrings(latestPreparationKey(a), latestPreparationKey(b)) >= 0 ? a : b;
}

export function buildPreparation(current, input) {
  const targetDate = input?.targetDate;
  const timezone = input?.timezone;
  const now = timestamp(input?.now);
  const mode = input?.mode;
  const updatedBy = writer(input?.updatedBy);
  const routineInstanceIds = ids(input?.routineInstanceIds);
  const oneOffItemIds = ids(input?.oneOffItemIds);
  if (!validPlanDate(targetDate) || !validPlanTimezone(timezone) || !now || !MODES.has(mode) || !updatedBy || !routineInstanceIds || !oneOffItemIds || typeof input.intentionalBlank !== 'boolean') throw new Error('Invalid preparation confirmation.');
  const previous = normalizePreparation(current, targetDate);
  const confirmation = {
    schemaVersion: 1,
    targetDate,
    timezone,
    firstPreparedAt: now,
    firstPreparedBy: updatedBy,
    firstPreparedMode: mode,
    lastPreparedAt: now,
    lastPreparedMode: mode,
    updatedBy,
    intentionalBlank: input.intentionalBlank,
    routineInstanceIds,
    oneOffItemIds
  };
  return previous ? mergePreparations(previous, confirmation, targetDate) : confirmation;
}

export function mergePreparations(localValue, remoteValue, targetDate) {
  const local = normalizePreparation(localValue, targetDate);
  const remote = normalizePreparation(remoteValue, targetDate);
  if (!local) return remote;
  if (!remote) return local;
  const first = earlierPreparation(local, remote);
  const last = laterPreparation(local, remote);
  const merged = {
    schemaVersion: 1,
    targetDate: first.targetDate,
    timezone: first.timezone,
    firstPreparedAt: first.firstPreparedAt,
    firstPreparedMode: first.firstPreparedMode,
    lastPreparedAt: last.lastPreparedAt,
    lastPreparedMode: last.lastPreparedMode,
    updatedBy: last.updatedBy,
    intentionalBlank: last.intentionalBlank,
    routineInstanceIds: last.routineInstanceIds.slice(),
    oneOffItemIds: last.oneOffItemIds.slice()
  };
  if (first.firstPreparedBy) merged.firstPreparedBy = first.firstPreparedBy;
  return merged;
}

function itemMutationKey(value) {
  return `${writer(value?.updatedBy) || ''}\u0000${canonical(value)}`;
}

function chooseItem(local, remote) {
  const localAt = mergeTimestamp(local?.updatedAt);
  const remoteAt = mergeTimestamp(remote?.updatedAt);
  if (localAt !== remoteAt) return remoteAt > localAt ? remote : local;
  return compareStrings(itemMutationKey(local), itemMutationKey(remote)) >= 0 ? local : remote;
}

function planItems(value) {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
  if (value && typeof value === 'object') return Object.values(value).filter(item => item && typeof item === 'object');
  return [];
}

export function mergeDatePlans(localValue, remoteValue, targetDate) {
  const local = localValue && typeof localValue === 'object' ? localValue : {};
  const remote = remoteValue && typeof remoteValue === 'object' ? remoteValue : {};
  const byId = new Map();
  for (const item of planItems(local.items)) if (item.id) byId.set(item.id, item);
  for (const item of planItems(remote.items)) {
    if (!item.id) continue;
    byId.set(item.id, byId.has(item.id) ? chooseItem(byId.get(item.id), item) : item);
  }
  const localAt = mergeTimestamp(local.updatedAt);
  const remoteAt = mergeTimestamp(remote.updatedAt);
  const latestPlan = localAt === remoteAt
    ? (compareStrings(writer(remote.updatedBy) || '', writer(local.updatedBy) || '') >= 0 ? remote : local)
    : (remoteAt > localAt ? remote : local);
  const merged = {
    items: [...byId.values()].sort((a, b) => compareStrings(String(a.id), String(b.id))),
    updatedAt: Math.max(localAt, remoteAt)
  };
  const latestWriter = writer(latestPlan.updatedBy);
  if (latestWriter) merged.updatedBy = latestWriter;
  const preparation = mergePreparations(local.preparation, remote.preparation, targetDate);
  if (preparation) merged.preparation = preparation;
  return merged;
}

export function planningConsistency(value, targetDate) {
  if (value === undefined || value === null) return 'not-prepared';
  const preparation = normalizePreparation(value, targetDate);
  if (!preparation) return 'unknown';
  return localPlanDate(preparation.firstPreparedAt, preparation.timezone) < preparation.targetDate ? 'ahead' : 'late';
}

export function computeReadyNow({ plan, targetDate, routines = [], localSaveSucceeded = true }) {
  const preparation = normalizePreparation(plan?.preparation, targetDate);
  if (!preparation || !localSaveSucceeded) return false;
  const oneOffIds = new Set(preparation.oneOffItemIds);
  const actionableOneOff = planItems(plan.items).some(item => oneOffIds.has(item.id) && !item.deleted && !item.done);
  const plannedRoutines = new Set(preparation.routineInstanceIds);
  const actionableRoutine = routines.some(item => plannedRoutines.has(item.id) && item.occurs !== false && !item.skipped && item.actionable !== false);
  return actionableOneOff || actionableRoutine || preparation.intentionalBlank;
}

export function classifyOneOffActual(item, { targetDate, timezone, trackedMinutes = 0, preparedAt = 0 } = {}) {
  if (item?.deleted && Number(item.updatedAt || 0) >= Number(preparedAt || 0)) return 'removed';
  if (item?.done) {
    const doneDate = Number.isFinite(item.doneAt) && validPlanTimezone(timezone) ? localPlanDate(item.doneAt, timezone) : targetDate;
    return doneDate < targetDate ? 'done-early' : 'done';
  }
  return trackedMinutes > 0 ? 'worked-on' : 'not-done';
}

export function classifyRoutineActual({ occurs = true, skipped = false, completion = null } = {}) {
  if (!occurs || skipped) return 'removed';
  if (completion && ['target', 'minimum', 'complete'].includes(completion.level)) return completion.level;
  if (completion && completion.level === 'incomplete' && Number(completion.duration || 0) > 0) return 'worked-on';
  return 'not-done';
}

export function summarizeActual(rows) {
  const active = rows.filter(row => row.status !== 'removed');
  const completed = active.filter(row => ['done-early', 'done', 'worked-on', 'target', 'minimum', 'complete'].includes(row.status)).length;
  return { planned: rows.length, active: active.length, completed, removed: rows.length - active.length };
}

const api = { validPlanDate, validPlanTimezone, localPlanDate, addCalendarDays, planTomorrowTargetDate, normalizePreparation, buildPreparation, mergePreparations, mergeDatePlans, planningConsistency, computeReadyNow, classifyOneOffActual, classifyRoutineActual, summarizeActual };
globalThis.PlanTomorrowModel = api;
globalThis.replayPendingPlanRemotes?.();
