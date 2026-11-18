// How a batch's work reaches the default branch, as decisions: the promotion PR a feature batch opens
// (and the next one after each merges), the epic PR an epic batch opens, takes out of draft and hands to
// the merge driver, the promotion ledger comment, and the epics read for triage records that lack one.
//
// Each section runs at its own point in the pass, so each has its own decision, a generator run by
// pass/run-phase.mjs runSteps: a read only some cases make (a gh call, a review) and a write whose result
// the decision goes on to use is an action it yields, and what the handler returns is what the yield
// gives back. The decisions start no process and write nothing; the handlers that do are pass.mjs's.
//
// Actions, beside the shared `set` and `report` ({ type, ... }; "->" is what the handler returns):
//   set-batch {fields}                  a batch-level queue write (queue.mjs set-batch)
//   base-line {line}                    a line of the batch base's report
//   out {line}                          a line of the pass's report
//   open-draft-promotion {carry, title} open the promotion or epic PR as a draft, recording `carry` with it
//   promotion-merge {pr}                -> { state, mergedAt } as gh has the PR, or null unread
//   feedback {pr}                       -> the epic PR's review payload { head, payload }, or null unread
//   verdict {fb}                        -> the review verdict at its head (review-threads.mjs readVerdict)
//   ready {pr}                          -> { ok, out } from taking the PR out of draft
//   start-try {fix}                     start the epic PR's review try in the base worktree
//   write-ledger {pr, ledger}           -> syncLedger's answer: { ok, action } or { ok: false, why }
//   read-epics {keys}                   -> { ok, out } from ticket-facts.mjs --epic
//   epic-line {line}                    a line of the epics report
import { lastPromotion } from '../batches.mjs';
import { epicCarry, epicChildren, childDone, epicDue } from '../batch-state.mjs';
import { epicReviewCall, FIX_TRIES_MAX } from '../base-fix.mjs';
import { promotionHolds } from '../gate.mjs';
import { ledgerHash } from '../ledger.mjs';
import { epicUnread } from '../desk-q-eta.mjs';

const prLink = (repo, n) => `https://github.com/${repo}/pull/${n}`;

// ---- promotion PR ----------------------------------------------------------
// At the batch base, once its worktree is ready and no fix worker owns it. A feature-mode batch opens
// its promotion PR as a draft on its first pass and records it, or why not, as `promotion`, so a refusal
// is not tried again; once one merges with children still to come, the next opens. An epic batch opens
// its epic PR once every child has merged into the base, and tries again each pass until one is open.
//
// The snapshot:
//   promotion   the queue's `promotion` record, as the base section read it, or null
//   tickets     the queue's tickets, by key, as the base section read them
//   ready       the base worktree is ready and no fix worker owns it
//   featureMode the batch runs in feature mode with a base
//   epicOn      an epic batch not in feature mode
//   epicDue     every epic child has merged into the base (batch-state.mjs epicDue)
//   gateBusy    the base gate is running
//   epic        the batch's epic key, or null
//   base        the batch base branch;  source  the default branch it lands on
//   dry         a dry run
//   now         the time, in ms
export function* decidePromotion(s) {
  if (!s.ready) return;
  const p = s.promotion;
  if (s.featureMode && p == null) yield* opening(s);
  else if (s.featureMode && p?.pr != null && !s.gateBusy) yield* nextPromotion(s, p);
  // Each one opened after an earlier merged keeps that merge as `since`, and every earlier merge in
  // `merged`, through a retry too: needs-you ages a child's follow-on steps from the epic PR that
  // promoted it (needs-you.mjs outAt), so a reopen must not drop one.
  if (s.epicOn && s.epicDue && (p?.pr == null || p.merged_at)) yield* opening(s, epicCarry(p));
}

// The promotion or epic PR's title.
export const promotionTitle = (epic, base, source, slice) => `${epic ?? 'Feature'}: promote ${base} to ${source}${slice ? ` (slice ${slice})` : ''}`;

function* opening(s, carry = {}) {
  const title = promotionTitle(s.epic, s.base, s.source, carry.slice);
  if (s.dry) { yield baseLine(`promotion PR (dry run): would open ${s.base} → ${s.source} as a draft, titled "${title}"`); return; }
  yield { type: 'open-draft-promotion', carry, title };
}

// A promotion PR that merged into the default branch while children are still to merge into the base
// is followed by the next one, opened as the first was, and the count toward the next slice starts
// from that merge. The ledger comment is written afresh on the new PR by the next ledger update.
function* nextPromotion(s, p) {
  if ((p.merged ?? []).some((m) => m.pr === p.pr)) return;
  const v = yield { type: 'promotion-merge', pr: p.pr };
  if (v?.state !== 'MERGED') return;
  const slice = p.slice ?? 1;
  const merged = [...(p.merged ?? []), { pr: p.pr, slice, merged_at: v.mergedAt ?? null }];
  if (lastPromotion(s.tickets, v.mergedAt)) {
    if (!s.dry) yield setBatch(`promotion.merged=${JSON.stringify(merged)}`);
    return;
  }
  yield baseLine(`promotion PR #${p.pr} (slice ${slice}) merged into ${s.source}`);
  if (s.dry) { yield baseLine(`promotion PR (dry run): would open the next one, ${s.base} → ${s.source}`); return; }
  yield setBatch('gate=null');
  yield* opening(s, { slice: slice + 1, since: v.mergedAt ?? new Date(s.now).toISOString(), merged });
}

// ---- epics ---------------------------------------------------------------
// A triage record written before ticket-facts.mjs recorded `epic` has no such key, and a ticket
// already triaged is not triaged again, so desk-q would read it as having no epic for good. Read the
// epic alone for each unfinished one (ticket-facts.mjs --epic); a record whose `epic` is null was
// looked up and has none, and is left alone. A read that fails is tried again next pass.
//
// The snapshot:
//   onJira    the repo's tracker is Jira
//   tickets   the queue's tickets, by key
//   tracker   { key: true } for each ticket whose key is a tracker key
//   triage    { key: its triage record } for each one whose record could be read
export function* decideEpicReads(s) {
  if (!s.onJira) return;
  const keys = Object.values(s.tickets).filter((t) => t.state !== 'done' && s.tracker[t.key] && epicUnread(s.triage[t.key] ?? null)).map((t) => t.key);
  if (!keys.length) return;
  const r = yield { type: 'read-epics', keys };
  const missed = r.out.split('\n').filter((l) => / epic NOT READ: /.test(l));
  yield {
    type: 'epic-line',
    line: `epics: read for ${keys.length - missed.length} of ${keys.length} triage record(s) written before epics were recorded`
      + (missed.length ? ` — not read, tried again next pass: ${missed.map((l) => l.replace(/^\[facts\]\s*/, '')).join(' | ')}` : r.ok ? '' : ` — ${r.out.split('\n').pop()}`),
  };
}

// ---- epic PR ---------------------------------------------------------------
// An epic batch not in feature mode lands its base through the epic PR the base section opens once
// every child has merged into the base. It leaves draft once a clean review stands at its head, which a
// review try in the base worktree posts (epicReviewCall), and the merge driver merges it once it is
// green, as it merges a child. Whatever only the person can clear (no PR, a closed one, no review after
// its tries, no merge driver, a merge hold) is put to them: nothing else would reach it.

// What the epic PR is waiting on, in a line. `own` false: another batch's epic, read from its queue
// alone. `epicPr` is this batch's epic PR as the pass read it (pass.mjs readEpicPr).
export function epicState(qx, { own = true, base, defaultBranch, epicPr }) {
  const p = qx.promotion ?? {};
  const b = own ? base : qx.base;
  if (!epicDue(qx)) {
    if (p.merged_at) return `epic PR #${p.pr} merged into ${defaultBranch}`;
    const left = epicChildren(qx).filter((t) => !childDone(t)).map((t) => t.key);
    return `no epic PR until ${left.join(', ') || 'every child'} merge${left.length === 1 ? 's' : ''} into ${b}`;
  }
  if (p.pr == null) return `no epic PR: ${p.why ?? `not opened yet from ${b}`}`;
  if (!own) return `epic PR #${p.pr}, which batch ${qx.epic} lands`;
  if (!epicPr) return `epic PR #${p.pr}, opened as a draft this pass`;
  if (epicPr.state !== 'OPEN') return `epic PR #${p.pr}, ${epicPr?.unreadable ? 'which could not be read' : String(epicPr?.state ?? 'unread').toLowerCase()}`;
  return `epic PR #${p.pr}, ${epicPr.isDraft ? 'in draft until a clean review stands at its head' : 'out of draft, merged by the merge driver once green'}`;
}

// Whether the epic PR step has work this pass: true for an epic batch whose children have all merged.
export const epicPending = (s) => !!s.epicOn && !!s.due;

// The snapshot:
//   epicOn       an epic batch not in feature mode;  due  epicDue of the queue
//   promotion    the queue's `promotion` record, or null
//   tickets      the queue's tickets, by key
//   epicPr       the epic PR as readEpicPr read it, or null
//   bf           the batch's base_fix record, or null;  baseFixLive  its worker is live
//   baseFix      a conflict fix starts in the base worktree this pass
//   baseFixRoom  a base worker may start this pass;  noRoom  why not, when it may not
//   baseWt       the base worktree's path, or null
//   readyPerm    config §3 pr-ready;  readyKey  its config key
//   base, source, repo, dry
// Not due, the snapshot need hold only epicOn and due. Its reads, beside the module's list:
//   merger                 -> spine-check.mjs spineMerger of the queue: { driver, rows }
//   driver-running         -> whether a merge driver holds this state directory
export function* decideEpicPr(s) {
  if (!epicPending(s)) return;
  const p = s.promotion ?? {};
  const { epicPr, base, source, repo } = s;
  if (p.pr == null || !epicPr) return;
  const n = p.pr;
  const link = p.url ?? prLink(repo, n);
  if (epicPr.unreadable) { yield out(`epic PR #${n}: could not be read; the next pass tries again`); return; }
  if (epicPr.state === 'CLOSED') {
    yield waiting(`EPIC PR: #${n} (${base} → ${source}) was closed without merging, so nothing lands on ${source}: reopen it, or open a new one with queue.mjs set-batch promotion=null. ${link}`);
    return;
  }
  if (epicPr.isDraft) {
    const fb = yield { type: 'feedback', pr: n };
    if (!fb) { yield out(`epic PR #${n}: its review could not be read; the next pass tries again`); return; }
    const v = yield { type: 'verdict', fb };
    if (v?.clean) {
      if (s.readyPerm !== 'yes') { yield waiting(`EPIC PR: #${n} has a clean review at its head, but config §3 ${s.readyKey} is "${s.readyPerm}": mark it ready (gh pr ready ${n} --repo ${repo}). ${link}`); return; }
      if (s.dry) { yield out(`epic PR #${n} (dry run): would mark it ready, its review clean at its head`); return; }
      const r = yield { type: 'ready', pr: n };
      if (!r.ok) { yield waiting(`EPIC PR: #${n} has a clean review at its head, but gh pr ready failed (${r.out.split('\n').pop()}): mark it ready. The next pass tries again. ${link}`); return; }
      const why = v.range ? `its clean review at ${String(v.carried).slice(0, 12)} is carried to its head, not reviewed there: ${source}'s range ${v.range} changed none of the files it rests on` : 'its review is clean at its head';
      yield out(`epic PR #${n}: ${why}, so it is out of draft; the merge driver merges it once it is green`);
      return;
    }
    const c = epicReviewCall(s.bf, { pr: n, head: fb.head }, { alive: s.baseFixLive });
    if (s.baseFixLive && c.call !== 'wait') yield out(`epic PR #${n}: its review try waits on the base conflict fix worker on ${base}`);
    else if (c.call === 'wait') yield out(`epic PR #${n}: review try ${c.try?.try ?? '?'} of ${FIX_TRIES_MAX} is at it (session ${s.bf.running})`);
    else if (c.call === 'stuck') yield waiting(`EPIC PR: #${n} stays draft: ${c.why}. Review it yourself, fix it on ${base}, or post a clean review at its head; it leaves draft once one stands there. ${link}`);
    else if (!s.baseWt) yield out(`epic PR #${n}: review try ${c.fix.try} of ${c.fix.of} waits on the base worktree`);
    else if (s.baseFix || !s.baseFixRoom) yield out(`epic PR #${n}: review try ${c.fix.try} of ${c.fix.of} starts once a worker may (none may this pass: ${s.baseFix ? `the conflict fix on ${base} starts first` : s.noRoom})`);
    else yield { type: 'start-try', fix: c.fix };
    return;
  }
  // Out of draft: the merge driver's, where config §3 lets one merge and nothing holds it for the person.
  const merger = yield { type: 'merger' };
  if (!merger.driver) yield waiting(`EPIC PR: #${n} is out of draft, but no merge driver merges it (${merger.rows}): merge it yourself once it is green, pinned to its head (gh pr merge ${n} --repo ${repo} --match-head-commit <sha>). ${link}`);
  else if (p.merge_blocked) yield waiting(`EPIC PR: #${n} is out of draft, but the merge driver holds it: ${p.merge_blocked}. ${link}`);
  else if (promotionHolds(Object.values(s.tickets), p.since ?? null).length) { /* said by reportPromotionHolds */ }
  else if (!(yield { type: 'driver-running' })) yield waiting(`EPIC PR: #${n} is out of draft, and no merge driver is running to merge it: start one, or merge it yourself once it is green. ${link}`);
  else yield out(`epic PR #${n}: out of draft; the merge driver merges it once it is green`);
}

// ---- promotion ledger ------------------------------------------------------
// The promotion PR carries one comment with one row per child (ledger.mjs), rewritten whenever a row
// changes, a child merging into the base included. The PR body is never touched. A comment that cannot
// be read or written is reported and the batch carries on; nothing is recorded until a write
// succeeds, so the next pass tries again.
//
// The snapshot:
//   promotion  the queue's `promotion` record, or null
//   ledger     the ledger comment as it should read now (ledger.mjs renderLedger), with a PR to put it on
//   editPerm   config §3 pr-edit;  editKey  its config key
//   dry        a dry run
export function* decideLedger(s) {
  const n = s.promotion?.pr;
  if (n == null) return;
  const hash = ledgerHash(s.ledger);
  if (s.promotion.ledger === hash) return;
  const notUpdated = (why) => out(`promotion PR #${n}: ledger not updated, ${why}. The batch carries on; the next pass tries again`);
  if (s.dry) { yield out(`promotion PR #${n} (dry run): would rewrite its ledger comment`); return; }
  if (s.editPerm !== 'yes') { yield notUpdated(`since config §3 ${s.editKey} is "${s.editPerm}"`); return; }
  const done = yield { type: 'write-ledger', pr: n, ledger: s.ledger };
  if (!done.ok) { yield notUpdated(`since ${done.why}`); return; }
  if (done.action !== 'unchanged') yield out(`promotion PR #${n}: ledger comment ${done.action}`);
  yield setBatch(`promotion.ledger=${hash}`);
}

const setBatch = (...fields) => ({ type: 'set-batch', fields });
const baseLine = (line) => ({ type: 'base-line', line });
const out = (line) => ({ type: 'out', line });
const waiting = (line) => ({ type: 'report', list: 'waiting', line });
