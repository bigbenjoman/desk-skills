// suite: bench-build (a task set frozen from merged PRs, kept only where the hidden tests fail at base and pass at merge)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, realpathSync, statSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, parsePr, testFiles, fieldsAt, counts, sizeOf, taskId } from '../desk/bin/bench-build.mjs';
import { keyRegex } from '../desk/bin/ticket-lint.mjs';
import { loadBenchTasks } from '../desk/bin/bench.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'bench-build.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-build-test-')));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const home = join(dir, 'home');
mkdirSync(home);
const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
for (const k of Object.keys(gitEnv)) if (/^(DESK_|JIRA_|GIT_DIR$|GIT_WORK_TREE$)/.test(k)) delete gitEnv[k];
writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n');
const repo = join(dir, 'repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { env: gitEnv, encoding: 'utf8' }).trim();
const commit = (files, msg) => {
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), body); }
  git('add', '-A');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};

// Four merged PRs in a row. Its test command runs each file it is given, so a fixture handed to it
// as a test would fail the run.
mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv });
const c0 = commit({ 'src.txt': 'old\n', 'run-tests.sh': '#!/bin/sh\nfor f in "$@"; do sh "$f" || exit 1; done\n', 'README': 'r\n' }, 'start');
const FIX_TEST = 'grep -q new src.txt && grep -q data tests/fixtures/input.txt\n';
const c1 = commit({ 'src.txt': 'new\n', 'tests/test_fix.sh': FIX_TEST, 'tests/fixtures/input.txt': 'data\n' }, 'DS-1 fix');
const c2 = commit({ 'tests/test_already.sh': 'exit 0\n' }, 'DS-2 already');
const c3 = commit({ 'README': 'r2\n' }, 'DS-3 docs');
const c4 = commit({ 'tests/test_broken.sh': 'exit 1\n' }, 'DS-4 broken');
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

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Ticket key pattern | \`DS-[0-9]+\` |
| Size field | \`customfield_1\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Project subagents sync | \`none\` |
| Env files | \`none\` |
| Local database | \`none\` |
| Database URL variable | \`none\` |
| Database migrate | \`none\` |
| Unit tests | \`sh run-tests.sh\` |
`);

// Stub gh and desk-jira: each answers from a fixture file and logs the call.
const stub = join(dir, 'stub');
mkdirSync(join(stub, 'gh'), { recursive: true });
mkdirSync(join(stub, 'jira'));
const bin = join(dir, 'bin');
mkdirSync(bin);
const stubScript = (kind, pick) => `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ kind: '${kind}', args: a, cwd: process.cwd() }) + '\\n');
const f = ${pick};
if (fs.existsSync(f.replace(/\\.json$/, '.kill'))) process.kill(process.ppid, 'SIGKILL');
if (!fs.existsSync(f)) { process.stderr.write('not found'); process.exit(1); }
process.stdout.write(fs.readFileSync(f, 'utf8'));
`;
writeFileSync(join(bin, 'gh'), stubScript('gh', `require('path').join('${stub}', 'gh', a[2] + '.json')`));
writeFileSync(join(bin, 'desk-jira'), stubScript('jira', `require('path').join('${stub}', 'jira', /issue\\/([A-Z]+-\\d+)/.exec(a[1])[1] + '.json')`));
chmodSync(join(bin, 'gh'), 0o755);
chmodSync(join(bin, 'desk-jira'), 0o755);

const FIRST = '2026-01-02T00:00:00Z';
const pr = (n, base, merge, paths) => writeFileSync(join(stub, 'gh', `${n}.json`), JSON.stringify({
  number: n, title: `feat: DS-${n} change`, headRefName: `feat/DS-${n}-x`, state: 'MERGED', baseRefOid: base, mergeCommit: { oid: merge },
  files: paths.map((p) => ({ path: p, changeType: 'MODIFIED' })), commits: [{ authoredDate: '2026-01-03T00:00:00Z' }, { authoredDate: FIRST }],
}));
pr(1, c0, c1, ['src.txt', 'tests/test_fix.sh', 'tests/fixtures/input.txt']);
pr(2, c1, c2, ['tests/test_already.sh']);
pr(3, c2, c3, ['README']);
pr(4, c3, c4, ['tests/test_broken.sh']);
pr(5, c0, c1, ['src.txt', 'tests/test_fix.sh']);

// DS-1's description was edited before the first commit (kept) and after it (left out), and its size
// changed after it too. DS-5 was created after the first commit.
const CREATED = '2025-12-01T00:00:00.000+0000';
const issue = (key, fields, histories) => writeFileSync(join(stub, 'jira', `${key}.json`), JSON.stringify({ key, fields: { created: CREATED, ...fields }, changelog: { total: histories.length, histories } }));
issue('DS-5', { summary: 'Late', description: 'written after the work', created: '2026-01-04T00:00:00.000+0000' }, []);
issue('DS-1', { summary: 'Fix the source', description: 'Make src say new. ANSWER: write new to src.txt', customfield_1: { value: 'S' } }, [
  { created: '2026-01-05T00:00:00.000+0000', items: [{ field: 'description', fieldId: 'description', fromString: 'Make src say new.', toString: 'Make src say new. ANSWER: write new to src.txt' }] },
  { created: '2026-01-04T00:00:00.000+0000', items: [{ field: 'Size', fieldId: 'customfield_1', fromString: 'XS', toString: 'S' }] },
  { created: '2026-01-01T00:00:00.000+0000', items: [{ field: 'description', fieldId: 'description', fromString: 'draft', toString: 'Make src say new.' }] },
]);
for (const k of ['DS-2', 'DS-3', 'DS-4']) issue(k, { summary: k, description: 'text', customfield_1: { value: 'M' } }, []);

const log = join(dir, 'calls.jsonl');
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
mkdirSync(join(dir, 'locks'));
const run = (args) => {
  rmSync(log, { force: true });
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: {
    ...gitEnv, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, DESK_CONFIG_ROOT: configRoot, DESK_LOCK_DIR: join(dir, 'locks'),
  } });
};

// Arguments.
t('no set refuses', /--set is required/.test(throws(() => parseArgs(['--pr', 'a/b#1']))), true);
t('no PR refuses', /--pr is required/.test(throws(() => parseArgs(['--set', 'x']))), true);
t('a PR URL is read', JSON.stringify(parsePr('https://github.com/acme/widgets/pull/12')), '{"repo":"acme/widgets","pr":12}');
t('a bad PR is named', /--pr widgets: want/.test(throws(() => parsePr('widgets'))), true);

// Which changed files are tests.
const tf = testFiles(['src/a.ts', 'src/a.test.ts', 'tests/test_x.sh', 'tests/fixtures/y.json', 'pkg/b_test.go', 'app/__tests__/helper.js', 'docs/testing.md']);
t('test files are hidden, fixtures beside them too', tf.files.join(), 'src/a.test.ts,tests/test_x.sh,tests/fixtures/y.json,pkg/b_test.go,app/__tests__/helper.js');
t('only test files are run', tf.run.join(), 'src/a.test.ts,tests/test_x.sh,pkg/b_test.go');

// The ticket text at a date.
const hist = [{ created: '2026-01-05T00:00:00Z', items: [{ fieldId: 'description', fromString: 'v2' }] }, { created: '2026-01-03T00:00:00Z', items: [{ fieldId: 'description', fromString: 'v1' }] }];
t('AC6 every edit after the cutoff is undone, oldest last', fieldsAt({ description: 'v3' }, hist, Date.parse('2026-01-02T00:00:00Z'), ['description']).description, 'v1');
t('AC6 an edit before the cutoff stays', fieldsAt({ description: 'v3' }, hist, Date.parse('2026-01-04T00:00:00Z'), ['description']).description, 'v2');
t('the size is the field\'s', sizeOf('m', 'Size: S\nbody'), 'M');
t('else a first line Size: S', sizeOf(null, '\n*Size:* S\nbody'), 'S');
t('else none', sizeOf('', 'body\nSize: S'), null);
t('two owners\' same-named repos get two task ids', taskId({ repo: 'acme/app', pr: 5 }) !== taskId({ repo: 'other/app', pr: 5 }), true);
t('a task id keeps its owner', taskId({ repo: 'acme/my.app', pr: 5 }), 'acme__my.app-5');
t('no key pattern reads <Jira project>-<n>', keyRegex((id) => ({ 'ticket-pattern': 'none', 'jira-project': '`KAN`' })[id]), 'KAN-[0-9]+');
t('counts per repo and per size',JSON.stringify(counts([{ repo: 'a/b', ticket: { size: 'M' } }, { repo: 'a/b', ticket: { size: null } }])), '{"repo":{"a/b":2},"size":{"M":1,"unsized":1}}');

// One build over all four PRs.
const setFile = join(dir, 'set', 'tasks.json');
const prs = [1, 2, 3, 4, 5].flatMap((n) => ['--pr', `acme/widgets#${n}`]);
let r = run(['--set', setFile, ...prs]);
if (r.status !== 0) console.log(r.stderr);
t('builds to completion', r.status, 0);
const set = JSON.parse(readFileSync(setFile, 'utf8'));
const task = set.tasks[0];
t('AC3 only the valid PR is kept', set.tasks.map((x) => x.id).join(), 'acme__widgets-1');
t('AC1 the repo is recorded', task.repo, 'acme/widgets');
t('AC1 the base commit is recorded', task.base, c0);
t('AC1 the merge commit is recorded', task.merge, c1);
t('AC1 the ticket key is recorded', task.ticket.key, 'DS-1');
t('AC1 the size is as it was then', task.ticket.size, 'XS');
t('AC6 the description is as it read at the first commit', task.ticket.description, 'Make src say new.');
t('AC6 no later text reaches the prompt', task.prompt.includes('ANSWER'), false);
t('AC6 the cutoff is the first commit', task.ticket.as_of, new Date(FIRST).toISOString());
t('the ticket is read from the repo\'s own Jira', calls().filter((c) => c.kind === 'jira').every((c) => realpathSync(c.cwd) === repo), true);
const hiddenDir = join(dir, 'set', 'acme__widgets-1', 'hidden');
t('AC2 the test files are the hidden tests', task.hidden_tests.files.join(), 'tests/test_fix.sh,tests/fixtures/input.txt');
t('AC2 copied at the merge commit', readFileSync(join(hiddenDir, 'tests', 'test_fix.sh'), 'utf8'), FIX_TEST);
t('AC2 beside the set, outside the repo', task.hidden_tests.dir === 'acme__widgets-1/hidden' && !hiddenDir.startsWith(repo), true);
t('AC2 a fixture is copied but not run', JSON.stringify(task.hidden_tests.run), '["tests/test_fix.sh"]');
t('the set loads as a bench task set', loadBenchTasks(setFile)[0].hidden_tests.dir, hiddenDir);
t('AC3 the base run failed', readFileSync(join(dir, 'set', 'acme__widgets-1', 'validate', 'base', 'test-output.log'), 'utf8').includes('exit 1'), true);
t('AC3 the merge run passed', readFileSync(join(dir, 'set', 'acme__widgets-1', 'validate', 'merge', 'test-output.log'), 'utf8').includes('exit 0'), true);
const why = Object.fromEntries(set.dropped.map((d) => [d.pr, d.why]));
t('AC4 passing at the base drops it', /already pass at the base/.test(why[2]), true);
t('AC5 no test changes skips it', /no tests to hide/.test(why[3]), true);
t('AC4 failing at the merge drops it', /fail at the merge commit/.test(why[4]), true);
t('AC6 a ticket created after the first commit drops it', /created after the PR's first commit/.test(why[5]), true);
t('AC5 a skipped PR runs no tests', existsSync(join(dir, 'set', 'acme__widgets-3')), false);
t('AC7 counts per repo', JSON.stringify(set.counts.repo), '{"acme/widgets":1}');
t('AC7 counts per size', JSON.stringify(set.counts.size), '{"XS":1}');
t('AC7 the build prints each dropped PR and why', ['#2: the hidden tests already pass', '#3: the PR changed no test files', '#4: the hidden tests fail'].every((s) => r.stdout.includes(s)), true);

// AC8: the same PRs again rewrite nothing; --rewrite builds them again.
const before = statSync(setFile).mtimeMs;
const text = readFileSync(setFile, 'utf8');
r = run(['--set', setFile, ...prs]);
t('AC8 a second run reads nothing', calls().length, 0);
t('AC8 and rewrites nothing', readFileSync(setFile, 'utf8') === text && statSync(setFile).mtimeMs === before, true);
t('AC8 and says so', /unchanged, not rewritten/.test(r.stdout), true);
writeFileSync(join(hiddenDir, 'tests', 'test_fix.sh'), 'edited\n');
r = run(['--set', setFile, '--pr', 'acme/widgets#1']);
t('AC8 a frozen task\'s hidden tests are left alone', readFileSync(join(hiddenDir, 'tests', 'test_fix.sh'), 'utf8'), 'edited\n');
r = run(['--set', setFile, '--pr', 'acme/widgets#1', '--rewrite']);
t('--rewrite builds it again', calls().some((c) => c.kind === 'gh') && readFileSync(join(hiddenDir, 'tests', 'test_fix.sh'), 'utf8') === FIX_TEST, true);
t('--rewrite keeps the others', JSON.parse(readFileSync(setFile, 'utf8')).dropped.length, 4);

// A build killed partway keeps each PR it finished before the kill.
writeFileSync(join(stub, 'gh', '6.kill'), '');
const killedSet = join(dir, 'killed', 'tasks.json');
r = run(['--set', killedSet, '--pr', 'acme/widgets#1', '--pr', 'acme/widgets#2', '--pr', 'acme/widgets#6']);
t('a killed build is killed', r.signal, 'SIGKILL');
const kept = existsSync(killedSet) ? JSON.parse(readFileSync(killedSet, 'utf8')) : { tasks: [], dropped: [] };
t('a killed build keeps the PRs it finished', `${kept.tasks.map((x) => x.id)}|${kept.dropped.map((d) => d.pr)}`, 'acme__widgets-1|2');

// The base is the merge commit's first parent, not GitHub's baseRefOid: PR 7 merged as c2 onto c1,
// though GitHub names c0, from before DS-1's fix landed. Read from c0, DS-1's fix would pass as PR 7's.
pr(7, c0, c2, ['tests/test_fix.sh']);
issue('DS-7', { summary: 'DS-7', description: 'text', customfield_1: { value: 'S' } }, []);
const staleSet = join(dir, 'stale', 'tasks.json');
r = run(['--set', staleSet, '--pr', 'acme/widgets#7']);
const stale = JSON.parse(readFileSync(staleSet, 'utf8'));
t('a stale baseRefOid is not the base: the PR\'s tests already pass at its real base', stale.tasks.length === 0 && /already pass at the base/.test(stale.dropped[0]?.why), true);

// A rebase merge lands the PR's two commits on main one by one, author dates kept: PR 8's tests in c5,
// its fix in c6. The base is c4, before both; c6's first parent, c5, already holds the tests.
const authored = (files, msg, date) => {
  for (const [f, body] of Object.entries(files)) writeFileSync(join(repo, f), body);
  git('add', '-A');
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', msg], { env: { ...gitEnv, GIT_AUTHOR_DATE: date } });
  return git('rev-parse', 'HEAD');
};
const c5 = authored({ 'tests/test_rebased.sh': 'grep -q rebased src.txt\n' }, 'DS-8 test', '2026-01-02T00:00:00Z');
const c6 = authored({ 'src.txt': 'rebased\n' }, 'DS-8 fix', '2026-01-03T00:00:00Z');
writeFileSync(join(stub, 'gh', '8.json'), JSON.stringify({
  number: 8, title: 'feat: DS-8 change', headRefName: 'feat/DS-8-x', state: 'MERGED', mergeCommit: { oid: c6 },
  files: [{ path: 'src.txt', changeType: 'MODIFIED' }, { path: 'tests/test_rebased.sh', changeType: 'ADDED' }],
  commits: [{ authoredDate: '2026-01-02T00:00:00Z' }, { authoredDate: '2026-01-03T00:00:00Z' }],
}));
issue('DS-8', { summary: 'DS-8', description: 'text', customfield_1: { value: 'S' } }, []);
const rebasedSet = join(dir, 'rebased', 'tasks.json');
r = run(['--set', rebasedSet, '--pr', 'acme/widgets#8']);
const rebased = JSON.parse(readFileSync(rebasedSet, 'utf8'));
t('a rebase-merged PR starts before its first commit, not at the merge\'s parent', rebased.tasks[0]?.base, c4);

// A PR outside any desk config, or not merged, is dropped with the reason.
r = run(['--set', join(dir, 'other.json'), '--pr', 'acme/other#1']);
t('a repo with no desk config is dropped', /acme\/other#1: no desk config/.test(r.stdout), true);

if (fails) { console.log(`FAIL ${fails} check(s) failed`); process.exit(1); }
console.log('all bench-build checks passed');
