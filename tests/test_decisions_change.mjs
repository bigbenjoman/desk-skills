// suite: a ticket file's Decisions entries added since its PR's last review (#1465)
// layer: L1
import { ticketDecisions, lastReviewAt, decisionsSince, newDecisions, decisionsBrief } from '../desk/bin/decisions-change.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const ticket = (...lines) => ['# T-1', '', '## Acceptance criteria', '- 2026-11-20 not a decision', '', '## Decisions', ...lines, '', '## Build on', '* 2026-11-30 not a decision either'].join('\n');
const file = ticket('* 2026-11-10 ben: the badge is green', '- 2026-11-24 ben: widen it to the list page', '* no date, left out');

t('the dated entries under Decisions only, each bullet form', ticketDecisions(file).map((d) => d.date), ['2026-11-10', '2026-11-24']);
t('an entry keeps its line without the bullet', ticketDecisions(file)[1].line, '2026-11-24 ben: widen it to the list page');
t('a ticket with no Decisions section has none', ticketDecisions('# T-1\n\n## Problem\n* 2026-11-24 x'), []);
t('an emphasised Decisions heading is still the section', ticketDecisions('# T-1\n\n## **Decisions**\n* 2026-11-24 ben: x').map((d) => d.date), ['2026-11-24']);

const opts = { isVerdict: (b) => /verdict/.test(b ?? ''), ownLogin: (l) => l === 'ben' };
const review = (login, at, body = 'desk-review verdict') => ({ author: { login }, submittedAt: at, body });
const pr = { createdAt: '2026-11-01T09:00:00Z', reviews: [review('ben', '2026-11-12T10:00:00Z'), review('ben', '2026-11-20T10:00:00Z'), review('ben', '2026-11-22T10:00:00Z', 'thanks'), review('eve', '2026-11-23T10:00:00Z')] };
t('the last review is the latest verdict review the person posted', lastReviewAt(pr, opts), '2026-11-20T10:00:00Z');
t('with none, it is the PR\'s open time', lastReviewAt({ ...pr, reviews: [review('eve', '2026-11-23T10:00:00Z')] }, opts), '2026-11-01T09:00:00Z');

const since = '2026-11-20T10:00:00Z';
t('AC1 an entry dated after the last review is new', newDecisions(file, { since, changedAt: '2026-11-24T08:00:00Z' }).map((d) => d.date), ['2026-11-24']);
t('AC3 a file untouched since the review has nothing new', newDecisions(file, { since: '2026-11-25T10:00:00Z', changedAt: '2026-11-24T08:00:00Z' }), []);
t('AC3 no entry after the review, though the file was written since, is nothing new', newDecisions(ticket('* 2026-11-10 ben: green'), { since, changedAt: '2026-11-24T08:00:00Z' }), []);
const sameDay = ticket('* 2026-11-20 ben: and the empty state');
t('an entry on the review\'s own day is new when the file was written after the review', newDecisions(sameDay, { since, changedAt: '2026-11-20T15:00:00Z' }).length, 1);
t('and not when the file was written before it', newDecisions(sameDay, { since, changedAt: '2026-11-20T09:00:00Z' }).length, 0);
t('no review time compares nothing', newDecisions(file, { since: null, changedAt: '2026-11-24T08:00:00Z' }), []);

t('with no restart delivered, the entries are compared with the review', decisionsSince(since, undefined), since);
t('a restart delivered after the review is what later spawns compare with', decisionsSince(since, '2026-11-24T09:00:00Z'), '2026-11-24T09:00:00Z');
t('a restart delivered before a newer review gives way to the review', decisionsSince(since, '2026-11-19T09:00:00Z'), since);
t('the restarted session\'s own handoff, the file unchanged since the restart, has nothing new', newDecisions(file, { since: decisionsSince(since, '2026-11-24T09:00:00Z'), changedAt: '2026-11-24T08:00:00Z' }), []);

const b = decisionsBrief({ key: 'T-1', pr: 7, since, entries: newDecisions(file, { since, changedAt: '2026-11-24T08:00:00Z' }), file: '/s/tickets/T-1.md' });
t('AC1 the briefing says it starts at Stage 3 and lists the entry', [b.includes('this session starts at Stage 3'), b.includes('- 2026-11-24 ben: widen it to the list page')], [true, true]);
t('AC2 the briefing has the worker check the branch and name the commit before taking the PR as done', b.includes('naming that commit and the decision, and only then treat that decision as done'), true);
const b0 = decisionsBrief({ key: 'T-1', pr: 7, since, entries: ticketDecisions(file), file: '/s/tickets/T-1.md', resumable: false });
t('a round that cannot be resumed starts at Stage 0, still building the entries at Stage 3', [b0.includes('this session starts at Stage 0'), b0.includes('at Stage 3 build what each decision adds')], [true, true]);

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
