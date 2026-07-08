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

function sumEntryMinutes(entriesArr, predicate, intervalMin = 30) {
  const byDate = new Map();
  let fallbackTotal = 0;
  entriesArr.forEach(entry => {
    if (!entry || entry.deleted || entry.missed) return;
    if (predicate && !predicate(entry)) return;
    if (!entry.ts) {
      fallbackTotal += testEntryDurationMinutes(entry, intervalMin);
      return;
    }
    const end = entry.ts;
    const start = entry.tsStart || end - testEntryDurationMinutes(entry, intervalMin) * 60000;
    if (end <= start) return;
    const dateKey = new Date(start).toISOString().slice(0, 10);
    const dayStart = Date.parse(dateKey + 'T00:00:00.000Z');
    const dayEnd = Date.parse(testDateKeyPlusDays(dateKey, 1) + 'T00:00:00.000Z');
    const clipped = { start: Math.max(start, dayStart), end: Math.min(end, dayEnd) };
    if (clipped.end <= clipped.start) return;
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push(clipped);
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
  return fallbackTotal + Math.round(totalMs / 60000);
}

function computeDeepHrs(arr, intervalMin = 30) {
  return +(sumEntryMinutes(arr, e => e.energy === 'deep', intervalMin) / 60).toFixed(1);
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
test('single deep entry is clipped to its start calendar day', () => {
  const arr = [
    {energy:'deep', tsStart: Date.UTC(2026, 0, 5, 0), ts: Date.UTC(2026, 0, 6, 4)},
  ];
  assert.equal(computeDeepHrs(arr), 24.0);
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
  let group = { ...clipped[0], _mergedIds: null };
  for (let i = 1; i < clipped.length; i++) {
    const e = clipped[i];
    const gap = (group.tsStart || group.ts) - e.ts;
    const sameKind = e.activity === group.activity && e.energy === group.energy;
    if (sameKind && gap >= 0 && gap <= MAX_GAP_MS) {
      if (!group._mergedIds) group._mergedIds = [group.id];
      group._mergedIds.push(e.id);
      group.tsStart = e.tsStart || e.ts;
      group.blockIntervalMin = Math.round(((group.tsStart || group.ts) - (e.tsStart || e.ts)) / 60000) ||
        (group.blockIntervalMin || 1);
    } else {
      out.push(group);
      group = { ...e, _mergedIds: null };
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
