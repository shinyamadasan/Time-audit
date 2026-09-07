import { DAILY_ROUTINES_KEY, instanceId, localContext, validateRoutine } from './daily-routines-model.js';

function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.routines)) throw new Error('Routine storage has an unsupported format.');
  localContext(0, state.timezone);
  const ids = new Set();
  state.routines.forEach(r => { validateRoutine(r); if (ids.has(r.id)) throw new Error('Duplicate routine ID.'); ids.add(r.id); });
  for (const field of ['manual', 'links', 'focus']) {
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) throw new Error(`Invalid routine ${field} storage.`);
  }
  const checkId = id => { const [routineId, date] = JSON.parse(id); if (!ids.has(routineId) || instanceId(routineId, date) !== id) throw new Error('Invalid stored instance identity.'); };
  Object.entries(state.manual).forEach(([id, value]) => { checkId(id); if (!['complete', 'minimum'].includes(value.level)) throw new Error('Invalid manual completion.'); });
  Object.entries(state.links).forEach(([id, link]) => { checkId(id); if (!link.planId || !link.stepId || !link.stepTitle) throw new Error('Invalid Learning linkage.'); });
  if (state.focusLaunch) { checkId(state.focusLaunch.instanceId); localContext(state.focusLaunch.startedAt, state.focusLaunch.timezone); if (!Number.isFinite(state.focusLaunch.startedAt)) throw new Error('Invalid Focus launch.'); }
  Object.entries(state.focus).forEach(([id, f]) => { checkId(f.instanceId); if (id !== f.entryId || !Number.isFinite(f.duration) || f.duration <= 0 || !Number.isFinite(f.startedAt) || !Number.isFinite(f.endedAt) || f.endedAt <= f.startedAt) throw new Error('Invalid Focus outcome.'); });
  return state;
}
export function createDailyRoutineRepository(storage = globalThis.localStorage) {
  return {
    read(timezone) {
      const raw = storage.getItem(DAILY_ROUTINES_KEY);
      return validateState(raw === null ? { schemaVersion: 1, timezone, routines: [], manual: {}, links: {}, focus: {} } : JSON.parse(raw));
    },
    update(timezone, change) {
      const state = this.read(timezone);
      change(state);
      validateState(state);
      storage.setItem(DAILY_ROUTINES_KEY, JSON.stringify(state));
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
    }
  };
}
