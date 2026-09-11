import { FIREBASE_CONFIG, TRACKED_SITES, MIN_SESSION_MS, MERGE_WINDOW_MS } from './firebase-config.js';

// ── State ──
let activeTab  = null;
let authToken  = null;
let uid        = null;
let trackedSites = {};  // loaded from storage, merges defaults + custom
let userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;  // fallback to device
// True only once userTimezone has been set FROM the account's Firebase settings
// (fetchUserTimezone succeeded) — as opposed to the device-OS fallback above or a
// previously-cached value of unknown freshness. Time Truth V1: provenance only,
// never used to silently accept a wrong-day assignment as if it were confirmed.
let userTimezoneConfirmed = false;
let lastSessionByDomain = {};  // domain → { startTs, endTs } for merge window

// Time Truth V1 — idle/sleep guard. chrome.idle has no signal finer than this, and we
// don't want to micromanage seconds of inactivity — 5 minutes is a conservative AFK/
// lock/sleep threshold, not a productivity timer.
const IDLE_THRESHOLD_SECONDS = 300;
// The last moment chrome.idle confirmed (or a fresh sign-in/tab-focus implied) the
// user was actually active. Session boundaries are capped here, never bridged past it —
// an unobserved gap (idle, lock, sleep, a long-dead service worker) must not become
// confirmed duration.
let lastHeartbeat = Date.now();

// ── Startup ──
// Called on install/update AND on every service worker restart (MV3 workers are killed after inactivity)
chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);
init(); // also run immediately on every service worker start to restore uid/authToken

async function init() {
  const stored = await chrome.storage.local.get(['uid', 'authToken', 'customSites', 'removedSites', 'userTimezone', 'userTimezoneConfirmed', 'activeTab', 'lastSessionByDomain', 'lastHeartbeat']);
  uid          = stored.uid          || null;
  authToken    = stored.authToken    || null;
  userTimezone = stored.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  userTimezoneConfirmed = !!stored.userTimezoneConfirmed;
  lastHeartbeat = stored.lastHeartbeat || Date.now();
  loadTrackedSites(stored.customSites || {}, stored.removedSites || []);
  if (stored.lastSessionByDomain) lastSessionByDomain = stored.lastSessionByDomain;

  try { chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS); } catch (e) { /* idle API unavailable */ }

  // Restore active session so SW restarts don't create duplicate entries — but first
  // check whether the gap since our last confirmed-active heartbeat is itself larger
  // than the idle threshold. A long-dead service worker, a suspended browser, or a
  // sleeping computer all look identical from here: elapsed wall-clock time with no
  // heartbeat to back it. Don't bridge that gap as continuous use — close the prior
  // session out at the last confirmed-active moment instead.
  if (stored.activeTab) {
    activeTab = stored.activeTab;
    if (Date.now() - lastHeartbeat > IDLE_THRESHOLD_SECONDS * 1000) {
      closeSessionAtHeartbeat();
    }
  }

  if (uid) {
    chrome.alarms.create('flush', { periodInMinutes: 5 });
    // Best-effort refresh so a timezone change made later in the web app eventually
    // reaches the extension without requiring an explicit sign-out/sign-in. Cheap
    // (one GET), fire-and-forget — never blocks startup or tracking.
    if (authToken) fetchUserTimezone(uid, authToken);
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const currentDomain = getAnyDomain(tabs[0].url);
      if (activeTab && activeTab.domain === currentDomain) {
        // Same site — continue the existing session, just refresh url/title
        activeTab.url   = tabs[0].url;
        activeTab.title = tabs[0].title;
      } else {
        // Different site or no stored session — flush old and start fresh
        switchTab(tabs[0].url, tabs[0].title);
      }
    });
  }
}

function markHeartbeat() {
  lastHeartbeat = Date.now();
  chrome.storage.local.set({ lastHeartbeat });
}

// Closes out the current session at the last confirmed-active heartbeat rather than
// at "now" — used whenever we discover the user went idle/locked/away without a clean
// flush event (idle-state transition, periodic alarm finding idle, or a service-worker
// restart after an unobserved gap). Never logs time past the heartbeat.
function closeSessionAtHeartbeat() {
  if (!activeTab) return;
  const endTs = Math.max(activeTab.startedAt, lastHeartbeat);
  const durationMs = endTs - activeTab.startedAt;
  const tab = activeTab;
  activeTab = null;
  chrome.storage.local.remove('activeTab');
  if (durationMs >= MIN_SESSION_MS && trackedSites[tab.domain]) {
    logSession(tab.domain, tab.title, tab.sessionId, endTs, endTs - tab.sessionId);
  }
}

// ── Tab listeners registered at top level so they survive service worker restarts ──
chrome.tabs.onActivated.addListener(onTabActivated);
chrome.tabs.onUpdated.addListener(onTabUpdated);
chrome.windows.onFocusChanged.addListener(onFocusChanged);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'flush') flushAndRestart();
});

// System-level idle/lock/active signal — the one thing tab events can't tell us.
// 'active' resumes tracking (and starts a fresh session if none is running); 'idle'
// or 'locked' closes out the current session at the last confirmed-active moment so
// the AFK/lock time itself is never counted.
try {
  chrome.idle.onStateChanged.addListener((state) => {
    if (state === 'active') {
      markHeartbeat();
      if (!activeTab) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
          if (tabs[0]) recordStart(tabs[0].url, tabs[0].title);
        });
      }
    } else {
      closeSessionAtHeartbeat();
    }
  });
} catch (e) { /* idle API unavailable */ }

function loadTrackedSites(customSites, removedSites) {
  trackedSites = {};
  // Add defaults (skip removed ones)
  for (const [domain, cfg] of Object.entries(TRACKED_SITES)) {
    if (!removedSites.includes(domain)) {
      const label  = typeof cfg === 'string' ? cfg : cfg.label;
      const energy = typeof cfg === 'string' ? 'waste' : (cfg.energy || 'waste');
      trackedSites[domain] = { label, energy, custom: false };
    }
  }
  // Add custom sites (stored as plain strings or objects)
  for (const [domain, cfg] of Object.entries(customSites)) {
    const label  = typeof cfg === 'string' ? cfg : cfg.label;
    const energy = typeof cfg === 'string' ? 'waste' : (cfg.energy || 'waste');
    trackedSites[domain] = { label, energy, custom: true };
  }
}

async function saveSites(customSites, removedSites) {
  await chrome.storage.local.set({ customSites, removedSites });
  loadTrackedSites(customSites, removedSites);
}

// ── Auth ──
async function getGoogleAccessToken(interactive) {
  const redirectUrl = chrome.identity.getRedirectURL();
  const clientId = '548433155531-abvpt7urujs8rjccma2o4petf726fueo.apps.googleusercontent.com';
  const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUrl);
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile');

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive },
      (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(chrome.runtime.lastError?.message || 'Auth cancelled');
          return;
        }
        const hash = new URL(responseUrl).hash.substring(1);
        const params = new URLSearchParams(hash);
        const token = params.get('access_token');
        token ? resolve(token) : reject('No access token in response');
      }
    );
  });
}

async function exchangeTokenWithFirebase(googleToken) {
  const fbRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: `access_token=${googleToken}&providerId=google.com`,
        requestUri: 'http://localhost',
        returnIdpCredential: true,
        returnSecureToken: true
      })
    }
  );
  const data = await fbRes.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

export async function signIn() {
  try {
    const googleToken = await getGoogleAccessToken(true);
    const userInfo = await fetch(`https://www.googleapis.com/oauth2/v1/userinfo?access_token=${googleToken}`).then(r => r.json());
    const fbData = await exchangeTokenWithFirebase(googleToken);
    uid       = fbData.localId;
    authToken = fbData.idToken;
    await chrome.storage.local.set({ uid, authToken, email: userInfo.email, googleToken, fbRefreshToken: fbData.refreshToken });
    // Resolve the account timezone BEFORE tracking starts — Time Truth V1: a session
    // logged before this resolves would otherwise date-key on the device OS fallback.
    // Best-effort: if the fetch fails (offline, no timezone set yet), tracking still
    // starts rather than blocking sign-in indefinitely; userTimezoneConfirmed stays
    // false and init() will keep retrying on later service-worker wakes.
    await fetchUserTimezone(fbData.localId, fbData.idToken);
    startTracking();
    return { uid, email: userInfo.email };
  } catch (e) {
    throw new Error(e.message || 'Sign in failed');
  }
}

export async function signOut() {
  flushActiveTab();
  uid = null; authToken = null; activeTab = null;
  await chrome.storage.local.remove(['uid', 'authToken', 'email', 'googleToken']);
  chrome.tabs.onActivated.removeListener(onTabActivated);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);
  chrome.windows.onFocusChanged.removeListener(onFocusChanged);
}

// Refresh token using Firebase refreshToken (no Google re-auth needed)
async function refreshAuthToken() {
  try {
    const stored = await chrome.storage.local.get(['fbRefreshToken']);
    if (!stored.fbRefreshToken) { console.warn('[Chronasense] no refresh token stored — please sign out and sign back in'); return false; }
    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: stored.fbRefreshToken })
      }
    );
    const data = await res.json();
    if (!data.id_token) { console.warn('[Chronasense] token refresh failed', data); return false; }
    authToken = data.id_token;
    await chrome.storage.local.set({ authToken, fbRefreshToken: data.refresh_token || stored.fbRefreshToken });
    console.log('[Chronasense] token refreshed ok');
    return true;
  } catch (e) { console.warn('[Chronasense] refresh error', e); return false; }
}


// ── Tab tracking ──
function startTracking() {
  chrome.alarms.create('flush', { periodInMinutes: 5 });
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (tabs[0]) recordStart(tabs[0].url, tabs[0].title);
  });
}

function onTabActivated(info) {
  chrome.tabs.get(info.tabId, (tab) => {
    if (tab) switchTab(tab.url, tab.title);
  });
}

function onTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.status === 'complete' && tab.active) {
    switchTab(tab.url, tab.title);
  }
}

function onFocusChanged(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    flushActiveTab();
  } else {
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
      if (tabs[0]) switchTab(tabs[0].url, tabs[0].title);
    });
  }
}

function switchTab(url, title) {
  flushActiveTab();
  recordStart(url, title);
}

function recordStart(url, title) {
  const domain = getAnyDomain(url);
  if (!domain) { activeTab = null; chrome.storage.local.remove('activeTab'); return; }
  const now = Date.now();
  activeTab = { url, title, domain, startedAt: now, sessionId: now };
  chrome.storage.local.set({ activeTab });
  markHeartbeat();
}

function flushActiveTab() {
  if (!activeTab) return;
  const now = Date.now();
  const durationMs = now - activeTab.startedAt;
  const tab = activeTab;
  activeTab = null;
  chrome.storage.local.remove('activeTab');
  if (durationMs < MIN_SESSION_MS) return;
  if (trackedSites[tab.domain]) {
    console.log('[Chronasense] flush:', tab.domain, Math.round(durationMs/1000)+'s → logging');
    logSession(tab.domain, tab.title, tab.sessionId, now, now - tab.sessionId);
  } else {
    maybeNotifyUnknown(tab.domain, durationMs);
  }
}

// Periodic 5-minute alarm for a still-open session. Time Truth V1: before trusting
// "now" as genuine continued use, reconfirm the user is actually active — this is the
// one place a computer-sleep/long-AFK gap would otherwise silently bridge forward as
// five more minutes of confirmed duration, repeated indefinitely.
async function flushAndRestart() {
  if (!activeTab) return;
  let state = 'active';
  try { state = await chrome.idle.queryState(IDLE_THRESHOLD_SECONDS); } catch (e) { /* idle API unavailable — assume active */ }
  if (state !== 'active') {
    closeSessionAtHeartbeat();
    return;
  }
  markHeartbeat();
  const now = Date.now();
  const durationMs = now - activeTab.startedAt;
  if (durationMs >= MIN_SESSION_MS && trackedSites[activeTab.domain]) {
    logSession(activeTab.domain, activeTab.title, activeTab.sessionId, now, now - activeTab.sessionId);
  }
  activeTab = { ...activeTab, startedAt: now };
  chrome.storage.local.set({ activeTab });
}

async function maybeNotifyUnknown(domain, durationMs) {
  const stored = await chrome.storage.local.get(['dismissedSites']);
  const dismissed = stored.dismissedSites || [];
  if (dismissed.includes(domain)) return;

  const mins = Math.round(durationMs / 60000);
  chrome.notifications.create(`unknown:${domain}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon128.png'),
    title: 'Untracked site',
    message: `You spent ${mins}m on ${domain}. Add to Chronasense tracking?`,
    buttons: [{ title: 'Track this' }, { title: 'Never ask' }],
    requireInteraction: true
  });
}

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIndex) => {
  if (!notifId.startsWith('unknown:')) return;
  const domain = notifId.slice(8);
  chrome.notifications.clear(notifId);
  if (btnIndex === 0) {
    // Pre-fill popup and open it
    await chrome.storage.local.set({ pendingAddDomain: domain });
    chrome.action.openPopup().catch(() => {
      // openPopup() may fail if not user-initiated — store for next popup open
    });
  } else {
    // Never ask again for this domain
    const stored = await chrome.storage.local.get(['dismissedSites']);
    const dismissed = stored.dismissedSites || [];
    if (!dismissed.includes(domain)) dismissed.push(domain);
    await chrome.storage.local.set({ dismissedSites: dismissed });
  }
});

// ── Firebase logging ──
async function logSession(domain, title, startTs, endTs, durationMs) {
  if (!uid) { console.warn('[Chronasense] not logged in, skipping'); return; }
  if (!authToken) {
    const ok = await refreshAuthToken();
    if (!ok) { console.warn('[Chronasense] no token and refresh failed, skipping'); return; }
  }

  const site    = trackedSites[domain] || {};
  const appName = site.label || domain;
  const energy  = site.energy || 'waste';

  // Merge with recent session for the same domain within the merge window
  const last = lastSessionByDomain[domain];
  let entryStartTs = startTs;
  if (last && (startTs - last.endTs) <= MERGE_WINDOW_MS) {
    entryStartTs = last.startTs; // extend the existing entry
  }
  lastSessionByDomain[domain] = { startTs: entryStartTs, endTs };
  chrome.storage.local.set({ lastSessionByDomain });

  const totalDuration = endTs - entryStartTs;
  const entry = {
    id: entryStartTs,
    ts: endTs,
    tsStart: entryStartTs,
    updatedAt: endTs,
    blockIntervalMin: Math.round(totalDuration / 60000),
    date: toDateKey(new Date(entryStartTs)),
    activity: appName,
    energy,
    onPlan: energy !== 'waste',
    retro: true,
    browserUsage: true,
    quickLogged: true,
    source: 'browser-extension',
    // Time Truth V1 provenance: was `date` derived from a timezone actually confirmed
    // from the account's Firebase settings, or the device-OS/cached fallback? The web
    // app's own reads never trust this stored `date` field for day-bucketing (they
    // re-derive from tsStart/ts in the account timezone), so this cannot mis-assign a
    // day — it's an honest confidence marker for anything that does read `date` raw.
    tzConfirmed: userTimezoneConfirmed
  };
  entry.category = getBucket(entry);
  entry.originalLabel = entry.energy;

  const path = `rooms/uid_${uid}/entries/${entryStartTs}`;
  const doWrite = () => fetch(
    `${FIREBASE_CONFIG.databaseURL}${path}.json?auth=${authToken}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }
  );

  try {
    let res = await doWrite();
    console.log('[Chronasense] Firebase write status:', res.status);
    if (res.status === 401) {
      console.log('[Chronasense] token expired, refreshing…');
      const ok = await refreshAuthToken();
      if (ok) {
        res = await doWrite();
        console.log('[Chronasense] retry write status:', res.status);
      } else {
        console.warn('[Chronasense] refresh failed, session lost');
      }
    } else if (res.status !== 200) {
      const t = await res.text();
      console.warn('[Chronasense] Firebase error body:', t);
    }
  } catch (e) {
    console.warn('[Chronasense] network error logging session:', e);
  }
}

// ── Helpers ──
function getDomain(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (trackedSites[h]) return h;
    for (const domain of Object.keys(trackedSites)) {
      if (h === domain || h.endsWith('.' + domain)) return domain;
    }
    return null;
  } catch { return null; }
}

function getAnyDomain(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (!h || h === 'newtab' || url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) return null;
    // Check if it matches a tracked site (use canonical domain key)
    if (trackedSites[h]) return h;
    for (const domain of Object.keys(trackedSites)) {
      if (h === domain || h.endsWith('.' + domain)) return domain;
    }
    return h; // Unknown domain — return as-is
  } catch { return null; }
}

async function fetchUserTimezone(uidVal, token) {
  try {
    const url = `${FIREBASE_CONFIG.databaseURL}rooms/uid_${uidVal}/settings/timezone.json?auth=${token}`;
    const res  = await fetch(url);
    const tz   = await res.json();
    if (tz && typeof tz === 'string') {
      userTimezone = tz;
      userTimezoneConfirmed = true;
      await chrome.storage.local.set({ userTimezone: tz, userTimezoneConfirmed: true });
      console.log('[Chronasense] timezone set to', tz);
    }
    // No value at this path (e.g. manual room-code pairing, where the account's
    // settings live outside rooms/uid_<uid>) — leave userTimezone/confirmed as they
    // were rather than guessing; the caller already has a cached-or-device fallback.
  } catch (e) { console.warn('[Chronasense] could not fetch timezone', e); }
}

function toDateKey(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: userTimezone }).format(d);
}

function getBucket(entry) {
  switch (entry.energy) {
    case 'deep':     return 'deep_work';
    case 'shallow':  return 'shallow_work';
    case 'waste':    return 'waste';
    case 'recovery': return 'recovery';
    default:         return 'waste';
  }
}

// ── Message bridge (popup ↔ background) ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SIGN_IN') {
    signIn().then(r => sendResponse({ ok: true, ...r })).catch(e => sendResponse({ ok: false, error: e }));
    return true;
  }
  if (msg.type === 'SIGN_OUT') {
    signOut().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'GET_STATUS') {
    chrome.storage.local.get(['uid', 'email'], (data) => {
      sendResponse({ signedIn: !!data.uid, email: data.email || null });
    });
    return true;
  }
  if (msg.type === 'GET_SITES') {
    sendResponse({ sites: trackedSites });
    return true;
  }
  if (msg.type === 'ADD_SITE') {
    chrome.storage.local.get(['customSites', 'removedSites'], (data) => {
      const customSites  = data.customSites  || {};
      const removedSites = (data.removedSites || []).filter(d => d !== msg.domain);
      customSites[msg.domain] = msg.label;
      saveSites(customSites, removedSites).then(() => sendResponse({ ok: true }));
    });
    return true;
  }
  if (msg.type === 'REMOVE_SITE') {
    chrome.storage.local.get(['customSites', 'removedSites'], (data) => {
      const customSites  = data.customSites  || {};
      const removedSites = data.removedSites || [];
      delete customSites[msg.domain];
      if (!removedSites.includes(msg.domain)) removedSites.push(msg.domain);
      saveSites(customSites, removedSites).then(() => sendResponse({ ok: true }));
    });
    return true;
  }
});
