#!/usr/bin/env node
// Refreshes fixtures/meal-source-contract-v1.fixture.json from a real Meal repo checkout's own
// tracked cross-repo fixture (tests/fixtures/cross-repo-life-ledger-fixture.json), which is
// itself only updated by that repo's `npm run fixture:update` (a real Playwright run against
// the real app — see tests/cross-repo-life-ledger-fixture.spec.js there).
//
// This script is the portability fix for the historical sibling-directory dependency: it makes
// a CHECKED-IN COPY inside this repo, so meal-cross-repo-life-ledger.test.js and
// meal-source-contract-gate.test.js keep working even when no sibling Meal checkout exists on
// this machine (a fresh clone, a moved/cleaned-up worktree, CI). The live sibling path is still
// preferred when present and newer, so this repo's tests always exercise the freshest real
// source shape available; the checked-in copy is the floor, not the ceiling.
//
// Usage:
//   node scripts/update-meal-source-fixture.mjs [mealRepoPath]
// or:
//   MEAL_REPO_PATH=/path/to/Meal-prep-app node scripts/update-meal-source-fixture.mjs
//
// Normal `npm test` runs never call this script and never mutate the tracked fixture.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(repoRoot, 'fixtures', 'meal-source-contract-v1.fixture.json');

const candidates = [
  process.argv[2],
  process.env.MEAL_REPO_PATH,
  path.resolve(repoRoot, '..', 'Meal prep app'),
  path.resolve(repoRoot, '..', '..', 'Meal prep app')
].filter(Boolean);

const sourceFixtureRel = path.join('tests', 'fixtures', 'cross-repo-life-ledger-fixture.json');
const repoPath = candidates.find(p => fs.existsSync(path.join(p, sourceFixtureRel)));

if (!repoPath) {
  console.error(`Could not find ${sourceFixtureRel} under any candidate Meal repo checkout.`);
  console.error('Tried:', candidates);
  console.error('');
  console.error('First generate it inside the Meal repo: npm run fixture:update');
  console.error('Then re-run this script, passing that repo path as an argument or via MEAL_REPO_PATH.');
  process.exit(1);
}

fs.copyFileSync(path.join(repoPath, sourceFixtureRel), fixturePath);
console.log(`Updated ${fixturePath} from ${repoPath}.`);
