// suite: push-retry (a worker's push, retried while GitHub answers with a 5xx)
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSIENT_EXIT, parseArgs, pushWithRetry, transientPush } from '../desk/bin/push-retry.mjs';

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

// A stubbed git answering from `answers`, its last repeating, on a clock only sleep and `took` move.
async function run(args, answers, took = 0) {
  let clock = 0;
  const calls = []; const slept = []; const said = [];
  const git = (a) => { calls.push(a.join(' ')); clock += took * 1000; return answers[Math.min(calls.length - 1, answers.length - 1)]; };
  const sleep = async (ms) => { slept.push(ms / 1000); clock += ms; };
  const code = await pushWithRetry(parseArgs(args), { git, sleep, now: () => clock, say: (l) => said.push(l) });
  return { code, calls, slept, said, secs: clock / 1000 };
}
const OK = { status: 0, out: '' };
const E5 = { status: 1, out: REJECTED_500 };
const NFF = { status: 1, out: ' ! [rejected] b -> b (non-fast-forward)' };

let r = await run(['origin', 'b'], [OK]);
t('pushed first time: one push, no wait', [r.code, r.calls.length, r.slept], [0, 1, []]);
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
t('the park line keeps a lease', /git push --force-with-lease origin b succeeds$/.test(r.said.at(-1)), true);
r = await run(['origin', 'b'], [E5], 200);
t('AC1 a slow push still stays inside the limit', [r.code, r.secs < 900, r.slept.length < 4], [TRANSIENT_EXIT, true, true]);
const slowFirst = r;
r = await run(['--more', 'origin', 'b'], [E5], 200);
t('AC1 and a slow push passes ten minutes over the two runs', slowFirst.secs + r.secs >= 600, true);
r = await run(['origin', 'b'], [NFF]);
t('AC3 a non-fast-forward: one try, no wait, git\'s exit', [r.code, r.calls.length, r.slept], [1, 1, []]);
r = await run(['origin', 'b'], [{ status: 128, out: 'fatal: could not read Username' }]);
t('AC3 git\'s own exit code is kept', r.code, 128);
r = await run(['origin', 'b'], [E5, NFF]);
t('AC3 a refusal after a 5xx stops there', [r.code, r.calls.length], [1, 2]);

// The CLI, against a stub git that prints $STUB_OUT and exits $STUB_RC.
const dir = mkdtempSync(join(tmpdir(), 'push-retry-'));
const log = join(dir, 'calls');
writeFileSync(join(dir, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nprintf '%s\\n' "$STUB_OUT" >&2\nexit "$STUB_RC"\n`);
chmodSync(join(dir, 'git'), 0o755);
const bin = join(dirname(fileURLToPath(import.meta.url)), '../desk/bin/push-retry.mjs');
const cli = (args, env) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env } });
let c = cli(['-u', 'origin', 'fix/A-1'], { STUB_OUT: 'pushed', STUB_RC: '0' });
t('the CLI runs that push and passes on what git said', [c.status, readFileSync(log, 'utf8').trim(), c.stderr.includes('pushed')], [0, 'push -u origin fix/A-1', true]);
c = cli(['origin', 'fix/A-1'], { STUB_OUT: ' ! [rejected] b -> b (non-fast-forward)', STUB_RC: '1' });
t('AC3 the CLI exits with git\'s refusal, unretried', [c.status, readFileSync(log, 'utf8').trim().split('\n').length], [1, 2]);
c = cli(['--force', 'origin', 'fix/A-1'], {});
t('the CLI refuses any other push, running nothing', [c.status, readFileSync(log, 'utf8').trim().split('\n').length], [2, 2]);
rmSync(dir, { recursive: true, force: true });

console.log(`push-retry: ${fails ? `${fails} failed` : 'all passed'}`);
process.exit(fails ? 1 : 0);
