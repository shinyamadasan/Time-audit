import { buildIntelligence, RECENT_DAYS, unambiguousRecords } from './intelligence-read-model.js?v=20261008-intelligence-int001';
import { appRoomOwner } from './personal-day-boundary-repository.js';
import { createBrainDumpRepository } from './brain-dump-repository.js';
import { createCommitmentsRepository } from './commitments-repository.js';
import { createCoarseEvidenceRepository } from './coarse-life-evidence-repository.js';
import { createDailyRoutineRepository } from './daily-routines-repository.js';
import { generateInstances, localContext, matchCompletion, scheduleState } from './daily-routines-model.js';

const panel = document.getElementById('intelligence-panel');
const root = document.getElementById('intelligence-root');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Each reader is synchronous and account-scoped. It never calls the routine UI's readView(),
// which may bind a Learning step, or a promotion reconciler, which may create a plan item.
export function collectIntelligenceInput(now = Date.now()) {
  const owner = appRoomOwner();
  let context;
  try { context = globalThis.getIntelligenceAppContext?.(now, RECENT_DAYS) || {}; }
  catch { return { owner, contextOwner: null, now }; }
  if (!owner || owner !== context.contextOwner) return { owner, contextOwner: null, now };
  const snapshot = { ...context, owner, now, plans: [], stale: [], captures: null, commitments: null,
    coarse: null, routines: null, notes: [], planAuthority: 'unknown' };
  const read = (label, fn) => {
    try { return fn(); } catch { snapshot.notes.push(`${label}: source could not be read; outcome unknown.`); return null; }
  };
  snapshot.captures = read('Brain Dump', () => Object.values(createBrainDumpRepository().listAllRaw()));
  snapshot.commitments = read('Appointments', () => Object.values(createCommitmentsRepository().listAllRaw()));
  snapshot.coarse = read('Broad activity evidence', () => createCoarseEvidenceRepository().list());
  read('Plans', () => {
    const authority = globalThis.PlanAuthority;
    if (!authority || authority.authorityState() === 'unknown') return;
    const current = authority.current(now);
    if (!current) return;
    snapshot.planAuthority = 'known';
    const targets = [{ target: current, items: authority.items(current) }];
    const carry = authority.calendarCarryoverFor(context.today);
    if (carry?.items?.length && carry.target.id !== current.id) targets.push(carry);
    snapshot.plans = targets.map(({ target, items }) => {
      const bounds = authority.evidenceWindow(target);
      const evidence = authority.reviewEvidenceWindow(target);
      return { id: target.id, date: target.dateKey || localContext(bounds.startMs, target.timezone).date,
        timezone: target.timezone, ...bounds, evidenceEndMs: evidence.endMs,
        items: items.map(item => ({ ...item, ...authority.itemInstants(target, item) })) };
    });
    const stale = authority.staleUnfinished(now);
    snapshot.stale = stale.items.map(({ item, target }) => ({ id: `${target.id}:${item.id}`, itemId: item.id,
      planId: target.id, task: item.task, date: target.dateKey || localContext(target.startMs, target.timezone).date }));
    if (stale.unresolvable.length) snapshot.notes.push('Some unfinished plans have unresolved day boundaries.');
    if (authority.recoveryConflicts().length) snapshot.notes.push('Plan recovery has conflicting destinations; inspect Unfinished before acting.');
  });
  snapshot.routines = read('Routines', () => {
    const state = createDailyRoutineRepository().read(context.timezone);
    const date = localContext(now, state.timezone).date;
    // Life Ledger currently has a device-global cache without an account ownership proof.
    // We cannot use it for account intelligence. Manual assertions and Focus receipts ARE scoped.
    if (state.routines.some(r => r.enabled && ['learning', 'workout'].includes(r.source))) {
      snapshot.notes.push('Learning/workout routine source completion is not evaluated: the Ledger cache has no account ownership proof.');
    }
    const routineEntries = unambiguousRecords(context.routineEntries, 'Routine evidence', e => e && e.id != null ? e : null, snapshot.notes);
    const input = { ...state, events: [], entries: routineEntries };
    return generateInstances(state.routines, date, state.timezone).map(instance => {
      const completion = matchCompletion(instance, input, now);
      const schedule = scheduleState(instance, now, completion);
      const skipped = !!state.skips[instance.id];
      return { id: instance.id, title: instance.routine.title, date, timezone: state.timezone,
        state: skipped ? 'skipped' : completion?.source === 'ambiguous' ? 'ambiguous'
          : completion && completion.level !== 'incomplete' ? 'complete'
          : completion ? 'worked' : 'unknown',
        source: completion?.source, evidenceId: completion?.evidenceId,
        due: ['Now', 'Anytime'].includes(schedule.group), cue: schedule.label };
    });
  });
  // Guard even synchronous readers if a future source implementation changes ownership mid-read.
  if (appRoomOwner() !== owner) return { owner: null };
  return snapshot;
}

function section(title, rows, empty) {
  return `<section class="intelligence-section"><h3>${title}</h3>${rows.length ? rows.map(r =>
    `<article data-intelligence-kind="${r.kind}" data-record-key="${escape(r.id)}"><div><strong>${escape(r.title)}</strong>
    <span class="intelligence-tag">${escape(r.kind === 'unknown' ? 'Unknown / gap' : r.kind === 'derived' ? 'Derived status' : r.kind === 'pattern' ? 'Pattern' : 'Fact')}</span></div>
    <p>${escape(r.status)}${r.planDate ? ` · Plan ${escape(r.planDate)}` : ''}${r.when ? ` · ${escape(r.when)}${r.whenDayOffset ? ' next day' : ''} · ${escape(r.timezone)}` : ''}</p>
    <small>${escape(r.detail)}</small></article>`).join('') : `<p class="intelligence-empty">${empty}</p>`}</section>`;
}

export function renderIntelligence() {
  if (!root || !panel?.open) return;
  const model = buildIntelligence(collectIntelligenceInput());
  if (model.state !== 'ready') { root.innerHTML = `<p>${escape(model.notes.join(' '))}</p>`; return; }
  const timestamp = new Intl.DateTimeFormat('en-US', { timeZone: model.timezone, hour: '2-digit', minute: '2-digit' }).format(Date.now());
  root.innerHTML = `<p class="intelligence-context">Calendar today ${escape(model.today)} · ${escape(model.timezone)} · As of ${escape(timestamp)}.
    Current plans retain their own day identity and timezone. Missing evidence stays unknown.</p>`
    + section('Today / attention', model.attention, 'No attention items derived from the readable sources.')
    + section('Plan vs actual', model.planActual, 'No readable current plan or routine rows. This does not establish that nothing was planned.')
    + section('Recorded actuals today', model.actuals, 'No readable actual records for this date. Activity outside this record remains unknown.')
    + section('Open loops', model.openLoops, 'No unresolved items found in the readable sources.')
    + section('Recent patterns', model.patterns, 'No supported repeated-label pattern. Requires records on at least three of the last seven calendar dates.')
    + (model.notes.length ? `<section class="intelligence-section"><h3>Data not evaluated</h3>${model.notes.map(n => `<p>${escape(n)}</p>`).join('')}</section>` : '');
}

if (panel && root) {
  panel.addEventListener('toggle', renderIntelligence);
  document.getElementById('intelligence-refresh').addEventListener('click', renderIntelligence);
  globalThis.renderIntelligence = renderIntelligence;
  globalThis.resetIntelligenceForAccount = () => { root.replaceChildren(); };
  window.addEventListener('storage', renderIntelligence);
  window.addEventListener('focus', renderIntelligence);
  window.setInterval(() => { if (!document.hidden && panel.closest('.view')?.classList.contains('active')) renderIntelligence(); }, 30000);
}
