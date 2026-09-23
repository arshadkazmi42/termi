const CACHE = 'termi-v8';
const PRECACHE = ['/', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Network-first for HTML/API, cache-first for static assets
  if (e.request.url.includes('/socket.io/')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});

// ── Push: "your session went quiet" ─────────────────────
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'termi', {
    body: d.body || '',
    tag: d.tag || 'termi',
    renotify: true,
    data: { url: d.url || '/' },
  }));
});

// Tapping it opens the session: an open termi window just switches route,
// otherwise a new one is opened on it.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if ('focus' in c) {
        c.postMessage({ type: 'open', url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
