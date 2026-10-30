#!/usr/bin/env node
// The weekly maintenance window, one per computer: at config §3b "Maintenance window" (e.g.
// `Mon 06:30 UTC`) the first pass opens it, and from then every repo's pass starts no new worker and
// lets its own workers finish, stopping any still running after §3b "Maintenance drain limit
// (minutes)" with their sessions kept. Once nothing runs (or other repos' workers have been waited on
// for DRAIN_OTHERS_MIN past the limit), one pass pulls desk-skills fast-forward and installs it, runs
// the reboot check, and restarts the computer where config §3 machine-reboot is `yes` and the check
// found no blocker. At `ask` (unset), or at `yes` with FileVault the only blocker, it hands "ready to
// reboot" to the check-in digest; at `no` it stops there. Spawning resumes once the window is done, or
// after the restart at login.
//
// Every repo's pass calls maintenance() once a pass, and the supervisor's idle tick runs the CLI, so an
// idle batch still gets its window. A repo with no window row follows a window another repo opened.
// Between windows the same call installs desk-skills main once it has passed its checks (auto-release,
// below), so merged work does not wait for the window.
// The state, the record and the lock are machine-wide, in ~/.desk-autopilot/maintenance/
// (DESK_MAINT_DIR overrides): maintenance.json and maintenance.log. A window runs at most once a week,
// and one not opened within START_WITHIN_H hours of its time is missed for that week, so a computer
// that was off on Monday does not drain in the middle of Thursday.
//   node maintenance.mjs step     one step now, outside a pass (the supervisor's idle tick); prints JSON
//
// Tests stand in for the clock and the commands: DESK_MAINT_NOW (ISO), DESK_BOOT_TIME (ISO or epoch
// seconds), DESK_SOURCE_CHECKOUT (the desk-skills checkout), DESK_REBOOT_CHECK_CMD and DESK_RESTART_CMD
// (each run with sh -c).
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { takeBorrowLock, otherQueues } from './borrow.mjs';
import { readInstalled } from './installed.mjs';

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

// This repo's slug, for what the machine-wide state says about it.
const selfSlug = () => { try { return E.repoSlug(); } catch { return 'this repo'; } };

// A worker running on this computer. A cloud session (cloud-worker.mjs) runs away from it, so the
// window neither waits for one nor stops it, in any repo.
export const runningHere = (t) => t?.state === 'running' && t.location !== 'cloud';

// A queue's workers running on this computer, as rows stopForWindow can stop: its running tickets, and
// its base conflict fix while one runs (pass.mjs keeps it on the queue as `base_fix`, not as a ticket,
// and runs it in the base worktree here). A base fix the window already stopped (`resume`) is not running.
export function runningWorkers(q) {
  const rows = Object.values(q?.tickets ?? {}).filter(runningHere);
  const bf = q?.base_fix;
  if (bf?.running && !bf.resume) rows.push({ key: E.baseFixKey(q.base ?? 'base'), session_id: bf.running, base_fix: true });
  return rows;
}

// Running workers in every other repo's queue (with `self`, this repo's too) that `where` keeps, and
// the queues that cannot be read.
function othersRunning(selfQueue, { self = false, where = () => true } = {}) {
  const queues = otherQueues({ self: selfQueue });
  if (self && selfQueue && existsSync(selfQueue)) {
    try { queues.unshift({ slug: selfSlug(), q: JSON.parse(readFileSync(selfQueue, 'utf8')) }); } catch (e) { queues.unshift({ slug: selfSlug(), error: e.message }); }
  }
  const running = []; const unreadable = [];
  for (const { slug, q, error } of queues) {
    if (error) unreadable.push(`${slug}'s queue cannot be read, so its workers cannot be counted (${error})`);
    for (const t of runningWorkers(q)) if (where(t)) running.push(`${slug} ${t.key}`);
  }
  return { running, unreadable };
}

// Stops one of this repo's workers by its registry pid, with its session kept, and queues it to
// resume after the window (pass.mjs resumes `resume=maintenance` without counting it as a kill).
// `live` is the session registry (null when it could not be read), `setQueue(key, fields)` -> {ok, why}.
// A base conflict fix (runningWorkers) is stopped the same way, and its try kept open with
// `resume: 'maintenance'`, so pass.mjs resumes it as the same try rather than ending it: `setBaseFix()`
// -> {ok, why} writes that.
export function stopForWindow(t, { live, kill, setQueue, setBaseFix }) {
  if (!Array.isArray(live)) return { ok: false, why: 'the session registry could not be read' };
  const a = live.find((x) => x.sessionId === t.session_id);
  if (a && !a.pid) return { ok: false, why: `no pid for session ${t.session_id}` };
  if (a?.pid) kill(a.pid);
  const r = t.base_fix ? (setBaseFix?.() ?? { ok: false, why: 'no way to record the base fix here' })
    : setQueue(t.key, ['state=triaged', 'resume=maintenance', 'resume_why=stopped for the maintenance window']);
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

// Why the checkout cannot fast-forward to `to` as it stands, or null: commits `to` does not have (an
// install would carry them unchecked), changes to tracked files, or untracked files at a path the incoming commits write (a file there, or one under a directory they
// add). Untracked files nothing incoming touches stay where they are.
function incomingBlock(git, dir, to) {
  if (!git('merge-base', '--is-ancestor', 'HEAD', to).ok) return `${dir} has commits on main that ${short(to)} does not, so nothing was pulled or installed`;
  if (git('status', '--porcelain', '--untracked-files=no').out) return `${dir} has uncommitted changes to tracked files, so nothing was pulled or installed`;
  const untracked = git('ls-files', '--others', '--exclude-standard').out.split('\n').filter(Boolean);
  if (!untracked.length) return null;
  const incoming = git('diff', '--name-only', '--no-renames', 'HEAD', to).out.split('\n').filter(Boolean);
  const hit = untracked.filter((u) => incoming.some((p) => u === p || u.startsWith(`${p}/`) || p.startsWith(`${u}/`)));
  return hit.length ? `${dir} has untracked files the incoming commits would overwrite (${hit.slice(0, 5).join(', ')}${hit.length > 5 ? `, ${hit.length - 5} more` : ''}), so nothing was pulled or installed` : null;
}

// Fast-forward the desk-skills checkout from origin and install it, as /desk-update does: only on a
// clean `main`. With `to`, a commit already fetched, it fast-forwards to exactly that commit and only
// untracked files in its way block it. -> {ok, old, new, commits} | {ok: false, why, old}
export function updateDesk(dir = sourceCheckout(), { to = null } = {}) {
  if (!dir || !existsSync(dir)) return { ok: false, why: `no desk-skills checkout (${dir ?? `${join(E.deskHome(), 'source-checkout')} names none`})` };
  const git = (...a) => run('git', ['-C', dir, ...a]);
  const old = git('rev-parse', 'HEAD').out;
  const branch = git('branch', '--show-current').out;
  if (branch !== 'main') return { ok: false, old, why: `${dir} is on ${branch || 'a detached HEAD'}, not main, so nothing was pulled or installed` };
  const blocked = to ? incomingBlock(git, dir, to) : git('status', '--porcelain').out ? `${dir} has uncommitted changes, so nothing was pulled or installed` : null;
  if (blocked) return { ok: false, old, why: blocked };
  const pull = to ? git('merge', '--ff-only', '-q', to) : git('pull', '--ff-only', '-q', 'origin', 'main');
  if (!pull.ok) return { ok: false, old, why: `git ${to ? 'merge' : 'pull'} --ff-only failed in ${dir}: ${said(pull)}` };
  const head = git('rev-parse', 'HEAD').out;
  const commits = old === head ? 0 : Number(git('rev-list', '--count', `${old}..${head}`).out) || 0;
  const inst = run(join(dir, 'install.sh'), [], { cwd: dir, timeout: UPDATE_TIMEOUT_MS });
  if (!inst.ok) return { ok: false, old, new: head, why: `install.sh failed in ${dir}: ${said(inst)}` };
  return { ok: true, old, new: head, commits };
}

// The reboot check's summary, and what stops an unattended restart: anything heavy still running (a
// suite, a typecheck, a dev server: a session is behind it) and any worker running in another repo.
// Uncommitted and unpushed work is on disk, so a restart keeps it.
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
  return { summary, blockers, loginWait };
}

const restart = () => (process.env.DESK_RESTART_CMD
  ? shell(process.env.DESK_RESTART_CMD)
  : run('osascript', ['-e', 'tell application "System Events" to restart']));

// ---- auto-release ------------------------------------------------------------------------------
// Between windows, a pass installs desk-skills main once origin/main has moved past the installed
// commit and main's `tests` check passed on it, so merged work runs within minutes. It waits while
// any repo has a worker at Stage 7 (opening its PR), and does nothing while a window is open. Its
// state is release.json beside the window's: when origin was last fetched, the last reason recorded
// for a commit, and the last commit whose check failed with the repo that pushes it. Tests stand in for
// the check with DESK_RELEASE_CHECK_CMD (run with sh -c, the commit appended; it prints success,
// pending or failure).
export const RELEASE_CHECK = 'tests';
export const FETCH_EVERY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60 * 1000;
export const releaseFile = (dir) => join(dir, 'release.json');
const readRelease = (dir) => { try { return JSON.parse(readFileSync(releaseFile(dir), 'utf8')) ?? {}; } catch { return {}; } };
const writeRelease = (dir, s) => { mkdirSync(dir, { recursive: true }); writeFileSync(releaseFile(dir), `${JSON.stringify(s, null, 2)}\n`); };

// main's `tests` check on `sha`: {state: 'success' | 'pending' | 'failure', word} | {error}. A check
// not started yet is pending; any conclusion but success is a failure.
export function releaseCheck(dir, sha) {
  const jq = `[.check_runs[] | select(.name == "${RELEASE_CHECK}")] | sort_by(.started_at) | last | if . == null then "pending" elif .status != "completed" then "pending" else .conclusion end`;
  const r = process.env.DESK_RELEASE_CHECK_CMD
    ? shell(`${process.env.DESK_RELEASE_CHECK_CMD} ${sha}`, { cwd: dir })
    : run('gh', ['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?check_name=${RELEASE_CHECK}`, '--jq', jq], { cwd: dir, timeout: FETCH_TIMEOUT_MS });
  const word = lastLine(r.out).trim().toLowerCase();
  if (!r.ok || !word) return { error: said(r) };
  if (word === 'success') return { state: 'success', word };
  if (['pending', 'queued', 'in_progress', 'waiting', 'requested'].includes(word)) return { state: 'pending', word };
  return { state: 'failure', word };
}

// A worker at Stage 7, which may be pushing.
const atStage7 = (t) => /^7(\/|$)/.test(String(t.stage ?? '')) || (t.stage == null && String(t.handoff_stage) === '7');

// The notification for main's failed check, which release.json gives to the repo whose pass first saw
// it fail. That repo returns it from every pass while origin/main is still at that commit, whatever
// else the pass did (the lock held elsewhere, a fetch or check read failing, a window open), so
// whoever sends the pass's pushes keeps its key, sends it once, and tries again when sending failed.
export function releasePush({ dir = maintDir(), src = sourceCheckout() } = {}) {
  const n = readRelease(dir).notified;
  if (!n?.sha || !n.text || n.by !== selfSlug() || !src || !existsSync(src)) return [];
  const head = run('git', ['-C', src, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/main']).out;
  return head === n.sha ? [{ key: `release-failed-${n.sha}`, text: n.text }] : [];
}

// One step of the auto-release. -> {lines}
export async function autoRelease({ dir = maintDir(), at = now(), selfQueue = null, src = sourceCheckout() } = {}) {
  const none = { lines: [] };
  if (!src || !existsSync(src)) return none;
  mkdirSync(dir, { recursive: true });
  const lock = await takeBorrowLock({ dir, name: 'release.lock.d', waitMs: 0 });
  if (!lock.ok) return { lines: [`release: skipped, another pass is checking or installing desk-skills (${lock.why})`] };
  try {
    const s = readRelease(dir);
    const git = (...a) => run('git', ['-C', src, ...a], { timeout: FETCH_TIMEOUT_MS });
    const since = at - Date.parse(s.fetched_at ?? '');
    if (!(since >= 0 && since < FETCH_EVERY_MS)) {
      const f = git('fetch', '-q', 'origin', 'main');
      if (!f.ok) return { lines: [`release: git fetch failed in ${src}: ${said(f)}; tried again next pass`] };
      s.fetched_at = at.toISOString();
      writeRelease(dir, s);
    }
    const head = git('rev-parse', '--verify', '-q', 'refs/remotes/origin/main').out;
    const base = readInstalled()?.commit ?? git('rev-parse', 'HEAD').out;
    if (!head || head === base) return none;
    // Installed at or past origin/main (local commits on main): nothing to release.
    if (git('merge-base', '--is-ancestor', head, base).ok) return none;
    const lines = [];
    const save = () => writeRelease(dir, s);
    // A reason is recorded, and said, once per commit.
    const blocked = (why) => {
      if (s.blocked?.sha === head && s.blocked.why === why) return { lines };
      s.blocked = { sha: head, why };
      save();
      record(dir, at, `release: ${short(head)} not installed: ${why}`);
      lines.push(`release: desk-skills main ${short(head)} not installed: ${why}`);
      return { lines };
    };
    if (!git('merge-base', '--is-ancestor', base, head).ok) return blocked(`the installed commit ${short(base)} is not on origin/main, so it was not replaced; run /desk-update`);

    const c = releaseCheck(src, head);
    if (c.error) return { lines: [`release: desk-skills main ${short(head)} is ahead of the installed ${short(base)}; waiting, main's ${RELEASE_CHECK} check could not be read (${c.error})`] };
    if (c.state === 'pending') return { lines: [`release: desk-skills main ${short(head)} is ahead of the installed ${short(base)}; waiting for main's ${RELEASE_CHECK} check on it`] };
    if (c.state === 'failure') {
      const text = `desk-skills main's ${RELEASE_CHECK} check failed (${c.word}) on ${short(head)}, so it was not installed: the installed version stays at ${short(base)}`;
      lines.push(`release: ${text}`);
      if (s.notified?.sha !== head) {
        s.notified = { sha: head, by: selfSlug(), text };
        save();
        record(dir, at, `release: ${text}`);
      }
      return { lines };
    }

    const o = othersRunning(selfQueue, { self: true, where: atStage7 });
    const pushing = [...o.running.map((w) => `${w} at Stage 7`), ...o.unreadable];
    if (pushing.length) return { lines: [`release: desk-skills main ${short(head)} passed its ${RELEASE_CHECK} check; waiting to install it for ${pushing.join(', ')}`] };

    const u = updateDesk(src, { to: head });
    if (!u.ok) return blocked(u.why);
    delete s.blocked;
    save();
    record(dir, at, `release: desk-skills ${short(base)} -> ${short(u.new)} (${u.commits} commit(s)), main's ${RELEASE_CHECK} check passed: pulled fast-forward and installed`);
    lines.push(`release: desk-skills ${short(base)} -> ${short(u.new)} (${u.commits} commit(s)) installed, main's ${RELEASE_CHECK} check passed on it`);
    return { lines };
  } finally { lock.release(); }
}

// ---- one step ----------------------------------------------------------------------------------
// The window's step, then, while no window is open, the auto-release's.
// -> {hold, lines, push}: hold is true while the window holds every new spawn.
export async function maintenance(opts = {}) {
  const dir = opts.dir ?? maintDir();
  const at = opts.at ?? now();
  const m = await windowStep({ ...opts, dir, at });
  const lines = [...m.lines];
  if (!m.hold && !HOLDING.includes(readState(dir)?.phase)) lines.push(...(await autoRelease({ dir, at, selfQueue: opts.selfQueue ?? null })).lines);
  return { ...m, lines, push: releasePush({ dir }) };
}

// Moves the window on as far as it can this pass. `running` is this repo's running tickets; `stop(t)`
// stops one with its session kept and queues it to resume ({ok, pid} | {ok: false, why}).
async function windowStep({ dir = maintDir(), running = [], stop = () => ({ ok: false, why: 'no way to stop a worker here' }), selfQueue = null, at = now() } = {}) {
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
      save({ phase: 'rebooting', restart_at: at.toISOString() });
      const r = restart();
      if (!r.ok) {
        log(`restart failed: ${said(r)}`);
        note(`not restarted: the restart command failed in the maintenance window (${said(r)})`);
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
      return finish(`restarted at ${stamp(new Date(bootMs()))}`);
    }
    if (at - asked > RESTART_GRACE_MS) {
      note(`the maintenance window asked the computer to restart at ${s.restart_at}, and it did not`);
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
  // Outside a pass (an idle batch): this repo's running workers are stopped through the session
  // registry and queued to resume, as a pass does.
  const qf = E.queueFile();
  let q = null;
  try { q = JSON.parse(readFileSync(qf, 'utf8')); } catch { /* no queue: nothing running */ }
  const running = runningWorkers(q);
  let live;
  const stop = (t) => {
    if (live === undefined) { try { live = JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8' })); } catch { live = null; } }
    return stopForWindow(t, {
      live,
      kill: (pid) => spawnSync('kill', [String(pid)]),
      setQueue: (key, fields) => { const r = run('node', [join(E.binDir(), 'queue.mjs'), 'set', key, ...fields]); return { ok: r.ok, why: lastLine(r.out) }; },
      setBaseFix: () => { const r = run('node', [join(E.binDir(), 'queue.mjs'), 'set-batch', `base_fix=${JSON.stringify({ ...q.base_fix, resume: 'maintenance' })}`]); return { ok: r.ok, why: lastLine(r.out) }; },
    });
  };
  console.log(JSON.stringify(await maintenance({ running, stop, selfQueue: qf })));
}
