import assert from 'node:assert/strict';
import test from 'node:test';
import { describeLifeLedgerSyncStatus } from './life-ledger-sync-status-ui.js';

test('unsupported browser', () => {
  const d = describeLifeLedgerSyncStatus({ supported: false });
  assert.match(d.text, /not available/i);
  assert.equal(d.action, null);
});

test('not configured yet offers Enable', () => {
  const d = describeLifeLedgerSyncStatus({ supported: true, configured: false });
  assert.equal(d.action, 'enable');
});

test('configured but permission lapsed offers Resume, never claims synced', () => {
  const d = describeLifeLedgerSyncStatus({ supported: true, configured: true, permission: 'prompt', worker: { outcome: 'synced', outboxSha256: 'x' }, outboxSha256: 'x' });
  assert.equal(d.action, 'resume');
  assert.ok(!/synced/i.test(d.text));
});

test('configured + granted + no worker report yet -> waiting, not synced', () => {
  const d = describeLifeLedgerSyncStatus({ supported: true, configured: true, permission: 'granted', worker: null, outboxSha256: 'x' });
  assert.ok(!/^Life Ledger synced/.test(d.text));
  assert.match(d.text, /waiting/i);
});

test('worker synced AND hash matches current outbox -> synced', () => {
  const d = describeLifeLedgerSyncStatus({
    supported: true, configured: true, permission: 'granted',
    worker: { outcome: 'synced', outboxSha256: 'abc' }, outboxSha256: 'abc'
  });
  assert.equal(d.text, 'Life Ledger synced.');
  assert.equal(d.tone, 'ok');
});

test('worker unchanged AND hash matches current outbox -> also counts as synced (up to date)', () => {
  const d = describeLifeLedgerSyncStatus({
    supported: true, configured: true, permission: 'granted',
    worker: { outcome: 'unchanged', outboxSha256: 'abc' }, outboxSha256: 'abc'
  });
  assert.equal(d.text, 'Life Ledger synced.');
});

test('worker synced but for an OLDER outbox hash -> never claims synced', () => {
  const d = describeLifeLedgerSyncStatus({
    supported: true, configured: true, permission: 'granted',
    worker: { outcome: 'synced', outboxSha256: 'old-hash' }, outboxSha256: 'new-hash'
  });
  assert.notEqual(d.text, 'Life Ledger synced.');
  assert.match(d.text, /waiting to sync/i);
});

test('worker conflict -> action required, no synced claim', () => {
  const d = describeLifeLedgerSyncStatus({
    supported: true, configured: true, permission: 'granted',
    worker: { outcome: 'conflict', reason: 'manifest_integrity_mismatch' }, outboxSha256: 'x'
  });
  assert.match(d.text, /blocked/i);
  assert.match(d.text, /manifest_integrity_mismatch/);
  assert.equal(d.tone, 'error');
});

test('worker intervention_required -> action required', () => {
  const d = describeLifeLedgerSyncStatus({
    supported: true, configured: true, permission: 'granted',
    worker: { outcome: 'intervention_required' }, outboxSha256: 'x'
  });
  assert.match(d.text, /attention/i);
  assert.equal(d.tone, 'error');
});

test('worker error -> temporarily unavailable, will retry, not an alarm tone escalation beyond warn', () => {
  const d = describeLifeLedgerSyncStatus({
    supported: true, configured: true, permission: 'granted',
    worker: { outcome: 'error' }, outboxSha256: 'x'
  });
  assert.match(d.text, /temporarily unavailable/i);
  assert.equal(d.tone, 'warn');
});

test('never emits the literal word "synced" for any non-synced/non-unchanged outcome', () => {
  for (const outcome of ['conflict', 'intervention_required', 'error', 'no_source']) {
    const d = describeLifeLedgerSyncStatus({
      supported: true, configured: true, permission: 'granted',
      worker: { outcome, outboxSha256: 'x' }, outboxSha256: 'x'
    });
    assert.ok(!/^Life Ledger synced\.$/.test(d.text));
  }
});
