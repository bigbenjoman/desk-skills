// suite: with-lock (the lock classes its usage line lists are exactly the ones it accepts; each run takes its slot as a lease)
// layer: L2
// covers: desk/bin/with-lock.sh desk/bin/prose-facts.mjs desk/bin/slot-lease.mjs
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
for (const tool of ['bash', 'sh', 'node', 'git', 'mkdir', 'cat', 'rm', 'mv', 'find', 'sleep', 'dirname', 'ps', 'true', 'pwd']) {
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
const hold = async (env, args, opts = {}, cmd = holdSh) => {
  const mark = join(S, `held-${n++}`);
  const c = spawn('bash', [script, ...args, '--', ...cmd(mark)], { env, stdio: ['ignore', 'ignore', 'pipe'], ...opts });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  // 'exit', not 'close': a wrapper SIGKILLed leaves its stderr open in the command it ran.
  const h = { c, mark, err: () => err, release: () => writeFileSync(`${mark}.go`, ''), done: new Promise((r) => c.on('exit', (code) => r(code))) };
  held.push(h);
  for (let i = 0; i < 200 && !existsSync(mark); i++) await sleep(50);
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
    t(`DS-909 AC6 kind off, ${path} path: no lease is taken`, [existsSync(join(env.DESK_LEASE_DIR, 'leases.json')), leaseLog(env.DESK_LEASE_DIR).length], [false, 0]);
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
} finally {
  for (const h of held) { h.release(); if (h.c.exitCode === null) h.c.kill(); }
  rmSync(S, { recursive: true, force: true });
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
