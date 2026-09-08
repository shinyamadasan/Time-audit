// ══════════════════════════════════════════════════════
// Regression + chaos coverage for the Focus reload-recovery bug:
// an active Focus (Pomodoro) session was never persisted anywhere, so a
// browser reload silently dropped it — no restored session, no fabricated
// new one either (just gone). See focus-mode.js's persistFocusSession() /
// restoreFocusSession() and the ta3-focus-timer storage key.
//
// These tests drive the REAL app (real index.html, real focus-mode.js,
// real storage.js, a real Chromium page.reload()) rather than hand-poking
// globals — the only stubbing is Firebase (network) and <audio>.play().
// ══════════════════════════════════════════════════════
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';

test.beforeAll(async () => {
  appServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = path.resolve(APP_ROOT, `.${decodeURIComponent(pathname)}`);
      if (!filePath.startsWith(APP_ROOT)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      const contentType = ext === '.html' ? 'text/html'
        : ext === '.js' ? 'application/javascript'
          : ext === '.css' ? 'text/css'
            : 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${appServer.address().port}/index.html`;
});

test.afterAll(async () => {
  if (appServer) await new Promise(resolve => appServer.close(resolve));
});

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const makeRef = refPath => ({
    path: refPath,
    child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) { if (eventName === 'value') setTimeout(() => cb(snapshot(null)), 0); return cb; },
    off() {},
    once() { return Promise.resolve(snapshot(null)); },
    update() { return Promise.resolve(); },
    set() { return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    push(value) {
      const pushed = makeRef(refPath + '/pushed');
      pushed.key = 'pushed';
      if (value !== undefined) pushed.set(value);
      return pushed;
    },
    onDisconnect() { return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }; }
  });
  const auth = () => ({
    onAuthStateChanged(cb) {
      setTimeout(() => cb({ uid: 'reload-test-user', displayName: 'Reload Test', email: 'reload@example.test', photoURL: '' }), 0);
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

function baseSettings() {
  return {
    hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10,
    presets: [], timezone: 'UTC', activityColors: {}, coachTone: 'analyst',
    reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00',
    sleepReminderMin: 30, sleepSetupDone: true, templates: []
  };
}

// Registered via addInitScript so it exists before ANY page script runs —
// including on reload. Lets tests observe what pushHudFocusState() actually
// sent to the (otherwise unreachable, real-network) Windows HUD companion.
const testHooksInit = `
window.__hudPushes = [];
const __realFetch = window.fetch ? window.fetch.bind(window) : null;
window.fetch = (url, opts) => {
  if (String(url).includes('127.0.0.1:51739')) {
    try { window.__hudPushes.push(JSON.parse((opts && opts.body) || '{}')); } catch {}
    return Promise.resolve(new Response('{}', { status: 200 }));
  }
  return __realFetch ? __realFetch(url, opts) : Promise.reject(new Error('no fetch in this test'));
};
`;

async function openApp(page) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: firebaseStub
  }));
  await page.addInitScript(testHooksInit);
  // Guarded so this only seeds once per test — addInitScript re-runs on
  // EVERY navigation, including page.reload(), and an unconditional
  // localStorage.clear() here would wipe the very persisted Focus session
  // these tests reload to observe, before the app's own scripts ever see it.
  await page.addInitScript(({ settings }) => {
    if (localStorage.getItem('ta3-focus-reload-test-seeded')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', 'UTC');
    localStorage.setItem('ta3-settings', JSON.stringify(settings));
    localStorage.setItem('ta3-entries', '[]');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-plans', '{}');
    localStorage.setItem('ta3-reviews', '{}');
    localStorage.setItem('ta3-focus-reload-test-seeded', '1');
  }, { settings: baseSettings() });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.enterFocusMode === 'function' && typeof window.restoreFocusSession === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

// Starts a real Focus work session through the real UI-adjacent globals
// (enterFocusMode + startPomodoro), exactly as a click on "Start" would.
async function startFocusSession(page, task) {
  return page.evaluate((task) => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    enterFocusMode();
    document.getElementById('focus-task-input').value = task;
    startPomodoro();
    return { pomodoroPhaseStartedAt, pomodoroPhase, currentTask, pomodoroWorkMin, pomodoroBreakMin };
  }, task);
}

function readFocusState(page) {
  return page.evaluate(() => ({
    pomodoroPhase, pomodoroPhaseStartedAt, currentTask, pomodoroWorkMin, pomodoroBreakMin,
    entriesCount: entries.length,
    overlayOpen: document.getElementById('focus-overlay').classList.contains('open'),
    phaseLabel: document.getElementById('focus-phase-label').textContent,
    persisted: localStorage.getItem('ta3-focus-timer')
  }));
}

test.describe('Focus reload recovery', () => {

  test('regression: active work-phase session is restored after a real reload with the same identity, no duplicate, HUD updated', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Reload recovery test');
    expect(before.pomodoroPhase).toBe('work');
    expect(before.currentTask).toBe('Reload recovery test');

    // Simulate 6 minutes of real elapsed time before the user reloads.
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 6 * 60 * 1000);
    await page.reload();

    const after = await readFocusState(page);
    expect(after.pomodoroPhase).toBe('work');
    expect(after.pomodoroPhaseStartedAt).toBe(before.pomodoroPhaseStartedAt); // exact — never reset to reload time
    expect(after.currentTask).toBe('Reload recovery test');
    expect(after.overlayOpen).toBe(true);
    expect(after.entriesCount).toBe(0); // still running — no receipt yet, and no duplicate

    const remaining = await page.evaluate(() => pomodoroRemaining);
    expect(remaining).toBeGreaterThan(1130);
    expect(remaining).toBeLessThanOrEqual(1140); // 1500s - 360s elapsed

    const hudPush = await page.evaluate(() => window.__hudPushes.at(-1));
    expect(hudPush).toMatchObject({ type: 'focus-active', title: 'Reload recovery test', phase: 'work' });
    expect(hudPush.startedAt).toBe(before.pomodoroPhaseStartedAt);
  });

  test('chaos 1: active work phase -> reload -> same work session restored', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Work phase reload');
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 60 * 1000);
    await page.reload();
    const after = await readFocusState(page);
    expect(after).toMatchObject({ pomodoroPhase: 'work', currentTask: 'Work phase reload', entriesCount: 0 });
    expect(after.pomodoroPhaseStartedAt).toBe(before.pomodoroPhaseStartedAt);
  });

  test('chaos 2: active break phase -> reload -> same break restored, no duplicate work entry', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Break phase reload');
    // Force the work phase to its natural end (established pattern already used
    // elsewhere in this suite for deterministic phase transitions).
    const breakStartedAt = await page.evaluate(() => {
      focusStartTime = pomodoroPhaseStartedAt - 25 * 60 * 1000; // pretend it ran the full 25 min
      endWorkSession();
      return pomodoroPhaseStartedAt;
    });
    let mid = await readFocusState(page);
    expect(mid.pomodoroPhase).toBe('break');
    expect(mid.entriesCount).toBe(1);

    await page.clock.setFixedTime(breakStartedAt + 2 * 60 * 1000); // 2 of 5 break minutes in
    await page.reload();

    const after = await readFocusState(page);
    expect(after.pomodoroPhase).toBe('break');
    expect(after.pomodoroPhaseStartedAt).toBe(breakStartedAt);
    expect(after.entriesCount).toBe(1); // the one work entry — break restore must not add another
    expect(after.overlayOpen).toBe(true);
    const remaining = await page.evaluate(() => pomodoroRemaining);
    expect(remaining).toBeGreaterThan(170);
    expect(remaining).toBeLessThanOrEqual(180); // 300s - 120s elapsed
  });

  test('chaos 3: reloading multiple times in a row still leaves exactly one session, no duplicates', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Multi-reload guard');
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 30 * 1000);
    await page.reload();
    await page.reload();
    await page.reload();
    const after = await readFocusState(page);
    expect(after.pomodoroPhase).toBe('work');
    expect(after.pomodoroPhaseStartedAt).toBe(before.pomodoroPhaseStartedAt);
    expect(after.entriesCount).toBe(0);
  });

  test('chaos 4: reload after the planned work duration already elapsed applies the transition once, not twice', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Overrun work reload');
    // 25-minute work session; reload 5 seconds past its planned end.
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 25 * 60 * 1000 + 5000);
    await page.reload();

    const afterFirst = await readFocusState(page);
    expect(afterFirst.pomodoroPhase).toBe('break'); // transitioned exactly once
    expect(afterFirst.entriesCount).toBe(1);
    const entry = await page.evaluate(() => entries.find(e => e.activity === 'Overrun work reload'));
    expect(entry.tsStart).toBe(before.pomodoroPhaseStartedAt); // original startedAt preserved on the receipt
    expect(entry.blockIntervalMin).toBe(25);

    // Reload again while still mid-break: must not re-log or re-transition.
    await page.reload();
    const afterSecond = await readFocusState(page);
    expect(afterSecond.pomodoroPhase).toBe('break');
    expect(afterSecond.entriesCount).toBe(1);
  });

  test('chaos 5: reload after the break already elapsed returns to idle exactly once, without fabricating a new session', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Overrun break reload');
    const breakStartedAt = await page.evaluate(() => {
      focusStartTime = pomodoroPhaseStartedAt - 25 * 60 * 1000;
      endWorkSession();
      return pomodoroPhaseStartedAt;
    });
    await page.clock.setFixedTime(breakStartedAt + 5 * 60 * 1000 + 5000); // 5s past the 5-min break
    await page.reload();

    const after = await readFocusState(page);
    expect(after.pomodoroPhase).toBe('idle'); // existing endPomodoroBreak() semantics, applied once
    expect(after.entriesCount).toBe(1); // only the original work entry — break itself never logs
    expect(after.persisted).toBeNull(); // cleared, nothing left to re-restore on a further reload

    await page.reload();
    const afterAgain = await readFocusState(page);
    expect(afterAgain.pomodoroPhase).toBe('idle');
    expect(afterAgain.entriesCount).toBe(1); // still not fabricated a second time
  });

  test('chaos 6: no active Focus -> reload -> does not fabricate a session', async ({ page }) => {
    await openApp(page);
    await page.reload();
    const after = await readFocusState(page);
    expect(after.pomodoroPhase).toBe('idle');
    expect(after.overlayOpen).toBe(false);
    expect(after.entriesCount).toBe(0);
    expect(after.persisted).toBeNull();
  });

  test('chaos 7: corrupt or incomplete persisted Focus state fails safely and never fabricates a session', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => localStorage.setItem('ta3-focus-timer', 'not valid json {{'));
    await page.reload();
    let after = await readFocusState(page);
    expect(after.pomodoroPhase).toBe('idle');
    expect(after.overlayOpen).toBe(false);
    expect(after.persisted).toBeNull(); // corrupt record discarded rather than left to break the next load

    await page.evaluate(() => localStorage.setItem('ta3-focus-timer', JSON.stringify({ pomodoroPhase: 'work' })));
    await page.reload();
    after = await readFocusState(page);
    expect(after.pomodoroPhase).toBe('idle');
    expect(after.overlayOpen).toBe(false);
    expect(after.entriesCount).toBe(0);
  });

  test('chaos 8: a restored locally-owned session keeps ownership against a genuinely stale remote update after reload', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Owned across reload');
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 30 * 1000);
    await page.reload();

    const result = await page.evaluate((beforeStartedAt) => {
      const applied = applyRemoteTimerState({
        running: true,
        mode: 'focus',
        lastTask: 'Someone elses task',
        intervalSecs: 1800,
        // Older than this device's own last known sync history (recorded
        // when the session originally started) — genuinely stale, not a
        // plausible later takeover.
        startedAt: beforeStartedAt - 5000,
        updatedBy: 'some-other-device-id',
        ownerDeviceId: 'some-other-device-id'
      });
      return { applied, pomodoroPhase, currentTask, timerOwnerDeviceId, syncedDeviceId };
    }, before.pomodoroPhaseStartedAt);
    // Reload-restore reconciliation window (storage.js applyRemoteTimerState,
    // restoredFocusAwaitingSyncReconciliation): a remote update from another
    // device is only allowed to win if it is demonstrably newer than this
    // device's own last known sync history. This update predates that
    // history, so — exactly like an ordinary conflicting update without a
    // takeover flag — it stays rejected and local ownership is kept.
    expect(result.applied).toBe(false);
    expect(result.pomodoroPhase).toBe('work');
    expect(result.currentTask).toBe('Owned across reload');
    expect(result.timerOwnerDeviceId).toBe(result.syncedDeviceId);
  });

  // ══════════════════════════════════════════════════════
  // Multi-device reconciliation after reload (High finding fix):
  // restoreFocusSession() sets restoredFocusAwaitingSyncReconciliation so a
  // reload-restored session's ownership claim is provisional for exactly one
  // incoming remote timer snapshot — letting a takeover that legitimately
  // completed while this device was away win, while still rejecting a
  // genuinely stale/older remote echo. See storage.js applyRemoteTimerState().
  // ══════════════════════════════════════════════════════

  test('reconciliation: a NEWER legitimate remote takeover wins over a restored session, updates the UI, clears the persisted claim, and is not permanently rejected afterward', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Device A session');
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 30 * 1000);
    await page.reload();

    // Confirm A is in the provisional/awaiting-reconciliation state right
    // after restore, before any remote message has been seen.
    const awaiting = await page.evaluate(() => restoredFocusAwaitingSyncReconciliation);
    expect(awaiting).toBe(true);

    // Device B legitimately took over while A was away — demonstrably newer
    // than A's own last known sync history (recorded when A's session
    // originally started, via the real syncFocusTimerState() push).
    const first = await page.evaluate((beforeStartedAt) => {
      const applied = applyRemoteTimerState({
        running: true,
        mode: 'focus',
        focusPhase: 'work',
        lastTask: 'Device B takeover',
        intervalSecs: 25 * 60,
        startedAt: beforeStartedAt + 5 * 60 * 1000,
        updatedAt: beforeStartedAt + 5 * 60 * 1000,
        updatedBy: 'device-b',
        ownerDeviceId: 'device-b',
        deviceName: 'Device B'
      });
      return {
        applied,
        awaitingAfter: restoredFocusAwaitingSyncReconciliation,
        pomodoroPhase,
        timerOwnerDeviceId,
        syncedFocusOwner: syncedFocusTimer?.ownerDeviceId,
        persisted: localStorage.getItem('ta3-focus-timer')
      };
    }, before.pomodoroPhaseStartedAt);

    expect(first.applied).toBe(true); // B wins
    expect(first.awaitingAfter).toBe(false); // consumed exactly once
    expect(first.timerOwnerDeviceId).toBe('device-b');
    expect(first.syncedFocusOwner).toBe('device-b'); // A's local Focus UI now mirrors B
    expect(first.persisted).toBeNull(); // A's stale claim cleared — a later reload can't resurrect it

    await expect(page.locator('#focus-phase-sub')).toContainText('Device B');

    // A does not permanently reject B going forward: a further consistent
    // update from B is accepted via ordinary (non-reconciliation) logic —
    // ownership has genuinely moved, not just been waived once.
    const second = await page.evaluate((beforeStartedAt) => applyRemoteTimerState({
      running: true,
      mode: 'focus',
      focusPhase: 'work',
      lastTask: 'Device B takeover',
      intervalSecs: 25 * 60,
      startedAt: beforeStartedAt + 5 * 60 * 1000,
      updatedAt: beforeStartedAt + 6 * 60 * 1000,
      updatedBy: 'device-b',
      ownerDeviceId: 'device-b',
      deviceName: 'Device B'
    }), before.pomodoroPhaseStartedAt);
    expect(second).toBe(true);
  });

  test('reconciliation: after B wins, a further reload of A does not resurrect A\'s stale session from persisted storage', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Device A resurrect check');
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 30 * 1000);
    await page.reload();

    const persistedAfterWin = await page.evaluate((beforeStartedAt) => {
      applyRemoteTimerState({
        running: true,
        mode: 'focus',
        focusPhase: 'work',
        lastTask: 'Device B takeover',
        intervalSecs: 25 * 60,
        startedAt: beforeStartedAt + 5 * 60 * 1000,
        updatedAt: beforeStartedAt + 5 * 60 * 1000,
        updatedBy: 'device-b',
        ownerDeviceId: 'device-b'
      });
      return localStorage.getItem('ta3-focus-timer');
    }, before.pomodoroPhaseStartedAt);
    expect(persistedAfterWin).toBeNull();

    // Second reload: nothing persisted to restore, and this test's Firebase
    // stub always reports null on (re)connect, so B's mirror is not
    // re-delivered either — A's own old session must not come back from
    // localStorage on its own.
    await page.reload();
    const after = await readFocusState(page);
    expect(after.pomodoroPhase).toBe('idle');
    expect(after.overlayOpen).toBe(false);
    expect(after.currentTask).not.toBe('Device A resurrect check');
    expect(after.persisted).toBeNull();
  });

  test('reconciliation: a genuinely OLDER remote update from a different owner is rejected once, and a further stale update afterward is rejected via ordinary logic (not re-entering reconciliation)', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Device A session 2');
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 30 * 1000);
    await page.reload();

    const awaiting = await page.evaluate(() => restoredFocusAwaitingSyncReconciliation);
    expect(awaiting).toBe(true);

    const first = await page.evaluate((beforeStartedAt) => {
      const applied = applyRemoteTimerState({
        running: true,
        mode: 'focus',
        focusPhase: 'work',
        lastTask: 'Stale device B echo',
        intervalSecs: 25 * 60,
        startedAt: beforeStartedAt - 60 * 1000,
        updatedAt: beforeStartedAt - 60 * 1000,
        updatedBy: 'device-b',
        ownerDeviceId: 'device-b'
      });
      return {
        applied,
        awaitingAfter: restoredFocusAwaitingSyncReconciliation,
        pomodoroPhase, timerOwnerDeviceId, syncedDeviceId
      };
    }, before.pomodoroPhaseStartedAt);
    expect(first.applied).toBe(false); // A keeps its restored session
    expect(first.awaitingAfter).toBe(false); // reconciliation resolved — consumed exactly once
    expect(first.pomodoroPhase).toBe('work');
    expect(first.timerOwnerDeviceId).toBe(first.syncedDeviceId);

    // A second stale update from B afterward must be rejected via ordinary
    // (non-reconciliation) ownership logic — not by re-entering a "first
    // snapshot" special case.
    const second = await page.evaluate((beforeStartedAt) => applyRemoteTimerState({
      running: true,
      mode: 'focus',
      focusPhase: 'work',
      lastTask: 'Stale device B echo again',
      intervalSecs: 25 * 60,
      startedAt: beforeStartedAt - 30 * 1000,
      updatedAt: beforeStartedAt - 30 * 1000,
      updatedBy: 'device-b',
      ownerDeviceId: 'device-b'
    }), before.pomodoroPhaseStartedAt);
    expect(second).toBe(false);

    const after = await page.evaluate(() => ({ pomodoroPhase, timerOwnerDeviceId, syncedDeviceId, currentTask }));
    expect(after.pomodoroPhase).toBe('work');
    expect(after.timerOwnerDeviceId).toBe(after.syncedDeviceId);
    expect(after.currentTask).toBe('Device A session 2');
  });

  // ══════════════════════════════════════════════════════
  // Same-owner echo does not close the window (Medium finding, round 3):
  // restoreFocusSession() performs its own outbound syncFocusTimerState()
  // push, which can echo straight back through the already-attached
  // Firebase listener as the first snapshot applyRemoteTimerState() sees.
  // That echo is not a different device and proves nothing about whether a
  // takeover happened while this device was away — closing the window on it
  // would let a later genuinely-stale conflicting snapshot slip through
  // unevaluated. See the sameOwnerEcho branch in applyRemoteTimerState().
  // ══════════════════════════════════════════════════════

  test('reconciliation: a SAME-OWNER echo leaves the reconciliation window open (flag and baseline untouched)', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Echo does not close window');
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 30 * 1000);
    await page.reload();

    const baselineBefore = await page.evaluate(() => restoredFocusBaselineSyncStamp);
    expect(baselineBefore).toBeGreaterThan(0);
    expect(await page.evaluate(() => restoredFocusAwaitingSyncReconciliation)).toBe(true);

    // Simulate restoreFocusSession()'s own outbound push echoing straight
    // back through the already-attached listener — same device, no takeover.
    const result = await page.evaluate(() => {
      applyRemoteTimerState({
        running: true,
        mode: 'focus',
        focusPhase: 'work',
        lastTask: 'Echo does not close window',
        intervalSecs: 25 * 60,
        startedAt: pomodoroPhaseStartedAt,
        updatedAt: Date.now(),
        updatedBy: syncedDeviceId,
        ownerDeviceId: syncedDeviceId
      });
      return {
        awaitingAfter: restoredFocusAwaitingSyncReconciliation,
        baselineAfter: restoredFocusBaselineSyncStamp
      };
    });

    expect(result.awaitingAfter).toBe(true); // window still open — echo is not a reconciliation signal
    expect(result.baselineAfter).toBe(baselineBefore); // untouched
  });

  test('reconciliation: a SAME-OWNER echo followed by a genuinely NEWER different-owner takeover still lets B win', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Echo then B wins');
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 30 * 1000);
    await page.reload();

    await page.evaluate(() => applyRemoteTimerState({
      running: true,
      mode: 'focus',
      focusPhase: 'work',
      lastTask: 'Echo then B wins',
      intervalSecs: 25 * 60,
      startedAt: pomodoroPhaseStartedAt,
      updatedAt: Date.now(),
      updatedBy: syncedDeviceId,
      ownerDeviceId: syncedDeviceId
    }));
    expect(await page.evaluate(() => restoredFocusAwaitingSyncReconciliation)).toBe(true); // still open after the echo

    // Device B's genuinely newer takeover arrives next.
    const result = await page.evaluate((beforeStartedAt) => {
      const applied = applyRemoteTimerState({
        running: true,
        mode: 'focus',
        focusPhase: 'work',
        lastTask: 'Device B after echo',
        intervalSecs: 25 * 60,
        startedAt: beforeStartedAt + 5 * 60 * 1000,
        updatedAt: beforeStartedAt + 5 * 60 * 1000,
        updatedBy: 'device-b',
        ownerDeviceId: 'device-b',
        deviceName: 'Device B'
      });
      return {
        applied,
        awaitingAfter: restoredFocusAwaitingSyncReconciliation,
        timerOwnerDeviceId,
        persisted: localStorage.getItem('ta3-focus-timer')
      };
    }, before.pomodoroPhaseStartedAt);

    expect(result.applied).toBe(true); // B wins — the window was still open for it to be evaluated
    expect(result.awaitingAfter).toBe(false); // now consumed by the genuine conflict
    expect(result.timerOwnerDeviceId).toBe('device-b');
    expect(result.persisted).toBeNull(); // A's stale claim cleared

    await expect(page.locator('#focus-phase-sub')).toContainText('Device B');

    // A further reload of A must not resurrect the stale session (same
    // pattern as the existing "after B wins" reload test above).
    await page.reload();
    const after = await readFocusState(page);
    expect(after.pomodoroPhase).toBe('idle');
    expect(after.persisted).toBeNull();
  });

  test('reconciliation: a SAME-OWNER echo followed by a genuinely OLDER different-owner update is rejected, closing the window normally (no re-entry on a further stale update)', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Echo then stale B rejected');
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 30 * 1000);
    await page.reload();

    await page.evaluate(() => applyRemoteTimerState({
      running: true,
      mode: 'focus',
      focusPhase: 'work',
      lastTask: 'Echo then stale B rejected',
      intervalSecs: 25 * 60,
      startedAt: pomodoroPhaseStartedAt,
      updatedAt: Date.now(),
      updatedBy: syncedDeviceId,
      ownerDeviceId: syncedDeviceId
    }));
    expect(await page.evaluate(() => restoredFocusAwaitingSyncReconciliation)).toBe(true); // still open after the echo

    const first = await page.evaluate((beforeStartedAt) => {
      const applied = applyRemoteTimerState({
        running: true,
        mode: 'focus',
        focusPhase: 'work',
        lastTask: 'Stale B after echo',
        intervalSecs: 25 * 60,
        startedAt: beforeStartedAt - 60 * 1000,
        updatedAt: beforeStartedAt - 60 * 1000,
        updatedBy: 'device-b',
        ownerDeviceId: 'device-b'
      });
      return {
        applied,
        awaitingAfter: restoredFocusAwaitingSyncReconciliation,
        pomodoroPhase, timerOwnerDeviceId, syncedDeviceId
      };
    }, before.pomodoroPhaseStartedAt);
    expect(first.applied).toBe(false); // A keeps its restored session — B predates A's known history
    expect(first.awaitingAfter).toBe(false); // window closed on this genuinely conflicting snapshot
    expect(first.pomodoroPhase).toBe('work');
    expect(first.timerOwnerDeviceId).toBe(first.syncedDeviceId);

    // A further stale update from B afterward is rejected via ordinary
    // (non-reconciliation) logic — not by re-entering a "first snapshot"
    // special case, and not re-evaluating the already-resolved snapshot.
    const second = await page.evaluate((beforeStartedAt) => applyRemoteTimerState({
      running: true,
      mode: 'focus',
      focusPhase: 'work',
      lastTask: 'Stale B again',
      intervalSecs: 25 * 60,
      startedAt: beforeStartedAt - 30 * 1000,
      updatedAt: beforeStartedAt - 30 * 1000,
      updatedBy: 'device-b',
      ownerDeviceId: 'device-b'
    }), before.pomodoroPhaseStartedAt);
    expect(second).toBe(false);

    const after = await page.evaluate(() => ({ pomodoroPhase, timerOwnerDeviceId, syncedDeviceId, currentTask }));
    expect(after.pomodoroPhase).toBe('work');
    expect(after.timerOwnerDeviceId).toBe(after.syncedDeviceId);
    expect(after.currentTask).toBe('Echo then stale B rejected');
  });

  test('reconciliation: a freshly-started (never reload-restored) Focus session keeps unmodified ownership protection even against a newer-timestamped conflicting update', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Fresh session, never restored');
    // Deliberately no reload here — this is the pre-existing, non-restore
    // path, which restoredFocusAwaitingSyncReconciliation must never affect.
    const result = await page.evaluate((beforeStartedAt) => {
      const applied = applyRemoteTimerState({
        running: true,
        mode: 'focus',
        focusPhase: 'work',
        lastTask: 'Someone elses task',
        intervalSecs: 1800,
        // Even a NEWER timestamp than this device's own history must not
        // matter outside the reload-restore reconciliation window.
        startedAt: beforeStartedAt + 5 * 60 * 1000,
        updatedAt: beforeStartedAt + 5 * 60 * 1000,
        updatedBy: 'some-other-device-id',
        ownerDeviceId: 'some-other-device-id'
      });
      return {
        applied,
        awaiting: restoredFocusAwaitingSyncReconciliation,
        pomodoroPhase, currentTask, timerOwnerDeviceId, syncedDeviceId
      };
    }, before.pomodoroPhaseStartedAt);
    expect(result.awaiting).toBe(false); // never set for a session that was never restored
    expect(result.applied).toBe(false);
    expect(result.pomodoroPhase).toBe('work');
    expect(result.currentTask).toBe('Fresh session, never restored');
    expect(result.timerOwnerDeviceId).toBe(result.syncedDeviceId);
  });

  // ══════════════════════════════════════════════════════
  // Reconciliation is Focus-only (High finding, round 4): the reconciliation
  // window exists to answer "did a Focus takeover happen while this device
  // was away?" — a conflicting-owner snapshot that isn't itself a Focus
  // snapshot (data.mode !== 'focus', e.g. another device's ordinary
  // ping/interval timer) can't answer that question, so it must not be
  // allowed to win the restored Focus session, and must not consume the
  // window pending a real Focus takeover. See conflictingFocusOwner /
  // nonFocusConflictDuringWindow in storage.js applyRemoteTimerState().
  // ══════════════════════════════════════════════════════

  test('reconciliation: a newer GENERIC (non-Focus) remote timer during the window is rejected and does not consume it, even repeatedly', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Generic B cannot win Focus');
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 30 * 1000);
    await page.reload();

    const baselineBefore = await page.evaluate(() => restoredFocusBaselineSyncStamp);
    expect(await page.evaluate(() => restoredFocusAwaitingSyncReconciliation)).toBe(true);

    // Device B started an ordinary (non-Focus) ping/interval timer, newer
    // than A's own last known sync history — no `mode` at all, exactly like
    // a real generic syncTimerState() push.
    const first = await page.evaluate((beforeStartedAt) => {
      const applied = applyRemoteTimerState({
        running: true,
        lastTask: 'Generic ping timer',
        intervalSecs: 1800,
        startedAt: beforeStartedAt + 5 * 60 * 1000,
        updatedAt: beforeStartedAt + 5 * 60 * 1000,
        updatedBy: 'device-b',
        ownerDeviceId: 'device-b'
      });
      return {
        applied,
        awaitingAfter: restoredFocusAwaitingSyncReconciliation,
        baselineAfter: restoredFocusBaselineSyncStamp,
        pomodoroPhase, currentTask, timerOwnerDeviceId, syncedDeviceId,
        persisted: localStorage.getItem('ta3-focus-timer')
      };
    }, before.pomodoroPhaseStartedAt);

    expect(first.applied).toBe(false); // generic B cannot win Focus ownership
    expect(first.pomodoroPhase).toBe('work'); // A's restored Focus is untouched
    expect(first.currentTask).toBe('Generic B cannot win Focus');
    expect(first.timerOwnerDeviceId).toBe(first.syncedDeviceId);
    expect(first.persisted).not.toBeNull(); // ta3-focus-timer still exists
    expect(first.awaitingAfter).toBe(true); // window still open — not consumed
    expect(first.baselineAfter).toBe(baselineBefore); // untouched

    // A second, later generic update from B must not consume the window
    // either — it keeps being treated the same way until a genuine Focus
    // snapshot arrives or the session ends.
    const second = await page.evaluate((beforeStartedAt) => {
      const applied = applyRemoteTimerState({
        running: true,
        lastTask: 'Generic ping timer again',
        intervalSecs: 1800,
        startedAt: beforeStartedAt + 6 * 60 * 1000,
        updatedAt: beforeStartedAt + 6 * 60 * 1000,
        updatedBy: 'device-b',
        ownerDeviceId: 'device-b'
      });
      return {
        applied,
        awaitingAfter: restoredFocusAwaitingSyncReconciliation,
        baselineAfter: restoredFocusBaselineSyncStamp,
        pomodoroPhase, timerOwnerDeviceId, syncedDeviceId
      };
    }, before.pomodoroPhaseStartedAt);

    expect(second.applied).toBe(false);
    expect(second.pomodoroPhase).toBe('work');
    expect(second.timerOwnerDeviceId).toBe(second.syncedDeviceId);
    expect(second.awaitingAfter).toBe(true); // still open
    expect(second.baselineAfter).toBe(baselineBefore); // still untouched

    // A itself keeps ticking undisturbed — no hybrid state (see round-4
    // review P1): a locally-owned in-memory tick would eventually log a
    // spurious receipt if the generic update had wrongly cleared the
    // session, so confirm it's still exactly where it started.
    const stillRunning = await readFocusState(page);
    expect(stillRunning.pomodoroPhase).toBe('work');
    expect(stillRunning.entriesCount).toBe(0);
  });

  test('reconciliation: a GENERIC remote timer during the window does not block a genuine Focus takeover that arrives afterward', async ({ page }) => {
    await openApp(page);
    const before = await startFocusSession(page, 'Generic then real Focus takeover');
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 30 * 1000);
    await page.reload();

    // Generic (non-Focus) snapshot arrives first — must be ignored without
    // consuming the reconciliation window (see previous test).
    await page.evaluate((beforeStartedAt) => applyRemoteTimerState({
      running: true,
      lastTask: 'Generic ping timer',
      intervalSecs: 1800,
      startedAt: beforeStartedAt + 5 * 60 * 1000,
      updatedAt: beforeStartedAt + 5 * 60 * 1000,
      updatedBy: 'device-b',
      ownerDeviceId: 'device-b'
    }), before.pomodoroPhaseStartedAt);
    expect(await page.evaluate(() => restoredFocusAwaitingSyncReconciliation)).toBe(true); // still open

    // Now device B's genuine, newer Focus takeover arrives — the window is
    // still open for it to be evaluated on its own merits.
    const result = await page.evaluate((beforeStartedAt) => {
      const applied = applyRemoteTimerState({
        running: true,
        mode: 'focus',
        focusPhase: 'work',
        lastTask: 'Device B real takeover',
        intervalSecs: 25 * 60,
        startedAt: beforeStartedAt + 7 * 60 * 1000,
        updatedAt: beforeStartedAt + 7 * 60 * 1000,
        updatedBy: 'device-b',
        ownerDeviceId: 'device-b',
        deviceName: 'Device B'
      });
      return {
        applied,
        awaitingAfter: restoredFocusAwaitingSyncReconciliation,
        timerOwnerDeviceId,
        syncedFocusOwner: syncedFocusTimer?.ownerDeviceId,
        persisted: localStorage.getItem('ta3-focus-timer')
      };
    }, before.pomodoroPhaseStartedAt);

    expect(result.applied).toBe(true); // B wins — a real Focus takeover, correctly evaluated
    expect(result.awaitingAfter).toBe(false); // now consumed
    expect(result.timerOwnerDeviceId).toBe('device-b');
    expect(result.syncedFocusOwner).toBe('device-b');
    expect(result.persisted).toBeNull(); // A's stale claim cleared — cannot later complete

    await expect(page.locator('#focus-phase-sub')).toContainText('Device B');

    // A's stale local session cannot later complete and log a receipt: a
    // further reload finds nothing to restore.
    await page.reload();
    const after = await readFocusState(page);
    expect(after.pomodoroPhase).toBe('idle');
    expect(after.entriesCount).toBe(0);
    expect(after.persisted).toBeNull();
  });

  test('pomodoroCount clamp: an absurdly large corrupted count is bounded on restore and does not build an unbounded dot list', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      localStorage.setItem('ta3-focus-timer', JSON.stringify({
        pomodoroPhase: 'work',
        pomodoroPhaseStartedAt: Date.now() - 60 * 1000,
        pomodoroWorkMin: 25,
        pomodoroBreakMin: 5,
        pomodoroCount: 999999999,
        task: 'Corrupt count',
        hudFocusLinkType: 'none',
        ownerDeviceId: null
      }));
    });
    await page.reload();

    const after = await page.evaluate(() => ({
      pomodoroPhase,
      pomodoroCount,
      dotCount: document.getElementById('focus-pomo-dots').children.length
    }));
    expect(after.pomodoroPhase).toBe('work'); // restore still succeeds safely despite the corrupt count
    // FOCUS_MAX_POMODORO_COUNT (focus-mode.js): the theoretical max
    // pomodoros achievable in a single day at the Focus settings UI's own
    // minimum work(1min)+break(1min) cycle.
    expect(after.pomodoroCount).toBe(720);
    expect(after.dotCount).toBe(720); // renderPomoDots(): 720 % 4 === 0, no extra rounding
  });

  test('Learning Plan linkage survives reload restore and fires exactly once on natural completion', async ({ page }) => {
    // Uses the REAL learning-plan-ui.js handler (window.onLearningPlanFocusSessionEnded
    // = receiveLearningPlanFocusOutcome), not a stub — that module script is deferred
    // (type="module") and overwrites any hook a test registers early, which is exactly
    // why restoreFocusSession() itself waits for DOMContentLoaded (see focus-mode.js)
    // before concluding an elapsed session: the real hook must already be registered.
    await openApp(page);
    const before = await page.evaluate(() => {
      HTMLMediaElement.prototype.play = () => Promise.resolve();
      const learningPlan = {
        planId: 'plan-1', phaseId: 'phase-1', lessonId: 'lesson-1', stepId: 'step-1',
        planTitle: 'Plan', phaseTitle: 'Phase', lessonTitle: 'Lesson', stepTitle: 'Learn reload recovery'
      };
      enterFocusMode({ task: 'Learn reload recovery', learningPlan, autoStart: true });
      return { pomodoroPhaseStartedAt, stepId: activeFocusLearningPlan && activeFocusLearningPlan.stepId };
    });
    expect(before.stepId).toBe('step-1');

    // Reload mid-session first — linkage must survive untouched, no outcome yet.
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 5 * 60 * 1000);
    await page.reload();
    const mid = await page.evaluate(() => ({
      stepId: activeFocusLearningPlan && activeFocusLearningPlan.stepId,
      entriesCount: entries.length
    }));
    expect(mid.stepId).toBe('step-1');
    expect(mid.entriesCount).toBe(0);
    await expect(page.getByRole('region', { name: 'Focus outcome' })).toHaveCount(0);

    // Now reload again, past the full work duration, so restoration itself
    // must conclude the session and deliver the Learning Plan outcome exactly
    // once through the real production handler.
    await page.clock.setFixedTime(before.pomodoroPhaseStartedAt + 25 * 60 * 1000 + 5000);
    await page.reload();

    const outcomeRegion = page.getByRole('region', { name: 'Focus outcome' });
    await expect(outcomeRegion).toBeVisible();
    await expect(outcomeRegion).toContainText('Learn reload recovery');
    const entriesCount = await page.evaluate(() => entries.length);
    expect(entriesCount).toBe(1); // exactly one receipt — no duplicate

    // The session itself is fully concluded (finishLearningPlanFocusSession()
    // clears the persisted record) — a further reload must find nothing left
    // to restore, and must not re-log a second entry.
    await page.reload();
    const after = await page.evaluate(() => ({ pomodoroPhase, entriesCount: entries.length, persisted: localStorage.getItem('ta3-focus-timer') }));
    expect(after.pomodoroPhase).toBe('idle');
    expect(after.entriesCount).toBe(1);
    expect(after.persisted).toBeNull();
  });
});
