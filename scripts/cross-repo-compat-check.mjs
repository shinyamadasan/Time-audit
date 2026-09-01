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
// Two modes, because "a sibling repo could not be reached" and "a required merge/release gate
// passed" must never look the same to a script (or a human skimming exit codes):
//
//   default (developer convenience) — a sibling repo not being found is reported as SKIPPED, not
//     FAILED, and the process exits 0 as long as nothing REACHED actually failed. This is what
//     you want on a laptop that only has one or two of the three repos checked out. The final
//     summary line always says explicitly whether this was a full pass or a pass-with-skips —
//     never just "passed" — so a human cannot misread partial verification as complete.
//
//   --strict (or CROSS_REPO_COMPAT_STRICT=1) — for a required merge/release gate. Every leg must
//     actually execute and pass; a SKIP is treated exactly like a FAIL, with a message naming
//     which leg was never executed and why. This is the mode `npm run test:cross-repo-compat`
//     uses; `npm run test:cross-repo-compat:local` is the permissive, default-mode alias for
//     everyday development. See contracts/README.md.
//
// Repo discovery is configurable and never silently permanent: MEAL_REPO_PATH /
// OPENGYM_REPO_PATH override the built-in sibling-directory guesses.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STRICT = process.argv.includes('--strict') || process.env.CROSS_REPO_COMPAT_STRICT === '1';

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

console.log(`\n─── Cross-repo compatibility summary${STRICT ? ' (STRICT MODE)' : ''} ───`);
for (const r of results) {
  console.log(`  ${r.status.padEnd(4)} ${r.label}${r.reason ? `  (${r.reason})` : ''}`);
}

const failedLegs = results.filter(r => r.status === 'FAIL');
const skippedLegs = results.filter(r => r.status === 'SKIP');

if (STRICT) {
  // In strict mode a SKIP is exactly as disqualifying as a FAIL: it means required source
  // verification never ran at all, which is unsafe to treat as a passing release/merge gate.
  if (failedLegs.length === 0 && skippedLegs.length === 0) {
    console.log('\nSTRICT: all required compatibility legs executed and passed.');
    process.exit(0);
  }
  console.error('\nCross-repo compatibility incomplete or failed (strict mode):');
  for (const r of failedLegs) console.error(`  - FAILED: ${r.label}`);
  for (const r of skippedLegs) console.error(`  - NOT EXECUTED: ${r.label} (${r.reason})`);
  console.error('\nStrict mode requires every leg to actually run and pass. Provide MEAL_REPO_PATH / OPENGYM_REPO_PATH (or check out the sibling repos at their default locations) to satisfy a skipped leg, or use the default (non-strict) mode for developer convenience: npm run test:cross-repo-compat:local');
  process.exit(1);
}

// Default mode: a SKIP is not a failure, but the summary must never let a partial run read as a
// full one.
if (failedLegs.length > 0) {
  console.error('\nAt least one REACHED compatibility gate failed. See output above for which contract clause broke.');
  process.exit(1);
}
if (skippedLegs.length > 0) {
  console.log(`\nPASS WITH SKIPS / INCOMPLETE — ${skippedLegs.length} leg(s) were not executed (not failures, but not verified either):`);
  for (const r of skippedLegs) console.log(`  - ${r.label} (${r.reason})`);
  console.log('This is NOT a full cross-repo verification. Use --strict (or CROSS_REPO_COMPAT_STRICT=1) for a gate that requires every leg to actually run.');
  process.exit(0);
}
console.log('\nFULL PASS — every compatibility leg (ChronaSense, Meal, Workout) actually executed and passed.');
