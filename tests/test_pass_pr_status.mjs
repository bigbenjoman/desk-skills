// suite: pass phase: PR status (each done ticket's PR read, merges recorded, the lists the steps after it use)
import { decidePrStatus, followState } from '../desk/bin/pass/pr-status.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);
// A generator decision's actions, each yield given back what `answer` returns for it.
const drive = (steps, answer) => { const acts = []; for (let r = steps.next(); !r.done; r = steps.next(answer(r.value))) acts.push(r.value); return acts; };

const PASS_AT = '2026-11-19T10:00:00.000Z';
const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));
const snap = (list, fields = {}) => ({ tickets: byKey(list), dry: false, passAt: PASS_AT, ...fields });
const done = (key, pr, fields = {}) => ({ key, state: 'done', result: { pr }, ...fields });
const status = (pr, state, fields = {}) => ({ pr, state, isDraft: false, merged_at: null, base_head: 'b1', ...fields });
// Answers each read from `reads` (by PR number), each merged with a record, each set with true.
const answers = (reads = {}) => (a) => {
  if (a.type === 'read-pr') return reads[a.pr] ?? null;
  if (a.type === 'merged') return `merged_at=${a.at ?? PASS_AT}`;
  if (a.type === 'set') return true;
  if (a.type === 'follow-on') return { ok: true };
  return undefined;
};
const run = (s, reads) => drive(decidePrStatus(s), answers(reads));
const ofType = (acts, type) => acts.filter((a) => a.type === type);
const lists = (acts) => acts.at(-1);

// ---- a done ticket's PR that is not its own: parked where it is read, in no list a later step works from
{
  const mine = (key, fields = {}) => done(key, 70, { branch: `fix/${key}`, ...fields });
  const read = (fields) => ({ 70: status(70, 'OPEN', { branch: 'fix/F', author: 'me', ...fields }) });
  const epic = run(snap([mine('F')], { logins: 'me' }), read({ branch: 'epic/E', author: 'alice', reopen: { tests: 'x' } }));
  t('a PR on another branch parks its ticket, naming why', ofType(epic, 'park')[0]?.question?.startsWith("its PR #70 is not its own: PR #70 is on branch epic/E, not F's branch fix/F."), true);
  t('it is in no draft, ready, reopen list and records no status', j([lists(epic).drafts.length, lists(epic).undrafted.length, lists(epic).reopens.length, ofType(epic, 'pr-status').length]), j([0, 0, 0, 0]));
  t('the report says nothing is done to it', ofType(epic, 'out').some((a) => a.line === "PR status: F's PR #70 is not its own (PR #70 is on branch epic/E, not F's branch fix/F): parked, and nothing is done to #70"), true);
  const merged = run(snap([mine('F')], { logins: 'me' }), read({ author: 'alice', state: 'MERGED', merged_at: '2026-11-19T09:00:00Z' }));
  t('one on its branch another account opened parks it too, and its merge is not recorded as the ticket\'s', j([ofType(merged, 'park').length, ofType(merged, 'merged').length, /opened by alice, not by me/.test(ofType(merged, 'park')[0]?.question ?? '')]), j([1, 0, true]));
  const dry = run(snap([mine('F')], { logins: 'me', dry: true }), read({ branch: 'epic/E' }));
  t('a dry run parks nothing, and says it would', j([ofType(dry, 'park').length, /would park it/.test(ofType(dry, 'out')[0]?.line ?? '')]), j([0, true]));
  const own = run(snap([mine('F')], { logins: 'me,me-bot' }), read({ author: 'Me-Bot' }));
  t('its own PR is listed as before', j([ofType(own, 'park').length, lists(own).undrafted.length]), j([0, 1]));
  const noHandle = run(snap([mine('F')], { logins: null }), read({ author: 'alice' }));
  t('with no account configured only the branch is checked', lists(noHandle).undrafted.length, 1);
}

// ---- AC1: a merged PR with no merged time recorded
{
  const acts = run(snap([done('A', 11)]), { 11: status(11, 'MERGED', { merged_at: '2026-11-19T09:00:00Z' }) });
  t('AC1 a done ticket whose PR merged, with no merged_at, gets one merged record', j(ofType(acts, 'merged')), j([{ type: 'merged', key: 'A', at: '2026-11-19T09:00:00Z' }]));
  t('AC1 its merge is a report line', j(ofType(acts, 'out').map((a) => a.line)), j(['merge recorded: A (PR #11): merged_at=2026-11-19T09:00:00Z']));
  t('AC1 and is in the merges the metrics count', lists(acts).merges.length, 1);
  t('AC1 its status is kept on the ticket', j(ofType(acts, 'pr-status').map((a) => a.key)), j(['A']));
}
{
  // Recorded merged, merged_at missing on the ticket: the kept status is used, not read again.
  const kept = status(12, 'MERGED', { merged_at: '2026-11-18T09:00:00Z' });
  const acts = run(snap([done('B', 12, { pr_status: kept })]));
  t('a kept merged status with its time records the merge without a read', j(acts.filter((a) => a.type === 'read-pr' || a.type === 'merged').map((a) => a.type)), j(['merged']));
  t('the merged record carries the kept time', ofType(acts, 'merged')[0].at, '2026-11-18T09:00:00Z');
}

// ---- AC2: a PR already recorded merged or closed is not read
{
  const merged = done('C', 13, { pr_status: status(13, 'MERGED', { merged_at: 'x' }), merged_at: 'x' });
  const closed = done('D', 14, { pr_status: status(14, 'CLOSED') });
  const acts = run(snap([merged, closed]));
  t('AC2 no read of a PR recorded merged (with merged_at) or closed', ofType(acts, 'read-pr').length, 0);
  t('AC2 and nothing is written for them', acts.filter((a) => !['prune-builds', 'lists'].includes(a.type)).length, 0);
  t('AC2 their kept states are the PR states', j(lists(acts).prStates), j({ 13: 'MERGED', 14: 'CLOSED' }));
  t('AC2 and neither keeps a check-build checkout', j(ofType(acts, 'prune-builds')[0].open), j([]));
}
{
  // Merged and recorded, but its review's post-merge criteria are not yet follow-on steps: read on.
  const owedT = done('E', 15, { merged_at: 'x', pr_status: status(15, 'MERGED', { merged_at: 'x', post_merge: [{ step: 'check prod' }] }) });
  const read = run(snap([{ ...owedT, post_merge_read: 15 }]));
  t('a merged PR whose post-merge criteria were read for it already gets no action', j(read.filter((a) => !['prune-builds', 'lists'].includes(a.type))), '[]');
  const acts = run(snap([owedT]));
  t('a merged PR owed its post-merge steps is not read again', ofType(acts, 'read-pr').length, 0);
  t('its criteria become follow-on steps in one write', j(ofType(acts, 'follow-on').map((a) => a.fields)), j([['follow_on=[{"step":"check prod","row":null,"from":"review"}]', 'post_merge_read=15']]));
  t('made only while the steps are as read, or as that write leaves them', j(ofType(acts, 'follow-on')[0].expect),
    j([followState(owedT), followState({ follow_on: [{ step: 'check prod', row: null, from: 'review' }], follow_on_done: null })]));
  t('and a merge line names them', ofType(acts, 'out')[0].line, 'merge recorded: E (PR #15): 1 criterion its review left for after the merge, now follow-on steps');
  const refused = drive(decidePrStatus(snap([owedT])), (a) => (a.type === 'follow-on' ? { ok: false, why: 'no' } : undefined));
  t('a refused write names no follow-on steps', ofType(refused, 'out').length, 0);
  const skipped = drive(decidePrStatus(snap([owedT])), (a) => (a.type === 'follow-on' ? { ok: true, skipped: true } : undefined));
  t('a write skipped because the steps changed under it names none', ofType(skipped, 'out').length, 0);
  const gated = done('E2', 26, { merged_at: 'x', pr_status: status(26, 'MERGED', { merged_at: 'x', post_merge: [{ step: 'check live', after: 'production' }] }) });
  t('a criterion gated on production keeps its gate', ofType(run(snap([gated])), 'follow-on')[0].fields[0], 'follow_on=[{"step":"check live","row":null,"from":"review","after":"production"}]');
  // DS-788: a kept criterion is that criterion only under the same gate, and an old pass's prefix is dropped.
  // Its merge commit kept, so a gated kept step does not send the PR to be read again for it.
  const committed = { ...gated, pr_status: { ...gated.pr_status, merge_commit: 'c' } };
  const sameWords = { ...committed, key: 'E5', follow_on: [{ step: 'check live', row: null, from: 'review', after: 'main' }] };
  t('DS-788 a kept criterion worded the same under another gate is another step',
    ofType(run(snap([sameWords])), 'follow-on')[0].fields[0], `follow_on=${j([...sameWords.follow_on, { step: 'check live', row: null, from: 'review', after: 'production' }])}`);
  const oldPrefix = { ...committed, key: 'E6', follow_on: [{ step: 'Check after the merge: AC1 (needs production): check live', row: null, after: 'production' }] };
  t('DS-788 a kept criterion an older pass recorded with its prefix is not added again',
    j(ofType(run(snap([oldPrefix])), 'follow-on').map((a) => a.fields)), j([['post_merge_read=26']]));
  // DS-787: steps the worker declared for after the merge win over its review's criteria.
  const declared = { ...owedT, key: 'E3', follow_on: [{ step: 'run the staging script', row: 'staging-write' }] };
  const dActs = run(snap([declared]));
  t('DS-787 a worker\'s declared step leaves the criteria out: only post_merge_read is written', j(ofType(dActs, 'follow-on').map((a) => a.fields)), j([['post_merge_read=15']]));
  t('DS-787 and no merge line names criteria', ofType(dActs, 'out').length, 0);
  const notWorkers = { ...owedT, key: 'E4', follow_on: [{ step: 'Issue link not made: DS-1 relates-to DS-2', row: 'jira-edit' }, { step: 'Check after the merge: AC1 (needs production): old', row: null }] };
  t('DS-787 a kept link step and an earlier PR\'s criterion are not declared steps: the criteria are added',
    ofType(run(snap([notWorkers])), 'follow-on')[0].fields[0], `follow_on=${j([...notWorkers.follow_on, { step: 'check prod', row: null, from: 'review' }])}`);
}
{
  // A follow step gated past the merge waits on its PR's merge commit: a merged PR recorded without one is read again.
  const follow = { follow_on: [{ step: 'check main', row: null, after: 'main' }] };
  const noCommit = done('V', 27, { merged_at: 'x', ...follow, pr_status: status(27, 'MERGED', { merged_at: 'x' }) });
  const acts = run(snap([noCommit]), { 27: status(27, 'MERGED', { merged_at: 'x', merge_commit: 'c'.repeat(40) }) });
  t('a merged PR owed its merge commit is read again', j(ofType(acts, 'read-pr').map((a) => a.pr)), j([27]));
  t('and origin is fetched while a gated follow step waits', ofType(acts, 'fetch-origin').length, 1);
  const withCommit = done('W', 28, { merged_at: 'x', ...follow, pr_status: status(28, 'MERGED', { merged_at: 'x', merge_commit: 'c'.repeat(40) }) });
  const kept = run(snap([withCommit]));
  t('one with its merge commit is not read again', ofType(kept, 'read-pr').length, 0);
  t('origin is still fetched for its gated step', ofType(kept, 'fetch-origin').length, 1);
  const mergeOnly = done('X', 29, { merged_at: 'x', follow_on: [{ step: 's', row: null }], pr_status: status(29, 'MERGED', { merged_at: 'x' }) });
  t('a step gated on the merge alone needs neither', j(run(snap([mergeOnly])).map((a) => a.type)), j(['prune-builds', 'lists']));
}
{
  // A closed PR still owed its reopen is read again, and counts as open.
  const owed = done('F', 16, { reopening: 16, pr_status: status(16, 'CLOSED') });
  const acts = run(snap([owed]), { 16: status(16, 'CLOSED') });
  t('a closed PR owed its reopen is read again', j(ofType(acts, 'read-pr').map((a) => a.pr)), j([16]));
  t('it counts as open', lists(acts).prStates[16], 'OPEN');
  t('and is in the reopens, owed', j(lists(acts).reopens.map(({ t: x, owed: o }) => [x.key, o])), j([['F', true]]));
}

// ---- AC3: a draft PR is in the drafts list
{
  const s = snap([done('G', 17), done('H', 18)]);
  const acts = run(s, { 17: status(17, 'OPEN', { isDraft: true }), 18: status(18, 'OPEN') });
  const l = lists(acts);
  t('AC3 a done ticket whose PR is a draft is in the drafts list', j(l.drafts.map(({ t: x, s: st }) => [x.key, st.pr])), j([['G', 17]]));
  t('a PR out of draft is in the undrafted list', j(l.undrafted.map(({ t: x }) => x.key)), j(['H']));
  t('the lists hold the snapshot\'s own tickets, which the steps after this one read', l.drafts[0].t === s.tickets.G, true);
  t('open PRs keep their check-build checkouts', j(ofType(acts, 'prune-builds')[0].open), j(['17', '18']));
  t('nothing is merged', ofType(acts, 'merged').length, 0);
}
{
  const tickets = [done('I', 19), { key: 'J', state: 'running' }, done('K', 19)];
  const acts = run(snap(tickets), { 19: status(19, 'OPEN', { reopen: { tests: 'main' } }) });
  t('one PR two tickets share is read once', ofType(acts, 'read-pr').length, 1);
  t('an open PR whose base now runs its untriggered checks is in the reopens', j(lists(acts).reopens.map(({ t: x, owed }) => [x.key, owed])), j([['I', false]]));
  t('a read that fails keeps nothing for that PR', j(run(snap([done('L', 20)]), {}).filter((a) => a.type !== 'read-pr').map((a) => a.type)), j(['prune-builds', 'lists']));
}
{
  const owed = done('M', 21, { reopening: 21 });
  const acts = run(snap([owed]), { 21: status(21, 'OPEN') });
  t('a reopen that has landed is cleared', j(ofType(acts, 'set').map((a) => a.fields)), j([['reopening=null']]));
}

// ---- fix tries finished
{
  const fix = { kind: 'conflict', at: 'T1' };
  const tries = [{ kind: 'conflict', at: 'T1' }, { kind: 'conflict', at: 'T0', finished: 'T0x' }, { kind: 'review', at: 'T1' }];
  const acts = run(snap([{ key: 'N', state: 'done', fix, fix_tries: tries }, { key: 'O', state: 'done', fix: { kind: 'review', at: 'T2' } }]));
  t('a conflict try is marked finished on its fix_tries entry', j(ofType(acts, 'fix-finished')[0]),
    j({ type: 'fix-finished', key: 'N', at: PASS_AT, fixTries: [{ kind: 'conflict', at: 'T1', finished: PASS_AT }, tries[1], tries[2]] }));
  t('any other try is marked finished alone', j(ofType(acts, 'fix-finished')[1]), j({ type: 'fix-finished', key: 'O', at: PASS_AT, fixTries: null }));
  t('a try already finished is left', ofType(run(snap([{ key: 'P', state: 'done', fix: { finished: 'x' } }])), 'fix-finished').length, 0);
}

// ---- a dry run
{
  const list = [done('Q', 22, { fix: { kind: 'review' } }), done('R', 23, { reopening: 23 })];
  const acts = run(snap(list, { dry: true }), { 22: status(22, 'MERGED', { merged_at: 'y', post_merge: [{ step: 's' }] }), 23: status(23, 'OPEN') });
  t('a dry run reads and keeps pr_status, and writes nothing else', j(acts.map((a) => a.type)), j(['read-pr', 'pr-status', 'read-pr', 'pr-status', 'lists']));
}

// ---- AC5: the decision does no I/O
{
  const list = [done('S', 24), done('T', 25, { pr_status: status(25, 'MERGED', { merged_at: 'z' }) }), { key: 'U', state: 'done', fix: { kind: 'conflict', at: 'a' }, fix_tries: [] }];
  const { out, threw, calls } = withNoIo(() => run(snap(list), { 24: status(24, 'OPEN', { isDraft: true }) }));
  t('AC5 it returns its actions without starting a process or writing a file', j({ threw, calls }), j({ threw: null, calls: [] }));
  t('AC5 and the actions are there', j(out.map((a) => a.type)), j(['read-pr', 'pr-status', 'merged', 'fix-finished', 'out', 'prune-builds', 'lists']));
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
