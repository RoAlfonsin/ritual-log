'use strict';
/* Ritual Log service worker.

   Network first, cache as the offline fallback: a deploy is picked up on the next
   load while the ritual list still opens in a dead spot. Nothing cross-origin is
   ever touched — the shared gist and the #schedule webhook must always hit the
   network, and config.js (the webhook) is never cached. */

const CACHE = 'ritual-log-v2';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .catch(() => {})
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      /* gist, GitHub API, webhook */
  if (url.pathname.endsWith('/config.js')) return;      /* the webhook: network only */
  if (url.pathname.endsWith('/plan.json')) return;      /* the plan: never from cache — the app
                                                           caches it itself and warns when it is stale */

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || caches.match('./index.html')))
  );
});
