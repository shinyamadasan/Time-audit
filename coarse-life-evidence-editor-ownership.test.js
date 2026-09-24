// coarse-life-evidence-editor-ownership.test.js
//
// Cross-Store Account Isolation V1 (FIX FIRST). The coarse-evidence editor is bound to the account
// room it was opened under. Before this fix a closed editor was only visually hidden: after a direct
// A -> B switch its inputs still held A's record with focus inside, and keyboard Save wrote that record
// into B's slot and B's room (reproduced in a real browser; see tests/cross-store-account-isolation.spec.js).
//
// These tests drive the REAL coarse-life-evidence-ui.js module against a minimal fake DOM, so the
// ownership guard is tested independently of CSS and of the sync bridge's rebind notification:
// the save path itself must refuse a session opened under another account, even if nothing closed it.
//
// No Firebase, no network, no production data.

import test from 'node:test';
import assert from 'node:assert/strict';

import { coarseEvidenceCacheKeyForRoom } from './coarse-life-evidence-repository.js';

const ROOM_A = 'uid_account-a';
const ROOM_B = 'uid_account-b';
const DATE = '2026-09-23';

// ── a minimal DOM: just the elements the editor and list touch ──────────────
const storage = (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k), _m: m }; })();
const auth = { room: '' };
const toasts = [];
const body = { id: 'body' };
const doc = { activeElement: body, elements: new Map() };
function element(id, { inOverlay = false } = {}) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', onclick: null, _inOverlay: inOverlay,
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    focus() { doc.activeElement = el; },
    blur() { if (doc.activeElement === el) doc.activeElement = body; },
  };
  doc.elements.set(id, el);
  return el;
}
const overlay = element('coarse-evidence-overlay');
overlay.contains = el => !!el && el._inOverlay === true;
['cle-title', 'cle-label', 'cle-hours', 'cle-minutes', 'cle-date', 'cle-error'].forEach(id => element(id, { inOverlay: true }));
element('rv-coarse-evidence');

globalThis.localStorage = storage;
globalThis.getChronaSenseRoomCode = () => auth.room;
globalThis.document = { getElementById: id => doc.elements.get(id) || null, get activeElement() { return doc.activeElement; } };
globalThis.window = globalThis;
globalThis.showToast = message => toasts.push(message);
storage.setItem('ta3-tz', 'Asia/Manila');

const ui = await import('./coarse-life-evidence-ui.js');
const field = id => doc.elements.get(id).value;
const setFields = values => Object.entries(values).forEach(([id, v]) => { doc.elements.get(id).value = v; });
const slot = room => Object.values(JSON.parse(storage.getItem(coarseEvidenceCacheKeyForRoom(room)) || '{"records":{}}').records).filter(r => !r.deleted).map(r => r.label).sort();

function reset() {
  storage._m.clear();
  storage.setItem('ta3-tz', 'Asia/Manila');
  toasts.length = 0;
  auth.room = '';
  ui.closeCoarseEvidenceEditor();
}

function seedA(label = 'A-private therapy', minutes = 75) {
  auth.room = ROOM_A;
  ui.openCoarseEvidenceEditor(DATE);
  setFields({ 'cle-label': label, 'cle-hours': String(Math.floor(minutes / 60)), 'cle-minutes': String(minutes % 60) });
  ui.saveCoarseEvidenceEditor();
  return `${DATE}::${label.toLowerCase()}`;
}

test('editorSessionMayWrite: only a live session whose opening room is the joined room may write', () => {
  assert.equal(ui.editorSessionMayWrite(ROOM_A, ROOM_A), true);
  assert.equal(ui.editorSessionMayWrite(ROOM_A, ROOM_B), false);
  assert.equal(ui.editorSessionMayWrite(ROOM_A, null), false);
  assert.equal(ui.editorSessionMayWrite(null, ROOM_A), false, 'no owner is never proof');
  assert.equal(ui.editorSessionMayWrite('', ''), false);
  assert.equal(ui.editorSessionMayWrite(null, null), false);
});

test('a stale EDIT session opened under A refuses to save under B even if nothing closed it (save-side defence)', () => {
  reset();
  const id = seedA();
  ui.openCoarseEvidenceEditor(DATE, id);
  assert.equal(field('cle-label'), 'A-private therapy');

  auth.room = ROOM_B; // direct switch; deliberately NO close/rebind — the stale inputs survive
  ui.saveCoarseEvidenceEditor();

  assert.deepEqual(slot(ROOM_B), [], 'zero local B writes');
  assert.deepEqual(slot(ROOM_A), ['A-private therapy'], 'A untouched');
  assert.equal(overlay.classList.contains('open'), false, 'the stale session was ended');
  assert.equal(field('cle-label'), '', 'and its A values cleared');
  assert.match(toasts.at(-1), /account changed/i);
});

test('a stale ADD session with unsaved A-side values refuses to save under B', () => {
  reset();
  auth.room = ROOM_A;
  ui.openCoarseEvidenceEditor(DATE);
  setFields({ 'cle-label': 'A-unsaved note', 'cle-hours': '2', 'cle-minutes': '0' });
  auth.room = ROOM_B;
  ui.saveCoarseEvidenceEditor();
  assert.deepEqual(slot(ROOM_B), []);
  assert.deepEqual(slot(ROOM_A), []);
});

test('closing (Cancel, or the account-rebind close) ends the session: fields cleared, focus moved out, later save refused', () => {
  reset();
  const id = seedA();
  ui.openCoarseEvidenceEditor(DATE, id);
  doc.elements.get('cle-label').focus();
  assert.equal(overlay.contains(doc.activeElement), true);

  ui.closeCoarseEvidenceEditor();
  assert.equal(overlay.contains(doc.activeElement), false, 'focus is not left inside the hidden editor');
  assert.deepEqual(['cle-label', 'cle-hours', 'cle-minutes', 'cle-date'].map(field), ['', '', '', '']);
  assert.equal(doc.elements.get('cle-title').textContent, 'Add approximate activity');

  // Even with the same account and values forced back in, a closed session never persists.
  setFields({ 'cle-label': 'A-private therapy', 'cle-hours': '9', 'cle-minutes': '0', 'cle-date': DATE });
  ui.saveCoarseEvidenceEditor();
  assert.equal(JSON.parse(storage.getItem(coarseEvidenceCacheKeyForRoom(ROOM_A))).records[id].estimatedMinutes, 75);
});

test('normal use is unaffected: a session opened under B saves into B only', () => {
  reset();
  seedA();
  auth.room = ROOM_B;
  ui.openCoarseEvidenceEditor(DATE);
  setFields({ 'cle-label': 'B-own walk', 'cle-hours': '0', 'cle-minutes': '30' });
  ui.saveCoarseEvidenceEditor();
  assert.deepEqual(slot(ROOM_B), ['B-own walk']);
  assert.deepEqual(slot(ROOM_A), ['A-private therapy']);
});

test('signed out: save keeps the existing sign-in message and writes nothing', () => {
  reset();
  ui.openCoarseEvidenceEditor(DATE);
  setFields({ 'cle-label': 'x', 'cle-minutes': '10' });
  ui.saveCoarseEvidenceEditor();
  assert.match(doc.elements.get('cle-error').textContent, /Sign in/);
  assert.equal([...storage._m.keys()].some(k => k.startsWith('ta3-coarse-life-evidence-v1')), false);
});

test('list actions rendered for A do nothing under B — even when B has a record with the SAME id (ids are date::label)', () => {
  reset();
  // B logged the same broad activity on the same day, so both accounts hold `2026-09-23::household`.
  auth.room = ROOM_B;
  ui.openCoarseEvidenceEditor(DATE);
  setFields({ 'cle-label': 'Household', 'cle-hours': '0', 'cle-minutes': '40' });
  ui.saveCoarseEvidenceEditor();
  const id = seedA('Household', 90);
  ui.renderCoarseEvidenceList(DATE); // A's list, showing A's Household row

  auth.room = ROOM_B; // direct switch before the list was re-rendered
  window.removeCoarseEvidenceRecord(id); // a click on A's stale Remove button
  assert.deepEqual(slot(ROOM_B), ['Household'], 'B’s own same-id record was not removed by A’s stale row');

  auth.room = ROOM_A;
  ui.renderCoarseEvidenceList(DATE); // A's list again
  auth.room = ROOM_B;
  window.editCoarseEvidenceRecord(id); // a click on A's stale Edit button
  assert.equal(overlay.classList.contains('open'), false, 'no editor opened from a row rendered for A');

  auth.room = ROOM_A;
  assert.deepEqual(slot(ROOM_A), ['Household'], 'A record not removed');
});
