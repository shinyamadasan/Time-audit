// ChronaSense Service Worker
// Handles background ping notifications and audio asset caching

const SW_VERSION = '1.1.2';
const AUDIO_CACHE = 'chrona-audio-v1';
const OLD_APP_SHELL_CACHE = 'ta3-sw';

let _pingTimer = null;
// Bound receipts for recent sessions, including Stop tombstones, rather than every interval.
const MAX_PING_SESSIONS = 16;
const _pingSessions = new Map();

function pingSession(key) {
  if (!_pingSessions.has(key)) {
    _pingSessions.set(key, { lastShownDue: 0, ended: false });
    if (_pingSessions.size > MAX_PING_SESSIONS) _pingSessions.delete(_pingSessions.keys().next().value);
  }
  return _pingSessions.get(key);
}

function clearPing(sessionKey) {
  if (_pingTimer && (!sessionKey || _pingTimer.sessionKey === sessionKey)) {
    clearTimeout(_pingTimer.id);
    _pingTimer = null;
  }
}

function deliverPing(sessionKey, dueAt, snoozed = false) {
  const session = pingSession(sessionKey);
  if (session.ended || dueAt <= session.lastShownDue) return Promise.resolve();
  session.lastShownDue = dueAt;
  if (_pingTimer?.sessionKey === sessionKey && _pingTimer.dueAt <= dueAt) clearPing(sessionKey);
  const options = snoozed ? {
    body: 'Time to log that block.', requireInteraction: true, tag: 'chrona-ping',
    renotify: true, vibrate: [200, 100, 200]
  } : {
    body: 'What were you doing? Tap to log it.',
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="%230b0b0c"/><circle cx="50" cy="50" r="28" fill="none" stroke="%234cc7f0" stroke-width="6"/><text x="50" y="57" text-anchor="middle" font-size="24" fill="%234cc7f0" font-family="monospace" font-weight="bold">T</text></svg>',
    badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="%234cc7f0"/></svg>',
    requireInteraction: true, tag: 'chrona-ping', renotify: true, vibrate: [200, 100, 200],
    actions: [{ action: 'log', title: 'Log it' }, { action: 'snooze', title: 'Snooze 5 min' }]
  };
  options.data = { sessionKey, dueAt };
  return Promise.resolve().then(() => self.registration.showNotification(snoozed ? '⏱ Snooze over' : '⏱ Block complete', options)).catch(() => {});
}

function schedulePing(sessionKey, dueAt, delayMs, snoozed = false) {
  const session = pingSession(sessionKey);
  if (session.ended || dueAt <= session.lastShownDue) return;
  clearPing();
  _pingTimer = { sessionKey, dueAt, id: setTimeout(() => {
    deliverPing(sessionKey, dueAt, snoozed);
  }, delayMs) };
}

// ── Message handler (from page) ──────────────────────────
self.addEventListener('message', event => {
  const { action, delayMs } = event.data || {};
  // Retain the unkeyed backup protocol for older clients.
  const sessionKey = typeof event.data?.sessionKey === 'string' ? event.data.sessionKey : 'legacy';
  const dueAt = Number.isFinite(event.data?.dueAt) ? event.data.dueAt : Date.now() + (delayMs || 0);

  if (action === 'schedule-ping') {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    schedulePing(sessionKey, dueAt, delayMs);
  } else if (action === 'ping-due') {
    if (!Number.isFinite(event.data?.dueAt)) return;
    event.waitUntil(deliverPing(sessionKey, dueAt));
  } else if (action === 'cancel-ping') {
    clearPing(sessionKey);
    if (event.data?.endSession) pingSession(sessionKey).ended = true;
  }
});

// ── Notification click handler ────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const sessionKey = event.notification.data?.sessionKey || 'legacy';
  if (pingSession(sessionKey).ended) return;

  if (event.action === 'snooze') {
    // Reschedule for 5 minutes
    schedulePing(sessionKey, Date.now() + 5 * 60 * 1000, 5 * 60 * 1000, true);
    return;
  }

  // 'log' action or tap on notification body — focus/open the app
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If app tab is already open, focus it and tell it to open the log
      for (const client of list) {
        if (client.url.includes('shinyamadasan.github.io') || client.url.includes('localhost') || client.url.includes('127.0.0.1')) {
          client.focus();
          client.postMessage({ action: 'open-log' });
          return;
        }
      }
      // Otherwise open a new tab
      return clients.openWindow('./').then(client => {
        if (client) {
          // Small delay to let the app load before sending the message
          setTimeout(() => client.postMessage({ action: 'open-log' }), 1500);
        }
      });
    })
  );
});

// ── Audio caching (cache-first, network fallback) ─────────
// Caches lo-fi tracks after first play so Focus Mode works offline.
self.addEventListener('fetch', event => {
  if (!event.request.url.includes('/Sounds/') || !event.request.url.endsWith('.mp3')) return;
  event.respondWith(
    caches.open(AUDIO_CACHE).then(cache =>
      cache.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        });
      })
    )
  );
});

// ── Install & activate ────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  // Clean up old audio caches and the retired inline app-shell cache.
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k === OLD_APP_SHELL_CACHE || (k.startsWith('chrona-audio-') && k !== AUDIO_CACHE))
          .map(k => caches.delete(k))
      )
    ).then(() => clients.claim())
  );
});
