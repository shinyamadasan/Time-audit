import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import {
  normalizeChronaSenseEntries,
  readChronaSenseLifeLedgerForDate
} from './chronasense-life-ledger-adapter.js';
import {
  deriveLifeLedgerKey,
  fingerprintLifeLedgerEvent,
  serializeLifeLedgerFacts,
  validateLifeLedgerEventDraft
} from './life-ledger-core.js';

const storageSource = readFileSync(new URL('./storage.js', import.meta.url), 'utf8');
const observedAt = '2026-09-07T12:00:00.000Z';
const sourceTimezone = 'America/Phoenix';

function entry(id, start = '2026-09-06T10:00:00-07:00', overrides = {}) {
  const tsStart = Date.parse(start);
  return {
    id, tsStart, ts: tsStart + 30 * 60000,
    activity: 'Deep work', energy: 'deep', date: '1999-01-01',
    ...overrides
  };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Load the real classic-script reader, including its configured/device timezone fallback.
// storage.js has startup writes; arm traps AFTER initialization to isolate read side effects.
function fixture(entries, timezone = sourceTimezone) {
  const sourceBytes = JSON.stringify(entries);
  freeze(entries);
  const persisted = new Map([
    ['ta3-device-id', 'fixture-device'],
    ['ta3-life-ledger-v1', '{"sentinel":"untouched"}'],
    ['ta3-entries', sourceBytes]
  ]);
  let armed = false;
  const calls = [];
  const forbid = name => {
    calls.push(name);
    throw new Error('Unexpected side effect: ' + name);
  };
  const sandbox = {
    entries, settings: freeze({ timezone }),
    localStorage: {
      getItem(key) { if (armed) return forbid('localStorage.getItem'); return persisted.get(key) ?? null; },
      setItem(key, value) { if (armed) return forbid('localStorage.setItem'); persisted.set(key, value); },
      removeItem() { return forbid('localStorage.removeItem'); },
      clear() { return forbid('localStorage.clear'); }
    },
    fetch() { return forbid('fetch'); },
    firebase: new Proxy({}, { get() { return forbid('firebase'); } }),
    crypto: { randomUUID() { return forbid('randomUUID'); } }
  };
  vm.createContext(sandbox);
  vm.runInContext(storageSource, sandbox);
  armed = true;
  const persistedBefore = [...persisted];
  const options = {
    getEntriesForDate: sandbox.getEntriesForDate,
    sourceTimezone: timezone,
    observedAt
  };
  return {
    options,
    read: date => readChronaSenseLifeLedgerForDate(date, options),
    verify() {
      assert.deepEqual(calls, []);
      assert.deepEqual([...persisted], persistedBefore);
      assert.equal(JSON.stringify(entries), sourceBytes);
    }
  };
}

test('normal date: multiple canonical drafts, stable source IDs, contract and legacy normalization parity', () => {
  const f = fixture([entry(42), entry('alpha'), entry('other', '2026-09-05T10:00:00-07:00')]);
  const result = f.read('2026-09-06');
  assert.equal(result.drafts.length, 2);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result, normalizeChronaSenseEntries(f.options.getEntriesForDate('2026-09-06'), f.options));
  assert.deepEqual(result.drafts.map(d => d.sourceEntityId), ['42', 'alpha']);
  for (const draft of result.drafts) {
    assert.equal(validateLifeLedgerEventDraft(draft).ok, true);
    assert.equal(draft.type, 'activity_logged');
    assert.equal(draft.occurredAt, '2026-09-06T17:30:00.000Z');
    assert.equal(draft.occurredDate, undefined);
    for (const key of ['eventId', 'recordedAt', 'revision', 'revisedAt']) assert.equal(key in draft, false);
  }
  f.verify();
});

test('empty date returns the existing empty adapter result', () => {
  const f = fixture([entry('a')]);
  assert.deepEqual(f.read('2026-09-05'), { drafts: [], rejected: [] });
  f.verify();
});

test('fixed context gives byte-identical replay; valid source permutation keeps draft bytes and identities', () => {
  const rows = [entry('z'), entry('a')];
  const f = fixture(rows);
  const first = f.read('2026-09-06');
  assert.equal(JSON.stringify(f.read('2026-09-06')), JSON.stringify(first));
  assert.equal(JSON.stringify(fixture([...rows].reverse()).read('2026-09-06')), JSON.stringify(first));
  const later = readChronaSenseLifeLedgerForDate('2026-09-06', { ...f.options, observedAt: '2026-09-08T12:00:00.000Z' });
  assert.deepEqual(later.drafts.map(deriveLifeLedgerKey), first.drafts.map(deriveLifeLedgerKey));
  assert.deepEqual(later.drafts.map(serializeLifeLedgerFacts), first.drafts.map(serializeLifeLedgerFacts));
  assert.deepEqual(later.drafts.map(fingerprintLifeLedgerEvent), first.drafts.map(fingerprintLifeLedgerEvent));
  f.verify();
});

test('malformed selected records retain adapter rejection reasons and indexes', () => {
  const rows = [entry('good'), entry('bad', undefined, { activity: '' }), entry(null),
    entry('interval', undefined, { ts: 0 }), entry('missed', undefined, { missed: true }),
    entry('template', undefined, { template: true }), entry('gap', undefined, { isGap: true })];
  const f = fixture(rows);
  const expected = normalizeChronaSenseEntries(f.options.getEntriesForDate('2026-09-06'), f.options);
  assert.deepEqual(f.read('2026-09-06'), expected);
  assert.equal(expected.drafts.length, 1);
  assert.equal(expected.rejected.length, 6);
  f.verify();
});

test('identical duplicates collapse; conflicting duplicates retain existing adapter outcomes', () => {
  const f = fixture([entry('a'), entry('a'), entry('b'), entry('b', undefined, { activity: 'Changed' })]);
  const result = f.read('2026-09-06');
  assert.deepEqual(result, normalizeChronaSenseEntries(f.options.getEntriesForDate('2026-09-06'), f.options));
  assert.deepEqual(result.drafts.map(d => d.sourceEntityId), ['a']);
  assert.equal(result.rejected[0].reason, 'conflicting_duplicate_physical_input');
  assert.deepEqual(result.rejected[0].indexes, [2, 3]);
  assert.equal(JSON.stringify(f.read('2026-09-06')), JSON.stringify(result));
  f.verify();
});

test('deleted source rows are excluded by the existing reader, without tombstone operations', () => {
  const f = fixture([entry('active'), entry('deleted', undefined, { deleted: true })]);
  assert.deepEqual(f.read('2026-09-06').drafts.map(d => d.sourceEntityId), ['active']);
  f.verify();
});

for (const [timezone, offset] of [['Asia/Tokyo', '+09:00'], ['America/Phoenix', '-07:00']]) {
  test(timezone + ': before midnight, exact midnight, after midnight; stale stored date ignored', () => {
    const f = fixture([
      entry('before', '2026-09-06T23:59:00' + offset),
      entry('midnight', '2026-09-07T00:00:00' + offset),
      entry('after', '2026-09-07T00:01:00' + offset)
    ], timezone);
    const before = f.read('2026-09-06');
    assert.deepEqual(before.drafts.map(d => d.sourceEntityId), ['before']);
    assert.equal(before.drafts[0].occurredAt, new Date(Date.parse('2026-09-07T00:29:00' + offset)).toISOString());
    assert.equal(before.drafts[0].payload.startedAt, new Date(Date.parse('2026-09-06T23:59:00' + offset)).toISOString());
    assert.deepEqual(f.read('2026-09-07').drafts.map(d => d.sourceEntityId), ['after', 'midnight']);
    f.verify();
  });
}

test('missing tsStart selects by ts, even when the adapter derives a prior-day interval start', () => {
  const f = fixture([entry('fallback', undefined, {
    tsStart: undefined, ts: Date.parse('2026-09-07T00:01:00-07:00'), blockIntervalMin: 30
  })]);
  assert.equal(f.read('2026-09-06').drafts.length, 0);
  const draft = f.read('2026-09-07').drafts[0];
  assert.equal(draft.payload.startedAt, '2026-09-07T06:31:00.000Z');
  assert.equal(draft.occurredAt, '2026-09-07T07:01:00.000Z');
  f.verify();
});

for (const [date, before, after, next] of [
  ['2026-03-08', '2026-03-08T01:59:00-05:00', '2026-03-08T03:01:00-04:00', '2026-03-09T00:00:00-04:00'],
  ['2026-11-01', '2026-11-01T01:30:00-04:00', '2026-11-01T01:30:00-05:00', '2026-11-02T00:00:00-05:00']
]) {
  test('America/New_York DST date ' + date + ' selects both instants, excludes next local day', () => {
    const f = fixture([entry('a', before), entry('b', after), entry('next', next)], 'America/New_York');
    const result = f.read(date);
    assert.deepEqual(result.drafts.map(d => d.sourceEntityId), ['a', 'b']);
    assert.deepEqual(result.drafts.map(d => d.payload.startedAt), [before, after].map(t => new Date(t).toISOString()));
    f.verify();
  });
}

test('explicit Phoenix timezone overrides Tokyo reader settings on both query dates', () => {
  const f = fixture([entry('boundary', '2026-09-07T00:05:00+09:00')], 'Asia/Tokyo');
  // The legacy one-argument reader still uses Tokyo settings.
  assert.equal(f.options.getEntriesForDate('2026-09-07').length, 1);
  assert.equal(f.options.getEntriesForDate('2026-09-06').length, 0);
  const options = { ...f.options, sourceTimezone: 'America/Phoenix' };
  assert.deepEqual(readChronaSenseLifeLedgerForDate('2026-09-07', options), { drafts: [], rejected: [] });
  const result = readChronaSenseLifeLedgerForDate('2026-09-06', options);
  assert.deepEqual(result.drafts.map(d => d.sourceEntityId), ['boundary']);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.drafts[0].sourceTimezone, 'America/Phoenix');
  assert.equal(result.drafts[0].payload.startedAt, '2026-09-06T15:05:00.000Z');
  assert.equal(result.drafts[0].occurredAt, '2026-09-06T15:35:00.000Z');
  f.verify();
});

test('explicit timezone exports valid drafts with no configured device timezone', () => {
  const f = fixture([entry('a')], '');
  const result = readChronaSenseLifeLedgerForDate('2026-09-06', { ...f.options, sourceTimezone });
  assert.deepEqual(result.drafts.map(d => d.sourceEntityId), ['a']);
  assert.deepEqual(result.rejected, []);
  assert.equal(validateLifeLedgerEventDraft(result.drafts[0]).ok, true);
  f.verify();
});

for (const populated of [false, true]) {
  for (const timezone of [undefined, 'Invalid/Zone']) {
    test(`${populated ? 'populated' : 'empty'} day rejects ${timezone || 'missing'} timezone before reading`, () => {
      const f = fixture(populated ? [entry('a')] : []);
      let reads = 0;
      assert.throws(() => readChronaSenseLifeLedgerForDate('2026-09-06', {
        ...f.options,
        sourceTimezone: timezone,
        getEntriesForDate(...args) { reads++; return f.options.getEntriesForDate(...args); }
      }), { name: 'RangeError', message: 'sourceTimezone must be an explicit valid IANA timezone containing /' });
      assert.equal(reads, 0);
      f.verify();
    });
  }
}

test('unsplit midnight record stays whole; physical splits belong to their respective days', () => {
  const f = fixture([
    entry('whole', '2026-09-06T23:55:00-07:00', { ts: Date.parse('2026-09-07T00:10:00-07:00') }),
    entry('part-a', '2026-09-06T23:55:00-07:00', { ts: Date.parse('2026-09-07T00:00:00-07:00') }),
    entry('part-b', '2026-09-07T00:00:00-07:00', { ts: Date.parse('2026-09-07T00:10:00-07:00') })
  ]);
  const first = f.read('2026-09-06');
  const second = f.read('2026-09-07');
  assert.deepEqual(first.drafts.map(d => d.sourceEntityId), ['part-a', 'whole']);
  assert.deepEqual(second.drafts.map(d => d.sourceEntityId), ['part-b']);
  assert.deepEqual(first.drafts.map(d => d.payload.durationMinutes), [5, 15]);
  assert.equal(first.drafts[1].payload.startedAt, '2026-09-07T06:55:00.000Z');
  assert.equal(first.drafts[1].occurredAt, '2026-09-07T07:10:00.000Z');
  assert.equal(second.drafts[0].payload.startedAt, '2026-09-07T07:00:00.000Z');
  assert.equal(second.drafts[0].payload.durationMinutes, 10);
  f.verify();
});

test('invalid date is rejected before reading source; leap day is accepted', () => {
  let reads = 0;
  const options = { getEntriesForDate() { reads++; return []; }, sourceTimezone, observedAt };
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-9-06', '', null, 20260906, '2026-09-06T00:00:00Z']) {
    assert.throws(() => readChronaSenseLifeLedgerForDate(date, options), RangeError);
  }
  assert.equal(reads, 0);
  assert.deepEqual(readChronaSenseLifeLedgerForDate('2024-02-29', options), { drafts: [], rejected: [] });
  assert.equal(reads, 1);
  assert.throws(() => readChronaSenseLifeLedgerForDate('2026-09-06'), TypeError);
});

test('reader errors propagate; malformed reader output and missing observation retain adapter semantics', () => {
  const error = new Error('source read failed');
  assert.throws(() => readChronaSenseLifeLedgerForDate('2026-09-06', {
    sourceTimezone, getEntriesForDate() { throw error; }
  }), err => err === error);
  for (const rows of [null, [null, {}, entry('a')]]) {
    assert.deepEqual(readChronaSenseLifeLedgerForDate('2026-09-06', {
      sourceTimezone, getEntriesForDate: () => rows
    }), normalizeChronaSenseEntries(rows, { sourceTimezone }));
  }
});

test('read API itself never accesses browser stores, network, or durable ID generation', () => {
  const keys = ['localStorage', 'firebase', 'fetch', 'crypto'];
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  try {
    keys.forEach(key => Object.defineProperty(globalThis, key, {
      configurable: true, get() { throw new Error('Unexpected access: ' + key); }
    }));
    const f = fixture([entry('a')]);
    assert.equal(f.read('2026-09-06').drafts.length, 1);
    f.verify();
  } finally {
    keys.forEach((key, i) => {
      if (descriptors[i]) Object.defineProperty(globalThis, key, descriptors[i]);
      else delete globalThis[key];
    });
  }
});
