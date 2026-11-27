// suite: bench score (the hidden tests' time limit counts from when they hold the test lock, not the wait for it)
// layer: L2
// covers: desk/bin/run-for.mjs
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { score } from '../desk/bin/bench.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wl = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'with-lock.sh');
const dir = realpathSync(scratch('bench-score-'));
// score() runs the real with-lock.sh with the arm's environment, read from this process's: a scratch
// lock and lease directory, a one-slot test lock on the lock files, and no slot of an outer run.
const profile = join(dir, 'machine.md');
writeFileSync(profile, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `lease-kinds` | `slot=off` | test |\n| `test-lock-slots` | `1` | test |\n');
Object.assign(process.env, { HOME: dir, DESK_LOCK_DIR: join(dir, 'locks'), DESK_LEASE_DIR: join(dir, 'leases'), DESK_MACHINE: profile, DESK_CONFIG: join(dir, 'no-config.md'), DESK_TEST_LOCK_SLOTS: '1' });
for (const k of ['DESK_LOCK_HELD', 'TEST_JOB_TOKENS', 'DESK_AUTOPILOT_WORKER', 'DESK_LIGHT_SMALL']) delete process.env[k];
mkdirSync(process.env.DESK_LOCK_DIR);
mkdirSync(process.env.DESK_LEASE_DIR);

let n = 0;
// A checkout whose one hidden test is `body`, scored with `timeout` ms. -> { result, secs }
function scoreWith(body, timeout) {
  const wt = join(dir, `wt-${n}`), hidden = join(dir, `hidden-${n}`), out = join(dir, `out-${n++}`);
  for (const d of [wt, join(hidden, 'tests'), out]) mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', wt]);
  writeFileSync(join(wt, 'run-tests.sh'), '#!/bin/sh\nfor f in "$@"; do sh "$f" || exit 1; done\n');
  writeFileSync(join(hidden, 'tests', 'hidden.sh'), body);
  const repo = { items: [{ dir: '.', cmd: 'sh run-tests.sh' }], cap: null, prefix: '' };
  const task = { hidden_tests: { dir: hidden, files: ['tests/hidden.sh'] } };
  const t0 = Date.now();
  const result = score(repo, task, wt, out, timeout);
  return { result, secs: (Date.now() - t0) / 1000 };
}

// A run that holds the test lock for `ms`: resolves once its command has started.
async function hold(ms) {
  const mark = join(dir, `held-${n++}`);
  const c = spawn('bash', [wl, 'test', '--', 'sh', '-c', `: > '${mark}'; sleep ${ms / 1000}`], { env: process.env, stdio: 'ignore' });
  const done = new Promise((r) => c.on('exit', r));
  for (let i = 0; i < 200 && !existsSync(mark); i++) await sleep(50);
  return { started: existsSync(mark), done };
}

try {
  // AC2: another run holds the lock well past the scoring timeout while a scored run waits for it.
  {
    const h = await hold(4000);
    t('AC2 another run holds the test lock', h.started, true);
    const { result, secs } = scoreWith('exit 1\n', 1500);
    t('AC2 a scored run that waited past its timeout is still scored, and a failing test rejects it', result.status, 'rejected');
    t('AC2 it waited for the lock rather than running beside the holder', secs >= 2, true);
    await h.done;
    const ok = scoreWith('exit 0\n', 1500);
    t('AC2 a passing test is accepted', ok.result.status, 'accepted');
  }
  // AC1: the time the tests run while holding the lock is still bounded.
  {
    const { result, secs } = scoreWith('sleep 30\n', 1500);
    t('AC1 tests that run past the timeout under the lock are failed', result.status, 'failed');
    t('AC1 and say the hidden tests did not finish', /^the hidden tests did not finish: /.test(result.why ?? ''), true);
    t('AC1 they are stopped at the timeout, not left to finish', secs < 15, true);
  }
  // run-for.mjs passes the command's own exit code through, and refuses a malformed call.
  {
    const rf = join(dirname(wl), 'run-for.mjs');
    t('run-for passes the exit code through', spawnSync(process.execPath, [rf, '5000', '--', 'sh', '-c', 'exit 3']).status, 3);
    t('run-for refuses a call with no time', spawnSync(process.execPath, [rf, '--', 'true']).status, 2);
  }
} catch (e) {
  fails++;
  console.log(`FAIL threw: ${e.stack}`);
}

console.log(fails ? `\n${fails} failure(s)` : '\nall passed');
process.exit(fails ? 1 : 0);
