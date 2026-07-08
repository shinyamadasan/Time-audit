// ChronaSense Service Worker
// Handles background ping notifications and audio asset caching

const SW_VERSION = '1.1.1';
const AUDIO_CACHE = 'chrona-audio-v1';
const OLD_APP_SHELL_CACHE = 'ta3-sw';

let _pingTimer = null;

// ── Message handler (from page) ──────────────────────────
self.addEventListener('message', event => {
  const { action, delayMs } = event.data || {};

  if (action === 'schedule-ping') {
    // Clear any existing backup timer
    if (_pingTimer) { clearTimeout(_pingTimer); _pingTimer = null; }
    if (!delayMs || delayMs <= 0) return;

    _pingTimer = setTimeout(() => {
      _pingTimer = null;
      self.registration.showNotification('⏱ Block complete', {
        body: 'What were you doing? Tap to log it.',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="%230b0b0c"/><circle cx="50" cy="50" r="28" fill="none" stroke="%234cc7f0" stroke-width="6"/><text x="50" y="57" text-anchor="middle" font-size="24" fill="%234cc7f0" font-family="monospace" font-weight="bold">T</text></svg>',
        badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="%234cc7f0"/></svg>',
        requireInteraction: true,
        tag: 'chrona-ping',
        renotify: true,
        vibrate: [200, 100, 200],
        actions: [
          { action: 'log', title: 'Log it' },
          { action: 'snooze', title: 'Snooze 5 min' }
        ]
      });
    }, delayMs);

  } else if (action === 'cancel-ping') {
    if (_pingTimer) { clearTimeout(_pingTimer); _pingTimer = null; }
  }
});

// ── Notification click handler ────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'snooze') {
    // Reschedule for 5 minutes
    _pingTimer = setTimeout(() => {
      _pingTimer = null;
      self.registration.showNotification('⏱ Snooze over', {
        body: 'Time to log that block.',
        requireInteraction: true,
        tag: 'chrona-ping',
        renotify: true,
        vibrate: [200, 100, 200]
      });
    }, 5 * 60 * 1000);
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
