// my-day-window.test.js
//
// Planning Continuity V1 — the My Day interval contract.
//
// "My Day" is the authoritative planning window Plan Authority already returns:
// half-open [startMs, endMs) in the account's own timezone. For an 18:00 Asia/Manila
// boundary it is Fri Sep 18 18:00 → Sat Sep 19 18:00. Real timestamps are never
// shifted; the boundary only decides grouping.
//
// These tests pin, with deterministic clocks and zones:
//   - which instants a My Day contains (exact start in, exact end out);
//   - that midnight does NOT roll an 18:00 My Day and 18:00 DOES;
//   - that schedule occurrences are projected by start instant, exactly once, via
//     PlanAuthority.templatesForTarget (the projection the Today timeline now uses);
//   - that commitments land on the My Day containing their startMs;
//   - that Planning Streak / readiness follow the authoritative My Day identity;
//   - 17:00 boundaries, custom 00:00, and legacy midnight behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlanAuthority } from './plan-authority.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { buildCommitment, commitmentsForTarget } from './commitments-model.js';

const MANILA = 'Asia/Manila';
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);

const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

function legacyStore() {
  const plans = {};
  return {
    plans,
    record: k => plans[k] || null,
    rawItems: k => (plans[k]?.items || []).map(i => ({ ...i })),
    saveItems(k, items) { plans[k] = { ...(plans[k] || {}), items, updatedAt: 1000 }; },
    confirm: () => ({ localSaved: true, syncPromise: Promise.resolve(false) }),
    allPlans: () => plans,
    earliestPlanDate() { const ks = Object.keys(plans).sort(); return ks.length ? ks[0] : null; },
  };
}

let seq = 0;

/** An app whose boundary (if any) became effective on Sep 1, so every day under test
 *  is governed by it rather than being a transition day. */
function makeApp({ boundaryTime = '18:00', enabled = true } = {}) {
  const nowRef = { value: at('2026-09-01', '10:00') };
  const legacy = legacyStore();
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage: memory(), idGenerator: () => `rev-${++seq}` });
  const planRepository = createOperationalPlanRepository({ storage: memory() });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => nowRef.value, deviceId: () => 'device-a', fallbackTimezone: () => MANILA,
  });
  const authority = createPlanAuthority({ live, legacy, now: () => nowRef.value, accountTimezone: () => MANILA });
  if (enabled) live.proposeBoundary({ boundaryTime, timezone: MANILA });
  return { authority, live, setNow: v => { nowRef.value = v; } };
}

const contains = (target, ms) => ms >= target.startMs && ms < target.endMs;

// ═══════════════════════════════════════════════════════════════════════
// 1. the interval itself
// ═══════════════════════════════════════════════════════════════════════

test('18:00 My Day is exactly [Sep 18 18:00, Sep 19 18:00)', () => {
  const app = makeApp();
  app.setNow(at('2026-09-19', '14:44'));
  const myDay = app.authority.current();
  assert.equal(myDay.store, 'operational');
  assert.equal(myDay.startMs, at('2026-09-18', '18:00'));
  assert.equal(myDay.endMs, at('2026-09-19', '18:00'));
  for (const [date, hhmm] of [['2026-09-18', '18:00'], ['2026-09-18', '22:00'], ['2026-09-18', '23:59'], ['2026-09-19', '00:00'], ['2026-09-19', '09:00'], ['2026-09-19', '17:59']]) {
    assert.ok(contains(myDay, at(date, hhmm)), `${date} ${hhmm} must be inside My Day`);
  }
  for (const [date, hhmm] of [['2026-09-18', '17:59'], ['2026-09-19', '18:00'], ['2026-09-19', '22:00']]) {
    assert.ok(!contains(myDay, at(date, hhmm)), `${date} ${hhmm} must be outside My Day`);
  }
});

test('exact 18:00 belongs to the NEXT My Day', () => {
  const app = makeApp();
  app.setNow(at('2026-09-19', '14:44'));
  const current = app.authority.current();
  const next = app.authority.containing(at('2026-09-19', '18:00'));
  assert.notEqual(next.id, current.id);
  assert.equal(next.startMs, at('2026-09-19', '18:00'));
  assert.equal(next.id, app.authority.upcoming().id);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. rollover: midnight does not roll, the boundary does
// ═══════════════════════════════════════════════════════════════════════

test('18:00 boundary: 17:59 → 18:00 rolls; 23:59 → 00:00 → 05:00 does NOT', () => {
  const app = makeApp();
  const idAt = (date, hhmm) => { app.setNow(at(date, hhmm)); return app.authority.current().id; };
  const before = idAt('2026-09-18', '17:59');
  const start = idAt('2026-09-18', '18:00');
  assert.notEqual(before, start, '18:00 starts a new My Day');
  assert.equal(idAt('2026-09-18', '23:59'), start);
  assert.equal(idAt('2026-09-19', '00:00'), start, 'midnight alone does not roll My Day');
  assert.equal(idAt('2026-09-19', '05:00'), start);
  assert.equal(idAt('2026-09-19', '17:59'), start);
  assert.notEqual(idAt('2026-09-19', '18:00'), start, 'the next 18:00 rolls it');
});

test('17:00 boundary behaves the same way at its own time', () => {
  const app = makeApp({ boundaryTime: '17:00' });
  const idAt = (date, hhmm) => { app.setNow(at(date, hhmm)); return app.authority.current().id; };
  const day = idAt('2026-09-18', '17:00');
  assert.notEqual(idAt('2026-09-18', '16:59'), day);
  assert.equal(idAt('2026-09-19', '00:00'), day);
  assert.equal(idAt('2026-09-19', '16:59'), day);
  assert.notEqual(idAt('2026-09-19', '17:00'), day);
  app.setNow(at('2026-09-19', '09:00'));
  const t = app.authority.current();
  assert.equal(t.startMs, at('2026-09-18', '17:00'));
  assert.equal(t.endMs, at('2026-09-19', '17:00'));
});

test('custom 00:00 is operational (not legacy) and spans calendar midnight to midnight', () => {
  const app = makeApp({ boundaryTime: '00:00' });
  app.setNow(at('2026-09-19', '14:44'));
  const t = app.authority.current();
  assert.equal(t.store, 'operational', 'a configured 00:00 is still a custom boundary internally');
  assert.equal(t.startMs, at('2026-09-19', '00:00'));
  assert.equal(t.endMs, at('2026-09-20', '00:00'));
  app.setNow(at('2026-09-19', '23:59'));
  assert.equal(app.authority.current().id, t.id);
  app.setNow(at('2026-09-20', '00:00'));
  assert.notEqual(app.authority.current().id, t.id, 'at 00:00 midnight IS the boundary');
});

test('a legacy account keeps plain calendar days that roll at midnight', () => {
  const app = makeApp({ enabled: false });
  app.setNow(at('2026-09-18', '23:59'));
  const t = app.authority.current();
  assert.equal(t.store, 'legacy');
  assert.equal(t.dateKey, '2026-09-18');
  app.setNow(at('2026-09-19', '00:00'));
  assert.equal(app.authority.current().dateKey, '2026-09-19');
});

// ═══════════════════════════════════════════════════════════════════════
// 3. schedule projection (what the Today timeline now calls)
// ═══════════════════════════════════════════════════════════════════════

/** A stand-in for index.html's generateTemplateEntries(dateKey): each template occurs
 *  on every date at its own local start time, like the real recurring blocks. */
function templatesByDate(templates) {
  return dateKey => templates.map(tpl => {
    const tsStart = at(dateKey, tpl.start);
    let tsEnd = at(dateKey, tpl.end);
    if (tsEnd <= tsStart) tsEnd += 86400000; // crosses midnight
    return { id: `tpl_${tpl.id}_${dateKey}`, templateId: tpl.id, tsStart, ts: tsEnd, date: dateKey, activity: tpl.id, template: true };
  });
}

test('schedule occurrences are projected by start instant into [startMs, endMs)', () => {
  const app = makeApp();
  app.setNow(at('2026-09-19', '14:44'));
  const myDay = app.authority.current();
  const templates = [
    { id: 'evening', start: '18:00', end: '19:00' },
    { id: 'late', start: '22:00', end: '23:00' },
    { id: 'night', start: '23:00', end: '23:30' },
    { id: 'midnight', start: '00:00', end: '00:30' },
    { id: 'early', start: '04:00', end: '05:00' },
    { id: 'morning', start: '08:30', end: '09:00' },
    { id: 'work', start: '09:00', end: '12:00' },
    { id: 'afternoon', start: '17:59', end: '18:30' },
  ];
  const projected = app.authority.templatesForTarget(myDay, templatesByDate(templates));
  const seen = projected.map(e => [e.templateId, e.date]).sort();
  assert.deepEqual(seen, [
    ['afternoon', '2026-09-19'], ['early', '2026-09-19'], ['evening', '2026-09-18'], ['late', '2026-09-18'],
    ['midnight', '2026-09-19'], ['morning', '2026-09-19'], ['night', '2026-09-18'], ['work', '2026-09-19'],
  ], 'previous evening from 18:00, this date before 18:00');
  // Excluded: Sep 18 before 18:00 (the "afternoon" 17:59 of Sep 18), and Sep 19 18:00 onward.
  assert.ok(!projected.some(e => e.date === '2026-09-18' && e.templateId === 'afternoon'));
  assert.ok(!projected.some(e => e.date === '2026-09-19' && ['evening', 'late', 'night'].includes(e.templateId)));
  assert.ok(projected.every(e => contains(myDay, e.tsStart)));
});

test('a schedule block crossing calendar midnight appears exactly once', () => {
  const app = makeApp();
  app.setNow(at('2026-09-19', '10:00'));
  const myDay = app.authority.current();
  const projected = app.authority.templatesForTarget(myDay, templatesByDate([{ id: 'sleep', start: '22:30', end: '06:30' }]));
  assert.equal(projected.length, 1);
  assert.equal(projected[0].tsStart, at('2026-09-18', '22:30'));
  assert.equal(projected[0].ts, at('2026-09-19', '06:30'));
});

test('the same schedule occurrence is never returned twice even if two dates both produce it', () => {
  const app = makeApp();
  app.setNow(at('2026-09-19', '10:00'));
  const myDay = app.authority.current();
  const duplicate = dateKey => [{ id: `x_${dateKey}`, templateId: 'dup', tsStart: at('2026-09-18', '20:00'), ts: at('2026-09-18', '21:00'), date: '2026-09-18' }];
  assert.equal(app.authority.templatesForTarget(myDay, duplicate).length, 1);
});

test('the NEXT My Day holds the 18:00-and-later occurrences of Sep 19', () => {
  const app = makeApp();
  app.setNow(at('2026-09-19', '14:44'));
  const next = app.authority.upcoming();
  const projected = app.authority.templatesForTarget(next, templatesByDate([
    { id: 'evening', start: '18:00', end: '19:00' }, { id: 'late', start: '22:00', end: '23:00' },
  ]));
  assert.deepEqual(projected.map(e => [e.templateId, e.date]).sort(), [['evening', '2026-09-19'], ['late', '2026-09-19']]);
});

test('custom 00:00 projects exactly the calendar date, like the legacy view', () => {
  const app = makeApp({ boundaryTime: '00:00' });
  app.setNow(at('2026-09-19', '10:00'));
  const projected = app.authority.templatesForTarget(app.authority.current(), templatesByDate([
    { id: 'late', start: '22:00', end: '23:00' }, { id: 'early', start: '04:00', end: '05:00' },
  ]));
  assert.deepEqual(projected.map(e => e.date), ['2026-09-19', '2026-09-19']);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. commitments
// ═══════════════════════════════════════════════════════════════════════

const commitment = (id, date, time) => buildCommitment({ id, title: id, date, time, timezone: MANILA, now: at('2026-09-01', '09:00'), updatedBy: 'd' }).record;

test('a 09:30 commitment is in the current My Day; one at exactly 18:00 is in the next', () => {
  const app = makeApp();
  app.setNow(at('2026-09-19', '14:44'));
  const records = [commitment('cmorning', '2026-09-19', '09:30'), commitment('cexact', '2026-09-19', '18:00')];
  assert.deepEqual(commitmentsForTarget(records, app.authority.current()).map(r => r.id), ['cmorning']);
  assert.deepEqual(commitmentsForTarget(records, app.authority.upcoming()).map(r => r.id), ['cexact']);
  // The stored instants are the real times, untouched.
  assert.equal(records[0].startMs, at('2026-09-19', '09:30'));
  assert.equal(records[1].startMs, at('2026-09-19', '18:00'));
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Planning Streak / readiness follow My Day identity
// ═══════════════════════════════════════════════════════════════════════

const priority = (id, task) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'd' });

test('streak and readiness do not reset at midnight and do roll at 18:00', () => {
  const app = makeApp();
  // At 20:00 on Sep 18 the current My Day is Sep 18 18:00 → Sep 19 18:00. Preparing
  // the NEXT My Day (Sep 19 18:00 →) before it starts earns today's habit credit.
  app.setNow(at('2026-09-18', '20:00'));
  const today = app.authority.current();
  const next = app.authority.upcoming();
  app.authority.confirmPreparation(next, { items: [priority('p1', 'tomorrow thing')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });

  const snapshot = (date, hhmm) => {
    app.setNow(at(date, hhmm));
    const s = app.authority.streak();
    return { currentId: app.authority.current().id, upcomingId: app.authority.upcoming().id, todayEarned: s.todayEarned, current: s.current, nextReady: app.authority.readyNow(next) };
  };

  for (const [date, hhmm] of [['2026-09-18', '23:59'], ['2026-09-19', '00:00'], ['2026-09-19', '05:00'], ['2026-09-19', '17:59']]) {
    const s = snapshot(date, hhmm);
    assert.equal(s.currentId, today.id, `${date} ${hhmm}: still the same My Day`);
    assert.equal(s.upcomingId, next.id, `${date} ${hhmm}: the prepared day is still "next"`);
    assert.equal(s.todayEarned, true, `${date} ${hhmm}: habit credit survives midnight`);
    assert.equal(s.nextReady, true);
  }

  const rolled = snapshot('2026-09-19', '18:00');
  assert.equal(rolled.currentId, next.id, '18:00 makes the prepared day current');
  assert.notEqual(rolled.upcomingId, next.id);
  assert.equal(rolled.todayEarned, false, 'the new My Day has not prepared ITS next day yet');
  assert.ok(rolled.current >= 1, 'yesterday\'s earned habit day is kept as finalized history');
});

test('17:59 vs 18:00: the upcoming (preparable) day switches only at the boundary', () => {
  const app = makeApp();
  app.setNow(at('2026-09-19', '17:59'));
  const beforeUpcoming = app.authority.upcoming().id;
  app.setNow(at('2026-09-19', '18:00'));
  assert.equal(app.authority.current().id, beforeUpcoming);
});
