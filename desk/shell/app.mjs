// Desk.app's main process, with Electron passed in so the tests drive it with stubs. It opens one
// window on the desk-ui server and signs it in itself: it reads the token file, posts it to
// /api/auth/exchange, and keeps the session cookie only in the window's own session store. The
// per-load token goes to the page through the preload, never a cookie the page can read.
// A refusal signs in again once; a refusal straight after that shows the not-signed-in card until the
// token file changes or the server restarts. A server that does not answer shows the unreachable card
// and is tried again every few seconds.
import { request } from 'node:http';
import { readFileSync, watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ORIGIN = 'http://127.0.0.1:4823';
export const PARTITION = 'persist:desk';
export const RETRY_MS = 5000;
const COOKIE = 'desk_ui';

// Where the server keeps its files. install.sh writes the config root and desk home it installed the
// server with into the bundle (desk-paths.json), because Finder and the Dock start Desk.app without
// install.sh's environment; the environment and the defaults are for a run from source.
const expandHome = (p) => p.replace(/^~(?=\/|$)/, homedir());
export function deskPaths(file, env = process.env) {
  let baked = {};
  try { if (file) baked = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { /* none written */ }
  const pick = (...xs) => expandHome(xs.find((x) => typeof x === 'string' && x));
  return {
    configRoot: pick(baked.configRoot, env.DESK_CONFIG_ROOT, join(homedir(), '.config', 'desk')),
    deskHome: pick(baked.deskHome, env.DESK_HOME, join(homedir(), '.claude', 'desk')),
  };
}
export const tokenFile = (paths = deskPaths()) => join(paths.configRoot, 'ui-token');
export function readToken(file = tokenFile()) {
  try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}
// The checkout install.sh last ran from, for the not-signed-in card's command.
export function checkout(paths = deskPaths()) {
  try {
    const from = JSON.parse(readFileSync(join(paths.deskHome, 'installed.json'), 'utf8')).from;
    return typeof from === 'string' && from ? from.replace(homedir(), '~') : null;
  } catch { return null; }
}

// `desk_ui=<id>; HttpOnly; ...; Max-Age=<s>` -> { value, maxAge }, or null for any other cookie.
export function parseCookie(header) {
  const [pair, ...attrs] = String(header).split(';').map((s) => s.trim());
  const i = pair.indexOf('=');
  if (i < 1 || pair.slice(0, i) !== COOKIE) return null;
  const age = attrs.map((a) => /^max-age=(\d+)$/i.exec(a)).find(Boolean);
  return { value: pair.slice(i + 1), maxAge: age ? Number(age[1]) : null };
}

// The run of the server that answered: its X-Desk-Boot header, '' from a server that names none.
// Node's headers are lower-cased; Electron's keep the server's case and come as arrays.
export function bootIn(headers = {}) {
  const k = Object.keys(headers ?? {}).find((h) => h.toLowerCase() === 'x-desk-boot');
  return String([].concat(k ? headers[k] : [])[0] ?? '');
}

// The sign-in exchange -> { status, cookie, loadToken, boot }; status 0 when nothing answers.
export function exchange(origin, token, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ token });
    const req = request(`${origin}/api/auth/exchange`, {
      method: 'POST', timeout: timeoutMs,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let loadToken = null;
        try { loadToken = JSON.parse(Buffer.concat(chunks).toString('utf8')).loadToken ?? null; } catch { /* not JSON */ }
        const cookie = [].concat(res.headers['set-cookie'] ?? []).map(parseCookie).find(Boolean) ?? null;
        resolve({ status: res.statusCode, cookie, loadToken, boot: bootIn(res.headers) });
      });
      res.on('error', () => resolve({ status: 0 }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0 }));
    req.end(body);
  });
}

// Which run of the server answers on its address (a string), or null when nothing answers.
export function serverBoot(origin, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = request(`${origin}/`, { method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(bootIn(res.headers));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.end();
  });
}

const quiet = (p) => { Promise.resolve(p).catch(() => {}); }; // a load another one replaced; did-fail-load reports real failures

export function createShell(electron, {
  origin = ORIGIN, preload, page, paths = deskPaths(), token = () => readToken(tokenFile(paths)), signIn = exchange,
  install = () => checkout(paths), probe = serverBoot,
  watch = (fn) => watchFile(tokenFile(paths), { interval: 2000 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) fn(); }),
  retryMs = RETRY_MS, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const { BrowserWindow, session, ipcMain } = electron;
  const ses = session.fromPartition(PARTITION);
  let win = null, view = null, load = null, timer = null, attempt = 0;
  let refusedToken = null; // the token the server refused at sign-in: not tried again until it changes
  let cardBoot = null;     // the run of the server the not-signed-in card is for: a new run gets one more try
  let signedBoot = null;   // the run of the server the window signed in to
  let fresh = false;       // signed in, and nothing from the server has succeeded since

  const fromServer = (url) => { try { return new URL(url).origin === origin; } catch { return false; } };
  ipcMain.handle('desk:load-token', (e) => (fromServer(e.senderFrame?.url) ? load : null));
  ipcMain.handle('desk:retry', () => { if (view === 'unreachable') connect(); });

  function show(state, extra = {}) {
    view = state;
    if (win) quiet(win.loadFile(page, { query: { state, ...extra } }));
  }
  function unreachable() {
    refusedToken = null; // the server that comes back is a new one: its refusal is worth one more try
    attempt += 1;
    show('unreachable', { attempt: String(attempt), retry: String(Math.round(retryMs / 1000)) });
    clearTimer(timer);
    timer = setTimer(connect, retryMs);
  }
  // The not-signed-in card watches the server: one that stops answering gets the unreachable card, and
  // one that restarted (a new X-Desk-Boot) gets one more sign-in.
  function signedOut(boot) {
    cardBoot = boot;
    const from = install();
    show('signed-out', from ? { checkout: from } : {});
    clearTimer(timer);
    timer = setTimer(watchServer, retryMs);
  }
  async function watchServer() {
    timer = null;
    if (view !== 'signed-out') return;
    const boot = await probe(origin);
    if (view !== 'signed-out' || timer) return;
    if (boot === null) return unreachable();
    if (boot !== cardBoot) { refusedToken = null; return connect(); }
    timer = setTimer(watchServer, retryMs);
  }

  let busy = null;
  function connect() {
    clearTimer(timer); timer = null;
    busy ??= (async () => {
      const t = token();
      if (!t || t === refusedToken) {
        // Nothing to sign in with: which card depends on whether the server answers.
        const boot = await probe(origin);
        if (!win) return;
        return boot === null ? unreachable() : signedOut(boot);
      }
      const r = await signIn(origin, t);
      if (!win) return;
      if (r.status === 0) return unreachable();
      if (r.status !== 200 || !r.cookie || !r.loadToken) { refusedToken = t; return signedOut(r.boot ?? ''); }
      const cookie = { url: origin, name: COOKIE, value: r.cookie.value, path: '/', httpOnly: true, sameSite: 'strict' };
      if (r.cookie.maxAge) cookie.expirationDate = Date.now() / 1000 + r.cookie.maxAge;
      await ses.cookies.set(cookie);
      if (!win) return;
      load = r.loadToken; signedBoot = r.boot ?? ''; attempt = 0; fresh = true; view = 'app';
      quiet(win.loadURL(`${origin}/`));
    })().catch(() => { if (win) unreachable(); }).finally(() => { busy = null; });
    return busy;
  }

  // Every answer from the server to this window: a refusal signs in again, once. A refusal before
  // anything succeeded is the same server refusing the new session, unless the server restarted since.
  ses.webRequest.onCompleted({ urls: [`${origin}/*`] }, (d) => {
    if (view !== 'app') return;
    if (d.statusCode === 401) {
      const boot = bootIn(d.responseHeaders);
      if (fresh && boot === signedBoot) { refusedToken = token(); load = null; signedOut(boot); } else connect();
    } else if (d.statusCode < 400) fresh = false;
  });
  watch(() => { if (view === 'signed-out') connect(); });

  function open() {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return win; }
    win = new BrowserWindow({
      width: 1280, height: 820, minWidth: 900, minHeight: 600, title: 'Desk', backgroundColor: '#09090b',
      webPreferences: { partition: PARTITION, preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // -3 is a load that another navigation replaced, not a failure.
    win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => { if (isMain && code !== -3 && fromServer(url)) unreachable(); });
    win.on('closed', () => { win = null; view = null; clearTimer(timer); timer = null; });
    connect();
    return win;
  }
  return { open, connect, get view() { return view; } };
}

// One copy only: a second launch hands over to the first, whose window comes to the front.
export function run(electron, opts) {
  const { app } = electron;
  if (!app.requestSingleInstanceLock()) { app.quit(); return null; }
  let shell = null;
  const open = () => shell?.open();
  app.on('second-instance', open);
  app.on('activate', open);
  app.whenReady().then(() => { shell = createShell(electron, opts); shell.open(); });
  return { get shell() { return shell; } };
}
