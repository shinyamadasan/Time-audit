// Test-only: execute the actual incoming-nudge block without starting unrelated sync writers.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function nudgeHarness({ source = readFileSync(new URL('./storage.js', import.meta.url), 'utf8'),
  storage = new Map(), now = 100_000, warn = () => {} } = {}) {
  const begin = source.indexOf('  // Listen for incoming nudges');
  const end = source.indexOf('  // Watch for partner connecting', begin);
  if (begin < 0 || end < 0) throw new Error('incoming-nudge anchors missing');
  const state = source.match(/^let _nudgeReceipts[^\r\n]*/m)?.[0] || '';
  const context = vm.createContext({ Date: { now: () => now }, console: { warn },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    NUDGE_MAX_AGE_MS: 30_000, _nudgesRef: null, currentUser: null, showToast: () => {} });
  vm.runInContext(state, context);
  return {
    attach(uid, ref, toast = () => {}) {
      context.currentUser = uid ? { uid } : null;
      context.fbDb = { ref: at => { if (at !== `uid_${uid}/nudges`) throw new Error(`unexpected path ${at}`); return ref; } };
      context.showToast = toast;
      let active = true;
      context.isCurrentSync = () => active;
      vm.runInContext(`(function(isCurrentSync) { ${source.slice(begin, end)} })(isCurrentSync);`, context);
      return () => { active = false; context._nudgesRef?.off(); context._nudgesRef = null; };
    },
    switchUser(uid) { context.currentUser = uid ? { uid } : null; },
  };
}
