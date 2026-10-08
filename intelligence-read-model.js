// Recomputable, read-only review of authoritative snapshots. No ranking or persistence.
import { addCalendarDays, localPlanDate, validPlanDate, validPlanTimezone } from './plan-tomorrow-model.js';
import { normalizeCapture } from './brain-dump-model.js';
import { normalizeCommitment } from './commitments-model.js';
import { validateCoarseEvidenceRecord } from './coarse-life-evidence-model.js';

export const RECENT_DAYS = 7;
export const PATTERN_MIN_DAYS = 3;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const id = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? text(String(value)) : null;
const instant = value => Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const overlaps = (a, b) => a.startMs < b.endMs && a.endMs > b.startMs;
const row = (key, title, kind, status, detail, refs = []) => ({ id: key, title, kind, status, detail, refs });

// Inputs are authority snapshots, not version histories. Conflicting copies of an identity are
// excluded and reported; we never select truth by array order, timestamp guess or title matching.
export function unambiguousRecords(records, source, normalize, notes) {
  if (!Array.isArray(records)) { notes.push(`${source}: source unavailable.`); return []; }
  const byId = new Map();
  const conflicts = new Set();
  for (const raw of records) {
    let value = null;
    try { value = normalize(raw); } catch { /* malformed source record is not a fact */ }
    if (!value || !id(value.id)) { notes.push(`${source}: malformed record omitted.`); continue; }
    value = { ...value, id: id(value.id) };
    const old = byId.get(value.id);
    if (old && stable(old) !== stable(value)) conflicts.add(value.id);
    else byId.set(value.id, value);
  }
  for (const key of [...conflicts].sort(compare)) {
    byId.delete(key);
    notes.push(`${source}: conflicting record ${key}; outcome unknown.`);
  }
  return [...byId.values()].sort((a, b) => compare(a.id, b.id));
}

export function buildIntelligence(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const result = { state: 'ready', today: input.today, timezone: input.timezone,
    attention: [], planActual: [], actuals: [], openLoops: [], patterns: [], notes: [] };
  const notes = result.notes;
  if (!text(input.owner) || input.owner !== input.contextOwner) {
    return { ...result, state: 'unavailable', notes: [!text(input.owner) ? 'Sign in to read this account’s intelligence.' : 'Account context is unavailable; no data shown.'] };
  }
  if (!instant(input.now) || !validPlanTimezone(input.timezone) || !validPlanDate(input.today)
      || localPlanDate(input.now, input.timezone) !== input.today) {
    return { ...result, state: 'unavailable', notes: ['Date or account context is unavailable.'] };
  }
  const days = unambiguousRecords(input.days, 'Calendar windows', d => validPlanDate(d?.date)
    && instant(d.startMs) && instant(d.endMs) && d.endMs > d.startMs
    && localPlanDate(d.startMs, input.timezone) === d.date
    && localPlanDate(d.endMs - 1, input.timezone) === d.date ? { ...d, id: d.date } : null, notes);
  const today = days.find(d => d.date === input.today);
  if (!today) return { ...result, state: 'unavailable', notes: [...notes, 'Today’s calendar window is unknown.'] };
  const entries = unambiguousRecords(input.entries, 'Recorded intervals', e => id(e?.id) && text(e.title)
    && typeof e.eligible === 'boolean' && instant(e.startMs) && instant(e.endMs)
    && e.startMs < e.endMs ? e : null, notes).filter(e => {
      if (!e.eligible) return false;
      if (e.endMs > input.now) { notes.push(`Recorded intervals: future interval ${e.id}; outcome unknown.`); return false; }
      return true;
    });
  const plans = unambiguousRecords(input.planAuthority === 'known' ? input.plans : [], 'Plans', p => text(p?.id) && validPlanDate(p.date)
    && instant(p.startMs) && instant(p.endMs) && p.endMs > p.startMs
    && (p.evidenceEndMs === undefined || (instant(p.evidenceEndMs) && p.evidenceEndMs >= p.endMs))
    && Array.isArray(p.items) ? p : null, notes);
  if (input.planAuthority !== 'known') notes.push('Plan authority is still unknown; no plan absence is inferred.');
  const items = plans.flatMap(p => unambiguousRecords(p.items, `Plan ${p.id}`, i => text(i?.id) && text(i.task)
    && (i.done === undefined || typeof i.done === 'boolean') ? i : null, notes)
    .filter(i => !i.deleted).map(i => ({ ...i, plan: p, key: `plan:${p.id}:${i.id}` })));
  const linked = new Set();
  for (const item of items) {
    const window = { startMs: item.plan.startMs, endMs: item.plan.evidenceEndMs || item.plan.endMs };
    const evidence = entries.filter(e => e.planItemId === item.id && overlaps(e, window));
    const ambiguous = evidence.some(e => items.filter(other => other.id === e.planItemId
      && overlaps(e, { startMs: other.plan.startMs, endMs: other.plan.evidenceEndMs || other.plan.endMs })).length > 1);
    const refs = [{ source: 'plan', planId: item.plan.id, id: item.id }];
    if (!ambiguous) evidence.forEach(e => { linked.add(e.id); refs.push({ source: 'entry', id: e.id }); });
    const kind = item.done ? 'fact' : !ambiguous && evidence.length ? 'derived' : 'unknown';
    const status = item.done ? 'Marked done' : ambiguous ? 'Ambiguous link' : evidence.length ? 'Recorded work' : 'Actual unknown';
    const detail = item.done ? 'Explicit plan completion; recorded duration is separate.'
      : ambiguous ? 'More than one plan could own this entry link; no work attribution chosen.'
      : evidence.length ? `${evidence.length} linked record(s); this does not assert completion.`
      : 'No linked actual evidence. This does not mean it did not happen.';
    const projected = { ...row(item.key, item.task, kind, status, detail, refs), planId: item.plan.id,
      planDate: item.plan.date, when: item.when || null, whenDayOffset: item.whenDayOffset || 0,
      timezone: item.whenTz || item.plan.timezone || input.timezone };
    result.planActual.push(projected);
    if (!item.done) {
      result.openLoops.push(row(item.key, item.task, 'derived', 'Plan still open',
        `Not marked done in plan ${item.plan.date}; actual evidence is reported separately.`, refs));
      if (item.plan.endMs > input.now || (item.startMs >= today.startMs && item.startMs < today.endMs)) {
        result.attention.push(projected);
      }
    }
  }
  for (const e of entries.filter(e => overlaps(e, today))) {
    result.actuals.push(row(`entry:${e.id}`, e.title, 'fact', linked.has(e.id) ? 'Linked record' : e.planItemId ? 'Recorded · link not resolved here' : 'Recorded · no plan link',
      'Recorded interval; presence in the log is separate from plan completion.', [{ source: 'entry', id: e.id }]));
  }
  const coarse = unambiguousRecords(input.coarse, 'Broad activity evidence', r => { validateCoarseEvidenceRecord(r); return r; }, notes);
  for (const r of coarse.filter(r => !r.deleted && r.date === input.today)) {
    result.actuals.push(row(`coarse:${r.id}`, r.label, 'fact', 'Approximate · no placement',
      `About ${r.estimatedMinutes} min asserted for ${r.date} in ${r.timezone}; no task match or timeline placement inferred.`, [{ source: 'coarse', id: r.id }]));
  }
  const stale = unambiguousRecords(input.planAuthority === 'known' ? input.stale : [], 'Unfinished plans', r => text(r?.id) && text(r.task)
    && text(r.planId) && text(r.itemId) && validPlanDate(r.date) ? r : null, notes);
  for (const r of stale) result.openLoops.push(row(`stale:${r.id}`, r.task, 'derived', 'Previous plan still open',
    `Not marked done or dismissed in plan ${r.date}; no claim about what happened.`,
    [{ source: 'plan', planId: r.planId, id: r.itemId }]));
  const captures = unambiguousRecords(input.captures, 'Brain Dump', normalizeCapture, notes);
  for (const c of captures.filter(c => ['untriaged', 'triaged'].includes(c.status) || c.promotionClaim)) {
    const pending = !!c.promotionClaim;
    const capture = row(`capture:${c.id}`, c.text, pending ? 'unknown' : 'derived',
      pending ? 'Promotion pending' : c.status === 'untriaged' ? 'Needs triage' : 'Triaged · unresolved',
      pending ? 'Promotion outcome is pending; inspect Brain Dump before acting.' : 'An unresolved capture; capturing it does not itself create an obligation.',
      [{ source: 'brainDump', id: c.id }]);
    result.openLoops.push(capture);
    if (pending || c.important === true || c.urgent === true) result.attention.push(capture);
  }
  const commitments = unambiguousRecords(input.commitments, 'Appointments', normalizeCommitment, notes);
  const recentStart = days.reduce((start, d) => Math.min(start, d.startMs), today.startMs);
  for (const c of commitments.filter(c => !c.deleted && c.startMs >= recentStart && c.startMs < today.endMs)) {
    // This domain has scheduling and tombstones, but no completion state or actual-link contract.
    const elapsed = c.precision === 'date' ? c.date < localPlanDate(input.now, c.timezone)
      : c.startMs + (c.durationMinutes || 0) * 60000 <= input.now;
    result.attention.push(row(`commitment:${c.id}`, c.title, elapsed ? 'unknown' : 'fact',
      elapsed ? 'Scheduled time passed · outcome unknown' : 'Scheduled appointment',
      `${c.date}${c.precision === 'timed' ? ` ${c.time}` : ' · date only'} · ${c.timezone}. Appointment records have no completion field.`,
      [{ source: 'commitment', id: c.id }]));
  }
  const routines = unambiguousRecords(input.routines, 'Routines', r => text(r?.id) && text(r.title) && validPlanDate(r.date)
    && ['unknown', 'complete', 'worked', 'skipped', 'ambiguous'].includes(r.state) ? r : null, notes);
  for (const r of routines) {
    const completed = r.state === 'complete' || r.state === 'skipped';
    const record = row(`routine:${r.id}`, r.title, completed ? 'fact' : r.state === 'worked' ? 'derived' : 'unknown',
      r.state === 'complete' ? r.source === 'manual' ? 'Manual assertion' : 'Source completion' : r.state === 'skipped' ? 'Explicitly skipped' : r.state === 'ambiguous' ? 'Ambiguous evidence' : r.state === 'worked' ? 'Recorded below target' : 'Actual unknown',
      `Routine date ${r.date} · ${r.timezone}. ${r.cue || ''} Completion uses the existing routine source contract.`,
      [{ source: 'routine', id: r.id }, ...(r.evidenceId ? [{ source: r.source, id: r.evidenceId }] : [])]);
    result.planActual.push(record);
    if (!completed) {
      result.openLoops.push(record);
      if (r.due || r.state === 'ambiguous') result.attention.push(record);
    }
  }
  const expectedDates = Array.from({ length: RECENT_DAYS }, (_, n) => addCalendarDays(input.today, -n));
  const recent = days.filter(d => expectedDates.includes(d.date));
  if (recent.length !== RECENT_DAYS) notes.push('Recent patterns unavailable: the seven calendar windows are incomplete.');
  else {
    const groups = new Map();
    for (const e of entries) {
      const key = e.title.toLowerCase().replace(/\s+/g, ' ').trim();
      const date = localPlanDate(e.startMs, input.timezone);
      if (!expectedDates.includes(date)) continue;
      if (!groups.has(key)) groups.set(key, { titles: new Set(), dates: new Set(), refs: [] });
      const g = groups.get(key);
      g.titles.add(e.title);
      g.dates.add(date);
      g.refs.push({ source: 'entry', id: e.id });
    }
    for (const [key, g] of groups) if (g.dates.size >= PATTERN_MIN_DAYS) {
      result.patterns.push(row(`pattern:${key}`, [...g.titles].sort(compare)[0], 'pattern',
        `Recorded on ${g.dates.size} of ${RECENT_DAYS} calendar dates`,
        `${expectedDates[RECENT_DAYS - 1]}–${input.today} · ${input.timezone}. Repeated log labels; no completion, consistency or missing-day claim.`, g.refs));
    }
  }
  if (input.session?.active) result.attention.push(row('session', input.session.title || 'Current session', 'fact',
    input.session.state, 'Live timer state; ongoing time is not counted as a finished record.'));
  for (const section of ['attention', 'planActual', 'actuals', 'openLoops', 'patterns']) {
    result[section].sort((a, b) => compare(a.title, b.title) || compare(a.id, b.id));
  }
  result.notes = [...new Set([...notes, ...(Array.isArray(input.notes) ? input.notes.filter(n => typeof n === 'string') : [])])].sort(compare);
  return result;
}
