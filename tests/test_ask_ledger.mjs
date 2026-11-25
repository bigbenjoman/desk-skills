// suite: ask ledger (each ask put to the person or the decider, raised, presented, answered and acted on, in the ticket ledger)
// layer: L2
// covers: desk/bin/ask-ledger.mjs desk/bin/ticket-ledger.mjs desk/bin/queue-ledger.mjs desk/bin/answer.mjs
// The writers in process against fixture queues whose ledgers sit beside them, with the ledger lever on
// and off; queue.mjs rebuild and answer.mjs as processes in the same scratch state.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

const B = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-askledger-');
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k) || k === 'CLAUDE_CODE_SESSION_ID') delete process.env[k];
const REPO = '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n| Default branch | `main` |\n';
const LEVERS = '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `ledger` |\n';
const ON = join(T, 'config-on.md');
const OFF = join(T, 'config-off.md');
writeFileSync(ON, `${REPO}${LEVERS}`);
writeFileSync(OFF, REPO);
mkdirSync(join(T, 'home'));
// answer.mjs runs queue.mjs from desk's bin: this checkout's.
mkdirSync(join(T, 'desk'));
symlinkSync(B, join(T, 'desk', 'bin'));
spawnSync('git', ['init', '-q', join(T, 'repo')]);
Object.assign(process.env, { HOME: join(T, 'home'), DESK_CONFIG: ON, DESK_HOME: join(T, 'desk'), DESK_CONFIG_ROOT: join(T, 'cfg'), DESK_REPO_DIR: join(T, 'repo'), DESK_REPO_ROOT: join(T, 'repo') });

const A = await import('../desk/bin/ask-ledger.mjs');
const { fold, read: readLog, ledgerPaths, project } = await import('../desk/bin/ticket-ledger.mjs');
const { lock, unlock } = await import('../desk/bin/dir-lock.mjs');
const { queueDifference } = await import('../desk/bin/queue-ledger.mjs');

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = JSON.stringify;
const write = (f, q) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(q, null, 2)}\n`); };
const log = (f) => { const p = ledgerPaths(dirname(f)).events; return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
let n = 0;
const fixture = (q) => { const f = join(T, `q${++n}`, 'queue.json'); write(f, q); return f; };
const SINCE = '2026-11-20T10:00:00.000Z';
const parkedQ = (key = 'P-1', since = SINCE, more = {}) => ({ version: 1, batch: 'b', tickets: { [key]: { key, lane: 'A', state: 'parked', park: { kind: 'question', question: 'which copy?', since }, ...more } } });

t('an ask is its ticket and its park\'s since', A.askId('P-1', SINCE), `P-1:${SINCE}`);

// Each step written once, under an id fixed by the ask and the step, and folded onto the ticket's asks.
{
  const f = fixture(parkedQ());
  const at = (s) => ({ now: new Date(`2026-11-20T10:${s}.000Z`), by: 'test' });
  const lines = [
    ...A.askRaised(f, { key: 'P-1', since: SINCE, question: 'which copy?' }, at('00:30')),
    ...A.askPresented(f, { key: 'P-1', since: SINCE, via: 'decider', ref: 'run-1' }, at('01:00')),
    ...A.askAnswered(f, { key: 'P-1', since: SINCE, by: 'person', session: null, at: '2026-11-20T10:15:30.000Z' }, at('15:31')),
    ...A.askActed(f, { key: 'P-1', since: SINCE, round: 2 }, at('20:00')),
  ];
  t('a write that succeeds reports nothing', j(lines), '[]');
  const ask = `P-1:${SINCE}`;
  t('each step is an event under its own id', j(log(f).map((e) => [e.type, e.id])),
    j([['ask_raised', `ask:${ask}:raised`], ['ask_presented', `ask:${ask}:presented:decider`], ['ask_answered', `ask:${ask}:answered`], ['ask_acted', `ask:${ask}:acted`]]));
  t('in the standing batch of the queue\'s repo', j([...new Set(log(f).map((e) => `${e.batch} ${e.key}`))]), '["standing P-1"]');
  t('latency is the answer\'s time less the park\'s since', log(f)[2]?.data?.latency_s, 930);
  t('the answer is dated when it was given', log(f)[2]?.at, '2026-11-20T10:15:30.000Z');
  t('an answer with no session still records, its session null', j([log(f)[2]?.data?.by, log(f)[2]?.data?.session]), '["person",null]');
  t('a park with no kind is read from its question', log(f)[0]?.data?.kind, 'question');
  t('the blocking flag is null until a writer knows it', log(f)[0]?.data?.blocking, null);
  const asks = A.readAsks(fold(dirname(f)));
  t('readAsks lists the ask with its ticket and batch', j(asks.map((a) => [a.key, a.batch, a.ask])), j([['P-1', 'standing', ask]]));
  t('with each step it took', j([asks[0]?.raised_at, asks[0]?.presented?.map((p) => `${p.via} ${p.ref}`), asks[0]?.answered?.latency_s, asks[0]?.acted?.round]),
    j(['2026-11-20T10:00:30.000Z', ['decider run-1'], 930, 2]));

  // A retry writes nothing twice, and a second answerer is not written over the first.
  const before = (existsSync(ledgerPaths(dirname(f)).events) ? readFileSync(ledgerPaths(dirname(f)).events, 'utf8') : '');
  const again = [
    ...A.askRaised(f, { key: 'P-1', since: SINCE, kind: 'question' }),
    ...A.askPresented(f, { key: 'P-1', since: SINCE, via: 'decider', ref: 'run-2' }),
    ...A.askAnswered(f, { key: 'P-1', since: SINCE, by: 'decider' }),
    ...A.askActed(f, { key: 'P-1', since: SINCE, round: 3 }),
  ];
  t('a retry of every step reports nothing', j(again), '[]');
  t('and writes nothing to the log the first writes made', before !== '' && (existsSync(ledgerPaths(dirname(f)).events) ? readFileSync(ledgerPaths(dirname(f)).events, 'utf8') : '') === before, true);
  A.askPresented(f, [{ key: 'P-1', since: SINCE, via: 'digest', ref: '/d/page.md', notification: 'digest:2026-11-20T17:00' }]);
  t('a presentation another way is written beside the first', j(A.readAsks(fold(dirname(f)))[0]?.presented?.map((p) => [p.via, p.notification])),
    j([['decider', null], ['digest', 'digest:2026-11-20T17:00']]));
  t('so is a park parked again, a new ask', A.askRaised(f, { key: 'P-1', since: '2026-11-21T09:00:00.000Z', kind: 'question' }).length + A.readAsks(fold(dirname(f))).length, 2);
}

// Latency: never below zero, and null where the since does not read as a time.
{
  const f = fixture(parkedQ());
  A.askAnswered(f, [
    { key: 'L-1', since: SINCE, by: 'person', at: '2026-11-20T09:59:00.000Z' },
    { key: 'L-2', since: 'not a time', by: 'default', at: SINCE },
    { key: 'L-3', since: SINCE, by: 'decider', at: new Date('2026-11-21T10:00:00.400Z') },
  ]);
  t('an answer stamped before its since is 0 s late; an unreadable since gives no latency; a day is 86,400 s',
    j(log(f).map((e) => e.data?.latency_s)), '[0,null,86400]');
  t('a step with no since is no ask\'s, and is not written', A.askRaised(f, { key: 'L-4', since: null, kind: 'question' }).length + log(f).length, 3);
}

// The events leave the queue's projection, its diff against queue.json and queue.mjs rebuild unchanged.
{
  const f = fixture(parkedQ('R-1', SINCE, { added_at: 'x' }));
  const first = queueDifference(f, { seed: true });
  const rebuild = () => spawnSync(process.execPath, [join(B, 'queue.mjs'), 'rebuild'], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: ON, DESK_QUEUE: f } });
  const r0 = rebuild();
  const rebuilt0 = readFileSync(join(dirname(f), 'queue.rebuilt.json'), 'utf8');
  const projected = j(project(fold(dirname(f)), 'standing', JSON.parse(readFileSync(f, 'utf8'))));
  A.recordAsks(f, [
    { step: 'raised', key: 'R-1', since: SINCE, kind: 'question' },
    { step: 'presented', key: 'R-1', since: SINCE, via: 'push', ref: 'urgent:x:R-1', notification: 'urgent:x:R-1' },
    { step: 'answered', key: 'R-1', since: SINCE, by: 'person', at: '2026-11-20T11:00:00.000Z' },
    { step: 'acted', key: 'R-1', since: SINCE, round: 1 },
  ]);
  // Each check names the four steps it was made with, so none passes on a log that holds none of them.
  const steps = log(f).filter((e) => e.type.startsWith('ask_')).length;
  t('with all four steps in the log, the projection is unchanged', j([steps, project(fold(dirname(f)), 'standing', JSON.parse(readFileSync(f, 'utf8')))]), j([4, JSON.parse(projected)]));
  t('so is the difference with queue.json', j([steps, queueDifference(f).diffs]), j([4, first.diffs]));
  const r1 = rebuild();
  t('and queue.mjs rebuild says and writes the same', j([steps, r1.status, r1.stdout, readFileSync(join(dirname(f), 'queue.rebuilt.json'), 'utf8')]), j([4, r0.status, r0.stdout, rebuilt0]));
  t('none of the steps is an illegal transition from the ticket\'s state', j([steps, readLog(dirname(f)).illegal]), j([4, []]));
}

// With the ledger lever off nothing is written and nothing fails; a failed write is a line, never a throw.
{
  const f = fixture(parkedQ());
  const off = A.askRaised(f, { key: 'P-1', since: SINCE, kind: 'question' }, { on: false });
  process.env.DESK_CONFIG = OFF;
  const offCfg = [...A.askAnswered(f, { key: 'P-1', since: SINCE, by: 'person' }), ...A.askActed(f, { key: 'P-1', since: SINCE, round: 1 })];
  process.env.DESK_CONFIG = ON;
  const made = existsSync(ledgerPaths(dirname(f)).dir);
  A.askRaised(f, { key: 'P-1', since: SINCE, kind: 'question' });
  t('lever off, as on: false or in the config: nothing reported and no ledger made, where the lever on writes the same step',
    j([off, offCfg, made, log(f).map((e) => e.type)]), j([[], [], false, ['ask_raised']]));
  lock(ledgerPaths(dirname(f)).lock);
  let thrown = null, out;
  try { out = A.askAnswered(f, { key: 'P-1', since: SINCE, by: 'person' }, { waitMs: 50 }); } catch (e) { thrown = e.message; }
  unlock(ledgerPaths(dirname(f)).lock);
  t('a held ledger lock fails the write without a throw, saying what was not recorded, and why', thrown === null && out?.length === 1 && out[0].startsWith('ask ledger: P-1\'s ask_answered could not be added to the ticket ledger (') && out[0].includes('locked by pid'), true);
  t('nothing was written for it', log(f).map((e) => e.type).join(), 'ask_raised');
  writeFileSync(join(T, 'a-file'), 'x');
  t('a ledger that cannot be made is a line too', A.askActed({ repoDir: join(T, 'a-file'), batch: 'b' }, { key: 'P-1', since: SINCE, round: 1 }).length, 1);
  t('as is a step no writer knows', A.recordAsks(f, [{ step: 'forgotten', key: 'P-1', since: SINCE }])[0]?.startsWith('ask ledger: P-1\'s ask_forgotten could not be added'), true);
}

// A named batch's queue writes into the repo's one ledger, under that batch's name; another repo's lever
// is read from that repo's config.
{
  const named = join(T, 'desk', 'repos', 'acme__y', 'batches', 'B-7', 'queue.json');
  write(named, parkedQ('Y-1'));
  A.askRaised(named, { key: 'Y-1', since: SINCE, kind: 'question' });
  const ev = log(join(T, 'desk', 'repos', 'acme__y', 'queue.json'))[0];
  t('a named batch\'s ask goes to the repo\'s ledger, under the batch', `${ev?.batch} ${ev?.key}`, 'B-7 Y-1');
  mkdirSync(join(T, 'cfg', 'repos', 'acme__y'), { recursive: true });
  writeFileSync(join(T, 'cfg', 'repos', 'acme__y', 'config.md'), `${REPO}${LEVERS}`);
  t('another repo\'s lever is read from its own config: on there, off with none', j([A.ledgerOnIn('acme__y'), A.ledgerOnIn('acme__none')]), '[true,false]');
}

// answer.mjs: the person's answer to a park answers its ask, in the session named where one is; the
// decider's take is the decider's; a "not now" answers nothing.
{
  const answer = (q, args, env = {}) => {
    const f = fixture(q);
    const state = join(dirname(f), 'state');
    mkdirSync(state, { recursive: true });
    const r = spawnSync(process.execPath, [join(B, 'answer.mjs'), ...args], { cwd: join(T, 'repo'), encoding: 'utf8', env: { ...process.env, DESK_QUEUE: f, DESK_AUTOPILOT_STATE: state, ...env } });
    return { r, ev: log(f).filter((e) => e.type === 'ask_answered') };
  };
  const p = answer(parkedQ('N-1'), ['N-1', 'the short copy']);
  t('an answer to a park, with no session id, records the person\'s answer', j([p.r.status, p.ev.length, p.ev[0]?.data?.by, p.ev[0]?.data?.session, p.ev[0]?.data?.ask]), j([0, 1, 'person', null, `N-1:${SINCE}`]));
  t('its latency runs from the park\'s since to the answer', p.ev[0]?.data?.latency_s, Math.round((Date.parse(p.ev[0]?.at) - Date.parse(SINCE)) / 1000));
  const s = answer(parkedQ('N-2'), ['N-2', 'the long copy'], { CLAUDE_CODE_SESSION_ID: 'sess-42' });
  t('an answer from a session names it', s.ev[0]?.data?.session, 'sess-42');
  const d = answer(parkedQ('N-3', SINCE, { park: { kind: 'question', question: 'Merge as foundation (recommended), or split?', since: SINCE } }),
    ['--taken', 'N-3', '{"question":"Merge as foundation, or split?","options":["Merge as foundation","Split"],"chose":"Merge as foundation","category":"scope"}']);
  t('a taken call is the decider\'s answer', j([d.r.status, d.ev[0]?.data?.by]), j([0, 'decider']));
  // Beside an answer that does record (p), so none of these passes where nothing ever records.
  const none = [answer(parkedQ('N-4'), ['N-4', 'not now']), answer({ version: 1, batch: 'b', tickets: { 'N-5': { key: 'N-5', state: 'triaged', open_questions: 1 } } }, ['N-5', 'yes']), answer(parkedQ('N-6'), ['N-6', 'yes'], { DESK_CONFIG: OFF })];
  t('a "not now", an answer to a ticket not parked, and an answer with the lever off each record no ask, and still exit 0',
    j([p.ev.length, ...none.map((o) => `${o.r.status} ${o.ev.length}`)]), j([1, '0 0', '0 0', '0 0']));
}

console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
