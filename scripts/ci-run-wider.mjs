#!/usr/bin/env node
// scripts/ci-run-wider.mjs <shard> <shards>
//
// Runs one shard of every browser spec that is not in $MANDATORY_SPECS and not the packaged release spec,
// then judges it with `ci-test-report.mjs legacy`: only failures recorded in scripts/ci-known-failures.json
// are tolerated. The CI regression-report job then requires the exact total across all shards.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const [shard, shards] = process.argv.slice(2);
const mandatory = new Set((process.env.MANDATORY_SPECS || '').split(/\s+/).filter(Boolean));
if (!shard || !shards || mandatory.size === 0) {
  console.error('usage: MANDATORY_SPECS="..." ci-run-wider.mjs <shard> <shards>');
  process.exit(2);
}
const specs = readdirSync('tests').filter(name => name.endsWith('.spec.js')).map(name => `tests/${name}`)
  .filter(file => !mandatory.has(file) && file !== 'tests/accounting-release-artifacts.spec.js').sort();
const report = `wider-${shard}.json`;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = spawnSync(npx, ['playwright', 'test', ...specs, '--forbid-only', `--shard=${shard}/${shards}`, '--reporter=list,json'],
  { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: report }, shell: process.platform === 'win32' });
console.log(`playwright exit ${run.status}; judging ${report} against the recorded known failures`);
const judged = spawnSync(process.execPath, ['scripts/ci-test-report.mjs', 'legacy', 'any', report], { stdio: 'inherit' });
process.exit(judged.status ?? 1);
