// Account-bound pending command receipts only. No task data or optimistic completion cache.
import { canonicalCompletion, COMPLETION_UUID } from './task-completion-model.js';
const PREFIX = 'ta3-task-completion-pending-v1:';
export function createTaskCompletionRepository({ storage, getOwner }) {
  const owned = uid => typeof uid === 'string' && uid && uid === getOwner();
  const prefix = uid => `${PREFIX}${encodeURIComponent(uid)}:`;
  const key = (uid, id) => {
    if (!owned(uid) || !COMPLETION_UUID.test(id)) throw new Error('Account changed. Nothing was sent.');
    return prefix(uid) + id;
  };
  return {
    list(uid) {
      if (!owned(uid)) return [];
      const pending = [];
      for (let index = 0; index < storage.length; index++) {
        const name = storage.key(index);
        if (!name?.startsWith(prefix(uid))) continue;
        const value = JSON.parse(storage.getItem(name));
        if (value?.v !== 1 || value.uid !== uid || !COMPLETION_UUID.test(value.request?.operationId)
            || name !== prefix(uid) + value.request.operationId) throw new Error('A pending completion needs recovery.');
        pending.push(value.request);
      }
      return pending;
    },
    stage(uid, request) {
      const name = key(uid, request.operationId), existing = storage.getItem(name);
      const value = JSON.stringify({ v: 1, uid, request });
      if (existing && canonicalCompletion(JSON.parse(existing).request) !== canonicalCompletion(request)) throw new Error('Completion receipt conflict.');
      storage.setItem(name, value); // failure MUST occur before dispatch
    },
    finish(uid, request) {
      const name = key(uid, request.operationId), existing = storage.getItem(name);
      if (existing && canonicalCompletion(JSON.parse(existing).request) === canonicalCompletion(request)) storage.removeItem(name);
    },
  };
}
