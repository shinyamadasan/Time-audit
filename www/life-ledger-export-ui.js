import {
  LIFE_LEDGER_EXPORT_FILENAME,
  exportLifeLedgerSnapshotJson
} from './life-ledger-transport.js';

function statusEl() {
  return document.getElementById('life-ledger-export-status');
}

function setStatus(message, isError = false) {
  const el = statusEl();
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
  el.style.color = isError ? 'var(--err)' : 'var(--muted)';
}

function downloadTextFile(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadLifeLedgerSnapshot() {
  try {
    const json = exportLifeLedgerSnapshotJson();
    downloadTextFile(LIFE_LEDGER_EXPORT_FILENAME, json);
    const count = JSON.parse(json).events.length;
    setStatus(`Life Ledger snapshot downloaded (${count} event${count === 1 ? '' : 's'}).`);
    if (typeof window.showToast === 'function') window.showToast('Life Ledger exported');
    return { ok: true, filename: LIFE_LEDGER_EXPORT_FILENAME, json };
  } catch (err) {
    const message = `Life Ledger export failed: ${err.message}`;
    setStatus(message, true);
    if (typeof window.showToast === 'function') window.showToast('Life Ledger export failed');
    return { ok: false, error: err, message };
  }
}

function bindExportButton() {
  const button = document.getElementById('life-ledger-export-btn');
  if (!button) return;
  button.addEventListener('click', downloadLifeLedgerSnapshot);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindExportButton);
} else {
  bindExportButton();
}

window.downloadLifeLedgerSnapshot = downloadLifeLedgerSnapshot;
