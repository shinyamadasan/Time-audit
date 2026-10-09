// ══════════════════════════════════════════════════════
// evidence-interpretation.js — Phase 6G.2 "Deterministic Analytics Truth Fixes"
//
// One small, bounded interpretation decision shared by every analytics consumer
// that turns entries into a behavioral claim (Today pulse, Review close-out,
// weekly Insights, attention signals, Focus Wallet):
//
//     "Does this entry's `energy` reflect a user assertion or a timer + chosen
//      label — something that actually supports a claim about behavior — or is
//      it only a default mapping / inherited context?"
//
// It is NOT a confidence framework, an allocation engine, or a new schema. It
// reads markers the entries ALREADY carry and returns booleans. Raw entries,
// their durations, and their provenance are never changed or removed.
//
// Canonical rules it encodes (see contracts/CHRONASENSE_EVIDENCE_CONTRACT_V1.md):
//   • schedule assumption            != actual behavior
//   • passive device/site observation != confirmed purpose / waste / deep work
//   • computer-session context ("PC Time") != confirmed focus
//
// Deterministic-distinguishability note: when a user reclassifies a passive
// entry, the retro save rebuilds the entry WITHOUT `browserUsage`/`phoneUsage`
// (only `scheduledAutoLog` lineage is deliberately preserved). So an entry that
// STILL carries a passive flag is provably an un-reclassified default. A PC-Time
// block cannot be shown to have inherited its energy from a real nearby session
// rather than the `|| 'deep'` fallback — the stored fields do not record that —
// so both are treated the same and the limitation is documented, not guessed.
// ══════════════════════════════════════════════════════
(function initEvidenceInterpretation(root) {
  'use strict';

  function isEntryLike(entry) {
    return !!entry && typeof entry === 'object' && !Array.isArray(entry);
  }

  // Passive device / site observation: energy is a site->energy or app->energy
  // default mapping, not a user- or timer-asserted classification.
  function isPassiveObservationEntry(entry) {
    if (!isEntryLike(entry)) return false;
    return entry.browserUsage === true ||
      entry.phoneUsage === true ||
      entry.source === 'browser-extension' ||
      entry.source === 'phone-usage';
  }

  // Schedule assumption: auto-written from a recurring template. Intended /
  // planned, never confirmed to have actually occurred.
  function isScheduledAssumptionEntry(entry) {
    if (!isEntryLike(entry)) return false;
    if (entry.scheduledAutoLog === true) return true;
    if (entry.captureMethod === 'scheduled_template') return true;
    const prov = entry.provenance;
    if (prov && typeof prov === 'object' && prov.captureMethod === 'scheduled_template') return true;
    return false;
  }

  // Computer-session context: the ambient "PC Time" tracker auto-logs a block
  // every minute with `energy = lastEntry?.energy || 'deep'`. That proves a
  // computer session was open, not presence, work, or deep work.
  function isComputerSessionEntry(entry) {
    if (!isEntryLike(entry)) return false;
    if (entry.browserUsage === true) return false;
    if (!(entry.autoLogged === true || entry.quickLogged === true)) return false;
    const base = String(entry.activity || '')
      .split(' (Output:')[0]
      .split(' · ')[0]
      .trim()
      .toLowerCase();
    return base === 'pc time' || base === 'screen time';
  }

  // The single predicate metric consumers call: is it safe to treat this
  // entry's `energy` as a confirmed behavioral classification (deep / waste /
  // learning / …) for totals, percentages, streaks, points and signals?
  //
  // Explicit user assertions and timer+label sessions pass. Passive defaults,
  // schedule assumptions and PC-Time context do not. (An entry a user edited no
  // longer carries the passive flags, so it passes — explicit assertion wins
  // wherever the metadata can actually distinguish it.)
  function hasConfirmedEnergyClassification(entry) {
    if (!isEntryLike(entry)) return false;
    return !isPassiveObservationEntry(entry) &&
      !isScheduledAssumptionEntry(entry) &&
      !isComputerSessionEntry(entry);
  }

  // Time Truth V1: does this entry only prove "a device/tab/timer was left open,"
  // not that the person was actually present? Passive device observation and the
  // native PC-Time ticker share this limitation — neither has an idle/lock signal,
  // so a long AFK/sleep gap can silently read as continuous coverage. Consumers
  // that claim "this part of the day is accounted for" (gap-closing, unlogged-hours
  // totals) should not treat these as solid coverage; consumers that just want a
  // duration figure may still count them.
  function isUnverifiedPresenceEntry(entry) {
    if (!isEntryLike(entry)) return false;
    return isPassiveObservationEntry(entry) || isComputerSessionEntry(entry);
  }

  root.isPassiveObservationEntry = isPassiveObservationEntry;
  root.isScheduledAssumptionEntry = isScheduledAssumptionEntry;
  root.isComputerSessionEntry = isComputerSessionEntry;
  root.hasConfirmedEnergyClassification = hasConfirmedEnergyClassification;
  root.isUnverifiedPresenceEntry = isUnverifiedPresenceEntry;
})(typeof globalThis !== 'undefined' ? globalThis : window);
