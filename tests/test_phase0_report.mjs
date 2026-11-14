// suite: phase 0 baseline report and levers row (phase0-report.mjs, desk-env levers)
// covers: desk/bin/phase0-report.mjs desk/bin/desk-env.mjs desk/bin/spawn-worker.sh desk/bin/lever-registry.mjs
// The report on fixture worker logs (stream-json), fix tries, digest answers, usage readings, spawn
// records and a stub gh; a main checkout behind origin with uncommitted files that the report leaves
// exactly as it found it; and the §3b Phase 0 levers row read through desk-env, with no row, known
// names and a name desk does not know.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logFacts, commandKey, report, spawnLine, spawnRecords, archivedBatches, claudeVersion, DAY_MS, perTicket, batchFigures } from '../desk/bin/phase0-report.mjs';
import { preflightLine } from '../desk/bin/worker-cost.mjs';
import { parseLevers, LEVERS, HOME } from '../desk/bin/desk-env.mjs';
import { REGISTRY, leverFingerprints, installedPath } from '../desk/bin/lever-registry.mjs';
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
const init = (sid) => JSON.stringify({ type: 'system', subtype: 'init', session_id: sid });
log('A-1.log', init('s1'), say('AUTOPILOT_STAGE: 4b/9 self-review'), use('x', 'Bash', { command: 'git stash list' }), deniedEvent('x', 'Bash'),
  say('AUTOPILOT_PARK: what copy?'), reading(0.30, RESET), reading(0.42, RESET), result(2, 1000, 100));
// A-2's log holds a start from before records existed (s0) and a recorded one after it (s2).
log('A-2.log', init('s0'), say('AUTOPILOT_STAGE: 3/9 implement'), init('s2'), say('AUTOPILOT_DONE: pr=2'), result(1, 3000, 300));
log('A-3.log', say('AUTOPILOT_STAGE: 3/9 implement'));
log('A-4.log', result(9, 9, 9));
utimesSync(join(S, 'logs', 'A-4.log'), (NOW - 10 * DAY_MS) / 1000, (NOW - 10 * DAY_MS) / 1000);
const queue = join(S, 'queue.json');
writeFileSync(queue, JSON.stringify({ tickets: {
  'A-1': { key: 'A-1', state: 'done', added_at: iso(3 * DAY_MS), merged_at: iso(DAY_MS), branch: 'feat/A-1',
    fix_tries: [{ try: 1, kind: 'checks', at: iso(DAY_MS) }, { try: 2, kind: 'review', at: iso(DAY_MS) }, { kind: 'capture', at: iso(DAY_MS) },
      { try: 1, kind: 'checks', at: iso(20 * DAY_MS) }] },
  'A-2': { key: 'A-2', state: 'done', added_at: iso(3 * DAY_MS), merged_at: iso(2 * DAY_MS), branch: 'feat/A-2' },
  'A-3': { key: 'A-3', state: 'running', added_at: iso(DAY_MS), branch: 'feat/A-3', fix_tries: [{ try: 1, kind: 'review', at: iso(DAY_MS) }] },
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
t('AC8: records are read back', spawnRecords(S).length, 2);
t('the spawn line records the effort', JSON.parse(spawnLine({ ticket: 'Z-1', session: 's', effort: 'high', installed: null, levers: { on: [], unknown: [] } })).effort, 'high');
t('the spawn line reads default with no effort passed', line.effort, 'default');

// ---- the claude version and lever-code fingerprints on the spawn line ------------------------
const TREE = join(T, 'tree');
const put = (p, body) => { mkdirSync(dirname(join(TREE, p)), { recursive: true }); writeFileSync(join(TREE, p), body); };
const paths = [...new Set(Object.values(REGISTRY).flatMap((l) => l.code.map((c) => c.path)))];
for (const p of paths) put(p, `${p} v1\n`);
const inTree = (p) => join(TREE, p);
const fpLine = (o = {}) => JSON.parse(spawnLine({ ticket: 'F-1', session: 's', installed: null, levers: { on: [], unknown: [] },
  claude: '2.1.0 (Claude Code)', fingerprints: leverFingerprints(REGISTRY, inTree), ...o }));
const first = fpLine();
t('AC1: the spawn line carries the claude version', first.claude_version, '2.1.0 (Claude Code)');
t('AC1: one hash per lever the registry declares', JSON.stringify(Object.keys(first.lever_fp)), JSON.stringify(Object.keys(REGISTRY)));
t('AC1: every hash is set when every file exists', Object.values(first.lever_fp).every((h) => /^[0-9a-f]{16}$/.test(h)), true);
t('AC3: two starts on the same code hash the same', JSON.stringify(fpLine().lever_fp), JSON.stringify(first.lever_fp));
put('hooks/desk-worker-hints.py', 'hooks/desk-worker-hints.py v2\n');
const second = fpLine();
t('AC2: a changed hints hook changes the wrappers hash', second.lever_fp.wrappers !== first.lever_fp.wrappers, true);
t('AC2: and no other lever\'s', Object.keys(REGISTRY).filter((n) => n !== 'wrappers').every((n) => second.lever_fp[n] === first.lever_fp[n]), true);
t('AC4: a failing claude --version is null', claudeVersion(() => ({ status: 1, stdout: '' })), null);
t('AC4: a claude that cannot be run is null', claudeVersion(() => { throw new Error('ENOENT'); }), null);
t('AC4: the version is the first line, trimmed', claudeVersion(() => ({ status: 0, stdout: ' 2.1.0 (Claude Code)\n' })), '2.1.0 (Claude Code)');
const noClaude = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'desk', 'bin', 'phase0-report.mjs'), 'spawn-line', '--ticket', 'F-2', '--session', 's'],
  { encoding: 'utf8', env: { ...env(noRow), PATH: join(T, 'no-bin'), DESK_HOME: join(T, 'no-desk') }, stdio: ['ignore', 'pipe', 'pipe'] }));
t('AC4: with no claude on PATH the spawn line is still written, version null', `${noClaude.ticket} ${noClaude.claude_version}`, 'F-2 null');
const FIX = { a: { code: [{ path: 'desk/bin/a.mjs' }, { path: 'desk/bin/gone.mjs' }] }, b: { code: [{ path: 'desk/bin/gone-too.mjs' }] } };
put('desk/bin/a.mjs', 'a\n');
const partial = leverFingerprints(FIX, inTree);
t('AC5: a lever with a missing file hashes the files that exist', partial.fp.a, leverFingerprints({ a: { code: [{ path: 'desk/bin/a.mjs' }] } }, inTree).fp.a);
t('AC5: a lever with no file that exists is null', partial.fp.b, null);
t('AC5: the spawn line names each missing file', JSON.stringify(fpLine({ fingerprints: partial }).lever_fp_missing), '["desk/bin/gone.mjs","desk/bin/gone-too.mjs"]');
const savedDeskHome = process.env.DESK_HOME;
process.env.DESK_HOME = join(T, 'desk-home');
t('the installed copy is hashed: desk/ under DESK_HOME', installedPath('desk/bin/x.mjs'), join(T, 'desk-home', 'bin', 'x.mjs'));
t('the installed copy is hashed: hooks/ under ~/.claude', installedPath('hooks/h.py'), join(HOME, '.claude', 'hooks', 'h.py'));
if (savedDeskHome === undefined) delete process.env.DESK_HOME; else process.env.DESK_HOME = savedDeskHome;

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
has('AC1: spend in the window, a run with no result named', batch, /spent in the window: 4,000 input tokens · 400 output tokens · \$3\.00 API-equivalent \(1 run\(s\) with no result event not counted\)$/);
has('AC1: tokens and cost per accepted ticket', batch, /per accepted ticket: 2,000 input tokens · 200 output tokens · \$1\.50 API-equivalent, over 2 of 2$/);
has('AC1: fix tries per accepted ticket: accepted tickets\' tries in the window, a capture not a try', batch, /fix tries per accepted ticket: 1\.00 \(2 made by accepted tickets\)/);
has('AC1: repair cycles by kind, every ticket\'s', batch, /repair cycles by kind: review 2 · capture 1 · checks 1$/);
has('AC1: needs-you raised and answered, this repo and window only', batch, /needs-you items: 1 raised \(worker parks\) · 1 answered/);
has('AC1: permission denials by command', batch, /permission denials by command: 1 in all: git stash 1$/);
has('AC1: Stage 4b review rounds', batch, /Stage 4b review rounds: 1$/);
has('AC1: red CI by failing job, batch branches only', batch, /red CI runs by failing job: test 1$/);
has('AC1: red CI in total counts every failed run, a run whose jobs cannot be read named', total, /red CI runs by failing job: CI \(jobs not read\) 1 · test 1$/);
has('AC1: quota used, from the readings in the logs', batch, /7-day window resetting .*: 30% to 42%, 12 point\(s\) used/);
has('AC2: the installed desk commit', out, /^installed desk: abcdef123456, installed 2026-11-06T00:00:00Z$/);
has('AC2: the instructions a worker loads now', out, /^instructions a worker loads now: worker contract core [\d,]+ bytes, memory index none$/);
has('AC2 / AC9: the desk commit each start used, a start before records, in a recorded log too, not recorded', batch, /desk commit workers ran on: abcdef123456 \(2 start\(s\)\) · not recorded \(2 start\(s\)\)$/);
has('AC2: instruction bytes per start', batch, /instructions loaded at start: 3,000 bytes on average over 2 start\(s\) \(system prompt 2,000, first message 1,000\)/);
has('AC2: each session\'s desk commit and bytes on its own line', batch, /start A-1 session s1 at \S+ \(stage 0, effort default\): desk abcdef123456, levers codex, 1,500 bytes loaded$/);
has('AC7: the levers on for the batch', batch, /levers on: codex \(1 start\(s\)\) · none \(1 start\(s\)\) · not recorded \(2 start\(s\)\)$/);
has('AC6: the report names an unknown lever as off', out, /^levers row now: on none; unknown, read as off: turbo$/);
t('the only gh calls are reads', ghCalls.every((c) => /^run (list|view) /.test(c)), true);

// AC4 / AC9: no readings anywhere: unreadable with the reason, never zero.
const S2 = join(T, 'state2');
mkdirSync(join(S2, 'logs'), { recursive: true });
writeFileSync(join(S2, 'logs', 'B-1.log'), `${result(1, 10, 10)}\n`);
// B-2 merged after a finished run and a retry that left no result event: its finished run still
// counts in the spend, and it is left out of the per-ticket figure, said so, never a zero.
writeFileSync(join(S2, 'logs', 'B-2.log'), `${result(1, 10, 10)}\n`);
writeFileSync(join(S2, 'logs', 'B-2.log.round1'), `${say('AUTOPILOT_STAGE: 3/9 implement')}\n`);
writeFileSync(join(S2, 'queue.json'), JSON.stringify({ tickets: {
  'B-1': { key: 'B-1', state: 'running', added_at: iso(DAY_MS) },
  'B-2': { key: 'B-2', state: 'done', added_at: iso(DAY_MS), merged_at: iso(DAY_MS / 24) },
} }));
const bare = report({ ...base, batches: [{ name: 'E-1', queue: join(S2, 'queue.json'), state: S2 }], ci: false });
has('a ticket with one run unfinished keeps its finished run\'s spend', bare, /^ {2}spent in the window: 20 input tokens · 20 output tokens · \$2\.00 API-equivalent \(1 run\(s\) with no result event not counted\)$/);
has('an accepted ticket with spend not fully recorded is left out, said so', bare, /^ {2}per accepted ticket: not recorded: no accepted ticket has its spend fully recorded; 1 accepted ticket\(s\) left out/);
has('AC4: an account with no reading is unreadable with the reason', bare, /^ {2}quota, the signed-in login: unreadable: no 7-day usage reading in any worker log or usage probe output since /);
has('AC4 / AC9: a batch with no reading is unreadable: not recorded', bare, /^ {2}quota, the signed-in login: unreadable: not recorded in this batch's logs$/);
t('AC4: never a zero quota', bare.some((l) => /quota.*\b0%/.test(l)), false);
has('AC9: no spawn record is not recorded, never zero', bare, /desk commit workers ran on: not recorded \(3 start\(s\)\)$/);
has('AC9: no recorded bytes', bare, /instructions loaded at start: not recorded$/);
has('red CI not read is said', bare, /red CI runs by failing job: not read \(--no-ci\)$/);
const badGh = report({ ...base, gh: () => ({ status: 1, stderr: 'HTTP 401: Bad credentials' }) });
has('red CI unreadable names the reason', badGh, /red CI runs by failing job: unreadable: gh run list failed: HTTP 401: Bad credentials$/);
writeFileSync(join(S2, 'logs', 'B-1.log'), `{"type":"rate_limit_event","rate_limit_info":{}}\n${result(1, 10, 10)}\n`);
const garbled = report({ ...base, batches: [{ name: 'E-1', queue: join(S2, 'queue.json'), state: S2 }], ci: false });
has('AC4: readings that cannot be read are unreadable, with the reason', garbled, /^ {2}quota, the signed-in login: unreadable: every reading in the window failed to parse \(1 more reading\(s\) could not be read\)$/);

// A named batch archived inside the window (batch.mjs moves its queue and state folders to .done/)
// still has its section and its share of the total.
const QR = join(T, 'qroot');
const SR = join(T, 'sroot');
const doneQ = join(QR, 'batches', '.done', 'E-9');
const doneS = join(SR, 'batches', '.done', 'E-9');
mkdirSync(doneQ, { recursive: true });
mkdirSync(join(doneS, 'logs'), { recursive: true });
mkdirSync(join(QR, 'batches', '.done', 'no-queue'), { recursive: true });
writeFileSync(join(doneQ, 'queue.json'), JSON.stringify({ tickets: { 'C-1': { key: 'C-1', state: 'done', added_at: iso(2 * DAY_MS), merged_at: iso(DAY_MS) } } }));
writeFileSync(join(doneS, 'logs', 'C-1.log'), `${result(1, 10, 10)}\n`);
const archived = archivedBatches({ queueRoot: QR, stateRoot: SR });
t('an archived batch is listed with its queue and state, a folder with no queue is not', archived.map((b) => `${b.name} ${b.queue === join(doneQ, 'queue.json')} ${b.state === doneS}`).join(', '), 'E-9 (archived) true true');
const withArchived = report({ ...base, batches: archived, ci: false });
has('an archived batch has its own section', withArchived, /^batch E-9 \(archived\):$/);
has('an archived batch counts in the total', withArchived.slice(withArchived.findIndex((l) => l.startsWith('total'))), /^ {2}tickets with work or a merge in the window: 1, accepted \(PR merged\): 1$/);

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

// ---- per-ticket rows: one per admitted ticket, across a live and an archived batch ---------
// 36 tickets admitted in the last 7 days, 24 merged and 12 not, split over a live batch (P-1..P-20)
// and an archived one (P-21..P-36), plus two admitted before the window whose work is all older.
const PR_ROOT = join(T, 'per-ticket');
const liveQ = join(PR_ROOT, 'q', 'batches', 'E-7', 'queue.json');
const liveS = join(PR_ROOT, 's', 'batches', 'E-7');
const archQ = join(PR_ROOT, 'q', 'batches', '.done', 'E-8', 'queue.json');
const archS = join(PR_ROOT, 's', 'batches', '.done', 'E-8');
const tickets = { [liveQ]: {}, [archQ]: {} };
const stateOf = { [liveQ]: liveS, [archQ]: archS };
for (const s of [liveS, archS]) for (const d of ['logs', 'workers', 'triage']) mkdirSync(join(s, d), { recursive: true });
mkdirSync(dirname(liveQ), { recursive: true });
mkdirSync(dirname(archQ), { recursive: true });
const PIN = { set: ['codex', 'memory'], arms: { codex: 'on', memory: 'off' }, trial_ids: { codex: 'T-1', memory: 'T-2' }, fp: { codex: 'abc' }, at: iso(DAY_MS) };
for (let i = 1; i <= 36; i++) {
  const key = `P-${i}`;
  const q = i <= 20 ? liveQ : archQ;
  const s = stateOf[q];
  // Admitted between 1 and 6 days ago, by i, so a narrower window holds a known subset.
  const added = iso(DAY_MS * (1 + (i % 6)) + i * 60_000);
  const merged = i % 3 !== 0;
  tickets[q][key] = { key, type: i % 2 ? 'Story' : 'Bug', lane: 'A', state: merged ? 'done' : i % 9 === 0 ? 'failed' : 'running',
    added_at: added, ...(merged ? { merged_at: iso(DAY_MS / 2) } : {}), branch: `feat/${key}`,
    login: { name: i % 2 ? 'work' : 'personal', config_dir: null }, ...(i === 1 ? { levers: PIN } : {}),
    fix_tries: i === 1 ? [{ try: 1, kind: 'checks', at: iso(DAY_MS) }, { kind: 'capture', at: iso(DAY_MS) }] : [] };
  if (i !== 2) writeFileSync(join(s, 'triage', `${key}.json`), JSON.stringify({ size: i % 2 ? 'M' : 's' }));
  const lines = [init(`ps-${i}`), result(1 + i * 0.37 + 0.001, 100 * i, 10 * i)];
  if (i === 1) lines.splice(1, 0, say('AUTOPILOT_STAGE: 4b/9 self-review'), say('AUTOPILOT_PARK: approve the pricing call?'),
    say('AUTOPILOT_PARK: worktree setup failed'), use('pd', 'Bash', { command: 'gh api x' }), deniedEvent('pd', 'Bash'));
  if (i % 4 === 0) lines.unshift(preflightLine({ usd: 0.05 * i, turns: 1 }).trim());
  if (i !== 36) writeFileSync(join(s, 'logs', `${key}.log`), `${lines.join('\n')}\n`);
  // P-5's second run left no result event.
  if (i === 5) writeFileSync(join(s, 'logs', `${key}.log.round1`), `${init('ps-5b')}\n${say('AUTOPILOT_STAGE: 3/9 implement')}\n`);
  if (i === 1) writeFileSync(join(s, 'workers', `${key}.runs.jsonl`), `${spawnLine({ ticket: key, session: 'ps-1', installed: { commit: 'feedface00112233' }, levers: { on: ['codex'], unknown: [] }, claude: '2.1.0 (Claude Code)' })}\n`);
  // P-3's start was recorded before starts carried a claude version.
  if (i === 3) writeFileSync(join(s, 'workers', `${key}.runs.jsonl`), `${JSON.stringify({ at: iso(DAY_MS), ticket: key, session: 'ps-3', stage: '0', desk_commit: 'feedface00112233', levers: [] })}\n`);
}
// Two tickets admitted before the window, merged and last worked before it.
tickets[liveQ]['OLD-1'] = { key: 'OLD-1', state: 'done', added_at: iso(20 * DAY_MS), merged_at: iso(15 * DAY_MS), branch: 'feat/OLD-1' };
tickets[archQ]['OLD-2'] = { key: 'OLD-2', state: 'failed', added_at: iso(9 * DAY_MS), branch: 'feat/OLD-2' };
for (const [k, s] of [['OLD-1', liveS], ['OLD-2', archS]]) {
  writeFileSync(join(s, 'logs', `${k}.log`), `${result(50, 1, 1)}\n`);
  utimesSync(join(s, 'logs', `${k}.log`), (NOW - 12 * DAY_MS) / 1000, (NOW - 12 * DAY_MS) / 1000);
}
for (const q of [liveQ, archQ]) writeFileSync(q, JSON.stringify({ tickets: tickets[q] }));
const ptBatches = [{ name: 'E-7', queue: liveQ, state: liveS }, ...archivedBatches({ queueRoot: join(PR_ROOT, 'q'), stateRoot: join(PR_ROOT, 's') })];
const ptGh = (args) => {
  if (args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ databaseId: 71, headBranch: 'feat/P-1', workflowName: 'CI' }, { databaseId: 72, headBranch: 'feat/P-1', workflowName: 'CI' }, { databaseId: 73, headBranch: 'main', workflowName: 'CI' }]) };
  return { status: 0, stdout: JSON.stringify({ jobs: [{ name: 'test', conclusion: 'failure' }] }) };
};
const SINCE = NOW - 7 * DAY_MS;
const pt = perTicket({ slug: 'o__r', batches: ptBatches, since: SINCE, until: NOW, gh: ptGh, repo: 'o/r' });
const rowOf = (k) => pt.rows.find((r) => r.key === k);
t('per-ticket AC1: one row per admitted ticket across a live and an archived batch', pt.rows.length, 36);
t('per-ticket AC1: 24 merged, 12 not', `${pt.rows.filter((r) => r.merged_at).length} ${pt.rows.filter((r) => !r.merged_at).length}`, '24 12');
t('per-ticket AC1: every key once', new Set(pt.rows.map((r) => r.key)).size, 36);
t('per-ticket AC1: the archived batch\'s tickets are there', rowOf('P-30')?.batch, 'E-8 (archived)');
t('per-ticket AC1: the CLI flags are documented in the header', /--per-ticket \[--json\]/.test(readFileSync(join(ROOT, 'desk', 'bin', 'phase0-report.mjs'), 'utf8')), true);
const aggregate = ptBatches.map((b) => batchFigures({ queue: b.queue, state: b.state, slug: 'o__r', since: SINCE })).reduce((n, f) => n + f.cost, 0);
const rowSum = pt.rows.reduce((n, r) => n + r.cost, 0);
t('per-ticket AC2: the rows\' costs sum to the aggregate\'s, to the cent', rowSum.toFixed(2), aggregate.toFixed(2));
const printed = report({ ...base, batches: ptBatches, ci: false });
const totalLine = printed.slice(printed.findIndex((l) => l.startsWith('total'))).find((l) => /spent in the window/.test(l));
t('per-ticket AC2: and to the total the report prints', totalLine.match(/\$([\d,.]+) API-equivalent/)?.[1], rowSum.toFixed(2));
const p1 = rowOf('P-1');
const FIELDS = ['slug', 'batch', 'key', 'type', 'lane', 'size', 'admitted_at', 'merged_at', 'state', 'cost', 'cost_complete', 'input', 'output',
  'preflight_cost', 'runs', 'unknown_runs', 'starts', 'fix_tries', 'parks', 'parks_by_class', 'review_rounds', 'denials', 'denials_by_command',
  'ci_reds', 'ci_reds_by_job', 'desk_commits', 'start_records', 'login', 'pin'];
t('per-ticket AC3: every row holds every field', pt.rows.every((r) => FIELDS.every((k) => k in r)), true);
t('per-ticket AC3: identity, type, lane, size, admitted and login', `${p1.slug} ${p1.key} ${p1.type} ${p1.lane} ${p1.size} ${p1.admitted_at === tickets[liveQ]['P-1'].added_at} ${p1.login}`, 'o__r P-1 Story A M true work');
t('per-ticket AC3: a size recorded in lower case reads as its size', rowOf('P-4').size, 'S');
t('per-ticket AC3: merged_at, or the terminal state for one not merged', `${p1.merged_at != null} ${rowOf('P-9').merged_at} ${rowOf('P-9').state}`, 'true null failed');
t('per-ticket AC3: cost, tokens and starts', `${p1.cost.toFixed(3)} ${p1.input} ${p1.output} ${p1.starts} ${p1.cost_complete}`, '1.371 100 10 1 true');
t('per-ticket AC3: preflight dollars are in the cost and on their own', `${rowOf('P-4').preflight_cost.toFixed(2)} ${rowOf('P-4').cost.toFixed(3)}`, '0.20 2.681');
t('per-ticket AC3: fix tries, a capture not a try', p1.fix_tries, 1);
t('per-ticket AC3: parks by class', JSON.stringify(p1.parks_by_class), '{"missing decision":1,"runner or resource":1}');
t('per-ticket AC3: Stage 4b rounds and permission denials', `${p1.review_rounds} ${p1.denials} ${JSON.stringify(p1.denials_by_command)}`, '1 1 {"gh api":1}');
t('per-ticket AC3: CI reds on its own branch only', `${p1.ci_reds} ${JSON.stringify(p1.ci_reds_by_job)} ${rowOf('P-2').ci_reds}`, '2 {"test":2} 0');
t('per-ticket AC3: distinct desk commits and the levers and claude version of each start',
  `${JSON.stringify(p1.desk_commits)} ${JSON.stringify(p1.start_records.map((s) => [s.session, s.levers, s.claude_version]))}`,
  '["feedface00112233"] [["ps-1",["codex"],"2.1.0 (Claude Code)"]]');
t('per-ticket AC3: a start with no record is there with nothing filled in', JSON.stringify(rowOf('P-7').start_records), '[{"at":null,"session":"ps-7","stage":null,"desk_commit":null,"levers":null,"claude_version":null}]');
const p5 = rowOf('P-5');
t('per-ticket AC4: a run with no result event leaves the cost incomplete', `${p5.cost_complete} ${p5.unknown_runs} ${p5.runs}`, 'false 1 2');
t('per-ticket AC4: and no estimate is filled in: the recorded run alone', p5.cost.toFixed(3), (1 + 5 * 0.37 + 0.001).toFixed(3));
t('per-ticket AC5: no triage size is null and the row is still printed', rowOf('P-2')?.size, null);
t('per-ticket AC6: a start that recorded no claude version is null', JSON.stringify(rowOf('P-3').start_records.map((s) => [s.desk_commit, s.claude_version])), '[["feedface00112233",null]]');
t('per-ticket AC8: a pinned ticket holds the pin\'s set, arms and trial ids', JSON.stringify(p1.pin), JSON.stringify({ set: PIN.set, arms: PIN.arms, trial_ids: PIN.trial_ids }));
t('per-ticket AC9: a ticket with no pin holds null', rowOf('P-2').pin, null);
t('per-ticket: a ticket no worker ran has a row, costing nothing, complete', `${rowOf('P-36')?.cost} ${rowOf('P-36')?.starts} ${rowOf('P-36')?.cost_complete}`, '0 0 true');
t('per-ticket: red CI not read is null, never zero', perTicket({ slug: 'o__r', batches: ptBatches, since: SINCE, until: NOW, ci: false }).rows[0].ci_reds, null);
const nineIso = new Date(NOW - 5 * DAY_MS).toISOString();
const twoIso = new Date(NOW - 2 * DAY_MS).toISOString();
const exitOf = (...a) => { try { execFileSync(process.execPath, [join(ROOT, 'desk', 'bin', 'phase0-report.mjs'), ...a], { env: env(noRow), stdio: 'ignore' }); return 0; } catch (e) { return e.status; } };
t('per-ticket AC7: the window flags are refused without --per-ticket', `${exitOf('--since', nineIso)} ${exitOf('--json')}`, '2 2');
t('per-ticket AC10: a window that is not one is refused', `${exitOf('--per-ticket', '--since', 'soon')} ${exitOf('--per-ticket', '--since', twoIso, '--until', nineIso)}`, '2 2');
const want = Object.values({ ...tickets[liveQ], ...tickets[archQ] }).filter((x) => Date.parse(x.added_at) >= Date.parse(nineIso) && Date.parse(x.added_at) < Date.parse(twoIso)).map((x) => x.key).sort();
const win = perTicket({ slug: 'o__r', batches: ptBatches, since: Date.parse(nineIso), until: Date.parse(twoIso), ci: false });
t('per-ticket AC10: a --since/--until window holds exactly the tickets admitted in it', JSON.stringify(win.rows.map((r) => r.key).sort()), JSON.stringify(want));
t('per-ticket AC10: the window is a proper subset', want.length > 0 && want.length < 36, true);
t('per-ticket AC10: the window is printed with the rows', `${win.since} ${win.until}`, `${nineIso} ${twoIso}`);

// ---- spawn-worker.sh appends the line for every start -------------------------------------
const spawn = readFileSync(join(ROOT, 'desk', 'bin', 'spawn-worker.sh'), 'utf8');
const from = spawn.indexOf('# The desk commit and levers this start runs on');
const to = spawn.indexOf('\ncd "$WT"', from);
if (from < 0 || to < 0) throw new Error('spawn-worker.sh has no recording step to run');
// Run spawn-worker.sh's own recording step, as it stands in the script, against a scratch state.
const S3 = join(T, 'state3');
mkdirSync(join(S3, 'workers'), { recursive: true });
const step = spawn.slice(from, to);
const spawnEnv = (extra) => {
  return { ...env(mixed), BIN: join(ROOT, 'desk', 'bin'), TICKET: 'W-9', SID: 'sid-9', STATE: S3, LOG: join(S3, 'W-9.log'), SYSTEM: 'héllo', PROMPT: 'abc', MODEL: 'opus', EFFORT: 'high', ...extra };
};
execFileSync('bash', ['-c', step], { env: spawnEnv({ START: '4b' }) });
execFileSync('bash', ['-c', step], { env: spawnEnv({ START: 'resume' }) });
execFileSync('bash', ['-c', step], { env: spawnEnv({ START: '0', BIN: join(T, 'no-bin') }) });
const written = readFileSync(join(S3, 'workers', 'W-9.runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const [w1, w2] = written;
t('AC8: a start writes one line per start, a failed record none and no error', written.length, 2);
t('AC8: the line names the ticket, session, stage and model', `${w1.ticket} ${w1.session} ${w1.stage} ${w1.model} ${w2.stage}`, 'W-9 sid-9 4b opus resume');
t('the line and the worker\'s log both record the effort', `${w1.effort} ${JSON.parse(readFileSync(join(S3, 'W-9.log'), 'utf8').split('\n')[0]).effort}`, 'high high');
t('AC8: the line records the levers on and the unknown ones', `${JSON.stringify(w1.levers)} ${JSON.stringify(w1.unknown_levers)}`, '["codex","effort","memory"] ["turbo"]');
t('AC8: the bytes handed over, counted in bytes', `${w1.system_bytes} ${w1.prompt_bytes}`, '6 3');
t('AC8: the record is read back by the report', spawnRecords(S3).length, 2);
t('AC1: spawn-worker\'s line carries the claude version and a hash per declared lever',
  `${'claude_version' in w1} ${JSON.stringify(Object.keys(w1.lever_fp ?? {}))}`, `true ${JSON.stringify(Object.keys(REGISTRY))}`);

if (fails) { console.log(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nall passed');
