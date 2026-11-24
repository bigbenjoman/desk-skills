// suite: tmpfs sweep (regenerable caches cleared under TMPFS-HIGH, and what is left named in needs-you)
// layer: L1
// covers: desk/bin/tmp-sweep.mjs desk/bin/asks.mjs
// A scratch folder stands in for /tmp and a fake /proc for the processes; nothing reads this computer's.
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { regenerable, tmpEntries, openFiles, planSweep, sweepTmp, sweepLines, tmpfsStep, settledLines } from '../desk/bin/tmp-sweep.mjs';
import { readAsks } from '../desk/bin/asks.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const NOW = Date.now();
const HOUR = 3_600_000;
// A /tmp: each entry a folder holding one file of `kb` KiB, last changed `ago` ms before NOW.
const fakeTmp = (entries) => {
  const dir = scratch('tmp-sweep-');
  for (const [name, kb, ago = 0] of entries) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'f'), Buffer.alloc(kb * 1024, 1));
    const at = (NOW - ago) / 1000;
    utimesSync(join(dir, name, 'f'), at, at);
    utimesSync(join(dir, name), at, at);
  }
  return dir;
};
// A /proc: each process its command line, working directory and open files.
const fakeProc = (procs) => {
  const dir = scratch('tmp-sweep-proc-');
  procs.forEach(({ args = ['sleep'], cwd = '/', fds = [] }, i) => {
    const at = join(dir, String(100 + i));
    mkdirSync(join(at, 'fd'), { recursive: true });
    writeFileSync(join(at, 'cmdline'), `${args.join('\0')}\0`);
    symlinkSync(cwd, join(at, 'cwd'));
    fds.forEach((f, n) => symlinkSync(f, join(at, 'fd', String(n))));
  });
  mkdirSync(join(dir, 'self'));
  return dir;
};

// ---- AC1: the largest entries, and the regenerable caches no process has open ----------------------
const tmp = fakeTmp([['jest_rs', 400], ['node-compile-cache', 200], ['v8-compile-cache-1000', 50], ['cdk.outAbC', 60, 2 * HOUR],
  ['cdk.outNew', 60, 10 * 60_000], ['turbo-cache', 30], ['vite-deps', 30], ['user-data', 600], ['jest_open', 20]]);
const entries = tmpEntries(tmp);
t('#1382 AC1 the entries are listed largest first', entries.slice(0, 3).map((e) => e.name), ['user-data', 'jest_rs', 'node-compile-cache']);
t('#1382 AC1 a name that only starts like a cache is no cache', ['vitest-coverage', 'turbolence', 'jest', 'node-compile-cache-old', 'cdk-out'].filter((n) => regenerable(n)), []);
t('#1382 AC1 the named caches in their usual forms are each one', ['jest_rs', 'node-compile-cache', 'v8-compile-cache-1000', 'cdk.out3xYz', 'turbod', '.turbo', 'vite', 'vite-deps'].every((n) => regenerable(n)), true);
const open = openFiles(fakeProc([{ args: ['node', 'x.js'], fds: [join(entries.find((e) => e.name === 'jest_open').path, 'f')] }]));
t('#1382 AC1 what is open is read from /proc', open.paths.some((p) => p.endsWith('/jest_open/f')), true);
t('#1382 AC1 the regenerable caches are picked, an open one, a CDK output changed within the hour and anything else are not',
  planSweep(entries, open, NOW).map((e) => e.name).sort(), ['cdk.outAbC', 'jest_rs', 'node-compile-cache', 'turbo-cache', 'v8-compile-cache-1000', 'vite-deps']);
const cwdIn = openFiles(fakeProc([{ cwd: entries.find((e) => e.name === 'vite-deps').path }]));
t('#1382 AC1 a cache some process works in is left', planSweep(entries, cwdIn, NOW).some((e) => e.name === 'vite-deps'), false);
const jestRuns = openFiles(fakeProc([{ args: ['node', '/repo/node_modules/.bin/jest', '--maxWorkers=2'] }]));
t('#1382 AC1 no Jest cache is cleared while Jest runs', planSweep(entries, jestRuns, NOW).filter((e) => e.name.startsWith('jest_')).length, 0);
const jestWorker = openFiles(fakeProc([{ args: ['node', '/repo/node_modules/jest-worker/build/workers/processChild.js'] }]));
t("#1382 AC1 nor while one of Jest's workers runs", planSweep(entries, jestWorker, NOW).filter((e) => e.name.startsWith('jest_')).length, 0);
t('#1382 AC1 a prompt that mentions jest is not Jest running', planSweep(entries, openFiles(fakeProc([{ args: ['claude', '-p', 'run jest with --maxWorkers'] }])), NOW).some((e) => e.name === 'jest_rs'), true);
t('#1382 AC1 nothing is cleared where /proc cannot be read', [openFiles(join(tmp, 'no-proc')), planSweep(entries, null, NOW)], [null, []]);

const swept = sweepTmp({ dir: tmp, proc: fakeProc([{ fds: [join(entries.find((e) => e.name === 'jest_open').path, 'f')] }]), now: NOW });
t('#1382 AC1 the sweep removes what it picked and keeps the rest',
  ['jest_rs', 'node-compile-cache', 'cdk.outAbC', 'cdk.outNew', 'user-data', 'jest_open'].map((n) => existsSync(join(tmp, n))), [false, false, false, true, true, true]);
t('#1382 AC1 and says what is left, largest first', swept.left.map((e) => e.name), ['user-data', 'cdk.outNew', 'jest_open']);
const said = sweepLines(swept);
t('#1382 AC1 its line says how much it freed and names each cache it cleared',
  said.length === 1 && /^\/tmp \(tmpfs\): cleared \d+M of regenerable cache no process had open: jest_rs \d+M \(Jest cache\), node-compile-cache \d+M \(Node compile cache\)/.test(said[0]), true);
t('#1382 AC1 a cache that cannot be removed is said, not counted as freed', (() => {
  const d = fakeTmp([['node-compile-cache', 4]]);
  const r = sweepTmp({ dir: d, proc: fakeProc([]), now: NOW, remove: () => { throw new Error('EBUSY: busy'); } });
  return [r.freed.length, sweepLines(r)];
})(), [0, ['/tmp (tmpfs): node-compile-cache (Node compile cache) could not be cleared: EBUSY: busy']]);
t('#1382 AC1 an unreadable /proc is said', sweepLines({ freed: [], failed: [], left: [], unread: true }),
  ['/tmp (tmpfs): /proc could not be read, so what has a file open there is not known and no cache was cleared']);

// ---- AC3: still over the line after the sweep, the hold stands and needs-you names what is left ----
const askState = scratch('tmp-sweep-asks-');
const left = [{ name: 'user-data', bytes: 3 * 2 ** 30 }, { name: 'cdk.outNew', bytes: 300 * 2 ** 20 }];
const sweepStub = (l) => () => ({ freed: [], failed: [], left: l, unread: false });
const over = tmpfsStep({ askState, limitGiB: 2, usage: () => 3.4, sweep: sweepStub(left), now: NOW });
const asks = readAsks(askState);
t('#1382 AC3 over the line after the sweep: the hold stands', over.over, true);
t('#1382 AC3 one needs-you ask names the size, the line and what is left, largest first', [asks.length, asks[0]?.settles,
  asks[0]?.text], [1, 'tmpfs', '/tmp is a tmpfs, so what it holds is memory: it holds 3.4G, over the 2G line that holds new workers, after desk cleared every cache it could. Largest left: user-data 3.0G, cdk.outNew 300M. Clear what you can (du -sh /tmp/*); workers start again once it is under 2G']);
t('#1382 AC3 the pass says what is left', over.lines.some((l) => l.startsWith('/tmp (tmpfs): still 3.4G, over its 2G line: largest left user-data 3.0G, cdk.outNew 300M (needs-you: ask ')), true);
tmpfsStep({ askState, limitGiB: 2, usage: () => 2.6, sweep: sweepStub(left.slice(1)), now: NOW });
const again = readAsks(askState);
t('#1382 AC3 the next pass updates the same ask rather than adding one', [again.length, again[0].id === asks[0].id, again[0].text.includes('holds 2.6G') && again[0].text.includes('Largest left: cdk.outNew 300M.')], [1, true, true]);
const under = tmpfsStep({ askState, limitGiB: 2, usage: () => 1.2, sweep: sweepStub(left.slice(1)), now: NOW });
t('#1382 AC3 under the line after the sweep: the hold lifts and the ask is dropped', [under.over, readAsks(askState).length, under.lines.at(-1)],
  [false, 0, `needs-you: ask ${asks[0].id} dropped, as /tmp is under its line`]);
t('#1382 AC1 under the line after the sweep, the pass still names the largest entries', under.lines.includes('/tmp (tmpfs): 1.2G now, under its 2G line, so it no longer holds spawns: largest left cdk.outNew 300M'), true);
const dry = tmpfsStep({ askState, limitGiB: 2, usage: () => 3, dry: true, sweep: () => { throw new Error('a dry run swept'); }, now: NOW });
t('#1382 AC3 a dry run clears nothing and records no ask', [dry.over, readAsks(askState).length], [true, 0]);
t('#1382 AC3 /tmp unreadable after the sweep keeps the hold', tmpfsStep({ askState, limitGiB: 2, usage: () => null, sweep: sweepStub([]), now: NOW }).over, true);
tmpfsStep({ askState, limitGiB: 2, usage: () => 3, sweep: sweepStub(left), now: NOW });
t('#1382 AC3 once TMPFS-HIGH no longer holds, the ask is dropped', [settledLines(askState).length, readAsks(askState).length], [1, 0]);

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
