import './entry-physical-keys.js';
const keys = globalThis.EntryPhysicalKeys;

/** No timing/merge math: callers supply complete captured entries, never fresh retry proposals. */
export function createPendingWrites({ storage, transport, identity, randomId }) {
  const tails = new Map(), failedCaptures = new Map(), frontiers = new Map();
  const capturePrefix = uid => `ta3-extension-capture-v1:${encodeURIComponent(uid)}:`;
  const slot = uid => `ta3-extension-writes-v1:${uid}`;
  const attached = (context, uid) => context?.uid === uid && context.owner === `uid_${uid}`
    && ['uid', 'owner', 'device', 'generation'].every(field => identity()?.[field] === context[field]);
  const ownedCapture = (record, uid) => record?.v === 1 && record.uid === uid && record.owner === `uid_${uid}`
    && /^[A-Za-z0-9_-]{8,100}$/.test(record.device) && Number.isSafeInteger(record.generation) && record.generation >= 0;
  const serial = (uid, action) => {
    const result = (tails.get(uid) || Promise.resolve()).then(action);
    tails.set(uid, result.catch(() => {})); return result;
  };
  async function load(uid) {
    const raw = await storage.get(slot(uid));
    const state = raw == null ? { v: 1, uid, queue: [], history: [], known: {} } : JSON.parse(raw);
    if (state.v !== 1 || state.uid !== uid || !Array.isArray(state.queue) || !Array.isArray(state.history) || !state.known || typeof state.known !== 'object' || Array.isArray(state.known)
      || [...state.queue, ...state.history].some(item => !item || item.uid !== uid || !/^[A-Za-z0-9_-]{8,100}$/.test(item.id)
        || !item.entry || typeof item.entry !== 'object' || Array.isArray(item.entry))) throw Error('Unknown extension outbox');
    return state;
  }
  async function save(uid, state) {
    const raw = JSON.stringify(state);
    await storage.set(slot(uid), raw);
    if (await storage.get(slot(uid)) !== raw) throw Error('Extension intent readback failed');
  }
  const sameCapture = (left, right) => ['id', 'uid', 'owner', 'device', 'generation', 'at', 'dependsOn'].every(field => left[field] === right[field])
    && keys.same(left.entry, right.entry) && keys.same(left.capture, right.capture);
  async function persistCapture(record) {
    const key = capturePrefix(record.uid) + record.id, raw = JSON.stringify(record);
    const existing = await storage.get(key);
    if (existing != null && existing !== raw) throw Error('Extension capture identity changed');
    if (existing == null) await storage.set(key, raw);
    if (await storage.get(key) !== raw) {
      const state = await load(record.uid);
      if (![...state.queue, ...state.history].some(item => sameCapture(item, record))) throw Error('Extension capture readback failed');
    }
  }
  async function importCaptures(uid, state) {
    const pending = [];
    for (const key of (await storage.keys(capturePrefix(uid))).sort()) {
      const captured = JSON.parse(await storage.get(key));
      if (!ownedCapture(captured, uid) || captured.phase !== 'captured'
        || !/^[A-Za-z0-9_-]{8,100}$/.test(captured.id) || key !== capturePrefix(uid) + captured.id
        || !captured.entry || typeof captured.entry !== 'object' || !Number.isFinite(captured.at)
        || captured.dependsOn != null && !/^[A-Za-z0-9_-]{8,100}$/.test(captured.dependsOn)) throw Error('Unknown extension capture');
      pending.push({ key, captured });
    }
    while (pending.length) {
      const known = [...state.queue, ...state.history];
      const index = pending.findIndex(item => !item.captured.dependsOn || known.some(op => op.id === item.captured.dependsOn));
      if (index < 0) throw Error('Extension capture predecessor unavailable');
      const { key, captured } = pending.splice(index, 1)[0];
      const existing = known.find(item => item.id === captured.id);
      if (existing && !sameCapture(existing, captured)) throw Error('Extension capture identity changed');
      if (!existing) {
        const duplicate = known.find(item => keys.same(item.entry, captured.entry) && keys.same(item.capture, captured.capture));
        if (duplicate) state.history.push({ ...captured, phase: 'coalesced', aliasOf: duplicate.id });
        else {
          const incompatibleCapture = known.some(item => item.entry.id === captured.entry.id
            && (item.entry.tsStart !== captured.entry.tsStart || item.entry.ts > captured.entry.ts));
          state.queue.push({ ...captured, incompatibleCapture });
        }
        state.captureFrontier = captured.id;
      }
      await save(uid, state); // full fact/receipt owns this intake before its removal
      await storage.remove(key);
    }
    if (!frontiers.has(uid)) frontiers.set(uid, state.captureFrontier || state.queue.at(-1)?.id || state.history.at(-1)?.id || null);
  }
  function predecessorConfirmed(state, id) {
    const seen = new Set();
    while (id) {
      if (seen.has(id)) return false;
      seen.add(id);
      const operation = state.history.find(item => item.id === id);
      if (!operation) return false;
      if (operation.aliasOf) { id = operation.aliasOf; continue; }
      return operation.phase === 'accepted';
    }
    return true;
  }
  function validCommand(operation) {
    try {
      const { basis, command, entry } = operation;
      if (!basis || command?.id !== operation.id || command.entryId !== entry.id || basis.id !== entry.id) return false;
      const paths = Object.keys(basis.before || {}), raw = {};
      if (!paths.length || paths.some(path => ![`entries/${entry.id}`, `entries/e_${entry.id}`].includes(path))) return false;
      for (const path of paths) if (basis.before[path] != null) raw[path.slice('entries/'.length)] = basis.before[path];
      const original = keys.resolve(raw, entry.id, paths[0] === `entries/${entry.id}` ? 'extension' : 'app');
      if (original.status !== basis.status || !keys.same(original.before, basis.before)
        || !keys.same(original.record, basis.record)) return false;
      // Reconstruct only from the retained original basis/fact; never a fresh read or timestamp.
      return keys.same(command, keys.prepare(original, { ...original.record, ...entry }, operation.id));
    } catch { return false; }
  }
  function accept(state, operation, authority) {
    operation.phase = 'accepted'; operation.authority = authority;
    state.known[String(operation.entry.id)] = keys.copy(operation.command?.patch || operation.basis.before);
    state.history.push(keys.copy(operation)); state.queue.shift();
  }
  function enqueue(uid, entry, capture = null) {
    // Freeze the complete producer observation before any storage/serialization await.
    const context = keys.copy(identity());
    if (!attached(context, uid)) throw Error('Account detached');
    const id = randomId();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(id) || failedCaptures.has(id)) throw Error('Invalid extension operation identity');
    const record = { v: 1, ...context, id, uid, at: Date.now(), dependsOn: frontiers.get(uid) || null, entry: keys.copy(entry), capture: keys.copy(capture),
      phase: 'captured', attempts: 0, command: null };
    frontiers.set(uid, id);
    const pending = { record, promise: null }; failedCaptures.set(id, pending);
    pending.promise = persistCapture(record).then(() => { failedCaptures.delete(id); });
    pending.promise.catch(() => {}); // the caller receives this same failure through its serialized result
    return serial(uid, async () => {
      await pending.promise;
      const state = await load(uid); await importCaptures(uid, state);
      const operation = [...state.queue, ...state.history].find(item => item.id === id);
      if (!operation) throw Error('Extension captured fact missing');
      return { id, retained: true, phase: operation.phase };
    });
  }
  function drain(uid) {
    const context = keys.copy(identity());
    return serial(uid, async () => {
      if (!attached(context, uid)) return { phase: 'unknown', reason: 'account-detached' };
      for (const [id, pending] of failedCaptures) {
        if (pending.record.uid !== uid) continue;
        try { await pending.promise; } catch { await persistCapture(pending.record); failedCaptures.delete(id); }
      }
      const state = await load(uid); await importCaptures(uid, state);
      while (state.queue.length) {
        if (!attached(context, uid)) return { phase: 'unknown', reason: 'account-detached' };
        const operation = state.queue[0];
        if (!ownedCapture(operation, uid) || operation.device !== context.device) {
          operation.phase = 'unknown'; operation.reason = 'captured-owner-device-unproven'; await save(uid, state); return keys.copy(operation);
        }
        if (operation.dependsOn && !predecessorConfirmed(state, operation.dependsOn)) {
          operation.phase = 'unknown'; operation.reason = 'predecessor-unconfirmed'; await save(uid, state); return keys.copy(operation);
        }
        if (operation.incompatibleCapture) {
          operation.phase = 'unknown'; operation.reason = 'captured-range-regression'; await save(uid, state); return keys.copy(operation);
        }
        // Canonical rules cannot prevent a concurrent writer creating the other alias.
        // Only the LOCAL emulator adapter with the tested binding gate supplies this capability.
        if (transport.enforcesPhysicalIdentity !== true) {
          operation.phase = 'unknown'; operation.reason = 'physical-fence-unproven'; await save(uid, state); return keys.copy(operation);
        }
        if (operation.command && !validCommand(operation)) {
          operation.phase = 'unknown'; operation.reason = 'sealed-command-unreadable'; await save(uid, state); return keys.copy(operation);
        }
        let raw;
        try { raw = await transport.inspect(uid); }
        catch { operation.phase = 'unknown'; operation.reason = 'inspection-unconfirmed'; await save(uid, state); return keys.copy(operation); }
        if (!attached(context, uid)) return { phase: 'unknown', reason: 'account-detached' };
        if (!operation.command) {
          const basis = keys.resolve(raw, operation.entry.id, 'extension');
          if (basis.status === 'unknown') {
            operation.phase = 'unknown'; operation.reason = basis.reason; await save(uid, state); return keys.copy(operation);
          }
          if (basis.status === 'found' && keys.same(keys.content(basis.record), keys.content(operation.entry))) {
            operation.basis = basis;
            accept(state, operation, 'authoritative-existing-content'); await save(uid, state); continue;
          }
          const known = state.known[String(operation.entry.id)];
          if ((basis.status === 'found' && (!known || !keys.same(known, basis.before))) || (basis.status === 'absent' && known)) {
            operation.phase = 'unknown'; operation.reason = 'original-base-unproven'; await save(uid, state); return keys.copy(operation);
          }
          try { operation.command = keys.prepare(basis, { ...basis.record, ...operation.entry }, operation.id); }
          catch { operation.phase = 'unknown'; operation.reason = 'protected-source'; await save(uid, state); return keys.copy(operation); }
          operation.basis = basis;
          operation.phase = 'intent'; await save(uid, state);
        }
        const command = operation.command, paths = Object.keys(command.patch);
        const actual = keys.resolve(raw, operation.entry.id, 'extension');
        if (actual.status === 'found' && keys.same(Object.keys(actual.before).sort(), paths.slice().sort())
          && paths.every(path => keys.same(raw[path.slice('entries/'.length)], command.patch[path]))) {
          accept(state, operation, 'authoritative-post-image'); await save(uid, state); continue;
        }
        if (!keys.unchanged(operation.basis, raw)) {
          operation.phase = 'unknown'; operation.reason = 'source-changed'; await save(uid, state); return keys.copy(operation);
        }
        if (paths.length > 1 && !transport.atomicPatch) {
          operation.phase = 'unknown'; operation.reason = 'atomic-alias-fence-required'; await save(uid, state); return keys.copy(operation);
        }
        if (paths.length === 1 && !operation.etag) {
          let exact;
          try { exact = await transport.read(uid, paths[0]); }
          catch { operation.phase = 'unknown'; operation.reason = 'conditional-read-unconfirmed'; await save(uid, state); return keys.copy(operation); }
          if (!keys.same(exact.value, command.before[paths[0]]) || !exact.etag) {
            operation.phase = 'unknown'; operation.reason = 'conditional-base-changed'; await save(uid, state); return keys.copy(operation);
          }
          operation.etag = exact.etag;
          await save(uid, state);
        }
        operation.phase = 'pending'; operation.attempts++; await save(uid, state);
        let response;
        try {
          if (!attached(context, uid)) return { phase: 'unknown', reason: 'account-detached' };
          response = paths.length === 1
            ? await transport.put(uid, paths[0], keys.copy(command.patch[paths[0]]), operation.etag)
            : await transport.atomicPatch(uid, keys.copy(command.patch));
        } catch { operation.phase = 'unknown'; operation.reason = 'write-unconfirmed'; await save(uid, state); return keys.copy(operation); }
        if (!attached(context, uid)) return { phase: 'unknown', reason: 'account-detached' };
        const echoed = path => Object.hasOwn(response.body || {}, path) ? response.body[path]
          : path.split('/').reduce((value, key) => value?.[key], response.body);
        const exact = paths.length === 1 ? keys.same(response.body, command.patch[paths[0]])
          : paths.every(path => keys.same(echoed(path), command.patch[path]));
        if (response.status === 200 && exact) {
          accept(state, operation, 'server-ack'); await save(uid, state); continue;
        }
        operation.phase = 'unknown'; operation.reason = `server-status-${response.status}`;
        await save(uid, state); return keys.copy(operation);
      }
      return { phase: 'accepted' };
    });
  }
  return { enqueue, drain,
    captureFailures: uid => keys.copy([...failedCaptures.values()].filter(item => item.record.uid === uid).map(item => item.record)),
    snapshot: uid => serial(uid, async () => { const state = await load(uid); await importCaptures(uid, state); return state; }) };
}

/** Conditional single-child REST only. Multi-alias PATCH is never inferred from marker presence. */
export function createExtensionTransport({ databaseURL, getToken, fetchImpl, timeoutMs = 15000, capability = null, identity = null }) {
  async function call(uid, path, method = 'GET', body, headers = {}) {
    const context = identity ? keys.copy(identity()) : null;
    const attached = () => !identity || context?.uid === uid && keys.same(context, identity());
    if (!attached()) throw Error('Account detached');
    const controller = new AbortController();
    let timer;
    try {
      const result = await Promise.race([
        (async () => {
          let token = await getToken(uid);
          if (!attached()) throw Error('Account detached');
          const url = new URL(databaseURL);
          const suffix = path ? '/' + path.split('/').map(encodeURIComponent).join('/') : '';
          url.pathname = `${url.pathname.replace(/\/+$/, '')}/rooms/${encodeURIComponent(`uid_${uid}`)}${suffix}.json`;
          url.searchParams.set('auth', token);
          const options = { method, body: body === undefined ? undefined : JSON.stringify(body), headers, signal: controller.signal, cache: 'no-store' };
          let response = await fetchImpl(url, options);
          if (response.status === 401) {
            if (!attached()) throw Error('Account detached');
            token = await getToken(uid, true);
            if (!attached()) throw Error('Account detached');
            url.searchParams.set('auth', token);
            response = await fetchImpl(url, options); // same frozen path, bytes and conditional ETag
          }
          return { status: response.status, body: await response.json(), etag: response.headers.get('ETag') };
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Extension request unconfirmed')); }, timeoutMs); }),
      ]);
      if (!attached()) throw Error('Account detached');
      return result;
    } finally { clearTimeout(timer); }
  }
  const entryPath = path => typeof path === 'string' && /^entries\/[^\x00-\x1f\x7f.#$\[\]/]+$/.test(path);
  return {
    // Supplied by trusted artifact/rule qualification, never inferred from database marker data.
    get enforcesPhysicalIdentity() { return typeof identity === 'function' && capability?.protocol === keys.PROTOCOL && capability.physicalIdentity === true
      && capability.cancellation === true && /^[a-f0-9]{64}$/.test(capability.rulesHash); },
    async inspect(uid) { const result = await call(uid, 'entries'); if (result.status !== 200) throw Error('Entry inspection refused'); return result.body || {}; },
    async read(uid, path) { if (!entryPath(path)) throw Error('Extension entry path required');
      const result = await call(uid, path, 'GET', undefined, { 'X-Firebase-ETag': 'true' });
      if (result.status !== 200) throw Error('Conditional inspection refused'); return { value: result.body, etag: result.etag }; },
    put(uid, path, value, etag) {
      if (!entryPath(path)) throw Error('Extension entry path required');
      return call(uid, path, 'PUT', value, { 'If-Match': etag, 'Content-Type': 'application/json' });
    },
    atomicPatch(uid, patch) {
      if (!patch || !Object.keys(patch).length || Object.keys(patch).some(path => !entryPath(path))) throw Error('Extension entry patch required');
      return call(uid, '', 'PATCH', patch, { 'Content-Type': 'application/json' });
    },
  };
}
