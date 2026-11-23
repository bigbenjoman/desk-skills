// suite: pass phase: red-base repairs another PR made needless (closed and recorded done by it, no worker)
// layer: L1
// covers: desk/bin/pass/repair-superseded.mjs
import { runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideSupersededRepairs, repairCandidate } from '../desk/bin/pass/repair-superseded.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const isRepair = (k) => k.startsWith('base-red-main');
const byKey = (...ts) => Object.fromEntries(ts.map((x) => [x.key, x]));
const snap = (tickets, more = {}) => ({ tickets: byKey(...tickets), isRepair, base: 'main', dry: false, ...more });
// The runner with stub handlers: each action answers from `answers` (a value, or a function of it).
function drive(s, answers = {}) {
  const READS = { superseded: null, 'pr-close': { ok: true, out: '' }, write: true, 'drop-worktree': 'its worktree was removed', report: undefined };
  const handlers = Object.fromEntries(Object.keys(READS).map((type) => [type, (a) => {
    const v = Object.hasOwn(answers, type) ? answers[type] : READS[type];
    return typeof v === 'function' ? v(a) : v;
  }]));
  return runSteps({ name: 'repairs', snapshot: () => s, decide: decideSupersededRepairs, handlers, report: { failed: [] } });
}
const of = (as, type) => as.filter((a) => a.type === type);
const lines = (as) => of(as, 'report').map((a) => a.line);
const FIXED = { why: 'on-base', by: { pr: 3561, at: '2026-11-23T09:00:00Z' } };

// The live case: a repair in draft on PR #3560 while main stayed red, whose fix another author merged in #3561.
const draft = { key: 'base-red-main-20261123080000', state: 'done', result: { pr: 3560 }, pr_status: { pr: 3560, state: 'OPEN' }, branch: 'fix/base-red', worktree: '/w/r' };
{
  const as = drive(snap([draft]), { superseded: FIXED });
  const close = of(as, 'pr-close')[0];
  t('a repair whose changes are on the base has its PR closed unmerged, the comment naming the PR that fixed it',
    `${close?.pr} ${/its changes are all on main already, and PR #3561 fixed main, so it has nothing left to do\. Its fix landed in #3561\./.test(close?.comment ?? '')}`, '3560 true');
  const fields = of(as, 'write')[0]?.fields ?? [];
  t('it is recorded done by that PR: done_by, its merge as merged_at, and its own PR off result.pr',
    j(['state=done', 'result.pr=null', 'merged_at=2026-11-23T09:00:00Z', 'done_by={"pr":3561,"why":"it fixed the red main this repair was for"}'].map((f) => fields.includes(f))), '[true,true,true,true]');
  t('a pending fix try, a park and a handoff are cleared, so no worker is spawned on it', ['fix=null', 'park=null', 'handoff=null', 'resume=null'].every((f) => fields.includes(f)), true);
  t('its worktree is removed and the line says so', `${of(as, 'drop-worktree').length} ${lines(as)[0]}`,
    '1 base-red-main-20261123080000: its changes are all on main already (PR #3561 fixed main): PR #3560 closed unmerged, recorded done by #3561, no worker spawned; its worktree was removed');
}
{
  const queued = { key: 'base-red-main', state: 'triaged', added_at: 'x' };
  const as = drive(snap([queued]), { superseded: { why: 'green', by: { pr: 77, at: 'a' }, sha: 'abcdef0123456789' } });
  t('a repair not yet spawned, the base green since it was admitted, closes no PR and is done by the fixing PR',
    `${of(as, 'pr-close').length} ${lines(as)[0]}`, '0 base-red-main: main has gone green since it began, at abcdef012345 (PR #77 fixed main): recorded done by #77, no worker spawned; its worktree was removed');
}
{
  const as = drive(snap([draft]), { superseded: { why: 'green', by: null } });
  const fields = of(as, 'write')[0]?.fields ?? [];
  t('with no PR to name, it is done with its own PR kept, closed, and no done_by, so a later red admits a repair afresh',
    j([fields.some((f) => f.startsWith('done_by')), fields.includes('result.pr=null'), fields.includes('state=done')]), '[false,false,true]');
}
t('still needed (the read says so): nothing is done', j(drive(snap([draft])).map((a) => a.type)), '["superseded"]');
{
  const as = drive(snap([draft]), { superseded: FIXED, 'pr-close': { ok: false, out: 'HTTP 403' } });
  t('a close that fails records nothing and says the next pass tries again',
    `${of(as, 'write').length} ${/PR #3560 could not be closed \(HTTP 403\): left as it is; the next pass tries again/.test(lines(as)[0])}`, '0 true');
}
t('a read that fails leaves it as it is and says why',
  /could not tell whether the red base it repairs is fixed elsewhere \(no history\): left as it is/.test(lines(drive(snap([draft]), { superseded: { error: 'no history' } }))[0]), true);
t('a dry run says what it would do and changes nothing',
  j(drive(snap([draft], { dry: true }), { superseded: FIXED }).map((a) => a.type)), '["superseded","report"]');

// Which repairs are read at all.
const c = (x) => repairCandidate(x, isRepair);
t('a running repair is left to its worker', c({ key: 'base-red-main', state: 'running' }), false);
t('a merged one, or one already done by another PR, is settled', [c({ key: 'base-red-main', state: 'done', merged_at: 'x', result: { pr: 1 } }), c({ key: 'base-red-main', state: 'parked', done_by: { pr: 2 } })].join(), 'false,false');
t('a done one with its PR closed is the red-base step\'s to admit afresh', c({ key: 'base-red-main', state: 'done', result: { pr: 1 }, pr_status: { pr: 1, state: 'CLOSED' } }), false);
t('a parked, queued or done-with-an-open-PR repair is read', [c({ key: 'base-red-main', state: 'parked' }), c({ key: 'base-red-main', state: 'queued' }), c(draft)].join(), 'true,true,true');
t('a ticket that is not a repair is never read', c({ key: 'ABC-1', state: 'parked' }), false);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
