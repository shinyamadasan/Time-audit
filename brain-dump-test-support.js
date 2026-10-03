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
