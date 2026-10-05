// plan-fence-sync.js
//
// The Firebase boundary of the Brain Dump promotion fence (DECISIONS #33): how a FENCED plan item
// (plan-item-origin.js) travels between a store's local array and its stable keyed child. Shared by
// the calendar and operational sync bridges (ES modules) and, through globalThis.PlanFenceSync, by
// storage.js's legacy date-plan sync (a classic script). Each caller supplies its own room-ownership
// check and its own per-item merge; nothing here knows which account is joined.
//
//   push : one create-or-merge TRANSACTION per fenced item, at
//          rooms/<room>/<fence collection>/<targetKey>/bdp1|<captureId>
//          (never inside the plan record, so a concurrent whole-record write cannot touch it)
//   read : ONE exact-child read, the only thing a promotion's "is the destination there?" question
//          is ever answered from (a missing child is a provable absence; the array is never scanned)
//
// Outcomes are values, never exceptions, and are deliberately coarse: 'committed' | 'unchanged' |
// 'owner-mismatch' | 'denied' (the server refused: the fence did its job) | 'transport-failure'.

import { FENCE_REMOTE_PATHS, mergeFencedItem } from './plan-item-origin.js';

/** A copy with every null/undefined field removed at every depth: what Firebase would store. */
function pruned(value) {
  if (Array.isArray(value)) return value.map(pruned);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== null && value[key] !== undefined) out[key] = pruned(value[key]);
    return out;
  }
  return value;
}

/** Equal as stored: ignores key order and the null fields Firebase prunes. */
export function sameOnWire(a, b) {
  return JSON.stringify(pruned(a)) === JSON.stringify(pruned(b));
}

export function fenceItemRef(roomRef, store, targetKey, itemId) {
  return roomRef.child(FENCE_REMOTE_PATHS[store]).child(targetKey).child(itemId);
}

/** Pushes every fenced item of one plan. `stillOwned()` is re-checked inside each transaction
 *  (Firebase may re-run it later), so an account switch mid-retry aborts with zero writes.
 *  @param {{roomRef:object, store:string, targetKey:string, items:object[], choose:(a:object,b:object)=>object, stillOwned:()=>boolean}} input
 *  @returns {Promise<{outcome:string, items:object[]}>} items: each item's value as the server now holds it */
export async function pushFencedItems({ roomRef, store, targetKey, items, choose, stillOwned }) {
  const settled = [];
  for (const item of items) {
    let ref;
    try {
      ref = fenceItemRef(roomRef, store, targetKey, item.id);
      if (typeof ref.transaction !== 'function') throw new Error('Firebase transactions are unavailable.');
    } catch { settled.push({ outcome: 'transport-failure' }); continue; }
    let ownerLost = false;
    try {
      const result = await ref.transaction(remote => {
        ownerLost = !stillOwned();
        if (ownerLost) return undefined;
        if (remote === null || remote === undefined) return item;
        const merged = mergeFencedItem(remote, item, choose);
        return sameOnWire(merged, remote) ? undefined : merged; // nothing to say: no write
      }, undefined, false);
      if (ownerLost) { settled.push({ outcome: 'owner-mismatch' }); continue; }
      const value = result?.snapshot && typeof result.snapshot.val === 'function' ? result.snapshot.val() : null;
      settled.push({ outcome: result?.committed ? 'committed' : (value ? 'unchanged' : 'transport-failure'), value });
    } catch (err) {
      settled.push({ outcome: /permission/i.test(`${err?.code || ''} ${err?.message || ''}`) ? 'denied' : 'transport-failure' });
    }
  }
  const order = ['owner-mismatch', 'denied', 'transport-failure', 'committed', 'unchanged'];
  const outcome = settled.length ? order.find(name => settled.some(entry => entry.outcome === name)) : 'unchanged';
  return { outcome, items: settled.map(entry => entry.value).filter(value => value && typeof value === 'object') };
}

/** ONE exact read of a fenced item's server child, bounded by a timeout. {ok:false} for no ref, a
 *  foreign cache, a transport failure or a timeout: never mistaken for an absent child.
 *  @returns {Promise<{ok:true, value:*} | {ok:false, reason:string}>} value is null for a missing child */
export function readFencedValue({ roomRef, store, targetKey, itemId, stillOwned, timeoutMs = 8000 }) {
  let ref;
  try { ref = fenceItemRef(roomRef, store, targetKey, itemId); } catch { return Promise.resolve({ ok: false, reason: 'offline' }); }
  if (typeof ref.once !== 'function') return Promise.resolve({ ok: false, reason: 'offline' });
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs); });
  const read = Promise.resolve(ref.once('value'))
    .then(snapshot => (stillOwned() ? { ok: true, value: snapshot.val() } : { ok: false, reason: 'owner-mismatch' }))
    .catch(() => ({ ok: false, reason: 'transport-failure' }));
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

globalThis.PlanFenceSync = { sameOnWire, fenceItemRef, pushFencedItems, readFencedValue };
