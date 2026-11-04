// LOCAL PROOF ONLY. No application imports this file or these rules.
import {buildRules} from '../scripts/firebase-rules-builder.mjs';
export const META = '_csWrite';
export const MAX_REVISION = Number.MAX_SAFE_INTEGER;
export const copy = value => structuredClone(value);
export function revision(value) {
  if (!value || !Object.hasOwn(value, META)) return 0;
  const meta = value[META];
  if (!meta || meta.v !== 1 || !Number.isSafeInteger(meta.revision) || meta.revision < 1) throw new Error('invalid stored revision');
  return meta.revision;
}
// Capture ONCE at intent creation, from the owned before-image, never in a retry callback.
// A legacy pending replacement without its original base is not a new revision-zero intent.
export function intent(owner, path, before, after) {
  if (before === undefined) throw new Error('missing before-image');
  const baseRevision = revision(before);
  if (baseRevision === MAX_REVISION) throw new Error('revision exhausted');
  return {owner, path, before: copy(before), after: {...copy(after), [META]: {
    v: 1, baseExists: before !== null, baseRevision, revision: baseRevision + 1,
  }}};
}
// Hold the immutable before-image through all SDK invocations, including retry and first-null cache.
export function transactionUpdate(pending, remote, activeOwner) {
  if (activeOwner !== pending.owner) return undefined;
  if (JSON.stringify(canonical(remote)) !== JSON.stringify(canonical(pending.before))) return undefined;
  return copy(pending.after);
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function guard({checkRevision = true, checkExists = true} = {}) {
  const d = "data.child('_csWrite')", n = "newData.child('_csWrite')";
  return [
    'newData.exists()', `${n}.child('v').val() === 1`,
    `${n}.child('revision').isNumber()`, `${n}.child('revision').val() > 0`,
    `${n}.child('revision').val() <= ${MAX_REVISION}`, `${n}.child('revision').val() % 1 === 0`,
    `${n}.child('baseRevision').isNumber()`,
    checkExists ? `${n}.child('baseExists').val() === data.exists()` : 'true',
    `(!${d}.exists() || (${d}.child('v').val() === 1 && ${d}.child('revision').isNumber() && ${d}.child('revision').val() > 0 && ${d}.child('revision').val() % 1 === 0))`,
    checkRevision ? `${n}.child('baseRevision').val() === (${d}.exists() ? ${d}.child('revision').val() : 0)` : 'true',
    `${n}.child('revision').val() === ${n}.child('baseRevision').val() + 1`,
  ].map(part => `(${part})`).join(' && ');
}
export function proofRules(options = {}) {
  const rules = options.baseRules ? copy(options.baseRules) : buildRules(), room = rules.rules.rooms.$roomId, gate = guard(options);
  for (const [store, key] of [['plans', '$dateKey'], ['calendarPlans', '$planId'], ['operationalPlans', '$dayKey']]) {
    const grant = room[store]['.write'];
    delete room[store]['.write']; // A descendant denial cannot override an ancestor grant.
    room[store][key]['.write'] = `(${grant}) && (${gate})`;
    if (options.parentBypass) room[store]['.write'] = grant; // Strict mutation control only.
  }
  room.entries.$entryId['.write'] = `(${room.entries.$entryId['.write']}) && (${gate})`;
  for (const store of ['planFences', 'calendarPlanFences', 'operationalPlanFences']) {
    const node = room[store].$targetKey.$itemId;
    node['.write'] = `(${node['.write']}) && (${gate})`;
  }
  return rules;
}
