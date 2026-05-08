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

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
