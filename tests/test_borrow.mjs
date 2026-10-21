// suite: borrow (a batch borrows worker slots other live batches are not using)
// borrow.mjs against fixture queues, heartbeats and repo configs in a throwaway HOME, DESK_HOME and
// DESK_CONFIG_ROOT, with a fixture machine profile and the available memory injected; then the real
// pass.mjs, with stub claude, gh, setup-worktree and spawn-worker, for the report and the spawn.
// Nothing touches your real ~/.claude, ~/.config/desk or state.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-borrow-'));
const env = {
  HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'),
  DESK_MACHINE: join(T, 'machine.md'), DESK_LOCK_DIR: join(T, 'locks'),
};
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'CLAUDE_CODE_SESSION_ID', 'AUTOPILOT_DRY_RUN', 'AUTOPILOT_RERUN', 'AUTOPILOT_PORT_FLOOR',
  'AUTOPILOT_MIN_AVAIL_GB', 'AUTOPILOT_BATCH_BUDGET_USD']) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
// Imported after the environment is set: desk-env reads HOME and the machine profile once.
const B = await import(join(BIN, 'borrow.mjs'));

const NOW = Date.now();
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const queuePath = (slug) => join(env.DESK_HOME, 'repos', slug, 'queue.json');

// One repo: its config's concurrency row, its queue (`running` and `ready` counts, or raw text) and
// a heartbeat `beat` minutes old (none when null).
function repo(slug, { conc = '2 / 4', share = 2, running = 0, ready = 0, beat = 1, raw = null, borrow = null } = {}) {
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | \`2 / 3\` | \`${conc}\` |\n` +
    (borrow ? `| Borrow idle workers | \`off\` | \`${borrow}\` |\n` : ''));
  const q = queuePath(slug);
  mkdirSync(dirname(q), { recursive: true });
  const tickets = {};
  for (let i = 1; i <= running; i++) tickets[`R-${i}`] = { key: `R-${i}`, state: 'running' };
  for (let i = 1; i <= ready; i++) tickets[`Y-${i}`] = { key: `Y-${i}`, state: 'triaged', open_questions: 0 };
  writeFileSync(q, raw ?? JSON.stringify({ version: 1, batch: slug, concurrency: share, tickets }));
  if (beat != null) {
    const dir = join(env.HOME, '.desk-autopilot', slug, 'orchestrators');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'q.json'), JSON.stringify({ queue: q, batch: slug, pid: 1, at: minsAgo(beat) }));
  }
  return q;
}
// A fresh world of repos: wipes the queues of the last one.
let n = 0;
const fresh = () => { n += 1; env.DESK_HOME = join(T, `deskhome${n}`); process.env.DESK_HOME = env.DESK_HOME; };
const plan = (self, mine, extra = {}) => B.borrowPlan({
  on: true, cap: 4, memory: { avail: 32, start: 8 }, machine: B.machineCap(), ...mine,
  others: B.otherBatches({ self: queuePath(self), now: NOW }), ...extra,
});

// AC1: A at its own number of 2 (cap 4) with 2 running and 1 ready; B live at 5 with nothing running
// or ready; a machine cap of 10.
fresh();
repo('acme__a', { share: 2, running: 2, ready: 1 });
repo('acme__b', { conc: '5 / 6', share: 5 });
t('the machine cap comes from the machine profile', B.machineCap(), 10);
let p = plan('acme__a', { share: 2, running: 2, wanted: 1 });
t('AC1 A may start its ready ticket', p.slots, 1);
t('AC1 the report says 1 worker is borrowed', /^borrowing: 1 worker borrowed this pass, 1 above the batch's own number of 2/.test(B.borrowedLine(p, { share: 2, running: 2, spawned: 1 })), true);

// AC2: a machine cap of 6; A at 2 with 3 running (1 borrowed) and 1 ready; B live at 3, nothing
// running and 3 ready.
fresh();
repo('acme__a', { share: 2, running: 3, ready: 1 });
repo('acme__b', { conc: '3 / 4', share: 3, ready: 3 });
p = plan('acme__a', { share: 2, running: 3, wanted: 1 }, { machine: B.machineCap('3 / 6') });
t('AC2 A starts nothing', p.slots, 0);
t('AC2 its report says B has first claim on the free slots', /acme\/b has first claim on the free slots/.test(B.borrowedLine(p, { share: 2, running: 3, spawned: 0 })), true);
p = plan('acme__b', { share: 3, running: 0, wanted: 3 }, { machine: B.machineCap('3 / 6') });
t('AC2 B starts 3', p.slots, 3);

// AC3: A running 2 borrowed workers, B gaining ready tickets on a full machine.
fresh();
repo('acme__a', { conc: '2 / 6', share: 2, running: 4, ready: 2 });
repo('acme__b', { conc: '6 / 6', share: 6, running: 6, ready: 3 });
p = plan('acme__a', { share: 2, running: 4, wanted: 2, cap: 6 });
t('AC3 A starts nothing new', p.slots, 0);
const ac3 = B.borrowedLine(p, { share: 2, running: 4, spawned: 0 });
t('AC3 its report says A is 2 above its own number and starting nothing new', /^borrowing: 2 above the batch's own number of 2, starting nothing new/.test(ac3), true);
t('AC3 none of A\'s workers is stopped: the plan has no way to', 'stop' in p, false);

// AC5: borrowing would allow a worker, but available memory is below the spawn gate.
fresh();
repo('acme__a', { share: 2, running: 2, ready: 1 });
repo('acme__b', { share: 2 });
p = plan('acme__a', { share: 2, running: 2, wanted: 1 }, { memory: { avail: 5.5, start: 8 } });
t('AC5 nothing starts below the spawn gate', p.slots, 0);
t('AC5 the report names the gate', p.line, 'borrowing: nothing starts, borrowed or not: available memory 5.5G is under the 8G spawn gate');
p = plan('acme__a', { share: 3, running: 2, wanted: 1 }, { memory: { avail: 5.5, start: 8 } });
t('AC5 not even up to its own number', p.slots, 0);

// AC6: a quiet batch (no pass for 15 minutes) with 2 workers still running.
fresh();
repo('acme__a', { share: 2, running: 2, ready: 3 });
repo('acme__quiet', { share: 3, running: 2, ready: 4, beat: 16 });
p = plan('acme__a', { share: 2, running: 2, wanted: 3, cap: 10 }, { machine: B.machineCap('2 / 6') });
t('AC6 the quiet batch\'s 2 count as running and it has no claim: 6 less 4 is 2 to borrow', p.slots, 2);
const q6 = B.otherBatches({ self: queuePath('acme__a'), now: NOW }).find((o) => o.slug === 'acme__quiet');
t('AC6 a heartbeat 16 minutes old is not live', q6.live, false);

// AC7: another repo's queue that cannot be parsed.
fresh();
repo('acme__a', { share: 2, running: 1, ready: 3 });
repo('acme__broken', { raw: '{ not json' });
p = plan('acme__a', { share: 2, running: 1, wanted: 3 });
t('AC7 it still starts up to its own number, and nothing above it', p.slots, 1);
t('AC7 the report names the unreadable queue', p.line.includes(`${queuePath('acme__broken')} is not valid JSON`), true);

// AC8: borrowing off, which is the default.
t('AC8 the row is off when unset', B.borrowSetting(null).on, false);
t('AC8 the row is off when TODO is read as unset', B.borrowSetting(undefined).on, false);
t('a row that is neither on nor off is said and read as off', B.borrowSetting('yes please').on === false && /Borrow idle workers" is "yes please"/.test(B.borrowSetting('yes please').bad), true);
fresh();
repo('acme__a', { share: 2, running: 1, ready: 5 });
p = plan('acme__a', { share: 2, running: 1, wanted: 5, cap: 10 }, { on: false });
t('AC8 off: never above its own number', p.slots, 1);
t('AC8 off: nothing to report', p.line, null);
t('a paused batch (its number 0) borrows nothing', plan('acme__a', { share: 0, running: 0, wanted: 5 }).slots, 0);

// AC4: one free machine slot, A and B each with a ready ticket above their own number, both passes
// at the same moment. Each counts, waits long enough for the other to count too, then records a
// running worker in its own queue: only the lock keeps them from both taking the slot.
fresh();
repo('acme__a', { conc: '1 / 3', share: 1, running: 1, ready: 1 });
repo('acme__b', { conc: '1 / 3', share: 1, running: 1, ready: 1 });
const racer = join(T, 'racer.mjs');
writeFileSync(racer, `
import { readFileSync, writeFileSync } from 'node:fs';
const B = await import(${JSON.stringify(join(BIN, 'borrow.mjs'))});
const self = process.argv[2];
const l = await B.takeBorrowLock({ waitMs: 20000, pollMs: 20 });
if (!l.ok) { console.log('nolock'); process.exit(0); }
const p = B.borrowPlan({ on: true, share: 1, cap: 3, running: 1, wanted: 1, machine: 3, memory: { avail: 32, start: 8 },
  others: B.otherBatches({ self }) });
await new Promise((r) => setTimeout(r, 400));
if (p.slots > 0) {
  const q = JSON.parse(readFileSync(self, 'utf8'));
  q.tickets['Y-1'].state = 'running';
  writeFileSync(self, JSON.stringify(q));
}
l.release();
console.log(p.slots);
`);
const race = (slug) => new Promise((res) => {
  const c = spawn('node', [racer, queuePath(slug)], { env: process.env });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  c.on('close', () => res(out.trim()));
});
const results = await Promise.all([race('acme__a'), race('acme__b')]);
const runningIn = (slug) => Object.values(JSON.parse(readFileSync(queuePath(slug), 'utf8')).tickets).filter((x) => x.state === 'running').length;
t('AC4 exactly one worker starts', runningIn('acme__a') + runningIn('acme__b'), 3);
t('AC4 one pass saw the slot and the other saw it taken', results.slice().sort().join(','), '0,1');
t('AC4 the lock is released afterwards', existsSync(join(env.DESK_LOCK_DIR, 'desk-borrow.lock.d')), false);
// A lock left by a process that has gone is taken over rather than waited on.
mkdirSync(join(env.DESK_LOCK_DIR, 'desk-borrow.lock.d'));
const dead = spawnSync('node', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
writeFileSync(join(env.DESK_LOCK_DIR, 'desk-borrow.lock.d', 'pid'), dead);
const taken = await B.takeBorrowLock({ waitMs: 2000, pollMs: 20 });
t('a dead holder\'s lock is taken over', taken.ok, true);
taken.release();
// A live holder is waited on, then given up on with its pid named.
const held = await B.takeBorrowLock({ waitMs: 2000, pollMs: 20 });
const second = await B.takeBorrowLock({ waitMs: 300, pollMs: 20, pid: process.pid + 1 });
t('a live holder is given up on after the wait, naming it', second.ok === false && second.why.includes(`pid ${process.pid}`), true);
held.release();

// ---- the real pass.mjs ----------------------------------------------------------------------
// This repo is acme/widgets at 2 / 4 with 2 running and 3 ready; the other repo is live and idle.
function passWorld({ borrow, minAvail = '0' }) {
  fresh();
  const W = mkdtempSync(join(T, 'pass-'));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(W, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n  email = t@example.com\n  name = t\n');
  spawnSync('git', ['init', '-q', '-b', 'main', join(W, 'repo')], { env: gitEnv });
  spawnSync('git', ['-C', join(W, 'repo'), 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv });
  mkdirSync(join(W, 'wt')); mkdirSync(join(W, 'state', 'logs'), { recursive: true }); mkdirSync(join(W, 'stub'));
  writeFileSync(join(W, 'config.md'), [
    '## 0. Repo', '| Field | Value |', '|---|---|', '| GitHub repo | `acme/widgets` |', '| Default branch | `main` |', '',
    '## 2. Paths', '| Field | Value |', '|---|---|', `| Primary repo root | \`${join(W, 'repo')}\` |`, `| Worktrees directory | \`${join(W, 'wt')}\` |`, '',
    '## 3. Permissions', '| Key | Capability | Recommended | Your setting |', '|---|---|---|---|', '| `autopilot-workers` | Run workers | `yes` | `yes` |', '',
    '## 3b. Cost and autonomy', '| Field | Recommended | Your setting |', '|---|---|---|', '| Autopilot worker concurrency | `2 / 3` | `2 / 4` |',
    ...(borrow ? [`| Borrow idle workers | \`off\` | \`${borrow}\` |`] : []), '',
  ].join('\n'));
  const bin = join(env.DESK_HOME, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const f of ['queue.mjs', 'harvest.mjs', 'desk-env.mjs', 'batch-state.mjs', 'briefing.mjs']) symlinkSync(join(BIN, f), join(bin, f));
  writeFileSync(join(bin, 'setup-worktree.sh'), `mkdir -p "${join(W, 'wt')}/$2"; echo "[setup-worktree] worktree=${join(W, 'wt')}/$2"; echo "[setup-worktree] branch=$3"\n`);
  writeFileSync(join(bin, 'spawn-worker.sh'), 'if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi\n');
  writeFileSync(join(W, 'stub', 'claude'), "#!/bin/sh\necho '[{\"sessionId\": \"live-1\"}]'\n", { mode: 0o755 });
  writeFileSync(join(W, 'stub', 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const self = queuePath('acme__widgets');
  const tickets = {};
  for (const k of ['W-1', 'W-2']) tickets[k] = { key: k, state: 'running', session_id: 'live-1', branch: `fix/${k}` };
  for (const k of ['W-3', 'W-4', 'W-5']) tickets[k] = { key: k, state: 'triaged', open_questions: 0, branch: `fix/${k}` };
  mkdirSync(dirname(self), { recursive: true });
  writeFileSync(self, JSON.stringify({ version: 1, batch: 'w', tickets }));
  repo('acme__idle', { conc: '5 / 6', share: 5 });
  const penv = { ...gitEnv, PATH: `${join(W, 'stub')}:${process.env.PATH}`, DESK_CONFIG: join(W, 'config.md'), DESK_QUEUE: self,
    DESK_AUTOPILOT_STATE: join(W, 'state'), AUTOPILOT_MIN_AVAIL_GB: minAvail, AUTOPILOT_ORCHESTRATOR: 'test', AUTOPILOT_PORT_FLOOR: '45100' };
  const r = spawnSync('node', [join(BIN, 'pass.mjs')], { encoding: 'utf8', env: penv, cwd: join(W, 'repo') });
  const states = Object.values(JSON.parse(readFileSync(self, 'utf8')).tickets).filter((x) => x.state === 'running').length;
  return { out: `${r.stdout}${r.stderr}`, running: states };
}
let w = passWorld({ borrow: 'on' });
t('pass AC1: with borrowing on it starts 2 above its own number of 2, to its cap of 4', w.running, 4);
t('pass AC1: the report says 2 workers are borrowed', /^borrowing: 2 workers borrowed this pass, 2 above the batch's own number of 2 \(machine 10: 2 running, 0 claimed by other batches\)$/m.test(w.out), true);
w = passWorld({ borrow: null });
t('pass AC8: borrowing off by default, it starts nothing at its own number', w.running, 2);
t('pass AC8: and says nothing about borrowing', /borrowing/.test(w.out), false);
w = passWorld({ borrow: 'on', minAvail: '100000' });
t('pass AC5: below the spawn gate nothing starts', w.running, 2);
t('pass AC5: the report names the gate', /^borrowing: nothing starts, borrowed or not: available memory .* under the 100000G spawn gate$/m.test(w.out), true);

console.log(fails ? `${fails} FAILED` : 'all borrow checks passed');
process.exit(fails ? 1 : 0);
