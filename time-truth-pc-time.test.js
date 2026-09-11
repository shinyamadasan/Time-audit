// node time-truth-pc-time.test.js
//
// Time Truth V1 — the native "PC Time" ticker (startPCTimeLive/autoLogBlock in
// index.html) previously inherited energy from `entries.find(...)?.energy || 'deep'`:
// whatever was logged most recently, or 'deep' if nothing had been logged yet. That let
// an unrelated confirmed entry quietly launder an unconfirmed auto-logged block into
// "deep work" — and even with nothing to inherit, it defaulted to the strongest
// possible confirmed-work claim. This is a static, deterministic source check (not a
// live-timer Playwright test — driving the real 60s setInterval would mean fast-
// forwarding the whole app's other unrelated intervals too, which this milestone's
// "smallest architecture" scope doesn't need) proving both patterns are gone from the
// current source, and that a fixed, non-claiming value is used instead. The functional
// consequence (a PC-Time block never counts as confirmed deep/waste evidence) is
// already covered end-to-end by tests/analytics-truth.spec.js.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const indexSource = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

function extractFunctionSource(name) {
  const start = indexSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in index.html`);
  let depth = 0;
  let i = indexSource.indexOf('{', start);
  const bodyStart = i;
  for (; i < indexSource.length; i++) {
    if (indexSource[i] === '{') depth++;
    else if (indexSource[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return indexSource.slice(bodyStart, i + 1);
}

test('startPCTimeLive no longer inherits energy from the most-recently-logged entry', () => {
  const src = extractFunctionSource('startPCTimeLive');
  assert.doesNotMatch(src, /lastEntry\??\.energy/, 'still reads lastEntry.energy — inheritance was not removed');
  assert.doesNotMatch(src, /entries\.find/, 'still searches entries for a prior energy to adopt');
});

test('startPCTimeLive no longer defaults to confirmed deep work', () => {
  const src = extractFunctionSource('startPCTimeLive');
  assert.doesNotMatch(src, /\|\|\s*'deep'/, "still falls back to 'deep'");
  assert.doesNotMatch(src, /\|\|\s*"deep"/, 'still falls back to "deep"');
});

test('startPCTimeLive uses a fixed, non-inherited energy value', () => {
  const src = extractFunctionSource('startPCTimeLive');
  assert.match(src, /const energy = 'shallow'/, 'expected a fixed literal energy assignment');
});

test('the fixed PC-Time energy value is still one that isComputerSessionEntry excludes from confirmed analytics', () => {
  // Belt-and-suspenders: the fixed value chosen ('shallow') only matters if this
  // ticker's entries stay excluded from confirmed analytics regardless of the value —
  // confirm that exclusion is keyed on activity name + autoLogged/quickLogged, NOT energy.
  const evidenceSrc = readFileSync(new URL('./evidence-interpretation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(
    extractPredicateSource(evidenceSrc, 'isComputerSessionEntry'),
    /entry\.energy/,
    'isComputerSessionEntry must not depend on the energy value — otherwise picking a new fixed value could silently start counting as confirmed'
  );
});

function extractPredicateSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  let depth = 0;
  let i = source.indexOf('{', start);
  const bodyStart = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(bodyStart, i + 1);
}
