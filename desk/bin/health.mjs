// The health watchdog: before a pass spawns, check that this machine is still signed in to what the
// workers need and has disk to write to. Without it an expired sign-in or a full disk shows up only
// as workers failing one by one.
//
// Each check, and when it is required:
//   gh       `gh auth status --active`            always
//   jira     `desk-jira whoami`                   where §4 Tracker is jira
//   claude   `claude auth status`                 always; and in the folder of the Claude default and of
//                                                 the login this repo's Subscription row pins, where the
//                                                 subscriptions file lists it in its own folder, told
//                                                 with its sign-in command but never holding a spawn.
//                                                 A listed login whose folder does not exist is a row
//                                                 with nothing behind it, not a sign-out: named in the
//                                                 health line's notes and pushed once per machine.
//                                                 Each login whose sign-in passes also makes one real
//                                                 call (usage-probe.mjs probeNow), as a sign-in the API
//                                                 refuses (401, 403, a Cloudflare page) still passes
//                                                 `claude auth status`. A refused call fails the login;
//                                                 a passing one is not made again for 15 minutes, and
//                                                 any other outcome (a usage limit, no answer) passes
//                                                 unkept, for the pacing and stall checks to judge
//   codex    `codex login status`                 unless config §3 codex-review is no (it catches a
//                                                 sign-out, not a seat out of usage: only a real call does)
//   browser  the browser profile's saved GitHub login (github-signin.mjs), unless §3 pr-images is no.
//            It holds no spawn: only screenshot uploads need it, and the machine's upload queue runs
//            none with that login while it fails (upload-queue.mjs signedIn). It is one item for the
//            machine per login, however many repos and batches find it (browserSignins): told by the
//            first slot to find it, or one taking over from a slot whose state folder is gone, and gone
//            once a slot checking that login, not reusing an earlier pass's results, finds it passing
//   disk     free space on the worktrees disk, against config §3b "Free disk floor (GB)" (default 20)
//   database `docker exec <container> pg_isready`  where §4 Local database is `postgres container <name>`
//                                                 and setup-worktree.sh makes a per-ticket database in it
//                                                 (§3 db-per-ticket yes, §4 Database URL variable names one),
//                                                 with `docker ps` beside it: one that times out names
//                                                 the engine as the cause ("Docker not responding:
//                                                 restart OrbStack", from `docker context show`)
//   reviewer `gh api user` as the account desk    where §4 Gate reviewers names logins: the login read
//            posts verdicts from (§4 Review       must be one of them. It never holds a spawn: failing,
//            account's gh config directory, else  it holds review and fix tries on PRs red only on a
//            the default gh login)                §4 State check of kind verdict (pass.mjs), told as one
//                                                 item for the repo, a mismatch or a sign-in
//
// A check that does not answer within 20 seconds has failed, "timed out". A remote check that times
// out or cannot reach its host is a network failure: it is run once more, 5 seconds later, before it
// counts. The results are kept in <state>/health.json and, while every check passes, reused for 15
// minutes, so a pass every few minutes does not run them each time; a failing run is not reused.
//
// A pass holds every new spawn while a required check other than the browser fails (`holding`), but
// not for gh whose only failure is a used-up API limit, told in the health line with its reset time. A
// remote check is told to the person (a stall line and a push) only once it has failed on two runs in
// a row, as a blip clears by itself; the local ones (browser, disk, database) on the first. Every remote check failing together, with at
// least one of them not reaching its host, is the network, one item (`health:<slug>:network`) with no
// sign-in fix, so a CLI that words a dropped connection in a way NETWORK misses does not push its
// sign-in; only when every one of them is a refused sign-in are they the sign-ins. A network failure
// of one check names its connection, not its sign-in. Otherwise one entry per failing check
// (`health:<slug>:<id>`); whoever sends the pass's pushes sends a key once, so a check that stays
// failing is not pushed again, and one that recovers and fails again is.
//
// AUTOPILOT_HEALTH_CHECKS=off skips them (the report says so); DESK_FREE_DISK_GB stands in for the
// free-disk figure, DESK_HEALTH_TIMEOUT_MS for the 20 seconds and DESK_HEALTH_RETRY_MS for the 5,
// in tests.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as E from './desk-env.mjs';
import { parseDfAvailableGB } from './machine.mjs';
import { isDir, loginEnv, readSubscriptions, repoSubscription, signInCommand } from './logins.mjs';
import { inUse, loginKey, loginOf, workLoginDirs } from './claude-logins.mjs';
import { probeNow } from './usage-probe.mjs';
import { accountEnv } from './review-post.mjs';
import { signedIn, SIGNIN_CMD } from './upload-queue.mjs';
import { sessionFile } from './find-playwright.mjs';

export const HEALTH_TTL_MS = 15 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 20 * 1000;
export const RETRY_DELAY_MS = 5 * 1000;
// A real call starts a whole `claude -p` session, so it gets longer than a status command.
export const CALL_TIMEOUT_MS = 60 * 1000;
export const DEFAULT_DISK_FLOOR_GB = 20;
const FLOOR_ROW = E.CONFIG_ROWS['disk-floor'].row;

export const CHECKS = Object.freeze([
  { id: 'gh', name: 'GitHub CLI', cmd: ['gh', 'auth', 'status', '--active'], fix: 'gh auth login' },
  { id: 'jira', name: 'Jira', cmd: ['desk-jira', 'whoami'], fix: 'renew the Jira API token with /desk-setup' },
  { id: 'claude', name: 'Claude', cmd: ['claude', 'auth', 'status'], fix: 'claude auth login' },
  { id: 'codex', name: 'Codex', cmd: ['codex', 'login', 'status'], fix: 'codex login' },
  { id: 'browser', name: 'browser profile', fix: `${SIGNIN_CMD}, in a terminal on this machine's screen` },
  { id: 'disk', name: 'free disk' },
  { id: 'database', name: 'local database' },
]);
const byId = Object.fromEntries(CHECKS.map((c) => [c.id, c]));
const isRemote = (id) => Boolean(byId[id]?.cmd);
// Failing, these hold no spawn.
const HOLDS_NO_SPAWN = new Set(['browser']);

// What a failed command's output says when the host could not be reached, as against a refused sign-in.
// It is read over the whole output: a CLI often prints the connection error above a closing hint.
const NETWORK = /timed? ?out|timeout|could not resolve|couldn't resolve|no such host|name resolution|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|network is unreachable|connection (refused|reset)|error connecting|failed to connect|unable to connect|could not connect|could not reach|internet connection|dial tcp|offline/i;
const failureKind = (out) => (NETWORK.test(out ?? '') ? 'network' : 'auth');
// What `gh auth status` says when the token is signed in but its API limit is used up ("HTTP 403: API
// rate limit exceeded for user ID …"). That is no sign-out: it is told with its reset time and holds no spawn.
// A 401 or bad credentials beside it is a sign-out. The check reads only the active account (`--active`),
// the one desk uses, so another account's error cannot stand in for it. install.sh's gh check applies
// the same rule to the same read: change both together.
const GH_LIMIT = /rate limit exceeded/i;
const GH_SIGNED_OUT = /HTTP 401|bad credentials/i;
const ghLimited = (out) => GH_LIMIT.test(out) && !GH_SIGNED_OUT.test(out);
// A gh older than `--active` (Ubuntu 24.04's 2.45) refuses the flag, which is no sign-out: there the
// check reads every account, as it did before the flag. install.sh falls back the same way.
const GH_NO_ACTIVE = /unknown flag: --active/;
const GH_ALL_ACCOUNTS = ['gh', 'auth', 'status'];
// When the token's core API limit resets, as an ISO time, or null. The rate_limit endpoint answers
// while the limit is used up. `cmdEnv`: the account's environment, where it is not gh as it stands.
async function ghLimitReset(timeoutMs, cmdEnv) {
  const r = await runCommand(['gh', 'api', 'rate_limit', '--jq', '.resources.core.reset'], timeoutMs, cmdEnv, true);
  const at = Number(r.ok ? r.out : NaN);
  return Number.isFinite(at) && at > 0 ? new Date(at * 1000).toISOString() : null;
}

export const healthFile = (state) => join(state, 'health.json');
// One marker file per listed Claude login whose folder is missing, shared by every repo and batch on
// the machine. It holds the state folder of the slot that pushes the login, and goes once the folder
// exists.
const missingLoginsDir = () => join(E.HOME, '.desk-autopilot', 'health-missing-logins');

// Whether the slot at `state` is the one on the machine that tells what the marker `file` stands for:
// the first to find it, or the one taking over from a slot whose state folder is gone. body(prev) is
// what the marker holds, from the text it held (null when new), and owner(text) reads back the state
// folder it names. The owner lists the push on every pass, so the supervisor's own once-per-key record
// sends it once and retries a failed send; no other slot lists it. A marker it cannot read or write is
// told anyway, as a push repeated beats one never sent.
function claimsMarker(file, state, { body, owner }) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body(null), { flag: 'wx' });
    return true;
  } catch (e) { if (e.code !== 'EEXIST') return true; }
  let prev;
  try { prev = readFileSync(file, 'utf8'); } catch { return true; }
  const by = owner(prev);
  if (by && by !== state && existsSync(by)) return false;
  const next = body(prev);
  if (next !== prev) { try { writeFileSync(file, next); } catch { /* told anyway */ } }
  return true;
}
const pushesMissing = (dir, l, state) => claimsMarker(join(dir, loginKey(l)), state, { body: () => `${state}\n`, owner: (t) => t.trim() });

// Drops the marker of every login no longer missing, so a folder that goes missing again is pushed again.
function clearFound(dir, missing) {
  const keep = new Set(missing.map(loginKey));
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) if (!keep.has(n)) { try { unlinkSync(join(dir, n)); } catch { /* another pass took it */ } }
}

// Whether setup-worktree.sh makes a per-ticket database, by its rules: `container` is the Postgres
// container §4 Local database names (DESK_PG_CONTAINER stands in for the name it gives), or null;
// `none` is why no per-ticket database is made, or null when one is, so a container that does not
// answer fails every new worktree. plan-batch.mjs reads it too.
export function perTicketDb(env = process.env) {
  const raw = String(E.configValue('local-db') ?? '').trim();
  const m = /^postgres\s+container\s+([A-Za-z0-9_.-]+)$/i.exec(raw);
  const container = m ? env.DESK_PG_CONTAINER || m[1] : null;
  const why = (none) => ({ container, none });
  if (!raw || E.isNone(raw)) return why(`config §4 Local database is ${raw ? 'none' : 'unset'}`);
  if (!m) return why(`config §4 Local database is "${raw}", which is not \`postgres container <name>\``);
  if (E.permission('db-per-ticket') !== 'yes') return why(`config §3 ${E.permissionKey('db-per-ticket')} is ${E.permission('db-per-ticket')}`);
  const vars = [].concat(E.configValues('db-url-var') ?? []).filter((v) => !E.isNone(v) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(E.parseCommandItem(v).cmd));
  return why(vars.length ? null : 'config §4 Database URL variable names none');
}

// Why a check is not required here, or null when it is.
export function notRequired(id) {
  if (id === 'database') return perTicketDb().none;
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

// One command, failed on a non-zero exit, a missing binary or no answer within the timeout. `keepOut`
// returns a passing command's output; otherwise none is kept, as health.json holds what is returned.
function runCommand([cmd, ...args], timeoutMs, cmdEnv = undefined, keepOut = false) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    // Its own process group, so a timeout kills whatever it started too: a grandchild left holding the
    // pipes would keep the pass from exiting.
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...(cmdEnv ? { env: cmdEnv } : {}) }); } catch (e) { finish({ ok: false, why: e.message }); return; }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      finish({ ok: false, why: 'timed out', kind: 'network' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => finish({ ok: false, why: e.code === 'ENOENT' ? `${cmd} not found` : e.message, kind: e.code === 'ENOENT' ? 'auth' : failureKind(e.message) }));
    child.on('close', (code, signal) => {
      if (code === 0) finish(keepOut ? { ok: true, out: out.trim() } : { ok: true });
      const last = out.trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
      finish({ ok: false, why: `${last ? `${last.slice(0, 160)}; ` : ''}exited ${code ?? signal}`, kind: failureKind(out), ...(ghLimited(out) ? { limited: true } : {}), ...(GH_NO_ACTIVE.test(out) ? { noActive: true } : {}) });
    });
  });
}

// `file` is the login's session file, resolved before it is read, so a file that does not parse is
// still the item of that login, which signing it in clears.
function browserCheck() {
  let file = null;
  try {
    const profile = E.browserProfile();
    file = sessionFile(profile);
    const s = signedIn({ profile });
    return s.ok ? { ok: true, file: s.file } : { ok: false, why: s.why, file: s.file };
  } catch (e) { return { ok: false, why: file ? `the GitHub login in ${file} could not be read (${e.message})` : e.message, file }; }
}

// The machine's browser sign-in items, one per saved GitHub login (its session file, `file`) found
// failing: { id, at, why, state, slug, file }, the slot that tells it and since when. One goes once a
// slot checking that login finds it passing; a repo with its own §2 profile has its own login.
export const SIGNIN_KEY = 'health:browser-signin';
export const SIGNIN_STALL = /^health: browser profile failed: /;
const signinDir = () => join(E.HOME, '.desk-autopilot', 'health-browser-signin');
export const signinId = (file) => createHash('sha1').update(String(file ?? '')).digest('hex').slice(0, 12);
const signinFile = (file) => join(signinDir(), `${signinId(file)}.json`);
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
export function browserSignins() {
  let names = [];
  try { names = readdirSync(signinDir()).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  return names.flatMap((n) => {
    let rec = null;
    try { rec = parse(readFileSync(join(signinDir(), n), 'utf8')); } catch { /* another slot took it */ }
    return rec ? [{ ...rec, id: n.slice(0, -'.json'.length) }] : [];
  });
}
// Whether the slot at `state` tells the sign-in item of the login in `file` (claimsMarker).
const tellsSignin = (state, slug, why, now, file) => claimsMarker(signinFile(file), state, {
  owner: (t) => parse(t)?.state,
  body: (t) => `${JSON.stringify({ at: (t && parse(t)?.at) || new Date(now).toISOString(), why, state, slug, file })}\n`,
});
const clearSignin = (file) => { try { unlinkSync(signinFile(file)); } catch { /* none, or another slot took it */ } };

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
  // Local: no host to be unreachable, so never retried and never part of the network verdict.
  // `docker ps` runs beside it, so an engine that has stopped answering is named as the cause; both end
  // at the timeout, so a hung engine costs the pass one timeout, not two.
  if (id === 'database') {
    const [r, engine] = await Promise.all([runCommand(dbCmd(env), timeoutMs), runCommand(DOCKER_PROBE, timeoutMs)]);
    delete r.kind;
    if (!r.ok && !engine.ok && engine.why === 'timed out') r.engine = await engineName(timeoutMs);
    return r;
  }
  // Both tries go through this, so a limit the retry meets is still a limit, not a sign-out.
  const attempt = async () => {
    let r = await runCommand(byId[id].cmd, timeoutMs);
    if (id === 'gh' && r.noActive) r = await runCommand(GH_ALL_ACCOUNTS, timeoutMs);
    delete r.noActive;
    if (id === 'gh' && r.limited) { delete r.limited; return { ...r, kind: 'limit', reset: await ghLimitReset(timeoutMs) }; }
    delete r.limited;
    return r;
  };
  const r = await attempt();
  if (r.ok || r.kind !== 'network') return r;
  await new Promise((res) => setTimeout(res, retryMs));
  return { ...(await attempt()), retried: true };
}

// The reviewer check: null where §4 Gate reviewers names no logins. Otherwise { ok, kind, why, login,
// gate, who, fix }: `kind` is `mismatch` (the login read is not on the row), `config` (a row that does
// not read), the sign-in's `auth` or `network` failure of `gh api user` as that account, or `limit`
// (its GitHub API limit used up, with `reset`), which is noted and never told.
const REVIEWER_CMD =['gh', 'api', 'user', '--jq', '.login'];
async function reviewerCheck(env, timeoutMs, retryMs) {
  let gate, acct;
  try { gate = E.gateReviewers(); } catch (e) { return { ok: false, kind: 'config', why: e.message, fix: 'correct §4 Gate reviewers with /desk-update' }; }
  if (!gate) return null;
  try { acct = E.reviewAccount(); } catch (e) { return { ok: false, kind: 'config', gate, why: e.message, fix: 'correct §4 Review account with /desk-update' }; }
  const who = acct ? `${acct.login} (GH_CONFIG_DIR=${acct.dir})` : 'your default gh login';
  // As review-post.mjs posts: the account's config directory with no token, else gh as it stands.
  const cmdEnv = acct ? accountEnv(acct, env) : undefined;
  const run = () => runCommand(REVIEWER_CMD, timeoutMs, cmdEnv, true);
  let r = await run();
  if (!r.ok && r.kind === 'network') { await new Promise((res) => setTimeout(res, retryMs)); r = { ...(await run()), retried: true }; }
  // The account's API limit used up is no sign-in: noted, never told, and it clears at its reset.
  if (!r.ok && r.limited) return { ok: false, kind: 'limit', gate, who, why: `gh api user as ${who}: the GitHub API limit is used up`, reset: await ghLimitReset(timeoutMs, cmdEnv) };
  if (!r.ok) {
    const fix = r.kind === 'network' ? "check this machine's connection to GitHub; it is not reaching it, which is not a sign-in"
      : acct ? `sign it in, in another terminal: GH_CONFIG_DIR=${acct.dir} gh auth login` : 'gh auth login';
    return { ok: false, kind: r.kind ?? 'auth', gate, who, why: `gh api user as ${who} failed: ${r.why}`, fix };
  }
  const login = String(r.out ?? '').split('\n')[0].trim();
  if (gate.some((g) => g.toLowerCase() === login.toLowerCase())) return { ok: true, gate, login, who };
  return { ok: false, kind: 'mismatch', gate, login, who,
    why: `the review gate counts ${gate.join(', ')}; desk posts verdicts as ${login || '(no login read)'}`,
    fix: `set §4 Review account to ${gate.length === 1 ? gate[0] : `one of ${gate.join(', ')}`} with its gh config directory, or add ${login || 'that login'} to the gate's reviewer list and to §4 Gate reviewers` };
}

function readRecord(state) {
  try { return JSON.parse(readFileSync(healthFile(state), 'utf8')); } catch { return null; }
}

// The real call of a login whose sign-in passed: the one made under HEALTH_TTL_MS ago, kept in
// health.json's `calls` under `key`, or a new one. -> { refused: { status, why } | null, kept: { at } | null }
function realCall(key, login, env, prev, now) {
  const was = prev?.calls?.[key]?.at;
  const age = was ? now - Date.parse(was) : Infinity;
  if (age >= 0 && age < HEALTH_TTL_MS) return { refused: null, kept: { at: was } };
  const p = probeNow({ login, env, timeoutMs: CALL_TIMEOUT_MS });
  return { refused: p.refused ?? null, kept: p.ok ? { at: new Date(now).toISOString() } : null };
}

const REFUSED_ELSE = "if the call is still refused once signed in, the API is turning away this machine's connection (a Cloudflare page says so), which no sign-in fixes";
const dbCmd = (env = process.env) => ['docker', 'exec', perTicketDb(env).container, 'pg_isready'];
const DOCKER_PROBE = ['docker', 'ps', '-q'];
// The engine behind a hung `docker ps`, named from the current context, which docker reads locally
// without asking the engine: OrbStack for its own context, else the context's name.
async function engineName(timeoutMs) {
  const r = await runCommand(['docker', 'context', 'show'], timeoutMs, undefined, true);
  const ctx = r.ok ? String(r.out ?? '').split('\n')[0].trim() : '';
  // The `default` context names no engine of its own.
  return !ctx || ctx === 'default' ? 'Docker' : /^orbstack$/i.test(ctx) ? 'OrbStack' : ctx;
}
const notResponding = (r) => `Docker not responding: restart ${r.engine}`;
const fixOf = (id, r) => {
  if (id === 'disk') return `free space on ${r.path ?? 'the worktrees disk'}`;
  if (id === 'database' && r.engine) return `${notResponding(r)} (docker ps timed out); the queued tickets spawn on the first pass it answers`;
  if (id === 'database') return `start Docker and the container ${perTicketDb().container}; the queued tickets spawn on the first pass it answers`;
  if (r.kind === 'network') return `check this machine's connection to ${byId[id].name}; it is not reaching it, which is not a sign-in`;
  if (r.refused) return `${byId[id].fix}; ${REFUSED_ELSE}`;
  return byId[id].fix;
};
const label = (id) => {
  const cmd = id === 'database' ? dbCmd() : byId[id].cmd;
  return `${byId[id].name}${cmd ? ` (${cmd.join(' ')})` : ''}`;
};

const stallOf = (id, r) => `health: ${label(id)} failed: ${r.why} — fix: ${fixOf(id, r)}; no new worker starts until it passes`;
const pushOf = (slug, id, r) => ({ key: `health:${slug}:${id}`, text: `desk ${slug}: the ${byId[id].name} check is failing (${r.why}), so no new worker starts. Fix: ${fixOf(id, r)}` });

// A local check found failing outside the checks, as worktree setup not reaching Postgres: recorded
// as failing in <state>/health.json, so the next pass runs the checks afresh rather than reusing a
// passing run, and returned as this pass's health line, stall and push, so the hold starts now.
export function markFailed(id, why, { state = E.stateDir(), slug = E.repoSlug(), now = Date.now() } = {}) {
  const prev = readRecord(state) ?? {};
  const r = { ok: false, why };
  const failing = [...new Set([...(prev.failing ?? []), id])];
  const streak = { ...(prev.streak ?? {}), [id]: { kind: 'auth', n: (prev.streak?.[id]?.n ?? 0) + 1 } };
  mkdirSync(state, { recursive: true });
  writeFileSync(healthFile(state), `${JSON.stringify({ ...prev, at: new Date(now).toISOString(), results: { ...(prev.results ?? {}), [id]: r }, failing, streak }, null, 2)}\n`);
  return {
    line: `health: ${failing.length} check(s) failing — ${failing.join(', ')} — holding new spawns (${id} failed during worktree setup)`,
    stall: stallOf(id, r),
    push: pushOf(slug, id, r),
  };
}

// How many runs in a row each failure has lasted, by check id (and `network` for every remote check
// failing together, one of them unreachable). A failure of another kind than last run's starts again at 1.
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
    return { off: true, failing: [], holding: [], recovered: [], unconfirmed: [], stalls: [], push: [], reviewer: null, line: 'health: checks off (AUTOPILOT_HEALTH_CHECKS=off)' };
  }
  const reviewerWanted = (() => { try { return E.gateReviewers() != null; } catch { return true; } })();
  const skip = Object.fromEntries(CHECKS.map((c) => [c.id, notRequired(c.id)]).filter(([, why]) => why));
  const wanted = CHECKS.map((c) => c.id).filter((id) => !skip[id]);
  const prev = readRecord(state);
  const age = prev ? now - Date.parse(prev.at) : Infinity;
  // The Claude default and the login this repo is pinned to, where the file lists it in its own folder
  // (logins.mjs), checked as the default is: a subscription no work here runs on is not checked. A
  // listed row whose folder does not exist is a row to remove or sign in, told apart from the
  // sign-outs. A folder the file does not list counts only once signed in, so it is not told as signed out.
  const listed = (() => { try { return readSubscriptions(E.subscriptionsPath()).logins.filter((l) => l.tool === 'claude' && l.configDir && inUse(l)); } catch { return []; } })();
  const missing = listed.filter((l) => !isDir(l.dir));
  const pinned = (() => { try { return workLoginDirs((subs) => [E.thisRepoSubscription({ repoSubscription }, subs, env)]); } catch { return new Set(); } })();
  const others = listed.filter((l) => isDir(l.dir) && pinned.has(l.dir));
  const reusedLogins = others.every((l) => prev?.logins?.[loginKey(l)]?.ok);
  const reused = age >= 0 && age < HEALTH_TTL_MS && wanted.every((id) => prev.results?.[id]?.ok) && reusedLogins
    && (reviewerWanted ? prev.reviewer?.ok === true : !prev.reviewer);
  let results;
  let loginResults;
  let reviewer = null;
  let at;
  const calls = {};
  if (reused) {
    ({ results, at, logins: loginResults = {} } = prev);
    reviewer = reviewerWanted ? prev.reviewer : null;
  } else {
    const timeoutMs = Number(env.DESK_HEALTH_TIMEOUT_MS) > 0 ? Number(env.DESK_HEALTH_TIMEOUT_MS) : CHECK_TIMEOUT_MS;
    const retryMs = env.DESK_HEALTH_RETRY_MS != null && Number(env.DESK_HEALTH_RETRY_MS) >= 0 ? Number(env.DESK_HEALTH_RETRY_MS) : RETRY_DELAY_MS;
    const [ran, ranLogins, ranReviewer] = await Promise.all([
      Promise.all(wanted.map((id) => runCheck(id, env, timeoutMs, retryMs))),
      Promise.all(others.map((l) => runCommand(byId.claude.cmd, timeoutMs, loginEnv(l, env)))),
      reviewerWanted ? reviewerCheck(env, timeoutMs, retryMs) : null,
    ]);
    results = Object.fromEntries(wanted.map((id, i) => [id, ran[i]]));
    loginResults = Object.fromEntries(others.map((l, i) => [loginKey(l), ranLogins[i]]));
    // Once the rest have answered, as a real call waits on its session and would hold their timers.
    const real = (key, login, r) => {
      if (!r?.ok) return r;
      const c = realCall(key, login, env, prev, now);
      if (c.kept) calls[key] = c.kept;
      return c.refused ? { ok: false, why: `a real call was refused: ${c.refused.why}`, kind: 'auth', refused: c.refused.status } : r;
    };
    const own = (() => { try { return loginOf(env.CLAUDE_CONFIG_DIR); } catch { return null; } })();
    results.claude = real('claude', own, results.claude);
    for (const l of others) loginResults[loginKey(l)] = real(`login:${loginKey(l)}`, l, loginResults[loginKey(l)]);
    reviewer = ranReviewer;
    at = new Date(now).toISOString();
  }
  // The reviewer check holds no spawn. A connection failure is told once it has lasted two runs, as a
  // remote check's is; a mismatch, a row that does not read or a refused sign-in at once.
  const reviewerOut = reviewer && !reviewer.ok ? reviewer : null;
  const reviewerStreak = reused ? prev.reviewer_streak ?? {}
    : nextStreak({ streak: prev?.reviewer_streak ?? {} }, reviewerOut ? [{ key: 'reviewer', kind: reviewerOut.kind }] : []);
  const reviewerTold = !!reviewerOut && reviewerOut.kind !== 'limit' && (reviewerOut.kind !== 'network' || reviewerStreak.reviewer?.n >= 2);
  const failing = wanted.filter((id) => !results[id].ok);
  // A used-up GitHub API limit holds no spawn and is no sign-in item: it clears by itself at its reset.
  const limited = failing.filter((id) => results[id].kind === 'limit');
  const holding = failing.filter((id) => !HOLDS_NO_SPAWN.has(id) && !limited.includes(id));
  const remote = wanted.filter(isRemote);
  const network = remote.length > 1 && remote.every((id) => !results[id].ok) && remote.some((id) => results[id].kind === 'network');
  // The browser is told as the machine's one sign-in item for its login, below, not as this slot's.
  const units = [
    ...(network ? [{ key: 'network', kind: 'network', ids: remote }] : []),
    ...holding.filter((id) => !(network && isRemote(id))).map((id) => ({ key: id, kind: results[id].kind ?? 'auth', ids: [id] })),
  ];
  const browserOut = wanted.includes('browser') && !results.browser.ok ? results.browser : null;
  let tellsBrowser = false;
  if (browserOut) tellsBrowser = tellsSignin(state, slug, browserOut.why, now, browserOut.file);
  // Only a check run now clears the item, and only its own login's: a reused pass predates any failure
  // another slot has found since.
  // One whose profile could not be resolved names no login, so any login passing clears it.
  else if (wanted.includes('browser') && !reused && results.browser.file) { clearSignin(results.browser.file); clearSignin(null); }
  const streak = reused ? prev.streak ?? {} : nextStreak(prev, units);
  // A call the API refused is an answer, not a blip, so it is told at once.
  const told = (u) => !isRemote(u.ids[0]) || results[u.key]?.refused || (streak[u.key]?.n ?? 1) >= 2;
  const unconfirmed = units.filter((u) => !told(u)).map((u) => u.key);
  // Recovery is news only from a fresh run: a reused one is the run that reported the failure.
  const recovered = reused ? [] : [...(prev?.failing ?? []).filter((id) => byId[id] && !failing.includes(id)),
    ...(prev?.reviewer && !prev.reviewer.ok && !reviewerOut ? ['reviewer'] : [])];
  // Another login failing holds no spawn: a pass starts no worker on it. It is told with its
  // sign-in command once signed out or refused by the API, and a connection failure once it has lasted
  // two runs. A refused one is also kept out of new work (refusedIn: pass.mjs repoLogin, the decider).
  const loginsOut = others.filter((l) => !loginResults[loginKey(l)]?.ok);
  const loginStreak = reused ? prev.login_streak ?? {}
    : nextStreak({ streak: prev?.login_streak ?? {} }, loginsOut.map((l) => ({ key: loginKey(l), kind: loginResults[loginKey(l)].kind ?? 'auth' })));
  const loginTold = loginsOut.filter((l) => loginResults[loginKey(l)].kind !== 'network' || loginStreak[loginKey(l)]?.n >= 2);
  if (!reused) {
    mkdirSync(state, { recursive: true });
    const kept = others.length ? { logins: loginResults, login_streak: loginStreak } : {};
    const rev = reviewer ? { reviewer: { ...reviewer, told: reviewerTold }, ...(reviewerOut ? { reviewer_streak: reviewerStreak } : {}) } : {};
    const answered = Object.keys(calls).length ? { calls } : {};
    writeFileSync(healthFile(state), `${JSON.stringify({ at, results, failing, streak, ...kept, ...rev, ...answered }, null, 2)}\n`);
  }

  const when = reused ? `checked ${Math.round(age / 60000)} min ago, reused` : 'checked now';
  const notes = [when];
  if (failing.includes('database') && results.database.engine) notes.push(notResponding(results.database));
  if (recovered.length) notes.push(`recovered: ${recovered.join(', ')}`);
  const rechecking = [...unconfirmed, ...(reviewerOut && !reviewerTold && reviewerOut.kind !== 'limit' ? ['reviewer'] : [])];
  if (rechecking.length) notes.push(`rechecking before telling you: ${rechecking.join(', ')}`);
  const limitNote = (name, reset) => `${name}: the GitHub API limit is used up, not a sign-in${reset ? `; it resets at ${reset}` : ''}`;
  for (const id of limited) notes.push(`${limitNote(byId[id].name, results[id].reset)}; not holding spawns`);
  if (reviewerOut?.kind === 'limit') notes.push(`${limitNote('reviewer', reviewerOut.reset)}; not holding review or fix tries`);
  if (reviewerTold) notes.push(`reviewer failing, holding review and fix tries on PRs red only on a verdict state check, not spawns`);
  if (browserOut) notes.push(`browser failing, not holding spawns: every repo's screenshot uploads with that login wait in the machine's upload queue${tellsBrowser ? '' : `, told once for the machine by ${browserSignins().find((s) => s.id === signinId(browserOut.file))?.slug ?? 'another slot'}'s pass`}`);
  // A repo with no Postgres container has no database to check, so it is not named as skipped.
  const skipped = Object.entries(skip).filter(([id]) => id !== 'database' || perTicketDb(env).container).map(([id, why]) => `${byId[id].name} (${why})`);
  if (skipped.length) notes.push(`not required: ${skipped.join(', ')}`);
  const refusedOut = loginsOut.filter((l) => loginResults[loginKey(l)].refused);
  const signedOutOrUnreached = loginsOut.filter((l) => !refusedOut.includes(l));
  if (signedOutOrUnreached.length) notes.push(`claude login${signedOutOrUnreached.length > 1 ? 's' : ''} ${signedOutOrUnreached.map((l) => l.name).join(', ')} failing, not holding spawns`);
  if (refusedOut.length) notes.push(`claude login${refusedOut.length > 1 ? 's' : ''} ${refusedOut.map((l) => l.name).join(', ')} refused by the API, no new worker or decider starts on ${refusedOut.length > 1 ? 'them' : 'it'}`);
  // The default is removed only once another login is the default.
  const missingFix = (l) => `${l.stored === 'default' ? 'make another login the default (desk-env logins default claude <name>) and then ' : ''}remove its row (desk-env logins remove claude ${l.name}) or sign it in (${signInCommand(l)})`;
  for (const l of missing) notes.push(`claude login ${l.name} listed at ${l.folder}, which does not exist: ${missingFix(l)}`);
  const line = !failing.length ? `health: all checks pass (${notes.join('; ')})`
    : `health: ${failing.length} check(s) failing — ${failing.join(', ')}${network ? ', every remote check: the network' : ''} — ${holding.length ? 'holding new spawns' : 'not holding spawns'} (${notes.join('; ')})`;
  const shown = units.filter(told);
  const stalls = shown.map((u) => (u.key === 'network'
    ? `health: every remote check failed (${u.ids.map((id) => `${id}: ${results[id].why}`).join('; ')}) — this machine looks offline, not signed out: check its network connection; no new worker starts until they pass`
    : stallOf(u.key, results[u.key])));
  const push = shown.map((u) => (u.key === 'network'
    ? { key: `health:${slug}:network`, text: `desk ${slug}: every remote check is failing (${u.ids.join(', ')}), so this machine looks offline rather than signed out, and no new worker starts. Fix: check its network connection` }
    : pushOf(slug, u.key, results[u.key])));
  for (const l of loginTold) {
    const r = loginResults[loginKey(l)];
    const out = r.kind === 'network' ? `could not reach Claude (${r.why})` : r.refused ? `is refused by the Claude API (${r.why})` : `is signed out (${r.why})`;
    const fix = r.kind === 'network' ? "check this machine's connection to Claude"
      : `sign it in, in another terminal: ${signInCommand(l)}${r.refused ? `; ${REFUSED_ELSE}` : ''}`;
    stalls.push(`health: Claude login ${l.name} (${l.folder}) ${out} — ${fix}; ${r.refused ? 'no new worker or decider starts on it' : 'spawns are not held for it'}`);
    push.push({ key: `health:${slug}:claude:${loginKey(l)}`, text: `desk ${slug}: Claude login ${l.name} ${out}. Fix: ${fix}` });
  }
  if (tellsBrowser) {
    stalls.push(`health: ${label('browser')} failed: ${browserOut.why} — fix: ${byId.browser.fix}; every repo's screenshot uploads with that login wait in the machine's upload queue until it passes, and new workers still start`);
    push.push({ key: `${SIGNIN_KEY}:${signinId(browserOut.file)}`, text: `desk: the browser profile's GitHub login is not signed in (${browserOut.why}), so every repo's screenshot uploads with that login wait in the machine's upload queue; workers still start. Fix: ${byId.browser.fix}` });
  }
  const missingDir = missingLoginsDir();
  clearFound(missingDir, missing);
  for (const l of missing.filter((m) => pushesMissing(missingDir, m, state))) {
    push.push({ key: `health:claude-missing:${loginKey(l)}`, text: `desk: Claude login ${l.name} is listed at ${l.folder}, which does not exist, so no worker uses it. Fix: ${missingFix(l)}` });
  }
  let held = null;
  if (reviewerTold) {
    held = reviewerItem(slug, reviewerOut);
    const words = `${HELD_WORDS}${reviewerOut.kind === 'mismatch' ? MISMATCH_WORDS : ''}`;
    stalls.push(`health: reviewer: ${reviewerOut.why} — fix: ${reviewerOut.fix}; ${words}`);
    push.push({ key: held.key, text: `desk ${slug}: ${held.signin ? `the account desk posts review verdicts from cannot be read (${reviewerOut.why})` : reviewerOut.why}, so ${words}. Fix: ${reviewerOut.fix}` });
  }
  return { off: false, reused, at, results, failing, holding, recovered, unconfirmed, notRequired: skip, line, stalls, push, reviewer: held, logins: loginResults };
}

// Why a health run (`rec`: health()'s result or its health.json record) found the API refusing a real
// call on `login`, or null. A login with a config folder is judged by its own result; the caller's
// login (`own`, or a null `login`) by the `claude` check's, which ran on it; any other was not called.
// A pass starts no new worker on that login, and the supervisor no decider.
export function refusedIn(rec, login, own) {
  const r = (login?.configDir && rec?.logins?.[loginKey(login)])
    || (!login || (own && login.dir === own.dir) ? rec?.results?.claude : null);
  return r && !r.ok && r.refused ? r.why : null;
}
// The same, read from the last health run at `state`.
export const refusedLogin = (state, login, own) => refusedIn(readRecord(state), login, own);

const HELD_WORDS = 'no PR red only on a §4 State check of kind verdict gets a review or fix try until it passes, except a fix for a review at its head with findings, and build workers still start';
// A mismatch still lets through the review the merge driver needs (pass/fix-tries.mjs heldReview): it
// counts desk's verdict though the gate does not.
export const MISMATCH_WORDS = ', except the review a head with no clean verdict needs, which the merge driver counts though the gate does not';
// The repo item a failing reviewer check is told as, and that holds a PR's tries: a sign-in failure is
// a sign-in item of its own, not a mismatch. { key, signin, why, fix, ... the check's result }.
export function reviewerItem(slug, r) {
  const signin = r.kind === 'auth' || r.kind === 'network';
  return { ...r, signin, key: `health:${slug}:${signin ? 'reviewer-signin' : 'reviewer'}` };
}
// The reviewer check as the last health run at `state` recorded it: null where it recorded none, or
// the slug's §4 Gate reviewers no longer names logins. { at, item }: `item` is the told failure's
// repo item, else null.
export function reviewerRecord(state, slug) {
  const rec = readRecord(state);
  const r = rec?.reviewer;
  if (!r) return null;
  try { if (E.repoGateReviewers(slug) == null) return null; } catch { /* a row that does not read is still told */ }
  return { at: rec.at, item: !r.ok && r.told ? reviewerItem(slug, r) : null };
}
