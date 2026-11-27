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
// The sizes the proposal makes, in its order, each with the check a hand-set override must pass.
const wholeAtLeast = (min) => (v) => /^\d+$/.test(v) && Number(v) >= min;
const numberAtLeast = (min) => (v) => /^\d+(\.\d+)?$/.test(v) && Number(v) >= min;

// ---- headroom admission ----------------------------------------------------------------------
// Each lock pool, heavy (test-lock-slots) and light (light-lock-slots), has a floor of slots always
// granted and a ceiling (test-lock-max, light-lock-max) it never passes. Between them a run is let in
// only while the machine's load, free memory and memory pressure leave room for it (admission.mjs).
// lock-admission says whether that runs: off; shadow, which logs what it would do and grants nothing;
// or on, which grants it. A row here that does not read makes admission off, so a typo never takes a
// slot away and never grants one.
const ADMISSION_MODES = Object.freeze(['off', 'shadow', 'on']);
const ADMISSION_RULES = Object.freeze({
  'lock-admission': { ok: (v) => ADMISSION_MODES.includes(v), want: 'off, shadow or on' },
  'light-lock-slots': { ok: wholeAtLeast(1), want: 'a whole number of slots, 1 or more' },
  'light-lock-max': { ok: wholeAtLeast(1), want: 'a whole number of slots, 1 or more' },
  'test-lock-max': { ok: wholeAtLeast(1), want: 'a whole number of slots, 1 or more' },
  'admit-max-load': { ok: numberAtLeast(0), want: 'a number, the 1-minute load average to stay at or under' },
  'admit-run-load': { ok: numberAtLeast(0), want: 'a number, the load one run adds' },
  'admit-reserve-gb': { ok: numberAtLeast(0), want: 'a number of GB to keep free' },
  'heavy-run-gb': { ok: numberAtLeast(0), want: 'a number of GB one heavy run takes' },
  'light-run-gb': { ok: numberAtLeast(0), want: 'a number of GB one light run takes' },
  'admit-max-pressure': { ok: numberAtLeast(1), want: 'a pressure level, 1 normal, 2 warn, 4 critical' },
  'admit-ramp-s': { ok: wholeAtLeast(0), want: 'a whole number of seconds' },
});
const ADMISSION_KEYS = Object.freeze(Object.keys(ADMISSION_RULES));
// Proposed rows whose value is another row's: each follows that row's override when a write keeps one.
const FOLLOWS = Object.freeze({ 'test-lock-max': 'test-lock-slots', 'light-lock-max': 'light-lock-slots', 'admit-run-load': 'test-cap' });
const ADMISSION_FIXED = Object.freeze({ 'lock-admission': 'off', 'admit-reserve-gb': '8', 'heavy-run-gb': '16', 'light-run-gb': '16', 'admit-max-pressure': '2', 'admit-ramp-s': '90' });
// admit-max-load's default: this many times every CPU core, efficiency cores at full weight.
const ADMIT_LOAD_PER_CORE = 1.67;
const admitMaxLoad = (cores) => String(Math.round(ADMIT_LOAD_PER_CORE * (known(num(cores)) ? num(cores) : 4)));

// The admission rows, read through `get(key)` (a profile value or null), each with its default where
// unset: -> { rows: { key: number | string }, problems: [line] }. A row set but unreadable, or a ceiling
// under its floor, is a problem naming the row and what it wants; any problem means mode off.
// `testSlots` is the heavy floor as the test lock reads it (desk-env testLockSlots), `lightSlots` the
// light floor as the light lock reads it (desk-env lightLockSlots), which over light-lock-max is not a
// problem: with admission on it raises the light ceiling to itself.
export function admissionRows(get, { testSlots = null, lightSlots = null } = {}) {
  const problems = [];
  const raw = (k) => { const v = get(k); return v == null ? null : String(v).trim(); };
  const rows = {};
  for (const k of ADMISSION_KEYS) {
    const v = raw(k);
    if (v == null) continue;
    if (!ADMISSION_RULES[k].ok(v)) { problems.push(`\`${k}\` is "${v}": want ${ADMISSION_RULES[k].want}`); continue; }
    rows[k] = k === 'lock-admission' ? v : Number(v);
  }
  for (const [k, v] of Object.entries(ADMISSION_FIXED)) rows[k] ??= k === 'lock-admission' ? v : Number(v);
  const slots = raw('test-lock-slots');
  rows['test-lock-slots'] = testSlots ?? (wholeAtLeast(1)(slots ?? '') ? Number(slots) : 1);
  if (lightSlots != null) rows['light-lock-slots'] = lightSlots;
  rows['light-lock-slots'] ??= 1;
  for (const [max, floor] of [['test-lock-max', 'test-lock-slots'], ['light-lock-max', 'light-lock-slots']]) {
    if (rows[max] == null) { if (raw(max) == null) rows[max] = rows[floor]; continue; }
    if (rows[max] < rows[floor] && !(floor === 'light-lock-slots' && lightSlots != null)) problems.push(`\`${max}\` is "${rows[max]}": want a whole number of slots, at least \`${floor}\` (${rows[floor]})`);
  }
  if (rows['admit-max-load'] == null && raw('admit-max-load') == null) rows['admit-max-load'] = Number(admitMaxLoad(get('cpu-cores')));
  if (rows['admit-run-load'] == null && raw('admit-run-load') == null) {
    const cap = raw('test-cap');
    if (wholeAtLeast(1)(cap ?? '')) rows['admit-run-load'] = Number(cap);
    // Only a problem where admission would run: a profile with neither row and admission off is fine.
    else if (rows['lock-admission'] !== 'off') problems.push('`admit-run-load` is unset and so is `test-cap`, its default: want a number, the load one run adds');
  }
  const mode = problems.length ? 'off' : rows['lock-admission'];
  // The light floor is the repo's row (lightLockSlots, already held to one under the spawn gate), so
  // with admission on it raises the light ceiling to itself rather than being cut to light-lock-max:
  // the ceiling is max(row, light-lock-max), and runs above the floor come only through a grant.
  if (mode === 'on' && rows['light-lock-max'] < rows['light-lock-slots']) rows['light-lock-max'] = rows['light-lock-slots'];
  return { rows, problems, mode };
}

const SIZING_RULES = Object.freeze({
  'autopilot-concurrency': { ok: (v) => /^\d+ \/ \d+$/.test(v) && Number(v.split(' / ')[0]) >= 1 && Number(v.split(' / ')[0]) <= Number(v.split(' / ')[1]),
    want: '"<default> / <cap>", whole numbers with the default from 1 to the cap' },
  'memory-ceiling-gb': { ok: wholeAtLeast(1), want: 'a whole number of GB, 1 or more' },
  'test-cap': { ok: wholeAtLeast(1), want: 'a whole number of test workers, 1 or more' },
  'test-lock-slots': { ok: wholeAtLeast(1), want: 'a whole number of slots, 1 or more' },
  'test-lock-queue-factor': { ok: wholeAtLeast(1), want: 'a whole number, 1 or more' },
  'typecheck-lock-timeout-min': { ok: wholeAtLeast(0), want: 'a whole number of minutes' },
  'pre-push-lock-timeout-s': { ok: wholeAtLeast(0), want: 'a whole number of seconds' },
  'turbo-concurrency': { ok: wholeAtLeast(1), want: 'a whole number of turbo tasks at once, 1 or more' },
  ...ADMISSION_RULES,
});
export const SIZING_KEYS = Object.freeze(Object.keys(SIZING_RULES));

// The light lock's express lane: one fixed slot of its own, never gated on headroom, that only a run
// with-lock.sh is told is small may take. Off unless the row is exactly `on`.
const EXPRESS_LANE_KEY = 'light-express-lane';
// A Sizing row that is a lever, on or off, checked as text.
const ON_OFF = Object.freeze(['on', 'off']);
const onOffRule = (key, why) => ({ text: true, problem: (v) => (ON_OFF.includes(v) ? null : `\`${key}\` is "${v}": want on or off`), why });
// The job-token lever: with it on, each suite tests/run.sh starts holds one token from a machine-wide
// budget of test-lock-slots x test-cap (leases.mjs's job pool). Off unless the row is exactly `on`.
export const JOB_TOKENS_KEY = 'job-tokens';
export const jobTokensOn = (v) => String(v ?? '').trim() === 'on';
// The bench's quota settings: Sizing rows no proposal makes, set by `desk-env machine set` from the
// user's answers and read by bench-quota.mjs.
export const BENCH_CAP_KEY = 'bench-cap-points';
export const BENCH_RESERVE_KEY = 'bench-reserve-percent';
const BENCH_RULES = Object.freeze({
  [BENCH_CAP_KEY]: { ok: (n) => n > 0, want: 'a positive number of points of the weekly allowance',
    why: 'points of each weekly allowance the bench may spend, set in /desk-setup' },
  [BENCH_RESERVE_KEY]: { ok: (n) => n < 100, want: 'a percentage of the weekly allowance from 0 to under 100',
    why: '% of each weekly allowance the bench leaves for interactive work, set in /desk-setup' },
  // Not the bench's, but set the same way: a Sizing row no proposal makes, which the lease broker
  // (leases.mjs) reads, 1 when unset.
  'preview-build-slots': { ok: (n) => Number.isInteger(n) && n >= 1, want: 'a whole number of preview builds at once per Vercel team, 1 or more',
    why: 'preview builds one Vercel team may run at once, read by desk-env lease; set by its user' },
  // The lease broker's per-kind lever, read as text rather than a number.
  'lease-kinds': { text: true, problem: (v) => leaseKindsProblem(v),
    why: 'off, shadow or on for each lease kind desk-env lease decides; a kind not named is shadow' },
  [EXPRESS_LANE_KEY]: onOffRule(EXPRESS_LANE_KEY,
    'on gives a small light run (tests/related.sh) one light slot of its own, outside light-lock-max; off when unset'),
  [JOB_TOKENS_KEY]: onOffRule(JOB_TOKENS_KEY,
    'on makes each suite tests/run.sh starts hold one of test-lock-slots x test-cap job tokens across the machine; off when unset'),
});
// The lever rows profileProblems checks, each with what reads as off when its row is wrong.
const LEVER_ROWS = Object.freeze([[EXPRESS_LANE_KEY, 'the express lane stays off'], [JOB_TOKENS_KEY, 'job tokens stay off']]);

// ---- lease kinds ------------------------------------------------------------------------------
// The lease broker's kinds (leases.mjs takes its list from here, as this file cannot import it) and
// the modes the lease-kinds row sets each to: off takes nothing, shadow grants and logs what it
// would have refused, on refuses. A kind the row does not name, or names wrongly, reads as
// DEFAULT_LEASE_MODE, so a typo never turns a kind on.
export const LEASE_KINDS = Object.freeze(['port', 'slot', 'preview-build', 'merge', 'mem']);
export const LEASE_MODES = Object.freeze(['off', 'shadow', 'on']);
export const DEFAULT_LEASE_MODE = 'shadow';
// `port=on slot=shadow` (spaces or commas between entries) -> { modes: { kind: mode }, unknown: [entry] }.
export function parseLeaseKinds(raw) {
  const modes = {}; const unknown = []; const garbled = new Set();
  for (const entry of String(raw ?? '').split(/[\s,]+/).filter(Boolean)) {
    const m = /^([\w-]+)=(.*)$/.exec(entry);
    const kind = m?.[1].toLowerCase(); const mode = m?.[2].toLowerCase();
    if (m && LEASE_KINDS.includes(kind) && LEASE_MODES.includes(mode)) modes[kind] = mode;
    else { unknown.push(entry); if (LEASE_KINDS.includes(kind)) garbled.add(kind); }
  }
  // A kind with any entry it cannot read is the default, whatever another entry sets it to.
  for (const k of garbled) delete modes[k];
  return { modes, unknown };
}
// What is wrong with a lease-kinds value, naming each entry it does not know, or null.
export function leaseKindsProblem(raw) {
  const { modes, unknown } = parseLeaseKinds(raw);
  const want = `<kind>=<mode> entries, kinds ${LEASE_KINDS.join(', ')} and modes ${LEASE_MODES.join(', ')}`;
  if (unknown.length) return `\`lease-kinds\` names ${unknown.length === 1 ? 'an entry' : 'entries'} it does not know: ${unknown.map((e) => `"${e}"`).join(', ')}: want ${want}`;
  return Object.keys(modes).length ? null : `\`lease-kinds\` is empty: want ${want}`;
}
// The checks on Sizing rows a person may have edited by hand, one line each: lease-kinds, the
// admission rows, whose problems end with the locks granting as with lock-admission off, and the
// express lane's and job tokens' rows.
// A profile row's value as written (Sizing, else Hardware), TODO and all, or null.
export const profileValue = (profile, k) => profile?.sizing?.[k]?.value ?? profile?.hardware?.[k]?.value ?? null;
export function profileProblems(profile) {
  const v = profile?.sizing?.['lease-kinds']?.value;
  const bad = v == null ? null : leaseKindsProblem(v);
  const admit = admissionRows((k) => profileValue(profile, k)).problems.map((p) => `${p}; the locks grant as with \`lock-admission\` off`);
  const levers = LEVER_ROWS.flatMap(([k, off]) => {
    const raw = profile?.sizing?.[k]?.value;
    const p = raw == null ? null : BENCH_RULES[k].problem(String(raw).trim());
    return p ? [`${p}; ${off}`] : [];
  });
  return [...(bad ? [bad] : []), ...admit, ...levers];
}
// `bench-run-limit-<provider>`: the most runs the bench may start in a rolling week on a provider it
// has no meter or allowance ledger for, which it otherwise refuses.
const BENCH_RUN_LIMIT_PREFIX = 'bench-run-limit-';
export const benchRunLimitKey = (provider) => `${BENCH_RUN_LIMIT_PREFIX}${provider}`;
const BENCH_RUN_LIMIT = new RegExp(`^${BENCH_RUN_LIMIT_PREFIX}[a-z0-9][a-z0-9-]*$`);
const RUN_LIMIT_RULE = Object.freeze({ ok: (n) => Number.isInteger(n) && n > 0, want: 'a whole number of runs a week, 1 or more',
  why: 'runs a week the bench may start on this provider, which it has no meter for, set by its user' });
const benchRule = (key) => BENCH_RULES[key] ?? (BENCH_RUN_LIMIT.test(key) ? RUN_LIMIT_RULE : null);
export const benchWhy = (key) => benchRule(key)?.why;
// Why a value cannot be stored or read as one of the bench settings, or null when it can.
export function benchSettingError(key, raw) {
  const rule = benchRule(key);
  if (!rule) return `\`${key}\` is not a bench setting: want ${Object.keys(BENCH_RULES).join(' or ')} or ${benchRunLimitKey('<provider>')}`;
  const v = String(raw ?? '').trim();
  // A profile row is one line, so a value that breaks across lines would be read back cut short.
  if (rule.text) return /[\r\n]/.test(v) ? `\`${key}\` holds a line break: give it on one line` : rule.problem(v);
  return /^\d+(\.\d+)?$/.test(v) && rule.ok(Number(v)) ? null : `\`${key}\` is "${raw}": want ${rule.want}`;
}

// The thresholds and ratios the proposal uses. Changing one changes every new proposal, never a
// profile already written.
export const RULES = Object.freeze({
  osReserveGB: 8, wslCeilingGB: 16, workerHeavyGB: 3, minTestWorkers: 3, memoryPerLockSlotGB: 16,
  efficiencyCoreWeight: 0.5, typecheckLockTimeoutMin: 20, prePushLockTimeoutS: 60, testLockQueueFactor: 2,
});

// ---- overrides -------------------------------------------------------------------------------
// A Sizing row the proposal makes, set by hand with `desk-env machine set`: its Why starts with
// "override", and detect and write keep it rather than reading it as drift.
const OVERRIDE_WHY = /^override\b/i;
export const isOverride = (row) => OVERRIDE_WHY.test(String(row?.why ?? '').trim());
export const overrideWhy = (reason) => `override: ${String(reason ?? '').trim() || 'set by hand with desk-env machine set'}`;
export const isSizingKey = (key) => Object.hasOwn(SIZING_RULES, key);
// Why a value cannot be stored as an override of a proposed size, or null when it can.
export function sizingSettingError(key, raw) {
  const rule = SIZING_RULES[key];
  if (!rule) return `\`${key}\` is not a size the proposal makes: want ${SIZING_KEYS.join(', ')}`;
  const v = String(raw ?? '').trim();
  return rule.ok(v) ? null : `\`${key}\` is "${raw}": want ${rule.want}`;
}

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

// /proc/meminfo's text as { <field>: bytes }, e.g. { MemTotal, MemAvailable, SwapFree, Zswap }; a
// field it does not hold is absent.
export function parseMeminfo(text) {
  const m = {};
  for (const l of String(text ?? '').split('\n')) {
    const x = /^(\w+):\s+(\d+)/.exec(l);
    if (x) m[x[1]] = Number(x[2]) * 1024;
  }
  return m;
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
  const memKB = num(parseMeminfo(meminfo).MemTotal) / 1024;
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
// The cores test runs are sized on: the performance cores, plus each efficiency core at
// efficiencyCoreWeight (an unknown count as none); 4 where the core count is unknown.
function countedCores(hw, r = RULES) {
  const cores = num(hw['cpu-cores']);
  const perf = known(num(hw['performance-cores'])) ? num(hw['performance-cores']) : cores;
  const eff = known(perf) && known(num(hw['efficiency-cores'])) ? Math.max(0, num(hw['efficiency-cores'])) : 0;
  return { eff, counted: known(perf) ? Math.max(1, perf + Math.floor(eff * r.efficiencyCoreWeight)) : 4 };
}

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
  // test-cap test workers, so the slots share the counted cores between them: slots x test-cap stays
  // within them. An efficiency core counts as efficiencyCoreWeight of a performance core, and an
  // unknown count as none. Each slot also needs room beside the workers in their own heavy stage.
  const { eff, counted: testCores } = countedCores(hw, r);
  const coresWhy = !known(perf) ? 'core count unknown: 4'
    : eff ? `the ${perf} performance cores and ${eff} efficiency cores at ${r.efficiencyCoreWeight} each, ${testCores} counted`
      : `the ${perf} performance cores`;
  const slots = Math.max(1, Math.min(Math.floor(ceiling / r.memoryPerLockSlotGB), Math.floor(testCores / r.minTestWorkers)));
  add('test-cap', Math.max(1, Math.floor(testCores / slots)),
    `${coresWhy}${slots > 1 ? `, shared by ${slots} test lock slots` : ''}`);
  add('test-lock-slots', slots,
    `min(floor(${ceiling} GB / ${r.memoryPerLockSlotGB} GB per slot), floor(${testCores} cores / ${r.minTestWorkers} test workers at least per suite)), at least 1: suites and typechecks that hold the test lock at once`);
  add('test-lock-queue-factor', r.testLockQueueFactor,
    'the pass starts no worker, and resumes none into Stage 4, while test-lock-slots x this many runs wait on the test lock');
  add('typecheck-lock-timeout-min', r.typecheckLockTimeoutMin,
    `how long a typecheck waits on the lock before the wait is reported; with-lock.sh itself never times out`);
  add('pre-push-lock-timeout-s', r.prePushLockTimeoutS,
    'how long the pre-push hook waits for the test lock before skipping a typecheck or suite; CI runs it anyway');
  add('turbo-concurrency', 1,
    'the --concurrency with-lock.sh gives a turbo run under the test lock: one task at a time, as each task is a suite or typecheck sized for a slot of its own');
  const testCap = rows.find((s) => s.key === 'test-cap').value;
  add('lock-admission', ADMISSION_FIXED['lock-admission'], 'off: the locks grant their floors only; shadow logs what headroom admission would grant above them; on grants it');
  add('light-lock-slots', 1, 'the light lock\'s floor: slots always granted');
  add('light-lock-max', 1, 'the light lock\'s ceiling, never passed: its floor');
  add('test-lock-max', slots, 'the test lock\'s ceiling, never passed: test-lock-slots');
  add('admit-max-load', admitMaxLoad(hw['cpu-cores']), `round(${ADMIT_LOAD_PER_CORE} x ${known(num(hw['cpu-cores'])) ? `${num(hw['cpu-cores'])} CPU cores, efficiency cores at full weight` : '4 cores, the count unknown'}): a run above the floor is let in while the load it projects stays at or under this`);
  add('admit-run-load', testCap, 'test-cap: the load one run adds');
  add('admit-reserve-gb', ADMISSION_FIXED['admit-reserve-gb'], 'GB that must stay free once the runs let in are counted');
  add('heavy-run-gb', ADMISSION_FIXED['heavy-run-gb'], 'GB one suite or typecheck in the heavy pool is counted as taking');
  add('light-run-gb', ADMISSION_FIXED['light-run-gb'], 'GB one light suite is counted as taking');
  add('admit-max-pressure', ADMISSION_FIXED['admit-max-pressure'], 'no run is let in above a floor at this memory pressure level or over (1 normal, 2 warn, 4 critical)');
  add('admit-ramp-s', ADMISSION_FIXED['admit-ramp-s'], 'seconds a run let in counts against the next, while its load and memory are not yet in the readings');
  return rows;
}

// Warnings on a set of Sizing rows ([{ key, value }], the proposal or what a write would keep): the
// lock ceilings' test workers, (test-lock-max + light-lock-max) x test-cap, against twice the counted
// cores. -> [line].
export function sizingWarnings(rows, hw, r = RULES) {
  const v = Object.fromEntries(rows.map((s) => [s.key, Number(s.value)]));
  const workers = (v['test-lock-max'] + v['light-lock-max']) * v['test-cap'];
  const { counted } = countedCores(hw, r);
  if (!Number.isFinite(workers) || workers <= 2 * counted) return [];
  return [`(\`test-lock-max\` ${v['test-lock-max']} + \`light-lock-max\` ${v['light-lock-max']}) x \`test-cap\` ${v['test-cap']} is ${workers} test workers at the ceilings, more than twice the ${counted} counted cores (efficiency cores at ${r.efficiencyCoreWeight})`];
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
    "A repo's §3b row that is set wins over the matching row here. To keep a size of your own, set it",
    'with `desk-env machine set <key>=<value>`, which marks it an override that a re-write keeps;',
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
// row for the key is replaced in place, a new one goes at the table's end, and a row whose value is
// null is removed. Everything else is kept.
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
    const at = lines.slice(start, end).findIndex((l) => l.trim().startsWith('|') && unquote(splitRow(l.trim())[0]).toLowerCase() === r.key);
    if (r.value == null) {
      if (at >= 0) { lines.splice(start + at, 1); end--; }
      continue;
    }
    const line = sizingRow(r);
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
  'Started by `desk-env machine set` to keep the settings below. No sizes are proposed yet:',
  '`desk-env machine propose` shows them, and `desk-env machine write` adds them once you confirm.',
  '',
].join('\n');

// Whether the profile holds the confirmed proposal (`machine write` always records the hardware).
export const sizesProposed = (profile) => Object.keys(profile?.hardware ?? {}).length > 0;

// The Sizing rows a re-written profile holds: the proposal with each override in the profile kept
// in its place unless its key is in drop, then every row the profile has that the proposal does not
// make (the bench settings, set by `desk-env machine set`), so a re-write keeps them.
export function rewrittenSizing(profile, proposal, drop = []) {
  const proposed = new Set(proposal.map((s) => s.key));
  const sizing = profile?.sizing ?? {};
  const keeps = (k) => isOverride(sizing[k]) && !drop.includes(k);
  const overridden = proposal.map((s) => (keeps(s.key) ? { key: s.key, value: sizing[s.key].value, why: sizing[s.key].why } : s));
  // A proposed row that is another's value takes the override kept for that one, so the write never
  // leaves a ceiling under the floor it was proposed as.
  const valueOf = (k) => overridden.find((s) => s.key === k)?.value;
  const placed = overridden.map((s) => (FOLLOWS[s.key] && !keeps(s.key) && keeps(FOLLOWS[s.key]) ? { ...s, value: valueOf(FOLLOWS[s.key]) } : s));
  const kept = Object.entries(sizing).filter(([k]) => !proposed.has(k)).map(([key, s]) => ({ key, value: s.value, why: s.why }));
  return [...placed, ...kept];
}

// The proposed sizes the profile overrides: -> [{ key, value, proposed, why }].
export const sizingOverrides = (profile, proposal) => proposal
  .filter((s) => isOverride(profile?.sizing?.[s.key]))
  .map((s) => ({ key: s.key, value: profile.sizing[s.key].value, proposed: s.value, why: profile.sizing[s.key].why }));

// Hardware rows that differ from the profile. Free disk moves every day, so it never counts.
export function hardwareChanges(profile, hw) {
  return HARDWARE_KEYS.filter((k) => k !== 'disk-free-gb')
    .filter((k) => profile?.hardware?.[k] && String(profile.hardware[k].value) !== String(hw[k]))
    .map((k) => ({ key: k, was: profile.hardware[k].value, now: String(hw[k]) }));
}
// Proposed sizes that differ from the profile's; an override is never one (sizingOverrides).
export function sizingChanges(profile, proposal) {
  return proposal
    .filter((s) => profile?.sizing?.[s.key] && !isOverride(profile.sizing[s.key]) && profile.sizing[s.key].value !== s.value)
    .map((s) => ({ key: s.key, was: profile.sizing[s.key].value, now: s.value }));
}
