#!/usr/bin/env node
// The autopilot supervisor: launchd runs a pass in this repo every few minutes while a batch is live,
// keeps the batch's merge driver running, and starts both again at login. No model is in the loop.
// Run it from inside the repo (or with DESK_REPO_DIR set): the repo decides which config applies.
//   node supervisor.mjs install [--interval <s>]   install or update this repo's launchd agent (default 180s)
//   node supervisor.mjs uninstall                  remove it: no further passes run for this repo
//   node supervisor.mjs status                     the agent, whether the batch is handed over, the log's tail
//   node supervisor.mjs tick                       one interval; launchd runs this at login and every interval
//
// A tick acts only on a batch the orchestrator handed over at Stage 4 (`queue.mjs set-batch
// supervised=true`), so a batch still being triaged or planned never gets a pass before Stage 3 asks.
// For a handed-over batch, each tick:
//   - skips, saying so in the log, while a pass holds <state>/orchestrator.lock;
//   - runs `pass.mjs --json` with only the Stage 3 approvals recorded with the batch: `approved.workers`
//     becomes AUTOPILOT_USER_APPROVED=1, `approved.base_push` AUTOPILOT_BASE_PUSH_APPROVED=1, and either
//     one inherited from the environment is dropped, so the supervisor never grants what it was not given;
//   - appends the report to <state>/supervisor.log;
//   - sends one macOS notification naming the repo and every item when a pass needs the person for an
//     item the last notification did not name (once per new set of items, not once per pass);
//   - starts the merge driver (where §3 autopilot-merge and pr-merge-green are both `yes`) while tickets
//     are still to merge and no driver holds <state>/merge-driver.lock.d;
//   - once a pass reports the batch idle, runs no pass and starts no driver until the queue changes:
//     a new batch, or a ticket admitted or requeued into this one.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { readQueue, describeCrash, isHeld, spinePark } from './batch-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(E.HOME, 'Library', 'LaunchAgents');
const DEFAULT_INTERVAL = 180;
const MIN_INTERVAL = 60;
// A pass takes seconds; one still going after this is hung, and launchd starts no tick while one runs.
const PASS_TIMEOUT_MS = 10 * 60 * 1000;
// Location roots an install passes on to the agent, so the tick reads the same config and scripts.
const PASS_ON = ['DESK_HOME', 'DESK_CONFIG_ROOT'];

const die = (msg, code = 1) => { console.error(`supervisor: ${msg}`); process.exit(code); };
const label = (slug) => `com.desk-skills.supervisor.${slug}`;
const plistPath = (slug) => join(AGENTS, `${label(slug)}.plist`);
const domain = () => `gui/${process.getuid()}`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ---- launchd ---------------------------------------------------------------------------------
const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });
const loaded = (slug) => launchctl('print', `${domain()}/${label(slug)}`).status === 0;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plistValue(v, pad) {
  if (typeof v === 'boolean') return `${pad}<${v}/>`;
  if (typeof v === 'number') return `${pad}<integer>${v}</integer>`;
  if (Array.isArray(v)) return `${pad}<array>\n${v.map((x) => plistValue(x, `${pad}\t`)).join('\n')}\n${pad}</array>`;
  if (v && typeof v === 'object') {
    const rows = Object.entries(v).map(([k, x]) => `${pad}\t<key>${xml(k)}</key>\n${plistValue(x, `${pad}\t`)}`);
    return `${pad}<dict>\n${rows.join('\n')}\n${pad}</dict>`;
  }
  return `${pad}<string>${xml(v)}</string>`;
}
function plist(job) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(job, '')}\n</plist>\n`;
}

function install(interval) {
  const slug = E.repoSlug();
  let root;
  try { root = E.repoRoot(); } catch (e) { die(e.message); }
  if (!existsSync(root)) die(`§2 Primary repo root ${root} does not exist here`);
  const state = E.stateDir();
  mkdirSync(state, { recursive: true });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', DESK_REPO_DIR: root };
  for (const k of PASS_ON) if (process.env[k]) env[k] = process.env[k];
  const job = {
    Label: label(slug),
    ProgramArguments: [process.execPath, join(HERE, 'supervisor.mjs'), 'tick'],
    WorkingDirectory: root,
    EnvironmentVariables: env,
    // At login, then every interval. launchd starts no second tick while one still runs.
    RunAtLoad: true,
    StartInterval: interval,
    StandardOutPath: join(state, 'supervisor.agent.log'),
    StandardErrorPath: join(state, 'supervisor.agent.log'),
    // The tick leaves the merge driver behind it; launchd would otherwise kill it when the tick exits.
    AbandonProcessGroup: true,
  };
  const text = plist(job);
  const file = plistPath(slug);
  if (existsSync(file) && readFileSync(file, 'utf8') === text && loaded(slug)) {
    console.log(`supervisor: ${label(slug)} is already installed and loaded, unchanged (every ${interval}s, log ${join(state, 'supervisor.log')})`);
    return;
  }
  mkdirSync(AGENTS, { recursive: true });
  if (loaded(slug)) launchctl('bootout', `${domain()}/${label(slug)}`);
  writeFileSync(file, text);
  const r = launchctl('bootstrap', domain(), file);
  if (r.status !== 0) die(`launchctl bootstrap ${domain()} ${file} failed: ${(r.stderr || r.stdout || '').trim()}`);
  console.log(`supervisor: installed ${label(slug)}: a pass every ${interval}s and at login for a batch handed over at Stage 4 (queue.mjs set-batch supervised=true); log ${join(state, 'supervisor.log')}`);
}

function uninstall() {
  const slug = E.repoSlug();
  const file = plistPath(slug);
  const was = loaded(slug);
  if (was) {
    const r = launchctl('bootout', `${domain()}/${label(slug)}`);
    if (r.status !== 0) die(`launchctl bootout ${domain()}/${label(slug)} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  const had = existsSync(file);
  rmSync(file, { force: true });
  console.log(was || had
    ? `supervisor: removed ${label(slug)}: no further passes run for this repo. A merge driver it started keeps running until it is stopped`
    : `supervisor: ${label(slug)} was not installed`);
}

// ---- state -----------------------------------------------------------------------------------
// <state>/supervisor.json: the queue fingerprint a pass reported idle, and the items last notified.
const stateFile = (state) => join(state, 'supervisor.json');
function readState(state) {
  try { return { idle: null, notified: [], ...JSON.parse(readFileSync(stateFile(state), 'utf8')) }; } catch { return { idle: null, notified: [] }; }
}
const writeState = (state, s) => writeFileSync(stateFile(state), `${JSON.stringify(s, null, 2)}\n`);

// What makes a batch the same batch: its name and every ticket's state. A new batch, or a ticket
// admitted or requeued into an idle one, changes it.
function fingerprint(q) {
  const rows = Object.values(q.tickets ?? {}).map((t) => `${t.key}=${t.state}`).sort();
  return createHash('sha1').update(JSON.stringify([q.batch ?? null, rows])).digest('hex');
}

// The pid holding a lock, or null. A merge-driver lock with no pid yet is a driver starting up.
function orchestratorHolder(state) {
  try {
    const { pid } = JSON.parse(readFileSync(join(state, 'orchestrator.lock'), 'utf8'));
    return pid && alive(pid) ? pid : null;
  } catch { return null; }
}
function driverHolder(state) {
  const d = join(state, 'merge-driver.lock.d');
  if (!existsSync(d)) return null;
  const pid = Number((() => { try { return readFileSync(join(d, 'pid'), 'utf8').trim(); } catch { return ''; } })());
  if (pid) return alive(pid) ? pid : null;
  try { return Date.now() - statSync(d).mtimeMs < 60_000 ? 'starting' : null; } catch { return null; }
}

// Tickets whose PR is still to merge: one still to start or running, one held behind a merge or a
// spine, or one done with a PR that is neither merged nor closed. A failed ticket merges nothing.
function toMerge(q) {
  const rows = Object.values(q.tickets ?? {});
  const pending = rows.filter((t) => ['queued', 'triaged', 'running'].includes(t.state) || isHeld(t) || spinePark(t));
  if (pending.length) return pending.map((t) => t.key);
  let repo = null;
  try { repo = E.ghRepo(); } catch { /* unknown: every PR counts as open */ }
  return rows.filter((t) => t.state === 'done' && t.result?.pr != null).filter((t) => {
    if (!repo) return true;
    const r = spawnSync('gh', ['pr', 'view', String(t.result.pr), '--repo', repo, '--json', 'state', '--jq', '.state'], { encoding: 'utf8' });
    return !(r.status === 0 && ['MERGED', 'CLOSED'].includes(r.stdout.trim()));
  }).map((t) => t.key);
}

// What a pass's verdict says needs the person, one item per ticket or entry, as pass.mjs's NOTIFY
// line names them.
function needsYou(v) {
  if (v.status === 'idle') return ['the batch is finished'];
  if (v.status === 'error') return [`the pass refused or failed: ${String(v.message ?? '').split('\n')[0].slice(0, 120)}`];
  const keys = [...(v.parked ?? []).map((p) => p.key), ...(v.waiting ?? []).map((x) => String(x).split(':')[0])];
  return [...new Set(keys)];
}

function notify(title, body) {
  const r = spawnSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.error?.message ?? (r.stderr || `osascript exited ${r.status}`).trim());
}

// ---- one interval ----------------------------------------------------------------------------
function tick() {
  const slug = E.repoSlug();
  const state = E.stateDir();
  const qf = E.queueFile();
  mkdirSync(state, { recursive: true });
  const logFile = join(state, 'supervisor.log');
  const log = (lines) => appendFileSync(logFile, `${lines.join('\n')}\n`);
  const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (!existsSync(qf)) return;
  let q;
  try { q = readQueue(qf); } catch (e) { log([`== ${stamp()} queue unreadable, no pass run: ${describeCrash(e)}`]); return; }
  if (q.supervised !== true) return;
  const s = readState(state);
  if (s.idle && s.idle === fingerprint(q)) return;
  const holder = orchestratorHolder(state);
  if (holder) { log([`== ${stamp()} skipped: a pass is still running (pid ${holder})`]); return; }

  const env = { ...process.env };
  delete env.AUTOPILOT_USER_APPROVED;
  delete env.AUTOPILOT_BASE_PUSH_APPROVED;
  const given = [];
  if (q.approved?.workers === true) { env.AUTOPILOT_USER_APPROVED = '1'; given.push('workers'); }
  if (q.approved?.base_push === true) { env.AUTOPILOT_BASE_PUSH_APPROVED = '1'; given.push('base push'); }
  const r = spawnSync(process.execPath, [join(HERE, 'pass.mjs'), '--json'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: PASS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  let v;
  try { v = JSON.parse(String(r.stdout ?? '').trim()); }
  catch {
    const why = r.error?.code === 'ETIMEDOUT' ? `timed out after ${PASS_TIMEOUT_MS / 60000} minutes` : `exited ${r.status ?? r.signal} without a verdict`;
    v = { status: 'error', code: r.status, message: `pass.mjs ${why}: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-5).join(' / ')}` };
  }
  const out = [`== ${stamp()} pass: exit ${r.status ?? r.signal} (${v.status}); approvals passed on: ${given.join(', ') || 'none'}`, String(v.message ?? '').trimEnd()];

  let qAfter = q;
  try { qAfter = readQueue(qf); } catch { /* the pass reported it */ }
  if (v.status === 'idle') {
    s.idle = fingerprint(qAfter);
    out.push(`supervisor: batch ${qAfter.batch ?? '?'} is idle: no pass and no merge driver until a new batch starts or a ticket is added to this one`);
  } else {
    s.idle = null;
    const keys = toMerge(qAfter);
    const driver = driverHolder(state);
    const ungranted = ['autopilot-merge', 'pr-merge-green'].filter((id) => E.permission(id) !== 'yes');
    if (!keys.length) { /* nothing to merge */ }
    else if (driver) out.push(`merge driver: running (pid ${driver})`);
    else if (ungranted.length) out.push(`merge driver: not started, since config §3 ${ungranted.map((id) => `${E.permissionKey(id)} is "${E.permission(id)}"`).join(' and ')}: green PRs wait for you`);
    else {
      const tickets = Object.keys(qAfter.tickets ?? {});
      const deps = Object.values(qAfter.tickets ?? {}).filter((t) => isHeld(t) && t.held_by)
        .map((t) => `${t.key}:${String(t.held_by).split('|').filter(Boolean).join(',')}`);
      const args = ['--tickets', tickets.join(' '), ...(deps.length ? ['--deps', deps.join(' ')] : []), '--log'];
      try {
        const child = spawn(join(HERE, 'merge-driver.sh'), args, { cwd: process.cwd(), env: process.env, detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
        out.push(`merge driver: started (pid ${child.pid}) for ${tickets.join(' ')}${deps.length ? ` with deps ${deps.join(' ')}` : ''}; its log is ${join(state, 'merge-driver.log')}`);
      } catch (e) { out.push(`merge driver: could not start: ${e.message}`); }
    }
  }

  // A pass that crashed or hung gave no verdict, and needs the person as much as one that said so.
  const items = r.status === 11 || v.notify === true || v.status === 'error' ? needsYou(v) : [];
  const fresh = items.filter((i) => !s.notified.includes(i));
  if (fresh.length) {
    const err = notify(`desk: ${slug}`, `${items.length} item(s) need you: ${items.join(', ')}`);
    out.push(err ? `notification: failed (${err}) for ${items.join(', ')}` : `notification: sent for ${items.join(', ')}`);
  } else if (items.length) out.push(`notification: not sent, the last one already named ${items.join(', ')}`);
  s.notified = items;
  writeState(state, s);
  log(out);
}

function status() {
  const slug = E.repoSlug();
  const file = plistPath(slug);
  const interval = existsSync(file) ? (/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(readFileSync(file, 'utf8'))?.[1] ?? '?') : null;
  console.log(`agent: ${label(slug)} ${interval ? `installed (every ${interval}s), ${loaded(slug) ? 'loaded' : 'not loaded'}` : 'not installed (supervisor.mjs install)'}`);
  const state = E.stateDir();
  const qf = E.queueFile();
  let batch = 'no batch';
  if (existsSync(qf)) {
    try {
      const q = readQueue(qf);
      const s = readState(state);
      batch = `batch ${q.batch ?? '?'}: ${q.supervised !== true ? 'not handed over (queue.mjs set-batch supervised=true at Stage 4)'
        : s.idle === fingerprint(q) ? 'idle, nothing runs until a new batch starts' : 'handed over'}`;
    } catch (e) { batch = `queue unreadable: ${describeCrash(e)}`; }
  }
  console.log(batch);
  const logFile = join(state, 'supervisor.log');
  if (existsSync(logFile)) {
    console.log(`log: ${logFile}, last lines:`);
    for (const l of readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-10)) console.log(`  ${l}`);
  }
  process.exitCode = interval && loaded(slug) ? 0 : 1;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'install') {
    const i = rest.indexOf('--interval');
    const n = i < 0 ? DEFAULT_INTERVAL : Number(rest[i + 1]);
    if (!Number.isInteger(n) || n < MIN_INTERVAL) die(`--interval wants whole seconds, at least ${MIN_INTERVAL}`, 2);
    install(n);
  } else if (cmd === 'uninstall') uninstall();
  else if (cmd === 'status') status();
  else if (cmd === 'tick') tick();
  else die('usage: supervisor.mjs install [--interval <s>] | uninstall | status | tick', 2);
} catch (e) { die(describeCrash(e)); }
