// suite: push-retry (a worker's push, retried while GitHub answers with a 5xx)
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClearsWhen } from '../desk/bin/clears-when.mjs';
import { TRANSIENT_EXIT, hookEnvFailure, parseArgs, pushWithRetry, refusalLine, transientPush, unreachedPush } from '../desk/bin/push-retry.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const REJECTED_500 = ' ! [remote rejected] fix/A-1 -> fix/A-1 (Internal Server Error)\nerror: failed to push some refs to \'github.com:acme/widgets.git\'';
for (const [name, out] of [
  ['the refusal VPL-630 hit', REJECTED_500],
  ['a remote rejected with a status', ' ! [remote rejected] b -> b (HTTP 503)'],
  ['a 502 over HTTPS', "fatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: 502"],
  ['an RPC failure', 'error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500'],
  ['the remote saying so', 'remote: Internal Server Error\nfatal: the remote end hung up unexpectedly'],
  ['a remote gateway timeout', 'remote: 504 Gateway Timeout'],
]) t(`AC1 a 5xx: ${name}`, transientPush(out), true);
for (const [name, out] of [
  ['a non-fast-forward', ' ! [rejected] b -> b (non-fast-forward)\nerror: failed to push some refs'],
  ['a fetch-first refusal', ' ! [rejected] b -> b (fetch first)'],
  ['a branch rule', ' ! [remote rejected] b -> b (protected branch hook declined)'],
  ['a pre-receive hook', ' ! [remote rejected] b -> b (pre-receive hook declined)'],
  ['a status that is not a 5xx', "fatal: unable to access 'x': The requested URL returned error: 403"],
  ['a failed pre-push check quoting a 5xx', `pre-push: FAIL  bash tests/run.sh (3s, exit 1)\n${REJECTED_500}\npre-push: push stopped.`],
  ['a check\'s own output', 'expected 200, got 500 Internal Server Error\nerror: failed to push some refs'],
  ['nothing', ''],
]) t(`AC3 not a 5xx: ${name}`, transientPush(out), false);

t('the plain push', parseArgs(['origin', 'fix/A-1']), { more: false, push: ['push', 'origin', 'fix/A-1'] });
t('--more and a flag', parseArgs(['--more', '-u', 'origin', 'fix/A-1']), { more: true, push: ['push', '-u', 'origin', 'fix/A-1'] });
t('a lease push', parseArgs(['--force-with-lease', 'origin', 'fix/A-1']).push, ['push', '--force-with-lease', 'origin', 'fix/A-1']);
for (const a of [[], ['origin'], ['--force', 'origin', 'b'], ['upstream', 'b'], ['origin', '+b'], ['origin', '--delete'], ['origin', 'a', 'b']]) t(`refused: ${a.join(' ') || 'nothing'}`, parseArgs(a), null);

const TRACKED = 'a'.repeat(40);
const PIN = `--force-with-lease=b:${'c'.repeat(40)}`;
t('a one-off lease', parseArgs([PIN, 'origin', 'b']).push, ['push', PIN, 'origin', 'b']);
t('refused: a lease naming another branch', parseArgs([PIN, 'origin', 'other']), null);
t('refused: a lease with no full SHA', parseArgs(['--force-with-lease=b:abc', 'origin', 'b']), null);
for (const [name, out, want] of [
  ['no DNS', "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com", true],
  ['an ssh timeout', 'ssh: connect to host github.com port 22: Operation timed out\nfatal: Could not read from remote repository.', true],
  ['a hung-up remote', 'fatal: the remote end hung up unexpectedly', true],
  ['a 403 is an answer', "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403", false],
  ['a non-fast-forward is an answer', ' ! [rejected] b -> b (non-fast-forward)\nerror: failed to push some refs', false],
  ['a revoked SSH key is an answer', 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.', false],
  ['a lost repo is an answer', 'ERROR: Repository not found.\nfatal: Could not read from remote repository.', false],
  ['a 413 is an answer', 'error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413\nfatal: the remote end hung up unexpectedly', false],
  ['a failed pre-push check printing fatal:', 'pre-push: FAIL  bash tests/run.sh (3s, exit 1)\nfatal: the remote end hung up unexpectedly', false],
]) t(`unreached: ${name}`, unreachedPush(out), want);

// A stubbed git answering from `answers`, its last repeating, on a clock only sleep and `took` move.
async function run(args, answers, took = 0) {
  let clock = 0;
  const calls = []; const slept = []; const said = [];
  const git = (a) => {
    if (a[0] === 'rev-parse') return { status: 0, out: `${TRACKED}\n` };
    calls.push(a.join(' ')); clock += took * 1000; return answers[Math.min(calls.length - 1, answers.length - 1)];
  };
  const sleep = async (ms) => { slept.push(ms / 1000); clock += ms; };
  const code = await pushWithRetry(parseArgs(args), { git, sleep, now: () => clock, say: (l) => said.push(l) });
  return { code, calls, slept, said, secs: clock / 1000 };
}
const OK = { status: 0, out: '' };
const E5 = { status: 1, out: REJECTED_500 };
const NFF = { status: 1, out: ' ! [rejected] b -> b (non-fast-forward)' };

let r = await run(['origin', 'b'], [OK]);
t('pushed first time: one push, no wait', [r.code, r.calls.length, r.slept], [0, 1, []]);

// The preview-build slot: taken before the push without waiting; given back when the push fails, and
// renewed for its build when it goes through.
const slotted = async (answers, taken, args = ['origin', 'b']) => {
  const log = []; const said = []; const calls = [];
  const slot = { take: () => { log.push('take'); return taken; }, give: (id) => { log.push(`give ${id}`); }, keep: (id) => { log.push(`keep ${id}`); } };
  const git = (a) => { calls.push(a.join(' ')); return answers.shift(); };
  const code = await pushWithRetry(parseArgs(args), { git, sleep: async () => {}, now: () => 0, say: (l) => said.push(l), slot });
  return { code, log, said, calls };
};
let sl = await slotted([OK], { id: 'L-1' });
t('a push takes the preview-build slot first and, once it pushes, renews it for the build', [sl.code, sl.log], [0, ['take', 'keep L-1']]);
sl = await slotted([NFF], { id: 'L-2' });
t('a push git refuses gives the slot back: it started no build', [sl.code, sl.log], [1, ['take', 'give L-2']]);
sl = await slotted([OK], { busy: 'held by #7' });
t('a slot another build holds: exit 76, nothing pushed, naming the wait and then this same push',
  [sl.code, sl.calls, /desk-env preview-slot --wait 540 'a push of b'/.test(sl.said[0]) && /then run this same push again: node \S+ origin b\./.test(sl.said[0])], [76, [], true]);
sl = await slotted([OK], { why: 'the preview-build slot was not taken (store unreadable)' });
t('a slot that could not be read: the push goes ahead anyway, saying so', [sl.code, sl.said], [0, ['push-retry: the preview-build slot was not taken (store unreadable): pushing anyway']]);
r = await run(['origin', 'b'], [E5, E5, OK]);
t('AC1 a 5xx then a success: retried with growing waits, exit 0', [r.code, r.slept], [0, [30, 60]]);
r = await run(['origin', 'b'], [E5]);
t('AC1 a run stops inside the ten-minute Bash limit, on exit 75', [r.code, r.slept, r.secs < 600], [TRANSIENT_EXIT, [30, 60, 120, 240], true]);
t('AC1 and says to run --more', /Run this next.*--more origin b$/.test(r.said.at(-1)), true);
const first = r;
r = await run(['--more', 'origin', 'b'], [E5]);
t('AC1 --more waits longer, and the two runs pass ten minutes', [r.code, r.slept, first.secs + r.secs >= 600], [TRANSIENT_EXIT, [240, 240], true]);
t('AC1 then it says what clears the park', /AUTOPILOT_PARK_CLEARS_WHEN: git push origin b succeeds$/.test(r.said.at(-1)), true);
r = await run(['--more', '-u', 'origin', 'b'], [E5]);
t('the park line drops -u', /git push origin b succeeds$/.test(r.said.at(-1)), true);
r = await run(['--more', '--force-with-lease', 'origin', 'b'], [E5]);
const parkLine = (run) => run.said.at(-1).split('AUTOPILOT_PARK_CLEARS_WHEN: ')[1];
t('a lease park pins what origin held, as the parser reads it', parseClearsWhen(parkLine(r)).cond, { kind: 'push-ok', branch: 'b', lease: TRACKED });
r = await run(['--more', PIN, 'origin', 'b'], [E5]);
t('a one-off lease park keeps its own SHA', parseClearsWhen(parkLine(r)).cond, { kind: 'push-ok', branch: 'b', lease: 'c'.repeat(40) });
r = await run(['origin', 'b'], [E5], 200);
t('AC1 a slow push ends inside the ten minutes', [r.code, r.secs < 600], [TRANSIENT_EXIT, true]);
const slowFirst = r;
r = await run(['--more', 'origin', 'b'], [E5], 200);
t('AC1 --more with a slow push ends inside them too', [r.code, r.secs < 600], [TRANSIENT_EXIT, true]);
t('AC1 and a slow push needs both runs to pass ten minutes', [slowFirst.secs < 600, slowFirst.secs + r.secs >= 600], [true, true]);
// The hooks the fixed waits fell short with (170s, 280s) and the edges round them, a try in the two
// runs taking different times too. The last try is what counts, so a --more run may not end on a wait.
const SLOW = [1, 30, 100, 165, 166, 170, 200, 270, 271, 280, 285, 286, 290, 299, 300, 400, 560];
const short = [];
for (const a of SLOW) {
  const one = await run(['origin', 'b'], [E5], a);
  for (const b of SLOW) {
    const two = await run(['--more', 'origin', 'b'], [E5], b);
    if (one.code !== TRANSIENT_EXIT || two.code !== TRANSIENT_EXIT || one.secs >= 600 || two.secs >= 600
      || one.secs + two.secs < 600 || two.slept.length !== two.calls.length - 1) short.push([a, b, one.secs, two.secs]);
  }
}
t('AC1 whatever a try takes, each run stays inside ten minutes, and the last try ends past them', short, []);
r = await run(['origin', 'b'], [E5], 170);
t('AC1 a run cut short says why it waits, and for how long', [r.slept, r.said.some((l) => /would not fit this run: waiting 200s/.test(l)), /in 570s\. Run this next/.test(r.said.at(-1))], [[30, 200], true, true]);
r = await run(['origin', 'b'], [E5], 580);
t('AC1 a try past the limit adds no wait', [r.code, r.slept], [TRANSIENT_EXIT, []]);
r = await run(['--more', 'origin', 'b'], [E5], 280);
t('AC1 a --more run cut short parks at once', [r.slept, /AUTOPILOT_PARK_CLEARS_WHEN/.test(r.said.at(-1))], [[], true]);
r = await run(['origin', 'b'], [NFF]);
t('AC3 a non-fast-forward: one try, no wait, git\'s exit', [r.code, r.calls.length, r.slept], [1, 1, []]);
r = await run(['origin', 'b'], [{ status: 128, out: 'fatal: could not read Username' }]);
t('AC3 git\'s own exit code is kept', r.code, 128);
r = await run(['origin', 'b'], [E5, NFF]);
t('AC3 a refusal after a 5xx stops there', [r.code, r.calls.length], [1, 2]);

// A hook that could not run its checks is an environment failure, never a failing check.
const VPL861 = [
  'pre-push: FAIL  pnpm format:check (1s, exit 1)',
  '> voicepa@ format:check /Users/x/voicepa-worktrees/base-feat-VPL-861-demo-caller-voices',
  '> turbo run format:check',
  '',
  ' WARN   Local package.json exists, but node_modules missing, did you mean to install?',
  'sh: turbo: command not found',
  ' ELIFECYCLE  Command failed.',
  'pre-push: push stopped. Fix it and push again, or push with --no-verify (CI still runs every check).',
  'error: failed to push some refs to \'github.com:acme/voicepa.git\'',
].join('\n');
const FORMAT = 'pre-push: ok    pnpm lint (4s)\npre-push: FAIL  pnpm format:check (2s, exit 1)\n[warn] src/a.ts\n[warn] Code style issues found in the above file. Run Prettier with --write to fix.\npre-push: push stopped.';
for (const [name, out, want] of [
  ['DS-803 AC2 the VPL-861 hook output names the missing tool', VPL861, '`turbo` (command not found)'],
  ['dash names it its own way', 'pre-push: FAIL  npm run lint (0s, exit 127)\nsh: 1: eslint: not found', '`eslint` (command not found)'],
  ['bash with a line number', 'pre-push: FAIL  make check (0s, exit 127)\nbash: line 1: ruff: command not found', '`ruff` (command not found)'],
  ['zsh puts the name last', 'pre-push: FAIL  just check (0s, exit 127)\nzsh: command not found: just', '`just` (command not found)'],
  ['packages missing, and a package could not be loaded', 'pre-push: FAIL  pnpm test (1s, exit 1)\n WARN  Local package.json exists, but node_modules missing, did you mean to install?\nError: Cannot find module \'vitest\'', '`node_modules` (packages not installed)'],
  ['or so says an ES module import', 'pre-push: FAIL  pnpm check (1s, exit 1)\n WARN  Local package.json exists, but node_modules missing, did you mean to install?\nError [ERR_MODULE_NOT_FOUND]: Cannot find package \'zod\' imported from /x/src/a.mjs', '`node_modules` (packages not installed)'],
  ['a local file the code could not load is a failing check', 'pre-push: FAIL  pnpm test (1s, exit 1)\n WARN  Local package.json exists, but node_modules missing, did you mean to install?\nError [ERR_MODULE_NOT_FOUND]: Cannot find module \'/x/src/gone.mjs\' imported from /x/src/a.mjs\nError: Cannot find module \'./gone\'', null],
  ['packages missing beside a check that ran and failed is a failing check', 'pre-push: FAIL  pnpm format:check (1s, exit 1)\n WARN  Local package.json exists, but node_modules missing, did you mean to install?\n[warn] b.txt\n[warn] Code style issues found in the above file.', null],
  ['DS-803 AC3 a real formatting failure is not one', FORMAT, null],
  ['nor is a refusal with no hook in it', 'sh: turbo: command not found\n ! [remote rejected] b -> b (pre-receive hook declined)', null],
  ['DS-808 AC3 Prisma\'s missing env var names the variable', 'pre-push: FAIL  bun run db:generate (1s, exit 1)\nFailed to load config file "/x/prisma.config.ts" as a TypeScript/JavaScript module. Error: PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.', '`DATABASE_URL` (environment variable not set)'],
  ['and its older wording', 'pre-push: FAIL  pnpm prisma validate (1s, exit 1)\nerror: Environment variable not found: DATABASE_URL.', '`DATABASE_URL` (environment variable not set)'],
  ['and its wording for a blanked one, as a base worktree\'s database variable is', 'pre-push: FAIL  pnpm prisma validate (1s, exit 1)\nError validating datasource `db`: You must provide a nonempty URL. The environment variable `DATABASE_URL` resolved to an empty string.', '`DATABASE_URL` (environment variable not set)'],
  ['and a shell\'s set -u','pre-push: FAIL  sh check.sh (0s, exit 1)\ncheck.sh: line 3: API_KEY: unbound variable', '`API_KEY` (environment variable not set)'],
  ['and dash\'s wording of it', 'pre-push: FAIL  sh check.sh (0s, exit 2)\ncheck.sh: 3: API_KEY: parameter not set', '`API_KEY` (environment variable not set)'],
]) t(name, hookEnvFailure(out), want);
t('DS-808 AC3 a missing env var is quoted as an environment failure naming it',
  refusalLine('pre-push: FAIL  bun run db:generate (1s, exit 1)\nPrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.').startsWith('the pre-push hook could not run its checks here: `DATABASE_URL` (environment variable not set), an environment failure, not a failing check'), true);
// Compared, not printed: tests/run.sh fails a suite on any output line holding the hook's word for a failed check.
t('DS-803 AC2 it is quoted as an environment failure, not a formatting one',
  refusalLine(VPL861) === 'the pre-push hook could not run its checks here: `turbo` (command not found), an environment failure, not a failing check (pre-push: FAIL  pnpm format:check (1s, exit 1))', true);
t('DS-803 AC3 a real failure is quoted by the hook\'s line for it, not the ok line before it', refusalLine(FORMAT) === 'pre-push: FAIL  pnpm format:check (2s, exit 1)', true);
t('a refusal with no hook is quoted by git\'s first line', refusalLine('To github.com:a/b.git\n ! [remote rejected] b -> b (GH006)\nerror: failed'), '! [remote rejected] b -> b (GH006)');
r = await run(['origin', 'b'], [{ status: 1, out: VPL861 }]);
t('DS-803 AC2 a worker\'s push says so, unretried', [r.code, r.calls.length, r.said.length === 1 && r.said[0].includes('an environment failure, not a failing check')], [1, 1, true]);
r = await run(['origin', 'b'], [{ status: 1, out: FORMAT }]);
t('and says nothing over a real failing check', r.said, []);

// The CLI, against a stub git that prints $STUB_OUT and exits $STUB_RC.
const dir = scratch('push-retry-');
const log = join(dir, 'calls');
writeFileSync(join(dir, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nprintf '%s\\n' "$STUB_OUT" >&2\nexit "$STUB_RC"\n`);
chmodSync(join(dir, 'git'), 0o755);
const bin = join(dirname(fileURLToPath(import.meta.url)), '../desk/bin/push-retry.mjs');
const cli = (args, env) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env } });
// The pushes the stub ran: desk-env's own reads of the repo (for the preview slot) are not pushes.
const pushes = () => readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('push'));
let c = cli(['-u', 'origin', 'fix/A-1'], { STUB_OUT: 'pushed', STUB_RC: '0' });
t('the CLI runs that push and passes on what git said', [c.status, pushes().join('\n'), c.stderr.includes('pushed')], [0, 'push -u origin fix/A-1', true]);
c = cli(['origin', 'fix/A-1'], { STUB_OUT: ' ! [rejected] b -> b (non-fast-forward)', STUB_RC: '1' });
t('AC3 the CLI exits with git\'s refusal, unretried', [c.status, pushes().length], [1, 2]);
c = cli(['--force', 'origin', 'fix/A-1'], {});
t('the CLI refuses any other push, running nothing', [c.status, pushes().length], [2, 2]);
// The CLI against a real lease store, where §4 Vercel names a team and preview-build leases hold.
{
  const ld = join(dir, 'leases'); const conf = join(dir, 'conf.md'); const mach = join(dir, 'machine.md');
  writeFileSync(conf, '## 4. Tracker, tools and team\n| Field | Value |\n|---|---|\n| Vercel | `acme` |\n');
  writeFileSync(mach, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `lease-kinds` | `preview-build=on` | test |\n');
  const envs = { DESK_CONFIG: conf, DESK_MACHINE: mach, DESK_LEASE_DIR: ld };
  const deskEnv = (a) => spawnSync(process.execPath, [join(dirname(bin), 'desk-env.mjs'), ...a], { encoding: 'utf8', env: { ...process.env, ...envs } });
  const held = () => deskEnv(['lease', 'list', '--json']).stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).label);
  deskEnv(['preview-slot', '--wait', '0', "another PR's build"]);
  writeFileSync(log, '');
  c = cli(['origin', 'fix/A-1'], { ...envs, STUB_OUT: 'pushed', STUB_RC: '0' });
  t('the CLI, the slot held by another build: exit 76 and no push', [c.status, pushes().length], [76, 0]);
  rmSync(ld, { recursive: true, force: true });
  deskEnv(['preview-slot', '--wait', '0', 'a push of fix/A-1']);
  c = cli(['origin', 'fix/A-1'], { ...envs, STUB_OUT: 'pushed', STUB_RC: '0' });
  t('the slot its own wait took is used, and renewed for the build once it pushes', [c.status, pushes().length, held()], [0, 1, ['the build of fix/A-1']]);
}

rmSync(dir, { recursive: true, force: true });

console.log(`push-retry: ${fails ? `${fails} failed` : 'all passed'}`);
process.exit(fails ? 1 : 0);
