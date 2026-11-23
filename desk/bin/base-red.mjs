#!/usr/bin/env node
// A red base: the branch the merge driver merges into, whose latest completed run of a §4 Required
// check failed. The driver reads it once per loop (`check`) and merges nothing into a red base but its
// repair ticket's PR; the pass reads the record the driver keeps and reports it once for the batch, and
// starts the repair ticket where config allows (pass.mjs).
//
//   base-red.mjs check --branch <name> [--repo <owner/name>] [--state <dir>] [--by <merger>] [--cache <file>] [--keys <k1,k2,…>]
//       one JSON line, { state: red | green | unknown | unread | none, checks?, why?, line? }, exit 0. It
//       keeps <state>/base-red.json while the base is red, removes it once it is green, unknown (no
//       check read red, so the driver merges as before) or nothing is required, and leaves it as it
//       was only when the base could not be read. So a red spell ends with the driver's hold, and the
//       next red is a spell of its own with its own since. With
//       --cache, the commits and the completed check runs it read are kept in <file> for the next loop
//       (cachedRead, read-cache.mjs). With --keys (the ticket keys of the PRs the driver may merge), a red
//       answer names in `repairs` those of them that are a repair of this base, any spell's: the pass admits
//       no second repair while one is open, so an earlier spell's repair is the one merge a later red lets in.
//
// The record, <state>/base-red.json:
//   { branch, sha, checks: [{ name, sha, url }], merges: [{ pr, ticket, sha, at }], repair_key, since, at }
// `merges` are the last MERGES_SHOWN merges the merge log holds for the repo by `--by` since the driver last
// read the base's tip green (<state>/base-green.json, written on each such read), newest first, and `since`
// when this red spell was first read. `repair_key` is this spell's own repair ticket (desk-env baseRedKey),
// so no two spells share one.
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as E from './desk-env.mjs';
import { runsState, FAILED } from './failure-class.mjs';
import { readLog } from './merge-log.mjs';
import { execGit } from './remote-git.mjs';
import { openCache } from './read-cache.mjs';
import { stepFailed } from './gate.mjs';
import { runIdFrom } from './evidence.mjs';

export const FILE = 'base-red.json';
// How many of the base's newest first-parent commits are read for a check's latest completed run.
export const WALK = 5;
export const MERGES_SHOWN = 3;
export const baseRedPath = (state) => join(state, FILE);
// When the driver last read its base green, { branch, at }, kept beside the record so a red spell names
// only the merges made since (lastMerges `after`).
export const GREEN_FILE = 'base-green.json';
export function readGreen(state, branch) {
  try { const g = JSON.parse(readFileSync(join(state, GREEN_FILE), 'utf8')); return g?.branch === branch && typeof g.at === 'string' ? g.at : null; } catch { return null; }
}
const short = (sha) => String(sha ?? '?').slice(0, 12);

export function readBaseRed(state) {
  try { const r = JSON.parse(readFileSync(baseRedPath(state), 'utf8')); return r && typeof r === 'object' && Array.isArray(r.checks) ? r : null; } catch { return null; }
}
// A running driver rewrites the record every loop it reads the base red, so one older than this was
// left by a driver that has stopped, and says nothing about the base now.
export const STALE_MS = 30 * 60 * 1000;
// The record while it is current: written within STALE_MS of `now`, and for `branch` where one is given
// (the base this batch merges into now). Else null, as for no record.
export function liveBaseRed(state, { branch = null, now = Date.now() } = {}) {
  const r = readBaseRed(state);
  if (!r || (branch != null && r.branch !== branch)) return null;
  const at = Date.parse(r.at);
  return Number.isFinite(at) && now - at <= STALE_MS ? r : null;
}

// Where a required check stands on `branch`: each one's newest completed run, read commit by commit down
// the branch's first-parent line from its tip, at most WALK commits. `read` gives
//   tip(branch) / commit(sha) -> { sha, parent } | null, runs(sha) -> [{ name, status, conclusion, url }] | null
// null meaning the read failed. -> { state: 'none' } with nothing required, { state: 'red', sha, checks }
// when any check's newest completed run failed (whatever a later read gives), { state: 'unread', why } when
// a read failed (an API error or limit: the driver holds its merges), { state: 'unknown', why } when every
// read answered but a check has a run in the walk and no completed one, else { state: 'green' }, with
// `tip_pending` when a check's newest completed run is below the tip. A required check with no run at all,
// of any status, on any commit of the walk runs only on PRs (a review gate) or not on pushes, so it is
// left out (`absent` on the answer), and the base reads by the checks that do run there; one with nothing
// else required reads unknown.
export function baseState({ required, branch, read }) {
  if (!required.length) return { state: 'none' };
  const unread = (why) => ({ state: 'unread', why });
  let c = read.tip(branch);
  if (!c) return unread(`the tip of ${branch} could not be read`);
  const tip = c.sha, left = new Set(required), red = [], seen = new Set(), onTip = new Set();
  for (let i = 0; i < WALK && c && left.size; i++) {
    const runs = read.runs(c.sha);
    // A read that fails after a check was found red leaves the base red: that failure stands.
    if (runs == null) { if (red.length) break; return unread(`the check runs on ${branch} at ${short(c.sha)} could not be read`); }
    for (const name of [...left]) {
      const mine = runs.filter((r) => r?.name === name);
      if (mine.length) seen.add(name);
      const st = runsState(mine);
      if (!st) continue;
      left.delete(name);
      if (i === 0) onTip.add(name);
      if (st === 'fail') red.push({ name, sha: c.sha, url: mine.find((r) => FAILED.has(String(r.conclusion ?? '').toLowerCase()))?.url ?? null });
    }
    if (!left.size || !c.parent || i === WALK - 1) break;
    c = read.commit(c.parent);
    if (!c) { if (red.length) break; return unread(`a commit on ${branch} could not be read`); }
  }
  if (red.length) return { state: 'red', sha: tip, checks: red };
  const absent = [...left].filter((n) => !seen.has(n)), pending = [...left].filter((n) => seen.has(n));
  if (pending.length || absent.length === required.length) return { state: 'unknown', why: `no completed run of ${(pending.length ? pending : absent).join(', ')} on the newest ${WALK} commits of ${branch}` };
  const more = absent.length ? { absent } : {};
  // Green from a commit below the tip, a check still going on it, says nothing yet of the newest merges.
  const ran = required.filter((n) => !absent.includes(n));
  return ran.every((n) => onTip.has(n)) ? { state: 'green', ...more } : { state: 'green', tip_pending: true, ...more };
}

// The last merges the merge log holds for `repo` by merger `by`, newest first. The log names no target
// branch, so `by` (the driver merging into this base, merge-driver.sh MERGER) is what keeps out merges
// other batches made into other branches; with no `by`, every merger's. With `after` (when the driver last
// read the base green, readGreen), only the merges made since, the ones that can have turned it red.
export function lastMerges(events, repo, by = null, n = MERGES_SHOWN, after = null) {
  const lc = String(repo).toLowerCase();
  const from = after == null ? NaN : Date.parse(after);
  return events.filter((e) => e.event === 'merged' && String(e.repo).toLowerCase() === lc && (by == null || e.by === by)
    && (!Number.isFinite(from) || Date.parse(e.at) > from)).slice(-n).reverse()
    .map((e) => ({ pr: Number(e.pr), ticket: e.ticket ?? null, sha: e.sha ?? null, at: e.at ?? null }));
}

const checkWords = (r) => r.checks.map((c) => `"${c.name}"${c.url ? ` (run ${c.url})` : ` at ${short(c.sha)}`}`).join(', ');
export const mergeWords = (r) => (r.merges?.length
  ? r.merges.map((m) => `#${m.pr}${m.ticket ? ` (${m.ticket})` : ''}`).join(', ')
  : 'none in the merge log');
// The driver's log line for a red base.
export const holdLine = (r) => `HOLDING on red ${r.branch}: required check ${checkWords(r)} failed on its latest run there, so no PR merges into it but its repair ${r.repair_key}'s; the last merges desk made: ${mergeWords(r)}`;

// The pass's one line for the batch. `held` the PRs it holds on it ("#12 (ABC-1)"), `repair` what became
// of the repair: { key, state } of its ticket, { key, first: why } where a rerun comes first (baseRerun),
// or { off: why no worker starts }.
export function batchLine(r, { held = [], repair }) {
  const fix = repair?.off
    ? `The repair is a change on ${r.branch} that no ticket in the batch owns, so it is not one of your own steps: ${repair.off}`
    : repair?.first
      ? `No repair ticket is admitted yet: ${repair.first}. Repair ticket ${repair.key} is admitted if it fails again`
      : `Repair ticket ${repair.key} is ${repair.state}: its PR is the one merge the driver lets into ${r.branch} until the check passes`;
  return `${r.branch} is red: ${checkWords(r)} failed on its latest run there, since ${r.since}. The merge driver merges nothing into it until that passes. ` +
    `The last merges desk made: ${mergeWords(r)}.${held.length ? ` It holds ${held.join(', ')}.` : ''} ${fix}`;
}

// The repair ticket's file ($DESK_STATE/tickets/<key>.md), which its worker reads as its ticket.
export function repairTicket(r) {
  return [
    `# ${r.repair_key}`, '',
    `Source: the autopilot pass, which read ${r.branch} red on a §4 Required check after desk's merges`, '',
    `The latest run on ${r.branch} of each check below failed, so the merge driver merges no other PR into ${r.branch} until it passes there.`, '',
    ...r.checks.map((c) => `- ${c.name}: failed at ${short(c.sha)}${c.url ? `, run ${c.url}` : ''}`), '',
    `The last merges desk made into ${r.branch}, newest first, the likeliest cause:`, '',
    ...(r.merges?.length ? r.merges.map((m) => `- PR #${m.pr}${m.ticket ? ` (${m.ticket})` : ''}${m.sha ? ` at ${short(m.sha)}` : ''}${m.at ? `, merged ${m.at}` : ''}`) : ['- none in the merge log']), '',
    'Read the failing run\'s log (gh run view), find the change that broke it, and fix it on a branch of your own with a PR into ' +
      `${r.branch}. Never revert a merge unless the fix is the revert, and never push to ${r.branch} itself.`, '',
    'Acceptance criteria:',
    ...r.checks.map((c) => `- ${c.name} passes on your PR's head, and on ${r.branch} once it merges.`),
    `- The batch's tests pass on your branch.`, '',
  ].join('\n');
}

// The triage record the repair ticket is admitted from (queue.mjs admit): a small fix with nothing to ask.
export const repairTriage = (r) => ({
  ticket: r.repair_key, type: 'Bug', status: 'To Do', summary: `${r.branch} is red on ${r.checks.map((c) => c.name).join(', ')}`,
  lane: 'A', lane_reason: `a red ${r.branch} the merge driver holds on; the failing run and the last merges are in the ticket file`,
  size: 'S', branch: `fix/${r.repair_key}`, files_in_scope: [], unknowns: [], already_met: [], links: 'n/a',
});

// A step that sets the runner up rather than building or testing the code: a dependency, browser or
// tool install, a cache restore, a checkout, GitHub's own `Set up job`, or an action named for one of them
// (`Run actions/checkout@v4`, `Run actions/setup-node@v4`, `Run actions/cache@v4`).
export const SETUP_STEP = /\b(?:install(?:s|ing)?|set ?up|setup-[\w-]+|checkout|restore|cache|npm ci)\b/i;
// The steps a run failed at that set its runner up, from `gh run view <id> --json jobs`: any of its
// jobs, so an install that failed one job explains the check downstream of it that found nothing to test.
export const setupFailed = (view) => (Array.isArray(view?.jobs) ? view.jobs : [])
  .flatMap((j) => (Array.isArray(j?.steps) ? j.steps : []).filter((x) => stepFailed(x) && SETUP_STEP.test(String(x?.name ?? ''))).map((x) => x.name));
// The jobs of a run that ended by timeout rather than by a failing assertion: a job or step whose
// conclusion is timed_out, or a failed job whose annotations say a step or the job ran out of time
// (`The action '…' has timed out after 12 minutes`, `… has exceeded the maximum execution time of …`).
// notes(jobId): the job's annotations ([{ message }]), null or undefined unread.
const TIMEOUT_LINE = /\bhas timed out after \d+ minutes?\b|\bexceeded the maximum execution time\b/i;
const ENDED = new Set(['failure', 'timed_out', 'cancelled']);
// A job re-run for a timeout that times out on the base again this soon is too slow for its limit, not
// unlucky: the repair is admitted, or the red noted on the open one, rather than a second rerun.
export const TIMEOUT_AGAIN_MS = 24 * 3600e3;
export function timedOut(view, notes = () => null) {
  return (Array.isArray(view?.jobs) ? view.jobs : []).filter((j) => {
    const c = String(j?.conclusion ?? '').toLowerCase();
    if (c === 'timed_out' || (Array.isArray(j?.steps) && j.steps.some((x) => String(x?.conclusion ?? '').toLowerCase() === 'timed_out'))) return true;
    if (!ENDED.has(c)) return false;
    const lines = notes(j?.databaseId);
    return Array.isArray(lines) && lines.some((x) => TIMEOUT_LINE.test(String(x?.message ?? '')));
  }).map((j) => j.name);
}
// The runs a red base's checks failed in, re-run once before its repair is admitted where the runner
// failed them and not the code, as a PR's red check classed runner or resource is (fix-tries.mjs): a
// setup step failed in it, a job of it timed out, or every red check is a §4 Known flaky check (flaky:
// their names).
// reran: the run ids already re-run for a red base (a rerun keeps its run's id, and a rerun still going
// can read the base green and start a new spell, so the ids and not the spell say a rerun was had).
// view(id): the run's jobs, null unread; notes(jobId): a job's annotations; status(id): { status,
// conclusion }, null unread; perm: §3 ci-rerun.
// -> { rerun: [id], why } (re-run these, admit nothing), { wait: why } (a rerun is still going, or passed
//    and the driver has yet to read it), or { admit: true, why? } (admit the repair as before).
// `timeouts` is the jobs re-run for a timeout before ({ job, at }); a rerun returns the ones it adds.
export function baseRerun(r, { reran = [], view, status, perm, notes = () => null, flaky = [], timeouts = [], now = Date.now() }) {
  // A check's run is named by its details URL (`…/actions/runs/<id>/job/<job>`).
  const ids = (r?.checks ?? []).map((c) => runIdFrom(c.url));
  if (!ids.length || ids.some((x) => !x)) return { admit: true };
  const runs = [...new Set(ids)];
  const plural = (xs) => (xs.length === 1 ? '' : 's');
  // The runs already re-run are read for how their rerun went; only the others can be re-run now.
  const had = runs.filter((x) => reran.includes(x)), fresh = runs.filter((x) => !reran.includes(x));
  if (had.length) {
    const st = had.map((x) => ({ id: x, s: status(x) }));
    // A rerun whose run cannot be read is not waited on, or a run gone for good would hold the repair for ever.
    const unread = st.filter((x) => !x.s).map((x) => x.id);
    if (unread.length) return { admit: true, why: `re-run once already, and run${plural(unread)} ${unread.join(', ')} could not be read since` };
    const going = st.filter((x) => String(x.s.status ?? '').toLowerCase() !== 'completed').map((x) => x.id);
    if (going.length) return { wait: `its failed run${plural(going)} ${going.join(', ')} ${going.length === 1 ? 'was' : 'were'} re-run once and ${going.length === 1 ? 'is' : 'are'} still going, so no repair is admitted until ${going.length === 1 ? 'it ends' : 'they end'}` };
    const again = st.filter((x) => String(x.s.conclusion ?? '').toLowerCase() !== 'success').map((x) => x.id);
    if (again.length) return { admit: true, why: `re-run once already, run${plural(again)} ${again.join(', ')} failed again` };
    if (!fresh.length) return { wait: `its re-run of run${plural(had)} ${had.join(', ')} passed, so no repair is admitted while the merge driver reads ${r.branch} again` };
  }
  // Why each run reads as the runner's, not the code's: a setup step, a timeout, or only known flaky checks.
  const allFlaky = (r.checks ?? []).length > 0 && r.checks.every((c) => flaky.includes(c.name));
  const outs = [];
  const why = fresh.map((x) => {
    if (allFlaky) return 'a §4 Known flaky check';
    const v = view(x);
    const setup = setupFailed(v), out = timedOut(v, notes);
    outs.push(...out);
    return [...(setup.length ? [`a setup step (${[...new Set(setup)].map((n) => `"${n}"`).join(', ')})`] : []), ...(out.length ? [`a timeout (${[...new Set(out)].map((n) => `"${n}"`).join(', ')})`] : [])].join(' and ');
  });
  if (!why.every(Boolean)) return { admit: true };
  const recent = new Set(timeouts.filter((t) => t?.job && now - Date.parse(t.at) < TIMEOUT_AGAIN_MS).map((t) => t.job));
  const again = [...new Set(outs)].filter((j) => recent.has(j));
  if (again.length) return { admit: true, why: `${again.map((n) => `"${n}"`).join(', ')} timed out on ${r.branch} again within ${TIMEOUT_AGAIN_MS / 3600e3} hours of a rerun for a timeout, so it is not re-run again` };
  const named = [...new Set(why)].join('; ');
  if (perm !== 'yes') return { admit: true, why: `it failed at ${named}, but config §3 ci-rerun is "${perm ?? 'no'}", so it is not re-run first` };
  const at = new Date(now).toISOString();
  return { rerun: fresh, timeouts: [...new Set(outs)].map((job) => ({ job, at })), why: `its failed run${plural(fresh)} ${fresh.join(', ')} failed at ${named}, the runner's and not the code's, so ${fresh.length === 1 ? 'it is' : 'they are'} re-run once before any repair is admitted` };
}

// The record to keep for state `s` read now, carrying `since` from the one before while it is red.
export function nextRecord(was, s, { branch, merges, at }) {
  if (s.state !== 'red') return null;
  const since = was?.branch === branch ? was.since ?? at : at;
  return { branch, sha: s.sha, checks: s.checks, merges, repair_key: E.baseRedKey(branch, since), since, at };
}

// `read` for baseState with what does not change kept in `cache` (read-cache.mjs openCache), so a driver
// whose base has not moved reads no commit and no check runs on its next loop: each commit's parent,
// and each commit's check runs once there is at least one and every one has completed. A commit with a
// run still queued or going is read again every loop until they have all completed, and so is the tip
// while any of `required` has no run on it yet: a run GitHub creates late (a workflow_run workflow, an
// app that posts its check afterwards) is pending as far as the base is concerned, and a kept list
// without it would read the tip's parent in its place. The tip is always read; a tip read that gives no
// parent (git ls-remote) takes it from commit(), kept too.
// A list holding a failure is kept only RED_KEEP_MS, not the cache's whole lifetime: a rerun of a red
// run on the same commit (by hand, or the pass's) changes it (the check-runs read, filter=latest, gives
// the rerun's newest attempt), and the driver holds every merge until it reads that, while a green list
// stays as it is.
const completed = (runs) => Array.isArray(runs) && runs.length > 0 && runs.every((r) => String(r?.status ?? '').toLowerCase() === 'completed');
export const RED_KEEP_MS = 5 * 60 * 1000;
const anyFailed = (runs) => runs.some((r) => FAILED.has(String(r?.conclusion ?? '').toLowerCase()));
export function cachedRead(read, cache, required = [], { now = Date.now() } = {}) {
  let tipSha = null;
  const keep = (c) => { if (c && cache.get(`commit:${c.sha}`) === undefined) cache.set(`commit:${c.sha}`, c.parent ?? null); return c; };
  const commit = (sha) => {
    const parent = cache.get(`commit:${sha}`);
    return parent !== undefined ? { sha, parent } : keep(read.commit(sha));
  };
  return {
    tip: (branch) => {
      const t = read.tip(branch);
      if (!t) return null;
      tipSha = t.sha;
      return t.parent === undefined ? commit(t.sha) : keep(t);
    },
    commit,
    runs: (sha) => {
      const kept = cache.get(`runs:${sha}`);
      // A bare list is a green one; one holding a failure was kept before red lists were dated, and is read again.
      if (Array.isArray(kept) && !anyFailed(kept)) return kept;
      if (kept?.red != null && now - kept.red <= RED_KEEP_MS && Array.isArray(kept.runs)) return kept.runs;
      const runs = read.runs(sha);
      if (completed(runs) && (sha !== tipSha || required.every((name) => runs.some((r) => r?.name === name)))) cache.set(`runs:${sha}`, anyFailed(runs) ? { red: now, runs } : runs);
      return runs;
    },
  };
}

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
const json = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
// Whether this checkout's origin is `repo`, so its branches are the ones base-red reads. The URL is
// read as desk-env reads it (ownerRepoFromUrl), an ssh host alias included.
const originUrl = () => { const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; };
export const originIs = (repo, url = originUrl()) => url != null && E.ownerRepoFromUrl(url)?.toLowerCase() === String(repo).toLowerCase();
// The SHA `branch` points at on origin, read with git rather than the REST API, which a driver loop
// would otherwise spend a core call on every time. Null when it cannot be read.
export function lsRemoteTip(branch, run = (args) => execGit('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })) {
  let out;
  try { out = String(run(['ls-remote', 'origin', `refs/heads/${branch}`])); } catch { return null; }
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && /^[0-9a-f]{40}$/.test(sha ?? '')) return { sha };
  }
  return null;
}
export function ghRead(repo) {
  const commit = (ref) => {
    const c = json(gh(['api', `repos/${repo}/commits/${encodeURIComponent(ref)}`, '--jq', '{sha: .sha, parent: .parents[0].sha}']));
    return /^[0-9a-f]{40}$/.test(c?.sha ?? '') ? { sha: c.sha, parent: c.parent ?? null } : null;
  };
  const viaGit = originIs(repo);
  return {
    // From origin where this checkout's origin is the repo, else (or when that read fails) the REST API.
    tip: (branch) => (viaGit ? lsRemoteTip(branch) : null) ?? commit(branch),
    commit,
    runs: (sha) => {
      const r = json(gh(['api', `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`, '--jq', '[.check_runs[] | {name, status, conclusion, url: (.details_url // .html_url)}]']));
      return Array.isArray(r) ? r : null;
    },
  };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] ?? ''; };
  if (args[0] !== 'check' || !flag('--branch')) {
    console.error('usage: base-red.mjs check --branch <name> [--repo <owner/name>] [--state <dir>] [--by <merger>] [--cache <file>] [--keys <k1,k2,…>]');
    process.exit(2);
  }
  const branch = flag('--branch');
  const repo = flag('--repo') ?? E.ghRepo();
  const state = flag('--state') ?? E.stateDir();
  const required = [].concat(E.configValues('required-checks') ?? []).filter((c) => c && !E.isNone(c));
  // A cache shared across repos would answer one repo's SHA from another's, so its keys are repo-scoped
  // by living in the repo's own state directory, which the driver passes.
  const cache = openCache(flag('--cache') || null);
  const s = required.length ? baseState({ required, branch, read: cachedRead(ghRead(repo), cache, required) }) : { state: 'none' };
  cache.save();
  const path = baseRedPath(state);
  if (s.state === 'red') {
    const merges = lastMerges(readLog(), repo, flag('--by'), MERGES_SHOWN, readGreen(state, branch));
    const rec = nextRecord(readBaseRed(state), s, { branch, merges, at: new Date().toISOString() });
    mkdirSync(state, { recursive: true });
    writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);
    const repairs = String(flag('--keys') ?? '').split(',').map((k) => k.trim()).filter((k) => k && E.isBaseRedKey(k, branch));
    console.log(JSON.stringify({ ...s, repair_key: rec.repair_key, repairs: [...new Set([rec.repair_key, ...repairs])], line: holdLine(rec) }));
  } else {
    // Unknown is no red: the driver merges as before, so the spell is over, as on a green read.
    if (s.state !== 'unread' && existsSync(path)) rmSync(path, { force: true });
    // Only a green read of the tip itself moves the mark: one from below it would pass over the merges
    // whose checks are still going, which are the ones a red read next would blame.
    if (s.state === 'green' && !s.tip_pending) { mkdirSync(state, { recursive: true }); writeFileSync(join(state, GREEN_FILE), `${JSON.stringify({ branch, at: new Date().toISOString() })}\n`); }
    console.log(JSON.stringify(s));
  }
}
