import { FIREBASE_CONFIG, TRACKED_SITES, MIN_SESSION_MS } from './firebase-config.js';

// ── State ──
let activeTab  = null;
let authToken  = null;
let uid        = null;
let trackedSites = {};  // loaded from storage, merges defaults + custom
let userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;  // fallback to device

// ── Startup ──
// Called on install/update AND on every service worker restart (MV3 workers are killed after inactivity)
chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);
init(); // also run immediately on every service worker start to restore uid/authToken

async function init() {
  const stored = await chrome.storage.local.get(['uid', 'authToken', 'customSites', 'removedSites', 'userTimezone']);
  uid          = stored.uid          || null;
  authToken    = stored.authToken    || null;
  userTimezone = stored.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  loadTrackedSites(stored.customSites || {}, stored.removedSites || []);
  if (uid) {
    chrome.alarms.create('flush', { periodInMinutes: 5 });
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (tabs[0]) recordStart(tabs[0].url, tabs[0].title);
    });
  }
}

// ── Tab listeners registered at top level so they survive service worker restarts ──
chrome.tabs.onActivated.addListener(onTabActivated);
chrome.tabs.onUpdated.addListener(onTabUpdated);
chrome.windows.onFocusChanged.addListener(onFocusChanged);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'flush') flushAndRestart();
});

function loadTrackedSites(customSites, removedSites) {
  trackedSites = {};
  // Add defaults (skip removed ones)
  for (const [domain, label] of Object.entries(TRACKED_SITES)) {
    if (!removedSites.includes(domain)) {
      trackedSites[domain] = { label, custom: false };
    }
  }
  // Add custom sites
  for (const [domain, label] of Object.entries(customSites)) {
    trackedSites[domain] = { label, custom: true };
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
    // Fetch user's timezone from their Firebase settings
    fetchUserTimezone(fbData.localId, fbData.idToken);
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
  if (!uid) return;
  chrome.tabs.get(info.tabId, (tab) => {
    if (tab) switchTab(tab.url, tab.title);
  });
}

function onTabUpdated(tabId, changeInfo, tab) {
  if (!uid) return;
  if (changeInfo.status === 'complete' && tab.active) {
    switchTab(tab.url, tab.title);
  }
}

function onFocusChanged(windowId) {
  if (!uid) return;
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
  if (!domain) { activeTab = null; return; }
  const now = Date.now();
  activeTab = { url, title, domain, startedAt: now, sessionId: now };
}

function flushActiveTab() {
  if (!activeTab) return;
  const now = Date.now();
  const durationMs = now - activeTab.startedAt;
  const tab = activeTab;
  activeTab = null;
  if (durationMs < MIN_SESSION_MS) return;
  if (trackedSites[tab.domain]) {
    console.log('[Chronasense] flush:', tab.domain, Math.round(durationMs/1000)+'s → logging');
    logSession(tab.domain, tab.title, tab.sessionId, now, now - tab.sessionId);
  } else {
    maybeNotifyUnknown(tab.domain, durationMs);
  }
}

function flushAndRestart() {
  if (!activeTab) return;
  const now = Date.now();
  const durationMs = now - activeTab.startedAt;
  if (durationMs >= MIN_SESSION_MS && trackedSites[activeTab.domain]) {
    logSession(activeTab.domain, activeTab.title, activeTab.sessionId, now, now - activeTab.sessionId);
  }
  activeTab = { ...activeTab, startedAt: now };
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
  console.log('[Chronasense] logSession uid:', uid, 'domain:', domain);
  if (!uid) { console.warn('[Chronasense] not logged in, skipping'); return; }
  if (!authToken) {
    const ok = await refreshAuthToken();
    if (!ok) { console.warn('[Chronasense] no token and refresh failed, skipping'); return; }
  }

  const appName = trackedSites[domain]?.label || domain;
  const entry = {
    id: startTs,
    ts: endTs,
    tsStart: startTs,
    updatedAt: endTs,
    blockIntervalMin: Math.round(durationMs / 60000),
    date: toDateKey(new Date(startTs)),
    activity: appName,
    energy: 'waste',
    onPlan: false,
    retro: true,
    browserUsage: true,
    quickLogged: true,
    source: 'browser-extension'
  };
  entry.category = getBucket(entry);
  entry.originalLabel = entry.energy;

  const path = `rooms/uid_${uid}/entries/${startTs}`;
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
      await chrome.storage.local.set({ userTimezone: tz });
      console.log('[Chronasense] timezone set to', tz);
    }
  } catch (e) { console.warn('[Chronasense] could not fetch timezone', e); }
}

function toDateKey(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: userTimezone }).format(d);
}

function getBucket(entry) {
  const e = entry.energy;
  if (e === 'waste') return 'Waste';
  if (e === 'invest') return 'Invest';
  return 'Neutral';
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
