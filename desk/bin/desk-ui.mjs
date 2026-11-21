#!/usr/bin/env node
// desk-ui: the desk app's local server, bound to 127.0.0.1:4823 and kept alive by launchd
// (com.desk-skills.ui). It answers only a Desk window that signed in to it; stopped, desk behaves as
// it always has.
//   node desk-ui.mjs serve       run the server (what launchd runs). Exits 2 when DESK_UI_HOST names
//                                any address but 127.0.0.1, 3 when the port is taken
//   node desk-ui.mjs install     write ~/.config/desk/ui-token (chmod 600) if missing, refuse when
//                                another process holds the port, then load the launchd job and wait
//                                for it to answer (install.sh runs this on macOS)
//   node desk-ui.mjs uninstall   unload the launchd job and remove its plist; nothing else changes
//
// Every request must name Host 127.0.0.1:4823 or localhost:4823; a request carrying an Origin, and
// every request that is not GET or HEAD, must come from http://127.0.0.1:4823. No response carries a
// CORS header. POST /api/auth/exchange {token} trades the token file's token for an HttpOnly,
// SameSite=Strict session cookie and a per-load token; every other /api route needs both, the
// per-load token in the X-Desk-Load header. Sessions live in memory, so a restart signs everyone out.
// DESK_UI_TEST_PORT moves the port, read only when HOME is not this user's own home (a test HOME).
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { AGENTS, runningVersion } from './installed.mjs';
import { launchctl, launchdDomain as domain, platform, plist } from './run-by.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4823;
const HOST = '127.0.0.1';
const LABEL = 'com.desk-skills.ui';
const COOKIE = 'desk_ui';
const LOAD_HEADER = 'x-desk-load';
const SESSION_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;
const MAX_BODY = 4096;

const testHome = () => !!process.env.HOME && process.env.HOME !== userInfo().homedir;
export function port() {
  const p = Number(process.env.DESK_UI_TEST_PORT);
  return testHome() && Number.isInteger(p) && p > 0 && p < 65536 ? p : PORT;
}
const tokenFile = () => join(E.deskConfigRoot(), 'ui-token');
const plistFile = () => join(AGENTS, `${LABEL}.plist`);
const logDir = () => join(E.HOME, '.desk-autopilot', 'ui');
const version = () => { try { return runningVersion() ?? 'unknown'; } catch { return 'unknown'; } };

// ---- the request guard -----------------------------------------------------------------------

const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; frame-ancestors 'none'";
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP };

const digest = (s) => createHash('sha256').update(String(s)).digest();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(digest(a), digest(b));
// Every desk_ui value the request carries: another 127.0.0.1 port can set one with a longer Path, which
// the browser sends first.
function cookiesOf(req) {
  const out = [];
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) out.push(part.slice(i + 1).trim());
  }
  return out;
}
const readToken = () => { try { return readFileSync(tokenFile(), 'utf8').trim() || null; } catch { return null; } };

function makeServer({ p = port(), log = (line) => console.log(line) } = {}) {
  const origin = `http://${HOST}:${p}`;
  const hosts = new Set([`${HOST}:${p}`, `localhost:${p}`]);
  const sessions = new Map(); // session id -> { load, expires }
  // Names this run of the server on every response, so Desk.app can tell a restart (which signed
  // everyone out) from the same server refusing it again. It grants nothing.
  const boot = randomBytes(8).toString('hex');
  let rev = 0, lastBody = null;

  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    const text = type.startsWith('application/json') ? JSON.stringify(body) : String(body);
    res.writeHead(status, { ...BASE_HEADERS, 'X-Desk-Boot': boot, 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), ...extra });
    res.end(text);
  };
  const refuse = (res, status, code, message) => send(res, status, { error: { code, message } });

  function session(req) {
    const sids = cookiesOf(req).slice(0, 8);
    if (!sids.length) return null;
    for (const [id, s] of sessions) {
      if (s.expires <= Date.now()) { sessions.delete(id); continue; }
      if (sids.some((sid) => same(id, sid))) return s;
    }
    return null;
  }
  function signIn() {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = randomBytes(32).toString('hex'), load = randomBytes(32).toString('hex');
    sessions.set(id, { load, expires: Date.now() + SESSION_MS });
    return { id, load };
  }

  async function snapshot() {
    const Q = await import('./desk-q-model.mjs');
    const now = Date.now();
    E.forgetReads(); // this process outlives edits to the machine profile and configs
    const { lines, generated_at, inputs, ...body } = Q.homeJson(Q.loadRepos(now), { all: true, now });
    // The revision moves with desk's state, not with the clock or free memory.
    const key = JSON.stringify({ needs: body.needs_you, running: body.machine?.running, cap: body.machine?.cap,
      repos: (body.repos ?? []).map(({ last_pass, all_done_by, ...r }) => r) });
    if (key !== lastBody) { rev += 1; lastBody = key; }
    return { at: new Date(now).toISOString(), rev, ...body, inputs };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const path = String(req.url ?? '/').split('?')[0];
    const method = req.method ?? 'GET';
    if (!hosts.has(String(req.headers.host ?? ''))) return refuse(res, 403, 'host', 'This server answers only 127.0.0.1 and localhost on its own port.');
    const from = req.headers.origin;
    const reading = method === 'GET' || method === 'HEAD';
    if ((from !== undefined || !reading) && from !== origin) return refuse(res, 403, 'origin', `Requests must come from ${origin}.`);
    if (method === 'OPTIONS') return refuse(res, 405, 'method', 'Not allowed.');

    if (path === '/api/auth/exchange') {
      if (method !== 'POST') return refuse(res, 405, 'method', 'POST only.');
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return refuse(res, 415, 'content_type', 'JSON only.');
      let given = null;
      try { given = JSON.parse(await readBody(req))?.token; } catch { return refuse(res, 400, 'body', 'Send {"token": "..."} as JSON.'); }
      const want = readToken();
      if (!want || !same(String(given ?? ''), want)) return refuse(res, 401, 'unauthorized', 'Not signed in.');
      const s = signIn();
      return send(res, 200, { loadToken: s.load }, undefined,
        { 'Set-Cookie': `${COOKIE}=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
    }

    const s = session(req);
    if (path.startsWith('/api/')) {
      if (!s || !same(String(req.headers[LOAD_HEADER] ?? ''), s.load)) return refuse(res, 401, 'unauthorized', 'Not signed in.');
      if (!reading) return refuse(res, 405, 'method', 'Not allowed.');
      if (path === '/api/snapshot') {
        try { return send(res, 200, await snapshot()); } catch (e) { console.error(`desk-ui: snapshot: ${e.message}`); return refuse(res, 500, 'read', "Could not read desk's state; see the server log."); }
      }
      if (path === '/api/meta') return send(res, 200, { version: version(), nodeVersion: process.version, shell: 'electron', port: p });
      return refuse(res, 404, 'not_found', 'No such route.');
    }
    if (path === '/') {
      if (!s) return send(res, 401, 'Not signed in. Open Desk.app.\n', 'text/plain; charset=utf-8');
      if (!reading) return refuse(res, 405, 'method', 'Not allowed.');
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>desk-ui</title><p>desk-ui ${version()}: no app build is installed.</p>\n`, 'text/html; charset=utf-8');
    }
    return refuse(res, 404, 'not_found', 'No such route.');
  }

  // One line per request: method, path and status only, never a header, a query or a body.
  const server = createServer((req, res) => {
    res.on('finish', () => log(`${new Date().toISOString()} ${req.method} ${String(req.url ?? '').split('?')[0].slice(0, 200)} ${res.statusCode}`));
    handle(req, res).catch(() => { if (!res.headersSent) refuse(res, 500, 'internal', 'Something went wrong.'); else res.destroy(); });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  return server;
}

// ---- the port --------------------------------------------------------------------------------

// The server binds 127.0.0.1 only, so that is the address a clash is probed on.
const portTaken = (p = port()) => E.probePort(p, HOST, 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const takenMessage = (p) => `desk-ui: port ${p} on ${HOST} is in use by another process, so the server was not started. It never moves to another port: free port ${p}, then run install.sh again.`;
// A configured repo whose dev-server and worker ports reach this one.
const claimOn = (p) => { try { return E.portClashes({ port: p, last: p }, E.repoPortClaims())[0] ?? null; } catch { return null; } };
const claimMessage = (p, c) => `desk-ui: port ${p} is inside ${c.slug}'s dev-server ports (${c.port}-${c.last}), so the server was not started. It never moves to another port: move that repo's §3b Preferred dev-server port with /desk-setup, then run install.sh again.`;

async function serve() {
  const host = process.env.DESK_UI_HOST ?? HOST;
  if (host !== HOST) { console.error(`desk-ui: refusing to bind ${host}: the server binds ${HOST} only.`); process.exit(2); }
  const p = port();
  if (await portTaken(p)) { console.error(`desk-ui: port ${p} on ${HOST} is in use by another process; not serving.`); process.exit(3); }
  // Checked on every start, not only at install: a repo's ports can move onto 4823 after it.
  const claim = claimOn(p);
  if (claim) { console.error(claimMessage(p, claim)); process.exit(3); }
  const server = makeServer({ p });
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `desk-ui: port ${p} on ${HOST} is in use by another process; not serving.` : `desk-ui: ${e.message}`); process.exit(3); });
  server.listen(p, HOST, () => console.log(`${new Date().toISOString()} desk-ui ${version()} listening on http://${HOST}:${p}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// ---- launchd ---------------------------------------------------------------------------------

const loaded = () => launchctl('print', `${domain()}/${LABEL}`).status === 0;

// The token file: 32 random bytes, readable only by this user. An existing one is kept.
function ensureToken() {
  const f = tokenFile();
  mkdirSync(dirname(f), { recursive: true });
  if (!existsSync(f)) { writeFileSync(f, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' }); return 'written'; }
  if ((statSync(f).mode & 0o777) !== 0o600) chmodSync(f, 0o600);
  return 'kept';
}

async function install() {
  if (platform() !== 'darwin') { console.log('desk-ui: skipped: the server runs under macOS launchd only'); return 0; }
  const made = ensureToken();
  const p = port();
  // Ours is stopped first, so whatever still answers on the port is another process.
  if (loaded()) launchctl('bootout', `${domain()}/${LABEL}`);
  let taken = await portTaken(p);
  for (let i = 0; taken && i < 10; i++) { await sleep(300); taken = await portTaken(p); }
  if (taken) { console.error(takenMessage(p)); return 3; }
  const claim = claimOn(p);
  if (claim) { console.error(claimMessage(p, claim)); return 3; }
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const k of ['DESK_HOME', 'DESK_CONFIG_ROOT']) if (process.env[k]) env[k] = process.env[k];
  // Loaded from a release folder, the job runs through ~/.claude/desk/bin, so a restart loads the current release.
  const dir = E.runBin() === HERE ? E.binDir() : HERE;
  mkdirSync(logDir(), { recursive: true });
  const job = {
    Label: LABEL,
    ProgramArguments: [process.execPath, join(dir, 'desk-ui.mjs'), 'serve'],
    EnvironmentVariables: env,
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 5,
    StandardOutPath: join(logDir(), 'server.log'),
    StandardErrorPath: join(logDir(), 'server.log'),
  };
  mkdirSync(AGENTS, { recursive: true });
  writeFileSync(plistFile(), plist(job));
  const r = launchctl('bootstrap', domain(), plistFile());
  if (r.status !== 0) { console.error(`desk-ui: launchctl bootstrap ${domain()} ${plistFile()} failed: ${(r.stderr || r.stdout || '').trim()}`); return 1; }
  for (let i = 0; i < 50; i++) {
    if (await portTaken(p)) { console.log(`desk-ui: ${LABEL} loaded and answering on http://${HOST}:${p} (token ${made}: ${tokenFile().replace(E.HOME, '~')})`); return 0; }
    await sleep(200);
  }
  console.error(`desk-ui: ${LABEL} is loaded but nothing answers on ${HOST}:${p} yet; see ${join(logDir(), 'server.log')}`);
  return 1;
}

function uninstall() {
  const was = loaded();
  if (was) {
    const r = launchctl('bootout', `${domain()}/${LABEL}`);
    if (r.status !== 0) { console.error(`desk-ui: launchctl bootout ${domain()}/${LABEL} failed: ${(r.stderr || r.stdout || '').trim()}`); return 1; }
  }
  const had = existsSync(plistFile());
  rmSync(plistFile(), { force: true });
  console.log(was || had ? `desk-ui: removed ${LABEL}; the server no longer runs` : `desk-ui: ${LABEL} was not installed`);
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'serve') await serve();
  else if (cmd === 'install') process.exit(await install());
  else if (cmd === 'uninstall') process.exit(uninstall());
  else { console.error('usage: desk-ui.mjs serve | install | uninstall'); process.exit(2); }
}
