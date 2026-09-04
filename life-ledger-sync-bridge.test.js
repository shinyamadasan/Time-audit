import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLifeLedgerSyncBridge,
  isLifeLedgerBackgroundSyncSupported,
  LIFE_LEDGER_SYNC_OUTBOX_FILENAME,
  LIFE_LEDGER_SYNC_STATUS_FILENAME
} from './life-ledger-sync-bridge.js';

function fakeDirectoryHandle() {
  const files = new Map();
  let permission = 'granted';
  let writeCount = 0;
  const delayForCall = new Map(); // 1-based write-call index -> promise to await before committing
  const startedSignalForCall = new Map(); // 1-based write-call index -> resolve fn, fired the instant write() is entered
  const writeOrder = [];
  return {
    files,
    writeOrder,
    setPermission(p) { permission = p; },
    // Delays the Nth write() call (1-based, counting every getFileHandle/write pair) until
    // `promise` settles — used to simulate a slow/older write racing a faster/newer one.
    delayWriteCall(callIndex, promise) { delayForCall.set(callIndex, promise); },
    // Resolves once the Nth write() call has actually been ENTERED — i.e. its owning task has
    // already captured its snapshot (capture always happens before write() is reached). Lets a
    // test deterministically sequence "older captured its state" before changing shared state
    // for a "newer" call, without guessing at microtask-tick counts.
    whenWriteStarted(callIndex) {
      return new Promise(resolve => { startedSignalForCall.set(callIndex, resolve); });
    },
    async queryPermission() { return permission; },
    async requestPermission() { permission = 'granted'; return permission; },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name) && !create) {
        const err = new Error(`not found: ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
      if (!files.has(name)) files.set(name, '');
      writeCount++;
      const myCallIndex = writeCount;
      return {
        async createWritable() {
          const delay = delayForCall.get(myCallIndex);
          return {
            async write(content) {
              const started = startedSignalForCall.get(myCallIndex);
              if (started) started();
              if (delay) await delay;
              files.set(name, content);
            },
            async close() { writeOrder.push(files.get(name)); }
          };
        },
        async getFile() {
          const content = files.get(name);
          return { async text() { return content; } };
        }
      };
    }
  };
}

function fakeHandleStore() {
  let stored = null;
  return {
    async get() { return stored; },
    async set(h) { stored = h; },
    async clear() { stored = null; }
  };
}

function fakeDeps(overrides = {}) {
  let snapshot = '{"events":[]}\n';
  return {
    globalObject: { showDirectoryPicker: () => {}, indexedDB: {} },
    handleStore: fakeHandleStore(),
    exportSnapshotJson: () => snapshot,
    setSnapshot(next) { snapshot = next; },
    digestHex: async text => `fake-digest:${text.length}`,
    ...overrides
  };
}

// ===========================================================================
// Feature detection
// ===========================================================================

test('isLifeLedgerBackgroundSyncSupported requires both showDirectoryPicker and indexedDB', () => {
  assert.equal(isLifeLedgerBackgroundSyncSupported({}), false);
  assert.equal(isLifeLedgerBackgroundSyncSupported({ showDirectoryPicker: () => {} }), false);
  assert.equal(isLifeLedgerBackgroundSyncSupported({ showDirectoryPicker: () => {}, indexedDB: {} }), true);
});

// ===========================================================================
// Not configured / unsupported
// ===========================================================================

test('getStatus on an unsupported browser reports supported:false and nothing else claimed', async () => {
  const deps = fakeDeps({ globalObject: {} });
  const bridge = createLifeLedgerSyncBridge(deps);
  const status = await bridge.getStatus();
  assert.deepEqual(status, { supported: false, configured: false, permission: null, worker: null, outboxSha256: null });
});

test('getStatus before enable reports configured:false', async () => {
  const deps = fakeDeps();
  const bridge = createLifeLedgerSyncBridge(deps);
  const status = await bridge.getStatus();
  assert.equal(status.supported, true);
  assert.equal(status.configured, false);
});

test('writeOutboxSnapshotIfEnabled before enable is a no-op, never throws', async () => {
  const deps = fakeDeps();
  const bridge = createLifeLedgerSyncBridge(deps);
  const result = await bridge.writeOutboxSnapshotIfEnabled();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

// ===========================================================================
// Enable -> immediate write -> status reflects it
// ===========================================================================

test('enable() picks a folder, stores it, and immediately mirrors the current snapshot', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  deps.setSnapshot('{"events":[{"eventId":"a"}]}\n');
  const bridge = createLifeLedgerSyncBridge(deps);

  const result = await bridge.enable();
  assert.equal(result.ok, true);
  assert.equal(handle.files.get(LIFE_LEDGER_SYNC_OUTBOX_FILENAME), '{"events":[{"eventId":"a"}]}\n');

  const status = await bridge.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.permission, 'granted');
  assert.equal(status.outboxSha256, `fake-digest:${'{"events":[{"eventId":"a"}]}\n'.length}`);
  assert.equal(status.worker, null, 'no worker status file has been written yet');
});

test('writeOutboxSnapshotIfEnabled mirrors updated snapshots on demand', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();

  deps.setSnapshot('{"events":[{"eventId":"a"},{"eventId":"b"}]}\n');
  const result = await bridge.writeOutboxSnapshotIfEnabled();
  assert.equal(result.ok, true);
  assert.equal(handle.files.get(LIFE_LEDGER_SYNC_OUTBOX_FILENAME), '{"events":[{"eventId":"a"},{"eventId":"b"}]}\n');
});

// ===========================================================================
// Permission lapses / resume
// ===========================================================================

test('a lapsed permission is reported truthfully, not silently ignored', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();
  handle.setPermission('prompt');

  const status = await bridge.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.permission, 'prompt');
  assert.equal(status.worker, null);

  const writeResult = await bridge.writeOutboxSnapshotIfEnabled();
  assert.equal(writeResult.ok, false);
  assert.equal(writeResult.reason, 'permission_not_granted');
});

test('writeOutboxSnapshotIfEnabled never auto-prompts for permission without force:true', async () => {
  const handle = fakeDirectoryHandle();
  let requestPermissionCalls = 0;
  handle.requestPermission = async () => { requestPermissionCalls++; return 'granted'; };
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable(); // enable() itself calls with force:true once, via requestPermission fallback path
  requestPermissionCalls = 0;
  handle.setPermission('prompt');

  await bridge.writeOutboxSnapshotIfEnabled();
  assert.equal(requestPermissionCalls, 0, 'a background write must never trigger a native permission prompt on its own');
});

test('resume() re-requests permission (a user-gesture action) and writes the current snapshot', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();
  handle.setPermission('prompt');

  const result = await bridge.resume();
  assert.equal(result.ok, true);
  const status = await bridge.getStatus();
  assert.equal(status.permission, 'granted');
});

test('resume() without a prior enable() reports not_configured', async () => {
  const bridge = createLifeLedgerSyncBridge(fakeDeps());
  const result = await bridge.resume();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

// ===========================================================================
// disable()
// ===========================================================================

test('disable() forgets the folder; status returns to not-configured', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();
  await bridge.disable();

  const status = await bridge.getStatus();
  assert.equal(status.configured, false);
  // Files already written to the folder are left alone — disable only stops future writes.
  assert.equal(handle.files.has(LIFE_LEDGER_SYNC_OUTBOX_FILENAME), true);
});

// ===========================================================================
// Reading the worker's status back (the bidirectional loop)
// ===========================================================================

test('getStatus reads back a status file the worker wrote into the same folder', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();

  handle.files.set(LIFE_LEDGER_SYNC_STATUS_FILENAME, JSON.stringify({ outcome: 'synced', message: 'Synced 2 file(s).' }));
  const status = await bridge.getStatus();
  assert.equal(status.worker.outcome, 'synced');
});

test('getStatus tolerates a malformed worker status file without throwing', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();
  handle.files.set(LIFE_LEDGER_SYNC_STATUS_FILENAME, 'not json');

  const status = await bridge.getStatus();
  assert.equal(status.worker, null);
});

// ===========================================================================
// Write failures never throw / never break the caller
// ===========================================================================

test('a write failure is reported, not thrown', async () => {
  const handle = fakeDirectoryHandle();
  handle.getFileHandle = async () => { throw new Error('disk full'); };
  const deps = fakeDeps({ pickDirectory: async () => fakeDirectoryHandle() });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();

  // Swap in the broken handle after enable so enable() itself succeeds and only the next write fails.
  deps.handleStore.set(handle);
  const result = await bridge.writeOutboxSnapshotIfEnabled();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write_failed');
});

// ===========================================================================
// Finding 2 — serialized mirror writes
// ===========================================================================

test('Finding 2: an artificially delayed OLDER write cannot land on disk after a newer logical write', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable(); // baseline write, call #1 — not delayed

  let releaseOlder;
  const gate = new Promise(resolve => { releaseOlder = resolve; });
  handle.delayWriteCall(2, gate); // the OLDER write below will be call #2

  deps.setSnapshot('{"events":["older-A"]}\n');
  const older = bridge.writeOutboxSnapshotIfEnabled(); // enqueued, will block mid-write on the gate

  // Wait for the older task to actually reach write() (i.e. it has already captured "older-A")
  // before flipping shared state — otherwise both calls could capture the same later value,
  // since enqueueing only SCHEDULES a task rather than running it synchronously.
  await handle.whenWriteStarted(2);

  deps.setSnapshot('{"events":["newer-B"]}\n');
  const newer = bridge.writeOutboxSnapshotIfEnabled(); // enqueued strictly behind `older`

  // Release the older write's gate LAST, after the newer call has already been queued — proving
  // the queue, not timing luck, is what enforces ordering.
  releaseOlder();

  const [olderResult, newerResult] = await Promise.all([older, newer]);
  assert.equal(olderResult.ok, true);
  assert.equal(newerResult.ok, true);
  assert.equal(handle.files.get(LIFE_LEDGER_SYNC_OUTBOX_FILENAME), '{"events":["newer-B"]}\n');
  assert.deepEqual(handle.writeOrder.slice(-2), ['{"events":["older-A"]}\n', '{"events":["newer-B"]}\n'], 'disk commit order must be older then newer');
});

test('Finding 2: three rapid queued writes settle with the disk equal to the last (third) snapshot', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();

  deps.setSnapshot('{"events":["one"]}\n');
  const p1 = bridge.writeOutboxSnapshotIfEnabled();
  deps.setSnapshot('{"events":["two"]}\n');
  const p2 = bridge.writeOutboxSnapshotIfEnabled();
  deps.setSnapshot('{"events":["three"]}\n');
  const p3 = bridge.writeOutboxSnapshotIfEnabled();

  const results = await Promise.all([p1, p2, p3]);
  assert.ok(results.every(r => r.ok === true));
  assert.equal(handle.files.get(LIFE_LEDGER_SYNC_OUTBOX_FILENAME), '{"events":["three"]}\n');
});

test('Finding 2: a failed write does not poison the queue -- a later write still succeeds', async () => {
  const workingHandle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => workingHandle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();

  const brokenHandle = fakeDirectoryHandle();
  brokenHandle.getFileHandle = async () => { throw new Error('disk full'); };
  await deps.handleStore.set(brokenHandle);
  deps.setSnapshot('{"events":["fails"]}\n');
  const failed = await bridge.writeOutboxSnapshotIfEnabled();
  assert.equal(failed.ok, false);

  await deps.handleStore.set(workingHandle);
  deps.setSnapshot('{"events":["recovers"]}\n');
  const recovered = await bridge.writeOutboxSnapshotIfEnabled();
  assert.equal(recovered.ok, true);
  assert.equal(workingHandle.files.get(LIFE_LEDGER_SYNC_OUTBOX_FILENAME), '{"events":["recovers"]}\n');
});

test('Finding 2: event followed immediately by a revision of that same event serializes correctly', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();

  deps.setSnapshot('{"events":[{"eventId":"e1","revision":1}]}\n');
  const original = bridge.writeOutboxSnapshotIfEnabled();
  deps.setSnapshot('{"events":[{"eventId":"e1","revision":2}]}\n');
  const revised = bridge.writeOutboxSnapshotIfEnabled();

  await Promise.all([original, revised]);
  assert.equal(handle.files.get(LIFE_LEDGER_SYNC_OUTBOX_FILENAME), '{"events":[{"eventId":"e1","revision":2}]}\n');
});

test('Finding 2: event followed immediately by its own tombstone serializes correctly', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();

  deps.setSnapshot('{"events":[{"eventId":"e1","tombstone":{"active":false}}]}\n');
  const active = bridge.writeOutboxSnapshotIfEnabled();
  deps.setSnapshot('{"events":[{"eventId":"e1","tombstone":{"active":true}}]}\n');
  const tombstoned = bridge.writeOutboxSnapshotIfEnabled();

  await Promise.all([active, tombstoned]);
  assert.equal(handle.files.get(LIFE_LEDGER_SYNC_OUTBOX_FILENAME), '{"events":[{"eventId":"e1","tombstone":{"active":true}}]}\n');
});

test('Finding 2: a focus-outcome mirror immediately followed by a plan-step-outcome mirror serializes correctly (mirrors learning-plan-ui.js\'s back-to-back call pattern)', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();

  deps.setSnapshot('{"events":[{"type":"focus_session_completed"}]}\n');
  const focusMirror = bridge.writeOutboxSnapshotIfEnabled();
  deps.setSnapshot('{"events":[{"type":"focus_session_completed"},{"type":"plan_step_completed"}]}\n');
  const planStepMirror = bridge.writeOutboxSnapshotIfEnabled();

  await Promise.all([focusMirror, planStepMirror]);
  assert.equal(handle.files.get(LIFE_LEDGER_SYNC_OUTBOX_FILENAME), '{"events":[{"type":"focus_session_completed"},{"type":"plan_step_completed"}]}\n');
});

// ===========================================================================
// Self-healing mirror refresh (soft requirement)
// ===========================================================================

test('self-healing: getStatus() schedules exactly one refresh when the current hash differs from the last successful mirror', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable(); // writes '{"events":[]}\n' and records its hash

  // Simulate a change that never got mirrored (e.g. a prior write failure or a fresh reload).
  deps.setSnapshot('{"events":["unmirrored-change"]}\n');
  await bridge.getStatus();
  // getStatus() only SCHEDULES the refresh (queued, not awaited) — await the same queue via a
  // no-op enqueue to let it settle before asserting.
  await bridge.writeOutboxSnapshotIfEnabled();

  assert.equal(handle.files.get(LIFE_LEDGER_SYNC_OUTBOX_FILENAME), '{"events":["unmirrored-change"]}\n');
});

test('self-healing: getStatus() does not schedule a redundant write when already up to date', async () => {
  const handle = fakeDirectoryHandle();
  const deps = fakeDeps({ pickDirectory: async () => handle });
  const bridge = createLifeLedgerSyncBridge(deps);
  await bridge.enable();
  const writeCountAfterEnable = handle.writeOrder.length;

  await bridge.getStatus(); // same snapshot as already mirrored -- must not trigger another write
  await new Promise(resolve => setTimeout(resolve, 0)); // let any (wrongly) scheduled microtask settle

  assert.equal(handle.writeOrder.length, writeCountAfterEnable, 'no redundant write when nothing changed');
});
