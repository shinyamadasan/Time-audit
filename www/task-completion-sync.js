// TASK-018 client boundary: all writes go through the authenticated completion endpoint.
import { completionIdentity, completionDigest, completionWireValue, canonicalCompletion, validateCompletionRecord } from './task-completion-model.js';
import { createTaskCompletionRepository } from './task-completion-repository.js';

export function createTaskCompletionSync({ context, storage, fetchImpl = fetch, changed = () => {} }) {
  let owner = null, generation = 0, epoch = 0, candidates = [], signature = '', views = new Map(), inflight = null;
  let listeners = [], timer = null, watchFailed = false;
  const busy = new Map();
  const repository = createTaskCompletionRepository({ storage, getOwner: () => context()?.uid || null });
  const identityKey = identity => canonicalCompletion(identity);
  const entryKey = entry => identityKey(completionIdentity(entry.target, entry.item));
  function reset() {
    generation++; epoch++; owner = null; signature = ''; candidates = []; views = new Map(); inflight = null; busy.clear();
    listeners.forEach(([ref, fn]) => ref.off('value', fn)); listeners = [];
    clearTimeout(timer); timer = null; watchFailed = false;
  }
  function bind() {
    const ctx = context();
    if ((ctx?.uid || null) !== owner) { reset(); owner = ctx?.uid || null; }
    return ctx;
  }
  const current = (uid, token) => context()?.uid === uid && generation === token;
  async function call(ctx, body, token) {
    if (!ctx?.uid || !ctx.roomRef || !ctx.endpoint || typeof ctx.getIdToken !== 'function') throw new Error('Sign in and reconnect to complete this task.');
    const idToken = await ctx.getIdToken();
    if (!current(ctx.uid, token)) throw new Error('Account changed.');
    const response = await fetchImpl(ctx.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
      body: JSON.stringify(body), signal: globalThis.AbortSignal.timeout(20000), cache: 'no-store' });
    const value = await response.json();
    if (!current(ctx.uid, token)) throw new Error('Account changed.');
    if (!['CONFIRMED', 'REJECTED', 'UNKNOWN'].includes(value?.outcome)) throw new Error('Completion acknowledgement unavailable.');
    return value;
  }
  function watch(ctx) {
    listeners.forEach(([ref, fn]) => ref.off('value', fn)); listeners = [];
    watchFailed = false;
    if (!ctx?.roomRef || !candidates.length) return;
    const token = generation;
    // Six fixed source namespaces catch aliases/duplicates introduced in ANY historical destination.
    // Listening only to the selected source would miss a released client's recovery copy elsewhere.
    const paths = new Set(['taskCompletionResolutions', 'calendarPlanAuthority', 'dayBoundaryRevisions', 'settings',
      'calendarPlans', 'calendarPlanFences', 'plans', 'planFences', 'operationalPlans', 'operationalPlanFences']);
    for (const path of paths) {
      const ref = ctx.roomRef.child(path);
      const fn = () => {
        if (!current(ctx.uid, token)) return;
        epoch++; // includes the first event: it may be newer than an in-flight inspection
        for (const view of views.values()) view.fresh = false;
        clearTimeout(timer); timer = setTimeout(() => { refresh(); }, 150);
        changed();
      };
      ref.on('value', fn, () => { if (current(ctx.uid, token)) { epoch++; watchFailed = true; for (const view of views.values()) view.fresh = false; changed(); } });
      listeners.push([ref, fn]);
    }
  }
  async function refresh() {
    const ctx = bind(), token = generation;
    if (!ctx?.uid || !candidates.length || watchFailed) return;
    if (inflight) return inflight;
    const selected = candidates.slice(), observedEpoch = epoch;
    const work = (async () => {
      try {
        // One root observation per batch, never one room download per task.
        for (let offset = 0; offset < selected.length; offset += 100) {
          const batch = selected.slice(offset, offset + 100);
          const response = await call(ctx, { kind: 'inspect', identities: batch.map(entry => completionIdentity(entry.target, entry.item)) }, token);
          if (epoch !== observedEpoch) return;
          if (response.outcome !== 'CONFIRMED' || response.uid !== ctx.uid || !Array.isArray(response.views)) throw new Error('Completion verification unavailable.');
          if (response.views.length !== batch.length || new Set(response.views.map(view => identityKey(view.identity))).size !== batch.length) throw new Error('Completion verification incomplete.');
          for (const view of response.views) {
            const entry = batch.find(item => entryKey(item) === identityKey(view.identity));
            if (!entry) throw new Error('Completion source mismatch.');
            if (view.record) validateCompletionRecord(view.record, ctx.uid);
            if (view.record && identityKey(view.record.identity) !== identityKey(view.identity)) throw new Error('Completion record identity mismatch.');
            const wire = completionWireValue(entry.item);
            const matches = view.itemHash && await completionDigest(wire) === view.itemHash;
            if (!current(ctx.uid, token) || epoch !== observedEpoch) return;
            const completed = view.record?.state === 'completed'
              && view.record.operations[view.record.completionOpId]?.sourceRevision === view.sourceRevision;
            const state = matches && view.sourceRevision && (view.state !== 'completed' || completed) ? view.state : 'needs-review';
            views.set(identityKey(view.identity), { ...view, state,
              local: canonicalCompletion(wire), fresh: true });
          }
        }
      } catch {
        if (current(ctx?.uid, token)) for (const view of views.values()) view.fresh = false;
      } finally { if (current(ctx?.uid, token)) { inflight = null; changed(); if (epoch !== observedEpoch) globalThis.queueMicrotask(() => { void refresh(); }); } }
    })();
    inflight = work;
    return work;
  }
  function ensure(entries) {
    const ctx = bind();
    const next = canonicalCompletion(entries.map(entry => [completionIdentity(entry.target, entry.item), completionWireValue(entry.item)]));
    candidates = entries;
    if (signature !== next) { signature = next; epoch++; for (const found of views.values()) found.fresh = false; watch(ctx); void refresh(); }
  }
  function view(entry) {
    bind();
    const found = views.get(entryKey(entry));
    if (!found) return null;
    if (!found.fresh || found.local !== canonicalCompletion(completionWireValue(entry.item))) return { ...found, state: found.record ? 'needs-review' : 'unavailable' };
    return found;
  }
  function pending(entry) {
    const ctx = bind();
    if (!ctx?.uid) return null;
    return repository.list(ctx.uid).find(request => identityKey(request.identity) === entryKey(entry)) || null;
  }
  async function dispatch(ctx, request, uncertain, token) {
    try { repository.stage(ctx.uid, request); }
    catch { return { outcome: uncertain ? 'UNKNOWN' : 'REJECTED', reason: 'RECEIPT_STORAGE_UNAVAILABLE' }; }
    changed();
    let result;
    try {
      // Resume looks for the existing receipt before trying a previously uncertain mutation again.
      result = uncertain ? await call(ctx, { kind: 'status', request }, token) : null;
      if (result?.outcome !== 'CONFIRMED') result = await call(ctx, { kind: 'mutate', request, uncertain }, token);
      if (!current(ctx.uid, token)) return { outcome: 'UNKNOWN', reason: 'ACCOUNT_CHANGED' };
      if (result.outcome === 'CONFIRMED') {
        validateCompletionRecord(result.record, ctx.uid);
        const receipt = result.record.operations[request.operationId];
        if (canonicalCompletion(result.record.identity) !== canonicalCompletion(request.identity)
            || !receipt || receipt.intentHash !== await completionDigest(request)
            || canonicalCompletion(result.receipt) !== canonicalCompletion(receipt)) throw new Error('Completion acknowledgement mismatch.');
      }
      if (!current(ctx.uid, token)) return { outcome: 'UNKNOWN', reason: 'ACCOUNT_CHANGED', request };
      if (result.outcome === 'CONFIRMED' || (result.outcome === 'REJECTED' && !uncertain)) repository.finish(ctx.uid, request);
      else result = { ...result, outcome: 'UNKNOWN' };
      await refresh();
      if (!current(ctx.uid, token)) return { outcome: 'UNKNOWN', reason: 'ACCOUNT_CHANGED', request };
      return { ...result, request };
    } catch { return { outcome: 'UNKNOWN', reason: 'ACK_UNAVAILABLE', request }; }
    finally { if (current(ctx.uid, token)) changed(); }
  }
  async function complete(entry, date, timezone) {
    const ctx = bind(), token = generation, key = entryKey(entry);
    if (busy.has(key)) return busy.get(key);
    const work = (async () => {
      try {
        const resumed = pending(entry);
        if (resumed) return await dispatch(ctx, resumed, true, token);
        await refresh();
        if (!current(ctx?.uid, token)) return { outcome: 'REJECTED', reason: 'ACCOUNT_CHANGED' };
        const observed = view(entry);
        if (!observed?.fresh || !observed.sourceRevision || !['unfinished', 'completed'].includes(observed.state)) return { outcome: 'REJECTED', reason: 'SOURCE_UNAVAILABLE' };
        const request = { identity: completionIdentity(entry.target, entry.item), operationId: globalThis.crypto.randomUUID(), expectedRevision: observed.record?.revision || 0,
          expectedSourceRevision: observed.sourceRevision, kind: 'complete', date, timezone };
        return await dispatch(ctx, request, false, token);
      } catch (error) { return { outcome: 'REJECTED', reason: error.message }; }
      finally { if (current(ctx?.uid, token)) { busy.delete(key); changed(); } }
    })();
    busy.set(key, work); changed(); return work;
  }
  async function undo(receipt) {
    const ctx = bind(), token = generation;
    if (!ctx?.uid || receipt.uid !== ctx.uid) return { outcome: 'REJECTED', reason: 'ACCOUNT_CHANGED' };
    const record = receipt.record, complete = record.operations[record.completionOpId];
    const request = { identity: record.identity, operationId: globalThis.crypto.randomUUID(), expectedRevision: record.revision,
      expectedSourceRevision: complete.sourceRevision, kind: 'undo', undoOf: record.completionOpId };
    return dispatch(ctx, request, false, token);
  }
  async function resume(request) {
    const ctx = bind(), token = generation;
    if (!ctx?.uid || !repository.list(ctx.uid).some(item => canonicalCompletion(item) === canonicalCompletion(request))) return { outcome: 'REJECTED', reason: 'RECEIPT_NOT_FOUND' };
    return dispatch(ctx, request, true, token);
  }
  return { ensure, refresh, view, pending, complete, undo, resume, reset,
    pendingAll: () => { const ctx = bind(); return ctx?.uid ? repository.list(ctx.uid) : []; }, busy: entry => busy.has(entryKey(entry)) };
}

if (typeof window !== 'undefined') {
  globalThis.TaskCompletions = createTaskCompletionSync({ context: () => globalThis.getTaskCompletionAppContext?.(), storage: localStorage,
    changed: () => globalThis.refreshCommitmentSurfaces?.() });
  globalThis.resetTaskCompletionsForAccount = () => globalThis.TaskCompletions.reset();
}
