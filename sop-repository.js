// sop-repository.js — SOP-linked Execution V1 (prototype). Device-local, room-scoped persistence.
// Mirrors daily-routines-repository.js (Device-Local Account Isolation V1): one envelope per room at
// `<key>:<roomId>`; no owner -> empty state and every write refused. Nothing here syncs, and nothing
// here reads or writes plan stores, fences, Firebase, or accounting state.
import { SOP_STORAGE_KEY, emptySopState, validateSopState } from './sop-model.js';
import { appRoomOwner } from './personal-day-boundary-repository.js';

export function sopKeyForRoom(roomId, key = SOP_STORAGE_KEY) {
  return `${key}:${roomId}`;
}

export function createSopRepository(injectedStorage, options = {}) {
  const storage = injectedStorage || globalThis.localStorage;
  const getOwner = typeof options.getOwner === 'function' ? options.getOwner : (injectedStorage ? null : appRoomOwner);
  const activeKey = () => {
    if (!getOwner) return SOP_STORAGE_KEY;
    const owner = getOwner();
    return typeof owner === 'string' && owner ? sopKeyForRoom(owner) : null;
  };
  return {
    read() {
      const key = activeKey();
      const raw = key === null ? null : storage.getItem(key);
      return validateSopState(raw === null ? emptySopState() : JSON.parse(raw));
    },
    /** `change` is a pure (state) => nextState from sop-model.js. Validated before it is written. */
    update(change) {
      const key = activeKey();
      if (key === null) throw new Error('No signed-in account owns SOPs on this device. Nothing was saved.');
      const next = validateSopState(change(this.read()));
      const raw = JSON.stringify(next);
      storage.setItem(key, raw);
      if (storage.getItem(key) !== raw) throw new Error('SOP save could not be confirmed.');
      return next;
    }
  };
}
