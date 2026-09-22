// personal-day-boundary-wire-encoding.test.js
//
// Reproduces, then verifies the fix for, a real production defect: Firebase RTDB deletes any
// object key whose value is a literal `null` (documented behavior — "Passing null ... deletes the
// data at that location", applied per-field inside a larger object exactly as at a top-level path).
// The Personal Day anchor revision is the only place this app ever persists a literal
// `effectiveFromInstant: null`, so every OTHER fake room ref in this test suite (which stores
// exactly the JS object it was given, never pruning anything) is too lenient to catch this — a real
// device was found stuck exactly this way: one revision received, one rejected, no conflict, the
// anchor permanently unappliable, even though the account's own device had pushed it correctly.
//
// This file's fake room ref is the one place in the suite that actually simulates the prune, so the
// fix (personal-day-boundary-sync.js's wire-safe sentinel encode/decode) is proven against the real
// wire behavior, not just the other fakes' more forgiving in-memory semantics.
//
// A second concern this file covers: an independent review found the FIRST version of the decoder
// too broad — it treated ANY revision missing `effectiveFromInstant` as "the anchor", which would
// have silently repaired a genuinely different, unrelated malformed revision that happened to also
// be missing that one field. The decoder now requires PROOF the object is anchor-shaped (the exact
// reserved id + boundaryTime + a real timezone this codebase's one anchor factory always produces)
// before treating a missing/sentinel field as semantic null — see the "decoder hardening" section.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPersonalDayBoundarySyncBridge,
  DAY_BOUNDARY_REVISIONS_REMOTE_PATH,
  decodeWireMap,
} from './personal-day-boundary-sync.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { LEGACY_CALENDAR_DAY_REVISION_ID, normalizeBoundaryRevisionHistory, validateBoundaryRevision } from './personal-day-boundary-model.js';

const MANILA = 'Asia/Manila';
const TEST_ROOM = 'uid_test-room';
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; };
let seq = 0;
const seqIds = () => `id-${++seq}`;

/** Recursively strips any key whose value is `null`, at every nesting level — the one thing every
 *  OTHER fake in this suite does not do, and the one thing real Firebase RTDB always does. */
function pruneNulls(value) {
  if (Array.isArray(value)) return value.map(pruneNulls);
  if (value && typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([k, v]) => { if (v !== null) out[k] = pruneNulls(v); });
    return out;
  }
  return value;
}

/** A room ref whose `set`/`transaction` commit path prunes nulls exactly like real RTDB, so any
 *  revision this test pushes through it experiences the real defect if the code does not encode
 *  around it. Otherwise the same minimal shape every other fake in this suite already uses. */
function nullPruningRoomRef(initial = {}) {
  const root = { value: pruneNulls(initial) };
  const listeners = new Map();
  const get = path => path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  function set(path, value) {
    const pruned = pruneNulls(value); // the real-RTDB step every other fake in this suite skips
    const segs = path.split('/').filter(Boolean);
    if (!segs.length) { root.value = pruned; fire(''); return; }
    let node = root.value;
    for (let i = 0; i < segs.length - 1; i++) {
      if (typeof node[segs[i]] !== 'object' || node[segs[i]] === null) node[segs[i]] = {};
      node = node[segs[i]];
    }
    node[segs[segs.length - 1]] = pruned;
    fire(path);
  }
  const fire = path => (listeners.get(path) || []).forEach(fn => fn({ val: () => get(path) ?? null }));
  function makeRef(path) {
    return {
      child(seg) { return makeRef(path ? `${path}/${seg}` : seg); },
      on(_event, fn) {
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(fn);
        fn({ val: () => get(path) ?? null });
      },
      off() { listeners.delete(path); },
      val: () => get(path) ?? null,
      transaction(updateFn) {
        const current = get(path) ?? null;
        const next = updateFn(current);
        if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => current } });
        set(path, next); // pruned exactly as a real commit would be
        return Promise.resolve({ committed: true, snapshot: { val: () => get(path) } }); // read back the PRUNED value, like real Firebase
      },
    };
  }
  return makeRef('');
}

function makeBridge({ roomRef, storage = memory(), onRemoteChange, onConflict } = {}) {
  const repository = createPersonalDayBoundaryRepository({ storage, idGenerator: seqIds, getOwner: () => TEST_ROOM });
  const bridge = createPersonalDayBoundarySyncBridge({ repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM, onRemoteChange, onConflict });
  return { bridge, repository };
}

// ═══════════════════════════════════════════════════════════════════════════
// The reproduction: this is the exact real-device signature.
// ═══════════════════════════════════════════════════════════════════════════

test('reproduction: pushing ONLY the anchor through a null-pruning room, then a second device attaching to it, does not get stuck unapplied', () => {
  const roomRef = nullPruningRoomRef();
  const pc = makeBridge({ roomRef });
  // Simulates exactly the real, historical defect scenario: a device pushed its anchor, but its
  // custom revision's own separate transaction never landed (offline/closed before the second push).
  const anchorOnly = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: null };
  return pc.bridge.pushRevision(anchorOnly).then(result => {
    assert.equal(result.committed, true, 'the anchor push itself succeeds');

    // What real Firebase now actually holds: the field the code tried to write as `null` is gone.
    const rawStoredAnchor = roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val()[LEGACY_CALENDAR_DAY_REVISION_ID];
    assert.ok(!('effectiveFromInstant' in rawStoredAnchor) || rawStoredAnchor.effectiveFromInstant !== null,
      'precondition: the raw wire value is not a literal null (this is what the pre-fix code left it as)');

    // A second, fresh device (matching the real report: desktop, already-synced) attaches.
    const mobile = makeBridge({ roomRef: null }); // constructed offline first, matching a slow room join
    let hydrated = 0;
    const listening = createPersonalDayBoundarySyncBridge({ repository: mobile.repository, getRoomRef: () => roomRef, getRoomId: () => TEST_ROOM, onHydrated: () => { hydrated++; } });
    listening.attach();

    // The diagnostics signature the real device reported must NOT reproduce: the lone anchor must
    // decode and validate, not come back as one received / one rejected / no conflict / unapplied.
    const diag = listening.diagnostics();
    assert.equal(diag.remoteRevisionCount, 1, 'the account cloud genuinely holds one revision');
    assert.equal(diag.remoteRejectedCount, 0, 'the anchor is no longer rejected as malformed');
    assert.equal(diag.remoteConflict, false);
    assert.equal(hydrated, 1, 'the device did hear the account — this is not a sync-pending state');

    // ── ANCHOR-ONLY SEMANTICS (strict-review conclusion) ────────────────────
    // The anchor VALIDATES on its own — but a real custom revision has still never arrived, so the
    // account is correctly read as "no personal day configured" (incomplete/legacy), never a bare,
    // nobody-chose-it "custom 00:00". `unapplied` is false (a valid, if incomplete, history is not
    // "broken"); `incomplete` is the distinct, honest label for exactly this state.
    assert.equal(diag.remoteUnapplied, false, 'a valid, if incomplete, remote history is not "unapplied" — it is honestly incomplete');
    assert.equal(diag.remoteIncomplete, true, 'diagnostics distinguishes "incomplete" from "unapplied/broken"');
    assert.equal(mobile.repository.status().status, 'absent');

    // Now the SAME device (the one whose custom push never landed) reconnects and finishes the job
    // — its own local cache still has both revisions (never lost locally), so pushAllLocal repairs
    // the cloud exactly as a reconnect after a dropped connection would.
    pc.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, Date.parse('2026-09-14T00:30:00Z'));
    return pc.bridge.pushAllLocal().then(() => {
      // snapshot 2: anchor + a valid custom revision -> the second snapshot hydrates normally.
      listening.handleRemoteSnapshot(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val());
      assert.equal(mobile.repository.status().status, 'custom');
      assert.equal(mobile.repository.status().revisions.length, 2);
      const active = mobile.repository.status().revisions.find(r => r.effectiveFromInstant !== null);
      assert.equal(active.boundaryTime, '18:00');
    });
  });
});

test('reproduction: a device pushing its OWN anchor+custom (both transactions) through a null-pruning room converges for a fresh bootstrap in one step', async () => {
  const roomRef = nullPruningRoomRef();
  const pc = makeBridge({ roomRef });
  pc.bridge.attach();
  pc.repository.propose({ boundaryTime: '18:00', timezone: MANILA }, Date.parse('2026-09-14T00:30:00Z'));
  await pc.bridge.pushAllLocal();

  const fresh = makeBridge({ roomRef });
  fresh.bridge.attach();
  assert.equal(fresh.repository.status().status, 'custom');
  assert.equal(fresh.repository.status().revisions.length, 2);
  assert.ok(fresh.repository.status().revisions.some(r => r.effectiveFromInstant === null), 'the anchor decoded correctly, not lost');
  assert.ok(fresh.repository.status().revisions.some(r => r.boundaryTime === '18:00' && r.effectiveFromInstant !== null));

  // And the remote store itself, decoded, is a genuinely valid history — the acceptance bar every
  // other concurrency test in this suite already holds itself to.
  const decoded = decodeWireMap(roomRef.child(DAY_BOUNDARY_REVISIONS_REMOTE_PATH).val());
  assert.doesNotThrow(() => normalizeBoundaryRevisionHistory(Object.values(decoded)));
});

test('idempotent re-push of an anchor already sitting in a null-pruning room (the real device\'s own retry) is a no-op, never a conflict', async () => {
  const roomRef = nullPruningRoomRef();
  const pc = makeBridge({ roomRef });
  const anchor = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: null };
  assert.deepEqual(await pc.bridge.pushRevision(anchor), { committed: true, outcome: 'committed' });
  // The SAME device retries (e.g. a reconnect re-drains pushAllLocal). Before the fix, this second
  // attempt would see its own now-corrupted anchor as "different" and refuse it as a conflict.
  assert.deepEqual(await pc.bridge.pushRevision(anchor), { committed: true, outcome: 'idempotent' });
});

// ═══════════════════════════════════════════════════════════════════════════
// Decoder hardening — the anchor-shape proof, not "undefined means anchor".
// ═══════════════════════════════════════════════════════════════════════════

test('1: old pruned anchor (field entirely absent, proven anchor-shaped) -> accepted as semantic anchor', () => {
  const oldStyleAbsent = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA }; // no effectiveFromInstant key at all
  const decoded = decodeWireMap({ a: oldStyleAbsent }).a;
  assert.equal(decoded.effectiveFromInstant, null);
  assert.ok(validateBoundaryRevision(decoded));
});

test('2: new sentinel anchor -> semantic null', () => {
  const sentinelStyle = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: 'legacy-anchor-instant' };
  const decoded = decodeWireMap({ a: sentinelStyle }).a;
  assert.equal(decoded.effectiveFromInstant, null);
  assert.ok(validateBoundaryRevision(decoded));
});

test('3: ordinary finite revision -> unchanged', () => {
  const t = Date.parse('2026-09-14T10:00:00Z');
  const timed = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: t };
  assert.deepEqual(decodeWireMap({ r1: timed }).r1, timed);
});

test('4: malformed NON-anchor with missing effectiveFromInstant -> rejected (never repaired just because a field is missing)', () => {
  // A real, device-generated custom revision that happens to be missing effectiveFromInstant for
  // some OTHER, unrelated reason (corruption, a bug, a partial write). Its id is NOT the reserved
  // anchor id, so the decoder must never guess this is "the anchor".
  const nonAnchorMissingField = { id: 'some-real-device-id', boundaryTime: '18:00', timezone: MANILA };
  const decoded = decodeWireMap({ x: nonAnchorMissingField }).x;
  assert.equal(decoded.effectiveFromInstant, undefined, 'left exactly as found — never rehydrated to null');
  assert.equal(validateBoundaryRevision(decoded), false, 'correctly rejected: neither null nor a finite number');
});

test('5: malformed anchor fields (right id, wrong boundaryTime/timezone) -> rejected, never accepted as anchor', () => {
  const wrongBoundaryTime = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '99:99', timezone: MANILA }; // bad time, missing field
  const decodedA = decodeWireMap({ a: wrongBoundaryTime }).a;
  assert.equal(decodedA.effectiveFromInstant, undefined, 'not proven anchor-shaped — boundaryTime is not 00:00 — left untouched');
  assert.equal(validateBoundaryRevision(decodedA), false);

  const wrongTimezone = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: 'Not/A_Zone' };
  const decodedB = decodeWireMap({ b: wrongTimezone }).b;
  assert.equal(decodedB.effectiveFromInstant, undefined, 'not proven anchor-shaped — timezone does not resolve — left untouched');
  assert.equal(validateBoundaryRevision(decodedB), false);

  const rightIdButNonZeroTime = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '18:00', timezone: MANILA }; // reserved id, but NOT the anchor's boundaryTime
  const decodedC = decodeWireMap({ c: rightIdButNonZeroTime }).c;
  assert.equal(decodedC.effectiveFromInstant, undefined, 'the reserved id alone is not proof — boundaryTime must also match');
  assert.equal(validateBoundaryRevision(decodedC), false);
});

test('6: unknown extra fields retain existing schema behavior — decoding neither strips nor otherwise mutates them', () => {
  const withExtra = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, someExtraField: 'kept-as-is' };
  const decoded = decodeWireMap({ a: withExtra }).a;
  assert.equal(decoded.effectiveFromInstant, null);
  assert.equal(decoded.someExtraField, 'kept-as-is');
  assert.ok(validateBoundaryRevision(decoded));
});

test('decodeWireMap rehydrates a sentinel-encoded anchor, an old-style (field entirely absent) anchor, and passes an already-correct anchor through unchanged — idempotently', () => {
  const sentinelStyle = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: 'legacy-anchor-instant' };
  const oldStyleAbsent = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA };
  const alreadyCorrect = { id: LEGACY_CALENDAR_DAY_REVISION_ID, boundaryTime: '00:00', timezone: MANILA, effectiveFromInstant: null };
  for (const raw of [sentinelStyle, oldStyleAbsent, alreadyCorrect]) {
    const decodedOnce = decodeWireMap({ a: raw }).a;
    assert.equal(decodedOnce.effectiveFromInstant, null);
    assert.ok(validateBoundaryRevision(decodedOnce));
    const decodedTwice = decodeWireMap({ a: decodedOnce }).a; // decoding an already-decoded value
    assert.deepEqual(decodedTwice, decodedOnce, 'decode is idempotent');
  }
});

test('decodeWireMap leaves a real, non-null effectiveFromInstant completely unchanged', () => {
  const t = Date.parse('2026-09-14T10:00:00Z');
  const timed = { id: 'r1', boundaryTime: '18:00', timezone: MANILA, effectiveFromInstant: t };
  assert.deepEqual(decodeWireMap({ r1: timed }).r1, timed);
});
