// node --test evidence-interpretation.test.js
//
// Phase 6G.2 — the shared "is this energy a confirmed classification?" decision.
// Every analytics consumer (Today pulse, Review close-out, weekly Insights,
// attention signals, Focus Wallet) leans on hasConfirmedEnergyClassification().

import assert from 'node:assert/strict';
import test from 'node:test';

import './evidence-interpretation.js';

const {
  isPassiveObservationEntry,
  isScheduledAssumptionEntry,
  isComputerSessionEntry,
  hasConfirmedEnergyClassification,
  isUnverifiedPresenceEntry
} = globalThis;

test('passive browser / phone observations are recognised', () => {
  assert.equal(isPassiveObservationEntry({ energy: 'waste', browserUsage: true }), true);
  assert.equal(isPassiveObservationEntry({ energy: 'deep', source: 'browser-extension' }), true);
  assert.equal(isPassiveObservationEntry({ energy: 'waste', phoneUsage: true }), true);
  assert.equal(isPassiveObservationEntry({ energy: 'waste', source: 'phone-usage' }), true);
  assert.equal(isPassiveObservationEntry({ energy: 'waste', activity: 'YouTube', retro: true }), false);
});

test('schedule assumptions are recognised via either marker location', () => {
  assert.equal(isScheduledAssumptionEntry({ energy: 'deep', scheduledAutoLog: true }), true);
  assert.equal(isScheduledAssumptionEntry({ energy: 'deep', captureMethod: 'scheduled_template' }), true);
  assert.equal(isScheduledAssumptionEntry({ payload: {}, provenance: { captureMethod: 'scheduled_template' } }), true);
  assert.equal(isScheduledAssumptionEntry({ energy: 'deep', autoLogged: true }), false); // autoLogged alone != schedule
});

test('PC-Time / screen-time context blocks are recognised, and only those', () => {
  assert.equal(isComputerSessionEntry({ activity: 'PC Time', energy: 'deep', autoLogged: true }), true);
  assert.equal(isComputerSessionEntry({ activity: 'PC time · GitHub', energy: 'deep', quickLogged: true }), true);
  assert.equal(isComputerSessionEntry({ activity: 'Screen time', energy: 'deep', autoLogged: true }), true);
  // A user-named task is never computer-session context, even if auto-logged.
  assert.equal(isComputerSessionEntry({ activity: 'Write the RFC', energy: 'deep', autoLogged: true }), false);
  // "PC Time" that is actually a browser sub-observation is handled by the passive path, not here.
  assert.equal(isComputerSessionEntry({ activity: 'PC Time', energy: 'deep', browserUsage: true }), false);
  // Not auto/quick-logged => a manual entry the user chose to call "PC Time".
  assert.equal(isComputerSessionEntry({ activity: 'PC Time', energy: 'deep', retro: true }), false);
});

test('hasConfirmedEnergyClassification: user assertions and timer+label pass; defaults do not', () => {
  // Confirmed: manual / retro / quick / timer entries.
  assert.equal(hasConfirmedEnergyClassification({ energy: 'deep', activity: 'Write', retro: true }), true);
  assert.equal(hasConfirmedEnergyClassification({ energy: 'waste', activity: 'Reddit', quickLogged: true }), true);
  assert.equal(hasConfirmedEnergyClassification({ energy: 'deep', activity: 'Focus: RFC' }), true);
  // Not confirmed: passive, scheduled, computer-session context.
  assert.equal(hasConfirmedEnergyClassification({ energy: 'waste', browserUsage: true }), false);
  assert.equal(hasConfirmedEnergyClassification({ energy: 'waste', phoneUsage: true }), false);
  assert.equal(hasConfirmedEnergyClassification({ energy: 'deep', scheduledAutoLog: true }), false);
  assert.equal(hasConfirmedEnergyClassification({ energy: 'deep', activity: 'PC Time', autoLogged: true }), false);
});

test('a user who reclassified a passive entry (flag dropped) is treated as confirmed', () => {
  // The retro save rebuilds the entry without browserUsage/phoneUsage.
  const reclassified = { energy: 'deep', activity: 'YouTube', retro: true, originalLabel: 'deep' };
  assert.equal(isPassiveObservationEntry(reclassified), false);
  assert.equal(hasConfirmedEnergyClassification(reclassified), true);
});

test('non-entries are never confirmed', () => {
  for (const junk of [null, undefined, 0, '', 'x', []]) {
    assert.equal(hasConfirmedEnergyClassification(junk), false);
  }
});

// Time Truth V1 — passive observation and computer-session context share a limitation
// neither has an idle/lock signal, so neither can prove continuous presence. Consumers
// that claim "this span is accounted for" (gap-closing, unlogged-hours totals) use this
// combined predicate; duration totals may still count them (see index.html comments).
test('isUnverifiedPresenceEntry: true for passive observation OR computer-session context, false otherwise', () => {
  assert.equal(isUnverifiedPresenceEntry({ energy: 'waste', browserUsage: true }), true);
  assert.equal(isUnverifiedPresenceEntry({ energy: 'waste', phoneUsage: true }), true);
  assert.equal(isUnverifiedPresenceEntry({ activity: 'PC Time', energy: 'shallow', autoLogged: true, quickLogged: true }), true);
  assert.equal(isUnverifiedPresenceEntry({ activity: 'Screen Time', energy: 'shallow', autoLogged: true }), true);
  // Confirmed evidence stays confirmed.
  assert.equal(isUnverifiedPresenceEntry({ energy: 'deep', activity: 'Write the RFC', retro: true }), false);
  assert.equal(isUnverifiedPresenceEntry({ energy: 'deep', activity: 'Focus: RFC' }), false);
  // A schedule assumption alone (no passive/computer-session marker) is a different
  // uncertainty class and is intentionally NOT included here.
  assert.equal(isUnverifiedPresenceEntry({ energy: 'deep', scheduledAutoLog: true }), false);
  for (const junk of [null, undefined, 0, '', 'x', []]) {
    assert.equal(isUnverifiedPresenceEntry(junk), false);
  }
});
