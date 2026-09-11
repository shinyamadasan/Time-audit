// tests/pair-accountability.spec.js
//
// Shared Access Hardening V1 — client-handshake tests (F1 + F2).
//
// These are CLIENT tests: Firebase is a shared in-memory mock held in Node and
// proxied to two independent browser pages (Alice + Bob), so the real
// two-client pairing handshake runs. They do NOT prove the security *rules* —
// that is firebase-rules.test.js (targaryen). Here we prove the client never
// writes the other user's `partnerUid`, and never links anyone without an
// explicit creator Accept.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_URL = pathToFileURL(path.resolve('index.html')).href;

// Minimal boot stub: enough for index.html to parse + expose its functions.
// onAuthStateChanged(null) keeps startSync() out of the way; the tests install a
// richer `fbDb` and set `currentUser` by hand.
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

// Page-side proxy: turns fbDb.ref(...) calls into calls on the Node-held store.
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

// One shared in-memory DB for a test, wired to N pages.
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
      writes.push({ path: p, value: v === undefined ? null : JSON.parse(JSON.stringify(v)), by: by || null });
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
    partnerUidWrites: () => writes.filter((w) => /^uid_[^/]+\/partnerUid$/.test(w.path)),
  };
}

async function boot(page, uid, { clearStorage = true } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: BOOT_STUB }));
  await page.addInitScript((clear) => {
    if (clear) localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
  }, clearStorage);
  await page.goto(APP_URL);
  await page.waitForFunction(() => typeof window.watchPairCode === 'function' && typeof window.connectPartner === 'function');
  await page.evaluate((u) => {
    window.__uid = u;
    window.confirm = () => true; // removePair() guards on confirm()
    currentUser = { uid: u, displayName: u.toUpperCase(), email: u + '@example.test' };
    const ov = document.getElementById('signin-overlay'); if (ov) ov.style.display = 'none';
  }, uid);
}

const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 30)));

test.describe('pairing handshake (Shared Access Hardening V1)', () => {
  test('F1 — pair codes come from crypto.getRandomValues, not Math.random', async ({ page }) => {
    await page.route('https://www.gstatic.com/firebasejs/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: BOOT_STUB }));
    await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1'); });
    await page.goto(APP_URL);
    await page.waitForFunction(() => typeof window.securePairCode === 'function');

    const res = await page.evaluate(() => {
      const codes = [];
      for (let i = 0; i < 200; i++) codes.push(securePairCode());
      const formatOk = codes.every((c) => /^[0-9A-Z]{6}$/.test(c));
      const distinct = new Set(codes).size;
      // Poison Math.random entirely — code generation must not care.
      const realRandom = Math.random;
      Math.random = () => { throw new Error('Math.random must not be used for pair codes'); };
      let survivesPoison = true;
      try { for (let i = 0; i < 50; i++) if (!/^[0-9A-Z]{6}$/.test(securePairCode())) survivesPoison = false; }
      catch { survivesPoison = false; }
      Math.random = realRandom;
      // No secure RNG -> throw, never silently fall back.
      const realCrypto = window.crypto;
      let throwsWithoutCrypto = false;
      try { Object.defineProperty(window, 'crypto', { value: undefined, configurable: true }); securePairCode(); }
      catch { throwsWithoutCrypto = true; }
      Object.defineProperty(window, 'crypto', { value: realCrypto, configurable: true });
      return { formatOk, distinct, total: codes.length, survivesPoison, throwsWithoutCrypto };
    });

    expect(res.formatOk).toBe(true);
    expect(res.distinct).toBeGreaterThan(res.total * 0.95); // 200 draws from ~2.18e9 — collisions ~impossible
    expect(res.survivesPoison).toBe(true);
    expect(res.throwsWithoutCrypto).toBe(true);
  });

  test('F2 — a claimed code is a request; creator is NOT auto-linked; Reject links no one', async ({ browser }) => {
    const shared = makeSharedDb();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const alice = await ctxA.newPage();
    const bob = await ctxB.newPage();
    await boot(alice, 'alice');
    await boot(bob, 'bob');
    await shared.attach(alice);
    await shared.attach(bob);

    // Alice creates a code.
    const code = await alice.evaluate(() => { generateMyPairCode(); return document.getElementById('my-pair-code').textContent; });
    expect(code).toMatch(/^[0-9A-Z]{6}$/);
    await settle(alice);

    // Bob enters it.
    await bob.evaluate((c) => { document.getElementById('partner-code-input').value = c; connectPartner(); }, code);
    await settle(bob); await settle(alice); await settle(bob);

    // Before Alice accepts:
    expect(shared.get('uid_alice/partnerUid')).toBeUndefined();          // creator NOT linked
    expect(shared.get('uid_bob/partnerUid')).toBeUndefined();            // joiner NOT linked
    expect(shared.get(`pairs/${code}/partner`)).toBe('bob');             // claim recorded
    expect(shared.get(`pairs/${code}/accepted`)).toBeFalsy();
    expect(await alice.evaluate(() => document.getElementById('partner-pending').style.display)).toBe('block');
    expect(await alice.evaluate(() => document.getElementById('partner-connected').style.display)).toBe('none');
    expect(await bob.evaluate(() => document.getElementById('partner-pending').textContent)).toContain('Waiting for your partner');
    expect(await bob.evaluate(() => document.getElementById('partner-connected').style.display)).toBe('none');

    // Alice rejects.
    await alice.evaluate(() => rejectPairClaim());
    await settle(alice); await settle(bob); await settle(bob);

    expect(shared.partnerUidWrites()).toHaveLength(0);                   // nothing ever written
    expect(shared.get(`pairs/${code}`)).toBeUndefined();                // code burned
    expect(await alice.evaluate(() => document.getElementById('partner-no-pair').style.display)).toBe('block');
    expect(await bob.evaluate(() => document.getElementById('partner-connected').style.display)).toBe('none');

    await ctxA.close(); await ctxB.close();
  });

  test('F2 — explicit Accept converges the reciprocal link, each side writing only its own partnerUid', async ({ browser }) => {
    const shared = makeSharedDb();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const alice = await ctxA.newPage();
    const bob = await ctxB.newPage();
    await boot(alice, 'alice');
    await boot(bob, 'bob');
    await shared.attach(alice);
    await shared.attach(bob);

    const code = await alice.evaluate(() => { generateMyPairCode(); return document.getElementById('my-pair-code').textContent; });
    await settle(alice);
    await bob.evaluate((c) => { document.getElementById('partner-code-input').value = c; connectPartner(); }, code);
    await alice.waitForFunction(() => typeof _pendingPairClaim !== 'undefined' && _pendingPairClaim === 'bob');

    // Alice accepts.
    await alice.evaluate(() => acceptPairClaim());
    await bob.waitForFunction(() => localStorage.getItem('ta3-partner-uid') === 'alice');
    await settle(alice); await settle(bob);

    expect(shared.get('uid_alice/partnerUid')).toBe('bob');
    expect(shared.get('uid_bob/partnerUid')).toBe('alice');
    // The crucial invariant: nobody wrote the other person's partnerUid.
    for (const w of shared.partnerUidWrites()) {
      const owner = w.path.match(/^uid_([^/]+)\//)[1];
      expect(w.by).toBe(owner);
    }
    expect(await alice.evaluate(() => document.getElementById('partner-connected').style.display)).toBe('block');
    expect(await bob.evaluate(() => document.getElementById('partner-connected').style.display)).toBe('block');

    // Disconnect from Alice's side still tears both sides down.
    await alice.evaluate(() => removePair());
    await settle(alice); await settle(bob); await settle(bob);
    expect(shared.get('uid_alice/partnerUid')).toBeUndefined();
    expect(shared.get('uid_bob/partnerUid')).toBeUndefined();
    expect(await bob.evaluate(() => document.getElementById('partner-connected').style.display)).toBe('none');

    await ctxA.close(); await ctxB.close();
  });

  test('F2 — pending claim survives a creator reload and still needs an explicit Accept', async ({ browser }) => {
    const shared = makeSharedDb();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    let alice = await ctxA.newPage();
    const bob = await ctxB.newPage();
    await boot(alice, 'alice');
    await boot(bob, 'bob');
    await shared.attach(alice);
    await shared.attach(bob);

    const code = await alice.evaluate(() => { generateMyPairCode(); return document.getElementById('my-pair-code').textContent; });
    await settle(alice);
    await bob.evaluate((c) => { document.getElementById('partner-code-input').value = c; connectPartner(); }, code);
    await alice.waitForFunction(() => typeof _pendingPairClaim !== 'undefined' && _pendingPairClaim === 'bob');
    expect(shared.get('uid_alice/partnerUid')).toBeUndefined();

    // Alice reloads (localStorage keeps ta3-pair-code — do NOT clear it on boot).
    alice = await ctxA.newPage();
    await boot(alice, 'alice', { clearStorage: false });
    await shared.attach(alice);
    await alice.evaluate(() => { if (localStorage.getItem('ta3-pair-code')) watchPairCode(); });
    await alice.waitForFunction(() => typeof _pendingPairClaim !== 'undefined' && _pendingPairClaim === 'bob');

    // Still pending, still no link.
    expect(shared.get('uid_alice/partnerUid')).toBeUndefined();
    expect(await alice.evaluate(() => document.getElementById('partner-pending').style.display)).toBe('block');
    expect(await alice.evaluate(() => (document.getElementById('partner-pending').textContent || '').includes('waiting to connect'))).toBe(true);

    // Now Alice accepts -> converges.
    await alice.evaluate(() => acceptPairClaim());
    await bob.waitForFunction(() => localStorage.getItem('ta3-partner-uid') === 'alice');
    await settle(alice);
    expect(shared.get('uid_alice/partnerUid')).toBe('bob');
    expect(shared.get('uid_bob/partnerUid')).toBe('alice');

    await ctxA.close(); await ctxB.close();
  });
});
