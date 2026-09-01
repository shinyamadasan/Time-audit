#!/usr/bin/env node
// Cross-repo compatibility workflow (Phase 5C, deliverable 8).
//
// Proves, deterministically and without production data:
//   CURRENT MEAL MAIN        + CURRENT CHRONASENSE MAIN        -> compatible
//   CURRENT WORKOUT SOURCE   + CURRENT CHRONASENSE MAIN        -> compatible
//
// "Compatible" means: this repo's own adapter-contract gate passes (always, using checked-in
// fixtures — see fixtures/resolve-fixture.js), AND, wherever a sibling source checkout can
// actually be found on this machine, that source repo's OWN compatibility gate also passes.
//
// A sibling repo not being found is reported as SKIPPED, not FAILED — this script must remain
// usable after any sibling worktree moves or is cleaned up (see contracts/README.md). It exits
// non-zero only when something that WAS reached actually failed.
//
// Repo discovery is configurable and never silently permanent: MEAL_REPO_PATH /
// OPENGYM_REPO_PATH override the built-in sibling-directory guesses.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const results = [];

function run(label, cmd, args, cwd) {
  console.log(`\n▶ ${label}\n  $ ${cmd} ${args.join(' ')}  (cwd: ${cwd})`);
  // shell:true is required on Windows to resolve `npm` to npm.cmd; args are fixed, known-safe
  // literals defined in this file (never user/environment-controlled), so the lack of shell
  // escaping here is not a command-injection risk.
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.error) console.error(res.error);
  const ok = res.status === 0;
  results.push({ label, status: ok ? 'PASS' : 'FAIL' });
  return ok;
}

function skip(label, reason) {
  console.log(`\n▶ ${label}\n  SKIPPED — ${reason}`);
  results.push({ label, status: 'SKIP', reason });
}

function findRepo(envVar, candidates, markerRelPath) {
  const override = process.env[envVar];
  const all = [override, ...candidates].filter(Boolean);
  return all.find(p => fs.existsSync(path.join(p, markerRelPath)));
}

// ── Leg 1: this repo's own adapter-contract gate (always runs; no external dependency) ────────
run(
  'ChronaSense adapter-contract gate (npm run test:adapter-contracts)',
  'npm', ['run', 'test:adapter-contracts'],
  repoRoot
);

// ── Leg 2: Meal source-side gate (best-effort; skipped cleanly if no checkout is found) ───────
const mealRepo = findRepo('MEAL_REPO_PATH', [
  path.resolve(repoRoot, '..', 'Meal prep app'),
  path.resolve(repoRoot, '..', '..', 'Meal prep app')
], 'package.json');
if (mealRepo && fs.existsSync(path.join(mealRepo, 'tests', 'ledger-source-contract.spec.js'))) {
  run('Meal source-contract gate (npm run test:ledger-contract)', 'npm', ['run', 'test:ledger-contract'], mealRepo);
} else {
  skip('Meal source-contract gate', mealRepo
    ? `found ${mealRepo} but it has no tests/ledger-source-contract.spec.js`
    : 'no Meal checkout found (tried MEAL_REPO_PATH and sibling-directory guesses)');
}

// ── Leg 3: Workout source-side gate (best-effort; skipped cleanly if no checkout is found) ────
const workoutRepo = findRepo('OPENGYM_REPO_PATH', [
  path.resolve(repoRoot, '..', 'openGym-longevity'),
  path.resolve(repoRoot, '..', '..', 'openGym-longevity')
], path.join('frontend', 'package.json'));
if (workoutRepo && fs.existsSync(path.join(workoutRepo, 'frontend', 'src', 'lib', 'workout-ledger-source-contract.test.js'))) {
  run('Workout source-contract gate (npm run test:ledger-contract)', 'npm', ['run', 'test:ledger-contract'], path.join(workoutRepo, 'frontend'));
} else {
  skip('Workout source-contract gate', workoutRepo
    ? `found ${workoutRepo} but its frontend has no src/lib/workout-ledger-source-contract.test.js`
    : 'no openGym-longevity checkout found (tried OPENGYM_REPO_PATH and sibling-directory guesses)');
}

console.log('\n─── Cross-repo compatibility summary ───');
for (const r of results) {
  console.log(`  ${r.status.padEnd(4)} ${r.label}${r.reason ? `  (${r.reason})` : ''}`);
}

const failed = results.some(r => r.status === 'FAIL');
if (failed) {
  console.error('\nAt least one REACHED compatibility gate failed. See output above for which contract clause broke.');
  process.exit(1);
}
console.log('\nAll reached compatibility gates passed. (SKIPPED legs are not failures — see contracts/README.md on portability.)');
