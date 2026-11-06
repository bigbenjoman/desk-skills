// suite: phase 0 baseline report and levers row (phase0-report.mjs, desk-env levers)
// covers: desk/bin/phase0-report.mjs desk/bin/desk-env.mjs desk/bin/spawn-worker.sh
// The report on fixture worker logs (stream-json), fix tries, digest answers, usage readings, spawn
// records and a stub gh; a main checkout behind origin with uncommitted files that the report leaves
// exactly as it found it; and the §3b Phase 0 levers row read through desk-env, with no row, known
// names and a name desk does not know.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logFacts, commandKey, report, spawnLine, spawnRecords, DAY_MS } from '../desk/bin/phase0-report.mjs';
import { parseLevers, LEVERS } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const has = (name, lines, re) => t(name, lines.some((l) => re.test(l)), true);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_BIN = join(ROOT, 'desk', 'bin', 'desk-env.mjs');
const T = mkdtempSync(join(tmpdir(), 'desk-phase0-'));

// ---- AC5 / AC6: the levers row --------------------------------------------------------------
const config = (rows) => {
  const p = join(T, `cfg-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(p, `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`3100\` |\n${rows}\n`);
  return p;
};
const env = (cfg) => ({ ...process.env, DESK_CONFIG: cfg, DESK_MACHINE: join(T, 'none.md'), HOME: T });
const levers = (cfg, ...a) => execFileSync('node', [ENV_BIN, 'levers', ...a], { encoding: 'utf8', env: env(cfg), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const noRow = config('');
t('AC5: no levers row: every lever is off', LEVERS.map((l) => levers(noRow, l)).every((v) => v === 'off'), true);
t('AC5: no levers row: nothing on', levers(noRow), 'on: none');
t('AC5: the template TODO is off', levers(config('| Phase 0 levers | `none` | `TODO` (names) |'), 'codex'), 'off');
t('AC5: none is off', levers(config('| Phase 0 levers | `none` | `none` |')), 'on: none');
const mixed = config('| Phase 0 levers | `none` | `codex` `turbo` `effort, memory` |');
t('a named lever is on', levers(mixed, 'codex'), 'on');
t('a span may hold several, split on commas', levers(mixed, 'memory'), 'on');
t('a lever left out is off', levers(mixed, 'wrappers'), 'off');
const all = levers(mixed).split('\n');
t('AC6: the levers on are listed', all[0], 'on: codex effort memory');
t('AC6: an unknown value is named and read as off', /^unknown: turbo \(.*read as off/.test(all[1] ?? ''), true);
t('AC6: asking for an unknown lever is off', levers(mixed, 'turbo'), 'off');
t('AC6: parseLevers keeps unknowns apart', JSON.stringify(parseLevers(['Codex', 'nope'])), '{"on":["codex"],"unknown":["nope"]}');
t('AC6: the template names every lever desk knows', LEVERS.every((l) => readFileSync(join(ROOT, 'desk-config.md'), 'utf8').includes(`\`${l}\``)), true);

// ---- denials, parks, 4b rounds and readings in one log -------------------------------------
const say = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const use = (id, name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const deniedEvent = (id, tool) => JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: tool, tool_use_id: id, message: `Permission to use ${tool} has been denied because Claude Code is running in don't ask mode.` });
const deniedResult = (id, tool) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `Permission to use ${tool} has been denied because Claude Code is running in don't ask mode.` }] } });
const reading = (u, resetsAt) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: u, resetsAt } } } });
const result = (cost, input, output) => JSON.stringify({ type: 'result', is_error: false, duration_ms: 1000, total_cost_usd: cost, modelUsage: { m: { inputTokens: input, outputTokens: output } } });
const RESET = Math.floor(Date.now() / 1000) + 3 * 86400;

const one = [
  say('AUTOPILOT_STAGE: 4b/9 self-review'),
  use('a', 'Bash', { command: 'cd /x && git stash list' }), deniedEvent('a', 'Bash'), deniedResult('a', 'Bash'),
  use('b', 'Bash', { command: 'sed -n 1p f' }), deniedResult('b', 'Bash'),
  use('c', 'Write', { file_path: '/y' }), deniedEvent('c', 'Write'),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'd', is_error: true, content: 'exit 1' }] } }),
  say('AUTOPILOT_PARK: which price?'),
  reading(0.4, RESET), '{"type":"rate_limit_event","rate_limit_info":{}}',
].join('\n');
const f = logFacts(one);
t('a denial counts once, by its event or its tool result', JSON.stringify(f.denials), '{"git stash":1,"sed":1,"Write":1}');
t('a failed tool call that is not a denial is not counted', Object.values(f.denials).reduce((a, b) => a + b, 0), 3);
t('a park the worker printed is counted', f.parks, 1);
t('a Stage 4b entry is a review round', f.reviewRounds, 1);
t('a reading with no window is unreadable, not zero', `${f.readings.length} ${f.badReadings}`, '1 1');
t('commandKey: gh with its subcommand', commandKey('Bash', { command: 'gh api repos/x' }), 'gh api');
t('commandKey: an absolute path is its program', commandKey('Bash', { command: '/usr/bin/curl -s x' }), 'curl');

// ---- AC1, AC2, AC4, AC7, AC8, AC9: the report on a fixture batch ---------------------------
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const S = join(T, 'state');
mkdirSync(join(S, 'logs'), { recursive: true });
mkdirSync(join(S, 'workers'), { recursive: true });
const log = (name, ...lines) => writeFileSync(join(S, 'logs', name), `${lines.join('\n')}\n`);
log('A-1.log', say('AUTOPILOT_STAGE: 4b/9 self-review'), use('x', 'Bash', { command: 'git stash list' }), deniedEvent('x', 'Bash'),
  say('AUTOPILOT_PARK: what copy?'), reading(0.30, RESET), reading(0.42, RESET), result(2, 1000, 100));
log('A-2.log', say('AUTOPILOT_DONE: pr=2'), result(1, 3000, 300));
log('A-3.log', say('AUTOPILOT_STAGE: 3/9 implement'));
log('A-4.log', result(9, 9, 9));
utimesSync(join(S, 'logs', 'A-4.log'), (NOW - 10 * DAY_MS) / 1000, (NOW - 10 * DAY_MS) / 1000);
const queue = join(S, 'queue.json');
writeFileSync(queue, JSON.stringify({ tickets: {
  'A-1': { key: 'A-1', state: 'done', added_at: iso(3 * DAY_MS), merged_at: iso(DAY_MS), branch: 'feat/A-1',
    fix_tries: [{ try: 1, kind: 'checks', at: iso(DAY_MS) }, { try: 2, kind: 'review', at: iso(DAY_MS) }, { try: 1, kind: 'checks', at: iso(20 * DAY_MS) }] },
  'A-2': { key: 'A-2', state: 'done', added_at: iso(3 * DAY_MS), merged_at: iso(2 * DAY_MS), branch: 'feat/A-2' },
  'A-3': { key: 'A-3', state: 'running', added_at: iso(DAY_MS), branch: 'feat/A-3' },
  'A-4': { key: 'A-4', state: 'done', added_at: iso(30 * DAY_MS), merged_at: iso(15 * DAY_MS) },
} }));
// AC8: spawn-worker's line, with and without an installed commit.
const rec = (o) => writeFileSync(join(S, 'workers', `${o.ticket}.runs.jsonl`), `${spawnLine(o)}\n`, { flag: 'a' });
rec({ ticket: 'A-1', session: 's1', installed: { commit: 'abcdef1234567890' }, levers: { on: ['codex'], unknown: [] }, systemBytes: 1000, promptBytes: 500 });
rec({ ticket: 'A-2', session: 's2', installed: { commit: 'abcdef1234567890' }, levers: { on: [], unknown: ['turbo'] }, systemBytes: 3000, promptBytes: 1500 });
const line = JSON.parse(spawnLine({ ticket: 'Z-1', session: 's', stage: '4b', installed: null, levers: { on: ['effort'], unknown: [] }, systemBytes: '12', promptBytes: '' }));
t('AC8: the spawn line records the levers on', JSON.stringify(line.levers), '["effort"]');
t('AC8: no installed commit is null, never a guess', line.desk_commit, null);
t('AC8: an empty byte count is null', `${line.system_bytes} ${line.prompt_bytes} ${line.stage}`, '12 null 4b');
t('AC8: records are read back for the window', spawnRecords(S, NOW - DAY_MS).length, 2);

const ghCalls = [];
const gh = (args) => {
  ghCalls.push(args.join(' '));
  if (args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ databaseId: 7, headBranch: 'feat/A-1', workflowName: 'CI' }, { databaseId: 8, headBranch: 'main', workflowName: 'CI' }]) };
  if (args[2] === '7') return { status: 0, stdout: JSON.stringify({ jobs: [{ name: 'test', conclusion: 'failure' }, { name: 'lint', conclusion: 'success' }] }) };
  return { status: 1, stdout: '' };
};
const base = {
  slug: 'o__r', batches: [{ name: null, queue, state: S }], days: 7, now: NOW, gh, repo: 'o/r', root: null,
  installed: { commit: 'abcdef1234567890', at: '2026-11-06T00:00:00Z' }, levers: { on: [], unknown: ['turbo'] },
  answered: { 'o__r/A-1/aaa': iso(DAY_MS), 'o__r/A-1/bbb': iso(30 * DAY_MS), 'x__y/A-1/ccc': iso(DAY_MS) },
  contract: join(ROOT, 'skills', 'desk-autopilot', 'references', 'autopilot-worker-contract.md'), memoryIndex: join(T, 'no-memory.md'),
};
const out = report(base);
const batch = out.slice(out.indexOf('batch (standing):'), out.findIndex((l) => l.startsWith('total')));
const total = out.slice(out.findIndex((l) => l.startsWith('total')));
console.log(out.map((l) => `      | ${l}`).join('\n'));
has('AC1: tickets with work and accepted ones, a ticket outside the window left out', batch, /tickets with work or a merge in the window: 3, accepted \(PR merged\): 2$/);
has('AC1: tokens and cost per accepted ticket, a run with no result named', batch, /per accepted ticket: 2,000 input tokens · 200 output tokens · \$1\.50 API-equivalent \(1 run\(s\) with no result event not counted\)/);
has('AC1: fix tries per accepted ticket, in the window only', batch, /fix tries per accepted ticket: 1\.00 \(2 in all\)/);
has('AC1: repair cycles by kind', batch, /repair cycles by kind: checks 1 · review 1$/);
has('AC1: needs-you raised and answered, this repo and window only', batch, /needs-you items: 1 raised \(worker parks\) · 1 answered/);
has('AC1: permission denials by command', batch, /permission denials by command: 1 in all: git stash 1$/);
has('AC1: Stage 4b review rounds', batch, /Stage 4b review rounds: 1$/);
has('AC1: red CI by failing job, batch branches only', batch, /red CI runs by failing job: test 1$/);
has('AC1: red CI in total counts every failed run, a run whose jobs cannot be read named', total, /red CI runs by failing job: CI \(jobs not read\) 1 · test 1$/);
has('AC1: quota used, from the readings in the logs', batch, /7-day window resetting .*: 30% to 42%, 12 point\(s\) used/);
has('AC2: the installed desk commit', out, /^installed desk: abcdef123456, installed 2026-11-06T00:00:00Z$/);
has('AC2: the instructions a worker loads now', out, /^instructions a worker loads now: worker contract core [\d,]+ bytes, memory index none$/);
has('AC2 / AC9: the desk commit each run used, older runs not recorded', batch, /desk commit workers ran on: abcdef123456 \(2 start\(s\)\) · not recorded \(1 run\(s\)\)$/);
has('AC2: instruction bytes per start', batch, /instructions loaded at start: 3,000 bytes on average over 2 start\(s\) \(system prompt 2,000, first message 1,000\)/);
has('AC7: the levers on for the batch', batch, /levers on: codex \(1 start\(s\)\) · none \(1 start\(s\)\) · not recorded \(1 run\(s\)\)$/);
has('AC6: the report names an unknown lever as off', out, /^levers row now: on none; unknown, read as off: turbo$/);
t('the only gh calls are reads', ghCalls.every((c) => /^run (list|view) /.test(c)), true);

// AC4 / AC9: no readings anywhere: unreadable with the reason, never zero.
const S2 = join(T, 'state2');
mkdirSync(join(S2, 'logs'), { recursive: true });
writeFileSync(join(S2, 'logs', 'B-1.log'), `${result(1, 10, 10)}\n`);
writeFileSync(join(S2, 'queue.json'), JSON.stringify({ tickets: { 'B-1': { key: 'B-1', state: 'running', added_at: iso(DAY_MS) } } }));
const bare = report({ ...base, batches: [{ name: 'E-1', queue: join(S2, 'queue.json'), state: S2 }], ci: false });
has('AC4: an account with no reading is unreadable with the reason', bare, /^ {2}quota, the signed-in login: unreadable: no 7-day usage reading in any worker log or usage probe output since /);
has('AC9: a batch with no reading says not recorded', bare, /^ {2}quota, the signed-in login: not recorded in this batch's logs$/);
t('AC4: never a zero quota', bare.some((l) => /quota.*\b0%/.test(l)), false);
has('AC9: no spawn record is not recorded, never zero', bare, /desk commit workers ran on: not recorded \(1 run\(s\)\)$/);
has('AC9: no recorded bytes', bare, /instructions loaded at start: not recorded$/);
has('red CI not read is said', bare, /red CI runs by failing job: not read \(--no-ci\)$/);
const badGh = report({ ...base, gh: () => ({ status: 1, stderr: 'HTTP 401: Bad credentials' }) });
has('red CI unreadable names the reason', badGh, /red CI runs by failing job: unreadable: gh run list failed: HTTP 401: Bad credentials$/);
writeFileSync(join(S2, 'logs', 'B-1.log'), `{"type":"rate_limit_event","rate_limit_info":{}}\n${result(1, 10, 10)}\n`);
const garbled = report({ ...base, batches: [{ name: 'E-1', queue: join(S2, 'queue.json'), state: S2 }], ci: false });
has('AC4: readings that cannot be read are unreadable, with the reason', garbled, /^ {2}quota, the signed-in login: unreadable: every reading in the window failed to parse \(1 more reading\(s\) could not be read\)$/);

// ---- AC3: a dirty checkout behind origin is reported and left exactly as it was ------------
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const origin = join(T, 'origin.git');
const main = join(T, 'main');
const other = join(T, 'other');
git(T, 'init', '-q', '--bare', '-b', 'main', origin);
git(T, 'clone', '-q', origin, main);
writeFileSync(join(main, 'a.txt'), 'a\n');
git(main, 'add', 'a.txt');
git(main, 'commit', '-q', '-m', 'first');
git(main, 'push', '-q', 'origin', 'HEAD:main');
git(T, 'clone', '-q', origin, other);
writeFileSync(join(other, 'b.txt'), 'b\n');
git(other, 'add', 'b.txt');
git(other, 'commit', '-q', '-m', 'second');
git(other, 'push', '-q', 'origin', 'HEAD:main');
git(main, 'fetch', '-q', 'origin');
git(main, 'worktree', 'add', '-q', '-b', 'feat/W-1', join(T, 'wt'), 'HEAD');
writeFileSync(join(main, 'a.txt'), 'changed\n');
writeFileSync(join(main, 'new.txt'), 'new\n');
const snapshot = (dir) => {
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); const s = statSync(p); return s.isDirectory() ? walk(p) : [`${p} ${s.size} ${s.mtimeMs}`]; });
  // --no-optional-locks: a plain status may rewrite the index, and the snapshot must not change it.
  return [git(dir, '--no-optional-locks', 'status', '--porcelain'), ...walk(dir)];
};
const before = snapshot(main);
const checked = report({ ...base, root: main, defaultBranch: 'main', ci: false });
const after = snapshot(main);
const moved = [...after.filter((l) => !before.includes(l)), ...before.filter((l) => !after.includes(l))];
t('AC3: nothing in the checkout, its .git included, is changed', moved.join(', ') || 'unchanged', 'unchanged');
has('AC3: behind origin and uncommitted files are reported', checked, /^main checkout: .* on main, 1 behind and 0 ahead of origin\/main as last fetched, 2 uncommitted file\(s\) \(reported only: nothing is fetched, reset or checked out\)$/);
has('AC2: each live worktree\'s base', checked, /^ {2}worktree .*wt \(feat\/W-1\): base [0-9a-f]{12}, 1 behind origin\/main$/);
has('AC2: the main checkout\'s commit', checked, new RegExp(`^main checkout: .* at ${git(main, 'rev-parse', 'HEAD').slice(0, 12)} `));

// ---- spawn-worker.sh appends the line for every start -------------------------------------
const spawn = readFileSync(join(ROOT, 'desk', 'bin', 'spawn-worker.sh'), 'utf8');
const at = spawn.indexOf('phase0-report.mjs" spawn-line');
t('AC8: spawn-worker records each start in the worker\'s state file, before it launches', at > 0 && at < spawn.indexOf('desk_detach claude') && spawn.includes('>> "$STATE/workers/$TICKET.runs.jsonl" 2>/dev/null || true'), true);
t('AC8: the record comes after the preflight exits, so a preflight is not a start', at > spawn.indexOf('[preflight] FAILED — refusing to spawn $TICKET" >&2\n  exit 1\nfi'), true);

if (fails) { console.log(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nall passed');
