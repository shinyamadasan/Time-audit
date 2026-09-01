import { deriveLifeLedgerKey, validateLifeLedgerEvent } from './life-ledger-core.js';
import { createLocalLifeLedgerStore } from './life-ledger-runtime.js';

export const LIFE_LEDGER_TRANSPORT_SCHEMA_VERSION = 1;
export const LIFE_LEDGER_TRANSPORT_KIND = 'chronasense-life-ledger';
export const LIFE_LEDGER_EXPORT_FILENAME = 'chronasense-life-ledger-v1.json';

const SNAPSHOT_KEYS = new Set(['transportSchemaVersion', 'kind', 'events']);

export class LifeLedgerTransportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LifeLedgerTransportError';
    this.code = code;
    Object.assign(this, details);
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.keys(value).sort().reduce((out, key) => {
    out[key] = stableValue(value[key]);
    return out;
  }, {});
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// A date-precision event (see life-ledger-core.js's temporal-precision invariant) has no
// occurredAt to sort by — comparing `null` against a real ISO instant string coerces both
// sides to NaN and silently reports "equal" for every such pair, which is not a sort at all.
// occurredDate is the correct factual chronological anchor for those events instead; it is
// also a lexicographic PREFIX of any same-day occurredAt instant string, so mixing the two
// kinds still produces a stable, deterministic chronological-then-technical ordering.
function transportSortKey(event) {
  return event.temporalPrecision === 'date' ? String(event.occurredDate) : String(event.occurredAt);
}

function compareTransportEvents(left, right) {
  return compareStrings(transportSortKey(left), transportSortKey(right))
    || compareStrings(left.type, right.type)
    || compareStrings(left.eventId, right.eventId);
}

function snapshotForSerialization(snapshot) {
  const validated = validateLifeLedgerSnapshot(snapshot);
  return {
    ...validated,
    events: [...validated.events].sort(compareTransportEvents)
  };
}

export function serializeLifeLedgerSnapshot(snapshot) {
  return `${JSON.stringify(stableValue(snapshotForSerialization(snapshot)))}\n`;
}

export function validateLifeLedgerSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    throw new LifeLedgerTransportError('invalid_snapshot', 'Life Ledger snapshot must be an object');
  }
  Object.keys(snapshot).forEach(key => {
    if (!SNAPSHOT_KEYS.has(key)) {
      throw new LifeLedgerTransportError('invalid_snapshot', `Life Ledger snapshot field ${key} is not allowed`);
    }
  });
  if (snapshot.transportSchemaVersion !== LIFE_LEDGER_TRANSPORT_SCHEMA_VERSION) {
    throw new LifeLedgerTransportError('unsupported_transport_schema', `Unsupported Life Ledger transport schema ${snapshot.transportSchemaVersion}`);
  }
  if (snapshot.kind !== LIFE_LEDGER_TRANSPORT_KIND) {
    throw new LifeLedgerTransportError('invalid_snapshot_kind', `Unsupported Life Ledger snapshot kind ${snapshot.kind}`);
  }
  if (!Array.isArray(snapshot.events)) {
    throw new LifeLedgerTransportError('invalid_snapshot_events', 'Life Ledger snapshot events must be an array');
  }

  const seenKeys = new Set();
  const seenEventIds = new Set();
  const events = snapshot.events.map((event, index) => {
    const validation = validateLifeLedgerEvent(event);
    if (!validation.ok) {
      throw new LifeLedgerTransportError(
        'invalid_event',
        `Life Ledger snapshot event ${index} is invalid`,
        { errors: validation.errors }
      );
    }
    const key = deriveLifeLedgerKey(event);
    if (seenKeys.has(key)) {
      throw new LifeLedgerTransportError('duplicate_logical_event', `Life Ledger snapshot repeats logical event ${key}`);
    }
    seenKeys.add(key);
    if (seenEventIds.has(event.eventId)) {
      throw new LifeLedgerTransportError('duplicate_event_id', `Life Ledger snapshot repeats eventId ${event.eventId}`);
    }
    seenEventIds.add(event.eventId);
    return cloneJson(event);
  });

  return {
    transportSchemaVersion: LIFE_LEDGER_TRANSPORT_SCHEMA_VERSION,
    kind: LIFE_LEDGER_TRANSPORT_KIND,
    events
  };
}

export function parseLifeLedgerSnapshotJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    throw new LifeLedgerTransportError('invalid_json', 'Life Ledger snapshot JSON is malformed', { cause: err });
  }
  return validateLifeLedgerSnapshot(parsed);
}

export function createLifeLedgerSnapshotFromEvents(events) {
  return validateLifeLedgerSnapshot({
    transportSchemaVersion: LIFE_LEDGER_TRANSPORT_SCHEMA_VERSION,
    kind: LIFE_LEDGER_TRANSPORT_KIND,
    events
  });
}

export function createLifeLedgerSnapshotFromStore(store) {
  if (!store || typeof store.listEvents !== 'function') {
    throw new LifeLedgerTransportError('invalid_store', 'Life Ledger snapshot export requires a runtime store');
  }
  return createLifeLedgerSnapshotFromEvents(store.listEvents());
}

export function exportLifeLedgerSnapshot(options = {}) {
  return createLifeLedgerSnapshotFromStore(options.store || createLocalLifeLedgerStore(options));
}

export function exportLifeLedgerSnapshotJson(options = {}) {
  return serializeLifeLedgerSnapshot(exportLifeLedgerSnapshot(options));
}

export function snapshotHasOnlyLedgerEnvelope(snapshot) {
  const validated = validateLifeLedgerSnapshot(snapshot);
  return Object.keys(validated).every(key => SNAPSHOT_KEYS.has(key))
    && !hasOwn(validated, 'localStorage')
    && !hasOwn(validated, 'settings')
    && !hasOwn(validated, 'firebase')
    && !hasOwn(validated, 'authToken');
}
