// The health watchdog: before a pass spawns, check that this machine is still signed in to what the
// workers need and has disk to write to. Without it an expired sign-in or a full disk shows up only
// as workers failing one by one.
//
// Each check, and when it is required:
//   gh       `gh auth status`                     always
//   jira     `desk-jira whoami`                   where §4 Tracker is jira
//   claude   `claude auth status`                 always
//   codex    `codex login status`                 unless config §3 codex-review is no (it catches a
//                                                 sign-out, not a seat out of usage: only a real call does)
//   browser  the browser profile's saved GitHub login (github-signin.mjs), unless §3 pr-images is no
//   disk     free space on the worktrees disk, against config §3b "Free disk floor (GB)" (default 20)
//
// A check that does not answer within 20 seconds has failed, "timed out". A remote check that times
// out or cannot reach its host is a network failure: it is run once more, 5 seconds later, before it
// counts. The results are kept in <state>/health.json and, while every check passes, reused for 15
// minutes, so a pass every few minutes does not run them each time; a failing run is not reused.
//
// A pass holds every new spawn while a required check fails. A remote check is told to the person
// (a stall line and a push) only once it has failed on two runs in a row, as a blip clears by
// itself; the local ones (browser, disk) on the first. Every remote check failing together is the
// network, one item (`health:<slug>:network`) with no sign-in fix; a network failure of one check
// names its connection, not its sign-in. Otherwise one entry per failing check
// (`health:<slug>:<id>`); whoever sends the pass's pushes sends a key once, so a check that stays
// failing is not pushed again, and one that recovers and fails again is.
//
// AUTOPILOT_HEALTH_CHECKS=off skips them (the report says so); DESK_FREE_DISK_GB stands in for the
// free-disk figure, DESK_HEALTH_TIMEOUT_MS for the 20 seconds and DESK_HEALTH_RETRY_MS for the 5,
// in tests.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as E from './desk-env.mjs';
import { loginState } from './find-playwright.mjs';
import { parseDfAvailableGB } from './machine.mjs';

export const HEALTH_TTL_MS = 15 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 20 * 1000;
export const RETRY_DELAY_MS = 5 * 1000;
export const DEFAULT_DISK_FLOOR_GB = 20;
const FLOOR_ROW = E.CONFIG_ROWS['disk-floor'].row;

export const CHECKS = Object.freeze([
  { id: 'gh', name: 'GitHub CLI', cmd: ['gh', 'auth', 'status'], fix: 'gh auth login' },
  { id: 'jira', name: 'Jira', cmd: ['desk-jira', 'whoami'], fix: 'renew the Jira API token with /desk-setup' },
  { id: 'claude', name: 'Claude', cmd: ['claude', 'auth', 'status'], fix: 'claude auth login' },
  { id: 'codex', name: 'Codex', cmd: ['codex', 'login', 'status'], fix: 'codex login' },
  { id: 'browser', name: 'browser profile', fix: 'node ~/.claude/desk/bin/github-signin.mjs' },
  { id: 'disk', name: 'free disk' },
]);
const byId = Object.fromEntries(CHECKS.map((c) => [c.id, c]));
const isRemote = (id) => Boolean(byId[id]?.cmd);

// What a failed command's output says when the host could not be reached, as against a refused sign-in.
const NETWORK = /timed? ?out|timeout|could not resolve|couldn't resolve|no such host|name resolution|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|network is unreachable|connection (refused|reset)|error connecting|failed to connect|unable to connect|could not connect|internet connection|dial tcp|offline/i;
export const failureKind = (why) => (NETWORK.test(why ?? '') ? 'network' : 'auth');

export const healthFile = (state) => join(state, 'health.json');

// Why a check is not required here, or null when it is.
export function notRequired(id) {
  const off = (perm) => ['no', 'never'].includes(E.permission(perm));
  if (id === 'jira') {
    const t = (E.configValue('tracker') ?? '').trim().toLowerCase();
    return t === 'jira' ? null : `§4 Tracker is "${t || 'unset'}"`;
  }
  if (id === 'codex' && off('codex-review')) return `config §3 ${E.permissionKey('codex-review')} is "${E.permission('codex-review')}"`;
  if (id === 'browser' && off('pr-images')) return `config §3 ${E.permissionKey('pr-images')} is "${E.permission('pr-images')}"`;
  return null;
}

// Config §3b "Free disk floor (GB)": a whole number of GB, `none`/`0` for no floor, unset is 20.
export function diskFloor(raw = E.configValue('disk-floor')) {
  if (raw == null) return { gb: DEFAULT_DISK_FLOOR_GB };
  if (E.isNone(raw)) return { gb: 0 };
  const v = String(raw).trim();
  if (/^\d+$/.test(v)) return { gb: Number(v) };
  return { bad: `config §3b "${FLOOR_ROW}" is "${raw}" — want a whole number of GB` };
}

// One command, failed on a non-zero exit, a missing binary or no answer within the timeout.
function runCommand([cmd, ...args], timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    // Its own process group, so a timeout kills whatever it started too: a grandchild left holding the
    // pipes would keep the pass from exiting.
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true }); } catch (e) { finish({ ok: false, why: e.message }); return; }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      finish({ ok: false, why: 'timed out' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => finish({ ok: false, why: e.code === 'ENOENT' ? `${cmd} not found` : e.message }));
    child.on('close', (code, signal) => {
      if (code === 0) finish({ ok: true });
      const last = out.trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
      finish({ ok: false, why: `${last ? `${last.slice(0, 160)}; ` : ''}exited ${code ?? signal}` });
    });
  });
}

function browserCheck() {
  try {
    const s = loginState(E.browserProfile());
    if (s.status === 'ok') return { ok: true };
    return { ok: false, why: s.status === 'expired' ? `the GitHub login in ${s.file} expired at ${s.expiredAt}` : `no GitHub login in ${s.file}` };
  } catch (e) { return { ok: false, why: e.message }; }
}

function diskCheck(env) {
  const floor = diskFloor();
  if (floor.bad) return { ok: false, why: floor.bad };
  let path;
  try { path = E.worktreesDir(); } catch { path = E.stateDir(); }
  while (path && !existsSync(path)) path = path.replace(/\/[^/]*$/, '');
  path ||= '/';
  let gb;
  if (env.DESK_FREE_DISK_GB != null && env.DESK_FREE_DISK_GB !== '') gb = Number(env.DESK_FREE_DISK_GB);
  else {
    const r = spawnSync('df', ['-k', path], { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS });
    gb = r.status === 0 ? parseDfAvailableGB(r.stdout) : 'unknown';
  }
  if (!Number.isFinite(gb)) return { ok: false, why: `could not read the free space on ${path}` };
  if (gb < floor.gb) return { ok: false, why: `${gb} GB free on ${path}, under the ${floor.gb} GB floor (config §3b "${FLOOR_ROW}")`, gb, floor: floor.gb, path };
  return { ok: true, gb, floor: floor.gb, path };
}

async function runCheck(id, env, timeoutMs, retryMs) {
  if (id === 'browser') return browserCheck();
  if (id === 'disk') return diskCheck(env);
  const r = await runCommand(byId[id].cmd, timeoutMs);
  if (r.ok || failureKind(r.why) !== 'network') return r.ok ? r : { ...r, kind: 'auth' };
  await new Promise((res) => setTimeout(res, retryMs));
  const again = await runCommand(byId[id].cmd, timeoutMs);
  return again.ok ? { ...again, retried: true } : { ...again, kind: failureKind(again.why), retried: true };
}

function readRecord(state) {
  try { return JSON.parse(readFileSync(healthFile(state), 'utf8')); } catch { return null; }
}

const fixOf = (id, r) => {
  if (id === 'disk') return `free space on ${r.path ?? 'the worktrees disk'}`;
  if (r.kind === 'network') return `check this machine's connection to ${byId[id].name}; it is not reaching it, which is not a sign-in`;
  return byId[id].fix;
};
const label = (id) => `${byId[id].name}${byId[id].cmd ? ` (${byId[id].cmd.join(' ')})` : ''}`;

// How many runs in a row each failure has lasted, by check id (and `network` for every remote check
// failing together). A failure of another kind than last run's starts again at 1.
function nextStreak(prev, units) {
  const was = prev?.streak ?? Object.fromEntries((prev?.failing ?? []).map((id) => [id, { kind: prev.results?.[id]?.kind ?? 'auth', n: 1 }]));
  return Object.fromEntries(units.map(({ key, kind }) => [key, { kind, n: was[key]?.kind === kind ? was[key].n + 1 : 1 }]));
}

// Run the checks, or reuse the last run's results while they all passed under 15 minutes ago, and
// say what a pass does with them: `failing` holds spawns, `line` is the report's one health line,
// `stalls` the lines naming each failure told to the person and its fix, `push` one entry for each,
// and `unconfirmed` the remote failures rechecked before they are told.
export async function health({ state = E.stateDir(), slug = E.repoSlug(), now = Date.now(), env = process.env } = {}) {
  if (/^off$/i.test(env.AUTOPILOT_HEALTH_CHECKS ?? '')) {
    return { off: true, failing: [], recovered: [], unconfirmed: [], stalls: [], push: [], line: 'health: checks off (AUTOPILOT_HEALTH_CHECKS=off)' };
  }
  const skip = Object.fromEntries(CHECKS.map((c) => [c.id, notRequired(c.id)]).filter(([, why]) => why));
  const wanted = CHECKS.map((c) => c.id).filter((id) => !skip[id]);
  const prev = readRecord(state);
  const age = prev ? now - Date.parse(prev.at) : Infinity;
  const reused = age >= 0 && age < HEALTH_TTL_MS && wanted.every((id) => prev.results?.[id]?.ok);
  let results;
  let at;
  if (reused) ({ results, at } = prev);
  else {
    const timeoutMs = Number(env.DESK_HEALTH_TIMEOUT_MS) > 0 ? Number(env.DESK_HEALTH_TIMEOUT_MS) : CHECK_TIMEOUT_MS;
    const retryMs = env.DESK_HEALTH_RETRY_MS != null && Number(env.DESK_HEALTH_RETRY_MS) >= 0 ? Number(env.DESK_HEALTH_RETRY_MS) : RETRY_DELAY_MS;
    const ran = await Promise.all(wanted.map((id) => runCheck(id, env, timeoutMs, retryMs)));
    results = Object.fromEntries(wanted.map((id, i) => [id, ran[i]]));
    at = new Date(now).toISOString();
  }
  const failing = wanted.filter((id) => !results[id].ok);
  const remote = wanted.filter(isRemote);
  const network = remote.length > 1 && remote.every((id) => failing.includes(id));
  const units = [
    ...(network ? [{ key: 'network', kind: 'network', ids: remote }] : []),
    ...failing.filter((id) => !(network && isRemote(id))).map((id) => ({ key: id, kind: results[id].kind ?? 'auth', ids: [id] })),
  ];
  const streak = reused ? prev.streak ?? {} : nextStreak(prev, units);
  const told = (u) => !isRemote(u.ids[0]) || (streak[u.key]?.n ?? 1) >= 2;
  const unconfirmed = units.filter((u) => !told(u)).map((u) => u.key);
  // Recovery is news only from a fresh run: a reused one is the run that reported the failure.
  const recovered = reused ? [] : (prev?.failing ?? []).filter((id) => byId[id] && !failing.includes(id));
  if (!reused) {
    mkdirSync(state, { recursive: true });
    writeFileSync(healthFile(state), `${JSON.stringify({ at, results, failing, streak }, null, 2)}\n`);
  }

  const when = reused ? `checked ${Math.round(age / 60000)} min ago, reused` : 'checked now';
  const notes = [when];
  if (recovered.length) notes.push(`recovered: ${recovered.join(', ')}`);
  if (unconfirmed.length) notes.push(`rechecking before telling you: ${unconfirmed.join(', ')}`);
  const skipped = Object.entries(skip).map(([id, why]) => `${byId[id].name} (${why})`);
  if (skipped.length) notes.push(`not required: ${skipped.join(', ')}`);
  const line = failing.length
    ? `health: ${failing.length} check(s) failing — ${failing.join(', ')}${network ? ', every remote check: the network' : ''} — holding new spawns (${notes.join('; ')})`
    : `health: all checks pass (${notes.join('; ')})`;
  const shown = units.filter(told);
  const stalls = shown.map((u) => (u.key === 'network'
    ? `health: every remote check failed (${u.ids.map((id) => `${id}: ${results[id].why}`).join('; ')}) — this machine looks offline, not signed out: check its network connection; no new worker starts until they pass`
    : `health: ${label(u.key)} failed: ${results[u.key].why} — fix: ${fixOf(u.key, results[u.key])}; no new worker starts until it passes`));
  const push = shown.map((u) => (u.key === 'network'
    ? { key: `health:${slug}:network`, text: `desk ${slug}: every remote check is failing (${u.ids.join(', ')}), so this machine looks offline rather than signed out, and no new worker starts. Fix: check its network connection` }
    : { key: `health:${slug}:${u.key}`, text: `desk ${slug}: the ${byId[u.key].name} check is failing (${results[u.key].why}), so no new worker starts. Fix: ${fixOf(u.key, results[u.key])}` }));
  return { off: false, reused, at, results, failing, recovered, unconfirmed, notRequired: skip, line, stalls, push };
}
