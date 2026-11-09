// suite: preflight skip (with the lever on, a preflight is skipped on a passed fingerprint and otherwise runs at low effort)
// covers: desk/bin/preflight-fingerprint.mjs desk/bin/spawn-worker.sh desk/bin/preflight-record.mjs
// A stub claude on PATH answers the version and account reads from files, and each -p call as the
// $T/reply file says, recording its argv. A scratch desk home links the real desk/bin beside its own
// installed.json. Scratch HOME and repo only.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const T = mkdtempSync(join(tmpdir(), 'desk-pre-'));
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
const stub = join(T, 'stub', 'claude');
writeFileSync(stub, `#!/usr/bin/env bash
if [ "$1" = --version ]; then cat "${T}/version"; exit 0; fi
if [ "$1 $2" = "auth status" ]; then cat "${T}/account"; exit 0; fi
printf '%s' "$*" | tr '\\n' ' ' >> "${T}/calls"
echo >> "${T}/calls"
cat "${T}/reply"
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
const preflight = (extra = {}, wt = join(T, 'repo')) => {
  rmSync(join(T, 'calls'), { force: true });
  const r = spawnSync('bash', [join(root, 'desk/bin/spawn-worker.sh'), KEY, wt, 'preflight'], { cwd: join(T, 'repo'), env: env(extra), encoding: 'utf8', timeout: 60000 });
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

// AC2: each input, changed alone, runs the preflight. It is put back, and the pass that makes is then
// the one to match, so each case starts from a clean skip.
const whenChanged = (name, change, undo, extra = {}) => {
  change();
  const c = preflight(extra);
  t(`AC2 a changed ${name} runs the preflight`, ran(c), RAN);
  t(`AC2 a changed ${name} is at low effort`, /--effort low( |$)/.test(c.calls[0] ?? ''), true);
  undo();
  preflight();
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
r = preflight({}, join(T, 'repo2'));
t('AC2 a changed worktree runs the preflight', ran(r), RAN);
preflight();

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
preflight(off);
t('AC4 lever off: nothing is recorded', existsSync(record), false);
const noEffortFinder = preflight({ ...off, AUTOPILOT_FINDER_MODEL: 'opus' });
t('AC4 lever off: the finder check has no --effort', [noEffortFinder.calls.length, noEffortFinder.calls.some((c) => c.includes('--effort'))], [2, false]);
const finder = preflight({ AUTOPILOT_FINDER_MODEL: 'opus' });
t('lever on: the finder check runs at low effort too', [finder.calls.length, finder.calls.every((c) => /--effort low( |$)/.test(c))], [2, true]);

t('first and last pass on the same inputs agree', (preflight(), readFileSync(record, 'utf8')) === first, true);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
