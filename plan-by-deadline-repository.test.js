import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanByDeadlineRepository, PLAN_BY_DEADLINE_SCHEMA_VERSION, scopedCacheKeyForRoom } from './plan-by-deadline-repository.js';

const MANILA = 'Asia/Manila';
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };
let seq = 0;
const seqIds = () => `id-${++seq}`;

function repo(overrides = {}) {
  return createPlanByDeadlineRepository({ storage: memory(), idGenerator: seqIds, ...overrides });
}

// ── absence: unconfigured, not a guessed default ────────────────────────

test('deadlineStatus() reports unconfigured for a never-touched account; readDeadlines() returns [] and never writes', () => {
  const storage = memory();
  const r = createPlanByDeadlineRepository({ storage, idGenerator: seqIds });
  assert.deepEqual(r.deadlineStatus(), { status: 'unconfigured' });
  assert.deepEqual(r.readDeadlines(), []);
  assert.equal(storage.getItem(r.key), null); // read never persists
  assert.deepEqual(r.deadlineStatus(), { status: 'unconfigured' });
});

// ── propose / activation persisted correctly ─────────────────────────────

test('proposeDeadline() on an unconfigured account persists the first-ever revision alone (no anchor)', () => {
  const r = repo();
  const nowMs = Date.parse('2026-09-27T00:00:00Z'); // 08:00 Manila
  const { revision, revisions } = r.proposeDeadline({ deadlineTime: '10:00', timezone: MANILA }, nowMs);
  assert.equal(revisions.length, 1);
  assert.equal(revision.deadlineTime, '10:00');
  assert.equal(revision.effectiveFromInstant, Date.parse('2026-09-27T02:00:00Z')); // 10:00 Manila same day
  const status = r.deadlineStatus();
  assert.equal(status.status, 'configured');
  assert.equal(status.revisions.length, 1);
});

test('proposeDeadline() appends without touching prior revisions', () => {
  const r = repo();
  const first = r.proposeDeadline({ deadlineTime: '10:00', timezone: MANILA }, Date.parse('2026-09-27T00:00:00Z'));
  const second = r.proposeDeadline({ deadlineTime: '07:00', timezone: MANILA }, Date.parse('2026-09-28T00:00:00Z'));
  assert.equal(second.revisions.length, 2);
  const preserved = second.revisions.find(rv => rv.id === first.revision.id);
  assert.deepEqual(preserved, first.revision);
});

test('proposeDeadline() requires an active account', () => {
  const r = createPlanByDeadlineRepository({ storage: memory(), idGenerator: seqIds, getOwner: () => null });
  assert.throws(() => r.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, Date.now()), /No account is active/);
});

// ── account/room scoping ──────────────────────────────────────────────────

test('deadline cache is room-scoped: A and B never see each other\'s deadline', () => {
  const storage = memory();
  let currentRoom = 'room-A';
  const r = createPlanByDeadlineRepository({ storage, idGenerator: seqIds, getOwner: () => currentRoom });
  r.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(r.deadlineStatus().status, 'configured');

  currentRoom = 'room-B';
  assert.deepEqual(r.deadlineStatus(), { status: 'unconfigured' }); // B has nothing

  currentRoom = 'room-A';
  assert.equal(r.deadlineStatus().status, 'configured'); // A's data is untouched
  assert.equal(storage.getItem(scopedCacheKeyForRoom('room-A', r.key)) !== null, true);
  assert.equal(storage.getItem(scopedCacheKeyForRoom('room-B', r.key)), null);
});

// ── merge (remote sync) ────────────────────────────────────────────────────

test('mergeRemoteDeadlines: a remote id local does not have is adopted', () => {
  const r = repo();
  const remote = { id: 'remote-1', deadlineTime: '08:00', effectiveFromInstant: 1000 };
  const result = r.mergeRemoteDeadlines({ 'remote-1': remote });
  assert.equal(result.changed, true);
  assert.deepEqual(r.readDeadlines(), [remote]);
});

test('mergeRemoteDeadlines: a genuine conflicting duplicate id is rejected, not silently overwritten', () => {
  const r = repo();
  r.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, Date.parse('2026-01-01T00:00:00Z'));
  const localId = r.readDeadlines()[0].id;
  const conflicting = { id: localId, deadlineTime: '09:00', effectiveFromInstant: 999999999 };
  const result = r.mergeRemoteDeadlines({ [localId]: conflicting });
  assert.equal(result.changed, false);
  assert.deepEqual(result.rejectedIds, [localId]);
});

test('mergeRemoteDeadlines: semantic duplicates converge on the canonical (lexicographically smaller) id', () => {
  const r = repo();
  r.proposeDeadline({ deadlineTime: '08:00', timezone: MANILA }, Date.parse('2026-01-01T00:00:00Z'));
  const localRevision = r.readDeadlines()[0];
  const remoteSemanticDup = { id: `aaa-${localRevision.id}`, deadlineTime: localRevision.deadlineTime, effectiveFromInstant: localRevision.effectiveFromInstant };
  const result = r.mergeRemoteDeadlines({ [remoteSemanticDup.id]: remoteSemanticDup });
  const idsNow = r.readDeadlines().map(rv => rv.id);
  assert.equal(idsNow.length, 1);
  assert.equal(idsNow[0], [localRevision.id, remoteSemanticDup.id].sort()[0]);
});

// ── intentional off-day ────────────────────────────────────────────────────

test('declareOffDay() creates a record; readOffDay() reflects it; second declare is idempotent', () => {
  const r = repo();
  const rec1 = r.declareOffDay('2026-09-27', 1000);
  assert.deepEqual(rec1, { dateKey: '2026-09-27', declaredAtMs: 1000, revokedAtMs: null });
  const rec2 = r.declareOffDay('2026-09-27', 2000); // already declared -> no-op, keeps original timestamp
  assert.deepEqual(rec2, rec1);
  assert.deepEqual(r.readOffDay('2026-09-27'), rec1);
});

test('revokeOffDay() is reversible before the deadline (§11) and idempotent once revoked', () => {
  const r = repo();
  r.declareOffDay('2026-09-27', 1000);
  const revoked = r.revokeOffDay('2026-09-27', 5000);
  assert.equal(revoked.revokedAtMs, 5000);
  const revokedAgain = r.revokeOffDay('2026-09-27', 9999); // already revoked -> unchanged
  assert.equal(revokedAgain.revokedAtMs, 5000);
});

test('revokeOffDay() on a date with no declaration returns null and writes nothing', () => {
  const r = repo();
  assert.equal(r.revokeOffDay('2026-09-27', 1000), null);
  assert.equal(r.readOffDay('2026-09-27'), null);
});

test('off-day cache is room-scoped, same as the deadline cache', () => {
  const storage = memory();
  let currentRoom = 'room-A';
  const r = createPlanByDeadlineRepository({ storage, idGenerator: seqIds, getOwner: () => currentRoom });
  r.declareOffDay('2026-09-27', 1000);
  currentRoom = 'room-B';
  assert.equal(r.readOffDay('2026-09-27'), null);
  currentRoom = 'room-A';
  assert.ok(r.readOffDay('2026-09-27'));
});

test('mergeRemoteOffDays: earliest declaredAtMs wins; a revoke on either side sticks (never un-merged)', () => {
  const r = repo();
  r.declareOffDay('2026-09-27', 5000);
  const remoteEarlierButRevoked = { dateKey: '2026-09-27', declaredAtMs: 1000, revokedAtMs: 2000 };
  const result = r.mergeRemoteOffDays({ '2026-09-27': remoteEarlierButRevoked });
  assert.equal(result.changed, true);
  const merged = r.readOffDay('2026-09-27');
  assert.equal(merged.declaredAtMs, 1000); // earliest wins
  assert.equal(merged.revokedAtMs, 2000); // remote's revoke sticks even though local had none
});

test('mergeRemoteOffDays: a malformed remote record is rejected, never adopted', () => {
  const r = repo();
  const result = r.mergeRemoteOffDays({ '2026-09-27': { dateKey: 'wrong-key', declaredAtMs: 1000 } });
  assert.equal(result.changed, false);
  assert.deepEqual(result.rejectedDateKeys, ['2026-09-27']);
});

// ── invalid persisted data is never silently reinterpreted (§18) ──────────

test('a malformed persisted deadline envelope reports invalid, not unconfigured', () => {
  const storage = memory();
  storage.setItem(scopedCacheKeyForRoom('room-A', 'ta3-plan-by-deadline-revisions-v1'), 'not json');
  const r = createPlanByDeadlineRepository({ storage, idGenerator: seqIds, getOwner: () => 'room-A' });
  const status = r.deadlineStatus();
  assert.equal(status.status, 'invalid');
  assert.throws(() => r.readDeadlines(), /malformed JSON/);
});
