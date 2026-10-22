// suite: machine budget (one memory ceiling and worker cap across every repo)
// The real pass.mjs in a throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT holding a machine profile and
// several repos' configs and queues, with stub claude, gh, setup-worktree and spawn-worker; one case
// per DS-147 criterion. Nothing touches your real ~/.claude, ~/.config/desk or state.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(SRC, 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-machine-budget-'));
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'DESK_MACHINE', 'DESK_MEM_CEILING_GB', 'CLAUDE_CODE_SESSION_ID', 'AUTOPILOT_DRY_RUN',
  'AUTOPILOT_RERUN', 'AUTOPILOT_PORT_FLOOR', 'AUTOPILOT_MIN_AVAIL_GB', 'AUTOPILOT_BATCH_BUDGET_USD', 'DESK_UPLOAD_APPROVED']) delete process.env[k];

// A world: its own HOME, DESK_HOME (with the real queue scripts beside stubs) and config root, and a
// machine profile of `cap` workers and a `ceiling` GB memory ceiling, or none at all.
let n = 0;
function world({ cap = 10, ceiling = 32, profile = true } = {}) {
  n += 1;
  const W = join(T, `w${n}`);
  const bin = join(W, 'deskhome', 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(W, 'stub'));
  mkdirSync(join(W, 'locks'));
  for (const f of ['queue.mjs', 'harvest.mjs', 'desk-env.mjs', 'batch-state.mjs', 'briefing.mjs']) symlinkSync(join(BIN, f), join(bin, f));
  writeFileSync(join(bin, 'setup-worktree.sh'), 'mkdir -p "$WT_DIR/$2"; echo "[setup-worktree] worktree=$WT_DIR/$2"; echo "[setup-worktree] branch=$3"\n');
  writeFileSync(join(bin, 'spawn-worker.sh'), 'if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi\n');
  writeFileSync(join(W, 'stub', 'claude'), "#!/bin/sh\necho '[{\"sessionId\": \"live-1\"}]'\n", { mode: 0o755 });
  writeFileSync(join(W, 'stub', 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (profile) {
    writeFileSync(join(W, 'machine.md'), `## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | \`5 / ${cap}\` | x |\n| memory-ceiling-gb | \`${ceiling}\` | x |\n`);
  }
  return W;
}
const queuePath = (W, slug) => join(W, 'deskhome', 'repos', slug, 'queue.json');
const configPath = (W, slug) => join(W, 'config', 'repos', slug, 'config.md');
const tickets = (running, ready) => {
  const out = {};
  for (let i = 1; i <= running; i++) out[`R-${i}`] = { key: `R-${i}`, state: 'running', session_id: 'live-1', branch: `fix/R-${i}` };
  for (let i = 1; i <= ready; i++) out[`Y-${i}`] = { key: `Y-${i}`, state: 'triaged', open_questions: 0, branch: `fix/Y-${i}` };
  return out;
};
// Another repo: its §3b concurrency row and its queue (`running` workers, or `raw` text).
function other(W, slug, { conc = '4 / 4', running = 0, raw = null } = {}) {
  mkdirSync(dirname(configPath(W, slug)), { recursive: true });
  writeFileSync(configPath(W, slug), `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | \`2 / 3\` | \`${conc}\` |\n`);
  mkdirSync(dirname(queuePath(W, slug)), { recursive: true });
  writeFileSync(queuePath(W, slug), raw ?? JSON.stringify({ version: 1, batch: slug, tickets: tickets(running, 0) }));
}
// This repo: a git checkout, a config at `conc` with a memory ceiling row, and a queue; runs one pass.
// -> { out, running }
let floor = 46100;
function pass(W, slug, { conc = '2 / 3', ceiling = '56', running = 0, ready = 3 } = {}) {
  const R = join(W, slug);
  const gitEnv = { ...process.env, HOME: join(W, 'home'), GIT_CONFIG_GLOBAL: join(W, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n  email = t@example.com\n  name = t\n');
  spawnSync('git', ['init', '-q', '-b', 'main', join(R, 'repo')], { env: gitEnv });
  spawnSync('git', ['-C', join(R, 'repo'), 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv });
  mkdirSync(join(R, 'wt'), { recursive: true });
  const state = join(W, 'home', '.desk-autopilot', slug);
  mkdirSync(join(state, 'logs'), { recursive: true });
  const config = configPath(W, slug);
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, [
    '## 0. Repo', '| Field | Value |', '|---|---|', `| GitHub repo | \`${slug.replace('__', '/')}\` |`, '| Default branch | `main` |', '',
    '## 2. Paths', '| Field | Value |', '|---|---|', `| Primary repo root | \`${join(R, 'repo')}\` |`, `| Worktrees directory | \`${join(R, 'wt')}\` |`, '',
    '## 3. Permissions', '| Key | Capability | Recommended | Your setting |', '|---|---|---|---|', '| `autopilot-workers` | Run workers | `yes` | `yes` |', '',
    '## 3b. Cost and autonomy', '| Field | Recommended | Your setting |', '|---|---|---|', `| Autopilot worker concurrency | \`2 / 3\` | \`${conc}\` |`,
    `| Memory ceiling for parallel work (GB) | \`16\` | \`${ceiling}\` |`, '',
  ].join('\n'));
  const q = queuePath(W, slug);
  mkdirSync(dirname(q), { recursive: true });
  writeFileSync(q, JSON.stringify({ version: 1, batch: slug, tickets: tickets(running, ready) }));
  floor += 100;
  const env = { ...gitEnv, PATH: `${join(W, 'stub')}:${process.env.PATH}`, DESK_HOME: join(W, 'deskhome'), DESK_CONFIG_ROOT: join(W, 'config'),
    DESK_CONFIG: config, DESK_QUEUE: q, DESK_AUTOPILOT_STATE: state, DESK_MACHINE: join(W, 'machine.md'), DESK_LOCK_DIR: join(W, 'locks'),
    WT_DIR: join(R, 'wt'), AUTOPILOT_MIN_AVAIL_GB: '0', AUTOPILOT_HEALTH_CHECKS: 'off', AUTOPILOT_ORCHESTRATOR: 'test', AUTOPILOT_PORT_FLOOR: String(floor) };
  const r = spawnSync('node', [join(BIN, 'pass.mjs')], { env, cwd: join(R, 'repo'), encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const now = Object.values(JSON.parse(readFileSync(q, 'utf8')).tickets).filter((x) => x.state === 'running').length;
  return { out, started: now - running };
}
const line = (out, prefix) => out.split('\n').find((l) => l.startsWith(prefix)) ?? null;

// AC1: a machine ceiling of 32 and a repo row of 56: the pass uses 32 and names the machine's limit.
let W = world({ ceiling: 32 });
let r = pass(W, 'acme__a', { ceiling: '56', ready: 0 });
t('AC1 the pass budgets against the machine ceiling of 32G and names it as the limit', line(r.out, 'memory ceiling'),
  'memory ceiling 32G, the machine profile\'s limit (this repo\'s config §3b "Memory ceiling for parallel work (GB)" says 56G, and a repo may not raise the machine\'s)');
const get = spawnSync('node', [join(BIN, 'desk-env.mjs'), 'get', 'memory-ceiling'], {
  encoding: 'utf8', env: { ...process.env, HOME: join(W, 'home'), DESK_CONFIG: configPath(W, 'acme__a'), DESK_MACHINE: join(W, 'machine.md') },
}).stdout.trim();
t('AC1 desk-env get reads the repo row of 56 as the machine\'s 32', get, '32');
r = pass(W, 'acme__b', { ceiling: '24', ready: 0 });
t('AC1 a repo row below the machine\'s is used as it is', line(r.out, 'memory ceiling'),
  'memory ceiling 24G (config §3b "Memory ceiling for parallel work (GB)", within the machine\'s 32G)');

// AC2: a machine cap of 10 with 4, 4 and 2 running in three repos: a fourth starts nothing.
W = world({ cap: 10 });
other(W, 'acme__one', { running: 4 });
other(W, 'acme__two', { running: 4 });
other(W, 'acme__three', { running: 2 });
r = pass(W, 'acme__four', { conc: '2 / 3', ready: 2 });
t('AC2 a fourth repo starts nothing', r.started, 0);
t('AC2 its report says the machine is at its cap', line(r.out, 'machine budget:'),
  'machine budget: 10 of the machine\'s 10 worker(s) running across every repo: the machine is at its cap, so nothing starts this pass');

// AC3: a machine cap of 10 with 8 running across the repos: a pass with 3 ready starts at most 2.
W = world({ cap: 10 });
other(W, 'acme__one', { running: 5 });
other(W, 'acme__two', { running: 1 });
r = pass(W, 'acme__three', { conc: '3 / 4', running: 2, ready: 3 });
t('AC3 it starts 2 of its 3 ready', r.started, 2);
t('AC3 its report says it starts at most 2', line(r.out, 'machine budget:'), 'machine budget: 8 of the machine\'s 10 worker(s) running across every repo: starting at most 2');

// AC4: another repo's queue cannot be parsed: it counts at its own cap of 4, and the report names it.
W = world({ cap: 10 });
other(W, 'acme__broken', { conc: '2 / 4', raw: '{"tickets": not json' });
other(W, 'acme__one', { running: 4 });
r = pass(W, 'acme__two', { conc: '3 / 4', ready: 3 });
t('AC4 the unreadable repo counts at its cap, so 2 start rather than 3', r.started, 2);
const ac4 = line(r.out, 'machine budget:') ?? '';
t('AC4 the report names the unreadable queue', ac4.startsWith('machine budget: 8 of the machine\'s 10 worker(s) running across every repo; acme/broken\'s queue cannot be read (')
  && ac4.includes(queuePath(W, 'acme__broken')) && ac4.endsWith('so it counts at its cap of 4 workers: starting at most 2'), true);

// AC5: no machine profile: each repo uses its own rows, and the report says there is no budget.
W = world({ profile: false });
other(W, 'acme__one', { running: 9 });
r = pass(W, 'acme__two', { conc: '2 / 3', ceiling: '56', ready: 3 });
t('AC5 the repo starts up to its own number', r.started, 2);
t('AC5 the report says there is no machine budget', line(r.out, 'machine budget:'), 'machine budget: none — no machine profile, so this repo uses its own §3b rows');
t('AC5 the repo\'s own memory ceiling is used', line(r.out, 'memory ceiling'), 'memory ceiling 56G (config §3b "Memory ceiling for parallel work (GB)")');

// AC6: /desk-setup proposes the machine's figure for a row above it, and says why.
const setup = readFileSync(join(SRC, 'skills', 'desk-setup', 'SKILL.md'), 'utf8');
t('AC6 desk-setup proposes the machine\'s figure for a ceiling row above it, saying why',
  /row already holds a figure above the\s+machine's, propose the machine's figure in its place and say why/.test(setup) && /a repo\s+row may be lower but never higher/.test(setup), true);

console.log(fails ? `${fails} check(s) did not pass` : 'machine budget: all checks passed');
process.exit(fails ? 1 : 0);
