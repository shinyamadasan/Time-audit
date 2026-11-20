// Every inline <script> in the shipped pages is parsed by ESLint and checked with no-dupe-keys. A duplicate key in
// an object literal silently drops the earlier value (the A1b merge lost its compaction flags exactly this way).
// A script that does not parse fails too, so nothing is skipped silently.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Linter } = require('eslint');

const PAGES = ['index.html', 'www/index.html'];
const NON_JS = /^(importmap|application\/json|application\/ld\+json|text\/template|text\/html|speculationrules)$/i;

function inlineScripts(html) {
  // HTML comments (e.g. "<!-- place this BEFORE <script> -->") are not markup: blank them, keeping line numbers.
  html = html.replace(/<!--[\s\S]*?-->/g, c => c.replace(/[^\n]/g, ' '));
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(html));) {
    const attrs = m[1], body = m[2];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || '';
    if (type && NON_JS.test(type)) continue;
    const line = html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length; // first body line - 1
    out.push({ code: body, module: /^module$/i.test(type), line });
  }
  return out;
}

function dupeKeyProblems(html) {
  const linter = new Linter({ configType: 'flat' });
  const problems = [];
  for (const { code, module, line } of inlineScripts(html)) {
    const messages = linter.verify(code, [{ languageOptions: { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script' },
      rules: { 'no-dupe-keys': 'error' } }]);
    for (const msg of messages) problems.push(`${msg.fatal ? 'PARSE' : msg.ruleId} at page line ${line + msg.line - 1}: ${msg.message}`);
  }
  return problems;
}

for (const page of PAGES) {
  test(`${page}: no duplicate object keys in any inline script (Priya M1)`, () => {
    const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
    assert.ok(inlineScripts(html).length > 0, 'found inline scripts to check');
    assert.deepEqual(dupeKeyProblems(html), []);
  });
}

test('the check catches a duplicate anywhere, including the A1b compaction shape and nested objects', () => {
  const page = body => `<html><script>${body}</script></html>`;
  assert.equal(dupeKeyProblems(page('f({ a: 1, compaction: x(), b: 2, compaction: { y: 1 } });')).length, 1);
  assert.equal(dupeKeyProblems(page('const o = { outer: { k: 1, "k": 2 } };')).length, 1, 'quoted vs bare key');
  assert.equal(dupeKeyProblems(page('const o = { m() {}, m: 1 };')).length, 1, 'method vs property');
  assert.equal(dupeKeyProblems(`<script type="module">export const o = { a: 1, a: 2 };</script>`).length, 1, 'module scripts');
  assert.equal(dupeKeyProblems(page('const o = { a: 1, ...rest, b: 2 };')).length, 0, 'spread is fine');
  assert.equal(dupeKeyProblems(page('const o = { get a() { return 1; }, set a(v) {} };')).length, 0, 'getter/setter pair is fine');
  assert.match(dupeKeyProblems(page('const o = { a: ;'))[0], /^PARSE/, 'unparseable script fails, never skipped');
  assert.deepEqual(dupeKeyProblems(`<script type="importmap">{"imports":{"a":"b","a":"c"}}</script><script src="x.js"></script>`), [], 'non-JS / external skipped');
});
