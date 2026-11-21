#!/usr/bin/env node
// The autopilot supervisor: launchd on macOS, or a systemd user timer on Linux, runs a pass in this
// repo every few minutes while a batch is live, and within seconds of a worker exiting (its exit file in
// <repo state>/exits wakes a tick), keeps the batch's merge driver running, and starts both again at
// login. No model is in the loop.
// Run it from inside the repo (or with DESK_REPO_DIR set): the repo decides which config applies.
//   node supervisor.mjs install [--interval <s>] [--reload]
//                                                  install or update this repo's launchd agent, or its
//                                                  systemd service, timer and path unit (default 180s); --reload
//                                                  reloads it even when unchanged
//   node supervisor.mjs uninstall                  remove it: no further passes run for this repo
//   node supervisor.mjs status                     the agent, then each batch: whether it is handed over, its log's tail
//   node supervisor.mjs tick [--foreground]        one interval; launchd or systemd runs this at login and every interval.
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
//   - sends one desktop notification (notify.mjs) for the pass's `push` entries the last notification did not carry
//     (the check-in digest, a production-broken park, a failing health check), or for a pass that
//     refused or failed;
//   - starts the merge driver (where §3 autopilot-merge and pr-merge-green are both `yes`, or the batch's
//     `approved.merge` is true where they are `yes` or `ask`: the driver reads it itself) while tickets
//     are still to merge and no driver holds <state>/merge-driver.lock.d, its output in
//     <state>/merge-driver.log. A running driver logs nothing; once the one it started has stopped, the
//     next tick logs why from that log (and keeps it in supervisor.json), and after 2 failed starts in a
//     row sends one notification naming the repo and the reason;
//   - when a pass exits needing the person, hands what the recovery rules never settle to the check-in
//     digest and starts one headless decider session (decider.mjs) for the rest, unless one is still
//     running; each tick stops a decider past its time, and records what an ended one cost, settled
//     and handed on, in the log and the batch notes;
//   - first, where config §3b "Intake query" names a query, runs standing intake (intake.mjs) at most
//     every 15 minutes: it admits the new tickets a worker can take, starting a batch handed over at
//     once if none is live, and its lines go into the tick's report, after those of any ticket a
//     producer pushed since the last tick (intake.mjs push, which starts a tick at once);
//   - once a pass reports the batch idle, runs no pass and starts no driver until the queue changes
//     (a new batch, or a ticket admitted or requeued into this one), a park is answered (answer.mjs),
//     or, with anything parked, failed or held behind a blocker in no batch (held_outside), or a PR
//     no ticket owns recorded (ticketless_prs, which only a pass drops once the PR is merged or closed),
//     DESK_IDLE_RECHECK_MS (30 minutes) has passed since the batch went idle, so a pass sees what
//     cleared a park, or landed a blocker, outside the queue; DESK_RUN_RECHECK_MS (2 minutes) while a
//     park a pass settles waits on an Actions run or a PR's checks. Each idle tick refreshes the
//     batch's heartbeat (so desk-q and needs-you read it as run, not stopped), and still runs the
//     check-in (killed past 5 minutes, DESK_CHECKIN_TIMEOUT_MS) and moves the weekly maintenance
//     window and the auto-release on (maintenance.mjs step), pushing what the step pushes.
// Each tick also keeps `code` in supervisor.json: the installed version (installed.mjs), and whether
// this agent and the running merge driver started at an older one (`old_code`). It records what that
// tick saw; desk-q judges old code for itself, from the loaded agent's plist and the driver's lock.
// For a handed-over batch, a driver on old code that waits between loops is restarted on the installed
// code with the same tickets and deps (installed.mjs restartDriver); one mid-loop is left, logged once,
// and none is moved while a pass runs (it holds supervisor.lock for the restart).
//
// A worker's exit wakes a tick too: spawn-worker.sh renames <KEY>.<ts>.json into <repo state>/exits,
// which launchd watches (WatchPaths, at most one tick per 20s) or a systemd path unit does. A tick
// deletes the exit files its passes have seen, runs another round when exits landed while one ran, and
// runs nothing when it finds none within a minute of deleting some, since that deletion woke it. One
// tick at a time runs woken rounds (supervisor.tick.lock), each at least 20s after the last, and a
// round's passes count a quiet pass only once an interval has passed since the last that did.
//
// After intake, each tick runs repo-templates.mjs check, which at most hourly records in the standing
// batch's templates.json which of the repo's committed copies of desk's templates are behind them.
// After every batch, each tick refreshes the machine-wide Levers page (levers-refresh.mjs).
// A tick runs intake once, then every batch the repo holds (batches.mjs listBatches), one after another:
// the standing batch, then each named batch. Each runs as above in its own state folder, with its own
// merge driver and notifications titled with the repo and the batch, and with DESK_BATCH naming it and
// DESK_DEFAULT_BRANCH removed, so its pass and driver read its own base. One batch that fails leaves
// the rest to run. A named batch whose epic's plan has been answered in /desk-needs-you is acted on
// before its pass (epic-plan.mjs actOnPlan): started, started with the edit applied, asked again
// naming what could not be applied, or discarded. Each named batch first gets its archive check (batch.mjs archiveCheck): once its
// last promotion PR is merged, or its promotion PR closed, with no ticket running and no ticket PR open, it is moved under
// batches/.done/, logged in the standing batch's log, and not run. A merge driver still running for such
// a batch is stopped first, and the batch is not run until a later tick archives it. An explicit DESK_BATCH, DESK_QUEUE or
// DESK_AUTOPILOT_STATE names one batch, and a tick runs only that one, with no archive check.
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, rmSync, renameSync, statSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { readQueue, describeCrash, isHeld, spinePark, IDLE_RECHECK_MS, RUN_RECHECK_MS, waitingOnRun } from './batch-state.mjs';
import { listBatches, batchPinned, alive, orchestratorHolder } from './batches.mjs';
import { tryLockFile, unlockFile } from './dir-lock.mjs';
import { archiveCheck } from './batch.mjs';
import { intakeQuery, prOpen, handedByIntake, takePushed } from './intake.mjs';
import { actOnPlan } from './epic-plan.mjs';
import { readCloseouts } from './closeout.mjs';
import { postMergeDue } from './post-merge.mjs';
import { readInstalled, oldCode, lockVersion, AGENTS, plistPath, unitDir, unitPath, readUnit, restartDriver } from './installed.mjs';
import { supervisorLabel, launchdDomain, supervisorLoaded, backend, systemctl } from './run-by.mjs';
import { notify as show } from './notify.mjs';
import { limitName, resetText } from './usage-limit.mjs';
import { lastBeat, writeBeat } from './borrow.mjs';
import { DECIDER_TIMEOUT_MS, deciderItems, presort, freshItems, handItems, pruneHanded, readHanded, dropHanded, answered, startDecider, readResult, outcome, reportLine, noteOutcome, runningBatches, restateKeys, baseSyncLine } from './decider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INTERVAL = 180;
const MIN_INTERVAL = 60;
// A pass takes seconds; one still going after this is hung, and launchd or systemd starts no tick while one runs.
const PASS_TIMEOUT_MS = 10 * 60 * 1000;
// Location roots an install passes on to the agent, so the tick reads the same config and scripts.
const PASS_ON = ['DESK_HOME', 'DESK_CONFIG_ROOT'];
// A worker's exit wakes a tick: spawn-worker.sh renames <KEY>.<ts>.json into the repo's exits folder,
// whichever batch the worker is in, and launchd starts a tick at most once per WAKE_THROTTLE_S.
const WAKE_THROTTLE_S = 20;
// The tick's own deletion of the exit files it consumed wakes it again: a tick that finds none this soon
// after one deleted some runs nothing.
const WAKE_QUIET_MS = 60 * 1000;
// Exits that land while a tick's passes run get another round of passes, up to this many in all.
const WAKE_ROUNDS = 3;
// A round starts at least this long after the one before it, on either backend, so the exits of one
// burst fold into one more round however short a pass is (the tests shorten it).
const WAKE_GAP_MS = Number(process.env.DESK_WAKE_GAP_MS) >= 0 && process.env.DESK_WAKE_GAP_MS ? Number(process.env.DESK_WAKE_GAP_MS) : WAKE_THROTTLE_S * 1000;
const exitsDir = E.exitsDir;
const repoFile = (name) => join(E.repoStateOf(E.stateDir()), name);
const wakeFile = () => repoFile('supervisor.wake');
const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const die = (msg, code = 1) => { console.error(`supervisor: ${msg}`); process.exit(code); };
const label = supervisorLabel;
const domain = launchdDomain;

// ---- launchd ---------------------------------------------------------------------------------
const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });
const loaded = supervisorLoaded;
// The installed agent's interval in seconds: '?' for a plist or timer without one, null when not installed.
function installedInterval(slug) {
  if (backend() === 'systemd') {
    if (!existsSync(unitPath(slug, 'service')) || !existsSync(unitPath(slug, 'timer'))) return null;
    return String(readUnit('', readFileSync(unitPath(slug, 'timer'), 'utf8')).every ?? '?');
  }
  return existsSync(plistPath(slug))
    ? (/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(readFileSync(plistPath(slug), 'utf8'))?.[1] ?? '?') : null;
}

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

// ---- systemd -----------------------------------------------------------------------------------
// A value inside a unit's double quotes: systemd reads C escapes there and % as a specifier.
const unitQuote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
// The service runs one tick; the timer runs it at once when started (at install and at login) and an
// interval after each run, the path unit whenever an entry in the exits folder changes, and systemd
// starts no second run while one is still active.
function units(slug, job) {
  const service = ['[Unit]', `Description=desk-skills supervisor for ${slug}`, '', '[Service]', 'Type=oneshot',
    `ExecStart=${[process.execPath, job.script].map(unitQuote).join(' ')} tick`,
    `WorkingDirectory=${job.cwd.replace(/%/g, '%%')}`,
    ...Object.entries(job.env).map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`)}`),
    `StandardOutput=append:${job.log.replace(/%/g, '%%')}`, `StandardError=append:${job.log.replace(/%/g, '%%')}`,
    // The tick leaves the merge driver behind it; systemd would otherwise kill it when the tick exits.
    'KillMode=process', ''].join('\n');
  const timer = ['[Unit]', `Description=desk-skills supervisor for ${slug}, every ${job.interval}s`, '', '[Timer]',
    'OnActiveSec=0', `OnUnitActiveSec=${job.interval}s`, 'AccuracySec=1s', '', '[Install]', 'WantedBy=timers.target', ''].join('\n');
  const path = ['[Unit]', `Description=desk-skills supervisor for ${slug}, on a worker's exit`, '', '[Path]',
    `PathChanged=${job.exits.replace(/%/g, '%%')}`, `Unit=${label(slug)}.service`, '', '[Install]', 'WantedBy=paths.target', ''].join('\n');
  return { service, timer, path };
}
const sysFail = (what, r) => die(`systemctl --user ${what} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`);
// Without lingering, systemd stops a user's timers once their last session ends. On WSL that is not
// enough: WSL stops the whole distro once the last process started from Windows exits, and no systemd
// unit, lingering or not, keeps it up, so install says so there whatever lingering is.
function lingerNote() {
  const r = spawnSync('loginctl', ['show-user', String(process.env.USER || process.getuid()), '-p', 'Linger'], { encoding: 'utf8' });
  const linger = /^Linger=no$/m.test(r.stdout ?? '') ? ' Lingering is off, so ticks stop once you log out; `loginctl enable-linger` keeps them running.' : '';
  const wsl = E.isWSL() ? ' On WSL, ticks run only while WSL is up, and lingering does not keep it up: WSL stops once every terminal closes. Keep a terminal open, or add a Windows Task Scheduler entry at logon that runs `wsl.exe --exec sleep infinity` (with `-d <distro>` if this is not your default distro), with "Stop the task if it runs longer than 3 days" turned off.' : '';
  return linger + wsl;
}

function installSystemd(slug, job, reload) {
  const text = units(slug, job);
  const names = [`${label(slug)}.timer`, `${label(slug)}.path`];
  const same = ['service', 'timer', 'path'].every((k) => existsSync(unitPath(slug, k)) && readFileSync(unitPath(slug, k), 'utf8') === text[k]);
  if (!reload && same && loaded(slug)) {
    console.log(`supervisor: ${label(slug)} is already installed and loaded, unchanged (every ${job.interval}s, log ${join(job.state, 'supervisor.log')})`);
    return;
  }
  mkdirSync(unitDir(), { recursive: true });
  for (const k of ['service', 'timer', 'path']) writeFileSync(unitPath(slug, k), text[k]);
  let r = systemctl('daemon-reload');
  if (r.status !== 0) sysFail('daemon-reload', r);
  const was = loaded(slug);
  r = was ? systemctl('restart', ...names) : systemctl('enable', '--now', ...names);
  if (r.status !== 0) sysFail(`${was ? 'restart' : 'enable --now'} ${names.join(' ')}`, r);
  // `enable` covers the next login; a unit restarted while loaded may still be disabled.
  if (was) systemctl('enable', ...names);
  console.log(`supervisor: installed ${label(slug)}: a pass every ${job.interval}s and at login for a batch handed over at Stage 4 (queue.mjs set-batch supervised=true); log ${join(job.state, 'supervisor.log')}.${lingerNote()}`);
}

function install(interval, reload = false) {
  const slug = E.repoSlug();
  if (!backend()) die('the supervisor needs macOS launchd or Linux systemd, so it cannot run on this computer');
  let root;
  try { root = E.repoRoot(); } catch (e) { die(e.message); }
  if (!existsSync(root)) die(`§2 Primary repo root ${root} does not exist here`);
  const state = E.stateDir();
  mkdirSync(state, { recursive: true });
  const exits = exitsDir();
  // launchd and systemd both watch a folder that is not there yet; it only means no worker exit wakes a tick.
  try { mkdirSync(exits, { recursive: true }); } catch { /* the interval still runs every tick */ }
  const env ={ PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', DESK_REPO_DIR: root };
  for (const k of PASS_ON) if (process.env[k]) env[k] = process.env[k];
  // The desk version the agent was loaded at, so a tick can tell its plist or service predates the install.
  const version = readInstalled()?.commit;
  if (version) env.DESK_AGENT_VERSION = version;
  // Loaded from a release folder, the agent runs through ~/.claude/desk/bin, so each tick loads the
  // release current then and never one an install has since pruned.
  const dir = E.runBin() === HERE ? E.binDir() : HERE;
  if (backend() === 'systemd') {
    installSystemd(slug, { script: join(dir, 'supervisor.mjs'), cwd: root, env, interval, state, exits, log: join(state, 'supervisor.agent.log') }, reload);
    return;
  }
  const job = {
    Label: label(slug),
    ProgramArguments: [process.execPath, join(dir, 'supervisor.mjs'), 'tick'],
    WorkingDirectory: root,
    EnvironmentVariables: env,
    // At login, then every interval, and whenever a worker's exit file lands in the exits folder, at
    // most once per ThrottleInterval. launchd starts no second tick while one still runs.
    RunAtLoad: true,
    StartInterval: interval,
    WatchPaths: [exits],
    ThrottleInterval: WAKE_THROTTLE_S,
    StandardOutPath: join(state, 'supervisor.agent.log'),
    StandardErrorPath: join(state, 'supervisor.agent.log'),
    // The tick leaves the merge driver behind it; launchd would otherwise kill it when the tick exits.
    AbandonProcessGroup: true,
  };
  const text = plist(job);
  const file = plistPath(slug);
  if (!reload && existsSync(file) && readFileSync(file, 'utf8') === text && loaded(slug)) {
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
  if (backend() === 'systemd') {
    const names = [`${label(slug)}.timer`, `${label(slug)}.path`];
    const was = loaded(slug);
    if (was) {
      const r = systemctl('disable', '--now', ...names);
      if (r.status !== 0) sysFail(`disable --now ${names.join(' ')}`, r);
    }
    const kinds = ['service', 'timer', 'path'];
    const had = kinds.some((k) => existsSync(unitPath(slug, k)));
    for (const k of kinds) rmSync(unitPath(slug, k), { force: true });
    if (had) systemctl('daemon-reload');
    console.log(was || had
      ? `supervisor: removed ${label(slug)}: no further passes run for this repo. A merge driver it started keeps running until it is stopped`
      : `supervisor: ${label(slug)} was not installed`);
    return;
  }
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

// Whether the batch records a PR no ticket owns (pass/ticketless-prs.mjs), which keeps its idle rechecking.
const ticketlessHeld = (q) => Array.isArray(q.ticketless_prs) && q.ticketless_prs.length > 0;

// What makes a batch the same batch: its name and every ticket's state. A new batch, or a ticket
// admitted or requeued into an idle one, changes it.
function fingerprint(q) {
  const rows = Object.values(q.tickets ?? {}).map((t) => `${t.key}=${t.state}`).sort();
  return createHash('sha1').update(JSON.stringify([q.batch ?? null, rows])).digest('hex');
}

// The pid holding the merge-driver lock, or null. A lock with no pid yet is a driver starting up.
const driverHolder = E.mergeDriverHolder;

// What runs old desk code: this agent, by the version its plist was loaded at, and the running merge
// driver, by the version it wrote into its lock, each against the installed version. A version not
// recorded predates recording it, so it counts as old once an installed version is known.
function codeRecord(state) {
  const installed = readInstalled();
  const agent = process.env.DESK_AGENT_VERSION || null;
  const pid = driverHolder(state);
  let driver = null;
  if (typeof pid === 'number') {
    const version = lockVersion(state);
    driver = { pid, version, old_code: oldCode(version, installed) };
  }
  return { installed: installed?.commit ?? null, supervisor: { version: agent, old_code: oldCode(agent, installed) }, driver };
}
// supervisor.json's `code`, written only when it moved.
function noteCode(state) {
  const s = readState(state);
  const code = codeRecord(state);
  if (JSON.stringify(s.code ?? null) !== JSON.stringify(code)) writeState(state, { ...s, code });
}

// A running merge driver on old code is restarted on the installed one once it waits between loops,
// as install.sh's restart does (installed.mjs restartDriver); one mid-loop is left for a later tick.
// -> the line to log, or null. A driver left for the same reason as last tick is not logged again.
function moveDriver(state, s) {
  const pid = driverHolder(state);
  if (typeof pid !== 'number' || !oldCode(lockVersion(state))) {
    if (s.driver_left) { delete s.driver_left; writeState(state, s); }
    return null;
  }
  // A pass running now reads the driver, and its own copy of supervisor.json would undo this one's.
  const busy = takeLock(state);
  if (busy) return null;
  const from = logSize(driverLog(state));
  let line;
  try { line = restartDriver({ slug: E.repoSlug(), batch: E.batchName(), dir: state, pid, queue: E.queueFile() }); }
  finally { dropLock(state); }
  const now = driverHolder(state);
  if (now !== pid) {
    // The driver this supervisor started carries on under its new pid, so its stop is still read, from
    // where the new one's output starts.
    if (s.driver?.pid === pid && typeof now === 'number') Object.assign(s.driver, { pid: now, started: new Date().toISOString(), from });
    delete s.driver_left;
    s.code = codeRecord(state);
    writeState(state, s);
    return line;
  }
  if (s.driver_left === line) return null;
  s.driver_left = line;
  writeState(state, s);
  return line;
}

// Tickets whose PR is still to merge: one still to start or running, one held behind a merge or a
// spine, or one done with a PR that is neither merged nor closed. A failed ticket merges nothing.
function toMerge(q) {
  const rows = Object.values(q.tickets ?? {});
  const pending = rows.filter((t) => ['queued', 'triaged', 'running'].includes(t.state) || isHeld(t) || spinePark(t));
  if (pending.length) return pending.map((t) => t.key);
  return rows.filter((t) => t.state === 'done' && t.result?.pr != null && prOpen(t.result.pr)).map((t) => t.key);
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

// One notification: -> { err, said }. `err` is why it failed, so the next tick tries again; `said` is
// what the log says went out. A computer with no notifier that works shows none and the log is the
// record, so that counts as told: retrying could never succeed, and a batch is recorded idle only once
// it is told.
function notify(title, body) {
  const n = show(title, body);
  if (!n.via) return { err: null, said: `none shown, no notifier here could show one (${n.error})` };
  return { err: n.error, said: 'sent' };
}
// A notification's title names the repo, and the batch where it is a named one.
const title = () => `desk: ${E.repoSlug()}${E.batchName() ? ` ${E.batchName()}` : ''}`;

// ---- one interval ----------------------------------------------------------------------------
// launchd or systemd runs `tick`, which starts the interval's work detached and returns at once: neither
// starts a tick while one runs, so a pass still going at the next interval could not otherwise be logged.
function tick() {
  const child = spawn(process.execPath, [join(HERE, 'supervisor.mjs'), 'tick', '--foreground'], { cwd: process.cwd(), env: process.env, detached: true, stdio: 'inherit' });
  child.unref();
}

// The supervisor's own run, held in <state>/supervisor.lock from the pass to the last log line.
const supervisorLock = (state) => join(state, 'supervisor.lock');

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
// A log past LOG_ROTATE_BYTES moves to <log>.1 before the next write, the older copies shift up one,
// and only LOG_ROTATE_KEEP are kept. The merge driver rotates its own log the same way.
const LOG_ROTATE_BYTES = Number(process.env.DESK_LOG_ROTATE_BYTES) || 10 * 1024 * 1024;
const LOG_ROTATE_KEEP = 3;
function rotateLog(file) {
  if (logSize(file) <= LOG_ROTATE_BYTES) return;
  rmSync(`${file}.${LOG_ROTATE_KEEP}`, { force: true });
  for (let i = LOG_ROTATE_KEEP - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  renameSync(file, `${file}.1`);
}
const logTo = (state) => (lines) => {
  const file = join(state, 'supervisor.log');
  try { rotateLog(file); } catch { /* the line is still written, to the unrotated log */ }
  appendFileSync(file, `${lines.join('\n')}\n`);
};

// What this tick has run once already for all its batches.
const ranOnce = new Set();
const firstTime = (what) => !ranOnce.has(what) && ranOnce.add(what);
// Every batch's state folder this tick runs, and the push keys it has sent for any of them.
let tickStates = [];
const sentThisTick = new Set();
// Whether another batch has sent `key`: the repo's own pushes reach every batch, and go out once. Any
// key sent this tick counts. From another batch's stored list only a key that names what it is about
// counts, since it never comes back: the check-in digest (its slot) and main's failed release (its
// commit). An idle batch's stored keys never change, and would silence a repeat of any other.
const ONCE_EVER = ['digest:', 'release-failed-'];
const sentElsewhere = (state, key) => sentThisTick.has(key)
  || (ONCE_EVER.some((p) => key.startsWith(p)) && tickStates.some((d) => d !== state && readState(d).notified.includes(key)));

// Points this process, and every child it starts, at batch `name` (null for the standing batch).
function enterBatch(name) {
  delete process.env.DESK_DEFAULT_BRANCH;
  if (name) process.env.DESK_BATCH = name;
  else delete process.env.DESK_BATCH;
}

// -> [{ name, queue, state }]: the one batch named explicitly, else every batch the repo holds, the
// standing first.
const tickBatches = (named = batchPinned()) => (named ? [{ name: E.batchName(), queue: E.queueFile(), state: E.stateDir() }] : listBatches());

// The exit files workers left in `dir`, as [{ file, at }] with `at` their mtime. A dot-named file is one
// still being written, before its rename.
function exitFiles(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => !n.startsWith('.') && n.endsWith('.json')).flatMap((n) => {
    try { return [{ file: join(dir, n), at: statSync(join(dir, n)).mtimeMs }]; } catch { return []; }
  });
}
// <repo state>/supervisor.wake, { consumed, round, counted }: when a tick last deleted exit files, last
// started a round, and last started one whose passes counted a quiet pass. Unreadable reads as never.
const readWake = () => { try { return JSON.parse(readFileSync(wakeFile(), 'utf8')) ?? {}; } catch { return {}; } };
const wakeAt = (k) => Date.parse(readWake()[k] ?? '') || 0;
const noteWake = (k, ms) => { try { writeFileSync(wakeFile(), `${JSON.stringify({ ...readWake(), [k]: new Date(ms).toISOString() })}\n`); } catch { /* the next tick runs as if never */ } };
// Deletes the exit files a round of passes has seen, and records when, so the wake that deletion causes
// runs nothing. A file that cannot be deleted stays and wakes nothing again.
function consumeExits(files) {
  let gone = 0;
  for (const f of files) { try { rmSync(f.file); gone += 1; } catch { /* left for the next tick */ } }
  if (gone) noteWake('consumed', Date.now());
}
// A round's passes count a quiet pass once an interval has passed since the last round that did, whatever
// started it, so exits never bring a quiet worker's wedge limit sooner, nor an exit file left behind
// stop it coming. The slack covers a tick starting a moment early.
const COUNT_SLACK_MS = 5000;
const countDueMs = () => (Number(installedInterval(E.repoSlug())) || DEFAULT_INTERVAL) * 1000 - COUNT_SLACK_MS;

// The repo's tick lock: one tick at a time runs rounds for exits. -> whether this process holds it.
const TICK_LOCK_WAIT_MS = 30 * 60 * 1000;
const tickLock = () => repoFile('supervisor.tick.lock');
function takeTickLock(wait) {
  const until = Date.now() + TICK_LOCK_WAIT_MS;
  for (;;) {
    let got;
    try { got = tryLockFile(tickLock()); } catch { return false; }
    if (got === true) return true;
    if (!wait || Date.now() > until) return false;
    sleep(1000);
  }
}
// Whether this round runs between intervals (an exit woke it), before its quiet pass is due: pass.mjs
// --woken then counts no quiet pass.
let wokenRound = false;
// Whether this round ran a pass for any batch: only a round that did has counted its quiet pass.
let passedRound = false;

// One tick: a round of every batch, and another while workers exited after the last round started and
// before it ended, so their exits are not left for the next interval. A round whose pass was skipped for
// a lock consumes nothing: the run holding it sees the exits when its own round ends. A tick woken by an
// exit while another tick runs rounds waits for it, then runs only for exits that one left. Every woken
// round starts WAKE_GAP_MS after the last round any tick started, so a burst runs at most two.
function interval() {
  const exits = exitsDir();
  const woken = exitFiles(exits).length > 0;
  if (!woken && Date.now() - wakeAt('consumed') < WAKE_QUIET_MS) return;
  // An interval's tick that finds the lock held runs as it always has; it takes the lock when free, so a
  // woken tick waits for its round.
  const held = takeTickLock(woken);
  if (woken && !held) return;
  try {
    if (woken) sleep(wakeAt('round') + WAKE_GAP_MS - Date.now());
    if (woken && !exitFiles(exits).length) return;
    // Pinned once: a round enters each batch in turn, which would read as a pin to the next round.
    const named = batchPinned();
    for (let round = 1; ; round += 1) {
      const start = Date.now();
      wokenRound = start - wakeAt('counted') < countDueMs();
      noteWake('round', start);
      passedRound = false;
      if (!intervalRound(named)) return;
      if (!wokenRound && passedRound) noteWake('counted', start);
      const left = exitFiles(exits);
      consumeExits(left.filter((f) => f.at < start));
      if (round >= WAKE_ROUNDS || !left.some((f) => f.at >= start)) return;
      sleep(start + WAKE_GAP_MS - Date.now());
    }
  } finally {
    if (held) unlockFile(tickLock());
  }
}

// -> false when a batch's pass was skipped because another run held its lock.
function intervalRound(named) {
  let ran = true;
  const batches = tickBatches(named);
  tickStates = batches.map((b) => b.state);
  // Standing intake first, in the standing batch's environment: it may start the batch this tick passes.
  if (!named) enterBatch(null);
  // What pushes admitted since the last tick goes in this tick's report with intake's own lines. Push
  // leaves them in the state folder it ran in, which a tick pinned to a batch shares with it.
  const intake = [...takePushed(E.stateDir()), ...runIntake()];
  templateCheck(batches[0].state);
  batches.forEach((b, i) => {
    if (!named) enterBatch(b.name);
    try {
      if (!named && b.name && archived(b, batches[0].state)) return;
      if (b.name && planAnswered(b, batches[0].state)) return;
      if (batchInterval(i === 0 ? intake : []) === 'skipped') ran = false;
    } catch (e) {
      try {
        mkdirSync(b.state, { recursive: true });
        logTo(b.state)([`== ${stamp()} batch ${b.name ?? 'standing'}: the tick failed and the next tries again; any other batch still runs: ${describeCrash(e)}`]);
      } catch { /* nowhere to say it */ }
    }
  });
  leversRefresh(batches[0].state);
  return ran;
}

// The Levers page, refreshed after the batches (levers-refresh.mjs): built only when an input changed
// or the last attempt is 10 minutes old, under one machine-wide lock. Run apart, so a build that fails
// or hangs never fails the tick; a build, or a failed one, is logged in the standing batch's log.
const LEVERS_TIMEOUT_MS = 2 * 60 * 1000;
function leversRefresh(standing) {
  const script = join(HERE, 'levers-refresh.mjs');
  if (!existsSync(script)) return;
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: process.env, timeout: LEVERS_TIMEOUT_MS });
  let res = null;
  try { res = JSON.parse(String(r.stdout).trim().split('\n').at(-1)); } catch { /* said below */ }
  const line = res?.ran === false ? null
    : res?.ok ? `levers: built the page (line: ${res.line})`
      : `levers: couldn't update the page: ${res?.where ?? String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0]}`;
  if (!line) return;
  try { mkdirSync(standing, { recursive: true }); logTo(standing)([`== ${stamp()} ${line}`]); } catch { /* nowhere to say it */ }
}

// Whether this repo's committed copies of desk's templates are behind them (repo-templates.mjs check,
// at most hourly), recorded for needs-you as one repo-level item. Only a failure is logged.
const TEMPLATE_CHECK_MS = 60 * 1000;
function templateCheck(standing) {
  const script = join(HERE, 'repo-templates.mjs');
  if (!existsSync(script) || !existsSync(join(E.deskHome(), 'templates'))) return;
  const r = spawnSync(process.execPath, [script, 'check'], { encoding: 'utf8', env: process.env, timeout: TEMPLATE_CHECK_MS });
  if (r.status === 0) return;
  try { mkdirSync(standing, { recursive: true }); logTo(standing)([`== ${stamp()} template check failed: ${String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0]}`]); } catch { /* nowhere to say it */ }
}

// A named batch's archive check (batch.mjs): what it says goes in the batch's own log, and an archive in
// the standing batch's, since the batch's log moves with it. -> whether the batch's tick ends here: it
// was archived, or its merge driver was told to stop for the archive, which no pass may start again.
function archived(b, standing) {
  const a = archiveCheck(b);
  if (a.lines.length) { mkdirSync(b.state, { recursive: true }); logTo(b.state)([`== ${stamp()} ${a.lines.join('\n')}`]); }
  if (a.archived) { mkdirSync(standing, { recursive: true }); logTo(standing)(a.log.map((l) => `== ${stamp()} ${l}`)); }
  if (a.stopped) {
    // A driver stopped for the archive did not fail, so it counts no failed start.
    const s = readState(b.state);
    if (s.driver?.pid) { s.driver.pid = null; writeState(b.state, s); }
  }
  return a.archived || Boolean(a.stopped);
}

// A feature batch whose epic's plan the person answered (epic-plan.mjs actOnPlan): started, edited and
// started, asked again, or discarded. A discarded batch's lines go in the standing batch's log, since
// its own log went with it. -> whether the batch is gone.
function planAnswered(b, standing) {
  const lock = { take: () => { mkdirSync(b.state, { recursive: true }); return !takeLock(b.state); }, drop: () => dropLock(b.state) };
  const p = actOnPlan(b, { lock });
  if (!p.lines.length) return p.gone;
  const to = p.gone ? standing : b.state;
  mkdirSync(to, { recursive: true });
  logTo(to)([`== ${stamp()} batch ${b.name}: the plan's answer`, ...p.lines]);
  return p.gone;
}

function batchInterval(intake) {
  const state = E.stateDir();
  mkdirSync(state, { recursive: true });
  const log = logTo(state);
  // What runs old code is kept on every tick: with no batch, a queue unreadable, or a pass skipped.
  noteCode(state);
  if (!existsSync(E.queueFile())) {
    if (intake.length) log([`== ${stamp()} intake`, ...intake]);
    // With no batch there is no pass, but what intake handed on still goes out at each check-in.
    if (handedByIntake(state).length) idleCheckin(state, readState(state), log, stamp, { maintenance: false });
    return;
  }
  let q;
  try { q = readQueue(E.queueFile()); } catch (e) { log([`== ${stamp()} queue unreadable, no pass run: ${describeCrash(e)}`, ...intake]); return; }
  const s = readState(state);
  // What intake did goes in the pass's report; a tick that runs no pass logs it alone.
  const intakeAlone = () => { if (intake.length) log([`== ${stamp()} intake`, ...intake]); };
  if (q.supervised !== true) {
    intakeAlone();
    // Said once per batch, so a batch never handed over is not mistaken for a supervisor that stopped.
    if (s.unsupervised !== (q.batch ?? null)) {
      log([`== ${stamp()} batch ${q.batch ?? '?'} is not handed over: no pass until Stage 4 runs queue.mjs set-batch supervised=true`]);
      writeState(state, { ...s, unsupervised: q.batch ?? null });
    }
    return;
  }
  const moved = moveDriver(state, s);
  if (moved) log([`== ${stamp()} ${moved}`]);
  // An answer leaves its ticket parked, so it does not change the fingerprint: an answer to an item
  // handed on, or to any park since the batch went idle, ends idle by itself, so a pass lists it and a
  // decider can act on the answer.
  const idleAt = Date.parse(s.idle_at ?? '') || 0;
  const answeredNow = Object.values(readHanded(state)).some((e) => answered(state, e))
    || Object.values(q.tickets ?? {}).some((t) => t.state === 'parked' && !isHeld(t)
      && answered(state, { ticket: t.key, at: new Date(Math.max(idleAt, Date.parse(t.park?.since ?? '') || 0)).toISOString() }));
  // So does an interactive close-out's note: only a pass turns it into a done ticket.
  const closedOut = readCloseouts(state).some((c) => !c.queue || c.queue === E.queueFile());
  // And, for a batch with anything parked, failed or held behind a blocker in no batch, the recheck
  // interval passing: what clears a park or an outside hold (a PR merged by hand, a variable set, a
  // blocker landing) is only seen by a pass, which asks GitHub once per distinct outside blocker. An
  // outside key counts only while it is still in held_by and in no ticket here: a person's release
  // clears held_by and leaves held_outside behind.
  const heldOutside = (t) => {
    const by = String(t.held_by ?? '').split('|');
    return isHeld(t) && String(t.held_outside ?? '').split('|').some((k) => k && by.includes(k) && !q.tickets[k]);
  };
  // A park waiting on an Actions run or a PR's checks is rechecked sooner, so it is requeued within
  // minutes of the run finishing. A PR no ticket owns (ticketless_prs) is rechecked on the same timer
  // as a park: only a pass sees it merged or closed and drops the needs-you item.
  const all = Object.values(q.tickets ?? {});
  const since = Date.now() - idleAt;
  const recheck = (all.some(waitingOnRun) && since >= RUN_RECHECK_MS)
    || ((all.some((t) => (t.state === 'parked' && !isHeld(t)) || t.state === 'failed' || heldOutside(t)) || ticketlessHeld(q)) && since >= IDLE_RECHECK_MS);
  // And a post-merge scan falling due while a merged PR is still watched: only a pass runs it.
  const watchDue = postMergeDue({ state, queue: q });
  if (s.idle && s.idle === fingerprint(q) && !answeredNow && !closedOut && !recheck && !watchDue) {
    intakeAlone();
    // A driver an earlier pass started can still be merging the batch's last PRs, or stop doing so.
    const reaped = reapDecider(state, s);
    const driver = watchDriver(state, s, driverHolder(state));
    if (reaped.length || driver.length) writeState(state, s);
    if (reaped.length) log([`== ${stamp()} ${reaped.join('\n')}`]);
    if (driver.length) log([`== ${stamp()} idle: the merge driver`, ...driver]);
    idleBeat(state, q);
    idleCheckin(state, s, log, stamp);
    return;
  }
  const holder = takeLock(state);
  if (holder) { log([`== ${stamp()} skipped: a pass is still running (pid ${holder})`, ...intake]); return 'skipped'; }
  try { runPass(state, q, s, log, stamp, intake); }
  finally { dropLock(state); }
}

// Takes <state>/supervisor.lock for this process: -> null, or the pid of the live run that holds it
// (or the orchestrator's pass lock). Taken exclusively (dir-lock.mjs tryLockFile), so of two ticks
// that both find a dead holder's lock only one takes it over.
function takeLock(state) {
  const pass = orchestratorHolder(state);
  if (pass) return pass;
  const got = tryLockFile(supervisorLock(state));
  return got === true ? null : (got ?? '?');
}
const dropLock = (state) => unlockFile(supervisorLock(state));

// Standing intake (intake.mjs), where config §3b "Intake query" names a query: the lines for the
// report, empty when it was not due. Triage runs a model per ticket, so it gets the longest wait.
const INTAKE_TIMEOUT_MS = 30 * 60 * 1000;
function runIntake() {
  if (!intakeQuery()) return [];
  const r =spawnSync(process.execPath, [join(HERE, 'intake.mjs'), 'run', '--json'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: INTAKE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(String(r.stdout ?? '').trim()).lines ?? []; } catch {
    return [`intake: failed (${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-2).join(' / ') || `exited ${r.status ?? r.signal}`}); the next tick tries again`];
  }
}

// An idle batch runs no pass, but its parked questions still go out at each check-in: the tick runs
// the check-in alone and pushes what it returns, once per key, as a pass's push would be.
// An idle tick runs no pass, so it refreshes the batch's heartbeat itself (pass.mjs writes it on a
// pass): `at` this tick, `next` the agent's next one, and the last pass's time carried, so desk-q's
// "last pass" still says when one ran. Without it, an idle batch the supervisor still runs, and an
// answer still wakes, reads as passes stopped once its last pass is LIVE_MS old.
function idleBeat(state, q) {
  const every = Number(installedInterval(E.repoSlug()));
  const now = Date.now();
  writeBeat(state, E.queueFile(), {
    batch: q.batch ?? null, now, pass: lastBeat(state, E.queueFile())?.pass ?? null, next: every > 0 ? now + every * 1000 : null,
  });
}

// The check-in reads Jira and GitHub; one that hangs is killed so the tick still ends.
const CHECKIN_TIMEOUT_MS = Number(process.env.DESK_CHECKIN_TIMEOUT_MS) || 5 * 60 * 1000;
function idleCheckin(state, s, log, stamp, { maintenance = true } = {}) {
  // Both are the repo's, not a batch's: a tick with several idle batches runs each once.
  if (maintenance && firstTime('maintenance')) idleMaintenance(state, s, log, stamp);
  if (!firstTime('checkin')) return;
  const r = spawnSync(process.execPath, [join(HERE, 'digest.mjs'), 'checkin'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: CHECKIN_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (r.error?.code === 'ETIMEDOUT') {
    log([`== ${stamp()} idle check-in: timed out after ${CHECKIN_TIMEOUT_MS / 1000}s and was killed; the next tick tries again`]);
    return;
  }
  let d;
  try { d = JSON.parse(String(r.stdout ?? '').trim()); } catch {
    log([`== ${stamp()} idle check-in: failed (${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-2).join(' / ')})`]);
    return;
  }
  pushOnce(state, s, log, stamp, 'idle check-in', d.push);
}

// Sends one push unless its key went out already, and records the key once it has.
function pushOnce(state, s, log, stamp, what, p) {
  if (!p?.key || !p.text || s.notified.includes(p.key)) return;
  if (sentElsewhere(state, p.key)) { s.notified.push(p.key); writeState(state, s); return; }
  const { err, said } = notify(title(), p.text);
  log([`== ${stamp()} ${what}: ${err ? `notification failed (${err}) for ${p.key}; the next tick tries again` : `notification ${said} for ${p.key}`}`]);
  if (!err) { s.notified.push(p.key); sentThisTick.add(p.key); writeState(state, s); }
}

// An idle batch runs no pass, so the weekly maintenance window and the auto-release are moved on here;
// their log says the rest. What the step pushes goes out once per key, as a pass's push would.
function idleMaintenance(state, s, log, stamp) {
  const r = spawnSync(process.execPath, [join(HERE, 'maintenance.mjs'), 'step'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: PASS_TIMEOUT_MS });
  let m;
  try { m = JSON.parse(String(r.stdout ?? '').trim()); } catch {
    log([`== ${stamp()} idle maintenance: failed (${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-2).join(' / ')})`]);
    return;
  }
  if (m.lines?.length) log([`== ${stamp()} idle maintenance:`, ...m.lines]);
  for (const p of Array.isArray(m.push) ? m.push : []) pushOnce(state, s, log, stamp, 'idle maintenance', p);
}

function runPass(state, q, s, log, stamp, intake = []) {
  const slug = E.repoSlug();
  const qf = E.queueFile();

  const env = { ...process.env };
  delete env.AUTOPILOT_USER_APPROVED;
  delete env.AUTOPILOT_BASE_PUSH_APPROVED;
  const given = [];
  if (q.approved?.workers === true) { env.AUTOPILOT_USER_APPROVED = '1'; given.push('workers'); }
  if (q.approved?.base_push === true) { env.AUTOPILOT_BASE_PUSH_APPROVED = '1'; given.push('base push'); }
  // Reaped before the pass, so the pass sees what an ended session did and a long pass does not
  // stretch a session's time.
  const reaped = reapDecider(state, s);
  // The next tick is this agent's interval away, so the pass records it as its next.
  const every = Number(installedInterval(slug));
  // An answer recorded while the pass runs is after it started, so it still ends the idle it reports.
  const startedAt = new Date().toISOString();
  // The pass reads its time from it, so a read it records is at most the interval before the pass the
  // idle recheck starts (pass/parks.mjs decideOutsideHolds), however long each pass took to reach it.
  env.DESK_PASS_AT = startedAt;
  passedRound = true;
  const r = spawnSync(process.execPath, [join(HERE, 'pass.mjs'), '--json', '--by', 'supervisor', ...(every > 0 ? ['--next', `+${every}`] : []), ...(wokenRound ? ['--woken'] : [])], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: PASS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  let v;
  try { v = JSON.parse(String(r.stdout ?? '').trim()); }
  catch {
    const why = r.error?.code === 'ETIMEDOUT' ? `timed out after ${PASS_TIMEOUT_MS / 60000} minutes` : `exited ${r.status ?? r.signal} without a verdict`;
    v = { status: 'error', code: r.status, message: `pass.mjs ${why}: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-5).join(' / ')}` };
  }
  const out = [`== ${stamp()} pass: exit ${r.status ?? r.signal} (${v.status}); approvals passed on: ${given.join(', ') || 'none'}`, ...intake, String(v.message ?? '').trimEnd()];

  let qAfter = q;
  try { qAfter = readQueue(qf); } catch { /* the pass reported it */ }
  out.push(...reaped, ...decide(state, s, v, qAfter));
  s.idle = null;
  const driver = driverHolder(state);
  out.push(...watchDriver(state, s, driver));
  if (v.status !== 'idle') {
    const keys = toMerge(qAfter);
    const grant = E.mergeGrant(qAfter);
    if (!keys.length) { /* nothing to merge */ }
    else if (driver) { /* running: nothing new to log */ }
    else if (!grant.by) out.push(`merge driver: not started, since ${grant.why}: green PRs wait for you`);
    else {
      // The driver takes in every queue ticket and its holds (held_by) on each loop by itself. Its
      // output goes to its log from the first line, so what it says before it takes --log is kept too.
      const tickets = Object.keys(qAfter.tickets ?? {});
      const from = logSize(driverLog(state));
      let fd;
      try {
        fd = openSync(driverLog(state), 'a');
        const child = spawn(join(HERE, 'merge-driver.sh'), ['--tickets', tickets.join(' '), '--log'], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', fd, fd] });
        child.on('error', () => {});
        child.unref();
        s.driver = { failures: 0, notified: false, ...s.driver, pid: child.pid, started: new Date().toISOString(), from };
        out.push(`merge driver: started (pid ${child.pid}) for ${tickets.join(' ')}; its log is ${driverLog(state)}`);
      } catch (e) { out.push(`merge driver: could not start: ${e.message}`); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  }

  // A pass that crashed or hung gave no verdict, and needs the person as much as one that said so.
  const pushes = toPush(v);
  const items = pushes.map((p) => p.key);
  const fresh = pushes.filter((p) => !s.notified.includes(p.key) && !sentElsewhere(state, p.key));
  let sent = true;
  if (fresh.length) {
    const { err, said } = notify(title(), fresh.map((p) => p.text).join(' · '));
    sent = !err;
    if (sent) fresh.forEach((p) => sentThisTick.add(p.key));
    out.push(err ? `notification: failed (${err}) for ${fresh.map((p) => p.key).join(', ')}; the next pass tries again` : `notification: ${said} for ${fresh.map((p) => p.key).join(', ')}`);
  } else if (items.length) out.push(`notification: not sent, the last one already named ${items.join(', ')}`);
  // A failed notification records nothing new, so the next pass sends it again. A pass that refused
  // or failed checked nothing, so it keeps the keys already sent rather than dropping them.
  if (v.status === 'error') s.notified = sent ? [...new Set([...s.notified, ...items])] : s.notified;
  else s.notified = sent ? items : s.notified.filter((i) => items.includes(i));
  // Idle is recorded only once its notification is out: until then the next interval passes again.
  if (v.status === 'idle' && sent) {
    s.idle = fingerprint(qAfter);
    s.idle_at = startedAt;
    out.push(`supervisor: batch ${qAfter.batch ?? '?'} is idle: no merge driver, and no pass until a new batch starts, a ticket is added to this one, a park is answered, or ${IDLE_RECHECK_MS / 60000} minutes pass with anything parked, failed or held behind a blocker in no batch${ticketlessHeld(qAfter) ? ', or a PR no ticket owns still recorded' : ''}${Object.values(qAfter.tickets ?? {}).some(waitingOnRun) ? ` (${RUN_RECHECK_MS / 60000} minutes while a park waits on an Actions run or a PR's checks)` : ''}`);
  }
  writeState(state, s);
  log(out);
}

// ---- the merge driver ------------------------------------------------------------------------
// s.driver is the last driver this supervisor started ({pid, started, from, failures, notified,
// reason, code}): `from` is where its output starts in merge-driver.log, and `failures` counts the
// starts in a row that stopped with a failure before a tick found a driver running.
const DRIVER_NOTIFY_AFTER = 2;
const driverLog = (state) => join(state, 'merge-driver.log');
const logSize = (f) => { try { return statSync(f).size; } catch { return 0; } };
const STAMP = /^\d\d:\d\d:\d\dZ /;
const EXITED = /^merge driver exited (\d+)$/;

// Why a driver stopped, from what it wrote from `from` on: its exit code (null when it logged none,
// as a killed one does) and its last FAIL line, else its last line.
function driverStop(state, from) {
  let text = '';
  try {
    const fd = openSync(driverLog(state), 'r');
    try {
      const size = fstatSync(fd).size;
      // A log cut shorter than `from` is read from its start; a long one by its last 64 KB.
      const start = Math.max(size < from ? 0 : from, size - 64 * 1024);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally { closeSync(fd); }
  } catch { /* no log yet */ }
  const lines = text.split('\n').map((l) => l.trim().replace(STAMP, '')).filter(Boolean);
  const codes = lines.map((l) => EXITED.exec(l)?.[1]).filter(Boolean);
  const said = lines.filter((l) => !EXITED.test(l));
  const reason = (said.filter((l) => l.startsWith('FAIL')).pop() ?? said.pop() ?? 'it wrote nothing to its log').slice(0, 300);
  return { code: codes.length ? Number(codes.at(-1)) : null, reason };
}

// The lines a tick logs about the driver it last started: nothing while one runs, why it stopped
// once, and one notification after DRIVER_NOTIFY_AFTER failed starts in a row. A driver that exits
// 0 (a one-loop run) did not fail; one that logged no exit code was killed, and counts.
function watchDriver(state, s, holder) {
  const d = s.driver;
  if (!d) return [];
  const lines = [];
  if (holder === 'starting') return lines;
  if (holder) { d.failures = 0; d.notified = false; return lines; }
  if (d.pid) {
    const { code, reason } = driverStop(state, d.from ?? 0);
    lines.push(`merge driver: stopped (pid ${d.pid}, started ${d.started}, ${code == null ? 'no exit code logged' : `exit ${code}`}): ${reason}`);
    Object.assign(d, { pid: null, code, reason, failures: code === 0 ? 0 : (d.failures ?? 0) + 1 });
    if (code === 0) d.notified = false;
  }
  // Retried each tick until it is out, so a notification that failed is not lost.
  if (d.failures >= DRIVER_NOTIFY_AFTER && !d.notified) {
    const { err, said } = notify(title(), `The merge driver failed ${d.failures} starts in a row: ${d.reason}`);
    d.notified = !err;
    lines.push(err ? `notification: failed (${err}) for the merge driver; the next tick tries again` : `notification: ${said} for the merge driver (${d.failures} failed starts in a row)`);
  }
  return lines;
}

// ---- the decider -----------------------------------------------------------------------------
// s.decider is the running session's record ({id, pid, started, out, items}), or null.
const recoveryRules = () => join(E.skillsDir(), 'desk-autopilot', 'references', 'orchestrator-recovery.md');

// Records none as the clears-when of each item's park still waiting on a restate (decider restateKeys):
// a session saw it and left it, or none will, so the park is the person's. Returns the report line.
function restatedNone(items) {
  if (!restateKeys(items).length) return [];
  let q;
  try { q = readQueue(E.queueFile()); } catch { return []; /* left for the next tick */ }
  const done = [];
  const failed = [];
  for (const key of restateKeys(items, q)) {
    const r = spawnSync(process.execPath, [join(HERE, 'queue.mjs'), 'clears-when', key, 'none'], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
    (r.status === 0 ? done : failed).push(r.status === 0 ? key : `${key} (${`${r.stderr ?? ''}`.trim().split('\n').pop()})`);
  }
  return [
    ...(done.length ? [`decider: unreadable clears-when recorded as none, for the person: ${done.join(', ')}`] : []),
    ...(failed.length ? [`decider: an unreadable clears-when could not be recorded as none: ${failed.join(', ')}`] : []),
  ];
}

// Restarts the RESTATE_MS clock on each item's park still waiting on a restate, for a tick that starts
// no decider (the batch on a usage hold, or the repo's subscription at its limit or signed in nowhere): the hour is the decider's to use, so a
// line never lapses to none, and to the person, before one has seen it. Returns the report line.
function restampRestate(items, now) {
  if (!restateKeys(items).length) return [];
  let q;
  try { q = readQueue(E.queueFile()); } catch { return []; /* left for the next tick */ }
  const done = [];
  for (const key of restateKeys(items, q)) {
    const r = spawnSync(process.execPath, [join(HERE, 'queue.mjs'), 'set', key, `park.clears_when.at=${now.toISOString()}`], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
    if (r.status === 0) done.push(key);
  }
  return done.length ? [`decider: the hour to restate an unreadable clears-when starts again once one runs: ${done.join(', ')}`] : [];
}

// Stops a decider past its time and hands its items on; records an ended one's outcome. Returns the
// lines for the batch report.
function reapDecider(state, s, now = new Date()) {
  const rec = s.decider;
  if (!rec) return [];
  // A written result means the session ended, whatever now holds its pid.
  let result = readResult(rec.out);
  if (result.error && rec.pid && alive(rec.pid)) {
    if (now - Date.parse(rec.started) < DECIDER_TIMEOUT_MS) return [];
    // The session leads its own process group (spawned detached); a pid no longer leading one is not it.
    try { process.kill(-rec.pid, 'SIGTERM'); } catch { /* gone */ }
    result = { cost: result.cost, error: 'timed out' };
  }
  let q = {};
  try { q = readQueue(E.queueFile()); } catch { /* every park reads as still parked */ }
  const o = outcome(rec, result, q, { state });
  // Handed on from the session's start, to the second answers are stamped at: an answer given while it
  // ran never reached it, so it still counts as one since the hand-over and reaches the next session.
  handItems(state, o.handed, new Date(Math.floor((Date.parse(rec.started) || now.getTime()) / 1000) * 1000));
  noteOutcome(state, o, now);
  s.decider = null;
  s.settled = o.settled.map((x) => x.item.id);
  // A session the usage limit refused saw nothing: its items wait for the next one.
  return [reportLine(rec, o), ...(o.kept ? [] : restatedNone(rec.items))];
}

// origin's head of the batch base, as the pass fetched it, when the pass lists a base sync line: or null.
function baseHead(q, v) {
  const base = typeof q?.base === 'string' ? q.base.trim() : '';
  if (!base || !(Array.isArray(v?.waiting) && v.waiting.some(baseSyncLine))) return null;
  const r = spawnSync('git', ['rev-parse', '--verify', '-q', `refs/remotes/origin/${base}^{commit}`], { cwd: process.cwd(), encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

// After a pass that needs the person: hands on what no session may settle, and starts a decider for
// the rest that is neither handed on and unanswered nor waiting on a decider already running.
function decide(state, s, v, q, now = new Date()) {
  if (v.status === 'error') return [];
  const items = deciderItems(v, q, state, { baseSha: baseHead(q, v) });
  pruneHanded(state, items);
  // What the last session settled, checked against this pass only.
  const settled = s.settled ?? [];
  s.settled = [];
  if (!['show_person', 'idle'].includes(v.status)) return [];
  const { hand, ask, waits } = presort(items, state);
  const lines = [];
  // A park now waiting on a recorded clears-when is no longer the digest's: a pass settles it.
  const handedNow = readHanded(state);
  const waiting = waits.filter((i) => handedNow[i.id]);
  if (waiting.length) {
    dropHanded(state, waiting.map((i) => i.id));
    lines.push(`decider: taken off the digest, each waits on its recorded clears-when: ${waiting.map((i) => i.ticket).join(', ')}`);
  }
  // One the last session settled that a pass still lists was not settled: another session would only
  // settle it again.
  const again = ask.filter((i) => settled.includes(i.id));
  const added = handItems(state, [...hand, ...again.map((item) => ({ item, why: 'the decider settled it, but the next pass still lists it' }))], now);
  if (added.length) lines.push(`decider: handed to the digest without a session: ${added.map((x) => `${x.item.ticket} (${x.why})`).join(', ')}`);
  const fresh = freshItems(state, ask.filter((i) => !again.includes(i)));
  // An unreadable clears-when no session will see now (handed on, or handed already and unanswered)
  // is none from here.
  const freshIds = new Set(fresh.map((i) => i.id));
  lines.push(...restatedNone(items.filter((i) => !freshIds.has(i.id))));
  if (!fresh.length) return lines;
  if (s.decider) return [...lines, `decider: one is still running (pid ${s.decider.pid}, since ${s.decider.started}), so none starts for ${fresh.map((i) => i.ticket).join(', ')}`];
  // A session started at the limit fails at once; its items wait for the pass that finds it lifted.
  const hold = q.usage_hold;
  if (hold) return [...lines, `decider: not started, the batch is held on ${limitName(hold.type)}${hold.resets_at != null ? ` until ${resetText(hold.resets_at)}` : ''} (usage_hold); ${fresh.map((i) => i.ticket).join(', ')} wait for the next decider once it lifts`, ...restampRestate(fresh, now)];
  const rules = recoveryRules();
  if (!existsSync(rules)) {
    handItems(state, fresh.map((item) => ({ item, why: `no decider: the recovery rules are missing at ${rules}` })), now);
    return [...lines, `decider: not started, the recovery rules are missing at ${rules}; ${fresh.map((i) => i.ticket).join(', ')} handed to the digest`, ...restatedNone(fresh)];
  }
  const started = startDecider({ state, slug: E.repoSlug(), bin: HERE, report: v.message, items: fresh, rules: readFileSync(rules, 'utf8'),
    webRead: E.permission('worker-web-read') === 'yes', judgement: E.permission('autopilot-judgement'), targets: runningBatches(HERE, { cwd: process.cwd() }), cwd: process.cwd(), now });
  if (started.wait) return [...lines, `decider: not started, ${started.wait}; ${fresh.map((i) => i.ticket).join(', ')} wait for the next decider`, ...restampRestate(fresh, now)];
  s.decider = started;
  return [...lines, `decider: started (pid ${s.decider.pid})${s.decider.login ? ` on login ${s.decider.login}` : ''} for ${fresh.map((i) => i.ticket).join(', ')}; its output is ${s.decider.out}`];
}

function status() {
  const slug = E.repoSlug();
  const interval = installedInterval(slug);
  console.log(`agent: ${label(slug)} ${interval ? `installed (every ${interval}s), ${loaded(slug) ? 'loaded' : 'not loaded'}` : 'not installed (supervisor.mjs install)'}`);
  for (const { name, queue: qf, state } of tickBatches()) {
    // A named batch's lines lead with its name; the standing batch's read as they always have.
    const lead = name ? `${name}: ` : '';
    let batch = 'no batch';
    if (existsSync(qf)) {
      try {
        const q = readQueue(qf);
        const s = readState(state);
        batch = `batch ${q.batch ?? '?'}: ${q.supervised !== true ? 'not handed over (queue.mjs set-batch supervised=true at Stage 4)'
          : s.idle === fingerprint(q) ? 'idle, nothing runs until a new batch starts' : 'handed over'}`;
      } catch (e) { batch = `queue unreadable: ${describeCrash(e)}`; }
    }
    console.log(`${lead}${batch}`);
    const logFile = join(state, 'supervisor.log');
    if (existsSync(logFile)) {
      console.log(`${lead}log: ${logFile}, last lines:`);
      for (const l of readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-10)) console.log(`  ${l}`);
    }
  }
  process.exitCode = interval && loaded(slug) ? 0 : 1;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'install') {
    const i = rest.indexOf('--interval');
    const n = i < 0 ? DEFAULT_INTERVAL : Number(rest[i + 1]);
    if (!Number.isInteger(n) || n < MIN_INTERVAL) die(`--interval wants whole seconds, at least ${MIN_INTERVAL}`, 2);
    install(n, rest.includes('--reload'));
  } else if (cmd === 'uninstall') uninstall();
  else if (cmd === 'status') status();
  else if (cmd === 'tick') { if (rest.includes('--foreground')) interval(); else tick(); }
  else die('usage: supervisor.mjs install [--interval <s>] [--reload] | uninstall | status | tick [--foreground]', 2);
} catch (e) { die(describeCrash(e)); }
