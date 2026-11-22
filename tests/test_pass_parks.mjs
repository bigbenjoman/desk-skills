// suite: pass phase: parks and holds (the clears-when, person-step, date, outside and merge hold decisions)
// layer: L1
import { runPhase, runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideLapsedRestates, decideClears, decidePersonSteps, decidePersonInputs, decideDateHolds, decideOutsideBlockers, decideOutsideHolds,
  decideMergeHolds } from '../desk/bin/pass/parks.mjs';
import { HELD_PREFIX, STOPPED_PREFIX, badLabelText, IDLE_RECHECK_MS, isHeld, parkKind, personStepPark } from '../desk/bin/batch-state.mjs';
import { newPark, applySet } from '../desk/bin/queue-writer.mjs';
import { shownState } from '../desk/bin/desk-q.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const byKey = (...ts) => Object.fromEntries(ts.map((x) => [x.key, x]));
const parked = (key, clears, fields = {}) => ({ key, state: 'parked', branch: `fix/${key}`, park: { question: 'which colour?', clears_when: clears }, ...fields });
const held = (key, by, fields = {}) => ({ key, state: 'parked', park: { question: `${HELD_PREFIX}: blocked by ${by}` }, held_by: by, ...fields });

// The runner with stub handlers: each read answers from `answers` (a value, or a function of the
// action), else from READS. A plain decision runs through runPhase, a generator through runSteps.
const READS = {
  'merge-park': null, check: { holds: false }, 'own-merged': { pr: null }, 'tail-after-merge': false, write: true, requeue: { ok: true, out: '' },
  'lift-put-off': { ok: true }, 'read-blockers': { unread: [], why: '' }, triage: {}, 'epic-merged': false, 'other-repo': false, landed: false, 'landed-here': false, unpromoted: null,
};
const WRITES = ['set', 'report', 'front', 'park', 'date-line', 'epic-line'];
function drive(decide, s, answers = {}, steps = true) {
  const handlers = Object.fromEntries([...Object.keys(READS), ...WRITES].map((type) => [type, (a) => {
    const v = Object.hasOwn(answers, type) ? answers[type] : READS[type];
    return typeof v === 'function' ? v(a) : v;
  }]));
  const report = { failed: [] };
  const run = steps ? runSteps : runPhase;
  return run({ name: 'parks', snapshot: () => s, decide, handlers, report });
}
const types = (as) => as.map((a) => a.type);
const sets = (as) => as.filter((a) => a.type === 'set').flatMap((a) => a.fields);
const lines = (as, type = 'report') => as.filter((a) => a.type === type).map((a) => a.line);
// What settles a park or moves a hold: a queue write, a requeue, a park, a front.
const SETTLES = new Set(['set', 'write', 'requeue', 'lift-put-off', 'tail-after-merge', 'park', 'front']);
const settles = (as) => as.filter((a) => SETTLES.has(a.type));

const clearsSnap = (tickets, more = {}) => ({ tickets, onBase: false, dry: false, putOff: new Set(), ...more });
const clears = (s, answers) => drive(decideClears, s, answers);
const PR_MERGED = { kind: 'pr-merged', pr: 41 };
const BASE_CONTAINS = 'base-contains';

// ---- parks whose condition cleared ----
// AC1: a park whose clears-when check could not run gets no action that settles it.
{
  const as = clears(clearsSnap(byKey(parked('A', PR_MERGED))), { check: { error: 'gh pr view 41: HTTP 502' } });
  t('AC1 a clears-when check that could not run settles nothing', j(settles(as)), '[]');
  t('AC1 and the park is reported left as it is', j(lines(as)), j(['A: could not check "PR #41 merged" (gh pr view 41: HTTP 502): left parked']));
}
{
  const as = clears(clearsSnap(byKey(parked('A', PR_MERGED))), { check: { holds: false, note: 'still open' } });
  t('a condition not yet holding is reported as waited on, and settles nothing', j([settles(as), lines(as)]), j([[], ['A: waiting on "PR #41 merged" (still open): left parked']]));
  t('one with no note says nothing', j(clears(clearsSnap(byKey(parked('A', PR_MERGED)))).filter((a) => a.type === 'report')), '[]');
}
// DS-864 AC1: a condition that can never hold is recorded none, with why, for the person: needs-you lists it
// and desk-q shows it as needs you, no longer waiting.
{
  const ON = { kind: 'commit-on', sha: '68c709f5a', branch: 'fix/A' };
  const never = 'the branch origin/fix/A has moved to 41736d45a, which 68c709f5a does not build on, so 68c709f5a can no longer land there: the push it waits on is stale';
  const as = clears(clearsSnap(byKey(parked('A', ON))), { check: { holds: false, never } });
  t('DS-864 AC1 a stale commit-on is recorded none, its why kept on the park, and nothing requeued',
    j([types(settles(as)), sets(as)]), j([['set'], ['park.clears_when={"kind":"none"}', `park.stale=${never}`]]));
  t('DS-864 AC1 and the pass says so', j(lines(as)), j([`A: "commit 68c709f5a on origin/fix/A" can never hold (${never}): recorded as none, for the person`]));
  const before = { ...parked('A', ON), lane: 'A', park: { question: 'push 68c709f5a onto fix/A', clears_when: ON } };
  // The state desk-q reads is the one the pass's own writes leave.
  const after = structuredClone(before);
  applySet(after, sets(as));
  t('DS-864 AC4 desk-q shows it as needs you, where it showed waiting before', `${shownState({ tickets: byKey(before) }, before)} → ${shownState({ tickets: byKey(after) }, after)}`, 'waiting → needs');
}
{
  const s = clearsSnap(byKey(parked('A', PR_MERGED, { park: { question: 'which colour?', clears_when: PR_MERGED, inputs: {} } })), { putOff: new Set(['A']) });
  const as = clears(s, { check: { holds: true } });
  t('a condition that holds requeues the ticket, records what cleared it and lifts its not-now entry',
    j(types(as)), j(['merge-park', 'check', 'own-merged', 'requeue', 'set', 'lift-put-off', 'report']));
  t('and says so', j(lines(as)), j(['A: "PR #41 merged" holds: requeued, its not-now entry lifted']));
  t('a dry run lifts no not-now entry', j(types(clears({ ...s, dry: true }, { check: { holds: true } }))), j(['merge-park', 'check', 'own-merged', 'requeue', 'set', 'report']));
  const refused = clears(s, { check: { holds: true }, requeue: { ok: false, out: 'locked\nqueue busy' } });
  t('a refused requeue leaves it parked', j([sets(refused), lines(refused)]), j([[], ['A: "PR #41 merged" holds, but the requeue was refused (queue busy): left parked']]));
}
// A fix try parked before its worker started is dropped when the park clears, and the PR is read again.
{
  const tryOf = (kind, more = {}) => ({ try: 1, of: 2, kind, pr: 46, head: 'a'.repeat(40), what: 'x', at: 'T0', ...more });
  const withTry = (f) => parked('A', PR_MERGED, { fix: f, fix_tries: [{ try: 1, head: f.head, kind: f.kind, what: 'x', at: 'T0' }, { try: 1, head: 'b', kind: 'checks', what: 'y', at: 'T-1' }] });
  const s = clearsSnap(byKey(withTry(tryOf('protected'))), { passAt: '2026-11-18T12:00:00.000Z' });
  const as = clears(s, { check: { holds: true } });
  t('an unstarted fix try is dropped, not requeued', j(types(as)), j(['merge-park', 'check', 'own-merged', 'write', 'report']));
  t('it is finished with no worker, taken out of the tries, and the ticket is done on its PR', j(as.find((a) => a.type === 'write').fields),
    j(['fix.finished=2026-11-18T12:00:00.000Z', 'fix.ended=parked before its worker started, and "PR #41 merged" holds', 'fix.no_worker=true',
      `fix_tries=${j([{ try: 1, head: 'b', kind: 'checks', what: 'y', at: 'T-1' }])}`, 'state=done', 'park=null', 'handoff_stage=null', 'result.pr=46']));
  t('and the line names the try by its kind', j(lines(as)), j(['A: "PR #41 merged" holds: its protected files try 1 of 2 on PR #46, parked before its worker started, is dropped, and the PR is read again for what it needs now']));
  for (const [name, f] of [['a started try', tryOf('feedback', { started: 'T1' })], ['a person\'s call', tryOf('gaps')], ['a review sent back', tryOf('review', { person: true })], ['a renames try', tryOf('renames')]]) {
    t(`${name} is requeued as before`, types(clears(clearsSnap(byKey(withTry(f)), { passAt: 'P' }), { check: { holds: true } })).includes('requeue'), true);
  }
}
{
  const s = clearsSnap(byKey(parked('A', PR_MERGED, { result: { pr: 7 } })));
  const as = clears(s, { check: { holds: true }, 'own-merged': { pr: 7 } });
  t('its own PR merged: closed out, recorded done', j(as.find((a) => a.type === 'write').fields),
    j(['state=done', 'park=null', 'handoff_stage=null', 'result.pr=7', 'result.summary=closed out: PR #41 merged, and its PR #7 merged']));
  t('and its line is said once the write is recorded', j(lines(as)), j(['A: "PR #41 merged" holds and its PR #7 merged: recorded done']));
  t('a refused write says nothing', j(lines(clears(s, { check: { holds: true }, 'own-merged': { pr: 7 }, write: false }))), '[]');
  const unread = clears(s, { check: { holds: true }, 'own-merged': { error: 'gh down' } });
  t('whether its own PR merged unread: left parked', j([settles(unread), lines(unread)]), j([[], ['A: "PR #41 merged" holds, but whether its own PR merged could not be read (gh down): left parked']]));
  const tail = clears(s, { check: { holds: true }, 'own-merged': { pr: 7 }, 'tail-after-merge': true });
  t('its own PR merged with its ticket not done: only the after-merge steps run', j(types(tail)), j(['merge-park', 'check', 'own-merged', 'tail-after-merge']));
}
{
  const as = clears(clearsSnap(byKey(parked('A', PR_MERGED, { lane: 'C' }))), { check: { holds: true } });
  t('a lane C park that holds is left for a person', j([settles(as), lines(as)]), j([[], ['A: "PR #41 merged" holds, but it is lane C: left parked for a person, never requeued for a headless worker']]));
  const push = clears(clearsSnap(byKey(parked('A', { kind: 'push-ok', branch: 'fix/A' }, { lane: 'C' }))));
  t('a lane C push is never tried', j(types(push)), '["report"]');
}
{
  const links = clears(clearsSnap(byKey(parked('A', { kind: 'links-made', links: [], pr: 9 }))), { check: { holds: true } });
  t('links made: done again on its PR', j(sets(links)), j(['state=done', 'park=null', 'result.pr=9']));
  const merges = clears(clearsSnap(byKey(parked('A', PR_MERGED))), { 'merge-park': { call: 'done', pr: 12, head: 'abcdef1234567', grant: '§3 pr-merge is yes' } });
  t('a merge question desk may now merge is done on its PR, with no check', j(types(merges)), j(['merge-park', 'set', 'report']));
  t('and keeps its words as the follow-on', sets(merges).some((f) => f.startsWith('follow_on=') && f.includes('which colour?')), true);
}
{
  const base = parked('B', { kind: BASE_CONTAINS, branch: 'main' });
  const tickets = byKey(base, parked('A', PR_MERGED));
  const keysChecked = (onBase) => clears(clearsSnap(tickets, { onBase })).filter((a) => a.type === 'check').map((a) => a.key);
  t('a park on "base contains" waits for the base step', j(keysChecked(false)), '["A"]');
  t('and only it is checked there', j(keysChecked(true)), '["B"]');
  const notClearable = byKey(parked('N', { kind: 'none' }), parked('L', { kind: 'live-read' }),
    // A held ticket with a recorded clears-when, so only its hold keeps it from being checked.
    held('H', 'X-1', { park: { question: `${HELD_PREFIX}: blocked by X-1`, clears_when: PR_MERGED } }), parked('C', PR_MERGED, { park: { question: 'q', clears_when: PR_MERGED, claim: { session: 's' } } }));
  t('none, live reads, holds and claimed parks are never checked', j(clears(clearsSnap(notClearable))), '[]');
}
// ---- lapsed restates ----
{
  const old = parked('U', { kind: 'unreadable', text: 'when it rains', at: new Date(NOW - 2 * 3600_000).toISOString() });
  const recent = parked('R', { kind: 'unreadable', text: 'soon', at: new Date(NOW - 60_000).toISOString() });
  const s = { tickets: byKey(old, recent), passAt: NOW, dry: false, usageHold: null };
  const as = drive(decideLapsedRestates, s, {}, false);
  t('an unreadable clears-when not restated within the hour is recorded none', j(sets(as)), j(['park.clears_when={"kind":"none"}']));
  t('and the person is told', j(lines(as)), j(['U: unreadable clears-when "when it rains" not restated within 60 minutes: recorded as none, for the person']));
  t('not on a usage hold, or in a dry run', j([decideLapsedRestates({ ...s, usageHold: { type: 'five_hour' } }), decideLapsedRestates({ ...s, dry: true })]), '[[],[]]');
}

// ---- date holds ----
const dateSnap = (tickets, triage, more = {}) => ({ tickets, triage, today: '2026-11-18', dry: false, ...more });
const dates = (s) => drive(decideDateHolds, s, {}, false);
// AC2: a triaged ticket whose blocked-until label cannot be read is held for the person.
{
  const as = dates(dateSnap(byKey({ key: 'A', state: 'triaged' }), { A: { labels: ['blocked-until-2026-13-45'] } }));
  t('AC2 an unreadable blocked-until label holds the ticket for the person',
    j(as.filter((a) => a.type !== 'date-line')), j([{ type: 'park', key: 'A', kind: 'date', question: `${HELD_PREFIX}: ${badLabelText('blocked-until-2026-13-45')}` }, { type: 'set', key: 'A', fields: ['held_label=blocked-until-2026-13-45'] }]));
}
// AC3: a triaged ticket whose blocked-until date is later than today is held until that date.
{
  const as = dates(dateSnap(byKey({ key: 'A', state: 'triaged' }), { A: { labels: ['blocked-until-2026-12-01'] } }));
  t('AC3 a later blocked-until date holds the ticket until that date',
    j(as), j([{ type: 'park', key: 'A', kind: 'date', question: `${HELD_PREFIX}: blocked until 2026-12-01 (label blocked-until-2026-12-01) — starts on that date by itself` }, { type: 'set', key: 'A', fields: ['held_label=blocked-until-2026-12-01'] }]));
  t('a date that has come holds nothing', j(dates(dateSnap(byKey({ key: 'A', state: 'triaged' }), { A: { labels: ['blocked-until-2026-11-18'] } }))), '[]');
  t('a label the person let start is not held on again', j(dates(dateSnap(byKey({ key: 'A', state: 'triaged', held_label: 'blocked-until-2026-12-01' }), { A: { labels: ['blocked-until-2026-12-01'] } }))), '[]');
}
{
  const h = { key: 'A', state: 'parked', park: { question: `${HELD_PREFIX}: blocked until 2026-11-10` }, held_label: 'blocked-until-2026-11-10' };
  const as = dates(dateSnap(byKey(h), { A: { labels: ['blocked-until-2026-11-10'] } }));
  t('a held ticket whose date has come is released', j([sets(as), lines(as, 'date-line')]), j([['state=triaged', 'park=null', 'held_label=null'], ['date hold: A: 2026-11-10 has come; RELEASED']]));
  t('an unread record keeps the label it was held on', j(dates(dateSnap(byKey({ ...h, held_label: 'blocked-until-2026-12-10' }), { A: { facts_error: 'jira down' } }))), '[]');
  t('a dry run only says what it would do', j(dates(dateSnap(byKey(h), { A: { labels: [] } }, { dry: true }))), j([{ type: 'date-line', line: 'date hold (dry run): A: would release it' }]));
}

// ---- person-step holds ----
{
  const tickets = byKey(held('A', 'P-1|Q-2', { held_outside: 'P-1|Q-2' }));
  const rec = { blockers: [{ key: 'P-1', category: 'new', labels: ['my-step'] }, { key: 'Q-2', category: 'new' }] };
  const s = { tickets, triage: { A: rec }, stepLabels: ['my-step'], inputLabels: ['my-input'], dry: false };
  const as = drive(decidePersonSteps, s, {}, false);
  t('a blocker that is the person step only for the merge moves to the merge gate', j(sets(as)), j(['held_by=Q-2', 'held_outside=Q-2', 'merge_after=P-1']));
  t('and the ticket stays held behind the rest', j(lines(as, 'date-line')), j(['RECLASSIFIED A: P-1 is a person step: build now, merge after', 'person-step hold: A: still held behind Q-2']));
  const alone = drive(decidePersonSteps, { ...s, tickets: byKey(held('A', 'P-1', { held_outside: 'P-1' })) }, {}, false);
  t('with no hold left it is released to the front', j(types(alone)), j(['set', 'front', 'date-line', 'date-line']));
  const input = { key: 'B', state: 'triaged', merge_after: 'P-1' };
  const back = drive(decidePersonInputs, { ...s, tickets: byKey(input), triage: { B: { blockers: [{ key: 'P-1', category: 'new', labels: ['my-input'] }] } } }, {}, false);
  t('a merge gate on a blocker now labelled as the person input is a full hold again', j(types(back)), j(['park', 'set', 'date-line']));
  t('held behind it', j(sets(back)), j(['held_by=P-1', 'held_outside=P-1', 'merge_after=null']));
}

// ---- outside blockers ----
{
  const tk = { key: 'DS-1', state: 'triaged' };
  const before = { blockers: [{ key: 'X-9', category: 'new' }] };
  const after = { blockers: [{ key: 'X-9', category: 'new', assignee: 'Sam' }] };
  const s = { tickets: byKey(tk), epic: null, onJira: true, trackerKeys: new Set(['DS-1']), triage: { 'DS-1': before }, now: NOW, dry: false };
  const as = drive(decideOutsideBlockers, s, { 'read-blockers': { unread: [], why: '' }, triage: { 'DS-1': after } });
  t('a ticket with outside blockers is read again, and its record read after the read', j(types(as)), j(['read-blockers', 'triage', 'set']));
  t('and records them as read', j(sets(as)), j(['outside_blockers=[{"key":"X-9","category":"new","assignee":"Sam"}]']));
  const fresh = drive(decideOutsideBlockers, { ...s, tickets: byKey({ ...tk, outside_blockers_read: new Date(NOW - 60_000).toISOString() }) });
  t('one read within the intake interval is not read again', types(fresh).includes('read-blockers'), false);
  t('nothing is read off Jira', j(drive(decideOutsideBlockers, { ...s, onJira: false })), '[]');
  const unread = drive(decideOutsideBlockers, s, { 'read-blockers': { unread: ['DS-1'], why: 'jira 503' }, triage: { 'DS-1': before } });
  t('a failed read is said', lines(unread, 'epic-line')[0], 'outside blockers: not read, kept as they were and tried again in 15 minutes: jira 503');
}

// ---- outside holds ----
{
  const tk = held('A', 'X-1|X-2', { held_outside: 'X-1|X-2' });
  const rec = { blockers: [{ key: 'X-1', category: 'done', resolution: 'Done' }, { key: 'X-2', category: 'new' }] };
  const s = { tickets: byKey(tk), epic: null, triage: { A: rec }, defaultBranch: 'main', repoDefault: 'main', now: NOW, dry: false };
  const stamp = `outside_read=${new Date(NOW).toISOString()}`;
  const asked = [];
  const as = drive(decideOutsideHolds, s, { landed: (a) => { asked.push(a.key); return true; } });
  t('only a Done blocker is asked whether it landed', j(asked), '["X-1"]');
  t('one that landed is lifted, the rest still hold, and when they were read is kept', j(sets(as)), j(['held_by=X-2', 'held_outside=X-2', stamp]));
  t('and it says so', lines(as, 'epic-line')[0], 'outside hold: A: X-1 Done and on main; still held behind X-2');
  const all = drive(decideOutsideHolds, { ...s, triage: { A: { blockers: [rec.blockers[0]] } } }, { landed: true });
  t('lifting the last releases it to the front', j(types(all.filter((a) => !['epic-merged', 'other-repo', 'landed'].includes(a.type)))), j(['set', 'front', 'epic-line']));
  const away = drive(decideOutsideHolds, s, { 'other-repo': (a) => a.key === 'X-1', landed: () => { throw new Error('asked'); } });
  t('Done in another repo lifts it with no landed read', lines(away, 'epic-line')[0], 'outside hold: A: X-1 Done in Jira, in another repo; still held behind X-2');
  const none = drive(decideOutsideHolds, s);
  t('nothing lifted, nothing said', j(lines(none, 'epic-line')), '[]');
  t('only when they were read is kept', j(sets(none)), j([stamp]));
  const both = { blockers: [rec.blockers[0], { key: 'X-2', category: 'done', resolution: 'Done' }] };
  const three = { ...s, tickets: byKey(tk, { ...tk, key: 'B' }, { ...tk, key: 'C' }), triage: { A: both, B: both, C: both } };
  const reads = [];
  const gh = { landed: (a) => { reads.push(`landed ${a.key}`); return false; }, 'epic-merged': (a) => { reads.push(`epic ${a.key}`); return false; } };
  drive(decideOutsideHolds, three, gh);
  t('DS-815 AC3 three tickets held behind the same two blockers ask GitHub once per blocker, and a Done one only whether it landed', j(reads), j(['landed X-1', 'landed X-2']));
  reads.length = 0;
  const readAt = (ago) => ({ ...tk, outside_read: new Date(NOW - ago).toISOString() });
  const later = drive(decideOutsideHolds, { ...three, tickets: byKey(readAt(60_000), { ...readAt(60_000), key: 'B' }, { ...readAt(60_000), key: 'C' }) }, gh);
  t('DS-815 AC3 and not again within the recheck interval', j(reads), '[]');
  t('so nothing is written', j(sets(later)), '[]');
  drive(decideOutsideHolds, { ...three, tickets: byKey(readAt(IDLE_RECHECK_MS - 1000)) }, gh);
  t('DS-815 AC3 not a second before the interval has passed', j(reads), '[]');
  drive(decideOutsideHolds, { ...three, tickets: byKey(readAt(IDLE_RECHECK_MS)) }, gh);
  t('DS-815 AC1 once the interval has passed, they are asked again', j(reads), j(['landed X-1', 'landed X-2']));
  reads.length = 0;
  const open = { blockers: [{ key: 'X-1', category: 'new' }, { key: 'X-2', category: 'new' }] };
  drive(decideOutsideHolds, { ...three, triage: { A: open, B: open, C: open } }, gh);
  t('DS-815 AC3 one not Done is asked once per pass only whether it landed through its epic PR', j(reads), j(['epic X-1', 'epic X-2']));
  reads.length = 0;
  const openLater = drive(decideOutsideHolds, { ...three, triage: { A: open, B: open, C: open }, tickets: byKey(readAt(60_000), { ...readAt(60_000), key: 'B' }, { ...readAt(60_000), key: 'C' }) }, gh);
  t('DS-815 its own batch landing through its epic PR is read from disk on every pass, within the interval too (its GitHub read keeps its own interval, pass.mjs epicMerged)', j(reads), j(['epic X-1', 'epic X-2']));
  t('and asking it moves no ticket\'s clock', j(sets(openLater)), '[]');
  reads.length = 0;
  // A, not read within the interval, asks X-1; B, read a minute ago, picks up that answer, but X-2 is
  // B's alone and was not asked, so B's clock stays where it was, and X-2 is asked once B's interval passes.
  const sharedFirst = { ...tk, held_by: 'X-1', held_outside: 'X-1' };
  const shared = drive(decideOutsideHolds, { ...three, tickets: byKey(sharedFirst, { ...readAt(60_000), key: 'B' }), triage: { A: { blockers: [rec.blockers[0]] }, B: both } }, gh);
  t('DS-815 an answer another ticket fetched does not restart the clock of one whose blockers were not all asked', j(reads), j(['landed X-1']));
  t('so only the ticket that asked is stamped', j(shared.filter((a) => a.type === 'set').map((a) => a.key)), j(['A']));
  reads.length = 0;
  const fresh = drive(decideOutsideHolds, { ...s, tickets: byKey(readAt(60_000)), triage: { A: { blockers: [rec.blockers[0]] } } }, { ...gh, 'other-repo': (a) => a.key === 'X-1' });
  t('a blocker that needs no GitHub read still lifts within the interval', lines(fresh, 'epic-line')[0], 'outside hold: A: X-1 Done in Jira, in another repo; X-2 no longer linked as a blocker; RELEASED');
  t('and the release clears when they were read', sets(fresh).includes('outside_read=null'), true);
}

// DS-811: a DS-705-shaped hold. The blocker is Done, and its PR merged into a feature base that has no
// promotion PR. A day after it was resolved, the pass records the base on the ticket and says so once.
{
  const base = { branch: 'feat/DS-631-levers', pr: null, state: 'none' };
  const tk = held('DS-705', 'DS-692', { held_outside: 'DS-692' });
  const rec = (hours) => ({ blockers: [{ key: 'DS-692', category: 'done', resolution: 'Done', resolved: new Date(NOW - hours * 3600_000).toISOString() }] });
  const snap = (hours, ticket = tk) => ({ tickets: byKey(ticket), epic: null, triage: { 'DS-705': rec(hours) }, defaultBranch: 'main', repoDefault: 'main', now: NOW, dry: false });
  // Each pass that asks whether the blocker landed also stamps when it did (DS-815's outside_read).
  const stamp = `outside_read=${new Date(NOW).toISOString()}`;
  const asked = [];
  const as = drive(decideOutsideHolds, snap(48), { unpromoted: (a) => { asked.push(a.key); return base; } });
  const since = new Date(NOW - 48 * 3600_000).toISOString();
  t('DS-811 AC1 a Done blocker not landed a day on is asked where its code is', j(asked), '["DS-692"]');
  t('DS-811 AC1 the base and its promotion PR are recorded on the held ticket, which stays held',
    j(sets(as)), j([`unpromoted=${JSON.stringify({ 'DS-692': { ...base, since } })}`, stamp]));
  t('DS-811 AC1 and it is said once', lines(as, 'epic-line').join(),
    'outside hold: DS-705: DS-692 Done since 2026-11-16, its code on feat/DS-631-levers with no promotion PR: raised once, in needs-you');
  const young = drive(decideOutsideHolds, snap(23), { unpromoted: () => { throw new Error('asked'); } });
  t('DS-811 AC2 Done under a day: nothing asked, recorded or said', j([young.filter((a) => !['epic-merged', 'other-repo', 'landed', 'set'].includes(a.type)), sets(young)]), j([[], [stamp]]));
  const recorded = { ...tk, unpromoted: { 'DS-692': { ...base, since } } };
  const again = drive(decideOutsideHolds, snap(48, recorded), { unpromoted: base });
  t('DS-811 AC5 the next pass finds it again and raises nothing, nor writes it', j([sets(again), lines(again, 'epic-line')]), j([[stamp], []]));
  const opened = drive(decideOutsideHolds, snap(48, { ...recorded, unpromoted: { 'DS-692': { ...base, since, promote: 12 } } }), { unpromoted: { ...base, pr: 12, state: 'red' } });
  t('DS-811 a promotion PR that changed state is written, the PR asked for kept, and not said again',
    j([sets(opened), lines(opened, 'epic-line')]), j([[`unpromoted=${JSON.stringify({ 'DS-692': { ...base, pr: 12, state: 'red', since, promote: 12 } })}`, stamp], []]));
  const unread = drive(decideOutsideHolds, snap(48, recorded), { unpromoted: null });
  t('DS-811 a read that failed keeps what was recorded', j(sets(unread)), j([stamp]));
  const noLanded = drive(decideOutsideHolds, snap(48, recorded), { landed: null, unpromoted: () => { throw new Error('asked'); } });
  t('DS-811 so does a landed read that failed, with nothing said', j([sets(noLanded), lines(noLanded, 'epic-line')]), j([[stamp], []]));
  const recent = { ...recorded, outside_read: new Date(NOW - 60_000).toISOString() };
  const throttledReads = [];
  const throttled = drive(decideOutsideHolds, snap(48, recent), { landed: (a) => { throttledReads.push(`landed ${a.key}`); return false; }, unpromoted: (a) => { throttledReads.push(`unpromoted ${a.key}`); return base; } });
  t('DS-811 within the recheck interval nothing is asked, and the record is kept, unwritten and unsaid', j([throttledReads, sets(throttled), lines(throttled, 'epic-line')]), '[[],[],[]]');
  const landed = drive(decideOutsideHolds, snap(48, recorded), { landed: true });
  t('DS-811 once it lands the record is dropped and the hold lifted', j(sets(landed)), j(['unpromoted=null', 'state=triaged', 'park=null', 'held_by=null', 'held_outside=null', 'outside_read=null']));
  const into = [];
  drive(decideOutsideHolds, { ...snap(48), defaultBranch: 'feat/DS-700-other', repoDefault: 'main' }, { unpromoted: (a) => { into.push(a.into); return base; } });
  t('DS-811 in a named batch its promotion PR is read into the repo default branch, which needs-you promotes into, not the batch base', j(into), '["main"]');
  t('DS-811 a dry run says it and writes nothing', j([sets(drive(decideOutsideHolds, { ...snap(48), dry: true }, { unpromoted: base })), lines(drive(decideOutsideHolds, { ...snap(48), dry: true }, { unpromoted: base }), 'epic-line')[0]?.startsWith('outside hold (dry run): DS-705')]), '[[],true]');
  // DS-947: its branch's promotion PR into the default branch has merged, and the batch base has not synced it yet.
  const promoted = { ...base, pr: 871, state: 'merged' };
  const named = { ...snap(48), defaultBranch: 'feat/DS-691-desk-app', repoDefault: 'main' };
  const waits = drive(decideOutsideHolds, named, { landed: false, unpromoted: promoted });
  t('DS-947 AC1 a merged promotion raises nothing: the hold stays, waiting for the base to sync', j([sets(waits), lines(waits, 'epic-line')]), j([[stamp], []]));
  const raisedBefore = drive(decideOutsideHolds, { ...named, tickets: byKey(recorded) }, { landed: false, unpromoted: promoted });
  t('DS-947 AC1 and a promote item raised before it merged is dropped, the ticket still held', j([sets(raisedBefore), lines(raisedBefore, 'epic-line')]), j([['unpromoted=null', stamp], []]));
  const synced = drive(decideOutsideHolds, named, { landed: true, unpromoted: () => { throw new Error('asked'); } });
  t('DS-947 AC2 once the base holds it the hold lifts', j(sets(synced)), j(['state=triaged', 'park=null', 'held_by=null', 'held_outside=null', 'outside_read=null']));
}

// ---- merge holds ----
{
  const tk = { key: 'A', state: 'running', merge_after: 'P-1|G-2' };
  const rec = {
    blockers: [{ key: 'P-1', category: 'done', labels: ['my-step'] }, { key: 'G-2', category: 'done', resolution: 'Done' }],
    blocker_needs: { 'G-2': { needs: 'merge', why: 'its API' } },
  };
  const s = { tickets: byKey(tk), triage: { A: rec }, stepLabels: ['my-step'], inputLabels: [], dry: false };
  const asked = [];
  const as = drive(decideMergeHolds, s, { 'landed-here': (a) => { asked.push(a.key); return false; } });
  t('a step Done is lifted with no landed read; a triage gate is asked whether it landed', j(asked), '["G-2"]');
  t('and the gate not landed still holds the merge', j([sets(as), lines(as, 'epic-line')]), j([['merge_after=G-2'], ['merge hold: A: P-1 Done; still merges only after G-2']]));
  const free = drive(decideMergeHolds, s, { 'landed-here': true });
  t('both lifted frees the merge', lines(free, 'epic-line')[0], 'merge hold: A: P-1, G-2 Done; free to merge');
  t('a merged ticket waits on nothing', j(drive(decideMergeHolds, { ...s, tickets: byKey({ ...tk, merged_at: 'x' }) })), '[]');
}

// ---- DS-895: a park's kind ----
// AC1: a ticket held behind a sibling, its park question since reworded, still reads as held.
{
  const sib = { key: 'S-1', state: 'running' };
  const was = held('A', 'S-1', { park: { question: `${HELD_PREFIX}: blocked by S-1`, kind: 'hold' } });
  const reworded = { ...was, park: { question: 'waits for S-1 to merge, then starts', kind: 'hold' } };
  const qOf = (x) => ({ tickets: byKey(sib, x) });
  t('DS-895 AC1 a hold whose question was reworded is still held', isHeld(reworded), true);
  t('DS-895 AC1 and desk-q shows it as it showed the hold before the rewording', `${shownState(qOf(reworded), reworded)}`, `${shownState(qOf(was), was)}`);
  t('DS-895 AC1 a cleared condition does not settle it as a park of its own',
    j(settles(clears(clearsSnap(byKey(sib, { ...reworded, park: { ...reworded.park, clears_when: PR_MERGED } })), { check: { holds: true } }))), '[]');
  t('DS-895 AC1 a park of its own whose question opens like a hold is not one', isHeld({ key: 'B', state: 'parked', park: { question: `${HELD_PREFIX}?`, kind: 'question' } }), false);
}
// AC3: a park recorded before parks carried their kind, or taken in from a park file holding only a
// question, gets the kind its question opens as.
{
  const kinds = (qs) => qs.map((x) => newPark(x).kind).join(' ');
  t('DS-895 AC3 a park taken in from its question alone gets the kind the question opens as',
    kinds(['which colour?', "the person's step: apply the migration", `${HELD_PREFIX}: blocked by X-1`, `${STOPPED_PREFIX} at x`, `${HELD_PREFIX}: blocked until 2026-12-01 (label b)`, `${HELD_PREFIX}: ${badLabelText('b')}`]),
    'question person-step hold stopped date date');
  t('DS-895 AC3 a writer that names the kind records that kind', newPark(`${HELD_PREFIX}: blocked by X-1`, 'x', 'stopped').kind, 'stopped');
  t('DS-895 AC3 a park recorded with no kind is read by its question', j(['which colour?', `${HELD_PREFIX}: blocked by X-1`, `${STOPPED_PREFIX} at x`].map((x) => parkKind({ park: { question: x } }))), '["question","hold","stopped"]');
  t('DS-895 AC3 an unknown kind on a park is read by its question', parkKind({ park: { question: 'which colour?', kind: 'held' } }), 'question');
  t('DS-895 a person step is read by its kind, its question reworded or not',
    j([{ question: 'apply the migration on staging', kind: 'person-step' }, { question: "the person's step: apply the migration" }, { question: "the person's step: apply it", kind: 'question' }]
      .map((park) => personStepPark({ state: 'parked', park }))), '[true,true,false]');
}

// AC5: the decisions start no process, call no git, gh or Jira, and write nothing, the queue included.
{
  const { out, threw, calls } = withNoIo(() => [
    clears(clearsSnap(byKey(parked('A', PR_MERGED), parked('B', { kind: BASE_CONTAINS, branch: 'main' }))), { check: { holds: true } }),
    drive(decideLapsedRestates, { tickets: byKey(parked('U', { kind: 'unreadable', at: '2020-01-01T00:00:00Z' })), passAt: NOW, dry: false, usageHold: null }, {}, false),
    dates(dateSnap(byKey({ key: 'A', state: 'triaged' }), { A: { labels: ['blocked-until-2026-12-01'] } })),
    drive(decidePersonSteps, { tickets: byKey(held('A', 'P-1', { held_outside: 'P-1' })), triage: { A: { blockers: [{ key: 'P-1', category: 'new', labels: ['s'] }] } }, stepLabels: ['s'], inputLabels: [], dry: false }, {}, false),
    drive(decideOutsideBlockers, { tickets: byKey({ key: 'DS-1', state: 'triaged' }), epic: null, onJira: true, trackerKeys: new Set(['DS-1']), triage: { 'DS-1': { blockers: [{ key: 'X-9', category: 'new' }] } }, now: NOW, dry: false }),
    drive(decideOutsideHolds, { tickets: byKey(held('A', 'X-1', { held_outside: 'X-1' })), epic: null, triage: { A: { blockers: [{ key: 'X-1', category: 'done' }] } }, defaultBranch: 'main', repoDefault: 'main', now: NOW, dry: false }, { landed: true }),
    drive(decideMergeHolds, { tickets: byKey({ key: 'A', state: 'running', merge_after: 'P-1' }), triage: { A: { blockers: [{ key: 'P-1', category: 'done' }] } }, stepLabels: [], inputLabels: [], dry: false }),
  ].map((as) => as.length));
  t('AC5 every decision returns its actions', out.every((n) => n > 0), true);
  t('AC5 and starts no process and writes no file on the way', j([threw, calls]), '[null,[]]');
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
