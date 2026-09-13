import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePriorityRow, normalizeRoutineRow, normalizeTemplateRow, deriveTomorrowTimelinePreview } from './tomorrow-timeline-model.js';

const priority = (overrides = {}) => ({ id: 'p1', task: 'Buy eyedrops', when: '', done: false, ...overrides });
const routineRow = (overrides = {}) => ({
  id: '["r1","2026-09-14"]',
  routine: { title: 'Deep work', mode: 'exact', time: '09:00', endTime: '', cue: '' },
  skipped: false, actionable: true,
  ...overrides
});
const templateEntry = (overrides = {}) => ({ templateId: 't1', date: '2026-09-14', activity: 'Dinner', autoLog: false, startWhen: '04:00', endWhen: '04:30', ...overrides });

test('normalizePriorityRow: ranged priority carries both ends', () => {
  const row = normalizePriorityRow(priority({ when: '09:00', durationMinutes: 120 }));
  assert.equal(row.precision, 'ranged');
  assert.equal(row.startMinutes, 540);
  assert.equal(row.endMinutes, 660);
});

test('normalizePriorityRow: start-only priority never fabricates an end', () => {
  const row = normalizePriorityRow(priority({ when: '09:00' }));
  assert.equal(row.precision, 'start-only');
  assert.equal(row.endMinutes, null);
});

test('normalizePriorityRow: untimed priority (blank or legacy free text) has no clock position', () => {
  assert.equal(normalizePriorityRow(priority({ when: '' })).precision, 'untimed');
  assert.equal(normalizePriorityRow(priority({ when: 'after lunch' })).precision, 'untimed');
});

test('normalizePriorityRow: malformed duration safely degrades to start-only, never throws', () => {
  const row = normalizePriorityRow(priority({ when: '23:00', durationMinutes: 300 })); // would cross midnight
  assert.equal(row.precision, 'start-only');
  assert.equal(row.endMinutes, null);
});

test('normalizeRoutineRow: exact-mode routine is start-only', () => {
  const row = normalizeRoutineRow(routineRow());
  assert.equal(row.precision, 'start-only');
  assert.equal(row.startMinutes, 540);
});

test('normalizeRoutineRow: window-mode routine is ranged, same-day only', () => {
  const row = normalizeRoutineRow(routineRow({ routine: { title: 'Gym', mode: 'window', time: '17:00', endTime: '18:00' } }));
  assert.equal(row.precision, 'ranged');
  assert.equal(row.startMinutes, 1020);
  assert.equal(row.endMinutes, 1080);
});

test('normalizeRoutineRow: cue and anytime routines are honestly untimed', () => {
  assert.equal(normalizeRoutineRow(routineRow({ routine: { title: 'Stretch', mode: 'cue', cue: 'After dinner' } })).precision, 'untimed');
  assert.equal(normalizeRoutineRow(routineRow({ routine: { title: 'Read', mode: 'anytime' } })).precision, 'untimed');
});

test('normalizeRoutineRow: malformed exact/window schedule degrades to unknown, never throws', () => {
  assert.equal(normalizeRoutineRow(routineRow({ routine: { title: 'Bad', mode: 'exact', time: 'garbage' } })).precision, 'unknown');
  assert.equal(normalizeRoutineRow(routineRow({ routine: { title: 'Bad window', mode: 'window', time: '18:00', endTime: '17:00' } })).precision, 'unknown');
});

test('normalizeTemplateRow: same-day template is ranged and not flagged cross-midnight', () => {
  const row = normalizeTemplateRow(templateEntry());
  assert.equal(row.precision, 'ranged');
  assert.equal(row.crossesMidnight, false);
  assert.equal(row.startMinutes, 240);
  assert.equal(row.endMinutes, 270);
});

test('normalizeTemplateRow: cross-midnight template extends endMinutes past 1440 and is flagged', () => {
  const row = normalizeTemplateRow(templateEntry({ activity: 'Scribe shift', startWhen: '22:00', endWhen: '08:00' }));
  assert.equal(row.precision, 'ranged');
  assert.equal(row.crossesMidnight, true);
  assert.equal(row.startMinutes, 1320);
  assert.equal(row.endMinutes, 480 + 1440);
});

test('normalizeTemplateRow: autoLog true/false maps straight through from configuration, never inferred', () => {
  assert.equal(normalizeTemplateRow(templateEntry({ autoLog: true })).autoLog, true);
  assert.equal(normalizeTemplateRow(templateEntry({ autoLog: false })).autoLog, false);
});

test('normalizeTemplateRow: malformed schedule degrades to unknown, never throws', () => {
  assert.equal(normalizeTemplateRow(templateEntry({ startWhen: null, endWhen: null })).precision, 'unknown');
  assert.equal(normalizeTemplateRow(templateEntry({ startWhen: 'nonsense', endWhen: '04:30' })).precision, 'unknown');
});

test('deriveTomorrowTimelinePreview: empty inputs produce empty buckets', () => {
  const result = deriveTomorrowTimelinePreview({});
  assert.deepEqual(result.positioned, []);
  assert.deepEqual(result.unscheduled, []);
});

test('deriveTomorrowTimelinePreview: source classification labels are exact', () => {
  const result = deriveTomorrowTimelinePreview({
    priorityItems: [priority({ id: 'p1', when: '09:00' })],
    routineRows: [routineRow()],
    templateEntries: [templateEntry({ templateId: 't1', autoLog: false }), templateEntry({ templateId: 't2', activity: 'Scribe shift', autoLog: true, startWhen: '22:00', endWhen: '08:00' })]
  });
  const byId = Object.fromEntries(result.positioned.map(row => [row.id, row]));
  assert.equal(byId['priority:p1'].statusLabel, 'Planned priority');
  assert.equal(byId['routine:["r1","2026-09-14"]'].statusLabel, 'Planned routine');
  assert.equal(byId['template:t1:2026-09-14'].statusLabel, 'Template hint');
  assert.equal(byId['template:t2:2026-09-14'].statusLabel, 'Scheduled auto-log');
});

test('deriveTomorrowTimelinePreview: mixed rows sort by clock start regardless of input order', () => {
  const inputs = {
    priorityItems: [priority({ id: 'late', when: '14:00' }), priority({ id: 'early', when: '05:00' })],
    routineRows: [routineRow({ id: 'mid', routine: { title: 'Mid routine', mode: 'exact', time: '10:00' } })],
    templateEntries: []
  };
  const forward = deriveTomorrowTimelinePreview(inputs).positioned.map(r => r.id);
  const reversed = deriveTomorrowTimelinePreview({
    priorityItems: [...inputs.priorityItems].reverse(),
    routineRows: inputs.routineRows,
    templateEntries: []
  }).positioned.map(r => r.id);
  assert.deepEqual(forward, ['priority:early', 'routine:mid', 'priority:late']);
  assert.deepEqual(reversed, forward);
});

test('deriveTomorrowTimelinePreview: same-start ties break deterministically by id, never by title', () => {
  const inputs = {
    priorityItems: [priority({ id: 'z-task', task: 'Aardvark first alphabetically but not by id', when: '09:00' }), priority({ id: 'a-task', task: 'Zzz last alphabetically but not by id', when: '09:00' })]
  };
  const order = deriveTomorrowTimelinePreview(inputs).positioned.map(r => r.id);
  assert.deepEqual(order, ['priority:a-task', 'priority:z-task']);
});

test('deriveTomorrowTimelinePreview: overlapping rows are both shown, never merged or dropped', () => {
  const inputs = {
    priorityItems: [priority({ id: 'p1', when: '09:00', durationMinutes: 120 })],
    routineRows: [routineRow({ id: 'r1', routine: { title: 'Overlap routine', mode: 'window', time: '09:30', endTime: '10:00' } })]
  };
  const positioned = deriveTomorrowTimelinePreview(inputs).positioned;
  assert.equal(positioned.length, 2);
});

test('deriveTomorrowTimelinePreview: cross-midnight template sorts by its actual start on the target date, not a wrapped value', () => {
  // The template's occurrence starts at 22:00 on the target date itself (and ends the next
  // calendar day) — within the target date's own timeline it is later in the day than a 2 AM item.
  const inputs = {
    priorityItems: [priority({ id: 'early-morning', when: '02:00' })],
    templateEntries: [templateEntry({ templateId: 'night-shift', activity: 'Scribe shift', autoLog: true, startWhen: '22:00', endWhen: '08:00' })]
  };
  const order = deriveTomorrowTimelinePreview(inputs).positioned.map(r => r.id);
  assert.deepEqual(order, ['priority:early-morning', 'template:night-shift:2026-09-14']);
});

test('deriveTomorrowTimelinePreview: untimed and malformed rows land in unscheduled, never dropped silently', () => {
  const inputs = {
    priorityItems: [priority({ id: 'blank', when: '' })],
    routineRows: [routineRow({ id: 'cue-r', routine: { title: 'Cue routine', mode: 'cue', cue: 'After dinner' } })],
    templateEntries: [templateEntry({ templateId: 'bad', startWhen: null, endWhen: null })]
  };
  const unscheduled = deriveTomorrowTimelinePreview(inputs).unscheduled;
  assert.equal(unscheduled.length, 3);
  assert.deepEqual(new Set(unscheduled.map(r => r.sourceType)), new Set(['priority', 'routine', 'template']));
});

test('deriveTomorrowTimelinePreview: hostile title text passes through untouched (escaping is the renderer\'s job)', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const result = deriveTomorrowTimelinePreview({ priorityItems: [priority({ id: 'p1', task: hostile, when: '09:00' })] });
  assert.equal(result.positioned[0].title, hostile);
});
