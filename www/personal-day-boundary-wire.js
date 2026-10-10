// Firebase RTDB prunes literal null fields. The legacy anchor may therefore
// arrive without effectiveFromInstant; newer writes use a non-prunable sentinel.
// Decode either representation only when the reserved id, midnight boundary,
// and real timezone prove the anchor shape. All other malformed revisions stay
// unchanged for canonical validation to reject. The domain model remains
// Firebase-agnostic; both the app sync bridge and the Action API use this codec.
import { LEGACY_CALENDAR_DAY_REVISION_ID, validOperationalDayTimezone } from './personal-day-boundary-model.js';

const WIRE_ANCHOR_SENTINEL = 'legacy-anchor-instant';

function provablyAnchorShaped(raw) {
  return raw.id === LEGACY_CALENDAR_DAY_REVISION_ID
    && raw.boundaryTime === '00:00'
    && validOperationalDayTimezone(raw.timezone);
}

export function encodeRevisionForWire(revision) {
  // Call only for a revision being written; never rewrite untouched siblings.
  return revision.effectiveFromInstant === null
    ? { ...revision, effectiveFromInstant: WIRE_ANCHOR_SENTINEL } : revision;
}

export function decodeWireRevision(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const missingOrSentinel = raw.effectiveFromInstant === undefined || raw.effectiveFromInstant === WIRE_ANCHOR_SENTINEL;
  if (missingOrSentinel && provablyAnchorShaped(raw)) return { ...raw, effectiveFromInstant: null };
  return raw;
}

export function decodeWireMap(remoteMap) {
  const decoded = {};
  Object.entries(remoteMap || {}).forEach(([id, raw]) => { decoded[id] = decodeWireRevision(raw); });
  return decoded;
}
