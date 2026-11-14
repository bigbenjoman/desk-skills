// Every Claude login a reader of this computer's Claude state covers: the agent registry, session
// transcripts, sign-in and the usage probe. A login is a config folder (logins.mjs); `claude agents
// --json`, `claude auth status` and a session's transcript each see only the folder CLAUDE_CONFIG_DIR
// points at, so each is read once per login.
//
// The registry covers every login whose folder exists, whatever its rule or sign-in: a worker started
// on a login later turned off, signed out or removed is still running. With one login, each reader makes one
// call, with no CLAUDE_CONFIG_DIR.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginFile, subscriptionsPath } from './desk-env.mjs';
import { CHECK_TIMEOUT_MS, defaultLogin, isDir, login, loginEnv, readSubscriptions, toolLogins } from './logins.mjs';

// A login for a folder no subscriptions row names.
const envLogin = (dir) => login({ tool: 'claude', name: basename(dir), folder: dir, rule: null, source: 'env' });

// The Claude logins the subscriptions file lists, then the folders under ~/.claude-logins it does not
// (on standby with a file, no rule without one), each once by folder. The default folder comes first
// and is always read, as is the caller's own CLAUDE_CONFIG_DIR, so a session or worker started under
// a folder the file does not name is never missed. Only folders that exist.
//   -> [login]
export function claudeLogins(env = process.env) {
  const extra = env.CLAUDE_CONFIG_DIR ? [envLogin(resolve(env.CLAUDE_CONFIG_DIR))] : [];
  return toolLogins('claude', readSubscriptions(subscriptionsPath()), extra).filter((l) => !l.configDir || isDir(l.dir));
}

// The logins work may be running on: every login above, then each removed one whose folder exists, as
// a worker started on a login before it was removed is still running. ~/.claude is always among them:
// with accounts pinned desk starts nothing there, but a worker started there before is still running.
//   -> [login]
function runningLogins(env = process.env) {
  const out = claudeLogins(env);
  const own = defaultLogin('claude');
  if (!out.some((l) => l.dir === own.dir) && isDir(own.dir)) out.unshift(own);
  for (const r of readSubscriptions(subscriptionsPath()).removed) {
    if (r.tool === 'claude' && isDir(r.dir) && !out.some((l) => l.dir === r.dir)) out.push(login({ tool: 'claude', name: r.name, folder: r.dir, rule: null, source: 'removed' }));
  }
  return out;
}

// A login desk may start or probe work on: in rotation or on standby.
export const inUse = (l) => l.rule === 'in rotation' || l.rule === 'standby';
// The logins a usage probe runs on, the default first.
export const probeLogins = () => claudeLogins().filter(inUse);

// The login a config folder is, or a login for that folder when no reader knows it. Null or empty is
// the default login.
export function loginOf(configDir) {
  const dir = configDir ? resolve(configDir) : defaultLogin('claude').dir;
  return claudeLogins().find((l) => l.dir === dir) ?? envLogin(dir);
}
// One key per login, for state kept per login: `default`, or the login's name with anything outside
// letters, digits, dot, dash and underscore made a dash.
export const loginKey = (l) => (l?.configDir ? String(l.name).replace(/[^A-Za-z0-9._-]/g, '-') : 'default');

// The agent registry across every login: each login's `claude agents --json`, each entry tagged with
// the login it came from. One login that cannot be read fails the whole read: a failure must never
// look like "nothing is running".
//   -> { ok: true, live: [{ ...agent, login, configDir }] } | { ok: false, live: null, why }
export function readRegistry({ env = process.env } = {}) {
  const live = [];
  for (const l of runningLogins(env)) {
    const r = spawnSync('claude', ['agents', '--json'], { env: loginEnv(l, env), encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    const at = `the registry of claude login ${l.name} (${l.folder})`;
    if (r.error || r.signal) return { ok: false, live: null, why: `${at}: ${r.error?.code === 'ETIMEDOUT' || r.signal ? `no answer within ${CHECK_TIMEOUT_MS / 1000}s` : r.error.message}` };
    if (r.status !== 0) return { ok: false, live: null, why: `${at}: exited ${r.status}${(r.stderr ?? '').trim() ? `: ${r.stderr.trim().split('\n').pop().slice(0, 200)}` : ''}` };
    let list;
    try { list = JSON.parse(r.stdout || '[]'); } catch { return { ok: false, live: null, why: `${at}: not JSON` }; }
    if (!Array.isArray(list)) return { ok: false, live: null, why: `${at}: not a list` };
    for (const a of list) live.push({ ...a, login: l.name, configDir: l.configDir });
  }
  return { ok: true, live };
}

// The login a worker runs on, from the file spawn-worker.sh writes beside its settings at each start
// (kept out of its log, whose growth is the worker's own output): its config folder, or null for the
// default. A worker with no such file reads as `none`.
const readLoginFile = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
export function workerLoginDir(stateDir, key, none = null) {
  const r = readLoginFile(loginFile(stateDir, key));
  return r ? r.config_dir || null : none;
}

// The login a worker log ran on, by its name in <state>/logs: `<key>.log` is the worker's latest start,
// and `<key>.log.round<n>[.gz]` the login file kept with that round, or the latest with none kept.
const WORKER_LOG = /^(.+)\.log(?:\.round(\d+)(?:\.gz)?)?$/;
export function logLoginDir(stateDir, name) {
  const [, key, round] = WORKER_LOG.exec(name) ?? [];
  if (!key) return null;
  const file = loginFile(stateDir, key);
  return ((round && readLoginFile(`${file}.round${round}`)) ?? readLoginFile(file))?.config_dir || null;
}

// Where every login keeps its session transcripts: <folder>/projects.
export const projectsDirs = () => runningLogins().map((l) => join(l.dir, 'projects'));

// ---- CLI ---------------------------------------------------------------------------------------
//   agents          the registry across every login, one JSON list; exit 1 when a login cannot be read
//   login-event     the login file's JSON for this process's CLAUDE_CONFIG_DIR
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'agents') {
    const r = readRegistry();
    if (!r.ok) { console.error(r.why); process.exit(1); }
    console.log(JSON.stringify(r.live));
  } else if (cmd === 'login-event') {
    const l = loginOf(process.env.CLAUDE_CONFIG_DIR);
    console.log(JSON.stringify({ login: l.name, config_dir: l.configDir, at: new Date().toISOString() }));
  } else {
    console.error('usage: claude-logins.mjs agents | login-event');
    process.exit(2);
  }
}
