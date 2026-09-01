#!/usr/bin/env node
// Contract change-detection fingerprint (Phase 5C, deliverable 9).
//
// NOT a security control and NOT a factual-equality authority — the actual factual-equality
// checks live in the adapter code (serializeLifeLedgerFacts / fingerprintLifeLedgerEvent) and
// are unaffected by anything here. This is developer tooling only: a SHA-256 over each contract
// document plus its paired fixture, so a change to either is visible as an explicit diff a
// human/agent has to acknowledge (`--write`) rather than something that can drift unnoticed.
//
// Usage:
//   node scripts/contract-fingerprint.mjs           # check; exits 1 and prints a diff on mismatch
//   node scripts/contract-fingerprint.mjs --write    # recompute and persist

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outPath = path.join(repoRoot, 'contracts', 'CONTRACT_FINGERPRINTS.json');

const ENTRIES = [
  {
    name: 'workout-source-contract-v1',
    files: [
      'contracts/WORKOUT_LEDGER_SOURCE_CONTRACT_V1.md',
      'fixtures/workout-source-contract-v1.fixture.json'
    ]
  },
  {
    name: 'meal-source-contract-v1',
    files: [
      'contracts/MEAL_LEDGER_SOURCE_CONTRACT_V1.md',
      'fixtures/meal-source-contract-v1.fixture.json'
    ]
  }
];

function sha256(filePath) {
  const bytes = fs.readFileSync(path.join(repoRoot, filePath));
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function computeAll() {
  const result = {};
  for (const entry of ENTRIES) {
    result[entry.name] = {};
    for (const file of entry.files) {
      result[entry.name][file] = sha256(file);
    }
  }
  return result;
}

const write = process.argv.includes('--write');
const computed = computeAll();

if (write) {
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), fingerprints: computed }, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${outPath}.`);
  process.exit(0);
}

if (!fs.existsSync(outPath)) {
  console.error(`${outPath} does not exist yet. Run with --write to create it.`);
  process.exit(1);
}

const recorded = JSON.parse(fs.readFileSync(outPath, 'utf8')).fingerprints || {};
let mismatched = false;
for (const entry of ENTRIES) {
  for (const file of entry.files) {
    const before = recorded[entry.name]?.[file];
    const after = computed[entry.name][file];
    if (before !== after) {
      mismatched = true;
      console.error(`CHANGED: ${file} (contract "${entry.name}") — fingerprint no longer matches CONTRACT_FINGERPRINTS.json.`);
      console.error(`  recorded: ${before ?? '(none)'}`);
      console.error(`  current:  ${after}`);
    }
  }
}

if (mismatched) {
  console.error('\nIf this change to a contract or fixture is intentional, review it, then run:');
  console.error('  node scripts/contract-fingerprint.mjs --write');
  process.exit(1);
}
console.log('All contract/fixture fingerprints match CONTRACT_FINGERPRINTS.json.');
