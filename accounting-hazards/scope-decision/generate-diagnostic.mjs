// Generates a LOCAL instrumented copy; original tests and runtime are never edited.
import { readFileSync, writeFileSync } from 'node:fs';
const source = new URL('../../tests/time-ack-unknown-hazards.spec.js', import.meta.url);
let spec = readFileSync(source, 'utf8')
  .replaceAll("from '../", "from '../../")
  .replace("fileURLToPath(import.meta.url)), '..')", "fileURLToPath(import.meta.url)), '../..')");
spec = spec.replace("import { readFileSync } from 'node:fs';", "import { readFileSync, writeFileSync } from 'node:fs';");
const hook = `
test.beforeEach(async ({ page }, info) => {
  const evidence = { title: info.title, evaluations: [], network: [], errors: [] };
  const evaluate = page.evaluate.bind(page);
  async function snapshot() {
    return evaluate(() => ({
      entries: typeof entries === 'undefined' ? null : JSON.parse(JSON.stringify(entries)),
      cursor: typeof timeAckCursorFrame === 'function' ? timeAckCursorFrame() : null,
      records: Object.fromEntries(Object.keys(localStorage).filter(k =>
        /^(ta3-accounting-|ta3-time-ack)/.test(k)).map(k => [k, JSON.parse(localStorage.getItem(k))])),
    })).catch(error => ({ snapshotError: error.message }));
  }
  page.evaluate = async (fn, arg) => {
    const label = String(fn);
    const value = await evaluate(fn, arg);
    evidence.evaluations.push({ label, value, state: await snapshot() });
    return value;
  };
  page.on('request', req => {
    const at = new URL(req.url());
    if (at.hostname === '127.0.0.1' && at.pathname.includes('/rooms/'))
      evidence.network.push({ kind: 'request', method: req.method(), path: at.pathname, body: req.postData() });
  });
  page.on('response', res => {
    const at = new URL(res.url());
    if (at.hostname === '127.0.0.1' && at.pathname.includes('/rooms/'))
      evidence.network.push({ kind: 'response', path: at.pathname, status: res.status() });
  });
  page.on('pageerror', error => evidence.errors.push(error.message));
  info._scopeEvidence = evidence;
});
test.afterEach(async ({ page }, info) => {
  if (info._scopeEvidence) writeFileSync(new URL('evidence-' +
    info.file.split(/[\\\\/]/).pop().replace('.spec.js', '') + '-' + info.repeatEachIndex + '-' +
    (info.title.startsWith('bob') ? 'bob' : 'alice') + '.json', import.meta.url),
    JSON.stringify({ ...info._scopeEvidence, status: info.status }, null, 2));
  if (info._scopeEvidence) await info.attach('durability-evidence', {
    body: JSON.stringify(info._scopeEvidence, null, 2), contentType: 'application/json'
  });
});
`;
spec = spec.replace("for (const uid of ['alice', 'bob']) {", hook + "\nfor (const uid of ['alice', 'bob']) {");
writeFileSync(new URL('instrumented.spec.js', import.meta.url), spec);
const helpers = spec.slice(0, spec.indexOf("for (const uid of ['alice', 'bob']) {"));
const controlled = `
for (const uid of ['alice', 'bob']) {
  test(uid + ': controlled scheduled replay starts before abort-route removal; original stays UNKNOWN across reload', async ({ page }) => {
    const world = await emulator.fresh(rules); await open(page, world, uid); await saved(page, world, uid);
    await install(page); await enforce(world);
    const pattern = 'http://127.0.0.1:' + emulator.port + '/rooms/uid_' + uid + '.json*';
    await page.route(pattern, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
    await page.evaluate(() => undoLastAction());
    await page.evaluate(() => {
      settings.templates = [{ id: 'scheduled-proof', enabled: true, autoLog: true, days: [3],
        startTime: '07:00', endTime: '08:00', activity: 'Scheduled work', energy: 'nine5' }];
      return autoLogDueTemplates({ notify: false });
    });
    await page.evaluate(() => { settings.templates[0].startTime = '06:00'; settings.templates[0].activity = 'Edited later'; });
    expect(await page.evaluate(() => LocalAccounting.keepServerVersion())).toBe(true);
    // Force the app's existing render/tick path into the exact still-aborted window.
    await page.evaluate(() => autoLogHeartbeatTick());
    await expect.poll(() => page.evaluate(() => LocalAccounting.journal.pending(roomCode)?.phase)).toBe('unknown');
    const captured = await page.evaluate(() => LocalAccounting.journal.pending(roomCode));
    expect(captured.attempts).toBe(1);
    await page.unroute(pattern);
    await page.evaluate(() => LocalAccounting.resumeEvents());
    expect((await remote(world, uid)).entries.find(e => e.templateId === 'scheduled-proof')).toBeUndefined();
    expect(await page.evaluate(() => LocalAccounting.journal.pending(roomCode))).toEqual(captured);
    const eventState = () => page.evaluate(() => Object.keys(localStorage)
      .filter(k => k.startsWith('ta3-accounting-event:' + roomCode + ':')).map(k => JSON.parse(localStorage.getItem(k))));
    const eventsBefore = await eventState();
    expect(eventsBefore).toHaveLength(1);
    expect(eventsBefore[0].templateEntries[0]).toMatchObject({ activity: 'Scheduled work',
      tsStart: Date.parse('2026-10-28T14:00:00Z'), ts: Date.parse('2026-10-28T15:00:00Z'), blockIntervalMin: 60 });
    await page.reload();
    await page.waitForFunction(room => getChronaSenseRoomCode() === room && !!_timeAckOnline?.online, 'uid_' + uid);
    await install(page); await page.evaluate(() => LocalAccounting.resumeEvents());
    expect(await page.evaluate(() => LocalAccounting.journal.pending(roomCode))).toEqual(captured);
    expect(await eventState()).toEqual(eventsBefore);
    expect((await remote(world, uid)).entries.find(e => e.templateId === 'scheduled-proof')).toBeUndefined();
    // Diagnostic delivery of the ORIGINAL retained bytes, not an adapter repair or rebased proposal.
    expect(await world.patch('rooms/uid_' + uid, captured.patch, token(uid))).toBe(true);
    await page.evaluate(() => LocalAccounting.resumeEvents());
    const actual = (await remote(world, uid)).entries.filter(e => e.templateId === 'scheduled-proof');
    expect(actual).toHaveLength(1);
    expect(actual[0]).toMatchObject({ activity: 'Scheduled work', blockIntervalMin: 60,
      tsStart: Date.parse('2026-10-28T14:00:00Z'), ts: Date.parse('2026-10-28T15:00:00Z'),
      _csWrite: { operationId: captured.id } });
    expect(await eventState()).toHaveLength(0);
    expect(await page.evaluate(() => LocalAccounting.journal.pending(roomCode))).toBeNull();
  });
}
`;
writeFileSync(new URL('controlled.spec.js', import.meta.url), helpers + controlled);
