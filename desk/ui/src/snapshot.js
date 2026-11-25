// The last snapshot the server gave, kept in the same Cache Storage as the service worker's app
// files, so a reload with the server stopped still has it. Fetched by the page itself, because the
// window adds its per-load token only to the page's own requests.
export const CACHE = 'desk-app';
export const SNAPSHOT = '/api/snapshot';

// The server's snapshot, kept for next time; with the server unreachable, the one kept last; null when
// the server refused or nothing was kept.
export async function loadSnapshot({ get = (u) => fetch(u), store = globalThis.caches } = {}) {
  let response;
  try {
    response = await get(SNAPSHOT);
  } catch {
    const kept = store ? await (await store.open(CACHE)).match(SNAPSHOT) : undefined;
    return kept ? kept.json() : null;
  }
  if (response.status !== 200) return null;
  if (store) {
    try { await (await store.open(CACHE)).put(SNAPSHOT, response.clone()); } catch { /* a full or refused cache only loses the copy */ }
  }
  return response.json();
}
