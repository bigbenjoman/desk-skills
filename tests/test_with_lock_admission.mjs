// suite: with-lock admission (lock-admission on: a run finding its pool's floor full takes a slot above it on headroom, up to the ceiling; the waiting line; the revert; an older wrapper beside it; the broker's pool)
// layer: L2
// covers: desk/bin/with-lock.sh desk/bin/admission.mjs desk/bin/admit-ledger.mjs desk/bin/slot-lease.mjs desk/bin/leases.mjs
// Real wrapper runs against a scratch lock directory, lease directory and machine profile per case,
// with fixture readings in a file the case can change while a run waits (DESK_ADMIT_SAMPLE=@<file>).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'desk', 'bin', 'with-lock.sh');
const S = scratch('with-lock-admit-');
let n = 0;
const fresh = (p) => { const d = join(S, `${p}${n++}`); mkdirSync(d, { recursive: true }); return d; };
const profileText = (rows) => `## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n${Object.entries(rows).map(([k, v]) => `| \`${k}\` | \`${v}\` | test |`).join('\n')}\n`;
const machine = (rows) => { const p = join(S, `machine-${n++}.md`); writeFileSync(p, profileText(rows)); return p; };
// A PATH with no flock(1), so the mkdir fallback runs wherever this does.
const noFlock = fresh('bin');
for (const tool of ['bash', 'sh', 'node', 'git', 'mkdir', 'cat', 'rm', 'mv', 'find', 'sleep', 'dirname', 'ps', 'true', 'pwd', 'sysctl']) {
  const at = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
  if (at.startsWith('/')) symlinkSync(at, join(noFlock, tool));
}
const hasFlock = spawnSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).status === 0;
const PATHS = [['mkdir', { PATH: noFlock }], ...(hasFlock ? [['flock', {}]] : [])];

// GB free from mem_free_pct of 80 GB.
const reading = ({ load = 10, freeGb = 40, pressure = 1 } = {}) => ({ load_1m: load, mem_free_pct: freeGb == null ? null : freeGb / 80 * 100, mem_total_gb: 80, mem_pressure: pressure, compressed_gb: 1 });
const ROWS = { 'lease-kinds': 'slot=off', 'lock-admission': 'on', 'test-lock-slots': '1', 'test-lock-max': '3', 'light-lock-slots': '1', 'light-lock-max': '3',
  'test-cap': '4', 'admit-max-load': '30', 'admit-ramp-s': '0' };
// One case: its lock and lease directories, its profile and its readings file.
const caseOf = ({ rows = ROWS, sample = reading(), extra = {} } = {}) => {
  const c = { locks: fresh('k'), leases: fresh('l'), profile: machine(rows), sampleFile: join(S, `sample-${n++}.json`) };
  writeFileSync(c.sampleFile, JSON.stringify(sample));
  c.env = { ...process.env, HOME: S, DESK_LEASE_DIR: c.leases, DESK_LOCK_DIR: c.locks, DESK_MACHINE: c.profile, DESK_CONFIG: join(S, 'no-config.md'),
    DESK_ADMIT_SAMPLE: `@${c.sampleFile}`, DESK_ADMIT_RECHECK_S: '2', ...extra };
  delete c.env.DESK_TEST_LOCK_SLOTS;
  c.readings = (r) => writeFileSync(c.sampleFile, JSON.stringify(r));
  return c;
};
const log = (c) => (existsSync(join(c.leases, 'leases.log.jsonl')) ? readFileSync(join(c.leases, 'leases.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const admitLines = (c) => log(c).filter((e) => e.event === 'admit' || e.event === 'deny');
const wl = (env, args, opts = {}) => spawnSync('bash', [script, ...args], { env, encoding: 'utf8', ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A run that holds its lock until release(): resolves once its command has started, or after `ms`.
const held = [];
const hold = async (env, args, { script: s = script, ms = 10_000 } = {}) => {
  const mark = join(S, `held-${n++}`);
  const c = spawn('bash', [s, ...args, '--', 'sh', '-c', `: > '${mark}'; while [ ! -e '${mark}.go' ]; do sleep 0.05; done`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  const h = { c, mark, t0: Date.now(), err: () => err, started: () => existsSync(mark), release: () => writeFileSync(`${mark}.go`, ''), done: new Promise((r) => c.on('exit', (code) => r(code))) };
  held.push(h);
  for (let i = 0; i < ms / 50 && !existsSync(mark); i++) await sleep(50);
  return h;
};
// The slot each holder's lock files name it in: `<lock>.<i>` for slot i above 1, on either path.
const slotsHeld = (c, lock) => readdirSync(c.locks).flatMap((f) => {
  const m = new RegExp(`^desk-${lock}\\.lock(?:\\.(\\d+))?(\\.d|\\.pid)$`).exec(f);
  if (!m) return [];
  const file = m[2] === '.d' ? join(c.locks, f, 'pid') : join(c.locks, f);
  const pids = existsSync(file) ? readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number) : [];
  return pids.some(alive) ? [Number(m[1] ?? 1)] : [];
}).sort();

try {
  for (const [path, extra] of PATHS) {
    // AC1: light floor 1 held, room for another: a second light run starts at once in a slot above the
    // floor, and the lease log records an admit line with the readings and the reason.
    {
      const c = caseOf({ extra });
      const a = await hold(c.env, ['light']);
      const b = await hold(c.env, ['light'], { ms: 5000 });
      const [l] = admitLines(c);
      t(`DS-987 AC1 ${path} path: a second light run with room starts at once`, [a.started(), b.started(), Date.now() - b.t0 < 5000], [true, true, true]);
      t(`DS-987 AC1 ${path} path: in a slot above the floor`, slotsHeld(c, 'light'), [1, 2]);
      t(`DS-987 AC1 ${path} path: an admit line with the readings and the reason`, [l?.event, l?.reason, l?.load_1m, l?.mem_free_gb, l?.mem_pressure, l?.held, l?.floor, l?.ceiling], ['admit', 'headroom', 10, 40, 1, 1, 1, 3]);
      // AC3: the pool holding its ceiling of 3, a fourth run waits whatever the readings.
      const b2 = await hold(c.env, ['light'], { ms: 5000 });
      const r = wl(c.env, ['light', '--timeout', '3', '--', 'true']);
      t(`DS-987 AC3 ${path} path: at the ceiling of 3, a fourth light run with room waits (exit 75 at its timeout)`, [b2.started(), slotsHeld(c, 'light'), r.status], [true, [1, 2, 3], 75]);
      t(`DS-987 AC3 ${path} path: and says it is at its ceiling`, /^with-lock\.sh: waiting for light lock: 3 of 1\.\.3 held; at its ceiling/m.test(r.stderr), true);
      for (const h of [a, b, b2]) h.release();
      t(`DS-987 ${path} path: each run's command keeps its status`, await Promise.all([a.done, b.done, b2.done]), [0, 0, 0]);
    }
  }
  // AC2: a free floor slot is granted at once with no room at all, and no admission line is logged.
  {
    const c = caseOf({ sample: reading({ load: 99, freeGb: 1, pressure: 4 }) });
    const r = wl(c.env, ['light', '--timeout', '0', '--', 'true']);
    t('DS-987 AC2 a free floor slot is granted at once though the readings show no room', [r.status, r.stderr, admitLines(c)], [0, '', []]);
  }
  // AC4, AC9: a full floor and a load that cannot be read: the run waits for the floor, a deny line
  // names the reading, and at its timeout the wrapper exits 75 as before.
  {
    const c = caseOf({ sample: reading({ load: null }) });
    const a = await hold(c.env, ['light']);
    const ran = join(S, `ran-${n++}`);
    const r = wl(c.env, ['light', '--timeout', '3', '--', 'sh', '-c', `: > '${ran}'`]);
    t('DS-987 AC4 AC9 an unreadable load: the run waits, then exits 75 at its timeout and runs nothing', [r.status, existsSync(ran)], [75, false]);
    t('DS-987 AC4 a deny line names the reading that could not be taken', admitLines(c).map((e) => [e.event, e.reason]), [['deny', 'load-unreadable']]);
    a.release(); await a.done;
  }
  // A zero-padded recheck interval is read as the default, never as octal: the run still waits for
  // the floor and runs nothing until it is granted.
  for (const [path, extra] of PATHS) {
    const c = caseOf({ sample: reading({ load: null }), extra: { ...extra, DESK_ADMIT_RECHECK_S: '08' } });
    const a = await hold(c.env, ['light']);
    const ran = join(S, `ran-${n++}`);
    const r = wl(c.env, ['light', '--timeout', '3', '--', 'sh', '-c', `: > '${ran}'`]);
    t(`DS-987 ${path} path: a recheck of 08 still waits for the floor, exits 75 and runs nothing`, [r.status, existsSync(ran)], [75, false]);
    a.release(); await a.done;
  }
  // AC5, AC6: two light runs held, the load leaving no room: a third prints one line in the agreed form,
  // and no more while its reason holds.
  {
    const c = caseOf();
    const a = await hold(c.env, ['light']); const b = await hold(c.env, ['light'], { ms: 5000 });
    c.readings(reading({ load: 29.6, freeGb: 33, pressure: 2 }));
    const r = wl(c.env, ['light', '--timeout', '8', '--', 'true']);
    const said = r.stderr.split('\n').filter((l) => l.startsWith('with-lock.sh: waiting'));
    t('DS-987 AC5 the waiting line names the pool, the slots held, the floor and ceiling, and the reason with its numbers',
      said, ['with-lock.sh: waiting for light lock: 2 of 1..3 held; no headroom: load 29.6 + 4 > 30 (pressure warn, 33 GB free, 16 GB/run)']);
    t('DS-987 AC6 rechecked every 2 s for 8 s, the reason unchanged: one waiting line and one deny line', [said.length, admitLines(c).filter((e) => e.event === 'deny').length], [1, 1]);
    a.release(); b.release(); await a.done; await b.done;
  }
  // AC8: a run waiting for headroom with the floor full starts above the floor within 10 s of the
  // readings showing room, at the default recheck.
  {
    const c = caseOf({ sample: reading({ load: 50 }) });
    delete c.env.DESK_ADMIT_RECHECK_S;
    const a = await hold(c.env, ['light']);
    const b = await hold(c.env, ['light'], { ms: 3000 });
    t('DS-987 AC8 with no room, the second light run waits', b.started(), false);
    const at = Date.now();
    c.readings(reading());
    for (let i = 0; i < 240 && !b.started(); i++) await sleep(50);
    t('DS-987 AC8 once the readings show room it starts above the floor within 10 s', [b.started(), Date.now() - at <= 10_500, slotsHeld(c, 'light')], [true, true, [1, 2]]);
    a.release(); b.release(); await a.done; await b.done;
  }
  // AC10: lock-admission set off: the next run is granted only floor slots, and the run above the floor
  // finishes undisturbed.
  {
    const c = caseOf();
    const a = await hold(c.env, ['light']); const b = await hold(c.env, ['light'], { ms: 5000 });
    writeFileSync(c.profile, profileText({ ...ROWS, 'lock-admission': 'off' }));
    const r = wl(c.env, ['light', '--timeout', '3', '--', 'true']);
    t('DS-987 AC10 admission set off: the next run gets no slot above the floor', [b.started(), r.status, slotsHeld(c, 'light')], [true, 75, [1, 2]]);
    b.release();
    t('DS-987 AC10 the run above the floor finishes undisturbed', [await b.done, alive(a.c.pid)], [0, true]);
    a.release(); await a.done;
  }
  // With lock-admission on and a ceiling at the floor there is no slot to admit to: the lock is today's,
  // with today's waiting line and no admission line.
  {
    const c = caseOf({ rows: { ...ROWS, 'light-lock-max': '1' } });
    const a = await hold(c.env, ['light']);
    const r = wl(c.env, ['light', '--timeout', '3', '--', 'true']);
    t('DS-987 on with the light ceiling at its floor of 1: the run waits as today, with today\'s line',
      [r.status, /^with-lock\.sh: waiting for light lock \(held by pid /m.test(r.stderr), admitLines(c)], [75, true, []]);
    a.release(); await a.done;
  }
  // AC13: lock-admission shadow grants only floor slots, as DS-977 leaves it.
  {
    const c = caseOf({ rows: { ...ROWS, 'lock-admission': 'shadow' } });
    const a = await hold(c.env, ['light']);
    const r = wl(c.env, ['light', '--timeout', '3', '--', 'true']);
    t('DS-987 AC13 shadow: a second light run with room still waits for the floor', [r.status, slotsHeld(c, 'light'), admitLines(c)], [75, [1], []]);
    a.release(); await a.done;
  }
  // AC11: a wrapper of an older release, which reads lock-admission on as a row it does not know and so
  // grants the floor alone, beside this one on the heavy pool: no slot is held by two runs, and the older
  // one takes only the floor. It is this script run with the profile it would read: admission off.
  {
    const c = caseOf();
    const older = { ...c.env, DESK_MACHINE: machine({ ...ROWS, 'lock-admission': 'off' }) };
    const a = await hold(c.env, ['test']); const b = await hold(c.env, ['test'], { ms: 5000 });
    const o = await hold(older, ['test'], { ms: 3000 });
    t('DS-987 AC11 the older wrapper waits while the floor is held, though a slot above it is free', [a.started(), b.started(), o.started(), slotsHeld(c, 'test')], [true, true, false, [1, 2]]);
    a.release(); await a.done;
    for (let i = 0; i < 100 && !o.started(); i++) await sleep(50);
    t('DS-987 AC11 it takes the floor slot once it frees, beside the run above the floor', [o.started(), slotsHeld(c, 'test'), alive(b.c.pid)], [true, [1, 2], true]);
    b.release(); o.release(); await b.done; await o.done;
  }
  // With the slot lease kind on, the broker's light pool grows by the run admitted above its floor.
  {
    const c = caseOf({ rows: { ...ROWS, 'lease-kinds': 'slot=on', 'light-lock-max': '2' } });
    const a = await hold(c.env, ['light']);
    const b = await hold(c.env, ['light'], { ms: 6000 });
    const leases = spawnSync(process.execPath, [join(root, 'desk', 'bin', 'leases.mjs'), 'list', '--json'], { env: c.env, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    t('DS-987 slot lease on: a second light run with room is admitted and holds a light lease beside the first', [b.started(), leases.map((l) => l.key), admitLines(c).map((e) => e.event)], [true, ['light', 'light'], ['admit']]);
    const r = wl(c.env, ['light', '--timeout', '3', '--', 'true']);
    t('DS-987 slot lease on: at the ceiling a run waits as before', r.status, 75);
    a.release(); b.release(); await a.done; await b.done;
  }
} finally {
  for (const h of held) { h.release(); if (h.c.exitCode === null) h.c.kill(); }
  rmSync(S, { recursive: true, force: true });
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
