import { DAILY_ROUTINES_KEY, instanceId, localContext, validateRoutine } from './daily-routines-model.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';

/** The storage slot holding ONE room's routines: `<key>:<roomId>` (Device-Local Account Isolation V1).
 *  Definitions, manual completions, links, skips and Focus outcomes are one envelope, so they switch together. */
export function dailyRoutinesKeyForRoom(roomId, key = DAILY_ROUTINES_KEY) {
  return `${key}:${roomId}`;
}

function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.routines)) throw new Error('Routine storage has an unsupported format.');
  localContext(0, state.timezone);
  const ids = new Set();
  state.routines.forEach(r => { validateRoutine(r); if (ids.has(r.id)) throw new Error('Duplicate routine ID.'); ids.add(r.id); });
  for (const field of ['manual', 'links', 'focus', 'skips']) {
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) throw new Error(`Invalid routine ${field} storage.`);
  }
  const checkId = id => { const [routineId, date] = JSON.parse(id); if (!ids.has(routineId) || instanceId(routineId, date) !== id) throw new Error('Invalid stored instance identity.'); };
  Object.entries(state.manual).forEach(([id, value]) => { checkId(id); if (!['complete', 'minimum'].includes(value.level)) throw new Error('Invalid manual completion.'); });
  Object.entries(state.links).forEach(([id, link]) => { checkId(id); if (!link.planId || !link.stepId || !link.stepTitle) throw new Error('Invalid Learning linkage.'); });
  Object.entries(state.skips).forEach(([id, skip]) => {
    checkId(id);
    if (!skip || !Number.isFinite(skip.skippedAt) || skip.skippedAt <= 0 || !Number.isFinite(skip.updatedAt) || skip.updatedAt < skip.skippedAt) throw new Error('Invalid routine date skip.');
  });
  if (state.focusLaunch) { checkId(state.focusLaunch.instanceId); localContext(state.focusLaunch.startedAt, state.focusLaunch.timezone); if (!Number.isFinite(state.focusLaunch.startedAt)) throw new Error('Invalid Focus launch.'); }
  Object.entries(state.focus).forEach(([id, f]) => { checkId(f.instanceId); if (id !== f.entryId || !Number.isFinite(f.duration) || f.duration <= 0 || !Number.isFinite(f.startedAt) || !Number.isFinite(f.endedAt) || f.endedAt <= f.startedAt) throw new Error('Invalid Focus outcome.'); });
  return state;
}
export function createDailyRoutineRepository(injectedStorage, options = {}) {
  const storage = injectedStorage || globalThis.localStorage;
  // Scoped when told who the owner is, or when running over the real localStorage: the owner is the
  // joined room, re-resolved on every call. No owner -> the empty state, and every write refused.
  const getOwner = typeof options.getOwner === 'function' ? options.getOwner : (injectedStorage ? null : appRoomOwner);
  const activeKey = () => {
    if (!getOwner) return DAILY_ROUTINES_KEY;
    const owner = getOwner();
    return typeof owner === 'string' && owner ? dailyRoutinesKeyForRoom(owner) : null;
  };
  return {
    read(timezone) {
      const key = activeKey();
      const raw = key === null ? null : storage.getItem(key);
      const state = raw === null ? { schemaVersion: 1, timezone, routines: [], manual: {}, links: {}, focus: {}, skips: {} } : JSON.parse(raw);
      if (state && state.schemaVersion === 1 && state.skips === undefined) state.skips = {};
      return validateState(state);
    },
    update(timezone, change) {
      const key = activeKey();
      if (key === null) throw new Error('No signed-in account owns routines on this device. Nothing was saved.');
      const state = this.read(timezone);
      change(state);
      validateState(state);
      storage.setItem(key, JSON.stringify(state));
      return state;
    },
    manualDone(timezone, id, level) {
      return this.update(timezone, state => {
        const [routineId] = JSON.parse(id);
        const routine = state.routines.find(r => r.id === routineId);
        if (level === null) { delete state.manual[id]; return; }
        if (routine?.source !== 'manual' || (level === 'minimum' && routine.minimumMinutes === null)) throw new Error('Automatic completion is source-owned.');
        state.manual[id] = { level };
      });
    },
    setDateSkip(timezone, id, skipped, now = Date.now()) {
      if (typeof skipped !== 'boolean' || !Number.isFinite(now) || now <= 0) throw new Error('Invalid routine date skip.');
      return this.update(timezone, state => {
        const [routineId, date] = JSON.parse(id);
        const routine = state.routines.find(r => r.id === routineId);
        if (!routine || instanceId(routineId, date) !== id) throw new Error('Invalid stored instance identity.');
        if (skipped) state.skips[id] = { skippedAt: now, updatedAt: now };
        else delete state.skips[id];
      });
    }
  };
}
