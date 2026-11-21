// suite: desk-wait (a worker waits on its own suite or the test lock in one blocking call)
// covers: desk/bin/desk-wait.mjs desk/bin/log-tool-calls.mjs
// Real with-lock.sh runs against a scratch lock dir with one slot and the slot lease off, their output
// written to a file the way the Bash tool writes a background task's. Scratch directories only.
import { closeSync, existsSync, openSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs, standing, recordLine, MAX_DEFAULT } from '../desk/bin/desk-wait.mjs';
import { waitCalls } from '../desk/bin/log-tool-calls.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'desk', 'bin');
const S = scratch('desk-wait-');

// ---- arguments ---------------------------------------------------------------------------------
t('a pid is waited on as a pid', parseArgs(['4242']), { pid: 4242, max: MAX_DEFAULT });
t('anything else is the task output file, with --max', parseArgs(['/tmp/x/b1.output', '--max', '30']), { file: '/tmp/x/b1.output', max: 30 });
t('AC1 --max past the Bash tool\'s 600 s is refused', /from 1 to 570/.test(parseArgs(['x', '--max', '600']).error), true);
t('no target is a usage error', /^usage:/.test(parseArgs([]).error), true);

// ---- where a run stands, from its processes -------------------------------------------------------
const shell = { pid: 10, ppid: 1, etime: '05:00', args: "/bin/zsh -c source ~/.zshrc && eval '~/.claude/desk/bin/with-lock.sh test -- bash tests/run.sh'" };
const wrapper = { pid: 11, ppid: 10, etime: '04:59', args: 'bash /Users/x/.claude/desk/bin/with-lock.sh test -- bash tests/run.sh' };
t('no process left is done', standing([]).state, 'done');
t('the shell, with-lock.sh and its pause are a wait, timed from the oldest',
  standing([shell, wrapper, { pid: 12, ppid: 11, etime: '00:01', args: 'sleep 2' }]), { state: 'waiting', seconds: 300, wrappers: [11], pids: [10, 11, 12], light: false });
t('a wrapper re-run under the light lock is read as waiting on it',
  standing([{ ...wrapper, args: 'bash /x/with-lock.sh light --cwd . -- bash tests/run.sh' }]).light, true);
t('a flock and the lease broker are a wait too',
  standing([wrapper, { pid: 12, ppid: 11, etime: '00:01', args: 'flock 9' }, { pid: 13, ppid: 11, etime: '00:01', args: 'node /x/slot-lease.mjs take test --pid 11 -- bash tests/run.sh' }]).state, 'waiting');
t('the command, exec\'d into the wrapper\'s pid, has started', standing([shell, { ...wrapper, args: 'bash tests/run.sh' }, { pid: 14, ppid: 11, etime: '00:01', args: 'node tests/test_x.mjs' }]), { state: 'started', pid: 11 });
t('a run that takes no lock has started from its shell', standing([{ pid: 20, ppid: 1, etime: '00:03', args: '/bin/zsh -c bash tests/run.sh' }]), { state: 'started', pid: 20 });
t('AC2 the record line is the one the contract records',
  recordLine('~/wt/DS-1: bash tests/run.sh, held 3m'), "not run locally: test lock busy (~/wt/DS-1: bash tests/run.sh, held 3m); CI's required tests cover it");

// ---- AC4: desk-wait calls are told apart from ps, tail and TaskStop in a worker log ------------------
const ev = (o) => JSON.stringify(o);
const use = (id, name, input) => ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id) => ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const log = [
  ev({ type: 'system', subtype: 'init', session_id: 's1' }),
  use('a', 'Bash', { command: 'ps -ww -axo pid,ppid,etime,args' }), res('a'),
  use('b', 'Bash', { command: 'tail -n 30 /tmp/x/b1.output' }), res('b'),
  use('c', 'TaskStop', { task_id: 'b1' }), res('c'),
  use('d', 'Bash', { command: '~/.claude/desk/bin/desk-wait.mjs /tmp/x/b1.output --max 540' }), res('d'),
  use('e', 'Bash', { command: 'git status --porcelain' }), res('e'),
  use('f', 'Bash', { command: 'node /Users/x/.claude/desk/bin/desk-wait.mjs 4242' }), res('f'),
  use('g', 'Bash', { command: 'git log | tail -3' }), res('g'),
].join('\n');
t('AC4 each wait call is classed by kind, in order, with its session', waitCalls(log).map((c) => `${c.session}:${c.kind}`),
  ['s1:ps', 's1:tail', 's1:TaskStop', 's1:desk-wait', 's1:desk-wait']);

// ---- real runs ----------------------------------------------------------------------------------
let n = 0;
const fresh = (p) => { const d = join(S, `${p}${n++}`); spawnSync('mkdir', ['-p', d]); return d; };
const profile = join(S, 'machine.md');
writeFileSync(profile, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `lease-kinds` | `slot=off` | test |\n| `test-lock-slots` | `1` | test |\n');
const locks = fresh('k');
const env = { ...process.env, HOME: S, DESK_LOCK_DIR: locks, DESK_LEASE_DIR: fresh('l'), DESK_MACHINE: profile, DESK_CONFIG: join(S, 'no-config.md'), DESK_WAIT_POLL_MS: '200' };
delete env.DESK_TEST_LOCK_SLOTS;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A background run whose output goes to its own file, as the Bash tool's does: the file is held open
// by the run alone.
const background = (argv) => {
  const out = join(S, `task-${n++}.output`);
  const fd = openSync(out, 'w');
  const c = spawn(argv[0], argv.slice(1), { env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  return { c, out, done: new Promise((r) => c.on('exit', (code) => r(code))) };
};
const wait = (target, extra = [], more = {}) => {
  const at = Date.now();
  const r = spawnSync(process.execPath, [join(bin, 'desk-wait.mjs'), String(target), ...extra], { env: { ...env, ...more }, encoding: 'utf8' });
  return { rc: r.status, out: r.stdout, err: r.stderr, seconds: (Date.now() - at) / 1000 };
};
const nodeSleep = (ms) => [process.execPath, '-e', `setTimeout(() => {}, ${ms})`];
const lockRun = (cmd) => ['bash', join(bin, 'with-lock.sh'), 'test', '--', ...cmd];

const held = [];
try {
  // AC1: a run that ends inside the wait returns done, with its output's tail.
  {
    const r = background(['sh', '-c', 'i=0; while [ $i -lt 40 ]; do echo "line $i"; i=$((i+1)); done; sleep 1']);
    const w = wait(r.out, ['--max', '20']);
    const lines = w.out.trim().split('\n');
    t('AC1 a run that ends returns done in one call, well inside --max', [w.rc, lines[0], w.seconds < 15], [0, 'done ?', true]);
    t('AC1 then the output\'s last 30 lines', [lines.length, lines[1], lines.at(-1)], [31, 'line 10', 'line 39']);
  }
  // AC1: a run still going when --max is up returns started, with the command's pid.
  {
    const r = background(lockRun(nodeSleep(60_000))); held.push(r);
    await sleep(500);
    const w = wait(r.out, ['--max', '1']);
    t('AC1 a run under the lock that has started returns started at --max', [w.rc, /^started \d+$/.test(w.out.trim()), w.seconds < 10], [0, true, true]);
    t('AC3 the run is still the child it was: desk-wait detached nothing', [alive(r.c.pid), spawnSync('ps', ['-o', 'ppid=', '-p', String(r.c.pid)], { encoding: 'utf8' }).stdout.trim()], [true, String(process.pid)]);
    // AC1: a run queued behind it returns waiting, with the holder and the minutes waited.
    const q = background(lockRun(['sh', '-c', `: > '${join(S, 'queued-ran')}'`])); held.push(q);
    await sleep(500);
    const w2 = wait(q.out, ['--max', '1']);
    t('AC1 a run the lock has not started returns waiting, naming the holder', [w2.rc, /^waiting \(.+\) 0$/.test(w2.out.trim()), w2.out.includes('held'), w2.seconds < 10], [0, true, true, true]);
    // AC2: past the threshold it stops the queued run, prints the holder and the record line, and
    // leaves the holder running.
    const w3 = wait(q.out, ['--max', '20'], { DESK_WAIT_SKIP_AFTER: '1' });
    const [first, second, third] = w3.out.trim().split('\n');
    const holder = /^waiting \((.+)\) \d+$/.exec(first ?? '')?.[1];
    t('AC2 at the threshold it prints the holder, then the record line naming it', [!!holder, second === recordLine(holder)], [true, true]);
    t('AC2 and says it stopped the queued run', /^stopped the queued run \(pid \d+/.test(third ?? ''), true);
    const code = await Promise.race([q.done, sleep(5000).then(() => 'still running')]);
    t('AC2 the queued run has ended, and its command never ran', [code !== 'still running', existsSync(join(S, 'queued-ran'))], [true, false]);
    t('AC2 the run holding the lock is left alone', alive(r.c.pid), true);
    r.c.kill('SIGTERM'); await r.done;
  }
  // A pid is waited on until it exits.
  {
    const r = background(nodeSleep(1000));
    const w = wait(r.c.pid, ['--max', '20']);
    t('a pid that exits returns done', [w.rc, w.out.trim(), w.seconds < 15], [0, 'done ?', true]);
  }
  t('a missing output file is an error, not done', wait(join(S, 'nope.output')).rc, 2);
} finally {
  for (const h of held) { try { h.c.kill('SIGKILL'); } catch { /* gone */ } }
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
