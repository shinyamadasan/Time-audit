// ChronaSense Coarse Life Evidence V1 (Phase 6H) — browser capture/edit UI.
//
// The smallest reusable "what broad thing? / roughly how long?" capture surface for
// duration-without-placement evidence (contracts/CHRONASENSE_EVIDENCE_CONTRACT_V1.md).
// No start/end time is ever collected or written.
//
// Mounted from Review's optional-details section (`renderCoarseEvidenceList`, called by
// `openReview()`) — the one small, optional access point this milestone is allowed to
// add there (§19 of the milestone spec). Not a new tab, not a mandatory card, not a
// recurring prompt. The same editor is meant to be reusable by a later Review
// reconciliation flow without redesign.
import { createCoarseEvidenceRepository } from './coarse-life-evidence-repository.js';

let _repository = null;
function repository() {
  if (!_repository) _repository = createCoarseEvidenceRepository();
  return _repository;
}

// Same resolution order life-feed-ui.js / life-character-sheet-ui.js use: the classic
// script's `settings` (attached to window only when it exists there), then the
// persisted timezone key, then the device default. Never Date.getHours()/getDay() —
// see storage.js's timezone-safety note.
function resolveAccountingTimezone() {
  const hint = (window.settings && window.settings.timezone) ||
    (globalThis.localStorage && globalThis.localStorage.getItem('ta3-tz')) || '';
  if (hint) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: hint }); return hint; } catch { /* fall through */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDur(min) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

let _editingId = null;
let _listDateKey = null; // date the mounted list should refresh for after save/delete

/** Opens the add/edit modal. Pass `recordId` to edit an existing record. */
export function openCoarseEvidenceEditor(dateKey, recordId = null) {
  const overlay = document.getElementById('coarse-evidence-overlay');
  if (!overlay) return;
  _listDateKey = dateKey;
  _editingId = recordId || null;
  const record = recordId ? repository().get(recordId) : null;

  document.getElementById('cle-title').textContent = record ? 'Edit approximate activity' : 'Add approximate activity';
  document.getElementById('cle-label').value = record ? record.label : '';
  const totalMin = record ? record.estimatedMinutes : 0;
  document.getElementById('cle-hours').value = record ? Math.floor(totalMin / 60) : '';
  document.getElementById('cle-minutes').value = record ? totalMin % 60 : '';
  document.getElementById('cle-date').value = record ? record.date : dateKey;
  document.getElementById('cle-error').textContent = '';

  overlay.classList.add('open');
  document.getElementById('cle-label').focus();
}

export function closeCoarseEvidenceEditor() {
  const overlay = document.getElementById('coarse-evidence-overlay');
  if (overlay) overlay.classList.remove('open');
  _editingId = null;
}

export function saveCoarseEvidenceEditor() {
  const errorEl = document.getElementById('cle-error');
  errorEl.textContent = '';
  const label = document.getElementById('cle-label').value;
  const date = document.getElementById('cle-date').value;
  const hours = parseInt(document.getElementById('cle-hours').value, 10) || 0;
  const minutes = parseInt(document.getElementById('cle-minutes').value, 10) || 0;
  const estimatedMinutes = hours * 60 + minutes;

  if (!label || !label.trim()) { errorEl.textContent = 'Enter what broad thing this was.'; return; }
  if (!date) { errorEl.textContent = 'Choose a date.'; return; }
  if (!Number.isInteger(estimatedMinutes) || estimatedMinutes < 1) {
    errorEl.textContent = 'Enter an approximate duration greater than zero.';
    return;
  }
  if (estimatedMinutes > 1440) { errorEl.textContent = 'A single day can be at most 24h.'; return; }

  try {
    repository().save({
      date,
      timezone: resolveAccountingTimezone(),
      label,
      estimatedMinutes,
      previousId: _editingId
    });
  } catch (err) {
    errorEl.textContent = err.message || 'Could not save that approximate activity.';
    return;
  }

  closeCoarseEvidenceEditor();
  if (typeof window.showToast === 'function') window.showToast(`Saved ~${fmtDur(estimatedMinutes)} · ${label.trim()}`);
  renderCoarseEvidenceList(_listDateKey || date);
}

export function deleteCoarseEvidenceRecord(id, dateKey) {
  const record = repository().get(id);
  repository().remove(id);
  closeCoarseEvidenceEditor();
  if (record && typeof window.showToast === 'function') window.showToast(`Removed ${record.label}`);
  renderCoarseEvidenceList(dateKey);
}

// Edit/Remove carry a record id derived from free-text (identity is date+label — see
// coarse-life-evidence-model.js). It must never be interpolated into an inline `onclick`
// JS-string context (a label containing a quote could break out and execute arbitrary
// script). `data-cle-id` keeps it in a plain, escaped HTML-attribute context instead —
// the browser round-trips it back to the exact original string via getAttribute(), with
// no JS evaluation involved — and one delegated listener (assigned as a property, so a
// re-render never accumulates duplicate listeners) dispatches the click.
function handleCoarseEvidenceListClick(event) {
  const button = event.target.closest('[data-cle-id]');
  if (!button) return;
  const id = button.getAttribute('data-cle-id');
  const action = button.getAttribute('data-cle-action');
  if (action === 'edit') editCoarseEvidenceRecord(id);
  else if (action === 'remove') removeCoarseEvidenceRecord(id);
}

/** Read-only list + "add" entry point, mounted inside Review. Never renders a timeline block. */
export function renderCoarseEvidenceList(dateKey) {
  const root = document.getElementById('rv-coarse-evidence');
  if (!root) return;
  _listDateKey = dateKey;

  let records = [];
  let totalEstimatedMinutes = 0;
  let unavailable = false;
  try {
    ({ records, totalEstimatedMinutes } = repository().listForDate(dateKey));
  } catch {
    // A corrupted coarse-evidence store must never block Review itself from opening —
    // degrade this optional widget only, never let the exception propagate to openReview().
    unavailable = true;
  }

  if (unavailable) {
    root.innerHTML = '<div style="font-size:12px;color:var(--muted)">Approximate activities unavailable on this device.</div>';
    root.onclick = null;
    return;
  }

  const rows = records.map(r => `
    <div class="cle-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border2)">
      <div style="min-width:0">
        <div style="font-size:12px;color:var(--text)">${escapeHtml(r.label)}</div>
        <div style="font-size:11px;color:var(--muted)">~${fmtDur(r.estimatedMinutes)} · Approx.</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn sm ghost" data-cle-action="edit" data-cle-id="${escapeHtml(r.id)}">Edit</button>
        <button type="button" class="btn sm ghost" data-cle-action="remove" data-cle-id="${escapeHtml(r.id)}">Remove</button>
      </div>
    </div>`).join('');

  const summary = records.length
    ? `<div style="font-size:11px;color:var(--muted);margin-top:6px">Approximate activities: ~${fmtDur(totalEstimatedMinutes)} total · shown separately from recorded intervals</div>`
    : '';

  root.innerHTML = `
    <label style="display:block;margin-bottom:6px">Approximate life activity <span class="note">(optional — roughly how much, not when)</span></label>
    ${rows || '<div style="font-size:12px;color:var(--muted)">None added for this day.</div>'}
    ${summary}
    <button type="button" class="btn sm ghost" style="margin-top:8px" onclick="addCoarseEvidenceRecord()">+ Add approximate activity</button>
  `;
  root.onclick = handleCoarseEvidenceListClick;
}

function addCoarseEvidenceRecord() {
  openCoarseEvidenceEditor(_listDateKey);
}
function editCoarseEvidenceRecord(id) {
  openCoarseEvidenceEditor(_listDateKey, id);
}
function removeCoarseEvidenceRecord(id) {
  deleteCoarseEvidenceRecord(id, _listDateKey);
}

if (typeof window !== 'undefined') {
  window.openCoarseEvidenceEditor = openCoarseEvidenceEditor;
  window.closeCoarseEvidenceEditor = closeCoarseEvidenceEditor;
  window.saveCoarseEvidenceEditor = saveCoarseEvidenceEditor;
  window.deleteCoarseEvidenceRecord = deleteCoarseEvidenceRecord;
  window.renderCoarseEvidenceList = renderCoarseEvidenceList;
  window.addCoarseEvidenceRecord = addCoarseEvidenceRecord;
  window.editCoarseEvidenceRecord = editCoarseEvidenceRecord;
  window.removeCoarseEvidenceRecord = removeCoarseEvidenceRecord;
}
