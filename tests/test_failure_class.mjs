// suite: failure class (every park and fix try records one class; a red check is read against the base)
// layer: L1
import { CLASSES, WAITING_CLASSES, PARK_RULES, parkClass, FIX_RULES, fixClass, runsState, baseSplit, keptHold, failingTestNames } from '../desk/bin/failure-class.mjs';
import { makeBaseReads } from '../desk/bin/base-reads.mjs';
import { fixCall, fixBrief, draftChecksFix, parseOperatorChecks, staleCall } from '../desk/bin/fix-tries.mjs';
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
// As the pass reads it, the latest state on the base is the merge base's when no run came since.
const read = (atMb, latest = {}) => ({ mergeBase: () => MB, atMergeBase: (n) => atMb[n] ?? null, latestOnBase: (n) => (n in latest ? latest[n] : atMb[n] ?? null) });
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
t('AC6 and says the base state is unknown', unknown?.fix.what, 'red: Lint; base state unknown for Lint (no run of it read on main at the merge base or since)');
t('AC6 no hold is kept', unknown?.base_red, null);
const noMb = baseSplit([red('Lint')], HEAD, null, { mergeBase: () => null, atMergeBase: () => null, latestOnBase: () => null });
t('AC6 a merge base that cannot be read is unknown too', `${noMb.unknown.length} ${noMb.red.length}`, '1 0');

// The base went red after the PR's merge base. A check that passed there, or had no run there,
// but whose latest run on the base fails is base red too.
const late = fixCall({ key: 'T-1' }, pr([ok('tests'), red('Size')]), ctx({ baseRead: read({ Size: 'pass' }, { Size: 'fail' }) }));
t('DS-614 AC1 passed at the merge base, red on the base\'s latest run: held, no try', `${late?.call} ${late?.class} ${late?.fix}`, 'held base red undefined');
t('DS-614 AC1 the hold records the check as red on the latest run', JSON.stringify(late?.base_red), JSON.stringify({ class: 'base red', head: HEAD, merge_base: MB, checks: ['Size'], cleared: [], latest: ['Size'] }));
t('DS-614 AC1 and says why', late?.why, 'base red: Size is red on main\'s latest run of that job since the merge base bbbbbbbbbbbb, so no fix try is spent on it; it goes to a fix try once that job passes on main');
t('DS-614 AC1 no run at the merge base, red on the latest: held too', fixCall({ key: 'T-1' }, pr([ok('tests'), red('Size')]), ctx({ baseRead: read({}, { Size: 'fail' }) }))?.call, 'held');
const lateDraft = draftChecksFix({ key: 'T-1' }, { pr: 701, head: HEAD, failing: [red('Size')] }, { repo: 'acme/widgets', base: 'main', baseRead: read({ Size: 'pass' }, { Size: 'fail' }) });
t('DS-614 AC1 a draft is held the same way', `${lateDraft?.call} ${lateDraft?.base_red?.latest}`, 'held Size');
const both = fixCall({ key: 'T-1' }, pr([ok('tests'), red('Lint'), red('Size', '8')]), ctx({ baseRead: read({ Lint: 'fail', Size: 'pass' }, { Size: 'fail' }) }));
t('DS-614 AC1 one red at the merge base and one on the latest run: each named for where', both?.why, 'base red: Lint is red on main at the merge base bbbbbbbbbbbb too, and Size is red on main\'s latest run of that job since the merge base bbbbbbbbbbbb, so no fix try is spent on it; it goes to a fix try once that job passes on main');
const lateMixed = fixCall({ key: 'T-1' }, pr([ok('tests'), red('Size'), red('Unit', '8')]), ctx({ baseRead: read({ Size: 'pass', Unit: 'pass' }, { Size: 'fail', Unit: 'pass' }) }));
t('DS-614 AC1 beside a check of its own, the try takes the other', `${lateMixed?.call} ${lateMixed?.fix.what} ${JSON.stringify(lateMixed?.fix.base_latest)}`, 'requeue red: Unit ["Size"]');
t('DS-614 AC1 and its brief says where the base red check is red', fixBrief({ fix: lateMixed.fix }).includes('- Size is red too, and on main in its latest run of that job as well, so it is not yours to fix: leave it red.'), true);
// AC2: the hold stays while the base's latest run is red, and clears once it passes.
const lateTk = { key: 'T-1', base_red: late.base_red };
const lateStill = fixCall(lateTk, pr([ok('tests'), red('Size')]), ctx({ baseRead: read({ Size: 'pass' }, { Size: 'fail' }) }));
t('DS-614 AC2 while the job is still red on the base, the hold stays and still says where', `${lateStill?.call} ${JSON.stringify(lateStill?.base_red?.latest)} ${/latest run of that job/.test(lateStill?.why)}`, 'held ["Size"] true');
t('DS-614 AC2 while the base\'s latest run cannot be read, the hold stays', fixCall(lateTk, pr([ok('tests'), red('Size')]), ctx({ baseRead: read({ Size: 'pass' }, { Size: null }) }))?.call, 'held');
const asked = [];
fixCall(lateTk, pr([ok('tests'), red('Size')]), ctx({ baseRead: { ...read({ Size: 'pass' }, { Size: 'fail' }), latestOnBase: (n, o) => { asked.push(o?.held === true); return 'fail'; } } }));
t('DS-614 AC2 a held check asks for the base\'s latest run as held, which may read further back', JSON.stringify(asked), '[true]');
const lateCleared = fixCall(lateTk, pr([ok('tests'), red('Size')]), ctx({ baseRead: read({ Size: 'pass' }, { Size: 'pass' }) }));
t('DS-614 AC2 once it passes on the base, the hold clears and a fix try proceeds as today', `${lateCleared?.call} ${lateCleared?.fix.what} ${JSON.stringify(lateCleared?.base_red?.cleared)} ${'latest' in (lateCleared?.base_red ?? {})}`, 'requeue red: Size ["Size"] false');
// AC3: green on the base's latest run and at the merge base: a fix try as today, with no unknown note.
const mineAll = fixCall({ key: 'T-1' }, pr([ok('tests'), red('Size')]), ctx({ baseRead: read({ Size: 'pass' }, { Size: 'pass' }) }));
t('DS-614 AC3 green on the base at the merge base and since: a fix try as today', `${mineAll?.call} ${mineAll?.fix.what} ${mineAll?.base_red}`, 'requeue red: Size null');
const greenLater = baseSplit([red('Size')], HEAD, null, read({}, { Size: 'pass' }));
t('DS-614 AC3 no run at the merge base but green since: the worker\'s, and not unknown', `${greenLater.mine.length} ${greenLater.unknown.length} ${greenLater.red.length}`, '1 0 0');
// AC5: neither read: a fix try, which says the base state is unknown.
const unread = baseSplit([red('Size')], HEAD, null, { mergeBase: () => null, atMergeBase: () => null, latestOnBase: () => null });
t('DS-614 AC5 the base\'s runs cannot be read: the worker\'s, and unknown', `${unread.mine.length} ${unread.unknown.length} ${unread.red.length} ${unread.record}`, '1 1 0 null');
const unreadLatest = fixCall({ key: 'T-1' }, pr([ok('tests'), red('Size')]), ctx({ baseRead: read({ Size: 'pass' }, { Size: null }) }));
t('DS-614 AC5 green at the merge base, but its latest run on the base unread: a fix try that says the base state is unknown', `${unreadLatest?.call} ${unreadLatest?.fix.what}`, 'requeue red: Size; base state unknown for Size (no run of it read on main at the merge base or since)');

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
t('AC6 the extra try says the base state is unknown', extraUnknown?.fix.what, 'red: Lint; base state unknown for Lint (no run of it read on main at the merge base or since)');
t('AC6 with nothing held, it clears no record', 'base_red' in extraUnknown && extraUnknown.base_red, null);
const extraMixed = fixCall({ key: 'T-1', fix_tries: spentTries }, pr([ok('tests'), quoted('Lint'), quoted('Unit')]), ctx({ baseRead: read({ Lint: 'fail', Unit: 'pass' }) }));
t('AC3 the extra try names a base red check once, as the numbered try does', `${JSON.stringify(extraMixed?.fix.base_red)} ${JSON.stringify(extraMixed?.fix.not_mine)}`, '["Lint"] []');
const offExtra = fixCall({ key: 'T-1', fix_tries: spentTries }, pr([ok('tests'), quoted('Lint')]), ctx());
t('AC7 no base read: the extra try carries no base fields', ['base_red', 'base'].some((k) => k in offExtra.fix) || 'base_red' in offExtra, false);

// AC7: with no base read (no baseRead), routing is exactly as before it.
const off = fixCall({ key: 'T-1' }, pr([ok('tests'), red('Lint')]), ctx());
t('AC7 no base read: requeued as today', `${off?.call} ${off?.fix.what}`, 'requeue red: Lint');
t('AC7 no base read: no base fields on the try or the call', ['base_red', 'base'].some((k) => k in off.fix) || 'base_red' in off, false);
const { checks: operator } = parseOperatorChecks(['Flows image missing: build it: ensure-flows-image.sh']);
t('AC7 no base read: a draft as today', JSON.stringify(draftChecksFix({ key: 'T-1' }, { pr: 701, head: HEAD, failing: [red('Lint')] }, { repo: 'acme/widgets', operator })), JSON.stringify({ call: 'requeue', fix: { try: 1, of: 2, pr: 701, head: HEAD, kind: 'checks', what: 'red: Lint', checks: [{ name: 'Lint', url: 'https://github.com/acme/widgets/actions/runs/9' }], not_mine: [], draft: true } }));

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

// ---- #805: a draft's red check whose failed log names no file the PR changes is re-run once at its head,
// every job of its run, before a fix try, with the failure-class lever on or off.
{
const CHANGED = ['apps/web/src/cart.ts', 'apps/web/src/cart.test.ts'];
const flaky = (name, runId, errors) => ({ ...red(name, runId), errors });
const away = flaky('Integration', '9', ['FAIL src/orders.test.ts > retries a timed-out order', 'AssertionError: expected 200 to be 504']);
const off805 = (o = {}) => crun({ classes: false, changed: CHANGED, ...o });
const out = draftOf([red('Integration', '9')], [ok('tests'), away], off805());
t('#805 a red check naming no changed file is re-run, lever off, with no fix try', `${out?.call} ${out?.fix} ${out?.gate?.failedRuns}`, 'rerun undefined 9');
t('#805 its whole run is re-run, so a job reading other jobs\' results reads the new ones', out?.gate?.full, true);
t('#805 and it says why', out?.why, 'its "Integration" check\'s failed log names no file this PR changes, so its run is re-run once at this head, every job, before any fix worker');
const crashed = draftOf([red('Test report', '9')], [ok('tests'), flaky('Test report', '9', ['TypeError: Cannot read properties of undefined (reading \'suites\')'])], off805());
t('#805 a job that crashed with no failed test is re-run too', crashed?.call, 'rerun');
t('#805 so is one with no error line at all', draftOf([red('Lint', '9')], [red('Lint', '9')], off805())?.call, 'rerun');
const inDiff = draftOf([red('Unit', '9')], [flaky('Unit', '9', ['FAIL src/cart.test.ts > totals the cart'])], off805());
t('#805 a failure naming a changed file, as the package runner prints it, goes to a fix try', `${inDiff?.call} ${inDiff?.fix?.what}`, 'requeue red: Unit');
t('#805 so does one whose annotation points at a changed file', draftOf([red('Unit', '9')], [{ ...flaky('Unit', '9', ['expected 3 to be 4']), error_paths: ['apps/web/src/cart.ts'] }], off805())?.call, 'requeue');
t('#805 one check naming a changed file beside one that does not: a fix try', draftOf([red('Unit', '9'), red('Integration', '8')], [flaky('Unit', '9', ['FAIL src/cart.test.ts']), { ...away, runId: '8' }], off805())?.call, 'requeue');
t('#805 the PR\'s files unread: as before', draftOf([red('Integration', '9')], [away], off805({ changed: null }))?.call, 'requeue');
// A log naming a changed file by its name less the extension (a dbt model or unit test), not its path.
const DBT = ['models/marts/fct_orders.sql', 'models/marts/schema.yml', 'models/marts/index.sql'];
const dbtFail = flaky('dbt build', '9', ['Failure in unit_test fct_orders::fct_orders_counts_refunds (models/marts/_unit_tests.yml)', '  actual differs from expected']);
const dbt = draftOf([red('dbt build', '9')], [dbtFail], off805({ changed: DBT }));
t('a dbt failure naming a changed model by name, with no .sql path, is the PR\'s own: a fix try, no rerun', `${dbt?.call} ${dbt?.fix?.what}`, 'requeue red: dbt build');
t('so is one naming it as dbt\'s node id', draftOf([red('dbt build', '9')], [flaky('dbt build', '9', ['Database Error in model.shop.fct_orders'])], off805({ changed: DBT }))?.call, 'requeue');
t('a name only inside a longer word is not that file', draftOf([red('dbt build', '9')], [flaky('dbt build', '9', ['Failure in test fct_orders_daily_unique_id'])], off805({ changed: DBT }))?.call, 'rerun');
t('nor is a generic name every log prints (schema, index)', draftOf([red('dbt build', '9')], [flaky('dbt build', '9', ['Compilation Error in schema test: index out of range'])], off805({ changed: DBT }))?.call, 'rerun');
t('a changed file named after a dbt node type is no evidence: model.sql against model.shop.dim_customers is rerun', draftOf([red('dbt build', '9')], [flaky('dbt build', '9', ['Database Error in model.shop.dim_customers'])], off805({ changed: ['models/model.sql'] }))?.call, 'rerun');
t('so is one named after any other dbt resource type: semantic_model.yml against semantic_model.shop.revenue', draftOf([red('dbt build', '9')], [flaky('dbt build', '9', ['Parsing Error in semantic_model.shop.revenue'])], off805({ changed: ['models/semantic_model.yml'] }))?.call, 'rerun');
t('a dbt failure naming nothing the PR changed is still rerun as environmental', draftOf([red('dbt build', '9')], [flaky('dbt build', '9', ['Failure in unit_test dim_customers::dim_customers_dedupes'])], off805({ changed: DBT }))?.call, 'rerun');
const after = draftOf([red('Integration', '9')], [away], off805({ reruns: () => 1, rerunsOk: () => 1 }));
t('#805 red again after its rerun: the fix try goes ahead and says so', after?.fix?.what, 'red: Integration; its failed log names no file this PR changes; one rerun was already tried at this head and it failed again');
t('#805 its brief says so too', fixBrief({ fix: after.fix }).includes('Their failed logs name no file this PR changes: its failed log names no file this PR changes; one rerun was already tried at this head and it failed again.'), true);
t('#805 ci-rerun not yes: no rerun, and the item says so', draftOf([red('Integration', '9')], [away], off805({ perm: 'ask' }))?.fix?.what, 'red: Integration; its failed log names no file this PR changes; config §3 ci-rerun is "ask", so reruns are not granted');
const runnerToo = draftOf([red('Lint', '9')], [spaced('Lint', '9')], crun({ changed: CHANGED }));
t('#805 with the lever on, a runner fault keeps its words and reruns only the failed jobs', `${runnerToo?.why} | ${runnerToo?.gate?.full}`, `${once.why} | undefined`);
t('#805 with the lever off, a runner fault naming no changed file is re-run as such a check', draftOf([red('Lint', '9')], [spaced('Lint', '9')], off805())?.gate?.full, true);
}

// ---- Every path the failed log names is matched against the PR's files, not only its first five error
// lines, which a runner's headings can fill.
{
const CHANGED = ['tests/test_new_holds.mjs', 'desk/bin/holds.mjs'];
const shard = (n, o = {}) => ({ ...red(`CI (shard ${n}/6)`, '9'), errors: [], log_errors: ['failed=$(grep -c FAIL out.txt)', '== suite: merge errors ==', '== suite: fix tries failed ==', '== suite: queue errors ==', '== suite: pass failed =='], ...o });
const off1640 = (o = {}) => crun({ classes: false, changed: CHANGED, ...o });
const added = draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_paths: ['tests/run.sh', 'tests/test_new_holds.mjs'], log_fail_paths: [] })], off1640());
t('#1640 AC1 an added file named only past the first five error lines is related: a fix try', `${added?.call} ${added?.fix?.what}`, 'requeue red: CI (shard 6/6)');
t('#1640 AC1 an edited file named only by its file name is related', draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_paths: ['dist/holds.mjs'] })], off1640())?.call, 'requeue');
t('#1640 AC1 a file name the log prints for many files (index.mjs) still counts by its name', draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_paths: ['dist/index.mjs'] })], off1640({ changed: ['desk/bin/index.mjs'] }))?.call, 'requeue');
t('#1640 AC1 negative control: a different file name in the log is not related', draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_paths: ['dist/main.mjs'] })], off1640({ changed: ['desk/bin/index.mjs'] }))?.call, 'rerun');
t('#1640 AC1 a renamed file counts by its new path, as the log prints it from a package folder', draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_paths: ['bin/holds.mjs'] })], off1640())?.call, 'requeue');
t('#1640 AC2 a repo-wide check naming a file the PR touches is related', draftOf([red('Size caps', '9')], [{ ...shard(1, { log_paths: ['desk/bin/holds.mjs'] }), name: 'Size caps' }], off1640())?.call, 'requeue');
t('#1640 AC2 a failure naming a path in a changed file\'s own folder is related', draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_fail_paths: ['desk/bin/queue.mjs'] })], off1640())?.call, 'requeue');
t('#1640 AC2 so is one on an error line, as the package runner prints it', draftOf([red('Unit', '9')], [{ ...red('Unit', '9'), errors: ['FAIL desk/bin/queue.test.mjs > totals the queue'] }], off1640({ changed: ['pkg/desk/bin/holds.mjs'] }))?.call, 'requeue');
t('#1640 AC2 so is one printed under the runner\'s workspace folder', draftOf([red('Unit', '9')], [{ ...red('Unit', '9'), errors: ['Error: totals at /home/runner/work/r/r/desk/bin/queue.mjs:12'] }], off1640())?.call, 'requeue');
t('#1640 AC2 a sibling folder is not', draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_fail_paths: ['desk/lib/queue.mjs'] })], off1640())?.call, 'rerun');
t('#1640 AC2 nor an ancestor folder', draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_fail_paths: ['desk/queue.mjs'] })], off1640())?.call, 'rerun');
t('#1640 AC2 a file directly in tests/ has tests/ as its own folder', draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_fail_paths: ['tests/test_queue.mjs'] })], off1640())?.call, 'requeue');
t('#1640 AC2 nor a subfolder of it', draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_fail_paths: ['desk/bin/pass/queue.mjs'] })], off1640())?.call, 'rerun');
t('#1640 AC2 nor a folder of the same name elsewhere', draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_fail_paths: ['apps/admin/tests/queue.spec.ts', 'packages/desk/bin/queue.mjs'] })], off1640())?.call, 'rerun');
t('#1640 AC2 nor a dependency\'s stack frame through a folder named like a changed file\'s', draftOf([red('Unit', '9')], [{ ...red('Unit', '9'), errors: ['TypeError: x at /home/runner/work/r/r/node_modules/zod/src/types.js:12'] }], off1640({ changed: ['src/holds.ts'] }))?.call, 'rerun');
t('#1640 AC2 nor a path in the folder printed only on a passing line', draftOf([red('CI (shard 6/6)', '9')], [shard(6, { log_paths: ['desk/bin/queue.mjs'], log_fail_paths: [] })], off1640())?.call, 'rerun');
const away = draftOf([red('CI (shard 6/6)', '9')], [shard(2, { conclusion: 'success' }), shard(6, { log_paths: ['tests/test_queue.mjs', 'desk/lib/queue.mjs'], log_fail_paths: ['tests/test_queue.mjs'] })], off1640({ changed: ['desk/bin/holds.mjs'] }));
t('#1640 AC1 a failure naming only untouched files is re-run', away?.call, 'rerun');
t('#1640 AC3 the rerun names the shard that failed, not one that passed', `${away?.why.includes('"CI (shard 6/6)"')} ${away?.why.includes('shard 2/6')}`, 'true false');
const rerunRed = draftOf([red('CI (shard 2/6)', '9')], [shard(6, { conclusion: 'success' }), shard(2, { log_paths: ['desk/lib/queue.mjs'], log_fail_paths: ['desk/lib/queue.mjs'] })], off1640({ changed: ['desk/bin/holds.mjs'] }));
t('#1640 AC3 and when another shard fails at the next attempt, it names that one', `${rerunRed?.why.includes('"CI (shard 2/6)"')} ${rerunRed?.why.includes('shard 6/6')}`, 'true false');
}

// The base red record a fix call leaves: when its hold began, and whether the call holds the PR.
{
  const rec = (checks) => ({ class: 'base red', head: 'h', merge_base: 'm', checks, cleared: [] });
  const A = '2026-11-20T10:00:00.000Z', B = '2026-11-20T11:00:00.000Z';
  t('keptHold: a new hold begins at this pass, held', JSON.stringify(keptHold(null, { call: 'held', base_red: rec(['Lint']) }, A)), JSON.stringify({ ...rec(['Lint']), since: A, held: true }));
  t('keptHold: a hold still open keeps when it began', keptHold({ ...rec(['Lint']), since: A }, { call: 'held', base_red: rec(['Lint']) }, B).since, A);
  t('keptHold: one after a cleared hold begins anew', keptHold({ ...rec([]), cleared: ['Lint'], since: A }, { call: 'held', base_red: rec(['Lint']) }, B).since, B);
  t('keptHold: a fix try beside it does not hold the PR', keptHold(null, { call: 'requeue', base_red: rec(['Lint']) }, A).held, false);
  t('keptHold: a call that clears it clears it', keptHold({ ...rec(['Lint']), since: A }, { call: 'requeue', base_red: null }, B), null);
}

// #1327: a PR red where its base was red when it branched, the base green since, is updated from the
// base, where §3 pr-update-branch lets the pass, rather than re-run or given a fix try.
{
  const up = (o = {}) => ctx({ refreshBase: true, ...o });
  const rf = fixCall(tk, pr([ok('tests'), red('Lint')]), up({ baseRead: read({ Lint: 'fail' }, { Lint: 'pass' }) }));
  t('#1327 a held check that has passed on the base since: its branch is updated, with no fix try', `${rf?.call} ${JSON.stringify(rf?.checks)} ${rf?.fix}`, 'refresh ["Lint"] undefined');
  t('#1327 and says why', rf?.why, 'Lint was red on main too and has passed on main since, so its branch is updated from main for a run on the green base, with no re-run and no fix try');
  t('#1327 so is one red at the merge base and green since, with no hold yet', fixCall({ key: 'T-1' }, pr([ok('tests'), red('Lint')]), up({ baseRead: read({ Lint: 'fail' }, { Lint: 'pass' }) }))?.call, 'refresh');
  t('#1327 and one held as red on the base\'s latest run, now green', fixCall(lateTk, pr([ok('tests'), red('Size')]), up({ baseRead: read({ Size: 'pass' }, { Size: 'pass' }) }))?.call, 'refresh');
  t('#1327 before the driver\'s reruns are spent, so no rerun replays the red merge', fixCall(tk, pr([ok('tests'), red('Lint')]), up({ cooledDown: false, reruns: () => 0, baseRead: read({ Lint: 'fail' }, { Lint: 'pass' }) }))?.call, 'refresh');
  const outage = new Map([['Lint', { line: 'x', text: 'x', prs: [700, 702], runnable: true }]]);
  t('#1327 and before an outage hold that names it', fixCall(tk, pr([ok('tests'), red('Lint')]), up({ outage, baseRead: read({ Lint: 'fail' }, { Lint: 'pass' }) }))?.call, 'refresh');
  t('#1327 still red on the base: held as before', fixCall(tk, pr([ok('tests'), red('Lint')]), up({ baseRead: read({ Lint: 'fail' }, { Lint: 'fail' }) }))?.call, 'held');
  t('#1327 green at the merge base: the PR\'s own, a fix try as before', fixCall({ key: 'T-1' }, pr([ok('tests'), red('Lint')]), up({ baseRead: read({ Lint: 'pass' }, { Lint: 'pass' }) }))?.call, 'requeue');
  t('#1327 once per head: updated at this head already, a fix try as before', fixCall({ ...tk, base_refresh: { head: HEAD, ok: false } }, pr([ok('tests'), red('Lint')]), up({ baseRead: read({ Lint: 'fail' }, { Lint: 'pass' }) }))?.call, 'requeue');
  t('#1327 with §3 pr-update-branch not yes, a fix try as before', fixCall(tk, pr([ok('tests'), red('Lint')]), ctx({ baseRead: read({ Lint: 'fail' }, { Lint: 'pass' }) }))?.call, 'requeue');
  const NOW = Date.parse('2026-11-23T12:00:00Z');
  const done = (at, ok = true) => ({ ...tk, base_refresh: { head: HEAD, at, ok } });
  const waits = fixCall(done('2026-11-23T11:50:00Z'), pr([ok('tests'), red('Lint')]), up({ now: NOW, baseRead: read({ Lint: 'fail' }, { Lint: 'pass' }) }));
  t('#1330 updated at this head minutes ago (by the pass or the merge driver): it waits for the new head, no fix try', `${waits?.call} ${/updated from main at 2026-11-23 11:50 UTC.*waits for the run at its new head/.test(waits?.why ?? '')}`, 'wait true');
  t('#1330 past the wait, a fix try as before', fixCall(done('2026-11-23T11:00:00Z'), pr([ok('tests'), red('Lint')]), up({ now: NOW, baseRead: read({ Lint: 'fail' }, { Lint: 'pass' }) }))?.call, 'requeue');
  t('#1330 the wait is the merge driver\'s too (stale-base.mjs reads staleCall)', staleCall(done('2026-11-23T11:50:00Z'), HEAD, ['Lint'], read({ Lint: 'fail' }, { Lint: 'pass' }), { base: 'main', now: NOW })?.call, 'wait');
  t('#1330 and so is the refresh', JSON.stringify(staleCall({ key: 'T-1' }, HEAD, ['Lint'], read({ Lint: 'fail' }, { Lint: 'pass' }), { base: 'main' })?.checks), '["Lint"]');
  const d = draftChecksFix({ key: 'T-1' }, { pr: 701, head: HEAD, failing: [red('Lint')] }, { repo: 'acme/widgets', base: 'main', refreshBase: true, baseRead: read({ Lint: 'fail' }, { Lint: 'pass' }) });
  t('#1327 a draft is updated the same way', `${d?.call} ${JSON.stringify(d?.checks)}`, 'refresh ["Lint"]');
}

// issue-1605: base red is judged by the failing tests inside a check, not by its name alone.
{
  const tests = (prT, baseT) => ({ failingTests: (f) => prT[f.name] ?? null, baseTests: (n, where) => baseT[`${n}@${where}`] ?? null });
  const SHARD = 'shard 1/6';
  // The job's latest run on the base passes: the merge base's failing set alone is compared.
  const GREEN_NOW = { [SHARD]: 'pass' };
  // AC4: the same check name with a different failing set: not base red, the fix try targets its own tests.
  const diff = fixCall({ key: 'T-1' }, pr([ok('tests'), red(SHARD)]), ctx({ baseRead: { ...read({ [SHARD]: 'fail' }, GREEN_NOW), ...tests(
    { [SHARD]: ['DS-226 AC1 FileVault on is reported', 'DS-226 AC4 fdesetup missing is unknown'] },
    { [`${SHARD}@merge-base`]: ['DS-763 AC4 the whole pass shell suite', 'DS-763 AC4 the stub that never exits is ended by the watch'] }) } }));
  t('issue-1605 AC1 same check red on the base, different failing tests: not base red, a fix try', `${diff?.call} ${diff?.base_red}`, 'requeue null');
  t('issue-1605 AC3 the pass line names the PR\'s own failing tests', diff?.fix.what, 'red: shard 1/6; red on main too, but failing its own tests there: shard 1/6 (DS-226 AC1 FileVault on is reported, DS-226 AC4 fdesetup missing is unknown)');
  t('issue-1605 AC1 the try\'s brief names them as the worker\'s', fixBrief({ fix: diff.fix }).includes('these of its failing tests are not failing there, so they are yours: DS-226 AC1 FileVault on is reported, DS-226 AC4 fdesetup missing is unknown'), true);
  // One shared test beside one of its own is still not base red; only the own one is named.
  const some = baseSplit([red(SHARD)], HEAD, null, { ...read({ [SHARD]: 'fail' }, GREEN_NOW), ...tests({ [SHARD]: ['A', 'B'] }, { [`${SHARD}@merge-base`]: ['A'] }) });
  t('issue-1605 AC1 any test not failing at the merge base makes it the PR\'s, naming only that one', `${some.red.length} ${JSON.stringify(some.mine.map((f) => f.own))} ${some.record}`, '0 [["B"]] null');
  // AC2/AC4: the same failing set: base red, held, as today.
  const same = fixCall({ key: 'T-1' }, pr([ok('tests'), red(SHARD)]), ctx({ baseRead: { ...read({ [SHARD]: 'fail' }, GREEN_NOW), ...tests({ [SHARD]: ['A', 'B'] }, { [`${SHARD}@merge-base`]: ['B', 'A', 'C'] }) } }));
  t('issue-1605 AC2 the same failing tests (or fewer) as the base: base red, held', `${same?.call} ${same?.class} ${JSON.stringify(same?.base_red?.checks)}`, 'held base red ["shard 1/6"]');
  // The base went red after the merge base: compared with the base's latest failing run of that job.
  const late2 = baseSplit([red(SHARD)], HEAD, null, { ...read({ [SHARD]: 'pass' }, { [SHARD]: 'fail' }), ...tests({ [SHARD]: ['X'] }, { [`${SHARD}@latest`]: ['Y'] }) });
  t('issue-1605 AC1 red on the base\'s latest run with other tests: the PR\'s', `${late2.red.length} ${JSON.stringify(late2.mine[0]?.own)}`, '0 ["X"]');
  // Either side unread, or naming no test: read by check name, as before.
  for (const [label, prT, baseT] of [['the PR\'s tests unread', {}, { [`${SHARD}@merge-base`]: ['A'] }], ['the base\'s tests unread', { [SHARD]: ['A'] }, {}],
    ['the base\'s log names no test', { [SHARD]: ['A'] }, { [`${SHARD}@merge-base`]: [] }]]) {
    const r = baseSplit([red(SHARD)], HEAD, null, { ...read({ [SHARD]: 'fail' }, GREEN_NOW), ...tests(prT, baseT) });
    t(`issue-1605 ${label}: base red by check name, as before`, `${r.red.length} ${r.mine.length}`, '1 0');
  }
  // The FAIL lines a job log gives, as the test names compared.
  const log = ['2026-11-27T10:00:00.1234567Z \x1b[31mFAIL\x1b[0m DS-226 AC1 FileVault on is reported: got on (want off)',
    '2026-11-27T10:00:01.0000000Z FAIL DS-226 AC1 FileVault on is reported: got 12 (want off)', 'FAIL src/a.test.ts (5.2 s)', 'ok   DS-1 passes', 'FAILURES above (3 checks passed)'].join('\n');
  t('issue-1605 AC1 a log\'s runner failure lines give its failing tests, once each, without what differs between runs', JSON.stringify(failingTestNames(log)), '["DS-226 AC1 FileVault on is reported","src/a.test.ts"]');
  t('issue-1605 an unread log names none', JSON.stringify(failingTestNames(null)), '[]');
  // Red at the merge base and on the base's latest run since: both failing sets are the base's.
  const both = { [`${SHARD}@merge-base`]: ['A'], [`${SHARD}@latest`]: ['A', 'X'] };
  const later = baseSplit([red(SHARD)], HEAD, null, { ...read({ [SHARD]: 'fail' }), ...tests({ [SHARD]: ['A', 'X'] }, both) });
  t('issue-1605 red at the merge base, a test the base broke since fails in the PR\'s run too: base red, held', `${later.red.length} ${later.mine.length} ${JSON.stringify(later.record?.checks)}`, '1 0 ["shard 1/6"]');
  const laterOwn = baseSplit([red(SHARD)], HEAD, null, { ...read({ [SHARD]: 'fail' }), ...tests({ [SHARD]: ['A', 'X', 'B'] }, both) });
  t('issue-1605 red at the merge base and since, a test neither fails: the PR\'s, naming only that one', `${laterOwn.red.length} ${JSON.stringify(laterOwn.mine[0]?.own)}`, '0 ["B"]');
  const latestUnread = baseSplit([red(SHARD)], HEAD, null, { ...read({ [SHARD]: 'fail' }), ...tests({ [SHARD]: ['A', 'X'] }, { [`${SHARD}@merge-base`]: ['A'] }) });
  t('issue-1605 red at the merge base, the latest run\'s tests unread: base red by check name', `${latestUnread.red.length} ${latestUnread.mine.length}`, '1 0');
  const latestNone = baseSplit([red(SHARD)], HEAD, null, { ...read({ [SHARD]: 'fail' }, { [SHARD]: null }), ...tests({ [SHARD]: ['A', 'X'] }, { [`${SHARD}@merge-base`]: ['A'] }) });
  t('issue-1605 red at the merge base, the latest run on the base unread: base red by check name', `${latestNone.red.length} ${latestNone.mine.length}`, '1 0');
  // A suite tests/run.sh retried: its first run's failures are not this run's.
  const retried = ['== tests/test_a.mjs', 'ok: 3', 'retried: failed its first run, passed its retry', '-- first run', 'FAIL flaky one: got x', 'FAIL 1 check(s) failed',
    '== tests/test_b.mjs', 'ok: 2', '-- first run', 'FAIL b first only: got y', '-- retry', 'FAIL b both: got z', '2026-11-27T10:00:00.1Z FAIL 3 check(s) failed', 'FAIL 2 check(s)', 'FAIL: 4 checks failed'].join('\n');
  t('issue-1605 P0 a retried suite\'s first run and a suite\'s count line name no failing test', JSON.stringify(failingTestNames(retried)), '["b both"]');
  const counts = (n) => baseSplit([red(SHARD)], HEAD, null, { ...read({ [SHARD]: 'fail' }, GREEN_NOW), failingTests: () => failingTestNames(`FAIL A: x\nFAIL ${n} check(s) failed`), baseTests: () => failingTestNames('FAIL A: x\nFAIL B: y\nFAIL 2 check(s) failed') });
  t('issue-1605 P0 a PR failing fewer of the base\'s tests, with its own count line: base red', `${counts(1).red.length} ${counts(1).mine.length}`, '1 0');
  // Other runners' failure lines, and junit cases a log prints.
  const runners = ['2026-11-27T10:00:00.1Z FAILED tests/test_x.py::test_one - AssertionError: no', '--- FAIL: TestParse (0.01s)', 'FAIL\tgithub.com/acme/parse\t0.012s',
    '@acme/web:test: FAIL src/b.test.ts (2.1 s)', '<testsuite name="s"><testcase classname="pkg.Mod" name="it works" time="0.1"><failure message="x"/></testcase>',
    '<testcase classname="pkg.Mod" name="passes" time="0.1"/><testcase classname="pkg.Mod" name="errs" time="0.2">', '<error message="boom"/></testcase></testsuite>'].join('\n');
  t('issue-1605 gap pytest, go, task-prefixed Jest lines and junit failure and error cases give failing tests', JSON.stringify(failingTestNames(runners)),
    '["tests/test_x.py::test_one","TestParse","github.com/acme/parse","src/b.test.ts","pkg.Mod.it works","pkg.Mod.errs"]');
  // The reads, through gh: the PR's job by name in its failed run, the base's by the job in its check run's URL.
  const R = 'acme/widgets', JOB_PR = '140393593637', JOB_BASE = '777';
  const answers = {
    [`repos/${R}/compare/main...${HEAD}`]: `${'c'.repeat(40)}\t${MB}`,
    [`repos/${R}/commits/${MB}/check-runs?check_name=${encodeURIComponent(SHARD)}&filter=latest&per_page=100`]: JSON.stringify([{ status: 'completed', conclusion: 'failure', details_url: `https://github.com/${R}/actions/runs/1/job/${JOB_BASE}` }]),
    [`repos/${R}/compare/${MB}...main?per_page=100`]: '',
    [`repos/${R}/actions/runs/45965634008/jobs?per_page=100`]: JOB_PR,
    [`repos/${R}/actions/jobs/${JOB_PR}/logs`]: 'FAIL DS-226 AC1 FileVault on is reported: got x\n',
    [`repos/${R}/actions/jobs/${JOB_BASE}/logs`]: 'FAIL DS-763 AC4 the whole pass shell suite: got y\n',
    [`repos/${R}/actions/runs/1/jobs?per_page=100`]: `${JOB_BASE}\n888\n889\n`,
    [`repos/${R}/actions/jobs/888/logs`]: 'FAIL DS-9 another shard\'s test: got z\n',
    [`repos/${R}/actions/jobs/889/logs`]: 'one or more shards failed\n',
  };
  const calls = [];
  const gh = (args) => { calls.push(args); const out = answers[args[1]]; return out == null ? { ok: false, out: '' } : { ok: true, out }; };
  const br = makeBaseReads({ gh, repo: R, branch: 'main' }).forHead(HEAD);
  t('issue-1605 the PR\'s failing tests are read from its job of that name', JSON.stringify(br.failingTests(red(SHARD, '45965634008'))), '["DS-226 AC1 FileVault on is reported"]');
  t('issue-1605 the job is picked by its name', calls.find((a) => a[1].includes('/runs/45965634008/jobs'))?.[3], `[.jobs[] | select(.name == "${SHARD}") | .id][0] // empty`);
  t('issue-1605 the base\'s failing tests are read from every failed job of its failed run at the merge base', JSON.stringify(br.baseTests(SHARD, 'merge-base')), '["DS-763 AC4 the whole pass shell suite","DS-9 another shard\'s test"]');
  t('issue-1605 the run\'s failed jobs are picked by conclusion', calls.find((a) => a[1] === `repos/${R}/actions/runs/1/jobs?per_page=100`)?.[4], '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "startup_failure") | .id');
  // A test the base fails in another shard of that run is the base's, whichever shard the PR ran it in.
  const moved = baseSplit([red(SHARD, '45965634008')], HEAD, null, { ...br, failingTests: () => ['DS-9 another shard\'s test'] });
  t('issue-1605 a base test that ran in another shard on the base: base red, held', `${moved.red.length} ${moved.mine.length}`, '1 0');
  const crashed = makeBaseReads({ gh: (args) => (args[1] === `repos/${R}/actions/jobs/${JOB_BASE}/logs` ? { ok: true, out: 'Error: the runner lost its connection\n' } : gh(args)), repo: R, branch: 'main' }).forHead(HEAD);
  t('issue-1605 the base\'s job of that name naming no test (a crash): none, so read by name', JSON.stringify(crashed.baseTests(SHARD, 'merge-base')), '[]');
  const split = baseSplit([red(SHARD, '45965634008')], HEAD, null, br);
  t('issue-1605 AC1 end to end through the reads: not base red', `${split.red.length} ${JSON.stringify(split.mine[0]?.own)}`, '0 ["DS-226 AC1 FileVault on is reported"]');
}

if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
