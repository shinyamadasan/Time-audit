// ══════════════════════════════════════════════════════
// FOCUS MODE — pomodoro, music, blocker, suggestions
// Depends on globals from index.html:
//   entries, settings, reviews, running, ticker, blockStartTime,
//   currentTask, intention, lastTaskForRepeat, timerStartedAt,
//   totalSecs, remaining, dailyCommitment,
//   persist(), syncEntries(), showToast(), resetTimer(),
//   getTodayEntries(), getActivityColor(), toDateKey(), fmtDur(),
//   getBucket(), renderToday(), updateRing(), doPing(),
//   buildHeroSuggestions(), buildSugItem(), syncTimerState(),
//   canonicalizeActivityInput(), _startHeartbeat(), _stopHeartbeat()
// ══════════════════════════════════════════════════════

// ── State ──
let focusModeOn = false;
let focusBlockCountdown = null;

// ── Pomodoro state ──
let pomodoroPhase = 'idle'; // 'idle' | 'work' | 'break'
let pomodoroTimer = null;
let pomodoroRemaining = 0;
let pomodoroWorkMin = 25;
let pomodoroBreakMin = 5;
let pomodoroCount = 0;
let focusStartTime = null;
let pomodoroPhaseStartedAt = null;
let pomodoroWasPaused = false;
let activeFocusLearningPlan = null;
let activeFocusContext = '';
let pendingFocusLearningPlan = null;
let pendingFocusContext = '';
let _pomodoroAutoStart = localStorage.getItem('ta3-pomo-auto') === '1';
let _lastFocusSyncAt = 0;
const FOCUS_SYNC_REFRESH_MS = 15000;
let _hudFocusLinkType = 'none'; // Phase 6B.1: 'daily-routine' | 'learning-plan' | 'none' — truthful source, never fabricated

// ── Music state ──
let _focusMusicVolume = parseFloat(localStorage.getItem('ta3-focus-vol') || '0.3');
let _lofiTrackIdx = 0;
let _shuffleMode = localStorage.getItem('ta3-focus-shuffle') === '1';
let _shuffleQueue = [];
let _inBreakMode = false;
let _outroActive = false;

function canonicalFocusActivity(task) {
  const fn = globalThis.canonicalizeActivityInput;
  return typeof fn === 'function' ? fn(task) : String(task || '').trim();
}

function cloneFocusLearningPlanMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const required = ['planId', 'phaseId', 'lessonId', 'stepId'];
  if (required.some(key => typeof value[key] !== 'string' || !value[key].trim())) return null;
  return {
    planId: value.planId,
    phaseId: value.phaseId,
    lessonId: value.lessonId,
    stepId: value.stepId,
    planTitle: String(value.planTitle || ''),
    phaseTitle: String(value.phaseTitle || ''),
    lessonTitle: String(value.lessonTitle || ''),
    stepTitle: String(value.stepTitle || '')
  };
}

function getFocusLearningPlanMetadata() {
  return cloneFocusLearningPlanMetadata(activeFocusLearningPlan);
}

function clearFocusLearningPlanContext() {
  activeFocusLearningPlan = null;
  activeFocusContext = '';
  pendingFocusLearningPlan = null;
  pendingFocusContext = '';
  _hudFocusLinkType = 'none';
}

function isFocusSessionRunning() {
  return pomodoroPhase !== 'idle';
}

// ══════════════════════════════════════════════════════
// RELOAD RECOVERY — persist/restore the active Focus session across a
// browser reload. storage.js's persist()/load() already restore a generic
// "ta3-timer" (the away/ping block timer, gated on the `running` flag),
// but Focus/Pomodoro state never sets `running` and was never written
// anywhere — so a reload silently dropped it. This mirrors that same
// pattern, scoped to Focus. Elapsed/remaining is always re-derived from the
// stored absolute pomodoroPhaseStartedAt vs the current wall clock on
// restore — never a second timer.
// ══════════════════════════════════════════════════════
const FOCUS_TIMER_STORAGE_KEY = 'ta3-focus-timer';

// Theoretical max pomodoros achievable in a single day even at the Focus
// settings UI's own minimum work(1min)+break(1min) cycle — index.html
// #pomo-work-min/#pomo-break-min both have min="1". Defensive clamp only:
// no legitimate session ever approaches this; it exists to stop a corrupted
// persisted count from making renderPomoDots() build an unbounded DOM list.
const FOCUS_MAX_POMODORO_COUNT = 720;

// Clock-skew tolerance for a restored pomodoroPhaseStartedAt: a legitimate
// value is never meaningfully in the future, but minor cross-device clock
// drift is real. Anything further ahead than this is treated as corrupt.
const FOCUS_MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

// Set by restoreFocusSession() only; in-memory only, NEVER persisted to
// localStorage (must not survive a reload itself). While true, storage.js's
// applyRemoteTimerState() treats this device's restored ownership claim as
// provisional for exactly one incoming remote timer snapshot instead of
// letting it permanently outrank a takeover that legitimately completed
// while this device was away. A freshly-started (non-restored) Focus
// session never sets this, so its ownership behavior is completely
// unchanged. See applyRemoteTimerState() in storage.js.
let restoredFocusAwaitingSyncReconciliation = false;
// The local timer-sync recency stamp (storage.js's TIMER_SYNC_STAMP_KEY) as
// it stood immediately before restoreFocusSession() made its own outbound
// syncFocusTimerState() push — captured so the one-time reconciliation
// check isn't comparing a remote snapshot against a stamp that restore's
// own push just bumped to "now".
let restoredFocusBaselineSyncStamp = 0;

function persistFocusSession() {
  if (pomodoroPhase === 'idle') { clearPersistedFocusSession(); return; }
  try {
    localStorage.setItem(FOCUS_TIMER_STORAGE_KEY, JSON.stringify({
      pomodoroPhase,
      pomodoroPhaseStartedAt,
      pomodoroWorkMin,
      pomodoroBreakMin,
      pomodoroCount,
      task: currentTask,
      learningPlan: cloneFocusLearningPlanMetadata(activeFocusLearningPlan),
      context: activeFocusContext,
      hudFocusLinkType: _hudFocusLinkType,
      ownerDeviceId: timerOwnerDeviceId || null
    }));
  } catch {}
}

function clearPersistedFocusSession() {
  try { localStorage.removeItem(FOCUS_TIMER_STORAGE_KEY); } catch {}
  // Focus ending/exiting locally means there is nothing left to reconcile —
  // never let this leak into a later, unrelated session.
  restoredFocusAwaitingSyncReconciliation = false;
  restoredFocusBaselineSyncStamp = 0;
}

// Reconstructs an active Focus session from persisted state after a reload.
// Never fabricates a session: a missing/corrupt/incomplete record, or a
// session already active in memory, leaves Focus untouched — it restores
// identity, it never starts a new one. When the persisted phase's planned
// duration already elapsed while the app was closed, it calls the exact
// same endWorkSession()/endPomodoroBreak() the running tab would have
// called, once, instead of inventing a parallel recovery path.
function restoreFocusSession() {
  if (pomodoroPhase !== 'idle') return false; // never clobber an already-active session
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(FOCUS_TIMER_STORAGE_KEY) || 'null'); }
  catch { clearPersistedFocusSession(); return false; }
  if (!saved || typeof saved !== 'object') return false;

  const validPhase = saved.pomodoroPhase === 'work' || saved.pomodoroPhase === 'break';
  const validStart = Number.isFinite(saved.pomodoroPhaseStartedAt) && saved.pomodoroPhaseStartedAt > 0
    && saved.pomodoroPhaseStartedAt <= Date.now() + FOCUS_MAX_FUTURE_SKEW_MS;
  const validWorkMin = Number.isFinite(saved.pomodoroWorkMin) && saved.pomodoroWorkMin > 0;
  const validBreakMin = Number.isFinite(saved.pomodoroBreakMin) && saved.pomodoroBreakMin > 0;
  if (!validPhase || !validStart || !validWorkMin || !validBreakMin) {
    clearPersistedFocusSession(); // corrupt/incomplete — fail safe, never fabricate a session
    return false;
  }

  // Capture the pre-restore local sync recency stamp BEFORE anything below
  // (including the syncFocusTimerState() push later in this function) can
  // touch it — this is the reconciliation baseline. See the declaration
  // comment above and applyRemoteTimerState() in storage.js.
  restoredFocusBaselineSyncStamp = typeof numberFromStorage === 'function' && typeof TIMER_SYNC_STAMP_KEY !== 'undefined'
    ? numberFromStorage(TIMER_SYNC_STAMP_KEY) : 0;
  restoredFocusAwaitingSyncReconciliation = true;

  pomodoroPhase = saved.pomodoroPhase;
  pomodoroPhaseStartedAt = saved.pomodoroPhaseStartedAt;
  focusStartTime = pomodoroPhase === 'work' ? pomodoroPhaseStartedAt : null;
  pomodoroWorkMin = saved.pomodoroWorkMin;
  pomodoroBreakMin = saved.pomodoroBreakMin;
  pomodoroCount = Number.isFinite(saved.pomodoroCount)
    ? Math.min(Math.max(0, Math.floor(saved.pomodoroCount)), FOCUS_MAX_POMODORO_COUNT) : 0;
  currentTask = String(saved.task || currentTask || '').trim();
  lastTaskForRepeat = currentTask || lastTaskForRepeat;
  activeFocusLearningPlan = cloneFocusLearningPlanMetadata(saved.learningPlan);
  activeFocusContext = String(saved.context || '').trim();
  _hudFocusLinkType = ['daily-routine', 'learning-plan', 'none'].includes(saved.hudFocusLinkType)
    ? saved.hudFocusLinkType : 'none';
  timerOwnerDeviceId = saved.ownerDeviceId || timerOwnerDeviceId;
  focusModeOn = true;

  const taskInput = document.getElementById('focus-task-input');
  if (taskInput) { taskInput.value = currentTask; taskInput.style.display = 'none'; }
  const intentionEl = document.getElementById('focus-intention-text');
  if (intentionEl) { intentionEl.textContent = getFocusTaskLabel(); intentionEl.style.display = 'block'; }
  document.getElementById('focus-settings-row').style.display = 'none';
  document.getElementById('focus-start-btn').style.display = 'none';
  document.getElementById('focus-overlay')?.classList.add('open');
  renderPomoDots();
  updateFocusDeepBar();

  const phaseSecs = (pomodoroPhase === 'break' ? pomodoroBreakMin : pomodoroWorkMin) * 60;
  const elapsedSecs = Math.max(0, Math.floor((Date.now() - pomodoroPhaseStartedAt) / 1000));

  if (elapsedSecs >= phaseSecs) {
    // The phase's planned end already passed while the app was closed or
    // reloaded. Apply the exact same one-time transition the running tab
    // would have applied — never a duplicate, never a bespoke shortcut.
    if (pomodoroPhase === 'work') {
      document.getElementById('focus-phase-label').textContent = 'FOCUS';
      document.getElementById('focus-phase-sub').textContent = focusPhaseSubText(pomodoroWorkMin);
      endWorkSession();
      // endWorkSession() concluded the work phase at its planned endpoint, not
      // the reopen time. If it then entered a break whose own planned window
      // also fully elapsed while the app was closed, conclude that too — the
      // same one-time endPomodoroBreak() a running tab would have applied. If
      // the break is still legitimately in progress, re-derive its real
      // remaining from the wall clock rather than the full fresh countdown
      // endWorkSession() optimistically set.
      if (pomodoroPhase === 'break' && Number.isFinite(pomodoroPhaseStartedAt)) {
        const breakSecs = pomodoroBreakMin * 60;
        const breakElapsedSecs = Math.max(0, Math.floor((Date.now() - pomodoroPhaseStartedAt) / 1000));
        if (breakElapsedSecs >= breakSecs) {
          clearInterval(pomodoroTimer);
          endPomodoroBreak();
        } else {
          pomodoroRemaining = breakSecs - breakElapsedSecs;
          setPomodoroCountdown(pomodoroRemaining);
        }
      }
    } else {
      document.getElementById('focus-phase-label').textContent = 'BREAK ☕';
      document.getElementById('focus-phase-sub').textContent = `take a breather · ${pomodoroBreakMin} min`;
      endPomodoroBreak();
    }
    return true;
  }

  pomodoroRemaining = phaseSecs - elapsedSecs;
  if (pomodoroPhase === 'work') {
    document.getElementById('focus-phase-label').textContent = 'FOCUS';
    document.getElementById('focus-phase-sub').textContent = focusPhaseSubText(pomodoroWorkMin);
  } else {
    document.getElementById('focus-phase-label').textContent = 'BREAK ☕';
    document.getElementById('focus-phase-sub').textContent = `take a breather · ${pomodoroBreakMin} min`;
    const btn = document.getElementById('focus-start-btn');
    if (btn) { btn.textContent = 'Skip break'; btn.onclick = skipBreak; btn.style.display = 'block'; }
  }
  setPomodoroCountdown(pomodoroRemaining);
  clearInterval(pomodoroTimer);
  pomodoroTimer = setInterval(tickPomodoro, 1000);
  syncFocusTimerState(pomodoroPhaseStartedAt);
  pushHudFocusState(pomodoroPhaseStartedAt);
  return true;
}

function focusContextText(metadata) {
  return [metadata?.planTitle, metadata?.phaseTitle, metadata?.lessonTitle]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' · ');
}

function focusPhaseSubText(workMin) {
  return activeFocusContext
    ? `${activeFocusContext} · ${workMin} min`
    : `work session · ${workMin} min`;
}

function learningPlanFocusSessionOutcome(metadata, entry, tsStart, tsEnd) {
  if (!metadata || !entry) return null;
  return {
    ...cloneFocusLearningPlanMetadata(metadata),
    focusEntryId: entry.id,
    focusActivity: entry.activity,
    focusStartedAt: tsStart,
    focusEndedAt: tsEnd,
    focusDurationMin: entry.blockIntervalMin
  };
}

function notifyLearningPlanFocusSessionEnded(entry, tsStart, tsEnd) {
  const metadata = cloneFocusLearningPlanMetadata(activeFocusLearningPlan);
  const outcome = learningPlanFocusSessionOutcome(metadata, entry, tsStart, tsEnd);
  if (!outcome || typeof globalThis.onLearningPlanFocusSessionEnded !== 'function') return false;
  try {
    return globalThis.onLearningPlanFocusSessionEnded(outcome) !== false;
  } catch (err) {
    showToast(`Learning Plan outcome unavailable: ${err.message || err}`);
    return false;
  }
}

function finishLearningPlanFocusSession() {
  pomodoroPhase = 'idle';
  pomodoroPhaseStartedAt = null;
  pomodoroRemaining = 0;
  clearPersistedFocusSession();
  stopFocusMusic();
  focusModeOn = false;
  document.getElementById('focus-overlay')?.classList.remove('open');
  if (typeof _stopHeartbeat === 'function') _stopHeartbeat();
  syncTimerState({ stopped: true, lastTask: null, mode: 'focus' });
  timerOwnerDeviceId = null;
  currentTask = '';
  pushHudFocusEnded();
  renderToday();
}

// Audio served from GitHub Pages — not bundled in APK (keeps APK ~12MB)
const _AUDIO_BASE = 'https://shinyamadasan.github.io/Time-audit/Sounds/';
const _BREAK_TRANSITION = _AUDIO_BASE + 'natureseye-trapped-introoutro-144328.mp3';
const _BREAK_LOOP       = _AUDIO_BASE + 'nickpanekaiassets-atom-bomb-jig-energetic-big-band-swing-instrumental-318351.mp3';
const _OUTRO_LEAD_SEC   = 19;

// ── Suggestions state ──
let _focusSugIndex = -1;

// ── Lo-fi track list ──
const _LOFI_TRACKS = [
  'focus.mp3',
  'pulsebox-lofi-melody-522894.mp3',
  'pulsebox-lofi-production-522875.mp3',
  'the_mountain-lofi-lofi-music-496553.mp3',
  'pulsebox-lofi-vlog-522887.mp3',
  'pulsebox-lofi-slow-522877.mp3',
  'pulsebox-lofi-drums-522891.mp3',
  'watermello-lofi-lofi-girl-lofi-chill-484610.mp3',
  'pulsebox-lofi-blog-522886.mp3',
  'pulsebox-lofi-cinematic-522892.mp3',
  'watermello-lofi-chill-lofi-girl-lofi-488388.mp3',
  'mondamusic-lofi-lofi-girl-lofi-chill-512853.mp3',
  'pulsebox-lofi-study-522878.mp3',
  'pulsebox-lofi-night-522890.mp3',
  'pulsebox-lofi-smooth-522876.mp3',
  'pulsebox-lofi-retro-522893.mp3',
  'fassounds-lofi-study-calm-peaceful-chill-hop-112191.mp3',
  'fassounds-good-night-lofi-cozy-chill-music-160166.mp3',
  'pulsebox-lofi-ambient-522898.mp3',
  'pulsebox-lofi-video-522883.mp3',
  'pulsebox-lofi-chill-522885.mp3',
  'lemonmusiclab-lofi-lofi-music-499264.mp3',
  'leberch-lofi-hip-hop-519408.mp3',
  'pulsebox-lofi-mellow-522897.mp3',
  'pulsebox-lofi-vinyl-522882.mp3',
  'pulsebox-lofi-instrumental-522889.mp3',
  'monume-lofi-lofi-girl-lofi-chill-509453.mp3',
  'mondamusic-lofi-beats-499181.mp3',
  'monume-lofi-lofi-girl-lofi-chill-519232.mp3',
  'leberch-lofi-516620.mp3',
  'pulsebox-lofi-atmosphere-522881.mp3',
  'pulsebox-lofi-cozy-522874.mp3',
  'pulsebox-lofi-walking-522873.mp3',
  'pulsebox-lofi-hip-hop-522884.mp3',
  'pulsebox-lofi-calm-522888.mp3',
  'atlasaudio-sad-lofi-516966.mp3',
  'mondamusic-lofi-chill-lofi-girl-491690.mp3',
  'freemusicforvideo-lofi-chill-music-495628.mp3',
  'bfcmusic-lofi-lo-fi-511230.mp3',
  'playstarz_music-lofi-chill-lofi-girl-lofi-490880.mp3',
  'solarflex-lofi-lofi-girl-lofi-chill-515513.mp3',
  'mondamusic-lofi-chill-491719.mp3',
  'vibehorn-lofi-beat-lo-fi-music-512500.mp3',
  'vibehorn-lofi-chill-music-496931.mp3',
  'mondamusic-lofi-chill-chill-512854.mp3',
  'lofi_music_library-lofi-girl-chill-lofi-beats-lofi-ambient-461871.mp3',
  'paulyudin-lofi-lofi-chill-lofi-girl-482399.mp3',
  'sonican-lo-fi-music-loop-sentimental-jazzy-love-473154.mp3',
  'monume-lofi-chill-chill-509496.mp3',
  'mondamusic-lofi-chill-487321.mp3',
  'lofi_music_library-coffee-lofi-chill-lofi-ambient-458901.mp3',
  'lofi_music_library-coffee-lofi-lofi-music-chill-ambient-458900.mp3',
  'delosound-lofi-lofi-chill-lofi-girl-466467.mp3',
  'aventure-lofi-chill-nostalgic-469629.mp3',
].map(f => _AUDIO_BASE + f);

// ══════════════════════════════════════════════════════
// POMODORO CORE
// ══════════════════════════════════════════════════════

function updateFocusDeepBar() {
  const todayE = getTodayEntries().filter(e => !e.missed);
  const deepBlocks = todayE.filter(e => e.energy === 'deep').length;
  const goal = dailyCommitment || settings.deepGoal || 8;
  const pct = Math.min(100, Math.round((deepBlocks / goal) * 100));
  document.getElementById('focus-deep-label').textContent = `${deepBlocks} / ${goal} blocks`;
  document.getElementById('focus-deep-bar').style.width = pct + '%';
}

function renderPomoDots() {
  const container = document.getElementById('focus-pomo-dots');
  const total = Math.max(4, pomodoroCount + (4 - pomodoroCount % 4 === 4 ? 0 : 4 - pomodoroCount % 4));
  container.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('div');
    d.style.cssText = `width:9px;height:9px;border-radius:50%;background:${i < pomodoroCount ? 'var(--deep)' : 'var(--bg3)'};transition:background 0.3s`;
    container.appendChild(d);
  }
}

function setPomodoroCountdown(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  document.getElementById('focus-countdown').textContent =
    `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function syncFocusTimerState(startedAt = pomodoroPhaseStartedAt || focusStartTime || Date.now()) {
  if (typeof syncTimerState !== 'function' || pomodoroPhase === 'idle') return;
  const phaseSecs = (pomodoroPhase === 'break' ? pomodoroBreakMin : pomodoroWorkMin) * 60;
  _lastFocusSyncAt = Date.now();
  syncTimerState({
    running: true,
    mode: 'focus',
    focusPhase: pomodoroPhase,
    lastTask: getFocusTaskLabel(),
    intervalSecs: phaseSecs,
    startedAt,
    taskStartTime: startedAt,
    blockStartTime: startedAt,
    ownerDeviceId: timerOwnerDeviceId || syncedDeviceId
  });
}

function refreshFocusTimerSync(force = false) {
  if (pomodoroPhase === 'idle') return false;
  if (!force && Date.now() - _lastFocusSyncAt < FOCUS_SYNC_REFRESH_MS) return false;
  syncFocusTimerState();
  return true;
}

// Phase 6B.1 — Windows Ambient Focus HUD projection. Purely additive: reflects
// whatever focus-mode.js already decided, creates no state of its own. A
// no-op if windows-hud-bridge.js hasn't loaded or no companion is running.
function pushHudFocusState(startedAtOverride) {
  const bridge = globalThis.chronaSenseHudBridge;
  if (!bridge || typeof bridge.pushActive !== 'function') return;
  const startedAt = startedAtOverride || pomodoroPhaseStartedAt || focusStartTime || Date.now();
  const intervalSecs = (pomodoroPhase === 'break' ? pomodoroBreakMin : pomodoroWorkMin) * 60;
  bridge.pushActive({
    title: getFocusTaskLabel(),
    phase: pomodoroPhase,
    startedAt,
    plannedEndAt: startedAt + intervalSecs * 1000,
    linkType: _hudFocusLinkType,
    deviceOwned: timerOwnerDeviceId === syncedDeviceId
  });
}

function pushHudFocusEnded() {
  const bridge = globalThis.chronaSenseHudBridge;
  if (bridge && typeof bridge.pushEnded === 'function') bridge.pushEnded();
}

function isSyncedFocusMirrorActive() {
  return !!(syncedFocusTimer
    && syncedFocusTimer.running
    && syncedFocusTimer.ownerDeviceId
    && syncedFocusTimer.ownerDeviceId !== syncedDeviceId);
}

function renderSyncedFocusOverlay() {
  if (!isSyncedFocusMirrorActive()) return false;
  const phase = syncedFocusTimer.focusPhase === 'break' ? 'break' : 'work';
  const intervalSecs = Math.max(1, Number(syncedFocusTimer.intervalSecs || totalSecs || 1500));
  const elapsed = Math.max(0, Math.floor((Date.now() - syncedFocusTimer.startedAt) / 1000));
  const remainingSecs = Math.max(0, intervalSecs - elapsed);

  pomodoroPhase = phase;
  pomodoroPhaseStartedAt = syncedFocusTimer.startedAt;
  pomodoroRemaining = remainingSecs;
  if (phase === 'break') pomodoroBreakMin = Math.max(1, Math.round(intervalSecs / 60));
  else pomodoroWorkMin = Math.max(1, Math.round(intervalSecs / 60));

  const taskInput = document.getElementById('focus-task-input');
  if (taskInput) taskInput.style.display = 'none';
  const intentionEl = document.getElementById('focus-intention-text');
  if (intentionEl) {
    intentionEl.textContent = syncedFocusTimer.task || currentTask || 'Focus session';
    intentionEl.style.display = 'block';
  }
  const labelEl = document.getElementById('focus-phase-label');
  if (labelEl) labelEl.textContent = phase === 'break' ? 'BREAK' : 'FOCUS';
  const subEl = document.getElementById('focus-phase-sub');
  if (subEl) subEl.textContent = `${syncedFocusTimer.deviceName || 'other device'} synced · ${phase} session`;
  const settingsRow = document.getElementById('focus-settings-row');
  if (settingsRow) settingsRow.style.display = 'none';
  const startBtn = document.getElementById('focus-start-btn');
  if (startBtn) startBtn.style.display = 'none';
  setPomodoroCountdown(remainingSecs);
  renderPomoDots();
  updateFocusDeepBar();
  return true;
}

function syncFocusOverlayFromRemote() {
  if (!renderSyncedFocusOverlay()) return false;
  if (document.getElementById('focus-overlay')?.classList.contains('open')) {
    clearInterval(pomodoroTimer);
    pomodoroTimer = setInterval(renderSyncedFocusOverlay, 1000);
  }
  return true;
}

function clearSyncedFocusOverlay() {
  if (!document.getElementById('focus-overlay')?.classList.contains('open')) return false;
  if (isSyncedFocusMirrorActive()) return false;
  clearInterval(pomodoroTimer);
  pomodoroTimer = null;
  pomodoroPhase = 'idle';
  pomodoroPhaseStartedAt = null;
  const taskInput = document.getElementById('focus-task-input');
  if (taskInput) {
    taskInput.value = '';
    taskInput.style.display = 'block';
  }
  document.getElementById('focus-intention-text').style.display = 'none';
  document.getElementById('focus-phase-label').textContent = 'POMODORO';
  document.getElementById('focus-phase-sub').textContent = 'set your timer and go';
  document.getElementById('focus-settings-row').style.display = 'flex';
  const startBtn = document.getElementById('focus-start-btn');
  startBtn.textContent = 'Start';
  startBtn.onclick = startPomodoro;
  startBtn.style.display = 'block';
  setPomodoroCountdown(pomodoroWorkMin * 60);
  return true;
}

function takeOverSyncedFocusTimer() {
  if (!syncedFocusTimer || !syncedFocusTimer.running) return false;
  // An explicit local takeover is a fresh ownership decision made by this
  // device right now — it supersedes any still-pending post-restore
  // reconciliation rather than waiting on it.
  restoredFocusAwaitingSyncReconciliation = false;
  const phase = syncedFocusTimer.focusPhase === 'break' ? 'break' : 'work';
  const intervalSecs = Math.max(1, Number(syncedFocusTimer.intervalSecs || totalSecs || 1500));
  const elapsed = Math.max(0, Math.floor((Date.now() - syncedFocusTimer.startedAt) / 1000));
  const remainingSecs = Math.max(0, intervalSecs - elapsed);
  const task = syncedFocusTimer.task || currentTask || 'Focus session';

  timerOwnerDeviceId = syncedDeviceId;
  currentTask = task;
  lastTaskForRepeat = task;
  totalSecs = intervalSecs;
  remaining = remainingSecs;
  timerStartedAt = syncedFocusTimer.startedAt;
  taskStartTime = taskStartTime || syncedFocusTimer.startedAt;
  blockStartTime = blockStartTime || taskStartTime || syncedFocusTimer.startedAt;
  pomodoroPhase = phase;
  pomodoroPhaseStartedAt = syncedFocusTimer.startedAt;
  pomodoroRemaining = remainingSecs;
  focusStartTime = phase === 'work' ? syncedFocusTimer.startedAt : null;
  if (phase === 'break') pomodoroBreakMin = Math.max(1, Math.round(intervalSecs / 60));
  else pomodoroWorkMin = Math.max(1, Math.round(intervalSecs / 60));

  if (!document.getElementById('focus-overlay')?.classList.contains('open')) return true;
  focusModeOn = true;
  const taskInput = document.getElementById('focus-task-input');
  if (taskInput) taskInput.style.display = 'none';
  const intentionEl = document.getElementById('focus-intention-text');
  if (intentionEl) {
    intentionEl.textContent = task;
    intentionEl.style.display = 'block';
  }
  document.getElementById('focus-phase-label').textContent = phase === 'break' ? 'BREAK' : 'FOCUS';
  document.getElementById('focus-phase-sub').textContent = `owned here · ${phase} session`;
  document.getElementById('focus-settings-row').style.display = 'none';
  document.getElementById('focus-start-btn').style.display = 'none';
  setPomodoroCountdown(remainingSecs);
  renderPomoDots();
  updateFocusDeepBar();
  clearInterval(pomodoroTimer);
  pomodoroTimer = setInterval(tickPomodoro, 1000);
  pushHudFocusState(syncedFocusTimer.startedAt);
  persistFocusSession();
  return true;
}

function startPomodoro(options = {}) {
  if (pomodoroPhase !== 'idle') return false;
  pomodoroWorkMin = parseInt(document.getElementById('pomo-work-min').value) || 25;
  pomodoroBreakMin = parseInt(document.getElementById('pomo-break-min').value) || 5;

  const taskInput = document.getElementById('focus-task-input');
  if (options.task) taskInput.value = options.task;
  const focusTask = canonicalFocusActivity(taskInput.value.trim());
  if (!focusTask) {
    taskInput.classList.add('focus-task-error');
    taskInput.placeholder = 'Name your focus session first';
    taskInput.focus();
    setTimeout(() => { taskInput.classList.remove('focus-task-error'); taskInput.placeholder = 'What are you focusing on?'; }, 2000);
    return false;
  }
  activeFocusLearningPlan = cloneFocusLearningPlanMetadata(options.learningPlan || pendingFocusLearningPlan);
  activeFocusContext = String(options.context || pendingFocusContext || focusContextText(activeFocusLearningPlan) || '').trim();
  pendingFocusLearningPlan = null;
  pendingFocusContext = '';
  const startedAt = Date.now();
  if (options.dailyRoutine && typeof globalThis.onDailyRoutineFocusStarted === 'function' &&
      globalThis.onDailyRoutineFocusStarted(options.dailyRoutine, startedAt) === false) return false;
  _hudFocusLinkType = options.dailyRoutine ? 'daily-routine' : (activeFocusLearningPlan ? 'learning-plan' : 'none');
  pomodoroPhase = 'work';
  pomodoroRemaining = pomodoroWorkMin * 60;
  focusStartTime = startedAt;
  pomodoroPhaseStartedAt = focusStartTime;
  taskInput.style.display = 'none';
  const intentionEl = document.getElementById('focus-intention-text');
  intentionEl.textContent = focusTask;
  intentionEl.style.display = 'block';
  currentTask = focusTask;
  lastTaskForRepeat = focusTask;
  timerOwnerDeviceId = syncedDeviceId;

  if (running) {
    pomodoroWasPaused = true;
    clearInterval(ticker); ticker = null;
  }

  document.getElementById('focus-phase-label').textContent = 'FOCUS';
  document.getElementById('focus-phase-sub').textContent = focusPhaseSubText(pomodoroWorkMin);
  document.getElementById('focus-settings-row').style.display = 'none';
  document.getElementById('focus-start-btn').style.display = 'none';

  clearInterval(pomodoroTimer);
  pomodoroTimer = setInterval(tickPomodoro, 1000);
  updateFocusDeepBar();
  syncFocusTimerState();
  pushHudFocusState();
  persistFocusSession();
  return true;
}

function getFocusTaskLabel() {
  const label = document.getElementById('focus-intention-text')?.textContent?.trim();
  return (label && label !== '—') ? label : (currentTask || intention || 'Deep work');
}

function logFocusSession(tsStart, tsEnd = Date.now()) {
  const dur = Math.round((tsEnd - tsStart) / 60000);
  if (dur < 1) return null;
  // Exactly-once completion: a Focus phase that runs to its configured length
  // has a deterministic end (its planned endpoint), so a repeat restoration, a
  // second tab, or a page/HUD race all recompute the SAME id. Never append the
  // same completion twice.
  const duplicate = entries.find(e => e.id === tsEnd && e.tsStart === tsStart && e.energy === 'deep');
  if (duplicate) return duplicate;
  const task = canonicalFocusActivity(getFocusTaskLabel());
  const entry = {
    id: tsEnd, ts: tsEnd, tsStart,
    blockIntervalMin: dur,
    date: toDateKey(new Date(tsEnd)),
    activity: task, energy: 'deep',
    onPlan: true, retro: false
  };
  entry.category = getBucket(entry);
  entry.originalLabel = entry.energy;
  getActivityColor(task);
  entries.push(entry);
  entries.sort((a, b) => b.ts - a.ts);
  lastTaskForRepeat = task;
  persist(); syncEntries();
  updateFocusDeepBar();
  return entry;
}

function saveActiveFocusSession() {
  if (!focusStartTime) return null;
  const tsStart = focusStartTime;
  focusStartTime = null;
  if (pomodoroPhase !== 'work') return null;
  const tsEnd = Date.now();
  const entry = logFocusSession(tsStart, tsEnd);
  notifyLearningPlanFocusSessionEnded(entry, tsStart, tsEnd);
  return entry;
}

function tickPomodoro() {
  pomodoroRemaining = Math.max(0, pomodoroRemaining - 1);
  setPomodoroCountdown(pomodoroRemaining);
  refreshFocusTimerSync();
  if (pomodoroPhase === 'work' && pomodoroRemaining === _OUTRO_LEAD_SEC) {
    _startWorkOutro();
  }
  if (pomodoroRemaining <= 0) {
    pomodoroPhase === 'work' ? endWorkSession() : endPomodoroBreak();
  }
}

function endWorkSession() {
  clearInterval(pomodoroTimer);
  pomodoroCount++;
  renderPomoDots();
  playAlertSound();

  // A work phase only reaches endWorkSession() by running to its configured
  // length: from tickPomodoro() at zero, or from restoreFocusSession() when
  // the planned end already passed while the app was closed. Its truthful end
  // is therefore the planned endpoint — phase start plus configured work
  // minutes — never the wall clock at the instant this fires, which on a
  // delayed restore can be hours after the session stopped being observed.
  // Early manual exit is a separate path (saveActiveFocusSession()) and still
  // uses real elapsed time.
  const plannedEndBase = Number.isFinite(focusStartTime)
    ? focusStartTime
    : (Number.isFinite(pomodoroPhaseStartedAt) ? pomodoroPhaseStartedAt : null);
  const tsEnd = plannedEndBase !== null
    ? plannedEndBase + pomodoroWorkMin * 60000
    : Date.now();
  const tsStart = focusStartTime || (tsEnd - pomodoroWorkMin * 60000);
  focusStartTime = null;
  const entry = logFocusSession(tsStart, tsEnd);
  if (entry && typeof globalThis.onDailyRoutineFocusCompleted === 'function') {
    globalThis.onDailyRoutineFocusCompleted(entry, tsStart, tsEnd);
  }
  const learningPlanOutcomeShown = notifyLearningPlanFocusSessionEnded(entry, tsStart, tsEnd);
  clearFocusLearningPlanContext();

  if (learningPlanOutcomeShown) {
    finishLearningPlanFocusSession();
    return;
  }

  pomodoroPhase = 'break';
  pomodoroPhaseStartedAt = tsEnd;
  pomodoroRemaining = pomodoroBreakMin * 60;
  _enterBreakMusic();
  document.getElementById('focus-phase-label').textContent = 'BREAK ☕';
  document.getElementById('focus-phase-sub').textContent = `take a breather · ${pomodoroBreakMin} min`;

  const btn = document.getElementById('focus-start-btn');
  btn.textContent = 'Skip break';
  btn.onclick = skipBreak;
  btn.style.display = 'block';

  renderToday();
  syncFocusTimerState(tsEnd);
  pushHudFocusState(tsEnd);
  persistFocusSession();
  pomodoroTimer = setInterval(tickPomodoro, 1000);
}

function endPomodoroBreak() {
  clearInterval(pomodoroTimer);
  pomodoroPhase = 'idle';
  pomodoroPhaseStartedAt = null;
  clearPersistedFocusSession();
  _exitBreakMusic();
  playAlertSound();
  clearFocusLearningPlanContext();

  if (_pomodoroAutoStart) {
    startPomodoro();
    return;
  }
  pushHudFocusEnded();

  document.getElementById('focus-phase-label').textContent = 'BREAK DONE';
  document.getElementById('focus-phase-sub').textContent = 'ready for the next one?';
  document.getElementById('focus-settings-row').style.display = 'flex';
  document.getElementById('focus-task-input').style.display = 'block';
  document.getElementById('focus-intention-text').style.display = 'none';
  setPomodoroCountdown(pomodoroWorkMin * 60);

  const btn = document.getElementById('focus-start-btn');
  btn.textContent = 'Start next session';
  btn.onclick = startPomodoro;
  btn.style.display = 'block';
}

function skipBreak() {
  clearInterval(pomodoroTimer);
  _skipBreakMusic();
  pomodoroPhase = 'idle';
  pomodoroPhaseStartedAt = null;
  clearPersistedFocusSession();
  clearFocusLearningPlanContext();
  startPomodoro();
}

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 150, 300].forEach(delay => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.3;
      o.start(ctx.currentTime + delay/1000);
      o.stop(ctx.currentTime + delay/1000 + 0.15);
    });
  } catch(e) {}
}

function togglePomodoroAutoStart() {
  _pomodoroAutoStart = !_pomodoroAutoStart;
  localStorage.setItem('ta3-pomo-auto', _pomodoroAutoStart ? '1' : '0');
  document.getElementById('pomo-autostart-btn')?.classList.toggle('active', _pomodoroAutoStart);
}

// ══════════════════════════════════════════════════════
// FOCUS MUSIC
// ══════════════════════════════════════════════════════

function _nextTrackIdx() {
  if (_LOFI_TRACKS.length === 1) return 0;
  if (_shuffleMode) {
    if (!_shuffleQueue.length) {
      _shuffleQueue = [...Array(_LOFI_TRACKS.length).keys()].filter(i => i !== _lofiTrackIdx);
      for (let i = _shuffleQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [_shuffleQueue[i], _shuffleQueue[j]] = [_shuffleQueue[j], _shuffleQueue[i]];
      }
    }
    return _shuffleQueue.pop();
  }
  return (_lofiTrackIdx + 1) % _LOFI_TRACKS.length;
}

function _updateTrackLabel() {
  const el = document.getElementById('focus-playlist-label');
  if (!el) return;
  if (_LOFI_TRACKS.length <= 1) { el.textContent = _inBreakMode ? 'break ☕' : ''; return; }
  const mode = _inBreakMode ? 'break ☕' : (_shuffleMode ? 'shuffle' : 'order');
  el.textContent = `track ${_lofiTrackIdx + 1} / ${_LOFI_TRACKS.length} · ${mode}`;
}

function _startWorkOutro() {
  if (_outroActive) return;
  _outroActive = true;
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.loop = false;
  mp3.src = _BREAK_TRANSITION;
  mp3.volume = _focusMusicVolume;
  mp3.play().catch(() => {});
  _updateTrackLabel();
}

function _enterBreakMusic() {
  _inBreakMode = true;
  _outroActive = false;
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.loop = false;
  mp3.src = _BREAK_LOOP;
  mp3.volume = _focusMusicVolume;
  mp3.loop = true;
  mp3.play().catch(() => {});
  _updateTrackLabel();
}

function _exitBreakMusic() {
  _inBreakMode = false;
  _outroActive = false;
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.loop = false;
  mp3.src = _BREAK_TRANSITION;
  mp3.volume = _focusMusicVolume;
  mp3.onended = () => {
    _lofiTrackIdx = _nextTrackIdx();
    startFocusMusic();
  };
  mp3.play().catch(() => {});
  _updateTrackLabel();
}

function _skipBreakMusic() {
  _inBreakMode = false;
  _outroActive = false;
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.loop = false;
  _lofiTrackIdx = _nextTrackIdx();
  startFocusMusic();
}

function _effectiveVolume() {
  return _focusMusicVolume;
}

function startFocusMusic() {
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.onerror = null;
  mp3.loop = false;
  mp3.src = _LOFI_TRACKS[_lofiTrackIdx];
  mp3.volume = _effectiveVolume();
  mp3.onerror = () => {
    _lofiTrackIdx = _nextTrackIdx();
    startFocusMusic();
  };
  mp3.onended = () => {
    // If < 3 min left in session, loop current track until outro takes over
    if (pomodoroPhase === 'work' && pomodoroRemaining > 0 && pomodoroRemaining < 3 * 60) {
      mp3.currentTime = 0;
      mp3.play().catch(() => {});
      return;
    }
    _lofiTrackIdx = _nextTrackIdx();
    startFocusMusic();
  };
  mp3.play().catch(() => {});
  _updateTrackLabel();
}

function stopFocusMusic() {
  _inBreakMode = false;
  _outroActive = false;
  const mp3 = document.getElementById('focus-music');
  mp3.onended = null;
  mp3.onerror = null;
  mp3.loop = false;
  mp3.pause();
  mp3.currentTime = 0;
}

function setFocusMusicVolume(val) {
  _focusMusicVolume = parseFloat(val);
  localStorage.setItem('ta3-focus-vol', val);
  document.getElementById('focus-music').volume = _effectiveVolume();
}

function toggleFocusPlaylist() {
  _shuffleMode = !_shuffleMode;
  _shuffleQueue = [];
  localStorage.setItem('ta3-focus-shuffle', _shuffleMode ? '1' : '0');
  const btn = document.getElementById('focus-playlist-btn');
  if (btn) btn.classList.toggle('active', _shuffleMode);
  document.getElementById('focus-music-off-btn')?.classList.remove('active');
  const mp3 = document.getElementById('focus-music');
  if (mp3.paused) startFocusMusic();
  _updateTrackLabel();
}

function selectFocusMusicOff() {
  stopFocusMusic();
  const btn = document.getElementById('focus-music-off-btn');
  document.getElementById('focus-playlist-btn').classList.remove('active');
  if (btn) btn.classList.add('active');
}

function resumeFocusMusic() {
  const offBtn = document.getElementById('focus-music-off-btn');
  if (offBtn) offBtn.classList.remove('active');
  startFocusMusic();
}

// ══════════════════════════════════════════════════════
// ENTER / EXIT
// ══════════════════════════════════════════════════════

function enterFocusMode(options = {}) {
  const launch = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  if (isFocusSessionRunning()) {
    focusModeOn = true;
    document.getElementById('focus-overlay')?.classList.add('open');
    return false;
  }
  const mirroredRemoteTimer = running && timerOwnerDeviceId && timerOwnerDeviceId !== syncedDeviceId;
  const ownedSyncedFocus = running && syncedFocusTimer?.running && syncedFocusTimer.ownerDeviceId === syncedDeviceId;
  if (running && blockStartTime && !mirroredRemoteTimer && !ownedSyncedFocus) {
    const tsEnd = Date.now();
    const dur = Math.round((tsEnd - blockStartTime) / 60000);
    if (dur >= 1) {
      const task = canonicalFocusActivity(currentTask || intention || 'Work block');
      const energy = entries.find(e => !e.missed && !e.break && !e.away)?.energy || 'deep';
      const entry = {
        id: tsEnd, ts: tsEnd, tsStart: blockStartTime,
        blockIntervalMin: dur, date: toDateKey(new Date(tsEnd)),
        activity: task, energy, onPlan: true, retro: false
      };
      entry.category = getBucket(entry); entry.originalLabel = entry.energy || null;
      getActivityColor(task);
      entries.push(entry);
      entries.sort((a, b) => b.ts - a.ts);
      lastTaskForRepeat = task;
      persist(); renderToday(); syncEntries();
      showToast(`Logged: ${task} · ${fmtDur(dur)}`);
    }
    resetTimer();
  }

  _focusMusicVolume = parseFloat(localStorage.getItem('ta3-focus-vol') || '0.3');
  _shuffleMode = localStorage.getItem('ta3-focus-shuffle') === '1';
  const volSlider = document.getElementById('focus-vol-slider');
  if (volSlider) volSlider.value = _focusMusicVolume;
  const pb = document.getElementById('focus-playlist-btn');
  if (pb) pb.classList.toggle('active', _shuffleMode);
  document.getElementById('focus-music-off-btn')?.classList.remove('active');
  _lofiTrackIdx = Math.floor(Math.random() * _LOFI_TRACKS.length);
  startFocusMusic();
  focusModeOn = true;
  clearInterval(pomodoroTimer);
  pomodoroTimer = null;
  pomodoroCount = 0;
  pomodoroPhase = 'idle';
  pomodoroWorkMin = parseInt(document.getElementById('pomo-work-min')?.value) || 25;
  pomodoroBreakMin = parseInt(document.getElementById('pomo-break-min')?.value) || 5;

  const taskInput = document.getElementById('focus-task-input');
  const launchTask = String(launch.task || '').trim();
  clearFocusLearningPlanContext();
  pendingFocusLearningPlan = cloneFocusLearningPlanMetadata(launch.learningPlan);
  pendingFocusContext = String(launch.context || focusContextText(pendingFocusLearningPlan) || '').trim();
  taskInput.value = launchTask;
  taskInput.style.display = 'block';
  if (!launch.autoStart) setTimeout(() => taskInput.focus(), 300);
  document.getElementById('focus-intention-text').style.display = 'none';

  document.getElementById('pomo-autostart-btn')?.classList.toggle('active', _pomodoroAutoStart);
  document.getElementById('focus-overlay').classList.add('open');
  document.getElementById('focus-phase-label').textContent = 'POMODORO';
  document.getElementById('focus-phase-sub').textContent = 'set your timer and go';
  document.getElementById('focus-settings-row').style.display = 'flex';
  document.getElementById('focus-start-btn').textContent = 'Start';
  document.getElementById('focus-start-btn').onclick = startPomodoro;
  document.getElementById('focus-start-btn').style.display = 'block';
  if (Number.isInteger(launch.workMinutes) && launch.workMinutes >= 1 && launch.workMinutes <= 240) {
    pomodoroWorkMin = launch.workMinutes;
    document.getElementById('pomo-work-min').value = launch.workMinutes;
  }
  setPomodoroCountdown(pomodoroWorkMin * 60);
  renderPomoDots();
  updateFocusDeepBar();
  if (ownedSyncedFocus) takeOverSyncedFocusTimer();
  else syncFocusOverlayFromRemote();
  if (launch.autoStart) return startPomodoro({
    dailyRoutine: launch.dailyRoutine,
    task: launchTask,
    learningPlan: pendingFocusLearningPlan,
    context: pendingFocusContext
  });
  return true;
}

function tryExitFocusMode() {
  confirmExitFocus();
}

function exitFocusConfirm() {
  if (!confirm('Are you sure you want to be distracted?')) return;
  confirmExitFocus();
}

function confirmExitFocus() {
  clearPersistedFocusSession();
  const mirroredRemoteFocus = isSyncedFocusMirrorActive();
  if (mirroredRemoteFocus) {
    clearInterval(pomodoroTimer);
    pomodoroTimer = null;
    pomodoroPhase = 'idle';
    pomodoroPhaseStartedAt = null;
    stopFocusMusic();
    focusModeOn = false;
    document.getElementById('focus-overlay').classList.remove('open');
    clearFocusLearningPlanContext();
    renderToday();
    return;
  }
  const shouldResumePausedTimer = pomodoroWasPaused && running && !ticker;
  saveActiveFocusSession();
  clearInterval(pomodoroTimer);
  pomodoroPhase = 'idle';
  pomodoroPhaseStartedAt = null;
  stopFocusMusic();
  focusModeOn = false;
  document.getElementById('focus-overlay').classList.remove('open');
  if (typeof _stopHeartbeat === 'function') _stopHeartbeat();
  if (shouldResumePausedTimer) {
    ticker = setInterval(() => {
      remaining = Math.max(0, totalSecs - Math.floor((Date.now() - timerStartedAt) / 1000));
      updateRing();
      if (remaining <= 0) doPing();
    }, 1000);
    if (typeof _startHeartbeat === 'function') _startHeartbeat();
  }
  pomodoroWasPaused = false;
  clearFocusLearningPlanContext();
  syncTimerState({ stopped: true, lastTask: null, mode: 'focus' });
  timerOwnerDeviceId = null;
  currentTask = '';
  pushHudFocusEnded();
  renderToday();
}

// ══════════════════════════════════════════════════════
// FOCUS BLOCKER
// ══════════════════════════════════════════════════════

function showFocusBlocker(reason) {
  const fbo = document.getElementById('focus-block-overlay');
  document.getElementById('fbo-title').textContent = reason || "You left focus mode";
  document.getElementById('fbo-sub').textContent = "Stay on task. Your timer is still running.";
  document.getElementById('fbo-countdown').style.display = 'none';
  document.getElementById('fbo-cd-label').style.display = 'none';
  document.getElementById('fbo-progress-wrap').style.display = 'none';
  const cancelBtn = document.getElementById('fbo-cancel-btn');
  cancelBtn.disabled = true; cancelBtn.textContent = 'Exit focus';
  fbo.classList.add('show');
}

function requestExitFocus() {
  const delay = settings.exitDelay || 10;
  let cd = delay;
  const cancelBtn = document.getElementById('fbo-cancel-btn');
  const cdEl = document.getElementById('fbo-countdown');
  const cdLabel = document.getElementById('fbo-cd-label');
  const progressFill = document.getElementById('fbo-progress-fill');
  const progressWrap = document.getElementById('fbo-progress-wrap');
  cancelBtn.disabled = true;
  cdEl.style.display = 'block'; cdLabel.style.display = 'block'; progressWrap.style.display = 'block';
  cdEl.textContent = cd;
  progressFill.style.width = '100%';
  progressFill.style.transition = 'none';
  setTimeout(() => { progressFill.style.transition = `width ${delay}s linear`; progressFill.style.width = '0%'; }, 50);
  focusBlockCountdown = setInterval(() => {
    cd--;
    cdEl.textContent = cd;
    if (cd <= 0) {
      clearInterval(focusBlockCountdown);
      document.getElementById('focus-block-overlay').classList.remove('show');
      confirmExitFocus();
    }
  }, 1000);
}

function returnToFocus() {
  clearInterval(focusBlockCountdown);
  document.getElementById('focus-block-overlay').classList.remove('show');
}

// ══════════════════════════════════════════════════════
// FOCUS TASK SUGGESTIONS
// ══════════════════════════════════════════════════════

function showFocusSuggestions(filter) {
  const el = document.getElementById('focus-suggestions');
  if (!el) return;
  const { recent, presets } = buildHeroSuggestions(filter);
  if (!recent.length && !presets.length) { el.style.display = 'none'; return; }
  _focusSugIndex = -1;
  let html = '';
  if (recent.length) {
    if (!filter) html += `<div class="hero-sug-label">Recent</div>`;
    html += recent.map(t => buildSugItem(t, `selectFocusSuggestion(event,'${t.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')`) ).join('');
  }
  if (presets.length) {
    html += `<div class="hero-sug-label">Presets</div>`;
    html += presets.map(t => buildSugItem(t, `selectFocusSuggestion(event,'${t.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')`) ).join('');
  }
  el.innerHTML = html;
  el.style.display = 'block';
}

function hideFocusSuggestions() {
  const el = document.getElementById('focus-suggestions');
  if (el) el.style.display = 'none';
  _focusSugIndex = -1;
}

function selectFocusSuggestion(e, task) {
  e.preventDefault();
  document.getElementById('focus-task-input').value = task;
  hideFocusSuggestions();
}

function handleFocusKey(e) {
  const el = document.getElementById('focus-suggestions');
  const items = el ? el.querySelectorAll('.hero-sug-item') : [];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _focusSugIndex = Math.min(_focusSugIndex + 1, items.length - 1);
    items.forEach((it, i) => it.style.background = i === _focusSugIndex ? 'var(--deep-dim)' : '');
    if (items[_focusSugIndex]) document.getElementById('focus-task-input').value = items[_focusSugIndex].querySelector('span')?.textContent||items[_focusSugIndex].textContent;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _focusSugIndex = Math.max(_focusSugIndex - 1, -1);
    items.forEach((it, i) => it.style.background = i === _focusSugIndex ? 'var(--deep-dim)' : '');
    if (_focusSugIndex >= 0 && items[_focusSugIndex]) document.getElementById('focus-task-input').value = items[_focusSugIndex].querySelector('span')?.textContent||items[_focusSugIndex].textContent;
  } else if (e.key === 'Escape') {
    hideFocusSuggestions();
  } else if (e.key === 'Enter') {
    hideFocusSuggestions();
    startPomodoro();
  }
}

// Restore any Focus session that was active when the page was last unloaded.
// index.html's inline boot script (load(), the generic ta3-timer restore)
// has already run above this in document order, and initAutoSync()'s
// Firebase listener callbacks can't possibly have fired yet (those need a
// network round-trip) — so a locally-owned session always wins over a stale
// remote mirror, consistent with the existing ownership rules in
// storage.js's isLocalFocusTimerActive()/applyRemoteTimerState().
//
// This script itself is classic (not type="module"), so it runs immediately
// during parsing — BEFORE the type="module" scripts declared earlier in the
// document (daily-routines-ui.js, learning-plan-ui.js, windows-hud-bridge.js
// etc.), which are deferred like `defer` and only run once parsing finishes.
// Those modules register onDailyRoutineFocusCompleted/onLearningPlanFocus-
// SessionEnded and window.chronaSenseHudBridge. If a persisted session's
// planned duration already elapsed while the app was closed, restoration
// calls endWorkSession()/endPomodoroBreak() to conclude it — and that path
// must see those hooks already registered, or Daily Routine / Learning Plan
// completion and the HUD push would be silently skipped on that first
// restore. So defer to DOMContentLoaded (after modules run) when parsing
// isn't finished yet; otherwise (script injected/loaded late) run inline.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', restoreFocusSession, { once: true });
} else {
  restoreFocusSession();
}
