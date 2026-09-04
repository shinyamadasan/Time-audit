import { lifeLedgerSyncBridge } from './life-ledger-sync-bridge.js';

// Phase 10 — Settings UI wiring for background sync. Kept deliberately separate from the pure
// bridge logic (life-ledger-sync-bridge.js) so the truthful-status text function can be unit
// tested with no DOM at all, mirroring life-ledger-export-ui.js's separation of concerns.
//
// HARD RULE: never render "synced" unless the worker itself has reported a matching successful
// sync for the CURRENT outbox content (outboxSha256 match). Local persistence (localStorage) is
// not proof Obsidian was updated — only a worker status file with a matching hash is.

export function describeLifeLedgerSyncStatus(status) {
  if (!status || status.supported === false) {
    return { text: 'Background sync is not available in this browser.', tone: 'muted', action: null };
  }
  if (!status.configured) {
    return { text: 'Background sync is off. Enable it to stop needing manual exports.', tone: 'muted', action: 'enable' };
  }
  if (status.permission !== 'granted') {
    return { text: 'Background sync is paused — folder access was not granted.', tone: 'warn', action: 'resume' };
  }
  const worker = status.worker;
  if (!worker) {
    return { text: 'Background sync is on — waiting for the first sync.', tone: 'muted', action: null };
  }
  if (worker.outcome === 'conflict') {
    return { text: `Sync blocked: conflict (${worker.reason || 'unresolved'}). Action required.`, tone: 'error', action: null };
  }
  if (worker.outcome === 'intervention_required') {
    return { text: 'Sync needs attention — a change could not be completed safely. Action required.', tone: 'error', action: null };
  }
  if (worker.outcome === 'error') {
    return { text: 'Sync temporarily unavailable. It will retry automatically.', tone: 'warn', action: null };
  }
  const upToDate = (worker.outcome === 'synced' || worker.outcome === 'unchanged')
    && status.outboxSha256 != null && worker.outboxSha256 === status.outboxSha256;
  if (upToDate) {
    return { text: 'Life Ledger synced.', tone: 'ok', action: null };
  }
  if (worker.outcome === 'no_source') {
    return { text: 'Background sync is on — waiting for the first sync.', tone: 'muted', action: null };
  }
  // The worker has run and reported success, but for an OLDER outbox snapshot than the one we
  // have locally right now — i.e. there are local changes it has not seen yet.
  return { text: 'Life Ledger has changes waiting to sync.', tone: 'muted', action: null };
}

function statusEl() {
  return document.getElementById('life-ledger-sync-status');
}
function enableBtn() {
  return document.getElementById('life-ledger-sync-enable-btn');
}

function toneColor(tone) {
  if (tone === 'ok') return 'var(--ok, #2ecc71)';
  if (tone === 'warn') return 'var(--warn, #e6a23c)';
  if (tone === 'error') return 'var(--err)';
  return 'var(--muted)';
}

async function refreshStatusUi() {
  const el = statusEl();
  if (!el) return;
  let status;
  try {
    status = await lifeLedgerSyncBridge.getStatus();
  } catch (err) {
    el.textContent = `Background sync status unavailable: ${err.message}`;
    el.style.color = 'var(--err)';
    return;
  }
  const described = describeLifeLedgerSyncStatus(status);
  el.textContent = described.text;
  el.hidden = false;
  el.style.color = toneColor(described.tone);

  const btn = enableBtn();
  if (btn) {
    if (described.action === 'enable') { btn.textContent = 'Enable Background Sync'; btn.hidden = false; }
    else if (described.action === 'resume') { btn.textContent = 'Resume Background Sync'; btn.hidden = false; }
    else { btn.hidden = true; }
  }
}

async function handleActionClick() {
  const btn = enableBtn();
  if (!btn) return;
  const isResume = btn.textContent === 'Resume Background Sync';
  btn.disabled = true;
  try {
    const result = isResume ? await lifeLedgerSyncBridge.resume() : await lifeLedgerSyncBridge.enable();
    if (!result.ok && typeof window.showToast === 'function') {
      window.showToast('Background sync could not be enabled');
    }
  } finally {
    btn.disabled = false;
    await refreshStatusUi();
  }
}

function bind() {
  const btn = enableBtn();
  if (btn) btn.addEventListener('click', handleActionClick);
  refreshStatusUi();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
}

if (typeof window !== 'undefined') {
  window.refreshLifeLedgerSyncStatusUi = refreshStatusUi;
}
