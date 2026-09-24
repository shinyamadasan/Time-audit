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
import { appRoomOwner } from './personal-day-boundary-repository.js';

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

// ── account ownership (Cross-Store Account Isolation V1) ─────────────────────
//
// The editor and the mounted list act on ONE account's cache. After a direct account switch
// (A -> B, no reload) a closed editor used to keep A's record in its inputs, with focus still
// inside it: keyboard Save then wrote A's record into B's slot and B's room, because by then it
// was a genuine B write as far as the repository and bridge could tell. So each editor session
// and each rendered list is bound to the room that was joined when it was opened/rendered (the
// canonical appRoomOwner(), not a second identity), and nothing it does persists unless that
// room is still the joined one. Closing the editor (Cancel, save, or an account rebind — the sync
// bridge calls closeCoarseEvidenceEditor() then) also clears every field and moves focus out.
const EDITOR_FIELD_IDS = ['cle-label', 'cle-hours', 'cle-minutes', 'cle-date'];
let _editorOwner = null; // room the open editor session belongs to; null = no live session
let _listOwner = null;   // room the mounted list was rendered for

/** A session may persist only while the room it was opened under is still the joined room.
 *  No owner (nothing joined when it opened, or a closed/invalidated session) never matches. */
export function editorSessionMayWrite(sessionOwner, currentOwner) {
  return typeof sessionOwner === 'string' && sessionOwner !== '' && sessionOwner === currentOwner;
}

function currentOwner() {
  return appRoomOwner();
}

/** Opens the add/edit modal. Pass `recordId` to edit an existing record. */
export function openCoarseEvidenceEditor(dateKey, recordId = null) {
  const overlay = document.getElementById('coarse-evidence-overlay');
  if (!overlay) return;
  _listDateKey = dateKey;
  _editingId = recordId || null;
  _editorOwner = currentOwner();
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

/** Closes the editor AND ends its session: no record identity, no field values, no focus left
 *  inside it. A closed overlay is only visually hidden (it stays in the DOM, keyboard-reachable),
 *  so hiding alone is never relied on. */
export function closeCoarseEvidenceEditor() {
  const overlay = document.getElementById('coarse-evidence-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    if (overlay.contains(document.activeElement) && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  }
  _editingId = null;
  _editorOwner = null;
  EDITOR_FIELD_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const title = document.getElementById('cle-title');
  if (title) title.textContent = 'Add approximate activity';
  const errorEl = document.getElementById('cle-error');
  if (errorEl) errorEl.textContent = '';
}

export function saveCoarseEvidenceEditor() {
  const errorEl = document.getElementById('cle-error');
  errorEl.textContent = '';
  // Fails closed BEFORE reading any field: a session opened under another account (or one already
  // closed) never persists, whatever its inputs still hold.
  const owner = currentOwner();
  if (!owner) {
    errorEl.textContent = 'Sign in to save approximate activities — no account is active on this device.';
    return;
  }
  if (!editorSessionMayWrite(_editorOwner, owner)) {
    const stale = _editorOwner !== null;
    closeCoarseEvidenceEditor();
    if (stale && typeof window.showToast === 'function') window.showToast('The account changed — nothing was saved.');
    return;
  }
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

  const previousId = _editingId;
  let saved;
  try {
    saved = repository().save({
      date,
      timezone: resolveAccountingTimezone(),
      label,
      estimatedMinutes,
      previousId
    });
  } catch (err) {
    errorEl.textContent = err.message || 'Could not save that approximate activity.';
    return;
  }

  closeCoarseEvidenceEditor();
  if (typeof window.showToast === 'function') window.showToast(`Saved ~${fmtDur(estimatedMinutes)} · ${label.trim()}`);
  renderCoarseEvidenceList(_listDateKey || date);
  pushToDurableSync(saved, previousId);
}

export function deleteCoarseEvidenceRecord(id, dateKey) {
  const record = repository().get(id);
  const removed = repository().remove(id);
  closeCoarseEvidenceEditor();
  if (record && typeof window.showToast === 'function') window.showToast(`Removed ${record.label}`);
  renderCoarseEvidenceList(dateKey);
  if (removed && window.CoarseLifeEvidenceSync) {
    const tombstone = repository().getRaw(id);
    if (tombstone) window.CoarseLifeEvidenceSync.pushRecord(tombstone);
  }
}

// Durability V1 — best-effort remote push after a local save. A rename/date-move also
// tombstones the record's old identity locally (see repository.save()); that tombstone must
// be pushed too, or a durable remote copy under the old id would never learn the rename and
// could later resurrect the stale old-named record on another device.
function pushToDurableSync(saved, previousId) {
  if (!window.CoarseLifeEvidenceSync) return;
  window.CoarseLifeEvidenceSync.pushRecord(saved);
  if (previousId && previousId !== saved.id) {
    const oldTombstone = repository().getRaw(previousId);
    if (oldTombstone) window.CoarseLifeEvidenceSync.pushRecord(oldTombstone);
  }
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
  _listOwner = currentOwner();

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
// List actions carry a record id rendered for _listOwner's account: acted on only while that
// account is still the joined one (a stale list is re-rendered instead).
function editCoarseEvidenceRecord(id) {
  if (!editorSessionMayWrite(_listOwner, currentOwner())) { refreshCoarseEvidenceListIfMounted(); return; }
  openCoarseEvidenceEditor(_listDateKey, id);
}
function removeCoarseEvidenceRecord(id) {
  if (!editorSessionMayWrite(_listOwner, currentOwner())) { refreshCoarseEvidenceListIfMounted(); return; }
  deleteCoarseEvidenceRecord(id, _listDateKey);
}

// Durability V1 — called by coarse-life-evidence-sync.js after a remote merge changes local
// data, so an open Review reflects another device's edit without the user doing anything.
// A no-op whenever the list isn't currently mounted (Review closed / never opened this
// session) — there is nothing to refresh, and this must never itself open or focus Review.
export function refreshCoarseEvidenceListIfMounted() {
  const root = document.getElementById('rv-coarse-evidence');
  if (root && _listDateKey) renderCoarseEvidenceList(_listDateKey);
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
  window.refreshCoarseEvidenceListIfMounted = refreshCoarseEvidenceListIfMounted;
}
