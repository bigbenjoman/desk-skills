// The desk app's service worker: it keeps the app's own files. Each is fetched from the server first
// and kept; only when the server cannot be reached (the fetch itself fails) does it answer from what
// it kept, so the window still loads with the server stopped. Any answer the server does give, a
// refusal included, is passed through. /api is never touched: the window adds its per-load token
// only to the page's own requests, and the page keeps the last snapshot itself (src/snapshot.js).
const CACHE = 'desk-app';

self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

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
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Every page is the one app, kept under /.
  event.respondWith(networkFirst(request, request.mode === 'navigate' ? '/' : url.pathname));
});
