// suite: preflight skip (with the lever on, a preflight is skipped on a passed fingerprint and otherwise runs at low effort)
// layer: L2
// budget: 80 DS-943 (about 50 whole spawn-worker.sh preflights, each a dozen node starts; 50-81 s on CI before DS-943's cuts)
// covers: desk/bin/preflight-fingerprint.mjs desk/bin/spawn-worker.sh desk/bin/preflight-record.mjs desk/bin/model-list.mjs
// A stub claude on PATH answers the version and account reads from files, and each -p call as the
// $T/reply file says, recording its argv. A scratch desk home links the real desk/bin beside its own
// installed.json. Scratch HOME and repo only.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, chmodSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
import { maskText } from '../desk/bin/preflight-fingerprint.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const T = scratch('desk-pre-');
for (const d of ['home', 'state', 'stub', 'repo', 'repo2', 'deskhome']) mkdirSync(join(T, d), { recursive: true });
cpSync(join(root, 'agents'), join(T, 'home', '.claude', 'agents'), { recursive: true });
symlinkSync(join(root, 'desk', 'bin'), join(T, 'deskhome', 'bin'));
const installed = (v) => writeFileSync(join(T, 'deskhome', 'installed.json'), JSON.stringify(v));
installed({ commit: 'c1', dirty: false, at: '2026-11-07T00:00:00Z' });
const git = (...a) => spawnSync('git', ['-C', join(T, 'repo'), ...a], { env: { ...process.env, HOME: join(T, 'home'), GIT_CONFIG_NOSYSTEM: '1' } });
git('init', '-q', '-b', 'main'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');

const config = (name, levers, extra = '') => {
  const p = join(T, `${name}.md`);
  writeFileSync(p, `## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`${join(T, 'repo')}\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Phase 0 levers | \`none\` | ${levers} |
${extra}
## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Ticket key pattern | \`none\` |
| Other work id patterns | \`none\` |
| Package manager | \`none\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Unit tests | \`bash tests/run.sh\` |
`);
  return p;
};
const ON = config('on', '`preflight`');
const ON_EFFORT = config('on-effort', '`preflight` `effort`', '| Worker effort | `none` | `4b=high` |\n');
const OFF = config('off', '`none`');
const ON_PUSH = join(T, 'on-push.md');
writeFileSync(ON_PUSH, readFileSync(ON, 'utf8').replace('| `autopilot-workers` |', '| `git-push` | Push | `yes` | `yes` |\n| `autopilot-workers` |'));

const say = (f, text) => writeFileSync(join(T, f), text);
say('version', '2.0.0 (Claude Code)');
say('account', '{"loggedIn":true,"email":"a@example.com"}');
// Every check the preflight asks, as the checks it wants answered. Only -p calls are recorded.
const GOOD = 'W_IN=OK\nW_OUT=BLOCKED\nTOOL1=OK\nAGENTS=OK\nDENY=BLOCKED\nDENY2=BLOCKED\nESCAPE=BLOCKED\nCODEX=BLOCKED\nMODEL_OK';
const result = (text, more = {}) => JSON.stringify({ type: 'result', result: text, total_cost_usd: 0.1, num_turns: 3, ...more });
say('reply', result(GOOD));
say('models', '{"value":"default"},{"value":"opus"}');
const stub = join(T, 'stub', 'claude');
writeFileSync(stub, `#!/usr/bin/env bash
if [ "$1" = --version ]; then cat "${T}/version"; exit 0; fi
if [ "$1 $2" = "auth status" ]; then cat "${T}/account"; exit 0; fi
printf '%s\\n' "\${FORCE_PROMPT_CACHING_5M-unset}" >> "${T}/cache"
printf '%s' "$*" | tr '\\n' ' ' >> "${T}/calls"
echo >> "${T}/calls"
# While $T/write-w-in exists, the session really writes the W_IN file the prompt names.
if [ -e "${T}/write-w-in" ]; then f=$(printf '%s' "$*" | grep -oE '[^ ]*/\\.preflight\\.tmp' | head -1); [ -n "$f" ] && echo x > "$f"; fi
# While $T/write-reread exists, the worker reread hook fires as it does under DESK_AUTOPILOT_WORKER=1.
if [ -e "${T}/write-reread" ] && [ "\${DESK_AUTOPILOT_WORKER-}" = 1 ] && [ "\${DESK_ALLOW_REREAD-}" != 1 ]; then mkdir -p "$DESK_HOME/worker-reread/sess-1"; echo '{}' > "$DESK_HOME/worker-reread/sess-1/r.json"; fi
# The model list (model-list.mjs): the initialize response, naming each model in $T/models, and no turn.
case "$*" in *--input-format*) printf '{"type":"control_response","response":{"subtype":"success","request_id":"desk-model-list","response":{"models":[%s]}}}\\n' "$(cat "${T}/models")"; exit 0 ;; esac
# While $T/reject-model exists, a call on the model it names is refused, as the CLI refuses a model it cannot start on.
if [ -e "${T}/reject-model" ] && printf '%s' "$*" | grep -qF -- "--model $(cat "${T}/reject-model")"; then echo "There's an issue with the selected model"; exit 1; fi
# $T/reply.first, while it exists, answers one call in place of $T/reply.
if [ -e "${T}/reply.first" ]; then cat "${T}/reply.first"; rm -f "${T}/reply.first"; else cat "${T}/reply"; fi
`);
chmodSync(stub, 0o755);
const KEY = 'fix-thing';
const record = join(T, 'state', 'workers', `${KEY}.preflight.json`);
const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8').trim().split('\n') : []);

const env = (extra) => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete e[k];
  return { ...e, HOME: join(T, 'home'), GIT_CONFIG_NOSYSTEM: '1', PATH: `${join(T, 'stub')}:${process.env.PATH}`,
    DESK_CONFIG: ON, DESK_HOME: join(T, 'deskhome'), DESK_STATE: join(T, 'state'), DESK_AUTOPILOT_STATE: join(T, 'state'),
    DESK_QUEUE: join(T, 'queue.json'), DESK_SKILLS_DIR: join(root, 'skills'),
    AUTOPILOT_PORT: '3999', AUTOPILOT_BRANCH: 'fix/fix-thing', AUTOPILOT_PREFLIGHT: '1', ...extra };
};
// One preflight: what it printed, its exit code, and the -p calls it made.
const preflight = (extra = {}, wt = join(T, 'repo'), key = KEY) => {
  rmSync(join(T, 'calls'), { force: true });
  const r = spawnSync('bash', [join(root, 'desk/bin/spawn-worker.sh'), key, wt, 'preflight'], { cwd: join(T, 'repo'), env: env(extra), encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: r.stdout + r.stderr, calls: calls(), skipped: /^\[preflight\] skipped/m.test(r.stdout), passed: /^\[preflight\] pass$/m.test(r.stdout) };
};
const ran = (r) => [r.status, r.skipped, r.calls.length > 0];
const RAN = [0, false, true];
const SKIPPED = [0, true, false];

let r = preflight();
t('AC2 with no record the preflight runs and passes', [...ran(r), r.passed], [...RAN, true]);
t('AC2 it runs at low effort', /--effort low( |$)/.test(r.calls[0]), true);
t('a pass records the fingerprint', /^\{"fingerprint":"[0-9a-f]{64}"\}\n$/.test(readFileSync(record, 'utf8')), true);
const first = readFileSync(record, 'utf8');
// The call is kept for the bench's replay (preflight-record.mjs), every file of it.
const kept = readdirSync(join(T, 'state', 'preflight')).sort();
const keptBase = kept.find((n) => n.endsWith('.prompt.md'))?.slice(0, -'.prompt.md'.length);
t('the call is recorded as prompt, reply, inputs, settings and agents', kept.map((n) => n.slice(keptBase.length)).join(' '), '.agents.json .inputs.json .json .prompt.md .settings.json');
t('the recorded prompt is the one sent', readFileSync(join(T, 'state', 'preflight', `${keptBase}.prompt.md`), 'utf8').startsWith('Perform these'), true);
t('the recorded reply is the raw reply', readFileSync(join(T, 'state', 'preflight', `${keptBase}.json`), 'utf8'), result(GOOD));
const keptInputs = JSON.parse(readFileSync(join(T, 'state', 'preflight', `${keptBase}.inputs.json`), 'utf8'));
t('the recorded inputs name the worktree, effort and files', [keptInputs.ticket, keptInputs.worktree, keptInputs.effort, keptInputs.files.w_in, keptInputs.probes.length > 0], [KEY, join(T, 'repo'), 'low', false, true]);

r = preflight();
t('AC1 the same inputs make no call', ran(r), SKIPPED);
t('AC1 and it still reads as a pass', r.passed, true);
t('AC1 the output names the fingerprint', /skipped: its last pass had this fingerprint/.test(r.out), true);
t('AC1 a resume or a later start skips too', ran(preflight({ AUTOPILOT_RESUME: 'carry on', AUTOPILOT_START_STAGE: '4b' })), SKIPPED);

// AC2: each input, changed alone, runs the preflight. It is put back with the first pass's record,
// which a pass on the first inputs writes again (checked at the end), so each case starts from a
// clean skip without a preflight run to remake it.
const whenChanged = (name, change, undo, extra = {}) => {
  change();
  const c = preflight(extra);
  t(`AC2 a changed ${name} runs the preflight`, ran(c), RAN);
  t(`AC2 a changed ${name} is at low effort`, /--effort low( |$)/.test(c.calls[0] ?? ''), true);
  undo();
  writeFileSync(record, first);
  t(`a changed ${name} put back is a skip again`, ran(preflight()), SKIPPED);
};
whenChanged('CLI version', () => say('version', '2.0.1 (Claude Code)'), () => say('version', '2.0.0 (Claude Code)'));
whenChanged('account', () => say('account', '{"loggedIn":true,"email":"b@example.com"}'), () => say('account', '{"loggedIn":true,"email":"a@example.com"}'));
say('account', '{"loggedIn":true,"email":"a@example.com","expiresAt":"later"}');
t('a status field that is not who is signed in changes nothing', ran(preflight()), SKIPPED);
say('account', '{"loggedIn":true,"email":"a@example.com"}');
whenChanged('desk commit', () => installed({ commit: 'c2', dirty: false, at: 'x' }), () => installed({ commit: 'c1', dirty: false, at: 'x' }));
whenChanged('dirty install', () => installed({ commit: 'c1', dirty: true, at: 'later' }), () => installed({ commit: 'c1', dirty: false, at: 'x' }));
whenChanged('model', () => {}, () => {}, { AUTOPILOT_MODEL: 'opus' });
whenChanged('finder model', () => {}, () => {}, { AUTOPILOT_FINDER_MODEL: 'opus' });
whenChanged('text model', () => {}, () => {}, { AUTOPILOT_TEXT_MODEL: 'opus' });
whenChanged('tool list', () => {}, () => {}, { AUTOPILOT_DEFAULT_TOOLS: '1' });
whenChanged('effort', () => {}, () => {}, { DESK_CONFIG: ON_EFFORT });
whenChanged('worker settings', () => {}, () => {}, { DESK_CONFIG: ON_PUSH });
// The agents file is rebuilt from the user's agents on every spawn.
const agent = join(T, 'home', '.claude', 'agents', 'lena-code-reviewer.md');
const agentWas = readFileSync(agent, 'utf8');
whenChanged('agents file', () => writeFileSync(agent, `${agentWas}\nOne more rule.\n`), () => writeFileSync(agent, agentWas));

// AC3: a failure and a usage limit leave nothing to skip on, whatever passed before.
say('reply', result('W_IN=BLOCKED'));
say('version', '2.0.2 (Claude Code)');
r = preflight();
t('AC3 a failed preflight fails', [r.status, r.passed], [1, false]);
t('AC3 it leaves no record', existsSync(record), false);
say('version', '2.0.0 (Claude Code)');
say('reply', result(GOOD));
t('AC3 the next spawn runs, even on the inputs of the pass before it', ran(preflight()), RAN);
say('reply', result("You've hit your weekly limit", { api_error_status: 429 }));
rmSync(record);
r = preflight();
t('AC3 a preflight at the usage limit says so and records nothing', [/^\[preflight\] usage-limit/m.test(r.out), existsSync(record)], [true, false]);
say('reply', result(GOOD));
t('AC3 the spawn after the limit runs', ran(preflight()), RAN);

// An input that cannot be read is no fingerprint: the preflight runs, and no pass is recorded on it.
say('account', '');
r = preflight();
t('an unreadable account runs the preflight', ran(r), RAN);
t('it says why', /no fingerprint, so it runs: could not read claude auth status/.test(r.out), true);
t('and records nothing', existsSync(record), false);
say('account', '{"loggedIn":true,"email":"a@example.com"}');
rmSync(join(T, 'deskhome', 'installed.json'));
t('no installed commit runs the preflight', [ran(preflight()), existsSync(record)], [RAN, false]);
installed({ commit: 'c1', dirty: false, at: 'x' });

// AC4: the lever off runs every time, with no effort and no record, and asks nothing new of the CLI.
preflight();
t('lever on: the record is there', existsSync(record), true);
const off = { DESK_CONFIG: OFF };
r = preflight(off);
t('AC4 lever off: a matching record is not skipped on', ran(r), RAN);
t('AC4 lever off: no --effort', r.calls.some((c) => c.includes('--effort')), false);
t('AC4 lever off: nothing is recorded', [r.passed, existsSync(record)], [true, false]);
// haiku is not in the stub's list, so the one-word probe runs and its own call is checked.
const noEffortFinder = preflight({ ...off, AUTOPILOT_FINDER_MODEL: 'haiku' });
t('AC4 lever off: the finder check has no --effort',
  [noEffortFinder.calls.length, noEffortFinder.calls.filter((c) => c.includes('MODEL_OK')).length, noEffortFinder.calls.some((c) => c.includes('--effort'))], [3, 1, false]);
const finder = preflight({ AUTOPILOT_FINDER_MODEL: 'opus' });
t('DS-696 AC1 a finder model the CLI lists is read from its list: no model turn is spent on it',
  [finder.passed, finder.calls.length, /--input-format stream-json/.test(finder.calls[1] ?? ''), finder.calls.some((c) => c.includes('MODEL_OK'))], [true, 2, true, false]);
const unlisted = preflight({ AUTOPILOT_FINDER_MODEL: 'haiku', AUTOPILOT_TEXT_MODEL: 'claude-haiku-5-5' });
t('DS-696 a model the CLI does not list gets the one-word probe, at low effort, after one list read',
  [unlisted.passed, unlisted.calls.length, unlisted.calls.filter((c) => c.includes('--input-format')).length, unlisted.calls.filter((c) => c.includes('MODEL_OK')).every((c) => /--effort low( |$)/.test(c))], [true, 4, 1, true]);
say('models', '');
const noList = preflight({ AUTOPILOT_FINDER_MODEL: 'opus' });
t('DS-696 a CLI that gives no list keeps the probe', [noList.passed, noList.calls.length, noList.calls.some((c) => c.includes('MODEL_OK'))], [true, 3, true]);
say('models', '{"value":"default"},{"value":"opus"}');

t('first and last pass on the same inputs agree', (preflight(), readFileSync(record, 'utf8')) === first, true);

// DS-649 AC4: a worker's preflight keeps the 1-hour prompt cache, even under a caller that set the 5-minute one.
rmSync(join(T, 'cache'), { force: true });
r = preflight({ ...off, FORCE_PROMPT_CACHING_5M: '1' });
t('DS-649 AC4 the preflight runs with FORCE_PROMPT_CACHING_5M unset', [ran(r), readFileSync(join(T, 'cache'), 'utf8').trim().split('\n')], [RAN, ['unset']]);

// A reply that ran no check, or missed only wanted-OK checks, is retried once; a boundary miss never is.
const ALL_BLOCKED = GOOD.replace(/=OK/g, '=BLOCKED');
const fresh = (first, extra = {}) => { rmSync(record, { force: true }); say('reply.first', first); return preflight(extra); };
r = fresh(result(ALL_BLOCKED, { num_turns: 1 }));
t('#731 a reply with no tool turn is retried', r.calls.length, 2);
t('#731 the retry is at default effort', [/--effort low( |$)/.test(r.calls[0]), /--effort/.test(r.calls[1] ?? '')], [true, false]);
t('#731 and its good answer passes', [r.status, r.passed, /FAIL/.test(r.out)], [0, true, false]);
t('#731 the cost line adds both calls', /^\[preflight\] cost=0\.2 turns=4$/m.test(r.out), true);
t('#731 the retry says why', /^\[preflight\] retry at default effort: the session ran no tool \(turns=1\)$/m.test(r.out), true);
r = fresh(result(''));
t('#731 an empty reply is retried and passes', [r.calls.length, r.status, r.passed], [2, 0, true]);
r = fresh(result(''), { AUTOPILOT_MODEL: 'opus' });
t('#731 with a worker model, an empty reply is retried, not read as a rejected model', [r.calls.length, r.status, r.passed], [2, 0, true]);
r = fresh(result('I will not', { num_turns: 1 }), { AUTOPILOT_MODEL: 'opus' });
t('#731 with a worker model, a reply with no tool turn is retried', [r.calls.length, r.status, r.passed], [2, 0, true]);
r = fresh(result(GOOD.replace('AGENTS=OK', 'AGENTS=BLOCKED')));
t('#731 a false BLOCKED on a wanted-OK check is retried and passes', [r.calls.length, r.status, r.passed], [2, 0, true]);
r = fresh(result(GOOD.replace('DENY=BLOCKED', 'DENY=OK')));
t('#731 a boundary failure is not retried', [r.calls.length, r.status, r.passed], [1, 1, false]);
say('reply.first', result(ALL_BLOCKED, { num_turns: 1 })); say('reply', result(ALL_BLOCKED, { num_turns: 1 })); rmSync(record, { force: true });
r = preflight();
t('#731 a second reply with no tool turn fails, once retried', [r.calls.length, r.status, /!! the session ran no tool \(turns=1\) on the retry either/.test(r.out)], [2, 1, true]);
say('reply', result(GOOD));
say('write-w-in', '');
r = fresh(result(GOOD.replace('W_IN=OK', 'W_IN=BLOCKED')));
t('#731 W_IN reads OK from the file in the worktree, whatever the reply says', [r.calls.length, r.status, existsSync(join(T, 'repo', '.preflight.tmp'))], [1, 0, false]);
rmSync(join(T, 'write-w-in'));

// DS-699: a pass on one ticket stands for another ticket in the repo with the same settings, for a day.
t('DS-699 a value is masked whole, never inside a longer word', maskText('a/DS-69/x DS-699 DS-69-b xDS-69', [['TICKET', 'DS-69']]), 'a/<TICKET>/x DS-699 <TICKET>-b xDS-69');
t('DS-699 the longest value is masked first', maskText('fix/DS-6-x DS-6', [['TICKET', 'DS-6'], ['BRANCH', 'fix/DS-6-x']]), '<BRANCH> <TICKET>');
// The first ticket is alone in the repo when it passes, so the second's settings deny a worktree its did not.
git('worktree', 'add', '-q', '-b', 'fix/one', join(T, 'wt-one'));
const passes = join(T, 'state', 'workers', 'preflight-passes.json');
const one = (extra = {}) => preflight({ AUTOPILOT_BRANCH: 'fix/one', ...extra }, join(T, 'wt-one'), 'ticket-one');
const two = (extra = {}) => preflight({ AUTOPILOT_BRANCH: 'fix/two', ...extra }, join(T, 'wt-two'), 'ticket-two');
r = one();
t('DS-699 the first ticket runs its preflight, and the repo records its pass', [ran(r), Object.values(JSON.parse(readFileSync(passes, 'utf8'))).map((p) => p.ticket).includes('ticket-one')], [RAN, true]);
git('worktree', 'add', '-q', '-b', 'fix/two', join(T, 'wt-two'));
r = two();
t('DS-699 AC1 a second ticket, different only in worktree, key and branch, makes no call', ran(r), SKIPPED);
t('DS-699 AC1 its spawn line names a cross-ticket skip and whose pass it took', /^\[preflight\] skipped: cross-ticket: ticket-one's pass at \S+ had this fingerprint$/m.test(r.out), true);
const lastRun = (key) => JSON.parse(readFileSync(join(T, 'state', 'workers', `${key}.runs.jsonl`), 'utf8').trim().split('\n').at(-1));
t('DS-699 AC1 its run record logs a cross-ticket skip', [lastRun('ticket-two').preflight, lastRun('ticket-two').cross_ticket], ['skipped', 'ticket-one']);
t('DS-699 a cross-ticket skip gives the ticket no record of its own', existsSync(join(T, 'state', 'workers', 'ticket-two.preflight.json')), false);
git('worktree', 'add', '-q', '-b', 'fix/three', join(T, 'wt-three'));
t('DS-699 another worktree coming changes nothing', ran(two()), SKIPPED);
t('DS-699 AC2 a settings change runs the preflight', ran(two({ DESK_CONFIG: ON_PUSH })), RAN);
const ON_DB = join(T, 'on-db.md');
writeFileSync(ON_DB, readFileSync(ON, 'utf8').replace('| Unit tests |', '| Local database | `postgres container pg1` |\n| Unit tests |'));
t('DS-699 per-ticket databases are masked too',
  [ran(one({ DESK_CONFIG: ON_DB, AUTOPILOT_DATABASE: 'widgets_one' })), ran(two({ DESK_CONFIG: ON_DB, AUTOPILOT_DATABASE: 'widgets_two' }))], [RAN, SKIPPED]);
t('DS-699 and the database name is in the settings it masks', readFileSync(join(T, 'state', 'workers', 'ticket-two.settings.json'), 'utf8').includes('psql -d widgets_two'), true);
const aged = JSON.parse(readFileSync(passes, 'utf8'));
for (const p of Object.values(aged)) p.at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
writeFileSync(passes, JSON.stringify(aged));
t('DS-699 a pass more than 24 hours old stands for no other ticket', ran(two()), RAN);
t('DS-699 and the run that replaces it is recorded as that ticket\'s, the stale passes dropped', Object.values(JSON.parse(readFileSync(passes, 'utf8'))).map((p) => p.ticket), ['ticket-two']);

// DS-1021: with the reread hook registered, the preflight session's own record proves the worker hooks
// loaded, and a sign-in the CLI could not make is named as one.
const hooksDir = join(T, 'home', '.claude', 'hooks');
mkdirSync(hooksDir, { recursive: true });
writeFileSync(join(hooksDir, 'desk-worker-reread.py'), '');
const READ_GOOD = result(`${GOOD}\nREAD=OK`, { session_id: 'sess-1' });
const rereadDir = join(T, 'deskhome', 'worker-reread', 'sess-1');
say('reply', READ_GOOD);
r = preflight(off);
t('DS-1021 AC1 a Read the reread hook did not record stops the spawn, unretried',
  [r.status, r.passed, r.calls.length, /HOOKS +FAIL +\(worker hooks did not load in the preflight: .*CLI 2\.0\.0 \(Claude Code\)\)/.test(r.out)], [1, false, 1, true]);
say('reply', result('Invalid API key · Please run /login', { is_error: true, num_turns: 1, session_id: 'sess-1' }));
r = preflight(off);
t('DS-1021 AC2 a sign-in failure stops the spawn, in the CLI\'s words, with no check verdict',
  [r.status, r.passed, /SIGNIN FAIL +\(the CLI could not sign in, so no check ran; claude said: Invalid API key · Please run \/login\)/.test(r.out), /W_IN|HOOKS|BLOCKED/.test(r.out)], [1, false, true, false]);
say('reply', 'Not logged in · Please run /login');
r = preflight(off);
t('DS-1021 AC2 a sign-in failure with no json result reads the same', [r.status, /SIGNIN FAIL .*Not logged in/.test(r.out)], [1, true]);
say('reply', READ_GOOD);
say('write-reread', '');
r = preflight(off);
t('DS-1021 AC3 a session the reread hook recorded spawns as now', [r.status, r.passed, /HOOKS +OK +ok/.test(r.out)], [0, true, true]);
r = preflight({ ...off, DESK_ALLOW_REREAD: '1' });
t('DS-1021 the reread opt-out in the environment does not read as hooks that did not load', [r.status, r.passed, /HOOKS +OK +ok/.test(r.out)], [0, true, true]);
t('DS-1021 the preflight session\'s records and its read file are tidied', [existsSync(rereadDir), existsSync(join(T, 'state', 'workers', `${KEY}.preflight-read.txt`))], [false, false]);
rmSync(join(T, 'write-reread'));
rmSync(join(hooksDir, 'desk-worker-reread.py'));
say('reply', result(GOOD));

// DS-1036: a model a lever drew that the CLI rejects is that lever's, so the preflight says drawn-only and
// records no step of the preflight lever (on here); the row's own models, and anything failing beside a
// drawn model, stay the preflight's.
const leverSteps = () => { const f = join(T, 'state', 'workers', `${KEY}.runs.jsonl`); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"lever_step"')).length : 0; };
const drawnRun = (extra, reply = GOOD) => {
  rmSync(record, { force: true }); rmSync(passes, { force: true }); say('reply', result(reply));
  const before = leverSteps();
  const p = preflight(extra);
  return { ...p, stepped: leverSteps() - before, drawnOnly: /^\[preflight\] drawn-only/m.test(p.out) };
};
say('reject-model', 'haiku');
r = drawnRun({ AUTOPILOT_FINDER_DRAWN: 'haiku' });
t('DS-1036 a drawn finder the CLI rejects fails as its lever\'s: drawn-only, no preflight step recorded', [r.status, /FINDER-DRAWN +FAIL/.test(r.out), r.drawnOnly, r.stepped], [1, true, true, 0]);
r = drawnRun({ AUTOPILOT_FINDER_MODEL: 'haiku' });
t('DS-1036 the row\'s finder rejected is the preflight\'s own step', [r.status, r.drawnOnly, r.stepped], [1, false, 1]);
r = drawnRun({ AUTOPILOT_FINDER_MODEL: 'haiku', AUTOPILOT_FINDER_DRAWN: 'opus' });
t('DS-1036 the row\'s finder is still proved beside a drawn one that passes, and its rejection stops the start', [r.status, /^ +FINDER +FAIL/m.test(r.out), r.drawnOnly], [1, true, false]);
r = drawnRun({ AUTOPILOT_FINDER_DRAWN: 'haiku' }, GOOD.replace('DENY=BLOCKED', 'DENY=OK'));
t('DS-1036 a drawn finder rejected beside a boundary failure is not drawn-only, and is the preflight\'s step', [r.status, r.drawnOnly, r.stepped], [1, false, 1]);
say('reject-model', 'opus');
r = drawnRun({ AUTOPILOT_MODEL: 'opus', AUTOPILOT_MODEL_DRAWN: '1' });
t('DS-1036 a drawn worker model the CLI rejects is drawn-only, with no preflight step', [r.status, /MODEL +FAIL/.test(r.out), r.drawnOnly, r.stepped], [1, true, true, 0]);
r = drawnRun({ AUTOPILOT_MODEL: 'opus' });
t('DS-1036 the row\'s worker model rejected is the preflight\'s own step', [r.status, r.drawnOnly, r.stepped], [1, false, 1]);
rmSync(join(T, 'reject-model'));
say('reply', result(GOOD));

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
