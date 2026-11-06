// Deterministic evidence analysis only; no tests, runtime or release decisions are changed.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const root = path.resolve(process.argv[2] || 'release-verification/perf-recovery-v1/blocking-failure');
const hosted = path.join(root, 'hosted-42280197609');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
const live = entries => (entries || []).filter(entry => entry && !entry.deleted).sort((a, b) => a.tsStart - b.tsStart);
const kib = (lines, key) => {
  const value = lines?.find(line => line.startsWith(key + ':'))?.match(/:\s*(\d+)/)?.[1];
  return value == null ? null : Number(value) * 1024;
};
const summary = { run: 42280197609, diagnosticCommit: 'a3d461c029263b06d158f3067af76231ac666f7a', subjects: {} };
for (const label of ['candidate', 'predecessor']) {
  const directory = path.join(hosted, `perf-blocker-${label}`);
  const runs = Object.fromEntries(['control', 'instrumented'].map(mode => [mode, read(path.join(directory, mode, 'run-result.json'))]));
  const diagnostics = walk(path.join(directory, 'instrumented/test-results')).filter(file => path.basename(file) === 'diagnostic.json').map(read);
  const cases = diagnostics.map(d => {
    const terminal = d.terminal.at(-1), state = terminal?.state;
    const entries = live(state?.entries), stored = live(state?.storedEntries ? JSON.parse(state.storedEntries) : []);
    const remote = live(Object.values(state?.remote?.entries || {}));
    return { repeat: d.repeat, worker: d.worker, status: d.status, browser: d.browserVersion,
      startedAt: d.startedAt, afterEachStartedAt: d.afterEachStartedAt, endedAt: d.endedAt,
      mainNavigations: d.events.filter(e => e.type === 'frame-navigated' && e.main).length,
      inTestCrashEvents: d.events.filter(e => /page-crash|browser-disconnected|Inspector.targetCrashed/.test(e.type)
        && d.startedAt + e.elapsedMs <= d.afterEachStartedAt),
      pageErrors: d.events.filter(e => e.type === 'page-error'), observerErrors: d.observerErrors,
      terminalErrors: d.terminal.filter(row => row.error || row.exception).map(row => ({ error: row.error, exception: row.exception })),
      entryCount: entries.length, contiguous: entries.length === 2 && entries[1].tsStart === entries[0].ts,
      totalMs: entries.reduce((sum, entry) => sum + entry.ts - entry.tsStart, 0),
      roundedMinutes: Math.round(entries.reduce((sum, entry) => sum + entry.ts - entry.tsStart, 0) / 60000),
      distinctEntryIds: new Set(entries.map(entry => entry.id)).size,
      storedMatchesEntries: isDeepStrictEqual(stored, entries), remoteMatchesEntries: isDeepStrictEqual(remote, entries),
      stopped: state?.running === false && state?.remote?.timer?.running === false,
      terminalQueueLength: state?.accounting?.queue?.length ?? null,
      terminalHudCaptured: Object.hasOwn(state || {}, 'hud') };
  });
  const samples = diagnostics.flatMap(d => d.samples);
  const rssSums = samples.map(sample => (sample.browserProcesses || []).reduce((sum, process) => sum + (kib(process.status, 'VmRSS') || 0), 0));
  const protocol = read(path.join(directory, 'instrumented/protocol-errors.json'));
  const unique = new Map();
  for (const entry of protocol.observations) {
    const item = entry.startsWith('{') ? JSON.parse(entry) : { raw: entry };
    const old = unique.get(item.raw);
    if (!old || item.command?.diagnosticProbe || !old.command) unique.set(item.raw, item);
  }
  const parsed = [...unique.values()].map(item => ({ ...item,
    at: Date.parse(item.raw.slice(0, 24)), message: JSON.parse(item.raw.slice(item.raw.indexOf('{'), item.raw.lastIndexOf('}') + 1)) }));
  const errors = parsed.filter(item => item.message.error).map(item => ({ at: item.at, error: item.message.error,
    command: item.command || null, sessionId: item.message.sessionId || null,
    nearAnyAfterEachOrTeardown: cases.some(d => item.at >= d.afterEachStartedAt && item.at <= d.endedAt + 500),
    insideAnyTestWindow: cases.some(d => item.at >= d.startedAt && item.at < d.afterEachStartedAt) }));
  const crashes = parsed.filter(item => item.message.method === 'Inspector.targetCrashed').map(item => ({
    at: item.at, sessionId: item.message.sessionId,
    nearAnyAfterEachOrTeardown: cases.some(d => item.at >= d.afterEachStartedAt && item.at <= d.endedAt + 500),
    insideAnyTestWindow: cases.some(d => item.at >= d.startedAt && item.at < d.afterEachStartedAt) }));
  summary.subjects[label] = {
    runs: Object.fromEntries(Object.entries(runs).map(([mode, run]) => [mode, {
      commit: run.commit, node: run.node, platform: run.platform, playwright: run.playwright,
      sourceSha256: run.sourceSha256, lockSha256: run.lockSha256, repeats: run.repeats, workers: run.workers,
      countIntegrity: run.countIntegrity, exitCode: run.exitCode, cases: run.selectedCases.length,
      statuses: run.selectedCases.map(test => test.status), sourceCopyIdentical: run.originalBytesAfterPrefixIdentical ?? null,
    }])), cases,
    resources: { samples: samples.length,
      minimumMemAvailableBytes: Math.min(...samples.map(s => kib(s.meminfo, 'MemAvailable')).filter(n => n != null)),
      maximumNodeRssBytes: Math.max(...samples.map(s => s.node.rss)),
      maximumEnumeratedBrowserRssSumBytes: Math.max(...rssSums),
      maximumCommittedAsBytes: Math.max(...samples.map(s => kib(s.meminfo, 'Committed_AS')).filter(n => n != null)),
      cgroupEventsAvailableSamples: samples.filter(s => s.cgroupEvents != null).length,
      unavailableCgroupIsNotZeroOOMEvents: true },
    protocol: { parsed: protocol.parsed, unparsed: protocol.unparsed, truncated: protocol.truncated,
      dropped: protocol.dropped, droppedOutputBytes: protocol.droppedOutputBytes,
      rawObservationCount: protocol.observations.length, uniqueObservationCount: unique.size,
      inducedUniqueErrors: errors.filter(item => item.command?.diagnosticProbe).length,
      nonProbeErrors: errors.filter(item => !item.command?.diagnosticProbe), targetCrashedNotifications: crashes,
      promiseCollectedResponses: errors.filter(item => /Promise was collected/i.test(item.error.message)).length,
      stopAndLogRuntimeErrorResponses: errors.filter(item => item.command?.stopAndLog).length,
      phaseLimit: 'Temporal windows overlap across two workers; session-to-test ownership is incomplete. Near teardown is not causal attribution.' },
  };
}
const allRuns = Object.values(summary.subjects).flatMap(subject => Object.values(subject.runs));
summary.comparability = { sameNode: new Set(allRuns.map(run => run.node)).size === 1,
  samePlaywright: new Set(allRuns.map(run => run.playwright)).size === 1,
  sameSourceHash: new Set(allRuns.map(run => run.sourceSha256)).size === 1,
  sameLockHash: new Set(allRuns.map(run => run.lockSha256)).size === 1,
  limitation: 'Same selected case and configured runner/browser stack; not the original 278-case ambient workload or original unretained trace.' };
fs.writeFileSync(path.join(root, 'MATCHED_SUMMARY.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ comparability: summary.comparability,
  subjects: Object.fromEntries(Object.entries(summary.subjects).map(([label, subject]) => [label, {
    cases: subject.cases.length, allTerminalChecks: subject.cases.every(c => c.entryCount === 2 && c.contiguous && c.roundedMinutes === 75
      && c.distinctEntryIds === 2 && c.storedMatchesEntries && c.remoteMatchesEntries && c.stopped),
    mainNavigations: subject.cases.map(c => c.mainNavigations), resources: subject.resources,
    nonProbeErrorGroups: Object.fromEntries([...new Set(subject.protocol.nonProbeErrors.map(e => e.error.message))]
      .map(message => [message, subject.protocol.nonProbeErrors.filter(e => e.error.message === message).length])),
    crashNotifications: subject.protocol.targetCrashedNotifications.length,
    crashNearTeardown: subject.protocol.targetCrashedNotifications.filter(c => c.nearAnyAfterEachOrTeardown).length,
    inTestCrashEvents: subject.cases.flatMap(c => c.inTestCrashEvents).length,
    promiseCollected: subject.protocol.promiseCollectedResponses, stopRuntimeErrors: subject.protocol.stopAndLogRuntimeErrorResponses,
  }])) }, null, 2));
