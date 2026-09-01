// Portability layer for cross-repo source-contract fixtures (Phase 5C).
//
// Historically, meal-cross-repo-life-ledger.test.js pointed at one hardcoded sibling worktree
// path (`../Meal prep app - durable-consumption-events/...`), which stopped existing the moment
// that worktree was cleaned up — leaving the whole suite silently SKIPPED with no signal that
// anything was wrong. This module fixes that by trying, in order:
//
//   1. An explicit override path (env var) — always wins when set, whether or not the file exists
//      yet, so a misconfigured override fails loudly instead of silently falling through.
//   2. Live sibling checkouts under a few plausible parent-directory layouts — so a real,
//      currently-checked-out source repo is always preferred over a possibly-stale committed copy.
//   3. The checked-in, versioned fixture inside THIS repo (fixtures/*.fixture.json) — the
//      portable floor that keeps these tests runnable after every sibling worktree is gone,
//      on a fresh clone, or in CI.
//
// Returns { fixture, source, path } or { fixture: null, reason } when nothing at all was found
// (only possible if the checked-in fixture itself is missing/corrupt, which should not happen
// on a normal checkout).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function resolve({ envVar, siblingCandidates, checkedInFileName }) {
  const checkedInPath = path.join(repoRoot, 'fixtures', checkedInFileName);

  const overridePath = process.env[envVar];
  if (overridePath) {
    const fixture = readJson(overridePath);
    if (!fixture) {
      return { fixture: null, reason: `${envVar} is set to ${overridePath}, but it could not be read as JSON.` };
    }
    return { fixture, source: 'override', path: overridePath };
  }

  for (const candidatePath of siblingCandidates) {
    const fixture = readJson(candidatePath);
    if (fixture) return { fixture, source: 'live-sibling-repo', path: candidatePath };
  }

  const checkedIn = readJson(checkedInPath);
  if (checkedIn) return { fixture: checkedIn, source: 'checked-in-fallback', path: checkedInPath };

  return {
    fixture: null,
    reason: `No live sibling repo found and the checked-in fallback at ${checkedInPath} is missing or corrupt.`
  };
}

export function resolveMealFixture() {
  return resolve({
    envVar: 'MEAL_REPO_FIXTURE_PATH',
    siblingCandidates: [
      path.resolve(repoRoot, '..', 'Meal prep app', 'tests', 'fixtures', 'cross-repo-life-ledger-fixture.json'),
      path.resolve(repoRoot, '..', '..', 'Meal prep app', 'tests', 'fixtures', 'cross-repo-life-ledger-fixture.json'),
      // Legacy worktree name kept as a candidate for anyone who still has it checked out.
      path.resolve(repoRoot, '..', 'Meal prep app - durable-consumption-events', 'tests', 'fixtures', 'cross-repo-life-ledger-fixture.json')
    ],
    checkedInFileName: 'meal-source-contract-v1.fixture.json'
  });
}

export function resolveWorkoutFixture() {
  return resolve({
    envVar: 'WORKOUT_REPO_FIXTURE_PATH',
    siblingCandidates: [
      path.resolve(repoRoot, '..', 'openGym-longevity', 'frontend', 'src', 'lib', '__fixtures__', 'workout-source-contract-v1.fixture.json'),
      path.resolve(repoRoot, '..', '..', 'openGym-longevity', 'frontend', 'src', 'lib', '__fixtures__', 'workout-source-contract-v1.fixture.json')
    ],
    // Note: a live sibling openGym fixture only ever carries the CSV-import variant (see
    // scripts/update-workout-source-fixture.mjs) — the checked-in fixture is the only place the
    // hand-authored native-variant examples live, so callers needing those must read the
    // checked-in file directly rather than relying on this resolver's live-sibling branch.
    checkedInFileName: 'workout-source-contract-v1.fixture.json'
  });
}
