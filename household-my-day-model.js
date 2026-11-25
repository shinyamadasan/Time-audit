// Household My Day V1 — pure state model for the partner and food columns.
// Inputs are the ALREADY-AUTHORIZED reads: the partner's validated `/shared` projection
// (ChronaSense RTDB, reciprocal-partner rules) and the viewer's own Meal Prep user
// document (Meal Prep Firestore, owner-only rules). Nothing here fetches or writes.
// Every non-ready state carries no data, so unavailable data is never shown as empty
// or current.
(() => {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const text = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  function validDate(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
      && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  }
  function dateIn(nowMs, timezone) {
    return new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit'}).format(nowMs);
  }
  const fail = state => ({state});

  /**
   * Partner column. `readState` is the storage.js listener state for the CURRENT link
   * ('loading' | 'received' | 'denied'); `summary`/`view` are the validated
   * SharedAccountabilityModel / PartnerViewModel results from that same node.
   */
  function partner({linked, readState, summary, view, nowMs}) {
    if (!linked) return fail('not-linked');
    if (!readState || readState === 'loading') return fail('loading');
    if (readState === 'denied') return fail('unavailable');
    if (!object(summary) || !object(summary.publisher) || !object(view) || !object(view.today)) return fail('not-published');
    const tz = summary.publisher.timezone;
    let today;
    try { today = dateIn(nowMs, tz); } catch { return fail('error'); }
    if (!Number.isFinite(summary.publisher.updatedAt) || summary.publisher.updatedAt > nowMs + 5 * 60000) return fail('error');
    const name = text(summary.publisher.displayName, 80) ? summary.publisher.displayName : null;
    if (view.today.dateKey !== today) return {state:'stale', name, updatedAt:summary.publisher.updatedAt};
    if (view.today.dailyTasksShared !== true) return {state:'not-shared', name};
    const items = Array.isArray(view.today.dailyTasks) ? view.today.dailyTasks : [];
    const ids = new Set();
    for (const item of items) {
      if (!object(item) || !text(item.id) || ids.has(item.id) || !text(item.title) || typeof item.done !== 'boolean') return fail('error');
      ids.add(item.id);
    }
    return {state:'ready', name, updatedAt:summary.publisher.updatedAt,
      items:items.map(item => ({id:item.id, title:item.title, done:item.done, when:item.when || '', status:item.statusLabel || (item.done ? 'Done' : 'Not started')}))};
  }

  function quantityLabel(p) {
    const q = typeof p.quantity === 'number' ? (Number.isInteger(p.quantity) ? String(p.quantity) : String(+p.quantity.toFixed(2))) : '';
    const unit = typeof p.unit === 'string' ? p.unit.trim().slice(0, 20) : '';
    return q ? (unit ? `${q} ${unit}` : q) : 'Quantity unknown';
  }

  /**
   * Food column from the viewer's own Meal Prep `users/{uid}` document.
   * `source` = {state, doc, exists, fromCache, today}. `today` is the viewer's local
   * calendar date (the food is at home, on this device's day).
   */
  function food(source) {
    if (!object(source)) return fail('error');
    if (source.state !== 'ready') return fail(source.state || 'error');
    if (!validDate(source.today)) return fail('error');
    if (source.fromCache) return fail('stale');
    if (!source.exists) return fail('no-account-data');
    const doc = source.doc;
    if (!object(doc)) return fail('error');
    const cooked = doc.cookedMeals == null ? [] : doc.cookedMeals;
    const pantry = doc.pantry == null ? [] : doc.pantry;
    if (!Array.isArray(cooked) || !Array.isArray(pantry) || cooked.length > 1000 || pantry.length > 2000) return fail('error');
    for (const meal of cooked) {
      if (!object(meal) || (meal.storage != null && !['fridge','freezer'].includes(meal.storage))
        || (meal.cookedDate != null && meal.cookedDate !== '' && !validDate(meal.cookedDate))
        || ['fridgeLife','freezerLife'].some(k => meal[k] != null && (!Number.isFinite(meal[k]) || meal[k] < 0))) return fail('error');
    }
    if (pantry.some(p => !object(p))) return fail('error');
    const ingredients = pantry
      .filter(p => text(p.name) && !(typeof p.quantity === 'number' && p.quantity <= 0))
      .map(p => ({name:p.name, quantity:quantityLabel(p)}))
      .sort((a, b) => a.name.localeCompare(b.name));
    const stamp = [doc.lastSaved, doc.lastUpdated, doc.updatedAt].map(v => typeof v === 'number' ? v : Date.parse(v)).find(Number.isFinite);
    return {state:'ready', updatedAt:stamp ?? null,
      meals:globalThis.MealReadyFood.project(cooked, source.today), ingredients};
  }

  globalThis.HouseholdMyDayModel = Object.freeze({partner, food, dateIn});
})();
