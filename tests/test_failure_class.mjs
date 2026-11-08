// suite: failure class (every park and fix try records one class; a red check is read against the base)
import { CLASSES, WAITING_CLASSES, PARK_RULES, parkClass, FIX_RULES, fixClass, runsState, baseSplit } from '../desk/bin/failure-class.mjs';
import { fixCall, fixBrief, draftChecksFix, parseOperatorChecks } from '../desk/bin/fix-tries.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

// Each class's rule, as a park record keeps it: the class a park gets is the first rule its text matches.
//   dependency wait     held behind a blocker until its PR merges, or waiting on another PR, ticket, run or live read
//   missing decision    a spine or plan waiting on the person; a ruling, approval, product/design/copy call,
//                       a lane C or D plan, a size or link to fix, a step the config does not grant, a question
//   application defect  specs left undone or failing; a P0 or P1, a red check or failing test, a conflict
//   quota               a usage limit, a budget or a spend cap
//   runner or resource  a wedged or killed worker, a worktree that would not set up, a cloud session that did
//                       not start, memory, disk, an unreachable service
//   base red            a check red on the default branch too
//   agent mistake       no marker, stray commits or files, a stage section missing, never posted what it had to
//   unclassified        none of the above; the text is kept as its evidence
const PARKS = [
  // Real park texts: pass.mjs and queue.mjs's own, and workers' AUTOPILOT_PARK lines from batch logs.
  ['dependency wait', 'held by orchestrator: blocked by DS-444 — starts once their PRs merge'],
  ['dependency wait', 'waiting on PR #41, the shared helper'],
  ['missing decision', 'which reviewer handle goes in the PR body?'],
  ['missing decision', 'spine awaiting approval: PR #12 has one strict expected-fail spec per criterion and stays draft. Check each spec means what its criterion says, then approve it (queue.mjs approve T-1) or send it back with a note (queue.mjs reject T-1 "<note>")'],
  ['missing decision', 'PR #159 conflicts with main in tests/test_pass.sh (DS-191, #160, changed the lines around the DS-155 checks), and workers never resolve a conflict. Rebasing would also need a force-with-lease push, which config §3 git-force-with-lease does not grant'],
  ['application defect', 'DS-192 self-review round 3 found a P1 (tests/test_harness.sh:203), fixed in 2e564d7 but not reviewed, and AC1 is narrowed'],
  ['application defect', 'acceptance specs not done: tests/spec/ac2.spec.ts still fails. PR #31 stays draft: send it back with what to fix (answer.mjs T-2 "<note>", then queue.mjs requeue T-2)'],
  ['runner or resource', 'wedged — no output for 6 passes, worker stopped (session 0b0c). Requeue it with queue.mjs requeue DS-301 (desk-autopilot\'s orchestrator-recovery.md); never resume the session by hand, which would run it without the worker sandbox'],
  ['runner or resource', 'worktree setup failed, not spawned — [setup-worktree] FAIL: .claude/agents is empty after the subagents sync'],
  ['agent mistake', 'its worker ended with no marker, so your instruction on PR #88 may not be carried out, and the PR stays held from merging. Requeue it for a new worker on the same instruction — check /x/logs/T-3.log'],
  // No park on record has these two yet: the usage limit holds a batch rather than parking it, and base
  // red is new. Each is a worker's park in the form the contract has it write.
  ['quota', 'stopped at the worker budget ($25.00 of $25): the self-review and the PR are not reached'],
  ['base red', 'CI Lint is red on main too (run 9001), so it is not this branch\'s: the PR, the review comment and the Jira comment are not reached'],
];
PARKS.forEach(([want, text], i) => t(`AC1 park fixture ${i + 1} is ${want}`, parkClass(text).class, want));
t('AC1 every class but unclassified has a park rule', CLASSES.filter((c) => c !== 'unclassified' && !PARK_RULES.some((r) => r.class === c)).join(', '), '');
t('AC1 a park records exactly one class, from the list', PARKS.every(([, x]) => CLASSES.includes(parkClass(x).class)), true);
t('AC1 and the rule that gave it', parkClass(PARKS[0][1]).class_rule, 'held behind a blocker until its PR merges');
// AC5: a park no rule matches (a real one from a batch log).
const odd = parkClass('waiting on the weather');
t('AC5 a park no rule matches is unclassified', odd.class, 'unclassified');
t('AC5 and its evidence is kept with it', odd.evidence, 'waiting on the weather');
t('AC5 a classified park carries no evidence field', 'evidence' in parkClass(PARKS[0][1]), false);
t('AC5 an empty park is unclassified', parkClass('').class, 'unclassified');

// AC2 and AC4: a fix try's class, read from its kind, what it quotes and its ticket.
t('AC2 a red-checks try is an application defect', fixClass({ kind: 'checks', what: 'red: Lint' }, { key: 'T-1' }).class, 'application defect');
t('AC2 a review try with findings is an application defect', fixClass({ kind: 'review', findings: [{ sev: 'P1', text: 'a.ts:3 null deref' }] }, {}).class, 'application defect');
t('AC2 a review try for a missing verdict is an agent mistake', fixClass({ kind: 'rereview' }, {}).class, 'agent mistake');
t('AC2 a capture try is an agent mistake', fixClass({ kind: 'capture', files: ['a.png'] }, {}).class, 'agent mistake');
t('AC2 every fix rule names a class from the list', FIX_RULES.every((r) => CLASSES.includes(r.class)), true);
const dep = fixClass({ kind: 'checks' }, { held_by: 'DS-1|DS-2' });
t('AC4 a try whose ticket is held behind a blocker is a dependency wait', `${dep.class} · ${dep.waiting}`, 'dependency wait · waiting for DS-1, DS-2 to merge');
const released = fixClass({ kind: 'checks' }, { held_by: null, held_outside: 'X-7' });
t('AC4 a ticket released by hand, its held_outside left behind, does not wait', released.class, 'application defect');
const outside = fixClass({ kind: 'checks' }, { held_by: 'X-7|DS-1', held_outside: 'X-7' });
t('AC4 a blocker outside the batch is named once', outside.waiting, 'waiting for X-7, DS-1 to merge');
const dec = fixClass({ kind: 'review', gaps: ['AC3: the empty state needs a product decision on its wording'] }, {});
t('AC4 a try whose every gap asks for a product call is a missing decision', `${dec.class} · ${dec.waiting}`, "missing decision · waiting for a person's call on what it quotes");
t('AC4 one gap a worker can close beside it makes it an application defect', fixClass({ kind: 'review', gaps: ['AC3: needs a product decision', 'AC4: the retry is not capped'] }, {}).class, 'application defect');
t('AC4 the classes that wait', WAITING_CLASSES.join(', '), 'missing decision, dependency wait');

// The base's state for a job at one commit.
t('base: a failed run is red', runsState([{ status: 'completed', conclusion: 'failure' }]), 'fail');
t('base: a passing run is green', runsState([{ status: 'completed', conclusion: 'success' }]), 'pass');
t('base: no run is unknown', runsState([]), null);
t('base: a run still going is unknown', runsState([{ status: 'in_progress', conclusion: null }]), null);
t('base: a cancelled run is unknown, not red', runsState([{ status: 'completed', conclusion: 'cancelled' }]), null);
t('base: unread is unknown', runsState(null), null);

const HEAD = 'a'.repeat(40), MB = 'b'.repeat(40);
const red = (name, runId = '9') => ({ name, status: 'completed', conclusion: 'failure', runId });
const ok = (name) => ({ name, status: 'completed', conclusion: 'success', runId: '1' });
const pr = (checks) => ({ pr: 700, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeState: 'BLOCKED', head: HEAD, checks });
const read = (atMb, latest = {}) => ({ mergeBase: () => MB, atMergeBase: (n) => atMb[n] ?? null, latestOnBase: (n) => latest[n] ?? null });
const ctx = (o = {}) => ({ repo: 'acme/widgets', base: 'main', required: ['tests'], advisory: [], operator: [], reruns: () => 2, cooledDown: true, waived: () => false, ...o });

// AC3: red on the base at the merge base too: base red, held, no try.
const held = fixCall({ key: 'T-1' }, pr([ok('tests'), red('Lint')]), ctx({ baseRead: read({ Lint: 'fail' }) }));
t('AC3 red on the base at the merge base: held, no try', `${held?.call} ${held?.class} ${held?.fix}`, 'held base red undefined');
t('AC3 the hold is kept for this head and merge base', JSON.stringify(held?.base_red), JSON.stringify({ class: 'base red', head: HEAD, merge_base: MB, checks: ['Lint'], cleared: [] }));
t('AC3 and says why', held?.why, 'base red: Lint is red on main at the merge base bbbbbbbbbbbb too, so no fix try is spent on it; it goes to a fix try once that job passes on main');
const draftHeld = draftChecksFix({ key: 'T-1' }, { pr: 701, head: HEAD, failing: [red('Lint')] }, { repo: 'acme/widgets', base: 'main', baseRead: read({ Lint: 'fail' }) });
t('AC3 a draft red on the base too is held the same way', `${draftHeld?.call} ${draftHeld?.base_red?.checks}`, 'held Lint');
// One red on the base beside one that is not: the try proceeds, the base red one named as not the worker's.
const mixed = fixCall({ key: 'T-1' }, pr([ok('tests'), red('Lint'), red('Unit', '8')]), ctx({ baseRead: read({ Lint: 'fail', Unit: 'pass' }) }));
t('AC3 one red on the base beside one that is not: the try takes the other', `${mixed?.call} ${mixed?.fix.what}`, 'requeue red: Unit');
t('AC3 and its brief names the base red check as not the worker\'s', fixBrief({ fix: mixed.fix }).includes('- Lint is red too, and on main at your merge base as well, so it is not yours to fix: leave it red.'), true);

// AC6: no run at the merge base: not base red, the try proceeds, and says the base state is unknown.
const unknown = fixCall({ key: 'T-1' }, pr([ok('tests'), red('Lint')]), ctx({ baseRead: read({}) }));
t('AC6 no run at the merge base: the try proceeds', unknown?.call, 'requeue');
t('AC6 and says the base state is unknown', unknown?.fix.what, 'red: Lint; base state unknown for Lint (no run of it on main at the merge base)');
t('AC6 no hold is kept', unknown?.base_red, null);
const noMb = baseSplit([red('Lint')], HEAD, null, { mergeBase: () => null, atMergeBase: () => null, latestOnBase: () => null });
t('AC6 a merge base that cannot be read is unknown too', `${noMb.unknown.length} ${noMb.red.length}`, '1 0');

// AC8: a held check clears once the job passes on the base, and stays cleared at that head.
const tk = { key: 'T-1', base_red: held.base_red };
const still = fixCall(tk, pr([ok('tests'), red('Lint')]), ctx({ baseRead: read({ Lint: 'fail' }, { Lint: 'fail' }) }));
t('AC8 while the job is still red on the base, the hold stays', still?.call, 'held');
const cleared = fixCall(tk, pr([ok('tests'), red('Lint')]), ctx({ baseRead: read({ Lint: 'fail' }, { Lint: 'pass' }) }));
t('AC8 once it passes on the base, a fix try proceeds as today', `${cleared?.call} ${cleared?.fix.what}`, 'requeue red: Lint');
t('AC8 and the check is kept cleared at that head', JSON.stringify(cleared?.base_red?.cleared), '["Lint"]');
const after = fixCall({ key: 'T-1', base_red: cleared.base_red }, pr([ok('tests'), red('Lint')]), ctx({ baseRead: read({ Lint: 'fail' }) }));
t('AC8 a later pass at that head does not hold it again', after?.call, 'requeue');
const moved = fixCall({ key: 'T-1', base_red: cleared.base_red }, { ...pr([ok('tests'), red('Lint')]), head: 'c'.repeat(40) }, ctx({ baseRead: read({ Lint: 'fail' }) }));
t('AC8 a new head reads its own merge base again', moved?.call, 'held');

// Tries spent: the extra error-line try, and the stuck call after it, read the base as a numbered try does.
const LINE = 'ReferenceError: React is not defined';
const quoted = (name) => ({ ...red(name), errors: [LINE] });
const spentTries = [{ try: 1, head: 'd'.repeat(40), kind: 'checks' }, { try: 2, head: 'e'.repeat(40), kind: 'checks' }];
const allTried = [...spentTries, { try: 2, head: 'f'.repeat(40), kind: 'checks', extra: true }];
const heldRec = { class: 'base red', head: HEAD, merge_base: MB, checks: ['Lint'], cleared: [] };
const extra = fixCall({ key: 'T-1', fix_tries: spentTries, base_red: heldRec }, pr([ok('tests'), quoted('Lint')]), ctx({ baseRead: read({}, { Lint: 'pass' }) }));
t('AC8 a hold cleared on the extra try is kept', `${extra?.fix.extra} ${JSON.stringify(extra?.base_red?.cleared)}`, 'true ["Lint"]');
const extraAfter = fixCall({ key: 'T-1', fix_tries: spentTries, base_red: extra.base_red }, pr([ok('tests'), quoted('Lint')]), ctx({ baseRead: read({ Lint: 'fail' }, { Lint: 'fail' }) }));
t('AC8 so it stays cleared at that head when the base flips red', extraAfter?.fix?.extra, true);
const stuckCleared = fixCall({ key: 'T-1', fix_tries: allTried, base_red: heldRec }, pr([ok('tests'), quoted('Lint')]), ctx({ baseRead: read({}, { Lint: 'pass' }) }));
t('AC8 and on the stuck call after it', `${stuckCleared?.call} ${JSON.stringify(stuckCleared?.base_red?.cleared)}`, 'stuck ["Lint"]');
const draftExtra = draftChecksFix({ key: 'T-1', fix_tries: spentTries, base_red: heldRec }, { pr: 701, head: HEAD, failing: [red('Lint')], checks: [ok('tests'), quoted('Lint')] }, ctx({ baseRead: read({}, { Lint: 'pass' }) }));
t('AC8 and on a draft\'s extra try', `${draftExtra?.fix.extra} ${draftExtra?.fix.draft} ${JSON.stringify(draftExtra?.base_red?.cleared)}`, 'true true ["Lint"]');
const extraUnknown = fixCall({ key: 'T-1', fix_tries: spentTries }, pr([ok('tests'), quoted('Lint')]), ctx({ baseRead: read({}) }));
t('AC6 the extra try says the base state is unknown', extraUnknown?.fix.what, 'red: Lint; base state unknown for Lint (no run of it on main at the merge base)');
t('AC6 with nothing held, it clears no record', 'base_red' in extraUnknown && extraUnknown.base_red, null);
const extraMixed = fixCall({ key: 'T-1', fix_tries: spentTries }, pr([ok('tests'), quoted('Lint'), quoted('Unit')]), ctx({ baseRead: read({ Lint: 'fail', Unit: 'pass' }) }));
t('AC3 the extra try names a base red check once, as the numbered try does', `${JSON.stringify(extraMixed?.fix.base_red)} ${JSON.stringify(extraMixed?.fix.not_mine)}`, '["Lint"] []');
const offExtra = fixCall({ key: 'T-1', fix_tries: spentTries }, pr([ok('tests'), quoted('Lint')]), ctx());
t('AC7 lever off: the extra try carries no base fields', ['base_red', 'base'].some((k) => k in offExtra.fix) || 'base_red' in offExtra, false);

// AC7: with the lever off (no baseRead), routing is exactly as today.
const off = fixCall({ key: 'T-1' }, pr([ok('tests'), red('Lint')]), ctx());
t('AC7 lever off: requeued as today', `${off?.call} ${off?.fix.what}`, 'requeue red: Lint');
t('AC7 lever off: no base fields on the try or the call', ['base_red', 'base'].some((k) => k in off.fix) || 'base_red' in off, false);
const { checks: operator } = parseOperatorChecks(['Flows image missing: build it: ensure-flows-image.sh']);
t('AC7 lever off: a draft as today', JSON.stringify(draftChecksFix({ key: 'T-1' }, { pr: 701, head: HEAD, failing: [red('Lint')] }, { repo: 'acme/widgets', operator })), JSON.stringify({ call: 'requeue', fix: { try: 1, of: 2, pr: 701, head: HEAD, kind: 'checks', what: 'red: Lint', checks: [{ name: 'Lint', url: 'https://github.com/acme/widgets/actions/runs/9' }], not_mine: [], draft: true } }));

// ---- a draft's red check classed runner or resource is re-run once before a fix try
const NOSPACE = 'ENOSPC: no space left on device, write';
const spaced = (name, runId) => ({ ...red(name, runId), errors: [NOSPACE] });
const crun = (o = {}) => ({ perm: 'yes', reruns: () => 0, rerunsOk: () => 0, ...o });
const draftOf = (failing, checks, classRerun, more = {}, tk2 = {}) => draftChecksFix({ key: 'T-1', ...tk2 }, { pr: 701, head: HEAD, failing, checks }, { repo: 'acme/widgets', base: 'main', ...(classRerun ? { classRerun } : {}), ...more });
const once = draftOf([red('Lint', '9')], [ok('tests'), spaced('Lint', '9')], crun());
t('DS-488 AC1 a draft\'s only red check classed runner or resource is re-run, with no fix try', `${once?.call} ${once?.fix} ${once?.gate?.failedRuns}`, 'rerun undefined 9');
t('DS-488 AC1 and says why, in words the board reads as a runner rerun', once?.why, 'its "Lint" check is classed runner or resource, ended by the runner or a resource and not the code, so it is re-run once before any fix worker');
const NOW = Date.parse('2026-11-08T12:00:00Z');
const running = (name, runId, hoursAgo = 1) => ({ name, status: 'in_progress', conclusion: null, runId, started: new Date(NOW - hoursAgo * 3600e3).toISOString() });
const waits = draftOf([red('Lint', '9')], [spaced('Lint', '9'), running('Unit', '9')], crun(), { now: NOW });
t('DS-488 AC1 a run past the pending limit is not waited for: a job that never finishes cannot hold it', draftOf([red('Lint', '9')], [spaced('Lint', '9'), running('Unit', '9', 7)], crun(), { now: NOW })?.call, 'rerun');
t('DS-488 AC1 another job of its run still going: it waits, with no rerun and no fix try', `${waits?.call} ${waits?.gate} ${waits?.fix} | ${waits?.why}`, 'wait undefined undefined | checks still running (Unit) in the run of ones classed runner or resource, re-run once they finish');
t('DS-488 AC1 a check still going in another run does not hold the rerun', draftOf([red('Lint', '9')], [spaced('Lint', '9'), running('Unit', '8')], crun())?.call, 'rerun');
t('DS-488 AC1 the rerun\'s gate is as rerun.sh reads it', JSON.stringify(once?.gate), JSON.stringify({ pending: [], failedRuns: ['9'], reasons: [], failing: [{ name: 'Lint', runId: '9' }] }));
t('DS-488 AC1 two such checks across runs are both re-run', draftOf([red('Lint', '9'), red('Unit', '8')], [spaced('Lint', '9'), spaced('Unit', '8')], crun())?.gate.failedRuns.join(), '9,8');
const againBoth = (o) => draftOf([red('Lint', '9')], [spaced('Lint', '9')], crun(o));
const again = againBoth({ reruns: () => 1, rerunsOk: () => 1 });
t('DS-488 AC3 red again after its rerun: the fix try proceeds', `${again?.call} ${again?.fix.try}`, 'requeue 1');
t('DS-488 AC3 and its item says one rerun was already tried', again?.fix.what, 'red: Lint; classed runner or resource; one rerun was already tried at this head and it failed again');
t('DS-488 AC3 its brief says so too', fixBrief({ fix: again.fix }).includes('Their errors name the runner or a resource rather than the code: classed runner or resource; one rerun was already tried at this head and it failed again.'), true);
t('DS-488 AC3 the try keeps the class it has today', fixClass(again.fix, { key: 'T-1' }).class, 'application defect');
t('DS-488 a refused rerun is tried again', againBoth({ reruns: () => 1 })?.call, 'rerun');
t('DS-488 both reruns refused: the fix try goes ahead and says so', againBoth({ reruns: () => 2 })?.fix.what, 'red: Lint; classed runner or resource; GitHub refused desk\'s 2 reruns at this head');
const spentAgain = draftOf([red('Lint', '9')], [spaced('Lint', '9')], crun({ reruns: () => 1, rerunsOk: () => 1 }), {}, { fix_tries: [...allTried] });
t('DS-488 AC3 with no try left, the stuck reason says so too', spentAgain?.why, `still red after 3 fix tries: Lint says "${NOSPACE}"; classed runner or resource; one rerun was already tried at this head and it failed again`);
const appDefect = draftOf([red('Lint', '9')], [{ ...red('Lint', '9'), errors: [LINE] }], crun());
t('DS-488 AC4 classed anything else: no rerun, the fix try as today', `${appDefect?.call} ${appDefect?.fix.what}`, 'requeue red: Lint');
const beside = draftOf([red('Lint', '9'), red('Unit', '8')], [spaced('Lint', '9'), { ...red('Unit', '8'), errors: [LINE] }], crun());
t('DS-488 AC4 one such check beside a code error: no rerun', `${beside?.call} ${beside?.fix.what}`, 'requeue red: Lint, Unit');
t('DS-488 AC4 a check with no error line: no rerun', draftOf([red('Lint', '9')], [red('Lint', '9')], crun())?.call, 'requeue');
for (const perm of ['no', 'ask', undefined]) {
  const c = draftOf([red('Lint', '9')], [spaced('Lint', '9')], { perm, reruns: () => 0, rerunsOk: () => 0 });
  t(`DS-488 AC5 ci-rerun ${perm}: no rerun, and the item says reruns are not granted`, `${c?.call} | ${c?.fix.what}`, `requeue | red: Lint; classed runner or resource; config §3 ci-rerun is "${perm ?? 'no'}", so reruns are not granted`);
}
t('DS-488 AC6 lever off: exactly as today', JSON.stringify(draftOf([red('Lint', '9')], [spaced('Lint', '9')], null)), JSON.stringify({ call: 'requeue', fix: { try: 1, of: 2, pr: 701, head: HEAD, kind: 'checks', what: 'red: Lint', checks: [{ name: 'Lint', url: 'https://github.com/acme/widgets/actions/runs/9' }], not_mine: [], draft: true } }));
const heldFirst = draftOf([red('Lint', '9')], [spaced('Lint', '9')], crun(), { baseRead: read({ Lint: 'fail' }) });
t('DS-488 red on the base too stays held rather than re-run', heldFirst?.call, 'held');
const beatsRecord = draftOf([red('Lint', '9'), red('Unit', '8')], [spaced('Lint', '9'), spaced('Unit', '8')], crun(), { baseRead: read({ Lint: 'fail' }) });
t('DS-488 beside a base red check, only its own run is re-run and the hold is kept', `${beatsRecord?.call} ${beatsRecord?.gate.failedRuns} ${beatsRecord?.base_red?.checks}`, 'rerun 8 Lint');

if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
