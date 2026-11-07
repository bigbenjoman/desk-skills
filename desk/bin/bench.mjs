// Runs named arms over a set of frozen tasks: each task in a throwaway checkout at the commit the
// ticket started from, with the merged PR's tests held back and applied only after the run to decide
// whether the task is accepted.
//
//   node bench.mjs --tasks <file.json> --arm <name>[=<model>[:<effort>]] [--arm …] --max-budget-usd <usd>
//                  [--total-budget-usd <usd>] [--out <dir>] [--timeout <seconds>] [--seed <n>]
//
// The task set is JSON, kept outside desk-skills, with paths relative to the file:
//   {"tasks": [{"id", "repo": "<owner/name>", "base": "<full commit SHA>", "prompt": "<ticket text>",
//               "hidden_tests": {"dir": "<directory holding the copies>", "files": ["<repo path>", …],
//                                "run": ["<repo path>", …]}}]}
// Each file's copy is <dir>/<repo path>. `run` (default: every file) names the files handed to the
// test command; the rest (fixtures, helpers) are only copied in. The repo needs a desk config on this machine: its §2 Primary
// repo root is where the base is fetched from and its §4 Unit tests are what score the hidden tests.
//
// A task's result is one of: accepted (every hidden test passed), rejected (one failed) or failed
// (the run errored, timed out or was stopped, or the hidden tests could not finish), and failed counts
// neither way. Under <out>/runs/<task>.<arm>.<key>/ each run keeps result.json (order, tokens,
// attempts), diff.patch, transcript.jsonl and test-output.log; <key> hashes the base and the arm's
// settings, so a run with an accepted or rejected result there is reused and a failed one runs again.
// <out>/run.json lists this invocation's seed, per-task arm order and outcomes. <out> defaults to
// bench-out beside the task set, so results outlive a run.
//
// --total-budget-usd (default 5) caps the invocation as claude's reported cost: a run starts only while
// it fits at its --max-budget-usd ceiling, and one that reports no cost counts as its ceiling.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, mkdtempSync, rmSync, cpSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FILE_SAFE, USD, claudeArgs, readRun, readTasks } from './skill-eval.mjs';
import { logTokens } from './worker-cost.mjs';
import { runItem } from './baseline.mjs';
import { nearestDir, takesFiles } from './test-scope.mjs';
import { lockDir, otherRepoEnv, repoConfigDir, slugOf } from './desk-env.mjs';

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const USAGE = 'usage: bench.mjs --tasks <file.json> --arm <name>[=<model>[:<effort>]] [--arm …] --max-budget-usd <usd> [--total-budget-usd <usd>] [--out <dir>] [--timeout <seconds>] [--seed <n>]';
const SHA = /^[0-9a-f]{40}$/;
const SCORED = new Set(['accepted', 'rejected']);
// The hidden tests' ceiling, wait for the test lock included.
const SCORE_TIMEOUT_MS = 60 * 60 * 1000;

// argv -> options. Throws, naming the flag, on anything missing or malformed.
export function parseArgs(argv) {
  const o = { arms: [], timeout: 1800, total: '5', seed: String(Date.now()) };
  const names = { '--tasks': 'tasks', '--max-budget-usd': 'budget', '--total-budget-usd': 'total', '--out': 'out', '--timeout': 'timeout', '--seed': 'seed' };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    if (!key && argv[i] !== '--arm') throw new Error(`unknown argument ${argv[i]}\n${USAGE}`);
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    if (key) o[key] = argv[++i];
    else o.arms.push(parseArm(argv[++i]));
  }
  if (!o.tasks) throw new Error(`refusing to start: --tasks is required\n${USAGE}`);
  if (!o.arms.length) throw new Error(`refusing to start: --arm is required\n${USAGE}`);
  if (o.budget == null) throw new Error('refusing to start: --max-budget-usd <usd> is required (the spend ceiling for each claude run)');
  if (new Set(o.arms.map((a) => a.name)).size !== o.arms.length) throw new Error('--arm: each arm needs its own name');
  for (const [flag, v] of [['--max-budget-usd', o.budget], ['--total-budget-usd', o.total]]) {
    if (!USD.test(v) || !(Number(v) > 0)) throw new Error(`${flag} must be a positive number of USD, not ${v}`);
  }
  if (Number(o.budget) > Number(o.total)) throw new Error(`--total-budget-usd ${o.total} cannot fit one run at --max-budget-usd ${o.budget}`);
  if (!/^\d+$/.test(String(o.timeout)) || !(Number(o.timeout) > 0)) throw new Error(`--timeout must be a positive number of seconds, not ${o.timeout}`);
  o.timeout = Number(o.timeout);
  return o;
}

function parseArm(text) {
  const m = /^([^=]+)(?:=([^:\s]+)(?::([a-z]+))?)?$/.exec(text);
  if (!m || !FILE_SAFE.test(m[1])) throw new Error(`--arm ${text}: want <name>[=<model>[:<effort>]], the name letters, digits, ., _ or -`);
  return { name: m[1], model: m[2] ?? null, effort: m[3] ?? null };
}

// The task set, validated, with `hidden_tests.dir` made absolute.
export function loadBenchTasks(file) {
  return readTasks(file, (t) => {
    if (typeof t.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(t.repo)) throw new Error(`task ${t.id}: repo must be owner/name`);
    if (typeof t.base !== 'string' || !SHA.test(t.base)) throw new Error(`task ${t.id}: base must be a full commit SHA`);
    const h = t.hidden_tests;
    if (typeof h?.dir !== 'string' || !Array.isArray(h.files) || !h.files.length) throw new Error(`task ${t.id}: hidden_tests needs a dir and at least one file`);
    h.dir = resolve(dirname(file), h.dir);
    for (const f of h.files) {
      if (typeof f !== 'string' || isAbsolute(f) || f.split('/').includes('..')) throw new Error(`task ${t.id}: hidden test ${JSON.stringify(f)} must be a path inside the repo`);
      if (!existsSync(join(h.dir, f))) throw new Error(`task ${t.id}: no hidden test copy at ${join(h.dir, f)}`);
    }
    if (h.run !== undefined && (!Array.isArray(h.run) || !h.run.length || h.run.some((f) => !h.files.includes(f)))) {
      throw new Error(`task ${t.id}: hidden_tests.run must list at least one of its files, and only those`);
    }
  });
}

// The hidden files the test command is given.
const runFiles = (task) => task.hidden_tests.run ?? task.hidden_tests.files;

// The arms in this task's order: a shuffle seeded by the run's seed and the task, so a seed repeats
// its order and the first arm differs from task to task.
export function armOrder(arms, seed, taskId) {
  let s = createHash('sha256').update(`${seed}:${taskId}`).digest().readUInt32LE(0);
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32; };
  const a = [...arms];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// What makes a stored result the same run: the base and everything the arm starts with.
export const runKey = (task, arm) => createHash('sha256')
  .update(JSON.stringify([task.base, task.prompt, arm.model, arm.effort])).digest('hex').slice(0, 12);

// Which §4 Unit tests items run which hidden files, each file going to the items in the deepest
// directory holding it, relative to that directory. -> { runs: [{dir, cmd, files}], orphans: [path] }
export function testRuns(items, files) {
  const byItem = new Map();
  const orphans = [];
  for (const f of files) {
    const near = nearestDir(items, f);
    if (!near) { orphans.push(f); continue; }
    for (const i of items.filter((x) => x.dir === near.dir)) byItem.set(i, [...(byItem.get(i) ?? []), near.rel]);
  }
  return { runs: [...byItem].map(([i, fs]) => ({ dir: i.dir, cmd: i.cmd, files: fs })), orphans };
}

// The ways out of the checkout, and what a run could read the answer through: gone from the allow
// list. `gh` reads count too: the merged PR is one `gh pr view` away.
// `git fetch` too: the checkout has no remote, but a URL fetches the merged commit just the same.
const OUT_OF_BOUNDS = /\b(gh|desk-jira|desk-gh|desk-env|desk-design|codex|docker|docker-compose)\b|verdict\.mjs|^WebFetch$|^WebSearch$|^mcp__|^Read\(|^Bash\(\S*\bgit\b[^:]*\sfetch\b/;

// A worker's generated settings cut down for an arm: its Edit rules only in the checkout, none of
// its grants beyond the repo's own toolchain, and `secrets` (the primary checkout, the task set, the
// hidden tests, the bench's results) denied by name to every tool.
export function armSettings(generated, { wt, secrets, lockDirs }) {
  const s = structuredClone(generated);
  const p = s.permissions;
  p.allow = p.allow.filter((r) => !OUT_OF_BOUNDS.test(r) && (!r.startsWith('Edit(') || r.startsWith(`Edit(/${wt}/`)));
  p.deny.push('WebFetch', 'WebSearch', 'Bash(gh:*)', 'Bash(desk-jira:*)', 'Bash(desk-gh:*)',
    ...secrets.flatMap((d) => [`Read(/${d})`, `Read(/${d}/**)`, `Bash(*${d}*)`]));
  p.additionalDirectories = p.additionalDirectories.filter((d) => lockDirs.includes(d) || d === '/proc');
  s.autoMemoryEnabled = false;
  return s;
}

const REACHES = [['push', /\bgit(\s+-\S+(\s+[^-\s]\S*)?)*\s+push\b/], ['pr', /\bgh\s+pr\s+create\b/], ['jira', /\bdesk-jira\b|atlassian\.net/]];

// Every call in a stream-json transcript that tried to push, open a PR or reach Jira, and whether it
// came back refused. -> [{kind, tool, call, refused}]
export function reachAttempts(transcript) {
  const calls = new Map();
  const refused = new Set();
  for (const line of transcript.split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    for (const c of Array.isArray(d?.message?.content) ? d.message.content : []) {
      if (d.type === 'assistant' && c.type === 'tool_use') calls.set(c.id, c);
      if (d.type === 'user' && c.type === 'tool_result' && c.is_error) refused.add(c.tool_use_id);
    }
  }
  const out = [];
  for (const [id, c] of calls) {
    const call = String(c.input?.command ?? c.input?.url ?? '');
    for (const [kind, re] of REACHES) if (re.test(call)) out.push({ kind, tool: c.name, call, refused: refused.has(id) });
  }
  return out;
}

// An arm's environment: another repo's, with no way to turn caching off and no token for GitHub.
const armEnv = () => Object.fromEntries(Object.entries(otherRepoEnv())
  .filter(([k]) => !/^(DISABLE_PROMPT_CACHING|GH_TOKEN$|GITHUB_TOKEN$|DESK_AUTOPILOT_WORKER$|DESK_BATCH$)/.test(k)));

const both = (p) => [...new Set([p, realpathSync(p)])];
const shq = (s) => `'${s.replace(/'/g, "'\\''")}'`;

export function deskEnv(repo, ...args) {
  const r = spawnSync(process.execPath, [join(HERE, 'desk-env.mjs'), ...args], { cwd: repo.root ?? tmpdir(), env: repo.env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`desk-env ${args.join(' ')} for ${repo.name}: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

// One repo's desk facts, read through a child so each repo's config decides. Throws on anything that
// would only fail after a run was spent.
export function readRepo(name) {
  const config = join(repoConfigDir(slugOf(name)), 'config.md');
  if (!existsSync(config)) throw new Error(`no desk config for ${name} (looked at ${config}): run /desk-setup there`);
  const repo = { name, env: { ...otherRepoEnv(), DESK_CONFIG: config } };
  repo.root = deskEnv(repo, 'get', 'repo-root');
  if (!existsSync(repo.root)) throw new Error(`${name}: §2 Primary repo root ${repo.root} does not exist`);
  repo.env.DESK_REPO_DIR = repo.root;
  repo.items = deskEnv(repo, 'cmds', 'test-cmd').split('\n').filter(Boolean).map((l) => { const [dir, cmd] = l.split('\t'); return { dir, cmd }; });
  if (!repo.items.length) throw new Error(`${name}: §4 Unit tests is none, so nothing can score a hidden test`);
  const prefix = deskEnv(repo, 'get', 'command-prefix');
  repo.prefix = /^none\b/i.test(prefix) ? '' : prefix;
  let cap = '';
  try { cap = deskEnv(repo, 'get', 'test-cap'); } catch { /* unset: the suite runs uncapped, still under the lock */ }
  repo.cap = /^\d+$/.test(cap) ? cap : null;
  return repo;
}

const git = (wt, ...args) => {
  const r = spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', env: armEnv() });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
};

// A throwaway checkout at the task's base, exactly as the ticket's worker found it: a test file the PR
// changed is there in its base version, and the PR's version arrives only when the run is scored.
export function makeCheckout(repo, task, wt) {
  const r = spawnSync('bash', [join(HERE, 'setup-worktree.sh'), '--for-worker', '--frozen', task.base, wt, task.id, 'bench'],
    { cwd: repo.root, env: repo.env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not set up the checkout: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
}

function writeSettings(repo, task, wt, file, secrets) {
  const r = spawnSync(process.execPath, [join(HERE, 'worker-settings.mjs'), 'worker', '--ticket', `bench-${task.id}`, '--wt', wt, '--out', file],
    { cwd: repo.root, env: repo.env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not generate the arm's settings: ${(r.stderr || '').trim()}`);
  const generated = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, `${JSON.stringify(armSettings(generated, { wt, secrets, lockDirs: both(lockDir()) }), null, 2)}\n`);
}

// One claude run, its stream going straight to the transcript. -> readRun's verdict plus usage.
function runClaude(task, arm, wt, settings, opts, dir) {
  const file = join(dir, 'transcript.jsonl');
  const fd = openSync(file, 'w');
  const err = openSync(join(dir, 'stderr.log'), 'w');
  const args = claudeArgs({ prompt: task.prompt, arm: 'base', budget: opts.budget, model: arm.model, effort: arm.effort, format: 'stream-json', extra: ['--verbose', '--settings', settings] });
  const proc = spawnSync('claude', args, { cwd: wt, env: armEnv(), stdio: ['ignore', fd, err], timeout: opts.timeout * 1000, killSignal: 'SIGKILL' });
  closeSync(fd);
  closeSync(err);
  const stdout = readFileSync(file, 'utf8');
  return { ...readRun({ ...proc, stdout }, opts.timeout), tokens: logTokens(stdout), attempts: reachAttempts(stdout) };
}

// The arm's whole change against the commit it started on, committed or not.
function saveDiff(wt, baseline, file) {
  git(wt, 'add', '-A');
  const fd = openSync(file, 'w');
  const r = spawnSync('git', ['-C', wt, 'diff', '--cached', '--binary', baseline], { stdio: ['ignore', fd, 'ignore'], env: armEnv() });
  closeSync(fd);
  if (r.status !== 0) throw new Error('git diff failed');
}

// Copies the hidden tests in and runs them, writing test-output.log in `dir`. -> { status, why? }
export function score(repo, task, wt, dir, timeout = SCORE_TIMEOUT_MS) {
  for (const f of task.hidden_tests.files) {
    mkdirSync(dirname(join(wt, f)), { recursive: true });
    cpSync(join(task.hidden_tests.dir, f), join(wt, f), { force: true });
  }
  const log = [];
  let failed = null;
  for (const { dir: d, cmd, files } of testRuns(repo.items, runFiles(task)).runs) {
    const cap = repo.cap && takesFiles(cmd) ? ` --maxWorkers=${repo.cap}` : '';
    const line = `${cmd}${cap} ${files.map(shq).join(' ')}`;
    const r = runItem({ bin: HERE, root: wt, dir: d, cmd: line, lock: 'test', prefix: repo.prefix, env: armEnv(), timeout });
    log.push(`$ ${line}\n${r.out}\nexit ${r.code}\n`);
    writeFileSync(join(dir, 'test-output.log'), log.join('\n'));
    if (r.stopped) return { status: 'failed', why: `the hidden tests did not finish: ${line}` };
    if (r.code !== 0) failed ??= line;
  }
  return failed ? { status: 'rejected', why: `a hidden test failed: ${failed}` } : { status: 'accepted' };
}

// One task on one arm, start to tidy-up. Whatever goes wrong is this run's failure, with the reason.
function runOne(repo, task, arm, order, opts, out, dir, secrets) {
  mkdirSync(dir, { recursive: true });
  const result = { task: task.id, arm: arm.name, repo: task.repo, base: task.base, model: arm.model, effort: arm.effort, order: order.map((a) => a.name),
    status: 'failed', why: null, cost: null, tokens: null, attempts: [], at: new Date().toISOString() };
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'desk-bench-'));
  const wt = join(parent, 'checkout');
  try {
    makeCheckout(repo, task, wt);
    const settings = join(parent, 'settings.json');
    writeSettings(repo, task, wt, settings, secrets);
    const run = runClaude(task, arm, wt, settings, opts, dir);
    Object.assign(result, { cost: run.cost, tokens: run.tokens, attempts: run.attempts, why: run.why ?? null });
    saveDiff(wt, task.base, join(dir, 'diff.patch'));
    if (run.ok) Object.assign(result, score(repo, task, wt, dir));
  } catch (e) {
    result.status = 'failed';
    result.why = e.message;
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
  writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function stored(file) {
  try { const r = JSON.parse(readFileSync(file, 'utf8')); return SCORED.has(r.status) ? r : null; } catch { return null; }
}

// Runs every task on every arm and writes run.json under the output folder.
export function runBench(opts, log = () => {}) {
  const tasks = loadBenchTasks(opts.tasks);
  const repos = new Map();
  for (const t of tasks) {
    if (!repos.has(t.repo)) repos.set(t.repo, readRepo(t.repo));
    const { orphans } = testRuns(repos.get(t.repo).items, runFiles(t));
    if (orphans.length) throw new Error(`task ${t.id}: no §4 Unit tests item covers ${orphans.join(', ')}`);
  }
  const out = resolve(opts.out || join(dirname(resolve(opts.tasks)), 'bench-out'));
  mkdirSync(join(out, 'runs'), { recursive: true });
  const budget = Number(opts.budget), total = Number(opts.total);
  let spent = 0;
  const report = tasks.map((task) => {
    const repo = repos.get(task.repo);
    const order = armOrder(opts.arms, opts.seed, task.id);
    const secrets = [repo.root, resolve(opts.tasks), task.hidden_tests.dir, out].flatMap(both);
    const runs = order.map((arm) => {
      const dir = join(out, 'runs', `${task.id}.${arm.name}.${runKey(task, arm)}`);
      const prior = stored(join(dir, 'result.json'));
      if (prior) { log(`reuse ${task.id} (${arm.name}): ${prior.status}`); return { arm: arm.name, status: prior.status, reused: true, dir }; }
      if (spent + budget > total + 1e-9) { log(`skip ${task.id} (${arm.name}): $${spent.toFixed(2)} of $${total} spent`); return { arm: arm.name, status: 'not run', dir: null }; }
      log(`run ${task.id} (${arm.name})`);
      const r = runOne(repo, task, arm, order, opts, out, dir, secrets);
      spent += r.cost ?? budget;
      log(`  ${r.status}${r.why ? `: ${r.why}` : ''}`);
      return { arm: arm.name, status: r.status, why: r.why, dir };
    });
    return { task: task.id, order: order.map((a) => a.name), runs };
  });
  const path = join(out, 'run.json');
  writeFileSync(path, `${JSON.stringify({ seed: opts.seed, spent, tasks: report }, null, 2)}\n`);
  return { path, report };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { path, report } = runBench(opts, (m) => console.error(m));
    for (const t of report) for (const r of t.runs) console.log(`${t.task} ${r.arm}: ${r.status}${r.reused ? ' (reused)' : ''}`);
    console.log(`results: ${path}`);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
