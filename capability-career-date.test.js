// node capability-career-date.test.js
//
// Regression suite for the date-only Life Ledger display bug (FIX 1).
//
// Capability/Career renders a date-precision Life Ledger event (temporalPrecision === 'date',
// e.g. meal_prepared) from its `occurredDate` (YYYY-MM-DD). The pre-fix code passed that
// string straight into `new Date('2026-08-30').toLocaleDateString(...)`, which is UTC
// midnight — so in any negative-UTC-offset viewer timezone (America/Phoenix) it rendered the
// day BEFORE the fact ("Aug 29, 2026"). `formatLedgerDate()` now formats date-only values
// from their calendar components in UTC, which no timezone can shift.
//
// Each real viewer timezone is exercised in its own child process with `TZ` set in the
// spawn environment (setting TZ after the runtime has started does not re-init it, and a
// POSIX shell may mangle an "Asia/Manila"-style value — the spawn env avoids both).

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { formatLedgerDate, ledgerEventDate } from './capability-career-date.js';

const SELF = fileURLToPath(import.meta.url);
const LOCALE = 'en-US';

const DATE_EVENT = { temporalPrecision: 'date', occurredDate: '2026-08-30' };
const LEAP_DATE_EVENT = { temporalPrecision: 'date', occurredDate: '2028-02-29' };
// 06:00Z is the previous calendar day in Phoenix (UTC-7 -> 23:00) and the same day in
// Manila (UTC+8 -> 14:00) — a genuine instant whose local calendar day differs by zone.
const INSTANT_EVENT = { occurredAt: '2026-08-30T06:00:00.000Z' };

function probe() {
  return {
    resolvedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    januaryOffsetMinutes: new Date('2026-01-01T00:00:00Z').getTimezoneOffset(),
    dateOnly2026: formatLedgerDate(ledgerEventDate(DATE_EVENT), LOCALE),
    leapDay: formatLedgerDate(ledgerEventDate(LEAP_DATE_EVENT), LOCALE),
    hostLocaleDateOnly: formatLedgerDate(ledgerEventDate(DATE_EVENT)),
    instant: formatLedgerDate(ledgerEventDate(INSTANT_EVENT), LOCALE),
    nullValue: formatLedgerDate(ledgerEventDate({}), LOCALE),
    // The pre-fix path, reproduced here so each run shows the bug it prevents.
    naive2026: new Date('2026-08-30').toLocaleDateString(LOCALE, {
      month: 'short', day: 'numeric', year: 'numeric'
    })
  };
}

if (process.env.CAREER_DATE_TEST_WORKER === '1') {
  process.stdout.write(JSON.stringify(probe()));
  process.exit(0);
}

function runInZone(timeZone) {
  const result = spawnSync(process.execPath, [SELF], {
    env: { ...process.env, TZ: timeZone, CAREER_DATE_TEST_WORKER: '1' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `worker for ${timeZone} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const ZONES = {
  phoenix: 'America/Phoenix',      // UTC-7, no DST — the timezone from the review finding
  manila: 'Asia/Manila',           // UTC+8, no DST — positive offset
  utc: 'UTC',
  pagoPago: 'Pacific/Pago_Pago',   // UTC-11, the largest negative offset
  kiritimati: 'Pacific/Kiritimati' // UTC+14, the largest positive offset
};

const observed = {};
for (const [name, tz] of Object.entries(ZONES)) observed[name] = runInZone(tz);

test('every timezone actually resolved to the zone under test (no silent fallback)', () => {
  assert.equal(observed.phoenix.resolvedTimezone, 'America/Phoenix');
  assert.equal(observed.manila.resolvedTimezone, 'Asia/Manila');
  assert.ok(observed.phoenix.januaryOffsetMinutes > 0, 'Phoenix must be a negative-UTC-offset zone');
  assert.ok(observed.manila.januaryOffsetMinutes < 0, 'Manila must be a positive-UTC-offset zone');
});

test('2026-08-30 renders as "Aug 30, 2026" in every timezone, positive and negative offset', () => {
  for (const [name, data] of Object.entries(observed)) {
    assert.equal(data.dateOnly2026, 'Aug 30, 2026', `${name} (${ZONES[name]})`);
  }
});

test('the pre-fix formatter genuinely mis-rendered the day in Phoenix and other negative-offset zones', () => {
  assert.equal(observed.phoenix.naive2026, 'Aug 29, 2026');
  assert.equal(observed.pagoPago.naive2026, 'Aug 29, 2026');
  // And is correct — by luck — for non-negative offsets, which is why the bug hid.
  assert.equal(observed.manila.naive2026, 'Aug 30, 2026');
});

test('a valid leap day (2028-02-29) renders as "Feb 29, 2028" in every timezone', () => {
  for (const [name, data] of Object.entries(observed)) {
    assert.equal(data.leapDay, 'Feb 29, 2028', `${name} (${ZONES[name]})`);
  }
});

test('date-only rendering with the host default locale still names the correct calendar day', () => {
  for (const [name, data] of Object.entries(observed)) {
    assert.ok(/\b30\b/.test(data.hostLocaleDateOnly), `${name}: ${data.hostLocaleDateOnly} should contain day 30`);
    assert.ok(/2026/.test(data.hostLocaleDateOnly), `${name}: ${data.hostLocaleDateOnly} should contain year 2026`);
    assert.ok(!/\b29\b/.test(data.hostLocaleDateOnly), `${name}: ${data.hostLocaleDateOnly} must not have shifted to the 29th`);
  }
});

test('instant-precision events keep local-time rendering (NOT forced to UTC by this fix)', () => {
  // The same instant is the 29th in Phoenix and the 30th in Manila — proof the instant
  // path is untouched and still viewer-local.
  assert.equal(observed.phoenix.instant, 'Aug 29, 2026');
  assert.equal(observed.manila.instant, 'Aug 30, 2026');
});

test('ledgerEventDate picks occurredDate for date events and occurredAt for instant events', () => {
  assert.equal(ledgerEventDate(DATE_EVENT), '2026-08-30');
  assert.equal(ledgerEventDate(INSTANT_EVENT), '2026-08-30T06:00:00.000Z');
  assert.ok(!ledgerEventDate(null));
});

test('a missing date value renders as "No date", never a shifted or Invalid Date string', () => {
  for (const [name, data] of Object.entries(observed)) {
    assert.equal(data.nullValue, 'No date', name);
  }
});

test('date-only events carry no factual occurredAt (the anchor is occurredDate only)', () => {
  assert.equal('occurredAt' in DATE_EVENT, false);
  assert.equal(ledgerEventDate(DATE_EVENT), DATE_EVENT.occurredDate);
});
