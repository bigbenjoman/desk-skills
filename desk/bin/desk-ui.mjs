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
// GET /api/events is the change stream (desk-ui-events.mjs), under the same guard, and refused as a
// POST is unless it carries the app's Origin (Desk.app adds it to its window's stream request);
// /api/snapshot reads the same model and revision. A WebSocket upgrade is refused: 403 from any Origin but the app's, 404
// from it, since no route takes one yet.
// GET /api/model is desk-q's: the listing the model was read from (desk-q-model.mjs modelWire), signed
// with `Authorization: Bearer <the token file's token>` and no Origin or session cookie (desk-q-server.mjs).
// Every other GET, from a signed-in window, is a file of the app build install.sh made
// (~/.claude/desk/ui/dist, desk-app.mjs install-ui); / is its index.html.
// DESK_UI_TEST_PORT moves the port, read only when HOME is not this user's own home (a test HOME).
//
// Usage probes: serve runs the usage probe loop (desk-ui-probes.mjs) for as long as it runs, whether or
// not a window is open, writing its heartbeat to ~/.desk-autopilot/ui/scheduler.json. A desk-q screen
// open beside it sees the heartbeat fresh and leaves the probes to the server; stopped, desk-q probes as
// it always has. Each probe's end rebuilds the change stream's model, whose home event carries the
// Usage & costs screen's figures (desk-q-model subscriptionsJson).
//
// Writes: every POST below runs one of desk's own commands, from WRITES, through execFile with no
// shell and an argv built here; the server never writes desk's files itself. Writes for one repo run
// one at a time, in the order they arrived; another repo's do not wait. Each command's exit maps to
// the status (0 200, 10 202, 11 409, anything else 500), and the body is { exit, stdout, stderr }.
// Every command run is appended to ~/.desk-autopilot/ui/audit.jsonl with its free text redacted.
//   POST /api/repos/<slug>/tickets/<KEY>/record {action, text?}   needs-you.mjs record <repo> <KEY> <action> [text]
//   POST /api/repos/<slug>/tickets/<KEY>/answer {text, approve?}  answer.mjs <KEY> [--approve] <text>
// <slug> is the snapshot's repos[].slug; <repo> is that repo's name, as needs-you names it.
// DESK_UI_TEST_BIN names the folder those commands run from, read only under a test HOME.
//
// The Inbox: GET /api/inbox is needs-you.mjs list --json --no-settle, which writes nothing, with
// `settled_at` (the last settling list's time), `github` (what the last check of GitHub found:
// { ok } or { ok: false, reason: 'down' | 'signin', detail }) and `next_pass_at` / `next_checkin_at`.
// ?settle=1 first checks GitHub, then, while it answers, runs the settling list: at most once a
// minute, and a request while one runs gets that one's answer.
//
// First run: GET /api/setup is { installed, checkout, repos, found }: whether desk's commands are
// installed, the checkout install.sh last ran from (~-relative), how many repos are configured, and,
// while installed with none configured, the git repos directly under ~/studia ([{ name, path }]).
//   POST /api/terminal {folder}   opens Terminal running /desk-setup in ~/studia/<folder>, through
//                                 osascript with the folder as its one argument. Only a folder setup
//                                 lists as found, and no other field: anything else is 400 and runs nothing.
//
// Conversations (desk-ui-sessions.mjs): a Claude conversation about a repo or one of its tickets, on the
// repo's subscription, seeded with quoted text as data, never counted as a queue worker.
//   POST /api/sessions {purpose, repo, ticket?, mode?, login?}   starts one: purpose park, ticket or blank,
//        repo a slug, mode chat, login another subscription's email for this conversation only, taken
//        only while the repo's own is at its limit (409 otherwise). Any other field (a prompt, flags, a
//        command) is 400 and starts nothing. 429 when the repo's subscription is at its usage limit and
//        no login is named, or at the broker's own limits.
//   GET /api/sessions                      { items }: every conversation, open and ended
//   POST /api/sessions/<id>/messages {text}  the person's next message; resumes one a restart ended
//   DELETE /api/sessions/<id>               ends it; its transcript is kept
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { makeFeed } from './desk-ui-events.mjs';
import { serverScheduler } from './desk-ui-probes.mjs';
import { ID as SESSION_ID, makeBroker, seedPrompt, shownArgs } from './desk-ui-sessions.mjs';
import { AGENTS, readInstalled, runningVersion } from './installed.mjs';
import { loginEnv, readSubscriptions, repoSubscription, tilde } from './logins.mjs';
import { loginOf } from './claude-logins.mjs';
import { limitName, resetText } from './usage-limit.mjs';
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
export const readToken = () => { try { return readFileSync(tokenFile(), 'utf8').trim() || null; } catch { return null; } };
// The token a terminal reader (desk-q) sends as `Authorization: Bearer <token>`, or null for none.
const MAX_BEARER = 256;
const bearerOf = (req) => { const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? '')); return m && m[1].length <= MAX_BEARER ? m[1] : null; };

// ---- writes ----------------------------------------------------------------------------------

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const VERB = /^[a-z][a-z-]*$/;
// Taken with an argument of their own that this route does not send: their own routes add them.
const NOT_HERE = new Set(['override', 'move']);
// answer.mjs reads a leading argument equal to one of these as its flag, so such text is refused.
const ANSWER_FLAGS = new Set(['--approve', '--all', '--taken']);
const MAX_TEXT = 2000;
// Room for any text MAX_TEXT allows: one UTF-16 unit is at most 6 bytes of JSON (a \u escape).
const MAX_WRITE_BODY = 6 * MAX_TEXT + 1024;
const WRITE_TIMEOUT_MS = 5 * 60 * 1000;
const READ_TIMEOUT_MS = 60 * 1000;
const WRITES = { record: 'needs-you.mjs', answer: 'answer.mjs' };
const STATUS = { 0: 200, 10: 202, 11: 409 };
const binDir = () => (testHome() && process.env.DESK_UI_TEST_BIN) || HERE;
const auditFile = () => join(logDir(), 'audit.jsonl');

// A desk command at `file`, through no shell: { exit, stdout, stderr }, exit null when it did not exit with a code.
function run(file, args, { cwd, env }, timeout = WRITE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args],
      { cwd, env, shell: false, timeout, maxBuffer: 1 << 20, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ exit: err ? (Number.isInteger(err.code) ? err.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });
}

function audit(route, argv, exit, more = {}) {
  try {
    mkdirSync(logDir(), { recursive: true });
    appendFileSync(auditFile(), `${JSON.stringify({ at: new Date().toISOString(), route, argv, exit, ...more })}\n`, { mode: 0o600 });
  } catch (e) { console.error(`desk-ui: audit: ${e.message}`); }
}

// ---- the Inbox -------------------------------------------------------------------------------

const SETTLE_EVERY_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 20 * 1000;
// What a failed gh call says about GitHub: its sign-in gone, or GitHub not answering.
export function githubState(stderr) {
  const text = String(stderr ?? '');
  if (/HTTP 401|Bad credentials|gh auth login|not logged in|token .*invalid/i.test(text)) return { ok: false, reason: 'signin', detail: null };
  const http = /HTTP (\d{3})/.exec(text);
  const line = text.trim().split('\n')[0].slice(0, 120);
  return { ok: false, reason: 'down', detail: http ? `gh: HTTP ${http[1]}` : `gh: ${line || 'no answer'}` };
}
// The earliest next check-in across the repos, each at its own §3b Check-in times (the default where unset
// or unread), as ms, or null.
async function nextCheckinOf(slugs, now) {
  const { repoCheckinTimes, DEFAULT_TIMES } = await import('./digest.mjs');
  const { nextCheckin } = await import('./ask-defaults.mjs');
  const ats = [...new Set(slugs)].map((s) => nextCheckin(repoCheckinTimes(s), new Date(now))).filter(Boolean).map(Number);
  if (!slugs.length) ats.push(Number(nextCheckin(DEFAULT_TIMES, new Date(now))));
  return ats.length ? Math.min(...ats) : null;
}
// One cheap GitHub read (rate_limit counts against no limit): { ok: true }, or githubState's answer.
const probeGitHub = () => new Promise((resolve) => {
  execFile('gh', ['api', 'rate_limit', '--silent'], { shell: false, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' },
    (err, _out, stderr) => resolve(err ? githubState(stderr || err.message) : { ok: true }));
});

// ---- the app build ---------------------------------------------------------------------------

const appDir = () => join(E.deskHome(), 'ui', 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8' };
// A file of the installed build for a request path (/ is its index.html), or null: only a file of a
// known type inside the build, never a dot name, a directory or a link that leads out of it.
function appFile(path) {
  let rel;
  try { rel = decodeURIComponent(path === '/' ? '/index.html' : path).slice(1); } catch { return null; }
  if (!rel || /[\\\0]/.test(rel) || rel.split('/').some((seg) => !seg || seg.startsWith('.'))) return null;
  const type = TYPES[extname(rel).toLowerCase()];
  if (!type) return null;
  try {
    const root = realpathSync(appDir());
    const real = realpathSync(join(root, rel));
    if (!real.startsWith(`${root}${sep}`) || !statSync(real).isFile()) return null;
    return { body: readFileSync(real), type };
  } catch { return null; }
}

// ---- first run -------------------------------------------------------------------------------

// desk's commands as install.sh installs them: the desk-env command on PATH and the scripts it runs.
const deskInstalled = () => existsSync(join(E.HOME, '.local', 'bin', 'desk-env')) && existsSync(join(E.binDir(), 'desk-env.mjs'));
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// The git repos directly under ~/studia: each folder (not a link) holding a .git, by name.
function gitRepos(root = join(E.HOME, 'studia')) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter((d) => d.isDirectory() && FOLDER.test(d.name) && existsSync(join(root, d.name, '.git')))
    .map((d) => ({ name: d.name, path: join(root, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
// The repos the first run offers, and the only folders /api/terminal opens: none once desk is missing
// or any repo is configured.
const firstRun = (installed = deskInstalled(), repos = E.configuredRepos().length) => (installed && !repos ? gitRepos() : []);
function setup() {
  const installed = deskInstalled();
  const from = readInstalled()?.from;
  const repos = E.configuredRepos().length;
  const found = firstRun(installed, repos).map((r) => ({ name: r.name, path: tilde(r.path) }));
  return { installed, checkout: typeof from === 'string' && from ? tilde(from) : null, repos, found };
}

// osascript's arguments for a Terminal window running /desk-setup in `dir`: the folder is the script's
// one argument, quoted for the shell by AppleScript itself, never spliced into the script's text.
export const terminalArgs = (dir) => [
  ...['on run argv', 'tell application "Terminal"', 'activate',
    'do script "cd " & quoted form of (item 1 of argv) & " && claude /desk-setup"', 'end tell', 'end run'].flatMap((l) => ['-e', l]),
  dir];
// -> its exit code, null when it did not exit with one.
const openTerminal = (dir) => new Promise((resolve) => {
  execFile('osascript', terminalArgs(dir), { shell: false, timeout: 30_000 }, (err) => resolve(err ? (Number.isInteger(err.code) ? err.code : null) : 0));
});

// ---- conversations ---------------------------------------------------------------------------

const START_FIELDS = new Set(['purpose', 'repo', 'ticket', 'mode', 'login']);
const FOLDER_FIELDS = new Set(['folder']);
const PURPOSES = new Set(['park', 'ticket', 'blank']);
const EMAIL = /^[^\s@`]{1,128}@[^\s@`]{1,128}\.[^\s@`]{1,63}$/;
const MAX_MESSAGE = 16000;
const MAX_MESSAGE_BODY = 6 * MAX_MESSAGE + 1024;
const sessionsFile = () => join(logDir(), 'sessions.json');
const possessive = (name) => (name.endsWith('s') ? `${name}'` : `${name}'s`);

// The quotes a conversation is seeded with: for a ticket desk parked, its park question as written.
// -> [{ source, text }]
function parkSeed({ ticket, batches }) {
  if (!ticket) return [];
  const t = batches.map((b) => b.q?.tickets?.[ticket]).find((x) => x?.state === 'parked' && typeof x.park?.question === 'string');
  return t ? [{ source: 'desk park', text: t.park.question }] : [];
}

// `events` passes options to the change stream's feed (makeFeed): the tests' clock and intervals.
// `terminal(dir)` opens Terminal for /api/terminal (openTerminal), and `github()` checks GitHub before
// the Inbox settles (probeGitHub); the tests pass stubs.
// `chat` passes the conversations' options: `seed(about)` -> the quotes (parkSeed), `now`, `checkMs`.
export function makeServer({ p = port(), log = (line) => console.log(line), events = {}, terminal = openTerminal, github = probeGitHub, chat = {} } = {}) {
  const origin = `http://${HOST}:${p}`;
  const hosts = new Set([`${HOST}:${p}`, `localhost:${p}`]);
  const sessions = new Map(); // session id -> { load, expires }
  const lanes = new Map(); // repo slug -> the end of its last queued write
  // Names this run of the server on every response, so Desk.app can tell a restart (which signed
  // everyone out) from the same server refusing it again. It grants nothing.
  const boot = randomBytes(8).toString('hex');
  const feed = makeFeed(events);
  const clock = events.now ?? Date.now; // the feed's, which dates each model it reads
  const seed = chat.seed ?? parkSeed;
  // A conversation's child runs in its repo's checkout on its subscription's login folder, with no
  // API key, so it is billed to that subscription.
  const broker = makeBroker({ file: sessionsFile(), now: chat.now, checkMs: chat.checkMs,
    envOf: (e) => ({ ...loginEnv({ tool: 'claude', configDir: e.configDir }, E.otherRepoEnv()), DESK_REPO_DIR: e.cwd, DESK_REPO_ROOT: e.cwd }) });

  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    const text = Buffer.isBuffer(body) ? body : type.startsWith('application/json') ? JSON.stringify(body) : String(body);
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

  // Read afresh, as the machine profile is not watched. The revision moves with desk's state, not with
  // the clock or free memory, and is the change stream's.
  async function snapshot() {
    const m = await feed.current({ fresh: true });
    if (!m) throw new Error('no read model');
    return feed.snapshot(m);
  }

  // desk-q's listing (desk-q-model.mjs modelWire), read again once it is REREAD_MS old. With ?at=
  // naming the one the reader holds, an unchanged listing is only { v, at, same: true }. A reread that
  // fails leaves the feed holding the old one, which is refused, so desk-q reads the files instead.
  async function model(res, query) {
    try {
      const { REREAD_MS } = await import('./desk-q-model.mjs');
      let m = await feed.current();
      if (m && clock() - m.at > REREAD_MS) m = await feed.current({ fresh: true });
      if (!m?.wire) throw new Error('no read model');
      if (clock() - m.at > REREAD_MS) throw new Error('the read model could not be read again');
      return send(res, 200, query.has('at') && Number(query.get('at')) === m.at ? { v: m.wire.v, at: m.at, same: true } : m.wire);
    } catch (e) { console.error(`desk-ui: model: ${e.message}`); return refuse(res, 500, 'read', "Could not read desk's state; see the server log."); }
  }

  function readBody(req, max = MAX_BODY) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  // `job` runs once every earlier write for the same repo has finished, however it ended.
  function inLane(slug, job) {
    const run = (lanes.get(slug) ?? Promise.resolve()).then(job);
    const end = run.then(() => {}, () => {});
    lanes.set(slug, end);
    end.then(() => { if (lanes.get(slug) === end) lanes.delete(slug); });
    return run;
  }

  async function loadAll() {
    const Q = await import('./desk-q-model.mjs');
    E.forgetReads();
    return { Q, all: Q.loadRepos(Date.now()) };
  }

  // What a write runs, from desk's state read in its turn: { args, shown, at } or { refuse }.
  // The item's actions are needs-you's own list (--no-settle writes nothing), run as a child so its
  // GitHub reads stall no other repo's write. The record names the batch whose item offers the action,
  // so needs-you records it there and not against an archived copy elsewhere.
  async function planRecord(repo, key, { action, text }) {
    const at = { env: E.otherRepoEnv() };
    const listed = await run(join(HERE, 'needs-you.mjs'), ['list', '--json', '--no-settle', repo], at, READ_TIMEOUT_MS);
    let items;
    try { items = JSON.parse(listed.stdout).items.filter((i) => i.ticket === key); } catch { items = null; }
    if (listed.exit !== 0 || !items) throw new Error(`needs-you list ${repo} exited ${listed.exit}: ${listed.stderr.trim().slice(0, 300)}`);
    const offered = [...new Set(items.flatMap((i) => i.actions.map((a) => a.action)))];
    const item = items.find((i) => i.actions.some((a) => a.action === action));
    if (!item) return { refuse: [400, 'action', `${repo} ${key} does not offer ${action}${offered.length ? ` (it offers ${offered.join(', ')})` : ': nothing there needs you'}.`] };
    const free = text === undefined ? [] : [text];
    return { args: ['record', item.batch, key, action, ...free], shown: ['record', item.batch, key, action, ...free.map(() => '<redacted>')], at };
  }
  // The batch holding the ticket is batches.mjs's batchHolding, which prefers a live copy to an archived one.
  async function planAnswer(Q, batches, slug, repo, key, { text, approve }) {
    const B = await import('./batches.mjs');
    let held;
    try { held = B.batchHolding(key, slug); } catch (e) { return { refuse: [409, 'ticket', e.message] }; }
    const r = held && batches.find((b) => b.queuePath === held.queue);
    if (!r?.q) return { refuse: [400, 'ticket', `${key} is in no batch of ${repo}.`] };
    const t = r.q.tickets[key];
    // What answer.mjs answers: a parked ticket's question or a triage question still open.
    if (!(t.state === 'parked' || (t.open_questions ?? 0) > 0)) return { refuse: [400, 'answer', `${repo} ${key} has no question to answer.`] };
    if (approve && !(t.state === 'parked' && t.park?.approve)) return { refuse: [400, 'approve', `${repo} ${key} has no write awaiting approval.`] };
    let at;
    try { at = Q.checkoutOf(r, 'answer it'); } catch (e) { return { refuse: [409, 'checkout', e.message] }; }
    const flag = approve ? ['--approve'] : [];
    return { args: [key, ...flag, text], shown: [key, ...flag, '<redacted>'],
      at: { cwd: at.cwd, env: { ...at.env, DESK_AUTOPILOT_STATE: r.stateDir, DESK_QUEUE: r.queuePath } } };
  }

  async function write(req, res, path, kind, slugPart, keyPart) {
    const body = await jsonOnly(req, res, '', null, MAX_WRITE_BODY);
    if (!body) return;
    let slug, key;
    try { slug = decodeURIComponent(slugPart); key = decodeURIComponent(keyPart); }
    catch { return refuse(res, 400, 'body', 'Send the request as JSON.'); }
    if (!KEY.test(key)) return refuse(res, 400, 'ticket', 'That is not a ticket key.');
    const { text } = body;
    if (text !== undefined && (typeof text !== 'string' || text.length > MAX_TEXT)) return refuse(res, 400, 'text', `The text must be a string of at most ${MAX_TEXT} characters.`);
    if (kind === 'record' && (typeof body.action !== 'string' || !VERB.test(body.action) || NOT_HERE.has(body.action))) return refuse(res, 400, 'action', 'That action is not one this route records.');
    if (kind === 'answer') {
      if (typeof text !== 'string' || !text.trim()) return refuse(res, 400, 'text', 'An answer needs its text.');
      if (ANSWER_FLAGS.has(text)) return refuse(res, 400, 'text', 'That text reads as one of answer.mjs\'s flags.');
      if (body.approve !== undefined && typeof body.approve !== 'boolean') return refuse(res, 400, 'approve', 'approve is true or false.');
    }
    let done;
    try {
      const first = await loadAll();
      if (!first.all.some((r) => r.slug === slug)) return refuse(res, 400, 'repo', 'That is not a configured repo.');
      done = await inLane(slug, async () => {
        // Read again in its turn: a write ahead of this one may have changed what the ticket offers.
        const { Q, all } = await loadAll();
        const batches = all.filter((r) => r.slug === slug);
        // needs-you names a repo by its name, the standing batch's.
        const repo = (batches.find((r) => r.batch == null) ?? batches[0]).repo;
        const plan = kind === 'record' ? await planRecord(repo, key, body) : await planAnswer(Q, batches, slug, repo, key, body);
        if (plan.refuse) return plan;
        const ran = await run(join(binDir(), WRITES[kind]), plan.args, plan.at);
        audit(path, [WRITES[kind], ...plan.shown], ran.exit);
        return { ran };
      });
    } catch (e) { console.error(`desk-ui: ${kind}: ${e.message}`); return refuse(res, 500, 'read', "Could not read desk's state; see the server log."); }
    if (done.refuse) return refuse(res, ...done.refuse);
    return send(res, STATUS[done.ran.exit] ?? 500, done.ran);
  }

  // Terminal for one folder setup lists as found, sent as {folder: <its name>} and nothing else.
  async function openFolder(req, res, query) {
    const body = await jsonOnly(req, res, query, FOLDER_FIELDS);
    if (!body) return;
    const repo = typeof body.folder === 'string' && FOLDER.test(body.folder) ? firstRun().find((r) => r.name === body.folder) : null;
    if (!repo) return refuse(res, 400, 'folder', 'That is not one of the git repos under ~/studia.');
    const exit = await terminal(repo.path);
    audit('/api/terminal', ['osascript', '<desk-setup>', tilde(repo.path)], exit);
    if (exit === 0) return send(res, 200, { opened: repo.name });
    console.error(`desk-ui: terminal: osascript exited ${exit} for ${tilde(repo.path)}`);
    return refuse(res, 500, 'terminal', "Terminal didn't open. See the server log.");
  }

  // needs-you's list as data, from a child so its reads stall no other request; `settle` runs the
  // settling list, which records what has shipped.
  async function needsYouList(settle) {
    const listed = await run(join(HERE, 'needs-you.mjs'), ['list', '--json', ...(settle ? [] : ['--no-settle'])], { env: E.otherRepoEnv() }, READ_TIMEOUT_MS);
    if (listed.exit !== 0) throw new Error(`needs-you list exited ${listed.exit}: ${listed.stderr.trim().slice(0, 300)}`);
    return JSON.parse(listed.stdout);
  }
  const inboxState = { settling: null, settledAt: null, lastSettle: -Infinity, github: null };
  // The settling list only once GitHub answers, as its reads of GitHub fail silently.
  function settleInbox() {
    inboxState.settling ??= (async () => {
      const gh = await github();
      inboxState.github = gh;
      if (!gh.ok) return needsYouList(false);
      inboxState.lastSettle = clock();
      const list = await needsYouList(true);
      inboxState.settledAt = list.generated_at;
      return list;
    })().finally(() => { inboxState.settling = null; });
    return inboxState.settling;
  }
  async function inbox(res, query) {
    try {
      const want = query.get('settle') === '1';
      const list = inboxState.settling ? await inboxState.settling
        : want && clock() - inboxState.lastSettle >= SETTLE_EVERY_MS ? await settleInbox() : await needsYouList(false);
      const { all } = await loadAll();
      const now = clock();
      const passes = all.filter((r) => r.live && Number.isFinite(Number(r.next)) && Number(r.next) > now).map((r) => Number(r.next));
      const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
      return send(res, 200, { ...list, settled_at: inboxState.settledAt, github: inboxState.github,
        next_pass_at: iso(passes.length ? Math.min(...passes) : null), next_checkin_at: iso(await nextCheckinOf(all.map((r) => r.slug), now)) });
    } catch (e) { console.error(`desk-ui: inbox: ${e.message}`); return refuse(res, 500, 'read', "Could not read desk's state; see the server log."); }
  }

  // A JSON object body with no query, holding only the fields `allowed` names (any, with `allowed`
  // null): -> the object, or null once refused.
  async function jsonOnly(req, res, query, allowed, max = MAX_BODY) {
    if (query) { refuse(res, 400, 'fields', 'Send the request in the body, with no query.'); return null; }
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { refuse(res, 415, 'content_type', 'JSON only.'); return null; }
    let body;
    try { body = JSON.parse(await readBody(req, max)); } catch { refuse(res, 400, 'body', 'Send the request as JSON.'); return null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { refuse(res, 400, 'body', 'Send the request as a JSON object.'); return null; }
    const extra = allowed ? Object.keys(body).filter((k) => !allowed.has(k)) : [];
    if (extra.length) { refuse(res, 400, 'fields', `This takes only ${[...allowed].join(', ')}: nothing else is read, so nothing was started.`); return null; }
    return body;
  }

  // `login`'s usage limit as the Usage screen reads it (a batch's hold, or a full window), as the reason
  // nothing starts on it, or null.
  const heldReason = (Q, all, login, who) => {
    const h = Q.loginLimit(all, login, clock());
    return h ? `${who} is at ${limitName(h.type)}${h.at != null ? ` until ${resetText(h.at)}` : ''}` : null;
  };

  // POST /api/sessions: what the conversation is about, checked; the subscription it runs on; then the broker.
  async function startConversation(req, res, query) {
    const body = await jsonOnly(req, res, query, START_FIELDS);
    if (!body) return;
    const { purpose, repo: slug, ticket, mode, login: other } = body;
    if (!PURPOSES.has(purpose)) return refuse(res, 400, 'purpose', 'purpose is park, ticket or blank.');
    if (mode !== undefined && mode !== 'chat') return refuse(res, 400, 'mode', 'mode is chat.');
    if (purpose === 'blank' ? ticket !== undefined : (typeof ticket !== 'string' || !KEY.test(ticket))) {
      return refuse(res, 400, 'ticket', purpose === 'blank' ? 'A blank conversation names no ticket.' : 'ticket is a ticket key.');
    }
    if (other !== undefined && (typeof other !== 'string' || !EMAIL.test(other))) return refuse(res, 400, 'login', 'login is the email of one of this computer\'s subscriptions.');
    let Q, all, at, batches;
    try {
      const loaded = await loadAll();
      ({ Q, all } = loaded);
      batches = typeof slug === 'string' ? all.filter((r) => r.slug === slug) : [];
      if (!batches.length) return refuse(res, 400, 'repo', 'That is not a configured repo.');
      try { at = loaded.Q.checkoutOf(batches.find((r) => r.batch == null) ?? batches[0], 'talk about it'); } catch (e) { return refuse(res, 409, 'checkout', e.message); }
    } catch (e) { console.error(`desk-ui: sessions: ${e.message}`); return refuse(res, 500, 'read', "Could not read desk's state; see the server log."); }
    const name = (batches.find((r) => r.batch == null) ?? batches[0]).repo;

    // The repo's own subscription (§3b Subscription), as its workers start on it; with no subscriptions
    // file and the row at default, the login the server itself runs as.
    const subs = readSubscriptions(E.subscriptionsPath());
    const own = loginOf(process.env.CLAUDE_CONFIG_DIR);
    const sub = repoSubscription(subs, { value: E.repoConfigValue(slug, 'subscription'), source: 'row' });
    const mine = !subs.exists && sub.source === 'default' ? own : sub.login;
    // Signed out is fixed by signing in, not by another subscription (screen-spec 8.3), so it refuses
    // whatever the request names. Another subscription only once the repo's own is at its limit.
    if (!mine) return refuse(res, 409, 'subscription', `${possessive(name)} subscription, ${sub.email ?? 'the default'}, is not signed in to any login here, so nothing started. Sign it in, then try again.`);
    const mineHeld = heldReason(Q, all, mine, `${possessive(name)} subscription${sub.email ? `, ${sub.email},` : ''}`);
    let login, email;
    if (other === undefined) {
      if (mineHeld) return refuse(res, 429, 'usage_limit', `${mineHeld}, so nothing started. Name another subscription for this conversation to start it there.`);
      login = mine; email = sub.email ?? null;
    } else {
      const o = repoSubscription(subs, { value: other, source: 'request' });
      if (!o.login) return refuse(res, 400, 'login', `${other} is not one of this computer's subscriptions.`);
      if (!mineHeld) return refuse(res, 409, 'subscription', `${possessive(name)} own subscription has room, so a conversation runs on it: another is named only once it is at its limit. Nothing started.`);
      const held = heldReason(Q, all, o.login, o.email);
      if (held) return refuse(res, 429, 'usage_limit', `${held}, so nothing started.`);
      login = o.login; email = o.email;
    }

    let quotes;
    try { quotes = await seed({ slug, repo: name, ticket, purpose, batches }); } catch (e) { console.error(`desk-ui: sessions: seed: ${e.message}`); quotes = []; }
    const started = await broker.start({ purpose, slug, repo: name, ticket, subscription: email, configDir: login.configDir ?? null, cwd: at.cwd,
      seed: seedPrompt({ repo: name, ticket, purpose }, Array.isArray(quotes) ? quotes : []) });
    if (started.refuse) return refuse(res, ...started.refuse);
    const e = started.entry;
    audit('/api/sessions', ['claude', ...shownArgs(e)], started.error ? null : 'started',
      { purpose, repo: slug, ticket: ticket ?? null, subscription: email, id: e.id });
    if (started.error) { console.error(`desk-ui: sessions: claude did not start: ${started.error.message}`); return refuse(res, 500, 'start', 'Claude did not start. See the server log.'); }
    return send(res, 201, { id: e.id, sessionId: e.sessionId, subscription: email, cwd: tilde(e.cwd), state: e.state });
  }

  async function sessionRoute(req, res, method, id, sub, query) {
    if (!SESSION_ID.test(id) || !broker.find(id)) return refuse(res, 404, 'not_found', 'No such conversation.');
    if (sub === 'messages') {
      if (method !== 'POST') return refuse(res, 405, 'method', 'POST only.');
      const body = await jsonOnly(req, res, query, new Set(['text']), MAX_MESSAGE_BODY);
      if (!body) return;
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_MESSAGE) return refuse(res, 400, 'text', `A message is text of at most ${MAX_MESSAGE} characters.`);
      const [status, out] = await broker.send(id, body.text);
      return send(res, status, out);
    }
    if (sub !== undefined) return refuse(res, 404, 'not_found', 'No such route.');
    if (method !== 'DELETE') return refuse(res, 405, 'method', 'DELETE only.');
    broker.end(id);
    return send(res, 200, { id, state: 'ended' });
  }

  async function handle(req, res) {
    const [path, query = ''] = String(req.url ?? '/').split('?');
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

    // A terminal reader's own credential: the token file's token itself, never with an Origin (a browser
    // sends one) or a session cookie as well, so it signs nobody in and evicts no window's session.
    if (path === '/api/model' && req.headers.authorization !== undefined) {
      if (from !== undefined) return refuse(res, 403, 'origin', 'A bearer token is for a terminal reader, which sends no Origin.');
      if (cookiesOf(req).length) return refuse(res, 400, 'credentials', 'Send a bearer token or a session cookie, not both.');
      if (method !== 'GET') return refuse(res, 405, 'method', 'GET only.');
      const want = readToken(), got = bearerOf(req);
      if (!want || !got || !same(got, want)) return refuse(res, 401, 'unauthorized', 'Not signed in.');
      return model(res, new URLSearchParams(query));
    }

    const s = session(req);
    if (path.startsWith('/api/')) {
      if (!s || !same(String(req.headers[LOAD_HEADER] ?? ''), s.load)) return refuse(res, 401, 'unauthorized', 'Not signed in.');
      const w = path.match(/^\/api\/repos\/([^/]+)\/tickets\/([^/]+)\/(record|answer)$/);
      if (w) return method === 'POST' ? write(req, res, path, w[3], w[1], w[2]) : refuse(res, 405, 'method', 'POST only.');
      if (path === '/api/terminal') return method === 'POST' ? openFolder(req, res, query) : refuse(res, 405, 'method', 'POST only.');
      if (path === '/api/sessions') {
        if (method === 'POST') return startConversation(req, res, query);
        if (method === 'GET') return send(res, 200, { items: broker.list() });
        return refuse(res, 405, 'method', 'GET or POST only.');
      }
      const c = path.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
      if (c) return sessionRoute(req, res, method, c[1], c[2], query);
      if (!reading) return refuse(res, 405, 'method', 'Not allowed.');
      if (path === '/api/setup') {
        try { return send(res, 200, setup()); } catch (e) { console.error(`desk-ui: setup: ${e.message}`); return refuse(res, 500, 'read', "Could not read desk's state; see the server log."); }
      }
      if (path === '/api/inbox') return inbox(res, new URLSearchParams(query));
      if (path === '/api/snapshot') {
        try { return send(res, 200, await snapshot()); } catch (e) { console.error(`desk-ui: snapshot: ${e.message}`); return refuse(res, 500, 'read', "Could not read desk's state; see the server log."); }
      }
      if (path === '/api/events') {
        if (method !== 'GET') return refuse(res, 405, 'method', 'GET only.');
        // As strictly as a POST (the ticket's ruling): the app's Origin, never none or null. A
        // same-origin GET carries none, so Desk.app adds it to its own window's stream request.
        if (from !== origin) return refuse(res, 403, 'origin', `Requests must come from ${origin}.`);
        const opened = await feed.subscribe(req, res, { headers: { ...BASE_HEADERS, 'X-Desk-Boot': boot }, query: new URLSearchParams(query) });
        return opened || refuse(res, 500, 'read', "Could not read desk's state; see the server log.");
      }
      if (path === '/api/meta') return send(res, 200, { version: version(), nodeVersion: process.version, shell: 'electron', port: p });
      return refuse(res, 404, 'not_found', 'No such route.');
    }
    if (!s) return send(res, 401, 'Not signed in. Open Desk.app.\n', 'text/plain; charset=utf-8');
    if (!reading) return refuse(res, 405, 'method', 'Not allowed.');
    // The app build install.sh made, read from disk on every request, so a new build shows on the
    // window's next reload.
    const file = appFile(path);
    if (file) return send(res, 200, file.body, file.type);
    if (path === '/') return send(res, 200, `<!doctype html><meta charset="utf-8"><title>desk-ui</title><p>desk-ui ${version()}: no app build is installed.</p>\n`, 'text/html; charset=utf-8');
    return refuse(res, 404, 'not_found', 'No such route.');
  }

  // One line per request: method, path and status only, never a header, a query or a body.
  const server = createServer((req, res) => {
    res.on('finish', () => log(`${new Date().toISOString()} ${req.method} ${String(req.url ?? '').split('?')[0].slice(0, 200)} ${res.statusCode}`));
    handle(req, res).catch(() => { if (!res.headersSent) refuse(res, 500, 'internal', 'Something went wrong.'); else res.destroy(); });
  });
  // A browser always sends Origin on an upgrade, so one without the app's is refused like a POST.
  server.on('upgrade', (req, socket) => {
    const ok = hosts.has(String(req.headers.host ?? '')) && req.headers.origin === origin;
    const status = ok ? '404 Not Found' : '403 Forbidden';
    log(`${new Date().toISOString()} UPGRADE ${String(req.url ?? '').split('?')[0].slice(0, 200)} ${status.slice(0, 3)}`);
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\nX-Desk-Boot: ${boot}\r\n\r\n`);
  });
  server.on('close', () => { feed.stop(); broker.stop(); });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.feed = feed;
  server.sessions = broker;
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
  // Open change streams never end by themselves, so they are ended (each closes its connection), while
  // a write in flight is let finish, so its command's result is answered and audited.
  // The usage probe loop runs for as long as the server does, a window open or not (desk-ui-probes.mjs).
  const probes = await serverScheduler({ changed: () => server.feed.changed() });
  probes.start();
  const stop = () => { probes.stop(); server.feed.stop(); server.sessions.stop(); server.close(() => process.exit(0)); };
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
