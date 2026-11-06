// Evidence analysis only; does not change test selection, outcomes or release gates.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function readReports(directory) {
  const rows = [];
  const visit = suite => {
    for (const spec of suite.specs || []) for (const test of spec.tests || []) rows.push({
      key: `${spec.file} :: ${spec.title}`, status: test.status, expectedStatus: test.expectedStatus,
      errors: (test.results || []).flatMap(result => result.errors || [])
        .map(error => (error.message || error.value || '').replace(/\u001b\[[0-9;]*m/g, '')),
    });
    for (const child of suite.suites || []) visit(child);
  };
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/wider-\d+\.json$/.test(entry.name)) {
        for (const suite of JSON.parse(readFileSync(file, 'utf8')).suites || []) visit(suite);
      }
    }
  };
  walk(directory);
  if (new Set(rows.map(row => row.key)).size !== rows.length) throw Error('Duplicate report cases');
  return rows;
}

const [baselineDirectory, candidateDirectory] = process.argv.slice(2);
const baseline = readReports(baselineDirectory), candidate = readReports(candidateDirectory);
const catalog = JSON.parse(readFileSync('scripts/ci-known-failures.json', 'utf8'));
const known = new Set([...catalog.playwright, ...catalog.historyOnly.tests]);
const failed = rows => rows.filter(row => ['unexpected', 'flaky', 'skipped'].includes(row.status));
const baselineFailed = new Set(failed(baseline).map(row => row.key));
const counts = rows => Object.fromEntries([...new Set(rows.map(row => row.status))]
  .map(status => [status, rows.filter(row => row.status === status).length]));
console.log(JSON.stringify({
  baseline: { total: baseline.length, counts: counts(baseline) },
  candidate: { total: candidate.length, counts: counts(candidate) },
  absentCases: baseline.filter(row => !candidate.some(item => item.key === row.key)).map(row => row.key),
  addedCases: candidate.filter(row => !baseline.some(item => item.key === row.key)).map(row => row.key),
  outsideCatalog: failed(candidate).filter(row => !known.has(row.key)),
  newlyFailingAgainstPriorRun: failed(candidate).filter(row => !baselineFailed.has(row.key)),
  nowPassingAgainstPriorRun: candidate.filter(row => row.status === 'expected' && baselineFailed.has(row.key)).map(row => row.key),
  failures: failed(candidate),
}, null, 2));
