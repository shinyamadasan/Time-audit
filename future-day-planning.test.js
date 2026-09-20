// future-day-planning.test.js
//
// Planning Continuity V1 — arbitrary future personal-day planning, and the three
// durability gaps that future-day planning opens in machinery which was previously
// correct only because "current + upcoming" WAS the whole reachable horizon:
//
//   G1  a future day holding a plan record must receive remote listener coverage,
//       or an edit made on another device stays invisible until the day arrives.
//   G2  a future-day write made OFFLINE must be re-pushed on reconnect. Before
//       this, nothing ever named that day again and the write stayed local forever.
//   G3  boundaryChangeImpact must warn about every future prepared day a change
//       would strand, not only current/upcoming.
//
// Plus the addressing itself: a future day must be reachable without creating a
// second day store, and a calendar date that overlaps two personal days must
// surface both rather than being merged into an invented "plan for that date".
//
// In-memory storage, a transaction-shaped fake room ref, injected clocks.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlanAuthority } from './plan-authority.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { createOperationalPlanSyncBridge } from './operational-plan-sync.js';
import { createPersonalDayBoundarySyncBridge } from './personal-day-boundary-sync.js';
import { toFirebaseSafeKey } from './operational-plan-sync.js';

const MANILA = 'Asia/Manila';
const manila = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const D = '2026-09-18';

const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};

function fakeRoomRef(initial = {}) {
  const root = { value: initial };
  const listeners = new Map();
  const get = path => path.split('/').filter(Boolean).reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), root.value);
  function set(path, value) {
    const segs = path.split('/').filter(Boolean);
    let node = root.value;
    for (let i = 0; i < segs.length - 1; i++) {
      if (typeof node[segs[i]] !== 'object' || node[segs[i]] === null) node[segs[i]] = {};
      node = node[segs[i]];
    }
    node[segs[segs.length - 1]] = value;
    for (let i = segs.length; i >= 0; i--) {
      const p = segs.slice(0, i).join('/');
      (listeners.get(p) || []).forEach(fn => fn({ val: () => get(p) ?? null }));
    }
  }
  function makeRef(path) {
    return {
      path,
      child(seg) { return makeRef(path ? `${path}/${seg}` : seg); },
      on(_event, fn) {
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(fn);
        fn({ val: () => get(path) ?? null });
      },
      off() { listeners.delete(path); },
      val: () => get(path) ?? null,
      transaction(updateFn) {
        const current = get(path) ?? null;
        const nextValue = updateFn(current);
        if (nextValue === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => current } });
        set(path, nextValue);
        return Promise.resolve({ committed: true, snapshot: { val: () => nextValue } });
      },
    };
  }
  return { ref: makeRef(''), raw: root, get, attachedPaths: () => [...listeners.keys()] };
}

function legacyStore(seed = {}) {
  const plans = JSON.parse(JSON.stringify(seed));
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

function makeApp({ clock = manila(D, '10:00'), room = null, deviceId = 'device-a', storage = memory(), planStorage = memory(), legacy = legacyStore() } = {}) {
  const nowRef = { value: clock };
  const roomRef = { value: room };
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage, idGenerator: () => `rev-${++seq}` });
  const planRepository = createOperationalPlanRepository({ storage: planStorage });
  const planSync = createOperationalPlanSyncBridge({ repository: planRepository, getRoomRef: () => roomRef.value });
  const boundarySync = createPersonalDayBoundarySyncBridge({ repository: boundaryRepository, getRoomRef: () => roomRef.value });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository, planSync, boundarySync,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => nowRef.value, deviceId: () => deviceId, fallbackTimezone: () => MANILA,
  });
  const authority = createPlanAuthority({ live, legacy, now: () => nowRef.value, accountTimezone: () => MANILA });
  return {
    authority, live, legacy, planRepository, planSync, boundarySync, boundaryRepository, storage, planStorage,
    setNow: v => { nowRef.value = v; },
    goOffline: () => { roomRef.value = null; },
    goOnline: ref => { roomRef.value = ref; },
  };
}

function enable(app, boundaryTime = '18:00') {
  // A device that is in a room has already heard the account's answer before the owner can act
  // (the app attaches on room join). Enabling on a joined-but-unheard device is refused by design
  // — it could mint a legacy anchor that competes with the account's real one — so model the
  // real ordering: the account answered, and it has no boundary yet.
  app.boundarySync.handleRemoteSnapshot({});
  app.live.proposeBoundary({ boundaryTime, timezone: MANILA });
  return app;
}

const item = (id, task, extra = {}) => ({ id, task, when: '', done: false, doneAt: null, updatedAt: 1000, updatedBy: 'device-a', ...extra });

// ═══════════════════════════════════════════════════════════════════════
// 1. addressing arbitrary future personal days — no new day store
// ═══════════════════════════════════════════════════════════════════════

test('dayAhead(0) is today, dayAhead(1) is exactly upcoming(), and both are ordinary targets', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  assert.deepEqual(app.authority.dayAhead(0), app.authority.current());
  assert.deepEqual(app.authority.dayAhead(1), app.authority.upcoming());
});

test('a day three weeks ahead is addressable, and is a real interval on the same chain', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const day21 = app.authority.dayAhead(21);
  assert.equal(day21.store, 'operational');
  // Today's personal day began at 18:00 on Sep 18; 21 days on is Oct 9 18:00.
  assert.equal(day21.startMs, manila('2026-10-09', '18:00'));
  assert.equal(day21.endMs, manila('2026-10-10', '18:00'));
  // Asserted structurally: the revision id inside an operationalDayId is minted, so
  // only the boundary-start date and zone are stable facts about the identity.
  assert.equal(day21.ref.boundaryStartDate, '2026-10-09');
  assert.equal(day21.ref.timezone, MANILA);
  assert.ok(day21.id.startsWith('odv1:'));
  assert.ok(day21.id.endsWith(':Asia/Manila:2026-10-09'));
});

test('a day a year ahead is addressable — there is no product horizon', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const far = app.authority.dayAhead(365);
  assert.equal(far.startMs, manila('2027-09-18', '18:00'));
});

test('future-day addressing refuses nonsense input and is bounded against a runaway walk', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  assert.throws(() => app.authority.dayAhead(-1), /non-negative whole number/);
  assert.throws(() => app.authority.dayAhead(1.5), /non-negative whole number/);
  assert.throws(() => app.authority.dayAhead(731), /Cannot address more than 730/);
  assert.throws(() => app.authority.upcomingDays(0), /positive whole number/);
});

test('upcomingDays lists consecutive personal days with no gap and no repeat', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const days = app.authority.upcomingDays(10);
  assert.equal(days.length, 10);
  for (let i = 1; i < days.length; i++) {
    assert.equal(days[i].startMs, days[i - 1].endMs, 'each day starts exactly where the previous ended');
    assert.notEqual(days[i].id, days[i - 1].id);
  }
});

test('a legacy account addresses future CALENDAR days through the same API', () => {
  const app = makeApp(); // never enabled
  const day3 = app.authority.dayAhead(3);
  assert.equal(day3.store, 'legacy');
  assert.equal(day3.dateKey, '2026-09-21');
  assert.deepEqual(app.authority.upcomingDays(3).map(t => t.dateKey), ['2026-09-18', '2026-09-19', '2026-09-20']);
});

test('preparing a future day writes to the ordinary operational store — no second day store appears', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const target = app.authority.dayAhead(21);
  app.authority.confirmPreparation(target, {
    items: [item('p1', 'dentist follow-up')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [],
  });
  const stored = app.planRepository.listAllRaw();
  assert.deepEqual(Object.keys(stored), [target.id], 'exactly one record, keyed by the ordinary operationalDayId');
  assert.ok(target.id.endsWith(':Asia/Manila:2026-10-09'));
  assert.equal(app.authority.items(target).length, 1);
  assert.equal(app.authority.preparedState(target).prepared, true);
  // Only the one storage key the operational store already uses.
  assert.equal(app.planStorage.getItem('ta3-operational-plans-v1') !== null, true);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. calendar date is a LOOKUP dimension, never a plan identity
// ═══════════════════════════════════════════════════════════════════════

test('a calendar date overlapping two personal days surfaces BOTH real intervals', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const days = app.authority.daysOverlappingCalendarDate('2026-09-30');
  assert.equal(days.length, 2, 'Sep 30 under an 18:00 boundary is covered by two personal days');
  assert.equal(days[0].startMs, manila('2026-09-29', '18:00'));
  assert.equal(days[0].endMs, manila('2026-09-30', '18:00'));
  assert.equal(days[1].startMs, manila('2026-09-30', '18:00'));
  assert.equal(days[1].endMs, manila('2026-10-01', '18:00'));
  assert.notEqual(days[0].id, days[1].id);
  // Nothing merged them into a synthetic "plan for 2026-09-30".
  assert.ok(days.every(d => d.store === 'operational' && d.id.startsWith('odv1:')));
});

test('dayForCalendarDate only SEEDS the browser, and says which day it picked', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  // Noon on Sep 30 lies in the day that began at 18:00 on Sep 29 — the same noon
  // anchor rule Decision A already uses for untimed routines.
  const seeded = app.authority.dayForCalendarDate('2026-09-30');
  assert.equal(seeded.ref.boundaryStartDate, '2026-09-29');
  assert.equal(seeded.startMs, manila('2026-09-29', '18:00'));
  // ...and it is one of the two overlapping days, never a third invented one.
  assert.ok(app.authority.daysOverlappingCalendarDate('2026-09-30').some(d => d.id === seeded.id));
  assert.throws(() => app.authority.dayForCalendarDate('nonsense'), /valid calendar date/);
});

test('a legacy account maps a calendar date to exactly one day — itself', () => {
  const app = makeApp();
  assert.deepEqual(app.authority.daysOverlappingCalendarDate('2026-09-30').map(t => t.dateKey), ['2026-09-30']);
  assert.equal(app.authority.dayForCalendarDate('2026-09-30').dateKey, '2026-09-30');
});

// ═══════════════════════════════════════════════════════════════════════
// 3. G1 — listener coverage for future days holding records
// ═══════════════════════════════════════════════════════════════════════

test('G1: a prepared future day gets a remote listener, bounded by records not by a date range', () => {
  const room = fakeRoomRef();
  const app = enable(makeApp({ room: room.ref }));
  app.setNow(manila(D, '20:00'));

  const baseline = app.live.refreshLiveDays();
  assert.equal(baseline.length, 2, 'current + upcoming only, before any future day exists');

  const future = app.authority.dayAhead(21);
  app.authority.saveItems(future, [item('p1', 'prepared far ahead')]);
  const widened = app.live.refreshLiveDays();
  assert.ok(widened.includes(future.id), 'the future day this device holds a record for is now listened to');
  assert.equal(widened.length, 3, 'exactly the days with records — not a date sweep');
});

test('G1: a PAST day with a record is not listened to (its plan is finalized history)', () => {
  const room = fakeRoomRef();
  const app = enable(makeApp({ room: room.ref }));
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();
  app.authority.saveItems(today, [item('p1', 'today')]);

  // Move the clock forward a week: that day is now finished history.
  app.setNow(manila('2026-09-25', '20:00'));
  const ids = app.live.refreshLiveDays();
  assert.ok(!ids.includes(today.id), 'a finalized past day needs no live listener');
});

test('G1: an edit made on another device to a FUTURE day converges without waiting for that day', () => {
  const room = fakeRoomRef();
  const a = enable(makeApp({ room: room.ref, deviceId: 'device-a' }));
  a.setNow(manila(D, '20:00'));
  const future = a.authority.dayAhead(21);
  a.authority.saveItems(future, [item('p1', 'from A')]);
  a.live.attachLiveDays();

  // Device B joins the same room, reconstructs the boundary, and edits that day.
  const b = makeApp({ room: room.ref, deviceId: 'device-b' });
  b.setNow(manila(D, '20:00'));
  b.live.attachLiveDays();
  assert.equal(b.live.enabled(), true, 'B learned the boundary from remote');
  const bFuture = b.authority.dayAhead(21);
  assert.equal(bFuture.id, future.id, 'both devices resolve the SAME future day identity');
  b.authority.saveItems(bFuture, [item('p1', 'from A'), item('p2', 'added by B')]);

  // A is listening to that future day (G1), so B's write reaches it now.
  a.live.refreshLiveDays();
  assert.deepEqual(a.authority.items(future).map(i => i.id).sort(), ['p1', 'p2']);
});

test('G1: a legacy account attaches nothing at all', () => {
  const room = fakeRoomRef();
  const app = makeApp({ room: room.ref });
  assert.deepEqual(app.live.refreshLiveDays(), []);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. G2 — an offline future-day write is never silently lost
// ═══════════════════════════════════════════════════════════════════════

test('G2: a future-day plan written OFFLINE is pushed on reconnect', async () => {
  const room = fakeRoomRef();
  const app = enable(makeApp({ room: room.ref }));
  app.setNow(manila(D, '20:00'));

  app.goOffline();
  const future = app.authority.dayAhead(21);
  app.authority.saveItems(future, [item('p1', 'written offline, weeks ahead')]);
  assert.equal(room.get(`operationalPlans/${toFirebaseSafeKey(future.id)}`), undefined, 'nothing reached remote while offline');

  app.goOnline(room.ref);
  app.live.pushAllLocal();
  await Promise.resolve();
  const remote = room.get(`operationalPlans/${toFirebaseSafeKey(future.id)}`);
  assert.ok(remote, 'the offline future-day write was re-pushed');
  assert.deepEqual(remote.items.map(i => i.task), ['written offline, weeks ahead']);
});

test('G2: the day being neither current nor upcoming is exactly what used to lose it', async () => {
  const room = fakeRoomRef();
  const app = enable(makeApp({ room: room.ref }));
  app.setNow(manila(D, '20:00'));
  app.goOffline();

  const future = app.authority.dayAhead(30);
  app.authority.saveItems(future, [item('p1', 'far ahead')]);
  // Prove the day really is outside the old retry set.
  const liveIdsIfOnlyCurrentUpcoming = [app.authority.current().id, app.authority.upcoming().id];
  assert.ok(!liveIdsIfOnlyCurrentUpcoming.includes(future.id));

  app.goOnline(room.ref);
  app.live.pushAllLocal();
  await Promise.resolve();
  assert.ok(room.get(`operationalPlans/${toFirebaseSafeKey(future.id)}`), 'pushed anyway, because the retry set is the RECORD set');
});

test('G2: several offline future days all land, and re-pushing is idempotent', async () => {
  const room = fakeRoomRef();
  const app = enable(makeApp({ room: room.ref }));
  app.setNow(manila(D, '20:00'));
  app.goOffline();
  const targets = [3, 10, 45].map(n => app.authority.dayAhead(n));
  targets.forEach((t, n) => app.authority.saveItems(t, [item(`p${n}`, `plan ${n}`)]));

  app.goOnline(room.ref);
  app.live.pushAllLocal();
  await Promise.resolve();
  for (const t of targets) assert.ok(room.get(`operationalPlans/${toFirebaseSafeKey(t.id)}`), `${t.id} pushed`);

  const before = JSON.stringify(room.raw.value.operationalPlans);
  app.live.pushAllLocal();
  await Promise.resolve();
  assert.equal(JSON.stringify(room.raw.value.operationalPlans), before, 'a second reconnect push is a no-op');
});

// ═══════════════════════════════════════════════════════════════════════
// 5. G3 — boundary-change warning names far-future prepared days
// ═══════════════════════════════════════════════════════════════════════

test('G3: a boundary change that would strand a day three weeks out names it BY NAME', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const future = app.authority.dayAhead(21);
  app.authority.confirmPreparation(future, {
    items: [item('p1', 'prepared three weeks out')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [],
  });

  const impact = app.authority.boundaryChangeImpact({ boundaryTime: '20:00', timezone: MANILA });
  assert.equal(impact.ok, true);
  const named = impact.orphaned.map(t => t.id);
  assert.ok(named.includes(future.id), `the far-future prepared day must be named; got ${JSON.stringify(named)}`);
});

test('G3: the stranded day stays fully discoverable after the change — never unreachable', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const future = app.authority.dayAhead(21);
  app.authority.confirmPreparation(future, {
    items: [item('p1', 'prepared three weeks out')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [],
  });

  // Actually make the change.
  app.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA });
  app.setNow(manila('2026-09-19', '21:00'));

  const prepared = app.authority.preparedPlans();
  const found = prepared.find(p => p.id === future.id);
  assert.ok(found, 'the plan is still listed by preparedPlans()');
  assert.equal(found.resolvable, true, 'and its real interval still resolves');
  assert.deepEqual(found.items.map(i => i.task), ['prepared three weeks out']);
  // The record itself was never moved, copied, merged or deleted.
  assert.ok(app.planRepository.listAllRaw()[future.id]);
});

test('G3: an EMPTY future day is not reported as stranded — there is nothing to lose', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const future = app.authority.dayAhead(21);
  app.authority.saveItems(future, []); // creates a record with no items
  const impact = app.authority.boundaryChangeImpact({ boundaryTime: '20:00', timezone: MANILA });
  assert.ok(!impact.orphaned.some(t => t.id === future.id));
});

test('G3 is strictly ADDITIVE: the upcoming day is still warned about, and the far-future day now is too', () => {
  // The pre-existing V1 behaviour is that a boundary change re-identifies the days
  // after it, so an already-prepared UPCOMING day is genuinely stranded under its old
  // id and is warned about. That must not regress. G3 only widens the set to include
  // prepared days further out, which used to be stranded SILENTLY.
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const tomorrow = app.authority.upcoming();
  const future = app.authority.dayAhead(21);
  for (const [target, task] of [[tomorrow, 'tomorrow'], [future, 'three weeks out']]) {
    app.authority.confirmPreparation(target, {
      items: [item(`p-${task.replace(/ /g, '')}`, task)], mode: 'normal', intentionalBlank: false, routineInstanceIds: [],
    });
  }
  const named = app.authority.boundaryChangeImpact({ boundaryTime: '20:00', timezone: MANILA }).orphaned.map(t => t.id);
  assert.ok(named.includes(tomorrow.id), 'the original upcoming-day warning still fires');
  assert.ok(named.includes(future.id), 'and the far-future prepared day is no longer silent');
});

test('G3: re-proposing the SAME boundary time still re-identifies future days, and says so', () => {
  // Deliberately NOT treated as a no-op. proposeBoundaryRevision appends an
  // immutable revision whatever its clock time, and every day after it takes its
  // identity from THAT revision — so a far-future prepared day genuinely stops being
  // reachable under its old id. previewProposal() flags this as `unchanged` for the
  // UI but explicitly does not block a user who insists, so the impact warning has
  // to tell the truth rather than assume nothing happened.
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const future = app.authority.dayAhead(21);
  app.authority.confirmPreparation(future, {
    items: [item('p1', 'x')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [],
  });
  const impact = app.authority.boundaryChangeImpact({ boundaryTime: '18:00', timezone: MANILA });
  assert.equal(impact.ok, true);
  assert.ok(impact.orphaned.some(t => t.id === future.id),
    'an identical-time re-proposal is still a new revision, and the owner is warned before committing');
});

test('G3: orphan warnings are ordered chronologically so the message reads sensibly', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  for (const n of [30, 5, 14]) {
    const t = app.authority.dayAhead(n);
    app.authority.confirmPreparation(t, { items: [item(`p${n}`, `day ${n}`)], mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  }
  const impact = app.authority.boundaryChangeImpact({ boundaryTime: '20:00', timezone: MANILA });
  const starts = impact.orphaned.map(t => t.startMs);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.ok(impact.orphaned.length >= 3);
});

test('G3: a past prepared day is never reported as strandable', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const today = app.authority.current();
  app.authority.confirmPreparation(today, { items: [item('p1', 'today')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  app.setNow(manila('2026-09-25', '20:00'));
  const impact = app.authority.boundaryChangeImpact({ boundaryTime: '20:00', timezone: MANILA });
  assert.ok(!impact.orphaned.some(t => t.id === today.id), 'finalized history cannot be stranded');
});

test('G3: a legacy account reports no impact at all', () => {
  const app = makeApp();
  assert.deepEqual(app.authority.boundaryChangeImpact({ boundaryTime: '18:00', timezone: MANILA }), { ok: true, orphaned: [] });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. future prepared days across a boundary revision
// ═══════════════════════════════════════════════════════════════════════

test('a future day prepared before a boundary change keeps its items and identity', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const future = app.authority.dayAhead(21);
  const originalId = future.id;
  app.authority.saveItems(future, [item('p1', 'keep me')]);

  app.live.proposeBoundary({ boundaryTime: '20:00', timezone: MANILA });
  app.setNow(manila('2026-09-19', '21:00'));

  // The record is still exactly where it was, under its original identity.
  assert.deepEqual(app.planRepository.listAllRaw()[originalId].items.map(i => i.task), ['keep me']);
  // And the new day at the same distance is a DIFFERENT identity, not a silent alias.
  const newFuture = app.authority.dayAhead(20);
  assert.notEqual(newFuture.id, originalId);
  assert.equal(app.authority.items(newFuture).length, 0, 'nothing was copied into the new day');
});

test('reload retains a future-day plan (a fresh authority over the same storage)', () => {
  const storage = memory();
  const planStorage = memory();
  const app = enable(makeApp({ storage, planStorage }));
  app.setNow(manila(D, '20:00'));
  const future = app.authority.dayAhead(21);
  app.authority.confirmPreparation(future, { items: [item('p1', 'survives reload')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });

  const reloaded = makeApp({ storage, planStorage });
  reloaded.setNow(manila(D, '20:00'));
  const sameDay = reloaded.authority.dayAhead(21);
  assert.equal(sameDay.id, future.id);
  assert.deepEqual(reloaded.authority.items(sameDay).map(i => i.task), ['survives reload']);
  assert.equal(reloaded.authority.preparedState(sameDay).prepared, true);
});

test('a far-future prepared day does not inflate the Planning Streak', () => {
  const app = enable(makeApp());
  app.setNow(manila(D, '20:00'));
  const before = app.authority.streak();
  const future = app.authority.dayAhead(21);
  app.authority.confirmPreparation(future, { items: [item('p1', 'far ahead')], mode: 'normal', intentionalBlank: false, routineInstanceIds: [] });
  const after = app.authority.streak();
  assert.equal(after.current, before.current, 'preparing a day weeks out is not a habit day for today');
  assert.equal(after.todayEarned, before.todayEarned);
});
