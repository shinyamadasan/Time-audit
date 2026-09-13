import { normalizePreparation, planItemScheduleLabel, planTomorrowTargetDate } from './plan-tomorrow-model.js';
import { deriveTomorrowViewState } from './tomorrow-view-model.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const TAB_STORAGE_KEY = 'ta3-commitments-view';

const todayPane = document.getElementById('today-commitments-today');
const tomorrowPane = document.getElementById('tomorrow-view');
const todayTab = document.getElementById('tmr-tab-today');
const tomorrowTab = document.getElementById('tmr-tab-tomorrow');

function context() {
  if (typeof globalThis.getPlanTomorrowAppContext !== 'function') throw new Error('Tomorrow View is not available yet.');
  return globalThis.getPlanTomorrowAppContext();
}

function currentTab() {
  return localStorage.getItem(TAB_STORAGE_KEY) === 'tomorrow' ? 'tomorrow' : 'today';
}

/** Mirrors plan-tomorrow-ui.js's own formatTargetDate() exactly — same Intl call, same reason
 *  (a bare "YYYY-MM-DD" must render in the account timezone's calendar, not the device's, and
 *  noon-UTC keeps the formatted weekday from ever slipping a day at either DST edge). Two small,
 *  independently-testable copies of a 2-line formatter beat importing a private UI helper across
 *  feature modules — same tradeoff plan-tomorrow-model.js already documents for its own regex. */
function formatHeadingDate(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/** Mirrors plan-tomorrow-ui.js's own scheduleLabel() — routine display formatting only, not
 *  recurrence logic. Which routines even apply to the target date still comes entirely from
 *  getPlanTomorrowRoutineSummary() below (generateInstances/occursOn), never recomputed here. */
function scheduleLabel(routine) {
  if (routine.mode === 'exact') return routine.time;
  if (routine.mode === 'window') return `${routine.time}–${routine.endTime}`;
  return routine.mode === 'cue' ? `Cue: ${routine.cue}` : 'Anytime';
}

function rowHtml(timeLabel, title) {
  return `<div class="tmr-row"><span class="tmr-row-time">${timeLabel ? escape(timeLabel) : '—'}</span><span class="tmr-row-title">${escape(title)}</span></div>`;
}

/** Reads today's already-authoritative sources for tomorrow's date — never a second Date+24h
 *  computation and never a locally-cached key (see planTomorrowTargetDate — same helper Plan
 *  Tomorrow itself uses, so the two can never disagree about which calendar day "tomorrow" is). */
function computeViewData() {
  const app = context();
  const timezone = app.timezone;
  const targetDate = planTomorrowTargetDate(Date.now(), timezone);
  const plan = app.plan(targetDate);
  const preparation = normalizePreparation(plan?.preparation, targetDate);
  const activeItems = app.rawItems(targetDate).filter(item => !item.deleted);
  const orderedItems = typeof globalThis.planDisplayOrder === 'function' ? globalThis.planDisplayOrder(activeItems) : activeItems;
  const routineSummary = typeof globalThis.getPlanTomorrowRoutineSummary === 'function'
    ? globalThis.getPlanTomorrowRoutineSummary(targetDate, timezone)
    : { mismatch: false, rows: [] };
  const applicableRoutines = routineSummary.mismatch ? [] : routineSummary.rows.filter(row => !row.skipped && row.actionable);
  const viewState = deriveTomorrowViewState({
    preparation,
    activeItemCount: orderedItems.length,
    applicableRoutineCount: applicableRoutines.length
  });
  return { targetDate, items: orderedItems, applicableRoutines, routineMismatch: routineSummary.mismatch, viewState };
}

function headingHtml(targetDate) {
  return `<div class="tmr-head"><div class="tmr-kicker">Tomorrow</div><div class="tmr-date">${escape(formatHeadingDate(targetDate))}</div></div>`;
}

function footerHtml(label) {
  return `<div class="tmr-footer"><button type="button" class="btn sm ghost" data-tmr-action="open">${escape(label)}</button></div>`;
}

function render() {
  if (!tomorrowPane) return;
  let data;
  try {
    data = computeViewData();
  } catch {
    tomorrowPane.innerHTML = '<p class="tmr-muted" role="status">Tomorrow’s plan can’t be shown right now.</p>';
    return;
  }
  const { targetDate, items, applicableRoutines, routineMismatch, viewState } = data;

  if (viewState === 'unprepared-empty') {
    tomorrowPane.innerHTML = headingHtml(targetDate)
      + '<p class="tmr-empty">Tomorrow hasn’t been prepared yet.</p>'
      + footerHtml('Plan tomorrow');
    return;
  }
  if (viewState === 'open-day') {
    tomorrowPane.innerHTML = headingHtml(targetDate)
      + '<p class="tmr-open-day">Tomorrow is an Open Day.</p>'
      + footerHtml('Edit tomorrow');
    return;
  }

  const statusLabel = viewState === 'unprepared-content' ? 'Not yet prepared' : 'Prepared';
  const routinesHtml = routineMismatch
    ? '<p class="tmr-muted" role="status">Routines use a different timezone than Today; showing one-off priorities only.</p>'
    : (applicableRoutines.length
      ? applicableRoutines.map(row => rowHtml(scheduleLabel(row.routine), row.routine.title)).join('')
      : '<p class="tmr-muted">No routines occur on this date.</p>');
  const itemsHtml = items.length
    ? items.map(item => rowHtml(planItemScheduleLabel(item), item.task)).join('')
    : '<p class="tmr-muted">No one-off priorities yet.</p>';

  tomorrowPane.innerHTML = headingHtml(targetDate)
    + `<div class="tmr-status" data-tmr-status="${escape(viewState)}">${escape(statusLabel)}</div>`
    + `<section class="tmr-section"><h3>Routines</h3>${routinesHtml}</section>`
    + `<section class="tmr-section"><h3>Priorities</h3>${itemsHtml}</section>`
    + footerHtml('Edit tomorrow');
}

function applyTab(tab) {
  if (!todayPane || !tomorrowPane || !todayTab || !tomorrowTab) return;
  const showTomorrow = tab === 'tomorrow';
  todayPane.hidden = showTomorrow;
  tomorrowPane.hidden = !showTomorrow;
  todayTab.setAttribute('aria-pressed', String(!showTomorrow));
  tomorrowTab.setAttribute('aria-pressed', String(showTomorrow));
  if (showTomorrow) render();
}

function setTab(tab) {
  localStorage.setItem(TAB_STORAGE_KEY, tab);
  applyTab(tab);
}

todayTab?.addEventListener('click', () => setTab('today'));
tomorrowTab?.addEventListener('click', () => setTab('tomorrow'));

tomorrowPane?.addEventListener('click', event => {
  if (!event.target.closest('[data-tmr-action="open"]')) return;
  globalThis.openPlanTomorrow?.();
});

applyTab(currentTab());

/** Called from writeDatePlanLocal() (any plan write) and from the existing 60s Today tick
 *  (calendar-day rollover). Both are unconditional no-ops unless Tomorrow is the visible tab —
 *  viewing Tomorrow never triggers a write of its own, this only reacts to writes/time that
 *  already happened elsewhere. */
globalThis.refreshTomorrowView = () => {
  if (currentTab() === 'tomorrow') render();
};
