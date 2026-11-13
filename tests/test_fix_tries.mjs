// suite: fix tries (a red or conflicted ready PR goes back to a worker, twice)
import { readFileSync } from 'node:fs';
import { fixCall, gateTry, fixBrief, fixTask, parseOperatorChecks, reviewFindings, reviewFix, reviewGaps, reviewTry, verdictTry, draftChecksFix, conflictFix, syncFix, captureTry, failedSteps, stuckWhy, personReviewFix, personGapsCall, personGapsIn, gapsFix, feedbackFix, resolvable, feedbackReply, FIX_TRIES_MAX, REVIEW_TRIES_CEILING } from '../desk/bin/fix-tries.mjs';
import { undraftCall, undraftComment, movedByBase, buildCall } from '../desk/bin/undraft.mjs';
import { readVerdict, readThreads, localReviewSet } from '../desk/bin/review-threads.mjs';
import { pullbotRound, PULLBOT_SHA, PULLBOT_CLEAN_COUNTS } from './fixtures/pullbot-review.mjs';
import { errorLinesIn } from '../desk/bin/evidence.mjs';
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
t('AC5 or the conflict, after 2 conflict tries', fixCall(tk({ fix_tries: two.map((x) => ({ ...x, kind: 'conflict' })) }), dirty, ctx())?.why, 'still in conflict with main after 2 fix tries');

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
t('DS-281 AC2 a P1 review of an older head is not this head\'s findings: the head goes to a review worker (DS-316)', undraftCall(tk(), draft(p1Body, { head: 'b'.repeat(40) }), ucfg)?.call, 'review');
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
t('DS-281 AC4 a try already made for this head is not made again', reviewFix(tk({ fix_tries: [{ try: 1, head: HEAD, kind: 'review' }] }), { pr: 702, head: HEAD, verdict: { p1: '1' } })?.why, 'review not clean after 1 fix try (1 review): 1 P1');
const r5 = reviewFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }] }), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '1' } });
t('DS-281 AC5 after 2 tries it is stuck, with the P1 count', `${r5?.call} | ${r5?.why}`, 'stuck | review not clean after 2 fix tries (2 review): 1 P1');
const r3Body = ['<!-- desk-review:local -->', `<!-- desk-review:verdict v=1 sha=${HEAD} p0=0 p1=1 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex-cross round=3 -->`,
  `**desk-review, round 3 (fix range ddddddd..aaaaaaa): 1 P1 at \`aaaaaaa\`** · codex read the diff cold`, `<!-- desk-review:carried v=1 p2=1 since=${'d'.repeat(40)} -->`, '', '- **P1** `src/b.ts:3` second formatter'].join('\n');
const u335 = undraftCall(tk(), draft(r3Body), ucfg);
const f335 = reviewFix(tk(), { pr: 702, head: HEAD, verdict: u335?.verdict, body: u335?.review });
t('DS-335 AC1 a worker\'s round-3 review with a P1 at the head goes to a fix try with that finding', `${u335?.call} ${f335?.call} ${f335?.fix.try}/${f335?.fix.of} ${JSON.stringify(f335?.fix.findings)}`, 'findings requeue 1/2 [{"sev":"P1","text":"- **P1** `src/b.ts:3` second formatter"}]');
const r335 = reviewFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }] }), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '1' }, body: p1Body });
t('DS-335 AC2 once the tries are spent, the stuck text names each finding with its file:line', r335?.why, 'review not clean after 2 fix tries (2 review): 1 P1 — P1: packages/core/src/money.ts:12         second currency formatter — packages/core/src/format.ts:8 is the original');
const p2only = undraftCall(tk(), draft(reviewBody('p0=0 p1=0 p2=2')), ucfg);
t('DS-281 AC6 only P2s it lists nowhere: not a findings call, the person settles them as today', `${p2only?.call} ${p2only?.action}`, 'person settle the findings or gaps on #702');
t('DS-433 a review counting P2s it lists nowhere is left to the person', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '0', p2: '2' } }), null);
const p1p2 = reviewBody('p0=0 p1=1 p2=1', ['P1 (1)', ' src/a.ts:3  second formatter', 'P2 (1)', ' src/pager.ts:1  no consumer']);
const p2Listed = reviewBody('p0=0 p1=0 p2=1', ['P2 (1)', ' src/pager.ts:1   no consumer outside its own story']);
const p2Verdict = { p0: '0', p1: '0', p2: '1', deferred: '0' };
t('DS-433 only P2s it lists: a findings call, for a fix worker, reversing DS-281 AC6', undraftCall(tk(), draft(p2Listed), ucfg)?.call, 'findings');
const p2Fix = reviewFix(tk(), { pr: 702, head: HEAD, verdict: p2Verdict, body: p2Listed });
t('DS-433 an uncarried P2 it lists goes to a fix worker, quoted', `${p2Fix?.call} ${p2Fix?.fix.kind} ${p2Fix?.fix.what} ${p2Fix?.fix.findings[0].sev}`, 'requeue review review not clean: 1 P2 P2');
t('DS-433 its brief says fix it, or carry it in the next round', fixBrief(tk({ fix: p2Fix.fix })).includes('Fix each P2 finding it lists, or carry one in your next review'), true);
t('DS-433 and does not take that back', fixBrief(tk({ fix: p2Fix.fix })).includes('not part of this try'), false);
t('DS-433 a P1 try\'s brief still leaves its P2s out', fixBrief(tk({ fix: reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '1', p2: '1' }, body: p1p2 }).fix })).includes('Its P2 findings are not part of this try.'), true);
t('DS-433 its task names the P2, not a P0 or P1, and offers the same carry', /fix each P2 finding it quotes, or carry one in your review of the new head/.test(fixTask(tk({ fix: p2Fix.fix }))), true);
const deferredBody = p2Listed.replace('deferred=0', 'deferred=1');
t('DS-433 a P2 deferred on purpose is the person\'s', `${reviewFix(tk(), { pr: 702, head: HEAD, verdict: { ...p2Verdict, deferred: '1' }, body: p2Listed })} ${undraftCall(tk(), draft(deferredBody), ucfg)?.call}`, 'null person');
t('DS-433 beside a P1, only the P1 is quoted: P2s wait for nothing worse', JSON.stringify(reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '1', p2: '1' }, body: p1p2 })?.fix.findings.map((x) => x.sev)), '["P1"]');
const p2Spent = reviewFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }] }), { pr: 702, head: HEAD, verdict: p2Verdict, body: p2Listed });
t('DS-433 once the tries are spent, it is the person\'s, naming the P2', /^review not clean after 2 fix tries \(2 review\): 1 P2 — P2: src\/pager\.ts:1/.test(p2Spent?.why ?? ''), true);
const mixedTries = [{ try: 1, head: 'b'.repeat(40), kind: 'checks', what: 'red: Lint' }];
t('DS-384 a checks try leaves a review fix its own tries: the review try is try 1', reviewFix(tk({ fix_tries: mixedTries }), { pr: 702, head: HEAD, verdict: { p1: '1' }, body: p1Body })?.fix.try, 1);
t('DS-281 AC7 and a review try counts toward a checks try', fixCall(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }] }), both, ctx())?.why, 'still red after 2 fix tries: Backend tests, Lint');

// ---- a review fix has tries of its own: a conflict try and a re-review try before it leave them
// DS-379's fix_tries as the queue recorded them on PR #348.
const ds379 = [{ try: 1, head: 'f73edbe' + '0'.repeat(33), kind: 'conflict', what: 'draft conflicts with main' },
  { try: 2, head: '597a520' + '0'.repeat(33), kind: 'rereview', what: 'review its head: its review verdict is for fdcfe56, not the head 597a520' }];
const p0At = (head) => ({ pr: 348, head, verdict: { p0: '1', p1: '0' }, body: reviewBody('p0=1 p1=0 p2=0', ['- **P0** `desk/bin/evidence.mjs:40` a code span splits the cell']) });
// The overall cap, with a check try in the conflict try's place: since DS-435 a conflict's tries are its
// own, so count toward neither of a review fix's caps.
const capped379 = [{ ...ds379[0], kind: 'checks', what: 'red: tests' }, ds379[1]];
t('DS-435 after DS-379\'s conflict try and rereview try, a P0 at the head gets both review fix tries', `${reviewFix(tk({ fix_tries: ds379 }), p0At(ds379[1].head))?.fix.try}/${reviewFix(tk({ fix_tries: ds379 }), p0At(ds379[1].head))?.fix.of}`, '1/2');
const a1 = reviewFix(tk({ fix_tries: capped379 }), p0At(ds379[1].head));
t('DS-558 AC2 after a check try and a rereview try, a P0 at the head goes to a review fix worker with both its tries', `${a1?.call} ${a1?.fix.kind} ${a1?.fix.try}/${a1?.fix.of}`, 'requeue review 1/2');
t('DS-384 AC1 the try quotes the P0', a1?.fix.findings.map((x) => x.text).join('|'), '- **P0** `desk/bin/evidence.mjs:40` a code span splits the cell');
t('DS-384 AC1 its brief says a finding it quotes that the next review still lists goes to the person', fixBrief(tk({ fix: a1.fix })).includes('This is try 1 of 2. A finding quoted here that the review of your new head still lists goes to the person.'), true);
const twoChecks = [{ ...ds379[0], kind: 'checks', what: 'red: tests' }, { try: 2, head: 'e'.repeat(40), kind: 'checks', what: 'red: tests' }];
t('DS-384 AC1 after two check tries, a P0 goes to a review fix worker, as its last try', `${reviewFix(tk({ fix_tries: twoChecks }), p0At(HEAD))?.fix.try}/${reviewFix(tk({ fix_tries: twoChecks }), p0At(HEAD))?.fix.of}`, '1/1');
const reviewTries = (n, from = 3) => Array.from({ length: n }, (_, i) => ({ try: i + 1, head: `${from + i}`.repeat(40), kind: 'review' }));
const afterOne = reviewFix(tk({ fix_tries: [ds379[0]] }), p0At(HEAD));
t('DS-384 one conflict try leaves a review fix both its tries', `${afterOne?.fix.try}/${afterOne?.fix.of}`, `1/${FIX_TRIES_MAX}`);
const a2 = reviewFix(tk({ fix_tries: reviewTries(FIX_TRIES_MAX) }), p0At(HEAD));
t('DS-384 AC2 once its review fix tries are spent, findings at the head go to the person', `${a2?.call} | ${a2?.why}`, 'stuck | review not clean after 2 fix tries (2 review): 1 P0 — P0: - **P0** `desk/bin/evidence.mjs:40` a code span splits the cell');
const a3 = reviewFix(tk({ fix_tries: [...twoChecks, ...reviewTries(1)] }), p0At(HEAD));
t('DS-384 AC3 with a review try of its own left but the overall cap reached, it goes to the person, naming the tries by kind', `${a3?.call} | ${a3?.why.split(':')[0]}`, 'stuck | review not clean after 3 fix tries (2 checks, 1 review)');
t('DS-558 AC2 a rereview try does not count toward the overall cap', reviewFix(tk({ fix_tries: [...capped379, ...reviewTries(1)] }), p0At(HEAD))?.fix?.try, 2);
const ex = reviewFix(tk({ fix_tries: [ds379[0], { try: 1, head: 'e'.repeat(40), kind: 'checks', extra: true }, ...reviewTries(1)] }), p0At(HEAD));
t('DS-384 AC3 an extra fix try counts toward neither cap', `${ex?.call} ${ex?.fix?.try}/${ex?.fix?.of}`, 'requeue 2/2');
const cap = reviewFix(tk({ fix_tries: [{ try: 1, head: 'f'.repeat(40), kind: 'capture' }, ...twoChecks, ...reviewTries(1)] }), p0At(HEAD));
t('DS-384 a capture try is not counted or named among the tries by kind', cap?.why.split(':')[0], 'review not clean after 3 fix tries (2 checks, 1 review)');

// ---- a review fix try that cleared what it quoted does not use up the tries; one that did not, ends them
// PR #367's three rounds: try 1 quoted round 1's finding at pass.mjs:617, try 2 round 2's gap, and the
// round 3 review at 84b7205, below as posted, found a new P0 in try 2's fix. The tries quote the lines
// round 3's "Earlier rounds" gives for them.
const H367 = ['914abdf' + '0'.repeat(33), 'df514a5' + '0'.repeat(33)], AT367 = '84b7205801472d6c86411ec57f439a8616fefd1b';
const ds367 = [{ try: 1, head: H367[0], kind: 'review', findings: [{ sev: 'P1', text: '- a park that names a Check builds check but also asks something else was recorded done (`desk/bin/pass.mjs:617`)' }] },
  { try: 2, head: H367[1], kind: 'review', gaps: ['every park names the steps it did not reach, so a realistic build-only park stayed parked'] }];
const p0_367 = '**F1 · P0 · `desk/bin/undraft.mjs:248`** (codex; CONFIRMED by ada-devils-advocate)';
const body367 = ['<!-- desk-review:local -->',
  `<!-- desk-review:verdict v=1 sha=${AT367} p0=1 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex-cross round=3 -->`,
  '**desk-review, round 3, fix range df514a5..84b7205: not clean: 1 P0 outstanding at `84b7205`** · codex read the diff cold · refuted cross-vendor',
  '<!-- desk-review:carried v=1 p2=0 since=df514a54fbfe14fd684fb30049d884b9e6898def -->', '<!-- desk-review:method v=1 fallback=0 -->', '',
  'Bar: default@84b7205 (`skills/desk-review/references/review-bar.md`). Review experts: none.', '',
  '## Outstanding', '', p0_367, '',
  '`buildPark`\'s test for the steps a park did not reach has no anchor. Two examples:', '',
  '- `Before the remaining steps, should we delete the existing customer records or preserve them?`', '',
  '## Earlier rounds', '',
  '- **Round 1 at `914abdf`** (lena, mira, bea, general-purpose simplicity, codex cold). Four P2s, all fixed in `df514a5`:',
  '  - a park that names a Check builds check but also asks something else was recorded done (`desk/bin/pass.mjs:617`)',
  '  - ticket IDs in code comments (`desk/bin/pass.mjs:616`, `desk/bin/undraft.mjs:235`)',
  '- **Round 2 at `df514a5`** (lena, bea, codex). Bea raised a requirement gap. Fixed in `84b7205`.'].join('\n');
const round3 = { pr: 367, head: AT367, verdict: { p0: '1', p1: '0' }, body: body367 };
t('DS-414 AC4 round 3\'s P0 as posted, under its F1 label, is read, and the earlier rounds\' lines are not', reviewFindings(body367).map((x) => `${x.sev} ${x.text}`).join('|'), `P0 ${p0_367}`);
const b1 = reviewFix(tk({ fix_tries: ds367 }), round3);
t('DS-414 AC1 AC4 after two tries that each cleared their findings, a new P0 goes to a fix worker, quoting it', `${b1?.call} ${b1?.fix?.try}/${b1?.fix?.of} ${b1?.fix?.findings?.map((x) => x.text).join('|')}`, `requeue 3/${REVIEW_TRIES_CEILING} ${p0_367}`);
const route = (at) => ({ pr: 702, head: HEAD, verdict: { p1: '1' }, body: reviewBody('p0=0 p1=1 p2=0', [`- **P1** \`${at}\` cart total unrounded`]) });
t('DS-414 a path holding brackets is matched whole: a finding at another route\'s same line did not survive', reviewFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review', findings: [{ sev: 'P1', text: 'app/[account]/page.tsx:12 stale balance' }] }] }), route('app/[product]/page.tsx:12'))?.call, 'requeue');
t('DS-414 and one at the same route and line did', reviewFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review', findings: [{ sev: 'P1', text: '- **P1** `app/[id]/(shop)/page.tsx:12` stale balance' }] }] }), route('app/[id]/(shop)/page.tsx:12'))?.call, 'stuck');
t('DS-414 a file:line an older try quoted, whose next review cleared it, is not a survivor at a later head', reviewFix(tk({ fix_tries: [{ ...ds367[0], findings: [{ sev: 'P1', text: 'desk/bin/undraft.mjs:248 reads the review of an older head' }] }, ds367[1]] }), round3)?.call, 'requeue');
t('DS-414 two findings sharing only their seat\'s attribution are not the same text', reviewFix(tk({ fix_tries: [ds367[1], { try: 2, head: 'c'.repeat(40), kind: 'review', findings: [{ sev: 'P0', text: '**F1 · P0 · `src/a.ts:3`** (codex; CONFIRMED by ada-devils-advocate)' }] }] }), round3)?.call, 'requeue');
const kept = { ...ds367[1], findings: [{ sev: 'P0', text: 'desk/bin/undraft.mjs:248 tail regex is not anchored' }] };
const b2 = reviewFix(tk({ fix_tries: [ds367[0], kept] }), round3);
t('DS-414 AC2 a P0 at the file:line the previous try quoted survived it: stuck, naming it', `${b2?.call} | ${b2?.why}`,
  `stuck | review not clean after 2 fix tries (2 review): 1 P0 — still open after the fix try that quoted it: P0: ${p0_367}`);
const said3 = { ...round3, body: reviewBody('p0=1 p1=0 p2=0', ['- **P0** `desk/bin/undraft.mjs:248` unanchored tail regex matches a longer check name']) };
t('DS-414 AC2 so is one an earlier try quoted with the same text at another line', reviewFix(tk({ fix_tries: [{ ...ds367[0], findings: [{ sev: 'P0', text: 'desk/bin/undraft.mjs:240 unanchored tail regex matches a longer check name' }] }, ds367[1]] }), said3)?.call, 'stuck');
const ceiling = Array.from({ length: REVIEW_TRIES_CEILING }, (_, i) => ({ try: i + 1, head: `${i + 3}`.repeat(40), kind: 'review', findings: [{ sev: 'P1', text: `src/r${i}.ts:${i + 1} round ${i + 1}` }] }));
const b3 = reviewFix(tk({ fix_tries: ceiling }), round3);
t('DS-414 AC3 at the ceiling of review fix tries a review still not clean goes to the person, naming the ceiling', `${b3?.call} | ${b3?.why}`,
  `stuck | review not clean after ${REVIEW_TRIES_CEILING} fix tries (${REVIEW_TRIES_CEILING} review), the most review fix tries a PR may make: 1 P0 — P0: ${p0_367}`);
t('DS-414 one below the ceiling is the last try', `${reviewFix(tk({ fix_tries: ceiling.slice(1) }), round3)?.fix?.try}/${reviewFix(tk({ fix_tries: ceiling.slice(1) }), round3)?.fix?.of}`, `4/${REVIEW_TRIES_CEILING}`);
t('DS-414 a cleared review try leaves room under the overall cap after a conflict and a rereview try', `${reviewFix(tk({ fix_tries: [...ds379, ds367[0]] }), round3)?.fix?.try}`, '2');

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
t('DS-319 AC3 the brief parks a gap that needs a product or another person\'s ruling', briefG.includes('needs a product ruling or another person\'s, as the worker contract\'s Ask or take sorts it') && briefG.includes('is not yours: park with that question (AUTOPILOT_PARK)'), true);
t('DS-319 AC2 a call that leaves the code as it is is committed empty, so the fresh review has a new head', briefG.includes('commit it on its own with git commit --allow-empty, the call and its reason as the message'), true);
const taskG = fixTask(tk({ fix: rg1.fix }));
t('DS-319 AC2 the task closes each gap and reviews the new head again', taskG.includes('close each requirement gap it quotes') && taskG.includes('review the new head with desk-review and post that review on the PR'), true);
t('DS-319 AC2 and lets the worker comment on the ticket', taskG.includes('leave the ticket\'s Jira status as it is, apart from the comments recording your calls'), true);
t('DS-319 AC4 without autopilot-judgement yes, gaps stay for the person', `${undraftCall(tk(), draft(g1Body), ucfg)?.call} ${reviewFix(tk(), { pr: 702, head: HEAD, verdict: g1.verdict, body: g1Body })}`, 'person null');
t('DS-319 AC4 nor under ask', undraftCall(tk(), draft(g1Body), { ...ucfg, judgement: 'ask' })?.call, 'person');
const tried = [{ try: 1, head: 'b'.repeat(40), kind: 'review' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }];
const rg5 = reviewFix(tk({ fix_tries: tried }), { pr: 702, head: HEAD, verdict: g1.verdict, body: g1Body }, { judgement: 'yes' });
t('DS-319 AC5 after 2 tries it is stuck, with the gap the last try\'s review gives', `${rg5?.call} | ${rg5?.why}`, `stuck | review not clean after 2 fix tries (2 review): 1 gap — ${AC2}`);
t('DS-414 AC2 a gap the previous try quoted that the review still lists survived it', reviewFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review', gaps: [AC2] }] }), { pr: 702, head: HEAD, verdict: g1.verdict, body: g1Body }, { judgement: 'yes' })?.why,
  `review not clean after 1 fix try (1 review): 1 gap — still open after the fix try that quoted it: ${AC2}`);
t('DS-319 a review counting a gap it does not list is left for the person', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { gaps: '1' }, body: gapBody('p0=0 p1=0 p2=0', 1, ['### Requirement gaps', 'None.']) }, { judgement: 'yes' }), null);
const p1g = reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '1', gaps: '1' }, body: p1Body }, { judgement: 'yes' });
t('DS-319 a P1 and a gap go in one try, both quoted', `${p1g?.fix.what} | ${p1g?.fix.findings.length} | ${p1g?.fix.gaps}`, 'review not clean: 1 P1, 1 gap | 1 | AC3: src/csv.ts:4 no VAT column');
t('DS-319 the terminal report\'s gaps are read, and an unverified code claim is not a gap', JSON.stringify(reviewGaps('REQUIREMENT GAPS (2, 1 unverified)  ABC-123\n AC3: "export includes VAT" — no VAT column\n AC1: "keyed per tenant" — UNVERIFIED CODE CLAIM, terminal only\n\nUNPROVEN PREMISES (1)\n src/a.ts:1 assumes retries')), JSON.stringify(['AC3: "export includes VAT" — no VAT column']));
t('DS-319 a bold-only heading opens and ends the gaps section', JSON.stringify(reviewGaps('**Requirement gaps**\n- AC1: "x" — not done\n**Scope**\n- src/a.ts:3 out of scope')), JSON.stringify(['AC1: "x" — not done']));
// ---- a gap the review tags as only the person's call earns no fix try
const PERSON_GAP = `- PERSON'S CALL · AC2: "the pass tries the push" — only the person can accept it or amend AC2`;
const CODE_GAP = '- AC3: "export includes VAT" — no VAT column';
const personBody = (gaps, ...items) => gapBody('p0=0 p1=0 p2=0', gaps, ['### Requirement gaps', ...items, '', '### Scope', '- No out-of-scope hunks.']);
const gapFix = (body, gaps, done = [], counts = {}) => reviewFix(tk({ fix_tries: done }), { pr: 702, head: HEAD, verdict: { gaps: String(gaps), ...counts }, body }, { judgement: 'yes' });
const onlyPerson = personBody(1, PERSON_GAP);
t('DS-513 AC1 a verdict whose only gap is the person\'s call spawns no fix try', gapFix(onlyPerson, 1), null);
t('DS-513 AC1 and stays the findings call the person answers', `${undraftCall(tk(), draft(onlyPerson), judge)?.call} ${undraftCall(tk(), draft(onlyPerson), judge)?.why.match(/gaps=\d/)?.[0]}`, 'findings gaps=1');
t('DS-513 AC1 tries already spent change nothing: it is not a stuck try', gapFix(onlyPerson, 1, tried), null);
t('DS-513 AC1 a curly apostrophe is the same tag', gapFix(personBody(1, PERSON_GAP.replace("'", '’')), 1), null);
t('DS-513 AC1 prose after a tagged gap earns no try: the verdict counts one gap', gapFix(personBody(1, PERSON_GAP, '', 'The requirements seat agrees the code is right.'), 1), null);
const codeOnly = gapFix(personBody(1, CODE_GAP), 1);
t('DS-513 AC2 a gap code can close spawns a try as before', `${codeOnly?.call} ${codeOnly?.fix.what} ${JSON.stringify(codeOnly?.fix.gaps)} ${codeOnly?.fix.person_gaps}`, `requeue review not clean: 1 gap ${JSON.stringify([CODE_GAP.slice(2)])} undefined`);
t('DS-513 AC2 a gap merely saying the person might care is a code gap', gapFix(personBody(1, '- AC3: the person\'s call on VAT was recorded, but no column'), 1)?.call, 'requeue');
const bothGaps = gapFix(personBody(2, PERSON_GAP, CODE_GAP), 2);
t('DS-513 AC3 with both kinds the try is aimed only at the gap code can close', `${bothGaps?.call} ${bothGaps?.fix.what} ${JSON.stringify(bothGaps?.fix.gaps)}`, `requeue review not clean: 1 gap ${JSON.stringify([CODE_GAP.slice(2)])}`);
t('DS-513 AC3 the person\'s gap is kept on the try', JSON.stringify(bothGaps?.fix.person_gaps), JSON.stringify([PERSON_GAP.slice(2)]));
const bothBrief = fixBrief(tk({ fix: bothGaps.fix }));
t('DS-513 AC3 the brief quotes the code gap to close and tells the worker to leave the person\'s', [`- Gap: ${CODE_GAP.slice(2)}`, 'not part of this try', `- ${PERSON_GAP.slice(2)}`].every((x) => bothBrief.includes(x)) && !bothBrief.includes(`- Gap: ${PERSON_GAP.slice(2)}`), true);
const findingAndPerson = gapFix(`${p1Body}\n\n### Requirement gaps\n${PERSON_GAP}`, 1, [], { p0: '0', p1: '1' });
t('DS-513 AC3 a P1 beside the person\'s gap gets its try, the gap carried', `${findingAndPerson?.fix.what} | ${findingAndPerson?.fix.findings.length} | ${findingAndPerson?.fix.gaps} | ${findingAndPerson?.fix.person_gaps?.length}`, 'review not clean: 1 P1 | 1 | undefined | 1');
t('DS-513 AC3 out of tries, the stuck reason names the person\'s gap too', gapFix(personBody(2, PERSON_GAP, CODE_GAP), 2, tried)?.why.includes(PERSON_GAP.slice(2)), true);
t('DS-513 AC3 a code gap that survived its try goes to the person with the person\'s gap', gapFix(personBody(2, PERSON_GAP, CODE_GAP), 2, [{ try: 1, head: 'b'.repeat(40), kind: 'review', gaps: [CODE_GAP.slice(2)] }])?.why.includes(PERSON_GAP.slice(2)), true);
const stuckBeside = gapFix(`${p1Body}\n\n### Requirement gaps\n${PERSON_GAP}`, 1, tried, { p0: '0', p1: '1' });
const sentBack = personReviewFix(tk(), { pr: 702, head: HEAD, why: stuckBeside?.why });
t('DS-513 AC3 a try the person sends for the finding is not aimed at the person\'s gap', `${stuckBeside?.why.includes(PERSON_GAP.slice(2))} ${sentBack?.findings.length} ${sentBack?.findings.some((x) => x.text.includes('PERSON'))}`, 'true 1 false');
t('DS-513 without autopilot-judgement yes nothing changes', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { gaps: '1' }, body: onlyPerson }), null);
const gapsCall = (body, verdict, opts = { judgement: 'yes' }) => personGapsCall({ verdict, body }, opts);
t('DS-513 a ready PR with only the person\'s gaps is stuck on them, its reason readable', JSON.stringify(personGapsIn(gapsCall(onlyPerson, { gaps: '1' })?.why)), JSON.stringify([PERSON_GAP.slice(2)]));
t('DS-513 AC3 a review stuck reason gives up the person\'s gap it carries', JSON.stringify(personGapsIn(stuckBeside?.why)), JSON.stringify([PERSON_GAP.slice(2)]));
t('DS-513 a ready PR with a code gap beside the person\'s is not stuck on them', gapsCall(personBody(2, PERSON_GAP, CODE_GAP), { gaps: '2' }), null);
t('DS-513 nor with a finding beside the person\'s gap', gapsCall(onlyPerson, { gaps: '1', p1: '1' }), null);
t('DS-513 nor a P2', gapsCall(onlyPerson, { gaps: '1', p2: '1' }), null);
t('DS-513 a deferred P2 earns no try, so the person\'s gap still reaches them', gapsCall(onlyPerson, { gaps: '1', p2: '1', deferred: '1' })?.call, 'stuck');
t('DS-513 nor with no gap counted', gapsCall(onlyPerson, { gaps: '0' }), null);
t('DS-513 nor without autopilot-judgement yes', gapsCall(onlyPerson, { gaps: '1' }, {}), null);
t('DS-513 another stuck reason is not a person\'s-gaps reason', personGapsIn('review not clean after 2 fix tries: 1 P1 — P1: src/a.ts:1 quotes PERSON\'S CALL').length, 0);
const readyCall = tk({ fix: gapsFix({ pr: 702, head: HEAD, ready: true, answer: 'accept it' }) });
t('DS-513 the person\'s call on a ready PR keeps it out of draft', `${fixBrief(readyCall).includes('open and out of draft')} ${/leave the PR out of draft/.test(fixTask(readyCall))}`, 'true true');
t('DS-319 the findings parser ends a P1 run at the same bold heading, and a bold finding with its file:line still counts', JSON.stringify(reviewFindings('P1 (2)\n**src/a.ts:4 — dup**\n**Requirement gaps**\n- AC1: src/b.ts:9 not done').map((x) => x.text)), JSON.stringify(['**src/a.ts:4 — dup**']));

// ---- DS-316: a draft with no verdict readable at its head goes to a review worker, a red one to a fix worker
const OLD = 'b'.repeat(40);
const plainReview = draft('Verdict: p0=0 p1=0 gaps=0');
t('DS-316 AC3 a review with no desk-review verdict line is a review call', `${undraftCall(tk(), plainReview, ucfg)?.call} | ${undraftCall(tk(), plainReview, ucfg)?.why}`, 'review | no desk-review verdict is posted on it');
t('DS-316 AC3 so is a draft with no review at all', undraftCall(tk(), { ...plainReview, reviews: [] }, ucfg)?.call, 'review');
const rv1 = reviewTry(tk(), { pr: 702, head: HEAD, why: 'no desk-review verdict is posted on it' });
t('DS-316 AC2 a review worker is requeued for try 1 of 2, of kind rereview', `${rv1?.call} ${rv1?.fix.try}/${rv1?.fix.of} ${rv1?.fix.kind} ${rv1?.fix.head === HEAD}`, 'requeue 1/2 rereview true');
const briefRv = fixBrief(tk({ fix: rv1.fix }));
t('DS-316 AC2 its brief says why and asks for a desk-review posted on the head, with no code change', briefRv.includes('## Review try 1 of 2: PR #702') && briefRv.includes(`at its head ${HEAD.slice(0, 12)}: no desk-review verdict is posted on it.`) && briefRv.includes('Review that head with desk-review and post the review on the PR') && briefRv.includes('Change no code'), true);
const taskRv = fixTask(tk({ fix: rv1.fix }));
t('DS-316 AC2 its task is the review try, leaving the PR in draft', taskRv.includes('review try 1 of 2 on PR #702') && taskRv.includes('change no code') && taskRv.includes('leave the PR in draft') && !taskRv.includes('git push'), true);
const rvTried = [{ try: 1, head: HEAD, kind: 'rereview' }];
const rv2 = reviewTry(tk({ fix_tries: rvTried }), { pr: 702, head: HEAD, why: 'no desk-review verdict is posted on it' });
t('DS-558 a review try already made at this head leaves it a second', `${rv2?.call} ${rv2?.fix.try}/${rv2?.fix.of} ${rv2?.fix.kind}`, 'requeue 2/2 rereview');
t('DS-558 the second try\'s brief says it is the last at this head, and not a fix try', fixBrief(tk({ fix: rv2.fix })).includes('This is review try 2 of 2 at this head, and not one of the fix tries. A PR with no verdict readable at its head after it goes to the person'), true);
t('DS-558 the first try\'s brief says one more follows', briefRv.includes('This is review try 1 of 2 at this head, and not one of the fix tries. A PR with no verdict readable at its head after it gets one more review try there.'), true);
const rvTwice = [...rvTried, { try: 2, head: HEAD, kind: 'rereview' }];
t('DS-558 AC3 two review tries at this head that posted nothing readable leave it to the person, naming the review failure', reviewTry(tk({ fix_tries: rvTwice }), { pr: 702, head: HEAD, why: 'no desk-review verdict is posted on it' })?.why, 'no review verdict readable at its head after 2 review tries at it: no desk-review verdict is posted on it');
const saidTwice = tk({ fix_tries: rvTwice, fix: { ...rvTwice[1], finished: true }, result: { summary: 'pr=702 jira=In Review gh pr review refused: 502' } });
t('DS-558 AC3 and what the last review try said', reviewTry(saidTwice, { pr: 702, head: HEAD, why: 'x' })?.why, 'no review verdict readable at its head after 2 review tries at it: x; the last try said: pr=702 jira=In Review gh pr review refused: 502');
const ac1 = reviewTry(tk({ fix_tries: tried }), { pr: 702, head: HEAD, why: 'its review verdict is for bbbbbbbbb, not the head aaaaaaaaa' });
t('DS-558 AC1 both fix tries spent, a head whose verdict is for an older head still goes to a review worker', `${ac1?.call} ${ac1?.fix.kind} ${ac1?.fix.try}/${ac1?.fix.of}`, 'requeue rereview 1/2');
const afterReview = fixCall(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'checks' }, { try: 1, head: 'c'.repeat(40), kind: 'rereview' }, { try: 2, head: 'c'.repeat(40), kind: 'rereview' }] }), both, ctx());
t('DS-558 AC2 review tries use no fix try: a red check after a fix try and two review tries gets try 2 of 2', `${afterReview?.call} ${afterReview?.fix.try}/${afterReview?.fix.of}`, 'requeue 2/2');
t('DS-316 a review try at this head does not use up a fix of the findings it then posts', reviewFix(tk({ fix_tries: rvTried }), { pr: 702, head: HEAD, verdict: u1.verdict, body: u1.review })?.call, 'requeue');

// ---- DS-377: a head a merge from the base moved gets a review try of its own, outside the fix tries
const unread = 'its latest review is for ccccccccc, not the head aaaaaaaaa';
const merged = reviewTry(tk({ fix_tries: tried }), { pr: 871, head: HEAD, why: unread, base: 'feat/epics', baseMerge: () => true });
t('DS-377 AC3 tries spent, a head moved by a base merge goes to a review worker, not the person', `${merged?.call} ${merged?.fix.kind} ${merged?.fix.try}/${merged?.fix.of} ${merged?.fix.head === HEAD}`, 'requeue rereview 1/2 true');
t('DS-377 AC3 it says the base merge moved the head', merged?.fix.what, `review its head, moved by a merge from feat/epics: ${unread}`);
const briefX = fixBrief(tk({ fix: merged.fix }));
t('DS-377 AC3 its brief says the try is not one of the fix tries', briefX.includes('## Review try 1 of 2: PR #871') && briefX.includes(`at its head ${HEAD.slice(0, 12)}: ${unread}.`) && briefX.includes('not one of the fix tries'), true);
t('DS-377 AC3 its task names the review try', fixTask(tk({ fix: merged.fix })).includes('Your task is review try 1 of 2 on PR #871'), true);
t('DS-558 a head no base merge moved gets a review try too, and the merge is not asked of a head already tried', reviewTry(tk({ fix_tries: tried }), { pr: 871, head: HEAD, why: unread, baseMerge: () => false })?.fix.what
  + ' | ' + reviewTry(tk({ fix_tries: rvTried }), { pr: 871, head: HEAD, why: unread, baseMerge: () => { throw new Error('asked'); } })?.fix.try, `review its head: ${unread} | 2`);
const afterX = [...tried, { try: 2, head: HEAD, kind: 'rereview', extra: true }];
t('DS-558 an extra review try recorded at the head is one of its two', reviewTry(tk({ fix_tries: afterX }), { pr: 871, head: HEAD, why: unread, baseMerge: () => true })?.fix.try, 2);
const oneX = [{ try: 0, head: OLD, kind: 'rereview', extra: true }];
t('DS-558 a review try at an older head leaves the current head its first review try', reviewTry(tk({ fix_tries: oneX }), { pr: 871, head: HEAD, why: unread })?.fix.try, 1);
// A fake git: `chain` is rev-list's first-parent lines from OLD to HEAD, and `onBase` the ancestry answer.
const MID = 'e'.repeat(40), THEIRS = 'd'.repeat(40);
const git = ({ chain, onBase = true }) => (args) => (args[0] === 'rev-parse' ? { ok: true, out: OLD }
  : args[0] === 'rev-list' ? { ok: true, out: chain.join('\n') } : { ok: args[3] === HEAD || onBase });
const moved = (o) => movedByBase({ from: OLD, head: HEAD, base: 'origin/feat', git: git(o) });
t('DS-377 a head that only merges from the base moved past the last try\'s head moved by the base', moved({ chain: [`${HEAD} ${MID} ${THEIRS}`, `${MID} ${OLD} ${THEIRS}`] }), true);
t('DS-377 AC3 a fix try\'s own commits before the base merge still leave the head moved by the base', moved({ chain: [`${HEAD} ${MID} ${THEIRS}`, `${MID} ${OLD}`] }), true);
t('DS-377 a head a commit of the PR\'s own last moved, or a merge of a branch off the base, is not', moved({ chain: [`${HEAD} ${MID}`, `${MID} ${OLD} ${THEIRS}`] }) || moved({ chain: [`${HEAD} ${OLD} ${THEIRS}`], onBase: false }), false);
t('DS-377 nor is a head that does not come down to the last try\'s head', moved({ chain: [`${HEAD} ${MID} ${THEIRS}`] }), false);
t('DS-377 the last try\'s head is what the base merges are read from', (() => { let from; reviewTry(tk({ fix_tries: tried }), { pr: 871, head: HEAD, why: unread, baseMerge: (f) => { from = f; return false; } }); return from; })(), 'c'.repeat(40));

const redDraft = draft(reviewBody('p0=0 p1=0 p2=0'), { checks: [ok('tests'), red('tests-i18n', '931')] });
const ucheck = undraftCall(tk(), redDraft, { ...ucfg, required: ['tests', 'tests-i18n'] });
t('DS-316 AC4 a red required check is a checks call with the failing check', `${ucheck?.call} ${ucheck?.failing.map((f) => f.name).join(',')}`, 'checks tests-i18n');
const dc = draftChecksFix(tk(), { pr: 702, head: HEAD, failing: ucheck.failing }, { repo: 'acme/widgets', operator });
t('DS-316 AC4 a fix worker is requeued with the check\'s name and run', `${dc?.call} ${dc?.fix.kind} ${dc?.fix.draft} ${dc?.fix.what} ${dc?.fix.checks[0].url}`, 'requeue checks true red: tests-i18n https://github.com/acme/widgets/actions/runs/931');
const briefDc = fixBrief(tk({ fix: dc.fix }));
t('DS-316 AC4 its brief names the draft\'s red check, its run and how to read its log', briefDc.includes('is a draft on this branch, and these required checks are red') && briefDc.includes('- tests-i18n: https://github.com/acme/widgets/actions/runs/931') && briefDc.includes('gh run view <run id> --log-failed') && !briefDc.includes('two reruns'), true);
const taskDc = fixTask(tk({ fix: dc.fix }));
t('DS-316 AC4 its task fixes the cause, keeps the draft and reviews the new head', taskDc.includes('fix the cause, never the check') && taskDc.includes('leave the PR in draft') && taskDc.includes('review the new head with desk-review'), true);
t('DS-316 AC4 a check only an operator fixes is the person\'s, with its command', draftChecksFix(tk(), { pr: 702, head: HEAD, failing: [red('Flows image missing', '9')] }, { repo: 'acme/widgets', operator })?.why, 'Flows image missing · build it: ensure-flows-image.sh');
t('DS-316 AC5 still red at a head a fix try was made for: the person\'s', draftChecksFix(tk({ fix_tries: [{ try: 1, head: HEAD, kind: 'checks' }] }), { pr: 702, head: HEAD, failing: ucheck.failing }, { repo: 'acme/widgets', operator })?.why, 'still red after 1 fix try: tests-i18n');
t('DS-316 a review try at this head does not count as a fix of its checks', draftChecksFix(tk({ fix_tries: rvTried }), { pr: 702, head: HEAD, failing: ucheck.failing }, { repo: 'acme/widgets', operator })?.call, 'requeue');
t('DS-316 nor of a ready PR\'s', fixCall(tk({ fix_tries: rvTried }), both, ctx())?.call, 'requeue');
t('DS-316 an older verdict is not read at the head without a carry', undraftCall(tk(), draft(reviewBody('p0=0 p1=0 p2=0'), { head: OLD }), ucfg)?.call, 'review');

// ---- a draft in conflict with its base goes to a fix worker where §3 lets one resolve it
const cleanBody = reviewBody('p0=0 p1=0 p2=0');
const conflicted = (o = {}) => draft(cleanBody, { mergeable: 'CONFLICTING', mergeState: 'DIRTY', ...o });
const ccfg = (unreviewed, reviewed = 'ask') => ({ ...ucfg, conflictUnreviewed: unreviewed, conflictReviewed: reviewed });
const someone = { author: { login: 'kim' }, body: 'Why not reuse the formatter?' };
const u318 = undraftCall(tk(), conflicted(), ccfg('yes'));
t('DS-318 AC1 no human review and pr-conflict-unreviewed yes: a conflict call', u318?.call, 'conflict');
t('DS-318 AC1 a bot\'s comment is no human review', undraftCall(tk(), conflicted({ comments: [{ author: { login: 'vercel' }, body: 'Preview ready' }, { author: { login: 'codex[bot]' }, body: 'x' }] }), ccfg('yes'))?.call, 'conflict');
t('DS-318 AC1 the person\'s own review, in another case, is no human review', undraftCall(tk(), conflicted({ reviews: [{ author: { login: 'Ben' }, body: cleanBody }] }), ccfg('yes', 'ask'))?.call, 'conflict');
t('DS-318 AC2 a human comment, pr-conflict-reviewed yes: a conflict call', undraftCall(tk(), conflicted({ comments: [someone] }), ccfg('yes', 'yes'))?.call, 'conflict');
const asked = undraftCall(tk(), conflicted({ reviews: [{ author: { login: 'ben' }, body: cleanBody }, someone] }), ccfg('yes', 'ask'));
t('DS-318 AC2 a human review, pr-conflict-reviewed ask: the person\'s as now', `${asked?.call} | ${asked?.action}`, 'person | resolve the conflict on #702; it then needs a fresh review');
t('DS-318 AC3 pr-conflict-unreviewed not yes: the person\'s as now', undraftCall(tk(), conflicted(), ccfg('ask', 'yes'))?.call, 'person');
const cf = conflictFix(tk(), { pr: 702, head: HEAD, base: 'main', files: ['src/a.ts'] });
t('DS-318 AC1 the conflict is requeued for try 1 on the draft', `${cf?.call} ${cf?.fix.try} ${cf?.fix.kind} ${cf?.fix.draft}`, 'requeue 1 conflict true');
const brief318 = fixBrief(tk({ fix: cf.fix }));
t('DS-318 AC1 the brief says it is a draft in conflict and names the files', brief318.includes('is a draft on this branch, and it conflicts with main') && brief318.includes('Conflicting files: src/a.ts.'), true);
const task318 = fixTask(tk({ fix: cf.fix }));
t('DS-318 AC4 the task merges the base, reviews the new head and posts it, and leaves the PR in draft',
  task318.includes('merge origin/main into your branch') && task318.includes('review the new head with desk-review and post that review on the PR') && task318.includes('leave the PR in draft'), true);
const stale318 = undraftCall(tk(), draft(reviewBody('p0=0 p1=0 p2=0'), { head: 'd'.repeat(40) }), ccfg('yes'));
t('DS-318 AC4 the new head\'s old review is stale, so it goes to a review worker (DS-316), never undrafted on it', `${stale318?.call} ${stale318?.why.includes('not the head')}`, 'review true');
t('DS-318 a review try at this head does not count as a conflict fix try, as it does not for a red check', conflictFix(tk({ fix_tries: rvTried }), { pr: 702, head: HEAD, base: 'main' })?.call, 'requeue');
t('DS-318 the brief of a draft\'s last conflict try says it goes to the person still in conflict', brief318.includes('A PR still in conflict after try 2 goes to the person.'), true);
// A conflict counts only conflict tries, as a review fix counts only review fix tries (DS-384).
t('DS-435 a review try leaves the conflict its own tries', conflictFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review' }] }), { pr: 702, head: HEAD, base: 'main' })?.fix.try, 1);
t('DS-435 AC1 two review tries still leave a conflict try', conflictFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'rereview' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }] }), { pr: 702, head: HEAD, base: 'main' })?.call, 'requeue');
t('DS-384 a conflict try leaves a review fix its own tries', reviewFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'conflict' }] }), { pr: 702, head: HEAD, verdict: { p1: '1' }, body: inlineBody, comments: () => [inlineP1] })?.fix.try, 1);
t('DS-318 a try already made for this head is not made again', conflictFix(tk({ fix_tries: [{ try: 1, head: HEAD, kind: 'conflict' }] }), { pr: 702, head: HEAD, base: 'main', files: null })?.why, 'still in conflict with main after 1 fix try');
const c318 = conflictFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'conflict' }, { try: 2, head: 'c'.repeat(40), kind: 'conflict' }] }), { pr: 702, head: HEAD, base: 'main', files: ['src/a.ts', 'src/b.ts'] });
t('DS-318 AC5 after 2 conflict tries it is stuck, naming the files still in conflict', `${c318?.call} | ${c318?.why}`, 'stuck | still in conflict with main after 2 fix tries: src/a.ts, src/b.ts');
t('DS-318 AC5 the conflict task asks the worker for its reason on its DONE line', task318.includes('End with AUTOPILOT_DONE: pr=702 jira=<its status> said=<one line: what you resolved, or what is still in conflict and why>.'), true);
t('DS-318 AC5 and only the conflict task', fixTask(tk({ fix: { try: 1, of: 2, pr: 702, kind: 'review', findings: [] } })).includes('said='), false);
const said318 = { fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'conflict' }, { try: 2, head: 'c'.repeat(40), kind: 'conflict' }], result: { pr: 702, summary: 'pr=702 jira=In Progress said=src/a.ts left unresolved: both sides rename the export' } };
t('DS-318 AC5 and with the reason the last try gave, once its worker has finished',
  conflictFix(tk({ ...said318, fix: { try: 2, kind: 'conflict', draft: true, finished: '2026-10-29T12:00:00Z' } }), { pr: 702, head: HEAD, base: 'main', files: ['src/a.ts'] })?.why,
  'still in conflict with main after 2 fix tries: src/a.ts; the last try said: pr=702 jira=In Progress said=src/a.ts left unresolved: both sides rename the export');
t('DS-318 AC5 the same for a conflict out of draft', fixCall(tk({ ...said318, fix: { try: 2, kind: 'conflict', finished: '2026-10-29T12:00:00Z' } }), dirty, ctx())?.why,
  'still in conflict with main after 2 fix tries; the last try said: pr=702 jira=In Progress said=src/a.ts left unresolved: both sides rename the export');
t('DS-318 AC5 a last try that was not for the conflict gave no reason for it', conflictFix(tk({ ...said318, fix: { try: 2, kind: 'review', finished: '2026-10-29T12:00:00Z' } }), { pr: 702, head: HEAD, base: 'main' })?.why,
  'still in conflict with main after 2 fix tries');

// ---- a repair that worked until a later base merge is not counted; five repairs is the overall limit.
const sha = (c) => c.repeat(40);
const repair = (h, tip, mb, o = {}) => ({ try: 1, head: sha(h), kind: 'conflict', base_sha: sha(tip), merge_base: sha(mb), ...o });
const baseNow = (tip, mb) => () => ({ base_sha: sha(tip), merge_base: sha(mb) });
const dirtyAt = (h) => pr([ok('tests')], { mergeable: 'CONFLICTING', mergeState: 'DIRTY', pr: 704, head: sha(h) });
const worked2 = [repair('a', '1', '0'), repair('b', '2', '1')];
const afterWorked = fixCall(tk({ fix_tries: worked2 }), dirtyAt('c'), ctx({ baseAt: baseNow('3', '2') }));
t('AC6 two repairs that worked until a later base merge: a new try is sent, counting neither', `${afterWorked?.call} ${afterWorked?.fix.try} ${afterWorked?.fix.base_sha === sha('3')} ${afterWorked?.fix.merge_base === sha('2')}`, 'requeue 1 true true');
t('AC6 the same for a draft', conflictFix(tk({ fix_tries: worked2 }), { pr: 702, head: sha('c'), base: 'main', files: null, baseAt: { base_sha: sha('3'), merge_base: sha('2') } })?.fix.try, 1);
t('AC6 a try with no record of where it stood still counts', fixCall(tk({ fix_tries: [{ try: 1, head: sha('a'), kind: 'conflict' }, { try: 2, head: sha('b'), kind: 'conflict' }] }), dirtyAt('c'), ctx({ baseAt: baseNow('3', '2') }))?.call, 'stuck');
const same = [repair('a', '1', '0'), repair('b', '1', '0')];
t('AC7 still in conflict with the base its repairs were made against, after two: the person, as today', fixCall(tk({ fix_tries: same }), dirtyAt('c'), ctx({ baseAt: baseNow('1', '0') }))?.why, 'still in conflict with main after 2 fix tries');
const five = ['a', 'b', 'c', 'd', 'e'].map((h, i) => repair(h, String(i + 1), String(i)));
const c8 = fixCall(tk({ fix_tries: five }), dirtyAt('f'), ctx({ baseAt: baseNow('9', '8'), conflictFiles: () => ['src/a.ts', 'src/b.ts'] }));
t('AC8 five repairs of any outcome: no worker, and the reason names the files', `${c8?.call} | ${c8?.why}`, 'stuck | still in conflict with main after 5 repairs, the most one PR gets: src/a.ts, src/b.ts');
t('AC8 the same for a draft', conflictFix(tk({ fix_tries: five }), { pr: 702, head: sha('f'), base: 'main', files: ['src/a.ts'], baseAt: { base_sha: sha('9'), merge_base: sha('8') } })?.why, 'still in conflict with main after 5 repairs, the most one PR gets: src/a.ts');

// ---- DS-435: a conflict has its own tries, whatever kind the PR's other tries were.
const gate435 = [{ try: 1, head: HEAD, kind: 'checks', what: 'red: 🔐 Review gate' }, { try: 2, head: HEAD, kind: 'checks', what: 'red: 🔐 Review gate' }];
const d435 = conflictFix(tk({ fix_tries: gate435 }), { pr: 2594, head: HEAD, base: 'main', files: ['src/generated/class.ts'] });
t('DS-435 AC1 a draft whose tries were spent on a check, at this head, gets conflict try 1', `${d435?.call} ${d435?.fix?.try}/${d435?.fix?.of} ${d435?.fix?.kind}`, `requeue 1/${FIX_TRIES_MAX} conflict`);
const r435 = fixCall(tk({ fix_tries: gate435 }), dirty, ctx());
t('DS-435 AC1 the same out of draft', `${r435?.call} ${r435?.fix?.try} ${r435?.fix?.kind}`, 'requeue 1 conflict');
const spent435 = [...gate435, { try: 1, head: 'b'.repeat(40), kind: 'conflict' }, { try: 2, head: 'c'.repeat(40), kind: 'conflict' }];
t('DS-435 FIX_TRIES_MAX conflict tries spend them, and the reason counts only those', conflictFix(tk({ fix_tries: spent435 }), { pr: 2594, head: HEAD, base: 'main' })?.why, 'still in conflict with main after 2 fix tries');
t('DS-435 still one conflict try per head', conflictFix(tk({ fix_tries: [...gate435, { try: 1, head: HEAD, kind: 'conflict' }] }), { pr: 2594, head: HEAD, base: 'main' })?.why, 'still in conflict with main after 1 fix try');
t('DS-435 a red check after the conflict tries still counts every kind', draftChecksFix(tk({ fix_tries: spent435.slice(2) }), { pr: 2594, head: HEAD, failing: [{ name: 'tests', runId: 1 }] }, ctx())?.call, 'stuck');
const rv435 = (done) => reviewFix(tk({ fix_tries: done }), { pr: 2594, head: 'd'.repeat(40), verdict: { p1: '1' }, body: inlineBody, comments: () => [inlineP1] });
t('DS-435 a review fix after check tries and the conflict\'s own tries still has one',
  [spent435.slice(0, 3), spent435].map((d) => `${rv435(d)?.call} ${rv435(d)?.fix?.try}`).join(' | '), 'requeue 1 | requeue 1');
const brief435 = fixBrief(tk({ fix: d435.fix }));
t('DS-435 AC2 the conflict brief takes the base\'s side of a generated file and runs §4 Codegen', brief435.includes("take main's version of it (`git checkout --theirs <file>` during the merge), run §4 Codegen (`desk-env cmds codegen-cmd`)"), true);
t('DS-435 the conflict brief merges a branch far behind in steps', brief435.includes('merge main in steps'), true);
const treeLine = 'run each item `desk-env cmds merged-tree-check-cmd` prints on the merged tree before you push';
t('DS-441 AC3 a conflict try runs the merged-tree check before it pushes', brief435.includes(treeLine) && brief435.includes('Push nothing while it fails.'), true);
t('DS-441 AC3 so does a sync try', fixBrief(tk({ fix: { kind: 'sync', try: 1, of: 2, pr: 2594, head: HEAD, base: 'main', build: 'x' } })).includes(treeLine), true);
t('DS-441 AC3 negative: a review try, which merges nothing, is not told to', fixBrief(tk({ fix: { kind: 'review', try: 1, of: 2, pr: 2594, head: HEAD, base: 'main' } })).includes(treeLine), false);

// ---- DS-552: a green PR the merge driver held for failing §4 Merged-tree check goes the conflict's way.
const held552 = { head: HEAD, base: 'main', base_sha: 'b'.repeat(40), command: 'apps/api: uv run python check_heads.py', output: 'alembic\nMultiple head revisions are present: 131' };
const green552 = pr([ok('tests')], { mergeState: 'CLEAN', pr: 909 });
const c552 = fixCall(tk({ tree_check: held552 }), green552, ctx());
t('DS-552 AC2 a held green PR is requeued as conflict try 1, with the check',
  `${c552?.call} ${c552?.fix?.try}/${c552?.fix?.of} ${c552?.fix?.kind} ${c552?.fix?.check?.command} | ${c552?.fix?.what}`,
  `requeue 1/${FIX_TRIES_MAX} conflict apps/api: uv run python check_heads.py | fails §4 Merged-tree check merged into main`);
t('DS-552 negative: a hold recorded at an older head is spent', fixCall(tk({ tree_check: { ...held552, head: 'c'.repeat(40) } }), green552, ctx()), null);
t('DS-552 negative: with no hold, a green PR is nothing to fix', fixCall(tk(), green552, ctx()), null);
const d552 = fixCall(tk({ tree_check: held552 }), { ...dirty, head: HEAD }, ctx());
t('DS-552 a DIRTY PR stays a conflict, whatever the hold says', `${d552?.call} ${d552?.fix?.kind} ${d552?.fix?.what} ${d552?.fix?.check === undefined}`, 'requeue conflict conflicts with main true');
const brief552 = fixBrief(tk({ fix: c552.fix }));
t('DS-552 AC2 the brief quotes the check\'s output and says to merge the base and renumber',
  [brief552.includes('`apps/api: uv run python check_heads.py` (§4 Merged-tree check) fails on the merged tree'), brief552.includes('> Multiple head revisions are present: 131'),
    brief552.includes('Merge origin/main into your branch, then run each item `desk-env cmds merged-tree-check-cmd` prints'), brief552.includes('renumber your branch\'s own'), brief552.includes('Conflicting files')].join(' '),
  'true true true true false');
t('DS-552 AC2 the task merges the base and renumbers until the check passes',
  fixTask(tk({ fix: c552.fix })).includes("merge origin/main into your branch (git merge, never a rebase or a force push) and change your branch's own side, renumbering its migration"), true);
const spent552 = [{ try: 1, head: HEAD, kind: 'conflict' }];
t('DS-552 a try already made at this head is spent, naming the check and its last line',
  fixCall(tk({ tree_check: held552, fix_tries: spent552 }), green552, ctx())?.why,
  'merged into main, still failing §4 Merged-tree check `apps/api: uv run python check_heads.py` after 1 fix try: Multiple head revisions are present: 131');

// ---- DS-440: a check build that failed behind the base goes to a sync try, one of the FIX_TRIES_MAX.
const build440 = "its check build `./scripts/ensure-flows-image.sh` exited 1 at aaaaaaaaa: main's backend/ has changed; its head is behind main";
const s440 = syncFix(tk(), { pr: 855, head: HEAD, base: 'main', why: build440 });
t('DS-440 AC1 a sync try is requeued as try 1 on the draft', `${s440?.call} ${s440?.fix.try}/${s440?.fix.of} ${s440?.fix.kind} ${s440?.fix.draft} ${s440?.fix.base}`, `requeue 1/${FIX_TRIES_MAX} sync true main`);
t('DS-440 a sync try counts against FIX_TRIES_MAX', syncFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'checks' }] }), { pr: 855, head: HEAD, base: 'main', why: build440 })?.fix.try, 2);
t('DS-435 a sync try leaves a conflict its own tries', conflictFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'sync' }] }), { pr: 855, head: HEAD, base: 'main' })?.fix.try, 1);
const brief440 = fixBrief(tk({ fix: s440.fix }));
t('DS-440 AC2 the brief merges the base, runs the checks and fixes a break the merge brought in, in its own commit',
  brief440.includes('Merge origin/main into your branch (git merge, never a rebase or a force push)') && brief440.includes('two migrations with the same parent') && brief440.includes('in a commit of its own after the merge commit, before you push') && brief440.includes(build440), true);
t('DS-440 AC3 the brief leaves the build to the pass, at the new head', brief440.includes('the pass runs it at your new head and re-runs the check'), true);
t('DS-440 the brief names the person as next once the tries are spent', brief440.includes('A PR still behind main with its check build failing after try 2 goes to the person.'), true);
const task440 = fixTask(tk({ fix: s440.fix }));
t('DS-440 AC2 the task merges the base, fixes what it breaks, reviews the new head and leaves the PR in draft',
  task440.includes('merge origin/main into your branch') && task440.includes('fix each break the merge brought in') && task440.includes('review the new head with desk-review') && task440.includes('leave the PR in draft'), true);
t('DS-440 AC5 the task asks for the outcome on its DONE line', task440.includes('said=<one line: what the merge broke and how you fixed it, or what still fails and why>.'), true);
t('DS-440 a sync try already made at this head is not made again', syncFix(tk({ fix_tries: [{ try: 1, head: HEAD, kind: 'sync' }] }), { pr: 855, head: HEAD, base: 'main', why: build440 })?.call, 'stuck');
const said440 = { fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'sync' }, { try: 2, head: 'c'.repeat(40), kind: 'sync' }], fix: { try: 2, of: 2, kind: 'sync', base: 'main', finished: '2026-11-06T10:00:00Z' }, result: { summary: 'pr=855 jira=In Progress said=alembic heads still split' } };
t('DS-440 AC5 out of tries it is stuck, naming the build and what the last sync try said', syncFix(tk(said440), { pr: 855, head: HEAD, base: 'main', why: build440 })?.why,
  `still behind main with its check build failing after 2 fix tries: ${build440}; the last try said: pr=855 jira=In Progress said=alembic heads still split`);
t('DS-440 AC5 a last try of another kind says nothing for it', syncFix(tk({ ...said440, fix: { ...said440.fix, kind: 'conflict' } }), { pr: 855, head: HEAD, base: 'main', why: build440 })?.why,
  `still behind main with its check build failing after 2 fix tries: ${build440}`);
t('DS-440 AC5 the conflict reason still ignores a sync try\'s summary', conflictFix(tk({ ...said440, fix_tries: said440.fix_tries.map((x) => ({ ...x, kind: 'conflict' })) }), { pr: 855, head: HEAD, base: 'main' })?.why, 'still in conflict with main after 2 fix tries');

// ---- DS-375: a stuck reason names the step each run failed at, keeps its checks by name, and leaves a
// §4 Check builds check (out of draft) or a §4 Pre-merge steps one to the person, with what clears it.
// The run's jobs are as `gh run view 41190703208 --repo bigbenjoman/desk-skills --json jobs` returned them.
const jobs375 = JSON.parse(readFileSync(new URL('./fixtures/gh-run-view-jobs.json', import.meta.url), 'utf8'));
t('DS-375 AC2 the failed step is read from the run, by its job\'s name', failedSteps(jobs375, 'tests').join(), 'Run tests');
t('DS-375 AC2 a check with no job in the run, or a payload of another shape, names none',
  [failedSteps(jobs375, 'Lint'), failedSteps(null, 'tests'), failedSteps({ jobs: 'x' }, 'tests'), failedSteps({ jobs: [{ name: 'tests', steps: [{ conclusion: 'failure' }] }] }, 'tests')].map((x) => x.length).join(), '0,0,0,0');
const steps375 = (f) => (f.name === 'Lint' ? ['Run eslint'] : []);
const c375 = fixCall(tk({ fix_tries: two }), both, ctx({ steps: steps375 }));
t('DS-375 AC2 still red after both tries: each check with the step its run failed at', c375?.why, 'still red after 2 fix tries: Backend tests, Lint (failed step: Run eslint)');
t('DS-375 AC1 the stuck call keeps its checks by name, for desk-q to read against the PR now', JSON.stringify(c375?.checks), JSON.stringify([{ name: 'Backend tests' }, { name: 'Lint', step: 'Run eslint' }]));
const builds = [{ name: 'Flows image', command: './scripts/ensure-flows-image.sh' }];
const flows375 = pr([ok('tests'), red('Flows image', '903')]);
const b375 = fixCall(tk(), flows375, ctx({ operator: [], builds, reruns: () => 0 }));
t('DS-375 AC3 out of draft, red only on a §4 Check builds check: never requeued, stuck with its command', `${b375?.call} | ${b375?.why}`, 'stuck | Flows image · ./scripts/ensure-flows-image.sh');
const b375b = fixCall(tk(), pr([ok('tests'), red('Flows image', '903'), red('Lint', '902')]), ctx({ operator: [], builds }));
t('DS-375 AC3 beside a fixable check, only that one goes to the worker', `${b375b?.call} | ${b375b?.fix.what} | ${b375b?.fix.not_mine.map((c) => `${c.name}: ${c.command}`).join()}`, 'requeue | red: Lint | Flows image: ./scripts/ensure-flows-image.sh');
t('DS-375 AC3 and once its tries are spent, the stuck reason names both', fixCall(tk({ fix_tries: two }), pr([ok('tests'), red('Flows image', '903'), red('Lint', '902')]), ctx({ operator: [], builds }))?.why,
  'still red after 2 fix tries: Lint; Flows image · ./scripts/ensure-flows-image.sh');
const premerge = [{ name: 'Check portal schema mirror', command: 'apply the PR\'s migrations to staging first' }];
const lint375 = pr([ok('tests'), red('Lint, Type Check & Build', '904')]);
const p375 = fixCall(tk(), lint375, ctx({ operator: [], premerge, steps: () => ['Check portal schema mirror'], reruns: () => 0 }));
t('DS-375 AC5 a check failing at a §4 Pre-merge steps step: never requeued, stuck naming the step', `${p375?.call} | ${p375?.why}`,
  'stuck | Lint, Type Check & Build (failed step: Check portal schema mirror) · apply the PR\'s migrations to staging first');
t('DS-375 AC5 the same check failing at another step is a worker\'s', fixCall(tk(), lint375, ctx({ operator: [], premerge, steps: () => ['Run eslint'] }))?.call, 'requeue');
t('DS-375 AC5 a draft reads the row the same way', draftChecksFix(tk(), { pr: 702, head: HEAD, failing: [{ name: 'Lint, Type Check & Build', runId: '904' }] }, { repo: 'acme/widgets', premerge, steps: () => ['Check portal schema mirror'] })?.call, 'stuck');
t('DS-375 the reason with no worker\'s check left names only what a person clears', stuckWhy({ lead: 'still red after 1 fix try', checks: [{ name: 'Flows image', command: 'x.sh' }] }), 'Flows image · x.sh');

// DS-379: a draft's screenshots nobody took go to a capture worker, once per PR, outside the fix tries.
const cp = captureTry(tk(), { pr: 761, head: HEAD, files: ['a-before.png', 'a-after.png'] });
t('DS-379 AC1 missing screenshots requeue a capture try naming them', JSON.stringify([cp?.call, cp?.fix.kind, cp?.fix.pr, cp?.fix.files]), '["requeue","capture",761,["a-before.png","a-after.png"]]');
t('DS-379 no file missing: no try', captureTry(tk(), { pr: 761, head: HEAD, files: [] }), null);
const briefCp = fixBrief(tk({ fix: cp.fix }));
t('DS-379 AC1 its brief lists each file to take', briefCp.includes('## Capture try: PR #761') && briefCp.includes('\n- a-before.png\n- a-after.png\n'), true);
const taskCp = fixTask(tk({ fix: cp.fix }));
t('DS-379 AC1 its task is to take them, print AUTOPILOT_IMAGES, change no code and say what it could not take',
  ['Your task is the capture try on PR #761', 'print AUTOPILOT_IMAGES', 'Change no code', 'leave the PR in draft', 'said=<all taken, or for each screen you could not take'].every((s) => taskCp.includes(s)), true);
const capDone = [{ try: 1, head: HEAD, kind: 'capture' }];
const cpStuck = captureTry(tk({ fix_tries: capDone, fix: { ...cp.fix, finished: 'x' }, result: { summary: 'pr=761 jira=Done said=a-after.png: needs a signed-in admin' } }), { pr: 761, head: HEAD, files: ['a-after.png'] });
t('DS-379 AC3 still missing after the capture try: stuck, naming the screen and why', `${cpStuck?.call}: ${cpStuck?.why}`,
  'stuck: 1 screenshot(s) still not taken after a capture try: a-after.png; the capture try said: a-after.png: needs a signed-in admin');
const longSaid = Array.from({ length: 6 }, (_, i) => `shot-${i}.png: the page needs a signed-in admin and seeded data`).join('; ');
t('DS-379 AC3 every screen\'s reason comes from result.done.said, which the 200-character summary would cut',
  captureTry(tk({ fix_tries: capDone, fix: { ...cp.fix, finished: 'x' }, result: { summary: `pr=761 jira=Done said=${longSaid}`.slice(0, 200), done: { said: longSaid } } }), { pr: 761, head: HEAD, files: ['shot-5.png'] })?.why,
  `1 screenshot(s) still not taken after a capture try: shot-5.png; the capture try said: ${longSaid}`);
t('DS-379 AC3 with nothing said, it still names the screen', captureTry(tk({ fix_tries: capDone }), { pr: 761, head: HEAD, files: ['a-after.png'] })?.why, '1 screenshot(s) still not taken after a capture try: a-after.png');
t('DS-379 the capture try is not one of the fix tries', draftChecksFix(tk({ fix_tries: [...capDone, { try: 1, head: 'b'.repeat(40), kind: 'checks' }] }), { pr: 761, head: HEAD, failing: [{ name: 'tests', runId: '9' }] }, { repo: 'acme/widgets' })?.fix?.try, 2);
t('DS-379 nor does it spend the head for a fix try', draftChecksFix(tk({ fix_tries: capDone }), { pr: 761, head: HEAD, failing: [{ name: 'tests', runId: '9' }] }, { repo: 'acme/widgets' })?.call, 'requeue');

// ---- DS-406: PR #348's round-7 review, abridged: its P0 and its P1 / P2 lines verbatim, a few of its
// sub-bullets. The one P0's indented sub-bullets are part of it, and a `P1: None` line citing a
// file:line is no finding.
const BT = '`';
const p0_348 = `**${BT}desk/bin/evidence.mjs:37${BT}: the code-span strip runs across lines. One unbalanced backtick hides real ${BT}_drag${BT} cells, so a draft with placeholders still in it can leave draft.**`;
const subs348 = [`  - the four-backtick form around three backticks, as ${BT}desk-config.md:338${BT} writes it.`,
  `  - ${BT}undraft.mjs:354${BT} makes no evidence call. ${BT}missingShots${BT} at ${BT}:357${BT} finds nothing, because ${BT}dragFiles${BT} uses the same matcher.`,
  `  - ${BT}upload-images.mjs:153${BT} counts 0 left and never sets exit code 4. So ${BT}pass.mjs:551-554${BT} records ${BT}images_uploaded=true${BT} while cells are still in the body.`];
const body348 = ['<!-- desk-review:local -->',
  '<!-- desk-review:verdict v=1 sha=597a520e300d9bb1a00b462583a43f3fcafe8676 p0=1 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex-cross round=7 -->',
  `**desk-review, round 7, fix range fdcfe56..597a520: not clean: 1 P0 outstanding at ${BT}597a520${BT}** · codex read the diff cold · refuted cross-vendor`, '',
  '## P0 (1)', '', p0_348, '',
  `- **The cause.** ${BT}outsideCode${BT} strips code spans, and three things in that pattern go wrong:`,
  '  - A backtick run with no partner is not left as literal text.',
  '- **What it does to a body.** Any of these is enough:', '  - a typo;', subs348[0],
  `- **What breaks.**`, subs348[1], subs348[2],
  '- **Suggested fix.**', `  - Add checks next to the DS-381 AC2 test in ${BT}tests/test_undraft.mjs${BT}.`, '',
  '## P1 / P2', '',
  `None. Round 7 raises no new P2s. Simplicity noted two narrative comments, at ${BT}evidence.mjs:35-36${BT} ("(DS-381)") and ${BT}test_undraft.mjs:200${BT}, but the round-7 rule left them out.`, '',
  '## Requirements', '', 'DS-379 AC1–AC4 are unchanged since round 6.'].join('\n');
const heading511 = readFileSync(new URL('./fixtures/review-finding-as-heading.md', import.meta.url), 'utf8');
const f511 = reviewFix(tk(), { pr: 511, head: HEAD, verdict: { p0: '1', p1: '0', p2: '0' }, body: heading511 });
t('DS-518 AC1 a finding written as a heading is sent to a fix try', `${f511?.call} ${f511?.fix.kind}`, 'requeue review');
t('DS-518 AC1 it quotes that finding alone, not the lines citing evidence under it', JSON.stringify(f511?.fix.findings), JSON.stringify([{ sev: 'P0', text: '`desk/bin/bench.mjs:358`: with `CLAUDE_CODE_OAUTH_TOKEN` set, the quota guard reads a different account from the one a Fable run spends' }]));
const headed = (rest) => reviewFindings(`## P0 (1)\n### src/a.ts:4: off by one\n${rest}`).map((x) => `${x.sev} ${x.text}`).join('|');
const only518 = 'P0 src/a.ts:4: off by one';
t('DS-518 AC2 a heading citing no file:line ends the section, whatever its prose cites', headed('### Notes\nSee src/b.ts:9 for the pattern.'), only518);
t('DS-518 AC3 no line of the gaps section after it is a P0', headed('## Requirement gaps\n- AC1: src/c.ts:7 not done'), only518);
t('DS-518 a heading of the severity heading\'s own level is not a finding, whatever it cites', headed('## Files read, src/d.ts:2'), only518);
t('DS-518 two headings are two findings', reviewFindings('## P1 (2)\n### src/a.ts:1: one\nsee src/x.ts:1\n### src/b.ts:2: two').map((x) => `${x.sev} ${x.text}`).join('|'), 'P1 src/a.ts:1: one|P1 src/b.ts:2: two');
t('DS-518 a heading under a severity left out is not read, and leaves the run where it was', reviewFindings('## P2 (1)\n### src/a.ts:1: naming\n## P0 (1)\n### src/b.ts:2: crash').map((x) => `${x.sev} ${x.text}`).join('|'), 'P0 src/b.ts:2: crash');
t('DS-518 a heading citing a file:line outside any severity is not a finding', reviewFindings('### src/a.ts:1: context\n- src/b.ts:2 note').length, 0);
t('DS-518 AC4 bullets under the severity heading are quoted as they were', JSON.stringify(reviewFindings('## P0 (2)\n- src/a.ts:1 one\n  - detail src/x.ts:1\n- src/b.ts:2 two').map((x) => x.text)), JSON.stringify(['- src/a.ts:1 one - detail src/x.ts:1', '- src/b.ts:2 two']));
t('DS-518 AC5 a review citing no file:line still sends no worker', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p0: '1' }, body: '## P0 (1)\n### The guard reads the wrong account\nIt spends another login.' }), null);

const f348 = reviewFindings(body348);
t('DS-406 AC1 round 7 of PR #348 is one finding, a P0', f348.map((x) => x.sev).join(','), 'P0');
t('DS-406 AC1 its text holds its three sub-bullets', subs348.every((s) => f348[0]?.text.includes(s.trim())), true);
t('DS-406 AC1 and its sub-bullets that cite no file:line', ['- A backtick run with no partner', '- a typo;', '- Add checks next to'].every((s) => f348[0]?.text.includes(s)), true);
t('DS-406 AC2 a finding that opens with the word None is still one', reviewFindings(`## P0 (1)\n- None of the three callers guard a null session, ${BT}src/auth.ts:12${BT}`).map((x) => x.sev).join(), 'P0');
t('DS-406 AC2 its "None" line under P1 / P2 is no P1', f348.some((x) => x.sev === 'P1'), false);
t('DS-406 AC2 nor is a "P1: None" line of its own', reviewFindings(`P0 (1)\n- src/a.ts:4 off by one\nP1: None. ${BT}evidence.mjs:35-36${BT} was left out.`).map((x) => `${x.sev} ${x.text}`).join('|'), 'P0 - src/a.ts:4 off by one');
const pf = personReviewFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }] }), { pr: 348, head: HEAD, why: `review not clean after 2 fix tries (2 review): 2 P0 — P0: ${p0_348}; P0: src/a.ts:4 off; by one` });
t('DS-406 AC3 a review stuck reason gives the person one more try, its findings split by severity', `${pf?.person} ${pf?.try}/${pf?.of} ${pf?.findings.map((x) => x.text).join('|')}`, `true 3/3 ${p0_348}|src/a.ts:4 off; by one`);
t('DS-406 AC3 its brief and task say the person sent it, quoting each finding', [fixBrief(tk({ fix: pf })).includes('## Fix try the person sent: PR #348'), fixBrief(tk({ fix: pf })).includes(`- P0: ${p0_348}`), fixTask(tk({ fix: pf })).includes('Your task is the fix try the person sent on PR #348')].join(), 'true,true,true');
t('DS-406 a reason that quotes no finding gives no try', personReviewFix(tk(), { why: 'review not clean after 2 fix tries (2 review): 1 P0' }), null);
t('DS-436 AC4 a P2 the review fix tries left gives the person one more try at it', JSON.stringify(personReviewFix(tk(), { why: p2Spent.why })?.findings.map((x) => x.sev)), '["P2"]');
t('DS-406 findings listed at the same depth are each their own', reviewFindings('### P1\n  - src/a.ts:1 one\n  - src/b.ts:2 two').length, 2);
t('DS-406 a deeper bullet under the next severity heading is not joined to the finding above it', reviewFindings('P0 (1)\n- src/a.ts:1 one\nP1 (1)\n  - src/b.ts:2 two').map((x) => x.sev).join(','), 'P0,P1');

// DS-419: a ready PR held for review feedback goes to a fix worker, under the same tries.
const th = [{ id: 'PRRT_1', text: 'src/rail.ts:40 "**P0** a class that goes live early is missing from the rail"', path: 'src/rail.ts' }];
const fb1 = feedbackFix(tk(), { pr: 2402, head: HEAD, decision: 'NONE', threads: th });
t('DS-419 AC1 one unresolved thread is a feedback fix try, try 1', `${fb1?.call} ${fb1?.fix.kind} ${fb1?.fix.try}/${fb1?.fix.of}`, `requeue feedback 1/${FIX_TRIES_MAX}`);
t('DS-419 AC1 the try quotes the thread by id and text only', JSON.stringify(fb1?.fix.threads), JSON.stringify([{ id: 'PRRT_1', text: th[0].text }]));
t('DS-419 AC1 it says what it is fixing', fb1?.fix.what, 'review feedback: 1 unresolved thread');
t('DS-419 changes requested with no thread is feedback too', feedbackFix(tk(), { pr: 2402, head: HEAD, decision: 'CHANGES_REQUESTED', threads: [] })?.fix.what, 'review feedback: changes requested');
t('DS-419 changes requested left after a feedback try, every thread resolved, is the reviewer\'s', feedbackFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'feedback' }] }), { pr: 2402, head: HEAD, decision: 'CHANGES_REQUESTED', threads: [] })?.why, 'review feedback still open after 1 fix try: changes requested, which only the reviewer clears, by reviewing it again');
t('DS-419 no thread and no changes requested is nothing to fix', feedbackFix(tk(), { pr: 2402, head: HEAD, decision: 'APPROVED', threads: [] }), null);
const fbBrief = fixBrief(tk({ fix: fb1.fix }));
t('DS-419 AC5 the brief quotes each thread and says the PR is out of draft', fbBrief.includes(`- ${th[0].text}`) && fbBrief.includes('is open and out of draft'), true);
t('DS-419 AC5 the brief has the worker validate, answer every thread, and leave resolving to the pass', fbBrief.includes('desk-review-response') && fbBrief.includes('Answer every thread with gh pr comment') && fbBrief.includes('the pass replies on each thread quoted here and resolves it'), true);
t('DS-419 AC8 the brief has a thread the worker cannot fix parked, naming it and what blocks it', fbBrief.includes('park (AUTOPILOT_PARK) naming the thread and exactly what blocks it'), true);
const fbTask = fixTask(tk({ fix: fb1.fix }));
t('DS-419 AC5 the task pushes to the same branch and posts a fresh desk-review on the new head', fbTask.includes('push to the same branch with git push origin <your branch>, then review the new head with desk-review and post that review on the PR'), true);
t('DS-419 the task leaves the ready PR out of draft', fbTask.includes('leave the PR out of draft'), true);
// AC7: out of tries, or tried at this head already: the person's, naming each thread.
const fbDone = [{ try: 1, head: 'b'.repeat(40), kind: 'feedback' }, { try: 2, head: 'c'.repeat(40), kind: 'feedback' }];
const fb7 = feedbackFix(tk({ fix_tries: fbDone }), { pr: 2402, head: HEAD, decision: 'NONE', threads: th });
t('DS-419 AC7 after 2 tries it is stuck, naming the thread', `${fb7?.call}: ${fb7?.why}`, `stuck: review feedback still open after 2 fix tries: 1 unresolved thread — ${th[0].text}`);
t('DS-419 AC7 a try already made at this head is not made again', feedbackFix(tk({ fix_tries: [{ try: 1, head: HEAD, kind: 'feedback' }] }), { pr: 2402, head: HEAD, threads: th })?.call, 'stuck');
// The threads the pass replies on and resolves: a finished try whose worker pushed past its head.
const worked = { ...fb1.fix, finished: 'x' };
t('DS-419 AC5 a finished try that moved the head has its threads resolved', resolvable(tk({ state: 'done', fix: worked }), 'd'.repeat(40)).map((x) => x.id).join(), 'PRRT_1');
t('DS-419 not while the head is still the try\'s', resolvable(tk({ state: 'done', fix: worked }), HEAD).length, 0);
t('DS-419 not while its worker runs or parked', [resolvable(tk({ state: 'done', fix: fb1.fix }), 'd'.repeat(40)).length, resolvable(tk({ state: 'parked', fix: worked }), 'd'.repeat(40)).length].join(), '0,0');
t('DS-419 not one already resolved', resolvable(tk({ state: 'done', fix: { ...worked, resolved: ['PRRT_1'] } }), 'd'.repeat(40)).length, 0);
t('DS-419 the reply names the try and the head', feedbackReply(fb1.fix, 'd'.repeat(40)).startsWith(`Worked by desk's fix try 1 of ${FIX_TRIES_MAX} at dddddddddddd`), true);
// AC2: a ready PR's review fix says it is out of draft, and leaves it there.
const rfReady = { ...reviewFix(tk(), { pr: 2289, head: HEAD, verdict: { p0: '1', p1: '0' }, body: '### P0 (1)\n- src/clerk.ts:12 signature changed on main' }).fix, ready: true };
t('DS-419 AC2 a ready PR\'s review fix brief says it is out of draft', fixBrief(tk({ fix: rfReady })).includes('Your PR #2289 is open and out of draft'), true);
t('DS-419 AC2 its task leaves it out of draft and reviews the new head', /review the new head with desk-review.*leave the PR out of draft/.test(fixTask(tk({ fix: rfReady }))), true);

// DS-422: a §4 State check reads the PR's state, so the driver never reruns it and no fix worker fixes it.
const STATE = [{ name: '🌿 Local Adversarial Code Review', kind: 'verdict' }, { name: '🔐 Review gate', kind: 'approval' }, { name: '🏁 CI gate', kind: null }];
const stateRed = pr([ok('tests'), red('🌿 Local Adversarial Code Review', '41439509032'), red('🔐 Review gate', '41439509055'), red('🏁 CI gate', '41439509055')]);
t('DS-422 AC1 red only on state checks, reruns spent: no fix try is sent', fixCall(tk(), stateRed, ctx({ stateChecks: STATE })), null);
const bareRed = fixCall(tk(), pr([ok('tests'), red('PR title', '77')]), ctx({ stateChecks: [...STATE, { name: 'PR title', kind: null }], reruns: () => 0 }));
t('DS-422 AC1 red only on a state check of no kind, never rerun: put to the person as stuck', `${bareRed?.call} ${bareRed?.why}`, 'stuck red on "PR title", a §4 State check: it reads the PR\'s state, not its code, so no rerun or fix try turns it green; a person clears what it reads');
const codeAndState = pr([...stateRed.checks, red('Backend tests', '901')]);
t('DS-422 AC2 a red test beside them still waits on its own reruns', fixCall(tk(), codeAndState, ctx({ stateChecks: STATE, reruns: (n) => (n === 'Backend tests' ? 1 : 0) })), null);
const c422 = fixCall(tk(), codeAndState, ctx({ stateChecks: STATE, reruns: (n) => (n === 'Backend tests' ? 2 : 0) }));
t('DS-422 AC2 and once they are spent, its fix try names only the test', c422?.fix.what, 'red: Backend tests');
const vt = verdictTry(tk(), stateRed, { required: ['tests'], stateChecks: STATE });
t('DS-422 AC3 a red verdict state check goes to a review worker', `${vt?.call} ${vt?.fix.kind} ${vt?.fix.ready}`, 'requeue rereview true');
t('DS-422 AC3 its brief says the PR is out of draft and why', fixBrief(tk({ fix: vt.fix })).includes('Your PR #697 is open and out of draft on this branch, and the merge driver will not rerun the check that reads its review at its head aaaaaaaaaaaa: its "🌿 Local Adversarial Code Review" check is red, and a rerun reads the same verdict.'), true);
t('DS-422 AC3 its task reviews the head and leaves it out of draft', /desk-review.*leave the PR out of draft/.test(fixTask(tk({ fix: vt.fix }))), true);
t('DS-558 two review tries per head: tried twice here, it is the person\'s', verdictTry(tk({ fix_tries: [{ ...vt.fix }] }), stateRed, { required: ['tests'], stateChecks: STATE })?.call
  + ' ' + verdictTry(tk({ fix_tries: [{ ...vt.fix }, { ...vt.fix }] }), stateRed, { required: ['tests'], stateChecks: STATE })?.call, 'requeue stuck');
t('DS-422 AC4 a red approval check alone sends no worker', verdictTry(tk(), pr([ok('tests'), red('🔐 Review gate', '7')]), { required: ['tests'], stateChecks: STATE }), null);
t('DS-422 a draft is undraft.mjs\'s, not this', verdictTry(tk(), { ...stateRed, isDraft: true }, { required: ['tests'], stateChecks: STATE }), null);
t('DS-422 a red verdict check beside an unclean review at the head is reviewFix\'s, as before', verdictTry(tk(), stateRed, { required: ['tests'], stateChecks: STATE, settled: true }), null);

// DS-433 AC2: a green PR the merge driver holds for want of a clean review at its head goes back for review.
const green433 = pr([ok('tests')]);
const stale = { head: HEAD, clean: false, carried: null, why: 'its review verdict is for bbbbbbbbb, not the head aaaaaaaaa', settle: false, person: false };
const ctx433 = (atHead, o = {}) => ({ required: ['tests'], stateChecks: STATE, atHead: () => atHead, ...o });
const vs = verdictTry(tk(), green433, ctx433(stale));
t('DS-433 AC2 a stale verdict on a green PR goes to a review worker, out of draft', `${vs?.call} ${vs?.fix.kind} ${vs?.fix.ready} ${vs?.fix.held}`, 'requeue rereview true true');
t('DS-433 AC2 its brief says the driver will not merge it, and why', fixBrief(tk({ fix: vs.fix })).includes('Your PR #697 is open and out of draft on this branch, and the merge driver will not merge it without a clean review at its head aaaaaaaaaaaa: its review verdict is for bbbbbbbbb, not the head aaaaaaaaa.'), true);
t('DS-433 AC2 its task reviews the head and leaves it out of draft', /desk-review.*leave the PR out of draft/.test(fixTask(tk({ fix: vs.fix }))), true);
t('DS-558 AC3 two review tries per head: tried twice here, it is the person\'s, naming the review failure', verdictTry(tk({ fix_tries: [{ ...vs.fix }, { ...vs.fix }] }), green433, ctx433(stale))?.why, `no review verdict readable at its head after 2 review tries at it: ${stale.why}`);
const movedTry = [{ try: 1, head: 'c'.repeat(40), kind: 'checks' }, { try: 2, head: 'd'.repeat(40), kind: 'checks' }];
t('DS-558 AC1 fix tries spent, a held PR still gets a review try at its head', verdictTry(tk({ fix_tries: movedTry }), green433, ctx433(stale, { base: 'main', baseMerge: () => true }))?.fix.what, `review its head, moved by a merge from main: ${stale.why}`);
t('DS-433 a clean review at the head sends no worker', verdictTry(tk(), green433, ctx433({ ...stale, clean: true, why: null })), null);
t('DS-433 nothing waiting on a verdict (no §4 Local review command, or no driver) sends no worker', verdictTry(tk(), green433, ctx433(null)), null);
t('DS-433 no atHead at all is as it was', verdictTry(tk(), green433, { required: ['tests'], stateChecks: STATE }), null);
const askedNot = () => { throw new Error('asked'); };
t('DS-433 checks still running: the head is not read yet', verdictTry(tk(), pr([{ name: 'tests', status: 'in_progress', conclusion: null }]), { required: ['tests'], atHead: askedNot }), null);
t('DS-433 a red check is the fix tries\', not a review', verdictTry(tk(), pr([red('tests', '9')]), { required: ['tests'], stateChecks: STATE, atHead: askedNot }), null);
t('DS-433 red only on a waived flake, the driver reaches its hold, so it goes for review', verdictTry(tk(), pr([ok('tests'), red('Flaky', '9')]), ctx433(stale, { waived: () => true }))?.fix.kind, 'rereview');
t('DS-433 a review at the head that no fix worker took is the person\'s', JSON.stringify(verdictTry(tk(), green433, ctx433({ ...stale, why: 'its review verdict at aaaaaaaaa is not clean (p2=1)', settle: true }))), JSON.stringify({ call: 'stuck', why: 'its review verdict at aaaaaaaaa is not clean (p2=1)' }));
t('DS-433 so is an unset row, which no worker can set', verdictTry(tk(), green433, ctx433({ ...stale, why: 'row', person: true }))?.call, 'stuck');

// DS-449 AC1: a review try the pass narrowed names only the base's changed files and the PR's code using them.
const narrowed = { from: OLD, range: '111111111111..222222222222', files: ['src/helper.js'], users: ['src/a.js'] };
const rvT = reviewTry(tk(), { pr: 702, head: HEAD, why: 'no clean review at its head', targeted: narrowed });
t('DS-449 AC1 a narrowed review try keeps what to read', JSON.stringify(rvT?.fix.targeted), JSON.stringify(narrowed));
const briefT = fixBrief(tk({ fix: rvT.fix }));
t('DS-449 AC1 its brief names the base\'s changed files and the PR\'s code that uses them', briefT.includes('### Targeted: review only what the base changed under the review') && briefT.includes('- Changed by the base: src/helper.js') && briefT.includes("- The PR's code that uses them: src/a.js") && briefT.includes('`111111111111..222222222222`') && briefT.includes(`posted on ${OLD.slice(0, 12)} was clean`), true);
t('DS-449 AC1 and its task asks for the targeted round on only that', fixTask(tk({ fix: rvT.fix })).includes('in its targeted round on only what the briefing\'s "Targeted" section names'), true);
t('DS-449 AC1 with no PR file using them, the brief says so', fixBrief(tk({ fix: { ...rvT.fix, targeted: { ...narrowed, users: [] } } })).includes("- The PR's code that uses them: none of its changed files names one"), true);
t('DS-449 AC4 an unnarrowed try is the whole review, as before', !briefRv.includes('Targeted') && !('targeted' in rv1.fix) && !fixTask(tk({ fix: rv1.fix })).includes('targeted'), true);
const xT = reviewTry(tk({ fix_tries: tried }), { pr: 871, head: HEAD, why: unread, base: 'main', baseMerge: () => true, targeted: narrowed });
t('DS-449 AC1 a try after a base merge is narrowed too', `${xT?.fix.what.includes('moved by a merge')} ${xT?.fix.targeted?.files}`, 'true src/helper.js');
t('DS-449 AC1 a held PR the driver will not merge gets the narrowed try', verdictTry(tk(), green433, ctx433({ ...stale, targeted: narrowed }))?.fix.targeted?.users?.[0], 'src/a.js');

// What the driver holds on (review-threads.mjs readVerdict).
{
const CLEAN = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0';
const marked = (sha, counts = CLEAN, login = 'ben', tail = []) => ({ id: `R${sha[0]}`, author: { login }, commit: { oid: sha }, body: ['<!-- desk-review:local -->', `<!-- desk-review:verdict v=1 sha=${sha} ${counts} vendor=codex round=1 -->`, '**desk-review**', ...tail].join('\n') });
const pl = (head, ...reviews) => ({ data: { repository: { pullRequest: { headRefOid: head, reviews: { nodes: reviews } } } } });
const OLD = 'b'.repeat(40);
const read433 = (payload, o = {}) => readVerdict(payload, { handle: 'ben', clean: CLEAN, ...o });
t('DS-433 clean at the head reads clean', read433(pl(HEAD, marked(HEAD))).clean, true);
t('DS-433 no payload is no answer', readVerdict({}, { handle: 'ben', clean: CLEAN }), null);
t('DS-433 no verdict is a review worker\'s', JSON.stringify(read433(pl(HEAD))), JSON.stringify({ head: HEAD, clean: false, carried: null, why: 'no desk-review verdict is posted on it', settle: false, person: false }));
t('DS-433 a stale verdict is too', `${read433(pl(HEAD, marked(OLD))).clean} ${read433(pl(HEAD, marked(OLD))).settle}`, 'false false');
t('DS-433 someone else\'s clean verdict attests nothing', read433(pl(HEAD, marked(HEAD, CLEAN, 'mallory'))).clean, false);
t('DS-433 the latest verdict counts: a dirty one after a clean one holds it', read433(pl(HEAD, marked(HEAD), marked(HEAD, 'p0=0 p1=1 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0'))).settle, true);
t('DS-433 an uncarried P2 at the head is not clean', read433(pl(HEAD, marked(HEAD, 'p0=0 p1=0 p2=1 deferred=0 gaps=0 unrefuted=0 partial=0'))).clean, false);
t('DS-433 a carried P2 is not in the counts, so it is clean', read433(pl(HEAD, marked(HEAD, CLEAN, 'ben', ['<!-- desk-review:carried v=1 p2=1 since=x -->']))).clean, true);
const carriedRead = read433(pl(HEAD, marked(OLD)), { carry: (sha) => sha === OLD });
t('DS-433 a clean verdict carried to the head reads clean, naming its commit', `${carriedRead.clean} ${carriedRead.carried === OLD}`, 'true true');
const carriedDirty = read433(pl(HEAD, marked(OLD, 'p0=0 p1=1 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0')), { carry: () => true });
t('DS-433 an unclean verdict carried to the head is not clean, and is a review worker\'s to post at it', `${carriedDirty.clean} ${carriedDirty.settle} ${carriedDirty.carried}`, 'false false null');
t('DS-433 an unset row is the person\'s', read433(pl(HEAD), { clean: 'TODO' }).person, true);
// DS-449: a clean verdict that does not carry is narrowed for the held PR's review worker; an unclean one never is.
const scoped = { from: OLD, range: 'a..b', files: ['src/h.js'], users: [] };
let scopeAsked = null;
const narrowRead = read433(pl(HEAD, marked(OLD)), { carry: () => null, scope: (sha, body) => { scopeAsked = [sha, body.includes(OLD)]; return scoped; } });
t('DS-449 AC1 a clean verdict that does not carry is narrowed, asked with its commit and body', `${narrowRead.clean} ${narrowRead.targeted === scoped} ${JSON.stringify(scopeAsked)}`, `false true ${JSON.stringify([OLD, true])}`);
t('DS-449 AC3 an unclean verdict for an older head is not narrowed: the head is reviewed whole', 'targeted' in read433(pl(HEAD, marked(OLD, 'p0=0 p1=1 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0')), { carry: () => null, scope: () => scoped }), false);
t('DS-449 a carried verdict is never narrowed', 'targeted' in read433(pl(HEAD, marked(OLD)), { carry: () => true, scope: () => { throw new Error('asked'); } }), false);
// DS-544 AC6: the merge driver reads a clean PullBot round at the head as clean under either row, so a
// PR it held as unreadable is released on the next pass.
const round544 = (sha, counts) => ({ id: 'RP', author: { login: 'ben' }, commit: { oid: sha }, body: pullbotRound(sha, counts) });
for (const clean of ['no P0, P1 or P2 findings', PULLBOT_CLEAN_COUNTS]) {
  t(`DS-544 AC6 a clean PullBot round at the head reads clean under "${clean}"`, read433(pl(PULLBOT_SHA, round544(PULLBOT_SHA)), { clean }).clean, true);
  const p1 = read433(pl(PULLBOT_SHA, round544(PULLBOT_SHA, 'p0=0 p1=1 p2=0 deferred=0 gaps=0')), { clean });
  t(`DS-544 AC3 a P1 in it under "${clean}" is a review at the head to settle, named`, `${p1.clean} ${p1.settle} ${p1.why.includes('p1=1')}`, 'false true true');
  t(`DS-544 AC6 the thread read takes it as the clean verdict under "${clean}"`, readThreads(pl(PULLBOT_SHA, round544(PULLBOT_SHA)), { handle: 'ben', clean }).verdict, PULLBOT_SHA);
}
t('DS-433 §4 Local review command: set, none, TODO, empty', [localReviewSet('/desk-review'), localReviewSet('none'), localReviewSet('TODO (run before)'), localReviewSet(null)].join(), 'true,false,false,false');
}

// ---- A Review gate failure a change on the branch may clear goes to a worker before the person. The
// protected lines are the recorded studia-web ones and those desk's own review-gate.mjs writes.
{
  const { failureLines, approvalFiles, staleVerdict } = await import('../desk/bin/gate.mjs');
  const failureLine = (notes) => failureLines(notes)[0] ?? null;
  const { checkApproval, checkVerdict } = await import('../desk/templates/scripts/desk/review-gate.mjs');
  const NOTES = JSON.parse(readFileSync(new URL('./fixtures/review-gate-annotations.json', import.meta.url), 'utf8'));
  const GATE = '🔐 Review gate';
  const STATE_BARE = [{ name: GATE, kind: null }];
  const studiaLine = failureLine(NOTES.protected), limitLine = failureLine(NOTES['file-limit']);
  const pkgLine = 'Approval required — 1 protected file(s): `apps/portal/apps/web/package.json`.';
  const deskLine = checkApproval({ title: 'feat: x', head: HEAD, author: 'me' }, [{ filename: 'package.json', additions: 1, deletions: 0 }], [], new Set(), { protected: 'package\\.json', generated: '^$', fileLimit: 30, exemptTypes: 'fix|docs|chore' }).message;
  const staleLine = checkVerdict([{ user: { login: 'ben' }, body: `<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=${OLD} p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1 -->\nClean` }], HEAD, new Set(['ben'])).message;
  // An old-format marker parses as no verdict, so desk's gate says none is posted.
  const oldFormatLine = checkVerdict([{ user: { login: 'ben' }, body: '<!-- pullbot:local -->\n<!-- pullbot:verdict sha=abc p0=0 rounds=1 -->' }], HEAD, new Set(['ben'])).message;
  const dirtyLine = checkVerdict([{ user: { login: 'ben' }, body: `<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=${HEAD} p0=1 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1 -->\nP0` }], HEAD, new Set(['ben'])).message;
  const gateRed = (...errors) => ({ ...red(GATE, '7'), error: errors[0] ?? null, errors });
  const gctx = (o = {}) => ({ required: ['tests'], advisory: [], stateChecks: STATE_BARE, base: 'main', baseMerge: () => false, ...o });

  t('DS-500 the protected files are read from a repo\'s gate line', JSON.stringify(approvalFiles(studiaLine)), JSON.stringify({ files: ['packages/db-studia/prisma/migrations/20261104120000_sv3178_drop_duplicate_indexes/migration.sql', 'packages/db-studia/prisma/schema.prisma'], more: 0 }));
  t('DS-500 and from desk\'s own', approvalFiles(deskLine)?.files.join(), 'package.json');
  t('DS-500 a file-limit line names no protected file', approvalFiles(limitLine), null);
  t('DS-500 a stale, missing or old-format verdict line reads stale', [staleLine, oldFormatLine].map(staleVerdict).join(), 'true,true');
  t('DS-500 one that is there and not clean, or an approval line, does not', [dirtyLine, studiaLine, limitLine].map(staleVerdict).join(), 'false,false,false');

  // AC1: a protected file the criteria may not need goes to a worker, with the files in its brief.
  const p1 = gateTry(tk(), pr([ok('tests'), gateRed(pkgLine)]), gctx());
  t('DS-500 AC1 a protected file goes to a protected-files try', `${p1?.call} ${p1?.fix.kind} ${p1?.fix.try}/${p1?.fix.of} ${p1?.fix.ready}`, `requeue protected 1/${FIX_TRIES_MAX} true`);
  t('DS-500 AC1 it carries the files', p1?.fix.paths.join(), 'apps/portal/apps/web/package.json');
  const pb = fixBrief(tk({ fix: p1.fix }));
  t('DS-500 AC1 its brief lists each file and has the worker drop what the criteria do not need', pb.includes('- apps/portal/apps/web/package.json') && /acceptance criteria/.test(pb) && /never move it to another path/.test(pb), true);
  t('DS-500 AC1 its task pushes only a drop, and leaves the PR out of draft', /If every change is needed, change nothing and push nothing.*leave the PR out of draft/.test(fixTask(tk({ fix: p1.fix }))), true);
  t('DS-500 AC1 it is not one of the fix tries', fixCall(tk({ fix_tries: [p1.fix] }), pr([ok('tests'), red('Lint', '9')]), ctx({ reruns: () => 2, required: ['tests', 'Lint'] }))?.fix.try, 1);
  t('DS-500 AC1 a protected try that moved no head leaves a red check\'s fix try to make', fixCall(tk({ fix_tries: [p1.fix] }), pr([ok('tests'), red('Lint', '9')]), ctx({ required: ['tests', 'Lint'] }))?.call, 'requeue');
  t('DS-500 AC1 desk\'s own gate line goes the same way', gateTry(tk(), pr([ok('tests'), gateRed(deskLine)]), gctx({ stateChecks: [{ name: GATE, kind: 'approval' }] }))?.fix.paths.join(), 'package.json');

  // AC3: a file the try judged needed is the person's: no worker again, at this head or the next.
  t('DS-500 AC3 tried at this head: no second try', gateTry(tk({ fix_tries: [p1.fix] }), pr([ok('tests'), gateRed(pkgLine)]), gctx()), null);
  t('DS-500 AC3 and fixCall then puts it to the person', fixCall(tk({ fix_tries: [p1.fix] }), pr([ok('tests'), gateRed(pkgLine)]), ctx({ stateChecks: STATE_BARE }))?.call, 'stuck');
  const NEXT = 'c'.repeat(40);
  const both = gateTry(tk(), pr([ok('tests'), gateRed(studiaLine)]), gctx());
  t('DS-500 AC3 after a try dropped one file, the files it judged needed send no worker at the new head',
    gateTry(tk({ fix_tries: [both.fix] }), pr([ok('tests'), gateRed(studiaLine)], { head: NEXT }), gctx()), null);
  const added = gateTry(tk({ fix_tries: [p1.fix] }), pr([ok('tests'), gateRed(studiaLine)], { head: NEXT }), gctx());
  t('DS-500 a file no try has judged gets one at a new head', `${added?.fix.kind} ${added?.fix.try}`, 'protected 2');
  t('DS-500 at most FIX_TRIES_MAX protected tries a PR', gateTry(tk({ fix_tries: [p1.fix, { ...p1.fix, head: OLD, paths: ['x'] }] }), pr([ok('tests'), gateRed(studiaLine)], { head: NEXT }), gctx()), null);
  t('DS-500 the file limit alone sends no worker: only a person approves it', gateTry(tk(), pr([ok('tests'), gateRed(limitLine)]), gctx()), null);

  // AC2: a verdict the gate cannot read at the head is reviewed again there before any item.
  const v2 = gateTry(tk(), pr([ok('tests'), gateRed(limitLine, oldFormatLine)]), gctx());
  t('DS-500 AC2 an old-format verdict goes to a review try at the head', `${v2?.call} ${v2?.fix.kind} ${v2?.fix.head === HEAD} ${v2?.fix.ready}`, 'requeue rereview true true');
  t('DS-500 AC2 its brief quotes the gate', fixBrief(tk({ fix: v2.fix })).includes(oldFormatLine), true);
  t('DS-500 AC2 so does a stale one', gateTry(tk(), pr([ok('tests'), gateRed(staleLine)]), gctx())?.fix.kind, 'rereview');
  t('DS-558 reviewed at this head once: a second review try', gateTry(tk({ fix_tries: [v2.fix] }), pr([ok('tests'), gateRed(limitLine, oldFormatLine)]), gctx())?.fix.try, 2);
  const g2 = gateTry(tk({ fix_tries: [v2.fix, v2.fix] }), pr([ok('tests'), gateRed(limitLine, oldFormatLine)]), gctx());
  t('DS-558 AC3 reviewed at this head twice already: the person\'s, named as a review that did not post, and no fix try is sent', `${g2?.call} ${/^no review verdict readable at its head after 2 review tries at it: /.test(g2?.why ?? '')}`, 'stuck true');
  const pv = gateTry(tk(), pr([ok('tests'), gateRed(pkgLine, staleLine)]), gctx());
  t('DS-500 AC2 beside a protected file, the protected try goes first', pv?.fix.kind, 'protected');
  t('DS-500 AC2 and the review try once it reported the file needed', gateTry(tk({ fix_tries: [pv.fix] }), pr([ok('tests'), gateRed(pkgLine, staleLine)]), gctx())?.fix.kind, 'rereview');
  t('DS-500 a verdict check of kind verdict is verdictTry\'s, not this', gateTry(tk(), pr([ok('tests'), gateRed(staleLine)]), gctx({ stateChecks: [{ name: GATE, kind: 'verdict' }] })), null);
  t('DS-500 a verdict that is there and not clean is a fix worker\'s', gateTry(tk(), pr([ok('tests'), gateRed(dirtyLine)]), gctx()), null);
  t('DS-500 a draft, a conflict or a pending check: not this', [pr([gateRed(pkgLine)], { isDraft: true }), pr([gateRed(pkgLine)], { mergeable: 'CONFLICTING' }), pr([gateRed(pkgLine), { name: 'tests', status: 'in_progress', conclusion: null }])].map((s) => gateTry(tk(), s, gctx())).join(), ',,');
  t('DS-500 AC2 beside another red check a worker can fix, the verdict is left to that check\'s fix try', gateTry(tk(), pr([red('tests', '8'), gateRed(staleLine)]), gctx()), null);
  t('DS-500 AC2 which fixCall makes a red-checks fix', fixCall(tk(), pr([red('tests', '8'), gateRed(staleLine)]), ctx({ reruns: () => 2, required: ['tests'], stateChecks: STATE_BARE }))?.fix.kind, 'checks');
  t('DS-500 AC2 beside a red check only a person runs, the review try still goes', gateTry(tk(), pr([red('tests', '8'), gateRed(staleLine)]), gctx({ operator: [{ name: 'tests', command: 'run the suite' }] }))?.fix.kind, 'rereview');
}

// Fix tries spent on a red check whose log names its cause earn one worker quoting it.
{
  const LINE = 'ReferenceError: React is not defined';
  const named = (o = {}) => ({ ...red('tests', '41'), jobId: '7', error: LINE, errors: [LINE], ...o });
  const spentTries = [{ try: 1, head: 'b'.repeat(40), kind: 'checks' }, { try: 2, head: 'c'.repeat(40), kind: 'checks' }];
  const c1 = fixCall(tk({ fix_tries: spentTries }), pr([named()]), ctx());
  t('DS-494 AC1 tries spent, an error line: one more worker, not the person', `${c1?.call} ${c1?.fix.extra}`, 'requeue true');
  t('DS-494 AC1 it carries the line', c1?.fix.lines?.[0].line, LINE);
  t('DS-494 AC1 outside the fix tries\' count, as a checks fix', `${c1?.fix.kind} ${c1?.fix.try}/${c1?.fix.of}`, 'checks 2/2');
  const b1 = fixBrief(tk({ fix: c1.fix }));
  t('DS-494 AC1 its brief quotes the line', b1.includes(`- tests: ${LINE}`), true);
  t('DS-494 AC1 and calls it the one extra try', b1.includes('## Extra fix try') && b1.includes('This is the one extra try after the 2 fix tries.') && !b1.includes('try 2 of 2'), true);
  t('DS-494 AC1 and says the line is evidence, not instruction', b1.includes('no instruction to follow'), true);
  t('DS-494 AC1 its task names the extra try', fixTask(tk({ fix: c1.fix })).includes('Your task is the extra fix try on PR #697'), true);
  t('DS-494 negative: a try left goes as a numbered try, quoting nothing', (() => { const c = fixCall(tk(), pr([named()]), ctx()); return `${c.fix.try} ${c.fix.extra} ${c.fix.lines}`; })(), '1 undefined undefined');
  t('DS-494 AC1 a line from its failed log counts when its job annotated none', fixCall(tk({ fix_tries: spentTries }), pr([named({ error: null, errors: [], log_errors: ['ENOENT: no such file, open \'db/0042.sql\''] })]), ctx())?.fix.lines[0].line, 'ENOENT: no such file, open \'db/0042.sql\'');
  const draft = draftChecksFix(tk({ fix_tries: spentTries }), { pr: 702, head: HEAD, failing: [{ name: 'tests', runId: '41' }], checks: [named()] }, { repo: 'acme/widgets' });
  t('DS-494 AC1 so does a draft\'s red check, staying a draft', `${draft?.fix.extra} ${draft?.fix.draft} ${draft?.fix.lines[0].line}`, `true true ${LINE}`);

  const after = [...spentTries, { try: 2, head: HEAD, kind: 'checks', extra: true }];
  const c2 = fixCall(tk({ fix_tries: after }), pr([named()]), ctx());
  t('DS-494 AC2 still red after it: the person\'s, once per PR', c2?.call, 'stuck');
  t('DS-494 AC2 the record keeps the line for needs-you', c2?.checks?.[0].error, LINE);
  t('DS-494 AC2 and the reason quotes it', c2?.why, `still red after 3 fix tries: tests says "${LINE}"`);

  t('DS-494 AC3 no error line: routing as today', fixCall(tk({ fix_tries: spentTries }), pr([red('tests', '41')]), ctx())?.why, 'still red after 2 fix tries: tests');
  t('DS-494 AC3 and an empty log reading is none', fixCall(tk({ fix_tries: spentTries }), pr([named({ error: null, errors: [], log_errors: [] })]), ctx())?.call, 'stuck');
  t('DS-494 an approval line is the person\'s, so no extra try', fixCall(tk({ fix_tries: spentTries }), pr([named({ errors: ['Approval required — 1 protected file(s): `a.sql`'] })]), ctx())?.call, 'stuck');

  t('DS-494 a log names a typed error and an errno', errorLinesIn('job\tRun\t2026-11-04T10:00:00.000Z ReferenceError: React is not defined\njob\tRun\t2026-11-04T10:00:01.000Z Error: ENOENT: open a.sql').join('|'), 'ReferenceError: React is not defined|Error: ENOENT: open a.sql');
  t('DS-494 negative: an exit line, a clean summary and plain output name none', errorLinesIn('##[error]Process completed with exit code 1.\nTests: 0 failed, 3 passed\nbuilding…').length, 0);
  t('DS-494 a build tool\'s capitalised error lines name a cause', errorLinesIn('ERROR: Could not find a version\n[ERROR] Failed to execute goal\nFailed to compile.\nBUILD FAILURE').length, 4);
  t('DS-494 each line once, at most five', errorLinesIn(['a error', 'a error', 'b error', 'c error', 'd error', 'e error', 'f error'].join('\n')).length, 5);
}

{
  // Each try that asks for a review names §4 Local review command's, and desk-review only in its place.
  const H = 'a'.repeat(40);
  const tries = {
    rereview: { try: 1, of: 2, pr: 9, head: H, kind: 'rereview', what: 'review its head: no verdict is posted' },
    review: { try: 1, of: 2, pr: 9, head: H, kind: 'review', verdict: 'p0=0 p1=1', findings: [{ sev: 'P1', text: 'src/a.ts:1 x' }] },
    renames: { try: 0, of: 2, extra: true, pr: 9, head: H, kind: 'renames', base: 'main', draft: true, renames: [{ old: 'a.sql', new: 'b.sql', to: 'm/b.sql', files: ['t.ts'] }] },
    protected: { try: 1, of: 2, pr: 9, head: H, kind: 'protected', checks: ['protected-path approval'], paths: ['x.sql'] },
    instruction: { try: 1, of: 1, pr: 9, head: H, kind: 'instruction', ready: true, what: 'your instruction', answer: 'do x' },
    gaps: { try: 1, of: 1, pr: 9, head: H, kind: 'gaps', ready: false, what: 'review gaps: your call', answer: 'drop it' },
  };
  const pull = (s) => `${s.includes('/pullbot')} ${s.includes('desk-review')}`;
  t('DS-545 AC1 a review try\'s task names /pullbot, never desk-review', pull(fixTask(tk({ fix: tries.rereview }), '/pullbot')), 'true false');
  t('DS-545 AC1 and so does its Review try section', pull(fixBrief(tk({ fix: tries.rereview }), '/pullbot')), 'true false');
  t('DS-545 AC1 and it is told to post the review as /pullbot says', fixTask(tk({ fix: tries.rereview }), '/pullbot').includes('Review its head with /pullbot and post its review on the PR as its own instructions say, and change no code.'), true);
  t('DS-545 AC2 a review fix reviews the new head with /pullbot', /review the new head with \/pullbot and post its review on the PR as its own instructions say/.test(fixTask(tk({ fix: tries.review }), '/pullbot')), true);
  t('DS-545 AC2 and neither its task nor its brief names desk-review', `${fixTask(tk({ fix: tries.review }), '/pullbot').includes('desk-review')} ${fixBrief(tk({ fix: tries.review }), '/pullbot').includes('desk-review')}`, 'false false');
  t('DS-545 AC3 a draft\'s rename try re-reviews with /pullbot', pull(fixTask(tk({ fix: tries.renames }), '/pullbot')), 'true false');
  t('DS-545 AC3 so does a protected-file try', pull(fixTask(tk({ fix: tries.protected }), '/pullbot')), 'true false');
  t('DS-545 AC4 the person\'s instruction re-reviews with /pullbot', pull(fixTask(tk({ fix: tries.instruction }), '/pullbot')), 'true false');
  t('DS-545 AC4 so does the person\'s call on gaps, brief included', `${pull(fixTask(tk({ fix: tries.gaps }), '/pullbot'))} ${pull(fixBrief(tk({ fix: tries.gaps }), '/pullbot'))}`, 'true false true false');
  for (const [kind, fix] of Object.entries(tries)) {
    const asToday = [fixTask(tk({ fix })), fixBrief(tk({ fix }))];
    const same = ['/desk-review', 'none', '', null].every((r) => fixTask(tk({ fix }), r) === asToday[0] && fixBrief(tk({ fix }), r) === asToday[1]);
    t(`DS-545 AC5 a ${kind} try under /desk-review, none or an unset row reads as today`, same, true);
  }
  // A narrowed try's targeted round is desk-review's own, so another review reads the whole head.
  const tT = fixTask(tk({ fix: rvT.fix }), '/pullbot'), bT = fixBrief(tk({ fix: rvT.fix }), '/pullbot');
  t('DS-545 AC1 a narrowed review try under /pullbot names /pullbot alone, task and brief', `${pull(tT)} ${pull(bT)}`, 'true false true false');
  t('DS-545 AC1 and it asks for a whole review, with no Targeted section', `${tT.includes('targeted')} ${bT.includes('Targeted')}`, 'false false');
  t('DS-545 AC5 a narrowed try under /desk-review reads as today', fixTask(tk({ fix: rvT.fix }), '/desk-review') === fixTask(tk({ fix: rvT.fix })) && fixBrief(tk({ fix: rvT.fix }), '/desk-review') === briefT, true);
  t('DS-545 AC5 and today\'s names desk-review Phase 7', fixTask(tk({ fix: tries.rereview })).includes('Review its head with desk-review and post that review on the PR (desk-review Phase 7), and change no code.'), true);
}

// DS-548: a ready PR red on a §4 Check builds check gets the draft's host build and sync try, and
// only a build that failed goes to the person, with its last line.
{
  const rows = [{ name: 'Flows image', command: './scripts/ensure-flows-image.sh' }];
  const built = { state: 'done', command: rows[0].command, code: 0, tail: 'pushed', reran: null };
  const failed = { ...built, code: 1, tail: 'step 7 / ECR denied the push' };
  // ctx.build as pass.mjs gives it: buildCall on the red build checks alone, with the record at HEAD.
  const bctx = (rec, { behind = () => null, rerun = 'yes', ...o } = {}) => ctx({ operator: [], builds: rows,
    build: (failing) => buildCall({ pending: [], failing }, { builds: rows, rerun, built: (h) => (h === HEAD ? rec : null), behind }, 697, HEAD, tk()), ...o });
  const only = pr([ok('tests'), red('Flows image', '903')]);
  const a1 = fixCall(tk(), only, bctx(null));
  t('DS-548 AC1 ready and red only on a check build not run at its head: the build runs', `${a1?.call} | ${a1?.command} | ${a1?.checks} | ${a1?.runs}`, 'build | ./scripts/ensure-flows-image.sh | Flows image | 903');
  t('DS-548 AC1 while it runs, nothing goes to anyone', fixCall(tk(), only, bctx({ state: 'running', command: built.command }))?.call, 'wait');
  t('DS-548 AC1 once it succeeded, the check is re-run', fixCall(tk(), only, bctx(built))?.call, 'rebuilt');
  t('DS-548 AC1 negative control: with §3 ci-rerun not yes it is the person\'s, with its command, as before', fixCall(tk(), only, bctx(null, { rerun: 'ask' }))?.why, 'Flows image · ./scripts/ensure-flows-image.sh');
  const a2 = fixCall(tk(), only, bctx(failed, { behind: () => 'main' }));
  t('DS-548 AC2 a build that failed behind the base goes to a sync try, out of draft', `${a2?.call} | ${a2?.fix.kind} | ${a2?.fix.draft} | ${a2?.fix.try}/${a2?.fix.of} | ${a2?.fix.base} | ${a2?.fix.what}`,
    `requeue | sync | undefined | 1/${FIX_TRIES_MAX} | main | ready PR behind main, its check build failed`);
  const brief2 = fixBrief(tk({ fix: a2.fix }));
  t('DS-548 AC2 its brief says the PR is out of draft and leaves the build to the pass', brief2.includes(`Your PR #697 is open and out of draft on this branch, and its head ${HEAD.slice(0, 12)} is behind main.`) && brief2.includes('Do not run the check build yourself'), true);
  t('DS-548 AC2 its task merges the base and leaves the PR out of draft', fixTask(tk({ fix: a2.fix })).includes('merge origin/main into your branch') && fixTask(tk({ fix: a2.fix })).includes('leave the PR out of draft'), true);
  t('DS-548 AC2 the sync try shares FIX_TRIES_MAX with the red-check tries', fixCall(tk({ fix_tries: one }), only, bctx(failed, { behind: () => 'main' }))?.fix.try, 2);
  t('DS-548 AC2 negative control: up to date with its base, no sync try', fixCall(tk(), only, bctx(failed))?.call, 'stuck');
  t('DS-548 AC2 the draft\'s sync try is unchanged', syncFix(tk(), { pr: 855, head: HEAD, base: 'main', why: 'x' })?.fix.what, 'draft behind main, its check build failed');
  const mixed = pr([ok('tests'), red('Flows image', '903'), red('Lint', '902')]);
  const a3 = fixCall(tk(), mixed, bctx(null));
  t('DS-548 AC3 beside a check a worker fixes, that one goes to the worker and the build is no one\'s to clear by hand', `${a3?.call} | ${a3?.fix.what} | ${a3?.fix.not_mine.length} | ${a3?.fix.builds}`, 'requeue | red: Lint | 0 | Flows image');
  t('DS-548 AC3 its brief tells the worker to leave the built check red', fixBrief(tk({ fix: a3.fix })).includes('- Flows image is red too, and it is not yours to fix: §4 Check builds names it, so the pass builds your head once the rest are green.'), true);
  const a3s = fixCall(tk({ fix_tries: two }), mixed, bctx(null));
  t('DS-548 AC3 its tries spent, the stuck reason lists only the worker\'s check, and the build starts beside it', `${a3s?.call} | ${a3s?.why} | ${a3s?.checks.map((c) => c.name)} | ${a3s?.build?.call}`, 'stuck | still red after 2 fix tries: Lint | Lint | build');
  t('DS-548 AC3 negative control: with a try left, no build starts under the worker', a3?.build, undefined);
  const a3f = fixCall(tk({ fix_tries: two }), mixed, bctx(failed));
  t('DS-548 AC3 its tries spent and its build already failed, that build joins the stuck checks with its line', JSON.stringify(a3f?.checks), '[{"name":"Flows image","build":"./scripts/ensure-flows-image.sh","error":"ECR denied the push"},{"name":"Lint"}]');
  t('DS-548 AC3 once the rest are green, its build runs, tries spent or not', fixCall(tk({ fix_tries: two }), only, bctx(null))?.call, 'build');
  t('DS-548 AC3 negative control: with ci-rerun not yes the built check is the person\'s beside it, as before', fixCall(tk({ fix_tries: two }), mixed, bctx(null, { rerun: 'no' }))?.why, 'still red after 2 fix tries: Lint; Flows image · ./scripts/ensure-flows-image.sh');
  const a4 = fixCall(tk(), only, bctx(failed));
  t('DS-548 AC4 a build that failed up to date with its base is stuck, quoting its last line', `${a4?.call} | ${a4?.why}`, 'stuck | its check build `./scripts/ensure-flows-image.sh` exited 1: Flows image says "ECR denied the push"');
  t('DS-548 AC4 its check carries the build and the line, and no command a person runs', JSON.stringify(a4?.checks), '[{"name":"Flows image","build":"./scripts/ensure-flows-image.sh","error":"ECR denied the push"}]');
  const a4s = fixCall(tk({ fix_tries: two }), only, bctx(failed, { behind: () => 'main' }));
  t('DS-548 AC4 behind its base with no try left, stuck the same way', `${a4s?.call} | ${a4s?.why}`, 'stuck | still behind main with its check build failing after 2 fix tries: Flows image says "ECR denied the push"');
  const still = fixCall(tk(), only, bctx({ ...built, reran: { ok: true, out: '' } }));
  t('DS-548 AC4 negative control: still red after a build that passed and its re-run, a plain red check, not a failed build', `${still?.call} | ${JSON.stringify(still?.checks)}`, 'stuck | [{"name":"Flows image"}]');
  const refused = fixCall(tk(), only, bctx({ ...built, reran: { ok: false, out: 'HTTP 403' } }));
  t('DS-548 AC4 negative control: a refused re-run is the person\'s step, not a failed build', `${refused?.call} | ${JSON.stringify(refused?.checks)}`, 'stuck | [{"name":"Flows image","command":"re-run \\"Flows image\\" on #697"}]');
  const steps = { premerge: [{ name: 'Check portal schema mirror', command: 'apply the PR\'s migrations to staging first' }], steps: () => [] };
  const both = pr([ok('tests'), red('Flows image', '903'), red('Check portal schema mirror', '905')]);
  const a5 = fixCall(tk(), both, bctx(null, steps));
  t('DS-548 AC5 a pre-merge step beside it is the person\'s alone, and the build starts with it', `${a5?.call} | ${a5?.why} | ${a5?.build?.call}`, 'stuck | Check portal schema mirror · apply the PR\'s migrations to staging first | build');
  t('DS-548 AC5 while the build runs, that step alone is stuck', fixCall(tk(), both, bctx({ state: 'running', command: built.command }, steps))?.why, 'Check portal schema mirror · apply the PR\'s migrations to staging first');
  t('DS-548 AC5 negative control: a pre-merge step alone is the person\'s, as today', fixCall(tk(), pr([ok('tests'), red('Check portal schema mirror', '905')]), bctx(null, steps))?.why, 'Check portal schema mirror · apply the PR\'s migrations to staging first');
}

process.exit(fails ? 1 : 0);
