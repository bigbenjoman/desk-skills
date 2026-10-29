// suite: borrow (a batch borrows worker slots other live batches are not using)
// borrow.mjs against fixture queues, heartbeats and repo configs in a throwaway HOME, DESK_HOME and
// DESK_CONFIG_ROOT, with a fixture machine profile and the available memory injected; then the real
// pass.mjs, with stub claude, gh, setup-worktree and spawn-worker, for the report, the spawn and two
// passes racing for one slot. Nothing touches your real ~/.claude, ~/.config/desk or state.
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
  'AUTOPILOT_MIN_AVAIL_GB', 'AUTOPILOT_BATCH_BUDGET_USD', 'DESK_UPLOAD_APPROVED', 'DESK_BATCH']) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });
const profile = (path, cap) => writeFileSync(path, `## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | \`5 / ${cap}\` | x |\n`);
profile(env.DESK_MACHINE, 10);
// Imported after the environment is set: desk-env reads HOME and the machine profile once.
const B = await import(join(BIN, 'borrow.mjs'));

const NOW = Date.now();
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const queuePath = (slug) => join(env.DESK_HOME, 'repos', slug, 'queue.json');
const namedQueue = (slug, name) => join(env.DESK_HOME, 'repos', slug, 'batches', name, 'queue.json');
const runningAt = (q) => Object.values(JSON.parse(readFileSync(q, 'utf8')).tickets).filter((x) => x.state === 'running').length;
const runningIn = (slug) => runningAt(queuePath(slug));

// One repo: its config's concurrency row, its queue (`running` and `ready` counts, or raw text) and
// a heartbeat `beat` minutes old (none when null).
function repo(slug, { conc = '2 / 4', share = 2, running = 0, ready = 0, beat = 1, raw = null } = {}) {
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | \`2 / 3\` | \`${conc}\` |\n`);
  const q = queuePath(slug);
  mkdirSync(dirname(q), { recursive: true });
  const tickets = {};
  for (let i = 1; i <= running; i++) tickets[`R-${i}`] = { key: `R-${i}`, state: 'running', session_id: 'live-1', branch: `fix/R-${i}` };
  for (let i = 1; i <= ready; i++) tickets[`Y-${i}`] = { key: `Y-${i}`, state: 'triaged', open_questions: 0, branch: `fix/Y-${i}` };
  writeFileSync(q, raw ?? JSON.stringify({ version: 1, batch: slug, concurrency: share, tickets }));
  if (beat != null) {
    const dir = join(env.HOME, '.desk-autopilot', slug, 'orchestrators');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'q.json'), JSON.stringify({ queue: q, batch: slug, pid: 1, at: minsAgo(beat) }));
  }
  return q;
}
// A fresh world of repos: a new DESK_HOME, so none of the last one's queues.
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

// The lender comes back to a full machine: it waits for slots to free rather than going over it.
fresh();
repo('acme__lender', { conc: '3 / 4', share: 3, ready: 3 });
repo('acme__borrower', { share: 2, running: 5 });
p = plan('acme__lender', { share: 3, running: 0, wanted: 3 }, { machine: B.machineCap('5 / 5') });
t('a lender on a full machine starts nothing until a slot frees', p.slots, 0);
t('and its report says the machine is full', /^borrowing: starting 0 of the 3 the batch's own number of 3 leaves room for: the machine is full/.test(p.line), true);

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
// DS-185: a recorded next pass keeps a batch live through a long wait, until it is PASS_GRACE_MS overdue.
const beat = (ago, next) => ({ at: NOW - ago * 60000, next: next == null ? null : NOW + next * 60000 });
t('DS-185 a 22-minute-old pass whose next is in 5 minutes is live', B.liveBeat(beat(22, 5), NOW), true);
t('DS-185 nor is it stopped 9 minutes after that next pass was due', B.liveBeat(beat(22, -9), NOW), true);
t('DS-185 but 11 minutes after it, it is', B.liveBeat(beat(22, -11), NOW), false);
t('DS-185 with no next recorded, 15 minutes is still the line', [B.liveBeat(beat(14), NOW), B.liveBeat(beat(16), NOW)].join(), 'true,false');
t('DS-185 --next reads +seconds and ISO times, and nothing else', [B.parseNext('+600', NOW) - NOW, B.parseNext('2026-10-22T14:56:00Z'), B.parseNext('soon')].join(),
  `600000,${Date.parse('2026-10-22T14:56:00Z')},`);

// AC7: another repo's queue that cannot be parsed.
fresh();
repo('acme__a', { share: 2, running: 1, ready: 3 });
repo('acme__broken', { raw: '{ not json' });
p = plan('acme__a', { share: 2, running: 1, wanted: 3 });
t('AC7 it still starts up to its own number, and nothing above it', p.slots, 1);
t('AC7 the report names the unreadable queue', p.line.includes(`${queuePath('acme__broken')} is not valid JSON`), true);
p = plan('acme__a', { share: 3, running: 1, wanted: 1 });
t('AC7 it names the queue when it is starting only within its own number too', p.slots === 2 && p.line.includes(queuePath('acme__broken')), true);
fresh();
repo('acme__a', { share: 2, running: 1, ready: 3 });
repo('acme__nul', { raw: 'null' });
p = plan('acme__a', { share: 2, running: 1, wanted: 3 });
t('AC7 a queue that parses to something other than a queue is unreadable too, not a crash', p.slots === 1 && p.line.includes(`${queuePath('acme__nul')} is not a queue`), true);

// A named batch's queue sits beside its repo's standing one, in batches/<name>/queue.json.
const named = (slug, name, raw) => {
  const q = join(env.DESK_HOME, 'repos', slug, 'batches', name, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  writeFileSync(q, raw);
  return q;
};
const listed = (self) => B.otherQueues({ self }).map((o) => `${o.slug}:${o.batch ?? '-'}${o.error ? ' unreadable' : ''}`).join(' ');
const budget = (self, running) => B.machineBudget({ running, machine: 10, queues: B.otherQueues({ self }) }).line;
fresh();
repo('acme__a', { share: 2, running: 1 });
repo('acme__b', { running: 2 });
t('DS-305 AC5 with only standing batches, each repo\'s queue is listed as before', listed(queuePath('acme__a')), 'acme__b:-');
t('DS-305 AC5 and the machine budget is unchanged', budget(queuePath('acme__a'), 1), 'machine budget: 3 of the machine\'s 10 worker(s) running across every repo');
const x1 = named('acme__a', 'X-1', JSON.stringify({ tickets: { 'X-2': { key: 'X-2', state: 'running' }, 'X-3': { key: 'X-3', state: 'running' }, 'X-4': { key: 'X-4', state: 'triaged' } } }));
mkdirSync(join(env.DESK_HOME, 'repos', 'acme__a', 'batches', '.done', 'X-0'), { recursive: true });
t('DS-305 this repo\'s named batch is listed beside the other repo, an archived one is not', listed(queuePath('acme__a')), 'acme__a:X-1 acme__b:-');
t('DS-305 AC2 the machine budget counts the workers of both batches', budget(queuePath('acme__a'), 1), 'machine budget: 5 of the machine\'s 10 worker(s) running across every repo');
t('DS-305 AC2 and from inside the named batch, the standing batch is the other one', `${listed(x1)} | ${budget(x1, 2)}`,
  'acme__a:- acme__b:- | machine budget: 5 of the machine\'s 10 worker(s) running across every repo');
const xbeat = join(env.HOME, '.desk-autopilot', 'acme__a', 'batches', 'X-1', 'orchestrators');
mkdirSync(xbeat, { recursive: true });
writeFileSync(join(xbeat, 'q.json'), JSON.stringify({ queue: x1, batch: 'X-1', pid: 1, at: minsAgo(1) }));
const xo = B.otherBatches({ self: queuePath('acme__b'), now: NOW }).find((o) => o.batch === 'X-1');
t('DS-305 borrowing reads a named batch\'s heartbeat from its own state directory', `${xo.live} ${xo.running}`, 'true 2');
named('acme__b', 'Y-1', '{ not json');
t('DS-305 an unreadable named batch\'s queue is named and counted at its repo\'s cap', /acme\/b batch Y-1's queue cannot be read \(.*batches\/Y-1\/queue\.json is not valid JSON.*\), so it counts at its cap of 4 workers/.test(budget(queuePath('acme__a'), 1)), true);

// A repo's batches share its §3b cap. A named batch of `slug` with `running` and `ready` tickets and
// a heartbeat `beat` minutes old in its own state directory, planning its next pass in `next` minutes.
function batchOf(slug, name, { share = 2, running = 0, ready = 0, beat = 1, next } = {}) {
  const tickets = {};
  for (let i = 1; i <= running; i++) tickets[`${name}-R${i}`] = { key: `${name}-R${i}`, state: 'running' };
  for (let i = 1; i <= ready; i++) tickets[`${name}-Y${i}`] = { key: `${name}-Y${i}`, state: 'triaged', open_questions: 0 };
  const q = named(slug, name, JSON.stringify({ version: 1, batch: name, concurrency: share, tickets }));
  if (beat != null) {
    const dir = join(env.HOME, '.desk-autopilot', slug, 'batches', name, 'orchestrators');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'q.json'), JSON.stringify({ queue: q, batch: name, pid: 1, at: minsAgo(beat), ...(next != null ? { next: minsAgo(-next) } : {}) }));
  }
  return q;
}
const repoRoom = (self, mine) => B.repoBudget({ cap: 3, ...mine, batches: B.otherBatches({ self, now: NOW }).filter((o) => o.slug === 'acme__a') });
fresh();
repo('acme__a', { conc: '2 / 3', share: 2, running: 2 });
let x1q = batchOf('acme__a', 'X-1', { ready: 2 });
repo('acme__b', { running: 4 });
let r = repoRoom(x1q, { batch: 'X-1', running: 0, wanted: 2 });
t('DS-308 AC1 with the standing batch running 2 of a cap of 3, X-1 starts at most 1', r.room, 1);
t('DS-308 AC1 another repo\'s workers do not count against this repo\'s cap', r.line.startsWith('repo workers: 2 of the §3b cap of 3 running'), true);
t('DS-308 AC5 the line names each batch and the running total against the cap', r.line,
  'repo workers: 2 of the §3b cap of 3 running — batch X-1 (this pass) 0, the standing batch 2: starting at most 1');
repo('acme__a', { conc: '2 / 3', share: 2, running: 2, ready: 1 });
r = repoRoom(queuePath('acme__a'), { running: 2, wanted: 1 });
t('DS-308 AC3 the standing batch, holding every slot but one, leaves it for X-1', r.room, 0);
t('DS-308 AC3 and says so', r.line, 'repo workers: 2 of the §3b cap of 3 running — the standing batch (this pass) 2, batch X-1 0; 2 kept for batch X-1, which has 2 ready and 0 running: nothing starts this pass');
fresh();
repo('acme__a', { conc: '2 / 3', share: 2, running: 1, ready: 1 });
x1q = batchOf('acme__a', 'X-1', { running: 1, ready: 1 });
t('DS-308 AC4 each batch holding one slot of 3: the standing batch leaves the spare one for X-1', repoRoom(queuePath('acme__a'), { running: 1, wanted: 1 }).room, 0);
t('DS-308 AC4 and X-1 may take it', repoRoom(x1q, { batch: 'X-1', running: 1, wanted: 1 }).room, 1);
fresh();
repo('acme__a', { conc: '2 / 3', share: 2, running: 1, ready: 1 });
batchOf('acme__a', 'X-1', { running: 0, ready: 1, beat: 16 });
t('DS-308 a batch whose orchestrator has gone, with nothing running, neither keeps a slot nor counts', String(repoRoom(queuePath('acme__a'), { running: 1, wanted: 1 }).room), 'Infinity');
batchOf('acme__a', 'X-1', { running: 0, ready: 1, beat: 16, next: 5 });
t('DS-308 a batch waiting longer than 15 minutes for the next pass it recorded still keeps its slot', repoRoom(queuePath('acme__a'), { running: 1, wanted: 2 }).room, 1);
fresh();
repo('acme__a', { conc: '2 / 3', share: 2, ready: 1 });
x1q = batchOf('acme__a', 'X-1', { share: 3, running: 2, ready: 1 });
t('DS-308 the standing batch, with ready work and nothing running, takes the last slot rather than both keeping it for the other',
  `${repoRoom(queuePath('acme__a'), { running: 0, wanted: 1 }).room} ${repoRoom(x1q, { batch: 'X-1', running: 2, wanted: 1 }).room}`, '1 0');
fresh();
repo('acme__a', { conc: '1 / 1', share: 1, ready: 1 });
x1q = batchOf('acme__a', 'X-1', { share: 1, ready: 1 });
t('DS-308 at a cap of 1 the one slot goes to the feature batch, not to both or neither',
  `${repoRoom(queuePath('acme__a'), { running: 0, wanted: 1, cap: 1 }).room} ${repoRoom(x1q, { batch: 'X-1', running: 0, wanted: 1, cap: 1 }).room}`, '0 1');
fresh();
repo('acme__a', { conc: '2 / 3', share: 2, running: 1, ready: 3 });
repo('acme__b', { running: 2 });
r = repoRoom(queuePath('acme__a'), { running: 1, wanted: 1 });
t('DS-308 AC6 with only a standing batch there is no repo budget and no line', `${r.room} ${r.line}`, 'Infinity null');
named('acme__a', 'X-9', '{ not json');
r = repoRoom(queuePath('acme__a'), { running: 1, wanted: 1 });
t('DS-308 a batch whose queue cannot be read counts at the cap, and is named', r.room === 0 && /batch X-9 unreadable \(.*X-9\/queue\.json is not valid JSON.*\), counted at the cap/.test(r.line), true);

// AC8: borrowing off, which is the default.
t('AC8 the row is off when unset', B.borrowSetting(null).on, false);
t('a row that is neither on nor off is said and read as off', B.borrowSetting('yes please').on === false && /Borrow idle workers" is "yes please"/.test(B.borrowSetting('yes please').bad), true);
fresh();
repo('acme__a', { share: 2, running: 1, ready: 5 });
p = plan('acme__a', { share: 2, running: 1, wanted: 5, cap: 10 }, { on: false });
t('AC8 off: never above its own number', p.slots, 1);
t('AC8 off: nothing to report', p.line, null);
t('a paused batch (its number 0) borrows nothing', plan('acme__a', { share: 0, running: 0, wanted: 5 }).slots, 0);

// The lock itself. A lock left by a process that has gone is cleared rather than waited on.
mkdirSync(join(env.DESK_LOCK_DIR, 'desk-borrow.lock.d'));
const dead = spawnSync('node', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
writeFileSync(join(env.DESK_LOCK_DIR, 'desk-borrow.lock.d', 'pid'), dead);
const taken = await B.takeBorrowLock({ waitMs: 2000, pollMs: 20 });
t('a dead holder\'s lock is taken over', taken.ok, true);
// A live holder is waited on, then given up on with its pid named.
const second = await B.takeBorrowLock({ waitMs: 300, pollMs: 20, pid: process.pid + 1 });
t('a live holder is given up on after the wait, naming it', second.ok === false && second.why.includes(`pid ${process.pid}`), true);
taken.release();
t('the lock is released', existsSync(join(env.DESK_LOCK_DIR, 'desk-borrow.lock.d')), false);

// ---- the real pass.mjs ----------------------------------------------------------------------
// A world for passes: a fresh DESK_HOME whose bin holds the real queue scripts beside stubs, and a
// machine profile of `machine` workers. setup-worktree takes a second, so a pass that counted the
// free slots is still starting its worker when another pass counts.
function passWorld(machine) {
  fresh();
  const W = mkdtempSync(join(T, 'pass-'));
  const bin = join(env.DESK_HOME, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(W, 'stub'));
  for (const f of ['queue.mjs', 'harvest.mjs', 'desk-env.mjs', 'batch-state.mjs', 'briefing.mjs']) symlinkSync(join(BIN, f), join(bin, f));
  writeFileSync(join(bin, 'setup-worktree.sh'), 'sleep 1; mkdir -p "$WT_DIR/$2"; echo "[setup-worktree] worktree=$WT_DIR/$2"; echo "[setup-worktree] branch=$3"\n');
  writeFileSync(join(bin, 'spawn-worker.sh'), 'if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi\n');
  writeFileSync(join(W, 'stub', 'claude'), "#!/bin/sh\necho '[{\"sessionId\": \"live-1\"}]'\n", { mode: 0o755 });
  writeFileSync(join(W, 'stub', 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  profile(join(W, 'machine.md'), machine);
  return W;
}
// This repo in that world: a git checkout, a config at `conc` with `borrow`, and a queue of `running`
// and `ready` tickets. With `batch`, the queue is that named batch's, and the repo is known by its
// slug so its other batches are found; `machine: false` runs with no machine profile; `prefix` starts
// the ticket keys. -> a function that runs one pass and resolves to its output.
function passRepo(W, slug, { conc = '2 / 4', running = 2, ready = 3, borrow = 'on', minAvail = '0', floor, batch, machine = true, prefix = '', lockDir }) {
  const R = join(W, slug);
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(W, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n  email = t@example.com\n  name = t\n');
  spawnSync('git', ['init', '-q', '-b', 'main', join(R, 'repo')], { env: gitEnv });
  spawnSync('git', ['-C', join(R, 'repo'), 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv });
  mkdirSync(join(R, 'wt'), { recursive: true });
  const state = join(env.HOME, '.desk-autopilot', slug, ...(batch ? ['batches', batch] : []));
  mkdirSync(join(state, 'logs'), { recursive: true });
  // Where every repo's config lives, so the other pass reads this one's own number.
  const config = join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, [
    '## 0. Repo', '| Field | Value |', '|---|---|', `| GitHub repo | \`${slug.replace('__', '/')}\` |`, '| Default branch | `main` |', '',
    '## 2. Paths', '| Field | Value |', '|---|---|', `| Primary repo root | \`${join(R, 'repo')}\` |`, `| Worktrees directory | \`${join(R, 'wt')}\` |`, '',
    '## 3. Permissions', '| Key | Capability | Recommended | Your setting |', '|---|---|---|---|', '| `autopilot-workers` | Run workers | `yes` | `yes` |', '',
    '## 3b. Cost and autonomy', '| Field | Recommended | Your setting |', '|---|---|---|', `| Autopilot worker concurrency | \`2 / 3\` | \`${conc}\` |`,
    ...(borrow ? [`| Borrow idle workers | \`off\` | \`${borrow}\` |`] : []), '',
  ].join('\n'));
  const q = batch ? namedQueue(slug, batch) : queuePath(slug);
  const tickets = {};
  for (let i = 1; i <= running; i++) tickets[`${prefix}R-${i}`] = { key: `${prefix}R-${i}`, state: 'running', session_id: 'live-1', branch: `fix/${prefix}R-${i}` };
  for (let i = 1; i <= ready; i++) tickets[`${prefix}Y-${i}`] = { key: `${prefix}Y-${i}`, state: 'triaged', open_questions: 0, branch: `fix/${prefix}Y-${i}` };
  mkdirSync(dirname(q), { recursive: true });
  writeFileSync(q, JSON.stringify({ version: 1, batch: batch ?? slug, tickets }));
  const penv = { ...gitEnv, PATH: `${join(W, 'stub')}:${process.env.PATH}`, DESK_CONFIG: config, DESK_QUEUE: q,
    DESK_AUTOPILOT_STATE: state, DESK_MACHINE: join(W, machine ? 'machine.md' : 'no-machine.md'), WT_DIR: join(R, 'wt'),
    AUTOPILOT_MIN_AVAIL_GB: minAvail, AUTOPILOT_HEALTH_CHECKS: 'off', AUTOPILOT_ORCHESTRATOR: 'test', AUTOPILOT_PORT_FLOOR: String(floor),
    ...(lockDir ? { DESK_LOCK_DIR: lockDir } : {}),
    ...(batch !== undefined ? { DESK_REPO_OVERRIDE: slug.replace('__', '/'), ...(batch ? { DESK_BATCH: batch } : {}) } : {}) };
  return () => new Promise((res) => {
    const c = spawn('node', [join(BIN, 'pass.mjs')], { env: penv, cwd: join(R, 'repo') });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', () => res(out));
  });
}

// AC1 through a pass: 2 / 4 with 2 running and 3 ready, the other repo live and idle, a machine of 10.
let W = passWorld(10);
repo('acme__idle', { conc: '5 / 6', share: 5 });
let out = await passRepo(W, 'acme__widgets', { floor: 45100 })();
t('pass AC1: with borrowing on it starts 2 above its own number of 2, to its cap of 4', runningIn('acme__widgets'), 4);
t('pass AC1: the report says 2 workers are borrowed', /^borrowing: 2 workers borrowed this pass, 2 above the batch's own number of 2 \(machine 10: 2 running, 0 claimed by other batches\)$/m.test(out), true);

// AC8 through a pass: the same, with no Borrow idle workers row.
W = passWorld(10);
repo('acme__idle', { conc: '5 / 6', share: 5 });
out = await passRepo(W, 'acme__widgets', { borrow: null, floor: 45200 })();
t('pass AC8: borrowing off by default, it starts nothing at its own number', runningIn('acme__widgets'), 2);
t('pass AC8: and says nothing about borrowing', /borrowing/.test(out), false);

// AC5 through a pass: below the spawn gate.
W = passWorld(10);
repo('acme__idle', { conc: '5 / 6', share: 5 });
out = await passRepo(W, 'acme__widgets', { minAvail: '100000', floor: 45300 })();
t('pass AC5: below the spawn gate nothing starts', runningIn('acme__widgets'), 2);
t('pass AC5: the report names the gate', /^borrowing: nothing starts, borrowed or not: available memory .* under the 100000G spawn gate$/m.test(out), true);

// AC3 through a pass: A at 2 / 6 runs 4 (2 borrowed); B, live at 6, runs 6 and has 3 ready: the
// machine of 10 is full.
W = passWorld(10);
repo('acme__b', { conc: '6 / 6', share: 6, running: 6, ready: 3 });
out = await passRepo(W, 'acme__a', { conc: '2 / 6', running: 4, ready: 2, floor: 45400 })();
const aq = JSON.parse(readFileSync(queuePath('acme__a'), 'utf8')).tickets;
t('pass AC3: none of A\'s 4 workers is stopped', ['R-1', 'R-2', 'R-3', 'R-4'].every((k) => aq[k].state === 'running'), true);
t('pass AC3: and it starts nothing new', ['Y-1', 'Y-2'].every((k) => aq[k].state === 'triaged'), true);
t('pass AC3: its report says A is 2 above its own number and starting nothing new', /^borrowing: 2 above the batch's own number of 2, starting nothing new: no free machine slot/m.test(out), true);

// AC4: one free machine slot; A and B each at 1 / 3 with 1 running and 1 ready, so each would start
// its ticket above its own number; both passes at the same moment. Without the lock both count the
// one slot before either has recorded its worker, and both start.
W = passWorld(3);
const passA = passRepo(W, 'acme__a', { conc: '1 / 3', running: 1, ready: 1, floor: 45500 });
const passB = passRepo(W, 'acme__b', { conc: '1 / 3', running: 1, ready: 1, floor: 45600 });
const outs = await Promise.all([passA(), passB()]);
t('AC4 exactly one worker starts', runningIn('acme__a') + runningIn('acme__b'), 3);
t('AC4 the other pass says there is no free machine slot', outs.filter((o) => /starting nothing above it: no free machine slot \(machine 3: 3 running/.test(o)).length, 1);
t('AC4 the lock is released afterwards', existsSync(join(env.DESK_LOCK_DIR, 'desk-borrow.lock.d')), false);

// A repo's batches share its §3b cap, with no machine profile and borrowing off. AC1 and AC5: the
// standing batch runs 2 of a cap of 3, and X-1 has 2 ready and nothing running.
W = passWorld(10);
passRepo(W, 'acme__a', { conc: '2 / 3', running: 2, ready: 0, borrow: null, batch: null, machine: false, floor: 45700 });
out = await passRepo(W, 'acme__a', { conc: '2 / 3', running: 0, ready: 2, borrow: null, batch: 'X-1', machine: false, floor: 45800, prefix: 'X' })();
t('DS-308 pass AC1: X-1 starts 1, the one slot the standing batch leaves', runningAt(namedQueue('acme__a', 'X-1')), 1);
t('DS-308 pass AC5: the report names each batch and the running total against the cap',
  /^repo workers: 2 of the §3b cap of 3 running — batch X-1 \(this pass\) 0, the standing batch 2: starting at most 1$/m.test(out), true);

// AC2: two named batches at a cap of 1, each with 1 ready, passing at the same moment. The shared
// count is taken under the lock, so only one of them starts.
W = passWorld(10);
const passX1 = passRepo(W, 'acme__a', { conc: '1 / 1', running: 0, ready: 1, borrow: null, batch: 'X-1', machine: false, floor: 45900, prefix: 'A' });
const passX2 = passRepo(W, 'acme__a', { conc: '1 / 1', running: 0, ready: 1, borrow: null, batch: 'X-2', machine: false, floor: 46000, prefix: 'B' });
const raced = await Promise.all([passX1(), passX2()]);
t('DS-308 pass AC2: exactly one worker starts across the two batches', runningAt(namedQueue('acme__a', 'X-1')) + runningAt(namedQueue('acme__a', 'X-2')), 1);
t('DS-308 pass AC2: the other pass says nothing starts', raced.filter((o) => /^repo workers: 1 of the §3b cap of 1 running — .*: nothing starts this pass$/m.test(o)).length, 1);

// AC2 without the lock: X-1 with a sibling batch, the lock unmakeable (its folder is a file). Unlocked
// it could count a slot another pass is counting too, so it starts nothing and says why.
W = passWorld(10);
passRepo(W, 'acme__a', { conc: '0 / 3', running: 0, ready: 0, borrow: null, batch: null, machine: false, floor: 46050 });
writeFileSync(join(W, 'not-a-dir'), '');
out = await passRepo(W, 'acme__a', { conc: '2 / 3', running: 0, ready: 2, borrow: null, batch: 'X-1', machine: false, floor: 46060, prefix: 'X', lockDir: join(W, 'not-a-dir') })();
t('DS-308 pass AC2: with sibling batches and no lock, X-1 starts nothing', runningAt(namedQueue('acme__a', 'X-1')), 0);
t('DS-308 pass AC2: and says the lock is why', /^repo workers: nothing starts this pass: the repo's batches share its §3b cap, and the borrow lock .* cannot be made/m.test(out), true);

// AC6: only a standing batch: it starts as many as before, and says nothing about the repo's batches.
W = passWorld(10);
out = await passRepo(W, 'acme__a', { conc: '2 / 4', running: 0, ready: 3, borrow: null, batch: null, machine: false, floor: 46100 })();
t('DS-308 pass AC6: a lone standing batch starts its own number of 2', runningIn('acme__a'), 2);
t('DS-308 pass AC6: and prints no repo workers line', /repo workers/.test(out), false);

console.log(fails ? `${fails} FAILED` : 'all borrow checks passed');
process.exit(fails ? 1 : 0);
