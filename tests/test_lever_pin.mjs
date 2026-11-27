// suite: lever pin (a ticket's levers are fixed at admission, and every worker for it runs with them)
// layer: L2
// covers: desk/bin/lever-pin.mjs desk/bin/desk-env.mjs desk/bin/queue.mjs desk/bin/spawn-worker.sh
// queue.mjs admit and add pin the row's levers; desk-env levers prints DESK_LEVERS over the row; and
// spawn-worker.sh exports a pinned ticket's set to its preflight, its spawn line and its worker, and
// leaves an unpinned one on the row. A stub claude on PATH answers the version, account and agent
// registry reads, and records each -p call's argv, DESK_LEVERS and DESK_LEVER_VALUES. Scratch HOME, queue and repo only.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pinAtAdmission, pinnedSet, envValue, leverOnFor, leverValueFor, pinDisagrees } from '../desk/bin/lever-pin.mjs';
import { levers } from '../desk/bin/desk-env.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(root, 'desk', 'bin');

// ---- the module -----------------------------------------------------------------------------------
t('no pin is null', pinnedSet({ key: 'A-1' }), null);
t('an empty pin is an empty set', pinnedSet({ key: 'A-1', levers: { set: [], at: 'x' } }), []);
t('a pin is its set', pinnedSet({ key: 'A-1', levers: { set: ['preflight'], arms: null, at: 'x' } }), ['preflight']);
let threw = '';
try { pinnedSet({ key: 'A-1', levers: { set: 'preflight' } }); } catch (e) { threw = e.message; }
t('a mangled pin throws naming the ticket', /^A-1's levers pin is not/.test(threw), true);
t('an empty set goes to DESK_LEVERS as none', envValue([]), 'none');
t('a set goes to DESK_LEVERS space-separated', envValue(['memory', 'preflight']), 'memory preflight');
t('a valued lever\'s value for a ticket is its pin\'s', leverValueFor('memory', { key: 'A-1', levers: { set: [], values: { memory: 'mixed' }, at: 'x' } }), 'mixed');
t('a pin naming no value for it reads as off, not its baseline', [leverValueFor('memory', { key: 'A-1', levers: { set: [], at: 'x' } }), leverValueFor('memory', { key: 'A-1' })], [null, null]);
const now = new Date('2026-11-14T10:00:00Z');
t('the admission pin is the row\'s set and the time', pinAtAdmission({ on: ['preflight'], unknown: ['turbo'] }, now), { set: ['preflight'], at: '2026-11-14T10:00:00.000Z' });
t('levers() reads DESK_LEVERS before the row', levers({ DESK_LEVERS: 'Memory, preflight' }).on, ['memory', 'preflight']);
t('levers() reads DESK_LEVERS=none as every lever off', levers({ DESK_LEVERS: 'none' }), { on: [], unknown: [] });

// The supervisor reads a lever per ticket, from its pin, and from the row only with no pin.
const row = { on: ['review-reuse', 'failure-class'], unknown: [] };
t('DS-639 a ticket pinned with the lever reads it on', leverOnFor('review-reuse', { key: 'A-1', levers: { set: ['review-reuse'] } }, { on: [], unknown: [] }), true);
t('DS-639 a ticket pinned without it reads it off whatever the row', leverOnFor('review-reuse', { key: 'A-2', levers: { set: [] } }, row), false);
t('DS-639 a ticket with no pin reads the row', leverOnFor('failure-class', { key: 'A-3' }, row), true);
t('DS-639 no ticket at all reads the row', leverOnFor('failure-class', null, row), true);
threw = '';
try { leverOnFor('review-reuse', { key: 'A-4', levers: ['review-reuse'] }, row); } catch (e) { threw = e.message; }
t('DS-639 a mangled pin throws rather than reading the row', /^A-4's levers pin is not/.test(threw), true);
t('DS-639 a start with the pin\'s set, in any order, agrees', pinDisagrees(['memory', 'preflight'], ['preflight', 'memory']), false);
t('DS-639 a start with a lever the pin lacks disagrees', pinDisagrees(['memory'], ['memory', 'codex']), true);
t('DS-639 a start missing a pinned lever disagrees', pinDisagrees(['memory', 'codex'], ['memory']), true);
t('DS-639 no pin, or no recorded levers, never disagrees', [pinDisagrees(null, ['memory']), pinDisagrees(['memory'], null)], [false, false]);

// ---- scratch repo, config, queue and stub claude --------------------------------------------------
const T = scratch('desk-pin-');
for (const d of ['home', 'state', 'stub', 'repo', 'deskhome']) mkdirSync(join(T, d), { recursive: true });
cpSync(join(root, 'agents'), join(T, 'home', '.claude', 'agents'), { recursive: true });
symlinkSync(BIN, join(T, 'deskhome', 'bin'));
writeFileSync(join(T, 'deskhome', 'installed.json'), JSON.stringify({ commit: 'c1', dirty: false, at: '2026-11-07T00:00:00Z' }));
const git = (...a) => spawnSync('git', ['-C', join(T, 'repo'), ...a], { env: { ...process.env, HOME: join(T, 'home'), GIT_CONFIG_NOSYSTEM: '1' } });
git('init', '-q', '-b', 'main'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');

const config = (name, row) => {
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
| Phase 0 levers | \`none\` | ${row} |

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
const PRE = config('pre', '`preflight`');
const BOTH = config('both', '`preflight memory`');

const QUEUE = join(T, 'queue.json');
const STATE = join(T, 'state');
const SID = '11111111-2222-4333-8444-555555555555';
const stub = join(T, 'stub', 'claude');
writeFileSync(stub, `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo '2.0.0 (Claude Code)'; exit 0; fi
if [ "$1 $2" = "auth status" ]; then echo '{"loggedIn":true,"email":"a@example.com"}'; exit 0; fi
if [ "$1" = agents ]; then echo '[{"sessionId":"${SID}","pid":4242}]'; exit 0; fi
printf '%s\\n' "\${DESK_LEVERS-unset}" >> "${T}/levers-env"
printf '%s\\n' "\${DESK_LEVER_VALUES-unset}" >> "${T}/values-env"
printf '%s' "$*" | tr '\\n' ' ' >> "${T}/calls"
echo >> "${T}/calls"
echo '{"type":"result","result":"W_IN=OK\\nW_OUT=BLOCKED\\nTOOL1=OK\\nAGENTS=OK\\nDENY=BLOCKED\\nDENY2=BLOCKED\\nESCAPE=BLOCKED\\nCODEX=BLOCKED","total_cost_usd":0.1,"num_turns":3}'
`);
chmodSync(stub, 0o755);

const env = (extra = {}) => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete e[k];
  return { ...e, HOME: join(T, 'home'), GIT_CONFIG_NOSYSTEM: '1', PATH: `${join(T, 'stub')}:${process.env.PATH}`,
    DESK_CONFIG: PRE, DESK_HOME: join(T, 'deskhome'), DESK_STATE: STATE, DESK_AUTOPILOT_STATE: STATE,
    DESK_QUEUE: QUEUE, DESK_SKILLS_DIR: join(root, 'skills'), DESK_REPO_OVERRIDE: 'acme/widgets', DESK_MACHINE: join(T, 'none.md'),
    AUTOPILOT_PORT: '3999', ...extra };
};
const node = (args, extra) => spawnSync('node', args, { cwd: join(T, 'repo'), env: env(extra), encoding: 'utf8' });
const queue = () => JSON.parse(readFileSync(QUEUE, 'utf8'));
const seed = (tickets) => writeFileSync(QUEUE, JSON.stringify({ version: 1, batch: 'b', concurrency: 1, tickets }));

// ---- AC1: admission pins the row ------------------------------------------------------------------
seed({});
mkdirSync(join(STATE, 'triage'), { recursive: true });
for (const k of ['P-1', 'P-2']) {
  writeFileSync(join(STATE, 'triage', `${k}.json`), JSON.stringify({ ticket: k, type: 'Story', lane: 'A', size: 'S', files_in_scope: [`src/${k}.js`], unknowns: [], blockers: [] }));
}
let r = node([join(BIN, 'queue.mjs'), 'admit', 'P-1', '--by', 'intake']);
t('AC1 admit succeeds', r.status, 0);
const pin1 = queue().tickets['P-1']?.levers;
t('AC1 an admitted ticket is pinned with the row\'s set', pin1?.set, ['preflight']);
t('AC1 with the time it was pinned', !Number.isNaN(Date.parse(pin1?.at)), true);
r = node([join(BIN, 'queue.mjs'), 'admit', 'P-2'], { DESK_LEVERS: 'memory' });
t('AC1 the pin is the row, not the admitting process\'s own levers', queue().tickets['P-2']?.levers?.set, ['preflight']);
r = node([join(BIN, 'queue.mjs'), 'add', 'P-3', 'Story', 'A']);
t('AC1 a ticket plan-batch adds is pinned too', queue().tickets['P-3']?.levers?.set, ['preflight']);

// ---- AC4: desk-env levers prints the pin ----------------------------------------------------------
const deskEnv = (args, extra) => node([join(BIN, 'desk-env.mjs'), 'levers', ...args], { DESK_CONFIG: BOTH, ...extra }).stdout.trim().split('\n')[0];
t('AC4 with no pin it prints the row', deskEnv([]), 'on: preflight memory');
t('AC4 a pinned worker prints its pin, not the row', deskEnv([], { DESK_LEVERS: 'preflight' }), 'on: preflight');
t('AC4 and a lever the row has but the pin does not is off', deskEnv(['memory'], { DESK_LEVERS: 'preflight' }), 'off');
t('AC4 an empty pin prints none', deskEnv([], { DESK_LEVERS: 'none' }), 'on: none');

// ---- spawn-worker.sh ------------------------------------------------------------------------------
const KEY = 'pin-thing';
const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8').trim().split('\n') : []);
// Whether the stub has finished writing a call: its last write is the newline that closes the line.
const callWritten = () => existsSync(join(T, 'calls')) && readFileSync(join(T, 'calls'), 'utf8').endsWith('\n');
const seen = () => (existsSync(join(T, 'levers-env')) ? readFileSync(join(T, 'levers-env'), 'utf8').trim().split('\n') : []);
const reset = () => { for (const f of ['calls', 'levers-env', 'values-env']) rmSync(join(T, f), { force: true }); rmSync(join(STATE, 'workers', `${KEY}.preflight.json`), { force: true }); };
const pinned = (set, values) => seed({ [KEY]: { key: KEY, state: 'running', ...(set ? { levers: { set, ...(values ? { values } : {}), at: '2026-11-14T00:00:00.000Z' } } : {}) } });
const valuesSeen = () => (existsSync(join(T, 'values-env')) ? readFileSync(join(T, 'values-env'), 'utf8').trim().split('\n') : []);
const spawn = (sid, extra = {}) => spawnSync('bash', [join(BIN, 'spawn-worker.sh'), KEY, join(T, 'repo'), sid], { cwd: join(T, 'repo'), env: env(extra), encoding: 'utf8', timeout: 60000 });
const preflight = (extra) => { reset(); const x = spawn('preflight', { AUTOPILOT_PREFLIGHT: '1', ...extra }); return { status: x.status, call: calls()[0] ?? '', levers: seen()[0], values: valuesSeen()[0], out: x.stdout + x.stderr }; };

// A valued lever's value reaches the worker, and desk-env there returns it.
pinned(['preflight'], { memory: 'batched' });
let v = preflight({ DESK_LEVER_VALUES: 'memory=stale' });
t('a pin with values: the worker carries them as DESK_LEVER_VALUES', [v.status, v.values], [0, 'memory=batched']);
t('desk-env levers <lever> in that worker prints its value', deskEnv(['memory'], { DESK_LEVERS: 'preflight', DESK_LEVER_VALUES: v.values }), 'batched');
pinned(['preflight']);
v = preflight({ DESK_LEVER_VALUES: 'memory=stale' });
t('a pin with no values: the worker carries none, whatever its caller had', [v.status, v.values], [0, 'unset']);
pinned(null);
v = preflight({ DESK_LEVER_VALUES: 'memory=stale' });
t('no pin: the worker carries no values', v.values, 'unset');
seed({ [KEY]: { key: KEY, state: 'running', levers: { set: [], values: ['memory'], at: '2026-11-14T00:00:00.000Z' } } });
v = preflight();
t('values that cannot be read refuse the spawn', [v.status, /levers pin values could not be read/.test(v.out)], [1, true]);
// `lever-pin.mjs values`: the pin's values as DESK_LEVER_VALUES takes them; desk-env reads its lever's.
const pinValues = (tickets, key = KEY) => { seed(tickets); const x = node([join(BIN, 'lever-pin.mjs'), 'values', key]); return [x.status, x.stdout.trim()]; };
t('values: each valued lever as lever=value, space-separated', pinValues({ [KEY]: { key: KEY, levers: { set: [], values: { memory: 'batched', wrappers: 'mixed' } } } }), [0, 'memory=batched wrappers=mixed']);
t('values: a pin with none prints an empty line', pinValues({ [KEY]: { key: KEY, levers: { set: ['memory'] } } }), [0, '']);
t('values: no pin exits 3', pinValues({ [KEY]: { key: KEY } })[0], 3);
t('values: a value DESK_LEVER_VALUES cannot carry exits 1', pinValues({ [KEY]: { key: KEY, levers: { set: [], values: { memory: 'a b' } } } })[0], 1);
t('values: a blind audit carries none', pinValues({}, `audit.${KEY}`), [0, '']);
t('desk-env levers <lever> is on or off for a lever DESK_LEVER_VALUES does not carry', deskEnv(['preflight'], { DESK_LEVERS: 'preflight', DESK_LEVER_VALUES: 'memory=batched' }), 'on');

// AC3: an empty pin runs the preflight as with the lever off, though the row has it on.
pinned([]);
let p = preflight();
t('AC3 an empty pin: the preflight passes', p.status, 0);
t('AC3 an empty pin: no --effort, as with the lever off', p.call.includes('--effort'), false);
t('AC3 an empty pin: no fingerprint is recorded', existsSync(join(STATE, 'workers', `${KEY}.preflight.json`)), false);
t('AC3 the preflight call carries the empty pin', p.levers, 'none');
// AC6: no pin reads the row, even under a caller that exported DESK_LEVERS.
pinned(null);
p = preflight({ DESK_LEVERS: 'none' });
t('AC6 no pin: the row\'s preflight lever is on (low effort)', [p.status, /--effort low( |$)/.test(p.call)], [0, true]);
t('AC6 no pin: the worker gets no DESK_LEVERS', p.levers, 'unset');
pinned(['preflight']);
p = preflight({ DESK_CONFIG: config('off', '`none`') });
t('a pin with the lever on wins over a row with it off', [p.status, /--effort low( |$)/.test(p.call)], [0, true]);
writeFileSync(QUEUE, '{ torn');
p = preflight();
t('a queue that cannot be read refuses the spawn', [p.status, /levers pin could not be read/.test(p.out)], [1, true]);

// AC2 and AC5: a fix try and a review try spawned after the row changed record the pin, and the
// worker runs with it. Each is a detached session, so its -p call is waited for.
const memDir = node([join(BIN, 'desk-env.mjs'), 'paths']).stdout.match(/^DESK_MEMORY_DIR='(.*)'$/m)?.[1];
if (memDir) mkdirSync(memDir, { recursive: true });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const runs = join(STATE, 'workers', `${KEY}.runs.jsonl`);
const start = (task) => {
  reset();
  rmSync(runs, { force: true });
  const x = spawn(SID, { DESK_CONFIG: BOTH, AUTOPILOT_TASK: task, AUTOPILOT_BRANCH: `feat/${KEY}` });
  // The stub writes levers-env before calls, and writes its call in pieces (printf | tr, then the
  // closing newline): wait for both, and for that newline, or a slow runner reads an empty or a
  // part-written call.
  for (let i = 0; i < 100 && !(seen().length && callWritten()); i++) sleep(100);
  const line = existsSync(runs) ? JSON.parse(readFileSync(runs, 'utf8').trim().split('\n').pop()) : null;
  return { status: x.status, out: x.stdout + x.stderr, levers: line?.levers, env: seen()[0], call: calls()[0] ?? '' };
};
for (const [ac, task] of [['AC2 a fix try', 'Fix the failing check on $TICKET.'], ['AC5 a review try', 'Answer the review on $TICKET.']]) {
  pinned(['preflight']);
  const s = start(task);
  t(`${ac} spawns`, [s.status, new RegExp(`^\\[spawn\\] ticket=${KEY} pid=4242`, 'm').test(s.out)], [0, true]);
  t(`${ac}: its spawn line records the pin alone`, s.levers, ['preflight']);
  t(`${ac}: its worker runs with the pin`, s.env, 'preflight');
  t(`${ac}: its worker keeps auto-memory, as with the memory lever off`, memDir ? s.call.includes(`--add-dir ${memDir}`) : 'no memory dir', true);
}
pinned(null);
const u = start('Fix the failing check on $TICKET.');
t('AC6 an unpinned ticket\'s spawn line records the row', u.levers, ['preflight', 'memory']);
t('AC6 an unpinned ticket\'s worker has no DESK_LEVERS', u.env, 'unset');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
