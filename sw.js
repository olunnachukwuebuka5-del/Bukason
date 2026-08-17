const CACHE = 'bukason-v1';
self.addEventListener('install', e => {
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  // Network-first, no offline caching of API calls — keeps AI responses live.
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
