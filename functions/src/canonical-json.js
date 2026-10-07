// functions/src/canonical-json.js
//
// Strict JSON input and RFC 8785 (JCS) canonical output.
//
// strictParseJson: the request body is hashed as raw bytes and then parsed, so the parse must have exactly ONE
// meaning. JSON.parse silently keeps the last of two duplicate keys and accepts lone-surrogate escapes, so
// `{"kind":"a","kind":"b"}` could be signed and hashed as one thing and acted on as another. Both are rejected,
// as are invalid UTF-8, a BOM, non-finite numbers and a non-object top level.
//
// canonicalize: RFC 8785 JSON Canonicalization Scheme, used for the command request hash (§5) and for the
// opaque `rev1:` revision (§7). ECMAScript number/string serialization IS the JCS serialization; object keys
// are ordered by UTF-16 code units (the default Array#sort order).

import { createHash } from 'node:crypto';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class JsonInputError extends Error {}

function assertWellFormedString(value) {
  if (LONE_SURROGATE.test(value)) throw new JsonInputError('invalid Unicode (lone surrogate)');
}

/** Walks already-syntax-valid JSON text and throws on a duplicate key inside any one object. */
function rejectDuplicateKeys(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',') { const top = stack.at(-1); if (top) top.expectKey = true; }
    else if (ch === ':') { const top = stack.at(-1); if (top) top.expectKey = false; }
    else if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.keys.has(key)) throw new JsonInputError('duplicate JSON key');
        top.keys.add(key);
      }
      i = j;
    }
  }
}

function checkValue(value) {
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new JsonInputError('non-finite number'); return; }
  if (typeof value === 'string') { assertWellFormedString(value); return; }
  if (Array.isArray(value)) { value.forEach(checkValue); return; }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { assertWellFormedString(key); checkValue(child); }
  }
}

/** @param {Uint8Array} bytes the exact raw body @returns {object} a plain JSON object */
export function strictParseJson(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new JsonInputError('body is not valid UTF-8'); }
  if (text.charCodeAt(0) === 0xFEFF) throw new JsonInputError('byte order mark is not allowed');
  let value;
  try { value = JSON.parse(text); } catch { throw new JsonInputError('body is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JsonInputError('body must be a JSON object');
  rejectDuplicateKeys(text);
  checkValue(value);
  return value;
}

/** RFC 8785 canonical JSON text of a plain JSON value. Throws on anything JSON cannot represent exactly. */
export function canonicalize(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JsonInputError('non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') { assertWellFormedString(value); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => {
      assertWellFormedString(key);
      if (value[key] === undefined) throw new JsonInputError('undefined is not JSON');
      return `${JSON.stringify(key)}:${canonicalize(value[key])}`;
    }).join(',')}}`;
  }
  throw new JsonInputError(`${typeof value} is not JSON`);
}

/** Lowercase hex SHA-256 of the UTF-8 JCS bytes. */
export function canonicalSha256Hex(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}
