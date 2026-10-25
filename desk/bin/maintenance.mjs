#!/usr/bin/env node
// The weekly maintenance window, one per computer: at config §3b "Maintenance window" (e.g.
// `Mon 06:30 UTC`) the first pass opens it, and from then every repo's pass starts no new worker and
// lets its own workers finish, stopping any still running after §3b "Maintenance drain limit
// (minutes)" with their sessions kept. Once nothing runs (or other repos' workers have been waited on
// for DRAIN_OTHERS_MIN past the limit), one pass pulls desk-skills fast-forward and installs it, runs
// the reboot check, and restarts the computer where config §3 machine-reboot is `yes` and the check
// found no blocker. At `ask` (unset), or at `yes` with FileVault the only blocker, it hands "ready to
// reboot" to the check-in digest; at `no` it stops there. Spawning resumes once the window is done, or after the restart at login.
//
// Every repo's pass calls maintenance() once a pass, and the supervisor's idle tick runs the CLI, so an
// idle batch still gets its window. A repo with no window row follows a window another repo opened.
// The state, the record and the lock are machine-wide, in ~/.desk-autopilot/maintenance/
// (DESK_MAINT_DIR overrides): maintenance.json and maintenance.log. A window runs at most once a week,
// and one not opened within START_WITHIN_H hours of its time is missed for that week, so a computer
// that was off on Monday does not drain in the middle of Thursday.
//   node maintenance.mjs step     one step now, outside a pass (the supervisor's idle tick); prints JSON
//
// Tests stand in for the clock and the commands: DESK_MAINT_NOW (ISO), DESK_BOOT_TIME (ISO or epoch
// seconds), DESK_SOURCE_CHECKOUT (the desk-skills checkout), DESK_REBOOT_CHECK_CMD, DESK_RUNNER_CMD and
// DESK_RESTART_CMD (each run with sh -c, the runner command with its subcommand appended).
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { takeBorrowLock, otherQueues } from './borrow.mjs';

export const WINDOW_ROW = E.CONFIG_ROWS['maintenance-window'].row;
export const DRAIN_ROW = E.CONFIG_ROWS['maintenance-drain'].row;
export const DEFAULT_DRAIN_MIN = 60;
export const START_WITHIN_H = 6;
// How long past the drain limit the window waits on workers in other repos, whose own passes stop
// them; a repo with no orchestrator running stops nothing, and the reboot check then names them.
export const DRAIN_OTHERS_MIN = 30;
// A restart that has not happened this long after it was asked for did not happen.
const RESTART_GRACE_MS = 15 * 60 * 1000;
export const FILEVAULT_ON = 'FileVault is on: after a restart nothing runs until someone logs in';
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// Phases that hold every new spawn, resumes included.
const HOLDING = ['draining', 'updating', 'checking', 'reboot', 'rebooting'];

export const maintDir = () => E.expandHome(process.env.DESK_MAINT_DIR ?? join(E.HOME, '.desk-autopilot', 'maintenance'));
const now = () => (process.env.DESK_MAINT_NOW ? new Date(process.env.DESK_MAINT_NOW) : new Date());
const bootMs = () => {
  const v = process.env.DESK_BOOT_TIME;
  if (v) return /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v);
  return Date.now() - uptime() * 1000;
};
const stamp = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const short = (sha) => String(sha ?? '?').slice(0, 12);

// Config §3b "Maintenance window": `<day> HH:MM`, local time, or `<day> HH:MM UTC`. Unset, `none` or
// `off` is no window. -> {off: true} | {ok: true, day, h, m, utc, text} | {bad}
export function parseWindow(raw) {
  if (raw == null || /^\s*(none|off|todo\b)/i.test(raw) || !String(raw).trim()) return { off: true };
  const text = String(raw).trim();
  const m = /^([a-z]+)\s+([01]?\d|2[0-3]):([0-5]\d)(\s+utc)?$/i.exec(text);
  const day = m && m[1].length >= 3 ? DAYS.findIndex((d) => d.startsWith(m[1].toLowerCase())) : -1;
  if (day < 0) return { bad: `config §3b "${WINDOW_ROW}" is "${text}": want a day and a time, e.g. \`Mon 06:30 UTC\`, or \`none\`` };
  return { ok: true, day, h: Number(m[2]), m: Number(m[3]), utc: !!m[4], text };
}

// Config §3b "Maintenance drain limit (minutes)": a whole number; unset is DEFAULT_DRAIN_MIN.
export function drainLimit(raw) {
  if (raw == null || /^\s*todo\b/i.test(raw) || !String(raw).trim()) return { minutes: DEFAULT_DRAIN_MIN };
  if (/^\s*\d+\s*$/.test(raw)) return { minutes: Number(raw) };
  return { minutes: DEFAULT_DRAIN_MIN, bad: `config §3b "${DRAIN_ROW}" is "${raw}": want a whole number of minutes; read as ${DEFAULT_DRAIN_MIN}` };
}

// The latest start of the window at or before `at`.
export function windowStart(w, at) {
  for (let back = 0; back < 8; back++) {
    const d = w.utc
      ? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - back, w.h, w.m))
      : new Date(at.getFullYear(), at.getMonth(), at.getDate() - back, w.h, w.m);
    if ((w.utc ? d.getUTCDay() : d.getDay()) === w.day && d <= at) return d;
  }
  return null;
}

// ---- state and record --------------------------------------------------------------------------
export const stateFile = (dir) => join(dir, 'maintenance.json');
export const logFile = (dir) => join(dir, 'maintenance.log');
export function readState(dir) {
  try { return JSON.parse(readFileSync(stateFile(dir), 'utf8')); } catch { return null; }
}
const writeState = (dir, s) => { mkdirSync(dir, { recursive: true }); writeFileSync(stateFile(dir), `${JSON.stringify(s, null, 2)}\n`); };
const record = (dir, at, text) => { mkdirSync(dir, { recursive: true }); appendFileSync(logFile(dir), `== ${stamp(at)} ${text}\n`); };
// Notes the check-in digest has not necessarily read yet survive into the next window.
const keptNotes = (s) => (s?.notes ?? []).slice(-20);

// What the window hands the check-in digest: {at, text}, oldest first.
export const digestNotes = (dir = maintDir()) => (readState(dir)?.notes ?? []).filter((n) => n?.at && n.text);

// Running tickets in every other repo's queue, and the queues that cannot be read.
function othersRunning(selfQueue) {
  const running = []; const unreadable = [];
  for (const { slug, q, error } of otherQueues({ self: selfQueue })) {
    if (error) unreadable.push(`${slug}'s queue cannot be read, so its workers cannot be counted (${error})`);
    for (const t of Object.values(q?.tickets ?? {})) if (t?.state === 'running') running.push(`${slug} ${t.key}`);
  }
  return { running, unreadable };
}

// Stops one of this repo's workers by its registry pid, with its session kept, and queues it to
// resume after the window (pass.mjs resumes `resume=maintenance` without counting it as a kill).
// `live` is the session registry (null when it could not be read), `setQueue(key, fields)` -> {ok, why}.
export function stopForWindow(t, { live, kill, setQueue }) {
  if (!Array.isArray(live)) return { ok: false, why: 'the session registry could not be read' };
  const a = live.find((x) => x.sessionId === t.session_id);
  if (a && !a.pid) return { ok: false, why: `no pid for session ${t.session_id}` };
  if (a?.pid) kill(a.pid);
  const r = setQueue(t.key, ['state=triaged', 'resume=maintenance', 'resume_why=stopped for the maintenance window']);
  return r.ok ? { ok: true, pid: a?.pid } : { ok: false, why: `queue write refused: ${r.why}` };
}

// ---- the steps' commands -----------------------------------------------------------------------
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), error: r.error?.message };
};
const shell = (cmd, opts) => run('sh', ['-c', cmd], opts);
const lastLine = (s) => String(s ?? '').split('\n').filter(Boolean).pop() ?? '';
const said = (r) => lastLine(r.out) || r.error || `exit ${r.status}`;

export function sourceCheckout() {
  if (process.env.DESK_SOURCE_CHECKOUT) return E.expandHome(process.env.DESK_SOURCE_CHECKOUT);
  try { return readFileSync(join(E.deskHome(), 'source-checkout'), 'utf8').trim() || null; } catch { return null; }
}

// Fast-forward the desk-skills checkout from origin and install it, as /desk-update does: only on a
// clean `main`. -> {ok, old, new, commits} | {ok: false, why, old}
export function updateDesk(dir = sourceCheckout()) {
  if (!dir || !existsSync(dir)) return { ok: false, why: `no desk-skills checkout (${dir ?? `${join(E.deskHome(), 'source-checkout')} names none`})` };
  const git = (...a) => run('git', ['-C', dir, ...a]);
  const old = git('rev-parse', 'HEAD').out;
  const branch = git('branch', '--show-current').out;
  if (branch !== 'main') return { ok: false, old, why: `${dir} is on ${branch || 'a detached HEAD'}, not main, so nothing was pulled or installed` };
  if (git('status', '--porcelain').out) return { ok: false, old, why: `${dir} has uncommitted changes, so nothing was pulled or installed` };
  const pull = git('pull', '--ff-only', '-q', 'origin', 'main');
  if (!pull.ok) return { ok: false, old, why: `git pull --ff-only failed in ${dir}: ${said(pull)}` };
  const head = git('rev-parse', 'HEAD').out;
  const commits = old === head ? 0 : Number(git('rev-list', '--count', `${old}..${head}`).out) || 0;
  const inst = run(join(dir, 'install.sh'), [], { cwd: dir, timeout: UPDATE_TIMEOUT_MS });
  if (!inst.ok) return { ok: false, old, new: head, why: `install.sh failed in ${dir}: ${said(inst)}` };
  return { ok: true, old, new: head, commits };
}

// The reboot check's summary, and what stops an unattended restart: anything heavy still running (a
// suite, a typecheck, a dev server: a session is behind it) and any worker running in another repo.
// Uncommitted and unpushed work is on disk, so a restart keeps it; the runner is stopped first.
// FileVault on, or not readable, blocks it too: the restarted Mac waits at the disk unlock screen, so
// no supervisor loads until someone logs in. That one is `loginWait` as well, since the computer is
// otherwise ready for a restart a person makes.
export function rebootCheck({ selfQueue = null } = {}) {
  const r = process.env.DESK_REBOOT_CHECK_CMD ? shell(process.env.DESK_REBOOT_CHECK_CMD) : run(process.execPath, [join(E.binDir(), 'reboot-check.mjs')]);
  const summary = r.out.split('\n').find((l) => l.startsWith('summary: ')) ?? null;
  const field = (k) => new RegExp(`\\b${k}=(\\S+)`).exec(summary ?? '')?.[1] ?? null;
  const blockers = [];
  if (!summary) blockers.push(`the reboot check gave no summary (${said(r)})`);
  const heavy = Number(field('heavy') ?? 0);
  if (heavy > 0) blockers.push(`${heavy} heavy process(es) running (test suites, typechecks, dev servers)`);
  const o = othersRunning(selfQueue);
  if (o.running.length) blockers.push(`${o.running.length} worker(s) running in another repo (${o.running.join(', ')})`);
  blockers.push(...o.unreadable);
  const fv = field('filevault');
  const loginWait = fv === 'on' ? FILEVAULT_ON
    : fv === 'unknown' ? 'could not tell whether FileVault is on (fdesetup status failed or is missing), so it counts as on: after a restart nothing runs until someone logs in'
      : null;
  if (loginWait) blockers.push(loginWait);
  return { summary, runner: field('runner'), keep: field('keep'), blockers, loginWait };
}

const runner = (sub) => (process.env.DESK_RUNNER_CMD ? shell(`${process.env.DESK_RUNNER_CMD} ${sub}`) : run(join(E.binDir(), 'desk-runner'), [sub]));
const restart = () => (process.env.DESK_RESTART_CMD
  ? shell(process.env.DESK_RESTART_CMD)
  : run('osascript', ['-e', 'tell application "System Events" to restart']));

// ---- one step ----------------------------------------------------------------------------------
// Moves the window on as far as it can this pass. `running` is this repo's running tickets; `stop(t)`
// stops one with its session kept and queues it to resume ({ok, pid} | {ok: false, why}).
// -> {hold, lines}: hold is true while the window holds every new spawn.
export async function maintenance({ dir = maintDir(), running = [], stop = () => ({ ok: false, why: 'no way to stop a worker here' }), selfQueue = null, at = now() } = {}) {
  const w = parseWindow(E.configValue('maintenance-window'));
  const isOpen = (x) => !!x && HOLDING.includes(x.phase);
  let s = readState(dir);
  let week = null;
  if (!isOpen(s)) {
    if (w.off) return { hold: false, lines: [] };
    if (w.bad) return { hold: false, lines: [`maintenance: ${w.bad}; no window runs until it is fixed`] };
    const start = windowStart(w, at);
    week = start.toISOString();
    if (s?.week === week) return { hold: false, lines: [] };
    if (at - start > START_WITHIN_H * 3600 * 1000) {
      writeState(dir, { week, phase: 'missed', notes: keptNotes(s) });
      record(dir, at, `window ${w.text} at ${stamp(start)} missed: no pass ran within ${START_WITHIN_H} hours of it; next week's runs as usual`);
      return { hold: false, lines: [`maintenance: this week's window (${w.text}) was missed, no pass ran within ${START_WITHIN_H} hours of it`] };
    }
  }

  mkdirSync(dir, { recursive: true });
  const lock = await takeBorrowLock({ dir, name: 'maintenance.lock.d', waitMs: 0 });
  // Busy is another pass opening or moving the window; a lock that cannot be made holds nothing new.
  if (!lock.ok) return { hold: isOpen(readState(dir)) || (week != null && / is held by /.test(lock.why)), lines: [`maintenance: the window lock was not taken (${lock.why})`] };
  try {
    s = readState(dir);
    if (!isOpen(s)) {
      if (week == null || s?.week === week) return { hold: false, lines: [] };
      // The pass that opens the window only drains: nothing new starts on it.
      s = { week, phase: 'draining', since: at.toISOString(), window: w.text, notes: keptNotes(s) };
      writeState(dir, s);
      record(dir, at, `window ${w.text} opened: draining, no new workers in any repo`);
      return { hold: true, lines: [drainLine(s, running, drainLimit(E.configValue('maintenance-drain')).minutes, at)] };
    }
    return step(s, { dir, at, running, stop, selfQueue });
  } finally { lock.release(); }
}

function drainLine(s, running, limit, at) {
  const left = Math.max(0, limit - Math.floor((at - new Date(s.since)) / 60000));
  return `maintenance: draining since ${stamp(new Date(s.since))} (window ${s.window}): no new workers; ` +
    (running.length ? `${running.length} running (${running.map((t) => t.key).join(', ')}), stopped at the ${limit} min limit, ${left} min from now` : 'none running here');
}

function step(s, { dir, at, running, stop, selfQueue }) {
  const lines = [];
  const save = (patch) => { Object.assign(s, patch); writeState(dir, s); };
  const log = (text) => record(dir, at, text);
  const note = (text) => save({ notes: [...(s.notes ?? []), { at: at.toISOString(), text }] });
  const finish = (line) => { save({ phase: 'done', done_at: at.toISOString() }); log(`window done: ${line}`); lines.push(`maintenance: ${line}; spawning resumes`); return { hold: false, lines }; };
  // The runner the window stopped is started again on every way out of a restart.
  const runnerBack = (why) => {
    if (!s.runner_was_up) return;
    const up = runner('up');
    log(`desk-runner up: ${up.ok ? lastLine(up.out) || 'ok' : said(up)}`);
    if (!up.ok) note(`${why}, desk-runner up failed: ${said(up)}. Run desk-runner up`);
  };

  if (s.phase === 'draining') {
    const limit = drainLimit(E.configValue('maintenance-drain'));
    if (limit.bad) lines.push(`maintenance: ${limit.bad}`);
    const since = new Date(s.since);
    const mins = Math.floor((at - since) / 60000);
    if (running.length && at - since >= limit.minutes * 60000) {
      const stopped = []; const left = [];
      for (const t of running) {
        const r = stop(t);
        if (r.ok) stopped.push(`${t.key}${r.pid ? ` (pid ${r.pid})` : ''}`);
        else left.push(`${t.key} (${r.why})`);
      }
      if (stopped.length) {
        log(`drained for ${mins} min, the ${limit.minutes} min limit: stopped ${stopped.join(', ')}, sessions kept; each resumes after the window`);
        lines.push(`maintenance: drained for ${mins} min, the ${limit.minutes} min limit: stopped ${stopped.join(', ')}, each with its session kept, to resume after the window`);
      }
      if (left.length) {
        lines.push(`maintenance: draining, but could not stop ${left.join(', ')}: stop it by hand, or the window waits`);
        return { hold: true, lines };
      }
    } else if (running.length) {
      lines.push(drainLine(s, running, limit.minutes, at));
      return { hold: true, lines };
    }
    const others = othersRunning(selfQueue).running;
    const until = new Date(since.getTime() + (limit.minutes + DRAIN_OTHERS_MIN) * 60000);
    if (others.length && at < until) {
      lines.push(`maintenance: draining since ${stamp(since)} (window ${s.window}): none running here; waiting on ${others.length} worker(s) in other repos (${others.join(', ')}) until ${stamp(until)}`);
      return { hold: true, lines };
    }
    log(others.length ? `drained here; still running in other repos after ${mins} min: ${others.join(', ')}` : 'drained: no worker running');
    save({ phase: 'updating' });
  }

  if (s.phase === 'updating') {
    const u = updateDesk();
    if (!u.ok) {
      log(`update failed: ${u.why}${u.old ? ` (installed version stays at ${short(u.old)})` : ''}`);
      note(`desk-skills update failed in the maintenance window, so the computer was not restarted: ${u.why}`);
      return finish(`desk-skills update failed (${u.why}), so no restart`);
    }
    log(`update: desk-skills ${short(u.old)} -> ${short(u.new)} (${u.commits} commit(s)), pulled fast-forward and installed`);
    lines.push(`maintenance: desk-skills updated ${short(u.old)} -> ${short(u.new)} (${u.commits} commit(s)) and installed`);
    save({ phase: 'checking', update: { old: u.old, new: u.new, commits: u.commits } });
  }

  if (s.phase === 'checking') {
    const c = rebootCheck({ selfQueue });
    log(`reboot check: ${c.summary ?? 'no summary'}${c.blockers.length ? `; blockers: ${c.blockers.join('; ')}` : '; no blocker'}`);
    save({ phase: 'reboot', check: c });
  }

  if (s.phase === 'reboot') {
    const perm = E.permissionOrUnset('machine-reboot') ?? 'ask';
    const key = E.permissionKey('machine-reboot');
    const c = s.check ?? { blockers: [] };
    if (perm === 'yes' && !c.blockers.length) {
      if (c.runner === 'running' || c.keep === 'loaded') {
        save({ runner_was_up: true });
        const down = runner('down');
        log(`desk-runner down: ${down.ok ? lastLine(down.out) || 'ok' : said(down)}`);
        if (!down.ok) {
          note(`not restarted: desk-runner down failed in the maintenance window (${said(down)})`);
          runnerBack('after desk-runner down failed');
          return finish('desk-runner down failed, so no restart');
        }
      }
      save({ phase: 'rebooting', restart_at: at.toISOString() });
      const r = restart();
      if (!r.ok) {
        log(`restart failed: ${said(r)}`);
        note(`not restarted: the restart command failed in the maintenance window (${said(r)})`);
        runnerBack('after the restart failed');
        return finish('the restart command failed');
      }
      log('restarting the computer');
      lines.push(`maintenance: restarting the computer (config §3 ${key} is "yes", the reboot check found no blocker); work resumes after login`);
      return { hold: true, lines };
    }
    // FileVault stops only a restart nobody is there for: alone, the computer is ready for one a person makes.
    const others = c.blockers.filter((b) => b !== c.loginWait);
    if (perm === 'yes' && c.loginWait && !others.length) {
      note(`ready to reboot: the maintenance window drained, updated desk-skills and found no other blocker, but did not restart itself because ${c.loginWait}. Restart when it suits you, then log in`);
      return finish(`not restarted: ${c.loginWait}; "ready to reboot" is in the next check-in`);
    }
    if (perm === 'yes') {
      note(`not restarted: config §3 ${key} is "yes", but the reboot check found ${c.blockers.join('; ')}`);
      return finish(`not restarted: ${c.blockers.join('; ')}`);
    }
    if (perm === 'ask') {
      note(others.length
        ? `not ready to reboot: the maintenance window drained and updated desk-skills, but the reboot check found ${others.join('; ')}. Config §3 ${key} is "ask"`
        : `ready to reboot: the maintenance window drained, updated desk-skills and found no blocker. Config §3 ${key} is "ask", so it did not restart: restart when it suits you${c.loginWait ? `, then log in (${c.loginWait})` : ''}`);
      return finish(`config §3 ${key} is "ask", so no restart: "${others.length ? 'not ready to reboot' : 'ready to reboot'}" is in the next check-in`);
    }
    return finish(`config §3 ${key} is "${perm}", so no restart`);
  }

  if (s.phase === 'rebooting') {
    const asked = Date.parse(s.restart_at);
    if (bootMs() > asked) {
      runnerBack('after the maintenance restart');
      return finish(`restarted at ${stamp(new Date(bootMs()))}`);
    }
    if (at - asked > RESTART_GRACE_MS) {
      note(`the maintenance window asked the computer to restart at ${s.restart_at}, and it did not`);
      runnerBack('after a restart that did not happen');
      return finish('the computer did not restart');
    }
    lines.push(`maintenance: restarting the computer, asked at ${s.restart_at}`);
    return { hold: true, lines };
  }
  return { hold: false, lines };
}

// ---- CLI -----------------------------------------------------------------------------------------
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  if (process.argv[2] !== 'step') {
    console.error('usage: maintenance.mjs step');
    process.exit(2);
  }
  // Outside a pass (an idle batch): this repo's running tickets are stopped through the session
  // registry and queued to resume, as a pass does.
  const qf = E.queueFile();
  let q = null;
  try { q = JSON.parse(readFileSync(qf, 'utf8')); } catch { /* no queue: nothing running */ }
  const running = Object.values(q?.tickets ?? {}).filter((t) => t.state === 'running');
  let live;
  const stop = (t) => {
    if (live === undefined) { try { live = JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8' })); } catch { live = null; } }
    return stopForWindow(t, {
      live,
      kill: (pid) => spawnSync('kill', [String(pid)]),
      setQueue: (key, fields) => { const r = run('node', [join(E.binDir(), 'queue.mjs'), 'set', key, ...fields]); return { ok: r.ok, why: lastLine(r.out) }; },
    });
  };
  console.log(JSON.stringify(await maintenance({ running, stop, selfQueue: qf })));
}
