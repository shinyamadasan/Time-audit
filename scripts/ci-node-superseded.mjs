#!/usr/bin/env node
// scripts/ci-node-superseded.mjs <file>
//
// Runs one whole node:test file that holds superseded tests named in scripts/ci-known-failures.json.
// Every other test in the file is required to pass, and their count is pinned (`required`). The named tests
// still run; their results are reported in a separate section and do not decide the outcome. A named test that no longer exists fails the run,
// so the list cannot silently cover a renamed or new test.
// A Markdown summary goes to stdout and, in GitHub Actions, to the job summary.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const file = process.argv[2];
const record = JSON.parse(readFileSync(new URL('./ci-known-failures.json', import.meta.url), 'utf8')).superseded[file];
if (!record) {
  console.error('usage: ci-node-superseded.mjs <file listed under "superseded" in ci-known-failures.json>');
  process.exit(2);
}

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
process.stderr.write(run.stdout + run.stderr);

// Top-level TAP results start at column 0; subtests are indented.
const outcomes = new Map();
for (const line of run.stdout.split('\n')) {
  const match = /^(ok|not ok) \d+ - (.*?)(\s+# (SKIP|TODO).*)?$/.exec(line);
  if (match) outcomes.set(match[2], match[3] ? 'skipped' : match[1] === 'ok' ? 'passed' : 'failed');
}
const named = new Set(record.tests);
const required = [...outcomes].filter(([name]) => !named.has(name));
const bad = required.filter(([, status]) => status !== 'passed');
const missing = record.tests.filter(name => !outcomes.has(name));
const ok = run.status !== null && required.length === record.required && bad.length === 0 && missing.length === 0;

const lines = [`## ${file}`, '', `required: ${required.length - bad.length}/${required.length} passed (expected ${record.required}): ${ok ? 'PASS' : 'FAIL'}`, '',
  ...bad.map(([name, status]) => `- ${status}: ${name}`), ...missing.map(name => `- superseded test not found (renamed?): ${name}`),
  '', `### Superseded, reported only (${record.tests.length})`, '', record.reason, '',
  ...record.tests.map(name => `- ${outcomes.get(name) || 'not run'}: ${name}`)];
const text = `${lines.join('\n')}\n\n`;
process.stdout.write(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
process.exit(ok ? 0 : 1);
