// node time-truth-timezone.test.js
//
// Time Truth V1 — proves the core invariant: for a FIXED account timezone
// (settings.timezone), the same absolute instant resolves to the same ChronaSense
// dateKey/week-key/planned-time regardless of which OS timezone the device running
// the code happens to be in. Device timezone is exercised by actually spawning child
// processes with different `TZ` env values (the only way to change what
// Intl/Date resolve to at runtime — setting process.env.TZ after start does not
// re-init ICU), mirroring the existing pattern in capability-career-date.test.js.
//
// Scenario from the Time Truth V1 brief:
//   account timezone : Asia/Manila
//   device A (work PC): America/Phoenix
//   device B (phone)  : Asia/Manila
//   instant           : 2026-09-11T01:30:00Z  (Phoenix: Sep 10 evening; Manila: Sep 11 morning)
// Both devices must resolve this instant to the SAME ChronaSense date (2026-09-11,
// the Manila/account-timezone day) — never Phoenix's calendar day.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const SELF = fileURLToPath(import.meta.url);
const storageSource = readFileSync(new URL('./storage.js', import.meta.url), 'utf8');

const ACCOUNT_TZ = 'Asia/Manila';
const INSTANT = '2026-09-11T01:30:00.000Z';        // Phoenix: Sep 10, 18:30; Manila: Sep 11, 09:30
const MIDNIGHT_CROSS_START = '2026-09-11T15:50:00.000Z'; // 23:50 Manila
const MIDNIGHT_CROSS_END = '2026-09-11T16:20:00.000Z';   // 00:20 Manila (next day)
const PLAN_DATE_KEY = '2026-09-12';
const PLAN_WHEN = '09:00';

/** Loads the real storage.js in a minimal vm sandbox with a fixed settings.timezone. */
function loadStorage(timezone) {
  const sandbox = {
    settings: { timezone },
    entries: [],
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    fetch() { throw new Error('fetch should not be called'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(storageSource, sandbox);
  return sandbox;
}

function probe() {
  const sandbox = loadStorage(ACCOUNT_TZ);
  const instantMs = Date.parse(INSTANT);
  return {
    resolvedDeviceTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dateKeyForInstant: sandbox.getDateInTZ(instantMs, ACCOUNT_TZ),
    // toDateKey() reads settings.timezone (the account timezone) — never the device's.
    toDateKeyForInstant: sandbox.toDateKey(new Date(instantMs)),
    // Planned "09:00 Asia/Manila on 2026-09-12" resolved to an absolute instant.
    plannedInstant: sandbox.tzParseTime(PLAN_DATE_KEY, PLAN_WHEN),
    // ISO week key for a fixed "now", resolved in the account timezone.
    weekKeyForInstant: sandbox.getWeekKey(new Date(sandbox.getDateInTZ(instantMs, ACCOUNT_TZ) + 'T12:00:00Z')),
    // Midnight-crossing interval, split at the account-timezone day boundary the same
    // way sumEntryMinutes()/clipEntryToDateForDisplay() in index.html do.
    beforeMidnightDateKey: sandbox.getDateInTZ(Date.parse(MIDNIGHT_CROSS_START), ACCOUNT_TZ),
    afterMidnightDateKey: sandbox.getDateInTZ(Date.parse(MIDNIGHT_CROSS_END) - 1, ACCOUNT_TZ),
    dayBoundaryTs: sandbox.tzParseTime(sandbox.getDateInTZ(Date.parse(MIDNIGHT_CROSS_END), ACCOUNT_TZ), '00:00')
  };
}

if (process.env.TIME_TRUTH_TZ_WORKER === '1') {
  process.stdout.write(JSON.stringify(probe()));
  process.exit(0);
}

function runInDeviceZone(deviceTimezone) {
  const result = spawnSync(process.execPath, [SELF], {
    env: { ...process.env, TZ: deviceTimezone, TIME_TRUTH_TZ_WORKER: '1' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `worker for device TZ ${deviceTimezone} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const phoenix = runInDeviceZone('America/Phoenix');
const manila = runInDeviceZone('Asia/Manila');
const utc = runInDeviceZone('UTC');

test('each worker actually ran under the device timezone it claims (no silent fallback)', () => {
  assert.equal(phoenix.resolvedDeviceTimezone, 'America/Phoenix');
  assert.equal(manila.resolvedDeviceTimezone, 'Asia/Manila');
  assert.equal(utc.resolvedDeviceTimezone, 'UTC');
  // Sanity: this instant really does land on different calendar days device-locally —
  // otherwise the test would prove nothing.
  assert.notEqual(phoenix.resolvedDeviceTimezone, manila.resolvedDeviceTimezone);
});

test('same absolute instant -> same ChronaSense dateKey on a Phoenix-OS device and a Manila-OS device', () => {
  assert.equal(phoenix.dateKeyForInstant, '2026-09-11');
  assert.equal(manila.dateKeyForInstant, '2026-09-11');
  assert.equal(utc.dateKeyForInstant, '2026-09-11');
  assert.equal(phoenix.toDateKeyForInstant, manila.toDateKeyForInstant);
  assert.equal(phoenix.toDateKeyForInstant, '2026-09-11');
});

test('planned "09:00 Asia/Manila" resolves to the identical absolute instant regardless of device OS timezone', () => {
  assert.equal(phoenix.plannedInstant, manila.plannedInstant);
  assert.equal(phoenix.plannedInstant, utc.plannedInstant);
  // 09:00 Manila (UTC+8) on 2026-09-12 == 2026-09-12T01:00:00Z
  assert.equal(new Date(phoenix.plannedInstant).toISOString(), '2026-09-12T01:00:00.000Z');
});

test('ISO week key for the same instant is identical across device timezones', () => {
  assert.equal(phoenix.weekKeyForInstant, manila.weekKeyForInstant);
  assert.equal(phoenix.weekKeyForInstant, utc.weekKeyForInstant);
});

test('a 23:50->00:20 Asia/Manila interval clips 10m to the prior day and 20m to the next, on every device', () => {
  for (const w of [phoenix, manila, utc]) {
    assert.equal(w.beforeMidnightDateKey, '2026-09-11');
    assert.equal(w.afterMidnightDateKey, '2026-09-12');
    const clipMs = w.dayBoundaryTs - Date.parse(MIDNIGHT_CROSS_START);
    const tailMs = Date.parse(MIDNIGHT_CROSS_END) - w.dayBoundaryTs;
    assert.equal(clipMs / 60000, 10);
    assert.equal(tailMs / 60000, 20);
  }
});

test('device timezone alone (no account timezone set) DOES change the dateKey — this is exactly the bug the account timezone fixes', () => {
  // Demonstrates why settings.timezone must be authoritative: without it, getDateInTZ
  // falls back to the device's own resolved timezone, and the two devices disagree.
  const phoenixNoAccountTz = spawnSync(process.execPath, ['-e', `
    const vm = require('node:vm');
    const fs = require('node:fs');
    const src = fs.readFileSync(${JSON.stringify(fileURLToPath(new URL('./storage.js', import.meta.url)))}, 'utf8');
    const sandbox = { settings: {}, entries: [], localStorage: { getItem: () => null, setItem(){}, removeItem(){}, clear(){} } };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    process.stdout.write(sandbox.getDateInTZ(Date.parse('${INSTANT}')));
  `], { env: { ...process.env, TZ: 'America/Phoenix' }, encoding: 'utf8' });
  const manilaNoAccountTz = spawnSync(process.execPath, ['-e', `
    const vm = require('node:vm');
    const fs = require('node:fs');
    const src = fs.readFileSync(${JSON.stringify(fileURLToPath(new URL('./storage.js', import.meta.url)))}, 'utf8');
    const sandbox = { settings: {}, entries: [], localStorage: { getItem: () => null, setItem(){}, removeItem(){}, clear(){} } };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    process.stdout.write(sandbox.getDateInTZ(Date.parse('${INSTANT}')));
  `], { env: { ...process.env, TZ: 'Asia/Manila' }, encoding: 'utf8' });
  assert.equal(phoenixNoAccountTz.stdout, '2026-09-10');
  assert.equal(manilaNoAccountTz.stdout, '2026-09-11');
  assert.notEqual(phoenixNoAccountTz.stdout, manilaNoAccountTz.stdout);
});
