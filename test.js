// node test.js
import assert from 'node:assert/strict';
import './focus-wallet.js';

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

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
