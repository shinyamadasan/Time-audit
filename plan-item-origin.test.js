// plan-item-origin.test.js
//
// The pure contract of the location-bound Brain Dump promotion fence (plan-item-origin.js,
// DECISIONS #33): physical target keys, origin v2, the fenced/ordinary split, the three fenced-item
// merge laws, exact-presence verdicts, and the (non-authoritative) queue guard.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAIN_DUMP_MOVE_REFUSED, FENCE_REMOTE_PATHS, brainDumpOrigin, captureIdOfPlanItem, fencedItemsOf, fencedPresence, foldFencedItems, isFencedItem,
  mergeFencedItem, originAuthorization, originOf, partitionOutboundItemsWith, physicalTargetKey, sameOrigin, splitFencedItems,
} from './plan-item-origin.js';
import { toFirebaseSafeKey } from './operational-plan-sync.js';
import { calendarPlanId } from './calendar-plan-model.js';
import { mergeCalendarPlanRecords } from './calendar-plan-model.js';

const CAL = 'cal1:2026-10-03';
const OP = 'odv1:rev-a1:Asia/Manila:2026-10-03';
const origin = (extra = {}) => brainDumpOrigin({ claimEpoch: 0, type: 'do-today', store: 'calendar', targetKey: CAL, ...extra });
const item = (extra = {}) => ({ id: 'bdp1|bcap0001', task: 'x', when: '', done: false, updatedAt: 10, updatedBy: 'a', kind: 'task', brainDumpOrigin: origin(), ...extra });
const choose = (a, b) => mergeCalendarPlanRecords({ items: [a] }, { items: [b] }, CAL).items[0];

test('physicalTargetKey: the Firebase child key of a plan target, from PlanAuthority\'s own identity', () => {
  assert.equal(physicalTargetKey('calendar', calendarPlanId('2026-10-03')), CAL);
  assert.equal(physicalTargetKey('legacy', '2026-10-03'), '2026-10-03');
  assert.equal(physicalTargetKey('operational', OP), toFirebaseSafeKey(OP), 'identical to the operational sync bridge\'s own key encoding');
  assert.match(physicalTargetKey('operational', OP), /^[A-Za-z0-9_-]+$/, 'a legal Firebase key (the id embeds "/")');
  for (const [store, id] of [['calendar', '2026-10-03'], ['calendar', 'cal1:2026-13-45x'], ['legacy', 'cal1:2026-10-03'], ['legacy', ''], ['nowhere', CAL], ['calendar', null], ['operational', undefined]]) {
    assert.equal(physicalTargetKey(store, id), null, `${store}/${id}`);
  }
  assert.deepEqual(FENCE_REMOTE_PATHS, { calendar: 'calendarPlanFences', operational: 'operationalPlanFences', legacy: 'planFences' });
});

test('origin v2: strictly shaped; anything else is not an origin, and so not fenced', () => {
  assert.deepEqual(originOf(item()), { v: 2, claimEpoch: 0, type: 'do-today', store: 'calendar', targetKey: CAL });
  const bad = {
    'v1 (the retired array-indexed shape)': { v: 1, claimEpoch: 0, type: 'do-today', targetId: CAL },
    'missing store': { v: 2, claimEpoch: 0, type: 'do-today', targetKey: CAL }, 'unknown store': origin({ store: 'nowhere' }), 'missing targetKey': origin({ targetKey: '' }),
    'string epoch': { ...origin(), claimEpoch: '0' }, 'fractional epoch': { ...origin(), claimEpoch: 0.5 }, 'negative epoch': { ...origin(), claimEpoch: -1 }, 'no type': { ...origin(), type: undefined },
  };
  for (const [label, value] of Object.entries(bad)) {
    assert.equal(originOf({ id: 'bdp1|bcap0001', brainDumpOrigin: value }), null, label);
    assert.equal(isFencedItem({ id: 'bdp1|bcap0001', brainDumpOrigin: value }), false, label);
  }
  assert.equal(isFencedItem(item({ id: 'pordinary1' })), false, 'an origin on a non-bdp1 id never fences it');
  assert.equal(isFencedItem(item({ id: 'bdp1|bad id' })), false, 'a malformed suffix');
  assert.equal(captureIdOfPlanItem('bdp1|bcap0001'), 'bcap0001');
  assert.equal(captureIdOfPlanItem('bdp1|'), null);
  assert.equal(captureIdOfPlanItem('bdp1|a b'), null);
  assert.equal(captureIdOfPlanItem('pordinary1'), null);
  assert.equal(BRAIN_DUMP_MOVE_REFUSED, "Brain Dump tasks can't be moved to another day yet.");
});

test('splitFencedItems: a fenced item goes to its keyed child, everything else (including a pre-fence bdp1 item) stays in the record', () => {
  const legacy = { id: 'bdp1|bold00001', task: 'old', done: false };
  const plain = { id: 'pplain001', task: 'p' };
  const { ordinary, fenced } = splitFencedItems([plain, item(), legacy]);
  assert.deepEqual(fenced.map(i => i.id), ['bdp1|bcap0001']);
  assert.deepEqual(ordinary.map(i => i.id), ['pplain001', 'bdp1|bold00001']);
  assert.deepEqual(splitFencedItems(undefined), { ordinary: [], fenced: [] });
});

test('fencedItemsOf: only well-formed fenced items whose key equals their id', () => {
  const value = { 'bdp1|bcap0001': item(), 'bdp1|bother001': item({ id: 'bdp1|mismatch1' }), 'pplain001': { id: 'pplain001' }, 'bdp1|bnoorigin': { id: 'bdp1|bnoorigin' } };
  assert.deepEqual(fencedItemsOf(value).map(i => i.id), ['bdp1|bcap0001']);
  assert.deepEqual(fencedItemsOf(null), []);
  assert.deepEqual(fencedItemsOf([item()]), []);
});

test('mergeFencedItem law 1: a newer generation supersedes an older one outright, whatever their clocks', () => {
  const g0 = item({ updatedAt: 999, task: 'old' });
  const g1 = item({ updatedAt: 1, task: 'new', brainDumpOrigin: origin({ claimEpoch: 1 }) });
  assert.equal(mergeFencedItem(g0, g1, choose).task, 'new');
  assert.equal(mergeFencedItem(g1, g0, choose).task, 'new', 'order independent');
});

test('mergeFencedItem law 2: a tombstone is monotonic — it beats a live copy with a later updatedAt, in either order', () => {
  const tombstone = item({ deleted: true, updatedAt: 10 });
  const staleLive = item({ updatedAt: 500, task: 'edited after' });
  assert.equal(mergeFencedItem(tombstone, staleLive, choose).deleted, true);
  assert.equal(mergeFencedItem(staleLive, tombstone, choose).deleted, true);
  // Same state: the store's own last-writer-wins.
  assert.equal(mergeFencedItem(item({ updatedAt: 5, task: 'a' }), item({ updatedAt: 6, task: 'b' }), choose).task, 'b');
  assert.equal(mergeFencedItem(item({ deleted: true, updatedAt: 5, task: 'a' }), item({ deleted: true, updatedAt: 6, task: 'b' }), choose).task, 'b');
});

test('mergeFencedItem law 3: a fenced item beats an un-fenced array item of the same id, and a null side is the other', () => {
  const legacy = { id: 'bdp1|bcap0001', task: 'legacy ghost', updatedAt: 9999, done: false };
  assert.equal(mergeFencedItem(legacy, item(), choose).brainDumpOrigin.v, 2);
  assert.equal(mergeFencedItem(item(), legacy, choose).brainDumpOrigin.v, 2);
  assert.equal(mergeFencedItem(null, item(), choose).id, 'bdp1|bcap0001');
  assert.equal(mergeFencedItem(item(), null, choose).id, 'bdp1|bcap0001');
  assert.equal(mergeFencedItem(null, null, choose), null);
});

test('foldFencedItems: folds with those laws, never removes a local item, reports whether anything changed', () => {
  const local = [{ id: 'pplain001', task: 'p' }, item({ updatedAt: 500, task: 'stale live' })];
  const result = foldFencedItems(local, [item({ deleted: true, updatedAt: 10 })], choose);
  assert.equal(result.changed, true);
  assert.equal(result.items.find(i => i.id === 'bdp1|bcap0001').deleted, true, 'the remote tombstone wins locally');
  assert.ok(result.items.some(i => i.id === 'pplain001'), 'an unrelated local item is untouched');
  assert.equal(foldFencedItems(result.items, [item({ deleted: true, updatedAt: 10 })], choose).changed, false, 'idempotent');
  assert.equal(foldFencedItems([], [item()], choose).items.length, 1);
  assert.equal(sameOrigin(item(), item()), true);
  assert.equal(sameOrigin(item(), item({ brainDumpOrigin: origin({ claimEpoch: 1 }) })), false);
});

test('fencedPresence: exact child or nothing — wrong id/epoch/store/target/type is "unknown", never present and never absent', () => {
  const expected = { itemId: 'bdp1|bcap0001', claimEpoch: 0, type: 'do-today', store: 'calendar', targetKey: CAL };
  assert.equal(fencedPresence(item(), expected), 'present');
  assert.equal(fencedPresence(item({ deleted: true }), expected), 'present', 'a tombstone is exact presence: it was written');
  assert.equal(fencedPresence(null, expected), 'absent');
  assert.equal(fencedPresence(undefined, expected), 'absent');
  for (const [label, value] of Object.entries({
    'wrong epoch': item({ brainDumpOrigin: origin({ claimEpoch: 1 }) }), 'wrong type': item({ brainDumpOrigin: origin({ type: 'schedule' }) }),
    'wrong store': item({ brainDumpOrigin: origin({ store: 'legacy' }) }), 'wrong target': item({ brainDumpOrigin: origin({ targetKey: 'cal1:2026-10-04' }) }),
    'wrong id': item({ id: 'bdp1|bother001' }), 'no origin': { id: 'bdp1|bcap0001' }, 'not an object': 'x', 'an array': [item()],
  })) assert.equal(fencedPresence(value, expected), 'unknown', label);
});

const CAPTURE = { id: 'bcap0001', status: 'triaged', claimEpoch: 0 };
const claim = (extra = {}) => ({ type: 'do-today', store: 'calendar', targetId: CAL, targetKey: CAL, planItemId: 'bdp1|bcap0001', claimedAt: 1, claimedBy: 'd', ...extra });
const authz = (it, capture) => originAuthorization(it, capture);

test('originAuthorization (fenced): mirrors the server — generation, claim/promotion, exact location', () => {
  assert.equal(authz(item(), { ...CAPTURE, promotionClaim: claim() }), 'authorized');
  assert.equal(authz(item(), { ...CAPTURE, promotionClaim: claim({ revokedAt: 5 }) }), 'unknown', 'revoked: frozen, not provably gone');
  assert.equal(authz(item(), { ...CAPTURE, status: 'promoted', promotion: claim() }), 'authorized');
  assert.equal(authz(item(), { ...CAPTURE, claimEpoch: 1 }), 'superseded', 'a newer generation can never authorize the old one');
  assert.equal(authz(item({ brainDumpOrigin: origin({ claimEpoch: 2 }) }), { ...CAPTURE, claimEpoch: 1 }), 'unknown', 'this device\'s capture copy is behind');
  assert.equal(authz(item(), { ...CAPTURE, promotionClaim: claim({ targetKey: 'cal1:2026-10-04' }) }), 'superseded', 'the claim names another location');
  assert.equal(authz(item(), { ...CAPTURE, promotionClaim: claim({ store: 'legacy' }) }), 'superseded');
  assert.equal(authz(item(), { ...CAPTURE, promotionClaim: claim({ type: 'schedule' }) }), 'superseded');
  assert.equal(authz(item(), { ...CAPTURE, status: 'promoted', promotion: claim({ targetKey: 'cal1:2026-10-04' }) }), 'superseded');
  assert.equal(authz(item(), CAPTURE), 'unknown', 'same generation, no claim: only the server can tell');
  assert.equal(authz(item(), null), 'unknown');
});

test('originAuthorization (un-fenced bdp1 item): a pre-fence item is judged by capture state alone and is NEVER fabricated into a fenced one', () => {
  const legacy = { id: 'bdp1|bcap0001', task: 'old', done: false };
  const legacyClaim = { type: 'do-today', store: 'calendar', targetId: CAL, planItemId: 'bdp1|bcap0001', claimedAt: 1, claimedBy: 'old' };
  assert.equal(authz(legacy, { ...CAPTURE, promotionClaim: legacyClaim }), 'authorized');
  assert.equal(authz(legacy, { ...CAPTURE, promotionClaim: { ...legacyClaim, revokedAt: 4 } }), 'unknown');
  assert.equal(authz(legacy, { ...CAPTURE, status: 'promoted', promotion: legacyClaim }), 'authorized');
  assert.equal(authz(legacy, { ...CAPTURE, promotionClaim: claim() }), 'superseded', 'the capture is fenced now: its item lives in the fence collection');
  assert.equal(authz(legacy, { ...CAPTURE, promotionClaim: { ...legacyClaim, planItemId: 'bdp1|bother001' } }), 'superseded', 'another item\'s claim');
  assert.equal(authz(legacy, { ...CAPTURE, claimEpoch: 1 }), 'superseded', 'a RECOVERED capture can never authorize its old claim\'s item again');
  assert.equal(authz(legacy, CAPTURE), 'unknown', 'epoch 0, no claim: this device\'s copy may simply be behind');
  assert.equal(authz(legacy, null), 'unknown');
});

test('the queue guard withholds only what is provably superseded, never on "unknown", and never touches an ordinary item', () => {
  const stale = item();
  const live = item({ id: 'bdp1|blive0001' });
  const unknown = item({ id: 'bdp1|bunk00001' });
  const plain = { id: 'pplain001' };
  const captures = {
    bcap0001: { ...CAPTURE, claimEpoch: 1 },
    blive0001: { id: 'blive0001', status: 'triaged', claimEpoch: 0, promotionClaim: claim({ planItemId: 'bdp1|blive0001' }) },
  };
  const { kept, superseded } = partitionOutboundItemsWith([stale, live, unknown, plain], id => captures[id] || null);
  assert.deepEqual(superseded, ['bdp1|bcap0001']);
  assert.deepEqual(kept.map(i => i.id), ['bdp1|blive0001', 'bdp1|bunk00001', 'pplain001']);
  // No lookup registered: nothing is ever withheld (the server alone decides).
  assert.deepEqual(partitionOutboundItemsWith([stale], null), { kept: [stale], superseded: [] });
  // A throwing lookup is "unknown", not a drop.
  assert.deepEqual(partitionOutboundItemsWith([stale], () => { throw new Error('no cache'); }), { kept: [stale], superseded: [] });
});
