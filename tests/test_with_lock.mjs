// suite: with-lock (the lock classes its usage line lists are exactly the ones it accepts; each run takes its slot as a lease)
// layer: L2
// covers: desk/bin/with-lock.sh desk/bin/prose-facts.mjs desk/bin/slot-lease.mjs desk/bin/admission.mjs
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { usageLocks } from '../desk/bin/prose-facts.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'desk', 'bin', 'with-lock.sh');

// The classes the `case "$name" in` that picks the lock file accepts: each arm's labels but `*`.
function acceptedLocks(text) {
  const body = /case "\$name" in\n([\s\S]*?)\n\s*esac/.exec(text)?.[1] ?? '';
  return [...body.matchAll(/^\s*([a-z][a-z|]*)\)/gm)].flatMap((m) => m[1].split('|'));
}
// Each class one side has and the other lacks, named with the side it is missing from.
const mismatched = (text) => {
  const usage = usageLocks(text), accepted = acceptedLocks(text);
  return [...usage.filter((c) => !accepted.includes(c)).map((c) => `${c}: in the usage line, not accepted`),
    ...accepted.filter((c) => !usage.includes(c)).map((c) => `${c}: accepted, not in the usage line`)];
};
const text = readFileSync(script, 'utf8');

// #881 AC5
t('#881 the usage line lists every class the script accepts, and only those', mismatched(text), []);
t('#881 the usage line is read', usageLocks(text).length > 0, true);
const usage = usageLocks(text);
const added = text.replace(`<${usage.join('|')}>`, `<${[...usage, 'gpu'].join('|')}>`);
t('#881 a class added to the usage line alone is named', added === text ? 'usage line not found' : mismatched(added), ['gpu: in the usage line, not accepted']);
const accepted = text.replace(/(\n\s*)browser\)/, '$1browser|gpu)');
t('#881 a class added to the case alone is named', accepted === text ? 'case arm not found' : mismatched(accepted), ['gpu: accepted, not in the usage line']);

// The real script runs a command under each listed class, and refuses one it does not list.
const lockDir = scratch('with-lock-');
try {
  const env = { ...process.env, DESK_LOCK_DIR: lockDir, DESK_LEASE_DIR: lockDir, DESK_TEST_LOCK_SLOTS: '1' };
  const run = (cls) => spawnSync('bash', [script, cls, '--', 'true'], { env, encoding: 'utf8' });
  t('#881 every class in the usage line runs a command', usageLocks(text).filter((c) => run(c).status !== 0), []);
  const bad = run('gpu');
  t('#881 a class not in the usage line is refused', [bad.status, bad.stderr.trim()], [2, "with-lock.sh: unknown lock 'gpu'"]);
} finally { rmSync(lockDir, { recursive: true, force: true }); }

// ---- DS-909: each run takes its slot as a lease ------------------------------------------------
// Real wrapper runs against a scratch lease directory and lock directory per case, with the slot kind
// set by a machine profile. A held run is a command that waits for its go file.
const S = scratch('with-lock-leases-');
let n = 0;
const fresh = (p) => { const d = join(S, `${p}${n++}`); mkdirSync(d, { recursive: true }); return d; };
const machine = (rows) => {
  const p = join(S, `machine-${n++}.md`);
  writeFileSync(p, `## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n${Object.entries(rows).map(([k, v]) => `| \`${k}\` | \`${v}\` | test |`).join('\n')}\n`);
  return p;
};
// A PATH with no flock(1), so the mkdir fallback runs wherever this does: a directory of links to the
// tools the wrapper, the lease client and the held commands use.
const noFlock = fresh('bin');
for (const tool of ['bash', 'sh', 'node', 'git', 'mkdir', 'cat', 'rm', 'mv', 'find', 'sleep', 'dirname', 'ps', 'true', 'pwd', 'sysctl']) {
  const r = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  const at = r.stdout.trim();
  if (at.startsWith('/')) symlinkSync(at, join(noFlock, tool));
}
const hasFlock = spawnSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).status === 0;
// The environment for one case: its lease dir, lock dir and profile.
const caseEnv = ({ leases, locks, profile, extra = {} }) => {
  const e = { ...process.env, HOME: S, DESK_LEASE_DIR: leases, DESK_LOCK_DIR: locks, DESK_MACHINE: profile, DESK_CONFIG: join(S, 'no-config.md'), ...extra };
  delete e.DESK_TEST_LOCK_SLOTS;
  return e;
};
const wl = (env, args, opts = {}) => spawnSync('bash', [script, ...args], { env, encoding: 'utf8', ...opts });
// A run that holds its lock until release(): resolves once its command has started.
const held = [];
// `cmd` turns the mark file into the command, which must create it and then wait for `<mark>.go`.
const holdSh = (mark) => ['sh', '-c', `: > '${mark}'; while [ ! -e '${mark}.go' ]; do sleep 0.05; done`];
// `ms` is how long to wait for the command to start: 0 returns at once, for a run that will wait.
const hold = async (env, args, opts = {}, cmd = holdSh, { ms = 10_000 } = {}) => {
  const mark = join(S, `held-${n++}`);
  const c = spawn('bash', [script, ...args, '--', ...cmd(mark)], { env, stdio: ['ignore', 'ignore', 'pipe'], ...opts });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  // 'exit', not 'close': a wrapper SIGKILLed leaves its stderr open in the command it ran.
  const h = { c, mark, err: () => err, release: () => writeFileSync(`${mark}.go`, ''), done: new Promise((r) => c.on('exit', (code) => r(code))) };
  held.push(h);
  for (let i = 0; i < ms / 50 && !existsSync(mark); i++) await sleep(50);
  return h;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000) => { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50); } return false; };
const leaseList = (env) => spawnSync(process.execPath, [join(root, 'desk', 'bin', 'leases.mjs'), 'list', '--json'], { env, encoding: 'utf8' })
  .stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const leaseLog = (dir) => (existsSync(join(dir, 'leases.log.jsonl')) ? readFileSync(join(dir, 'leases.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const ON2 = machine({ 'lease-kinds': 'slot=on', 'test-lock-slots': '2' });
const SHADOW1 = machine({ 'lease-kinds': 'slot=shadow', 'test-lock-slots': '1' });
const OFF1 = machine({ 'lease-kinds': 'slot=off', 'test-lock-slots': '1' });

try {
  // AC1: a typecheck waits on a full heavy pool, says who holds it, and runs once a slot frees.
  {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: ON2 });
    const a = await hold(env, ['test']); const b = await hold(env, ['test']);
    const ran = join(S, `ran-${n++}`);
    const c = spawn('bash', [script, 'tsc', '--', 'sh', '-c', `: > '${ran}'`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; c.stderr.on('data', (d) => { err += d; });
    const done = new Promise((r) => c.on('close', (code) => r(code)));
    await until(() => err.includes('waiting'));
    t('DS-909 AC1 a typecheck waits while both heavy slots are held, and has not run', [err.includes('waiting for the heavy pool (2 slots)'), existsSync(ran)], [true, false]);
    t('DS-909 AC1 it names who holds the pool', [`pid ${a.c.pid}`, `pid ${b.c.pid}`].every((p) => err.includes(p)) && err.includes('test '), true);
    a.release();
    t('DS-909 AC1 it runs once a slot is released', [await done, existsSync(ran)], [0, true]);
    b.release(); await a.done; await b.done;
  }
  // AC2, AC3: a lint, run under the tsc class as the worker contract runs it, holds a lint slot in the
  // heavy pool, owned by its command, for as long as it runs.
  {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: ON2 });
    const bin = fresh('nm');
    writeFileSync(join(bin, 'eslint'), '#!/bin/sh\n[ -n "$1" ] || exit 0\n: > "$1"; while [ ! -e "$1.go" ]; do sleep 0.05; done\n'); chmodSync(join(bin, 'eslint'), 0o755);
    const h = await hold(env, ['tsc'], {}, (mark) => [join(bin, 'eslint'), mark]);
    const [l] = leaseList(env);
    t('DS-909 AC2 a linter binary run under the tsc class holds a lint slot in the heavy pool, owned by its command', [l?.kind, l?.key, l?.owner?.pid === h.c.pid, leaseList(env).length], ['slot', 'lint', true, 1]);
    h.release(); await h.done;
    t('DS-909 AC3 the slot is released as the command exits', leaseList(env).length, 0);
    // A typecheck under the same class holds a tsc slot, though its shell names a linter later on.
    wl(env, ['tsc', '--', 'sh', '-c', `true; ${join(bin, 'eslint')}`]);
    const keys = leaseLog(env.DESK_LEASE_DIR).filter((e) => e.event === 'grant').map((e) => e.key);
    t('DS-909 AC2 a typecheck under the tsc class holds a tsc slot', keys, ['lint', 'tsc']);
    const cfg = join(S, `config-${n++}.md`);
    writeFileSync(cfg, '## 4. Tools\n| Field | Value |\n|---|---|\n| Lint | `sh lint.sh` |\n');
    const e2 = { ...caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: ON2 }), DESK_CONFIG: cfg };
    writeFileSync(join(S, 'lint.sh'), 'exit 0\n');
    wl(e2, ['tsc', '--', 'sh', 'lint.sh', '--strict'], { cwd: S });
    t('DS-909 AC2 a §4 Lint item run under the tsc class, arguments added, holds a lint slot', leaseLog(e2.DESK_LEASE_DIR).filter((e) => e.event === 'grant').map((e) => e.key), ['lint']);
    // The pre-push hook and the baseline runner run each item as the one argument of `bash -c` / `sh -c`.
    wl(e2, ['tsc', '--timeout', '60', '--', 'bash', '-c', 'sh lint.sh'], { cwd: S });
    wl(e2, ['tsc', '--', 'sh', '-c', 'sh lint.sh --fix'], { cwd: S });
    t('DS-909 AC2 a §4 Lint item run through bash -c or sh -c holds a lint slot', leaseLog(e2.DESK_LEASE_DIR).filter((e) => e.event === 'grant').map((e) => e.key), ['lint', 'lint', 'lint']);
  }
  // AC4: the wrapper SIGKILLed while its command runs leaves the slot held until the command exits.
  // The mkdir fallback is the path that keeps a wrapper beside its command; in shadow, its lease is the command's.
  {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: SHADOW1, extra: { PATH: noFlock } });
    const h = await hold(env, ['test']);
    await until(() => leaseList(env).length === 1);
    const [l] = leaseList(env);
    t('DS-909 AC4 the mkdir path\'s lease is owned by the command, not the wrapper', [l?.owner?.pid !== h.c.pid, alive(l?.owner?.pid)], [true, true]);
    h.c.kill('SIGKILL'); await h.done;
    t('DS-909 AC4 with the wrapper SIGKILLed, the slot stays held while the command runs', [alive(l.owner.pid), leaseList(env).map((x) => x.id)], [true, [l.id]]);
    h.release(); await until(() => !alive(l.owner.pid));
    t('DS-909 AC4 and is released once the command exits', leaseList(env).length, 0);
  }
  // AC5: a 0-second wait with every heavy slot held exits 75 and runs nothing.
  {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: ON2 });
    const a = await hold(env, ['test']); const b = await hold(env, ['tsc']);
    const ran = join(S, `ran-${n++}`);
    const r = wl(env, ['tsc', '--timeout', '0', '--', 'sh', '-c', `: > '${ran}'`]);
    t('DS-909 AC5 --timeout 0 on a full heavy pool exits 75 and runs nothing', [r.status, existsSync(ran), /^with-lock\.sh: gave up waiting/m.test(r.stderr)], [75, false, true]);
    a.release(); b.release(); await a.done; await b.done;
  }
  // AC6: with the slot kind off, a suite waits for and holds the test lock as before, on both lock paths, and takes no lease.
  for (const [path, extra] of [['mkdir', { PATH: noFlock }], ...(hasFlock ? [['flock', {}]] : [])]) {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: OFF1, extra });
    const h = await hold(env, ['test']);
    const lockHeld = path === 'mkdir' ? existsSync(join(env.DESK_LOCK_DIR, 'desk-test.lock.d'))
      : spawnSync('flock', ['-n', join(env.DESK_LOCK_DIR, 'desk-test.lock'), 'true']).status !== 0;
    const r = wl(env, ['test', '--timeout', '0', '--', 'true']);
    t(`DS-909 AC6 kind off, ${path} path: the suite holds the test lock and a second waits on it`, [lockHeld, r.status], [true, 75]);
    t(`DS-909 AC6 kind off, ${path} path: no lease is taken`, [existsSync(join(env.DESK_LEASE_DIR, 'leases.json')), leaseLog(env.DESK_LEASE_DIR).filter((e) => e.id).length], [false, 0]);
    const { readLog, trialOf } = await import('../desk/bin/leases.mjs');
    t(`DS-909 AC6 kind off, ${path} path: the lock runs' wait lines do not start the lease trial`,
      [leaseLog(env.DESK_LEASE_DIR).length > 0, trialOf(readLog({ dir: env.DESK_LEASE_DIR }))], [true, null]);
    h.release(); await h.done;
  }
  if (!hasFlock) console.log('skip DS-909 AC6 kind off, flock path: no flock(1) here (CI\'s Linux lane runs it)');
  // AC7: in shadow, the legacy lock and a lease both; only the lock is waited on, and a full pool logs a would-refuse.
  for (const [path, extra] of [['mkdir', { PATH: noFlock }], ...(hasFlock ? [['flock', {}]] : [])]) {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: SHADOW1, extra });
    const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    spawnSync(process.execPath, [join(root, 'desk', 'bin', 'leases.mjs'), 'acquire', 'slot', 'test', '--ttl', '600', '--label', 'another repo', '--pid', String(sleeper.pid)], { env });
    const h = await hold(env, ['test']);
    await until(() => leaseList(env).length === 2);
    const lockHeld = path === 'mkdir' ? existsSync(join(env.DESK_LOCK_DIR, 'desk-test.lock.d'))
      : spawnSync('flock', ['-n', join(env.DESK_LOCK_DIR, 'desk-test.lock'), 'true']).status !== 0;
    t(`DS-909 AC7 shadow, ${path} path: a full pool did not hold the suite, which holds the lock and a lease`, [lockHeld, leaseList(env).length], [true, 2]);
    t(`DS-909 AC7 shadow, ${path} path: the log records the would-refuse`, leaseLog(env.DESK_LEASE_DIR).some((e) => e.event === 'would-refuse' && e.key === 'test'), true);
    const r = wl(env, ['test', '--timeout', '0', '--', 'true']);
    t(`DS-909 AC7 shadow, ${path} path: a second run waits on the legacy lock`, r.status, 75);
    h.release(); await h.done; sleeper.kill();
  }
  // AC8: an unreadable store with the kind on takes the legacy lock and says so once.
  {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: ON2, extra: { PATH: noFlock } });
    writeFileSync(join(env.DESK_LEASE_DIR, 'leases.json'), '{not json');
    const h = await hold(env, ['test']);
    t('DS-909 AC8 an unreadable store takes the legacy lock', existsSync(join(env.DESK_LOCK_DIR, 'desk-test.lock.d')), true);
    h.release(); await h.done;
    await until(() => h.err().includes('leases were unreadable'), 2000);
    const said = h.err().split('\n').filter((l) => l.includes('leases were unreadable'));
    t('DS-909 AC8 and prints once that leases were unreadable', said.length, 1);
    const r = wl(env, ['test', '--', 'sh', '-c', 'exit 3']);
    t('DS-909 AC8 the command still runs and keeps its status', r.status, 3);
  }
  // AC9-AC11: --cwd in a sibling worktree of the same repository runs there under its slot; another repository's is refused.
  {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: ON2, extra: { GIT_CONFIG_GLOBAL: join(S, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } });
    writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\temail = t@example.com\n\tname = t\n');
    const main = fresh('main'), other = fresh('other');
    const git = (cwd, ...a) => spawnSync('git', a, { cwd, env, encoding: 'utf8' });
    git(main, 'init', '-q', '-b', 'main'); git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    const sib = join(S, `sib-${n++}`);
    git(main, 'worktree', 'add', '-q', sib, '-b', 'sib'); mkdirSync(join(sib, 'sub'));
    git(other, 'init', '-q');
    const real = (p) => realpathSync(p);
    const r = wl(env, ['test', '--cwd', join(sib, 'sub'), '--', 'sh', '-c', 'pwd -P; node "$0" list --json', join(root, 'desk', 'bin', 'leases.mjs')], { cwd: main });
    const [where, lease] = r.stdout.trim().split('\n');
    t('DS-909 AC9 a sibling worktree as --cwd runs the command there', [r.status, where], [0, real(join(sib, 'sub'))]);
    t('DS-909 AC9 under its slot', JSON.parse(lease ?? '{}').key, 'test');
    const ran = join(S, `ran-${n++}`);
    const x = wl(env, ['test', '--cwd', other, '--', 'sh', '-c', `: > '${ran}'`], { cwd: main });
    t('DS-909 AC10 another repository as --cwd exits 2 and runs nothing', [x.status, existsSync(ran)], [2, false]);
    t('DS-909 AC11 the refusal names the target and, separately, the worktree root it compared against',
      x.stderr.includes(`--cwd ${real(other)} resolves outside this worktree (${real(main)})`), true);
  }
  // AC13: in shadow, an unreadable store or a failing broker leaves a --timeout run (the pre-push hook's) as before.
  {
    const leases = fresh('l');
    writeFileSync(join(leases, 'leases.json'), '{not json');
    const env = caseEnv({ leases, locks: fresh('k'), profile: SHADOW1 });
    const r = wl(env, ['tsc', '--timeout', '0', '--', 'sh', '-c', 'exit 3']);
    t('DS-909 AC13 shadow, unreadable store: exits with the command\'s status and says nothing', [r.status, r.stderr], [3, '']);
    const file = join(S, `not-a-dir-${n++}`); writeFileSync(file, '');
    const r2 = wl(caseEnv({ leases: file, locks: fresh('k'), profile: SHADOW1 }), ['tsc', '--timeout', '0', '--', 'sh', '-c', 'exit 4']);
    t('DS-909 AC13 shadow, broker erroring: exits with the command\'s status and says nothing', [r2.status, r2.stderr], [4, '']);
  }
  // AC14: in shadow, a suite running past the slot TTL keeps its lease until it exits.
  {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: SHADOW1, extra: { DESK_SLOT_LEASE_TTL: '1' } });
    const h = await hold(env, ['test']);
    await until(() => leaseList(env).length === 1);
    const [l] = leaseList(env);
    t('DS-909 AC14 the fixture TTL is 1 s', l?.ttl, 1);
    await sleep(2500);
    t('DS-909 AC14 past twice its TTL, the running suite\'s lease is still live', leaseList(env).map((x) => x.id), [l.id]);
    h.release(); await h.done;
    await until(() => leaseList(env).length === 0, 3000);
    t('DS-909 AC14 and goes once it exits', leaseList(env).length, 0);
  }
  // DS-924: the command learns it runs inside a slot of this lock (tests/related.sh then takes no
  // second), and a run waiting on the lock files says on whom, on both lock paths.
  {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: SHADOW1 });
    const said = (args, e = env) => wl(e, [...args, '--', 'sh', '-c', 'printf %s "$DESK_LOCK_HELD"']).stdout;
    t('DS-924 with-lock.sh exports DESK_LOCK_HELD as the lock its command holds',
      [said(['test']), said(['tsc']), said(['light']), said(['test'], caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: ON2 })), said(['nolock'])],
      ['test', 'tsc', 'light', 'test', '']);
  }
  for (const [path, extra] of [['mkdir', { PATH: noFlock }], ...(hasFlock ? [['flock', {}]] : [])]) {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: OFF1, extra });
    const h = await hold(env, ['test']);
    const r = wl(env, ['test', '--timeout', '2', '--', 'true']);
    t(`DS-924 ${path} path: a run waiting on the test lock names the holder's run, and how long it has held it`,
      [r.status, /^with-lock\.sh: waiting for test lock \(held by pid [\d ]+\): .+, held /m.test(r.stderr)], [75, true]);
    const now = wl(env, ['test', '--timeout', '0', '--', 'true']);
    t(`DS-924 ${path} path: a 0-second wait gives up without saying it waits`, [now.status, now.stderr.includes('waiting for test lock')], [75, false]);
    // With the test lock still held, a run waiting on the light lock is told the light lock's holder alone.
    const hl = await hold(env, ['light']);
    const lr = wl(env, ['light', '--timeout', '2', '--', 'true']);
    const line = lr.stderr.split('\n').find((l) => l.startsWith('with-lock.sh: waiting for light lock')) ?? '';
    t(`DS-924 ${path} path: a run waiting on the light lock names its holder, not the test lock's`, [lr.status, /\): .+, held /.test(line), line.split(', held ').length - 1], [75, true, 1]);
    hl.release(); await hl.done;
    h.release(); await h.done;
  }
  // Every wait, grant and give-up is in the lease log with the run's class, worktree, seconds
  // waited, the queue behind the lock and the load and memory then, whatever the slot kind's mode.
  {
    const ON1 = machine({ 'lease-kinds': 'slot=on', 'test-lock-slots': '1' });
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const readings = (e) => ['load_1m', 'mem_free_pct', 'compressed_gb'].every((k) => k in (e ?? {}) && (e[k] === null || typeof e[k] === 'number'));
    const of = (env, ev) => leaseLog(env.DESK_LEASE_DIR).filter((e) => e.event === ev && e.key === 'light');
    const run = (env, args) => { const c = spawn('bash', [script, ...args], { env, cwd: root, stdio: 'ignore' }); return new Promise((r) => c.on('exit', r)); };
    for (const [label, profile, extra] of [['off, mkdir path', OFF1, { PATH: noFlock }], ...(hasFlock ? [['off, flock path', OFF1, {}]] : []),
      ['shadow', SHADOW1, { PATH: noFlock }], ['on', ON1, {}]]) {
      const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile, extra });
      const a = await hold(env, ['light'], { cwd: root });
      // The mkdir path starts its command before it logs the grant: the queue it counts is the one then.
      await until(() => of(env, 'grant').length === 1);
      const b = run(env, ['light', '--', 'true']);
      await until(() => of(env, 'queued').length === 1);
      const c = run(env, ['light', '--', 'true']);
      await until(() => of(env, 'queued').length === 2);
      await sleep(2200);
      a.release(); await a.done; await b; await c;
      const [q1, q2] = of(env, 'queued');
      t(`DS-975 AC2 ${label}: a run that finds the light slot held logs a queued line with its class, worktree, the queue, the time and the readings`,
        [q1?.class, q1?.worktree === top, q1?.queue, Number.isFinite(Date.parse(q1?.at)), readings(q1)], ['light', true, 0, true, true]);
      t(`DS-975 AC2 ${label}: the second to wait counts the first in the queue`, q2?.queue, 1);
      const [ga, g1, g2] = of(env, 'grant');
      t(`DS-975 AC4 ${label}: a run granted at once logs one grant line, 0 seconds waited`, [of(env, 'grant').length, ga?.wait_s, ga?.queue], [3, 0, 0]);
      t(`DS-975 AC1 ${label}: a run granted after waiting logs its class, the seconds waited, the queue at grant and the readings`,
        [g1?.class, g1?.wait_s >= 2, g1?.queue, readings(g1), g1?.worktree === top], ['light', true, 1, true, true]);
      t(`DS-975 AC1 ${label}: the last granted had nobody behind it`, g2?.queue, 0);
      t(`DS-975 ${label}: the machine's readings are read`, [ga, g1, g2, q1].some((e) => typeof e?.load_1m === 'number'), true);
      t(`DS-975 ${label}: nobody is left in the queue`, existsSync(join(env.DESK_LOCK_DIR, 'desk-light.waiting')) ? readdirSync(join(env.DESK_LOCK_DIR, 'desk-light.waiting')) : [], []);
      // In shadow a lease beside the lock carries the grant; one its command outran is logged as with the kind off.
      const own = { on: [ga, g1, g2], shadow: [ga] }[label] ?? [];
      t(`DS-975 ${label}: the grant line is the lease's own where a lease is taken, else a line of its own`,
        [own.every((e) => typeof e?.id === 'string'), label.startsWith('off') ? [ga, g1, g2].some((e) => e?.id) : false], [true, false]);
      // AC3: a wait that reaches its timeout exits 75 and logs a gave-up line.
      const h = await hold(env, ['light'], { cwd: root });
      const r = wl(env, ['light', '--timeout', '2', '--', 'true'], { cwd: root });
      const g = of(env, 'gave-up').at(-1);
      t(`DS-975 AC3 ${label}: a run that gives up exits 75 and logs its class, worktree, seconds waited, the queue and the readings`,
        [r.status, g?.class, g?.worktree === top, g?.wait_s >= 2, g?.queue, readings(g)], [75, 'light', true, true, 0, true]);
      h.release(); await h.done;
    }
    // AC6: every reading failing (a sysctl that hangs) leaves them empty, and the grant is still logged
    // with the command started within 1 s of it. macOS's sampler runs sysctl; Linux's reads /proc.
    if (process.platform === 'darwin') {
      const slow = fresh('slow');
      writeFileSync(join(slow, 'sysctl'), '#!/bin/sh\nexec sleep 5\n'); chmodSync(join(slow, 'sysctl'), 0o755);
      const stampCmd = (stamp) => [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], String(Date.now()))', stamp];
      const startedAt = (stamp) => Number(existsSync(stamp) ? readFileSync(stamp, 'utf8') : NaN);
      const empty = (g) => [g?.load_1m, g?.mem_free_pct, g?.compressed_gb];
      // On: the slot is granted when the lease is taken, its expiry less its TTL, before any reading.
      {
        const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: ON1, extra: { PATH: `${slow}:${process.env.PATH}` } });
        const stamp = join(S, `started-${n++}`);
        const r = wl(env, ['light', '--', ...stampCmd(stamp)], { cwd: root });
        const g = of(env, 'grant').at(-1);
        t('DS-975 AC6 on: with every reading failing the grant is logged, the readings empty', [r.status, ...empty(g), g?.wait_s], [0, null, null, null, 0]);
        t('DS-975 AC6 on: the command starts within 1 s of the grant', startedAt(stamp) - (Date.parse(g?.expires) - g?.ttl * 1000) < 1000, true);
      }
      // Off, flock(1): the slot is granted when flock takes the lock, and the holder file beside it is
      // written then, before the grant line's readings, so they fall inside the interval timed.
      if (hasFlock) {
        const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: OFF1, extra: { PATH: `${slow}:${process.env.PATH}` } });
        const stamp = join(S, `started-${n++}`);
        const r = wl(env, ['light', '--', ...stampCmd(stamp)], { cwd: root });
        const g = of(env, 'grant').at(-1);
        const grantedAt = statSync(join(env.DESK_LOCK_DIR, 'desk-light.lock.pid')).mtimeMs;
        t('DS-975 AC6 off, flock path: with every reading failing the grant is logged, the readings empty', [r.status, ...empty(g), g?.wait_s], [0, null, null, null, 0]);
        t('DS-975 AC6 off, flock path: the command starts within 1 s of the lock being taken', startedAt(stamp) - grantedAt < 1000, true);
      }
      // Off, mkdir path: the command is started before the grant line's readings are taken.
      {
        const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: OFF1, extra: { PATH: `${slow}:${noFlock}` } });
        const stamp = join(S, `started-${n++}`);
        const r = wl(env, ['light', '--', ...stampCmd(stamp)], { cwd: root });
        const g = of(env, 'grant').at(-1);
        t('DS-975 AC6 off, mkdir path: with every reading failing the grant is logged, the readings empty', [r.status, ...empty(g), g?.wait_s], [0, null, null, null, 0]);
        t('DS-975 AC6 off, mkdir path: the command starts before the grant line is read', startedAt(stamp) < Date.parse(g?.at), true);
      }
    } else console.log('skip DS-975 AC6 with a failing sysctl: this is not macOS (test_leases.mjs covers a failing /proc read)');
  }
  // With the slot kind on, runs waiting for a pool are served oldest first, told their place
  // as they wait, and told it again as they give up.
  {
    const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: machine({ 'lease-kinds': 'slot=on', 'test-lock-slots': '1' }) });
    const h = await hold(env, ['light']);
    const a = await hold(env, ['light'], {}, holdSh, { ms: 0 });
    await until(() => a.err().includes('waiting'));
    const b = await hold(env, ['light'], {}, holdSh, { ms: 0 });
    await until(() => b.err().includes('waiting'));
    t('DS-981 AC2 each waiting run says its place in the queue and how many hold the pool',
      [/waiting for the light slot, position 1 of 1 in its queue, 1 of 1 slot held: /.test(a.err()), /position 2 of 2 in its queue, 1 of 1 slot held/.test(b.err())], [true, true]);
    h.release(); await h.done;
    await until(() => existsSync(a.mark) || existsSync(b.mark));
    await sleep(2500);
    t('DS-981 AC1 the slot freed goes to the run that waited first, and the later one waits on', [existsSync(a.mark), existsSync(b.mark)], [true, false]);
    a.release(); await a.done;
    await until(() => existsSync(b.mark));
    t('DS-981 AC1 then the next', existsSync(b.mark), true);
    const r = wl(env, ['light', '--timeout', '2', '--', 'true']);
    t('DS-981 AC6 a run giving up at its deadline exits 75 naming its place then',
      [r.status, /gave up waiting for the light slot after 2s at position 1 of 1 in its queue, 1 of 1 slot held: /.test(r.stderr)], [75, true]);
    b.release(); await b.done;
  }
  // DS-998: with the slot kind on, a run on the lock files with no lease (an older wrapper, played by a
  // run with the kind off on the same lock directory) holds its slot; and every grant line names the release.
  {
    const leases = fresh('l'), locks = fresh('k');
    const home = fresh('h'); writeFileSync(join(home, 'installed.json'), JSON.stringify({ commit: 'c0ffee1' }));
    const ON1 = machine({ 'lease-kinds': 'slot=on', 'test-lock-slots': '1' });
    const on = caseEnv({ leases, locks, profile: ON1, extra: { DESK_HOME: home } });
    const old = await hold(caseEnv({ leases, locks, profile: OFF1, extra: { PATH: noFlock, DESK_HOME: home } }), ['test']);
    const ran = join(S, `ran-${n++}`);
    const r = wl(on, ['test', '--timeout', '2', '--', 'sh', '-c', `: > '${ran}'`]);
    t('DS-998 AC1 every heavy slot held by a lock-file run with no lease: an on run waits and is not granted',
      [r.status, existsSync(ran), /the lock file \S*\/desk-test\.lock\.d \(pid \d+, no lease\)/.test(r.stderr), leaseList(on).length], [75, false, true, 0]);
    old.release(); await old.done;
    // A flock holder file outlives its run: one naming a pid that has exited holds nothing.
    const gone = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(locks, 'desk-test.lock.pid'), `${gone}\n`);
    const r2 = wl(on, ['test', '--timeout', '2', '--', 'sh', '-c', `: > '${ran}'`]);
    t('DS-998 AC2 a lock file whose holder has exited does not count: the on run is granted', [r2.status, existsSync(ran)], [0, true]);
    t('DS-998 AC4 the lock-file run\'s grant line and the lease\'s both name the installed release',
      leaseLog(leases).filter((e) => e.event === 'grant').map((e) => [e.id != null, e.release]), [[false, 'c0ffee1'], [true, 'c0ffee1']]);
    for (const [mode, profile] of [['off', OFF1], ['shadow', SHADOW1]]) {
      const l = fresh('l');
      wl(caseEnv({ leases: l, locks: fresh('k'), profile, extra: { DESK_HOME: home } }), ['test', '--', 'true']);
      t(`DS-998 AC4 kind ${mode}: the grant line names the installed release`, leaseLog(l).filter((e) => e.event === 'grant').map((e) => e.release), ['c0ffee1']);
    }
    const l = fresh('l');
    const r3 = wl(caseEnv({ leases: l, locks: fresh('k'), profile: ON1, extra: { DESK_HOME: fresh('h') } }), ['test', '--', 'true']);
    t('DS-998 AC5 no readable release record: the run is granted, its grant line naming the release unknown', [r3.status, leaseLog(l).filter((e) => e.event === 'grant').map((e) => e.release)], [0, ['unknown']]);
  }
  // DS-977: headroom admission in shadow judges a run that waits, and changes nothing it is granted.
  {
    const admitLines = (env) => leaseLog(env.DESK_LEASE_DIR).filter((e) => e.event === 'would-admit' || e.event === 'would-deny');
    const sample = JSON.stringify({ load_1m: 10, mem_free_pct: 50, mem_total_gb: 80, mem_pressure: 1, compressed_gb: 1 });
    const SHADOW_ADMIT = machine({ 'lease-kinds': 'slot=off', 'lock-admission': 'shadow', 'test-lock-slots': '1', 'light-lock-max': '3', 'test-cap': '4', 'admit-max-load': '30' });
    const UNSET = machine({ 'lease-kinds': 'slot=off', 'test-lock-slots': '2', 'test-cap': '4' });
    for (const [path, extra] of [['mkdir', { PATH: noFlock }], ...(hasFlock ? [['flock', {}]] : [])]) {
      const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: SHADOW_ADMIT, extra: { ...extra, DESK_ADMIT_SAMPLE: sample, DESK_ADMIT_RECHECK_S: '1' } });
      const a = await hold(env, ['light']);
      t(`DS-977 AC11 ${path} path: a run that takes a free floor slot at once logs no admission line`, admitLines(env), []);
      const r = wl(env, ['light', '--timeout', '4', '--', 'true']);
      const ls = admitLines(env);
      t(`DS-977 AC2 ${path} path: a second light run logs a would-admit and still waits for the floor slot`, [r.status, ls.map((l) => [l.event, l.key, l.pool, l.reason])], [75, [['would-admit', 'light', 'light', 'headroom']]]);
      t(`DS-977 AC12 ${path} path: judged again each second for 4 s, the same outcome logs one line`, ls.length, 1);
      a.release(); await a.done;
    }
    // The watcher judging a waiting run is not a second with-lock.sh on ps, which suite-wait.mjs would
    // count as another run waiting on the lock; and it reads the profile afresh, so admission turned off
    // while the run waits stops it.
    {
      const rows = { 'lease-kinds': 'slot=off', 'lock-admission': 'shadow', 'test-lock-slots': '1', 'test-cap': '4', 'admit-max-load': '30' };
      const profile = machine(rows);
      const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile, extra: { DESK_ADMIT_SAMPLE: sample, DESK_ADMIT_RECHECK_S: '1' } });
      const a = await hold(env, ['test']);
      const w = spawn('bash', [script, 'test', '--timeout', '8', '--', 'true'], { env, stdio: 'ignore' });
      const done = new Promise((r) => w.on('exit', r));
      const children = (re) => spawnSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' }).stdout.split('\n')
        .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m) => m && Number(m[2]) === w.pid && re.test(m[3])).map((m) => Number(m[1]));
      // A second in: the wrapper's own brief subshells (the holders it names as it starts to wait) are done.
      await until(() => admitLines(env).length > 0); await sleep(1000);
      const watchers = children(/admission\.mjs\s+watch\s/);
      t('DS-977 while a run waits under shadow, its admission watcher is not a second with-lock.sh test on ps',
        [admitLines(env).length > 0, children(/with-lock\.sh\s+test(\s|$)/).length, watchers.length], [true, 0, 1]);
      writeFileSync(profile, readFileSync(machine({ ...rows, 'lock-admission': 'off' }), 'utf8'));
      t('DS-977 admission turned off while a run waits stops its watcher, the run still waiting',
        [await until(() => watchers.every((p) => !alive(p)), 4000), alive(w.pid)], [true, true]);
      await done; a.release(); await a.done;
    }
    // AC1: no lock-admission row: the heavy pool grants its test-lock-slots, the light pool 1, and no line is logged.
    {
      const env = caseEnv({ leases: fresh('l'), locks: fresh('k'), profile: UNSET, extra: { DESK_ADMIT_SAMPLE: sample, DESK_ADMIT_RECHECK_S: '1' } });
      const a = await hold(env, ['test']); const b = await hold(env, ['test']);
      t('DS-977 AC1 with no lock-admission row the heavy pool grants both its slots', [existsSync(a.mark), existsSync(b.mark)], [true, true]);
      const h = await hold(env, ['light']);
      const r = wl(env, ['light', '--timeout', '3', '--', 'true']);
      t('DS-977 AC1 the light pool grants 1, and no admission line is logged', [r.status, admitLines(env)], [75, []]);
      a.release(); b.release(); h.release(); await a.done; await b.done; await h.done;
    }
  }
} finally {
  for (const h of held) { h.release(); if (h.c.exitCode === null) h.c.kill(); }
  rmSync(S, { recursive: true, force: true });
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
