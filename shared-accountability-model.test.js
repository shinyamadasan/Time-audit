import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveTodayItemStatus, deriveTomorrowPrepStatus, dateKeyInTimezone, isSharedTodayFresh,
  formatFreshness, buildSharedPayload, sharedPayloadSignature, validateSharedPayload
} from './shared-accountability-model.js';

// ── STATUS TESTS (mandatory) ────────────────────────────────────────────────

test('plan exists, no actual -> planned', () => {
  assert.equal(deriveTodayItemStatus({ id: 'p1', task: 'Write report', done: false }, 0), 'planned');
});

test('plan exists, linked actual, not done -> worked-on', () => {
  assert.equal(deriveTodayItemStatus({ id: 'p1', task: 'Write report', done: false }, 45), 'worked-on');
});

test('plan explicitly done -> done', () => {
  assert.equal(deriveTodayItemStatus({ id: 'p1', task: 'Write report', done: true }, 0), 'done');
});

test('3 hours linked actual but not done -> worked-on, never done (minutes cannot imply completion)', () => {
  assert.equal(deriveTodayItemStatus({ id: 'p1', task: 'Finish proposal', done: false }, 180), 'worked-on');
});

test('done overrides any minute count', () => {
  assert.equal(deriveTodayItemStatus({ id: 'p1', task: 'Finish proposal', done: true }, 0), 'done');
  assert.equal(deriveTodayItemStatus({ id: 'p1', task: 'Finish proposal', done: true }, 500), 'done');
});

test('same-title different planItemId does not cross-contaminate (caller-level linkage, asserted at the payload boundary)', () => {
  // The model only ever sees whatever trackedMinutes the caller computed for THIS item's
  // id (planTrackedMin(task, dateKey, item.id) in index.html) — a second item sharing the
  // same title but a different id must be derived independently.
  const a = deriveTodayItemStatus({ id: 'p1', task: 'Read', done: false }, 0);
  const b = deriveTodayItemStatus({ id: 'p2', task: 'Read', done: false }, 30);
  assert.equal(a, 'planned');
  assert.equal(b, 'worked-on');
});

// ── TOMORROW TESTS (mandatory) ──────────────────────────────────────────────

test('prepared -> PREPARED', () => {
  assert.equal(deriveTomorrowPrepStatus({ intentionalBlank: false, oneOffItemIds: ['x'] }), 'prepared');
});

test('open day -> OPEN DAY', () => {
  assert.equal(deriveTomorrowPrepStatus({ intentionalBlank: true, oneOffItemIds: [] }), 'open-day');
});

test('nothing confirmed -> NOT PREPARED YET', () => {
  assert.equal(deriveTomorrowPrepStatus(null), 'not-prepared');
  assert.equal(deriveTomorrowPrepStatus(undefined), 'not-prepared');
});

test('shared tomorrow object never contains task titles, times, or notes', () => {
  const payload = buildSharedPayload({
    timezone: 'Asia/Manila', dateKey: '2026-09-11', updatedAt: 1000,
    todayItems: [], tomorrowDateKey: '2026-09-12', tomorrowPrepStatus: 'prepared'
  });
  assert.deepEqual(Object.keys(payload.tomorrow).sort(), ['dateKey', 'prepStatus']);
  assert.equal(JSON.stringify(payload.tomorrow).includes('title'), false);
});

// ── STALE / TIMEZONE TESTS (mandatory) ──────────────────────────────────────

test('publisher Manila day is evaluated independent of viewer device timezone', () => {
  // 2026-09-11 08:00 UTC is 2026-09-11 16:00 in Manila (+8) and 2026-09-11 01:00 in
  // Phoenix (-7) — same instant, both timezones already on the 11th.
  const instant = Date.parse('2026-09-11T08:00:00Z');
  assert.equal(dateKeyInTimezone(instant, 'Asia/Manila'), '2026-09-11');
  assert.equal(dateKeyInTimezone(instant, 'America/Phoenix'), '2026-09-11');
});

test('stale payload from publisher prior day is never treated as current, regardless of viewer zone', () => {
  // Publisher (Manila) published yesterday. "Now" has rolled into Manila's next day.
  const publishedAt = Date.parse('2026-09-10T10:00:00Z'); // 2026-09-10 18:00 Manila
  const now = Date.parse('2026-09-11T20:00:00Z');          // 2026-09-12 04:00 Manila — new Manila day
  assert.equal(isSharedTodayFresh(now, 'Asia/Manila', '2026-09-10'), false);
  // Control: same publisher, current Manila day, is fresh.
  assert.equal(isSharedTodayFresh(publishedAt, 'Asia/Manila', '2026-09-10'), true);
});

test('an invalid-but-present publisher timezone fails safe to "not fresh" instead of throwing', () => {
  // Reachable only via corrupted sync data or direct tampering of an owner's own /shared
  // node (rules bar anyone else from writing it) — the app's own timezone <select> can
  // never produce this. It must still never crash the render and must never fall back
  // to treating the viewer's own timezone as authoritative.
  assert.doesNotThrow(() => isSharedTodayFresh(Date.now(), 'Not/AZone', '2026-09-11'));
  assert.equal(isSharedTodayFresh(Date.now(), 'Not/AZone', '2026-09-11'), false);
});

test('control: a well-formed publisher timezone with the current publisher day still renders fresh', () => {
  const now = Date.parse('2026-09-11T08:00:00Z'); // 2026-09-11 16:00 in Manila
  assert.equal(isSharedTodayFresh(now, 'Asia/Manila', '2026-09-11'), true);
});

test('freshness copy stays coarse and never shows raw timestamps or "last seen"', () => {
  const now = 1_000_000_000;
  assert.equal(formatFreshness(now, now - 2 * 60 * 1000), 'Updated recently');
  assert.equal(formatFreshness(now, now - 40 * 60 * 1000), 'Updated 40m ago');
  assert.equal(formatFreshness(now, now - 3 * 60 * 60 * 1000), 'Updated 3h ago');
  assert.equal(formatFreshness(now, now - 2 * 24 * 60 * 60 * 1000), 'Updated 2d ago');
});

// ── PRIVACY ALLOWLIST TEST (mandatory) ──────────────────────────────────────

test('the real payload builder never emits anything outside the V1 allowlist, even given a maximal hostile input', () => {
  // A maximal internal state, as if someone tried to leak everything through this one
  // call by attaching every kind of private field an attacker (or a careless caller)
  // might have lying around on the objects it touches.
  const maximalTodayItems = [
    {
      title: 'Finish proposal', status: 'worked-on',
      // planted private fields that must never survive into the payload:
      id: 'secret-plan-id-123', deepMinutes: 240, wasteMinutes: 90, focusMinutes: 300,
      streak: 14, score: 87, walletBalance: 42, reviewText: 'felt distracted all day',
      url: 'https://reddit.com/r/all', domain: 'reddit.com', timelineEntries: ['e1', 'e2'],
      notes: 'private note about my partner', deviceId: 'device-xyz', completedAt: 1234567,
      exactDurationMin: 137, browserTabs: ['tab1'], appName: 'Slack', location: 'home'
    },
    { title: 'Read a book', status: 'done', reviewText: 'leaked reflection text', minutes: 999 }
  ];
  const payload = buildSharedPayload({
    displayName: 'Alyssa',
    timezone: 'Asia/Manila',
    dateKey: '2026-09-11',
    updatedAt: 1_700_000_000_000,
    todayItems: maximalTodayItems,
    tomorrowDateKey: '2026-09-12',
    tomorrowPrepStatus: 'prepared',
    // planted top-level hostile fields that buildSharedPayload never reads:
    deepHrsToday: 6, streak: 30, score: 99, wallet: { balance: 500 }, review: 'private',
    entries: [{ activity: 'Browsing Reddit', url: 'https://reddit.com' }],
    timeline: ['a', 'b'], notes: 'do not leak me', device: 'laptop-1',
    tomorrowTitles: ['Secret task for tomorrow']
  });

  const serialized = JSON.stringify(payload);
  const forbidden = [
    'deep', 'waste', 'minute', 'focus', 'streak', 'score', 'wallet', 'review', 'url',
    'domain', 'timeline', 'notes', 'device', 'secret', 'reddit', 'slack', 'location',
    'browser', 'app', 'tab', 'completedAt', 'exactDuration'
  ];
  for (const bad of forbidden) {
    assert.equal(
      serialized.toLowerCase().includes(bad.toLowerCase()), false,
      `payload leaked forbidden term "${bad}": ${serialized}`
    );
  }

  // Positive allowlist assertion — the payload contains ONLY these keys, nested.
  assert.deepEqual(Object.keys(payload).sort(), ['publisher', 'schemaVersion', 'today', 'tomorrow']);
  assert.deepEqual(Object.keys(payload.publisher).sort(), ['dateKey', 'displayName', 'timezone', 'updatedAt']);
  assert.deepEqual(Object.keys(payload.today).sort(), ['dateKey', 'priorities']);
  assert.deepEqual(Object.keys(payload.tomorrow).sort(), ['dateKey', 'prepStatus']);
  payload.today.priorities.forEach(p => assert.deepEqual(Object.keys(p).sort(), ['status', 'title']));

  // Titles pass through as plain text but every other planted field is gone.
  assert.equal(payload.today.priorities[0].title, 'Finish proposal');
  assert.equal(payload.today.priorities[0].status, 'worked-on');
  assert.equal(payload.today.priorities[1].status, 'done');
});

test('buildSharedPayload never spreads its input — unknown keys cannot ride along even without a forbidden-word match', () => {
  const payload = buildSharedPayload({
    timezone: 'UTC', dateKey: '2026-09-11', updatedAt: 1,
    todayItems: [{ title: 'A', status: 'planned', mysteryField: 'zzz-unforeseen-key' }],
    tomorrowDateKey: '2026-09-12', tomorrowPrepStatus: 'not-prepared',
    mysteryTopLevel: 'zzz-unforeseen-top'
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('zzz'), false);
});

test('status and prepStatus values are coerced to a safe default rather than passed through raw', () => {
  const payload = buildSharedPayload({
    timezone: 'UTC', dateKey: '2026-09-11', updatedAt: 1,
    todayItems: [{ title: 'A', status: 'CRUSHING_IT_100_PERCENT' }],
    tomorrowDateKey: '2026-09-12', tomorrowPrepStatus: 'super-duper-ready'
  });
  assert.equal(payload.today.priorities[0].status, 'planned');
  assert.equal(payload.tomorrow.prepStatus, 'not-prepared');
});

test('caps at 3 priorities even if given more', () => {
  const items = ['A', 'B', 'C', 'D', 'E'].map(t => ({ title: t, status: 'planned' }));
  const payload = buildSharedPayload({
    timezone: 'UTC', dateKey: '2026-09-11', updatedAt: 1, todayItems: items,
    tomorrowDateKey: '2026-09-12', tomorrowPrepStatus: 'not-prepared'
  });
  assert.equal(payload.today.priorities.length, 3);
});

test('empty title items are dropped, never shown as a blank row', () => {
  const payload = buildSharedPayload({
    timezone: 'UTC', dateKey: '2026-09-11', updatedAt: 1,
    todayItems: [{ title: '   ', status: 'planned' }, { title: 'Real one', status: 'done' }],
    tomorrowDateKey: '2026-09-12', tomorrowPrepStatus: 'not-prepared'
  });
  assert.equal(payload.today.priorities.length, 1);
  assert.equal(payload.today.priorities[0].title, 'Real one');
});

// ── WRITE DEDUPE ─────────────────────────────────────────────────────────────

test('signature ignores updatedAt so a timestamp alone never forces a rewrite', () => {
  const a = buildSharedPayload({ timezone: 'UTC', dateKey: '2026-09-11', updatedAt: 1000, todayItems: [{ title: 'A', status: 'planned' }], tomorrowDateKey: '2026-09-12', tomorrowPrepStatus: 'prepared' });
  const b = buildSharedPayload({ timezone: 'UTC', dateKey: '2026-09-11', updatedAt: 999999, todayItems: [{ title: 'A', status: 'planned' }], tomorrowDateKey: '2026-09-12', tomorrowPrepStatus: 'prepared' });
  assert.equal(sharedPayloadSignature(a), sharedPayloadSignature(b));
});

test('signature changes when a status actually changes', () => {
  const a = buildSharedPayload({ timezone: 'UTC', dateKey: '2026-09-11', updatedAt: 1000, todayItems: [{ title: 'A', status: 'planned' }], tomorrowDateKey: '2026-09-12', tomorrowPrepStatus: 'prepared' });
  const b = buildSharedPayload({ timezone: 'UTC', dateKey: '2026-09-11', updatedAt: 1000, todayItems: [{ title: 'A', status: 'done' }], tomorrowDateKey: '2026-09-12', tomorrowPrepStatus: 'prepared' });
  assert.notEqual(sharedPayloadSignature(a), sharedPayloadSignature(b));
});

// ── READ-SIDE VALIDATION (defense in depth against a legacy/malformed remote node) ──

test('validateSharedPayload strips a hostile/legacy node down to the allowlist', () => {
  const hostile = {
    schemaVersion: 1,
    publisher: { timezone: 'Asia/Manila', dateKey: '2026-09-11', updatedAt: 5, displayName: 'A', deepHrsToday: 9, streak: 3 },
    today: { dateKey: '2026-09-11', priorities: [{ title: 'X', status: 'done', minutes: 500, url: 'evil.com' }] },
    tomorrow: { dateKey: '2026-09-12', prepStatus: 'prepared', titles: ['secret'] },
    score: 100, review: 'leak'
  };
  const clean = validateSharedPayload(hostile);
  assert.deepEqual(Object.keys(clean).sort(), ['publisher', 'schemaVersion', 'today', 'tomorrow']);
  assert.deepEqual(Object.keys(clean.publisher).sort(), ['dateKey', 'displayName', 'timezone', 'updatedAt']);
  assert.deepEqual(Object.keys(clean.tomorrow).sort(), ['dateKey', 'prepStatus']);
  assert.deepEqual(Object.keys(clean.today.priorities[0]).sort(), ['status', 'title']);
});

test('validateSharedPayload rejects anything not schemaVersion 1 or missing required publisher fields', () => {
  assert.equal(validateSharedPayload(null), null);
  assert.equal(validateSharedPayload({}), null);
  assert.equal(validateSharedPayload({ schemaVersion: 2 }), null);
  assert.equal(validateSharedPayload({ schemaVersion: 1, publisher: {}, today: { dateKey: 'x', priorities: [] }, tomorrow: {} }), null);
  // legacy /public-shaped object (from before this feature existed) must not parse as valid /shared
  assert.equal(validateSharedPayload({ deepHrsToday: 2, name: 'A', avatar: '👤', dateKey: '2026-09-11', updatedAt: 1 }), null);
});

test('validateSharedPayload accepts a missing `today.priorities` as zero priorities, never as invalid', () => {
  // The Realtime Database has no concept of a persisted empty array — a node with zero
  // children is indistinguishable from one that was never written, so a genuinely-published
  // `priorities: []` reads back over the wire as `today.priorities === undefined`, not `[]`.
  // Zero priorities is a valid, current, accountability-relevant state and must never be
  // conflated with a broken/legacy payload.
  const prunedEmpty = {
    schemaVersion: 1,
    publisher: { timezone: 'Asia/Manila', dateKey: '2026-09-12', updatedAt: 5, displayName: 'A' },
    today: { dateKey: '2026-09-12' }, // priorities key absent — exactly what RTDB does to []
    tomorrow: { dateKey: '2026-09-13', prepStatus: 'not-prepared' }
  };
  const clean = validateSharedPayload(prunedEmpty);
  assert.notEqual(clean, null);
  assert.deepEqual(clean.today, { dateKey: '2026-09-12', priorities: [] });
});
