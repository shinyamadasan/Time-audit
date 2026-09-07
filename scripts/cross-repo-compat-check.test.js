// ── Tests for the cross-repo compatibility RUNNER itself (not the contracts it orchestrates) ──
//
// The bug these tests lock down: on Windows a sibling-repo path handed to the runner through
// OPENGYM_REPO_PATH / MEAL_REPO_PATH (or inherited from a shell on a lower-case drive letter)
// reached spawnSync() as `c:\…` instead of the on-disk-canonical `C:\…`. Vitest 4 +
// rolldown-vite 8 then evaluated the Workout contract file in a module graph where
// @vitest/runner's `runner` singleton was never bound, so its first top-level describe() threw
// "Cannot read properties of undefined (reading 'config')" and the leg reported "0 test" — a
// false FAIL of the release gate that had nothing to do with any contract.
//
// Strategy: exercise the real script end to end against a synthetic harness (a throwaway
// "ChronaSense repo" plus fake Meal / Workout sibling checkouts whose `test:ledger-contract`
// scripts are stubs we control). No real test runner, no real source repo, fast, deterministic.
//
// Run in isolation: `npm run test:cross-repo-runner`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildLegEnv,
  canonicalizeDir,
  cleanupLegTmpDirs,
  findRepo,
  legStatusFromExit,
  makeLegTmpDir
} from './cross-repo-compat-check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_SRC = path.join(__dirname, 'cross-repo-compat-check.mjs');
const IS_WIN = process.platform === 'win32';

// ── Synthetic harness ────────────────────────────────────────────────────────────────────────
//
// Lays out, under a fresh temp dir:
//   <root>/harness/scripts/cross-repo-compat-check.mjs   (copy of the real runner)
//   <root>/harness/package.json                          (test:adapter-contracts -> stub)
//   <root>/Meal prep app/…                               (marker files + test:ledger-contract stub)
//   <root>/openGym-longevity/frontend/…                  (marker files + test:ledger-contract stub)
//
// Each stub, when run, appends one JSON line to <root>/legs.log recording its label, cwd, the
// temp-dir env vars it saw, and a sentinel string — then exits with the code the test asked for.

function makeStub(exitCode, label) {
  // Written as a .mjs the stub package.json invokes via `node`.
  return [
    `import fs from 'node:fs';`,
    `const rec = {`,
    `  label: ${JSON.stringify(label)},`,
    `  cwd: process.cwd(),`,
    `  TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR,`,
    `  sentinel: 'STUB_SENTINEL_' + ${JSON.stringify(label)},`,
    `};`,
    `fs.appendFileSync(process.env.LEGS_LOG, JSON.stringify(rec) + '\\n');`,
    `console.log(rec.sentinel + ' (cwd=' + rec.cwd + ')');`,
    `process.exit(${exitCode});`
  ].join('\n');
}

function buildHarness({ chronaExit = 0, mealExit = 0, workoutExit = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xrepo-runner-test-'));
  const harness = path.join(root, 'harness');
  fs.mkdirSync(path.join(harness, 'scripts'), { recursive: true });
  fs.copyFileSync(RUNNER_SRC, path.join(harness, 'scripts', 'cross-repo-compat-check.mjs'));

  fs.writeFileSync(path.join(harness, 'chrona-stub.mjs'), makeStub(chronaExit, 'chronasense'));
  fs.writeFileSync(path.join(harness, 'package.json'), JSON.stringify({
    name: 'harness-chronasense', private: true,
    scripts: { 'test:adapter-contracts': 'node chrona-stub.mjs' }
  }, null, 2));

  const meal = path.join(root, 'Meal prep app');
  fs.mkdirSync(path.join(meal, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(meal, 'tests', 'ledger-source-contract.spec.js'), '// marker\n');
  fs.writeFileSync(path.join(meal, 'meal-stub.mjs'), makeStub(mealExit, 'meal'));
  fs.writeFileSync(path.join(meal, 'package.json'), JSON.stringify({
    name: 'harness-meal', private: true,
    scripts: { 'test:ledger-contract': 'node meal-stub.mjs' }
  }, null, 2));

  const workoutFrontend = path.join(root, 'openGym-longevity', 'frontend');
  fs.mkdirSync(path.join(workoutFrontend, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(workoutFrontend, 'src', 'lib', 'workout-ledger-source-contract.test.js'), '// marker\n');
  fs.writeFileSync(path.join(workoutFrontend, 'workout-stub.mjs'), makeStub(workoutExit, 'workout'));
  fs.writeFileSync(path.join(workoutFrontend, 'package.json'), JSON.stringify({
    name: 'harness-workout', private: true,
    scripts: { 'test:ledger-contract': 'node workout-stub.mjs' }
  }, null, 2));

  return {
    root,
    runner: path.join(harness, 'scripts', 'cross-repo-compat-check.mjs'),
    mealPath: meal,
    workoutPath: path.join(root, 'openGym-longevity'),
    legsLog: path.join(root, 'legs.log'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function runHarness(h, { strict = true, mealRepoPath, openGymRepoPath, extraEnv = {} } = {}) {
  const args = [h.runner];
  if (strict) args.push('--strict');
  const res = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      LEGS_LOG: h.legsLog,
      MEAL_REPO_PATH: mealRepoPath ?? h.mealPath,
      OPENGYM_REPO_PATH: openGymRepoPath ?? h.workoutPath,
      ...extraEnv
    }
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const legs = fs.existsSync(h.legsLog)
    ? fs.readFileSync(h.legsLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  return { status: res.status, out, legs };
}

// ── 1. Ordering is deterministic: ChronaSense -> Meal -> Workout ──────────────────────────────
test('legs execute in the fixed order ChronaSense -> Meal -> Workout', () => {
  const h = buildHarness();
  try {
    const { status, legs, out } = runHarness(h);
    assert.equal(status, 0, out);
    assert.deepEqual(legs.map(l => l.label), ['chronasense', 'meal', 'workout']);
    assert.ok(out.indexOf('STUB_SENTINEL_chronasense') < out.indexOf('STUB_SENTINEL_meal'));
    assert.ok(out.indexOf('STUB_SENTINEL_meal') < out.indexOf('STUB_SENTINEL_workout'));
  } finally {
    h.cleanup();
  }
});

// ── 2. Per-leg environment / temp isolation ──────────────────────────────────────────────────
test('each leg runs under its own fresh TEMP/TMP/TMPDIR, all under os.tmpdir()', () => {
  const h = buildHarness();
  try {
    const { legs, status, out } = runHarness(h);
    assert.equal(status, 0, out);
    const temps = legs.map(l => l.TEMP);
    assert.equal(new Set(temps).size, 3, `expected 3 distinct TEMP dirs, got ${JSON.stringify(temps)}`);
    for (const l of legs) {
      assert.equal(l.TEMP, l.TMP);
      assert.equal(l.TEMP, l.TMPDIR);
      assert.ok(
        canonicalizeDir(path.dirname(l.TEMP)) === canonicalizeDir(os.tmpdir()),
        `${l.TEMP} is not directly under os.tmpdir() (${os.tmpdir()})`
      );
    }
  } finally {
    h.cleanup();
  }
});

// ── 3. Required source paths propagate to the child's cwd ────────────────────────────────────
test('MEAL_REPO_PATH / OPENGYM_REPO_PATH propagate to the leg cwd', () => {
  const h = buildHarness();
  try {
    const { legs, status, out } = runHarness(h);
    assert.equal(status, 0, out);
    const meal = legs.find(l => l.label === 'meal');
    const workout = legs.find(l => l.label === 'workout');
    assert.equal(canonicalizeDir(meal.cwd), canonicalizeDir(h.mealPath));
    assert.equal(canonicalizeDir(workout.cwd), canonicalizeDir(path.join(h.workoutPath, 'frontend')));
  } finally {
    h.cleanup();
  }
});

// ── 4. The actual fix: a non-canonical (lower-case drive) override still lands on a canonical cwd
test('a lower-case-drive OPENGYM_REPO_PATH is canonicalised before it reaches the child', { skip: !IS_WIN }, () => {
  const h = buildHarness();
  try {
    const lower = h.workoutPath.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + ':');
    assert.notEqual(lower, h.workoutPath, 'precondition: drive letter was actually lower-cased');
    const { legs, status, out } = runHarness(h, { openGymRepoPath: lower });
    assert.equal(status, 0, out);
    const workout = legs.find(l => l.label === 'workout');
    // The child's real cwd must carry the on-disk-canonical (upper-case) drive letter, not the
    // lower-case one we passed in.
    assert.match(workout.cwd, /^[A-Z]:/, `child cwd kept a non-canonical drive letter: ${workout.cwd}`);
    assert.equal(canonicalizeDir(workout.cwd), canonicalizeDir(path.join(h.workoutPath, 'frontend')));
  } finally {
    h.cleanup();
  }
});

// ── 5. A failed child causes strict failure; nothing downstream can undo it ───────────────────
test('strict: a non-zero exit from ANY leg fails the whole gate', () => {
  for (const which of ['chronaExit', 'mealExit', 'workoutExit']) {
    const h = buildHarness({ [which]: 1 });
    try {
      const { status, out } = runHarness(h, { strict: true });
      assert.equal(status, 1, `${which}=1 should fail strict\n${out}`);
      assert.match(out, /incomplete or failed \(strict mode\)/);
    } finally {
      h.cleanup();
    }
  }
});

test('a later PASS leg cannot turn an earlier FAIL into an overall pass', () => {
  // ChronaSense fails, Meal + Workout pass -> still overall FAIL, still exit 1.
  const h = buildHarness({ chronaExit: 1, mealExit: 0, workoutExit: 0 });
  try {
    const { status, out, legs } = runHarness(h);
    assert.equal(status, 1, out);
    assert.equal(legs.length, 3, 'all three legs still ran');
    assert.match(out, /FAIL ChronaSense/);
    assert.match(out, /PASS Meal/);
    assert.match(out, /PASS Workout/);
    assert.doesNotMatch(out, /all required compatibility legs executed and passed/);
  } finally {
    h.cleanup();
  }
});

// ── 6. Child stdout/stderr stay visible ──────────────────────────────────────────────────────
test('child stdout is inherited (sentinels appear in the runner output)', () => {
  const h = buildHarness();
  try {
    const { out } = runHarness(h);
    assert.match(out, /STUB_SENTINEL_chronasense/);
    assert.match(out, /STUB_SENTINEL_meal/);
    assert.match(out, /STUB_SENTINEL_workout/);
  } finally {
    h.cleanup();
  }
});

// ── 7. The runner does not mutate the (fake) source checkouts ─────────────────────────────────
test('runner leaves the sibling checkouts byte-for-byte unchanged', () => {
  const h = buildHarness({ workoutExit: 1 }); // even on failure
  try {
    const snapshot = dir => {
      const map = {};
      for (const p of walk(dir)) map[path.relative(dir, p)] = fs.statSync(p).mtimeMs + ':' + fs.readFileSync(p, 'utf8').length;
      return map;
    };
    const before = { meal: snapshot(h.mealPath), workout: snapshot(path.join(h.workoutPath, 'frontend')) };
    runHarness(h);
    const after = { meal: snapshot(h.mealPath), workout: snapshot(path.join(h.workoutPath, 'frontend')) };
    assert.deepEqual(after, before);
  } finally {
    h.cleanup();
  }
});

// ── 8. Strict SKIP semantics preserved (missing repo path is fail-closed) ─────────────────────
test('strict: an undiscoverable source repo is treated as FAIL, not skipped-and-passed', () => {
  const h = buildHarness();
  try {
    // Remove the fake openGym checkout and point the override at nothing, so every discovery
    // path misses.
    fs.rmSync(h.workoutPath, { recursive: true, force: true });
    const missing = path.join(h.root, 'nope');
    const { status, out } = runHarness(h, { openGymRepoPath: missing });
    assert.equal(status, 1, out);
    assert.match(out, /NOT EXECUTED: Workout/);
    assert.doesNotMatch(out, /all required compatibility legs executed and passed/);
  } finally {
    h.cleanup();
  }
});

// ── 9. Unit coverage of the exported helpers ─────────────────────────────────────────────────
test('legStatusFromExit maps only exit 0 to PASS', () => {
  assert.equal(legStatusFromExit(0), 'PASS');
  assert.equal(legStatusFromExit(1), 'FAIL');
  assert.equal(legStatusFromExit(null), 'FAIL'); // spawn failed to start
  assert.equal(legStatusFromExit(undefined), 'FAIL');
});

test('canonicalizeDir returns an absolute on-disk path and (on Windows) an upper-case drive', () => {
  const canon = canonicalizeDir(__dirname);
  assert.ok(path.isAbsolute(canon));
  assert.ok(fs.existsSync(canon));
  if (IS_WIN) {
    assert.match(canon, /^[A-Z]:\\/);
    const lowered = canon.replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ':');
    assert.equal(canonicalizeDir(lowered), canon, 'lower-cased drive letter must normalise back');
  }
});

test('buildLegEnv copies the base env and repoints only the temp vars', () => {
  const base = { PATH: 'x', FOO: 'bar', TEMP: 'old', TMP: 'old', TMPDIR: 'old' };
  const env = buildLegEnv(base, '/leg/tmp');
  assert.equal(env.PATH, 'x');
  assert.equal(env.FOO, 'bar');
  assert.equal(env.TEMP, '/leg/tmp');
  assert.equal(env.TMP, '/leg/tmp');
  assert.equal(env.TMPDIR, '/leg/tmp');
  assert.notEqual(env, base); // a copy, not the same object
});

test('makeLegTmpDir creates distinct real dirs under os.tmpdir(); cleanupLegTmpDirs removes them', () => {
  const a = makeLegTmpDir('leg one!!');
  const b = makeLegTmpDir('leg one!!'); // same label -> still distinct dir
  assert.notEqual(a, b);
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
  assert.equal(canonicalizeDir(path.dirname(a)), canonicalizeDir(os.tmpdir()));
  cleanupLegTmpDirs();
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b));
});

test('findRepo honours the env override first, then falls back to candidates', () => {
  const h = buildHarness();
  try {
    const viaOverride = findRepo('X_MEAL', ['/nope'], 'package.json', { X_MEAL: h.mealPath });
    assert.equal(viaOverride, h.mealPath);
    const viaCandidate = findRepo('X_MEAL', [h.mealPath], 'package.json', {});
    assert.equal(viaCandidate, h.mealPath);
    const none = findRepo('X_MEAL', ['/nope'], 'package.json', {});
    assert.equal(none, undefined);
  } finally {
    h.cleanup();
  }
});

// ── 10. Control proof (opt-in): the isolated context fixes the real Vitest contamination ──────
//
// Only runs when CROSS_REPO_COMPAT_CONTROL_PROOF=1 and a real openGym frontend is reachable —
// it depends on the upstream Vitest/rolldown-vite behaviour and a real checkout, so it is not
// part of the default suite (which must pass on any machine).
test('control: raw lower-case-drive cwd reproduces "0 test"; canonicalised cwd does not', {
  skip: process.env.CROSS_REPO_COMPAT_CONTROL_PROOF !== '1' ? 'set CROSS_REPO_COMPAT_CONTROL_PROOF=1 to run' : (!IS_WIN && 'Windows-only')
}, () => {
  const gym = findRepo('OPENGYM_REPO_PATH', [
    path.resolve(__dirname, '..', '..', 'openGym-longevity')
  ], path.join('frontend', 'package.json'));
  assert.ok(gym, 'need a real openGym-longevity checkout for the control proof');
  const frontend = path.join(gym, 'frontend');

  const runLeg = cwd => {
    const r = spawnSync('npm', ['run', 'test:ledger-contract'], {
      cwd, encoding: 'utf8', shell: true,
      env: buildLegEnv(process.env, makeLegTmpDir('control'))
    });
    return (r.stdout || '') + (r.stderr || '');
  };

  const lower = frontend.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + ':');
  const rawOut = runLeg(lower);
  const fixedOut = runLeg(canonicalizeDir(lower));
  cleanupLegTmpDirs();

  assert.match(rawOut, /0 test|no tests/, 'expected the raw lower-case-drive cwd to reproduce the contamination');
  assert.match(fixedOut, /29 passed/, 'expected the canonicalised cwd to collect all 29 tests');
});

// tiny recursive file walker (dirs only contain files/dirs we made)
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}
