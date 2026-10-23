// suite: check-in digest (slots, one digest per slot across repos, answers and overrides)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkinTimes, latestSlot, checkin, answer, override, urgentParks, readDecisions, openQuestions, askAgain, DEFAULT_TIMES } from '../desk/bin/digest.mjs';
import { addPutOff, putOffEntry } from '../desk/bin/not-now.mjs';
import { takeBorrowLock } from '../desk/bin/borrow.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const at = (d, hm) => new Date(`${d}T${hm}:00`);   // local time, as the slots are

t('AC2 an unset row is 08:00 and 17:00', checkinTimes(null).times.join(' '), DEFAULT_TIMES.join(' '));
t('AC2 a TODO row is the default too', checkinTimes('TODO').times.join(' '), '08:00 17:00');
t('a row of times reads, sorted', checkinTimes('17:30, 07:15').times.join(' '), '07:15 17:30');
t('AC3 a row that is not HH:MM times is refused, naming the row', /config §3b "Check-in times" is "8am"/.test(checkinTimes('8am').why), true);
t('AC3 an hour past 23 is refused', checkinTimes('24:00').ok, false);
t('before the first slot of the day, the latest is yesterday\'s last', latestSlot(DEFAULT_TIMES, at('2026-10-22', '07:59')).id, '2026-10-21T17:00');
t('just past a slot, it is that slot', latestSlot(DEFAULT_TIMES, at('2026-10-22', '17:00')).id, '2026-10-22T17:00');

// Three repos: parks in two, decisions in a third.
const root = mkdtempSync(join(tmpdir(), 'desk-digest-'));
const repo = (slug, tickets, decisions = []) => {
  const state = join(root, 'state', slug);
  mkdirSync(join(state, 'triage'), { recursive: true });
  const queue = join(root, 'q', slug, 'queue.json');
  mkdirSync(dirname(queue), { recursive: true });
  writeFileSync(queue, JSON.stringify({ batch: 'b', tickets }));
  if (decisions.length) writeFileSync(join(state, 'decisions.jsonl'), decisions.map((d) => `${JSON.stringify(d)}\n`).join(''));
  return { slug, state, queue };
};
const dec = (id, ticket, iso, extra = {}) => ({ id, at: iso, repo: 'acme/c', ticket, question: `Call ${id}?`, options: ['a', 'b'], chose: 'a', category: 'engineering', pr: null, ...extra });
const A = repo('acme__a', {
  'A-1': { key: 'A-1', state: 'parked', park: { question: 'which empty-state copy?' } },
  'A-2': { key: 'A-2', state: 'parked', park: { question: 'held by orchestrator: blocked by A-1' } },
});
const B = repo('acme__b', { 'B-1': { key: 'B-1', state: 'triaged', open_questions: 1 } });
writeFileSync(join(B.state, 'triage', 'B-1.json'), JSON.stringify({ unknowns: ['Which plan tier gets the export?'] }));
const C = repo('acme__c', {}, [dec('d1', 'C-1', at('2026-10-22', '09:00').toISOString()), dec('d2', 'C-2', at('2026-10-22', '10:00').toISOString())]);
const list = [A, B, C];
const dir = join(root, 'digest');

const r1 = await checkin({ times: DEFAULT_TIMES, now: at('2026-10-22', '17:01'), dir, list, bin: BIN, self: 'acme__a' });
t('AC1 the first pass past 17:00 sends the digest', r1.status, 'sent');
t('AC1 the push names the counts', /^Check-in 17:00: 2 question\(s\), 2 decision\(s\) across 3 repo\(s\)\./.test(r1.push?.text), true);
const page = readFileSync(r1.page, 'utf8');
t('AC1 the page groups by repo', ['## acme__a', '## acme__b', '## acme__c'].every((h) => page.includes(h)), true);
t('AC1 a parked question is listed', page.includes('`A-1` (parked): which empty-state copy?'), true);
t('a hold is not a question', page.includes('A-2'), false);
t('AC1 a triage unknown is listed by its text', page.includes('`B-1` (triage): Which plan tier gets the export?'), true);
t('AC1 each decision is listed with its override command', page.includes('id `d1`') && page.includes('override acme__c d1'), true);

const r2 = await checkin({ times: DEFAULT_TIMES, now: at('2026-10-22', '17:04'), dir, list, bin: BIN, self: 'acme__b' });
t('AC4 a pass in another repo past the same slot sends nothing', `${r2.status} ${r2.push}`, 'not_due null');
const again = await checkin({ times: DEFAULT_TIMES, now: at('2026-10-22', '17:04'), dir, list, bin: BIN, self: 'acme__a' });
t('the building repo keeps the same push until the next slot, for a failed notification to retry', again.push?.key, 'digest:2026-10-22T17:00');

// AC4: a lock held by a live process makes the other caller leave the slot to it.
const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
const held = await takeBorrowLock({ dir, name: 'digest.lock.d', waitMs: 0, pid: holder.pid });
t('the lock is taken', held.ok, true);
t('AC4 a contended lock leaves the slot to its holder', (await checkin({ times: DEFAULT_TIMES, now: at('2026-10-23', '08:01'), dir, list, bin: BIN })).status, 'busy');
holder.kill();
await new Promise((res) => holder.on('exit', res));
const freed = await takeBorrowLock({ dir, name: 'digest.lock.d', waitMs: 0 });
t('a lock whose holder died is cleared', freed.ok, true);
freed.release();

// AC7: answering from the digest goes through that repo's answer.mjs and marks the page.
process.env.DESK_HOME = join(BIN, '..');
const ans = answer({ slug: 'acme__a', ticket: 'A-1', text: 'Use "Nothing here yet"', dir, list, bin: BIN, now: new Date('2026-10-22T17:10:00.000Z') });
t('AC7 the answer is recorded', ans.ok, true);
t('AC7 it reaches the ticket as answer.mjs records it', readFileSync(join(A.state, 'briefings', 'A-1.md'), 'utf8').includes('Use "Nothing here yet"'), true);
t('AC7 the page marks the question answered', readFileSync(r1.page, 'utf8').includes('- [x] `A-1` (parked): which empty-state copy? — answered 2026-10-22T17:10:00.000Z'), true);
t('an unknown repo is refused', answer({ slug: 'nope', ticket: 'A-1', text: 'x', dir, list, bin: BIN }).ok, false);

// AC8: an override is logged with who and when, and marked on the page.
const ov = override({ slug: 'acme__c', id: 'd2', choice: 'b', dir, list, by: 'Ben', now: new Date('2026-10-22T17:12:00.000Z') });
const o = readDecisions(C.state).overrides[0];
t('AC8 the override is recorded with who and when', `${ov.ok} ${o?.override_of} ${o?.chose} ${o?.was} ${o?.by} ${o?.at}`, 'true d2 b a Ben 2026-10-22T17:12:00.000Z');
t('AC8 the page marks the decision overridden', readFileSync(r1.page, 'utf8').includes('id `d2` — overridden to **b** by Ben'), true);
t('a decision is overridden once', override({ slug: 'acme__c', id: 'd2', choice: 'a', dir, list, by: 'Ben' }).ok, false);
t('an unknown decision is refused', override({ slug: 'acme__c', id: 'zz', choice: 'a', dir, list, by: 'Ben' }).ok, false);

// AC5 and AC11: nothing ran at 08:00; the first pass after covers everything since the last digest,
// and B-1's question, still open, is listed again.
appendFileSync(join(C.state, 'decisions.jsonl'), `${JSON.stringify(dec('d3', 'C-3', at('2026-10-22', '17:30').toISOString()))}\n`);
const r3 = await checkin({ times: DEFAULT_TIMES, now: at('2026-10-23', '10:30'), dir, list, bin: BIN, self: 'acme__a' });
const page3 = readFileSync(r3.page, 'utf8');
t('AC5 the missed 08:00 slot is sent by the first pass after it', `${r3.status} ${r3.slot}`, 'sent 2026-10-23T08:00');
t('AC5 it covers the decision taken since the last digest, and no earlier one', page3.includes('id `d3`') && !page3.includes('id `d1`'), true);
t('AC11 an unanswered question is listed again at the next check-in', page3.includes('`B-1` (triage)'), true);
t('AC7 an answered question is not', page3.includes('`A-1`'), false);
writeFileSync(A.queue, JSON.stringify({ batch: 'b', tickets: { 'A-1': { key: 'A-1', state: 'parked', park: { question: 'which empty-state copy?', since: '2026-10-23T11:00:00.000Z' } } } }));
const r3b = await checkin({ times: DEFAULT_TIMES, now: at('2026-10-23', '17:01'), dir, list, bin: BIN, self: 'acme__a' });
t('the same question parked again after an answer is listed and pushed as new', `${readFileSync(r3b.page, 'utf8').includes('`A-1` (parked)')} ${r3b.push?.key}`, 'true digest:2026-10-23T17:00');

t('a decision taken since is new, so the missed slot pushes', r3.push?.key, 'digest:2026-10-23T08:00');

// AC6: nothing new since the last digest. B-1 is still open and listed, but the last page listed it.
const r4 = await checkin({ times: DEFAULT_TIMES, now: at('2026-10-24', '08:05'), dir, list, bin: BIN, self: 'acme__a' });
t('AC6 nothing new: no push', `${r4.status} ${r4.push}`, 'sent null');
t('AC11 the carried question is still on the page', readFileSync(r4.page, 'utf8').includes('`B-1` (triage)'), true);
const r5 = await checkin({ times: DEFAULT_TIMES, now: at('2026-10-24', '17:05'), dir, list: [repo('acme__e', {})], bin: BIN, self: 'acme__a' });
t('AC6 with nothing open at all, the page says there is nothing to answer', `${r5.push} ${readFileSync(r5.page, 'utf8').includes('Nothing to answer')}`, 'null true');

// AC9 and AC10: only a production-broken park is pushed between check-ins.
const urgent = urgentParks([{ key: 'X-1', question: 'PRODUCTION BROKEN: checkout 500s' }, { key: 'X-2', question: 'which copy?' }], 'acme__x');
t('AC9 a production-broken park is pushed alone', urgent.map((u) => u.key).join(' '), 'urgent:acme__x:X-1');

// DS-143: a question put off with the same inputs is listed once under "Put off", not as a question;
// one whose inputs changed is a question saying what changed; a check made instead of asking is listed.
const P = repo('acme__p', {
  'P-1': { key: 'P-1', state: 'parked', park: { question: 'Rotate the prod DB password?', inputs: { env: 'prod' } } },
  'P-2': { key: 'P-2', state: 'parked', park: { question: 'rotate the prod db password', inputs: { env: 'prod' } } },
  'P-3': { key: 'P-3', state: 'parked', park: { question: 'Which plan tier?', inputs: { pr: '2' } } },
}, [{ id: 'c1', kind: 'check', at: at('2026-10-25', '09:00').toISOString(), ticket: 'P-4', question: 'Is the DNS record in?', checked: 'dig +short api.acme.dev', showed: '203.0.113.7' }]);
addPutOff(putOffEntry({ question: 'Rotate the prod DB password?', ticket: 'P-1', inputs: { env: 'prod' }, by: 'Ben', at: '2026-10-21T09:00:00.000Z' }), P.state);
addPutOff(putOffEntry({ question: 'Which plan tier?', ticket: 'P-3', inputs: { pr: '1' }, by: 'Ben', at: '2026-10-21T09:00:00.000Z' }), P.state);
const r6 = await checkin({ times: DEFAULT_TIMES, now: at('2026-10-25', '17:01'), dir, list: [P], bin: BIN, self: 'acme__p' });
const page6 = readFileSync(r6.page, 'utf8');
t('DS-143 AC6 a put-off question is not asked', page6.includes('`P-1` (parked)') || page6.includes('`P-2` (parked)'), false);
t('DS-143 AC6 it is listed once under Put off, with the date', page6.split('\n').filter((l) => l.includes('Put off on 2026-10-21 by Ben')).length === 1 && page6.includes('### Put off') && page6.includes('- `P-1`, `P-2`: Rotate the prod DB password?'), true);
t('DS-143 AC7 changed inputs are asked, saying what changed', page6.includes('`P-3` (parked): Which plan tier? (Changed since Ben put it off on 2026-10-21: pr 1 → 2.)'), true);
t('DS-143 AC2 a check made instead of asking is listed with what it showed', page6.includes('### Checked instead of asking') && page6.includes('`P-4`: Is the DNS record in? Checked dig +short api.acme.dev: 203.0.113.7'), true);
t('DS-143 the push counts the questions and checks, not the put-off ones', r6.push?.text.includes('1 question(s), 0 decision(s), 1 check(s)'), true);
t('DS-143 ask-again takes it out of the register', askAgain({ slug: 'acme__p', ticket: 'P-1', list: [P] }).ok, true);
t('DS-143 and it is a question again', openQuestions(P).map((q) => q.ticket).join(' '), 'P-1 P-2 P-3');
writeFileSync(join(P.state, 'not-now.jsonl'), '{"key": "torn');
t('DS-143 AC8 an unreadable register asks as today', openQuestions(P).length, 3);

rmSync(root, { recursive: true, force: true });
t('cleaned up', existsSync(root), false);
if (fails) { console.log(`${fails} failed`); process.exit(1); }
