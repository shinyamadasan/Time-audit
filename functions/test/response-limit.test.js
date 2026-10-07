// functions/test/response-limit.test.js
//
// A1-02: §5 "All API bodies use JSON, UTF-8, maximum 64 KiB" — a maximum, so the bound is INCLUSIVE (65536 bytes
// allowed, 65537 refused), the same reading the request-body check already uses (`length > MAX_BODY_BYTES`).
// Measured in UTF-8 bytes of the exact payload the function sends, never JS string length. An oversize complete
// result is refused whole (DOMAIN_LIMIT); it is never truncated into a partial list presented as complete.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_RESPONSE_BYTES } from '../src/action-api.js';
import { OWNER, capture, harness, signedRequest } from './support.js';

const LIMIT = 64 * 1024;
const ROOM = `uid_${OWNER.ownerFirebaseUid}`;
const T = 1_789_000_000_000;

function store(texts) {
  return Object.fromEntries(texts.map((text, i) => {
    const id = `bdc_${String(i).padStart(5, '0')}`;
    return [id, capture(id, { text, createdAt: T + i, updatedAt: T + i })];
  }));
}

async function call(texts) {
  const h = harness({ rooms: { [ROOM]: { brainDump: store(texts) } } });
  const response = await h.handle(signedRequest());
  return { ...response, bytes: Buffer.byteLength(response.payload, 'utf8') };
}

/** ASCII texts whose complete get_brain_dump response is EXACTLY `target` bytes (each extra ASCII char = 1 byte). */
async function textsForExactly(target) {
  const texts = [];
  // Grow until one more capture no longer yields a complete 200 response within `target` bytes. (Once over the
  // limit the response becomes a small refusal, so status — not size alone — ends the loop.)
  for (;;) {
    const next = await call([...texts, 'a'.repeat(900)]);
    if (next.status !== 200 || next.bytes > target) break;
    texts.push('a'.repeat(900));
  }
  let gap = target - (await call(texts)).bytes;
  for (let i = 0; gap > 0; i++) { const add = Math.min(gap, 100); texts[i] += 'a'.repeat(add); gap -= add; }
  const check = await call(texts);
  assert.equal(check.bytes, target, 'the fixture hits the boundary exactly');
  return texts;
}

function assertOversize(response) {
  assert.equal(response.status, 422);
  assert.equal(response.reason, 'response-too-large');
  assert.deepEqual(Object.keys(response.body).sort(), ['contractVersion', 'error', 'requestId']);
  assert.deepEqual(response.body.error, {
    code: 'DOMAIN_LIMIT', message: 'The complete result exceeds the 64 KiB response limit; no partial result is returned.',
    retryability: 'not_retryable', details: { limitBytes: LIMIT },
  });
  assert.ok(!('result' in response.body) && !response.payload.includes('captures'), 'no partial result in the refusal');
  assert.ok(response.bytes <= LIMIT, 'the refusal itself fits the limit');
  assert.equal(response.payload, JSON.stringify(response.body), 'the payload is exactly the error envelope');
}

test('the limit is the contract\'s 64 KiB, shared with the request cap', () => {
  assert.equal(MAX_RESPONSE_BYTES, LIMIT);
});

test('empty and comfortably-small responses are unchanged, and the payload is exactly the serialized body', async () => {
  for (const texts of [[], ['one thought'], Array(20).fill('x'.repeat(100))]) {
    const response = await call(texts);
    assert.equal(response.status, 200);
    assert.equal(response.payload, JSON.stringify(response.body));
    assert.deepEqual(Object.keys(response.body).sort(), ['authority', 'contractVersion', 'kind', 'requestId', 'result']);
    assert.equal(response.body.result.captures.length, texts.length);
    assert.ok(response.bytes < LIMIT);
  }
});

test('boundary: exactly 65536 bytes succeeds; the first byte over is a typed DOMAIN_LIMIT refusal', async () => {
  const texts = await textsForExactly(LIMIT);
  const atLimit = await call(texts);
  assert.equal(atLimit.status, 200);
  assert.equal(atLimit.bytes, LIMIT);
  assert.equal(atLimit.body.result.captures.length, texts.length, 'complete');
  const over = await call([texts[0] + 'a', ...texts.slice(1)]);
  assert.equal(over.status, 422);
  assertOversize(over);
});

test('bytes, not characters: multibyte text at the same JS length crosses the limit; byte-neutral swaps do not', async () => {
  const texts = await textsForExactly(LIMIT);
  // 'é' is 1 UTF-16 unit but 2 UTF-8 bytes: same character count, one byte more -> refused.
  assert.equal((await call(texts)).payload.length, LIMIT, 'the all-ASCII at-limit body is 65536 characters and 65536 bytes');
  const swappedText = `${texts[0].slice(1)}é`;
  assert.equal(swappedText.length, texts[0].length, 'the swap keeps the JS character count, so the body would still be 65536 characters');
  assertOversize(await call([swappedText, ...texts.slice(1)]));
  // Two ASCII bytes -> one 'é' (2 bytes) and four -> one '😀' (4 bytes): byte count unchanged, JS length shorter.
  const swapped = await call([`${texts[0].slice(2)}é`, `${texts[1].slice(4)}😀`, ...texts.slice(2)]);
  assert.equal(swapped.status, 200);
  assert.equal(swapped.bytes, LIMIT);
  assert.ok(swapped.payload.length < LIMIT, 'fewer characters than bytes, still allowed at exactly 64 KiB');
  // All-multibyte content: well under 64 Ki characters but over 64 KiB -> refused.
  const wideTexts = Array(40).fill('é'.repeat(990));
  assert.ok(wideTexts.join('').length < LIMIT && Buffer.byteLength(wideTexts.join(''), 'utf8') > LIMIT, '39600 characters, 79200 bytes');
  assertOversize(await call(wideTexts));
});

test('a very large Brain Dump fails closed and is never truncated', async () => {
  const response = await call(Array(500).fill('z'.repeat(1000)));
  assertOversize(response);
});

test('the nonce is still consumed and the read still happened only once for an oversize response (no silent retry)', async () => {
  const h = harness({ rooms: { [ROOM]: { brainDump: store(Array(200).fill('z'.repeat(1000))) } } });
  const request = signedRequest();
  assert.equal((await h.handle(request)).reason, 'response-too-large');
  assert.equal(h.domain.reads.length, 1);
  assert.equal((await h.handle(request)).reason, 'replayed-request-id', 'the same request ID cannot be replayed to probe again');
});
