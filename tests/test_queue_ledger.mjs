// suite: queue ledger (with the ledger lever on, every queue write appends what it changed to the ticket ledger)
// The pass's writer in process, queue.mjs commands and move-batch.mjs as processes, each against a
// fixture queue whose ledger sits beside it, with the lever on; and the same writes with it off.
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

const B = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-qledger-');
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete process.env[k];
const REPO = '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n| Default branch | `main` |\n';
const ON = join(T, 'config-on.md');
const OFF = join(T, 'config-off.md');
writeFileSync(ON, `${REPO}\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | \`none\` | \`ledger\` |\n`);
writeFileSync(OFF, REPO);
mkdirSync(join(T, 'home'));
execFileSync('git', ['init', '-q', join(T, 'repo')]);
Object.assign(process.env, { HOME: join(T, 'home'), DESK_CONFIG: ON, DESK_HOME: join(T, 'desk'), DESK_REPO_DIR: join(T, 'repo'), DESK_REPO_ROOT: join(T, 'repo') });

const { queueWriter } = await import('../desk/bin/queue-writer.mjs');
const { versionOf } = await import('../desk/bin/queue-store.mjs');
const { read: readLog, ledgerPaths, reduce, fold } = await import('../desk/bin/ticket-ledger.mjs');
const { recordWrite, ledgerTarget, STANDING } = await import('../desk/bin/queue-ledger.mjs');
const { lock, unlock } = await import('../desk/bin/dir-lock.mjs');

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const write = (f, q) => writeFileSync(f, `${JSON.stringify(q, null, 2)}\n`);
const tk = (key, more = {}) => ({ key, type: 'Task', lane: 'A', state: 'triaged', park: null, result: null, ...more });
let n = 0;
const fixture = (q) => { const f = join(T, `q${++n}`, 'queue.json'); mkdirSync(dirname(f)); write(f, q); return f; };
const other = (f, change) => { const q = read(f); change(q); q.version = versionOf(q) + 1; write(f, q); };
const log = (f) => readLog(dirname(f)).events;
// The events after the first `from`, and those as `type key` each.
const since = (f, from) => log(f).slice(from);
const shape = (evs) => evs.map((e) => `${e.type} ${e.key}`).join(', ');
const q = (f, cfg, ...args) => spawnSync(process.execPath, [join(B, 'queue.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: cfg, DESK_QUEUE: f } });

// AC6 and AC2: a running batch with no log is seeded first; then the pass's state change is one typed
// event and the other fields written with it one legacy event, the pass named as the writer.
{
  const f = fixture({ version: 3, batch: 'b', tickets: { A: tk('A'), B: tk('B', { state: 'queued' }) } });
  const w = queueWriter(f);
  w.apply(['set', 'A', 'state=running', 'session_id=s-1', 'port=3231', 'stage=0/9']);
  w.apply(['set', 'B', 'lane=B']);
  w.flush();
  const evs = log(f);
  t('AC6 the log is seeded with one event per ticket before the write', shape(evs.slice(0, 2)), 'seeded A, seeded B');
  t('AC6 a seeded event holds the ticket as queue.json held it', evs[0].data.fields.state, 'triaged');
  t('AC6 the seeded tickets are in the standing batch', evs[0].batch, STANDING);
  t('AC2 then one typed event for the state change and one legacy event for the rest', shape(evs.slice(2)), 'spawned A, legacy_set A, legacy_set B');
  t('AC2 the typed event carries the spawn', `${evs[2].data.worker} ${evs[2].data.port}`, 's-1 3231');
  t('AC2 the legacy event holds the other fields, not the state', Object.keys(evs[3].data.fields).sort().join(' '), 'port session_id stage updated_at');
  t('AC2 each names the pass as the writer', [...new Set(evs.map((e) => e.by.proc))].join(' '), 'pass');
  t('the version written is one higher, as before', read(f).version, 4);

  const at = log(f).length;
  w.apply(['park', 'A', 'which colour?']);
  w.flush();
  const p = since(f, at);
  t('a batch the log has seen is not seeded again', shape(p), 'parked A, legacy_set A');
  t('a park is a typed parked event with its question', `${p[0].data.kind} ${p[0].data.question}`, 'question which colour?');

  // AC9: a worker's log size or quiet-pass count is written, and appends nothing.
  const at9 = log(f).length;
  w.apply(['set', 'A', 'log_bytes=1200', 'idle_passes=2']);
  const r9 = w.flush();
  t('AC9 the queue is written', `${r9.wrote} ${read(f).tickets.A.idle_passes}`, 'true 2');
  t('AC9 and nothing is appended for it', log(f).length, at9);
}

// AC4: another writer changed a field this pass also set: the log records the value queue.json kept.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A') } });
  const w = queueWriter(f);
  w.apply(['set', 'A', 'stage=1/9']);
  w.flush();
  const at = log(f).length;
  w.apply(['set', 'A', 'lane=D', 'stage=2/9']);
  other(f, (x) => { x.tickets.A.lane = 'C'; });
  const r = w.flush();
  const evs = since(f, at);
  t('AC4 the other writer\'s value stays', `${read(f).tickets.A.lane} ${r.conflicts.map((c) => c.field).join(' ')}`, 'C lane');
  t('AC4 the log never records the value queue.json lost', evs.some((e) => e.data.fields?.lane === 'D'), false);
  t('AC4 and records what this pass did write', evs.map((e) => e.data.fields?.stage).filter(Boolean).join(' '), '2/9');
}

// AC5: a conditional set whose condition no longer holds under the lock appends nothing for it.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A', { state: 'parked', park: { question: 'q', since: 'x' } }), B: tk('B') } });
  const w = queueWriter(f);
  w.apply(['set', 'B', 'stage=1/9']);
  w.flush();
  const at = log(f).length;
  w.apply(['set', 'A', 'resume=x', 'stage=5/9'], { when: (x) => x.state === 'parked' });
  other(f, (x) => { x.tickets.A.state = 'triaged'; x.tickets.A.park = null; });
  const r = w.flush();
  t('AC5 the set is taken back', `${r.skipped.join(' ')} ${read(f).tickets.A.stage ?? 'none'}`, 'A none');
  t('AC5 nothing is appended for the fields it took back', since(f, at).some((e) => 'stage' in (e.data.fields ?? {}) || 'resume' in (e.data.fields ?? {})), false);
}

// AC8: a pass archiving a done ticket appends an archived event for it, after what it changed.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { M: tk('M', { state: 'done', result: { pr: 4 } }), A: tk('A') } });
  const w = queueWriter(f);
  w.apply(['set', 'A', 'stage=1/9']);
  w.flush();
  const at = log(f).length;
  w.apply(['set', 'M', 'merged_at=2026-11-20T10:00:00.000Z']);
  const r = w.flush({ archive: true });
  t('AC8 the ticket is archived', r.archived.join(' '), 'M');
  t('AC8 the log gains its change and an archived event', shape(since(f, at)), 'legacy_set M, archived M');
}

// AC10: the ledger lock held past its wait: queue.json is still written, and one missed append is reported.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A') } });
  const w = queueWriter(f);
  w.apply(['set', 'A', 'stage=1/9']);
  w.flush();
  const at = log(f).length;
  lock(ledgerPaths(dirname(f)).lock);
  w.apply(['set', 'A', 'stage=2/9']);
  const r = w.flush();
  unlock(ledgerPaths(dirname(f)).lock);
  t('AC10 queue.json is still written', `${r.ok} ${read(f).tickets.A.stage}`, 'true 2/9');
  t('AC10 the writer reports one missed append', /locked/.test(r.ledgerMissed ?? ''), true);
  t('AC10 nothing was appended', log(f).length, at);
  q(f, ON, 'set', 'A', 'lane=B');
  lock(ledgerPaths(dirname(f)).lock);
  const r2 = q(f, ON, 'set', 'A', 'lane=C');
  unlock(ledgerPaths(dirname(f)).lock);
  t('AC10 queue.mjs too: the write succeeds and says one append was missed', `${r2.status} ${read(f).tickets.A.lane} ${r2.stderr.includes('ledger: 1 missed append')}`, '0 C true');
}

// AC1: the lever off: nothing is appended, by the pass or by queue.mjs, and each writes as before.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A') } });
  const r = q(f, OFF, 'set', 'A', 'state=running', 'session_id=s-1');
  t('AC1 queue.mjs writes as before', `${r.status} ${read(f).version} ${read(f).tickets.A.state} ${r.stderr}`, '0 2 running ');
  t('AC1 and no log is made', existsSync(ledgerPaths(dirname(f)).dir), false);
}

// AC3: each queue.mjs command that writes the queue appends the events of what it changed, naming the
// command.
{
  const f = join(T, 'cmds', 'queue.json');
  mkdirSync(dirname(f));
  const last = { n: 0 };
  const run = (...args) => {
    const r = q(f, ON, ...args);
    if (r.status !== 0) console.log(`     queue.mjs ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    const evs = existsSync(ledgerPaths(dirname(f)).events) ? log(f) : [];
    const fresh = evs.slice(last.n);
    last.n = evs.length;
    return fresh;
  };
  const by = (evs) => [...new Set(evs.map((e) => e.by.proc))].join(' ');
  let e = run('init', 'b');
  t('AC3 init of an empty batch has no ticket to record', e.length, 0);
  e = run('add', 'T-1');
  t('AC3 add: admitted, then its fields', `${shape(e)} / ${by(e)}`, 'admitted T-1, legacy_set T-1 / queue.mjs add');
  run('add', 'T-2');
  e = run('set', 'T-1', 'lane=B');
  t('AC3 set: its fields', `${shape(e)} / ${by(e)} / ${Object.keys(e[0].data.fields).sort().join(' ')}`, 'legacy_set T-1 / queue.mjs set / lane updated_at');
  e = run('set-batch', 'concurrency=3');
  t('AC3 set-batch changes no ticket and records none', e.length, 0);
  e = run('park', 'T-1', 'which colour?');
  t('AC3 park: parked, then the park', `${shape(e)} / ${by(e)}`, 'parked T-1, legacy_set T-1 / queue.mjs park');
  e = run('requeue', 'T-1');
  t('AC3 requeue: from its park to triage, requeued then triaged', `${read(f).tickets['T-1'].state} ${shape(e.filter((x) => x.type !== 'legacy_set'))} / ${by(e)}`, 'triaged requeued T-1, triaged T-1 / queue.mjs requeue');
  e = run('move', 'T-2', '1');
  t('AC3 move: placed', `${shape(e)} / ${by(e)} / ${e[0]?.data.fields.placed}`, 'legacy_set T-2 / queue.mjs move / true');
  e = run('hold', 'T-1', 'T-2');
  t('AC3 hold: parked, with held_by', `${shape(e)} / ${by(e)} / ${e[1]?.data.fields.held_by}`, 'parked T-1, legacy_set T-1 / queue.mjs hold / T-2');
  e = run('drop', 'T-2');
  t('AC3 drop: moved out of the batch', `${shape(e)} / ${by(e)} / ${e[0]?.data.from}>${e[0]?.data.to}`, 'moved T-2 / queue.mjs drop / standing>null');
  // AC2: a command the pass runs as queue.mjs (its spawn's state=running write) names the pass.
  const at = log(f).length;
  const r = spawnSync(process.execPath, [join(B, 'queue.mjs'), 'set', 'T-1', 'state=running', 'session_id=s-9'], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: ON, DESK_QUEUE: f, DESK_LEDGER_BY: 'pass' } });
  e = since(f, at);
  t('AC2 a queue.mjs command run for the pass names the pass as the writer', `${r.status} ${shape(e)} / ${by(e)}`, '0 spawned T-1, legacy_set T-1 / pass');
  // Every typed event these commands appended is a legal transition when the log is read back.
  const illegal = [];
  reduce(log(f), null, { onIllegal: (ev, from) => illegal.push(`${ev.type} ${ev.key} from ${from}`) });
  t('AC3 the log they wrote reads back with no illegal transition', illegal.join(', '), '');
}

// A pass taking a running ticket back to triage, which no typed event does: the state is recorded with
// its other fields, never as an illegal triaged event.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A', { state: 'running', session_id: 's-1' }) } });
  const w = queueWriter(f);
  w.apply(['set', 'A', 'state=triaged', 'session_id=null']);
  w.flush();
  const evs = log(f).slice(1);
  t('running back to triaged is one legacy event holding the state', `${shape(evs)} ${evs[0]?.data.fields.state}`, 'legacy_set A triaged');
}

// A ticket archived in the log and admitted again is live in it again: admitted first, then its state.
{
  const dir = join(T, 'readmit');
  const file = join(dir, 'queue.json');
  const done = tk('M', { state: 'done', result: { pr: 4 } });
  recordWrite(file, { tickets: { M: done } }, { tickets: {} }, { by: 'pass', archived: { M: done } });
  t('the done ticket is archived in the log', fold(dir).tickets.M?.archived, true);
  const at = readLog(dir).events.length;
  recordWrite(file, { tickets: {} }, { tickets: { M: tk('M', { state: 'triaged' }) } }, { by: 'queue.mjs admit' });
  const evs = readLog(dir).events.slice(at);
  t('admitted again: admitted, then triaged', shape(evs.filter((x) => x.type !== 'legacy_set')), 'admitted M, triaged M');
  t('and the log holds it live, triaged', `${fold(dir).tickets.M.archived} ${fold(dir).tickets.M.state}`, 'false triaged');
}

// A ticket transferred to another batch arrives there as moved, naming both batches, and leaving this
// one records nothing more: the log already has it in the other.
{
  const dir = join(T, 'xfer');
  const standing = join(dir, 'queue.json');
  const named = join(dir, 'batches', 'E-2', 'queue.json');
  t('the standing and a named batch share the repo\'s log', `${ledgerTarget(standing).repoDir === ledgerTarget(named).repoDir} ${ledgerTarget(named).batch}`, 'true E-2');
  const was = { tickets: { X: tk('X'), Y: tk('Y') } };
  recordWrite(named, { tickets: {} }, { tickets: { X: tk('X', { moved_from: { batch: null, at: 'x' } }) } }, { by: 'queue.mjs transfer' });
  recordWrite(standing, was, { tickets: { Y: tk('Y') } }, { by: 'queue.mjs transfer' });
  const evs = readLog(dir).events;
  t('transfer: moved in from the standing batch; the standing batch seeded without it', shape(evs), 'moved X, legacy_set X, seeded Y');
  t('transfer: the moved event names both batches', `${evs[0].data.from}>${evs[0].data.to}`, 'standing>E-2');
}

// AC7: move-batch, either way it moves the queue, appends a moved event per ticket naming both batches.
{
  const HOME = join(T, 'mb-home');
  const DESK_HOME = join(T, 'mb-desk');
  const SLUG = 'acme__widgets';
  mkdirSync(HOME, { recursive: true });
  const env = { ...process.env, HOME, DESK_HOME, DESK_CONFIG: ON, DESK_REPO_OVERRIDE: 'acme/widgets', DESK_MACHINE: join(T, 'none.md'), DESK_MOVE_DRIVER_WAIT_MS: '5000' };
  delete env.DESK_REPO_DIR;
  const standingQ = join(DESK_HOME, 'repos', SLUG, 'queue.json');
  for (const [how, extra] of [['renamed whole', {}], ['written', { 'K-2': { images_dir: join(HOME, '.desk-autopilot', SLUG, 'images', 'K-2') } }]]) {
    rmSync(join(DESK_HOME, 'repos'), { recursive: true, force: true });
    rmSync(join(HOME, '.desk-autopilot'), { recursive: true, force: true });
    mkdirSync(dirname(standingQ), { recursive: true });
    write(standingQ, { version: 1, batch: '2026-10-12T07:29', base: 'feat/x', epic: 'E-1', supervised: true, concurrency: 2,
      tickets: { 'K-1': { key: 'K-1', state: 'triaged' }, 'K-2': { key: 'K-2', state: 'parked', park: { question: 'which colour?' }, ...extra['K-2'] } } });
    const r = spawnSync(process.execPath, [join(B, 'move-batch.mjs')], { encoding: 'utf8', env });
    const evs = readLog(join(DESK_HOME, 'repos', SLUG)).events;
    t(`AC7 (${how}) the batch moved`, `${r.status} ${existsSync(join(DESK_HOME, 'repos', SLUG, 'batches', 'E-1', 'queue.json'))}`, '0 true');
    t(`AC7 (${how}) the log is seeded, then a moved event per ticket`, shape(evs.filter((e) => e.type !== 'legacy_set')), 'seeded K-1, seeded K-2, moved K-1, moved K-2');
    t(`AC7 (${how}) each moved event names both batches, by move-batch`, [...new Set(evs.filter((e) => e.type === 'moved').map((e) => `${e.data.from}>${e.data.to} ${e.by.proc}`))].join(', '), 'standing>E-1 move-batch.mjs');
  }
}

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
