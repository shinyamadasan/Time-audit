import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationalPlanRepository, OPERATIONAL_PLAN_STORAGE_KEY } from './operational-plan-repository.js';
import {
  legacyBoundaryRevision, proposeBoundaryRevision, operationalDayContaining, operationalDayId,
} from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };

function eighteenHundredHistory() {
  const legacy = legacyBoundaryRevision(MANILA);
  const nowMs = Date.parse('2026-09-14T00:30:00Z');
  return proposeBoundaryRevision([legacy], { id: 'r-1800', boundaryTime: '18:00', timezone: MANILA }, nowMs).revisions;
}

function mondayOperationalDay() {
  const revisions = eighteenHundredHistory();
  const ref = operationalDayContaining(Date.parse('2026-09-14T12:00:00Z'), revisions); // Monday 20:00 Manila
  return { ref, revisions, id: operationalDayId(ref) };
}

function repo() {
  return createOperationalPlanRepository({ storage: memory() });
}

// ── absence is not migration (§13) ──────────────────────────────────────

test('read() for an unknown operationalDayId returns null — no implicit fallback or migration', () => {
  const { id } = mondayOperationalDay();
  const r = repo();
  assert.equal(r.read(id), null);
});

test('read() throws for a structurally invalid operationalDayId rather than silently treating it as a calendar date', () => {
  const r = repo();
  assert.throws(() => r.read('2026-09-14')); // a bare date is never a valid operationalDayId
  assert.throws(() => r.read('not-an-id'));
});

// ── write validates item ranges before mutation (§16, §17) ──────────────

test('write() accepts a cross-midnight item (23:00 -> 01:00) under an 18:00-boundary day', () => {
  const { ref, revisions, id } = mondayOperationalDay();
  const r = repo();
  const written = r.write(id, [{ id: 'p1', task: 'late work', when: '23:00', durationMinutes: 120, updatedAt: 1, updatedBy: 'device-a' }], { updatedBy: 'device-a', ref, revisions });
  assert.equal(written.items[0].when, '23:00');
  assert.deepEqual(r.read(id).items[0], written.items[0]);
});

test('write() rejects an out-of-bounds item (17:30 -> 18:30) and writes nothing', () => {
  const { ref, revisions, id } = mondayOperationalDay();
  const r = repo();
  assert.throws(() => r.write(id, [{ id: 'p1', task: 'bad range', when: '17:30', endClock: '18:30', updatedAt: 1, updatedBy: 'a' }], { updatedBy: 'a', ref, revisions }));
  assert.equal(r.read(id), null); // nothing partially written
});

test('write() rejects one bad item among several and writes NONE of them (atomic)', () => {
  const { ref, revisions, id } = mondayOperationalDay();
  const r = repo();
  const items = [
    { id: 'good', task: 'fine', when: '23:00', durationMinutes: 60, updatedAt: 1, updatedBy: 'a' },
    { id: 'bad', task: 'bad', when: '17:30', endClock: '18:30', updatedAt: 1, updatedBy: 'a' }
  ];
  assert.throws(() => r.write(id, items, { updatedBy: 'a', ref, revisions }));
  assert.equal(r.read(id), null);
});

test('write() accepts untimed items with no range at all', () => {
  const { ref, revisions, id } = mondayOperationalDay();
  const r = repo();
  const written = r.write(id, [{ id: 'p1', task: 'anytime', updatedAt: 1, updatedBy: 'a' }], { updatedBy: 'a', ref, revisions });
  assert.equal(written.items.length, 1);
});

test('write() requires ref+revisions — a caller cannot bypass range validation by omitting them', () => {
  const { id } = mondayOperationalDay();
  const r = repo();
  assert.throws(() => r.write(id, [{ id: 'p1', task: 'x', updatedAt: 1, updatedBy: 'a' }], { updatedBy: 'a' }));
});

// ── preparation scoped to the same day identity (§14) ────────────────────

test('writePreparation() attaches preparation to the SAME record items live in, never a separate store', () => {
  const { ref, revisions, id } = mondayOperationalDay();
  const r = repo();
  r.write(id, [{ id: 'p1', task: 'x', updatedAt: 1, updatedBy: 'a' }], { updatedBy: 'a', ref, revisions });
  const prep = { schemaVersion: 1, targetOperationalDayId: id, firstPreparedAt: 1, firstPreparedMode: 'normal', firstPreparedBy: 'a', lastPreparedAt: 1, lastPreparedMode: 'normal', updatedBy: 'a', intentionalBlank: false, routineInstanceIds: [], oneOffItemIds: ['p1'] };
  r.writePreparation(id, prep);
  const record = r.read(id);
  assert.equal(record.items.length, 1); // items preserved
  assert.deepEqual(record.preparation, prep);
});

// ── independence from the legacy store (§8) ───────────────────────────────

test('this repository has no method that reads or references plans[dateKey] at all', () => {
  const r = repo();
  assert.equal(typeof r.readLegacy, 'undefined');
  assert.equal('plans' in r === false || typeof r.plans !== 'object', true);
});

// ── sync-facing surface ───────────────────────────────────────────────────

test('listAllRaw returns every persisted operational plan, empty when none exist', () => {
  const { ref, revisions, id } = mondayOperationalDay();
  const r = repo();
  assert.deepEqual(r.listAllRaw(), {});
  r.write(id, [{ id: 'p1', task: 'x', updatedAt: 1, updatedBy: 'a' }], { updatedBy: 'a', ref, revisions });
  assert.equal(Object.keys(r.listAllRaw()).length, 1);
});

test('mergeRemote merges per-item, not whole-record replace, and returns changed:false when nothing new arrives', () => {
  const { ref, revisions, id } = mondayOperationalDay();
  const r = repo();
  r.write(id, [{ id: 'p1', task: 'local', updatedAt: 100, updatedBy: 'a' }], { updatedBy: 'a', ref, revisions });
  const remote = { items: [{ id: 'p1', task: 'local', updatedAt: 100, updatedBy: 'a' }], updatedAt: 100, updatedBy: 'a' };
  const result1 = r.mergeRemote(id, remote);
  assert.equal(result1.changed, false); // identical content
  const newerRemote = { items: [{ id: 'p1', task: 'remote wins', updatedAt: 200, updatedBy: 'b' }], updatedAt: 200, updatedBy: 'b' };
  const result2 = r.mergeRemote(id, newerRemote);
  assert.equal(result2.changed, true);
  assert.equal(r.read(id).items[0].task, 'remote wins');
});

test('mergeRemote cannot resurrect a relocated item from an ordinary stale source edit', () => {
  const { ref, revisions, id } = mondayOperationalDay();
  const destination = id.replace('2026-09-14', '2026-09-15');
  const r = repo();
  const relocationRevision = { schemaVersion: 1, sequence: 1, fromDayId: id, toDayId: destination, updatedBy: 'device-a', updatedAt: 100 };
  r.write(id, [{ id: 'p1', task: 'moved', deleted: true, movedToDayId: destination, relocationRevision, updatedAt: 100, updatedBy: 'device-a' }], { updatedBy: 'device-a', ref, revisions });
  r.mergeRemote(id, { items: [{ id: 'p1', task: 'offline stale edit', updatedAt: 999, updatedBy: 'device-z' }], updatedAt: 999, updatedBy: 'device-z' });
  const stored = r.read(id).items[0];
  assert.equal(stored.deleted, true);
  assert.deepEqual(stored.relocationRevision, relocationRevision);
});

// ── malformed storage fails loudly ─────────────────────────────────────

test('a corrupted storage key throws rather than silently returning an empty store', () => {
  const storage = memory();
  storage.setItem(OPERATIONAL_PLAN_STORAGE_KEY, 'not json');
  const r = createOperationalPlanRepository({ storage });
  const { id } = mondayOperationalDay();
  assert.throws(() => r.read(id));
});
