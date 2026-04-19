// ══════════════════════════════════════════════════════
// storage.js — persistence, Firebase sync, and data queries
//
// Depends on globals defined in index.html:
//   entries, settings, reviews, weeklyReviews, intention,
//   dailyCommitment, snoozesUsedToday, running, timerStartedAt,
//   totalSecs, remaining, lastTaskForRepeat,
//   fbApp, fbDb, fbRoomRef, roomCode, timerOwnerDeviceId,
//   ticker, taskStartTime, currentTask, breakActive, breakEndsAt,
//   breakTicker, breakStartTs,
//   renderToday(), renderWeek(), showToast(), updateRing(),
//   updateLiveCost(), doPing(), _updateBreakDisplay(), endBreak()
// ══════════════════════════════════════════════════════

// ── Firebase config ──
const firebaseConfig = {
  apiKey: "AIzaSyDQeoZ1o1uz7adi1fLQiC6VKFCJ-6q8kgA",
  authDomain: "time-audit-3c3da.firebaseapp.com",
  databaseURL: "https://time-audit-3c3da-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "time-audit-3c3da"
};

let syncedDeviceId = localStorage.getItem('ta3-device-id') || ('device_' + Math.random().toString(36).slice(2,8));
localStorage.setItem('ta3-device-id', syncedDeviceId);
let connectedDevices = {};

// ── Shared constants ──
const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const AWAY_BUCKETS = {
  'Sleep':      'recovery',   // Maintenance
  'Eat':        'recovery',   // Maintenance
  'Lunch':      'recovery',   // Maintenance
  'Dinner':     'recovery',   // Maintenance
  'Breakfast':  'recovery',   // Maintenance
  'Rest':       'recovery',   // Maintenance
  'Nap':        'recovery',   // Maintenance
  'Grooming':   'recovery',   // Maintenance
  'Shower':     'recovery',   // Maintenance
  'Cooking':    'recovery',   // Maintenance
  'Walk':       'exercise',
  'Exercise':   'exercise',
  'Gym':        'exercise',
  'Run':        'exercise',
  'Yoga':       'exercise',
  'Commute':    'errands',
  'Shopping':   'errands',
  'Errand':     'errands',
  'Appointment':'errands',
  'Personal':   'social',
  'Family':     'social',
  'Friends':    'social',
};

const DEFAULT_PRESETS = [
  {label:'Email / Slack',energy:'shallow'},
  {label:'Deep work',energy:'deep'},
  {label:'Meeting',energy:'shallow'},
  {label:'Job shift',energy:'nine5'},
  {label:'Social media',energy:'waste'},
  {label:'Lunch',energy:'recovery'},
  {label:'Content creation',energy:'deep'},
  {label:'Exercise',energy:'exercise'},
];

// ══════════════════════════════════════════════════════
// BUCKET CLASSIFICATION
// ══════════════════════════════════════════════════════
function getBucket(entry) {
  if (!entry) return null;
  switch (entry.energy) {
    case 'nine5':    return 'nine5';
    case 'deep':     return 'deep_work';
    case 'shallow':  return 'shallow_work';
    case 'errands':  return 'errands';
    case 'learning': return 'learning';
    case 'exercise': return 'exercise';
    case 'social':   return 'social';
    case 'recovery': return 'recovery';
    case 'waste':    return 'waste';
    // Legacy fallbacks
    case 'admin':       return 'nine5';
    case 'distraction': return 'waste';
    case 'break':       return 'recovery';
    case 'away':        return AWAY_BUCKETS[entry.activity] || 'recovery';
    default: return null;
  }
}

// ══════════════════════════════════════════════════════
// DATE & QUERY UTILS
// ══════════════════════════════════════════════════════
function toDateKey(d) {
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('en-CA', {timeZone: tz}).format(d);
}

// ── Timezone-aware display/parse helpers ──────────────────────────────────
// All functions read settings.timezone (set once, syncs to all devices).
// Never use Date.getHours() / .getDay() / .getMonth() directly — those
// return device-local values and break multi-device, multi-timezone setups.

function tzTime(ts) {
  // "9:30 AM" in user's timezone, for display
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
  }).format(new Date(ts));
}

function tzHHMM(ts) {
  // "HH:MM" (24-hour) for <input type="time"> prefill
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(ts));
  const h = (parts.find(p => p.type === 'hour')?.value || '00').replace(/^24$/, '00');
  const m =  parts.find(p => p.type === 'minute')?.value || '00';
  return `${h.padStart(2,'0')}:${m.padStart(2,'0')}`;
}

function tzHour(ts) {
  // Hour 0–23 in user's timezone
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false
  }).formatToParts(new Date(ts));
  return parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
}

function tzDow(ts) {
  // Day-of-week 0=Sun…6=Sat in user's timezone
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return DAYS.indexOf(
    new Intl.DateTimeFormat('en-US', {timeZone: tz, weekday: 'short'}).format(new Date(ts))
  );
}

function tzParseTime(dateKey, hhmm) {
  // Convert a wall-clock "HH:MM" time on dateKey (YYYY-MM-DD, in user's timezone)
  // to a UTC timestamp. Iterates to self-correct for timezone offset.
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = dateKey.split('-').map(Number);
  let ts = Date.UTC(y, mo - 1, d, h, m, 0); // start with naive UTC guess
  for (let i = 0; i < 3; i++) {
    const [ah, am] = tzHHMM(ts).split(':').map(Number);
    const diff = ((h * 60 + m) - (ah * 60 + am)) * 60000;
    ts += diff;
    if (diff === 0) break;
  }
  // For UTC+ timezones the naive guess can converge to the right wall-clock time
  // but on the wrong calendar date (one day ahead). Detect and correct.
  const landed = getDateInTZ(ts);
  if (landed !== dateKey) {
    ts += (landed < dateKey ? 1 : -1) * 24 * 60 * 60 * 1000;
  }
  return ts;
}

function getDateInTZ(ts, tz) {
  // Canonical "what calendar date is this UTC timestamp on?" in the user's timezone.
  // Always derive from the UTC timestamp — never trust the stored e.date field, which
  // may have been written with a different (or absent) timezone setting.
  tz = tz || settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('en-CA', {timeZone: tz}).format(new Date(ts));
}

function getTodayEntries() {
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayKey = getDateInTZ(Date.now(), tz);
  return entries.filter(e => {
    if (e.deleted) return false;
    // Derive the entry's date from its UTC timestamp, not the stored e.date field.
    // e.tsStart is when the block began; e.ts is when it ended. Use start if available.
    return getDateInTZ(e.tsStart || e.ts, tz) === todayKey;
  });
}

function getEntriesForDate(dateKey) {
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return entries.filter(e => {
    if (e.deleted) return false;
    return getDateInTZ(e.tsStart || e.ts, tz) === dateKey;
  });
}

function getWeekEntries(offset=0) {
  const days = getWeekDays(offset);
  const keys = new Set(days.map(d => d.key));
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return entries.filter(e => {
    if (e.deleted) return false;
    return keys.has(getDateInTZ(e.tsStart || e.ts, tz));
  });
}

function getWeekDays(offset=0) {
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayKey = toDateKey(new Date());
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const dow = tzDow(Date.now()); // day-of-week in user's timezone
  const mondayDiff = (dow === 0 ? -6 : 1 - dow) + offset * 7;
  const days = [];
  for (let i = 0; i < 7; i++) {
    // Use noon UTC so the date survives any DST boundary or large TZ offset
    const dt = new Date(Date.UTC(ty, tm - 1, td + mondayDiff + i, 12, 0, 0));
    const key = toDateKey(dt);
    const isToday = key === todayKey;
    const isFuture = key > todayKey;
    const dayE = entries.filter(e => !e.missed && !e.deleted && getDateInTZ(e.tsStart || e.ts, tz) === key);
    const label = new Intl.DateTimeFormat('en-US', {timeZone: tz, weekday: 'short'}).format(dt);
    days.push({key, label, isToday, isFuture, hasData: dayE.length > 0, entries: dayE, date: dt});
  }
  return days;
}

function getWeekKey(d) {
  // Returns e.g. "2026-W15"
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const startOfW1 = new Date(jan4);
  startOfW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const weekNum = Math.floor((d - startOfW1) / 604800000) + 1;
  return `${d.getFullYear()}-W${String(weekNum).padStart(2,'0')}`;
}

function getEntriesForWeekKey(weekKey) {
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return entries.filter(e => {
    if (!e.ts || e.deleted) return false;
    // Derive date from UTC timestamp, then build a noon-UTC date for getWeekKey()
    const dateKey = getDateInTZ(e.tsStart || e.ts, tz);
    const d = new Date(dateKey + 'T12:00:00Z');
    return getWeekKey(d) === weekKey;
  });
}

function getMonthEntries(offset=0) {
  // Target month using user's timezone date key prefix (e.g. "2026-04")
  const [y, mo] = toDateKey(new Date()).split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1 + offset, 15, 12, 0, 0)); // 15th avoids month edge issues
  const targetPrefix = toDateKey(dt).slice(0, 7);
  return entries.filter(e => {
    if (e.missed || e.away || e.deleted || !e.ts) return false;
    return getDateInTZ(e.tsStart || e.ts, settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone).startsWith(targetPrefix);
  });
}

// ══════════════════════════════════════════════════════
// DEBOUNCED RENDER
// ══════════════════════════════════════════════════════
let _renderTodayPending = false;
function scheduleRenderToday() {
  if (_renderTodayPending) return;
  _renderTodayPending = true;
  requestAnimationFrame(() => { _renderTodayPending = false; renderToday(); });
}

// ══════════════════════════════════════════════════════
// PERSIST / LOAD
// ══════════════════════════════════════════════════════
function persist() {
  // Always store entries in strict chronological order (newest first)
  entries.sort((a, b) => (b.tsStart || b.ts) - (a.tsStart || a.ts));
  localStorage.setItem('ta3-entries', JSON.stringify(entries));
  localStorage.setItem('ta3-settings', JSON.stringify(settings));
  localStorage.setItem('ta3-reviews', JSON.stringify(reviews));
  localStorage.setItem('ta3-weekly-reviews', JSON.stringify(weeklyReviews));
  localStorage.setItem('ta3-intention', intention);
  localStorage.setItem('ta3-commitment', JSON.stringify({goal: dailyCommitment, date: toDateKey(new Date()), snoozesToday: snoozesUsedToday}));
  localStorage.setItem('ta3-lv', Date.now()); // local version — used to detect unsynced changes
  if (running && timerStartedAt) {
    localStorage.setItem('ta3-timer', JSON.stringify({timerStartedAt, totalSecs, running: true, lastTask: lastTaskForRepeat, currentTask, taskStartTime}));
  } else {
    localStorage.removeItem('ta3-timer');
  }
}

function load() {
  try { const raw = JSON.parse(localStorage.getItem('ta3-entries') || '[]'); entries = Array.isArray(raw) ? raw : Object.values(raw).filter(e=>e&&e.id); } catch(e){ entries=[]; }
  // Migrate: stamp updatedAt on any entry that's missing it (older entries)
  entries.forEach(e => { if (!e.updatedAt) e.updatedAt = e.ts || Date.now(); });
  // Migrate: clear stale away:true on user-logged entries (old code preserved away flag on edits)
  entries.forEach(e => { if (e.away && e.activity && e.retro) delete e.away; });
  // Migrate: rename old energy values to 9-category system
  entries.forEach(e => {
    if      (e.energy === 'distraction') e.energy = 'waste';
    else if (e.energy === 'break')       e.energy = 'recovery';
    else if (e.energy === 'admin')       e.energy = 'nine5';
    else if (e.energy === 'away')        e.energy = AWAY_BUCKETS[e.activity] || 'recovery';
  });
  // Migrate: stamp category + originalLabel on any entry that's missing them
  entries.forEach(e => {
    if (!e.category)      e.category      = getBucket(e);
    if (!e.originalLabel) e.originalLabel = e.energy || null;
  });
  // Always sort by actual start time, newest first
  entries.sort((a, b) => (b.tsStart || b.ts) - (a.tsStart || a.ts));
  try { const s = JSON.parse(localStorage.getItem('ta3-settings')); if(s) settings={...settings,...s}; } catch(e){}
  // Dedicated timezone key wins over everything (Firebase can't overwrite it)
  const savedTz = localStorage.getItem('ta3-tz');
  if (savedTz) {
    settings.timezone = savedTz;
  } else {
    // First load with new system — auto-detect from browser and lock it in
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    settings.timezone = browserTz;
    localStorage.setItem('ta3-tz', browserTz);
  }
  try { reviews = JSON.parse(localStorage.getItem('ta3-reviews') || '{}'); } catch(e){ reviews={}; }
  try { weeklyReviews = JSON.parse(localStorage.getItem('ta3-weekly-reviews') || '{}'); } catch(e){ weeklyReviews={}; }
  intention = localStorage.getItem('ta3-intention') || '';
  if (!settings.presets?.length) settings.presets = DEFAULT_PRESETS;
  // Pre-fill intention from yesterday's "tomorrow" field if today's is empty
  if (!intention) {
    const yesterday = toDateKey(new Date(Date.now() - 86400000));
    if (reviews[yesterday]?.tomorrow) intention = reviews[yesterday].tomorrow;
  }
  // Restore daily commitment
  try {
    const c = JSON.parse(localStorage.getItem('ta3-commitment') || 'null');
    if (c && c.date === toDateKey(new Date())) {
      dailyCommitment = c.goal || 0;
      snoozesUsedToday = c.snoozesToday || 0;
    }
  } catch(e) {}
  // Restore timer state across refresh
  try {
    const saved = JSON.parse(localStorage.getItem('ta3-timer') || 'null');
    if (saved && saved.running && saved.timerStartedAt) {
      const elapsed = Math.floor((Date.now() - saved.timerStartedAt) / 1000);
      if (elapsed < saved.totalSecs) {
        timerStartedAt = saved.timerStartedAt;
        totalSecs = saved.totalSecs;
        remaining = Math.max(0, totalSecs - elapsed);
        running = true;
        lastTaskForRepeat = saved.lastTask || '';
        if (saved.currentTask) currentTask = saved.currentTask;
        if (saved.taskStartTime) taskStartTime = saved.taskStartTime;
      }
    }
  } catch(e) {}
}

// ══════════════════════════════════════════════════════
// FIREBASE AUTH
// ══════════════════════════════════════════════════════
function initAutoSync() {
  if (!firebase.apps.length) {
    fbApp = firebase.initializeApp(firebaseConfig);
  } else {
    fbApp = firebase.app();
  }
  fbDb = firebase.database();

  // Initialize Google Auth once at startup
  if (window.Capacitor && window.Capacitor.Plugins.GoogleAuth) {
    window.Capacitor.Plugins.GoogleAuth.initialize({
      clientId: '548433155531-r93hucpo6pa8darnjm5tioj1rgg4vn6s.apps.googleusercontent.com',
      scopes: ['profile', 'email'],
      grantOfflineAccess: true
    });
  }

  // Auth state drives everything — signed in = synced, signed out = show login
  firebase.auth().onAuthStateChanged(user => {
    if (user) {
      currentUser = user;
      // Use UID as room — same account on any device = same room = auto-sync
      roomCode = 'uid_' + user.uid;
      document.getElementById('signin-overlay').style.display = 'none';
      updateAuthUI(user);
      startSync();
    } else {
      currentUser = null;
      // Tear down listeners from previous session
      if (fbDb && roomCode) {
        ['timer','entries','intention','settings','devices','breakState'].forEach(k =>
          fbDb.ref(`rooms/${roomCode}/${k}`).off()
        );
        fbDb.ref('.info/connected').off();
      }
      fbRoomRef = null; roomCode = '';
      updateSyncPill('offline', 'signed out');
      updateAuthUI(null);
      document.getElementById('signin-overlay').style.display = 'flex';
    }
  });
}

async function signIn() {
  try {
    const googleUser = await window.Capacitor.Plugins.GoogleAuth.signIn();
    const credential = firebase.auth.GoogleAuthProvider.credential(
      googleUser.authentication.idToken
    );
    await firebase.auth().signInWithCredential(credential);
  } catch (err) {
    if (err && err.error !== 'popup_closed_by_user') {
      showToast('Sign-in failed: ' + (err.error || err.message || ''));
    }
  }
}

function signOutUser() {
  if (!confirm('Sign out? Your local data stays on this device.')) return;
  // Remove device presence before signing out
  if (fbDb && roomCode) {
    fbDb.ref(`rooms/${roomCode}/devices/${syncedDeviceId}`).remove();
  }
  firebase.auth().signOut();
}

function updateAuthUI(user) {
  const signedIn  = document.getElementById('auth-signed-in');
  const signedOut = document.getElementById('auth-signed-out');
  if (!signedIn || !signedOut) return;
  if (user) {
    signedIn.style.display = 'block';
    signedOut.style.display = 'none';
    const avatar = document.getElementById('auth-avatar');
    if (user.photoURL) { avatar.src = user.photoURL; avatar.style.display = 'block'; }
    document.getElementById('auth-name').textContent  = user.displayName || '';
    document.getElementById('auth-email').textContent = user.email || '';
  } else {
    signedIn.style.display  = 'none';
    signedOut.style.display = 'block';
  }
}

// ══════════════════════════════════════════════════════
// FIREBASE SYNC
// ══════════════════════════════════════════════════════
function startSync() {
  if (!fbDb) return;
  fbRoomRef = fbDb.ref(`rooms/${roomCode}`);

  fbDb.ref('.info/connected').on('value', snap => {
    const online = snap.val();
    if (online) {
      updateSyncPill('connected', 'synced');
      deviceRef.set({
        lastSeen: Date.now(),
        name: navigator.userAgent.includes('Mobile') ? '📱 Mobile' : '💻 Desktop'
      });
      // Push any local changes that happened while offline
      const lv = parseInt(localStorage.getItem('ta3-lv') || '0', 10);
      const ls = parseInt(localStorage.getItem('ta3-last-sync') || '0', 10);
      if (lv > ls) syncEntries();
    } else {
      const pill = document.getElementById('sync-pill');
      if (pill && pill.classList.contains('connected')) {
        updateSyncPill('syncing', 'offline · data saved locally');
      }
    }
  });

  // Clean up any stale devices (last seen > 30 min ago) before registering
  fbDb.ref(`rooms/${roomCode}/devices`).once('value', snap => {
    const devs = snap.val() || {};
    const cutoff = Date.now() - 30 * 60 * 1000;
    Object.entries(devs).forEach(([id, d]) => {
      if (id !== syncedDeviceId && d.lastSeen && d.lastSeen < cutoff) {
        fbDb.ref(`rooms/${roomCode}/devices/${id}`).remove();
      }
    });
  });
  const deviceRef = fbDb.ref(`rooms/${roomCode}/devices/${syncedDeviceId}`);
  deviceRef.set({
    lastSeen: Date.now(),
    name: navigator.userAgent.includes('Mobile') ? '📱 Mobile' : '💻 Desktop'
  });
  deviceRef.onDisconnect().remove();

  fbDb.ref(`rooms/${roomCode}/timer`).on('value', snap => {
    const data = snap.val();
    if (!data) return;
    if (data.ownerDeviceId) timerOwnerDeviceId = data.ownerDeviceId;
    if (data.running && data.startedAt) {
      const elapsed = Math.floor((Date.now() - data.startedAt) / 1000);
      timerStartedAt = data.startedAt;
      totalSecs = data.intervalSecs;
      remaining = Math.max(0, totalSecs - elapsed);
      if (!running) {
        running = true;
        settings.intervalMin = data.intervalSecs / 60;
        document.getElementById('interval-input').value = settings.intervalMin;
        document.getElementById('main-btn').textContent = 'Break';
        document.getElementById('timer-status').textContent = `Synced · pinging every ${settings.intervalMin} min`;
        // Show hero-active when synced timer starts
        const task = currentTask || lastTaskForRepeat || 'Work';
        if (!taskStartTime) taskStartTime = timerStartedAt || Date.now();
        document.getElementById('hero-idle').style.display = 'none';
        document.getElementById('hero-active').style.display = 'block';
        document.getElementById('hero-task-name').textContent = task;
        if (!ticker) {
          ticker = setInterval(() => {
            remaining = Math.max(0, totalSecs - Math.floor((Date.now() - timerStartedAt) / 1000));
            updateLiveCost();
            remaining <= 0 ? doPing() : updateRing();
          }, 1000);
        }
      } else {
        // Already running — just re-sync remaining without restarting ticker
        remaining = Math.max(0, totalSecs - elapsed);
        updateRing();
      }
    } else if (!data.running) {
      if (data.pausedRemaining != null) remaining = data.pausedRemaining;
      if (running) {
        running = false; clearInterval(ticker); ticker = null;
        document.getElementById('main-btn').textContent = 'Resume';
        document.getElementById('timer-status').textContent = 'Paused (synced)';
      }
    }
    if (data.intervalSecs) { totalSecs = data.intervalSecs; settings.intervalMin = data.intervalSecs/60; }
    updateRing();
  });

  fbDb.ref(`rooms/${roomCode}/entries`).on('value', snap => {
    const data = snap.val();
    if (!data) return;
    const remoteEntries = Object.values(data);
    // Build a Map for O(1) lookup and conflict resolution
    const localMap = new Map(entries.map(e => [e.id, e]));
    let changed = false;
    remoteEntries.forEach(re => {
      if (!re || !re.id) return;
      const local = localMap.get(re.id);
      if (!local) {
        // New entry from remote — skip tombstones, add live entries
        if (re.deleted) return;
        if (!re.updatedAt) re.updatedAt = re.ts || Date.now();
        entries.push(re);
        changed = true;
      } else {
        // Conflict: prefer whichever version is newer (deleted flag propagates too)
        const remoteV = re.updatedAt || re.ts || 0;
        const localV  = local.updatedAt || local.ts || 0;
        if (remoteV > localV) {
          Object.assign(local, re);
          changed = true;
        }
      }
    });
    if (changed) {
      entries.sort((a,b) => b.ts - a.ts);
      localStorage.setItem('ta3-last-sync', Date.now());
      persist();
      scheduleRenderToday();
      if (document.getElementById('view-week').classList.contains('active')) renderWeek();
    } else {
      localStorage.setItem('ta3-last-sync', Date.now());
    }
  });

  fbDb.ref(`rooms/${roomCode}/intention`).on('value', snap => {
    const val = snap.val();
    if (val && val !== intention) { intention = val; document.getElementById('intention').value = intention; persist(); }
  });

  fbDb.ref(`rooms/${roomCode}/settings`).on('value', snap => {
    const val = snap.val();
    if (!val) return;
    // Only apply remote settings if they were saved MORE RECENTLY than local ones.
    // This prevents a stale Firebase value from overwriting a timezone the user just changed.
    const remoteTs = val._savedAt || 0;
    const localTs  = settings._savedAt || 0;
    if (remoteTs > localTs && val.timezone && val.timezone !== settings.timezone) {
      settings.timezone = val.timezone;
      persist();
      renderToday();
    }
  });

  fbDb.ref(`rooms/${roomCode}/devices`).on('value', snap => {
    connectedDevices = snap.val() || {};
    updateSyncUI();
  });

  fbDb.ref(`rooms/${roomCode}/breakState`).on('value', snap => {
    const data = snap.val();
    if (!data) return;
    if (data.active && data.endsAt && !breakActive && data.startedBy !== syncedDeviceId) {
      // Remote device started a break — mirror it here
      breakEndsAt = data.endsAt;
      breakStartTs = Date.now();
      breakActive = true;
      running = false; clearInterval(ticker); ticker = null;
      document.getElementById('break-active-row').classList.add('show');
      document.getElementById('break-btn').style.display = 'none'; document.getElementById('switch-btn').style.display = 'none';
      document.getElementById('main-btn').textContent = 'On Break';
      document.getElementById('main-btn').disabled = true;
      document.getElementById('timer-status').textContent = `${data.durationMin||'?'}-min break · synced from other device`;
      _updateBreakDisplay();
      clearInterval(breakTicker);
      breakTicker = setInterval(() => { _updateBreakDisplay(); if (Date.now() >= breakEndsAt) endBreak(); }, 1000);
    } else if (!data.active && breakActive && data.startedBy !== syncedDeviceId) {
      // Remote device ended break — mirror it
      clearInterval(breakTicker); breakTicker = null;
      breakActive = false;
      document.getElementById('break-active-row').classList.remove('show');
      document.getElementById('main-btn').disabled = false;
    }
  });

  updateSyncPill('connected', 'synced');
  syncEntries();
  localStorage.setItem('ta3-last-sync', Date.now());
  showToast('Synced ✓');
}

function syncTimerState() {
  if (!fbRoomRef) return;
  fbRoomRef.update({
    timer: {
      running,
      intervalSecs: totalSecs,
      startedAt: running ? Date.now() - (totalSecs - remaining) * 1000 : null,
      pausedRemaining: running ? null : remaining,
      ownerDeviceId: timerOwnerDeviceId || null
    }
  });
}

function syncEntries() {
  if (!fbRoomRef) return;
  const updates = {};
  entries.forEach(e => { updates[`entries/e_${e.id}`] = e; });
  fbRoomRef.update(updates);
}

function syncIntention(val) {
  if (!fbRoomRef) return;
  fbRoomRef.update({ intention: val });
}

function disconnectSync() {
  if (!confirm('Disconnect from room? Your data stays local.')) return;
  if (fbDb && roomCode) {
    fbDb.ref('.info/connected').off();
    fbDb.ref(`rooms/${roomCode}/timer`).off();
    fbDb.ref(`rooms/${roomCode}/entries`).off();
    fbDb.ref(`rooms/${roomCode}/intention`).off();
    fbDb.ref(`rooms/${roomCode}/devices`).off();
    fbDb.ref(`rooms/${roomCode}/settings`).off();
    fbDb.ref(`rooms/${roomCode}/breakState`).off();
    if (fbRoomRef) fbRoomRef.off();
    fbDb.ref(`rooms/${roomCode}/devices/${syncedDeviceId}`).onDisconnect().cancel();
    fbDb.ref(`rooms/${roomCode}/devices/${syncedDeviceId}`).remove();
  }
  fbRoomRef = null; roomCode = '';
  // Generate a fresh private room so this device is isolated
  const newRoom = 'USER-' + Math.random().toString(36).slice(2,8).toUpperCase();
  localStorage.setItem('ta3-room', newRoom);
  updateSyncPill('offline', 'offline');
  const crEl = document.getElementById('connected-room');
  if (crEl) crEl.textContent = '—';
  showToast('Disconnected — data is local only');
  // Re-init so Firebase is still available for future joins
  initAutoSync();
}

function updateSyncPill(state, label) {
  ['sync-pill','sync-pill2'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.className='sync-pill'+(state==='connected'?' connected':state==='syncing'?' syncing':'');
  });
  ['sync-label','sync-label2'].forEach(id=>{ const el=document.getElementById(id); if(el) el.textContent=label; });
  ['sync-dot','sync-dot2'].forEach(id=>{
    const d=document.getElementById(id);
    if(d) d.className='sync-dot'+(state==='syncing'?' pulse':'');
  });
  const dl=document.getElementById('sync-detail-label');
  if(dl) dl.textContent =
    state==='connected' ? `Synced across all your devices` :
    state==='syncing'   ? 'Connecting…' :
                          'Not connected';
}

function updateSyncUI() {
  const devicesEl = document.getElementById('sync-devices');
  const deviceEntries = Object.entries(connectedDevices);
  if (deviceEntries.length > 0) {
    devicesEl.innerHTML =
      `<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:4px;margin-top:8px">Connected devices</div>` +
      deviceEntries.map(([id,d])=>`<div class="sync-device-row"><div class="sync-device-dot"></div>${d.name||'Device'} ${id===syncedDeviceId?'<span style="color:var(--deep)">(this device)</span>':''}</div>`).join('');
  } else { devicesEl.innerHTML = ''; }
}

function copyRoomCode() {
  if (!roomCode) { showToast('Not connected yet'); return; }
  if (navigator.clipboard && location.protocol === 'https:') {
    navigator.clipboard.writeText(roomCode)
      .then(() => showToast('Room code copied ✓'))
      .catch(() => _copyFallback(roomCode));
  } else {
    _copyFallback(roomCode);
  }
}

function _copyFallback(text) {
  const el = document.createElement('textarea');
  el.value = text;
  el.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(el);
  el.focus(); el.select();
  try { document.execCommand('copy'); showToast('Room code copied ✓'); }
  catch(e) { showToast('Your code: ' + text); }
  document.body.removeChild(el);
}

function joinRoom() {
  const input = document.getElementById('room-code-input');
  const code = (input.value || '').trim().toUpperCase();
  if (!code) { showToast('Enter a room code'); return; }
  if (code === roomCode) { showToast('Already in this room'); return; }
  // Tear down existing listeners
  if (fbDb && roomCode) {
    fbDb.ref('.info/connected').off();
    fbDb.ref(`rooms/${roomCode}/timer`).off();
    fbDb.ref(`rooms/${roomCode}/entries`).off();
    fbDb.ref(`rooms/${roomCode}/intention`).off();
    fbDb.ref(`rooms/${roomCode}/devices`).off();
    fbDb.ref(`rooms/${roomCode}/breakState`).off();
    if (fbRoomRef) fbRoomRef.off();
    fbDb.ref(`rooms/${roomCode}/devices/${syncedDeviceId}`).remove();
  }
  // Re-initialize Firebase if it never started
  if (!fbDb) {
    try {
      fbApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);
      fbDb = firebase.database();
    } catch(e) { showToast('Firebase init failed'); return; }
  }
  roomCode = code;
  localStorage.setItem('ta3-room', code);
  input.value = '';
  updateSyncPill('syncing', 'connecting…');
  startSync();
}

function tryAutoConnect() {
  const savedConfig = localStorage.getItem('ta3-firebase-config');
  const savedRoom = localStorage.getItem('ta3-room-code');
  if (!savedConfig || !savedRoom) return;
  try {
    const config = JSON.parse(savedConfig);
    document.getElementById('firebase-config-input').value = savedConfig;
    document.getElementById('room-code-input').value = savedRoom;
    updateSyncPill('syncing','connecting…');
    if (!firebase.apps.length) {
      fbApp = firebase.initializeApp(config);
    } else {
      fbApp = firebase.app();
    }
    fbDb = firebase.database();
    roomCode = savedRoom;
    startSync();
  } catch(e) {
    updateSyncPill('offline','offline');
    console.error('Auto-connect failed:', e);
  }
}
