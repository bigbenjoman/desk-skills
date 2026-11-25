// suite: the desk app's offline copy (desk/ui/public/sw.js keeps the app, desk/ui/src/snapshot.js the last snapshot)
// covers: desk/ui/public/sw.js desk/ui/src/snapshot.js
// The service worker runs in a vm with a stand-in Cache Storage and network, so a reload is a fetch
// event and a stopped server is a fetch that fails. snapshot.js is the page's own module, run here
// as it is. Nothing is fetched from anywhere.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'ui');
const { loadSnapshot, CACHE, SNAPSHOT } = await import(join(UI, 'src', 'snapshot.js'));
const ORIGIN = 'http://127.0.0.1:4823';

// Cache Storage as a page and its service worker share it: named caches of responses by path.
function cacheStorage() {
  const named = new Map();
  return {
    named,
    async open(name) {
      if (!named.has(name)) {
        const kept = new Map();
        named.set(name, { kept, async match(key) { return kept.get(String(key))?.clone(); }, async put(key, response) { kept.set(String(key), response); } });
      }
      return named.get(name);
    },
  };
}
const caches = cacheStorage();
// The server: what each path answers while it runs. Stopped, every fetch fails as a refused connection does.
const server = { up: true, pages: { '/': ['build one', 200], '/assets/app-1.js': ['one()', 200], [SNAPSHOT]: [JSON.stringify({ at: '2026-11-22T10:07:00.000Z', rev: 7 }), 200] } };
const pathOf = (request) => new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
async function network(request) {
  if (!server.up) throw new TypeError('fetch failed');
  const [body, status] = server.pages[pathOf(request)] ?? ['not found', 404];
  return new Response(body, { status });
}

// ---- the service worker
const on = {};
const sw = { location: new URL(`${ORIGIN}/sw.js`), addEventListener: (type, f) => { on[type] = f; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
runInNewContext(readFileSync(join(UI, 'public', 'sw.js'), 'utf8'), { self: sw, caches, fetch: network, URL });
t('the worker takes over at once', [typeof on.install, typeof on.activate, typeof on.fetch], ['function', 'function', 'function']);
// A load through the worker: its answer, or 'network' when it leaves the request to the browser.
async function load(path, { mode = 'cors', method = 'GET', origin = ORIGIN } = {}) {
  let answer = null;
  on.fetch({ request: { url: `${origin}${path}`, method, mode }, respondWith: (p) => { answer = p; } });
  if (!answer) return 'network';
  try { const r = await answer; return [r.status, await r.text()]; } catch (e) { return `failed: ${e.message}`; }
}
const page = () => load('/', { mode: 'navigate' });
const kept = () => [...(caches.named.get(CACHE)?.kept.keys() ?? [])].sort();

t('the window loads the app from the server', [await page(), await load('/assets/app-1.js')], [[200, 'build one'], [200, 'one()']]);
t('it keeps the page and its files', kept(), ['/', '/assets/app-1.js']);
t('no /api request goes through the worker', [await load(SNAPSHOT), await load('/api/meta'), await load('/api/events')], ['network', 'network', 'network']);
t('nor anything but a GET, nor another origin', [await load('/', { method: 'POST' }), await load('/x.js', { origin: 'https://github.com' })], ['network', 'network']);

// ---- AC4: the server stops and the window reloads
server.up = false;
t('AC4 with the server stopped, a reload still loads the app from the cache', [await page(), await load('/assets/app-1.js')], [[200, 'build one'], [200, 'one()']]);
t('AC4 any page of the app is the one it kept', await load('/inbox', { mode: 'navigate' }), [200, 'build one']);
t('a file it never kept fails as the network did', await load('/assets/never.js'), 'failed: fetch failed');

// ---- a server that answers is believed, even when it refuses
server.up = true;
server.pages['/'] = ['Not signed in', 401];
t('a refusal from the server is passed on, not replaced by the copy', await page(), [401, 'Not signed in']);
server.up = false;
t('and the copy it kept is not overwritten by the refusal', await page(), [200, 'build one']);

// ---- a new build replaces the copy
server.up = true;
server.pages['/'] = ['build two', 200];
t('a new build is shown on the next reload', await page(), [200, 'build two']);
server.up = false;
t('and is the copy kept from then on', await page(), [200, 'build two']);

// ---- AC4: the last snapshot, kept by the page
const get = (path) => network(path);
server.up = true;
t('AC4 the page reads the snapshot from the server', await loadSnapshot({ get, store: caches }), { at: '2026-11-22T10:07:00.000Z', rev: 7 });
t('AC4 and keeps it beside the app', kept().includes(SNAPSHOT), true);
server.up = false;
t('AC4 with the server stopped, the last snapshot still loads', await loadSnapshot({ get, store: caches }), { at: '2026-11-22T10:07:00.000Z', rev: 7 });
t('AC4 and loads again on the next reload', (await loadSnapshot({ get, store: caches }))?.rev, 7);
server.up = true;
server.pages[SNAPSHOT] = ['{"error":{"code":"unauthorized"}}', 401];
t('a refused snapshot is none, and is not kept', await loadSnapshot({ get, store: caches }), null);
server.up = false;
t('the last good snapshot is still the one kept', (await loadSnapshot({ get, store: caches }))?.rev, 7);
t('with nothing kept, there is no snapshot', await loadSnapshot({ get, store: cacheStorage() }), null);
t('with no Cache Storage, there is no snapshot', await loadSnapshot({ get, store: undefined }), null);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
