#!/usr/bin/env node
// scripts/ci-test-report.mjs
//
// Reads Playwright JSON reports written by the CI shards.
//   required <count> <report...>  fails unless exactly <count> tests ran and every one passed (no skip, no flake)
//   legacy <count> <report...>    requires exactly <count> tests to have run, then compares failures with
//                                 scripts/ci-known-failures.json; fails on any failure or skip outside that
//                                 recorded baseline. Known failures are listed, never hidden.
// A Markdown summary goes to stdout and, in GitHub Actions, to the job summary.

import { appendFileSync, readFileSync } from 'node:fs';

const [mode, ...rest] = process.argv.slice(2);
const expectedCount = Number(rest.shift());
if (!['required', 'legacy'].includes(mode) || !rest.length || !Number.isInteger(expectedCount)) {
  console.error('usage: ci-test-report.mjs required|legacy <count> <report.json...>');
  process.exit(2);
}

const results = new Map();
const collect = suite => {
  for (const spec of suite.specs || []) for (const test of spec.tests || []) {
    const key = `${spec.file} :: ${spec.title}`;
    const status = test.status === 'expected' ? 'passed' : test.status;
    results.set(results.has(key) ? `${key} [${results.size}]` : key, status);
  }
  for (const child of suite.suites || []) collect(child);
};
for (const file of rest) for (const suite of JSON.parse(readFileSync(file, 'utf8')).suites || []) collect(suite);

const by = status => [...results].filter(([, value]) => value === status).map(([key]) => key).sort();
const passed = by('passed'), failed = [...by('unexpected'), ...by('flaky')].sort(), skipped = by('skipped');
const lines = [`## ${mode === 'required' ? 'Required' : 'Wider browser suite against known failures'} Playwright result`, '',
  `ran ${results.size}, passed ${passed.length}, failed ${failed.length}, skipped ${skipped.length}`, ''];
let ok;

if (mode === 'required') {
  ok = results.size === expectedCount && passed.length === expectedCount;
  lines.push(`expected exactly ${expectedCount} passing tests: ${ok ? 'PASS' : 'FAIL'}`, '');
  for (const key of [...failed, ...skipped]) lines.push(`- ${results.get(key)}: ${key}`);
} else {
  const record = JSON.parse(readFileSync(new URL('./ci-known-failures.json', import.meta.url), 'utf8'));
  const historyOnly = new Set(record.historyOnly.tests), baseline = new Set([...record.playwright, ...historyOnly]);
  const outside = failed.filter(key => !baseline.has(key));
  const known = failed.filter(key => baseline.has(key) && !historyOnly.has(key));
  const unrunnable = failed.filter(key => historyOnly.has(key));
  const nowPassing = passed.filter(key => baseline.has(key));
  ok = results.size === expectedCount && outside.length === 0 && skipped.length === 0;
  lines.push(`expected ${expectedCount} tests to run: ${results.size === expectedCount ? 'yes' : 'NO'}`,
    `failures outside the recorded baseline (blocking): ${outside.length}`, `known baseline failures still failing: ${known.length}`,
    `history-only fixtures failing: ${unrunnable.length} (${record.historyOnly.reason})`, `baseline tests now passing: ${nowPassing.length}`, '');
  const section = (title, keys) => { if (keys.length) lines.push(`### ${title}`, '', ...keys.map(key => `- ${key}`), ''); };
  section('Failures outside the recorded baseline', outside);
  section('Skipped', skipped);
  section('Baseline tests now passing', nowPassing);
  section('History-only fixtures', unrunnable);
  section('Known baseline failures still failing', known);
}

const text = `${lines.join('\n')}\n`;
process.stdout.write(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
process.exit(ok ? 0 : 1);
