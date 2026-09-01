import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLifeLedgerMemoryStore,
  deriveLifeLedgerKey,
  fingerprintLifeLedgerEvent,
  serializeLifeLedgerFacts,
  upsertLifeLedgerEvent,
  validateLifeLedgerEventDraft
} from './life-ledger-core.js';
import {
  WORKOUT_LIFE_LEDGER_CAPABILITIES,
  importWorkoutBackup,
  normalizeWorkoutBackup,
  normalizeWorkoutCompleted
} from './workout-life-ledger-adapter.js';

const TZ = 'America/Phoenix';
const START = Date.parse('2026-08-30T17:00:00.000Z');
const END = Date.parse('2026-08-30T18:15:00.000Z');
const SNAPSHOT = Date.parse('2026-08-30T18:16:00.000Z');
const OBSERVED = '2026-08-31T15:00:00.000Z';
const EVENT_ID = '00000000-0000-4000-8000-000000000001';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Mirrors openGym doFinishWorkout(): active fields are copied, unfinished sets remain in
// finished exercise blocks, bw/topW/target/prs are durable, and rating/note may be added later.
function nativeWorkout(overrides = {}) {
  return {
    id: 'm-native-1',
    d: '2026-08-30',
    start: START,
    end: END,
    routineId: 'routine-a',
    name: 'Full body',
    bw: 82.4,
    entries: [
      {
        id: 'squat',
        topW: 105,
        sets: [
          { w: 100, r: 5, rir: 2, done: true },
          { w: 105, r: 5, rpe: 9, done: true },
          { w: 110, r: 5, done: false }
        ],
        target: { mode: 'reps', sets: 3, reps: 5, weight: 100, prog: 'linear', inc: 2.5 }
      }
    ],
    prs: ['squat'],
    vol: 1025,
    rating: 'right',
    note: 'Solid session.',
    ...overrides
  };
}

// Mirrors parseWorkoutCSV(): iw-prefixed ID, converted numeric loads with row units dropped,
// imported name, completed sets, topW, empty PRs, and end === start when duration was absent.
function importedWorkout(overrides = {}) {
  return nativeWorkout({
    id: 'iw-imported-1',
    name: 'Imported',
    end: START,
    routineId: null,
    bw: undefined,
    entries: [{ id: 'squat', sets: [{ w: 100, r: 5, done: true }], topW: 100 }],
    prs: [],
    vol: 500,
    rating: undefined,
    note: undefined,
    ...overrides
  });
}

function backup(workouts = [nativeWorkout()], overrides = {}) {
  return { unit: 'kg', workouts, _ts: SNAPSHOT, active: null, ...overrides };
}

function context(overrides = {}) {
  return { assertedTimezone: TZ, observationClock: () => OBSERVED, ...overrides };
}

function ledgerOptions(overrides = {}) {
  return { clock: () => OBSERVED, createId: () => EVENT_ID, ...overrides };
}

test('normalizes source-compatible strength, timed, and cardio facts with bounded context', () => {
  const source = nativeWorkout({
    entries: [
      ...nativeWorkout().entries,
      {
        id: 'plank', n: 'Weighted plank', topW: 20,
        sets: [{ sec: 90, w: 20, done: true }],
        target: { mode: 'time', sets: 1, sec: 90, weight: 20, prog: 'time', inc: 5 }
      },
      {
        id: 'treadmill', sets: [{ min: 20, speed: 9.5, done: true }],
        target: { mode: 'cardio', sets: 1, min: 20, speed: 9.5 }
      }
    ]
  });
  const result = normalizeWorkoutBackup(backup([source]), context({ assertedWeightUnit: 'kg' }));
  assert.equal(result.rejected.length, 0);
  const event = result.drafts[0];
  assert.equal(event.sourceEntityId, 'm-native-1');
  assert.equal(event.occurredAt, '2026-08-30T18:15:00.000Z');
  assert.equal(event.payload.durationMinutes, 75);
  assert.deepEqual(event.payload.bodyWeight, { value: 82.4 });
  assert.equal(event.payload.rating, 'right');
  assert.equal(event.payload.note, 'Solid session.');
  assert.equal(event.payload.exercises[0].topWeight, 105);
  assert.deepEqual(event.payload.exercises[1].sets, [{ seconds: 90, load: 20 }]);
  assert.deepEqual(event.payload.exercises[2].sets, [{ minutes: 20, speedKph: 9.5 }]);
  assert.deepEqual(event.payload.source.weightUnitContext, { authority: 'import_assertion', unit: 'kg' });
  assert.deepEqual(event.payload.source.timezoneContext, { authority: 'import_assertion', timeZone: TZ });
  assert.equal(event.provenance.observedAt, OBSERVED);
  assert.equal(validateLifeLedgerEventDraft(event).ok, true);
});

test('accepts native finish-anyway zero-set records and excludes active sessions', () => {
  const finished = nativeWorkout({ id: 'finished-empty', entries: [], prs: [], vol: 0 });
  const result = normalizeWorkoutBackup(backup([finished], {
    active: { id: 'started-only', start: START, name: 'Never finished', entries: [] }
  }), context());
  assert.deepEqual(result.drafts.map(draft => draft.sourceEntityId), ['finished-empty']);
  assert.deepEqual(result.drafts[0].payload.exercises, []);
  assert.equal(result.rejected.length, 0);
});

test('represents CSV-imported unknown duration without fabrication or whole-batch failure', () => {
  const result = normalizeWorkoutBackup(
    backup([importedWorkout(), nativeWorkout({ id: 'valid-native' })]), context()
  );
  assert.equal(result.rejected.length, 0);
  assert.equal(result.drafts.length, 2);
  const imported = result.drafts.find(draft => draft.sourceEntityId === 'iw-imported-1');
  assert.equal(imported.payload.startedAt, imported.payload.endedAt);
  assert.equal(Object.hasOwn(imported.payload, 'durationMinutes'), false);
  assert.equal(imported.payload.source.durationStatus, 'unknown');
  assert.equal(imported.payload.source.recordCategory, 'csv_import_path_compatible');
  assert.equal(imported.confidence.basis, 'validated-supplied-backup-record');
  assert.equal(validateLifeLedgerEventDraft(imported).ok, true);
});

test('an iw-prefixed ID is only recognized as shape-compatible, never as proven CSV origin', () => {
  // Arbitrary supplied JSON can imitate an `iw` prefix; the backup gives no cryptographic proof of
  // its origin. The adapter may recognize the shape/ID as compatible with openGym's CSV import
  // path, but must not describe it as definitively imported history.
  const forged = normalizeWorkoutBackup(
    backup([nativeWorkout({ id: 'iw-forged-arbitrary-json-1', name: 'Forged history-shaped record' })]),
    context()
  );
  assert.equal(forged.rejected.length, 0);
  const draft = forged.drafts[0];
  assert.equal(draft.payload.source.recordCategory, 'csv_import_path_compatible');
  assert.notEqual(draft.payload.source.recordCategory, 'csv_imported_history');
  assert.equal(draft.payload.source.completionBasis, 'source-import-path-shape-compatible');
  assert.equal(draft.confidence.basis, 'validated-supplied-backup-record');
});

test('current global unit changes never relabel historical numeric loads', () => {
  const kgSetting = normalizeWorkoutBackup(backup(), context());
  const lbSetting = normalizeWorkoutBackup(backup(undefined, { unit: 'lb' }), context());
  assert.deepEqual(kgSetting.drafts[0].payload.source.weightUnitContext, { authority: 'unknown' });
  assert.equal(kgSetting.drafts[0].payload.exercises[0].sets[0].load, 100);
  assert.equal(fingerprintLifeLedgerEvent(kgSetting.drafts[0]), fingerprintLifeLedgerEvent(lbSetting.drafts[0]));

  const asserted = normalizeWorkoutBackup(backup(), context({ assertedWeightUnit: 'kg' }));
  assert.deepEqual(asserted.drafts[0].payload.source.weightUnitContext, { authority: 'import_assertion', unit: 'kg' });
});

test('bw, topW, rating, and note are factual and each changes the workout fingerprint', () => {
  const fingerprint = workout => fingerprintLifeLedgerEvent(
    normalizeWorkoutBackup(backup([workout]), context()).drafts[0]
  );
  const base = fingerprint(nativeWorkout());
  const changed = [
    nativeWorkout({ bw: 83 }),
    nativeWorkout({ entries: [{ ...nativeWorkout().entries[0], topW: 110 }] }),
    nativeWorkout({ rating: 'hard' }),
    nativeWorkout({ note: 'Different note.' })
  ];
  changed.forEach(workout => assert.notEqual(fingerprint(workout), base));
});

test('timezone and source local date remain separate facts without false mismatch rejection', () => {
  const result = normalizeWorkoutBackup(
    backup([nativeWorkout({ d: '2026-08-29' })]), context({ assertedTimezone: 'Asia/Manila' })
  );
  assert.equal(result.rejected.length, 0);
  assert.equal(result.drafts[0].sourceTimezone, 'Asia/Manila');
  assert.equal(result.drafts[0].payload.source.localDate, '2026-08-29');
  assert.equal(result.drafts[0].payload.startedAt, new Date(START).toISOString());
});

test('observation time comes only from the injected clock, never old or future-skewed _ts', () => {
  const old = normalizeWorkoutBackup(backup(undefined, { _ts: Date.parse('2020-01-01T00:00:00Z') }), context());
  const future = normalizeWorkoutBackup(backup(undefined, { _ts: Date.parse('2099-01-01T00:00:00Z') }), context());
  const missing = normalizeWorkoutBackup(backup(undefined, { _ts: null }), context());
  assert.equal(old.drafts[0].provenance.observedAt, OBSERVED);
  assert.equal(future.drafts[0].provenance.observedAt, OBSERVED);
  assert.equal(old.drafts[0].provenance.sourceStateTimestamp, '2020-01-01T00:00:00.000Z');
  assert.equal(future.drafts[0].provenance.sourceStateTimestamp, '2099-01-01T00:00:00.000Z');
  assert.equal(Object.hasOwn(missing.drafts[0].provenance, 'sourceStateTimestamp'), false);
});

test('normalization is deterministic, non-mutating, sorted, and collapses exact duplicates', () => {
  const input = backup([nativeWorkout({ id: 'z' }), nativeWorkout({ id: 'a' }), nativeWorkout({ id: 'a' })]);
  const before = clone(input);
  const first = normalizeWorkoutBackup(input, context());
  const second = normalizeWorkoutBackup(clone(input), context());
  assert.deepEqual(input, before);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.drafts.map(draft => draft.sourceEntityId), ['a', 'z']);
  assert.equal(serializeLifeLedgerFacts(first.drafts[0]), serializeLifeLedgerFacts(second.drafts[0]));
});

test('every physical input record gets an explicit indexed outcome, including identical duplicates', () => {
  const result = normalizeWorkoutBackup(backup([
    nativeWorkout({ id: 'x' }), nativeWorkout({ id: 'x' })
  ]), context());
  assert.equal(result.rejected.length, 0);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.outcomes.length, 2);
  assert.deepEqual(result.outcomes.map(outcome => outcome.status), ['accepted', 'duplicate']);
  assert.equal(result.outcomes[0].index, 0);
  assert.equal(result.outcomes[1].index, 1);
  assert.equal(result.outcomes[1].duplicateOfIndex, 0);
});

test('duplicate outcome classification stays correct with reversed/interleaved input order', () => {
  const forward = normalizeWorkoutBackup(backup([
    nativeWorkout({ id: 'a' }), nativeWorkout({ id: 'b' }), nativeWorkout({ id: 'a' })
  ]), context());
  assert.deepEqual(forward.outcomes.map(outcome => outcome.status), ['accepted', 'accepted', 'duplicate']);
  assert.equal(forward.outcomes[2].duplicateOfIndex, 0);

  const reversed = normalizeWorkoutBackup(backup([
    nativeWorkout({ id: 'a' }), nativeWorkout({ id: 'a' }), nativeWorkout({ id: 'b' })
  ]), context());
  assert.deepEqual(reversed.outcomes.map(outcome => outcome.status), ['accepted', 'duplicate', 'accepted']);
  assert.equal(reversed.outcomes[1].duplicateOfIndex, 0);
});

test('conflicting duplicate IDs mark every physical record in the group as a conflict outcome', () => {
  const result = normalizeWorkoutBackup(backup([
    nativeWorkout({ id: 'collision' }), nativeWorkout({ id: 'valid' }),
    nativeWorkout({ id: 'collision', name: 'Different facts' })
  ]), context());
  assert.deepEqual(result.outcomes.map(outcome => outcome.status), ['conflict', 'accepted', 'conflict']);
});

test('conflicting duplicate IDs reject that group but preserve unrelated valid drafts', () => {
  const result = normalizeWorkoutBackup(backup([
    nativeWorkout({ id: 'collision' }), nativeWorkout({ id: 'valid' }),
    nativeWorkout({ id: 'collision', name: 'Different facts' })
  ]), context());
  assert.deepEqual(result.drafts.map(draft => draft.sourceEntityId), ['valid']);
  assert.equal(result.rejected[0].reason, 'conflicting_duplicate_workout_id');
  assert.deepEqual(result.rejected[0].indexes, [0, 2]);
});

test('malformed records fail closed at record level without silently skipping valid records', () => {
  const malformed = [
    nativeWorkout({ id: '' }),
    nativeWorkout({ id: 42 }),
    nativeWorkout({ end: START - 1 }),
    nativeWorkout({ entries: [{ id: 'x', sets: [{ w: -1, r: 5, done: true }] }] }),
    nativeWorkout({ entries: [{ id: 'x', sets: [{ w: 10, r: 5 }] }] }),
    nativeWorkout({ entries: [{ id: 'x', sets: [{ w: 10, r: 5, sec: 30, done: true }] }] }),
    nativeWorkout({ prs: ['missing'] }),
    nativeWorkout({ rating: 'perfect' }),
    nativeWorkout({ note: 'x'.repeat(301) })
  ];
  const result = normalizeWorkoutBackup(backup([nativeWorkout({ id: 'valid' }), ...malformed]), context());
  assert.deepEqual(result.drafts.map(draft => draft.sourceEntityId), ['valid']);
  assert.equal(result.rejected.length, malformed.length);
  assert.deepEqual(result.rejected.map(item => item.index), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('requires explicit observation clock and timezone assertion at the import boundary', () => {
  assert.equal(normalizeWorkoutBackup(backup(), { assertedTimezone: TZ }).rejected[0].reason, 'missing_observation_clock');
  assert.equal(normalizeWorkoutBackup(backup(), { observationClock: () => OBSERVED }).rejected[0].reason, 'invalid_timezone_assertion');
  assert.equal(normalizeWorkoutBackup(backup(), context({ assertedWeightUnit: 'stone' })).rejected[0].reason, 'invalid_weight_unit_assertion');
  assert.equal(normalizeWorkoutBackup(backup(), context({ observationClock: () => null })).rejected[0].reason, 'invalid_observation_clock');
  assert.equal(normalizeWorkoutBackup(null, context()).rejected[0].reason, 'backup_must_be_object');
});

test('a fatal batch/context rejection still returns one indexed outcome per physical record', () => {
  const threeRecordBackup = backup([
    nativeWorkout({ id: 'a' }), nativeWorkout({ id: 'b' }), nativeWorkout({ id: 'c' })
  ]);
  const result = normalizeWorkoutBackup(threeRecordBackup, { assertedTimezone: TZ }); // missing observationClock
  assert.equal(result.fatal, true);
  assert.equal(result.rejected[0].reason, 'missing_observation_clock');
  assert.equal(result.outcomes.length, 3);
  assert.deepEqual(result.outcomes.map(outcome => outcome.index), [0, 1, 2]);
  assert.ok(result.outcomes.every(outcome => outcome.status === 'invalid' && outcome.reason === 'missing_observation_clock'));

  // Deterministic on repeated invocation with the same input.
  const repeat = normalizeWorkoutBackup(threeRecordBackup, { assertedTimezone: TZ });
  assert.deepEqual(repeat.outcomes, result.outcomes);

  // The top-level import result surfaces the same fatal status and per-record accounting.
  const store = createLifeLedgerMemoryStore();
  const imported = importWorkoutBackup(threeRecordBackup, { assertedTimezone: TZ, store });
  assert.equal(imported.status, 'rejected');
  assert.equal(imported.outcomes.length, 3);
});

test('a fatal batch/context rejection with zero physical records returns zero outcomes', () => {
  const emptyBackup = backup([]);
  const result = normalizeWorkoutBackup(emptyBackup, { assertedTimezone: TZ });
  assert.equal(result.fatal, true);
  assert.deepEqual(result.outcomes, []);
});

test('a fatal structural rejection (backup itself malformed) returns zero outcomes', () => {
  assert.deepEqual(normalizeWorkoutBackup(null, context()).outcomes, []);
  assert.deepEqual(normalizeWorkoutBackup({ workouts: 'not-an-array' }, context()).outcomes, []);
});

test('preserves repeated exercise IDs, PR IDs, and hostile text as inert factual data', () => {
  const hostileId = '../<script>alert(1)</script>';
  const repeated = nativeWorkout({
    id: hostileId, name: '<img src=x onerror=1>',
    entries: [
      { id: 'squat', sets: [{ w: 100, r: 5, done: true }], topW: 100 },
      { id: 'squat', sets: [{ w: 80, r: 10, done: true }], topW: 80 }
    ],
    prs: ['squat']
  });
  const result = normalizeWorkoutBackup(backup([repeated]), context());
  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.drafts[0].payload.exercises.map(exercise => exercise.exerciseId), ['squat', 'squat']);
  assert.equal(result.drafts[0].payload.workoutName, '<img src=x onerror=1>');
  assert.equal(deriveLifeLedgerKey(result.drafts[0]), `workout:${hostileId}:workout_completed`);
});

test('oversized and control-character text/identifier fields are rejected, not silently truncated', () => {
  const bell = String.fromCharCode(7);
  const cases = [
    nativeWorkout({ name: 'x'.repeat(201) }),
    nativeWorkout({ name: `bad${bell}name` }),
    nativeWorkout({ id: 'x'.repeat(201) }),
    nativeWorkout({ id: `bad${bell}id` }),
    nativeWorkout({ entries: [{ id: 'x', n: 'x'.repeat(201), sets: [{ w: 10, r: 5, done: true }] }] }),
    nativeWorkout({ entries: [{ id: 'x', n: `bad${bell}exercise`, sets: [{ w: 10, r: 5, done: true }] }] }),
    nativeWorkout({
      entries: [{ id: 'x', sets: [{ w: 10, r: 5, done: true }], target: { mode: 'reps', prog: 'x'.repeat(201) } }]
    }),
    nativeWorkout({ routineId: 'x'.repeat(201) })
  ];
  cases.forEach((workout, caseIndex) => {
    const result = normalizeWorkoutBackup(backup([workout]), context());
    assert.equal(result.drafts.length, 0, `case ${caseIndex} unexpectedly accepted: ${JSON.stringify(result.rejected)}`);
    assert.equal(result.rejected.length, 1, `case ${caseIndex} did not reject`);
  });
  // A tab/newline in a free-text note is legitimate and must not be rejected as unsafe.
  const multilineNote = normalizeWorkoutBackup(backup([nativeWorkout({ note: 'Line one\nLine two' })]), context());
  assert.equal(multilineNote.rejected.length, 0);
});

test('same-ID changed facts are immutable conflicts regardless of higher global _ts', () => {
  const store = createLifeLedgerMemoryStore();
  const first = importWorkoutBackup(backup(), { ...context(), store, ledgerOptions: ledgerOptions() });
  const changed = importWorkoutBackup(
    backup([nativeWorkout({ name: 'Changed facts' })], { _ts: SNAPSHOT + 100000 }),
    { ...context(), store, ledgerOptions: ledgerOptions() }
  );
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.actions.map(action => action.action), ['created']);
  assert.equal(changed.status, 'partial');
  assert.equal(changed.conflicts[0].reason, 'immutable_workout_conflict');
  assert.equal(store.listEvents()[0].payload.workoutName, 'Full body');
  assert.equal(store.listEvents()[0].revision, 1);
});

test('same-ID changed facts mark the record outcome as conflict, not accepted', () => {
  const store = createLifeLedgerMemoryStore();
  importWorkoutBackup(backup(), { ...context(), store, ledgerOptions: ledgerOptions() });
  const changed = importWorkoutBackup(
    backup([nativeWorkout({ name: 'Changed facts' })]),
    { ...context(), store, ledgerOptions: ledgerOptions() }
  );
  assert.deepEqual(changed.outcomes.map(outcome => outcome.status), ['conflict']);
});

// This exact note pair produces a real FNV-1a 32-bit fingerprint collision through this adapter's
// own normalization pipeline (verified independently before writing this test: both drafts,
// otherwise identical, hash to fnv1a32:9ce28ae5). The reviewer's own example pair could not be
// reproduced against this repo's specific canonical fixture shape, so this pair was found by direct
// search against the adapter's real serialization/hash output and re-verified end-to-end; it proves
// the same class of bug the reviewer described. Fingerprint equality must never, by itself, be
// treated as proof that two records carry the same facts.
function collisionWorkout(note, overrides = {}) {
  return {
    id: 'm-native-1', d: '2026-08-30', start: START, end: END, name: 'Full body',
    entries: [{ id: 'squat', sets: [{ w: 100, r: 5, done: true }] }],
    note,
    ...overrides
  };
}
const COLLISION_NOTE_A = 'n6vl8';
const COLLISION_NOTE_B = 'nnpd6';

test('two distinct note values produce a real fingerprint collision (sanity check for the test below)', () => {
  const draftA = normalizeWorkoutBackup(backup([collisionWorkout(COLLISION_NOTE_A)]), context()).drafts[0];
  const draftB = normalizeWorkoutBackup(backup([collisionWorkout(COLLISION_NOTE_B)]), context()).drafts[0];
  assert.notEqual(draftA.payload.note, draftB.payload.note);
  assert.equal(fingerprintLifeLedgerEvent(draftA), fingerprintLifeLedgerEvent(draftB));
  assert.equal(fingerprintLifeLedgerEvent(draftA), 'fnv1a32:9ce28ae5');
});

test('a fingerprint collision between changed facts still produces immutable_workout_conflict, not a silent unchanged', () => {
  const store = createLifeLedgerMemoryStore();
  const first = importWorkoutBackup(backup([collisionWorkout(COLLISION_NOTE_A)]), {
    ...context(), store, ledgerOptions: ledgerOptions()
  });
  assert.equal(first.status, 'ok');
  assert.equal(first.actions[0].action, 'created');
  const storedAfterFirst = store.listEvents();
  assert.equal(storedAfterFirst[0].payload.note, COLLISION_NOTE_A);
  assert.equal(storedAfterFirst[0].revision, 1);
  const originalEventId = storedAfterFirst[0].eventId;

  const second = importWorkoutBackup(
    backup([collisionWorkout(COLLISION_NOTE_B)], { _ts: SNAPSHOT + 1000 }),
    { ...context(), store, ledgerOptions: ledgerOptions({ createId: () => `00000000-0000-4000-8000-${'2'.padStart(12, '0')}` }) }
  );

  assert.equal(second.status, 'partial');
  assert.equal(second.conflicts.length, 1);
  assert.equal(second.conflicts[0].reason, 'immutable_workout_conflict');
  // The conflict was detected DESPITE colliding fingerprints — this is the actual bug proof.
  assert.equal(second.conflicts[0].acceptedFingerprint, second.conflicts[0].incomingFingerprint);
  assert.deepEqual(second.outcomes.map(outcome => outcome.status), ['conflict']);
  assert.equal(second.actions.length, 0);

  const storedAfterSecond = store.listEvents();
  assert.equal(storedAfterSecond.length, 1, 'no duplicate event was created');
  assert.equal(storedAfterSecond[0].eventId, originalEventId, 'eventId is unchanged');
  assert.equal(storedAfterSecond[0].revision, 1, 'revision is unchanged');
  assert.equal(storedAfterSecond[0].payload.note, COLLISION_NOTE_A, 'original note was not silently overwritten or lost');
});

test('identical canonical facts with an identical (non-colliding) fingerprint remain an idempotent unchanged', () => {
  const store = createLifeLedgerMemoryStore();
  importWorkoutBackup(backup([collisionWorkout(COLLISION_NOTE_A)]), { ...context(), store, ledgerOptions: ledgerOptions() });
  const retry = importWorkoutBackup(backup([collisionWorkout(COLLISION_NOTE_A)], { _ts: SNAPSHOT + 1000 }), {
    ...context(), store, ledgerOptions: ledgerOptions()
  });
  assert.equal(retry.status, 'ok');
  assert.deepEqual(retry.actions.map(action => action.action), ['unchanged']);
  assert.deepEqual(retry.outcomes.map(outcome => outcome.status), ['accepted']);
  assert.equal(store.listEvents()[0].revision, 1);
});

test('a rejected ledger upsert prevents the top-level status from reporting ok', () => {
  const store = createLifeLedgerMemoryStore();
  // A non-UUID createId forces upsertLifeLedgerEvent() to reject the fully-built event even though
  // the workout draft itself is valid, reproducing a store-level failure independent of malformed
  // input or a source conflict.
  const result = importWorkoutBackup(backup(), {
    ...context(), store, ledgerOptions: ledgerOptions({ createId: () => 'not-a-uuid' })
  });
  assert.equal(result.rejected.length, 0);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.actions[0].action, 'rejected');
  assert.notEqual(result.status, 'ok');
  assert.equal(result.status, 'partial');
  assert.equal(store.listEvents().length, 0);
  assert.deepEqual(result.outcomes.map(outcome => outcome.status), ['failed']);

  const retried = importWorkoutBackup(backup(), { ...context(), store, ledgerOptions: ledgerOptions() });
  assert.equal(retried.status, 'ok');
  assert.equal(store.listEvents().length, 1);
});

test('restored older facts with a newly stamped _ts cannot roll back an accepted workout', () => {
  const store = createLifeLedgerMemoryStore();
  importWorkoutBackup(backup([nativeWorkout({ name: 'Accepted facts' })]), {
    ...context(), store, ledgerOptions: ledgerOptions()
  });
  const restored = importWorkoutBackup(
    backup([nativeWorkout({ name: 'Older restored facts' })], { _ts: SNAPSHOT + 999999 }),
    { ...context(), store, ledgerOptions: ledgerOptions() }
  );
  assert.equal(restored.conflicts[0].reason, 'immutable_workout_conflict');
  assert.equal(store.listEvents()[0].payload.workoutName, 'Accepted facts');
});

test('future-skewed _ts does not freeze later processing of a new workout', () => {
  const store = createLifeLedgerMemoryStore();
  importWorkoutBackup(
    backup([nativeWorkout({ id: 'future-seen' })], { _ts: Date.parse('2099-01-01T00:00:00Z') }),
    { ...context(), store, ledgerOptions: ledgerOptions() }
  );
  let ids = 1;
  const later = importWorkoutBackup(
    backup([
      nativeWorkout({ id: 'future-seen' }),
      nativeWorkout({ id: 'later-legitimate' })
    ], { _ts: SNAPSHOT }),
    {
      ...context(), store,
      ledgerOptions: ledgerOptions({
        createId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
      })
    }
  );
  assert.equal(later.status, 'ok');
  assert.deepEqual(later.actions.map(action => action.action), ['unchanged', 'created']);
  assert.deepEqual(store.listEvents().map(event => event.sourceEntityId).sort(), ['future-seen', 'later-legitimate']);
});

test('exact retries deduplicate despite changed snapshot metadata and observation time', () => {
  const store = createLifeLedgerMemoryStore();
  importWorkoutBackup(backup(), { ...context(), store, ledgerOptions: ledgerOptions() });
  const retry = importWorkoutBackup(backup(undefined, { _ts: SNAPSHOT + 1000 }), {
    ...context({ observationClock: () => '2026-09-01T15:00:00.000Z' }),
    store,
    ledgerOptions: ledgerOptions({ clock: () => '2026-09-01T15:00:00.000Z' })
  });
  assert.equal(retry.status, 'ok');
  assert.deepEqual(retry.actions.map(action => action.action), ['unchanged']);
  assert.equal(store.listEvents()[0].revision, 1);
  assert.equal(store.listEvents()[0].provenance.observedAt, OBSERVED);
});

test('valid records apply beside malformed rejections and source conflicts', () => {
  const store = createLifeLedgerMemoryStore();
  importWorkoutBackup(backup([nativeWorkout({ id: 'existing' })]), {
    ...context(), store, ledgerOptions: ledgerOptions()
  });
  let ids = 1;
  const result = importWorkoutBackup(backup([
    nativeWorkout({ id: 'new-valid' }), nativeWorkout({ id: '' }),
    nativeWorkout({ id: 'existing', name: 'Conflicting facts' })
  ]), {
    ...context(), store,
    ledgerOptions: ledgerOptions({
      createId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
    })
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.actions.map(action => action.action), ['created']);
  assert.equal(result.rejected[0].index, 1);
  assert.equal(result.conflicts[0].sourceEntityId, 'existing');
  assert.deepEqual(store.listEvents().map(event => event.sourceEntityId).sort(), ['existing', 'new-valid']);
});

test('snapshot absence never implies deletion or restore', () => {
  const store = createLifeLedgerMemoryStore();
  importWorkoutBackup(backup(), { ...context(), store, ledgerOptions: ledgerOptions() });
  const absent = importWorkoutBackup(backup([], { _ts: SNAPSHOT + 1000 }), {
    ...context(), store, ledgerOptions: ledgerOptions()
  });
  assert.equal(absent.status, 'ok');
  assert.deepEqual(absent.actions, []);
  assert.equal(store.listEvents()[0].tombstone.active, false);
  assert.match(WORKOUT_LIFE_LEDGER_CAPABILITIES.deletion, /^unsupported/);
  assert.match(WORKOUT_LIFE_LEDGER_CAPABILITIES.restore, /^unsupported/);
});

test('a retry completes safely after a storage failure interrupts prior valid writes', () => {
  const underlying = createLifeLedgerMemoryStore();
  let calls = 0;
  const flaky = {
    getByKey: key => underlying.getByKey(key),
    upsertEvent(draft, options) {
      calls += 1;
      if (calls === 2) throw new Error('simulated storage failure');
      return upsertLifeLedgerEvent(underlying, draft, options);
    }
  };
  const source = backup([nativeWorkout({ id: 'a' }), nativeWorkout({ id: 'b' })]);
  let ids = 0;
  const options = ledgerOptions({
    createId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
  });
  assert.throws(
    () => importWorkoutBackup(source, { ...context(), store: flaky, ledgerOptions: options }),
    /simulated storage failure/
  );
  assert.equal(underlying.listEvents().length, 1);
  const retried = importWorkoutBackup(source, { ...context(), store: underlying, ledgerOptions: options });
  assert.deepEqual(retried.actions.map(action => action.action), ['unchanged', 'created']);
  assert.equal(underlying.listEvents().length, 2);
});

test('individual normalization requires contextual authority and never owns Ledger fields', () => {
  const result = normalizeWorkoutCompleted(nativeWorkout(), {
    assertedTimezone: TZ,
    observedAt: OBSERVED,
    sourceStateTimestamp: SNAPSHOT
  });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.draft, 'eventId'), false);
  assert.equal(Object.hasOwn(result.draft, 'recordedAt'), false);
  assert.equal(Object.hasOwn(result.draft, 'revision'), false);
});
