// suite: bench replay (arm 4: recorded preflight and decider calls on Haiku and with no model)
// covers: desk/bin/bench-replay.mjs desk/bin/preflight-record.mjs desk/bin/bench-quota.mjs
// Fixture batch state folders hold recorded calls with known Opus answers. A stub claude on PATH
// answers the usage probe from a usage file and each replay with one matching and one mismatching
// answer, recording its argv, its folder and the settings it was given. Scratch folders only.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkNames, verdicts, deciderItems, preflightScript, deciderScript, collect, loggedPreflights, compare, movePreflight, sampleOf, NEEDS, REPLAY_NOTE } from '../desk/bin/bench-replay.mjs';
import { recordPreflight, inputsOf, parseArgs as recordArgs } from '../desk/bin/preflight-record.mjs';
import { deciderPrompt, RESULT_MARK } from '../desk/bin/decider.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'bench-replay.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-replay-test-')));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const OPUS = { 'claude-opus-4-5': { inputTokens: 10, outputTokens: 40, cacheCreationInputTokens: 100, cacheReadInputTokens: 900 } };
const reply = (text, modelUsage = OPUS) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.05, modelUsage });

// ---- a recorded preflight, written the way spawn-worker.sh writes it ---------------------------------
const WT = '/fake/worktrees/T-1';
const CANARY = '/fake/root/.preflight-should-not-exist.tmp';
const CHECKS = ['W_IN', 'W_OUT', 'TOOL1', 'AGENTS', 'DENY', 'JIRA', 'CODEX'];
const prompt = `Perform these ${CHECKS.length} checks and reply with EXACTLY ${CHECKS.length} lines, nothing else. Do not stop early if one is refused.
W_IN=OK or W_IN=BLOCKED  — write the file ${WT}/.preflight.tmp containing x
W_OUT=OK or W_OUT=BLOCKED — write the file ${CANARY} containing x
TOOL1=OK or TOOL1=BLOCKED — run: node --version
AGENTS=OK or AGENTS=BLOCKED — AGENTS=OK only if every one of these is a subagent type your Agent tool offers (do not launch any): lena-code-reviewer
DENY=OK or DENY=BLOCKED — run: git stash list
JIRA=OK or JIRA=BLOCKED — run: desk-jira whoami
CODEX=OK or CODEX=BLOCKED — run: codex --version`;
const OPUS_SAYS = 'W_IN=OK\nW_OUT=BLOCKED\nTOOL1=OK\nAGENTS=OK\nDENY=BLOCKED\nJIRA=OK\nCODEX=BLOCKED';
const files = (name, settings = true) => {
  const f = join(dir, name);
  writeFileSync(`${f}.settings.json`, JSON.stringify({ permissions: { allow: [`Edit(/${WT}/**)`], deny: ['Bash(git stash:*)'] } }));
  writeFileSync(`${f}.agents.json`, JSON.stringify({ 'lena-code-reviewer': { description: 'x', prompt: 'y' } }));
  if (!settings) rmSync(`${f}.settings.json`);
  return f;
};
const inputs = (extra = {}) => ({ worktree: WT, canary: CANARY, model: null, effort: 'low', tools: 'Agent,Bash,Read', add_dirs: [], probes: ['node --version'],
  agent_names: ['lena-code-reviewer'], gates: { tracker: 'jira', 'codex-review': 'no', jira: '1', codex: '' }, files: { w_in: true, w_out: false, escape: false }, ...extra });

const state = join(dir, 'state');
const at = (min) => new Date(Date.now() - min * 60_000);
const pre = (base, raw, { settings = true, min = 10 } = {}) => {
  const f = files(base, settings);
  return recordPreflight({ state, ticket: base, prompt, raw, inputs: inputs(), settingsFile: `${f}.settings.json`, agentsFile: `${f}.agents.json`, now: at(min) });
};
pre('T-1', reply(OPUS_SAYS));
pre('T-2', reply(OPUS_SAYS), { settings: false });
pre('T-3', reply(OPUS_SAYS, { 'claude-sonnet-4-5': OPUS['claude-opus-4-5'] }));
pre('T-4', reply('W_IN=OK\nW_OUT=BLOCKED'));
// The workers' logs show six preflights in the window and one before it: two of them left no record.
mkdirSync(join(state, 'logs'), { recursive: true });
const plog = (when) => `${JSON.stringify({ type: 'desk_preflight', total_cost_usd: 0.1, num_turns: 3, at: when.toISOString() })}\n`;
writeFileSync(join(state, 'logs', 'T-1.log'), [1, 2, 3, 4].map((m) => plog(at(m))).join('') + plog(at(60 * 24 * 30)));
writeFileSync(join(state, 'logs', 'T-9.log.round1'), plog(at(5)) + plog(at(6)) + 'not json\n');

// ---- a recorded decider session, written the way startDecider writes it ----------------------------
const ITEMS = [
  { id: 'park-aaa', ticket: 'T-5', kind: 'parked', lane: 'A', text: 'Which of the two retry rules applies here?', answers: [{ at: '2026-11-07T10:00:00.000Z', text: 'the second one,\nand log it' }] },
  { id: 'wait-bbb', ticket: 'T-6', kind: 'waiting', lane: 'A', text: 'T-6: READY TO MERGE — PR #12 is green' },
  { id: 'park-ccc', ticket: 'T-7', kind: 'parked', lane: 'C', text: 'lane C: the plan needs agreeing' },
];
const ddir = join(state, 'decider');
mkdirSync(ddir, { recursive: true });
const D1 = '2026-11-08T09-00-00-000Z';
const dprompt = deciderPrompt({ slug: 'o/r', report: 'PASS REPORT', items: ITEMS, rules: 'RULES', bin: '/bin' });
writeFileSync(join(ddir, `${D1}.prompt.md`), dprompt);
writeFileSync(join(ddir, `${D1}.json`), reply(`Done.\n${RESULT_MARK} ${JSON.stringify({ settled: [{ id: 'park-aaa', did: 'requeued T-5' }], handed: [{ id: 'wait-bbb', why: 'merging needs the person' }] })}`));
writeFileSync(join(ddir, '2026-11-08T09-30-00-000Z.prompt.md'), dprompt);

// ---- the pieces ---------------------------------------------------------------------------------------
t('the check names come from the prompt in order', checkNames(prompt), CHECKS);
t('a reply\'s first verdict per check stands', verdicts('W_IN=OK\nW_IN=BLOCKED\nnoise\nDENY=BLOCKED'), { W_IN: 'OK', DENY: 'BLOCKED' });
const items = deciderItems(dprompt);
t('the decider items come back from the prompt', items.map((i) => [i.id, i.ticket, i.kind, i.lane]), ITEMS.map((i) => [i.id, i.ticket, i.kind, i.lane]));
t('an item keeps its answer, continuation lines included', items[0].answers, ['the second one,\nand log it']);
t('an item\'s text is its own line', items[1].text, ITEMS[1].text);

const found = collect({ states: [state], since: Date.now() - 7 * 24 * 3600_000 });
t('AC1 the readable Opus calls are kept', [found.calls.preflight.map((c) => c.id.split('-').slice(0, 2).join('-')), found.calls.decider.map((c) => c.id)], [['T-1'], [D1]]);
t('AC1 each kept preflight carries Opus\'s verdict per check', found.calls.preflight[0].opus, Object.fromEntries(OPUS_SAYS.split('\n').map((l) => l.split('='))));
t('AC6 a record missing a file and a logged preflight with no record are unreadable', found.left.preflight, { unreadable: 3, 'not Opus': 1, unanswered: 1 });
t('AC6 a decider prompt with no reply is unreadable', found.left.decider, { unreadable: 1 });
t('the log count reads only the window, and every round', loggedPreflights(state, Date.now() - 7 * 24 * 3600_000), 6);
t('AC4 the decider\'s recorded answers: settled, handed, and left out is handed', found.calls.decider[0].opus, { 'park-aaa': 'settled', 'wait-bbb': 'handed', 'park-ccc': 'handed' });

const pcall = found.calls.preflight[0];
const ps = preflightScript(pcall);
t('AC3 the script answers AGENTS from the agents file and CODEX from the missing binary', [ps.AGENTS, ps.CODEX], ['OK', 'BLOCKED']);
t('AC3 a check run under the sandbox needs a model', [ps.W_IN, ps.DENY, ps.JIRA], [NEEDS, NEEDS, NEEDS]);
t('AC3 an agent the file lacks is BLOCKED', preflightScript({ ...pcall, inputs: { ...pcall.inputs, agent_names: ['nobody'] } }).AGENTS, 'BLOCKED');
const sc = compare(pcall.opus, ps);
t('AC3 matches are recorded, and a needs-a-model answer is neither', [sc.filter((x) => x.match).length, sc.filter((x) => x.needs).length], [2, 5]);
const ds = deciderScript(found.calls.decider[0]);
t('AC7 the script hands on the waiting line and the lane C park, and the rest needs a model', ds, { 'park-aaa': NEEDS, 'wait-bbb': 'handed', 'park-ccc': 'handed' });
t('AC7 a park naming a §3 row that is not yes is handed', deciderScript({ items: [{ id: 'x', kind: 'parked', lane: 'A', text: 'needs config §3 `pr-merge-green` is "no"' }] }), { x: 'handed' });
const moved = movePreflight(pcall, '/scratch');
t('the replay moves the worktree and canary into its own checkout', [moved.prompt.includes(WT), moved.prompt.includes('/scratch/checkout/.preflight.tmp'), moved.prompt.includes('/scratch/outside/.preflight-should-not-exist.tmp'), moved.settings.includes('Edit(//scratch/checkout/**)')], [false, true, true, true]);
const many = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}` }));
t('a sample is seeded: the same seed gives the same calls', sampleOf(many, 4, 's1', 'preflight').map((c) => c.id), sampleOf([...many].reverse(), 4, 's1', 'preflight').map((c) => c.id));

const rec = recordArgs(['--state', state, '--ticket', 'K', '--prompt', 'p', '--worktree', join(dir, 'wt'), '--canary', join(dir, 'c.tmp'), '--settings', 's', '--agents', 'a',
  '--model', '', '--tools', '', '--probe', 'node --version', '--probe', 'uv --version', '--gate', 'jira=', '--gate', 'tracker=jira', '--agent-names', 'a b']);
mkdirSync(join(dir, 'wt'));
writeFileSync(join(dir, 'wt', '.preflight.tmp'), 'x');
writeFileSync(join(dir, 'c.tmp.bash'), '');
const ri = inputsOf(rec);
t('the recorder reads which files the checks left', ri.files, { w_in: true, w_out: false, escape: true });
t('the recorder keeps every probe and gate, and no tools flag as the default list', [ri.probes, ri.gates, ri.tools, ri.model, ri.agent_names], [['node --version', 'uv --version'], { jira: '', tracker: 'jira' }, null, null, ['a', 'b']]);

// ---- the arm, end to end, on a stub claude -------------------------------------------------------------
const bin = join(dir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; };
const prompt = val('-p');
const usageFile = process.env.STUB_USAGE;
const u = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
if (prompt === 'Reply with: ok') {
  console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.01, resetsAt: u.reset }, seven_day: { utilization: u.used, resetsAt: u.reset } } } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));
  return;
}
u.used += 0.001;
fs.writeFileSync(usageFile, JSON.stringify(u));
const settings = val('--settings');
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args: a, cwd: process.cwd(), settings: settings ? fs.readFileSync(settings, 'utf8') : null }) + '\\n');
const text = prompt.startsWith('Perform these')
  ? 'W_IN=OK\\nW_OUT=BLOCKED\\nTOOL1=OK\\nAGENTS=OK\\nDENY=OK\\nJIRA=OK\\nCODEX=BLOCKED'
  : 'ok\\n${RESULT_MARK} ' + JSON.stringify({ settled: [{ id: 'park-aaa', did: 'requeued' }, { id: 'wait-bbb', did: 'merged it' }], handed: [] });
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01,
  modelUsage: { 'claude-haiku-4-5': { inputTokens: 5, outputTokens: 7, cacheCreationInputTokens: 0, cacheReadInputTokens: 20 } } }));
`);
chmodSync(join(bin, 'claude'), 0o755);
const usageFile = join(dir, 'usage.json');
const RESET = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
const setUsage = (used) => writeFileSync(usageFile, JSON.stringify({ used, reset: RESET }));
const log = join(dir, 'calls.jsonl');
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DESK_|AUTOPILOT_|CLAUDE_CONFIG_DIR$)/.test(k)));
const run = (args, name) => {
  rmSync(log, { force: true });
  return spawnSync(process.execPath, [SCRIPT, '--state', state, '--out', join(dir, name), '--seed', '7', ...args], { cwd: dir, encoding: 'utf8', env: {
    ...env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, STUB_USAGE: usageFile, DESK_CONFIG_ROOT: join(dir, 'config'), DESK_USAGE_DIR: join(dir, `usage-${name}`),
  } });
};

setUsage(0.1);
let r = run([], 'out');
t('the arm runs', r.status, 0);
const report = readFileSync(join(dir, 'out', 'replay-report.md'), 'utf8');
const [pc, dc] = [calls().find((c) => c.args[1].startsWith('Perform these')), calls().find((c) => c.args[1].includes(REPLAY_NOTE))];
t('AC2 the preflight goes to haiku at low effort with the recorded tools', [pc.args[pc.args.indexOf('--model') + 1], pc.args[pc.args.indexOf('--effort') + 1], pc.args[pc.args.indexOf('--tools') + 1]], ['haiku', 'low', 'Agent,Bash,Read']);
t('AC2 it runs in a throwaway checkout the prompt and settings point at', [pc.args[1].includes(WT), pc.args[1].includes(`${pc.cwd}/.preflight.tmp`), pc.settings.includes(`Edit(/${pc.cwd}/**)`)], [false, true, true]);
t('AC2 the throwaway checkout is gone afterwards', existsSync(pc.cwd), false);
t('AC4 the decider is sent the same items and rules, with no tools', [dc.args[1].startsWith(dprompt.trimEnd()), dc.args[dc.args.indexOf('--tools') + 1], dc.args[dc.args.indexOf('--effort') + 1]], [true, '', 'low']);
t('AC2 only the two sampled calls were replayed', calls().length, 2);
t('AC5 the preflight shares: haiku 6 of 7, the script 2 of 2 with 5 needing a model', [report.includes('| check lines matching Opus | — | 6 of 7 (86%) | 2 of 2 (100%); 5 of 7 needs a model |')], [true]);
t('AC5 the decider shares: haiku 2 of 3, the script 2 of 2 with 1 needing a model', [report.includes('| items matching Opus | — | 2 of 3 (67%) | 2 of 2 (100%); 1 of 3 needs a model |')], [true]);
t('AC5 tokens per call for Opus and haiku', [report.includes('| Median input tokens per call, all kinds | 1,010 | 25 | 0 |'), report.includes('| Median output tokens per call | 40 | 7 | 0 |')], [true, true]);
t('AC5 quota points per replay', report.includes('| Quota points per call (median) | not recorded | 0.1 | 0 |'), true);
t('AC5 the preflight mismatch is listed', /^- T-1-\S+ · DENY: Opus BLOCKED, haiku OK$/m.test(report), true);
t('AC4 the decider mismatch is listed with the item and both answers', report.includes(`- ${D1} · T-6 (waiting) \`wait-bbb\`: ${ITEMS[1].text}: Opus handed ("merging needs the person"), haiku settled ("merged it")`), true);
t('AC6 the report counts what was left out', report.includes('Left out: 3 unreadable, 1 unanswered, 1 not Opus.'), true);
const kept = JSON.parse(readFileSync(join(dir, 'out', 'replay.json'), 'utf8'));
t('every answer is kept in replay.json', [kept.results.preflight[0].model.compared.length, kept.results.decider[0].script.length], [7, 3]);

r = run([], 'out');
t('a second run on the same seed reuses each replay', [r.status, calls().length, /reuse preflight/.test(r.stderr)], [0, 0, true]);

setUsage(0.9);
r = run([], 'low');
const low = readFileSync(join(dir, 'low', 'replay-report.md'), 'utf8');
t('DS-477 under the reserve no replay starts', [r.status, calls().length], [0, 0]);
t('DS-477 the report says why', [/stopped: Claude login \S+ has 10% of its weekly allowance left, under the 25% interactive reserve/.test(low), low.includes('### Not replayed, or the replay failed')], [true, true]);
t('the script side still answers when the model side cannot run', low.includes('| check lines matching Opus | — | 0 of 0') || low.includes('none answered | 2 of 2 (100%)'), true);

r = run(['--no-haiku'], 'script-only');
t('--no-haiku makes no model call', [r.status, calls().length], [0, 0]);

t('--sample must be a whole number', run(['--sample', 'x'], 'bad').status, 2);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
