import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIntelligence, PATTERN_MIN_DAYS, RECENT_DAYS } from './intelligence-read-model.js';
import { calendarPlanInterval } from './calendar-plan-model.js';
import { localPlanDate, addCalendarDays } from './plan-tomorrow-model.js';
import { buildCapture, triageCapture, archiveCapture, delegateCapture, claimPromotion } from './brain-dump-model.js';
import { buildCommitment } from './commitments-model.js';
import { createCoarseEvidenceRecord } from './coarse-life-evidence-model.js';

const NOW = Date.parse('2026-10-07T12:00:00+08:00');
function input(patch = {}) {
  const now = patch.now ?? NOW;
  const timezone = patch.timezone ?? 'Asia/Manila';
  const today = localPlanDate(now, timezone);
  return { owner: 'uid_A', contextOwner: 'uid_A', now, timezone, today,
    days: Array.from({ length: RECENT_DAYS }, (_, n) => { const date = addCalendarDays(today, -n); return { date, ...calendarPlanInterval(date, timezone) }; }),
    plans: [], entries: [], captures: [], commitments: [], routines: [], coarse: [], stale: [], planAuthority: 'known', ...patch };
}
function plan(items, date = '2026-10-07', timezone = 'Asia/Manila') {
  return { id: `cal1:${date}`, date, timezone, ...calendarPlanInterval(date, timezone), items };
}
const item = (patch = {}) => ({ id: 'plan-one', task: 'Write', done: false, ...patch });
const entry = (patch = {}) => ({ id: 'e1', title: 'Write', startMs: NOW - 3600000, endMs: NOW - 1800000, eligible: true, ...patch });
const capture = (patch = {}) => buildCapture({ id: 'bd001', text: 'Call someone', now: NOW - 3000, updatedBy: 'test', ...patch }).record;
const commitment = (patch = {}) => buildCommitment({ id: 'apt001', title: 'Dentist', date: '2026-10-07', time: '09:00', timezone: 'Asia/Manila', now: NOW - 5000, updatedBy: 'test', ...patch }).record;
const run = patch => buildIntelligence(input(patch));

function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

test('empty signed-in account is empty, without fabricating actions or negative facts', () => {
  const r = run({}); assert.equal(r.state, 'ready');
  for (const k of ['attention', 'planActual', 'actuals', 'patterns', 'openLoops']) assert.deepEqual(r[k], []);
  assert.deepEqual(r.notes, []);
});
test('signed-out and mismatched context never expose sources', () => {
  for (const patch of [{ owner: null }, { contextOwner: 'uid_B' }]) {
    const r = run({ ...patch, plans: [plan([item()])], entries: [entry()], captures: [capture()] });
    assert.equal(r.state, 'unavailable'); assert.equal(r.planActual.length + r.actuals.length + r.openLoops.length, 0);
  }
});
test('only plans yield unknown actual, open state and attention; no did-not-happen claim', () => {
  const r = run({ plans: [plan([item()])] });
  assert.equal(r.planActual[0].kind, 'unknown'); assert.equal(r.planActual[0].status, 'Actual unknown');
  assert.match(r.planActual[0].detail, /does not mean/); assert.equal(r.attention.length, 1); assert.equal(r.openLoops.length, 1);
});
test('exact entry linkage yields work, never completion', () => {
  const r = run({ plans: [plan([item()])], entries: [entry({ planItemId: 'plan-one' })] });
  assert.equal(r.planActual[0].status, 'Recorded work'); assert.equal(r.planActual[0].kind, 'derived');
  assert.deepEqual(r.planActual[0].refs.map(r => r.source), ['plan', 'entry']); assert.equal(r.openLoops.length, 1);
});
test('same title without immutable link stays unknown and the actual remains separately visible', () => {
  const r = run({ plans: [plan([item()])], entries: [entry()] });
  assert.equal(r.planActual[0].kind, 'unknown'); assert.equal(r.actuals[0].status, 'Recorded · no plan link');
});
test('marked done is an explicit fact without invented actual duration', () => {
  const r = run({ plans: [plan([item({ done: true })])] });
  assert.equal(r.planActual[0].kind, 'fact'); assert.equal(r.planActual[0].status, 'Marked done');
  assert.equal(r.attention.length + r.openLoops.length + r.actuals.length, 0);
});
test('removed plan items and ineligible scheduled/passive intervals create no actual claims', () => {
  const r = run({ plans: [plan([item({ deleted: true })])], entries: [entry({ eligible: false })] });
  assert.equal(r.planActual.length + r.actuals.length + r.patterns.length, 0);
});
test('actual without plans is known and does not invent a plan', () => {
  const r = run({ entries: [entry()] }); assert.equal(r.actuals[0].kind, 'fact'); assert.equal(r.planActual.length, 0);
});
test('future intervals are unknown, never actuals', () => {
  const r = run({ entries: [entry({ endMs: NOW + 60000 })] });
  assert.equal(r.actuals.length, 0); assert.match(r.notes.join(), /future interval/);
});
test('untriaged and triaged captures are open; triage only determines supported attention flags', () => {
  const triaged = triageCapture(capture({ id: 'bd002' }), { important: true, urgent: false, now: NOW, updatedBy: 'test' }).record;
  const r = run({ captures: [capture(), triaged] }); assert.equal(r.openLoops.length, 2); assert.equal(r.attention.length, 1);
  assert.match(r.openLoops[0].detail, /does not itself create an obligation/);
});
test('archived and delegated captures are resolved, not outstanding commitments', () => {
  const a = archiveCapture(capture(), { now: NOW, updatedBy: 'test' }).record;
  const d = delegateCapture(capture({ id: 'bd002' }), { now: NOW, updatedBy: 'test' }).record;
  const r = run({ captures: [a, d] }); assert.equal(r.openLoops.length, 0);
});
test('pending promotion is visible as unknown and never asserted completed', () => {
  const c = triageCapture(capture(), { important: true, urgent: true, now: NOW - 2000, updatedBy: 'test' }).record;
  const claimed = claimPromotion(c, { promotion: { type: 'do-today', store: 'calendar', targetId: 'cal1:2026-10-07', planItemId: 'bdp1|bd001' }, now: NOW, updatedBy: 'test' }).record;
  assert.ok(claimed, 'valid canonical claim fixture');
  const r = run({ captures: [claimed] }); assert.equal(r.openLoops[0].kind, 'unknown'); assert.equal(r.openLoops[0].status, 'Promotion pending');
});
test('appointments have no completion authority: elapsed time stays unknown', () => {
  const r = run({ commitments: [commitment()] }); assert.equal(r.attention[0].kind, 'unknown'); assert.match(r.attention[0].status, /outcome unknown/); assert.equal(r.openLoops.length, 0);
});
test('upcoming and date-only appointments are facts; date-only noon is not a deadline', () => {
  const r = run({ commitments: [commitment({ time: '13:00' }), commitment({ id: 'apt002', precision: 'date', time: null })] });
  assert.ok(r.attention.every(r => r.kind === 'fact'));
});
test('deleted appointments and appointments beyond today are omitted', () => {
  const r = run({ commitments: [{ ...commitment(), deleted: true }, commitment({ id: 'apt002', date: '2026-10-08' })] }); assert.equal(r.attention.length, 0);
});
test('broad evidence is approximate day-scoped actual without placement or plan match', () => {
  const coarse = createCoarseEvidenceRecord({ date: '2026-10-07', timezone: 'Asia/Manila', label: 'Cooking', estimatedMinutes: 50, now: NOW });
  const r = run({ coarse: [coarse], plans: [plan([item({ task: 'Cooking' })])] });
  assert.equal(r.actuals[0].status, 'Approximate · no placement'); assert.equal(r.planActual[0].kind, 'unknown');
});
test('routine assertions, incomplete work, ambiguity and skips retain separate meanings', () => {
  const routines = ['complete', 'worked', 'unknown', 'ambiguous', 'skipped'].map((state, n) => ({ id: `routine${n}`, title: `Routine ${n}`, date: '2026-10-07', timezone: 'Asia/Manila', state, due: true }));
  const r = run({ routines }); assert.equal(r.planActual.length, 5); assert.equal(r.openLoops.length, 3); assert.equal(r.attention.length, 3);
  assert.equal(r.planActual[3].status, 'Ambiguous evidence');
});
test('stale source-owned unfinished plans stay open without an actual-negative assertion', () => {
  const r = run({ stale: [{ id: 'old:p1', planId: 'old', itemId: 'p1', task: 'Prepare', date: '2026-10-01' }] });
  assert.equal(r.openLoops[0].status, 'Previous plan still open'); assert.match(r.openLoops[0].detail, /no claim about what happened/);
});
test('identical duplicates are counted once; conflicting entry identity is omitted in either order', () => {
  const a = entry(); const b = entry({ title: 'Other' });
  assert.equal(run({ entries: [a, { ...a }] }).actuals.length, 1);
  const x = run({ entries: [a, b] }); assert.deepEqual(x, run({ entries: [b, a] })); assert.equal(x.actuals.length, 0); assert.match(x.notes.join(), /conflicting record e1/);
});
test('equal-authority plan item contradictions fail safely and independently of key order', () => {
  const a = item(); const b = { task: 'Other', done: false, id: 'plan-one' };
  const x = run({ plans: [plan([a, b])] }); assert.equal(x.planActual.length, 0);
  assert.deepEqual(x, run({ plans: [plan([b, a])] })); assert.match(x.notes.join(), /conflicting record/);
});
test('an entry potentially linked to multiple plan owners remains ambiguous', () => {
  const p = plan([item()]); const q = { ...p, id: 'legacy:overlap' };
  const r = run({ plans: [p, q], entries: [entry({ planItemId: 'plan-one' })] });
  assert.ok(r.planActual.every(row => row.status === 'Ambiguous link')); assert.equal(r.actuals[0].status, 'Recorded · link not resolved here');
});
test('unknown authority never projects even supplied plans as authoritative', () => {
  const r = run({ planAuthority: 'unknown', plans: [plan([item()])] }); assert.equal(r.planActual.length, 0); assert.match(r.notes.join(), /authority.*unknown/);
});
test('malformed/unavailable sources are surfaced without aborting valid sources', () => {
  const r = run({ entries: [null, entry({ id: '' }), entry()], captures: null, commitments: [{}] });
  assert.equal(r.actuals.length, 1); assert.match(r.notes.join(), /source unavailable/); assert.match(r.notes.join(), /malformed/);
});
test('derivation preserves deeply frozen input and ignores input ordering', () => {
  const x = input({ plans: [plan([item(), item({ id: 'p2', task: 'Alpha' })])], entries: [entry({ id: 'e2' }), entry()], captures: [capture({ id: 'bd002' }), capture()] });
  const before = JSON.stringify(x); const a = buildIntelligence(freeze(x)); assert.equal(JSON.stringify(x), before);
  const y = structuredClone(x); y.plans[0].items.reverse(); y.entries.reverse(); y.captures.reverse(); y.days.reverse(); assert.deepEqual(a, buildIntelligence(y));
});
function repeated(n) { return Array.from({ length: n }, (_, i) => entry({ id: `e${i}`, startMs: NOW - i * 86400000 - 3600000, endMs: NOW - i * 86400000 - 1800000 })); }
test('patterns require at least three distinct calendar dates, with exact evidence IDs', () => {
  assert.equal(run({ entries: repeated(PATTERN_MIN_DAYS - 1) }).patterns.length, 0);
  const r = run({ entries: repeated(PATTERN_MIN_DAYS) }); assert.equal(r.patterns.length, 1); assert.match(r.patterns[0].status, /3 of 7/); assert.equal(r.patterns[0].refs.length, 3);
});
test('repeated logs on a single date and dates outside the seven-date window cannot manufacture patterns', () => {
  assert.equal(run({ entries: repeated(3).map(e => ({ ...e, startMs: NOW - 3600000, endMs: NOW - 1800000 })) }).patterns.length, 0);
  assert.equal(run({ entries: repeated(3).map(e => ({ ...e, startMs: e.startMs - 7 * 86400000, endMs: e.endMs - 7 * 86400000 })) }).patterns.length, 0);
});
test('partial calendar windows abstain from recent patterns', () => {
  const x = input({ entries: repeated(3) }); x.days.pop(); const r = buildIntelligence(x); assert.equal(r.patterns.length, 0); assert.match(r.notes.join(), /windows are incomplete/);
});
for (const timezone of ['Asia/Manila', 'America/Phoenix', 'America/New_York', 'Pacific/Kiritimati']) {
  test(`calendar midnight uses authoritative ${timezone} boundaries and half-open intervals`, () => {
    const bounds = calendarPlanInterval('2026-10-07', timezone);
    const before = input({ timezone, now: bounds.startMs - 1, entries: [entry({ startMs: bounds.startMs - 60000, endMs: bounds.startMs - 1 })] });
    const after = input({ timezone, now: bounds.startMs, entries: before.entries });
    assert.equal(before.today, '2026-10-06'); assert.equal(after.today, '2026-10-07');
    assert.equal(buildIntelligence(before).actuals.length, 1); assert.equal(buildIntelligence(after).actuals.length, 0);
  });
}
for (const date of ['2026-03-08', '2026-11-01']) {
  test(`DST ${date} uses calendar dates, not 24h subtraction`, () => {
    const bounds = calendarPlanInterval(date, 'America/New_York');
    assert.equal((bounds.endMs - bounds.startMs) / 3600000, date.endsWith('03-08') ? 23 : 25);
    const x = input({ timezone: 'America/New_York', now: bounds.endMs - 1 }); assert.equal(buildIntelligence(x).state, 'ready'); assert.equal(x.days[1].date, addCalendarDays(date, -1));
  });
}
test('cross-midnight owner linkage uses the plan evidence window and retains its plan date', () => {
  const p = plan([item({ when: '01:00', whenDayOffset: 1, whenTz: 'Asia/Manila' })], '2026-10-06'); p.evidenceEndMs = calendarPlanInterval('2026-10-07', 'Asia/Manila').endMs;
  const r = run({ plans: [p], entries: [entry({ planItemId: 'plan-one' })] }); assert.equal(r.planActual[0].status, 'Recorded work'); assert.equal(r.planActual[0].planDate, '2026-10-06');
});
test('invalid dates and timezones abstain without throwing', () => {
  for (const patch of [{ today: '2026-02-30' }, { timezone: 'no/such-zone' }, { now: NaN }, { today: '2026-10-08' }]) assert.equal(buildIntelligence({ ...input(), ...patch }).state, 'unavailable');
});

test('malformed top-level input and optional notes cannot throw', () => {
  for (const value of [null, 42, [], 'invalid']) assert.equal(buildIntelligence(value).state, 'unavailable');
  assert.equal(run({ notes: 42 }).state, 'ready');
});
test('invalid extended plan window is omitted, never used to attribute unrelated work', () => {
  const p = plan([item()]); p.evidenceEndMs = Infinity;
  const r = run({ plans: [p], entries: [entry({ planItemId: 'plan-one' })] });
  assert.equal(r.planActual.length, 0); assert.match(r.notes.join(), /malformed/);
  assert.equal(r.actuals[0].status, 'Recorded · link not resolved here');
});

test('manual routine completion is labeled as an assertion, not an imported source fact', () => {
  const r = run({ routines: [{ id: 'manual:2026-10-07', title: 'Stretch', date: '2026-10-07', timezone: 'Asia/Manila', state: 'complete', source: 'manual' }] });
  assert.equal(r.planActual[0].kind, 'fact'); assert.equal(r.planActual[0].status, 'Manual assertion');
  assert.equal(r.openLoops.length, 0);
});

test('date-only appointment does not expire at its noon anchor in another account timezone', () => {
  const appointment = commitment({ precision: 'date', time: null, timezone: 'Pacific/Kiritimati' });
  const before = run({ timezone: 'America/Phoenix', now: Date.parse('2026-10-07T01:00:00-07:00'), commitments: [appointment] });
  assert.equal(before.attention[0].kind, 'fact');
  const after = run({ timezone: 'America/Phoenix', now: Date.parse('2026-10-07T03:00:00-07:00'), commitments: [appointment] });
  assert.equal(after.attention[0].kind, 'unknown'); assert.match(after.attention[0].status, /Scheduled time passed/);
});

test('finite numbers outside the JavaScript instant range are malformed, not source evidence', () => {
  assert.equal(buildIntelligence({ ...input(), now: 1e30 }).state, 'unavailable');
  const r = run({ entries: [entry({ startMs: -1e30 })] });
  assert.equal(r.actuals.length + r.patterns.length, 0); assert.match(r.notes.join(), /malformed/);
});

// INT-001: independent records, each attributed once by canonical start in the account zone.
test('INT-001: one eligible interval spanning three dates is not repeated evidence', () => {
  const r = run({ entries: [entry({ startMs: Date.parse('2026-10-05T10:00:00+08:00'), endMs: NOW })] });
  assert.equal(r.patterns.length, 0);
  assert.equal(r.actuals.length, 1, 'calendar actual interval attribution is unchanged');
});
test('INT-001: two independent records on two dates do not reach the threshold', () => {
  assert.equal(run({ entries: repeated(2) }).patterns.length, 0);
});
test('INT-001: three independent records on three dates produce exactly three-of-seven', () => {
  const r = run({ entries: repeated(3) });
  assert.equal(r.patterns.length, 1); assert.equal(r.patterns[0].status, 'Recorded on 3 of 7 calendar dates');
  assert.deepEqual(r.patterns[0].refs.map(r => r.id), ['e0', 'e1', 'e2']);
});
test('INT-001: cross-midnight record contributes only its start date, with same-date records deduplicated', () => {
  const records = [
    entry({ id: 'cross', startMs: Date.parse('2026-10-05T23:30:00+08:00'), endMs: Date.parse('2026-10-06T00:30:00+08:00') }),
    entry({ id: 'same', startMs: Date.parse('2026-10-05T10:00:00+08:00'), endMs: Date.parse('2026-10-05T11:00:00+08:00') }),
    entry({ id: 'previous', startMs: Date.parse('2026-10-04T10:00:00+08:00'), endMs: Date.parse('2026-10-04T11:00:00+08:00') }),
  ];
  assert.equal(run({ entries: records }).patterns.length, 0, 'only October 4 and 5 have canonical record starts');
  const third = entry({ id: 'third', startMs: Date.parse('2026-10-06T10:00:00+08:00'), endMs: Date.parse('2026-10-06T11:00:00+08:00') });
  const r = run({ entries: [...records, third] });
  assert.equal(r.patterns[0].status, 'Recorded on 3 of 7 calendar dates');
  assert.equal(r.patterns[0].refs.length, 4);
  assert.deepEqual(r, run({ entries: [third, ...records].reverse() }));
});
test('INT-001: a start outside the seven-date window does not enter via overlap', () => {
  const r = run({ entries: [entry({ id: 'before-window', startMs: Date.parse('2026-09-30T10:00:00+08:00'), endMs: NOW }), ...repeated(2)] });
  assert.equal(r.patterns.length, 0);
});
test('INT-001: the account timezone determines canonical start date, independently of UTC date and input order', () => {
  const records = [
    entry({ id: 'early', startMs: Date.parse('2026-10-05T06:30:00Z'), endMs: Date.parse('2026-10-05T07:30:00Z') }),
    entry({ id: 'same-utc', startMs: Date.parse('2026-10-05T08:00:00Z'), endMs: Date.parse('2026-10-05T09:00:00Z') }),
    entry({ id: 'next', startMs: Date.parse('2026-10-06T08:00:00Z'), endMs: Date.parse('2026-10-06T09:00:00Z') }),
  ];
  const now = Date.parse('2026-10-07T18:00:00Z');
  const utc = run({ timezone: 'Etc/UTC', now, entries: records });
  assert.equal(utc.patterns.length, 0, 'UTC has only October 5 and 6');
  const phoenix = run({ timezone: 'America/Phoenix', now, entries: records });
  assert.equal(phoenix.patterns[0].status, 'Recorded on 3 of 7 calendar dates', 'Phoenix has October 4, 5 and 6');
  assert.deepEqual(phoenix, run({ timezone: 'America/Phoenix', now, entries: [...records].reverse() }));
});
