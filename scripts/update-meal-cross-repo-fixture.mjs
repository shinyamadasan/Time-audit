// npm run fixture:update
//
// Explicit, opt-in workflow that refreshes the committed cross-repo Life Ledger fixture
// (tests/fixtures/meal-cross-repo-life-ledger-fixture.json) from the sibling Meal repo's
// OWN committed fixture (tests/fixtures/cross-repo-life-ledger-fixture.json).
//
// The Meal repo froze that fixture with its own `npm run fixture:update` (a real browser
// capture of normalizeCookedMeals()/useCookedPortion()). This script only mirrors those
// already-frozen bytes into this repo, so the deterministic UUID/timestamp values are
// preserved exactly. An ordinary `npm test` never runs this — it just reads the committed
// copy and fails closed if it is absent.
//
// Source Meal repo resolution order:
//   1. $MEAL_REPO_DIR (an absolute path to a Meal repo working tree)
//   2. a sibling directory next to this repo whose name starts with "Meal prep app" and
//      that actually contains the source fixture

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MEAL_FEATURE_BRANCH = 'feat/durable-meal-consumption-events';

function branchOf(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_REL = path.join('tests', 'fixtures', 'cross-repo-life-ledger-fixture.json');
const DEST = path.join(REPO_ROOT, 'tests', 'fixtures', 'meal-cross-repo-life-ledger-fixture.json');

function fail(message) {
  console.error(`fixture:update FAILED — ${message}`);
  process.exit(1);
}

function candidateMealRepos() {
  const out = [];
  if (process.env.MEAL_REPO_DIR) out.push(path.resolve(process.env.MEAL_REPO_DIR));
  const parent = path.resolve(REPO_ROOT, '..');
  let siblings = [];
  try {
    siblings = fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('Meal prep app'))
      .map((entry) => path.join(parent, entry.name));
  } catch (error) {
    fail(`could not read parent directory ${parent}: ${error.message}`);
  }
  // Prefer a working tree actually checked out on the Meal feature branch, so the mirrored
  // bytes come from the branch this repo's cross-repo proof is paired with.
  siblings.sort((a, b) => (branchOf(b) === MEAL_FEATURE_BRANCH ? 1 : 0) - (branchOf(a) === MEAL_FEATURE_BRANCH ? 1 : 0));
  return [...out, ...siblings];
}

function validate(fixture) {
  const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(fixture)) return 'top level is not an object';
  if (!Array.isArray(fixture.cookedMeals) || fixture.cookedMeals.length !== 2) return 'cookedMeals must have exactly 2 records';
  if (!Array.isArray(fixture.mealConsumptions) || fixture.mealConsumptions.length !== 1) return 'mealConsumptions must have exactly 1 record';
  if (!isObject(fixture.deletions)) return 'deletions must be an object';
  if (!isObject(fixture.tombstoneScenario) || !isObject(fixture.tombstoneScenario.before) || !isObject(fixture.tombstoneScenario.after)) {
    return 'tombstoneScenario.before / .after must be objects';
  }
  const consumption = fixture.mealConsumptions[0];
  if (typeof consumption.id !== 'string' || consumption.id.length !== 'mc_'.length + 36) return 'mealConsumptions[0].id is not an mc_<uuid>';
  if (!Number.isInteger(consumption.portionsConsumed) || consumption.portionsConsumed < 1 || consumption.portionsConsumed > 99) {
    return 'mealConsumptions[0].portionsConsumed must be an integer 1..99';
  }
  return null;
}

let source = null;
for (const dir of candidateMealRepos()) {
  const candidate = path.join(dir, SOURCE_REL);
  if (fs.existsSync(candidate)) {
    source = candidate;
    break;
  }
}

if (!source) {
  fail(
    'no sibling Meal repo with a committed cross-repo fixture found. ' +
    'Set MEAL_REPO_DIR to a Meal working tree, or create a worktree next to this repo, ' +
    `then run \`npm run fixture:update\` in that Meal repo first to freeze ${SOURCE_REL}.`
  );
}

const raw = fs.readFileSync(source, 'utf8');
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  fail(`source fixture ${source} is not valid JSON: ${error.message}`);
}

const problem = validate(parsed);
if (problem) fail(`source fixture ${source} is malformed: ${problem}`);

const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
const previous = fs.existsSync(DEST) ? fs.readFileSync(DEST, 'utf8') : null;
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.writeFileSync(DEST, serialized, 'utf8');

console.log(`fixture:update OK`);
console.log(`  source: ${source}`);
console.log(`  dest:   ${DEST}`);
console.log(`  ${previous === serialized ? 'unchanged (already in sync)' : 'updated'}`);
