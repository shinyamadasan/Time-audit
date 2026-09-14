// tests/partner-view-mobile-planning-nudge.spec.js
//
// Partner View Mobile Navigation + Planning Nudge V1.
//
// Two independent legs, proven separately per the build brief:
//   Leg A — mobile-safe navigation: the "Back to my day" escape action stays reachable
//   at mobile widths and is never covered by simulated status/safe-area chrome.
//   Leg B — contextual planning reminder: "Remind to plan tomorrow" appears ONLY when the
//   authoritative `shared.tomorrow.prepStatus` (SharedAccountabilityModel) proves the viewed
//   partner has genuinely not prepared tomorrow — never inferred from priority item count,
//   never shown for an explicit Open Day, never shown for stale/missing data.
//
// Reuses the exact boot/pairing/publish harness from tests/partner-view.spec.js (same
// in-memory Firebase mock, same two-page real-pairing handshake) rather than inventing a
// second one.

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

// Extends tests/partner-view.spec.js's PROXY_DB with 'child_added' support (needed for the
// real /nudges listener, storage.js's initPartnerSharedListener), routed through the SAME
// cross-page __dbSet -> deliver(p) -> window.__fanout(p) mechanism as 'value' listeners —
// each page's own local `childListeners` map only fires from a fanout call driven by the
// shared Node-side write log, never from a same-page-only shortcut, so a write from Bob's
// page correctly reaches Alice's page's listener.
const PROXY_DB = `
(() => {
  const listeners = new Map();
  const childListeners = new Map();
  const seenChildren = new Map();
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
    const lastSlash = changed.lastIndexOf('/');
    if (lastSlash > 0) {
      const parent = changed.slice(0, lastSlash);
      const childKey = changed.slice(lastSlash + 1);
      const cbs = childListeners.get(parent);
      if (cbs) {
        let seen = seenChildren.get(parent);
        if (!seen) { seen = new Set(); seenChildren.set(parent, seen); }
        if (!seen.has(childKey)) {
          seen.add(childKey);
          const v = await window.__dbOnce(changed);
          if (v !== null && v !== undefined) [...cbs].forEach((cb) => cb(mkSnap(v)));
        }
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
      } else if (ev === 'child_added') {
        if (!childListeners.has(p)) childListeners.set(p, new Set());
        childListeners.get(p).add(cb);
      }
      return cb;
    },
    off(cb) {
      if (listeners.has(p)) { if (cb) listeners.get(p).delete(cb); else listeners.delete(p); }
      if (childListeners.has(p)) { if (cb) childListeners.get(p).delete(cb); else childListeners.delete(p); }
    },
    set(v) { return window.__dbSet(p, v === undefined ? null : v, window.__uid); },
    update(obj) { return Promise.all(Object.entries(obj).map(([k, v]) => window.__dbSet(p + '/' + k, v, window.__uid))); },
    remove() { return window.__dbSet(p, null, window.__uid); },
    push(v) {
      const k = 'k' + Math.random().toString(36).slice(2);
      const r = ref(p + '/' + k);
      r.key = k;
      if (v !== undefined) r.set(v);
      return r;
    },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  window.__installProxyDb = () => { fbDb = { ref }; };
})();`;

function rtdbCompact(v) {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    if (v.length === 0) return undefined;
    return v.map(rtdbCompact);
  }
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const c = rtdbCompact(val);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return v;
}

function makeSharedDb() {
  let db = {};
  const writes = [];
  const parts = (p) => p.split('/').filter(Boolean);
  const getAt = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), db);
  const setAt = (p, v) => {
    const ks = parts(p); let o = db;
    for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; }
    const compacted = rtdbCompact(v);
    if (compacted === undefined) delete o[ks[ks.length - 1]];
    else o[ks[ks.length - 1]] = compacted;
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
    nudgeWrites: (uid) => writes.filter((w) => w.path.startsWith(`uid_${uid}/nudges/`)),
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

async function linkAliceAndBob(alice, bob) {
  const code = await alice.evaluate(() => { generateMyPairCode(); return document.getElementById('my-pair-code').textContent; });
  await settle(alice);
  await bob.evaluate((c) => { document.getElementById('partner-code-input').value = c; connectPartner(); }, code);
  await alice.waitForFunction(() => typeof _pendingPairClaim !== 'undefined' && _pendingPairClaim === 'bob');
  await alice.evaluate(() => acceptPairClaim());
  await bob.waitForFunction(() => localStorage.getItem('ta3-partner-uid') === 'alice');
  await settle(alice); await settle(bob); await settle(alice); await settle(bob);
}

async function setupLinkedPair(browser, { bobViewport } = {}) {
  const shared = makeSharedDb();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext(bobViewport ? { viewport: bobViewport } : {});
  const alice = await ctxA.newPage();
  const bob = await ctxB.newPage();
  await boot(alice, 'alice');
  await boot(bob, 'bob');
  await shared.attach(alice);
  await shared.attach(bob);
  await linkAliceAndBob(alice, bob);
  return { shared, ctxA, ctxB, alice, bob };
}

/** Sets Alice's tomorrow preparation directly through the canonical model (same pattern as
 *  tests/wife-shared-accountability.spec.js) and publishes. `prep` is 'prepared' | 'open-day' |
 *  'none' (never confirmed at all — the true "not prepared" state). */
async function setAliceTomorrowAndPublish(alice, { timezone, todayKey, todayItems = [], prep }) {
  const tomorrowKey = await alice.evaluate(({ timezone }) => globalThis.PlanTomorrowModel.planTomorrowTargetDate(Date.now(), timezone), { timezone });
  if (prep === 'prepared' || prep === 'open-day') {
    await alice.evaluate(({ tomorrowKey, timezone, intentionalBlank }) => {
      writeDatePlanLocal(tomorrowKey, {
        items: intentionalBlank ? [] : [{ id: 't1', task: 'Tomorrow task', done: false, when: '', updatedAt: Date.now() }],
        preparation: globalThis.PlanTomorrowModel.buildPreparation(null, {
          targetDate: tomorrowKey, timezone, now: Date.now(), mode: 'normal',
          updatedBy: 'device-a', intentionalBlank, routineInstanceIds: [], oneOffItemIds: intentionalBlank ? [] : ['t1']
        }),
        updatedAt: Date.now(), updatedBy: 'device-a'
      });
    }, { tomorrowKey, timezone, intentionalBlank: prep === 'open-day' });
  }
  await alice.evaluate(({ timezone, todayKey, todayItems }) => {
    settings.timezone = timezone;
    writeDatePlanLocal(todayKey, { items: todayItems, updatedAt: Date.now(), updatedBy: 'device-a' });
    publishSharedAccountability();
  }, { timezone, todayKey, todayItems });
  return tomorrowKey;
}

async function openBobPartnerView(bob) {
  await bob.evaluate(() => openPartnerView());
  await bob.waitForFunction(() => document.getElementById('partner-view-screen').hidden === false);
}

const TIMEZONE = 'Asia/Manila';

// ── Leg A — Mobile-safe navigation ──────────────────────────────────────────────────────

test.describe('Partner View Mobile Navigation V1', () => {
  test('Back to my day sits fully below a simulated safe-area inset and stays reachable', async ({ browser }) => {
    const { ctxA, ctxB, alice, bob } = await setupLinkedPair(browser, { bobViewport: { width: 390, height: 800 } });
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    await setAliceTomorrowAndPublish(alice, { timezone: TIMEZONE, todayKey, prep: 'prepared' });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);

    // Playwright/Chromium cannot emulate a real device's env(safe-area-inset-top) — there is
    // no OS notch/status bar to trigger it. This instead verifies the CSS *contract*: that
    // --safe-top (the same custom property style.css already uses for this purpose elsewhere,
    // e.g. .focus-exit-wrap/.install-banner) genuinely drives the banner's padding, by
    // overriding the property to a concrete pixel value and asserting the back button is
    // pushed below it. That is the honest limit of what this suite can prove.
    await bob.addStyleTag({ content: ':root{--safe-top:48px}' });
    const bannerBox = await bob.locator('.pv-banner').boundingBox();
    const backBox = await bob.locator('.pv-back-btn').boundingBox();
    expect(backBox).not.toBeNull();
    expect(backBox.y).toBeGreaterThanOrEqual(48);
    expect(backBox.y + backBox.height).toBeLessThanOrEqual(bannerBox.y + bannerBox.height + 1);
    expect(backBox.height).toBeGreaterThanOrEqual(36); // reasonable touch target

    await bob.locator('.pv-back-btn').click();
    await bob.waitForFunction(() => document.getElementById('partner-view-screen').hidden === true);

    await ctxA.close(); await ctxB.close();
  });

  test('320px and 390px: no horizontal overflow, back button clickable and keyboard-activatable', async ({ browser }) => {
    for (const width of [320, 390]) {
      const { ctxA, ctxB, alice, bob } = await setupLinkedPair(browser, { bobViewport: { width, height: 800 } });
      const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
      await setAliceTomorrowAndPublish(alice, {
        timezone: TIMEZONE, todayKey,
        todayItems: [{ id: 'p1', task: 'A priority', done: false, when: '', updatedAt: Date.now() }],
        prep: 'prepared'
      });
      await settle(alice); await settle(bob);
      await openBobPartnerView(bob);

      const overflow = await bob.evaluate(() => {
        const el = document.getElementById('partner-view-screen');
        return el.scrollWidth > window.innerWidth + 1;
      });
      expect(overflow, `no horizontal overflow at ${width}px`).toBe(false);

      // Keyboard activation: focus the back button directly and press Enter — a real button
      // element responds to both Enter and Space natively; Enter is sufficient to prove it.
      await bob.locator('.pv-back-btn').focus();
      await expect(bob.locator('.pv-back-btn')).toBeFocused();
      await bob.keyboard.press('Enter');
      await bob.waitForFunction(() => document.getElementById('partner-view-screen').hidden === true);

      await ctxA.close(); await ctxB.close();
    }
  });

  test('a very long viewed-person name wraps instead of pushing the back button offscreen', async ({ browser }) => {
    const shared = makeSharedDb();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext({ viewport: { width: 320, height: 800 } });
    const alice = await ctxA.newPage();
    const bob = await ctxB.newPage();
    await boot(alice, 'alice');
    await boot(bob, 'bob');
    await shared.attach(alice);
    await shared.attach(bob);
    await linkAliceAndBob(alice, bob);

    // A real display name has no server-side length cap other than the model's 80-char clean —
    // use a long single unbroken word (no spaces) as the adversarial case for wrapping.
    await alice.evaluate(() => {
      currentUser = { uid: 'alice', displayName: 'Supercalifragilisticexpialidociousandalsosomeadditionaltext', email: 'a@example.test' };
    });
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    await setAliceTomorrowAndPublish(alice, { timezone: TIMEZONE, todayKey, prep: 'prepared' });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);

    // Scoped to the Partner View overlay itself (#partner-view-screen), not the whole
    // document: the underlying Today view stays laid out behind the fixed overlay (covered,
    // not unmounted) and can have its own pre-existing overflow at narrow widths independent
    // of Partner View — out of scope for this bounded feature.
    const overflow = await bob.evaluate(() => {
      const el = document.getElementById('partner-view-screen');
      return el.scrollWidth > window.innerWidth + 1;
    });
    expect(overflow).toBe(false);
    const backBox = await bob.locator('.pv-back-btn').boundingBox();
    const viewport = bob.viewportSize();
    expect(backBox.x + backBox.width).toBeLessThanOrEqual(viewport.width + 1); // fully on-screen
    await expect(bob.locator('.pv-back-btn')).toBeVisible();

    await ctxA.close(); await ctxB.close();
  });

  test('scrolling the body leaves the banner and back button usable (no permanent content occlusion, no nested-scroll trap)', async ({ browser }) => {
    const { ctxA, ctxB, alice, bob } = await setupLinkedPair(browser, { bobViewport: { width: 375, height: 700 } });
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    // Enough entries to force real scroll height in the Timeline section.
    const now = await alice.evaluate(() => Date.now());
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: 'p' + i, tsStart: now - (i + 1) * 65000, ts: now - (i + 1) * 65000 + 60000,
      activity: 'Task ' + i, energy: 'shallow', blockIntervalMin: 1
    }));
    await alice.evaluate(({ many }) => { entries.push(...many); }, { many });
    await setAliceTomorrowAndPublish(alice, { timezone: TIMEZONE, todayKey, prep: 'prepared' });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);

    await bob.locator('.pv-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await bob.waitForTimeout(50);
    // Banner (and its back button) remains in the layout, visible, and clickable after scroll —
    // it lives outside the scrollable .pv-body, so it is never carried off-screen or hidden.
    await expect(bob.locator('.pv-back-btn')).toBeVisible();
    const backBox = await bob.locator('.pv-back-btn').boundingBox();
    expect(backBox.y).toBeGreaterThanOrEqual(0);
    await bob.locator('.pv-back-btn').click();
    await bob.waitForFunction(() => document.getElementById('partner-view-screen').hidden === true);

    await ctxA.close(); await ctxB.close();
  });
});

// ── Leg B — Contextual planning reminder ────────────────────────────────────────────────

test.describe('Partner View Planning Reminder V1', () => {
  test('prepared tomorrow -> no reminder', async ({ browser }) => {
    const { ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    await setAliceTomorrowAndPublish(alice, { timezone: TIMEZONE, todayKey, prep: 'prepared' });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);
    expect(screenText).not.toContain('Remind to plan tomorrow');
    await ctxA.close(); await ctxB.close();
  });

  test('explicit Open Day -> no reminder, even with zero tomorrow priorities', async ({ browser }) => {
    const { ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    await setAliceTomorrowAndPublish(alice, { timezone: TIMEZONE, todayKey, prep: 'open-day' });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const cardText = await bob.evaluate(() => document.getElementById('partner-card').textContent);
    expect(cardText).toContain('Open day'); // sanity: the fixture actually produced Open Day (summary card copy)
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);
    expect(screenText).not.toContain('Remind to plan tomorrow');
    await ctxA.close(); await ctxB.close();
  });

  test('authoritatively unprepared tomorrow -> reminder visible', async ({ browser }) => {
    const { ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    await setAliceTomorrowAndPublish(alice, { timezone: TIMEZONE, todayKey, prep: 'none' });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);
    expect(screenText).toContain('No plan for tomorrow yet');
    expect(screenText).toContain('Remind to plan tomorrow');
    await ctxA.close(); await ctxB.close();
  });

  // 'unknown' (never linked / no shared data at all) has no separate integration test here:
  // Partner View cannot even be opened without `ta3-partner-uid` set (openPartnerView() no-ops
  // otherwise), so there is no reachable UI state to assert against. That state IS proven
  // directly in shared-accountability-model.test.js (derivePlanningReminderState with
  // hasSharedData: false), which is the correct and only place to test it in isolation.

  test('missing/no current update -> no reminder (Partner View fails closed before the Tomorrow section ever renders)', async ({ browser }) => {
    const { ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    // A stale prior-day payload — same construction as the existing stale-payload regression
    // in tests/partner-view.spec.js.
    await alice.evaluate((timezone) => {
      const M = globalThis.SharedAccountabilityModel;
      const PV = globalThis.PartnerViewModel;
      const stale = M.buildSharedPayload({
        displayName: 'ALICE', timezone, dateKey: '2020-01-01', updatedAt: Date.parse('2020-01-01T10:00:00Z'),
        todayItems: [], tomorrowDateKey: '2020-01-02', tomorrowPrepStatus: 'not-prepared'
      });
      stale.partnerView = PV.buildPartnerViewProjection({
        dateKey: '2020-01-01', priorities: [], soFar: { deepMin: 0, wasteMin: 0 }, timelineItems: [],
        tomorrowDateKey: '2020-01-02', tomorrowPriorities: []
      });
      fbDb.ref('uid_alice/shared').set(stale);
    }, TIMEZONE);
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);
    expect(screenText).toContain('No current update');
    expect(screenText).not.toContain('Remind to plan tomorrow'); // even though the stale payload's prepStatus is 'not-prepared'
    await ctxA.close(); await ctxB.close();
  });

  test('zero tomorrow priorities but explicitly prepared -> no reminder (item count never implies unprepared)', async ({ browser }) => {
    const { ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    const tomorrowKey = await alice.evaluate((tz) => globalThis.PlanTomorrowModel.planTomorrowTargetDate(Date.now(), tz), TIMEZONE);
    // Prepared via a routine only (zero one-off items) — genuinely zero tomorrow PRIORITIES
    // displayed, but preparation truth is 'prepared', not 'not-prepared'.
    await alice.evaluate(({ tomorrowKey, timezone }) => {
      writeDatePlanLocal(tomorrowKey, {
        items: [],
        preparation: globalThis.PlanTomorrowModel.buildPreparation(null, {
          targetDate: tomorrowKey, timezone, now: Date.now(), mode: 'normal',
          updatedBy: 'device-a', intentionalBlank: false, routineInstanceIds: ['r1'], oneOffItemIds: []
        }),
        updatedAt: Date.now(), updatedBy: 'device-a'
      });
    }, { tomorrowKey, timezone: TIMEZONE });
    await alice.evaluate(({ todayKey, timezone }) => {
      settings.timezone = timezone;
      writeDatePlanLocal(todayKey, { items: [], updatedAt: Date.now(), updatedBy: 'device-a' });
      publishSharedAccountability();
    }, { todayKey, timezone: TIMEZONE });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);
    expect(screenText).toContain('No plan for tomorrow yet'); // zero displayed priorities...
    expect(screenText).not.toContain('Remind to plan tomorrow'); // ...but preparation truth says prepared
    await ctxA.close(); await ctxB.close();
  });

  test('priorities exist but preparation was never confirmed -> reminder still shows (preparation truth, not item presence, governs)', async ({ browser }) => {
    const { ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    const tomorrowKey = await alice.evaluate((tz) => globalThis.PlanTomorrowModel.planTomorrowTargetDate(Date.now(), tz), TIMEZONE);
    // A tomorrow item was drafted but preparation was never confirmed — no `preparation` object
    // at all, exactly what an in-progress, un-submitted draft looks like.
    await alice.evaluate(({ tomorrowKey, todayKey, timezone }) => {
      settings.timezone = timezone;
      writeDatePlanLocal(tomorrowKey, { items: [{ id: 't1', task: 'Draft item', done: false, when: '', updatedAt: Date.now() }], updatedAt: Date.now(), updatedBy: 'device-a' });
      writeDatePlanLocal(todayKey, { items: [], updatedAt: Date.now(), updatedBy: 'device-a' });
      publishSharedAccountability();
    }, { tomorrowKey, todayKey, timezone: TIMEZONE });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);
    expect(screenText).toContain('Draft item'); // the draft item itself is still visible (allowlisted display data)...
    expect(screenText).toContain('Remind to plan tomorrow'); // ...but never-confirmed preparation still reads as unprepared
    await ctxA.close(); await ctxB.close();
  });

  test('clicking the reminder sends via the existing /nudges transport with correct recipient, type, message and target date; success feedback shown; no plan/preparation/Timeline mutation', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    const tomorrowKey = await setAliceTomorrowAndPublish(alice, { timezone: TIMEZONE, todayKey, prep: 'none' });
    await settle(alice); await settle(bob);

    const planBefore = await alice.evaluate(() => JSON.stringify(plans));

    await openBobPartnerView(bob);
    await bob.locator('.pv-reminder-btn').click();
    await bob.waitForSelector('.pv-reminder-sent');
    const feedbackText = await bob.locator('.pv-reminder-sent').textContent();
    expect(feedbackText).toContain('Reminder sent');

    await settle(alice); await settle(bob);
    const writes = shared.nudgeWrites('alice');
    expect(writes.length).toBe(1);
    expect(writes[0].value.type).toBe('planning-reminder');
    expect(writes[0].value.message).toBe('Reminder to plan tomorrow'); // bounded, factual — not judgmental
    expect(writes[0].value.targetDate).toBe(tomorrowKey);
    expect(writes[0].value.from).toBe('BOB'); // stable identity via displayName, not a raw uid leak into the message
    expect(writes[0].by).toBe('bob'); // authenticated as the recipient's linked partner (bob), matching the rules' writer check

    // Truth boundary: the reminder is a one-way accountability push, never a mutation of
    // Alice's own planning/preparation/Timeline truth.
    const planAfter = await alice.evaluate(() => JSON.stringify(plans));
    expect(planAfter).toBe(planBefore);

    // Note: the recipient-side toast listener (`_nudgesRef.on('child_added', ...)`) is wired
    // up inside startSync()'s room-code bootstrap, not the partner-pairing flow this harness
    // exercises — same scope boundary as tests/partner-view.spec.js, which also never asserts
    // on nudge delivery. The write itself (above) is the authoritative proof the reminder used
    // the real /nudges transport; the toast-text branch added to that listener in storage.js is
    // a two-line, directly-reviewable ternary (`type === 'planning-reminder' ? ... : ...`).

    await ctxA.close(); await ctxB.close();
  });

  test('reminder failure shows failed feedback and allows retry, without silently claiming success', async ({ browser }) => {
    const { ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    await setAliceTomorrowAndPublish(alice, { timezone: TIMEZONE, todayKey, prep: 'none' });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);

    // Force the underlying write to fail (e.g. a rules rejection / offline) by breaking the
    // nudges ref's .set() for this one push, without touching the real transport code.
    await bob.evaluate(() => {
      const partnerUid = localStorage.getItem('ta3-partner-uid');
      const origRef = fbDb.ref.bind(fbDb);
      fbDb.ref = (p) => {
        const r = origRef(p);
        if (p === `uid_${partnerUid}/nudges`) {
          const origPush = r.push.bind(r);
          r.push = () => { const child = origPush(); child.set = () => Promise.reject(new Error('simulated failure')); return child; };
        }
        return r;
      };
    });

    await bob.locator('.pv-reminder-btn').click();
    await bob.waitForSelector('.pv-reminder-feedback');
    const feedback = await bob.locator('.pv-reminder-feedback').textContent();
    expect(feedback).toMatch(/try again/i);
    // The retry button is still present and enabled (not stuck disabled forever).
    await expect(bob.locator('.pv-reminder-btn')).toBeEnabled();

    await ctxA.close(); await ctxB.close();
  });

  test('double-click sends exactly one write (no duplicate from a fast double tap)', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    await setAliceTomorrowAndPublish(alice, { timezone: TIMEZONE, todayKey, prep: 'none' });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);

    await bob.evaluate(() => { sendPlanningReminder(); sendPlanningReminder(); sendPlanningReminder(); });
    await bob.waitForSelector('.pv-reminder-sent');
    await settle(alice); await settle(bob);
    expect(shared.nudgeWrites('alice').length).toBe(1);

    await ctxA.close(); await ctxB.close();
  });

  test('cooldown is shared with the generic Nudge — sending one blocks the other until the window elapses', async ({ browser }) => {
    const { shared, ctxA, ctxB, alice, bob } = await setupLinkedPair(browser);
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    await setAliceTomorrowAndPublish(alice, { timezone: TIMEZONE, todayKey, prep: 'none' });
    await settle(alice); await settle(bob);

    // Send the generic Nudge from the partner card first.
    await bob.evaluate(() => sendNudge());
    await settle(bob);

    await openBobPartnerView(bob);
    const screenText = await bob.evaluate(() => document.getElementById('partner-view-screen').textContent);
    // Reminder is still ELIGIBLE (tomorrow is still genuinely unprepared) but rate-limited by
    // the shared cooldown, so the eligible-but-limited state is shown rather than an actionable
    // button that would let the two controls bypass each other's rate limit.
    expect(screenText).toContain('Already nudged recently');
    await expect(bob.locator('.pv-reminder-btn')).toHaveCount(0);

    await settle(alice); await settle(bob);
    expect(shared.nudgeWrites('alice').length).toBe(1); // only the generic nudge — the reminder click never fires

    await ctxA.close(); await ctxB.close();
  });
});
