// time-ack.js — acknowledged Undo for recorded time (TASK-039).
//
// An Undo that tombstones/restores recorded entries (and may rewind the owned timer cursor) is ONE
// accounting operation. It is staged durably in an account-scoped localStorage record that is read
// back before anything is sent, committed as ONE authenticated multi-path RTDB PATCH, and applied
// locally only after the server has acknowledged it. Phases:
//   preparing shared reservation before agreement reads; no attempt has been sent
//   intent   staged; nothing sent; nothing local changed
//   pending  an attempt is in flight (recorded BEFORE the request leaves)
//   accepted the server acknowledged the whole exact patch, or an authoritative read shows every
//            exact post-image. Finalized once: applied, or 'superseded' when a newer local change
//            means the frozen result can no longer be applied.
//   refused  nothing was sent, or the first attempt was refused outright (401/403). Undo is kept.
//   unknown  a sent attempt has no authoritative answer. Kept across reloads, reconciled from
//            server reads, never discarded automatically. Identical retry requires every exact
//            before-image. Cancellation requires an enforced fence; a timeout never permits it.
// The SDK's optimistic cache, a UI transition or a missing exception is never acceptance: reads and
// writes use the RTDB REST API with the signed-in user's ID token. Operation identity and the
// _csWrite revision stamp are metadata, never authentication. No time calculation lives here.
(function (root) {
  'use strict';

  const STORAGE_BASE = 'ta3-time-ack';
  const META = '_csWrite';
  const HISTORY_LIMIT = 20;
  const OPEN_PHASES = new Set(['preparing', 'intent', 'pending', 'unknown', 'accepted']);
  const SETTLE_TRIES = 6;
  const SETTLE_MS = 400;

  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  /** RTDB stores no nulls or empty objects: compare and send values the way the server holds them. */
  function stored(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') return value;
    const result = Array.isArray(value) ? [] : {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = stored(child);
      if (normalized !== null) result[key] = normalized;
    }
    return Object.keys(result).length ? result : null;
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }

  const same = (a, b) => JSON.stringify(canonical(stored(a))) === JSON.stringify(canonical(stored(b)));

  function baseRevision(value) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, META)) return 0;
    const meta = value[META];
    if (!meta || meta.v !== 1 || !Number.isSafeInteger(meta.revision) || meta.revision < 1
      || !Number.isSafeInteger(meta.baseRevision) || meta.baseRevision < 0 || meta.revision !== meta.baseRevision + 1
      || typeof meta.baseExists !== 'boolean' || !meta.baseExists && meta.baseRevision !== 0
      || typeof meta.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(meta.operationId)
      || (meta.protocol != null && meta.protocol !== 'staged-command-v1')
      || Object.keys(meta).some(key => !['v', 'protocol', 'revision', 'baseRevision', 'baseExists', 'operationId'].includes(key))) {
      throw new Error('Invalid stored revision');
    }
    return meta.revision;
  }

  /** The proven per-record revision/existence stamp, computed ONCE from the server before-image. */
  function stamp(before, after, operationId) {
    const base = baseRevision(before);
    if (base >= Number.MAX_SAFE_INTEGER) throw new Error('Revision exhausted');
    return stored({ ...copy(after), [META]: {
      v: 1, baseExists: before != null, baseRevision: base, revision: base + 1, operationId,
    } });
  }

  /** RTDB PATCH replies echo a nested tree even when the request used multi-path keys. */
  function echoed(body, patch) {
    return Object.fromEntries(Object.keys(patch).map(path => [path,
      body && Object.prototype.hasOwnProperty.call(body, path) ? body[path]
        : path.split('/').reduce((node, key) => node == null ? undefined : node[key], body)]));
  }

  function createTimeAck({ storage, lock, transport, sleep, randomId }) {
    const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const key = owner => `${STORAGE_BASE}:${owner}`;

    function load(owner) {
      const raw = storage.getItem(key(owner));
      if (raw == null) return { v: 1, owner, operation: null, history: [] };
      const envelope = JSON.parse(raw);
      if (!envelope || envelope.v !== 1 || envelope.owner !== owner || !Array.isArray(envelope.history)) {
        throw new Error('Unsupported time acknowledgement record');
      }
      return envelope;
    }

    function save(owner, envelope) {
      const raw = JSON.stringify(envelope);
      storage.setItem(key(owner), raw);
      if (storage.getItem(key(owner)) !== raw) throw new Error('Durable readback failed');
    }

    function update(owner, id, edit) {
      const envelope = load(owner);
      if (!envelope.operation || envelope.operation.id !== id) throw new Error('Operation replaced');
      edit(envelope.operation, envelope);
      save(owner, envelope);
      return copy(envelope.operation);
    }

    function retire(owner, id, outcome, evidence) {
      return update(owner, id, (op, envelope) => {
        op.outcome = outcome;
        op.finalizedAt = Date.now();
        if (evidence) op.finalEvidence = copy(evidence);
        envelope.history.unshift(copy(op));
        envelope.history.length = Math.min(envelope.history.length, HISTORY_LIMIT);
        envelope.operation = null;
      });
    }

    function classify(op, actual) {
      const paths = Object.keys(op.patch);
      if (paths.every(path => same(actual[path], op.patch[path]))) return 'after';
      // A surviving stamp cannot prove every exact postimage after intervening writes.
      if (paths.every(path => same(actual[path], op.before[path]))) return 'before';
      return 'other';
    }

    /** The open (barrier-holding) operation, null, or {phase:'unreadable'} for a record it cannot parse. */
    let cachedRaw = null, cachedOpen = null;
    function openOperation(owner) {
      const raw = storage.getItem(key(owner));
      if (raw === cachedRaw && raw !== null) return copy(cachedOpen);
      let envelope;
      try { envelope = load(owner); } catch { return { phase: 'unreadable' }; }
      const op = envelope.operation;
      cachedRaw = raw; cachedOpen = op && OPEN_PHASES.has(op.phase) ? op : null;
      return copy(cachedOpen);
    }

    function lastFinalized(owner) {
      try { return copy(load(owner).history[0] || null); } catch { return null; }
    }

    /**
     * Reads the affected paths and requires them to agree with the local frame (allowing a
     * just-issued write to land), stages the operation durably, then sends the first attempt —
     * all under one cross-tab lock. Nothing local changes here.
     * spec: {owner, uid, device, session, label, actionCreatedAt, records:{path:proposedValue},
     *        agrees(actual) -> bool, local, proposedLocal}
     */
    function begin(spec) {
      return lock(spec.owner, async () => {
        const envelope = load(spec.owner);
        if (envelope.operation && OPEN_PHASES.has(envelope.operation.phase)) {
          return { refused: 'barrier', operation: copy(envelope.operation) };
        }
        const paths = Object.keys(spec.records);
        if (!paths.length) throw new Error('Empty accounting operation');
        const id = randomId();
        if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw new Error('Invalid operation identity');
        if (envelope.history.some(op => op.id === id)) throw new Error('Operation identity reuse');
        envelope.operation = {
          id, owner: spec.owner, uid: spec.uid, device: spec.device, session: spec.session,
          label: spec.label, actionCreatedAt: spec.actionCreatedAt, createdAt: Date.now(),
          phase: 'preparing', attempts: 0, uncertain: false, retrySafe: false,
          records: copy(spec.records), before: {}, patch: {}, local: copy(spec.local),
          proposedLocal: copy(spec.proposedLocal), evidence: null,
        };
        save(spec.owner, envelope); // shared barrier BEFORE the first authoritative agreement read
        let actual = null;
        for (let attempt = 0; attempt < SETTLE_TRIES; attempt++) {
          try { actual = await transport.read(spec.owner, paths); } catch (error) {
            retire(spec.owner, id, 'refused', { reason: 'unreachable-before-send' });
            return { refused: 'unreachable', reason: String(error && error.message || error) };
          }
          if (spec.agrees(actual)) break;
          actual = null;
          if (attempt < SETTLE_TRIES - 1) await wait(SETTLE_MS);
        }
        if (!actual) { retire(spec.owner, id, 'refused', { reason: 'server-differs-before-send' }); return { refused: 'server-differs' }; }
        const before = {}, patch = {};
        for (const path of paths) {
          before[path] = actual[path] == null ? null : copy(actual[path]);
          patch[path] = stamp(before[path], spec.records[path], id);
        }
        const op = update(spec.owner, id, current => { current.before = before; current.patch = patch; current.phase = 'intent'; });
        return { operation: await send(spec.owner, op) };
      });
    }

    async function send(owner, op) {
      op = update(owner, op.id, current => { current.phase = 'pending'; current.attempts++; current.lastAttemptAt = Date.now(); });
      let result;
      try { result = await transport.patch(owner, copy(op.patch)); } catch (error) {
        return update(owner, op.id, current => {
          current.phase = 'unknown'; current.uncertain = true; current.retrySafe = false;
          current.evidence = { reason: String(error && error.message || error) };
        });
      }
      if (result.status === 200 && Object.entries(echoed(result.body, op.patch)).every(([path, value]) => same(value, op.patch[path]))) {
        return update(owner, op.id, current => {
          current.phase = 'accepted'; current.evidence = { authority: 'server-ack', status: 200 };
        });
      }
      if ((result.status === 401 || result.status === 403) && op.attempts === 1 && !op.uncertain) {
        return update(owner, op.id, current => {
          current.phase = 'refused'; current.evidence = { authority: 'server-refusal', status: result.status };
        });
      }
      return update(owner, op.id, current => {
        current.phase = 'unknown'; current.uncertain = true; current.retrySafe = false;
        current.evidence = { reason: 'No authoritative matching acknowledgement', status: result.status };
      });
    }

    /** Reconciles an interrupted or unanswered attempt from authoritative server state. */
    function recover(owner) {
      return lock(owner, async () => {
        const op = load(owner).operation;
        if (op && op.resolution === 'keep-server-version') return copy(op);
        // Staged, then interrupted before its attempt was recorded: nothing was ever sent.
        if (op && (op.phase === 'intent' || op.phase === 'preparing')) {
          return update(owner, op.id, current => { current.phase = 'refused'; current.evidence = { reason: 'interrupted-before-send' }; });
        }
        if (!op || (op.phase !== 'pending' && op.phase !== 'unknown')) return copy(op);
        let actual;
        try { actual = await transport.read(owner, Object.keys(op.patch)); } catch (error) {
          return update(owner, op.id, current => {
            current.phase = 'unknown'; current.uncertain = true; current.retrySafe = false;
            current.evidence = { reason: String(error && error.message || error) };
          });
        }
        const match = classify(op, actual);
        return update(owner, op.id, current => {
          if (match === 'after') {
            current.phase = 'accepted';
            current.evidence = { authority: 'server-post-image' };
            return;
          }
          current.phase = 'unknown'; current.uncertain = true;
          current.retrySafe = match === 'before';
          current.evidence = { authority: 'server-read', match };
        });
      });
    }

    /** User-chosen identical retry: same id, timestamps, bases and payload. Only from the before-state. */
    function retry(owner) {
      return lock(owner, async () => {
        const op = load(owner).operation;
        if (!op || op.resolution || op.phase !== 'unknown' || !op.retrySafe) return copy(op);
        let actual;
        try { actual = await transport.read(owner, Object.keys(op.patch)); } catch { return copy(op); }
        const match = classify(op, actual);
        if (match === 'after') return update(owner, op.id, current => { current.phase = 'accepted'; current.evidence = { authority: 'server-post-image' }; });
        if (match !== 'before') return update(owner, op.id, current => { current.retrySafe = false; current.evidence = { authority: 'server-read', match }; });
        return send(owner, op);
      });
    }

    /** Compatibility entry point: elapsed time and an unchanged before-image cannot cancel a PATCH. */
    function abandon(owner) {
      return lock(owner, () => ({ operation: copy(load(owner).operation), abandoned: false,
        reason: 'requires-enforceable-cancellation' }));
    }

    /**
     * Applies an accepted operation exactly once (apply(op) -> 'applied' | 'superseded'), or
     * retires a refused one. attached(op) keeps it dormant for another account/device.
     */
    function finalize(owner, { attached, apply }) {
      return lock(owner, async () => {
        const op = load(owner).operation;
        if (!op) return { outcome: null };
        if (op.phase === 'refused') { retire(owner, op.id, 'refused'); return { outcome: 'refused', operation: op }; }
        if (op.phase !== 'accepted') return { outcome: null, operation: copy(op) };
        if (!attached(op)) return { outcome: 'dormant', operation: copy(op) };
        const outcome = apply(copy(op)) === 'applied' ? 'applied' : 'superseded';
        retire(owner, op.id, outcome);
        return { outcome, operation: op };
      });
    }

    return { openOperation, lastFinalized, begin, recover, retry, abandon, finalize };
  }

  function createRestTransport({ databaseURL, getIdToken, fetchImpl, timeoutMs = 15000 }) {
    const segment = value => String(value).split('/').map(encodeURIComponent).join('/');
    async function call(method, owner, path, body) {
      const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      let timer = null;
      try {
        // The token fetch is inside the same deadline, so a hung refresh cannot hold the lock forever.
        const token = await Promise.race([getIdToken(), new Promise((_, reject) => {
          timer = setTimeout(() => { if (controller) controller.abort(); reject(new Error('Request timed out')); }, timeoutMs);
        })]);
        const url = new URL(databaseURL);
        url.pathname = `${url.pathname.replace(/\/+$/, '')}/rooms/${segment(owner)}${path ? '/' + segment(path) : ''}.json`;
        url.searchParams.set('auth', token);
        const response = await fetchImpl(url.toString(), {
          method, body, cache: 'no-store', signal: controller ? controller.signal : undefined,
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      } finally { if (timer) clearTimeout(timer); }
    }
    return {
      async read(owner, paths) {
        const results = await Promise.all(paths.map(path => call('GET', owner, path)));
        return Object.fromEntries(paths.map((path, index) => {
          if (results[index].status !== 200) throw new Error(`Authoritative read refused ${results[index].status}`);
          return [path, results[index].body];
        }));
      },
      patch: (owner, patch) => call('PATCH', owner, '', JSON.stringify(patch)),
      cancel: (owner, id) => call('PUT', owner, `timeAckCancellations/${id}`, 'true'),
      put: (owner, path, body) => call('PUT', owner, path, body),
    };
  }

  function webLock(owner, task) {
    if (!root.navigator || !root.navigator.locks || typeof root.navigator.locks.request !== 'function') {
      return Promise.reject(new Error('Cross-tab locking unavailable'));
    }
    return root.navigator.locks.request(`${STORAGE_BASE}:${owner}`, task);
  }

  function randomOperationId() {
    const bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    return 'op_' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  const api = { STORAGE_BASE, META, stored, same, stamp, createTimeAck, createRestTransport, webLock, randomOperationId };
  root.TimeAckCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
