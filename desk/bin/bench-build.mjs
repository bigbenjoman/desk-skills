// Freezes merged PRs into bench tasks (bench.mjs's task set format), keeping only tasks whose hidden
// tests tell a right answer from a wrong one: they fail at the PR's base commit and pass at its merge.
//
//   node bench-build.mjs --set <file.json> --pr <owner/name>#<n> [--pr …] [--rewrite] [--timeout <seconds>]
//
// A --pr may also be a PR URL. Each repo needs a desk config on this machine: its §2 Primary repo root
// holds the commits, its §4 Unit tests score the hidden tests, and its Jira holds the ticket the PR's
// title or branch names. For each PR the builder records the repo, base and merge commits, the ticket's
// key, size, summary and description as they read when the PR's first commit was authored (later
// edits are undone from the Jira changelog; comments are never read), and copies the PR's added or
// changed test files at the merge commit to <set dir>/<task id>/hidden/. Each validation's test output
// is kept under <set dir>/<task id>/validate/{base,merge}/.
//
// A PR already in the set, kept or dropped, is left exactly as it is unless --rewrite is given, which
// builds the PRs named on this run again. The set file is written after each PR, and only when
// something in it changed.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FILE_SAFE } from './skill-eval.mjs';
import { deskEnv, makeCheckout, readRepo, score, testRuns } from './bench.mjs';
import { keyRegex, SIZE_LINE } from './ticket-lint.mjs';
import { SIZES } from './desk-q-eta.mjs';

const USAGE = 'usage: bench-build.mjs --set <file.json> --pr <owner/name>#<n> [--pr …] [--rewrite] [--timeout <seconds>]';
const SHA = /^[0-9a-f]{40}$/;

// argv -> options. Throws, naming the flag, on anything missing or malformed.
export function parseArgs(argv) {
  const o = { prs: [], rewrite: false, timeout: 3600 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rewrite') { o.rewrite = true; continue; }
    if (!['--set', '--pr', '--timeout'].includes(a)) throw new Error(`unknown argument ${a}\n${USAGE}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    const v = argv[++i];
    if (a === '--set') o.set = v;
    else if (a === '--pr') o.prs.push(parsePr(v));
    else o.timeout = v;
  }
  if (!o.set) throw new Error(`refusing to start: --set is required\n${USAGE}`);
  if (!o.prs.length) throw new Error(`refusing to start: --pr is required\n${USAGE}`);
  if (!/^\d+$/.test(String(o.timeout)) || !(Number(o.timeout) > 0)) throw new Error(`--timeout must be a positive number of seconds, not ${o.timeout}`);
  o.timeout = Number(o.timeout);
  return o;
}

// `owner/name#123` or a github.com PR URL -> { repo, pr }.
export function parsePr(text) {
  const m = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(text) ?? /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/.exec(text);
  if (!m) throw new Error(`--pr ${text}: want <owner>/<name>#<number> or a PR URL`);
  return { repo: m[1], pr: Number(m[2]) };
}

const IN_TEST_DIR = /(^|\/)(tests?|__tests__|specs?)\//;
const TEST_NAME = /(^|\/)(test_[^/]+|[^/]+[._-](test|spec)\.[A-Za-z0-9]+|[^/]+_test\.[A-Za-z0-9]+)$/;

// The PR's test files from its changed paths: `files` are hidden, `run` are the ones a test command
// is handed (named as tests); the rest of `files` are the fixtures and helpers beside them.
export function testFiles(paths) {
  const files = paths.filter((p) => TEST_NAME.test(p) || IN_TEST_DIR.test(p));
  return { files, run: files.filter((p) => TEST_NAME.test(p)) };
}

// The fields named, as they read at `cutoff`: each change made after it is undone, newest first.
// `current` maps field id to today's value; `histories` is Jira's changelog.
export function fieldsAt(current, histories, cutoff, ids) {
  const out = { ...current };
  const after = histories.filter((h) => Date.parse(h.created) > cutoff).sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  for (const h of after) {
    for (const it of h.items ?? []) {
      const id = it.fieldId ?? it.field;
      if (ids.includes(id)) out[id] = it.fromString ?? '';
    }
  }
  return out;
}

// The size from the Size field's value, else a first description line `Size: M`; null when neither.
export function sizeOf(field, description) {
  const first = String(description ?? '').split('\n').find((l) => l.trim()) ?? '';
  return [field, SIZE_LINE.exec(first)?.[1]].map((v) => String(v ?? '').trim().toUpperCase()).find((s) => SIZES.includes(s)) ?? null;
}

// The task id: owner and name, so two owners' same-named repos never share a task directory. A
// GitHub owner holds no `_`, so `__` is never inside one.
export const taskId = ({ repo, pr }) => `${repo.replace('/', '__')}-${pr}`.replace(/[^A-Za-z0-9._-]/g, '-');

// Tasks per repo and per size.
export function counts(tasks) {
  const tally = (key) => tasks.reduce((m, t) => ({ ...m, [key(t)]: (m[key(t)] ?? 0) + 1 }), {});
  return { repo: tally((t) => t.repo), size: tally((t) => t.ticket.size ?? 'unsized') };
}

const run = (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

function ghPr({ repo, pr }) {
  const r = run('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'number,title,headRefName,state,mergeCommit,files,commits']);
  if (r.status !== 0) throw new Error(`gh pr view failed: ${(r.stderr || '').trim()}`);
  return JSON.parse(r.stdout);
}

function jira(repo, path) {
  const r = run('desk-jira', ['api', path], { cwd: repo.root, env: repo.env });
  if (r.status !== 0) throw new Error(`desk-jira api ${path}: ${(r.stderr || r.stdout || '').trim()}`);
  return JSON.parse(r.stdout);
}

const optional = (repo, id) => { try { return deskEnv(repo, 'get', id); } catch { return ''; } };

// The ticket as it read at `cutoff` (ms). -> { key, size, summary, description, as_of }
// A ticket created after the cutoff was all written after it, so it is a drop.
function ticketAt(repo, key, cutoff) {
  const size = optional(repo, 'jira-size-field');
  const sizeId = /^customfield_\d+$/.test(size) ? size : null;
  const fields = ['summary', 'description', ...(sizeId ? [sizeId] : [])];
  const issue = jira(repo, `api/2/issue/${key}?fields=${[...fields, 'created'].join(',')}&expand=changelog`);
  const created = Date.parse(issue.fields?.created ?? '');
  if (!Number.isFinite(created)) fail(`${key} gives no creation date to tell its text from what came after the PR`);
  if (created > cutoff) fail(`${key} was created after the PR's first commit, so all its text came after the work`);
  const histories = [...(issue.changelog?.histories ?? [])];
  while (histories.length < (issue.changelog?.total ?? 0)) {
    const page = jira(repo, `api/2/issue/${key}/changelog?startAt=${histories.length}&maxResults=100`);
    if (!page.values?.length) break;
    histories.push(...page.values);
  }
  const f = issue.fields ?? {};
  const current = { summary: f.summary ?? '', description: f.description ?? '', ...(sizeId ? { [sizeId]: f[sizeId]?.value ?? f[sizeId] ?? null } : {}) };
  const at = fieldsAt(current, histories, cutoff, fields);
  return { key, size: sizeOf(sizeId && at[sizeId], at.description), summary: at.summary, description: at.description, as_of: new Date(cutoff).toISOString() };
}

const git = (root, args, opts = {}) => run('git', ['-C', root, ...args], opts);

export function haveCommit(root, sha) {
  if (git(root, ['cat-file', '-e', `${sha}^{commit}`]).status === 0) return;
  const f = git(root, ['fetch', '-q', 'origin', sha]);
  if (f.status !== 0) throw new Error(`commit ${sha} is not in ${root} and could not be fetched: ${(f.stderr || '').trim()}`);
}

// Runs the hidden tests in a throwaway checkout at `commit`. -> score's { status, why? }
function validateAt(repo, task, commit, dir, timeout) {
  mkdirSync(dir, { recursive: true });
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'desk-bench-build-'));
  const wt = join(parent, 'checkout');
  try {
    makeCheckout(repo, { ...task, base: commit }, wt);
    return score(repo, task, wt, dir, timeout * 1000);
  } catch (e) {
    return { status: 'failed', why: e.message };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

const fail = (why) => { throw Object.assign(new Error(why), { drop: true }); };

// How many first-parent commits the PR put on the base branch. A merge commit or a squash is one. A
// rebase merge lands each of the PR's commits with the author dates they had, so the merge commit is
// the last of them: read from its first parent, the base would already hold the rest of the PR.
function commitsLanded(root, merge, commits) {
  if (commits.length < 2) return 1;
  const r = git(root, ['log', '--first-parent', '--format=%P %at', '-n', String(commits.length), merge]);
  const landed = (r.stdout ?? '').trim().split('\n').reverse().map((line) => line.split(' '));
  const rebased = landed.length === commits.length && landed.every((f, i) =>
    f.length === 2 && Number(f[1]) === Date.parse(commits[i].authoredDate) / 1000);
  return rebased ? commits.length : 1;
}

// One PR to a validated task, or a thrown reason it was dropped.
function freeze(want, setDir, opts, repos) {
  if (!repos.has(want.repo)) repos.set(want.repo, (() => { try { return readRepo(want.repo); } catch (e) { return e; } })());
  const repo = repos.get(want.repo);
  if (repo instanceof Error) fail(repo.message);
  const pr = ghPr(want);
  if (pr.state !== 'MERGED' || !SHA.test(pr.mergeCommit?.oid ?? '')) fail('the PR is not merged');
  const { files, run: runs } = testFiles((pr.files ?? []).filter((f) => f.changeType !== 'DELETED').map((f) => f.path));
  if (!runs.length) fail('the PR changed no test files, so it has no tests to hide');

  const pattern = keyRegex((id) => optional(repo, id));
  if (!/^jira\b/i.test(optional(repo, 'tracker').trim()) || !pattern) fail(`${want.repo} has no Jira tracker to read the ticket from`);
  const key = new RegExp(pattern).exec(`${pr.title}\n${pr.headRefName}`)?.[0];
  if (!key) fail(`no ticket key matching ${pattern} in the PR's title or branch`);
  const first = Math.min(...(pr.commits ?? []).map((c) => Date.parse(c.authoredDate)).filter(Number.isFinite));
  if (!Number.isFinite(first)) fail('the PR has no commits to date the ticket text by');
  const ticket = ticketAt(repo, key, first);
  if (!ticket.description.trim() && !ticket.summary.trim()) fail(`${key} had no text when the PR's first commit was made`);

  // The base is the commit the merge applied the PR to, so the merge differs from it by the PR alone.
  // GitHub's baseRefOid can be older: work merged to the base branch after it would reach the hidden
  // tests without reaching the run.
  const merge = pr.mergeCommit.oid;
  haveCommit(repo.root, merge);
  const base = git(repo.root, ['rev-parse', '--verify', '--quiet', `${merge}~${commitsLanded(repo.root, merge, pr.commits ?? [])}`]).stdout?.trim();
  if (!SHA.test(base ?? '')) fail('the merge commit has no parent to start from');
  const id = taskId(want);
  if (!FILE_SAFE.test(id)) fail(`cannot make a task id from ${want.repo}#${want.pr}`);
  const taskDir = join(setDir, id);
  rmSync(taskDir, { recursive: true, force: true });
  const hidden = join(taskDir, 'hidden');
  for (const f of files) {
    const r = git(repo.root, ['show', `${merge}:${f}`], { encoding: 'buffer' });
    if (r.status !== 0) fail(`cannot read ${f} at the merge commit`);
    mkdirSync(dirname(join(hidden, f)), { recursive: true });
    writeFileSync(join(hidden, f), r.stdout);
  }
  const { orphans } = testRuns(repo.items, runs);
  if (orphans.length) fail(`no §4 Unit tests item covers ${orphans.join(', ')}`);

  const prompt = `${key}: ${ticket.summary}\n\n${ticket.description}`.trim();
  const task = { id, repo: want.repo, pr: want.pr, base, merge, ticket, prompt,
    hidden_tests: { dir: `${id}/hidden`, files, ...(runs.length < files.length ? { run: runs } : {}) } };
  const abs = { ...task, hidden_tests: { ...task.hidden_tests, dir: hidden } };
  const atMerge = validateAt(repo, abs, merge, join(taskDir, 'validate', 'merge'), opts.timeout);
  if (atMerge.status !== 'accepted') {
    fail(atMerge.status === 'failed'
      ? `the hidden tests cannot run at the merge commit: ${atMerge.why}`
      : `the hidden tests fail at the merge commit (a missing service or credential reads the same): ${atMerge.why}`);
  }
  const atBase = validateAt(repo, abs, base, join(taskDir, 'validate', 'base'), opts.timeout);
  if (atBase.status === 'accepted') fail('the hidden tests already pass at the base commit, so they cannot tell a right answer from a wrong one');
  if (atBase.status === 'failed') fail(`the hidden tests cannot run at the base commit: ${atBase.why}`);
  return task;
}

const same = (a) => (b) => a.repo === b.repo && a.pr === b.pr;

// Builds the set. -> { path, written, tasks, dropped, counts }
export function build(opts, log = () => {}) {
  const path = resolve(opts.set);
  const setDir = dirname(path);
  let prior = { tasks: [], dropped: [] };
  if (existsSync(path)) {
    try { prior = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`cannot read task set ${path}: ${e.message}`); }
  }
  const tasks = [...(prior.tasks ?? [])];
  const dropped = [...(prior.dropped ?? [])];
  const repos = new Map();
  let written = false;
  // Saved after every PR, so a build that is killed keeps each PR it finished.
  const save = () => {
    const text = `${JSON.stringify({ tasks, counts: counts(tasks), dropped }, null, 2)}\n`;
    if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
    mkdirSync(setDir, { recursive: true });
    writeFileSync(path, text);
    written = true;
  };
  for (const want of opts.prs) {
    const name = `${want.repo}#${want.pr}`;
    const t = tasks.findIndex(same(want)), d = dropped.findIndex(same(want));
    if (!opts.rewrite && t >= 0) { log(`kept ${tasks[t].id}: already frozen`); continue; }
    if (!opts.rewrite && d >= 0) { log(`kept ${name}: already dropped (${dropped[d].why})`); continue; }
    if (t >= 0) tasks.splice(t, 1);
    if (d >= 0) dropped.splice(d, 1);
    log(`freezing ${name}`);
    try {
      const task = freeze(want, setDir, opts, repos);
      tasks.push(task);
      log(`  frozen as ${task.id}`);
    } catch (e) {
      dropped.push({ repo: want.repo, pr: want.pr, why: e.message });
      log(`  dropped: ${e.message}`);
    }
    save();
  }
  save();
  return { path, written, tasks, counts: counts(tasks), dropped };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    const r = build(parseArgs(process.argv.slice(2)), (m) => console.error(m));
    console.log(`${r.tasks.length} task(s) in ${r.path}${r.written ? '' : ' (unchanged, not rewritten)'}`);
    for (const [k, v] of Object.entries(r.counts.repo)) console.log(`  repo ${k}: ${v}`);
    for (const [k, v] of Object.entries(r.counts.size)) console.log(`  size ${k}: ${v}`);
    if (r.dropped.length) console.log(`dropped ${r.dropped.length}:`);
    for (const d of r.dropped) console.log(`  ${d.repo}#${d.pr}: ${d.why}`);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
