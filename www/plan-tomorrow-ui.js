import { classifyRoutineActual, clearPlanItemRange, durationBetween, formatPlanItemSchedule, isPriorityPlanItem, isSecondaryPlanItem, planItemEndTime, withPlanItemKind, reconciliationBucket, validPlanItemRange, validPlanItemTime } from './plan-tomorrow-model.js';
import { carryItemIdFor } from './plan-authority.js';
import { describeDayStart } from './personal-day-boundary-live.js';
import { generateInstances, matchCompletion, occursOn } from './daily-routines-model.js';
import { createDailyRoutineRepository } from './daily-routines-repository.js';
import { createLearningPlanRepository } from './learning-plan-repository.js';
import { findNextLearningPlanStep } from './learning-plan-next-action.js';
import { createLocalLifeLedgerStore } from './life-ledger-runtime.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';
import { quadrantOf } from './brain-dump-model.js';
import { sameOnWire } from './plan-fence-sync.js';

const routineRepository = createDailyRoutineRepository();
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const root = document.getElementById('plan-tomorrow-overlay');
const body = document.getElementById('plan-tomorrow-body');
const error = document.getElementById('plan-tomorrow-error');
let draft = null;
let draftInstance = 0;
let opener = null;
let liveCheck = null;
let saveAttempt = null;
const CHECKPOINT_LIMIT = 128 * 1024;
const LIVE_CHECK_MS = 1000;
const dialog = root?.querySelector('.plan-tomorrow-modal');
const inerted = new Set();
if (root) {
  const scroll = document.createElement('div'); scroll.className = 'pt-scroll';
  scroll.append(root.querySelector('.pt-mode-row'), body, error);
  const warning = document.createElement('div'); warning.id = 'pt-context-warning'; warning.className = 'pt-context'; warning.hidden = true;
  warning.innerHTML = '<p></p><button type="button" class="btn sm" data-pt-action="latest">Review latest plan</button>';
  body.before(warning);
  root.querySelector('.pt-footer').before(scroll);
  const status = document.createElement('div'); status.id = 'pt-save-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  root.querySelector('.pt-footer').prepend(status);
  const exit = document.createElement('dialog'); exit.id = 'pt-exit'; exit.setAttribute('aria-labelledby', 'pt-exit-title');
  exit.innerHTML = '<h2 id="pt-exit-title">Keep your planning draft?</h2><p>Changes have not all been saved. Choose what happens to your draft.</p><button type="button" class="btn primary" data-pt-exit="stay">Keep editing</button><button type="button" class="btn" data-pt-exit="keep">Keep draft and close</button><button type="button" class="btn ghost" data-pt-exit="discard">Discard draft changes</button>';
  document.body.append(exit);
  exit.addEventListener('click', event => {
    const action = event.target.closest('[data-pt-exit]')?.dataset.ptExit;
    if (!action) return;
    if (action === 'keep' && !checkpoint()) { exit.querySelector('p').textContent = 'Draft recovery could not be stored. Keep editing, or explicitly discard your changes.'; return; }
    if (action === 'discard') { clearCheckpoint(); draft = null; }
    exit.close();
    if (action !== 'stay') hidePreparation();
  });
  const resume = document.createElement('button'); resume.type = 'button'; resume.id = 'pt-return'; resume.className = 'btn'; resume.hidden = true;
  resume.textContent = 'Planning draft kept · Return to plan';
  resume.addEventListener('click', () => openPlanTomorrow({ target: draft?.target }));
  document.body.append(resume);
}

const checkpointKey = () => appRoomOwner() ? `ta3-plan-tomorrow-draft-v1:${appRoomOwner()}` : null;
const sourceState = target => JSON.stringify({ items: globalThis.PlanAuthority.rawItems(target).slice().sort((a,b) => String(a.id).localeCompare(String(b.id))), preparation: globalThis.PlanAuthority.preparation(target) });
const draftState = () => JSON.stringify({ items: draft.items, mode: draft.mode, blank: draft.intentionalBlank, forms: draft.forms || {} });
function captureForms() {
  if (!draft || !body || body.dataset.ptDraft !== String(draft.instance)) return;
  const forms = { ...draft.forms };
  for (const input of body.querySelectorAll('form input[name]')) {
    const key = `${input.form.id}:${input.name}`;
    if (input.value) forms[key] = input.value; else delete forms[key];
  }
  draft.forms = forms;
}
function restoreForms() {
  body.querySelectorAll('form input[name]').forEach(input => { input.value = draft.forms?.[`${input.form.id}:${input.name}`] || ''; });
}
function checkpoint() {
  if (!draft || draft.owner !== appRoomOwner()) return false;
  try {
    captureForms();
    const value = JSON.stringify({ v: 1, owner: draft.owner, targetId: draft.target.id, targetHeading: draft.heading, timezone: draft.timezone,
      items: draft.items, mode: draft.mode, blank: draft.intentionalBlank, forms: draft.forms, base: draft.base,
      initial: draft.initial, explicitDay: draft.explicitDay, receipt: draft.receipt || null });
    if (value.length > CHECKPOINT_LIMIT) throw new Error('Draft is too large to checkpoint.');
    window.sessionStorage.setItem(checkpointKey(), value);
    return true;
  } catch { error.textContent = 'Draft recovery could not be stored on this device. Keep this window open before leaving.'; return false; }
}
function clearCheckpoint() {
  if (draft?.owner === appRoomOwner()) window.sessionStorage.removeItem(checkpointKey());
}
function assertDraftOwner() {
  if (!draft || !draft.owner || draft.owner !== appRoomOwner() || globalThis.accountLocalKey?.('ta3-plan-tomorrow-draft-v1') !== `ta3-plan-tomorrow-draft-v1:${draft.owner}`) {
    draft = null; saveAttempt = null;hidePreparation(false);
    throw new Error('The account changed. Reopen planning for the current account.');
  }
}
function assertDraftTarget() {
  assertDraftOwner();
  const authority = globalThis.PlanAuthority;
  if (draft.timezone !== context().timezone) throw new Error('The planning timezone changed. Your original draft is kept; review a fresh plan before saving.');
  const current = authority.targetById(draft.target.id);
  if (!current || current.store !== draft.target.store || (!draft.explicitDay && authority.upcoming()?.id !== draft.target.id)) throw new Error('The day changed. Your original draft is kept; reopen a fresh plan before saving.');
  authority.assertDirectSchedulingTarget(current);
  if (targetHeading(current) !== draft.heading) throw new Error('The Personal Day boundary changed. Your original draft is kept.');
  if (!sameOnWire(JSON.parse(sourceState(current)), JSON.parse(draft.base))) throw new Error('This plan changed at source or on another device. Keep your draft and review the latest plan before saving.');
}
function hidePreparation(returnToReview = true) {
  root.classList.remove('open');
  clearInterval(liveCheck); liveCheck = null;
  for (const el of inerted) el.inert = false;
  inerted.clear();
  if (opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true });
  else document.querySelector('.nav-btn.active')?.focus({ preventScroll: true });
  if (returnToReview && draft?.returnToReview) {
    globalThis.renderReviewTomorrowStatus();
    document.getElementById('review-overlay').classList.add('open');
  }
}
function keepFocus(event) {
  if (event.key !== 'Tab') return;
  const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea,summary')].filter(el => el.getClientRects().length && !el.closest('[hidden]'));
  const first = controls[0], last = controls.at(-1);
  if (!controls.includes(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
    event.preventDefault(); (event.shiftKey ? last : first)?.focus();
  }
}
root?.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); try { closePreparation(); } catch (err) { globalThis.showToast(err.message); } }
  keepFocus(event);
});
root?.addEventListener('change', event => {
  try { assertDraftOwner(); }
  catch (err) { event.stopImmediatePropagation();globalThis.showToast(err.message); }
}, true);
document.getElementById('pt-exit')?.addEventListener('keydown', keepFocus);
window.addEventListener('beforeunload', event => {
  if (draft?.owner === appRoomOwner()) {
    captureForms();
    if (draftState() !== draft.initial) { checkpoint(); event.preventDefault(); event.returnValue = ''; }
  }
});
window.visualViewport?.addEventListener('resize', () => root?.style.setProperty('--pt-visible-height', `${window.visualViewport.height}px`));

function considerationHtml() {
  const repository = globalThis.BrainDumpRepository;
  const records = repository?.ownerRoomId() === draft.owner ? Object.values(repository.listAllRaw()) : [];
  const groups = ['do-first', 'schedule'].map(q => records.filter(item => item.status === 'triaged' && quadrantOf(item) === q).sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
  const rows = [0, 1].flatMap(index => groups.map(group => group[index]).filter(Boolean));
  return `<details class="pt-consider" data-pt-fold="consider" ${window.innerWidth > 700 ? 'open' : ''}><summary>From Brain Dump <span>${rows.length} ideas</span></summary><p class="pt-muted">Ideas to consider. Review and schedule them in Brain Dump.</p>${rows.map(item => `<article class="pt-candidate"><small>${quadrantOf(item) === 'do-first' ? 'Q1 · Important & urgent' : 'Q2 · Important, not urgent'}</small><p>${escape(item.text)}</p>${item.promotionClaim ? '<p class="pt-muted">Waiting for the move to your plan to finish.</p>' : ''}<button type="button" class="btn sm ghost" data-pt-action="brain-dump">Review in Brain Dump</button></article>`).join('') || '<p class="pt-muted">No Q1 or Q2 ideas available on this device yet.</p>'}<p class="pt-muted">Up to two Q1 and two Q2 ideas saved on this device.</p><button type="button" class="btn sm" data-pt-action="brain-dump">Open Brain Dump</button></details>`;
}

function plannerStatus() {
  const status = document.getElementById('pt-save-status');
  if (!status || !draft) return;
  status.textContent = draft.receipt?.signature === draftState() ? draft.receipt.message : draftState() === draft.initial ? 'Review your plan, then save' : 'Unsaved changes';
  document.getElementById('plan-tomorrow-confirm').disabled = !!saveAttempt || draft.receipt?.signature === draftState();
  if (dialog) dialog.setAttribute('aria-busy', String(!!saveAttempt));
  root.querySelector('.pt-scroll').inert = !!saveAttempt;
}

function checkContext() {
  if (!root.classList.contains('open') || !draft) return;
  try { assertDraftTarget(); document.getElementById('pt-context-warning').hidden = true; }
  catch (err) {
    if (!draft) { saveAttempt = null; return; }
    const warning = document.getElementById('pt-context-warning'); warning.hidden = false; warning.querySelector('p').textContent = err.message;
  }
}

function context() {
  if (typeof globalThis.getPlanTomorrowAppContext !== 'function') throw new Error('Plan Tomorrow is not available yet.');
  return globalThis.getPlanTomorrowAppContext();
}

function scheduleLabel(routine) {
  if (routine.mode === 'exact') return routine.time;
  if (routine.mode === 'window') return `${routine.time}–${routine.endTime}`;
  return routine.mode === 'cue' ? `Cue: ${routine.cue}` : 'Anytime';
}

/** The routine instances that belong to a PLAN TARGET (Decision A).
 *
 *  Instance identity stays [routineId, calendarDate] — nothing is migrated. For
 *  a legacy day this is exactly the old behavior: generate that date's
 *  instances, use them all. For a personal day, instances are generated for each
 *  calendar date the day touches and then filtered by ownership: a timed routine
 *  belongs to the day containing its own start, an untimed one to the day
 *  containing 12:00 on its date. A routine whose local clock reading is
 *  ambiguous or nonexistent (DST) is never guessed into a day — it is reported
 *  in `unplaceable` so the UI can say so. */
function routinePlan(target, timezone) {
  const state = routineRepository.read(timezone);
  if (state.timezone !== timezone) return { state, mismatch: true, rows: [], unplaceable: [] };
  const learningPlans = createLearningPlanRepository().listPlans();
  const decorate = instance => {
    const learningPlan = instance.routine.source === 'learning' ? learningPlans.find(plan => plan.id === instance.routine.planId) : null;
    const likelyNext = learningPlan ? findNextLearningPlanStep(learningPlan) : null;
    return { ...instance, skipped: !!state.skips[instance.id], actionable: instance.routine.source !== 'learning' || !!likelyNext, likelyNext };
  };
  if (target.store !== 'operational') {
    return { state, mismatch: false, rows: generateInstances(state.routines, target.dateKey, state.timezone).map(decorate), unplaceable: [] };
  }
  const authority = globalThis.PlanAuthority;
  const candidates = routineCandidateDates(target, state.timezone)
    .flatMap(date => generateInstances(state.routines, date, state.timezone));
  const { rows, unplaceable } = authority.routinesForTarget(target, candidates);
  return { state, mismatch: false, rows: rows.map(decorate), unplaceable };
}

/** The calendar dates whose instances could possibly belong to this personal
 *  day: the dates its interval touches, plus one either side, because an
 *  untimed routine is anchored at noon of its own date (which can sit inside a
 *  personal day that starts on the previous date) and a timed one can sit
 *  anywhere in the interval. Ownership is then decided per instance, never by
 *  this list. */
function routineCandidateDates(target, timezone) {
  const day = 86400000;
  const dates = new Set();
  for (let instant = target.startMs - day; instant <= target.endMs + day; instant += day) {
    dates.add(new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(instant)));
  }
  return [...dates].sort();
}

function activeItems() {
  return draft.items.filter(item => !item.deleted);
}

/** Planning Continuity V1 — the 3-cap, the Open-Day affordance and preparation
 *  are all measured on TOP PRIORITIES. Secondary planned tasks are uncapped and
 *  never earn preparation credit, so they are counted separately everywhere. */
function activePriorities() {
  return activeItems().filter(isPriorityPlanItem);
}

function activeSecondary() {
  return activeItems().filter(isSecondaryPlanItem);
}

function activeRoutines() {
  return draft.routines.rows.filter(row => !row.skipped && row.actionable);
}

/** Today's one-off priorities relevant to Daily Reconciliation: classified via the same
 *  classifyOneOffActual authority the Review "Plan vs Actual" widget already uses, then bucketed
 *  into completed/unfinished. Deleted-after-prep items ('removed') are excluded — nothing to
 *  reconcile once an item is gone. Routines are out of scope: they already recur/skip on their
 *  own cadence, and "carry forward" has no analog for them.
 *
 *  `failed: true` means classification could not be determined — kept distinct from a legitimate
 *  empty `rows` (nothing to reconcile) so the renderer never shows "0 unfinished" as if it were a
 *  fact when it's actually an abstention. Reconciliation is supplementary context for Plan
 *  Tomorrow, never a precondition for it: either way `openPlanTomorrow` still opens. */
function buildReconciliation() {
  const authority = globalThis.PlanAuthority;
  try {
    // Reconciles the CURRENT authoritative day — for a graveyard owner that is
    // their personal day in progress, not the calendar date on the wall.
    const current = authority.current();
    const preparation = authority.preparation(current);
    const rows = authority.rawItems(current)
      .filter(item => !item.deleted)
      .map(item => {
        const trackedMinutes = context().trackedMinutes(current, item.task, item.id);
        const status = authority.classifyItemActual(current, item, { trackedMinutes, preparedAt: preparation?.firstPreparedAt || 0, timezone: preparation?.timezone });
        return { item, status, bucket: reconciliationBucket(status) };
      })
      .filter(row => row.bucket !== 'excluded');
    return { source: current, rows, failed: false };
  } catch {
    return { source: null, rows: [], failed: true };
  }
}

/** The tomorrow-draft item (if any) already carrying this today item forward — looked up by the
 *  deterministic carriedItemId(todayKey, todayItemId), NOT by scanning for a matching
 *  carriedFromId. Determinism is what makes carrying converge across devices: two clients that
 *  independently carry the same source item before syncing both write to this exact same id, so
 *  the existing per-id mergeDatePlans/chooseItem merge (highest updatedAt wins) collapses them
 *  into one active item instead of two random-id survivors. */
function carriedItemFor(todayItemId) {
  const source = draft.reconciliation?.source;
  if (!source) return null;
  const id = carryItemIdFor(source, todayItemId, draft.target);
  const existing = draft.items.find(item => item.id === id);
  return existing && !existing.deleted ? existing : null;
}

function toggleCarry(todayItemId) {
  const row = draft.reconciliation?.rows.find(r => r.item.id === todayItemId);
  if (!row) return;
  const source = draft.reconciliation.source;
  const id = carryItemIdFor(source, todayItemId, draft.target);
  const existing = draft.items.find(item => item.id === id);
  if (existing && !existing.deleted) {
    draft.items = draft.items.map(item => item.id === id ? context().stampItem({ ...item, deleted: true }) : item);
    return;
  }
  if (activePriorities().length >= context().maxItems) throw new Error(`Reduce tomorrow's plan to ${context().maxItems} priorities before carrying this forward.`);
  // A fresh stamp (no updatedAt/updatedBy passed in) always gets the current Date.now(), which is
  // later than any prior tombstone on this same id — so re-carrying correctly supersedes an
  // earlier un-carry via the existing chooseItem "highest updatedAt wins" rule, no special case.
  const carried = context().stampItem({ id, task: row.item.task, when: '', done: false, doneAt: null, carriedFromId: todayItemId,
    ...(typeof row.item.description === 'string' ? { description: row.item.description } : {}) });
  draft.items = existing ? draft.items.map(item => item.id === id ? carried : item) : [...draft.items, carried];
  draft.intentionalBlank = false;
}

/** Reason-for-slipping is optional, free-text, and lives on TODAY's plan item — written straight
 *  through the same savePlanItems path Today's own UI already uses for done/delete, never through
 *  confirmPreparedDatePlan. That keeps it fully outside preparation/Planning-Streak semantics:
 *  recording or editing a reason can never make tomorrow look "prepared". */
function withReconciliationReason(item, reason) {
  const next = { ...item };
  if (reason) next.reconciliationReason = reason;
  else delete next.reconciliationReason;
  return next;
}

function saveReconciliationReason(todayItemId, reasonValue) {
  assertDraftTarget();
  const reason = reasonValue.trim();
  const authority = globalThis.PlanAuthority;
  const source = authority.targetById(draft.reconciliation.source.id);
  if (!source || source.store !== draft.reconciliation.source.store || source.id !== authority.current()?.id) throw new Error('The source day changed. Review today before editing its reason.');
  authority.assertDirectSchedulingTarget(source);
  const original = draft.reconciliation.rows.find(row => row.item.id === todayItemId)?.item;
  const actual = authority.rawItems(source).find(item => item.id === todayItemId && !item.deleted);
  if (!actual || !sameOnWire(actual, original)) throw new Error('The source task changed. Reopen its review before editing.');
  const updated = authority.rawItems(source).map(item =>
    item.id === todayItemId ? context().stampItem(withReconciliationReason(item, reason)) : item);
  authority.saveItems(source, updated);
  draft.reconciliation.rows = draft.reconciliation.rows.map(row =>
    row.item.id === todayItemId ? { ...row, item: updated.find(item => item.id === todayItemId) } : row);
}

function formatTargetDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/** A legacy day is still named by its date. A personal day is named by the
 *  interval it actually is — "Wed Sep 16 18:00 → Thu Sep 17 18:00" — because
 *  calling it "Thursday" would be false for most of its hours. */
function targetHeading(target) {
  if (target.store !== 'operational') return formatTargetDate(target.dateKey);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: target.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fmt.format(new Date(target.startMs)).replace(',', '')} → ${fmt.format(new Date(target.endMs)).replace(',', '')}`;
}

/** Range validation for the day being edited: a legacy day keeps the existing
 *  midnight-clamped rule exactly; a personal day is checked against its own real
 *  interval, so 23:00 → 01:00 is ordinary there and 21:00 on a day truncated at
 *  20:00 is refused. */
function itemRangeValid(item) {
  const authority = globalThis.PlanAuthority;
  if (!authority || !draft) return validPlanItemRange(item.when, item.durationMinutes);
  return authority.validateItem(draft.target, item).ok;
}

function refreshRoutines() {
  draft.routines = routinePlan(draft.target, draft.timezone);
}

function suggestionRows() {
  const selected = new Set(activeItems().map(item => context().normalizeTask(item.task)));
  const suggestions = context().suggestions(draft.target).slice();
  const seen = new Set();
  return suggestions.filter(item => {
    const key = context().normalizeTask(item.task);
    if (!key || selected.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function routineHtml() {
  if (draft.routines.mismatch) return `<div class="pt-warning" role="status">Routines use ${escape(draft.routines.state.timezone)}; Today uses ${escape(draft.timezone)}. One-off planning is still available.</div>`;
  // A routine whose own clock reading is ambiguous or does not exist (a DST
  // change) is never filed into a day by guesswork — it is named here instead.
  const unplaceable = (draft.routines.unplaceable || []).length
    ? `<div class="pt-warning" role="status">${draft.routines.unplaceable.length} routine${draft.routines.unplaceable.length === 1 ? '' : 's'} can’t be placed in a personal day because of a clock change on ${escape(draft.routines.unplaceable.map(entry => entry.instance.date).join(', '))}. Plan them by hand.</div>`
    : '';
  if (!draft.routines.rows.length) return unplaceable + '<p class="pt-muted">No routines occur on this date.</p>';
  return unplaceable + draft.routines.rows.map(row => {
    const routine = row.routine;
    const detail = [`Target ${routine.targetMinutes} min`];
    if (routine.minimumMinutes) detail.push(`Minimum ${routine.minimumMinutes} min`);
    if (routine.fallback) detail.push(`Fallback: ${routine.fallback}`);
    return `<article class="pt-routine${row.skipped ? ' skipped' : ''}" data-pt-instance="${escape(row.id)}">
      <div><strong>${escape(routine.title)}</strong><div class="pt-muted">${escape(scheduleLabel(routine))} · ${escape(detail.join(' · '))}</div>
      ${routine.source === 'learning' ? `<div class="pt-learning">${row.likelyNext ? `Likely next: ${escape(row.likelyNext.stepTitle)}` : 'No unfinished Learning action'}</div>` : ''}</div>
      <button type="button" class="btn sm ghost" data-pt-action="${row.skipped ? 'unskip' : 'skip'}" data-id="${escape(row.id)}">${row.skipped ? 'Restore tomorrow' : 'Skip tomorrow'}</button>
    </article>`;
  }).join('');
}

// Faster Scheduling V1 — quick presets are UI convenience only; every choice (quick or custom)
// converges on the exact same stored fields (`when`, `durationMinutes`) via context().stampItem.
const QUICK_STARTS = [
  { label: '8 AM', value: '08:00' },
  { label: '9 AM', value: '09:00' },
  { label: '10 AM', value: '10:00' },
  { label: 'Noon', value: '12:00' },
  { label: '2 PM', value: '14:00' }
];
const QUICK_DURATIONS = [
  { label: '30m', value: 30 },
  { label: '1h', value: 60 },
  { label: '1.5h', value: 90 },
  { label: '2h', value: 120 }
];

/** Applies a new start to an item, dropping any existing duration the new start would make
 *  invalid (e.g. 09:00+2h -> 23:00 would run past midnight) in the SAME mutation — never leaves a
 *  hidden durationMinutes that could later resurrect a stale range. A duration that's still valid
 *  against the new start (e.g. 09:00+2h -> 10:00) is left untouched. */
function withNewStart(item, when) {
  const next = { ...item, when };
  return itemRangeValid(next) ? next : clearPlanItemRange(next);
}

function chipRowHtml({ id, labelId, options, current, action }) {
  const chips = options.map(opt => {
    const selected = current === opt.value;
    return `<button type="button" class="pt-chip${selected ? ' selected' : ''}" data-pt-action="${action}" data-id="${escape(id)}" data-value="${opt.value}" aria-pressed="${selected}">${escape(opt.label)}</button>`;
  }).join('');
  return `<div class="pt-chip-row" role="group" aria-labelledby="${labelId}">${chips}</div>`;
}

/** A calendar plan's item, as the store will see it: marked calendar-native so a range that
 *  crosses midnight (Sunday 23:00 → Monday 01:00) is drawn as one. Drafts are not stamped with a
 *  zone until they are saved, so the marker is supplied here for display only. */
function scheduleView(item) {
  return draft?.target?.store === 'calendar' && !item.whenTz ? { ...item, whenTz: draft.timezone } : item;
}

function schedulePanelHtml(item) {
  const timed = validPlanItemTime(item.when);
  const startLabelId = `pt-start-label-${escape(item.id)}`;
  const nextDayToggle = draft?.target?.store === 'calendar' && timed
    ? `<label class="pt-schedule-custom"><input type="checkbox" class="pt-nextday-input" data-pt-nextday="${escape(item.id)}" aria-label="Next day: ${escape(item.task)}" ${item.whenDayOffset === 1 ? 'checked' : ''}> Next day (after midnight)</label>`
    : '';
  const startRow = `<div class="pt-schedule-row">
    <span class="pt-schedule-label" id="${startLabelId}">Start</span>
    ${chipRowHtml({ id: item.id, labelId: startLabelId, options: QUICK_STARTS, current: item.when, action: 'quick-start' })}
    <label class="pt-schedule-custom">Custom <input type="time" class="pt-time-input" data-pt-time="${escape(item.id)}" aria-label="Custom start time for ${escape(item.task)}" value="${timed ? escape(item.when) : ''}"></label>
    ${nextDayToggle}
  </div>`;
  if (!timed) return `<div class="pt-schedule-panel" data-pt-schedule-panel="${escape(item.id)}">${startRow}</div>`;
  const lengthLabelId = `pt-length-label-${escape(item.id)}`;
  const endValue = planItemEndTime(item.when, item.durationMinutes, draft?.target?.store === 'calendar') || '';
  const lengthRow = `<div class="pt-schedule-row">
    <span class="pt-schedule-label" id="${lengthLabelId}">Length</span>
    ${chipRowHtml({ id: item.id, labelId: lengthLabelId, options: QUICK_DURATIONS, current: item.durationMinutes, action: 'quick-duration' })}
    <label class="pt-schedule-custom">Custom end <input type="time" class="pt-end-input" data-pt-end="${escape(item.id)}" aria-label="Custom end time for ${escape(item.task)}" value="${escape(endValue)}"></label>
  </div>`;
  return `<div class="pt-schedule-panel" data-pt-schedule-panel="${escape(item.id)}">${startRow}${lengthRow}</div>`;
}

function scheduleControlHtml(item) {
  if (draft.schedulingId === item.id) return schedulePanelHtml(item);
  const timed = validPlanItemTime(item.when);
  if (!timed) {
    return `<button type="button" class="pt-time-link add" data-pt-action="edit-schedule" data-id="${escape(item.id)}" aria-label="Set time for ${escape(item.task)}">+ Add time</button>`;
  }
  const label = formatPlanItemSchedule(scheduleView(item));
  const ranged = !!planItemEndTime(item.when, item.durationMinutes, draft?.target?.store === 'calendar');
  const rangeControl = ranged ? `<span aria-hidden="true"> · </span>
      <button type="button" class="pt-time-link" data-pt-action="remove-range" data-id="${escape(item.id)}" aria-label="Remove range for ${escape(item.task)}">Remove range</button>` : '';
  return `<span class="pt-time-value">${escape(label)}</span>
      <button type="button" class="pt-time-link" data-pt-action="edit-schedule" data-id="${escape(item.id)}" aria-label="Change time for ${escape(item.task)}">Change</button>
      ${rangeControl}
      <span aria-hidden="true"> · </span>
      <button type="button" class="pt-time-link" data-pt-action="remove-time" data-id="${escape(item.id)}" aria-label="Remove time for ${escape(item.task)}">Remove time</button>`;
}

function itemHtml() {
  const items = activePriorities();
  const overCap = items.length > context().maxItems;
  const rows = items.map(item => {
    const timed = validPlanItemTime(item.when);
    const legacyWhen = !timed && item.when ? `<span class="plan-when">${escape(item.when)} →</span> ` : '';
    return `<div class="pt-oneoff" data-pt-item="${escape(item.id)}">
      <div class="pt-oneoff-main">
        <div class="pt-oneoff-task">${legacyWhen}${escape(item.task)}</div>
        <div class="pt-oneoff-time">${scheduleControlHtml(item)}</div>
      </div>
      <button type="button" class="pt-kind" data-pt-action="kind" data-kind="task" data-id="${escape(item.id)}">Move to other tasks</button>
      <button type="button" class="plan-remove" data-pt-action="remove" data-id="${escape(item.id)}" aria-label="Remove ${escape(item.task)} from plan" title="Remove from plan">✕</button>
    </div>`;
  }).join('');
  const add = items.length < context().maxItems ? `<form id="plan-tomorrow-add" class="pt-add"><input name="when" maxlength="40" placeholder="Time (optional)" aria-label="Priority time (optional)"><input name="task" maxlength="80" placeholder="Add a priority…" aria-label="New priority"><button class="btn sm" type="submit">Add</button></form>` : '';
  const warning = overCap ? `<div class="pt-warning">${items.length} priorities arrived from synced devices. Nothing was deleted; reduce to ${context().maxItems} before confirming.</div>` : '';
  const suggestions = items.length < context().maxItems ? suggestionRows() : [];
  const chips = suggestions.length ? `<div class="pt-chips">${suggestions.map(item => `<button type="button" class="rv-plan-chip ${escape(item.tag)}" data-pt-action="suggest" data-task="${escape(item.task)}">${escape(item.task)}<span class="rv-chip-tag">${escape(item.tag)}</span></button>`).join('')}</div>` : '';
  return warning + (rows || '<p class="pt-muted">What would make this day a good one?</p>') + add + chips;
}

/** Other planned tasks — real plan capacity with NO artificial cap. They never
 *  count against the Top 3 and never earn preparation/readiness credit, so this
 *  section has no counter against a maximum and no over-cap warning. */
function secondaryHtml() {
  const items = activeSecondary();
  const rows = items.map(item => {
    const timed = validPlanItemTime(item.when);
    const legacyWhen = !timed && item.when ? `<span class="plan-when">${escape(item.when)} →</span> ` : '';
    return `<div class="pt-oneoff pt-secondary" data-pt-item="${escape(item.id)}">
      <div class="pt-oneoff-main">
        <div class="pt-oneoff-task">${legacyWhen}${escape(item.task)}</div>
        <div class="pt-oneoff-time">${scheduleControlHtml(item)}</div>
      </div>
      <button type="button" class="pt-kind" data-pt-action="kind" data-kind="priority" data-id="${escape(item.id)}">Move to Top 3</button>
      <button type="button" class="plan-remove" data-pt-action="remove" data-id="${escape(item.id)}" aria-label="Remove ${escape(item.task)} from plan" title="Remove from plan">✕</button>
    </div>`;
  }).join('');
  const add = `<form id="plan-tomorrow-add-task" class="pt-add"><input name="when" maxlength="40" placeholder="Time (optional)" aria-label="Task time (optional)"><input name="task" maxlength="80" placeholder="Add another task…" aria-label="New task"><button class="btn sm" type="submit">Add</button></form>`;
  return (rows || '<p class="pt-muted">Nothing else planned.</p>') + add;
}

function reconciliationHtml() {
  const reconciliation = draft.reconciliation;
  if (!reconciliation) return '';
  // Failed classification must never render as "nothing to reconcile" — that would silently claim
  // zero unfinished items when the truth is actually unknown. Show a neutral abstention instead,
  // with no rows, no reason boxes, and no carry controls (there is nothing safe to act on).
  if (reconciliation.failed) return '<section class="pt-reconcile"><p class="pt-muted" role="status">Today’s priorities couldn’t be reconciled right now. You can still plan tomorrow.</p></section>';
  if (!reconciliation.rows.length) return '';
  const unfinished = reconciliation.rows.filter(row => row.bucket === 'unfinished');
  const completed = reconciliation.rows.filter(row => row.bucket === 'completed');
  const unfinishedHtml = unfinished.map(row => {
    const carried = carriedItemFor(row.item.id);
    return `<div class="pt-reconcile-row pt-reconcile-unfinished" data-pt-reconcile-item="${escape(row.item.id)}">
      <div class="pt-reconcile-row-main">
        <div class="pt-reconcile-task">${escape(row.item.task)}</div>
        <textarea class="pt-reconcile-reason" data-pt-reason="${escape(row.item.id)}" maxlength="240" placeholder="Why did this slip? (optional)" aria-label="Why did &quot;${escape(row.item.task)}&quot; slip?">${escape(row.item.reconciliationReason || '')}</textarea>
      </div>
      <button type="button" class="btn sm ghost pt-reconcile-carry${carried ? ' selected' : ''}" data-pt-action="carry" data-id="${escape(row.item.id)}">${carried ? '✓ Carrying to tomorrow' : 'Carry to tomorrow'}</button>
    </div>`;
  }).join('');
  const completedHtml = completed.map(row => `<div class="pt-reconcile-row pt-reconcile-done">
      <div class="pt-reconcile-row-main"><div class="pt-reconcile-task"><span aria-hidden="true">✓ </span>${escape(row.item.task)}</div></div>
    </div>`).join('');
  return `<section class="pt-reconcile"><h3>Today <span>${unfinished.length} unfinished · ${completed.length} done</span></h3>${unfinishedHtml}${completedHtml}</section>`;
}

function renderNormal() {
  // Only priorities and routines make a day actionable — adding secondary tasks
  // must never remove the need to state an intention (or to choose Open day).
  const actionable = activeRoutines().length + activePriorities().filter(item => !item.done).length;
  return `<section><h3>Top 3 priorities <span>${activePriorities().length}/${context().maxItems}</span></h3><p class="pt-muted pt-section-intro">Choose up to three outcomes. Leave room for the rest of your day.</p>${itemHtml()}</section>
    <details class="pt-fold" data-pt-fold="other"><summary>Other planned tasks <span>${activeSecondary().length}</span></summary>${secondaryHtml()}</details>
    <details class="pt-fold" data-pt-fold="routines"><summary>Routines already included <span>${activeRoutines().length}</span></summary>${routineHtml()}</details>
    ${actionable ? '' : `<button type="button" class="btn ghost pt-open-day${draft.intentionalBlank ? ' selected' : ''}" data-pt-action="blank">${draft.intentionalBlank ? '✓ ' : ''}Open day / no commitments</button>`}`;
}

function renderRescue() {
  const routines = activeRoutines().length;
  const priorities = activePriorities().filter(item => !item.done).length;
  if (routines + priorities) return `<div class="pt-rescue"><h3>${routines || 'No'} routine${routines === 1 ? '' : 's'} · ${priorities || 'no'} priorit${priorities === 1 ? 'y' : 'ies'}</h3><p>Use this plan as it is. No additional scheduling decisions needed.</p>${draft.routines.mismatch ? routineHtml() : ''}</div>`;
  return `<div class="pt-rescue"><h3>Keep it minimal</h3><form id="plan-tomorrow-rescue-add" class="pt-add"><input name="task" maxlength="80" placeholder="one anytime priority"><button class="btn sm" type="submit">Add</button></form><span class="pt-or">or</span><button type="button" class="btn ghost pt-open-day${draft.intentionalBlank ? ' selected' : ''}" data-pt-action="blank">${draft.intentionalBlank ? '✓ ' : ''}Open day / no commitments</button></div>`;
}

// Set for the duration of body.innerHTML's own assignment below. Replacing markup that contains
// the currently-focused element (e.g. a just-clicked quick-pick chip) synchronously fires a
// focusout against that stale, about-to-be-removed node before the new markup is even inserted —
// indistinguishable, by target or relatedTarget alone, from a genuine "focus left the panel"
// click-away. The scheduling-panel focusout handler below checks this flag to ignore that
// self-inflicted event rather than misreading its own re-render as the user clicking away.
let rendering = false;

function render() {
  if (!draft || !body) return;
  captureForms();
  const folds = body.dataset.ptOwner === draft.owner ? Object.fromEntries([...body.querySelectorAll('details[data-pt-fold]')].map(el => [el.dataset.ptFold, el.open])) : {};
  rendering = true;
  try {
    // The heading stays natural; the authoritative date range, boundary and zone remain below.
    const usesPersonalDay = draft.target.store === 'operational';
    // Planning Continuity V1: when an ARBITRARY future day is being prepared, neither
    // 'tomorrow' nor 'next personal day' is true — name the day itself so the owner can
    // never be editing one day while the title claims another.
    document.getElementById('plan-tomorrow-title').textContent = draft.explicitDay
      ? `Plan ${draft.dayLabel}`
      : 'Plan your next day';
    document.getElementById('plan-tomorrow-date').textContent = draft.heading;
    document.getElementById('plan-tomorrow-timezone').textContent = draft.target.store === 'operational' ? draft.target.timezone : draft.timezone;
    const startsEl = document.getElementById('plan-tomorrow-starts');
    if (startsEl) startsEl.textContent = usesPersonalDay ? describeDayStart(draft.target.startMs, draft.target.boundaryTime, draft.target.timezone, Date.now()) : '';
    const authority = globalThis.PlanAuthority;
    const readyNow = authority.readyNow(draft.target, draft.routines.rows);
    const consistency = authority.consistency(draft.target);
    const readiness = document.getElementById('plan-tomorrow-readiness');
    readiness.textContent = consistency === 'not-prepared' ? '' : `${readyNow ? 'Ready to use' : 'Saved plan needs review'} · ${consistency === 'ahead' ? 'planned ahead' : consistency === 'late' ? 'planned after the day started' : 'planning time unknown'}`;
    readiness.dataset.ready = String(readyNow);
    document.querySelectorAll('[data-pt-mode]').forEach(button => button.classList.toggle('selected', button.dataset.ptMode === draft.mode));
    const latest = draft.latestReview ? `<section class="pt-latest pt-warning"><h3>Latest saved plan · read-only</h3>${authority.rawItems(draft.target).filter(item => !item.deleted).map(item => `<p>${escape(item.task)} · ${escape(item.when || 'Anytime')}</p>`).join('') || '<p>No active saved tasks.</p>'}<p>Your draft remains below. Starting fresh explicitly discards its unsaved changes.</p><button type="button" class="btn sm" data-pt-action="fresh">Start from latest plan</button></section>` : '';
    body.innerHTML = `${latest}<div class="pt-zones"><div class="pt-plan-zone">${draft.mode === 'rescue' ? renderRescue() : renderNormal()}<details class="pt-fold" data-pt-fold="unfinished"><summary>Unfinished work and today's review</summary>${reconciliationHtml()}</details></div>${considerationHtml()}</div>`;
    // Logical order matches the phone hierarchy and keyboard reading order at every width.
    body.querySelector('.pt-plan-zone').firstElementChild.after(body.querySelector('.pt-consider'));
    root.querySelector('.pt-source-jump').textContent = `From Brain Dump · ${body.querySelectorAll('.pt-candidate').length}`;
    body.dataset.ptOwner = draft.owner; body.dataset.ptTarget = draft.target.id; body.dataset.ptDraft = String(draft.instance);
    for (const row of body.querySelectorAll('[data-pt-item]')) {
      const item = draft.items.find(candidate => candidate.id === row.dataset.ptItem);
      const main = row.querySelector('.pt-oneoff-main');
      if (!item || !main) continue;
      const edit = document.createElement('details'); edit.className = 'pt-edit';
      edit.innerHTML = `<summary>Edit task</summary><label>Headline<input maxlength="200" data-pt-title="${escape(item.id)}" value="${escape(item.task)}"></label><label>Notes (optional)<textarea maxlength="1000" data-pt-notes="${escape(item.id)}">${escape(typeof item.description === 'string' ? item.description : '')}</textarea></label>`;
      edit.append(row.querySelector('.pt-kind'));
      main.append(edit);
    }
    for (const el of body.querySelectorAll('details[data-pt-fold]')) if (Object.hasOwn(folds, el.dataset.ptFold)) el.open = folds[el.dataset.ptFold];
    restoreForms();
    document.getElementById('plan-tomorrow-confirm').textContent = 'Save plan';
    error.textContent = '';
    plannerStatus();checkContext();
    if (draft.schedulingId) body.querySelector(`[data-pt-schedule-panel="${draft.schedulingId}"] .pt-time-input`)?.focus();
  } finally {
    rendering = false;
  }
}

/** "Tomorrow" is the UPCOMING AUTHORITATIVE DAY. For a legacy account that is
 *  tomorrow's calendar date exactly as before; for a graveyard owner at 08:00
 *  with an 18:00 boundary it is the personal day that begins at 18:00 today —
 *  which is why this no longer computes a date of its own. */
/** Prepares a personal day. With no argument that is the UPCOMING day, exactly as
 *  before. Planning Continuity V1 adds an explicit `target`, so an arbitrary FUTURE
 *  personal day is prepared through this SAME workflow — deliberately reusing the one
 *  preparation surface rather than adding a second editor, which is the defect Single
 *  Plan Authority V1 exists to prevent. */
/** The day being prepared, named by its real interval (index.html's own
 *  planTargetLabel when available, which is what every other surface uses). */
function planTargetDayLabel(target) {
  if (typeof globalThis.planTargetLabel === 'function') return globalThis.planTargetLabel(target);
  return target.store !== 'operational' ? target.dateKey : new Date(target.startMs).toISOString().slice(0, 10);
}

export function openPlanTomorrow({ returnToReview = false, target: explicitTarget = null } = {}) {
  try {
    const app = context();
    const authority = globalThis.PlanAuthority;
    if (!authority) throw new Error('Planning is still loading.');
    const owner = appRoomOwner();
    if (!owner || globalThis.accountLocalKey?.('ta3-plan-tomorrow-draft-v1') !== `ta3-plan-tomorrow-draft-v1:${owner}`) throw new Error('Sign in and let your plan load before planning.');
    if (draft && draft.owner !== owner) { hidePreparation(false); draft = null; saveAttempt = null; }
    let target = explicitTarget || authority.upcoming();
    let saved = null;
    try {
      const raw = window.sessionStorage.getItem(checkpointKey());
      const candidate = raw && raw.length <= CHECKPOINT_LIMIT ? JSON.parse(raw) : null;
      if (candidate?.v === 1 && candidate.owner === owner && Array.isArray(candidate.items) && candidate.items.every(item => item && typeof item.id === 'string' && typeof item.task === 'string') && typeof candidate.base === 'string' && typeof candidate.initial === 'string') saved = candidate;
    } catch { /* No checkpoint is applied without a valid account/target-bound envelope. */ }
    if (draft?.owner === owner && draft.target.id !== target.id && draftState() !== draft.initial) {
      target = draft.target; // Never replace another day's unsaved work merely because "tomorrow" advanced.
    } else if (!draft && !explicitTarget && saved && saved.targetId !== target.id) {
      target = authority.targetById(saved.targetId) || target;
    }
    const preparation = authority.preparation(target);
    const resume = draft?.owner === owner && draft.target.id === target.id && (draftState() !== draft.initial || !!saveAttempt || (draft.receipt && draft.receipt.message !== 'Saved · sync confirmed'));
    if (!resume) draft = {
      instance: ++draftInstance,
      owner,
      target,
      heading: targetHeading(target),
      base: sourceState(target),
      forms: {},
      explicitDay: !!explicitTarget,
      dayLabel: explicitTarget ? planTargetDayLabel(explicitTarget) : '',
      returnToReview,
      timezone: app.timezone,
      items: authority.rawItems(target).map(item => ({ ...item })),
      routines: routinePlan(target, app.timezone),
      mode: 'normal',
      intentionalBlank: preparation?.intentionalBlank || false,
      schedulingId: null,
      // Daily Reconciliation compares TODAY against the day being prepared next. For an
      // arbitrary future day there is no such relationship, so it is omitted rather
      // than shown against the wrong day.
      reconciliation: explicitTarget ? null : buildReconciliation()
    };
    if (!resume) {
      draft.initial = draftState();
      if (saved?.targetId === target.id) {
        draft.items = saved.items; draft.mode = saved.mode === 'rescue' ? 'rescue' : 'normal';
        draft.intentionalBlank = saved.blank === true; draft.forms = saved.forms && typeof saved.forms === 'object' ? saved.forms : {};
        draft.base = saved.base; draft.initial = saved.initial; draft.heading = saved.targetHeading;
        if (typeof saved.timezone === 'string') draft.timezone = saved.timezone;
        draft.explicitDay = saved.explicitDay === true; draft.receipt = saved.receipt || null;
        if (draft.receipt) draft.receipt.message = 'Saved draft recovered · sync not confirmed. Review before editing.';
      }
    }
    opener = document.activeElement;
    document.getElementById('pt-return').hidden = true;
    root.classList.add('open');
    root.style.setProperty('--pt-visible-height', `${window.visualViewport?.height || window.innerHeight}px`);
    for (const el of document.body.children) if (el !== root && el.id !== 'pt-exit' && !el.inert) { el.inert = true; inerted.add(el); }
    render();
    clearInterval(liveCheck); liveCheck = setInterval(checkContext, LIVE_CHECK_MS);
    document.getElementById('plan-tomorrow-title').tabIndex = -1;
    document.getElementById('plan-tomorrow-title').focus({ preventScroll: true });
  } catch (err) {
    globalThis.showToast(err.message);
  }
}

function closePreparation() {
  assertDraftOwner();captureForms();
  if (draftState() !== draft.initial) {
    checkpoint();document.getElementById('pt-exit').showModal();return;
  }
  hidePreparation();
}

/** "Make task" / "Make priority" inside the preparation draft. Only kind changes; the
 *  id and every other field are kept. Promotion into a full Top 3 is refused, never a
 *  silent swap. */
function setDraftItemKind(itemId, kind) {
  const current = draft.items.find(item => item.id === itemId && !item.deleted);
  if (!current) throw new Error('That item is no longer in this plan.');
  if (kind === 'priority' && activePriorities().filter(item => item.id !== itemId).length >= context().maxItems) {
    throw new Error('Your Top ' + context().maxItems + ' is already full. Remove or demote one first.');
  }
  draft.items = draft.items.map(item => (item.id === itemId ? context().stampItem(withPlanItemKind(item, kind)) : item));
}

function addItem(task, when = '', kind = 'priority') {
  if (kind === 'priority' && activePriorities().length >= context().maxItems) {
    throw new Error(`${context().maxItems} priorities is the cap — add it under Other planned tasks instead.`);
  }
  draft.items.push(context().createItem(task, when, kind));
  // A secondary task is not an intention, so it must not silently clear an
  // explicit Open Day choice the way adding a priority does.
  if (kind === 'priority') draft.intentionalBlank = false;
}

async function confirmDraft() {
  assertDraftTarget();captureForms();
  if (saveAttempt || draft.receipt?.signature === draftState()) return;
  if (Object.values(draft.forms).some(value => value)) throw new Error('Add or clear the unfinished task input before saving.');
  if (activeItems().some(item => !item.task.trim() || item.task.length > 200 || (typeof item.description === 'string' && item.description.length > 1000))) throw new Error('Each task needs a headline up to 200 characters and notes up to 1000 characters.');
  const unfinishedItems = activePriorities().filter(item => !item.done);
  const routines = activeRoutines();
  if (activePriorities().length > context().maxItems) throw new Error(`Reduce the plan to ${context().maxItems} priorities before confirming.`);
  const intentionalBlank = routines.length + unfinishedItems.length === 0 && draft.intentionalBlank;
  if (!routines.length && !unfinishedItems.length && !intentionalBlank) throw new Error('Add one priority, keep a routine, or choose Open day.');
  const authority = globalThis.PlanAuthority;
  const working = draft;
  const attempt = { owner: draft.owner, targetId: draft.target.id };
  saveAttempt = attempt;plannerStatus();
  let result;
  try { result = authority.confirmPreparation(draft.target, {
    items: draft.items.map(item => ({ ...item })),
    mode: draft.mode,
    intentionalBlank,
    routineInstanceIds: draft.routines.rows.filter(row => row.actionable).map(row => row.id),
    actionableRoutineInstanceIds: routines.map(row => row.id)
  });
    if (!result.localSaved || !authority.readyNow(draft.target, routines)) throw new Error('Tomorrow could not be marked ready. Your draft is still open.');
    draft.base = sourceState(draft.target);draft.initial = draftState();
    draft.receipt = { signature: draftState(), message: 'Saved on this device · sync pending' };
    checkpoint();plannerStatus();
    const cloudSynced = await Promise.resolve(result.syncPromise).catch(() => false);
    if (draft !== working || appRoomOwner() !== attempt.owner) return;
    try { assertDraftTarget(); }
    catch (err) { draft.receipt.message = `Saved locally; current plan needs review. ${err.message}`;checkpoint();return; }
    draft.receipt.message = cloudSynced === true ? 'Saved · sync confirmed' : 'Saved on this device · sync not confirmed';
    checkpoint();
    if (cloudSynced === true && draft.receipt.signature === draftState()) { clearCheckpoint();if (root.classList.contains('open')) hidePreparation(); }
  } finally {
    if (saveAttempt === attempt) saveAttempt = null;
    if (draft === working && appRoomOwner() === attempt.owner) plannerStatus();
  }
}

root?.addEventListener('click', async event => {
  if (event.target === root) { try { closePreparation(); } catch (err) { error.textContent = err.message; } return; }
  const control = event.target.closest('[data-pt-action], [data-pt-mode]');
  if (!control || !draft) return;
  try {
    assertDraftOwner();
    if (saveAttempt && control.dataset.ptAction !== 'close') return;
    if (control.dataset.ptMode) { draft.mode = control.dataset.ptMode; render();checkpoint(); return; }
    const action = control.dataset.ptAction;
    if (action === 'close') { closePreparation(); return; }
    if (action === 'consider') {
      const ideas = body.querySelector('.pt-consider');
      ideas.open = true;
      ideas.querySelector('summary').focus({ preventScroll: true });
      ideas.scrollIntoView({ block: 'start', behavior: 'instant' });
      return;
    }
    if (action === 'brain-dump') {
      if (!checkpoint()) return;
      hidePreparation(false);globalThis.showView('braindump');document.getElementById('pt-return').hidden = false;return;
    }
    if (action === 'latest') { draft.latestReview = true;render();return; }
    if (action === 'fresh') {
      if (!window.confirm('Discard unsaved draft changes and open the latest plan? Already saved tasks stay in your plan.')) return;
      const target = draft.explicitDay ? draft.target : null;
      clearCheckpoint();hidePreparation(false);draft = null;openPlanTomorrow({target});return;
    }
    if (action === 'blank') { draft.intentionalBlank = !draft.intentionalBlank; render();checkpoint(); return; }
    if (action === 'kind') setDraftItemKind(control.dataset.id, control.dataset.kind);
    if (action === 'remove') draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem({ ...item, deleted: true }) : item);
    if (action === 'edit-schedule') draft.schedulingId = control.dataset.id;
    if (action === 'remove-time') {
      draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem(clearPlanItemRange({ ...item, when: '' })) : item);
      draft.schedulingId = null;
    }
    if (action === 'remove-range') {
      draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem(clearPlanItemRange(item)) : item);
    }
    if (action === 'quick-start') {
      draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem(withNewStart(item, control.dataset.value)) : item);
    }
    if (action === 'quick-duration') {
      // Validate BEFORE touching draft state: an invalid pick (e.g. 23:00 + 2h crossing midnight)
      // must never overwrite the last-known-good duration, even transiently — see Blocker 1.
      const value = Number(control.dataset.value);
      const target = draft.items.find(item => item.id === control.dataset.id);
      if (!target || !itemRangeValid({ ...target, durationMinutes: value })) {
        throw new Error(draft.target.store === 'operational'
          ? 'That length would run past the end of this personal day. Choose a shorter length.'
          : 'That length would run past midnight. Choose a shorter length.');
      }
      draft.items = draft.items.map(item => item.id === control.dataset.id ? context().stampItem({ ...item, durationMinutes: value }) : item);
      draft.schedulingId = null;
    }
    if (action === 'suggest') addItem(control.dataset.task);
    if (action === 'carry') toggleCarry(control.dataset.id);
    if (action === 'skip' || action === 'unskip') {
      assertDraftTarget();
      routineRepository.setDateSkip(draft.routines.state.timezone, control.dataset.id, action === 'skip');
      refreshRoutines();
      if (action === 'unskip') draft.intentionalBlank = false;
    }
    if (action === 'confirm') { await confirmDraft(); return; }
    render();
    checkpoint();
  } catch (err) { error.textContent = err.message; }
});

// The "next day" checkbox of a calendar plan's item. Only the offset changes; whichever range no
// longer fits the plan's two dates is dropped in the SAME mutation (never left hidden).
root?.addEventListener('change', event => {
  const toggle = event.target.closest('.pt-nextday-input');
  if (!toggle || !draft) return;
  const id = toggle.dataset.ptNextday;
  draft.items = draft.items.map(item => {
    if (item.id !== id) return item;
    const next = { ...item };
    if (toggle.checked) next.whenDayOffset = 1; else delete next.whenDayOffset;
    return context().stampItem(itemRangeValid(next) ? next : clearPlanItemRange(next));
  });
  render();
  checkpoint();
});

root?.addEventListener('change', event => {
  const input = event.target.closest('.pt-time-input');
  if (!input || !draft) return;
  const id = input.dataset.ptTime;
  draft.items = draft.items.map(item => item.id === id ? context().stampItem(withNewStart(item, input.value)) : item);
  draft.schedulingId = null;
  render();
  checkpoint();
});

// Custom end time is picked as an exact clock time (a second native time input, never a raw
// minutes field) and converted to the stored durationMinutes here — the only place that
// conversion happens, so quick-duration chips and this custom path always converge on the same
// field. An empty value means "backed out without choosing" and is left alone, not an error.
root?.addEventListener('change', event => {
  const input = event.target.closest('.pt-end-input');
  if (!input || !draft || !input.value) return;
  const id = input.dataset.ptEnd;
  const item = draft.items.find(i => i.id === id);
  try {
    let duration = item ? durationBetween(item.when, input.value) : null;
    // In a calendar plan an end at or before the start means "the next day": 23:00 -> 01:00 is 120 minutes.
    if (!duration && item && draft.target.store === 'calendar' && validPlanItemTime(item.when) && validPlanItemTime(input.value) && input.value !== item.when) {
      const toMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
      duration = toMinutes(input.value) + 24 * 60 - toMinutes(item.when);
    }
    if (!duration) throw new Error('End time must be later than the start, on the same day.');
    if (!itemRangeValid({ ...item, durationMinutes: duration })) {
      throw new Error(draft.target.store === 'operational'
        ? 'End time must be within 12 hours of the start, inside this personal day.'
        : 'End time must be within 12 hours of the start.');
    }
    draft.items = draft.items.map(i => i.id === id ? context().stampItem({ ...i, durationMinutes: duration }) : i);
    draft.schedulingId = null;
    render();
    checkpoint();
  } catch (err) { error.textContent = err.message; }
});

root?.addEventListener('change', event => {
  const textarea = event.target.closest('.pt-reconcile-reason');
  if (!textarea || !draft?.reconciliation) return;
  try { saveReconciliationReason(textarea.dataset.ptReason, textarea.value); }
  catch (err) { error.textContent = err.message; }
});

// Focus moving to a sibling control inside the same scheduling panel (a quick-pick button, the
// other native input) must not collapse it out from under an in-progress click; only focus
// actually leaving the panel closes it, mirroring the prior single-input "click away" behavior.
root?.addEventListener('focusout', event => {
  if (rendering) return; // our own re-render detached the focused node — not a real click-away
  const panel = event.target.closest('[data-pt-schedule-panel]');
  if (!panel || !draft || draft.schedulingId !== panel.dataset.ptSchedulePanel) return;
  if (event.relatedTarget && panel.contains(event.relatedTarget)) return;
  draft.schedulingId = null;
  render();
});

root?.addEventListener('submit', event => {
  if (!event.target.matches('#plan-tomorrow-add, #plan-tomorrow-rescue-add, #plan-tomorrow-add-task')) return;
  event.preventDefault();
  const kind = event.target.id === 'plan-tomorrow-add-task' ? 'task' : 'priority';
  try {
    assertDraftOwner();
    const data = new FormData(event.target);
    const task = String(data.get('task') || '').trim();
    if (!task) throw new Error(kind === 'task' ? 'Name the task first.' : 'Name the priority first.');
    addItem(task, String(data.get('when') || '').trim(), kind);
    event.target.reset();
    render();
    checkpoint();
  } catch (err) { error.textContent = err.message; }
});

root?.addEventListener('input', event => {
  if (!draft || !event.target.matches('form input[name],[data-pt-title],[data-pt-notes]')) return;
  try {
    assertDraftOwner();
    const input = event.target;
    const id = input.dataset.ptTitle || input.dataset.ptNotes;
    if (id) draft.items = draft.items.map(item => item.id === id ? context().stampItem({ ...item, [input.dataset.ptTitle ? 'task' : 'description']: input.value }) : item);
    captureForms();checkpoint();plannerStatus();
  }
  catch (err) { error.textContent = err.message; }
});

export function getPlanTomorrowRoutineSummary(target, timezone = context().timezone) {
  return routinePlan(target, timezone);
}

/** Each row's own calendar date comes from the instance id it was prepared
 *  under ([routineId, date]), not from a single date passed in — that is what
 *  lets a personal day's preparation, whose routines can span two calendar
 *  dates, reconcile each one against the date it actually occurs on. For a
 *  legacy preparation every id carries the same date, so this is identical to
 *  the previous behavior. */
export function getPlanTomorrowRoutineActual(preparation) {
  const state = routineRepository.read(context().timezone);
  const timezone = preparation.timezone || state.timezone;
  const entries = context().entries;
  const events = createLocalLifeLedgerStore().listEvents();
  const ids = new Set(preparation.routineInstanceIds);
  return preparation.routineInstanceIds.map(id => {
    let routineId;
    let instanceDate;
    try { [routineId, instanceDate] = JSON.parse(id); } catch { return { id, title: 'Unknown routine', status: 'removed' }; }
    const routine = state.routines.find(item => item.id === routineId);
    const occurs = !!routine && state.timezone === timezone && routine.enabled && occursOn(routine, instanceDate);
    if (!occurs) return { id, title: routine?.title || 'Removed routine', status: 'removed' };
    const instance = generateInstances([routine], instanceDate, state.timezone)[0];
    const completion = matchCompletion(instance, { ...state, events, entries }, Date.now());
    return { id, title: routine.title, taskLabel: state.links[id]?.stepTitle || routine.title, status: classifyRoutineActual({ occurs, skipped: !!state.skips[id], completion }) };
  }).filter(row => ids.has(row.id));
}

globalThis.openPlanTomorrow = openPlanTomorrow;
globalThis.getPlanTomorrowRoutineSummary = getPlanTomorrowRoutineSummary;
globalThis.getPlanTomorrowRoutineActual = getPlanTomorrowRoutineActual;
