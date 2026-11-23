// suite: admission (headroom admission in shadow: would-admit and would-deny on fixture readings, the ledger of recent admits, the admission lock; on: admit and deny, the waiting line and how often it prints)
// layer: L2
// covers: desk/bin/admission.mjs desk/bin/admit-ledger.mjs desk/bin/machine.mjs
// admit() against a scratch lock directory and lease log, with fixture readings and a fixed clock; the
// CLI as eight real processes for the admission lock.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admit, grant, judge, ledgerFile, parseLedger, poolRows, pressureLevel, sayNow, waitText } from '../desk/bin/admission.mjs';
import { liveAdmits } from '../desk/bin/admit-ledger.mjs';
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
const wait = (dir, { cls = 'light', pid = process.pid, rows = BASE, held = 1, sample = reading(), now = T0, last = null, isAlive = () => true, isWaiting = () => false } = {}) =>
  admit({ cls, pid, last, env: envOf(rows), dir, logDir: dir, held, sample, platform: 'darwin', now: () => now, isAlive, isWaiting });
const ledger = (dir, entries) => writeFileSync(ledgerFile(dir), entries.map((e) => `${e.at} ${e.pool} ${e.pid} ${e.gb} ${e.load} ${e.reason ?? 'headroom'}${e.start ? ` ${e.start}` : ''}\n`).join(''));

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
// The floor: a light floor of 2 with one slot held is a would-admit on the floor, no readings needed,
// and logs no line (on grants it at once). While it waits it holds that slot, so the next run is
// judged above the floor.
{
  const d = fresh();
  const rows = { ...BASE, 'light-lock-slots': '2' };
  t('DS-977 a free floor slot is a would-admit on the floor that logs no line',
    [wait(d, { rows, sample: reading({ load: null }) }), lines(d).length, parseLedger(readFileSync(ledgerFile(d), 'utf8')).map((e) => e.reason)], ['would-admit:floor', 0, ['floor']]);
  wait(d, { rows, pid: process.ppid, sample: reading({ load: null }), isWaiting: () => true });
  t('DS-977 the floor run still waiting holds its floor slot: the next is judged above it', lines(d).map((l) => [l.event, l.reason, l.held, l.shadow_held]), [['would-deny', 'load-unreadable', 2, 1]]);
}
// The ceiling counts the runs shadow would have let in that still wait: light floor 1, ceiling 2.
{
  const d = fresh();
  const rows = { ...BASE, 'light-lock-max': '2' };
  wait(d, { rows });
  wait(d, { rows, pid: process.ppid, isWaiting: () => true });
  t('DS-977 a second would-admit past the ceiling is a would-deny naming the ceiling', lines(d).map((l) => `${l.event}:${l.reason}`), ['would-admit:headroom', 'would-deny:ceiling']);
  const d2 = fresh();
  wait(d2, { rows });
  wait(d2, { rows, pid: process.ppid, now: T0 + 200_000, isWaiting: () => false });
  t('DS-977 one that no longer waits, its ramp over, holds nothing and is dropped', [lines(d2).map((l) => `${l.event}:${l.reason}`), parseLedger(readFileSync(ledgerFile(d2), 'utf8')).map((e) => e.pid)],
    [['would-admit:headroom', 'would-admit:headroom'], [process.ppid]]);
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
  const bad = admissionRows((k) => ({ 'lock-admission': 'yes', 'light-lock-slots': '0', 'test-lock-slots': '3', 'test-lock-max': '2', 'admit-reserve-gb': 'lots', 'test-cap': '4' })[k] ?? null);
  t('DS-977 AC13 each broken row is named with what it wants, and admission is off', [bad.mode, bad.problems], ['off', [
    '`lock-admission` is "yes": want off, shadow or on',
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

// ---- DS-987: admission on grants a slot above the floor ----------------------------------------
const ON = { ...BASE, 'lock-admission': 'on', 'test-lock-slots': '1', 'test-lock-max': '3' };
const ask = (dir, { cls = 'light', pid = process.pid, rows = ON, sample = reading(), now = T0, last = null, said = null, saidAt = null, isAlive = () => true, startsOf = null } = {}) =>
  grant({ cls, pid, last, said, saidAt, env: envOf(rows), dir, logDir: dir, sample, platform: 'darwin', now: () => now, isAlive, startsOf });
// AC1: light floor 1 full, readings with room: admitted, logged with the readings and the reason, and in the ledger.
{
  const d = fresh();
  const r = ask(d);
  const [l] = lines(d);
  t('DS-987 AC1 a run finding the light floor full, with room, is admitted', r.key, 'admit:headroom');
  t('DS-987 AC1 the lease log records an admit line with the readings and the reason',
    [l?.event, l?.mode, l?.key, l?.reason, l?.load_1m, l?.mem_free_gb, l?.mem_pressure, l?.held, l?.floor, l?.ceiling], ['admit', 'on', 'light', 'headroom', 10, 40, 1, 1, 1, 3]);
  t('DS-987 AC1 the admit holds its place in the ledger', parseLedger(readFileSync(ledgerFile(d), 'utf8')).map((e) => [e.pool, e.pid, e.reason]), [['light', process.pid, 'admit']]);
  const again = ask(d, { last: r.key, sample: reading({ load: 99 }) });
  t('DS-987 a run already let in is not judged again, logs nothing more, and keeps one entry', [again.key, lines(d).length, parseLedger(readFileSync(ledgerFile(d), 'utf8')).length], ['admit:headroom', 1, 1]);
}
// AC3, AC12: two admits live over a light floor of 1 make 3 held, the ceiling: denied whatever the readings.
{
  const d = fresh();
  ledger(d, [{ at: T0 / 1000 - 500, pool: 'light', pid: 11, gb: 16, load: 1, reason: 'admit' }, { at: T0 / 1000 - 500, pool: 'light', pid: 12, gb: 16, load: 1, reason: 'admit' }]);
  const r = ask(d, { sample: reading({ load: 0, freeGb: 80 }) });
  t('DS-987 AC3 the light pool at its ceiling of 3 denies a fourth with room', [r.key, lines(d)[0]?.held], ['deny:ceiling', 3]);
  t('DS-987 AC3 an admit older than admit-ramp-s still holds its place while its run runs', parseLedger(readFileSync(ledgerFile(d), 'utf8')).map((e) => e.pid), [11, 12]);
  const d2 = fresh();
  ledger(d2, [{ at: T0 / 1000 - 500, pool: 'light', pid: 11, gb: 16, load: 1, reason: 'admit' }]);
  t('DS-987 an admit whose run has exited holds nothing and is dropped', [ask(d2, { isAlive: (p) => p !== 11 }).key, parseLedger(readFileSync(ledgerFile(d2), 'utf8')).map((e) => e.pid)], ['admit:headroom', [process.pid]]);
}
// An admit records its run's process start time, and one whose pid a later process has taken holds nothing.
{
  const startsOf = (now) => (pids) => new Map(pids.map((p) => [p, now[p] ?? `s${p}`]));
  const d = fresh();
  ledger(d, [{ at: T0 / 1000 - 500, pool: 'light', pid: 11, gb: 16, load: 1, reason: 'admit', start: 'old' }, { at: T0 / 1000 - 500, pool: 'light', pid: 12, gb: 16, load: 1, reason: 'admit', start: 's12' }]);
  const r = ask(d, { startsOf: startsOf({}) });
  t('DS-987 an admit whose pid now has another start time is a run that has exited: dropped, and its room is free',
    [r.key, lines(d)[0]?.held, parseLedger(readFileSync(ledgerFile(d), 'utf8')).map((e) => [e.pid, e.start])], ['admit:headroom', 2, [[12, 's12'], [process.pid, `s${process.pid}`]]]);
  const d2 = fresh();
  ledger(d2, [{ at: T0 / 1000 - 500, pool: 'light', pid: process.pid, gb: 16, load: 1, reason: 'admit', start: 'old' }, { at: T0 / 1000 - 500, pool: 'light', pid: 12, gb: 16, load: 1, reason: 'admit', start: 's12' }]);
  t('DS-987 a run whose pid an exited admit had is judged afresh, not let in on that admit', ask(d2, { startsOf: startsOf({}), sample: reading({ load: 99 }) }).key, 'deny:load');
  const entries = parseLedger(`1 light 11 16 1 admit old\n1 light 12 16 1 admit s12\n1 heavy 13 16 1 admit\n`);
  t('DS-987 liveAdmits counts an admit only while its start time matches, and one with none by its pid',
    [liveAdmits(entries, { isAlive: () => true, starts: startsOf({})([11, 12, 13]) }), liveAdmits(entries, { isAlive: () => true })], [{ heavy: 1, light: 1 }, { heavy: 1, light: 2 }]);
}
// AC4: a reading that cannot be taken is a deny naming it.
{
  const got = [{ load: null }, { freeGb: null }, { pressure: null }].map((r) => { const d = fresh(); ask(d, { sample: reading(r) }); return lines(d).map((l) => [l.event, l.reason])[0]; });
  t('DS-987 AC4 a full floor and a reading that cannot be taken: a deny line naming it', got, [['deny', 'load-unreadable'], ['deny', 'memory-unreadable'], ['deny', 'pressure-unreadable']]);
}
// AC5: the waiting line, with the live numbers.
{
  const d = fresh();
  ledger(d, [{ at: T0 / 1000 - 500, pool: 'light', pid: 11, gb: 16, load: 1, reason: 'admit' }]);
  const r = ask(d, { sample: reading({ load: 29.6, freeGb: 33, pressure: 2 }) });
  t('DS-987 AC5 two light runs held, the load leaving no room: the line names the pool, slots, floor and ceiling, and the reason with its numbers',
    [r.key, r.say, r.text], ['deny:load', true, 'waiting for light lock: 2 of 1..3 held; no headroom: load 29.6 + 4 > 30 (pressure warn, 33 GB free, 16 GB/run)']);
  t('DS-987 the memory and pressure reasons give their numbers too', [
    waitText('test', 'memory', { held: 1, floor: 1, ceiling: 3, mem_free_gb: 20, recent_gb: 0, run_gb: 16, reserve_gb: 8, mem_pressure: 1 }),
    waitText('light', 'pressure', { held: 1, floor: 1, ceiling: 3, mem_free_gb: 40, run_gb: 16, mem_pressure: 4, max_pressure: 2 }),
    waitText('light', 'ceiling', { held: 3, floor: 1, ceiling: 3, mem_free_gb: null, run_gb: 16, mem_pressure: null })], [
    'waiting for test lock: 1 of 1..3 held; no headroom: 20 GB free - 16 < 8 GB reserve (pressure normal, 20 GB free, 16 GB/run)',
    'waiting for light lock: 1 of 1..3 held; no headroom: pressure critical, at or over warn (pressure critical, 40 GB free, 16 GB/run)',
    'waiting for light lock: 3 of 1..3 held; at its ceiling (pressure unread, unread GB free, 16 GB/run)']);
}
// AC6, AC7: the line is printed once while its reason holds, and a reason that changes prints at most once a minute.
{
  const run = (keys) => { let said = null, saidAt = null, printed = 0; for (const [at, key] of keys) if (sayNow({ key, said, saidAt, at })) { printed++; said = key; saidAt = at; } return printed; };
  t('DS-987 AC6 five minutes waited, rechecked every 10 s, the reason unchanged: one line', run(Array.from({ length: 31 }, (_, i) => [i * 10, 'deny:load'])), 1);
  const changes = [[0, 'deny:load'], [70, 'deny:memory'], [80, 'deny:pressure'], [90, 'deny:load'], [100, 'deny:memory'], [129, 'deny:memory']];
  t('DS-987 AC7 the reason changing three times within a minute prints at most one line for those changes', run(changes) - 1, 1);
  t('DS-987 AC7 and a reason still new a minute after the last line is printed then', run([[0, 'deny:load'], [10, 'deny:memory'], [20, 'deny:pressure'], [30, 'deny:memory'], [60, 'deny:memory']]), 2);
}
// AC13, AC10: shadow or off grants nothing here; the shadow judge ignores on, as before.
{
  const got = ['shadow', 'off'].map((m) => { const d = fresh(); return [ask(d, { rows: { ...ON, 'lock-admission': m } }), lines(d).length, existsSync(ledgerFile(d))]; });
  t('DS-987 AC10 AC13 with lock-admission shadow or off, grant lets nothing in and logs nothing', got, [[null, 0, false], [null, 0, false]]);
  t('DS-987 poolRows: on gives the rows\' floor and ceiling, else the floor the locks grant', [
    poolRows('light', admissionRows((k) => ON[k] ?? null, { testSlots: 1 })), poolRows('heavy', admissionRows((k) => ON[k] ?? null, { testSlots: 1 })),
    poolRows('light', admissionRows((k) => BASE[k] ?? null, { testSlots: 2 })), poolRows('heavy', admissionRows((k) => ({ ...ON, 'light-lock-max': '0' })[k] ?? null, { testSlots: 2 }))],
  [{ mode: 'on', floor: 1, ceiling: 3 }, { mode: 'on', floor: 1, ceiling: 3 }, { mode: 'shadow', floor: 1, ceiling: 1 }, { mode: 'off', floor: 2, ceiling: 2 }]);
}
// Eight light runs at once, admission on: the admission lock lets exactly one take the last room.
{
  const d = fresh();
  const profile = join(S, 'machine-on.md');
  writeFileSync(profile, `## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n${Object.entries({ ...ON, 'light-lock-max': '2' }).map(([k, v]) => `| \`${k}\` | \`${v}\` | test |`).join('\n')}\n`);
  const sleepers = Array.from({ length: 8 }, () => spawn('sleep', ['30'], { stdio: 'ignore' }));
  const env = { ...process.env, HOME: S, DESK_LOCK_DIR: d, DESK_LEASE_DIR: d, DESK_MACHINE: profile, DESK_CONFIG: join(S, 'no-config.md'), DESK_ADMIT_SAMPLE: JSON.stringify(reading()) };
  delete env.DESK_TEST_LOCK_SLOTS;
  const keys = await Promise.all(sleepers.map((s) => new Promise((r) => {
    const c = spawn(process.execPath, [join(root, 'desk', 'bin', 'admission.mjs'), 'grant', 'light', '--pid', String(s.pid)], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; c.stdout.on('data', (b) => { out += b; });
    c.on('close', () => r(out.split('\t')[0]));
  })));
  for (const s of sleepers) s.kill();
  t('DS-987 eight light runs at once with one slot of room above the floor: exactly one is admitted', [keys.filter((k) => k === 'admit:headroom').length, keys.filter((k) => k === 'deny:ceiling').length], [1, 7]);
}

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
  // A row written TODO does not read, as machine detect says: admission is off and nothing is logged.
  const todo = join(S, 'machine-todo.md');
  writeFileSync(todo, readFileSync(profile, 'utf8').replace('| `admit-max-load` | `30` |', '| `admit-max-load` | `TODO` |'));
  const d2 = fresh();
  const s = spawn('sleep', ['30'], { stdio: 'ignore' });
  const out = await new Promise((r) => {
    const c = spawn(process.execPath, [join(root, 'desk', 'bin', 'admission.mjs'), 'judge', 'light', '--pid', String(s.pid)], { env: { ...env, DESK_LOCK_DIR: d2, DESK_LEASE_DIR: d2, DESK_MACHINE: todo }, stdio: ['ignore', 'pipe', 'ignore'] });
    let o = ''; c.stdout.on('data', (b) => { o += b; }); c.on('close', () => r(o.trim()));
  });
  s.kill();
  t('DS-977 AC13 an admission row written TODO turns admission off', [out, lines(d2).length], ['', 0]);
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
