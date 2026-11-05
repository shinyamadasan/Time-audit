// Explicit LOCAL integration adapter. The test host installs the matching accounting rule variant.
// Never loaded by index.html or inferred from a server marker. No production capability claim.
(function (root) {
  'use strict';
  const core = root.TimeAckCore;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const originals = Object.fromEntries(['persist',
    '_doQuickSave', 'stopAndLog', 'switchTaskMidBlock', 'autoLogBlock', 'handleRecovery', 'endBreak',
    'autoLogDueTemplates', 'applyAutoTemplateEntries', 'undoLastAction', 'resetTimer', 'timeAckBlocks', 'doPing'].map(name => [name, root[name]]));
  let active = false, before = null, wire = null;
  const owner = () => roomCode;
  const transport = () => core.createRestTransport({ databaseURL: fbApp.options.databaseURL,
    getIdToken: () => currentUser.getIdToken(), fetchImpl: (...args) => fetch(...args) });
  const journal = AccountingCommandJournal.createJournal({ storage: localStorage, lock: core.webLock,
    transport: { read: (...args) => transport().read(...args), patch: (...args) => transport().patch(...args) },
    core, randomId: core.randomOperationId });
  const frame = () => ({ entries: clone(entries), redemptions: clone(focusRedemptions), cursor: clone(timeAckCursorFrame()) });
  const records = () => ({ ...Object.fromEntries(entries.map(e => [`entries/e_${e.id}`, clone(e)])),
    ...Object.fromEntries(focusRedemptions.map(e => [`focusRedemptions/r_${e.id}`, clone(e)])), timer: clone(wire?.timer ?? null) });
  const eventPrefix = room => `ta3-accounting-event:${room}:`;
  const attached = event => event.owner === owner() && _localStateOwner === event.owner
    && currentUser?.uid === event.uid && syncedDeviceId === event.device;
  const blocked = () => !!timeAckOpenOperation() || !!journal.pending(owner());
  const events = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    .filter(key => key?.startsWith(eventPrefix(owner())))
    .map(key => ({ key, event: JSON.parse(localStorage.getItem(key)) }))
    .sort((a, b) => a.event.at - b.event.at || a.key.localeCompare(b.key));
  function timerAgrees(snapshot) {
    const timer = snapshot?.timer;
    if (!timer || timer.ownerRoom !== owner()) return false;
    if (timer.running) return running && timerStateOwnerRoom() === owner()
      && (timer.ownerDeviceId || null) === (timerOwnerDeviceId || null)
      && (timer.taskStartTime || timer.blockStartTime || timer.startedAt) === taskStartTime
      && (timer.blockStartTime || timer.taskStartTime || timer.startedAt) === blockStartTime
      && (timer.trackingStartedAt || null) === (trackingStartedAt || null)
      && timer.lastTask === currentTask;
    if (timer.stopped) return !running && !taskStartTime && !blockStartTime && !timerOwnerDeviceId;
    return !running && breakActive && breakStateOwnedByCurrentAccount()
      && snapshot.breakState?.startedAt === breakStartTs
      && snapshot.breakState?.startedBy === syncedDeviceId;
  }
  root.timeAckBlocks = label => {
    if (!active && journal.pending(owner())) { showToast(`${label} waits for an accounting command`); return true; }
    return originals.timeAckBlocks(label);
  };

  async function refresh() {
    wire = (await transport().read(owner(), ['']))[''] || {};
    return wire;
  }
  function stage(changes) {
    const changed = Object.fromEntries(Object.entries(changes).filter(([path, value]) => !core.same(value, before[path])));
    journal.stage(owner(), changed);
    return Promise.resolve(false); // the publication is still unconfirmed
  }
  root.persist = function () {
    if (active) journal.checkpoint(owner(), frame()); // before separate legacy cache writes
    return originals.persist();
  };
  root.syncEntries = () => active ? stage(Object.fromEntries(entries.map(e => [`entries/e_${e.id}`, clone(e)]))) : Promise.resolve(false);
  root.syncFocusRedemptions = () => active ? stage(Object.fromEntries(focusRedemptions.map(e => [`focusRedemptions/r_${e.id}`, clone(e)]))) : Promise.resolve(false);
  root.syncTimerState = (extra = {}) => {
    if (!active) return false;
    stage({ timer: buildTimerPublication(extra) }); return true;
  };

  async function settle() {
    await journal.recover(owner());
    await journal.finalize(owner(), command => {
      if (command.owner !== owner() || command.device !== syncedDeviceId) return false;
      for (const [path, value] of Object.entries(command.patch)) {
        if (path === 'timer') continue;
        const list = path.startsWith('entries/') ? entries : focusRedemptions;
        const item = list.find(record => String(record.id) === String(value.id));
        // Do not put an old acknowledgement over a newer local generation.
        if (item && core.same({ ...item, _csWrite: null }, { ...value, _csWrite: null })) item._csWrite = clone(value._csWrite);
      }
      originals.persist(); return true;
    });
    await refresh();
  }
  function saveEvent(name, args) {
    const templateEntries = name === 'autoLogDueTemplates'
      ? clone(originals.autoLogDueTemplates({ ...(args[0] || {}), captureOnly: true }) || []) : null;
    if (name === 'autoLogDueTemplates' && !templateEntries.length) return null;
    if (name === 'endBreak' && (!breakActive || !breakStateOwnedByCurrentAccount())) return null;
    if (name === 'handleRecovery' && !isCurrentTimerRecovery(window._timerRecoveryState)) return null;
    if (['autoLogDueTemplates', 'endBreak', 'doPing'].includes(name)) {
      const existing = events().find(item => item.event.name === name);
      if (existing) return existing; // preserve the first immutable occurrence, never recapture it
    }
    const event = { id: core.randomOperationId(), name, args: clone(args), owner: owner(), uid: currentUser.uid,
      device: syncedDeviceId, at: Date.now(), session: trackingStartedAt || taskStartTime,
      recovery: name === 'handleRecovery' ? clone(window._timerRecoveryState) : null,
      templateEntries,
      breakStart: breakStartTs,
      energy: entries.find(e => !e.missed && !e.deleted && !e.break && e.energy)?.energy || 'deep' };
    const key = eventPrefix(event.owner) + event.id, raw = JSON.stringify(event);
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw Error('Automatic event readback failed');
    return { event, key };
  }
  const executingEvents = new Map();
  function invoke(name, args, deferred = null) {
    if (!deferred) return invokeOne(name, args, null);
    const id = deferred.event.id;
    if (executingEvents.has(id)) return executingEvents.get(id);
    const result = invokeOne(name, args, deferred);
    executingEvents.set(id, result);
    return result.finally(() => { if (executingEvents.get(id) === result) executingEvents.delete(id); });
  }
  async function invokeOne(name, args, deferred) {
    const event = deferred?.event || { owner: owner(), uid: currentUser.uid, device: syncedDeviceId,
      name, at: Date.now(), args };
    if (!attached(event)) return false;
    if (!deferred && events().length) {
      await resumeEvents();
      if (events().length) return false;
    }
    if (blocked()) {
      if (!deferred) timeAckBlocks('Accounting');
      return false;
    }
    const localBefore = frame();
    await refresh();
    if (!timerAgrees(wire)) return false; // a fresh revision cannot reauthorize a stale local cursor
    const originalBefore = records();
    const result = await journal.run({ owner: event.owner, uid: event.uid, device: event.device, name,
      at: event.at, before: originalBefore, capture: frame, blocked: () => !!timeAckOpenOperation(),
      validate: () => core.same(localBefore, frame()),
      eventId: deferred?.event.id || null,
      apply() {
        if (!attached(event)) throw Error('Account changed before accounting mutation');
        before = originalBefore; active = true;
        const RealDate = root.Date;
        if (deferred) root.Date = class extends RealDate {
          constructor(...values) { super(...(values.length ? values : [event.at])); }
          static now() { return event.at; }
        };
        try {
          if (name === 'handleRecovery' && deferred) {
            const recovery = event.recovery;
            if (!recovery || recovery.ownerRoom !== owner()
              || event.session !== (trackingStartedAt || taskStartTime)
              || timerOwnerDeviceId !== event.device || !timerStateOwnedByCurrentAccount()) throw Error('Recovery context changed');
            invalidateTimerRecovery();
            if (!event.args[0]) {
              if (recovery.timerExpired) originals.doPing();
              _startHeartbeat();
              if (!recovery.timerExpired) showToast(`Timer resumed · ${recovery.task}`);
              return true;
            }
            originals.autoLogBlock(recovery.task, event.energy, recovery.taskStartTime || recovery.timerStartedAt, recovery.shutdownTs);
            _stopHeartbeat(); originals.resetTimer(); return true;
          }
          if (name === 'endBreak' && deferred && event.breakStart !== breakStartTs) return false;
          if (name === 'autoLogDueTemplates' && deferred) {
            const created = event.templateEntries || [];
            if (created.some(record => entries.some(item => String(item.id) === String(record.id) && !core.same(item, record)))) return false;
            const fresh = created.filter(record => !entries.some(item => String(item.id) === String(record.id)));
            if (!fresh.length) return true;
            return originals.applyAutoTemplateEntries(fresh, args[0] || {});
          }
          return originals[name](...args);
        } finally {
          const after = records(); delete after.timer;
          stage(after); // catches delayed-persist entry helpers before their callback is scheduled
          if (!core.same(localBefore.cursor, timeAckCursorFrame()) && !journal.pending(owner()).records.timer) {
            stage({ timer: buildTimerPublication({ ownerRoom: event.owner, stopped: !running && !breakActive }) });
          }
          root.Date = RealDate; active = false; before = null;
        }
      },
    });
    if (result.blocked) return false;
    await settle();
    if (deferred && result.value !== false && !journal.pending(owner())) localStorage.removeItem(deferred.key);
    return result.value;
  }
  for (const name of ['_doQuickSave', 'stopAndLog', 'switchTaskMidBlock']) {
    root[name] = (...args) => active ? originals[name](...args) : invoke(name, args);
  }
  for (const name of ['autoLogBlock', 'handleRecovery', 'endBreak', 'autoLogDueTemplates', 'doPing']) {
    root[name] = (...args) => {
      if (active) return originals[name](...args);
      const deferred = saveEvent(name, args); // before waiting, mutation or network
      if (!deferred) return false;
      return invoke(name, args, deferred);
    };
  }
  root.undoLastAction = (...args) => {
    if (journal.pending(owner())) { showToast('Undo waits for the earlier accounting command'); return false; }
    return originals.undoLastAction(...args);
  };
  async function resumeEvents() {
    await settle();
    for (const deferred of events()) {
      if (journal.snapshot(owner()).history.some(command => command.eventId === deferred.event.id && command.phase === 'accepted')) {
        localStorage.removeItem(deferred.key); continue;
      }
      if (blocked()) break;
      await invoke(deferred.event.name, deferred.event.args, deferred);
    }
  }
  async function keepServerVersion() {
    const room = owner();
    return core.webLock(room, async () => {
      const key = `${core.STORAGE_BASE}:${room}`, envelope = JSON.parse(localStorage.getItem(key) || 'null');
      const op = envelope?.operation;
      if (!op || op.phase !== 'unknown' || !timeAckAttached(op) || journal.pending(room)) return false;
      op.resolution = 'keep-server-version';
      const raw = JSON.stringify(envelope); localStorage.setItem(key, raw);
      if (localStorage.getItem(key) !== raw) throw Error('Cancellation intent readback failed');
      const databaseURL = new URL(fbApp.options.databaseURL), idToken = await currentUser.getIdToken();
      databaseURL.pathname = `/rooms/${encodeURIComponent(room)}/timeAckCancellations/${op.id}.json`;
      databaseURL.searchParams.set('auth', idToken);
      const reply = await fetch(databaseURL, { method: 'PUT', body: 'true', cache: 'no-store' });
      if (reply.status !== 200) return false;
      const actual = await refresh();
      if (actual.timeAckCancellations?.[op.id] !== true || !timeAckAttached(op)) return false;
      // Automatic events have not mutated entries/cursor; retain their immutable queue separately.
      for (const item of entries) {
        const path = `entries/e_${item.id}`, server = actual.entries?.[`e_${item.id}`] ?? null;
        const captured = op.local.records[path];
        if (!timeAckRecordUnchanged(item, server) && !timeAckRecordUnchanged(item, captured)) return false;
      }
      for (const item of focusRedemptions) {
        const path = `focusRedemptions/r_${item.id}`, server = actual.focusRedemptions?.[`r_${item.id}`] ?? null;
        if (!core.same(item, server) && !core.same(item, op.local.records[path])) return false;
      }
      if (actual.timer?.ownerRoom !== room) return false;
      if (!timerAgrees(actual) && !core.same(timeAckCursorFrame(), op.local.cursor)) return false;
      applyRemoteTimerState(actual.timer, room);
      if (!timerAgrees(actual)) return false;
      entries = Object.values(actual.entries || {});
      focusRedemptions = Object.values(actual.focusRedemptions || {});
      originals.persist();
      op.outcome = 'cancelled-keep-server'; op.finalEvidence = { authority: 'permanent-operation-fence' };
      envelope.history.unshift(op); envelope.operation = null;
      localStorage.setItem(key, JSON.stringify(envelope));
      if (JSON.parse(localStorage.getItem(key)).operation !== null) throw Error('Cancellation finalization readback failed');
      renderTimeAckStatus(); return true;
    });
  }
  root.LocalAccounting = { ready: refresh(), journal, settle, resumeEvents, keepServerVersion };
})(globalThis);
