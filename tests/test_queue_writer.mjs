// suite: queue writer (a pass's changes in one locked, versioned write; done tickets archived)
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

const B = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-qw-');
for (const k of Object.keys(process.env)) if (k.startsWith('DESK_')) delete process.env[k];
writeFileSync(join(T, 'config.md'), '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n| Default branch | `main` |\n');
mkdirSync(join(T, 'home'));
execFileSync('git', ['init', '-q', join(T, 'repo')]);
Object.assign(process.env, { HOME: join(T, 'home'), DESK_CONFIG: join(T, 'config.md'), DESK_HOME: join(T, 'desk'), DESK_REPO_DIR: join(T, 'repo') });

const { queueWriter } = await import('../desk/bin/queue-writer.mjs');
const { versionOf, archivePath, mergeQueue, archivedOf } = await import('../desk/bin/queue-store.mjs');
const { readQueue, waitingOnMerge, batchIdle } = await import('../desk/bin/batch-state.mjs');

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const write = (f, q) => writeFileSync(f, `${JSON.stringify(q, null, 2)}\n`);
const tk = (key, more = {}) => ({ key, type: 'Task', lane: 'A', state: 'triaged', park: null, result: null, ...more });
let n = 0;
const fixture = (q) => { const f = join(T, `q${++n}`, 'queue.json'); mkdirSync(dirname(f)); write(f, q); return f; };
// Another writer: what queue.mjs does, read, change, save one version higher.
const other = (f, change) => { const q = read(f); change(q); q.version = versionOf(q) + 1; write(f, q); return q.version; };

// AC1: several tickets changed, one write of the file, one version higher.
{
  const f = fixture({ version: 4, batch: 'b', tickets: { A: tk('A'), B: tk('B'), C: tk('C') } });
  const w = queueWriter(f);
  w.apply(['set', 'A', 'lane=B']); w.apply(['park', 'B', 'why?']); w.apply(['set', 'C', 'stage=2/9']); w.apply(['set-batch', 'concurrency=2']);
  t('AC1 nothing is written while the changes are applied', read(f).version, 4);
  t('AC1 the pass reads its own changes before they are written', w.view().tickets.B.state, 'parked');
  const r = w.flush();
  const q = read(f);
  t('AC1 one write holds every change', [q.tickets.A.lane, q.tickets.B.park.question, q.tickets.C.stage, q.concurrency].join(' '), 'B why? 2/9 2');
  t('AC1 and is one version higher', `${r.version} ${q.version}`, '5 5');
  t('AC1 a flush with nothing new writes nothing', w.flush().wrote, false);
  t('AC1 a refused value writes nothing and says why', w.apply(['set', 'A', 'state=bogus']).why, 'bad state "bogus" (want: queued|triaged|running|parked|done|failed)');
}

// AC2: another writer's changes since the pass read the file stay beside the pass's own.
{
  const f = fixture({ version: 7, batch: 'b', tickets: { A: tk('A'), B: tk('B') } });
  const w = queueWriter(f);
  w.apply(['set', 'A', 'stage=3/9']);
  const theirs = other(f, (q) => { q.tickets.B.state = 'parked'; q.tickets.D = tk('D'); q.concurrency = 1; });
  const r = w.flush();
  const q = read(f);
  t('AC2 the file holds both writers\' changes', [q.tickets.A.stage, q.tickets.B.state, !!q.tickets.D, q.concurrency].join(' '), '3/9 parked true 1');
  t('AC2 its version is one higher than the other writer left it', `${theirs} ${q.version}`, '8 9');
  t('AC2 nothing is named as not written', r.conflicts.length, 0);
}

// AC3: both changed one field: the other writer's value stays, and the field is named.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A'), B: tk('B') } });
  const w = queueWriter(f);
  w.apply(['set', 'A', 'state=parked', 'stage=1/9']);
  w.apply(['set', 'B', 'lane=E']);
  other(f, (q) => { q.tickets.A.state = 'done'; q.tickets.A.updated_at = '2099-01-01T00:00:00.000Z'; });
  const r = w.flush();
  const q = read(f);
  t('AC3 the other writer\'s value stays', q.tickets.A.state, 'done');
  t('AC3 the pass\'s other fields are written', `${q.tickets.A.stage} ${q.tickets.B.lane}`, '1/9 E');
  t('AC3 the ticket and field not written are named, and updated_at is not one', JSON.stringify(r.conflicts), '[{"ticket":"A","field":"state"}]');
  // A ticket another writer took out takes none of the pass's changes, each named.
  w.apply(['set', 'B', 'stage=2/9']);
  other(f, (x) => { delete x.tickets.B; });
  const r2 = w.flush();
  t('AC3 a ticket another writer dropped stays dropped', 'B' in read(f).tickets, false);
  t('AC3 and its field is named', JSON.stringify(r2.conflicts.map((c) => [c.ticket, c.field, !!c.gone])), '[["B","stage",true]]');
}

// The spawn order the pass set is kept unless the other writer reordered too.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A'), B: tk('B'), C: tk('C') } });
  const w = queueWriter(f);
  w.apply(['front', 'C']);
  other(f, (q) => { q.tickets.D = tk('D'); });
  w.flush();
  t('the pass\'s front survives another writer\'s admit', Object.keys(read(f).tickets).join(''), 'CABD');
  const m = mergeQueue({ tickets: { A: {}, B: {} } }, { tickets: { B: {}, A: {} } }, { tickets: { B: {}, A: {}, C: {} } });
  t('the same reorder made by both is no conflict', `${Object.keys(m.result.tickets).join('')} ${m.conflicts[0]?.field}`, 'BAC undefined');
  const m2 = mergeQueue({ tickets: { A: {}, B: {}, C: {} } }, { tickets: { C: {}, A: {}, B: {} } }, { tickets: { B: {}, A: {}, C: {} } });
  t('two different reorders keep theirs and name the order', `${Object.keys(m2.result.tickets).join('')} ${m2.conflicts[0]?.field}`, 'BAC order');
}

// A set on a condition: made while it holds, left out when another writer changed the ticket first.
{
  const park = { question: 'Ship it?', inputs: { 'pr-head': 'h1' } };
  const still = (x) => x.state === 'parked' && x.park?.question === 'Ship it?';
  const f = fixture({ version: 1, batch: 'b', tickets: { A: tk('A', { state: 'parked', park }), B: tk('B', { state: 'parked', park }), C: tk('C', { state: 'parked', park }) } });
  const w = queueWriter(f);
  const requeue = (x) => { x.state = 'triaged'; x.park = null; };
  other(f, (q) => requeue(q.tickets.B));
  const b = w.apply(['set', 'B', 'park.inputs={"pr-head":"h2"}'], { when: still });
  t('a condition no longer met when applied writes nothing, and says so', `${b.ok} ${b.skipped}`, 'true true');
  t('a condition met applies the set', w.apply(['set', 'A', 'park.inputs={"pr-head":"h2"}'], { when: still }).skipped, undefined);
  w.apply(['set', 'C', 'park.inputs={"pr-head":"h2"}'], { when: still });
  other(f, (q) => requeue(q.tickets.C));
  const r = w.flush();
  const q = read(f);
  t('the met one is written', q.tickets.A.park.inputs['pr-head'], 'h2');
  t('a requeue before the set stands', `${q.tickets.B.state} ${q.tickets.B.park}`, 'triaged null');
  t('a requeue between the set and the write stands', `${q.tickets.C.state} ${q.tickets.C.park}`, 'triaged null');
  t('the write names it as skipped, not as lost to another writer', `${r.skipped.join(',')} ${r.conflicts.length}`, 'C 0');
  t('a condition on anything but set is refused', (() => { try { w.apply(['park', 'A', 'q'], { when: still }); return 'ran'; } catch (e) { return e.message; } })(), 'a condition applies only to set, not park');
  // Another writer changing only the state, leaving the park, still takes the set back.
  w.apply(['set', 'A', 'park.inputs={"pr-head":"h3"}'], { when: still });
  other(f, (x) => { x.tickets.A.state = 'triaged'; });
  w.flush();
  t('a state change alone takes back the conditional set', read(f).tickets.A.park.inputs['pr-head'], 'h2');
}

// DS-796: a condition sees the queue too, so a set that depends on another ticket's set is taken back
// with it: an owner dropped before its write lands leaves the other ticket unstamped.
{
  const f = fixture({ version: 1, batch: 'b', tickets: { O: tk('O', { state: 'done' }), S: tk('S', { state: 'done' }) } });
  const w = queueWriter(f);
  const live = (x) => x.state === 'done';
  const ownerTook = (x, cur) => live(x) && cur?.tickets?.O?.post_merge_read === 7;
  w.apply(['set', 'O', 'post_merge_read=7'], { when: live });
  t('a condition on another ticket holds once that ticket\'s set is applied', w.apply(['set', 'S', 'post_merge_read=7', 'post_merge_by=O'], { when: ownerTook }).skipped, undefined);
  other(f, (q) => { delete q.tickets.O; });
  const r = w.flush();
  const q = read(f);
  t('the owner dropped before the write takes its set back, and the set that named it with it', `${'O' in q.tickets} ${q.tickets.S.post_merge_read ?? null} ${q.tickets.S.post_merge_by ?? null} ${r.skipped.join(',')}`, 'false null null S');
  const w2 = queueWriter(f);
  t('nor is it applied while the ticket it names is gone', w2.apply(['set', 'S', 'post_merge_read=7'], { when: ownerTook }).skipped, true);
}

// AC5: the lock not taken within its wait: nothing written, every change named.
{
  const f = fixture({ version: 3, batch: 'b', tickets: { A: tk('A'), B: tk('B') } });
  const w = queueWriter(f, { waitMs: 150 });
  w.apply(['set', 'A', 'stage=2/9']); w.apply(['park', 'B', 'q']);
  const before = readFileSync(f, 'utf8');
  mkdirSync(`${f}.lock`); writeFileSync(join(`${f}.lock`, 'pid'), `${process.ppid}\n`);
  const r = w.flush();
  t('AC5 a lock held past the wait writes nothing', readFileSync(f, 'utf8') === before, true);
  t('AC5 it names the holder', r.ok === false && r.why.includes(`pid ${process.ppid}`), true);
  t('AC5 and every change not recorded', JSON.stringify(r.lost), '[["set","A","stage=2/9"],["park","B","q"]]');
  t('AC5 the pass no longer reads them as made', w.view().tickets.B.state, 'triaged');
  rmSync(`${f}.lock`, { recursive: true });
}

// AC6, AC7: done tickets whose PR merged or closed move to the archive; one still open stays.
{
  const f = fixture({ version: 2, batch: 'b', tickets: {
    M: tk('M', { state: 'done', result: { pr: 1 }, merged_at: '2026-11-16T10:00:00.000Z' }),
    X: tk('X', { state: 'done', result: { pr: 2 }, pr_status: { pr: 2, state: 'CLOSED' } }),
    O: tk('O', { state: 'done', result: { pr: 3 }, pr_status: { pr: 3, state: 'OPEN' } }),
    F: tk('F', { state: 'done', result: { pr: 4 }, merged_at: '2026-11-16T10:00:00.000Z', follow_on: ['run the migration'] }),
    H: tk('H', { state: 'done', result: { pr: 5 }, merged_at: '2026-11-16T10:00:00.000Z' }),
    W: tk('W', { state: 'parked', held_by: 'H', park: { question: 'held by orchestrator: blocked by H' } }),
    // Criteria its review left for after the merge: P's the pass has not made steps yet, Q's it has.
    P: tk('P', { state: 'done', result: { pr: 6 }, merged_at: '2026-11-16T10:00:00.000Z', pr_status: { pr: 6, state: 'MERGED', post_merge: [{ step: 'x' }] } }),
    Q: tk('Q', { state: 'done', result: { pr: 7 }, merged_at: '2026-11-16T10:00:00.000Z', pr_status: { pr: 7, state: 'MERGED', post_merge: [{ step: 'x' }] }, post_merge_read: 7 }),
    // Closed, and the pass still owes it a reopen whose retry was refused.
    R: tk('R', { state: 'done', result: { pr: 8 }, pr_status: { pr: 8, state: 'CLOSED' }, reopening: 8 }),
    A: tk('A'),
  } });
  const w = queueWriter(f);
  w.apply(['set', 'A', 'stage=1/9']);
  w.flush();
  t('a write before the pass\'s last archives nothing', 'M' in read(f).tickets, true);
  w.apply(['set', 'A', 'stage=2/9']);
  const r = w.flush({ archive: true });
  const q = read(f);
  const a = read(archivePath(f));
  t('AC6 the archive sits beside the queue', archivePath(f), join(dirname(f), 'queue.archive.json'));
  t('AC6 merged and closed tickets leave the live queue', `${'M' in q.tickets} ${'X' in q.tickets}`, 'false false');
  t('AC6 and are in the archive, with when', `${a.tickets.M.state} ${a.tickets.X.state} ${!!a.tickets.M.archived_at}`, 'done done true');
  t('AC6 the write says which moved', r.archived.join(','), 'M,X,Q');
  t('DS-785 a merged ticket whose post-merge criteria the pass has not made steps yet stays live; one it has is archived', `${'P' in q.tickets} ${'Q' in q.tickets}`, 'true false');
  t('AC7 a done ticket whose PR is open stays live', 'O' in q.tickets, true);
  t('DS-796 a closed PR still owed its reopen stays live, so the next pass retries it', 'R' in q.tickets, true);  t('a merged ticket with follow-on steps waiting stays live', 'F' in q.tickets, true);
  t('a merged ticket another ticket is held behind stays live', 'H' in q.tickets, true);

  // AC8: an archived ticket is still found by key, as done.
  const rq = readQueue(f);
  t('AC8 a queue read finds an archived ticket by key', rq.tickets.M?.state, 'done');
  t('AC8 and `in` finds it', 'X' in rq.tickets, true);
  t('AC8 but listing the tickets does not', Object.keys(rq.tickets).includes('M'), false);
  t('AC8 nor does writing the queue', JSON.stringify(rq).includes('"M"'), false);
  t('AC8 its archive reads beside it', Object.keys(archivedOf(rq)).sort().join(','), 'M,Q,X');
  rq.tickets.Y = tk('Y', { state: 'parked', held_by: 'M', park: { question: 'held by orchestrator: blocked by M' } });
  t('AC8 a hold on an archived merged ticket is waiting on a merge, not stuck', waitingOnMerge(rq, rq.tickets.Y), true);

  const env = { ...process.env, DESK_QUEUE: f, DESK_AUTOPILOT_STATE: join(dirname(f), 'state') };
  const qm = (...args) => spawnSync(process.execPath, [join(B, 'queue.mjs'), ...args], { encoding: 'utf8', env });
  t('AC8 queue.mjs get finds it, as done', JSON.parse(qm('get', 'M').stdout).state, 'done');
  const s = qm('set', 'M', 'lane=B');
  t('an archived ticket is not changed', s.status !== 0 && s.stderr.includes('M is done and archived'), true);
  const h = qm('hold', 'A', 'M');
  t('AC8 a hold behind an archived ticket finds it, and is kept for the merge driver to release', `${h.status} ${read(f).tickets.A.held_by}`, '0 M');  qm('add', 'M');
  t('admitting an archived ticket again starts it over', read(f).tickets.M?.state, 'queued');
  t('queue.mjs saves one version higher each time, and a refused command saves nothing', read(f).version, versionOf(q) + 2);
}

// A merged ticket still owed its post-merge steps keeps its batch from idling, so the pass that adds
// them still runs; once they are added, or for a PR that closed unmerged, the batch idles.
{
  const owedTk = (more) => tk('P', { state: 'done', result: { pr: 6 }, merged_at: '2026-11-16T10:00:00.000Z', pr_status: { pr: 6, state: 'MERGED', post_merge: [{ step: 'x' }] }, ...more });
  const idle = (t) => batchIdle({ tickets: { P: t } }, () => 'MERGED');
  t('DS-785 a batch whose merged ticket is owed its post-merge steps is not idle; once read, never merged, or requeued and parked (no pass reads it), it is',
    `${idle(owedTk({}))} ${idle(owedTk({ post_merge_read: 6 }))} ${idle(owedTk({ merged_at: null }))} ${idle(owedTk({ state: 'parked' }))}`, 'false true true true');
}

// A batch on a base, or an epic's, counts its finished children: it archives nothing.
{
  const f = fixture({ version: 1, batch: 'E-1', epic: 'E-1', base: 'feat/e', tickets: { M: tk('M', { state: 'done', result: { pr: 1 }, merged_at: 'x' }), A: tk('A') } });
  const w = queueWriter(f);
  w.apply(['set', 'A', 'stage=1/9']); w.flush({ archive: true });
  t('an epic batch archives nothing', `${'M' in read(f).tickets} ${existsSync(archivePath(f))}`, 'true false');
}

// AC9: a queue with no version number, from an older desk, is read as 0 and written with one.
{
  const f = fixture({ batch: 'b', tickets: { A: tk('A') } });
  t('AC9 no version reads as 0', versionOf(read(f)), 0);
  const w = queueWriter(f);
  w.apply(['set', 'A', 'stage=1/9']);
  t('AC9 the pass writes it as version 1', w.flush().version, 1);
  const g = fixture({ batch: 'b', tickets: { A: tk('A') } });
  spawnSync(process.execPath, [join(B, 'queue.mjs'), 'set', 'A', 'lane=B'], { env: { ...process.env, DESK_QUEUE: g } });
  t('AC9 queue.mjs writes it as version 1', read(g).version, 1);
}

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
