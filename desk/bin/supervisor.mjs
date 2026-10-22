#!/usr/bin/env node
// The autopilot supervisor: launchd runs a pass in this repo every few minutes while a batch is live,
// keeps the batch's merge driver running, and starts both again at login. No model is in the loop.
// Run it from inside the repo (or with DESK_REPO_DIR set): the repo decides which config applies.
//   node supervisor.mjs install [--interval <s>]   install or update this repo's launchd agent (default 180s)
//   node supervisor.mjs uninstall                  remove it: no further passes run for this repo
//   node supervisor.mjs status                     the agent, whether the batch is handed over, the log's tail
//   node supervisor.mjs tick [--foreground]        one interval; launchd runs this at login and every interval.
//                                                  It starts the work detached and returns; --foreground does it here
//
// A tick acts only on a batch the orchestrator handed over at Stage 4 (`queue.mjs set-batch
// supervised=true`), so a batch still being triaged or planned never gets a pass before Stage 3 asks;
// the log says so once per batch. For a handed-over batch, each tick:
//   - skips, saying so in the log, while a pass holds <state>/orchestrator.lock or the previous tick's
//     run still holds <state>/supervisor.lock;
//   - runs `pass.mjs --json` with only the Stage 3 approvals recorded with the batch: `approved.workers`
//     becomes AUTOPILOT_USER_APPROVED=1, `approved.base_push` AUTOPILOT_BASE_PUSH_APPROVED=1, and either
//     one inherited from the environment is dropped, so the supervisor never grants what it was not given;
//   - appends the report to <state>/supervisor.log;
//   - sends one macOS notification for the pass's `push` entries the last notification did not carry
//     (the check-in digest, a production-broken park, a failing health check), or for a pass that
//     refused or failed;
//   - starts the merge driver (where §3 autopilot-merge and pr-merge-green are both `yes`) while tickets
//     are still to merge and no driver holds <state>/merge-driver.lock.d;
//   - once a pass reports the batch idle, runs no pass and starts no driver until the queue changes:
//     a new batch, or a ticket admitted or requeued into this one.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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
// line names them. An idle batch can still carry parked and failed tickets, named before the finish.
// What a pass says to push now: its `push` items (the check-in digest, a production-broken park), or
// the pass itself failing. Everything else waits for the check-in.
function toPush(v) {
  if (v.status === 'error') {
    const why = `the pass refused or failed: ${String(v.message ?? '').split('\n')[0].slice(0, 120)}`;
    return [{ key: why, text: why }];
  }
  return (Array.isArray(v.push) ? v.push : []).filter((p) => p?.key && p.text);
}

function notify(title, body) {
  const r = spawnSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.error?.message ?? (r.stderr || `osascript exited ${r.status}`).trim());
}

// ---- one interval ----------------------------------------------------------------------------
// launchd runs `tick`, which starts the interval's work detached and returns at once: launchd starts
// no tick while one runs, so a pass still going at the next interval could not otherwise be logged.
function tick() {
  const child = spawn(process.execPath, [join(HERE, 'supervisor.mjs'), 'tick', '--foreground'], { cwd: process.cwd(), env: process.env, detached: true, stdio: 'inherit' });
  child.unref();
}

// The supervisor's own run, held in <state>/supervisor.lock from the pass to the last log line.
const supervisorLock = (state) => join(state, 'supervisor.lock');
function supervisorHolder(state) {
  try {
    const { pid } = JSON.parse(readFileSync(supervisorLock(state), 'utf8'));
    return pid && pid !== process.pid && alive(pid) ? pid : null;
  } catch { return null; }
}

function interval() {
  const state = E.stateDir();
  mkdirSync(state, { recursive: true });
  const logFile = join(state, 'supervisor.log');
  const log = (lines) => appendFileSync(logFile, `${lines.join('\n')}\n`);
  const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (!existsSync(E.queueFile())) return;
  let q;
  try { q = readQueue(E.queueFile()); } catch (e) { log([`== ${stamp()} queue unreadable, no pass run: ${describeCrash(e)}`]); return; }
  const s = readState(state);
  if (q.supervised !== true) {
    // Said once per batch, so a batch never handed over is not mistaken for a supervisor that stopped.
    if (s.unsupervised !== (q.batch ?? null)) {
      log([`== ${stamp()} batch ${q.batch ?? '?'} is not handed over: no pass until Stage 4 runs queue.mjs set-batch supervised=true`]);
      writeState(state, { ...s, unsupervised: q.batch ?? null });
    }
    return;
  }
  if (s.idle && s.idle === fingerprint(q)) { idleCheckin(state, s, log, stamp); return; }
  const holder = orchestratorHolder(state) ?? supervisorHolder(state);
  if (holder) { log([`== ${stamp()} skipped: a pass is still running (pid ${holder})`]); return; }
  try { writeFileSync(supervisorLock(state), JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), { flag: 'wx' }); }
  catch {
    // A dead holder's lock is taken over; a live one started in the moment since the check above.
    if (supervisorHolder(state)) { log([`== ${stamp()} skipped: a pass is still running (pid ${supervisorHolder(state)})`]); return; }
    writeFileSync(supervisorLock(state), JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
  }
  try { runPass(state, q, s, log, stamp); }
  finally { try { if (JSON.parse(readFileSync(supervisorLock(state), 'utf8')).pid === process.pid) rmSync(supervisorLock(state)); } catch { /* gone */ } }
}

// An idle batch runs no pass, but its parked questions still go out at each check-in: the tick runs
// the check-in alone and pushes what it returns, once per key, as a pass's push would be.
function idleCheckin(state, s, log, stamp) {
  const r = spawnSync(process.execPath, [join(HERE, 'digest.mjs'), 'checkin'], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  let d;
  try { d = JSON.parse(String(r.stdout ?? '').trim()); } catch {
    log([`== ${stamp()} idle check-in: failed (${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-2).join(' / ')})`]);
    return;
  }
  if (!d.push?.key || s.notified.includes(d.push.key)) return;
  const err = notify(`desk: ${E.repoSlug()}`, d.push.text);
  log([`== ${stamp()} idle check-in: ${err ? `notification failed (${err}) for ${d.push.key}; the next tick tries again` : `notification sent for ${d.push.key}`}`]);
  if (!err) writeState(state, { ...s, notified: [...s.notified, d.push.key] });
}

function runPass(state, q, s, log, stamp) {
  const slug = E.repoSlug();
  const qf = E.queueFile();

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
  s.idle = null;
  if (v.status !== 'idle') {
    const keys = toMerge(qAfter);
    const driver = driverHolder(state);
    const ungranted = ['autopilot-merge', 'pr-merge-green'].filter((id) => E.permission(id) !== 'yes');
    if (!keys.length) { /* nothing to merge */ }
    else if (driver) out.push(`merge driver: running (pid ${driver})`);
    else if (ungranted.length) out.push(`merge driver: not started, since config §3 ${ungranted.map((id) => `${E.permissionKey(id)} is "${E.permission(id)}"`).join(' and ')}: green PRs wait for you`);
    else {
      // The driver takes in every queue ticket and its holds (held_by) on each loop by itself.
      const tickets = Object.keys(qAfter.tickets ?? {});
      try {
        const child = spawn(join(HERE, 'merge-driver.sh'), ['--tickets', tickets.join(' '), '--log'], { cwd: process.cwd(), env: process.env, detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
        out.push(`merge driver: started (pid ${child.pid}) for ${tickets.join(' ')}; its log is ${join(state, 'merge-driver.log')}`);
      } catch (e) { out.push(`merge driver: could not start: ${e.message}`); }
    }
  }

  // A pass that crashed or hung gave no verdict, and needs the person as much as one that said so.
  const pushes = toPush(v);
  const items = pushes.map((p) => p.key);
  const fresh = pushes.filter((p) => !s.notified.includes(p.key));
  let sent = true;
  if (fresh.length) {
    const err = notify(`desk: ${slug}`, fresh.map((p) => p.text).join(' · '));
    sent = !err;
    out.push(err ? `notification: failed (${err}) for ${fresh.map((p) => p.key).join(', ')}; the next pass tries again` : `notification: sent for ${fresh.map((p) => p.key).join(', ')}`);
  } else if (items.length) out.push(`notification: not sent, the last one already named ${items.join(', ')}`);
  // A failed notification records nothing new, so the next pass sends it again.
  s.notified = sent ? items : s.notified.filter((i) => items.includes(i));
  // Idle is recorded only once its notification is out: until then the next interval passes again.
  if (v.status === 'idle' && sent) {
    s.idle = fingerprint(qAfter);
    out.push(`supervisor: batch ${qAfter.batch ?? '?'} is idle: no pass and no merge driver until a new batch starts or a ticket is added to this one`);
  }
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
  else if (cmd === 'tick') { if (rest.includes('--foreground')) interval(); else tick(); }
  else die('usage: supervisor.mjs install [--interval <s>] | uninstall | status | tick [--foreground]', 2);
} catch (e) { die(describeCrash(e)); }
