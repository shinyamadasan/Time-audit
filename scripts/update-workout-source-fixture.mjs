#!/usr/bin/env node
// Refreshes the csvImportVariant portion of fixtures/workout-source-contract-v1.fixture.json
// from a real openGym-longevity checkout's own generated fixture.
//
// openGym's import-csv.js transitively imports i18n.js, which uses Vite's import.meta.glob() —
// it cannot be executed by plain Node. The real capture therefore happens INSIDE the openGym
// repo, through Vite/Vitest's own transform:
//
//   1. In the openGym-longevity checkout:
//        cd frontend && WORKOUT_LEDGER_FIXTURE_UPDATE=1 npx vitest run src/lib/workout-ledger-source-contract.test.js
//      This writes frontend/src/lib/__fixtures__/workout-source-contract-v1.fixture.json from a
//      REAL parseWorkoutCSV() execution.
//   2. This script copies that file's contents into this repo's fixture, under the
//      `csvImportVariant` key, leaving the hand-authored `nativeVariant*` keys untouched.
//
// Usage:
//   node scripts/update-workout-source-fixture.mjs [openGymRepoPath]
// or:
//   OPENGYM_REPO_PATH=/path/to/openGym-longevity node scripts/update-workout-source-fixture.mjs
//
// Normal `npm test` runs never call this script and never mutate the tracked fixture.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(repoRoot, 'fixtures', 'workout-source-contract-v1.fixture.json');

const candidates = [
  process.argv[2],
  process.env.OPENGYM_REPO_PATH,
  path.resolve(repoRoot, '..', 'openGym-longevity'),
  path.resolve(repoRoot, '..', '..', 'openGym-longevity'),
  path.resolve(repoRoot, '..', 'openGym')
].filter(Boolean);

const sourceFixtureRelPath = path.join('frontend', 'src', 'lib', '__fixtures__', 'workout-source-contract-v1.fixture.json');
const repoPath = candidates.find(p => fs.existsSync(path.join(p, sourceFixtureRelPath)));

if (!repoPath) {
  console.error(`Could not find ${sourceFixtureRelPath} under any candidate openGym-longevity checkout.`);
  console.error('Tried:', candidates);
  console.error('');
  console.error('First generate it inside the openGym-longevity checkout:');
  console.error('  cd frontend && WORKOUT_LEDGER_FIXTURE_UPDATE=1 npx vitest run src/lib/workout-ledger-source-contract.test.js');
  console.error('Then re-run this script, passing that repo path as an argument or via OPENGYM_REPO_PATH.');
  process.exit(1);
}

const captured = JSON.parse(fs.readFileSync(path.join(repoPath, sourceFixtureRelPath), 'utf8'));
const existing = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
existing.csvImportVariant = {
  capturedAt: captured.capturedAt,
  capturedFrom: `${captured.capturedFrom}, copied from ${repoPath}`,
  sourceCsv: captured.sourceCsv,
  workout: captured.workout
};
fs.writeFileSync(fixturePath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
console.log(`Updated csvImportVariant in ${fixturePath} from ${repoPath}.`);
