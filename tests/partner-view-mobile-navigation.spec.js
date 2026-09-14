// tests/partner-view-mobile-navigation.spec.js
//
// Partner View Mobile Navigation V1.
//
// The "Back to my day" escape action stays reachable at mobile widths and is never
// covered by simulated status/safe-area chrome.
//
// Note: this file originally also covered a contextual "Remind to plan tomorrow" leg
// (Planning Nudge V1). That leg was held back at independent review: reminder eligibility
// and its target date were built on CALENDAR tomorrow, but ChronaSense has since adopted a
// configurable Personal / Operational Day Boundary (for night-shift users, "tomorrow" in
// the planning sense is not always the next calendar date). Shipping a calendar-tomorrow
// reminder would assert a fact the product can no longer guarantee is correct. The
// planning-reminder UI, send path, eligibility helper, and its tests were removed; only
// the independently-passed mobile navigation fix remains. The reminder will be rebuilt
// later against the authoritative next-operational-day contract once Personal Day
// Boundary V1 lands.
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

// Same PROXY_DB as tests/partner-view.spec.js — 'value' listeners only. This suite never
// exercises /nudges, so no 'child_added' support is needed here.
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
    await page.exposeFunction('__dbSet', async (p, v) => { setAt(p, v); await deliver(p); });
    pages.push(page);
    await page.evaluate(PROXY_DB);
    await page.evaluate(() => window.__installProxyDb());
  }
  return { attach, snapshot: () => JSON.parse(JSON.stringify(db)), get: (p) => getAt(p) };
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

/** Sets Alice's today plan/timezone and publishes via the real publishSharedAccountability()
 *  path — same pattern as tests/partner-view.spec.js's setAliceStateAndPublish(). Tomorrow's
 *  preparation state is deliberately not touched: it has no bearing on the mobile navigation
 *  surface this file proves. */
async function setAliceStateAndPublish(alice, { timezone, todayKey, todayItems = [] }) {
  await alice.evaluate(({ timezone, todayKey, todayItems }) => {
    settings.timezone = timezone;
    writeDatePlanLocal(todayKey, { items: todayItems, updatedAt: Date.now(), updatedBy: 'device-a' });
    publishSharedAccountability();
  }, { timezone, todayKey, todayItems });
}

async function openBobPartnerView(bob) {
  await bob.evaluate(() => openPartnerView());
  await bob.waitForFunction(() => document.getElementById('partner-view-screen').hidden === false);
}

const TIMEZONE = 'Asia/Manila';

test.describe('Partner View Mobile Navigation V1', () => {
  test('Back to my day sits fully below a simulated safe-area inset and stays reachable', async ({ browser }) => {
    const { ctxA, ctxB, alice, bob } = await setupLinkedPair(browser, { bobViewport: { width: 390, height: 800 } });
    const todayKey = await alice.evaluate((tz) => getDateInTZ(Date.now(), tz), TIMEZONE);
    await setAliceStateAndPublish(alice, { timezone: TIMEZONE, todayKey });
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
      await setAliceStateAndPublish(alice, {
        timezone: TIMEZONE, todayKey,
        todayItems: [{ id: 'p1', task: 'A priority', done: false, when: '', updatedAt: Date.now() }]
      });
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
    await setAliceStateAndPublish(alice, { timezone: TIMEZONE, todayKey });
    await settle(alice); await settle(bob);
    await openBobPartnerView(bob);

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
    await setAliceStateAndPublish(alice, { timezone: TIMEZONE, todayKey });
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
