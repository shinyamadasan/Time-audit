/* DESIGN ONLY: refined A. Copied mock fixture/context from the initial study; no app imports or persistence. */
(() => {
  'use strict';
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
  function contextBefore() {
    return `<div class="day-header"><h2>Thursday, October 15⌄</h2><span class="context-more">⋯</span></div>
      <section class="next-card"><small>UP NEXT</small><div class="next-content"><div><h3>Review client feedback</h3><p>Your next priority.</p></div><button class="context-start" disabled>Start</button></div><div class="next-links"><span>Choose something else</span><span>Focus mode</span></div></section>
      <span class="context-add">+ Add</span><div class="context-needs"><small>NEEDS YOU · 1 thing</small><p>Your configured sleep reminder is due.<span class="context-log">Log sleep</span></p></div>
      <p class="context-intelligence">▸ Intelligence <span>Plans, evidence and open loops</span></p>
      <div class="context-tray">Brain Dump <span>3 ready to plan · Open ›</span></div>
      <section class="context-timeline"><div class="timeline-heading">‹ <span>Today’s timeline</span> › ${icon('calendar')}</div><div class="timeline-row"><span class="timeline-time">11:30<br>AM</span><div class="timeline-line"><span class="timeline-check"></span><div class="timeline-copy"><strong>★ Review client feedback</strong><p>Planned priority · 11:30 AM–12:00 PM · 30m · no time logged by this check</p></div></div></div><div class="timeline-row"><span class="timeline-time">2:00 PM</span><div class="timeline-line"><span class="timeline-check"></span><div class="timeline-copy"><strong>Prepare workshop outline</strong><p>Planned task · 2:00 PM–3:00 PM · 1h · no time logged by this check</p></div></div></div></section>`;
  }
  const outcomes = new Map();
  let query = '', collapsed = false, pending = null, pendingKind = '', failNext = false;
  let receipt = null, failed = null, popover = null, opener = null, noticeTimer = null;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dateLabel = date => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
  const active = () => source.filter(task => !outcomes.has(task.id));
  document.getElementById('app').innerHTML = `<main class="day-context">
    <div class="refinement-label"><strong>DESIGN PREVIEW · REFINED A</strong><span>Mock only · <a href="A-REFINEMENT.md">Design notes</a></span></div>
    ${contextBefore()}<section class="study preview-shell" aria-label="Unfinished preview"></section>
    <p class="context-so-far">Calendar today · No time recorded yet.　Details</p><div class="context-streak">0-day planning streak</div>
    <aside class="mock-controls"><strong>Mock interactions only — production approval pending</strong><div class="mock-buttons"><button data-demo="reset">Reset 22 tasks</button><button data-demo="fail" aria-pressed="false">Fail next action: off</button><a href="comparison.html">Initial study</a></div><p>Original plans are mock data. No storage, Firebase or real completion write. Surrounding My Day is a read-only mock reconstruction.</p></aside>
    <nav class="context-nav" aria-label="Mock My Day navigation"><span>${icon('day')}My Day</span><span>${icon('day')}Brain Dump</span><span>${icon('calendar')}Week</span><span>${icon('day')}Trends</span><span>${icon('day')}Life</span><span>${icon('day')}Learning</span><span>${icon('day')}Career</span><span>${icon('day')}Settings</span></nav></main>
    <dialog class="backlog-window" aria-label="All unfinished tasks"><header class="backlog-header"><h2>All unfinished <span id="backlog-count"></span></h2><button class="icon-button" data-action="close-all" aria-label="Close full backlog">×</button></header><label class="find-bar">${icon('search')}<input id="backlog-search" type="search" placeholder="Find a task…" aria-label="Find a task in full backlog"></label><div class="backlog-rows" tabindex="0" aria-label="Scrollable unfinished tasks"></div><footer class="backlog-footer"></footer></dialog>
    <div class="undo-notice" role="status" aria-live="polite" hidden></div>`;
  const preview = document.querySelector('.preview-shell');
  const backlog = document.querySelector('.backlog-window');
  const notice = document.querySelector('.undo-notice');
  function row(task) {
    const disabled = pending === task.id ? ' disabled' : '';
    return `<div class="task-row${disabled ? ' is-pending' : ''}" data-id="${task.id}"><label class="complete-target"><input type="checkbox" data-complete="${task.id}" aria-label="Complete today: ${escape(task.title)}" title="Complete today"${disabled}${disabled && pendingKind === 'completion' ? ' checked' : ''}></label><button class="task-content title-button" data-action="title" aria-expanded="false" title="${escape(task.title)}"${disabled}><span class="task-title">${escape(task.title)}</span><span class="task-meta">Planned ${dateLabel(task.planned)}</span></button><button class="icon-button more-button" data-action="menu" aria-label="More actions for ${escape(task.title)}" aria-haspopup="menu" aria-expanded="false"${disabled}>⋯</button></div>`;
  }
  function closePopover(restore = false) {
    popover?.remove(); popover = null;
    document.querySelectorAll('.more-button').forEach(button => button.setAttribute('aria-expanded', 'false'));
    if (restore && opener?.isConnected) opener.focus();
  }
  function renderBacklog() {
    const tasks = active().filter(task => task.title.toLowerCase().includes(query.toLowerCase()));
    document.getElementById('backlog-count').textContent = active().length;
    backlog.querySelector('.backlog-rows').innerHTML = tasks.map(row).join('') || '<div class="empty"><h3>No matching tasks</h3><p>Try a different word.</p></div>';
    backlog.querySelector('.backlog-footer').textContent = query ? `${tasks.length} matching · ${active().length} unfinished` : `${active().length} tasks · original planned dates`;
  }
  function render() {
    closePopover();
    const tasks = active();
    preview.innerHTML = `<header class="list-head"><button class="heading-button" data-action="collapse" aria-label="${collapsed ? 'Expand' : 'Collapse'} Unfinished" aria-expanded="${!collapsed}">Unfinished ${icon('down')}</button><span class="count">${tasks.length} tasks</span></header><div${collapsed ? ' hidden' : ''}><div class="row-list">${tasks.slice(0, 5).map(row).join('') || '<div class="empty"><h3>Nothing unfinished</h3><p>Your original plans and history stay intact.</p></div>'}</div>${tasks.length ? `<footer class="list-footer"><span>Showing ${Math.min(5, tasks.length)} of ${tasks.length}</span><button class="text-button footer-next" data-action="view-all">View all ${icon('next')}</button></footer>` : ''}</div>`;
    renderBacklog();
  }
  function pauseNotice() { clearTimeout(noticeTimer); }
  function dismissNotice() { pauseNotice(); notice.hidden = true; receipt = null; }
  function resumeNotice() {
    pauseNotice();
    if (!notice.hidden && notice.dataset.temporary === 'true' && !notice.matches(':hover') && !notice.contains(document.activeElement)) noticeTimer = setTimeout(dismissNotice, 8000);
  }
  function showNotice(text, action = '', temporary = true, error = false) {
    pauseNotice();
    (backlog.open ? backlog : document.body).append(notice);
    notice.className = `undo-notice${error ? ' error' : ''}`;
    notice.dataset.temporary = String(temporary);
    notice.setAttribute('role', error ? 'alert' : 'status');
    notice.innerHTML = `<span>${escape(text)}</span>${action ? `<button data-notice="${action}">${action === 'undo' ? 'Undo' : 'Retry'}</button>` : ''}`;
    notice.hidden = false; resumeNotice();
  }
  notice.addEventListener('mouseenter', pauseNotice); notice.addEventListener('mouseleave', resumeNotice);
  notice.addEventListener('focusin', pauseNotice); notice.addEventListener('focusout', () => setTimeout(resumeNotice, 0));
  function openAll() {
    closePopover(); query = ''; document.getElementById('backlog-search').value = ''; renderBacklog();
    backlog.showModal(); document.documentElement.style.overflow = 'hidden'; backlog.append(notice);
    document.getElementById('backlog-search').focus();
  }
  function closeAll() {
    closePopover(); backlog.close(); document.documentElement.style.overflow = ''; document.body.append(notice);
    preview.querySelector('[data-action=view-all]')?.focus();
  }
  function applyAction(id, kind, date = today) {
    if (pending || outcomes.has(id)) return;
    closePopover(); pauseNotice(); receipt = null; pending = id; pendingKind = kind; render(); showNotice('Mock: saving…', '', false);
    setTimeout(() => {
      pending = null;
      if (failNext) {
        failNext = false; failed = { id, kind, date };
        const control = document.querySelector('[data-demo=fail]'); control.textContent = 'Fail next action: off'; control.setAttribute('aria-pressed', 'false');
        render(); showNotice('Mock save failed', 'retry', false, true); return;
      }
      outcomes.set(id, { kind, date }); receipt = id; failed = null; render();
      const message = kind === 'completion' ? `Completed ${date === today ? 'today' : dateLabel(date)}` : kind === 'dismiss' ? 'Removed from backlog' : kind === 'move' ? 'Moved to today' : `Rescheduled ${dateLabel(date)}`;
      showNotice(message, 'undo');
      (backlog.open ? backlog : preview).querySelector('[data-complete]')?.focus();
    }, 220);
  }
  function anchor(trigger) {
    const box = popover.getBoundingClientRect(), rect = trigger.getBoundingClientRect();
    popover.style.left = `${Math.min(innerWidth - box.width - 12, Math.max(12, rect.right - box.width))}px`;
    popover.style.top = `${rect.bottom + box.height + 5 <= innerHeight - 12 ? rect.bottom + 5 : Math.max(12, rect.top - box.height - 5)}px`;
  }
  function mountPopover(trigger) { (backlog.open ? backlog : document.body).append(popover); opener = trigger; anchor(trigger); }
  function showMenu(trigger, id) {
    closePopover(); trigger.setAttribute('aria-expanded', 'true');
    popover = document.createElement('div'); popover.className = 'popover'; popover.setAttribute('role', 'menu'); popover.setAttribute('aria-label', 'Task actions');
    popover.innerHTML = `<button role="menuitem" data-menu="date">${icon('calendar')}Done earlier…</button><div class="separator" role="separator"></div><button role="menuitem" data-menu="move">${icon('move')}Move to today</button><button role="menuitem" data-menu="reschedule">${icon('calendar')}Reschedule…</button><button role="menuitem" data-menu="dismiss">${icon('dismiss')}Not doing this</button>`;
    mountPopover(trigger);
    popover.onclick = e => {
      e.stopPropagation(); const action = e.target.closest('[data-menu]')?.dataset.menu;
      if (action === 'date' || action === 'reschedule') showDate(trigger, id, action === 'date' ? 'completion' : 'reschedule');
      if (action === 'move' || action === 'dismiss') applyAction(id, action);
    };
    popover.querySelector('button').focus();
  }
  function showDate(trigger, id, kind) {
    closePopover(); const task = source.find(task => task.id === id);
    popover = document.createElement('form'); popover.className = 'popover date-popover'; popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', kind === 'completion' ? 'Done earlier' : 'Reschedule');
    popover.innerHTML = `<h3>${kind === 'completion' ? 'Done earlier' : 'Reschedule'}</h3><p>Originally planned ${dateLabel(task.planned)}</p><label for="reported-date">${kind === 'completion' ? 'Actual completion date' : 'New plan date'}</label><input id="reported-date" type="date" value="${today}" required ${kind === 'completion' ? `max="${today}"` : `min="${today}"`}><div class="date-shortcuts"><button type="button" data-date="${today}">Today</button><button type="button" data-date="${kind === 'completion' ? '2026-10-14' : '2026-10-16'}">${kind === 'completion' ? 'Yesterday' : 'Tomorrow'}</button></div><div class="form-actions"><button type="button" data-cancel>Cancel</button><button class="save" type="submit">${kind === 'completion' ? 'Save completion' : 'Reschedule'}</button></div>`;
    mountPopover(trigger);
    popover.onclick = e => {
      e.stopPropagation(); const quick = e.target.closest('[data-date]');
      if (quick) { popover.querySelector('input').value = quick.dataset.date; popover.querySelectorAll('[data-date]').forEach(button => button.setAttribute('aria-pressed', String(button === quick))); }
      if (e.target.closest('[data-cancel]')) closePopover(true);
    };
    popover.onsubmit = e => { e.preventDefault(); applyAction(id, kind, popover.querySelector('input').value); };
    popover.querySelector('input').focus();
  }
  document.addEventListener('click', e => {
    if (e.target.closest('.popover')) return;
    const button = e.target.closest('[data-action]'), action = button?.dataset.action;
    const id = Number(button?.closest('[data-id]')?.dataset.id);
    if (action === 'menu') { if (button.getAttribute('aria-expanded') === 'true') closePopover(true); else showMenu(button, id); return; }
    closePopover();
    if (action === 'title') { button.classList.toggle('expanded'); button.setAttribute('aria-expanded', String(button.classList.contains('expanded'))); }
    if (action === 'collapse') { collapsed = !collapsed; render(); preview.querySelector('.heading-button').focus(); }
    if (action === 'view-all') openAll();
    if (action === 'close-all') closeAll();
    const noticeAction = e.target.closest('[data-notice]')?.dataset.notice;
    if (noticeAction === 'undo' && receipt && !pending) { outcomes.delete(receipt); dismissNotice(); render(); }
    if (noticeAction === 'retry' && failed) applyAction(failed.id, failed.kind, failed.date);
    const demo = e.target.closest('[data-demo]')?.dataset.demo;
    if (demo === 'reset' && !pending) { outcomes.clear(); failed = null; dismissNotice(); render(); }
    if (demo === 'fail') { failNext = !failNext; const control = e.target.closest('button'); control.textContent = `Fail next action: ${failNext ? 'on' : 'off'}`; control.setAttribute('aria-pressed', String(failNext)); }
    if (e.target === backlog) { const r = backlog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeAll(); }
  });
  document.addEventListener('change', e => { if (e.target.dataset.complete) { if (pending) { e.target.checked = false; return; } applyAction(Number(e.target.dataset.complete), 'completion'); } });
  document.getElementById('backlog-search').addEventListener('input', e => { closePopover(); query = e.target.value; renderBacklog(); backlog.querySelector('.backlog-rows').scrollTop = 0; });
  backlog.addEventListener('cancel', e => { e.preventDefault(); if (popover) closePopover(true); else closeAll(); });
  backlog.querySelector('.backlog-rows').addEventListener('scroll', () => closePopover());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && popover) { e.preventDefault(); closePopover(true); return; }
    if (e.key === 'Escape' && backlog.open) { e.preventDefault(); closeAll(); return; }
    if (!popover) return;
    const controls = [...popover.querySelectorAll('button,input')], index = controls.indexOf(document.activeElement);
    if (popover.getAttribute('role') === 'menu' && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); controls[(index + (e.key === 'ArrowDown' ? 1 : controls.length - 1)) % controls.length].focus(); }
    if (e.key === 'Tab' && (e.shiftKey && index === 0 || !e.shiftKey && index === controls.length - 1)) { e.preventDefault(); controls[e.shiftKey ? controls.length - 1 : 0].focus(); }
  });
  addEventListener('resize', () => closePopover()); addEventListener('scroll', () => closePopover(), { passive: true });
  render();
  window.refinedASnapshot = () => ({ activeIds: active().map(task => task.id), source: source.map(task => ({ ...task })), outcomes: [...outcomes], pending, backlogOpen: backlog.open });
})();
