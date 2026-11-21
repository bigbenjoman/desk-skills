// suite: Desk.app's main process (sign-in, re-sign-in, the unreachable card, one copy only)
// covers: desk/shell/** desk/shell/app.mjs desk/shell/main.mjs desk/shell/preload.cjs desk/shell/status.html desk/shell/status.js desk/shell/package.json
// desk/shell/app.mjs driven with a stubbed Electron (BrowserWindow, session, ipcMain, app) against the
// real desk-ui server on a throwaway HOME and a test-only port. Nothing touches your real ~/.claude,
// ~/.config/desk, state, or a server on 4823.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
import { createShell, exchange, parseCookie, run, PARTITION } from '../desk/shell/app.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin', 'desk-ui.mjs');
const SHELL = join(ROOT, 'desk', 'shell');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
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

function call(path, headers = {}) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let text = ''; res.on('data', (d) => { text += d; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
}

// ---- a stubbed Electron ------------------------------------------------------------------------
function fakeElectron({ lock = true } = {}) {
  const ipc = {}, appEvents = {}, windows = [], cookies = [];
  let completed = null, ready = null, quit = 0;
  class BrowserWindow {
    constructor(opts) { this.opts = opts; this.loads = []; this.events = {}; this.minimized = false; this.focused = 0; this.webContents = { on: (ev, fn) => { this.events[ev] = fn; } }; windows.push(this); }
    loadURL(u) { this.loads.push(u); }
    loadFile(p, { query } = {}) { this.loads.push(`card:${query.state}`); this.page = p; this.query = query; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() {}
    focus() { this.focused += 1; }
    on(ev, fn) { this.events[ev] = fn; }
  }
  const ses = { partition: null, cookies: { set: async (c) => { cookies.push(c); } }, webRequest: { onCompleted: (filter, fn) => { completed = { filter, fn }; } } };
  const electron = {
    BrowserWindow,
    session: { fromPartition: (p) => { ses.partition = p; return ses; } },
    ipcMain: { handle: (name, fn) => { ipc[name] = fn; } },
    app: {
      requestSingleInstanceLock: () => lock,
      quit: () => { quit += 1; },
      on: (ev, fn) => { appEvents[ev] = fn; },
      whenReady: () => new Promise((r) => { ready = r; }),
    },
  };
  return { electron, ipc, appEvents, windows, cookies, ses, completed: () => completed, ready: () => ready?.(), quits: () => quit };
}

// What the window does when it loads a server URL: the request with the cookie its store holds, then
// the response handed to the session's webRequest listener, as Chromium does.
async function windowLoads(f, path = '/') {
  const c = f.cookies.at(-1);
  const r = await call(path, c ? { Cookie: `${c.name}=${c.value}` } : {});
  f.completed()?.fn({ url: `${ORIGIN}${path}`, statusCode: r.status, resourceType: 'mainFrame' });
  return r;
}
const settle = () => sleep(150);

t('the desk-ui server starts on the test port', await startServer(), true);

// ---- helpers ----------------------------------------------------------------------------------
t('parseCookie reads desk_ui and its Max-Age', parseCookie('desk_ui=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400'), { value: 'abc', maxAge: 86400 });
t('parseCookie ignores another cookie', parseCookie('other=1; Path=/'), null);
const refusedX = await exchange(ORIGIN, WRONG);
t('exchange with the wrong token: 401, no cookie', [refusedX.status, refusedX.cookie, refusedX.loadToken], [401, null, null]);

// ---- AC1: the window opens on the server, signed in --------------------------------------------
let shellToken = TOKEN;
let exchanges = 0;
const timers = [];
const signIn = (o, tok) => { exchanges += 1; return exchange(o, tok); };
const opts = (more = {}) => ({ origin: ORIGIN, preload: join(SHELL, 'preload.cjs'), page: join(SHELL, 'status.html'), token: () => shellToken, signIn,
  install: () => '~/src/desk-skills', watch: (fn) => { watchers.push(fn); }, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, ...more });
const watchers = [];
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

// The per-load token, through the preload's IPC, to the server's own pages only.
const load = await f.ipc['desk:load-token']({ senderFrame: { url: `${ORIGIN}/` } });
const meta = await call('/api/meta', { Cookie: `desk_ui=${f.cookies[0].value}`, 'X-Desk-Load': load ?? '' });
t('the load token answers the server\'s page and works on /api', [typeof load, load?.length, meta.status], ['string', 64, 200]);
t('the load token is refused to any other page', [await f.ipc['desk:load-token']({ senderFrame: { url: 'https://example.com/' } }), await f.ipc['desk:load-token']({ senderFrame: { url: 'file:///x/status.html' } })], [null, null]);
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
f.completed().fn({ url: `${ORIGIN}/`, statusCode: 401 });
await settle();
t('a refusal straight after signing in shows the card rather than signing in again', [exchanges, shell.view], [0, 'signed-out']);
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
shellToken = TOKEN;

// A window opened while the server is down shows the card straight away.
await stopServer();
const cold = fakeElectron();
const coldShell = createShell(cold.electron, opts());
const coldWin = coldShell.open();
await settle();
t('Desk.app opened on a stopped server shows the unreachable card', [coldWin.loads, coldShell.view], [['card:unreachable'], 'unreachable']);
await startServer();

// The cards themselves: the copy the screen spec states, and the retry button wired to the main process.
const html = readFileSync(join(SHELL, 'status.html'), 'utf8');
t('the unreachable card says what the spec says', [html.includes("Desk can't reach its local server"), html.includes('launchctl kickstart -k gui/$(id -u)/com.desk-skills.ui'),
  html.includes("The desk-ui server on 127.0.0.1:4823 isn't answering. Your queues are safe: workers and the supervisor keep running without it.")], [true, true, true]);
t('the not-signed-in card says what the spec says', [html.includes("This window isn't signed in to Desk"), html.includes("Re-run install.sh in Terminal. It writes Desk's sign-in again, and this window signs in by itself.")], [true, true]);
await f.ipc['desk:retry']();
t('Try now only acts on the unreachable card', shell.view, 'signed-out');

// The preload exposes the two calls and nothing else.
const exposed = {};
runInNewContext(readFileSync(join(SHELL, 'preload.cjs'), 'utf8'), {
  require: (m) => (m === 'electron' ? { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = Object.keys(v); } }, ipcRenderer: { invoke: () => null } } : null),
});
t('the preload exposes desk.loadToken and desk.retryNow only', exposed, { desk: ['loadToken', 'retryNow'] });

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
