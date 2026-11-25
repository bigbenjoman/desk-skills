// suite: question arms (how a handed-on ask reaches the person, by its ticket's question-handling arm)
// layer: L1
// covers: desk/bin/question-arms.mjs desk/bin/lever-pin.mjs
// The module in process against fixture queues and a scratch batch state folder: which asks each arm
// pushes, quiet hours, and the push register the digest reads. With the lever off for a ticket,
// nothing changes.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';

const T = scratch('desk-question-arms-');
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete process.env[k];
mkdirSync(join(T, 'home'));
Object.assign(process.env, { HOME: join(T, 'home'), DESK_CONFIG_ROOT: join(T, 'cfg') });
const QA = await import('../desk/bin/question-arms.mjs');

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
const stateDir = () => { const d = join(T, `state${++n}`); mkdirSync(d); return d; };
const P = { kind: 'question', question: 'which layout?' };

// ---- the raised ask: its arm and blocking flag only where the lever is on --------------------------
t('lever off: the raised step is as it was, with no arm or flag', QA.raised(item('A'), P, queue(parked('A'), running('R'))), { step: 'raised', kind: 'question', question: 'which layout?' });
t('on, with another ticket running and none held behind it: not blocking', QA.raised(item('A'), P, queue(parked('A', 'mixed'), running('R'))), { step: 'raised', kind: 'question', question: 'which layout?', arm: 'mixed', blocking: false });
t('a ticket held behind it: blocking', QA.raised(item('A'), P, queue(parked('A', 'batched'), running('R'), { key: 'H', state: 'queued', held_by: 'A' })).blocking, true);
t('a finished ticket once held behind it does not count', QA.raised(item('A'), P, queue(parked('A', 'batched'), running('R'), { key: 'H', state: 'done', held_by: 'A' })).blocking, false);
t('nothing else running: blocking', QA.raised(item('A'), P, queue(parked('A', 'one-at-a-time'), { key: 'Q', state: 'queued' })).blocking, true);

// ---- which handed-on asks each arm pushes ---------------------------------------------------------
{
  const s = stateDir();
  const q = queue(parked('OFF'), parked('B', 'batched'), running('R'));
  t('lever off and batched: nothing queued', QA.queuePushes(s, [item('OFF'), item('B')], q, { slug: 'acme__widgets', now: DAY }), []);
  t('and no push register is written', existsSync(join(s, 'ask-pushes.json')), false);
  t('and nothing is due', QA.duePushes(s, q, DAY), []);
}
{
  const s = stateDir();
  const q = queue(parked('O', 'one-at-a-time'), parked('M', 'mixed'), parked('MB', 'mixed'), { key: 'H', state: 'queued', held_by: 'MB' },
    parked('PB', 'one-at-a-time', 'PRODUCTION BROKEN: checkout fails'), running('R'));
  const lines = QA.queuePushes(s, ['O', 'M', 'MB', 'PB'].map(item), q, { slug: 'acme__widgets', now: DAY });
  t('one-at-a-time and a blocking mixed ask are queued; the report says so', lines, ['question-handling: pushed at the next notification: O (one-at-a-time), MB (mixed)']);
  const due = QA.duePushes(s, q, DAY);
  t('each is due with its question, keyed by its ask', due, [
    { key: `ask:acme__widgets:O:${SINCE}`, text: 'O: O: which layout?' },
    { key: `ask:acme__widgets:MB:${SINCE}`, text: 'MB: MB: which layout?' },
  ]);
  t('a production-broken park is the pass\'s to push, never queued here', due.some((p) => p.key.includes(':PB:')), false);
  t('nothing is pushed yet', [...QA.pushedAsks(s)], []);
  QA.markPushed(s, [due[0].key], { queue: join(s, 'queue.json'), now: DAY });
  t('once sent, it is kept as pushed by its ask id', [...QA.pushedAsks(s)], [`O:${SINCE}`]);
  t('and no longer due; one not yet sent still is', QA.duePushes(s, q, DAY).map((p) => p.key), [`ask:acme__widgets:MB:${SINCE}`]);
  QA.queuePushes(s, [item('O')], q, { slug: 'acme__widgets', now: DAY });
  t('handed on again, a pushed ask is not queued twice', QA.duePushes(s, q, DAY).map((p) => p.key), [`ask:acme__widgets:MB:${SINCE}`]);
  const answered = queue(parked('O', 'one-at-a-time'), { ...parked('MB', 'mixed'), state: 'queued', park: null }, running('R'));
  t('an ask answered before its push goes out is dropped', QA.duePushes(s, answered, DAY), []);
}

// ---- quiet hours, 22:00 to 08:00: nothing pushed, the ask waits for the digest ----------------------
{
  const s = stateDir();
  const q = queue(parked('O', 'one-at-a-time'), running('R'));
  t('handed on at night: not queued, and the report says it waits for the digest', QA.queuePushes(s, [item('O')], q, { slug: 'acme__widgets', now: NIGHT }),
    ['question-handling: not pushed in quiet hours (22:00 to 08:00), each waits for the check-in digest: O (one-at-a-time)']);
  t('nothing is due the next morning', QA.duePushes(s, q, new Date(2026, 10, 26, 9, 0)), []);
  QA.queuePushes(s, [item('O')], q, { slug: 'acme__widgets', now: new Date(2026, 10, 25, 21, 59) });
  t('queued just before quiet hours and not sent by then: dropped, left to the digest', QA.duePushes(s, q, new Date(2026, 10, 25, 22, 0)), []);
  t('08:00 is outside quiet hours', QA.queuePushes(s, [item('O')], q, { slug: 'acme__widgets', now: new Date(2026, 10, 26, 8, 0) }).length && QA.duePushes(s, q, new Date(2026, 10, 26, 8, 0)).length, 1);
}

if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all checks passed');
