#!/usr/bin/env node
// The one definition of "green" (desk-config.md, Rules: "Green means one thing everywhere"), and the
// merge-hold test, shared by merge-driver.sh and desk-clearance's clearance-state.mjs so the two can
// never disagree about whether a PR may merge.
//
// Green, on the exact head commit being merged:
//   1. every §4 Required check completed with success (skipped, neutral or absent does not count);
//   2. no other check failed, errored, timed out, was cancelled, or is still queued or running,
//      unless §4 Advisory checks names it; and no workflow run for that commit is still in flight;
//   3. at least one check completed with success.
// The merge is then pinned to that commit with `--match-head-commit <sha>`.
//
// Library:
//   evaluateGate(checks, { required, advisory, runs }) -> { state, reasons, failing, pending, succeeded }
//     checks: normalised { name, status: 'queued'|'in_progress'|'completed', conclusion, runId }
//     state:  'pass' | 'fail' | 'pending' | 'absent'
//   normaliseRollup(nodes)   statusCheckRollup / GraphQL context nodes -> checks
//   parseHolds(items)        §4 Merge holds items `<glob>[#<key>]: <why>` -> [{ glob, path, key, why }]
//   matchHolds(files, holds, contents) -> [{ glob, why, files }]
//   readKeyedFiles({ repo, base, head, files, holds, run }) -> contents, for the `#<key>` holds
//
// CLI (merge-driver.sh):
//   node gate.mjs pr <number> [--repo owner/name]   one JSON object: sha, base, head, mergeState,
//     reviewDecision, gate (as above, plus failedRuns: run ids of failing non-advisory checks), holds
//   node gate.mjs holds <file-with-paths>          print each matching hold as `<glob>\t<why>\t<n files>`
//     (with no diff to read, a `#<key>` hold on a listed file holds)
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FAILED = new Set(['failure', 'error', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const lc = (s) => String(s ?? '').toLowerCase();

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
  ...normaliseCheck(n), workflow: n.workflowName ?? null, startedAt: n.startedAt ?? null,
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

export function evaluateGate(allChecks, { required = [], advisory = [], runs = [] } = {}) {
  const checks = latestPerCheck(allChecks);
  const adv = new Set(advisory);
  const reasons = [];
  const failing = [];
  const pending = [];
  let succeeded = 0;
  for (const c of checks) {
    if (c.status === 'completed' && c.conclusion === 'success') succeeded++;
  }
  // 1. Required: each present, each instance completed with success.
  let absent = false;
  for (const n of required) {
    const hits = checks.filter((c) => c.name === n);
    if (!hits.length) { absent = true; reasons.push(`required check "${n}" has not reported`); continue; }
    for (const h of hits) {
      if (h.status !== 'completed') { pending.push(n); reasons.push(`required check "${n}" is ${h.status}`); }
      else if (h.conclusion !== 'success') {
        if (FAILED.has(h.conclusion)) failing.push({ name: n, conclusion: h.conclusion, runId: h.runId });
        reasons.push(`required check "${n}" is ${h.conclusion ?? 'unknown'}${h.conclusion === 'skipped' ? ' (skipped does not count)' : ''}`);
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
  // check at all). A completed skipped/neutral required check, or a head whose every check was
  // skipped, is `fail`: waiting will not turn it green.
  const state = failing.length ? 'fail'
    : pending.length ? 'pending'
    : absent || !checks.length ? 'absent'
    : reasons.length ? 'fail'
    : 'pass';
  return { state, reasons, failing, pending, succeeded };
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
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

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
      try { runs = JSON.parse(gh(['run', 'list', '--repo', repo, '--commit', pr.headRefOid, '--limit', '100', '--json', 'databaseId,name,workflowName,status,conclusion'])); }
      catch { runs = [{ name: 'gh run list (unreadable)', status: 'unknown' }]; }
      const gate = evaluateGate(checks, { required, advisory, runs });
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
      try { files = gh(['api', '--paginate', `repos/${repo}/pulls/${n}/files?per_page=100`, '--jq', '.[].filename']).split('\n').filter(Boolean); }
      catch { filesOk = false; }
      const contents = filesOk ? await readKeyedFiles({ repo, base: pr.baseRefName, head: pr.headRefOid, files, holds, run: gh }) : new Map();
      const held = filesOk ? matchHolds(files, holds, contents) : holds.length ? [{ glob: '*', why: 'the PR file list is unreadable, so §4 Merge holds cannot be checked', files: [] }] : [];
      console.log(JSON.stringify({
        number: pr.number, sha: pr.headRefOid, head: pr.headRefName, base: pr.baseRefName, isDraft: pr.isDraft,
        mergeState: pr.mergeStateStatus, reviewDecision: pr.reviewDecision || 'NONE', autoMerge: !!pr.autoMergeRequest,
        gate: { ...gate, failedRuns: [...ids] },
        holds: held.map((h) => ({ glob: h.glob, why: h.why, files: h.files.slice(0, 5), count: h.files.length })),
      }));
    } else if (cmd === 'holds') {
      const { holds } = await loadConfigLists();
      const files = readFileSync(rest[0] ?? '/dev/stdin', 'utf8').split('\n').filter(Boolean);
      for (const h of matchHolds(files, holds)) console.log(`${h.glob}\t${h.why}\t${h.files.length}`);
    } else {
      console.error('usage: gate.mjs pr <number> [--repo owner/name] | gate.mjs holds <file>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`gate: ${(e.stderr || e.message || String(e)).toString().trim().slice(0, 400)}`);
    process.exit(1);
  }
}
