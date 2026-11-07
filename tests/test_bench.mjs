// suite: bench (frozen tasks in throwaway checkouts, scored by hidden tests)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadBenchTasks, armOrder, armSettings, reachAttempts, runKey, testRuns } from '../desk/bin/bench.mjs';
import { logTokens } from '../desk/bin/worker-cost.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'bench.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-test-')));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const home = join(dir, 'home');
mkdirSync(home);
const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
for (const k of Object.keys(gitEnv)) if (/^(DESK_|JIRA_|GIT_DIR$|GIT_WORK_TREE$)/.test(k)) delete gitEnv[k];
writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { env: gitEnv, encoding: 'utf8' }).trim();

// A two-commit repo: the base has an older copy of one test the PR changed; the merge fixes src.txt
// and adds the other. Its test command runs each file it is given.
const repo = join(dir, 'repo');
mkdirSync(join(repo, 'tests'), { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv });
writeFileSync(join(repo, 'src.txt'), 'old\n');
writeFileSync(join(repo, 'run-tests.sh'), '#!/bin/sh\nfor f in "$@"; do sh "$f" || exit 1; done\n');
writeFileSync(join(repo, 'tests', 'old.sh'), 'exit 0 # OLD VERSION\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
const base = git('rev-parse', 'HEAD');
const FIXED = 'grep -q new src.txt\n';
writeFileSync(join(repo, 'src.txt'), 'new\n');
writeFileSync(join(repo, 'tests', 'old.sh'), FIXED);
writeFileSync(join(repo, 'tests', 'hidden.sh'), FIXED);
git('add', '-A');
git('commit', '-q', '-m', 'merge');
const merge = git('rev-parse', 'HEAD');
git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');

const configRoot = join(dir, 'config');
mkdirSync(join(configRoot, 'repos', 'acme__widgets'), { recursive: true });
writeFileSync(join(configRoot, 'repos', 'acme__widgets', 'config.md'), `## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`${repo}\` |
| Worktrees directory | \`${join(dir, 'wt')}\` |

## 3. Permissions
| Key | Value |
|---|---|
| \`git-push\` | \`yes\` |
| \`pr-open\` | \`yes\` |
| \`jira-comment\` | \`yes\` |
| \`worker-web-read\` | \`yes\` |

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Project subagents sync | \`none\` |
| Env files | \`none\` |
| Local database | \`none\` |
| Database URL variable | \`none\` |
| Database migrate | \`none\` |
| Unit tests | \`sh run-tests.sh\` |
`);

// The hidden copies live outside any checkout.
const hidden = join(dir, 'hidden');
mkdirSync(join(hidden, 'tests'), { recursive: true });
writeFileSync(join(hidden, 'tests', 'old.sh'), FIXED);
writeFileSync(join(hidden, 'tests', 'hidden.sh'), FIXED);
mkdirSync(join(hidden, 'tests', 'deep'));
writeFileSync(join(hidden, 'tests', 'deep', 'new.sh'), FIXED);

// A stub claude: logs what the run could see, then acts on words in the prompt. Its stream-json holds
// a tool call and its refusal where the prompt asks for a push.
const bin = join(dir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; };
const prompt = val('-p');
const sh = (c) => spawnSync('sh', ['-c', c], { encoding: 'utf8' });
const push = sh('git push origin HEAD');
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({
  args: a, cwd: process.cwd(), head: sh('git rev-parse HEAD').stdout.trim(),
  hiddenThere: fs.existsSync('tests/hidden.sh'), old: fs.readFileSync('tests/old.sh', 'utf8'), status: sh('git status --porcelain').stdout,
  remotes: sh('git remote').stdout, merge: sh('git cat-file -e ${merge}').status, pushCode: push.status,
  caching: Object.keys(process.env).filter((k) => k.startsWith('DISABLE_PROMPT_CACHING')),
  settings: JSON.parse(fs.readFileSync(val('--settings'), 'utf8')),
}) + '\\n');
const say = (o) => console.log(JSON.stringify(o));
if (prompt.includes('CRASH')) { process.stderr.write('boom'); process.exit(1); }
if (prompt.includes('SLOW')) { setTimeout(() => {}, 5000); return; }
if (prompt.includes('FIX')) fs.writeFileSync('src.txt', 'new\\n');
if (prompt.includes('NEW-FILE')) fs.writeFileSync('notes.txt', 'added\\n');
if (prompt.includes('PUSH')) {
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git push origin HEAD' } }] } });
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'denied' }] } });
}
say({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01,
  modelUsage: { m: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 } } });
`);
chmodSync(join(bin, 'claude'), 0o755);

const log = join(dir, 'calls.jsonl');
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const run = (args) => {
  rmSync(log, { force: true });
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: {
    ...gitEnv, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, DESK_CONFIG_ROOT: configRoot, DESK_LOCK_DIR: join(dir, 'locks'), DISABLE_PROMPT_CACHING: '1',
  } });
};
mkdirSync(join(dir, 'locks'));
const task = (id, prompt, files = ['tests/hidden.sh', 'tests/old.sh']) => ({ id, repo: 'acme/widgets', base, prompt, hidden_tests: { dir: 'hidden', files } });
const taskSet = (name, tasks) => { const f = join(dir, `${name}.json`); writeFileSync(f, JSON.stringify({ tasks })); return f; };
const armFlags = ['--arm', 'a=model-a:medium', '--arm', 'b=model-b:high'];
const flags = (name) => ['--max-budget-usd', '1', '--out', join(dir, name), '--seed', '7'];
const results = (out) => Object.fromEntries(readdirSync(join(out, 'runs')).filter((d) => existsSync(join(out, 'runs', d, 'result.json')))
  .map((d) => { const r = JSON.parse(readFileSync(join(out, 'runs', d, 'result.json'), 'utf8')); return [`${r.task}.${r.arm}`, { ...r, dir: join(out, 'runs', d) }]; }));

// AC8: no task set or no arm refuses, names the flag and starts nothing.
const set = taskSet('main', [task('fixed', 'FIX it'), task('wrong', 'do nothing')]);
let r = run(['--arm', 'a', '--max-budget-usd', '1']);
t('AC8 no task set exits 2', r.status, 2);
t('AC8 names --tasks', /--tasks is required/.test(r.stderr), true);
r = run(['--tasks', set, '--max-budget-usd', '1']);
t('AC8 no arm exits 2', r.status, 2);
t('AC8 names --arm', /--arm is required/.test(r.stderr), true);
t('AC8 starts nothing', calls().length, 0);
t('a run needs a budget', /--max-budget-usd/.test(throws(() => parseArgs(['--tasks', 'x', '--arm', 'a']))), true);
t('two arms cannot share a name', /own name/.test(throws(() => parseArgs(['--tasks', 'x', '--arm', 'a', '--arm', 'a', '--max-budget-usd', '1']))), true);
t('an arm names a model and an effort', JSON.stringify(parseArgs(['--tasks', 'x', '--arm', 'a=m:high', '--max-budget-usd', '1']).arms), '[{"name":"a","model":"m","effort":"high"}]');

// The task set's format.
const badSet = (over) => taskSet('bad', [{ ...task('x', 'p'), ...over }]);
t('a repo is owner/name', /repo must be/.test(throws(() => loadBenchTasks(badSet({ repo: 'widgets' })))), true);
t('a base is a full SHA', /full commit SHA/.test(throws(() => loadBenchTasks(badSet({ base: 'abc123' })))), true);
t('a hidden test stays in the repo', /inside the repo/.test(throws(() => loadBenchTasks(badSet({ hidden_tests: { dir: 'hidden', files: ['../x'] } })))), true);
t('a hidden test has a copy', /no hidden test copy/.test(throws(() => loadBenchTasks(badSet({ hidden_tests: { dir: 'hidden', files: ['tests/none.sh'] } })))), true);
r = run(['--tasks', taskSet('noconfig', [{ ...task('x', 'p'), repo: 'acme/other' }]), '--arm', 'a', '--max-budget-usd', '1']);
t('a repo with no desk config refuses before any run', /no desk config for acme\/other/.test(r.stderr) && calls().length === 0, true);

// AC1, AC2, AC4, AC5, AC6, AC9, AC10 on one real invocation.
const out = join(dir, 'out');
r = run(['--tasks', set, ...armFlags, ...flags('out')]);
if (r.status !== 0) console.log(r.stderr);
t('runs to completion', r.status, 0);
const c = calls();
t('every task on every arm', c.length, 4);
t('AC1 the arm starts on the base commit', c.every((x) => x.head === base), true);
t('AC1 a new hidden test is absent during the run', c.every((x) => !x.hiddenThere), true);
t('AC1 a changed one is there only in its base version', c.every((x) => x.old === 'exit 0 # OLD VERSION\n'), true);
t('AC1 the tree is clean at the start', c.every((x) => x.status === ''), true);
t('AC1 each run has its own new checkout', new Set(c.map((x) => x.cwd)).size, 4);
t('AC1 the merge commit is not in the checkout', c.every((x) => x.merge !== 0), true);
t('AC4 there is no remote to push to', c.every((x) => x.remotes === '' && x.pushCode !== 0), true);
const res = results(out);
t('AC2 every hidden test passing is accepted', res['fixed.a'].status, 'accepted');
t('AC2 both arms scored', res['fixed.b'].status, 'accepted');
t('AC2 a failing hidden test is rejected', res['wrong.a'].status, 'rejected');
t('AC2 the rejection names the test command', /sh run-tests\.sh/.test(res['wrong.a'].why), true);
t('AC2 the test output is kept', readFileSync(join(res['wrong.a'].dir, 'test-output.log'), 'utf8').includes('exit 1'), true);
t('AC6 nothing disables caching', c.every((x) => !x.caching.length && !x.args.some((a) => /cach/i.test(a))), true);
t('AC6 tokens recorded by kind', JSON.stringify(res['fixed.a'].tokens), '{"uncached":10,"cacheWrite":30,"cacheRead":40,"output":20}');
t('AC9 the checkout is removed', c.every((x) => !existsSync(x.cwd)), true);
t('AC9 the diff is kept', /^\+new$/m.test(readFileSync(join(res['fixed.a'].dir, 'diff.patch'), 'utf8')), true);
t('AC9 the diff holds only the arm\'s change', /old\.sh|hidden\.sh/.test(readFileSync(join(res['fixed.a'].dir, 'diff.patch'), 'utf8')), false);
t('AC9 the transcript is kept', readFileSync(join(res['fixed.a'].dir, 'transcript.jsonl'), 'utf8').includes('"result"'), true);
const argOf = (x, f) => x.args[x.args.indexOf(f) + 1];
t('AC10 model reaches claude', c.filter((x) => argOf(x, '--model') === 'model-a').length, 2);
t('AC10 effort reaches claude', c.filter((x) => argOf(x, '--model') === 'model-b').every((x) => argOf(x, '--effort') === 'high'), true);
t('AC10 the result records both', `${res['fixed.b'].model} ${res['fixed.b'].effort}`, 'model-b high');
t('every run has a stream to read', c.every((x) => argOf(x, '--output-format') === 'stream-json' && x.args.includes('--verbose')), true);

// AC4: what an arm may run, on a config that grants a worker all of it.
const s = c[0].settings;
const rules = s.permissions.allow;
t('AC4 no gh rule is allowed', rules.some((a) => /\bgh\b/.test(a)), false);
t('AC4 no Jira rule is allowed', rules.some((a) => /desk-jira/.test(a)), false);
t('AC4 no push rule is allowed', rules.some((a) => /git.* push/.test(a)), false);
t('AC4 no web is allowed', rules.some((a) => /^Web/.test(a)), false);
t('AC1 no fetch is allowed, so no URL brings the merged commit in', rules.some((a) => /\bgit\b.*\sfetch\b/.test(a)), false);
t('AC1 a fetch rule is taken out in every form', armSettings({ permissions: { allow: ['Bash(git fetch:*)', 'Bash(/usr/bin/git fetch:*)', 'Bash(git -C /wt fetch:*)', 'Bash(git status:*)'], deny: [], additionalDirectories: [] } }, { wt: '/wt', secrets: [], lockDirs: [] }).permissions.allow.join(), 'Bash(git status:*)');
t('AC4 push denied', s.permissions.deny.includes('Bash(git push:*)'), true);
t('AC4 gh denied whatever the subcommand', s.permissions.deny.includes('Bash(gh:*)'), true);
t('AC4 Jira denied', s.permissions.deny.includes('Bash(desk-jira:*)'), true);
t('an arm edits only its checkout', rules.filter((a) => a.startsWith('Edit(')).every((a) => a.startsWith(`Edit(/${c[0].cwd}/`)), true);
t('an arm still runs the repo\'s tests', rules.some((a) => a.includes('sh run-tests.sh')), true);
t('the primary checkout is denied by name', s.permissions.deny.includes(`Bash(*${repo}*)`) && s.permissions.deny.includes(`Read(/${repo}/**)`), true);
t('the hidden tests are denied by name', s.permissions.deny.includes(`Bash(*${hidden}*)`), true);
t('the results are denied by name', s.permissions.deny.includes(`Read(/${out}/**)`), true);
t('no desk state reaches an arm', s.permissions.additionalDirectories.every((d) => !d.includes('.desk-autopilot') && !d.includes('skills')), true);
t('armSettings leaves its input alone', (() => {
  const g = { permissions: { allow: ['Bash(gh pr view:*)', 'Edit(//wt/**)', 'Edit(//state/x)'], deny: [], additionalDirectories: ['/lock', '/state'] } };
  const a = armSettings(g, { wt: '/wt', secrets: [], lockDirs: ['/lock'] });
  return `${a.permissions.allow.join()} ${a.permissions.additionalDirectories.join()} ${g.permissions.allow.length}`;
})(), 'Edit(//wt/**) /lock 3');

// AC4: an attempt is recorded in that run's result, refused or not.
const push = join(dir, 'out-push');
r = run(['--tasks', taskSet('push', [task('push', 'PUSH then FIX')]), '--arm', 'a', ...flags('out-push')]);
const pushed = results(push)['push.a'];
t('AC4 the attempt is recorded', JSON.stringify(pushed.attempts), '[{"kind":"push","tool":"Bash","call":"git push origin HEAD","refused":true}]');
t('AC4 an attempt does not change the score', pushed.status, 'accepted');
const stream = (command) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command } }] } })}\n`;
t('AC4 a PR attempt counts', reachAttempts(stream('gh pr create --draft'))[0].kind, 'pr');
t('AC4 a Jira attempt counts', reachAttempts(stream('desk-jira comment X-1 hi'))[0].kind, 'jira');
t('AC4 a pushed path counts', reachAttempts(stream('cd x && /usr/bin/git -C y push origin z'))[0].kind, 'push');
t('AC4 a commit naming a push does not', reachAttempts(stream('git commit -m "push the fix"')).length, 0);

// AC5: arms shuffle per task, a seed repeats, and the order is recorded.
const arms = ['a', 'b', 'c'].map((name) => ({ name }));
const firsts = new Set(Array.from({ length: 30 }, (_, i) => armOrder(arms, '7', `task-${i}`)[0].name));
t('AC5 no arm always starts', firsts.size, 3);
t('AC5 a seed repeats its order', armOrder(arms, '7', 'x').map((a) => a.name).join(), armOrder(arms, '7', 'x').map((a) => a.name).join());
const runFile = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
t('AC5 the seed is recorded', runFile.seed, '7');
t('AC5 the order is recorded per task', runFile.tasks.every((x) => x.order.length === 2 && x.order.join() === x.runs.map((y) => y.arm).join()), true);
t('AC5 and in each result', res['fixed.a'].order.join(), runFile.tasks[0].order.join());

// AC7: a scored task and arm is reused with no new run; other settings are not.
r = run(['--tasks', set, ...armFlags, ...flags('out')]);
t('AC7 a second run starts nothing', calls().length, 0);
t('AC7 and says so', /fixed a: accepted \(reused\)/.test(r.stdout), true);
r = run(['--tasks', set, '--arm', 'a=model-a:high', ...flags('out')]);
t('AC7 other arm settings run again', calls().length, 2);
t('AC7 the key follows the base', runKey({ base: 'x', prompt: 'p' }, {}) === runKey({ base: 'y', prompt: 'p' }, {}), false);

// AC3: errors and timeouts are failed, with the reason, counted neither way; they run again.
const failOut = join(dir, 'out-fail');
const failSet = taskSet('fail', [task('crash', 'CRASH now'), task('slow', 'SLOW please'), { ...task('nobase', 'FIX'), base: 'a'.repeat(40) }]);
r = run(['--tasks', failSet, '--arm', 'a', '--timeout', '1', ...flags('out-fail')]);
t('failed runs do not fail the bench', r.status, 0);
const failed = results(failOut);
t('AC3 an error is failed', failed['crash.a'].status, 'failed');
t('AC3 with its reason', failed['crash.a'].why, 'claude exited 1');
t('AC3 a timeout is failed', `${failed['slow.a'].status}: ${failed['slow.a'].why}`, 'failed: timed out after 1s');
t('AC3 a base that cannot be set up is failed', failed['nobase.a'].status === 'failed' && /could not set up/.test(failed['nobase.a'].why), true);
t('AC3 no hidden test ran for a failed run', existsSync(join(failed['crash.a'].dir, 'test-output.log')), false);
t('AC3 a failed run leaves no checkout', calls().every((x) => !existsSync(x.cwd)), true);
r = run(['--tasks', failSet, '--arm', 'a', '--timeout', '1', ...flags('out-fail')]);
t('AC7 a failed run is not reused', calls().length, 2);

// The whole-run budget: a run that does not fit is listed, never started.
const capped = join(dir, 'out-cap');
r = run(['--tasks', taskSet('cap', [task('one', 'FIX'), task('two', 'FIX')]), '--arm', 'a', '--max-budget-usd', '1', '--total-budget-usd', '1', '--out', capped, '--seed', '7']);
t('a run past the total is not started', calls().length, 1);
t('and is listed', /two a: not run/.test(r.stdout), true);

// The arm's own change is kept whether it committed or not; a new file counts.
const newOut = join(dir, 'out-new');
r = run(['--tasks', taskSet('new', [task('new', 'NEW-FILE FIX', ['tests/deep/new.sh'])]), '--arm', 'a', ...flags('out-new')]);
t('AC9 an untracked file is in the diff', readFileSync(join(results(newOut)['new.a'].dir, 'diff.patch'), 'utf8').includes('notes.txt'), true);
t('AC2 a hidden test in a new directory is scored', results(newOut)['new.a'].status, 'accepted');

// Which test item runs which file.
const items = [{ dir: '.', cmd: 'root' }, { dir: 'apps/api', cmd: 'api' }, { dir: 'apps/api', cmd: 'api2' }];
const plan = testRuns(items, ['a.test', 'apps/api/b.test']);
t('a file goes to the deepest items, relative to them', JSON.stringify(plan.runs.map((x) => [x.cmd, x.files])), '[["root",["a.test"]],["api",["b.test"]],["api2",["b.test"]]]');
t('a file no item covers is named', testRuns([{ dir: 'apps', cmd: 'x' }], ['b.test']).orphans.join(), 'b.test');

t('logTokens falls back to usage', JSON.stringify(logTokens(`${JSON.stringify({ type: 'result', usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 } })}\n`)), '{"uncached":1,"cacheWrite":2,"cacheRead":3,"output":4}');
t('logTokens with no result is null', logTokens('nope\n'), null);

if (fails) { console.log(`FAIL ${fails} check(s) failed`); process.exit(1); }
console.log('all bench checks passed');
