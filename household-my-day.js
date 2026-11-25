/* global URLSearchParams, PlanAuthority, isViewingToday, toggleTimelinePlanDone, accountLocalKey, isTimelineTargetEditable,
  showView, openPlanTomorrow, getPlanItemStatus, planTrackedMinFor, showToast, stopAndLog, running,
  currentTaskPlanItemId, focusModeOn, activeFocusPlanItemId, currentUser, partnerShared, partnerViewShared,
  partnerSharedReadState, _partnerSharedListener, settings, getDateInTZ,
  timerRunsForPlanItem, getActiveTimerOwnerSnapshot, todayGuidedAction, getNextPlanItem, planDisplayOrder */
// Household My Day V1 (opt-in: ?household=1). Three columns over existing authorities:
//   • My daily tasks  — ChronaSense PlanAuthority + the existing Start / Stop / Mark done handlers.
//   • Partner's tasks — the partner's own `/shared` projection (reciprocal-partner rules), full list
//                       only when the partner opted in. Read only.
//   • Food at home    — the viewer's own Meal Prep account (separate Firebase project), via the
//                       Meal Prep ready-food projection. Read only.
// No new task or food store, no write to the partner or to Meal Prep.
(() => {
  if (new URLSearchParams(location.search).get('household') !== '1') return;
  const byId = id => document.getElementById(id);
  const model = globalThis.HouseholdMyDayModel;
  const foodSource = globalThis.HouseholdFoodSource;
  const owner = () => globalThis.getChronaSenseRoomCode?.() || null;
  const ownerEmail = () => (typeof currentUser !== 'undefined' && currentUser && currentUser.email) || '';
  const viewerZone = () => (typeof settings !== 'undefined' && settings.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let mounted = false;
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const action = (label, handler, className = '') => {
    const el = node('button', label, `btn sm ${className}`.trim()); el.type = 'button';
    el.addEventListener('click', handler); return el;
  };
  function details(target) {
    byId('household-secondary').open = true;
    byId(target)?.scrollIntoView({block:'start'});
  }
  const SECTIONS = [['mine','My daily tasks','My tasks'],['partner','Partner’s daily tasks','Partner'],['food','Available food at home','Food']];
  function mount() {
    const today = byId('view-today'), overview = byId('command-overview');
    if (!today || !overview) return false;
    today.classList.add('household-enabled'); document.body.classList.add('household-on');
    const root = node('section'); root.id = 'household-dashboard'; root.setAttribute('aria-label','Household My Day');
    // Up Next: the one task to act on now, with its Start/Stop and Done controls in thumb reach.
    const next = node('section',null,'household-next'); next.id = 'household-next';
    next.setAttribute('aria-label','Up next'); next.setAttribute('aria-live','polite'); root.append(next);
    // Phone: one tap to any of the three sections (they stack on a narrow screen).
    const jump = node('nav',null,'household-jump'); jump.setAttribute('aria-label','Household sections');
    for (const [id,,short] of SECTIONS) {
      const link = node('button',null,'household-jump-link'); link.type = 'button'; link.id = `household-jump-${id}`;
      link.append(node('span',short,'household-jump-name'), node('span','','household-jump-count'));
      link.addEventListener('click', () => byId(`household-${id}`)?.scrollIntoView({block:'start', behavior:'smooth'}));
      jump.append(link);
    }
    root.append(jump);
    const grid = node('div', null, 'household-grid'); root.append(grid);
    for (const [id,title] of SECTIONS) {
      const card = node('section',null,'command-tile ol-day household-card'); card.id = `household-${id}`;
      const heading = node('h2',title); heading.id = `${card.id}-title`; card.setAttribute('aria-labelledby',heading.id);
      const body = node('div'); body.id = `${card.id}-body`; body.setAttribute('aria-live','polite'); card.append(heading,body); grid.append(card);
    }
    const toolbar = node('nav', null, 'household-toolbar'); toolbar.setAttribute('aria-label','My Day tools');
    toolbar.append(action('Time tracking', () => details('up-next')),
      action('Brain Dump', () => showView('braindump')), action('Plan Tomorrow', () => openPlanTomorrow()));
    root.append(toolbar);
    const secondary = node('details'); secondary.id = 'household-secondary';
    secondary.append(node('summary','Time tracking, planning and day details'));
    overview.before(root, secondary);
    for (const id of ['command-overview','timeline-section','needs-you','intelligence-panel','so-far','unfinished-carry','planning-streak','accountability-details']) {
      const el = byId(id); if (el && !secondary.contains(el)) secondary.append(el);
    }
    return true;
  }
  function jumpCount(id, text) {
    const el = byId(`household-jump-${id}`)?.querySelector('.household-jump-count');
    if (el && el.textContent !== text) el.textContent = text;
  }
  // A re-render keeps keyboard focus on the equivalent control (same id or accessible name).
  let pendingFocus = null;
  // Mark done / Reopen and Start / Stop are toggles whose label flips, so each pair shares a focus key.
  const focusKey = el => el.id ? `#${el.id}` : `${el.tagName}|${(el.getAttribute('aria-label') || el.textContent)
    .replace(/^(Mark done|Reopen):/, 'toggle:').replace(/^(Start|Stop):/, 'track:')}`;
  function changed(body, key) {
    const encoded = JSON.stringify(key);
    if (body.dataset.renderKey === encoded) return false;
    const active = document.activeElement;
    if (active && active !== body && body.contains(active)) pendingFocus = {body, key: focusKey(active), row: active.closest('li[data-item-id]')?.dataset.itemId};
    body.dataset.renderKey = encoded; body.replaceChildren(); return true;
  }
  function restoreFocus() {
    if (!pendingFocus) return;
    const {body, key, row} = pendingFocus; pendingFocus = null;
    const controls = [...body.querySelectorAll('button,input,select,textarea,a[href]')];
    const sameRow = row && [...body.querySelectorAll('li[data-item-id]')].find(li => li.dataset.itemId === row);
    const match = controls.find(el => focusKey(el) === key) || sameRow?.querySelector('button') || controls[0];
    match?.focus({preventScroll: true});
  }
  const note = (body, message) => body.append(node('p', message, 'household-note'));
  // Compact task row: [done toggle] [title + meta] [start/stop]. Names stay on aria-label.
  function iconButton(label, glyph, handler, className = '') {
    const el = node('button', null, `household-icon ${className}`.trim()); el.type = 'button';
    el.setAttribute('aria-label', label); el.title = label.replace(/:.*/, '');
    el.append(node('span', glyph, 'household-glyph')); el.firstChild.setAttribute('aria-hidden','true');
    el.addEventListener('click', handler); return el;
  }
  function taskRow(title, meta, done) {
    const item = node('li', null, `household-task${done ? ' is-done' : ''}`);
    const text = node('div', null, 'household-task-text');
    text.append(node('div',title,'household-item-title'), node('div',meta,'household-item-meta'));
    item.append(text); return item;
  }
  // "Updated … ago" text ticks every minute without rebuilding (and re-announcing) the live list.
  function stamp(body, prefix, ms) {
    const el = node('p', '', 'household-note household-stamp'); el.setAttribute('aria-live','off');
    el.dataset.prefix = prefix; el.dataset.at = String(ms); body.append(el); tickStamps(body);
  }
  function tickStamps(body) {
    for (const el of body.querySelectorAll('.household-stamp')) {
      const text = `${el.dataset.prefix}${ago(Number(el.dataset.at))}`;
      if (el.textContent !== text) el.textContent = text;
    }
  }
  function ago(ms) {
    const min = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.floor(min/60)} h ago` : `${Math.floor(min/1440)} d ago`;
  }

  // ── Column 1: my tasks (authoritative ChronaSense plan, existing handlers) + Up Next ──
  // Up Next reuses the app's own choice: the running/focused item, else the hero's guided plan
  // item, else getNextPlanItem(). It never invents an order of its own.
  function pickNext(items, target, timerItem, focusItem) {
    const open = id => items.find(item => item.id === id && !item.done);
    if (timerItem) return items.find(item => item.id === timerItem) || null;
    if (focusItem && open(focusItem)) return open(focusItem);
    try { const guided = todayGuidedAction()?.planItemId; if (open(guided)) return open(guided); } catch { /* fall through */ }
    try { const next = getNextPlanItem(target); if (next && open(next.id)) return open(next.id); } catch { /* fall through */ }
    return items.find(item => !item.done) || null;
  }
  function ownTasks() {
    const body = byId('household-mine-body'), hero = byId('household-next');
    const idle = (key, message, heroMessage) => {
      if (changed(body,key)) note(body,message);
      if (changed(hero,key)) { hero.hidden = !heroMessage; if (heroMessage) hero.append(node('p',heroMessage,'household-next-empty')); }
      jumpCount('mine','');
    };
    if (!owner()) return idle('signed-out','Sign in to see your tasks.', null);
    const target = globalThis.PlanAuthority?.current();
    if (!target) return idle('loading','Loading your plan…', null);
    let items = PlanAuthority.items(target);
    try { items = planDisplayOrder(items); } catch { /* keep stored order */ }
    const labels = items.map(item => getPlanItemStatus(item,target,planTrackedMinFor(target,item.task,item.id)).label);
    // Same test the hero and Mark done use, so an offline (provisional) Start also shows Stop.
    const timerItem = items.find(item => timerRunsForPlanItem(item.id))?.id || null;
    const focusItem = focusModeOn ? activeFocusPlanItemId : null;
    let remote = null;
    try { remote = getActiveTimerOwnerSnapshot(); } catch { remote = null; }
    const elsewhere = !!remote;
    const next = pickNext(items, target, timerItem, focusItem);
    const left = items.filter(item => !item.done).length;
    jumpCount('mine', items.length ? `${left} left` : '');
    const scope = owner(), account = accountLocalKey('command-center');
    const current = item => owner() === scope && accountLocalKey('command-center') === account
      && PlanAuthority.current()?.id === target.id && isViewingToday() && isTimelineTargetEditable(target)
      && PlanAuthority.items(target).some(candidate => candidate.id === item.id);
    async function invoke(item, fn) {
      if (!current(item)) { refresh(); return; }
      try { await fn(); } catch (err) { showToast(err.message); } finally { refresh(); }
    }
    const start = item => () => invoke(item, () => globalThis.DailyCommandCenter.startTask(target.id,item.id,account));
    const stop = item => () => invoke(item, () => stopAndLog()); // the hero's own Stop path
    const toggle = item => () => invoke(item, () => toggleTimelinePlanDone(target.id,item.id));
    const status = (item, index) => item.done ? 'Done'
      : item.id === timerItem ? (elsewhere ? 'Tracking on another device' : 'Tracking now')
      : item.id === focusItem ? 'In focus session' : labels[index];

    // Up Next hero.
    if (changed(hero,[owner(),target.id,next,next && status(next, items.indexOf(next)),timerItem,focusItem,elsewhere && [remote.ownerName, remote.task],left])) {
      hero.hidden = false;
      if (elsewhere) {
        hero.classList.remove('is-tracking');
        hero.append(node('p','Tracking on another device','household-next-label'),
          node('div', remote.task || 'Another task', 'household-next-title'),
          node('div', remote.ownerName ? `On ${remote.ownerName}. Take over in Time tracking.` : 'Take over in Time tracking.', 'household-next-meta'));
        const row = node('div',null,'household-next-actions');
        const take = action('Time tracking', () => details('up-next'), 'primary');
        take.setAttribute('aria-label','Open Time tracking to take over (Up next)'); row.append(take); hero.append(row);
      } else if (!next) {
        hero.classList.remove('is-tracking');
        hero.append(node('p', items.length ? 'All done for today.' : 'Nothing planned for today.', 'household-next-empty'));
      } else {
        const tracking = next.id === timerItem;
        hero.classList.toggle('is-tracking', tracking);
        hero.append(node('p', tracking ? 'Tracking now' : next.id === focusItem ? 'In focus session' : 'Up next', 'household-next-label'),
          node('div', next.task, 'household-next-title'),
          node('div', `${next.when || 'Anytime'} · ${status(next, items.indexOf(next))} · ${left} of ${items.length} left`, 'household-next-meta'));
        const row = node('div',null,'household-next-actions');
        if (tracking) { const b = action('■ Stop', stop(next), 'primary'); b.setAttribute('aria-label', `Stop ${next.task} (Up next)`); row.append(b); }
        else if (next.id !== focusItem) { const b = action('▶ Start', start(next), 'primary'); b.setAttribute('aria-label', `Start ${next.task} (Up next)`); row.append(b); }
        const d = action('✓ Done', toggle(next)); d.setAttribute('aria-label', `Mark ${next.task} done (Up next)`); row.append(d);
        hero.append(row);
      }
    }

    // Full list: compact rows.
    if (!changed(body,[owner(),target.id,items,labels,timerItem,focusItem,elsewhere,next?.id])) return;
    if (!items.length) { note(body,'Nothing planned for your current day. Use Plan Tomorrow or + Add.'); return; }
    const list = node('ul',null,'household-list household-tasks'); body.append(list);
    for (const [index,item] of items.entries()) {
      const row = taskRow(item.task, `${item.when || 'Anytime'} · ${status(item, index)}`, item.done);
      row.dataset.itemId = item.id;
      if (item.id === timerItem && !elsewhere) row.classList.add('is-active');
      if (item.id === next?.id && !elsewhere) row.classList.add('is-next');
      row.prepend(iconButton(`${item.done ? 'Reopen' : 'Mark done'}: ${item.task}`, item.done ? '✓' : '', toggle(item), 'household-check'));
      if (item.id === timerItem && elsewhere) {
        // Owned by another device: only the existing takeover flow (Time tracking) may act on it.
      } else if (item.id === timerItem) {
        row.append(iconButton(`Stop: ${item.task}`, '■', stop(item), 'household-play is-stop'));
      } else if (!item.done && item.id !== focusItem && !elsewhere) {
        row.append(iconButton(`Start: ${item.task}`, '▶', start(item), 'household-play'));
      }
      list.append(row);
    }
  }

  // ── Column 2: partner tasks (their own /shared projection; strictly read only — no controls here;
  //    the viewer's own sharing consent lives only in Settings › Partner) ──
  function partnerState() {
    const partnerUid = localStorage.getItem('ta3-partner-uid');
    const listener = typeof _partnerSharedListener !== 'undefined' ? _partnerSharedListener : null;
    const read = typeof partnerSharedReadState !== 'undefined' ? partnerSharedReadState : null;
    const live = !!(read && listener && read.ref === listener && read.uid === partnerUid);
    return model.partner({linked: !!(owner() && partnerUid), readState: live ? read.state : 'loading',
      summary: live && typeof partnerShared !== 'undefined' ? partnerShared : null,
      view: live && typeof partnerViewShared !== 'undefined' ? partnerViewShared : null, nowMs: Date.now()});
  }
  function partnerTasks() {
    const body = byId('household-partner-body');
    const view = partnerState();
    jumpCount('partner', view.state === 'ready' ? `${view.items.filter(item => !item.done).length} left` : '');
    const jumpName = byId('household-jump-partner')?.querySelector('.household-jump-name');
    const firstName = view.name ? view.name.split(/\s+/)[0] : 'Partner';
    if (jumpName && jumpName.textContent !== firstName) jumpName.textContent = firstName;
    if (!changed(body,[owner(),view])) return tickStamps(body);
    const name = view.name || 'Your partner';
    byId('household-partner-title').textContent = view.name ? `${view.name}’s daily tasks` : 'Partner’s daily tasks';
    const messages = {
      'not-linked':'Connect a partner in Settings › Partner to see their day here.',
      loading:`Loading ${name}’s shared day…`,
      unavailable:`${name}’s shared day is unavailable. Partner sharing has to be connected on both sides in Settings › Partner.`,
      'not-published':`${name} hasn’t shared a day yet.`,
      stale:`${name} hasn’t opened ChronaSense today, so there is no current list.`,
      'not-shared':`${name} isn’t sharing their full daily list, only their top 3 priorities. They can turn it on in their own Settings › Partner.`,
      error:'The shared list could not be read safely. Nothing is shown rather than a partial list.'
    };
    if (view.state === 'ready') {
      stamp(body,'Read only · updated ',view.updatedAt);
      if (!view.items.length) note(body,'Nothing planned for their current day.');
      const list = node('ul',null,'household-list household-tasks'); body.append(list);
      for (const item of view.items) {
        const row = taskRow(item.title,`${item.when || 'Anytime'} · ${item.done ? 'Done' : item.status}`, item.done);
        const mark = node('span', item.done ? '✓' : '', 'household-check household-check-static'); mark.setAttribute('aria-hidden','true');
        row.prepend(mark); list.append(row);
      }
    } else {
      note(body, messages[view.state] || messages.error);
      if (view.state === 'stale' && view.updatedAt) stamp(body, 'Last update ', view.updatedAt);
    }
  }

  // ── Column 3: food (viewer's own Meal Prep account; read only) ──
  function connectForm(body) {
    const form = node('form',null,'household-connect');
    form.setAttribute('aria-label','Connect Meal Prep');
    const email = node('input'); email.type = 'email'; email.autocomplete = 'username'; email.required = true;
    email.value = ownerEmail(); email.setAttribute('aria-label','Meal Prep email');
    const password = node('input'); password.type = 'password'; password.autocomplete = 'current-password'; password.required = true;
    password.setAttribute('aria-label','Meal Prep password'); password.placeholder = 'Meal Prep password';
    const submit = node('button','Connect Meal Prep','btn sm primary'); submit.type = 'submit';
    form.append(email,password,submit);
    form.addEventListener('submit', async event => {
      event.preventDefault(); submit.disabled = true;
      try { await foodSource.connect(email.value, password.value); }
      catch (err) { showToast(err.message); submit.disabled = false; }
      password.value = '';
    });
    body.append(form);
  }
  function food() {
    const body = byId('household-food-body');
    if (!owner()) { if (changed(body,'signed-out')) note(body,'Sign in to see food at home.'); return; }
    const today = getDateInTZ(Date.now(), viewerZone());
    const view = model.food(foodSource ? foodSource.snapshot(today) : {state:'not-configured'});
    jumpCount('food', view.state === 'ready' ? `${view.meals.length} ${view.meals.length === 1 ? 'meal' : 'meals'}` : '');
    if (!changed(body,[owner(),view])) return tickStamps(body);
    const messages = {
      'not-configured':'Meal Prep is not connected on this device yet.',
      connecting:'Connecting to Meal Prep…', loading:'Loading food from Meal Prep…',
      mismatch:'That Meal Prep account does not match this ChronaSense account. Use the same email.',
      refused:'Meal Prep refused access to this account’s food.',
      stale:'Offline: Meal Prep could not confirm current food. Nothing is shown until it reconnects.',
      'no-account-data':'This Meal Prep account has no kitchen data yet.',
      error:'Food could not be read safely from Meal Prep. Nothing is shown rather than a partial list.'
    };
    if (view.state === 'signed-out' || view.state === 'mismatch') {
      if (view.state === 'mismatch') note(body, messages.mismatch);
      note(body,'Sign in with your Meal Prep account to see the food at home. Read only.');
      connectForm(body); return;
    }
    if (view.state !== 'ready') { note(body, messages[view.state] || messages.error); return; }
    if (view.updatedAt) stamp(body,'Read only · Meal Prep updated ',view.updatedAt); else note(body,'Read only · from your Meal Prep account');
    body.append(node('h3','Ready to eat'));
    if (!view.meals.length) note(body,'No prepared meals available.');
    const meals = node('ul',null,'household-list household-meals'); body.append(meals);
    for (const meal of view.meals) {
      const freshness = meal.daysLeft == null ? 'Freshness unknown' : meal.daysLeft === 0 ? 'Use today' : `${meal.daysLeft} ${meal.daysLeft === 1 ? 'day' : 'days'} left`;
      const urgency = meal.daysLeft == null ? '' : meal.daysLeft <= 0 ? ' is-urgent' : meal.daysLeft <= 1 ? ' is-soon' : '';
      const portions = meal.portions == null ? 'Portions unknown' : `${meal.portions} ${meal.portions === 1 ? 'portion' : 'portions'}`;
      const row = node('li', null, 'household-meal');
      row.append(node('div', meal.name, 'household-item-title'), node('span', freshness, `household-badge${urgency}`),
        node('div', `${portions} · ${meal.storage}`, 'household-item-meta'));
      meals.append(row);
    }
    const pantryHeading = node('h3','Pantry ingredients'); pantryHeading.className = 'household-pantry-heading';
    body.append(pantryHeading);
    if (!view.ingredients.length) note(body,'No ingredients recorded.');
    const ingredients = node('ul',null,'household-pantry'); body.append(ingredients);
    for (const ingredient of view.ingredients) {
      const chip = node('li'); chip.append(node('span', ingredient.name, 'household-pantry-name'), node('span', ingredient.quantity, 'household-pantry-qty'));
      ingredients.append(chip);
    }
    body.append(action('Disconnect Meal Prep', () => foodSource.disconnect(), 'ghost household-disconnect'));
  }

  function refresh() {
    if (!mounted) mounted = mount();
    if (!mounted) return;
    foodSource?.bind(owner(), ownerEmail());
    const root = byId('household-dashboard'); root.hidden = !isViewingToday();
    if (root.hidden) return;
    ownTasks(); partnerTasks(); food();
    restoreFocus();
  }
  globalThis.HouseholdMyDay = Object.freeze({refresh});
  foodSource?.subscribe(refresh);
  refresh();
  try { globalThis.firebase?.auth().onAuthStateChanged(() => refresh()); } catch { /* No auth SDK yet; the tick still re-checks ownership. */ }
  // Day rollover, sign-out and running-timer labels are re-checked even without a source event.
  setInterval(refresh, 2000);
})();
