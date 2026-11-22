// suite: Desk.app's main process (sign-in, re-sign-in, the unreachable card, one copy only)
// covers: desk/shell/** desk/shell/app.mjs desk/shell/main.mjs desk/shell/preload.cjs desk/shell/status.html desk/shell/status.js desk/shell/package.json desk/bin/desk-ui.mjs
// desk/shell/app.mjs driven with a stubbed Electron (BrowserWindow, session, ipcMain, app) against the
// real desk-ui server on a throwaway HOME and a test-only port. Nothing touches your real ~/.claude,
// ~/.config/desk, state, or a server on 4823.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
import { call as callPort, freePort } from './local-http.mjs';
import { homedir } from 'node:os';
import { createShell, deskPaths, exchange, externalUrl, jiraSites, parseCookie, run, tokenFile, PARTITION } from '../desk/shell/app.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin', 'desk-ui.mjs');
const SHELL = join(ROOT, 'desk', 'shell');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = scratch('desk-shell-');
const PORT = await freePort();
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOKEN = `tok${'c3'.repeat(30)}`;
const WRONG = `wrong${'d4'.repeat(29)}`;
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_UI_TEST_PORT: String(PORT), PATH: process.env.PATH };
mkdirSync(env.HOME, { recursive: true });
mkdirSync(env.DESK_HOME, { recursive: true });
mkdirSync(env.DESK_CONFIG_ROOT, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
writeFileSync(join(env.DESK_CONFIG_ROOT, 'ui-token'), `${TOKEN}\n`, { mode: 0o600 });

let srv = null;
async function startServer() {
  let out = '';
  srv = spawn('node', [BIN, 'serve'], { env, cwd: T });
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 300 && !out.includes('listening'); i++) await sleep(50);
  return out.includes('listening');
}
async function stopServer() {
  if (!srv) return;
  const done = new Promise((r) => srv.once('exit', r));
  srv.kill(); await done; srv = null;
}
process.on('exit', () => srv?.kill());

// A GET to the server; status 0 when nothing answers.
const call = (path, headers = {}) => callPort(PORT, 'GET', path, { headers }).catch(() => ({ status: 0 }));

// ---- a stubbed Electron ------------------------------------------------------------------------
function fakeElectron({ lock = true } = {}) {
  const ipc = {}, appEvents = {}, windows = [], cookies = [], opened = [], notes = [], badges = [];
  let completed = null, sending = null, ready = null, quit = 0, permRequest = null, permCheck = null;
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts; this.loads = []; this.events = {}; this.sent = []; this.minimized = false; this.focused = 0;
      this.webContents = { id: 40 + windows.length, on: (ev, fn) => { this.events[ev] = fn; }, setWindowOpenHandler: (fn) => { this.openHandler = fn; }, send: (ch, ...a) => { this.sent.push([ch, ...a]); } };
      windows.push(this);
    }
    loadURL(u) { this.loads.push(u); }
    loadFile(p, { query } = {}) { this.loads.push(`card:${query.state}`); this.page = p; this.query = query; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() {}
    focus() { this.focused += 1; }
    on(ev, fn) { this.events[ev] = fn; }
  }
  const ses = {
    partition: null, cookies: { set: async (c) => { cookies.push(c); } },
    webRequest: { onCompleted: (filter, fn) => { completed = { filter, fn }; }, onBeforeSendHeaders: (filter, fn) => { sending = { filter, fn }; } },
    setPermissionRequestHandler: (fn) => { permRequest = fn; }, setPermissionCheckHandler: (fn) => { permCheck = fn; },
  };
  class Notification {
    static isSupported() { return true; }
    constructor(o) { this.o = o; }
    show() { notes.push(this.o); }
  }
  const electron = {
    BrowserWindow, Notification,
    shell: { openExternal: async (u) => { opened.push(u); } },
    session: { fromPartition: (p) => { ses.partition = p; return ses; } },
    ipcMain: { handle: (name, fn) => { ipc[name] = fn; } },
    app: {
      requestSingleInstanceLock: () => lock,
      quit: () => { quit += 1; },
      on: (ev, fn) => { appEvents[ev] = fn; },
      whenReady: () => new Promise((r) => { ready = r; }),
      dock: { setBadge: (s) => { badges.push(s); } },
    },
  };
  return { electron, ipc, appEvents, windows, cookies, ses, opened, notes, badges, completed: () => completed, sending: () => sending,
    permRequest: () => permRequest, permCheck: () => permCheck, ready: () => ready?.(), quits: () => quit };
}
// What the preload's call looks like to the main process: from this window, on this frame's URL.
const from = (w, url = `${ORIGIN}/`) => ({ sender: w.webContents, senderFrame: { url } });
// The headers the window's request to the server goes out with, after the session's listener.
function sentHeaders(f, w, { url = `${ORIGIN}/api/snapshot`, frame = `${ORIGIN}/`, headers = {} } = {}) {
  let out = null;
  f.sending().fn({ url, webContentsId: w.webContents.id, frame: frame === null ? null : { url: frame }, requestHeaders: headers }, (r) => { out = r.requestHeaders; });
  return out;
}

// What the window does when it loads a server URL: the request with the cookie its store holds, then
// the response handed to the session's webRequest listener, as Chromium does.
async function windowLoads(f, path = '/') {
  const c = f.cookies.at(-1);
  const r = await call(path, sentHeaders(f, f.windows.at(-1), { url: `${ORIGIN}${path}`, headers: c ? { Cookie: `${c.name}=${c.value}` } : {} }));
  f.completed()?.fn({ url: `${ORIGIN}${path}`, statusCode: r.status, resourceType: 'mainFrame', responseHeaders: { 'X-Desk-Boot': [r.headers?.['x-desk-boot']] } });
  return r;
}
const settle = () => sleep(150);

t('the desk-ui server starts on the test port', await startServer(), true);

// ---- helpers ----------------------------------------------------------------------------------
t('parseCookie reads desk_ui and its Max-Age', parseCookie('desk_ui=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400'), { value: 'abc', maxAge: 86400 });
t('parseCookie ignores another cookie', parseCookie('other=1; Path=/'), null);
const refusedX = await exchange(ORIGIN, WRONG);
t('exchange with the wrong token: 401, no cookie, and the server run that refused it', [refusedX.status, refusedX.cookie, refusedX.loadToken, /^[0-9a-f]{16}$/.test(refusedX.boot)], [401, null, null, true]);

// Finder and the Dock start Desk.app with none of install.sh's environment: the paths written into the
// bundle win, with a leading ~ read as the home directory.
const pathsFile = join(T, 'desk-paths.json');
writeFileSync(pathsFile, JSON.stringify({ configRoot: '~/custom/desk', deskHome: join(T, 'deskhome') }));
const baked = deskPaths(pathsFile, { DESK_CONFIG_ROOT: '/elsewhere' });
t('the bundle\'s paths win over the environment', [baked.configRoot, baked.deskHome, tokenFile(baked)], [join(homedir(), 'custom', 'desk'), join(T, 'deskhome'), join(homedir(), 'custom', 'desk', 'ui-token')]);
t('with none written, the environment, then the defaults', [deskPaths(join(T, 'none.json'), { DESK_CONFIG_ROOT: '/cfg' }).configRoot, deskPaths(null, {}).configRoot],
  ['/cfg', join(homedir(), '.config', 'desk')]);

// ---- AC1: the window opens on the server, signed in --------------------------------------------
let shellToken = TOKEN;
let exchanges = 0;
const timers = [];
const signIn = (o, tok) => { exchanges += 1; return exchange(o, tok); };
const opts = (more = {}) => ({ origin: ORIGIN, preload: join(SHELL, 'preload.cjs'), page: join(SHELL, 'status.html'), token: () => shellToken, signIn,
  install: () => '~/src/desk-skills', watch: (fn) => { watchers.push(fn); }, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  jira: async () => ['acme.atlassian.net'], kick: async () => { kicks += 1; }, ...more });
const watchers = [];
let kicks = 0;
const f = fakeElectron();
const shell = createShell(f.electron, opts());
const win = shell.open();
await settle();
const prefs = win.opts.webPreferences;
t('the window is sandboxed, isolated and has no Node', [prefs.sandbox, prefs.contextIsolation, prefs.nodeIntegration, prefs.partition], [true, true, false, PARTITION]);
t('the session cookie goes into the window\'s own store, HttpOnly and SameSite=Strict',
  [f.ses.partition, f.cookies.length, f.cookies[0]?.name, f.cookies[0]?.httpOnly, f.cookies[0]?.sameSite, f.cookies[0]?.url], [PARTITION, 1, 'desk_ui', true, 'strict', ORIGIN]);
t('the window loads the server, not a card', [win.loads, shell.view], [[`${ORIGIN}/`], 'app']);
const page = await windowLoads(f);
t('the window\'s request to the server is signed in', page.status, 200);

// The per-load token goes on the window's own requests to the server, from the server's page only.
const sent = sentHeaders(f, win, { headers: { 'x-desk-load': 'from-the-page' } });
const load = sent['X-Desk-Load'];
const meta = await call('/api/meta', { Cookie: `desk_ui=${f.cookies[0].value}`, 'X-Desk-Load': load ?? '' });
t('the load token is added to the window\'s requests and works on /api, over any the page set', [typeof load, load?.length, meta.status, 'x-desk-load' in sent], ['string', 64, 200, false]);
t('the load token is not added for another frame, another window, or a request the page could not make',
  [sentHeaders(f, win, { frame: 'https://example.com/' })['X-Desk-Load'], sentHeaders(f, win, { frame: 'file:///x/status.html' })['X-Desk-Load'],
    sentHeaders(f, { webContents: { id: 999 } })['X-Desk-Load']], [undefined, undefined, undefined]);
t('the load token is only for the server', f.sending().filter.urls, [`${ORIGIN}/*`]);
// The change stream wants the app's Origin, which a same-origin GET does not carry: the window's own
// stream request gets it, over any the page set, and no other request or frame does.
const streamSent = sentHeaders(f, win, { url: `${ORIGIN}/api/events`, headers: { origin: 'null' } });
const opened = await new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port: PORT, path: '/api/events', headers: { Host: `127.0.0.1:${PORT}`, Cookie: `desk_ui=${f.cookies[0].value}`, ...streamSent } },
    (res) => { resolve(res.statusCode); req.destroy(); });
  req.on('error', () => resolve(null));
  req.end(); // a request is only sent once ended: without this the server drops the idle socket
});
t('the window\'s stream request carries the app\'s Origin and opens', [streamSent.Origin, 'origin' in streamSent, opened], [ORIGIN, false, 200]);
t('no other request, nor another frame\'s stream, gets an Origin added',
  [sentHeaders(f, win).Origin, sentHeaders(f, win, { url: `${ORIGIN}/api/events`, frame: 'https://example.com/' }).Origin], [undefined, undefined]);
t('the token never reaches a window load', win.loads.some((u) => u.includes(TOKEN)), false);

// ---- AC2: the sign-in is Desk's alone -----------------------------------------------------------
t('a browser or curl, with no cookie, is refused the snapshot', (await call('/api/snapshot')).status, 401);
t('the cookie alone, without the per-load token, is refused', (await call('/api/snapshot', { Cookie: `desk_ui=${f.cookies[0].value}` })).status, 401);
t('the window\'s cookie and load token get the snapshot', (await call('/api/snapshot', { Cookie: `desk_ui=${f.cookies[0].value}`, 'X-Desk-Load': load })).status, 200);

// ---- AC3: a refusal signs in again once ---------------------------------------------------------
await stopServer();
t('the server restarts', await startServer(), true);
exchanges = 0;
const before = win.loads.length;
const old = await windowLoads(f); // the restarted server has no sessions: the old cookie is refused
await settle();
t('the old session is refused after the restart', old.status, 401);
t('the refusal signs in again once and reloads the server page, with no card',
  [exchanges, f.cookies.length, win.loads.slice(before), shell.view], [1, 2, [`${ORIGIN}/`], 'app']);
t('the new session works', (await windowLoads(f)).status, 200);

// Refused again: the token file now holds a token the server does not know.
shellToken = WRONG;
exchanges = 0;
f.completed().fn({ url: `${ORIGIN}/api/snapshot`, statusCode: 401 });
await settle();
t('a sign-in the server refuses shows the not-signed-in card, once', [exchanges, win.loads.at(-1), shell.view, win.query?.checkout], [1, 'card:signed-out', 'signed-out', '~/src/desk-skills']);
watchers.forEach((w) => w());
await settle();
t('the same refused token is not tried again', exchanges, 1);
shellToken = TOKEN; // install.sh wrote the token again
watchers.forEach((w) => w());
await settle();
t('a changed token file signs in again', [exchanges, win.loads.at(-1), shell.view], [2, `${ORIGIN}/`, 'app']);

// A refusal straight after signing in, before anything succeeded, does not loop.
exchanges = 0;
// The server refuses the new session (here, a load token it did not issue).
const refusedFresh = await call('/api/snapshot', { Cookie: `desk_ui=${f.cookies.at(-1).value}`, 'X-Desk-Load': 'f'.repeat(64) });
f.completed().fn({ url: `${ORIGIN}/api/snapshot`, statusCode: refusedFresh.status, responseHeaders: { 'X-Desk-Boot': [refusedFresh.headers?.['x-desk-boot']] } });
await settle();
t('a refusal straight after signing in shows the card rather than signing in again', [refusedFresh.status, exchanges, shell.view], [401, 0, 'signed-out']);
// Unless the server restarted between the sign-in and the refusal: that is a new server, so sign in again.
await stopServer();
await startServer();
await timers.at(-1).fn(); // the card sees a new run of the server: one more sign-in, which it accepts
await settle();
t('the card signs in to a restarted server', shell.view, 'app');
await stopServer();
await startServer();
exchanges = 0;
await windowLoads(f);
await settle();
t('a refusal straight after signing in, from a restarted server, signs in again with no card', [exchanges, shell.view, win.loads.at(-1)], [1, 'app', `${ORIGIN}/`]);
exchanges = 0;
shellToken = null;
shell.connect();
await settle();
t('no token file: the not-signed-in card, no exchange', [exchanges, shell.view], [0, 'signed-out']);
shellToken = TOKEN;

// ---- AC5: the server not answering ---------------------------------------------------------------
// The not-signed-in card watches the server: still answering, it stays.
await timers.at(-1).fn();
t('the not-signed-in card stays while the server answers', [shell.view, exchanges], ['signed-out', 0]);
await stopServer();
timers.length = 0;
win.events['did-fail-load']({}, -102, 'ERR_CONNECTION_REFUSED', `${ORIGIN}/`, true);
await settle();
t('a server that does not answer shows the unreachable card, never a blank window',
  [win.loads.at(-1), shell.view, win.query?.attempt, win.query?.retry, timers.at(-1)?.ms], ['card:unreachable', 'unreachable', '1', '5', 5000]);
win.events['did-fail-load']({}, -3, 'ERR_ABORTED', `${ORIGIN}/`, true);
t('a load another navigation replaced is not a failure', win.query?.attempt, '1');
await timers.at(-1).fn();
await settle();
t('each retry counts its attempt', [shell.view, win.query?.attempt], ['unreachable', '2']);
t('Try now on the unreachable card starts the server\'s job and tries at once', [await f.ipc['desk:start-server'](from(win, 'file:///x/status.html')), kicks], [true, 1]);
await settle();
t('Try now from another window does nothing', [await f.ipc['desk:start-server']({ sender: {}, senderFrame: { url: 'file:///x/status.html' } }), kicks], [false, 1]);
t('the server starts again', await startServer(), true);
await timers.at(-1).fn();
await settle();
t('once the server answers, the window signs in and loads it', [shell.view, win.loads.at(-1)], ['app', `${ORIGIN}/`]);
// A server that comes back after a refusal is tried once more, though the token did not change.
shellToken = WRONG;
await shell.connect();
await settle();
t('a refused token shows the not-signed-in card', shell.view, 'signed-out');
await stopServer();
await timers.at(-1).fn();
await settle();
t('the card notices the server stop', shell.view, 'unreachable');
await startServer();
exchanges = 0;
await timers.at(-1).fn();
await settle();
t('after a server restart a refused token is tried once more', [exchanges, shell.view], [1, 'signed-out']);
// A restart the card never saw down (launchctl kickstart -k is back within a second) is a new server too.
await stopServer();
await startServer();
exchanges = 0;
await timers.at(-1).fn();
await settle();
t('a restart between two looks is noticed, and the refused token is tried once more', [exchanges, shell.view], [1, 'signed-out']);
await timers.at(-1).fn();
await settle();
t('the same server is not asked again', [exchanges, shell.view], [1, 'signed-out']);
shellToken = TOKEN;

// A window opened while the server is down shows the card straight away.
await stopServer();
const cold = fakeElectron();
const coldShell = createShell(cold.electron, opts());
const coldWin = coldShell.open();
await settle();
t('Desk.app opened on a stopped server shows the unreachable card', [coldWin.loads, coldShell.view], [['card:unreachable'], 'unreachable']);
// With no token file either, it is still the unreachable card, and it stays on it.
const bare = fakeElectron();
const bareShell = createShell(bare.electron, opts({ token: () => null }));
const bareWin = bareShell.open();
await settle();
await timers.at(-1).fn();
await settle();
t('no token and a stopped server: the unreachable card, retry after retry', [bareWin.loads, bareShell.view], [['card:unreachable', 'card:unreachable'], 'unreachable']);
await startServer();

// The cards themselves, as the window shows them: status.html with status.js run against its markup.
const html = readFileSync(join(SHELL, 'status.html'), 'utf8');
function card(query) {
  const els = {};
  for (const m of html.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const from = m.index + m[0].length;
    const text = html.slice(from, html.indexOf(`</${m[1]}>`, from)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    els[m[3]] = { hidden: /\shidden\b/.test(m[2]), textContent: text, addEventListener: () => {} };
  }
  runInNewContext(readFileSync(join(SHELL, 'status.js'), 'utf8'), {
    location: { search: `?${new URLSearchParams(query)}` }, URLSearchParams,
    document: { getElementById: (id) => els[id] ?? null, querySelectorAll: () => [] },
    setInterval: () => 0, setTimeout: () => 0, navigator: {}, window: {},
  });
  return Object.fromEntries(Object.entries(els).filter(([, e]) => !e.hidden).map(([id, e]) => [id, e.textContent]));
}
const shown = card({ state: 'unreachable', attempt: '2', retry: '5' });
t('the unreachable card is the one shown, with the spec\'s copy and command', [shown.unreachable?.includes("Desk can't reach its local server"),
  shown.unreachable?.includes("The desk-ui server on 127.0.0.1:4823 isn't answering. Your queues are safe: workers and the supervisor keep running without it."),
  shown.unreachable?.includes('launchctl kickstart -k gui/$(id -u)/com.desk-skills.ui'), shown.countdown, 'signed-out' in shown],
  [true, true, true, 'Trying again in 5 s… (attempt 2)', false]);
const out = card({ state: 'signed-out', checkout: '~/src/desk-skills' });
t('the not-signed-in card is the one shown, with the spec\'s copy and the checkout\'s command', [out['signed-out']?.includes("This window isn't signed in to Desk"),
  out['signed-out']?.includes("Re-run install.sh in Terminal. It writes Desk's sign-in again, and this window signs in by itself."), out['install-cmd'], 'unreachable' in out],
  [true, true, 'cd ~/src/desk-skills && ./install.sh', false]);
kicks = 0;
t('Try now only acts on the unreachable card', [await f.ipc['desk:start-server'](from(win, 'file:///x/status.html')), kicks, shell.view], [false, 0, 'signed-out']);

// ---- the hardened window -----------------------------------------------------------------------
// AC1: the page reaches no Node, and only the preload's five calls.
const exposed = {}, invoked = [], listeners = {};
runInNewContext(readFileSync(join(SHELL, 'preload.cjs'), 'utf8'), {
  require: (m) => (m === 'electron' ? {
    contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } },
    ipcRenderer: { invoke: (ch, ...a) => { invoked.push([ch, ...a]); return null; }, on: (ch, fn) => { listeners[ch] = fn; } },
  } : null),
});
t('the preload exposes desk.badge, notify, openExternal, onDeepLink and startServer only',
  Object.fromEntries(Object.entries(exposed).map(([k, v]) => [k, Object.keys(v)])), { desk: ['badge', 'notify', 'openExternal', 'onDeepLink', 'startServer'] });
exposed.desk.badge(3); exposed.desk.notify({ title: 'T', body: 'B', extra: 1 }); exposed.desk.openExternal('https://github.com/x'); exposed.desk.startServer();
t('each call goes to its own channel, passing only plain values', invoked,
  [['desk:badge', 3], ['desk:notify', { title: 'T', body: 'B' }], ['desk:open-external', 'https://github.com/x'], ['desk:start-server']]);
const routes = [];
exposed.desk.onDeepLink((...a) => routes.push(a));
listeners['desk:deep-link']({ sender: 'the IPC event' }, '/inbox/x');
t('a deep link reaches the page as its route alone, never the IPC event', routes, [['/inbox/x']]);
t('the main process answers only those channels', Object.keys(f.ipc).sort(), ['desk:badge', 'desk:notify', 'desk:open-external', 'desk:start-server']);
t('no webview tag', prefs.webviewTag, false);

// AC2: the page cannot leave the server or open a window.
const nav = (ev, url) => { let blocked = false; win.events[ev]({ url, preventDefault: () => { blocked = true; } }, url); return blocked; };
t('navigating to another site, a file, or another port is blocked',
  ['https://evil.example/', 'file:///etc/passwd', 'http://127.0.0.1:1/', 'http://localhost:4823/', 'javascript:alert(1)'].map((u) => nav('will-navigate', u)), [true, true, true, true, true]);
t('a redirect away from the server is blocked', nav('will-redirect', 'https://evil.example/'), true);
t('navigating within the server is not', [nav('will-navigate', `${ORIGIN}/inbox`), nav('will-redirect', `${ORIGIN}/`)], [false, false]);
t('no new window opens, for any URL', ['https://github.com/a', `${ORIGIN}/`, 'about:blank'].map((url) => win.openHandler({ url }).action), ['deny', 'deny', 'deny']);
t('no camera, microphone, location or web notifications; the Copy buttons may write the clipboard',
  [['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'clipboard-sanitized-write'].map((p) => { let r = null; f.permRequest()(null, p, (x) => { r = x; }); return r; }),
    f.permCheck()(null, 'media'), f.permCheck()(null, 'clipboard-sanitized-write')],
  [[false, false, false, false, false, true], false, true]);

// AC3 and AC4: openExternal opens GitHub and the configured Jira sites, and nothing else.
await shell.connect();
await settle();
const ext = async (url, frame = `${ORIGIN}/`) => [await f.ipc['desk:open-external'](from(win, frame), url), f.opened.at(-1) === url];
f.opened.length = 0;
t('a GitHub link opens in the browser', await ext('https://github.com/bigbenjoman/desk-skills/pull/1'), [true, true]);
t('a configured Jira site\'s link opens in the browser', await ext('https://acme.atlassian.net/browse/DS-721'), [true, true]);
const refused = ['file:///etc/passwd', 'https://evil.example/', 'http://github.com/x', 'https://github.com.evil.example/', 'https://github.com@evil.example/',
  'https://user:pw@github.com/', 'https://gist.github.com/x', 'https://other.atlassian.net/browse/X', 'javascript:alert(1)', 'not a url', 42, { href: 'https://github.com/' }];
const before2 = f.opened.length;
t('any other URL opens nothing', [await Promise.all(refused.map((u) => f.ipc['desk:open-external'](from(win), u))), f.opened.length - before2], [refused.map(() => false), 0]);
t('a page that is not the server\'s cannot open even a GitHub link',
  [await f.ipc['desk:open-external'](from(win, 'file:///x/status.html'), 'https://github.com/'), await f.ipc['desk:open-external']({ sender: {}, senderFrame: { url: `${ORIGIN}/` } }, 'https://github.com/'), f.opened.length - before2], [false, false, 0]);

// The badge and notifications, from the server's page only, with plain values only.
t('the badge shows a count, and clears at 0', [await f.ipc['desk:badge'](from(win), 25), await f.ipc['desk:badge'](from(win), 0), f.badges], [true, true, ['25', '']]);
t('the badge refuses anything but a count, or another page', [await f.ipc['desk:badge'](from(win), -1), await f.ipc['desk:badge'](from(win), '9'), await f.ipc['desk:badge'](from(win, 'https://evil.example/'), 9), f.badges.length], [false, false, false, 2]);
t('a notification shows its title and body', [await f.ipc['desk:notify'](from(win), { title: ' Parked ', body: 'DS-1 needs you' }), f.notes], [true, [{ title: 'Parked', body: 'DS-1 needs you' }]]);
t('a notification with no title, or from another page, shows nothing', [await f.ipc['desk:notify'](from(win), { body: 'x' }), await f.ipc['desk:notify'](from(win, 'file:///x'), { title: 'x' }), f.notes.length], [false, false, 1]);
t('a long notification is cut short', (await f.ipc['desk:notify'](from(win), { title: 'x'.repeat(500), body: 'y'.repeat(5000) }), [f.notes.at(-1).title.length, f.notes.at(-1).body.length]), [120, 500]);

// The Jira sites come from each configured repo's config, through desk-env.
const cfgRoot = join(T, 'jira-config');
for (const [slug, site] of [['acme__a', 'acme.atlassian.net'], ['acme__b', 'https://Other.Example.com/'], ['acme__c', 'none']]) {
  mkdirSync(join(cfgRoot, 'repos', slug), { recursive: true });
  writeFileSync(join(cfgRoot, 'repos', slug, 'config.md'), `## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Jira site | \`${site}\` |\n`);
}
t('each configured repo\'s Jira site, from desk-env', await jiraSites({ configRoot: cfgRoot, deskHome: T }, join(ROOT, 'desk', 'bin', 'desk-env.mjs')), ['acme.atlassian.net', 'other.example.com']);
t('no desk-env to read: no Jira site', await jiraSites({ configRoot: cfgRoot, deskHome: join(T, 'nowhere') }), []);
t('externalUrl matches a Jira site by its whole host', [await externalUrl('https://acme.atlassian.net/x', async () => ['acme.atlassian.net']), await externalUrl('https://acme.atlassian.net.evil.example/x', async () => ['acme.atlassian.net'])],
  ['https://acme.atlassian.net/x', null]);

// ---- AC4: one copy only ------------------------------------------------------------------------
const second = fakeElectron({ lock: false });
t('a second launch quits and opens no window', [run(second.electron, opts()), second.quits(), second.windows.length], [null, 1, 0]);
const first = fakeElectron();
const running = run(first.electron, opts());
first.ready();
await settle();
first.windows[0].minimized = true;
first.appEvents['second-instance']();
first.appEvents.activate();
t('opening it again brings the one window to the front', [first.windows.length, first.windows[0].minimized, first.windows[0].focused, running.shell.view], [1, false, 2, 'app']);

// ---- the package Desk.app is built from ----------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(SHELL, 'package.json'), 'utf8'));
t('the bundle identifier and name are fixed', [pkg.build.appId, pkg.build.productName, pkg.main], ['com.desk-skills.desk', 'Desk', 'main.mjs']);
t('every file the app loads is packaged', ['main.mjs', 'app.mjs', 'preload.cjs', 'status.html', 'status.js'].every((x) => pkg.build.files.includes(x)), true);
t('the Electron major is pinned', /^\^\d+\.\d+\.\d+$/.test(pkg.devDependencies.electron), true);

await stopServer();
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
