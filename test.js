// node test.js
import assert from 'node:assert/strict';
import './focus-wallet.js';
import {
  normalizeChronaSenseEntries,
  normalizeChronaSenseEntry
} from './chronasense-life-ledger-adapter.js';
import {
  createLifeLedgerMemoryStore,
  deriveLifeLedgerKey,
  fingerprintLifeLedgerEvent,
  serializeLifeLedgerFacts,
  upsertLifeLedgerEvent,
  upsertManyLifeLedgerEvents,
  validateLifeLedgerEvent,
  validateLifeLedgerEventDraft
} from './life-ledger-core.js';
import {
  addLesson,
  addPhase,
  addStep,
  completeStep,
  createLearningPlan,
  createLesson,
  createPhase,
  createStep,
  getLearningPlanProgress,
  hydrateLearningPlan,
  renameLesson,
  renamePhase,
  renamePlan,
  renameStep,
  reopenStep,
  reorderLessons,
  reorderPhases,
  reorderSteps,
  serializeLearningPlan,
  validateLearningPlan
} from './learning-plan-model.js';

const { computeFocusWallet, getFocusWalletWeekKey } = globalThis;

// ── Extracted pure functions ────────────────────────────────────────────────

function fmt(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDur(min) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function computeDeepScore(arr) {
  return arr.length ? Math.round(arr.filter(e => e.energy === 'deep').length / arr.length * 100) : 0;
}

function testDateKeyPlusDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0)).toISOString().slice(0, 10);
}

function testEntryDurationMinutes(entry, fallbackMin = 30) {
  if (entry.tsStart && entry.ts && entry.ts > entry.tsStart) {
    return Math.max(1, Math.round((entry.ts - entry.tsStart) / 60000));
  }
  return entry.blockIntervalMin || fallbackMin;
}

function testEntryTimeRange(entry, fallbackMin = 30) {
  if (!entry || !entry.ts) return null;
  const end = Number(entry.ts);
  const start = entry.tsStart ? Number(entry.tsStart) : end - testEntryDurationMinutes(entry, fallbackMin) * 60000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function isSameDeletionTarget(entry, target) {
  if (!entry || !target || entry.deleted) return false;
  if (entry.id === target.id) return true;
  if (String(entry.activity || '').trim().toLowerCase() !== String(target.activity || '').trim().toLowerCase()) return false;
  if ((entry.energy || '') !== (target.energy || '')) return false;
  const a = testEntryTimeRange(entry);
  const b = testEntryTimeRange(target);
  if (!a || !b) return false;
  const toleranceMs = 60 * 1000;
  return Math.abs(a.start - b.start) <= toleranceMs && Math.abs(a.end - b.end) <= toleranceMs;
}

function clipEntryToDateForDisplay(entry, dateKey, intervalMin = 30, includeDeleted = false) {
  if (!entry || (entry.deleted && !includeDeleted)) return null;
  const range = testEntryTimeRange(entry, intervalMin);
  if (!range) return entry.date === dateKey ? entry : null;
  const dayStart = Date.parse(dateKey + 'T00:00:00.000Z');
  const dayEnd = Date.parse(testDateKeyPlusDays(dateKey, 1) + 'T00:00:00.000Z');
  const start = Math.max(range.start, dayStart);
  const end = Math.min(range.end, dayEnd);
  if (end <= start) return null;
  if (start === range.start && end === range.end) return entry;
  return {
    ...entry,
    tsStart: start,
    ts: end,
    blockIntervalMin: Math.max(1, Math.round((end - start) / 60000)),
    _clippedToDate: dateKey
  };
}

function getEntriesForDateWindow(entriesArr, dateKey, intervalMin = 30, includeDeleted = false) {
  return entriesArr.map(e => clipEntryToDateForDisplay(e, dateKey, intervalMin, includeDeleted)).filter(Boolean);
}

function todayRenderKey(dateKey, entriesArr) {
  return dateKey + '|' + entriesArr.map(e => [e.id, e.tsStart || '', e.ts || '', e.updatedAt || ''].join(':')).join(',');
}

function shouldRenderOnDateTick(lastDateKey, currentDateKey) {
  return !!currentDateKey && currentDateKey !== lastDateKey;
}

function resolveEntrySync(local, remote, nowTs = Date.now()) {
  if (!remote || !remote.id) return { action: 'skip' };
  const remoteEntry = remote.updatedAt ? remote : { ...remote, updatedAt: remote.ts || nowTs };
  if (!local) {
    return remoteEntry.deleted ? { action: 'skip' } : { action: 'add', entry: remoteEntry };
  }
  if (local.deleted && !remoteEntry.deleted) {
    const remoteV = remoteEntry.updatedAt || remoteEntry.ts || 0;
    const localV = local.updatedAt || local.ts || 0;
    if (remoteEntry.undoRestoredAt && remoteV > localV) return { action: 'replace', entry: remoteEntry };
    return { action: 'keep-local' };
  }
  const remoteV = remoteEntry.updatedAt || remoteEntry.ts || 0;
  const localV = local.updatedAt || local.ts || 0;
  return remoteV > localV ? { action: 'replace', entry: remoteEntry } : { action: 'keep-local' };
}

function testSameUndoId(a, b) {
  return String(a) === String(b);
}

function testTombstoneUndoEntries(entriesArr, entryIds, nowTs) {
  let changed = false;
  (entryIds || []).forEach(id => {
    const idx = entriesArr.findIndex(e => testSameUndoId(e.id, id));
    if (idx >= 0) entriesArr[idx] = { ...entriesArr[idx], deleted: true, updatedAt: nowTs };
    else entriesArr.push({ id, ts: nowTs, deleted: true, updatedAt: nowTs });
    changed = true;
  });
  return changed;
}

function testRestoreUndoEntries(entriesArr, snapshots, nowTs) {
  let changed = false;
  (snapshots || []).forEach(snapshot => {
    if (!snapshot || snapshot.id == null) return;
    const restored = JSON.parse(JSON.stringify(snapshot));
    restored.updatedAt = nowTs;
    restored.undoRestoredAt = nowTs;
    if (!snapshot.deleted) delete restored.deleted;
    const idx = entriesArr.findIndex(e => testSameUndoId(e.id, restored.id));
    if (idx >= 0) entriesArr[idx] = restored;
    else entriesArr.push(restored);
    changed = true;
  });
  return changed;
}

function testTombstoneUndoRedemptions(redemptionsArr, redemptionIds, nowTs) {
  let changed = false;
  (redemptionIds || []).forEach(id => {
    const idx = redemptionsArr.findIndex(r => testSameUndoId(r.id, id));
    if (idx >= 0) redemptionsArr[idx] = { ...redemptionsArr[idx], deleted: true, updatedAt: nowTs };
    else redemptionsArr.push({ id, deleted: true, updatedAt: nowTs });
    changed = true;
  });
  return changed;
}

function normalizeActivityForTemplate(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function entryCoversTemplateSlot(entry, tpl) {
  if (!entry || entry.missed) return false;
  if (!entry.deleted) return true;
  const entryActivity = String(normalizeActivityForTemplate(String(entry.activity || '').trim()) || '').toLowerCase();
  const tplActivity = String(normalizeActivityForTemplate(String(tpl.activity || '').trim()) || '').toLowerCase();
  return entryActivity === tplActivity && entry.energy === tpl.energy;
}

function testDataDoctorDateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function testDataDoctorIssueEntry(entry, index, range) {
  const anchor = range ? range.start : Number(entry?.tsStart || entry?.ts);
  return {
    index,
    id: entry?.id ?? 'missing',
    date: Number.isFinite(anchor) ? testDataDoctorDateKey(anchor) : (entry?.date || 'unknown'),
    activity: entry?.activity || 'Untitled',
    energy: entry?.energy || 'unknown',
    deleted: !!entry?.deleted
  };
}

function testDataDoctorDuplicateKey(entry, range) {
  return [
    String(entry.activity || '').trim().toLowerCase(),
    entry.energy || '',
    Math.round(range.start / 60000),
    Math.round(range.end / 60000)
  ].join('|');
}

function testDataDoctorAddDayMinutes(dayTotals, range) {
  let cursor = range.start;
  let guard = 0;
  while (cursor < range.end && guard++ < 370) {
    const dateKey = testDataDoctorDateKey(cursor);
    const dayStart = Date.parse(dateKey + 'T00:00:00.000Z');
    const dayEnd = Date.parse(testDateKeyPlusDays(dateKey, 1) + 'T00:00:00.000Z');
    const start = Math.max(range.start, dayStart);
    const end = Math.min(range.end, dayEnd);
    if (end > start) dayTotals.set(dateKey, (dayTotals.get(dateKey) || 0) + Math.round((end - start) / 60000));
    cursor = Math.max(dayEnd, cursor + 60000);
  }
}

function testDataDoctorAddDayInterval(dayIntervals, entry, index, range) {
  let cursor = range.start;
  let guard = 0;
  while (cursor < range.end && guard++ < 370) {
    const dateKey = testDataDoctorDateKey(cursor);
    const dayStart = Date.parse(dateKey + 'T00:00:00.000Z');
    const dayEnd = Date.parse(testDateKeyPlusDays(dateKey, 1) + 'T00:00:00.000Z');
    const start = Math.max(range.start, dayStart);
    const end = Math.min(range.end, dayEnd);
    if (end > start) {
      if (!dayIntervals.has(dateKey)) dayIntervals.set(dateKey, []);
      dayIntervals.get(dateKey).push({ start, end, index, entry });
    }
    cursor = Math.max(dayEnd, cursor + 60000);
  }
}

function dataDoctorKeepScore(entry) {
  const activity = String(entry?.activity || '').trim().toLowerCase();
  let score = 0;
  if (activity === 'sleep') score += 8;
  if (entry?.energy === 'recovery') score += 5;
  if (entry?.energy === 'deep') score += 4;
  if (entry?.energy === 'nine5') score += 3;
  if (entry?.energy === 'learning') score += 2;
  if (entry?.energy === 'exercise' || entry?.energy === 'social' || entry?.energy === 'errands') score += 1;
  if (entry?.retro) score += 2;
  if (entry?.onPlan === true) score += 1;
  if (activity && !['pc time', 'screen time', 'phone usage'].includes(activity)) score += 1;
  if (activity === 'pc time' || activity === 'screen time' || activity === 'phone usage') score -= 5;
  if (entry?.autoLogged) score -= 2;
  return score;
}

function testDataDoctorChooseOverlapLoser(a, b) {
  const aScore = dataDoctorKeepScore(a.entry);
  const bScore = dataDoctorKeepScore(b.entry);
  if (aScore !== bScore) return aScore < bScore ? a : b;
  const aUpdated = a.entry?.updatedAt || a.entry?.ts || 0;
  const bUpdated = b.entry?.updatedAt || b.entry?.ts || 0;
  if (aUpdated !== bUpdated) return aUpdated < bUpdated ? a : b;
  const aDur = a.end - a.start;
  const bDur = b.end - b.start;
  if (aDur !== bDur) return aDur < bDur ? a : b;
  return a.index > b.index ? a : b;
}

function testDataDoctorFindOverflowOverlaps(dayIntervals, dayTotals, dayMaxMin) {
  const byIndex = new Map();
  dayTotals.forEach((minutes, date) => {
    if (minutes <= dayMaxMin) return;
    const intervals = (dayIntervals.get(date) || []).slice().sort((a, b) => a.start - b.start);
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        const a = intervals[i], b = intervals[j];
        if (b.start >= a.end) break;
        const overlapMs = Math.min(a.end, b.end) - Math.max(a.start, b.start);
        if (overlapMs < 15 * 60000) continue;
        const loser = testDataDoctorChooseOverlapLoser(a, b);
        const prev = byIndex.get(loser.index);
        const overlapMinutes = Math.round(overlapMs / 60000);
        if (!prev || overlapMinutes > prev.overlapMinutes) {
          byIndex.set(loser.index, {
            ...testDataDoctorIssueEntry(loser.entry, loser.index, { start: loser.start, end: loser.end }),
            minutes: Math.round((loser.end - loser.start) / 60000),
            overlapMinutes
          });
        }
      }
    }
  });
  return [...byIndex.values()];
}

function scanDataDoctorEntries(entriesArr, opts = {}) {
  const intervalMin = opts.intervalMin || 30;
  const nowTs = opts.nowTs ?? Date.now();
  const longEntryMin = opts.longEntryMin || 18 * 60;
  const dayMaxMin = opts.dayMaxMin || 24 * 60;
  const futureGraceMs = opts.futureGraceMs || 60 * 60 * 1000;
  const issues = {
    missingUpdatedAt: [],
    dateMismatches: [],
    invalidRanges: [],
    futureEntries: [],
    longEntries: [],
    exactDuplicateGroups: [],
    duplicateIds: [],
    dayOverflows: [],
    overflowOverlaps: []
  };
  const duplicateMap = new Map();
  const idMap = new Map();
  const dayTotals = new Map();
  const dayIntervals = new Map();

  (entriesArr || []).forEach((entry, index) => {
    if (!entry || entry.template) return;
    if (entry.id != null && !entry.deleted) {
      const key = String(entry.id);
      if (!idMap.has(key)) idMap.set(key, []);
      idMap.get(key).push(testDataDoctorIssueEntry(entry, index, null));
    }
    if (!entry.updatedAt) issues.missingUpdatedAt.push(testDataDoctorIssueEntry(entry, index, null));

    const range = testEntryTimeRange(entry, intervalMin);
    const anchor = range ? range.start : Number(entry.tsStart || entry.ts);
    const expectedDate = Number.isFinite(anchor) ? testDataDoctorDateKey(anchor) : null;
    if (expectedDate && entry.date !== expectedDate) {
      issues.dateMismatches.push({ ...testDataDoctorIssueEntry(entry, index, range), storedDate: entry.date || 'missing', expectedDate });
    }

    if (entry.deleted || entry.missed) return;
    if (!range) {
      issues.invalidRanges.push(testDataDoctorIssueEntry(entry, index, null));
      return;
    }

    const minutes = Math.round((range.end - range.start) / 60000);
    const issue = { ...testDataDoctorIssueEntry(entry, index, range), minutes };
    if (range.end > nowTs + futureGraceMs) issues.futureEntries.push(issue);
    if (minutes > longEntryMin) issues.longEntries.push(issue);
    testDataDoctorAddDayMinutes(dayTotals, range);
    testDataDoctorAddDayInterval(dayIntervals, entry, index, range);

    const dupKey = testDataDoctorDuplicateKey(entry, range);
    if (!duplicateMap.has(dupKey)) duplicateMap.set(dupKey, []);
    duplicateMap.get(dupKey).push({ ...issue, index, range });
  });

  duplicateMap.forEach(group => {
    if (group.length < 2) return;
    group.sort((a, b) => (entriesArr[b.index]?.updatedAt || entriesArr[b.index]?.ts || 0) - (entriesArr[a.index]?.updatedAt || entriesArr[a.index]?.ts || 0));
    issues.exactDuplicateGroups.push({
      keepIndex: group[0].index,
      duplicateIndexes: group.slice(1).map(item => item.index),
      ids: group.map(item => item.id),
      count: group.length,
      activity: group[0].activity,
      energy: group[0].energy,
      date: group[0].date,
      minutes: group[0].minutes
    });
  });

  idMap.forEach((items, id) => {
    if (items.length > 1) issues.duplicateIds.push({ id, count: items.length, items });
  });

  dayTotals.forEach((minutes, date) => {
    if (minutes > dayMaxMin) issues.dayOverflows.push({ date, minutes });
  });
  issues.overflowOverlaps = testDataDoctorFindOverflowOverlaps(dayIntervals, dayTotals, dayMaxMin);

  const totalIssues = Object.values(issues).reduce((sum, list) => sum + list.length, 0);
  return { issues, totalIssues, scanned: (entriesArr || []).length };
}

function getDataDoctorExactDuplicateIndexes(scan, entriesArr) {
  const indexes = new Set();
  scan.issues.exactDuplicateGroups.forEach(group => {
    group.duplicateIndexes.forEach(index => {
      if (Number.isInteger(index) && entriesArr[index] && !entriesArr[index].deleted) indexes.add(index);
    });
  });
  return indexes;
}

function getDataDoctorDuplicateIdExtraIndexes(scan, entriesArr) {
  const indexes = new Set();
  scan.issues.duplicateIds.forEach(group => {
    const sorted = group.items
      .map(item => item.index)
      .filter(index => Number.isInteger(index) && entriesArr[index])
      .sort((a, b) => (entriesArr[b].updatedAt || entriesArr[b].ts || 0) - (entriesArr[a].updatedAt || entriesArr[a].ts || 0));
    sorted.slice(1).forEach(index => indexes.add(index));
  });
  return indexes;
}

function getDataDoctorFlaggedIndexes(scan, entriesArr) {
  const indexes = new Set();
  ['longEntries', 'invalidRanges', 'futureEntries'].forEach(key => {
    scan.issues[key].forEach(item => {
      if (Number.isInteger(item.index) && entriesArr[item.index]) indexes.add(item.index);
    });
  });
  scan.issues.overflowOverlaps.forEach(item => {
    if (Number.isInteger(item.index) && entriesArr[item.index]) indexes.add(item.index);
  });
  getDataDoctorExactDuplicateIndexes(scan, entriesArr).forEach(index => indexes.add(index));
  getDataDoctorDuplicateIdExtraIndexes(scan, entriesArr).forEach(index => indexes.add(index));
  return indexes;
}

function sumEntryMinutes(entriesArr, predicate, intervalMin = 30, dateKeyFilter = null) {
  const byDate = new Map();
  const fallbackMinsByDate = new Map();
  entriesArr.forEach(entry => {
    if (!entry || entry.deleted || entry.missed) return;
    if (predicate && !predicate(entry)) return;
    if (!entry.ts) {
      const fallbackKey = entry.date || null;
      if (!dateKeyFilter || fallbackKey === dateKeyFilter) {
        const key = fallbackKey || dateKeyFilter || '__fallback__';
        fallbackMinsByDate.set(key, (fallbackMinsByDate.get(key) || 0) + testEntryDurationMinutes(entry, intervalMin));
      }
      return;
    }
    const end = entry.ts;
    const start = entry.tsStart || end - testEntryDurationMinutes(entry, intervalMin) * 60000;
    if (end <= start) return;
    let cursor = start;
    let guard = 0;
    while (cursor < end && guard++ < 370) {
      const dateKey = new Date(cursor).toISOString().slice(0, 10);
      const dayStart = Date.parse(dateKey + 'T00:00:00.000Z');
      const dayEnd = Date.parse(testDateKeyPlusDays(dateKey, 1) + 'T00:00:00.000Z');
      const clipped = { start: Math.max(start, dayStart), end: Math.min(end, dayEnd) };
      if (clipped.end > clipped.start && (!dateKeyFilter || dateKey === dateKeyFilter)) {
        if (!byDate.has(dateKey)) byDate.set(dateKey, []);
        byDate.get(dateKey).push(clipped);
      }
      cursor = Math.max(dayEnd, cursor + 60000);
    }
  });

  let totalMs = 0;
  byDate.forEach(intervals => {
    intervals.sort((a, b) => a.start - b.start);
    let current = null;
    intervals.forEach(interval => {
      if (!current) current = { ...interval };
      else if (interval.start <= current.end) current.end = Math.max(current.end, interval.end);
      else {
        totalMs += current.end - current.start;
        current = { ...interval };
      }
    });
    if (current) totalMs += current.end - current.start;
  });
  let fallbackTotal = 0;
  fallbackMinsByDate.forEach(mins => { fallbackTotal += mins; });
  return fallbackTotal + Math.round(totalMs / 60000);
}

function computeDeepHrs(arr, intervalMin = 30, dateKey = null) {
  return +(sumEntryMinutes(arr, e => e.energy === 'deep', intervalMin, dateKey) / 60).toFixed(1);
}

function computeIdentityScore(arr) {
  return arr.filter(e => e.onPlan === true && e.energy === 'deep').length;
}

function getIdentityLevelWithEmoji(score) {
  if (score >= 8) return 'Operator 🟢';
  if (score >= 5) return 'Builder 🟡';
  if (score >= 3) return 'Trying 🟠';
  return 'Drifting 🔴';
}

function getTimeByActivity(entriesArr, intervalMin = 30) {
  const map = {};
  entriesArr.forEach(e => {
    const mins = e.segments
      ? e.segments.reduce((sum, s) => sum + s.duration, 0) / 60
      : intervalMin;
    const key = e.activity.split(' (Output')[0].toLowerCase().trim();
    if (!map[key]) map[key] = 0;
    map[key] += mins;
  });
  return map;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\nfmt(s)');
test('zero seconds', () => assert.equal(fmt(0), '00:00'));
test('one minute', () => assert.equal(fmt(60), '01:00'));
test('30 minutes', () => assert.equal(fmt(1800), '30:00'));
test('90 seconds', () => assert.equal(fmt(90), '01:30'));
test('pads single-digit minutes', () => assert.equal(fmt(300), '05:00'));
test('pads single-digit seconds', () => assert.equal(fmt(9), '00:09'));

console.log('\nfmtDur(min)');
test('under an hour', () => assert.equal(fmtDur(25), '25m'));
test('exact hour', () => assert.equal(fmtDur(60), '1h'));
test('multiple hours', () => assert.equal(fmtDur(120), '2h'));
test('hours and minutes', () => assert.equal(fmtDur(90), '1h 30m'));
test('59 minutes', () => assert.equal(fmtDur(59), '59m'));

console.log('\ncomputeDeepScore(arr)');
test('empty array returns 0', () => assert.equal(computeDeepScore([]), 0));
test('all deep returns 100', () => {
  const arr = [{energy:'deep'},{energy:'deep'},{energy:'deep'}];
  assert.equal(computeDeepScore(arr), 100);
});
test('no deep returns 0', () => {
  const arr = [{energy:'shallow'},{energy:'admin'}];
  assert.equal(computeDeepScore(arr), 0);
});
test('half deep rounds correctly', () => {
  const arr = [{energy:'deep'},{energy:'shallow'}];
  assert.equal(computeDeepScore(arr), 50);
});
test('one of three deep rounds to 33', () => {
  const arr = [{energy:'deep'},{energy:'shallow'},{energy:'admin'}];
  assert.equal(computeDeepScore(arr), 33);
});

console.log('\ncomputeDeepHrs(arr)');
test('empty array returns 0', () => assert.equal(computeDeepHrs([]), 0));
test('2 deep blocks at 30min = 1.0h', () => {
  const arr = [{energy:'deep'},{energy:'deep'},{energy:'shallow'}];
  assert.equal(computeDeepHrs(arr, 30), 1.0);
});
test('3 deep blocks at 20min = 1.0h', () => {
  const arr = [{energy:'deep'},{energy:'deep'},{energy:'deep'}];
  assert.equal(computeDeepHrs(arr, 20), 1.0);
});
test('overlapping deep entries count occupied time once', () => {
  const arr = [
    {energy:'deep', tsStart: Date.UTC(2026, 0, 5, 9), ts: Date.UTC(2026, 0, 5, 12)},
    {energy:'deep', tsStart: Date.UTC(2026, 0, 5, 10), ts: Date.UTC(2026, 0, 5, 13)},
  ];
  assert.equal(computeDeepHrs(arr), 4.0);
});
test('single deep entry splits across calendar days', () => {
  const arr = [
    {energy:'deep', tsStart: Date.UTC(2026, 0, 5, 0), ts: Date.UTC(2026, 0, 6, 4)},
  ];
  assert.equal(computeDeepHrs(arr), 28.0);
  assert.equal(computeDeepHrs(arr, 30, '2026-01-05'), 24.0);
  assert.equal(computeDeepHrs(arr, 30, '2026-01-06'), 4.0);
});
test('day-specific activity sum caps a 28h entry to that calendar day', () => {
  const arr = [
    {activity:'PC Time', energy:'deep', tsStart: Date.UTC(2026, 0, 5, 0), ts: Date.UTC(2026, 0, 6, 4)},
  ];
  assert.equal(sumEntryMinutes(arr, e => e.activity === 'PC Time', 30, '2026-01-05'), 24 * 60);
  assert.equal(sumEntryMinutes(arr, e => e.activity === 'PC Time', 30, '2026-01-06'), 4 * 60);
});
test('date window clips a crossing entry for each viewed day', () => {
  const arr = [
    {id:1, activity:'PC Time', energy:'deep', tsStart: Date.UTC(2026, 0, 5, 0), ts: Date.UTC(2026, 0, 6, 4)},
  ];
  const mon = getEntriesForDateWindow(arr, '2026-01-05');
  const tue = getEntriesForDateWindow(arr, '2026-01-06');
  assert.equal(mon.length, 1);
  assert.equal(tue.length, 1);
  assert.equal(mon[0].blockIntervalMin, 24 * 60);
  assert.equal(tue[0].blockIntervalMin, 4 * 60);
  assert.equal(mon[0].tsStart, Date.UTC(2026, 0, 5, 0));
  assert.equal(mon[0].ts, Date.UTC(2026, 0, 6, 0));
  assert.equal(tue[0].tsStart, Date.UTC(2026, 0, 6, 0));
  assert.equal(tue[0].ts, Date.UTC(2026, 0, 6, 4));
});
test('date window only includes deleted entries when explicitly requested', () => {
  const arr = [
    {id:1, activity:'Sleep', energy:'recovery', deleted:true, tsStart: Date.UTC(2026, 0, 5, 0), ts: Date.UTC(2026, 0, 5, 12)},
  ];
  assert.equal(getEntriesForDateWindow(arr, '2026-01-05').length, 0);
  const withDeleted = getEntriesForDateWindow(arr, '2026-01-05', 30, true);
  assert.equal(withDeleted.length, 1);
  assert.equal(withDeleted[0].activity, 'Sleep');
});
test('delete target matches duplicate visible block with a different id', () => {
  const target = {id:1, activity:'Sleep', energy:'recovery', tsStart: Date.UTC(2026, 0, 5, 0), ts: Date.UTC(2026, 0, 5, 12)};
  const dup = {id:2, activity:'sleep', energy:'recovery', tsStart: Date.UTC(2026, 0, 5, 0), ts: Date.UTC(2026, 0, 5, 12)};
  const later = {id:3, activity:'Sleep', energy:'recovery', tsStart: Date.UTC(2026, 0, 5, 1), ts: Date.UTC(2026, 0, 5, 12)};
  assert.equal(isSameDeletionTarget(dup, target), true);
  assert.equal(isSameDeletionTarget(later, target), false);
});
test('today render key changes between clipped views of the same saved entry', () => {
  const arr = [
    {id:1, activity:'PC Time', energy:'deep', tsStart: Date.UTC(2026, 0, 5, 0), ts: Date.UTC(2026, 0, 6, 4)},
  ];
  const mon = getEntriesForDateWindow(arr, '2026-01-05');
  const tue = getEntriesForDateWindow(arr, '2026-01-06');
  assert.notEqual(todayRenderKey('2026-01-05', mon), todayRenderKey('2026-01-06', tue));
});
test('minute tick only requests full render when date changes', () => {
  assert.equal(shouldRenderOnDateTick('2026-07-09', '2026-07-09'), false);
  assert.equal(shouldRenderOnDateTick('2026-07-09', '2026-07-10'), true);
  assert.equal(shouldRenderOnDateTick('', '2026-07-09'), true);
});

console.log('\nresolveEntrySync(local, remote)');
test('remote live entry is added when local is missing', () => {
  const result = resolveEntrySync(null, { id: 1, ts: 1000, activity: 'Deep work' }, 2000);
  assert.equal(result.action, 'add');
  assert.equal(result.entry.updatedAt, 1000);
});
test('remote tombstone is skipped when local is missing', () => {
  assert.equal(resolveEntrySync(null, { id: 1, deleted: true, updatedAt: 3000 }).action, 'skip');
});
test('local tombstone wins over newer remote live entry', () => {
  const local = { id: 1, deleted: true, updatedAt: 1000 };
  const remote = { id: 1, deleted: false, updatedAt: 5000, activity: 'Sleep' };
  assert.equal(resolveEntrySync(local, remote).action, 'keep-local');
});
test('newer remote tombstone replaces local live entry', () => {
  const local = { id: 1, deleted: false, updatedAt: 1000, activity: 'Sleep' };
  const remote = { id: 1, deleted: true, updatedAt: 5000 };
  assert.equal(resolveEntrySync(local, remote).action, 'replace');
});
test('undo-restored remote live entry can replace a local tombstone', () => {
  const local = { id: 1, deleted: true, updatedAt: 1000 };
  const remote = { id: 1, deleted: false, updatedAt: 5000, undoRestoredAt: 5000, activity: 'Sleep' };
  const result = resolveEntrySync(local, remote);
  assert.equal(result.action, 'replace');
  assert.equal(result.entry.activity, 'Sleep');
});

console.log('\nundo helpers');
test('created entry undo tombstones existing entries', () => {
  const entriesArr = [{ id: 1, ts: 1000, activity: 'Movie', updatedAt: 1000 }];
  assert.equal(testTombstoneUndoEntries(entriesArr, [1], 2000), true);
  assert.equal(entriesArr.length, 1);
  assert.equal(entriesArr[0].deleted, true);
  assert.equal(entriesArr[0].updatedAt, 2000);
});
test('created entry undo writes a tombstone when local entry is missing', () => {
  const entriesArr = [];
  testTombstoneUndoEntries(entriesArr, ['abc'], 3000);
  assert.deepEqual(entriesArr[0], { id: 'abc', ts: 3000, deleted: true, updatedAt: 3000 });
});
test('delete undo restores the saved live snapshot with a newer stamp', () => {
  const entriesArr = [{ id: 2, ts: 2000, activity: 'Sleep', deleted: true, updatedAt: 2500 }];
  const snapshot = { id: 2, ts: 2000, activity: 'Sleep', energy: 'recovery', updatedAt: 1000 };
  testRestoreUndoEntries(entriesArr, [snapshot], 4000);
  assert.equal(entriesArr[0].activity, 'Sleep');
  assert.equal(entriesArr[0].deleted, undefined);
  assert.equal(entriesArr[0].updatedAt, 4000);
  assert.equal(entriesArr[0].undoRestoredAt, 4000);
});
test('reward spend undo tombstones wallet redemptions', () => {
  const redemptionsArr = [{ id: 'r1', points: 30, updatedAt: 1000 }];
  testTombstoneUndoRedemptions(redemptionsArr, ['r1'], 5000);
  assert.equal(redemptionsArr[0].deleted, true);
  assert.equal(redemptionsArr[0].updatedAt, 5000);
});

console.log('\nentryCoversTemplateSlot(entry, tpl)');
test('live entries suppress overlapping templates regardless of label', () => {
  const entry = { id: 1, activity: 'PC Time', energy: 'deep' };
  const tpl = { activity: 'Sleep', energy: 'recovery' };
  assert.equal(entryCoversTemplateSlot(entry, tpl), true);
});
test('deleted matching entry suppresses matching template', () => {
  const entry = { id: 1, activity: ' sleep ', energy: 'recovery', deleted: true };
  const tpl = { activity: 'Sleep', energy: 'recovery' };
  assert.equal(entryCoversTemplateSlot(entry, tpl), true);
});
test('deleted different entry does not suppress unrelated template', () => {
  const entry = { id: 1, activity: 'Scribe shift', energy: 'nine5', deleted: true };
  const tpl = { activity: 'Sleep', energy: 'recovery' };
  assert.equal(entryCoversTemplateSlot(entry, tpl), false);
});

console.log('\nscanDataDoctorEntries(entries)');
test('detects exact duplicate live entries', () => {
  const start = Date.parse('2026-01-05T10:00:00.000Z');
  const end = Date.parse('2026-01-05T11:00:00.000Z');
  const scan = scanDataDoctorEntries([
    { id: 1, tsStart: start, ts: end, date: '2026-01-05', activity: 'Deep work', energy: 'deep', updatedAt: 1000 },
    { id: 2, tsStart: start, ts: end, date: '2026-01-05', activity: ' deep work ', energy: 'deep', updatedAt: 2000 }
  ], { nowTs: Date.parse('2026-01-06T00:00:00.000Z') });
  assert.equal(scan.issues.exactDuplicateGroups.length, 1);
  assert.deepEqual(scan.issues.exactDuplicateGroups[0].duplicateIndexes, [0]);
});
test('detects long entries that should be manually reviewed', () => {
  const start = Date.parse('2026-01-05T00:00:00.000Z');
  const scan = scanDataDoctorEntries([
    { id: 1, tsStart: start, ts: start + 28 * 60 * 60000, date: '2026-01-05', activity: 'PC Time', energy: 'deep', updatedAt: 1000 }
  ], { nowTs: Date.parse('2026-01-07T00:00:00.000Z') });
  assert.equal(scan.issues.longEntries.length, 1);
  assert.equal(scan.issues.longEntries[0].minutes, 28 * 60);
});
test('detects raw day totals above 24 hours', () => {
  const day = Date.parse('2026-01-05T00:00:00.000Z');
  const scan = scanDataDoctorEntries([
    { id: 1, tsStart: day, ts: day + 20 * 60 * 60000, date: '2026-01-05', activity: 'PC Time', energy: 'deep', updatedAt: 1000 },
    { id: 2, tsStart: day + 2 * 60 * 60000, ts: day + 10 * 60 * 60000, date: '2026-01-05', activity: 'Sleep', energy: 'recovery', updatedAt: 1000 }
  ], { nowTs: Date.parse('2026-01-06T00:00:00.000Z') });
  assert.equal(scan.issues.dayOverflows.length, 1);
  assert.equal(scan.issues.dayOverflows[0].minutes, 28 * 60);
});
test('detects metadata drift without counting deleted entries as visible duplicates', () => {
  const start = Date.parse('2026-01-05T10:00:00.000Z');
  const end = Date.parse('2026-01-05T11:00:00.000Z');
  const scan = scanDataDoctorEntries([
    { id: 1, tsStart: start, ts: end, date: '2026-01-04', activity: 'Sleep', energy: 'recovery', deleted: true }
  ], { nowTs: Date.parse('2026-01-06T00:00:00.000Z') });
  assert.equal(scan.issues.missingUpdatedAt.length, 1);
  assert.equal(scan.issues.dateMismatches.length, 1);
  assert.equal(scan.issues.dateMismatches[0].storedDate, '2026-01-04');
  assert.equal(scan.issues.dateMismatches[0].expectedDate, '2026-01-05');
  assert.equal(scan.issues.exactDuplicateGroups.length, 0);
  assert.equal(scan.issues.duplicateIds.length, 0);
});
test('flags long, invalid, future, exact duplicate, and duplicate-id extras for deletion', () => {
  const day = Date.parse('2026-01-05T00:00:00.000Z');
  const entriesArr = [
    { id: 1, tsStart: day, ts: day + 19 * 60 * 60000, date: '2026-01-05', activity: 'PC Time', energy: 'deep', updatedAt: 1000 },
    { id: 2, tsStart: day + 2 * 60 * 60000, ts: day + 60 * 60000, date: '2026-01-05', activity: 'Bad range', energy: 'deep', updatedAt: 1000 },
    { id: 3, tsStart: day + 26 * 60 * 60000, ts: day + 27 * 60 * 60000, date: '2026-01-06', activity: 'Future', energy: 'deep', updatedAt: 1000 },
    { id: 4, tsStart: day + 4 * 60 * 60000, ts: day + 5 * 60 * 60000, date: '2026-01-05', activity: 'Keep id', energy: 'deep', updatedAt: 3000 },
    { id: 4, tsStart: day + 6 * 60 * 60000, ts: day + 7 * 60 * 60000, date: '2026-01-05', activity: 'Drop id', energy: 'deep', updatedAt: 1000 },
    { id: 5, tsStart: day + 8 * 60 * 60000, ts: day + 9 * 60 * 60000, date: '2026-01-05', activity: 'Duplicate', energy: 'deep', updatedAt: 1000 },
    { id: 6, tsStart: day + 8 * 60 * 60000, ts: day + 9 * 60 * 60000, date: '2026-01-05', activity: ' Duplicate ', energy: 'deep', updatedAt: 2000 }
  ];
  const scan = scanDataDoctorEntries(entriesArr, { nowTs: day + 24 * 60 * 60000 });
  assert.deepEqual([...getDataDoctorFlaggedIndexes(scan, entriesArr)].sort((a, b) => a - b), [0, 1, 2, 4, 5]);
  assert.deepEqual([...getDataDoctorExactDuplicateIndexes(scan, entriesArr)], [5]);
  assert.deepEqual([...getDataDoctorDuplicateIdExtraIndexes(scan, entriesArr)], [4]);
});
test('ignores deleted tombstones when detecting duplicate ids', () => {
  const day = Date.parse('2026-01-05T00:00:00.000Z');
  const scan = scanDataDoctorEntries([
    { id: 1, tsStart: day, ts: day + 60 * 60000, date: '2026-01-05', activity: 'Old tombstone', energy: 'deep', deleted: true, updatedAt: 1000 },
    { id: 1, tsStart: day + 2 * 60 * 60000, ts: day + 3 * 60 * 60000, date: '2026-01-05', activity: 'Live copy', energy: 'deep', updatedAt: 2000 }
  ], { nowTs: day + 24 * 60 * 60000 });
  assert.equal(scan.issues.duplicateIds.length, 0);
});
test('flags lower-priority overlap records on overflow days', () => {
  const day = Date.parse('2026-01-05T00:00:00.000Z');
  const entriesArr = [
    { id: 1, tsStart: day, ts: day + 13 * 60 * 60000, date: '2026-01-05', activity: 'PC Time', energy: 'deep', updatedAt: 1000 },
    { id: 2, tsStart: day + 10 * 60 * 60000, ts: day + 23 * 60 * 60000, date: '2026-01-05', activity: 'Sleep', energy: 'recovery', updatedAt: 1000 }
  ];
  const scan = scanDataDoctorEntries(entriesArr, { nowTs: day + 24 * 60 * 60000 });
  assert.equal(scan.issues.dayOverflows.length, 1);
  assert.deepEqual(scan.issues.overflowOverlaps.map(item => item.index), [0]);
  assert.deepEqual([...getDataDoctorFlaggedIndexes(scan, entriesArr)], [0]);
});
test('does not flag overlaps when the raw day total stays under 24 hours', () => {
  const day = Date.parse('2026-01-05T00:00:00.000Z');
  const entriesArr = [
    { id: 1, tsStart: day, ts: day + 8 * 60 * 60000, date: '2026-01-05', activity: 'PC Time', energy: 'deep', updatedAt: 1000 },
    { id: 2, tsStart: day + 6 * 60 * 60000, ts: day + 14 * 60 * 60000, date: '2026-01-05', activity: 'Sleep', energy: 'recovery', updatedAt: 1000 }
  ];
  const scan = scanDataDoctorEntries(entriesArr, { nowTs: day + 24 * 60 * 60000 });
  assert.equal(scan.issues.dayOverflows.length, 0);
  assert.equal(scan.issues.overflowOverlaps.length, 0);
  assert.equal(getDataDoctorFlaggedIndexes(scan, entriesArr).size, 0);
});

console.log('\ncomputeIdentityScore(arr)');
test('empty array returns 0', () => assert.equal(computeIdentityScore([]), 0));
test('counts only onPlan+deep entries', () => {
  const arr = [
    {energy:'deep', onPlan:true},
    {energy:'deep', onPlan:false},
    {energy:'shallow', onPlan:true},
    {energy:'deep', onPlan:true},
  ];
  assert.equal(computeIdentityScore(arr), 2);
});
test('onPlan null is not counted', () => {
  const arr = [{energy:'deep', onPlan:null}];
  assert.equal(computeIdentityScore(arr), 0);
});

console.log('\ngetIdentityLevelWithEmoji(score)');
test('0 → Drifting', () => assert.equal(getIdentityLevelWithEmoji(0), 'Drifting 🔴'));
test('3 → Trying', () => assert.equal(getIdentityLevelWithEmoji(3), 'Trying 🟠'));
test('5 → Builder', () => assert.equal(getIdentityLevelWithEmoji(5), 'Builder 🟡'));
test('8 → Operator', () => assert.equal(getIdentityLevelWithEmoji(8), 'Operator 🟢'));
test('10 → Operator', () => assert.equal(getIdentityLevelWithEmoji(10), 'Operator 🟢'));

console.log('\ngetTimeByActivity(arr)');
test('aggregates by activity key', () => {
  const arr = [
    {activity:'Coding', energy:'deep'},
    {activity:'Coding', energy:'deep'},
    {activity:'Email', energy:'admin'},
  ];
  const result = getTimeByActivity(arr, 30);
  assert.equal(result['coding'], 60);
  assert.equal(result['email'], 30);
});
test('strips " (Output..." suffix from activity name', () => {
  const arr = [{activity:'Writing (Output: draft)'}];
  const result = getTimeByActivity(arr, 30);
  assert.ok('writing' in result, 'key should be "writing"');
  assert.ok(!('writing (output: draft)' in result));
});
test('uses segments duration when present', () => {
  const arr = [{activity:'Focus', segments:[{duration:600},{duration:600}]}];
  const result = getTimeByActivity(arr, 30);
  assert.equal(result['focus'], 20);
});

// ── Timeline functions (inlined from index.html for testability) ─────────────

const SEAM_TOLERANCE_MS = 2 * 60 * 1000;
const MAX_GAP_MS        = 5 * 60 * 1000;
const MIN_GAP_MIN       = 5;

function activityBaseName(activity) {
  return String(activity || '').split(' (Output')[0].trim().replace(/\s+/g, ' ');
}

function activityGroupKey(activity) {
  return activityBaseName(activity).toLowerCase();
}

function activityDisplayLabel(activity) {
  const label = activityBaseName(activity);
  if (!label) return '';
  const letters = label.replace(/[^A-Za-z]/g, '');
  const allLower = letters && letters === letters.toLowerCase();
  const shouty = letters.length > 3 && letters === letters.toUpperCase();
  return (allLower || shouty) ? normalizeActivityForTemplate(label.toLowerCase()) : label;
}

function preferActivityLabel(current, candidate) {
  if (!current) return candidate || '';
  if (!candidate) return current;
  if (activityDisplayLabel(current) !== current && activityDisplayLabel(candidate) === candidate) return candidate;
  return activityDisplayLabel(current);
}

function clipOverlapsForDisplay(ascSorted) {
  if (ascSorted.length < 2) return ascSorted;
  const result = ascSorted.map(e => ({ ...e }));
  for (let i = 0; i < result.length - 1; i++) {
    const curr = result[i];
    const next = result[i + 1];
    const nextStart = next.tsStart || next.ts;
    if (curr.ts > nextStart && next.ts > curr.ts) {
      curr.ts = nextStart;
      const startMs = curr.tsStart || (curr.ts - (curr.blockIntervalMin || 1) * 60000);
      curr.blockIntervalMin = Math.max(1, Math.round((curr.ts - startMs) / 60000));
    }
  }
  return result;
}

function mergeConsecutiveForDisplay(clipped) {
  if (!clipped.length) return [];
  const out = [];
  let group = { ...clipped[0], activity: activityDisplayLabel(clipped[0].activity), _mergedIds: null };
  for (let i = 1; i < clipped.length; i++) {
    const e = clipped[i];
    const gap = (group.tsStart || group.ts) - e.ts;
    const sameKind = activityGroupKey(e.activity) === activityGroupKey(group.activity) && e.energy === group.energy;
    if (sameKind && gap >= 0 && gap <= MAX_GAP_MS) {
      if (!group._mergedIds) group._mergedIds = [group.id];
      group._mergedIds.push(e.id);
      group.activity = preferActivityLabel(group.activity, activityDisplayLabel(e.activity));
      group.tsStart = e.tsStart || e.ts;
      group.blockIntervalMin = Math.round(((group.tsStart || group.ts) - (e.tsStart || e.ts)) / 60000) ||
        (group.blockIntervalMin || 1);
    } else {
      out.push(group);
      group = { ...e, activity: activityDisplayLabel(e.activity), _mergedIds: null };
    }
  }
  out.push(group);
  return out;
}

const MIN = 60 * 1000;
const HR  = 60 * MIN;

function makeEntry(id, startHr, endHr, activity = 'Task', energy = 'deep') {
  const tsStart = startHr * HR;
  const ts      = endHr   * HR;
  return { id, ts, tsStart, blockIntervalMin: Math.round((ts - tsStart) / MIN), activity, energy };
}

console.log('\nclipOverlapsForDisplay');
test('no-op on non-overlapping entries', () => {
  const a = makeEntry(1, 9, 10);
  const b = makeEntry(2, 10, 11);
  const result = clipOverlapsForDisplay([a, b]);
  assert.equal(result[0].ts, a.ts);
  assert.equal(result[1].ts, b.ts);
});
test('clips partial overlap: A.ts trimmed to B.tsStart', () => {
  const a = makeEntry(1, 9, 10.5);    // A ends at 10:30
  const b = makeEntry(2, 10, 11);     // B starts at 10:00 → overlap
  const [rA] = clipOverlapsForDisplay([a, b]);
  assert.equal(rA.ts, b.tsStart, 'A.ts should be clipped to B.tsStart');
});
test('does not clip when B is fully inside A', () => {
  const a = makeEntry(1, 9, 12);      // A: 9-12
  const b = makeEntry(2, 10, 11);     // B fully inside A (b.ts <= a.ts? No — b.ts=11 <= a.ts=12... wait)
  // b.ts (11*HR) <= a.ts (12*HR) → "next.ts <= curr.ts" case → skip clip
  const [rA] = clipOverlapsForDisplay([a, b]);
  assert.equal(rA.ts, a.ts, 'A.ts should not be clipped when B is inside A');
});
test('does not mutate original entries', () => {
  const a = makeEntry(1, 9, 10.5);
  const b = makeEntry(2, 10, 11);
  const origTs = a.ts;
  clipOverlapsForDisplay([a, b]);
  assert.equal(a.ts, origTs, 'original entry must not be mutated');
});
test('single entry returned as-is', () => {
  const a = makeEntry(1, 9, 10);
  assert.deepEqual(clipOverlapsForDisplay([a]), [a]);
});

console.log('\nmergeConsecutiveForDisplay');
test('no merge when gap > MAX_GAP_MS', () => {
  const a = makeEntry(2, 10, 11);               // 10–11
  const b = makeEntry(1, 9, 9.5);              // 9–9:30 — gap > 5min
  const result = mergeConsecutiveForDisplay([a, b]);
  assert.equal(result.length, 2);
  assert.equal(result[0]._mergedIds, null);
});
test('merges same-activity entries within MAX_GAP_MS', () => {
  const a = makeEntry(2, 9, 10);                 // 9–10, newest
  const b = makeEntry(1, 9 - 4/60, 9 - 1/60);   // 8:56–8:59, gap ~1min — within 5min
  const result = mergeConsecutiveForDisplay([a, b]);
  assert.equal(result.length, 1);
  assert.ok(Array.isArray(result[0]._mergedIds), '_mergedIds should be an array');
  assert.equal(result[0]._mergedIds.length, 2);
});
test('merges same-activity entries when casing differs', () => {
  const a = makeEntry(2, 9, 10, 'APP BUILDING', 'deep');
  const b = makeEntry(1, 9 - 4/60, 9 - 1/60, 'app building', 'deep');
  const result = mergeConsecutiveForDisplay([a, b]);
  assert.equal(result.length, 1);
  assert.equal(result[0].activity, 'App building');
  assert.ok(Array.isArray(result[0]._mergedIds), '_mergedIds should be an array');
  assert.equal(result[0]._mergedIds.length, 2);
});
test('no merge when energy differs', () => {
  const a = makeEntry(2, 10, 11, 'Task', 'deep');
  const b = makeEntry(1, 9.9, 10, 'Task', 'shallow'); // gap ~0 but energy differs
  const result = mergeConsecutiveForDisplay([a, b]);
  assert.equal(result.length, 2);
});
test('no merge when activity differs', () => {
  const a = makeEntry(2, 10, 11, 'Coding', 'deep');
  const b = makeEntry(1, 9.9, 10, 'Email', 'deep');
  const result = mergeConsecutiveForDisplay([a, b]);
  assert.equal(result.length, 2);
});
test('empty array returns empty', () => {
  assert.deepEqual(mergeConsecutiveForDisplay([]), []);
});

// ── Focus Wallet functions (extracted to focus-wallet.js) ───────────────────

const FW_WEEK = '2026-W02';
const FW_MIN = 60 * 1000;

function walletTs(dayOffset, hour, minute = 0) {
  return Date.UTC(2026, 0, 5 + dayOffset, hour, minute, 0);
}

function walletEntry(id, dayOffset, hour, durationMin, activity, energy, extra = {}) {
  const tsStart = walletTs(dayOffset, hour);
  return {
    id,
    tsStart,
    ts: tsStart + durationMin * FW_MIN,
    blockIntervalMin: durationMin,
    activity,
    energy,
    ...extra
  };
}

console.log('\ngetFocusWalletWeekKey(date)');
test('uses app week key format', () => {
  assert.equal(getFocusWalletWeekKey(new Date(walletTs(0, 12))), FW_WEEK);
});

console.log('\ncomputeFocusWallet(entries, redemptions)');
test('live deep work earns base points plus focus bonus', () => {
  const wallet = computeFocusWallet([
    walletEntry('d1', 0, 9, 60, 'Build feature', 'deep')
  ], [], { intervalMin: 30 }, FW_WEEK);
  assert.equal(wallet.earned, 17);
  assert.equal(wallet.balance, 17);
});

test('retro deep work earns half credit and no live bonus', () => {
  const wallet = computeFocusWallet([
    walletEntry('d1', 0, 9, 60, 'Build feature', 'deep', { retro: true })
  ], [], { intervalMin: 30 }, FW_WEEK);
  assert.equal(wallet.earned, 6);
  assert.equal(wallet.balance, 6);
});

test('waste costs are capped per day', () => {
  const wallet = computeFocusWallet([
    walletEntry('w1', 0, 9, 300, 'Scroll', 'waste')
  ], [], { intervalMin: 30 }, FW_WEEK);
  assert.equal(wallet.autoCosts, 20);
  assert.equal(wallet.balance, -20);
});

test('first three sports sessions are free, then session four and five cost points', () => {
  const entries = [0, 1, 2, 3, 4].map(i =>
    walletEntry(`s${i}`, i, 18, 60, 'Pickleball', 'exercise')
  );
  const wallet = computeFocusWallet(entries, [], { intervalMin: 30 }, FW_WEEK);
  assert.equal(wallet.sportsSessions, 5);
  assert.equal(wallet.autoCosts, 35);
});

test('long sports sessions cost points even inside free session count', () => {
  const wallet = computeFocusWallet([
    walletEntry('s1', 0, 18, 180, 'Basketball', 'exercise')
  ], [], { intervalMin: 30 }, FW_WEEK);
  assert.equal(wallet.autoCosts, 10);
});

test('reward redemptions subtract from the same week balance', () => {
  const wallet = computeFocusWallet([
    walletEntry('d1', 0, 9, 60, 'Build feature', 'deep')
  ], [
    { id: 'r1', weekKey: FW_WEEK, label: 'Movie', points: 15, createdAt: walletTs(5, 19) }
  ], { intervalMin: 30 }, FW_WEEK);
  assert.equal(wallet.redeemed, 15);
  assert.equal(wallet.balance, 2);
});

test('reward redemptions can make the balance negative', () => {
  const wallet = computeFocusWallet([], [
    { id: 'r1', weekKey: FW_WEEK, label: 'Movie', points: 25, createdAt: walletTs(5, 19) }
  ], { intervalMin: 30 }, FW_WEEK);
  assert.equal(wallet.redeemed, 25);
  assert.equal(wallet.balance, -25);
});

test('negative debt carries forward, but prior surplus does not', () => {
  const nextWeek = '2026-W03';
  const debtWallet = computeFocusWallet([
    walletEntry('d1', 7, 9, 60, 'Build feature', 'deep')
  ], [
    { id: 'r1', weekKey: FW_WEEK, label: 'Movie', points: 40, createdAt: walletTs(5, 19) }
  ], { intervalMin: 30 }, nextWeek);
  assert.equal(debtWallet.carriedDebt, -40);
  assert.equal(debtWallet.balance, -23);

  const surplusWallet = computeFocusWallet([
    walletEntry('d1', 0, 9, 60, 'Build feature', 'deep')
  ], [], { intervalMin: 30 }, nextWeek);
  assert.equal(surplusWallet.carriedDebt, 0);
  assert.equal(surplusWallet.balance, 0);
});

// -- Learning Plan model ------------------------------------------------------

const LP_TIME = {
  created: '2026-08-27T12:00:00.000Z',
  updated: '2026-08-27T12:05:00.000Z',
  later: '2026-08-27T12:10:00.000Z',
  completed: '2026-08-27T12:15:00.000Z',
  reopened: '2026-08-27T12:20:00.000Z'
};

function sequencedIds(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function fixedClock(value = LP_TIME.updated) {
  return () => value;
}

function seededLearningPlan() {
  let plan = createLearningPlan({ title: 'Frontend fundamentals' }, {
    idGenerator: sequencedIds('plan-1'),
    clock: fixedClock(LP_TIME.created)
  });
  plan = addPhase(plan, { title: 'Phase A' }, {
    idGenerator: sequencedIds('phase-a'),
    clock: fixedClock(LP_TIME.updated)
  });
  plan = addPhase(plan, { title: 'Phase B' }, {
    idGenerator: sequencedIds('phase-b'),
    clock: fixedClock(LP_TIME.updated)
  });
  plan = addLesson(plan, 'phase-a', { title: 'Lesson A' }, {
    idGenerator: sequencedIds('lesson-a'),
    clock: fixedClock(LP_TIME.updated)
  });
  plan = addLesson(plan, 'phase-a', { title: 'Lesson B' }, {
    idGenerator: sequencedIds('lesson-b'),
    clock: fixedClock(LP_TIME.updated)
  });
  plan = addStep(plan, 'lesson-a', { title: 'Step A' }, {
    idGenerator: sequencedIds('step-a'),
    clock: fixedClock(LP_TIME.updated)
  });
  plan = addStep(plan, 'lesson-a', { title: 'Step B' }, {
    idGenerator: sequencedIds('step-b'),
    clock: fixedClock(LP_TIME.updated)
  });
  return plan;
}

function firstPhase(plan) {
  return plan.phases[0];
}

function firstLesson(plan) {
  return firstPhase(plan).lessons[0];
}

function firstStep(plan) {
  return firstLesson(plan).steps[0];
}

function withStructuredCloneDisabled(fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
  try {
    globalThis.structuredClone = undefined;
    fn();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'structuredClone', descriptor);
    else delete globalThis.structuredClone;
  }
}

function assertRejectedWithAndWithoutStructuredClone(value, pattern) {
  assert.throws(() => hydrateLearningPlan(value), pattern);
  withStructuredCloneDisabled(() => {
    assert.throws(() => hydrateLearningPlan(value), pattern);
  });
}

console.log('\nLearning Plan model');
test('create plan gets an immutable UUID-like injected ID and timestamps', () => {
  const plan = createLearningPlan({ title: 'JavaScript', description: 'Core work' }, {
    idGenerator: sequencedIds('uuid-plan'),
    clock: fixedClock(LP_TIME.created)
  });
  assert.equal(plan.id, 'uuid-plan');
  assert.equal(plan.title, 'JavaScript');
  assert.equal(plan.description, 'Core work');
  assert.deepEqual(plan.phases, []);
  assert.equal(plan.createdAt, LP_TIME.created);
  assert.equal(plan.updatedAt, LP_TIME.created);
});
test('phase, lesson, and step each get immutable injected IDs', () => {
  assert.equal(createPhase({ title: 'Phase' }, { idGenerator: sequencedIds('phase-id') }).id, 'phase-id');
  assert.equal(createLesson({ title: 'Lesson' }, { idGenerator: sequencedIds('lesson-id') }).id, 'lesson-id');
  assert.equal(createStep({ title: 'Step' }, { idGenerator: sequencedIds('step-id') }).id, 'step-id');
});
test('rename plan keeps plan ID and does not mutate the caller-owned plan', () => {
  const plan = seededLearningPlan();
  const renamed = renamePlan(plan, 'Frontend mastery', { clock: fixedClock(LP_TIME.later) });
  assert.equal(renamed.id, plan.id);
  assert.equal(renamed.title, 'Frontend mastery');
  assert.equal(plan.title, 'Frontend fundamentals');
  assert.equal(renamed.updatedAt, LP_TIME.later);
});
test('rename phase keeps phase ID', () => {
  const plan = seededLearningPlan();
  const renamed = renamePhase(plan, 'phase-a', 'Basics', { clock: fixedClock(LP_TIME.later) });
  assert.equal(renamed.phases[0].id, 'phase-a');
  assert.equal(renamed.phases[0].title, 'Basics');
});
test('rename lesson keeps lesson ID', () => {
  const plan = seededLearningPlan();
  const renamed = renameLesson(plan, 'lesson-a', 'Syntax', { clock: fixedClock(LP_TIME.later) });
  assert.equal(firstLesson(renamed).id, 'lesson-a');
  assert.equal(firstLesson(renamed).title, 'Syntax');
});
test('rename step keeps step ID', () => {
  const plan = seededLearningPlan();
  const renamed = renameStep(plan, 'step-a', 'Read docs', { clock: fixedClock(LP_TIME.later) });
  assert.equal(firstStep(renamed).id, 'step-a');
  assert.equal(firstStep(renamed).title, 'Read docs');
});
test('reordering phases keeps IDs and uses array order only', () => {
  const plan = seededLearningPlan();
  const reordered = reorderPhases(plan, ['phase-b', 'phase-a'], { clock: fixedClock(LP_TIME.later) });
  assert.deepEqual(reordered.phases.map(phase => phase.id), ['phase-b', 'phase-a']);
  assert.equal(reordered.phases[1].lessons[0].id, 'lesson-a');
});
test('reordering lessons keeps IDs', () => {
  const plan = seededLearningPlan();
  const reordered = reorderLessons(plan, 'phase-a', ['lesson-b', 'lesson-a'], { clock: fixedClock(LP_TIME.later) });
  assert.deepEqual(firstPhase(reordered).lessons.map(lesson => lesson.id), ['lesson-b', 'lesson-a']);
});
test('reordering steps keeps IDs', () => {
  const plan = seededLearningPlan();
  const reordered = reorderSteps(plan, 'lesson-a', ['step-b', 'step-a'], { clock: fixedClock(LP_TIME.later) });
  assert.deepEqual(firstLesson(reordered).steps.map(step => step.id), ['step-b', 'step-a']);
});
test('complete step keeps step ID, sets completedAt, and touches plan updatedAt', () => {
  const plan = seededLearningPlan();
  const completed = completeStep(plan, 'step-a', { clock: fixedClock(LP_TIME.completed) });
  assert.equal(firstStep(completed).id, 'step-a');
  assert.equal(firstStep(completed).completed, true);
  assert.equal(firstStep(completed).completedAt, LP_TIME.completed);
  assert.equal(completed.updatedAt, LP_TIME.completed);
});
test('repeated complete is idempotent', () => {
  const completed = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.completed) });
  const retried = completeStep(completed, 'step-a', { clock: fixedClock(LP_TIME.later) });
  assert.deepEqual(retried, completed);
});
test('reopen keeps step ID, clears completedAt, and touches plan updatedAt', () => {
  const completed = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.completed) });
  const reopened = reopenStep(completed, 'step-a', { clock: fixedClock(LP_TIME.reopened) });
  assert.equal(firstStep(reopened).id, 'step-a');
  assert.equal(firstStep(reopened).completed, false);
  assert.equal(firstStep(reopened).completedAt, null);
  assert.equal(reopened.updatedAt, LP_TIME.reopened);
});
test('complete, reopen, complete again preserves identity with a new completedAt', () => {
  const completed = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.completed) });
  const reopened = reopenStep(completed, 'step-a', { clock: fixedClock(LP_TIME.reopened) });
  const completedAgain = completeStep(reopened, 'step-a', { clock: fixedClock(LP_TIME.later) });
  assert.equal(firstStep(completedAgain).id, 'step-a');
  assert.equal(firstStep(completedAgain).completedAt, LP_TIME.later);
});
test('adding an entity creates exactly one new ID', () => {
  const plan = seededLearningPlan();
  let idCalls = 0;
  const withPhase = addPhase(plan, { title: 'Phase C' }, {
    idGenerator: () => {
      idCalls++;
      return 'phase-c';
    },
    clock: fixedClock(LP_TIME.later)
  });
  assert.equal(idCalls, 1);
  assert.deepEqual(withPhase.phases.map(phase => phase.id), ['phase-a', 'phase-b', 'phase-c']);
});
test('invalid empty titles are rejected on create and rename', () => {
  assert.throws(() => createLearningPlan({ title: ' ' }, { idGenerator: sequencedIds('x'), clock: fixedClock() }), /title/);
  assert.throws(() => renameStep(seededLearningPlan(), 'step-a', ' ', { clock: fixedClock() }), /title/);
});
test('duplicate IDs are rejected across the entire hierarchy', () => {
  const plan = seededLearningPlan();
  const duplicated = {
    ...plan,
    phases: [{ ...plan.phases[0], id: plan.id }, plan.phases[1]]
  };
  const validation = validateLearningPlan(duplicated);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some(error => error.includes('duplicates')));
});
test('ID generator collisions are rejected during add operations', () => {
  const plan = seededLearningPlan();
  assert.throws(() => addStep(plan, 'lesson-a', { title: 'Duplicate' }, {
    idGenerator: sequencedIds('step-a'),
    clock: fixedClock(LP_TIME.later)
  }), /duplicates/);
});
test('malformed timestamps are rejected', () => {
  const plan = { ...seededLearningPlan(), updatedAt: '2026-08-27T12:00:00' };
  const validation = validateLearningPlan(plan);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some(error => error.includes('updatedAt')));
});
test('completed/completedAt contradictions are rejected', () => {
  const incompleteWithDate = seededLearningPlan();
  incompleteWithDate.phases[0].lessons[0].steps[0].completedAt = LP_TIME.completed;
  assert.equal(validateLearningPlan(incompleteWithDate).ok, false);

  const completeWithoutDate = seededLearningPlan();
  completeWithoutDate.phases[0].lessons[0].steps[0].completed = true;
  completeWithoutDate.phases[0].lessons[0].steps[0].completedAt = null;
  assert.equal(validateLearningPlan(completeWithoutDate).ok, false);
});
test('missing arrays and sparse arrays are rejected during hydrate', () => {
  const missing = { ...seededLearningPlan() };
  delete missing.phases[0].lessons;
  assert.throws(() => hydrateLearningPlan(missing), /lessons/);

  const sparse = seededLearningPlan();
  sparse.phases.length = 3;
  assert.throws(() => hydrateLearningPlan(sparse), /sparse array hole/);
});
test('JSON round trip preserves immutable IDs exactly', () => {
  const plan = seededLearningPlan();
  const roundTrip = hydrateLearningPlan(JSON.parse(serializeLearningPlan(plan)));
  assert.deepEqual(roundTrip.phases.map(phase => phase.id), plan.phases.map(phase => phase.id));
  assert.deepEqual(firstLesson(roundTrip).steps.map(step => step.id), firstLesson(plan).steps.map(step => step.id));
});
test('progress reports zero-step plans deterministically', () => {
  const plan = createLearningPlan({ title: 'Empty' }, {
    idGenerator: sequencedIds('plan-empty'),
    clock: fixedClock(LP_TIME.created)
  });
  assert.deepEqual(getLearningPlanProgress(plan), {
    totalSteps: 0,
    completedSteps: 0,
    completionRatio: 0,
    completionPercent: 0
  });
});
test('progress reports partial completion', () => {
  const plan = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.completed) });
  assert.deepEqual(getLearningPlanProgress(plan), {
    totalSteps: 2,
    completedSteps: 1,
    completionRatio: 0.5,
    completionPercent: 50
  });
});
test('progress reports complete plans', () => {
  let plan = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.completed) });
  plan = completeStep(plan, 'step-b', { clock: fixedClock(LP_TIME.completed) });
  assert.deepEqual(getLearningPlanProgress(plan), {
    totalSteps: 2,
    completedSteps: 2,
    completionRatio: 1,
    completionPercent: 100
  });
});
test('operations do not mutate caller-owned input or share returned mutable state backward', () => {
  const plan = seededLearningPlan();
  const updated = addStep(plan, 'lesson-a', { title: 'Step C' }, {
    idGenerator: sequencedIds('step-c'),
    clock: fixedClock(LP_TIME.later)
  });
  updated.phases[0].lessons[0].steps[0].title = 'Mutated returned object';
  assert.equal(firstLesson(plan).steps.length, 2);
  assert.equal(firstStep(plan).title, 'Step A');
});
test('nonexistent target IDs fail deterministically', () => {
  const plan = seededLearningPlan();
  assert.throws(() => renamePhase(plan, 'missing-phase', 'Nope', { clock: fixedClock() }), /phase missing-phase not found/);
  assert.throws(() => addLesson(plan, 'missing-phase', { title: 'Nope' }, { idGenerator: sequencedIds('x'), clock: fixedClock() }), /phase missing-phase not found/);
  assert.throws(() => completeStep(plan, 'missing-step', { clock: fixedClock() }), /step missing-step not found/);
});
test('reorder rejects missing, duplicate, and extra IDs deterministically', () => {
  const plan = seededLearningPlan();
  assert.throws(() => reorderSteps(plan, 'lesson-a', ['step-a'], { clock: fixedClock() }), /include every existing id/);
  assert.throws(() => reorderSteps(plan, 'lesson-a', ['step-a', 'step-a'], { clock: fixedClock() }), /duplicate id/);
  assert.throws(() => reorderSteps(plan, 'lesson-a', ['step-a', 'missing-step'], { clock: fixedClock() }), /unknown id/);
});
test('same title on two different entities is allowed because title is not identity', () => {
  let plan = createLearningPlan({ title: 'Same' }, {
    idGenerator: sequencedIds('plan-same'),
    clock: fixedClock(LP_TIME.created)
  });
  plan = addPhase(plan, { title: 'Same' }, { idGenerator: sequencedIds('phase-same'), clock: fixedClock() });
  plan = addLesson(plan, 'phase-same', { title: 'Same' }, { idGenerator: sequencedIds('lesson-same'), clock: fixedClock() });
  plan = addStep(plan, 'lesson-same', { title: 'Same' }, { idGenerator: sequencedIds('step-same'), clock: fixedClock() });
  assert.equal(validateLearningPlan(plan).ok, true);
  assert.deepEqual([plan.id, plan.phases[0].id, plan.phases[0].lessons[0].id, plan.phases[0].lessons[0].steps[0].id], [
    'plan-same',
    'phase-same',
    'lesson-same',
    'step-same'
  ]);
});
test('changing title, order, and completion never changes future source identity IDs', () => {
  const plan = seededLearningPlan();
  const idsBefore = {
    plan: plan.id,
    phase: 'phase-a',
    lesson: 'lesson-a',
    step: 'step-a'
  };
  let changed = renamePlan(plan, 'Renamed', { clock: fixedClock(LP_TIME.later) });
  changed = renamePhase(changed, 'phase-a', 'Renamed phase', { clock: fixedClock(LP_TIME.later) });
  changed = reorderSteps(changed, 'lesson-a', ['step-b', 'step-a'], { clock: fixedClock(LP_TIME.later) });
  changed = completeStep(changed, 'step-a', { clock: fixedClock(LP_TIME.completed) });
  assert.equal(changed.id, idsBefore.plan);
  assert.equal(changed.phases.find(phase => phase.id === idsBefore.phase).id, idsBefore.phase);
  assert.equal(changed.phases.find(phase => phase.id === 'phase-b').id, 'phase-b');
  assert.equal(changed.phases[0].lessons.find(lesson => lesson.id === idsBefore.lesson).id, idsBefore.lesson);
  assert.equal(changed.phases[0].lessons[0].steps.find(step => step.id === idsBefore.step).id, idsBefore.step);
});
test('empty child arrays are valid durable model state', () => {
  const plan = createLearningPlan({ title: 'Empty' }, {
    idGenerator: sequencedIds('empty-plan'),
    clock: fixedClock(LP_TIME.created)
  });
  assert.equal(validateLearningPlan(plan).ok, true);
});
test('hydrate succeeds with structuredClone unavailable for valid plain data', () => {
  const plan = seededLearningPlan();
  withStructuredCloneDisabled(() => {
    const hydrated = hydrateLearningPlan(plan);
    assert.deepEqual(hydrated, plan);
    assert.notEqual(hydrated, plan);
  });
});
test('unsupported function-valued properties are rejected before fallback clone', () => {
  const plan = seededLearningPlan();
  plan.extra = () => 1;
  assertRejectedWithAndWithoutStructuredClone(plan, /unsupported function/);
});
test('unsupported symbol values and symbol keys are rejected before fallback clone', () => {
  const symbolValue = seededLearningPlan();
  symbolValue.extra = Symbol('bad');
  assertRejectedWithAndWithoutStructuredClone(symbolValue, /unsupported symbol/);

  const symbolKey = seededLearningPlan();
  symbolKey[Symbol('bad')] = 'hidden';
  assertRejectedWithAndWithoutStructuredClone(symbolKey, /symbol key/);
});
test('unsupported BigInt values are rejected before fallback clone', () => {
  const plan = seededLearningPlan();
  plan.extra = 1n;
  assertRejectedWithAndWithoutStructuredClone(plan, /unsupported bigint/);
});
test('Date values are rejected before fallback clone', () => {
  const plan = seededLearningPlan();
  plan.extra = new Date(LP_TIME.created);
  assertRejectedWithAndWithoutStructuredClone(plan, /JSON-safe plain data/);
});
test('Map and Set values are rejected before fallback clone', () => {
  const withMap = seededLearningPlan();
  withMap.extra = new Map([['x', 1]]);
  assertRejectedWithAndWithoutStructuredClone(withMap, /JSON-safe plain data/);

  const withSet = seededLearningPlan();
  withSet.extra = new Set(['x']);
  assertRejectedWithAndWithoutStructuredClone(withSet, /JSON-safe plain data/);
});
test('class instances are rejected before fallback clone', () => {
  class CustomPhase {
    constructor() {
      this.id = 'custom-phase';
      this.title = 'Custom';
      this.lessons = [];
    }
  }
  const plan = seededLearningPlan();
  plan.phases[0] = new CustomPhase();
  assertRejectedWithAndWithoutStructuredClone(plan, /JSON-safe plain data/);
});
test('circular structures are rejected safely before fallback clone', () => {
  const plan = seededLearningPlan();
  plan.extra = plan;
  assertRejectedWithAndWithoutStructuredClone(plan, /circular reference/);
});
test('undefined durable values are rejected before fallback clone', () => {
  const plan = seededLearningPlan();
  plan.phases[0].title = undefined;
  assertRejectedWithAndWithoutStructuredClone(plan, /unsupported undefined/);
});
test('valid JSON-safe round trip preserves IDs, timestamps, completion, and order without structuredClone', () => {
  let plan = seededLearningPlan();
  plan = completeStep(plan, 'step-b', { clock: fixedClock(LP_TIME.completed) });
  plan = reorderPhases(plan, ['phase-b', 'phase-a'], { clock: fixedClock(LP_TIME.later) });
  plan = reorderSteps(plan, 'lesson-a', ['step-b', 'step-a'], { clock: fixedClock(LP_TIME.reopened) });

  withStructuredCloneDisabled(() => {
    const roundTrip = hydrateLearningPlan(JSON.parse(serializeLearningPlan(plan)));
    assert.deepEqual(roundTrip, plan);
    assert.deepEqual(roundTrip.phases.map(phase => phase.id), ['phase-b', 'phase-a']);
    assert.deepEqual(roundTrip.phases[1].lessons[0].steps.map(step => step.id), ['step-b', 'step-a']);
    assert.equal(roundTrip.createdAt, LP_TIME.created);
    assert.equal(roundTrip.updatedAt, LP_TIME.reopened);
    assert.equal(roundTrip.phases[1].lessons[0].steps[0].completed, true);
    assert.equal(roundTrip.phases[1].lessons[0].steps[0].completedAt, LP_TIME.completed);
  });
});
test('invalid injected idGenerator and clock outputs are rejected', () => {
  assert.throws(() => createLearningPlan({ title: 'Bad ID' }, {
    idGenerator: () => '',
    clock: fixedClock(LP_TIME.created)
  }), /idGenerator/);
  assert.throws(() => createLearningPlan({ title: 'Bad clock' }, {
    idGenerator: sequencedIds('bad-clock-plan'),
    clock: () => '2026-08-27T12:00:00'
  }), /clock/);
  assert.throws(() => completeStep(seededLearningPlan(), 'step-a', {
    clock: () => 'not a timestamp'
  }), /clock/);
});

// -- Life Ledger core ---------------------------------------------------------

const LL_TIME = {
  start: '2026-08-27T16:00:00.000Z',
  end: '2026-08-27T16:45:00.000Z',
  recorded: '2026-08-27T16:46:03.000Z',
  revised: '2026-08-27T17:00:00.000Z'
};

function sampleActivityDraft(overrides = {}) {
  const base = {
    schemaVersion: 1,
    sourceApp: 'chronasense',
    sourceEntityId: '1700000000000',
    type: 'activity_logged',
    occurredAt: LL_TIME.end,
    sourceTimezone: 'America/Phoenix',
    payload: {
      activity: 'Deep work',
      category: 'deep_work',
      startedAt: LL_TIME.start,
      endedAt: LL_TIME.end,
      durationMinutes: 45,
      energy: 'deep',
      onPlan: true
    },
    provenance: {
      source: 'chronasense',
      sourceRecordKind: 'chronasense.entry',
      adapterVersion: 'chronasense-v1',
      observedAt: LL_TIME.recorded,
      captureMethod: 'timer',
      evidence: ['chronasense.entries/1700000000000']
    },
    confidence: {
      score: 1,
      basis: 'source-recorded'
    },
    tombstone: {
      active: false,
      deletedAt: null,
      reason: null,
      provenance: null
    }
  };
  return {
    ...base,
    ...overrides,
    payload: { ...base.payload, ...(overrides.payload || {}) },
    provenance: { ...base.provenance, ...(overrides.provenance || {}) },
    confidence: { ...base.confidence, ...(overrides.confidence || {}) },
    tombstone: { ...base.tombstone, ...(overrides.tombstone || {}) }
  };
}

function sampleStoredEvent(overrides = {}) {
  return {
    ...sampleActivityDraft(overrides),
    eventId: '3f1d7f69-8b5a-4f10-b7ec-d1c45e6fba55',
    recordedAt: LL_TIME.recorded,
    revisedAt: null,
    revision: 1,
    ...overrides
  };
}

function tombstoneDraft() {
  return sampleActivityDraft({
    provenance: {
      sourceOperation: 'delete',
      observedAt: '2026-08-27T17:05:00.000Z'
    },
    tombstone: {
      active: true,
      deletedAt: '2026-08-27T17:05:00.000Z',
      reason: 'user_delete',
      provenance: {
        sourceOperation: 'delete',
        sourceRecordKind: 'chronasense.entry',
        evidence: ['chronasense.entries/1700000000000/deleted']
      }
    }
  });
}

function sequencedClock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

const CS_CONTEXT = {
  sourceTimezone: 'America/Phoenix',
  observedAt: LL_TIME.recorded
};

function chronaEntry(overrides = {}) {
  return {
    id: 1700000000000,
    tsStart: Date.parse(LL_TIME.start),
    ts: Date.parse(LL_TIME.end),
    blockIntervalMin: 45,
    date: '2026-08-27',
    activity: 'Deep work',
    energy: 'deep',
    category: 'deep_work',
    onPlan: true,
    retro: false,
    updatedAt: Date.parse(LL_TIME.recorded),
    originalLabel: 'deep',
    syncStamp: 999,
    ...overrides
  };
}

function adapterDraft(entryOverrides = {}, contextOverrides = {}) {
  const result = normalizeChronaSenseEntry(
    chronaEntry(entryOverrides),
    { ...CS_CONTEXT, ...contextOverrides }
  );
  assert.equal(result.ok, true, result.errors ? result.errors.join('; ') : result.reason);
  return result.draft;
}

console.log('\nChronaSense Life Ledger adapter');
test('normal ChronaSense entry normalizes to valid activity_logged draft', () => {
  const draft = adapterDraft();
  assert.equal(draft.sourceApp, 'chronasense');
  assert.equal(draft.type, 'activity_logged');
  assert.equal(draft.sourceEntityId, '1700000000000');
  assert.equal(draft.payload.activity, 'Deep work');
  assert.equal(validateLifeLedgerEventDraft(draft).ok, true);
});
test('source ID is preserved deterministically and is separate from Life Ledger UUID', () => {
  const draft = adapterDraft();
  const store = createLifeLedgerMemoryStore();
  const created = upsertLifeLedgerEvent(store, draft, {
    createId: () => '12121212-1212-4212-8212-121212121212',
    clock: () => LL_TIME.recorded
  });
  assert.equal(created.event.sourceEntityId, '1700000000000');
  assert.notEqual(created.event.eventId, created.event.sourceEntityId);
});
test('numeric timestamp-style source ID is supported', () => {
  assert.equal(adapterDraft({ id: 1700000123456 }).sourceEntityId, '1700000123456');
});
test('stable string source ID is supported', () => {
  const draft = adapterDraft({ id: 'tpllog_deep_work_2026-08-27' });
  assert.equal(draft.sourceEntityId, 'tpllog_deep_work_2026-08-27');
});
test('same source entry normalizes to same logical identity', () => {
  const a = adapterDraft();
  const b = adapterDraft({}, { observedAt: '2026-08-28T00:00:00.000Z' });
  assert.equal(deriveLifeLedgerKey(a), deriveLifeLedgerKey(b));
});
test('mutable activity text change keeps logical identity', () => {
  const a = adapterDraft();
  const b = adapterDraft({ activity: 'Deep work renamed' });
  assert.equal(deriveLifeLedgerKey(a), deriveLifeLedgerKey(b));
  assert.notEqual(a.payload.activity, b.payload.activity);
});
test('startedAt, endedAt, and occurredAt map from the source interval', () => {
  const draft = adapterDraft();
  assert.equal(draft.payload.startedAt, LL_TIME.start);
  assert.equal(draft.payload.endedAt, LL_TIME.end);
  assert.equal(draft.occurredAt, LL_TIME.end);
});
test('sourceTimezone is injected from the ChronaSense timezone context', () => {
  const phoenix = adapterDraft();
  const manila = adapterDraft({}, { sourceTimezone: 'Asia/Manila' });
  assert.equal(phoenix.sourceTimezone, 'America/Phoenix');
  assert.equal(manila.sourceTimezone, 'Asia/Manila');
});
test('duration is computed from factual interval timestamps', () => {
  const draft = adapterDraft({ blockIntervalMin: 99 });
  assert.equal(draft.payload.durationMinutes, 45);
});
test('operational sync metadata does not become factual payload', () => {
  const draft = adapterDraft({
    updatedAt: Date.parse(LL_TIME.revised),
    originalLabel: 'deep',
    syncStamp: 123,
    source: 'browser-extension'
  });
  assert.equal(Object.hasOwn(draft.payload, 'updatedAt'), false);
  assert.equal(Object.hasOwn(draft.payload, 'originalLabel'), false);
  assert.equal(Object.hasOwn(draft.payload, 'syncStamp'), false);
  assert.equal(Object.hasOwn(draft.payload, 'source'), false);
  assert.equal(draft.payload.captureMethod, 'browser_usage');
});
test('deleted:true plus updatedAt without explicit reason is rejected', () => {
  const result = normalizeChronaSenseEntry(
    chronaEntry({ deleted: true, updatedAt: Date.parse('2026-08-27T17:05:00.000Z') }),
    CS_CONTEXT
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous_deletion_evidence');
});
test('explicit user_delete can produce a valid tombstone draft', () => {
  const draft = adapterDraft({
    deleted: true,
    deletionReason: 'user_delete',
    updatedAt: Date.parse('2026-08-27T17:05:00.000Z')
  });
  assert.equal(draft.tombstone.active, true);
  assert.equal(draft.tombstone.deletedAt, '2026-08-27T17:05:00.000Z');
  assert.equal(draft.tombstone.reason, 'user_delete');
  assert.equal(validateLifeLedgerEventDraft(draft).ok, true);
});
test('explicit bulk_clear can produce a valid tombstone draft', () => {
  const draft = adapterDraft({
    deleted: true,
    deleteReason: 'bulk_clear',
    updatedAt: Date.parse('2026-08-27T17:05:00.000Z')
  });
  assert.equal(draft.tombstone.active, true);
  assert.equal(draft.tombstone.reason, 'bulk_clear');
  assert.equal(draft.provenance.sourceOperation, 'delete');
});
test('explicit data_doctor_repair can produce a valid tombstone draft', () => {
  const draft = adapterDraft({
    deleted: true,
    deletionReason: 'data_doctor_repair',
    updatedAt: Date.parse('2026-08-27T17:05:00.000Z')
  });
  assert.equal(draft.tombstone.active, true);
  assert.equal(draft.tombstone.reason, 'data_doctor_repair');
  assert.equal(draft.provenance.sourceOperation, 'repair');
});
test('ambiguous deleted record never becomes user_delete automatically', () => {
  const result = normalizeChronaSenseEntry(
    chronaEntry({ deleted: true, updatedAt: Date.parse('2026-08-27T17:05:00.000Z') }),
    CS_CONTEXT
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous_deletion_evidence');
  assert.equal(Object.hasOwn(result, 'draft'), false);
});
test('trusted context deletion reason can produce a valid tombstone draft', () => {
  const draft = adapterDraft(
    { deleted: true, updatedAt: Date.parse('2026-08-27T17:05:00.000Z') },
    { deletionReason: 'user_delete' }
  );
  assert.equal(draft.tombstone.active, true);
  assert.equal(draft.tombstone.deletedAt, '2026-08-27T17:05:00.000Z');
  assert.equal(draft.tombstone.reason, 'user_delete');
  assert.equal(validateLifeLedgerEventDraft(draft).ok, true);
});
test('explicit deletion reason controls tombstone source operation', () => {
  const draft = adapterDraft(
    { deleted: true, deletionReason: 'data_doctor_repair', updatedAt: Date.parse('2026-08-27T17:05:00.000Z') }
  );
  assert.equal(draft.tombstone.reason, 'data_doctor_repair');
  assert.equal(draft.tombstone.provenance.sourceOperation, 'repair');
  assert.equal(draft.provenance.sourceOperation, 'repair');
});
test('ordinary live entry is not tombstoned', () => {
  assert.equal(adapterDraft().tombstone.active, false);
});
test('selected-day or Data Doctor-like ambiguous deletion is rejected without explicit reason', () => {
  const result = normalizeChronaSenseEntry(
    chronaEntry({ deleted: true, updatedAt: Date.parse('2026-08-27T17:05:00.000Z'), dataDoctorCandidate: true }),
    CS_CONTEXT
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous_deletion_evidence');
});
test('missing source record and empty adapter input create no tombstone', () => {
  const empty = normalizeChronaSenseEntries([], CS_CONTEXT);
  assert.deepEqual(empty.drafts, []);
  assert.deepEqual(empty.rejected, []);
  assert.equal(normalizeChronaSenseEntry(null, CS_CONTEXT).ok, false);
});
test('ordinary entry without physical-path context does not fabricate e_<id> evidence', () => {
  const draft = adapterDraft();
  assert.deepEqual(draft.provenance.evidence, ['chronasense.entry:1700000000000']);
  assert.equal(Object.hasOwn(draft.provenance, 'sourcePath'), false);
  assert.equal(Object.hasOwn(draft.provenance, 'sourceEvidence'), false);
});
test('caller-provided source evidence is preserved as operational provenance', () => {
  const draft = adapterDraft({}, { sourceEvidence: ['rooms/demo/entries/e_1700000000000'] });
  assert.deepEqual(draft.provenance.evidence, ['chronasense.entry:1700000000000']);
  assert.deepEqual(draft.provenance.sourceEvidence, ['rooms/demo/entries/e_1700000000000']);
});
test('browser-extension origin derives truthful entries/<id> source path', () => {
  const draft = adapterDraft({ source: 'browser-extension' });
  assert.equal(draft.provenance.sourceOrigin, 'browser-extension');
  assert.equal(draft.provenance.sourcePath, 'entries/1700000000000');
  assert.deepEqual(draft.provenance.sourceEvidence, ['entries/1700000000000']);
});
test('source evidence metadata does not change logical identity', () => {
  const a = adapterDraft({}, { sourceEvidence: ['rooms/a/entries/e_1700000000000'] });
  const b = adapterDraft({}, { sourceEvidence: ['rooms/b/entries/e_1700000000000'] });
  assert.equal(deriveLifeLedgerKey(a), deriveLifeLedgerKey(b));
});
test('source evidence-only operational change does not create a factual revision', () => {
  const store = createLifeLedgerMemoryStore();
  const opts = {
    createId: () => '89898989-8989-4898-8989-898989898989',
    clock: sequencedClock(LL_TIME.recorded, LL_TIME.revised)
  };
  const first = upsertLifeLedgerEvent(store, adapterDraft({}, { sourceEvidence: ['rooms/a/entries/e_1700000000000'] }), opts);
  const second = upsertLifeLedgerEvent(store, adapterDraft({}, { sourceEvidence: ['rooms/b/entries/e_1700000000000'] }), opts);
  assert.equal(first.action, 'created');
  assert.equal(second.action, 'unchanged');
  assert.equal(second.event.revision, 1);
});
test('multiple capture flags produce deterministic captureMethod priority', () => {
  assert.equal(adapterDraft({ browserUsage: true, phoneUsage: true, scheduledAutoLog: true }).payload.captureMethod, 'browser_usage');
  assert.equal(adapterDraft({ phoneUsage: true, scheduledAutoLog: true, retro: true }).payload.captureMethod, 'phone_usage');
  assert.equal(adapterDraft({ scheduledAutoLog: true, walletReward: true, retro: true }).payload.captureMethod, 'scheduled_template');
  assert.equal(adapterDraft({ walletReward: true, retro: true, quickLogged: true }).payload.captureMethod, 'reward_log');
  assert.equal(adapterDraft({ retro: true, quickLogged: true }).payload.captureMethod, 'retro_log');
});
test('duplicate identical physical rows collapse to one adapter draft', () => {
  let ids = 0;
  const batch = normalizeChronaSenseEntries([chronaEntry(), chronaEntry()], CS_CONTEXT);
  assert.equal(batch.drafts.length, 1);
  assert.deepEqual(batch.rejected, []);
  const store = createLifeLedgerMemoryStore();
  const result = upsertManyLifeLedgerEvents(store, batch.drafts, {
    createId: () => {
      ids++;
      return '34343434-3434-4434-8434-343434343434';
    },
    clock: () => LL_TIME.recorded
  });
  assert.equal(result.action, 'ok');
  assert.equal(store.listEvents().length, 1);
  assert.equal(ids, 1);
});
test('equivalent browser-extension duplicate rows collapse deterministically', () => {
  const a = normalizeChronaSenseEntries([
    chronaEntry({ source: 'browser-extension' }),
    chronaEntry({ source: 'browser-extension' })
  ], CS_CONTEXT);
  const b = normalizeChronaSenseEntries([
    chronaEntry({ source: 'browser-extension' }),
    chronaEntry({ source: 'browser-extension' })
  ], CS_CONTEXT);
  assert.equal(a.drafts.length, 1);
  assert.equal(b.drafts.length, 1);
  assert.deepEqual(a.drafts[0], b.drafts[0]);
  assert.deepEqual(a.drafts[0].provenance.sourceEvidence, ['entries/1700000000000']);
});
test('conflicting same-ID physical rows are rejected at the adapter level', () => {
  const first = normalizeChronaSenseEntries([
    chronaEntry(),
    chronaEntry({ activity: 'Different activity' })
  ], CS_CONTEXT);
  const second = normalizeChronaSenseEntries([
    chronaEntry({ activity: 'Different activity' }),
    chronaEntry()
  ], CS_CONTEXT);
  assert.equal(first.drafts.length, 0);
  assert.equal(second.drafts.length, 0);
  assert.equal(first.rejected.length, 1);
  assert.equal(second.rejected.length, 1);
  assert.equal(first.rejected[0].reason, 'conflicting_duplicate_physical_input');
  assert.equal(second.rejected[0].reason, 'conflicting_duplicate_physical_input');
  assert.equal(first.rejected[0].key, second.rejected[0].key);
  assert.deepEqual(first.rejected[0].indexes, [0, 1]);
  assert.deepEqual(second.rejected[0].indexes, [0, 1]);
});
test('focus-originated ordinary entry emits only activity_logged', () => {
  const draft = adapterDraft({ focusSession: true, pomodoroCount: 1 });
  assert.equal(draft.type, 'activity_logged');
  assert.notEqual(draft.type, 'focus_session_completed');
});
test('malformed or insufficient source records are rejected deterministically', () => {
  assert.equal(normalizeChronaSenseEntry(chronaEntry({ tsStart: Date.parse(LL_TIME.end) }), CS_CONTEXT).reason, 'invalid_interval');
  assert.equal(normalizeChronaSenseEntry(chronaEntry({ activity: '' }), CS_CONTEXT).reason, 'missing_activity');
  assert.equal(normalizeChronaSenseEntry(chronaEntry(), { observedAt: LL_TIME.recorded }).reason, 'missing_source_timezone');
  assert.equal(normalizeChronaSenseEntry(chronaEntry({ deleted: true, updatedAt: null }), CS_CONTEXT).reason, 'invalid_deletion_evidence');
});
test('adapter does not mutate the source object', () => {
  const source = chronaEntry({ note: 'Keep this note' });
  const before = JSON.parse(JSON.stringify(source));
  normalizeChronaSenseEntry(source, CS_CONTEXT);
  assert.deepEqual(source, before);
});
test('normalized output passes Life Ledger validation and upsert', () => {
  const store = createLifeLedgerMemoryStore();
  const result = upsertLifeLedgerEvent(store, adapterDraft(), {
    createId: () => '56565656-5656-4565-8565-565656565656',
    clock: () => LL_TIME.recorded
  });
  assert.equal(result.action, 'created');
  assert.equal(validateLifeLedgerEvent(result.event).ok, true);
});
test('repeated adapter plus upsert retry remains idempotent', () => {
  let ids = 0;
  const store = createLifeLedgerMemoryStore();
  const opts = {
    createId: () => {
      ids++;
      return '67676767-6767-4676-8676-676767676767';
    },
    clock: sequencedClock(LL_TIME.recorded, '2026-08-28T00:00:00.000Z')
  };
  const first = upsertLifeLedgerEvent(store, adapterDraft(), opts);
  const retry = upsertLifeLedgerEvent(store, adapterDraft({}, { observedAt: '2026-08-28T00:00:00.000Z' }), opts);
  assert.equal(first.action, 'created');
  assert.equal(retry.action, 'unchanged');
  assert.equal(retry.event.eventId, first.event.eventId);
  assert.equal(retry.event.revision, 1);
  assert.equal(ids, 1);
});
test('legacy entries without tsStart use stored duration without machine-time reinterpretation', () => {
  const draft = adapterDraft({ tsStart: undefined, blockIntervalMin: 30 });
  assert.equal(draft.payload.startedAt, '2026-08-27T16:15:00.000Z');
  assert.equal(draft.payload.endedAt, LL_TIME.end);
  assert.equal(draft.sourceTimezone, 'America/Phoenix');
});

console.log('\nLife Ledger validation');
test('valid V1 persisted event passes', () => {
  assert.equal(validateLifeLedgerEvent(sampleStoredEvent()).ok, true);
});
test('unsupported sourceApp fails', () => {
  const result = validateLifeLedgerEventDraft(sampleActivityDraft({ sourceApp: 'calendar' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('sourceApp')));
});
test('unsupported type fails', () => {
  const result = validateLifeLedgerEventDraft(sampleActivityDraft({ type: 'journal_entry_added' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('type')));
});
test('malformed timestamp fails', () => {
  const result = validateLifeLedgerEventDraft(sampleActivityDraft({ occurredAt: '2026-08-27 16:45' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('occurredAt')));
});
test('malformed revision fails', () => {
  const result = validateLifeLedgerEvent(sampleStoredEvent({ revision: 0 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('revision')));
});
test('malformed provenance fails', () => {
  const event = sampleActivityDraft();
  event.provenance = { source: 'chronasense' };
  const result = validateLifeLedgerEventDraft(event);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('provenance')));
});
test('sourceTimezone is required for V1 local-window semantics', () => {
  const result = validateLifeLedgerEventDraft(sampleActivityDraft({ sourceTimezone: 'Phoenix' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('sourceTimezone')));
});
test('nested payload factual values must be JSON-safe', () => {
  [
    NaN,
    Infinity,
    -Infinity,
    undefined,
    new Date(LL_TIME.end),
    () => {},
    Symbol('x'),
    new Map([['x', 1]])
  ].forEach(bad => {
    const event = sampleActivityDraft({ payload: { source: { bad } } });
    const result = validateLifeLedgerEventDraft(event);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('payload.source.bad')), `expected payload.source.bad error for ${String(bad)}`);
  });
});
test('class instances and circular factual payloads are rejected safely', () => {
  class FactualBox {
    constructor() {
      this.value = 1;
    }
  }
  const classEvent = sampleActivityDraft({ payload: { source: { bad: new FactualBox() } } });
  const classResult = validateLifeLedgerEventDraft(classEvent);
  assert.equal(classResult.ok, false);
  assert.ok(classResult.errors.some(error => error.includes('payload.source.bad')));

  const circular = {};
  circular.self = circular;
  const circularEvent = sampleActivityDraft({ payload: { source: circular } });
  const circularResult = validateLifeLedgerEventDraft(circularEvent);
  assert.equal(circularResult.ok, false);
  assert.ok(circularResult.errors.some(error => error.includes('circular')));
});
test('sparse factual arrays are rejected instead of becoming implicit null', () => {
  const items = [];
  items.length = 2;
  items[1] = 'present';
  const result = validateLifeLedgerEventDraft(sampleActivityDraft({ payload: { source: { items } } }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('payload.source.items[0]')));
});
test('sparse nested factual arrays are rejected', () => {
  const items = [];
  items.length = 2;
  items[1] = { label: 'present' };
  const result = validateLifeLedgerEventDraft(sampleActivityDraft({ payload: { source: { deep: { items } } } }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('payload.source.deep.items[0]')));
});
test('explicit null in factual arrays remains valid', () => {
  const result = validateLifeLedgerEventDraft(sampleActivityDraft({ payload: { source: { items: [null, 'present'] } } }));
  assert.equal(result.ok, true);
});
test('dense factual arrays with nested JSON data remain valid', () => {
  const result = validateLifeLedgerEventDraft(sampleActivityDraft({
    payload: {
      source: {
        items: [
          { label: 'first', flags: [true, false], count: 1 },
          { label: 'second', meta: { note: 'present' } }
        ]
      }
    }
  }));
  assert.equal(result.ok, true);
});
test('unsupported factual provenance, confidence, and tombstone values are rejected', () => {
  const provenanceEvent = sampleActivityDraft();
  provenanceEvent.provenance.evidence = ['chronasense.entries/1700000000000'];
  provenanceEvent.provenance.extra = { bad: new Set(['x']) };
  assert.equal(validateLifeLedgerEventDraft(provenanceEvent).ok, false);

  const confidenceEvent = sampleActivityDraft({ confidence: { source: { bad: NaN } } });
  assert.equal(validateLifeLedgerEventDraft(confidenceEvent).ok, false);

  const tombstoneEvent = tombstoneDraft();
  tombstoneEvent.tombstone.provenance.sourceMetadata = { bad: new Date(LL_TIME.end) };
  assert.equal(validateLifeLedgerEventDraft(tombstoneEvent).ok, false);
});
test('non-activity payload validation covers valid and invalid meal_prepared events', () => {
  const valid = {
    schemaVersion: 1,
    sourceApp: 'meal',
    sourceEntityId: 'cooked-meal-1',
    type: 'meal_prepared',
    occurredAt: '2026-08-27T18:00:00.000Z',
    sourceTimezone: 'America/Phoenix',
    payload: {
      mealName: 'Chicken bowls',
      preparedAt: '2026-08-27T18:00:00.000Z',
      servingsPrepared: 4
    },
    provenance: {
      source: 'meal',
      sourceRecordKind: 'meal.cooked_meal',
      adapterVersion: 'meal-v1',
      observedAt: '2026-08-27T18:01:00.000Z',
      evidence: ['meal.cookedMeals/cooked-meal-1']
    },
    confidence: { score: 1, basis: 'source-recorded' },
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null }
  };
  assert.equal(validateLifeLedgerEventDraft(valid).ok, true);
  const invalid = { ...valid, payload: { mealName: 'Chicken bowls' } };
  assert.equal(validateLifeLedgerEventDraft(invalid).ok, false);
});

console.log('\nLife Ledger identity');
test('same logical source fact derives same idempotency key', () => {
  assert.equal(
    deriveLifeLedgerKey(sampleActivityDraft()),
    'chronasense:1700000000000:activity_logged'
  );
});
test('mutable payload change does not change logical key', () => {
  const a = sampleActivityDraft();
  const b = sampleActivityDraft({ payload: { activity: 'Renamed work' } });
  assert.equal(deriveLifeLedgerKey(a), deriveLifeLedgerKey(b));
});
test('same raw source ID is scoped by sourceApp and type', () => {
  const workout = {
    ...sampleActivityDraft({
      sourceApp: 'workout',
      type: 'workout_completed',
      sourceEntityId: '1700000000000',
      occurredAt: LL_TIME.end,
      payload: {
        workoutName: 'Leg day',
        startedAt: LL_TIME.start,
        endedAt: LL_TIME.end,
        durationMinutes: 45
      },
      provenance: {
        source: 'workout',
        sourceRecordKind: 'workout.workout',
        adapterVersion: 'workout-v1',
        observedAt: LL_TIME.recorded,
        evidence: ['workout.completed/1700000000000']
      }
    })
  };
  assert.notEqual(deriveLifeLedgerKey(sampleActivityDraft()), deriveLifeLedgerKey(workout));
});

console.log('\nLife Ledger fingerprint');
test('object key-order differences do not change fingerprint', () => {
  const a = sampleActivityDraft({
    payload: { source: { z: 1, a: 2 } }
  });
  const b = sampleActivityDraft({
    payload: { source: { a: 2, z: 1 } }
  });
  assert.equal(fingerprintLifeLedgerEvent(a), fingerprintLifeLedgerEvent(b));
  assert.equal(serializeLifeLedgerFacts(a), serializeLifeLedgerFacts(b));
});
test('observedAt-only change does not change factual fingerprint', () => {
  const a = sampleActivityDraft();
  const b = sampleActivityDraft({ provenance: { observedAt: '2026-08-28T00:00:00.000Z' } });
  assert.equal(fingerprintLifeLedgerEvent(a), fingerprintLifeLedgerEvent(b));
});
test('adapterVersion-only change does not change factual fingerprint', () => {
  const a = sampleActivityDraft();
  const b = sampleActivityDraft({ provenance: { adapterVersion: 'chronasense-v2' } });
  assert.equal(fingerprintLifeLedgerEvent(a), fingerprintLifeLedgerEvent(b));
});
test('recordedAt, revisedAt, revision, and eventId do not affect fingerprint', () => {
  const a = sampleStoredEvent();
  const b = sampleStoredEvent({
    eventId: '4f1d7f69-8b5a-4f10-b7ec-d1c45e6fba55',
    recordedAt: '2026-08-30T00:00:00.000Z',
    revisedAt: '2026-08-30T01:00:00.000Z',
    revision: 9
  });
  assert.equal(fingerprintLifeLedgerEvent(a), fingerprintLifeLedgerEvent(b));
});
test('sourceTimezone and occurredAt changes affect factual fingerprint', () => {
  const base = sampleActivityDraft();
  assert.notEqual(fingerprintLifeLedgerEvent(base), fingerprintLifeLedgerEvent(sampleActivityDraft({ sourceTimezone: 'Asia/Manila' })));
  assert.notEqual(fingerprintLifeLedgerEvent(base), fingerprintLifeLedgerEvent(sampleActivityDraft({
    occurredAt: '2026-08-27T17:00:00.000Z',
    payload: { endedAt: '2026-08-27T17:00:00.000Z' }
  })));
});
test('tombstone-state change affects factual fingerprint', () => {
  assert.notEqual(fingerprintLifeLedgerEvent(sampleActivityDraft()), fingerprintLifeLedgerEvent(tombstoneDraft()));
});

console.log('\nLife Ledger upsert');
test('new event gets one UUID, revision 1, and immutable recordedAt', () => {
  const store = createLifeLedgerMemoryStore();
  const result = upsertLifeLedgerEvent(store, sampleActivityDraft(), {
    createId: () => '11111111-1111-4111-8111-111111111111',
    clock: () => LL_TIME.recorded
  });
  assert.equal(result.action, 'created');
  assert.equal(result.event.eventId, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.event.sourceEntityId, '1700000000000');
  assert.equal(result.event.revision, 1);
  assert.equal(result.event.recordedAt, LL_TIME.recorded);
  assert.equal(result.event.revisedAt, null);
});
test('same normalized event twice creates one logical event and keeps revision 1', () => {
  let ids = 0;
  const store = createLifeLedgerMemoryStore();
  const opts = {
    createId: () => {
      ids++;
      return '22222222-2222-4222-8222-222222222222';
    },
    clock: sequencedClock(LL_TIME.recorded, '2026-08-28T00:00:00.000Z')
  };
  const first = upsertLifeLedgerEvent(store, sampleActivityDraft(), opts);
  const second = upsertLifeLedgerEvent(store, sampleActivityDraft({ provenance: { observedAt: '2026-08-28T00:00:00.000Z' } }), opts);
  assert.equal(first.action, 'created');
  assert.equal(second.action, 'unchanged');
  assert.equal(second.event.eventId, first.event.eventId);
  assert.equal(second.event.revision, 1);
  assert.equal(second.event.recordedAt, LL_TIME.recorded);
  assert.equal(second.event.revisedAt, null);
  assert.equal(store.listEvents().length, 1);
  assert.equal(ids, 1);
});
test('factual payload change increments revision and keeps identity fields', () => {
  const store = createLifeLedgerMemoryStore();
  const opts = {
    createId: () => '33333333-3333-4333-8333-333333333333',
    clock: sequencedClock(LL_TIME.recorded, LL_TIME.revised)
  };
  const first = upsertLifeLedgerEvent(store, sampleActivityDraft(), opts);
  const second = upsertLifeLedgerEvent(store, sampleActivityDraft({ payload: { activity: 'Deep work corrected' } }), opts);
  assert.equal(second.action, 'revised');
  assert.equal(second.event.eventId, first.event.eventId);
  assert.equal(second.event.recordedAt, first.event.recordedAt);
  assert.equal(second.event.revision, 2);
  assert.equal(second.event.revisedAt, LL_TIME.revised);
});
test('explicit tombstone transition increments revision and keeps eventId', () => {
  const store = createLifeLedgerMemoryStore();
  const opts = {
    createId: () => '44444444-4444-4444-8444-444444444444',
    clock: sequencedClock(LL_TIME.recorded, '2026-08-27T17:05:00.000Z')
  };
  const first = upsertLifeLedgerEvent(store, sampleActivityDraft(), opts);
  const deleted = upsertLifeLedgerEvent(store, tombstoneDraft(), opts);
  assert.equal(deleted.action, 'tombstoned');
  assert.equal(deleted.event.eventId, first.event.eventId);
  assert.equal(deleted.event.revision, 2);
  assert.equal(deleted.event.tombstone.active, true);
});
test('empty batch does not infer a tombstone from source absence', () => {
  const store = createLifeLedgerMemoryStore();
  upsertLifeLedgerEvent(store, sampleActivityDraft(), {
    createId: () => '55555555-5555-4555-8555-555555555555',
    clock: () => LL_TIME.recorded
  });
  const batch = upsertManyLifeLedgerEvents(store, []);
  const [event] = store.listEvents();
  assert.equal(batch.action, 'ok');
  assert.equal(event.tombstone.active, false);
});
test('explicit restore clears tombstone, increments revision, and keeps eventId', () => {
  const store = createLifeLedgerMemoryStore();
  const opts = {
    createId: () => '66666666-6666-4666-8666-666666666666',
    clock: sequencedClock(LL_TIME.recorded, '2026-08-27T17:05:00.000Z', '2026-08-27T17:30:00.000Z')
  };
  const first = upsertLifeLedgerEvent(store, sampleActivityDraft(), opts);
  upsertLifeLedgerEvent(store, tombstoneDraft(), opts);
  const restored = upsertLifeLedgerEvent(store, sampleActivityDraft({
    provenance: {
      sourceOperation: 'restore',
      observedAt: '2026-08-27T17:30:00.000Z'
    }
  }), opts);
  assert.equal(restored.action, 'restored');
  assert.equal(restored.event.eventId, first.event.eventId);
  assert.equal(restored.event.revision, 3);
  assert.equal(restored.event.tombstone.active, false);
});
test('create with restore provenance is rejected', () => {
  const store = createLifeLedgerMemoryStore();
  let ids = 0;
  const result = upsertLifeLedgerEvent(store, sampleActivityDraft({
    provenance: { sourceOperation: 'restore' }
  }), {
    createId: () => {
      ids++;
      return 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    },
    clock: () => LL_TIME.recorded
  });
  assert.equal(result.action, 'rejected');
  assert.equal(result.reason, 'restore_requires_existing_tombstone');
  assert.equal(store.listEvents().length, 0);
  assert.equal(ids, 0);
});
test('active never-deleted event rejects restore provenance without changing stored state', () => {
  const store = createLifeLedgerMemoryStore();
  const opts = {
    createId: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    clock: sequencedClock(LL_TIME.recorded, LL_TIME.revised)
  };
  const first = upsertLifeLedgerEvent(store, sampleActivityDraft(), opts);
  const rejected = upsertLifeLedgerEvent(store, sampleActivityDraft({
    provenance: {
      sourceOperation: 'restore',
      observedAt: LL_TIME.revised
    }
  }), opts);
  const [stored] = store.listEvents();
  assert.equal(rejected.action, 'rejected');
  assert.equal(rejected.reason, 'restore_requires_existing_tombstone');
  assert.equal(stored.eventId, first.event.eventId);
  assert.equal(stored.revision, 1);
  assert.equal(stored.recordedAt, LL_TIME.recorded);
  assert.equal(stored.revisedAt, null);
  assert.equal(stored.tombstone.active, false);
});
test('simple reappearance after tombstone is rejected without restore evidence', () => {
  const store = createLifeLedgerMemoryStore();
  const opts = {
    createId: () => '77777777-7777-4777-8777-777777777777',
    clock: sequencedClock(LL_TIME.recorded, '2026-08-27T17:05:00.000Z', '2026-08-27T17:30:00.000Z')
  };
  upsertLifeLedgerEvent(store, sampleActivityDraft(), opts);
  upsertLifeLedgerEvent(store, tombstoneDraft(), opts);
  const reappeared = upsertLifeLedgerEvent(store, sampleActivityDraft({
    provenance: { observedAt: '2026-08-27T17:30:00.000Z' }
  }), opts);
  assert.equal(reappeared.action, 'rejected');
  assert.equal(reappeared.reason, 'restore_requires_explicit_evidence');
  assert.equal(store.listEvents()[0].tombstone.active, true);
});
test('repeated identical restored retry does not increment revision again', () => {
  const store = createLifeLedgerMemoryStore();
  const opts = {
    createId: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    clock: sequencedClock(LL_TIME.recorded, '2026-08-27T17:05:00.000Z', '2026-08-27T17:30:00.000Z', '2026-08-27T18:00:00.000Z')
  };
  const created = upsertLifeLedgerEvent(store, sampleActivityDraft(), opts);
  upsertLifeLedgerEvent(store, tombstoneDraft(), opts);
  const restoreDraft = sampleActivityDraft({
    provenance: {
      sourceOperation: 'restore',
      observedAt: '2026-08-27T17:30:00.000Z'
    }
  });
  const restored = upsertLifeLedgerEvent(store, restoreDraft, opts);
  const retried = upsertLifeLedgerEvent(store, restoreDraft, opts);
  assert.equal(retried.action, 'unchanged');
  assert.equal(retried.event.eventId, created.event.eventId);
  assert.equal(restored.event.revision, 3);
  assert.equal(retried.event.revision, 3);
});
test('repeated retry after create does not create duplicate UUIDs or events', () => {
  let ids = 0;
  const store = createLifeLedgerMemoryStore();
  const opts = {
    createId: () => {
      ids++;
      return '88888888-8888-4888-8888-888888888888';
    },
    clock: () => LL_TIME.recorded
  };
  upsertLifeLedgerEvent(store, sampleActivityDraft(), opts);
  upsertLifeLedgerEvent(store, sampleActivityDraft(), opts);
  upsertLifeLedgerEvent(store, sampleActivityDraft(), opts);
  assert.equal(store.listEvents().length, 1);
  assert.equal(store.listEvents()[0].eventId, '88888888-8888-4888-8888-888888888888');
  assert.equal(ids, 1);
});
test('sparse arrays are rejected by upsert before successful fingerprint persistence', () => {
  let ids = 0;
  const store = createLifeLedgerMemoryStore();
  const items = [];
  items.length = 2;
  items[1] = 'present';
  const result = upsertLifeLedgerEvent(store, sampleActivityDraft({ payload: { source: { items } } }), {
    createId: () => {
      ids++;
      return '99999999-9999-4999-8999-999999999999';
    },
    clock: () => LL_TIME.recorded
  });
  assert.equal(result.action, 'rejected');
  assert.equal(result.reason, 'invalid_event');
  assert.equal(store.listEvents().length, 0);
  assert.equal(ids, 0);
});
test('repeated identical retry after factual revision does not increment revision again', () => {
  const store = createLifeLedgerMemoryStore();
  const opts = {
    createId: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    clock: sequencedClock(LL_TIME.recorded, LL_TIME.revised, '2026-08-27T18:00:00.000Z')
  };
  upsertLifeLedgerEvent(store, sampleActivityDraft(), opts);
  const corrected = sampleActivityDraft({ payload: { activity: 'Deep work corrected' } });
  const revision = upsertLifeLedgerEvent(store, corrected, opts);
  const retry = upsertLifeLedgerEvent(store, corrected, opts);
  assert.equal(revision.action, 'revised');
  assert.equal(revision.event.revision, 2);
  assert.equal(retry.action, 'unchanged');
  assert.equal(retry.event.revision, 2);
});
test('conflicting duplicate physical input rejects batch without minting multiple logical events', () => {
  let ids = 0;
  const store = createLifeLedgerMemoryStore();
  const result = upsertManyLifeLedgerEvents(store, [
    sampleActivityDraft(),
    sampleActivityDraft({ payload: { activity: 'Conflicting physical duplicate' } })
  ], {
    createId: () => {
      ids++;
      return '99999999-9999-4999-8999-999999999999';
    },
    clock: () => LL_TIME.recorded
  });
  assert.equal(result.action, 'partial');
  assert.equal(result.results[0].reason, 'conflicting_duplicate_physical_input');
  assert.equal(store.listEvents().length, 0);
  assert.equal(ids, 0);
});
test('identical duplicate physical rows in one batch create only one logical event', () => {
  let ids = 0;
  const store = createLifeLedgerMemoryStore();
  const result = upsertManyLifeLedgerEvents(store, [
    sampleActivityDraft(),
    sampleActivityDraft()
  ], {
    createId: () => {
      ids++;
      return 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    },
    clock: () => LL_TIME.recorded
  });
  assert.equal(result.action, 'ok');
  assert.equal(store.listEvents().length, 1);
  assert.equal(ids, 1);
});
test('conflicting duplicate rows reversed in input order produce same rejection outcome', () => {
  const a = sampleActivityDraft();
  const b = sampleActivityDraft({ payload: { activity: 'Conflicting physical duplicate' } });
  const first = upsertManyLifeLedgerEvents(createLifeLedgerMemoryStore(), [a, b], {
    createId: () => '12345678-1234-4234-8234-123456789abc',
    clock: () => LL_TIME.recorded
  });
  const second = upsertManyLifeLedgerEvents(createLifeLedgerMemoryStore(), [b, a], {
    createId: () => '12345678-1234-4234-8234-123456789abc',
    clock: () => LL_TIME.recorded
  });
  assert.equal(first.action, second.action);
  assert.equal(first.results[0].reason, 'conflicting_duplicate_physical_input');
  assert.equal(second.results[0].reason, 'conflicting_duplicate_physical_input');
  assert.equal(first.results[0].key, second.results[0].key);
});
test('returned store object mutation cannot mutate stored state', () => {
  const store = createLifeLedgerMemoryStore();
  const created = upsertLifeLedgerEvent(store, sampleActivityDraft(), {
    createId: () => 'abcdefab-abcd-4abc-8abc-abcdefabcdef',
    clock: () => LL_TIME.recorded
  });
  created.event.payload.activity = 'Mutated outside';
  assert.equal(store.listEvents()[0].payload.activity, 'Deep work');
});
test('listed store object mutation cannot mutate stored state', () => {
  const store = createLifeLedgerMemoryStore();
  upsertLifeLedgerEvent(store, sampleActivityDraft(), {
    createId: () => 'fedcbafe-dcba-4dcb-8dcb-fedcbafedcba',
    clock: () => LL_TIME.recorded
  });
  const listed = store.listEvents();
  listed[0].payload.activity = 'Mutated outside';
  assert.equal(store.listEvents()[0].payload.activity, 'Deep work');
});
test('source-owned timestamp-style ChronaSense IDs remain stable strings', () => {
  const store = createLifeLedgerMemoryStore();
  const result = upsertLifeLedgerEvent(store, sampleActivityDraft({ sourceEntityId: '1700000000000' }), {
    createId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    clock: () => LL_TIME.recorded
  });
  assert.equal(result.event.sourceEntityId, '1700000000000');
  assert.notEqual(result.event.eventId, result.event.sourceEntityId);
  assert.equal(deriveLifeLedgerKey({ sourceApp: 'chronasense', sourceEntityId: 1700000000000, type: 'activity_logged' }), deriveLifeLedgerKey(result.event));
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
