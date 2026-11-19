// suite: pass phase: parks and holds (the clears-when, person-step, date, outside and merge hold decisions)
import { runPhase, runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideLapsedRestates, decideClears, decidePersonSteps, decidePersonInputs, decideDateHolds, decideOutsideBlockers, decideOutsideHolds,
  decideMergeHolds } from '../desk/bin/pass/parks.mjs';
import { HELD_PREFIX, badLabelText, IDLE_RECHECK_MS } from '../desk/bin/batch-state.mjs';
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
  'lift-put-off': { ok: true }, 'read-blockers': { unread: [], why: '' }, triage: {}, 'epic-merged': false, 'other-repo': false, landed: false, 'landed-here': false,
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
{
  const s = clearsSnap(byKey(parked('A', PR_MERGED, { result: { pr: 7 } })));
  const as = clears(s, { check: { holds: true }, 'own-merged': { pr: 7 } });
  t('its own PR merged: closed out, recorded done', j(as.find((a) => a.type === 'write').fields),
    j(['state=done', 'park=null', 'handoff_stage=null', 'result.summary=closed out: PR #41 merged, and its PR #7 merged', 'result.pr=7']));
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
    j(as.filter((a) => a.type !== 'date-line')), j([{ type: 'park', key: 'A', question: `${HELD_PREFIX}: ${badLabelText('blocked-until-2026-13-45')}` }, { type: 'set', key: 'A', fields: ['held_label=blocked-until-2026-13-45'] }]));
}
// AC3: a triaged ticket whose blocked-until date is later than today is held until that date.
{
  const as = dates(dateSnap(byKey({ key: 'A', state: 'triaged' }), { A: { labels: ['blocked-until-2026-12-01'] } }));
  t('AC3 a later blocked-until date holds the ticket until that date',
    j(as), j([{ type: 'park', key: 'A', question: `${HELD_PREFIX}: blocked until 2026-12-01 (label blocked-until-2026-12-01) — starts on that date by itself` }, { type: 'set', key: 'A', fields: ['held_label=blocked-until-2026-12-01'] }]));
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
  t('DS-815 AC3 three tickets held behind the same two blockers ask GitHub once per blocker', j(reads), j(['epic X-1', 'epic X-2', 'landed X-1', 'landed X-2']));
  reads.length = 0;
  const readAt = (ago) => ({ ...tk, outside_read: new Date(NOW - ago).toISOString() });
  const later = drive(decideOutsideHolds, { ...three, tickets: byKey(readAt(60_000), { ...readAt(60_000), key: 'B' }, { ...readAt(60_000), key: 'C' }) }, gh);
  t('DS-815 AC3 and not again within the recheck interval', j(reads), '[]');
  t('so nothing is written', j(sets(later)), '[]');
  drive(decideOutsideHolds, { ...three, tickets: byKey(readAt(IDLE_RECHECK_MS - 30_000)) }, gh);
  t('DS-815 AC1 once the interval has all but passed, they are asked again', j(reads), j(['epic X-1', 'epic X-2', 'landed X-1', 'landed X-2']));
  reads.length = 0;
  const fresh = drive(decideOutsideHolds, { ...s, tickets: byKey(readAt(60_000)), triage: { A: { blockers: [rec.blockers[0]] } } }, { ...gh, 'other-repo': (a) => a.key === 'X-1' });
  t('a blocker that needs no GitHub read still lifts within the interval', lines(fresh, 'epic-line')[0], 'outside hold: A: X-1 Done in Jira, in another repo; X-2 no longer linked as a blocker; RELEASED');
  t('and the release clears when they were read', sets(fresh).includes('outside_read=null'), true);
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
