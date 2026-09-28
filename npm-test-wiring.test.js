// npm-test-wiring.test.js
//
// A safety net for the package.json wiring itself. `npm test` is a hand-maintained chain and
// `npm run lint` a hand-maintained file list, so a new test file or runtime module can be
// forgotten and everything stays green: a test that never runs, or production code nobody
// lints, passes silently. (Calendar Day + Extended My Day V1 noted this exact gap and left it
// unguarded; it is closed here.)
//
//  - EVERY *.test.js at the repo root and in scripts/ must be part of the `npm test` chain,
//    unless it is one of the named exemptions below, each of which is run by its own script.
//  - EVERY local module the browser loads (an entry <script> tag or an import-map pin) must be
//    in the `npm run lint` file list, unless it is a named, pre-existing exemption.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const html = readFileSync(path.join(HERE, 'index.html'), 'utf8');

/** Run by their own dedicated scripts (test:workout-source-gate / test:meal-source-gate), which
 *  need the sibling source repositories, so they are deliberately not in the default chain. */
const OWN_SCRIPT = new Map([
  ['workout-source-contract-gate.test.js', 'test:workout-source-gate'],
  ['meal-source-contract-gate.test.js', 'test:meal-source-gate'],
]);

/** A pre-existing runtime module that is not in the lint list. Listed by name so it stays visible
 *  and so any NEW omission fails; not changed by this phase. */
const LINT_EXEMPT = new Set(['personal-day-boundary-recovery.js']);

test('every root and scripts/ test file is in the npm test chain, or is run by its own named script', () => {
  const chain = pkg.scripts.test;
  const files = [
    ...readdirSync(HERE).filter(name => name.endsWith('.test.js') || name === 'test.js'),
    ...readdirSync(path.join(HERE, 'scripts')).filter(name => name.endsWith('.test.js')).map(name => `scripts/${name}`),
  ];
  const unwired = files.filter(name => !new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(chain) && !OWN_SCRIPT.has(name));
  assert.deepEqual(unwired, [], 'these test files would never run under `npm test`');
  for (const [file, script] of OWN_SCRIPT) {
    assert.ok(pkg.scripts[script]?.includes(file), `${file} must be run by ${script}`);
  }
});

test('every local module the browser loads is in the lint list', () => {
  const importMap = Object.keys(JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports).map(key => key.replace('./', ''));
  const tags = [...html.matchAll(/<script[^>]*src="([^"?]+)/g)].map(match => match[1]).filter(src => !src.startsWith('http'));
  const runtime = [...new Set([...importMap, ...tags])].filter(file => file.endsWith('.js'));
  const linted = new Set(pkg.scripts.lint.split(/\s+/));
  const missing = runtime.filter(file => !linted.has(file) && !LINT_EXEMPT.has(file));
  assert.deepEqual(missing, [], 'these runtime modules are never linted');
  assert.ok(runtime.length > 40, 'the runtime crawl found the app\'s modules');
});

test('the calendar-native modules specifically are wired everywhere: runtime, lint, tests', () => {
  const newModules = ['calendar-plan-model.js', 'calendar-plan-repository.js', 'calendar-plan-sync.js', 'calendar-plan-live.js', 'calendar-plan-ui.js'];
  const linted = new Set(pkg.scripts.lint.split(/\s+/));
  for (const file of newModules) assert.ok(linted.has(file), `${file} is linted`);
  for (const file of ['calendar-plan-model.test.js', 'calendar-plan-repository.test.js', 'calendar-plan-sync.test.js', 'calendar-plan-live.test.js', 'plan-authority-calendar.test.js']) {
    assert.ok(pkg.scripts.test.includes(`node --test ${file}`), `${file} runs under npm test`);
  }
});
