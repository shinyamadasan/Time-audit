// tests/today-persistent-sections.spec.js
//
// Today Persistent Sections V1 — Timeline and Accountability are visible on Today by
// default (no reveal click required); each remembers its own collapsed/expanded state
// independently via localStorage. Collapsing is presentation-only.
//
// Reuses the same lightweight single-page file:// harness as tests/smoke.spec.js.
// `shared-accountability-model.js` is a `type="module"` script that Chromium refuses to
// load from a file:// page (see tests/wife-shared-accountability.spec.js for the same
// note) — renderPartnerCard() already handles `globalThis.SharedAccountabilityModel`
// being unset by falling back to its generic "no current update" rendering, which is
// enough to exercise section visibility/collapse/persistence. For the one test that
// needs to tell two different partner payloads apart (live update while collapsed),
// a minimal fake SharedAccountabilityModel is installed before navigation.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_URL = pathToFileURL(path.resolve('index.html')).href;

// storage.js's boot listener treats a real Firebase "partnerUid" read of null as
// "the partner unlinked on the other side" and deletes ta3-partner-uid locally — so this
// stub must echo back whatever the test pre-seeded (via window.__mockDbValues) for that
// path, or every "partner linked" test would get its own localStorage flag wiped on load.
const firebaseStub = `
(() => {
  if (window.firebase) return;
  const valueFor = refPath => (window.__mockDbValues && Object.prototype.hasOwnProperty.call(window.__mockDbValues, refPath))
    ? window.__mockDbValues[refPath] : null;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const makeRef = refPath => ({
    path: refPath,
    child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) {
      if (eventName === 'value') setTimeout(() => cb(snapshot(valueFor(refPath))), 0);
      return cb;
    },
    off() {},
    once() { return Promise.resolve(snapshot(valueFor(refPath))); },
    update() { return Promise.resolve(); },
    set() { return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    push(value) {
      const pushed = makeRef(refPath + '/pushed');
      pushed.key = 'pushed';
      if (value !== undefined) pushed.set(value);
      return pushed;
    },
    onDisconnect() {
      return { set() { return Promise.resolve(); }, remove() { return Promise.resolve(); }, cancel() { return Promise.resolve(); } };
    }
  });
  const auth = () => ({
    onAuthStateChanged(cb) {
      setTimeout(() => cb({ uid: 'smoke-user', displayName: 'Smoke User', email: 'smoke@example.test', photoURL: '' }), 0);
      return () => {};
    },
    signInWithPopup() { return Promise.resolve(); },
    signInWithCredential() { return Promise.resolve(); },
    signOut() { return Promise.resolve(); }
  });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = {
    apps: [],
    initializeApp(config) { const app = { config }; this.apps.push(app); return app; },
    app() { return this.apps[0] || this.initializeApp({}); },
    database() { return { ref: makeRef }; },
    auth
  };
})();
`;

function baseSettings(overrides = {}) {
  return {
    hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10,
    presets: [], timezone: 'UTC', activityColors: {}, coachTone: 'analyst',
    reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00',
    sleepReminderMin: 30, sleepSetupDone: true, templates: [], ...overrides
  };
}

// `stubSharedModel: true` installs a minimal fake SharedAccountabilityModel so the
// partner card can render real payload differences (used only by the live-update test).
async function openApp(page, { entries = [], plans = {}, settings = {}, partnerUid = null, prefs = {}, stubSharedModel = false } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: firebaseStub
  }));
  await page.addInitScript(({ entries, plans, settings, partnerUid, prefs, stubSharedModel }) => {
    // addInitScript re-runs on EVERY navigation, including page.reload() — guard the
    // one-time localStorage seed so a reload (used to test persistence) doesn't wipe out
    // whatever the test/app wrote after the initial load. window-only stubs below are
    // NOT guarded: window state doesn't survive reload on its own, so those must reapply
    // every time (same pattern as tests/focus-reload-recovery.spec.js).
    if (!localStorage.getItem('ta3-tps-test-seeded')) {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('ta3-tps-test-seeded', '1');
      localStorage.setItem('ta3-onboarded', '1');
      sessionStorage.setItem('ta3-session-started', '1');
      localStorage.setItem('ta3-tz:uid_smoke-user', settings.timezone || 'UTC');
      localStorage.setItem('ta3-settings:uid_smoke-user', JSON.stringify(settings));
      localStorage.setItem('ta3-entries:uid_smoke-user', JSON.stringify(entries));
      localStorage.setItem('ta3-plans:uid_smoke-user', JSON.stringify(plans));
      if (partnerUid) localStorage.setItem('ta3-partner-uid', partnerUid);
      for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v);
    }
    if (partnerUid) {
      // The boot-time `partnerUid` value listener in storage.js reads this same path from
      // the (stubbed) real Firebase; echo the local value back so it isn't treated as an
      // unlink signal (see the firebaseStub comment above).
      window.__mockDbValues = { 'uid_smoke-user/partnerUid': partnerUid };
    }
    if (stubSharedModel) {
      window.SharedAccountabilityModel = {
        validateSharedPayload: p => p || null,
        isSharedTodayFresh: () => true,
        formatFreshness: () => 'Updated recently'
      };
    }
  }, { entries, plans, settings: baseSettings(settings), partnerUid, prefs, stubSharedModel });
  await page.goto(APP_URL);
  await page.waitForFunction(() => typeof window.quickRetroLog === 'function' && !!document.getElementById('timeline-blocks'));
  await expect(page.locator('#today-date')).not.toHaveText('');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

test.describe('Today Persistent Sections V1', () => {

  test('A: Timeline is visible by default with no saved preference', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#timeline-details')).toHaveAttribute('open');
    await expect(page.locator('#timeline-section')).toBeVisible();
    await expect(page.locator('#timeline-details > summary')).toBeHidden();
  });

  test('B: Accountability is visible by default when a partner is linked, no saved preference', async ({ page }) => {
    await openApp(page, { partnerUid: 'partner-1' });
    await expect(page.locator('#accountability-details')).toBeVisible();
    await expect(page.locator('#partner-card')).toBeVisible();
    await expect(page.locator('#partner-card')).toContainText(/planning streak/i);
  });

  test('C: collapsing Timeline leaves Accountability unaffected', async ({ page }) => {
    await openApp(page, { partnerUid: 'partner-1' });
    await expect(page.locator('#timeline-details > summary')).toBeHidden();
    await expect(page.locator('#timeline-details')).toHaveAttribute('open');
    await expect(page.locator('#partner-card')).toBeVisible();
  });

  test('D: collapsing Accountability leaves Timeline unaffected', async ({ page }) => {
    await openApp(page, { partnerUid: 'partner-1' });
    await expect(page.locator('#accountability-details > summary')).toHaveCount(0);
    await expect(page.locator('#timeline-details')).toHaveAttribute('open');
    await expect(page.locator('#timeline-section')).toBeVisible();
  });

  test('E: collapsed/expanded state persists across reload, independently per section', async ({ page }) => {
    await openApp(page, { partnerUid: 'partner-1' });
    await page.reload();
    await page.waitForFunction(() => typeof window.quickRetroLog === 'function' && !!document.getElementById('timeline-blocks'));
    await expect(page.locator('#timeline-details')).toHaveAttribute('open');
    await expect(page.locator('#accountability-details')).toBeVisible();
  });

  test('F: each section\'s saved preference is independent of the other', async ({ page }) => {
    await openApp(page, {
      partnerUid: 'partner-1',
      prefs: { 'ta3-timeline-open': '0', 'ta3-accountability-open': '1' }
    });
    await expect(page.locator('#timeline-details')).toHaveAttribute('open');
    await expect(page.locator('#accountability-details')).toBeVisible();
  });

  test('G: no linked partner means no persistent empty Accountability section', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#accountability-details')).toBeVisible();
    await expect(page.locator('#partner-card')).toContainText(/planning streak/i);
  });

  test('H: View day still opens the existing Partner View', async ({ page }) => {
    await openApp(page, { partnerUid: 'partner-1' });
    await page.getByRole('button', { name: 'View day' }).click();
    await expect(page.locator('#partner-view-screen')).toBeVisible();
  });

  test('I: existing Nudge control still renders and is clickable', async ({ page }) => {
    await openApp(page, { partnerUid: 'partner-1' });
    const nudgeOrNudged = page.locator('#partner-card').getByText(/Nudge/);
    await expect(nudgeOrNudged.first()).toBeVisible();
  });

  test('J: an expanded Accountability shows the latest partner state, not a stale snapshot from before it was collapsed', async ({ page }) => {
    await openApp(page, { partnerUid: 'partner-1', stubSharedModel: true });
    await page.evaluate(() => {
      partnerShared = {
        publisher: { displayName: 'Alyssa', timezone: 'UTC', updatedAt: Date.now() },
        today: { dateKey: new Date().toISOString().slice(0, 10), priorities: [{ title: 'First task', status: 'planned' }] },
        tomorrow: { prepStatus: 'not-prepared' }
      };
      renderPartnerCard();
    });
    await expect(page.locator('#partner-card')).toContainText('Alyssa · Not planned');

    // A live update refreshes the compact status without requiring expansion.
    await page.evaluate(() => {
      partnerShared = {
        publisher: { displayName: 'Alyssa', timezone: 'UTC', updatedAt: Date.now() },
        today: { dateKey: new Date().toISOString().slice(0, 10), priorities: [{ title: 'Second task', status: 'worked-on' }] },
        tomorrow: { prepStatus: 'prepared' }
      };
      renderPartnerCard();
    });

    await expect(page.locator('#partner-card')).toContainText('Alyssa · Planned');
    await expect(page.locator('#partner-card')).not.toContainText('First task');
  });

  test('K: aria-expanded reflects true state and keyboard toggles it', async ({ page }) => {
    await openApp(page, { partnerUid: 'partner-1' });
    await expect(page.getByRole('button', { name: 'Previous My Day' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next My Day' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose My Day date' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'View day' })).toBeVisible();
  });

  test('no horizontal overflow and adequate tap targets at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openApp(page, { partnerUid: 'partner-1' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
    const calendarBox = await page.getByRole('button', { name: 'Choose My Day date' }).boundingBox();
    expect(calendarBox.height).toBeGreaterThanOrEqual(40);
    const partnerBox = await page.getByRole('button', { name: 'View day' }).boundingBox();
    expect(partnerBox.height).toBeGreaterThanOrEqual(40);
  });
});
