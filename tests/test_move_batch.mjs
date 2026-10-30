// suite: move-batch (a standing batch on a base moves to its epic's own batch slot)
// move-batch.mjs against fixture queues and state folders in a throwaway HOME and DESK_HOME.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-move-batch-'));
const HOME = join(T, 'home');
const DESK_HOME = join(T, 'deskhome');
const SLUG = 'acme__widgets';
mkdirSync(HOME, { recursive: true });
const config = join(T, 'config.md');
writeFileSync(config, '## 0. Repo\n\n| Field | Value |\n|---|---|\n| Default branch | `main` |\n');

const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DESK_|AUTOPILOT_)/.test(k)));
Object.assign(base, { HOME, DESK_HOME, DESK_CONFIG: config, DESK_REPO_OVERRIDE: 'acme/widgets', DESK_MACHINE: join(T, 'none.md'), DESK_MOVE_DRIVER_WAIT_MS: '5000' });

const standingQ = join(DESK_HOME, 'repos', SLUG, 'queue.json');
const standingS = join(HOME, '.desk-autopilot', SLUG);
const namedQ = (n) => join(DESK_HOME, 'repos', SLUG, 'batches', n, 'queue.json');
const namedS = (n) => join(HOME, '.desk-autopilot', SLUG, 'batches', n);

const move = () => {
  const r = spawnSync('node', [join(BIN, 'move-batch.mjs')], { encoding: 'utf8', env: base });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const read = (p) => readFileSync(p, 'utf8');
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
// Every file under `dir`, with its contents, so "nothing changed" compares the whole tree.
const tree = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile()).map((d) => { const p = join(d.parentPath ?? d.path, d.name); return `${p}=${read(p)}`; }).sort().join('\n') : '');
const everything = () => `${tree(join(DESK_HOME, 'repos'))}\n${tree(join(HOME, '.desk-autopilot'))}`;
const reset = () => { rmSync(join(DESK_HOME, 'repos'), { recursive: true, force: true }); rmSync(join(HOME, '.desk-autopilot'), { recursive: true, force: true }); };
const queue = (extra) => JSON.stringify({ version: 1, batch: '2026-10-12T07:29', concurrency: 2, tickets: {
  'K-1': { key: 'K-1', state: 'triaged', handoff: 'pending', handoff_stage: '4b' },
  'K-2': { key: 'K-2', state: 'parked', park: { question: 'which colour?' } },
  'K-3': { key: 'K-3', state: 'done', result: { pr: 7 } },
}, ...extra }, null, 2);

// AC5: no standing batch, or one on the default branch, is left alone.
let r = move();
t('AC5 no standing batch: exit 0', r.code, 0);
t('AC5 no standing batch: says so', r.out.includes('nothing to move'), true);
t('AC5 no standing batch: writes nothing', everything(), '\n');
put(standingQ, queue({ epic: 'E-1', supervised: true }));
put(join(standingS, 'parks', 'K-2.json'), '{"question":"which colour?"}');
let before = everything();
r = move();
t('AC5 a standing batch on main: exit 0', r.code, 0);
t('AC5 a standing batch on main: says it runs on the default branch', r.out.includes('runs on the default branch: nothing to move'), true);
t('AC5 a standing batch on main: nothing changed', everything(), before);
t('AC5 a standing batch on main: no batch slot made', existsSync(join(DESK_HOME, 'repos', SLUG, 'batches')) || existsSync(join(standingS, 'batches')), false);

// AC4: a standing batch on a base whose epic cannot be read is refused, naming it, and nothing changes.
for (const [why, extra, says] of [
  ['no epic', {}, 'its queue names no epic'],
  ['an epic that is not a batch name', { epic: '../x' }, '"../x" is not a batch name'],
]) {
  reset();
  put(standingQ, queue({ base: 'feat/x', supervised: true, ...extra }));
  put(join(standingS, 'parks', 'K-2.json'), '{"question":"which colour?"}');
  before = everything();
  r = move();
  t(`AC4 ${why}: refused`, r.code, 11);
  t(`AC4 ${why}: names what is missing`, r.out.includes(says), true);
  t(`AC4 ${why}: nothing changed`, everything(), before);
}
// A slot the epic already has, or a pass running, is refused the same way.
reset();
put(standingQ, queue({ base: 'feat/x', epic: 'E-1' }));
put(namedQ('E-1'), queue({}));
before = everything();
r = move();
t('an epic whose slot is taken: refused, naming it', r.code === 11 && r.out.includes(`batch E-1 already has ${namedQ('E-1')}`), true);
t('an epic whose slot is taken: nothing changed', everything(), before);
reset();
put(standingQ, queue({ base: 'feat/x', epic: 'E-1' }));
put(join(standingS, 'orchestrator.lock'), JSON.stringify({ pid: process.pid, since: 'now' }));
before = everything();
r = move();
t('a pass holding the lock: refused', r.code === 11 && r.out.includes(`a pass is running in the standing batch (pid ${process.pid})`), true);
t('a pass holding the lock: nothing changed', everything(), before);
// A queue lock is never taken over, even one a dead writer left: queue.mjs clears that under its own lock.
const dead = Number(spawnSync('bash', ['-c', 'true & echo $!'], { encoding: 'utf8' }).stdout.trim());
for (const [why, pid, says] of [['a live queue write', process.pid, `a queue write holds ${standingQ}.lock (pid ${process.pid})`], ['a dead writer\'s queue lock', dead, `a queue write that has exited (pid ${dead})`]]) {
  reset();
  put(standingQ, queue({ base: 'feat/x', epic: 'E-1', supervised: true }));
  put(join(`${standingQ}.lock`, 'pid'), `${pid}\n`);
  before = everything();
  r = move();
  t(`${why}: refused, naming it`, r.code === 11 && r.out.includes(says), true);
  t(`${why}: nothing changed, the lock left in place`, everything(), before);
}
// Only a batch the supervisor runs moves.
reset();
put(standingQ, queue({ base: 'feat/x', epic: 'E-1', supervised: false }));
put(join(standingS, 'handoffs', 'K-1.json'), '{"ticket":"K-1"}');
before = everything();
r = move();
t('a batch a session runs: refused, naming it', r.code === 11 && r.out.includes('is run by a session, not the supervisor'), true);
t('a batch a session runs: nothing changed', everything(), before);
// AC2: a batch with workers running drains instead: its spawns pause, nothing moves, and the running
// workers and their files are left as they are.
for (const [why, extra, says] of [
  ['a running worker', { tickets: { 'K-1': { key: 'K-1', state: 'running' }, 'K-2': { key: 'K-2', state: 'running' } } }, 'K-1, K-2 are running'],
  ['a running base fix', { base_fix: { running: true } }, 'the base fix is running'],
]) {
  reset();
  put(standingQ, queue({ base: 'feat/x', epic: 'E-1', supervised: true, concurrency: 3, ...extra }));
  put(join(standingS, 'handoffs', 'K-1.json'), '{"ticket":"K-1"}');
  const was = JSON.parse(read(standingQ));
  r = move();
  t(`AC2 ${why}: drains, naming it`, r.code === 12 && r.out.includes(says) && r.out.includes('new spawns are paused'), true);
  const dq = JSON.parse(read(standingQ));
  t(`AC2 ${why}: spawns paused as the user's worker count of 0`, `${dq.concurrency}/${dq.concurrency_by}/${dq.concurrency_user}`, '0/user/0');
  t(`AC2 ${why}: the count it had is kept`, `${dq.move_drain?.epic} ${dq.move_drain?.concurrency} ${dq.move_drain?.concurrency_by}`, 'E-1 3 null');
  t(`AC2 ${why}: tickets untouched`, JSON.stringify(dq.tickets), JSON.stringify(was.tickets));
  t(`AC2 ${why}: nothing moved`, existsSync(namedQ('E-1')) || !existsSync(join(standingS, 'handoffs', 'K-1.json')), false);
  t(`AC2 ${why}: no lock is left behind`, existsSync(`${standingQ}.lock`) || existsSync(join(standingS, 'orchestrator.lock')), false);
}
// Run again while still draining: the kept count is not overwritten by the pause.
r = move();
t('AC2 run again while draining: still drains, keeping the count it had', `${r.code} ${JSON.parse(read(standingQ)).move_drain?.concurrency}`, '12 3');
// Once the workers have parked or finished, the move runs and sets the count back.
const drainedQ = JSON.parse(read(standingQ));
delete drainedQ.base_fix;
put(standingQ, JSON.stringify(drainedQ, null, 2));
r = move();
const back = JSON.parse(read(namedQ('E-1')));
t('AC2 drained: moved', r.code === 0 && r.out.includes('is 3 again'), true);
t('AC2 drained: the worker count is set back and the drain cleared', `${back.concurrency} ${'concurrency_by' in back} ${'concurrency_user' in back} ${'move_drain' in back}`, '3 false false false');
// A count the person set while it drained is theirs: the move leaves it.
reset();
put(standingQ, queue({ base: 'feat/x', epic: 'E-1', supervised: true, concurrency: 1, concurrency_by: 'user', concurrency_user: 1, move_drain: { epic: 'E-1', concurrency: 3, concurrency_by: null, concurrency_user: null } }));
r = move();
const kept = JSON.parse(read(namedQ('E-1')));
t('AC2 a count set while draining: moved, keeping it', `${r.code} ${kept.concurrency} ${kept.concurrency_by} ${'move_drain' in kept}`, '0 1 user false');
reset();
put(standingQ, queue({ base: 'feat/x', epic: 'E-1', supervised: true }));
put(join(standingS, 'supervisor.json'), JSON.stringify({ idle: null, decider: { pid: process.pid, out: join(standingS, 'decider', 'd.json') } }));
before = everything();
r = move();
t('a running decider: refused, naming it', r.code === 11 && r.out.includes(`decider session (pid ${process.pid}) is running`), true);
t('a running decider: nothing changed', everything(), before);

// AC1: a live standing batch on a feature branch moves whole to batches/E-1/, and the slot is empty.
reset();
const q = queue({ base: 'feat/epics', epic: 'E-1', supervised: true, approved: { workers: true } });
put(standingQ, q);
const moving = {
  'parks/K-2.json': '{"question":"which colour?"}',
  'answers/K-2.txt': 'blue',
  'logs/K-1.log': '{"type":"system"}\n',
  'triage/K-1.json': '{"ticket":"K-1"}',
  'batch-notes.md': '# Batch notes\n',
  'handoffs/K-1.json': '{"ticket":"K-1","stage":"4b"}',
  'merge-driver.log': 'merge driver exited 0\n',
};
const staying = {
  'intake.json': '{"seen":{}}',
  'supervisor.agent.log': 'agent\n',
  'batches/OTHER/parks/O-1.json': '{"question":"other batch"}',
};
for (const [f, text] of Object.entries({ ...moving, ...staying })) put(join(standingS, f), text);
// A merge driver holding its lock: a process that outlives this check, reparented so it is reaped.
const sleeper = Number(spawnSync('bash', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim());
put(join(standingS, 'merge-driver.lock.d', 'pid'), `${sleeper}\n`);
// The supervisor had read the batch as idle, with that driver running.
put(join(standingS, 'supervisor.json'), JSON.stringify({ idle: 'abc123', notified: ['x'], driver: { pid: sleeper, started: 'then', failures: 1 },
  decider: { pid: dead, out: join(standingS, 'decider', 'd.json') } }));
put(join(standingS, 'decider', 'd.json'), '{"result":"x"}');
// A close-out note for this queue, and one written for another.
put(join(standingS, 'closed-out', 'K-2.json'), `${JSON.stringify({ ticket: 'K-2', how: 'done', pr: null, at: 'then', queue: standingQ })}\n`);
put(join(standingS, 'closed-out', 'K-9.json'), `${JSON.stringify({ ticket: 'K-9', how: 'merged', pr: 3, at: 'then', queue: '/other/queue.json' })}\n`);
r = move();
t('AC1 moved: exit 0', r.code, 0);
t('AC1 moved: says where it went', r.out.includes('from the standing slot to batch E-1') && r.out.includes(namedQ('E-1')) && r.out.includes(namedS('E-1')), true);
t('AC1 the queue is under batches/E-1/, unchanged', existsSync(namedQ('E-1')) && read(namedQ('E-1')), q);
const moved = JSON.parse(read(namedQ('E-1')));
t('AC1 its base is unchanged', moved.base, 'feat/epics');
t('AC1 its supervised flag is unchanged', moved.supervised, true);
t('AC1 its tickets and parks are unchanged', JSON.stringify(moved.tickets), JSON.stringify(JSON.parse(q).tickets));
for (const [f, text] of Object.entries(moving)) t(`AC1 state ${f} moved, unchanged`, existsSync(join(namedS('E-1'), f)) && read(join(namedS('E-1'), f)), text);
for (const f of Object.keys(moving)) t(`AC1 state ${f} is gone from the standing slot`, existsSync(join(standingS, f)), false);
for (const [f, text] of Object.entries(staying)) t(`AC1 ${f} stays with the standing slot`, existsSync(join(standingS, f)) && read(join(standingS, f)), text);
t('AC1 the standing slot has no queue', existsSync(standingQ), false);
t('AC1 no lock is left behind', ['orchestrator.lock', 'supervisor.lock'].some((f) => existsSync(join(standingS, f))) || existsSync(`${standingQ}.lock`), false);
let driverAlive = true;
try { process.kill(sleeper, 0); } catch { driverAlive = false; }
t('AC1 the merge driver was stopped, for the supervisor to start again in E-1', driverAlive, false);
t('AC1 and the output says so', r.out.includes(`its merge driver (pid ${sleeper}) was stopped`), true);
const sup = JSON.parse(read(join(namedS('E-1'), 'supervisor.json')));
t('AC2 the supervisor no longer reads the moved batch as idle, so its next tick runs a pass', sup.idle, null);
t('AC2 the stopped driver counts no failed start', `${sup.driver.pid}/${sup.driver.failures}`, 'null/1');
t('AC2 the rest of the supervisor state moved unchanged', JSON.stringify(sup.notified), '["x"]');
t('AC2 an ended decider\'s result is read from where it moved', sup.decider.out, join(namedS('E-1'), 'decider', 'd.json'));
t('AC2 and it is there', existsSync(sup.decider.out), true);
const note = JSON.parse(read(join(namedS('E-1'), 'closed-out', 'K-2.json')));
t('AC2 a close-out note for the batch names its moved queue, so a pass applies it', `${note.queue} ${note.how}`, `${namedQ('E-1')} done`);
t('AC2 a note written for another queue is left alone', JSON.parse(read(join(namedS('E-1'), 'closed-out', 'K-9.json'))).queue, '/other/queue.json');
const listed = spawnSync('node', ['--input-type=module', '-e', `import * as B from '${join(BIN, 'batches.mjs')}'; console.log(B.listBatches().map((b) => b.name ?? '-').join(' ')); console.log(B.batchHolding('K-2')?.name)`], { encoding: 'utf8', env: base });
t('AC1 the repo lists the standing slot and batch E-1', listed.stdout.trim(), '- E-1\nE-1');
r = move();
t('AC1 run again with the slot empty: nothing to move', r.code === 0 && r.out.includes('there is no standing batch'), true);

// AC2: a screenshot folder the queue records under the old state folder follows the move.
reset();
put(standingQ, queue({ base: 'feat/epics', epic: 'E-1', supervised: true }));
const withImages = JSON.parse(read(standingQ));
withImages.tickets['K-1'].images_dir = join(standingS, 'images', 'K-1');
withImages.tickets['K-3'].images_dir = '/elsewhere/K-3';
put(standingQ, JSON.stringify(withImages, null, 2));
put(join(standingS, 'images', 'K-1', 'shot.png'), 'png');
r = move();
t('AC2 with screenshots: moved', r.code, 0);
const after = JSON.parse(read(namedQ('E-1')));
t('AC2 an images_dir under the old folder points at the moved one', after.tickets['K-1'].images_dir, join(namedS('E-1'), 'images', 'K-1'));
t('AC2 and the screenshot is there', existsSync(join(after.tickets['K-1'].images_dir, 'shot.png')), true);
t('AC2 an images_dir elsewhere is left alone', after.tickets['K-3'].images_dir, '/elsewhere/K-3');
t('AC2 everything else in the queue unchanged', JSON.stringify({ ...after, tickets: null }), JSON.stringify({ ...withImages, tickets: null }));
t('AC2 with screenshots: the standing slot has no queue', existsSync(standingQ), false);

if (fails) { console.log(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nall passed');
