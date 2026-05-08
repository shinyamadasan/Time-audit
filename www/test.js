// node test.js
import assert from 'node:assert/strict';

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

function computeDeepHrs(arr, intervalMin = 30) {
  return +(arr.filter(e => e.energy === 'deep').length * (intervalMin / 60)).toFixed(1);
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

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
