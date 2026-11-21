// Desk.app's main process, with Electron passed in so the tests drive it with stubs. It opens one
// window on the desk-ui server and signs it in itself: it reads the token file, posts it to
// /api/auth/exchange, and keeps the session cookie only in the window's own session store. The
// per-load token goes to the page through the preload, never a cookie the page can read.
// A refusal signs in again once; a refusal straight after that shows the not-signed-in card until the
// token file changes or the server restarts. A server that does not answer shows the unreachable card
// and is tried again every few seconds.
import { request } from 'node:http';
import { connect as netConnect } from 'node:net';
import { readFileSync, watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ORIGIN = 'http://127.0.0.1:4823';
export const PARTITION = 'persist:desk';
export const RETRY_MS = 5000;
const COOKIE = 'desk_ui';

export const tokenFile = (env = process.env) => join(env.DESK_CONFIG_ROOT || join(homedir(), '.config', 'desk'), 'ui-token');
export function readToken(file = tokenFile()) {
  try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}
// The checkout install.sh last ran from, for the not-signed-in card's command.
export function checkout(env = process.env) {
  try {
    const from = JSON.parse(readFileSync(join(env.DESK_HOME || join(homedir(), '.claude', 'desk'), 'installed.json'), 'utf8')).from;
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

// The sign-in exchange -> { status, cookie, loadToken }; status 0 when nothing answers.
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
        resolve({ status: res.statusCode, cookie, loadToken });
      });
      res.on('error', () => resolve({ status: 0 }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0 }));
    req.end(body);
  });
}

// Whether anything answers on the server's address.
export function reachable(origin, ms = 1000) {
  return new Promise((resolve) => {
    const u = new URL(origin);
    const s = netConnect({ host: u.hostname, port: Number(u.port) });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export function createShell(electron, {
  origin = ORIGIN, preload, page, token = () => readToken(), signIn = exchange, install = () => checkout(), probe = reachable,
  watch = (fn) => watchFile(tokenFile(), { interval: 2000 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) fn(); }),
  retryMs = RETRY_MS, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const { BrowserWindow, session, ipcMain } = electron;
  const ses = session.fromPartition(PARTITION);
  let win = null, view = null, load = null, timer = null, attempt = 0;
  let refusedToken = null; // the token the server refused at sign-in: not tried again until it changes
  let fresh = false;       // signed in, and nothing from the server has succeeded since

  const fromServer = (url) => { try { return new URL(url).origin === origin; } catch { return false; } };
  ipcMain.handle('desk:load-token', (e) => (fromServer(e.senderFrame?.url) ? load : null));
  ipcMain.handle('desk:retry', () => { if (view === 'unreachable') connect(); });

  function show(state, extra = {}) {
    view = state;
    if (win) win.loadFile(page, { query: { state, ...extra } });
  }
  function unreachable() {
    refusedToken = null; // the server that comes back is a new one: its refusal is worth one more try
    attempt += 1;
    show('unreachable', { attempt: String(attempt), retry: String(Math.round(retryMs / 1000)) });
    clearTimer(timer);
    timer = setTimer(connect, retryMs);
  }
  // The not-signed-in card watches the server: one that stops answering gets the unreachable card,
  // and signs in once more when it is back.
  function signedOut() {
    const from = install();
    show('signed-out', from ? { checkout: from } : {});
    clearTimer(timer);
    timer = setTimer(watchServer, retryMs);
  }
  async function watchServer() {
    timer = null;
    if (view !== 'signed-out') return;
    if (!(await probe(origin))) { if (view === 'signed-out') unreachable(); return; }
    if (view === 'signed-out' && !timer) timer = setTimer(watchServer, retryMs);
  }

  let busy = null;
  function connect() {
    clearTimer(timer); timer = null;
    busy ??= (async () => {
      const t = token();
      if (!t || t === refusedToken) return signedOut();
      const r = await signIn(origin, t);
      if (!win) return;
      if (r.status === 0) return unreachable();
      if (r.status !== 200 || !r.cookie || !r.loadToken) { refusedToken = t; return signedOut(); }
      const cookie = { url: origin, name: COOKIE, value: r.cookie.value, path: '/', httpOnly: true, sameSite: 'strict' };
      if (r.cookie.maxAge) cookie.expirationDate = Date.now() / 1000 + r.cookie.maxAge;
      await ses.cookies.set(cookie);
      load = r.loadToken; attempt = 0; fresh = true; view = 'app';
      win.loadURL(`${origin}/`);
    })().finally(() => { busy = null; });
    return busy;
  }

  // Every answer from the server to this window: a refusal signs in again, once.
  ses.webRequest.onCompleted({ urls: [`${origin}/*`] }, (d) => {
    if (view !== 'app') return;
    if (d.statusCode === 401) {
      if (fresh) { refusedToken = token(); load = null; signedOut(); } else connect();
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
