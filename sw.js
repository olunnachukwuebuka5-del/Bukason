const CACHE = 'bukason-v1';
self.addEventListener('install', e => {
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  // Only handle simple page loads (GET). Let chat requests (POST) go straight
  // through untouched — this was breaking the AI connection before.
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
