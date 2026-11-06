// Every Claude login a reader of this computer's Claude state covers: the agent registry, session
// transcripts, sign-in and the usage probe. A login is a config folder (logins.mjs); `claude agents
// --json`, `claude auth status` and a session's transcript each see only the folder CLAUDE_CONFIG_DIR
// points at, so each is read once per login.
//
// The registry covers every login whose folder exists, whatever its rule or sign-in: a worker started
// on a login later turned off or signed out is still running. With one login, every reader here runs
// exactly the one call it ran before.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscriptionsPath } from './desk-env.mjs';
import { CHECK_TIMEOUT_MS, defaultLogin, loginEnv, loginsFolder, readSubscriptions } from './logins.mjs';

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// The Claude logins the subscriptions file lists, then the folders under ~/.claude-logins it does not
// (on standby with a file, no rule without one), each once by folder. The default folder comes first
// and is always read, as is the caller's own CLAUDE_CONFIG_DIR, so a session or worker started under
// a folder the file does not name is never missed. Only folders that exist.
//   -> [login]
export function claudeLogins({ path = subscriptionsPath(), env = process.env } = {}) {
  const subs = readSubscriptions(path);
  const out = [defaultLogin('claude')];
  const add = (l) => { if (!out.some((o) => o.dir === l.dir)) out.push(l); };
  for (const l of subs.logins) if (l.tool === 'claude') add(l);
  let names = [];
  try { names = readdirSync(loginsFolder('claude')).sort(); } catch { /* none */ }
  for (const n of names) {
    const dir = join(loginsFolder('claude'), n);
    if (isDir(dir)) add(folderLogin(dir, { name: n, rule: subs.exists ? 'standby' : null, source: 'found' }));
  }
  if (env.CLAUDE_CONFIG_DIR) add(folderLogin(resolve(env.CLAUDE_CONFIG_DIR), { source: 'env' }));
  // The default login keeps its place whatever the file says about it, so the file's own entry for
  // ~/.claude (a name, a rule) replaces it.
  // A file that lists other Claude logins but not this one gives it no rule.
  const fileDefault = subs.logins.find((l) => l.tool === 'claude' && l.dir === out[0].dir);
  out[0] = fileDefault ?? { ...out[0], rule: null };
  return out.filter((l, i) => i === 0 || isDir(l.dir));
}

// The logins a usage probe runs on: those in rotation or on standby, the default first.
export const probeLogins = (opts) => claudeLogins(opts).filter((l) => l.rule === 'in rotation' || l.rule === 'standby');

// The login a config folder is, or a login for that folder when no reader knows it. Null or empty is
// the default login.
export function loginOf(configDir, logins = claudeLogins()) {
  const dir = configDir ? resolve(configDir) : defaultLogin('claude').dir;
  return logins.find((l) => l.dir === dir) ?? folderLogin(dir, { source: 'env' });
}
// A login for a folder no subscriptions row names.
function folderLogin(dir, { name = basename(dir), rule = null, source }) {
  const d = defaultLogin('claude');
  return dir === d.dir ? d : { ...d, name, folder: dir, dir, configDir: dir, rule, source };
}
// One key per login, for state kept per login: `default`, or the login's name with anything outside
// letters, digits, dot, dash and underscore made a dash.
export const loginKey = (l) => (l?.configDir ? String(l.name).replace(/[^A-Za-z0-9._-]/g, '-') : 'default');

// The agent registry across every login: each login's `claude agents --json`, each entry tagged with
// the login it came from. One login that cannot be read fails the whole read, as a failed read of the
// one registry did: a failure must never look like "nothing is running".
//   -> { ok: true, live: [{ ...agent, login, configDir }] } | { ok: false, live: null, why }
export function readRegistry({ claude = 'claude', env = process.env, logins = claudeLogins({ env }) } = {}) {
  const live = [];
  for (const l of logins) {
    const r = spawnSync(claude, ['agents', '--json'], { env: loginEnv(l, env), encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
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

// The login a worker runs on, from the `desk_login` line spawn-worker.sh writes to its log at each
// start: its config folder, or null for the default (and for a log with no such line).
export const LOGIN_EVENT = 'desk_login';
export function logLoginDir(path) {
  try { return loginDirIn(readFileSync(path, 'utf8')); } catch { return null; }
}
export function loginDirIn(text) {
  const at = String(text).lastIndexOf(`{"type":"${LOGIN_EVENT}"`);
  if (at < 0) return null;
  const end = text.indexOf('\n', at);
  try { return JSON.parse(text.slice(at, end < 0 ? undefined : end)).config_dir || null; } catch { return null; }
}

// Where every login keeps its session transcripts: <folder>/projects.
export const projectsDirs = (opts) => claudeLogins(opts).map((l) => join(l.dir, 'projects'));

// ---- CLI ---------------------------------------------------------------------------------------
//   agents          the registry across every login, one JSON list; exit 1 when a login cannot be read
//   login-event     the `desk_login` log line for this process's CLAUDE_CONFIG_DIR
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
    console.log(JSON.stringify({ type: LOGIN_EVENT, login: l.name, config_dir: l.configDir, at: new Date().toISOString() }));
  } else {
    console.error('usage: claude-logins.mjs agents | login-event');
    process.exit(2);
  }
}
