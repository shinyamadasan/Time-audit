// ══════════════════════════════════════════════════════
// attention-signals.js — Phase 11.8 "Minimal Distraction Signals"
//
// Derives a small, mostly-automatic attention-awareness layer from the
// activity/context data ChronaSense ALREADY captures (the `entries` array).
//
// Principles (see planning/ROADMAP.md Phase 11.8, CODEMAP.md):
//   • Pure and deterministic. No DOM, no `Date.now()`, no mutation of inputs,
//     no network, no ML, no AI. Same input → same output, always.
//   • Automatic behaviour data is NOT guaranteed mental attention. Outputs use
//     hedged language ("coherent focus", "likely distraction", "attention
//     break", "recovered") and never claim exact cognitive measurement.
//   • Explainable: every number is accompanied by supporting metadata
//     (segments, stretches, breaks) so the computation can be inspected.
//   • Phase 12 may INTERPRET these signals later; it must not silently change
//     how they are calculated.
//
// Related work-tool switching (VS Code → Claude → GitHub → docs → VS Code) is
// NOT treated as distraction: segments are classified by the entry's own
// energy label / plan membership, not by app or window, so a run of blocks
// that are all "deep" (or all the same plan task) stays ONE coherent stretch.
// A stretch ends only when the evidence meaningfully indicates drift: a
// sustained distracting context, a long idle gap, or a sustained task change.
// ══════════════════════════════════════════════════════

export const ATTENTION_SIGNALS_VERSION = 1;

/**
 * Deterministic thresholds. Exact semantics:
 *  - debounceMin:         a distracting segment shorter than this is a
 *                         within-stretch DIP (counted toward "likely
 *                         distraction" minutes) — it does not end the stretch
 *                         and does not create an attention break. This is the
 *                         "avoid double-counting rapid noise" rule.
 *  - idleGapMin:          an untracked gap of at least this many minutes
 *                         between logged segments ends the current stretch and
 *                         counts as an attention break (reason: "idle").
 *  - contextShiftMin:     an unbroken run of non-focus ("neutral") logged time
 *                         of at least this length ends the current stretch
 *                         (reason: "context-shift"). This is NOT counted as an
 *                         attention break — it is a task change, not drift.
 *  - minStretchMin:       a focused run must accumulate at least this much
 *                         focus time to count as a "coherent stretch" and to
 *                         be breakable. Prevents trivial blips from producing
 *                         stretches (and therefore breaks).
 *  - recoveryWindowMin:   after a break, if a new coherent stretch begins
 *                         within this many minutes it counts as a recovery.
 *  - distractionSupportMin: minimum total classified distraction minutes
 *                         before the "~N min" likely-distraction number is
 *                         surfaced at all. Below this the metric is withheld
 *                         (returned as null) rather than forced.
 */
export const ATTENTION_SIGNALS_CONFIG = Object.freeze({
  debounceMin: 10,
  idleGapMin: 25,
  contextShiftMin: 30,
  minStretchMin: 10,
  recoveryWindowMin: 60,
  distractionSupportMin: 15
});

// Energy labels that count as focused, meaningful work.
const FOCUS_ENERGIES = new Set(['deep', 'learning']);
// Energy labels that are an explicit distraction / waste classification.
const DISTRACTION_ENERGIES = new Set(['waste', 'distraction']);
// Everything else real (shallow, nine5, errands, exercise, recovery, social,
// admin) is "neutral": legitimate time, but not focused work and not drift.

const VALID_RATINGS = new Set(['focused', 'mixed', 'distracted']);

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeActivityKey(activity) {
  return String(activity || '')
    .split(' (Output:')[0]
    .trim()
    .toLowerCase();
}

function median(sortedNumbers) {
  const n = sortedNumbers.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedNumbers[mid] : (sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2;
}

/**
 * Turn a raw entry into a `{ start, end }` window in epoch ms, or null if the
 * entry carries no usable time span. Prefers explicit tsStart/ts; falls back
 * to ts minus blockIntervalMin when only an end + duration are known.
 */
function entryWindow(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.missed || entry.deleted || entry.break || entry.away) return null;

  const end = toFiniteNumber(entry.ts);
  let start = toFiniteNumber(entry.tsStart);
  const durMin = toFiniteNumber(entry.blockIntervalMin);

  if (start == null && end != null && durMin != null && durMin > 0) {
    start = end - durMin * 60000;
  }
  if (start == null || end == null) return null;
  if (end <= start) return null;
  return { start, end };
}

function classifyEntry(entry, planKeySet) {
  const energy = String(entry.energy || '').toLowerCase();
  if (DISTRACTION_ENERGIES.has(energy)) return 'distraction';
  if (FOCUS_ENERGIES.has(energy)) return 'focus';
  if (planKeySet && planKeySet.size) {
    const key = normalizeActivityKey(entry.activity);
    if (key && planKeySet.has(key)) return 'focus';
  }
  return 'neutral';
}

/**
 * Build the ordered, non-overlapping segment list the derivation walks.
 * Overlaps are clipped (later segment loses the overlapped head) so a
 * mis-entered or auto-synced block can't corrupt the timeline.
 */
function buildSegments(entries, planKeySet) {
  const raw = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const win = entryWindow(entry);
    if (!win) continue;
    raw.push({
      start: win.start,
      end: win.end,
      cls: classifyEntry(entry, planKeySet),
      energy: String(entry.energy || '').toLowerCase(),
      activity: String(entry.activity || ''),
      source: entry.source || (entry.browserUsage ? 'browser-extension' : entry.phoneUsage ? 'phone-usage' : 'manual')
    });
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end);

  const segments = [];
  let prevEnd = null;
  for (const seg of raw) {
    let start = seg.start;
    if (prevEnd != null && start < prevEnd) start = prevEnd;
    if (start >= seg.end) continue; // fully swallowed by the previous segment
    segments.push({ ...seg, start });
    prevEnd = seg.end;
  }
  return segments;
}

/**
 * deriveAttentionSignals(entries, options)
 *
 * @param {Array} entries  Day-scoped entries (caller filters to the day and
 *                          drops deleted rows; this fn also skips
 *                          missed/deleted/break/away defensively).
 * @param {Object} [options]
 * @param {Object} [options.config]      Threshold overrides (see ATTENTION_SIGNALS_CONFIG).
 * @param {string[]} [options.planTasks] Today Plan task strings — entries whose
 *                                       activity matches one are treated as focus.
 * @param {?string} [options.selfRating] 'focused' | 'mixed' | 'distracted' — the
 *                                       user's optional subjective rating. Echoed
 *                                       back untouched; never changes the numbers.
 * @param {string} [options.dateKey]     Optional label, echoed in meta.
 * @returns {Object} factual outputs + supporting metadata (see below).
 */
export function deriveAttentionSignals(entries, options = {}) {
  const cfg = { ...ATTENTION_SIGNALS_CONFIG, ...(options.config || {}) };

  const planKeySet = new Set(
    (Array.isArray(options.planTasks) ? options.planTasks : [])
      .map(normalizeActivityKey)
      .filter(Boolean)
  );

  const selfRating = VALID_RATINGS.has(options.selfRating) ? options.selfRating : null;
  const segments = buildSegments(entries, planKeySet);

  const stretches = [];
  const breaks = [];
  let totalDistractionMin = 0;
  let distractionSegmentCount = 0;

  let stretch = null;      // { start, focusMin, neutralRunMin, neutralRunStart, distractionDipMin }
  let prevEnd = null;

  const newStretch = (start) => ({
    start,
    focusMin: 0,
    neutralRunMin: 0,
    neutralRunStart: null,
    distractionDipMin: 0
  });

  const closeStretch = (endTs, reason, breakTs) => {
    if (!stretch) return;
    const qualified = stretch.focusMin >= cfg.minStretchMin && endTs > stretch.start;
    if (qualified) {
      stretches.push({
        start: stretch.start,
        end: endTs,
        durationMin: Math.round((endTs - stretch.start) / 60000),
        focusMin: Math.round(stretch.focusMin),
        distractionDipMin: Math.round(stretch.distractionDipMin),
        endReason: reason
      });
      if (reason === 'distraction' || reason === 'idle') {
        breaks.push({ ts: breakTs, reason });
      }
    }
    stretch = null;
  };

  for (const seg of segments) {
    const durMin = (seg.end - seg.start) / 60000;

    // 1. Idle gap since the previous logged segment ends an open stretch.
    if (stretch && prevEnd != null) {
      const gapMin = (seg.start - prevEnd) / 60000;
      if (gapMin >= cfg.idleGapMin) {
        closeStretch(prevEnd, 'idle', prevEnd);
      }
    }

    // 2. Handle this segment by its context class.
    if (seg.cls === 'focus') {
      if (!stretch) stretch = newStretch(seg.start);
      stretch.focusMin += durMin;
      stretch.neutralRunMin = 0;
      stretch.neutralRunStart = null;
    } else if (seg.cls === 'neutral') {
      if (stretch) {
        if (stretch.neutralRunStart == null) stretch.neutralRunStart = seg.start;
        stretch.neutralRunMin += durMin;
        if (stretch.neutralRunMin >= cfg.contextShiftMin) {
          closeStretch(stretch.neutralRunStart, 'context-shift', null);
        }
      }
      // No open stretch → roaming neutral time, nothing to record.
    } else { // distraction
      totalDistractionMin += durMin;
      distractionSegmentCount += 1;
      if (stretch) {
        if (durMin >= cfg.debounceMin) {
          if (stretch.focusMin >= cfg.minStretchMin) {
            closeStretch(seg.start, 'distraction', seg.start);
          } else {
            stretch = null; // a budding, not-yet-coherent run broken by real drift
          }
        } else {
          stretch.distractionDipMin += durMin; // brief dip — stretch survives
        }
      }
    }

    prevEnd = seg.end;
  }
  closeStretch(prevEnd, 'day-end', null);

  // Recovery: match each break to the next coherent stretch that begins after
  // it, within recoveryWindowMin. Each stretch can satisfy at most one break.
  let recoveries = 0;
  const recoveryGaps = [];
  let si = 0;
  for (const br of breaks) {
    while (si < stretches.length && stretches[si].start <= br.ts) si += 1;
    if (si < stretches.length) {
      const gapMin = (stretches[si].start - br.ts) / 60000;
      if (gapMin <= cfg.recoveryWindowMin) {
        recoveries += 1;
        recoveryGaps.push(gapMin);
      }
      si += 1;
    }
  }
  const sortedGaps = [...recoveryGaps].sort((a, b) => a - b);
  const medianRecoveryMin = recoveryGaps.length >= 2 ? Math.round(median(sortedGaps)) : null;

  const longestStretch = stretches.reduce(
    (best, s) => (s.durationMin > (best ? best.durationMin : -1) ? s : best),
    null
  );

  const likelyDistractionMin =
    totalDistractionMin >= cfg.distractionSupportMin ? Math.round(totalDistractionMin) : null;

  const totalFocusMin = Math.round(stretches.reduce((sum, s) => sum + s.focusMin, 0));

  return {
    version: ATTENTION_SIGNALS_VERSION,
    hasData: segments.length > 0,

    // ── Primary signals ──
    longestStretchMin: longestStretch ? longestStretch.durationMin : 0,
    coherentStretchCount: stretches.length,
    attentionBreaks: breaks.length,
    likelyDistractionMin,                 // null when below the support threshold
    recoveries,
    medianRecoveryMin,                    // null unless there are >= 2 recoveries

    // ── Subjective (echoed, never fused into the numbers) ──
    selfRating,

    // ── Supporting / explainability metadata ──
    totalFocusMin,
    config: cfg,
    meta: {
      dateKey: options.dateKey || null,
      segmentCount: segments.length,
      distractionSegmentCount,
      totalDistractionMinRaw: Math.round(totalDistractionMin),
      longestStretch: longestStretch || null
    },
    segments,
    stretches,
    breaks
  };
}

/**
 * Turn a derived-signals object into the short list of lines the UI renders.
 * Only metrics actually supported by the data appear — progressive disclosure,
 * no forced or false-precision numbers.
 *
 * @returns {{key:string,label:string,value:string}[]}
 */
export function attentionSignalLines(signals) {
  if (!signals || !signals.hasData) return [];
  const lines = [];

  // The longest coherent stretch is a wall-clock SPAN — it can legitimately
  // contain short neutral runs and sub-debounce distraction dips. Show the
  // classified focus minutes alongside the span whenever they differ, so the
  // span can never be misread as "N minutes of actual focus".
  let longestValue = '—';
  if (signals.longestStretchMin > 0) {
    const ls = signals.meta && signals.meta.longestStretch;
    const focusMin = ls && Number.isFinite(ls.focusMin) ? ls.focusMin : signals.longestStretchMin;
    longestValue = focusMin < signals.longestStretchMin
      ? `${signals.longestStretchMin} min span · ${focusMin} min focused`
      : `${signals.longestStretchMin} min`;
  }
  lines.push({ key: 'longest', label: 'Longest coherent stretch', value: longestValue });

  if (signals.coherentStretchCount > 0 || signals.attentionBreaks > 0) {
    lines.push({
      key: 'breaks',
      label: 'Attention breaks',
      value: String(signals.attentionBreaks)
    });
  }

  if (signals.likelyDistractionMin != null) {
    lines.push({
      key: 'distraction',
      label: 'Likely distraction',
      value: `~${signals.likelyDistractionMin} min`
    });
  }

  if (signals.attentionBreaks > 0) {
    let value = String(signals.recoveries);
    if (signals.medianRecoveryMin != null) value += ` · median ${signals.medianRecoveryMin} min`;
    lines.push({ key: 'recovery', label: 'Recovered from drift', value });
  }

  if (signals.selfRating) {
    const label = signals.selfRating.charAt(0).toUpperCase() + signals.selfRating.slice(1);
    lines.push({ key: 'rating', label: 'Self-rating', value: label });
  }

  return lines;
}

// Attach to the global scope for the classic-script callers (insights.js,
// index.html) — mirrors the focus-wallet.js pattern.
if (typeof globalThis !== 'undefined') {
  globalThis.deriveAttentionSignals = deriveAttentionSignals;
  globalThis.attentionSignalLines = attentionSignalLines;
  globalThis.ATTENTION_SIGNALS_CONFIG = ATTENTION_SIGNALS_CONFIG;
}
