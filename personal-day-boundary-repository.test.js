import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalDayBoundaryRepository, PERSONAL_DAY_BOUNDARY_SCHEMA_VERSION } from './personal-day-boundary-repository.js';
import { isLegacyOperationalDay, operationalDayContaining, LEGACY_CALENDAR_DAY_REVISION_ID } from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };
let seq = 0;
const seqIds = () => `id-${++seq}`;

function repo(overrides = {}) {
  return createPersonalDayBoundaryRepository({ storage: memory(), idGenerator: seqIds, ...overrides });
}

// ── absence (§3) ─────────────────────────────────────────────────────────

test('status() reports absent for a never-touched user; read() never writes anything', () => {
  const storage = memory();
  const r = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds });
  assert.deepEqual(r.status(), { status: 'absent' });
  const revisions = r.read(MANILA);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].effectiveFromInstant, null);
  assert.equal(revisions[0].timezone, MANILA);
  assert.equal(storage.getItem(r.key), null); // read() never persists — §3
  assert.deepEqual(r.status(), { status: 'absent' }); // still absent after read()
});

test('an absent user is legacy at every instant, matching operationalDayContaining directly', () => {
  const r = repo();
  const revisions = r.read(MANILA);
  const ref = operationalDayContaining(Date.now(), revisions);
  assert.equal(isLegacyOperationalDay(ref, revisions), true);
});

// ── first custom boundary (§4) ──────────────────────────────────────────

test('propose() on an absent user creates the legacy anchor AND the candidate as one atomic write', () => {
  const r = repo();
  const nowMs = Date.parse('2026-09-14T00:30:00Z'); // 08:30 Asia/Manila per the product case
  const { revision, revisions } = r.propose({ boundaryTime: '18:00', timezone: MANILA }, nowMs);
  assert.equal(revisions.length, 2);
  assert.ok(revisions.some(rv => rv.effectiveFromInstant === null)); // legacy anchor present
  assert.equal(revision.boundaryTime, '18:00');
  assert.equal(revision.timezone, MANILA);
  const status = r.status();
  assert.equal(status.status, 'custom');
  assert.equal(status.revisions.length, 2);
});

test('the product case: Monday 08:30 Asia/Manila proposing 18:00 activates Monday 18:00, not Tuesday', () => {
  const r = repo();
  const nowMs = Date.parse('2026-09-14T00:30:00Z'); // Monday 08:30 Manila (UTC+8)
  const { revision } = r.propose({ boundaryTime: '18:00', timezone: MANILA }, nowMs);
  const activatesAt = new Intl.DateTimeFormat('en-CA', { timeZone: MANILA, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(revision.effectiveFromInstant));
  assert.equal(activatesAt, '2026-09-14, 18:00');
});

test('propose() canonicalizes a timezone alias before it ever reaches storage', () => {
  const r = repo();
  r.propose({ boundaryTime: '18:00', timezone: 'US/Eastern' }, Date.parse('2026-09-14T12:00:00Z'));
  const { revisions } = r.status();
  assert.ok(revisions.every(rv => rv.timezone === 'America/New_York'));
});

test('earlier events/plans retain legacy semantics — a past instant resolves under the anchor, not the new revision', () => {
  const r = repo();
  const nowMs = Date.parse('2026-09-14T00:30:00Z');
  r.propose({ boundaryTime: '18:00', timezone: MANILA }, nowMs);
  const revisions = r.status().revisions;
  const past = operationalDayContaining(Date.parse('2026-09-01T00:00:00Z'), revisions);
  assert.equal(isLegacyOperationalDay(past, revisions), true);
});

// ── malformed/invalid persisted state (§18) ─────────────────────────────

test('status() reports invalid, never absent or legacy, for corrupted storage', () => {
  const storage = memory();
  storage.setItem('ta3-day-boundary-revisions-v1', 'not json');
  const r = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds });
  const status = r.status();
  assert.equal(status.status, 'invalid');
  assert.ok(status.error);
  assert.throws(() => r.read(MANILA));
});

test('status() reports invalid for a persisted history missing its anchor', () => {
  const storage = memory();
  storage.setItem('ta3-day-boundary-revisions-v1', JSON.stringify({
    schemaVersion: PERSONAL_DAY_BOUNDARY_SCHEMA_VERSION,
    revisions: { r1: { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: 12345678 } }
  }));
  const r = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds });
  assert.equal(r.status().status, 'invalid');
});

// ── multi-device merge safety (§5, §6, §21) ──────────────────────────────

test('mergeRemoteRevisions unions distinct revisions from two devices — arrival order does not matter', () => {
  const storage = memory();
  const r = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds });
  const anchor = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: null };
  const revA = { id: 'device-a', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: Date.parse('2026-09-14T10:00:00Z') };
  const revB = { id: 'device-b', boundaryTime: '16:00', timezone: MANILA, effectiveFromInstant: Date.parse('2026-09-20T08:00:00Z') };
  const remote1 = { [anchor.id]: anchor, [revA.id]: revA };
  const result1 = r.mergeRemoteRevisions(remote1);
  assert.equal(result1.changed, true);
  assert.deepEqual(result1.changedIds.sort(), [anchor.id, revA.id].sort());
  const remote2 = { [anchor.id]: anchor, [revA.id]: revA, [revB.id]: revB };
  const result2 = r.mergeRemoteRevisions(remote2);
  assert.equal(result2.changed, true);
  assert.deepEqual(result2.changedIds, [revB.id]);
  const status = r.status();
  assert.equal(status.revisions.length, 3);
});

test('mergeRemoteRevisions rejects (never overwrites) a same-id revision with conflicting facts', () => {
  const storage = memory();
  const r = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds });
  const nowMs = Date.parse('2026-09-14T00:30:00Z');
  const { revision: local } = r.propose({ boundaryTime: '18:00', timezone: MANILA }, nowMs);
  const conflicting = { ...local, boundaryTime: '17:00' }; // same id, different fact
  const result = r.mergeRemoteRevisions({ [local.id]: conflicting });
  assert.equal(result.changed, false);
  assert.deepEqual(result.rejectedIds, [local.id]);
  const status = r.status();
  assert.ok(status.revisions.find(rv => rv.id === local.id).boundaryTime === '18:00'); // untouched
});

test('mergeRemoteRevisions skips a structurally malformed remote revision without throwing', () => {
  const r = repo();
  const result = r.mergeRemoteRevisions({ bad: { id: 'bad', boundaryTime: '99:99', timezone: MANILA, effectiveFromInstant: 1 } });
  assert.equal(result.changed, false);
  assert.deepEqual(result.rejectedIds, ['bad']);
});

test('mergeRemoteRevisions writes nothing (reports a conflict) when the union would collide on effectiveFromInstant', () => {
  const storage = memory();
  const r = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds });
  const anchor = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: null };
  const sameInstant = Date.parse('2026-09-14T10:00:00Z');
  r.mergeRemoteRevisions({ [anchor.id]: anchor, a: { id: 'a', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: sameInstant } });
  const before = r.status();
  const result = r.mergeRemoteRevisions({ b: { id: 'b', boundaryTime: '16:00', timezone: MANILA, effectiveFromInstant: sameInstant } });
  assert.equal(result.changed, false);
  assert.ok(result.conflict);
  assert.deepEqual(r.status(), before); // nothing written
});

// ── concurrent-proposal semantic deduplication / identity reconciliation ────
// (§3, §4, §5 of the boundary-sync atomicity contract)

test('mergeRemoteRevisions adopts the remote canonical id and drops the local losing id when remote wins', () => {
  const storage = memory();
  const r = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds });
  const t = Date.parse('2026-09-14T10:00:00Z');
  // Local device independently proposed the same fact under a LARGER id.
  r.mergeRemoteRevisions({ [LEGACY_CALENDAR_DAY_REVISION_ID]: { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: null }, 'zzz-local': { id: 'zzz-local', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: t } });
  assert.equal(r.status().revisions.length, 2);
  // Remote now (from another device) canonicalizes the SAME fact under a
  // SMALLER id — the deterministic winner.
  const result = r.mergeRemoteRevisions({ 'aaa-remote': { id: 'aaa-remote', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: t } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.changedIds, ['aaa-remote']);
  assert.deepEqual(result.droppedIds, ['zzz-local']);
  const ids = r.status().revisions.map(rv => rv.id).sort();
  assert.deepEqual(ids, ['aaa-remote', LEGACY_CALENDAR_DAY_REVISION_ID].sort());
});

test('mergeRemoteRevisions ignores a remote losing-id duplicate when the local id already IS canonical', () => {
  const storage = memory();
  const r = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds });
  const t = Date.parse('2026-09-14T10:00:00Z');
  r.mergeRemoteRevisions({ [LEGACY_CALENDAR_DAY_REVISION_ID]: { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: null }, 'aaa-local': { id: 'aaa-local', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: t } });
  const result = r.mergeRemoteRevisions({ 'zzz-remote': { id: 'zzz-remote', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: t } });
  assert.equal(result.changed, false); // nothing to adopt — our own id already wins
  assert.deepEqual(result.droppedIds, []);
  const ids = r.status().revisions.map(rv => rv.id).sort();
  assert.deepEqual(ids, ['aaa-local', LEGACY_CALENDAR_DAY_REVISION_ID].sort()); // zzz-remote never adopted
});

test('mergeRemoteRevisions still hard-rejects a genuine contradiction sharing an effective instant under different immutable facts (not deduplication)', () => {
  const storage = memory();
  const r = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds });
  const t = Date.parse('2026-09-14T10:00:00Z'); // 18:00 Asia/Manila == 06:00 America/New_York
  r.mergeRemoteRevisions({ [LEGACY_CALENDAR_DAY_REVISION_ID]: { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: null }, a: { id: 'a', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: t } });
  const before = r.status();
  const result = r.mergeRemoteRevisions({ b: { id: 'b', boundaryTime: '06:00', timezone: 'America/New_York', effectiveFromInstant: t } });
  assert.equal(result.changed, false);
  assert.ok(result.conflict);
  assert.deepEqual(r.status(), before); // nothing written — a genuine contradiction, never a favorite picked
});

test('listAllRaw returns every persisted revision for sync push, empty for an absent user', () => {
  const r = repo();
  assert.deepEqual(r.listAllRaw(), []);
  r.propose({ boundaryTime: '18:00', timezone: MANILA }, Date.parse('2026-09-14T00:30:00Z'));
  assert.equal(r.listAllRaw().length, 2);
});

// ── reset to midnight is a new revision, never a deletion (§22) ─────────

test('resetting to midnight is proposing a 00:00 revision, not deleting history', () => {
  const r = repo();
  const t1 = Date.parse('2026-09-14T00:30:00Z');
  r.propose({ boundaryTime: '18:00', timezone: MANILA }, t1);
  const t2 = Date.parse('2026-10-01T00:30:00Z');
  const { revision } = r.propose({ boundaryTime: '00:00', timezone: MANILA }, t2);
  assert.equal(revision.boundaryTime, '00:00');
  assert.equal(revision.effectiveFromInstant !== null, true); // NOT the anchor — a real, later revision
  const status = r.status();
  assert.equal(status.revisions.length, 3); // anchor + 18:00 revision + reset revision, all preserved
});
