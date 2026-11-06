// Bounded investigation only. Original failure, assertions and outcomes remain visible.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const option = name => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1]; };
const subject = path.resolve(option('--subject') || '.');
const out = path.resolve(option('--out') || 'blocker-diagnostic');
const repeats = Number(option('--repeats') || 10), workers = Number(option('--workers') || 2);
const instrumented = process.argv.includes('--instrumented');
if (![repeats, workers].every(n => Number.isInteger(n) && n > 0) || repeats > 20 || workers > 2) throw Error('Bounded maximum: 20 repeats, 2 workers');
if (existsSync(out)) throw Error(`Evidence directory already exists: ${out}`);
mkdirSync(out, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(subject, 'tests/daily-use-reliability.spec.js');
const source = readFileSync(sourcePath);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = { subject, out, repeats, workers, instrumented, node: process.version, platform: process.platform,
  sourceSha256: hash(source), lockSha256: hash(readFileSync(path.join(subject, 'package-lock.json'))),
  playwright: JSON.parse(readFileSync(path.join(subject, 'node_modules/@playwright/test/package.json'))).version,
  startedAt: new Date().toISOString(), totalMemory: os.totalmem(), freeMemory: os.freemem(), cpus: os.cpus().length };
try { metadata.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: subject, encoding: 'utf8' }).trim(); } catch { metadata.commit = null; }
let config = path.join(subject, 'playwright.config.js'), spec = sourcePath, disposable;
if (instrumented) {
  disposable = path.join(subject, `.perf-blocker-diag-${process.pid}`);
  if (existsSync(disposable)) throw Error(`Disposable path already exists: ${disposable}`);
  mkdirSync(disposable);
  const prefix = `import { monitor } from ${JSON.stringify(pathToFileURL(path.join(here, 'monitor.mjs')).href)};\nmonitor(test);\n`;
  spec = path.join(disposable, 'case.spec.js');
  writeFileSync(spec, Buffer.concat([Buffer.from(prefix), source]));
  writeFileSync(path.join(disposable, 'time-ack-test-server.js'), readFileSync(path.join(subject, 'tests/time-ack-test-server.js')));
  config = path.join(disposable, 'playwright.config.mjs');
  writeFileSync(config, `import original from ${JSON.stringify(pathToFileURL(path.join(subject, 'playwright.config.js')).href)};\nexport default {...original, testDir: ${JSON.stringify(disposable)}, testMatch: 'case.spec.js', testIgnore: []};\n`);
  metadata.originalBytesAfterPrefixIdentical = readFileSync(spec).subarray(Buffer.byteLength(prefix)).equals(source);
}
writeFileSync(path.join(out, 'environment.json'), JSON.stringify(metadata, null, 2));
const report = path.join(out, 'playwright.json'), results = path.join(out, 'test-results');
const args = [path.join(subject, 'node_modules/@playwright/test/cli.js'), 'test', path.relative(subject, spec).split(path.sep).join('/'),
  '--config', config, '--grep', '^.*two reminders retain pending time; Save/reload/Stop has no duplicate coverage or HUD restart$',
  `--repeat-each=${repeats}`, `--workers=${workers}`, '--forbid-only', '--reporter=list,json', '--output', results];
const protocol = [], pending = new Map(), unparsedExamples = [], OUTPUT_LIMIT = 2 * 1024 * 1024;
let dropped = 0, parsed = 0, unparsed = 0, truncated = 0, stdout = '', stderr = '', partial = '', partialOut = '';
let droppedOutputBytes = 0;
function normalLine(line, channel) {
  const text = line + '\n', current = channel === 'stdout' ? stdout : stderr;
  if (Buffer.byteLength(current) + Buffer.byteLength(text) > OUTPUT_LIMIT) { droppedOutputBytes += Buffer.byteLength(text); return; }
  if (channel === 'stdout') { stdout += text; process.stdout.write(text); } else stderr += text;
}
const keep = line => { if (protocol.length < 1500) protocol.push(line.slice(0, 6000)); else dropped++; };
function protocolLine(line) {
  line = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  if (!line.includes('pw:protocol')) { normalLine(line, 'stderr'); return; }
  if (line.includes('LOG TRUNCATED')) { truncated++; return; }
  const start = line.indexOf('{'), end = line.lastIndexOf('}');
  let message; try { message = JSON.parse(line.slice(start, end + 1)); parsed++; } catch {
    unparsed++; if (unparsedExamples.length < 5) unparsedExamples.push(line.slice(0, 1000)); return;
  }
  const key = `${message.sessionId || ''}:${message.id}`;
  if (/SEND/.test(line) && /Runtime\.(evaluate|callFunctionOn)/.test(message.method || '')) {
    if (pending.size > 2000) pending.clear();
    pending.set(key, { method: message.method, awaitPromise: message.params?.awaitPromise,
      stopAndLog: JSON.stringify(message.params || {}).includes('stopAndLog'),
      diagnosticProbe: JSON.stringify(message.params || {}).includes('blocker-diagnostic-probe') });
  }
  if (message.error) keep(JSON.stringify({ raw: line, command: pending.get(key) || null }));
  if (/targetCrashed|executionContextDestroyed|executionContextsCleared|detachedFromTarget/.test(message.method || '')) keep(line);
  if (/RECV/.test(line) && message.id != null) pending.delete(key);
}
let exitCode;
try {
  const child = spawn(process.execPath, args, { cwd: subject,
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: report, BLOCKER_DIAGNOSTIC_OUT: out,
      ...(instrumented ? { DEBUG: 'pw:protocol', DEBUG_COLORS: '0' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => {
    partialOut += chunk.toString(); const lines = partialOut.split(/\r?\n/); partialOut = lines.pop();
    for (const line of lines) { if (line.includes('pw:protocol')) protocolLine(line); else normalLine(line, 'stdout'); }
  });
  child.stderr.on('data', chunk => {
    partial += chunk.toString(); const lines = partial.split(/\r?\n/); partial = lines.pop();
    for (const line of lines) protocolLine(line);
  });
  exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
} finally {
  if (partial) protocolLine(partial);
  if (partialOut) { if (partialOut.includes('pw:protocol')) protocolLine(partialOut); else normalLine(partialOut, 'stdout'); }
  // Test-worker DEBUG output belongs to reporter result.stderr, not the launcher's stderr.
  // Retain bounded errors/lifecycle evidence and report parsing limits rather than huge source dumps.
  if (existsSync(report)) {
    const data = JSON.parse(readFileSync(report, 'utf8'));
    const selected = [];
    const visit = suite => {
      for (const spec of suite.specs || []) for (const test of spec.tests || []) {
        selected.push({ title: spec.title, status: test.status, expectedStatus: test.expectedStatus,
          attempts: test.results?.map(result => result.status) || [] });
        if (instrumented) for (const result of test.results || []) {
          const chunks = result.stderr || [], retained = chunks.filter(entry => !entry.text);
          for (const line of chunks.map(entry => entry.text || '').join('').split(/\r?\n/).filter(Boolean)) {
            if (line.includes('pw:protocol')) protocolLine(line); else retained.push({ text: line + '\n' });
          }
          result.stderr = retained;
        }
      }
      for (const child of suite.suites || []) visit(child);
    };
    for (const suite of data.suites || []) visit(suite);
    metadata.selectedCases = selected;
    metadata.countIntegrity = selected.length === repeats && selected.every(test => test.expectedStatus === 'passed'
      && test.attempts.length === 1 && !test.attempts.includes('skipped') && test.title === 'two reminders retain pending time; Save/reload/Stop has no duplicate coverage or HUD restart');
    if (!metadata.countIntegrity) exitCode ||= 1;
    if (instrumented) writeFileSync(report, JSON.stringify(data, null, 2));
  } else { metadata.countIntegrity = false; exitCode ||= 1; }
  writeFileSync(path.join(out, 'stdout.log'), stdout);
  writeFileSync(path.join(out, 'stderr.log'), stderr);
  writeFileSync(path.join(out, 'protocol-errors.json'), JSON.stringify({ parsed, unparsed, unparsedExamples, truncated, dropped, droppedOutputBytes,
    fullDebugSourcePayloadsRetained: false, observations: protocol }, null, 2));
  writeFileSync(path.join(out, 'run-result.json'), JSON.stringify({ ...metadata, exitCode, endedAt: new Date().toISOString(), freeMemory: os.freemem() }, null, 2));
  if (disposable) {
    const expected = path.resolve(subject, `.perf-blocker-diag-${process.pid}`);
    if (path.resolve(disposable) !== expected || path.dirname(expected) !== subject) throw Error('Unsafe disposable cleanup path');
    rmSync(disposable, { recursive: true, force: true });
  }
}
process.exitCode = exitCode;
