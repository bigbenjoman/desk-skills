#!/usr/bin/env node
// What desk-q counts as needing the person, across every repo on this computer, one line per item,
// and the one command that records each answer. The desk-needs-you skill reads `list`, asks, and
// records through `record`; it reads no queue, log, briefing or digest page itself.
//
//   needs-you.mjs list [<repo>]                       one line per batch with items, then one per item
//       <repo> is a repo's name (all its batches) or <repo>:<name> (one named batch), as each item
//       line starts. Before listing it reads GitHub, Jira and git again: a parked or session item whose
//       own PR merged, with its ticket done (or in no tracker), is recorded done, and a worktree held for
//       changes since committed and pushed is released, each with a line saying so. A draft whose
//       review left requirement gaps quotes each gap from that review on GitHub, and a PR under a
//       person's merge hold reads its files and checks there, to say once the hold's step is done.
//       --no-settle skips that settling, so it writes nothing; --json prints the list as data
//       (listItems): each item's question, actions, `cause` and how many held tickets wait behind it
//   needs-you.mjs record <repo> <TICKET> <action> ["<text>"]
//       resume "<answer>"   answer it (digest.mjs answer), then requeue it, or mark it answered and
//                           name the session to ask. On a lane C or D session item whose step the
//                           person has done, "<what was done>": handed back to a worker that starts at
//                           self-review, with it in its briefing (queue.mjs handback). On a PR open on
//                           GitHub, "<instruction>": kept for its next worker and requeued for a worker
//                           on the PR, whoever runs the batch; a merged or closed PR is refused, saying so.
//                           On a park whose step only a person or another account takes, its PR is read
//                           first: one with no commit, review or passing check since the park, or one
//                           that cannot be read, is refused, saying what GitHub shows, and nothing requeued
//       answer "<answer>"  answer it only (digest.mjs answer): triage questions, and an epic's drafted
//                           plan (start, discard, or an edit), recorded on the epic for the supervisor to
//                           act on (epic-plan.mjs actOnPlan). On a draft PR whose
//                           review left gaps, the call on them: posted on the PR, kept for its next
//                           worker, and requeued for a worker on the PR
//       start               let a held ticket start where nothing else will (desk-q's "let it start" command);
//                           where its hold names one blocker, that blocker alone is lifted
//       requeue             send a ticket whose worker stopped, or whose PR was closed unmerged, back to
//                           a worker (queue.mjs requeue)
//       fix                 send a PR whose review findings outlasted desk's fix tries back to a worker
//                           on the PR, for one more try at the findings its stuck reason quotes
//       drop                take a parked, session or stopped-session ticket, or one whose PR was closed
//                           unmerged, out of the batch and remove its worktree (queue.mjs drop), refused
//                           naming the worktree and what it holds while that has unpushed work; Jira is
//                           left as it is. Recommended first where the park says it has no worker work.
//                           Taken on any ticket row put off with not-now; a put-off item that is no
//                           ticket row (an ask, a step, a follow-on check, a batch-wide hold) is recorded
//                           dismissed in the not-now register instead, by its own key or the ticket key
//                           desk-q shows for it, so it leaves Put off until what it keys to changes
//       move "<batch>"      a parked or stopped ticket out of its batch and into another running batch of
//                           the repo (queue.mjs transfer), its next worker on that batch's base; a batch
//                           not running is refused, naming those that are
//       approve | reject "<note>"   a feature spine's specs (queue.mjs approve or reject); approve on a
//                           batch's `base-push` item records approved.base_push on its queue
//       override <id> "<choice>"    a decision its worker took (digest.mjs override)
//       not-now             put it off (the not-now register), asked again once its inputs change
//       waiting             a PR held only by a person's approval: put off the same way, with the PR's head
//                           and who approved it as its inputs, so it is back once it gets one or its head moves
//       open                a lane C or D park, or one on a step no worker is allowed (aws, curl, gh
//                           api, …) or on a step the person approved that no worker can run: names
//                           the desk-ticket session to open; records nothing
//       admit               a ticket held by open tickets outside its batch that no batch holds: names
//                           the /desk-admit to run for them; records nothing
//       done                the person did the step themselves. On a PR it reads the PR from GitHub:
//                           merged is recorded and leaves the list; unmerged is said, and noted on the
//                           item until its head moves. On a session item, the ticket finished outside
//                           desk: its PR merged, or no PR, records it done; an unmerged PR is refused.
//                           On a step the person approved that no worker can run, that step is done:
//                           the ticket goes back to a worker with it in its briefing (queue.mjs step-done).
//                           On a stopped ticket, or one held outside its batch, whose own PR merged in
//                           another configured repo (that repo's queue, else a merged PR on GitHub whose
//                           branch names it), recommended first: recorded done here with that PR, merged
//   needs-you.mjs move <repo> <TICKET> <batch>        record's move alone: the one action the decider is
//                                                     allowed, so its allow rule names no other
//   needs-you.mjs left [<repo>]                       how many items desk-q still counts, and where passes stopped
//   needs-you.mjs ask <repo> "<what to do>" [--until <TICKET>[,<TICKET>...]]
//                     [--options <a>|<b>[|...] [--recommend <a>] [--apply-by <HH:MM|ISO>] [--never-default "<why>"]]
//                                                     an action a session hands the person, as an item
//                                                     `ask:<n>` of the repo's until they say done (asks.mjs);
//                                                     with --until, a wait on those tickets, which a pass
//                                                     drops once they are all merged or done. With --options,
//                                                     a choice: each option (one word) is an action, the
//                                                     recommended one first, and a pass applies it by itself
//                                                     at --apply-by, else the next §3b check-in, unless it
//                                                     must never default (ask-defaults.mjs)
//   needs-you.mjs ask-status <repo> <id>              whether ask <id> is open, or which option was chosen,
//                                                     by the person or by default, and when
//   needs-you.mjs claim [<repo>] <item> --by <session>
//                                                     a session takes a follow item (`follow:<KEY>…`, a check
//                                                     after merge) on: desk-q shows it as checking (<session>)
//                                                     and leaves it out of the person's count until it is
//                                                     done, or the session is idle past §3b Release idle
//                                                     claims after (hours) (the not-now register keeps it)
//
// Two items are the repo's rather than a ticket's, and are named in place of one: `unset:<key>`, every
// ticket parked naming a §3 row the repo's config does not set (done requeues them once it is set), and
// `templates`, the repo's committed copies of desk's templates the supervisor found behind (done
// checks them again). `reviewer` is the repo's too: its failing reviewer health check, naming every PR
// the pass holds on it (done records nothing; the next pass checks again). `browser-signin:<id>` is the
// machine's: a browser profile's GitHub login failing, which every repo's screenshot uploads with it wait on
// (done records nothing; the next pass checks again). `upload-page` is the machine's too: the upload queue
// paused because the uploader found no comment composer on GitHub's PR page, a desk fault every repo's
// screenshot uploads wait on (done records nothing; an upload after desk is installed again clears it).
// `lease-trial` is the machine's too: the lease trial has run its days with a kind still in shadow, and
// on-clean, on-all or keep sets the profile's lease-kinds row and restarts the trial for what stays in shadow. `step:<KEY>` is the repo's too: a step only the person takes, which every ticket
// it names, in any of the repo's batches, waits on to merge (done records nothing; the pass reads the step from Jira).
// `promotion:<n>` is a feature batch's: its promotion PR #<n>, still red once its check tries are spent,
// listed above the follow items waiting on it (done records nothing; the next pass reads its checks again).
// `ask:<n>` is the repo's too: an action a session handed the person (done takes it off the list).
// `nopr:<KEY>` is a batch's: its ticket <KEY>, done with no PR, naming every ticket held behind it
// (start lifts the hold on <KEY> alone from each, so a ticket also held behind another stays held).
// `proposal:<KEY>` is a ticket's: a pending proposal on its priority that triage found (priority-proposal.mjs),
// which holds no work; promote ["<value>"] or reject writes the answer to the ticket (desk-jira) and keeps it.
// `base-red:<branch>` is a batch's: its base red on checks that hold its PRs' fix tries, naming the
// PRs held and the last merges desk made (done records nothing; each hold clears once its check passes there).
// `base-sync` is a batch's: its base sync failed (could not push, fetch or recreate the base) while that
// holds every spawn, so every ticket ready to spawn is frozen; listed first, naming the failure and, for a
// refused push, the command that pushes it (done records nothing; the next pass clears it once the base is current).
// `stalled` (`stalled:<batch>` for a named batch) is a batch's: a session runs it and its passes stopped
// with work left (done records nothing; the next pass clears it).
// Items are what desk-q's home screen counts as "◆ needs you", and its follow items it counts apart as
// checks after merge, in order: a PRODUCTION BROKEN park
// first, then most held tickets waiting behind it (each item says how many), then the longest waiting,
// less any put off with not-now whose inputs are unchanged and, where its entry recorded the actions it
// offered, that offers none it did not offer then; one put off is listed anyway while three or more
// held tickets wait behind it. Exits 0, or 11
// (show the person) on anything it refuses.
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runOnce, outOrNull } from './build-memo.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dragCells, evidenceRecord, missingShots, parseEvidenceRow, ticketShots } from './evidence.mjs';
import { evidenceHold } from './preview-db.mjs';
import { cellPlan, reviewStep, RUNNER_FIX, UPLOAD_CRASHED } from './undraft.mjs';
import { conflictTriesMade, draftHasGaps, gapsFix, lastTrySaid, instructionFix, personGapsIn, personReviewFix, reviewGaps as reviewGapLines, stuckFindings, verdictReviewAt } from './fix-tries.mjs';
import { approvalFiles, evaluateGate, globToRegExp, holdNeedsPerson, FAILED, latestPerCheck, normaliseRollup } from './gate.mjs';
import { SAFE_ID, deskHome, expandHome, machineValue, psRows, slugOf, repoConfigValue, repoConfigValues, parseLevers, releaseCommand, repoPermission, repoPermissionUnset, repoVerdictLogins, isNone, fullMatch, personStepLabels, personInputLabels, repoPortClaims, repoDirs, PERMISSION_KEYS } from './desk-env.mjs';
import { fixClass } from './failure-class.mjs';
import { liveBaseRed, MERGES_SHOWN } from './base-red.mjs';
import { describeCond } from './clears-when.mjs';
import { readRecord as templatesRecord, check as templatesCheck } from './repo-templates.mjs';
import { landedPr } from './post-merge.mjs';
import { promotionPr, readQueue, isHeld, heldBehindOf, spinePark, planPark, openQuestion, sessionPark, neverStep, noWorkerWork, personOnlyStep, moveTarget, targetsText, moveOffer, prStatusOf, shippedSet, ownPr, mergedTailPr, mergedTailSteps, gitHold, gitHeld, triageGate, triagePark as parkedAtTriage, holdsKept, epicBatch, promotedAt, unpromotedHolds, promotionState, designParkUrls, EXIT, planFirst, planFirstWaits, planFirstPutOff } from './batch-state.mjs';
import { snapshotOf, savedAt, canonicalUrl } from './desk-design.mjs';
import { promotionTitle } from './pass/promotion-pr.mjs';
import { blockersOf } from './queue-states.mjs';
import { dayAndTime } from './desk-q-eta.mjs';
import { browserSignins, reviewerRecord } from './health.mjs';
import { PAGE_RESUMES, readUploadQueue, SIGNIN_CMD, uploadPause, waitingPrs } from './upload-queue.mjs';
import { sessionFile } from './find-playwright.mjs';
import { gateHeldAt, loadRepos, shownRepos, holdOf, holdShown, heldDraft, heldAsks, resolveRepo, resumeOf, needsSession, queueRun, checkoutOf, timeOf, needsRows, needText, prWhy, andList, capital, keysOf, triageOf, usageHoldOf, stuckOf, behindPrs, worktreeBusy,worktreeBusyText, busyPark, outsideOf, JIRA_CATEGORY, personStepOf, inputAge, mtimeOf, sessionStalled, unmergedBlockers, throughOnRecord, BATCH_MERGES, HOLD_CAVEAT, batchMerging } from './desk-q.mjs';
import { answer, override, readDecisions, openQuestions, PRODUCTION_BROKEN, checkinTimes, DEFAULT_TIMES } from './digest.mjs';
import { addPutOff, putOffEntry, notNowPath, readRegister, lookup, changedLine, changes, inputsHash, questionKey, addClaim, claimOf, clearClaim } from './not-now.mjs';
import { claimHours, transcriptOf, SESSION_ID, DEFAULT_CLAIM_HOURS } from './claims.mjs';
import { batchHolding, listBatches, otherRunningBatches, finishedOnRecord, queuedCopies, copiesElsewhere, copyWhere } from './batches.mjs';
import { followOnPending, postMergeOwed } from './harvest.mjs';
import { followKind, checkOf, settled, broken, followDue, followDueAt, followDelayMs, FOLLOW_WAIT_MS, FOLLOW_TIMEOUT_MS, FOLLOW_BROKEN_RETRY_MS } from './follow-steps.mjs';
import { promotionRef } from './promotion.mjs';
import { kindMode, readLog, restartTrial, trialOf, TRIAL_DAYS } from './leases.mjs';
import { LEASE_KINDS } from './machine.mjs';
import { saveAnswer } from './briefing.mjs';
import { addAsk, removeAsk, readAsks, answerAsk, answerOf } from './asks.mjs';
import { OPTION, applyByOf, neverDefault, nextCheckin, deadlineText } from './ask-defaults.mjs';
import { finishedCloud, readArchived, readPending, recordArchived } from './cloud-worker.mjs';
import { readArchive } from './queue-store.mjs';
import { saveNamedFixtures, MAX_BYTES, NAMED_MAX_BYTES } from './live-read.mjs';
import { prsNaming } from './recoveries.mjs';
import { parkWords, plainTerms, GRANT_WORDS } from './park-words.mjs';
import { askAnswered, ledgerOnIn } from './ask-ledger.mjs';
import { lostAt, readRearm } from './loop-tick.mjs';
import { dueTick } from './borrow.mjs';
import { acceptNeed, acceptOnly, evidenceIn, gapParts } from './accept-gaps.mjs';

// The decisions a parked item offers to override, newest first.
const DECISIONS_SHOWN = 3;

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const since = (ms) => { const m = Math.floor(ms / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
// A park triage made (size, a dependency cycle): queue.mjs requeue refuses it, so it needs a person.
const triagePark = (t) => /^(size |dependency cycle:)/.test(String(t.park?.question ?? ''));
// A park in lane C, or a canvas-less lane D, is offered to an interactive desk-ticket session. A stopped
// worker's park is the one it wrote to its park file: it exited with no marker, so the queue holds none.
const parkText = (r, t) => String(t.park?.question ?? openQuestion(r.stateDir, t.key) ?? '');
// A park's need as the person reads it: plain words, without the steps its worker did not reach, which
// stay in the raw park.question the classifiers read and in the worker log (park-words.mjs).
const parkNeed = (q) => one(parkWords(q));
// Each action's reason is plain words too: no lane letters, grant ids or queue verbs.
const SESSION_WHY = "it needs a plan or design agreed with you first, which a worker can't do, so it needs you";
// Why a session park is one: a step no worker is ever allowed, or its lane.
const sessionWhy = (q) => { const s = neverStep(q); return s ? `a worker can't ${s === '.claude/ write' ? 'write under .claude/' : `run ${s} commands`}, so it needs you` : SESSION_WHY; };
// Once the person has done a lane C or D park's step, resume hands it back to a worker that starts at
// self-review (queue.mjs handback). Offered only where that worker has somewhere to start, the
// worktree and branch the queue records, and never on a step no worker is allowed: a worker parked
// mid-build there, and self-review would skip the rest of its build.
const handBack = (r, t) => (t.worktree && t.branch && !neverStep(parkText(r, t))
  ? [['resume', null, 'once its step is done, resume "<what you did>" hands it back to a worker that starts at self-review']] : []);
// Every parked or session item can be dropped out of its batch (queue.mjs drop, which removes its clean
// worktree). Where its park says it has no worker work, drop comes first as the recommendation and the
// item's own first action keeps its reason as a note; otherwise drop is offered just before not-now.
const DROP_WHY = 'its worker says nothing is left for a worker to do, so sending it back would only stop it again: drop takes it out of the batch and removes its clean worktree, and leaves Jira as it is';
const DROP_NOTE = 'drop takes it out of the batch and removes its worktree, refused while that holds unpushed work; Jira is left as it is';
function withDrop(r, t, actions) {
  if (noWorkerWork(parkText(r, t))) {
    const [[name, why, note], ...rest] = actions;
    return [['drop', DROP_WHY], [name, null, note ?? why], ...rest];
  }
  const at = actions.findIndex(([a]) => a === 'not-now');
  return at < 0 ? [...actions, ['drop', null, DROP_NOTE]] : [...actions.slice(0, at), ['drop', null, DROP_NOTE], ...actions.slice(at)];
}
const PERSON_RESUME_NOTE = 'once the step is done, resume "<what you did>" reads its PR on GitHub and sends it back to a worker only if a commit, review or passing check landed since the park';
// What changed on a PR (`v`, read with commits, reviews and statusCheckRollup) since its ticket parked
// (park.since): a commit, a review, or a check finished since that is not failing (a red one gone green).
// Read from GitHub's own times, since no PR state is recorded when a ticket parks. -> { changed, shows },
// `shows` saying what GitHub still shows when nothing did. With no park time nothing can be compared, so
// it reads as changed and resumes as before.
export function prSincePark(t, v) {
  const since = Date.parse(t?.park?.since ?? '');
  if (Number.isNaN(since)) return { changed: true };
  const after = (at) => Date.parse(at ?? '') > since;
  const checks = latestPerCheck(normaliseRollup(v.statusCheckRollup));
  const moved = (v.commits ?? []).some((c) => after(c?.committedDate))
    || (v.reviews ?? []).some((x) => after(x?.submittedAt))
    || checks.some((c) => after(c.completedAt ?? c.startedAt) && c.conclusion && !FAILED.has(c.conclusion));
  if (moved) return { changed: true };
  const red = [...new Set(checks.filter((c) => FAILED.has(c.conclusion)).map((c) => c.name))].sort();
  const failing = red.length ? `${red.length === 1 ? 'a failing check' : `${red.length} failing checks`}, ${andList(red.map((c) => `"${c}"`))}` : 'no failing check';
  return { changed: false, shows: `head ${String(v.headRefOid ?? '?').slice(0, 7)}, no commit, review or passing check since it parked, and ${failing}` };
}
// A session item the person finished themselves, outside desk: done records it, once its PR has merged.
const SESSION_DONE = ['done', null, 'if you finished the ticket yourself, done reads its PR and records it done once the PR has merged, or where it has none'];
// A step the person approved that its park says no worker can run (park.session_step, answer.mjs):
// they run it in a session, and done sends the ticket back to a worker with it recorded done.
const STEP_WHY = "a worker can't run the step you approved, so it needs you: run it in an interactive session";
const STEP_DONE = ['done', null, 'once you have run the step, done sends the ticket back to a worker with it recorded as done'];
const STEP_ANSWER = ['answer', null, 'if you did not mean to approve running it, answer again: an answer approving no step makes it an ordinary park you can resume'];
const digestList = (r) => [{ slug: r.slug, batch: r.batch ?? null, state: r.stateDir, queue: r.queuePath }];
// A draft the pass left for the person because the review verdict at its head has gaps (undraft.mjs
// verdictAt's `not clean (… gaps=N …)`), whatever its call: one whose fix tries ran out keeps `findings`.
// A PR out of draft has no such record: the pass marks it stuck on the gaps only its person can settle.
const reviewGaps = (t, stuck) => draftHasGaps(t) || (t.pr_status?.isDraft === false && personGapsIn(stuck?.why).length > 0);
// The requirement gaps a draft's review lists (fix-tries.mjs reviewGaps), read from GitHub: the latest
// of desk's own reviews whose verdict is the one its undraft record names (`verdict at <sha>`). null
// when the PR, that review, or a gap under its gaps heading cannot be read.
function draftGapsOf(r, t, reads) {
  const at = /\bverdict at ([0-9a-f]{7,40})\b/.exec(String(t.undraft?.why ?? ''))?.[1];
  const logins = repoVerdictLogins(r.slug);
  if (!at || !logins) return null;
  const { v } = reads.pr(r, t.result.pr, ',reviews');
  const review = verdictReviewAt(v?.reviews, logins, at);
  const gaps = review ? reviewGapLines(review.body) : [];
  return gaps.length ? gaps : null;
}
// The evidence a PR's body already holds for each gap only the person accepts (accept-gaps.mjs
// acceptNeed): the body's lines naming the gap's criterion label, keyed by label (`AC2`), at most
// three each. {} without reads, or when the body cannot be read.
function prEvidence(r, t, reads, gaps) {
  if (!reads || !gaps.some((g) => gapParts(g).ac) || t?.result?.pr == null) return {};
  const body = String(reads.pr(r, t.result.pr, ',body').v?.body ?? '');
  return Object.fromEntries(Object.entries(evidenceIn(body, gaps)).map(([ac, lines]) => [ac, lines.map(one)]));
}
const prComment = (text) => `The person's call on this PR's review gaps, recorded through desk-needs-you:\n\n${text.split('\n').map((l) => `> ${l}`).join('\n')}\n\nA worker on this branch carries it out.`;
// Every open PR takes an instruction for a worker on it, whatever else the item offers.
const SEND_BACK = ['resume', null, 'resume "<instruction>" keeps it for the next worker and sends the ticket back to a worker on the PR'];
// Why a PR in this state takes no instruction, or null for an open one.
const prShut = (pr, state) => (state === 'MERGED' ? `PR #${pr} is merged, so no worker can carry out an instruction on it, and nothing was recorded.`
  : state === 'CLOSED' ? `PR #${pr} was closed without merging, so no worker can carry out an instruction on it, and nothing was recorded. Drop the ticket, or requeue it for a worker that opens a new PR.` : null);
// What GitHub shows of a PR that has not merged.
const prShows = (v) => (v.state === 'CLOSED' ? 'closed without merging' : `unmerged${v.isDraft === true ? ', still a draft' : ''}`);

// ---- Work finished outside desk. The pass looks for it only on tickets it could spawn, so a parked
// ticket whose PR merged, or a worktree pushed since the pass held it, stays listed until list reads
// it again here. A read that fails is null, and the item stays as it was.
const ghRepoOf = (r) => repoConfigValue(r.slug, 'gh-repo') ?? r.slug.replace('__', '/');
// Batch `r`'s repo's default branch (§0), never a named batch's base.
const defaultOf = (r) => repoConfigValue(r.slug, 'default-branch') ?? 'main';
const quiet = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
export const READS = {
  // The PR as GitHub has it now, which the queue's record may be a pass behind: { v, err }.
  pr: (r, pr, more = '') => {
    try { return { v: JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--repo', ghRepoOf(r), '--json', `state,mergedAt,isDraft,headRefOid${more}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })), err: '' }; }
    catch (e) { return { v: null, err: one(e.stderr || e.message) }; }
  },
  // The ticket's status category (`new`, `indeterminate`, `done`), read in the repo's own checkout so
  // its own Jira is the one asked.
  ticket: (r, key) => {
    try {
      const at = checkoutOf(r, 'read its ticket');
      return JSON.parse(execFileSync('desk-jira', ['get', key, '--json'], { ...quiet, cwd: at.cwd, env: at.env }))?.fields?.status?.statusCategory?.key ?? null;
    } catch { return null; }
  },
  // desk-jira run in the repo's own checkout, so its own Jira is the one written: its stdout, or a throw.
  jira: (r, args) => {
    const at = checkoutOf(r, 'write to its ticket');
    return execFileSync('desk-jira', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: at.cwd, env: at.env, maxBuffer: 64 << 20 });
  },
  git: (dir, args) => outOrNull(runOnce('git', ['-C', dir, ...args])),
  // origin fetched in `dir`, so its remote refs are as GitHub has them: true, or false when it failed.
  fetch: (dir) => { try { execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin'], { ...quiet, timeout: 120000 }); return true; } catch { return false; } },
  // The newest PR merged in repo `slug` whose branch names `key` (a title is not enough: another
  // ticket's PR often names it), read once per process: { pr, mergedAt }, or null, also when unread.
  merged: (slug, key) => {
    const id = `${slug}\t${key}`;
    if (!mergedRead.has(id)) {
      let hit = null;
      try {
        const p = prsNaming(ghRepoOf({ slug }), 'merged', key, { fields: 'mergedAt' }).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))[0];
        if (p) hit = { pr: Number(p.number), mergedAt: p.mergedAt ?? null };
      } catch { /* unread: no PR found */ }
      mergedRead.set(id, hit);
    }
    return mergedRead.get(id);
  },
  // The newest open PR whose title or branch names `key`: { pr, err }, pr null when none is open. Every
  // open PR is read, as GitHub's text search never reads a branch name.
  open: (r, key) => {
    try {
      const p = prsNaming(ghRepoOf(r), 'open', key, { fields: 'title', inTitle: true, search: false, limit: 500 }).sort((a, b) => Number(b.number) - Number(a.number))[0];
      return { pr: p ? Number(p.number) : null, err: '' };
    } catch (e) { return { pr: null, err: one(e.stderr || e.message) }; }
  },
  // The repo's open ci-main-red issues assigned to the person gh is signed in as: [{ number, title,
  // url, createdAt }], none when unread.
  ciRed: (r) => {
    try { return JSON.parse(execFileSync('gh', ['issue', 'list', '--repo', ghRepoOf(r), '--label', 'ci-main-red', '--state', 'open', '--assignee', '@me', '--limit', '5', '--json', 'number,title,url,createdAt'], quiet)); }
    catch { return []; }
  },
};
const mergedRead = new Map();
// The ticket's own PR merged in a configured repo other than r's, where it was built: that repo's
// queue record of it first (a PR it records merged), then GitHub (READS.merged) where `reads` is given.
// Only a tracker key both repos share is the same ticket there: an issue-<n> or ticket-file slug names
// a different ticket in each repo. A ticket requeued after a merge here counts only a later merge, as
// the pass's shippedElsewhere does. -> { slug, repo, pr, mergedAt }, or null.
function mergedElsewhere(r, t, reads) {
  const key = t.key;
  if (!trackerTicket(r, key)) return null;
  const own = Date.parse(t.merged_at);
  const later = (e) => (Number.isNaN(own) || Date.parse(e.mergedAt) > own ? e : null);
  let others;
  try { others = repoPortClaims().map((c) => c.slug).filter((s) => s !== r.slug && trackerTicket({ slug: s }, key)); } catch { return null; }
  for (const slug of others) {
    let batches;
    try { batches = listBatches(slug); } catch { continue; }
    for (const b of batches) {
      let o;
      try { o = existsSync(b.queue) ? readQueue(b.queue).tickets?.[key] : null; } catch { continue; }
      const s = prStatusOf(o);
      const hit = o?.result?.pr != null && (o.merged_at || s?.state === 'MERGED') && later({ slug, repo: ghRepoOf({ slug }), pr: Number(o.result.pr), mergedAt: o.merged_at ?? s?.merged_at ?? null });
      if (hit) return hit;
    }
  }
  for (const slug of reads?.merged ? others : []) {
    const hit = reads.merged(slug, key);
    if (hit && later(hit)) return { slug, repo: ghRepoOf({ slug }), ...hit };
  }
  return null;
}
// An item's actions once its PR is found merged in another repo: done first, and every other action
// kept, its recommendation said as a note.
const shippedFirst = (actions, e) => (!e ? actions : [
  ['done', `its PR #${e.pr} merged in ${e.repo}: done records it done here from that PR, and the tickets held behind it can start`],
  ...actions.map(([name, why, note]) => (note ?? why ? [name, null, note ?? why] : [name]))]);
// Whether a key is a ticket in the repo's tracker, by its §4 Ticket key pattern.
function trackerTicket(r, key) {
  const pattern = repoConfigValue(r.slug, 'ticket-pattern');
  return !!pattern && !isNone(pattern) && fullMatch(pattern, key);
}
const ticketWords = (key, status) => (status === 'done' ? `${key} is done in Jira` : status ? `${key} is not done in Jira yet` : `${key}'s Jira status could not be read`);
// A time, in ms or as an ISO string, to the minute in UTC: "2026-11-09 19:40 UTC".
const utc = (at) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const mergedWords = (pr, v) => (pr == null ? 'it has no PR' : `PR #${pr} merged${v?.mergedAt ? ` at ${utc(v.mergedAt)}` : ''}`);
const recordShipped = (r, t, how, pr, v) => queueCmd(r, shippedSet(t, how, pr, v?.mergedAt ?? null));
// A park waiting on issue links only the person makes holds them in its clears_when alone: the pass
// records it done once each reads on Jira, so it is never closed here.
const linksPending = (t) => (t.park?.clears_when?.kind === 'links-made' ? describeCond(t.park.clears_when) : null);
// A parked or session item that shipped: its own PR merged, and its ticket done or in no tracker. -> how, or null.
function shippedOf(r, t, reads) {
  const pr = ownPr(t);
  if (pr == null || linksPending(t)) return null;
  const { v } = reads.pr(r, pr);
  if (v?.state !== 'MERGED') return null;
  if (!trackerTicket(r, t.key)) return { how: mergedWords(pr, v), pr, v };
  return reads.ticket(r, t.key) === 'done' ? { how: `${mergedWords(pr, v)}, and ${ticketWords(t.key, 'done')}`, pr, v } : null;
}
// A parked item whose own PR merged and whose ticket reads not done in Jira: back to a worker for its
// after-merge steps alone (batch-state mergedTailSteps). -> { pr, v }, or null.
function tailOf(r, t, reads) {
  const pr = mergedTailPr(t);
  if (pr == null || linksPending(t) || !trackerTicket(r, t.key)) return null;
  const { v } = reads.pr(r, pr);
  if (v?.state !== 'MERGED') return null;
  const status = reads.ticket(r, t.key);
  return status && status !== 'done' ? { pr, v } : null;
}
function requeueTail(r, t, { pr, v }) {
  const how = `${mergedWords(pr, v)}, and ${ticketWords(t.key, 'indeterminate')}`;
  const steps = mergedTailSteps(t, pr, v?.mergedAt ?? null);
  if (steps.before) queueCmd(r, steps.before);
  const rq = queueCmd(r, ['requeue', t.key]);
  if (!rq.ok) {
    queueCmd(r, steps.refused);
    return `${how}, but the requeue for its after-merge steps was refused, so it stays on your list: ${rq.out}`;
  }
  const m = queueCmd(r, steps.after);
  return m.ok ? `${how}, so it is back with a worker for its after-merge steps only, and off your list.`
    : `${how}; it is requeued, but its briefing could not be told only the after-merge steps are left: ${m.out}`;
}
// A worktree held for uncommitted changes or unpushed commits (batch-state gitHold): true once it has
// neither, else false, or null where it cannot be read. One held because another process works in it
// is the pass's to read.
function worktreeClean(r, t, reads) {
  const held = gitHeld(worktreeBusy(t)?.why);
  if (!held) return null;
  const dir = expandHome(repoConfigValue(r.slug, 'worktrees-dir') ?? '');
  const wt = [t.worktree, held.wt, dir && !isNone(dir) ? join(dir, t.key) : null].find((p) => p && existsSync(p));
  if (!wt) return null;
  const why = gitHold(wt, (args) => reads.git(wt, args));
  return why === undefined ? null : why === null;
}

// What list settles before it lists, in the batches `word` names: a parked or session item that shipped
// is recorded done, and a worktree hold found clean is dropped. -> one line for each.
export function refresh({ word = null, now = Date.now(), repos = loadRepos(now, word), reads = READS } = {}) {
  const lines = [];
  const scope = scopeOf(repos, word).scope.filter((x) => !x.error && x.q);
  // A follow step gated on the default branch or production is judged from the repo root's remote refs
  // and its PR's merge commit (gateHeld), which no pass keeps fresh once the batch is idle: origin is
  // fetched once per repo root, and a PR whose merge was recorded with no merge commit (done here, a
  // hand-ship) is read for it. So is a promotion PR that took a child with a production step to the
  // default branch with no merge commit recorded (the merge driver's read failed, or a record from before
  // the pass kept one): a rebase merge leaves gateHeld nothing else to find it by.
  const fetched = new Set();
  for (const r of scope) {
    const promos = new Set();
    for (const t of followsOf(r).filter(gatedFollow)) {
      const root = gitRootOf(r);
      if (root && !fetched.has(root)) { fetched.add(root); reads.fetch?.(root); }
      if (!reads.pr) continue;
      const p = (t.promoted_at || viaBase(r.q, t)) && t.follow_on.some((s) => gateOf(s) === 'production') ? promotionPr(r.q, t) : null;
      if (p && !SHA40.test(String(p.merge_commit ?? '')) && /^\d+$/.test(String(p.pr)) && !promos.has(p.pr)) {
        promos.add(p.pr);
        const oid = reads.pr(r, p.pr, ',mergeCommit').v?.mergeCommit?.oid;
        if (SHA40.test(String(oid ?? ''))) queueCmd(r, ['set-batch', `promotion_commits.${p.pr}=${oid}`]);
      }
      if (t.pr_status?.merge_commit || t.result?.pr == null) continue;
      const oid = reads.pr(r, t.result.pr, ',mergeCommit').v?.mergeCommit?.oid;
      if (SHA40.test(String(oid ?? ''))) queueCmd(r, ['set', t.key, `pr_status.merge_commit=${oid}`]);
    }
  }
  for (const r of scope) {
    for (const x of needsRows(r)) {
      const t = x.t;
      if (worktreeBusy(t)) {
        if (worktreeClean(r, t, reads) !== true) continue;
        const m = queueCmd(r, ['set', t.key, 'worktree_busy=null']);
        lines.push(`${r.word} ${t.key}: ${m.ok ? 'its worktree is clean and its branch matches origin, so it is off your list; the next pass can start it.' : `its worktree is clean, but dropping its hold was refused: ${m.out}`}`);
        continue;
      }
      if (t.state !== 'parked' || !['parked', 'session'].includes(itemOf(r, x).kind)) continue;
      const shipped = shippedOf(r, t, reads);
      const tail = !shipped && itemOf(r, x).kind === 'parked' && !needsSession(t) && !t.park?.claim?.session ?tailOf(r, t, reads) : null;
      if (tail) { lines.push(`${r.word} ${t.key}: ${requeueTail(r, t, tail)}`); continue; }
      if (!shipped) continue;
      const { how } = shipped;
      const m = recordShipped(r, t, how, shipped.pr, shipped.v);
      lines.push(`${r.word} ${t.key}: ${m.ok ? `${how}, so it is recorded done and off your list.` : `${how}, but recording it done was refused: ${m.out}`}`);
    }
  }
  return lines;
}

// ---- A PR item in the person's words: what is wrong, then what to do and what happens once they have.
// No commit SHA, fix try or review-verdict wording: those are the pass's, for its log. Recorded text
// quoted in one is kept whole, and a URL in it untouched, so the session can ask it as it stands.
const URL_PART = /(https?:\/\/\S+)/;
// A commit SHA standing on its own: hex inside a path or file name (fix-338f2164.md) is not one.
const SHA = String.raw`(?<![\w./-])[0-9a-f]{7,40}(?![\w/-]|\.\w)`;
const passWords = (s) => s.replace(new RegExp(String.raw`,\s*at ${SHA},`, 'g'), '').replace(new RegExp(String.raw`\s*\bat ${SHA}`, 'g'), '').replace(new RegExp(SHA, 'g'), 'its latest commit')
  .replace(/\s*after \d+ fix tr(?:y|ies)/g, '').replace(/\bfix tr(?:y|ies)\b/g, 'repair').replace(/\breview verdict\b/g, 'review');
const plainWords = (s) => one(one(s).split(URL_PART).map((p, i) => (i % 2 ? p : passWords(p))).join(''));
// Once the person's step is done: desk merges it where it may, whoever merges for the batch does where
// the grant covers it with no merge driver running, else merging is theirs too.
const thenMerge = (r) => (r.ctx?.merges ? 'desk then merges it once its checks are green'
  : r.ctx?.batchMerges ? `it then ${BATCH_MERGES} (its merge driver, or the session relaying its merge lines)${r.ctx.mergeHolds ? HOLD_CAVEAT : ''} once its checks are green`
    : 'then merge it on GitHub once its checks are green');
const REPAIRED = "desk's own repairs did not fix";
// A draft fix-tries.mjs captureTry left stuck: the screenshots still not taken, then what its worker said.
const CAPTURE = /^(\d+) screenshot\(s\) still not taken after a capture try: (.+?)(?:; the capture try said: ([^]*))?$/;
// Whether a draft's item is about its screenshots: what `done` on it reads is the body's cells.
const shotsItem = (r, t) => {
  const w = prWhy(r, t) ?? {};
  return w.code === 'stuck' ? CAPTURE.test(String(w.stuck?.why ?? '')) : w.code === 'draft' && /screenshot|^its evidence workflow/.test(String(w.undraft?.why ?? ''));
};
// What desk does about each cell left in a body, for the person who said done on it: the pass's own
// cell call (undraft.mjs cellPlan), read with what the pass reads.
function cellWords(r, t, pr, v, repo) {
  const row = repoConfigValue(r.slug, 'evidence-workflow');
  const view = (id) => { try { return JSON.parse(execFileSync('gh', ['run', 'view', String(id), '--repo', repo, '--json', 'status,conclusion'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; } };
  const plan = cellPlan(t, { number: pr, head: v.headRefOid ?? null, body: v.body }, {
    // A PR with a preview database never takes an evidence run (pass/undraft.mjs, preview-db.mjs evidenceHold).
    evidence: row && !evidenceHold(r.stateDir, pr) ? parseEvidenceRow([row]) : null,
    evidenceRun: (head) => evidenceRecord(join(r.stateDir, 'evidence-runs'), pr, head, view),
    missingShots: (body) => missingShots(body, ticketShots(t, r.stateDir)),
  });
  return plan.map((c) => `${c.file}: ${c.doing}`).join('; ');
}
// Those screens and the worker's reason, whole: the item's note, which listText prints after the need.
const captureNote = (s) => {
  const m = CAPTURE.exec(String(s?.why ?? ''));
  return m ? `(Not taken: ${m[2]}.${m[3] ? ` The capture try said: ${one(m[3])}` : ''})` : '';
};
// A review stuck reason's tries by kind (fix-tries.mjs triesByKind), as `after desk's 3 repairs (1
// conflict fix, 1 re-review, 1 review fix)`; null for a reason that names none.
const REPAIR_KIND = { conflict: ['conflict fix', 'conflict fixes'], rereview: ['re-review', 're-reviews'], review: ['review fix', 'review fixes'], checks: ['red-check fix', 'red-check fixes'] };
function repairsMade(why) {
  const m = /^review not clean after (\d+) fix tr(?:y|ies) \(([^)]*)\)/.exec(why);
  if (!m) return null;
  const kinds = m[2].split(', ').map((p) => { const [c, k] = p.split(' '); const w = REPAIR_KIND[k] ?? ['repair', 'repairs']; return `${c} ${w[c === '1' ? 0 : 1]}`; });
  return `after desk's ${m[1]} ${m[1] === '1' ? 'repair' : 'repairs'} (${kinds.join(', ')})`;
}

// A PR in conflict: no repair failed where no conflict try ran, and a failed one says what its worker
// reported (the stuck reason's `the last try said`, else the finished try's DONE line).
function conflictPlain(r, t, n, base, why = '') {
  const made = conflictTriesMade(t?.fix_tries);
  const done = /; the last try said: (.+)$/.exec(why)?.[1] ?? lastTrySaid(t);
  const said = done ? one(/\bsaid=(.+)$/.exec(done)?.[1] ?? done) : '';
  const how = made ? `${REPAIRED} it${said ? `: its last repair said "${said}"` : ''}` : 'no repair by desk has tried it yet';
  const files = /^still in conflict with .+? repairs, the most one PR gets: ([^;]+)/.exec(why)?.[1];
  return `${n} is in conflict with ${base ?? 'its base'}${files ? ` in ${files}` : ''}, and ${how}. Resolve the conflict on its branch; ${thenMerge(r)}.`;
}

function stuckPlain(r, n, s, t, reads = null) {
  const checks = s?.checks ?? [];
  if (checks.length) {
    const label = (c) => `"${c.name}"${c.step ? ` (failed at "${c.step}")` : c.unread ? ' (desk could not read which step failed)' : ''}`;
    // A check desk builds (§4 Check builds) whose build failed: a worker fixes the build on its branch.
    const built = checks.filter((c) => c.build);
    const mine = checks.filter((c) => !c.command && !c.build), theirs = checks.filter((c) => c.command);
    const buildSaid = (c) => `"${c.name}"'s check build \`${c.build}\` failed${c.error ? `, and its last line says: "${one(c.error)}"` : ''}`;
    const parts = [...built.map(buildSaid), ...(mine.length ? [`${andList(mine.map(label))} ${mine.length === 1 ? 'is' : 'are'} failing, and ${REPAIRED} ${mine.length === 1 ? 'it' : 'them'}`] : []),
      ...theirs.map((c) => `${label(c)} needs a step outside GitHub: ${c.command}`)];
    const fix = [...built, ...mine];
    const todo = fix.length ? `${built.length ? 'Send it back to a worker on the PR with what to fix, or fix' : 'Fix'} ${fix.length === 1 ? 'it' : 'them'} on its branch${theirs.length ? ', and do that step' : ''}` : `Do ${theirs.length === 1 ? 'that step' : 'those steps'}`;
    const said = mine.filter((c) => c.error).map((c) => ` "${c.name}" says: "${one(c.error)}".`).join('');
    return `${n}: ${parts.join('; ')}.${said} ${todo}; ${thenMerge(r)}.`;
  }
  const why = String(s?.why ?? '');
  const shots = CAPTURE.exec(why);
  if (shots) {
    const k = Number(shots[1]);
    return `${n} is a draft, and desk's capture try could not take ${k === 1 ? 'one of its screenshots' : `${k} of its screenshots`}, so nothing desk has can fill ${k === 1 ? 'its cell' : 'their cells'}. Edit the PR body so no cell is left; the next pass then takes it out of draft.`;
  }
  const tagged = personGapsIn(why);
  const accepts = tagged.filter(acceptOnly);
  const personGaps = tagged.filter((g) => !acceptOnly(g)).map(one).join('; ');
  const toAccept = accepts.length && t?.result?.pr ? `${accepts.length === 1 ? 'a requirement gap' : 'requirement gaps'} only you can accept: ${acceptNeed(t.result.pr, ghRepoOf(r), accepts.map(one), prEvidence(r, t, reads, accepts))}` : '';
  const settleYours = personGaps ? `requirement gaps only you can settle: ${personGaps}. Say how to settle them; a worker on the PR carries out your call.` : '';
  const yours = [settleYours, toAccept && (settleYours ? `It also left ${toAccept}` : toAccept)].filter(Boolean).join(' ');
  if (yours && !/^review not clean/.test(why)) return `${n}'s code review left ${yours}`;
  // Before the conflict test: a review reason names the conflict tries it was made after.
  if (/^review not clean/.test(why)) {
    const left = stuckFindings(why);
    const named = left.length ? `: ${left.map((f) => `${f.sev} ${one(f.text)}`).join('; ')}` : '';
    return `${n}'s code review still has findings ${repairsMade(why) ?? REPAIRED}${named}. ${left.length ? 'Send it back to a worker for one more try, or fix' : 'Fix'} them on its branch and post a fresh review; ${thenMerge(r)}.${yours ? ` It also left ${yours}` : ''}`;
  }
  const fb = /^review feedback still open[^:]*: (.+)$/.exec(why);
  if (fb) return `${n} still has review feedback open ${REPAIRED}: ${one(fb[1])}. Answer and resolve it, or fix it on its branch; ${thenMerge(r)}.`;
  // Before the conflict test too: this reason ends with what the last review try's worker said.
  if (/^no review verdict/.test(why)) {
    const said = /; the last try said: (.+)$/.exec(why)?.[1];
    const k = /after (\d+) review tr(?:y|ies) at it/.exec(why)?.[1];
    const ran = k ? `: desk's review ran on it ${k === '1' ? 'once' : k === '2' ? 'twice' : `${k} times`} and posted none it can read${said ? `, and the last one said "${plainWords(said)}"` : ''}` : '';
    // The verdict step the check failed at, as gateTry quotes it.
    const step = /: its ("[^"]+") check says: (.+?)(?:; the last try said: .+)?$/.exec(why);
    const failed = step ? ` Its ${step[1]} check failed its verdict step: "${one(step[2])}".` : '';
    return `${n} has no code review desk can read for its latest commit${ran}.${failed} Post one (run /desk-review on it); the next pass then takes it on.`;
  }
  if (/conflict/.test(why)) return conflictPlain(r, t, n, r.ctx?.base, why);
  const red = /^still red[^:]*:\s*(.+)$/.exec(why);
  if (red) return `${n} has failing checks ${REPAIRED}: ${plainWords(red[1])}. Fix them on its branch; ${thenMerge(r)}.`;
  return `${n} is stuck where desk can not move it${why ? ` (${plainWords(why)})` : ''}. Settle it on GitHub; the next pass then picks it up.`;
}

// `gapLines`: the gaps its review lists (draftGapsOf), quoted after their count; null when they could
// not be read, which the need says.
function draftPlain(r, n, u, gapLines = null, t = null, reads = null) {
  const why = String(u?.why ?? '');
  const dirty = /not clean \(([^)]*)\)/.exec(why);
  if (dirty) {
    const kv = dirty[1].split(/\s+/).filter(Boolean).map((p) => p.split('=')).filter(([, v]) => Number(v) > 0);
    const found = kv.filter(([k]) => /^p\d$/i.test(k)).map(([k, v]) => `${v} ${k.toUpperCase()}`);
    const gaps = Number(kv.find(([k]) => k === 'gaps')?.[1] ?? 0);
    const what = andList([...(found.length ? [`${andList(found)} finding${found.length === 1 && found[0].startsWith('1 ') ? '' : 's'}`] : []), ...(gaps ? [`${gaps} requirement gap${gaps === 1 ? '' : 's'}`] : [])]);
    const settle = `Say how to settle ${gaps === 1 && !found.length ? 'it' : 'them'}; a worker on the PR carries out your call.`;
    // Gaps only the person's own comment accepts are given the ready comment, not a call to say.
    const accepts = t?.result?.pr ? (gapLines ?? []).filter(acceptOnly) : [];
    if (gaps && accepts.length) {
      const rest = gapLines.filter((g) => !accepts.includes(g)).map((g) => one(g).replace(/[.;]$/, ''));
      const toAccept = `${accepts.length === 1 ? 'The gap' : 'Gaps'} only you can accept: ${acceptNeed(t.result.pr, ghRepoOf(r), accepts.map(one), prEvidence(r, t, reads, accepts))}`;
      return `${n} is a draft, and its code review left ${what}${rest.length ? `: ${rest.join('; ')}. ${settle}` : '.'} ${toAccept}`;
    }
    if (gaps && gapLines?.length) return `${n} is a draft, and its code review left ${what}: ${gapLines.map((g) => one(g).replace(/[.;]$/, '')).join('; ')}. ${settle}`;
    if (gaps) return `${n} is a draft, and its code review left ${what}. Desk could not read the review to quote ${gaps === 1 ? 'the gap' : 'the gaps'}, so read ${gaps === 1 ? 'it' : 'them'} on the PR. ${settle}`;
    // No fix try ran on these: one that did and ran out is stuck (stuckPlain), so the reason is the review's.
    const it = found.length === 1 && found[0].startsWith('1 ') ? 'it' : 'them';
    const unsent = kv.some(([k]) => k === 'deferred') ? `which it marks deferred, so desk sends no worker to ${it}` : `which it does not list with a file:line a worker can fix, so desk sends no worker to ${it}`;
    if (what) return `${n} is a draft, and its code review found ${what}, ${unsent}. Fix ${it} on its branch and post a fresh review; the next pass then takes it out of draft.`;
  }
  // A check the runner ended (undraft.mjs rerunCall): no change on its branch clears it.
  const ended = u?.call === 'person' && /^its (.+?) check was ended by the runner([^:]*): (.+?)(?:; config §3 ci-rerun is "([^"]*)", so desk is not granted a rerun)?$/.exec(why);
  if (ended) {
    const lead = `${n} is a draft, and its ${ended[1]} check was ended by the runner, not by its code: ${one(ended[3])}`;
    if (ended[4] != null) return `${lead}. Desk is not granted reruns (config §3 ci-rerun is "${ended[4]}"), so re-run it yourself, and if it fails the same way, ${RUNNER_FIX}; the next pass then picks it up.`;
    if (/refused/.test(ended[2])) return `${lead}. GitHub refused desk's reruns of it, so re-run it yourself, and if it fails the same way, ${RUNNER_FIX}; the next pass then picks it up.`;
    return `${lead}, after desk re-ran it once. Nothing on its branch fixes that: ${RUNNER_FIX}, then re-run it; the next pass then picks it up.`;
  }
  if (/Clean review verdict is not set/.test(why)) return `${n} is a draft, and desk can not read its code review because §4 Clean review verdict is not set. Set it with /desk-setup; the next pass then reads the review.`;
  if (/clean and green/.test(why)) return `${n} is a draft with a clean review and green checks. Undraft it; ${thenMerge(r)}.`;
  if (!u) return `${n} is a draft with no review recorded. Review it, then undraft it; ${thenMerge(r)}.`;
  return `${n} is a draft: ${plainWords(why.replace(/^its? /, ''))}. ${capital(plainWords(u.action ?? 'settle it'))}; the next pass then picks it up.`;
}

// A PR into the default branch under a §4 Merge hold (desk-q parseHoldNote): the hold's step comes
// first, so the need names it, or the routine desk ran and the step it failed at.
function holdPlain(n, w, done = null) {
  const files = w.where ? ` (${one(w.where)})` : '';
  if (w.failed) {
    return `${n} touches files under a merge hold${files}, and desk ran its routine, \`${w.routine}\`, at ${w.failed.sha}: it failed (exit ${w.failed.exit}) at "${one(w.failed.step)}". Settle that step and finish the routine by hand, then merge it on GitHub; the ticket is then done.`;
  }
  const step = `${n} touches files under a merge hold${files}, and its step comes before the merge: ${one(w.why)}.`;
  // Only a routine held back by the §3 row is one the row can hand to desk; one held by a hold with no
  // routine stays the person's even with the row on.
  if (w.routine && /^§3 /.test(w.off ?? '')) return `${step} desk can run its routine, \`${w.routine}\`, but ${w.off}. Run it yourself, then merge it on GitHub (or set that row to yes with /desk-setup, and desk runs it and merges); the ticket is then done.`;
  if (w.routine) return `${step} desk can run its routine, \`${w.routine}\`, but ${w.off ?? 'it was not run'}. Run it and take that step yourself, then merge it on GitHub; the ticket is then done.`;
  // With no routine, a step an agent can check is a gap in the config, not the person's to take.
  if (!holdNeedsPerson(w.why)) return `${n} is under a merge hold whose step an agent can check, but the hold names no routine, so desk cannot run it: "${one(w.why)}"${files}. Give this hold a routine: /desk-update proposes one (\`; desk runs: <command>\` on its §4 Merge holds item, with §3 merge-hold-routine yes); desk then runs it and merges.`;
  // Otherwise the hold's reason is the step the person takes before merging, unless it reads done.
  if (done) return `${n} is under a merge hold, so desk never merges it itself: "${one(w.why)}"${files}. Its step is done: the PR changes ${andList(done.map((f) => `\`${f}\``))}, and its checks are green. Only the merge is left: merge it on GitHub; the ticket is then done.`;
  return `${n} is under a merge hold, so desk never merges it itself: "${one(w.why)}"${files}. Do what it asks first, then merge it on GitHub; the ticket is then done.`;
}

// The files a hold's reason names: a backticked path, a path with a slash, or a file name with one of
// these extensions. A script is a step to run, not a file the step changes, so it is left out.
const HOLD_FILE = /`([^`\s]+)`|(?<![\w/.:-])((?:[\w.-]+\/)+[\w.*-]+|[\w.-]+\.(?:md|json|ya?ml|txt|toml|csv))(?![\w/-])/gi;
const SCRIPT = /\.(?:sh|py|[cm]?[jt]s|rb)$/i;
const holdFiles = (why) => [...new Set([...String(why ?? '').matchAll(HOLD_FILE)].map((m) => (m[1] ?? m[2]).replace(/[.,;:]+$/, ''))
  .filter((p) => /[/.]/.test(p) && !SCRIPT.test(p)))];
// The path a hold note's `where` names first (merge-driver.sh: `<glob>, <n> file(s), e.g. <file>`),
// without the `#<key>` of a keyed hold (gate.mjs parseHolds: `<glob>#<key>` guards one key of that file).
const holdGlob = (where) => /^(.+?), \d+ file\(s\)/.exec(String(where ?? ''))?.[1]?.replace(/#.*$/, '') || null;
// A person's merge hold whose step reads done on GitHub: the PR changes every file its reason names
// (a sign-off or approval file), and its checks at its head are green. -> those files, or null when the
// reason names none, one is unchanged, a check is not green, the PR touches another hold with no
// routine (the note counts it as `more`), or the PR cannot be read. A name that is a glob, or a path the
// hold itself guards, is not a sign-off file: the PR changes it only because it is under the hold, so it
// says nothing of the step.
function holdStepDone(r, t, w, reads) {
  const glob = holdGlob(w.where), guarded = glob ? globToRegExp(glob) : null;
  const named = holdFiles(w.why).filter((p) => !p.includes('*') && !(guarded && (p === glob || guarded.test(p))));
  if (!named.length || w.routine || w.failed || w.more || !holdNeedsPerson(w.why)) return null;
  const { v } = reads.pr(r, t.result.pr, ',files,statusCheckRollup');
  if (v?.state !== 'OPEN') return null;
  const changed = (v.files ?? []).map((f) => String(f?.path ?? ''));
  if (!named.every((p) => changed.includes(p))) return null;
  const checks = latestPerCheck(normaliseRollup(v.statusCheckRollup));
  return evaluateGate(checks, { required: r.ctx?.required ?? [], advisory: r.ctx?.advisory ?? [] }).state === 'pass' ? named : null;
}

// ---- A red check that wants a person's approval, as its error line says: a review gate on protected
// files or over its file limit, in the wording of desk's review-gate.mjs or a repo's own gate.
const FILE_WORDS = [[/(^|\/)migrations?\//, 'a database migration'], [/(^|\/)schema\.(prisma|sql)$/, 'the database schema']];
const fileWords = (f) => FILE_WORDS.find(([re]) => re.test(f))?.[1] ?? `\`${f}\``;
// What `line` asks for, or null where it names neither cause: { why, then }, the reason and what else it says.
function approvalCause(line) {
  const s = String(line ?? '');
  if (!/approv/i.test(s)) return null;
  const prot = approvalFiles(s);
  const over = /\*{0,2}(\d+)\*{0,2} changed files, over the (\d+)-file limit/.exec(s);
  if (!prot && !over) return null;
  const { files, more } = prot ?? { files: [], more: 0 };
  const named = [...new Set(files.map(fileWords)), ...(more > 0 ? [`${more} more protected file${more === 1 ? '' : 's'}`] : [])];
  const why = [...(named.length ? [`it changes ${andList(named)}`] : []), ...(over ? [`it has ${over[1]} changed files, over the ${over[2]}-file limit`] : [])].join(', and ');
  const stale = /— and (.+?)'s approval predates/.exec(s)?.[1] ?? /\. ([^.]+?) approved an earlier commit/.exec(s)?.[1];
  return { why, then: stale ? ` ${stale} approved an earlier commit, so it needs approving again.` : '' };
}
// The role §4 People gives an approval to: the code reviewer, else the product owner, by name.
function approverOf(r) {
  const row = ['code-reviewer', 'product-owner'].map((id) => repoConfigValue(r.slug, id)).find((v) => v && !isNone(v));
  if (!row) return 'approval from a person with approval rights';
  if (/^you\b/i.test(row)) return 'your approval';
  return `${row.split(/\s*[(,]|\s+@|\s+[—–-]\s/)[0] || row}'s approval`;
}
// The approval holding an unmerged PR: { cause, names, left }, the red checks asking for it and the
// others holding the PR beside them; null where no check's error asks for one, or a reason that is not
// its checks holds the PR.
function approvalAsk(t, w) {
  const held = w.code === 'red' ? w.names : w.code === 'approval' ? []
    : w.code !== 'stuck' ? null : w.stuck.checks.length ? w.stuck.checks.map((c) => c.name) : /^still red/.test(String(w.stuck.why ?? '')) ? [] : null;
  if (!held) return null;
  const asks = (t.pr_status?.checks ?? []).filter((c) => approvalCause(c.error));
  if (!asks.length) return null;
  const names = new Set(asks.map((c) => c.name));
  return { cause: approvalCause(asks[0].error), names, left: held.filter((x) => !names.has(x)) };
}

// An unmerged PR's need, from the reason desk-q has it need the person (prWhy).
// `reads` (READS) lets a merge hold's need read whether its step is done; without it none is read.
function prPlain(r, t, gapLines = null, reads = null) {
  const n = `PR #${t.result.pr}`;
  const w = prWhy(r, t) ?? {};
  const ask = approvalAsk(t, w);
  const needsIt = ask && `needs ${approverOf(r)}: ${ask.cause.why}.${ask.cause.then}`;
  if (ask && !ask.left.length) return `${n} ${needsIt} No code change clears it, only an approving review on GitHub at its latest commit; ${thenMerge(r)}.`;
  // Beside other red checks, those are worded as ever, and the approval is said after them.
  const also = ask ? ` It also ${needsIt}` : '';
  switch (w.code) {
    case 'closed': return `${n} was closed without merging, so nothing will merge it. Drop the ticket, or requeue it; a requeued ticket gets a worker that opens a new PR.`;
    case 'stuck': return `${stuckPlain(r, n, ask ? { ...w.stuck, checks: w.stuck.checks.filter((c) => !ask.names.has(c.name)) } : w.stuck, t, reads)}${also}`;
    case 'spine': return `${n} is the feature spine, still a draft. Approve its acceptance specs; desk then takes it out of draft.`;
    case 'skipped': return `${n} is a draft, and CI does not run on drafts, so its checks were skipped. Undraft it so they run; ${thenMerge(r)}.`;
    case 'draft': return draftPlain(r, n, w.undraft, gapLines, t, reads);
    case 'hold': return holdPlain(n, w, reads && holdStepDone(r, t, w, reads));
    case 'feedback': return `${n} is held for review: ${one(w.text)}. Resolve or answer it; desk then merges it.`;
    case 'approval': return `${n} waits on a person's approval: ${plainWords(w.text).replace(/: a person approves it before desk merges it$/, '')}. Review and approve it on GitHub; desk then merges it.`;
    case 'merge-ref': return `${n} looks stuck on GitHub: ${plainWords(w.text).replace(/: push a new commit .*$/, '')}. Push a new commit to its branch (an empty one will do) for a fresh merge ref, or open a new PR from it; desk then merges it once it is green.`;
    case 'conflict': return conflictPlain(r, t, n, w.base);
    case 'red': {
      const red = ask ? ask.left : w.names;
      return `${n} has ${red.length === 1 ? 'a failing check' : `${red.length} failing checks`}, ${andList(red.map((c) => `"${c}"`))}, and nothing here re-runs or repairs ${red.length === 1 ? 'it' : 'them'}. Fix or re-run ${red.length === 1 ? 'it' : 'them'}; ${thenMerge(r)}.${also}`;
    }
    case 'trigger': return `${n} is not green: ${one(w.text)}. Re-running cannot help, as no run exists: add ${w.base ?? 'its base'} (or a pattern such as feat/**) to the pull_request branches of the workflow that runs ${andList(w.names.map((c) => `"${c}"`))}, a change to the repo; its next push then runs the check, and ${thenMerge(r)}.`;
    case 'behind': return `${n} is not green: ${one(w.text)}. Nothing here may sync ${w.base ?? 'its base'}: merge the default branch into it, then close and reopen ${n} so its checks run; ${thenMerge(r)}.`;
    case 'gate': return `${n} is not green: ${plainWords(w.text ?? 'a required check did not pass')}. Fix that check, or §4 Required checks if it should not be required; ${thenMerge(r)}.`;
    case 'green': return `${n} has ${w.checks === 1 ? 'its check' : `all ${w.checks} checks`} green${w.advisory ? ` (${w.advisory} advisory failed, which holds nothing)` : ''}, and desk may not merge in this repo. Merge it on GitHub; the ticket is then done.`;
    case 'running': return `${n}${w.checks ? `'s checks are still running (${w.done} of ${w.checks} done)` : ' has no checks reported yet'}, and desk may not merge in this repo. Merge it on GitHub once its checks are green; the ticket is then done.`;
    default: return `${n} is waiting on you. Settle it on GitHub; the next pass then picks it up.`;
  }
}

// What GitHub showed the last time the person said done on a PR, while its head is the one it showed.
// It is the item's `note`, which listText prints whole after the need.
function doneNote(t) {
  const d = t.done_check;
  if (!d || (d.head ?? null) !== (t.pr_status?.head ?? null)) return '';
  const shown = d.cells ? `with ${d.cells} screenshot cell(s) left` : d.state === 'CLOSED' ? 'closed without merging' : `unmerged${d.draft ? ', still a draft' : ''}`;
  return `(You said done at ${utc(d.at)}, and GitHub still showed it ${shown}.)`;
}

// The batches `word` names: a repo's name is all of its batches, `<repo>:<name>` one named batch.
function batchesNamed(repos, word) {
  const r = resolveRepo(repos, word);
  return { named: r, scope: r.batch ? [r] : repos.filter((x) => x.slug === r.slug) };
}

// Who moves the repo's batch on once an answer is recorded: its supervisor, a live session (named by
// its batch, as the orchestrator is), or nothing while passes are stopped.
export function runner(r) {
  if (!r.live) return { by: 'stopped', resume: resumeOf(r) };
  return r.run?.by === 'supervisor' ? { by: 'supervisor' } : { by: 'session', name: r.q?.batch ?? null };
}

// The other batches of r's repo a parked or stopped ticket can be moved into, read here on every refresh
// and judged finished from the queues alone; queue.mjs transfer asks GitHub when the move is made.
// -> [{ name, base, word }], the standing batch's name null.
const MOVABLE = ['parked', 'stopped'];
export function moveTargets(r) {
  try {
    checkoutOf(r, 'list its batches');
    return otherRunningBatches(r.slug, r.queuePath, () => defaultOf(r), finishedOnRecord).map(moveTarget);
  } catch { return []; /* no checkout to move it in: nothing to offer */ }
}
const moveAction = (r) => { const ts = moveTargets(r); return ts.length ? [['move', null, moveOffer(ts)]] : []; };

// The open blockers outside its batch the last pass recorded for a ticket (pass.mjs outside_blockers),
// each with its Jira status category and the batch of this repo holding it: `standing`, a named
// batch, or null for none. A key two batches hold reads as held, so it is never offered to admit.
function outsideHolds(r, t) {
  return outsideOf(t).map((b) => {
    let at;
    try { at = batchHolding(b.key, r.slug); } catch { at = { name: 'more than one batch' }; }
    return { key: b.key, category: b.category ?? 'new', batch: at ? (at.name ?? 'standing') : null, ...('assignee' in b ? { assignee: b.assignee } : {}) };
  });
}
// Why the person would not queue blocker `o` (one outsideHolds returns), or null when it is theirs to:
// in To Do, in this repo's §4 Jira project (`project`), and unassigned or assigned to them (`owner`, §1
// Jira display name, as plan-batch tests it). An assignee never read is no one's to assume.
export function notAdmittable(o, { project, owner }) {
  const why = [];
  if (o.assignee === undefined) why.push('its assignee could not be read');
  else if (o.assignee !== null && o.assignee !== owner) why.push(`it is assigned to ${o.assignee}`);
  const p = String(o.key).replace(/-\d+$/, '');
  if (p !== project) why.push(project ? `it is in Jira project ${p}, not ${project}` : `this repo's config names no Jira project to match ${p} against`);
  if (o.category !== 'new') why.push(`it is ${(JIRA_CATEGORY[o.category] ?? o.category).toLowerCase()}`);
  return why.length ? `${o.key}: ${why.join(', and ')}` : null;
}
const admitRules = (r) => ({ project: repoConfigValue(r.slug, 'jira-project'), owner: repoConfigValue(r.slug, 'jira-display-name') ?? repoConfigValue(r.slug, 'name') });
const batchWords = (o) => (o.batch ? `in batch ${o.batch}` : 'in no batch');
const holdWords = (o) => `${o.key} (${(JIRA_CATEGORY[o.category] ?? o.category).toLowerCase()}, ${batchWords(o)})`;
// A blocker's state as a put-off input: done (in the batch, or Done in Jira), none (in neither the batch
// nor the recorded outside blockers), else open. A blocker moving between in-flight stages (triaged,
// running, parked, a Jira status short of Done) is not a change, or every pass would bring it back. A
// `+yours` mark (blockerStates) is kept. Reads both this form and the one entries recorded before it: a
// batch stage, or `<category>@<batch>`.
const settledOf = (s) => {
  const str = String(s), yours = str.endsWith('+yours') ? '+yours' : '';
  const v = str.slice(0, str.length - yours.length).split('@')[0];
  return `${v === 'done' || v === 'none' ? v : 'open'}${yours}`;
};
const blockerList = (pairs) => pairs.map(([b, s]) => [b, settledOf(s)]).sort(([a], [b]) => a.localeCompare(b)).map(([b, s]) => `${b}:${s}`).join(',');
// Every blocker a ticket names, in its batch or outside it, with its settled state: a put-off item's
// input, so a blocker added, removed or done brings it back. One in no batch that is the person's to
// queue (notAdmittable) is marked `+yours`, so a blocker put off as someone else's comes back once it is
// unassigned or theirs.
function blockerStates(r, t) {
  const holds = outsideHolds(r, t), rules = holds.some((o) => !o.batch) ? admitRules(r) : null;
  const yours = (o) => (!o.batch && !notAdmittable(o, rules) ? '+yours' : '');
  const out = new Map(holds.map((o) => [o.key, `${o.category}${yours(o)}`]));
  return blockerList([...new Set([...blockersOf(t), ...out.keys()])].map((b) => [b, r.q.tickets?.[b]?.state ?? out.get(b) ?? 'none']));
}
// An outside hold put off as its need without the Jira status of each blocker, which moves in flight.
const LEGACY_HOLD = /\((?:[^,()]+), (in batch [^()]*|in no batch)\)/g;
// An item's action names, once each: what a put-off entry records, so one it gains brings it back.
const verbsOf = (item) => [...new Set(item.actions.map(([a]) => a.split(' ')[0]))];

// A batch held on a usage limit is one item, named by this in place of a ticket: its paused workers
// and held tickets are none of them stopped, so none is an item of its own.
const USAGE_ITEM = 'usage-limit';
const usageRow = (r) => (usageHoldOf(r) ? { t: { key: USAGE_ITEM }, usage: true } : null);
// A supervised batch whose base is behind while §3 batch-base-push is `ask` (pass.mjs base_push_ask)
// is one item, named by this, until its approval is on the queue: the supervisor passes
// `approved.base_push` to every later pass of the batch.
const BASE_PUSH_ITEM = 'base-push';
const basePushRow = (r) => (r.q?.base_push_ask && r.q.approved?.base_push !== true ? { t: { key: BASE_PUSH_ITEM }, basePush: true } : null);
// A batch whose repo is pinned to a subscription set off (pass.mjs subscription_off) is one item, named
// by this: no new work of the repo starts until the person moves the pin or sets the subscription unused.
const SUB_OFF_ITEM = 'subscription-off';
const subOffRow = (r) => (r.q?.subscription_off?.email ? { t: { key: SUB_OFF_ITEM }, subOff: true } : null);
// A batch whose base sync failed while that holds every spawn (pass/batch-base.mjs base_sync_stuck) is
// one item, named by this: every ticket ready to spawn waits on it, so it is listed first.
const BASE_SYNC_ITEM = 'base-sync';
const baseSyncRow = (r) => (r.q?.base_sync_stuck?.base ? { t: { key: BASE_SYNC_ITEM }, baseSync: true } : null);
const batchRows = (r) => [baseSyncRow(r), usageRow(r), basePushRow(r), subOffRow(r)].filter(Boolean);
// The base-sync, base-push and subscription-off items desk-q counts, one per batch of a repo row (each
// keyed in its batch, `b`): unlike a usage hold none lifts by itself, so each needs the person.
const countedBatchRows = (r) => (r.batches ?? [r]).flatMap((b) => [baseSyncRow(b), basePushRow(b), subOffRow(b)].filter(Boolean).map((x) => ({ ...x, b })));

// ---- repo-level items: one for the repo, not one per ticket ------------------------------------
// A §3 row the repo's config does not set reads as `no`, so every ticket whose worker needed it parks
// on it. The row is answered once (/desk-update asks each row the config lacks), so the tickets parked
// naming it are one item, `unset:<key>`, and its done requeues them all.
const UNSET = 'unset:';
const FIXED_ROWS = new Set(['slack-send', 'merge-bypass', 'others-prs', 'product-calls', 'legal-content']);
const ROW_KEYS = Object.keys(PERMISSION_KEYS).filter((k) => !FIXED_ROWS.has(k));
const namesRow = (text, key) => new RegExp(`(^|[^a-z0-9-])${key}([^a-z0-9-]|$)`).test(text);
const rootOf = (r) => repoConfigValue(r.slug, 'repo-root') ?? r.repo;
const finite = (n) => (Number.isFinite(n) ? n : null);
function unsetRowOf(r, t, unsetIn) {
  const q = String(t.park?.question ?? '');
  return ROW_KEYS.find((k) => namesRow(q, k) && unsetIn(r.slug, k)) ?? null;
}
function unsetItem(g) {
  const keys = g.parked.map((p) => p.t.key);
  const n = keys.length;
  return { kind: 'config', repoLevel: true, parked: g.parked,
    need: `${n === 1 ? 'A ticket' : `${n} tickets`} (${andList(keys)}) parked because ${g.r.repo}'s desk config does not say whether workers may ${GRANT_WORDS[g.key] ?? 'take the step they need'}, so they can't. Answer it once with /desk-update in ${rootOf(g.r)}, then say done and ${n === 1 ? 'it goes' : 'each goes'} back to a worker`,
    actions: [['done', `once you have answered it, done sends ${n === 1 ? 'the ticket' : `all ${n} tickets`} parked on it back to a worker`], ['not-now']] };
}
// A ticket admitted headless whose claude.ai artifact (a design, a spec page) no session has read parks
// on it (batch-state designPark): only a session that can answer the platform's prompt to read one made
// outside the organisation can. One session reads them all, so every such ticket of the repo is one
// item, `artifacts`, naming each artifact and its tickets; its done requeues each ticket whose
// artifacts all have a copy now.
const ARTIFACTS = 'artifacts';
function artifactsItem(g) {
  const keys = g.parked.map((p) => p.t.key);
  const n = keys.length;
  const urls = [...new Set(g.parked.flatMap((p) => p.urls))];
  const each = urls.map((u) => `${u} (${andList(g.parked.filter((p) => p.urls.includes(u)).map((p) => p.t.key))})`);
  return { kind: ARTIFACTS, repoLevel: true, parked: g.parked,
    need: `${n === 1 ? 'A ticket' : `${n} tickets`} (${andList(keys)}) ${n === 1 ? 'links' : 'link'} ${urls.length === 1 ? 'a claude.ai artifact' : `${urls.length} claude.ai artifacts`} no session has read, so no worker can: ${each.join('; ')}. Read ${urls.length === 1 ? 'it' : 'them all'} in one interactive session in ${rootOf(g.r)} with /desk-admit ${keys.join(' ')}, which saves each (you answer once whether Claude may read one made outside your organisation), then say done and ${n === 1 ? 'it goes' : 'each goes'} back to a worker`,
    actions: [['done', `once ${urls.length === 1 ? 'it is' : 'they are'} saved, done sends each ticket whose artifacts all have a copy back to a worker`], ['not-now']] };
}
// The copies saved under the repo's Design canvases directory on its batch's base, as desk-design's
// savedAt reads them (origin/<base> where fetched), or none.
function savedOnBase(r) {
  const dir = String(repoConfigValue(r.slug, 'design-dir') ?? 'docs/design/').trim().replace(/\/+$/, '');
  if (!dir || /^none$/i.test(dir)) return [];
  const base = r.q?.base ?? defaultOf(r);
  for (const ref of [`origin/${base}`, base]) { try { return savedAt(rootOf(r), dir, ref); } catch { /* no such ref */ } }
  return [];
}
// Done on the artifacts item: each ticket whose every artifact has a copy, a snapshot or one saved on
// its base, is requeued in its own batch (or named for the live session that runs it); the rest stay,
// naming what is still unread.
function artifactsDone(i, say) {
  const ready = [], unread = [];
  for (const p of i.parked) {
    const saved = savedOnBase(p.r);
    const missing = p.urls.filter((u) => !snapshotOf(p.r.stateDir, u) && !saved.some((c) => canonicalUrl(c.url) === canonicalUrl(u)));
    if (missing.length) unread.push(`${p.t.key} (${missing.join(', ')})`); else ready.push(p);
  }
  const { refused, parts, first } = requeueParked(ready);
  if (unread.length) parts.push(`still no copy of ${andList(unread)}, so ${unread.length === 1 ? 'it stays' : 'they stay'} parked: run /desk-admit for ${unread.length === 1 ? 'it' : 'them'} in a session`);
  return say(!refused.length && !unread.length, `${parts.join('; ')}.`,
    first ? { to: first[0], text: `${andList(first[1])} parked on a claude.ai artifact that now has a copy: requeue ${themOf(first[1])} (node ~/.claude/desk/bin/queue.mjs requeue <TICKET>).` } : null);
}
// Sends each parked ticket back to a worker: requeued in its own batch, or named for the live session
// that runs it. `parts` is the answer's line, a clause each; `first` the first session to message.
const themOf = (ks) => (ks.length === 1 ? 'it' : 'them');
function requeueParked(parked) {
  const requeued = [], refused = [], bySession = new Map();
  for (const p of parked) {
    const w = runner(p.r);
    if (w.by === 'session') { const s = w.name ?? '(no batch name recorded)'; bySession.set(s, [...(bySession.get(s) ?? []), p.t.key]); continue; }
    const q = queueCmd(p.r, ['requeue', p.t.key]);
    if (q.ok) requeued.push(p.t.key); else refused.push(`${p.t.key} (${q.out})`);
  }
  const parts = [...(requeued.length ? [`requeued ${andList(requeued)}; the next pass can spawn ${themOf(requeued)}`] : []),
    ...(refused.length ? [`the requeue was refused for ${andList(refused)}`] : []),
    ...[...bySession].map(([s, ks]) => `a live session (${s}) runs ${andList(ks)}: message it to requeue ${themOf(ks)}`)];
  const [first] = bySession;
  return { refused, parts, first };
}
// A committed copy of a desk template (the pre-push hook, the desk gate) the template has moved on
// from, as the supervisor's last template check found it (repo-templates.mjs): one item for the repo.
const TEMPLATES = 'templates';
function templatesItem(r, rec) {
  const behind = (rec?.files ?? []).filter((f) => f.status === 'BEHIND');
  if (!behind.length) return null;
  const paths = behind.map((f) => f.path);
  return { kind: 'templates', repoLevel: true,
    need: `${r.repo}'s committed ${andList(paths)} ${paths.length === 1 ? 'is' : 'are'} behind desk's template, which changed since ${paths.length === 1 ? 'its copy was' : 'the copies were'} made. Run /desk-update in ${rootOf(r)}: it shows what changed and opens one PR, off ${String(rec.ref ?? 'the default branch').replace(/^origin\//, '')}, that applies the template's changes and keeps this repo's own edits. Merge it, then say done`,
    actions: [['done', 'once that PR has merged, done checks the copies again and the item leaves the list'], ['not-now']],
    since: finite(Math.min(...behind.map((f) => timeOf(f.since) ?? timeOf(rec.at) ?? Infinity))) };
}
const standingOf = (repos, r) => repos.find((x) => x.slug === r.slug && x.batch == null) ?? r;

// ---- the person's steps: one item for each, not one per ticket waiting on it ---------------------
// A blocker in no batch that is a step only the person takes holds the merge of every ticket admitted
// behind it (merge_after), or, held in full (held_outside, read as the person's step by desk-q's
// personStepOf), its build. The step is one item, `step:<KEY>`, for the repo however many of its
// batches have a ticket waiting on it, naming every ticket waiting to start and every PR and ticket
// waiting to merge in each; the pass lifts the hold once Jira has the step Done, so done records
// nothing. `batches` are one repo's; each item is shown in `r`, the standing batch where it is one of
// them, else the first by name with a ticket waiting, and is put off in `dir`, always the standing
// batch's state folder, so desk-q's count over any of the repo's batches and this list read one register.
const STEP = 'step:';
const standingDir = (b) => (b.batch == null ? b.stateDir : resolve(b.stateDir, '..', '..'));
// The steps in no batch of `q` that hold held ticket `t`'s build, or a triage park's, by `stepOf`
// (personStepOf). Only those still in its held_by: a person's release leaves held_outside behind (queue.mjs).
const startSteps = (q, t, stepOf) => (holdsKept(t) ? keysOf(t.held_outside).filter((k) => blockersOf(t).includes(k) && !q?.tickets?.[k] && stepOf?.(t.key, k)) : []);
// A needs row whose hold needs nothing but such a step: the step's item lists it, so it is not one of its own.
const stepHeld = (b, x) => !heldAsks(x.t) && holdShown(b.q, x.t, b.ctx)?.step != null;
// Every ticket in any of the repo's batches waiting on the step, read from the queues on disk, so a
// step is put off under the same inputs whichever of the repo's batches a caller passed. `at(dir)` is
// the listing's object for state folder `dir`, which triageOf reads each record through once.
const waitingOn = (slug, key, at) => listBatches(slug)
  .flatMap((b) => {
    let q;
    try { q = readQueue(b.queue); } catch { return []; /* no queue there */ }
    const stepOf = personStepOf(at(b.state), slug);
    return Object.values(q.tickets ?? {}).filter((t) => keysOf(t.merge_after).includes(key) || startSteps(q, t, stepOf).includes(key));
  })
  .filter((t) => !t.merged_at && t.state !== 'failed').map((t) => t.key).sort();
// Whether ticket `t`'s merge_after key `k` is no step of the person's but a blocker triage called needed
// only to merge (batch-state.mjs triageGate): another ticket's code, which the pass lifts once it is Done
// and landed, with nothing for the person to do.
const mergeGate = (b, t, k) => {
  const rec = triageOf(b, t.key);
  const bl = (Array.isArray(rec?.blockers) ? rec.blockers : []).find((x) => x?.key === k);
  return triageGate(bl, rec, personStepLabels(b.slug), personInputLabels(b.slug));
};
function stepItems(batches) {
  const waits = new Map();
  const add = (k, w) => waits.set(k, [...(waits.get(k) ?? []), w]);
  for (const b of batches) {
    for (const t of Object.values(b.q?.tickets ?? {})) {
      if (t.merged_at || t.state === 'failed') continue;
      const starts = startSteps(b.q, t, b.ctx?.stepOf);
      for (const k of starts) add(k, { b, t, start: true });
      for (const k of keysOf(t.merge_after)) if (!starts.includes(k) && !mergeGate(b, t, k)) add(k, { b, t });
    }
  }
  const standing = batches.find((b) => b.batch == null);
  // A batch this listing loaded reads its triage records through its own object, and one it did not
  // through one made here once, so every step item shares the reads.
  const byDir = new Map(batches.map((b) => [b.stateDir, b]));
  const at = (dir) => byDir.get(dir) ?? byDir.set(dir, { stateDir: dir }).get(dir);
  return [...waits].map(([key, ws]) => {
    const r = standing ?? ws.map((w) => w.b).sort((a, c) => String(a.batch).localeCompare(String(c.batch)))[0];
    return { r, dir: standingDir(r), in: new Set(ws.map((w) => w.b)), t: { key: `${STEP}${key}` }, item: { ...stepItem(key, ws), waiting: waitingOn(r.slug, key, at) },
      // Ranked by every ticket waiting on it; its line names the waiting ones, so it adds the count only
      // where more are held behind them.
      behind: heldBehindAll(ws.map(({ b, t }) => [b, t.key]), true), said: heldBehindAll(ws.map(({ b, t }) => [b, t.key])) > 0 };
  });
}
function stepItem(key, ws) {
  const summary = ws.map(({ b, t }) => (triageOf(b, t.key)?.blockers ?? []).find((x) => x?.key === key)?.summary).find(Boolean);
  const what = ({ t }) => (t.state === 'done' && t.result?.pr != null ? `PR #${t.result.pr} (${t.key})` : `${t.key} (${t.state === 'running' ? 'being built' : t.state === 'done' ? 'no PR' : 'not built yet'})`);
  const starts = ws.filter((w) => w.start).map(({ t }) => t.key), mw = ws.filter((w) => !w.start);
  const n = mw.length, merges = mw.filter(({ b }) => b.ctx?.merges || b.ctx?.batchMerges).length;
  const merger = merges === n ? 'desk merges them in order' : merges === 0 ? 'you merge them on GitHub'
    : 'desk merges those in batches it merges, and you merge the rest on GitHub';
  // `m` tickets wait to `verb` on it; after the first clause, one is "one", not "one ticket".
  const waits = (m, verb, first) => `${m === 1 ? (first ? 'one ticket waits' : 'one waits') : `${m} tickets wait`} to ${verb} on it`;
  const said = [starts.length && `${waits(starts.length, 'start', true)}: ${andList(starts)}`,
    n && `${waits(n, 'merge', !starts.length)}: ${andList(mw.map(what))}`].filter(Boolean).join(', and ');
  const after = [starts.length && `${andList(starts)} can start`, n && merger].filter(Boolean).join(', and ');
  return { kind: 'step', step: key,
    need: `${key}${summary ? ` ("${one(summary)}")` : ''} is a step only you can take, and ${said}. Do it and move ${key} to Done in Jira; the next pass that reads it lifts the hold, and ${after}`,
    actions: [['done', `once ${key} is Done in Jira, the next pass that reads it lifts the hold`], ['not-now']],
    since: finite(Math.min(...ws.map(({ t }) => timeOf(t.added_at) ?? Infinity))) };
}

// ---- a blocker that finished with no PR: one item for it, not one per ticket held behind it -------
// A done ticket of the batch with no PR and no merge recorded lands nothing, so the tickets held behind
// it wait until the person lets them start without it. Each such blocker is one item, `nopr:<KEY>`,
// naming every held ticket whose hold still names it; start lifts that blocker alone from each, so one
// held behind another blocker too stays held behind that one, and one held behind it alone is released
// as start releases any hold.
const NOPR = 'nopr:';
// A needs row whose hold is spoken for by such a blocker (holdOf's `finished`): its item lists the row.
const noPrHeld = (b, x) => !heldAsks(x.t) && holdShown(b.q, x.t, b.ctx)?.finished != null;
// The held tickets of `q` behind each blocker that finished with no PR, by blocker.
function noPrWaits(q) {
  const by = new Map();
  for (const t of Object.values(q?.tickets ?? {})) {
    if (!isHeld(t)) continue;
    for (const k of unmergedBlockers(q, t)) {
      const bt = q.tickets?.[k];
      if (bt?.state === 'done' && bt.result?.pr == null) by.set(k, [...(by.get(k) ?? []), t]);
    }
  }
  return by;
}
function noPrItems(r) {
  return [...noPrWaits(r.q)].map(([b, ts]) => ({ r, t: { key: `${NOPR}${b}` }, item: noPrItem(r, b, ts),
    behind: heldBehindAll(ts.map((t) => [r, t.key]), true), said: heldBehindAll(ts.map((t) => [r, t.key])) > 0 }));
}
function noPrItem(r, b, ts) {
  const waiting = ts.map((t) => t.key).sort();
  const summary = ts.map((t) => (triageOf(r, t.key)?.blockers ?? []).find((x) => x?.key === b)?.summary).find(Boolean);
  const single = ts.length === 1;
  const free = ts.filter((t) => freeFrom(t, b, r.q).release).map((t) => t.key).sort(), kept = ts.filter((t) => !freeFrom(t, b, r.q).release);
  const after = [free.length && `${andList(free)} can start`, ...kept.map((t) => freedWords(t, b, r.q))].filter(Boolean).join(', and ');
  return { kind: 'held', ticket: b, finished: b, waiting,
    need: `${b}${summary ? ` ("${one(summary)}")` : ''} finished with no PR, so nothing of it lands, and ${single ? 'one ticket is' : `${ts.length} tickets are`} held behind it: ${andList(waiting)}. Start lifts the hold on ${b} alone, and ${after}`,
    actions: [['start', `lifts the hold on ${b} from ${single ? waiting[0] : `all ${ts.length}`} and keeps every other hold`], ['not-now']],
    since: finite(Math.min(...ts.map((t) => timeOf(t.park?.since ?? t.added_at) ?? Infinity))) };
}
// Start: `b` lifted from every ticket still held behind it, each as freeCommand frees one.
function startNoPr(i, say) {
  const b = i.finished, q = i.r.q;
  const ts = i.waiting.map((k) => q?.tickets?.[k]).filter((x) => x && blockersOf(x).includes(b));
  if (!ts.length) return say(false, `no ticket is held behind ${b} any more, so nothing was changed.`);
  const done = [], words = [];
  for (const x of ts) {
    const m = liftOne(i.r, x, b);
    if (!m.ok) return say(false, `${done.length ? `hold on ${b} lifted from ${andList(done)}, but ` : ''}lifting it from ${x.key} was refused: ${m.out}`);
    done.push(x.key); words.push(m.words);
  }
  return say(true, `hold on ${b} lifted from ${andList(done)}: ${words.join('; ')}.`);
}

// ---- plan-first work no session has claimed ---------------------------------------------------------
// A lane C ticket parked at triage reaches the person only once it has waited unclaimed past config §3b
// "Plan-first wait before needs-you (hours)" (desk-q's shownState). Those of one batch, one or more, are
// one item, `plan-first`, naming the count and recommending the first be started in the batch's session,
// which claims it. Not-now puts it off until the tickets it names change, unless HOLDS_BACK or more held
// tickets wait behind them, as for any park (judged): then it is still listed, saying so.
const PLAN_FIRST = 'plan-first';
const planFirstHeld = (x) => !x.pr && planFirst(x.t);
function planFirstItems(r) {
  const ts = needsRows(r).filter(planFirstHeld).map((x) => x.t);
  if (!ts.length) return [];
  const keys = ts.map((t) => t.key), first = keys[0];
  const w = runner(r);
  const where = w.by === 'session' ? `the batch's session${w.name ? ` (${w.name})` : ''}` : `an interactive session in ${repoConfigValue(r.slug, 'repo-root') ?? r.name}`;
  const hours = (r.ctx?.planFirstMs ?? 0) / 3600e3;
  return [{ r, t: { key: PLAN_FIRST }, dir: r.stateDir, behind: heldBehindAll(keys.map((k) => [r, k])), item: { kind: PLAN_FIRST, planFirst: keys, ticket: first,
    need: `${planFirstWaits(keys)}: ${andList(keys)}. No session has claimed ${keys.length === 1 ? 'it' : 'them'} for more than ${hours}h`,
    actions: [['open', `start /desk-ticket ${first} in ${where}; it claims ${first}${keys.length > 1 ? ', and the others wait for that session or another' : ''}`], ['not-now']],
    since: finite(Math.min(...ts.map((t) => timeOf(t.park?.since) ?? Infinity))) } }];
}

// ---- follow-on steps: what a ticket left for after its PR merges (pass.mjs follow_on) -------------
// Once the PR has merged, its steps are one item, `follow:<KEY>`, each with the §3 row it names and
// that row's value. A step that only reads CI, desk's logs or desk's state is a follow-step checker's
// (follow-steps.mjs), which the pass starts: it is held off the list while one runs or is still to,
// gone once one passed it, and listed with what it found once one failed it. Every other step is the
// person's. Done records them settled (follow_on_done) and the item leaves the list.
const FOLLOW = 'follow:';
// A child of a feature or epic batch merged into the base, not the default branch: its code is out once
// a promotion PR merged after it, as the pass records each (promotion.merged, merged_at, since) or the
// archive check stamps it on the ticket before archiving the batch (promoted_at, batch.mjs). Null until
// then. A batch with a base desk opens no promotion PR for, and a ticket carried in from an earlier
// batch, are judged by the ticket's own merge.
const viaBase = (q, t) => !t.promoted_at && (q?.feature === true || epicBatch(q)) && !!q.base && !('carried_from' in t);
export function outAt(q, t) {
  if (t.promoted_at) return t.promoted_at;
  return viaBase(q, t) ? promotedAt(q, t) : t.merged_at;
}
// Whether a step's gate (after: merge, main or production) holds once outAt does: { held, note }, `note`
// saying why a gate was taken as held without being checked. A production gate read as held adds
// `on: 'production'`, and `at` where a commit of production's own took it in: that commit's date. A gate is git reachability in the repo
// root, from its remote refs as the last fetch left them: list's refresh and the pass fetch origin while
// a gated step waits. The commit judged is the one that put the PR's code on the default branch: its merge commit
// (pr_status.merge_commit), or for a batch child that a squash or rebase promotion left off it, the
// merge commit of the promotion PR that took it there (batch-state promotionPr, merge_commit), else the default
// branch's commit found by that PR's number. A batch
// child's main gate is its promotion's merge, which outAt has already seen. A commit not read yet (no
// merge commit recorded, or one not fetched) waits, as list's refresh and the pass fetch and record it;
// only what no fetch brings (a ref the repo root does not have, a promotion desk has no record of) lists
// the step saying it was not checked.
const gitRootOf = (r) => repoDirs(r.slug).root;
const SHA40 = /^[0-9a-f]{40}$/;
// `reads` is collect's (READS); its git reads the refs, READS.git where it has none.
function gateHeld(r, t, s, reads = null) {
  const after = s.after ?? 'merge';
  if (after === 'merge') return { held: true, note: null };
  const root = gitRootOf(r);
  if (!root) return { held: true, note: 'its gate could not be checked: config §2 "Primary repo root" is unset' };
  const git = (args) => (reads?.git ?? READS.git)(root, args);
  const commit = (x) => git(['rev-parse', '--verify', '--quiet', `${x}^{commit}`]);
  const within = (a, b) => git(['merge-base', a, b]) === a;
  const pr = `PR #${t.result?.pr ?? '?'}`;
  const unread = (ref) => ({ held: true, note: `${ref} could not be read in ${root}, so whether it has ${pr}'s merge was not checked` });
  const wait = { held: false, note: null };
  const def = defaultOf(r);
  const main = commit(`origin/${def}`);
  if (!main) return unread(`origin/${def}`);
  const promoted = !!t.promoted_at || viaBase(r.q, t);
  const own = t.pr_status?.merge_commit ? commit(t.pr_status.merge_commit) : null;
  let landed = own && within(own, main) ? own : null;
  if (after === 'main') return promoted || landed ? { held: true, note: null } : wait;
  const ref = promotionRef(repoConfigValue(r.slug, 'promotion-ref'));
  if (ref.why) return promoted || landed ? { held: true, note: `production could not be checked: ${ref.why}` } : wait;
  if (!landed && promoted) {
    // A squash or rebase promotion: the promotion PR's merge commit as the pass, the merge driver or list's
    // refresh recorded it (promotionPr), which a rebase merge needs, as it writes no subject naming the PR.
    // Until one is recorded, the default branch's commit by its number in the subject GitHub writes for a
    // merge or squash ("Merge pull request #N from …", or "<title> (#N)"). Neither found yet waits, as an
    // unread merge commit does: list's refresh reads the promotion PR for it.
    const p = promotionPr(r.q, t);
    if (!p) return { held: true, note: `production could not be checked: desk keeps no record of the promotion PR that took ${pr} to the default branch` };
    if (SHA40.test(String(p.merge_commit ?? ''))) landed = commit(p.merge_commit);
    else {
      const n = String(p.pr);
      const hit = String(git(['log', '--first-parent', '-n', '2000', '--format=%H%x09%s', main]) ?? '').split('\n')
        .find((l) => { const sub = l.split('\t')[1] ?? ''; return landedPr(sub) === Number(n); });
      landed = hit ? hit.split('\t')[0] : null;
    }
  }
  if (!landed) return wait;
  const prod = commit(ref.ref);
  if (!prod) return unread(`production (\`${ref.ref}\`)`);
  if (!within(landed, prod)) return wait;
  // Production has had it since the oldest commit on its first-parent line that holds `landed`. Where that
  // is `landed` itself, production was fast-forwarded to it, and git keeps no date for that: none is given.
  const lines = (x) => String(x ?? '').split('\n').filter(Boolean);
  const line = new Set(lines(git(['rev-list', '--first-parent', '-n', '2000', prod])));
  const entry = line.has(landed) ? null : lines(git(['rev-list', '--ancestry-path', `${landed}..${prod}`])).reverse().find((c) => line.has(c));
  const at = entry ? Date.parse(git(['log', '-1', '--format=%cI', entry]) ?? '') : NaN;
  return { held: true, note: null, on: 'production', ...(Number.isFinite(at) ? { at } : {}) };
}
// Whether step `s` of ticket `t` in queue `q` of repo `slug` has its gate held, for the pass's follow-step
// checker (pass/follow-steps.mjs), which runs a step only once needs-you would list it.
export const followGateHeld = (slug, q, t, s) => gateHeld({ slug, q }, t, s).held;
// A ticket's steps split by their gates: `ready` listed now (each with its note, `checked` where it is a
// checker's to run, and `failed`, the checker's record, where one failed it), `waiting` not yet. A step a
// checker passed is neither, nor is one not due yet (follow-steps.mjs followDelayMs after the code went
// out), nor a runnable one not yet passed or failed while its checker runs (up to FOLLOW_TIMEOUT_MS) or,
// for FOLLOW_WAIT_MS after it fell due, is still to.
function followSplit(r, t, now = Date.now(), reads = null) {
  const ready = [], waiting = [];
  const labels = personStepLabels(r.slug);
  const out = timeOf(outAt(r.q, t)) ?? now;
  const running = !!t.follow_run && now - Date.parse(t.follow_run.started) < FOLLOW_TIMEOUT_MS;
  for (const s of t.follow_on) {
    const c = checkOf(t, s);
    if (c?.result === 'pass') continue;
    // A source found broken is listed at once, waiting on its fix, whether or not a checker runs it again.
    const found = settled(c) || broken(c);
    if (!found && !followDue(s, out, now)) continue;
    const waited = now - followDueAt(s, out) >= FOLLOW_WAIT_MS;
    const g = gateHeld(r, t, s, reads);
    if (!g.held) { waiting.push(s); continue; }
    // A step a checker ran stays its own, whatever the labels read now.
    const checked = found || followKind(s, labels) === 'runnable';
    const runnable = checked && !found;
    if (runnable && (running || !waited)) continue;
    const note = runnable ? [g.note, 'no follow-step checker has passed or failed it yet'].filter(Boolean).join('; ') : g.note;
    ready.push({ s, note, on: g.on, at: g.at, checked, ...(found ? { failed: c } : {}) });
  }
  return { ready, waiting };
}
// A merged PR whose kept status names criteria its review left for after the merge, which the pass has
// not made follow-on steps yet (pass.mjs post_merge_read), is held off the list until it has: its item
// would gain them after the person saw it, and done would take them as run unseen.
const followsOf = (r) => Object.values(r.q?.tickets ?? {}).filter((t) => followOnPending(t) && outAt(r.q, t) && !postMergeOwed(t));
const GATES = ['merge', 'main', 'production'];
const gateOf = (s) => s?.after ?? 'merge';
const gatedFollow = (t) => t.follow_on.some((s) => gateOf(s) !== 'merge');
// A ticket's ready steps are one item per gate: `follow:<KEY>` for the merge's, `follow:<KEY>:<gate>` for
// the others. Steps sharing a gate open together, so done records only the steps its item showed, and a
// gate that opens after the list was read is a new item rather than one taken as run unseen. A checker's
// step is an item of its own, `…:checked:<id>` (stepId), listed as soon as it failed or went unrun: its
// result comes in on its own time, and would otherwise join an item the person was already shown. So, for
// the same reason, is a person's step that waits a set time after the merge (followDelayMs), `…:later:<id>`.
const stepId = (s) => createHash('sha1').update(String(s.step)).digest('hex').slice(0, 6);
const ownItem = (x) => (x.checked ? 'checked' : followDelayMs(x.s) > 0 ? 'later' : null);
function followItems(r, reads = null) {
  return followsOf(r).flatMap((t) => {
    const { ready, waiting } = followSplit(r, t, Date.now(), reads);
    const groups = GATES.flatMap((g) => {
      const here = ready.filter((x) => gateOf(x.s) === g);
      return [{ g, ready: here.filter((x) => !ownItem(x)) }, ...here.filter(ownItem).map((x) => ({ g, id: `${ownItem(x)}:${stepId(x.s)}`, ready: [x] }))];
    }).filter((x) => x.ready.length);
    return groups.map(({ g, id, ready: shown }, i) => ({
      r, t: { key: `${FOLLOW}${t.key}${g === 'merge' ? '' : `:${g}`}${id ? `:${id}` : ''}` },
      item: followItem(r, t, { gate: g, ready: shown, waiting: i === 0 ? waiting : [] }),
    }));
  });
}
const GATE_WORDS = { main: 'the default branch has', production: 'production runs' };
// A session's claim on follow item `key` (needs-you.mjs claim), { item, session, at }, while it is live:
// the session's transcript has changed within the repo's §3b "Release idle claims after (hours)", counted
// from the claim at the latest, as a ticket's claim is (pass.mjs). 0 never lapses while a transcript is
// there; with none the claim has lapsed, and the item needs the person again. Null where none is live.
export function liveClaim(r, key, register = readRegister(r.stateDir), now = Date.now()) {
  const c = claimOf(register, key);
  if (!c) return null;
  const tr = transcriptOf(c.session);
  if (!tr) return null;
  let raw = null;
  try { raw = repoConfigValue(r.slug, 'claim-release'); } catch { /* an unreadable config reads as unset */ }
  const { hours = DEFAULT_CLAIM_HOURS } = claimHours(raw);
  const since = Math.max(tr.mtimeMs, Date.parse(c.at) || 0);
  return hours > 0 && now - since > hours * 3600e3 ? null : c;
}
// The batch's listed follow items (neither put off nor dropped), each with `item.claim` where a session
// has a live claim on it: desk-q's and the check-in digest's "Checks after merge". Those put off go in
// `off`, where one is given.   -> [{ r, t, item }]
export function followChecks(r, register = readRegister(r.stateDir), now = Date.now(), off = null) {
  if (!r?.q) return [];
  return followItems(r).flatMap((f) => {
    const st = lookupItem(register, putOffKey(f.r, f.t, f.item)).status;
    if (st === 'put_off') off?.push(f);
    if (st === 'put_off' || st === 'dismissed') return [];
    const claim = liveClaim(f.r, f.t.key, register, now);
    return [claim ? { ...f, item: { ...f.item, claim } } : f];
  });
}
// A step whose evidence source a checker found broken (follow-steps.mjs broken): not unchecked, but
// waiting on that source's fix, so the item names the broken step, what it printed, and the open issue
// tracking it, or drafts one to file where none does. A checker runs it again every
// FOLLOW_BROKEN_RETRY_MS, and it passes, leaving the list, once the source works.
const brokenWords = (r, c) => {
  const src = one(c.source), what = one(c.found).replace(/\.$/, '');
  const fix = c.issue ? `It waits on #${c.issue}, which tracks that`
    : `No open issue tracks that: file one, "${src} produces nothing to judge on ${defaultOf(r)}", quoting "${what}" and the run (${one(c.evidence)}), and it waits on that`;
  return ` A follow-step checker found its evidence source broken, so it could not be checked: ${src} ran and produced nothing to judge (${what}; evidence: ${one(c.evidence)}). ${fix}; a follow-step checker runs it again every ${FOLLOW_BROKEN_RETRY_MS / 3600000} hours, and it leaves this list once the source works.`;
};
// "<KEY> is on <where> since <date>.", then any gate left unchecked, then one "Check: <step>." per step,
// a step's §3 row and its value named only where it has one.
function followItem(r, t, { gate, ready, waiting }) {
  const rowSaid = (row) => {
    if (!row) return '';
    let v;
    try { v = repoPermission(r.slug, row); } catch { v = 'unread'; }
    return ` (§3 ${row} is "${v}")`;
  };
  // A step's own closing period gives way to the line's; any other last character (a command's `.`) is kept.
  const stop = (x) => `${x}${x.endsWith('.') ? '' : '.'}`;
  const checks = ready.map(({ s, failed }) => {
    const said = `${reviewStep(one(s.step)).trim().replace(/([^\s.])\.$/, '$1')}${rowSaid(s.row)}`;
    const ran = !failed ? '' : broken(failed) ? brokenWords(r, failed)
      : ` A follow-step checker ran it and it failed: ${one(failed.found).replace(/\.$/, '')} (evidence: ${one(failed.evidence)}).`;
    return ` Check: ${stop(said)}${ran}`;
  }).join('');
  const notes = [...new Set(ready.map((x) => x.note).filter(Boolean))].map((x) => ` ${capital(x)}.`).join('');
  const n = ready.length;
  const m = waiting.length;
  const later = m ? ` ${m === 1 ? 'Another step waits' : `${m} more steps wait`} until ${andList([...new Set(waiting.map((s) => GATE_WORDS[s.after]))])} its merge, and ${m === 1 ? 'is' : 'are'} listed then.` : '';
  // Production is named only where its ref was read; unchecked, its steps were judged by the default branch.
  const onProd = gate === 'production' && ready.every((x) => x.on === 'production');
  const at = onProd ? Math.min(...ready.map((x) => x.at ?? Infinity)) : timeOf(outAt(r.q, t));
  const day = Number.isFinite(at) ? ` since ${new Date(at).toISOString().slice(0, 10)}` : '';
  const where = onProd ? 'production' : defaultOf(r);
  return { kind: 'follow', ticket: t.key, steps: ready.map((x) => x.s),
    need: `${t.key} is on ${where}${day}.${notes}${checks}${later} Then say done.`,
    actions: [['done', `once ${n === 1 ? 'it has' : 'each has'} run, or ${t.result?.pr != null ? `PR #${t.result.pr}'s` : "the PR's"} own checks already cover ${n === 1 ? 'it' : 'them'}; done takes ${t.follow_on.length > n ? 'these steps' : 'the item'} off your list`], ['not-now']],
    since: timeOf(outAt(r.q, t)) };
}

// ---- a feature batch's red promotion PR (pass.mjs promotion.red) ---------------------------------
// A promotion PR still red once its check tries are spent is one `pr` item, `promotion:<n>`, naming the
// checks it fails and what desk tried. The follow steps of every child merged into the base since the
// last promotion wait on it reaching the default branch: outAt holds their follow items off the list
// until it merges, so this item names them and ranks above any follow item, by their count. done
// records nothing: the next pass reads the PR again and clears it once it is not red.
const PROMOTION = 'promotion:';
function promotionItems(r) {
  const p = r.q?.promotion, red = p?.red;
  if (!red || red.pr == null || red.pr !== p.pr || p.merged_at) return [];
  const follows = Object.values(r.q.tickets ?? {}).filter((t) => followOnPending(t) && t.merged_at && !outAt(r.q, t)).map((t) => t.key);
  const base = r.q.base ?? 'the base';
  const checks = Array.isArray(red.checks) ? red.checks : [];
  // `why` (base-fix.mjs promotionChecksCall) says how many check tries desk made and how the last ended.
  const what = `it is ${plainWords(red.why ?? `still red after ${Number(red.tried) || 0} check tries`)}`;
  const waits = follows.length ? `. The follow steps of ${andList(follows)} wait on it reaching the default branch` : '';
  return [{ r, t: { key: `${PROMOTION}${red.pr}` }, behind: follows.length,
    item: { kind: 'pr', promotion: red.pr, head: red.head ?? '', checks,
      need: `promotion PR #${red.pr} (${base} into the default branch) is red, failing ${andList(checks)}; ${what}, so no more workers go to it. Fix what fails on ${base} and push it, then say done; merging it stays yours${waits}`,
      actions: [['done', 'once it is fixed on the base, the next pass reads its checks again and this item goes while they pass'], ['not-now']],
      since: timeOf(red.since) } }];
}

// ---- the base red under a batch's PRs (fix-tries.mjs againstBase, kept on each ticket as base_red) ---
// A check red on the base holds every PR it fails on without a fix try (BASE RED), and no worker repairs
// the base. While any open PR holds on one, one item says so: the checks, the PRs held and the last merges
// desk made, which may be what turned it red. done records nothing: the next pass reads the base again,
// each hold clears once its check passes there, and the item goes with the last.
// A check the merge driver holds the base on (base-red.mjs) is the batch's, reported by the pass once and
// repaired by its own ticket, so it is not one of the person's items; a PR held on another check still is.
const BASE_RED = 'base-red:';
function baseRedItems(r) {
  const driver = new Set((r.stateDir ? liveBaseRed(r.stateDir)?.checks ?? [] : []).map((c) => c.name));
  const tickets = Object.values(r.q?.tickets ?? {});
  // Held now: the last call held it, and its PR is open at the head the hold read, one of those checks
  // still red there. A record a PR left on going green, closing or taking a fix try is not a hold.
  // `live` is each held ticket's checks still red on its PR, the only ones the item names.
  const liveOf = (t) => {
    const b = t.base_red, st = prStatusOf(t);
    if (!b?.held || !b.checks?.length || st?.state !== 'OPEN' || st.head !== b.head) return [];
    // The status's checks are already the latest per workflow and name (readPrStatus), so read as they are.
    return [...new Set((st.checks ?? []).filter((c) => b.checks.includes(c.name) && !driver.has(c.name) && FAILED.has(c.conclusion)).map((c) => c.name))];
  };
  const held = tickets.map((t) => ({ t, live: liveOf(t) })).filter((x) => x.live.length);
  if (!held.length) return [];
  const base = r.q.base ?? 'the default branch';
  const checks = [...new Set(held.flatMap((x) => x.live))].sort();
  const prOf = (t) => (t.result?.pr != null ? `#${t.result.pr} (${t.key})` : t.key);
  const merges = tickets.filter((t) => t.merged_at).sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at)).slice(0, MERGES_SHOWN)
    .map((t) => `${prOf(t)} on ${dayAndTime(t.merged_at)}`);
  const last = merges.length ? `. The last merges desk made: ${andList(merges)}` : '';
  return [{ r, t: { key: `${BASE_RED}${r.q.base ?? 'default'}` }, behind: held.length,
    item: { kind: 'base-red', repoLevel: true, checks,
      need: `${base} is red on ${andList(checks.map((c) => `"${c}"`))}, so ${andList(held.map((x) => prOf(x.t)))} ${held.length === 1 ? 'holds' : 'hold'} with no fix try and no worker repairs ${base}${last}. Fix it on ${base}, or revert the merge that turned it red, then say done`,
      actions: [['done', 'the next pass reads the base again; each hold clears once its check passes there, and this item goes with the last'], ['not-now']],
      since: timeOf(held.map((x) => x.t.base_red.since).filter(Boolean).sort()[0]) } }];
}

// ---- one ticket queued in two repos (batches.mjs queuedCopies) -----------------------------------
// A ticket is queued in one repo at most, so a copy here beside one in another configured repo's batch
// is one item on this copy, keyed by its ticket. The copy held behind blockers its own batch lacks and
// the other copy's batch has is the extra one: its item recommends drop, and the other copy lists none.
// Where neither copy is held so, or both are, each lists the other, drop offered but not recommended.
const awayHolds = (q, t, there) => (holdsKept(t) ? blockersOf(t).filter((k) => !q?.tickets?.[k] && there?.tickets?.[k]) : []);
function duplicateOf(r, t, copies = queuedCopies()) {
  if (!r.q || t.state === 'done' || t.merged_at) return null;
  const o = copiesElsewhere(t.key, r.slug, copies)[0];
  if (!o) return null;
  const mine = awayHolds(r.q, t, o.q), theirs = awayHolds(o.q, o.t, r.q);
  if (theirs.length && !mine.length) return null;
  return { o, mine: theirs.length ? [] : mine };
}
function duplicateItems(r) {
  const copies = queuedCopies();
  return Object.values(r.q?.tickets ?? {}).flatMap((t) => {
    const d = duplicateOf(r, t, copies);
    return d ? [{ r, t, item: duplicateItem(t, d) }] : [];
  });
}
// The duplicate row of ticket `key` in r, as record takes it: null where its copy is the only one.
function duplicateRow(r, key) {
  const t = r.q?.tickets?.[key], d = t && duplicateOf(r, t);
  return d ? { t, dup: duplicateItem(t, d) } : null;
}
function duplicateItem(t, { o, mine }) {
  const there = `${copyWhere(o)} (${o.t.state})`;
  const is = mine.length === 1 ? 'is' : 'are';
  const need = mine.length
    ? `${t.key} is queued here and in ${there}, and a ticket is queued in one repo at most. This copy is the extra one: it is held behind ${andList(mine)}, which ${is} in that batch and not this one, so nothing here releases it. Drop it; the copy in ${o.ghRepo} goes on as it is`
    : `${t.key} is queued here and in ${there}, and a ticket is queued in one repo at most. Neither copy waits only on the other's batch, so which repo it belongs to is your call: drop the copy in the repo it does not belong to, and the other goes on as it is`;
  const drop = mine.length
    ? ['drop', `${andList(mine)} ${is} queued beside the copy in ${o.ghRepo}, so this copy is the extra one; drop takes it out of this batch and leaves that one as it is`]
    : ['drop', null, `takes this copy out of this batch; the copy in ${o.ghRepo} stays`];
  return { kind: 'duplicate', ticket: t.key, need, actions: [drop, ['not-now']], since: timeOf(t.added_at) };
}

// ---- links that no hold settles (pass.mjs wont_do_link, dropped_link, cycle_link) -----------------
// A blocker Done under a resolution that ships nothing (Won't Do, Duplicate), in no batch or in this one
// with its PR unmerged, never lands, a blocker dropped from the batch is released by nothing, and two
// tickets linked as blocking each other cannot both wait: whatever waits on one waits for ever. Each such
// link is one triage item, `link:<KEY>:<BLOCKER>`, asking whether it is still right; the ticket's own
// item (a hold, a park) stays as it is. The pass clears the marker once the link no longer stands, and
// the item leaves the list. A ticket done and waiting to merge on no step waits on nothing, and the pass
// reads it no more, so it has none.
const LINK = 'link:';
const LINK_KINDS = [['wont_do_link', 'wontDo'], ['dropped_link', 'dropped'], ['cycle_link', 'cycle']];
function linkItems(r) {
  const copies = queuedCopies();
  return Object.values(r.q?.tickets ?? {}).filter((t) => !t.merged_at && !(t.state === 'done' && !keysOf(t.merge_after).length))
    .flatMap((t) => {
      // A hold on a ticket the other repo's copy has beside it is the duplicate's item (duplicateItems).
      const dup = duplicateOf(r, t, copies);
      const seen = new Set();
      return LINK_KINDS.flatMap(([field, kind]) => keysOf(t[field]).filter((b) => !seen.has(b) && seen.add(b) && !(kind === 'dropped' && dup?.o.q.tickets?.[b]))
        .map((b) => ({ r, t: { key: `${LINK}${t.key}:${b}` }, item: linkItem(r, t, b, kind), behind: linkBehind(r, t, b, kind) })));
    });
}
// How many tickets wait on the link from `t` to `b` (collect ranks by it): `t` where its hold or its merge
// names `b`, with every ticket held behind it. A cycle's other side waits behind `t` whatever `t` waits on;
// a ticket held on another blocker waits on that one, not on this link.
function linkBehind(r, t, b, kind) {
  const waits = (holdsKept(t) && blockersOf(t).includes(b)) || keysOf(t.merge_after).includes(b);
  return waits || kind === 'cycle' ? heldBehindAll([[r, t.key]], waits) : 0;
}
// The command that frees ticket `x` from its hold on `b` alone: its other holds, and a park at triage
// (lane, size, design, the person's step), stay, as a release would send that park to a worker. The
// merge driver also waits on its --deps, which outlive a restart, so freed_from names `b` for it to skip.
// A value holding `|` is quoted, or a shell would read it as a pipe.
const shellArg = (s) => (/^[\w.,:=@+-]+$/.test(s) ? s : `'${s}'`);
// Ticket `x` freed from `b` alone: the holds left (`rest`), those of them still open (`open`: with its
// queue `q`, less any through on what the last pass read, so a PR it has not read yet still holds),
// whether nothing then holds it (`release`), and its freed_from with `b` added (`freed`).
const freeFrom = (x, b, q = null) => {
  const rest = blockersOf(x).filter((k) => k !== b);
  const open = q ? rest.filter((k) => !throughOnRecord(q, k)) : rest;
  return { rest, open, release: !open.length && !parkedAtTriage(x), freed: [...new Set([...keysOf(x.freed_from), b])].join('|') };
};
const freeCommand = (x, b) => (freeFrom(x, b).release ? releaseCommand(x.key) : `queue.mjs ${freeSteps(x, b)[0].map(shellArg).join(' ')}`);
// releaseCommand as queue.mjs argument lists: [set args, front args].
const releaseSteps = (key) => releaseCommand(key, '').split(/, then /).map((s) => s.trim().split(/\s+/));
// freeCommand as queue.mjs argument lists, run in order; `also` adds fields to the set.
function freeSteps(x, b, q = null, also = []) {
  const { rest, release, freed } = freeFrom(x, b, q);
  if (!release) return [['set', x.key, `held_by=${rest.join('|') || 'null'}`, `freed_from=${freed}`, ...also]];
  const [set, front] = releaseSteps(x.key);
  return [[...set, ...(also.length ? [`freed_from=${freed}`] : []), ...also], front];
}
// What freeing ticket `x` from `b` alone leaves it waiting on, in words.
const freedWords = (x, b, q = null) => {
  const { open, release } = freeFrom(x, b, q);
  return release ? `${x.key} is queued at the front, so the next pass can start it` : open.length ? `${x.key} stays held behind ${andList(open)}` : `${x.key} keeps its own park`;
};
// Ticket `x` of batch `r` freed from `b` alone: { ok, out } of the first refused step, else { ok, words }.
function liftOne(r, x, b, also = []) {
  for (const s of freeSteps(x, b, r.q, also)) { const m = queueCmd(r, s); if (!m.ok) return m; }
  return { ok: true, words: freedWords(x, b, r.q) };
}
function linkItem(r, t, b, kind = 'wontDo') {
  const rec = (triageOf(r, t.key)?.blockers ?? []).find((x) => x?.key === b);
  const about = `${b}${rec?.summary ? ` ("${one(rec.summary)}")` : ''}`;
  const fixed = 'If not, remove it in Jira; the next pass that reads it lifts any hold and clears this';
  let need;
  if (kind === 'dropped') {
    need = `${t.key} is held behind ${about}, which is no longer in this batch, so nothing releases it. Is the link still right? If not, release ${t.key} from it (${freeCommand(t, b)}); if ${t.key} still needs that work, admit ${b} again (/desk-admit ${b}), and this clears`;
  } else if (kind === 'cycle') {
    need = `${t.key} and ${about} are linked in Jira as blocking each other, so neither can wait for the other: ${b} is held behind ${t.key}, and ${t.key} does not start until this is settled. Which comes first? If ${t.key}, remove its "is blocked by ${b}" link in Jira; the next pass that reads its blockers clears this. If ${b}, removing ${b}'s link leaves its hold, so release ${b} (${freeCommand(r.q?.tickets?.[b] ?? { key: b }, t.key)}), then hold ${t.key} behind it (queue.mjs hold ${t.key} ${b}), and this clears`;
  } else {
    const closed = rec?.resolution ? `closed as ${rec.resolution}` : 'closed';
    const inBatch = !!r.q?.tickets?.[b];
    const where = inBatch ? 'is in this batch with its PR unmerged' : 'is in no batch';
    const held = blockersOf(t).includes(b);
    // A hold on a ticket in this batch outlives its link, so removing the link alone leaves it held.
    const waits = !held ? 'still links it as a blocker' : inBatch ? 'is held behind it, and nothing releases it' : 'is held behind it, and stays held until the link goes';
    const settle = held && inBatch ? `If not, remove it in Jira, then release ${t.key} from it (${freeCommand(t, b)}), as its hold outlives the link; the next pass that reads it clears this` : fixed;
    need = `${t.key} is blocked by ${about}, which ${where} and was ${closed} without landing, so ${t.key} ${waits}. Is the link still right? ${settle}. If ${t.key} still needs that work, link the ticket that does it instead`;
  }
  return { kind: 'triage', ticket: t.key, blocker: b, need,
    actions: [['done', kind === 'dropped' ? `once ${t.key} is released or ${b} is back in the batch, the next pass clears this item` : `once the link is fixed in Jira, the next pass that reads ${t.key}'s blockers clears this item`], ['not-now']],
    since: timeOf(t.added_at) };
}

// ---- a blocker Done with its code on another branch (pass.mjs unpromoted) -------------------------
// A ticket held behind a blocker outside its batch that has been Done a day or more, with its PR merged
// into another branch that no PR has promoted, waits for ever unless that branch is promoted. Each such
// hold is one item, `unpromoted:<KEY>:<BLOCKER>`, naming the branch and its promotion PR's state: promote
// opens that PR (or names the open one) and leaves the ticket held until it merges; start lifts the
// hold on that blocker alone. Once promote has named a PR, the item is listed again only if that PR goes
// red or is no longer open.
const UNPROMOTED = 'unpromoted:';
const promoteAnswered = (u) => u.promote != null && u.promote === u.pr && ['open', 'draft'].includes(u.state);
function unpromotedItems(r) {
  return Object.values(r.q?.tickets ?? {}).flatMap((t) => unpromotedHolds(t).filter(([, u]) => !promoteAnswered(u))
    .map(([b, u]) => ({ r, t: { key: `${UNPROMOTED}${t.key}:${b}` }, item: unpromotedItem(r, t, b, u), behind: heldBehindAll([[r, t.key]], true) })));
}
function unpromotedItem(r, t, b, u) {
  const def = defaultOf(r);
  const rec = (triageOf(r, t.key)?.blockers ?? []).find((x) => x?.key === b);
  const about = `${b}${rec?.summary ? ` ("${one(rec.summary)}")` : ''}`;
  const promote = u.pr == null
    ? `opens a PR from ${u.branch} into ${def}, ready for review; ${t.key} stays held until it merges`
    : `names promotion PR #${u.pr}, which is ${promotionState(u)}; ${t.key} stays held until it merges`;
  const where = u.pr == null ? `No PR promotes ${u.branch} into ${def}, so nothing lands it`
    : `Promotion PR #${u.pr}, ${u.branch} into ${def}, is ${promotionState(u)}, and ${t.key} waits until it merges`;
  return { kind: 'held', ticket: t.key, waitsOn: b, unpromoted: u,
    need: `${t.key} is held behind ${about}, Done since ${u.since.slice(0, 10)}, whose code merged into ${u.branch}, not ${def}. ${where}. Promote ${u.branch}, or start ${t.key} without ${b}`,
    actions: [['promote', promote], ['start', null, `lifts ${t.key}'s hold on ${b} alone and queues it, without ${b}'s code`], ['not-now']],
    since: timeOf(u.since) };
}
// Promote: the open PR from the branch into the default branch, read now, else one opened ready for
// review; recorded as the PR asked for, so the item leaves the list while that PR is open and not red.
function promoteBase(i, say) {
  const u = i.unpromoted, def = defaultOf(i.r), repo = ghRepoOf(i.r);
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let open;
  try { open = JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--head', u.branch, '--base', def, '--json', 'number,isDraft']) || '[]'); }
  catch (e) { return say(false, `could not read ${u.branch}'s promotion PR from GitHub (${one(e.stderr || e.message)}), so nothing was opened.`); }
  let n = Array.isArray(open) ? open[0]?.number : null, state = open?.[0]?.isDraft ? 'draft' : 'open', how;
  if (n == null) {
    const key = /[A-Z][A-Z0-9]+-\d+/.exec(u.branch)?.[0] ?? null;
    const body = `Promotes ${u.branch} into ${def}: ${i.waitsOn} merged into ${u.branch}, and ${i.ticket} is held until its code reaches ${def}.`;
    let out;
    try { out = gh(['pr', 'create', '--repo', repo, '--base', def, '--head', u.branch, '--title', promotionTitle(key, u.branch, def), '--body', body]); }
    catch (e) { return say(false, `gh pr create failed (${one(e.stderr || e.message)}), so nothing was opened.`); }
    n = Number(/\/pull\/(\d+)/.exec(out)?.[1]);
    if (!n) return say(false, `gh pr create printed no PR link (${one(out) || 'no output'}), so nothing was recorded.`);
    how = `opened promotion PR #${n} (${u.branch} into ${def}), ready for review`;
  } else how = `promotion PR #${n} (${u.branch} into ${def}) is already open${state === 'draft' ? ', as a draft' : ''}`;
  const at = `unpromoted.${i.waitsOn}`;
  const m = queueCmd(i.r, ['set', i.ticket, `${at}.pr=${n}`, `${at}.state=${state}`, `${at}.promote=${n}`]);
  if (!m.ok) return say(false, `${how}, but recording it was refused: ${m.out}`);
  return say(true, `${how}; ${i.ticket} stays held behind ${i.waitsOn} until it merges, and this item comes back if it goes red or closes.`);
}
// Start: the ticket's hold on that blocker lifted, as a link item frees one (freeCommand), and its record
// of the blocker dropped; queued at the front where nothing else holds it.
function startWithout(i, say) {
  const x = i.r.q?.tickets?.[i.ticket];
  if (!x) return say(false, `${i.ticket} is no longer in the batch, so nothing was changed.`);
  const b = i.waitsOn;
  const rec = { ...(x.unpromoted ?? {}) };
  delete rec[b];
  // Its outside hold and its record of `b` go too, or the pass would read it held outside again.
  const m = liftOne(i.r, x, b, [`held_outside=${keysOf(x.held_outside).filter((k) => k !== b).join('|') || 'null'}`,
    `unpromoted=${Object.keys(rec).length ? JSON.stringify(rec) : 'null'}`]);
  return m.ok ? say(true, `hold on ${b} lifted; ${m.words}.`) : say(false, `refused: ${m.out}`);
}

// ---- the repo's reviewer check (health.mjs): one item, naming every PR it holds ------------------
// While a batch's last health run told its reviewer check failing (the account desk posts verdicts
// from is not one §4 Gate reviewers counts, or cannot be read), the PRs the pass holds for it
// (gate_hold) are named in this one item's note rather than listed one by one. It is shown and put off
// in the standing batch, else the first by name; done records nothing: the next pass's health check
// reads the account again and lifts every hold once it passes.
const REVIEWER = 'reviewer';
function reviewerItems(batches) {
  // The newest run across the repo's batches decides: a stopped batch's older failure is not shown.
  const h = batches.map((b) => reviewerRecord(b.stateDir, b.slug)).filter(Boolean)
    .sort((a, c) => String(c.at).localeCompare(String(a.at)))[0]?.item;
  if (!h) return [];
  const held = batches.flatMap((b) => Object.values(b.q?.tickets ?? {}).filter(gateHeldAt));
  const r = batches.find((b) => b.batch == null) ?? [...batches].sort((a, c) => String(a.batch).localeCompare(String(c.batch)))[0];
  const prs = held.map((t) => `PR #${t.result?.pr ?? prStatusOf(t)?.pr ?? '?'} (${t.key})`);
  const need = h.signin
    ? `the account desk posts ${r.repo}'s review verdicts from cannot be read (${one(h.why)}). Fix: ${h.fix}`
    : `${r.repo}'s review gate does not count desk's verdicts: ${one(h.why)}. Fix: ${h.fix}`;
  return [{ r, dir: standingDir(r), t: { key: REVIEWER }, item: { kind: REVIEWER, repoLevel: true, held: held.map((t) => t.key),
    need: `${need}. Until it passes, no PR red only on that gate gets a review or fix try; build workers still start`,
    note: prs.length ? `Held on it: ${andList(prs)}.` : 'No PR is held on it yet.',
    actions: [['done', 'once it is fixed, the next pass checks the account again and lifts the hold on every PR it names'], ['not-now']],
    since: finite(Math.min(...held.map((t) => timeOf(t.gate_hold.at) ?? Infinity))) } }];
}

// ---- the machine's browser sign-ins (health.mjs browserSignins): one item a login, whatever waits ---
// While a browser profile's GitHub login fails, no repo's screenshot upload with it runs, so it is one
// item for the machine, not one per repo or PR, naming the sign-in command and the uploads that wait.
// It is shown in the batch whose pass tells it, else a batch of its repo, else the first; desk-q counts
// it in its repo's row. done records nothing: the next pass that finds the login passing drops it.
const SIGNIN = 'browser-signin';
function signinItems(batches, only = null) {
  const live = batches.filter((x) => !x.error && x.q);
  let jobs = null;
  return browserSignins().flatMap((s) => {
    const mine = (b) => b.slug === s.slug;
    if (only && !only.some(mine)) return [];
    const r = live.find((b) => s.state && resolve(b.stateDir) === resolve(s.state)) ?? live.find(mine) ?? live[0];
    if (!r) return [];
    if (!jobs) { try { jobs = readUploadQueue().jobs; } catch { jobs = []; /* named as none waiting */ } }
    const prs = waitingPrs(jobs.filter((j) => !s.file || !j.profile || sessionFile(j.profile) === s.file));
    return [{ r, dir: r.stateDir, t: { key: `${SIGNIN}:${s.id}` }, item: { kind: SIGNIN, repoLevel: true,
      need: `the browser profile's saved GitHub login is not signed in (${one(s.why)}), so no repo's screenshot upload with it runs; workers still start. Sign it in, in a terminal on this machine's screen: ${SIGNIN_CMD}`,
      note: prs.length ? `Waiting in the upload queue: ${andList(prs)}.` : 'No upload waits on it yet.',
      actions: [['done', 'once it is signed in, the next pass finds the login passing, drops this item and uploads what waits'], ['not-now']],
      since: timeOf(s.at) } }];
  });
}

// ---- the machine's upload queue paused on GitHub's PR page (upload-queue.mjs page): one item --------
// While the uploader finds no comment composer, no repo's screenshot upload runs, so it is one desk
// fault for the machine, not a drag-it-in item per PR. It is listed in a batch of the repo whose upload
// found it, else of a repo with an upload waiting; desk-q counts it only in the first (`home`). It is
// put off for the machine, in desk's home, whichever repo lists it. done records nothing: the first
// upload after desk is installed again that finds the composer drops it.
const PAGE = 'upload-page';
function pageItems(batches, { home = false } = {}) {
  const pause = uploadPause();
  if (!pause) return [];
  const { page: p, jobs, prs } = pause;
  const live = batches.filter((x) => !x.error && x.q);
  const first = (bs) => bs.find((b) => b.batch == null) ?? bs[0];
  // The queue holds the pass's GitHub repo as its origin spells it; GitHub's names are case-insensitive.
  const isRepo = (b, repo) => repo != null && [b.slug, slugOf(ghRepoOf(b))].includes(slugOf(String(repo)));
  const r = first(live.filter((b) => isRepo(b, p.repo))) ?? (home ? null : first(live.filter((b) => jobs.some((j) => isRepo(b, j.repo)))));
  if (!r) return [];
  return [{ r, dir: deskHome(), t: { key: PAGE }, item: { kind: PAGE, repoLevel: true,
    need: `desk's screenshot uploader is broken by a GitHub page change (${one(p.why)}), so no repo's screenshot upload runs and ${prs.length} PR(s) wait in draft for their screenshots. ${PAGE_RESUMES}`,
    note: prs.length ? `Waiting in the upload queue: ${andList(prs)}.` : 'No upload waits on it yet.',
    actions: [['done', 'once desk is installed again with a fix, the next pass uploads what waits and drops this item'], ['not-now']],
    since: timeOf(p.at) } }];
}

// ---- the end of the lease trial (leases.mjs trialOf): one item for the machine --------------------
// Once a trial has run TRIAL_DAYS and a kind is still in shadow, the person decides which kinds turn
// on, with each kind's clashes over the trial. It is listed under the first batch desk-q's home screen
// shows, else the first readable batch at all (leaseTrialHome), whose row desk-q counts it in. Each answer sets the machine profile's
// lease-kinds row and restarts the trial for the kinds left in shadow, so it asks again after another
// TRIAL_DAYS while any is; there is no not-now, since keep is that.
const LEASE_TRIAL = 'lease-trial';
const LEASE_ENV = { machineValue, psRows };
// The trial's facts once it has ended with a kind still in shadow, else null (no log, a log or
// profile that cannot be read, the trial still running, or no kind in shadow).
export function leaseTrialAsk(now = Date.now()) {
  let log, modes;
  try { log = readLog(); modes = Object.fromEntries(LEASE_KINDS.map((k) => [k, kindMode(k, LEASE_ENV).mode])); } catch { return null; }
  const trial = trialOf(log);
  const shadow = LEASE_KINDS.filter((k) => modes[k] === 'shadow');
  if (!trial || now < trial.ends || !shadow.length) return null;
  const caught = Object.fromEntries(shadow.map((k) => [k, log.clashes.filter((e) => e.kind === k && Date.parse(e.at) >= trial.start && Date.parse(e.at) <= now)]));
  return { trial, modes, shadow, caught };
}
// The repo the trial's item is listed and counted under: the first readable batch the home screen
// shows, in its order, else the first readable batch of any repo, so a quiet machine is still asked.
// desk-q and this list both take it from every loaded repo. -> its slug, or null.
const readable = (b) => !b.error && b.q;
export const leaseTrialHome = (repos) => (shownRepos(repos, false).find(readable) ?? shownRepos(repos, true).find(readable) ?? repos.find(readable))?.slug ?? null;
// The lease-kinds row with `on` kinds set on and every other kind as it is now.
const leaseRow = (modes, on) => LEASE_KINDS.map((k) => `${k}=${on.includes(k) ? 'on' : modes[k]}`).join(',');
// Each answer: the kinds it turns on. -> { <action>: kinds }.
function trialChoices(a) {
  const clean = a.shadow.filter((k) => !a.caught[k].length);
  return { 'on-clean': clean, 'on-all': a.shadow, keep: [] };
}
function leaseTrialItems(repos, named, now) {
  const a = leaseTrialAsk(now);
  const slug = a && leaseTrialHome(repos);
  if (!slug || (named && named.slug !== slug)) return [];
  const r = repos.find((b) => b.slug === slug && b.batch == null && readable(b)) ?? repos.find((b) => b.slug === slug && readable(b));
  const dm = (t) => dayAndTime(t).split(' ').slice(1, 3);
  const [d1, m1] = dm(a.trial.start), [d2, m2] = dm(a.trial.ends);
  const span = m1 === m2 ? `${d1} to ${d2} ${m2}` : `${d1} ${m1} to ${d2} ${m2}`;
  const n = (k) => a.caught[k].length;
  const days = (k) => andList([...new Set(a.caught[k].map((e) => dayAndTime(Date.parse(e.at)).split(' ').slice(0, 2).join(' ')))]);
  // The clash listing reaches back to the trial's start, however long the question has waited.
  const back7 = Math.max(TRIAL_DAYS, Math.ceil((now - a.trial.start) / 86_400_000));
  const listing = `desk-env lease list --clashes${back7 > TRIAL_DAYS ? ` --days ${back7}` : ''}`;
  const counts = a.shadow.map((k) => `${k} ${n(k)}${n(k) ? ` (${days(k)}; ${listing} shows them)` : ''}`).join(', ');
  const { 'on-clean': clean } = trialChoices(a);
  const dirty = a.shadow.filter((k) => n(k));
  const total = dirty.reduce((x, k) => x + n(k), 0);
  const all = a.shadow.length;
  const caughtWords = `${andList(dirty)} would have refused ${total} request${total === 1 ? '' : 's'} this week instead of letting ${total === 1 ? 'it' : 'them'} through`;
  const onAll = `turn all ${all} on`;
  const keep = ['keep', null, `keep all ${all} on trial for ${TRIAL_DAYS} more days: changes nothing. Pick this if this week was quieter than usual`];
  const actions = !dirty.length
    ? [['on-all', `${onAll}: nothing they would refuse happened all week, so turning them on blocks nothing that works today`], keep]
    : !clean.length
      ? [['keep', `keep all ${all} on trial for ${TRIAL_DAYS} more days: every kind caught a clash, so turning one on would turn away work that runs today`], ['on-all', null, `${onAll}: ${caughtWords}`]]
      : [['on-clean', `turn on the ${clean.length} with no clashes: nothing they would refuse happened all week, so turning them on blocks nothing that works today. ${andList(dirty)} ${dirty.length === 1 ? 'stays' : 'stay'} on trial while ${dirty.length === 1 ? 'its' : 'their'} ${total} clash${total === 1 ? ' is' : 'es are'} looked at`],
        ['on-all', null, `${onAll}: ${caughtWords}`], keep];
  // The command is for after a turn-on: the recommended one, or turning them all on where keep is recommended.
  const kept = actions[0][0] === 'keep';
  const first = kept ? a.shadow : trialChoices(a)[actions[0][0]];
  const back = leaseRow(a.modes, first).replace(`${first[0]}=on`, `${first[0]}=shadow`);
  return [{ r, dir: deskHome(), t: { key: LEASE_TRIAL }, item: { kind: LEASE_TRIAL, repoLevel: true,
    need: `Leases finished their ${TRIAL_DAYS}-day trial (${span}). Turn them on, so a second session is turned away from a port, test slot, build or merge someone else holds, instead of let through?`,
    note: `Clashes caught: ${counts}. ${kept ? 'If you turn them on, any kind goes back' : 'Any kind goes back'} to trial with one command: desk-env machine set lease-kinds=${back}`,
    actions, since: a.trial.ends } }];
}
// Records an answer to the trial's item: lease-kinds set in the machine profile, then the trial restarted.
function leaseTrialAnswer(verb, now, say) {
  const a = leaseTrialAsk(now);
  if (!a) return say(false, 'the lease trial is not waiting on an answer now, so nothing was recorded.');
  const on = trialChoices(a)[verb];
  const row = leaseRow(a.modes, on);
  if (on.length) {
    const set = spawnSync(process.execPath, [fileURLToPath(new URL('./desk-env.mjs', import.meta.url)), 'machine', 'set', `lease-kinds=${row}`, '--reason', `the lease trial's day-${TRIAL_DAYS} answer: ${verb}`], { encoding: 'utf8' });
    if (set.status !== 0) return say(false, `lease-kinds was not set (${one(set.stderr || set.stdout)}), so nothing was recorded.`);
  }
  try { restartTrial(`answered ${verb}`); } catch (e) { return say(false, `${on.length ? `lease-kinds is now ${row}, but ` : ''}the trial could not be restarted (${one(e.message)}).`); }
  const left = a.shadow.filter((k) => !on.includes(k));
  return say(true, `${on.length ? `lease-kinds is now ${row}` : 'lease-kinds is unchanged'}; ${left.length ? `${andList(left)} ${left.length === 1 ? 'stays' : 'stay'} on trial for ${TRIAL_DAYS} more days` : 'no kind is on trial now'}.${on.length ? ` To put one back on trial: desk-env machine set lease-kinds=${row.replace(`${on[0]}=on`, `${on[0]}=shadow`)}` : ''}`);
}

// ---- what a session handed the person (asks.mjs): one item an ask, on the repo's standing batch ----
const ASK = 'ask:';
const askItems = (batches) => batches.filter((b) => b.batch == null && !b.error).flatMap((r) => (r.asks ?? []).map((a) => ({ r, dir: r.stateDir, t: { key: `${ASK}${a.id}` },
  item: { kind: 'ask', repoLevel: true, id: a.id, ...(a.settles ? { settles: a.settles } : {}), ...askShape(a), since: timeOf(a.at) } })));
// An ask's need and actions: a plain ask is done once done; a choice offers each option, the recommended
// one first, saying when it applies by itself (ask-defaults.mjs deadlineText).
function askShape(a, now = new Date()) {
  if (!(a.options?.length >= 2)) return { need: a.text, actions: [['done', 'a session handed this to you; say done once it is done, and it leaves the list'], ['not-now']] };
  const when = deadlineText(a, now);
  const ordered = a.recommended ? [a.recommended, ...a.options.filter((o) => o !== a.recommended)] : a.options;
  return { need: when ? `${a.text} (${when})` : a.text, choice: true,
    actions: [...ordered.map((o) => (o === a.recommended ? [o, when ?? 'the session that asked recommends it'] : [o])), ['done', 'it is settled some other way: it leaves the list, no option recorded'], ['not-now']] };
}

// ---- a pending priority proposal on a ticket (priority-proposal.mjs): one item a ticket --------------
// A ticket whose triage record carries `priority_proposal` (ticket-facts.mjs: a label §4 Priority
// proposal labels matches, or a description line asking a person to promote it or reject it) is one
// item, `proposal:<KEY>`, until the person answers it. It holds no work: the ticket is built either way.
// promote sets §4 Priority to the value proposed (or the one the answer names), reject leaves it; both
// take the label off and comment on the ticket (proposalAnswer), and the answer is kept on the queue
// ticket (priority_proposal_answer), so the item goes.
const PROPOSAL = 'proposal:';
const proposalItems = (batches) => batches.filter((b) => !b.error && b.q).flatMap((r) => Object.values(r.q.tickets ?? {}).flatMap((t) => {
  if (t.merged_at || t.state === 'failed' || t.priority_proposal_answer) return [];
  const p = triageOf(r, t.key)?.priority_proposal;
  if (!p || typeof p !== 'object') return [];
  const asked = `${p.label ? `the label ${p.label}` : 'its description'}${p.line ? ` ("${cut(one(p.line), 160)}")` : ''}`;
  const off = p.label ? ' and takes the label off' : '';
  return [{ r, dir: r.stateDir, t: { key: `${PROPOSAL}${t.key}` }, item: { kind: 'proposal', proposal: true, ticket: t.key, to: p.to ?? null, label: p.label ?? null,
    need: `${t.key} carries a pending proposal to make its priority ${p.to ?? 'higher'}, from ${asked}, which a person promotes or rejects. It is built either way: promote sets its priority${p.to ? ` to ${p.to}` : ' to the value you name'}${off}, and reject leaves the priority as it is${off}; both comment on ${t.key}`,
    actions: [p.to ? ['promote', `desk admitted ${t.key} to build now, so its priority is the one proposed`] : ['promote', null, 'name the value: promote "P1"'],
      ['reject', null, 'the priority stays as it is'], ['not-now']],
    since: timeOf(t.added_at) } }];
}));

// The answer to proposal item `i`, written to its ticket through desk-jira in the repo's own checkout
// (`reads.jira`): §4 Priority set to the value (promote only, with --approved when it is one of §4
// Priorities only you set, as the person's answer is that approval), the label taken off (desk-jira
// labels remove), and a comment;
// then kept on the queue ticket. A write that fails stops there, saying what was written before it.
function proposalAnswer(i, verb, text, reads, now, say) {
  const to = verb === 'promote' ? (one(text).replace(/^["']|["']$/g, '') || i.to || '').toUpperCase() : null;
  if (verb === 'promote' && !to) return say(false, 'promote needs the value to set, as promote "P1", since the proposal names none.');
  const pr = [].concat(repoConfigValues(i.r.slug, 'jira-priority') ?? []).map(String);
  const field = pr.find((v) => /^customfield_\d+$/.test(v.trim()))?.trim() ?? 'priority';
  const top = [].concat(repoConfigValues(i.r.slug, 'jira-priority-user-only') ?? []).map((v) => String(v).trim().toLowerCase());
  const done = [];
  const run = (what, args) => {
    try { reads.jira(i.r, args); done.push(what); return null; }
    catch (e) { return say(false, `${what} failed (${one(e.stderr || e.message)})${done.length ? `, after ${andList(done)}` : ', so nothing was written'}; it stays on your list.`); }
  };
  let no = to ? run(`setting ${field} to ${to}`, ['edit', i.ticket, `${field}=${to}`,
    ...(top.includes(to.toLowerCase()) ? ['--approved', `promoted to ${to} through desk-needs-you, answering the pending priority proposal`] : [])]) : null;
  if (no) return no;
  if (i.label) {
    // Jira's own remove, which touches that label alone: a label added meanwhile is kept.
    no = run(`taking ${i.label} off`, ['labels', i.ticket, 'remove', i.label]);
    if (no) return no;
  }
  const body = `Priority proposal ${verb === 'promote' ? `promoted: ${field} set to ${to}` : 'rejected: the priority stays as it was'}${i.label ? `, and the label ${i.label} taken off` : ''}. Answered by the person through desk-needs-you.`;
  no = run('the comment', ['comment', i.ticket, body]);
  if (no) return no;
  const q = queueCmd(i.r, ['set', i.ticket, `priority_proposal_answer=${JSON.stringify({ answer: verb, to, at: new Date(now).toISOString() })}`]);
  return q.ok ? say(true, `${andList(done)} on ${i.ticket}, so it is off your list.`) : say(false, `${andList(done)} on ${i.ticket}, but keeping the answer was refused (${q.out}): it may be listed again.`);
}

// ---- a red main assigned to the person (tests/ci_main_red.mjs): one item an issue -------------------
// CI's alarm keeps one issue labelled ci-main-red open, assigned to the repo's owner, while a lane on
// main is red, cancelled or stale. It is read through gh only when items are listed (`read`, READS.ciRed),
// never for desk-q's count, and listed on the repo's standing batch. done records nothing: the alarm
// closes the issue once every lane is green and fresh, and the item goes with it.
const CI_RED = 'ci-red:';
const ciRedItems = (repos, scope, read) => [...new Set(scope.filter((b) => !b.error).map((b) => b.slug))].flatMap((slug) => {
  const r = repos.find((b) => b.slug === slug && b.batch == null && !b.error) ?? scope.find((b) => b.slug === slug && !b.error);
  return (read(r) ?? []).map((i) => ({ r, dir: r.stateDir, t: { key: `${CI_RED}${i.number}` }, item: { kind: 'ci-red', repoLevel: true,
    need: `main is red in ${ghRepoOf(r)}: issue #${i.number} (${one(i.title)}, ${i.url}) says which CI lane on main failed, was cancelled or went stale. Fix it on main, or rerun a lane that only flaked`,
    actions: [['done', 'the alarm closes the issue once every lane on main is green and fresh, and this item goes with it; done records nothing'], ['not-now']],
    since: timeOf(i.createdAt) } }));
});

// ---- a PR a desk session opened that no ticket owns (pass.mjs ticketless_prs): one item a PR -------
// The merge driver merges only a ticket's PR, so a PR a desk session opened into a batch's base with no
// ticket waits until a person merges or closes it. Each one a pass records is one item, listed once for
// its repo however many of its batches record it, on the standing batch where that one does. done
// records nothing: the next pass that finds the PR merged or closed drops it.
const TICKETLESS = 'ticketless:';
function ticketlessItems(batches) {
  const seen = new Set();
  return [...batches].sort((a, b) => (a.batch == null ? 0 : 1) - (b.batch == null ? 0 : 1))
    .filter((r) => !r.error && Array.isArray(r.q?.ticketless_prs))
    .flatMap((r) => r.q.ticketless_prs.filter((p) => p?.pr != null && !seen.has(`${r.slug}#${p.pr}`) && seen.add(`${r.slug}#${p.pr}`))
      .map((p) => ({ r, dir: r.stateDir, t: { key: `${TICKETLESS}${p.pr}` }, item: { kind: 'ticketless', repoLevel: true, pr: p.pr,
        need: `PR #${p.pr}${p.title ? ` ("${one(p.title)}")` : ''} from ${p.branch} into ${r.q.base ?? defaultOf(r)} was opened by a desk session, and no ticket owns it, so nothing will merge it: review it, then merge or close it yourself`,
        actions: [['done', 'once it is merged or closed, the next pass drops this item; done records nothing'], ['not-now']],
        since: timeOf(p.since) } })));
}

// ---- finished cloud sessions (cloud-worker.mjs finishedCloud): one item a batch --------------------
// Nothing here can archive a cloud session, so each batch's finished ones are one item, naming each
// session and its URL; the standing batch's also lists those an archived named batch handed it. Its
// key, `cloud-archive:<id>` (`cloud-archive:<batch>:<id>` for a named batch), carries a hash of the
// sessions it names, so a done answers only the list that was shown: once another session finishes,
// the old key is no longer listed and its done is refused. Done records every session it named as
// archived (cloud-worker.mjs recordArchived).
const CLOUD_ARCHIVE = 'cloud-archive';
function cloudItems(batches) {
  return batches.filter((b) => !b.error && b.q).flatMap((r) => {
    let archive = {};
    try { archive = readArchive(r.queuePath).tickets; } catch { /* an unreadable archive lists none of its tickets */ }
    const done = finishedCloud(r.q.tickets, archive, readArchived(r.stateDir), r.batch == null ? readPending(r.stateDir) : []);
    if (!done.length) return [];
    const sessions = done.map((d) => d.session);
    const id = createHash('sha256').update(sessions.join('\n')).digest('hex').slice(0, 8);
    const list = done.map((d) => `${d.name ?? d.key} ${d.url}`).join('; ');
    return [{ r, dir: r.stateDir, t: { key: `${CLOUD_ARCHIVE}:${r.batch == null ? '' : `${r.batch}:`}${id}` }, item: { kind: CLOUD_ARCHIVE, repoLevel: true, sessions,
      need: `${done.length === 1 ? '1 cloud session has' : `${done.length} cloud sessions have`} finished in ${r.name ?? r.slug} and ${done.length === 1 ? 'is' : 'are'} still open: archive ${done.length === 1 ? 'it' : 'these'} in claude.ai/code: ${list}`,
      actions: [['done', 'once you have archived them, done records them so they are not listed again'], ['not-now']],
      since: timeOf(done[done.length - 1].at) } }];
  });
}

// ---- a session-run batch whose passes stopped (desk-q sessionStalled): one item a batch -------------
// A batch an interactive session runs (§3b Batches run by `session`) has no supervisor to start its
// passes again, so when that session stalls (a turn that ended short of its next step, a request that
// hung) nothing moves there. Once such a batch has run a pass and desk-q reads it paused (no pass for
// LIVE_MS, its next pass due more than PASS_GRACE_MS ago, and a ticket autopilot could move), it is
// one item, `stalled` for the standing batch and `stalled:<batch>` for a named one, listed and put
// off in that batch alone, so every scope that lists it lists the same item. Its need names its last
// pass and what the session did about it (rearmOf), so not-now holds until a later stall or a re-arm;
// done records nothing: the next pass drops it.
const STALLED = 'stalled';
// What the session running the batch did about its lost tick: hooks/desk-handoff.py tells it to re-arm
// the loop on its first turn once the loop reads lost, which is never later than this item shows, and
// queue.mjs next-pass logs the re-arm (loop-tick.mjs).
function rearmOf(b) {
  const rec = readRearm(b.stateDir, b.last);
  if (rec?.why) return `the session could not re-arm it: ${one(rec.why)}`;
  if (rec?.rearmed_at) return `the session re-armed it at ${utc(rec.rearmed_at)}, but no pass has run since`;
  if (rec?.told_at) return `the session could not re-arm it yet: it was told to at ${utc(rec.told_at)} and has not recorded a next pass since`;
  return `the session could not re-arm it: it has taken no turn since ${utc(lostAt(b))}, when it was due to`;
}
const stalledItems = (batches, now = Date.now()) => batches
  .filter((b) => !b.error && b.q && sessionStalled(b))
  .map((b) => ({ r: b, dir: b.stateDir, t: { key: b.batch == null ? STALLED : `${STALLED}:${b.batch}` }, item: { kind: STALLED, repoLevel: true,
    need: `passes stopped in ${b.name}, a batch a session runs, so nothing new starts or merges there: its last pass ran at ${utc(b.last)}${dueTick(b) != null ? `, and the next was due at ${utc(dueTick(b))}` : ''}. The loop lost its next tick, and ${rearmOf(b)}: resume the session, or ${resumeOf(b)}`,
    note: `Passes stopped ${since(now - b.last)} ago.${b.rows.some((x) => x.k === 'running') ? ' Running workers carry on.' : ''}`,
    actions: [['done', 'once a pass runs again this item leaves the list; done records nothing'], ['not-now']],
    since: b.last } }));

// One item's kind, its one-line need and its actions, the recommended one first with its reason.
// `reads` (READS) lets a draft's need quote the gaps its review lists; without it none is read.
// `finds` (READS) lets a stopped or outside-held ticket's merged PR in another repo be looked for on
// GitHub; without it only those repos' queues are read.
function itemOf(r, x, reads = null, finds = reads) {
  const t = x.t;
  if (x.dup) return x.dup;
  if (x.usage) return { kind: 'usage', need: usageHoldOf(r), actions: [['done', 'it lifts by itself; switch subscription to lift it sooner, then say done'], ['not-now']] };
  if (x.subOff) {
    const s = r.q.subscription_off;
    return { kind: 'subscription-off', need: `${r.slug} is pinned to ${s.email}, which is off${s.login ? ` (claude ${s.login})` : ''}, so no new work starts for it: move it to another subscription (desk-env subscription set ${r.slug} <default|email>)${s.login ? `, or set ${s.login} unused (desk-env logins set claude ${s.login} unused)` : ''}`,
      actions: [['done', 'once it is moved, or the subscription is unused, the next pass starts its work and drops this item'], ['not-now']] };
  }
  if (x.baseSync) {
    const b = r.q.base_sync_stuck;
    const n = b.frozen ?? 0;
    const frozen = `${n === 1 ? '1 ticket ready to spawn is' : `${n} tickets ready to spawn are`} frozen until ${b.base} takes ${b.source ?? 'the default branch'}: ${b.why}`;
    return { kind: 'base-sync', holdsAll: true,
      need: b.cmd ? `the base sync of ${b.base} could not push, so ${frozen}. Run it by hand to see the hook's full output and push it: ${b.cmd}`
        : `the base sync of ${b.base} failed, so ${frozen}. It clears once a pass syncs ${b.base}: fix what stopped it (a base missing on origin is restored or recreated there)`,
      actions: [['done', `once the base is ${b.cmd ? 'pushed' : 'fixed'}, the next pass finds it current, spawns again and drops this item`], ['not-now']] };
  }
  if (x.basePush) {
    const a = r.q.base_push_ask;
    const base = a.base ?? 'the batch base', source = a.source ?? 'the default branch';
    const ci = behindPrs(r.q);
    if (a.recreate) {
      return { kind: 'base-push', need: `${base} is missing on origin (merged into ${source}, then deleted), and config §3 batch-base-push is "ask", so no pass recreates it: approve it once for this batch`,
        actions: [['approve', `it is only code: the next pass pushes ${source}'s head back as ${base}, and every later sync in this batch runs without asking`], ['not-now']] };
    }
    const starts = ci.length ? ` Syncing ${base} starts CI on its child ${ci.length === 1 ? 'PR' : 'PRs'} ${andList(ci)}, whose required checks only ${source}'s workflow runs on ${base}; the pass then reopens ${ci.length === 1 ? 'it' : 'them'}.` : '';
    return { kind: 'base-push', need: `${base} is behind ${source}, and config §3 batch-base-push is "ask", so no pass merges ${source} into it: approve it once for this batch${starts ? `.${starts}` : ''}`,
      actions: [['approve', `it is only code: the next pass merges ${source} into ${base} and pushes it, and every later sync in this batch runs without asking`], ['not-now']] };
  }
  if (heldDraft(t)) {
    const n = t.result.pr;
    return { kind: 'held', need: `you put PR #${n} back to draft, so nothing undrafts or merges it: undraft it to release it (gh pr ready ${n} --repo ${r.slug.replace('__', '/')})`, note: doneNote(t),
      actions: [['done', 'only you can undraft it; say done once you have'], ['not-now']] };
  }
  // An unmerged PR: only the person's step on GitHub moves it. A draft whose review left gaps also
  // takes their call on them, which a worker on the PR carries out.
  if (x.pr) {
    const stuck = stuckOf(t, r.ctx);
    const gapLines = reads && draftHasGaps(t) ? draftGapsOf(r, t, reads) : null;
    const need = prPlain(r, t, gapLines, reads), note = [captureNote(stuck), doneNote(t)].filter(Boolean).join(' ');
    // Closed unmerged: nothing merges it, so the ticket leaves the batch, or goes back for a new PR.
    if (t.pr_status?.state === 'CLOSED') return { kind: 'pr', need, note, actions: [['drop', 'its PR was closed without merging, so nothing will merge it; drop takes the ticket out of the batch and removes its clean worktree'], ['requeue'], ['not-now']] };
    const openPr = (...actions) => ({ kind: 'pr', need, note, actions: [...actions, SEND_BACK, ['not-now']] });
    // Findings left beside the gaps are still a worker's to fix, so fix stays on offer. Gaps that only
    // the person's own comment accepts take no answer desk would post: the need gives the ready comment,
    // and the pass reads it from the PR once it is there.
    const tagged = draftHasGaps(t) ? gapLines ?? [] : personGapsIn(stuck?.why);
    if (reviewGaps(t, stuck) && tagged.length && tagged.every(acceptOnly)) {
      return { kind: 'pr', need, note, actions: [['not-now', 'post the ready comment from your own GitHub account: not-now keeps it off this list, and the next pass reads your comment and sends the PR to a worker that records the acceptance'], ...(stuck && personReviewFix(t, { why: stuck.why }) ? [['fix', 'its findings are in the code: fix sends it to a worker on the PR for one more try, and leaves the gaps for your comment']] : []), SEND_BACK] };
    }
    if (reviewGaps(t, stuck)) return openPr(['answer', 'say how to settle its review gaps; it is posted on the PR and a worker on the PR carries it out'], ...(stuck && personReviewFix(t, { why: stuck.why }) ? [['fix', 'its findings are in the code: fix sends it to a worker on the PR for one more try, and leaves the gaps for your answer']] : []), ['done']);
    // Held by nothing but a person's approval: once asked for, there is nothing to do but wait for it.
    const ask = approvalAsk(t, prWhy(r, t) ?? {});
    if (ask && !ask.left.length) return { ...openPr(['waiting', 'once the approval is asked for, waiting keeps it off this list until it gets one or its head moves'], ['done']), approval: true };
    // A check build desk ran that failed is the branch's to fix, so a worker on the PR is recommended.
    if (stuck?.checks.some((c) => c.build)) {
      return { kind: 'pr', need, note, actions: [[SEND_BACK[0], 'desk built it and the build failed, which a change on its branch fixes: resume "<instruction>" sends it to a worker on the PR with what to fix', SEND_BACK[2]], ['done'], ['not-now']] };
    }
    // A step off GitHub (a staging migration, a build desk does not run) has no recommendation: its need
    // names the step, and the item leaves the list once every check it is still stuck on is green.
    const outside = stuck?.outside ?? [];
    if (outside.length) {
      const checks = `${stuck.checks.map((c) => `"${c.name}"`).join(', ')} ${stuck.checks.length === 1 ? 'is' : 'are'} green`;
      return openPr(['done', null, `the step is outside GitHub (${outside.map((c) => c.command).join('; ')}); it drops off once ${checks}`]);
    }
    // Review findings in the code are a worker's to fix, so one more try goes to a worker on the PR.
    if (stuck && personReviewFix(t, { why: stuck.why })) {
      return openPr(['fix', "its findings are in the code, which a worker can fix: fix sends it to a worker on the PR for one more try, and the review of its new head says whether they are gone"], ['done']);
    }
    // A failing log that names its cause is code a person or a worker can fix, so no step only they can do.
    if (stuck?.checks.some((c) => c.error)) return openPr(['done', 'desk\'s workers could not clear what its log names; say done once it is fixed, and the PR is checked on GitHub there and then']);
    // Desk's own upload crashed on every try: the saved output says why, and the files are still there.
    if (UPLOAD_CRASHED.test(String(t.undraft?.why ?? ''))) return openPr(['done', "desk's upload crashed on every try it gets, and its saved output says why; say done once no screenshot cell is left, and the PR is checked on GitHub there and then"]);
    // A hold with no routine whose step an agent can check waits on a config change, not on the person's step.
    const w = prWhy(r, t);
    if (w?.code === 'hold' && !w.routine && !w.failed && !holdNeedsPerson(w.why)) return openPr(['done', 'the hold needs a routine in the config; say done once it has one, and the PR is checked on GitHub there and then']);
    return openPr(['done', 'only you can do this step; say done once you have, and the PR is checked on GitHub there and then']);
  }
  // A worktree the pass will not spawn into (desk-q worktreeBusy): only the person, or the session in
  // it, makes it clean, and the pass drops the record once it is.
  const wb = worktreeBusy(t);
  // Requeued off a park and held here: the park says why its worker stopped, and the ticket is queued
  // already, so a resume only records what the next worker should know.
  // A reworded need is put off by its raw text (putOffKey), so a change of wording brings back nothing.
  if (busyPark(t)) return { kind: 'worktree', need: parkNeed(busyPark(t).question), rawNeed: one(busyPark(t).question), note: `${capital(worktreeBusyText(wb))}.`, actions: [['resume', 'say what you did about it; a worker finishes it, with your note in its briefing, once a pass finds its worktree clean'], ['not-now']] };
  if (wb) return { kind: 'worktree', need: worktreeBusyText(wb), actions: [['done', 'commit, push or discard its changes (or end the session working in it), then say done; the next pass that finds it clean starts it'], ['not-now']] };
  // A stopped or outside-held ticket whose PR merged in another repo, where it was built, is done.
  const elsewhere = x.k === 'failed' || x.k === 'stuck' ? mergedElsewhere(r, t, finds) : null;
  const shipped = (item) => (elsewhere ? { ...item, elsewhere, actions: shippedFirst(item.actions, elsewhere) } : item);
  if (x.k === 'failed' && sessionPark(parkText(r, t))) return shipped({ kind: 'stopped', need: `worker stopped: ${parkNeed(parkText(r, t))}`, rawNeed: `worker stopped: ${one(parkText(r, t))}`, actions: withDrop(r, t, [['open', sessionWhy(parkText(r, t))], ['not-now']]) });
  if (x.k === 'failed') {
    // A park file saying it has no worker work recommends drop over a requeue that would only park it again.
    const actions = [['requeue', 'its worker gave up; requeue sends it back for a new worker to start again'], ['not-now']];
    // With no reason of its own recorded, its need is its park in plain words, not the raw question.
    const said = String(t.failed?.why ?? '').trim() ? '' : parkNeed(parkText(r, t));
    return shipped({ kind: 'stopped', need: said ? `worker stopped: ${said}` : needText(r, x), rawNeed: said ? `worker stopped: ${one(parkText(r, t))}` : needText(r, x), actions: [...(noWorkerWork(parkText(r, t)) ? withDrop(r, t, actions) : actions), ...moveAction(r)] });
  }
  // Held by open tickets outside the batch, held inside it or not, with its question on them open. A
  // blocker no batch holds is worked by nobody, so admitting it comes first when every such blocker is
  // the person's to queue (notAdmittable); when one is not, it is its owner's or already under way, so
  // putting the item off comes first and admit is only offered. Answering says whether this one can
  // start without them.
  if (x.k === 'stuck') {
    const outside = outsideHolds(r, t), freeHolds = outside.filter((o) => !o.batch), free = freeHolds.map((o) => o.key);
    const single = free.length === 1;
    const admitWhy = `${andList(free)} ${single ? 'is' : 'are'} in no batch, so nothing works ${single ? 'it' : 'them'}: admitting queues ${single ? 'it' : 'them'} for a worker`;
    const rules = free.length ? admitRules(r) : null;
    const notYours = freeHolds.map((o) => notAdmittable(o, rules)).filter(Boolean);
    const answerWhy = 'say whether it can start without the tickets outside; the next pass can then start it';
    const need = `held by ${andList(outside.map(holdWords))}, outside this batch`;
    // Put off without each blocker's Jira status, which moves in flight.
    const putOffNeed = `held by ${andList(outside.map((o) => `${o.key} (${batchWords(o)})`))}, outside this batch`;
    if (notYours.length) {
      return shipped({ kind: 'held', need, putOffNeed, outside: outside.map((o) => o.key), actions: [['not-now', `${notYours.join('; ')}. So ${notYours.length === 1 ? 'it is' : 'they are'} not yours to queue here; not-now puts this off until a blocker moves`],
        ['admit', null, admitWhy], ['answer', null, answerWhy]] });
    }
    const admit = free.length ? [['admit', admitWhy]] : [];
    return shipped({ kind: 'held', need, putOffNeed, outside: outside.map((o) => o.key),
      actions: [...admit, admit.length ? ['answer', null, answerWhy] : ['answer', answerWhy], ['not-now']] });
  }
  // A held ticket with a question of its own is asked that question, below.
  if (isHeld(t) && !heldAsks(t)) {
    const h = holdOf(r.q, t, r.ctx);
    // Where its hold names one blocker, start lifts that one alone and the ticket waits on any other.
    const f = h.lift ? freeFrom(t, h.lift, r.q) : null;
    const why = f && !f.release ? `lifts its hold on ${h.lift} alone; ${f.open.length ? `it stays held behind ${andList(f.open)}` : 'it keeps its own park'}` : 'nothing else lets it start, and once you do the next pass can start it';
    return h.act
      ? { kind: 'held', need: h.text, ...(h.lift ? { lifts: h.lift } : {}), actions: [['start', why], ['not-now']] }
      : { kind: 'held', need: h.text, actions: [['done', 'only you can do this step; say done once you have'], ['not-now']] };
  }
  if (t.state === 'parked' && !isHeld(t)) {
    const need = parkNeed(t.park?.question) || 'parked, with no question recorded';
    // What its worktree holds that origin does not, as the last pass read it.
    // A gated write's exact text (park.approve) is printed whole under the question by listText; the
    // note points the session there, since it asks from this one line.
    const approval = t.park?.approve?.body ? 'Its exact text awaiting approval follows this line: show it verbatim before you ask.' : '';
    // park.stale explains a condition the pass recorded none; once a new one is recorded it no longer applies.
    const stale = t.park?.stale && t.park.clears_when?.kind === 'none' ? `${capital(t.park.stale)}.` : '';
    const note = [stale, t.park?.unpushed ? `${capital(t.park.unpushed)}.` : '', approval].filter(Boolean).join(' ') || undefined;
    if (planPark(t)) return { kind: 'plan', need, note, actions: [['answer', 'say start, discard, or the edit to make; the supervisor acts on it at its next tick: an edit is applied and the batch starts, and one it cannot apply comes back here naming why'], ['not-now']] };
    const sp = spinePark(t);
    if (sp === 'approval') return { kind: 'spine', need, note, actions: [['approve', 'its acceptance specs passed the spec check'], ['reject'], ['not-now']] };
    if (sp === 'specs') return { kind: 'spine', need, note, actions: [['reject', 'its acceptance specs failed the spec check, so it goes back with what to fix'], ['not-now']] };
    if (t.park?.session_step) return { kind: 'session', need: `you approved a step no worker can run: ${one(t.park.session_step.step)}`, note, actions: withDrop(r, t, [['open', STEP_WHY], STEP_DONE, STEP_ANSWER, ['not-now']]) };
    if (sessionPark(parkText(r, t))) return { kind: 'session', need, note, actions: withDrop(r, t, [['open', sessionWhy(parkText(r, t))], ...handBack(r, t), SESSION_DONE, ['not-now']]) };
    if (needsSession(t)) return { kind: 'session', need, note, actions: withDrop(r, t, [['open', SESSION_WHY], ...handBack(r, t), SESSION_DONE, ['not-now']]) };
    if (triagePark(t)) return { kind: 'session', need, note, actions: withDrop(r, t, [['open', "it needs splitting or its ticket links fixing, which a worker can't do, so it needs you"], SESSION_DONE, ['not-now']]) };
    const { taken, overrides } = readDecisions(r.stateDir);
    const overridden = new Set(overrides.map((o) => o.override_of));
    const offer = taken.filter((d) => d.ticket === t.key && !d.lever && !overridden.has(d.id)).slice(-DECISIONS_SHOWN).reverse()
      .map((d) => [`override ${d.id}`, null, `took "${cut(one(d.chose), 40)}" on "${cut(one(d.question), 60)}"`]);
    // A step only the person or another account takes: nothing a worker does moves it, so no action is
    // the recommendation, and resume reads its PR on GitHub before it requeues (record).
    const step = personOnlyStep(parkText(r, t));
    if (step) return { kind: 'parked', personOnly: step, need: `a step only you or another account takes: ${plainTerms(step)}${one(parkText(r, t)) === step ? '' : ` (${need})`}`, note,
      actions: [['resume', null, PERSON_RESUME_NOTE], ['drop', null, DROP_NOTE], ['not-now'], ...moveAction(r), ...offer] };
    // No bare answer: it would leave the ticket parked, and desk-q still counting it.
    return { kind: 'parked', need, note, actions: [...withDrop(r, t, [['resume', 'a worker finishes it once it has your answer'], ['not-now']]), ...moveAction(r), ...offer] };
  }
  // Its questions as the digest page words them, so a put-off entry keys to the same text.
  const need = one(openQuestions({ ...digestList(r)[0], triage: (k) => triageOf(r, k) }).find((q) => q.ticket === t.key && q.kind === 'triage')?.text) || `${t.open_questions} triage question(s) open`;
  return { kind: 'triage', need, actions: [['answer', 'answering clears its questions, so the next pass can start it'], ['not-now']] };
}

// The question and inputs an item is put off under. A park is keyed as answer.mjs records it, to its
// question and park inputs; anything else to its ticket and kind, since several tickets share a need's
// words, with its need, PR head and the settled states of any blockers it names as inputs, so a moved
// head or a blocker added, removed or done brings it back. A PR's need is left out: it carries the age
// of its running checks. An outside hold's need is keyed without its blockers' Jira statuses.
// `legacy` reads an entry's inputs as recorded before blockers were settled, so an older entry stays
// put off while what it keys to is unchanged.
const PARK_KINDS = ['parked', 'session', 'spine', 'plan'];
const KEPT_ASKS = ['reviewer', 'drift', 'tmpfs'];
function putOffKey(r, t, item) {
  if (PARK_KINDS.includes(item.kind)) return { question: t.park?.question ?? '', inputs: t.park?.inputs ?? {} };
  // A step: what waits on it in every batch of the repo, not its need, which names only those passed.
  if (item.kind === 'step') return { question: `${t.key} step`, inputs: { ticket: t.key, waiting: item.waiting.join(', ') } };
  if (item.kind === 'follow') return { question: `${t.key} follow-on`, inputs: { ticket: item.ticket, steps: item.need } };
  // A ticket newly held behind it brings it back.
  if (item.finished) return { question: `${t.key} finished`, inputs: { blocker: item.finished, waiting: item.waiting.join(', ') } };
  if (item.planFirst) return planFirstPutOff(item.planFirst);
  if (item.blocker) return { question: `${t.key} link`, inputs: { ticket: item.ticket, blocker: item.blocker } };
  // A promotion PR opened, or one that changes state, brings it back.
  if (item.unpromoted) return { question: `${t.key} unpromoted`, inputs: { ticket: item.ticket, blocker: item.waitsOn, branch: item.unpromoted.branch, pr: String(item.unpromoted.pr ?? 'none'), state: item.unpromoted.state } };
  if (item.promotion != null) return { question: `${t.key} red`, inputs: { 'pr-head': item.head, checks: item.checks.join(', ') } };
  // An ask desk keeps up to date itself is the same ask while its id stands: new wording brings nothing back.
  if (item.kind === 'ask' && KEPT_ASKS.includes(item.settles)) return { question: `${t.key} ask`, inputs: { ticket: t.key }, legacy: ({ need, ...was }) => was };
  const inputs = { ticket: t.key };
  if (item.kind === 'pr') inputs['pr-head'] = t.pr_status?.head ?? '';
  else inputs.need = item.putOffNeed ?? item.rawNeed ?? item.need;
  if (item.approval) inputs.approvals = (t.pr_status?.approvals ?? []).join(', ') || 'none';
  // A worktree item led by its park's reason holds the worktree's state in its note: a new hold brings it back.
  if (item.kind === 'worktree' && item.note) inputs.hold = item.note;
  const blockers = blockerStates(r, t);
  if (blockers || item.kind === 'held') inputs.blockers = blockers;
  const legacy = (was) => {
    const out = { ...was };
    if (typeof out.blockers === 'string') out.blockers = blockerList(out.blockers.split(',').filter(Boolean).map((p) => { const i = p.lastIndexOf(':'); return [p.slice(0, i), p.slice(i + 1)]; }));
    if (item.putOffNeed && typeof out.need === 'string') out.need = out.need.replace(LEGACY_HOLD, '($1)');
    return out;
  };
  return { question: `${t.key} ${item.kind}`, inputs, legacy };
}
// The ticket an item is about, as desk-q's TICKET column shows it: `item.ticket` where it has one, else
// its key past a follow:, link:, unpromoted: or step: prefix.
export const itemKey = (t, item) => item.ticket ?? (/^(follow|link|unpromoted|step):/.test(t.key) ? t.key.replace(/^[a-z]+:/, '').split(':')[0] : t.key);
// lookup, with an entry recorded in an older form read through the key's `legacy`.
function lookupItem(register, key) {
  const l = lookup(register, key);
  if (l.status !== 'changed' || !key.legacy) return l;
  const was = key.legacy(l.entry.inputs ?? {});
  return inputsHash(was) === inputsHash(key.inputs) ? { status: l.entry.dismissed ? 'dismissed' : 'put_off', entry: l.entry } : { ...l, line: changedLine(l.entry, changes(was, key.inputs)) };
}

// A needs row as an item, and what the not-now register says of it: the one rule desk-q's count and
// this list both go by. An item put off with unchanged inputs is asked again once it offers an action
// it did not offer then. An entry from before entries recorded actions is asked again once, and
// records them. Every way of putting an item off records them since (stampActions), so one written
// since without them is an item no batch listed when it was put off: it stays put off on its inputs.
const ACTIONS_SINCE = Date.parse('2026-11-01T15:00:00Z');
const recordedBefore = (e) => !(Date.parse(e.at) >= ACTIONS_SINCE);
// A put-off item is listed anyway, first, while this many tickets of its batch are held behind it.
export const HOLDS_BACK = 3;
// How many held tickets of r's batch wait behind `key`: held by it, or by a ticket held behind it.
export const heldBehind = (r, key) => heldBehindOf(r.q, key).size;
// How many held tickets wait behind a repo-level item, over the [batch, ticket] pairs it stands for:
// each one's held tickets, once each per batch, plus the pairs themselves where `self` (a step's
// waiting tickets wait on it; an unset row's parked tickets are the item, not behind it).
function heldBehindAll(pairs, self = false) {
  const all = new Set();
  for (const [b, key] of pairs) {
    if (self) all.add(`${b.stateDir}\t${key}`);
    for (const k of heldBehindOf(b.q, key)) all.add(`${b.stateDir}\t${k}`);
  }
  return all.size;
}
const holdingWords = (n) => `${n} tickets wait behind it, so it is listed though you put it off`;
const behindWords = (n) => (n === 1 ? '1 ticket waits behind this' : `${n} tickets wait behind this`);
// What a reply putting `key` off adds while enough tickets wait behind it that it stays listed.
const stillWords = (n) => (n >= HOLDS_BACK ? ` It is still listed while ${HOLDS_BACK} or more tickets wait behind it (${n} do now).` : '');
const stillListed = (r, key) => stillWords(heldBehind(r, key));
function judged(r, x, register, reads = null) {
  const item = itemOf(r, x, reads);
  const l = lookupItem(register, putOffKey(r, x.t, item));
  const behind = heldBehind(r, x.t.key);
  // A listed item says how many held tickets wait behind it, and ranks by that (collect).
  const counted = behind > 0 ? { ...item, need: `${item.need} (${behindWords(behind)})`, behind } : item;
  if (l.status !== 'put_off') return { item: counted, l };
  const shown = behind >= HOLDS_BACK ? { ...item, need: `${item.need} (${holdingWords(behind)})`, behind } : item;
  const was = Array.isArray(l.entry.actions) ? l.entry.actions : null, now = verbsOf(item);
  if (was ? now.every((a) => was.includes(a)) : !recordedBefore(l.entry)) return shown === item ? { item, l } : { item: shown, l: { status: 'holding', entry: l.entry } };
  return { item: shown === item ? counted : shown, l: { status: 'changed', entry: l.entry, line: changedLine(l.entry, [`actions ${was ? was.join(', ') : '(not recorded)'} → ${now.join(', ')}`]) } };
}

// Whether ticket `t`, held by open tickets outside its batch (desk-q's stuck), is put off with not-now
// as this list judges it: one a moved blocker or a new action has brought back is not, and one listed
// only because enough tickets wait behind it still is. `r` needs only the batch's slug, state directory
// and queue (`q`), as pass.mjs has them.
export const heldPutOff = (r, t) => ['put_off', 'holding'].includes(judged(r, { t, k: 'stuck' }, readRegister(r.stateDir)).l.status);

// Records on a ticket's put-off entry the actions its item offers now, so one it gains later brings it
// back (judged). answer.mjs and not-now.mjs add call it once they have put a question off, as this
// file's not-now does: neither knows an item's actions. The batch is the one whose state directory is
// `stateDir`. Returns the actions recorded, or null where that batch lists no item for the ticket or
// the item is keyed to another question than the one put off: an older entry of the item's own is
// never stamped, or the actions it gained since would hide it again.
export function stampActions({ stateDir, ticket, question, now = Date.now(), repos = loadRepos(now) }) {
  const r = repos.find((b) => b.q && resolve(b.stateDir) === resolve(stateDir));
  const x = r && needsRows(r).find((y) => y.t.key === ticket);
  const item = x && itemOf(r, x, null, READS);
  return item && questionKey(putOffKey(r, x.t, item).question) === questionKey(question) ? stampItem(r, x, item) : null;
}
function stampItem(r, x, item) {
  const l = lookupItem(readRegister(r.stateDir), putOffKey(r, x.t, item));
  if (l.status !== 'put_off') return null;
  const actions = verbsOf(item);
  if (l.entry.actions?.join() !== actions.join()) addPutOff({ ...l.entry, actions }, r.stateDir);
  return actions;
}

// desk-q's NEEDS YOU count for a batch, or for a repo row of several (each row keyed in its own batch,
// `b`): the rows that need the person (`rows`), plus its person's-step items (stepItems), as
// `shown`, less `putOff`, those put off with unchanged inputs. A row held only by a person's step
// is in `stepRows`, not `rows`, while a step holding it is not put off: it needs the person, but is
// counted once, through its step item. A reader that draws "not in rows" as put off counts
// `stepRows` as needing the person too, so a row whose every step is put off is drawn put off.
// `items` are the counted items that are not ticket rows (steps, follow-ons, asks, sign-ins, …), each
// { r, t, item }, so a reader can draw a row for every one it counts; `offItems` those put off.
// Follow steps are not in `shown` or `items`: `follows` lists those nobody has taken on and `checking`
// those a session has claimed (followChecks), desk-q's "checks after merge".
export function needsCount(r) {
  const registers = new Map();
  const register = (b) => { if (!registers.has(b.stateDir)) registers.set(b.stateDir, readRegister(b.stateDir)); return registers.get(b.stateDir); };
  const rows = [], held = [];
  let putOff = 0;
  const items = [], offItems = [];
  // An item that is no ticket row, by its register entry: put off, dropped (neither listed nor
  // counted), or listed, `listed` saying so. `dir` is the state folder it is put off in.
  const place = (s, dir, listed = () => {}) => {
    const st = lookupItem(register({ stateDir: dir }), putOffKey(s.r, s.t, s.item)).status;
    if (st === 'dismissed') return;
    if (st === 'put_off') { putOff++; offItems.push(s); } else { items.push(s); listed(); }
  };
  // A batch's base-sync, base-push and subscription-off items are no ticket's row, so they are items.
  for (const x of countedBatchRows(r)) {
    const { item, l } = judged(x.b, x, register(x.b));
    if (l.status === 'dismissed') continue;
    if (l.status === 'put_off') { putOff++; offItems.push({ r: x.b, t: x.t, item }); } else items.push({ r: x.b, t: x.t, item });
  }
  for (const x of needsRows(r)) {
    const b = x.b ?? r;
    if (stepHeld(b, x) || noPrHeld(b, x) || planFirstHeld(x)) { held.push(x); continue; }
    if (judged(b, x, register(b)).l.status === 'put_off') putOff++; else rows.push(x);
  }
  const live = new Set(), liveNoPr = new Set();
  for (const s of stepItems((r.batches ?? [r]).filter((x) => x.q))) place(s, s.dir, () => live.add(s.item.step));
  for (const s of (r.batches ?? [r]).filter((x) => x.q).flatMap(noPrItems)) place(s, s.r.stateDir, () => liveNoPr.add(`${s.r.stateDir}\t${s.item.finished}`));
  // A plan-first item put off or dropped is still listed while HOLDS_BACK or more wait behind it.
  const livePlanFirst = new Set();
  for (const s of (r.batches ?? [r]).filter((x) => x.q).flatMap(planFirstItems)) {
    const st = lookupItem(register(s.r), putOffKey(s.r, s.t, s.item)).status;
    const holding = s.behind >= HOLDS_BACK;
    if (st === 'dismissed' && !holding) continue;
    if (st === 'put_off' && !holding) { putOff++; offItems.push(s); } else { items.push(s); livePlanFirst.add(s.r.stateDir); }
  }
  // A row held by a step or a blocker with no PR is drawn as needing the person while that item is listed.
  const stepRows = held.filter((x) => {
    const b = x.b ?? r;
    return startSteps(b.q, x.t, b.ctx?.stepOf).some((k) => live.has(k)) || unmergedBlockers(b.q, x.t).some((k) => liveNoPr.has(`${b.stateDir}\t${k}`))
      || (planFirstHeld(x) && livePlanFirst.has(b.stateDir));
  });
  // A follow step is a check after a merge, counted apart from what needs the person: `follows` those
  // nobody has taken on, `checking` those a session has a live claim on (item.claim), neither in `shown`.
  const follows = [], checking = [];
  for (const b of (r.batches ?? [r]).filter((x) => x.q)) {
    const off = [];
    for (const f of followChecks(b, register(b), Date.now(), off)) (f.item.claim ? checking : follows).push(f);
    putOff += off.length;
    offItems.push(...off);
  }
  for (const f of (r.batches ?? [r]).filter((x) => x.q).flatMap((b) => [...linkItems(b), ...unpromotedItems(b), ...promotionItems(b), ...baseRedItems(b), ...duplicateItems(b)])) place(f, f.r.stateDir);
  for (const s of reviewerItems((r.batches ?? [r]).filter((x) => x.q))) place(s, s.dir);
  const own = (r.batches ?? [r]).filter((x) => x.q);
  for (const s of [...signinItems(own, own), ...pageItems(own, { home: true })]) place(s, s.dir);
  for (const s of [...askItems(r.batches ?? [r]), ...stalledItems(own), ...ticketlessItems(own), ...cloudItems(own), ...proposalItems(own)]) place(s, s.dir);
  return { shown: rows.length + items.length, putOff, rows, stepRows, items, offItems, follows, checking };
}

// The batches `word` names, else every batch desk-q's home screen shows.
const scopeOf = (repos, word) => (word ? batchesNamed(repos, word) : { named: null, scope: shownRepos(repos, false) });

// Every item desk-q counts as needing the person, in the batches `word` names (all when null), less
// those put off with unchanged inputs (`putOff` counts them). One whose inputs changed says what did.
// A usage-limit hold is an item here, but not in desk-q's count; a base-push or subscription-off item is in both.
// `reads` (READS) is how a draft whose review left gaps quotes them from GitHub; null reads none.
// `ciRed` (READS.ciRed) reads the red-main issues assigned to the person; null reads none.
export function collect({ word = null, now = Date.now(), repos = loadRepos(now, word), reads = READS, ciRed = reads?.ciRed ?? null } = {}) {
  const { named, scope } = scopeOf(repos, word);
  const items = [], off = [];
  let putOff = 0;
  const seen = new Map();
  const unsetIn = (slug, k) => { const id = `${slug}\t${k}`; if (!seen.has(id)) seen.set(id, repoPermissionUnset(slug, k)); return seen.get(id); };
  const groups = new Map();
  // Tickets parked on a claude.ai artifact no session has read, by repo: one item each (artifactsItem).
  const unread = new Map();
  // The repo-level and step items, put off under their own key as any other item is.
  // `dir` is where it is put off, its batch's state folder unless the item names another.
  // `behind` held tickets wait behind it: it says so and ranks by that, as a ticket's item does (judged).
  // `say` false ranks it without the words. `holds`: put off, it is still listed while HOLDS_BACK or more
  // wait behind it, as a ticket's item is. One put off is kept in `off`, unlisted, for a drop to find;
  // one dropped is neither listed nor counted.
  const repoItem = (r, t, item, since, dir = r.stateDir, behind = 0, say = true, holds = false) => {
    const key = putOffKey(r, t, item);
    const l = lookupItem(readRegister(dir), key);
    const holding = (l.status === 'put_off' || l.status === 'dismissed') && holds && behind >= HOLDS_BACK;
    if (l.status === 'dismissed' && !holding) return;
    if (l.status === 'put_off' && !holding) { putOff++; off.push({ r, t, ...item, putOffKey: key, putOffDir: dir, since }); return; }
    if (l.status === 'changed') item.need = `${item.need} (${l.line})`;
    if (behind > 0 && say) item.need = `${item.need} (${(holding ? holdingWords : behindWords)(behind)})`;
    items.push({ r, t, ...item, putOffKey: key, putOffDir: dir, since, broken: false, ...(behind > 0 ? { behind } : {}) });
  };
  for (const r of scope.filter((x) => !x.error && x.q)) {
    const register = readRegister(r.stateDir);
    for (const x of [...batchRows(r), ...needsRows(r)]) {
      if (stepHeld(r, x) || noPrHeld(r, x) || planFirstHeld(x)) continue;
      const { item, l } = judged(r, x, register, reads);
      if (l.status === 'dismissed') continue;
      // A put-off batch-wide hold is no ticket row, so a drop finds it in `off` as a repo-level item.
      if (l.status === 'put_off') { putOff++; if (!r.q.tickets?.[x.t.key]) off.push({ r, t: x.t, ...item, putOffKey: putOffKey(r, x.t, item), putOffDir: r.stateDir }); continue; }
      const since = x.baseSync ? timeOf(r.q.base_sync_stuck.since) : x.usage ? timeOf(r.q.usage_hold.since) : x.basePush ? timeOf(r.q.base_push_ask.since) : x.subOff ? timeOf(r.q.subscription_off.since) : timeOf(x.t.park?.since ?? (x.pr ? x.t.undraft?.at : null) ?? x.t.added_at);
      const row = item.kind === 'parked' ? unsetRowOf(r, x.t, unsetIn) : null;
      if (row) {
        const id = `${r.slug}\t${row}`;
        if (!groups.has(id)) groups.set(id, { r: standingOf(repos, r), key: row, parked: [] });
        groups.get(id).parked.push({ r, t: x.t, since });
        continue;
      }
      const urls = item.kind === 'parked' && !item.personOnly ? designParkUrls(x.t.park?.question) : null;
      if (urls?.length) {
        if (!unread.has(r.slug)) unread.set(r.slug, { r: standingOf(repos, r), parked: [] });
        unread.get(r.slug).parked.push({ r, t: x.t, since, urls });
        continue;
      }
      if (l.status === 'changed') item.need = `${item.need} (${l.line})`;
      items.push({ r, t: x.t, ...item, since, broken: PRODUCTION_BROKEN.test(x.t.park?.question ?? '') });
    }
  }
  // A step once for its repo, over every readable batch of it, listed where a batch in scope waits on it.
  const inScope = scope.filter((x) => !x.error && x.q);
  for (const slug of new Set(inScope.map((x) => x.slug))) {
    const dirs = new Set(inScope.filter((x) => x.slug === slug).map((x) => resolve(x.stateDir)));
    for (const s of stepItems(repos.filter((x) => x.slug === slug && !x.error && x.q))) {
      if ([...s.in].some((b) => dirs.has(resolve(b.stateDir)))) repoItem(s.r, s.t, s.item, s.item.since, s.dir, s.behind, s.said);
    }
  }
  // A follow item a session has a live claim on (claim) is that session's to check: in `checking`, not
  // listed, until it is done or the claim lapses. Put off or dropped, it stays so.
  const checking = [];
  for (const f of inScope.flatMap((b) => [...followItems(b, reads), ...linkItems(b), ...unpromotedItems(b), ...duplicateItems(b)])) {
    const claim = f.item.kind === 'follow' ? liveClaim(f.r, f.t.key, readRegister(f.r.stateDir), now) : null;
    const key = claim && putOffKey(f.r, f.t, f.item);
    if (claim && !['put_off', 'dismissed'].includes(lookupItem(readRegister(f.r.stateDir), key).status)) checking.push({ r: f.r, t: f.t, ...f.item, claim, putOffKey: key, putOffDir: f.r.stateDir, since: f.item.since, broken: false });
    else repoItem(f.r, f.t, f.item, f.item.since, f.r.stateDir, f.behind ?? 0);
  }
  for (const f of inScope.flatMap(noPrItems)) repoItem(f.r, f.t, f.item, f.item.since, f.r.stateDir, f.behind, f.said);
  for (const f of inScope.flatMap(planFirstItems)) repoItem(f.r, f.t, f.item, f.item.since, f.r.stateDir, f.behind, true, true);
  for (const f of inScope.flatMap(baseRedItems)) repoItem(f.r, f.t, f.item, f.item.since, f.r.stateDir, f.behind, false);
  // Its need names the follow items waiting on it, so it ranks by them without saying the count.
  for (const f of inScope.flatMap(promotionItems)) repoItem(f.r, f.t, f.item, f.item.since, f.r.stateDir, f.behind, false);
  for (const slug of new Set(inScope.map((x) => x.slug))) {
    for (const s of reviewerItems(repos.filter((x) => x.slug === slug && !x.error && x.q))) repoItem(s.r, s.t, s.item, s.item.since, s.dir);
  }
  for (const s of stalledItems(inScope, now)) repoItem(s.r, s.t, s.item, s.item.since, s.dir);
  for (const s of signinItems(inScope, word ? inScope : null)) repoItem(s.r, s.t, s.item, s.item.since, s.dir);
  for (const s of pageItems(inScope)) repoItem(s.r, s.t, s.item, s.item.since, s.dir);
  for (const s of leaseTrialItems(repos, named, now)) repoItem(s.r, s.t, s.item, s.item.since, s.dir);
  for (const s of askItems(scope)) repoItem(s.r, s.t, s.item, s.item.since, s.dir);
  for (const s of proposalItems(inScope)) repoItem(s.r, s.t, s.item, s.item.since, s.dir);
  for (const s of ticketlessItems(inScope)) repoItem(s.r, s.t, s.item, s.item.since, s.dir);
  for (const s of cloudItems(inScope)) repoItem(s.r, s.t, s.item, s.item.since, s.dir);
  // Unscoped, every configured repo: a quiet repo, which the home screen does not show, is where a lane goes stale.
  if (ciRed) for (const s of ciRedItems(repos, word ? scope : repos, ciRed)) repoItem(s.r, s.t, s.item, s.item.since, s.dir);
  for (const g of groups.values()) repoItem(g.r, { key: `${UNSET}${g.key}` }, unsetItem(g), finite(Math.min(...g.parked.map((p) => p.since ?? Infinity))), g.r.stateDir, heldBehindAll(g.parked.map((p) => [p.r, p.t.key])));
  for (const g of unread.values()) repoItem(g.r, { key: ARTIFACTS }, artifactsItem(g), finite(Math.min(...g.parked.map((p) => p.since ?? Infinity))), g.r.stateDir, heldBehindAll(g.parked.map((p) => [p.r, p.t.key])));
  const slugs = new Set((word ? scope : repos).map((x) => x.slug));
  for (const slug of slugs) {
    const r = repos.find((x) => x.slug === slug && x.batch == null);
    const item = r && !r.error ? templatesItem(r, templatesRecord(slug)) : null;
    if (item) repoItem(r, { key: TEMPLATES }, item, item.since);
  }
  for (const i of items) i.cause = causeOf(i);
  // Heads of one batch with tickets waiting behind them go in build order (its queue's), as a fork's do.
  const built = (x) => Object.keys(x.r?.q?.tickets ?? {}).indexOf(x.t.key);
  const heads = (a, b) => (a.r === b.r && (a.behind ?? 0) > 0 && built(a) >= 0 && built(b) >= 0 ? built(a) - built(b) : 0);
  items.sort((a, b) => (b.broken - a.broken) || (!!b.holdsAll - !!a.holdsAll) || ((b.behind ?? 0) - (a.behind ?? 0)) || heads(a, b) || ((a.since ?? Infinity) - (b.since ?? Infinity)) || a.t.key.localeCompare(b.t.key));
  // Green PRs whoever merges for the batch takes (desk-q batchMerging): shown, never the person's items.
  const moving = scope.filter((x) => !x.error && x.q).flatMap((r) => batchMerging(r).map((m) => ({ r, ...m })));
  return { repos, scope, items, named, putOff, off, moving, checking };
}

const actionText = ([name, why, note], i) => `${i + 1}. ${name}${why ? ` (recommended: ${why})` : note ? ` (${note})` : ''}`;
const runLine = (r) => {
  const w = runner(r);
  return `@ ${r.name}: ${w.by === 'supervisor' ? 'run by the supervisor; an answer wakes it, and its next pass picks the answer up'
    : w.by === 'session' ? `run by a live session${w.name ? ` (${w.name})` : ''}; resumes go to it by message`
      : `passes stopped; answers wait until they resume. To resume: ${w.resume}`}`;
};

// The put-off count, after the item count: they are not listed again until their inputs change.
const putOffLine = (c) => (c.putOff ? ` ${c.putOff} put off with not-now, left out until ${c.putOff === 1 ? 'it changes' : 'they change'}.` : '');
// The PRs that move without the person, on the same line, in desk-q's words for its Merging row.
const movingLine = (c) => (c.moving ?? []).map((m) => ` Moves without you: PR #${m.pr} (${m.key}${c.named ? '' : `, ${m.r.name}`}), ${m.text}.`).join('')
  + (c.checking ?? []).map((i) => ` Checking (${i.claim.session}): ${i.t.key}${c.named ? '' : `, ${i.r.name}`}, a check after merge that session took on.`).join('');

// A parked write awaiting approval, as listText prints it under its item: a header naming its kind and
// target, the body line for line as the worker wrote it, and an end line, so the body is never cut or
// reworded and nothing after it reads as part of it.
export const approvalLines = (key, a) => [
  `--- ${key} awaiting approval: ${a.kind} on ${a.target}, the exact text ---`,
  ...String(a.body).split('\n'),
  `--- end of ${key}'s text awaiting approval ---`,
];

export function listText(c, now = Date.now()) {
  if (!c.items.length) return `Nothing needs you${c.named ? ` in ${c.named.name}` : ''}.${putOffLine(c)}${movingLine(c)}`;
  // A repo-level item is the person's own step, so who runs the batch says nothing about it.
  const lines = [...new Set(c.items.filter((i) => !i.repoLevel).map((i) => i.r))].map(runLine);
  const repos = [...new Set(c.items.map((i) => i.r))];
  for (const i of c.items) {
    const waited = i.since == null ? '' : ` ${since(now - i.since)}`;
    // The need is never cut: the session asks from this line, so a recommendation or URL in it must
    // survive. A done note follows it whole: what GitHub showed when the person last said done.
    const need = `${i.need}${i.note ? ` ${i.note}` : ''}`;
    lines.push(`${i.r.word} ${i.t.key} ${i.kind}${waited} | ${need} | ${i.actions.map(actionText).join(' | ')}`);
    // A write its park waits for the person to approve: the exact text, verbatim, under the question.
    const a = i.t.state === 'parked' ? i.t.park?.approve : null;
    if (a?.body) lines.push(...approvalLines(i.t.key, a));
  }
  const n = new Set(repos.map((r) => r.slug)).size;
  lines.push(`${c.items.length} item${c.items.length === 1 ? '' : 's'} in ${n} repo${n === 1 ? '' : 's'}.${putOffLine(c)}${movingLine(c)}`);
  return lines.join('\n');
}

// What an item waits on, as a key items with the same cause share, so one answer can settle them all:
// the approval, check or gate holding a PR, the tickets outside the batch holding a ticket, the step
// only the person takes, a usage hold or a subscription that is off. Null where the item is its own,
// as a failing check or a skipped draft is: each PR's is cleared on its own branch.
const PR_CAUSES = { trigger: (w) => [w.base ?? '', ...[...w.names].sort()].join('|'), gate: (w) => one(w.text),
  behind: (w) => w.base ?? '', green: () => '', running: () => '', hold: (w) => one(w.why ?? w.text) };
export function causeOf(i) {
  const at = (...parts) => [i.r.slug, ...parts].join(':');
  if (i.kind === 'usage') return at('usage');
  if (i.kind === 'subscription-off') return at('subscription-off', i.r.q?.subscription_off?.email ?? '');
  if (i.kind === 'parked' && i.personOnly) return at('person-step', one(i.personOnly));
  if (i.outside?.length) return at('outside', [...i.outside].sort().join('|'));
  if (i.kind !== 'pr') return null;
  const w = prWhy(i.r, i.t) ?? {};
  const ask = approvalAsk(i.t, w);
  if (ask && !ask.left.length) return at('approval', ask.cause.why);
  return PR_CAUSES[w.code] ? at(`pr-${w.code}`, PR_CAUSES[w.code](w)) : null;
}

// One item as data: what listText prints for it, with its key, its cause and how many held tickets wait
// behind it. `id` is stable while the item is the same item: its batch, key and kind.
function itemJson(i, now) {
  const ticket = i.ticket ?? (i.repoLevel || i.t.key.includes(':') ? null : i.t.key);
  return { id: `${i.r.word}:${i.t.key}:${i.kind}`, cause: i.cause ?? null, kind: i.kind, repo: i.r.repo, batch: i.r.word, key: i.t.key, ticket,
    ...(({ as_of, age_s }) => ({ since: as_of, waited_s: age_s }))(inputAge(i.since, now)),
    question: i.need, note: i.note || null, behind: i.behind ?? 0, production_broken: !!i.broken, repo_level: !!i.repoLevel,
    actions: i.actions.map(([action, why, note]) => ({ action, recommended: why != null, why: why ?? null, note: note ?? null })) };
}

// The list as data, what `list --json` prints. With `settle` it first settles what has shipped, as list
// does (refresh), and `settled` holds the lines that says; without it, it writes nothing.
export function listItems({ word = null, settle = false, now = Date.now(), repos = null, reads = READS } = {}) {
  const settled = settle ? refresh({ word, now, ...(repos ? { repos } : {}), reads }) : [];
  const c = collect({ word, now, repos: settle || !repos ? loadRepos(now) : repos, reads });
  const batches = [...new Set(c.scope.filter((x) => !x.error && x.q))];
  return { v: 1, generated_at: new Date(now).toISOString(), settled: settle, settled_lines: settled,
    inputs: { queues: batches.map((b) => ({ batch: b.word, ...inputAge(mtimeOf(b.queuePath), now) })) },
    scope: c.named ? c.named.name : null, count: c.items.length, put_off: c.putOff, items: c.items.map((i) => itemJson(i, now)),
    moving: c.moving.map(({ r, key, pr, text }) => ({ batch: r.word, key, pr, text })) };
}

// A queue.mjs command run from the named repo's checkout, so the permissions and GitHub repo it reads
// are that repo's, not those of the repo this session is in: { ok, out }. Exit 11 with nothing on
// stderr is queue.mjs having recorded it and naming what is left for the person, on stdout.
function queueCmd(r, args) {
  let at;
  try { at = checkoutOf(r, 'record it'); } catch (e) { return { ok: false, out: e.message }; }
  const q = queueRun(r, args, at);
  if (q.ok || (q.code === EXIT.SHOW_PERSON && !q.err && q.out.trim())) return { ok: true, out: one(q.out) };
  return { ok: false, out: one(q.why) };
}

// A ticket a pass moved on since it was listed: an answer or resume with text is kept in its briefing
// for its next worker, while it can still spawn one (not merged, and not done without a PR). Anything
// else records nothing. Only the briefing is written, never through answer.mjs: its mailbox would
// answer a running worker's next park before it is asked, and its queue writes would take back a
// grant the requeue was made for.
function movedOn(r, ticket, verb, text, now) {
  const t = r.q?.tickets?.[ticket];
  const spent = !t || !!t.merged_at || prStatusOf(t)?.state === 'MERGED' || (t.state === 'done' && t.result?.pr == null);
  if (spent || !['answer', 'resume'].includes(verb) || !text.trim()) return { ok: false, line: `${r.name} ${ticket}: desk-q does not count it as needing you, so nothing was recorded.` };
  try { saveAnswer(r.stateDir, ticket, text.trim(), new Date(now).toISOString()); }
  catch (e) { return { ok: false, line: `${r.name} ${ticket}: no longer waiting on you, and your answer was not saved: ${one(e.message)}` }; }
  return { ok: true, line: `${r.name} ${ticket}: no longer waiting on you; your answer is saved in its briefing for its next worker.${namedFixturesText(r, ticket, text)}` };
}

// What saveNamedFixtures did with the paths an answer names, as sentences led by a space; '' when it
// names none outside the state folders.
function namedFixturesText(r, ticket, text) {
  let f;
  try { f = saveNamedFixtures({ state: r.stateDir, key: ticket, text }); } catch (e) { return ` Copying the files your answer names failed (${one(e.message)}), so its next worker may not be able to read them.`; }
  const mb = (n) => `${Math.ceil(n / 1048576)} MB`;
  return [
    ...f.copied.map((c) => `Copied ${c.path} into ${f.dir}/ for its next worker: ${c.names.join(', ')}.`),
    ...(f.replaced.length ? [`That replaced the copies already there of ${f.replaced.join(', ')}.`] : []),
    ...(f.over.length ? [`Over the ${mb(MAX_BYTES)} a worktree copy takes, so its worker cannot read: ${f.over.join(', ')}.`] : []),
    ...f.notFound.map((p) => `${p} was not found, so nothing was copied from it.`),
    ...f.tooLarge.map((x) => `${x.path} is too large to copy (${mb(x.bytes)}, over ${mb(NAMED_MAX_BYTES)}), so nothing was copied from it.`),
    ...f.refused.map((x) => `${x.path} was not copied: ${x.why}.`),
  ].map((s) => ` ${s}`).join('');
}

// The actions that answer a park's ask; a not-now puts it off, and a move or drop answers nothing.
const ASK_ANSWERS = ['answer', 'resume', 'approve', 'reject', 'done', 'requeue'];

// Records one answer: { ok, line, message } where `message` is what a live session must be sent.
export function record({ word, ticket, action, text = '', now = Date.now(), repos = loadRepos(now, word), reads = READS }) {
  if (ticket.startsWith(UNSET) || ticket.startsWith(STEP) || ticket.startsWith(FOLLOW) || ticket.startsWith(LINK) || ticket.startsWith(UNPROMOTED) || ticket.startsWith(NOPR) || ticket === PLAN_FIRST || ticket.startsWith(PROMOTION) || ticket.startsWith(BASE_RED) || ticket === TEMPLATES || ticket === ARTIFACTS || ticket === REVIEWER || ticket === STALLED || ticket.startsWith(`${STALLED}:`) || ticket === PAGE || ticket === LEASE_TRIAL || ticket.startsWith(`${SIGNIN}:`) || ticket.startsWith(ASK) || ticket.startsWith(CI_RED) || ticket.startsWith(TICKETLESS) || ticket.startsWith(`${CLOUD_ARCHIVE}:`) || ticket.startsWith(PROPOSAL)) return recordRepoItem({ word, ticket, action, text, now, repos, reads });
  // A ticket is in one batch at most, so the batch named that holds it is the one its answer goes to.
  const { named, scope } = batchesNamed(repos, word);
  const r = scope.find((b) => b.q?.tickets?.[ticket]) ?? named;
  const [verb, id] = action.split(/\s+/);
  // A resume on a PR the queue already has shut says why, not that the verb or the item is unknown.
  const queued = r.q?.tickets?.[ticket], status = prStatusOf(queued);
  const shut = verb === 'resume' && status ? prShut(status.pr, queued.merged_at ? 'MERGED' : status.state) : null;
  if (shut) return { ok: false, line: `${r.name} ${ticket}: ${shut}` };
  const row = !r.q ? null : [...batchRows(r), ...needsRows(r)].find((y) => y.t.key === ticket);
  // A copy queued in another repo too is its duplicate item, which a drop answers whatever its own row
  // offers, and a not-now puts off beside its own row's item.
  const dup = r.q ? duplicateRow(r, ticket) : null;
  const x = !row || verb === 'drop' ? dup ?? row : row;
  // A drop or done the ticket's own row does not take may name a put-off item by the ticket key desk-q shows.
  const offDrop = () => (verb === 'drop' ? dropPutOff(collect({ word, now, repos, reads: null }), ticket, now)
    : verb === 'done' ? donePutOff(collect({ word, now, repos, reads: null }), ticket, { word, now, repos, reads }) : null);
  if (!x) return offDrop() ?? movedOn(r, ticket, verb, text, now);
  const item = itemOf(r, x, null, reads);
  // move is taken on any parked or stopped item, listed or not, so one naming no running batch is
  // refused naming those that are.
  // A put-off ticket row can always be dropped (queue.mjs drop says if it cannot), so one whose premise
  // was decided otherwise leaves Put off.
  const putOffRow = ['drop', 'done'].includes(verb) && !!r.q.tickets?.[x.t.key] && judged(r, x, readRegister(r.stateDir), reads).l.status === 'put_off';
  const allowed = [...item.actions.map(([a]) => a.split(' ')[0]), ...(MOVABLE.includes(item.kind) ? ['move'] : []), ...(putOffRow ? ['drop'] : [])];
  // A put-off ticket row takes no done: done means a step was taken, and drop dismisses the rest.
  if (verb === 'done' && putOffRow) return { ok: false, line: `${r.name} ${ticket}: ${putOffDoneRefusal(item.kind, allowed)}` };
  if (!allowed.includes(verb)) return offDrop() ?? { ok: false, line: `${r.name} ${ticket}: ${verb} is not an action for a ${item.kind} item (${[...new Set(allowed)].join(', ')}).` };
  const w = runner(r);
  const tail = w.by === 'stopped' ? ` Passes are stopped in ${r.name}: nothing acts on it until they resume.` : '';
  let copiedNote = '';
  // An action recorded on a park answers its ask (ask-ledger.mjs), by the person, in this session where
  // one is named: answer.mjs records it too where the action goes through it, and the ledger keeps the first.
  const asked = (ok) => (ok && ASK_ANSWERS.includes(verb) && x.t.state === 'parked' && x.t.park?.since && !isHeld(x.t)
    ? askAnswered(r.queuePath, { key: ticket, since: x.t.park.since, by: 'person', session: process.env.CLAUDE_CODE_SESSION_ID ?? null, at: now }, { on: ledgerOnIn(r.slug), by: 'needs-you' }).map((l) => ` ${l}`).join('')
    : '');
  const say = (ok, line, message = null) => ({ ok, line: `${r.name} ${ticket}: ${line}${ok ? tail : ''}${copiedNote}${asked(ok)}`, message });
  if (['answer', 'resume', 'reject', 'override'].includes(verb) && !text.trim()) return say(false, `${verb} needs the text to record.`);
  // A file the answer names is copied where the ticket's next worker reads it, before any requeue.
  if (['answer', 'resume'].includes(verb)) copiedNote = namedFixturesText(r, ticket, text);
  if (verb === 'move' && !text.trim()) return say(false, 'move needs the batch to move it to.');
  const ans = () => answer({ slug: r.slug, ticket, text, list: digestList(r), now: new Date(now) });
  const putOff = () => addPutOff(putOffEntry({ ...putOffKey(r, x.t, item), ticket, at: new Date(now).toISOString(), actions: verbsOf(item) }), r.stateDir);
  // A fix for the ticket's next worker, then the requeue that spawns it: written first so the spawn
  // reads it, and taken back if the requeue is refused. null once both are made, else what refused.
  // The fix records its class first (failure-class.mjs); the person sent it, so a class that waits
  // does not hold it.
  const sendFix = (fix) => {
    const classed = (({ class: c, class_rule }) => ({ class: c, class_rule }))(fixClass(fix, x.t));
    const f = queueCmd(r, ['set', ticket, `fix=${JSON.stringify({ ...fix, ...classed, at: new Date(now).toISOString() })}`]);
    if (!f.ok) return `its fix was refused: ${f.out}`;
    const q = queueCmd(r, ['requeue', ticket]);
    if (!q.ok) { queueCmd(r, ['set', ticket, 'fix=null']); return `the requeue was refused: ${q.out}`; }
    return null;
  };
  // The person's call on a PR's review gaps: posted on the PR, kept in the briefing and as the fix
  // its next worker starts on, then requeued. Requeued whoever runs the batch: the next pass closes a
  // fix on a ticket still done, so one left for a session to requeue would be lost.
  const gapsAnswer = () => {
    const pr = x.t.result.pr;
    try { execFileSync('gh', ['pr', 'comment', String(pr), '--repo', ghRepoOf(r), '--body', prComment(text)], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return say(false, `not posted on PR #${pr} (${one(e.stderr || e.message)}), so nothing was recorded.`); }
    const a = ans();
    if (!a.ok) return say(false, `posted on PR #${pr}, but not recorded: ${a.why}`);
    const no = sendFix(gapsFix({ pr, head: x.t.pr_status?.head, ready: x.t.pr_status?.isDraft === false, answer: text }));
    if (no) return say(false, `posted on PR #${pr} and in its briefing, but ${no}`);
    return say(true, `posted on PR #${pr}, kept for its next worker and requeued; the next pass sends it to a worker on the PR.`);
  };
  const readPr = (pr, more = '') => ({ ...reads.pr(r, pr, more), repo: ghRepoOf(r) });
  // The person's instruction on an open PR: kept in the briefing and as the fix its next worker starts
  // on, then requeued whoever runs the batch, as a gaps answer is. Read from GitHub first: a worker
  // sent to a PR merged or closed since the last pass has nothing to push to.
  const prResume = () => {
    const pr = x.t.result.pr;
    const { v, err } = readPr(pr);
    if (!v?.state) return say(false, `could not read PR #${pr}'s state from GitHub${err ? ` (${err})` : ''}, so nothing was recorded and it stays on your list.`);
    const gone = prShut(pr, v.state);
    if (gone) return say(false, gone);
    const a = ans();
    if (!a.ok) return say(false, a.why);
    const no = sendFix(instructionFix(x.t, { pr, head: v.headRefOid ?? x.t.pr_status?.head, ready: v.isDraft === false, answer: text }));
    if (no) return say(false, `kept in its briefing, but ${no}`);
    return say(true, `kept for its next worker and requeued; the next pass sends it to a worker on PR #${pr}.`);
  };
  // Done on a PR: read it from GitHub now. Merged is recorded (the next pass records the merge in full,
  // as it does any merge) and leaves the list; anything else is said, and noted on the item.
  const prDone = () => {
    const pr = x.t.result.pr;
    const { v, err, repo } = readPr(pr, ',body');
    if (!v?.state) return say(false, `could not read PR #${pr}'s state from GitHub${err ? ` (${err})` : ''}, so it is not marked done and stays on your list.`);
    if (v.state === 'MERGED') {
      const at = v.mergedAt && !String(v.mergedAt).startsWith('0001-') ? v.mergedAt : new Date(now).toISOString();
      const m = queueCmd(r, ['set', ticket, 'pr_status.state=MERGED', `pr_status.merged_at=${at}`]);
      if (!m.ok) return say(false, `GitHub shows PR #${pr} merged, but recording it was refused: ${m.out}`);
      return say(true, `GitHub shows PR #${pr} merged, so it is off your list.`);
    }
    // A PR held in draft asked only for undrafting: out of draft is that step done.
    if (heldDraft(x.t) && v.state === 'OPEN' && v.isDraft === false) {
      const m = queueCmd(r, ['set', ticket, 'pr_status.isDraft=false']);
      if (!m.ok) return say(false, `GitHub shows PR #${pr} out of draft, but recording it was refused: ${m.out}`);
      return say(true, `GitHub shows PR #${pr} out of draft, so it is released; the next pass takes it on from there.`);
    }
    // A draft's screenshot item asked only for its cells: taking it out of draft is desk's own step.
    const shots = v.state === 'OPEN' && v.isDraft === true && shotsItem(r, x.t);
    const cells = shots ? dragCells(v.body) : 0;
    if (shots && !cells) {
      const rec = { call: 'filled', why: 'no screenshot cell is left in its body', action: null, sha: v.headRefOid ?? null, carried_from: null, pr, at: new Date(now).toISOString() };
      const m = queueCmd(r, ['set', ticket, 'stuck=null', `undraft=${JSON.stringify(rec)}`]);
      if (!m.ok) return say(false, `GitHub shows no screenshot cell left in PR #${pr}'s body, but recording it was refused: ${m.out}`);
      // The pass undrafts it itself only as undraftCall's pr-ready gate allows; otherwise it comes back as the person's undraft.
      const perm = repoPermission(r.slug, 'pr-ready');
      const next = perm === 'yes' || (perm === 'ask' && r.q?.approved?.undraft === true) ? 'the next pass takes it out of draft'
        : `config §3 ${PERMISSION_KEYS['pr-ready']} is "${perm}", so the next pass leaves undrafting #${pr} to you`;
      return say(true, `GitHub shows no screenshot cell left in PR #${pr}'s body, so it is off your list; ${next}.`);
    }
    const check = { at: new Date(now).toISOString(), state: v.state, draft: v.isDraft === true, head: v.headRefOid ?? null, ...(cells ? { cells } : {}) };
    const shows = prShows(v);
    const m = queueCmd(r, ['set', ticket, `done_check=${JSON.stringify(check)}`]);
    if (cells) {
      const still = `GitHub still shows ${cells} screenshot cell(s) in PR #${pr}'s body`;
      return say(false, m.ok ? `${still}, so it stays on your list: ${cellWords(r, x.t, pr, v, repo)}.` : `${still}; noting it on the item was refused: ${m.out}`);
    }
    if (!m.ok) return say(false, `GitHub still shows PR #${pr} ${shows}; noting it on the item was refused: ${m.out}`);
    const moved = check.head && x.t.pr_status?.head && check.head !== x.t.pr_status.head;
    return say(false, `GitHub still shows PR #${pr} ${shows}${moved ? ', though it has new commits the next pass reads' : ''}, so it stays on your list with that note.`);
  };
  // Done on a session item: the person finished the ticket outside desk. Its PR and ticket are read now;
  // a merged PR, or none, is recorded done as list records one that shipped, and anything else is refused.
  // Its PR is the one it recorded, else the one the last pass read (pr_status) unless that is the PR
  // merged before a requeue or one GitHub shows closed unmerged (an earlier round's), else an open PR on
  // GitHub naming its key: "no PR" is never assumed.
  const sessionDone = () => {
    const links = linksPending(x.t);
    if (links) return say(false, `it waits on ${links}, so it is not recorded done and stays on your list: the next pass records it done once each is on Jira.`);
    const status = x.t.pr_status;
    const earlier = x.t.merged_at != null && (status?.state === 'MERGED' || Number(status?.pr) === Number(x.t.result?.pr));
    const own = ownPr(x.t);
    let pr = own ?? (status?.pr != null && !earlier ? Number(status.pr) : null);
    let read = pr == null ? null : readPr(pr);
    if (own == null && read?.v?.state === 'CLOSED') { pr = null; read = null; }
    if (pr == null && reads.open) {
      const found = reads.open(r, ticket);
      if (found.err) return say(false, `could not look on GitHub for an open PR naming ${ticket} (${found.err}), so it is not recorded done and stays on your list.`);
      pr = found.pr;
    }
    const { v, err } = read ?? (pr == null ? { v: null, err: '' } : readPr(pr));
    if (pr != null && !v?.state) return say(false, `could not read PR #${pr}'s state from GitHub${err ? ` (${err})` : ''}, so it is not recorded done and stays on your list.`);
    if (pr != null && v.state !== 'MERGED') return say(false, `GitHub shows PR #${pr} ${prShows(v)}, so it is not recorded done and stays on your list. Say done once it has merged.`);
    const how = `you said done; ${mergedWords(pr, v)}${trackerTicket(r, ticket) ? `; ${ticketWords(ticket, reads.ticket(r, ticket))}` : ''}`;
    const m = recordShipped(r, x.t, how, pr, v);
    return m.ok ? say(true, `recorded done (${how}), so it is off your list.`) : say(false, `recording it done was refused: ${m.out}`);
  };
  // Done on a ticket whose PR merged in another repo: recorded done here with that PR, read as merged
  // (pr_status and merged_at), so no pass reads its number as one of this repo's PRs and the tickets
  // held behind it are released as behind any merge.
  const elsewhereDone = ({ repo, pr, mergedAt }) => {
    const at = mergedAt && !String(mergedAt).startsWith('0001-') ? new Date(mergedAt).toISOString() : new Date(now).toISOString();
    const how = `you said done; PR #${pr} merged in ${repo}${mergedAt ? ` at ${utc(at)}` : ''}`;
    const status = { pr, state: 'MERGED', merged_at: at, url: `https://github.com/${repo}/pull/${pr}` };
    const m = queueCmd(r, [...shippedSet(x.t, how, pr, at), `pr_status=${JSON.stringify(status)}`]);
    if (!m.ok) return say(false, `recording it done was refused: ${m.out}`);
    // Recorded as needs-you's, on that PR: its head and base are the other repo's, so they are left out.
    const g = queueCmd(r, ['merged', ticket, at, '--pr', String(pr), '--by', 'needs-you']);
    if (!g.ok) return say(true, `recorded done (${how}), so it is off your list; its merge time was not recorded (${g.out}), which the next pass records.`);
    return say(true, `recorded done (${how}), so it is off your list and the tickets held behind it can start.`);
  };
  switch (verb) {
    case 'answer': {
      if (item.kind === 'pr') return gapsAnswer();
      const a = ans();
      return a.ok ? say(true, 'answer recorded (digest.mjs answer).') : say(false, a.why);
    }
    case 'resume': {
      // A session item's step done by the person: handed back to a worker at self-review whoever runs
      // the batch, as a fix is, since nothing about it is a session's to decide.
      if (item.kind === 'session') {
        const h = queueCmd(r, ['handback', ticket, text]);
        return h.ok ? say(true, 'handed back to a worker that starts at self-review, with your note in its briefing; the next pass can spawn it.') : say(false, `not handed back: ${h.out}`);
      }
      if (item.kind === 'pr') return prResume();
      // A step only the person or another account takes shows on its PR once taken: read GitHub first,
      // and requeue only once a commit, review or passing check landed since the park.
      const pr = item.personOnly ? ownPr(x.t) : null;
      if (pr != null) {
        const { v, err } = readPr(pr, ',commits,reviews,statusCheckRollup');
        if (!v?.state) return say(false, `could not read PR #${pr} from GitHub${err ? ` (${err})` : ''}, so nothing was recorded or requeued, and it stays on your list.`);
        const gone = prShut(pr, v.state);
        if (gone) return say(false, gone);
        const s = prSincePark(x.t, v);
        if (!s.changed) return say(false, `GitHub shows PR #${pr} unchanged since the park (${s.shows}), so nothing was recorded or requeued: a worker would park again. Resume once the step shows on the PR.`);
      }
      const a = ans();
      if (!a.ok) return say(false, a.why);
      if (item.kind === 'worktree') return say(true, 'recorded for its next worker; the next pass that finds the worktree clean starts it.');
      // Approving a step no worker can run makes it a session item (answer.mjs), never a requeue.
      const step = readQueue(r.queuePath).tickets?.[ticket]?.park?.session_step;
      if (step) return say(true, `answer recorded; not requeued, because no worker can run the step you approved (${one(step.step)}): run it in an interactive session, then say done and it goes back to a worker with the step recorded done.`);
      if (w.by === 'session') {
        // Marked answered, so desk-q shows it waiting on that session rather than needing the person.
        const m = queueCmd(r, ['set', ticket, `park.answered=${new Date(now).toISOString()}`]);
        if (!m.ok) return say(false, `answer recorded, but marking it answered was refused: ${m.out}`);
        return say(true, `answer recorded; not requeued, because a live session runs ${r.name}: message it to requeue ${ticket}.`,
          { to: w.name, text: `${ticket} was answered through desk-needs-you: requeue it (node ~/.claude/desk/bin/queue.mjs requeue ${ticket}).` });
      }
      const q = queueCmd(r, ['requeue', ticket]);
      return q.ok ? say(true, `answer recorded and requeued; the next pass can spawn it.`) : say(false, `answer recorded, but the requeue was refused: ${q.out}`);
    }
    case 'requeue': {
      if (w.by === 'session') {
        const why = item.kind === 'pr' ? `'s PR #${x.t.result.pr} was closed unmerged` : "'s worker stopped";
        return say(true, `not requeued, because a live session runs ${r.name}: message it to requeue ${ticket}.`,
          { to: w.name, text: `${ticket}${why} and the person asked through desk-needs-you to requeue it (node ~/.claude/desk/bin/queue.mjs requeue ${ticket}).` });
      }
      const q = queueCmd(r, ['requeue', ticket]);
      return q.ok ? say(true, 'requeued; the next pass can spawn it.') : say(false, `requeue refused: ${q.out}`);
    }
    case 'start': {
      if (item.lifts) {
        const m = liftOne(r, x.t, item.lifts);
        return m.ok ? say(true, `hold on ${item.lifts} lifted; ${m.words}.`) : say(false, `refused: ${m.out}`);
      }
      for (const s of releaseSteps(ticket)) { const q = queueCmd(r, s); if (!q.ok) return say(false, `refused: ${q.out}`); }
      return say(true, 'hold lifted; the next pass can start it.');
    }
    // queue.mjs's own lines: they name any undraft or merge left for the person to do.
    case 'approve': {
      if (item.kind === 'base-push') {
        const q = queueCmd(r, ['set-batch', 'approved.base_push=true']);
        return q.ok ? say(true, 'base sync approved for the batch (approved.base_push on its queue): the next pass merges the base up to date, and every later sync runs without asking.') : say(false, `approval refused: ${q.out}`);
      }
      const q = queueCmd(r, ['approve', ticket]);
      return q.ok ? say(true, `spine approved: ${q.out}`) : say(false, q.out);
    }
    case 'reject': {
      const q = queueCmd(r, ['reject', ticket, text]);
      return q.ok ? say(true, 'spine sent back with your note.') : say(false, q.out);
    }
    case 'override': {
      if (!id) return say(false, 'override needs the decision id.');
      const o = override({ slug: r.slug, id, choice: text, list: digestList(r), now: new Date(now) });
      return o.ok ? say(true, `decision ${id} overridden to "${text}" (digest.mjs override).`) : say(false, o.why);
    }
    case 'not-now': {
      // A park is put off by answer.mjs, keyed to its inputs, and its entry then records the actions it
      // offers; anything else here, as putOffKey keys it.
      if (dup && x !== dup) addPutOff(putOffEntry({ ...putOffKey(r, dup.t, dup.dup), ticket, at: new Date(now).toISOString(), actions: verbsOf(dup.dup) }), r.stateDir);
      const still = stillListed(r, ticket);
      if (PARK_KINDS.includes(item.kind)) {
        const a = answer({ slug: r.slug, ticket, text: 'not now', list: digestList(r), now: new Date(now) });
        if (!a.ok) return say(false, a.why);
        stampItem(r, x, item);
        return say(true, `put off (not-now register).${still}`);
      }
      putOff();
      return say(true, `put off (${notNowPath(r.stateDir)}).${still}`);
    }
    case 'waiting': {
      putOff();
      return say(true, `waiting on its approval (${notNowPath(r.stateDir)}): not listed again until it gets one or its head moves.${stillListed(r, ticket)}`);
    }
    // Into another running batch of the repo, by its name, `<repo>:<name>`, or `standing`. Made here
    // whoever runs either batch: the move holds both queue locks, and the next pass there spawns it.
    case 'move': {
      const said = one(text);
      const to = said.startsWith(`${r.repo}:`) ? said.slice(r.repo.length + 1) : said;
      const ts = moveTargets(r);
      const dest = ts.find((b) => b.word === to || (!b.name && to === r.repo));
      if (!dest) return say(false, `${to} is not a batch running in ${r.repo} beside this one, so nothing was moved. ${ts.length ? `The batches running are ${targetsText(ts)}.` : 'No other batch is running there.'}`);
      const q = queueCmd(r, ['transfer', ticket, dest.word]);
      return q.ok ? say(true, `${q.out} (queue.mjs transfer); the next pass there can spawn it.`) : say(false, `move refused: ${q.out}`);
    }
    // One more review fix try, as the pass sends one. Requeued whoever runs the batch, as a gaps answer is.
    case 'fix': {
      const pr = x.t.result.pr;
      const fix = personReviewFix(x.t, { pr, head: x.t.pr_status?.head, why: stuckOf(x.t, r.ctx)?.why });
      if (!fix) return say(false, `PR #${pr}'s stuck reason quotes no review finding, so nothing was sent.`);
      const no = sendFix(fix);
      if (no) return say(false, no);
      return say(true, `sent back to a worker on PR #${pr} for one more try at its findings; the review of its new head says whether they are gone.`);
    }
    // Nothing spawns from a drop, so it is made here whoever runs the batch.
    case 'drop': { const q = queueCmd(r, ['drop', ticket]); return q.ok ? say(true, `${q.out} (queue.mjs drop); Jira is left as it is.`) : say(false, `drop refused: ${q.out}`); }
    case 'open': {
      const root = repoConfigValue(r.slug, 'repo-root');
      return say(true, `not requeued (${x.t.park?.session_step ? 'a step you approved that no worker can run' : neverStep(parkText(r, x.t)) ? 'a step no worker is allowed' : 'it needs a plan or design agreed with you first'}). Open an interactive session${root ? ` in ${root}` : ` in ${r.name}`} and run /desk-ticket ${ticket}.`);
    }
    // Admission runs its own checks on each blocker, so it is the person's /desk-admit, not made here.
    case 'admit': {
      const free = outsideHolds(r, x.t).filter((o) => !o.batch).map((o) => o.key);
      const root = repoConfigValue(r.slug, 'repo-root');
      return say(true, `nothing recorded. Run /desk-admit ${free.join(' ')} in ${root ?? r.name}; ${ticket} stays held until ${free.length === 1 ? 'it is' : 'they are'} Done, or you answer that it can start without ${free.length === 1 ? 'it' : 'them'}.`);
    }
    case 'done': {
      // Done on a batch-wide hold put off with not-now (no ticket of the queue: a put-off ticket row
      // was refused done above) is answered as the listed hold's is, and then it is dismissed as a
      // drop dismisses one, so it leaves Put off.
      const j = judged(r, x, readRegister(r.stateDir)), key = putOffKey(r, x.t, j.item);
      const out = rowDone();
      if (!out.ok || j.l.status !== 'put_off') return out;
      return { ...out, line: `${out.line} It leaves Put off (${dismissPutOff({ r, t: x.t, putOffKey: key, putOffDir: r.stateDir }, now)}).` };
    }
    default: return say(false, `unknown action ${verb}.`);
  }
  // Done on the row as it is listed: { ok, line, message }.
  function rowDone() {
    if (item.elsewhere) return elsewhereDone(item.elsewhere);
    if (x.t.park?.session_step) {
      const d = queueCmd(r, ['step-done', ticket]);
      return d.ok ? say(true, 'the step is recorded done and the ticket requeued, with it in its briefing; the next pass can spawn it.') : say(false, `not sent back: ${d.out}`);
    }
    if (x.pr || heldDraft(x.t)) return prDone();
    if (item.kind === 'session') return sessionDone();
    if (item.kind === 'usage') return say(true, 'noted: the batch carries on by itself once the usage limit lifts.');
    if (item.kind === 'base-sync') return say(true, 'noted: the next pass reads the base again, and spawns once it is current.');
    if (item.kind === 'subscription-off') return say(true, 'noted: the next pass reads the repo\'s subscription again, and starts its work once that is not off.');
    if (item.kind === 'worktree') return say(true, 'noted: the next pass that finds the worktree clean drops the record and starts it.');
    return say(true, 'noted: the next pass reads it again and moves it on once your step shows.');
  }
}

// The put-off items in collect's `off` that `ticket` names: by their own key, else by the ticket key
// desk-q shows for them (itemKey). An answer is refused naming each own key where more than one shows so.
function putOffHits(c, ticket) {
  const own = c.off.filter((y) => y.t.key === ticket);
  return own.length ? own : c.off.filter((y) => itemKey(y.t, y) === ticket);
}
const manyPutOff = (c, ticket, hits, what, how) => ({ ok: false, line: `${c.named?.name ?? hits[0].r.repo} ${ticket}: ${hits.length} put-off items show as ${ticket}, so nothing was ${what}. ${how} one by its own key: ${hits.map((y) => y.t.key).join(', ')}.`, message: null });
// Why done is refused on a put-off item with no done action (a duplicate, a finished ticket with no
// PR, plan-first, unpromoted, a proposal, a base-sync approve, a ticket row): the actions it takes,
// and that drop closes it.
function putOffDoneRefusal(kind, verbs) {
  const take = [...new Set(verbs)].filter((v) => !['done', 'not-now', 'drop'].includes(v));
  return `done is not an action for a put-off ${kind} item, so nothing was recorded. ${take.length ? `It takes ${andList(take)}, and drop closes it` : 'Drop closes it'}.`;
}
// Records put-off item `off` dismissed in its register: it leaves Put off until what it keys to changes. -> the register's path
function dismissPutOff(off, now) {
  const dir = off.putOffDir ?? off.r.stateDir;
  addPutOff({ ...putOffEntry({ question: off.putOffKey.question, ticket: off.t.key, inputs: off.putOffKey.inputs, at: new Date(now).toISOString() }), dismissed: true }, dir);
  return notNowPath(dir);
}
// A put-off item that is no ticket row has no batch to drop it from, so a drop records it dismissed:
// it leaves Put off and is not listed again until what it keys to changes. null where none is put
// off under the key.
function dropPutOff(c, ticket, now) {
  const hits = putOffHits(c, ticket);
  if (!hits.length) return null;
  if (hits.length > 1) return manyPutOff(c, ticket, hits, 'dropped', 'Drop');
  const [off] = hits;
  return { ok: true, line: `${off.r.repo} ${off.t.key}: dropped (${dismissPutOff(off, now)}), so it leaves Put off and is not listed again until it changes.`, message: null };
}
// Done on a put-off item named by the ticket key desk-q shows for it: answered by its own key, as
// recordRepoItem answers it. null where none is put off under the key.
function donePutOff(c, ticket, { word, now, repos, reads }) {
  const hits = putOffHits(c, ticket);
  if (!hits.length) return null;
  if (hits.length > 1) return manyPutOff(c, ticket, hits, 'recorded', 'Say done on');
  return recordRepoItem({ word, ticket: hits[0].t.key, action: 'done', now, repos, reads });
}

// A repo-level or step item's answer. Done on an unset row requeues every ticket parked on it once the
// row is set, each in its own batch (or names the live session to message); done on behind templates
// checks the copies again now; done on a step records nothing, since the pass reads the step from Jira.
function recordRepoItem({ word, ticket, action, text = '', now, repos, reads = READS }) {
  const c = collect({ word, now, repos, reads: null, ciRed: ticket.startsWith(CI_RED) ? (reads ?? READS).ciRed : null });
  let i = c.items.find((y) => (y.repoLevel || y.proposal || y.kind === 'step' || y.kind === 'follow' || y.blocker || y.unpromoted || y.finished || y.planFirst || y.promotion != null) && y.t.key === ticket)
    ?? c.checking.find((y) => y.t.key === ticket);
  // A row set since the list was shown no longer groups its parks there; done still finds them. One
  // put off is dropped as it stands, before that.
  if (!i && ticket.startsWith(UNSET) && c.named && !(action.split(/\s+/)[0] === 'drop' && c.off.some((y) => y.t.key === ticket))) {
    const key = ticket.slice(UNSET.length);
    const parked = repos.filter((b) => b.slug === c.named.slug && !b.error && b.q)
      .flatMap((b) => needsRows(b).filter((x) => x.t.state === 'parked' && namesRow(String(x.t.park?.question ?? ''), key)).map((x) => ({ r: b, t: x.t })));
    if (parked.length) {
      const g = { r: standingOf(repos, c.named), key, parked };
      i = { r: g.r, t: { key: ticket }, ...unsetItem(g) };
      i.putOffKey = putOffKey(i.r, i.t, i);
    }
  }
  const [verb] = action.split(/\s+/);
  const dropped = !i && verb === 'drop' ? dropPutOff(c, ticket, now) : null;
  if (dropped) return dropped;
  // Done on a put-off item is answered as the listed item's done is, and then it leaves Put off: a
  // done that records nothing (a noted item) would otherwise leave it there.
  const off = !i && verb === 'done' ? c.off.find((y) => y.t.key === ticket) : null;
  if (off) {
    if (!off.actions.some(([a]) => a === 'done')) return { ok: false, line: `${off.r.repo} ${ticket}: ${putOffDoneRefusal(off.kind, off.actions.map(([a]) => a.split(' ')[0]))}` };
    const out = answerRepoItem(off, { ticket, verb, text, now, reads });
    return out.ok ? { ...out, line: `${out.line} It leaves Put off (${dismissPutOff(off, now)}).` } : out;
  }
  if (!i) return { ok: false, line: `${c.named?.name ?? word} ${ticket}: desk-q does not count it as needing you, so nothing was recorded.` };
  return answerRepoItem(i, { ticket, verb, text, now, reads });
}

// Answers repo-level or step item `i` with `verb`, as recordRepoItem found it: { ok, line, message }.
function answerRepoItem(i, { ticket, verb, text, now, reads }) {
  const say = (ok, line, message = null) => ({ ok, line: `${i.r.repo} ${ticket}: ${line}`, message });
  if (!i.actions.some(([a]) => a === verb)) return say(false, `${verb} is not an action for a ${i.kind} item (${i.actions.map(([a]) => a).join(', ')}).`);
  if (verb === 'not-now') {
    addPutOff(putOffEntry({ ...i.putOffKey, ticket, at: new Date(now).toISOString(), ...(i.kind === 'step' ? { actions: verbsOf(i) } : {}) }), i.putOffDir ?? i.r.stateDir);
    return say(true, `put off (${notNowPath(i.putOffDir ?? i.r.stateDir)}).${i.planFirst ? stillWords(i.behind ?? 0) : ''}`);
  }
  // Done on a follow item records the steps it lists as settled (run, or closed on the PR's own evidence), each by its text and gate, under the queue
  // lock, so the ticket's other steps (another gate's, or one written since this read) are kept.
  if (i.kind === 'follow') {
    const m = queueCmd(i.r, ['follow-ran', i.ticket, JSON.stringify(i.steps), new Date(now).toISOString()]);
    if (!m.ok) return say(false, `recording it was refused: ${m.out}`);
    // A session's claim on it ends with it.
    try { clearClaim(i.t.key, i.r.stateDir, new Date(now).toISOString()); } catch { /* an unreadable register holds no claim to clear */ }
    return say(true, 'recorded done, so it is off your list.');
  }
  if (i.proposal) return proposalAnswer(i, verb, text, reads ?? READS, now, say);
  if (i.unpromoted) return verb === 'promote' ? promoteBase(i, say) : startWithout(i, say);
  if (i.finished) return startNoPr(i, say);
  if (i.planFirst) return say(true, `nothing recorded. Open the batch's session, or an interactive one in ${rootOf(i.r)}, and run /desk-ticket ${i.ticket}: it claims ${i.ticket}${i.planFirst.length > 1 ? `, and ${andList(i.planFirst.slice(1))} wait for a session to take ${i.planFirst.length === 2 ? 'it' : 'them'} on` : ''}.`);
  if (i.promotion != null) return say(true, `noted: the next pass reads promotion PR #${i.promotion}'s checks again, and this item goes once they pass.`);
  if (i.blocker) return say(true, `noted: the next pass that reads ${i.ticket}'s blockers clears this once ${i.blocker} is no longer linked, and lifts any hold on it.`);
  if (i.kind === REVIEWER) return say(true, 'noted: the next pass checks the account again, and lifts the hold on every PR it names once the check passes.');
  if (i.kind === 'ask' && i.choice && verb !== 'done') {
    let a;
    try { a = answerAsk(i.r.stateDir, i.id, { chose: verb, by: 'person', at: now }); } catch (e) { return say(false, `the choice could not be recorded (${one(e.message)}).`); }
    return a ? say(true, `${verb}, recorded as your choice; the session that asked reads it (needs-you.mjs ask-status), and it is off your list.`) : say(false, 'it is no longer open: it was answered or applied already.');
  }
  if (i.kind === 'ask') {
    try { removeAsk(i.r.stateDir, i.id); } catch (e) { return say(false, `it could not be taken off the list (${one(e.message)}).`); }
    return say(true, 'done, so it is off your list.');
  }
  if (i.kind === STALLED) return say(true, 'noted: this item goes once a pass runs again; done records nothing.');
  if (i.kind === 'base-red') return say(true, 'noted: the next pass reads the base again; each hold clears once its check passes there, and this item goes with the last; done records nothing.');
  if (i.kind === 'ci-red') return say(true, 'noted: this item goes once the alarm closes the issue, when every CI lane on main is green and fresh; done records nothing.');
  if (i.kind === CLOUD_ARCHIVE) {
    try { recordArchived(i.r.stateDir, i.sessions); } catch (e) { return say(false, `recording it was refused (${one(e.message)}), so it stays on your list.`); }
    return say(true, `recorded ${i.sessions.length === 1 ? 'the session' : `all ${i.sessions.length} sessions`} archived, so it is off your list.`);
  }
  if (i.kind === 'ticketless') return say(true, `noted: the next pass that finds PR #${i.pr} merged or closed drops this item; done records nothing.`);
  if (i.kind === SIGNIN) return say(true, 'noted: the next pass checks the login again; once it passes this item goes and the upload queue resumes.');
  if (i.kind === LEASE_TRIAL) return leaseTrialAnswer(verb, now, say);
  if (i.kind === PAGE) return say(true, 'noted: once desk is installed again, the next upload checks the page; once it finds the composer this item goes and the upload queue resumes.');
  if (i.kind === 'step') return say(true, `noted: the next pass that reads ${i.step} from Jira lifts the hold on what waits for it once it is Done${i.r.ctx?.merges ? ', and desk then merges them' : ''}.`);
  if (i.kind === ARTIFACTS) return artifactsDone(i, say);
  if (i.kind === TEMPLATES) {
    let rec;
    try { rec = templatesCheck({ slug: i.r.slug, force: true, now }).record; } catch (e) { return say(false, `could not check the copies again (${one(e.message)}), so it stays on your list.`); }
    const still = rec.files.filter((f) => f.status === 'BEHIND').map((f) => f.path);
    return still.length
      ? say(false, `${andList(still)} ${still.length === 1 ? 'is' : 'are'} still behind on ${rec.ref}, so it stays on your list. Merge the PR /desk-update opened first.`)
      : say(true, `no copy is behind on ${rec.ref} now, so it is off your list.`);
  }
  const key = ticket.slice(UNSET.length);
  if (repoPermissionUnset(i.r.slug, key)) return say(false, `§3 ${key} is still not set in ${i.r.repo}'s config, so nothing was requeued. Answer it with /desk-update in ${rootOf(i.r)} first.`);
  const { refused, parts, first } = requeueParked(i.parked);
  return say(!refused.length, `§3 ${key} is set now: ${parts.join('; ')}.`,
    first ? { to: first[0], text: `${andList(first[1])} parked on §3 ${key}, which is now set: requeue ${themOf(first[1])} (node ~/.claude/desk/bin/queue.mjs requeue <TICKET>).` } : null);
}

// What is left: desk-q's NEEDS YOU count in scope (needsCount's rule), then a line for each unfinished batch there whose passes are
// stopped, needing the person or not: one just answered no longer does, and still waits on a pass.
export function leftText({ word = null, now = Date.now(), repos = loadRepos(now, word) } = {}) {
  const c = scopeOf(repos, word);
  const where = c.named ? ` in ${c.named.name}` : '';
  const counts = c.scope.filter((x) => !x.error && (x.q || x.asks?.length)).map(needsCount);
  const n = counts.reduce((a, y) => a + y.shown, 0);
  const lines = [`desk-q counts ${n} item${n === 1 ? '' : 's'} needing you${where}.${putOffLine({ putOff: counts.reduce((a, y) => a + y.putOff, 0) })}`];
  for (const r of (c.named ? c.scope : repos).filter((x) => !x.error && x.q && !x.live && (x.rows.length || x.prs.length))) {
    lines.push(`Passes are stopped in ${r.name}, so nothing acts on its answers yet. To resume: ${resumeOf(r)}.`);
  }
  return lines.join('\n');
}

// Records an action a session hands the person on the repo `word` names: { ok, line }.
// `until`: the tickets it waits on (--until), so a pass drops it once they are all merged or done.
export function ask({ word, text, until = [], options = [], recommend = null, applyBy = null, neverDefault: never = null, now = Date.now(), repos = loadRepos(now, word) }) {
  const what = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!what) return { ok: false, line: 'say what the person is to do: needs-you.mjs ask <repo> "<what to do>" [--until <TICKET>[,<TICKET>...]]' };
  if (until.some((k) => !SAFE_ID.test(k))) return { ok: false, line: `--until wants ticket keys, comma-separated, not "${until.join(',')}"` };
  const r = standingOf(repos, batchesNamed(repos, word).named);
  let choice = null;
  if (options.length || recommend || applyBy || never) {
    if (options.length < 2 || options.some((o) => !OPTION.test(o)) || new Set(options).size < options.length) return { ok: false, line: `--options wants two or more different one-word options, |-separated, not "${options.join('|')}"` };
    if (options.some((o) => ['done', 'not-now'].includes(o))) return { ok: false, line: '--options cannot be done or not-now: those are every ask\'s own' };
    if (recommend != null && !options.includes(recommend)) return { ok: false, line: `--recommend wants one of the options (${options.join(', ')}), not "${recommend}"` };
    const by = applyBy == null ? null : applyByOf(applyBy, new Date(now));
    if (applyBy != null && !by) return { ok: false, line: `--apply-by wants a local HH:MM or an ISO time, not "${applyBy}"` };
    const nd = recommend ? neverDefault(what, recommend, never) : null;
    let times = null;
    try { times = [].concat(repoConfigValues(r.slug, 'checkin-times') ?? []).join(' ') || null; } catch { /* unread: the default times */ }
    const c = checkinTimes(times);
    const at = !recommend || nd ? null : by ?? nextCheckin(c.ok ? c.times : DEFAULT_TIMES, new Date(now));
    choice = { options, recommended: recommend, apply_by: at ? at.toISOString() : null, never_default: nd };
  }
  const { id, added, until: kept, ask: a } = addAsk(r.stateDir, what, now, { until, choice });
  const when = choice ? deadlineText(a, new Date(now)) : null;
  return { ok: true, line: `${r.repo} ${ASK}${id}: ${added ? 'recorded' : 'already recorded'}; /desk-needs-you and desk-q list it until you ${choice ? `choose (${options.join(', ')})` : 'say done'}${kept.length ? `, or a pass finds ${kept.join(', ')} merged or done` : ''}${when ? `; it ${when}` : ''}.` };
}

// A session takes a follow item on (claim <item> --by <session>): desk-q shows it as checking (<session>)
// and leaves it out of the person's count until done, or until the session is idle past §3b "Release
// idle claims after (hours)" (liveClaim). `item` is its key (follow:<KEY>…) or the ticket it is about,
// where that names one item.   -> { ok, line }
export function claim({ word = null, item, session, now = Date.now(), repos = loadRepos(now, word) }) {
  if (!SESSION_ID.test(String(session ?? ''))) return { ok: false, line: `--by wants a session id (letters, digits, - and _), not "${session ?? ''}"` };
  const c = collect({ word, now, repos, reads: null, ciRed: null });
  const follows = [...c.items, ...c.checking].filter((y) => y.kind === 'follow');
  const exact = follows.filter((y) => y.t.key === item || y.t.key === `${FOLLOW}${item}`);
  const hits = exact.length ? exact : follows.filter((y) => y.ticket === item);
  const where = c.named ? ` in ${c.named.name}` : '';
  if (!hits.length) return { ok: false, line: `no check after merge${where} is listed as ${item}, so nothing was claimed: claim takes a follow item's key (needs-you.mjs list shows them).` };
  if (hits.length > 1) return { ok: false, line: `${item} names ${hits.length} checks after merge${where} (${hits.map((y) => `${y.t.key}${c.named ? '' : ` in ${y.r.name}`}`).join(', ')}): claim one by its key.` };
  const [i] = hits;
  if (!transcriptOf(session)) return { ok: false, line: `no transcript for session ${session} on this computer, so nothing was claimed: --by wants the id of a session here.` };
  addClaim({ item: i.t.key, session, ticket: i.ticket, at: new Date(now).toISOString() }, i.r.stateDir);
  let raw = null;
  try { raw = repoConfigValue(i.r.slug, 'claim-release'); } catch { /* unset */ }
  const { hours = DEFAULT_CLAIM_HOURS } = claimHours(raw);
  const until = hours > 0 ? `, or session ${session} has been idle past §3b Release idle claims after (${hours} hours)` : '';
  return { ok: true, line: `${i.r.repo} ${i.t.key}: claimed by session ${session}. desk-q shows it as checking (${session}) and leaves it out of your count until it is done${until}.` };
}

// ask's flags after the repo and text: { until, options, recommend, applyBy, neverDefault }, or null where
// one is unknown or has no value.
function askFlags(args) {
  const f = { until: [], options: [], recommend: null, applyBy: null, neverDefault: null };
  for (let i = 0; i < args.length; i += 2) {
    const [k, v] = [args[i], args[i + 1]];
    if (v == null) return null;
    if (k === '--until') f.until = v.split(',').map((x) => x.trim()).filter(Boolean);
    else if (k === '--options') f.options = v.split('|').map((x) => x.trim()).filter(Boolean);
    else if (k === '--recommend') f.recommend = v.trim();
    else if (k === '--apply-by') f.applyBy = v.trim();
    else if (k === '--never-default') f.neverDefault = v;
    else return null;
  }
  return f;
}

// Whether ask `id` of the repo is open, or which option was chosen, by whom, and when.
export function askStatus({ word, id, now = Date.now(), repos = loadRepos(now, word) }) {
  const r = standingOf(repos, batchesNamed(repos, word).named);
  const open = readAsks(r.stateDir).find((a) => a.id === id);
  if (open) return { ok: true, line: `${r.repo} ${ASK}${id}: open${open.recommended ? `; it ${deadlineText(open, new Date(now)) ?? 'waits for the person'}` : ''}` };
  const a = answerOf(r.stateDir, id);
  if (!a) return { ok: true, line: `${r.repo} ${ASK}${id}: not open, and no choice is recorded (done, or never asked)` };
  // A default the person overrode from the check-in digest (digest.mjs override) stands as their choice.
  const o = a.by === 'default' ? readDecisions(r.stateDir).overrides.filter((x) => x.ticket === `${ASK}${id}`).at(-1) : null;
  if (o) return { ok: true, line: `${r.repo} ${ASK}${id}: ${o.chose}, chosen by the person at ${o.at}, overriding ${a.chose}, which desk applied by default at ${a.answered_at}` };
  return { ok: true, line: `${r.repo} ${ASK}${id}: ${a.chose}, chosen ${a.by === 'default' ? 'by default, nobody having chosen,' : 'by the person'} at ${a.answered_at}` };
}

// One run of the command line, in this process: { code, out, err }, which the entry below prints and exits
// with. `reads` is what list's refresh and collect, and record, read through (READS where none is given).
export function run(argv, { reads } = {}) {
  const [cmd, ...rest] = argv;
  const lines = [];
  const end = (code, err = '') => ({ code, out: lines.map((l) => `${l}\n`).join(''), err });
  const at = reads === undefined ? {} : { reads };
  try {
    const words = rest.filter((a) => !['--json', '--no-settle'].includes(a));
    if (cmd === 'list' && words.length <= 1 && !words.some((a) => a.startsWith('--'))) {
      const word = words[0] ?? null, settle = !rest.includes('--no-settle');
      if (rest.includes('--json')) lines.push(JSON.stringify(listItems({ word, settle, ...at }), null, 2));
      else lines.push([...(settle ? refresh({ word, ...at }) : []), listText(collect({ word, ...at }))].join('\n'));
    }
    else if (cmd === 'left' && rest.length <= 1) lines.push(leftText({ word: rest[0] ?? null }));
    else if (cmd === 'record' && rest.length >= 3) {
      const [word, ticket, verb, ...more] = rest;
      // An override names its decision id before the choice.
      const [action, text] = verb === 'override' ? [`override ${more[0] ?? ''}`, more.slice(1).join(' ')] : [verb, more.join(' ')];
      const res = record({ word, ticket, action, text, ...at });
      lines.push(res.line);
      if (res.message) lines.push(`MESSAGE ${res.message.to ?? '(no batch name recorded)'}: ${res.message.text}`);
      if (!res.ok) return end(EXIT.SHOW_PERSON);
    } else if (cmd === 'move' && rest.length === 3) {
      const [word, ticket, to] = rest;
      const res = record({ word, ticket, action: 'move', text: to, ...at });
      lines.push(res.line);
      if (!res.ok) return end(EXIT.SHOW_PERSON);
    } else if (cmd === 'ask' && rest.length >= 2 && askFlags(rest.slice(2))) {
      const f = askFlags(rest.slice(2));
      const res = ask({ word: rest[0], text: rest[1], ...f });
      lines.push(res.line);
      if (!res.ok) return end(EXIT.SHOW_PERSON);
    } else if (cmd === 'ask-status' && rest.length === 2 && /^(ask:)?\d+$/.test(rest[1])) {
      lines.push(askStatus({ word: rest[0], id: Number(rest[1].replace(/^ask:/, '')) }).line);
    } else if (cmd === 'claim' && rest.indexOf('--by') >= 1 && rest.indexOf('--by') <= 2 && rest.length === rest.indexOf('--by') + 2) {
      const by = rest.indexOf('--by');
      const [word, item] = by === 2 ? rest : [null, rest[0]];
      const res = claim({ word, item, session: rest[by + 1] });
      lines.push(res.line);
      if (!res.ok) return end(EXIT.SHOW_PERSON);
    } else return end(EXIT.SHOW_PERSON, 'usage: needs-you.mjs list [--json] [--no-settle] [<repo>] | record <repo> <TICKET> <action> ["<text>"] | move <repo> <TICKET> <batch> | left [<repo>] | ask <repo> "<what to do>" [--until <TICKET>[,<TICKET>...]] [--options <a>|<b> [--recommend <a>] [--apply-by <HH:MM|ISO>] [--never-default "<why>"]] | ask-status <repo> <id> | claim [<repo>] <item> --by <session>\n');
  } catch (e) { return end(EXIT.SHOW_PERSON, `${e.message}\n`); }
  return end(0);
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const { code, out, err } = run(process.argv.slice(2));
  // Through console, which drops a write to a closed pipe rather than throwing EPIPE and exiting 1.
  if (out) console.log(out.replace(/\n$/, ''));
  if (err) console.error(err.replace(/\n$/, ''));
  process.exitCode = code;
}
