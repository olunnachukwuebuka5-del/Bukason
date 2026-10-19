// sw.js: lets BUKASON open with no internet.
// Replaces the older sw.js in your repo (same file name, so phones update it).
//
// - App files are saved on first visit and refreshed in the background.
// - The Supabase library from the CDN is saved too, otherwise the app
//   would crash offline when it tries to create the Supabase client.
// - Live data (AI replies, Supabase calls) is never cached.

const CACHE = "bukason-shell-v9";

const SHELL = [
  "./",
  "./index.html",
  "./knowledge-sync.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./offline-knowledge.json"
];

const CDN_SCRIPTS = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    // One at a time, so a missing file never blocks the install.
    for (const url of SHELL) {
      try { await cache.add(url); } catch (e) { /* skip missing file */ }
    }
    for (const url of CDN_SCRIPTS) {
      try {
        const req = new Request(url, { mode: "no-cors" });
        await cache.put(req, await fetch(req));
      } catch (e) { /* will be cached on first normal load instead */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    return (await cache.match(request)) ||
           (fallbackUrl && (await cache.match(fallbackUrl))) ||
           Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((res) => { if (res.ok) cache.put(request, res.clone()); return res; })
    .catch(() => null);
  return cached || (await refresh) || Response.error();
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    // opaque (status 0) responses are fine for <script> tags
    if (res.ok || res.type === "opaque") cache.put(request, res.clone());
    return res;
  } catch (err) {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache live data.
  if (url.pathname.startsWith("/.netlify/functions/")) return;
  if (url.hostname.endsWith("supabase.co")) return;

  // Pages: try the network, fall back to the saved app.
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, "./index.html"));
    return;
  }

  // The Supabase library from jsDelivr.
  if (url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Our own files.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
  }
});
