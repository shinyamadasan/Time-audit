// tests/wife-shared-accountability.spec.js
//
// Wife / Shared Accountability V1 — client-integration tests.
//
// shared-accountability-model.test.js proves the pure allowlist builder in isolation.
// firebase-rules.test.js proves the `/shared` node's owner-write + reciprocal-partner-read
// rules (unchanged by this milestone). This file proves the CLIENT wiring around both:
// publishSharedAccountability() only ever writes the allowlisted shape, the partner card
// renders read-only status from the real linked-partner flow, unlink clears it immediately,
// a stale publisher day is never shown as current, and routine app activity does not cause
// repeated high-frequency writes.
//
// Same harness as tests/pair-accountability.spec.js: a real two-page pairing handshake
// against a shared in-memory Firebase mock held in Node.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

// Wife/Shared Accountability V1 loads as a `type="module"` script (like plan-tomorrow-ui.js
// and every other model module this app already ships). Chromium refuses to load ANY
// `type="module"` script from a `file://` page (CORS treats file:// as a null origin) —
// tests/pair-accountability.spec.js gets away with `pathToFileURL(...)` only because its
// F1/F2 assertions never touch a module-loaded global. This spec does, so it serves the repo
// over a throwaway local static server instead — no change to playwright.config.js or any
// other spec's harness.
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
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb(null), 0); return () => {}; },
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

// Faithful-to-real-RTDB compaction: a Realtime Database node's "existence" is defined
// purely by having at least one child (or being a primitive) — an empty array/object has
// zero children, which the data model cannot distinguish from "never written," so it is
// pruned entirely and reads back as null/undefined. A mock that instead preserves `[]`
// exactly (as a plain JS object tree would) hides real production bugs like a validator
// that requires `Array.isArray(x)` to treat a legitimately-empty list as valid.
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
  await page.waitForFunction(() => !!globalThis.SharedAccountabilityModel); // module script has evaluated
  await page.evaluate((u) => {
    window.__uid = u;
    window.confirm = () => true;
    currentUser = { uid: u, displayName: u.toUpperCase(), email: u + '@example.test' };
    const ov = document.getElementById('signin-overlay'); if (ov) ov.style.display = 'none';
  }, uid);
}

const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 30)));

/** Runs the real two-page F1/F2 handshake to reach a genuinely reciprocally-linked state. */
async function linkAliceAndBob(shared, alice, bob) {
  const code = await alice.evaluate(() => { generateMyPairCode(); return document.getElementById('my-pair-code').textContent; });
  await settle(alice);
  await bob.evaluate((c) => { document.getElementById('partner-code-input').value = c; connectPartner(); }, code);
  await alice.waitForFunction(() => typeof _pendingPairClaim !== 'undefined' && _pendingPairClaim === 'bob');
  await alice.evaluate(() => acceptPairClaim());
  await bob.waitForFunction(() => localStorage.getItem('ta3-partner-uid') === 'alice');
  await settle(alice); await settle(bob); await settle(alice); await settle(bob);
}

/** Sets Alice's account timezone, today's plan (raw items), and any actual entries, then
 *  publishes. Bypasses the modal UI — writeDatePlanLocal/entries/publishSharedAccountability
 *  are the same functions the real UI calls. */
async function setAlicePlanAndPublish(alice, { timezone, todayKey, items, entries: entryList = [] }) {
  return alice.evaluate(({ timezone, todayKey, items, entryList }) => {
    settings.timezone = timezone;
    entries.push(...entryList);
    writeDatePlanLocal(todayKey, { items, updatedAt: Date.now(), updatedBy: 'device-a' });
    publishSharedAccountability();
  }, { timezone, todayKey, items, entryList });
}

test.describe('Wife/Shared Accountability V1', () => {
  test('publishSharedAccountability writes only the V1 allowlist, even with maximal private state present', async ({ browser }) => {
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

    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    await setAlicePlanAndPublish(alice, {
      timezone: 'Asia/Manila',
      todayKey,
      items: [
        { id: 'p1', task: 'Finish proposal', done: false, when: '', updatedAt: Date.now() },
        { id: 'p2', task: 'Read a book', done: true, doneAt: Date.now(), when: '', updatedAt: Date.now() }
      ],
      entries: [{
        id: 'e1', ts: Date.now(), activity: 'Finish proposal', energy: 'deep', planItemId: 'p1',
        blockIntervalMin: 120, url: 'https://reddit.com/r/all', domain: 'reddit.com',
        review: 'felt distracted', device: 'laptop-1'
      }]
    });
    await settle(alice);

    const payload = shared.get('uid_alice/shared');
    expect(payload).toBeTruthy();
    // Partner View V1 (corrected product requirement) publishes its deeper reciprocal
    // Today projection as a sibling `partnerView` key on this SAME payload/write — the
    // quick-glance summary allowlist below is otherwise unchanged.
    expect(Object.keys(payload).sort()).toEqual(['partnerView', 'publisher', 'schemaVersion', 'today', 'tomorrow']);
    expect(Object.keys(payload.publisher).sort()).toEqual(['dateKey', 'displayName', 'timezone', 'updatedAt']);
    expect(Object.keys(payload.today).sort()).toEqual(['dateKey', 'priorities']);
    expect(Object.keys(payload.tomorrow).sort()).toEqual(['dateKey', 'prepStatus']);
    payload.today.priorities.forEach((p) => expect(Object.keys(p).sort()).toEqual(['status', 'title']));

    // "deep"/"minute" are deliberately excluded from this full-payload check — Partner
    // View V1 (partnerView.today.soFar) is now the one place Deep/Waste minutes are
    // intentionally exposed. Everything else here must still never appear anywhere,
    // including inside partnerView (no gamification, no technical/security internals).
    const serialized = JSON.stringify(payload).toLowerCase();
    for (const bad of ['reddit', 'url', 'domain', 'review', 'device', 'streak', 'score', 'wallet']) {
      expect(serialized.includes(bad)).toBe(false);
    }
    // The narrow summary card itself (publisher/today/tomorrow, excluding partnerView)
    // still never leaks Deep/Waste minutes or any other behavioral figure — unchanged.
    const summaryOnly = JSON.stringify({ publisher: payload.publisher, today: payload.today, tomorrow: payload.tomorrow }).toLowerCase();
    for (const bad of ['deep', 'minute']) {
      expect(summaryOnly.includes(bad)).toBe(false);
    }

    // Status semantics: linked actual + not done -> worked-on; explicit done -> done; minutes never imply done.
    const byTitle = Object.fromEntries(payload.today.priorities.map((p) => [p.title, p.status]));
    expect(byTitle['Finish proposal']).toBe('worked-on');
    expect(byTitle['Read a book']).toBe('done');

    await ctxA.close(); await ctxB.close();
  });

  test('partner card shows read-only Planned/Worked on/Done and Tomorrow prep status; no editing controls', async ({ browser }) => {
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

    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    const tomorrowKey = await alice.evaluate(() => globalThis.PlanTomorrowModel.planTomorrowTargetDate(Date.now(), 'Asia/Manila'));
    await alice.evaluate(({ tomorrowKey }) => {
      settings.timezone = 'Asia/Manila';
      writeDatePlanLocal(tomorrowKey, {
        items: [],
        preparation: globalThis.PlanTomorrowModel.buildPreparation(null, {
          targetDate: tomorrowKey, timezone: 'Asia/Manila', now: Date.now(), mode: 'normal',
          updatedBy: 'device-a', intentionalBlank: true, routineInstanceIds: [], oneOffItemIds: []
        }),
        updatedAt: Date.now(), updatedBy: 'device-a'
      });
    }, { tomorrowKey });
    await setAlicePlanAndPublish(alice, {
      timezone: 'Asia/Manila',
      todayKey,
      items: [
        { id: 'p1', task: 'Planned only', done: false, when: '', updatedAt: Date.now() },
        { id: 'p2', task: 'In progress task', done: false, when: '', updatedAt: Date.now() },
        { id: 'p3', task: 'Finished task', done: true, doneAt: Date.now(), when: '', updatedAt: Date.now() }
      ],
      entries: [{ id: 'e1', ts: Date.now(), activity: 'In progress task', planItemId: 'p2', blockIntervalMin: 30 }]
    });
    await settle(alice); await settle(bob);

    await bob.waitForFunction(() => {
      const el = document.getElementById('partner-card');
      return el && el.textContent.includes('Planned only');
    });
    const cardHtml = await bob.evaluate(() => document.getElementById('partner-card').innerHTML);
    const cardText = await bob.evaluate(() => document.getElementById('partner-card').textContent);

    expect(cardText).toContain('Planned only');
    expect(cardText).toContain('In progress task');
    expect(cardText).toContain('Finished task');
    expect(cardText).toContain('Planned');
    expect(cardText).toContain('Worked on');
    expect(cardText).toContain('Done');
    expect(cardText).toContain('Open day'); // tomorrow prep status

    // Read-only: no partner-task control markup (checkbox/edit/delete/start affordances).
    expect(cardHtml).not.toMatch(/onclick="[^"]*(toggle|remove|edit|start)PlanItem/i);

    // No gamification/surveillance vocabulary anywhere in the rendered card.
    const lower = cardText.toLowerCase();
    for (const bad of ['streak', 'score', 'ahead', 'behind', 'winning', 'productivity', '%']) {
      expect(lower.includes(bad)).toBe(false);
    }

    await ctxA.close(); await ctxB.close();
  });

  test('unlink clears the partner card immediately; no stale partner data lingers', async ({ browser }) => {
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

    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    await setAlicePlanAndPublish(alice, {
      timezone: 'Asia/Manila', todayKey,
      items: [{ id: 'p1', task: 'Some priority', done: false, when: '', updatedAt: Date.now() }]
    });
    await settle(alice); await settle(bob);
    await bob.waitForFunction(() => document.getElementById('partner-card').textContent.includes('Some priority'));

    // Alice disconnects.
    await alice.evaluate(() => removePair());
    await bob.waitForFunction(() => document.getElementById('partner-card').style.display === 'none');

    const bobText = await bob.evaluate(() => document.getElementById('partner-card').textContent);
    expect(bobText).not.toContain('Some priority');
    expect(await bob.evaluate(() => typeof partnerShared === 'undefined' ? null : partnerShared)).toBeNull();

    await ctxA.close(); await ctxB.close();
  });

  test('a stale publisher-day payload is never shown as current, regardless of viewer device clock/timezone', async ({ browser }) => {
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

    // Directly write a payload dated to a day that is definitely not "today" in Manila.
    await alice.evaluate(() => {
      const stalePayload = globalThis.SharedAccountabilityModel.buildSharedPayload({
        displayName: 'ALICE', timezone: 'Asia/Manila', dateKey: '2020-01-01', updatedAt: Date.parse('2020-01-01T10:00:00Z'),
        todayItems: [{ title: 'Old stale priority', status: 'planned' }],
        tomorrowDateKey: '2020-01-02', tomorrowPrepStatus: 'prepared'
      });
      fbDb.ref('uid_alice/shared').set(stalePayload);
    });
    await settle(alice); await settle(bob);

    const bobText = await bob.evaluate(() => document.getElementById('partner-card').textContent);
    expect(bobText).not.toContain('Old stale priority');
    expect(bobText).toContain('No current update');

    await ctxA.close(); await ctxB.close();
  });

  test('an invalid-but-present publisher timezone fails safe (no crash, no viewer-timezone fallback, no stale title shown)', async ({ browser }) => {
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

    const bobErrors = [];
    bob.on('pageerror', (err) => bobErrors.push(err.message));

    // A payload that shape-validates (validateSharedPayload only checks the timezone is a
    // non-empty string, not that it's a real IANA zone) but whose timezone cannot be used
    // to establish the publisher's current day — reachable only via corrupted sync data or
    // direct tampering with an owner's own /shared node, never via the app's own timezone
    // <select>. dateKey is deliberately today-looking so the ONLY thing standing between
    // this payload and being shown as current is the (now-guarded) freshness check.
    const todayLookingKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    await alice.evaluate(({ todayLookingKey }) => {
      const badTzPayload = globalThis.SharedAccountabilityModel.buildSharedPayload({
        displayName: 'ALICE', timezone: 'Not/AZone', dateKey: todayLookingKey, updatedAt: Date.now(),
        todayItems: [{ title: 'Recognizable current-looking priority', status: 'planned' }],
        tomorrowDateKey: todayLookingKey, tomorrowPrepStatus: 'prepared'
      });
      fbDb.ref('uid_alice/shared').set(badTzPayload);
    }, { todayLookingKey });
    await settle(alice); await settle(bob);

    // No uncaught exception reached the page from the render pass.
    expect(bobErrors).toEqual([]);

    const bobText = await bob.evaluate(() => document.getElementById('partner-card').textContent);
    expect(bobText).not.toContain('Recognizable current-looking priority'); // never shown as Today
    expect(bobText).toContain('No current update'); // fails CLOSED, not open
    expect(await bob.evaluate(() => document.getElementById('partner-card').style.display)).not.toBe('none'); // partner is still linked — card stays visible with the calm placeholder, doesn't just vanish

    await ctxA.close(); await ctxB.close();
  });

  test('routine activity (many render/entry-sync calls) does not cause repeated /shared writes — bounded, not high-frequency', async ({ browser }) => {
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

    const todayKey = await alice.evaluate(() => getDateInTZ(Date.now(), 'Asia/Manila'));
    await setAlicePlanAndPublish(alice, {
      timezone: 'Asia/Manila', todayKey,
      items: [{ id: 'p1', task: 'Steady task', done: false, when: '', updatedAt: Date.now() }]
    });
    await settle(alice);
    const writesAfterFirstPublish = shared.sharedWrites('alice').length;
    expect(writesAfterFirstPublish).toBeGreaterThan(0);

    // Simulate 60 "timer tick" style calls with no actual state change — this is exactly what
    // a naive "publish on every render" wiring would produce over one minute of ticking.
    await alice.evaluate(() => {
      for (let i = 0; i < 60; i++) publishSharedAccountability();
    });
    await settle(alice);

    expect(shared.sharedWrites('alice').length).toBe(writesAfterFirstPublish); // zero additional writes

    await ctxA.close(); await ctxB.close();
  });
});
