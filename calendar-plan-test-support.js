// Test-only support (never loaded by the app): an in-memory storage and an in-memory
// Realtime Database (value tree + on('value') listeners + a real transaction), shared by the
// calendar-native plan unit tests so every suite exercises the SAME fake.

export function memoryStorage() {
  const data = new Map();
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); }, data };
}

/** A tiny in-memory Realtime Database: a value tree, `on('value')` listeners, and a real
 *  transaction (the update function may be re-run by the test to model a retry). */
export function fakeDatabase() {
  const tree = {};
  const listeners = new Map(); // path -> Set<fn>
  const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  // Realtime Database persists NO empty array/object and no null: they vanish on write. Every value
  // written here is compacted the same way, so a test cannot pass only because the fake kept an
  // empty array the real database would have dropped.
  const compact = value => {
    if (Array.isArray(value)) { const items = value.map(compact).filter(v => v !== undefined); return items.length ? items : undefined; }
    if (value && typeof value === 'object') {
      const out = {};
      Object.entries(value).forEach(([k, v]) => { const c = compact(v); if (c !== undefined) out[k] = c; });
      return Object.keys(out).length ? out : undefined;
    }
    return value === null ? undefined : value;
  };
  const getAt = path => path.split('/').filter(Boolean).reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), tree);
  const setAt = (path, value) => {
    const parts = path.split('/').filter(Boolean);
    let node = tree;
    parts.slice(0, -1).forEach(part => { node[part] = node[part] && typeof node[part] === 'object' ? node[part] : {}; node = node[part]; });
    const stored = compact(clone(value));
    if (stored === undefined) delete node[parts[parts.length - 1]]; else node[parts[parts.length - 1]] = stored;
  };
  const notify = () => listeners.forEach((set, path) => set.forEach(fn => fn({ val: () => clone(getAt(path)) })));
  const ref = path => ({
    path,
    child: child => ref(`${path}/${child}`),
    // Like the real SDK, a new 'value' listener is told the CURRENT value right away.
    on: (event, cb) => { if (!listeners.has(path)) listeners.set(path, new Set()); listeners.get(path).add(cb); cb({ val: () => clone(getAt(path)) }); return cb; },
    off: () => { listeners.delete(path); },
    once: () => Promise.resolve({ val: () => clone(getAt(path)) }),
    update: updates => { Object.entries(updates).forEach(([key, value]) => setAt(`${path}/${key}`, value)); notify(); return Promise.resolve(); },
    transaction: updateFn => {
      const next = updateFn(clone(getAt(path)));
      if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => clone(getAt(path)) } });
      setAt(path, next);
      notify();
      return Promise.resolve({ committed: true, snapshot: { val: () => clone(getAt(path)) } });
    },
  });
  return { tree, ref, listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0), fire: notify, getAt, setAt };
}
