#!/usr/bin/env node
// The installed desk version, and moving what still runs onto it. install.sh runs both at the end:
//   node installed.mjs record <checkout> [<release dir>]   write <DESK_HOME>/installed.json: the commit
//                                          installed from (and the release's own release.json)
//   node installed.mjs version             print the installed commit (nothing when none is recorded)
//   node installed.mjs running             print the commit of the release this script runs from (the
//                                          installed one outside a release folder)
//   node installed.mjs restart             restart each running merge driver that is between loops, and
//                                          rewrite and reload each loaded supervisor agent; one line each
//   node installed.mjs prune               delete all but the newest three releases, never the current one
//   node installed.mjs rollback            make the release before the current one current (exit 1: none)
//
// install.sh puts each install in a release folder of its own, so a running merge driver keeps its old copy until it is
// started again. A driver is restarted only while it waits between loops (its one child is `sleep`):
// one mid-loop may be merging, so it is left, and a supervisor tick restarts it the same way once it
// waits between loops (supervisor.mjs moveDriver). Each one is
// started again with the tickets and deps it was given, from its repo's §2 Primary repo root, except
// that the repo's one driver (--all-batches) starts again as one, and so does a handed-over batch's
// driver that was given no deps: a repo's per-batch drivers become its one driver.
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, openSync, closeSync, realpathSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { namedBatches } from './batches.mjs';
import { supervisorLabel, backend, systemctl } from './run-by.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AGENTS = join(E.HOME, 'Library', 'LaunchAgents');
export const plistPath = (slug) => join(AGENTS, `${supervisorLabel(slug)}.plist`);
// The systemd user units, `<label>.service` and `<label>.timer`, where systemd reads a user's own.
export const unitDir = () => join(process.env.XDG_CONFIG_HOME || join(E.HOME, '.config'), 'systemd', 'user');
export const unitPath = (slug, kind) => join(unitDir(), `${supervisorLabel(slug)}.${kind}`);
const WAIT_MS = Number(process.env.DESK_RESTART_WAIT_MS) || 10_000;

export const installedFile = (home = E.deskHome()) => join(home, 'installed.json');
// {commit, dirty, at, from}, or null when no install has recorded one.
export function readInstalled(home = E.deskHome()) {
  try { const v = JSON.parse(readFileSync(installedFile(home), 'utf8')); return v?.commit ? v : null; } catch { return null; }
}
// The desk version this script runs: its release folder's (releaseCommit), so one started from an older
// release reads as old whatever is installed since. Outside a release folder, the installed commit, or null.
export function runningVersion(home = E.deskHome()) {
  const dir = E.releaseDirOf(HERE, home);
  if (!dir) return readInstalled(home)?.commit ?? null;
  let info = null;
  try { info = JSON.parse(readFileSync(join(dir, RELEASE_FILE), 'utf8')); } catch { /* none written */ }
  return releaseCommit(basename(dir), info);
}
// A process runs old code when an installed version is known and the one it started at is not it.
export const oldCode = (version, installed = readInstalled()) => Boolean(installed?.commit) && version !== installed.commit;

// A source that is not a git checkout has no commit, so it gets one of its own for this install: the
// version before it must not stay recorded, or what started on older code would read as current.
// `dirty` means a tracked file differs from the commit; untracked files are not installed code.
// With a release folder, the same record is written into it as release.json, which rollback reads.
function record(src, release = null) {
  const git = (...a) => spawnSync('git', ['-C', src, ...a], { encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  const at = new Date().toISOString();
  const v = head.status === 0
    ? { commit: head.stdout.trim(), dirty: Boolean(git('status', '--porcelain', '--untracked-files=no').stdout.trim()), at, from: src }
    : { commit: `unversioned-${at}`, dirty: null, at, from: src };
  if (release) {
    v.release = basename(release);
    writeFileSync(join(release, RELEASE_FILE), `${JSON.stringify(v, null, 2)}\n`);
  }
  mkdirSync(E.deskHome(), { recursive: true });
  writeFileSync(installedFile(), `${JSON.stringify(v, null, 2)}\n`);
  return v;
}

// ---- releases --------------------------------------------------------------------------------
// install.sh puts desk's scripts and templates in <DESK_HOME>/releases/<name>/{bin,templates};
// `current` is a relative link to the live one, and <DESK_HOME>/bin and /templates link through it.
// A release's order is its release.json `at` (when it last went live), else its folder's mtime.
export const KEEP_RELEASES = 3;
const RELEASE_FILE = 'release.json';
// A release's version: its release.json commit, else release-<name>. Rollback records it as installed and
// a driver started from the release records it in its lock, so the two compare equal.
const releaseCommit = (name, info) => info?.commit || `release-${name}`;
export const releasesDir = (home = E.deskHome()) => join(home, 'releases');
export function currentRelease(home = E.deskHome()) {
  try { return basename(readlinkSync(join(home, 'current'))); } catch { return null; }
}
export function releases(home = E.deskHome()) {
  const dir = releasesDir(home);
  const out = [];
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (name.startsWith('.') || !statSync(join(dir, name)).isDirectory()) continue;
    let info = null;
    try { info = JSON.parse(readFileSync(join(dir, name, RELEASE_FILE), 'utf8')); } catch { /* none written */ }
    const t = Date.parse(info?.at ?? '');
    out.push({ name, info, at: Number.isNaN(t) ? statSync(join(dir, name)).mtimeMs : t });
  }
  return out.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}
// Points `current` at releases/<name> in one rename, so no reader ever finds it missing.
export function makeCurrent(name, home = E.deskHome()) {
  const tmp = join(home, `.current.${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(join('releases', name), tmp);
  renameSync(tmp, join(home, 'current'));
}
// Deletes all but the newest `keep` releases, never the current one. One line per release deleted.
export function pruneReleases(keep = KEEP_RELEASES, home = E.deskHome()) {
  const cur = currentRelease(home);
  const list = releases(home);
  return list.slice(0, Math.max(0, list.length - keep)).filter((r) => r.name !== cur).map((r) => {
    rmSync(join(releasesDir(home), r.name), { recursive: true, force: true });
    return `removed release ${r.name} (only the newest ${keep} are kept)`;
  });
}
// Makes the release before the current one current, and records its commit as installed.
// {ok, line}; with no earlier release, nothing changes.
export function rollback(home = E.deskHome()) {
  const cur = currentRelease(home);
  const list = releases(home);
  const at = list.findIndex((r) => r.name === cur);
  if (at < 1) {
    return { ok: false, line: `nothing rolled back: there is no earlier release than ${cur ? `the current one (${cur})` : 'what is installed'} in ${releasesDir(home)}` };
  }
  const prev = list[at - 1];
  makeCurrent(prev.name, home);
  const v = { commit: releaseCommit(prev.name, prev.info), dirty: prev.info?.dirty ?? null, at: new Date().toISOString(), from: prev.info?.from ?? null, release: prev.name };
  writeFileSync(installedFile(home), `${JSON.stringify(v, null, 2)}\n`);
  return { ok: true, line: `rolled back from release ${cur} to ${prev.name} (commit ${v.commit})` };
}

// ---- merge drivers ---------------------------------------------------------------------------
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(ok, ms = WAIT_MS) {
  for (const end = Date.now() + ms; Date.now() < end; sleep(200)) if (ok()) return true;
  return ok();
}
// `lock` is a batch's own lock, or E.REPO_DRIVER_LOCK, the one the repo's one driver holds.
const BATCH_LOCK = 'merge-driver.lock.d';
const lockPid = (dir, lock = BATCH_LOCK) => { try { return Number(readFileSync(join(dir, lock, 'pid'), 'utf8').trim()) || null; } catch { return null; } };
// The desk version the driver holding the lock in `dir` started at, or null with none written.
export const lockVersion = (dir, lock = BATCH_LOCK) => { try { return readFileSync(join(dir, lock, 'version'), 'utf8').trim() || null; } catch { return null; } };

// Every process as {pid, ppid, comm, args}, from one ps. Throws when ps cannot be read.
function processes() {
  return E.psRows('pid=,ppid=,comm=,args=').map((p) => ({ ...p, comm: basename(p.comm) }));
}

// --tickets and --deps from a driver's command line, and `all` for the repo's one driver
// (--all-batches), or null when it names no tickets and is not that. No id or deps entry starts with
// `--`, so each flag's words run to the next flag.
export function driverArgs(args) {
  const words = String(args).trim().split(/\s+/);
  const at = words.findIndex((w) => /(^|\/)merge-driver\.sh$/.test(w));
  if (at < 0) return null;
  const out = { tickets: [], deps: [] };
  let into = null;
  for (const w of words.slice(at + 1)) {
    if (w === '--tickets') into = out.tickets;
    else if (w === '--deps') into = out.deps;
    else if (w === '--all-batches') { out.all = true; into = null; }
    else if (w.startsWith('--')) into = null;
    // A deps entry keeps its commas (succ:pred,pred); tickets may be comma-separated.
    else if (into === out.deps) into.push(w);
    else if (into) into.push(...w.split(',').filter(Boolean));
  }
  return out.tickets.length || out.all ? out : null;
}

// The batch state directories under ~/.desk-autopilot whose merge driver is alive: each repo's standing
// batch (`batch` null), then its named batches under `batches/<name>/`, after the repo's one driver. A
// driver is listed once, at the first lock it holds: the repo's one driver holds the repo's lock and
// points the lock of each batch it merges for.
function runningDrivers(root) {
  const out = [];
  const seen = new Set();
  const add = (slug, batch, dir, lock) => {
    const pid = lockPid(dir, lock);
    if (pid && alive(pid) && !seen.has(pid)) { seen.add(pid); out.push({ slug, batch, dir, pid }); }
  };
  for (const slug of existsSync(root) ? readdirSync(root).sort() : []) {
    add(slug, null, join(root, slug), E.REPO_DRIVER_LOCK);
    for (const batch of [null, ...namedBatches(join(root, slug))]) add(slug, batch, batch ? join(root, slug, E.BATCHES_DIR, batch) : join(root, slug));
  }
  return out;
}

// The update runs from any shell, perhaps one that worked another repo's batch, so the restarted
// driver keeps none of its per-repo values: the repo's own config and queue decide them, as they do
// for the supervisor's driver. An inherited DESK_DEFAULT_BRANCH would have it watch another base.
export function driverEnv(env = process.env) {
  const out = E.otherRepoEnv(env);
  for (const k of E.PER_REPO_ENV) delete out[k];
  return out;
}

// Whether the batch's queue is handed over to the supervisor, whose one driver merges for it.
const supervised = (queue) => { try { return JSON.parse(readFileSync(queue, 'utf8')).supervised === true; } catch { return false; } };

// One line saying what became of a running driver. `queue`, where given, is the queue it is started on
// again; a named batch's is otherwise that batch's, the standing batch's the repo's own. It reads a
// fresh ps: a partial list could miss its tickets, so a ps that fails leaves it running. The repo's one
// driver, or a handed-over batch's driver with no deps, is started again as the repo's one driver; a
// named batch's so is stopped, and the repo's one driver takes the batch on, started here when none runs.
export function restartDriver({ slug, batch = null, dir, pid, queue = null }) {
  const who = batch ? `${slug} batch ${batch}` : slug;
  const name = `merge driver for ${who} (pid ${pid})`;
  let ps;
  try { ps = processes(); } catch (e) { return `${name}: left running on the old code, ${e.message}`; }
  const me = ps.find((p) => p.pid === pid);
  const args = me && driverArgs(me.args);
  if (!args) return `${name}: left running on the old code, its command line names no tickets to start it again with`;
  const asRepo = args.all || (!args.deps.length && supervised(queue ?? E.batchPaths(slug, batch).queue));
  const kids = ps.filter((p) => p.ppid === pid);
  if (!kids.length || kids.some((k) => k.comm !== 'sleep')) {
    return `${name}: left running on the old code, it is mid-loop and may be merging; a supervisor tick moves it to the new code once it waits between loops`;
  }
  const root = E.repoDirs(slug).root;
  if (!root || !existsSync(root)) return `${name}: left running on the old code, ${slug} has no §2 Primary repo root here to start it from`;
  // The driver stops on TERM in its pause; its sleep is stopped too.
  for (const p of [pid, ...kids.map((k) => k.pid)]) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
  if (!waitFor(() => !alive(pid) && lockPid(dir, args.all ? E.REPO_DRIVER_LOCK : BATCH_LOCK) !== pid)) return `${name}: did not stop within ${WAIT_MS / 1000}s of SIGTERM, so it was not started again`;
  if (asRepo) return restartRepo({ slug, batch, dir, pid, queue, args, root, name });
  const env = { ...driverEnv(), DESK_REPO_DIR: root, DESK_AUTOPILOT_STATE: dir };
  // A named batch's driver acts on that batch's queue, and reads its base as the batch does.
  if (batch) Object.assign(env, { DESK_BATCH: batch, DESK_QUEUE: E.batchPaths(slug, batch).queue });
  if (queue) env.DESK_QUEUE = queue;
  const argv = ['--tickets', args.tickets.join(' '), ...(args.deps.length ? ['--deps', args.deps.join(' ')] : []), '--log'];
  const now = startDriver({ argv, env, root, dir, lock: BATCH_LOCK, pid });
  if (typeof now === 'string') return `${name}: stopped, but could not be started again: ${now}`;
  return now
    ? `merge driver for ${who}: restarted on the new code (pid ${pid} -> ${now}) for ${args.tickets.join(' ')}`
    : `${name}: stopped and started again, but no new driver holds the lock yet; see ${join(dir, 'merge-driver.log')}`;
}

// Starts a driver detached, logging to <dir>/merge-driver.log, and waits for a new pid in its lock.
// -> that pid, null when none holds it in time, or the error that stopped the start.
function startDriver({ argv, env, root, dir, lock, pid }) {
  let fd;
  try {
    mkdirSync(dir, { recursive: true });
    fd = openSync(join(dir, 'merge-driver.log'), 'a');
    const child = spawn(join(HERE, 'merge-driver.sh'), argv, { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => {});
    child.unref();
  } catch (e) { return e.message; }
  finally { if (fd !== undefined) closeSync(fd); }
  const now = waitFor(() => { const p = lockPid(dir, lock); return Boolean(p && p !== pid && alive(p)); }) ? lockPid(dir, lock) : null;
  // It writes its version just after its pid, so what reads the lock next reads it as current.
  if (now) waitFor(() => Boolean(lockVersion(dir, lock)) || lockPid(dir, lock) !== now);
  return now;
}

// The stopped driver's place taken by the repo's one driver, which holds the repo's lock under the
// standing batch's state: the same driver started again, or one that also merges for a batch whose own
// driver stopped. A driver that named its batch or state explicitly (DESK_BATCH, DESK_AUTOPILOT_STATE,
// DESK_QUEUE) is started on that one again.
function restartRepo({ slug, batch, dir, pid, queue, args, root, name }) {
  const own = E.batchPaths(slug);
  const at = args.all || !batch ? dir : own.state;
  const env = { ...driverEnv(), DESK_REPO_DIR: root };
  if (at !== own.state) env.DESK_AUTOPILOT_STATE = at;
  if (args.all && batch) env.DESK_BATCH = batch;
  if (queue && queue !== own.queue && (args.all || !batch)) env.DESK_QUEUE = queue;
  const running = lockPid(at, E.REPO_DRIVER_LOCK);
  if (running && running !== pid && alive(running)) return `${name}: stopped, and the repo's one driver (pid ${running}) merges for its batch from its next sweep`;
  const now = startDriver({ argv: ['--all-batches', '--log'], env, root, dir: at, lock: E.REPO_DRIVER_LOCK, pid });
  if (typeof now === 'string') return `${name}: stopped, but the repo's one driver could not be started: ${now}`;
  return now
    ? `merge driver for ${slug}: restarted on the new code (pid ${pid} -> ${now}), as the repo's one driver for all its batches`
    : `${name}: stopped and the repo's one driver started, but it holds no lock yet; see ${join(at, 'merge-driver.log')}`;
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
// A supervisor's service and timer units, as supervisor.mjs writes them: { cwd, env, every }.
const unquote = (s) => s.replace(/\\(.)/g, '$1').replace(/%%/g, '%');
export function readUnit(service, timer = '') {
  const cwd = /^WorkingDirectory=(.*)$/m.exec(service)?.[1];
  const env = {};
  for (const [, v] of service.matchAll(/^Environment="((?:[^"\\]|\\.)*)"$/gm)) {
    const kv = unquote(v);
    env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  }
  const every = Number(/^OnUnitActiveSec=(\d+)s$/m.exec(timer)?.[1]) || null;
  return { cwd: cwd == null ? null : unquote(cwd), env, every };
}
// The desk version a repo's agent was loaded at, or null with none recorded. The plist or service is
// only written as the agent reloads, so this is what launchd or systemd runs next, whatever a pass
// still going started on.
export function agentVersion(slug) {
  try {
    if (backend() === 'systemd') return readUnit(readFileSync(unitPath(slug, 'service'), 'utf8')).env.DESK_AGENT_VERSION ?? null;
    return readPlist(readFileSync(plistPath(slug), 'utf8')).env.DESK_AGENT_VERSION ?? null;
  } catch { return null; }
}

// One line per loaded agent, rewritten through `supervisor.mjs install --reload` from its own working
// directory and environment, so its plist or service names this node. An agent not loaded (a timer
// not active) is not running.
const UNIT = /^(com\.desk-skills\.supervisor\..+)\.service$/;
function loadedAgents(dir, units) {
  const found = [];
  if (backend() === 'systemd') {
    for (const f of existsSync(units) ? readdirSync(units).sort() : []) {
      const label = UNIT.exec(f)?.[1];
      if (!label || systemctl('is-active', '--quiet', `${label}.timer`).status !== 0) continue;
      const timer = join(units, `${label}.timer`);
      found.push({ label, ...readUnit(readFileSync(join(units, f), 'utf8'), existsSync(timer) ? readFileSync(timer, 'utf8') : '') });
    }
    return found;
  }
  for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (!AGENT.test(f)) continue;
    const p = readPlist(readFileSync(join(dir, f), 'utf8'));
    const label = p.label ?? f.replace(/\.plist$/, '');
    if (spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`]).status !== 0) continue;
    found.push({ ...p, label });
  }
  return found;
}
function reloadAgents(dir, units) {
  const lines = [];
  for (const { label, ...p } of loadedAgents(dir, units)) {
    if (!p.cwd || !existsSync(p.cwd)) { lines.push(`supervisor ${label}: not reloaded, its working directory ${p.cwd ?? '(none)'} is gone`); continue; }
    const env = { ...process.env, ...p.env, PATH: process.env.PATH };
    const r = spawnSync(process.execPath, [join(HERE, 'supervisor.mjs'), 'install', '--reload', ...(p.every ? ['--interval', String(p.every)] : [])], { cwd: p.cwd, env, encoding: 'utf8' });
    lines.push(r.status === 0 ? `supervisor ${label}: rewritten with node ${process.execPath} and reloaded`
      : `supervisor ${label}: could not be reloaded: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').pop()}`);
  }
  return lines;
}

export function restart({ stateRoot = join(E.HOME, '.desk-autopilot'), agents = AGENTS, units = unitDir() } = {}) {
  // A fresh ps for each driver: restarting the one before can take seconds, in which this one wakes.
  const lines = [...runningDrivers(stateRoot).map((d) => restartDriver(d)), ...reloadAgents(agents, units)];
  return lines.length ? lines : ['nothing to restart: no merge driver or supervisor agent is running'];
}

const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  const [cmd, arg, rel] = process.argv.slice(2);
  try {
    if (cmd === 'record' && arg) { const v = record(arg, rel ?? null); console.log(`${v.commit}${v.dirty ? ' (with uncommitted changes)' : ''}${v.dirty === null ? ' (not a git checkout)' : ''}`); }
    else if (cmd === 'version') { const v = readInstalled(); if (v) console.log(v.commit); }
    else if (cmd === 'running') { const v = runningVersion(); if (v) console.log(v); }
    else if (cmd === 'restart') for (const l of restart()) console.log(l);
    else if (cmd === 'prune') for (const l of pruneReleases()) console.log(l);
    else if (cmd === 'rollback') { const r = rollback(); console.log(r.line); if (!r.ok) process.exit(1); }
    else { console.error('usage: installed.mjs record <checkout> [<release dir>] | version | running | restart | prune | rollback'); process.exit(2); }
  } catch (e) { console.error(`installed: ${e.message}`); process.exit(1); }
}
