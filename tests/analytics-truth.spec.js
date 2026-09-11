// Phase 6G.2 — Deterministic Analytics Truth Fixes V1
//
// End-to-end checks that Today / Review / Insights / Focus Wallet interpret the
// evidence they actually have: passive site/app observations, schedule
// assumptions and "PC Time" context stay as raw entries but are not counted as
// confirmed deep work or confirmed waste, and overlapping evidence no longer
// pushes percentages past 100%.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';
const NOW = Date.parse('2026-09-08T18:00:00Z');
const DAY = '2026-09-08';

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const makeRef = () => ({
    child() { return makeRef(); }, on(e, cb) { if (e === 'value') setTimeout(() => cb(snapshot(null)), 0); return cb; },
    off() {}, once() { return Promise.resolve(snapshot(null)); }, update() { return Promise.resolve(); },
    set() { return Promise.resolve(); }, remove() { return Promise.resolve(); },
    transaction(fn) { return Promise.resolve({ committed: true, snapshot: snapshot(fn(null)) }); },
    push() { const p = makeRef(); p.key = 'k'; return p; },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  const auth = () => ({ onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'u', displayName: 'U', email: 'u@example.test', photoURL: '' }), 0); return () => {}; }, signInWithPopup: () => Promise.resolve(), signOut: () => Promise.resolve() });
  auth.GoogleAuthProvider = function () {}; auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = { apps: [], initializeApp(c) { const a = { config: c }; this.apps.push(a); return a; }, app() { return this.apps[0] || this.initializeApp({}); }, database() { return { ref: makeRef }; }, auth };
})();`;

test.beforeAll(async () => {
  appServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = path.resolve(APP_ROOT, `.${decodeURIComponent(pathname)}`);
      if (!filePath.startsWith(APP_ROOT)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${appServer.address().port}/index.html`;
});

test.afterAll(async () => {
  if (appServer) await new Promise(resolve => appServer.close(resolve));
});

async function openApp(page) {
  await page.route('https://www.gstatic.com/firebasejs/**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.addInitScript(({ now }) => {
    const RealDate = Date;
    window.Date = class MockDate extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', 'Etc/UTC');
    localStorage.setItem('ta3-device-id', 'device-test');
    localStorage.setItem('ta3-settings', JSON.stringify({ timezone: 'Etc/UTC', hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepSetupDone: true, templates: [] }));
    localStorage.setItem('ta3-entries', '[]'); localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-reviews', '{}'); localStorage.setItem('ta3-plans', '{}');
    localStorage.setItem('ta3-daily-routines-v1', JSON.stringify({ schemaVersion: 1, timezone: 'Etc/UTC', routines: [], manual: {}, links: {}, focus: {}, skips: {} }));
  }, { now: NOW });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof computeDailySummary === 'function' && typeof hasConfirmedEnergyClassification === 'function');
}

// A 60-min confirmed deep block, fully overlapped by a 60-min passive browser
// "waste" observation, plus a scheduled-template "deep" block and a "PC Time"
// context block — all on 2026-09-08.
const MIXED_DAY = () => {
  const base = Date.parse('2026-09-08T09:00:00Z');
  const seeded = [
    { id: 'deep1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'Write RFC', energy: 'deep', retro: true, originalLabel: 'deep' },
    { id: 'br1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'YouTube', energy: 'waste', browserUsage: true, source: 'browser-extension', retro: true, quickLogged: true, originalLabel: 'waste' },
    { id: 'sch1', tsStart: base + 10800000, ts: base + 14400000, blockIntervalMin: 60, date: '2026-09-08', activity: 'Morning writing', energy: 'deep', autoLogged: true, scheduledAutoLog: true, templateId: 't1', originalLabel: 'deep' },
    { id: 'pc1', tsStart: base + 18000000, ts: base + 21600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'PC Time', energy: 'deep', autoLogged: true, quickLogged: true, originalLabel: 'deep' }
  ];
  seeded.forEach(e => { e.category = getBucket(e); });
  entries.length = 0;
  entries.push(...seeded);
  persist();
};

test('Today pulse: passive + scheduled + PC-Time energy is not counted; overlap does not inflate', async ({ page }) => {
  await openApp(page);
  const s = await page.evaluate(({ day, seed }) => { (0, eval)('(' + seed + ')')(); return computeDailySummary(day); },
    { day: DAY, seed: MIXED_DAY.toString() });

  expect(s.totalMin).toBe(60);
  expect(s.deepMin).toBe(60);
  expect(s.wasteMin).toBe(0);
  expect(s.deepPct).toBe(100);
  expect(s.wastePct).toBe(0);
  expect(s.deepPct + s.wastePct).toBeLessThanOrEqual(100);
});

test('Review close-out: deep / waste minutes are confirmed-only', async ({ page }) => {
  await openApp(page);
  const summary = await page.evaluate(({ day, seed }) => { (0, eval)('(' + seed + ')')(); return computeCloseoutSummary(day); },
    { day: DAY, seed: MIXED_DAY.toString() });
  expect(summary.deepMin).toBe(60);
  expect(summary.wasteMin).toBe(0);
});

test('Focus Wallet: passive waste is not penalised, PC-Time / scheduled deep is not rewarded', async ({ page }) => {
  await openApp(page);
  const wallet = await page.evaluate(({ seed }) => { (0, eval)('(' + seed + ')')(); return getCurrentFocusWallet(); },
    { seed: MIXED_DAY.toString() });
  expect(wallet.earned).toBe(6); // only the one confirmed retro deep block: floor(60/5)*0.5 = 6
  expect(wallet.autoCosts).toBe(0);
});

test('weekly honest summary says "No confirmed waste logged" when the only waste is passive', async ({ page }) => {
  await openApp(page);
  const text = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const seeded = [
      { id: 'd', tsStart: base, ts: base + 5400000, blockIntervalMin: 90, date: '2026-09-08', activity: 'Write', energy: 'deep', retro: true, originalLabel: 'deep' },
      { id: 'b', tsStart: base + 7200000, ts: base + 10800000, blockIntervalMin: 60, date: '2026-09-08', activity: 'YouTube', energy: 'waste', phoneUsage: true, retro: true, originalLabel: 'waste' }
    ];
    seeded.forEach(e => { e.category = getBucket(e); });
    entries.length = 0;
    entries.push(...seeded);
    persist();
    renderHonestSummary();
    return document.getElementById('reflect-honest').textContent;
  });
  expect(text).toContain('No confirmed waste logged this week');
  expect(text).not.toContain('clean week');
});

test('static markup no longer carries the retired "Recovered from drift" label', async ({ page }) => {
  await openApp(page);
  const html = await page.content();
  expect(html).not.toContain('Recovered from drift');
});

// ── Today top-level stats (s-deep / s-streak) — Phase 6G.2 targeted fix ────
// computeDailySummary()/computeCloseoutSummary() already applied the confirmed-
// energy boundary; "Deep blocks today" (#s-deep) and "Deep streak days"
// (#s-streak) did not. Assert the actual rendered Today DOM, seeding entries
// on DAY (2026-09-08, which matches the mocked NOW) so today's render reflects
// them directly.
async function seedTodayAndRender(page, seeded) {
  return page.evaluate((seededEntries) => {
    seededEntries.forEach(e => { e.category = getBucket(e); });
    entries.length = 0;
    entries.push(...seededEntries);
    persist();
    _todayRenderKey = '__FORCE__';
    renderToday();
    return {
      deep: document.getElementById('s-deep').textContent,
      streak: document.getElementById('s-streak').textContent
    };
  }, seeded);
}

const baseTs = Date.parse('2026-09-08T09:00:00Z');

test('Today s-deep/s-streak: a scheduled-template deep entry does not qualify either stat', async ({ page }) => {
  await openApp(page);
  const stats = await seedTodayAndRender(page, [
    { id: 'sch1', tsStart: baseTs, ts: baseTs + 3600000, blockIntervalMin: 60, date: DAY, activity: 'Morning writing', energy: 'deep', autoLogged: true, scheduledAutoLog: true, templateId: 't1', originalLabel: 'deep' }
  ]);
  expect(stats.deep).toBe('0');
  expect(stats.streak).toBe('0');
});

test('Today s-deep/s-streak: a browser-passive deep observation does not qualify either stat', async ({ page }) => {
  await openApp(page);
  const stats = await seedTodayAndRender(page, [
    { id: 'br1', tsStart: baseTs, ts: baseTs + 3600000, blockIntervalMin: 60, date: DAY, activity: 'IDE', energy: 'deep', browserUsage: true, source: 'browser-extension', originalLabel: 'deep' }
  ]);
  expect(stats.deep).toBe('0');
  expect(stats.streak).toBe('0');
});

test('Today s-deep/s-streak: an Android phone-usage passive deep observation does not qualify either stat', async ({ page }) => {
  await openApp(page);
  const stats = await seedTodayAndRender(page, [
    { id: 'ph1', tsStart: baseTs, ts: baseTs + 3600000, blockIntervalMin: 60, date: DAY, activity: 'Coding app', energy: 'deep', phoneUsage: true, source: 'phone-usage', originalLabel: 'deep' }
  ]);
  expect(stats.deep).toBe('0');
  expect(stats.streak).toBe('0');
});

test('Today s-deep/s-streak: an auto-logged PC Time deep block does not qualify either stat', async ({ page }) => {
  await openApp(page);
  const stats = await seedTodayAndRender(page, [
    { id: 'pc1', tsStart: baseTs, ts: baseTs + 3600000, blockIntervalMin: 60, date: DAY, activity: 'PC Time', energy: 'deep', autoLogged: true, quickLogged: true, originalLabel: 'deep' }
  ]);
  expect(stats.deep).toBe('0');
  expect(stats.streak).toBe('0');
});

test('Today s-deep/s-streak: a genuine confirmed manual/timer deep block still counts', async ({ page }) => {
  await openApp(page);
  const stats = await seedTodayAndRender(page, [
    { id: 'deep1', tsStart: baseTs, ts: baseTs + 3600000, blockIntervalMin: 60, date: DAY, activity: 'Write RFC', energy: 'deep', retro: true, originalLabel: 'deep' }
  ]);
  expect(stats.deep).toBe('1');
  expect(stats.streak).toBe('1');
});

test('Today s-deep/s-streak: mixed confirmed + unconfirmed evidence — only confirmed contributes', async ({ page }) => {
  await openApp(page);
  const stats = await seedTodayAndRender(page, [
    { id: 'deep1', tsStart: baseTs, ts: baseTs + 3600000, blockIntervalMin: 60, date: DAY, activity: 'Write RFC', energy: 'deep', retro: true, originalLabel: 'deep' },
    { id: 'sch1', tsStart: baseTs + 3600000, ts: baseTs + 7200000, blockIntervalMin: 60, date: DAY, activity: 'Morning writing', energy: 'deep', autoLogged: true, scheduledAutoLog: true, templateId: 't1', originalLabel: 'deep' },
    { id: 'pc1', tsStart: baseTs + 7200000, ts: baseTs + 10800000, blockIntervalMin: 60, date: DAY, activity: 'PC Time', energy: 'deep', autoLogged: true, quickLogged: true, originalLabel: 'deep' }
  ]);
  // Only the one confirmed deep entry counts, regardless of the two unconfirmed ones.
  expect(stats.deep).toBe('1');
  expect(stats.streak).toBe('1');
});

// ── Week share (Low finding, Section 10) — same bounded filter, active copy ─
// buildWeekShareSummary() feeds the user-visible "Share week" export and made
// the same unfiltered-energy claim (PC-Time/scheduled/passive 'deep' counted
// as real deep work). Fixed with the same hasConfirmedEnergyClassification()
// filter already used by computeDailySummary/computeCloseoutSummary/computeStreak.
test('Week share: PC-Time/scheduled deep entries are not counted as deep work', async ({ page }) => {
  await openApp(page);
  const summary = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const seeded = [
      { id: 'pc1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'PC Time', energy: 'deep', autoLogged: true, quickLogged: true, originalLabel: 'deep' },
      { id: 'sch1', tsStart: base + 3600000, ts: base + 7200000, blockIntervalMin: 60, date: '2026-09-08', activity: 'Morning writing', energy: 'deep', autoLogged: true, scheduledAutoLog: true, templateId: 't1', originalLabel: 'deep' }
    ];
    seeded.forEach(e => { e.category = getBucket(e); });
    entries.length = 0;
    entries.push(...seeded);
    persist();
    return getCurrentWeekShareSummary();
  });
  expect(summary.deepMins).toBe(0);
  expect(summary.text).toContain('Deep work: 0m');
});

test('Week share: a genuine confirmed deep block is still counted as deep work', async ({ page }) => {
  await openApp(page);
  const summary = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const seeded = [
      { id: 'deep1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'Write RFC', energy: 'deep', retro: true, originalLabel: 'deep' }
    ];
    seeded.forEach(e => { e.category = getBucket(e); });
    entries.length = 0;
    entries.push(...seeded);
    persist();
    return getCurrentWeekShareSummary();
  });
  expect(summary.deepMins).toBe(60);
});

// ── Time Truth V1 — gap-closing must not trust unverified presence ──────────
// computeGaps() previously treated ANY entry with tsStart+ts as solid coverage,
// including passive browser/phone observation and the native PC-Time ticker —
// neither has an idle/lock/sleep signal, so a period "covered" only by one of
// these could falsely read as "fully accounted for" when the machine may have
// been idle or asleep. Confirmed entries (manual/timer/retro) are unaffected.
test('computeGaps: a span covered only by the PC-Time ticker still shows as an unlogged gap', async ({ page }) => {
  await openApp(page);
  const gaps = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const pcOnly = [
      { id: 'pc1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'PC Time', energy: 'shallow', autoLogged: true, quickLogged: true }
    ];
    return computeGaps(pcOnly, base + 3600000);
  });
  expect(gaps.length).toBe(1);
  expect(gaps[0].isGap).toBe(true);
  expect(gaps[0].gapMin).toBe(60);
});
test('computeGaps: a span covered only by passive browser observation still shows as an unlogged gap', async ({ page }) => {
  await openApp(page);
  const gaps = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const browserOnly = [
      { id: 'br1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'GitHub', energy: 'deep', browserUsage: true, source: 'browser-extension' }
    ];
    return computeGaps(browserOnly, base + 3600000);
  });
  expect(gaps.length).toBe(1);
  expect(gaps[0].isGap).toBe(true);
  expect(gaps[0].gapMin).toBe(60);
});
test('computeGaps: a genuine confirmed entry still closes the gap exactly as before (no regression)', async ({ page }) => {
  await openApp(page);
  const gaps = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const confirmed = [
      { id: 'deep1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'Write RFC', energy: 'deep', retro: true }
    ];
    return computeGaps(confirmed, base + 3600000);
  });
  expect(gaps.length).toBe(0);
});

// ── Time Truth V1 fix-first — OBSERVED vs TIMER label truthfulness ──────────
// Independent review: isUnverifiedPresenceEntry() unions passive observation
// (genuine device/site telemetry) with computer-session context (the native
// PC-Time ticker, which has no idle/lock/activity signal at all). Reusing the
// single "OBSERVED" tag for both implied the ticker was witnessed the way real
// telemetry is. OBSERVED is now reserved for isPassiveObservationEntry; the
// native ticker gets TIMER instead.
test('Timeline: native PC-Time / computer-session entry renders TIMER, not OBSERVED', async ({ page }) => {
  await openApp(page);
  const html = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const pc = { id: 'pc1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'PC Time', energy: 'shallow', autoLogged: true, quickLogged: true };
    return renderTimelineCombined([pc]);
  });
  expect(html).toContain('TIMER');
  expect(html).not.toContain('OBSERVED');
});
test('Timeline: passive browser-extension entry renders OBSERVED, not TIMER', async ({ page }) => {
  await openApp(page);
  const html = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const br = { id: 'br1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'GitHub', energy: 'deep', browserUsage: true, source: 'browser-extension' };
    return renderTimelineCombined([br]);
  });
  expect(html).toContain('OBSERVED');
  expect(html).not.toContain('TIMER');
});
test('Timeline: a nested PC-Time container shows TIMER for its own segment and OBSERVED for a nested browser sub-activity', async ({ page }) => {
  await openApp(page);
  const html = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const sub = { id: 'sub1', tsStart: base + 300000, ts: base + 600000, activity: 'GitHub', browserUsage: true, source: 'browser-extension', energy: 'deep' };
    const container = {
      id: 'pc1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08',
      activity: 'PC Time', energy: 'shallow', autoLogged: true, quickLogged: true,
      _subActivities: [sub]
    };
    return renderEntryRow(container);
  });
  expect(html).toContain('TIMER');
  expect(html).toContain('OBSERVED');
});
test('Timeline: an ordinary confirmed manual entry gets neither TIMER nor OBSERVED', async ({ page }) => {
  await openApp(page);
  const html = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const manual = { id: 'm1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'Write RFC', energy: 'deep', retro: true };
    return renderTimelineCombined([manual]);
  });
  expect(html).not.toContain('OBSERVED');
  expect(html).not.toContain('TIMER');
});

// ── Time Truth V1 fix-first — clearTodayOnly() must use account-timezone-derived
// "today", not the raw stored e.date field (which may have been written under a
// different/fallback timezone). Mirrors the pattern clearSelectedDay() already uses.
test('clearTodayOnly: an entry whose stale .date says today but whose timestamp is yesterday (account tz) is NOT deleted', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(() => {
    // Account timezone is Etc/UTC (see openApp's seeded settings). "Today" is 2026-09-08.
    // This entry's real UTC instant is 2026-09-07 (yesterday), but its stale stored
    // .date field incorrectly claims today.
    const yesterdayTs = Date.parse('2026-09-07T10:00:00Z');
    entries.length = 0;
    entries.push({
      id: 'stale-today', tsStart: yesterdayTs, ts: yesterdayTs + 1800000, blockIntervalMin: 30,
      date: '2026-09-08', activity: 'Stale date says today', energy: 'deep', retro: true
    });
    persist();
    clearTodayOnly();
    return { remaining: entries.length, survivorId: entries[0]?.id };
  });
  expect(result.remaining).toBe(1);
  expect(result.survivorId).toBe('stale-today');
});
test('clearTodayOnly: an entry whose stale .date says yesterday but whose timestamp is today (account tz) IS deleted', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(() => {
    // Real UTC instant is today (2026-09-08); stale stored .date incorrectly claims yesterday.
    const todayTs = Date.parse('2026-09-08T10:00:00Z');
    entries.length = 0;
    entries.push({
      id: 'stale-yesterday', tsStart: todayTs, ts: todayTs + 1800000, blockIntervalMin: 30,
      date: '2026-09-07', activity: 'Stale date says yesterday', energy: 'deep', retro: true
    });
    persist();
    clearTodayOnly();
    return { remaining: entries.length };
  });
  expect(result.remaining).toBe(0);
});

// ════════════════════════════════════════════════════════════════════════
// Timeline Truth Follow-up V1 — three dogfood gaps exposed (not caused) by
// Time Truth V1: (A) Today "So Far" summed raw energy instead of confirmed-
// only, (B1) the gap label overstated "Untracked" when confirmed-only gap
// math can still leave OBSERVED evidence visible, (B2) browser sub-activity
// nesting was generic time-overlap instead of scoped to a real computer-
// session container, (C) editing an existing auto-logged PC-Time entry
// through the plain retro path silently dropped its provenance markers.
// ════════════════════════════════════════════════════════════════════════

// ── Fix A: computeTodayHealth (the "So Far" stat) is confirmed-evidence-only ──
test('computeTodayHealth: passive browser-only entries do not count as deep/waste', async ({ page }) => {
  await openApp(page);
  const health = await page.evaluate(({ day }) => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const seeded = [
      { id: 'fb1', tsStart: base, ts: base + 600000, blockIntervalMin: 10, date: day, activity: 'Facebook', energy: 'waste', browserUsage: true, source: 'browser-extension' },
      { id: 'gm1', tsStart: base + 600000, ts: base + 660000, blockIntervalMin: 1, date: day, activity: 'Gmail', energy: 'shallow', browserUsage: true, source: 'browser-extension' },
      { id: 'fb2', tsStart: base + 660000, ts: base + 960000, blockIntervalMin: 5, date: day, activity: 'Facebook', energy: 'waste', browserUsage: true, source: 'browser-extension' }
    ];
    seeded.forEach(e => { e.category = getBucket(e); });
    entries.length = 0;
    entries.push(...seeded);
    persist();
    return computeTodayHealth(entries, day);
  }, { day: DAY });
  expect(health.deepMin).toBe(0);
  expect(health.wasteMin).toBe(0);
});

test('computeTodayHealth: a confirmed manual entry still counts alongside unconfirmed passive noise', async ({ page }) => {
  await openApp(page);
  const health = await page.evaluate(({ day }) => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const seeded = [
      { id: 'fb1', tsStart: base, ts: base + 600000, blockIntervalMin: 10, date: day, activity: 'Facebook', energy: 'waste', browserUsage: true, source: 'browser-extension' },
      { id: 'confirmed', tsStart: base + 600000, ts: base + 1020000, blockIntervalMin: 7, date: day, activity: 'Doomscrolling', energy: 'waste', retro: true }
    ];
    seeded.forEach(e => { e.category = getBucket(e); });
    entries.length = 0;
    entries.push(...seeded);
    persist();
    return computeTodayHealth(entries, day);
  }, { day: DAY });
  expect(health.deepMin).toBe(0);
  expect(health.wasteMin).toBe(7);
});

// ── Fix B1: gap label says "No confirmed activity", not "Untracked" ──────────
test('Timeline gap row reads "No confirmed activity", not "Untracked"', async ({ page }) => {
  await openApp(page);
  const html = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const gap = { tsStart: base, ts: base + 3600000, gapMin: 60, isGap: true };
    return renderTimelineCombined([gap]);
  });
  expect(html).toContain('No confirmed activity');
  expect(html).not.toContain('Untracked');
});

test('a gap that still has visible OBSERVED evidence nearby keeps both: the gap label and the observed row', async ({ page }) => {
  await openApp(page);
  const html = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    // computeGaps() excludes passive browser observation from closing a gap, so
    // the gap and the observed row can legitimately coexist in the same window.
    const browserOnly = [
      { id: 'br1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'GitHub', energy: 'deep', browserUsage: true, source: 'browser-extension' }
    ];
    const gaps = computeGaps(browserOnly, base + 3600000);
    const combined = [...browserOnly, ...gaps].sort((a, b) => (a.tsStart || a.ts) - (b.tsStart || b.ts));
    return renderTimelineCombined(combined);
  });
  expect(html).toContain('No confirmed activity');
  expect(html).toContain('OBSERVED');
  expect(html).not.toContain('Untracked');
});

// ── Fix B2: browser sub-activity nesting is scoped to real computer-session containers ──
test('assembleTodayTimeline: a genuine PC-Time container nests an overlapping browser observation', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const container = { id: 'pc1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'PC Time', energy: 'shallow', autoLogged: true, quickLogged: true };
    const sub = { id: 'sub1', tsStart: base + 300000, ts: base + 600000, blockIntervalMin: 5, date: '2026-09-08', activity: 'GitHub', browserUsage: true, source: 'browser-extension', energy: 'deep' };
    entries.length = 0;
    [container, sub].forEach(e => { e.category = getBucket(e); entries.push(e); });
    persist();
    const combined = assembleTodayTimeline(entries);
    return { ids: combined.map(i => i.id), pcSubCount: (combined.find(i => i.id === 'pc1') || {})._subActivities?.length || 0 };
  });
  expect(result.pcSubCount).toBe(1);
  expect(result.ids).not.toContain('sub1'); // absorbed as a nested sub-row, not a top-level item
});

test('assembleTodayTimeline: an ordinary manual task does NOT absorb an overlapping browser observation', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const manualTask = { id: 'task1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'Write RFC', energy: 'deep', retro: true };
    const sub = { id: 'sub1', tsStart: base + 300000, ts: base + 600000, blockIntervalMin: 5, date: '2026-09-08', activity: 'GitHub', browserUsage: true, source: 'browser-extension', energy: 'deep' };
    entries.length = 0;
    [manualTask, sub].forEach(e => { e.category = getBucket(e); entries.push(e); });
    persist();
    const combined = assembleTodayTimeline(entries);
    return { ids: combined.map(i => i.id), taskSubCount: (combined.find(i => i.id === 'task1') || {})._subActivities?.length || 0 };
  });
  expect(result.taskSubCount).toBe(0);
  expect(result.ids).toContain('sub1'); // stays its own top-level row, never relabeled "PC time · <site>"
});

// ── Fix C: editing an existing auto-logged entry preserves computer-session provenance ──
test('editing an existing auto-generated PC-Time entry through the normal edit path keeps it a computer-session entry', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const pcEntry = { id: 'pc1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'PC Time', energy: 'shallow', autoLogged: true, quickLogged: true };
    pcEntry.category = getBucket(pcEntry);
    entries.length = 0;
    entries.push(pcEntry);
    persist();

    openEditEntry('pc1');
    // Ordinary edit through the same production path: nudge the end time later.
    document.getElementById('retro-start').value = '09:00';
    document.getElementById('retro-end').value = '09:45';
    saveRetroEntry();

    const updated = entries.find(e => e.activity === 'PC Time');
    return { isSession: isComputerSessionEntry(updated), autoLogged: updated.autoLogged, quickLogged: updated.quickLogged };
  });
  expect(result.isSession).toBe(true);
  expect(result.autoLogged).toBe(true);
  expect(result.quickLogged).toBe(true);
});

test('editing an ordinary manual entry named "PC Time" does not manufacture computer-session provenance', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const manualEntry = { id: 'manual-pc', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'PC Time', energy: 'shallow', retro: true };
    manualEntry.category = getBucket(manualEntry);
    entries.length = 0;
    entries.push(manualEntry);
    persist();

    openEditEntry('manual-pc');
    document.getElementById('retro-start').value = '09:00';
    document.getElementById('retro-end').value = '09:45';
    saveRetroEntry();

    const updated = entries.find(e => e.activity === 'PC Time');
    return { isSession: isComputerSessionEntry(updated), autoLogged: !!updated.autoLogged, quickLogged: !!updated.quickLogged };
  });
  expect(result.isSession).toBe(false);
  expect(result.autoLogged).toBe(false);
  expect(result.quickLogged).toBe(false);
});

// ── Fix First (independent review): the midnight-split branch of the same edit path ──
// must preserve computer-session provenance on BOTH resulting entries, not just the
// pre-midnight part. secondPart previously came out of makeEntry() with no autoLogged/
// quickLogged at all, so the post-midnight half silently lost its TIMER identity.
test('editing an existing auto-generated PC-Time entry across midnight preserves provenance on BOTH split parts', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const pcEntry = { id: 'pc1', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'PC Time', energy: 'shallow', autoLogged: true, quickLogged: true };
    pcEntry.category = getBucket(pcEntry);
    entries.length = 0;
    entries.push(pcEntry);
    persist();

    openEditEntry('pc1');
    // Normal production edit, retimed to cross midnight (23:30 -> 00:30 next day).
    document.getElementById('retro-start').value = '23:30';
    document.getElementById('retro-end').value = '00:30';
    saveRetroEntry();

    const pcParts = entries.filter(e => e.activity === 'PC Time').sort((a, b) => a.tsStart - b.tsStart);
    return {
      count: pcParts.length,
      parts: pcParts.map(e => ({
        date: e.date,
        isSession: isComputerSessionEntry(e),
        autoLogged: e.autoLogged,
        quickLogged: e.quickLogged
      }))
    };
  });
  expect(result.count).toBe(2);
  expect(result.parts[0].date).toBe('2026-09-08');
  expect(result.parts[1].date).toBe('2026-09-09');
  for (const part of result.parts) {
    expect(part.isSession).toBe(true);
    expect(part.autoLogged).toBe(true);
    expect(part.quickLogged).toBe(true);
  }
});

// Negative control: a manual entry merely named "PC Time" (no provenance markers)
// edited across midnight must not gain autoLogged/quickLogged on either split part —
// text identity alone must never manufacture provenance.
test('editing a manual entry named "PC Time" across midnight does not manufacture provenance on either split part', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(() => {
    const base = Date.parse('2026-09-08T09:00:00Z');
    const manualEntry = { id: 'manual-pc', tsStart: base, ts: base + 3600000, blockIntervalMin: 60, date: '2026-09-08', activity: 'PC Time', energy: 'shallow', retro: true };
    manualEntry.category = getBucket(manualEntry);
    entries.length = 0;
    entries.push(manualEntry);
    persist();

    openEditEntry('manual-pc');
    document.getElementById('retro-start').value = '23:30';
    document.getElementById('retro-end').value = '00:30';
    saveRetroEntry();

    const pcParts = entries.filter(e => e.activity === 'PC Time').sort((a, b) => a.tsStart - b.tsStart);
    return {
      count: pcParts.length,
      parts: pcParts.map(e => ({
        isSession: isComputerSessionEntry(e),
        autoLogged: !!e.autoLogged,
        quickLogged: !!e.quickLogged
      }))
    };
  });
  expect(result.count).toBe(2);
  for (const part of result.parts) {
    expect(part.isSession).toBe(false);
    expect(part.autoLogged).toBe(false);
    expect(part.quickLogged).toBe(false);
  }
});
