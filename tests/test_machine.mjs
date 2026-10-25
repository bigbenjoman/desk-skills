// suite: machine profile (detection, sizing, §3b fallback)
// The machine profile: hardware parsing from fixture output, the sizing rules, the profile file, and
// the §3b fallback through desk-env. Scratch directories only; nothing reads this computer.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMac, parseLinux, propose, renderProfile, parseProfile, hardwareChanges, sizingChanges, countCpuList, runnerChosen, slotChosen, idleChosen, slotFit } from '../desk/bin/machine.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const sized = (hw) => Object.fromEntries(propose(hw).map((r) => [r.key, r]));

// ---- macOS: a 12-core 64 GB desktop (system_profiler, sysctl, sw_vers, df, pmset as they print)
const macMini = parseMac({
  systemProfiler: `Hardware:

    Hardware Overview:

      Model Name: Mac mini
      Model Identifier: Mac16,11
      Chip: Apple M4 Pro
      Total Number of Cores: 12 (8 performance and 4 efficiency)
      Memory: 64 GB
      System Firmware Version: 11881.41.5

Graphics/Displays:

    Apple M4 Pro:

      Chipset Model: Apple M4 Pro
      Type: GPU
      Bus: Built-In
      Total Number of Cores: 16
      Vendor: Apple (0x106b)
`,
  sysctl: 'hw.ncpu: 12\nhw.memsize: 68719476736\nhw.model: Mac16,11\nhw.perflevel0.physicalcpu: 8\nhw.perflevel1.physicalcpu: 4\nmachdep.cpu.brand_string: Apple M4 Pro\n',
  swVers: 'ProductName:\t\tmacOS\nProductVersion:\t\t15.1\nBuildVersion:\t\t24B83\n',
  df: 'Filesystem     1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on\n/dev/disk3s1s1   971350180  10741680 430000000     3%  425798 4300000000    0%   /\n',
  pmset: "Now drawing from 'AC Power'\n",
  arch: 'arm64',
});
t('mac model', macMini.model, 'Mac mini (Mac16,11)');
t('mac chip', macMini.chip, 'Apple M4 Pro');
t('mac cores', macMini['cpu-cores'], 12);
t('mac performance cores', macMini['performance-cores'], 8);
t('mac efficiency cores', macMini['efficiency-cores'], 4);
t('mac gpu cores (not the CPU line)', macMini['gpu-cores'], 16);
t('mac memory from hw.memsize', macMini['memory-gb'], 64);
t('mac free disk', macMini['disk-free-gb'], 410);
t('mac os', macMini.os, 'macOS 15.1');
t('mac arch', macMini.arch, 'arm64');
t('mac on mains', macMini.battery, 'no');

// The runner is off by default on mains too: nothing sized, nothing held back from the ceiling.
const miniOff = sized(macMini);
t('desktop: runner off by default', miniOff['runner-possible'].value, 'no');
t('desktop: reason says off by default and how to opt in', miniOff['runner-possible'].why, 'meets the minimum (64 GB, 12 cores, 410 GB free) but the runner is off by default: --runner sizes it on');
t('desktop off: no VM', ['runner-vm-cpus', 'runner-vm-memory-gb', 'runner-vm-disk-gb', 'runner-slots-per-repo', 'runner-memory-reserved-gb'].map((k) => miniOff[k].value).join(' '), '0 0 0 0 0');
t('desktop off: no idle timeout', miniOff['runner-idle-minutes'].value, 'off');
t('desktop off: ceiling holds nothing back', `${miniOff['memory-ceiling-gb'].value} ${miniOff['memory-ceiling-gb'].why}`, '56 64 GB - 8 for the OS; nothing reserved for a runner');
t('desktop off: workers from the whole ceiling', miniOff['autopilot-concurrency'].value, '9 / 18');

const mini = Object.fromEntries(propose(macMini, { runner: true }).map((r) => [r.key, r]));
t('desktop --runner: runner possible', mini['runner-possible'].value, 'yes');
t('desktop: VM cpus 8 of 12', mini['runner-vm-cpus'].value, '8');
t('desktop: VM memory 24 of 64', mini['runner-vm-memory-gb'].value, '24');
t('desktop: VM disk at most 100', mini['runner-vm-disk-gb'].value, '100');
t('desktop: slots of 2 CPUs and 7 GB', mini['runner-slots-per-repo'].value, '3');
t('desktop: slots arithmetic shown', mini['runner-slots-per-repo'].why, 'min(8 CPUs / 2, (24 GB - 2 for the VM) / 7 GB): 2 CPUs and 7 GB per slot');
t('desktop: slot size rows', `${mini['runner-slot-cpus'].value} ${mini['runner-slot-memory-gb'].value}`, '2 7');
t('a 12-CPU 40 GB VM fits 5 slots', Object.fromEntries(propose({ ...macMini, 'cpu-cores': 18, 'memory-gb': 107 }, { runner: true }).map((r) => [r.key, r.value]))['runner-slots-per-repo'], '5');
const bigSlot = Object.fromEntries(propose(macMini, { runner: true, slot: { cpus: 4, memoryGB: 10 } }).map((r) => [r.key, r]));
t('slotFit: what desk-runner enforces, floored at 0', `${slotFit(8, 24).fit} ${slotFit(12, 40).fit} ${slotFit(8, 24, { memoryGB: 30 }).fit} ${slotFit(8, 24).why}`, '3 5 0 min(8 CPUs / 2, (24 GB - 2 for the VM) / 7 GB)');
t('a slot size the profile sets is kept and sizes the slots', `${bigSlot['runner-slot-cpus'].value} ${bigSlot['runner-slot-memory-gb'].value} ${bigSlot['runner-slots-per-repo'].value} ${bigSlot['runner-slot-cpus'].why}`, '4 10 2 kept from the profile');
t('desktop: reserved = VM memory', mini['runner-memory-reserved-gb'].value, '24');
t('desktop: the VM sleeps after 10 idle minutes', `${mini['runner-idle-minutes'].value} ${mini['runner-idle-minutes'].why}`, '10 stop the VM after 10 minutes with no job, which gives its memory back; off keeps it up');
t('desktop: ceiling after OS and runner', mini['memory-ceiling-gb'].value, '32');
t('desktop: workers at 3 GB each', mini['autopilot-concurrency'].value, '5 / 10');
t('desktop: test cap = performance cores', mini['test-cap'].value, '8');
t('desktop: typecheck lock timeout', mini['typecheck-lock-timeout-min'].value, '20');
t('desktop: pre-push lock timeout', mini['pre-push-lock-timeout-s'].value, '60');
t('desktop: arithmetic shown', mini['runner-vm-memory-gb'].why, 'floor(64 GB x 3/8)');

// ---- macOS: a 10-core 32 GB laptop, read from sysctl alone (no system_profiler output)
const laptop = parseMac({
  sysctl: 'hw.ncpu: 10\nhw.memsize: 34359738368\nhw.model: MacBookPro18,3\nhw.perflevel0.physicalcpu: 8\nhw.perflevel1.physicalcpu: 2\nmachdep.cpu.brand_string: Apple M1 Pro\n',
  swVers: 'ProductName:\tmacOS\nProductVersion:\t14.6\n',
  df: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1s1 488245288 9000000 209715200 5% /\n',
  pmset: "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t95%; discharging; 6:12 remaining present: true\n",
  arch: 'arm64',
});
t('laptop model from sysctl', laptop.model, 'MacBookPro18,3');
t('laptop chip from sysctl', laptop.chip, 'Apple M1 Pro');
t('laptop cores from sysctl', `${laptop['cpu-cores']} ${laptop['performance-cores']} ${laptop['efficiency-cores']}`, '10 8 2');
t('laptop gpu unknown without system_profiler', laptop['gpu-cores'], 'unknown');
t('laptop has a battery', laptop.battery, 'yes');
const lap = sized(laptop);
t('laptop: meets the minimum but proposed off on battery', lap['runner-possible'].value, 'no');
t('laptop: reason names the battery and the opt-in', lap['runner-possible'].why, 'meets the minimum (32 GB, 10 cores, 200 GB free, on battery) but the runner is off by default: --runner sizes it on');
t('laptop: no VM', lap['runner-vm-memory-gb'].value, '0');
t('laptop: nothing reserved', lap['runner-memory-reserved-gb'].value, '0');
t('laptop: ceiling 32 - 8', lap['memory-ceiling-gb'].value, '24');
t('laptop: workers', lap['autopilot-concurrency'].value, '4 / 8');
t('laptop: test cap', lap['test-cap'].value, '8');
const lapMains = sized({ ...laptop, battery: 'no' });
t('same laptop on mains: still off by default', `${lapMains['runner-possible'].value} ${lapMains['runner-memory-reserved-gb'].value} ${lapMains['memory-ceiling-gb'].value}`, 'no 0 24');
const lapMainsOn = Object.fromEntries(propose({ ...laptop, battery: 'no' }, { runner: true }).map((r) => [r.key, r]));
t('same laptop on mains --runner: slots', `${lapMainsOn['runner-possible'].value} ${lapMainsOn['runner-vm-cpus'].value} ${lapMainsOn['runner-vm-memory-gb'].value} ${lapMainsOn['runner-slots-per-repo'].value}`, 'yes 6 12 1');
const lapOptIn = Object.fromEntries(propose(laptop, { runner: true }).map((r) => [r.key, r]));
t('laptop opted in: runner sized', `${lapOptIn['runner-possible'].value} ${lapOptIn['runner-vm-memory-gb'].value} ${lapOptIn['runner-slots-per-repo'].value}`, 'yes 12 1');
t('laptop opted in: reason says on battery by choice', /on battery by choice$/.test(lapOptIn['runner-possible'].why), true);
t('laptop opted in: ceiling leaves room for it', `${lapOptIn['memory-ceiling-gb'].value} ${lapOptIn['autopilot-concurrency'].value}`, '12 2 / 4');
t('opt-in cannot lift a machine below the minimum', propose({ ...laptop, 'memory-gb': 16 }, { runner: true })[0].value, 'no');

// ---- an Intel Mac: one kind of core
const intel = parseMac({ systemProfiler: '      Model Name: MacBook Pro\n      Model Identifier: MacBookPro16,1\n      Processor Name: 6-Core Intel Core i7\n      Total Number of Cores: 6\n      Memory: 16 GB\n', arch: 'x64' });
t('intel chip', intel.chip, '6-Core Intel Core i7');
t('intel: all performance cores', `${intel['performance-cores']} ${intel['efficiency-cores']}`, '6 0');
t('intel: memory from system_profiler', intel['memory-gb'], 16);

// ---- Linux: a 16 GB machine
const small = parseLinux({
  cpuinfo: 'processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD Ryzen 7 5800U with Radeon Graphics\n',
  meminfo: 'MemTotal:       16303868 kB\nMemFree:         1234567 kB\nMemAvailable:    9000000 kB\n',
  nproc: '16\n', dmiProduct: 'ThinkPad T14 Gen 2a\n', osRelease: 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
  df: 'Filesystem     1K-blocks     Used Available Use% Mounted on\n/dev/nvme0n1p2 490617784 90000000 375000000  20% /\n',
  powerSupplies: ['Mains\n', 'Battery\n'], procVersion: 'Linux version 6.8.0-45-generic', arch: 'x64',
});
t('linux model', small.model, 'ThinkPad T14 Gen 2a');
t('linux chip', small.chip, 'AMD Ryzen 7 5800U with Radeon Graphics');
t('linux memory', small['memory-gb'], 16);
t('linux cores, one kind', `${small['cpu-cores']} ${small['performance-cores']} ${small['efficiency-cores']}`, '16 16 0');
t('linux os', small.os, 'Ubuntu 24.04.1 LTS');
t('linux battery', small.battery, 'yes');
t('linux not wsl', small.wsl, 'no');
const sm = sized(small);
t('16 GB: no runner', sm['runner-possible'].value, 'no');
t('16 GB: reason names memory', sm['runner-possible'].why, 'below the minimum: 16 GB memory < 32');
t('16 GB: ceiling', sm['memory-ceiling-gb'].value, '8');
t('16 GB: workers', sm['autopilot-concurrency'].value, '1 / 2');

// ---- WSL: hybrid Intel P/E cores, and the 16 GB ceiling whatever the guest grant
const wsl = parseLinux({
  cpuinfo: 'model name\t: 13th Gen Intel(R) Core(TM) i7-13700H\n', meminfo: 'MemTotal:       25165824 kB\n',
  nproc: '24', cpuCore: '0-15\n', cpuAtom: '16-23\n', osRelease: 'PRETTY_NAME="Ubuntu 22.04.4 LTS"\n',
  df: 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sdc 1055762868 50000000 900000000 6% /\n',
  procVersion: 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@x) #1 SMP', arch: 'x64',
});
t('wsl detected', wsl.wsl, 'yes');
t('wsl os marked', wsl.os, 'Ubuntu 22.04.4 LTS (WSL)');
t('wsl model', wsl.model, 'WSL virtual machine');
t('hybrid P/E split', `${wsl['performance-cores']} ${wsl['efficiency-cores']}`, '16 8');
const ws = sized(wsl);
t('wsl: never a runner host', ws['runner-possible'].value, 'no');
t('wsl: ceiling 16', ws['memory-ceiling-gb'].value, '16');
t('wsl: test cap = P-cores', ws['test-cap'].value, '16');
t('cpu list', countCpuList('0-7,16-23'), 16);
t('unknown memory: no runner', sized({ ...macMini, 'memory-gb': 'unknown' })['runner-possible'].why, 'below the minimum: GB memory unknown');

// ---- the file round-trips, and detect reports only real hardware changes
// A profile written with --runner; desk-env re-proposes with runnerChosen(profile, --runner given?).
const doc = renderProfile(macMini, propose(macMini, { runner: true }), '2026-10-17');
const back = parseProfile(doc);
const again = (profile, hw = macMini, flag = false) => propose(hw, { runner: runnerChosen(profile, flag) });
t('profile hardware value', back.hardware['memory-gb'].value, '64');
t('profile hardware date', back.hardware.chip.detected, '2026-10-17');
t('profile sizing value', back.sizing['autopilot-concurrency'].value, '5 / 10');
t('profile sizing reason', back.sizing['runner-possible'].why, '64 GB >= 32, 12 cores >= 8, 410 GB free >= 100');
t('runner on in the profile stays on', again(back)[0].value, 'yes');
t('no change against itself', hardwareChanges(back, macMini).length + sizingChanges(back, again(back)).length, 0);
const offBack = parseProfile(renderProfile(macMini, propose(macMini), '2026-10-17'));
t('runner off in the profile stays off', again(offBack)[0].value, 'no');
t('runner off: detect reports no change', hardwareChanges(offBack, macMini).length + sizingChanges(offBack, again(offBack)).length, 0);
t('runner off: --runner turns it on', sizingChanges(offBack, again(offBack, macMini, true)).map((c) => c.key).join(), 'runner-possible,runner-vm-cpus,runner-vm-memory-gb,runner-vm-disk-gb,runner-slots-per-repo,runner-memory-reserved-gb,runner-idle-minutes,autopilot-concurrency,memory-ceiling-gb');
t('no profile: runner off', runnerChosen(null), false);
t('no profile: no slot size kept', JSON.stringify(slotChosen(null)), '{}');
const sizedBack = parseProfile(doc.replace('| `runner-slot-cpus` | `2` |', '| `runner-slot-cpus` | `3` |'));
t('a slot size in the profile is chosen', JSON.stringify(slotChosen(sizedBack)), '{"cpus":3,"memoryGB":7}');
t('no profile: no idle timeout kept', idleChosen(null), undefined);
for (const v of ['5', 'off']) {
  const idleBack = parseProfile(doc.replace('| `runner-idle-minutes` | `10` |', `| \`runner-idle-minutes\` | \`${v}\` |`));
  const kept = Object.fromEntries(propose(macMini, { runner: true, idle: idleChosen(idleBack) }).map((r) => [r.key, r]));
  t(`an idle timeout of ${v} in the profile is kept`, `${kept['runner-idle-minutes'].value} ${kept['runner-idle-minutes'].why}`, `${v} kept from the profile`);
}
t('an idle timeout that is not minutes or off is not kept', idleChosen(parseProfile(doc.replace('| `runner-idle-minutes` | `10` |', '| `runner-idle-minutes` | `soon` |'))), undefined);
t('free disk drift is not a hardware change', hardwareChanges(back, { ...macMini, 'disk-free-gb': 300 }).length, 0);
const more = { ...macMini, 'memory-gb': 128 };
t('memory change reported', hardwareChanges(back, more).map((c) => `${c.key}:${c.was}->${c.now}`).join(), 'memory-gb:64->128');
t('memory change re-proposes', sizingChanges(back, again(back, more)).some((c) => c.key === 'runner-vm-memory-gb' && c.now === '48'), true);
t('disk below the minimum re-proposes', sizingChanges(back, again(back, { ...macMini, 'disk-free-gb': 50 }))[0].key, 'runner-possible');

// ---- desk-env: get/why, and the §3b fallback (a set repo row wins; no profile behaves as before)
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-env.mjs');
const T = mkdtempSync(join(tmpdir(), 'desk-machine-'));
const profile = join(T, 'machine.md');
// A stray park-after row, so the repo-only check below fails if the fallback ever reaches every id.
writeFileSync(profile, `${renderProfile(small, propose(small), '2026-10-17')}| \`park-after\` | \`99\` | stray |\n`);
const cfg = (rows) => { const p = join(T, `c${Math.random().toString(36).slice(2)}.md`); writeFileSync(p, `## 3b. Cost\n\n| Field | Recommended | Your setting |\n|---|---|---|\n${rows}\n`); return p; };
const env = (args, config, machine = profile) => {
  try {
    return execFileSync('node', [BIN, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, DESK_CONFIG: config, DESK_MACHINE: machine, HOME: T } }).trim();
  } catch (e) { return `exit ${e.status}`; }
};
const todo = cfg('| Test worker cap under the test lock | `4` | `TODO` |\n| Memory ceiling for parallel work (GB) | `16` | `TODO` |');
const set = cfg('| Test worker cap under the test lock | `4` | `3` |\n| Autopilot worker concurrency | `2 / 3` | `2 / 3` |');
const absent = cfg('| Preferred dev-server port | `3000` | `3100` |');
t('machine get', env(['machine', 'get', 'runner-possible'], absent), 'no');
t('machine why', env(['machine', 'why', 'runner-possible'], absent), 'below the minimum: 16 GB memory < 32');
t('machine get hardware', env(['machine', 'get', 'memory-gb'], absent), '16');
t('machine get unknown key', env(['machine', 'get', 'nope'], absent), 'exit 3');
t('machine slot-fit', env(['machine', 'slot-fit', '8', '24'], absent), '3\t2\t7\t2\tmin(8 CPUs / 2, (24 GB - 2 for the VM) / 7 GB)');
t('machine slot-fit needs two numbers', env(['machine', 'slot-fit', '8'], absent), 'exit 2');
t('TODO row falls back', env(['get', 'test-cap'], todo), '16');
t('TODO ceiling falls back', env(['get', 'memory-ceiling'], todo), '8');
t('absent row falls back', env(['get', 'concurrency'], absent), '1 / 2');
t('set row wins', env(['get', 'test-cap'], set), '3');
t('set concurrency wins', env(['get', 'concurrency'], set), '2 / 3');
t('the stray row is readable', env(['machine', 'get', 'park-after'], absent), '99');
t('a repo-only row never falls back', env(['get', 'park-after'], absent), 'exit 3');
t('machine --runner write is not a subcommand', env(['machine', '--runner', 'write'], absent), 'exit 2');
const missing = join(T, 'none.md');
t('no profile: TODO row stays unset', env(['get', 'test-cap'], todo, missing), 'exit 3');
t('no profile: machine get exits 3', env(['machine', 'get', 'runner-possible'], absent, missing), 'exit 3');
rmSync(T, { recursive: true, force: true });

console.log(fails ? `${fails} FAILED` : 'machine: all checks passed');
process.exit(fails ? 1 : 0);
