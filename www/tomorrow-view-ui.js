import { planItemScheduleLabel } from './plan-tomorrow-model.js';
import { deriveTomorrowViewState } from './tomorrow-view-model.js';
import { deriveTomorrowTimelinePreview } from './tomorrow-timeline-model.js';
import { describeDayStart } from './personal-day-boundary-live.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const TAB_STORAGE_KEY = 'ta3-commitments-view';

const todayPane = document.getElementById('today-commitments-today');
const tomorrowPane = document.getElementById('tomorrow-view');
const todayTab = document.getElementById('tmr-tab-today');
const tomorrowTab = document.getElementById('tmr-tab-tomorrow');
const todayPrepareBtn = document.getElementById('today-prepare-tomorrow');

// Today-only actual/action surfaces that must not sit beneath Tomorrow's projected content —
// each represents current-day tracked truth or an action on it (So far, Log time, the real
// Timeline + its row actions, Entry actions), never something that could honestly be relabeled
// "tomorrow". Hidden via the `hidden` IDL property (never inline display), which also removes
// them from tab order and the accessibility tree automatically — no separate focus-trap handling
// needed. `needs-you` is governed by index.html's own renderNeedsYou() (see its tab-aware check)
// rather than forced here, since a MutationObserver can re-run it independently of this tab click.
const soFarSection = document.getElementById('so-far');
const logTimeNavButton = document.getElementById('today-nav-log-time');
const logTimeDetails = document.getElementById('log-time-details');
const timelineSection = document.getElementById('timeline-section');
const timelineEntryActions = document.getElementById('timeline-entry-actions');
const timelinePreview = document.getElementById('tomorrow-timeline-preview');

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

/** Tomorrow View inspects the UPCOMING AUTHORITATIVE DAY — the same target the
 *  Prepare Tomorrow workflow edits, so the two can never describe different
 *  plans. For a legacy account that is tomorrow's calendar date exactly as
 *  before; for a boundary account at 08:00 it is the personal day starting at
 *  the next boundary. */
function computeViewData() {
  const app = context();
  const timezone = app.timezone;
  const authority = globalThis.PlanAuthority;
  if (!authority) throw new Error('Tomorrow View is not available yet.');
  const target = authority.upcoming();
  const preparation = authority.preparation(target);
  const activeItems = authority.items(target);
  const orderedItems = typeof globalThis.planDisplayOrder === 'function' ? globalThis.planDisplayOrder(activeItems) : activeItems;
  const routineSummary = typeof globalThis.getPlanTomorrowRoutineSummary === 'function'
    ? globalThis.getPlanTomorrowRoutineSummary(target, timezone)
    : { mismatch: false, rows: [] };
  const applicableRoutines = routineSummary.mismatch ? [] : routineSummary.rows.filter(row => !row.skipped && row.actionable);
  const viewState = deriveTomorrowViewState({
    preparation,
    activeItemCount: orderedItems.length,
    applicableRoutineCount: applicableRoutines.length
  });
  return { target, items: orderedItems, applicableRoutines, routineMismatch: routineSummary.mismatch, viewState };
}

function headingHtml(target) {
  // A personal day is named by its real interval; a calendar day by its date.
  const label = target.store === 'operational'
    ? formatPersonalDayWindow(target)
    : formatHeadingDate(target.dateKey);
  const starts = target.store === 'operational'
    ? `<div class="tmr-starts">${escape(describeDayStart(target.startMs, target.boundaryTime, target.timezone, Date.now()))}</div>`
    : '';
  return `<div class="tmr-head"><div class="tmr-kicker">${target.store === 'operational' ? 'Next personal day' : 'Tomorrow'}</div><div class="tmr-date">${escape(label)}</div>${starts}</div>`;
}

function formatPersonalDayWindow(target) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: target.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fmt.format(new Date(target.startMs)).replace(',', '')} → ${fmt.format(new Date(target.endMs)).replace(',', '')}`;
}

function footerHtml(label) {
  return `<div class="tmr-footer"><button type="button" class="btn sm ghost" data-tmr-action="open">${escape(label)}</button></div>`;
}

/** Tomorrow's schedule Template occurrences, reduced from index.html's generateTemplateEntries()
 *  (the exact same pure, date-parameterized helper Today's own Timeline calls for whichever date
 *  it's viewing — never a second template-applicability derivation) into the plain "HH:MM" shape
 *  tomorrow-timeline-model.js works with. tzHHMM/activityDisplayLabel are the app's own existing
 *  account-timezone/display-name authorities — this never touches Intl or raw settings itself.
 *  Templates have no timezone-mismatch concept of their own (unlike Daily Routines): they always
 *  read the single account `settings.timezone`, so there is nothing analogous to
 *  routineMismatch to guard against here. */
function tomorrowTemplateEntries(target) {
  if (typeof globalThis.generateTemplateEntries !== 'function') return [];
  const authority = globalThis.PlanAuthority;
  const toHHMM = typeof globalThis.tzHHMM === 'function' ? globalThis.tzHHMM : null;
  if (!toHHMM) return [];
  const displayLabel = typeof globalThis.activityDisplayLabel === 'function' ? globalThis.activityDisplayLabel : value => value;
  // Template identity stays calendar-based (its factual source identity); only
  // the SELECTION is by instant, so a personal day shows the occurrences that
  // actually fall inside it — including post-midnight ones.
  return authority.templatesForTarget(target, date => globalThis.generateTemplateEntries(date)).map(entry => ({
    templateId: entry.templateId,
    date: entry.date,
    activity: displayLabel(entry.activity),
    autoLog: entry.autoLog,
    startWhen: toHHMM(entry.tsStart),
    endWhen: toHHMM(entry.ts)
  }));
}

function ttpRowHtml(row) {
  const timeLabel = row.scheduleLabel || '—';
  return `<div class="ttp-row" data-ttp-source="${escape(row.sourceType)}">
    <span class="ttp-time">${escape(timeLabel)}</span>
    <span class="ttp-title">${escape(row.title)}</span>
    <span class="ttp-status">${escape(row.statusLabel)}</span>
  </div>`;
}

function ttpUnscheduledRowHtml(row) {
  return `<div class="ttp-row ttp-row-unscheduled" data-ttp-source="${escape(row.sourceType)}">
    <span class="ttp-title">${escape(row.title)}</span>
    <span class="ttp-status">${escape(row.statusLabel)}</span>
  </div>`;
}

/** Renders independently of Plan Tomorrow's own prepared/unprepared/Open-Day viewState: Daily
 *  Routines and one-off priorities are gated the same way the pane above already gates them
 *  (routineMismatch → priorities only; otherwise the caller's already-applicable rows), but
 *  schedule Templates fire on their own recurrence regardless of whether tomorrow was ever
 *  "prepared" or was explicitly marked an Open Day — exactly as they already do for Today, where
 *  they are never part of the Plan Tomorrow confirmation at all. Showing them only when
 *  viewState === 'prepared' would hide a real, already-scheduled future block; this call site
 *  (inside render(), once, before the viewState branch) is what makes that renders every time,
 *  on every branch, without duplicating the call. */
function renderTimelinePreview({ target, items, applicableRoutines, routineMismatch }) {
  if (!timelinePreview) return;
  let preview;
  try {
    preview = deriveTomorrowTimelinePreview({
      priorityItems: items,
      routineRows: routineMismatch ? [] : applicableRoutines,
      templateEntries: tomorrowTemplateEntries(target)
    });
  } catch {
    timelinePreview.innerHTML = '<p class="tmr-muted" role="status">Tomorrow’s timeline can’t be shown right now.</p>';
    return;
  }
  const { positioned, unscheduled } = preview;
  const heading = `<div class="tmr-head"><div class="tmr-kicker">Tomorrow’s timeline</div><span class="ttp-badge">Planned</span></div>`;
  if (!positioned.length && !unscheduled.length) {
    timelinePreview.innerHTML = heading + '<p class="tmr-muted">Nothing scheduled yet.</p>';
    return;
  }
  const positionedHtml = positioned.length ? positioned.map(ttpRowHtml).join('') : '<p class="tmr-muted">No scheduled times yet.</p>';
  const unscheduledHtml = unscheduled.length
    ? `<section class="ttp-unscheduled"><h4>Unscheduled</h4>${unscheduled.map(ttpUnscheduledRowHtml).join('')}</section>`
    : '';
  timelinePreview.innerHTML = heading + positionedHtml + unscheduledHtml;
}

function render() {
  if (!tomorrowPane) return;
  let data;
  try {
    data = computeViewData();
  } catch {
    tomorrowPane.innerHTML = '<p class="tmr-muted" role="status">Tomorrow’s plan can’t be shown right now.</p>';
    if (timelinePreview) timelinePreview.innerHTML = '<p class="tmr-muted" role="status">Tomorrow’s timeline can’t be shown right now.</p>';
    return;
  }
  const { target, items, applicableRoutines, routineMismatch, viewState } = data;
  renderTimelinePreview({ target, items, applicableRoutines, routineMismatch });

  if (viewState === 'unprepared-empty') {
    const emptyLabel = target.store === 'operational' ? 'Your next personal day hasn’t been prepared yet.' : 'Tomorrow hasn’t been prepared yet.';
    tomorrowPane.innerHTML = headingHtml(target)
      + `<p class="tmr-empty">${escape(emptyLabel)}</p>`
      + footerHtml(target.store === 'operational' ? 'Plan next personal day' : 'Plan tomorrow');
    return;
  }
  if (viewState === 'open-day') {
    const openDayLabel = target.store === 'operational' ? 'Next personal day is an Open Day.' : 'Tomorrow is an Open Day.';
    tomorrowPane.innerHTML = headingHtml(target)
      + `<p class="tmr-open-day">${escape(openDayLabel)}</p>`
      + footerHtml(target.store === 'operational' ? 'Edit next personal day' : 'Edit tomorrow');
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

  tomorrowPane.innerHTML = headingHtml(target)
    + `<div class="tmr-status" data-tmr-status="${escape(viewState)}">${escape(statusLabel)}</div>`
    + `<section class="tmr-section"><h3>Routines</h3>${routinesHtml}</section>`
    + `<section class="tmr-section"><h3>Priorities</h3>${itemsHtml}</section>`
    + footerHtml(target.store === 'operational' ? 'Edit next personal day' : 'Edit tomorrow');
}

/** The Today/Tomorrow toggle now governs more than the commitments pane: everything below it that
 *  represents current-day actual truth or an action on it must not keep showing while browsing a
 *  projection of tomorrow. Each element here is hidden via the `hidden` IDL property, matching
 *  todayPane/tomorrowPane above, never inline style — that also drops it from tab order and the
 *  accessibility tree with no separate focus-management code. `#needs-you` is deliberately not
 *  touched here; it is re-derived by calling index.html's own renderNeedsYou(), whose hidden
 *  condition already accounts for this same tab (see index.html), so a MutationObserver-triggered
 *  re-render elsewhere can never un-hide it out from under this tab switch. */
function applyTodayOnlySurfaces(showTomorrow) {
  if (soFarSection) soFarSection.hidden = showTomorrow;
  if (logTimeNavButton) logTimeNavButton.hidden = showTomorrow;
  if (logTimeDetails) logTimeDetails.hidden = showTomorrow;
  if (timelineSection) timelineSection.hidden = showTomorrow;
  if (timelineEntryActions) timelineEntryActions.hidden = showTomorrow;
  if (timelinePreview) timelinePreview.hidden = !showTomorrow;
  globalThis.renderNeedsYou?.();
}

function applyTab(tab) {
  if (!todayPane || !tomorrowPane || !todayTab || !tomorrowTab) return;
  const showTomorrow = tab === 'tomorrow';
  todayPane.hidden = showTomorrow;
  tomorrowPane.hidden = !showTomorrow;
  todayTab.setAttribute('aria-pressed', String(!showTomorrow));
  tomorrowTab.setAttribute('aria-pressed', String(showTomorrow));
  applyTodayOnlySurfaces(showTomorrow);
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

/** These two are GLOBAL, static action labels — always visible on Today, never
 *  tied to a specific resolved plan target the way headingHtml()/footerHtml()
 *  above are. Per the same "enable is immediate, effective-later" rule those
 *  target-based labels already honor, this reads the same synchronous
 *  personalDayBoundaryConfigured() check index.html's own first-paint routing
 *  already relies on (see currentPlanTarget/upcomingPlanTarget in index.html)
 *  rather than gating on the currently-governing revision — so a first 18:00
 *  enable reads as "next personal day" immediately, before 18:00 ever arrives. */
function refreshPlanningTerminologyLabels() {
  const usesPersonalDay = typeof globalThis.personalDayBoundaryConfigured === 'function' && globalThis.personalDayBoundaryConfigured();
  if (tomorrowTab) tomorrowTab.textContent = usesPersonalDay ? 'Next personal day' : 'Tomorrow';
  if (todayPrepareBtn) todayPrepareBtn.textContent = usesPersonalDay ? 'Prepare next personal day' : 'Prepare tomorrow';
}

applyTab(currentTab());
refreshPlanningTerminologyLabels();

/** Called from writeDatePlanLocal() (any plan write) and from the existing 60s Today tick
 *  (calendar-day rollover). Both are unconditional no-ops unless Tomorrow is the visible tab —
 *  viewing Tomorrow never triggers a write of its own, this only reacts to writes/time that
 *  already happened elsewhere. */
globalThis.refreshTomorrowView = () => {
  if (currentTab() === 'tomorrow') render();
};

// Exposed so personal-day-boundary-live.js's onChange hook (the same one that
// already re-renders the Settings panel and the Prepared Plans surface on
// every enable/change) can keep these two static labels in sync too, with no
// second boundary-change listener.
globalThis.refreshPlanningTerminologyLabels = refreshPlanningTerminologyLabels;
