#!/usr/bin/env node
// The one definition of "green" (desk-config.md, Rules: "Green means one thing everywhere"), and the
// merge-hold test, shared by merge-driver.sh and desk-clearance's clearance-state.mjs so the two can
// never disagree about whether a PR may merge.
//
// Green, on the exact head commit being merged:
//   1. every §4 Required check completed with success, or skipped as branch protection counts it
//      (neutral or absent does not count);
//   2. no other check failed, errored, timed out, was cancelled, or is still queued or running,
//      unless §4 Advisory checks names it; and no workflow run for that commit is still in flight;
//   3. at least one check completed with success.
// The merge is then pinned to that commit with `--match-head-commit <sha>`.
//
// Library:
//   evaluateGate(checks, { required, advisory, runs, untriggered }) -> { state, reasons, failing, pending, succeeded, untriggered }
//     checks: normalised { name, status: 'queued'|'in_progress'|'completed', conclusion, runId }
//     state:  'pass' | 'fail' | 'pending' | 'absent'
//   untriggeredChecks(required, base, workflows, { branch }) -> { <check>: <why> } the required checks
//     no workflow runs on a PR into base from branch (its trigger filters), for evaluateGate's `untriggered`
//   staleTriggers(untriggered, base, { branch, atBase, atDefault, defaultBranch }) -> { untriggered, behind, reopen }
//     that map split by whether the base's or the default branch's copy of the workflows runs each check
//   baseUntriggered(required, base, { branches, atBase, atDefault, defaultBranch }) -> { <check>: <why> }
//     at a batch's admission, the required checks no copy runs on PRs into base from those branches
//   admissionRefusal(base, { required, branches, defaultBranch, repo, run }) -> why or null
//     that check against the workflows on GitHub, worded as a refused epic admission or batch start
//   readWorkflows({ repo, ref, run }) -> [{ file, text }] the repo's .github/workflows at ref
//   normaliseRollup(nodes)   statusCheckRollup / GraphQL context nodes -> checks
//   parseHolds(items)        §4 Merge holds items `<glob>[#<key>]: <why>` -> [{ glob, path, key, why }]
//   matchHolds(files, holds, contents) -> [{ glob, why, files }]
//   readKeyedFiles({ repo, base, head, files, holds, run }) -> contents, for the `#<key>` holds
//   parseFlaky(items)        §4 Known flaky checks items `<check>: <glob> [<glob>…]` -> { flaky, errors }
//   flakyWaiver(checks, { required, advisory, runs, flaky, files }) -> null | { applies, reason, checks, hits }
//   skippedOnly(checks)      every check finished, at least one was skipped, and the rest passed
//   isBot(author)            a PR author, reviewer or commenter ({ login, __typename? }) that is a bot
//   isHuman(author, self)    one that is neither a bot nor `self`
//
// CLI (merge-driver.sh):
//   node gate.mjs pr <number> [--repo owner/name]   one JSON object: sha, base, head, mergeState,
//     reviewDecision, gate (as above, plus failedRuns: run ids of failing non-advisory checks), holds,
//     defaultBranch (§0), holdsApply (the PR's base is that branch, so its holds hold it),
//     waiver (flakyWaiver's verdict, with the failing run ids of the checks it would waive)
//   node gate.mjs holds <file-with-paths>          print each matching hold as `<glob>\t<why>\t<n files>`
//     (with no diff to read, a `#<key>` hold on a listed file holds)
//   node gate.mjs flaky                            print each known flaky check as `<check>\t<globs>`;
//     exit 1 naming the row when it does not parse
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseWorkflow, branchEvents, checkNameOf, checkIsJob } from './desk-ci.mjs';

export const FAILED = new Set(['failure', 'error', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
// A required check passes as branch protection passes it: success, or a job its workflow skipped by
// `if:`. A head whose every check was skipped still fails clause 3 (no success).
const REQUIRED_PASS = new Set(['success', 'skipped']);
const lc = (s) => String(s ?? '').toLowerCase();

// The services that comment on PRs under a login of their own. A personal-token bot goes here too,
// for desk-clearance and the pass alike.
export const BOT_LOGINS = new Set(['github-actions', 'vercel', 'chromatic', 'codecov', 'dependabot', 'renovate']);
export const isBot = (a) => !a?.login || a.__typename === 'Bot' || /\[bot\]$/.test(a.login) || BOT_LOGINS.has(lc(a.login));
// A person other than `self` (a login, in any case; with none, every person counts).
export const isHuman = (a, self) => !isBot(a) && !(self && lc(a.login) === lc(self));

// One check or status context, whatever API it came from, to { name, status, conclusion, runId }.
//   CheckRun (GraphQL / gh --json statusCheckRollup): name, status, conclusion, detailsUrl
//   StatusContext: context, state (SUCCESS FAILURE ERROR PENDING EXPECTED)
//   gh pr checks --json: name, state, bucket (pass fail pending skipping cancel)
export function normaliseCheck(c) {
  const name = c.name || c.context || '';
  const runId = /\/actions\/runs\/(\d+)/.exec(c.detailsUrl || c.link || c.targetUrl || '')?.[1] ?? null;
  if (c.bucket) {
    const b = lc(c.bucket);
    if (b === 'pending') return { name, status: 'in_progress', conclusion: null, runId };
    const conclusion = { pass: 'success', fail: 'failure', skipping: 'skipped', cancel: 'cancelled' }[b] ?? b;
    return { name, status: 'completed', conclusion, runId };
  }
  if (c.context !== undefined && c.state !== undefined && !c.status) {
    const s = lc(c.state);
    if (s === 'pending' || s === 'expected') return { name, status: 'in_progress', conclusion: null, runId };
    return { name, status: 'completed', conclusion: s, runId };
  }
  const status = lc(c.status);
  if (status && status !== 'completed') return { name, status: status === 'queued' ? 'queued' : 'in_progress', conclusion: null, runId };
  return { name, status: 'completed', conclusion: lc(c.conclusion) || null, runId };
}
export const normaliseRollup = (nodes) => (nodes || []).filter((n) => n && (n.name || n.context)).map((n) => ({
  ...normaliseCheck(n), workflow: n.workflowName ?? null, startedAt: n.startedAt ?? null, completedAt: n.completedAt ?? null,
}));

// The latest run of each check, as GitHub's own `gh pr checks` and branch protection read it.
// statusCheckRollup keeps EVERY check run on the head commit, so a check that failed and then passed
// in a later workflow run (a PR closed and reopened, a new pull_request event) appears twice. Counting
// the old failure kept a green PR red, and listed the superseded run for a rerun, which replays the
// old event payload and fails again. Grouped by workflow and name; the newest start wins, and a
// check not yet started (queued) is newer than any that has; ties go to the higher run id. Checks
// with no run id (status contexts, external apps) are kept as they are: GitHub already reports only
// the latest state of a status context.
export function latestPerCheck(checks) {
  const keep = [];
  const best = new Map();
  const when = (c) => (c.status === 'queued' && !c.startedAt ? Infinity : Date.parse(c.startedAt ?? '') || 0);
  const newer = (a, b) => when(a) !== when(b) ? when(a) > when(b) : Number(a.runId) > Number(b.runId);
  for (const c of checks) {
    if (!c.runId) { keep.push(c); continue; }
    const k = `${c.workflow ?? ''}\u0000${c.name}`;
    const cur = best.get(k);
    if (!cur || newer(c, cur)) best.set(k, c);
  }
  return [...keep, ...best.values()];
}

// Every check finished, at least one was skipped and the rest passed: on a draft, that is CI that
// does not run there (a workflow that skips drafts), not a check to fix. Undrafting it runs them.
export function skippedOnly(allChecks) {
  const checks = latestPerCheck(allChecks ?? []);
  return checks.some((c) => c.conclusion === 'skipped') && checks.every((c) => c.status === 'completed' && ['success', 'skipped'].includes(c.conclusion));
}
export const SKIPPED_ON_DRAFT = 'CI does not run on a draft, so its checks were skipped';

// ---- Workflow triggers -------------------------------------------------------------------------
// A required check that never reported may be one its workflow never runs on the PR's base: a workflow
// filtered to `pull_request: branches: [main]` reports nothing on a PR into a feature base, so no
// re-run can help. The workflow is read with desk-ci.mjs's scanner (branchEvents). Anything it cannot
// read counts as running everywhere, so the gate never blames a trigger it did not read.

// GitHub's branch filter patterns: `*` stops at `/`, `**` does not, `+` and `?` repeat the character
// before them, and a later `!pattern` takes back what earlier ones matched. A pattern that does not
// compile counts as matching.
const branchRe = (p) => new RegExp(`^${p.replace(/[.^${}()|\\]/g, '\\$&').replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*'))}$`);
export function branchMatches(patterns, branch) {
  let hit = false;
  for (const p of patterns ?? []) {
    const neg = p.startsWith('!');
    let re;
    try { re = branchRe(neg ? p.slice(1) : p); } catch { return true; }
    if (re.test(branch)) hit = !neg;
  }
  return hit;
}
const filterHits = (e, ref) => (e.branches ? branchMatches(e.branches, ref) : e.ignore ? !branchMatches(e.ignore, ref) : true);
const filterText = (e) => (e.branches ? `only into ${e.branches.join(', ')}` : `except into ${e.ignore.join(', ')}`);
// Whether a workflow may report on a PR into `base` from `branch`. pull_request_target takes its
// trigger from the base branch's copy, not the head's read here, and a push to the PR's branch reports
// on its head too (with no branch to test, any filtered push counts).
const mayRun = (t, base, branch) => !t || t.called || t.events.some((e) => e.unread || e.event === 'pull_request_target'
  || (e.event === 'pull_request' && filterHits(e, base))
  || (e.event === 'push' && (branch == null ? true : filterHits(e, branch))));

// The required checks no workflow runs on a PR into `base`, as { <check>: <why> }. workflows: [{ file,
// text }] at the PR's head; branch: its head branch, for push triggers. A check is a workflow's when
// one of its jobs reports under that name (desk-ci.mjs checkIsJob). One that no readable workflow
// reports (an app's, a status context) is left out, since nothing here says it will not run, and so is
// every check when a workflow does not read.
const readCopy = (workflows) => (workflows ?? []).map((w) => { const wf = parseWorkflow(String(w.text ?? '')); return { file: w.file, on: branchEvents(wf.on), names: wf.jobs.map(checkNameOf) }; });
const ownersOf = (read, n) => read.filter((w) => w.names.some((name) => checkIsJob(n, name)));
export function untriggeredChecks(required, base, workflows, { branch = null } = {}) {
  let read;
  try { read = readCopy(workflows); } catch { return {}; }
  const out = {};
  for (const n of required ?? []) {
    const own = ownersOf(read, n);
    if (!own.length || own.some((w) => mayRun(w.on, base, branch))) continue;
    const how = own.map((w) => {
      const prs = w.on.events.filter((e) => e.event === 'pull_request');
      return `${w.file} ${prs.length ? `runs on pull requests ${prs.map(filterText).join(', or ')}` : 'has no pull_request trigger'}`;
    });
    out[n] = `never runs on PRs into ${base} (workflow trigger: ${how.join('; ')})`;
  }
  return out;
}

// A pull_request run takes its workflow from the merge of head into base, so a check the head's copy
// never runs on the base may still run once the base has the trigger. Of untriggeredChecks's map, at
// the head: `reopen` the checks the base's own copy runs (no pull_request event came since the base
// gained the trigger, so closing and reopening the PR starts them), `behind` those only the default
// branch's copy runs (the base is behind it, so syncing the base and then reopening starts them), and
// `untriggered` the rest, a change to the workflow. A copy that does not read counts as running nothing.
export function staleTriggers(untriggered, base, { branch = null, atBase = [], atDefault = [], defaultBranch = 'main' } = {}) {
  const copy = (wfs) => { try { return readCopy(wfs); } catch { return []; } };
  const b = copy(atBase), d = base === defaultBranch ? [] : copy(atDefault);
  const runs = (read, n) => { const own = ownersOf(read, n); return own.length > 0 && own.some((w) => mayRun(w.on, base, branch)); };
  const out = { untriggered: {}, behind: {}, reopen: {} };
  for (const [n, why] of Object.entries(untriggered ?? {})) {
    if (runs(b, n)) out.reopen[n] = `has not reported, though ${base}'s copy of its workflow now runs it: no pull_request event has come since, so closing and reopening the PR starts it`;
    else if (runs(d, n)) out.behind[n] = `has not reported because ${base} is behind ${defaultBranch}, whose copy of its workflow runs it on PRs into ${base}: syncing ${base} with ${defaultBranch} and reopening the PR starts it`;
    else out.untriggered[n] = why;
  }
  return out;
}

// Before a batch on `base` starts: the required checks neither the base's nor the default branch's
// copy of the workflows runs on a PR into base from any of `branches`, as { <check>: <why> }. A child's
// head is cut from the base, so the base's copy stands in for it; one only the default branch's copy
// runs is left to the base sync. A check either copy reads no workflow for is left out: an unread
// workflow counts as running, so a failed read never refuses a batch.
export function baseUntriggered(required, base, { branches = [], atBase = [], atDefault = [], defaultBranch = 'main' } = {}) {
  let d = null;
  if (base !== defaultBranch) { try { d = readCopy(atDefault); } catch { return {}; } }
  const out = {};
  for (const branch of branches.length ? branches : [null]) {
    const atHead = untriggeredChecks(required, base, atBase, { branch });
    for (const [n, why] of Object.entries(staleTriggers(atHead, base, { branch, atBase, atDefault, defaultBranch }).untriggered)) {
      if (!d || ownersOf(d, n).length) out[n] = why;
    }
  }
  return out;
}

// Why no child PR into `base` could ever go green, or null: baseUntriggered over the workflows the base
// and the default branch hold on GitHub, as the line a refused admission or batch start prints. Both
// epic paths ask it before any worker starts: batch.mjs start (no child branch yet) and startEpic once
// its children are triaged. run: gh's runner, as readWorkflows takes it.
export function admissionRefusal(base, { required = [], branches = [], defaultBranch = 'main', repo, run = gh } = {}) {
  if (!required.length || !repo) return null;
  const at = (ref) => readWorkflows({ repo, ref, run });
  const never = baseUntriggered(required, base, { branches: [...new Set(branches)], atBase: at(base), atDefault: base === defaultBranch ? [] : at(defaultBranch), defaultBranch });
  const names = Object.keys(never);
  if (!names.length) return null;
  return `${names.length === 1 ? 'a required check does' : 'required checks do'} not run on PRs into ${base}, so no child PR could go green: ${names.map((n) => `"${n}" ${never[n]}`).join('; ')}. Add ${base} (or a pattern such as feat/**) to the pull_request branches of ${names.length === 1 ? 'that workflow' : 'those workflows'}, then admit the epic again`;
}

// The repo's workflow files at ref, as untriggeredChecks reads them. run(ghArgs) returns gh's stdout
// and throws on failure; a file that cannot be read is left out, and so are all of them when the
// directory cannot be listed.
export function readWorkflows({ repo, ref, run }) {
  const at = `?ref=${encodeURIComponent(ref)}`;
  let paths;
  try { paths = String(run(['api', `repos/${repo}/contents/.github/workflows${at}`, '--jq', '.[] | select(.type == "file") | .path'])).split('\n').filter((p) => /\.ya?ml$/.test(p)); }
  catch { return []; }
  const out = [];
  for (const file of paths) {
    try { out.push({ file, text: String(run(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}${at}`])) }); }
    catch { /* unread: its checks count as running */ }
  }
  return out;
}

// untriggered: untriggeredChecks's map. A required check that has not reported and is in it gets that
// reason instead, and is listed in the result's `untriggered`.
export function evaluateGate(allChecks, { required = [], advisory = [], runs = [], untriggered = {} } = {}) {
  const checks = latestPerCheck(allChecks);
  const adv = new Set(advisory);
  const reasons = [];
  const failing = [];
  const pending = [];
  let succeeded = 0;
  for (const c of checks) {
    if (c.status === 'completed' && c.conclusion === 'success') succeeded++;
  }
  // 1. Required: each present, each instance completed with success or skipped.
  let absent = false;
  const never = [];
  for (const n of required) {
    const hits = checks.filter((c) => c.name === n);
    if (!hits.length) {
      absent = true;
      const why = Object.hasOwn(untriggered ?? {}, n) ? untriggered[n] : null;
      if (why) never.push(n);
      reasons.push(`required check "${n}" ${why ?? 'has not reported'}`);
      continue;
    }
    for (const h of hits) {
      if (h.status !== 'completed') { pending.push(n); reasons.push(`required check "${n}" is ${h.status}`); }
      else if (!REQUIRED_PASS.has(h.conclusion)) {
        if (FAILED.has(h.conclusion)) failing.push({ name: n, conclusion: h.conclusion, runId: h.runId });
        reasons.push(`required check "${n}" is ${h.conclusion ?? 'unknown'}`);
      }
    }
  }
  // 2. Everything else: no failure and nothing in flight, unless advisory.
  const req = new Set(required);
  for (const c of checks) {
    if (req.has(c.name) || adv.has(c.name)) continue;
    if (c.status !== 'completed') { pending.push(c.name); reasons.push(`"${c.name}" is ${c.status}`); }
    else if (FAILED.has(c.conclusion)) { failing.push({ name: c.name, conclusion: c.conclusion, runId: c.runId }); reasons.push(`"${c.name}" ${c.conclusion}`); }
  }
  for (const r of runs) {
    if (lc(r.status) !== 'completed' && !adv.has(r.name) && !adv.has(r.workflowName)) {
      pending.push(`run ${r.name || r.workflowName || r.databaseId}`);
      reasons.push(`workflow run "${r.name || r.workflowName || r.databaseId}" is ${lc(r.status)}`);
    }
  }
  // 3. At least one success.
  if (!succeeded) reasons.push('no check has completed with success');

  // absent: a required check never reported and nothing is still running that could report it (or no
  // check at all). A completed neutral required check, or a head whose every check was skipped, is
  // `fail`: waiting will not turn it green.
  const state = failing.length ? 'fail'
    : pending.length ? 'pending'
    : absent || !checks.length ? 'absent'
    : reasons.length ? 'fail'
    : 'pass';
  return { state, reasons, failing, pending, succeeded, untriggered: never };
}

// §4 Merge holds items: `<glob>: <why>`, split on the first `: `. A bare glob holds with no reason given.
// `<glob>#<key>` holds a JSON file only when the PR changes that key (dotted for a nested one), so
// `package.json#scripts` holds a PR that edits the scripts but not one that only bumps versions.
// `glob` is the item as written, for reporting; `path` is the part matched against file names.
export function parseHolds(items) {
  if (!items) return [];
  return items.filter((x) => x && !/^none$/i.test(x.trim())).map((x) => {
    const i = x.indexOf(': ');
    const glob = (i < 0 ? x : x.slice(0, i)).trim();
    const why = i < 0 ? '(no reason given in §4 Merge holds)' : x.slice(i + 2).trim();
    const k = glob.indexOf('#');
    return { glob, path: k < 0 ? glob : glob.slice(0, k), key: k < 0 ? null : glob.slice(k + 1), why };
  });
}

// The PR's files for matchHolds, from `gh api pulls/<n>/files`: both sides of a rename, so a file
// moved out of a held path is still held.
export const PR_FILES_JQ = '.[] | .filename, (.previous_filename // empty)';

// gitignore-flavoured globs: `**` crosses directories, `*` and `?` do not, a trailing `/` means the
// whole directory, and a pattern with no `/` matches that name at any depth.
export function globToRegExp(glob) {
  let g = glob.trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  const anyDepth = !g.includes('/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anyDepth ? `(^|/)${re}$` : `^${re}$`);
}
// A `#<key>` hold compares the key's value at the merge base and the head. A missing file reads as
// an absent key; a file that does not parse counts as changed.
const valueAt = (text, key) => (text == null ? undefined : key.split('.').reduce((v, k) => v?.[k], JSON.parse(text)));
export function keyChanged(before, after, key) {
  try { return JSON.stringify(valueAt(before, key)) !== JSON.stringify(valueAt(after, key)); } catch { return true; }
}

// contents: Map file -> { before, after } from readKeyedFiles. A keyed hold on a file it lacks holds
// the PR rather than guess.
export function matchHolds(files, holds, contents) {
  return holds.map((h) => {
    const re = globToRegExp(h.path ?? h.glob);
    let unread = false;
    const hit = files.filter((f) => {
      if (!re.test(f)) return false;
      if (!h.key) return true;
      const c = contents?.get(f);
      if (!c) { unread = true; return true; }
      return keyChanged(c.before, c.after, h.key);
    });
    return { ...h, why: unread ? `${h.why} (${h.key} could not be compared, so held)` : h.why, files: hit };
  }).filter((h) => h.files.length);
}

// The holds a batch's children carried into its base (merge-driver.sh records each as `promotion_hold`
// on the ticket when it merges one past them), for the base's own merge into the default branch: one
// `<key> (#<pr>): <holds>` per child merged after `since` (the last promotion's merge), every one
// without it.
export const promotionHolds = (tickets, since = null) => (tickets ?? [])
  .filter((t) => t?.promotion_hold && t.merged_at && (since == null || Date.parse(t.merged_at) > Date.parse(since)))
  .map((t) => `${t.key}${t.result?.pr != null ? ` (#${t.result.pr})` : ''}: ${t.promotion_hold}`);

// §4 Known flaky checks items: `<check>: <glob> [<glob>…]`, split on the last `: ` so a check name may
// hold one. The globs are the paths whose change can make that check fail for real: a PR touching one
// never has the check waived. An item with no check or no glob is an error, never a guess.
export function parseFlaky(items) {
  const flaky = [];
  const errors = [];
  for (const x of items || []) {
    if (!x || /^none$/i.test(x.trim())) continue;
    const i = x.lastIndexOf(': ');
    const name = i < 0 ? '' : x.slice(0, i).trim();
    const paths = i < 0 ? [] : x.slice(i + 2).trim().split(/\s+/).filter(Boolean);
    if (!name || !paths.length) errors.push(`\`${x}\``);
    else flaky.push({ name, paths });
  }
  return { flaky, errors };
}

// Whether a red head may merge past its failures because each is a §4 Known flaky check. null when
// there is nothing to waive (not red, or no row). Otherwise `applies` is true only when every failing
// check is listed, none is required (branch protection enforces those, and merging past one is a
// bypass: §3 merge-bypass is never), the PR's files touch none of their globs, and the gate passes
// with them set aside. `reason` says which test failed: unlisted, required, files (unreadable), paths
// (with `hits`), or gate (something else keeps it red or pending). The driver's two reruns come first.
export function flakyWaiver(checks, { required = [], advisory = [], runs = [], flaky = [], files = null } = {}) {
  const gate = evaluateGate(checks, { required, advisory, runs });
  if (gate.state !== 'fail' || !gate.failing.length || !flaky.length) return null;
  const globs = new Map();
  for (const f of flaky) globs.set(f.name, [...(globs.get(f.name) ?? []), ...f.paths]);
  const names = [...new Set(gate.failing.map((f) => f.name))];
  const no = (reason, extra = {}) => ({ applies: false, reason, checks: names, ...extra });
  const unlisted = names.filter((n) => !globs.has(n));
  if (unlisted.length) return no('unlisted', { checks: unlisted });
  const req = names.filter((n) => required.includes(n));
  if (req.length) return no('required', { checks: req });
  if (!files) return no('files');
  const hits = [];
  for (const n of names) {
    for (const glob of globs.get(n)) {
      const re = globToRegExp(glob);
      const hit = files.filter((f) => re.test(f));
      if (hit.length) hits.push({ check: n, glob, files: hit.slice(0, 5) });
    }
  }
  if (hits.length) return no('paths', { hits });
  const rest = evaluateGate(checks, { required, advisory: [...advisory, ...names], runs });
  if (rest.state !== 'pass') return no('gate', { reasons: rest.reasons });
  return { applies: true, reason: null, checks: names };
}

// The files a `#<key>` hold has to look inside, read at the PR's merge base and at its head. A file
// absent on one side (added or deleted) reads as null; one that cannot be read is left out, so
// matchHolds holds it. run(ghArgs) returns gh's stdout, or a promise of it, and throws on failure.
export async function readKeyedFiles({ repo, base, head, files, holds, run }) {
  const out = new Map();
  const want = files.filter((f) => holds.some((h) => h.key && globToRegExp(h.path).test(f)));
  if (!want.length) return out;
  let mergeBase;
  try { mergeBase = String(await run(['api', `repos/${repo}/compare/${base}...${head}`, '--jq', '.merge_base_commit.sha'])).trim(); }
  catch { return out; }
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) return out;
  const read = async (path, ref) => {
    try { return String(await run(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`])); }
    catch (e) { if (/HTTP 404/.test(String(e?.stderr ?? e?.message ?? e))) return null; throw e; }
  };
  await Promise.all(want.map(async (f) => {
    try { out.set(f, { before: await read(f, mergeBase), after: await read(f, head) }); } catch { /* unread: held */ }
  }));
  return out;
}

// ---- CLI -------------------------------------------------------------------------------------
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

async function loadConfigLists() {
  const E = await import('./desk-env.mjs');
  const list = (id) => { const v = E.configValues(id); return v && !E.isNone(v) ? v : []; };
  return { E, required: list('required-checks'), advisory: list('advisory-checks'), holds: parseHolds(E.configValues('merge-holds')) };
}
// §4 Known flaky checks, refused whole when any item does not parse: unset or `none` waives nothing.
function loadFlaky(E) {
  const { flaky, errors } = parseFlaky(E.configValues('flaky-checks'));
  if (errors.length) throw new Error(`config §4 Known flaky checks does not parse: ${errors.join(', ')} (want \`<check>: <glob> [<glob>…]\`, one span per check, or \`none\`). Run /desk-setup`);
  return flaky;
}
export const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
// The workflow runs on a commit, in the shape evaluateGate reads. Throws when gh cannot list them.
export const readRuns = (repo, sha) =>
  JSON.parse(gh(['run', 'list', '--repo', repo, '--commit', sha, '--limit', '100', '--json', 'databaseId,name,workflowName,status,conclusion']));

if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'pr') {
      const n = rest[0];
      if (!/^\d+$/.test(n ?? '')) throw new Error('usage: gate.mjs pr <number> [--repo owner/name]');
      const { E, required, advisory, holds } = await loadConfigLists();
      const ri = rest.indexOf('--repo');
      const repo = ri >= 0 ? rest[ri + 1] : E.ghRepo();
      const pr = JSON.parse(gh(['pr', 'view', n, '--repo', repo, '--json',
        'number,headRefOid,headRefName,baseRefName,isDraft,mergeStateStatus,reviewDecision,autoMergeRequest,statusCheckRollup']));
      const checks = normaliseRollup(pr.statusCheckRollup);
      let runs = [];
      try { runs = readRuns(repo, pr.headRefOid); }
      catch { runs = [{ name: 'gh run list (unreadable)', status: 'unknown' }]; }
      // A hold is for the merge that deploys: one into the repo's default branch (§0, never a batch
      // base). A PR into any other base merges past it, and the hold falls on that base's own PR.
      const repoDefault = String(E.configValue('default-branch') ?? '').trim();
      const defaultBranch = repoDefault && !/^(todo|none)\b/i.test(repoDefault) ? repoDefault : 'main';
      let gate = evaluateGate(checks, { required, advisory, runs });
      // A required check that never reported may be one its workflow never runs on this base, or one a
      // base behind the default branch has not yet been given the trigger for.
      if (gate.state === 'absent') {
        const branch = pr.headRefName ?? null;
        const atHead = untriggeredChecks(required, pr.baseRefName, readWorkflows({ repo, ref: pr.headRefOid, run: gh }), { branch });
        if (Object.keys(atHead).length) {
          const s = staleTriggers(atHead, pr.baseRefName, { branch, defaultBranch,
            atBase: readWorkflows({ repo, ref: pr.baseRefName, run: gh }), atDefault: readWorkflows({ repo, ref: defaultBranch, run: gh }) });
          gate = evaluateGate(checks, { required, advisory, runs, untriggered: { ...s.untriggered, ...s.behind, ...s.reopen } });
        }
      }
      // Run ids of failing, non-advisory checks, for a bounded rerun. From the check itself, else the
      // failed completed runs for this commit.
      const ids = new Set(gate.failing.map((f) => f.runId).filter(Boolean));
      if (gate.failing.some((f) => !f.runId)) {
        // Only the latest run of each workflow: rerunning a superseded one replays its old payload.
        const latest = new Map();
        for (const r of runs) { const k = r.workflowName || r.name; if (!latest.has(k) || Number(r.databaseId) > Number(latest.get(k).databaseId)) latest.set(k, r); }
        for (const r of latest.values()) if (lc(r.status) === 'completed' && FAILED.has(lc(r.conclusion)) && !advisory.includes(r.name) && !advisory.includes(r.workflowName)) ids.add(String(r.databaseId));
      }
      let files = [];
      let filesOk = true;
      try { files = gh(['api', '--paginate', `repos/${repo}/pulls/${n}/files?per_page=100`, '--jq', PR_FILES_JQ]).split('\n').filter(Boolean); }
      catch { filesOk = false; }
      const contents = filesOk ? await readKeyedFiles({ repo, base: pr.baseRefName, head: pr.headRefOid, files, holds, run: gh }) : new Map();
      const held = filesOk ? matchHolds(files, holds, contents) : holds.length ? [{ glob: '*', why: 'the PR file list is unreadable, so §4 Merge holds cannot be checked', files: [] }] : [];
      const waiver = flakyWaiver(checks, { required, advisory, runs, flaky: loadFlaky(E), files: filesOk ? files : null });
      // The failing runs of the checks it would waive, for the ticket filed after the merge.
      if (waiver) waiver.runs = [...new Set(gate.failing.filter((f) => waiver.checks.includes(f.name)).map((f) => f.runId).filter(Boolean))];
      if (waiver && !waiver.runs.length) waiver.runs = [...ids];
      console.log(JSON.stringify({
        number: pr.number, sha: pr.headRefOid, head: pr.headRefName, base: pr.baseRefName, isDraft: pr.isDraft,
        mergeState: pr.mergeStateStatus, reviewDecision: pr.reviewDecision || 'NONE', autoMerge: !!pr.autoMergeRequest,
        gate: { ...gate, failedRuns: [...ids] },
        holds: held.map((h) => ({ glob: h.glob, why: h.why, files: h.files.slice(0, 5), count: h.files.length })),
        defaultBranch, holdsApply: pr.baseRefName === defaultBranch,
        waiver,
      }));
    } else if (cmd === 'holds') {
      const { holds } = await loadConfigLists();
      const files = readFileSync(rest[0] ?? '/dev/stdin', 'utf8').split('\n').filter(Boolean);
      for (const h of matchHolds(files, holds)) console.log(`${h.glob}\t${h.why}\t${h.files.length}`);
    } else if (cmd === 'flaky') {
      for (const f of loadFlaky(await import('./desk-env.mjs'))) console.log(`${f.name}\t${f.paths.join(' ')}`);
    } else {
      console.error('usage: gate.mjs pr <number> [--repo owner/name] | gate.mjs holds <file> | gate.mjs flaky');
      process.exit(2);
    }
  } catch (e) {
    console.error(`gate: ${(e.stderr || e.message || String(e)).toString().trim().slice(0, 400)}`);
    process.exit(1);
  }
}
