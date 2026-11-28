#!/usr/bin/env node
// desk-ptyd: the pty daemon that hosts Desk's terminals, kept alive by launchd (com.desk-skills.ptyd)
// apart from the desk-ui server, so a terminal outlives a restart of that server. It runs only claude
// with a desk skill, or claude --resume of a session it knows; anything else is refused and nothing runs.
//   node desk-ptyd.mjs serve                 run the daemon (what launchd runs). Exits 4 when node-pty
//                                            is not installed, 3 when another daemon answers the socket
//   node desk-ptyd.mjs install --src <desk/ptyd>   install node-pty into ~/.claude/desk/ptyd (npm ci on
//                                            the committed lockfile) when it changed, then load the launchd
//                                            job; a job already running with the same plist keeps running,
//                                            and with it every terminal. A build that fails keeps the
//                                            previous one, names its log and exits 1; with none, terminals
//                                            stay unavailable and the job is not loaded
//   node desk-ptyd.mjs uninstall             unload the launchd job and remove its plist and ~/.claude/desk/ptyd
//
// The socket, ~/.desk-autopilot/ui/ptyd/ptyd.sock, is chmod 600 in a chmod 700 folder: only this user
// can connect. Each line either way is one JSON object. A request is { re, op, ... } and its answer
// { re, ok: true, ... } or { re, ok: false, error: { code, message } }:
//   ping                                     { version }
//   open { argv, cwd, env?, cols?, rows? }   { id, sessionId, pid }: argv is ['claude', '/desk-<skill> <args>']
//                                            or ['claude', '--resume', <session id>]; cwd a configured
//                                            repo's checkout or one of its worktrees; env only
//                                            CLAUDE_CONFIG_DIR, DESK_REPO_DIR and DESK_REPO_ROOT
//   list                                     { items: [{ id, sessionId, argv, cwd, pid, state, code, startedAt }] }
//   attach { id }                            { scrollback (base64: the last 256 KB of output), state, code },
//                                            then { ev: 'data', id, data } and { ev: 'exit', id, code, signal }
//   detach { id }  write { id, data }  resize { id, cols, rows }  kill { id }
// A connection closing detaches it and nothing else: its terminals keep running.
import { createServer, connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { AGENTS, runningVersion } from './installed.mjs';
import { launchctl, launchdDomain as domain, platform, plist } from './run-by.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LABEL = 'com.desk-skills.ptyd';
export const RING = 256 * 1024;
const MAX_LIVE = 8;
const KEEP_EXITED = 16;
const MAX_LINE = 1 << 20;
const MAX_WRITE = 64 * 1024;
const KILL_GRACE_MS = 5000;
const SKILL_PROMPT = /^\/(desk-[a-z][a-z0-9-]{0,40})((?: [A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,4})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERM_ID = /^[a-f0-9]{16}$/;
const ENV_KEYS = new Set(['CLAUDE_CONFIG_DIR', 'DESK_REPO_DIR', 'DESK_REPO_ROOT']);

const testHome = () => !!process.env.HOME && process.env.HOME !== userInfo().homedir;
const uiDir = () => join(E.HOME, '.desk-autopilot', 'ui');
export const socketDir = () => join(uiDir(), 'ptyd');
// DESK_PTYD_TEST_SOCKET moves the socket, read only under a test HOME (a scratch path can pass the
// 104 bytes a socket path may hold).
export const socketPath = () => (testHome() && process.env.DESK_PTYD_TEST_SOCKET) || join(socketDir(), 'ptyd.sock');
export const ptydDir = () => join(E.deskHome(), 'ptyd');
const sessionsFile = () => join(dirname(socketPath()), 'sessions.json');
const plistFile = () => join(AGENTS, `${LABEL}.plist`);
const logFile = () => join(uiDir(), 'ptyd.log');
export const buildLog = () => join(uiDir(), 'ptyd-build.log');
const tilde = (p) => p.replace(E.HOME, '~');
const version = () => { try { return runningVersion() ?? 'unknown'; } catch { return 'unknown'; } };

// ---- what may run ----------------------------------------------------------------------------

const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// The session ids a resume may name: the terminals this daemon opened and desk-ui's conversations.
export function knownSessions() {
  const ids = new Set();
  for (const f of [sessionsFile(), join(uiDir(), 'sessions.json')]) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      for (const e of Array.isArray(j?.items) ? j.items : []) if (typeof e?.sessionId === 'string' && UUID.test(e.sessionId)) ids.add(e.sessionId);
    } catch { /* none yet */ }
  }
  return ids;
}
// The folders a terminal may run in: each configured repo's checkout, or a folder in its worktrees one.
function allowedCwd(dir) {
  const r = real(dir);
  if (!r || !isDir(r)) return null;
  for (const { slug } of E.configuredRepos()) {
    const d = E.repoDirs(slug);
    const root = d.root && real(d.root), trees = d.worktrees && real(d.worktrees);
    if (root && r === root) return r;
    if (trees && r.startsWith(`${trees}${sep}`)) return r;
  }
  return null;
}
const skillInstalled = (name) => [join(E.HOME, '.claude', 'skills', name, 'SKILL.md'), join(E.HOME, '.agents', 'skills', name, 'SKILL.md')].some((f) => existsSync(f));

// An open request checked: -> { args, sessionId, cwd, env } or { refuse: [code, message] }. args are
// claude's own, all built here; the request's argv only chooses between the two shapes.
export function checkOpen(req, known = knownSessions()) {
  const no = (code, message) => ({ refuse: [code, message] });
  const { argv, cwd, env = {} } = req ?? {};
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string') || argv[0] !== 'claude') return no('argv', 'Only claude runs here.');
  let args, sessionId;
  if (argv.length === 2) {
    const m = SKILL_PROMPT.exec(argv[1]);
    if (!m) return no('argv', 'claude runs here only with a desk skill and its plain arguments, or --resume of a known session.');
    if (!skillInstalled(m[1])) return no('skill', `${m[1]} is not an installed desk skill.`);
    sessionId = randomUUID();
    args = ['--session-id', sessionId, argv[1]];
  } else if (argv.length === 3 && argv[1] === '--resume') {
    if (!UUID.test(argv[2]) || !known.has(argv[2])) return no('session', 'That is not a session desk knows.');
    sessionId = argv[2];
    args = ['--resume', sessionId];
  } else return no('argv', 'claude runs here only with a desk skill and its plain arguments, or --resume of a known session.');
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return no('cwd', 'cwd is an absolute path.');
  const at = allowedCwd(cwd);
  if (!at) return no('cwd', 'cwd is not a configured repo\'s checkout or one of its worktrees.');
  if (!env || typeof env !== 'object' || Array.isArray(env)) return no('env', 'env is an object.');
  const extra = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEYS.has(k)) return no('env', `${k} is not set through the daemon.`);
    if (typeof v !== 'string' || !isAbsolute(v) || !isDir(v)) return no('env', `${k} is an existing folder.`);
    extra[k] = v;
  }
  return { args, sessionId, cwd: at, env: extra };
}

// The environment a terminal runs with: the daemon's own, without an API key or another login's
// folder, so it is billed to the login the request names, or the default one.
export function terminalEnv(extra, env = process.env) {
  const { ANTHROPIC_API_KEY: _a, OPENAI_API_KEY: _o, CLAUDE_CONFIG_DIR: _c, CODEX_HOME: _h, ...rest } = E.otherRepoEnv(env);
  return { ...rest, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extra };
}
// claude as the daemon's PATH finds it, never a path a request names.
function which(name, path = process.env.PATH ?? '') {
  for (const d of path.split(delimiter).filter(Boolean)) {
    const f = join(d, name);
    try { if (statSync(f).isFile()) return f; } catch { /* not here */ }
  }
  return null;
}
const size = (n, lo, hi, d) => (Number.isInteger(n) && n >= lo && n <= hi ? n : d);

// ---- the daemon ------------------------------------------------------------------------------

// node-pty from ~/.claude/desk/ptyd, or null when install.sh could not install it.
export function loadPty(dir = ptydDir()) {
  try { return createRequire(join(dir, 'package.json'))('node-pty'); } catch { return null; }
}

// `pty` is node-pty (or a stand-in with its spawn); `socket` the path listened on.
export function makeDaemon({ pty, socket = socketPath(), log = (l) => console.error(l), claude = () => which('claude') } = {}) {
  const terms = new Map(); // id -> terminal
  let own = [];
  try { const j = JSON.parse(readFileSync(sessionsFile(), 'utf8')); own = Array.isArray(j?.items) ? j.items.filter((e) => UUID.test(e?.sessionId)) : []; } catch { /* none yet */ }
  function remember(e) {
    own = [...own.filter((x) => x.sessionId !== e.sessionId), { sessionId: e.sessionId, cwd: e.cwd, at: new Date().toISOString() }].slice(-200);
    try {
      const tmp = `${sessionsFile()}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify({ v: 1, items: own })}\n`, { mode: 0o600 });
      renameSync(tmp, sessionsFile());
    } catch (err) { log(`desk-ptyd: sessions: ${err.message}`); }
  }
  const shown = (t) => ({ id: t.id, sessionId: t.sessionId, argv: ['claude', ...t.args], cwd: t.cwd, pid: t.pid, state: t.state,
    code: t.code, startedAt: new Date(t.startedAt).toISOString() });

  function push(t, chunk) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    t.ring.push(b);
    t.bytes += b.length;
    while (t.bytes > RING) {
      const over = t.bytes - RING;
      if (t.ring[0].length <= over) t.bytes -= t.ring.shift().length;
      else { t.ring[0] = t.ring[0].subarray(over); t.bytes -= over; }
    }
    const ev = { ev: 'data', id: t.id, data: b.toString('base64') };
    for (const c of t.subs) c.say(ev);
  }
  function prune() {
    const ended = [...terms.values()].filter((t) => t.state === 'exited').sort((a, b) => b.startedAt - a.startedAt);
    for (const t of ended.slice(KEEP_EXITED)) terms.delete(t.id);
  }

  function open(req) {
    if ([...terms.values()].filter((t) => t.state === 'running').length >= MAX_LIVE) return { ok: false, error: { code: 'limit', message: `${MAX_LIVE} terminals are running, the most Desk runs at once.` } };
    const c = checkOpen(req);
    if (c.refuse) return { ok: false, error: { code: c.refuse[0], message: c.refuse[1] } };
    const bin = claude();
    if (!bin) return { ok: false, error: { code: 'claude', message: 'claude is not on the daemon\'s PATH.' } };
    let p;
    try {
      p = pty.spawn(bin, c.args, { name: 'xterm-256color', cols: size(req.cols, 10, 500, 120), rows: size(req.rows, 5, 300, 32), cwd: c.cwd, env: terminalEnv(c.env) });
    } catch (err) { log(`desk-ptyd: spawn: ${err.message}`); return { ok: false, error: { code: 'spawn', message: 'claude did not start; see the daemon log.' } }; }
    const t = { id: randomBytes(8).toString('hex'), sessionId: c.sessionId, args: c.args, cwd: c.cwd, pid: p.pid, p, state: 'running',
      code: null, signal: null, startedAt: Date.now(), ring: [], bytes: 0, subs: new Set() };
    terms.set(t.id, t);
    remember(t);
    p.onData((d) => push(t, d));
    p.onExit(({ exitCode, signal }) => {
      t.state = 'exited'; t.code = exitCode ?? null; t.signal = signal || null;
      for (const s of t.subs) s.say({ ev: 'exit', id: t.id, code: t.code, signal: t.signal });
      prune();
    });
    log(`${new Date().toISOString()} open ${t.id} pid ${t.pid}: claude ${c.args.join(' ')} in ${c.cwd}`);
    return { ok: true, id: t.id, sessionId: t.sessionId, pid: t.pid };
  }

  function answer(conn, m) {
    const t = typeof m.id === 'string' && TERM_ID.test(m.id) ? terms.get(m.id) : undefined;
    const none = { ok: false, error: { code: 'not_found', message: 'No such terminal.' } };
    switch (m.op) {
      case 'ping': return { ok: true, version: version() };
      case 'open': return open(m);
      case 'list': return { ok: true, items: [...terms.values()].map(shown) };
      case 'attach':
        if (!t) return none;
        t.subs.add(conn); conn.terms.add(t);
        return { ok: true, scrollback: Buffer.concat(t.ring).toString('base64'), state: t.state, code: t.code };
      case 'detach':
        if (!t) return none;
        t.subs.delete(conn); conn.terms.delete(t);
        return { ok: true };
      case 'write': {
        if (!t) return none;
        if (t.state !== 'running') return { ok: false, error: { code: 'exited', message: 'That terminal has exited.' } };
        const b = typeof m.data === 'string' ? Buffer.from(m.data, 'base64') : null;
        if (!b || b.length > MAX_WRITE) return { ok: false, error: { code: 'data', message: `data is base64 of at most ${MAX_WRITE} bytes.` } };
        t.p.write(b.toString('utf8'));
        return { ok: true };
      }
      case 'resize':
        if (!t) return none;
        if (t.state === 'running') t.p.resize(size(m.cols, 10, 500, 120), size(m.rows, 5, 300, 32));
        return { ok: true };
      case 'kill':
        if (!t) return none;
        if (t.state === 'running') {
          try { t.p.kill('SIGHUP'); } catch { /* gone */ }
          setTimeout(() => { if (t.state === 'running') try { t.p.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS).unref();
        } else terms.delete(t.id);
        return { ok: true };
      default: return { ok: false, error: { code: 'op', message: 'No such request.' } };
    }
  }

  const server = createServer((sock) => {
    const conn = { terms: new Set(), say: (o) => { if (!sock.destroyed) sock.write(`${JSON.stringify(o)}\n`); } };
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_LINE && buf.indexOf('\n') < 0) { sock.destroy(); return; }
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { conn.say({ ok: false, error: { code: 'json', message: 'One JSON object a line.' } }); continue; }
        if (!m || typeof m !== 'object') continue;
        let out;
        try { out = answer(conn, m); } catch (err) { log(`desk-ptyd: ${err.message}`); out = { ok: false, error: { code: 'internal', message: 'Something went wrong.' } }; }
        conn.say({ re: m.re ?? null, ...out });
      }
    });
    const gone = () => { for (const t of conn.terms) t.subs.delete(conn); conn.terms.clear(); };
    sock.on('close', gone);
    sock.on('error', gone);
  });

  // Only this user may reach the socket: its folder is 700 and the socket is 600 from its first moment.
  function listen() {
    return new Promise((resolve, reject) => {
      const dir = dirname(socket);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.uid !== process.getuid()) { reject(new Error(`${dir} is not a folder of this user's`)); return; }
      chmodSync(dir, 0o700);
      try { if (lstatSync(socket).isSocket()) unlinkSync(socket); } catch { /* none */ }
      const mask = process.umask(0o177);
      server.once('error', (e) => { process.umask(mask); reject(e); });
      server.listen(socket, () => { process.umask(mask); chmodSync(socket, 0o600); resolve(); });
    });
  }
  function stop() {
    for (const t of terms.values()) if (t.state === 'running') try { t.p.kill('SIGHUP'); } catch { /* gone */ }
    return new Promise((r) => server.close(() => r()));
  }
  return { listen, stop, server, terms };
}

// Whether a daemon answers on `socket`.
export const answers = (socket = socketPath()) => new Promise((resolve) => {
  const c = connect(socket);
  const done = (v) => { c.destroy(); resolve(v); };
  c.setTimeout(1000, () => done(false));
  c.once('connect', () => done(true));
  c.once('error', () => done(false));
});

async function serve() {
  const pty = loadPty();
  if (!pty) { console.error(`desk-ptyd: node-pty is not installed in ${tilde(ptydDir())}, so terminals are unavailable: run install.sh again.`); process.exit(4); }
  if (await answers()) { console.error(`desk-ptyd: another daemon answers on ${tilde(socketPath())}; not serving.`); process.exit(3); }
  const d = makeDaemon({ pty, log: (l) => console.log(l) });
  await d.listen();
  console.log(`${new Date().toISOString()} desk-ptyd ${version()} listening on ${tilde(socketPath())}`);
  const stop = () => { d.stop().then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// ---- install ---------------------------------------------------------------------------------

// What a build is made from: the package files, which pin node-pty, and the node it is built for.
export function sourceHash(src) {
  const h = createHash('sha256').update(`${process.version}\0${process.arch}\0`);
  for (const f of ['package.json', 'package-lock.json']) h.update(`${f}\0`).update(readFileSync(join(src, f))).update('\0');
  return h.digest('hex');
}
const readStamp = () => { try { return readFileSync(join(ptydDir(), 'source-hash'), 'utf8').trim(); } catch { return null; } };
function step(log, cmd, args, cwd) {
  appendFileSync(log, `\n$ ${cmd} ${args.join(' ')}\n`);
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  appendFileSync(log, `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `${r.error.message}\n` : ''}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ''} failed`);
}
// node-pty installed into a fresh folder, loaded once to prove its native module works for this node,
// then swapped in: until the swap the previous one stays.
function build(src, hash) {
  const log = buildLog();
  const work = `${ptydDir()}.build`, old = `${ptydDir()}.old`;
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, `${new Date().toISOString()} installing node-pty from ${src}\n`);
  try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) cpSync(join(src, f), join(work, f));
    step(log, 'npm', ['ci', '--no-audit', '--no-fund'], work);
    step(log, process.execPath, ['-e', `require(${JSON.stringify(join(work, 'node_modules', 'node-pty'))}).spawn`], work);
    writeFileSync(join(work, 'source-hash'), `${hash}\n`);
    rmSync(old, { recursive: true, force: true });
    if (existsSync(ptydDir())) renameSync(ptydDir(), old);
    renameSync(work, ptydDir());
    rmSync(old, { recursive: true, force: true });
    return null;
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    return e.message;
  }
}

const loaded = () => launchctl('print', `${domain()}/${LABEL}`).status === 0;
function job() {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const k of ['DESK_HOME', 'DESK_CONFIG_ROOT']) if (process.env[k]) env[k] = process.env[k];
  // Loaded from a release folder, the job runs through ~/.claude/desk/bin, so its next start loads the current release.
  const dir = E.runBin() === HERE ? E.binDir() : HERE;
  return plist({ Label: LABEL, ProgramArguments: [process.execPath, join(dir, 'desk-ptyd.mjs'), 'serve'], EnvironmentVariables: env,
    RunAtLoad: true, KeepAlive: true, ThrottleInterval: 5, StandardOutPath: logFile(), StandardErrorPath: logFile() });
}

export function install(src) {
  if (platform() !== 'darwin') { console.log('desk-ptyd: skipped: Desk\'s terminals run under macOS launchd only'); return 0; }
  if (!src || !existsSync(join(src, 'package-lock.json'))) { console.error(`desk-ptyd: no ptyd source at ${src ?? '(none given)'}`); return 2; }
  const hash = sourceHash(src);
  let failed = null;
  if (!loadPty() || readStamp() !== hash) failed = build(src, hash);
  if (failed && !loadPty()) {
    console.error(`desk-ptyd: node-pty did not install (${failed}), so Desk's terminals are unavailable; the rest of Desk works. Build log: ${tilde(buildLog())}`);
    return 1;
  }
  mkdirSync(uiDir(), { recursive: true });
  const text = job();
  const same = existsSync(plistFile()) && readFileSync(plistFile(), 'utf8') === text;
  let said;
  if (same && loaded()) said = `${LABEL} already running; its terminals keep running`;
  else {
    if (loaded()) launchctl('bootout', `${domain()}/${LABEL}`);
    mkdirSync(AGENTS, { recursive: true });
    writeFileSync(plistFile(), text);
    const r = launchctl('bootstrap', domain(), plistFile());
    if (r.status !== 0) { console.error(`desk-ptyd: launchctl bootstrap ${domain()} ${plistFile()} failed: ${(r.stderr || r.stdout || '').trim()}`); return 1; }
    said = `${LABEL} loaded (${tilde(socketPath())})`;
  }
  if (failed) { console.error(`desk-ptyd: node-pty did not reinstall (${failed}); the previous install is still in use. Build log: ${tilde(buildLog())}`); return 1; }
  console.log(`desk-ptyd: ${said}`);
  return 0;
}

export function uninstall() {
  const was = loaded();
  if (was) {
    const r = launchctl('bootout', `${domain()}/${LABEL}`);
    if (r.status !== 0) { console.error(`desk-ptyd: launchctl bootout ${domain()}/${LABEL} failed: ${(r.stderr || r.stdout || '').trim()}`); return 1; }
  }
  const had = existsSync(plistFile());
  rmSync(plistFile(), { force: true });
  rmSync(ptydDir(), { recursive: true, force: true });
  console.log(was || had ? `desk-ptyd: removed ${LABEL}; Desk's terminals no longer run` : `desk-ptyd: ${LABEL} was not installed`);
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const [cmd, flag, src] = process.argv.slice(2);
  if (cmd === 'serve' && flag === undefined) await serve();
  else if (cmd === 'install' && flag === '--src' && src) process.exit(install(src));
  else if (cmd === 'uninstall' && flag === undefined) process.exit(uninstall());
  else { console.error('usage: desk-ptyd.mjs serve | install --src <desk/ptyd> | uninstall'); process.exit(2); }
}
