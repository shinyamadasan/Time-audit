import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPartnerViewPriority, buildPartnerViewTimelineItem, buildPartnerViewProjection,
  partnerViewSignature, validatePartnerViewProjection
} from './partner-view-model.js';

// ── PRIORITY ROW ─────────────────────────────────────────────────────────────

test('priority row: title/plannedTime/done/statusLabel pass through, everything else does not', () => {
  const row = buildPartnerViewPriority({ title: 'Finish app', plannedTime: '09:00', done: false, statusLabel: 'In progress', secret: 'x', id: 'p1' });
  assert.deepEqual(Object.keys(row).sort(), ['done', 'plannedTime', 'statusLabel', 'title']);
  assert.equal(row.title, 'Finish app');
  assert.equal(row.plannedTime, '09:00');
  assert.equal(row.statusLabel, 'In progress');
});

test('priority row: empty title is dropped entirely (never a blank row)', () => {
  assert.equal(buildPartnerViewPriority({ title: '   ' }), null);
  assert.equal(buildPartnerViewPriority(null), null);
});

test('priority row: unknown statusLabel coerced to a safe default from done', () => {
  assert.equal(buildPartnerViewPriority({ title: 'A', done: true, statusLabel: 'CRUSHING_IT' }).statusLabel, 'Done');
  assert.equal(buildPartnerViewPriority({ title: 'A', done: false, statusLabel: 'CRUSHING_IT' }).statusLabel, 'Not started');
});

// ── TIMELINE ROW — evidence truth boundaries ────────────────────────────────

test('gap row never carries activity/energy/evidenceLabel — gap != waste', () => {
  const row = buildPartnerViewTimelineItem({ kind: 'gap', tsStart: 1000, tsEnd: 2000, activity: 'sneaky', energy: 'waste', evidenceLabel: 'OBSERVED' });
  assert.deepEqual(Object.keys(row).sort(), ['kind', 'tsEnd', 'tsStart']);
  assert.equal(row.kind, 'gap');
});

test('template row never carries an evidenceLabel — template hint != actual/observed', () => {
  const row = buildPartnerViewTimelineItem({ kind: 'template', activity: 'Hygiene', energy: 'recovery', tsStart: 1, tsEnd: 2, evidenceLabel: 'OBSERVED', autoLog: true });
  assert.equal('evidenceLabel' in row, false);
  assert.equal(row.autoLog, true);
});

test('observed row carries the OBSERVED evidence label; a confirmed manual actual carries none', () => {
  const observed = buildPartnerViewTimelineItem({ kind: 'observed', activity: 'Facebook', energy: 'waste', tsStart: 1, tsEnd: 2, evidenceLabel: 'OBSERVED' });
  assert.equal(observed.evidenceLabel, 'OBSERVED');
  const actual = buildPartnerViewTimelineItem({ kind: 'actual', activity: 'Scribe shift', energy: 'nine5', tsStart: 1, tsEnd: 2, evidenceLabel: null });
  assert.equal('evidenceLabel' in actual, false);
});

test('an unrecognized kind or missing tsEnd is dropped, never passed through raw', () => {
  assert.equal(buildPartnerViewTimelineItem({ kind: 'made-up', tsEnd: 1 }), null);
  assert.equal(buildPartnerViewTimelineItem({ kind: 'actual', tsEnd: null }), null);
});

test('unknown energy values are dropped rather than passed through raw', () => {
  const row = buildPartnerViewTimelineItem({ kind: 'actual', activity: 'X', energy: 'made-up-energy', tsStart: 1, tsEnd: 2 });
  assert.equal('energy' in row, false);
});

// ── PROJECTION — allowlist against a maximal hostile input ─────────────────

test('the projection builder never emits anything outside the V1 allowlist, even given a maximal hostile input', () => {
  const projection = buildPartnerViewProjection({
    dateKey: '2026-09-12',
    priorities: [{ title: 'Finish app', done: false, statusLabel: 'In progress', secretId: 'p1', walletBalance: 42 }],
    soFar: { deepMin: 90, wasteMin: 45, focusMinutes: 999, streak: 30 },
    timelineItems: [
      { kind: 'actual', activity: 'Scribe shift', energy: 'nine5', tsStart: 1, tsEnd: 2, url: 'evil.com', deviceId: 'd1' },
      { kind: 'observed', activity: 'Facebook', energy: 'waste', tsStart: 3, tsEnd: 4, evidenceLabel: 'OBSERVED', rawUrl: 'https://facebook.com/secret' },
      { kind: 'gap', tsStart: 5, tsEnd: 6 },
      { kind: 'template', activity: 'Hygiene', energy: 'recovery', tsStart: 7, tsEnd: 8, autoLog: false }
    ],
    tomorrowDateKey: '2026-09-13',
    tomorrowPriorities: [{ title: 'Client build', plannedTime: '21:00' }],
    // planted hostile top-level fields never read by this builder:
    score: 100, wallet: { balance: 500 }, entries: [{ url: 'https://reddit.com' }], notes: 'do not leak me'
  });

  const serialized = JSON.stringify(projection);
  const forbidden = ['secretid', 'wallet', 'streak', 'focusminutes', 'url', 'deviceid', 'notes', 'score', 'reddit', 'facebook.com/secret'];
  for (const bad of forbidden) {
    assert.equal(serialized.toLowerCase().includes(bad), false, `projection leaked forbidden term "${bad}": ${serialized}`);
  }

  assert.deepEqual(Object.keys(projection).sort(), ['today', 'tomorrow']);
  assert.deepEqual(Object.keys(projection.today).sort(), ['dateKey', 'priorities', 'soFar', 'timeline']);
  assert.deepEqual(Object.keys(projection.today.soFar).sort(), ['deepMin', 'wasteMin']);
  assert.equal(projection.today.soFar.deepMin, 90);
  assert.equal(projection.today.soFar.wasteMin, 45);
  assert.equal(projection.today.timeline.length, 4);
  assert.deepEqual(Object.keys(projection.tomorrow).sort(), ['dateKey', 'priorities']);
  assert.equal(projection.tomorrow.priorities[0].plannedTime, '21:00');
});

test('caps priorities at 3 and timeline at 150 even given far more input', () => {
  const priorities = Array.from({ length: 10 }, (_, i) => ({ title: `P${i}` }));
  const timelineItems = Array.from({ length: 400 }, (_, i) => ({ kind: 'gap', tsStart: i, tsEnd: i + 1 }));
  const projection = buildPartnerViewProjection({ dateKey: '2026-09-12', priorities, soFar: {}, timelineItems });
  assert.equal(projection.today.priorities.length, 3);
  assert.equal(projection.today.timeline.length, 150);
});

test('missing dateKey refuses to build at all — no half-formed projection can be published', () => {
  assert.equal(buildPartnerViewProjection({ dateKey: '' }), null);
  assert.equal(buildPartnerViewProjection({}), null);
});

// ── WRITE DEDUPE ─────────────────────────────────────────────────────────────

test('signature changes when a Timeline entry is added, even with priorities/soFar unchanged', () => {
  const base = { dateKey: '2026-09-12', priorities: [], soFar: { deepMin: 0, wasteMin: 0 }, timelineItems: [] };
  const a = buildPartnerViewProjection(base);
  const b = buildPartnerViewProjection({ ...base, timelineItems: [{ kind: 'actual', activity: 'X', energy: 'deep', tsStart: 1, tsEnd: 2 }] });
  assert.notEqual(partnerViewSignature(a), partnerViewSignature(b));
});

test('signature is identical for two builds of the same content', () => {
  const input = { dateKey: '2026-09-12', priorities: [{ title: 'A', done: true }], soFar: { deepMin: 10, wasteMin: 0 }, timelineItems: [{ kind: 'gap', tsStart: 1, tsEnd: 2 }] };
  assert.equal(partnerViewSignature(buildPartnerViewProjection(input)), partnerViewSignature(buildPartnerViewProjection(input)));
});

// ── READ-SIDE VALIDATION ─────────────────────────────────────────────────────

test('validatePartnerViewProjection strips a hostile/legacy node down to the allowlist', () => {
  const hostile = {
    today: { dateKey: '2026-09-12', priorities: [{ title: 'X', done: true, secret: 1 }], soFar: { deepMin: 5, wasteMin: 1, streak: 9 }, timeline: [{ kind: 'gap', tsStart: 1, tsEnd: 2, energy: 'waste' }] },
    tomorrow: { dateKey: '2026-09-13', priorities: [{ title: 'Y' }] },
    score: 100, review: 'leak'
  };
  const clean = validatePartnerViewProjection(hostile);
  assert.deepEqual(Object.keys(clean).sort(), ['today', 'tomorrow']);
  assert.deepEqual(Object.keys(clean.today.timeline[0]).sort(), ['kind', 'tsEnd', 'tsStart']);
});

test('validatePartnerViewProjection fails closed to null on missing/malformed shape', () => {
  assert.equal(validatePartnerViewProjection(null), null);
  assert.equal(validatePartnerViewProjection({}), null);
  assert.equal(validatePartnerViewProjection({ today: {} }), null);
});

// ── HOUSEHOLD MY DAY V1: OPT-IN FULL DAILY LIST ─────────────────────────────
test('full daily list is absent unless the publisher passes it (consent off by default)', () => {
  const p = buildPartnerViewProjection({ dateKey: '2026-11-25', priorities: [{ title: 'A' }] });
  assert.equal(p.today.dailyTasksShared, undefined);
  assert.equal(p.today.dailyTasks, undefined);
  const v = validatePartnerViewProjection(p);
  assert.equal(v.today.dailyTasksShared, undefined);
  assert.equal(v.today.dailyTasks, undefined);
});

test('full daily list keeps more than three tasks, allowlists fields, dedupes ids and bounds length', () => {
  const tasks = Array.from({ length: 130 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, done: i === 1, when: i === 0 ? '09:30' : 'bad', statusLabel: 'In progress', secret: 'x', description: 'private' }));
  tasks.splice(5, 0, { id: 't0', title: 'Duplicate' });
  const p = buildPartnerViewProjection({ dateKey: '2026-11-25', priorities: [], dailyTasks: tasks });
  assert.equal(p.today.dailyTasksShared, true);
  assert.equal(p.today.dailyTasks.length, 100);
  assert.deepEqual(p.today.dailyTasks[0], { id: 't0', title: 'Task 0', done: false, when: '09:30', statusLabel: 'In progress' });
  assert.deepEqual(p.today.dailyTasks[1], { id: 't1', title: 'Task 1', done: true, statusLabel: 'Done' });
  assert.ok(!p.today.dailyTasks.some(t => t.title === 'Duplicate'));
  assert.equal(p.today.priorities.length, 0, 'the top-3 priorities remain separate');
});

test('shared but empty survives RTDB dropping the empty array', () => {
  const p = buildPartnerViewProjection({ dateKey: '2026-11-25', dailyTasks: [] });
  assert.deepEqual([p.today.dailyTasksShared, p.today.dailyTasks], [true, undefined]);
  const v = validatePartnerViewProjection(JSON.parse(JSON.stringify(p)));
  assert.deepEqual([v.today.dailyTasksShared, v.today.dailyTasks], [true, []]);
});

test('read side: a hostile node without the consent marker never exposes a list; malformed rows are dropped', () => {
  const hostile = { today: { dateKey: '2026-11-25', dailyTasks: [{ id: 'a', title: 'Leak' }] } };
  assert.equal(validatePartnerViewProjection(hostile).today.dailyTasks, undefined);
  const v = validatePartnerViewProjection({ today: { dateKey: '2026-11-25', dailyTasksShared: true,
    dailyTasks: [{ id: 'a', title: 'Ok', done: 'yes' }, { title: 'no id' }, null, { id: 'b', title: '' }] } });
  assert.deepEqual(v.today.dailyTasks, [{ id: 'a', title: 'Ok', done: false, statusLabel: 'Not started' }]);
});
