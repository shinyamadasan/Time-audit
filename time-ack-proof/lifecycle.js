// LOCAL DESIGN FIXTURE ONLY. No production code imports this module.
import {copy, canonical, intent, META, proofRules} from '../stale-contract/contract.js';
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export {same};
function stored(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return value;
  const result = Array.isArray(value) ? [] : {};
  for (const [key, child] of Object.entries(value)) {const normalized = stored(child); if (normalized !== undefined) result[key] = normalized;}
  return Object.keys(result).length ? result : undefined;
}

export function accountingRules({timerGate = true, baseRules = null} = {}) {
  const result = proofRules({baseRules});
  // Reuse the exact existing owner + revision/existence gate; no new auth principal/service.
  if (timerGate) result.rules.rooms.$roomId.timer['.write'] = result.rules.rooms.$roomId.calendarPlans.$planId['.write'];
  return result;
}

function writeConfirmed(store, value) {
  const raw = JSON.stringify(value);
  store.write(raw);
  if (store.read() !== raw) throw new Error('Durable envelope readback failed');
}
export function initialize(store, frame) {
  if (store.read() !== null) throw new Error('Existing state must be recovered, not initialized over');
  writeConfirmed(store, {v: 1, owner: frame.owner, frame: copy(frame), operation: null, history: [], applications: 0});
}

function operation(id, kind, original, projection) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid operation identity');
  const before = {}, patch = {}, proposed = copy(projection.frame);
  if (!same(original.focusRedemptions ?? [], proposed.focusRedemptions ?? [])) throw new Error('Focus redemption changes are outside this entry-operation proof');
  const old = new Map(original.entries.map(entry => [String(entry.id), entry]));
  const updated = new Map(proposed.entries.map(entry => [String(entry.id), entry]));
  if (updated.size !== proposed.entries.length) throw new Error('Duplicate entry identity');
  for (const key of old.keys()) if (!updated.has(key)) throw new Error('Source removal needs an explicit tombstone in the same batch');
  const wire = (path, base, value) => {
    before[path] = copy(base);
    patch[path] = stored(intent(original.owner, path, base, value).after);
    patch[path][META].operationId = id; // Operation identity is metadata, never authentication.
    return patch[path];
  };
  proposed.entries = proposed.entries.map(entry => {
    const base = old.get(String(entry.id)) ?? null;
    if (same(base, entry)) return entry;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(entry.id))) throw new Error('Unsupported entry identity');
    return wire(`entries/e_${entry.id}`, base, entry);
  });
  proposed.timer = wire('timer', original.timer, {...original.timer, ...projection.timer});
  proposed.generation = original.generation + 1;
  return {id, kind, owner: original.owner, device: original.device, session: original.session,
    phase: 'intent', attempts: 0, uncertain: false, applied: false,
    original: copy(original), proposed, before, patch};
}

export function createLifecycle({store, owner, active, transport}) {
  function load() {
    const envelope = JSON.parse(store.read());
    if (envelope?.v !== 1 || envelope.owner !== owner) throw new Error('Wrong account or unsupported recovery envelope');
    return envelope;
  }
  function attached(op) {
    const context = active();
    return context?.owner === owner && context.device === op.device && context.session === op.session;
  }
  function update(id, edit) {
    const envelope = load();
    if (envelope.operation?.id !== id) throw new Error('Operation replaced; old acknowledgement cannot change current state');
    edit(envelope.operation, envelope);
    writeConfirmed(store, envelope);
    return copy(envelope.operation);
  }
  function mark(id, phase, evidence) {
    return update(id, op => {
      if (op.phase === 'accepted' || op.phase === 'refused' && phase !== 'accepted') return;
      op.phase = phase; op.evidence = copy(evidence);
      if (phase === 'unknown') op.uncertain = true;
    });
  }
  function classify(op, actual) {
    const matches = (record, expected) => Object.keys(expected).every(path => same(record[path], expected[path]));
    if (matches(actual, op.patch)) return 'after';
    if (matches(actual, op.before)) return 'before';
    return 'other';
  }
  async function observe(op) {
    // transport.read is an authenticated, authoritative single-room snapshot, not SDK optimistic cache.
    const actual = await transport.read(owner, Object.keys(op.patch));
    return {actual, match: classify(op, actual)};
  }
  return {
    snapshot: () => copy(load()),
    prepare({id, kind, projection}) {
      const envelope = load();
      if (envelope.operation && !(envelope.operation.phase === 'refused' || envelope.operation.applied)) throw new Error('Pending accounting barrier; retain the current intent');
      if (!same(envelope.frame, projection.original)) throw new Error('Captured original state changed; do not reauthorize the proposal');
      if ([envelope.operation, ...envelope.history].some(op => op?.id === id)) throw new Error('Operation identity reuse');
      const op = operation(id, kind, envelope.frame, projection);
      if (!attached(op) || envelope.frame.timer.running && envelope.frame.timer.ownerDeviceId !== op.device) throw new Error('Account/device/session guard');
      if (envelope.operation) envelope.history.push(envelope.operation);
      envelope.operation = op;
      writeConfirmed(store, envelope); // No domain access or local accounting transition before confirmation.
      return copy(op);
    },
    async recover() {
      const op = load().operation;
      if (!op || op.phase === 'accepted' || op.phase === 'refused' || !attached(op)) return copy(op);
      try {
        const observed = await observe(op);
        if (observed.match === 'after') return mark(op.id, 'accepted', {authority: 'server-post-image', id: op.id, records: observed.actual});
        // An old in-flight request could still land. An unchanged pre-state permits only identical CAS retry.
        return update(op.id, current => {
          if (current.phase === 'accepted' || current.phase === 'refused') return;
          current.phase = current.attempts ? 'unknown' : 'intent';
          current.uncertain ||= current.attempts > 0;
          current.retrySafe = observed.match === 'before';
          current.evidence = {authority: 'server-read', match: observed.match};
        });
      } catch (error) {return mark(op.id, 'unknown', {reason: String(error.message)});}
    },
    async submit() {
      let op = load().operation;
      if (!op || op.phase === 'accepted' || op.phase === 'refused' || !attached(op)) return copy(op);
      if (!same(load().frame, op.original)) return copy(op); // New local Stop/takeover/edit cannot be rolled back.
      let observed;
      try {observed = await observe(op);} catch (error) {return mark(op.id, 'unknown', {reason: String(error.message)});}
      if (!attached(op)) return copy(load().operation);
      if (observed.match === 'after') return mark(op.id, 'accepted', {authority: 'server-post-image', id: op.id, records: observed.actual});
      if (observed.match !== 'before') return mark(op.id, load().operation.attempts ? 'unknown' : 'refused', {authority: 'server-read', match: observed.match});
      const priorUncertainty = op.uncertain || op.attempts > 0;
      op = update(op.id, current => {
        if (current.phase === 'accepted' || current.phase === 'refused') return;
        current.phase = 'pending'; current.attempts++;
      });
      if (op.phase !== 'pending') return op;
      let result;
      try {result = await transport.patch(owner, copy(op.patch));}
      catch (error) {return mark(op.id, 'unknown', {reason: String(error.message)});}
      // RTDB PATCH replies use a nested tree even when the request uses multi-path keys.
      const echoed = Object.fromEntries(Object.keys(op.patch).map(path => [path,
        result.body?.[path] ?? path.split('/').reduce((node, key) => node?.[key], result.body)]));
      if (result.status === 200 && same(echoed, op.patch)) {
        return mark(op.id, 'accepted', {authority: 'server-ack', id: op.id, records: echoed});
      }
      if (result.status === 401 || result.status === 403) {
        const latest = load().operation;
        return mark(op.id, priorUncertainty || latest.uncertain || latest.attempts !== op.attempts ? 'unknown' : 'refused', {authority: 'server-refusal', status: result.status});
      }
      return mark(op.id, 'unknown', {reason: 'No authoritative matching acknowledgement'});
    },
    apply() {
      const envelope = load(), op = envelope.operation;
      if (!op || op.phase !== 'accepted' || op.applied) return false;
      if (!attached(op) || !same(envelope.frame, op.original)) return false;
      envelope.frame = copy(op.proposed); op.applied = true; envelope.applications++;
      // Atomic local envelope = frame + consumed Undo + applied identity. Rehydrate, never rerun Undo.
      writeConfirmed(store, envelope);
      return true;
    },
  };
}
