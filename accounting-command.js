// Unified accounting lifecycle. Classic script; domain reducers supply all time calculations.
(function (root) {
  'use strict';
  const VERSION = 1;
  const PROTOCOL = 'staged-command-v1';
  const BASE = 'ta3-accounting-state-v1';
  const INTAKE = 'ta3-accounting-capture-v1';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const pathValue = (tree, path) => path.split('/').reduce((node, part) => node?.[part], tree) ?? null;
  const pathAllowed = path => /^(timer|awayState|breakState)$/.test(path)
    || /^(entries|focusRedemptions)\/[^\x00-\x1f\x7f.#$\[\]/]+$/.test(path);

  function createCoordinator({ storage, lock, transport, identity, randomId, same, prepare, project, reconcile, apply, validateLocal = () => {}, validateProjection = () => {} }) {
    const drains = new Map();
    const failed = new Map();
    function readStored(slot) {
      try { return storage.getItem(slot); }
      catch (error) { error.accountingStorageRead = true; throw error; }
    }
    const key = owner => `${BASE}:${owner}`;
    const prefix = owner => `${INTAKE}:${owner}:`;
    const validEffect = (effect, operation) => effect?.v === 1 && effect.operationId === operation.id
      && effect.owner === operation.owner && effect.device === operation.device
      && /^[a-z-]+$/.test(effect.kind) && effect.id === `${operation.id}:${effect.kind}`;
    const validSource = source => source && Array.isArray(source.outcomes)
      && source.outcomes.every(outcome => /^[A-Za-z0-9_-]{8,100}$/.test(outcome?.id) && typeof outcome.result?.ok === 'boolean')
      && new Set(source.outcomes.map(outcome => outcome.id)).size === source.outcomes.length
      && (source.result == null || source.result.ok === true);
    const attached = captured => {
      const current = identity();
      return !!current && ['owner', 'uid', 'device', 'generation'].every(field => current[field] === captured[field])
        && captured.owner === `uid_${captured.uid}`;
    };
    function load(owner) {
      const raw = readStored(key(owner));
      const state = raw == null ? { v: VERSION, owner, generation: 0, committed: null, queue: [], history: [] } : JSON.parse(raw);
      if (state?.v !== VERSION || state.owner !== owner || !Array.isArray(state.queue)
        || !Array.isArray(state.history) || !Number.isSafeInteger(state.generation) || state.generation < 0
        || state.sources != null && !Array.isArray(state.sources)
        || state.provisionalObserved != null && (typeof state.provisionalObserved !== 'object' || Array.isArray(state.provisionalObserved)
          || Object.entries(state.provisionalObserved).some(([id, at]) => !Number.isSafeInteger(at) || at <= 0
            || ![...state.queue, ...state.history].some(op => op.id === id && op.input.ordinary?.v === 1
              && op.input.ordinary.kind === 'start' && at >= op.at)))
        || [...state.queue, ...state.history, ...state.sources || []].some(op => op.v !== VERSION || op.owner !== owner || owner !== `uid_${op.uid}`
          || !/^[A-Za-z0-9_-]{8,100}$/.test(op.id) || !op.input || typeof op.input !== 'object'
          || op.source != null && !validSource(op.source) || op.phase === 'awaiting-source' && !validSource(op.source)
          || op.proposal?.effects != null && (!Array.isArray(op.proposal.effects) || op.proposal.effects.some(effect => !validEffect(effect, op))
            || new Set(op.proposal.effects.map(effect => effect.id)).size !== op.proposal.effects.length))
        || new Set([...state.queue, ...state.history, ...state.sources || []].map(op => op.id)).size
          !== state.queue.length + state.history.length + (state.sources?.length || 0)
        || state.committed != null && (state.committed.generation !== state.generation
          || !state.history.some(op => op.id === state.committed.operationId && op.appliedGeneration === state.generation
            && ['local-applied', 'fenced-reconciled'].includes(op.phase)))
        || state.committed == null && state.generation !== 0
        || state.effects != null && (!Array.isArray(state.effects)
          || new Set(state.effects.map(effect => effect?.id)).size !== state.effects.length || state.effects.some(effect => !effect
          || Object.hasOwn(state.effectReceipts || {}, effect.id)
          || !state.history.some(op => op.id === effect.operationId && op.proposal?.effects?.some(original => same(effect, original)))))
        || state.effectReceipts != null && (typeof state.effectReceipts !== 'object' || Array.isArray(state.effectReceipts)
          || Object.entries(state.effectReceipts).some(([id, receipt]) => receipt?.v !== 1
            || !state.history.some(op => op.id === receipt.operationId && op.proposal?.effects?.some(effect => effect.id === id))))) throw Error('Unreadable accounting envelope');
      return state;
    }
    function save(state) {
      const raw = JSON.stringify(state);
      storage.setItem(key(state.owner), raw);
      if (readStored(key(state.owner)) !== raw) throw Error('Accounting envelope readback failed');
    }
    function captures(owner) {
      return Array.from({ length: storage.length }, (_, i) => storage.key(i))
        .filter(slot => slot?.startsWith(prefix(owner))).map(slot => {
          const captured = JSON.parse(readStored(slot));
          if (captured?.v !== VERSION || captured.owner !== owner || owner !== `uid_${captured.uid}`
            || !/^[A-Za-z0-9_-]{8,100}$/.test(captured.id) || !captured.input || typeof captured.input !== 'object'
            || !['captured', 'awaiting-source', 'source-result', 'provisional-observation'].includes(captured.phase)
            || captured.source != null && !validSource(captured.source)
            || captured.phase === 'awaiting-source' && !validSource(captured.source)
            || captured.phase === 'source-result' && (typeof captured.result?.ok !== 'boolean'
              || !/^[A-Za-z0-9_-]{8,100}$/.test(captured.sourceId))) throw Error('Unreadable accounting capture');
          return { slot, captured };
        }).sort((a, b) => a.captured.at - b.captured.at
          || Number(a.captured.phase === 'source-result') - Number(b.captured.phase === 'source-result') || a.slot.localeCompare(b.slot));
    }
    // Unique intake slots avoid an unlocked read/modify/write race before the first Web Lock await.
    // Their removal follows durable import into the single authoritative projection/command envelope.
    function capture(input, { eventKey = null, local = null, dependsOn = null, at = Date.now(), source = false, provisionalObservation = false, onCaptured = null } = {}) {
      const context = clone(identity());
      if (!context || context.owner !== `uid_${context.uid}`) throw Error('Accounting requires an authenticated owner');
      const id = randomId();
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw Error('Invalid accounting operation identity');
      const slot = prefix(context.owner) + id;
      if (readStored(slot) != null || failed.has(id)) throw Error('Accounting identity already used');
      const record = { v: VERSION, ...context, id, at, eventKey, dependsOn, input: clone(input), local: clone(local),
        phase: provisionalObservation ? 'provisional-observation' : source ? 'awaiting-source' : 'captured', ...(source ? { source: { outcomes: [] } } : {}) };
      const raw = JSON.stringify(record);
      try {
        storage.setItem(slot, raw);
        if (readStored(slot) !== raw) throw Error('Accounting capture readback failed');
      } catch (error) {
        failed.set(id, { record, raw, onCaptured });
        throw error;
      }
      return clone(record);
    }
    // A failed synchronous capture remains an original page-held fact. No later command may
    // send until this fact has passed durable readback in its original account/device partition.
    function failedCaptures(owner) {
      return [...failed.values()].map(item => clone(item.record)).filter(item => item.owner === owner)
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    }
    function flushFailedCaptures(context) {
      for (const record of failedCaptures(context.owner)) {
        if (record.uid !== context.uid || record.device !== context.device) throw Error('Failed capture belongs to another device');
        const item = failed.get(record.id), slot = prefix(record.owner) + record.id;
        const existing = readStored(slot);
        if (existing != null && existing !== item.raw) throw Error('Accounting capture identity changed');
        if (existing == null) storage.setItem(slot, item.raw);
        if (readStored(slot) !== item.raw) throw Error('Accounting capture readback failed');
        failed.delete(record.id);
        item.onCaptured?.(clone(record));
      }
    }
    // Results are immutable intake records, including failed queries. They can be retained after
    // detach in the original partition without applying anything to the newly attached account.
    function completeSource(reservation, result, { dependsOn = reservation.dependsOn } = {}) {
      const state = load(reservation.owner);
      const original = [...state.sources || [], ...state.queue, ...state.history,
        ...captures(reservation.owner).map(item => item.captured)].find(item => item.id === reservation.id && item.source);
      if (!original || !same(original.input, reservation.input)
        || !['owner', 'uid', 'device', 'generation', 'at'].every(field => original[field] === reservation[field])
        || typeof result?.ok !== 'boolean') throw Error('Unproven accounting source reservation');
      const id = randomId();
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw Error('Invalid accounting result identity');
      const slot = `${prefix(original.owner)}result:${id}`;
      if (readStored(slot) != null) throw Error('Accounting result identity already used');
      const record = { ...clone(reservation), id, dependsOn, phase: 'source-result', sourceId: original.id, result: clone(result) };
      const raw = JSON.stringify(record);
      storage.setItem(slot, raw);
      if (readStored(slot) !== raw) throw Error('Accounting result readback failed');
      return clone(record);
    }
    function importCaptures(state) {
      for (const { slot, captured } of captures(state.owner)) {
        if (captured.phase === 'provisional-observation') {
          const source = [...state.queue, ...state.history, ...captures(state.owner).map(item => item.captured)]
            .find(item => item.id === captured.input.sourceId);
          if (captured.input.name !== 'ordinary-heartbeat' || source?.input.ordinary?.v !== 1
            || source.input.ordinary.kind !== 'start' || source.device !== captured.device || source.uid !== captured.uid
            || !Number.isSafeInteger(captured.at) || captured.at < source.at) throw Error('Unreadable provisional observation');
          state.provisionalObserved ||= {};
          state.provisionalObserved[source.id] = Math.max(state.provisionalObserved[source.id] || source.at, captured.at);
          save(state); storage.removeItem(slot); continue;
        }
        if (captured.phase === 'awaiting-source' || captured.phase === 'source-result') {
          state.sources ||= [];
          const originalId = captured.sourceId || captured.id;
          const original = [...state.sources, ...state.queue, ...state.history].find(item => item.id === originalId);
          if (captured.phase === 'awaiting-source') {
            if (!original) state.sources.push(captured);
            else if (!same(original.input, captured.input)) throw Error('Accounting source identity changed');
          } else {
            if (!original?.source || !same(original.input, captured.input)
              || !['owner', 'uid', 'device', 'generation', 'at'].every(field => original[field] === captured[field])
              || typeof captured.result?.ok !== 'boolean') throw Error('Unreadable accounting source result');
            if (!original.source.outcomes.some(item => item.id === captured.id)) {
              original.source.outcomes.push({ id: captured.id, result: clone(captured.result) });
              if (captured.result.ok && !original.source.result) {
                original.source.requestDependency = original.dependsOn;
                original.dependsOn = captured.dependsOn;
                original.source.result = clone(captured.result); original.phase = 'captured';
                state.sources = state.sources.filter(item => item.id !== original.id); state.queue.push(original);
              } else if (captured.result.ok && !same(original.source.result, captured.result)) {
                state.queue.push({ ...captured, phase: 'conflict', reason: 'source-result-changed' });
              }
            }
          }
          save(state); storage.removeItem(slot); continue;
        }
        const known = [...state.queue, ...state.history].find(op => op.id === captured.id
          || (captured.eventKey && op.eventKey === captured.eventKey));
        const semantic = operation => {
          const facts = clone(operation.input.observation?.facts);
          if (!facts) return operation.input;
          if (operation.input.name === 'scheduled-log' && facts.entry) delete facts.entry.updatedAt;
          return { name: operation.input.name, facts };
        };
        if (known?.id === captured.id && (!same(known.input, captured.input)
          || !['owner', 'uid', 'device', 'generation', 'at', 'eventKey', 'dependsOn'].every(field => known[field] === captured[field]))) {
          throw Error('Accounting capture identity changed');
        }
        if (known && captured.eventKey && !same(semantic(known), semantic(captured))) {
          // A repeated source identity with different facts is evidence, never silent deduplication.
          if (!state.queue.some(op => op.id === captured.id)) state.queue.push({ ...captured, phase: 'conflict', reason: 'occurrence-changed' });
        } else if (!known) state.queue.push(captured);
        else if (known.id !== captured.id && !state.history.some(op => op.id === captured.id)) {
          state.history.push({ ...captured, phase: 'coalesced', aliasOf: known.id });
        }
        save(state);
        storage.removeItem(slot);
      }
    }
    function update(state, operation, fields) {
      Object.assign(operation, fields); save(state); return operation;
    }
    function retained(operation) {
      return { status: operation.phase, id: operation.id, reason: operation.reason || null, retained: true };
    }
    async function inspect(context) {
      if (!attached(context)) throw Error('Account detached');
      const raw = await transport.inspect(context.owner);
      if (!attached(context)) throw Error('Account detached');
      return raw || {};
    }
    function exact(raw, records) {
      return Object.entries(records).every(([path, value]) => same(pathValue(raw, path), value));
    }
    function proposalShape(proposal, operation, sealing = false) {
      const record = value => value && typeof value === 'object' && !Array.isArray(value);
      if (!record(proposal) || !record(proposal.patch) || !record(proposal.before) || !record(proposal.local)) return false;
      const paths = Object.keys(proposal.patch);
      if (!paths.length || !same(paths.slice().sort(), Object.keys(proposal.before).sort()) || paths.some(path => !pathAllowed(path))) return false;
      const metadata = value => record(value) && value.v === 1 && Number.isSafeInteger(value.revision) && value.revision > 0
        && Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 0 && value.revision === value.baseRevision + 1
        && typeof value.baseExists === 'boolean' && (value.baseExists || value.baseRevision === 0)
        && typeof value.operationId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value.operationId)
        && (value.protocol == null || value.protocol === PROTOCOL)
        && Object.keys(value).every(field => ['v', 'protocol', 'revision', 'baseRevision', 'baseExists', 'operationId'].includes(field));
      return paths.every(path => {
        const before = proposal.before[path], after = proposal.patch[path], meta = after?._csWrite;
        if (before != null && !record(before) || before?._csWrite !== undefined && !metadata(before._csWrite)
          || !record(after) || !metadata(meta)) return false;
        const base = before?._csWrite?.revision || 0;
        return (sealing || meta.protocol === PROTOCOL) && meta.operationId === operation.id
          && meta.baseExists === (before != null) && meta.baseRevision === base && meta.revision === base + 1;
      });
    }
    function validProposal(proposal, raw, operation) {
      const paths = Object.keys(proposal?.patch || {});
      if (!proposalShape(proposal, operation, true) || !paths.length || !proposal.local || !proposal.before
        || !same(paths.slice().sort(), Object.keys(proposal.before).sort())
        || paths.some(path => !pathAllowed(path) || proposal.patch[path] == null)
        || !exact(raw, proposal.before)) throw Error('Invalid accounting proposal');
      for (const record of Object.values(proposal.patch)) {
        if (record._csWrite?.v !== 1 || record._csWrite.operationId !== operation.id) throw Error('Invalid accounting command stamp');
        record._csWrite.protocol = PROTOCOL;
      }
      if (proposal.effects && (!Array.isArray(proposal.effects) || proposal.effects.some(effect => !validEffect(effect, operation))
        || new Set(proposal.effects.map(effect => effect.id)).size !== proposal.effects.length)) throw Error('Invalid accounting effects');
      return proposal;
    }
    function commitProjection(state, operation, projection, context, details) {
      validateProjection(clone(projection), operation.owner);
      const generation = state.generation + 1;
      const committed = { generation, operationId: operation.id,
        effectName: details.effectName || operation.input.name || null,
        effectFacts: clone(operation.input.observation?.facts || null), value: clone(projection) };
      const next = clone(state);
      next.generation = generation; next.committed = committed;
      next.queue = next.queue.filter(item => item.id !== operation.id);
      if (details.deliverEffects !== false && operation.proposal?.effects?.length) {
        next.effects ||= [];
        for (const effect of operation.proposal.effects) {
          if (!next.effects.some(item => item.id === effect.id) && !Object.hasOwn(next.effectReceipts || {}, effect.id)) next.effects.push(clone(effect));
        }
      }
      const { effectName, deliverEffects, ...receipt } = details;
      next.history.push({ ...clone(operation), ...clone(receipt), appliedGeneration: generation });
      save(next); Object.assign(state, next);
      if (attached(context)) apply(clone(projection), clone(committed));
      return generation;
    }
    async function settleCancellation(state, operation, context) {
      if (!attached(context)) return { status: 'detached', id: operation.id, retained: true };
      if (operation.uid !== context.uid || operation.device !== context.device) {
        return retained(update(state, operation, { reason: 'captured-owner-device' }));
      }
      if (transport.enforcesAccounting !== true || transport.enforcesCancellation !== true || typeof transport.cancel !== 'function') {
        return retained(update(state, operation, { reason: 'cancellation-fence-unproven' }));
      }
      // A lost PUT response does not invalidate a later authoritative permanent-fence read.
      try { await transport.cancel(operation.owner, operation.id); } catch {}
      if (!attached(context)) return { status: 'detached', id: operation.id, retained: true };
      let raw;
      try { raw = await inspect(context); }
      catch { return retained(update(state, operation, { reason: 'cancellation-read-unconfirmed' })); }
      if (raw.timeAckCancellations?.[operation.id] !== true) {
        return retained(update(state, operation, { reason: 'cancellation-read-unconfirmed' }));
      }
      let projection;
      try { projection = reconcile && await reconcile(clone(raw), clone(operation), clone(state.committed)); }
      catch (error) { return retained(update(state, operation, { reason: error.message })); }
      if (!projection) return retained(update(state, operation, { reason: 'fenced-reconciliation-unconfirmed' }));
      if (!attached(context)) return { status: 'detached', id: operation.id, retained: true };
      const paths = Object.keys(operation.proposal?.patch || {});
      const generation = commitProjection(state, operation, projection, context, { phase: 'fenced-reconciled',
        deliverEffects: ['exact-server-ack', 'all-authoritative-post-images'].includes(operation.authority) || operation.proposal && exact(raw, operation.proposal.patch),
        effectName: 'keep-server', authority: 'permanent-operation-fence',
        settledWrites: Object.fromEntries(paths.map(path => [path, clone(pathValue(raw, path))])) });
      return { status: 'fenced-reconciled', id: operation.id, generation, retained: !!state.queue.length };
    }
    async function settleOne(state, operation, context) {
      if (!attached(context)) return { status: 'detached', id: operation.id, retained: true };
      if (operation.uid !== context.uid || operation.device !== context.device) {
        return retained(update(state, operation, { phase: 'conflict', reason: 'captured-owner-device' }));
      }
      if (operation.input.confirmedOnly && operation.proposal) {
        return retained(update(state, operation, { phase: 'conflict', reason: 'confirmed-refresh-must-be-read-only' }));
      }
      if (operation.proposal && !proposalShape(operation.proposal, operation)) {
        const unproven = proposalShape(operation.proposal, operation, true);
        return retained(update(state, operation, { phase: unproven ? 'unknown' : 'conflict',
          reason: unproven ? 'sealed-protocol-unproven' : 'sealed-proposal-unreadable' }));
      }
      if (operation.proposal) {
        try { validateLocal(clone(operation.proposal.local), operation.owner, clone(operation)); }
        catch (error) { return retained(update(state, operation, { phase: 'conflict', reason: error.message })); }
      }
      // A conflict found while planning (nothing sealed or sent) is planned again on the next drain, so it clears
      // once the data no longer conflicts. Intake, device and sealed-proposal conflicts stay held. Conflicts stored by
      // the first accounting release carry no flag, so they are judged by reason.
      const heldReasons = ['occurrence-changed', 'source-result-changed', 'captured-owner-device', 'cyclic-command-dependency'];
      if (operation.phase === 'conflict' && (operation.proposal
        || !(operation.replannable || operation.replannable === undefined && !heldReasons.includes(operation.reason)))) return retained(operation);
      if (transport.enforcesAccounting !== true) {
        return retained(update(state, operation, { reason: 'accounting-fence-unproven' }));
      }
      let raw;
      try { raw = await inspect(context); }
      catch { return retained(update(state, operation, { reason: attached(context) ? 'inspection-unconfirmed' : 'account-detached' })); }
      if (!operation.proposal) {
        let proposal;
        try { proposal = await prepare(clone(operation), clone(raw), clone(state.committed), clone(state.history), clone(state.queue)); }
        catch (error) { return retained(update(state, operation, { phase: 'conflict', reason: error.message, replannable: true })); }
        if (!attached(context)) return { status: 'detached', id: operation.id, retained: true };
        if (proposal?.status === 'wait') return retained(update(state, operation, { reason: proposal.reason }));
        if (proposal?.status === 'conflict') return retained(update(state, operation, { phase: 'conflict', reason: proposal.reason, replannable: true }));
        if (operation.input.confirmedOnly && (operation.input.name !== 'hydrate-accounting' || proposal?.localOnly !== true)) {
          return retained(update(state, operation, { phase: 'conflict', reason: 'confirmed-refresh-must-be-read-only' }));
        }
        if (['hydrate-accounting', 'native-usage', 'legacy-accounting-caches'].includes(operation.input.name) && proposal?.localOnly === true && proposal.projection) {
          const generation = commitProjection(state, operation, proposal.projection, context, { phase: 'local-applied',
            authority: operation.input.name === 'native-usage' ? 'retained-native-result-and-coherent-read'
              : operation.input.name === 'legacy-accounting-caches' ? 'legacy-caches-on-server' : 'coherent-account-read',
            settledWrites: clone(proposal.settledWrites || {}), evidence: clone(proposal.evidence || null) });
          return { status: 'applied', id: operation.id, generation };
        }
        try { validProposal(proposal, raw, operation); validateLocal(clone(proposal.local), operation.owner, clone(operation)); }
        catch (error) { return retained(update(state, operation, { phase: 'conflict', reason: error.message, replannable: true })); }
        update(state, operation, { phase: 'sealed', proposal: clone(proposal), attempts: 0,
          localGeneration: state.generation, reason: null });
      }
      const proposal = operation.proposal;
      if (Object.values(proposal.patch).some(value => value?._csWrite?.protocol !== PROTOCOL)) {
        return retained(update(state, operation, { phase: 'unknown', reason: 'sealed-protocol-unproven' }));
      }
      if (raw.timeAckCancellations?.[operation.id] === true) {
        return retained(update(state, operation, { phase: 'conflict', reason: 'operation-fenced' }));
      }
      if (operation.phase !== 'accepted' && exact(raw, proposal.patch)) {
        update(state, operation, { phase: 'accepted', authority: 'all-authoritative-post-images', reason: null });
      }
      if (operation.phase !== 'accepted') {
        if (!exact(raw, proposal.before)) {
          return retained(update(state, operation, { phase: 'unknown', reason: 'original-source-changed' }));
        }
        update(state, operation, { phase: 'pending', attempts: operation.attempts + 1, reason: null });
        let response;
        try {
          if (!attached(context)) return { status: 'detached', id: operation.id, retained: true };
          response = await transport.patch(context.owner, clone(proposal.patch));
        } catch {
          return retained(update(state, operation, { phase: 'unknown', reason: 'write-unconfirmed' }));
        }
        const echo = response?.body;
        const acknowledged = response?.status === 200 && Object.entries(proposal.patch).every(([path, value]) => same(
          Object.hasOwn(echo || {}, path) ? echo[path] : pathValue(echo, path), value));
        if (!acknowledged) {
          return retained(update(state, operation, { phase: 'unknown', reason: 'write-unconfirmed', responseStatus: response?.status || null }));
        }
        // Record ACK even if the initiating tab detached while the request was in flight.
        update(state, operation, { phase: 'accepted', authority: 'exact-server-ack', reason: null });
      }
      if (!attached(context)) return { status: 'detached', id: operation.id, retained: true };
      try { raw = await inspect(context); }
      catch { return retained(update(state, operation, { reason: 'accepted-readback-unconfirmed' })); }
      let projection;
      try { projection = project(clone(raw), clone(operation), clone(state.committed)); }
      catch (error) { return retained(update(state, operation, { reason: error.message })); }
      if (!projection) return retained(update(state, operation, { reason: 'local-projection-unconfirmed' }));
      if (!attached(context)) return { status: 'detached', id: operation.id, retained: true };
      // Projection, apply receipt and retirement are ONE local commit. Caches are derived afterward.
      const generation = commitProjection(state, operation, projection, context, { phase: 'local-applied' });
      return { status: 'applied', id: operation.id, generation };
    }
    function drain() {
      const context = clone(identity());
      if (!context) return Promise.resolve({ status: 'detached', retained: true });
      const partition = JSON.stringify(context);
      const active = drains.get(partition);
      if (active) { active.again = true; return active.promise; }
      const work = { again: true };
      work.promise = Promise.resolve().then(async () => {
        let result;
        do {
          work.again = false;
          result = await drainOnce(context);
        } while (work.again && attached(context));
        return result;
      }).then(result => {
        if (drains.get(partition) === work) drains.delete(partition);
        return work.again && attached(context) ? drain() : result;
      }, error => {
        if (drains.get(partition) === work) drains.delete(partition);
        throw error;
      });
      drains.set(partition, work);
      return work.promise;
    }
    function drainOnce(context) {
      return lock(context.owner, async () => {
        if (!attached(context)) return { status: 'detached', retained: true };
        const state = load(context.owner);
        try { flushFailedCaptures(context); }
        catch (error) {
          // Read-only recovery may observe a peer Stop while original facts cannot be stored.
          // It never sends, retires or gives a dependency receipt to those page-held facts.
          const refresh = [...state.queue, ...captures(context.owner).map(item => item.captured)]
            .find(item => item.phase === 'captured' && item.input.name === 'hydrate-accounting'
              && item.input.confirmedOnly === true && !item.dependsOn);
          if (!refresh) throw error;
          const settled = state.history.find(item => item.id === refresh.id);
          if (settled) {
            if (!same(settled.input, refresh.input)) throw Error('Accounting capture identity changed');
          } else if (!state.queue.some(item => item.id === refresh.id)) { state.queue.push(refresh); save(state); }
          // The queue/history now durably owns this read; its intake cannot replay the receipt.
          storage.removeItem(prefix(context.owner) + refresh.id);
          if (!settled) await settleOne(state, refresh, context);
          return { status: 'capture-unconfirmed', reason: error.message, retained: true };
        }
        importCaptures(state); // receipt recheck is inside this same lock
        if (state.committed) { validateProjection(clone(state.committed.value), context.owner); apply(clone(state.committed.value), clone(state.committed)); }
        while (state.queue.length) {
          let candidate = state.queue[0];
          const dependencies = new Set();
          const originalDependency = id => {
            const aliases = new Set();
            while (state.history.find(op => op.id === id)?.aliasOf) {
              if (aliases.has(id)) return null;
              aliases.add(id); id = state.history.find(op => op.id === id).aliasOf;
            }
            return id;
          };
          while (candidate.dependsOn && !state.history.some(op => op.id === originalDependency(candidate.dependsOn)
            && ['local-applied', 'fenced-reconciled'].includes(op.phase))) {
            if (dependencies.has(candidate.id)) return retained(update(state, candidate, { phase: 'conflict', reason: 'cyclic-command-dependency' }));
            dependencies.add(candidate.id);
            const parent = state.queue.find(op => op.id === originalDependency(candidate.dependsOn));
            if (!parent) return retained(update(state, candidate, { reason: 'predecessor-unconfirmed' }));
            candidate = parent;
          }
          if (candidate !== state.queue[0]) {
            state.queue.splice(state.queue.indexOf(candidate), 1); state.queue.unshift(candidate); save(state);
          }
          const result = state.queue[0].phase === 'cancelling'
            ? await settleCancellation(state, state.queue[0], context)
            : await settleOne(state, state.queue[0], context);
          if (result.status === 'fenced-reconciled') { importCaptures(state); continue; }
          if (result.status !== 'applied') {
            // A confirmed server read may update the view while an immutable command remains held.
            // It cannot send a mutation, pass a causal dependency or retire that held command.
            const refresh = state.queue.find(item => item.id !== state.queue[0].id && item.phase === 'captured'
              && item.input.name === 'hydrate-accounting' && item.input.confirmedOnly === true && !item.dependsOn);
            if (refresh && attached(context)) await settleOne(state, refresh, context);
            return result;
          }
          importCaptures(state);
        }
        return { status: 'drained', generation: state.generation, retained: false };
      });
    }
    function submit(input, options) {
      const operation = capture(input, options);
      options?.onCaptured?.(clone(operation));
      return drain().then(result => ({ ...result, capturedId: operation.id,
        ownApplied: load(operation.owner).history.some(item => item.id === operation.id && item.phase === 'local-applied') }));
    }
    function cancel(id) {
      const context = clone(identity());
      if (!context) return Promise.resolve({ status: 'detached', retained: true });
      return lock(context.owner, async () => {
        if (!attached(context)) return { status: 'detached', retained: true };
        const state = load(context.owner); importCaptures(state);
        const operation = state.queue[0];
        if (!operation || operation.id !== id) return { status: 'resolution-head-required', retained: true };
        if (operation.uid !== context.uid || operation.device !== context.device) return { status: 'detached', retained: true };
        update(state, operation, { phase: 'cancelling', resolution: 'keep-server', reason: null });
        return settleCancellation(state, operation, context);
      });
    }
    function runEffects(perform) {
      const context = clone(identity());
      if (!context) return Promise.resolve({ status: 'detached', retained: true });
      return lock(context.owner, async () => {
        if (!attached(context)) return { status: 'detached', retained: true };
        const state = load(context.owner);
        if (state.effects != null && !Array.isArray(state.effects)
          || state.effectReceipts != null && (typeof state.effectReceipts !== 'object' || Array.isArray(state.effectReceipts))) throw Error('Unreadable accounting effects');
        for (const effect of [...state.effects || []]) {
          if (effect.owner !== context.owner || effect.device !== context.device) return { status: 'effects-retained', reason: 'captured-owner-device', retained: true };
          let result;
          try { result = await perform(clone(effect), clone(state.committed?.value)); } catch { result = false; }
          if (!attached(context)) return { status: 'detached', retained: true };
          if (result === false) return { status: 'effects-retained', reason: 'effect-unconfirmed', retained: true };
          state.effectReceipts ||= {};
          state.effectReceipts[effect.id] = { v: 1, operationId: effect.operationId, outcome: clone(result ?? true) };
          state.effects = state.effects.filter(item => item.id !== effect.id);
          save(state);
        }
        return { status: 'effects-delivered', retained: false };
      });
    }
    function restore() {
      const context = identity();
      if (!context) return false;
      const state = load(context.owner);
      if (!state.committed) return false;
      validateProjection(clone(state.committed.value), context.owner);
      apply(clone(state.committed.value), clone(state.committed));
      return true;
    }
    // load() parses a fresh object from storage on every call, so no defensive copy is needed.
    function snapshot(owner = identity()?.owner) { return owner ? load(owner) : null; }
    function observeProvisional(sourceId, at = Date.now()) {
      const observation = capture({ name: 'ordinary-heartbeat', sourceId }, { at, provisionalObservation: true });
      return lock(observation.owner, () => {
        if (!attached(observation)) return false;
        const state = load(observation.owner); importCaptures(state); return true;
      });
    }
    return { capture, failedCaptures, reserveSource: (input, options) => capture(input, { ...options, source: true }), completeSource,
      submit, drain, cancel, runEffects, restore, snapshot, observeProvisional, captures: owner => clone(captures(owner)) };
  }
  root.AccountingCommand = { VERSION, PROTOCOL, BASE, INTAKE, clone, pathValue, pathAllowed, createCoordinator };
})(globalThis);
