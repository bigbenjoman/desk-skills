// suite: fix tries (a red or conflicted ready PR goes back to a worker, twice)
import { fixCall, fixBrief, fixTask, parseOperatorChecks, FIX_TRIES_MAX } from '../desk/bin/fix-tries.mjs';
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

process.exit(fails ? 1 : 0);
