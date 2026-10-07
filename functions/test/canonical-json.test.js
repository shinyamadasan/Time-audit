// functions/test/canonical-json.test.js — one meaning per body (strict parse) and RFC 8785 canonical output.

import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, canonicalSha256Hex, JsonInputError, strictParseJson } from '../src/canonical-json.js';

const bytes = text => Buffer.from(text, 'utf8');
const refuses = (input, pattern) => assert.throws(() => strictParseJson(typeof input === 'string' ? bytes(input) : input), error => error instanceof JsonInputError && pattern.test(error.message));

test('duplicate keys are refused at every depth and through escape spellings of the same key', () => {
  refuses('{"kind":"a","kind":"b"}', /duplicate/);
  refuses('{"p":{"x":1,"x":2}}', /duplicate/);
  refuses('{"a":[{"k":1,"k":1}]}', /duplicate/);
  refuses('{"kind":"a","\\u006bind":"b"}', /duplicate/);
  // Same key in DIFFERENT objects, and a key-like string VALUE, are fine.
  assert.deepEqual(strictParseJson(bytes('{"a":{"k":1},"b":{"k":2},"c":["a","a"],"d":"a"}')), { a: { k: 1 }, b: { k: 2 }, c: ['a', 'a'], d: 'a' });
  assert.deepEqual(strictParseJson(bytes('{"s":"x\\"y","s2":"\\\\"}')), { s: 'x"y', s2: '\\' });
});

test('invalid UTF-8, a BOM, lone surrogates, non-finite numbers and non-object bodies are refused', () => {
  refuses(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), /UTF-8/);
  refuses(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('{}')]), /byte order mark/);
  refuses('{"a":"\\ud800"}', /lone surrogate/);
  refuses('{"\\udc00":1}', /lone surrogate/);
  refuses('{"a":1e400}', /non-finite/);
  for (const top of ['[]', '1', '"x"', 'null', '']) refuses(top, /JSON/);
  assert.deepEqual(strictParseJson(bytes('{"a":"\\ud83d\\ude00"}')), { a: '😀' }, 'a valid surrogate pair is fine');
});

test('RFC 8785 canonical form: sorted keys (UTF-16 order), ECMAScript numbers, minimal escaping', () => {
  assert.equal(canonicalize({ b: 1, a: [3, 2, 1], c: { z: null, y: true } }), '{"a":[3,2,1],"b":1,"c":{"y":true,"z":null}}');
  // RFC 8785 §3.2.2.3 number examples.
  assert.equal(canonicalize([1e21, 1e-7, 0.000001, -0, 333333333.33333329, 1e23, 9007199254740992]), '[1e+21,1e-7,0.000001,0,333333333.3333333,1e+23,9007199254740992]');
  // UTF-16 code-unit ordering (RFC 8785 §3.2.3): "€" (€) sorts before "😀" (😀) sorts before "דּ".
  assert.equal(canonicalize({ 'דּ': 1, '😀': 2, '€': 3, '\r': 4, 1: 5 }), '{"\\r":4,"1":5,"€":3,"😀":2,"דּ":1}');
  assert.equal(canonicalize('\u0000\u001f"\\/é'), '"\\u0000\\u001f\\"\\\\/é"');
});

test('canonicalize refuses what JSON cannot represent exactly', () => {
  for (const bad of [Number.NaN, Infinity, undefined, () => 1, new Date(0), { a: undefined }, '\ud800', 10n]) {
    assert.throws(() => canonicalize(bad), JsonInputError);
  }
});

test('the hash ignores key order but not array order or values', () => {
  assert.equal(canonicalSha256Hex({ a: 1, b: [1, 2] }), canonicalSha256Hex({ b: [1, 2], a: 1 }));
  assert.notEqual(canonicalSha256Hex({ a: 1, b: [1, 2] }), canonicalSha256Hex({ a: 1, b: [2, 1] }));
  assert.notEqual(canonicalSha256Hex({ a: 1 }), canonicalSha256Hex({ a: '1' }));
  assert.match(canonicalSha256Hex({}), /^[0-9a-f]{64}$/);
  assert.equal(canonicalSha256Hex({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
});
