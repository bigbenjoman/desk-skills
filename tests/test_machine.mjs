// suite: machine profile (detection, sizing, §3b fallback)
// The machine profile: hardware parsing from fixture output, the sizing rules, the profile file, and
// the §3b fallback through desk-env. Scratch directories only; nothing reads this computer.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMac, parseLinux, propose, renderProfile, parseProfile, hardwareChanges, sizingChanges, countCpuList } from '../desk/bin/machine.mjs';
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

const mini = sized(macMini);
t('desktop: sizes nothing for a CI runner', Object.keys(mini).filter((k) => k.startsWith('runner-')).join(), '');
t('desktop: ceiling is memory less the OS', `${mini['memory-ceiling-gb'].value} ${mini['memory-ceiling-gb'].why}`, '56 64 GB - 8 for the OS');
t('desktop: workers at 3 GB each', mini['autopilot-concurrency'].value, '9 / 18');
t('desktop: test cap = performance cores shared by the lock slots', `${mini['test-cap'].value} ${mini['test-cap'].why}`, '4 the 8 performance cores, shared by 2 test lock slots');
t('desktop: 2 test lock slots (56 GB / 16 = 3, 8 P-cores / 4 = 2)', mini['test-lock-slots'].value, '2');
t('desktop: slots x test cap stays within the P-cores', Number(mini['test-lock-slots'].value) * Number(mini['test-cap'].value) <= 8, true);
t('desktop: typecheck lock timeout', mini['typecheck-lock-timeout-min'].value, '20');
t('desktop: pre-push lock timeout', mini['pre-push-lock-timeout-s'].value, '60');

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
t('laptop: ceiling 32 - 8', lap['memory-ceiling-gb'].value, '24');
t('laptop: workers', lap['autopilot-concurrency'].value, '4 / 8');
t('laptop: test cap', lap['test-cap'].value, '8');
t('laptop: one test lock slot (24 GB / 16), so the test cap keeps every P-core', lap['test-lock-slots'].value, '1');
t('laptop: battery or mains sizes the same', JSON.stringify(propose({ ...laptop, battery: 'no' })), JSON.stringify(propose(laptop)));

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
t('16 GB: ceiling', sm['memory-ceiling-gb'].value, '8');
t('16 GB: workers', sm['autopilot-concurrency'].value, '1 / 2');
t('16 GB: one test lock slot (8 GB / 16 rounds down, at least 1)', sm['test-lock-slots'].value, '1');

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
t('wsl: ceiling 16', ws['memory-ceiling-gb'].value, '16');
t('wsl: test cap = P-cores', ws['test-cap'].value, '16');
t('wsl: test lock slots bound by the 16 GB ceiling', ws['test-lock-slots'].value, '1');
t('cpu list', countCpuList('0-7,16-23'), 16);

// ---- the file round-trips, and detect reports only real hardware changes
const doc = renderProfile(macMini, propose(macMini), '2026-10-17');
const back = parseProfile(doc);
t('profile hardware value', back.hardware['memory-gb'].value, '64');
t('profile hardware date', back.hardware.chip.detected, '2026-10-17');
t('profile sizing value', back.sizing['autopilot-concurrency'].value, '9 / 18');
t('profile sizing reason', back.sizing['memory-ceiling-gb'].why, '64 GB - 8 for the OS');
t('no change against itself', hardwareChanges(back, macMini).length + sizingChanges(back, propose(macMini)).length, 0);
// A profile written while desk sized a CI runner: its runner rows still parse, and nothing reads them.
const oldRows = '| `runner-possible` | `yes` | old |\n| `runner-vm-memory-gb` | `24` | old |\n' +
  '| `runner-memory-reserved-gb` | `24` | old |\n| `runner-memory-floor-gb` | `8` | old |\n';
const oldDoc = doc.replace('| `autopilot-concurrency` |', `${oldRows}| \`autopilot-concurrency\` |`);
const oldBack = parseProfile(oldDoc);
t('an old profile with runner rows loads', `${oldBack.sizing['runner-possible'].value} ${oldBack.sizing['autopilot-concurrency'].value}`, 'yes 9 / 18');
t('an old profile\'s runner rows are no change', sizingChanges(oldBack, propose(macMini)).length, 0);
t('free disk drift is not a hardware change', hardwareChanges(back, { ...macMini, 'disk-free-gb': 300 }).length, 0);
const more = { ...macMini, 'memory-gb': 128 };
t('memory change reported', hardwareChanges(back, more).map((c) => `${c.key}:${c.was}->${c.now}`).join(), 'memory-gb:64->128');
t('memory change re-proposes', sizingChanges(back, propose(more)).some((c) => c.key === 'memory-ceiling-gb' && c.now === '120'), true);

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
t('machine get', env(['machine', 'get', 'memory-ceiling-gb'], absent), '8');
t('machine why', env(['machine', 'why', 'memory-ceiling-gb'], absent), '16 GB - 8 for the OS');
t('machine get hardware', env(['machine', 'get', 'memory-gb'], absent), '16');
t('machine get unknown key', env(['machine', 'get', 'nope'], absent), 'exit 3');
t('machine slot-fit is gone', env(['machine', 'slot-fit', '8', '24'], absent), 'exit 2');
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
t('no profile: machine get exits 3', env(['machine', 'get', 'memory-ceiling-gb'], absent, missing), 'exit 3');
rmSync(T, { recursive: true, force: true });

console.log(fails ? `${fails} FAILED` : 'machine: all checks passed');
process.exit(fails ? 1 : 0);
