// suite: a GitHub issue's ticket file refreshed from the issue before its worker spawns (#1483)
// layer: L1
import { issueChanged, issueText, criteria, refreshTicket, refreshBrief } from '../desk/bin/ticket-refresh.mjs';
import { ticketDecisions, newDecisions, withDecisions } from '../desk/bin/decisions-change.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

t('AC3 an issue updated before the file was written has not changed', issueChanged({ updatedAt: '2026-11-20T10:00:00Z', fileAt: '2026-11-21T10:00:00Z' }), false);
t('AC1 an issue updated after the file was written has changed', issueChanged({ updatedAt: '2026-11-22T10:00:00Z', fileAt: '2026-11-21T10:00:00Z' }), true);
t('a recorded read later than the update is not a change, though the file is older', issueChanged({ updatedAt: '2026-11-22T10:00:00Z', readAt: '2026-11-22T10:00:00Z', fileAt: '2026-11-21T10:00:00Z' }), false);
t('issue-1694 a recorded read wins over a later file write: an edit after the read is a change', issueChanged({ updatedAt: '2026-11-22T10:00:00Z', readAt: '2026-11-21T10:00:00Z', fileAt: '2026-11-23T10:00:00Z' }), true);
t('an unreadable update time is no change', issueChanged({ updatedAt: '', fileAt: '2026-11-21T10:00:00Z' }), false);

const body = '## Problem\nThe badge is missing.\n\n## Acceptance criteria\n- AC1: the badge shows on the card\n\n## Design\nNo UI.';
const issue = (over = {}) => ({ title: 'Badge on the card', body, comments: [], updatedAt: '2026-11-22T10:00:00Z', ...over });
const args = { key: 'issue-7', repo: 'acme/widgets', n: '7', today: '2026-11-27' };
const admitted = issueText({ ...args, issue: issue() });
t('the file is laid out as at admission: key, source, title, body', admitted.split('\n').slice(0, 5), ['# issue-7', '', 'Source: GitHub issue acme/widgets#7', '', 'Badge on the card']);
t('the criteria are the Acceptance criteria lines', criteria(admitted), ['- AC1: the badge shows on the card']);

const same = refreshTicket({ ...args, old: admitted, issue: issue(), pr: 9 });
t('AC3 an unchanged issue gives the same text and no entry', [same.text === admitted, same.entry, same.what], [true, null, '']);

const comment = { author: { login: 'ben' }, createdAt: '2026-11-26T02:00:00Z', body: 'Also: AC2 the badge shows on the list page.' };
const fromComment = refreshTicket({ ...args, old: admitted, issue: issue({ comments: [comment] }) });
t('AC1 a criterion added in a comment reaches the file', fromComment.text.includes('## Comments') && fromComment.text.includes('Also: AC2 the badge shows on the list page.'), true);
t('with no PR open, no Decisions entry is written', [fromComment.entry, ticketDecisions(fromComment.text)], [null, []]);

const edited = body.replace('- AC1: the badge shows on the card', '- AC1: the badge shows on the card and the list\n- AC2: it is green');
const withPr = refreshTicket({ ...args, old: admitted, issue: issue({ body: edited }), pr: 9 });
t('AC2 a criterion changed in the body is named as added and removed', [withPr.added, withPr.removed], [['- AC1: the badge shows on the card and the list', '- AC2: it is green'], ['- AC1: the badge shows on the card']]);
t('AC2 with a PR open, the file gains a dated Decisions entry naming it', ticketDecisions(withPr.text).map((d) => d.date), ['2026-11-27']);
t('AC2 the entry says to build and re-review before taking the PR as done', withPr.entry.includes('Build and re-review it before taking the PR as done'), true);
t('AC2 the entry counts as new against a PR reviewed before it', newDecisions(withPr.text, { since: '2026-11-25T10:00:00Z', changedAt: '2026-11-27T09:00:00Z' }).length, 1);

const decided = `${body.replace('## Design', '## Decisions\n* 2026-11-20 ben: the badge is green\n\n## Design')}`;
const intoOwn = refreshTicket({ ...args, old: issueText({ ...args, issue: issue() }), issue: issue({ body: decided.replace('- AC1: the badge shows on the card', '- AC1: on the card and the list') }), pr: 9 });
t('the entry goes into the issue\'s own Decisions section, so the restart reads it', ticketDecisions(intoOwn.text).map((d) => d.date), ['2026-11-20', '2026-11-27']);

const again = refreshTicket({ ...args, today: '2026-11-28', old: withPr.text, issue: issue({ body: edited, title: 'Badge on the card and list' }), pr: 9 });
t('a later refresh keeps the earlier refresh\'s entry and adds none for a title change', [ticketDecisions(again.text).map((d) => d.date), again.entry], [['2026-11-27'], null]);

const ownEntry = ticketDecisions(withPr.text)[0].line;
const issueDecided = (line) => body.replace('## Design', `## Decisions\n* ${line}\n\n## Design`);
const priorOld = issueText({ ...args, issue: issue({ body: issueDecided('2026-11-20 ben: the badge is green') }), extra: [`* ${ownEntry}`] });
const editedOnIssue = refreshTicket({ ...args, today: '2026-11-28', old: priorOld, issue: issue({ body: issueDecided('2026-11-20 ben: the badge is blue') }), pr: 9 });
t('a Decisions entry edited on the issue is not kept in its old form, while the earlier desk pass entry is', ticketDecisions(editedOnIssue.text).map((d) => d.line), ['2026-11-20 ben: the badge is blue', ownEntry]);
const deletedOnIssue = refreshTicket({ ...args, today: '2026-11-28', old: priorOld, issue: issue(), pr: 9 });
t('a Decisions entry deleted on the issue is gone, while the earlier desk pass entry is kept', ticketDecisions(deletedOnIssue.text).map((d) => d.line), [ownEntry]);
const otherIssue = ownEntry.replace('issue #7 ', 'issue #8 ');
t('a desk pass entry naming another issue is not taken for this one\'s', ticketDecisions(refreshTicket({ ...args, old: issueText({ ...args, issue: issue(), extra: [`* ${otherIssue}`] }), issue: issue(), pr: 9 }).text).length, 0);

const wikiBody = 'h2. Problem\nThe badge is missing.\n\nh2. Acceptance criteria\n- AC1: the badge shows on the card';
const wiki = issueText({ ...args, issue: issue({ body: wikiBody }), extra: ['* 2026-11-27 desk pass: x'] });
t('a body in wiki headings gains an h2. Decisions heading, which the restart reads', [wiki.includes('\nh2. Decisions\n'), wiki.includes('## Decisions'), ticketDecisions(wiki).map((d) => d.line)], [true, false, ['2026-11-27 desk pass: x']]);
const wikiOwn = issueText({ ...args, issue: issue({ body: `${wikiBody}\n\nh2. Decisions\n* 2026-11-20 ben: green\n\nh2. Design\nNo UI.` }), extra: ['* 2026-11-27 desk pass: x'] });
t('an extra entry goes after the last entry of a wiki Decisions section, before the next heading', [ticketDecisions(wikiOwn).map((d) => d.date), wikiOwn.includes('* 2026-11-20 ben: green\n* 2026-11-27 desk pass: x\n\nh2. Design')], [['2026-11-20', '2026-11-27'], true]);
t('an extra entry goes straight under an empty Decisions heading', issueText({ ...args, issue: issue({ body: body.replace('## Design', '## Decisions\n\n## Design') }), extra: ['* 2026-11-27 desk pass: x'] }).includes('## Decisions\n* 2026-11-27 desk pass: x\n'), true);

const handAdmitted =`# issue-7\n\nSource: GitHub issue acme/widgets#7\n\nBadge on the card\n\n${body}\n\n## Comments\nben, 26 Nov: ${comment.body}\n`;
t('a comment already in a hand-written file is not new', refreshTicket({ ...args, old: handAdmitted, issue: issue({ comments: [comment] }), pr: 9 }).comments.length, 0);

const b = refreshBrief({ key: 'issue-7', n: '7', file: '/s/tickets/issue-7.md', what: fromComment.what });
t('the briefing for a session past Stage 0 names the file and what changed', [b.includes('/s/tickets/issue-7.md'), b.includes('ben at 2026-11-26T02:00:00Z')], [true, true]);

// issue-1694: an answer.mjs entry is not on the issue, so a refresh keeps it; it lands in the Decisions section.
{
  const answered = withDecisions(admitted.trimEnd(), ['* 2026-11-28 ben (answer.mjs): AC1: shows on the card, checked at 3f2a1b0']);
  t('issue-1694 AC2 an answer entry lands under a Decisions heading of its own where the file had none', ticketDecisions(answered).map((d) => d.line), ['2026-11-28 ben (answer.mjs): AC1: shows on the card, checked at 3f2a1b0']);
  const kept = refreshTicket({ ...args, today: '2026-11-29', old: answered, issue: issue({ comments: [{ author: { login: 'ben' }, createdAt: '2026-11-29T01:00:00Z', body: 'one more thing' }] }), pr: 9 });
  t('issue-1694 AC2 a refresh from the issue keeps the answer entry', ticketDecisions(kept.text).map((d) => d.line).filter((l) => l.includes('(answer.mjs)')), ['2026-11-28 ben (answer.mjs): AC1: shows on the card, checked at 3f2a1b0']);
  const filled = withDecisions(issueText({ ...args, issue: issue({ body: `${body}\n\n## Decisions\n* 2026-11-20 ben: the badge is blue\n\n## Build on\nsrc/card.ts` }) }), ['* 2026-11-28 ben (answer.mjs): AC1: 2']);
  t('issue-1694 AC2 into an existing Decisions section, after its last entry and before the next section', ticketDecisions(filled).map((d) => d.line), ['2026-11-20 ben: the badge is blue', '2026-11-28 ben (answer.mjs): AC1: 2']);
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
