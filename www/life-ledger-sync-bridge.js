import { exportLifeLedgerSnapshotJson } from './life-ledger-transport.js';

// Phase 10 — the browser-side half of the durable transport. This module is what makes a Life
// Ledger event durably available to a background process WITHOUT a manual "Export Life Ledger"
// click: once a user opts in (one-time folder pick, via the File System Access API), every call
// to writeOutboxSnapshotIfEnabled() mirrors the exact same deterministic snapshot the manual
// export already produces (unchanged: exportLifeLedgerSnapshotJson()) into that local folder.
// The background worker (scripts/life-ledger-sync-worker.mjs) reads it from there.
//
// The SAME folder is used bidirectionally: the worker also writes a small, secret-free status
// file back into it, which getStatus() reads so the Settings UI can show truthful sync state
// without ever touching the vault or backup filesystem directly.
//
// Deliberately dependency-injected (handleStore / pickDirectory / digestHex / exportSnapshotJson)
// so the full enable/disable/status/write lifecycle is unit-testable with an in-memory fake
// FileSystemDirectoryHandle, with no real browser and no real File System Access API required.
//
// Review Finding 2 — mirror writes are SERIALIZED through one process-local promise queue. A
// snapshot is captured (exportSnapshotJson()) at the moment a queued write task actually starts
// executing, not when the caller happened to invoke writeOutboxSnapshotIfEnabled() — so even if
// an earlier write's I/O is slow, it cannot land on disk after a later, logically-newer write:
// the later task's own task function simply cannot begin until the earlier one has fully
// settled. A failed write resolves (never throws) and never blocks the queue for later calls.

export const LIFE_LEDGER_SYNC_OUTBOX_FILENAME = 'chronasense-life-ledger-outbox-v1.json';
export const LIFE_LEDGER_SYNC_STATUS_FILENAME = 'chronasense-life-ledger-outbox-v1.status.json';

const HANDLE_DB_NAME = 'chronasense-life-ledger-sync';
const HANDLE_STORE_NAME = 'handles';
const HANDLE_KEY = 'outboxDir';

export function isLifeLedgerBackgroundSyncSupported(globalObject = globalThis) {
  return typeof globalObject.showDirectoryPicker === 'function'
    && typeof globalObject.indexedDB === 'object' && globalObject.indexedDB !== null;
}

function defaultIndexedDbHandleStore() {
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(HANDLE_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(HANDLE_STORE_NAME); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return {
    async get() {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const req = db.transaction(HANDLE_STORE_NAME, 'readonly').objectStore(HANDLE_STORE_NAME).get(HANDLE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    },
    async set(handle) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
        tx.objectStore(HANDLE_STORE_NAME).put(handle, HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    async clear() {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
        tx.objectStore(HANDLE_STORE_NAME).delete(HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  };
}

async function defaultDigestHex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function createLifeLedgerSyncBridge(deps = {}) {
  const pickDirectory = deps.pickDirectory
    || (() => globalThis.showDirectoryPicker({ id: 'chronasense-life-ledger-outbox', mode: 'readwrite' }));
  const handleStore = deps.handleStore || defaultIndexedDbHandleStore();
  const exportSnapshotJson = deps.exportSnapshotJson || exportLifeLedgerSnapshotJson;
  const digestHex = deps.digestHex || defaultDigestHex;
  const supported = () => isLifeLedgerBackgroundSyncSupported(deps.globalObject || globalThis);

  async function queryPermission(handle) {
    try {
      return await handle.queryPermission({ mode: 'readwrite' });
    } catch {
      return 'denied';
    }
  }

  async function requestPermission(handle) {
    try {
      return await handle.requestPermission({ mode: 'readwrite' });
    } catch {
      return 'denied';
    }
  }

  async function writeFile(dirHandle, filename, content) {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async function readFileIfExists(dirHandle, filename) {
    try {
      const fileHandle = await dirHandle.getFileHandle(filename, { create: false });
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (err) {
      if (err && err.name === 'NotFoundError') return null;
      throw err;
    }
  }

  async function getHandle() {
    try {
      return await handleStore.get();
    } catch {
      return null;
    }
  }

  // Tracks the hash of the last snapshot this bridge instance itself successfully wrote, purely
  // as a self-healing signal for getStatus() (never persisted, never trusted as proof of sync —
  // that proof only ever comes from the worker's own status file).
  let lastMirroredHash = null;

  // The actual write, captured and executed only when the serialization queue below runs it —
  // this is what makes the capture-at-execution-time ordering guarantee work.
  async function performWrite({ force = false } = {}) {
    if (!supported()) return { ok: false, reason: 'unsupported' };
    const handle = await getHandle();
    if (!handle) return { ok: false, reason: 'not_configured' };
    let permission = await queryPermission(handle);
    if (permission !== 'granted' && force) permission = await requestPermission(handle);
    if (permission !== 'granted') return { ok: false, reason: 'permission_not_granted' };
    try {
      const json = exportSnapshotJson();
      await writeFile(handle, LIFE_LEDGER_SYNC_OUTBOX_FILENAME, json);
      try { lastMirroredHash = await digestHex(json); } catch { /* self-healing hint only */ }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'write_failed', message: err.message };
    }
  }

  // Review Finding 2 — a strict FIFO promise chain. Each call's task only begins once every
  // task enqueued before it has fully settled (success OR failure) — `.then(fn, fn)` on both
  // branches means one failed write can never poison the chain for later calls.
  let writeQueue = Promise.resolve();
  function enqueueWrite(taskFn) {
    const settled = writeQueue.then(taskFn, taskFn);
    writeQueue = settled.then(() => undefined, () => undefined);
    return settled;
  }

  // Writes the current deterministic snapshot into the outbox, if background sync is enabled
  // and permission is currently granted. Never throws — a failure here must never break the
  // caller's primary localStorage write. Pass { force: true } to also (re-)request permission,
  // which only succeeds when called from within a user gesture (e.g. a button click handler).
  // Serialized: concurrent/rapid calls always commit in call order, and the final on-disk
  // content always matches the LAST call's canonical state at the time it actually executes.
  function writeOutboxSnapshotIfEnabled(options = {}) {
    return enqueueWrite(() => performWrite(options));
  }

  // Opt-in entry point. Must be called from a user gesture (a click handler) — showDirectoryPicker
  // requires one. Picks a folder, remembers it, and immediately writes the current snapshot.
  async function enable() {
    if (!supported()) return { ok: false, reason: 'unsupported' };
    const handle = await pickDirectory();
    await handleStore.set(handle);
    return writeOutboxSnapshotIfEnabled({ force: true });
  }

  // Re-grants permission on an already-chosen folder without asking the user to pick again.
  // Must also be called from a user gesture.
  async function resume() {
    const handle = await getHandle();
    if (!handle) return { ok: false, reason: 'not_configured' };
    const permission = await requestPermission(handle);
    if (permission !== 'granted') return { ok: false, reason: 'permission_not_granted' };
    return writeOutboxSnapshotIfEnabled({ force: false });
  }

  async function disable() {
    await handleStore.clear();
    return { ok: true };
  }

  // Truthful status for the Settings UI. Never claims anything the worker hasn't itself reported
  // back via the status file it writes into the same folder.
  async function getStatus() {
    if (!supported()) return { supported: false, configured: false, permission: null, worker: null, outboxSha256: null };
    const handle = await getHandle();
    if (!handle) return { supported: true, configured: false, permission: null, worker: null, outboxSha256: null };
    const permission = await queryPermission(handle);
    if (permission !== 'granted') {
      return { supported: true, configured: true, permission, worker: null, outboxSha256: null };
    }
    let outboxSha256 = null;
    try {
      outboxSha256 = await digestHex(exportSnapshotJson());
    } catch { /* leave null — status must still render */ }
    // Self-healing (soft requirement): a previous mirror write may have failed, or simply never
    // ran for the CURRENT local state (e.g. permission just lapsed and was resumed). Whenever
    // Settings is opened/reloaded and the current canonical hash doesn't match what this bridge
    // last successfully wrote, schedule exactly one refresh attempt through the same serialized
    // queue — never an aggressive retry loop, never awaited here (status must still render fast).
    if (outboxSha256 && outboxSha256 !== lastMirroredHash) {
      writeOutboxSnapshotIfEnabled().catch(() => {});
    }
    let worker = null;
    try {
      const statusJson = await readFileIfExists(handle, LIFE_LEDGER_SYNC_STATUS_FILENAME);
      worker = statusJson ? JSON.parse(statusJson) : null;
    } catch { worker = null; }
    return { supported: true, configured: true, permission, worker, outboxSha256 };
  }

  return { enable, resume, disable, getStatus, writeOutboxSnapshotIfEnabled };
}

// A ready-to-use singleton for the real app (index.html), backed by the real File System Access
// API and IndexedDB. Test files use createLifeLedgerSyncBridge(fakeDeps) directly instead.
export const lifeLedgerSyncBridge = createLifeLedgerSyncBridge();
