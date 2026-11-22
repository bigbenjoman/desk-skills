// suite: pass phase: ticketless PRs (the open PRs a desk session opened that no ticket owns)
// layer: L1
import { decideTicketless, ticketlessPrs, ownerOf, DESK_PR_FENCE } from '../desk/bin/pass/ticketless-prs.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const BODY = `${DESK_PR_FENCE}\nWhat it does.\n<!-- desk-pr: end -->`;
const pr = (number, o = {}) => ({ number, title: `fix: change ${number}`, headRefName: `fix/change-${number}`, baseRefName: 'main', body: BODY,
  createdAt: '2026-11-20T10:00:00Z', author: { login: 'deskbot' }, ...o });
// One ticketless desk-opened PR, one a person opened under another handle, one under desk's handle with no
// fence (a person's own PR), and one for each way a ticket owns a PR: its title, its branch, its PR number.
const PRS = [
  pr(10),
  pr(11, { author: { login: 'someone' } }),
  pr(12, { body: 'Bumps a dependency.' }),
  pr(13, { title: 'fix(DS-5): the queue reads', headRefName: 'fix/queue-reads' }),
  pr(14, { headRefName: 'feat/recorded-branch' }),
  pr(15),
];
const TICKETS = [{ key: 'DS-5', state: 'running' }, { key: 'DS-6', branch: 'feat/recorded-branch' }, { key: 'DS-7', result: { pr: 15 } }];
const snap = (o = {}) => ({ prs: PRS, tickets: TICKETS, handle: 'DeskBot', base: 'main', recorded: null, dry: false, ...o });

t('DS-836 AC1 the desk-opened PR no ticket owns is the only one listed', j(ticketlessPrs(snap()).map((p) => p.pr)), '[10]');
t('DS-836 AC1 it is recorded with its title, branch and opening time', j(ticketlessPrs(snap())[0]),
  j({ pr: 10, title: 'fix: change 10', branch: 'fix/change-10', since: '2026-11-20T10:00:00Z' }));
t('DS-836 AC3 a PR a person opened under another handle is not listed', ticketlessPrs(snap({ prs: [PRS[1]] })).length, 0);
t('DS-836 AC3 a PR under desk\'s handle without desk\'s body fence is a person\'s, and not listed', ticketlessPrs(snap({ prs: [PRS[2]] })).length, 0);
t('DS-836 AC4 a PR whose title names a queued ticket is owned', ownerOf(PRS[3], TICKETS), 'DS-5');
t('DS-836 AC4 a PR on a ticket\'s recorded branch is owned', ownerOf(PRS[4], TICKETS), 'DS-6');
t('DS-836 AC4 a ticket\'s recorded PR is owned', ownerOf(PRS[5], TICKETS), 'DS-7');
t('a PR from a batch\'s base, its promotion or epic PR, is that batch\'s and not listed', ticketlessPrs(snap({ prs: [pr(10, { headRefName: 'feat/x' })], heads: ['feat/x'] })).length, 0);
t('a PR into another branch than the batch\'s base is not listed', ticketlessPrs(snap({ prs: [pr(10, { baseRefName: 'feat/x' })] })).length, 0);

// The decision: the record written when it changes, and a report line only for a PR listed for the first time.
{
  const first = decideTicketless(snap());
  t('DS-836 AC1 the first pass records it and says so once', j(first.map((a) => a.type)), '["set-batch","out"]');
  t('DS-836 AC1 the record is the list, as JSON', first[0].fields[0], `ticketless_prs=${j(ticketlessPrs(snap()))}`);
  t('DS-836 AC1 the report line names the PR and why nothing merges it', first[1].line,
    'PR #10 (fix/change-10) into main was opened by a desk session and no ticket owns it, so nothing will merge it: listed in needs-you');
  t('DS-836 AC5 a second pass with the same PR writes nothing and says nothing', j(decideTicketless(snap({ recorded: ticketlessPrs(snap()) }))), '[]');
  t('DS-836 AC2 once the PR is merged or closed, the next pass drops the record', j(decideTicketless(snap({ prs: [], recorded: ticketlessPrs(snap()) }))),
    j([{ type: 'set-batch', fields: ['ticketless_prs=null'] }]));
  t('a PR list gh could not read leaves the record as it is', j(decideTicketless(snap({ prs: null, recorded: ticketlessPrs(snap()) }))), '[]');
  t('no GitHub handle: nothing is listed or dropped', j(decideTicketless(snap({ handle: null, recorded: ticketlessPrs(snap()) }))), '[]');
  t('a dry run writes no record', j(decideTicketless(snap({ dry: true })).map((a) => a.type)), '["out"]');
}

console.log(fails ? `\n${fails} check(s) did not pass` : '\nall passed');
process.exit(fails ? 1 : 0);
