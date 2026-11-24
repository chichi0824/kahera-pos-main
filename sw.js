/* Kahera POS — service worker
 * Offline foundation: cache the app shell, serve navigations from the network
 * when available, and use cached same-origin assets when the device is offline.
 * Bump CACHE whenever the app shell or offline modules change. */
const CACHE = 'kahera-v3.0.0-offline-foundation';
const SHELL = [
  './', 'index.html', 'order.html', 'css/styles.css', 'css/order.css',
  'js/order.js', 'js/money.js', 'js/store.js', 'js/menu-sample.js',
  'js/offline-db.js', 'js/cloud.js', 'js/app.js',
  'manifest.webmanifest', 'icons/kahera-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('kahera-') && key !== CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(async () => {
        return (await caches.match(request)) ||
          (await caches.match('./index.html')) ||
          Response.error();
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkUpdate = fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
      return cached || networkUpdate;
    })
  );
});
