// node attention-signals.test.js
//
// Phase 11.8 "Minimal Distraction Signals" — deterministic regression tests.
//
// Every case uses a hand-built synthetic timeline so the expected numbers can
// be reasoned about by hand. The two load-bearing proofs the roadmap calls for:
//   • related work-tool switching is NOT automatically "distracted"  (case 2)
//   • real sustained drift DOES create an attention break            (case 4)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveAttentionSignals,
  attentionSignalLines,
  ATTENTION_SIGNALS_CONFIG
} from './attention-signals.js';

const M = 60000;
const T0 = Date.UTC(2026, 8, 5, 9, 0, 0); // 2026-09-05 09:00:00 UTC

/** block starting `offMin` minutes after T0, lasting `durMin`. */
function blk(offMin, durMin, energy, activity = 'task', extra = {}) {
  return {
    tsStart: T0 + offMin * M,
    ts: T0 + (offMin + durMin) * M,
    blockIntervalMin: durMin,
    energy,
    activity,
    ...extra
  };
}

// ── Case 1 — long single-task focus block ──────────────────────────────────
test('long single-task focus block: one stretch, no breaks', () => {
  const s = deriveAttentionSignals([blk(0, 90, 'deep', 'Write chapter')]);
  assert.equal(s.hasData, true);
  assert.equal(s.coherentStretchCount, 1);
  assert.equal(s.longestStretchMin, 90);
  assert.equal(s.attentionBreaks, 0);
  assert.equal(s.recoveries, 0);
  assert.equal(s.likelyDistractionMin, null);
});

// ── Case 2 — rapid switches among RELATED work tools ───────────────────────
test('related-tool switching is one coherent stretch, not distraction', () => {
  const s = deriveAttentionSignals([
    blk(0, 12, 'deep', 'VS Code'),
    blk(12, 12, 'deep', 'Claude'),
    blk(24, 12, 'deep', 'GitHub'),
    blk(36, 12, 'deep', 'docs'),
    blk(48, 12, 'deep', 'VS Code')
  ]);
  assert.equal(s.coherentStretchCount, 1);
  assert.equal(s.longestStretchMin, 60);
  assert.equal(s.attentionBreaks, 0);
  assert.equal(s.likelyDistractionMin, null);
});

// ── Case 3 — brief unrelated switch BELOW the debounce threshold ───────────
test('sub-debounce distraction is a dip, not a break', () => {
  const s = deriveAttentionSignals([
    blk(0, 30, 'deep', 'Design'),
    blk(30, 6, 'waste', 'Twitter'),
    blk(36, 30, 'deep', 'Design')
  ]);
  assert.equal(s.attentionBreaks, 0);
  assert.equal(s.coherentStretchCount, 1);
  assert.equal(s.longestStretchMin, 66);
  assert.equal(s.stretches[0].distractionDipMin, 6);
  // 6 min of distraction is below distractionSupportMin → number withheld.
  assert.equal(s.likelyDistractionMin, null);
  assert.equal(s.meta.totalDistractionMinRaw, 6);
});

// ── Case 4 — sustained distracting context ─────────────────────────────────
test('sustained drift creates exactly one attention break', () => {
  const s = deriveAttentionSignals([
    blk(0, 20, 'deep', 'Report'),
    blk(20, 40, 'waste', 'YouTube')
  ]);
  assert.equal(s.attentionBreaks, 1);
  assert.equal(s.breaks[0].reason, 'distraction');
  assert.equal(s.coherentStretchCount, 1);
  assert.equal(s.longestStretchMin, 20);
  assert.equal(s.likelyDistractionMin, 40);
});

// ── Case 5 — drift → recovery ─────────────────────────────────────────────
test('drift then return to focus is a recovery', () => {
  const s = deriveAttentionSignals([
    blk(0, 20, 'deep', 'Report'),
    blk(20, 20, 'waste', 'Reddit'),
    blk(40, 25, 'deep', 'Report')
  ]);
  assert.equal(s.attentionBreaks, 1);
  assert.equal(s.recoveries, 1);
  assert.equal(s.coherentStretchCount, 2);
  assert.equal(s.medianRecoveryMin, null); // needs >= 2 recoveries
});

test('median recovery time reported once there are two or more recoveries', () => {
  const s = deriveAttentionSignals([
    blk(0, 20, 'deep', 'A'), blk(20, 15, 'waste', 'x'), blk(35, 10, 'deep', 'A'),   // recover gap 15
    blk(45, 20, 'deep', 'A'), blk(65, 15, 'waste', 'x'), blk(105, 15, 'deep', 'A'), // idle+dist; recover gap 25
    blk(120, 20, 'deep', 'A'), blk(140, 15, 'waste', 'x'), blk(160, 15, 'deep', 'A')// recover gap 20
  ]);
  assert.ok(s.recoveries >= 2);
  assert.equal(typeof s.medianRecoveryMin, 'number');
});

// ── Case 6 — idle / gap handling ─────────────────────────────────────────
test('idle gap at or above threshold ends the stretch and is a break', () => {
  const s = deriveAttentionSignals([
    blk(0, 20, 'deep', 'A'),
    blk(50, 20, 'deep', 'A') // 30-min untracked gap
  ]);
  assert.equal(s.attentionBreaks, 1);
  assert.equal(s.breaks[0].reason, 'idle');
  assert.equal(s.recoveries, 1);
});

test('short gap below threshold keeps a single stretch', () => {
  const s = deriveAttentionSignals([
    blk(0, 20, 'deep', 'A'),
    blk(40, 20, 'deep', 'A') // 20-min gap, under idleGapMin (25)
  ]);
  assert.equal(s.attentionBreaks, 0);
  assert.equal(s.coherentStretchCount, 1);
  assert.equal(s.longestStretchMin, 60); // gap time is inside the stretch span
});

// ── Case 7 — no usable activity data ─────────────────────────────────────
test('no data: everything zeroed and no render lines', () => {
  for (const input of [[], null, undefined, [{ missed: true }, { deleted: true, ts: T0 }]]) {
    const s = deriveAttentionSignals(input);
    assert.equal(s.hasData, false);
    assert.equal(s.longestStretchMin, 0);
    assert.equal(s.attentionBreaks, 0);
    assert.equal(s.recoveries, 0);
    assert.equal(s.likelyDistractionMin, null);
    assert.deepEqual(attentionSignalLines(s), []);
  }
});

// ── Case 8 — mixed manual + automatic data ───────────────────────────────
test('manual and browser-extension entries derive together', () => {
  const s = deriveAttentionSignals([
    blk(0, 30, 'deep', 'Spec'),
    blk(30, 20, 'waste', 'YouTube', { source: 'browser-extension', browserUsage: true }),
    blk(50, 20, 'deep', 'Spec')
  ]);
  assert.equal(s.attentionBreaks, 1);
  assert.equal(s.recoveries, 1);
  assert.equal(s.likelyDistractionMin, 20);
  assert.equal(s.segments[1].source, 'browser-extension');
});

// ── Case 9 — Focus Mode session shape ───────────────────────────────────
test('a Focus Mode deep entry counts as a coherent stretch', () => {
  // logFocusSession() writes: energy 'deep', onPlan true, retro false.
  const s = deriveAttentionSignals([
    { tsStart: T0, ts: T0 + 45 * M, blockIntervalMin: 45, energy: 'deep', activity: 'Write RFC', onPlan: true, retro: false }
  ]);
  assert.equal(s.coherentStretchCount, 1);
  assert.equal(s.longestStretchMin, 45);
});

// ── Case 10 — day boundary / timestamp-only entries ─────────────────────
test('entry with only ts + duration still yields a window', () => {
  const s = deriveAttentionSignals([
    { ts: T0 + 40 * M, blockIntervalMin: 40, energy: 'deep', activity: 'A' }
  ]);
  assert.equal(s.hasData, true);
  assert.equal(s.longestStretchMin, 40);
});

test('the module does not filter by day — the caller owns the date window', () => {
  const s = deriveAttentionSignals([
    blk(0, 30, 'deep', 'A'),
    blk(24 * 60, 30, 'deep', 'A') // next calendar day
  ]);
  // Huge idle gap between them → the second is its own stretch, first breaks on idle.
  assert.equal(s.coherentStretchCount, 2);
  assert.equal(s.attentionBreaks, 1);
});

// ── Context shift vs. attention break ───────────────────────────────────
test('sustained neutral time ends the stretch WITHOUT counting as a break', () => {
  const s = deriveAttentionSignals([
    blk(0, 20, 'deep', 'A'),
    blk(20, 35, 'shallow', 'Email')
  ]);
  assert.equal(s.coherentStretchCount, 1);
  assert.equal(s.stretches[0].endReason, 'context-shift');
  assert.equal(s.longestStretchMin, 20); // trailing neutral trimmed
  assert.equal(s.attentionBreaks, 0);
});

test('a short neutral block bridges two focus runs into one stretch', () => {
  const s = deriveAttentionSignals([
    blk(0, 20, 'deep', 'A'),
    blk(20, 15, 'shallow', 'Slack'),
    blk(35, 20, 'deep', 'A')
  ]);
  assert.equal(s.coherentStretchCount, 1);
  assert.equal(s.longestStretchMin, 55);
  assert.equal(s.attentionBreaks, 0);
});

// ── Debounce boundary ─────────────────────────────────────────────────
test('distraction exactly at the debounce threshold breaks; just under does not', () => {
  const at = deriveAttentionSignals([blk(0, 20, 'deep', 'A'), blk(20, 10, 'waste', 'x'), blk(30, 20, 'deep', 'A')]);
  assert.equal(at.attentionBreaks, 1);

  const under = deriveAttentionSignals([blk(0, 20, 'deep', 'A'), blk(20, 9, 'waste', 'x'), blk(29, 20, 'deep', 'A')]);
  assert.equal(under.attentionBreaks, 0);
  assert.equal(under.coherentStretchCount, 1);
});

// ── minStretchMin gate ────────────────────────────────────────────────
test('a budding run below minStretchMin produces no stretch and no break', () => {
  const s = deriveAttentionSignals([
    blk(0, 8, 'deep', 'A'),
    blk(8, 30, 'waste', 'x'),
    blk(38, 8, 'deep', 'A')
  ]);
  assert.equal(s.coherentStretchCount, 0);
  assert.equal(s.attentionBreaks, 0);
  assert.equal(s.recoveries, 0);
});

// ── Plan-task membership upgrades a neutral entry to focus ─────────────
test('an entry matching a Today Plan task is treated as focus', () => {
  const plain = deriveAttentionSignals([blk(0, 30, 'shallow', 'Write report')]);
  assert.equal(plain.coherentStretchCount, 0);

  const planned = deriveAttentionSignals([blk(0, 30, 'shallow', 'Write report')], {
    planTasks: ['Write report']
  });
  assert.equal(planned.coherentStretchCount, 1);
  assert.equal(planned.longestStretchMin, 30);
});

// ── Self-rating echo ─────────────────────────────────────────────────
test('self rating is echoed but never fuses into the automatic numbers', () => {
  const base = deriveAttentionSignals([blk(0, 40, 'deep', 'A'), blk(40, 30, 'waste', 'x')]);
  const rated = deriveAttentionSignals([blk(0, 40, 'deep', 'A'), blk(40, 30, 'waste', 'x')], {
    selfRating: 'distracted'
  });
  assert.equal(rated.selfRating, 'distracted');
  assert.equal(rated.longestStretchMin, base.longestStretchMin);
  assert.equal(rated.attentionBreaks, base.attentionBreaks);
  assert.equal(rated.likelyDistractionMin, base.likelyDistractionMin);

  const bad = deriveAttentionSignals([blk(0, 40, 'deep', 'A')], { selfRating: 'super-focused' });
  assert.equal(bad.selfRating, null);
});

// ── attentionSignalLines: only supported metrics are shown ────────────
test('render lines withhold unsupported metrics (progressive disclosure)', () => {
  const clean = deriveAttentionSignals([blk(0, 50, 'deep', 'A')]);
  const keys = attentionSignalLines(clean).map(l => l.key);
  assert.deepEqual(keys, ['longest', 'breaks']); // no distraction, no recovery, no rating

  const messy = deriveAttentionSignals(
    [blk(0, 30, 'deep', 'A'), blk(30, 25, 'waste', 'x'), blk(55, 30, 'deep', 'A')],
    { selfRating: 'mixed' }
  );
  const messyLines = attentionSignalLines(messy);
  const byKey = Object.fromEntries(messyLines.map(l => [l.key, l.value]));
  assert.equal(byKey.longest, '30 min');
  assert.equal(byKey.distraction, '~25 min');
  assert.equal(byKey.recovery, '1');
  assert.equal(byKey.rating, 'Mixed');
});

// ── Coherent-stretch display: span vs. actual focused minutes ────────
test('the longest-stretch line shows span AND focused minutes when they differ', () => {
  // Review's adversarial case: 10 focus / 29 neutral / 10 focus.
  const s = deriveAttentionSignals([
    blk(0, 10, 'deep', 'A'),
    blk(10, 29, 'shallow', 'Email'),
    blk(39, 10, 'deep', 'A')
  ]);
  assert.equal(s.coherentStretchCount, 1);
  assert.equal(s.meta.longestStretch.durationMin, 49);
  assert.equal(s.meta.longestStretch.focusMin, 20);
  assert.equal(s.longestStretchMin, 49);

  const line = attentionSignalLines(s).find(l => l.key === 'longest');
  assert.equal(line.value, '49 min span · 20 min focused');
  // Must be impossible to read the span as pure focus.
  assert.ok(/span/.test(line.value) && /focused/.test(line.value));
  assert.ok(line.value.includes('49') && line.value.includes('20'));
});

test('the longest-stretch line stays concise when the whole span is focus', () => {
  const s = deriveAttentionSignals([blk(0, 47, 'deep', 'A')]);
  const line = attentionSignalLines(s).find(l => l.key === 'longest');
  assert.equal(line.value, '47 min');
});

// ── Determinism + input immutability ─────────────────────────────────
test('same input yields deeply-equal output', () => {
  const input = [
    blk(0, 25, 'deep', 'A'), blk(25, 15, 'waste', 'x'),
    blk(40, 20, 'deep', 'A'), blk(90, 20, 'deep', 'A')
  ];
  const a = deriveAttentionSignals(input, { planTasks: ['A'], dateKey: '2026-09-05' });
  const b = deriveAttentionSignals(input, { planTasks: ['A'], dateKey: '2026-09-05' });
  assert.deepEqual(a, b);
});

test('input entries array is not mutated', () => {
  const input = Object.freeze([
    Object.freeze(blk(0, 30, 'deep', 'A')),
    Object.freeze(blk(30, 30, 'waste', 'x'))
  ]);
  const before = JSON.stringify(input);
  deriveAttentionSignals(input);
  assert.equal(JSON.stringify(input), before);
});

// ── Overlapping entries are clipped, not double-counted ──────────────
test('overlapping entries are clipped to a monotonic timeline', () => {
  const s = deriveAttentionSignals([
    { tsStart: T0, ts: T0 + 40 * M, blockIntervalMin: 40, energy: 'deep', activity: 'A' },
    { tsStart: T0 + 20 * M, ts: T0 + 60 * M, blockIntervalMin: 40, energy: 'deep', activity: 'B' }
  ]);
  assert.equal(s.coherentStretchCount, 1);
  assert.equal(s.longestStretchMin, 60); // T0 .. T0+60, not 80
});

// ── Config is echoed and overridable ────────────────────────────────
test('config overrides flow through and are echoed', () => {
  const s = deriveAttentionSignals([blk(0, 20, 'deep', 'A'), blk(20, 8, 'waste', 'x'), blk(28, 20, 'deep', 'A')], {
    config: { debounceMin: 5 }
  });
  assert.equal(s.config.debounceMin, 5);
  assert.equal(s.attentionBreaks, 1); // 8-min waste now exceeds the lowered debounce
  assert.equal(ATTENTION_SIGNALS_CONFIG.debounceMin, 10); // frozen default untouched
});
