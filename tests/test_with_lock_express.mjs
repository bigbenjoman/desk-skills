// suite: with-lock express lane (light-express-lane on: a small light run finding every pool slot held takes the lane; a large run never does; its grant line; admission counts it)
// layer: L2
// covers: desk/bin/with-lock.sh desk/bin/admission.mjs desk/bin/admit-ledger.mjs desk/bin/slot-lease.mjs desk/bin/machine.mjs
// Real wrapper runs against a scratch lock directory, lease directory and machine profile per case,
// on the mkdir path and, where flock(1) exists, the flock path. A small run is one called with
// DESK_LIGHT_SMALL=1, as tests/related.sh calls it.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'desk', 'bin', 'with-lock.sh');
const S = scratch('with-lock-express-');
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
const reading = ({ load = 10, freeGb = 40, pressure = 1 } = {}) => ({ load_1m: load, mem_free_pct: freeGb / 80 * 100, mem_total_gb: 80, mem_pressure: pressure, compressed_gb: 1 });
const ROWS = { 'lease-kinds': 'slot=off', 'light-express-lane': 'on', 'light-lock-slots': '1', 'light-lock-max': '1', 'test-cap': '4' };
const caseOf = ({ rows = ROWS, sample = reading(), extra = {} } = {}) => {
  const c = { locks: fresh('k'), leases: fresh('l'), profile: machine(rows), sampleFile: join(S, `sample-${n++}.json`) };
  writeFileSync(c.sampleFile, JSON.stringify(sample));
  c.env = { ...process.env, HOME: S, DESK_LEASE_DIR: c.leases, DESK_LOCK_DIR: c.locks, DESK_MACHINE: c.profile, DESK_CONFIG: join(S, 'no-config.md'),
    DESK_ADMIT_SAMPLE: `@${c.sampleFile}`, DESK_ADMIT_RECHECK_S: '2', ...extra };
  delete c.env.DESK_TEST_LOCK_SLOTS; delete c.env.DESK_LIGHT_SMALL;
  c.small = { ...c.env, DESK_LIGHT_SMALL: '1' };
  c.readings = (r) => writeFileSync(c.sampleFile, JSON.stringify(r));
  return c;
};
const log = (c) => (existsSync(join(c.leases, 'leases.log.jsonl')) ? readFileSync(join(c.leases, 'leases.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const grants = (c) => log(c).filter((e) => e.event === 'grant').map((e) => e.lane ?? 'pool');
const wl = (env, args) => spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const held = [];
const hold = async (env, args, { ms = 10_000 } = {}) => {
  const mark = join(S, `held-${n++}`);
  const c = spawn('bash', [script, ...args, '--', 'sh', '-c', `: > '${mark}'; while [ ! -e '${mark}.go' ]; do sleep 0.05; done`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  const h = { c, mark, t0: Date.now(), err: () => err, started: () => existsSync(mark), release: () => writeFileSync(`${mark}.go`, ''), done: new Promise((r) => c.on('exit', (code) => r(code))) };
  held.push(h);
  for (let i = 0; i < ms / 50 && !existsSync(mark); i++) await sleep(50);
  return h;
};
// The light lock's holders by where they hold it: pool slot numbers, and `express` for the lane.
const holding = (c) => readdirSync(c.locks).flatMap((f) => {
  const m = /^desk-light(-express)?\.lock(?:\.(\d+))?(\.d|\.pid)$/.exec(f);
  if (!m) return [];
  const file = m[3] === '.d' ? join(c.locks, f, 'pid') : join(c.locks, f);
  const pids = existsSync(file) ? readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number) : [];
  return pids.some(alive) ? [m[1] ? 'express' : Number(m[2] ?? 1)] : [];
}).sort();
const ledger = (c) => (existsSync(join(c.locks, 'desk-admit.ledger')) ? readFileSync(join(c.locks, 'desk-admit.ledger'), 'utf8').trim().split('\n').map((l) => l.split(' ')[5]) : []);

try {
  for (const [path, extra] of PATHS) {
    const c = caseOf({ extra });
    const full = await hold(c.env, ['light']);
    // AC3: a large run (not called small) waits for a pool slot and never takes the lane.
    const big = wl(c.env, ['light', '--timeout', '2', '--', 'true']);
    t(`DS-980 AC3 ${path} path: the pool full, a large run waits for it (75) and never takes the free lane`, [big.status, holding(c)], [75, [1]]);
    // AC2, AC7: a small run starts at once in the lane, says so, and its grant line names it.
    const t0 = Date.now();
    const r = wl(c.small, ['light', '--timeout', '30', '--', 'sh', '-c', 'echo "small=${DESK_LIGHT_SMALL:-unset}"']);
    t(`DS-980 AC2 ${path} path: the pool full and the lane free, a small run starts at once`, [r.status, r.stdout.trim(), Date.now() - t0 < 5000], [0, 'small=unset', true]);
    t(`DS-980 AC2 ${path} path: and says it takes the express lane`, /^with-lock\.sh: all light slots it may take are held, so this small run takes the express lane$/m.test(r.stderr), true);
    t(`DS-980 AC7 ${path} path: its grant line in the lease log names the express lane`, grants(c), ['pool', 'express']);
    // AC4: a small run holds the lane; a second small run waits for either, and takes the pool slot when it frees.
    const lane = await hold(c.small, ['light']);
    t(`DS-980 AC4 ${path} path: a small run holds the lane beside the full pool`, holding(c), [1, 'express']);
    const second = await hold(c.small, ['light'], { ms: 3000 });
    t(`DS-980 AC4 ${path} path: a second small run waits while the pool and the lane are held`, [second.started(), /all 1 slots and the express lane held/.test(second.err())], [false, true]);
    full.release(); await full.done;
    for (let i = 0; i < 100 && !second.started(); i++) await sleep(50);
    t(`DS-980 AC4 ${path} path: it takes the pool slot once that frees, beside the lane`, [second.started(), holding(c)], [true, [1, 'express']]);
    second.release(); lane.release();
    t(`DS-980 ${path} path: each run's command keeps its status`, await Promise.all([second.done, lane.done]), [0, 0]);
    // AC4: with a free pool slot, a small run takes it, not the lane.
    const free = wl(c.small, ['light', '--timeout', '0', '--', 'true']);
    t(`DS-980 AC4 ${path} path: a free pool slot is taken before the lane`, [free.status, grants(c).at(-1)], [0, 'pool']);
  }
  // AC8: a profile with no express lane row: a small run waits as today.
  {
    const rows = { ...ROWS }; delete rows['light-express-lane'];
    const c = caseOf({ rows });
    const a = await hold(c.env, ['light']);
    const r = wl(c.small, ['light', '--timeout', '2', '--', 'true']);
    t('DS-980 AC8 no light-express-lane row: a small run waits for the pool as today (75), with today\'s line',
      [r.status, /^with-lock\.sh: waiting for light lock \(held by pid /m.test(r.stderr), holding(c)], [75, true, [1]]);
    a.release(); await a.done;
  }
  // The row set off, or to a value that does not read: the lane stays shut.
  for (const v of ['off', 'yes']) {
    const c = caseOf({ rows: { ...ROWS, 'light-express-lane': v } });
    const a = await hold(c.env, ['light']);
    const r = wl(c.small, ['light', '--timeout', '2', '--', 'true']);
    t(`DS-980 light-express-lane ${v}: a small run waits for the pool`, r.status, 75);
    a.release(); await a.done;
  }
  // The slot lease kind shadow: an express grant takes no light lease, which would count against the pool.
  {
    const c = caseOf({ rows: { ...ROWS, 'lease-kinds': 'slot=shadow' } });
    const a = await hold(c.env, ['light']);
    const r = wl(c.small, ['light', '--timeout', '5', '--', 'true']);
    const refused = log(c).filter((e) => e.event === 'would-refuse');
    t('DS-980 slot lease shadow: the express grant takes no lease and logs no would-refuse', [r.status, grants(c).at(-1), refused.length], [0, 'express', 0]);
    a.release(); await a.done;
  }
  // AC9: admission on, the floor held and no headroom, so a small run takes the lane; once the readings
  // show room for one run, the next light run is judged with the express grant among the recent admits
  // at light-run-gb, and that leaves no room.
  {
    const rows = { ...ROWS, 'lock-admission': 'on', 'light-lock-max': '3', 'admit-max-load': '30', 'admit-ramp-s': '90', 'light-run-gb': '12', 'admit-reserve-gb': '8' };
    const c = caseOf({ rows, sample: reading({ load: 50 }) });
    const a = await hold(c.env, ['light']);
    const lane = await hold(c.small, ['light'], { ms: 5000 });
    t('DS-980 AC9 with no headroom a small run takes the lane', [lane.started(), holding(c), ledger(c)], [true, [1, 'express'], ['express']]);
    // 30 GB free: one run of 12 GB leaves 18, over the 8 reserve; the express grant's 12 too leaves 6.
    c.readings(reading({ freeGb: 30 }));
    const r = wl(c.env, ['light', '--timeout', '3', '--', 'true']);
    const deny = log(c).filter((e) => e.event === 'deny').at(-1);
    t('DS-980 AC9 the next run\'s admission counts the express grant among the recent admits, at light-run-gb', [r.status, deny?.reason, deny?.recent_admits, deny?.recent_gb, deny?.held], [75, 'memory', 1, 12, 1]);
    lane.release(); await lane.done;
    const b = await hold(c.env, ['light'], { ms: 6000 });
    t('DS-980 AC9 once the express run ends it no longer counts, and the run is let in above the floor', [b.started(), holding(c)], [true, [1, 2]]);
    a.release(); b.release(); await a.done; await b.done;
  }
} finally {
  for (const h of held) { h.release(); if (h.c.exitCode === null) h.c.kill(); }
  rmSync(S, { recursive: true, force: true });
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
