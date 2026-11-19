// sop-model.js — SOP-linked Execution V1 (prototype). Pure: no storage, no DOM, no network.
//
// An SOP is a reusable, ordered checklist. A plan item can be LINKED to one SOP; executing the item
// walks that SOP's steps. Progress is a per-plan-item RUN.
//
// Deliberately NOT part of the plan item: plan items are synced through three authority-routed
// stores (legacy plans / operationalPlans / calendarPlans) with fence and merge code, so the link
// and the run live in their own device-local, room-scoped envelope (see sop-repository.js). The
// plan item is referenced only by its existing, stable `id` (p…, bdp1|…, api1_…), never written.
// Progress never marks the plan item done: completing the item stays the user's existing action.

export const SOP_STORAGE_KEY = 'ta3-sops-v1';
export const SOP_SCHEMA_VERSION = 1;
export const SOP_MAX_STEPS = 50;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
// Plan item ids that exist today: 'p' + base36 (createPlanItem), 'bdp1|<captureId>' (Brain Dump),
// 'api1_<actionId>' (ChronaSense Action API).
const PLAN_ITEM_ID = /^[A-Za-z0-9_|-]{1,80}$/;
const text = (value, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

export function emptySopState() {
  return { schemaVersion: SOP_SCHEMA_VERSION, sops: [], links: {}, runs: {} };
}

export function validPlanItemId(id) {
  return typeof id === 'string' && PLAN_ITEM_ID.test(id);
}

export function validateSop(sop) {
  if (!plainObject(sop) || !ID.test(sop.id ?? '') || !text(sop.title)) throw new Error('Give the SOP a title.');
  if (!Array.isArray(sop.steps) || sop.steps.length < 1 || sop.steps.length > SOP_MAX_STEPS) throw new Error(`An SOP needs 1–${SOP_MAX_STEPS} steps.`);
  const ids = new Set();
  for (const step of sop.steps) {
    if (!plainObject(step) || !ID.test(step.id ?? '') || !text(step.text)) throw new Error('Every SOP step needs text (up to 200 characters).');
    if (ids.has(step.id)) throw new Error('Duplicate SOP step ID.');
    ids.add(step.id);
  }
  if (!timestamp(sop.updatedAt)) throw new Error('Invalid SOP timestamp.');
  return sop;
}

export function validateSopState(state) {
  if (!plainObject(state) || state.schemaVersion !== SOP_SCHEMA_VERSION || !Array.isArray(state.sops)
    || !plainObject(state.links) || !plainObject(state.runs)) throw new Error('SOP storage has an unsupported format.');
  const byId = new Map();
  for (const sop of state.sops) {
    validateSop(sop);
    if (byId.has(sop.id)) throw new Error('Duplicate SOP ID.');
    byId.set(sop.id, sop);
  }
  for (const [itemId, link] of Object.entries(state.links)) {
    if (!validPlanItemId(itemId) || !plainObject(link) || !byId.has(link.sopId) || !timestamp(link.linkedAt)) throw new Error('Invalid SOP link.');
  }
  for (const [itemId, run] of Object.entries(state.runs)) {
    // A run exists only for a linked item, and only for the SOP it is linked to.
    if (!state.links[itemId] || !plainObject(run) || run.sopId !== state.links[itemId].sopId || !plainObject(run.checked)) throw new Error('Invalid SOP run.');
    for (const [stepId, at] of Object.entries(run.checked)) if (!ID.test(stepId) || !timestamp(at)) throw new Error('Invalid SOP run step.');
  }
  return state;
}

const clone = value => JSON.parse(JSON.stringify(value));

export function createSop(title, stepTexts, { now = Date.now(), randomId } = {}) {
  if (typeof randomId !== 'function') throw new Error('An ID source is required.');
  const sop = {
    id: randomId(),
    title: typeof title === 'string' ? title.trim() : title,
    steps: (Array.isArray(stepTexts) ? stepTexts : []).map(t => (typeof t === 'string' ? t.trim() : t))
      .filter(t => t !== '').map(t => ({ id: randomId(), text: t })),
    updatedAt: now
  };
  return validateSop(sop);
}

export function upsertSop(state, sop) {
  validateSop(sop);
  const next = clone(state);
  const at = next.sops.findIndex(s => s.id === sop.id);
  if (at >= 0) next.sops[at] = clone(sop); else next.sops.push(clone(sop));
  return validateSopState(next);
}

/** Removes the SOP and every link/run that used it. The plan items themselves are untouched. */
export function deleteSop(state, sopId) {
  const next = clone(state);
  next.sops = next.sops.filter(s => s.id !== sopId);
  for (const [itemId, link] of Object.entries(next.links)) {
    if (link.sopId === sopId) { delete next.links[itemId]; delete next.runs[itemId]; }
  }
  return validateSopState(next);
}

/** Link (or re-link) a plan item to an SOP. Re-linking to a DIFFERENT SOP starts a fresh run. */
export function linkSop(state, planItemId, sopId, now = Date.now()) {
  if (!validPlanItemId(planItemId)) throw new Error('Invalid plan item.');
  if (!state.sops.some(s => s.id === sopId)) throw new Error('That SOP no longer exists.');
  const next = clone(state);
  if (next.links[planItemId]?.sopId !== sopId) delete next.runs[planItemId];
  next.links[planItemId] = { sopId, linkedAt: now };
  return validateSopState(next);
}

export function unlinkSop(state, planItemId) {
  const next = clone(state);
  delete next.links[planItemId];
  delete next.runs[planItemId];
  return validateSopState(next);
}

/** Tick or untick one step of the item's run. Only steps of the CURRENT linked SOP can be ticked. */
export function setStepChecked(state, planItemId, stepId, checked, now = Date.now()) {
  const link = state.links[planItemId];
  if (!link) throw new Error('This task has no SOP linked.');
  const sop = state.sops.find(s => s.id === link.sopId);
  if (!sop.steps.some(step => step.id === stepId)) throw new Error('That step is no longer in this SOP.');
  if (typeof checked !== 'boolean') throw new Error('Invalid step state.');
  const next = clone(state);
  const run = next.runs[planItemId] || (next.runs[planItemId] = { sopId: link.sopId, checked: {} });
  if (checked) run.checked[stepId] = run.checked[stepId] || now; else delete run.checked[stepId];
  return validateSopState(next);
}

/** What executing this item looks like right now, or null when it has no SOP.
 *  Progress is measured against the SOP as it is NOW: ticks for steps since removed are ignored. */
export function sopRunView(state, planItemId) {
  const link = state.links[planItemId];
  if (!link) return null;
  const sop = state.sops.find(s => s.id === link.sopId);
  const checked = state.runs[planItemId]?.checked || {};
  const steps = sop.steps.map((step, index) => ({ id: step.id, text: step.text, index, done: Object.hasOwn(checked, step.id) }));
  const done = steps.filter(s => s.done).length;
  return {
    sopId: sop.id,
    title: sop.title,
    steps,
    done,
    total: steps.length,
    nextStep: steps.find(s => !s.done) || null,
    complete: done === steps.length
  };
}

/** Drop links/runs whose plan item no longer exists anywhere the caller can see. Pure. */
export function pruneSopLinks(state, livePlanItemIds) {
  const live = new Set(livePlanItemIds);
  const next = clone(state);
  for (const itemId of Object.keys(next.links)) if (!live.has(itemId)) { delete next.links[itemId]; delete next.runs[itemId]; }
  return validateSopState(next);
}
