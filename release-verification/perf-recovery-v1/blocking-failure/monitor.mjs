// Diagnostic observers only: no action retries, clock changes, or altered assertions.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const observations = new WeakMap();
const read = file => { try { return readFileSync(file, 'utf8').trim(); } catch { return null; } };
function resources() {
  return { at: Date.now(), freeMemory: os.freemem(), node: process.memoryUsage(),
    meminfo: read('/proc/meminfo')?.split('\n').filter(line => /^(MemAvailable|CommitLimit|Committed_AS|SwapFree):/.test(line)),
    cgroupCurrent: read('/sys/fs/cgroup/memory.current'), cgroupMax: read('/sys/fs/cgroup/memory.max'),
    cgroupEvents: read('/sys/fs/cgroup/memory.events') };
}
export function monitor(test) {
  test.beforeEach(async ({ context, browser }, info) => {
    const state = { title: info.title, repeat: info.repeatEachIndex, worker: info.workerIndex,
      browserVersion: browser.version(), startedAt: Date.now(), events: [], samples: [], pages: [], observerErrors: [] };
    observations.set(info, state);
    const event = (type, detail = {}) => state.events.push({ elapsedMs: Date.now() - state.startedAt, type, ...detail });
    const sample = async () => {
      const row = resources();
      try {
        const { processInfo } = await state.browserCdp.send('SystemInfo.getProcessInfo');
        row.browserProcesses = processInfo.map(process => ({ ...process, status: read(`/proc/${process.id}/status`)
          ?.split('\n').filter(line => /^(Name|VmPeak|VmSize|VmHWM|VmRSS):/.test(line)) }));
      } catch (error) { row.browserProcessError = error.message; }
      if (state.samples.length < 60) state.samples.push(row);
    };
    try { state.browserCdp = await browser.newBrowserCDPSession(); } catch (error) { state.observerErrors.push(error.message); }
    state.disconnected = () => event('browser-disconnected');
    browser.on('disconnected', state.disconnected);
    context.on('close', () => event('context-close'));
    context.on('page', page => {
      const record = { id: state.pages.length, page, session: null };
      state.pages.push(record);
      page.on('framenavigated', frame => event('frame-navigated', { page: record.id, main: frame === page.mainFrame(), url: frame.url() }));
      page.on('crash', () => event('page-crash', { page: record.id }));
      page.on('close', () => event('page-close', { page: record.id }));
      page.on('pageerror', error => event('page-error', { page: record.id, message: error.message }));
      record.ready = (async () => {
        try {
          const cdp = record.session = await context.newCDPSession(page);
          for (const name of ['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Inspector.targetCrashed']) {
            cdp.on(name, detail => event(name, { page: record.id, detail }));
          }
          await cdp.send('Runtime.enable'); await cdp.send('Performance.enable');
        } catch (error) { state.observerErrors.push(error.message); }
      })();
    });
    await sample(); state.interval = setInterval(() => { void sample(); }, 1000);
  });
  test.afterEach(async ({ browser }, info) => {
    const state = observations.get(info); if (!state) return;
    const afterEachStartedAt = Date.now();
    clearInterval(state.interval); browser.off('disconnected', state.disconnected);
    const terminal = [];
    for (const record of state.pages) {
      const row = { page: record.id, closed: record.page.isClosed(), url: record.page.url() };
      try {
        await record.ready;
        const cdp = record.session;
        row.heap = await cdp.send('Runtime.getHeapUsage');
        row.performance = await cdp.send('Performance.getMetrics');
        const result = await cdp.send('Runtime.evaluate', { returnByValue: true, timeout: 1500, expression: `(() => {
          const owner = typeof roomCode === 'string' ? roomCode : null;
          return { url: location.href, navigationEntries: performance.getEntriesByType('navigation').map(e => ({type:e.type,startTime:e.startTime})),
            running: typeof running === 'undefined' ? null : running,
            taskStartTime: typeof taskStartTime === 'undefined' ? null : taskStartTime,
            entries: typeof entries === 'undefined' ? null : entries,
            storedEntries: owner ? localStorage.getItem('ta3-entries:' + owner) : null,
            remote: owner ? window.__fbTest?.get('rooms/' + owner) : null,
            accounting: typeof accountingCoordinator === 'function' ? accountingCoordinator().snapshot() : null };
        })()` });
        row.state = result.result?.value; row.exception = result.exceptionDetails;
        // Deliberately invalid read-only context, AFTER the test/terminal snapshot: validates raw -32000
        // capture. This is labeled induced and is never evidence of the original failure's cause.
        try { await cdp.send('Runtime.evaluate', { expression: '/* blocker-diagnostic-probe */ 1', contextId: -1 }); }
        catch (error) { row.inducedProtocolProbe = error.message; }
      } catch (error) { row.error = error.message; }
      terminal.push(row);
    }
    try { await state.browserCdp?.detach(); } catch {}
    const result = { title: state.title, repeat: state.repeat, worker: state.worker, browserVersion: state.browserVersion,
      status: info.status, expectedStatus: info.expectedStatus, errors: info.errors, events: state.events,
      startedAt: state.startedAt, afterEachStartedAt,
      samples: state.samples, terminal, observerErrors: state.observerErrors, endedAt: Date.now(),
      note: 'Instrumented copy only; extra CDP/logging/resource sampling overhead. No test action retried.' };
    const output = info.outputPath('diagnostic.json');
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(result, null, 2));
    await info.attach('browser-lifecycle-accounting-diagnostic', { path: output, contentType: 'application/json' });
  });
}
