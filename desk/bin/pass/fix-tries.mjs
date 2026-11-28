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
//   outage        the outage step's held checks (decideOutage, fix-tries.mjs outagePlan), or null
//   outageRerun   the PRs that step re-ran as a hold cleared: each waits for that run, with no fix try
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
//   apply {key, pr, head, call}         carry out the call: stuck, requeue, held, wait, rerun or refresh
//   external-seen {key, pr, head, login, reviewedAtHead, last}   an outside reviewer's review read on a ready PR
//   external-wait {key, pr, head, login, line}   the PR waits on that reviewer: `line` is its report line, which
//                                       the pass prints unless that reviewer reads as down (gate-reviewer.mjs)
import { prInConflict, resumeConflict, baseHeldAt, fixCall, gateTry, reviewFix, feedbackFix, personGapsCall, resolvable, settleable, verdictTry, externalTry, driverReviewTry, treeHeld, builtStuck, stuckLessHeld, outagePlan, outageGap, reviewGates, OUTAGE_PRS, OUTAGE_GAP_MAX_S } from '../fix-tries.mjs';
import { reviewerGated, set, say } from './shared.mjs';
import { OUTAGE_MS, outageWait } from './deadlines.mjs';
import { externalReview } from '../review-threads.mjs';
import { FAILED, externalPassed } from '../gate.mjs';

const out = (line) => ({ type: 'out', line });
const waiting = (key, line) => say(key, 'waiting', line);

export function* decideFixTries(s) {
  if (s.rowErrors.length && s.undrafted.length) yield out(`fix tries: none this pass, since config ${s.rowErrors.join('; ')}. Run /desk-setup`);
  if (s.rowErrors.length) return;
  // A PR the outage step re-ran this pass, its hold cleared, waits for that run rather than a fix try.
  const snap = s.outage?.size ? s : { ...s, outage: null };
  for (const { t, s: p } of s.undrafted) {
    // A ready PR whose outside reviewer's check passed at its head was reviewed there, cleanly: that
    // reviewer is reviewing, whatever PR waits on it (gate-reviewer.mjs). The check's finish is that review's time.
    const passed = p.state === 'OPEN' && p.isDraft === false && p.head ? externalPassed(p.checks, s.stateChecks) : null;
    if (passed) {
      const last = (p.checks ?? []).filter((c) => c.name === passed.name).map((c) => c.completed ?? c.completedAt).filter(Boolean).sort().at(-1) ?? null;
      yield { type: 'external-seen', key: t.key, pr: p.pr, head: p.head, login: passed.login, reviewedAtHead: true, last };
    }
    if (s.outageRerun?.includes(p.pr)) continue;
    yield* fixTry(t, p, snap);
  }
}

// ---- the outage hold ---------------------------------------------------------
// A check red with the same platform line on several open PRs at once is one outage for the batch
// (fix-tries.mjs outagePlan): said once as waiting, every PR red with it held from fix tries (fixCall,
// draftChecksFix), and re-run on one PR at a time on a back-off until a PR it held passes it, when the
// hold clears and the other PRs' runs are re-run. Runs before the undraft step, so drafts are held too.
//
// The snapshot: { prs (the pass's drafts and ready PRs, [{ t, s }]), gate, was (the hold kept from the
// last pass, or {}), now (ms), unread (a Set of the PRs whose read failed this pass: what the hold
// keeps of one stays; a PR it holds that the pass neither read nor tried to is gone), dry, rowErrors,
// recorded (the queue's `platform_outage`, or null), base (the default branch), staleOf (t, s, names)
// -> the names red only as its base was, green on the base since (fix-tries.mjs staleChecks), or absent }.
// Actions, beside `report` and `out`:
//   set-batch {fields}                        the batch's outage record (outageRecord)
//   outage-rerun {key, branch, pr, head, run, name}   -> { ok, why, wait } (gh run rerun --failed, under
//                                             §3 ci-rerun, once it has the PR's preview-build lease; `wait` where another build holds it)
//   outage-hold {hold}                        keep the hold for the next pass
//   outage-held {held, rerun}                 the checks held this pass (Map), and the PRs re-run as it
//                                             cleared, or still owed a re-run (their run still going,
//                                             or waiting on the preview build)
// A PR's checks its base red hold names at its head (held or cleared), and, where s.staleOf reads them
// (§3 pr-update-branch yes), those red on its base where it branched and green on the base since
// (fix-tries.mjs staleChecks), are red because its base was, not because a platform fails: the outage
// reads the PR without them, so they neither start, join nor re-run a hold, and its fix tries update
// its branch from the base (staleBase).
const baseOut = (staleOf) => (e) => {
  const red = [...new Set((e.s?.checks ?? []).filter((c) => FAILED.has(String(c.conclusion ?? '').toLowerCase())).map((c) => c.name))];
  const off = new Set([...baseHeldAt(e.t, e.s?.head), ...(red.length && staleOf ? staleOf(e.t, e.s, red) : [])]);
  return off.size ? { ...e, s: { ...e.s, checks: (e.s.checks ?? []).filter((c) => !off.has(c.name)) } } : e;
};
const clock = (ms) => new Date(ms).toISOString().slice(11, 16);
const prList = (prs) => `#${prs.join(', #')}`;
export function* decideOutage(s) {
  if (s.rowErrors?.length) return;
  // A review or approval gate red on many PRs waits on its reviewer, so it is left out (reviewGates).
  const plan = outagePlan({ prs: (s.prs ?? []).map(baseOut(s.staleOf)), lists: { ...s.gate, gates: reviewGates(s.stateChecks) }, was: s.was ?? {}, now: s.now, unread: s.unread ?? null });
  const keep = { ...plan.keep };
  // A PR a cleared hold still owes a re-run waits for it, with no fix try, until it is made.
  const reran = [...plan.owing];
  const owe = (name, text, r) => {
    const k = keep[name] ?? { cleared: true, text, owed: [] };
    keep[name] = { ...k, owed: [...(k.owed ?? []), { pr: r.pr, head: r.head, run: String(r.run) }] };
    reran.push(r.pr);
  };
  for (const r of plan.owe) {
    const x = yield { type: 'outage-rerun', key: r.key, branch: r.branch, pr: r.pr, head: r.head, run: r.run, name: r.name };
    if (x?.ok) reran.push(r.pr); else if (x?.wait) owe(r.name, s.was[r.name]?.text, r);
    yield out(`outage: "${r.name}"'s platform is back, and the re-run its hold owed PR #${r.pr} ${x?.ok ? 'is made now' : x?.wait ? `waits on the preview build (${x.why}), so the next pass makes it` : `could not be made (${x?.why ?? 'refused'}), so it goes on as before`}`);
  }
  for (const c of plan.cleared) {
    const done = [], refused = [], waits = [];
    for (const r of c.rerun) {
      const x = yield { type: 'outage-rerun', key: r.key, branch: r.branch, pr: r.pr, head: r.head, run: r.run, name: c.name };
      if (x?.ok) { done.push(r.pr); reran.push(r.pr); } else if (x?.wait) { waits.push(r.pr); owe(c.name, c.text, r); } else refused.push(`#${r.pr} (${x?.why ?? 'refused'})`);
    }
    // A re-run waiting on the preview build another PR holds, or on its own run still going, is owed:
    // kept on the hold file (outagePlan's `owed`), so the next pass makes it, though the PR that passed
    // has merged by then, and until then those PRs wait, with no fix try.
    const owed = [...waits, ...c.later];
    yield out(`outage: "${c.name}" passes on PR #${c.by} again, so its platform is back and the hold is cleared: ${done.length ? `re-ran it on ${prList(done)}` : owed.length ? 'nothing re-run yet' : 'no other PR had a run to re-run'}${waits.length ? `; ${prList(waits)} ${waits.length === 1 ? 'waits' : 'wait'} on the preview build` : ''}${c.later.length ? `; ${prList(c.later)} ${c.later.length === 1 ? 'has' : 'have'} a run still going` : ''}${owed.length ? `, and a later pass re-runs ${owed.length === 1 ? 'it' : 'them'}` : ''}${refused.length ? `; not re-run on ${refused.join(', ')}, which go on as before` : ''}${c.push.length ? `; ${prList(c.push)} ${c.push.length === 1 ? 'has' : 'have'} no Actions run for it: redeploy there or push to ${c.push.length === 1 ? 'it' : 'them'}` : ''}`);
  }
  for (const l of plan.lifted) yield out(`outage: "${l.name}" is no longer red with one error line on ${OUTAGE_PRS} or more open PRs, so its hold is lifted and each PR goes on as before`);
  const probed = new Map(), tried = new Set();
  for (const r of plan.rerun) {
    const x = yield { type: 'outage-rerun', key: r.key, branch: r.branch, pr: r.pr, head: r.head, run: r.run, name: r.name };
    // Waiting on the preview build another PR holds is no re-run tried, so the back-off does not grow.
    if (x?.wait) { probed.set(r.name, `waits on the preview build before its re-run on PR #${r.pr} (${x.why})`); continue; }
    keep[r.name] = { ...keep[r.name], reruns: [...keep[r.name].reruns, { pr: r.pr, head: r.head, run: String(r.run), at: new Date(s.now).toISOString(), ok: !!x?.ok }] };
    tried.add(r.name);
    probed.set(r.name, x?.ok ? `was re-run on PR #${r.pr} now` : `could not be re-run on PR #${r.pr} (${x?.why ?? 'refused'})`);
  }
  for (const [name, h] of plan.held) {
    const n = keep[name].reruns.length;
    const next = tried.has(name) ? s.now + outageGap(n) * 1000 : Math.max(h.due, s.now);
    const how = !h.runnable
      ? 'No Actions run reports it, so nothing desk re-runs turns it green: once the platform is back, redeploy there or push to the PRs'
      : `${probed.has(name) ? `It ${probed.get(name)}; the` : 'The'} next re-run on one PR whose run has completed is due at ${clock(next)} UTC (${Math.round(outageGap(n) / 60)} minutes after the last, doubling to ${Math.round(OUTAGE_GAP_MAX_S / 60)}); once one passes, the hold clears and the other PRs' runs are re-run`;
    yield say(null, 'waiting', `OUTAGE — the deploy platform is failing for every PR: "${name}" is red on ${h.prs.length} open PRs (${prList(h.prs)}) with the same error, "${h.text}", so no fix try is spent on it and none of them is stuck. ${how}`);
  }
  if (!s.dry && JSON.stringify(keep) !== JSON.stringify(s.was ?? {})) yield { type: 'outage-hold', hold: keep };
  yield* outageRecord(s, plan.held, keep);
  yield { type: 'outage-held', held: plan.held, rerun: reran };
}

// The outage as the batch's record: the queue's `platform_outage` { check, since, deadline, escalated? },
// kept while any check is held, from when the first of them was, and cleared once none is (a PR passes
// it, or it is no longer red as one). Past its deadline it is escalated once (pass/deadlines.mjs outageWait).
function* outageRecord(s, held, keep) {
  const was = s.recorded ?? null;
  if (!held.size) {
    if (was && !s.dry) yield { type: 'set-batch', fields: ['platform_outage=null'] };
    return;
  }
  const check = [...held.keys()].map((n) => `"${n}"`).join(', ');
  const since = was?.since ?? [...held.keys()].map((n) => keep[n]?.since).filter(Boolean).sort()[0] ?? new Date(s.now).toISOString();
  const rec = was ? { ...was, check } : { check, since, deadline: new Date(Date.parse(since) + OUTAGE_MS).toISOString() };
  const runnable = [...held.values()].some((h) => h.runnable);
  const { rec: next, line } = outageWait(rec, new Date(s.now).toISOString(), s.base ?? 'the base', { runnable });
  if (line) yield say(null, 'waiting', line);
  if (!s.dry && JSON.stringify(next) !== JSON.stringify(was)) yield { type: 'set-batch', fields: [`platform_outage=${JSON.stringify(next)}`] };
}

// How the report names a try: "capture try", "extra review try", "protected files try 1 of 2".
export function tryLabel(f) {
  if (f.kind === 'capture') return 'capture try';
  if (f.extra) return `extra ${f.kind === 'rereview' ? 'review' : 'fix'} try`;
  return `${f.kind === 'rereview' ? 'review' : f.kind === 'protected' ? 'protected files' : 'fix'} try ${f.try} of ${f.of}`;
}

// The §3 row a PR's conflict goes to a fix worker under: pr-conflict-reviewed where anyone but the user's
// handle, and not a bot, reviewed or commented on it, else pr-conflict-unreviewed. -> { row, perm, key }
function* conflictRow(t, n, rows) {
  const row = (yield { type: 'human-seen', key: t.key, pr: n }) ? 'pr-conflict-reviewed' : 'pr-conflict-unreviewed';
  return { row, ...rows[row] };
}

// ---- a Stage 7 resume whose PR is in conflict (issue-1669) -------------------
// A requeued ticket about to resume at Stage 7 whose open PR conflicts with the base, or whose requeue
// note names a conflict, goes to a conflict fix try (merge the base in, resolve, run the targeted
// suites, push) rather than a Stage 7 session, which reads its PR as done and pushes nothing
// (fix-tries.mjs resumeConflict). So does a ticket whose Stage 7 session finished with its PR in
// conflict, which the advance step parked for it (pass/advance.mjs). A conflict alone goes to a worker
// only under the §3 row a ready PR's conflict reads (conflictRow); a note naming it is the instruction to
// resolve it. Otherwise, and once the PR's conflict tries are spent, it is parked naming the conflict,
// its handoff stage kept so a requeue once the person has resolved it resumes at Stage 7 (a ticket
// parked so stays parked). One the advance step parked whose PR no longer conflicts is requeued to
// finish Stage 7.
//
// The snapshot: { resumes: [{ t, s (its PR's status), parked (the advance step's park), notes (the
// answers recorded since its last park) }], base, dry, conflictRows (as decideFixTries's) }.
// Actions, beside `set` and `report` ("->" is what the handler returns):
//   human-seen {key, pr}             -> as decideFixTries's
//   conflict-files {key, branch}     -> as decideFixTries's
//   park {key, question}             park it, its handoff cleared and its handoff stage kept
//   requeue {key}                    -> { ok, out }: queue.mjs requeue
//   apply {key, pr, head, call, parked}   -> whether the try was written (the pass's applyFix, which
//                                    requeues a parked ticket and clears the handoff and its stage)
export function* decideResumeConflicts(s) {
  for (const { t, s: p, parked, notes } of s.resumes) {
    const n = p.pr;
    const c = resumeConflict(t, p, { base: s.base, files: null, notes });
    if (!c) {
      if (!parked || s.dry) continue;
      const rq = yield { type: 'requeue', key: t.key };
      yield say(t.key, rq?.ok ? 'recovered' : 'waiting', `${t.key}: PR #${n} no longer conflicts with ${s.base}: ${rq?.ok ? 'requeued to finish Stage 7' : `its requeue was refused (${lastOf(rq?.out)})`}`);
      continue;
    }
    if (c.call === 'stuck') { yield* parkResume(t, parked, s.dry, `CONFLICT — ${c.why}: not resumed at Stage 7, which would push nothing. Resolve it on the PR's branch and push`); continue; }
    if (!c.noted) {
      const { perm, key } = yield* conflictRow(t, n, s.conflictRows);
      if (perm !== 'yes') { yield* parkResume(t, parked, s.dry, `CONFLICT — ${c.why}, and config §3 ${key} is "${perm}", so no fix worker resolves it and it is not resumed at Stage 7: resolve it on the PR's branch and push`); continue; }
    }
    // The files are read only for a try that goes ahead.
    const files = yield { type: 'conflict-files', key: t.key, branch: p.branch ?? t.branch };
    const call = resumeConflict(t, p, { base: s.base, files, notes });
    const wrote = yield { type: 'apply', key: t.key, pr: n, head: p.head, call, parked };
    // A try the pass did not write (its class waits, or a dry run) leaves a parked ticket parked; one
    // about to resume at Stage 7 is parked instead, as Stage 7 would push nothing.
    if (!wrote && !parked && !s.dry) yield* parkResume(t, false, false, `CONFLICT — ${c.why}, and no conflict fix try was sent for it this pass: not resumed at Stage 7, which would push nothing. Resolve it on the PR's branch and push`);
  }
}
const lastOf = (s) => String(s ?? '').split('\n').filter(Boolean).at(-1) ?? '';
function* parkResume(t, parked, dry, why) {
  if (parked) { yield waiting(t.key, `${t.key}: ${why}`); return; }
  if (dry) { yield waiting(t.key, `${t.key} (dry run): would park instead of resuming at Stage 7: ${why}`); return; }
  yield { type: 'park', key: t.key, question: why };
  yield say(t.key, 'parked', `${t.key}: ${why}`);
}

function* fixTry(t, p, s) {
  const n = p.pr;
  // A conflict goes to a fix worker only under the §3 row the base's conflict reads too, and so does a
  // head the merge driver held for failing §4 Merged-tree check merged into the base.
  const dirty = prInConflict(p);
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
  // The threads a finished feedback try worked are replied on and resolved first, on every route a ready
  // PR takes (held by the reviewer check, red, or green), once its worker has pushed past them, so no
  // route reads a thread the try already answered as still open. One GitHub would not settle holds any
  // new try until a later pass settles it: a new try would replace the record of what was worked.
  let settled = [];
  if (p.state === 'OPEN' && p.isDraft === false && p.head && resolvable(t, p.head).length) {
    const fb = yield { type: 'feedback', key: t.key, pr: n };
    const worked = fb && fb.head === p.head ? settleable(t, p.head, fb.left) : [];
    settled = worked.length ? yield { type: 'settle-worked', key: t.key, pr: n, head: p.head, worked } : [];
    if (settled.length < worked.length && !s.dry) return;
  }
  const gated = !dirty && !tree && reviewerGated(p, s);
  if (gated) { yield* heldTry(t, p, s); return; }
  yield { type: 'gate-hold', key: t.key, on: false };
  if (dirty || tree) {
    const { perm, key } = yield* conflictRow(t, n, s.conflictRows);
    if (perm !== 'yes') {
      const what = tree ? `merged into ${s.base}, fails §4 Merged-tree check \`${tree.command}\`` : `conflicts with ${s.base}`;
      const fix = tree ? `merge ${s.base} into the PR's branch, fix what the check names, and push` : "resolve it on the PR's branch and push";
      yield waiting(t.key, `${t.key}: CONFLICT — PR #${n} is out of draft and ${what}, and config §3 ${key} is "${perm}", so no fix worker ${tree ? 'fixes' : 'resolves'} it: ${fix}`);
      return;
    }
  }
  const { ctx: read, baseMerge, ...reads } = yield { type: 'reads', key: t.key, dirty, dirtyFiles };
  const ctx = s.outage ? { ...read, outage: s.outage } : read;
  // A check an outage holds is the pass's, so a stuck record naming it (written before the outage, or
  // beside it) drops it, whatever route the PR goes this pass: held, a build's wait or any other.
  const less = stuckLessHeld(t.stuck, n, s.outage, { builds: (ctx.builds ?? []).map((b) => b.name) });
  if (less !== undefined && !s.dry) { yield set(t.key, `stuck=${JSON.stringify(less)}`); t = { ...t, stuck: less }; }
  // A red check a change on the branch may clear (an unneeded protected file, a stale verdict) goes to a
  // worker before anything is put to the person.
  let c = gateTry(t, p, { ...ctx, baseMerge }) ?? fixCall(t, p, ctx) ?? (yield* feedbackCall(t, p, s, ctx.waived, reads, settled));
  if (!c) { if (t.stuck && !s.dry) yield set(t.key, 'stuck=null'); return; }
  // Waiting on an outside reviewer leaves the person nothing to do, so an earlier stuck record goes.
  if (c.call === 'wait') {
    if (c.external && t.stuck && !s.dry) yield set(t.key, 'stuck=null');
    // A wait on an outside reviewer is the pass's to report, once it knows whether that reviewer is down.
    if (c.external) yield { type: 'external-wait', key: t.key, pr: n, head: p.head, login: c.login, line: `fix tries: PR #${n} (${t.key}) is out of draft: ${c.why}` };
    else yield out(`fix tries: PR #${n} (${t.key}) is out of draft: ${c.why}`);
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
  const worked = review ? findingsFix(t, p, s, { ...fb, review }, reads) ?? personGapsCall(review, { judgement: s.judgement, workerMay: s.workerMay }) : null;
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
  const rf = reviewFix(t, { pr: p.pr, head: p.head, verdict: fb.review.verdict, body: fb.review.body, comments }, { judgement: s.judgement, workerMay: s.workerMay, outside: reads.outside, title: reads.title });
  return rf?.call === 'requeue' ? { ...rf, fix: { ...rf.fix, ready: true } } : rf;
}

// A ready PR's review, read as the merge driver reads it (review-threads.mjs): a desk-review at its
// head that is not clean goes to a review fix (reviewFix), and, where §3 merge-feedback-first holds
// the merge for them, threads left unresolved or changes requested to a feedback fix (feedbackFix).
// `settled`: the threads fixTry replied on and resolved this pass, which the next try does not quote.
function* feedbackCall(t, p, s, waived, reads, settled = []) {
  if (p.state !== 'OPEN' || p.isDraft !== false || !p.head) return null;
  const n = p.pr;
  const fb = yield { type: 'feedback', key: t.key, pr: n };
  if (!fb) { yield out(`fix tries: PR #${n} (${t.key}): its review threads could not be read; the next pass tries again`); return null; }
  if (fb.head !== p.head) return null;
  const { judgement } = s;
  // A red check reading an outside reviewer's review goes ahead of desk's own review and feedback
  // routes: it waits for that reviewer at the head, then sends their findings (externalTry).
  // Each read of that reviewer is reported (external-seen), so the pass can tell it has stopped reviewing
  // across the repo from one PR waiting on it (gate-reviewer.mjs).
  const seen = [];
  const external = (login) => { const r = externalReview(fb.payload, login); seen.push({ login, r }); return r; };
  const ext = externalTry(t, p, { ...s.gate, stateChecks: s.stateChecks, external, clean: s.clean ?? null, resolvedNow: settled });
  for (const { login, r } of seen) yield { type: 'external-seen', key: t.key, pr: n, head: p.head, login, reviewedAtHead: !!r?.reviewed && r.head === p.head, last: r?.last ?? null };
  if (ext !== undefined) return ext;
  if (fb.review) {
    const rf = findingsFix(t, p, s, fb, reads);
    if (rf) return rf;
  }
  const ff = !s.feedbackFirst ? null
    : feedbackFix(t, { pr: n, head: p.head, decision: fb.decision, threads: fb.left.filter((x) => !settled.includes(x.id)) });
  if (ff) return ff;
  // Gaps only the person can settle wait on their call, whatever the checks or the merge grant say.
  const gaps = fb.review ? personGapsCall(fb.review, { judgement, workerMay: s.workerMay }) : null;
  if (gaps) return gaps;
  // A red verdict state check with no unclean review at the head to fix: a review worker posts one. So
  // does a green PR the driver would hold for want of a clean verdict, where a driver may merge.
  const { carry, scope, baseMerge } = reads.moves();
  const atHead = () => reads.atHead(fb.payload, carry, scope);
  return verdictTry(t, p, { ...s.gate, stateChecks: s.stateChecks, settled: !!fb.review, resolvedNow: settled, atHead, external, clean: s.clean ?? null, waived, base: s.base, baseMerge });
}
