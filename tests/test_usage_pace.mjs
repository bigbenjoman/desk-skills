// suite: usage pace (a pass holds new spawns while 7-day usage runs ahead of an even weekly pace)
// usage-pace.mjs with a fixed clock against fake worker logs carrying rate_limit_event lines, then the
// real pass.mjs, with stub claude, gh, setup-worktree and spawn-worker, once per acceptance criterion.
// A throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT: nothing touches your real state.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-usage-pace-'));
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'), DESK_LOCK_DIR: join(T, 'locks') };
for (const k of ['DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH',
  'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'CLAUDE_CODE_SESSION_ID', 'AUTOPILOT_DRY_RUN', 'AUTOPILOT_RERUN', 'AUTOPILOT_PORT_FLOOR',
  'AUTOPILOT_MIN_AVAIL_GB', 'AUTOPILOT_BATCH_BUDGET_USD', 'DESK_UPLOAD_APPROVED']) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });
// Imported after the environment is set: desk-env reads HOME once.
const P = await import(join(BIN, 'usage-pace.mjs'));

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// One rate_limit_event line, as real workers write it (tests/fixtures/usage-limit-allowed.json).
const event = (utilization, resetsAt) => JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed', resetsAt: 1, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 }, seven_day: { utilization, resetsAt } } },
});
const resetIn = (now, ms) => Math.round((now + ms) / 1000);
// A worker log in `state` holding `lines`, last written `ago` ms before the real clock.
function log(state, name, lines, ago = 0) {
  mkdirSync(join(state, 'logs'), { recursive: true });
  const path = join(state, 'logs', `${name}.log`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  const at = (Date.now() - ago) / 1000;
  utimesSync(path, at, at);
}

// ---- the module, with a fixed clock --------------------------------------------------------
const NOW = Date.UTC(2026, 9, 22, 18, 0);
t('the row unset is a headroom of 5', JSON.stringify(P.pacingSetting(null)), '{"headroom":5}');
t('a number is a headroom in points', JSON.stringify(P.pacingSetting(' 10 ')), '{"headroom":10}');
t('off is off', JSON.stringify(P.pacingSetting('OFF')), '{"off":true}');
t('anything else is bad, naming the row', /Usage pacing headroom \(points\)" is "5 points"/.test(P.pacingSetting('5 points').bad), true);
t('pace with 3.5 days left is 50%', P.paceAt(resetIn(NOW, 3.5 * DAY), NOW), 50);
t('pace just after a reset is 0%', Math.round(P.paceAt(resetIn(NOW, 7 * DAY), NOW)), 0);
t('a top-level event is read', JSON.stringify(P.windowEvents(event(0.4, 100)).map((e) => e.seven_day)), '[{"utilization":0.4,"resetsAt":100}]');
t('the event quoted inside a tool result is not', P.windowEvents(`{"type":"user","content":${JSON.stringify(event(0.9, 100))}}`).length, 0);
const at = (u, ms) => ({ utilization: u, resetsAt: resetIn(NOW, ms) });
const pace = (setting, usage) => P.usagePace({ setting: P.pacingSetting(setting), usage, now: NOW });
t('AC1 unit: 40% at pace 50 spawns', JSON.stringify(pace(null, at(0.4, 3.5 * DAY))), '{"hold":false,"bad":null,"line":"usage: 7-day 40%, pace 50%"}');
t('AC2 unit: 62% at pace 50 + 5 holds', JSON.stringify(pace('5', at(0.62, 3.5 * DAY))), '{"hold":true,"bad":null,"line":"usage: 7-day 62%, pace 50% + 5: holding spawns"}');
t('at exactly pace + headroom it still spawns', pace('5', at(0.55, 3.5 * DAY)).hold, false);
t('AC3 unit: no reading spawns and says so', JSON.stringify(pace(null, null)), '{"hold":false,"bad":null,"line":"usage: no recent data"}');
t('AC4 unit: off spawns ahead of pace and says off', JSON.stringify(pace('off', at(0.9, 3.5 * DAY))), '{"hold":false,"bad":null,"line":"usage: 7-day 90%, pace 50%, pacing off (config §3b \\"Usage pacing headroom (points)\\")"}');
t('AC5 unit: a bad row holds', pace('lots', at(0.1, 3.5 * DAY)).hold && !!pace('lots', null).bad, true);
t('AC7 unit: a reading whose window reset is unknown, and spawns', /^usage: no recent data \(the newest reading's 7-day window reset at /.test(pace('5', at(0.99, -HOUR)).line) && !pace('5', at(0.99, -HOUR)).hold, true);

// Logs: the 6-hour window, and the newest reading across every repo's state directory.
const root = join(env.HOME, '.desk-autopilot');
const A = join(root, 'acme__a');
const B = join(root, 'acme__b');
const real = Date.now();
log(A, 'A-1', [event(0.3, resetIn(real, 2 * DAY)), event(0.4, resetIn(real, 2 * DAY))]);
log(B, 'B-1', [event(0.62, resetIn(real, 2 * DAY))], HOUR);
t('AC6 unit: the newest reading across both repos', JSON.stringify(P.newestUsage({ dirs: P.stateDirs({ self: A, root }), now: real })), JSON.stringify({ utilization: 0.62, resetsAt: resetIn(real, 2 * DAY) }));
log(B, 'B-1', [event(0.9, resetIn(real, -DAY))]);
t('a later window beats a higher reading in a window that has reset', P.newestUsage({ dirs: P.stateDirs({ self: A, root }), now: real }).utilization, 0.4);
// A log over the 1 MB tail: the tail's newest reading, and the whole log when the tail has none.
const filler = Array(12000).fill(JSON.stringify({ type: 'user', pad: 'x'.repeat(100) }));
log(A, 'A-1', [event(0.3, resetIn(real, 2 * DAY)), ...filler, event(0.45, resetIn(real, 2 * DAY)), ...filler.slice(0, 10)]);
rmSync(join(B, 'logs'), { recursive: true });
t('a long log is read from its tail', P.newestUsage({ dirs: P.stateDirs({ self: A, root }), now: real }).utilization, 0.45);
log(A, 'A-1', [event(0.35, resetIn(real, 2 * DAY)), ...filler]);
t('a long log whose tail has no reading is read whole', P.newestUsage({ dirs: P.stateDirs({ self: A, root }), now: real }).utilization, 0.35);
log(A, 'A-1', [event(0.4, resetIn(real, 2 * DAY))], 7 * HOUR);
log(B, 'B-1', ['{"type":"assistant"}'], 0);
t('AC3 unit: a log last written over 6 hours ago does not count', P.newestUsage({ dirs: P.stateDirs({ self: A, root }), now: real }), null);
writeFileSync(join(B, 'logs', 'B-2.log.round1.gz'), gzipSync(`${event(0.5, resetIn(real, 2 * DAY))}\n`));
t('a round moved aside gzipped is read too', P.newestUsage({ dirs: P.stateDirs({ self: A, root }), now: real })?.utilization, 0.5);
// DS-305: a named batch's logs sit under its repo's state directory, in batches/<name>/.
const dirsOf = (self) => JSON.stringify(P.stateDirs({ self, root }).sort());
t('DS-305 AC5 unit: with only standing batches, the directories are the repos\'', dirsOf(A), JSON.stringify([A, B]));
const X = join(A, 'batches', 'X-1');
log(X, 'X-2', [event(0.7, resetIn(real, 2 * DAY))]);
mkdirSync(join(A, 'batches', '.done', 'X-0'), { recursive: true });
t('DS-305 a named batch is listed, an archived one is not', dirsOf(A), JSON.stringify([A, X, B].sort()));
t('DS-305 AC3 unit: a named batch\'s worker logs count', P.newestUsage({ dirs: P.stateDirs({ self: A, root }), now: real })?.utilization, 0.7);
t('DS-305 AC3 unit: and from inside the named batch, its repo\'s do too', P.stateDirs({ self: X, root }).includes(A), true);
rmSync(root, { recursive: true, force: true });

// ---- the real pass.mjs ---------------------------------------------------------------------
// A world for passes: a DESK_HOME whose bin holds the real queue scripts beside stubs, and this repo
// with one running worker and one ready ticket. -> { state, run }, where run() resolves to the output.
let floor = 46100;
function world({ pacing } = {}) {
  rmSync(join(T, 'w'), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(env.DESK_HOME, { recursive: true, force: true });
  const W = join(T, 'w');
  const bin = join(env.DESK_HOME, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(W, 'stub'), { recursive: true });
  for (const f of ['queue.mjs', 'harvest.mjs', 'desk-env.mjs', 'batch-state.mjs', 'briefing.mjs']) symlinkSync(join(BIN, f), join(bin, f));
  writeFileSync(join(bin, 'setup-worktree.sh'), 'mkdir -p "$WT_DIR/$2"; echo "[setup-worktree] worktree=$WT_DIR/$2"; echo "[setup-worktree] branch=$3"\n');
  writeFileSync(join(bin, 'spawn-worker.sh'), 'if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi\n');
  writeFileSync(join(W, 'stub', 'claude'), "#!/bin/sh\necho '[{\"sessionId\": \"live-1\"}]'\n", { mode: 0o755 });
  writeFileSync(join(W, 'stub', 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const slug = 'acme__widgets';
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(W, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n  email = t@example.com\n  name = t\n');
  spawnSync('git', ['init', '-q', '-b', 'main', join(W, 'repo')], { env: gitEnv });
  spawnSync('git', ['-C', join(W, 'repo'), 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv });
  mkdirSync(join(W, 'wt'), { recursive: true });
  const state = join(root, slug);
  mkdirSync(join(state, 'logs'), { recursive: true });
  const config = join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, [
    '## 0. Repo', '| Field | Value |', '|---|---|', '| GitHub repo | `acme/widgets` |', '| Default branch | `main` |', '',
    '## 2. Paths', '| Field | Value |', '|---|---|', `| Primary repo root | \`${join(W, 'repo')}\` |`, `| Worktrees directory | \`${join(W, 'wt')}\` |`, '',
    '## 3. Permissions', '| Key | Capability | Recommended | Your setting |', '|---|---|---|---|', '| `autopilot-workers` | Run workers | `yes` | `yes` |', '',
    '## 3b. Cost and autonomy', '| Field | Recommended | Your setting |', '|---|---|---|', '| Autopilot worker concurrency | `2 / 3` | `2 / 3` |',
    ...(pacing ? [`| Usage pacing headroom (points) | \`5\` | \`${pacing}\` |`] : []), '',
  ].join('\n'));
  const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  writeFileSync(q, JSON.stringify({ version: 1, batch: slug, tickets: {
    'R-1': { key: 'R-1', state: 'running', session_id: 'live-1', branch: 'fix/R-1' },
    'Y-1': { key: 'Y-1', state: 'triaged', open_questions: 0, branch: 'fix/Y-1' },
  } }));
  const penv = { ...gitEnv, PATH: `${join(W, 'stub')}:${process.env.PATH}`, DESK_CONFIG: config, DESK_QUEUE: q, DESK_AUTOPILOT_STATE: state,
    WT_DIR: join(W, 'wt'), AUTOPILOT_MIN_AVAIL_GB: '0', AUTOPILOT_HEALTH_CHECKS: 'off', AUTOPILOT_ORCHESTRATOR: 'test', AUTOPILOT_PORT_FLOOR: String(floor += 100) };
  const run = () => new Promise((res) => {
    const c = spawn('node', [join(BIN, 'pass.mjs')], { env: penv, cwd: join(W, 'repo') });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', () => res(out));
  });
  const ticket = (k) => JSON.parse(readFileSync(q, 'utf8')).tickets[k].state;
  return { state, run, ticket };
}
const soon = (days) => resetIn(Date.now(), days * DAY);

// AC1: 40% with 3.5 days left, headroom 5.
let w = world({ pacing: '5' });
log(w.state, 'R-1', [event(0.4, soon(3.5))]);
let out = await w.run();
t('pass AC1: it spawns as usual', w.ticket('Y-1'), 'running');
t('pass AC1: it reports usage and pace', /^usage: 7-day 40%, pace 50%$/m.test(out), true);

// AC2: 62% with 3.5 days left, headroom 5.
w = world({ pacing: '5' });
log(w.state, 'R-1', [event(0.62, soon(3.5))]);
out = await w.run();
t('pass AC2: it starts no new worker', w.ticket('Y-1'), 'triaged');
t('pass AC2: and leaves the running one alone', w.ticket('R-1'), 'running');
t('pass AC2: it reports the hold', /^usage: 7-day 62%, pace 50% \+ 5: holding spawns$/m.test(out), true);

// AC3: the only event is in a log last written 7 hours ago.
w = world();
log(w.state, 'R-1', [event(0.9, soon(3.5))], 7 * HOUR);
out = await w.run();
t('pass AC3: it spawns as usual', w.ticket('Y-1'), 'running');
t('pass AC3: it reports no recent data', /^usage: no recent data$/m.test(out), true);

// AC4: pacing off, usage well ahead of pace.
w = world({ pacing: 'off' });
log(w.state, 'R-1', [event(0.9, soon(3.5))]);
out = await w.run();
t('pass AC4: it spawns as usual', w.ticket('Y-1'), 'running');
t('pass AC4: it reports pacing as off', /^usage: 7-day 90%, pace 50%, pacing off /m.test(out), true);

// AC5: a row that is neither points nor off.
w = world({ pacing: 'five' });
log(w.state, 'R-1', [event(0.1, soon(3.5))]);
out = await w.run();
t('pass AC5: it holds every spawn', w.ticket('Y-1'), 'triaged');
t('pass AC5: it names the row', /Usage pacing headroom \(points\)" is "five" — want a number of percentage points, or `off` — not spawning until it is fixed/.test(out), true);

// AC6: this repo's log is under pace; another repo's newer reading is ahead of it.
w = world({ pacing: '5' });
log(w.state, 'R-1', [event(0.4, soon(3.5))]);
log(join(root, 'acme__other'), 'O-1', [event(0.62, soon(3.5))]);
out = await w.run();
t('pass AC6: the other repo\'s newer reading holds this repo\'s spawns', w.ticket('Y-1'), 'triaged');
t('pass AC6: and is the one reported', /^usage: 7-day 62%, pace 50% \+ 5: holding spawns$/m.test(out), true);

// AC7: the only reading's window has reset.
w = world({ pacing: '5' });
log(w.state, 'R-1', [event(0.99, soon(-0.1))]);
out = await w.run();
t('pass AC7: usage is unknown, so it spawns', w.ticket('Y-1'), 'running');
t('pass AC7: it reports no recent data', /^usage: no recent data \(the newest reading's 7-day window reset at /m.test(out), true);

console.log(fails ? `${fails} FAILED` : 'all usage pace checks passed');
process.exit(fails ? 1 : 0);
