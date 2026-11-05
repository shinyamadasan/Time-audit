// Packaged release artifacts against the exact candidate rules on a loopback-only RTDB emulator.
// Every runtime byte comes from scripts/build-release-artifacts.mjs: the web tree and the bundle
// re-extracted from the built APK. Nothing here defines or replaces the accounting transport,
// except the two labelled cases that deliberately break the shipped capability file.
// Test-only surfaces, by design: Firebase Auth is stubbed (no Google sign-in), the Firebase SDK is
// served from node_modules, and the clock is pinned. Neither bundle runs in a native WebView here.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulator, token, MALLORY } from '../rtdb-emulator-support.js';
import { acknowledgedUndo, holdEvaluates, retainedAccountingResult } from './accounting-retained-action.js';

holdEvaluates(test);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = process.env.CHRONASENSE_RELEASE_DIR ? path.resolve(root, process.env.CHRONASENSE_RELEASE_DIR) : null;
if (!releaseDir || !existsSync(path.join(releaseDir, 'release-manifest.json'))) {
  throw Error('Set CHRONASENSE_RELEASE_DIR to a directory built by scripts/build-release-artifacts.mjs');
}
const manifest = JSON.parse(readFileSync(path.join(releaseDir, 'release-manifest.json'), 'utf8'));
// A stale release directory must not qualify this source: every packaged file equals HEAD's blob.
for (const [file, hash] of Object.entries(manifest.web.hashes)) {
  const blob = execFileSync('git', ['-c', 'core.autocrlf=false', 'show', `HEAD:www/${file}`], { cwd: root, maxBuffer: 1 << 26 });
  if (createHash('sha256').update(blob).digest('hex') !== hash) throw Error(`${file} in the release directory is not HEAD's blob`);
}
const rules = readFileSync(path.join(releaseDir, 'firebase.rules.json'), 'utf8');
const productionRules = execFileSync('git', ['-c', 'core.autocrlf=false', 'show', 'f73edd4:firebase.rules.json'], { cwd: root, maxBuffer: 1 << 26 }).toString();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const walk = (dir, base = dir) => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
}).sort();
const tree = dir => sha256(walk(dir).map(file => `${sha256(readFileSync(path.join(dir, file)))}  ${file}\n`).join(''));

const MIN = 60000, T0 = Date.parse('2026-10-28T16:00:00Z');
const artifacts = [
  { name: 'web', dir: path.join(releaseDir, 'web'), expected: manifest.web.tree },
  { name: 'android', dir: path.join(releaseDir, 'android'), expected: manifest.android.bundleTree },
];

let emulator;
test.use({ serviceWorkers: 'block' });
test.beforeAll(async () => { emulator = await startEmulator(); });
test.afterAll(async () => { emulator?.stop(); });

for (const artifact of artifacts) {
  if (!artifact.expected) throw Error(`${artifact.name} artifact was not built; run the packaging script without --skip-android`);
  const bytes = new Map(walk(artifact.dir).map(file => [file, readFileSync(path.join(artifact.dir, file))]));
  let server, url;
  const proofEndpoint = value => {
    const parsed = new URL(value);
    return ['127.0.0.1', 'localhost'].includes(parsed.hostname) && [String(emulator?.port), url && new URL(url).port].includes(parsed.port);
  };

  test.describe(`${artifact.name} artifact`, () => {
    test.beforeAll(async () => {
      expect(tree(artifact.dir), `${artifact.name} tree must match the release manifest`).toBe(artifact.expected);
      server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const file = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
        if (!bytes.has(file)) { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream' });
        response.end(bytes.get(file));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${server.address().port}/`;
    });
    test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });
    test.beforeEach(async ({ context, page }) => {
      page.on('pageerror', error => console.error('[runtime-pageerror]', error.message));
      await context.route('**/*', route => proofEndpoint(route.request().url()) ? route.continue() : route.abort());
    });

    async function open(page, world, uid) {
      for (const name of ['app', 'database']) await page.route(`https://www.gstatic.com/firebasejs/10.12.2/firebase-${name}-compat.js`, route => route.fulfill({
        contentType: 'text/javascript', body: readFileSync(path.join(root, `node_modules/firebase/firebase-${name}-compat.js`), 'utf8') }));
      const config = { databaseURL: `${emulator.base}?ns=${world.name}`, projectId: 'demo-unknown-recovery' };
      await page.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js', route => route.fulfill({ contentType: 'text/javascript', body: `(()=>{
        const app=firebase.initializeApp(${JSON.stringify(config)});firebase.initializeApp=()=>app;
        app.database().useEmulator('127.0.0.1',${emulator.port},{mockUserToken:${JSON.stringify(token(uid))}});
        app.database().INTERNAL.forceWebSockets();
        if (localStorage.getItem('__proof-offline-sdk') === '1') app.database().goOffline();
        const user={uid:${JSON.stringify(uid)},displayName:'Local proof',email:'proof@example.invalid',getIdToken:()=>Promise.resolve(${JSON.stringify(token(uid))})};
        firebase.auth=()=>({currentUser:user,onAuthStateChanged:fn=>{setTimeout(()=>fn(user),0);return()=>{};},signOut:async()=>{}});
        firebase.auth.GoogleAuthProvider=class{};firebase.auth.GoogleAuthProvider.credential=()=>({});
      })();` }));
      await page.addInitScript(({ T0, uid }) => {
        if (location.protocol !== 'http:') return;
        const RealDate = Date, now = () => Number(localStorage.getItem('__proof-now')) || T0;
        window.__setNow = ts => localStorage.setItem('__proof-now', String(ts));
        window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } };
        sessionStorage.setItem('ta3-session-started', '1');
        if (!localStorage.getItem('__proof-seeded')) {
          localStorage.setItem('__proof-seeded', '1'); localStorage.setItem('__proof-now', String(T0));
          localStorage.setItem('ta3-onboarded', '1'); localStorage.setItem('ta3-device-id', 'release-device');
          localStorage.setItem(`ta3-settings:uid_${uid}`, JSON.stringify({ timezone: 'America/Phoenix', intervalMin: 30, sleepSetupDone: true, presets: [], templates: [] }));
          localStorage.setItem(`ta3-tz:uid_${uid}`, 'America/Phoenix');
        }
      }, { T0, uid });
      await page.goto(url);
      await page.waitForFunction(owner => globalThis.getChronaSenseRoomCode?.() === owner && _timeAckOnline?.online, `uid_${uid}`);
      await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4);
    }
    const remote = async (world, uid) => ({ timer: await world.read(`rooms/uid_${uid}/timer`), entries: Object.entries(await world.read(`rooms/uid_${uid}/entries`) || {}) });
    const live = async (world, uid) => (await remote(world, uid)).entries.map(([, entry]) => entry).filter(entry => !entry.deleted);
    // A room as main writes it today: an unstamped entry and an unrelated sibling the upgrade must keep.
    const seededRoom = uid => ({ entries: { e_71: { id: 71, activity: 'Legacy unstamped', energy: 'deep', date: '2026-10-28', ts: T0 - 20 * MIN, tsStart: T0 - 30 * MIN, updatedAt: T0 - 20 * MIN } },
      templatesSavedAt: T0 - 60 * MIN });
    const roomPattern = uid => `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}.json*`;
    const queued = page => page.evaluate(() => accountingCoordinator().snapshot().queue.map(op => ({ id: op.id, name: op.input.name, ordinary: op.input.ordinary?.kind || null, phase: op.phase, reason: op.reason })));
    async function settle(page) { await page.evaluate(async () => { await accountingCoordinator().drain(); clearInterval(ticker); ticker = null; }); }

    test('package carries the capability, no test seam and no extension writer', async () => {
      const closure = [...bytes.keys()];
      expect(closure).toContain('accounting-capability.js');
      expect(closure.filter(file => file.startsWith('browser-extension/'))).toEqual(['browser-extension/entry-physical-keys.js']);
      expect(closure.filter(file => /\.(test|spec)\.js$|^tests\/|^accounting-hazards\//.test(file))).toEqual([]);
      for (const [file, body] of bytes) {
        if (!/\.(js|html)$/.test(file)) continue;
        const text = body.toString('utf8');
        for (const seam of ['__chronasenseAccountingTransport', '__chronasenseTimeAckTransport', '__chronasenseExtensionAccountingCapability', '__testAccountingTransport', '__fbTest']) {
          expect(text.includes(seam), `${file} must not contain ${seam}`).toBe(false);
        }
      }
      const shipped = bytes.get('accounting-capability.js').toString('utf8');
      expect(shipped).toContain(sha256(rules));
      expect(sha256(rules)).toBe(manifest.rulesSha256);
    });

    for (const uid of ['alice', 'bob']) {
      test(`${uid}: signed-in session proves the installed gates with no injected transport`, async ({ page }) => {
        const world = await emulator.fresh(rules); await open(page, world, uid);
        expect(await page.evaluate(() => typeof globalThis.__chronasenseAccountingTransport)).toBe('undefined');
        await expect.poll(() => page.evaluate(() => accountingTransportState())).toBe('proven');
        expect(await world.read(`rooms/uid_${uid}/timeAckCancellations`)).toEqual({ 'capability-probe-v1': true });
        expect(await world.read(`rooms/uid_${uid}/focusRedemptions`)).toBeNull();
      });

      test(`${uid}: Start Save Undo Switch Break Away retro edit and delete commit through the real rules`, async ({ page }) => {
        const world = await emulator.fresh(rules); await open(page, world, uid);
        expect(await page.evaluate(() => _startTimer('Writing'))).toBe(true);
        await expect.poll(async () => (await remote(world, uid)).timer?.taskStartTime).toBe(T0);
        expect((await remote(world, uid)).timer._csWrite).toMatchObject({ protocol: 'staged-command-v1', revision: 1 });

        await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
        expect(await page.evaluate(() => { quickLogBusy = false; return _doQuickSave('Writing', 'deep'); })).toBe(true);
        await expect.poll(async () => (await live(world, uid)).length).toBe(1);
        expect((await live(world, uid))[0]).toMatchObject({ activity: 'Writing', tsStart: T0, ts: T0 + 10 * MIN });

        expect(await acknowledgedUndo(page)).toBe(true);
        await expect.poll(async () => (await live(world, uid)).length).toBe(0);
        expect((await remote(world, uid)).timer.taskStartTime).toBe(T0);

        await page.evaluate(ts => window.__setNow(ts), T0 + 20 * MIN);
        expect(await page.evaluate(() => switchToTask('Reviewing'))).toBeTruthy();
        await expect.poll(async () => (await remote(world, uid)).timer?.lastTask).toBe('Reviewing');
        expect((await live(world, uid)).map(entry => [entry.tsStart, entry.ts])).toEqual([[T0, T0 + 20 * MIN]]);

        await page.evaluate(ts => window.__setNow(ts), T0 + 30 * MIN);
        expect(await page.evaluate(() => startBreak(5))).toBe(true);
        await expect.poll(() => world.read(`rooms/uid_${uid}/breakState`)).toMatchObject({ active: true });
        await page.evaluate(ts => window.__setNow(ts), T0 + 35 * MIN);
        expect(await retainedAccountingResult(page, 'end-break')).toBe(true);
        await expect.poll(async () => (await world.read(`rooms/uid_${uid}/breakState`))?.active ?? false).toBe(false);

        await page.evaluate(ts => window.__setNow(ts), T0 + 40 * MIN);
        expect(await page.evaluate(() => startAway('Lunch'))).toBe(true);
        await expect.poll(() => world.read(`rooms/uid_${uid}/awayState`)).toMatchObject({ active: true });
        await page.evaluate(ts => window.__setNow(ts), T0 + 50 * MIN);
        expect(await page.evaluate(() => toggleAway())).toBe(true);
        await expect.poll(async () => (await world.read(`rooms/uid_${uid}/awayState`))?.active ?? false).toBe(false);

        const before = await live(world, uid);
        await page.evaluate(id => openEditEntry(id), before[0].id);
        await page.evaluate(() => { const input = document.getElementById('retro-activity'); input.focus(); input.value = 'Edited Writing'; return saveRetroEntry(); });
        await expect.poll(async () => (await live(world, uid)).some(entry => entry.activity === 'Edited Writing')).toBe(true);
        expect(await page.evaluate(id => deleteEntry(id), before[0].id)).toBe(true);
        await expect.poll(async () => (await live(world, uid)).some(entry => entry.activity === 'Edited Writing')).toBe(false);
        expect(await queued(page)).toEqual([]);
      });

      test(`${uid}: offline O1 Start and Stop survive reload and deliver exactly once with original facts`, async ({ page }) => {
        const world = await emulator.fresh(rules); await open(page, world, uid);
        await expect.poll(() => page.evaluate(() => accountingTransportState())).toBe('proven');
        await page.route(roomPattern(uid), route => route.abort('failed'));
        expect(await page.evaluate(() => _startTimer('Offline release'))).toBe(true);
        await page.evaluate(ts => { window.__setNow(ts); localStorage.setItem('__proof-offline-sdk', '1'); fbDb.goOffline(); }, T0 + 10 * MIN);
        await page.route(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}/**`, route => route.abort('failed'));
        await page.reload(); await page.waitForFunction(() => accountingIdentity());
        expect(await page.evaluate(() => accountingTransportState())).toBe('unverified');
        expect(await retainedAccountingResult(page, 'stop')).toBe(true);
        expect(await page.evaluate(() => ({ running, entries, lastUndoAction }))).toEqual({ running: false, entries: [], lastUndoAction: null });
        await expect(page.locator('#ordinary-provisional')).toContainText('Offline release');
        expect((await remote(world, uid)).entries).toEqual([]);

        await page.unroute(roomPattern(uid)); await page.unroute(`http://127.0.0.1:${emulator.port}/rooms/uid_${uid}/**`);
        await page.evaluate(() => { localStorage.removeItem('__proof-offline-sdk'); fbDb.goOnline(); });
        await page.evaluate(() => timeAckUserAction('check'));
        await expect.poll(async () => (await live(world, uid)).length).toBe(1);
        expect((await live(world, uid))[0]).toMatchObject({ activity: 'Offline release', tsStart: T0, ts: T0 + 10 * MIN, blockIntervalMin: 10 });
        await settle(page);
        expect((await live(world, uid)).length).toBe(1);
      });

      test(`${uid}: a response lost after commit settles from the post-image without a duplicate`, async ({ page }) => {
        const world = await emulator.fresh(rules); await open(page, world, uid);
        await expect.poll(() => page.evaluate(() => accountingTransportState())).toBe('proven');
        let dropped = 0;
        await page.route(roomPattern(uid), async route => {
          if (route.request().method() === 'PATCH' && !dropped++) { await route.fetch(); return route.abort('failed'); }
          return route.continue();
        });
        await page.evaluate(() => { window.__start = _startTimer('Lost reply'); });
        await expect.poll(async () => (await remote(world, uid)).timer?.taskStartTime).toBe(T0);
        await page.unroute(roomPattern(uid)); await settle(page);
        expect(await page.evaluate(() => accountingCoordinator().snapshot().history.find(op => op.input.ordinary)?.authority)).toBe('all-authoritative-post-images');
        expect((await remote(world, uid)).timer._csWrite.revision).toBe(1);
      });

      test(`${uid}: a request lost before delivery retries the identical sealed bytes`, async ({ page }) => {
        const world = await emulator.fresh(rules); await open(page, world, uid);
        await expect.poll(() => page.evaluate(() => accountingTransportState())).toBe('proven');
        const bodies = [];
        await page.route(roomPattern(uid), route => {
          if (route.request().method() !== 'PATCH') return route.continue();
          bodies.push(route.request().postData());
          return bodies.length === 1 ? route.abort('failed') : route.continue();
        });
        await page.evaluate(() => { window.__start = _startTimer('Exact retry'); });
        await expect.poll(() => bodies.length).toBe(1);
        await expect.poll(async () => (await queued(page))[0]?.phase).toBe('unknown');
        await settle(page);
        expect(bodies.length).toBe(2); expect(bodies[1]).toBe(bodies[0]);
        expect((await remote(world, uid)).timer).toMatchObject({ taskStartTime: T0 });
      });

      test(`${uid}: Keep server fences the original command and its late replay is refused by the rules`, async ({ page }) => {
        const world = await emulator.fresh(rules); await open(page, world, uid);
        await expect.poll(() => page.evaluate(() => accountingTransportState())).toBe('proven');
        let body = null;
        await page.route(roomPattern(uid), route => {
          if (route.request().method() !== 'PATCH') return route.continue();
          body = route.request().postData(); return route.abort('failed');
        });
        await page.evaluate(() => { window.__start = _startTimer('Fenced original'); });
        await expect.poll(async () => (await queued(page))[0]?.phase).toBe('unknown');
        const [{ id }] = await queued(page);
        await page.unroute(roomPattern(uid));
        await page.evaluate(() => timeAckUserAction('keep-server'));
        await expect.poll(() => world.read(`rooms/uid_${uid}/timeAckCancellations/${id}`)).toBe(true);
        const late = await fetch(`${emulator.base}/rooms/uid_${uid}.json?ns=${world.name}&auth=${token(uid)}`, { method: 'PATCH', body });
        expect(late.status).toBe(401);
        expect((await remote(world, uid)).timer).toBeNull();
      });

      test(`${uid}: wrong account and stale revision stay refused`, async ({ page }) => {
        const world = await emulator.fresh(rules); await open(page, world, uid);
        await expect.poll(() => page.evaluate(() => accountingTransportState())).toBe('proven');
        const room = `${emulator.base}/rooms/uid_${uid}`, auth = `?ns=${world.name}&auth=${MALLORY}`;
        expect((await fetch(`${room}.json${auth}`)).status).toBe(401);
        expect((await fetch(`${room}.json${auth}`, { method: 'PATCH', body: JSON.stringify({ timer: { lastTask: 'Intruder' } }) })).status).toBe(401);
        expect((await fetch(`${room}/timeAckCancellations/op_intruder1.json${auth}`, { method: 'PUT', body: 'true' })).status).toBe(401);

        expect(await page.evaluate(() => _startTimer('Original cursor'))).toBe(true);
        await expect.poll(async () => (await remote(world, uid)).timer?.taskStartTime).toBe(T0);
        const stale = (await remote(world, uid)).timer;
        const peer = { ...stale, lastTask: 'Peer', _csWrite: { ...stale._csWrite, operationId: 'op_peerwrite1', baseExists: true, baseRevision: stale._csWrite.revision, revision: stale._csWrite.revision + 1 } };
        expect(await world.write(`rooms/uid_${uid}/timer`, peer, token(uid))).toBe(true);
        expect(await world.write(`rooms/uid_${uid}/timer`, { ...stale, lastTask: 'Stale' }, token(uid))).toBe(false);
        expect((await remote(world, uid)).timer.lastTask).toBe('Peer');
      });

      test(`${uid}: contradictory physical aliases hold new work and keep both originals`, async ({ page }) => {
        const world = await emulator.fresh(rules);
        const record = { id: 77, energy: 'deep', ts: T0 - 20 * MIN, tsStart: T0 - 30 * MIN, updatedAt: T0 - 20 * MIN };
        await world.seed(`rooms/uid_${uid}/entries/77`, { ...record, activity: 'Numeric' });
        await world.seed(`rooms/uid_${uid}/entries/e_77`, { ...record, activity: 'Contradicts' });
        await open(page, world, uid);
        await expect.poll(() => page.evaluate(() => accountingTransportState())).toBe('proven');
        expect(await page.evaluate(() => _startTimer('Held by contradiction'))).toBe(true);
        await page.evaluate(() => accountingCoordinator().drain());
        expect((await queued(page)).some(op => op.ordinary === 'start')).toBe(true);
        const after = await remote(world, uid), entries = Object.fromEntries(after.entries);
        expect(after.timer).toBeNull();
        expect([entries['77'].activity, entries.e_77.activity]).toEqual(['Numeric', 'Contradicts']);
      });

      test(`${uid}: current production rules keep the package quiesced, then upgraded gates deliver retained facts once`, async ({ page }) => {
        const world = await emulator.fresh(productionRules);
        await world.seed(`rooms/uid_${uid}`, seededRoom(uid));
        const sent = [];
        page.on('request', request => { if (request.url().includes(`/rooms/uid_${uid}`) && request.method() !== 'GET') sent.push(`${request.method()} ${new URL(request.url()).pathname}`); });
        await open(page, world, uid);
        await expect.poll(() => page.evaluate(() => accountingTransportState())).toBe('incompatible');
        expect(await page.evaluate(() => _startTimer('Before gates'))).toBe(true);
        await page.evaluate(ts => window.__setNow(ts), T0 + 10 * MIN);
        expect(await retainedAccountingResult(page, 'stop')).toBe(true);
        expect(await page.evaluate(() => timeAckBlocks('Saving'))).toBe(true);
        await page.evaluate(() => accountingCoordinator().drain());
        await expect(page.locator('#time-ack-status')).toContainText('safeguards');
        await expect(page.locator('#ordinary-provisional')).toContainText('Before gates');
        expect((await queued(page)).filter(op => op.ordinary).map(op => op.ordinary)).toEqual(['start', 'stop']);
        expect(new Set(sent)).toEqual(new Set([`PUT /rooms/uid_${uid}/timeAckCancellations/capability-probe-v1.json`]));
        // Non-accounting device and settings sync continues; every accounting path stays exactly as seeded.
        const held = await world.read(`rooms/uid_${uid}`);
        expect(Object.fromEntries(['timer', 'entries', 'focusRedemptions', 'awayState', 'breakState', 'timeAckCancellations'].map(key => [key, held[key] ?? null])))
          .toEqual({ timer: null, entries: seededRoom(uid).entries, focusRedemptions: null, awayState: null, breakState: null, timeAckCancellations: null });
        await page.reload(); await page.waitForFunction(() => accountingIdentity());
        expect((await queued(page)).filter(op => op.ordinary).map(op => op.ordinary)).toEqual(['start', 'stop']);

        const installed = await fetch(`${emulator.base}/.settings/rules.json?ns=${world.name}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
        expect(installed.status).toBe(200);
        await page.evaluate(() => timeAckUserAction('check'));
        await expect.poll(async () => (await live(world, uid)).some(entry => entry.activity === 'Before gates')).toBe(true);
        expect((await live(world, uid)).find(entry => entry.activity === 'Before gates')).toMatchObject({ tsStart: T0, ts: T0 + 10 * MIN });
        expect(await world.read(`rooms/uid_${uid}/entries/e_71`)).toEqual(seededRoom(uid).entries.e_71);
        expect(await page.evaluate(() => accountingTransportState())).toBe('proven');
        expect(await page.evaluate(() => deleteEntry(71))).toBe(true);
        await expect.poll(() => world.read(`rooms/uid_${uid}/entries/e_71/deleted`)).toBe(true);
        expect((await world.read(`rooms/uid_${uid}/entries/e_71`))._csWrite).toMatchObject({ protocol: 'staged-command-v1', baseExists: true, baseRevision: 0, revision: 1 });
      });

      test(`${uid}: gates without the cancellation sink hold the package while old writers are refused, then the exact rules activate it`, async ({ page }) => {
        const stageA = JSON.parse(rules); delete stageA.rules.rooms.$roomId.timeAckCancellations;
        const world = await emulator.fresh(stageA); await open(page, world, uid);
        await expect.poll(() => page.evaluate(() => accountingTransportState())).toBe('incompatible');
        expect(await world.write(`rooms/uid_${uid}/timer`, { running: true, lastTask: 'Old writer' }, token(uid))).toBe(false);
        expect(await world.write(`rooms/uid_${uid}/entries/e_9`, { id: 9, activity: 'Old writer', energy: 'deep', ts: T0, tsStart: T0 - MIN }, token(uid))).toBe(false);
        expect(await page.evaluate(() => _startTimer('Waiting for stage B'))).toBe(true);
        await page.evaluate(() => accountingCoordinator().drain());
        expect((await remote(world, uid)).timer).toBeNull();
        const installed = await fetch(`${emulator.base}/.settings/rules.json?ns=${world.name}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
        expect(installed.status).toBe(200);
        await page.evaluate(() => timeAckUserAction('check'));
        await expect.poll(async () => (await remote(world, uid)).timer?.taskStartTime).toBe(T0);
      });

      for (const [weakness, mutate] of Object.entries({
        'erasable cancellation markers': room => { room.timeAckCancellations.$operationId['.write'] = "auth != null && $roomId === ('uid_' + auth.uid)"; },
        'parent grant over redemptions': room => { room.focusRedemptions = { '.write': "auth != null && $roomId === ('uid_' + auth.uid)" }; },
      })) {
        test(`${uid}: rules with ${weakness} never prove the capability`, async ({ page }) => {
          const weakened = JSON.parse(rules); mutate(weakened.rules.rooms.$roomId);
          const world = await emulator.fresh(weakened); await open(page, world, uid);
          await expect.poll(() => page.evaluate(() => accountingTransportState())).toBe('incompatible');
          expect(await page.evaluate(() => _startTimer('Held by weak rules'))).toBe(true);
          await page.evaluate(() => accountingCoordinator().drain());
          expect((await queued(page)).some(op => op.ordinary === 'start')).toBe(true);
          expect((await remote(world, uid)).timer).toBeNull();
        });
      }

      // The only two cases that alter the shipped capability file; they prove its absence is safe.
      for (const [fault, fulfil] of Object.entries({
        missing: route => route.fulfill({ status: 404, body: 'gone' }),
        mismatched: route => route.fulfill({ contentType: 'text/javascript',
          body: bytes.get('accounting-capability.js').toString('utf8').replace("protocol: 'staged-command-v1'", "protocol: 'staged-command-v2'") }),
      })) {
        test(`${uid}: ${fault} capability retains captured facts, sends nothing and recovers on the real file`, async ({ page }) => {
          await page.route('**/accounting-capability.js*', fulfil);
          const world = await emulator.fresh(rules); await open(page, world, uid);
          expect(await page.evaluate(() => accountingTransportState())).toBe(fault === 'missing' ? 'missing' : 'incompatible');
          expect(await page.evaluate(() => _startTimer('Held without capability'))).toBe(true);
          await page.evaluate(() => accountingCoordinator().drain());
          expect((await queued(page)).filter(op => op.ordinary).map(op => op.ordinary)).toEqual(['start']);
          expect((await queued(page))[0].reason).toBe('accounting-fence-unproven');
          expect(await remote(world, uid)).toEqual({ timer: null, entries: [] });
          expect(await world.read(`rooms/uid_${uid}/timeAckCancellations`)).toBeNull();
          await page.unroute('**/accounting-capability.js*');
          await page.reload(); await page.waitForFunction(() => accountingIdentity());
          await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4);
          await page.evaluate(() => timeAckUserAction('check'));
          await expect.poll(async () => (await remote(world, uid)).timer?.taskStartTime).toBe(T0);
        });
      }

      test(`${uid}: a credential or network failure stays unverified instead of incompatible`, async ({ page }) => {
        const world = await emulator.fresh(rules); await open(page, world, uid);
        let probes = 0;
        const pattern = `http://127.0.0.1:${emulator.port}/rooms/uid_${uid}**`;
        await page.route(pattern, route => { probes++; return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Permission denied"}' }); });
        await page.reload(); await page.waitForFunction(() => accountingIdentity());
        await page.waitForFunction(() => window._accountingSourcesSeen?.size === 4);
        await page.evaluate(() => hydrateAccounting());
        await expect.poll(() => probes).toBeGreaterThan(0);
        expect(await page.evaluate(() => accountingTransportState())).toBe('unverified');
        await page.unroute(pattern);
        await page.route(pattern, route => { probes++; return route.abort('failed'); });
        const before = probes;
        await page.evaluate(() => hydrateAccounting());
        await expect.poll(() => probes).toBeGreaterThan(before);
        expect(await page.evaluate(() => accountingTransportState())).toBe('unverified');
      });
    }
  });
}
