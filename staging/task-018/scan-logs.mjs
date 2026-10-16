// Post-run privacy check for exported staging logs (`gcloud logging read ... --format=json > logs.json`).
//   node staging/task-018/scan-logs.mjs logs.json <forbidden string>...
// Pass the run's test-user UIDs and emails, the run label and "Synthetic staging task". Exit 1 on any hit.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function scanLogs(entries, forbidden) {
  const completion = entries.filter(entry => entry?.jsonPayload?.component === 'chronasense-completion-api');
  const text = JSON.stringify(completion);
  const hits = forbidden.filter(value => value && text.includes(value));
  const outcomes = {};
  for (const { jsonPayload: e } of completion) {
    const key = `${e.op ?? e.event}:${e.outcome}${e.reason ? `:${e.reason}` : ''}`;
    outcomes[key] = (outcomes[key] || 0) + 1;
  }
  // Outcome keys come from log fields, so they are withheld when a leak exists rather than risk echoing it.
  return { events: completion.length, forbiddenHits: hits.length, ...(hits.length ? {} : { outcomes }), ok: hits.length === 0 && completion.length > 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = scanLogs(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv.slice(3));
  console.log(JSON.stringify(report, null, 2)); // hit COUNT only: never echo the matched value
  process.exitCode = report.ok ? 0 : 1;
}
