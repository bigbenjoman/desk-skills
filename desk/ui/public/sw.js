// The desk app's service worker: it keeps the app's own files. Each is fetched from the server first
// and kept; only when the server cannot be reached (the fetch itself fails) does it answer from what
// it kept, so the window still loads with the server stopped. Any answer the server does give, a
// refusal included, is passed through. /api is never touched: the window adds its per-load token
// only to the page's own requests, and the page keeps the last snapshot itself (src/snapshot.js).
const CACHE = 'desk-app';

self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

// Only the app's own files are kept: this origin, never /api.
const ours = (url) => url.origin === self.location.origin && !url.pathname.startsWith('/api/');

async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  let response;
  try {
    response = await fetch(request);
  } catch (e) {
    const kept = await cache.match(key);
    if (kept) return kept;
    throw e;
  }
  if (response.status === 200) await cache.put(key, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!ours(url)) return;
  // Every page is the one app, kept under /.
  event.respondWith(networkFirst(request, request.mode === 'navigate' ? '/' : url.pathname));
});

// The page the worker was registered from loaded its files before the worker existed, so none of them
// passed through it. That page posts them ({ keep: [url, …] }, src/main.jsx) and they are fetched and
// kept now, so loading the app once is enough for a reload with the server stopped.
async function keep(urls) {
  const cache = await caches.open(CACHE);
  await Promise.all(urls.map(async (u) => {
    const url = new URL(u, self.location.origin);
    if (!ours(url)) return;
    try {
      const response = await fetch(url.pathname);
      if (response.status === 200) await cache.put(url.pathname, response);
    } catch { /* unreachable now: kept the next time it passes through */ }
  }));
}

self.addEventListener('message', (event) => {
  const urls = event.data?.keep;
  if (Array.isArray(urls)) event.waitUntil(keep(urls.filter((u) => typeof u === 'string')));
});
