// Intentions only. Inputs are validated repository state and source-owned facts.
export const DAILY_ROUTINES_KEY = 'ta3-daily-routines-v1';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const text = value => typeof value === 'string' && value.trim() && value.length <= 200;
const formatters = new Map();
export function localContext(now, timezone) {
  if (!timezone) throw new Error('A scheduler timezone is required.');
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const parts = formatters.get(timezone).formatToParts(new Date(now));
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute), timezone };
}
export function validDate(date) {
  return typeof date === 'string' && DATE.test(date) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;
}
export function instanceId(routineId, date) {
  if (!text(routineId) || !validDate(date)) throw new Error('Invalid daily identity.');
  return JSON.stringify([routineId, date]);
}
export function validateRoutine(r) {
  if (!r || !text(r.id) || !text(r.title) || typeof r.enabled !== 'boolean' || !validDate(r.createdDate)) throw new Error('Invalid routine identity or title.');
  if (!['daily', 'weekdays', 'selected'].includes(r.cadence) || !Array.isArray(r.days) || r.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(r.days).size !== r.days.length || (r.cadence === 'selected' && !r.days.length)) throw new Error('Choose at least one valid weekday.');
  if (!['exact', 'window', 'cue', 'anytime'].includes(r.mode)) throw new Error('Choose a schedule mode.');
  if (['exact', 'window'].includes(r.mode) && !TIME.test(r.time)) throw new Error('Choose a preferred time.');
  if (r.mode === 'window' && (!TIME.test(r.endTime) || r.endTime <= r.time)) throw new Error('The window must end after it starts, on the same day.');
  if (r.mode === 'cue' && !text(r.cue)) throw new Error('Enter a routine cue.');
  if (!Number.isInteger(r.targetMinutes) || r.targetMinutes < 1 || r.targetMinutes > 240 || (r.minimumMinutes !== null && (!Number.isInteger(r.minimumMinutes) || r.minimumMinutes < 1 || r.minimumMinutes > r.targetMinutes))) throw new Error('Use a target of 1–240 minutes and a minimum no larger than the target.');
  if (typeof r.fallback !== 'string' || r.fallback.length > 200) throw new Error('Fallback is too long.');
  if (!['manual', 'workout', 'learning', 'focus'].includes(r.source)) throw new Error('Choose a completion source.');
  if (r.source === 'learning' && !text(r.planId)) throw new Error('Choose a Learning Plan.');
  if (r.workoutRoutineId && !text(r.workoutRoutineId)) throw new Error('Invalid workout linkage.');
  return r;
}
export function occursOn(r, date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return date >= r.createdDate && (r.cadence === 'daily' || (r.cadence === 'weekdays' ? day >= 1 && day <= 5 : r.days.includes(day)));
}
export function generateInstances(routines, date, timezone) {
  if (!validDate(date)) throw new Error('Invalid schedule date.');
  localContext(`${date}T12:00:00Z`, timezone);
  return [...new Map(routines.filter(r => r.enabled && occursOn(r, date)).map(r => [r.id, { id: instanceId(r.id, date), routineId: r.id, date, timezone, routine: r }])).values()];
}
const clockMinute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export function scheduleState(instance, now, completion = null) {
  if (completion && completion.level !== 'incomplete') return { group: 'Done', label: completion.level === 'minimum' ? 'Minimum complete' : completion.level === 'target' ? 'Target complete' : 'Complete' };
  const current = localContext(now, instance.timezone);
  const r = instance.routine;
  if (instance.date < current.date) return { group: 'Incomplete', label: 'Missed / incomplete' };
  if (r.mode === 'cue') return { group: 'Later', label: `Cue: ${r.cue}` };
  if (r.mode === 'anytime') return { group: 'Anytime', label: 'Anytime today' };
  const minute = instance.date > current.date ? -1 : current.minute;
  const start = clockMinute(r.time);
  if (minute < start) return { group: 'Next', label: r.mode === 'exact' ? 'Up next' : 'Later' };
  const end = r.mode === 'window' ? clockMinute(r.endTime) : Math.min(1440, start + r.targetMinutes);
  if (minute < end) return { group: 'Now', label: r.mode === 'window' ? 'Available now' : 'Now' };
  return { group: r.fallback ? 'Now' : 'Anytime', label: r.fallback ? `Still available · ${r.fallback}` : 'Preferred time passed · still available today' };
}
export function completionLevel(r, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 'complete';
  if (duration >= r.targetMinutes) return 'target';
  if (r.minimumMinutes !== null && duration >= r.minimumMinutes) return 'minimum';
  return 'incomplete';
}
// Never title-match or infer completion from opening Focus or a clock crossing a cue.
export function matchCompletion(instance, { routines, events = [], manual = {}, links = {}, focus = {}, entries = [] }, now) {
  const r = instance.routine;
  const link = links[instance.id];
  const candidates = [];
  let ambiguous = false;
  const dateOf = value => localContext(value, instance.timezone).date;
  const sameDay = e => !e.tombstone?.active && Date.parse(e.occurredAt) <= Number(new Date(now)) && dateOf(e.occurredAt) === instance.date;
  for (const e of events.filter(sameDay)) {
    if (r.source === 'workout' && e.sourceApp === 'workout' && e.type === 'workout_completed' && (!r.workoutRoutineId || e.payload.source.routineId === r.workoutRoutineId)) {
      const eligible = routines.filter(other => other.source === 'workout' && occursOn(other, instance.date) && (!other.workoutRoutineId || other.workoutRoutineId === e.payload.source.routineId));
      if (eligible.length !== 1) { ambiguous = true; continue; }
      candidates.push({ evidenceId: e.eventId, duration: e.payload.durationMinutes, source: 'workout' });
    }
    if (r.source === 'learning' && e.sourceApp === 'chronasense' && e.type === 'plan_step_completed' && e.payload.source.planId === r.planId && (link ? link.planId === r.planId && e.payload.source.stepId === link.stepId : instance.date < dateOf(now))) {
      const eligible = routines.filter(other => other.source === 'learning' && occursOn(other, instance.date) && other.planId === r.planId);
      if (eligible.length !== 1) { ambiguous = true; continue; }
      candidates.push({ evidenceId: e.eventId, duration: e.payload.trackedMinutes, source: 'learning' });
    }
  }
  if (r.source === 'focus') {
    for (const receipt of Object.values(focus).filter(f => f.instanceId === instance.id)) {
      const entry = entries.find(e => String(e.id) === receipt.entryId && !e.deleted && !e.missed && e.tsStart === receipt.startedAt && e.ts === receipt.endedAt && e.blockIntervalMin === receipt.duration);
      if (entry && receipt.endedAt <= Number(new Date(now)) && dateOf(receipt.startedAt) === instance.date) candidates.push({ evidenceId: receipt.entryId, duration: receipt.duration, source: 'focus' });
    }
  }
  const rank = { target: 3, complete: 2, minimum: 1, incomplete: 0 };
  const automatic = candidates.map(c => ({ ...c, level: completionLevel(r, c.duration) })).sort((a, b) => rank[b.level] - rank[a.level] || String(a.evidenceId).localeCompare(String(b.evidenceId)))[0];
  // A source switch keeps routine identity and manual assertions. One row, never two completions.
  const assertion = manual[instance.id];
  const manualResult = assertion ? { source: 'manual', level: assertion.level } : null;
  if (automatic && (!manualResult || rank[automatic.level] >= rank[manualResult.level])) return automatic;
  return manualResult || automatic || (ambiguous ? { level: 'incomplete', source: 'ambiguous' } : null);
}
export function previousDate(date) {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
// Consecutive calendar days, intentionally not "scheduled opportunities".
export function routineStreak(routine, date, isComplete) {
  let cursor = isComplete(date) ? date : previousDate(date);
  let days = 0;
  while (cursor >= routine.createdDate && isComplete(cursor)) { days++; cursor = previousDate(cursor); }
  return days;
}
export function dailyScore(completions) {
  const levels = completions.map(c => c?.level);
  return { planned: levels.length, completed: levels.filter(l => l && l !== 'incomplete').length, target: levels.filter(l => l === 'target').length, minimum: levels.filter(l => l === 'minimum').length };
}
