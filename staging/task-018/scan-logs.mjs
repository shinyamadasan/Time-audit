// Post-run monitoring + privacy check over ALL exported logs for the staging completion service:
//   gcloud logging read 'resource.labels.service_name="chronasensecompletionapi"' --project=STAGING --freshness=3h --format=json > logs.json
//   node staging/task-018/scan-logs.mjs logs.json report.json <forbidden string>...
// Pass the run's test-user UIDs and emails, the run label and "Synthetic staging task". Exit 1 on any failure.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function scanLogs(entries, forbidden, harnessReport = null) {
  // Full text of every entry (jsonPayload, textPayload, request logs) is scanned, not just completion events.
  const text = JSON.stringify(entries);
  const hits = forbidden.filter(value => value && text.includes(value));
  const events = entries.map(entry => entry?.jsonPayload).filter(e => e?.component === 'chronasense-completion-api' && e.event === 'completion-request');
  const unavailable = entries.filter(entry => entry?.jsonPayload?.event === 'completion-unavailable').length;
  const outcomes = {};
  for (const e of events) {
    const key = `${e.op}:${e.outcome}${e.reason ? `:${e.reason}` : ''}`;
    outcomes[key] = (outcomes[key] || 0) + 1;
  }
  const unauthenticated = events.filter(e => e.status === 401);
  const checks = {
    noForbiddenStrings: hits.length === 0,
    eventsPresent: events.length > 0,
    // At least the three mandatory bad-token cases, and none of them read anything.
    unauthenticatedReadNothing: unauthenticated.length >= 3 && unauthenticated.every(e => e.reads === 0),
    noUnavailableEvents: unavailable === 0,
    // Exactly one event per endpoint request the harness sent (deliberate missing-endpoint calls never reach it).
    oneEventPerRequest: harnessReport ? events.length === harnessReport.traffic?.endpointRequests : null,
  };
  const ok = Object.values(checks).every(value => value !== false);
  // Outcome keys come from log fields, so they are withheld when a leak exists rather than risk echoing it.
  return { entries: entries.length, events: events.length, unavailable, forbiddenHits: hits.length, checks,
    ...(hits.length ? {} : { outcomes }), ok };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [logs, harness, ...forbidden] = process.argv.slice(2);
  const report = scanLogs(JSON.parse(readFileSync(logs, 'utf8')), forbidden, JSON.parse(readFileSync(harness, 'utf8')));
  console.log(JSON.stringify(report, null, 2)); // hit COUNT only: never echo the matched value
  process.exitCode = report.ok ? 0 : 1;
}
