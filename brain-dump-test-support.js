// brain-dump-test-support.js
//
// Test-only helpers shared by the Brain Dump suites (never loaded by index.html).
//
// pruneLikeFirebase: Firebase RTDB never stores a null. A null value's key disappears,
// and an object left empty disappears too, recursively. Every Brain Dump fake room must
// store and deliver records through this, or it is more forgiving than the real wire
// (that leniency is exactly how a literal-null normalization bug once passed the whole
// suite). brain-dump-wire-format.test.js proves this function against a recording made
// with the real Firebase JS SDK 10.12.2 and the real RTDB emulator.

export function pruneLikeFirebase(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value) || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const pruned = pruneLikeFirebase(child);
    if (pruned !== undefined) out[key] = pruned;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A deep copy in RTDB's own wire form: what a listener or transaction snapshot
 *  would deliver for `value`. A pruned-to-nothing value reads back as null. */
export function wireCopy(value) {
  if (value === undefined || value === null) return null;
  const pruned = pruneLikeFirebase(JSON.parse(JSON.stringify(value)));
  return pruned === undefined ? null : pruned;
}

/** RTDB's storage rule for a whole value: nulls and empty objects/arrays vanish. */
function compactLikeFirebase(value) {
  if (Array.isArray(value)) { const items = value.map(compactLikeFirebase).filter(v => v !== undefined); return items.length ? items : undefined; }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) { const kept = compactLikeFirebase(child); if (kept !== undefined) out[key] = kept; }
    return Object.keys(out).length ? out : undefined;
  }
  return value === null ? undefined : value;
}

/** ONE in-memory Realtime Database holding every path (Brain Dump AND the plan
 *  stores), Firebase-faithful where the promotion fence depends on it:
 *   - values are stored and delivered in RTDB's wire form (nulls/empties pruned);
 *   - a committed write raises every affected 'value' listener BEFORE its own
 *     transaction Promise resolves (the real SDK order);
 *   - every write is checked against the REAL firebase.rules.json (via targaryen,
 *     which firebase-rules-emulator.test.js confirms agrees with the real
 *     emulator on the fence), and a denial rejects like the SDK's permission_denied.
 *  @param {{targaryen:object, rules:object, uid:string}} deps */
export function rulesEnforcingDatabase({ targaryen, rules, uid }) {
  let tree = {};
  const listeners = new Map(); // path -> Set<fn>
  const denials = [];
  const copy = value => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
  const parts = path => path.split('/').filter(Boolean);
  const getAt = path => parts(path).reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), tree);
  const read = path => { const value = getAt(path); return value === undefined ? null : copy(value); };
  function setAt(path, value) {
    const keys = parts(path);
    const next = copy(tree) || {};
    let node = next;
    keys.slice(0, -1).forEach(key => { node[key] = node[key] && typeof node[key] === 'object' ? node[key] : {}; node = node[key]; });
    const stored = compactLikeFirebase(copy(value));
    if (stored === undefined) delete node[keys[keys.length - 1]]; else node[keys[keys.length - 1]] = stored;
    tree = compactLikeFirebase(next) || {};
  }
  function notify(changed) {
    listeners.forEach((set, at) => {
      if (changed.startsWith(at) || at.startsWith(changed)) set.forEach(fn => fn({ val: () => read(at) }));
    });
  }
  function allowed(path, value) {
    const verdict = targaryen.database(rules, copy(tree) || {}).as({ uid }).write(`/${path}`, compactLikeFirebase(copy(value)) ?? null);
    return verdict.allowed;
  }
  const ref = path => ({
    path,
    child: key => ref(`${path}/${key}`),
    on(_event, fn) { if (!listeners.has(path)) listeners.set(path, new Set()); listeners.get(path).add(fn); fn({ val: () => read(path) }); return fn; },
    off() { listeners.delete(path); },
    once() { return Promise.resolve({ val: () => read(path) }); },
    get() { return Promise.resolve({ val: () => read(path) }); },
    transaction(updateFn) {
      const next = updateFn(read(path));
      if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => read(path) } });
      if (!allowed(path, next)) {
        denials.push({ path, attempted: copy(next) });
        return Promise.reject(Object.assign(new Error('permission_denied'), { code: 'PERMISSION_DENIED' }));
      }
      setAt(path, next);
      notify(path);
      return Promise.resolve({ committed: true, snapshot: { val: () => read(path) } });
    },
  });
  return {
    ref, denials, read,
    /** Writes as an admin (no rules): seeding a starting state only. */
    seed(path, value) { setAt(path, value); notify(path); },
  };
}
