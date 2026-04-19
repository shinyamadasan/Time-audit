import { FIREBASE_CONFIG, TRACKED_SITES, MIN_SESSION_MS } from './firebase-config.js';

// ── State ──
let activeTab  = null;
let authToken  = null;
let uid        = null;
let trackedSites = {};  // loaded from storage, merges defaults + custom

// ── Startup ──
chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);

async function init() {
  const stored = await chrome.storage.local.get(['uid', 'authToken', 'customSites', 'removedSites']);
  uid       = stored.uid       || null;
  authToken = stored.authToken || null;
  loadTrackedSites(stored.customSites || {}, stored.removedSites || []);
  if (uid) startTracking();
}

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
    if (!stored.fbRefreshToken) return false;
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
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.windows.onFocusChanged.addListener(onFocusChanged);

  // Flush any open session every 5 min in case tab stays open a long time
  chrome.alarms.create('flush', { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'flush') flushAndRestart();
  });

  // Capture current tab right away
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
  const domain = getDomain(url);
  if (!domain || !trackedSites[domain]) {
    console.log('[Chronasense] not tracked:', url);
    activeTab = null;
    return;
  }
  console.log('[Chronasense] started tracking:', domain);
  activeTab = { url, title, domain, startedAt: Date.now() };
}

function flushActiveTab() {
  if (!activeTab) return;
  const durationMs = Date.now() - activeTab.startedAt;
  const tab = activeTab;
  activeTab = null;
  console.log('[Chronasense] flush:', tab.domain, Math.round(durationMs/1000)+'s', durationMs >= MIN_SESSION_MS ? '→ logging' : '→ too short, skipped');
  if (durationMs >= MIN_SESSION_MS) {
    logSession(tab.domain, tab.title, tab.startedAt, Date.now(), durationMs);
  }
}

function flushAndRestart() {
  if (!activeTab) return;
  const now = Date.now();
  const durationMs = now - activeTab.startedAt;
  if (durationMs >= MIN_SESSION_MS) {
    logSession(activeTab.domain, activeTab.title, activeTab.startedAt, now, durationMs);
  }
  // Restart the segment
  activeTab = { ...activeTab, startedAt: now };
}

// ── Firebase logging ──
async function logSession(domain, title, startTs, endTs, durationMs) {
  console.log('[Chronasense] logSession uid:', uid, 'domain:', domain);
  if (!uid) { console.warn('[Chronasense] not logged in, skipping'); return; }

  // Always refresh token before writing — idToken expires after 1 hour
  await refreshAuthToken();
  if (!authToken) { console.warn('[Chronasense] could not refresh token, skipping'); return; }

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
  const url  = `${FIREBASE_CONFIG.databaseURL}${path}.json?auth=${authToken}`;

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
    console.log('[Chronasense] Firebase write status:', res.status);
    if (res.status !== 200) { const t = await res.text(); console.warn('[Chronasense] Firebase error body:', t); }
    if (res.status === 401) {
      // Token expired — refresh and retry once
      const ok = await refreshAuthToken();
      if (ok) {
        await fetch(`${FIREBASE_CONFIG.databaseURL}${path}.json?auth=${authToken}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry)
        });
      }
    }
  } catch (e) {
    // Network error — queue for retry (simple: ignore for now, next sync will catch)
    console.warn('Chronasense: failed to log session', e);
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

function toDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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
