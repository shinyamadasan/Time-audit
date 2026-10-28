/* global PlanAuthority, isViewingToday, isTimelineTargetEditable, stampPlanItemMutation,
  refreshAuthoritativePlanSurfaces, showToast, getActiveTimerOwnerSnapshot, focusModeOn,
  running, breakActive, awayActive, enterFocusMode, _startTimer, settings, todayGuidedAction,
  planDisplayOrder, planItemKindOf, accountLocalKey, showView, currentTaskPlanItemId,
  activeFocusPlanItemId, unworkedPlanItems, workedOnPlanItems, planItemsFor */
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
  function refresh() {
    const context = `${accountLocalKey('command-center')}|${byId('timeline-date-label')?.textContent || ''}`;
    if (viewKey !== context) { selected = null; viewKey = context; }
    byId('timeline-blocks')?.querySelectorAll('.tl-row').forEach(enhanceRow);
    byId('timeline-anytime')?.querySelectorAll('.anytime-row').forEach(enhanceRow);
    refreshOverview();
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
    capture.innerHTML = '<h2>Brain Dump</h2><p>Capture ideas. Bring what matters into your plan.</p>';
    capture.append(button('Open Brain Dump', () => showView('braindump')));
    const upNext = byId('up-next');
    upNext.before(overview); overview.append(upNext,priorities,preparation,capture);
    const next = document.createElement('p'); next.id = 'command-next'; upNext.append(next);
    const brand = document.createElement('div'); brand.className = 'command-brand'; brand.innerHTML = 'Chrona<span>Sense</span>';
    today.prepend(brand);
    globalThis.DailyCommandCenter = {refresh};
    refresh();
  }
  initialize();
})();
