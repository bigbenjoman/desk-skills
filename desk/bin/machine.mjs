// The machine profile: what this computer is, and how much local work it can carry.
//
// One file per computer, ~/.config/desk/machine.md (desk-env.mjs owns the path), shared by every
// repo. Two tables: Hardware (detected, each row dated) and Sizing (proposed from the hardware by
// the rules below, written only once the user confirms in /desk-setup). desk-env reads it by key
// (`desk-env machine get <key>`), and a repo's §3b rows that are really about the computer fall back
// to it when they are TODO or absent. No profile means every caller behaves as if this file did not
// exist.
//
// Detection is split from parsing so the parsers run on fixture output: gather() runs the
// platform's commands, parseMac()/parseLinux() turn their raw text into the hardware rows.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { arch as osArch, cpus, platform as osPlatform } from 'node:os';
import { join } from 'node:path';

export const HARDWARE_KEYS = Object.freeze([
  'model', 'chip', 'cpu-cores', 'performance-cores', 'efficiency-cores', 'gpu-cores',
  'memory-gb', 'disk-free-gb', 'os', 'arch', 'battery', 'wsl',
]);
export const SIZING_KEYS = Object.freeze([
  'autopilot-concurrency',
  'memory-ceiling-gb', 'test-cap', 'test-lock-slots', 'typecheck-lock-timeout-min', 'pre-push-lock-timeout-s',
]);

// The bench's quota settings: Sizing rows no proposal makes, set by `desk-env machine set` from the
// user's answers and read by bench-quota.mjs.
export const BENCH_CAP_KEY = 'bench-cap-points';
export const BENCH_RESERVE_KEY = 'bench-reserve-percent';
const BENCH_RULES = Object.freeze({
  [BENCH_CAP_KEY]: { ok: (n) => n > 0, want: 'a positive number of points of the weekly allowance',
    why: 'points of each weekly allowance the bench may spend, set in /desk-setup' },
  [BENCH_RESERVE_KEY]: { ok: (n) => n < 100, want: 'a percentage of the weekly allowance from 0 to under 100',
    why: '% of each weekly allowance the bench leaves for interactive work, set in /desk-setup' },
});
// `bench-run-limit-<provider>`: the most runs the bench may start in a rolling week on a provider it
// has no meter or allowance ledger for, which it otherwise refuses.
const BENCH_RUN_LIMIT = /^bench-run-limit-[a-z0-9][a-z0-9-]*$/;
const RUN_LIMIT_RULE = Object.freeze({ ok: (n) => Number.isInteger(n) && n > 0, want: 'a whole number of runs a week, 1 or more',
  why: 'runs a week the bench may start on this provider, which it has no meter for, set by its user' });
const benchRule = (key) => BENCH_RULES[key] ?? (BENCH_RUN_LIMIT.test(key) ? RUN_LIMIT_RULE : null);
export const benchWhy = (key) => benchRule(key)?.why;
// Why a value cannot be stored or read as one of the bench settings, or null when it can.
export function benchSettingError(key, raw) {
  const rule = benchRule(key);
  if (!rule) return `\`${key}\` is not a bench setting: want ${Object.keys(BENCH_RULES).join(' or ')} or bench-run-limit-<provider>`;
  const v = String(raw ?? '').trim();
  return /^\d+(\.\d+)?$/.test(v) && rule.ok(Number(v)) ? null : `\`${key}\` is "${raw}": want ${rule.want}`;
}

// The thresholds and ratios the proposal uses. Changing one changes every new proposal, never a
// profile already written.
export const RULES = Object.freeze({
  osReserveGB: 8, wslCeilingGB: 16, workerHeavyGB: 3, minTestWorkers: 4, memoryPerLockSlotGB: 16,
  typecheckLockTimeoutMin: 20, prePushLockTimeoutS: 60,
});

const num = (v) => (v === '' || v == null ? NaN : Number(v));
const known = (v) => Number.isFinite(v);

// ---- parsing ---------------------------------------------------------------------------------
// Every parser returns the full HARDWARE_KEYS set; anything it could not read is 'unknown'.
const blank = () => Object.fromEntries(HARDWARE_KEYS.map((k) => [k, 'unknown']));
const kbToGB = (kb) => Math.round(num(kb) / 1024 / 1024);

// `df -k /`: the Available column of the last line (a long device name can wrap onto its own line).
export function parseDfAvailableGB(df) {
  const rows = String(df ?? '').trim().split('\n').slice(1).join(' ').trim().split(/\s+/);
  const kb = num(rows[3]);
  return known(kb) ? kbToGB(kb) : 'unknown';
}

// `0-7,16-23` -> 16
export function countCpuList(list) {
  let n = 0;
  for (const part of String(list ?? '').trim().split(',').filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    if (!known(a)) return NaN;
    n += known(b) ? b - a + 1 : 1;
  }
  return n || NaN;
}

const sysctlValue = (out, key) => new RegExp(`^${key.replace(/\./g, '\\.')}:\\s*(.+)$`, 'm').exec(out ?? '')?.[1].trim();

// macOS: `system_profiler SPHardwareDataType SPDisplaysDataType`, `sysctl <keys>`, `sw_vers`,
// `df -k /`, `pmset -g batt`.
export function parseMac({ systemProfiler = '', sysctl = '', swVers = '', df = '', pmset = '', arch = '' } = {}) {
  const hw = blank();
  const [cpuPart, gpuPart = ''] = String(systemProfiler).split(/^Graphics\/Displays:/m);
  const field = (text, label) => new RegExp(`^\\s*${label}:\\s*(.+)$`, 'm').exec(text)?.[1].trim();

  const name = field(cpuPart, 'Model Name');
  const id = field(cpuPart, 'Model Identifier') ?? sysctlValue(sysctl, 'hw.model');
  if (name || id) hw.model = name && id ? `${name} (${id})` : name ?? id;
  const chip = field(cpuPart, 'Chip') ?? field(cpuPart, 'Processor Name') ?? sysctlValue(sysctl, 'machdep.cpu.brand_string');
  if (chip) hw.chip = chip;

  const cores = /Total Number of Cores:\s*(\d+)(?:\s*\((\d+) performance and (\d+) efficiency\))?/.exec(cpuPart);
  const total = num(cores?.[1] ?? sysctlValue(sysctl, 'hw.ncpu'));
  const perf = num(cores?.[2] ?? sysctlValue(sysctl, 'hw.perflevel0.physicalcpu'));
  const eff = num(cores?.[3] ?? sysctlValue(sysctl, 'hw.perflevel1.physicalcpu'));
  if (known(total)) {
    hw['cpu-cores'] = total;
    // Intel Macs have one kind of core: all of them are performance cores.
    hw['performance-cores'] = known(perf) ? perf : total;
    hw['efficiency-cores'] = known(eff) ? eff : known(perf) ? total - perf : 0;
  }
  const gpu = num(/Total Number of Cores:\s*(\d+)/.exec(gpuPart)?.[1]);
  if (known(gpu)) hw['gpu-cores'] = gpu;

  const memSize = num(sysctlValue(sysctl, 'hw.memsize'));
  const memGB = known(memSize) ? Math.round(memSize / 1024 ** 3) : num(/^\s*Memory:\s*(\d+)\s*GB/m.exec(cpuPart)?.[1]);
  if (known(memGB)) hw['memory-gb'] = memGB;

  hw['disk-free-gb'] = parseDfAvailableGB(df);
  const product = field(swVers, 'ProductName') ?? 'macOS';
  const version = field(swVers, 'ProductVersion');
  if (version) hw.os = `${product} ${version}`;
  if (arch) hw.arch = arch;
  hw.battery = /InternalBattery/.test(pmset) ? 'yes' : 'no';
  hw.wsl = 'no';
  return hw;
}

// Linux and WSL: /proc/cpuinfo, /proc/meminfo, nproc, the hybrid-CPU lists
// (/sys/devices/cpu_core/cpus, /sys/devices/cpu_atom/cpus), the DMI product name, /etc/os-release,
// `df -k /`, the /sys/class/power_supply/*/type values and /proc/version.
export function parseLinux({ cpuinfo = '', meminfo = '', nproc = '', cpuCore = '', cpuAtom = '', dmiProduct = '',
  osRelease = '', df = '', powerSupplies = [], procVersion = '', arch = '' } = {}) {
  const hw = blank();
  const wsl = /microsoft/i.test(procVersion);
  const product = String(dmiProduct).trim();
  if (product && !/^(to be filled|default string|system product name)/i.test(product)) hw.model = product;
  else if (wsl) hw.model = 'WSL virtual machine';
  const chip = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1].trim();
  if (chip) hw.chip = chip;

  const total = num(String(nproc).trim());
  if (known(total)) {
    hw['cpu-cores'] = total;
    // A hybrid Intel CPU lists its P-cores and E-cores separately; anything else has one kind.
    const p = countCpuList(cpuCore);
    const e = countCpuList(cpuAtom);
    hw['performance-cores'] = known(p) ? p : total;
    hw['efficiency-cores'] = known(e) ? e : known(p) ? total - p : 0;
  }
  const memKB = num(/^MemTotal:\s*(\d+)/m.exec(meminfo)?.[1]);
  if (known(memKB)) hw['memory-gb'] = kbToGB(memKB);

  hw['disk-free-gb'] = parseDfAvailableGB(df);
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(osRelease)?.[1].trim();
  if (pretty) hw.os = wsl ? `${pretty} (WSL)` : pretty;
  if (arch) hw.arch = arch;
  hw.battery = powerSupplies.some((t) => /^battery$/i.test(String(t).trim())) ? 'yes' : 'no';
  hw.wsl = wsl ? 'yes' : 'no';
  return hw;
}

// ---- detection -------------------------------------------------------------------------------
// A command that fails or is missing reads as empty output, so the row reads 'unknown'. sysctl
// exits non-zero when one key is absent (perflevel on Intel) but still prints the rest.
const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }); }
  catch (e) { return typeof e.stdout === 'string' ? e.stdout : ''; }
};
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

export function gather(plat = osPlatform()) {
  const arch = osArch();
  if (plat === 'darwin') {
    return parseMac({
      systemProfiler: run('system_profiler', ['SPHardwareDataType', 'SPDisplaysDataType']),
      sysctl: run('sysctl', ['hw.ncpu', 'hw.memsize', 'hw.model', 'hw.perflevel0.physicalcpu', 'hw.perflevel1.physicalcpu', 'machdep.cpu.brand_string']),
      swVers: run('sw_vers', []), df: run('df', ['-k', '/']), pmset: run('pmset', ['-g', 'batt']), arch,
    });
  }
  if (plat === 'linux') {
    const ps = '/sys/class/power_supply';
    let supplies = [];
    try { supplies = readdirSync(ps).map((d) => read(join(ps, d, 'type'))); } catch { /* no power_supply class */ }
    return parseLinux({
      cpuinfo: read('/proc/cpuinfo'), meminfo: read('/proc/meminfo'),
      nproc: run('nproc', []).trim() || String(cpus().length),
      cpuCore: read('/sys/devices/cpu_core/cpus'), cpuAtom: read('/sys/devices/cpu_atom/cpus'),
      dmiProduct: read('/sys/devices/virtual/dmi/id/product_name'), osRelease: read('/etc/os-release'),
      df: run('df', ['-k', '/']), powerSupplies: supplies, procVersion: read('/proc/version'), arch,
    });
  }
  const hw = blank();
  hw['cpu-cores'] = cpus().length;
  hw['performance-cores'] = cpus().length;
  hw.os = plat;
  hw.arch = arch;
  return hw;
}

// ---- the proposal ----------------------------------------------------------------------------
// -> [{ key, value, why }] in SIZING_KEYS order; `why` is the arithmetic, shown before anything is
// written and kept in the profile's Why column.
export function propose(hw, r = RULES) {
  const mem = num(hw['memory-gb']);
  const cores = num(hw['cpu-cores']);
  const perf = known(num(hw['performance-cores'])) ? num(hw['performance-cores']) : cores;
  const wsl = hw.wsl === 'yes';
  const rows = [];
  const add = (key, value, why) => rows.push({ key, value: String(value), why });

  let ceiling;
  let ceilingWhy;
  if (!known(mem)) { ceiling = r.wslCeilingGB; ceilingWhy = `memory unknown: ${r.wslCeilingGB}`; }
  else if (wsl) {
    ceiling = Math.max(2, Math.min(r.wslCeilingGB, mem - r.osReserveGB));
    ceilingWhy = `WSL: min(${r.wslCeilingGB}, ${mem} - ${r.osReserveGB} for the OS); the Windows host caps VmmemWSL below the guest's grant`;
  } else {
    ceiling = Math.max(2, mem - r.osReserveGB);
    ceilingWhy = `${mem} GB - ${r.osReserveGB} for the OS`;
  }
  const cap = Math.max(1, Math.floor(ceiling / r.workerHeavyGB));
  const def = Math.max(1, Math.floor(cap / 2));
  add('autopilot-concurrency', `${def} / ${cap}`, `cap floor(${ceiling} GB / ${r.workerHeavyGB} GB per worker in its heavy stage), default half the cap`);
  add('memory-ceiling-gb', ceiling, ceilingWhy);
  // with-lock.sh lets test-lock-slots suites or typechecks hold the test lock at once, each with
  // test-cap test workers, so the slots share the P-cores between them: slots x test-cap stays within
  // the P-cores. Each slot also needs room beside the workers in their own heavy stage.
  const testCores = known(perf) ? Math.max(1, perf) : 4;
  const slots = Math.max(1, Math.min(Math.floor(ceiling / r.memoryPerLockSlotGB), Math.floor(testCores / r.minTestWorkers)));
  add('test-cap', Math.max(1, Math.floor(testCores / slots)),
    `${known(perf) ? `the ${perf} performance cores` : 'core count unknown: 4'}${slots > 1 ? `, shared by ${slots} test lock slots` : ''}`);
  add('test-lock-slots', slots,
    `min(floor(${ceiling} GB / ${r.memoryPerLockSlotGB} GB per slot), floor(${testCores} cores / ${r.minTestWorkers} test workers at least per suite)), at least 1: suites and typechecks that hold the test lock at once`);
  add('typecheck-lock-timeout-min', r.typecheckLockTimeoutMin,
    `how long a typecheck waits on the lock before the wait is reported; with-lock.sh itself never times out`);
  add('pre-push-lock-timeout-s', r.prePushLockTimeoutS,
    'how long the pre-push hook waits for the test lock before skipping a typecheck or suite; CI runs it anyway');
  return rows;
}

// ---- the file --------------------------------------------------------------------------------
// Split a markdown table row into cells. A `|` inside backticks is part of the value (a regex such
// as `KAN-[0-9]+|VPL-[0-9]+`), not a column break; `\|` is a literal pipe too. desk-env's config
// parser uses this as well, so the config and the profile split rows one way.
export function splitRow(line) {
  const body = line.replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  let tick = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') tick = !tick;
    if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}
const unquote = (s) => String(s ?? '').trim().replace(/^`(.*)`$/, '$1').trim();
const esc = (s) => String(s).replace(/\|/g, '\\|');
// The Sizing table's heading and header, and one of its rows; renderProfile and setSizingRows share them.
const SIZING_HEAD = Object.freeze(['## Sizing', '', '| Key | Value | Why |', '|---|---|---|']);
const sizingRow = (s) => `| \`${s.key}\` | \`${esc(s.value)}\` | ${esc(s.why)} |`;

// -> { hardware: { key: { value, detected } }, sizing: { key: { value, why } } }
export function parseProfile(text) {
  const out = { hardware: {}, sizing: {} };
  let section = null;
  let header = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { section = /hardware/i.test(h[1]) ? 'hardware' : /sizing/i.test(h[1]) ? 'sizing' : null; header = false; continue; }
    if (!section || !line.startsWith('|')) { header = false; continue; }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    if (!header) { header = true; continue; }
    const key = unquote(cells[0]).toLowerCase();
    if (!key) continue;
    const value = unquote(cells[1]);
    out[section][key] = section === 'hardware' ? { value, detected: unquote(cells[2]) } : { value, why: (cells[2] ?? '').trim() };
  }
  return out;
}

export const readProfile = (path) => (path && existsSync(path) ? parseProfile(readFileSync(path, 'utf8')) : null);

export function renderProfile(hw, sizing, date) {
  const lines = [
    '# Machine profile',
    '',
    'What this computer is, and how much local work desk sizes for it. Written by',
    '`desk-env machine write` once you confirmed the proposal in `/desk-setup`; every repo reads it.',
    "A repo's §3b row that is set wins over the matching row here. Edit a value by hand if you need to;",
    '`desk-env machine detect` shows what has changed since, and `desk-env machine propose` re-proposes.',
    '',
    '## Hardware',
    '',
    '| Key | Value | Detected |',
    '|---|---|---|',
    ...HARDWARE_KEYS.map((k) => `| \`${k}\` | \`${esc(hw[k] ?? 'unknown')}\` | \`${date}\` |`),
    '',
    ...SIZING_HEAD,
    ...sizing.map(sizingRow),
    '',
  ];
  return lines.join('\n');
}

// The profile text with each of rows ([{ key, value, why }]) set in its Sizing table: an existing
// row for the key is replaced in place, a new one goes at the table's end. Everything else is kept.
export function setSizingRows(text, rows) {
  const lines = String(text ?? '').replace(/\n+$/, '').split('\n');
  let start = lines.findIndex((l) => /^##\s+.*sizing/i.test(l.trim()));
  if (start < 0) {
    lines.push('', ...SIZING_HEAD);
    start = lines.length - SIZING_HEAD.length;
  }
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end].trim())) end++;
  for (const r of rows) {
    const line = sizingRow(r);
    const at = lines.slice(start, end).findIndex((l) => l.trim().startsWith('|') && unquote(splitRow(l.trim())[0]).toLowerCase() === r.key);
    if (at >= 0) { lines[start + at] = line; continue; }
    let last = end - 1;
    while (last > start && !lines[last].trim().startsWith('|')) last--;
    lines.splice(last + 1, 0, line);
    end++;
  }
  return `${lines.join('\n')}\n`;
}

// The text `desk-env machine set` starts a profile from when there is none: no Hardware rows and no
// proposed sizes, so sizesProposed reads false and /desk-setup still offers the whole proposal.
export const BENCH_ONLY_PROFILE = [
  '# Machine profile',
  '',
  'Started by `desk-env machine set` to keep the bench settings below. No sizes are proposed yet:',
  '`desk-env machine propose` shows them, and `desk-env machine write` adds them once you confirm.',
  '',
].join('\n');

// Whether the profile holds the confirmed proposal (`machine write` always records the hardware).
export const sizesProposed = (profile) => Object.keys(profile?.hardware ?? {}).length > 0;

// The Sizing rows a re-written profile holds: the proposal, then every row the profile has that the
// proposal does not make (set by `desk-env machine set`), so a re-write keeps them.
export function rewrittenSizing(profile, proposal) {
  const proposed = new Set(proposal.map((s) => s.key));
  const kept = Object.entries(profile?.sizing ?? {}).filter(([k]) => !proposed.has(k)).map(([key, s]) => ({ key, value: s.value, why: s.why }));
  return [...proposal, ...kept];
}

// Hardware rows that differ from the profile. Free disk moves every day, so it never counts.
export function hardwareChanges(profile, hw) {
  return HARDWARE_KEYS.filter((k) => k !== 'disk-free-gb')
    .filter((k) => profile?.hardware?.[k] && String(profile.hardware[k].value) !== String(hw[k]))
    .map((k) => ({ key: k, was: profile.hardware[k].value, now: String(hw[k]) }));
}
export function sizingChanges(profile, proposal) {
  return proposal
    .filter((s) => profile?.sizing?.[s.key] && profile.sizing[s.key].value !== s.value)
    .map((s) => ({ key: s.key, was: profile.sizing[s.key].value, now: s.value }));
}
