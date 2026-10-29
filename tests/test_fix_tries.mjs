// suite: fix tries (a red or conflicted ready PR goes back to a worker, twice)
import { fixCall, fixBrief, fixTask, parseOperatorChecks, reviewFindings, reviewFix, reviewGaps, FIX_TRIES_MAX } from '../desk/bin/fix-tries.mjs';
import { undraftCall, undraftComment } from '../desk/bin/undraft.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const HEAD = 'a'.repeat(40);
const ok = (name) => ({ name, status: 'completed', conclusion: 'success', runId: '1' });
const red = (name, runId) => ({ name, status: 'completed', conclusion: 'failure', runId });
const pr = (checks, o = {}) => ({ pr: 697, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeState: 'BLOCKED', head: HEAD, checks, ...o });
const { checks: operator } = parseOperatorChecks(['Flows image missing: build it: ensure-flows-image.sh']);
// Every check the driver reran twice, and the last rerun's gap over.
const ctx = (o = {}) => ({ repo: 'acme/widgets', base: 'main', required: ['tests'], advisory: [], operator, reruns: () => 2, cooledDown: true, waived: () => false, conflictFiles: () => ['src/a.ts'], ...o });
const tk = (o = {}) => ({ key: 'T-1', ...o });

// The row.
t('operator row splits on the first ": ", so the command may hold one', operator[0].command, 'build it: ensure-flows-image.sh');
t('operator row: an item with no command is an error', parseOperatorChecks(['Flows image missing']).errors.length, 1);
t('operator row: none is empty', parseOperatorChecks(['none']).checks.length, 0);

// AC2: red after both reruns, not waived: requeued, the brief naming each check and its run.
const both = pr([ok('tests'), red('Backend tests', '901'), red('Lint', '902')]);
const c2 = fixCall(tk(), both, ctx());
t('AC2 red after the two reruns is requeued', c2?.call, 'requeue');
t('AC2 try 1 of 2, for this head', `${c2?.fix.try}/${c2?.fix.of} ${c2?.fix.head === HEAD}`, `1/${FIX_TRIES_MAX} true`);
t('AC2 it names what it fixes', c2?.fix.what, 'red: Backend tests, Lint');
const brief2 = fixBrief(tk({ fix: c2.fix }));
t('AC2 the brief names each failing check and its run URL', brief2.includes('- Backend tests: https://github.com/acme/widgets/actions/runs/901') && brief2.includes('- Lint: https://github.com/acme/widgets/actions/runs/902'), true);
t('AC2 a brief is only for an open try', fixBrief(tk({ fix: { ...c2.fix, finished: 'x' } })), '');
t('AC2 the task names the PR and the try', fixTask(tk({ fix: c2.fix })).includes('fix try 1 of 2 on PR #697'), true);
t('AC2 not before the second rerun', fixCall(tk(), both, ctx({ reruns: () => 1 })), null);
t('AC2 not before the last rerun has had its gap', fixCall(tk(), both, ctx({ cooledDown: false })), null);
t('AC2 not while a check still runs', fixCall(tk(), pr([...both.checks, { name: 'e2e', status: 'in_progress', conclusion: null }]), ctx()), null);
t('AC2 not when the driver waives it as a known flaky check', fixCall(tk(), both, ctx({ waived: () => true })), null);
t('AC2 a green PR is nothing to fix', fixCall(tk(), pr([ok('tests')]), ctx()), null);
t('AC2 a draft is nothing to fix', fixCall(tk(), pr(both.checks, { isDraft: true }), ctx()), null);

// AC3: in conflict with its base.
const dirty = pr([ok('tests')], { mergeable: 'CONFLICTING', mergeState: 'DIRTY', pr: 704 });
const c3 = fixCall(tk(), dirty, ctx());
t('AC3 a conflicted PR is requeued', `${c3?.call} ${c3?.fix.kind}`, 'requeue conflict');
const brief3 = fixBrief(tk({ fix: c3.fix }));
t('AC3 the brief says it conflicts with the base and names the files', brief3.includes('it conflicts with main') && brief3.includes('Conflicting files: src/a.ts.'), true);
t('AC3 with no files listed, the brief says how to find them', fixBrief(tk({ fix: fixCall(tk(), dirty, ctx({ conflictFiles: () => null })).fix })).includes('git merge-tree --write-tree --name-only origin/main HEAD'), true);
t('AC3 the task authorises resolving it by a merge, never a force push', fixTask(tk({ fix: c3.fix })).includes('merge origin/main into your branch (git merge, never a rebase or a force push)'), true);

// AC4 and AC5: one try per head, two at most.
const one = [{ try: 1, head: 'b'.repeat(40), kind: 'checks', what: 'red: Lint' }];
t('AC4 a new head after try 1 gets try 2', fixCall(tk({ fix_tries: one }), both, ctx())?.fix.try, 2);
t('AC4 a try already made for this head is not made again', fixCall(tk({ fix_tries: [{ ...one[0], head: HEAD }] }), both, ctx())?.call, 'stuck');
const two = [...one, { try: 2, head: 'c'.repeat(40), kind: 'checks', what: 'red: Lint' }];
const c5 = fixCall(tk({ fix_tries: two }), both, ctx());
t('AC5 after 2 tries it is stuck, not requeued', c5?.call, 'stuck');
t('AC5 the stuck text names the checks', c5?.why, 'still red after 2 fix tries: Backend tests, Lint');
t('AC5 or the conflict', fixCall(tk({ fix_tries: two }), dirty, ctx())?.why, 'still in conflict with main after 2 fix tries');

// AC6: red only on a check no worker can fix: stuck at once, with the command.
const flows = pr([ok('tests'), red('Flows image missing', '903')]);
const c6 = fixCall(tk(), flows, ctx({ reruns: () => 0 }));
t('AC6 never requeued, stuck with the command', `${c6?.call} | ${c6?.why}`, 'stuck | Flows image missing · build it: ensure-flows-image.sh');

// AC7: an operator-only check beside a fixable one: requeued for the fixable one only.
const mixed = pr([ok('tests'), red('Flows image missing', '903'), red('Lint', '902')]);
const c7 = fixCall(tk(), mixed, ctx());
t('AC7 requeued for the fixable check only', `${c7?.call} ${c7?.fix.what}`, 'requeue red: Lint');
const brief7 = fixBrief(tk({ fix: c7.fix }));
t('AC7 the brief says the other check is not the worker\'s', brief7.includes('Flows image missing is red too, and it is not yours to fix: build it: ensure-flows-image.sh') && !brief7.includes('- Flows image missing: https'), true);

// AC1: the undraft call carries the verdict it read, and the comment quotes it.
const verdictBody = `<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=${HEAD} p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1 -->\nclean`;
const ready = undraftCall(tk(), { number: 701, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'CLEAN', body: '', reviews: [{ author: { login: 'ben' }, body: verdictBody }], checks: [ok('tests')] },
  { perm: 'yes', localReview: '/desk-review', clean: 'p0=0 p1=0 gaps=0', handle: 'ben', required: ['tests'] });
t('AC1 a ready call carries its verdict', ready?.verdict?.sha, HEAD);
const comment = undraftComment(ready.verdict, HEAD, 'p0=0 p1=0 gaps=0');
t('AC1 the comment says why it left draft', comment.startsWith(`Out of draft: the desk-review verdict posted on this head (\`${HEAD.slice(0, 12)}\`) is clean`), true);
t('AC1 and quotes the verdict', comment.includes(`> \`sha=${HEAD} p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1\``), true);

// ---- a draft whose review at its head found a P0 or P1 goes back to a fix worker, twice
const CLEAN = 'p0=0 p1=0 p2=0 deferred=0 gaps=0';
const reviewBody = (counts, rest = []) => [`<!-- desk-review:local -->`, `<!-- desk-review:verdict v=1 sha=${HEAD} ${counts} deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1 -->`, '**desk-review, round 1**', '', ...rest].join('\n');
const p1Body = reviewBody('p0=0 p1=1 p2=1', ['P1 (1)', ' packages/core/src/money.ts:12         second currency formatter', '                                       — packages/core/src/format.ts:8 is the original', '', 'P2 (1)', ' apps/web/src/Pager.tsx:1   no consumer', '', '### Requirement gaps', ' AC3: src/csv.ts:4 no VAT column']);
const draft = (body, o = {}) => ({ number: 702, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'BLOCKED', body: '', reviews: [{ author: { login: 'ben' }, body }], checks: [ok('tests')], ...o });
const ucfg = { perm: 'yes', localReview: '/desk-review', clean: CLEAN, handle: 'ben', required: ['tests'] };
const u1 = undraftCall(tk(), draft(p1Body), ucfg);
t('DS-281 AC1 a review at the head with a P1 is a findings call, with its review', `${u1?.call} ${u1?.verdict?.p1} ${u1?.review === p1Body}`, 'findings 1 true');
t('DS-281 AC1 found before red checks or a conflict', undraftCall(tk(), draft(p1Body, { mergeable: 'CONFLICTING', mergeState: 'DIRTY', checks: [red('tests', '9')] }), ucfg)?.call, 'findings');
t('DS-281 AC2 a P1 review of an older head is not this head\'s findings', undraftCall(tk(), draft(p1Body, { head: 'b'.repeat(40) }), ucfg)?.call, 'person');
const r1 = reviewFix(tk(), { pr: 702, head: HEAD, verdict: u1.verdict, body: u1.review });
t('DS-281 AC1 requeued for try 1 of 2, of kind review', `${r1?.call} ${r1?.fix.try}/${r1?.fix.of} ${r1?.fix.kind} ${r1?.fix.what}`, 'requeue 1/2 review review not clean: 1 P1');
t('DS-281 AC1 the findings read are the P1 only, with its file:line', JSON.stringify(r1?.fix.findings), JSON.stringify([{ sev: 'P1', text: 'packages/core/src/money.ts:12         second currency formatter — packages/core/src/format.ts:8 is the original' }]));
const brief281 = fixBrief(tk({ fix: r1.fix }));
t('DS-281 AC1 the brief quotes each P1 with its file and line', brief281.includes('- P1: packages/core/src/money.ts:12         second currency formatter — packages/core/src/format.ts:8 is the original'), true);
t('DS-281 AC1 and not the P2 or the gap', !brief281.includes('Pager.tsx') && !brief281.includes('csv.ts'), true);
t('DS-281 AC1 the brief quotes the verdict', brief281.includes(`(\`sha=${HEAD} p0=0 p1=1 p2=1`), true);
const p0Body = reviewBody('p0=1 p1=1 p2=0', ['- **P0** `apps/api/routes/invoices.py:67` invoice total rounded per line', '- **P1** `src/b.ts:3` second formatter']);
t('DS-281 AC1 findings that open with their own severity are read too', reviewFindings(p0Body).map((x) => x.sev).join(','), 'P0,P1');
t('DS-281 AC1 a capitalised file is a finding, and a capitals heading ends the run', reviewFindings('P1 (2)\n README.md:3  stale\nREQUIREMENT GAPS (1)  DS-9\n AC3: src/a.ts:4 gap').map((x) => x.text).join('|'), 'README.md:3  stale');
t('DS-281 AC1 a review listing no P1 with its file:line, in its body or inline, is left for the person', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p1: '1' }, body: 'nothing here' }), null);
const task281 = fixTask(tk({ fix: r1.fix }));
t('DS-281 AC2 the task reviews the new head and posts it on the PR', task281.includes('review the new head with desk-review and post that review on the PR'), true);
t('DS-281 AC2 and leaves the PR in draft', task281.includes('leave the PR in draft'), true);
const clean281 = undraftCall(tk(), draft(reviewBody('p0=0 p1=0 p2=0')), ucfg);
t('DS-281 AC3 a clean re-review at the new head is undrafted with its verdict', `${clean281?.call} ${clean281?.verdict?.sha === HEAD}`, 'ready true');
t('DS-281 AC4 a try already made for this head is not made again', reviewFix(tk({ fix_tries: [{ try: 1, head: HEAD, kind: 'review' }] }), { pr: 702, head: HEAD, verdict: { p1: '1' } })?.why, 'review not clean after 1 fix try: 1 P1');
const r5 = reviewFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }] }), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '1' } });
t('DS-281 AC5 after 2 tries it is stuck, with the P1 count', `${r5?.call} | ${r5?.why}`, 'stuck | review not clean after 2 fix tries: 1 P1');
const p2only = undraftCall(tk(), draft(reviewBody('p0=0 p1=0 p2=2')), ucfg);
t('DS-281 AC6 only P2s: not a findings call, the person settles them as today', `${p2only?.call} ${p2only?.action}`, 'person settle the findings or gaps on #702');
t('DS-281 AC6 and reviewFix leaves it alone', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '0', p2: '2' } }), null);
const mixedTries = [{ try: 1, head: 'b'.repeat(40), kind: 'checks', what: 'red: Lint' }];
t('DS-281 AC7 a checks try counts: the review try is try 2', reviewFix(tk({ fix_tries: mixedTries }), { pr: 702, head: HEAD, verdict: { p1: '1' }, body: p1Body })?.fix.try, 2);
t('DS-281 AC7 and a review try counts toward a checks try', fixCall(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }] }), both, ctx())?.why, 'still red after 2 fix tries: Backend tests, Lint');

// ---- a review whose P0s and P1s are posted inline goes to a fix worker too
const inlineBody = reviewBody('p0=0 p1=1 p2=0', ['P2 (0)']);
const inlineP1 = { path: 'src/money.ts', line: 12, body: '**P1** second currency formatter\nsrc/format.ts:8 is the original' };
t('DS-299 the undraft call carries the review\'s id', undraftCall(tk(), draft(inlineBody, { reviews: [{ id: 'PRR_1', author: { login: 'ben' }, body: inlineBody }] }), ucfg)?.reviewId, 'PRR_1');
const r299 = reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '1' }, body: inlineBody, comments: [inlineP1] });
t('DS-299 AC1 an inline P1 and none in the body is requeued for try 1', `${r299?.call} ${r299?.fix.try} ${r299?.fix.kind}`, 'requeue 1 review');
t('DS-299 AC1 the finding is quoted with its file and line', JSON.stringify(r299?.fix.findings), JSON.stringify([{ sev: 'P1', text: 'src/money.ts:12 second currency formatter src/format.ts:8 is the original' }]));
t('DS-299 AC1 and the brief quotes it', fixBrief(tk({ fix: r299.fix })).includes('- P1: src/money.ts:12 second currency formatter'), true);
const both299 = reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p0: '1', p1: '1' }, body: p1Body, comments: [
  { path: 'packages/core/src/money.ts', line: 12, body: '**P1** second currency formatter' },
  { path: 'packages/core/src/money.ts', line: 1, body: '**P1** a different line' },
  { path: 'apps/api/routes/invoices.py', line: 67, body: '**P0:** invoice total rounded per line' },
  { path: 'packages/core/src/format.ts', line: 8, body: '**P1** rounds half down' },
] });
t('DS-299 AC2 a finding in the body and inline is quoted once, and the rest each once, one the body only cites as evidence included', both299?.fix.findings.map((x) => `${x.sev} ${x.text.split(' ')[0]}`).join('|'), 'P1 packages/core/src/money.ts:12|P1 packages/core/src/money.ts:1|P0 apps/api/routes/invoices.py:67|P1 packages/core/src/format.ts:8');
const routeBody = reviewBody('p0=0 p1=1 p2=0', ['- **P1** `app/[id]/(shop)/page.tsx:12` cart total unrounded']);
t('DS-299 AC2 a path holding brackets or parentheses is quoted once too', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p1: '1' }, body: routeBody, comments: [{ path: 'app/[id]/(shop)/page.tsx', line: 12, body: '**P1** cart total unrounded' }] })?.fix.findings.length, 1);
t('DS-299 AC3 inline comments that could not be read leave an inline-only review for the person', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p1: '1' }, body: inlineBody, comments: null }), null);
t('DS-299 AC4 inline comments holding only P2s are not requeued', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p1: '1' }, body: inlineBody, comments: [{ path: 'src/a.ts', line: 3, body: '**P2** naming' }, { path: 'src/b.ts', line: 4, body: 'a reply, no severity' }] }), null);
t('DS-299 inline comments are read only once a try is left', reviewFix(tk({ fix_tries: [{ try: 1, head: HEAD, kind: 'review' }] }), { pr: 702, head: HEAD, verdict: { p1: '1' }, comments: () => { throw new Error('read'); } })?.call, 'stuck');
t('DS-299 and read when one is', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p1: '1' }, body: inlineBody, comments: () => [inlineP1] })?.fix.findings.length, 1);

// ---- under §3 autopilot-judgement yes, a review with only requirement gaps goes to a fix worker too
const gapBody = (counts, gaps, rest) => reviewBody(counts, rest).replace('deferred=0 gaps=0', `deferred=0 gaps=${gaps}`);
const AC2 = '**AC2**, "no slot is handed to both." This holds only while the borrow lock is held.';
const g1Body = gapBody('p0=0 p1=0 p2=0', 1, ['### Findings', 'None.', '', '### Requirement gaps', '- **AC2**, "no slot is handed to both."', '  - This holds only while the borrow lock is held.', '', '### Scope', '- No out-of-scope hunks.']);
const judge = { ...ucfg, judgement: 'yes' };
const g1 = undraftCall(tk(), draft(g1Body), judge);
t('DS-319 AC1 a review at the head with only gaps is a findings call under autopilot-judgement yes', `${g1?.call} ${g1?.verdict?.gaps} ${g1?.action}`, 'findings 1 settle the findings or gaps on #702');
t('DS-319 AC1 found before red checks', undraftCall(tk(), draft(g1Body, { checks: [red('tests', '9')] }), judge)?.call, 'findings');
const rg1 = reviewFix(tk(), { pr: 702, head: HEAD, verdict: g1.verdict, body: g1.review }, { judgement: 'yes' });
t('DS-319 AC1 requeued for try 1 of 2, of kind review', `${rg1?.call} ${rg1?.fix.try}/${rg1?.fix.of} ${rg1?.fix.kind} ${rg1?.fix.what}`, 'requeue 1/2 review review not clean: 1 gap');
t('DS-319 AC1 the gap is quoted from the review, its sub-points with it, and no other section', JSON.stringify(rg1?.fix.gaps), JSON.stringify([AC2]));
const briefG = fixBrief(tk({ fix: rg1.fix }));
t('DS-319 AC1 the brief quotes the gap', briefG.includes(`- Gap: ${AC2}`), true);
t('DS-319 AC1 and asks for no P0 or P1 fix', briefG.includes('Fix each P0 and P1'), false);
t('DS-319 AC2 the brief says the call is the worker\'s, recorded as a decision, in the PR body and on the ticket', ['AUTOPILOT_DECISION', 'Decisions taken in the PR body', 'comment it on the ticket'].every((x) => briefG.includes(x)), true);
t('DS-319 AC3 the brief parks a gap that needs a product or another person\'s ruling', briefG.includes('needs a product ruling or another person\'s is not yours: park with that question (AUTOPILOT_PARK)'), true);
const taskG = fixTask(tk({ fix: rg1.fix }));
t('DS-319 AC2 the task closes each gap and reviews the new head again', taskG.includes('close each requirement gap it quotes') && taskG.includes('review the new head with desk-review and post that review on the PR'), true);
t('DS-319 AC2 and lets the worker comment on the ticket', taskG.includes('leave the ticket\'s Jira status as it is, apart from the comments recording your calls'), true);
t('DS-319 AC4 without autopilot-judgement yes, gaps stay for the person', `${undraftCall(tk(), draft(g1Body), ucfg)?.call} ${reviewFix(tk(), { pr: 702, head: HEAD, verdict: g1.verdict, body: g1Body })}`, 'person null');
t('DS-319 AC4 nor under ask', undraftCall(tk(), draft(g1Body), { ...ucfg, judgement: 'ask' })?.call, 'person');
const tried = [{ try: 1, head: 'b'.repeat(40), kind: 'review' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }];
const rg5 = reviewFix(tk({ fix_tries: tried }), { pr: 702, head: HEAD, verdict: g1.verdict, body: g1Body }, { judgement: 'yes' });
t('DS-319 AC5 after 2 tries it is stuck, with the gap the last try\'s review gives', `${rg5?.call} | ${rg5?.why}`, `stuck | review not clean after 2 fix tries: 1 gap — ${AC2}`);
t('DS-319 a review counting a gap it does not list is left for the person', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { gaps: '1' }, body: gapBody('p0=0 p1=0 p2=0', 1, ['### Requirement gaps', 'None.']) }, { judgement: 'yes' }), null);
const p1g = reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '1', gaps: '1' }, body: p1Body }, { judgement: 'yes' });
t('DS-319 a P1 and a gap go in one try, both quoted', `${p1g?.fix.what} | ${p1g?.fix.findings.length} | ${p1g?.fix.gaps}`, 'review not clean: 1 P1, 1 gap | 1 | AC3: src/csv.ts:4 no VAT column');
t('DS-319 the terminal report\'s gaps are read, and an unverified code claim is not a gap', JSON.stringify(reviewGaps('REQUIREMENT GAPS (2, 1 unverified)  ABC-123\n AC3: "export includes VAT" — no VAT column\n AC1: "keyed per tenant" — UNVERIFIED CODE CLAIM, terminal only\n\nUNPROVEN PREMISES (1)\n src/a.ts:1 assumes retries')), JSON.stringify(['AC3: "export includes VAT" — no VAT column']));

process.exit(fails ? 1 : 0);
