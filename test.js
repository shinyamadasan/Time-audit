// node test.js
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  LIFE_LEDGER_RUNTIME_KEY,
  LifeLedgerRuntimeStoreError,
  buildLearningPlanFocusSessionCompletedDraft,
  buildLearningPlanStepCompletedDraft,
  buildLearningPlanStepReopenedDraft,
  createLocalLifeLedgerStore,
  learningPlanStepSourceEntityId,
  recordLearningPlanFocusSessionCompleted,
  recordLearningPlanStepCompleted,
  recordLearningPlanStepReopened
} from './life-ledger-runtime.js';
import {
  LIFE_LEDGER_TRANSPORT_KIND,
  LIFE_LEDGER_TRANSPORT_SCHEMA_VERSION,
  createLifeLedgerSnapshotFromEvents,
  exportLifeLedgerSnapshot,
  exportLifeLedgerSnapshotJson,
  parseLifeLedgerSnapshotJson,
  serializeLifeLedgerSnapshot,
  snapshotHasOnlyLedgerEnvelope
} from './life-ledger-transport.js';
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
import {
  LEARNING_PLAN_REPOSITORY_KEY,
  LearningPlanRepositoryError,
  createLearningPlanRepository
} from './learning-plan-repository.js';
import { parseLearningPlanOutline } from './learning-plan-import.js';
import { findNextLearningPlanStep } from './learning-plan-next-action.js';
import {
  addCareerTarget,
  addEvidence,
  addPortfolioArtifact,
  addProject,
  addSkill,
  addTool,
  archiveSkill,
  createEmptyCapabilityProfile,
  updateProjectPortfolioStatus,
  validateCapabilityProfile
} from './capability-career-model.js';
import {
  CAPABILITY_CAREER_REPOSITORY_KEY,
  CapabilityCareerRepositoryError,
  createCapabilityCareerRepository
} from './capability-career-repository.js';
import {
  buildCapabilityProfileFromImportDraft,
  parseCapabilityCareerImportJson
} from './capability-career-import.js';
import { analyzeCapabilityCareer } from './capability-career-analytics.js';
import {
  OBSIDIAN_LIFE_LEDGER_SENTINEL,
  buildObsidianLifeLedgerExport
} from './obsidian-life-ledger-renderer.js';
import {
  resolveObsidianLifeLedgerPath,
  writeObsidianLifeLedgerExport
} from './obsidian-life-ledger-writer.js';
import { runLifeLedgerObsidianExport } from './scripts/export-life-ledger-to-obsidian.mjs';

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
const asyncTests = [];

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

function asyncTest(name, fn) {
  asyncTests.push((async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  })());
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

function makeMemoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  let setCalls = 0;
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      setCalls++;
      data.set(key, String(value));
    },
    raw(key = LEARNING_PLAN_REPOSITORY_KEY) {
      return data.get(key);
    },
    setCalls() {
      return setCalls;
    }
  };
}

function learningPlanRepository(storage = makeMemoryStorage()) {
  return createLearningPlanRepository({ storage });
}

function repositoryEnvelope(storage, key = LEARNING_PLAN_REPOSITORY_KEY) {
  return JSON.parse(storage.raw(key));
}

function secondSeededLearningPlan() {
  let plan = createLearningPlan({ title: 'Backend fundamentals' }, {
    idGenerator: sequencedIds('plan-2'),
    clock: fixedClock(LP_TIME.created)
  });
  plan = addPhase(plan, { title: 'Phase C' }, {
    idGenerator: sequencedIds('phase-c'),
    clock: fixedClock(LP_TIME.updated)
  });
  plan = addLesson(plan, 'phase-c', { title: 'Lesson C' }, {
    idGenerator: sequencedIds('lesson-c'),
    clock: fixedClock(LP_TIME.updated)
  });
  plan = addStep(plan, 'lesson-c', { title: 'Step C' }, {
    idGenerator: sequencedIds('step-c'),
    clock: fixedClock(LP_TIME.updated)
  });
  return plan;
}

function completedPlanWithSharedStepId(planId, title) {
  let plan = createLearningPlan({ title }, {
    idGenerator: sequencedIds(planId),
    clock: fixedClock(LP_TIME.created)
  });
  plan = addPhase(plan, { title: `${title} phase` }, {
    idGenerator: sequencedIds(`${planId}-phase`),
    clock: fixedClock(LP_TIME.updated)
  });
  plan = addLesson(plan, `${planId}-phase`, { title: `${title} lesson` }, {
    idGenerator: sequencedIds(`${planId}-lesson`),
    clock: fixedClock(LP_TIME.updated)
  });
  plan = addStep(plan, `${planId}-lesson`, { title: `${title} shared step` }, {
    idGenerator: sequencedIds('shared-step'),
    clock: fixedClock(LP_TIME.updated)
  });
  return completeStep(plan, 'shared-step', { clock: fixedClock(LP_TIME.completed) });
}

function learningPlanIds(plan) {
  return [
    plan.id,
    ...plan.phases.flatMap(phase => [
      phase.id,
      ...phase.lessons.flatMap(lesson => [
        lesson.id,
        ...lesson.steps.map(step => step.id)
      ])
    ])
  ];
}

function withGlobalLocalStorage(storage, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: storage
    });
    fn();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
}

// -- Capability/Career model -------------------------------------------------

const CC_TIME = {
  created: '2026-08-30T12:00:00.000Z',
  recent: '2026-08-29T12:00:00.000Z',
  stale: '2026-06-01T12:00:00.000Z',
  now: '2026-08-31T12:00:00.000Z'
};

function ccOptions(...ids) {
  return { idGenerator: sequencedIds(...ids), clock: fixedClock(CC_TIME.created) };
}

function createCapabilityEvidenceLike(id) {
  return {
    id,
    skillId: 'skill-js',
    dimension: 'knowledge',
    source: 'manual',
    summary: 'Synthetic evidence',
    observedAt: CC_TIME.recent,
    createdAt: CC_TIME.recent,
    updatedAt: CC_TIME.recent
  };
}

function seededCapabilityProfile() {
  let profile = createEmptyCapabilityProfile({ clock: fixedClock(CC_TIME.created) });
  profile = addSkill(profile, { name: 'JavaScript', category: 'Engineering' }, ccOptions('skill-js'));
  profile = addSkill(profile, { name: 'API integration', category: 'Engineering' }, ccOptions('skill-api'));
  profile = addTool(profile, { name: 'GitHub', skillIds: ['skill-js'] }, ccOptions('tool-github'));
  profile = addCareerTarget(profile, {
    title: 'Automation developer',
    objective: 'Build durable automations',
    skillIds: ['skill-js', 'skill-api'],
    priority: 'primary'
  }, ccOptions('target-auto'));
  profile = addProject(profile, {
    title: 'Adapter project',
    summary: 'Connect app facts to the ledger',
    skillIds: ['skill-js', 'skill-api'],
    toolIds: ['tool-github'],
    careerTargetIds: ['target-auto'],
    portfolioStatus: 'candidate'
  }, ccOptions('project-adapter'));
  return profile;
}

function addCcEvidence(profile, id, skillId, dimension, observedAt = CC_TIME.recent, extra = {}) {
  return addEvidence(profile, {
    skillId,
    dimension,
    source: extra.source || 'manual',
    summary: extra.summary || `${dimension} evidence`,
    observedAt,
    ...extra
  }, ccOptions(id));
}

function ccLedgerEvent(eventId, tombstoned = false) {
  return {
    eventId,
    tombstone: tombstoned
      ? {
          active: true,
          deletedAt: '2026-08-30T13:00:00.000Z',
          reason: 'user_delete',
          provenance: { sourceOperation: 'delete', sourceRecordKind: 'test', evidence: ['test'] }
        }
      : { active: false, deletedAt: null, reason: null, provenance: null }
  };
}

function setCcProjectStatus(profile, projectId, status, portfolioStatus = 'candidate') {
  return {
    ...profile,
    projects: profile.projects.map(project => project.id === projectId
      ? { ...project, status, portfolioStatus, updatedAt: CC_TIME.created }
      : project)
  };
}

console.log('\nCapability/Career model');
test('empty Capability/Career profile is versioned and valid', () => {
  const profile = createEmptyCapabilityProfile({ clock: fixedClock(CC_TIME.created) });
  assert.equal(profile.schemaVersion, 1);
  assert.deepEqual(validateCapabilityProfile(profile), { ok: true, errors: [] });
});
test('stable IDs are generated once and not derived from names', () => {
  const profile = seededCapabilityProfile();
  assert.equal(profile.skills[0].id, 'skill-js');
  assert.equal(profile.skills[0].name, 'JavaScript');
  assert.notEqual(profile.skills[0].id, profile.skills[0].name);
});
test('validation rejects duplicate IDs and missing references', () => {
  const profile = seededCapabilityProfile();
  assert.equal(validateCapabilityProfile({ ...profile, skills: [...profile.skills, { ...profile.skills[0] }] }).ok, false);
  const broken = validateCapabilityProfile({ ...profile, evidence: [{ ...createCapabilityEvidenceLike('e1'), skillId: 'missing' }] });
  assert.equal(broken.ok, false);
  assert.match(broken.errors.join('; '), /missing skill/);
});
test('validation enforces constructor string limits during hydration', () => {
  const profile = seededCapabilityProfile();
  const oversizedSkill = { ...profile.skills[0], name: 'x'.repeat(161) };
  const oversizedEvidence = { ...createCapabilityEvidenceLike('e-long-summary'), summary: 'x'.repeat(241) };
  const result = validateCapabilityProfile({
    ...profile,
    skills: [oversizedSkill, profile.skills[1]],
    evidence: [oversizedEvidence]
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /skills\[0\]\.name must be 160 characters or fewer/);
  assert.match(result.errors.join('; '), /evidence\[0\]\.summary must be 240 characters or fewer/);
});
test('archiving a referenced skill preserves references without cascading evidence', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-js-1', 'skill-js', 'execution');
  profile = archiveSkill(profile, 'skill-js', ccOptions());
  assert.equal(profile.skills.find(skill => skill.id === 'skill-js').status, 'archived');
  assert.equal(profile.evidence[0].skillId, 'skill-js');
  assert.equal(validateCapabilityProfile(profile).ok, true);
});
test('portfolio artifacts are separate from evidence and link through projects', () => {
  let profile = seededCapabilityProfile();
  profile = addPortfolioArtifact(profile, {
    projectId: 'project-adapter',
    type: 'repository',
    label: 'Repo',
    reference: 'https://example.test/repo'
  }, ccOptions('artifact-repo'));
  assert.equal(profile.artifacts[0].id, 'artifact-repo');
  assert.equal(profile.projects[0].artifactIds[0], 'artifact-repo');
  assert.equal(profile.evidence.length, 0);
});
test('project portfolio status updates without changing project identity', () => {
  let profile = seededCapabilityProfile();
  profile = updateProjectPortfolioStatus(profile, 'project-adapter', 'ready', ccOptions());
  assert.equal(profile.projects[0].id, 'project-adapter');
  assert.equal(profile.projects[0].portfolioStatus, 'ready');
});
test('Life Ledger evidence can support different skills but not duplicate the same skill dimension', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-ledger-js', 'skill-js', 'execution', CC_TIME.recent, {
    source: 'life-ledger',
    lifeLedgerEventId: 'ledger-event-1',
    lifeLedgerKey: 'chronasense:entry-1:focus_session_completed'
  });
  profile = addCcEvidence(profile, 'e-ledger-api', 'skill-api', 'execution', CC_TIME.recent, {
    source: 'life-ledger',
    lifeLedgerEventId: 'ledger-event-1',
    lifeLedgerKey: 'chronasense:entry-1:focus_session_completed'
  });
  assert.equal(validateCapabilityProfile(profile).ok, true);
  assert.throws(() => addCcEvidence(profile, 'e-ledger-dup', 'skill-js', 'execution', CC_TIME.recent, {
    source: 'life-ledger',
    lifeLedgerEventId: 'ledger-event-1'
  }), /duplicates/);
});

console.log('\nCapability/Career repository');
test('repository returns an empty profile for missing storage', () => {
  const storage = makeMemoryStorage();
  const loaded = createCapabilityCareerRepository({ storage }).loadProfile();
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.skills.length, 0);
});
test('repository saves and reloads a validated profile', () => {
  const storage = makeMemoryStorage();
  const repo = createCapabilityCareerRepository({ storage });
  repo.saveProfile(seededCapabilityProfile());
  assert.equal(createCapabilityCareerRepository({ storage }).loadProfile().projects[0].title, 'Adapter project');
});
test('repository does not leak aliases from reads', () => {
  const storage = makeMemoryStorage();
  const repo = createCapabilityCareerRepository({ storage });
  repo.saveProfile(seededCapabilityProfile());
  const loaded = repo.loadProfile();
  loaded.skills[0].name = 'Mutated elsewhere';
  assert.equal(repo.loadProfile().skills[0].name, 'JavaScript');
});
test('repository surfaces corruption and unsupported versions without resetting storage', () => {
  const storage = makeMemoryStorage({ [CAPABILITY_CAREER_REPOSITORY_KEY]: '{bad json' });
  assert.throws(() => createCapabilityCareerRepository({ storage }).loadProfile(), error => error.code === 'invalid_json');
  assert.equal(storage.raw(CAPABILITY_CAREER_REPOSITORY_KEY), '{bad json');
  const unsupported = makeMemoryStorage({ [CAPABILITY_CAREER_REPOSITORY_KEY]: JSON.stringify({ schemaVersion: 99, profile: {} }) });
  assert.throws(() => createCapabilityCareerRepository({ storage: unsupported }).loadProfile(), error => error.code === 'unsupported_schema_version');
});
test('repository write failure preserves prior stored state', () => {
  const storage = makeMemoryStorage();
  const repo = createCapabilityCareerRepository({ storage });
  repo.saveProfile(seededCapabilityProfile());
  const before = storage.raw(CAPABILITY_CAREER_REPOSITORY_KEY);
  const failingStorage = {
    getItem: storage.getItem,
    setItem() { throw new Error('blocked write'); }
  };
  const next = addSkill(repo.loadProfile(), { name: 'Blocked' }, ccOptions('skill-blocked'));
  assert.throws(() => createCapabilityCareerRepository({ storage: failingStorage }).saveProfile(next), error => error.code === 'storage_write_failed');
  assert.equal(storage.raw(CAPABILITY_CAREER_REPOSITORY_KEY), before);
});
test('repository rejects invalid storage/key contracts', () => {
  assert.throws(() => createCapabilityCareerRepository({ storage: null }), error => error instanceof CapabilityCareerRepositoryError);
  assert.throws(() => createCapabilityCareerRepository({ storage: makeMemoryStorage(), key: '' }), error => error.code === 'invalid_key');
});
test('repository rejects oversized hydrated strings without clearing stored data', () => {
  const profile = seededCapabilityProfile();
  const invalid = { ...profile, skills: [{ ...profile.skills[0], description: 'x'.repeat(1001) }, profile.skills[1]] };
  const raw = JSON.stringify({ schemaVersion: 1, profile: invalid });
  const storage = makeMemoryStorage({ [CAPABILITY_CAREER_REPOSITORY_KEY]: raw });
  assert.throws(() => createCapabilityCareerRepository({ storage }).loadProfile(), error => error.code === 'invalid_profile');
  assert.equal(storage.raw(CAPABILITY_CAREER_REPOSITORY_KEY), raw);
});

console.log('\nCapability/Career import');
test('valid import previews counts and builds a linked profile', () => {
  const result = parseCapabilityCareerImportJson(JSON.stringify({
    skills: [{ name: 'JavaScript' }, { name: 'API integration' }],
    tools: [{ name: 'GitHub', skills: ['JavaScript'] }],
    careerTargets: [{ title: 'Automation developer', skills: ['JavaScript', 'API integration'] }],
    projects: [{ title: 'Adapter', skills: ['JavaScript'], tools: ['GitHub'], careerTargets: ['Automation developer'], portfolioStatus: 'candidate' }],
    artifacts: [{ project: 'Adapter', type: 'repository', label: 'Repo', reference: 'https://example.test/repo' }],
    evidence: [{ skill: 'JavaScript', dimension: 'execution', source: 'manual', summary: 'Built adapter', project: 'Adapter' }]
  }));
  assert.equal(result.ok, true);
  assert.equal(result.counts.evidence, 1);
  const imported = buildCapabilityProfileFromImportDraft(result.draft, {
    idGenerator: sequencedIds('skill-js', 'skill-api', 'tool-gh', 'target-auto', 'project-adapter', 'artifact-repo', 'e-js'),
    clock: fixedClock(CC_TIME.created)
  });
  assert.equal(imported.projects[0].skillIds[0], 'skill-js');
  assert.equal(imported.artifacts[0].projectId, 'project-adapter');
  assert.equal(imported.evidence[0].projectId, 'project-adapter');
});
test('import rejects malformed JSON, duplicate names, missing references, and user-supplied IDs', () => {
  assert.equal(parseCapabilityCareerImportJson('{bad').ok, false);
  const result = parseCapabilityCareerImportJson(JSON.stringify({
    skills: [{ id: 'not-accepted', name: 'JavaScript' }, { name: 'JavaScript' }],
    projects: [{ title: 'Broken', skills: ['Missing skill'] }]
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /id is not accepted/);
  assert.match(result.errors.join('; '), /duplicates/);
  assert.match(result.errors.join('; '), /references missing skill/);
});
test('malformed import does not partially persist through repository flow', () => {
  const storage = makeMemoryStorage();
  const parsed = parseCapabilityCareerImportJson(JSON.stringify({ evidence: [{ skill: 'Missing', dimension: 'knowledge', summary: 'Bad' }] }));
  assert.equal(parsed.ok, false);
  assert.equal(storage.raw(CAPABILITY_CAREER_REPOSITORY_KEY), undefined);
});

console.log('\nCapability/Career analytics');
test('insufficient data recommends explicit setup without fabricated gaps', () => {
  const analysis = analyzeCapabilityCareer(createEmptyCapabilityProfile({ clock: fixedClock(CC_TIME.created) }), { now: CC_TIME.now });
  assert.equal(analysis.insufficientData, true);
  assert.equal(analysis.nextAction.kind, 'setup-target');
  assert.equal(analysis.stalls.length, 0);
});
test('knowledge-heavy target skill produces application and execution stalls', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-k1', 'skill-js', 'knowledge');
  profile = addCcEvidence(profile, 'e-p1', 'skill-js', 'practice');
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  assert.ok(analysis.stalls.some(stall => stall.type === 'application-stall'));
  assert.ok(analysis.stalls.some(stall => stall.type === 'execution-stall'));
  assert.equal(analysis.nextAction.kind, 'execute-skill');
});
test('active target with no linked active skills is setup, not generic continuation', () => {
  let profile = createEmptyCapabilityProfile({ clock: fixedClock(CC_TIME.created) });
  profile = addSkill(profile, { name: 'Unrelated skill' }, ccOptions('skill-other'));
  profile = addCareerTarget(profile, { title: 'Automation developer', skillIds: [], priority: 'primary' }, ccOptions('target-empty'));
  profile = addCcEvidence(profile, 'e-other-1', 'skill-other', 'execution');
  profile = addCcEvidence(profile, 'e-other-2', 'skill-other', 'shipping');
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  assert.equal(analysis.insufficientData, true);
  assert.equal(analysis.nextAction.kind, 'map-target-skills');
  assert.deepEqual(analysis.targetSkillIds, []);
});
test('active target linked only to archived skills is setup even with unrelated evidence', () => {
  let profile = seededCapabilityProfile();
  profile = archiveSkill(profile, 'skill-js', ccOptions());
  profile = archiveSkill(profile, 'skill-api', ccOptions());
  profile = addSkill(profile, { name: 'Video editing' }, ccOptions('skill-video'));
  profile = addCcEvidence(profile, 'e-v1', 'skill-video', 'execution');
  profile = addCcEvidence(profile, 'e-v2', 'skill-video', 'shipping');
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  assert.equal(analysis.insufficientData, true);
  assert.equal(analysis.nextAction.kind, 'map-target-skills');
});
test('active linked target skill resumes normal analytics while unrelated targets stay irrelevant', () => {
  let profile = seededCapabilityProfile();
  profile = addSkill(profile, { name: 'Video editing' }, ccOptions('skill-video'));
  profile = addCareerTarget(profile, { title: 'Video target', skillIds: ['skill-video'], priority: 'secondary' }, ccOptions('target-video'));
  profile = addCcEvidence(profile, 'e-js-1', 'skill-js', 'execution');
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  assert.equal(analysis.insufficientData, false);
  assert.equal(analysis.target.id, 'target-auto');
  assert.deepEqual(analysis.targetSkillIds, ['skill-js', 'skill-api']);
  assert.notEqual(analysis.nextAction.kind, 'map-target-skills');
});
test('old evidence produces stale momentum only after enough evidence exists', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-old-1', 'skill-api', 'knowledge', CC_TIME.stale);
  profile = addCcEvidence(profile, 'e-old-2', 'skill-api', 'practice', CC_TIME.stale);
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  const api = analysis.skills.find(skill => skill.skillId === 'skill-api');
  assert.equal(api.momentum, 'stale');
  assert.ok(analysis.stalls.some(stall => stall.type === 'knowledge-stall' && stall.skillId === 'skill-api'));
});
test('future evidence is excluded from current momentum and dimension coverage', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-now', 'skill-js', 'execution', CC_TIME.now);
  profile = addCcEvidence(profile, 'e-future', 'skill-js', 'shipping', '2026-08-31T12:00:00.001Z');
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  const js = analysis.skills.find(skill => skill.skillId === 'skill-js');
  assert.equal(js.totalEvidence, 1);
  assert.equal(js.momentum, 'active');
  assert.equal(analysis.dimensionTotals.execution, 1);
  assert.equal(analysis.dimensionTotals.shipping, 0);
  assert.deepEqual(analysis.excludedEvidence.map(item => item.reason), ['future']);
});
test('recency boundaries are deterministic around now, 30 days, and 45 days', () => {
  const cases = [
    ['exact now', CC_TIME.now, 'active', 1],
    ['just before now', '2026-08-31T11:59:59.999Z', 'active', 1],
    ['just after now', '2026-08-31T12:00:00.001Z', 'no-evidence', 0],
    ['substantially future', '2026-09-30T12:00:00.000Z', 'no-evidence', 0],
    ['exactly 30 days', '2026-08-01T12:00:00.000Z', 'active', 1],
    ['just over 30 days', '2026-08-01T11:59:59.999Z', 'stale', 1],
    ['exactly 45 days', '2026-07-17T12:00:00.000Z', 'stale', 1],
    ['just over 45 days', '2026-07-17T11:59:59.999Z', 'stale', 1]
  ];
  cases.forEach(([label, observedAt, expectedMomentum, expectedEvidence]) => {
    let profile = seededCapabilityProfile();
    profile = addCcEvidence(profile, `e-${label.replaceAll(' ', '-')}`, 'skill-js', 'knowledge', observedAt);
    const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
    const js = analysis.skills.find(skill => skill.skillId === 'skill-js');
    assert.equal(js.momentum, expectedMomentum, label);
    assert.equal(js.totalEvidence, expectedEvidence, label);
  });
});
test('execution without shipping or portfolio prioritizes portfolio proof', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-ex-1', 'skill-js', 'execution');
  profile = addCcEvidence(profile, 'e-ex-2', 'skill-js', 'execution');
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  assert.ok(analysis.stalls.some(stall => stall.type === 'shipping-stall'));
  assert.ok(analysis.stalls.some(stall => stall.type === 'portfolio-stall'));
  assert.equal(analysis.nextAction.kind, 'portfolio-proof');
});
test('shipping without portfolio proof creates portfolio next action', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-ex-1', 'skill-js', 'execution');
  profile = addCcEvidence(profile, 'e-ship-1', 'skill-js', 'shipping');
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  assert.equal(analysis.nextAction.kind, 'portfolio-proof');
});
test('project progress without ready portfolio creates a project portfolio stall', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-project', 'skill-js', 'execution', CC_TIME.recent, {
    source: 'project',
    projectId: 'project-adapter'
  });
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  assert.ok(analysis.stalls.some(stall => stall.type === 'portfolio-stall' && stall.projectId === 'project-adapter'));
});
test('archived and paused projects do not generate actionable portfolio recommendations', () => {
  ['archived', 'paused'].forEach(status => {
    let profile = setCcProjectStatus(seededCapabilityProfile(), 'project-adapter', status, 'candidate');
    profile = addCcEvidence(profile, `e-${status}`, 'skill-js', 'execution', CC_TIME.recent, {
      source: 'project',
      projectId: 'project-adapter'
    });
    const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
    assert.equal(analysis.projects.find(project => project.projectId === 'project-adapter').actionable, false);
    assert.equal(analysis.stalls.some(stall => stall.projectId === 'project-adapter'), false);
    assert.equal(analysis.nextAction.title.includes('Adapter project'), false);
  });
});
test('archived project artifacts remain historical and do not create project actions', () => {
  let profile = setCcProjectStatus(seededCapabilityProfile(), 'project-adapter', 'archived', 'candidate');
  profile = addPortfolioArtifact(profile, {
    projectId: 'project-adapter',
    type: 'link',
    label: 'Historical proof',
    reference: 'https://example.test/historical'
  }, ccOptions('artifact-history'));
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  assert.equal(profile.artifacts.length, 1);
  assert.equal(analysis.stalls.some(stall => stall.projectId === 'project-adapter'), false);
  assert.equal(analysis.nextAction.title.includes('Adapter project'), false);
});
test('active project still produces a resolvable portfolio recommendation', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-active-project', 'skill-js', 'execution', CC_TIME.recent, {
    source: 'project',
    projectId: 'project-adapter'
  });
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  assert.ok(analysis.stalls.some(stall => stall.projectId === 'project-adapter'));
  assert.equal(analysis.nextAction.title, 'Turn Adapter project into presentable proof');
});
test('Life Ledger evidence counts only while the referenced event is live and available', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-ledger-live', 'skill-js', 'execution', CC_TIME.recent, {
    source: 'life-ledger',
    lifeLedgerEventId: 'ledger-event-1'
  });
  const live = analyzeCapabilityCareer(profile, { now: CC_TIME.now, lifeLedgerEvents: [ccLedgerEvent('ledger-event-1')] });
  assert.equal(live.skills.find(skill => skill.skillId === 'skill-js').totalEvidence, 1);
  const tombstoned = analyzeCapabilityCareer(profile, { now: CC_TIME.now, lifeLedgerEvents: [ccLedgerEvent('ledger-event-1', true)] });
  assert.equal(tombstoned.skills.find(skill => skill.skillId === 'skill-js').totalEvidence, 0);
  assert.equal(tombstoned.excludedEvidence[0].reason, 'life-ledger-tombstoned');
  assert.equal(profile.evidence.length, 1);
  const restored = analyzeCapabilityCareer(profile, { now: CC_TIME.now, lifeLedgerEvents: [ccLedgerEvent('ledger-event-1')] });
  assert.equal(restored.skills.find(skill => skill.skillId === 'skill-js').totalEvidence, 1);
});
test('missing Life Ledger references are preserved but unavailable for current proof', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-ledger-missing', 'skill-js', 'execution', CC_TIME.recent, {
    source: 'life-ledger',
    lifeLedgerEventId: 'ledger-event-missing'
  });
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now, lifeLedgerEvents: [] });
  assert.equal(analysis.skills.find(skill => skill.skillId === 'skill-js').totalEvidence, 0);
  assert.equal(analysis.excludedEvidence[0].reason, 'life-ledger-unavailable');
  assert.equal(validateCapabilityProfile(profile).ok, true);
});
test('non-target activity can trigger career alignment stall conservatively', () => {
  let profile = seededCapabilityProfile();
  profile = addSkill(profile, { name: 'Video editing' }, ccOptions('skill-video'));
  profile = addCcEvidence(profile, 'e-v1', 'skill-video', 'knowledge');
  profile = addCcEvidence(profile, 'e-v2', 'skill-video', 'practice');
  profile = addCcEvidence(profile, 'e-v3', 'skill-video', 'execution');
  profile = addCcEvidence(profile, 'e-v4', 'skill-video', 'shipping');
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  assert.ok(analysis.stalls.some(stall => stall.type === 'career-alignment-stall'));
});
test('balanced target evidence avoids stall diagnosis and recommends continuing', () => {
  let profile = seededCapabilityProfile();
  profile = addCcEvidence(profile, 'e-k', 'skill-js', 'knowledge');
  profile = addCcEvidence(profile, 'e-p', 'skill-js', 'practice');
  profile = addCcEvidence(profile, 'e-ex', 'skill-js', 'execution');
  profile = addCcEvidence(profile, 'e-ship', 'skill-js', 'shipping');
  profile = addCcEvidence(profile, 'e-port', 'skill-js', 'portfolio');
  profile = addCcEvidence(profile, 'e-api-ex', 'skill-api', 'execution');
  profile = addCcEvidence(profile, 'e-api-ship', 'skill-api', 'shipping');
  profile = addCcEvidence(profile, 'e-api-port', 'skill-api', 'portfolio');
  const analysis = analyzeCapabilityCareer(profile, { now: CC_TIME.now });
  assert.equal(analysis.stalls.filter(stall => stall.skillId === 'skill-js').length, 0);
  assert.equal(analysis.nextAction.kind, 'continue');
});

// -- Learning Plan Next Action -----------------------------------------------

function nextActionMultiPlan() {
  let plan = seededLearningPlan();
  plan = addStep(plan, 'lesson-b', { title: 'Step C' }, {
    idGenerator: sequencedIds('step-c'),
    clock: fixedClock(LP_TIME.updated)
  });
  plan = addLesson(plan, 'phase-b', { title: 'Lesson C' }, {
    idGenerator: sequencedIds('lesson-c'),
    clock: fixedClock(LP_TIME.updated)
  });
  plan = addStep(plan, 'lesson-c', { title: 'Step D' }, {
    idGenerator: sequencedIds('step-d'),
    clock: fixedClock(LP_TIME.updated)
  });
  return plan;
}

function nextStepId(plan) {
  return findNextLearningPlanStep(plan)?.stepId || null;
}

console.log('\nLearning Plan Next Action');
test('one unfinished step returns it', () => {
  const next = findNextLearningPlanStep(seededLearningPlan());
  assert.equal(next.stepId, 'step-a');
  assert.equal(next.stepTitle, 'Step A');
});
test('completed steps are skipped', () => {
  const plan = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.completed) });
  assert.equal(nextStepId(plan), 'step-b');
});
test('first unfinished step follows phase order', () => {
  let plan = nextActionMultiPlan();
  plan = completeStep(plan, 'step-a', { clock: fixedClock(LP_TIME.completed) });
  plan = completeStep(plan, 'step-b', { clock: fixedClock(LP_TIME.completed) });
  plan = completeStep(plan, 'step-c', { clock: fixedClock(LP_TIME.completed) });
  assert.equal(nextStepId(plan), 'step-d');
});
test('first unfinished step follows lesson order', () => {
  let plan = nextActionMultiPlan();
  plan = completeStep(plan, 'step-a', { clock: fixedClock(LP_TIME.completed) });
  plan = completeStep(plan, 'step-b', { clock: fixedClock(LP_TIME.completed) });
  assert.equal(nextStepId(plan), 'step-c');
});
test('first unfinished step follows step order', () => {
  const plan = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.completed) });
  assert.equal(nextStepId(plan), 'step-b');
});
test('empty phases are skipped', () => {
  let plan = createLearningPlan({ title: 'Empty phase first' }, {
    idGenerator: sequencedIds('plan-empty-phase'),
    clock: fixedClock(LP_TIME.created)
  });
  plan = addPhase(plan, { title: 'Empty phase' }, { idGenerator: sequencedIds('phase-empty'), clock: fixedClock() });
  plan = addPhase(plan, { title: 'Action phase' }, { idGenerator: sequencedIds('phase-action'), clock: fixedClock() });
  plan = addLesson(plan, 'phase-action', { title: 'Lesson' }, { idGenerator: sequencedIds('lesson-action'), clock: fixedClock() });
  plan = addStep(plan, 'lesson-action', { title: 'First action' }, { idGenerator: sequencedIds('step-action'), clock: fixedClock() });
  assert.equal(nextStepId(plan), 'step-action');
});
test('empty lessons are skipped', () => {
  let plan = createLearningPlan({ title: 'Empty lesson first' }, {
    idGenerator: sequencedIds('plan-empty-lesson'),
    clock: fixedClock(LP_TIME.created)
  });
  plan = addPhase(plan, { title: 'Phase' }, { idGenerator: sequencedIds('phase-empty-lesson'), clock: fixedClock() });
  plan = addLesson(plan, 'phase-empty-lesson', { title: 'Empty lesson' }, { idGenerator: sequencedIds('lesson-empty'), clock: fixedClock() });
  plan = addLesson(plan, 'phase-empty-lesson', { title: 'Action lesson' }, { idGenerator: sequencedIds('lesson-action'), clock: fixedClock() });
  plan = addStep(plan, 'lesson-action', { title: 'First action' }, { idGenerator: sequencedIds('step-action'), clock: fixedClock() });
  assert.equal(nextStepId(plan), 'step-action');
});
test('duplicate titles do not affect returned identity', () => {
  let plan = createLearningPlan({ title: 'Same' }, { idGenerator: sequencedIds('plan-same-next'), clock: fixedClock(LP_TIME.created) });
  plan = addPhase(plan, { title: 'Same' }, { idGenerator: sequencedIds('phase-same-1'), clock: fixedClock() });
  plan = addLesson(plan, 'phase-same-1', { title: 'Same' }, { idGenerator: sequencedIds('lesson-same-1'), clock: fixedClock() });
  plan = addStep(plan, 'lesson-same-1', { title: 'Same' }, { idGenerator: sequencedIds('step-same-1'), clock: fixedClock() });
  plan = addPhase(plan, { title: 'Same' }, { idGenerator: sequencedIds('phase-same-2'), clock: fixedClock() });
  plan = addLesson(plan, 'phase-same-2', { title: 'Same' }, { idGenerator: sequencedIds('lesson-same-2'), clock: fixedClock() });
  plan = addStep(plan, 'lesson-same-2', { title: 'Same' }, { idGenerator: sequencedIds('step-same-2'), clock: fixedClock() });
  plan = completeStep(plan, 'step-same-1', { clock: fixedClock(LP_TIME.completed) });
  const next = findNextLearningPlanStep(plan);
  assert.deepEqual({
    phaseId: next.phaseId,
    lessonId: next.lessonId,
    stepId: next.stepId
  }, {
    phaseId: 'phase-same-2',
    lessonId: 'lesson-same-2',
    stepId: 'step-same-2'
  });
});
test('fully complete plan returns null', () => {
  let plan = seededLearningPlan();
  plan = completeStep(plan, 'step-a', { clock: fixedClock(LP_TIME.completed) });
  plan = completeStep(plan, 'step-b', { clock: fixedClock(LP_TIME.completed) });
  assert.equal(findNextLearningPlanStep(plan), null);
});
test('zero-step plan returns null', () => {
  const plan = createLearningPlan({ title: 'No steps' }, { idGenerator: sequencedIds('plan-no-steps'), clock: fixedClock(LP_TIME.created) });
  assert.equal(findNextLearningPlanStep(plan), null);
});
test('next action derivation does not mutate input', () => {
  const plan = nextActionMultiPlan();
  const before = JSON.stringify(plan);
  findNextLearningPlanStep(plan);
  assert.equal(JSON.stringify(plan), before);
});
test('same input produces deterministic next action', () => {
  const plan = nextActionMultiPlan();
  assert.deepEqual(findNextLearningPlanStep(plan), findNextLearningPlanStep(plan));
});
test('returned phaseId, lessonId, and stepId exactly match source IDs', () => {
  const next = findNextLearningPlanStep(nextActionMultiPlan());
  assert.equal(next.phaseId, 'phase-a');
  assert.equal(next.lessonId, 'lesson-a');
  assert.equal(next.stepId, 'step-a');
});
test('reopening an earlier step makes it the first unfinished step again', () => {
  let plan = nextActionMultiPlan();
  plan = completeStep(plan, 'step-a', { clock: fixedClock(LP_TIME.completed) });
  plan = completeStep(plan, 'step-b', { clock: fixedClock(LP_TIME.completed) });
  plan = reopenStep(plan, 'step-a', { clock: fixedClock(LP_TIME.reopened) });
  assert.equal(nextStepId(plan), 'step-a');
});
test('completion order is based on stored hierarchy, not completedAt recency', () => {
  let plan = nextActionMultiPlan();
  plan = completeStep(plan, 'step-a', { clock: fixedClock(LP_TIME.later) });
  assert.equal(nextStepId(plan), 'step-b');
});

// -- Learning Plan import parser ---------------------------------------------

function parsedOutline(text) {
  const result = parseLearningPlanOutline(text);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result;
}

function rejectedOutline(text, code) {
  const result = parseLearningPlanOutline(text);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === code), `Expected ${code} in ${JSON.stringify(result.errors)}`);
  return result;
}

console.log('\nLearning Plan import parser');
test('valid one-phase one-lesson one-step outline parses', () => {
  const result = parsedOutline('# Phase 1\n## Lesson 1\n- Read chapter');
  assert.deepEqual(result.phases, [
    { title: 'Phase 1', lessons: [{ title: 'Lesson 1', steps: [{ title: 'Read chapter' }] }] }
  ]);
});
test('multiple phases parse in order', () => {
  const result = parsedOutline('# Phase 1\n## Lesson 1\n- Step 1\n# Phase 2\n## Lesson 2\n- Step 2');
  assert.deepEqual(result.phases.map(phase => phase.title), ['Phase 1', 'Phase 2']);
});
test('multiple lessons parse under one phase', () => {
  const result = parsedOutline('# Phase\n## Lesson 1\n- Step 1\n## Lesson 2\n- Step 2');
  assert.deepEqual(result.phases[0].lessons.map(lesson => lesson.title), ['Lesson 1', 'Lesson 2']);
});
test('multiple steps parse under one lesson', () => {
  const result = parsedOutline('# Phase\n## Lesson\n- Step 1\n- Step 2');
  assert.deepEqual(result.phases[0].lessons[0].steps.map(step => step.title), ['Step 1', 'Step 2']);
});
test('blank lines are ignored', () => {
  const result = parsedOutline('\n# Phase\n\n## Lesson\n\n- Step\n');
  assert.deepEqual(result.counts, { phases: 1, lessons: 1, steps: 1 });
});
test('asterisk step syntax is supported', () => {
  const result = parsedOutline('# Phase\n## Lesson\n* Read docs');
  assert.equal(result.phases[0].lessons[0].steps[0].title, 'Read docs');
});
test('surrounding whitespace is trimmed from labels', () => {
  const result = parsedOutline('  #   Phase A  \n  ##   Lesson A  \n  -   Step A  ');
  assert.deepEqual(result.phases, [
    { title: 'Phase A', lessons: [{ title: 'Lesson A', steps: [{ title: 'Step A' }] }] }
  ]);
});
test('multiple spaces after import markers remain valid', () => {
  const result = parsedOutline('#    Phase\n##   Lesson\n-    Step');
  assert.deepEqual(result.phases, [
    { title: 'Phase', lessons: [{ title: 'Lesson', steps: [{ title: 'Step' }] }] }
  ]);
});
test('phase marker without whitespace is rejected', () => {
  rejectedOutline('#Phase\n## Lesson\n- Step', 'unsupported_line');
});
test('lesson marker without whitespace is rejected', () => {
  rejectedOutline('# Phase\n##Lesson\n- Step', 'unsupported_line');
});
test('dash step marker without whitespace is rejected', () => {
  rejectedOutline('# Phase\n## Lesson\n-Step', 'unsupported_line');
});
test('asterisk step marker without whitespace is rejected', () => {
  rejectedOutline('# Phase\n## Lesson\n*Step', 'unsupported_line');
});
test('lesson before phase is rejected', () => {
  const result = rejectedOutline('## Lesson\n- Step', 'lesson_before_phase');
  assert.equal(result.errors[0].line, 1);
});
test('step before lesson is rejected', () => {
  rejectedOutline('- Step', 'step_before_phase');
});
test('step directly under phase is rejected', () => {
  rejectedOutline('# Phase\n- Step', 'step_before_lesson');
});
test('unsupported non-empty line is rejected with line number', () => {
  const result = rejectedOutline('# Phase\n## Lesson\nDo work\n- Step', 'unsupported_line');
  assert.equal(result.errors.find(error => error.code === 'unsupported_line').line, 3);
});
test('empty phase title is rejected', () => {
  rejectedOutline('#   \n## Lesson\n- Step', 'empty_phase_title');
});
test('empty lesson title is rejected', () => {
  rejectedOutline('# Phase\n##   \n- Step', 'empty_lesson_title');
});
test('empty step title is rejected', () => {
  rejectedOutline('# Phase\n## Lesson\n-   ', 'empty_step_title');
});
test('phase with no lessons is rejected', () => {
  rejectedOutline('# Phase 1\n# Phase 2\n## Lesson\n- Step', 'empty_phase');
});
test('lesson with no steps is rejected', () => {
  rejectedOutline('# Phase\n## Lesson 1\n## Lesson 2\n- Step', 'empty_lesson');
});
test('zero phases are rejected', () => {
  rejectedOutline('   \n\n', 'no_phases');
});
test('counts are correct', () => {
  const result = parsedOutline('# P1\n## L1\n- S1\n- S2\n## L2\n- S3\n# P2\n## L3\n- S4');
  assert.deepEqual(result.counts, { phases: 2, lessons: 3, steps: 4 });
});
test('parser result has no generated durable IDs', () => {
  const result = parsedOutline('# Phase\n## Lesson\n- Step');
  assert.equal(JSON.stringify(result).includes('"id"'), false);
  assert.equal(JSON.stringify(result).includes('createdAt'), false);
});
test('same input produces deterministic parse output', () => {
  const input = '# Phase\n## Lesson\n- Step';
  assert.deepEqual(parseLearningPlanOutline(input), parseLearningPlanOutline(input));
});

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

console.log('\nLearning Plan repository');
test('empty repository lists no plans without writing storage', () => {
  const storage = makeMemoryStorage();
  assert.deepEqual(learningPlanRepository(storage).listPlans(), []);
  assert.equal(storage.raw(), undefined);
  assert.equal(storage.setCalls(), 0);
});
test('default key happy path uses ta3-learning-plans-v1', () => {
  const storage = makeMemoryStorage();
  createLearningPlanRepository({ storage }).savePlan(seededLearningPlan());
  assert.ok(storage.raw(LEARNING_PLAN_REPOSITORY_KEY));
});
test('valid custom key happy path stores under the custom key only', () => {
  const storage = makeMemoryStorage();
  const customKey = 'ta3-learning-plans-custom';
  createLearningPlanRepository({ storage, key: customKey }).savePlan(seededLearningPlan());
  assert.equal(storage.raw(LEARNING_PLAN_REPOSITORY_KEY), undefined);
  assert.deepEqual(repositoryEnvelope(storage, customKey).plans.map(plan => plan.id), ['plan-1']);
});
test('save one valid plan writes the versioned envelope', () => {
  const storage = makeMemoryStorage();
  const plan = seededLearningPlan();
  const saved = learningPlanRepository(storage).savePlan(plan);
  assert.deepEqual(saved, plan);
  assert.notEqual(saved, plan);
  assert.equal(storage.setCalls(), 1);
  assert.deepEqual(repositoryEnvelope(storage), {
    schemaVersion: 1,
    plans: [plan]
  });
});
test('reload from a new repository instance returns the same plan', () => {
  const storage = makeMemoryStorage();
  const plan = seededLearningPlan();
  learningPlanRepository(storage).savePlan(plan);
  assert.deepEqual(learningPlanRepository(storage).getPlan('plan-1'), plan);
});
test('every plan, phase, lesson, and step ID survives reload unchanged', () => {
  const storage = makeMemoryStorage();
  const plan = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.completed) });
  const beforeIds = learningPlanIds(plan);
  learningPlanRepository(storage).savePlan(plan);
  const loaded = learningPlanRepository(storage).getPlan('plan-1');
  assert.deepEqual(learningPlanIds(loaded), beforeIds);
});
test('completion state and completedAt survive reload', () => {
  const storage = makeMemoryStorage();
  const plan = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.completed) });
  learningPlanRepository(storage).savePlan(plan);
  const loaded = learningPlanRepository(storage).getPlan('plan-1');
  assert.equal(firstStep(loaded).completed, true);
  assert.equal(firstStep(loaded).completedAt, LP_TIME.completed);
});
test('hierarchy ordering survives reload', () => {
  const storage = makeMemoryStorage();
  let plan = reorderPhases(seededLearningPlan(), ['phase-b', 'phase-a'], { clock: fixedClock(LP_TIME.later) });
  plan = reorderSteps(plan, 'lesson-a', ['step-b', 'step-a'], { clock: fixedClock(LP_TIME.reopened) });
  learningPlanRepository(storage).savePlan(plan);
  const loaded = learningPlanRepository(storage).getPlan('plan-1');
  assert.deepEqual(loaded.phases.map(phase => phase.id), ['phase-b', 'phase-a']);
  assert.deepEqual(loaded.phases[1].lessons[0].steps.map(step => step.id), ['step-b', 'step-a']);
});
test('saving an existing ID replaces rather than duplicates and preserves order', () => {
  const storage = makeMemoryStorage();
  const repo = learningPlanRepository(storage);
  const first = seededLearningPlan();
  const second = secondSeededLearningPlan();
  repo.savePlan(first);
  repo.savePlan(second);
  repo.savePlan(renamePlan(first, 'Frontend mastery', { clock: fixedClock(LP_TIME.later) }));
  const plans = repo.listPlans();
  assert.deepEqual(plans.map(plan => plan.id), ['plan-1', 'plan-2']);
  assert.equal(plans[0].title, 'Frontend mastery');
});
test('repeated identical save remains one plan with stable IDs', () => {
  const storage = makeMemoryStorage();
  const repo = learningPlanRepository(storage);
  const plan = seededLearningPlan();
  repo.savePlan(plan);
  repo.savePlan(plan);
  repo.savePlan(plan);
  assert.equal(repo.listPlans().length, 1);
  assert.deepEqual(learningPlanIds(repo.getPlan('plan-1')), learningPlanIds(plan));
});
test('save does not mutate caller input', () => {
  const storage = makeMemoryStorage();
  const plan = seededLearningPlan();
  const before = JSON.stringify(plan);
  learningPlanRepository(storage).savePlan(plan);
  assert.equal(JSON.stringify(plan), before);
});
test('caller mutation after save does not alter persisted state', () => {
  const storage = makeMemoryStorage();
  const repo = learningPlanRepository(storage);
  const plan = seededLearningPlan();
  repo.savePlan(plan);
  plan.phases[0].lessons[0].steps[0].title = 'Mutated source';
  assert.equal(firstStep(repo.getPlan('plan-1')).title, 'Step A');
});
test('mutation of getPlan result does not alter later reads', () => {
  const storage = makeMemoryStorage();
  const repo = learningPlanRepository(storage);
  repo.savePlan(seededLearningPlan());
  const loaded = repo.getPlan('plan-1');
  loaded.phases[0].lessons[0].steps[0].title = 'Mutated get';
  assert.equal(firstStep(repo.getPlan('plan-1')).title, 'Step A');
});
test('mutation of listPlans output does not alter later reads', () => {
  const storage = makeMemoryStorage();
  const repo = learningPlanRepository(storage);
  repo.savePlan(seededLearningPlan());
  const listed = repo.listPlans();
  listed[0].title = 'Mutated list';
  listed.push(secondSeededLearningPlan());
  assert.deepEqual(repo.listPlans().map(plan => plan.title), ['Frontend fundamentals']);
});
test('two repository instances see shared persisted state', () => {
  const storage = makeMemoryStorage();
  const firstRepo = learningPlanRepository(storage);
  const secondRepo = learningPlanRepository(storage);
  firstRepo.savePlan(seededLearningPlan());
  assert.equal(secondRepo.getPlan('plan-1').title, 'Frontend fundamentals');
  secondRepo.savePlan(secondSeededLearningPlan());
  assert.deepEqual(firstRepo.listPlans().map(plan => plan.id), ['plan-1', 'plan-2']);
});
test('remove deletes only the exact matching plan ID', () => {
  const storage = makeMemoryStorage();
  const repo = learningPlanRepository(storage);
  repo.savePlan(seededLearningPlan());
  repo.savePlan(secondSeededLearningPlan());
  const beforeRemoveSetCalls = storage.setCalls();
  assert.deepEqual(repo.removePlan('plan-1'), { removed: true, planId: 'plan-1' });
  assert.equal(storage.setCalls(), beforeRemoveSetCalls + 1);
  assert.equal(repo.getPlan('plan-1'), null);
  assert.equal(repo.getPlan('plan-2').title, 'Backend fundamentals');
});
test('remove preserves relative order of remaining plans', () => {
  const storage = makeMemoryStorage();
  const repo = learningPlanRepository(storage);
  repo.savePlan(seededLearningPlan());
  repo.savePlan(secondSeededLearningPlan());
  repo.savePlan(createLearningPlan({ title: 'Third' }, {
    idGenerator: sequencedIds('plan-3'),
    clock: fixedClock(LP_TIME.created)
  }));
  repo.removePlan('plan-2');
  assert.deepEqual(repo.listPlans().map(plan => plan.id), ['plan-1', 'plan-3']);
});
test('remove of a nonexistent ID is a deterministic no-op', () => {
  const storage = makeMemoryStorage();
  const repo = learningPlanRepository(storage);
  repo.savePlan(seededLearningPlan());
  const before = storage.raw();
  const beforeSetCalls = storage.setCalls();
  assert.deepEqual(repo.removePlan('missing-plan'), { removed: false, planId: 'missing-plan' });
  assert.equal(storage.raw(), before);
  assert.equal(storage.setCalls(), beforeSetCalls);
});
test('empty and whitespace IDs are rejected for get and remove', () => {
  const repo = learningPlanRepository(makeMemoryStorage());
  assert.throws(() => repo.getPlan('  '), error => error.code === 'invalid_plan_id');
  assert.throws(() => repo.removePlan(''), error => error.code === 'invalid_plan_id');
});
test('empty, whitespace, and non-string repository keys are rejected when supplied', () => {
  const storage = makeMemoryStorage();
  assert.throws(() => createLearningPlanRepository({ storage, key: '' }), error => error.code === 'invalid_plan_id');
  assert.throws(() => createLearningPlanRepository({ storage, key: '   ' }), error => error.code === 'invalid_plan_id');
  assert.throws(() => createLearningPlanRepository({ storage, key: 12 }), error => error.code === 'invalid_plan_id');
});
test('explicit null and undefined keys are rejected instead of defaulted', () => {
  const storage = makeMemoryStorage();
  assert.throws(() => createLearningPlanRepository({ storage, key: null }), error => error.code === 'invalid_plan_id');
  assert.throws(() => createLearningPlanRepository({ storage, key: undefined }), error => error.code === 'invalid_plan_id');
});
test('explicit invalid storage values are rejected instead of defaulted', () => {
  assert.throws(() => createLearningPlanRepository({ storage: null }), error => error.code === 'storage_unavailable');
  assert.throws(() => createLearningPlanRepository({ storage: undefined }), error => error.code === 'storage_unavailable');
  assert.throws(() => createLearningPlanRepository({ storage: 'local' }), error => error.code === 'storage_unavailable');
  assert.throws(() => createLearningPlanRepository({ storage: { getItem() {} } }), error => error.code === 'storage_unavailable');
});
test('explicit null storage is rejected even when global localStorage exists', () => {
  withGlobalLocalStorage(makeMemoryStorage(), () => {
    assert.throws(() => createLearningPlanRepository({ storage: null }), error => error.code === 'storage_unavailable');
  });
});
test('omitted storage may use global localStorage', () => {
  const storage = makeMemoryStorage();
  withGlobalLocalStorage(storage, () => {
    createLearningPlanRepository().savePlan(seededLearningPlan());
    assert.deepEqual(repositoryEnvelope(storage).plans.map(plan => plan.id), ['plan-1']);
  });
});
test('malformed plan is rejected before write', () => {
  const storage = makeMemoryStorage();
  assert.throws(() => learningPlanRepository(storage).savePlan({ id: 'bad' }), error => error.code === 'invalid_plan');
  assert.equal(storage.raw(), undefined);
  assert.equal(storage.setCalls(), 0);
});
test('duplicate nested IDs are rejected before write', () => {
  const storage = makeMemoryStorage();
  const plan = seededLearningPlan();
  plan.phases[0].lessons[0].steps[1].id = 'step-a';
  assert.throws(() => learningPlanRepository(storage).savePlan(plan), error => error.code === 'invalid_plan');
  assert.equal(storage.raw(), undefined);
});
test('malformed completedAt state is rejected before write', () => {
  const storage = makeMemoryStorage();
  const plan = seededLearningPlan();
  plan.phases[0].lessons[0].steps[0].completedAt = LP_TIME.completed;
  assert.throws(() => learningPlanRepository(storage).savePlan(plan), error => error.code === 'invalid_plan');
  assert.equal(storage.raw(), undefined);
});
test('malformed JSON in storage is rejected and left untouched', () => {
  const storage = makeMemoryStorage({ [LEARNING_PLAN_REPOSITORY_KEY]: '{bad json' });
  assert.throws(() => learningPlanRepository(storage).listPlans(), error => error.code === 'invalid_json');
  assert.equal(storage.raw(), '{bad json');
});
test('undefined storage value is rejected and cannot be overwritten by save', () => {
  const storage = makeMemoryStorage({ [LEARNING_PLAN_REPOSITORY_KEY]: undefined });
  assert.throws(() => learningPlanRepository(storage).listPlans(), error => error.code === 'invalid_storage_value');
  assert.throws(() => learningPlanRepository(storage).savePlan(seededLearningPlan()), error => error.code === 'invalid_storage_value');
  assert.equal(storage.raw(), undefined);
  assert.equal(storage.setCalls(), 0);
});
test('non-string storage values are rejected before parsing', () => {
  [7, false, {}, []].forEach(value => {
    const storage = makeMemoryStorage({ [LEARNING_PLAN_REPOSITORY_KEY]: value });
    assert.throws(() => learningPlanRepository(storage).listPlans(), error => error.code === 'invalid_storage_value');
    assert.equal(storage.raw(), value);
  });
});
test('malformed envelope is rejected and left untouched', () => {
  const raw = JSON.stringify({ schemaVersion: 1, plans: {} });
  const storage = makeMemoryStorage({ [LEARNING_PLAN_REPOSITORY_KEY]: raw });
  assert.throws(() => learningPlanRepository(storage).listPlans(), error => error.code === 'invalid_envelope');
  assert.equal(storage.raw(), raw);
});
test('extra envelope fields are rejected', () => {
  const raw = JSON.stringify({ schemaVersion: 1, plans: [], progress: [] });
  const storage = makeMemoryStorage({ [LEARNING_PLAN_REPOSITORY_KEY]: raw });
  assert.throws(() => learningPlanRepository(storage).listPlans(), error => error.code === 'invalid_envelope');
  assert.equal(storage.raw(), raw);
});
test('unsupported schemaVersion is rejected and left untouched', () => {
  const raw = JSON.stringify({ schemaVersion: 2, plans: [] });
  const storage = makeMemoryStorage({ [LEARNING_PLAN_REPOSITORY_KEY]: raw });
  assert.throws(() => learningPlanRepository(storage).listPlans(), error => error.code === 'unsupported_schema_version');
  assert.equal(storage.raw(), raw);
});
test('malformed persisted plan is rejected and left untouched', () => {
  const raw = JSON.stringify({ schemaVersion: 1, plans: [seededLearningPlan(), { id: 'bad' }] });
  const storage = makeMemoryStorage({ [LEARNING_PLAN_REPOSITORY_KEY]: raw });
  assert.throws(() => learningPlanRepository(storage).listPlans(), error => error.code === 'invalid_plan');
  assert.equal(storage.raw(), raw);
});
test('duplicate plan IDs in persisted envelope are rejected', () => {
  const raw = JSON.stringify({ schemaVersion: 1, plans: [seededLearningPlan(), seededLearningPlan()] });
  const storage = makeMemoryStorage({ [LEARNING_PLAN_REPOSITORY_KEY]: raw });
  assert.throws(() => learningPlanRepository(storage).listPlans(), error => error.code === 'duplicate_plan_id');
  assert.equal(storage.raw(), raw);
});
test('read errors are surfaced without writing or clearing storage', () => {
  let setCalls = 0;
  const storage = {
    getItem() {
      throw new Error('read failed');
    },
    setItem() {
      setCalls++;
    }
  };
  assert.throws(() => createLearningPlanRepository({ storage }).listPlans(), error => error.code === 'storage_read_failed');
  assert.equal(setCalls, 0);
});
test('write failures are surfaced and failed save does not report success', () => {
  const plan = seededLearningPlan();
  const storage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error('write failed');
    }
  };
  assert.throws(() => createLearningPlanRepository({ storage }).savePlan(plan), error => error.code === 'storage_write_failed');
});
test('failed save leaves prior persisted state unchanged', () => {
  const storage = makeMemoryStorage();
  const repo = learningPlanRepository(storage);
  repo.savePlan(seededLearningPlan());
  const before = storage.raw();
  const failingStorage = {
    getItem: storage.getItem,
    setItem() {
      throw new Error('write failed');
    }
  };
  assert.throws(() => createLearningPlanRepository({ storage: failingStorage }).savePlan(secondSeededLearningPlan()), error => error.code === 'storage_write_failed');
  assert.equal(storage.raw(), before);
});
test('save after corrupt persisted state does not replace corruption', () => {
  const storage = makeMemoryStorage({ [LEARNING_PLAN_REPOSITORY_KEY]: '{bad json' });
  assert.throws(() => learningPlanRepository(storage).savePlan(seededLearningPlan()), error => error.code === 'invalid_json');
  assert.equal(storage.raw(), '{bad json');
});
test('removePlan against corrupt storage throws without touching bytes', () => {
  const storage = makeMemoryStorage({ [LEARNING_PLAN_REPOSITORY_KEY]: '{bad json' });
  assert.throws(() => learningPlanRepository(storage).removePlan('plan-1'), error => error.code === 'invalid_json');
  assert.equal(storage.raw(), '{bad json');
  assert.equal(storage.setCalls(), 0);
});
test('nested mutation of listPlans output does not alter future reads', () => {
  const storage = makeMemoryStorage();
  const repo = learningPlanRepository(storage);
  repo.savePlan(seededLearningPlan());
  const listed = repo.listPlans();
  listed[0].phases[0].lessons[0].steps[0].title = 'Mutated nested list';
  assert.equal(firstStep(repo.listPlans()[0]).title, 'Step A');
});
test('repository persistence is plain JSON-safe state without derived progress', () => {
  const storage = makeMemoryStorage();
  let plan = completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.completed) });
  plan = reorderLessons(plan, 'phase-a', ['lesson-b', 'lesson-a'], { clock: fixedClock(LP_TIME.reopened) });
  learningPlanRepository(storage).savePlan(plan);
  const envelope = repositoryEnvelope(storage);
  assert.equal(Object.prototype.hasOwnProperty.call(envelope.plans[0], 'progress'), false);
  assert.deepEqual(hydrateLearningPlan(JSON.parse(JSON.stringify(envelope.plans[0]))), plan);
});
test('no IDs are regenerated during hydrate or load', () => {
  const storage = makeMemoryStorage();
  const plan = seededLearningPlan();
  learningPlanRepository(storage).savePlan(plan);
  const rawBefore = storage.raw();
  assert.deepEqual(learningPlanRepository(storage).listPlans()[0], plan);
  assert.equal(storage.raw(), rawBefore);
});
test('repository errors carry stable codes', () => {
  assert.throws(() => createLearningPlanRepository({ storage: null }), error => {
    assert.ok(error instanceof LearningPlanRepositoryError);
    assert.equal(error.code, 'storage_unavailable');
    return true;
  });
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
    temporalPrecision: 'date',
    occurredDate: '2026-08-27',
    sourceTimezone: 'America/Phoenix',
    payload: {
      mealName: 'Chicken bowls',
      preparedDate: '2026-08-27',
      portionsPrepared: 4
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
  const impossibleDate = { ...valid, occurredDate: '2026-02-30', payload: { ...valid.payload, preparedDate: '2026-02-30' } };
  assert.equal(validateLifeLedgerEventDraft(impossibleDate).ok, false);
  const fakeMidnight = { ...valid, occurredAt: '2026-08-27T00:00:00.000Z' };
  assert.equal(validateLifeLedgerEventDraft(fakeMidnight).ok, false);
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

// -- Life Ledger runtime store and Learning Plan bridge -----------------------

function runtimeStore(storage = makeMemoryStorage()) {
  return createLocalLifeLedgerStore({ storage, key: LIFE_LEDGER_RUNTIME_KEY });
}

function runtimeEnvelope(storage) {
  return JSON.parse(storage.raw(LIFE_LEDGER_RUNTIME_KEY));
}

function completedLearningPlan() {
  return completeStep(seededLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.completed) });
}

function focusOutcome(overrides = {}) {
  const start = Date.parse('2026-08-27T16:00:00.000Z');
  const end = Date.parse('2026-08-27T16:25:00.000Z');
  return {
    outcomeId: '1700001500000:plan-1:phase-a:lesson-a:step-a',
    planId: 'plan-1',
    phaseId: 'phase-a',
    lessonId: 'lesson-a',
    stepId: 'step-a',
    planTitle: 'Frontend fundamentals',
    phaseTitle: 'Phase A',
    lessonTitle: 'Lesson A',
    stepTitle: 'Step A',
    focusEntryId: '1700001500000',
    focusActivity: 'Step A',
    focusStartedAt: start,
    focusEndedAt: end,
    focusDurationMin: 25,
    ...overrides
  };
}

function runtimeOpts(overrides = {}) {
  return {
    sourceTimezone: 'America/Phoenix',
    createId: () => 'abababab-abab-4aba-8bab-abababababab',
    clock: fixedClock(LL_TIME.recorded),
    ...overrides
  };
}

console.log('\nLife Ledger runtime Learning Plan bridge');
test('runtime store treats missing localStorage key as an empty ledger', () => {
  assert.deepEqual(runtimeStore().listEvents(), []);
});
test('runtime store writes a versioned localStorage envelope after first upsert', () => {
  const storage = makeMemoryStorage();
  const store = runtimeStore(storage);
  const result = recordLearningPlanStepCompleted(completedLearningPlan(), 'step-a', {
    ...runtimeOpts(),
    store
  });
  const envelope = runtimeEnvelope(storage);
  assert.equal(result.action, 'created');
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.records.length, 1);
  assert.equal(envelope.records[0].event.type, 'plan_step_completed');
});
test('runtime store rejects malformed JSON without clearing stored bytes', () => {
  const storage = makeMemoryStorage({ [LIFE_LEDGER_RUNTIME_KEY]: '{bad json' });
  assert.throws(() => runtimeStore(storage).listEvents(), error => error instanceof LifeLedgerRuntimeStoreError && error.code === 'invalid_json');
  assert.equal(storage.raw(LIFE_LEDGER_RUNTIME_KEY), '{bad json');
});
test('runtime store rejects unsupported schema without rewriting storage', () => {
  const raw = JSON.stringify({ schemaVersion: 999, records: [] });
  const storage = makeMemoryStorage({ [LIFE_LEDGER_RUNTIME_KEY]: raw });
  assert.throws(() => runtimeStore(storage).listEvents(), error => error.code === 'unsupported_schema_version');
  assert.equal(storage.raw(LIFE_LEDGER_RUNTIME_KEY), raw);
});
test('runtime store rejects persisted records with mismatched fingerprints', () => {
  const draft = buildLearningPlanStepCompletedDraft(completedLearningPlan(), 'step-a', runtimeOpts());
  const memory = createLifeLedgerMemoryStore();
  const created = upsertLifeLedgerEvent(memory, draft, runtimeOpts());
  const bad = {
    schemaVersion: 1,
    records: [{ key: created.key, event: created.event, fingerprint: 'fnv1a32:00000000' }]
  };
  const storage = makeMemoryStorage({ [LIFE_LEDGER_RUNTIME_KEY]: JSON.stringify(bad) });
  assert.throws(() => runtimeStore(storage).listEvents(), error => error.code === 'invalid_record');
});
test('runtime store write failure preserves the previously persisted envelope', () => {
  const storage = makeMemoryStorage();
  const store = runtimeStore(storage);
  recordLearningPlanStepCompleted(completedLearningPlan(), 'step-a', { ...runtimeOpts(), store });
  const before = storage.raw(LIFE_LEDGER_RUNTIME_KEY);
  const failingStore = createLocalLifeLedgerStore({
    key: LIFE_LEDGER_RUNTIME_KEY,
    storage: {
      getItem: storage.getItem,
      setItem() {
        throw new Error('blocked write');
      }
    }
  });
  const nextPlan = completeStep(reopenStep(completedLearningPlan(), 'step-a', { clock: fixedClock(LP_TIME.reopened) }), 'step-a', { clock: fixedClock(LP_TIME.later) });
  assert.throws(() => recordLearningPlanStepCompleted(nextPlan, 'step-a', { ...runtimeOpts({ clock: fixedClock(LL_TIME.revised) }), store: failingStore }), error => error.code === 'storage_write_failed');
  assert.equal(storage.raw(LIFE_LEDGER_RUNTIME_KEY), before);
});
test('focus session draft is valid, non-additive, and keyed by the focus entry id', () => {
  const draft = buildLearningPlanFocusSessionCompletedDraft(focusOutcome(), runtimeOpts());
  assert.equal(validateLifeLedgerEventDraft(draft).ok, true);
  assert.equal(draft.type, 'focus_session_completed');
  assert.equal(draft.sourceEntityId, focusOutcome().focusEntryId);
  assert.equal(draft.payload.additiveForTimeTotals, false);
  assert.equal(draft.payload.durationMinutes, 25);
  assert.ok(draft.provenance.evidence.includes(`chronasense.focus_outcome:${focusOutcome().outcomeId}`));
  assert.ok(draft.provenance.evidence.includes('chronasense.entry:1700001500000'));
});
test('focus session recording creates one Life Ledger focus event', () => {
  const store = runtimeStore();
  const result = recordLearningPlanFocusSessionCompleted(focusOutcome(), { ...runtimeOpts(), store });
  assert.equal(result.action, 'created');
  assert.equal(store.listEvents()[0].type, 'focus_session_completed');
});
test('focus session retry is idempotent and does not mint another UUID', () => {
  let ids = 0;
  const store = runtimeStore();
  const opts = runtimeOpts({
    store,
    createId: () => {
      ids++;
      return 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc';
    }
  });
  const first = recordLearningPlanFocusSessionCompleted(focusOutcome(), opts);
  const retry = recordLearningPlanFocusSessionCompleted(focusOutcome(), opts);
  assert.equal(first.action, 'created');
  assert.equal(retry.action, 'unchanged');
  assert.equal(store.listEvents().length, 1);
  assert.equal(ids, 1);
});
test('same focus entry retry preserves the same event id even when outcome id changes', () => {
  let ids = 0;
  const store = runtimeStore();
  const opts = runtimeOpts({
    store,
    createId: () => {
      ids++;
      return 'abababab-abab-4bab-8bab-abababababab';
    }
  });
  const first = recordLearningPlanFocusSessionCompleted(focusOutcome({ outcomeId: 'outcome-first' }), opts);
  const retry = recordLearningPlanFocusSessionCompleted(focusOutcome({ outcomeId: 'outcome-retry' }), opts);
  assert.equal(retry.event.eventId, first.event.eventId);
  assert.equal(store.listEvents().length, 1);
  assert.equal(ids, 1);
});
test('focus and activity facts for the same entry remain separate and non-duplicating', () => {
  const focusDraft = buildLearningPlanFocusSessionCompletedDraft(focusOutcome(), runtimeOpts());
  const activityDraft = sampleActivityDraft({ sourceEntityId: focusOutcome().focusEntryId });
  assert.notEqual(deriveLifeLedgerKey(focusDraft), deriveLifeLedgerKey(activityDraft));
  assert.equal(focusDraft.sourceEntityId, activityDraft.sourceEntityId);
  assert.equal(focusDraft.payload.additiveForTimeTotals, false);
});
test('plan step source identity is a canonical plan and step composite', () => {
  assert.equal(learningPlanStepSourceEntityId('plan-1', 'step-a'), '["plan-1","step-a"]');
  assert.equal(learningPlanStepSourceEntityId('plan,1', 'step"]a'), JSON.stringify(['plan,1', 'step"]a']));
  assert.notEqual(learningPlanStepSourceEntityId('plan-a', 'shared-step'), learningPlanStepSourceEntityId('plan-b', 'shared-step'));
});
test('plan step completion draft preserves the stable composite step identity and step label', () => {
  const draft = buildLearningPlanStepCompletedDraft(completedLearningPlan(), 'step-a', runtimeOpts());
  assert.equal(validateLifeLedgerEventDraft(draft).ok, true);
  assert.equal(draft.type, 'plan_step_completed');
  assert.equal(draft.sourceEntityId, learningPlanStepSourceEntityId('plan-1', 'step-a'));
  assert.equal(draft.payload.stepLabel, 'Step A');
  assert.equal(draft.payload.planDate, '2026-08-27');
  assert.equal(draft.provenance.sourceRecordKind, 'chronasense.plan_step');
});
test('matching nested step ids in different Learning Plans create distinct Life Ledger events', () => {
  let ids = 0;
  const store = runtimeStore();
  const opts = runtimeOpts({
    store,
    createId: () => {
      ids++;
      return ids === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
    }
  });
  const first = recordLearningPlanStepCompleted(completedPlanWithSharedStepId('plan-a', 'Plan A'), 'shared-step', opts);
  const second = recordLearningPlanStepCompleted(completedPlanWithSharedStepId('plan-b', 'Plan B'), 'shared-step', opts);
  assert.equal(store.listEvents().length, 2);
  assert.notEqual(first.event.sourceEntityId, second.event.sourceEntityId);
  assert.notEqual(first.event.eventId, second.event.eventId);
});
test('plan step completion recording creates a durable Life Ledger event', () => {
  const store = runtimeStore();
  const result = recordLearningPlanStepCompleted(completedLearningPlan(), 'step-a', { ...runtimeOpts(), store });
  assert.equal(result.action, 'created');
  assert.equal(store.listEvents()[0].payload.completedAt, LP_TIME.completed);
});
test('plan step completion retry keeps one event and one eventId', () => {
  let ids = 0;
  const store = runtimeStore();
  const opts = runtimeOpts({
    store,
    createId: () => {
      ids++;
      return 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    }
  });
  const first = recordLearningPlanStepCompleted(completedLearningPlan(), 'step-a', opts);
  const retry = recordLearningPlanStepCompleted(completedLearningPlan(), 'step-a', opts);
  assert.equal(retry.action, 'unchanged');
  assert.equal(retry.event.eventId, first.event.eventId);
  assert.equal(ids, 1);
});
test('plan step completion from a focus outcome includes tracked minutes as source context', () => {
  const draft = buildLearningPlanStepCompletedDraft(completedLearningPlan(), 'step-a', {
    ...runtimeOpts(),
    focusOutcome: focusOutcome(),
    trackedMinutes: 25,
    captureMethod: 'pomodoro'
  });
  assert.equal(draft.payload.trackedMinutes, 25);
  assert.equal(draft.payload.source.focusEntryId, '1700001500000');
  assert.equal(draft.provenance.captureMethod, 'pomodoro');
});
test('plan step reopen draft is a user_delete tombstone for the same logical completion event', () => {
  const draft = buildLearningPlanStepReopenedDraft(completedLearningPlan(), 'step-a', runtimeOpts());
  assert.equal(validateLifeLedgerEventDraft(draft).ok, true);
  assert.equal(draft.sourceEntityId, learningPlanStepSourceEntityId('plan-1', 'step-a'));
  assert.equal(draft.tombstone.active, true);
  assert.equal(draft.tombstone.reason, 'user_delete');
  assert.equal(draft.provenance.sourceOperation, 'delete');
});
test('plan step reopen tombstones an existing completion and preserves eventId', () => {
  const store = runtimeStore();
  const opts = runtimeOpts({
    store,
    createId: () => 'dededede-dede-4ede-8ede-dededededede',
    clock: sequencedClock(LL_TIME.recorded, LL_TIME.revised, '2026-08-27T17:30:00.000Z', '2026-08-27T17:45:00.000Z')
  });
  const created = recordLearningPlanStepCompleted(completedLearningPlan(), 'step-a', opts);
  const deleted = recordLearningPlanStepReopened(completedLearningPlan(), 'step-a', opts);
  assert.equal(deleted.action, 'tombstoned');
  assert.equal(deleted.event.eventId, created.event.eventId);
  assert.equal(deleted.event.tombstone.active, true);
});
test('repeated identical reopen retry does not increment revision again', () => {
  const store = runtimeStore();
  const opts = runtimeOpts({
    store,
    createId: () => 'efefefef-efef-4fef-8fef-efefefefefef',
    clock: fixedClock(LL_TIME.recorded)
  });
  recordLearningPlanStepCompleted(completedLearningPlan(), 'step-a', opts);
  const deleted = recordLearningPlanStepReopened(completedLearningPlan(), 'step-a', opts);
  const retry = recordLearningPlanStepReopened(completedLearningPlan(), 'step-a', opts);
  assert.equal(retry.action, 'unchanged');
  assert.equal(retry.event.revision, deleted.event.revision);
});
test('completion after reopen restores the existing tombstoned event', () => {
  const store = runtimeStore();
  const opts = runtimeOpts({
    store,
    createId: () => 'fafafafa-fafa-4afa-8afa-fafafafafafa',
    clock: sequencedClock(LL_TIME.recorded, LL_TIME.revised, '2026-08-27T17:05:00.000Z', '2026-08-27T17:10:00.000Z', '2026-08-27T17:30:00.000Z', '2026-08-27T17:35:00.000Z')
  });
  const completed = completedLearningPlan();
  const created = recordLearningPlanStepCompleted(completed, 'step-a', opts);
  recordLearningPlanStepReopened(completed, 'step-a', opts);
  const recompleted = completeStep(reopenStep(completed, 'step-a', { clock: fixedClock(LP_TIME.reopened) }), 'step-a', { clock: fixedClock(LP_TIME.later) });
  const restored = recordLearningPlanStepCompleted(recompleted, 'step-a', opts);
  assert.equal(restored.action, 'restored');
  assert.equal(restored.event.eventId, created.event.eventId);
  assert.equal(restored.event.sourceEntityId, created.event.sourceEntityId);
  assert.equal(restored.event.tombstone.active, false);
});
test('completion for an incomplete step is rejected before any runtime write', () => {
  const storage = makeMemoryStorage();
  assert.throws(() => recordLearningPlanStepCompleted(seededLearningPlan(), 'step-a', {
    ...runtimeOpts(),
    store: runtimeStore(storage)
  }), error => error.code === 'step_not_completed');
  assert.equal(storage.raw(LIFE_LEDGER_RUNTIME_KEY), undefined);
});
test('runtime source timezone maps legacy UTC setting to a contract-valid IANA name', () => {
  const storage = makeMemoryStorage();
  storage.setItem('ta3-tz', 'UTC');
  withGlobalLocalStorage(storage, () => {
    const draft = buildLearningPlanStepCompletedDraft(completedLearningPlan(), 'step-a', runtimeOpts({ sourceTimezone: null }));
    assert.equal(draft.sourceTimezone, 'Etc/UTC');
    assert.equal(validateLifeLedgerEventDraft(draft).ok, true);
  });
});
test('runtime list results are cloned and cannot mutate persisted state', () => {
  const store = runtimeStore();
  recordLearningPlanStepCompleted(completedLearningPlan(), 'step-a', { ...runtimeOpts(), store });
  const listed = store.listEvents();
  listed[0].payload.stepLabel = 'Mutated';
  assert.equal(store.listEvents()[0].payload.stepLabel, 'Step A');
});

// -- Obsidian Life Ledger export ---------------------------------------------

const OBS_TIME = {
  start: '2026-08-30T16:00:00.000Z',
  end: '2026-08-30T16:25:00.000Z',
  step: '2026-08-30T16:30:00.000Z',
  recorded: '2026-08-30T16:31:00.000Z'
};

function obsidianFocusEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: '10101010-1010-4010-8010-101010101010',
    sourceApp: 'chronasense',
    sourceEntityId: 'focus-entry-1',
    type: 'focus_session_completed',
    occurredAt: OBS_TIME.end,
    recordedAt: OBS_TIME.recorded,
    revisedAt: null,
    sourceTimezone: 'America/Phoenix',
    payload: {
      activity: 'Synthetic focus',
      startedAt: OBS_TIME.start,
      endedAt: OBS_TIME.end,
      durationMinutes: 25,
      additiveForTimeTotals: false,
      source: { focusEntryId: 'focus-entry-1' }
    },
    provenance: {
      source: 'chronasense',
      sourceRecordKind: 'chronasense.focus_outcome',
      adapterVersion: 'test-v1',
      observedAt: OBS_TIME.recorded,
      captureMethod: 'pomodoro',
      evidence: ['synthetic.focus:1']
    },
    confidence: { score: 1, basis: 'source-recorded' },
    revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null },
    ...overrides
  };
}

function obsidianStepEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: '20202020-2020-4020-8020-202020202020',
    sourceApp: 'chronasense',
    sourceEntityId: '["synthetic-plan","synthetic-step"]',
    type: 'plan_step_completed',
    occurredAt: OBS_TIME.step,
    recordedAt: OBS_TIME.recorded,
    revisedAt: null,
    sourceTimezone: 'America/Phoenix',
    payload: {
      planDate: '2026-08-30',
      stepLabel: 'Synthetic step',
      completedAt: OBS_TIME.step,
      source: {
        planTitle: 'Synthetic course',
        phaseTitle: 'Phase 1',
        lessonTitle: 'Lesson 2'
      }
    },
    provenance: {
      source: 'chronasense',
      sourceRecordKind: 'chronasense.plan_step',
      adapterVersion: 'test-v1',
      observedAt: OBS_TIME.recorded,
      captureMethod: 'plan_toggle',
      evidence: ['synthetic.step:1']
    },
    confidence: { score: 1, basis: 'source-recorded' },
    revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null },
    ...overrides
  };
}

function obsidianActivityEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: '40404040-4040-4040-8040-404040404040',
    sourceApp: 'chronasense',
    sourceEntityId: 'synthetic-activity-1',
    type: 'activity_logged',
    occurredAt: OBS_TIME.end,
    recordedAt: OBS_TIME.recorded,
    revisedAt: null,
    sourceTimezone: 'America/Phoenix',
    payload: {
      activity: 'Synthetic deep work',
      category: 'work',
      startedAt: OBS_TIME.start,
      endedAt: OBS_TIME.end,
      durationMinutes: 25
    },
    provenance: {
      source: 'chronasense',
      sourceRecordKind: 'chronasense.entries',
      adapterVersion: 'test-v1',
      observedAt: OBS_TIME.recorded,
      captureMethod: 'manual',
      evidence: ['synthetic.entries:1']
    },
    confidence: { score: 1, basis: 'source-recorded' },
    revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null },
    ...overrides
  };
}

function obsidianWorkoutEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: '30303030-3030-4030-8030-303030303030',
    sourceApp: 'workout',
    sourceEntityId: 'synthetic-workout',
    type: 'workout_completed',
    occurredAt: '2026-08-30T18:00:00.000Z',
    recordedAt: OBS_TIME.recorded,
    revisedAt: null,
    sourceTimezone: 'America/Phoenix',
    payload: {
      workoutName: 'Synthetic workout',
      startedAt: '2026-08-30T17:00:00.000Z',
      endedAt: '2026-08-30T18:00:00.000Z',
      durationMinutes: 60,
      exercises: [
        { exerciseId: 'squat', mode: 'reps', sets: [{ load: 100, repetitions: 5 }] },
        { exerciseId: 'plank', mode: 'time', sets: [{ seconds: 60 }] }
      ],
      source: {
        localDate: '2026-08-30',
        weightUnitContext: { authority: 'unknown' },
        timezoneContext: { authority: 'import_assertion', timeZone: 'America/Phoenix' }
      }
    },
    provenance: {
      source: 'workout',
      sourceRecordKind: 'opengym.workout',
      adapterVersion: 'test-v1',
      observedAt: OBS_TIME.recorded,
      captureMethod: 'opengym_backup',
      evidence: ['opengym.backup:workouts/synthetic-workout']
    },
    confidence: { score: 0.9, basis: 'validated-supplied-backup-record' },
    revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null },
    ...overrides
  };
}

function obsidianMealPreparedEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: '50505050-5050-4050-8050-505050505050',
    sourceApp: 'meal',
    sourceEntityId: 'synthetic-cooked-meal',
    type: 'meal_prepared',
    temporalPrecision: 'date',
    occurredDate: '2026-08-30',
    recordedAt: OBS_TIME.recorded,
    revisedAt: null,
    sourceTimezone: 'America/Phoenix',
    payload: {
      mealName: 'Synthetic Chicken Bowls',
      preparedDate: '2026-08-30',
      portionsPrepared: 3,
      source: {
        cookedMealId: 'synthetic-cooked-meal',
        localDate: '2026-08-30',
        preparedDateBasis: 'source-local-date',
        recipeId: 'synthetic-recipe',
        preparationKind: 'recipe'
      }
    },
    provenance: {
      source: 'meal',
      sourceRecordKind: 'meal.cooked_meal',
      adapterVersion: 'test-v1',
      observedAt: OBS_TIME.recorded,
      captureMethod: 'meal_app',
      evidence: ['synthetic.meal:cookedMeals/synthetic-cooked-meal']
    },
    confidence: { score: 0.85, basis: 'source-local-date-only-no-time-of-day-evidence' },
    revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null },
    ...overrides
  };
}

function obsidianMealConsumedEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: '60606060-6060-4060-8060-606060606060',
    sourceApp: 'meal',
    sourceEntityId: 'synthetic-consumption',
    type: 'meal_consumed',
    occurredAt: '2026-08-30T19:00:00.000Z',
    recordedAt: OBS_TIME.recorded,
    revisedAt: null,
    sourceTimezone: 'America/Phoenix',
    payload: {
      mealName: 'Synthetic Chicken Bowls',
      consumedAt: '2026-08-30T19:00:00.000Z',
      portionCount: 1,
      cookedMealId: 'synthetic-cooked-meal',
      source: { consumptionId: 'synthetic-consumption', recipeId: 'synthetic-recipe' }
    },
    provenance: {
      source: 'meal',
      sourceRecordKind: 'meal.consumption',
      adapterVersion: 'test-v1',
      observedAt: OBS_TIME.recorded,
      captureMethod: 'meal_app',
      evidence: ['synthetic.meal:mealConsumptions/synthetic-consumption']
    },
    confidence: { score: 1, basis: 'source-recorded' },
    revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null },
    ...overrides
  };
}

function dailyFile(exportPlan, dateKey = '2026-08-30') {
  return exportPlan.files.find(file => file.relativePath === `Life Ledger/Daily/${dateKey}.md`);
}

async function withTempVault(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronasense-life-ledger-'));
  await fs.mkdir(path.join(root, 'Life Ledger'), { recursive: true });
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function mockObsidianStats(kind) {
  return {
    mode: kind === 'link' ? 0x400 : 0,
    isSymbolicLink: () => kind === 'link',
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir'
  };
}

function createMockObsidianFs({ dirs = [], files = {}, links = [], realpaths = {}, readdir = {} } = {}) {
  const calls = { readFile: [], writeFile: [], rename: [], unlink: [], readdir: [], lstat: [], realpath: [], stat: [] };
  const normalize = value => path.resolve(value);
  const dirSet = new Set(dirs.map(normalize));
  const linkSet = new Set(links.map(normalize));
  const fileMap = new Map(Object.entries(files).map(([filePath, content]) => [normalize(filePath), content]));
  const realpathMap = new Map(Object.entries(realpaths).map(([filePath, realPath]) => [normalize(filePath), normalize(realPath)]));
  const readdirMap = new Map(Object.entries(readdir).map(([dirPath, names]) => [normalize(dirPath), names]));
  const missing = target => Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
  const adapter = {
    async mkdir(target) {
      dirSet.add(normalize(target));
    },
    async stat(target) {
      const key = normalize(target);
      calls.stat.push(key);
      if (fileMap.has(key)) return { size: fileMap.get(key).length, isFile: () => true };
      if (dirSet.has(key)) return { size: 0, isFile: () => false };
      throw missing(target);
    },
    async readFile(target) {
      const key = normalize(target);
      calls.readFile.push(key);
      if (!fileMap.has(key)) throw missing(target);
      return fileMap.get(key);
    },
    async writeFile(target, content) {
      const key = normalize(target);
      calls.writeFile.push(key);
      fileMap.set(key, content);
    },
    async rename(from, to) {
      const fromKey = normalize(from);
      const toKey = normalize(to);
      calls.rename.push([fromKey, toKey]);
      if (!fileMap.has(fromKey)) throw missing(from);
      fileMap.set(toKey, fileMap.get(fromKey));
      fileMap.delete(fromKey);
    },
    async unlink(target) {
      const key = normalize(target);
      calls.unlink.push(key);
      fileMap.delete(key);
      linkSet.delete(key);
    },
    async readdir(target) {
      const key = normalize(target);
      calls.readdir.push(key);
      if (!readdirMap.has(key)) throw missing(target);
      return readdirMap.get(key).map(name => ({ name, isFile: () => fileMap.has(path.join(key, name)) }));
    },
    async lstat(target) {
      const key = normalize(target);
      calls.lstat.push(key);
      if (linkSet.has(key)) return mockObsidianStats('link');
      if (fileMap.has(key)) return mockObsidianStats('file');
      if (dirSet.has(key)) return mockObsidianStats('dir');
      throw missing(target);
    },
    async realpath(target) {
      const key = normalize(target);
      calls.realpath.push(key);
      if (realpathMap.has(key)) return realpathMap.get(key);
      if (dirSet.has(key) || fileMap.has(key) || linkSet.has(key)) return key;
      throw missing(target);
    }
  };
  return { adapter, calls, fileMap, linkSet };
}

function lifeLedgerDraftFromEvent(event) {
  const { eventId, recordedAt, revisedAt, revision, ...draft } = event;
  return draft;
}

async function withTempSnapshotFile(content, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronasense-life-ledger-snapshot-'));
  const filePath = path.join(root, 'chronasense-life-ledger-v1.json');
  try {
    await fs.writeFile(filePath, content, 'utf8');
    return await fn(filePath, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function createCliSpyOptions(fsAdapter) {
  const calls = { renderer: 0, resolvePath: 0, writeExport: 0 };
  return {
    calls,
    options: {
      fs: fsAdapter,
      buildExportPlan(events) {
        calls.renderer++;
        return buildObsidianLifeLedgerExport(events);
      },
      async resolvePath(vaultRoot, relativePath, options) {
        calls.resolvePath++;
        return resolveObsidianLifeLedgerPath(vaultRoot, relativePath, options);
      },
      async writeExport(plan, options) {
        calls.writeExport++;
        return writeObsidianLifeLedgerExport(plan, options);
      }
    }
  };
}

async function assertCliSnapshotRejectedWithoutSideEffects(snapshotText, expectedCode) {
  const input = 'C:\\Snapshot\\bad.json';
  const vault = 'C:\\SafeVault';
  const { adapter, calls: fsCalls } = createMockObsidianFs({
    dirs: [vault],
    files: { [input]: snapshotText }
  });
  const { calls, options } = createCliSpyOptions(adapter);
  await assert.rejects(() => runLifeLedgerObsidianExport(['--input', input, '--vault', vault], options), error => error.code === expectedCode);
  assert.equal(calls.renderer, 0);
  assert.equal(calls.resolvePath, 0);
  assert.equal(calls.writeExport, 0);
  assert.equal(fsCalls.lstat.length, 0);
  assert.equal(fsCalls.writeFile.length, 0);
  assert.equal(fsCalls.unlink.length, 0);
}

async function assertCliArgsRejectedBeforeSnapshotRead(argv, expectedCode) {
  const { adapter, calls } = createMockObsidianFs();
  const { calls: cliCalls, options } = createCliSpyOptions(adapter);
  await assert.rejects(() => runLifeLedgerObsidianExport(argv, options), error => error.code === expectedCode);
  assert.equal(calls.stat.length, 0);
  assert.equal(calls.readFile.length, 0);
  assert.equal(calls.lstat.length, 0);
  assert.equal(cliCalls.renderer, 0);
  assert.equal(cliCalls.resolvePath, 0);
  assert.equal(cliCalls.writeExport, 0);
}

console.log('\nObsidian Life Ledger export');
test('transport exports an empty runtime Ledger as a valid envelope', () => {
  const storage = makeMemoryStorage();
  const snapshot = exportLifeLedgerSnapshot({ storage });
  assert.equal(snapshot.transportSchemaVersion, LIFE_LEDGER_TRANSPORT_SCHEMA_VERSION);
  assert.equal(snapshot.kind, LIFE_LEDGER_TRANSPORT_KIND);
  assert.deepEqual(snapshot.events, []);
});
test('transport exports all runtime Ledger events without regenerating identity', () => {
  const storage = makeMemoryStorage();
  const store = createLocalLifeLedgerStore({ storage });
  store.upsertEvent(lifeLedgerDraftFromEvent(obsidianFocusEvent()), {
    createId: () => obsidianFocusEvent().eventId,
    clock: () => obsidianFocusEvent().recordedAt
  });
  store.upsertEvent(lifeLedgerDraftFromEvent(obsidianStepEvent()), {
    createId: () => obsidianStepEvent().eventId,
    clock: () => obsidianStepEvent().recordedAt
  });
  const snapshot = exportLifeLedgerSnapshot({ store });
  assert.deepEqual(snapshot.events.map(event => event.eventId).sort(), [obsidianFocusEvent().eventId, obsidianStepEvent().eventId].sort());
  assert.deepEqual(snapshot.events.map(event => event.revision), [1, 1]);
});
test('transport preserves tombstones, event IDs, and revisions', () => {
  const tombstoned = obsidianStepEvent({
    revision: 2,
    revisedAt: '2026-08-30T16:32:00.000Z',
    tombstone: {
      active: true,
      deletedAt: '2026-08-30T16:32:00.000Z',
      reason: 'user_delete',
      provenance: { sourceOperation: 'delete', sourceRecordKind: 'chronasense.plan_step', evidence: ['synthetic.step:1:deleted'] }
    }
  });
  const snapshot = createLifeLedgerSnapshotFromEvents([tombstoned]);
  assert.equal(snapshot.events[0].eventId, tombstoned.eventId);
  assert.equal(snapshot.events[0].revision, 2);
  assert.equal(snapshot.events[0].tombstone.active, true);
});
test('transport serialization is byte-identical for identical Ledger state', () => {
  const snapshot = createLifeLedgerSnapshotFromEvents([obsidianStepEvent(), obsidianFocusEvent()]);
  assert.equal(serializeLifeLedgerSnapshot(snapshot), serializeLifeLedgerSnapshot(snapshot));
});
test('transport serialization is byte-identical for the same event set in different array order', () => {
  const first = serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianFocusEvent(), obsidianStepEvent()]));
  const second = serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent(), obsidianFocusEvent()]));
  assert.equal(first, second);
});
test('transport serialization does not mutate the caller event array order or events', () => {
  const events = [obsidianStepEvent(), obsidianFocusEvent()];
  const before = JSON.stringify(events);
  serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents(events));
  assert.equal(JSON.stringify(events), before);
  assert.deepEqual(events.map(event => event.eventId), [obsidianStepEvent().eventId, obsidianFocusEvent().eventId]);
});
test('transport export does not mutate the runtime Ledger', () => {
  const storage = makeMemoryStorage();
  const store = createLocalLifeLedgerStore({ storage });
  store.upsertEvent(lifeLedgerDraftFromEvent(obsidianStepEvent()), {
    createId: () => obsidianStepEvent().eventId,
    clock: () => obsidianStepEvent().recordedAt
  });
  const before = JSON.stringify(store.listEvents());
  exportLifeLedgerSnapshot({ store });
  assert.equal(JSON.stringify(store.listEvents()), before);
});
test('transport refuses malformed runtime Ledger state through the runtime boundary', () => {
  const storage = makeMemoryStorage({
    [LIFE_LEDGER_RUNTIME_KEY]: JSON.stringify({ schemaVersion: 1, records: [{ key: 'bad', fingerprint: 'bad', event: { nope: true } }] })
  });
  assert.throws(() => exportLifeLedgerSnapshot({ storage }), error => error.code === 'invalid_record');
});
test('transport accepts a valid snapshot and preserves event identity on import', () => {
  const snapshot = parseLifeLedgerSnapshotJson(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent()])));
  assert.equal(snapshot.events[0].eventId, obsidianStepEvent().eventId);
  assert.equal(snapshot.events[0].revision, 1);
});
test('transport rejects malformed JSON, wrong version, wrong kind, invalid events, and duplicate logical events', () => {
  assert.throws(() => parseLifeLedgerSnapshotJson('{bad'), error => error.code === 'invalid_json');
  assert.throws(() => parseLifeLedgerSnapshotJson(JSON.stringify({ transportSchemaVersion: 2, kind: LIFE_LEDGER_TRANSPORT_KIND, events: [] })), error => error.code === 'unsupported_transport_schema');
  assert.throws(() => parseLifeLedgerSnapshotJson(JSON.stringify({ transportSchemaVersion: 1, kind: 'other', events: [] })), error => error.code === 'invalid_snapshot_kind');
  assert.throws(() => parseLifeLedgerSnapshotJson(JSON.stringify({ transportSchemaVersion: 1, kind: LIFE_LEDGER_TRANSPORT_KIND, events: [{ nope: true }] })), error => error.code === 'invalid_event');
  assert.throws(() => createLifeLedgerSnapshotFromEvents([obsidianStepEvent(), { ...obsidianStepEvent(), eventId: '30303030-3030-4030-8030-303030303030' }]), error => error.code === 'duplicate_logical_event');
});
test('transport privacy envelope excludes unrelated storage and token-like values', () => {
  const storage = makeMemoryStorage({ firebaseAuthToken: 'secret-token', 'ta3-settings': '{"timezone":"UTC"}' });
  const snapshot = exportLifeLedgerSnapshot({ storage });
  assert.equal(snapshotHasOnlyLedgerEnvelope(snapshot), true);
  assert.equal(JSON.stringify(snapshot).includes('secret-token'), false);
  assert.deepEqual(Object.keys(snapshot).sort(), ['events', 'kind', 'transportSchemaVersion']);
});
test('transport snapshot import preserves tombstones as tombstones', () => {
  const tombstoned = obsidianStepEvent({
    revision: 2,
    revisedAt: '2026-08-30T16:32:00.000Z',
    tombstone: {
      active: true,
      deletedAt: '2026-08-30T16:32:00.000Z',
      reason: 'user_delete',
      provenance: { sourceOperation: 'delete', sourceRecordKind: 'chronasense.plan_step', evidence: ['synthetic.step:1:deleted'] }
    }
  });
  const snapshot = parseLifeLedgerSnapshotJson(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([tombstoned])));
  assert.equal(snapshot.events[0].tombstone.active, true);
  assert.equal(snapshot.events[0].eventId, tombstoned.eventId);
  assert.equal(snapshot.events[0].revision, 2);
});

asyncTest('CLI validation failure performs zero writer filesystem calls', async () => {
  const input = 'C:\\Snapshot\\bad.json';
  const vault = 'C:\\SafeVault';
  const { adapter, calls } = createMockObsidianFs({
    files: { [input]: '{bad json' }
  });
  await assert.rejects(() => runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--apply'], { fs: adapter }), error => error.code === 'invalid_json');
  assert.equal(calls.lstat.length, 0);
  assert.equal(calls.writeFile.length, 0);
  assert.equal(calls.unlink.length, 0);
});
asyncTest('CLI rejects malformed JSON before renderer or writer calls', async () => {
  await assertCliSnapshotRejectedWithoutSideEffects('{bad json', 'invalid_json');
});
asyncTest('CLI rejects wrong transport schema before renderer or writer calls', async () => {
  await assertCliSnapshotRejectedWithoutSideEffects(JSON.stringify({ transportSchemaVersion: 2, kind: LIFE_LEDGER_TRANSPORT_KIND, events: [] }), 'unsupported_transport_schema');
});
asyncTest('CLI rejects wrong snapshot kind before renderer or writer calls', async () => {
  await assertCliSnapshotRejectedWithoutSideEffects(JSON.stringify({ transportSchemaVersion: 1, kind: 'other', events: [] }), 'invalid_snapshot_kind');
});
asyncTest('CLI rejects non-array snapshot events before renderer or writer calls', async () => {
  await assertCliSnapshotRejectedWithoutSideEffects(JSON.stringify({ transportSchemaVersion: 1, kind: LIFE_LEDGER_TRANSPORT_KIND, events: {} }), 'invalid_snapshot_events');
});
asyncTest('CLI rejects invalid Life Ledger events before renderer or writer calls', async () => {
  await assertCliSnapshotRejectedWithoutSideEffects(JSON.stringify({ transportSchemaVersion: 1, kind: LIFE_LEDGER_TRANSPORT_KIND, events: [{ nope: true }] }), 'invalid_event');
});
asyncTest('CLI rejects duplicate logical events before renderer or writer calls', async () => {
  await assertCliSnapshotRejectedWithoutSideEffects(JSON.stringify({
    transportSchemaVersion: 1,
    kind: LIFE_LEDGER_TRANSPORT_KIND,
    events: [obsidianStepEvent(), { ...obsidianStepEvent(), eventId: '30303030-3030-4030-8030-303030303030' }]
  }), 'duplicate_logical_event');
});
asyncTest('CLI rejects duplicate event IDs before renderer or writer calls', async () => {
  await assertCliSnapshotRejectedWithoutSideEffects(JSON.stringify({
    transportSchemaVersion: 1,
    kind: LIFE_LEDGER_TRANSPORT_KIND,
    events: [obsidianStepEvent(), obsidianFocusEvent({ eventId: obsidianStepEvent().eventId })]
  }), 'duplicate_event_id');
});
asyncTest('CLI defaults to dry run and reports planned managed paths without writing', async () => withTempVault(async vault => {
  await fs.writeFile(path.join(vault, 'TEST-VAULT.md'), 'test vault\n', 'utf8');
  await withTempSnapshotFile(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianFocusEvent(), obsidianStepEvent()])), async input => {
    const summary = await runLifeLedgerObsidianExport(['--input', input, '--vault', vault]);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.written, 2);
    assert.deepEqual(summary.plannedPaths.sort(), ['Life Ledger/Daily/2026-08-30.md', 'Life Ledger/System/README.md']);
    assert.equal(await pathExists(path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md')), false);
  });
}));
asyncTest('CLI explicit dry run remains dry run and reports planned managed paths without writing', async () => withTempVault(async vault => {
  await fs.writeFile(path.join(vault, 'TEST-VAULT.md'), 'test vault\n', 'utf8');
  await withTempSnapshotFile(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent()])), async input => {
    const summary = await runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--dry-run']);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.written, 2);
    assert.equal(await pathExists(path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md')), false);
  });
}));
asyncTest('CLI apply requires TEST-VAULT marker', async () => withTempVault(async vault => {
  await withTempSnapshotFile(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent()])), async input => {
    await assert.rejects(() => runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--apply']), error => error.code === 'apply_not_authorized');
    assert.equal(await pathExists(path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md')), false);
  });
}));
asyncTest('CLI apply authorization succeeds with a real regular TEST-VAULT marker', async () => {
  const input = 'C:\\Snapshot\\ledger.json';
  const vault = 'C:\\SafeVault';
  const marker = path.join(vault, 'TEST-VAULT.md');
  const { adapter } = createMockObsidianFs({
    dirs: [vault, path.join(vault, 'Life Ledger')],
    files: {
      [input]: serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent()])),
      [marker]: 'test vault\n'
    }
  });
  const summary = await runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--apply'], { fs: adapter });
  assert.equal(summary.dryRun, false);
  assert.equal(summary.applyAuthorized, true);
  assert.equal(summary.written, 2);
});
asyncTest('CLI apply rejects a TEST-VAULT marker symlink or reparse point before writer calls', async () => {
  const input = 'C:\\Snapshot\\ledger.json';
  const vault = 'C:\\SafeVault';
  const marker = path.join(vault, 'TEST-VAULT.md');
  const { adapter, calls: fsCalls } = createMockObsidianFs({
    dirs: [vault],
    files: { [input]: serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent()])) },
    links: [marker]
  });
  const { calls, options } = createCliSpyOptions(adapter);
  await assert.rejects(() => runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--apply'], options), error => error.code === 'apply_not_authorized');
  assert.equal(calls.renderer, 0);
  assert.equal(calls.resolvePath, 0);
  assert.equal(calls.writeExport, 0);
  assert.equal(fsCalls.writeFile.length, 0);
  assert.equal(fsCalls.unlink.length, 0);
});
asyncTest('CLI apply rejects a TEST-VAULT.md directory marker', async () => {
  const input = 'C:\\Snapshot\\ledger.json';
  const vault = 'C:\\SafeVault';
  const marker = path.join(vault, 'TEST-VAULT.md');
  const { adapter, calls: fsCalls } = createMockObsidianFs({
    dirs: [vault, marker],
    files: { [input]: serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent()])) }
  });
  const { calls, options } = createCliSpyOptions(adapter);
  await assert.rejects(() => runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--apply'], options), error => error.code === 'apply_not_authorized');
  assert.equal(calls.writeExport, 0);
  assert.equal(fsCalls.writeFile.length, 0);
  assert.equal(fsCalls.unlink.length, 0);
});
asyncTest('CLI apply rejects nested TEST-VAULT.md when the vault-root marker is absent', async () => {
  const input = 'C:\\Snapshot\\ledger.json';
  const vault = 'C:\\SafeVault';
  const nested = path.join(vault, 'Nested', 'TEST-VAULT.md');
  const { adapter, calls: fsCalls } = createMockObsidianFs({
    dirs: [vault, path.join(vault, 'Nested')],
    files: {
      [input]: serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent()])),
      [nested]: 'test vault\n'
    }
  });
  const { calls, options } = createCliSpyOptions(adapter);
  await assert.rejects(() => runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--apply'], options), error => error.code === 'apply_not_authorized');
  assert.equal(calls.writeExport, 0);
  assert.equal(fsCalls.writeFile.length, 0);
  assert.equal(fsCalls.unlink.length, 0);
});
asyncTest('CLI rejects duplicate --input before reading snapshots', async () => {
  await assertCliArgsRejectedBeforeSnapshotRead(['--input', 'one.json', '--input', 'two.json', '--vault', 'C:\\SafeVault'], 'duplicate_input');
});
asyncTest('CLI rejects duplicate --vault before reading snapshots', async () => {
  await assertCliArgsRejectedBeforeSnapshotRead(['--input', 'one.json', '--vault', 'C:\\SafeVault', '--vault', 'C:\\OtherVault'], 'duplicate_vault');
});
asyncTest('CLI rejects --apply combined with --dry-run before reading snapshots', async () => {
  await assertCliArgsRejectedBeforeSnapshotRead(['--input', 'one.json', '--vault', 'C:\\SafeVault', '--apply', '--dry-run'], 'conflicting_mode');
});
asyncTest('CLI rejects duplicate --apply before reading snapshots', async () => {
  await assertCliArgsRejectedBeforeSnapshotRead(['--input', 'one.json', '--vault', 'C:\\SafeVault', '--apply', '--apply'], 'duplicate_apply');
});
asyncTest('CLI rejects duplicate --dry-run before reading snapshots', async () => {
  await assertCliArgsRejectedBeforeSnapshotRead(['--input', 'one.json', '--vault', 'C:\\SafeVault', '--dry-run', '--dry-run'], 'duplicate_dry_run');
});
asyncTest('CLI rejects missing --input value before reading snapshots', async () => {
  await assertCliArgsRejectedBeforeSnapshotRead(['--input', '--vault', 'C:\\SafeVault'], 'missing_input_value');
});
asyncTest('CLI rejects missing --vault value before reading snapshots', async () => {
  await assertCliArgsRejectedBeforeSnapshotRead(['--input', 'one.json', '--vault'], 'missing_vault_value');
});
asyncTest('CLI rejects unknown flags before reading snapshots', async () => {
  await assertCliArgsRejectedBeforeSnapshotRead(['--input', 'one.json', '--vault', 'C:\\SafeVault', '--surprise'], 'unknown_arg');
});
asyncTest('CLI rejects positional garbage before reading snapshots', async () => {
  await assertCliArgsRejectedBeforeSnapshotRead(['--input', 'one.json', '--vault', 'C:\\SafeVault', 'garbage'], 'unexpected_position');
});
asyncTest('CLI apply rejects denied Obsidian vault roots', async () => {
  const input = 'C:\\Snapshot\\ledger.json';
  const oneDriveRoot = 'C:\\Users\\Admin\\OneDrive\\2nd Brain';
  const desktopRoot = 'C:\\Users\\Admin\\Desktop\\2nd Brain';
  for (const deniedRoot of [oneDriveRoot, desktopRoot]) {
    const { adapter } = createMockObsidianFs({
      dirs: [deniedRoot],
      files: {
        [input]: serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent()])),
        [path.join(deniedRoot, 'TEST-VAULT.md')]: 'test vault\n'
      }
    });
    await assert.rejects(() => runLifeLedgerObsidianExport(['--input', input, '--vault', deniedRoot, '--apply'], { fs: adapter }), error => error.code === 'denied_vault_root');
  }
});
asyncTest('CLI dry run rejects denied Obsidian vault roots without apply authorization', async () => {
  await withTempSnapshotFile(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent()])), async input => {
    await assert.rejects(() => runLifeLedgerObsidianExport(['--input', input, '--vault', 'C:\\Users\\Admin\\OneDrive\\2nd Brain']), error => error.code === 'denied_vault_root');
    await assert.rejects(() => runLifeLedgerObsidianExport(['--input', input, '--vault', 'C:\\Users\\Admin\\Desktop\\2nd Brain']), error => error.code === 'denied_vault_root');
  });
});
asyncTest('CLI apply uses the reviewed renderer and writer for authorized test vaults', async () => withTempVault(async vault => {
  await fs.writeFile(path.join(vault, 'TEST-VAULT.md'), 'test vault\n', 'utf8');
  await withTempSnapshotFile(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianFocusEvent(), obsidianStepEvent()])), async input => {
    const summary = await runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--apply']);
    assert.equal(summary.dryRun, false);
    assert.equal(summary.written, 2);
    const daily = await fs.readFile(path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md'), 'utf8');
    assert.ok(daily.includes('Synthetic focus'));
    assert.ok(daily.includes('Synthetic step'));
    assert.ok(daily.includes(OBSIDIAN_LIFE_LEDGER_SENTINEL));
  });
}));
asyncTest('CLI apply preserves unmanaged conflicts and identical second apply is a no-op', async () => withTempVault(async vault => {
  await fs.writeFile(path.join(vault, 'TEST-VAULT.md'), 'test vault\n', 'utf8');
  const inputContent = serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent()]));
  await withTempSnapshotFile(inputContent, async input => {
    await runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--apply']);
    const second = await runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--apply']);
    assert.equal(second.written, 0);
    assert.equal(second.deleted, 0);
    assert.equal(second.skipped, 2);
  });
  const manualVault = await fs.mkdtemp(path.join(os.tmpdir(), 'chronasense-life-ledger-manual-'));
  try {
    await fs.mkdir(path.join(manualVault, 'Life Ledger', 'Daily'), { recursive: true });
    await fs.writeFile(path.join(manualVault, 'TEST-VAULT.md'), 'test vault\n', 'utf8');
    await fs.writeFile(path.join(manualVault, 'Life Ledger', 'Daily', '2026-08-30.md'), '# Manual\n', 'utf8');
    await withTempSnapshotFile(inputContent, async input => {
      const conflict = await runLifeLedgerObsidianExport(['--input', input, '--vault', manualVault, '--apply']);
      assert.equal(conflict.conflicts, 1);
      assert.equal(await fs.readFile(path.join(manualVault, 'Life Ledger', 'Daily', '2026-08-30.md'), 'utf8'), '# Manual\n');
    });
  } finally {
    await fs.rm(manualVault, { recursive: true, force: true });
  }
}));
asyncTest('CLI apply preserves stale generated Daily cleanup semantics', async () => withTempVault(async vault => {
  await fs.writeFile(path.join(vault, 'TEST-VAULT.md'), 'test vault\n', 'utf8');
  await withTempSnapshotFile(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent()])), async input => {
    await runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--apply']);
  });
  await withTempSnapshotFile(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([])), async input => {
    const summary = await runLifeLedgerObsidianExport(['--input', input, '--vault', vault, '--apply']);
    assert.equal(summary.deleted, 1);
    assert.equal(await pathExists(path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md')), false);
  });
}));
test('transport round trip renders focus, live step, tombstoned step, and restored step semantics', () => {
  const live = parseLifeLedgerSnapshotJson(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianFocusEvent(), obsidianStepEvent()])));
  assert.ok(dailyFile(buildObsidianLifeLedgerExport(live.events)).content.includes('Synthetic focus'));
  assert.ok(dailyFile(buildObsidianLifeLedgerExport(live.events)).content.includes('Synthetic step'));

  const tombstoned = obsidianStepEvent({
    revision: 2,
    revisedAt: '2026-08-30T16:32:00.000Z',
    tombstone: {
      active: true,
      deletedAt: '2026-08-30T16:32:00.000Z',
      reason: 'user_delete',
      provenance: { sourceOperation: 'delete', sourceRecordKind: 'chronasense.plan_step', evidence: ['synthetic.step:1:deleted'] }
    }
  });
  const tombstonePlan = buildObsidianLifeLedgerExport(parseLifeLedgerSnapshotJson(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([tombstoned]))).events);
  assert.equal(dailyFile(tombstonePlan), undefined);

  const restored = parseLifeLedgerSnapshotJson(serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents([obsidianStepEvent({
    revision: 3,
    revisedAt: '2026-08-30T16:33:00.000Z'
  })])));
  assert.ok(dailyFile(buildObsidianLifeLedgerExport(restored.events)).content.includes('Synthetic step'));
});
test('renderer emits only the system note for an empty event set', () => {
  const exportPlan = buildObsidianLifeLedgerExport([]);
  assert.deepEqual(exportPlan.files.map(file => file.relativePath), ['Life Ledger/System/README.md']);
  assert.ok(exportPlan.files[0].content.includes(OBSIDIAN_LIFE_LEDGER_SENTINEL));
});
test('renderer renders focus_session_completed as human-readable focus Markdown', () => {
  const content = dailyFile(buildObsidianLifeLedgerExport([obsidianFocusEvent()])).content;
  assert.ok(content.includes('## Focus'));
  assert.ok(content.includes('- 09:00-09:25 - **Synthetic focus** · 25 min'));
  assert.ok(content.includes('<!-- life-ledger:event:10101010-1010-4010-8010-101010101010 -->'));
});
test('renderer renders plan_step_completed with available learning context', () => {
  const content = dailyFile(buildObsidianLifeLedgerExport([obsidianStepEvent()])).content;
  assert.ok(content.includes('## Learning'));
  assert.ok(content.includes('- 09:30 - Completed **Synthetic step**'));
  assert.ok(content.includes('  - Synthetic course / Phase 1 / Lesson 2'));
});
test('workout_completed permits unknown duration only when the source interval is not negative', () => {
  const payload = {
    ...obsidianWorkoutEvent().payload,
    startedAt: '2026-08-30T17:00:00.000Z',
    endedAt: '2026-08-30T17:00:00.000Z'
  };
  delete payload.durationMinutes;
  const unknownDuration = obsidianWorkoutEvent({
    occurredAt: '2026-08-30T17:00:00.000Z',
    payload
  });
  assert.equal(validateLifeLedgerEvent(unknownDuration).ok, true);
  const negative = {
    ...unknownDuration,
    occurredAt: '2026-08-30T16:59:00.000Z',
    payload: { ...unknownDuration.payload, endedAt: '2026-08-30T16:59:00.000Z' }
  };
  assert.equal(validateLifeLedgerEvent(negative).ok, false);
  const missingKnownDuration = obsidianWorkoutEvent({
    payload: { ...payload, endedAt: '2026-08-30T18:00:00.000Z' },
    occurredAt: '2026-08-30T18:00:00.000Z'
  });
  assert.equal(validateLifeLedgerEvent(missingKnownDuration).ok, false);
});
test('renderer renders workout_completed as compact factual Markdown', () => {
  const content = dailyFile(buildObsidianLifeLedgerExport([obsidianWorkoutEvent()])).content;
  assert.ok(content.includes('## Workouts'));
  assert.ok(content.includes('- 10:00-11:00 - Workout **Synthetic workout** · 60 min · 2 exercises · 2 sets'));
  assert.ok(content.includes('<!-- life-ledger:event:30303030-3030-4030-8030-303030303030 -->'));
});
test('mixed focus, plan step, and workout snapshot renders deterministically', () => {
  const snapshot = parseLifeLedgerSnapshotJson(serializeLifeLedgerSnapshot(
    createLifeLedgerSnapshotFromEvents([obsidianWorkoutEvent(), obsidianStepEvent(), obsidianFocusEvent()])
  ));
  const first = buildObsidianLifeLedgerExport(snapshot.events);
  const second = buildObsidianLifeLedgerExport(snapshot.events);
  const content = dailyFile(first).content;
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.ok(content.includes('## Focus'));
  assert.ok(content.includes('## Learning'));
  assert.ok(content.includes('## Workouts'));
});
test('workout_completed rejects a null payload', () => {
  assert.equal(validateLifeLedgerEvent(obsidianWorkoutEvent({ payload: null })).ok, false);
});
test('workout_completed rejects a non-string workoutName', () => {
  const result = validateLifeLedgerEvent(obsidianWorkoutEvent({
    payload: { ...obsidianWorkoutEvent().payload, workoutName: {} }
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('workoutName')));
});
test('workout_completed rejects exercises given as a string', () => {
  const result = validateLifeLedgerEvent(obsidianWorkoutEvent({
    payload: { ...obsidianWorkoutEvent().payload, exercises: 'legs and back' }
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('exercises')));
});
test('workout_completed rejects malformed nested exercise and set structures', () => {
  const setsNotArray = validateLifeLedgerEvent(obsidianWorkoutEvent({
    payload: { ...obsidianWorkoutEvent().payload, exercises: [{ exerciseId: 'squat', mode: 'reps', sets: 'not-an-array' }] }
  }));
  assert.equal(setsNotArray.ok, false);
  const wrongTypedSet = validateLifeLedgerEvent(obsidianWorkoutEvent({
    payload: { ...obsidianWorkoutEvent().payload, exercises: [{ exerciseId: 'squat', mode: 'reps', sets: [{ load: 'heavy', repetitions: 5 }] }] }
  }));
  assert.equal(wrongTypedSet.ok, false);
});
test('workout_completed rejects a non-object bodyWeight', () => {
  const result = validateLifeLedgerEvent(obsidianWorkoutEvent({
    payload: { ...obsidianWorkoutEvent().payload, bodyWeight: '82.4' }
  }));
  assert.equal(result.ok, false);
});
test('workout_completed rejects an out-of-enum rating', () => {
  const result = validateLifeLedgerEvent(obsidianWorkoutEvent({
    payload: { ...obsidianWorkoutEvent().payload, rating: 5 }
  }));
  assert.equal(result.ok, false);
});
test('workout_completed rejects a non-string note', () => {
  const result = validateLifeLedgerEvent(obsidianWorkoutEvent({
    payload: { ...obsidianWorkoutEvent().payload, note: {} }
  }));
  assert.equal(result.ok, false);
});
test('workout_completed rejects oversized free-text fields', () => {
  const result = validateLifeLedgerEvent(obsidianWorkoutEvent({
    payload: { ...obsidianWorkoutEvent().payload, workoutName: 'x'.repeat(201) }
  }));
  assert.equal(result.ok, false);
});
test('workout_completed rejects unsafe control characters in free text', () => {
  const bell = String.fromCharCode(7);
  const result = validateLifeLedgerEvent(obsidianWorkoutEvent({
    payload: { ...obsidianWorkoutEvent().payload, workoutName: `Leg day${bell}` }
  }));
  assert.equal(result.ok, false);
});
test('renderer rejects a malformed workout_completed payload instead of fabricating a line', () => {
  assert.throws(
    () => buildObsidianLifeLedgerExport([obsidianWorkoutEvent({ payload: { ...obsidianWorkoutEvent().payload, workoutName: {} } })]),
    /Malformed workout_completed payload/
  );
  assert.throws(
    () => buildObsidianLifeLedgerExport([obsidianWorkoutEvent({ payload: { ...obsidianWorkoutEvent().payload, exercises: 'nope' } })]),
    /Malformed workout_completed payload/
  );
});

// Shared drift guard: every fixture here is run against BOTH life-ledger-core.js's shared
// validateLifeLedgerEvent() and the renderer's buildObsidianLifeLedgerExport() directly. The
// invariant under test is that the renderer never accepts a workout_completed payload the core
// rejects (and vice versa for the one canonical valid fixture). A future change to either
// validator that drifts from the other on any of these cases fails this test.
const WORKOUT_PARITY_FIXTURES = [
  { label: 'valid canonical workout', valid: true, mutate: payload => payload },
  { label: 'reserved payload.program field', valid: false, mutate: payload => ({ ...payload, program: { bad: true } }) },
  { label: 'reserved top-level payload.sets field', valid: false, mutate: payload => ({ ...payload, sets: 'bad' }) },
  { label: 'unknown payload.source key', valid: false, mutate: payload => ({ ...payload, source: { ...payload.source, extra: 'x' } }) },
  { label: 'extra key inside timezoneContext', valid: false, mutate: payload => ({
    ...payload, source: { ...payload.source, timezoneContext: { ...payload.source.timezoneContext, extra: 'x' } }
  }) },
  { label: 'contradictory weightUnitContext (unknown authority + unit)', valid: false, mutate: payload => ({
    ...payload, source: { ...payload.source, weightUnitContext: { authority: 'unknown', unit: 'lb' } }
  }) },
  { label: 'invalid weightUnitContext authority enum', valid: false, mutate: payload => ({
    ...payload, source: { ...payload.source, weightUnitContext: { authority: 'bogus' } }
  }) },
  { label: 'overclaiming recordOrigin', valid: false, mutate: payload => ({
    ...payload, source: { ...payload.source, recordOrigin: 'definitely_native' }
  }) },
  { label: 'overclaiming completionBasis', valid: false, mutate: payload => ({
    ...payload, source: { ...payload.source, completionBasis: 'cryptographically_verified' }
  }) },
  { label: 'missing exerciseId', valid: false, mutate: payload => ({
    ...payload, exercises: [{ mode: 'reps', sets: [{ load: 100, repetitions: 5 }] }]
  }) },
  { label: 'missing mode with invalid set shape', valid: false, mutate: payload => ({
    ...payload, exercises: [{ exerciseId: 'x', sets: ['bad'] }]
  }) },
  { label: 'empty sets array', valid: false, mutate: payload => ({
    ...payload, exercises: [{ exerciseId: 'x', mode: 'reps', sets: [] }]
  }) },
  { label: 'invalid rir out of range', valid: false, mutate: payload => ({
    ...payload, exercises: [{ exerciseId: 'x', mode: 'reps', sets: [{ load: 1, repetitions: 1, rir: 99 }] }]
  }) },
  { label: 'invalid prescription (negative plannedSets)', valid: false, mutate: payload => ({
    ...payload,
    exercises: [{
      exerciseId: 'x', mode: 'reps', sets: [{ load: 1, repetitions: 1 }],
      prescription: { mode: 'reps', plannedSets: -1 }
    }]
  }) },
  { label: 'bodyWeight with an extra field', valid: false, mutate: payload => ({
    ...payload, bodyWeight: { value: 80, extra: true }
  }) },
  { label: 'missing startedAt', valid: false, mutate: payload => {
    const { startedAt, ...rest } = payload;
    return rest;
  } },
  { label: 'missing endedAt', valid: false, mutate: payload => {
    const { endedAt, ...rest } = payload;
    return rest;
  } },
  { label: 'invalid startedAt (not an ISO instant)', valid: false, mutate: payload => ({ ...payload, startedAt: 'not-a-date' }) },
  { label: 'invalid endedAt (not an ISO instant)', valid: false, mutate: payload => ({ ...payload, endedAt: 'not-a-date' }) },
  { label: 'endedAt before startedAt', valid: false, mutate: payload => ({
    ...payload, startedAt: '2026-08-30T19:00:00.000Z', endedAt: '2026-08-30T18:00:00.000Z'
  }) },
  { label: 'durationMinutes: 0', valid: false, mutate: payload => ({ ...payload, durationMinutes: 0 }) },
  { label: 'durationMinutes present but interval is zero (inconsistent)', valid: false, mutate: payload => ({
    ...payload, startedAt: payload.endedAt, durationMinutes: 60
  }) },
  { label: 'endedAt does not match top-level occurredAt', valid: false, mutate: payload => ({
    ...payload, endedAt: '2026-08-30T18:05:00.000Z'
  }) },
  { label: 'valid equal start/end with duration omitted (unknown duration)', valid: true, mutate: payload => {
    const { durationMinutes, ...rest } = payload;
    return { ...rest, startedAt: payload.endedAt };
  } }
];
test('workout_completed core/renderer validator parity matrix', () => {
  WORKOUT_PARITY_FIXTURES.forEach(({ label, valid, mutate }) => {
    const event = obsidianWorkoutEvent({ payload: mutate(obsidianWorkoutEvent().payload) });
    const coreResult = validateLifeLedgerEvent(event);
    assert.equal(coreResult.ok, valid, `core validation mismatch for "${label}": ${JSON.stringify(coreResult.errors)}`);
    let rendererOk = true;
    let rendererError = null;
    try {
      buildObsidianLifeLedgerExport([event]);
    } catch (err) {
      rendererOk = false;
      rendererError = err.message;
    }
    assert.equal(rendererOk, valid, `renderer validation mismatch for "${label}": ${rendererError}`);
  });
});

// Same drift guard as WORKOUT_PARITY_FIXTURES above, applied to meal_prepared and
// meal_consumed: every fixture runs against both life-ledger-core.js's shared
// validateLifeLedgerEvent() and the renderer's independent copy directly.
const MEAL_PREPARED_PARITY_FIXTURES = [
  { label: 'valid canonical meal_prepared', valid: true, mutate: payload => payload },
  { label: 'unknown top-level payload key', valid: false, mutate: payload => ({ ...payload, portionsRemaining: 'nope', extraneous: true }) },
  { label: 'unknown payload.source key', valid: false, mutate: payload => ({ ...payload, source: { ...payload.source, extra: 'x' } }) },
  { label: 'cookedMealId not matching sourceEntityId', valid: false, mutate: payload => ({
    ...payload, source: { ...payload.source, cookedMealId: 'someone-elses-id' }
  }) },
  { label: 'localDate not YYYY-MM-DD', valid: false, mutate: payload => ({ ...payload, source: { ...payload.source, localDate: '08/30/2026' } }) },
  { label: 'localDate is an impossible calendar date', valid: false, mutate: payload => ({ ...payload, source: { ...payload.source, localDate: '2026-02-30' } }) },
  { label: 'overclaiming preparedDateBasis', valid: false, mutate: payload => ({
    ...payload, source: { ...payload.source, preparedDateBasis: 'captured-exact-moment' }
  }) },
  { label: 'reintroduced storage field is unrecognized', valid: false, mutate: payload => ({ ...payload, source: { ...payload.source, storage: 'fridge' } }) },
  { label: 'invalid preparationKind enum', valid: false, mutate: payload => ({ ...payload, source: { ...payload.source, preparationKind: 'foraged' } }) },
  { label: 'portionsPrepared out of range (0)', valid: false, mutate: payload => ({ ...payload, portionsPrepared: 0 }) },
  { label: 'portionsPrepared out of range (>99)', valid: false, mutate: payload => ({ ...payload, portionsPrepared: 100 }) },
  { label: 'portionsPrepared not an integer', valid: false, mutate: payload => ({ ...payload, portionsPrepared: 2.5 }) },
  { label: 'reintroduced portionsRemaining field is unrecognized', valid: false, mutate: payload => ({ ...payload, portionsRemaining: 1 }) },
  { label: 'reintroduced ingredients field is unrecognized', valid: false, mutate: payload => ({ ...payload, ingredients: ['chicken'] }) },
  { label: 'missing mealName', valid: false, mutate: payload => { const { mealName, ...rest } = payload; return rest; } },
  { label: 'mealName is an object', valid: false, mutate: payload => ({ ...payload, mealName: {} }) },
  { label: 'oversized mealName', valid: false, mutate: payload => ({ ...payload, mealName: 'x'.repeat(201) }) },
  { label: 'unsafe control character in mealName', valid: false, mutate: payload => ({ ...payload, mealName: `Chicken${String.fromCharCode(7)}` }) },
  { label: 'missing preparedDate', valid: false, mutate: payload => { const { preparedDate, ...rest } = payload; return rest; } },
  { label: 'invalid preparedDate (not YYYY-MM-DD)', valid: false, mutate: payload => ({ ...payload, preparedDate: 'not-a-date' }) },
  { label: 'preparedDate is an impossible calendar date', valid: false, mutate: payload => ({ ...payload, preparedDate: '2026-02-30' }) },
  { label: 'preparedDate does not match top-level occurredDate', valid: false, mutate: payload => ({ ...payload, preparedDate: '2026-08-31' }) },
  { label: 'valid with no portionsPrepared (untracked batch)', valid: true, mutate: payload => {
    const { portionsPrepared, ...rest } = payload;
    return rest;
  } }
];
test('meal_prepared core/renderer payload validator parity matrix', () => {
  MEAL_PREPARED_PARITY_FIXTURES.forEach(({ label, valid, mutate }) => {
    const event = obsidianMealPreparedEvent({ payload: mutate(obsidianMealPreparedEvent().payload) });
    const coreResult = validateLifeLedgerEvent(event);
    assert.equal(coreResult.ok, valid, `core validation mismatch for "${label}": ${JSON.stringify(coreResult.errors)}`);
    let rendererOk = true;
    let rendererError = null;
    try {
      buildObsidianLifeLedgerExport([event]);
    } catch (err) {
      rendererOk = false;
      rendererError = err.message;
    }
    assert.equal(rendererOk, valid, `renderer validation mismatch for "${label}": ${rendererError}`);
  });
});
test('meal_prepared temporalPrecision mismatch, fake-midnight, and occurredAt:null are rejected by both core and renderer', () => {
  [
    { ...obsidianMealPreparedEvent(), temporalPrecision: 'instant', occurredAt: '2026-08-30T00:00:00.000Z', occurredDate: undefined },
    { ...obsidianMealPreparedEvent(), occurredAt: '2026-08-30T00:00:00.000Z' },
    { ...obsidianMealPreparedEvent(), occurredAt: null }
  ].forEach(event => {
    assert.equal(validateLifeLedgerEvent(event).ok, false);
    assert.throws(() => buildObsidianLifeLedgerExport([event]));
  });
});

const MEAL_CONSUMED_PARITY_FIXTURES = [
  { label: 'valid canonical meal_consumed', valid: true, mutate: payload => payload },
  { label: 'unknown top-level payload key', valid: false, mutate: payload => ({ ...payload, extraneous: true }) },
  { label: 'unknown payload.source key', valid: false, mutate: payload => ({ ...payload, source: { ...payload.source, extra: 'x' } }) },
  { label: 'consumptionId not matching sourceEntityId', valid: false, mutate: payload => ({
    ...payload, source: { ...payload.source, consumptionId: 'someone-elses-id' }
  }) },
  { label: 'cookedMealId wrong type', valid: false, mutate: payload => ({ ...payload, cookedMealId: 42 }) },
  { label: 'missing cookedMealId (required — every real record captures it)', valid: false, mutate: payload => { const { cookedMealId, ...rest } = payload; return rest; } },
  { label: 'missing mealName', valid: false, mutate: payload => { const { mealName, ...rest } = payload; return rest; } },
  { label: 'mealName is an object', valid: false, mutate: payload => ({ ...payload, mealName: {} }) },
  { label: 'missing consumedAt', valid: false, mutate: payload => { const { consumedAt, ...rest } = payload; return rest; } },
  { label: 'invalid consumedAt (not an ISO instant)', valid: false, mutate: payload => ({ ...payload, consumedAt: 'not-a-date' }) },
  { label: 'consumedAt does not match top-level occurredAt', valid: false, mutate: payload => ({ ...payload, consumedAt: '2026-08-30T20:00:00.000Z' }) },
  { label: 'missing portionCount', valid: false, mutate: payload => { const { portionCount, ...rest } = payload; return rest; } },
  { label: 'portionCount zero', valid: false, mutate: payload => ({ ...payload, portionCount: 0 }) },
  { label: 'portionCount negative', valid: false, mutate: payload => ({ ...payload, portionCount: -1 }) },
  { label: 'portionCount non-numeric', valid: false, mutate: payload => ({ ...payload, portionCount: 'one' }) },
  { label: 'portionCount not an integer (1.5)', valid: false, mutate: payload => ({ ...payload, portionCount: 1.5 }) },
  { label: 'portionCount out of range (100)', valid: false, mutate: payload => ({ ...payload, portionCount: 100 }) },
  { label: 'valid without recipeId linkage (cookedMealId still required)', valid: true, mutate: payload => (
    { ...payload, source: { consumptionId: payload.source.consumptionId } }
  ) }
];
test('meal_consumed core/renderer payload validator parity matrix', () => {
  MEAL_CONSUMED_PARITY_FIXTURES.forEach(({ label, valid, mutate }) => {
    const event = obsidianMealConsumedEvent({ payload: mutate(obsidianMealConsumedEvent().payload) });
    const coreResult = validateLifeLedgerEvent(event);
    assert.equal(coreResult.ok, valid, `core validation mismatch for "${label}": ${JSON.stringify(coreResult.errors)}`);
    let rendererOk = true;
    let rendererError = null;
    try {
      buildObsidianLifeLedgerExport([event]);
    } catch (err) {
      rendererOk = false;
      rendererError = err.message;
    }
    assert.equal(rendererOk, valid, `renderer validation mismatch for "${label}": ${rendererError}`);
  });
});

function assertTemporalEnvelopeParity(label, event, valid) {
  const coreResult = validateLifeLedgerEvent(event);
  assert.equal(coreResult.ok, valid, `core temporal-envelope mismatch for "${label}": ${JSON.stringify(coreResult.errors)}`);
  let rendererOk = true;
  let rendererError = null;
  try {
    buildObsidianLifeLedgerExport([event]);
  } catch (err) {
    rendererOk = false;
    rendererError = err.message;
  }
  assert.equal(rendererOk, valid, `renderer temporal-envelope mismatch for "${label}": ${rendererError}`);
}

test('meal_prepared core/renderer temporal envelope parity matrix', () => {
  const withoutTemporalPrecision = obsidianMealPreparedEvent();
  delete withoutTemporalPrecision.temporalPrecision;
  const withoutOccurredDate = obsidianMealPreparedEvent();
  delete withoutOccurredDate.occurredDate;
  [
    ['valid canonical date event', obsidianMealPreparedEvent(), true],
    ['valid implicit type-required date precision', withoutTemporalPrecision, true],
    ['invalid source timezone', obsidianMealPreparedEvent({ sourceTimezone: 'Not/AZone' }), false],
    ['invalid precision mismatch', obsidianMealPreparedEvent({ temporalPrecision: 'instant' }), false],
    ['invalid malformed precision', obsidianMealPreparedEvent({ temporalPrecision: 'calendar' }), false],
    ['invalid occurredAt presence', obsidianMealPreparedEvent({ occurredAt: '2026-08-30T00:00:00.000Z' }), false],
    ['invalid occurredAt null presence', obsidianMealPreparedEvent({ occurredAt: null }), false],
    ['missing occurredDate', withoutOccurredDate, false],
    ['malformed occurredDate', obsidianMealPreparedEvent({ occurredDate: 'August 30' }), false],
    ['impossible occurredDate', obsidianMealPreparedEvent({ occurredDate: '2026-02-30', payload: { ...obsidianMealPreparedEvent().payload, preparedDate: '2026-02-30' } }), false]
  ].forEach(([label, event, valid]) => assertTemporalEnvelopeParity(label, event, valid));
});

test('meal_consumed core/renderer temporal envelope parity matrix', () => {
  const withoutOccurredAt = obsidianMealConsumedEvent();
  delete withoutOccurredAt.occurredAt;
  [
    ['valid canonical instant event', obsidianMealConsumedEvent(), true],
    ['invalid source timezone', obsidianMealConsumedEvent({ sourceTimezone: 'Not/AZone' }), false],
    ['invalid precision mismatch', obsidianMealConsumedEvent({ temporalPrecision: 'date' }), false],
    ['invalid malformed precision', obsidianMealConsumedEvent({ temporalPrecision: 'calendar' }), false],
    ['invalid occurredDate presence', obsidianMealConsumedEvent({ occurredDate: '2026-08-30' }), false],
    ['invalid occurredDate null presence', obsidianMealConsumedEvent({ occurredDate: null }), false],
    ['missing occurredAt', withoutOccurredAt, false],
    ['malformed occurredAt', obsidianMealConsumedEvent({ occurredAt: 'not-a-date' }), false]
  ].forEach(([label, event, valid]) => assertTemporalEnvelopeParity(label, event, valid));
});
test('renderer renders a Meals section with both prepared and consumed lines, correctly formatted', () => {
  const content = dailyFile(buildObsidianLifeLedgerExport([obsidianMealPreparedEvent(), obsidianMealConsumedEvent()])).content;
  assert.ok(content.includes('## Meals'));
  assert.ok(content.includes('Prepared **Synthetic Chicken Bowls** · 3 portions — 2026-08-30'));
  assert.ok(content.includes('Ate **Synthetic Chicken Bowls** · 1 portion'));
});
test('renderer never fabricates a time-of-day (never 00:00) for a date-precision meal_prepared event', () => {
  const content = dailyFile(buildObsidianLifeLedgerExport([obsidianMealPreparedEvent()])).content;
  assert.equal(content.includes('00:00'), false);
});
test('renderer omits portions text when absent rather than fabricating a count', () => {
  const prepared = obsidianMealPreparedEvent({ payload: (() => {
    const { portionsPrepared, ...rest } = obsidianMealPreparedEvent().payload;
    return rest;
  })() });
  const content = dailyFile(buildObsidianLifeLedgerExport([prepared])).content;
  assert.ok(content.includes('Prepared **Synthetic Chicken Bowls** — 2026-08-30\n'));
  assert.equal(content.includes('portions'), false);
});
test('renderer rejects a malformed meal_prepared or meal_consumed payload instead of fabricating a line', () => {
  assert.throws(
    () => buildObsidianLifeLedgerExport([obsidianMealPreparedEvent({ payload: { ...obsidianMealPreparedEvent().payload, mealName: {} } })]),
    /Malformed meal_prepared payload/
  );
  assert.throws(
    () => buildObsidianLifeLedgerExport([obsidianMealConsumedEvent({ payload: { ...obsidianMealConsumedEvent().payload, portionCount: -1 } })]),
    /Malformed meal_consumed payload/
  );
});
test('renderer omits tombstoned events from active daily output', () => {
  const exportPlan = buildObsidianLifeLedgerExport([obsidianStepEvent({
    tombstone: { active: true, deletedAt: OBS_TIME.recorded, reason: 'user_delete', provenance: { sourceOperation: 'delete' } }
  })]);
  assert.equal(dailyFile(exportPlan), undefined);
});
test('renderer includes a restored event when tombstone is inactive again', () => {
  const exportPlan = buildObsidianLifeLedgerExport([obsidianStepEvent({ revision: 3, tombstone: { active: false, deletedAt: null, reason: null, provenance: null } })]);
  assert.ok(dailyFile(exportPlan).content.includes('Completed **Synthetic step**'));
});
test('renderer sorts events by occurredAt, type, and eventId', () => {
  const later = obsidianFocusEvent({ eventId: '30303030-3030-4030-8030-303030303030', occurredAt: '2026-08-30T17:25:00.000Z', payload: { ...obsidianFocusEvent().payload, activity: 'Later focus', startedAt: '2026-08-30T17:00:00.000Z', endedAt: '2026-08-30T17:25:00.000Z' } });
  const earlier = obsidianFocusEvent({ eventId: '40404040-4040-4040-8040-404040404040', occurredAt: '2026-08-30T15:25:00.000Z', payload: { ...obsidianFocusEvent().payload, activity: 'Earlier focus', startedAt: '2026-08-30T15:00:00.000Z', endedAt: '2026-08-30T15:25:00.000Z' } });
  const content = dailyFile(buildObsidianLifeLedgerExport([later, obsidianStepEvent(), earlier])).content;
  assert.ok(content.indexOf('Earlier focus') < content.indexOf('Later focus'));
  assert.ok(content.indexOf('Later focus') < content.indexOf('Synthetic step'));
});
test('renderer output is byte-identical for the same input', () => {
  const first = JSON.stringify(buildObsidianLifeLedgerExport([obsidianStepEvent(), obsidianFocusEvent()]));
  const second = JSON.stringify(buildObsidianLifeLedgerExport([obsidianStepEvent(), obsidianFocusEvent()]));
  assert.equal(first, second);
});
test('renderer partitions days using sourceTimezone', () => {
  const exportPlan = buildObsidianLifeLedgerExport([obsidianFocusEvent({
    sourceTimezone: 'Asia/Manila',
    occurredAt: '2026-08-30T16:25:00.000Z',
    payload: { ...obsidianFocusEvent().payload, startedAt: '2026-08-30T16:00:00.000Z', endedAt: '2026-08-30T16:25:00.000Z' }
  })]);
  assert.ok(dailyFile(exportPlan, '2026-08-31'));
});
test('renderer rejects a missing sourceTimezone instead of falling back to UTC', () => {
  assert.throws(
    () => buildObsidianLifeLedgerExport([obsidianFocusEvent({ sourceTimezone: '' })]),
    /sourceTimezone must be a valid IANA timezone/
  );
});
test('renderer escapes hostile Markdown and HTML-like titles', () => {
  const content = dailyFile(buildObsidianLifeLedgerExport([obsidianStepEvent({
    payload: {
      ...obsidianStepEvent().payload,
      stepLabel: '# Own heading\n<script>alert(`x`)</script> [link](bad)'
    }
  })])).content;
  assert.ok(content.includes('\\# Own heading / &lt;script&gt;alert\\(\\`x\\`\\)&lt;/script&gt; \\[link\\]\\(bad\\)'));
  assert.equal(content.includes('\n# Own heading'), false);
  assert.equal(content.includes('<script>'), false);
});
test('renderer does not fabricate missing optional learning context', () => {
  const content = dailyFile(buildObsidianLifeLedgerExport([obsidianStepEvent({ payload: { planDate: '2026-08-30', stepLabel: 'Bare step', completedAt: OBS_TIME.step } })])).content;
  assert.ok(content.includes('Completed **Bare step**'));
  assert.equal(content.includes('undefined'), false);
  assert.equal(content.includes(' / '), false);
});
test('renderer handles unknown event types explicitly', () => {
  // Every V1 Life Ledger event type (life-ledger-core.js's ALLOWED_EVENT_TYPES) is now
  // renderer-supported, including activity_logged — see the mixed-export test below. A
  // genuinely unrecognized type string (never a real V1 type) still fails closed.
  assert.throws(() => buildObsidianLifeLedgerExport([{ ...obsidianStepEvent(), type: 'some_future_event_type' }]), /Unsupported Life Ledger event type/);
  const skipped = buildObsidianLifeLedgerExport([{ ...obsidianStepEvent(), type: 'some_future_event_type' }], { unsupportedEventPolicy: 'skip' });
  assert.equal(skipped.skipped.length, 1);
});
test('renderer does not turn non-additive focus events into duplicate totals', () => {
  const content = dailyFile(buildObsidianLifeLedgerExport([obsidianFocusEvent()])).content;
  assert.equal((content.match(/25 min/g) || []).length, 1);
  assert.equal(/total/i.test(content), false);
});

// The reviewer's requested mixed Ledger: activity, focus, plan, workout, meal prepared,
// meal consumed, all in one export. This is the "compatibility plumbing" bar the
// architectural review set for activity_logged support — not the full Unified Life Feed.
test('a single export mixing activity_logged, focus, plan, workout, meal_prepared, and meal_consumed renders every section correctly', () => {
  const events = [
    obsidianActivityEvent(),
    obsidianFocusEvent(),
    obsidianStepEvent(),
    obsidianWorkoutEvent(),
    obsidianMealPreparedEvent(),
    obsidianMealConsumedEvent()
  ];
  events.forEach(event => assert.equal(validateLifeLedgerEvent(event).ok, true, event.type));

  const exportPlan = buildObsidianLifeLedgerExport(events);
  const content = dailyFile(exportPlan).content;
  assert.ok(content.includes('## Activity'));
  assert.ok(content.includes('## Focus'));
  assert.ok(content.includes('## Learning'));
  assert.ok(content.includes('## Workouts'));
  assert.ok(content.includes('## Meals'));
  assert.ok(content.includes('Synthetic deep work'));
  assert.ok(content.includes('Completed **Synthetic step**'));
  assert.ok(content.includes('Workout **Synthetic workout**'));
  assert.ok(content.includes('Prepared **Synthetic Chicken Bowls**'));
  assert.ok(content.includes('Ate **Synthetic Chicken Bowls**'));
  assert.equal(exportPlan.skipped.length, 0);
});

asyncTest('writer accepts an ordinary managed Daily path', async () => withTempVault(async root => {
  const resolved = await resolveObsidianLifeLedgerPath(root, 'Life Ledger/Daily/2026-08-30.md');
  assert.ok(resolved.destinationPath.endsWith(path.join('Life Ledger', 'Daily', '2026-08-30.md')));
}));
asyncTest('writer rejects ../ traversal paths', async () => withTempVault(async root => {
  await assert.rejects(() => resolveObsidianLifeLedgerPath(root, 'Life Ledger/../outside.md'), error => error.code === 'invalid_path');
}));
asyncTest('writer rejects absolute child paths', async () => withTempVault(async root => {
  await assert.rejects(() => resolveObsidianLifeLedgerPath(root, path.join(root, 'Life Ledger', 'Daily', '2026-08-30.md')), error => error.code === 'invalid_path');
}));
asyncTest('writer rejects drive-qualified child paths', async () => withTempVault(async root => {
  await assert.rejects(() => resolveObsidianLifeLedgerPath(root, 'C:\\tmp\\escape.md'), error => error.code === 'invalid_path');
}));
asyncTest('writer rejects UNC child paths', async () => withTempVault(async root => {
  await assert.rejects(() => resolveObsidianLifeLedgerPath(root, '\\\\server\\share\\escape.md'), error => error.code === 'invalid_path');
}));
asyncTest('writer rejects normalized escapes', async () => withTempVault(async root => {
  await assert.rejects(() => resolveObsidianLifeLedgerPath(root, 'Life Ledger/Daily/../../outside.md'), error => error.code === 'invalid_path');
}));
asyncTest('writer rejects symlink or junction escapes when supported', async () => withTempVault(async root => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'chronasense-life-ledger-outside-'));
  try {
    await fs.mkdir(path.join(root, 'Life Ledger', 'Daily'), { recursive: true });
    await fs.rm(path.join(root, 'Life Ledger', 'Daily'), { recursive: true, force: true });
    try {
      await fs.symlink(outside, path.join(root, 'Life Ledger', 'Daily'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (['EPERM', 'EACCES'].includes(err?.code)) return;
      throw err;
    }
    await assert.rejects(() => resolveObsidianLifeLedgerPath(root, 'Life Ledger/Daily/2026-08-30.md'), error => error.code === 'link_escape');
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
}));
asyncTest('writer rejects parent link escapes with injected filesystem', async () => {
  const root = 'C:\\SafeVault';
  const dailyRoot = path.join(root, 'Life Ledger', 'Daily');
  const { adapter } = createMockObsidianFs({
    dirs: [root, path.join(root, 'Life Ledger')],
    links: [dailyRoot]
  });
  await assert.rejects(() => resolveObsidianLifeLedgerPath(root, 'Life Ledger/Daily/2026-08-30.md', { fs: adapter }), error => error.code === 'link_escape');
});
asyncTest('writer rejects an existing Daily target link before reading it', async () => {
  const root = 'C:\\SafeVault';
  const target = path.join(root, 'Life Ledger', 'Daily', '2026-08-30.md');
  const { adapter, calls } = createMockObsidianFs({
    dirs: [root, path.join(root, 'Life Ledger'), path.join(root, 'Life Ledger', 'Daily')],
    links: [target]
  });
  await assert.rejects(() => writeObsidianLifeLedgerExport([{
    relativePath: 'Life Ledger/Daily/2026-08-30.md',
    content: `${OBSIDIAN_LIFE_LEDGER_SENTINEL}\n# Generated\n`
  }], { vaultRoot: root, fs: adapter }), error => error.code === 'link_escape');
  assert.equal(calls.readFile.includes(path.resolve(target)), false);
});
asyncTest('writer rejects an existing System target link before reading it', async () => {
  const root = 'C:\\SafeVault';
  const target = path.join(root, 'Life Ledger', 'System', 'README.md');
  const { adapter, calls } = createMockObsidianFs({
    dirs: [root, path.join(root, 'Life Ledger'), path.join(root, 'Life Ledger', 'System')],
    links: [target]
  });
  await assert.rejects(() => writeObsidianLifeLedgerExport([{
    relativePath: 'Life Ledger/System/README.md',
    content: `${OBSIDIAN_LIFE_LEDGER_SENTINEL}\n# Generated\n`
  }], { vaultRoot: root, fs: adapter }), error => error.code === 'link_escape');
  assert.equal(calls.readFile.includes(path.resolve(target)), false);
});
asyncTest('writer rejects stale Daily target links without reading or deleting them', async () => {
  const root = 'C:\\SafeVault';
  const dailyRoot = path.join(root, 'Life Ledger', 'Daily');
  const target = path.join(dailyRoot, '2026-08-30.md');
  const { adapter, calls, linkSet } = createMockObsidianFs({
    dirs: [root, path.join(root, 'Life Ledger'), dailyRoot],
    links: [target],
    readdir: { [dailyRoot]: ['2026-08-30.md'] }
  });
  await assert.rejects(() => writeObsidianLifeLedgerExport([], { vaultRoot: root, fs: adapter }), error => error.code === 'link_escape');
  assert.equal(calls.readFile.includes(path.resolve(target)), false);
  assert.equal(calls.unlink.includes(path.resolve(target)), false);
  assert.equal(linkSet.has(path.resolve(target)), true);
});
asyncTest('writer keeps hostile titles out of output paths', async () => withTempVault(async root => {
  const exportPlan = buildObsidianLifeLedgerExport([obsidianStepEvent({ payload: { ...obsidianStepEvent().payload, stepLabel: '../escape' } })]);
  assert.deepEqual(exportPlan.files.map(file => file.relativePath).sort(), ['Life Ledger/Daily/2026-08-30.md', 'Life Ledger/System/README.md']);
  await writeObsidianLifeLedgerExport(exportPlan.files, { vaultRoot: root });
  assert.equal(await pathExists(path.join(root, 'escape')), false);
}));
asyncTest('writer denies the production OneDrive vault root for this slice', async () => {
  await assert.rejects(() => resolveObsidianLifeLedgerPath('C:\\Users\\Admin\\OneDrive\\2nd Brain', 'Life Ledger/Daily/2026-08-30.md'), error => error.code === 'denied_vault_root');
});
asyncTest('writer denies child vaults under the production OneDrive root', async () => {
  await assert.rejects(() => resolveObsidianLifeLedgerPath('C:\\Users\\Admin\\OneDrive\\2nd Brain\\SubVault', 'Life Ledger/Daily/2026-08-30.md'), error => error.code === 'denied_vault_root');
});
asyncTest('writer denies aliases that resolve beneath the production OneDrive root', async () => {
  const aliasRoot = 'C:\\SafeAliasVault';
  const { adapter } = createMockObsidianFs({
    dirs: [aliasRoot],
    realpaths: { [aliasRoot]: 'C:\\Users\\Admin\\OneDrive\\2nd Brain\\SubVault' }
  });
  await assert.rejects(() => resolveObsidianLifeLedgerPath(aliasRoot, 'Life Ledger/Daily/2026-08-30.md', { fs: adapter }), error => error.code === 'denied_vault_root');
});
asyncTest('writer denies the stale Desktop vault root for this slice', async () => {
  await assert.rejects(() => resolveObsidianLifeLedgerPath('C:\\Users\\Admin\\Desktop\\2nd Brain', 'Life Ledger/Daily/2026-08-30.md'), error => error.code === 'denied_vault_root');
});
asyncTest('writer denies child vaults under the stale Desktop root', async () => {
  await assert.rejects(() => resolveObsidianLifeLedgerPath('C:\\Users\\Admin\\Desktop\\2nd Brain\\Anything', 'Life Ledger/Daily/2026-08-30.md'), error => error.code === 'denied_vault_root');
});
asyncTest('writer allows the OneDrive prefix-lookalike backup vault', async () => {
  const root = 'C:\\Users\\Admin\\OneDrive\\2nd Brain Backup';
  const { adapter } = createMockObsidianFs({
    dirs: [root, path.join(root, 'Life Ledger'), path.join(root, 'Life Ledger', 'Daily')]
  });
  const resolved = await resolveObsidianLifeLedgerPath(root, 'Life Ledger/Daily/2026-08-30.md', { fs: adapter });
  assert.equal(resolved.relativePath, 'Life Ledger/Daily/2026-08-30.md');
  assert.ok(resolved.destinationPath.endsWith(path.join('2nd Brain Backup', 'Life Ledger', 'Daily', '2026-08-30.md')));
});
asyncTest('writer first export writes expected files', async () => withTempVault(async root => {
  const result = await writeObsidianLifeLedgerExport(buildObsidianLifeLedgerExport([obsidianFocusEvent(), obsidianStepEvent()]).files, { vaultRoot: root });
  assert.deepEqual(result.written.map(item => item.relativePath).sort(), ['Life Ledger/Daily/2026-08-30.md', 'Life Ledger/System/README.md']);
  assert.ok((await fs.readFile(path.join(root, 'Life Ledger', 'Daily', '2026-08-30.md'), 'utf8')).includes('Synthetic focus'));
}));
asyncTest('writer identical second export writes nothing', async () => withTempVault(async root => {
  const plan = buildObsidianLifeLedgerExport([obsidianFocusEvent(), obsidianStepEvent()]).files;
  await writeObsidianLifeLedgerExport(plan, { vaultRoot: root });
  const second = await writeObsidianLifeLedgerExport(plan, { vaultRoot: root });
  assert.equal(second.written.length, 0);
  assert.equal(second.deleted.length, 0);
  assert.equal(second.skipped.length, 2);
}));
asyncTest('writer replaces ordinary generated Daily files safely', async () => withTempVault(async root => {
  const firstPlan = buildObsidianLifeLedgerExport([obsidianStepEvent()]).files;
  const secondPlan = buildObsidianLifeLedgerExport([obsidianStepEvent({
    revision: 2,
    payload: { ...obsidianStepEvent().payload, stepLabel: 'Updated synthetic step' }
  })]).files;
  await writeObsidianLifeLedgerExport(firstPlan, { vaultRoot: root });
  const result = await writeObsidianLifeLedgerExport(secondPlan, { vaultRoot: root });
  const dailyReplace = result.written.find(item => item.relativePath === 'Life Ledger/Daily/2026-08-30.md');
  assert.equal(dailyReplace.action, 'replace');
  assert.ok((await fs.readFile(path.join(root, 'Life Ledger', 'Daily', '2026-08-30.md'), 'utf8')).includes('Updated synthetic step'));
}));
asyncTest('writer never overwrites an existing unmanaged target file', async () => withTempVault(async root => {
  const target = path.join(root, 'Life Ledger', 'Daily', '2026-08-30.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '# Human note\n', 'utf8');
  const result = await writeObsidianLifeLedgerExport(buildObsidianLifeLedgerExport([obsidianStepEvent()]).files, { vaultRoot: root });
  assert.equal(result.conflicts.length, 1);
  assert.equal(await fs.readFile(target, 'utf8'), '# Human note\n');
}));
asyncTest('writer may remove stale generated Daily files', async () => withTempVault(async root => {
  const plan = buildObsidianLifeLedgerExport([obsidianStepEvent()]).files;
  await writeObsidianLifeLedgerExport(plan, { vaultRoot: root });
  const empty = await writeObsidianLifeLedgerExport(buildObsidianLifeLedgerExport([]).files, { vaultRoot: root });
  assert.deepEqual(empty.deleted.map(item => item.relativePath), ['Life Ledger/Daily/2026-08-30.md']);
  assert.equal(await pathExists(path.join(root, 'Life Ledger', 'Daily', '2026-08-30.md')), false);
}));
asyncTest('writer preserves stale unmarked Daily files and surfaces conflict', async () => withTempVault(async root => {
  const target = path.join(root, 'Life Ledger', 'Daily', '2026-08-29.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '# Manual daily note\n', 'utf8');
  const result = await writeObsidianLifeLedgerExport(buildObsidianLifeLedgerExport([]).files, { vaultRoot: root });
  assert.deepEqual(result.conflicts.map(item => item.reason), ['stale_daily_missing_generated_sentinel']);
  assert.equal(await fs.readFile(target, 'utf8'), '# Manual daily note\n');
}));
asyncTest('writer failure does not leave a partial final output', async () => withTempVault(async root => {
  const adapter = {
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    rename: fs.rename,
    unlink: fs.unlink,
    readdir: fs.readdir,
    lstat: fs.lstat,
    realpath: fs.realpath,
    writeFile() {
      throw new Error('synthetic write failure');
    }
  };
  await assert.rejects(() => writeObsidianLifeLedgerExport(buildObsidianLifeLedgerExport([obsidianStepEvent()]).files, { vaultRoot: root, fs: adapter }), /synthetic write failure/);
  assert.equal(await pathExists(path.join(root, 'Life Ledger', 'Daily', '2026-08-30.md')), false);
}));
asyncTest('writer only touches the managed Life Ledger subtree', async () => withTempVault(async root => {
  await assert.rejects(() => writeObsidianLifeLedgerExport([{ relativePath: '../outside.md', content: 'bad' }], { vaultRoot: root }), error => error.code === 'invalid_path');
  assert.equal(await pathExists(path.join(root, 'outside.md')), false);
}));
asyncTest('writer removes false generated history after a tombstone rebuild', async () => withTempVault(async root => {
  await writeObsidianLifeLedgerExport(buildObsidianLifeLedgerExport([obsidianStepEvent()]).files, { vaultRoot: root });
  const tombstoned = obsidianStepEvent({
    tombstone: { active: true, deletedAt: OBS_TIME.recorded, reason: 'user_delete', provenance: { sourceOperation: 'delete' } }
  });
  const result = await writeObsidianLifeLedgerExport(buildObsidianLifeLedgerExport([tombstoned]).files, { vaultRoot: root });
  assert.deepEqual(result.deleted.map(item => item.relativePath), ['Life Ledger/Daily/2026-08-30.md']);
}));
asyncTest('writer restores generated history after a restored completion rebuild', async () => withTempVault(async root => {
  const tombstoned = obsidianStepEvent({
    tombstone: { active: true, deletedAt: OBS_TIME.recorded, reason: 'user_delete', provenance: { sourceOperation: 'delete' } }
  });
  await writeObsidianLifeLedgerExport(buildObsidianLifeLedgerExport([tombstoned]).files, { vaultRoot: root });
  await writeObsidianLifeLedgerExport(buildObsidianLifeLedgerExport([obsidianStepEvent({ revision: 3 })]).files, { vaultRoot: root });
  assert.ok((await fs.readFile(path.join(root, 'Life Ledger', 'Daily', '2026-08-30.md'), 'utf8')).includes('Synthetic step'));
}));

await Promise.all(asyncTests);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
