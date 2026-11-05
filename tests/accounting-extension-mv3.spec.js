// Actual unpacked MV3 worker + app SDK, isolated browser profile and loopback RTDB only.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { computeClosure } from '../scripts/runtime-mirror.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = fs.readFileSync(path.join(root, 'firebase.rules.json'), 'utf8');
const ruleHash = createHash('sha256').update(rules).digest('hex');
const T0 = Date.parse('2026-10-28T16:00:00Z'), END = T0 + 600000;
const sources = new Map(computeClosure({ rootDir: root }).files.map(name => [name, fs.readFileSync(path.join(root, name))]));
let emulator, appServer, appUrl;
test.setTimeout(60000);
test.beforeAll(async () => {
  emulator = await startEmulator();
  appServer = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!sources.has(name)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    response.end(sources.get(name));
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${appServer.address().port}/`;
});
test.afterAll(async () => { if (appServer) await new Promise(resolve => appServer.close(resolve)); emulator?.stop(); });
async function proofProxy(world) {
  const state = { offline: true, writes: [] };
  const server = http.createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      if (['PUT', 'PATCH'].includes(request.method)) {
        state.writes.push({ method: request.method, path: request.url.split('?')[0], bytes: body, etag: request.headers['if-match'] || null });
        if (state.offline) { response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"Injected local offline boundary"}'); return; }
      }
      const target = new URL(request.url, emulator.base); target.searchParams.set('ns', world.name);
      const result = await fetch(target, { method: request.method, headers: { 'content-type': 'application/json',
        ...(request.headers['if-match'] ? { 'If-Match': request.headers['if-match'] } : {}),
        ...(request.headers['x-firebase-etag'] ? { 'X-Firebase-ETag': request.headers['x-firebase-etag'] } : {}) },
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body }) });
      response.writeHead(result.status, { 'content-type': 'application/json', ...(result.headers.get('etag') ? { ETag: result.headers.get('etag') } : {}) });
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(500).end('{"error":"Local proof transport failure"}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { ...state, state, server, base: `http://127.0.0.1:${server.address().port}` };
}
function configure(directory, proxy, version, now) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'browser-extension/manifest.json'), 'utf8'));
  manifest.version = version; manifest.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const configuration = fs.readFileSync(path.join(root, 'browser-extension/firebase-config.js'), 'utf8')
    .replace(/databaseURL: "[^"]+"/, `databaseURL: ${JSON.stringify(proxy.base + '/')}`);
  const environment = `const proofFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, options) => { if (new URL(String(input)).origin !== ${JSON.stringify(proxy.base)}) throw Error('Non-proof request blocked before network'); return proofFetch(input, options); };
    Date.now = () => ${now};
    globalThis.__chronasenseExtensionAccountingCapability = ${JSON.stringify({ protocol: 'staged-command-v1', physicalIdentity: true, cancellation: true, rulesHash: ruleHash })};
`;
  fs.writeFileSync(path.join(directory, 'firebase-config.js'), environment + configuration);
}
async function launchProof(extension, profile, proxy) {
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], serviceWorkers: 'allow' });
  await context.route('**/*', route => {
    const target = new URL(route.request().url());
    return target.protocol === 'chrome-extension:' || [proxy.base, emulator.base, new URL(appUrl).origin].includes(target.origin) ? route.continue() : route.abort();
  });
  return context;
}
const workerFor = async context => context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const outbox = async (worker, uid) => worker.evaluate(async uid => JSON.parse((await chrome.storage.local.get([`ta3-extension-writes-v1:${uid}`]))[`ta3-extension-writes-v1:${uid}`] || 'null'), uid);
async function openApp(context, world, uid) {
  const page = await context.newPage();
  for (const name of ['app', 'database']) await page.route(`https://www.gstatic.com/firebasejs/10.12.2/firebase-${name}-compat.js`, route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, `node_modules/firebase/firebase-${name}-compat.js`)) }));
  const config = { databaseURL: `${emulator.base}?ns=${world.name}`, projectId: 'demo-unknown-recovery' };
  await page.route('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js', route => route.fulfill({ contentType: 'text/javascript', body: `(()=>{
    const app=firebase.initializeApp(${JSON.stringify(config)});firebase.initializeApp=()=>app;
    app.database().useEmulator('127.0.0.1',${emulator.port},{mockUserToken:${JSON.stringify(token(uid))}});app.database().INTERNAL.forceWebSockets();
    const user={uid:${JSON.stringify(uid)},displayName:'MV3 proof',email:'proof@example.invalid',getIdToken:()=>Promise.resolve(${JSON.stringify(token(uid))})};
    firebase.auth=()=>({currentUser:user,onAuthStateChanged:fn=>{setTimeout(()=>fn(user),0);return()=>{};},signOut:async()=>{}});firebase.auth.GoogleAuthProvider=class{};
  })();` }));
  await page.addInitScript(({ uid, now }) => {
    if (location.protocol !== 'http:') return;
    const RealDate = Date; window.__setNow = value => localStorage.setItem('__proof-now', value);
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [Number(localStorage.getItem('__proof-now')) || now])); } static now() { return Number(localStorage.getItem('__proof-now')) || now; } };
    sessionStorage.setItem('ta3-session-started', '1'); localStorage.setItem('ta3-onboarded', '1'); localStorage.setItem('ta3-device-id', 'app-proof-device');
    localStorage.setItem(`ta3-settings:uid_${uid}`, JSON.stringify({ timezone: 'America/Phoenix', intervalMin: 30, sleepSetupDone: true, presets: [], templates: [] }));
  }, { uid, now: END + 86400000 });
  await page.goto(appUrl); await page.waitForFunction(() => accountingIdentity() && window._accountingSourcesSeen?.size === 4);
  await page.evaluate(async () => {
    await accountingCoordinator().drain(); await requestAccountingRefresh();
  });
  return page;
}
for (const uid of ['alice', 'bob']) {
  test(`${uid}: historical MV3 upgrade retains unproven original queue without publishing or adopting ownership`, async ({}, info) => {
    const historicalCommit = '73739e9', world = await emulator.fresh(rules), proxy = await proofProxy(world);
    const directory = fs.mkdtempSync(path.join(root, 'test-results/task039-mv3-history-')), extension = path.join(directory, 'extension');
    fs.cpSync(path.join(root, 'browser-extension'), extension, { recursive: true });
    const historicalSources = {};
    for (const name of ['background.js', 'pending-writes.js', 'entry-physical-keys.js']) {
      const bytes = execFileSync('git', ['show', `${historicalCommit}:browser-extension/${name}`], { cwd: root });
      historicalSources[name] = createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(path.join(extension, name), bytes);
    }
    configure(extension, proxy, '1.0', END);
    const extensionKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const pinIdentity = directory => {
      const file = path.join(directory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      manifest.key = extensionKey; fs.writeFileSync(file, JSON.stringify(manifest));
    };
    pinIdentity(extension);
    const profile = path.join(directory, 'profile');
    let context = await launchProof(extension, profile, proxy);
    try {
      let worker = await workerFor(context);
      await worker.evaluate(async ({ uid, auth, start, end }) => chrome.storage.local.set({ uid, authToken: auth, lastHeartbeat: end,
        activeTab: { ownerUid: uid, domain: 'github.com', url: 'https://github.com/historical-proof', title: 'Historical browser use', startedAt: start, sessionId: start } }),
      { uid, auth: token(uid), start: T0, end: END });
      await context.close(); context = await launchProof(extension, profile, proxy); worker = await workerFor(context);
      await expect.poll(async () => (await outbox(worker, uid))?.queue[0]?.reason).toBe('physical-fence-unproven');
      const original = (await outbox(worker, uid)).queue[0];
      expect(original.entry).toMatchObject({ id: T0, tsStart: T0, ts: END, blockIntervalMin: 10 });
      expect(original.device).toBeUndefined(); expect(proxy.state.writes).toHaveLength(0);
      await context.close();
      const candidate = path.join(directory, 'candidate');
      fs.cpSync(path.join(root, 'browser-extension'), candidate, { recursive: true }); configure(candidate, proxy, '1.1', END + 86400000); pinIdentity(candidate);
      // Chromium retains the historical unpacked worker graph across a profile restart even
      // when getManifest reports the new version. New package URLs force candidate evaluation.
      fs.copyFileSync(path.join(candidate, 'entry-physical-keys.js'), path.join(candidate, 'entry-physical-keys-upgrade.js'));
      fs.writeFileSync(path.join(candidate, 'pending-writes-upgrade.js'), fs.readFileSync(path.join(candidate, 'pending-writes.js'), 'utf8').replace("'./entry-physical-keys.js'", "'./entry-physical-keys-upgrade.js'"));
      fs.writeFileSync(path.join(candidate, 'background-upgrade.js'), fs.readFileSync(path.join(candidate, 'background.js'), 'utf8').replace("'./pending-writes.js'", "'./pending-writes-upgrade.js'"));
      const candidateManifest = JSON.parse(fs.readFileSync(path.join(candidate, 'manifest.json'), 'utf8'));
      candidateManifest.background.service_worker = 'background-upgrade.js'; fs.writeFileSync(path.join(candidate, 'manifest.json'), JSON.stringify(candidateManifest));
      proxy.state.offline = false;
      const originalId = new URL(worker.url()).hostname;
      context = await launchProof(candidate, profile, proxy); worker = await workerFor(context);
      expect(new URL(worker.url()).hostname).toBe(originalId);
      expect(await worker.evaluate(() => chrome.runtime.getManifest().version)).toBe('1.1');
      await expect.poll(async () => (await outbox(worker, uid))?.queue[0]?.reason).toBe('captured-owner-device-unproven');
      const retained = (await outbox(worker, uid)).queue[0];
      expect(retained.id).toBe(original.id); expect(retained.entry).toEqual(original.entry); expect(retained.capture).toEqual(original.capture);
      expect(retained.command).toEqual(original.command);
      for (const field of ['owner', 'device', 'generation', 'v']) expect(Object.hasOwn(retained, field)).toBe(false);
      expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('!');
      expect(await worker.evaluate(() => chrome.action.getTitle({}))).toContain('captured-owner-device-unproven');
      expect(proxy.state.writes).toHaveLength(0); expect(await world.read(`rooms/uid_${uid}/entries`)).toBeNull();
      await info.attach('historical-upgrade-retention', { contentType: 'application/json', body: JSON.stringify({ uid, historicalCommit, historicalSources, ruleHash, original, retained,
        candidateSources: Object.fromEntries(['background-upgrade.js', 'pending-writes-upgrade.js', 'entry-physical-keys-upgrade.js'].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(candidate, name))).digest('hex')])) }) });
    } finally { await context.close(); await new Promise(resolve => proxy.server.close(resolve)); }
  });
  test(`${uid}: actual MV3 stop and upgrade retain original pending bytes then app Delete Undo preserves one physical identity`, async ({}, info) => {
    const world = await emulator.fresh(rules); await world.seed(`rooms/uid_${uid}/settings/timezone`, 'America/Phoenix');
    const proxy = await proofProxy(world);
    const directory = fs.mkdtempSync(path.join(root, 'test-results/task039-mv3-')), extension = path.join(directory, 'extension');
    fs.cpSync(path.join(root, 'browser-extension'), extension, { recursive: true }); configure(extension, proxy, '1.0', END);
    const profile = path.join(directory, 'profile');
    let context = await launchProof(extension, profile, proxy);
    try {
      let worker = await workerFor(context);
      await worker.evaluate(async ({ uid, auth, start, end }) => chrome.storage.local.set({ uid, authToken: auth, lastHeartbeat: end,
        activeTab: { ownerUid: uid, domain: 'github.com', url: 'https://github.com/local-proof', title: 'Synthetic browser use', startedAt: start, sessionId: start } }), { uid, auth: token(uid), start: T0, end: END });
      // Relaunch the same isolated profile: command-line unpacked extensions do not reliably
      // survive runtime.reload in headless Chromium. This is an actual browser/worker process stop.
      await context.close(); context = await launchProof(extension, profile, proxy); worker = await workerFor(context);
      await expect.poll(async () => (await outbox(worker, uid))?.queue[0]?.reason).toBe('server-status-503');
      const original = (await outbox(worker, uid)).queue[0];
      expect(original.entry).toMatchObject({ id: T0, tsStart: T0, ts: END, blockIntervalMin: 10 });
      expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('!');
      expect(await world.read(`rooms/uid_${uid}/entries`)).toBeNull();
      const browser = context.browser(), cdp = await browser.newBrowserCDPSession();
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      const browserProcess = processInfo.find(item => item.type === 'browser');
      expect(browserProcess).toBeDefined(); expect(browserProcess.id).toBeGreaterThan(0); expect(browserProcess.id).not.toBe(process.pid);
      expect(path.resolve(profile).startsWith(path.join(root, 'test-results') + path.sep)).toBe(true);
      await info.attach('owned-browser-process-kill', { contentType: 'application/json', body: JSON.stringify({ profile, pid: browserProcess.id, method: 'SIGKILL of browser PID from this isolated browser CDP session' }) });
      process.kill(browserProcess.id, 'SIGKILL');
      await expect.poll(() => browser.isConnected()).toBe(false);
      await context.close().catch(() => {});
      context = await launchProof(extension, profile, proxy); worker = await workerFor(context);
      await expect.poll(async () => (await outbox(worker, uid))?.queue[0]?.reason).toBe('server-status-503');
      expect((await outbox(worker, uid)).queue[0].command).toEqual(original.command);
      await context.close();
      configure(extension, proxy, '1.1', END + 86400000); proxy.state.offline = false;
      context = await launchProof(extension, profile, proxy); worker = await workerFor(context);
      await expect.poll(async () => (await outbox(worker, uid))?.queue.length).toBe(0);
      expect(await worker.evaluate(() => chrome.runtime.getManifest().version)).toBe('1.1');
      const accepted = (await outbox(worker, uid)).history.find(item => item.id === original.id);
      expect(accepted.entry).toEqual(original.entry); expect(accepted.command).toEqual(original.command);
      expect(proxy.state.writes.every(item => item.bytes === proxy.state.writes[0].bytes && item.etag === proxy.state.writes[0].etag)).toBe(true);
      const app = await openApp(context, world, uid);
      await expect.poll(() => app.evaluate(() => entries.filter(entry => !entry.deleted).length)).toBe(1);
      expect(await app.evaluate(id => { window.__proofOperation = deleteEntry(id); return window.__proofOperation; }, T0)).toBe(true);
      expect((await world.read(`rooms/uid_${uid}/entries/${T0}`)).deleted).toBe(true);
      await app.evaluate(now => window.__setNow(now), END + 86401000);
      expect(await app.evaluate(() => { window.__proofOperation = undoLastAction(); return window.__proofOperation; })).toBe(true);
      const raw = await world.read(`rooms/uid_${uid}/entries`); expect(Object.keys(raw)).toEqual([String(T0)]);
      expect(raw[T0]).toMatchObject({ id: T0, tsStart: T0, ts: END, blockIntervalMin: 10, browserUsage: true }); expect(raw[T0].deleted).not.toBe(true);
      await info.attach('mv3-source-and-outcome', { contentType: 'application/json', body: JSON.stringify({ directory, uid, ruleHash, original,
        accepted, extensionSources: Object.fromEntries(['background.js', 'pending-writes.js', 'entry-physical-keys.js'].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(extension, name))).digest('hex')])),
        appSources: Object.fromEntries([...sources].map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) }) });
    } finally { await context.close(); await new Promise(resolve => proxy.server.close(resolve)); }
  });
}
