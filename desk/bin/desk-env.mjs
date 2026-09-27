#!/usr/bin/env node
// Shared resolver for the desk/bin scripts: one place that turns "who am I, where is the repo,
// what am I allowed to do" into values, so no script hardcodes a person or a machine.
//
// Resolution order for every value: environment variable -> ~/.claude/desk-config.md -> default.
// Anything identity-shaped (GitHub handle, Jira name, repo root) has NO default and fails loudly:
// a guessed handle sends work to the wrong place silently.
//
// Also the portable OS helpers the scripts share (memory, uuid, ports), so Linux, WSL and macOS
// differ in exactly one file.
//
// CLI (used by desk-env.sh, so there is one markdown parser, not two):
//   node desk-env.mjs get <config id>         print the value (CONFIG_ROWS), exit 3 if unset
//   node desk-env.mjs perm <permission id>    print yes|ask|no|never|stop (PERMISSION_KEYS; unset -> no)
//   node desk-env.mjs key <permission id>     print the §3 key it maps to
//   node desk-env.mjs budget worker|batch     print USD or none; exit 4 if malformed
//   node desk-env.mjs ids                     print every id, the row it maps to, and its value
//   node desk-env.mjs paths                   print KEY=value lines for the shell
//   node desk-env.mjs identity                print GITHUB_HANDLE= and JIRA_NAME= (fails if unset)
//   node desk-env.mjs mem <avail|used|rss|status>
//   node desk-env.mjs uuid
//   node desk-env.mjs port-in-use <port>      exit 0 if something is listening
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { homedir, platform, totalmem, freemem, release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import net from 'node:net';

export const HOME = process.env.HOME || homedir();
export const CONFIG_PATH = process.env.DESK_CONFIG ?? join(HOME, '.claude', 'desk-config.md');

export const expandHome = (p) => (typeof p === 'string' ? p.replace(/^~(?=\/|$)/, HOME) : p);

// ---- the one map from what a script means to where the config says it ------------------------
// Scripts never name a config row directly. They name a logical id below, and this is the only
// place that knows which row that is, so a row renamed by /desk-setup is a one-line edit here.
//
// §3 rows are matched by their stable Key column. §1, §2 and §3b have no key column, so their rows
// are matched by display name. Either way the match is EXACT (case, backticks and spacing aside):
// a near-miss must read as unset, never borrow a neighbouring row's value.
export const PERMISSION_KEYS = Object.freeze({
  'autopilot-workers': 'autopilot-workers',
  'autopilot-merge': 'autopilot-merge',
  'pr-merge-green': 'pr-merge-green',
  'merge-feedback-first': 'merge-feedback-first',
  'pr-auto-merge': 'pr-auto-merge',
  'pr-ready': 'pr-ready',
  'git-push': 'git-push',
  'pr-open': 'pr-open',
  'pr-edit': 'pr-edit',
  'pr-self-review-comment': 'pr-self-review-comment',
  'pr-reply': 'pr-reply',
  'pr-images': 'pr-images',
  'pr-update-branch': 'pr-update-branch',
  'jira-comment': 'jira-comment',
  'jira-transition': 'jira-transition',
  'jira-create': 'jira-create',
  'jira-edit': 'jira-edit',
  'ci-rerun': 'ci-rerun',
  'codex-review': 'codex-review',
  'read-figma': 'read-figma',
});

export const CONFIG_ROWS = Object.freeze({
  'github-handle': { section: '1', row: 'GitHub handle' },
  'jira-display-name': { section: '1', row: 'Jira display name' },
  name: { section: '1', row: 'Name' },
  'repo-root': { section: '2', row: 'Primary repo root' },
  'worktrees-dir': { section: '2', row: 'Worktrees directory' },
  wsl: { section: '2', row: 'Running on WSL?' },
  'browser-profile': { section: '2', row: 'Signed-in browser profile' },
  'dev-port': { section: '3b', row: 'Preferred dev-server port' },
  concurrency: { section: '3b', row: 'Autopilot worker concurrency' },
  'memory-ceiling': { section: '3b', row: 'Memory ceiling for parallel work (GB)' },
  'worker-budget': { section: '3b', row: 'Autopilot per-worker budget (USD)' },
  'batch-budget': { section: '3b', row: 'Autopilot batch budget (USD)' },
});

export class DeskConfigError extends Error {}

// ---- config parsing ------------------------------------------------------------------------
// The config is markdown written by /desk-setup and editable by hand: sections are `## <n>.`
// headings, rows are table rows, and the value is the first backtick span in the value column.
// The value column comes from the header ("Your setting", else "Value", else "Setting", else the
// second column) because §2's Notes and §3's Recommended columns also carry backticks, and taking
// the wrong one would read the suggestion as the user's answer. The row id is the "Key" column
// where the table has one, otherwise the first column.
let cache = null;
const norm = (s) => s.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function parseConfig() {
  if (cache) return cache;
  cache = { exists: existsSync(CONFIG_PATH), sections: {} };
  if (!cache.exists) return cache;
  let section = null;
  let header = null;
  for (const raw of readFileSync(CONFIG_PATH, 'utf8').split('\n')) {
    const line = raw.trim();
    const h = /^##\s+(\d+[a-z]?)[.)]?\s/i.exec(line);
    if (h) { section = h[1].toLowerCase(); header = null; cache.sections[section] ??= { byKey: {}, byName: {} }; continue; }
    if (!section) continue;
    if (!line.startsWith('|')) { header = null; continue; }
    const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // separator row
    if (!header) { header = cells.map(norm); continue; }
    let col = ['your setting', 'value', 'setting'].map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
    if (col < 0) col = 1;
    const keyCol = header.indexOf('key');
    const cell = cells[col] ?? '';
    const tick = /`([^`]*)`/.exec(cell);
    const value = (tick ? tick[1] : cell).trim();
    const s = cache.sections[section];
    if (keyCol >= 0) { const k = norm(cells[keyCol] ?? ''); if (k) s.byKey[k] = value; }
    else { const n = norm(cells[0] ?? ''); if (n) s.byName[n] = value; }
  }
  return cache;
}

const unset = (v) => v == null || v === '' || /^todo\b/i.test(v);

function rowFor(id) {
  const r = CONFIG_ROWS[id];
  if (!r) throw new Error(`desk-env: unknown config id "${id}" (known: ${Object.keys(CONFIG_ROWS).join(', ')})`);
  return r;
}

// Exact lookup by logical id. Unset (missing row, blank, TODO) is null.
export function configValue(id) {
  const { section, row } = rowFor(id);
  const v = parseConfig().sections[section]?.byName[norm(row)];
  return unset(v) ? null : v;
}

// env -> config -> fallback. Identity-shaped values have no fallback and fail loudly.
export function resolve({ env, id, fallback, identity = false }) {
  const fromEnv = env ? process.env[env] : undefined;
  if (!unset(fromEnv)) return expandHome(fromEnv);
  const fromCfg = id ? configValue(id) : null;
  if (fromCfg != null) return expandHome(fromCfg);
  if (!identity && fallback !== undefined) return typeof fallback === 'function' ? fallback() : fallback;
  const where = parseConfig().exists ? CONFIG_PATH : `${CONFIG_PATH} (missing)`;
  const r = id ? CONFIG_ROWS[id] : null;
  throw new DeskConfigError(
    `studia: ${r ? `"${r.row}"` : env} is not set. Set ${env ? `$${env} or ` : ''}` +
      `${r ? `config §${r.section} "${r.row}"` : 'it'} in ${where} — run /desk-setup. Refusing to guess.`,
  );
}

// §3 is an allowlist, matched by exact key: a missing row, a blank, a TODO or anything unrecognised
// is a `no`. An id this file does not know is a bug in the caller, so it throws.
export function permission(id) {
  const key = PERMISSION_KEYS[id];
  if (!key) throw new Error(`desk-env: unknown permission id "${id}" (known: ${Object.keys(PERMISSION_KEYS).join(', ')})`);
  const v = parseConfig().sections['3']?.byKey[norm(key)];
  if (unset(v)) return 'no';
  return /^(yes|ask|no|never|stop)\b/i.exec(v.trim())?.[1].toLowerCase() ?? 'no';
}
export const permissionKey = (id) => PERMISSION_KEYS[id];

// A spend guard is a number of USD or explicitly off. Anything else ("25 USD", "0", "lots") is
// refused rather than read as off: a typo must never silently remove a cap.
//   -> { off: true } | { usd: <number> }, or throws DeskConfigError
export function parseBudget(raw, label) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (/^(none|off|no|no cap)$/.test(v)) return { off: true };
  if (/^\d+(\.\d+)?$/.test(v) && Number(v) > 0) return { usd: Number(v) };
  throw new DeskConfigError(`studia: ${label} is "${raw}" — want a positive number of USD, or none/off/no cap. Refusing to guess.`);
}
export const workerBudget = () => parseBudget(resolve({ env: 'AUTOPILOT_BUDGET_USD', id: 'worker-budget', fallback: '25' }), 'the per-worker budget');
export const batchBudget = () => parseBudget(resolve({ env: 'AUTOPILOT_BATCH_BUDGET_USD', id: 'batch-budget', fallback: 'none' }), 'the batch budget');

// ---- identity and paths --------------------------------------------------------------------
export const githubHandle = () => resolve({ env: 'DESK_GITHUB_HANDLE', id: 'github-handle', identity: true });
// Jira shows the assignee by display name, so the ownership test needs that exact string.
export const jiraName = () => {
  try { return resolve({ env: 'DESK_JIRA_NAME', id: 'jira-display-name', identity: true }); }
  catch { return resolve({ env: 'DESK_JIRA_NAME', id: 'name', identity: true }); }
};
export const repoRoot = () => resolve({ env: 'DESK_REPO_ROOT', id: 'repo-root', identity: true }).replace(/\/+$/, '');
export const worktreesDir = () => resolve({
  env: 'DESK_WORKTREES_DIR', id: 'worktrees-dir',
  fallback: () => { const r = repoRoot(); return join(dirname(r), `${basename(r)}-worktrees`); },
}).replace(/\/+$/, '');
export const browserProfile = () => resolve({ env: 'DESK_BROWSER_PROFILE', id: 'browser-profile', identity: true });
export const ghRepo = () => resolve({ env: 'DESK_GH_REPO', fallback: 'Sophos-Education/studia-web' });
export const studiaHome = () => expandHome(process.env.DESK_HOME ?? join(HOME, '.claude', 'desk'));
export const binDir = () => join(studiaHome(), 'bin');
export const stateDir = () => expandHome(process.env.DESK_AUTOPILOT_STATE ?? join(HOME, '.desk-autopilot'));
export const queueFile = () => expandHome(process.env.DESK_QUEUE ?? join(studiaHome(), 'queue.json'));
export const skillsDir = () => expandHome(process.env.DESK_SKILLS_DIR ?? join(HOME, '.agents', 'skills'));
export const lockDir = () => expandHome(process.env.DESK_LOCK_DIR ?? '/tmp');
// Claude Code keys a project's memory dir by the absolute cwd with every non-alphanumeric char as `-`.
export const memoryDir = (root = repoRoot()) => join(HOME, '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
export const pgContainer = () => resolve({ env: 'DESK_PG_CONTAINER', fallback: () => `${basename(repoRoot())}-postgres-1` });

export function isWSL() {
  const cfg = configValue('wsl');
  if (cfg) return /^yes/i.test(cfg);
  return platform() === 'linux' && /microsoft/i.test(release());
}

export function devPort() {
  const v = Number(resolve({ env: 'DESK_DEV_PORT', id: 'dev-port', fallback: '3000' }));
  return Number.isInteger(v) && v > 0 ? v : 3000;
}

// Worker ports start one above the user's dev port and skip anything taken. One definition, used
// by pass.mjs (the real path) and spawn-worker.sh's standalone fallback alike.
export function workerPortFloor() {
  const v = Number(process.env.AUTOPILOT_PORT_FLOOR ?? devPort() + 1);
  return Number.isInteger(v) && v > 0 ? v : devPort() + 1;
}

// `<default> / <cap>` from §3b, default 2 / 3.
export function concurrencyLimits() {
  const nums = (configValue('concurrency') ?? '').match(/\d+/g)?.map(Number) ?? [];
  const def = nums[0] ?? 2;
  return { def, cap: nums[1] ?? Math.max(def, 3) };
}

// ---- memory --------------------------------------------------------------------------------
// Two numbers answer two different questions; see the autopilot skill's memory section.
//   avail: is there room to START something?  Linux MemAvailable; macOS free+inactive+purgeable+speculative.
//   used:  how big has the VM / machine footprint grown?  Linux MemTotal-MemFree (counts page cache,
//          which WSL's VmmemWSL also counts); macOS total minus free pages.
const GiB = 1024 ** 3;
function linuxMeminfo() {
  try {
    const m = {};
    for (const l of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const x = /^(\w+):\s+(\d+)/.exec(l);
      if (x) m[x[1]] = Number(x[2]) * 1024;
    }
    return m.MemTotal ? m : null;
  } catch { return null; }
}
function macVmStat() {
  try {
    const out = execFileSync('vm_stat', { encoding: 'utf8' });
    const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
    const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0) * pageSize;
    return {
      free: pages('Pages free'), inactive: pages('Pages inactive'),
      speculative: pages('Pages speculative'), purgeable: pages('Pages purgeable'),
    };
  } catch { return null; }
}
export function availableGiB() {
  const m = linuxMeminfo();
  if (m?.MemAvailable) return m.MemAvailable / GiB;
  const v = platform() === 'darwin' ? macVmStat() : null;
  if (v) return (v.free + v.inactive + v.speculative + v.purgeable) / GiB;
  return freemem() / GiB; // last resort; under-reports, which only ever delays a spawn
}
export function usedGiB() {
  const m = linuxMeminfo();
  if (m) return (m.MemTotal - m.MemFree) / GiB;
  const v = platform() === 'darwin' ? macVmStat() : null;
  if (v) return (totalmem() - v.free) / GiB;
  return (totalmem() - freemem()) / GiB;
}
export function rssGiB() {
  try {
    const out = execFileSync('ps', ['-axo', 'rss='], { encoding: 'utf8' });
    return out.split('\n').reduce((s, l) => s + (Number(l.trim()) || 0), 0) * 1024 / GiB;
  } catch { return NaN; }
}
export const memCeilingGiB = () => Number(/\d+(\.\d+)?/.exec(resolve({ env: 'DESK_MEM_CEILING_GB', id: 'memory-ceiling', fallback: '16' }))?.[0]) || 16;

// Heavy processes (suites, typecheck, dev servers) counted by argv[0]/argv[1], never `pgrep -f`:
// a claude worker carries its briefing in argv (which mentions jest, vitest and tsc), and the
// harness's own `bash -c` wrapper carries the pattern literally, so a -f match counts both.
export function heavyProcesses() {
  let out = '';
  try { out = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }); } catch { return []; }
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid) continue;
    const [a0 = '', a1 = ''] = m[2].split(/\s+/);
    const exe = basename(a0);
    if (['claude', 'bash', 'sh', 'zsh', 'grep', 'ps', 'awk'].includes(exe)) continue;
    const hay = `${exe} ${a1}`;
    if (/jest|vitest|tsc|next-server|next dev|playwright|storybook/.test(hay)) rows.push({ pid: Number(m[1]), args: m[2].slice(0, 160) });
  }
  return rows;
}

// ---- misc ----------------------------------------------------------------------------------
export const uuid = () => randomUUID();

// Probe by connecting, which works the same on Linux and macOS and needs no ss/lsof.
export function portInUse(port, timeoutMs = 400) {
  const probe = (host) => new Promise((res) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); res(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((r) => r.some(Boolean));
}

// ---- CLI -----------------------------------------------------------------------------------
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'get': {
        const v = configValue(args[0]);
        if (v == null) process.exit(3);
        console.log(expandHome(v));
        break;
      }
      case 'perm':
        console.log(permission(args[0]));
        break;
      case 'key':
        if (!PERMISSION_KEYS[args[0]]) throw new Error(`desk-env: unknown permission id "${args[0]}"`);
        console.log(PERMISSION_KEYS[args[0]]);
        break;
      case 'budget': {
        const b = args[0] === 'batch' ? batchBudget() : args[0] === 'worker' ? workerBudget() : null;
        if (!b) throw new Error('usage: desk-env.mjs budget worker|batch');
        console.log(b.off ? 'none' : b.usd);
        break;
      }
      case 'ids':
        for (const [id, key] of Object.entries(PERMISSION_KEYS)) console.log(`perm ${id} -> §3 ${key} = ${permission(id)}`);
        for (const [id, r] of Object.entries(CONFIG_ROWS)) console.log(`get  ${id} -> §${r.section} "${r.row}" = ${configValue(id) ?? '(unset)'}`);
        break;
      case 'paths': {
        const lines = {
          DESK_REPO_ROOT: repoRoot(), DESK_WORKTREES_DIR: worktreesDir(), DESK_HOME: studiaHome(),
          DESK_BIN: binDir(), DESK_STATE: stateDir(), DESK_QUEUE: queueFile(), DESK_SKILLS_DIR: skillsDir(),
          DESK_LOCK_DIR: lockDir(), DESK_MEMORY_DIR: memoryDir(), DESK_GH_REPO: ghRepo(),
          DESK_PG_CONTAINER: pgContainer(), DESK_DEV_PORT: devPort(), DESK_WORKER_PORT_FLOOR: workerPortFloor(), DESK_IS_WSL: isWSL() ? 'yes' : 'no',
        };
        for (const [k, v] of Object.entries(lines)) console.log(`${k}=${String(v).replace(/'/g, `'\\''`).replace(/^|$/g, "'")}`);
        break;
      }
      case 'identity':
        console.log(`DESK_GITHUB_HANDLE='${githubHandle()}'`);
        console.log(`DESK_JIRA_NAME='${jiraName().replace(/'/g, `'\\''`)}'`);
        break;
      case 'mem': {
        const what = args[0] ?? 'status';
        if (what === 'avail') console.log(availableGiB().toFixed(1));
        else if (what === 'used') console.log(usedGiB().toFixed(1));
        else if (what === 'rss') console.log(rssGiB().toFixed(1));
        else console.log(`vmmem=${usedGiB().toFixed(1)}G avail=${availableGiB().toFixed(1)}G rss=${rssGiB().toFixed(1)}G`);
        break;
      }
      case 'heavy':
        for (const p of heavyProcesses()) console.log(`${p.pid} ${p.args}`);
        break;
      case 'uuid':
        console.log(uuid());
        break;
      case 'port-in-use':
        process.exit((await portInUse(Number(args[0]))) ? 0 : 1);
        break;
      default:
        console.error('usage: desk-env.mjs get|perm|key|budget|ids|paths|identity|mem|heavy|uuid|port-in-use');
        process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(e instanceof DeskConfigError ? 4 : 1);
  }
}
