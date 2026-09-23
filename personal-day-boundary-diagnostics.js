// personal-day-boundary-diagnostics.js
//
// A read-only, screenshot-friendly view of the Personal Day sync state on THIS device, opened only with
// `?pdbdiag=1` on the app URL (index.html loads this module lazily and only then). It exists so the
// state of a real phone can be read from one screenshot instead of remote DevTools.
//
// It writes nothing (no storage, no Firebase, no revisions) and prints no secrets: never a uid, token,
// Firebase key, email, revision id or revision contents. Identity is only ever shown as a short SHA-256
// fingerprint (equal on two devices <=> same account / same Firebase project), and everything else is a
// yes/no, a count, an HH:MM or a module file name.

import { boundaryCacheKeyForRoom, appRoomOwner, PERSONAL_DAY_BOUNDARY_STORAGE_KEY } from './personal-day-boundary-repository.js';

const MODULE_PATTERN = /(personal-day-boundary-[a-z]+|operational-plan-[a-z]+|plan-authority)\.js|\/storage\.js/;

async function fingerprint(label, value) {
  try {
    if (!value || !globalThis.crypto?.subtle) return 'n/a';
    const bytes = new globalThis.TextEncoder().encode(`pdb-diag:${label}:${value}`);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'n/a';
  }
}

function countRevisions(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return 'none';
    return String(Object.keys(JSON.parse(raw).revisions || {}).length);
  } catch {
    return 'unreadable';
  }
}

function releaseOf(html) {
  const match = /name="pdb-release"\s+content="([^"]+)"/.exec(html || '');
  return match ? match[1] : null;
}

/** Module URLs this page actually loaded: file + whether it carried a ?v= release and whether it came
 *  from the HTTP cache (transferSize 0) — the evidence for a mixed / stale module graph. */
function loadedModules() {
  const rows = [];
  for (const entry of globalThis.performance.getEntriesByType('resource')) {
    if (!MODULE_PATTERN.test(entry.name)) continue;
    const url = new URL(entry.name);
    rows.push(`${url.pathname.split('/').pop()} ${url.search ? url.search.replace('?v=', 'v=') : 'UNVERSIONED'} ${entry.transferSize === 0 ? 'cache' : 'net'}`);
  }
  return rows;
}

export async function collectDiagnostics() {
  const live = window.PersonalDayBoundaryLive || null;
  const sync = window.PersonalDayBoundarySync || null;
  const recovery = window.PersonalDayBoundaryRecovery || null;
  const room = appRoomOwner();
  const bridge = sync && typeof sync.diagnostics === 'function' ? sync.diagnostics() : null;
  let boundary = null;
  try { boundary = live ? live.boundaryState() : null; } catch { boundary = null; }
  // Legacy Recovery V2 — categorized counts/booleans ONLY, exactly like every other row here. Never
  // "ownership verified" or "safe owner match": software cannot know that, and never claims to —
  // "attestation required" is a constant reminder of the gate, never a report on whether the owner
  // has actually attested (that is UI state, not a diagnosable fact worth surfacing here).
  let recoveryAnalysis = null;
  try { recoveryAnalysis = recovery ? recovery.status() : null; } catch { recoveryAnalysis = null; }
  const running = document.querySelector('meta[name="pdb-release"]')?.content || 'none';
  let deployed = 'unknown';
  try {
    const response = await fetch(location.pathname, { cache: 'no-store' });
    deployed = releaseOf(await response.text()) || 'unknown';
  } catch { deployed = 'unreachable'; }
  // The compat SDK's app options identify the Firebase project; the room code (`uid_<uid>`) identifies the account.
  let project = null;
  try { const o = globalThis.firebase.app().options; project = o && o.projectId ? `${o.projectId}|${o.databaseURL}` : null; } catch { project = null; }
  let authed = !!room;
  try { authed = authed || !!globalThis.firebase.auth().currentUser; } catch { /* no SDK */ }
  const panel = document.getElementById('personal-day-boundary-settings');
  const uiState = panel?.querySelector('[data-pdb-state]')?.dataset.pdbState || (panel?.textContent.includes('Off.') ? 'off' : (panel ? 'shown' : 'no-panel'));
  let otherSlots = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(`${PERSONAL_DAY_BOUNDARY_STORAGE_KEY}:`) && key !== (room ? boundaryCacheKeyForRoom(room) : null)) otherSlots++;
  }
  return [
    ['release running', running],
    ['release deployed', deployed],
    ['release match', running === deployed ? 'yes' : (deployed === 'unknown' || deployed === 'unreachable' ? 'unknown' : 'NO (stale)')],
    ['import map supported', String(!!(globalThis.HTMLScriptElement && globalThis.HTMLScriptElement.supports && globalThis.HTMLScriptElement.supports('importmap')))],
    ['display mode', (globalThis.matchMedia('(display-mode: standalone)').matches || navigator.standalone) ? 'standalone (PWA)' : 'browser tab'],
    ['mobile UA', /Mobi|Android|iPhone|iPad/.test(navigator.userAgent) ? 'yes' : 'no'],
    ['auth present', authed ? 'yes' : 'no'],
    ['account fingerprint', await fingerprint('account', room)],
    ['firebase project fingerprint', await fingerprint('project', project)],
    ['room identity known', room ? 'yes' : 'no'],
    ['room ref matches identity', (() => { try { const ref = globalThis.getChronaSenseRoomRef(); return ref && room && ref.path ? String(ref.path === `rooms/${room}`) : (ref ? 'ref present' : 'no ref'); } catch { return 'n/a'; } })()],
    ['boundary live attached', String(!!live)],
    ['sync bridge present', String(!!sync)],
    ['listener bound', bridge ? String(bridge.listenerBound) : 'n/a'],
    ['first snapshot received', bridge ? String(bridge.hydrated) : 'n/a'],
    ['sync state', bridge ? bridge.syncState : 'n/a'],
    ['listener error', bridge ? (bridge.listenerError ? `yes (${bridge.listenerErrorCode})` : 'no') : 'n/a'],
    ['remote revisions received', bridge ? String(bridge.remoteRevisionCount) : 'n/a'],
    ['remote rejected / conflict', bridge ? `${bridge.remoteRejectedCount} / ${bridge.remoteConflict ? 'yes' : 'no'}` : 'n/a'],
    ['remote unapplied', bridge ? String(bridge.remoteUnapplied) : 'n/a'],
    ['remote incomplete (anchor-only)', bridge ? String(bridge.remoteIncomplete) : 'n/a'],
    ['cache owner matches room', bridge ? String(bridge.cacheOwnerMatchesRoom) : 'n/a'],
    ['this account cache revisions', room ? countRevisions(boundaryCacheKeyForRoom(room)) : 'no room'],
    ['other accounts cache slots', String(otherSlots)],
    ['old unowned cache revisions', countRevisions(PERSONAL_DAY_BOUNDARY_STORAGE_KEY)],
    // Legacy Recovery V2 — compatibility facts only (counts/booleans/a reason label). Never a
    // provenance claim: no "ownership verified", no "safe owner match".
    ['legacy history present', recoveryAnalysis?.legacy ? String(recoveryAnalysis.legacy.totalCount > 0) : 'n/a'],
    ['legacy history validates', recoveryAnalysis?.legacy ? String(recoveryAnalysis.legacy.valid) : 'n/a'],
    ['remote compatibility', recoveryAnalysis ? String(recoveryAnalysis.compatible) : 'n/a'],
    ['attestation required', recoveryAnalysis?.compatible ? 'yes' : 'n/a'],
    ['effective boundary', boundary && boundary.active ? boundary.active.boundaryTime : (boundary ? `none (${boundary.status})` : 'n/a')],
    ['plan authority enabled', window.PlanAuthority ? String(window.PlanAuthority.enabled()) : 'not loaded'],
    ['settings UI state', uiState],
    ['modules loaded', loadedModules().join(' | ') || 'n/a'],
  ];
}

export async function showDiagnostics() {
  document.getElementById('pdb-diagnostics')?.remove();
  const box = document.createElement('div');
  box.id = 'pdb-diagnostics';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Personal day sync diagnostics');
  box.style.cssText = 'position:fixed;inset:8px;z-index:2147483000;overflow:auto;background:#0b0b0c;color:#e8e8ea;border:1px solid #4cc7f0;border-radius:10px;padding:12px;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace';
  box.textContent = 'Collecting…';
  document.body.appendChild(box);
  const rows = await collectDiagnostics();
  box.textContent = '';
  const title = document.createElement('div');
  title.textContent = 'Personal day sync diagnostics (read-only, no identity shown)';
  title.style.cssText = 'font-weight:700;margin-bottom:8px';
  box.appendChild(title);
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.style.cssText = 'border-top:1px solid #26262a;padding:3px 0;word-break:break-word';
    const key = document.createElement('span');
    key.textContent = `${label}: `;
    key.style.color = '#9aa0a6';
    const val = document.createElement('span');
    val.textContent = value;
    row.append(key, val);
    box.appendChild(row);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.style.cssText = 'margin-top:10px;padding:6px 14px';
  close.addEventListener('click', () => box.remove());
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = 'Refresh';
  refresh.style.cssText = 'margin:10px 8px 0 0;padding:6px 14px';
  refresh.addEventListener('click', () => { showDiagnostics(); });
  box.append(refresh, close);
  return rows;
}

if (typeof window !== 'undefined') {
  window.showPersonalDayDiagnostics = showDiagnostics;
  showDiagnostics();
}
