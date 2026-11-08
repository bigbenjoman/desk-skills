// suite: bench arm 4 (PR text on Opus, on Haiku and from the template with no model)
// covers: desk/bin/bench-pr-text.mjs desk/bin/bench-pr-text-rubric.md
// A stub claude on PATH, and two scratch repos: one with a PR template and a PR-description check that
// fails on a missing section, one with neither.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DESK_TEMPLATE, MAX_PROMPT, NO_CHECKS, SIDES, checkCell, fillTemplate, parseArgs, promptFrom } from '../desk/bin/bench-pr-text.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-pr-text-test-')));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const home = join(dir, 'home');
mkdirSync(home);
const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
for (const k of Object.keys(gitEnv)) if (/^(DESK_|JIRA_|GIT_DIR$|GIT_WORK_TREE$|AUTOPILOT_|CODEX_HOME$|CLAUDE_CONFIG_DIR$)/.test(k)) delete gitEnv[k];
writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n');

const TEMPLATE = '## Summary\n<!-- what and why -->\nExplain it here.\n\n## Changes\n\n## Testing\n- [ ] ran the suite\n\n## Rollback plan\n';

function makeRepo(name, files, checks) {
  const repo = join(dir, name);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { env: gitEnv, encoding: 'utf8' }).trim();
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv });
  for (const [f, text] of Object.entries({ 'src.txt': 'old\n', 'run-tests.sh': '#!/bin/sh\nexit 0\n', ...files })) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src.txt'), 'new\n');
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'tests', 'hidden.sh'), 'exit 0\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: start the counter at one hundred');
  const merge = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', `git@github.com:acme/${name}.git`);
  const cfg = join(dir, 'config', 'repos', `acme__${name}`);
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'config.md'), `## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/${name}\` |
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
| Command prefix | \`none\` |
| Install | \`none\` |
| Project subagents sync | \`none\` |
| Env files | \`none\` |
| Local database | \`none\` |
| Database URL variable | \`none\` |
| Database migrate | \`none\` |
| Unit tests | \`sh run-tests.sh\` |
${checks == null ? '' : `| PR-description checks | ${checks} |\n`}`);
  return { base, merge };
}

const checked = makeRepo('checked', { '.github/pull_request_template.md': TEMPLATE, 'check.sh': 'grep -q "^## Summary" "$1"\n' }, '`sh check.sh`');
const plain = makeRepo('plain', {}, '`none`');
const noRow = makeRepo('norow', {}, null);
const unsetRow = makeRepo('unsetrow', {}, '`TODO`');

const setDir = join(dir, 'set');
mkdirSync(join(setDir, 'hidden', 'tests'), { recursive: true });
writeFileSync(join(setDir, 'hidden', 'tests', 'hidden.sh'), 'exit 0\n');
const task = (id, name, c) => ({ id, repo: `acme/${name}`, base: c.base, merge: c.merge, prompt: `${id}: start the counter at one hundred`, hidden_tests: { dir: 'hidden', files: ['tests/hidden.sh'] } });
const setFile = join(setDir, 'tasks.json');
writeFileSync(setFile, JSON.stringify({ tasks: [task('one', 'checked', checked), { ...task('nomerge', 'checked', checked), merge: undefined }] }));
const plainFile = join(setDir, 'plain.json');
writeFileSync(plainFile, JSON.stringify({ tasks: [task('bare', 'plain', plain)] }));
const unconfiguredFile = join(setDir, 'unconfigured.json');
writeFileSync(unconfiguredFile, JSON.stringify({ tasks: [task('absent', 'norow', noRow), task('todo', 'unsetrow', unsetRow)] }));
const badRepoFile = join(setDir, 'bad-repo.json');
writeFileSync(badRepoFile, JSON.stringify({ tasks: [task('fine', 'plain', plain), task('bad', 'missing', plain)] }));

const bin = join(dir, 'bin');
mkdirSync(bin);
// Opus writes the Summary section the check wants, Haiku leaves it out, and both sign the text.
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; };
const prompt = val('-p');
const u = JSON.parse(fs.readFileSync(process.env.STUB_USAGE, 'utf8'));
const say = (o) => console.log(JSON.stringify(o));
if (prompt === 'Reply with: ok') {
  say({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.01, resetsAt: u.reset }, seven_day: { utilization: u.used, resetsAt: u.reset } } } });
  say({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  return;
}
u.used += 0.001; fs.writeFileSync(process.env.STUB_USAGE, JSON.stringify(u));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args: a, entries: fs.readdirSync('.'), settings: JSON.parse(fs.readFileSync(val('--settings'), 'utf8')) }) + '\\n');
say({ type: 'system', subtype: 'init', model: 'claude-' + val('--model') + '-stub' });
const body = val('--model') === 'opus' ? '## Summary\\nWritten by claude-opus-5.\\n' : '## Changes\\nWritten by haiku.\\n';
say({ type: 'result', subtype: 'success', is_error: false, result: body, total_cost_usd: 0.01,
  modelUsage: { m: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 } } });
`);
chmodSync(join(bin, 'claude'), 0o755);

const log = join(dir, 'calls.jsonl');
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const usageFile = join(dir, 'usage.json');
const reset = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
writeFileSync(usageFile, JSON.stringify({ used: 0.1, reset }));
mkdirSync(join(dir, 'locks'));
const env = { ...gitEnv, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, DESK_CONFIG_ROOT: join(dir, 'config'), DESK_LOCK_DIR: join(dir, 'locks'),
  STUB_USAGE: usageFile, DESK_USAGE_DIR: join(dir, 'usage'), DESK_SUBSCRIPTIONS: join(dir, 'subscriptions.md') };
const node = (script, args) => spawnSync(process.execPath, [join(BIN, script), ...args], { cwd: dir, encoding: 'utf8', env });
const run = (args) => { rmSync(log, { force: true }); return node('bench-pr-text.mjs', args); };
const results = (out) => Object.fromEntries(readdirSync(join(out, 'runs')).filter((d) => existsSync(join(out, 'runs', d, 'result.json')))
  .map((d) => { const r = JSON.parse(readFileSync(join(out, 'runs', d, 'result.json'), 'utf8')); return [r.arm, { ...r, body: existsSync(join(out, 'runs', d, 'description.md')) ? readFileSync(join(out, 'runs', d, 'description.md'), 'utf8') : null }]; }));

// The arguments and the fill.
t('AC1 the three sides', SIDES.map((s) => s.name).join(' '), 'opus haiku no-model');
t('an arm of its own is refused', /sets its own sides/.test(throws(() => parseArgs(['--tasks', 'x', '--arm', 'a', '--max-budget-usd', '1']))), true);
t('the bench flags still apply', /--max-budget-usd/.test(throws(() => parseArgs(['--tasks', 'x']))), true);
const inputs = { ticket: 'Make it so.\nMore detail.', commits: ['feat: one'], files: ['M\tsrc/a.js', 'A\ttests/test_a.mjs'], diff: 'D'.repeat(10), template: { source: 'x', text: TEMPLATE } };
const filled = fillTemplate(inputs);
t('the fill drops guidance and comments', /what and why|Explain it/.test(filled), false);
t('the fill puts the ticket under Summary', filled.includes('## Summary\n\nMake it so.\nMore detail.'), true);
t('the fill lists the commits under Changes', filled.includes('## Changes\n\n- feat: one'), true);
t('the fill names the changed tests and keeps the checklist', filled.includes('## Testing\n\nTest files changed:\n- tests/test_a.mjs\n\n- [ ] ran the suite'), true);
t('a heading it cannot fill says so', filled.includes('## Rollback plan\n\nNot recorded.'), true);
t('a template with no headings gets the desk sections', fillTemplate({ ...inputs, template: { text: 'Please describe.\n' } }).includes('### Testing'), true);
t('the desk sections name Summary and Testing', /Summary[\s\S]*Testing/.test(DESK_TEMPLATE), true);
const big = promptFrom({ ...inputs, diff: 'é'.repeat(MAX_PROMPT) });
t('a large diff is cut to fit', big.truncated && Buffer.byteLength(big.prompt) <= MAX_PROMPT + 40, true);
t('the cut is marked', big.prompt.endsWith('[diff cut here to fit]'), true);
t('a small diff is whole', promptFrom(inputs).truncated, false);
t('no checks is not a pass', checkCell({ written: 2, checked: 0, passed: 0, noChecks: 2, unfinished: 0 }), NO_CHECKS);
t('checks that never finished are not read as none configured', checkCell({ written: 2, checked: 0, passed: 0, noChecks: 1, unfinished: 1 }), `1 did not finish (1 ${NO_CHECKS})`);
t('a mix shows both', checkCell({ written: 3, checked: 2, passed: 1, noChecks: 1, unfinished: 0 }), `1 of 2 passed (1 ${NO_CHECKS})`);

// AC1, AC2: one task, three sides, checks per side.
const out = join(dir, 'out');
let r = run(['--tasks', setFile, '--max-budget-usd', '1', '--out', out, '--seed', '3']);
if (r.status !== 0) console.log(r.stderr);
t('runs to completion', r.status, 0);
const res = results(out);
const cl = calls();
t('AC1 one call each for Opus and Haiku', cl.map((c) => c.args[c.args.indexOf('--model') + 1]).sort().join(' '), 'haiku opus');
t('AC1 both model sides get the same prompt', cl[0].args[cl[0].args.indexOf('-p') + 1] === cl[1].args[cl[1].args.indexOf('-p') + 1], true);
const prompt = cl[0].args[cl[0].args.indexOf('-p') + 1];
t('AC1 the prompt holds ticket, commit, file, diff and template', ['one: start the counter', 'feat: start the counter', 'M\tsrc.txt', '+new', '## Rollback plan'].every((x) => prompt.includes(x)), true);
t('a model side runs in an empty folder', cl.every((c) => c.entries.length === 0), true);
t('a model side has no tools', cl.every((c) => ['Bash', 'Read', 'Edit', 'Write'].every((x) => c.settings.permissions.deny.includes(x))), true);
t('AC1 the no-model side makes no call and records no model or tokens', `${res['no-model'].model} ${res['no-model'].tokens} ${res['no-model'].quota}`, 'null null undefined');
t('AC1 the no-model side fills the repo template', res['no-model'].body.includes('## Rollback plan') && res['no-model'].template === '.github/pull_request_template.md', true);
t('AC2 the check passes a description with the section', `${res.opus.check.status} ${res['no-model'].check.status}`, 'passed passed');
t('AC2 the check fails one without it', res.haiku.check.status, 'failed');
t('a model side records tokens and points', typeof res.opus.tokens.output === 'number' && typeof res.opus.quota.points === 'number', true);
t('a task with no merge is left out and named', r.stdout.includes('nomerge: left out, the task records no merge commit'), true);

// AC4: the blind export, unchanged in its letters and redaction.
r = node('bench-blind.mjs', ['export', '--tasks', setFile, '--out', out]);
if (r.status !== 0) console.log(r.stderr);
t('AC4 the export runs', r.status, 0);
const sheet = readFileSync(join(out, 'blind', 'sheets', 'one.md'), 'utf8');
t('AC4 three descriptions under letters', ['A', 'B', 'C'].every((l) => sheet.includes(`## Description ${l}`)), true);
t('AC4 the descriptions are shown', sheet.includes('Written by') && sheet.includes('```markdown'), true);
t('AC4 no side is named', /\bopus\b|\bhaiku\b|no-model/i.test(sheet), false);
t('AC4 the sheet carries the PR text rubric', sheet.includes('A good description'), true);

// AC5: the report.
const key = JSON.parse(readFileSync(join(out, 'blind', 'key.json'), 'utf8')).tasks.one;
const letter = (arm) => Object.keys(key).find((l) => key[l].arm === arm);
writeFileSync(join(out, 'blind', 'scores.csv'), `task,letter,score\none,${letter('opus')},5\none,${letter('haiku')},2\none,${letter('no-model')},3\n`);
r = node('bench-blind.mjs', ['join', '--tasks', setFile, '--out', out]);
t('AC5 the join runs', r.status, 0);
r = node('bench-pr-text.mjs', ['report', '--tasks', setFile, '--out', out]);
if (r.status !== 0) console.log(r.stderr);
const rep = readFileSync(join(out, 'report.md'), 'utf8');
const row = (label) => rep.split('\n').find((l) => l.startsWith(`| ${label}`));
t('AC5 the columns', row('Figure'), '| Figure | opus | haiku | no-model |');
t('AC5 check pass rate per side', row('PR-description checks'), '| PR-description checks | 1 of 1 passed | 0 of 1 passed | 1 of 1 passed |');
t('AC5 mean blind score per side', row('Mean blind'), '| Mean blind score (1 to 5) | 5.00 (1 scored) | 2.00 (1 scored) | 3.00 (1 scored) |');
t('AC5 tokens per description', row('Median output'), '| Median output tokens per description | 20 | 20 | no model call |');
t('AC5 input tokens counts every kind', row('Median input'), '| Median input tokens per description (all kinds) | 80 | 80 | no model call |');
t('AC5 quota points, none for no-model', /^\| Median quota points per description \| [\d.]+ \| [\d.]+ \| no model call \|$/.test(row('Median quota')), true);
t('the report names what it left out', rep.includes('nomerge: the task records no merge commit'), true);

// A second run spends nothing.
r = run(['--tasks', setFile, '--max-budget-usd', '1', '--out', out, '--seed', '3']);
t('a written side is reused', `${r.status} ${calls().length}`, '0 0');

// A check that did not finish runs again, on the description already paid for.
const opusDir = readdirSync(join(out, 'runs')).find((d) => d.startsWith('one.opus.'));
const opusResult = join(out, 'runs', opusDir, 'result.json');
writeFileSync(opusResult, JSON.stringify({ ...JSON.parse(readFileSync(opusResult, 'utf8')), check: { status: 'did not finish', runs: [] } }));
r = run(['--tasks', setFile, '--max-budget-usd', '1', '--out', out, '--seed', '3']);
t('a check that did not finish runs again with no model call', `${r.status} ${calls().length} ${JSON.parse(readFileSync(opusResult, 'utf8')).check.status}`, '0 0 passed');

// AC3: no checks, no template.
const bare = join(dir, 'bare-out');
r = run(['--tasks', plainFile, '--max-budget-usd', '1', '--out', bare, '--seed', '3']);
if (r.status !== 0) console.log(r.stderr);
const br = results(bare);
t('AC3 no checks configured, on every side', Object.values(br).map((x) => x.check.status).join(), `${NO_CHECKS},${NO_CHECKS},${NO_CHECKS}`);
t('no template: the desk sections, named', br['no-model'].template === 'desk-pr sections' && br['no-model'].body.includes('### Summary\n\nbare: start'), true);
node('bench-pr-text.mjs', ['report', '--tasks', plainFile, '--out', bare]);
t('AC3 the report reads it as no checks, not a pass', readFileSync(join(bare, 'report.md'), 'utf8').split('\n').find((l) => l.startsWith('| PR-description')), `| PR-description checks | ${NO_CHECKS} | ${NO_CHECKS} | ${NO_CHECKS} |`);

const unconfigured = join(dir, 'unconfigured-out');
r = run(['--tasks', unconfiguredFile, '--max-budget-usd', '1', '--out', unconfigured, '--seed', '3']);
if (r.status !== 0) console.log(r.stderr);
const noRowChecks = readdirSync(join(unconfigured, 'runs')).map((d) => JSON.parse(readFileSync(join(unconfigured, 'runs', d, 'result.json'), 'utf8')).check.status);
t('AC3 a row absent or unset reads as no checks configured', `${r.status} ${noRowChecks.length} ${noRowChecks.every((s) => s === NO_CHECKS)}`, '0 6 true');

// A repo that cannot be read refuses the run before any task spends.
r = run(['--tasks', badRepoFile, '--max-budget-usd', '1', '--out', join(dir, 'bad-out'), '--seed', '3']);
t('a bad repo refuses before anything is spent', `${r.status} ${calls().length} ${/no desk config for acme\/missing/.test(r.stderr)}`, '2 0 true');

// The quota guard: a model side stops, the no-model side still runs.
writeFileSync(usageFile, JSON.stringify({ used: 0.9, reset }));
const held = join(dir, 'held-out');
r = run(['--tasks', plainFile, '--max-budget-usd', '1', '--out', held, '--seed', '4']);
t('the quota guard stops the model sides', `${calls().length} ${/under the 25% interactive reserve/.test(r.stdout)}`, '0 true');
t('the no-model side still runs', r.stdout.includes('bare no-model: written'), true);

// The default output folder keeps away from the code arms'.
r = node('bench-pr-text.mjs', ['report', '--tasks', join(setDir, 'none.json')]);
t('the report defaults to its own folder', r.stderr.includes('bench-pr-text-out'), true);

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
