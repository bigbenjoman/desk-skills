// suite: fix tries (a red or conflicted ready PR goes back to a worker, twice)
import { readFileSync } from 'node:fs';
import { fixCall, fixBrief, fixTask, parseOperatorChecks, reviewFindings, reviewFix, reviewGaps, reviewTry, draftChecksFix, conflictFix, captureTry, failedSteps, stuckWhy, FIX_TRIES_MAX } from '../desk/bin/fix-tries.mjs';
import { undraftCall, undraftComment, movedByBase } from '../desk/bin/undraft.mjs';
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
t('DS-281 AC6 only P2s: not a findings call, the person settles them as today', `${p2only?.call} ${p2only?.action}`, 'person settle the findings or gaps on #702');
t('DS-281 AC6 and reviewFix leaves it alone', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '0', p2: '2' } }), null);
const mixedTries = [{ try: 1, head: 'b'.repeat(40), kind: 'checks', what: 'red: Lint' }];
t('DS-384 a checks try leaves a review fix its own tries: the review try is try 1', reviewFix(tk({ fix_tries: mixedTries }), { pr: 702, head: HEAD, verdict: { p1: '1' }, body: p1Body })?.fix.try, 1);
t('DS-281 AC7 and a review try counts toward a checks try', fixCall(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }] }), both, ctx())?.why, 'still red after 2 fix tries: Backend tests, Lint');

// ---- a review fix has tries of its own: a conflict try and a re-review try before it leave them
// DS-379's fix_tries as the queue recorded them on PR #348.
const ds379 = [{ try: 1, head: 'f73edbe' + '0'.repeat(33), kind: 'conflict', what: 'draft conflicts with main' },
  { try: 2, head: '597a520' + '0'.repeat(33), kind: 'rereview', what: 'review its head: its review verdict is for fdcfe56, not the head 597a520' }];
const p0At = (head) => ({ pr: 348, head, verdict: { p0: '1', p1: '0' }, body: reviewBody('p0=1 p1=0 p2=0', ['- **P0** `desk/bin/evidence.mjs:40` a code span splits the cell']) });
const a1 = reviewFix(tk({ fix_tries: ds379 }), p0At(ds379[1].head));
t('DS-384 AC1 after a conflict try and a rereview try, a P0 at the head goes to a review fix worker', `${a1?.call} ${a1?.fix.kind} ${a1?.fix.try}/${a1?.fix.of}`, `requeue review 1/${FIX_TRIES_MAX}`);
t('DS-384 AC1 the try quotes the P0', a1?.fix.findings.map((x) => x.text).join('|'), '- **P0** `desk/bin/evidence.mjs:40` a code span splits the cell');
const reviewTries = (n, from = 3) => Array.from({ length: n }, (_, i) => ({ try: i + 1, head: `${from + i}`.repeat(40), kind: 'review' }));
const a2 = reviewFix(tk({ fix_tries: [...ds379, ...reviewTries(FIX_TRIES_MAX)] }), p0At(HEAD));
t('DS-384 AC2 once its review fix tries are spent, findings at the head go to the person', `${a2?.call} | ${a2?.why}`, 'stuck | review not clean after 4 fix tries (1 conflict, 1 rereview, 2 review): 1 P0 — P0: - **P0** `desk/bin/evidence.mjs:40` a code span splits the cell');
const capped = [...ds379, { try: 3, head: 'd'.repeat(40), kind: 'checks' }, ...reviewTries(1)];
const a3 = reviewFix(tk({ fix_tries: capped }), p0At(HEAD));
t('DS-384 AC3 with a review try left but the overall cap reached, it goes to the person, naming the tries by kind', `${a3?.call} | ${a3?.why.split(':')[0]}`, 'stuck | review not clean after 4 fix tries (1 conflict, 1 rereview, 1 checks, 1 review)');
t('DS-384 AC3 an extra review try a base merge earned counts toward neither cap', reviewFix(tk({ fix_tries: [...ds379, { try: 2, head: 'e'.repeat(40), kind: 'rereview', extra: true }, ...reviewTries(1)] }), p0At(HEAD))?.fix.try, 2);

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
t('DS-319 a review counting a gap it does not list is left for the person', reviewFix(tk(), { pr: 702, head: HEAD, verdict: { gaps: '1' }, body: gapBody('p0=0 p1=0 p2=0', 1, ['### Requirement gaps', 'None.']) }, { judgement: 'yes' }), null);
const p1g = reviewFix(tk(), { pr: 702, head: HEAD, verdict: { p0: '0', p1: '1', gaps: '1' }, body: p1Body }, { judgement: 'yes' });
t('DS-319 a P1 and a gap go in one try, both quoted', `${p1g?.fix.what} | ${p1g?.fix.findings.length} | ${p1g?.fix.gaps}`, 'review not clean: 1 P1, 1 gap | 1 | AC3: src/csv.ts:4 no VAT column');
t('DS-319 the terminal report\'s gaps are read, and an unverified code claim is not a gap', JSON.stringify(reviewGaps('REQUIREMENT GAPS (2, 1 unverified)  ABC-123\n AC3: "export includes VAT" — no VAT column\n AC1: "keyed per tenant" — UNVERIFIED CODE CLAIM, terminal only\n\nUNPROVEN PREMISES (1)\n src/a.ts:1 assumes retries')), JSON.stringify(['AC3: "export includes VAT" — no VAT column']));
t('DS-319 a bold-only heading opens and ends the gaps section', JSON.stringify(reviewGaps('**Requirement gaps**\n- AC1: "x" — not done\n**Scope**\n- src/a.ts:3 out of scope')), JSON.stringify(['AC1: "x" — not done']));
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
t('DS-316 AC5 a review try already made at this head leaves it to the person, saying what is unread', reviewTry(tk({ fix_tries: rvTried }), { pr: 702, head: HEAD, why: 'no desk-review verdict is posted on it' })?.why, 'no review verdict readable at its head after 1 fix try: no desk-review verdict is posted on it');
t('DS-316 AC5 so does one with both tries spent', reviewTry(tk({ fix_tries: tried }), { pr: 702, head: HEAD, why: 'x' })?.call, 'stuck');
t('DS-316 a review try at this head does not use up a fix of the findings it then posts', reviewFix(tk({ fix_tries: rvTried }), { pr: 702, head: HEAD, verdict: u1.verdict, body: u1.review })?.call, 'requeue');

// ---- DS-377: a head a merge from the base moved gets a review try of its own, outside the fix tries
const unread = 'its latest review is for ccccccccc, not the head aaaaaaaaa';
const merged = reviewTry(tk({ fix_tries: tried }), { pr: 871, head: HEAD, why: unread, base: 'feat/epics', baseMerge: () => true });
t('DS-377 AC3 tries spent, a head moved by a base merge goes to a review worker, not the person', `${merged?.call} ${merged?.fix.kind} ${merged?.fix.extra} ${merged?.fix.head === HEAD}`, 'requeue rereview true true');
t('DS-377 AC3 it says the base merge moved the head', merged?.fix.what, `review its head, moved by a merge from feat/epics: ${unread}`);
const briefX = fixBrief(tk({ fix: merged.fix }));
t('DS-377 AC3 its brief says the try is not one of the fix tries', briefX.includes('## Review try for a merge from the base: PR #871') && briefX.includes(`at its head ${HEAD.slice(0, 12)}: ${unread}.`) && briefX.includes('this try is not one of the 2 fix tries'), true);
t('DS-377 AC3 its task names the extra review try', fixTask(tk({ fix: merged.fix })).includes('Your task is a review try after a merge from the base on PR #871'), true);
t('DS-377 AC3 a head no base merge moved is stuck as before, and the merge is not asked of a head already tried', reviewTry(tk({ fix_tries: tried }), { pr: 871, head: HEAD, why: unread, baseMerge: () => false })?.call
  + ' ' + reviewTry(tk({ fix_tries: rvTried }), { pr: 871, head: HEAD, why: unread, baseMerge: () => { throw new Error('asked'); } })?.call, 'stuck stuck');
const afterX = [...tried, { try: 2, head: HEAD, kind: 'rereview', extra: true }];
t('DS-377 AC4 still unreadable after that try, it is the person\'s as today', reviewTry(tk({ fix_tries: afterX }), { pr: 871, head: HEAD, why: unread, baseMerge: () => true })?.why, `no review verdict readable at its head after 3 fix tries: ${unread}`);
const oneX = [{ try: 0, head: OLD, kind: 'rereview', extra: true }];
t('DS-377 the extra try is not counted: a fix try after it is try 1 of 2', reviewTry(tk({ fix_tries: oneX }), { pr: 871, head: HEAD, why: unread })?.fix.try, 1);
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
// Every try counts towards a conflict try, while a review fix counts only review fix tries (DS-384).
t('DS-318 a review try counts towards the conflict tries', conflictFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review' }] }), { pr: 702, head: HEAD, base: 'main' })?.fix.try, 2);
t('DS-318 two review tries leave no conflict try', conflictFix(tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review' }, { try: 2, head: 'c'.repeat(40), kind: 'review' }] }), { pr: 702, head: HEAD, base: 'main' })?.why, 'still in conflict with main after 2 fix tries');
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

process.exit(fails ? 1 : 0);
