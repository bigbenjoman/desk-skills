// suite: memory watch (avail band, heavy processes)
// layer: L1
// The sustained-high watch and what counts as heavy: fixture `ps` output and stubbed memory
// figures only; nothing reads this computer.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { heavyFromPs as heavyFromRows, parsePs, sustainedBandGiB, sustainedStep, harmStep, oomKills, workerMemSignals, workerLogTail,
  harmThresholds, harmRecord, writeHarmRecord, harmHold } from '../desk/bin/desk-env.mjs';
import { scratch } from './scratch.mjs';
const heavyFromPs = (text, self) => heavyFromRows(parsePs(text, 'pid=,args='), self);
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

// ---- heavy: a playwright-mcp server is idle tooling, a playwright test run is a suite
const ps = [
  ' 2624 npm exec @playwright/mcp@latest',
  ' 2769 node /Users/me/.npm/_npx/9833c18b2d85bc59/node_modules/.bin/playwright-mcp',
  ' 4100 node /Users/me/app/node_modules/.bin/playwright test --workers=2',
  ' 4200 node /Users/me/app/node_modules/.bin/vitest run',
  ' 4300 /bin/zsh -c playwright test',
].join('\n');
const heavy = heavyFromPs(ps, 1).map((r) => r.pid).join(',');
t('playwright-mcp server not heavy, npm exec wrapper not heavy', heavy.includes('2769') || heavy.includes('2624'), false);
t('playwright test is heavy', heavy.includes('4100'), true);
t('vitest still heavy', heavy.includes('4200'), true);
t('shell wrapper carrying the name not heavy', heavy.includes('4300'), false);
t('own pid skipped', heavyFromPs(' 4100 node /x/.bin/playwright test', 4100).length, 0);

// ---- the band: 2 GiB unless the §3b row names a lower one; the drop-to worker count is not a band
t('row unset -> 2', sustainedBandGiB(''), 2);
t('template row -> 2', sustainedBandGiB('start > 8 GiB · hold 4–8 · drop to 1 below 4'), 2);
t('row naming a lower band -> it', sustainedBandGiB('start > 8 GiB · hold 4–8 · drop to 1 below 4 · reclaim below 1.5'), 1.5);
t('"1 below 4" count is not a band', sustainedBandGiB('start 8 · hold 4–8 · 1 below 4'), 2);

// ---- the watch: avail decides, held for the window, nothing heavy
const cfg = { band: 2, windowMs: 300_000 };
const run = (samples) => { let s = null; const lines = []; for (const x of samples) { const r = sustainedStep(s, x, cfg); s = r.state; if (r.line) lines.push(r.line); } return lines; };
const at = (min, avail, heavy = 0) => ({ now: min * 60_000, avail, heavy });

t('avail above the band: silent whatever vmmem reads', run([0, 1, 2, 3, 4, 5, 6, 10].map((m) => at(m, 28.8))).length, 0);
const fired = run([0, 1, 2, 3, 4, 5, 6].map((m) => at(m, 1.4)));
t('below the band for 5 minutes, nothing heavy: fires once', fired.length, 1);
t('the line carries SUSTAINED-HIGH and the avail figure', /^SUSTAINED-HIGH: avail=1\.4G below 2G for 5m/.test(fired[0] ?? ''), true);
t('below the band for 4 minutes: silent', run([0, 1, 2, 3, 4].map((m) => at(m, 1.4))).length, 0);
t('below the band with a suite running: silent', run([0, 1, 2, 3, 4, 5, 6].map((m) => at(m, 1.4, 1))).length, 0);
t('a recovery mid-window restarts the clock', run([at(0, 1.4), at(3, 5), at(4, 1.4), at(8, 1.4)]).length, 0);
t('a new episode after recovery fires again', run([at(0, 1.4), at(5, 1.4), at(6, 9), at(7, 1.4), at(12, 1.4)]).length, 2);


// ---- #758: the harm signals. Swap growth over the window, a new OOM kill, a full tmpfs /tmp
const harm = (samples, cfg2) => { let st = null; const out = []; for (const x of samples) { const r = harmStep(st, x, cfg2); st = r.state; out.push(...r.lines); } return out; };
const hs = (min, swapGiB, oom = [], tmpGiB = 0) => ({ now: min * 60_000, swapGiB, oom, tmpGiB });
t('#758 steady swap, no OOM, small /tmp: silent', harm([0, 2, 4, 6, 8].map((m) => hs(m, 3))).length, 0);
const grew = harm([hs(0, 1), hs(3, 2), hs(6, 3.5), hs(8, 4)]);
t('#758 swap up 2G or more within the window fires once, naming the figures', JSON.stringify(grew), JSON.stringify(['SWAP-GROWING: swap used went from 1.0G to 3.5G, up 2.5G in 10m: hold new spawns']));
t('#758 the same growth spread past the window is silent', harm([hs(0, 1), hs(11, 2), hs(22, 3), hs(33, 4)]).length, 0);
t('#758 it fires again only after it clears', harm([hs(0, 1), hs(2, 3.5), hs(14, 3.5), hs(26, 3.5), hs(27, 3.5), hs(30, 6)]).length, 2);
t('#758 an OOM kill already in the log at the start is not news', harm([hs(0, 1, [10, 20]), hs(1, 1, [10, 20])]).length, 0);
t('#758 a new OOM kill fires, once per kill', JSON.stringify(harm([hs(0, 1, [10]), hs(1, 1, [10, 30]), hs(2, 1, [10, 30])])), JSON.stringify(["OOM-KILL: the kernel killed 1 process(es) for memory: drop to the ladder's lowest count"]));
t('#758 a kill after the kernel log wrapped past old ones still fires', harm([hs(0, 1, [10, 20, 30]), hs(1, 1, [30]), hs(2, 1, [30, 40])]).length, 1);
t('#758 a kill that pushes an old one out of the log, the count unchanged, still fires', harm([hs(0, 1, [10, 20, 30]), hs(1, 1, [20, 30, 40])]).length, 1);
t('#758 a log with no timestamps keys each kill by its line', harm([hs(0, 1, ['Killed process 1 (a)']), hs(1, 1, ['Killed process 1 (a)', 'Killed process 2 (b)'])]).length, 1);
t('#758 and a kill there that pushes an old one out, the count unchanged, still fires', harm([hs(0, 1, ['Killed process 1 (a)', 'Killed process 2 (b)']), hs(1, 1, ['Killed process 2 (b)', 'Killed process 3 (c)'])]).length, 1);
t('#758 an unreadable kernel log is said once', JSON.stringify(harm([hs(0, 1, null), hs(1, 1, null)])), JSON.stringify(['OOM-UNKNOWN: the kernel log cannot be read (dmesg), so OOM kills are not watched']));
t('#758 a full tmpfs /tmp fires once, not as a leak', JSON.stringify(harm([hs(0, 1, [], 5), hs(1, 1, [], 5.5)])), JSON.stringify(['TMPFS-HIGH: /tmp (tmpfs) holds 5.0G, which memory pressure pushes to swap, not a leak: see what holds it (du -sh /tmp/*)']));
const ino = (min, used, total = 1_048_576) => ({ now: min * 60_000, swapGiB: 1, oom: [], tmpGiB: 0, tmpInodes: { used, total } });
t('a tmpfs /tmp past 80% of its inodes fires once, naming the count and what to run', JSON.stringify(harm([ino(0, 900_000), ino(1, 950_000)])),
  JSON.stringify(['TMPFS-INODES: /tmp (tmpfs) has used 86% of its inodes (900,000 of 1,048,576); once all are used no shell on this computer can start: see what holds them (du --inodes -s /tmp/* | sort -n | tail)']));
t('below it, silent', harm([ino(0, 500_000), ino(1, 700_000)]).length, 0);
t('it fires again only after the use falls back below 60%', harm([ino(0, 900_000), ino(1, 700_000), ino(2, 900_000), ino(3, 500_000), ino(4, 900_000)]).length, 2);
t('#758 off Linux nothing is watched and nothing said', harm([{ now: 0, swapGiB: null, oom: undefined, tmpGiB: null }, { now: 60_000, swapGiB: null, oom: undefined, tmpGiB: null }]).length, 0);
const kernel = [
  '[ 812.1] oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task=node,pid=4100,uid=1000',
  '[ 812.1] Out of memory: Killed process 4100 (node) total-vm:9000000kB, anon-rss:7000000kB',
  '[ 901.4] Memory cgroup out of memory: Killed process 5200 (vitest) total-vm:4000000kB',
].join('\n');
t('#758 one kill is one line, its oom-kill: summary aside; a cgroup kill counts too, each by its timestamp and naming the process', JSON.stringify(oomKills(kernel)),
  JSON.stringify([{ key: 812.1, proc: 'node (pid 4100)' }, { key: 901.4, proc: 'vitest (pid 5200)' }]));

// ---- the kill named, worker logs, the WSL VM against its grant, thresholds, the record the pass reads
const kills = oomKills(kernel);
t('AC3 a new OOM kill names the killed process', JSON.stringify(harm([hs(0, 1, kills.slice(0, 1)), hs(1, 1, kills)])),
  JSON.stringify(["OOM-KILL: the kernel killed 1 process(es) for memory (vitest (pid 5200)): drop to the ladder's lowest count"]));
t('AC8 an unreadable kernel log still reads swap', harm([hs(0, 1, null), hs(3, 3.5, null)]).filter((l) => l.startsWith('SWAP-GROWING')).length, 1);
t('tmpfs is 2G unless set', JSON.stringify([harm([hs(0, 1, [], 2.5)]).length, harm([hs(0, 1, [], 2.5)], { tmpfsGiB: 3 }).length]), '[1,0]');

// Log events as the CLI's stream-json writes them: a failed Bash call's tool result, and the worker's prose.
const result = (content, failed = true) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content, is_error: failed }] } });
const said = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const banner = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';
const heapLine = result(`Exit code 134\n<--- Last few GCs --->\n${banner}\n`);
const killedLine = result('Exit code 137\nKilled: 9');
const mention = said('AC4: a heap out of memory line or an exit 137');
t('AC4 a heap OOM and an exit 137 are read as the runtime prints them', JSON.stringify([workerMemSignals(heapLine), workerMemSignals(killedLine)]),
  JSON.stringify([['JavaScript heap out of memory'], ['a command killed with exit 137 (SIGKILL)']]));
t('AC4 a ticket only mentioning them is not', workerMemSignals(mention).length, 0);
t('AC4 nor the worker quoting the banner word for word', workerMemSignals(said(`${banner}\nExit code 137`)).length, 0);
t('AC4 nor a file read or grep that holds them, even one that failed for another reason',
  JSON.stringify([workerMemSignals(result(`${heapLine}\n${killedLine}\n${banner}\nExit code 137`, false)), workerMemSignals(result(`Exit code 1\n  86\t${heapLine}\n  87\t${killedLine}`))]), '[[],[]]');
t('AC4 a worker log signal names the ticket', JSON.stringify(harm([{ now: 0, swapGiB: 1, oom: [], workers: [{ key: 'DS-12', text: heapLine }] }])),
  JSON.stringify(["WORKER-OOM: DS-12's log shows JavaScript heap out of memory: drop to the ladder's lowest count"]));

const T = scratch('desk-memwatch-');
const logs = join(T, 'logs');
mkdirSync(logs);
writeFileSync(join(logs, 'DS-1.log'), `${heapLine}\n`);
let tail = workerLogTail(logs, null);
t('AC4 what a log held before the watch started is not news', tail.chunks.length, 0);
appendFileSync(join(logs, 'DS-1.log'), `${mention}\n${killedLine}\n{"partial`);
writeFileSync(join(logs, 'DS-2.log'), `${heapLine}\n`);
tail = workerLogTail(logs, tail.seen);
t('AC4 what each log gained since, in whole lines, by ticket', JSON.stringify(tail.chunks.map((c) => [c.key, workerMemSignals(c.text)]).sort()),
  JSON.stringify([['DS-1', ['a command killed with exit 137 (SIGKILL)']], ['DS-2', ['JavaScript heap out of memory']]]));
appendFileSync(join(logs, 'DS-1.log'), '"}\n');
tail = workerLogTail(logs, tail.seen);
t('AC4 a line finished later is read whole, and nothing twice', JSON.stringify(tail.chunks.map((c) => [c.key, c.text])), JSON.stringify([['DS-1', '{"partial"}\n']]));

const vm = (min, usedGiB) => ({ now: min * 60_000, swapGiB: 1, oom: [], vmmem: { usedGiB, grantGiB: 24 } });
t('AC6 the WSL VM at 90% of its grant fires once, naming both', JSON.stringify(harm([vm(0, 20), vm(1, 22), vm(2, 22.5)])),
  JSON.stringify(['VMMEM-HIGH: the WSL VM holds 22.0G of its 24.0G .wslconfig grant (92%), past which it can only swap: hold new spawns']));
t('AC6 again only after it falls 5 points under', harm([vm(0, 22), vm(1, 21), vm(2, 22), vm(3, 19), vm(4, 22)]).length, 2);
t('AC6 not on WSL, nothing', harm([{ now: 0, swapGiB: 1, oom: [], vmmem: null }]).length, 0);

// What stands is what is past its threshold now: a signal under it, though not yet cleared for saying again, stands no longer.
const standing = (samples) => { let s = null; return samples.map((x) => { const r = harmStep(s, x); s = r.state; return r.standing.join(','); }); };
t('a signal stands while past its threshold, and not once under it', JSON.stringify(standing([hs(0, 1, [], 2.5), hs(1, 1, [], 1.9), vm(2, 22), vm(3, 21)])),
  JSON.stringify(['TMPFS-HIGH', '', 'VMMEM-HIGH', '']));

const rows = { 'harm-swap-growth': '3', 'harm-tmpfs': null, 'harm-vmmem': 'TODO' };
t('the thresholds read from §3b, unset or unreadable keep the default', JSON.stringify(harmThresholds((id) => rows[id])), JSON.stringify({ swapGrowGiB: 3, tmpfsGiB: 2, vmmemShare: 0.9 }));
const odd = { 'harm-swap-growth': '0x10', 'harm-tmpfs': '0', 'harm-vmmem': '90.5' };
t('values the row type refuses, or zero, keep the default', JSON.stringify(harmThresholds((id) => odd[id])), JSON.stringify({ swapGrowGiB: 2, tmpfsGiB: 2, vmmemShare: 0.9 }));

const st = join(T, 'state');
t('AC9 with no record nothing holds', harmHold(st, 0).length, 0);
let rec = harmRecord(null, { now: 0, lines: ['OOM-UNKNOWN: x', 'SWAP-GROWING: up'], standing: ['SWAP-GROWING'] });
rec = harmRecord(rec, { now: 9 * 60_000, lines: [], standing: ['SWAP-GROWING'] });
writeHarmRecord(st, rec);
t('AC7 a signal said, then standing, holds from its last reading; OOM-UNKNOWN is not harm', JSON.stringify(harmHold(st, 15 * 60_000)),
  JSON.stringify([{ signal: 'SWAP-GROWING', at: 9 * 60_000, line: 'SWAP-GROWING: up' }]));
t('AC7 and not past the window', harmHold(st, 20 * 60_000).length, 0);
writeFileSync(join(st, 'mem-harm.json'), '{not json');
t('a record that does not read holds nothing', harmHold(st, 0).length, 0);

if (fails) { console.log(`FAIL: ${fails} checks failed`); process.exit(1); }
