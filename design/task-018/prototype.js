/* DESIGN ONLY. Mock data, memory-only outcomes; no app imports, storage, accounts, network or real completion write. */
(() => {
  'use strict';
  const option = document.body.dataset.option;
  const titles = { A: 'Minimal checkbox list', B: 'Grouped task manager', C: 'Triage inbox' };
  const descriptions = { A: 'Check it off. Keep everything else out of the way.', B: 'Find the task, see its context, act without opening it.', C: 'Review the oldest loose ends, one by one or together.' };
  const today = '2026-10-15';
  const source = [
    ['Open play', '10-11'], ['Start AI automation project', '10-11'],
    ['Review the onboarding research and send the revised automation proposal to the client', '10-10'],
    ['Tara AI community — 1 hr', '10-05'], ['Fix business dashboard', '10-05'], ['Client follow-up', '10-04'],
    ['Book dentist appointment', '10-04'], ['Renew home insurance', '10-03'], ['Review household budget', '10-03'],
    ['Submit the expense claim', '10-02'], ['Outline workshop exercises', '10-02'], ['Read the project brief', '10-01'],
    ['Confirm the venue booking', '10-01'], ['Organize interview notes', '09-30'], ['Prepare the grocery list', '09-30'],
    ['Send the revised contract', '09-29'], ['Plan next week’s training sessions', '09-29'], ['Replace the air filter', '09-28'],
    ['Check the volunteer roster', '09-28'], ['Back up family photos', '09-27'], ['Return the library books', '09-26'],
    ['Prepare the supporting documents for the vehicle registration renewal and confirm the service appointment', '09-25'],
  ].map(([title, date], index) => ({ id: index + 1, title, planned: `2026-${date}` }));
  const outcomes = new Map();
  let offset = 0, query = '', findOpen = false, collapsed = false, selecting = false, selected = new Set(), order = 'oldest';
  let lastAction = null, failedAction = null, failNext = false, pending = false, popover = null, opener = null;
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dateLabel = date => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
  const icons = {
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18m-13 5h3"/>',
    completionDate: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18m5 5 3 3 5-5"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
    next: '<path d="m9 5 7 7-7 7"/>', down: '<path d="m6 9 6 6 6-6"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    move: '<path d="M4 12h15m-6-6 6 6-6 6"/>', dismiss: '<path d="M5 12h14"/>',
    day: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18m6 0v12"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.day}</svg>`;
  const active = () => source.filter(task => !outcomes.has(task.id));
  const matches = () => {
    let tasks = active().filter(task => task.title.toLowerCase().includes(query.toLowerCase()));
    if (option === 'C') tasks = tasks.slice().sort((a, b) => order === 'oldest' ? a.planned.localeCompare(b.planned) || a.id - b.id : a.id - b.id);
    return tasks;
  };
  function closePopover(restore = false) {
    popover?.remove(); popover = null;
    document.querySelectorAll('[aria-haspopup=menu]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    if (restore && opener?.isConnected) opener.focus();
  }
  function contextBefore() {
    return `<div class="day-header"><h2>Thursday, October 15⌄</h2><span class="context-more">⋯</span></div>
      <section class="next-card"><small>UP NEXT</small><div class="next-content"><div><h3>Review client feedback</h3><p>Your next priority.</p></div><button class="context-start" disabled>Start</button></div><div class="next-links"><span>Choose something else</span><span>Focus mode</span></div></section>
      <span class="context-add">+ Add</span><div class="context-needs"><small>NEEDS YOU · 1 thing</small><p>Your configured sleep reminder is due.<span class="context-log">Log sleep</span></p></div>
      <p class="context-intelligence">▸ Intelligence <span>Plans, evidence and open loops</span></p>
      <div class="context-tray">Brain Dump <span>3 ready to plan · Open ›</span></div>
      <section class="context-timeline"><div class="timeline-heading">‹ <span>Today’s timeline</span> › ${icon('calendar')}</div><div class="timeline-row"><span class="timeline-time">11:30<br>AM</span><div class="timeline-line"><span class="timeline-check"></span><div class="timeline-copy"><strong>★ Review client feedback</strong><p>Planned priority · 11:30 AM–12:00 PM · 30m · no time logged by this check</p></div></div></div><div class="timeline-row"><span class="timeline-time">2:00 PM</span><div class="timeline-line"><span class="timeline-check"></span><div class="timeline-copy"><strong>Prepare workshop outline</strong><p>Planned task · 2:00 PM–3:00 PM · 1h · no time logged by this check</p></div></div></div></section>`;
  }
  const inContext = new URLSearchParams(location.search).get('context') === 'day';
  document.getElementById('app').innerHTML = `<main class="study-frame ${inContext ? 'day-context' : ''}">
    <div class="study-heading"><p class="study-kicker">TASK-018 / ${option} / DESIGN ONLY</p><h1>${titles[option]}</h1><p>${descriptions[option]}</p><nav class="study-nav"><a href="comparison.html">Compare A / B / C</a><a href="?${inContext ? '' : 'context=day'}">${inContext ? 'Isolated component' : 'See within My Day'}</a><span>Mock behavior · nothing is saved</span></nav></div>
    ${inContext ? contextBefore() : ''}<div class="workbench"><section class="study" aria-label="Unfinished tasks"></section><div id="feedback" class="feedback" role="status" aria-live="polite" hidden></div></div>
    ${inContext ? '<p class="context-so-far">Calendar today · No time recorded yet.　Details</p><div class="context-streak">0-day planning streak</div><nav class="context-nav" aria-label="Mock My Day navigation"><span>' + icon('day') + 'My Day</span><span>' + icon('day') + 'Brain Dump</span><span>' + icon('calendar') + 'Week</span><span>' + icon('day') + 'Trends</span><span>' + icon('day') + 'Life</span><span>' + icon('day') + 'Learning</span><span>' + icon('day') + 'Career</span><span>' + icon('day') + 'Settings</span></nav>' : ''}
    <aside class="mock-controls"><strong>Prototype controls — mock data only</strong><div class="mock-buttons"><button data-demo="reset">Reset 22 tasks</button><button data-demo="empty">Empty state</button><button data-demo="error">Error state</button><button data-demo="fail" aria-pressed="false">Fail next action: off</button></div><p>No account, Firebase, app storage or real completion write. Undo is an interaction concept. ${inContext ? 'Surrounding My Day is a read-only mock reconstruction; Brain Dump and timeline actions are not wired.' : 'Tap a long title to read it in full.'}</p></aside></main>`;
  const panel = document.querySelector('.study');
  function row(task) {
    const metadata = option === 'A' ? `<div class="task-meta">Planned ${dateLabel(task.planned)}</div>` : '';
    return `<div class="task-row ${selected.has(task.id) ? 'selected' : ''}" data-id="${task.id}">
      <label class="complete-target"><input type="checkbox" data-complete="${task.id}" aria-label="Complete ${escape(task.title)} today" title="Completed today"></label>
      <button class="task-content title-button" data-action="title" aria-expanded="false" title="${escape(task.title)}"><span class="task-title">${escape(task.title)}</span>${metadata}</button>
      ${option !== 'A' ? `<span class="row-date" title="Originally planned ${task.planned}">${dateLabel(task.planned)}</span>` : ''}
      ${option === 'B' ? `<button class="icon-button date-button" data-action="date" aria-label="Completion date for ${escape(task.title)}" title="Completed on another date">${icon('completionDate')}</button>` : ''}
      ${selecting ? `<label class="selection-target"><input type="checkbox" data-select="${task.id}" aria-label="Select ${escape(task.title)} for batch action"${selected.has(task.id) ? ' checked' : ''}></label>` : `<button class="icon-button more-button" data-action="menu" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${escape(task.title)}" title="More actions">⋯</button>`}</div>`;
  }
  function render(focusSearch = false) {
    closePopover();
    const filtered = matches();
    offset = Math.min(offset, Math.max(0, Math.ceil(filtered.length / 5) - 1) * 5);
    const shown = filtered.slice(offset, offset + 5);
    let rows = '', group = '';
    for (const task of shown) {
      const nextGroup = task.planned >= '2026-10-08' ? 'Last 7 days' : 'Earlier plans';
      if (option === 'B' && group !== nextGroup) { rows += `<div class="group-label">${nextGroup}<span>Planned</span></div>`; group = nextGroup; }
      rows += row(task);
    }
    const find = `<label class="find-bar">${icon('search')}<input id="find-task" type="search" value="${escape(query)}" placeholder="Find a task in all 22…" aria-label="Find a task"></label>`;
    panel.innerHTML = `<header class="list-head"><button class="heading-button" data-action="collapse" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Expand' : 'Collapse'} Unfinished">Unfinished ${icon('down')}</button><span class="count ${option === 'B' ? 'count-pill' : ''}" data-count="${active().length}">${active().length}${option === 'A' ? ' tasks' : ' open'}</span>${option === 'C' ? `<button class="batch-toggle" data-action="select">${selecting ? 'Cancel selection' : 'Select'}</button>` : ''}</header>
      <div class="list-body"${collapsed ? ' hidden' : ''}>
      ${option === 'B' ? find : ''}
      ${option === 'C' ? `<div class="inbox-toolbar"><span>${outcomes.size ? `${outcomes.size} reviewed · ` : ''}Review at your pace</span><select id="sort" aria-label="Task order"><option value="oldest"${order === 'oldest' ? ' selected' : ''}>Oldest plans first</option><option value="original"${order === 'original' ? ' selected' : ''}>Original order</option></select><button class="icon-button" data-action="find" aria-label="Find a task">${icon('search')}</button></div>${findOpen || query ? find : ''}` : ''}
      ${selecting ? `<div class="batch-bar"><p>${selected.size ? `${selected.size} selected · completion checks stay separate` : 'Select tasks with the right-hand boxes'}</p><div class="batch-actions"><button class="primary" data-action="batch-done"${!selected.size ? ' disabled' : ''}>Complete ${selected.size || ''} today</button><button data-action="batch-date"${!selected.size ? ' disabled' : ''}>Date…</button><button data-action="batch-dismiss"${!selected.size ? ' disabled' : ''}>Not doing</button></div></div>` : ''}
      <div class="row-list">${rows || `<div class="empty">${icon('check')}<h3>${active().length ? 'No matching tasks' : 'Nothing unfinished'}</h3><p>${active().length ? 'Try a different word.' : 'Your original plans and history stay intact.'}</p></div>`}</div>
      ${filtered.length ? `<footer class="list-footer"><span>${offset ? `${offset + 1}–${offset + shown.length}` : `Showing ${shown.length}`} of ${filtered.length}</span><div class="footer-actions"><button class="text-button" data-action="previous" aria-label="Previous five tasks"${offset ? '' : ' hidden'}>‹ Back</button><button class="text-button footer-next" data-action="next" aria-label="Next five tasks"${offset + 5 >= filtered.length ? ' disabled' : ''}>${option === 'C' ? 'Next 5' : 'View more'} ${icon('next')}</button></div></footer>` : ''}</div>`;
    if (focusSearch) { const input = document.getElementById('find-task'); input?.focus(); input?.setSelectionRange?.(query.length, query.length); }
  }
  function feedback(message, kind = 'success', action = '') {
    const node = document.getElementById('feedback');
    node.hidden = false; node.className = `feedback ${kind}`; node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    node.innerHTML = `<span>${escape(message)}</span>${action ? `<button data-feedback="${action}">${action === 'undo' ? 'Undo' : 'Retry'}</button>` : ''}`;
  }
  function applyAction(ids, kind, date = today) {
    if (pending || !ids.length) return;
    const tasks = source.filter(task => ids.includes(task.id) && !outcomes.has(task.id));
    if (!tasks.length) return;
    closePopover(); pending = true;
    tasks.forEach(task => {
      const row = panel.querySelector(`[data-id="${task.id}"]`);
      row?.classList.add('is-pending'); row?.querySelectorAll('button,input').forEach(control => control.disabled = true);
    });
    feedback('Mock: saving…');
    setTimeout(() => {
      pending = false;
      if (failNext) {
        failNext = false; failedAction = { ids, kind, date };
        document.querySelector('[data-demo=fail]').textContent = 'Fail next action: off';
        document.querySelector('[data-demo=fail]').setAttribute('aria-pressed', 'false');
        render(); feedback('Mock error: couldn’t save. Tasks kept here.', 'error', 'retry'); return;
      }
      lastAction = { ids: tasks.map(task => task.id), kind, date };
      tasks.forEach(task => outcomes.set(task.id, { kind, date, planned: task.planned }));
      selected.clear(); render();
      const label = kind === 'completion' ? `completed ${date === today ? 'today' : dateLabel(date)}` : kind === 'dismiss' ? 'removed from active backlog; history kept' : kind === 'move' ? 'moved to today' : `rescheduled for ${dateLabel(date)}`;
      feedback(`Mock: ${tasks.length === 1 ? 'Task' : tasks.length + ' tasks'} ${label}.`, 'success', 'undo');
      panel.querySelector('[data-complete]')?.focus();
    }, 220);
  }
  function anchor(trigger) {
    const rect = trigger.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const left = Math.min(innerWidth - box.width - 12, Math.max(12, rect.right - box.width));
    const below = rect.bottom + 5;
    const top = below + box.height <= innerHeight - 12 ? below : Math.max(12, rect.top - box.height - 5);
    popover.style.left = `${left}px`; popover.style.top = `${top}px`;
  }
  function showMenu(trigger, task) {
    closePopover(); opener = trigger; trigger.setAttribute('aria-expanded', 'true');
    popover = document.createElement('div'); popover.className = 'popover'; popover.setAttribute('role', 'menu'); popover.setAttribute('aria-label', 'Task actions');
    popover.innerHTML = `<button role="menuitem" data-menu="date">${icon('calendar')}Completed on another date…</button><div class="separator" role="separator"></div><button role="menuitem" data-menu="move">${icon('move')}Move to today</button><button role="menuitem" data-menu="reschedule">${icon('calendar')}Reschedule…</button><button role="menuitem" data-menu="dismiss">${icon('dismiss')}Not doing this</button>`;
    document.body.append(popover); anchor(trigger);
    popover.onclick = e => {
      e.stopPropagation(); const action = e.target.closest('[data-menu]')?.dataset.menu;
      if (action === 'date' || action === 'reschedule') showDate(trigger, [task.id], action === 'date' ? 'completion' : 'reschedule');
      if (action === 'move' || action === 'dismiss') applyAction([task.id], action);
    };
    popover.querySelector('button').focus();
  }
  function showDate(trigger, ids, kind = 'completion') {
    closePopover(); opener = trigger;
    popover = document.createElement('form'); popover.className = 'popover date-popover'; popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', kind === 'completion' ? 'Report completion date' : 'Reschedule task');
    const planned = ids.length === 1 ? dateLabel(source.find(task => task.id === ids[0]).planned) : `${ids.length} selected tasks`;
    popover.innerHTML = `<h3>${kind === 'completion' ? 'When was it completed?' : 'Choose a new plan date'}</h3><p>${ids.length === 1 ? 'Originally planned ' : ''}${planned}</p><label for="action-date">${kind === 'completion' ? 'Actual completion date' : 'New scheduled date'}</label><input id="action-date" type="date" required value="${today}" ${kind === 'completion' ? `max="${today}"` : `min="${today}"`}><div class="date-shortcuts"><button type="button" data-date="${today}" aria-pressed="true">Today</button><button type="button" data-date="${kind === 'completion' ? '2026-10-14' : '2026-10-16'}" aria-pressed="false">${kind === 'completion' ? 'Yesterday' : 'Tomorrow'}</button></div><div class="form-actions"><button type="button" data-cancel>Cancel</button><button class="save" type="submit">${kind === 'completion' ? 'Save completion' : 'Reschedule'}</button></div>`;
    document.body.append(popover); anchor(trigger);
    popover.onclick = e => {
      e.stopPropagation();
      const quick = e.target.closest('[data-date]');
      if (quick) { popover.querySelector('input').value = quick.dataset.date; popover.querySelectorAll('[data-date]').forEach(button => button.setAttribute('aria-pressed', String(button === quick))); }
      if (e.target.closest('[data-cancel]')) closePopover(true);
    };
    popover.onsubmit = e => { e.preventDefault(); const date = popover.querySelector('input').value; applyAction(ids, kind, date); };
    popover.querySelector('input').focus();
  }
  document.addEventListener('click', e => {
    if (e.target.closest('.popover')) return;
    const actionButton = e.target.closest('[data-action]');
    if (actionButton) {
      const action = actionButton.dataset.action;
      const task = source.find(task => task.id === Number(actionButton.closest('[data-id]')?.dataset.id));
      if (action !== 'menu') closePopover();
      if (action === 'menu') { if (actionButton.getAttribute('aria-expanded') === 'true') closePopover(true); else showMenu(actionButton, task); }
      if (action === 'date') showDate(actionButton, [task.id]);
      if (action === 'title') { actionButton.classList.toggle('expanded'); actionButton.setAttribute('aria-expanded', String(actionButton.classList.contains('expanded'))); }
      if (action === 'next' || action === 'previous') { offset += action === 'next' ? 5 : -5; render(); panel.querySelector('.title-button')?.focus(); }
      if (action === 'collapse') { collapsed = !collapsed; render(); panel.querySelector('.heading-button').focus(); }
      if (action === 'select') { selecting = !selecting; selected.clear(); render(); }
      if (action === 'find') { findOpen = true; render(true); }
      if (action === 'batch-done' || action === 'batch-dismiss') applyAction([...selected], action === 'batch-done' ? 'completion' : 'dismiss');
      if (action === 'batch-date') showDate(actionButton, [...selected]);
      return;
    }
    const demo = e.target.closest('[data-demo]')?.dataset.demo;
    if (demo === 'reset' || demo === 'empty') {
      if (pending) return;
      outcomes.clear(); selected.clear(); selecting = false; offset = 0; query = ''; findOpen = false; collapsed = false; lastAction = null; failedAction = null;
      if (demo === 'empty') source.forEach(task => outcomes.set(task.id, { kind: 'completion', date: today, planned: task.planned }));
      document.getElementById('feedback').hidden = true; render();
    }
    if (demo === 'error') feedback('Mock error: couldn’t save. Tasks kept here.', 'error');
    if (demo === 'fail') { failNext = !failNext; const button = e.target.closest('button'); button.textContent = `Fail next action: ${failNext ? 'on' : 'off'}`; button.setAttribute('aria-pressed', String(failNext)); }
    const response = e.target.closest('[data-feedback]')?.dataset.feedback;
    if (response === 'undo' && lastAction && !pending) {
      lastAction.ids.forEach(id => outcomes.delete(id)); selected.clear(); offset = 0; lastAction = null; render(); feedback('Mock: restored. Original planned dates unchanged.');
    }
    if (response === 'retry' && failedAction) applyAction(failedAction.ids, failedAction.kind, failedAction.date);
    if (!e.target.closest('.popover')) closePopover();
  });
  panel.addEventListener('change', e => {
    if (e.target.dataset.complete) applyAction([Number(e.target.dataset.complete)], 'completion');
    if (e.target.dataset.select) { const id = Number(e.target.dataset.select); if (e.target.checked) selected.add(id); else selected.delete(id); render(); panel.querySelector(`[data-select="${id}"]`)?.focus(); }
    if (e.target.id === 'sort') { order = e.target.value; offset = 0; render(); }
  });
  panel.addEventListener('input', e => {
    if (e.target.id === 'find-task') { query = e.target.value; offset = 0; render(true); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (popover) closePopover(true); else if (selecting) { selecting = false; selected.clear(); render(); } }
    if (popover) {
      const controls = [...popover.querySelectorAll('button,input')];
      const index = controls.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp'].includes(e.key) && popover.getAttribute('role') === 'menu') { e.preventDefault(); controls[(index + (e.key === 'ArrowDown' ? 1 : controls.length - 1)) % controls.length].focus(); }
      if (e.key === 'Tab' && (e.shiftKey && index === 0 || !e.shiftKey && index === controls.length - 1)) { e.preventDefault(); controls[e.shiftKey ? controls.length - 1 : 0].focus(); }
    } else if (option !== 'A' && !['INPUT', 'SELECT'].includes(document.activeElement.tagName)) {
      const row = document.activeElement.closest('[data-id]');
      if (row && ['j', 'k'].includes(e.key)) { e.preventDefault(); const rows = [...panel.querySelectorAll('[data-id]')]; rows[(rows.indexOf(row) + (e.key === 'j' ? 1 : rows.length - 1)) % rows.length].querySelector('.title-button').focus(); }
      if (row && e.key === 'd') showDate(row.querySelector('.more-button'), [Number(row.dataset.id)]);
    }
  });
  addEventListener('resize', () => closePopover());
  addEventListener('scroll', () => closePopover(), { passive: true });
  const state = new URLSearchParams(location.search).get('state');
  if (state === 'empty') source.forEach(task => outcomes.set(task.id, { kind: 'completion', date: today, planned: task.planned }));
  render();
  if (state === 'error') feedback('Mock error: couldn’t save. Tasks kept here.', 'error');
  // Read-only inspection seam for artifact verification; state changes still use the visible controls.
  window.designSnapshot = () => ({ option, activeIds: active().map(task => task.id), source: source.map(task => ({ ...task })), outcomes: [...outcomes.entries()], pending });
})();
