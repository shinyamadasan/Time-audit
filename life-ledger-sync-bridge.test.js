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
  return {
    files,
    setPermission(p) { permission = p; },
    async queryPermission() { return permission; },
    async requestPermission() { permission = 'granted'; return permission; },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name) && !create) {
        const err = new Error(`not found: ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
      if (!files.has(name)) files.set(name, '');
      return {
        async createWritable() {
          let buffer = '';
          return {
            async write(content) { buffer = content; },
            async close() { files.set(name, buffer); }
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
