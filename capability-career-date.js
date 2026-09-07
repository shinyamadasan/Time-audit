// Date rendering for Capability/Career's Life Ledger evidence list.
//
// A date-precision Life Ledger event (life-ledger-core.js's temporal-precision invariant —
// e.g. meal_prepared) carries a calendar date in `occurredDate` (YYYY-MM-DD) and has NO
// `occurredAt`. That date is a factual calendar day with no time-of-day evidence, so it must
// render as that exact day in every viewer timezone.
//
// `new Date('2026-08-30')` parses as UTC midnight. Formatted in a negative-UTC-offset zone
// (America/Phoenix, most of the US) that instant falls on 2026-08-29 local — so the naive
// `new Date(occurredDate).toLocaleDateString()` displays the day BEFORE the fact. Date-only
// values are therefore formatted from their calendar components, anchored and formatted in
// UTC, which no offset can shift. Instant-precision events keep their existing local-time
// rendering (an instant genuinely happened at a moment; showing it in the viewer's zone is
// correct).

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DISPLAY_OPTIONS = { month: 'short', day: 'numeric', year: 'numeric' };

// Pick the temporal anchor that actually exists for the event: date-precision events expose
// `occurredDate`; every other (instant) event exposes `occurredAt`.
export function ledgerEventDate(event) {
  return event && event.temporalPrecision === 'date'
    ? event.occurredDate
    : event && event.occurredAt;
}

// `locale` is optional and exists for deterministic tests; production passes nothing so the
// host default locale is used, matching the rest of this UI.
export function formatLedgerDate(value, locale) {
  if (!value) return 'No date';
  try {
    const dateOnly = DATE_ONLY_RE.exec(value);
    if (dateOnly) {
      const year = Number(dateOnly[1]);
      const month = Number(dateOnly[2]);
      const day = Number(dateOnly[3]);
      // Anchor at UTC noon and format in UTC: the rendered day is exactly year-month-day
      // regardless of the runtime timezone.
      return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).toLocaleDateString(
        locale || [],
        { ...DISPLAY_OPTIONS, timeZone: 'UTC' }
      );
    }
    return new Date(value).toLocaleDateString(locale || [], DISPLAY_OPTIONS);
  } catch {
    return String(value);
  }
}
