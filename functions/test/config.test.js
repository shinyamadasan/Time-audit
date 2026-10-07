// functions/test/config.test.js — named configuration fails closed; nonce retention covers the replay window.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, parseDatabaseUrl, parseHmacKeys, requireValue } from '../src/config.js';
import { RETENTION_MS } from '../src/nonce-store.js';
import { FRESHNESS_SECONDS } from '../src/service-auth.js';

test('HMAC keys: a JSON map of keyId -> lowercase hex of 32..128 bytes; anything else refuses to start', () => {
  const keys = parseHmacKeys(JSON.stringify({ k1: 'ab'.repeat(32), k2: 'cd'.repeat(64) }));
  assert.deepEqual([...keys.keys()], ['k1', 'k2']);
  assert.equal(keys.get('k1').length, 32);
  for (const bad of ['', 'nope', '[]', '{}', JSON.stringify({ k1: 'ab'.repeat(31) }), JSON.stringify({ k1: 'AB'.repeat(32) }), JSON.stringify({ 'k 1': 'ab'.repeat(32) }), JSON.stringify({ k1: 7 })]) {
    assert.throws(() => parseHmacKeys(bad), ConfigError, bad);
  }
});

test('database URL must be an https Realtime Database origin; plain values must be set and untrimmed', () => {
  assert.equal(parseDatabaseUrl('https://demo-default-rtdb.asia-southeast1.firebasedatabase.app'), 'https://demo-default-rtdb.asia-southeast1.firebasedatabase.app');
  assert.equal(parseDatabaseUrl('https://demo.firebaseio.com'), 'https://demo.firebaseio.com');
  for (const bad of ['http://demo.firebaseio.com', 'https://demo.firebaseio.com/', 'https://evil.example', 'https://demo.firebaseio.com.evil.example', undefined]) assert.throws(() => parseDatabaseUrl(bad), ConfigError, String(bad));
  assert.equal(requireValue('X', 'v'), 'v');
  for (const bad of ['', ' v', undefined]) assert.throws(() => requireValue('X', bad), ConfigError);
});

test('nonce retention outlives the last instant a claimed request could still be fresh', () => {
  // A request stamped t is accepted only while |now - t| <= F, and when claimed at c we know t <= c + F,
  // so its last fresh instant is t + F <= c + 2F. Retention must reach past that.
  for (let skew = -FRESHNESS_SECONDS; skew <= FRESHNESS_SECONDS; skew += 25) {
    const claimedAt = 1_000_000_000;
    const lastFreshMs = (claimedAt / 1000 + skew + FRESHNESS_SECONDS) * 1000;
    assert.ok(claimedAt + RETENTION_MS > lastFreshMs, `skew ${skew}`);
  }
  assert.ok(RETENTION_MS <= 11 * 60 * 1000, 'bounded: approximately ten minutes');
});
