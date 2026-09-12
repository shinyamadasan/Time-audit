// tests/partner-view.spec.js
//
// Partner View V1 — client-integration tests.
//
// partner-view-model.test.js proves the pure allowlist builder/validator in isolation.
// tests/wife-shared-accountability.spec.js proves the quick-glance summary card (unchanged
// by this milestone — run as a regression, not duplicated here). This file proves the CLIENT
// wiring: buildPartnerViewProjectionForPublish() classifies the SAME canonical Timeline/So-Far/
// priority truth the owner's own Today screen renders, publishSharedAccountability() writes it
// as a sibling of the summary payload in one .set(), the read-only Partner View screen renders
// it faithfully with zero mutation controls, and the lifecycle (unlink/logout/stale/dedupe)
// guarantees hold.
//
// Same two-page real-pairing-handshake harness as tests/wife-shared-accountability.spec.js,
// against a shared in-memory Firebase mock held in Node.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const ROOT_DIR = path.resolve('.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
let server;
let APP_URL;

test.beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
      const abs = path.join(ROOT_DIR, rel);
      if (!abs.startsWith(ROOT_DIR)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(abs);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  APP_URL = `http://127.0.0.1:${port}/index.html`;
});

test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

// Same as wife-shared-accountability.spec.js's BOOT_STUB, plus `window.__authCb` capture so
// tests can simulate a REAL second onAuthStateChanged(null) transition (a genuine logout),
// not a hand-rolled approximation of storage.js's teardown code.
const BOOT_STUB = `
(() => {
  if (window.firebase) return;
  const noopRef = () => ({
    child: noopRef, on: () => {}, off: () => {}, once: () => Promise.resolve({ val: () => null }),
    set: () => Promise.resolve(), update: () => Promise.resolve(), remove: () => Promise.resolve(),
    push: () => ({ set: () => Promise.resolve() }),
    onDisconnect: () => ({ set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() })
  });
  const auth = () => ({ onAuthStateChanged(cb) { window.__authCb = cb; setTimeout(() => cb(null), 0); return () => {}; },
    signInWithPopup: () => Promise.resolve(), signInWithCredential: () => Promise.resolve(), signOut: () => Promise.resolve() });
  auth.GoogleAuthProvider = function () {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(c){ const a={config:c}; this.apps.push(a); return a; },
    app(){ return this.apps[0] || this.initializeApp({}); }, database(){ return { ref: noopRef }; }, auth };
})();`;

const PROXY_DB = `
(() => {
  const listeners = new Map();
  const mkSnap = (v) => ({
    val: () => (v === undefined ? null : v),
    exists: () => v !== null && v !== undefined,
    child: (k) => mkSnap(v && typeof v === 'object' ? v[k] : undefined)
  });
  window.__fanout = async (changed) => {
    for (const [lp, cbs] of listeners) {
      if (lp === changed || changed.startsWith(lp + '/') || lp.startsWith(changed + '/')) {
        const v = await window.__dbOnce(lp);
        [...cbs].forEach((cb) => cb(mkSnap(v)));
      }
    }
  };
  const ref = (p) => ({
    path: p,
    child(c) { return ref(p + '/' + c); },
    once() { return window.__dbOnce(p).then(mkSnap); },
    on(ev, cb) {
      if (ev === 'value') {
        if (!listeners.has(p)) listeners.set(p, new Set());
        listeners.get(p).add(cb);
        window.__dbOnce(p).then((v) => cb(mkSnap(v)));
      }
      return cb;
    },
    off(cb) { if (listeners.has(p)) { if (cb) listeners.get(p).delete(cb); else listeners.delete(p); } },
    set(v) { return window.__dbSet(p, v === undefined ? null : v, window.__uid); },
    update(obj) { return Promise.all(Object.entries(obj).map(([k, v]) => window.__dbSet(p + '/' + k, v, window.__uid))); },
    remove() { return window.__dbSet(p, null, window.__uid); },
    push(v) { const k = 'k' + Math.random().toString(36).slice(2); const r = ref(p + '/' + k); r.key = k; if (v !== undefined) r.set(v); return r; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  window.__installProxyDb = () => { fbDb = { ref }; };
})();`;

function makeSharedDb() {
  let db = {};
  const writes = [];
  const parts = (p) => p.split('/').filter(Boolean);
  const getAt = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), db);
  const setAt = (p, v) => {
    const ks = parts(p); let o = db;
    for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; }
    if (v === null || v === undefined) delete o[ks[ks.length - 1]];
    else o[ks[ks.length - 1]] = v;
  };
  const pages = [];
  const deliver = async (changed) => {
    for (const pg of pages) await pg.evaluate((c) => window.__fanout(c), changed).catch(() => {});
  };
  async function attach(page) {
    await page.exposeFunction('__dbOnce', async (p) => { const v = getAt(p); return v === undefined ? null : v; });
    await page.exposeFunction('__dbSet', async (p, v, by) => {
      setAt(p, v);
      writes.push({ path: p, value: v === undefined ? null : JSON.parse(JSON.stringify(v)), by: by || null, ts: Date.now() });
      await deliver(p);
    });
    pages.push(page);
    await page.evaluate(PROXY_DB);
    await page.evaluate(() => window.__installProxyDb());
  }
  return {
    attach,
    writes,
    snapshot: () => JSON.parse(JSON.stringify(db)),
    get: (p) => getAt(p),
    sharedWrites: (uid) => writes.filter((w) => w.path === `uid_${uid}/shared`),
  };
}

async function boot(page, uid) {
  await page.route('https://www.gstatic.com/firebasejs/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: BOOT_STUB }));
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
  });
  await page.goto(APP_URL);
  await page.waitForFunction(() => typeof window.watchPairCode === 'function' && typeof window.connectPartner === 'function');
  await page.waitForFunction(() => !!globalThis.SharedAccountabilityModel && !!globalThis.PartnerViewModel);
  await page.evaluate((u) => {
    window.__uid = u;
    window.confirm = () => true;
    currentUser = { uid: u, displayName: u.toUpperCase(), email: u + '@example.test' };
    const ov = document.getElementById('signin-overlay'); if (ov) ov.style.display = 'none';
  }, uid);
}

const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 30)));

async function linkAliceAndBob(shared, alice, bob) {
  const code = await alice.evaluate(() => { generateMyPairCode(); return document.getElementById('my-pair-code').textContent; });
  await settle(alice);
  await bob.evaluate((c) => { document.getElementById('partner-code-input').value = c; connectPartner(); }, code);
  await alice.waitForFunction(() => typeof _pendingPairClaim !== 'undefined' && _pendingPairClaim === 'bob');
  await alice.evaluate(() => acceptPairClaim());
  await bob.waitForFunction(() => localStorage.getItem('ta3-partner-uid') === 'alice');
  await settle(alice); await settle(bob); await settle(alice); await settle(bob);
}

/** Sets Alice's timezone/plan/entries/templates then publishes via the real
 *  publishSharedAccountability() -> buildPartnerViewProjectionForPublish() path. */
async function setAliceStateAndPublish(alice, { timezone, todayKey, items = [], entries: entryList = [], templates = null, tomorrowKey = null, tomorrowItems = null }) {
  return alice.evaluate(({ timezone, todayKey, items, entryList, templates, tomorrowKey, tomorrowItems }) => {
    settings.timezone = timezone;
    if (templates) settings.templates = templates;
    entries.push(...entryList);
    writeDatePlanLocal(todayKey, { items, updatedAt: Date.now(), updatedBy: 'device-a' });
    if (tomorrowKey) writeDatePlanLocal(tomorrowKey, { items: tomorrowItems || [], updatedAt: Date.now(), updatedBy: 'device-a' });
    publishSharedAccountability();
  }, { timezone, todayKey, items, entryList, templates, tomorrowKey, tomorrowItems });
}

async function openBobPartnerView(bob) {
  await bob.evaluate(() => openPartnerView());
  await bob.waitForFunction(() => document.getElementById('partner-view-screen').hidden === false);
}

async function setupLinkedPair(browser) {
  const shared = makeSharedDb();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const alice = await ctxA.newPage();
  const bob = await ctxB.newPage();
  await boot(alice, 'alice');
  await boot(bob, 'bob');
  await shared.attach(alice);
  await shared.attach(bob);
  await linkAliceAndBob(shared, alice, bob);
  return { shared, ctxA, ctxB, alice, bob };
}

test.describe('Partner View V1', () => {
  test('linked partner opens a read-only "Viewing X" screen with priorities, So Far, and tomorrow — mirroring canonical status exactly', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    const tomorrowKey = await alice.evaluate(() => globalThis.PlanTomorrowModel.planTomorrowTargetDate(Date.now(), 'Asia/Manila'));
    const now = await alice.evaluate(() => Date.now());

    await setAliceStateAndPublish(alice, {
      timezone: 'Asia/Manila', todayKey,
      items: [
        { id: 'p1', task: 'Finish app', done: false, when: '', updatedAt: now },
        { id: 'p2', task: 'Workout', done: true, doneAt: now, when: '18:00', updatedAt: now }
      ],
      entries: [{ id: 'e1', ts: now, tsStart: now - 30 * 60000, activity: 'Finish app', energy: 'deep', planItemId: 'p1', blockIntervalMin: 30 }],
      tomorrowKey,
      tomorrowItems: [{ id: 't1', task: 'Client build', done: false, when: '21:00', updatedAt: now }]
    });
    // A genuinely active/running task — the canonical "In progress" state
    // (getPlanItemStatus/isPlanTaskActive), not merely "has tracked minutes".
    await alice.evaluate(() => { running = true; currentTaskPlanItemId = 'p1'; publishSharedAccountability(); });
    await settle(alice); await settle(bob);

    // Canonical So Far, computed the SAME way the owner's own Today screen would — the
    // test asserts Partner View reports the identical number, never an independent calc.
    const expectedHealth = await alice.evaluate(({ todayKey }) => computeTodayHealth(entries, todayKey), { todayKey });

    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);

    expect(screenText).toContain('Viewing ALICE');
    expect(screenText).toContain('Read only');
    expect(screenText).toContain('Finish app');
    expect(screenText).toContain('In progress'); // linked actual, not done
    expect(screenText).toContain('Workout');
    expect(screenText).toMatch(new RegExp(String(expectedHealth.deepMin))); // So Far parity, no alt calc
    expect(screenText).toContain('Client build'); // tomorrow detail
    expect(screenText).toContain('21:00');

    await ctxA.close(); await ctxB.close();
  });

  test('no plan today shows the neutral empty state, but real Timeline evidence still renders', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    const now = await alice.evaluate(() => Date.now());

    await setAliceStateAndPublish(alice, {
      timezone: 'Asia/Manila', todayKey, items: [],
      entries: [{ id: 'e1', ts: now, tsStart: now - 20 * 60000, activity: 'Errand', energy: 'errands', blockIntervalMin: 20 }]
    });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);

    expect(screenText).toContain('No priorities planned today');
    expect(screenText).toContain('Errand'); // Timeline evidence is independent of whether a plan exists

    await ctxA.close(); await ctxB.close();
  });

  test('Timeline distinguishes actual / OBSERVED / gap / template hint exactly like the owner\'s own Today screen', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    const now = await alice.evaluate(() => Date.now());

    // Small offsets from the real "now" (not fixed clock times) — small enough that they
    // cannot cross a calendar-day boundary regardless of what wall-clock time the suite
    // happens to run at (a fixed early-morning anchor time can itself be "in the future"
    // relative to `now` when the real Manila clock is between midnight and that hour).
    const dow = await alice.evaluate(({ todayKey }) => tzDow(tzParseTime(todayKey, '12:00')), { todayKey });
    await setAliceStateAndPublish(alice, {
      timezone: 'Asia/Manila', todayKey, items: [],
      entries: [
        // Confirmed actual block, ends 30m ago.
        { id: 'e1', ts: now - 30 * 60000, tsStart: now - 40 * 60000, activity: 'Scribe shift', energy: 'nine5', blockIntervalMin: 10 },
        // 15-minute gap between e1 and e2 (>= MIN_GAP_MIN), then OBSERVED browser evidence.
        { id: 'e2', ts: now - 10 * 60000, tsStart: now - 15 * 60000, activity: 'Facebook', energy: 'waste', browserUsage: true, source: 'browser-extension', blockIntervalMin: 5 }
      ],
      templates: [{ id: 'tpl1', activity: 'Hygiene', energy: 'recovery', days: [dow], startTime: '12:00', endTime: '12:20', enabled: true, autoLog: false }]
    });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);
    const screenHtml = await bob.evaluate(() => document.getElementById('partner-view-screen').innerHTML);

    expect(screenText).toContain('Scribe shift');
    expect(screenHtml).not.toMatch(/Scribe shift[^<]*<span class="pv-evidence-tag"/); // confirmed actual carries no evidence tag
    expect(screenText).toContain('Facebook');
    expect(screenHtml).toMatch(/Facebook[^<]*<span class="pv-evidence-tag">OBSERVED/);
    expect(screenText).toContain('No confirmed activity'); // gap != waste, never mislabeled
    expect(screenText).toContain('Hygiene');
    expect(screenText).toContain('template hint'); // schedule assumption, never shown as actual

    await ctxA.close(); await ctxB.close();
  });

  test('a scheduled auto-log block appears as ordinary actual evidence, exactly as the owner sees it', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    const now = await alice.evaluate(() => Date.now());

    await setAliceStateAndPublish(alice, {
      timezone: 'Asia/Manila', todayKey, items: [],
      entries: [{
        id: 'tpllog_scribe_' + todayKey, ts: now - 60 * 60000, tsStart: now - 120 * 60000,
        activity: 'Scribe shift', energy: 'nine5', blockIntervalMin: 60,
        onPlan: true, retro: false, autoLogged: true, scheduledAutoLog: true, templateId: 'tpl1'
      }]
    });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenHtml = await bob.evaluate(() => document.getElementById('partner-view-screen').innerHTML);

    expect(screenHtml).toContain('Scribe shift');
    // No TIMER/OBSERVED tag and no "template hint" wording — a scheduled auto-log entry
    // is confirmed actual evidence, indistinguishable from any other logged block.
    expect(screenHtml).not.toMatch(/Scribe shift[^<]*<span class="pv-evidence-tag"/);
    expect(screenHtml).not.toContain('template hint');

    await ctxA.close(); await ctxB.close();
  });

  test('publisher timezone controls Partner View\'s day — the viewer\'s own device timezone has no influence', async ({ browser }) => {
    const shared = makeSharedDb();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext({ timezoneId: 'America/Phoenix' });
    const alice = await ctxA.newPage();
    const bob = await ctxB.newPage();
    await boot(alice, 'alice');
    await boot(bob, 'bob');
    await shared.attach(alice);
    await shared.attach(bob);
    await linkAliceAndBob(shared, alice, bob);

    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    const now = await alice.evaluate(() => Date.now());
    await setAliceStateAndPublish(alice, {
      timezone: 'Asia/Manila', todayKey,
      items: [{ id: 'p1', task: 'Manila-anchored task', done: false, when: '', updatedAt: now }]
    });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);

    expect(screenText).toContain('Manila-anchored task'); // shown as current despite Phoenix viewer device

    await ctxA.close(); await ctxB.close();
  });

  test('a stale prior-day payload shows a calm "no current update" state, never a past day rendered as today', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);

    await alice.evaluate(() => {
      const M = globalThis.SharedAccountabilityModel;
      const PV = globalThis.PartnerViewModel;
      const stale = M.buildSharedPayload({
        displayName: 'ALICE', timezone: 'Asia/Manila', dateKey: '2020-01-01', updatedAt: Date.parse('2020-01-01T10:00:00Z'),
        todayItems: [], tomorrowDateKey: '2020-01-02', tomorrowPrepStatus: 'not-prepared'
      });
      stale.partnerView = PV.buildPartnerViewProjection({
        dateKey: '2020-01-01', priorities: [{ title: 'Old stale priority', done: false }],
        soFar: { deepMin: 999, wasteMin: 0 }, timelineItems: [], tomorrowDateKey: '2020-01-02', tomorrowPriorities: []
      });
      fbDb.ref('uid_alice/shared').set(stale);
    });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);

    expect(screenText).not.toContain('Old stale priority');
    expect(screenText).toContain('No current update');

    await ctxA.close(); await ctxB.close();
  });

  test('Partner View renders zero mutation controls — no start/stop/log/done/edit/delete affordances anywhere', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    const now = await alice.evaluate(() => Date.now());
    const dow = await alice.evaluate(({ todayKey }) => tzDow(tzParseTime(todayKey, '12:00')), { todayKey });

    await setAliceStateAndPublish(alice, {
      timezone: 'Asia/Manila', todayKey,
      items: [{ id: 'p1', task: 'A priority', done: false, when: '', updatedAt: now }],
      entries: [{ id: 'e1', ts: now, tsStart: now - 30 * 60000, activity: 'Deep work', energy: 'deep', blockIntervalMin: 30 }],
      templates: [{ id: 'tpl1', activity: 'Hygiene', energy: 'recovery', days: [dow], startTime: '12:00', endTime: '12:20', enabled: true, autoLog: false }]
    });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenHtml = await bob.evaluate(() => document.getElementById('partner-view-screen').innerHTML);

    // No onclick handler anywhere in Partner View calls a mutation function — read-only is
    // enforced by never emitting the control, not by disabling it with CSS/attributes.
    const mutationFns = /onclick="[^"]*(startTimer|stopAndLog|switchToTask|startBreak|startAway|togglePlanDone|removePlanItem|addPlanItem|openEditEntry|deleteEntry|openRetroLogPrefilled|openTemplateLog|skipTemplateOnDate|prepareTomorrow|confirmPreparedDatePlan)/i;
    expect(screenHtml).not.toMatch(mutationFns);
    expect(screenHtml).not.toContain('<input');
    expect(screenHtml).not.toContain('<textarea');
    // The only interactive control in the whole screen is the back button.
    const buttonCount = await bob.evaluate(() => document.getElementById('partner-view-screen').querySelectorAll('button').length);
    expect(buttonCount).toBe(1);

    await ctxA.close(); await ctxB.close();
  });

  test('a hostile/malformed partnerView node is validated away — no crash, no leaked technical fields', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const bobErrors = [];
    bob.on('pageerror', (err) => bobErrors.push(err.message));

    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    await alice.evaluate(({ todayKey }) => {
      const M = globalThis.SharedAccountabilityModel;
      const base = M.buildSharedPayload({
        displayName: 'ALICE', timezone: 'Asia/Manila', dateKey: todayKey, updatedAt: Date.now(),
        todayItems: [], tomorrowDateKey: todayKey, tomorrowPrepStatus: 'not-prepared'
      });
      base.partnerView = {
        today: {
          dateKey: todayKey,
          priorities: [{ title: 'X', done: true, walletBalance: 42, secretId: 'p1' }],
          soFar: { deepMin: 5, wasteMin: 1, streak: 99 },
          timeline: [{ kind: 'actual', activity: 'Y', energy: 'deep', tsStart: 1, tsEnd: 2, url: 'https://evil.example' }]
        },
        tomorrow: { dateKey: todayKey, priorities: [] },
        score: 100, review: 'leak'
      };
      fbDb.ref('uid_alice/shared').set(base);
    }, { todayKey });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenHtml = await bob.evaluate(() => document.getElementById('partner-view-screen').innerHTML);

    expect(bobErrors).toEqual([]);
    for (const bad of ['walletBalance', 'secretId', 'streak', 'evil.example', 'score', 'leak']) {
      expect(screenHtml).not.toContain(bad);
    }
    expect(screenHtml).toContain('X'); // the allowlisted title still renders

    await ctxA.close(); await ctxB.close();
  });

  test('unlink immediately closes Partner View and clears its underlying data', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    const now = await alice.evaluate(() => Date.now());
    await setAliceStateAndPublish(alice, {
      timezone: 'Asia/Manila', todayKey,
      items: [{ id: 'p1', task: 'Visible priority', done: false, when: '', updatedAt: now }]
    });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    await bob.waitForFunction(() => document.getElementById('partner-view-screen').textContent.includes('Visible priority'));

    await alice.evaluate(() => removePair());
    await bob.waitForFunction(() => document.getElementById('partner-view-screen').hidden === true);
    expect(await bob.evaluate(() => typeof partnerViewShared === 'undefined' ? null : partnerViewShared)).toBeNull();
    expect(await bob.evaluate(() => isPartnerViewOpen())).toBe(false);

    await ctxA.close(); await ctxB.close();
  });

  test('sign-out clears Partner View and cannot leave it visible for a future session', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    const now = await alice.evaluate(() => Date.now());
    await setAliceStateAndPublish(alice, {
      timezone: 'Asia/Manila', todayKey,
      items: [{ id: 'p1', task: 'Session priority', done: false, when: '', updatedAt: now }]
    });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    await bob.waitForFunction(() => document.getElementById('partner-view-screen').textContent.includes('Session priority'));

    // A REAL second onAuthStateChanged(null) transition — the actual sign-out path, not a
    // hand-rolled approximation of it.
    await bob.evaluate(() => window.__authCb(null));
    await bob.waitForFunction(() => document.getElementById('partner-view-screen').hidden === true);
    expect(await bob.evaluate(() => typeof partnerViewShared === 'undefined' ? null : partnerViewShared)).toBeNull();

    await ctxA.close(); await ctxB.close();
  });

  test('write dedupe: unchanged republishes and high-frequency timer-tick-style calls never produce repeated writes; a real Timeline-relevant change publishes exactly once', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    const now = await alice.evaluate(() => Date.now());
    await setAliceStateAndPublish(alice, {
      timezone: 'Asia/Manila', todayKey,
      items: [{ id: 'p1', task: 'Steady task', done: false, when: '', updatedAt: now }]
    });
    await settle(alice);
    const afterFirst = shared.sharedWrites('alice').length;
    expect(afterFirst).toBeGreaterThan(0);

    // 60 timer-tick-style republishes with no semantic change at all.
    await alice.evaluate(() => { for (let i = 0; i < 60; i++) publishSharedAccountability(); });
    await settle(alice);
    expect(shared.sharedWrites('alice').length).toBe(afterFirst); // zero additional writes

    // A real new Timeline-relevant entry — a genuine content change.
    await alice.evaluate(({ now }) => {
      entries.push({ id: 'eNew', ts: now, tsStart: now - 15 * 60000, activity: 'New deep block', energy: 'deep', blockIntervalMin: 15 });
      publishSharedAccountability();
    }, { now });
    await settle(alice); await settle(bob);
    expect(shared.sharedWrites('alice').length).toBe(afterFirst + 1); // exactly one bounded update

    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);
    expect(screenText).toContain('New deep block');

    await ctxA.close(); await ctxB.close();
  });

  test('caps the published Timeline at a bounded size without distorting an ordinary day', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    const now = await alice.evaluate(() => Date.now());
    // A pathological number of tiny back-to-back entries, spaced 10s apart (200 * 10s ≈
    // 33 minutes total span) so the whole block safely stays within today regardless of
    // what wall-clock time the suite happens to run at.
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: 'p' + i, ts: now - i * 10000, tsStart: now - (i + 1) * 10000,
      activity: 'Task ' + i, energy: 'shallow', blockIntervalMin: 1
    }));
    await setAliceStateAndPublish(alice, { timezone: 'Asia/Manila', todayKey, items: [], entries: many });
    await settle(alice);
    // Prove the cap is actually the limiting factor, not a coincidence of fewer surviving
    // same-day entries — the raw window-filtered count on the publisher side exceeds it.
    const rawTodayCount = await alice.evaluate(({ todayKey }) => getEntriesForDateWindow(todayKey).length, { todayKey });
    expect(rawTodayCount).toBeGreaterThan(150);
    const payload = shared.get('uid_alice/shared');
    expect(payload.partnerView.today.timeline.length).toBeLessThanOrEqual(150);

    await ctxA.close(); await ctxB.close();
  });
});
