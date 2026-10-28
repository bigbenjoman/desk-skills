#!/usr/bin/env node
// The installed desk version, and moving what still runs onto it. install.sh runs both at the end:
//   node installed.mjs record <checkout>   write <DESK_HOME>/installed.json: the commit installed from
//   node installed.mjs version             print the installed commit (nothing when none is recorded)
//   node installed.mjs restart             restart each running merge driver that is between loops, and
//                                          rewrite and reload each loaded supervisor agent; one line each
//
// install.sh replaces scripts by rename, so a running merge driver keeps its old copy until it is
// started again. A driver is restarted only while it waits between loops (its one child is `sleep`):
// one mid-loop may be merging, so it is left, and moves when it is next started. Each one is
// started again with the tickets and deps it was given, from its repo's §2 Primary repo root.
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, openSync, closeSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAIT_MS = Number(process.env.DESK_RESTART_WAIT_MS) || 10_000;

export const installedFile = (home = E.deskHome()) => join(home, 'installed.json');
// {commit, dirty, at, from}, or null when no install has recorded one.
export function readInstalled(home = E.deskHome()) {
  try { const v = JSON.parse(readFileSync(installedFile(home), 'utf8')); return v?.commit ? v : null; } catch { return null; }
}
// A process runs old code when an installed version is known and the one it started at is not it.
export const oldCode = (version, installed = readInstalled()) => Boolean(installed?.commit) && version !== installed.commit;

// A source that is not a git checkout has no commit, so it gets one of its own for this install: the
// version before it must not stay recorded, or what started on older code would read as current.
function record(src) {
  const git = (...a) => spawnSync('git', ['-C', src, ...a], { encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  const at = new Date().toISOString();
  const v = head.status === 0
    ? { commit: head.stdout.trim(), dirty: Boolean(git('status', '--porcelain').stdout.trim()), at, from: src }
    : { commit: `unversioned-${at}`, dirty: null, at, from: src };
  mkdirSync(E.deskHome(), { recursive: true });
  writeFileSync(installedFile(), `${JSON.stringify(v, null, 2)}\n`);
  return v;
}

// ---- merge drivers ---------------------------------------------------------------------------
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(ok, ms = WAIT_MS) {
  for (const end = Date.now() + ms; Date.now() < end; sleep(200)) if (ok()) return true;
  return ok();
}
const lockPid = (dir) => { try { return Number(readFileSync(join(dir, 'merge-driver.lock.d', 'pid'), 'utf8').trim()) || null; } catch { return null; } };

// Every process as {pid, ppid, comm, args}, from one ps.
function processes() {
  const r = spawnSync('ps', ['-ww', '-A', '-o', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' });
  return String(r.stdout ?? '').split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map(([, pid, ppid, comm, args]) => ({ pid: Number(pid), ppid: Number(ppid), comm: basename(comm), args }));
}

// --tickets and --deps from a driver's command line, or null when it names no tickets. No id or deps
// entry starts with `--`, so each flag's words run to the next flag.
export function driverArgs(args) {
  const words = String(args).trim().split(/\s+/);
  const at = words.findIndex((w) => /(^|\/)merge-driver\.sh$/.test(w));
  if (at < 0) return null;
  const out = { tickets: [], deps: [] };
  let into = null;
  for (const w of words.slice(at + 1)) {
    if (w === '--tickets') into = out.tickets;
    else if (w === '--deps') into = out.deps;
    else if (w.startsWith('--')) into = null;
    // A deps entry keeps its commas (succ:pred,pred); tickets may be comma-separated.
    else if (into === out.deps) into.push(w);
    else if (into) into.push(...w.split(',').filter(Boolean));
  }
  return out.tickets.length ? out : null;
}

// The batch state directories under ~/.desk-autopilot whose merge driver is alive: each repo's standing
// batch (`batch` null), then its named batches under `batches/<name>/`.
function runningDrivers(root) {
  const out = [];
  for (const slug of existsSync(root) ? readdirSync(root).sort() : []) {
    const nested = join(root, slug, E.BATCHES_DIR);
    let names = [];
    try { names = readdirSync(nested, { withFileTypes: true }).filter((d) => d.isDirectory() && E.SAFE_ID.test(d.name)).map((d) => d.name).sort(); } catch { /* no named batches */ }
    for (const batch of [null, ...names]) {
      const dir = batch ? join(nested, batch) : join(root, slug);
      const pid = lockPid(dir);
      if (pid && alive(pid)) out.push({ slug, batch, dir, pid });
    }
  }
  return out;
}

// One line saying what became of a running driver.
function restartDriver({ slug, batch = null, dir, pid }, ps) {
  const who = batch ? `${slug} batch ${batch}` : slug;
  const name = `merge driver for ${who} (pid ${pid})`;
  const me = ps.find((p) => p.pid === pid);
  const args = me && driverArgs(me.args);
  if (!args) return `${name}: left running on the old code, its command line names no tickets to start it again with`;
  const kids = ps.filter((p) => p.ppid === pid);
  if (!kids.length || kids.some((k) => k.comm !== 'sleep')) {
    return `${name}: left running on the old code, it is mid-loop and may be merging; it moves to the new code when the supervisor next starts it`;
  }
  const raw = E.repoConfigValue(slug, 'repo-root');
  const root = raw && E.expandHome(raw).replace(/\/+$/, '');
  if (!root || !existsSync(root)) return `${name}: left running on the old code, ${slug} has no §2 Primary repo root here to start it from`;
  // The driver traps TERM once its sleep returns, so the sleep is stopped too.
  for (const p of [pid, ...kids.map((k) => k.pid)]) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
  if (!waitFor(() => !alive(pid) && lockPid(dir) !== pid)) return `${name}: did not stop within ${WAIT_MS / 1000}s of SIGTERM, so it was not started again`;
  const env = { ...process.env, DESK_REPO_DIR: root, DESK_AUTOPILOT_STATE: dir };
  for (const k of ['DESK_QUEUE', 'DESK_STATE', 'DESK_SLUG', 'DESK_REPO_ROOT', 'DESK_BATCH']) delete env[k];
  // A named batch's driver acts on that batch's queue, and reads its base as the batch does.
  if (batch) Object.assign(env, { DESK_BATCH: batch, DESK_QUEUE: E.batchPaths(slug, batch).queue });
  const argv = ['--tickets', args.tickets.join(' '), ...(args.deps.length ? ['--deps', args.deps.join(' ')] : []), '--log'];
  let fd;
  try {
    fd = openSync(join(dir, 'merge-driver.log'), 'a');
    const child = spawn(join(HERE, 'merge-driver.sh'), argv, { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => {});
    child.unref();
  } catch (e) { return `${name}: stopped, but could not be started again: ${e.message}`; }
  finally { if (fd !== undefined) closeSync(fd); }
  const now = waitFor(() => { const p = lockPid(dir); return Boolean(p && p !== pid && alive(p)); }) ? lockPid(dir) : null;
  return now
    ? `merge driver for ${who}: restarted on the new code (pid ${pid} -> ${now}) for ${args.tickets.join(' ')}`
    : `${name}: stopped and started again, but no new driver holds the lock yet; see ${join(dir, 'merge-driver.log')}`;
}

// ---- supervisor agents -----------------------------------------------------------------------
const AGENT = /^com\.desk-skills\.supervisor\.(.+)\.plist$/;
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export function readPlist(text) {
  const str = (k) => { const m = new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(text); return m ? unxml(m[1]) : null; };
  const env = {};
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? '';
  for (const [, k, v] of dict.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) env[unxml(k)] = unxml(v);
  const every = Number(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1]) || null;
  return { label: str('Label'), cwd: str('WorkingDirectory'), env, every };
}

// One line per loaded agent, rewritten through `supervisor.mjs install --reload` from its own working
// directory and environment, so its plist names this node. An agent not loaded is not running.
function reloadAgents(dir) {
  const lines = [];
  for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (!AGENT.test(f)) continue;
    const p = readPlist(readFileSync(join(dir, f), 'utf8'));
    const label = p.label ?? f.replace(/\.plist$/, '');
    if (spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`]).status !== 0) continue;
    if (!p.cwd || !existsSync(p.cwd)) { lines.push(`supervisor ${label}: not reloaded, its working directory ${p.cwd ?? '(none)'} is gone`); continue; }
    const env = { ...process.env, ...p.env, PATH: process.env.PATH };
    const r = spawnSync(process.execPath, [join(HERE, 'supervisor.mjs'), 'install', '--reload', ...(p.every ? ['--interval', String(p.every)] : [])], { cwd: p.cwd, env, encoding: 'utf8' });
    lines.push(r.status === 0 ? `supervisor ${label}: rewritten with node ${process.execPath} and reloaded`
      : `supervisor ${label}: could not be reloaded: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').pop()}`);
  }
  return lines;
}

export function restart({ stateRoot = join(E.HOME, '.desk-autopilot'), agents = join(E.HOME, 'Library', 'LaunchAgents') } = {}) {
  // A fresh ps for each driver: restarting the one before can take seconds, in which this one wakes.
  const lines = [...runningDrivers(stateRoot).map((d) => restartDriver(d, processes())), ...reloadAgents(agents)];
  return lines.length ? lines : ['nothing to restart: no merge driver or supervisor agent is running'];
}

const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'record' && arg) { const v = record(arg); console.log(`${v.commit}${v.dirty ? ' (with uncommitted changes)' : ''}${v.dirty === null ? ' (not a git checkout)' : ''}`); }
    else if (cmd === 'version') { const v = readInstalled(); if (v) console.log(v.commit); }
    else if (cmd === 'restart') for (const l of restart()) console.log(l);
    else { console.error('usage: installed.mjs record <checkout> | version | restart'); process.exit(2); }
  } catch (e) { console.error(`installed: ${e.message}`); process.exit(1); }
}
