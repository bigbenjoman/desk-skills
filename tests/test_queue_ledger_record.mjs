// suite: queue ledger record mode (with the ledger and ledger-record levers on, the log is written first and queue.json restored from it)
// layer: L2
// The pass's writer and queue-store in process, queue.mjs as a process, each against a fixture queue
// whose ledger sits beside it; the levers are set through DESK_LEVERS, which desk-env reads first.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

const B = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-qrecord-');
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete process.env[k];
const CFG = join(T, 'config.md');
writeFileSync(CFG, '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n| Default branch | `main` |\n');
mkdirSync(join(T, 'home'));
execFileSync('git', ['init', '-q', join(T, 'repo')]);
Object.assign(process.env, { HOME: join(T, 'home'), DESK_CONFIG: CFG, DESK_HOME: join(T, 'desk'), DESK_REPO_DIR: join(T, 'repo'), DESK_REPO_ROOT: join(T, 'repo') });
const RECORD = 'ledger ledger-record';
const levers = (v) => { process.env.DESK_LEVERS = v; };

const { queueWriter } = await import('../desk/bin/queue-writer.mjs');
const { writeQueueFile, LedgerRefusal } = await import('../desk/bin/queue-store.mjs');
const { read: readLog, append } = await import('../desk/bin/ticket-ledger.mjs');
const { recordMode, restoreQueue, queueDifference, recordWrite, STANDING } = await import('../desk/bin/queue-ledger.mjs');
const { recordLine } = await import('../desk/bin/pass/report.mjs');

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const write = (f, q) => writeFileSync(f, `${JSON.stringify(q, null, 2)}\n`);
const tk = (key, more = {}) => ({ key, type: 'Task', lane: 'A', state: 'triaged', park: null, result: null, ...more });
let n = 0;
const fixture = (q) => { const f = join(T, `q${++n}`, 'queue.json'); mkdirSync(dirname(f)); write(f, q); return f; };
const log = (f) => readLog(dirname(f)).events;
const shape = (evs) => evs.map((e) => `${e.type} ${e.key}`).join(', ');
const queueCmd = (f, lv, ...args) => spawnSync(process.execPath, [join(B, 'queue.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, DESK_QUEUE: f, DESK_LEVERS: lv } });

// AC6: the record lever alone is ignored, and the pass's report says it needs the ledger lever.
levers('ledger-record');
t('AC6 ledger-record without ledger is off and ignored', recordMode(), { on: false, ignored: true });
t('AC6 the report says it needs the ledger lever', /ledger-record lever is ignored: it needs the ledger lever/.test(recordLine({ restore: null, ignored: true })), true);
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A') } });
  writeQueueFile(f, read(f), { by: 'test' });
  t('AC6 and a write appends nothing and records no log position', [log(f).length, read(f).ledger_seq], [0, undefined]);
}
levers(RECORD);
t('both levers on is record mode', recordMode(), { on: true, ignored: false });
levers('none');
t('neither lever is off', recordMode(), { on: false, ignored: false });

// AC5: with the ledger lever on and the record lever off, queue.json is written first, as in shadow mode.
levers('ledger');
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A') } });
  let seen = null;
  writeQueueFile(f, { ...read(f), tickets: { A: tk('A', { lane: 'B' }) } }, { by: 'test', onLedger: () => { seen = read(f).tickets.A.lane; } });
  t('AC5 in shadow mode the log hears the write after queue.json holds it', seen, 'B');
  t('AC5 and records no log position', read(f).ledger_seq, undefined);
}

// AC1: in record mode the log gains the event before queue.json changes, and queue.json then matches
// the queue rebuilt from the log.
levers(RECORD);
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A'), B: tk('B', { state: 'queued' }) } });
  let lane = null;
  writeQueueFile(f, { ...read(f), tickets: { ...read(f).tickets, A: tk('A', { lane: 'B' }) } }, { by: 'test', onLedger: () => { lane = read(f).tickets.A.lane; } });
  t('AC1 the log is appended while queue.json still holds the old value', lane, 'A');
  t('AC1 the batch is seeded, then the change appended', shape(log(f)), 'seeded A, seeded B, legacy_set A');
  t('AC1 queue.json records the log position it holds', read(f).ledger_seq, log(f).at(-1).seq);
  t('AC1 queue.json matches the queue rebuilt from the log', queueDifference(f).diffs, []);

  const w = queueWriter(f);
  w.apply(['set', 'A', 'state=running', 'session_id=s-1', 'port=3231']);
  w.apply(['park', 'B', 'which colour?']);
  const r = w.flush();
  t('AC1 a pass write is typed events, in the log first', [r.ok, shape(log(f).slice(3))], [true, 'spawned A, legacy_set A, parked B']);
  t('AC1 and still matches the rebuild', queueDifference(f).diffs, []);
  t('fields still written as legacy events are kept, and counted', [read(f).tickets.A.port, r.ledgerLegacy], [3231, 1]);
}

// AC3: a done ticket started running without a requeue is refused, naming its state and the event, and
// neither the log nor queue.json changes.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { D: tk('D', { state: 'done', result: { pr: 7 } }) } });
  writeQueueFile(f, read(f), { by: 'test' });
  const logBefore = log(f).length;
  const fileBefore = readFileSync(f, 'utf8');
  const r = queueCmd(f, RECORD, 'set', 'D', 'state=running', 'session_id=s-9');
  t('AC3 queue.mjs set refuses it', r.status !== 0, true);
  t('AC3 naming the ticket, its state and the event', /spawned for D is illegal from its current state done/.test(r.stderr), true);
  t('AC3 neither the log nor queue.json changes', [log(f).length, readFileSync(f, 'utf8') === fileBefore], [logBefore, true]);

  const w = queueWriter(f);
  w.apply(['set', 'D', 'state=running', 'session_id=s-9']);
  const fr = w.flush();
  t('AC3 the pass\'s writer reports the refusal and writes nothing', [fr.ok, /illegal from its current state done/.test(fr.why), fr.lost.length], [false, true, 1]);
  t('AC3 and neither file changes', [log(f).length, readFileSync(f, 'utf8') === fileBefore], [logBefore, true]);

  let threw = null;
  try { writeQueueFile(f, { ...read(f), tickets: { D: { ...read(f).tickets.D, state: 'running', session_id: 's-9' } } }, { by: 'test' }); } catch (e) { threw = e; }
  t('AC3 writeQueueFile throws a LedgerRefusal', threw instanceof LedgerRefusal, true);

  const ok = queueCmd(f, RECORD, 'requeue', 'D');
  t('a requeue first is not refused', ok.status === 0 ? read(f).tickets.D.state : ok.stderr, 'triaged');
  const sh = queueCmd(f, 'ledger', 'set', 'D', 'state=done');
  const shadow = queueCmd(f, 'ledger', 'set', 'D', 'state=running', 'session_id=s-9');
  t('in shadow mode the same write is made, as before', [sh.status, shadow.status, read(f).tickets.D.state], [0, 0, 'running']);
}

// AC4: a crash after the log was written but before queue.json: the next pass's restore lays the
// missing change on queue.json, keeping its order and projection-only fields.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A'), B: tk('B', { pr_status: { pr: 3, state: 'OPEN' } }) } });
  writeQueueFile(f, read(f), { by: 'test' });
  const stale = read(f);
  const after = { ...structuredClone(stale), tickets: { ...structuredClone(stale.tickets), B: { ...stale.tickets.B, lane: 'C' } } };
  t('the crashed write is in the log', recordWrite(f, stale, after, { by: 'test', mode: 'record' }).appended, 1);
  t('AC4 queue.json lacks it', read(f).tickets.B.lane, 'A');
  const r = restoreQueue(f);
  t('AC4 the restore finds queue.json behind and names the ticket', [r.restored, r.tickets], ['behind', ['B']]);
  t('AC4 queue.json gains the missing change', read(f).tickets.B.lane, 'C');
  t('AC4 keeping its order and its projection-only fields', [Object.keys(read(f).tickets), read(f).tickets.B.pr_status], [['A', 'B'], { pr: 3, state: 'OPEN' }]);
  t('AC4 and its log position moves on', read(f).ledger_seq, log(f).at(-1).seq);
  t('the report names what was restored', recordLine({ restore: r, ignored: false }), 'ledger: queue.json was behind the log, so it was rebuilt from it: B');
  t('a second restore has nothing to do', restoreQueue(f).restored, null);
  t('and nothing to report', recordLine({ restore: restoreQueue(f), ignored: false }), null);

  // A write worked out from the stale copy, after a crash, is refused until the restore has run.
  const g = fixture({ version: 1, batch: 'b', tickets: { A: tk('A', { held_by: 'X' }), X: tk('X'), Y: tk('Y') } });
  writeQueueFile(g, read(g), { by: 'test' });
  const old = read(g);
  recordWrite(g, old, { ...old, tickets: { ...old.tickets, A: { ...old.tickets.A, held_by: 'Y' } } }, { by: 'test', mode: 'record' });
  const logged = log(g).length;
  let threw = null;
  try { writeQueueFile(g, { ...read(g), tickets: { ...read(g).tickets, A: { ...read(g).tickets.A, held_by: null } } }, { by: 'test' }); } catch (e) { threw = e; }
  t('a write over a queue.json behind the log is refused, saying why', [threw instanceof LedgerRefusal, /queue.json is behind the ticket ledger/.test(threw?.message)], [true, true]);
  t('and neither the log nor queue.json changes', [log(g).length, read(g).tickets.A.held_by, read(g).ledger_seq], [logged, 'X', old.ledger_seq]);
  restoreQueue(g);
  t('the restore lays the crashed change on', read(g).tickets.A.held_by, 'Y');
  writeQueueFile(g, { ...read(g), tickets: { ...read(g).tickets, A: { ...read(g).tickets.A, held_by: null } } }, { by: 'test' });
  t('so the same write is then made, and the rebuild agrees', [read(g).tickets.A.held_by, queueDifference(g).diffs], [null, []]);
}

// The first record-mode write over a queue written in shadow mode stamps it with the log's position
// first, so a crash between its append and its write is still restored.
{
  levers('ledger');
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A') } });
  writeQueueFile(f, read(f), { by: 'test' });
  levers(RECORD);
  try { writeQueueFile(f, { ...read(f), tickets: { A: tk('A', { lane: 'C' }) } }, { by: 'test', onLedger: () => { throw new Error('crash'); } }); } catch { /* the crash */ }
  t('a crash in the first record-mode write leaves queue.json stamped, without the change', [Number.isInteger(read(f).ledger_seq), read(f).tickets.A.lane], [true, 'A']);
  t('so the next restore lays the change on', [restoreQueue(f).restored, read(f).tickets.A.lane], ['behind', 'C']);

  // A refused first record-mode write leaves queue.json as it was, unstamped.
  levers('ledger');
  const g = fixture({ version: 1, batch: 'b', tickets: { D: tk('D', { state: 'done', result: { pr: 7 } }) } });
  writeQueueFile(g, read(g), { by: 'test' });
  const fileBefore = readFileSync(g, 'utf8');
  const r = queueCmd(g, RECORD, 'set', 'D', 'state=running', 'session_id=s-9');
  t('AC3 on a queue written before record mode, the refusal leaves queue.json byte for byte', [r.status !== 0, readFileSync(g, 'utf8') === fileBefore], [true, true]);

  // A write outside record mode drops the log position, so a later record-mode period starts afresh.
  levers(RECORD);
  writeQueueFile(f, read(f), { by: 'test' });
  levers('ledger');
  writeQueueFile(f, { ...read(f), tickets: { A: { ...read(f).tickets.A, lane: 'D' } } }, { by: 'test' });
  t('a shadow write drops ledger_seq', read(f).ledger_seq, undefined);
  levers(RECORD);
  t('so record mode back on leaves that queue as it is', [restoreQueue(f).restored, read(f).tickets.A.lane], [null, 'D']);
}

// An append that fails in record mode writes nothing: queue.json is never ahead of the log.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A') } });
  writeQueueFile(f, read(f), { by: 'test' });
  const fileBefore = readFileSync(f, 'utf8');
  const held = join(dirname(f), 'ledger', '.lock');
  mkdirSync(held);
  writeFileSync(join(held, 'pid'), `${process.pid}\n`);
  let threw = null;
  try { writeQueueFile(f, { ...read(f), tickets: { A: tk('A', { lane: 'C' }) } }, { by: 'test' }); } catch (e) { threw = e; }
  rmSync(held, { recursive: true });
  t('a failed append refuses the write, saying why', [threw instanceof LedgerRefusal, /could not be appended to/.test(threw?.message)], [true, true]);
  t('and queue.json is unchanged', readFileSync(f, 'utf8') === fileBefore, true);
}

// The pass's own auto-merge lines in the log leave queue.json as it is; a restore changes only the
// tickets the log has moved on, keeping any other queue.json holds.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A', { state: 'running' }), B: tk('B') } });
  writeQueueFile(f, read(f), { by: 'test' });
  append(dirname(f), [{ type: 'automerge_armed', batch: STANDING, key: 'A', data: { by: 'session', pr: 4, head_sha: 'abc1234', line: 0 } }], { by: 'pass' });
  const fileBefore = readFileSync(f, 'utf8');
  t('an auto-merge line leaves queue.json as it is', [restoreQueue(f).restored, readFileSync(f, 'utf8') === fileBefore], [null, true]);
  writeQueueFile(f, { ...read(f), tickets: { ...read(f).tickets, B: tk('B', { lane: 'B' }) } }, { by: 'test' });
  t('and a write after it is made', read(f).tickets.B.lane, 'B');
  const stale = read(f);
  write(f, { ...stale, tickets: { ...stale.tickets, Z: tk('Z') } });
  recordWrite(f, stale, { ...stale, tickets: { ...stale.tickets, B: { ...stale.tickets.B, lane: 'C' } } }, { by: 'test', mode: 'record' });
  const r = restoreQueue(f);
  t('a restore names only the ticket the log moved on', [r.restored, r.tickets], ['behind', ['B']]);
  t('and keeps a ticket only queue.json holds', [read(f).tickets.B.lane, Object.keys(read(f).tickets)], ['C', ['A', 'B', 'Z']]);
}

// AC2: queue.json deleted; the next pass rebuilds it from the log with every live ticket's state,
// holds, park and merge record, and the report says so.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A'), H: tk('H'), P: tk('P'), M: tk('M', { state: 'done', result: { pr: 9 } }) } });
  writeQueueFile(f, read(f), { by: 'test' });
  const w = queueWriter(f);
  w.apply(['set', 'H', 'held_by=A']);
  w.apply(['park', 'P', 'which colour?']);
  w.flush();
  const m = queueCmd(f, RECORD, 'merged', 'M', '2026-11-20T10:00:00.000Z', '--pr', '9', '--by', 'merge-driver', '--head-sha', 'abc1234', '--base', 'main');
  t('a merge is recorded', m.status, 0);
  const want = read(f).tickets;
  rmSync(f);
  const r = restoreQueue(f);
  const got = read(f).tickets;
  t('AC2 queue.json is rebuilt', [r.restored, r.tickets.length], ['missing', 4]);
  t('AC2 every live ticket\'s state', Object.values(got).map((x) => `${x.key}=${x.state}`), Object.values(want).map((x) => `${x.key}=${x.state}`));
  t('AC2 its holds', [got.H.held_by, got.H.holds], ['A', ['A']]);
  t('AC2 its park', got.P.park.question, 'which colour?');
  t('AC2 its merge record', got.M.merge, want.M.merge);
  t('AC2 the report says it was rebuilt', /queue.json was missing, so it was rebuilt from the log \(4 ticket\(s\)\)/.test(recordLine({ restore: r, ignored: false })), true);
  t('AC2 and names no batch name, which only queue.json held', Object.hasOwn(read(f), 'batch'), false);
  t('AC2 and is marked rebuilt until a person clears it', read(f).rebuilt_from_log?.tickets, 4);
  t('a later restore keeps the mark', [restoreQueue(f).restored, read(f).rebuilt_from_log?.tickets], [null, 4]);
  writeFileSync(f, '{ torn');
  let threw = null;
  try { restoreQueue(f); } catch (e) { threw = e; }
  t('a queue.json that does not read is left as it is, and the restore says so', [/does not read as a queue/.test(threw?.message), readFileSync(f, 'utf8')], [true, '{ torn']);
  t('a batch the log has never named is not rebuilt', (() => { const g = join(T, 'empty', 'queue.json'); mkdirSync(dirname(g)); return restoreQueue(g).restored; })(), null);
}

// A queue written before record mode has no log position: the restore leaves it as it is.
{
  levers('ledger');
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A') } });
  writeQueueFile(f, read(f), { by: 'test' });
  append(dirname(f), [{ type: 'legacy_set', batch: STANDING, key: 'A', data: { fields: { lane: 'Z' } } }], { by: 'test' });
  levers(RECORD);
  t('a shadow-written queue is not restored', [restoreQueue(f).restored, read(f).tickets.A.lane], [null, 'A']);
}

console.log(fails ? `\n${fails} failure(s)` : '\nall passed');
process.exit(fails ? 1 : 0);
