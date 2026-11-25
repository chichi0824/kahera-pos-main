/* Kahera POS — sw.js
 * Offline support: cache the app shell on install, serve cache-first,
 * refresh the cache in the background. Bump CACHE when files change. */
const CACHE = 'kahera-v2.9.47-dark-mode-audit-final';
const SHELL = [
  './', 'index.html', 'assets/victorias-empty-order-cloche.svg', 'assets/victorias-leafy-corner.svg', 'order.html', 'css/styles.css', 'css/order.css', 'js/order.js', 'js/money.js', 'js/store.js',
  'js/menu-sample.js', 'js/cloud.js', 'js/app.js', 'manifest.webmanifest', 'icons/kahera-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
