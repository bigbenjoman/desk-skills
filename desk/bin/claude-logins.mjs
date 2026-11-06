// Every Claude login a reader of this computer's Claude state covers: the agent registry, session
// transcripts, sign-in and the usage probe. A login is a config folder (logins.mjs); `claude agents
// --json`, `claude auth status` and a session's transcript each see only the folder CLAUDE_CONFIG_DIR
// points at, so each is read once per login.
//
// The registry covers every login whose folder exists, whatever its rule or sign-in: a worker started
// on a login later turned off or signed out is still running. With one login, each reader makes one
// call, with no CLAUDE_CONFIG_DIR.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscriptionsPath } from './desk-env.mjs';
import { CHECK_TIMEOUT_MS, defaultLogin, foundLogin, isDir, login, loginEnv, readSubscriptions, unlistedFolders } from './logins.mjs';

// A login for a folder no subscriptions row names.
const envLogin = (dir) => login({ tool: 'claude', name: basename(dir), folder: dir, rule: null, source: 'env' });

// The Claude logins the subscriptions file lists, then the folders under ~/.claude-logins it does not
// (on standby with a file, no rule without one), each once by folder. The default folder comes first
// and is always read, as is the caller's own CLAUDE_CONFIG_DIR, so a session or worker started under
// a folder the file does not name is never missed. Only folders that exist.
//   -> [login]
function claudeLogins(env = process.env) {
  const subs = readSubscriptions(subscriptionsPath());
  const out = [defaultLogin('claude')];
  const add = (l) => { if (!out.some((o) => o.dir === l.dir)) out.push(l); };
  for (const l of subs.logins) if (l.tool === 'claude') add(l);
  for (const dir of unlistedFolders('claude', out)) add(foundLogin('claude', dir, subs));
  if (env.CLAUDE_CONFIG_DIR) add(envLogin(resolve(env.CLAUDE_CONFIG_DIR)));
  // The default login keeps its place: the file's own row for ~/.claude (a name, a rule) replaces it,
  // and a file that lists other Claude logins but not this one gives it no rule.
  const fileDefault = subs.logins.find((l) => l.tool === 'claude' && l.dir === out[0].dir);
  out[0] = fileDefault ?? { ...out[0], rule: null };
  return out.filter((l, i) => i === 0 || isDir(l.dir));
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
  for (const l of claudeLogins(env)) {
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
// default, and for a worker with no such file.
export const loginFile = (stateDir, key) => join(stateDir, 'workers', `${key}.login.json`);
export function workerLoginDir(stateDir, key) {
  try { return JSON.parse(readFileSync(loginFile(stateDir, key), 'utf8')).config_dir || null; } catch { return null; }
}

// Where every login keeps its session transcripts: <folder>/projects.
export const projectsDirs = () => claudeLogins().map((l) => join(l.dir, 'projects'));

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
