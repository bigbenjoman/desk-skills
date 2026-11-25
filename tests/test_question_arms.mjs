// suite: question arms (how a handed-on ask reaches the person, by its ticket's question-handling arm)
// layer: L1
// covers: desk/bin/question-arms.mjs desk/bin/lever-pin.mjs desk/bin/decider.mjs desk/bin/ask-ledger.mjs
// The module in process against fixture queues, their ledgers and scratch batch state folders: which
// handed-on asks each arm pushes, reconciled each tick, quiet hours, an ask a digest listed first, the
// push register the digest reads, and when a recommended call applies by default at a check-in. With
// the lever off for a ticket, nothing changes.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scratch } from './scratch.mjs';

const T = scratch('desk-question-arms-');
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete process.env[k];
mkdirSync(join(T, 'home'));
const CONFIG = join(T, 'config.md');
writeFileSync(CONFIG, '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `ledger` |\n');
Object.assign(process.env, { HOME: join(T, 'home'), DESK_CONFIG: CONFIG, DESK_CONFIG_ROOT: join(T, 'cfg') });
const QA = await import('../desk/bin/question-arms.mjs');
const { handItems } = await import('../desk/bin/decider.mjs');
const { recordAsks } = await import('../desk/bin/ask-ledger.mjs');
const { queueDifference } = await import('../desk/bin/queue-ledger.mjs');

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const SINCE = '2026-11-25T09:00:00.000Z';
// Local times: afternoon is outside quiet hours, 23:00 inside them.
const DAY = new Date(2026, 10, 25, 14, 0);
const NIGHT = new Date(2026, 10, 25, 23, 0);
const pin = (arm) => (arm ? { levers: { set: arm === 'batched' ? [] : ['question-handling'], values: { 'question-handling': arm }, at: SINCE } } : {});
const parked = (key, arm, question = `${key}: which layout?`) => ({ key, state: 'parked', lane: 'C', park: { kind: 'question', question, since: SINCE }, ...pin(arm) });
const item = (key) => ({ id: `parked-${key}`, ticket: key, kind: 'parked', text: `${key}: which layout?`, since: SINCE });
const queue = (...tickets) => ({ version: 1, batch: 'b', tickets: Object.fromEntries(tickets.map((x) => [x.key, x])) });
const running = (key, more = {}) => ({ key, state: 'running', lane: 'A', ...more });
let n = 0;
// A batch: its state folder and its queue file, the ledger beside it named, and `keys` handed on at `at`.
const batch = (q, keys, at = new Date(2026, 10, 25, 13, 0)) => {
  const state = join(T, `state${++n}`);
  const file = join(T, `q${n}`, 'queue.json');
  mkdirSync(state, { recursive: true });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(q));
  queueDifference(file, { seed: true });
  handItems(state, keys.map((k) => ({ item: item(k), why: 'test' })), at);
  return { state, file };
};
const due = (b, q, now = DAY) => QA.duePushes(b.state, q, { queue: b.file, slug: 'acme__widgets', now }).map((p) => p.key.split(':')[2]);

// ---- the raised ask: its arm and blocking flag only where the lever is on, whichever path raises it --
const P = { kind: 'question', question: 'which layout?' };
t('lever off: the raised step is as it was, with no arm or flag', QA.raised(item('A'), P, queue(parked('A'), running('R'))), { step: 'raised', kind: 'question', question: 'which layout?' });
t('on, with another ticket running and none held behind it: not blocking', QA.raised(item('A'), P, queue(parked('A', 'mixed'), running('R'))), { step: 'raised', kind: 'question', question: 'which layout?', arm: 'mixed', blocking: false });
t('a ticket held behind it: blocking', QA.raised(item('A'), P, queue(parked('A', 'batched'), running('R'), { key: 'H', state: 'queued', held_by: 'A' })).blocking, true);
t('a finished ticket once held behind it does not count', QA.raised(item('A'), P, queue(parked('A', 'batched'), running('R'), { key: 'H', state: 'done', held_by: 'A' })).blocking, false);
t('nothing else running: blocking', QA.raised(item('A'), P, queue(parked('A', 'one-at-a-time'), { key: 'Q', state: 'queued' })).blocking, true);
const qr = queue(parked('A', 'batched'), running('R'));
t('raised from the ticket itself (the digest, the pass) carries the same arm and flag', QA.raisedOf(qr.tickets.A, qr), { step: 'raised', key: 'A', since: SINCE, kind: 'question', question: 'A: which layout?', arm: 'batched', blocking: false });
t('and none with the lever off', Object.keys(QA.raisedOf(parked('A'), queue(parked('A')))).sort(), ['key', 'kind', 'question', 'since', 'step']);

// ---- which handed-on asks each arm pushes ---------------------------------------------------------
{
  const q = queue(parked('OFF'), parked('B', 'batched'), running('R'));
  const b = batch(q, ['OFF', 'B']);
  t('lever off and batched: nothing due', due(b, q), []);
  t('and no push register is written', existsSync(join(b.state, 'ask-pushes.json')), false);
}
{
  const q = queue(parked('O', 'one-at-a-time'), parked('M', 'mixed'), parked('MB', 'mixed'), { key: 'H', state: 'queued', held_by: 'MB' },
    parked('PB', 'one-at-a-time', 'PRODUCTION BROKEN: checkout fails'), parked('NH', 'one-at-a-time'), running('R'));
  const b = batch(q, ['O', 'M', 'MB', 'PB']);
  const first = QA.duePushes(b.state, q, { queue: b.file, slug: 'acme__widgets', now: DAY });
  t('one-at-a-time and a blocking mixed ask handed on are due, each with its question', first.map((p) => [p.key, p.text]), [
    [`ask:acme__widgets:O:${SINCE}`, 'O: O: which layout?'],
    [`ask:acme__widgets:MB:${SINCE}`, 'MB: MB: which layout?'],
  ]);
  t('a production-broken park is the pass\'s to push, a park never handed on is not, nor a mixed one blocking nothing', ['PB', 'NH', 'M'].some((k) => due(b, q).includes(k)), false);
  t('not yet sent, the same asks are due again the next tick', due(b, q), ['O', 'MB']);
  t('a register write that fails is a report line, not a throw', (() => {
    mkdirSync(join(b.state, 'ask-pushes.json'));
    try { return QA.markPushed(b.state, [first[0]], { queue: b.file, now: DAY }).some((l) => l.startsWith('question-handling: O pushed, but not recorded')); } catch { return 'threw'; }
  })(), true);
  const b2 = batch(q, ['O', 'MB']);
  QA.markPushed(b2.state, [first[0]], { queue: b2.file, now: DAY });
  t('once sent, it is kept as pushed by its ask id', [...QA.pushedAsks(b2.state)], [`O:${SINCE}`]);
  t('and no longer due; one not yet sent still is', due(b2, q), ['MB']);
  mkdirSync(join(b2.state, 'briefings'), { recursive: true });
  writeFileSync(join(b2.state, 'briefings', 'MB.md'), `## Answer from the user (${new Date(2026, 10, 25, 13, 30).toISOString()})\n\nthe wide one\n`);
  t('an ask answered since it was handed on is not pushed', due(b2, q), []);
  const settled = queue(parked('O', 'one-at-a-time'), { ...parked('MB', 'mixed'), state: 'queued', park: null }, running('R'));
  t('nor one whose park is gone', due(batch(settled, ['MB']), settled), []);
}

// ---- an ask a check-in digest listed first is not pushed --------------------------------------------
{
  const q = queue(parked('O', 'one-at-a-time'), parked('P', 'one-at-a-time'), running('R'));
  const b = batch(q, ['O', 'P']);
  recordAsks(b.file, [{ step: 'presented', key: 'O', since: SINCE, via: 'digest', ref: 'page.md' }], { on: true, now: DAY });
  t('the digest presented O: only P is pushed', due(b, q), ['P']);
}

// ---- quiet hours, 22:00 to 08:00: nothing pushed until they end, unless a digest lists it first -----
{
  const q = queue(parked('O', 'one-at-a-time'), running('R'));
  const b = batch(q, ['O'], new Date(2026, 10, 25, 22, 30));
  t('handed on at night: nothing due', due(b, q, NIGHT), []);
  t('due once quiet hours end at 08:00', due(b, q, new Date(2026, 10, 26, 8, 0)), ['O']);
  recordAsks(b.file, [{ step: 'presented', key: 'O', since: SINCE, via: 'digest', ref: 'page.md' }], { on: true, now: new Date(2026, 10, 26, 7, 59) });
  t('unless the digest listed it first', due(b, q, new Date(2026, 10, 26, 8, 0)), []);
}

// ---- a recommended call applies by default at the check-in after a digest listed it, on batched only --
{
  const TIMES = ['08:00', '17:00'];
  const since = new Date(2026, 10, 25, 7, 55).toISOString();
  const tk = (arm) => ({ ...parked('D', arm), park: { kind: 'question', question: 'Two columns or one?', since } });
  const call = (o = {}) => ({ question: 'Two columns or one?', options: ['two columns', 'one column'], chose: 'two columns', category: 'design', ...o });
  // Listed by the 08:00 digest; the next check-in is 17:00.
  const listed = () => new Map([[`D:${since}`, new Date(2026, 10, 25, 8, 0).toISOString()]]);
  const at = (h, m = 0) => new Date(2026, 10, 25, h, m);
  const deflt = (arm, d = call(), now = at(17, 5), presented = listed) => QA.defaultsAtCheckin(tk(arm), d, { times: TIMES, presented, now });
  t('batched, listed by a digest and the next check-in passed: it applies', deflt('batched'), true);
  t('parked at 07:55, never listed by a digest: the 08:00 pass does not apply it', deflt('batched', call(), at(8, 0), () => new Map()), false);
  t('listed at 08:00: not before the next check-in', deflt('batched', call(), at(16, 59)), false);
  t('lever off: never', deflt(null), false);
  t('one-at-a-time and mixed: never', ['one-at-a-time', 'mixed'].map((a) => deflt(a)), [false, false]);
  t('a product call never defaults', deflt('batched', call({ category: 'product' })), false);
  t('a call that spends money never defaults', deflt('batched', call({ question: 'Upgrade the plan, at $20 a month?', options: ['upgrade', 'stay'], chose: 'upgrade' })), false);
  t('a call about who owns something never defaults', deflt('batched', call({ question: 'Who owns the onboarding copy?', options: ['design', 'growth'], chose: 'design' })), false);
  t('no check-in times: never', QA.defaultsAtCheckin(tk('batched'), call(), { times: null, presented: listed, now: at(17, 5) }), false);
  t('the worker is told the digest listed it first', /The check-in digest listed it and nobody answered it by the next check-in, so desk applied it by default/.test(QA.defaultAnswer(call())), true);
  const logged = QA.defaultCall(call(), 'D', '2026-11-25T17:05:00.000Z');
  t('the logged call says how to reverse it', /listed it and nobody answered by the next check-in, so desk applied the recommendation by default at 2026-11-25T17:05:00.000Z\. To reverse it, override it here with one column, then answer D with that choice\.$/.test(logged.question), true);
  t('and keeps the call itself', [logged.chose, logged.category, logged.options], ['two columns', 'design', ['two columns', 'one column']]);
}

if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all checks passed');
