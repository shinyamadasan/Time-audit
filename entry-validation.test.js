import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const storage = readFileSync(new URL('./storage.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const index = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.parse('2026-10-24T12:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));

function fn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'source function missing: ' + name);
  return source.slice(start, end + 2);
}

function entry(extra = {}) {
  return { id: NOW, ts: NOW, tsStart: NOW - 60_000, updatedAt: NOW,
    blockIntervalMin: 1, date: '2026-10-24', activity: 'Synthetic task', energy: 'deep',
    category: 'deep', originalLabel: 'deep', ...extra };
}

function harness() {
  let now = NOW;
  const values = new Map();
  const warnings = [];
  const writes = [];
  const callbacks = [];
  const elements = new Map();
  const noop = () => {};
  const context = vm.createContext({
    crypto: webcrypto,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    console: { warn: (...args) => warnings.push({ message: args.slice(0, 2).join(' '), entry: clone(args[2]) }) },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    entries: [], settings: { intervalMin: 30, timezone: 'UTC', templates: [] },
    _settingsDefaults: { intervalMin: 30, timezone: 'UTC', templates: [] }, _localStateOwner: null,
    _syncGeneration: 0, roomCode: '', pendingPlanRemoteByDate: new Map(), pendingFenceRemoteByDate: new Map(),
    lastUndoAction: null, DEFAULT_PRESETS: [], AWAY_BUCKETS: {}, ensureTemplateSyncStamp: noop,
    detachTimerAwayRuntime: noop, restoreTimerAwayState: noop,
    getBucket: e => e.energy, plans: {}, reviews: {}, weeklyReviews: {}, focusRedemptions: [],
    intention: '', dailyCommitment: 0, snoozesUsedToday: 0, running: false, timerStartedAt: null,
    _timerStateOwner: null, _awayStateOwner: null, _breakStateOwner: null, awayActive: false,
    breakActive: false, breakStartTs: null, breakEndsAt: null,
    TIMER_STORAGE_KEY: 'ta3-timer', AWAY_STORAGE_KEY: 'ta3-away-state', BREAK_STORAGE_KEY: 'ta3-break-state',
    timerStateOwnedByCurrentAccount: () => false,
    toDateKey: d => d.toISOString().slice(0, 10), scheduleRenderToday: noop, renderWeek: noop,
    publishSharedAccountability: noop, publishPublicStats: noop,
    ownedRoomRef: () => context.roomCode ? { update: changes => { writes.push({ room: context.roomCode, changes: clone(changes) }); return Promise.resolve(); } } : null,
    fbDb: { ref: () => ({ on: (_event, callback) => callbacks.push(callback) }) },
    document: { getElementById: id => {
      if (!elements.has(id)) elements.set(id, { value: '', dataset: {}, style: {},
        classList: { add: noop, remove: noop, contains: () => false }, focus: noop });
      return elements.get(id);
    } },
    getDateInTZ: ts => new Date(ts).toISOString().slice(0, 10),
    tzParseTime: (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00Z'),
    tzDow: ts => new Date(ts).getUTCDay(),
    _dateKeyPlusDays: (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10),
    activityGroupKey: text => text.toLowerCase(), canonicalizeActivityInput: text => text,
    getActivityColor: noop, getEntriesOverlappingRange: () => [],
    taskStartTime: null, trackingStartedAt: null, _restoredTimerSync: null,
    rememberCreatedUndo: noop, showUndoToast: noop, fmtDur: String,
    COMMON_LOG_OPTIONS: [], getViewingDateKey: () => '2026-10-24',
    learnWastePattern: noop, resetRetroBar: noop, checkBudget: noop, showToast: noop,
    breakStateOwnerRoom: () => context.roomCode, timerStateOwnerRoom: () => context.roomCode,
    breakStateOwnedByCurrentAccount: () => true, clearInterval: noop, setInterval: () => 1,
    updateRing: noop, doPing: noop, syncTimerState: noop, syncBreakState: noop,
    breakTicker: null, ticker: null, currentTask: 'Synthetic task', lastTaskForRepeat: '',
    releaseBreakStateOwnership: noop, playAlert: noop, syncedDeviceId: 'fixture-device',
  });
  const begin = storage.indexOf('// ── Entry schema validation');
  const end = storage.indexOf('// ── Goal helpers', begin);
  assert.ok(begin >= 0 && end > begin);
  vm.runInContext(storage.slice(begin, end), context);
  for (const name of ['accountLocalKey', 'setAccountLocal', 'removeAccountLocal', 'bindAccountLocalState', 'persist', 'resolveEntrySync', 'syncEntries']) {
    vm.runInContext(fn(storage, name), context);
  }
  for (const name of ['autoTemplateEntryId', 'templateSkippedOnDate', 'templateCoverageDuration', 'templateSlotCovered', 'autoLogDueTemplates', 'endBreak', 'quickRetroLog']) {
    vm.runInContext(fn(index, name), context);
  }
  return {
    context, warnings, writes, values,
    setNow(value) { now = value; },
    rows() { return clone(context.entries); },
    bind(room, rows) {
      context.roomCode = room;
      if (rows) values.set('ta3-entries:' + room, JSON.stringify(rows));
      context.bindAccountLocalState(room);
    },
    listen() {
      const generation = context._syncGeneration;
      const room = context.roomCode;
      context.isCurrentSync = () => context.roomCode === room && context._syncGeneration === generation;
      const start = storage.indexOf("  fbDb.ref(" + String.fromCharCode(96) + 'rooms/${roomCode}/entries');
      const end = storage.indexOf("  fbDb.ref(" + String.fromCharCode(96) + 'rooms/${roomCode}/intention', start);
      assert.ok(start >= 0 && end > start, 'entry listener source anchors missing');
      vm.runInContext('(function(isCurrentSync) {' + storage.slice(start, end) + '})(isCurrentSync);', context);
      const callback = callbacks.at(-1);
      return value => callback({ val: () => clone(value) });
    },
  };
}

test('actual scheduled auto-log producer keeps its deterministic ID and does not falsely warn or repeat writes', () => {
  const h = harness();
  h.bind('uid_A', []);
  h.context.settings.templates = [{ id: 'schedule/fixture', activity: 'Synthetic scheduled work', energy: 'deep',
    enabled: true, autoLog: true, days: [6] }];
  h.context.templateSlotRange = (_tpl, day) => ({ tsStart: Date.parse(day + 'T01:00:00Z'), tsEnd: Date.parse(day + 'T11:00:00Z') });
  assert.equal(h.context.autoLogDueTemplates({ notify: false }), true);
  const [row] = h.rows();
  assert.equal(row.id, 'tpllog_schedule_fixture_2026-10-24');
  assert.equal(row.blockIntervalMin, 600);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.context.autoLogDueTemplates({ notify: false }), false);
  assert.equal(h.writes.length, 1);
  assert.equal(h.rows().length, 1);
});

test('scheduled IDs survive history edits without needing current templates, markers or matching dates', () => {
  const h = harness();
  const row = entry({ id: 'tpllog_old_template_2026-10-23', date: '2026-10-24' });
  h.context.validateEntry(row);
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(row, entry({ id: 'tpllog_old_template_2026-10-23', date: '2026-10-24' }));
});

for (const id of [0, -1, NaN, Infinity, null, {}, '', '123', 'tpl_hint_2026-10-24', 'unknown',
  'tpllog_a.b_2026-10-24', 'tpllog_a_2026-10-24\n', 'tpllog_a_2026-10-24/other']) {
  test('malformed or unsupported ID remains diagnostic: ' + String(id), () => {
    const h = harness();
    h.context.validateEntry(entry({ id }));
    assert.match(h.warnings[0]?.message || '', /id invalid/);
    assert.equal(h.writes.length, 0);
  });
}

test('other malformed fields remain diagnostic even with a legitimate scheduled ID', () => {
  const h = harness();
  h.context.validateEntry(entry({ id: 'tpllog_fixture_2026-10-24', ts: 0, blockIntervalMin: 0, activity: '', energy: 'unknown', date: 'invalid' }));
  assert.match(h.warnings[0].message, /ts invalid; blockIntervalMin < 1; activity missing; energy "unknown" not recognised; date "invalid" not YYYY-MM-DD/);
  assert.doesNotMatch(h.warnings[0].message, /id invalid/);
});

test('repeated account loads report real zero-minute history without changing its ID, interval or duration or syncing it', () => {
  const h = harness();
  const row = entry({ tsStart: NOW - 5400, blockIntervalMin: 0, energy: 'recovery', category: 'recovery', originalLabel: 'recovery' });
  h.bind('uid_A', [row]);
  h.bind('uid_B', [entry({ id: NOW + 1 })]);
  h.bind('uid_A');
  assert.equal(h.warnings.length, 2);
  assert.ok(h.warnings.every(w => w.message === '[validateEntry] blockIntervalMin < 1'));
  assert.deepEqual(h.rows(), [row]);
  assert.equal(h.writes.length, 0);
});

test('stable remote replay converges without revalidating unchanged rows or causing entry writes', () => {
  const h = harness();
  h.bind('uid_A', []);
  const deliver = h.listen();
  const row = entry({ tsStart: NOW - 5400, blockIntervalMin: 0 });
  deliver({ bare_alias: row, prefixed_alias: row });
  for (let n = 0; n < 20; n++) deliver({ bare_alias: row, prefixed_alias: row });
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.rows(), [row]);
  assert.equal(h.writes.length, 0);
  deliver({ prefixed_alias: { ...row, updatedAt: NOW + 1 } });
  assert.equal(h.warnings.length, 2, 'a genuinely newer malformed record is still diagnosed');
  assert.equal(h.rows()[0].blockIntervalMin, 0);
  h.bind('uid_B', [entry({ id: NOW + 2 })]);
  deliver({ stale: row });
  assert.equal(h.warnings.length, 2, 'detached account callback remains inert');
  assert.equal(h.rows()[0].id, NOW + 2);
});

test('unchanged malformed remote rows missing both timestamps can revalidate via the existing version fallback, without writing Firebase', () => {
  const h = harness();
  h.bind('uid_A', []);
  const deliver = h.listen();
  const row = entry({ ts: 0, updatedAt: 0, blockIntervalMin: 0 });
  for (let n = 0; n < 3; n++) { h.setNow(NOW + n * 1000); deliver({ row }); }
  assert.equal(h.warnings.length, 3);
  assert.equal(h.writes.length, 0);
  assert.equal(h.rows()[0].id, row.id);
  assert.equal(h.rows()[0].blockIntervalMin, 0);
});

test('explicit sync sends existing rows unchanged; its echo and validation do not schedule another sync', async () => {
  const h = harness();
  const rows = [entry({ id: 'tpllog_fixture_2026-10-24' }), entry({ id: NOW + 1, blockIntervalMin: 0 })];
  h.bind('uid_A', rows);
  const deliver = h.listen();
  await h.context.syncEntries();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(Object.values(h.writes[0].changes), h.rows());
  deliver(Object.fromEntries(h.rows().map(row => ['e_' + row.id, row])));
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.rows(), rows);
});

test('actual early-break producer keeps the owner sample 5.4-second interval as a valid one-minute record (TASK-026)', () => {
  const h = harness();
  h.bind('uid_A', []);
  h.context.breakActive = true;
  h.context.breakStartTs = NOW - 5400;
  assert.equal(h.context.endBreak('uid_A'), true);
  const [row] = h.rows();
  assert.equal(row.ts - row.tsStart, 5400);
  assert.equal(row.blockIntervalMin, 1);
  assert.equal(row.retro, undefined);
  assert.equal(row.autoLogged, undefined);
  h.context.validateEntry(row);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.writes.length, 1, 'one explicit producer sync, not a validation loop');
});

test('actual quick-retro 23:00-00:00 no longer creates an empty second fragment (TASK-026)', () => {
  const h = harness();
  h.bind('uid_A', []);
  h.context.document.getElementById('retro-task').value = 'Synthetic past work';
  h.context.document.getElementById('retro-qstart').value = '23:00';
  h.context.document.getElementById('retro-qend').value = '00:00';
  h.context.quickRetroLog();
  assert.deepEqual(h.rows().map(row => row.blockIntervalMin), [60]);
  assert.ok(h.rows().every(row => row.ts > row.tsStart));
  assert.equal(h.warnings.length, 0);
  assert.equal(h.writes.length, 1);
});

// TASK-026: duration contract at the producers. Exact timestamps are the tracked time; a
// positive interval is legitimate (at least one minute) and an empty interval is never stored.
function retroHarness() {
  const h = harness();
  Object.assign(h.context, { retroEnergy: 'deep', editingEntryId: null, editingMergedIds: null,
    editingEntryBase: null, _lastLoggedEntryId: null, sameEntryId: (a, b) => String(a) === String(b),
    cloneUndoValue: clone, maybeOfferTemplateUpdate: () => false, closeModal: () => {},
    formatEnergyLabel: String, confirm: () => false });
  vm.runInContext(fn(index, 'saveRetroEntry'), h.context);
  return h;
}

function fillRetroModal(h, start, end) {
  h.context.document.getElementById('retro-activity').value = 'Synthetic past work';
  h.context.document.getElementById('retro-start').value = start;
  h.context.document.getElementById('retro-end').value = end;
}

test('TASK-026 a normal break keeps its rounded duration and exact interval', () => {
  const h = harness();
  h.bind('uid_A', []);
  h.context.breakActive = true;
  h.context.breakStartTs = NOW - 25 * 60_000;
  assert.equal(h.context.endBreak('uid_A'), true);
  const [row] = h.rows();
  assert.equal(row.blockIntervalMin, 25);
  assert.equal(row.ts - row.tsStart, 25 * 60_000);
  assert.equal(h.warnings.length, 0);
});

test('TASK-026 a clock-skewed break with no positive interval stores no entry but still resumes the timer', () => {
  const h = harness();
  h.bind('uid_A', []);
  h.context.breakActive = true;
  h.context.breakStartTs = NOW + 2000;
  assert.equal(h.context.endBreak('uid_A'), true);
  assert.deepEqual(h.rows(), []);
  assert.equal(h.context.breakActive, false);
  assert.equal(h.context.running, true);
  assert.equal(h.warnings.length, 0);
});

test('TASK-026 quick retro ending exactly at midnight is one start-day record, not an empty fragment', () => {
  const h = harness();
  h.bind('uid_A', []);
  h.context.document.getElementById('retro-task').value = 'Synthetic past work';
  h.context.document.getElementById('retro-qstart').value = '23:00';
  h.context.document.getElementById('retro-qend').value = '00:00';
  h.context.quickRetroLog();
  const rows = h.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blockIntervalMin, 60);
  assert.equal(rows[0].date, '2026-10-24');
  assert.equal(rows[0].tsStart, Date.parse('2026-10-24T23:00:00Z'));
  assert.equal(rows[0].ts, Date.parse('2026-10-25T00:00:00Z'));
  assert.equal(h.warnings.length, 0);
});

test('TASK-026 quick retro that genuinely crosses midnight still splits by date', () => {
  const h = harness();
  h.bind('uid_A', []);
  h.context.document.getElementById('retro-task').value = 'Synthetic past work';
  h.context.document.getElementById('retro-qstart').value = '23:30';
  h.context.document.getElementById('retro-qend').value = '00:15';
  h.context.quickRetroLog();
  const rows = h.rows().sort((a, b) => a.tsStart - b.tsStart);
  assert.deepEqual(rows.map(row => [row.date, row.blockIntervalMin]), [['2026-10-24', 30], ['2026-10-25', 15]]);
  assert.equal(rows[0].ts, rows[1].tsStart);
  assert.equal(h.warnings.length, 0);
});

test('TASK-026 a positive sub-minute midnight fragment is kept with exact timestamps and one minute', () => {
  const h = harness();
  h.bind('uid_A', []);
  h.setNow(Date.parse('2026-10-25T00:00:10Z'));
  h.context.document.getElementById('retro-task').value = 'Synthetic past work';
  h.context.quickRetroLog();
  const rows = h.rows().sort((a, b) => a.tsStart - b.tsStart);
  assert.deepEqual(rows.map(row => [row.date, row.blockIntervalMin]), [['2026-10-24', 30], ['2026-10-25', 1]]);
  assert.equal(rows[1].ts - rows[1].tsStart, 10_000);
  assert.equal(rows[1].tsStart - rows[0].tsStart, 29 * 60_000 + 50_000);
  assert.equal(h.warnings.length, 0);
});

test('TASK-026 retro modal ending exactly at midnight is one record, still splits a real crossing', () => {
  const h = retroHarness();
  h.bind('uid_A', []);
  fillRetroModal(h, '23:00', '00:00');
  h.context.saveRetroEntry();
  assert.deepEqual(h.rows().map(row => [row.date, row.blockIntervalMin]), [['2026-10-24', 60]]);
  fillRetroModal(h, '23:45', '00:30');
  h.context.saveRetroEntry();
  assert.deepEqual(h.rows().map(row => row.blockIntervalMin).sort((a, b) => a - b), [15, 30, 60]);
  assert.ok(h.rows().every(row => row.ts > row.tsStart));
  assert.equal(h.warnings.length, 0);
});

test('TASK-026 editing a block to end exactly at midnight keeps its ID and creates no fragment', () => {
  const h = retroHarness();
  const original = entry({ id: 1_700_000_000_000, tsStart: Date.parse('2026-10-24T22:00:00Z'),
    ts: Date.parse('2026-10-24T22:30:00Z'), blockIntervalMin: 30, retro: true });
  h.bind('uid_A', [original]);
  h.context.editingEntryId = original.id;
  h.context.editingEntryBase = { startDate: new Date(original.tsStart), crossesMidnight: false };
  fillRetroModal(h, '23:00', '00:00');
  h.context.saveRetroEntry();
  const rows = h.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, original.id);
  assert.equal(rows[0].blockIntervalMin, 60);
  assert.equal(h.warnings.length, 0);
});

test('TASK-026 merged-block edit ending exactly at midnight replaces its sub-entries with one record', () => {
  const h = retroHarness();
  const a = entry({ id: 1_700_000_000_001, tsStart: Date.parse('2026-10-24T22:00:00Z'), ts: Date.parse('2026-10-24T22:30:00Z'), blockIntervalMin: 30 });
  const b = entry({ id: 1_700_000_000_002, tsStart: Date.parse('2026-10-24T22:30:00Z'), ts: Date.parse('2026-10-24T23:00:00Z'), blockIntervalMin: 30 });
  h.bind('uid_A', [a, b]);
  h.context.editingEntryId = a.id;
  h.context.editingMergedIds = [a.id, b.id];
  h.context.editingEntryBase = { startDate: new Date(a.tsStart), crossesMidnight: false };
  fillRetroModal(h, '22:00', '00:00');
  h.context.saveRetroEntry();
  assert.deepEqual(h.rows().map(row => [row.id, row.blockIntervalMin]), [[a.id, 120]]);
  assert.equal(h.warnings.length, 0);
});

test('TASK-026 editing a scheduled auto-log to end exactly at midnight keeps its tpllog ID and markers', () => {
  const h = retroHarness();
  const original = entry({ id: 'tpllog_fixture_2026-10-24', tsStart: Date.parse('2026-10-24T22:00:00Z'),
    ts: Date.parse('2026-10-24T23:00:00Z'), blockIntervalMin: 60, autoLogged: true,
    scheduledAutoLog: true, templateId: 'fixture' });
  h.bind('uid_A', [original]);
  h.context.editingEntryId = original.id;
  h.context.editingEntryBase = { startDate: new Date(original.tsStart), crossesMidnight: false };
  fillRetroModal(h, '22:00', '00:00');
  h.context.saveRetroEntry();
  const rows = h.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, original.id);
  assert.equal(rows[0].blockIntervalMin, 120);
  assert.deepEqual([rows[0].autoLogged, rows[0].scheduledAutoLog, rows[0].templateId], [true, true, 'fixture']);
  assert.equal(h.warnings.length, 0);
});

test('TASK-026 a break with no positive interval offers no undo for a record that does not exist', () => {
  const h = harness();
  const calls = [];
  Object.assign(h.context, { rememberCreatedUndo: (...args) => calls.push(['undo', ...args]),
    showUndoToast: (...args) => calls.push(['undoToast', ...args]), showToast: text => calls.push(['toast', text]) });
  h.bind('uid_A', []);
  h.context.breakActive = true;
  h.context.breakStartTs = NOW;
  assert.equal(h.context.endBreak('uid_A'), true);
  assert.deepEqual(h.rows(), []);
  assert.deepEqual(calls, [['toast', 'Break over']]);
});
