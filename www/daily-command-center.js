/* global PlanAuthority, isViewingToday, isTimelineTargetEditable, stampPlanItemMutation,
  refreshAuthoritativePlanSurfaces, showToast, getActiveTimerOwnerSnapshot, focusModeOn,
  running, breakActive, awayActive, enterFocusMode, _startTimer, settings, todayGuidedAction,
  planDisplayOrder, planItemKindOf, accountLocalKey, showView, currentTaskPlanItemId,
  activeFocusPlanItemId, unworkedPlanItems, workedOnPlanItems, planItemsFor,
  planRawItemsFor, createPlanItem */
// Presentation over the existing My Day renderers; source records and timer ownership stay authoritative.
(() => {
  let selected = null;
  let viewKey = null;
  let launchPending = false;
  const byId = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const button = (label, action, className = '') => {
    const el = document.createElement('button');
    el.type = 'button'; el.className = `btn sm ${className}`; el.textContent = label;
    el.addEventListener('click', action);
    return el;
  };
  function planSource(row) {
    const target = globalThis.PlanAuthority?.targetById(row.dataset.planDayId);
    const item = target && PlanAuthority.items(target).find(candidate => candidate.id === row.dataset.planItemId);
    return target && item ? {target,item} : null;
  }
  function editableSource(row) {
    const source = planSource(row);
    if (row.dataset.commandOwner !== accountLocalKey('command-center')) throw new Error('The account changed. Reopen the task.');
    if (!source || !isViewingToday() || !isTimelineTargetEditable(source.target)) throw new Error('This plan is no longer editable.');
    PlanAuthority.assertDirectSchedulingTarget(source.target);
    return source;
  }
  async function execute(row, focus) {
    try {
      const {item} = editableSource(row);
      if (launchPending) throw new Error('A session is starting. Please wait.');
      if (item.done) throw new Error('This task is already complete.');
      if (getActiveTimerOwnerSnapshot()) throw new Error('Another device is active. Use the existing takeover controls first.');
      if (focusModeOn || running || breakActive || awayActive) throw new Error('A session is already active. Use its current controls before starting another task.');
      launchPending = true;
      try {
        if (focus) enterFocusMode({task:item.task,planItemId:item.id,autoStart:true});
        else await _startTimer(item.task,item.id);
      } finally { launchPending = false; }
    } catch (err) { showToast(err.message); }
  }
  function deletePlanned(row) {
    try {
      const source = editableSource(row);
      if (!window.confirm(`Delete planned task “${source.item.task}”?\nRecorded time stays in your history.`)) return;
      // The source is re-read after the dialog: no date navigation or stale row can re-own the item.
      const {target,item} = editableSource(row);
      const items = PlanAuthority.rawItems(target).map(candidate => candidate.id === item.id
        ? stampPlanItemMutation({...candidate,deleted:true}) : candidate);
      PlanAuthority.saveItems(target,items);
      selected = null;
      refreshAuthoritativePlanSurfaces();
    } catch (err) { showToast(err.message); }
  }
  function enhanceRow(row, index) {
    if (row.dataset.commandCard) return;
    let content = row.querySelector(':scope > .tl-content');
    const anytimeTitle = row.querySelector(':scope > .anytime-title');
    if (!content && anytimeTitle) {
      content = document.createElement('div'); content.className = 'tl-content';
      content.append(anytimeTitle); row.append(content);
    }
    if (!content) return;
    const headline = content.querySelector('.tl-activity, .anytime-title');
    if (!headline) return;
    const key = JSON.stringify([row.dataset.planDayId,row.dataset.planItemId,row.dataset.commitmentId,row.dataset.entryId,row.querySelector('.tl-time')?.textContent,row.dataset.entryId ? row.dataset.activityKey : row.dataset.planItemId || row.dataset.commitmentId ? '' : index]);
    const editCall = row.getAttribute('onclick');
    row.removeAttribute('onclick'); row.style.removeProperty('cursor');
    row.dataset.commandCard = key;
    row.dataset.commandOwner = accountLocalKey('command-center');
    const details = document.createElement('details');
    details.className = 'command-card';
    details.name = 'my-day-agenda';
    const summary = document.createElement('summary');
    const title = headline.cloneNode(true);
    title.className = 'command-headline';
    title.querySelectorAll('.tl-badge').forEach(badge => badge.remove());
    const kind = row.dataset.planItemId ? 'Planned'
      : row.classList.contains('tl-commitment-row') || row.dataset.commitmentId ? 'Appointment'
        : row.classList.contains('tl-untracked-row') ? 'Unknown time'
          : row.classList.contains('tl-template-row') ? 'Schedule' : 'Recorded';
    const type = document.createElement('span'); type.className = 'command-source';
    type.textContent = kind + (row.classList.contains('done') ? ' · Done' : '');
    summary.append(title,type);
    const body = document.createElement('div'); body.className = 'command-card-body';
    const actions = document.createElement('div'); actions.className = 'command-card-actions';
    // Keep source-specific controls, merged IDs, observation labels and original edit handlers intact.
    [...row.children].filter(child => child !== content && !child.classList.contains('tl-time') && !child.classList.contains('tl-bar-col')).forEach(child => actions.append(child));
    actions.querySelectorAll('.tl-icon-action').forEach(control => { control.textContent = 'Edit'; });
    actions.querySelectorAll('.tl-plan-check').forEach(control => { control.textContent = row.classList.contains('done') ? 'Mark not done' : 'Mark done'; });
    if (editCall && !row.classList.contains('tl-template-row')) {
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'btn sm'; edit.textContent = 'Edit recording';
      edit.setAttribute('onclick',editCall);
      // Only the old decorative edit glyph is replaced; real source controls are retained.
      [...actions.children].filter(child=>child.tagName === 'SPAN').forEach(child=>child.remove());
      actions.append(edit);
    }
    body.append(content);
    if (row.dataset.planItemId) {
      const description = document.createElement('p'); description.className = 'command-description';
      const source = planSource(row);
      description.textContent = typeof source?.item.description === 'string' ? source.item.description : '';
      description.hidden = !description.textContent;
      body.append(description);
      if (source) {
        const schedule = document.createElement('p'); schedule.className = 'command-schedule';
        const zone = source.item.whenTz || source.target.timezone || settings.timezone;
        const instants = PlanAuthority.itemInstants(source.target,source.item);
        schedule.textContent = instants && Number.isFinite(instants.startMs)
          ? `${new Intl.DateTimeFormat('en-US',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(instants.startMs)} · ${zone}`
          : `Anytime · ${zone}`;
        body.append(schedule);
      }
      if (source && isTimelineTargetEditable(source.target)) {
        actions.prepend(button('Start Focus', () => execute(row,true),'primary'),button('Start Tracking', () => execute(row,false)));
        actions.append(button('Delete planned task', () => deletePlanned(row),'command-delete'));
      }
    }
    body.append(actions);
    details.append(summary,body);
    details.open = selected === key;
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      summary.setAttribute('aria-expanded',String(details.open));
      if (details.open) selected = key;
      else if (selected === key) selected = null;
    });
    summary.setAttribute('aria-expanded',String(details.open));
    details.addEventListener('keydown', event => {
      if (event.key === 'Escape') { details.open = false; selected = null; summary.focus({preventScroll:true}); }
    });
    row.append(details);
  }
  function refreshOverview() {
    const authority = globalThis.PlanAuthority;
    const target = authority?.current();
    const container = byId('command-priorities');
    if (!container) return;
    const items = target ? planDisplayOrder(authority.items(target).filter(item => planItemKindOf(item) === 'priority')) : [];
    container.innerHTML = `<h2>Top 3 priorities <span>${items.filter(item=>item.done).length} / ${items.length}</span></h2>`
      + (target ? items.length ? `<ol>${items.map(item=>`<li><span class="command-priority-status">${item.done ? '✓' : '○'}</span><span>${escape(item.task)}</span></li>`).join('')}</ol>` : '<p>No priorities planned. Add one when useful.</p>' : '<p>Loading your plan…</p>');
    container.hidden = !isViewingToday();
    const upcoming = authority?.upcoming();
    const prepared = upcoming && authority.preparation(upcoming);
    byId('command-preparation-state').textContent = prepared ? 'Your next-day plan is saved.' : 'Plan once. Start your next day ready.';
    const activeId = (focusModeOn ? activeFocusPlanItemId : running ? currentTaskPlanItemId : null) || todayGuidedAction().planItemId;
    const candidates = target ? planItemsFor(target).filter(item=>!item.done && item.id !== activeId) : [];
    const next = target && [...planDisplayOrder(unworkedPlanItems(candidates,target)),...planDisplayOrder(workedOnPlanItems(candidates,target))][0];
    byId('command-next').textContent = next ? `Next · ${next.task}${next.when ? ` · ${next.when}` : ' · Anytime'}` : 'Next · Nothing else planned';
    byId('command-next').hidden = !isViewingToday();
  }
  // "Show" goes to the section that manages a line. The routines section (learning steps) lives
  // in the Routines dialog, not on the page, so scrolling to it did nothing: open that dialog with
  // the full routine cards (and their Start Focus) expanded instead. Any other dialog: just open it.
  function showWorkTarget(id) {
    const target = byId(id);
    if (!target) return;
    // The Procedures panel is a closed <details> by default: open it, not just scroll to its title.
    if (id === 'sop-execution' && typeof globalThis.SopUI?.reveal === 'function') { globalThis.SopUI.reveal(); return; }
    const dialog = target.closest('dialog');
    if (dialog && !dialog.open) {
      if (dialog.id === 'routine-day-dialog' && typeof globalThis.inspectRoutineDetails === 'function') { globalThis.inspectRoutineDetails(); return; }
      dialog.showModal();
    }
    target.scrollIntoView({behavior:'smooth',block:'start'});
  }
  // My Day Command Center V1: one read-only line each for tasks, learning and SOP runs, with a
  // button that goes to the My Day section that already manages it. Never writes anything.
  function refreshWork() {
    const tile = byId('command-work');
    const model = globalThis.MyDayWorkModel;
    if (!tile || !model) return;
    tile.hidden = !isViewingToday();
    if (tile.hidden) return;
    let sop = null, learning = null;
    try { sop = globalThis.SopUI?.summary?.() ?? null; } catch { sop = null; }
    try { learning = globalThis.DailyRoutinesUI?.todayLearning?.() ?? null; } catch { learning = null; }
    const list = document.createElement('ul'); list.className = 'command-work-lines';
    for (const line of model.workLines({tasks: sop && sop.tasks, learning, sop: sop && sop.sop})) {
      const item = document.createElement('li'); item.dataset.workLine = line.key;
      const text = document.createElement('span'); text.textContent = line.text;
      // No learning step today usually means no learning routine yet: there is no card to show,
      // so say how to get one and go to the plans instead.
      if (line.key === 'learning' && Array.isArray(learning) && !learning.length) {
        const hint = document.createElement('small'); hint.className = 'command-work-hint';
        hint.textContent = 'To get a daily step, add a Learning routine (Routines › Manage) linked to a plan.';
        item.append(text, hint, button('Open Learning Plans', () => globalThis.showView?.('learning'), 'ghost'));
      } else item.append(text, button('Show', () => showWorkTarget(line.target), 'ghost'));
      list.append(item);
    }
    const old = tile.querySelector('.command-work-lines');
    if (old) old.replaceWith(list); else tile.append(list);
  }
  function submitCapture(event) {
    event.preventDefault();
    const input = byId('command-capture-text');
    const status = byId('command-capture-status');
    const ui = globalThis.BrainDumpUI;
    if (!input || !ui?.capture) { showToast('Brain Dump is still loading.'); return; }
    let result;
    try { result = ui.capture(input.value); } catch (err) { result = {ok:false}; showToast(err.message); }
    if (result.ok) { input.value = ''; status.textContent = 'Captured. Sort it in Brain Dump to plan it.'; }
    else { status.textContent = 'Type something to capture.'; input.focus(); }
  }
  // Owner decision (LOW 4): priorities left unfinished on the previous day appear in Needs you for
  // triage, even if the evening plan was skipped, but they NEVER get a time on their own. Adding one
  // to today is the user's explicit choice and reuses the planner's carry: the same deterministic id
  // (so a carry made in Plan Tomorrow, on any device, is the same item) and when '' (Anytime). Once an
  // item is carried (even if later removed from today) or done, it leaves this list.
  function unfinishedFromYesterday() {
    const carryId = globalThis.carryItemIdFor;
    if (typeof carryId !== 'function' || !globalThis.PlanAuthority || !isViewingToday()) return null;
    const today = PlanAuthority.current();
    const prior = today && PlanAuthority.previous(today);
    if (!prior) return null;
    const triaged = new Set(planRawItemsFor(today).map(item => item.id));
    const rows = [];
    for (const item of planItemsFor(prior)) {
      if (item.done || planItemKindOf(item) !== 'priority') continue;
      let id; try { id = carryId(prior, item.id, today); } catch { continue; }
      if (!triaged.has(id)) rows.push({ item, id });
    }
    return { prior, today, rows };
  }
  function addUnfinishedToToday(id) {
    try {
      const data = unfinishedFromYesterday();
      const row = data?.rows.find(r => r.id === id);
      if (!row) return;
      const item = { ...createPlanItem(row.item.task, '', 'priority'), id: row.id, carriedFromId: row.item.id };
      PlanAuthority.addItem({ destination: data.today, item });
      refreshAuthoritativePlanSurfaces();
      showToast(`Added to today · ${row.item.task} · Anytime`);
    } catch (err) { showToast(err.message); }
  }
  function refreshUnfinished() {
    const el = byId('unfinished-carry');
    if (!el) return;
    let data = null;
    try { data = unfinishedFromYesterday(); } catch { data = null; }
    const rows = data?.rows || [];
    const wasHidden = el.hidden;
    el.hidden = !rows.length;
    el.textContent = '';
    if (rows.length) {
      const key = data.prior.dateKey || data.prior.ref?.boundaryStartDate;
      let day = 'yesterday';
      try { day = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: settings.timezone || undefined }).format(new Date(`${key}T12:00:00Z`)); } catch { /* keep 'yesterday' */ }
      const head = document.createElement('span');
      head.textContent = `${rows.length} unfinished ${rows.length === 1 ? 'priority' : 'priorities'} from ${day}. Add the ones you still want to today (no time is set).`;
      const list = document.createElement('ul'); list.className = 'unfinished-carry-list';
      for (const row of rows) {
        const li = document.createElement('li');
        const title = document.createElement('span'); title.textContent = row.item.task;
        li.append(title, button('Add to today', () => addUnfinishedToToday(row.id), 'ghost'));
        li.lastChild.setAttribute('aria-label', `Add to today: ${row.item.task}`);
        list.append(li);
      }
      el.append(head, list);
    }
    if (wasHidden !== el.hidden) globalThis.renderNeedsYou?.();
  }
  function refresh() {
    const context = `${accountLocalKey('command-center')}|${byId('timeline-date-label')?.textContent || ''}`;
    if (viewKey !== context) { selected = null; viewKey = context; }
    byId('timeline-blocks')?.querySelectorAll('.tl-row').forEach(enhanceRow);
    byId('timeline-anytime')?.querySelectorAll('.anytime-row').forEach(enhanceRow);
    refreshOverview();
    refreshWork();
    refreshUnfinished();
  }
  function initialize() {
    const today = byId('view-today');
    const overview = document.createElement('div'); overview.id = 'command-overview';
    const priorities = document.createElement('section'); priorities.id = 'command-priorities'; priorities.className = 'command-tile';
    const preparation = document.createElement('section'); preparation.className = 'command-tile';
    preparation.innerHTML = '<h2>Plan your next day</h2><p id="command-preparation-state"></p>';
    preparation.append(button('Plan Tomorrow', () => {
      if (typeof globalThis.openPlanTomorrow === 'function') globalThis.openPlanTomorrow();
      else showToast('Planning is still loading.');
    }));
    const capture = document.createElement('section'); capture.className = 'command-tile';
    capture.innerHTML = '<h2>Brain Dump</h2><p>Capture ideas. Bring what matters into your plan.</p>'
      + '<form id="command-capture-form" class="command-capture">'
      + '<input id="command-capture-text" type="text" maxlength="1000" aria-label="Capture to Brain Dump" autocomplete="off" placeholder="Capture a thought…">'
      + '<button type="submit" class="btn sm primary">Capture</button></form><p id="command-capture-status" class="routine-meta" role="status"></p>';
    capture.querySelector('form').addEventListener('submit', submitCapture);
    capture.append(button('Open Brain Dump', () => showView('braindump')));
    const work = document.createElement('section'); work.id = 'command-work'; work.className = 'command-tile';
    work.innerHTML = "<h2>Today’s work</h2>";
    const upNext = byId('up-next');
    upNext.before(overview); overview.append(upNext,priorities,preparation,capture,work);
    const next = document.createElement('p'); next.id = 'command-next'; upNext.append(next);
    const brand = document.createElement('div'); brand.className = 'command-brand'; brand.innerHTML = 'Chrona<span>Sense</span>';
    today.prepend(brand);
    globalThis.DailyCommandCenter = {refresh, refreshWork};
    refresh();
  }
  initialize();
})();
