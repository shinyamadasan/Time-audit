// ══════════════════════════════════════════════════════
// storage.js — persistence, Firebase sync, and data queries
//
// Depends on globals defined in index.html:
//   entries, settings, reviews, weeklyReviews, focusRedemptions, intention,
//   dailyCommitment, snoozesUsedToday, running, timerStartedAt,
//   totalSecs, remaining, lastTaskForRepeat,
//   fbApp, fbDb, fbRoomRef, roomCode, timerOwnerDeviceId,
//   ticker, taskStartTime, currentTask, breakActive, breakEndsAt,
//   breakTicker, breakStartTs,
//   renderToday(), renderWeek(), showToast(), showHeroState(), updateRing(),
//   updateLiveCost(), doPing(), _updateBreakDisplay(), endBreak()
// ══════════════════════════════════════════════════════

// ── App config ──
const firebaseConfig = {
  apiKey: "AIzaSyDQeoZ1o1uz7adi1fLQiC6VKFCJ-6q8kgA",
  authDomain: "time-audit-3c3da.firebaseapp.com",
  databaseURL: "https://time-audit-3c3da-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "time-audit-3c3da"
};
const GOOGLE_CLIENT_ID = '548433155531-r93hucpo6pa8darnjm5tioj1rgg4vn6s.apps.googleusercontent.com';

let syncedDeviceId = localStorage.getItem('ta3-device-id') || ('device_' + Math.random().toString(36).slice(2,8));
localStorage.setItem('ta3-device-id', syncedDeviceId);
let connectedDevices = {};
let _lastTimerSyncDetail = null;
let _syncDetailAgeTicker = null;
let _syncReconcileTicker = null;
let _syncReconcileInFlight = false;
const TIMER_SYNC_STAMP_KEY = 'ta3-timer-updated-at';
const AWAY_SYNC_STAMP_KEY = 'ta3-away-updated-at';
const SYNC_EVENT_LOG_KEY = 'ta3-sync-event-log';
const SYNC_EVENT_LOG_LIMIT = 6;
const SYNC_RECONCILE_MS = 2 * 60 * 1000;
let _syncEventLog = loadSyncEventLog();

// ── Shared constants ──
const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// Time constants
const SEAM_TOLERANCE_MS  = 2 * 60 * 1000;  // max gap between same-activity blocks to extend rather than create new
const MAX_GAP_MS         = 5 * 60 * 1000;  // max gap between consecutive same-activity blocks to merge for display
const MIN_GAP_MIN        = 5;               // minimum untracked gap (minutes) before showing a gap block
const NUDGE_MAX_AGE_MS   = 30 * 1000;      // ignore incoming nudges older than this

// Goal constants
const WORK_DAYS_PER_WEEK = 5;              // divisor for converting settings.deepGoal (weekly hrs) to daily hrs

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
/** @param {{energy:string, activity:string}} entry @returns {string|null} bucket category string */
/** @param {{energy:string,activity:string}} entry @returns {string|null} */
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
/** @param {Date} d @returns {string} YYYY-MM-DD in user timezone */
function toDateKey(d) {
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('en-CA', {timeZone: tz}).format(d);
}

// ── Timezone-aware display/parse helpers ──────────────────────────────────
// All functions read settings.timezone (set once, syncs to all devices).
// Never use Date.getHours() / .getDay() / .getMonth() directly — those
// return device-local values and break multi-device, multi-timezone setups.

/** @param {number} ts UTC ms @returns {string} "9:30 AM" in user timezone */
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

/** @param {string} dateKey YYYY-MM-DD @param {string} hhmm "HH:MM" wall-clock @returns {number} UTC ms */
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

const _dateInTZFmtCache = new Map();
/** @param {number} ts UTC ms @param {string} [tz] @returns {string} YYYY-MM-DD */
function getDateInTZ(ts, tz) {
  // Canonical "what calendar date is this UTC timestamp on?" in the user's timezone.
  // Always derive from the UTC timestamp — never trust the stored e.date field, which
  // may have been written with a different (or absent) timezone setting.
  tz = tz || settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let fmt = _dateInTZFmtCache.get(tz);
  if (!fmt) { fmt = new Intl.DateTimeFormat('en-CA', {timeZone: tz}); _dateInTZFmtCache.set(tz, fmt); }
  return fmt.format(new Date(ts));
}

/** @returns {Array} entries for today in user timezone, newest first */
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

/** @param {string} dateKey YYYY-MM-DD @returns {Array} */
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

function numberFromStorage(key) {
  const n = parseInt(localStorage.getItem(key) || '0', 10);
  return Number.isFinite(n) ? n : 0;
}

function rememberTimerSyncStamp(ts = Date.now()) {
  const stamp = Number(ts) || Date.now();
  localStorage.setItem(TIMER_SYNC_STAMP_KEY, String(stamp));
  return stamp;
}

function currentTimerSyncStamp() {
  const saved = numberFromStorage(TIMER_SYNC_STAMP_KEY);
  const activeAnchor = running ? Math.max(timerStartedAt || 0, taskStartTime || 0, blockStartTime || 0) : 0;
  return Math.max(saved, activeAnchor);
}

function remoteTimerSyncStamp(data) {
  if (!data) return 0;
  return Number(data.updatedAt || data.startedAt || data.taskStartTime || data.blockStartTime || 0) || 0;
}

function isStaleRemoteTimerState(data) {
  const remoteStamp = remoteTimerSyncStamp(data);
  const localStamp = currentTimerSyncStamp();
  return !!(remoteStamp && localStamp && remoteStamp < localStamp);
}

function rememberAwaySyncStamp(ts = Date.now()) {
  const stamp = Number(ts) || Date.now();
  localStorage.setItem(AWAY_SYNC_STAMP_KEY, String(stamp));
  return stamp;
}

function currentAwaySyncStamp() {
  return Math.max(numberFromStorage(AWAY_SYNC_STAMP_KEY), awayActive ? (awayStartTime || 0) : 0);
}

function remoteAwaySyncStamp(data) {
  if (!data) return 0;
  return Number(data.updatedAt || data.startedAt || 0) || 0;
}

function isStaleRemoteAwayState(data) {
  const remoteStamp = remoteAwaySyncStamp(data);
  const localStamp = currentAwaySyncStamp();
  return !!(remoteStamp && localStamp && remoteStamp < localStamp);
}

function loadSyncEventLog() {
  try {
    const raw = JSON.parse(localStorage.getItem(SYNC_EVENT_LOG_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(Boolean).slice(0, SYNC_EVENT_LOG_LIMIT) : [];
  } catch {
    return [];
  }
}

function syncEventWriterId(data) {
  return data && (data.updatedBy || data.startedBy || data.ownerDeviceId || '');
}

function syncEventCloudAt(data) {
  return data && (data.updatedAt || data.startedAt || data.taskStartTime || data.blockStartTime || 0);
}

function recordSyncEvent(kind, data, stateLabel) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    stateLabel,
    writerId: syncEventWriterId(data),
    ownerDeviceId: data && data.ownerDeviceId || '',
    deviceName: data && data.deviceName || '',
    cloudAt: syncEventCloudAt(data),
    seenAt: Date.now()
  };
  _syncEventLog = [event, ..._syncEventLog]
    .filter((item, idx, arr) => idx === arr.findIndex(other =>
      other.kind === item.kind &&
      other.stateLabel === item.stateLabel &&
      other.writerId === item.writerId &&
      other.cloudAt === item.cloudAt
    ))
    .slice(0, SYNC_EVENT_LOG_LIMIT);
  localStorage.setItem(SYNC_EVENT_LOG_KEY, JSON.stringify(_syncEventLog));
  renderSyncEventLog();
}

function syncEventEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function renderSyncEventLog() {
  const el = document.getElementById('sync-event-log');
  if (!el) return false;
  if (!_syncEventLog.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return false;
  }

  el.style.display = 'block';
  el.innerHTML = `<div class="sync-event-head">Recent timer / away sync</div>` +
    _syncEventLog.map(event => {
      const device = syncDeviceLabel(event.writerId, event.deviceName);
      const cloudAge = event.cloudAt ? syncAgeLabel(event.cloudAt) : 'no cloud time';
      const seenAge = syncAgeLabel(event.seenAt);
      return `<div class="sync-event-row">
        <span class="sync-event-kind">${syncEventEscape(event.kind)}</span>
        <span class="sync-event-main">${syncEventEscape(event.stateLabel)}</span>
        <span class="sync-event-meta">${syncEventEscape(device)} / cloud ${syncEventEscape(cloudAge)} / seen ${syncEventEscape(seenAge)}</span>
      </div>`;
    }).join('');
  return true;
}

// ══════════════════════════════════════════════════════
// PERSIST / LOAD
// ══════════════════════════════════════════════════════
/** Saves entries, settings, and commitment to localStorage then schedules a render. */
function persist() {
  // Always store entries in strict chronological order (newest first)
  entries.sort((a, b) => (b.tsStart || b.ts) - (a.tsStart || a.ts));
  localStorage.setItem('ta3-entries', JSON.stringify(entries));
  localStorage.setItem('ta3-settings', JSON.stringify(settings));
  localStorage.setItem('ta3-reviews', JSON.stringify(reviews));
  localStorage.setItem('ta3-weekly-reviews', JSON.stringify(weeklyReviews));
  localStorage.setItem('ta3-focus-redemptions', JSON.stringify(focusRedemptions));
  localStorage.setItem('ta3-plans', JSON.stringify(plans));
  localStorage.setItem('ta3-intention', intention);
  localStorage.setItem('ta3-commitment', JSON.stringify({goal: dailyCommitment, date: toDateKey(new Date()), snoozesToday: snoozesUsedToday}));
  localStorage.setItem('ta3-lv', Date.now()); // local version — used to detect unsynced changes
  if (running && timerStartedAt) {
    localStorage.setItem('ta3-timer', JSON.stringify({
      timerStartedAt,
      totalSecs,
      running: true,
      lastTask: lastTaskForRepeat,
      currentTask,
      taskStartTime,
      timerUpdatedAt: currentTimerSyncStamp(),
      ownerDeviceId: timerOwnerDeviceId || null
    }));
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
  // Validate schema — warns to console for any malformed entries without crashing
  entries.forEach(e => { if (!e.missed && !e.deleted) validateEntry(e); });
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
  try { focusRedemptions = JSON.parse(localStorage.getItem('ta3-focus-redemptions') || '[]'); } catch { focusRedemptions=[]; }
  if (!Array.isArray(focusRedemptions)) focusRedemptions = [];
  try { plans = JSON.parse(localStorage.getItem('ta3-plans') || '{}'); } catch { plans={}; }
  if (!plans || typeof plans !== 'object' || Array.isArray(plans)) plans = {};
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
        if (saved.timerUpdatedAt) rememberTimerSyncStamp(saved.timerUpdatedAt);
        if (saved.ownerDeviceId) timerOwnerDeviceId = saved.ownerDeviceId;
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
      clientId: GOOGLE_CLIENT_ID,
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
    if (window.Capacitor?.isNativePlatform()) {
      // Native Android app — use Capacitor Google Auth plugin
      const googleUser = await window.Capacitor.Plugins.GoogleAuth.signIn();
      const credential = firebase.auth.GoogleAuthProvider.credential(
        googleUser.authentication.idToken
      );
      await firebase.auth().signInWithCredential(credential);
    } else {
      // Web browser — use Firebase popup (works in Chrome, Edge, Safari)
      const provider = new firebase.auth.GoogleAuthProvider();
      await firebase.auth().signInWithPopup(provider);
    }
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
      startSyncReconcileTicker();
      deviceRef.set({
        lastSeen: Date.now(),
        name: navigator.userAgent.includes('Mobile') ? '📱 Mobile' : '💻 Desktop'
      });
      syncLocalActiveTimerState();
      // Push any local changes that happened while offline
      const lv = parseInt(localStorage.getItem('ta3-lv') || '0', 10);
      const ls = parseInt(localStorage.getItem('ta3-last-sync') || '0', 10);
      if (lv > ls) syncEntries();
    } else {
      stopSyncReconcileTicker();
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
    const changed = applyRemoteTimerState(snap.val());
    if (changed) {
      scheduleRenderToday();
    }
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
      const resolution = resolveEntrySync(local, re);
      if (resolution.action === 'add') {
        const entry = resolution.entry;
        if (!entry.missed && !entry.deleted) validateEntry(entry);
        entries.push(entry);
        changed = true;
      } else if (resolution.action === 'replace') {
        if (!resolution.entry.missed && !resolution.entry.deleted) validateEntry(resolution.entry);
        Object.assign(local, resolution.entry);
        changed = true;
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
    const remoteTs = val._savedAt || 0;
    const localTs  = settings._savedAt || 0;
    if (remoteTs > localTs) {
      settings = { ...settings, ...val };
      localStorage.setItem('ta3-settings', JSON.stringify(settings));
      if (val.timezone) localStorage.setItem('ta3-tz', val.timezone);
      renderToday();
      renderSettings();
    } else if ((val._templatesSavedAt || 0) > (settings._templatesSavedAt || 0)) {
      // Remote has newer templates even if overall settings are older — accept just templates
      settings.templates = val.templates || [];
      settings._templatesSavedAt = val._templatesSavedAt;
      localStorage.setItem('ta3-settings', JSON.stringify(settings));
      renderToday();
      if (document.getElementById('view-settings').classList.contains('active')) renderSettings();
    }
  });

  fbDb.ref(`rooms/${roomCode}/reviews`).on('value', snap => {
    const val = snap.val();
    if (!val) return;
    let changed = false;
    Object.entries(val).forEach(([date, review]) => {
      if (!reviews[date] || (review._savedAt || 0) > (reviews[date]._savedAt || 0)) {
        reviews[date] = review;
        changed = true;
      }
    });
    if (changed) { localStorage.setItem('ta3-reviews', JSON.stringify(reviews)); renderToday(); }
  });

  // Plans merge per date-key, then per item id by updatedAt. A whole-object last-writer-wins
  // would drop a done-toggle made on one device while another device added an item the same day.
  fbDb.ref(`rooms/${roomCode}/plans`).on('value', snap => {
    const val = snap.val();
    if (!val) return;
    let changed = false;
    Object.entries(val).forEach(([date, remote]) => {
      if (!remote) return;
      const remoteItems = normalizePlanItems(remote.items);
      const local = plans[date];
      if (!local) {
        plans[date] = { items: remoteItems, updatedAt: remote.updatedAt || 0 };
        changed = true;
        return;
      }
      const byId = new Map(normalizePlanItems(local.items).map(i => [i.id, i]));
      remoteItems.forEach(ri => {
        if (!ri || !ri.id) return;
        const li = byId.get(ri.id);
        if (!li || (ri.updatedAt || 0) > (li.updatedAt || 0)) { byId.set(ri.id, ri); changed = true; }
      });
      plans[date] = {
        items: Array.from(byId.values()),
        updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0)
      };
    });
    if (changed) {
      localStorage.setItem('ta3-plans', JSON.stringify(plans));
      if (typeof syncCommitmentFromPlan === 'function') syncCommitmentFromPlan();
      renderToday();
    }
  });

  fbDb.ref(`rooms/${roomCode}/weeklyReviews`).on('value', snap => {
    const val = snap.val();
    if (!val) return;
    let changed = false;
    Object.entries(val).forEach(([week, review]) => {
      if (!weeklyReviews[week] || (review._savedAt || 0) > (weeklyReviews[week]._savedAt || 0)) {
        weeklyReviews[week] = review;
        changed = true;
      }
    });
    if (changed) { localStorage.setItem('ta3-weekly-reviews', JSON.stringify(weeklyReviews)); }
  });

  fbDb.ref(`rooms/${roomCode}/focusRedemptions`).on('value', snap => {
    const val = snap.val();
    if (!val) return;
    let changed = false;
    Object.values(val).forEach(item => {
      if (!item || !item.id) return;
      const local = focusRedemptions.find(r => r.id === item.id);
      if (!local) {
        if (!item.deleted) focusRedemptions.push(item);
        changed = true;
      } else if ((item.updatedAt || item.createdAt || 0) > (local.updatedAt || local.createdAt || 0)) {
        Object.assign(local, item);
        changed = true;
      }
    });
    if (changed) {
      localStorage.setItem('ta3-focus-redemptions', JSON.stringify(focusRedemptions));
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

  fbDb.ref(`rooms/${roomCode}/awayState`).on('value', snap => {
    const changed = applyRemoteAwayState(snap.val());
    if (changed) scheduleRenderToday();
  });

  // Listen for incoming nudges (ignore any that are older than 30s to skip history on connect)
  _nudgesRef = fbDb.ref(`uid_${currentUser.uid}/nudges`);
  _nudgesRef.on('child_added', snap => {
    const nudge = snap.val();
    if (!nudge || !nudge.ts || Date.now() - nudge.ts > NUDGE_MAX_AGE_MS) { snap.ref.remove(); return; }
    showToast(`💪 ${nudge.from || 'Your partner'} is cheering you on!`);
    snap.ref.remove();
  });

  // Watch for partner connecting (handles the code-generator side who never calls connectPartner)
  _partnerUidRef = fbDb.ref(`uid_${currentUser.uid}/partnerUid`);
  _partnerUidRef.on('value', snap => {
    const remotePartnerUid = snap.val();
    const localPartnerUid = localStorage.getItem('ta3-partner-uid');
    if (remotePartnerUid) {
      if (remotePartnerUid !== localPartnerUid) {
        localStorage.setItem('ta3-partner-uid', remotePartnerUid);
      }
      if (!_partnerListener) initPartnerListener(remotePartnerUid);
      if (typeof renderPartnerSettings === 'function') renderPartnerSettings();
    } else if (localPartnerUid) {
      // Partner was removed from the other side
      localStorage.removeItem('ta3-partner-uid');
      localStorage.removeItem('ta3-pair-code');
      partnerData = null;
      if (_partnerListener) { _partnerListener.off(); _partnerListener = null; }
      if (typeof renderPartnerCard === 'function') renderPartnerCard();
      if (typeof renderPartnerSettings === 'function') renderPartnerSettings();
    }
  });

  startSyncDetailAgeTicker();
  updateSyncPill('connected', 'synced');
  Promise.all([syncEntries(), syncFocusRedemptions()]).then(results => {
    if (!results.some(Boolean)) return;
    localStorage.setItem('ta3-last-sync', Date.now());
    showToast('Synced ✓');
  });
}

async function forceSyncNow() {
  if (!fbRoomRef) {
    showToast('Sign in to sync first');
    return false;
  }
  const btn = document.getElementById('sync-now-btn');
  if (btn) btn.disabled = true;
  updateSyncPill('syncing', 'syncing...');
  try {
    const [timerSnap, awaySnap] = await Promise.all([
      fbRoomRef.child('timer').once('value'),
      fbRoomRef.child('awayState').once('value')
    ]);
    const timerChanged = applyRemoteTimerState(timerSnap.val());
    const awayChanged = applyRemoteAwayState(awaySnap.val());
    await Promise.all([syncEntries(), syncFocusRedemptions()]);
    localStorage.setItem('ta3-last-sync', Date.now());
    if (timerChanged || awayChanged) {
      persist();
      scheduleRenderToday();
    }
    updateSyncPill('connected', 'synced');
    showToast('Sync checked');
    return true;
  } catch (err) {
    notifySyncWriteFailed(err);
    updateSyncPill('syncing', 'sync retry needed');
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function reconcileRemoteActiveState() {
  if (!fbRoomRef || _syncReconcileInFlight) return false;
  _syncReconcileInFlight = true;
  try {
    const [timerSnap, awaySnap] = await Promise.all([
      fbRoomRef.child('timer').once('value'),
      fbRoomRef.child('awayState').once('value')
    ]);
    const timerChanged = applyRemoteTimerState(timerSnap.val());
    const awayChanged = applyRemoteAwayState(awaySnap.val());
    localStorage.setItem('ta3-last-sync', Date.now());
    if (timerChanged || awayChanged) {
      persist();
      scheduleRenderToday();
    }
    return timerChanged || awayChanged;
  } catch (err) {
    notifySyncWriteFailed(err);
    return false;
  } finally {
    _syncReconcileInFlight = false;
  }
}

function syncDeviceLabel(deviceId, fallback) {
  if (!deviceId) return 'other device';
  if (deviceId === syncedDeviceId) return 'this device';
  if (fallback) return fallback;
  const device = connectedDevices && connectedDevices[deviceId];
  return (device && device.name) || 'other device';
}

function syncAgeLabel(ts) {
  if (!ts) return 'now';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 5) return 'now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  return `${min}m ago`;
}

function updateTimerSyncDetail(data, stateLabel, kind = 'timer') {
  _lastTimerSyncDetail = { data: { ...data }, stateLabel };
  recordSyncEvent(kind, data || {}, stateLabel);
  renderTimerSyncDetail();
}

function renderTimerSyncDetail() {
  const el = document.getElementById('sync-detail-label');
  if (!el || !_lastTimerSyncDetail) return false;
  const { data, stateLabel } = _lastTimerSyncDetail;
  const device = syncDeviceLabel(data.updatedBy || data.ownerDeviceId, data.deviceName);
  const ownerName = data.ownerDeviceId
    ? syncDeviceLabel(data.ownerDeviceId, data.ownerDeviceId === data.updatedBy ? data.deviceName : null)
    : 'none';
  const source = data.updatedBy === syncedDeviceId ? 'cloud heard this device' : `cloud heard ${device}`;
  el.textContent = `${source} ${syncAgeLabel(data.updatedAt)} · owner: ${ownerName} · ${stateLabel}`;
  return true;
}

function startSyncDetailAgeTicker() {
  if (_syncDetailAgeTicker) return;
  _syncDetailAgeTicker = setInterval(() => {
    renderTimerSyncDetail();
    renderSyncEventLog();
  }, 15000);
}

function stopSyncDetailAgeTicker() {
  if (!_syncDetailAgeTicker) return;
  clearInterval(_syncDetailAgeTicker);
  _syncDetailAgeTicker = null;
}

function startSyncReconcileTicker() {
  if (_syncReconcileTicker) return;
  _syncReconcileTicker = setInterval(() => {
    reconcileRemoteActiveState();
  }, SYNC_RECONCILE_MS);
}

function stopSyncReconcileTicker() {
  if (!_syncReconcileTicker) return;
  clearInterval(_syncReconcileTicker);
  _syncReconcileTicker = null;
}

function isLocalFocusTimerActive() {
  return typeof pomodoroPhase !== 'undefined'
    && pomodoroPhase !== 'idle'
    && timerOwnerDeviceId === syncedDeviceId;
}

function syncLocalActiveTimerState() {
  if (!fbRoomRef) return false;
  if (isLocalFocusTimerActive() && typeof syncFocusTimerState === 'function') {
    syncFocusTimerState();
    return true;
  }
  if (running && timerOwnerDeviceId === syncedDeviceId) {
    syncTimerState();
    return true;
  }
  return false;
}

function applyRemoteTimerState(data) {
  if (!data) return false;
  if (isLocalFocusTimerActive() && data.updatedBy && data.updatedBy !== syncedDeviceId && !data.takeover) {
    fbTimerReceived = true;
    updateTimerSyncDetail(data, 'ignored remote timer; focus owned here');
    syncLocalActiveTimerState();
    return false;
  }
  if (isStaleRemoteTimerState(data)) {
    fbTimerReceived = true;
    updateTimerSyncDetail(data, 'ignored stale timer');
    return false;
  }
  if ('ownerDeviceId' in data) timerOwnerDeviceId = data.ownerDeviceId || null;
  if (data.intervalSecs) {
    totalSecs = data.intervalSecs;
    settings.intervalMin = data.intervalSecs / 60;
  }

  if (data.running && data.startedAt) {
    const isFocusTimer = data.mode === 'focus';
    const elapsed = Math.floor((Date.now() - data.startedAt) / 1000);
    timerStartedAt = data.startedAt;
    remaining = Math.max(0, totalSecs - elapsed);

    const remoteTask = data.lastTask || currentTask || lastTaskForRepeat || 'Work';
    const remoteTaskStart = data.taskStartTime || data.blockStartTime || data.startedAt;
    currentTask = remoteTask;
    lastTaskForRepeat = remoteTask;
    taskStartTime = remoteTaskStart;
    blockStartTime = data.blockStartTime || remoteTaskStart;
    if (awayActive) {
      clearInterval(awayElapsedTicker);
      awayElapsedTicker = null;
      awayActive = false;
      awayStartTime = null;
      awayLabel = 'Away';
    }
    if (breakActive) {
      clearInterval(breakTicker);
      breakTicker = null;
      breakActive = false;
      const breakRow = document.getElementById('break-active-row');
      if (breakRow) breakRow.classList.remove('show');
    }

    const nameEl = document.getElementById('hero-task-name');
    if (nameEl) nameEl.textContent = remoteTask;
    if (isFocusTimer) {
      syncedFocusTimer = {
        running: true,
        task: remoteTask,
        focusPhase: data.focusPhase || 'work',
        startedAt: data.startedAt,
        intervalSecs: totalSecs,
        ownerDeviceId: data.ownerDeviceId || data.updatedBy || null,
        updatedAt: data.updatedAt || Date.now(),
        deviceName: data.deviceName || null
      };
      if (typeof syncFocusOverlayFromRemote === 'function') syncFocusOverlayFromRemote();
    } else {
      syncedFocusTimer = null;
    }

    if (!running) {
      running = true;
      const intervalEl = document.getElementById('interval-input');
      if (intervalEl) intervalEl.value = settings.intervalMin;
      document.getElementById('main-btn').textContent = 'Break';
      showHeroState('active');
      document.getElementById('activity-hero').classList.add('tracking');
      if (!ticker) {
        ticker = setInterval(() => {
          remaining = Math.max(0, totalSecs - Math.floor((Date.now() - timerStartedAt) / 1000));
          updateLiveCost();
          remaining <= 0 ? doPing() : updateRing();
        }, 1000);
      }
    }
    document.getElementById('timer-status').textContent = isFocusTimer
      ? `Focus synced · ${remoteTask}`
      : `Synced · pinging every ${settings.intervalMin} min`;
    updateTimerTaskLabel();
    rememberTimerSyncStamp(remoteTimerSyncStamp(data) || Date.now());
    updateTimerSyncDetail(data, `${isFocusTimer ? 'focus' : 'active'}: ${remoteTask}`);
    fbTimerReceived = true;
    updateRing();
    persist();
    scheduleRenderToday();
    return true;
  }

  if (!data.running) {
    fbTimerReceived = true;
    if (data.stopped) {
      const hadTimer = running || !!taskStartTime || !!timerStartedAt || !!currentTask;
      rememberTimerSyncStamp(remoteTimerSyncStamp(data) || Date.now());
      if (data.mode === 'focus') {
        syncedFocusTimer = null;
        if (typeof clearSyncedFocusOverlay === 'function') clearSyncedFocusOverlay();
      }
      if (hadTimer) resetTimer();
      updateTimerSyncDetail(data, 'timer stopped');
      return hadTimer;
    }

    if (data.pausedRemaining != null) remaining = data.pausedRemaining;
    if (running) {
      running = false;
      clearInterval(ticker);
      ticker = null;
      persist();
      document.getElementById('main-btn').textContent = 'Resume';
      document.getElementById('timer-status').textContent = 'Paused (synced)';
      updateTimerTaskLabel();
      rememberTimerSyncStamp(remoteTimerSyncStamp(data) || Date.now());
      updateTimerSyncDetail(data, 'timer paused');
      updateRing();
      return true;
    }
    rememberTimerSyncStamp(remoteTimerSyncStamp(data) || Date.now());
    updateTimerSyncDetail(data, 'timer idle');
  }
  updateRing();
  return false;
}

function applyRemoteAwayState(data) {
  if (!data) return false;
  if (isStaleRemoteAwayState(data)) {
    updateTimerSyncDetail({
      updatedAt: data.updatedAt || data.startedAt || Date.now(),
      updatedBy: data.startedBy,
      deviceName: data.deviceName
    }, 'ignored stale away', 'away');
    return false;
  }
  if (data.startedBy === syncedDeviceId) {
    if (data.updatedAt || data.startedAt) rememberAwaySyncStamp(remoteAwaySyncStamp(data));
    return false;
  }
  if (data.active && data.label) {
    const startedAt = data.startedAt || Date.now();
    const changed = !awayActive || awayLabel !== data.label || awayStartTime !== startedAt;
    if (!changed) return false;

    rememberAwaySyncStamp(remoteAwaySyncStamp(data) || Date.now());
    const mirroredTimer = running && (!timerOwnerDeviceId || timerOwnerDeviceId !== syncedDeviceId);
    if (mirroredTimer) {
      running = false;
      clearInterval(ticker);
      ticker = null;
      if (typeof _stopHeartbeat === 'function') _stopHeartbeat();
      if (typeof cancelNativePing === 'function') cancelNativePing();
      timerStartedAt = null;
      taskStartTime = null;
      blockStartTime = null;
      timerOwnerDeviceId = null;
      currentTask = '';
      totalSecs = settings.intervalMin * 60;
      remaining = totalSecs;
      const mainBtn = document.getElementById('main-btn');
      if (mainBtn) { mainBtn.textContent = 'Start'; mainBtn.disabled = false; }
      const switchBtn = document.getElementById('switch-btn');
      if (switchBtn) switchBtn.style.display = 'none';
      const breakBtn = document.getElementById('break-btn');
      if (breakBtn) breakBtn.style.display = 'none';
      updateTimerTaskLabel();
    }
    awayActive = true;
    awayStartTime = startedAt;
    awayLabel = data.label;
    showHeroState('away');
    const labelEl = document.getElementById('hero-away-label');
    if (labelEl) labelEl.textContent = data.label;
    clearInterval(awayElapsedTicker);
    const renderElapsed = () => {
      const s = Math.floor((Date.now() - awayStartTime) / 1000);
      const el = document.getElementById('hero-away-elapsed');
      if (el) el.textContent = `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
    };
    renderElapsed();
    awayElapsedTicker = setInterval(renderElapsed, 1000);
    const statusEl = document.getElementById('timer-status');
    if (statusEl) statusEl.textContent = `Away · ${data.label} · synced`;
    updateTimerSyncDetail({
      updatedAt: data.updatedAt || Date.now(),
      updatedBy: data.startedBy,
      deviceName: data.deviceName
    }, `away: ${data.label}`, 'away');
    return true;
  }
  if (!data.active && awayActive) {
    // Remote ended away — clear local away UI. The device ending away owns the entry log.
    rememberAwaySyncStamp(remoteAwaySyncStamp(data) || Date.now());
    clearInterval(awayElapsedTicker);
    awayElapsedTicker = null;
    awayActive = false;
    awayStartTime = null;
    awayLabel = 'Away';
    showHeroState('idle');
    updateTimerSyncDetail({
      updatedAt: data.updatedAt || Date.now(),
      updatedBy: data.startedBy,
      deviceName: data.deviceName
    }, 'away ended', 'away');
    return true;
  }
  return false;
}

function syncTimerState(extra = {}) {
  if (!fbRoomRef) return;
  const now = Date.now();
  rememberTimerSyncStamp(now);
  const isStopped = !!extra.stopped;
  const hasExplicitRunning = Object.prototype.hasOwnProperty.call(extra, 'running');
  const isRunning = isStopped ? false : (hasExplicitRunning ? !!extra.running : running);
  const intervalSecs = extra.intervalSecs || totalSecs;
  const startedAt = Object.prototype.hasOwnProperty.call(extra, 'startedAt')
    ? extra.startedAt
    : (isRunning ? Date.now() - (intervalSecs - remaining) * 1000 : null);
  const taskAnchor = extra.taskStartTime || taskStartTime || blockStartTime || timerStartedAt || startedAt || now;
  const blockAnchor = extra.blockStartTime || blockStartTime || taskStartTime || timerStartedAt || startedAt || now;
  const lastTask = Object.prototype.hasOwnProperty.call(extra, 'lastTask')
    ? extra.lastTask
    : (currentTask || lastTaskForRepeat || null);
  const timer = {
    lastTask,
    running: isRunning,
    stopped: isStopped,
    intervalSecs,
    startedAt: isRunning ? startedAt : null,
    taskStartTime: isRunning ? taskAnchor : null,
    blockStartTime: isRunning ? blockAnchor : null,
    pausedRemaining: isRunning || isStopped ? null : remaining,
    ownerDeviceId: isStopped ? null : (extra.ownerDeviceId || timerOwnerDeviceId || null),
    mode: extra.mode || null,
    focusPhase: extra.focusPhase || null,
    takeover: !!extra.takeover,
    updatedAt: now,
    updatedBy: syncedDeviceId,
    deviceName: navigator.userAgent.includes('Mobile') ? 'phone' : 'PC'
  };
  fbRoomRef.update({
    timer
  });
  updateTimerSyncDetail(timer, extra.stateLabel || (timer.running
    ? `${timer.mode === 'focus' ? 'focus' : 'active'}: ${timer.lastTask || 'Work'}`
    : timer.stopped ? 'timer stopped' : 'timer paused'));
}

function resolveEntrySync(local, remote, nowTs = Date.now()) {
  if (!remote || !remote.id) return { action: 'skip' };
  const remoteEntry = remote.updatedAt ? remote : { ...remote, updatedAt: remote.ts || nowTs };
  if (!local) {
    return remoteEntry.deleted ? { action: 'skip' } : { action: 'add', entry: remoteEntry };
  }
  if (local.deleted && !remoteEntry.deleted) {
    const remoteV = remoteEntry.updatedAt || remoteEntry.ts || 0;
    const localV = local.updatedAt || local.ts || 0;
    if (remoteEntry.undoRestoredAt && remoteV > localV) return { action: 'replace', entry: remoteEntry };
    return { action: 'keep-local' };
  }
  const remoteV = remoteEntry.updatedAt || remoteEntry.ts || 0;
  const localV  = local.updatedAt || local.ts || 0;
  return remoteV > localV ? { action: 'replace', entry: remoteEntry } : { action: 'keep-local' };
}

let _lastSyncErrorToastAt = 0;
function notifySyncWriteFailed(err) {
  console.warn('Sync write failed', err);
  const now = Date.now();
  if (now - _lastSyncErrorToastAt < 30000) return;
  _lastSyncErrorToastAt = now;
  if (typeof showToast === 'function') showToast('Sync failed — saved locally');
}

function syncEntries() {
  if (!fbRoomRef) return Promise.resolve(false);
  const updates = {};
  entries.forEach(e => { updates[`entries/e_${e.id}`] = e; });
  return fbRoomRef.update(updates)
    .then(() => { publishPublicStats(); return true; })
    .catch(err => { notifySyncWriteFailed(err); return false; });
}

function syncFocusRedemptions() {
  if (!fbRoomRef) return Promise.resolve(false);
  const updates = {};
  focusRedemptions.forEach(item => {
    if (item && item.id) updates[`focusRedemptions/r_${item.id}`] = item;
  });
  if (!Object.keys(updates).length) return Promise.resolve(false);
  return fbRoomRef.update(updates)
    .then(() => true)
    .catch(err => { notifySyncWriteFailed(err); return false; });
}

function publishPublicStats() {
  if (!fbDb || !currentUser) return;
  const todayE = getTodayEntries().filter(e => !e.missed && !e.deleted);
  const todayKey = getDateInTZ(Date.now(), settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const deepMinsToday = typeof sumEnergyMinutes === 'function'
    ? sumEnergyMinutes(todayE, 'deep', todayKey)
    : todayE.filter(e => e.energy === 'deep').reduce((s, e) => s + (e.blockIntervalMin || settings.intervalMin || 30), 0);
  const deepHrsToday = +(deepMinsToday / 60).toFixed(1);
  fbDb.ref(`uid_${currentUser.uid}/public`).set({
    deepHrsToday,
    streak: computeStreak(),
    name: currentUser.displayName || currentUser.email?.split('@')[0] || 'Partner',
    avatar: settings.avatar || '👤',
    dateKey: toDateKey(new Date()),
    updatedAt: Date.now()
  });
}

let _partnerListener = null;
let _nudgesRef      = null;
let _partnerUidRef  = null;

/** Removes all active Firebase room listeners. Call before switching rooms or signing out. */
function teardownRoomListeners() {
  if (!fbDb || !roomCode) return;
  stopSyncDetailAgeTicker();
  stopSyncReconcileTicker();
  const paths = ['timer','entries','intention','devices','settings','breakState','reviews','weeklyReviews','focusRedemptions','awayState','plans'];
  paths.forEach(p => fbDb.ref(`rooms/${roomCode}/${p}`).off());
  fbDb.ref('.info/connected').off();
  if (fbRoomRef) fbRoomRef.off();
  if (_nudgesRef)     { _nudgesRef.off();     _nudgesRef     = null; }
  if (_partnerUidRef) { _partnerUidRef.off(); _partnerUidRef = null; }
  if (_partnerListener) { _partnerListener.off(); _partnerListener = null; }
}

function initPartnerListener(partnerUid) {
  if (_partnerListener) { _partnerListener.off(); _partnerListener = null; }
  _partnerListener = fbDb.ref(`uid_${partnerUid}/public`);
  _partnerListener.on('value', snap => {
    partnerData = snap.val();
    if (typeof renderPartnerCard === 'function') renderPartnerCard();
    if (typeof renderPartnerSettings === 'function') renderPartnerSettings();
  });
}

function syncIntention(val) {
  if (!fbRoomRef) return;
  fbRoomRef.update({ intention: val });
}

/** Firebase stores sparse arrays as objects — always read plan items back as a real array. */
function normalizePlanItems(items) {
  if (Array.isArray(items)) return items.filter(Boolean);
  if (items && typeof items === 'object') return Object.values(items).filter(Boolean);
  return [];
}

function syncPlans(dateKey) {
  if (!fbRoomRef || !dateKey || !plans[dateKey]) return;
  fbRoomRef.update({ [`plans/${dateKey}`]: plans[dateKey] });
}

function disconnectSync() {
  if (!confirm('Disconnect from room? Your data stays local.')) return;
  if (fbDb && roomCode) {
    teardownRoomListeners();
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
  if(dl) {
    const renderedTimer = state === 'connected' && renderTimerSyncDetail();
    if (!renderedTimer) {
      dl.textContent =
        state==='connected' ? `Synced across all your devices` :
        state==='syncing'   ? 'Connecting...' :
                              'Not connected';
    }
  }
  renderSyncEventLog();
}

function updateSyncUI() {
  const devicesEl = document.getElementById('sync-devices');
  const deviceEntries = Object.entries(connectedDevices);
  if (deviceEntries.length > 0) {
    devicesEl.innerHTML =
      `<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:4px;margin-top:8px">Connected devices</div>` +
      deviceEntries.map(([id,d])=>`<div class="sync-device-row"><div class="sync-device-dot"></div>${d.name||'Device'} ${id===syncedDeviceId?'<span style="color:var(--deep)">(this device)</span>':''}</div>`).join('');
  } else { devicesEl.innerHTML = ''; }
  renderSyncEventLog();
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
    teardownRoomListeners();
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

// ── Entry schema validation ──────────────────────────────────────────────────
const VALID_ENERGY = new Set(['deep','shallow','nine5','errands','learning','exercise','social','recovery','waste','admin','distraction','break','away']);
const DATE_KEY_RE  = /^\d{4}-\d{2}-\d{2}$/;

// Warns to console if a newly created entry is missing required fields.
// Never throws — validation is defensive only; a malformed entry is better than a crash.
/** Warns to console if a newly created entry is missing required fields. Never throws. @param {Object} entry */
function validateEntry(entry) {
  const problems = [];
  if (typeof entry.id !== 'number' || entry.id <= 0)        problems.push('id invalid');
  if (typeof entry.ts !== 'number' || entry.ts <= 0)        problems.push('ts invalid');
  if (typeof entry.blockIntervalMin !== 'number' || entry.blockIntervalMin < 1) problems.push('blockIntervalMin < 1');
  if (!entry.activity || typeof entry.activity !== 'string') problems.push('activity missing');
  if (!VALID_ENERGY.has(entry.energy))                       problems.push(`energy "${entry.energy}" not recognised`);
  if (!DATE_KEY_RE.test(entry.date))                         problems.push(`date "${entry.date}" not YYYY-MM-DD`);
  if (problems.length) console.warn('[validateEntry]', problems.join('; '), entry);
}

// ── Goal helpers ─────────────────────────────────────────────────────────────
// settings.deepGoal is stored as hours/week. All daily calculations must use these helpers.
/** @returns {number} daily deep-work goal in hours (settings.deepGoal / WORK_DAYS_PER_WEEK) */
function getDailyGoalHrs()  { return (settings.deepGoal || 0) / WORK_DAYS_PER_WEEK; }
/** @returns {number} daily deep-work goal in minutes */
function getDailyGoalMins() { return getDailyGoalHrs() * 60; }
/** @returns {number} weekly deep-work goal in minutes */
function getWeeklyGoalMins(){ return (settings.deepGoal || 0) * 60; }

// ── Date range helpers — moved from index.html ──────────────────────────────
// End of day as UTC ms for a YYYY-MM-DD key (= start of next calendar day - 1 ms)
/** @param {string} dateKey YYYY-MM-DD @returns {number} UTC ms at end of that calendar day */
function dayEndTs(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nextKey = `${y}-${String(mo).padStart(2,'0')}-${String(d+1).padStart(2,'0')}`;
  return tzParseTime(nextKey, '00:00') - 1;
}

// Earliest entry timestamp for the work day — used as the gap anchor by computeGaps.
// ⚠ ANCHOR: computeGaps() depends on this; changing it shifts where gaps appear on the timeline.
/** @param {Array} [entriesOverride] @returns {number} UTC ms of earliest entry — gap anchor for computeGaps */
function getWorkDayStartTs(entriesOverride) {
  const todayEntries = (entriesOverride || getTodayEntries()).filter(e => !e.missed && (e.tsStart || e.ts));
  if (!todayEntries.length) return Date.now();
  return Math.min(...todayEntries.map(e => e.tsStart || e.ts));
}
