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
//
// ── Per-leg process isolation (why run() looks the way it does) ───────────────────────────────
//
// Each leg is a separate test runner (ChronaSense: node --test; Meal: Playwright; Workout:
// Vitest 4 on rolldown-vite 8) executed via spawnSync. One leg's runner must not be able to
// poison the next leg's collection. Two concrete hazards, one of which bit this gate in
// practice on Windows:
//
//   1. Non-canonical cwd (the real bug). A sibling path handed in through OPENGYM_REPO_PATH /
//      MEAL_REPO_PATH — or inherited from a shell whose current drive letter was lower-case —
//      reaches spawnSync() as e.g. `c:\…\frontend` instead of the on-disk-canonical
//      `C:\…\frontend`. Vitest 4 + rolldown-vite 8 key their SSR module runner off that exact
//      string; with a non-canonical drive-letter case the Workout test file is evaluated in a
//      module graph where @vitest/runner's internal `runner` singleton was never bound, so the
//      file's very first top-level `describe()` throws
//      "TypeError: Cannot read properties of undefined (reading 'config')" and the leg reports
//      "0 test". canonicalizeDir() collapses every cwd to realpath's native (OS-case-exact)
//      form before it can reach spawnSync, which removes the whole class of failure.
//
//   2. Shared scratch directories. Vitest's transform cache, Vite's optimize-deps scratch and
//      Playwright's artifacts all land under the process TEMP dir. Giving each leg its own
//      fresh TEMP/TMP/TMPDIR (makeLegTmpDir) guarantees no on-disk handoff between legs.
//
// Neither mechanism weakens the gate: legs still run in the fixed order ChronaSense → Meal →
// Workout, each child's real exit code is the only thing that decides PASS/FAIL, child stdout
// and stderr stay inherited (visible), and --strict still treats a SKIP exactly like a FAIL.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STRICT = process.argv.includes('--strict') || process.env.CROSS_REPO_COMPAT_STRICT === '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── Process-isolation helpers (exported for scripts/cross-repo-compat-check.test.js) ──────────

// Collapse a directory path to its on-disk-canonical absolute form. On Windows realpath's
// "native" variant is the one that fixes drive-letter / 8.3 / casing drift; plain realpath
// preserves whatever case the caller passed. Falls back gracefully if the path can't be
// resolved (a missing path is handled by the caller's existence checks, not here).
export function canonicalizeDir(dir) {
  const abs = path.resolve(dir);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  }
}

// Every leg gets a private, empty TEMP so no test runner can share scratch state with the next.
const legTmpDirs = [];
export function makeLegTmpDir(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'leg';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `xrepo-compat-${slug}-`));
  legTmpDirs.push(dir);
  return dir;
}
export function cleanupLegTmpDirs() {
  for (const dir of legTmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort — a leftover temp dir is not worth failing a release gate over */
    }
  }
}

// The fully-explicit environment a leg runs under: a copy of the parent environment (so nothing
// is shared by reference) with the temp-dir variables repointed at this leg's private scratch.
export function buildLegEnv(baseEnv, tmpDir) {
  return { ...baseEnv, TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir };
}

// PASS/FAIL purely from a child process's real exit status. Kept separate so it can be
// exercised directly: nothing else is allowed to turn a non-zero exit into a pass.
export function legStatusFromExit(exitStatus) {
  return exitStatus === 0 ? 'PASS' : 'FAIL';
}

export function findRepo(envVar, candidates, markerRelPath, env = process.env) {
  const override = env[envVar];
  const all = [override, ...candidates].filter(Boolean);
  return all.find(p => fs.existsSync(path.join(p, markerRelPath)));
}

// ── Runner ───────────────────────────────────────────────────────────────────────────────────

const results = [];

function run(label, cmd, args, cwd) {
  const legCwd = canonicalizeDir(cwd);
  const tmpDir = makeLegTmpDir(label);
  const env = buildLegEnv(process.env, tmpDir);
  console.log(`\n▶ ${label}\n  $ ${cmd} ${args.join(' ')}  (cwd: ${legCwd})`);
  console.log(`  ↳ isolated TEMP: ${tmpDir}`);
  // shell:true is required on Windows to resolve `npm` to npm.cmd; args are fixed, known-safe
  // literals defined in this file (never user/environment-controlled), so the lack of shell
  // escaping here is not a command-injection risk.
  const res = spawnSync(cmd, args, { cwd: legCwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.error) console.error(res.error);
  const status = legStatusFromExit(res.status);
  results.push({ label, status });
  return status === 'PASS';
}

function skip(label, reason) {
  console.log(`\n▶ ${label}\n  SKIPPED — ${reason}`);
  results.push({ label, status: 'SKIP', reason });
}

function main() {
  process.on('exit', cleanupLegTmpDirs);

  // ── Leg 1: this repo's own adapter-contract gate (always runs; no external dependency) ──────
  run(
    'ChronaSense adapter-contract gate (npm run test:adapter-contracts)',
    'npm', ['run', 'test:adapter-contracts'],
    repoRoot
  );

  // ── Leg 2: Meal source-side gate (best-effort; skipped cleanly if no checkout is found) ─────
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

  // ── Leg 3: Workout source-side gate (best-effort; skipped cleanly if no checkout is found) ──
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

  // Default mode: a SKIP is not a failure, but the summary must never let a partial run read as
  // a full one.
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
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
