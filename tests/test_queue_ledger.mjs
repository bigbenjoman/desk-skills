// suite: queue ledger (with the ledger lever on, every queue write appends what it changed to the ticket ledger)
// layer: L2
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
const { recordWrite, ledgerTarget, STANDING, queueDifference, queueEvents } = await import('../desk/bin/queue-ledger.mjs');
const { ledgerLine } = await import('../desk/bin/pass/report.mjs');
const { failedField } = await import('../desk/bin/pass/shared.mjs');
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
  t('a batch the log has seen is not seeded again; the park is its parked event alone', shape(p), 'parked A');
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
  t('AC3 park: parked, the event carrying the park', `${shape(e)} / ${by(e)}`, 'parked T-1 / queue.mjs park');
  e = run('requeue', 'T-1');
  t('AC3 requeue: from its park to triage, requeued then triaged', `${read(f).tickets['T-1'].state} ${shape(e.filter((x) => x.type !== 'legacy_set'))} / ${by(e)}`, 'triaged requeued T-1, triaged T-1 / queue.mjs requeue');
  e = run('move', 'T-2', '1');
  t('AC3 move: placed', `${shape(e)} / ${by(e)} / ${e[0]?.data.fields.placed}`, 'legacy_set T-2 / queue.mjs move / true');
  e = run('hold', 'T-1', 'T-2');
  t('AC3 hold: parked, then held behind its blocker', `${shape(e)} / ${by(e)} / ${e[1]?.data.by} / ${'held_by' in (e[2]?.data.fields ?? {})}`, 'parked T-1, held T-1, legacy_set T-1 / queue.mjs hold / T-2 / false');
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

// DS-898: a worker spawned, failed and requeued, written as the pass writes each (queue.mjs for the
// spawn's state=running, the pass's writer for the failure): each is its own typed event.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A'), B: tk('B'), C: tk('C') } });
  const w = queueWriter(f);
  w.apply(['set', 'C', 'stage=1/9']);
  w.flush();
  const asPass = (...args) => spawnSync(process.execPath, [join(B, 'queue.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: ON, DESK_QUEUE: f, DESK_LEDGER_BY: 'pass' } });
  const running = (key, sid, port, more = []) => asPass('set', key, 'state=running', `session_id=${sid}`, `port=${port}`, `login=${JSON.stringify({ name: 'work', config_dir: '/x' })}`, 'resumes=null', ...more);
  const at = log(f).length;
  running('A', 's-A', 3231);
  running('B', 's-B', 3232);
  // The pass then crashes with a change applied and never flushed.
  w.apply(['set', 'C', 'stage=2/9']);
  const spawned = since(f, at).filter((e) => e.type === 'spawned');
  t('AC1 a spawn appends a spawned event with its login, port, worker and round',
    JSON.stringify(spawned[0]?.data), JSON.stringify({ worker: 's-A', round: 0, login: 'work', port: 3231 }));
  t('AC3 a pass that spawned two workers and crashed leaves both spawned events in the log', shape(spawned), 'spawned A, spawned B');

  // A resumed worker's round is how many times it was resumed.
  asPass('set', 'B', 'state=triaged', 'resume=pending');
  const atR = log(f).length;
  asPass('set', 'B', 'state=running', 'resumes=2', 'port=3233', 'resume=null');
  t('AC1 a resume\'s spawned event carries its round', since(f, atR).find((e) => e.type === 'spawned')?.data.round, 2);

  // The failure as markFailed writes it, with the subtype its session ended in.
  const w2 = queueWriter(f);
  const atF = log(f).length;
  w2.apply(['set', 'A', 'state=failed', failedField('exited with no marker', { subtype: 'error_max_budget_usd' })]);
  w2.flush();
  t('AC2 a failure appends a failed event with its session\'s subtype', JSON.stringify(since(f, atF).find((e) => e.type === 'failed')?.data), JSON.stringify({ subtype: 'error_max_budget_usd' }));

  const atQ = log(f).length;
  const rq = q(f, ON, 'requeue', 'A');
  t('AC4 a failed ticket requeued appends a requeued event', `${rq.status} ${shape(since(f, atQ).filter((e) => e.type !== 'legacy_set'))}`, '0 requeued A, triaged A');

  const d = queueDifference(f, { by: 'test' });
  t('AC5 after the spawns, the failure and the requeue the difference stays at zero', d.diffs.map((x) => x.path).join(', '), '');
}

// DS-896: a hold added and its blockers released, each as queue.mjs writes it, are held and released
// events, never a legacy event for held_by, and the queue rebuilt from them matches queue.json.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A'), B: tk('B'), C: tk('C') } });
  const at = () => log(f).length;
  const holdsIn = (evs) => evs.filter((e) => ['held', 'released'].includes(e.type)).map((e) => `${e.type} ${e.key} ${[e.data.by].flat().join('|')}`).join(', ');
  const legacyHeldBy = (evs) => evs.some((e) => e.type === 'legacy_set' && 'held_by' in e.data.fields);
  // The first write seeds the batch, so the hold's own events are those after it.
  q(f, ON, 'set', 'A', 'lane=B');
  let from = at();
  q(f, ON, 'hold', 'C', 'A', 'B');
  let e = since(f, from);
  t('AC5 a hold appends a held event naming its blockers in order', holdsIn(e), 'held C A|B');
  t('AC5 and no legacy event for them', legacyHeldBy(e), false);
  t('AC5 queue.json keeps held_by, and holds beside it as a list', `${read(f).tickets.C.held_by} ${JSON.stringify(read(f).tickets.C.holds)}`, 'A|B ["A","B"]');
  from = at();
  q(f, ON, 'set', 'C', 'held_by=B');
  e = since(f, from);
  t('AC6 a blocker released appends a released event naming it', holdsIn(e), 'released C A');
  t('AC6 and no legacy event for it', legacyHeldBy(e), false);
  from = at();
  q(f, ON, 'set', 'C', 'state=triaged', 'park=null', 'held_by=null');
  e = since(f, from);
  t('AC6 the last blocker released with the ticket\'s start', holdsIn(e), 'released C B');
  t('AC6 and no legacy event for it either', legacyHeldBy(e), false);
  t('AC7 after the holds were added and released the difference stays at zero', queueDifference(f, { by: 'test' }).diffs.map((x) => x.path).join(', '), '');
  // Blockers reordered is no add or release: it is recorded as the field, which a rebuild still matches.
  q(f, ON, 'hold', 'C', 'A', 'B');
  from = at();
  q(f, ON, 'set', 'C', 'held_by=B|A');
  e = since(f, from);
  t('blockers reordered are recorded as held_by itself', `${holdsIn(e)}/${legacyHeldBy(e)}`, '/true');
  t('and the difference still reads zero', queueDifference(f, { by: 'test' }).diffs.map((x) => x.path).join(', '), '');
  // Dropped while held behind A and B, then added again and held behind B alone: the blockers it had
  // before its drop are not kept, so the rebuild holds it behind B, as queue.json does.
  q(f, ON, 'drop', 'C');
  q(f, ON, 'add', 'C');
  q(f, ON, 'set', 'C', 'state=triaged');
  from = at();
  q(f, ON, 'hold', 'C', 'B');
  t('a ticket dropped and added again is held only by its new blocker', `${holdsIn(since(f, from))} ${read(f).tickets.C.held_by}`, 'held C B B');
  t('and the difference reads zero', queueDifference(f, { by: 'test' }).diffs.map((x) => x.path).join(', '), '');
}

// DS-896 AC5: a ticket new to the queue arrives with its blockers set. Where the log holds none for it,
// they are a held event; where it still holds some from a last stay, or was not read, they are held_by
// itself, which replaces those, never a held event added to them.
{
  const before = { version: 1, batch: 'b', tickets: { B: tk('B') } };
  const after = { ...before, tickets: { ...before.tickets, C: tk('C', { state: 'parked', held_by: 'B', park: { question: 'held by orchestrator: blocked by B — starts once their PRs merge', since: 'x' } }) } };
  const arrive = (logged) => {
    const evs = queueEvents(before, after, { batch: 'b', logged }).filter((e) => e.key === 'C');
    return `${evs.filter((e) => e.type === 'held').map((e) => e.data.by.join('|')).join() || 'none'} ${evs.find((e) => e.type === 'legacy_set')?.data.fields.held_by ?? 'no-field'}`;
  };
  t('DS-896 AC5 blockers a ticket new to the log arrives with are a held event, not its held_by field', arrive(() => []), 'B no-field');
  t('blockers the log still holds from a last stay: the arrival\'s are its held_by field', arrive(() => ['A']), 'none B');
  t('the log unread: the arrival\'s blockers are its held_by field', arrive(undefined), 'none B');
  const s = reduce(queueEvents(before, after, { batch: 'b', logged: () => [] }).filter((e) => e.key === 'C').map((e, i) => ({ ...e, seq: i + 1, id: `x${i + 1}` })));
  t('DS-896 AC5 and the log rebuilds it held behind them', `${JSON.stringify(s.tickets.C.holds)} ${s.tickets.C.state}`, '["B"] parked');
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
  // Archived again, then joining the queue done (an adopted PR): admitted, the state with the fields.
  recordWrite(file, { tickets: { M: tk('M', { state: 'triaged' }) } }, { tickets: {} }, { by: 'pass', archived: { M: done } });
  const at2 = readLog(dir).events.length;
  recordWrite(file, { tickets: {} }, { tickets: { M: done } }, { by: 'queue.mjs adopt' });
  t('joining done: admitted, then the done state as a field', `${shape(readLog(dir).events.slice(at2))} ${fold(dir).tickets.M.archived} ${fold(dir).tickets.M.state}`, 'admitted M, legacy_set M false done');
}

// A parked ticket set back to triage with its park kept: requeued, triaged, and the park laid back,
// so the log holds the park queue.json kept.
{
  const dir = join(T, 'keep-park');
  const file = join(dir, 'queue.json');
  const parked = tk('P', { state: 'parked', park: { question: 'which colour?', since: 'x' } });
  recordWrite(file, { tickets: { P: parked } }, { tickets: { P: parked } }, { by: 'pass' });
  const at = readLog(dir).events.length;
  recordWrite(file, { tickets: { P: parked } }, { tickets: { P: { ...parked, state: 'triaged' } } }, { by: 'queue.mjs set' });
  t('requeued, triaged, then the park it kept', `${shape(readLog(dir).events.slice(at))} ${fold(dir).tickets.P.park?.question} ${fold(dir).tickets.P.state}`, 'requeued P, triaged P, legacy_set P which colour? triaged');
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

// The difference check: queue.json against the queue rebuilt from the log, and the pass's line for it.
{
  const diff = (f, opts) => queueDifference(f, opts);
  const paths = (r) => r.diffs.map((d) => d.path).join(', ');
  const line = (check, missed = 0) => ledgerLine({ check, missed, queueBin: '/bin/queue.mjs' });

  // AC4: a running batch with no log is seeded from queue.json, and nothing differs.
  const f = fixture({ version: 3, batch: 'b', tickets: { A: tk('A'), B: tk('B', { state: 'queued', held_by: 'A' }) } });
  const seeded = diff(f, { seed: true, by: 'pass' });
  t('AC4 a batch the log has never named is seeded from queue.json', `${seeded.seeded} ${shape(log(f))} ${log(f)[0].by.proc}`, '2 seeded A, seeded B pass');
  t('AC4 and the difference reads zero', `${seeded.diffs.length} ${line(seeded)}`, '0 ledger: seeded the log from queue.json (2 ticket(s)); 0 field(s) differ between queue.json and the queue rebuilt from the log, 0 missed append(s) this pass');
  t('a batch the log has named is not seeded again', diff(f, { seed: true }).seeded, 0);

  // AC1: writes through the queue store leave nothing to report.
  const w = queueWriter(f);
  w.apply(['set', 'A', 'state=running', 'session_id=s-1', 'port=3231', 'stage=0/9', 'log_bytes=9']);
  w.apply(['park', 'B', 'which colour?']);
  w.flush();
  w.apply(['set', 'A', 'stage=3/9']);
  w.flush();
  const clean = diff(f);
  t('AC1 a queue that matches its log has no difference', `${clean.diffs.length} ${line(clean)}`, '0 null');

  // AC2: a field written to queue.json without going through the queue store is named, ticket and field.
  other(f, (x) => { x.tickets.A.lane = 'C'; x.tickets.B.park.question = 'which size?'; });
  const off = diff(f);
  t('AC2 each ticket field that differs is named', paths(off), 'A lane, B park.question');
  t('AC2 with both values', `${off.diffs[0].queue} ${off.diffs[0].rebuilt}`, '"C" "A"');
  t('AC2 the line names them and counts them', line(off), 'ledger: 2 field(s) differ between queue.json and the queue rebuilt from the log, 0 missed append(s) this pass: A lane, B park.question. See each with node /bin/queue.mjs rebuild');
  other(f, (x) => { x.tickets.A.updated_at = 'later'; x.tickets.A.idle_passes = 4; });
  t('a stamp is compared as set or not, and a pass\'s observation not at all', paths(diff(f)), 'A lane, B park.question');
  const ws = queueWriter(f);
  ws.apply(['set', 'A', 'spawned_at=2026-11-20T09:00:00.000Z']);
  ws.flush();
  t('a spawn time written through the store matches', paths(diff(f)), 'A lane, B park.question');
  other(f, (x) => { x.tickets.A.spawned_at = '2026-11-20T09:30:00.000Z'; });
  t('a spawn time is compared by its value', paths(diff(f)), 'A lane, A spawned_at, B park.question');
  other(f, (x) => { x.tickets.A.spawned_at = '2026-11-20T09:00:00.000Z'; });
  // The check holds the queue lock, as writers do: a held lock is waited on, then refused.
  lock(`${f}.lock`);
  let held;
  try { diff(f, { waitMs: 100 }); held = 'ran'; } catch (e) { held = /locked by pid/.test(e.message) ? 'refused' : e.message; }
  unlock(`${f}.lock`);
  t('the check waits on the queue lock, then refuses', held, 'refused');
  let gone;
  try { diff(join(dirname(f), 'missing', 'queue.json')); gone = 'ran'; } catch (e) { gone = /no queue to compare/.test(e.message) ? 'refused' : e.message; }
  t('a queue that does not read is a check that did not run', gone, 'refused');
  const many = { diffs: Array.from({ length: 12 }, (_, i) => ({ path: `T-${i} lane` })), seeded: 0 };
  t('only the first ten are named', line(many).endsWith('T-9 lane, and 2 more. See each with node /bin/queue.mjs rebuild'), true);
  t('a check that did not run says why', line({ error: 'boom' }), 'ledger: the difference check did not run (boom)');

  // AC6: the rebuild command writes the rebuilt queue beside queue.json and leaves queue.json as it was.
  const before = readFileSync(f, 'utf8');
  const r = q(f, ON, 'rebuild');
  const rebuilt = read(join(dirname(f), 'queue.rebuilt.json'));
  t('AC6 rebuild prints each differing field', `${r.status} ${r.stdout.split('\n')[0]}`, '0 A lane: queue.json "C", rebuilt "A"');
  t('AC6 and how many differ', r.stdout.includes(`wrote ${join(dirname(f), 'queue.rebuilt.json')}: 2 field(s) differ`), true);
  t('AC6 the rebuilt queue holds the log\'s values', `${rebuilt.tickets.A.lane} ${rebuilt.tickets.A.state} ${rebuilt.tickets.B.park.question}`, 'A running which colour?');
  t('AC6 queue.json is unchanged', readFileSync(f, 'utf8') === before, true);
  t('AC6 an unknown batch is refused', `${q(f, ON, 'rebuild', 'no-such').status}`, '11');
  // A named batch rebuilds from its own queue, whatever state the current one is in.
  const { batchPaths, repoSlug } = await import('../desk/bin/desk-env.mjs');
  const named = batchPaths(repoSlug(), 'R-1').queue;
  mkdirSync(dirname(named), { recursive: true });
  write(named, { version: 1, batch: 'R-1', tickets: { R: tk('R') } });
  const corrupt = join(T, 'corrupt', 'queue.json');
  mkdirSync(dirname(corrupt));
  writeFileSync(corrupt, '{ not json');
  const rn = q(corrupt, ON, 'rebuild', 'R-1');
  t('AC6 a corrupt current queue does not stop a named batch rebuilding', `${rn.status} ${rn.stdout.includes(`wrote ${join(dirname(named), 'queue.rebuilt.json')}`)}`, '0 true');

  // AC3: a pass archiving a done ticket leaves the difference at zero: it is on neither side.
  const g = fixture({ version: 1, batch: 'b', tickets: { M: tk('M', { state: 'done', result: { pr: 4 } }), A: tk('A') } });
  const wg = queueWriter(g);
  t('an archiving write with nothing pending and nothing to archive writes nothing', wg.flush({ archive: true }).wrote, false);
  other(g, (x) => { x.tickets.M.merged_at = '2026-11-20T10:00:00.000Z'; });
  const ra = queueWriter(g).flush({ archive: true });
  t('AC3 an archiving write with nothing else pending archives the done ticket, and nothing differs', `${ra.wrote} ${ra.archived.join(' ')} ${diff(g).diffs.length}`, 'true M 0');

  // AC5: a write that missed its append: the field it changed differs, and the line counts the miss.
  lock(ledgerPaths(dirname(g)).lock);
  wg.apply(['set', 'A', 'stage=2/9']);
  const rm = wg.flush();
  unlock(ledgerPaths(dirname(g)).lock);
  const missed = diff(g);
  t('AC5 the fields the missed append held differ, its first stamp among them', `${!!rm.ledgerMissed} ${paths(missed)}`, 'true A stage, A updated_at');
  t('AC5 and the line counts the missed append', line(missed, 1).startsWith('ledger: 2 field(s) differ between queue.json and the queue rebuilt from the log, 1 missed append(s) this pass: A stage, A updated_at'), true);
}

// DS-895 AC4: a worker's park taken in with the write it awaits approval of, as the pass takes it in (the
// park, then its round and its park's other fields, in one write): one parked event carrying its kind and
// that payload verbatim, and no legacy event holding the park.
{
  const j = JSON.stringify;
  const f = fixture({ version: 1, batch: 'b', tickets: { W: tk('W', { state: 'running', session_id: 's-W' }), S: tk('S', { state: 'running', session_id: 's-S' }), Q: tk('Q', { open_questions: 3 }) } });
  queueDifference(f, { seed: true, by: 'pass' });
  const at = log(f).length;
  const approve = { kind: 'jira-comment', target: 'W', body: 'Root cause: x.\nThe fix: y.\n\n(W/desk-ticket)' };
  const w = queueWriter(f);
  w.apply(['park', 'W', 'awaiting approval: the Jira comment. Not reached: the transition']);
  w.apply(['set', 'W', 'last_round={"stage":"8/9"}']);
  w.apply(['set', 'W', 'park.inputs={}', 'park.clears_when={"kind":"none"}', `park.approve=${j(approve)}`]);
  w.flush();
  const evs = since(f, at);
  const p = evs.find((e) => e.type === 'parked');
  t('DS-895 AC4 the park is one parked event, then the other fields', shape(evs), 'parked W, legacy_set W');
  t('DS-895 AC4 with its kind and the payload awaiting approval, verbatim', `${p?.data.kind} ${j(p?.data.approve)}`, `question ${j(approve)}`);
  t('DS-895 AC4 and no legacy event holds the park', evs.some((e) => e.type === 'legacy_set' && 'park' in e.data.fields), false);
  t('DS-895 AC4 the log\'s park is queue.json\'s', j(fold(dirname(f)).tickets.W.park) === j(read(f).tickets.W.park), true);

  // AC7: a stop's park, and triage questions answered one at a time: the rebuild still matches.
  w.apply(['park', 'S', '--kind', 'stopped', 'its worker was stopped; it starts once you let it']);
  w.flush();
  q(f, ON, 'set', 'Q', 'open_questions=2', 'answered_questions=["which size?"]');
  q(f, ON, 'set', 'Q', 'open_questions=1', 'answered_questions=["which size?","which colour?"]');
  t('DS-895 AC7 a stop is a parked event of kind stopped', log(f).find((e) => e.type === 'parked' && e.key === 'S')?.data.kind, 'stopped');
  t('DS-895 AC7 each answer is an answered event naming its question', j(log(f).filter((e) => e.type === 'answered').map((e) => e.data.qid)), j(['which size?', 'which colour?']));
  t('DS-895 AC7 and no legacy event holds the answered list', log(f).some((e) => e.type === 'legacy_set' && 'answered_questions' in e.data.fields), false);
  const d = queueDifference(f);
  t('DS-895 AC7 after parks, a stop and answers, nothing differs and the pass prints no difference line',
    `${d.diffs.map((x) => x.path).join(', ')}|${ledgerLine({ check: d, missed: 0, queueBin: '/bin/queue.mjs' })}`, '|null');
}

// DS-901: the deadline sweep's waits (pass/deadlines.mjs), as the pass writes them: one waiting event as a
// wait starts and again as it is escalated, one waited event as it ends, and the rebuild still matches.
{
  const j = JSON.stringify;
  const f = fixture({ version: 1, batch: 'b', tickets: { D: tk('D', { state: 'done', result: { pr: 801 } }), H: tk('H', { handoff: 'pending', handoff_stage: '4b' }) } });
  queueDifference(f, { seed: true, by: 'pass' });
  const at = log(f).length;
  const merge = { since: '2026-11-20T10:00:00.000Z', deadline: '2026-11-20T10:30:00.000Z', escalate_to: 'person', pr: 801 };
  const hand = { since: '2026-11-20T10:00:00.000Z', deadline: '2026-11-20T10:15:00.000Z', escalate_to: 'requeue', stage: '4b' };
  const w = queueWriter(f);
  w.apply(['set', 'D', `waits=${j({ mergeability: merge })}`]);
  w.apply(['set', 'H', `waits=${j({ handoff: hand })}`]);
  w.flush();
  const started = since(f, at);
  // Beside each, the write's stamp, which every write records with its other fields.
  const stampOnly = (evs) => evs.filter((e) => e.type === 'legacy_set').every((e) => j(Object.keys(e.data.fields)) === '["updated_at"]');
  t('AC6 a wait starting is a waiting event', shape(started), 'waiting D, legacy_set D, waiting H, legacy_set H');
  t('AC6 with its start, deadline and escalation', j(started[0].data), j({ ...merge, on: 'mergeability' }));
  t('AC6 and no legacy event holds the waits, only the write\'s stamp', `${log(f).some((e) => e.type === 'legacy_set' && 'waits' in e.data.fields)} ${stampOnly(started)}`, 'false true');
  const at2 = log(f).length;
  w.apply(['set', 'H', `waits=${j({ handoff: { ...hand, escalated: '2026-11-20T10:16:00.000Z' } })}`]);
  w.flush();
  t('the escalation recorded on a wait is a waiting event carrying it', `${shape(since(f, at2))} ${since(f, at2)[0]?.data.escalated}`, 'waiting H, legacy_set H 2026-11-20T10:16:00.000Z');
  const at3 = log(f).length;
  w.apply(['set', 'D', 'waits=null']);
  w.apply(['set', 'H', 'waits=null', 'handoff=null', 'state=running', 'session_id=s-H']);
  w.flush();
  const ended = since(f, at3);
  t('AC7 a wait ending is a waited event naming what it waited on', j(ended.filter((e) => e.type === 'waited').map((e) => [e.key, e.data.on])), j([['D', 'mergeability'], ['H', 'handoff']]));
  t('AC7 with the spawn that ended the handoff', shape(ended), 'waited D, legacy_set D, spawned H, waited H, legacy_set H');
  t('AC7 and no legacy event holds the waits', ended.some((e) => e.type === 'legacy_set' && 'waits' in e.data.fields), false);
  t('the log reads no illegal transition, a done ticket\'s wait included', readLog(dirname(f)).illegal.length, 0);
  const d = queueDifference(f);
  t('AC8 with waits started, escalated and ended, nothing differs and the pass prints no difference line',
    `${d.diffs.map((x) => x.path).join(', ')}|${ledgerLine({ check: d, missed: 0, queueBin: '/bin/queue.mjs' })}`, '|null');
  w.apply(['set', 'D', `waits=${j({ mergeability: { ...merge, since: '2026-11-20T11:00:00.000Z' } })}`]);
  w.flush();
  t('AC8 a wait open at the check matches too', queueDifference(f).diffs.length, 0);
  const at4 = log(f).length;
  w.apply(['set', 'D', 'waits=soon']);
  w.flush();
  t('a waits field that is no map of waits is recorded as the field', `${shape(since(f, at4))} ${since(f, at4)[0]?.data.fields.waits}`, 'legacy_set D soon');
  t('and still matches', queueDifference(f).diffs.length, 0);
}

// DS-902 AC7: workers that made progress and stalled, as the advance step and the deadline sweep write
// them pass after pass: progress_at and progress_sha are never appended, the progress wait is, and the
// rebuild still matches with no difference line.
{
  const j = JSON.stringify;
  const { nextWaits } = await import('../desk/bin/pass/deadlines.mjs');
  // Seeded as a live queue's tickets are, each with the stamp every write sets.
  const running = (key) => tk(key, { state: 'running', stage: '3/9', updated_at: '2026-11-20T09:00:00.000Z' });
  const f = fixture({ version: 1, batch: 'b', tickets: { M: running('M'), S: running('S') } });
  queueDifference(f, { seed: true, by: 'pass' });
  const from = log(f).length;
  const w = queueWriter(f);
  const at = (mins) => new Date(Date.parse('2026-11-20T10:00:00.000Z') + mins * 60000).toISOString();
  // One pass at `mins`: the advance step's progress for each worker that moved, then the sweep's waits.
  const pass = (mins, moved) => {
    for (const k of moved) w.apply(['set', k, `progress_at=${at(mins + 0.5)}`, `progress_sha=${j({ head: 'a'.repeat(40), pushed: `${mins}`.padStart(40, '0') })}`]);
    w.flush();
    for (const k of ['M', 'S']) {
      const tq = read(f).tickets[k];
      const { waits } = nextWaits(tq, at(mins));
      const open = Object.keys(waits).length ? waits : null;
      if (j(open) !== j(tq.waits ?? null)) w.apply(['set', k, `waits=${j(open)}`]);
    }
    w.flush();
  };
  pass(0, ['M', 'S']);
  pass(10, ['M']);
  pass(20, ['M']);
  pass(50, []);
  pass(60, ['S']);
  pass(70, ['M']);
  const evs = since(f, from);
  t('AC7 progress_at and progress_sha are never appended', evs.some((e) => e.type === 'legacy_set' && ('progress_at' in e.data.fields || 'progress_sha' in e.data.fields)), false);
  t('AC7 the progress waits are, the stalled one\'s escalation, the end of each wait at progress, and the wait after it',
    j(evs.filter((e) => /^wait/.test(e.type)).map((e) => `${e.type} ${e.key}${e.data.escalated ? ' escalated' : ''}`)),
    j(['waiting S', 'waiting M', 'waiting S escalated', 'waited S', 'waited M', 'waiting S']));
  t('AC7 the log reads no illegal transition', readLog(dirname(f)).illegal.length, 0);
  const d = queueDifference(f);
  t('AC7 the rebuild matches and the pass prints no difference line',
    `${d.diffs.map((x) => x.path).join(', ')}|${ledgerLine({ check: d, missed: 0, queueBin: '/bin/queue.mjs' })}`, '|null');
}

// DS-903: the batch's red base, as the pass records it (pass/base-gate.mjs decideBaseRed): one base_red
// batch event as it starts, none as it is escalated, one base_green as it clears, and the rebuild matches.
{
  const j = JSON.stringify;
  const f = fixture({ version: 1, batch: 'b', tickets: { D: tk('D', { state: 'done', result: { pr: 813 } }) } });
  queueDifference(f, { seed: true, by: 'pass' });
  const rec = { branch: 'main', check: 'tests', since: '2026-11-20T10:00:00.000Z', deadline: '2026-11-20T11:00:00.000Z', merges: [{ pr: 802, ticket: 'T-2' }, { pr: 801, ticket: null }] };
  const w = queueWriter(f);
  const at = log(f).length;
  w.apply(['set-batch', `base_red=${j(rec)}`]);
  w.flush();
  const started = since(f, at);
  t('AC5 a red base starting is one base_red batch event with no ticket', j(started.map((e) => [e.type, e.key])), j([['base_red', null]]));
  t('AC5 carrying its check, start, deadline and merges', j(started[0]?.data), j({ check: rec.check, since: rec.since, deadline: rec.deadline, merges: rec.merges }));
  const at2 = log(f).length;
  w.apply(['set-batch', `base_red=${j({ ...rec, escalated: '2026-11-20T11:05:00.000Z' })}`]);
  w.flush();
  t('its escalation appends nothing', since(f, at2).length, 0);
  const at3 = log(f).length;
  w.apply(['set-batch', 'base_red=null']);
  w.flush();
  t('AC6 a red base clearing is one base_green batch event with no ticket', j(since(f, at3).map((e) => [e.type, e.key])), j([['base_green', null]]));
  t('and the fold holds no red base for the batch', fold(dirname(f)).batches.b?.base_red, undefined);
  const d = queueDifference(f);
  t('AC7 with the base gone red and green, nothing differs and the pass prints no difference line',
    `${d.diffs.map((x) => x.path).join(', ')}|${ledgerLine({ check: d, missed: 0, queueBin: '/bin/queue.mjs' })}`, '|null');
}

// DS-904: the batch's platform outage, as the pass records it (pass/fix-tries.mjs decideOutage): one
// platform_outage batch event as it starts, none as it is escalated, one platform_clear as it clears.
{
  const j = JSON.stringify;
  const f = fixture({ version: 1, batch: 'b', tickets: { D: tk('D', { state: 'done', result: { pr: 814 } }) } });
  queueDifference(f, { seed: true, by: 'pass' });
  const rec = { check: '"Deploy preview"', since: '2026-11-22T10:00:00.000Z', deadline: '2026-11-22T12:00:00.000Z' };
  const w = queueWriter(f);
  const at = log(f).length;
  w.apply(['set-batch', `platform_outage=${j(rec)}`]);
  w.flush();
  const started = since(f, at);
  t('AC6 an outage starting is one platform_outage batch event with no ticket', j(started.map((e) => [e.type, e.key])), j([['platform_outage', null]]));
  t('AC6 carrying its check, start and deadline', j(started[0]?.data), j(rec));
  const at2 = log(f).length;
  w.apply(['set-batch', `platform_outage=${j({ ...rec, escalated: '2026-11-22T12:05:00.000Z' })}`]);
  w.flush();
  t('its escalation appends nothing', since(f, at2).length, 0);
  const at3 = log(f).length;
  w.apply(['set-batch', 'platform_outage=null']);
  w.flush();
  t('AC7 an outage clearing is one platform_clear batch event with no ticket', j(since(f, at3).map((e) => [e.type, e.key])), j([['platform_clear', null]]));
  t('and the fold holds no outage for the batch', fold(dirname(f)).batches.b?.platform_outage, undefined);
  const d = queueDifference(f);
  t('AC8 with an outage started and cleared, nothing differs and the pass prints no difference line',
    `${d.diffs.map((x) => x.path).join(', ')}|${ledgerLine({ check: d, missed: 0, queueBin: '/bin/queue.mjs' })}`, '|null');
}

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
