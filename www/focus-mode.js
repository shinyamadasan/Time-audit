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
//   _startHeartbeat(), _stopHeartbeat()
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
let _pomodoroAutoStart = localStorage.getItem('ta3-pomo-auto') === '1';
let _lastFocusSyncAt = 0;
const FOCUS_SYNC_REFRESH_MS = 15000;

// ── Music state ──
let _focusMusicVolume = parseFloat(localStorage.getItem('ta3-focus-vol') || '0.3');
let _lofiTrackIdx = 0;
let _shuffleMode = localStorage.getItem('ta3-focus-shuffle') === '1';
let _shuffleQueue = [];
let _inBreakMode = false;
let _outroActive = false;

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
  return true;
}

function startPomodoro() {
  pomodoroWorkMin = parseInt(document.getElementById('pomo-work-min').value) || 25;
  pomodoroBreakMin = parseInt(document.getElementById('pomo-break-min').value) || 5;

  const taskInput = document.getElementById('focus-task-input');
  const focusTask = taskInput.value.trim();
  if (!focusTask) {
    taskInput.classList.add('focus-task-error');
    taskInput.placeholder = 'Name your focus session first';
    taskInput.focus();
    setTimeout(() => { taskInput.classList.remove('focus-task-error'); taskInput.placeholder = 'What are you focusing on?'; }, 2000);
    return;
  }
  pomodoroPhase = 'work';
  pomodoroRemaining = pomodoroWorkMin * 60;
  focusStartTime = Date.now();
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
  document.getElementById('focus-phase-sub').textContent = `work session · ${pomodoroWorkMin} min`;
  document.getElementById('focus-settings-row').style.display = 'none';
  document.getElementById('focus-start-btn').style.display = 'none';

  clearInterval(pomodoroTimer);
  pomodoroTimer = setInterval(tickPomodoro, 1000);
  updateFocusDeepBar();
  syncFocusTimerState();
}

function getFocusTaskLabel() {
  const label = document.getElementById('focus-intention-text')?.textContent?.trim();
  return (label && label !== '—') ? label : (currentTask || intention || 'Deep work');
}

function logFocusSession(tsStart, tsEnd = Date.now()) {
  const dur = Math.round((tsEnd - tsStart) / 60000);
  if (dur < 1) return null;
  const task = getFocusTaskLabel();
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
  showToast(`Logged: ${task} · ${fmtDur(dur)}`);
  updateFocusDeepBar();
  return entry;
}

function saveActiveFocusSession() {
  if (!focusStartTime) return null;
  const tsStart = focusStartTime;
  focusStartTime = null;
  if (pomodoroPhase !== 'work') return null;
  return logFocusSession(tsStart);
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

  const tsEnd = Date.now();
  const tsStart = focusStartTime || (tsEnd - pomodoroWorkMin * 60000);
  focusStartTime = null;
  logFocusSession(tsStart, tsEnd);

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
  pomodoroTimer = setInterval(tickPomodoro, 1000);
}

function endPomodoroBreak() {
  clearInterval(pomodoroTimer);
  pomodoroPhase = 'idle';
  pomodoroPhaseStartedAt = null;
  _exitBreakMusic();
  playAlertSound();

  if (_pomodoroAutoStart) {
    startPomodoro();
    return;
  }

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
  pomodoroPhaseStartedAt = null;
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

function enterFocusMode() {
  const mirroredRemoteTimer = running && timerOwnerDeviceId && timerOwnerDeviceId !== syncedDeviceId;
  const ownedSyncedFocus = running && syncedFocusTimer?.running && syncedFocusTimer.ownerDeviceId === syncedDeviceId;
  if (running && blockStartTime && !mirroredRemoteTimer && !ownedSyncedFocus) {
    const tsEnd = Date.now();
    const dur = Math.round((tsEnd - blockStartTime) / 60000);
    if (dur >= 1) {
      const task = currentTask || intention || 'Work block';
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
  taskInput.value = '';
  taskInput.style.display = 'block';
  setTimeout(() => taskInput.focus(), 300);
  document.getElementById('focus-intention-text').style.display = 'none';

  document.getElementById('pomo-autostart-btn')?.classList.toggle('active', _pomodoroAutoStart);
  document.getElementById('focus-overlay').classList.add('open');
  document.getElementById('focus-phase-label').textContent = 'POMODORO';
  document.getElementById('focus-phase-sub').textContent = 'set your timer and go';
  document.getElementById('focus-settings-row').style.display = 'flex';
  document.getElementById('focus-start-btn').textContent = 'Start';
  document.getElementById('focus-start-btn').onclick = startPomodoro;
  document.getElementById('focus-start-btn').style.display = 'block';
  setPomodoroCountdown(pomodoroWorkMin * 60);
  renderPomoDots();
  updateFocusDeepBar();
  if (ownedSyncedFocus) takeOverSyncedFocusTimer();
  else syncFocusOverlayFromRemote();
}

function tryExitFocusMode() {
  confirmExitFocus();
}

function exitFocusConfirm() {
  if (!confirm('Are you sure you want to be distracted?')) return;
  confirmExitFocus();
}

function confirmExitFocus() {
  const mirroredRemoteFocus = isSyncedFocusMirrorActive();
  if (mirroredRemoteFocus) {
    clearInterval(pomodoroTimer);
    pomodoroTimer = null;
    pomodoroPhase = 'idle';
    pomodoroPhaseStartedAt = null;
    stopFocusMusic();
    focusModeOn = false;
    document.getElementById('focus-overlay').classList.remove('open');
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
  syncTimerState({ stopped: true, lastTask: null, mode: 'focus' });
  timerOwnerDeviceId = null;
  currentTask = '';
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
