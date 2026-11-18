// suite: pass phase: the promotion PR, the epic PR, the promotion ledger and the epics read (the decisions)
import { runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decidePromotion, decideEpicReads, decideEpicPr, decideLedger, epicState, epicPending, promotionTitle } from '../desk/bin/pass/promotion-pr.mjs';
import { ledgerHash } from '../desk/bin/ledger.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
// The runner with stub handlers: each read answers from `answers` (a value, or a function of the action).
const TYPES = ['set', 'report', 'set-batch', 'base-line', 'out', 'open-draft-promotion', 'promotion-merge', 'feedback', 'verdict', 'ready',
  'start-try', 'merger', 'driver-running', 'write-ledger', 'read-epics', 'epic-line'];
function drive(decide, s, answers = {}) {
  const handlers = Object.fromEntries(TYPES.map((type) => [type, (a) => { const v = answers[type]; return typeof v === 'function' ? v(a) : v; }]));
  const report = { failed: [] };
  const actions = runSteps({ name: 'test', snapshot: () => s, decide, handlers, report });
  if (report.failed.length) { fails++; console.log(`FAIL an action with no handler: ${j(report.failed)}`); }
  return { actions, failed: report.failed };
}
const types = (as) => as.map((a) => a.type);
const lines = (as) => as.filter((a) => ['out', 'base-line', 'epic-line', 'report'].includes(a.type)).map((a) => a.line);

// ---- the promotion PR --------------------------------------------------------
const kid = (key, fields = {}) => ({ key, state: 'done', result: { pr: 10 }, ...fields });
const promo = (fields = {}) => ({
  promotion: null, tickets: { A: kid('A', { merged_at: '2026-11-18T10:00:00Z' }), B: { key: 'B', state: 'running' } },
  ready: true, featureMode: true, epicOn: false, epicDue: false, gateBusy: false, epic: 'DS-1', base: 'feat/x', source: 'main', dry: false, now: NOW, ...fields,
});
{
  const { actions } = drive(decidePromotion, promo());
  t('AC1 a feature batch\'s first pass with no promotion recorded opens one draft promotion PR', j(actions), j([{ type: 'open-draft-promotion', carry: {}, title: 'DS-1: promote feat/x to main' }]));
}
t('AC2 a promotion refused and recorded with a reason is not tried again', j(drive(decidePromotion, promo({ promotion: { pr: null, why: 'config §3 pr-open is "ask"' } })).actions), '[]');
t('a base worktree not ready, or owned by a fix worker, opens nothing', j(drive(decidePromotion, promo({ ready: false })).actions), '[]');
t('a dry run says what it would open', j(lines(drive(decidePromotion, promo({ dry: true })).actions)), j(['promotion PR (dry run): would open feat/x → main as a draft, titled "DS-1: promote feat/x to main"']));
t('a feature batch with no epic is titled Feature', promotionTitle(null, 'b', 'main', 2), 'Feature: promote b to main (slice 2)');
t('an open promotion PR is not read while the base gate runs', j(drive(decidePromotion, promo({ promotion: { pr: 5 }, gateBusy: true })).actions), '[]');
t('a promotion PR whose merge is recorded is not read again', j(drive(decidePromotion, promo({ promotion: { pr: 5, merged: [{ pr: 5 }] } })).actions), '[]');
t('an open promotion PR is read, and nothing follows', j(types(drive(decidePromotion, promo({ promotion: { pr: 5 } }), { 'promotion-merge': { state: 'OPEN' } }).actions)), '["promotion-merge"]');
t('an unreadable promotion PR waits for the next pass', j(types(drive(decidePromotion, promo({ promotion: { pr: 5 } }), { 'promotion-merge': null }).actions)), '["promotion-merge"]');
{
  const { actions } = drive(decidePromotion, promo({ promotion: { pr: 5, slice: 1 } }), { 'promotion-merge': { state: 'MERGED', mergedAt: '2026-11-18T11:00:00Z' } });
  const merged = [{ pr: 5, slice: 1, merged_at: '2026-11-18T11:00:00Z' }];
  t('a merged promotion PR with children to come opens the next slice, its gate reset', j(actions), j([
    { type: 'promotion-merge', pr: 5 },
    { type: 'base-line', line: 'promotion PR #5 (slice 1) merged into main' },
    { type: 'set-batch', fields: ['gate=null'] },
    { type: 'open-draft-promotion', carry: { slice: 2, since: '2026-11-18T11:00:00Z', merged }, title: 'DS-1: promote feat/x to main (slice 2)' },
  ]));
}
{
  const tickets = { A: kid('A', { merged_at: '2026-11-18T10:00:00Z' }) };
  const { actions } = drive(decidePromotion, promo({ tickets, promotion: { pr: 5 } }), { 'promotion-merge': { state: 'MERGED', mergedAt: '2026-11-18T11:00:00Z' } });
  t('the last promotion merging is recorded, and none opens after it', j(actions.slice(1)), j([{ type: 'set-batch', fields: [`promotion.merged=${j([{ pr: 5, slice: 1, merged_at: '2026-11-18T11:00:00Z' }])}`] }]));
  const dry = drive(decidePromotion, promo({ tickets, promotion: { pr: 5 }, dry: true }), { 'promotion-merge': { state: 'MERGED', mergedAt: '2026-11-18T11:00:00Z' } });
  t('a dry run records nothing for it', j(types(dry.actions)), '["promotion-merge"]');
}
t('a dry run says it would open the next slice, and writes nothing',
  j(drive(decidePromotion, promo({ promotion: { pr: 5 }, dry: true }), { 'promotion-merge': { state: 'MERGED', mergedAt: '2026-11-18T11:00:00Z' } }).actions.slice(1).map((a) => a.type)), '["base-line","base-line"]');

// The epic PR, opened by an epic batch once its children have merged.
const epicBatch = (fields) => promo({ featureMode: false, epicOn: true, epicDue: true, ...fields });
t('an epic batch whose children have merged opens its epic PR', j(drive(decidePromotion, epicBatch({})).actions), j([{ type: 'open-draft-promotion', carry: {}, title: 'DS-1: promote feat/x to main' }]));
t('an epic PR refused last pass is tried again', j(types(drive(decidePromotion, epicBatch({ promotion: { pr: null, why: 'x' } })).actions)), '["open-draft-promotion"]');
t('an epic PR open and not merged opens nothing', j(drive(decidePromotion, epicBatch({ promotion: { pr: 7 } })).actions), '[]');
t('an epic batch with children to merge opens nothing', j(drive(decidePromotion, epicBatch({ epicDue: false })).actions), '[]');
t('the epic PR after a merged one carries its merge', j(drive(decidePromotion, epicBatch({ promotion: { pr: 7, merged_at: '2026-11-18T09:00:00Z' } })).actions[0].carry),
  j({ since: '2026-11-18T09:00:00Z', merged: [{ pr: 7, merged_at: '2026-11-18T09:00:00Z' }] }));

// ---- the promotion ledger ------------------------------------------------------
const LEDGER = '<!-- ledger -->\n| A | merged |';
const ledger = (fields = {}) => ({ promotion: { pr: 5 }, ledger: LEDGER, editPerm: 'yes', editKey: 'pr-edit', dry: false, ...fields });
t('a batch with no promotion PR writes no ledger', j(drive(decideLedger, { promotion: null }).actions), '[]');
t('a ledger unchanged since its last write is not written', j(drive(decideLedger, ledger({ promotion: { pr: 5, ledger: ledgerHash(LEDGER) } })).actions), '[]');
{
  // The last pass's write failed, so the hash it would have recorded is not on the queue.
  const { actions } = drive(decideLedger, ledger({ promotion: { pr: 5, ledger: ledgerHash('<!-- ledger -->\n| A | running |') } }), { 'write-ledger': { ok: true, action: 'edited' } });
  t('AC3 a ledger not written last pass is written again, and recorded once it is', j(actions), j([
    { type: 'write-ledger', pr: 5, ledger: LEDGER },
    { type: 'out', line: 'promotion PR #5: ledger comment edited' },
    { type: 'set-batch', fields: [`promotion.ledger=${ledgerHash(LEDGER)}`] },
  ]));
}
t('a write that fails is reported and records nothing, so the next pass tries again',
  j(drive(decideLedger, ledger(), { 'write-ledger': { ok: false, why: 'its comments could not be read (HTTP 502)' } }).actions.slice(1)),
  j([{ type: 'out', line: 'promotion PR #5: ledger not updated, since its comments could not be read (HTTP 502). The batch carries on; the next pass tries again' }]));
t('a comment already as it should read is recorded without a line', j(types(drive(decideLedger, ledger(), { 'write-ledger': { ok: true, action: 'unchanged' } }).actions)), '["write-ledger","set-batch"]');
t('without §3 pr-edit the ledger is not written, and the row is named', j(lines(drive(decideLedger, ledger({ editPerm: 'ask' })).actions)),
  j(['promotion PR #5: ledger not updated, since config §3 pr-edit is "ask". The batch carries on; the next pass tries again']));
t('a dry run says it would write the ledger', j(lines(drive(decideLedger, ledger({ dry: true })).actions)), j(['promotion PR #5 (dry run): would rewrite its ledger comment']));

// ---- the epic PR -----------------------------------------------------------------
const epicSnap = (fields = {}) => ({
  epicOn: true, due: true, promotion: { pr: 7, url: 'https://x/7' }, tickets: { A: kid('A', { merged_at: '2026-11-18T10:00:00Z' }) },
  epicPr: { pr: 7, state: 'OPEN', isDraft: true, head: 'abc' }, bf: null, baseFixLive: false, baseFix: false, baseFixRoom: true, noRoom: null,
  baseWt: '/wt/base', readyPerm: 'yes', readyKey: 'pr-ready', base: 'feat/x', source: 'main', repo: 'o/r', dry: false, ...fields,
});
t('an epic batch with children to merge has no epic PR step', j([drive(decideEpicPr, { epicOn: true, due: false }).actions, epicPending({ epicOn: true, due: false })]), '[[],false]');
t('the epic PR step is pending once its children have merged', epicPending(epicSnap()), true);
t('an epic PR not opened yet waits for the base section', j(drive(decideEpicPr, epicSnap({ promotion: { pr: null } })).actions), '[]');
t('an unreadable epic PR waits for the next pass', j(lines(drive(decideEpicPr, epicSnap({ epicPr: { pr: 7, unreadable: true } })).actions)), j(['epic PR #7: could not be read; the next pass tries again']));
t('a closed epic PR is the person\'s', j(lines(drive(decideEpicPr, epicSnap({ epicPr: { pr: 7, state: 'CLOSED' } })).actions)),
  j(['EPIC PR: #7 (feat/x → main) was closed without merging, so nothing lands on main: reopen it, or open a new one with queue.mjs set-batch promotion=null. https://x/7']));
{
  const fb = { head: 'abc', payload: {} };
  const clean = (fields, answers = {}) => drive(decideEpicPr, epicSnap(fields), { feedback: fb, verdict: { clean: true }, ready: { ok: true, out: '' }, ...answers }).actions;
  t('a draft with a clean review at its head is taken out of draft', j(clean({}).map((a) => a.type === 'out' ? a.line : a.type)),
    j(['feedback', 'verdict', 'ready', 'epic PR #7: its review is clean at its head, so it is out of draft; the merge driver merges it once it is green']));
  t('without §3 pr-ready it is put to the person', j(lines(clean({ readyPerm: 'ask' }))), j(['EPIC PR: #7 has a clean review at its head, but config §3 pr-ready is "ask": mark it ready (gh pr ready 7 --repo o/r). https://x/7']));
  t('a dry run does not take it out of draft', j(types(clean({ dry: true }))), '["feedback","verdict","out"]');
  t('a failed gh pr ready is said, and tried again next pass', j(lines(clean({}, { ready: { ok: false, out: 'x\nHTTP 500' } }))),
    j(['EPIC PR: #7 has a clean review at its head, but gh pr ready failed (HTTP 500): mark it ready. The next pass tries again. https://x/7']));
  t('an unread review waits for the next pass', j(lines(drive(decideEpicPr, epicSnap(), { feedback: null }).actions)), j(['epic PR #7: its review could not be read; the next pass tries again']));
  const unclean = (fields) => drive(decideEpicPr, epicSnap(fields), { feedback: fb, verdict: { clean: false } }).actions;
  t('a draft with no clean review starts its review try', j(unclean({}).at(-1)), j({ type: 'start-try', fix: { kind: 'review', try: 1, of: 2, head: 'abc', pr: 7 } }));
  t('a review try with no worker room waits, naming why', j(lines(unclean({ baseFixRoom: false, noRoom: 'memory: 2.0G available' }))), j(['epic PR #7: review try 1 of 2 starts once a worker may (none may this pass: memory: 2.0G available)']));
  t('a review try with no base worktree waits for it', j(lines(unclean({ baseWt: null }))), j(['epic PR #7: review try 1 of 2 waits on the base worktree']));
  const spent = [{ kind: 'review', pr: 7, head: 'h1' }, { kind: 'review', pr: 7, head: 'h2' }];
  t('spent review tries wait on a live conflict fix worker', j(lines(unclean({ baseFixLive: true, bf: { running: 's1', tries: [...spent, { try: 1 }] } }))), j(['epic PR #7: its review try waits on the base conflict fix worker on feat/x']));
  t('spent review tries are the person\'s', j(lines(unclean({ bf: { running: null, tries: spent } }))),
    j(['EPIC PR: #7 stays draft: no clean review at abc after 2 review tries. Review it yourself, fix it on feat/x, or post a clean review at its head; it leaves draft once one stands there. https://x/7']));
  t('a running review try is waited on', j(lines(unclean({ baseFixLive: true, bf: { running: 's1', tries: [{ kind: 'review', pr: 7, head: 'h1', try: 1 }] } }))), j(['epic PR #7: review try 1 of 2 is at it (session s1)']));
}
{
  const out = (fields, answers) => lines(drive(decideEpicPr, epicSnap({ epicPr: { pr: 7, state: 'OPEN', isDraft: false, head: 'abc' }, ...fields }), answers).actions);
  t('out of draft with no merge driver to merge it, it is the person\'s', j(out({}, { merger: { driver: false, rows: '§3 pr-merge-green is "no"' } })),
    j(['EPIC PR: #7 is out of draft, but no merge driver merges it (§3 pr-merge-green is "no"): merge it yourself once it is green, pinned to its head (gh pr merge 7 --repo o/r --match-head-commit <sha>). https://x/7']));
  t('out of draft and green-to-merge, the merge driver merges it', j(out({}, { merger: { driver: true }, 'driver-running': true })), j(['epic PR #7: out of draft; the merge driver merges it once it is green']));
  t('out of draft with no merge driver running, it is said', j(out({}, { merger: { driver: true }, 'driver-running': false })),
    j(['EPIC PR: #7 is out of draft, and no merge driver is running to merge it: start one, or merge it yourself once it is green. https://x/7']));
  t('a merge the driver holds is said', j(out({ promotion: { pr: 7, url: 'https://x/7', merge_blocked: 'a merge hold' } }, { merger: { driver: true } })), j(['EPIC PR: #7 is out of draft, but the merge driver holds it: a merge hold. https://x/7']));
}

// What the epic PR waits on.
{
  const q = { epic: 'DS-1', base: 'feat/x', tickets: { A: kid('A', { merged_at: '2026-11-18T10:00:00Z' }) }, promotion: { pr: 7 } };
  const st = (qx, o = {}) => epicState(qx, { base: 'feat/x', defaultBranch: 'main', epicPr: { pr: 7, state: 'OPEN', isDraft: true }, ...o });
  t('an epic PR in draft waits for a clean review', st(q), 'epic PR #7, in draft until a clean review stands at its head');
  t('another batch\'s epic PR is named as that batch\'s', st(q, { own: false }), 'epic PR #7, which batch DS-1 lands');
  t('an epic PR opened this pass', st(q, { epicPr: null }), 'epic PR #7, opened as a draft this pass');
  t('children still to merge', st({ ...q, tickets: { A: { key: 'A', state: 'running' } } }), 'no epic PR until A merges into feat/x');
  t('a merged epic PR', st({ ...q, tickets: { A: { key: 'A', state: 'running' } }, promotion: { pr: 7, merged_at: 'x' } }), 'epic PR #7 merged into main');
}

// ---- the epics read ---------------------------------------------------------------
{
  const s = { onJira: true, tickets: { A: { key: 'A', state: 'running' }, B: { key: 'B', state: 'done' }, C: { key: 'C', state: 'queued' }, D: { key: 'D', state: 'queued' } },
    tracker: { A: true, B: true, C: true }, triage: { A: { links: [] }, B: { links: [] }, C: { epic: null }, D: { links: [] } } };
  const { actions } = drive(decideEpicReads, s, { 'read-epics': { ok: true, out: '[facts] A epic NOT READ: HTTP 500' } });
  t('only an unfinished tracker ticket whose record has no epic is read', j(actions[0]), j({ type: 'read-epics', keys: ['A'] }));
  t('the line names what was not read', actions[1].line, 'epics: read for 0 of 1 triage record(s) written before epics were recorded — not read, tried again next pass: A epic NOT READ: HTTP 500');
  t('off Jira nothing is read', j(drive(decideEpicReads, { ...s, onJira: false }).actions), '[]');
}

// AC5: every decision starts no process, calls no git, gh or Jira, and writes nothing, the queue included.
{
  const { out, threw, calls } = withNoIo(() => [
    [...decidePromotion(promo())],
    drive(decidePromotion, promo({ promotion: { pr: 5 } }), { 'promotion-merge': { state: 'MERGED', mergedAt: '2026-11-18T11:00:00Z' } }).actions,
    drive(decideLedger, ledger(), { 'write-ledger': { ok: true, action: 'edited' } }).actions,
    drive(decideEpicPr, epicSnap(), { feedback: { head: 'abc' }, verdict: { clean: false } }).actions,
    drive(decideEpicReads, { onJira: true, tickets: { A: { key: 'A', state: 'running' } }, tracker: { A: true }, triage: { A: {} } }, { 'read-epics': { ok: true, out: '' } }).actions,
  ]);
  t('AC5 the decisions return their actions', j(out?.map((as) => as.at(-1)?.type)), '["open-draft-promotion","open-draft-promotion","set-batch","start-try","epic-line"]');
  t('AC5 and start no process and write no file on the way', j([threw, calls]), '[null,[]]');
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
