/** Tomorrow View is inspection-only: it never writes plan truth, so this module derives display
 *  state purely from what Plan Tomorrow's own model already establishes as authoritative —
 *  `normalizePreparation()`'s result, plus counts of what's actually active for the target date.
 *  Keeping this in one pure, unit-tested function is what lets "prepared" vs "content exists but
 *  unconfirmed" vs "truly empty" stay a fact, not a UI guess (see PlanTomorrowModel.normalizePreparation
 *  and computeReadyNow for the underlying authority this reads from). */
export function deriveTomorrowViewState({ preparation, activeItemCount = 0, applicableRoutineCount = 0 } = {}) {
  if (preparation) return preparation.intentionalBlank === true ? 'open-day' : 'prepared';
  return activeItemCount > 0 || applicableRoutineCount > 0 ? 'unprepared-content' : 'unprepared-empty';
}

const api = { deriveTomorrowViewState };
globalThis.TomorrowViewModel = api;
