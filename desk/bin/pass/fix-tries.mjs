// The "fix tries" step of a pass, as a decision. A ready PR the merge driver cannot merge, red after its
// two reruns, in conflict with its base, held for review feedback, or with a review at its head that is
// not clean, goes back to a fix worker on the same branch, at most twice (fix-tries.mjs); one whose §4
// State check reading its verdict is red, which the driver never reruns, or that it holds for want of a
// clean verdict at its head, to a review worker (verdictTry). What no worker can fix, a check a person
// clears (§4 Checks workers can't fix or Pre-merge steps, or Check builds where the pass builds none) or
// a third failure, is recorded on the ticket as `stuck` and put to the person. A §4 Check builds check
// gets its build here as a draft's does, once nothing a worker fixes is red.
//
// The decision is a generator (pass/run-phase.mjs runSteps): a read only some cases make (a PR's
// conflicting files, its reviewers, its review threads) and a write whose result it goes on to use (the
// conflict record, the threads a finished try worked, a check build's start) is an action it yields,
// and what the handler returns is what the yield gives back. fix-tries.mjs's calls read a PR's runs, its
// files and the base only where they need to, through the reads the `reads` action returns. The
// decision starts no process and writes nothing; the handlers that do are pass.mjs's.
//
// The snapshot:
//   undrafted     the pass's ready PRs this step reads: [{ t (the queue's ticket), s (the PR's status) }]
//   rowErrors     a line per config row the fix tries read that does not parse; any one makes no try
//   dry           a dry run
//   base          the default branch
//   reviewer      health.mjs's failing reviewer check ({ key, why }), or null (pass/shared.mjs reviewerGated)
//   gate          config §4 Required and Advisory checks (pass/shared.mjs gateListsOf)
//   stateChecks   config §4 State checks, parsed
//   conflictRows  { 'pr-conflict-reviewed', 'pr-conflict-unreviewed' }: each { perm, key }, its §3 value and key
//   feedbackFirst config §3 merge-feedback-first is not `no`
//   judgement     config §3 autopilot-judgement
//   outage        set here: outageChecks's map of the checks red on many ready PRs at once
//
// Actions, beside the shared `set` and `report` ({ type, key, ... }; "->" is what the handler returns):
//   out {line}                          a line of the pass's report
//   conflict-files {key, branch}        -> the files the PR conflicts on against the base, or null
//   note-conflict {key, what, entry}    -> a line for the report where the conflict record was not written, or null
//   gate-hold {key, on}                 mark, or clear, the PR's hold on the reviewer check
//   human-seen {key, pr}                -> whether anyone but the user's handle, and not a bot, reviewed or commented on it
//   reads {key, dirty, dirtyFiles}      -> the reads fix-tries.mjs's calls make, each run only when called: fixCall's
//                                          ctx, with baseMerge, moves() (the head against the base, read afresh),
//                                          comments(id) (a review's inline comments) and atHead(payload, carry, scope)
//   feedback {key, pr}                  -> the PR's review threads (review-threads.mjs readThreads, with its payload), or null
//   settle-worked {key, pr, head, worked}   -> the ids of the threads a finished feedback try worked, replied on and resolved
//   check-build {key, pr, head, call}   -> the build's record: `call` 'person' where it could not start or re-run
//   apply {key, pr, head, call}         carry out the call: stuck, requeue, held, wait or rerun
import { fixCall, gateTry, reviewFix, feedbackFix, personGapsCall, resolvable, verdictTry, externalTry, driverReviewTry, treeHeld, builtStuck, outageChecks } from '../fix-tries.mjs';
import { reviewerGated, set, say } from './shared.mjs';
import { externalReview } from '../review-threads.mjs';

const out = (line) => ({ type: 'out', line });
const waiting = (key, line) => say(key, 'waiting', line);

export function* decideFixTries(s) {
  if (s.rowErrors.length && s.undrafted.length) yield out(`fix tries: none this pass, since config ${s.rowErrors.join('; ')}. Run /desk-setup`);
  if (s.rowErrors.length) return;
  // A check red on many ready PRs at once is said once here, and each PR it holds is held (fixCall).
  const outage = outageChecks(s.undrafted, s.gate);
  for (const [name, prs] of outage) {
    yield out(`fix tries: "${name}" is red on ${prs.length} ready PRs at once (#${[...prs].sort((a, b) => a - b).join(', #')}), which reads as its platform failing, not their code: no fix try is spent on it, and nothing desk reruns turns it green; once the platform is back, redeploy there or push to the PRs`);
  }
  const snap = outage.size ? { ...s, outage } : s;
  for (const { t, s: p } of s.undrafted) yield* fixTry(t, p, snap);
}

// How the report names a try: "capture try", "extra review try", "protected files try 1 of 2".
export function tryLabel(f) {
  if (f.kind === 'capture') return 'capture try';
  if (f.extra) return `extra ${f.kind === 'rereview' ? 'review' : 'fix'} try`;
  return `${f.kind === 'rereview' ? 'review' : f.kind === 'protected' ? 'protected files' : 'fix'} try ${f.try} of ${f.of}`;
}

function* fixTry(t, p, s) {
  const n = p.pr;
  // A conflict goes to a fix worker only under the §3 row the base's conflict reads too, and so does a
  // head the merge driver held for failing §4 Merged-tree check merged into the base.
  const dirty = p.mergeable === 'CONFLICTING' || p.mergeState === 'DIRTY';
  const tree = dirty ? null : treeHeld(t, p);
  // Each file a ready PR conflicts on goes on the conflict record, whoever then resolves it.
  const dirtyFiles = dirty ? yield { type: 'conflict-files', key: t.key, branch: t.branch } : null;
  if (dirty) {
    const noted = yield { type: 'note-conflict', key: t.key, what: `PR #${n} (${t.key})`, entry: { files: dirtyFiles, ticket: t.key, pr: n, head: p.head } };
    if (noted) yield out(noted);
  }
  // Held by the reviewer check: no review, checks or feedback fix try, as on a draft. A fix's new head
  // would need a verdict the gate does not count either. A conflict or a merged-tree hold is not red
  // only on the gate, so it still goes to its own fix below.
  const gated = !dirty && !tree && reviewerGated(p, s);
  if (gated) { yield* heldTry(t, p, s); return; }
  yield { type: 'gate-hold', key: t.key, on: false };
  if (dirty || tree) {
    const row = (yield { type: 'human-seen', key: t.key, pr: n }) ? 'pr-conflict-reviewed' : 'pr-conflict-unreviewed';
    const { perm, key } = s.conflictRows[row];
    if (perm !== 'yes') {
      const what = tree ? `merged into ${s.base}, fails §4 Merged-tree check \`${tree.command}\`` : `conflicts with ${s.base}`;
      const fix = tree ? `merge ${s.base} into the PR's branch, fix what the check names, and push` : "resolve it on the PR's branch and push";
      yield waiting(t.key, `${t.key}: CONFLICT — PR #${n} is out of draft and ${what}, and config §3 ${key} is "${perm}", so no fix worker ${tree ? 'fixes' : 'resolves'} it: ${fix}`);
      return;
    }
  }
  const { ctx: read, baseMerge, ...reads } = yield { type: 'reads', key: t.key, dirty, dirtyFiles };
  const ctx = s.outage ? { ...read, outage: s.outage } : read;
  // A red check a change on the branch may clear (an unneeded protected file, a stale verdict) goes to a
  // worker before anything is put to the person.
  let c = gateTry(t, p, { ...ctx, baseMerge }) ?? fixCall(t, p, ctx) ?? (yield* feedbackCall(t, p, s, ctx.waived, reads));
  if (!c) { if (t.stuck && !s.dry) yield set(t.key, 'stuck=null'); return; }
  // Waiting on an outside reviewer leaves the person nothing to do, so an earlier stuck record goes.
  if (c.call === 'wait') {
    if (c.external && t.stuck && !s.dry) yield set(t.key, 'stuck=null');
    yield out(`fix tries: PR #${n} (${t.key}) is out of draft: ${c.why}`);
    return;
  }
  // A §4 Check builds build to start or re-run: on its own, or beside a check a person clears.
  const b = c.call === 'build' || c.call === 'rebuilt' ? c : c.build;
  if (b) {
    const r = yield { type: 'check-build', key: t.key, pr: n, head: p.head, call: b };
    // One that could not start or whose re-run was refused is the person's step, with what to run.
    const person = r?.call === 'person';
    if (b === c && !person) { if (t.stuck && !s.dry) yield set(t.key, 'stuck=null'); return; }
    if (person) {
      const beside = b === c ? null : c;
      c = { ...beside, ...builtStuck(beside?.lead ?? r.lead, b.checks, { command: r.action }, beside?.checks ?? []) };
    }
  }
  yield { type: 'apply', key: t.key, pr: n, head: p.head, call: c };
}

// A PR the reviewer check holds. The hold is for a review that is missing or stale, so a review at the
// head that is not clean, a §4 Gate reviewer's (`gate` on the read) or else desk's own, still goes to a
// review fix, or to the person for the gaps only they settle; the hold lifts only where one goes.
// Where the check fails only because the gate counts another account (kind `mismatch`), desk still
// posts its verdicts and the merge driver counts them though the gate does not, so a head the driver
// would hold for want of a clean verdict gets its review try now, while the gate is red. Nothing else
// goes to it: red checks and threads wait.
function* heldTry(t, p, s) {
  const reads = yield { type: 'reads', key: t.key, dirty: false, dirtyFiles: null };
  const fb = yield { type: 'feedback', key: t.key, pr: p.pr, gate: true };
  const atHead = !!fb && fb.head === p.head;
  const review = atHead ? fb.gateReview ?? fb.review : null;
  const worked = review ? findingsFix(t, p, s, { ...fb, review }, reads) ?? personGapsCall(review, { judgement: s.judgement }) : null;
  // The hold is recorded, and listed, only where nothing goes to the PR's findings.
  yield { type: 'gate-hold', key: t.key, on: !worked };
  if (!atHead) return;
  let c = worked;
  if (!review && s.reviewer?.kind === 'mismatch') {
    const { carry, scope, baseMerge } = reads.moves();
    const r = driverReviewTry(t, p, { atHead: () => reads.atHead(fb.payload, carry, scope), stateChecks: s.stateChecks, base: s.base, baseMerge });
    c = r?.call === 'requeue' ? r : null;
  }
  if (c) yield { type: 'apply', key: t.key, pr: p.pr, head: p.head, call: c };
}
// The review fix a ready PR's review at its head that is not clean gets (reviewFix), marked ready.
function findingsFix(t, p, s, fb, reads) {
  const comments = () => reads.comments(fb.review.id);
  const rf = reviewFix(t, { pr: p.pr, head: p.head, verdict: fb.review.verdict, body: fb.review.body, comments }, { judgement: s.judgement, outside: reads.outside, title: reads.title });
  return rf?.call === 'requeue' ? { ...rf, fix: { ...rf.fix, ready: true } } : rf;
}

// A ready PR's review, read as the merge driver reads it (review-threads.mjs): a desk-review at its
// head that is not clean goes to a review fix (reviewFix), and, where §3 merge-feedback-first holds
// the merge for them, threads left unresolved or changes requested to a feedback fix (feedbackFix).
// The threads a finished feedback try worked are replied on and resolved first, once its worker has
// pushed past them, so the next try quotes only what is still open. One GitHub would not settle holds
// any new try until a later pass settles it: a new try would replace the record of what was worked.
function* feedbackCall(t, p, s, waived, reads) {
  if (p.state !== 'OPEN' || p.isDraft !== false || !p.head) return null;
  const n = p.pr;
  const fb = yield { type: 'feedback', key: t.key, pr: n };
  if (!fb) { yield out(`fix tries: PR #${n} (${t.key}): its review threads could not be read; the next pass tries again`); return null; }
  if (fb.head !== p.head) return null;
  const open = new Set(fb.left.map((x) => x.id));
  const worked = resolvable(t, p.head).filter((x) => open.has(x.id));
  const settled = worked.length ? yield { type: 'settle-worked', key: t.key, pr: n, head: p.head, worked } : [];
  if (settled.length < worked.length && !s.dry) return null;
  const { judgement } = s;
  // A red check reading an outside reviewer's review goes ahead of desk's own review and feedback
  // routes: it waits for that reviewer at the head, then sends their findings (externalTry).
  const external = (login) => externalReview(fb.payload, login);
  const ext = externalTry(t, p, { ...s.gate, stateChecks: s.stateChecks, external });
  if (ext !== undefined) return ext;
  if (fb.review) {
    const rf = findingsFix(t, p, s, fb, reads);
    if (rf) return rf;
  }
  const ff = !s.feedbackFirst ? null
    : feedbackFix(t, { pr: n, head: p.head, decision: fb.decision, threads: fb.left.filter((x) => !settled.includes(x.id)) });
  if (ff) return ff;
  // Gaps only the person can settle wait on their call, whatever the checks or the merge grant say.
  const gaps = fb.review ? personGapsCall(fb.review, { judgement }) : null;
  if (gaps) return gaps;
  // A red verdict state check with no unclean review at the head to fix: a review worker posts one. So
  // does a green PR the driver would hold for want of a clean verdict, where a driver may merge.
  const { carry, scope, baseMerge } = reads.moves();
  const atHead = () => reads.atHead(fb.payload, carry, scope);
  return verdictTry(t, p, { ...s.gate, stateChecks: s.stateChecks, settled: !!fb.review, atHead, external, waived, base: s.base, baseMerge });
}
