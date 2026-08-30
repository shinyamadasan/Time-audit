export const OBSIDIAN_LIFE_LEDGER_SENTINEL = '<!-- life-ledger:generated:v1 -->';
export const OBSIDIAN_LIFE_LEDGER_DAILY_DIR = 'Life Ledger/Daily';
export const OBSIDIAN_LIFE_LEDGER_SYSTEM_README = 'Life Ledger/System/README.md';

const SUPPORTED_EVENT_TYPES = new Set(['focus_session_completed', 'plan_step_completed']);
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_FALLBACK_TIMEZONE = 'Etc/UTC';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidTimezone(value) {
  if (typeof value !== 'string' || !value.trim() || !value.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function timezoneFor(event) {
  const timezone = String(event?.sourceTimezone || '').trim();
  return isValidTimezone(timezone) ? timezone : UTC_FALLBACK_TIMEZONE;
}

function dateKeyFor(isoInstant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(isoInstant));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function timeFor(isoInstant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(isoInstant));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.hour === '24' ? '00' : byType.hour}:${byType.minute}`;
}

function text(value, fallback = '') {
  const normalized = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n+/g, ' / ')
    .trim();
  const escaped = normalized
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/#/g, '\\#')
    .replace(/\|/g, '\\|');
  return escaped || fallback;
}

function minutes(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function isTombstoned(event) {
  return event?.tombstone?.active === true;
}

function eventMarker(event) {
  return `<!-- life-ledger:event:${text(event.eventId, 'missing-event-id')} -->`;
}

function supportedEventOrThrow(event, index, policy, skipped) {
  if (SUPPORTED_EVENT_TYPES.has(event?.type)) return true;
  const type = String(event?.type || 'missing');
  const message = `Unsupported Life Ledger event type for Obsidian export at index ${index}: ${type}`;
  if (policy === 'skip') {
    skipped.push({ index, type, reason: message });
    return false;
  }
  throw new Error(message);
}

function sortEvents(a, b) {
  return String(a.occurredAt).localeCompare(String(b.occurredAt))
    || String(a.type).localeCompare(String(b.type))
    || String(a.eventId).localeCompare(String(b.eventId));
}

function focusLine(event) {
  const timezone = timezoneFor(event);
  const startedAt = event.payload?.startedAt || event.occurredAt;
  const endedAt = event.payload?.endedAt || event.occurredAt;
  const duration = minutes(event.payload?.durationMinutes);
  const durationText = duration == null ? '' : ` · ${duration} min`;
  return `- ${timeFor(startedAt, timezone)}-${timeFor(endedAt, timezone)} - **${text(event.payload?.activity, 'Focus session')}**${durationText}\n  ${eventMarker(event)}`;
}

function learningContext(source = {}) {
  const parts = [source.planTitle, source.phaseTitle, source.lessonTitle]
    .map(item => text(item))
    .filter(Boolean);
  return parts.join(' / ');
}

function learningLine(event) {
  const timezone = timezoneFor(event);
  const context = learningContext(event.payload?.source);
  return [
    `- ${timeFor(event.payload?.completedAt || event.occurredAt, timezone)} - Completed **${text(event.payload?.stepLabel, 'Learning step')}**`,
    context ? `  - ${context}` : '',
    `  ${eventMarker(event)}`
  ].filter(Boolean).join('\n');
}

function renderDaily(dateKey, events) {
  const focusEvents = events.filter(event => event.type === 'focus_session_completed');
  const learningEvents = events.filter(event => event.type === 'plan_step_completed');
  const lines = [
    OBSIDIAN_LIFE_LEDGER_SENTINEL,
    '',
    `# Life Ledger - ${dateKey}`,
    ''
  ];
  if (focusEvents.length) {
    lines.push('## Focus', '', ...focusEvents.map(focusLine), '');
  }
  if (learningEvents.length) {
    lines.push('## Learning', '', ...learningEvents.map(learningLine), '');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function renderSystemReadme() {
  return `${[
    OBSIDIAN_LIFE_LEDGER_SENTINEL,
    '',
    '# Life Ledger',
    '',
    'This subtree is generated from validated Life Ledger events.',
    '',
    'Generated Daily notes are current-state projections. Tombstoned events are omitted, and generated stale Daily files may be removed during a full rebuild.',
    '',
    'Do not manually edit generated files inside this subtree; write personal notes elsewhere in the vault.'
  ].join('\n')}\n`;
}

function normalizeEvents(events, unsupportedEventPolicy) {
  if (!Array.isArray(events)) throw new Error('Life Ledger export events must be an array');
  const skipped = [];
  const active = events.filter((event, index) => {
    if (!isPlainObject(event)) throw new Error(`Life Ledger export event at index ${index} must be an object`);
    return supportedEventOrThrow(event, index, unsupportedEventPolicy, skipped) && !isTombstoned(event);
  });
  return { active, skipped };
}

export function buildObsidianLifeLedgerExport(events, options = {}) {
  const unsupportedEventPolicy = options.unsupportedEventPolicy || 'throw';
  if (!['throw', 'skip'].includes(unsupportedEventPolicy)) {
    throw new Error('unsupportedEventPolicy must be throw or skip');
  }
  const { active, skipped } = normalizeEvents(events, unsupportedEventPolicy);
  const byDay = new Map();
  active.slice().sort(sortEvents).forEach(event => {
    const day = dateKeyFor(event.occurredAt, timezoneFor(event));
    if (!DATE_KEY_RE.test(day)) throw new Error(`Unable to derive Life Ledger export date for event ${event.eventId}`);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(event);
  });
  const files = [
    {
      relativePath: OBSIDIAN_LIFE_LEDGER_SYSTEM_README,
      content: renderSystemReadme()
    },
    ...Array.from(byDay.keys()).sort().map(day => ({
      relativePath: `${OBSIDIAN_LIFE_LEDGER_DAILY_DIR}/${day}.md`,
      content: renderDaily(day, byDay.get(day))
    }))
  ];
  return { files, skipped };
}
