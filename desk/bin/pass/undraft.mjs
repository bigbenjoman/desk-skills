// The "reopen" and "undraft" steps of a pass, as decisions: a PR whose required checks never reported
// is closed and reopened, a child naming a migration its base renumbered goes to a worker, each done
// ticket's draft PR leaves draft under Stage 7's own rules (../undraft.mjs undraftCall) or is sent to a
// worker or the person, and a person's own undraft releases their hold.
//
// Each decision is a generator (pass/run-phase.mjs runSteps). A read the pass makes itself (a gh call,
// a git fetch) and a write whose result the decision goes on to use is an action it yields, and what
// the action's handler returns is what its yield gives back, so every read and write runs at the point
// the decision reaches it, in order. The calls in ../undraft.mjs and ../fix-tries.mjs that this decides
// with read lazily, through the functions they are given: those come in the snapshot's `reads`, which
// pass.mjs fills with its gh and git readers and a unit suite with stubs. The decision itself starts no
// process and writes nothing. The handlers that do I/O are pass.mjs's.
//
// Actions, beside the shared `set` and `report` ({ type, key, ... }; "->" is what the handler returns):
//   out {line}                         a report line
//   set-batch {fields}                 a batch-level queue write
//   pr-close {key, pr}                 -> { ok, out } (gh pr close)
//   pr-reopen {key, pr}                -> { ok, out } (gh pr reopen)
//   fetch {key, branch}                -> whether origin's default branch and the branch were fetched
//   child-renames {key, head}          -> the migrations the base renumbered under the head
//   events {key, t, pr}                -> { hold } as personHold gives it, or { unread } with why the PR's events could not say
//   apply-fix {key, t, pr, head, fix}  carry out a fix-tries answer (pass.mjs applyFix)
//   take {key, list, entry}            take the entry out of the pass's drafts or undrafted list
//   pr-view {key, pr}                  -> the draft's gh pr view, or null unread
//   gate-hold {key, t, s, on}          record, or clear, the reviewer check's hold (pass.mjs markGateHold)
//   pr-files {key, pr, head}           -> the files the PR changes at head, or null unread
//   conflict-files {key, branch}       -> the files the PR conflicts on, or null
//   base-at {key, head}                -> { base_sha, merge_base } for the head, or null unread
//   upload {key, t, pr, dir}           put dir's screenshots in the PR's body
//   rerun-draft {key, t, pr, head, c}  re-run a draft's cancelled or timed-out runs (rerun.sh)
//   cancel|build|rebuilt|evidence {key, t, pr, head, c, rec}   -> the undraft record after it
//   ready {key, pr}                    -> { ok, out } (gh pr ready)
//   comment {key, pr, body}            -> { ok, out } (gh pr comment)
//   carried {key, pr, head}            record that the carry was said at this head
//   note {line}                        a batch-notes line
//   undraft-error {line}               a gh pr ready that failed, for the pass record
//   evidence-failures {items}          settle the drafts whose evidence run failed, together
import { undraftCall, undraftComment, personHold } from '../undraft.mjs';
import { reviewFix, conflictFix, syncFix, renamesFix, reviewTry, draftChecksFix, draftGateTry, captureTry } from '../fix-tries.mjs';
import { latestPerCheck, normaliseRollup } from '../gate.mjs';
import { dragCells } from '../evidence.mjs';
import { set, say } from './shared.mjs';

const out = (line) => ({ type: 'out', line });
const waiting = (line) => say(null, 'waiting', line);
const lastLine = (o) => String(o ?? '').split('\n').pop();
const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;

// The undraft calls that act on a draft: undraft it, re-run or build its checks, or send it to a review
// or fix worker. A person's hold stops every one of them, so each is checked against the PR's events.
const UNDRAFT_ACTS =['ready', 'findings', 'checks', 'review', 'conflict', 'sync', 'rerun', 'cancel', 'build', 'rebuilt', 'evidence', 'evidence-failed', 'capture', 'upload'];

// The queue write that keeps a draft's undraft record `rec` on ticket t, or null when the record already
// says it (its `at` aside) or on a dry run.
export function undraftWrite(t, rec, { dry, at: now }) {
  const was = t.undraft ?? {};
  // unknown_since too, so a record from before it was kept gains one on its first pass with no answer.
  if (dry || !['call', 'why', 'action', 'sha', 'carried_from', 'pr', 'unknown_since'].some((k) => (was[k] ?? null) !== (rec[k] ?? null))) return null;
  // at: when this call began on this PR, kept while both stay the same, so a person's step is aged from
  // when it became theirs, not from each pass that rewords it.
  const at = was.call === rec.call && (was.pr ?? null) === (rec.pr ?? null) ? was.at ?? now : now;
  return set(t.key, `undraft=${JSON.stringify({ ...rec, at })}`);
}

// ---- reopen --------------------------------------------------------------
// A PR whose required checks never reported, though its base's copy of the workflow now runs them (the
// base gained the trigger after the PR's last pull_request event), gets a run only from a new event:
// it is closed and reopened, once per base head. The batch keeps that head as `reopened_at`, so a PR
// still unreported after its reopen goes to the person rather than round again. Each ticket owes its
// reopen (`reopening`, its PR) from before the close until the reopen lands, so one whose close or
// reopen failed is tried again next pass, at any base head, and a closed one is read again till then.
//
// The snapshot: { reopens: [{ t, s, owed }] (the PR-status read's list), reopenedAt (the batch's
// reopened_at), dry, repo }.
export function* decideReopen(snap) {
  const toReopen = snap.reopens.filter(({ s, owed }) => owed || String(s.base_head) !== String(snap.reopenedAt ?? ''));
  if (!toReopen.length) return;
  if (snap.dry) { yield out(`reopen (dry run): would close and reopen ${toReopen.map(({ t, s }) => `PR #${s.pr} (${t.key})`).join(', ')} so their CI runs`); return; }
  const done = [];
  for (const { t, s, owed } of toReopen) {
    const n = String(s.pr);
    if (!owed) yield set(t.key, `reopening=${n}`);
    const closed = s.state === 'CLOSED' ? { ok: true } : yield { type: 'pr-close', key: t.key, pr: n };
    const r = closed.ok ? yield { type: 'pr-reopen', key: t.key, pr: n } : closed;
    if (r.ok) {
      // Until the next pass reads it, desk-q shows it reopened rather than its unreported checks.
      yield set(t.key, 'reopening=null', 'pr_status.state=OPEN', 'pr_status.reopened=true');
      done.push(`PR #${n} (${t.key})`);
      continue;
    }
    yield waiting(closed.ok
      ? `reopen: PR #${n} (${t.key}) is closed, to start its CI, and did not reopen (${lastLine(r.out)}); the next pass tries again, or: gh pr reopen ${n} --repo ${snap.repo}`
      : `reopen: PR #${n} (${t.key}) could not be closed to start its CI (${lastLine(r.out)}); the next pass tries again`);
  }
  if (done.length) yield out(`reopen: closed and reopened ${done.join(', ')}, whose required checks never reported though ${toReopen[0].s.base}'s workflow now runs them, so their CI runs`);
  const head = toReopen.map(({ s }) => s.base_head).filter(Boolean).at(-1);
  if (head) yield { type: 'set-batch', fields: [`reopened_at=${head}`] };
}

// ---- migration renames ---------------------------------------------------
// A child naming a migration its base renumbered goes to a worker before any other fix try is read, so
// it comes out of this pass's lists. A conflict is left to the conflict tries, which merge the base.
//
// The snapshot: { drafts, undrafted (the PR-status read's lists of { t, s }), base (the default branch) }.
export function* decideRenames(snap) {
  for (const list of ['drafts', 'undrafted']) {
    for (const entry of [...snap[list]]) {
      const { t, s } = entry;
      if (!t.branch || !s.head || s.mergeable === 'CONFLICTING' || s.mergeState === 'DIRTY') continue;
      if (!(yield { type: 'fetch', key: t.key, branch: t.branch })) continue;
      const renames = yield { type: 'child-renames', key: t.key, head: s.head };
      const c = renamesFix(t, { pr: s.pr, head: s.head, base: snap.base, renames, draft: list === 'drafts' });
      if (!c) continue;
      if (list === 'drafts') {
        const held = personHold(t, s.pr) ? { hold: true } : yield { type: 'events', key: t.key, t, pr: s.pr };
        if (held.unread != null || held.hold) continue;
      }
      yield { type: 'apply-fix', key: t.key, t, pr: s.pr, head: s.head, fix: c };
      yield { type: 'take', key: t.key, list, entry };
    }
  }
}

// ---- undraft -------------------------------------------------------------
// Each done ticket's draft PR leaves draft under Stage 7's own rules (../undraft.mjs), whoever runs the
// pass, so a supervised batch does not stall on its first draft. One it may not undraft is recorded
// on the ticket as `undraft` and put to the person, unless a worker can take it on (fix-tries.mjs):
// P0s and P1s in its review, a red check, a head with no verdict to read, or a merge conflict §3
// pr-conflict-unreviewed or -reviewed lets a worker resolve. A gh pr ready that fails is kept in the
// pass record and tried again next pass, since the PR is still a draft.
//
// The snapshot:
//   drafts        the PR-status read's draft PRs, [{ t, s }], less those the renames step took
//   spine         the batch's spine key (a spine's draft is not undrafted here)
//   dry, at       a dry run; the pass's time, for the undraft record
//   repo, base    §0 GitHub repo; the default branch
//   cfg           undraftCall's configuration values: perm, permKey, approved, rerun, localReview,
//                 clean, judgement, conflictUnreviewed, conflictReviewed, handle, required, advisory,
//                 stateChecks, builds, evidence, upload
//   gates         { required, advisory } (gateLists), for the protected-files try
//   evidenceErrors, buildErrors   why §4 Evidence workflow and §4 Check builds do not parse, or null
//   fixRowErrors  the rows the fix tries read that do not parse (none parse: no checks fix this pass)
//   clearsRows    what a person clears, as fix-tries.mjs splitFailing reads it
//   failureClass  whether the failure-class lever is on
//   gatedByReviewer(s)   whether a failing reviewer check holds the PR red only on its review gate
//   reviewerMismatch     whether the reviewer check fails only because its gate counts another account
//   reads         the readers undraftCall and the fix tries call as they need them (pass.mjs's):
//                 untriggered, runOf, fault, stale (undraftCall's), baseMoves(t, head) -> { carry,
//                 scope, baseMerge, behind }, driver(n, head) (the merge driver's rerun record),
//                 built(n, head), evidenceRun(n, head), missingShots(body, t) (the files body's cells
//                 name that t's screenshot directory does not hold), shotDir(t), baseReads(head),
//                 reviewComments(id) -> { comments } or { comments: null, error },
//                 waived(n, head, checks, names) (the merge driver waives these red checks: pass.mjs waivedAt)
export function* decideUndraft(snap) {
  const { cfg, reads } = snap;
  if (!snap.drafts.length) return;
  if (snap.evidenceErrors) yield out(`undraft: no evidence runs this pass, since config §4 Evidence workflow does not parse: ${snap.evidenceErrors.join(', ')} (want \`<workflow>.yml\` or \`none\`). Run /desk-setup`);
  if (snap.buildErrors?.length) yield out(`undraft: no check builds this pass, since config §4 Check builds does not parse: ${snap.buildErrors.join(', ')} (want \`<check>: <command>\`). Run /desk-setup`);
  const passCfg = { ...cfg, untriggered: reads.untriggered, runOf: reads.runOf, fault: reads.fault, stale: reads.stale };
  // Evidence runs that failed, settled together once every draft is read, so one failure is one fix.
  const evidenceFailed = [];
  for (const { t, s } of snap.drafts) {
    const n = s.pr;
    const v = yield { type: 'pr-view', key: t.key, pr: n };
    if (!v || typeof v !== 'object') { yield out(`undraft: PR #${n} (${t.key}) could not be read; the next pass tries again`); continue; }
    const head = v.headRefOid;
    const spine = t.key === snap.spine || t.spine_check != null || t.approved === true;
    // A verdict for an older head holds at this one when only clean merges of the base and empty commits came since.
    const { carry, scope, baseMerge, behind } = reads.baseMoves(t, head);
    const c = undraftCall(t, { number: n, head, base: v.baseRefName ?? null, baseHead: s.base_head ?? null, branch: v.headRefName ?? null, mergeState: v.mergeStateStatus, mergeable: v.mergeable, body: v.body, reviews: v.reviews, comments: v.comments, checks: latestPerCheck(normaliseRollup(v.statusCheckRollup)), carry, scope },
      { ...passCfg, passAt: snap.at, spine, ...reads.driver(n, head), built: (h) => reads.built(n, h), behind, evidenceRun: (h) => reads.evidenceRun(n, h), missingShots: (body) => reads.missingShots(body, t), shotDir: reads.shotDir(t),
        waived: (names) => s.head === head && !!reads.waived?.(n, head, s.checks, names) });
    if (!c) continue;
    // A person who put it back to draft holds it, whatever the call: no undraft, no rerun or check
    // build, and no review or fix worker. The events are read only where the record cannot settle it
    // and the call would act.
    // A red check asking an approval for protected files goes to a protected-files try first, as out of
    // draft, where the draft would otherwise go to a fix worker or the person over its checks. That try
    // acts on the draft whatever the call, so it too is checked against the PR's events.
    const gateFix = ['checks', 'person'].includes(c.call) && s.head === head ? draftGateTry(t, s, { ...snap.gates, stateChecks: cfg.stateChecks }) : null;
    let hold = personHold(t, n);
    if (!hold && (UNDRAFT_ACTS.includes(c.call) || gateFix)) {
      const ev = yield { type: 'events', key: t.key, t, pr: n };
      if (ev.unread != null) { yield out(`undraft: PR #${n} (${t.key}) stays draft for now: its events, which say whether a person put it back to draft, could not be read (${ev.unread}); the next pass tries again`); continue; }
      hold = ev.hold;
    }
    let rec = hold ? { call: 'held', why: hold.why, action: hold.action, sha: head ?? null, carried_from: null, pr: n }
      : { call: c.call, why: c.why ?? null, action: c.action ?? null, sha: head ?? null, carried_from: c.carried ?? null, pr: n, ...(c.unknown_since ? { unknown_since: c.unknown_since } : {}) };
    // Red only on a verdict state check while the reviewer check fails: no review or checks fix worker,
    // as out of draft. A review at the head with findings is not held: the hold is for a review that is
    // missing or stale, and those findings are the fix worker's whatever the reviewer check says.
    const held = !hold && ['review', 'checks'].includes(c.call) && s.head === head && snap.gatedByReviewer(s);
    yield { type: 'gate-hold', key: t.key, t, s, on: held };
    // Unless the check fails only because the gate counts another account: the merge driver still
    // counts desk's verdict, so a head with none that holds still gets its review while the gate is red.
    const gated = held && !(c.call === 'review' && snap.reviewerMismatch);
    // A P0 or P1 in the review at its head, or under §3 autopilot-judgement yes a gap, goes back to a
    // fix worker, which reviews its new head again.
    // An interactive desk-review posts its P0s and P1s inline: unread, they leave only the body's.
    const unreadComments = [];
    const comments = () => {
      const r = reads.reviewComments(c.reviewId);
      if (r.error) unreadComments.push(out(`undraft: PR #${n} (${t.key}): its review's inline comments could not be read (${r.error}), so only its body's findings count`));
      return r.comments;
    };
    // A red required check goes to a fix worker, and a head with no verdict to read to a review worker.
    let rf = null;
    if (hold || gated) rf = null;
    else if (gateFix) rf = gateFix;
    else if (c.call === 'findings') {
      const tri = reads.scope?.(t.key) ?? {};
      rf = reviewFix(t, { pr: n, head, verdict: c.verdict, body: c.review, comments }, { judgement: cfg.judgement, files: () => reads.prFiles?.(n, head) ?? null, scope: tri.files, title: tri.title });
    }
    else if (c.call === 'checks' && !snap.fixRowErrors.length) {
      const ctx = { repo: snap.repo, base: snap.base, ...snap.clearsRows, stateChecks: cfg.stateChecks, builds: [], ...reads.baseReads(head) };
      const driver = reads.driver(n, head);
      const changed = yield { type: 'pr-files', key: t.key, pr: n, head };
      rf = draftChecksFix(t, { pr: n, head, failing: [...c.failing, ...(c.state ?? [])], checks: s.checks }, { ...ctx, classRerun: { perm: cfg.rerun, ...driver, classes: snap.failureClass, changed } });
    } else if (c.call === 'review') rf = reviewTry(t, { pr: n, head, why: c.why, base: snap.base, baseMerge, targeted: c.targeted });
    else if (c.call === 'conflict') {
      const files = yield { type: 'conflict-files', key: t.key, branch: t.branch };
      const baseAt = yield { type: 'base-at', key: t.key, head };
      rf = conflictFix(t, { pr: n, head, base: snap.base, files, baseAt });
    }
    // A check build that failed behind the base goes to a worker that merges it.
    else if (c.call === 'sync') rf = syncFix(t, { pr: n, head, base: c.base, why: c.why });
    // Screenshots nobody took go to a capture worker, once per PR.
    else if (c.call === 'capture') rf = captureTry(t, { pr: n, head, files: c.files });
    yield* unreadComments;
    // A stuck reason holds only while the call at this head still gives one: with no fix answer here,
    // whatever it was stuck on was fixed by hand, and the undraft call says what holds it now (red
    // checks unread for a config error are not that). Held by a person, only a conflict they resolved
    // or screenshots they put in are known to be gone.
    const stale = hold ? (c.call !== 'conflict' && /^still in conflict/.test(t.stuck?.why ?? '')) || (c.call !== 'capture' && /still not taken after a capture try/.test(t.stuck?.why ?? ''))
      : !rf && !(c.call === 'checks' && snap.fixRowErrors.length);
    if (t.stuck && stale && !snap.dry) yield set(t.key, 'stuck=null');
    const carried = !c.carried ? ''
      : c.range ? `; its review verdict is carried from ${String(c.carried).slice(0, 12)}, as its own diff is unchanged and ${snap.base}'s range ${c.range} changed none of the files the review rests on`
        : `; its review verdict is carried from ${String(c.carried).slice(0, 12)}, as only clean merges of ${snap.base} and empty commits came since`;
    const act = (type) => ({ type, key: t.key, t, pr: n, head, c, rec });
    if (hold) yield waiting(`${t.key}: HELD — PR #${n} stays draft: ${hold.why}. ${cap(hold.action)} (gh pr ready ${n} --repo ${snap.repo})`);
    else if (rf) {
      yield { type: 'apply-fix', key: t.key, t, pr: n, head, fix: rf };
      if (rf.call === 'rerun' || rf.call === 'wait') rec = { ...rec, call: rf.call, why: rf.why, action: null };
    }
    else if (gated) { /* the gate-hold action reported it */ }
    else if (c.call === 'wait') yield out(`undraft: PR #${n} (${t.key}) stays draft for now: ${c.why}`);
    else if (c.call === 'upload' && snap.dry) yield out(`undraft (dry run): would upload ${c.dir} to PR #${n} (${t.key}): ${c.why}`);
    else if (c.call === 'upload') {
      yield out(`undraft: PR #${n} (${t.key}) stays draft for now: ${c.why}`);
      yield { type: 'upload', key: t.key, t, pr: String(n), dir: c.dir };
    }
    else if (c.call === 'rerun' && snap.dry) yield out(`undraft (dry run): would re-run run(s) ${c.runs.join(', ')} on PR #${n} (${t.key}): ${c.why}`);
    else if (c.call === 'rerun') yield { type: 'rerun-draft', key: t.key, t, pr: n, head, c };
    else if (['cancel', 'build', 'rebuilt', 'evidence'].includes(c.call)) rec = yield act(c.call);
    else if (c.call === 'evidence-failed') { evidenceFailed.push({ t, n, head, c, rec, cells: dragCells(v.body) }); continue; }
    else if (['person', 'findings', 'checks', 'review', 'conflict', 'sync', 'capture'].includes(c.call)) yield waiting(`${t.key}: DRAFT — PR #${n} stays draft: ${c.why}${carried}. ${cap(c.action)}`);
    else if (snap.dry) yield out(`undraft (dry run): would mark PR #${n} (${t.key}) ready at ${String(head).slice(0, 12)}${carried}`);
    else {
      const r = yield { type: 'ready', key: t.key, pr: n };
      if (r.ok) {
        yield out(`undrafted: PR #${n} (${t.key}) at ${String(head).slice(0, 12)}${carried}; the merge driver merges it once it is green`);
        const said = yield { type: 'comment', key: t.key, pr: n, body: undraftComment(c.verdict, head, cfg.clean, c.carried, c.range) };
        if (!said.ok) yield out(`undraft: PR #${n} (${t.key}) left draft, but its comment was not posted (${lastLine(said.out)})`);
        // Said here, the merge driver need not say the carry again at this head.
        else if (c.range) yield { type: 'carried', key: t.key, pr: n, head };
        if (c.note) yield { type: 'note', line: c.note };
      } else {
        const why = lastLine(r.out);
        yield { type: 'undraft-error', line: `${t.key}: gh pr ready ${n} failed: ${why}` };
        yield out(`undraft: PR #${n} (${t.key}) could not leave draft (${why}); the next pass tries again`);
        rec = { ...rec, call: 'failed', why };
      }
    }
    const w = undraftWrite(t, rec, snap);
    if (w) yield w;
  }
  if (evidenceFailed.length) yield { type: 'evidence-failures', items: evidenceFailed };
}

// ---- person undraft release ------------------------------------------------
// The person's own undraft releases their hold: recorded as out of draft, so putting it back holds it again.
//
// The snapshot: { undrafted (the PR-status read's ready PRs, [{ t, s }]), dry, at }.
export function* decideRelease(snap) {
  for (const { t, s } of snap.undrafted) {
    if (t.undraft?.call !== 'held' || (t.undraft.pr != null && t.undraft.pr !== s.pr)) continue;
    yield out(`released: PR #${s.pr} (${t.key}) was undrafted by a person; the merge driver merges it once it is green`);
    if (!snap.dry) yield set(t.key, `undraft=${JSON.stringify({ call: 'ready', why: 'a person undrafted it', action: null, sha: s.head, pr: s.pr, at: snap.at })}`);
  }
}
