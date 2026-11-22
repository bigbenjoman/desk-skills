// suite: admission (headroom admission in shadow: would-admit and would-deny on fixture readings, the ledger of recent admits, the admission lock)
// layer: L2
// covers: desk/bin/admission.mjs desk/bin/machine.mjs
// admit() against a scratch lock directory and lease log, with fixture readings and a fixed clock; the
// CLI as eight real processes for the admission lock.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admit, judge, ledgerFile, parseLedger, pressureLevel } from '../desk/bin/admission.mjs';
import { admissionRows } from '../desk/bin/machine.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = scratch('admission-');
let n = 0;
const fresh = () => { const d = join(S, `c${n++}`); mkdirSync(d, { recursive: true }); return d; };

// A profile's rows as desk-env would read them, and the readings: GB free from mem_free_pct of 80 GB.
const BASE = { 'lock-admission': 'shadow', 'test-lock-slots': '2', 'test-lock-max': '4', 'light-lock-slots': '1', 'light-lock-max': '3',
  'admit-max-load': '30', 'admit-run-load': '4', 'cpu-cores': '18', 'test-cap': '4' };
const envOf = (rows) => ({ machineValue: (k) => rows[k] ?? null, testLockSlots: () => Number(rows['test-lock-slots'] ?? 1) });
const reading = ({ load = 10, freeGb = 40, pressure = 1 } = {}) => ({ load_1m: load, mem_free_pct: freeGb == null ? null : freeGb / 80 * 100, mem_total_gb: 80, mem_pressure: pressure, compressed_gb: 1 });
const T0 = 1_800_000_000_000;
const lines = (dir) => (existsSync(join(dir, 'leases.log.jsonl')) ? readFileSync(join(dir, 'leases.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
// One run starting to wait: its pool's floor `held` full, judged against case directory `dir`.
const wait = (dir, { cls = 'light', pid = process.pid, rows = BASE, held = 1, sample = reading(), now = T0, last = null, isAlive = () => true } = {}) =>
  admit({ cls, pid, last, env: envOf(rows), dir, logDir: dir, held, sample, platform: 'darwin', now: () => now, isAlive });
const ledger = (dir, entries) => writeFileSync(ledgerFile(dir), entries.map((e) => `${e.at} ${e.pool} ${e.pid} ${e.gb} ${e.load}\n`).join(''));

// AC2: a second light run, one holding the floor slot, has headroom: the would-admit names everything.
{
  const d = fresh();
  t('DS-977 AC2 the key it returns', wait(d), 'would-admit:headroom');
  const [l] = lines(d);
  t('DS-977 AC2 the line names the pool, the readings, the recent admits, the projections and the reason',
    [l.event, l.key, l.pool, l.load_1m, l.mem_free_gb, l.mem_pressure, l.recent_admits, l.projected_load, l.projected_free_gb, l.reason],
    ['would-admit', 'light', 'light', 10, 40, 1, 0, 14, 24, 'headroom']);
  t('DS-977 AC2 the would-admit is in the ledger', parseLedger(readFileSync(ledgerFile(d), 'utf8')).map((e) => [e.pool, e.pid, e.gb]), [['light', process.pid, 16]]);
}
// AC3: load 28 + 4 is over 30.
{
  const d = fresh();
  wait(d, { sample: reading({ load: 28 }) });
  t('DS-977 AC3 a full light floor at load 28 is a would-deny naming load', lines(d).map((l) => [l.event, l.reason, l.projected_load]), [['would-deny', 'load', 32]]);
}
// AC4: free memory less a recent admit's 16 GB and this run's 16 GB is under the 8 GB reserve.
{
  const d = fresh();
  ledger(d, [{ at: T0 / 1000 - 10, pool: 'heavy', pid: process.ppid, gb: 16, load: 10 }]);
  wait(d, { sample: reading({ freeGb: 30 }) });
  t('DS-977 AC4 memory below the reserve once the recent admits and this run are counted is a would-deny naming memory',
    lines(d).map((l) => [l.event, l.reason, l.recent_gb, l.projected_free_gb]), [['would-deny', 'memory', 16, -2]]);
}
// AC5: pressure at warn with admit-max-pressure 2.
{
  const d = fresh();
  wait(d, { rows: { ...BASE, 'admit-max-pressure': '2' }, sample: reading({ pressure: 2 }) });
  t('DS-977 AC5 pressure at warn is a would-deny naming pressure', lines(d).map((l) => [l.event, l.reason, l.mem_pressure]), [['would-deny', 'pressure', 2]]);
}
// AC6, AC7: a third heavy run, two would-admits logged in the last 90 s, then the same with them older.
{
  const d = fresh();
  const recent = (age) => [{ at: T0 / 1000 - age, pool: 'heavy', pid: process.ppid, gb: 16, load: 20 }, { at: T0 / 1000 - age, pool: 'light', pid: 1, gb: 16, load: 20 }];
  ledger(d, recent(30));
  wait(d, { cls: 'test', held: 2, sample: reading({ load: 20 }) });
  t('DS-977 AC6 two recent would-admits: a would-deny naming load that counts them', lines(d).map((l) => [l.event, l.pool, l.reason, l.recent_admits, l.projected_load]), [['would-deny', 'heavy', 'load', 2, 32]]);
  const d2 = fresh();
  ledger(d2, recent(90));
  wait(d2, { cls: 'test', held: 2, sample: reading({ load: 20 }) });
  t('DS-977 AC7 the same two older than admit-ramp-s: a would-admit', lines(d2).map((l) => [l.event, l.reason, l.recent_admits]), [['would-admit', 'headroom', 0]]);
  const d3 = fresh();
  ledger(d3, recent(30));
  wait(d3, { cls: 'test', held: 2, sample: reading({ load: 20 }), isAlive: () => false });
  t('DS-977 a recent admit whose pid has exited is dropped from the ledger', [lines(d3)[0].recent_admits, parseLedger(readFileSync(ledgerFile(d3), 'utf8')).map((e) => e.pid)], [0, [process.pid]]);
}
// AC8: each reading that cannot be taken is a would-deny naming it.
{
  const got = [{ load: null }, { freeGb: null }, { pressure: null }].map((r) => { const d = fresh(); wait(d, { sample: reading(r) }); return lines(d).map((l) => [l.event, l.reason])[0]; });
  t('DS-977 AC8 a reading that cannot be taken is a would-deny naming it', got, [['would-deny', 'load-unreadable'], ['would-deny', 'memory-unreadable'], ['would-deny', 'pressure-unreadable']]);
  const d = fresh();
  wait(d, { sample: { load_1m: null, mem_free_pct: null, mem_total_gb: null, mem_pressure: null } });
  t('DS-977 AC8 every reading empty is still one would-deny', lines(d).map((l) => l.event), ['would-deny']);
}
// AC10: light-lock-max equal to the light floor denies on the ceiling whatever the readings.
{
  const d = fresh();
  wait(d, { rows: { ...BASE, 'light-lock-max': '1' }, sample: reading({ load: 0, freeGb: 80 }) });
  t('DS-977 AC10 a ceiling equal to the floor is a would-deny naming the ceiling', lines(d).map((l) => [l.event, l.reason]), [['would-deny', 'ceiling']]);
  const d2 = fresh();
  wait(d2, { rows: { ...BASE, 'light-lock-max': '1' }, sample: reading({ load: null }) });
  t('DS-977 AC10 the ceiling is named before a reading that cannot be taken', lines(d2).map((l) => l.reason), ['ceiling']);
}
// AC12: a run judged again with the same outcome and reason logs nothing more; a change logs one.
{
  const d = fresh();
  let key = null;
  for (let s = 0; s <= 300; s += 30) key = wait(d, { sample: reading({ load: 28 }), now: T0 + s * 1000, last: key });
  t('DS-977 AC12 five minutes waited, the outcome and reason unchanged: one line', lines(d).length, 1);
  wait(d, { sample: reading({ load: 10 }), now: T0 + 330_000, last: key });
  t('DS-977 AC12 an outcome that changes logs a second', lines(d).map((l) => `${l.event}:${l.reason}`), ['would-deny:load', 'would-admit:headroom']);
  const again = wait(d, { sample: reading({ load: 10 }), now: T0 + 340_000, last: 'would-admit:headroom' });
  t('DS-977 a run judged again is not counted against itself, and adds no second ledger entry',
    [again, lines(d).length, parseLedger(readFileSync(ledgerFile(d), 'utf8')).length], ['would-admit:headroom', 2, 1]);
}
// The floor: a light floor of 2 with one slot held is a would-admit on the floor, no readings needed.
{
  const d = fresh();
  wait(d, { rows: { ...BASE, 'light-lock-slots': '2' }, sample: reading({ load: null }) });
  t('DS-977 a free floor slot is a would-admit on the floor', lines(d).map((l) => [l.event, l.reason, l.floor]), [['would-admit', 'floor', 2]]);
}
// AC1, AC13: admission off, unset or a row that does not read: nothing is judged or logged.
{
  const cases = [{ 'lock-admission': 'off' }, { 'lock-admission': null }, { 'lock-admission': 'on' }, { 'admit-max-load': 'thirty' }, { 'light-lock-slots': '0' }, { 'light-lock-max': '0' }, { 'test-lock-max': '1' }];
  const got = cases.map((c) => { const d = fresh(); const rows = { ...BASE }; for (const [k, v] of Object.entries(c)) { if (v == null) delete rows[k]; else rows[k] = v; } return [wait(d, { rows }), lines(d).length, existsSync(ledgerFile(d))]; });
  t('DS-977 AC1 AC13 admission off, unset, on, or a row that does not read logs nothing', got, cases.map(() => [null, 0, false]));
}
// The rows' defaults (the ticket's), and each problem named with what it wants.
{
  const { rows, problems, mode } = admissionRows((k) => ({ 'lock-admission': 'shadow', 'cpu-cores': '18', 'test-cap': '4', 'test-lock-slots': '3' })[k] ?? null);
  t('DS-977 the admission rows\' defaults', [mode, problems, rows['light-lock-slots'], rows['light-lock-max'], rows['test-lock-max'], rows['admit-max-load'], rows['admit-run-load'], rows['admit-reserve-gb'], rows['heavy-run-gb'], rows['light-run-gb'], rows['admit-max-pressure'], rows['admit-ramp-s']],
    ['shadow', [], 1, 1, 3, 30, 4, 8, 16, 16, 2, 90]);
  const bad = admissionRows((k) => ({ 'lock-admission': 'on', 'light-lock-slots': '0', 'test-lock-slots': '3', 'test-lock-max': '2', 'admit-reserve-gb': 'lots', 'test-cap': '4' })[k] ?? null);
  t('DS-977 AC13 each broken row is named with what it wants, and admission is off', [bad.mode, bad.problems], ['off', [
    '`lock-admission` is "on": want off or shadow',
    '`light-lock-slots` is "0": want a whole number of slots, 1 or more',
    '`admit-reserve-gb` is "lots": want a number of GB to keep free',
    '`test-lock-max` is "2": want a whole number of slots, at least `test-lock-slots` (3)',
  ]]);
}
// Linux's pressure reading is a PSI %, read as macOS's levels.
t('DS-977 Linux PSI some avg10 read as levels', [0, 9.9, 10, 39, 40, null].map((p) => pressureLevel({ mem_pressure: p }, 'linux')), [1, 1, 2, 2, 4, null]);
t('DS-977 macOS\'s level is read as it is', pressureLevel({ mem_pressure: 4 }, 'darwin'), 4);
t('DS-977 judge is pure: the same input, the same answer', JSON.stringify(judge({ pool: 'light', held: 1, sample: reading(), level: 1, recent: [], rows: admissionRows((k) => BASE[k] ?? null).rows })),
  JSON.stringify(judge({ pool: 'light', held: 1, sample: reading(), level: 1, recent: [], rows: admissionRows((k) => BASE[k] ?? null).rows })));

// AC9: eight light runs starting to wait in the same second, as eight processes: one would-admit.
{
  const d = fresh();
  const profile = join(S, 'machine.md');
  writeFileSync(profile, `## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n${Object.entries(BASE).map(([k, v]) => `| \`${k}\` | \`${v}\` | test |`).join('\n')}\n`);
  const sleepers = Array.from({ length: 8 }, () => spawn('sleep', ['30'], { stdio: 'ignore' }));
  const env = { ...process.env, HOME: S, DESK_LOCK_DIR: d, DESK_LEASE_DIR: d, DESK_MACHINE: profile, DESK_CONFIG: join(S, 'no-config.md'), DESK_ADMIT_SAMPLE: JSON.stringify(reading({ load: 24 })) };
  delete env.DESK_TEST_LOCK_SLOTS;
  const runs = sleepers.map((s) => new Promise((r) => {
    const c = spawn(process.execPath, [join(root, 'desk', 'bin', 'admission.mjs'), 'judge', 'light', '--pid', String(s.pid)], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; c.stdout.on('data', (b) => { out += b; });
    c.on('close', () => r(out.trim()));
  }));
  const keys = await Promise.all(runs);
  for (const s of sleepers) s.kill();
  t('DS-977 AC9 eight light runs at once: exactly one would-admit, the rest would-deny', [keys.filter((k) => k === 'would-admit:headroom').length, keys.filter((k) => k === 'would-deny:load').length], [1, 7]);
  t('DS-977 AC9 and each is logged once', [lines(d).filter((l) => l.event === 'would-admit').length, lines(d).filter((l) => l.event === 'would-deny').length], [1, 7]);
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
