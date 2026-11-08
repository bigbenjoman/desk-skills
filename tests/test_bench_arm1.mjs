// suite: bench arm 1 (the ticket as filed against the ticket plus a task packet)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ARMS, answerLines, diffLines, leak, parseArgs } from '../desk/bin/bench-arm1.mjs';
import { PACKET_HEADING, promptFor, ranAt, runKey } from '../desk/bin/bench.mjs';
import { renderReport, loadRun } from '../desk/bin/bench-report.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'bench-arm1.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-arm1-test-')));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const home = join(dir, 'home');
mkdirSync(home);
const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
for (const k of Object.keys(gitEnv)) if (/^(DESK_|JIRA_|GIT_DIR$|GIT_WORK_TREE$|AUTOPILOT_|CLAUDE_CONFIG_DIR$)/.test(k)) delete gitEnv[k];
writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { env: gitEnv, encoding: 'utf8' }).trim();

// The merge changes src.txt and adds a hidden test; its lines are what a packet may not quote.
const OLD_LINE = 'the widget counter starts at zero';
const NEW_LINE = 'the widget counter starts at one hundred';
const TEST_LINE = 'grep -q "one hundred" src.txt';
const repo = join(dir, 'repo');
mkdirSync(join(repo, 'tests'), { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv });
writeFileSync(join(repo, 'src.txt'), `${OLD_LINE}\n`);
writeFileSync(join(repo, 'run-tests.sh'), '#!/bin/sh\nfor f in "$@"; do sh "$f" || exit 1; done\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
const base = git('rev-parse', 'HEAD');
writeFileSync(join(repo, 'src.txt'), `${NEW_LINE}\n`);
writeFileSync(join(repo, 'tests', 'hidden.sh'), `${TEST_LINE}\n`);
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

// The task set: hidden copies beside it, packets in packets/.
const setDir = join(dir, 'set');
mkdirSync(join(setDir, 'hidden', 'tests'), { recursive: true });
writeFileSync(join(setDir, 'hidden', 'tests', 'hidden.sh'), `${TEST_LINE}\n`);
mkdirSync(join(setDir, 'packets'));
const task = (id) => ({ id, repo: 'acme/widgets', base, merge, prompt: `${id}: make the counter start at one hundred`, hidden_tests: { dir: 'hidden', files: ['tests/hidden.sh'] } });
const setFile = join(setDir, 'tasks.json');
writeFileSync(setFile, JSON.stringify({ tasks: ['good', 'nopacket', 'empty', 'quotes-test', 'quotes-diff', 'quotes-old', 'trivial', 'nomerge'].map(task)
  .map((x) => (x.id === 'nomerge' ? { ...x, merge: undefined } : x)) }));
const packet = (id, text) => writeFileSync(join(setDir, 'packets', `${id}.md`), text);
const GOOD = 'Entry point: src.txt. Check with `sh run-tests.sh tests/hidden.sh`. FIX';
packet('good', GOOD);
packet('empty', '  \n');
packet('quotes-test', `The test will run:\n\n    ${TEST_LINE.replace(' ', '   ')}\n`);
packet('quotes-diff', `Make it read "${NEW_LINE}".`);
packet('quotes-old', `Today it reads: ${OLD_LINE}`);
packet('trivial', 'Lines like\nfi\n}\nexit 0\nare too short to count. FIX');
packet('nomerge', 'anything');

// A stub claude: answers the usage probe, logs its arguments and what it could read, writes an init
// event naming the model and effort it was given (STUB_NO_EFFORT: no effort), and fixes src.txt
// when the prompt says FIX.
const bin = join(dir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; };
const prompt = val('-p');
const usageFile = process.env.STUB_USAGE;
const u = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
const say = (o) => console.log(JSON.stringify(o));
if (prompt === 'Reply with: ok') {
  say({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.01, resetsAt: u.reset }, seven_day: { utilization: u.used, resetsAt: u.reset } } } });
  say({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  return;
}
u.used += 0.001; fs.writeFileSync(usageFile, JSON.stringify(u));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args: a, settings: JSON.parse(fs.readFileSync(val('--settings'), 'utf8')) }) + '\\n');
say({ type: 'system', subtype: 'init', model: 'claude-' + val('--model') + '-stub', ...(process.env.STUB_NO_EFFORT ? {} : { effort: val('--effort') }) });
if (prompt.includes('FIX')) fs.writeFileSync('src.txt', ${JSON.stringify(`${NEW_LINE}\n`)});
say({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01,
  modelUsage: { m: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 } } });
`);
chmodSync(join(bin, 'claude'), 0o755);

const log = join(dir, 'calls.jsonl');
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const usageFile = join(dir, 'usage.json');
writeFileSync(usageFile, JSON.stringify({ used: 0.1, reset: Math.floor(Date.now() / 1000) + 3 * 24 * 3600 }));
mkdirSync(join(dir, 'locks'));
const run = (args, extra = {}) => {
  rmSync(log, { force: true });
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: {
    ...gitEnv, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, DESK_CONFIG_ROOT: configRoot, DESK_LOCK_DIR: join(dir, 'locks'),
    STUB_USAGE: usageFile, DESK_USAGE_DIR: join(dir, 'usage'), ...extra,
  } });
};
const results = (out) => Object.fromEntries(readdirSync(join(out, 'runs')).filter((d) => existsSync(join(out, 'runs', d, 'result.json')))
  .map((d) => { const r = JSON.parse(readFileSync(join(out, 'runs', d, 'result.json'), 'utf8')); return [`${r.task}.${r.arm}`, r]; }));

// The arms are fixed.
t('AC1 two arms, both opus at medium', JSON.stringify(ARMS.map((a) => [a.name, a.model, a.effort])), '[["filed","opus","medium"],["packet","opus","medium"]]');
t('an arm of its own is refused', /sets its own arms/.test(throws(() => parseArgs(['--tasks', 'x', '--arm', 'a', '--max-budget-usd', '1']))), true);
t('the bench flags still apply', /--max-budget-usd/.test(throws(() => parseArgs(['--tasks', 'x']))), true);

// What a line is, and how a quote is found.
t('AC3 short and punctuation-only lines do not count', answerLines('fi\n}\n   \n-------------------------\nexit 0\n').length, 0);
t('AC3 a long line counts, squashed', answerLines(`  ${TEST_LINE.replace(' ', '\t ')}  `).join(), TEST_LINE);
t('AC3 both sides of a hunk are lines, headers are not', diffLines(`diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n context\n`).join(), 'old,new');
t('AC3 a removed line that starts with dashes is still a line', diffLines('diff --git a/q b/q\n--- a/q\n+++ b/q\n@@ -1 +0,0 @@\n--- sql comment\n').join(), '-- sql comment');
t('AC3 a quote split across whitespace is found', leak(`see\n${NEW_LINE.split(' ').join('\n  ')}\n`, [{ from: 'd', text: NEW_LINE }])?.line, NEW_LINE);
t('AC3 no quote, no leak', leak(GOOD, [{ from: 'd', text: NEW_LINE }]), null);

// The prompt and the run key.
const k = { base, prompt: 'P', packet: 'K\n' };
t('AC1 the packet goes after the ticket text', promptFor(k, ARMS[1]), `P\n\n${PACKET_HEADING}\n\nK`);
t('AC1 the filed side is the ticket text alone', promptFor(k, ARMS[0]), 'P');
t('a packet edit is a new run', runKey(k, ARMS[1]) === runKey({ ...k, packet: 'K2' }, ARMS[1]), false);
t('a filed run keeps its key with or without a packet', runKey(k, ARMS[0]), runKey({ base, prompt: 'P' }, ARMS[0]));

// AC4: model and effort come from the session's init event.
const init = (o) => `${JSON.stringify({ type: 'system', subtype: 'init', ...o })}\n`;
t('AC4 both named', JSON.stringify(ranAt(init({ model: 'claude-opus-5-5', effort: 'medium' }))), '{"model":"claude-opus-5-5","effort":"medium","why":null}');
t('AC4 no effort in the log is null, with why', JSON.stringify(ranAt(init({ model: 'claude-opus-5-5' }))), '{"model":"claude-opus-5-5","effort":null,"why":"the session\'s log names no effort"}');
t('AC4 no init event', ranAt('{"type":"result"}\n').why, 'the session\'s log has no init event');

// One real run.
const out = join(dir, 'out');
let r = run(['--tasks', setFile, '--max-budget-usd', '1', '--out', out, '--seed', '7']);
if (r.status !== 0) console.log(r.stderr);
t('runs to completion', r.status, 0);
t('AC1 the two runnable tasks run once per side', calls().length, 4);
const c = calls().filter((x) => x.args[x.args.indexOf('-p') + 1].startsWith('good:'));
t('AC1 one run per side for a task', c.length, 2);
const prompts = c.map((x) => x.args[x.args.indexOf('-p') + 1]);
const filed = prompts.find((p) => !p.includes(PACKET_HEADING)), withPacket = prompts.find((p) => p.includes(PACKET_HEADING));
t('AC1 the filed side gets the ticket text alone', filed, 'good: make the counter start at one hundred');
t('AC1 the packet side gets the ticket text plus its packet', withPacket, `${filed}\n\n${PACKET_HEADING}\n\n${GOOD}`);
const rest = (x) => { const a = [...x.args]; a.splice(a.indexOf('-p'), 2); const i = a.indexOf('--settings'); a.splice(i, 2); return JSON.stringify(a); };
t('AC1 both sides get identical arguments but the prompt', rest(c[0]), rest(c[1]));
t('AC1 both on opus at medium', c.every((x) => x.args[x.args.indexOf('--model') + 1] === 'opus' && x.args[x.args.indexOf('--effort') + 1] === 'medium'), true);
t('AC1 the settings match but for the checkout', JSON.stringify(c[0].settings.permissions.deny.filter((d) => !d.includes('desk-bench-'))), JSON.stringify(c[1].settings.permissions.deny.filter((d) => !d.includes('desk-bench-'))));
t('no arm may read the packets', c.every((x) => x.settings.permissions.deny.includes(`Read(/${join(setDir, 'packets')}/**)`)), true);

const runFile = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
const why = Object.fromEntries((runFile.left_out ?? []).map((l) => [l.task, l.why]));
t('AC2 a task with no packet is listed as having none', /^no packet/.test(why.nopacket ?? ''), true);
t('AC2 an empty packet is no packet', /^no packet/.test(why.empty ?? ''), true);
t('AC2 neither side ran them', runFile.tasks.map((x) => x.task).join(), 'good,trivial');
t('AC2 they are named as the run starts', /left out nopacket: no packet/.test(r.stderr), true);
t('AC3 a packet quoting a hidden test is refused, naming the test', why['quotes-test'], `refused: its packet quotes a line of hidden test tests/hidden.sh: ${JSON.stringify(TEST_LINE)}`);
t('AC3 a packet quoting an added diff line is refused', /^refused: its packet quotes a line of the merged diff/.test(why['quotes-diff'] ?? ''), true);
t('AC3 a removed diff line counts too', /^refused: .*merged diff.*starts at zero/.test(why['quotes-old'] ?? ''), true);
t('AC3 the refused task is named as the run starts', /left out quotes-test: refused/.test(r.stderr), true);
t('AC3 trivial lines are no leak', why.trivial, undefined);
t('AC3 a task with no merge commit cannot be checked, so is refused', /could not be checked: the task records no merge commit/.test(why.nomerge ?? ''), true);

const res = results(out);
t('AC4 the result records the model the log names', res['good.packet'].ran_at.model, 'claude-opus-stub');
t('AC4 and the effort', res['good.filed'].ran_at.effort, 'medium');
t('only the packet said FIX, so only it is accepted', `${res['good.filed'].status} ${res['good.packet'].status}`, 'rejected accepted');

// AC5: the report puts filed beside packet, and lists what was left out.
const report = renderReport({ out, run: loadRun(out), joined: { arms: { filed: { scores: [{ task: 'good', score: 2 }] }, packet: { scores: [{ task: 'good', score: 4 }] } } }, baseline: { ok: false, why: 'none', path: 'x' } });
t('AC5 filed and packet side by side', report.compared && /\| Figure \| Phase 0 baseline \| filed \| packet \|/.test(report.text), true);
t('AC5 accepted tasks', /\| Tasks accepted, of tasks run \| no baseline \| 0 of 2 \| 2 of 2 \|/.test(report.text), true);
t('AC5 blind score', /\| Mean blind score \(1 to 5\) \| no baseline \| 2\.00 \(1 scored\) \| 4\.00 \(1 scored\) \|/.test(report.text), true);
t('AC5 tokens per accepted task', /\| Median output tokens per accepted task \| no baseline \| no task accepted \| 20 \|/.test(report.text), true);
t('AC2 the report lists the tasks left out', /## Left out[\s\S]*- nopacket: no packet/.test(report.text), true);

// AC4: an init event with no effort leaves it null in the result.
const noEffort = join(dir, 'out-noeffort');
r = run(['--tasks', setFile, '--max-budget-usd', '1', '--out', noEffort, '--seed', '7'], { STUB_NO_EFFORT: '1' });
t('AC4 an effort the log does not name is not assumed', JSON.stringify(results(noEffort)['good.filed'].ran_at), '{"model":"claude-opus-stub","effort":null,"why":"the session\'s log names no effort"}');

// No task with a packet: nothing starts.
const lone = join(dir, 'lone');
mkdirSync(join(lone, 'hidden', 'tests'), { recursive: true });
writeFileSync(join(lone, 'hidden', 'tests', 'hidden.sh'), `${TEST_LINE}\n`);
writeFileSync(join(lone, 'tasks.json'), JSON.stringify({ tasks: [task('alone')] }));
r = run(['--tasks', join(lone, 'tasks.json'), '--max-budget-usd', '1']);
t('no runnable task refuses to start', r.status === 2 && /no task has a packet/.test(r.stderr) && calls().length === 0, true);

if (fails) { console.log(`FAIL ${fails} check(s) failed`); process.exit(1); }
console.log('all bench arm 1 checks passed');
