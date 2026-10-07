// functions/test/brain-dump-query.test.js — the typed get_brain_dump projection over the real domain model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { normalizeCapture } from '../../brain-dump-model.js';
import { allowedDispositions, captureRevision, getBrainDump } from '../src/brain-dump-query.js';
import { canonicalize } from '../src/canonical-json.js';
import { ApiError } from '../src/errors.js';
import { NOW_MS, capture, fakeDomain } from './support.js';

const IDENTITY = Object.freeze({ principalSubject: 's', firebaseUid: 'ownerUid123', roomId: 'uid_ownerUid123', scopes: ['chronasense:read'] });
const T = 1_789_000_000_000;
const claim = { type: 'do-today', store: 'calendar', targetId: 'cal1:2026-10-07', targetKey: 'cal1:2026-10-07', planItemId: 'bdp1|bdc_claimed', claimedAt: T + 5, claimedBy: 'device-b' };

/** One capture in every lifecycle state the domain model knows, in RTDB wire form (nulls pruned). */
const STORE = {
  bdc_untriaged: capture('bdc_untriaged', { createdAt: T + 1, updatedAt: T + 1 }),
  bdc_triaged: capture('bdc_triaged', { createdAt: T + 2, updatedAt: T + 3, status: 'triaged', important: true, urgent: false, triagedAt: T + 3 }),
  bdc_claimed: capture('bdc_claimed', { createdAt: T + 3, updatedAt: T + 5, status: 'triaged', important: true, urgent: true, triagedAt: T + 4, promotionClaim: claim }),
  bdc_promoted: capture('bdc_promoted', {
    createdAt: T + 4, updatedAt: T + 9, status: 'triaged', important: false, urgent: true, triagedAt: T + 5, disposedAt: T + 9,
    promotion: { type: 'schedule', store: 'calendar', targetId: 'cal1:2026-10-08', targetKey: 'cal1:2026-10-08', planItemId: 'bdp1|bdc_promoted', intentRecorded: true, when: '09:30', durationMinutes: 30, promotedAt: T + 9 },
  }),
  bdc_archived: capture('bdc_archived', { createdAt: T + 5, updatedAt: T + 6, status: 'archived', disposedAt: T + 6 }),
  bdc_delegated: capture('bdc_delegated', { createdAt: T + 6, updatedAt: T + 7, status: 'delegated', disposedAt: T + 7, delegatedTo: 'Sam' }),
};
STORE.bdc_promoted.status = 'promoted';

const read = (store, now = NOW_MS) => getBrainDump(IDENTITY, { domain: fakeDomain({ uid_ownerUid123: { brainDump: store } }), nowMs: now });

test('typed output: every capture state projects to the documented shape, in creation order', async () => {
  const { result, authority } = await read(STORE);
  assert.deepEqual(result.captures.map(c => c.captureId), ['bdc_untriaged', 'bdc_triaged', 'bdc_claimed', 'bdc_promoted', 'bdc_archived', 'bdc_delegated']);
  const byId = Object.fromEntries(result.captures.map(c => [c.captureId, c]));
  const KEYS = ['allowedDispositions', 'captureId', 'classification', 'createdAt', 'delegatedTo', 'disposedAt', 'promotion', 'promotionPending', 'revision', 'status', 'text', 'updatedAt'];
  for (const c of result.captures) assert.deepEqual(Object.keys(c).sort(), KEYS, `${c.captureId} has exactly the typed fields`);
  assert.deepEqual(byId.bdc_untriaged, {
    captureId: 'bdc_untriaged', text: 'thought bdc_untriaged', status: 'untriaged', classification: null, promotionPending: false, promotion: null,
    delegatedTo: null, createdAt: new Date(T + 1).toISOString(), updatedAt: new Date(T + 1).toISOString(), disposedAt: null,
    allowedDispositions: ['archive', 'delegate'], revision: byId.bdc_untriaged.revision,
  });
  assert.deepEqual(byId.bdc_triaged.classification, { important: true, urgent: false, quadrant: 'schedule', triagedAt: new Date(T + 3).toISOString() });
  assert.equal(byId.bdc_claimed.promotionPending, true);
  assert.deepEqual(byId.bdc_claimed.allowedDispositions, [], 'a claimed capture refuses archive/delegate');
  assert.deepEqual(byId.bdc_promoted.promotion, { type: 'schedule', store: 'calendar', targetId: 'cal1:2026-10-08', planItemId: 'bdp1|bdc_promoted', promotedAt: new Date(T + 9).toISOString() });
  assert.deepEqual(byId.bdc_promoted.allowedDispositions, []);
  assert.deepEqual(byId.bdc_archived.allowedDispositions, ['reopen']);
  assert.equal(byId.bdc_delegated.delegatedTo, 'Sam');
  assert.deepEqual(authority, { authority: 'brain_dump_capture', store: 'brainDump', access: 'user_scoped', recordIds: result.captures.map(c => c.captureId), readAt: new Date(NOW_MS).toISOString() });
  for (const c of result.captures) assert.match(c.revision, /^rev1:[A-Za-z0-9_-]{43}$/);
});

test('no claim / fence internals, writer IDs or raw paths leak into the response', async () => {
  const text = JSON.stringify(await read(STORE));
  for (const leak of ['promotionClaim', 'claimEpoch', 'claimedBy', 'targetKey', 'revokedAt', 'expiredClaim', 'reopenCount', 'schemaVersion', 'updatedBy', 'device-a', 'device-b', 'rooms/', 'uid_ownerUid123']) {
    assert.ok(!text.includes(leak), `must not expose ${leak}`);
  }
});

test('empty / missing Brain Dump is an authoritative empty list, not an error', async () => {
  for (const empty of [null, {}]) {
    const { result, authority } = await read(empty);
    assert.deepEqual(result.captures, []);
    assert.deepEqual(authority.recordIds, []);
  }
});

test('malformed Firebase data is never silently dropped: the whole read is CONFLICT', async () => {
  const cases = {
    'garbage record': { ...STORE, bdc_bad: { hello: 'world' } },
    'key/id mismatch': { ...STORE, bdc_other: capture('bdc_untriaged') },
    'half-triaged record': { bad_half: capture('bad_half', { important: true }) },
    'terminal record carrying a claim': { bad_term: capture('bad_term', { status: 'archived', disposedAt: T, promotionClaim: claim }) },
    'unknown status': { bad_status: capture('bad_status', { status: 'done' }) },
  };
  for (const [name, store] of Object.entries(cases)) {
    await assert.rejects(read(store), error => error instanceof ApiError && error.code === 'CONFLICT' && error.details.malformedRecords >= 1, name);
  }
  for (const store of [[], 'x', 7, true]) {
    await assert.rejects(read(store), error => error.code === 'CONFLICT', `store value ${JSON.stringify(store)}`);
  }
});

test('an unknown read outcome propagates as an error and is never reported as an empty Brain Dump', async () => {
  const domain = { async readRoomCollection() { throw new ApiError('RETRYABLE_TRANSPORT', 'x', { reason: 'domain-read-network' }); } };
  await assert.rejects(getBrainDump(IDENTITY, { domain, nowMs: NOW_MS }), error => error.code === 'RETRYABLE_TRANSPORT');
});

test('the query reads exactly the bound room\'s brainDump and nothing else', async () => {
  const domain = fakeDomain({});
  await getBrainDump(IDENTITY, { domain, nowMs: NOW_MS });
  assert.deepEqual(domain.reads, [{ roomId: 'uid_ownerUid123', collection: 'brainDump' }]);
});

test('rev1 projection is pinned: sha256 over JCS {v, store, captureId, record: normalizeCapture(record)}', () => {
  const normalized = normalizeCapture(STORE.bdc_claimed);
  const expected = `rev1:${createHash('sha256').update(canonicalize({ v: 1, store: 'brainDump', captureId: 'bdc_claimed', record: normalized }), 'utf8').digest('base64url')}`;
  assert.equal(captureRevision(normalized), expected);
  // The documented field set: every field of the normalized authoritative record.
  assert.deepEqual(Object.keys(normalized).sort(), ['claimEpoch', 'createdAt', 'delegatedTo', 'disposedAt', 'expiredClaim', 'id', 'important', 'promotion', 'promotionClaim', 'reopenCount', 'schemaVersion', 'status', 'text', 'triagedAt', 'updatedAt', 'updatedBy', 'urgent']);
});

test('rev1 changes with every authoritative field that governs concurrency, and is stable under wire/logical forms', () => {
  const base = STORE.bdc_triaged;
  const rev = value => captureRevision(normalizeCapture(value));
  const original = rev(base);
  const variants = {
    text: { text: 'other' }, important: { important: false }, urgent: { urgent: true }, triagedAt: { triagedAt: T + 4, updatedAt: T + 4 },
    updatedAt: { updatedAt: T + 99 }, updatedBy: { updatedBy: 'device-z' }, claim: { promotionClaim: claim },
    revokedClaim: { promotionClaim: { ...claim, revokedAt: T + 8 } }, claimEpoch: { schemaVersion: 2, claimEpoch: 1 },
    reopenCount: { schemaVersion: 2, reopenCount: 1 }, schemaVersion: { schemaVersion: 2 },
  };
  const seen = new Set([original]);
  for (const [name, patch] of Object.entries(variants)) {
    const next = rev({ ...base, ...patch });
    assert.ok(!seen.has(next), `${name} must change the revision`);
    seen.add(next);
  }
  // Same record in another capture slot (target identity) never shares a token.
  assert.notEqual(rev(capture('bdc_aaa1')), rev({ ...capture('bdc_aaa1'), id: 'bdc_aaa2' }));
  // Logical form (explicit nulls) and Firebase-pruned wire form are the same authoritative state.
  assert.equal(rev({ ...base, disposedAt: null, promotionClaim: null, delegatedTo: null, reopenCount: 0 }), original);
});

test('allowedDispositions mirrors the domain model\'s refusals', () => {
  const n = value => normalizeCapture(value);
  assert.deepEqual(allowedDispositions(n(STORE.bdc_untriaged)), ['archive', 'delegate']);
  assert.deepEqual(allowedDispositions(n(STORE.bdc_triaged)), ['archive', 'delegate']);
  assert.deepEqual(allowedDispositions(n(STORE.bdc_claimed)), []);
  assert.deepEqual(allowedDispositions(n(STORE.bdc_promoted)), []);
  assert.deepEqual(allowedDispositions(n(STORE.bdc_archived)), ['reopen']);
  assert.deepEqual(allowedDispositions(n(STORE.bdc_delegated)), ['reopen']);
});
