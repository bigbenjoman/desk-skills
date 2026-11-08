// suite: bench arm 3 (implementation on Codex Sol at medium and high, Opus at medium and Sonnet)
// covers: desk/bin/bench-arm3.mjs desk/bin/codex-exec.mjs desk/bin/bench-credits.mjs desk/bin/overage-watch.mjs
// Stub claude and codex binaries on PATH, a scratch repo, config and Codex login. The stub codex logs
// its arguments, whether it had any stdin and its working folder, writes a session log in the shape
// Codex writes one (session_meta, turn_context, a tool call the sandbox refused, a token_count with
// rate_limits), writes its final message, and fixes src.txt when the prompt says FIX.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ARMS, CODEX_MODEL, FABLE_ARM, SANDBOX_CONFIG, codexRanAt, codexTokens, codexVerdict, parseArgs, sandboxRefusals } from '../desk/bin/bench-arm3.mjs';
import { creditState, newestCredits, usingOverage } from '../desk/bin/bench-credits.mjs';
import { renderReport, loadRun } from '../desk/bin/bench-report.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'bench-arm3.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-arm3-test-')));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const home = join(dir, 'home');
mkdirSync(home);
const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
for (const k of Object.keys(gitEnv)) if (/^(DESK_|JIRA_|GIT_DIR$|GIT_WORK_TREE$|AUTOPILOT_|CODEX_HOME$|CLAUDE_CONFIG_DIR$)/.test(k)) delete gitEnv[k];
writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n');

const OLD_LINE = 'the widget counter starts at zero';
const NEW_LINE = 'the widget counter starts at one hundred';
const repo = join(dir, 'repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { env: gitEnv, encoding: 'utf8' }).trim();
mkdirSync(join(repo, 'tests'), { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv });
writeFileSync(join(repo, 'src.txt'), `${OLD_LINE}\n`);
writeFileSync(join(repo, 'run-tests.sh'), '#!/bin/sh\nfor f in "$@"; do sh "$f" || exit 1; done\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
const base = git('rev-parse', 'HEAD');
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

const setDir = join(dir, 'set');
mkdirSync(join(setDir, 'hidden', 'tests'), { recursive: true });
writeFileSync(join(setDir, 'hidden', 'tests', 'hidden.sh'), 'grep -q "one hundred" src.txt\n');
const task = (id, prompt) => ({ id, repo: 'acme/widgets', base, prompt, hidden_tests: { dir: 'hidden', files: ['tests/hidden.sh'] } });
const setFile = join(setDir, 'tasks.json');
writeFileSync(setFile, JSON.stringify({ tasks: [task('fix', 'fix: make the counter start at one hundred. FIX'), task('nofix', 'nofix: leave it')] }));
const hangFile = join(setDir, 'hang.json');
writeFileSync(hangFile, JSON.stringify({ tasks: [task('hang', 'hang: HANG')] }));

const bin = join(dir, 'bin');
mkdirSync(bin);
// The stub claude, as in the arm 1 suite.
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; };
const prompt = val('-p');
const u = JSON.parse(fs.readFileSync(process.env.STUB_USAGE, 'utf8'));
const say = (o) => console.log(JSON.stringify(o));
const credits = process.env.STUB_CREDITS ? JSON.parse(fs.readFileSync(process.env.STUB_CREDITS, 'utf8'))[path.basename(process.env.CLAUDE_CONFIG_DIR || 'default')] : {};
if (prompt === 'Reply with: ok') {
  say({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', ...credits, unifiedWindows: { five_hour: { utilization: 0.01, resetsAt: u.reset }, seven_day: { utilization: u.used, resetsAt: u.reset } } } });
  say({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  return;
}
u.used += 0.001; fs.writeFileSync(process.env.STUB_USAGE, JSON.stringify(u));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: 'claude', args: a, credential: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || null }) + '\\n');
say({ type: 'system', subtype: 'init', model: 'claude-' + val('--model') + '-stub', ...(val('--effort') ? { effort: val('--effort') } : {}) });
if (prompt.includes('OVERAGE') && val('--model').includes('fable')) {
  say({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'allowed', isUsingOverage: true } });
  setInterval(() => {}, 1000);
  return;
}
if (prompt.includes('FIX')) fs.writeFileSync('src.txt', ${JSON.stringify(`${NEW_LINE}\n`)});
say({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01,
  modelUsage: { m: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 } } });
`);
writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; };
const configs = a.filter((x, i) => a[i - 1] === '-c');
let stdin = 'closed';
try { if (fs.readFileSync(0, 'utf8').length) stdin = 'data'; } catch { stdin = 'unreadable'; }
const cd = val('--cd'), prompt = a[a.indexOf('--') + 1];
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: 'codex', args: a, configs, stdin, cwd: process.cwd() }) + '\\n');
if (prompt.includes('HANG')) { setInterval(() => {}, 1000); return; }
const u = JSON.parse(fs.readFileSync(process.env.STUB_CODEX_USAGE, 'utf8'));
u.used += 2; fs.writeFileSync(process.env.STUB_CODEX_USAGE, JSON.stringify(u));
const effort = /^model_reasoning_effort="(\\w+)"$/.exec(configs.find((c) => c.startsWith('model_reasoning_effort')) || '')[1];
const ev = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
const lines = [ev('session_meta', { id: 's', cwd: cd, cli_version: '0.167.0' }), ev('turn_context', { cwd: cd, model: val('-m'), effort }),
  ev('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'echo x > /etc/outside'] }), call_id: 'c1' }),
  ev('response_item', { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'bash: /etc/outside: Operation not permitted', metadata: { exit_code: 1 } }) }),
  ev('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Permission denied is what I would say, but this is prose' }] }),
  ev('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 } },
    rate_limits: { primary: { used_percent: 1, window_minutes: 300, resets_at: u.reset }, secondary: { used_percent: u.used, window_minutes: 10080, resets_at: u.reset }, plan_type: 'pro' } })];
const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '08');
fs.mkdirSync(day, { recursive: true });
fs.writeFileSync(path.join(day, 'rollout-2026-11-08T00-00-00-' + Math.random().toString(36).slice(2) + '.jsonl'), lines.join('\\n') + '\\n');
if (prompt.includes('FIX')) fs.writeFileSync(path.join(cd, 'src.txt'), ${JSON.stringify(`${NEW_LINE}\n`)});
fs.writeFileSync(val('--output-last-message'), 'DONE: ' + val('-m') + ' at ' + effort + '\\n');
`);
for (const b of ['claude', 'codex']) chmodSync(join(bin, b), 0o755);

const codexHome = join(dir, 'codex-home');
const reset = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
// The Codex login's reading before any run: a session elsewhere, minutes ago.
mkdirSync(join(codexHome, 'sessions', '2026', '11', '07'), { recursive: true });
writeFileSync(join(codexHome, 'sessions', '2026', '11', '07', 'rollout-seed.jsonl'), [
  JSON.stringify({ timestamp: new Date(Date.now() - 60000).toISOString(), type: 'session_meta', payload: { id: 'seed', cwd: '/elsewhere' } }),
  JSON.stringify({ timestamp: new Date(Date.now() - 60000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null,
    rate_limits: { primary: { used_percent: 1, window_minutes: 300, resets_at: reset }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: reset }, plan_type: 'pro' } } }),
].join('\n') + '\n');

const log = join(dir, 'calls.jsonl');
const calls = (tool) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.tool === tool) : []);
const usageFile = join(dir, 'usage.json');
const codexUsage = join(dir, 'codex-usage.json');
writeFileSync(usageFile, JSON.stringify({ used: 0.1, reset }));
writeFileSync(codexUsage, JSON.stringify({ used: 10, reset }));
mkdirSync(join(dir, 'locks'));
const run = (args, env = {}) => {
  rmSync(log, { force: true });
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', input: 'typed at a prompt\n', env: {
    ...gitEnv, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, DESK_CONFIG_ROOT: configRoot, DESK_LOCK_DIR: join(dir, 'locks'),
    STUB_USAGE: usageFile, STUB_CODEX_USAGE: codexUsage, CODEX_HOME: codexHome, DESK_USAGE_DIR: join(dir, 'usage'), DESK_SUBSCRIPTIONS: join(dir, 'subscriptions.md'), ...env,
  } });
};
const results = (out) => Object.fromEntries(readdirSync(join(out, 'runs')).filter((d) => existsSync(join(out, 'runs', d, 'result.json')))
  .map((d) => { const r = JSON.parse(readFileSync(join(out, 'runs', d, 'result.json'), 'utf8')); return [`${r.task}.${r.arm}`, { ...r, dir: join(out, 'runs', d) }]; }));

// AC1: the four sides.
t('AC1 four sides: Codex Sol medium and high, Opus medium, Sonnet at the default', JSON.stringify(ARMS.map((a) => [a.name, a.model, a.effort])),
  JSON.stringify([['codex-medium', CODEX_MODEL, 'medium'], ['codex-high', CODEX_MODEL, 'high'], ['opus-medium', 'opus', 'medium'], ['sonnet', 'sonnet', null]]));
t('an arm of its own is refused', /sets its own arms/.test(throws(() => parseArgs(['--tasks', 'x', '--arm', 'a', '--max-budget-usd', '1']))), true);
t('the bench flags still apply', /--max-budget-usd/.test(throws(() => parseArgs(['--tasks', 'x']))), true);

// The session log readers.
const ev = (type, payload) => JSON.stringify({ timestamp: '2026-11-08T00:00:00Z', type, payload });
const tc = (n) => ev('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: n, cached_input_tokens: n / 2, output_tokens: 5, reasoning_output_tokens: 2 } } });
t('AC3 tokens come from the last token_count running total', JSON.stringify(codexTokens([tc(100), tc(400), ev('event_msg', { type: 'token_count', info: null })].join('\n'))),
  '{"uncached":200,"cacheWrite":0,"cacheRead":200,"output":5,"reasoning":2}');
t('AC3 no token_count is no tokens', codexTokens(ev('session_meta', {})), null);
t('the model and effort come from turn_context', JSON.stringify(codexRanAt(ev('turn_context', { model: 'm', effort: 'high' }))), '{"model":"m","effort":"high","why":null}');
t('no turn_context says so', codexRanAt('').why, 'the session\'s log has no turn_context event');
t('AC4 a refused patch is found', JSON.stringify(sandboxRefusals([ev('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: '*** Add File: /x', call_id: 'p' }),
  ev('response_item', { type: 'custom_tool_call_output', call_id: 'p', output: 'writing outside of the project; rejected by user approval settings' })].join('\n'))),
'[{"call":"*** Add File: /x","output":"writing outside of the project; rejected by user approval settings"}]');
t('AC4 a model\'s own words are no refusal', sandboxRefusals(ev('response_item', { type: 'message', content: [{ text: 'Operation not permitted' }] })).length, 0);
t('a timeout is a failure', codexVerdict({ code: 124, timedOut: true, message: '' }, 9).why, 'timed out after 9s');
t('no final message is a failure', codexVerdict({ code: 0, timedOut: false, message: ' \n' }, 9).why, 'codex wrote no final message');

// One real run.
const out = join(dir, 'out');
let r = run(['--tasks', setFile, '--max-budget-usd', '1', '--out', out, '--seed', '3']);
if (r.status !== 0) console.log(r.stderr);
t('runs to completion', r.status, 0);
const cx = calls('codex'), cl = calls('claude');
t('AC1 each task runs once per side', `${cx.length} codex, ${cl.length} claude`, '4 codex, 4 claude');
const flag = (c, f) => c.args[c.args.indexOf(f) + 1];
t('AC1 the Codex sides on Codex Sol at medium and at high', cx.map((c) => `${flag(c, '-m')}:${c.configs[0]}`).sort().join(' '),
  `${CODEX_MODEL}:model_reasoning_effort="high" ${CODEX_MODEL}:model_reasoning_effort="high" ${CODEX_MODEL}:model_reasoning_effort="medium" ${CODEX_MODEL}:model_reasoning_effort="medium"`);
t('AC1 the Claude sides: Opus at medium, Sonnet with no effort named', cl.map((c) => `${flag(c, '--model')}:${c.args.includes('--effort') ? flag(c, '--effort') : 'default'}`).sort().join(' '),
  'opus:medium opus:medium sonnet:default sonnet:default');
const res = results(out);
const wts = Object.values(res).map((x) => x.dir);
t('AC1 every side has its own run', new Set(wts).size, 8);
t('AC1 each Codex side in its own checkout', new Set(cx.map((c) => flag(c, '--cd'))).size, 4);
t('AC2 Codex runs in the workspace-write sandbox', cx.every((c) => flag(c, '--sandbox') === 'workspace-write'), true);
t('AC2 with no network and neither temporary folder writable', cx.every((c) => SANDBOX_CONFIG.every((s) => c.configs.includes(s))), true);
t('AC2 the checkout is the workspace and the folder it runs in', cx.every((c) => c.cwd === flag(c, '--cd') && /desk-bench-.*\/checkout$/.test(c.cwd)), true);
t('AC2 its stdin is closed', cx.map((c) => c.stdin).join(), 'closed,closed,closed,closed');
const fixHigh = res['fix.codex-high'];
t('AC2 the final message is captured to a file', readFileSync(join(fixHigh.dir, 'last-message.txt'), 'utf8'), `DONE: ${CODEX_MODEL} at high\n`);
t('AC2 written where codex was told', cx.filter((c) => flag(c, '--output-last-message').startsWith(join(out, 'runs'))).length, 4);
t('the ticket text is the prompt', cx.some((c) => c.args[c.args.length - 1] === 'fix: make the counter start at one hundred. FIX'), true);
t('a Codex fix is scored on the hidden tests', `${res['fix.codex-medium'].status} ${res['nofix.codex-medium'].status}`, 'accepted rejected');
t('AC3 its tokens come from its own session log', JSON.stringify(fixHigh.tokens), '{"uncached":400,"cacheWrite":0,"cacheRead":600,"output":50,"reasoning":20}');
t('AC3 and the log is kept beside the result', existsSync(join(fixHigh.dir, 'codex-session.jsonl')), true);
t('AC3 the model and effort the log names', `${fixHigh.ran_at.model} ${fixHigh.ran_at.effort}`, `${CODEX_MODEL} high`);
t('AC3 its quota points are the Codex weekly rise during the run', `${fixHigh.quota.account} ${fixHigh.quota.points}`, 'Codex login codex-home 2');
t('AC3 a Claude side reads the Claude allowance', /^Claude login/.test(res['fix.opus-medium'].quota.account), true);
t('AC4 the sandbox refusal is in the result', JSON.stringify(fixHigh.refusals.map((x) => x.output)), JSON.stringify(['bash: /etc/outside: Operation not permitted']));
t('AC4 naming the call it refused', /echo x > \/etc\/outside/.test(fixHigh.refusals[0].call), true);
t('AC4 and the run carries on to its own result', fixHigh.status, 'accepted');
t('a Codex side spends none of the USD budget', JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')).spent.toFixed(2), '0.04');

// AC5: the report, Claude and Codex on separate allowance lines.
const report = renderReport({ out, run: loadRun(out), joined: { arms: Object.fromEntries(ARMS.map((a) => [a.name, { scores: [{ task: 'fix', score: 3 }] }])) }, baseline: { ok: false, why: 'none', path: 'x' } }).text;
const row = (label) => report.split('\n').find((l) => l.startsWith(`| ${label} |`))?.split(' | ').slice(2).map((c) => c.replace(/ \|$/, '')).join(' / ');
t('AC5 all four sides side by side', report.includes('| Figure | Phase 0 baseline | codex-high | codex-medium | opus-medium | sonnet |'), true);
t('AC5 accepted tasks', row('Tasks accepted, of tasks run'), '1 of 2 / 1 of 2 / 1 of 2 / 1 of 2');
t('AC5 blind score', row('Mean blind score (1 to 5)'), '3.00 (1 scored) / 3.00 (1 scored) / 3.00 (1 scored) / 3.00 (1 scored)');
t('AC5 tokens per accepted task', row('Median output tokens per accepted task'), '50 / 50 / 20 / 20');
t('AC5 the Codex allowance on its own line', row('Codex quota points per accepted task (median), per account'), 'Codex login codex-home: 2 / Codex login codex-home: 2 / — / —');
t('AC5 the Claude allowance on its own line', /^— \/ — \/ Claude login \S+: 0\.1 \/ Claude login \S+: 0\.1$/.test(row('Claude quota points per accepted task (median), per account') ?? ''), true);

// AC2: a Codex side still running at the timeout is ended, and the run fails on it.
const hung = join(dir, 'out-hang');
const start = Date.now();
r = run(['--tasks', hangFile, '--max-budget-usd', '1', '--out', hung, '--seed', '1', '--timeout', '2']);
const hres = results(hung);
const hc = Object.values(hres).find((x) => x.arm.startsWith('codex'));
t('AC2 a hung Codex side is ended at the bench timeout', `${hc?.status} ${hc?.why}`, 'failed timed out after 2s');
t('AC2 well before the hidden-test ceiling', (Date.now() - start) < 60000, true);

// The Fable side and the usage-credit gate.
const event = (info) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });
const ORG_OFF = { overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false };
const EMPTY = { overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: false };
const ON = { overageStatus: 'allowed', isUsingOverage: false };
const state = (info) => creditState(newestCredits(event(info))).state;
t('AC1 rejected for an organisation reason is off', state(ORG_OFF), 'off');
t('AC2 an empty balance is not off', state(EMPTY), 'on');
t('AC2 the recorded out_of_credits event is not off', creditState(newestCredits(readFileSync(join(dirname(SCRIPT), '..', '..', 'tests', 'fixtures', 'usage-limit-allowed.json'), 'utf8'))).state, 'on');
t('AC2 allowed is not off', state(ON), 'on');
t('AC2 using overage is not off, whatever else it says', state({ ...ORG_OFF, isUsingOverage: true }), 'on');
t('AC3 no overage fields is unknown', state({ status: 'allowed' }), 'unknown');
t('AC3 rejected with no reason is unknown', state({ overageStatus: 'rejected' }), 'unknown');
t('AC3 no event is unknown', creditState(newestCredits('{"type":"result"}')).state, 'unknown');
t('the newest event decides', creditState(newestCredits([event(ON), event(ORG_OFF)].join('\n'))).state, 'off');
t('a tool result quoting an event is not one', usingOverage(`{"type":"user","text":${JSON.stringify(event({ isUsingOverage: true }))}}`), false);
t('AC4 a request using overage is seen', usingOverage(event({ ...ON, isUsingOverage: true })), true);
t('AC4 an event not using it is not', usingOverage(event(ORG_OFF)), false);
t('Fable is asked for by its flag alone', `${parseArgs(['--tasks', 'x', '--max-budget-usd', '1']).arms.length} ${parseArgs(['--tasks', 'x', '--max-budget-usd', '1', '--fable']).arms.at(-1).name}`, '4 fable');
t('the Fable side has its own runner on a Claude model', `${typeof FABLE_ARM.runner} ${FABLE_ARM.model}`, 'function claude-fable-5-1');

const creditsFile = join(dir, 'credits.json');
const setCredits = (c) => writeFileSync(creditsFile, JSON.stringify(c));
const work = join(home, '.claude-logins', 'work');
mkdirSync(work, { recursive: true });
const subs = join(dir, 'subs-two.md');
writeFileSync(subs, `## Claude\n\n| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| claude | work | ~/.claude-logins/work | in rotation |\n`);
writeFileSync(join(setDir, 'over.json'), JSON.stringify({ tasks: [task('over', 'over: OVERAGE'), task('after', 'after: leave it')] }));
const fableEnv = (name) => ({ STUB_CREDITS: creditsFile, DESK_SUBSCRIPTIONS: subs, DESK_USAGE_DIR: join(dir, `usage-${name}`) });

setCredits({ default: ORG_OFF, work: { ...ON } });
r = run(['--tasks', setFile, '--max-budget-usd', '1', '--out', join(dir, 'out-on'), '--seed', '1', '--fable'], fableEnv('on'));
t('AC2 credits on any account refuses before any run', `${r.status} ${calls('claude').length} ${calls('codex').length}`, '2 0 0');
t('AC2 naming the account and the reading', /Claude login work does not read usage credits off \(overageStatus allowed\)/.test(r.stderr), true);
setCredits({ default: EMPTY, work: ORG_OFF });
r = run(['--tasks', setFile, '--max-budget-usd', '1', '--out', join(dir, 'out-empty'), '--seed', '1', '--fable'], fableEnv('empty'));
t('AC2 an empty balance refuses too', `${r.status} ${/Claude login default does not read.*out_of_credits/.test(r.stderr)}`, '2 true');
setCredits({ default: ORG_OFF, work: { status: 'allowed' } });
r = run(['--tasks', setFile, '--max-budget-usd', '1', '--out', join(dir, 'out-unknown'), '--seed', '1', '--fable'], fableEnv('unknown'));
t('AC3 an account with no reading is refused as unknown', `${r.status} ${/Claude login work has an unknown usage credit state/.test(r.stderr)}`, '2 true');

setCredits({ default: ORG_OFF, work: ORG_OFF });
const onSides = join(dir, 'out-fable');
r = run(['--tasks', setFile, '--max-budget-usd', '1', '--total-budget-usd', '20', '--out', onSides, '--seed', '4', '--fable'], { ...fableEnv('fable'), ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_OAUTH_TOKEN: 'token-test' });
if (r.status !== 0) console.log(r.stderr);
const fableRes = results(onSides);
const fableCalls = calls('claude').filter((c) => flag(c, '--model') === FABLE_ARM.model);
t('AC1 with credits off everywhere it runs', r.status, 0);
t('AC1 each task on the Fable model', fableCalls.length, 2);
t('a Fable run drops credentials that would bill instead of the login it checked, which the other sides keep', `${fableCalls.filter((c) => c.credential).length} ${calls('claude').filter((c) => flag(c, '--model') !== FABLE_ARM.model && c.credential).length}`, '0 4');
t('AC1 and is scored like any side', `${fableRes['fix.fable'].status} ${fableRes['nofix.fable'].status}`, 'accepted rejected');
const fableReport = renderReport({ out: onSides, run: loadRun(onSides), joined: { arms: Object.fromEntries([...ARMS, FABLE_ARM].map((a) => [a.name, { scores: [{ task: 'fix', score: 3 }] }])) }, baseline: { ok: false, why: 'none', path: 'x' } }).text;
const fableRow = fableReport.split('\n').find((l) => l.startsWith('| Tasks accepted, of tasks run |'));
t('AC5 Fable beside the other sides', fableReport.includes('| Figure | Phase 0 baseline | codex-high | codex-medium | fable | opus-medium | sonnet |'), true);
t('AC5 with the same columns', fableRow.split(' | ').length, 7);

const overOut = join(dir, 'out-over');
const overStart = Date.now();
r = run(['--tasks', join(setDir, 'over.json'), '--max-budget-usd', '1', '--total-budget-usd', '20', '--out', overOut, '--seed', '4', '--timeout', '60', '--fable'], fableEnv('over'));
const overElapsed = Date.now() - overStart;
const overRes = results(overOut);
t('AC4 the stub that never exits is ended by the watch, not the 60s timeout', overElapsed < 50000, true);
const runJson = JSON.parse(readFileSync(join(overOut, 'run.json'), 'utf8'));
const overStops = runJson.arm_stops?.[0]?.why ?? '';
t('AC4 the run using overage is ended, well before its timeout', `${overRes['over.fable']?.status} ${/recorded a request using overage/.test(overRes['over.fable']?.why ?? '')}`, 'failed true');
t('AC4 no further Fable run starts', runJson.tasks.find((x) => x.task === 'after').runs.find((x) => x.arm === 'fable').status, 'not run');
t('AC4 the other sides carry on', runJson.tasks.find((x) => x.task === 'after').runs.find((x) => x.arm === 'sonnet').status, 'rejected');
t('AC4 the task and the account are reported', /task over on Claude login \S+/.test(overStops) && r.stdout.includes('stopped fable: task over'), true);
t('AC4 and in the report', renderReport({ out: overOut, run: loadRun(overOut), joined: null, baseline: { ok: false, why: 'none', path: 'x' } }).text.includes('## Arms stopped'), true);

if (fails) { console.log(`FAIL ${fails} check(s) failed`); process.exit(1); }
console.log('all bench arm 3 checks passed');
