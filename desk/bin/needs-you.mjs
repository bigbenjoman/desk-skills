#!/usr/bin/env node
// What desk-q counts as needing the person, across every repo on this computer, one line per item,
// and the one command that records each answer. The desk-needs-you skill reads `list`, asks, and
// records through `record`; it reads no queue, log, briefing or digest page itself.
//
//   needs-you.mjs list [<repo>]                       one line per batch with items, then one per item
//       <repo> is a repo's name (all its batches) or <repo>:<name> (one named batch), as each item
//       line starts
//   needs-you.mjs record <repo> <TICKET> <action> ["<text>"]
//       resume "<answer>"   answer it (digest.mjs answer), then requeue it, or mark it answered and
//                           name the session to ask. On a lane C or D session item whose step the
//                           person has done, "<what was done>": handed back to a worker that starts at
//                           self-review, with it in its briefing (queue.mjs handback). On a PR open on
//                           GitHub, "<instruction>": kept for its next worker and requeued for a worker
//                           on the PR, whoever runs the batch; a merged or closed PR is refused, saying so
//       answer "<answer>"  answer it only (digest.mjs answer): triage questions, and an epic's drafted
//                           plan (start, discard, or an edit), recorded on the epic for the supervisor to
//                           act on (epic-plan.mjs actOnPlan). On a draft PR whose
//                           review left gaps, the call on them: posted on the PR, kept for its next
//                           worker, and requeued for a worker on the PR
//       start               let a held ticket start where nothing else will (desk-q's "let it start" command)
//       requeue             send a ticket whose worker stopped, or whose PR was closed unmerged, back to
//                           a worker (queue.mjs requeue)
//       fix                 send a PR whose review findings outlasted desk's fix tries back to a worker
//                           on the PR, for one more try at the findings its stuck reason quotes
//       drop                take a ticket whose PR was closed unmerged out of the batch (queue.mjs drop)
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
//                           api, …): names the desk-ticket session to open; records nothing
//       admit               a ticket held by open tickets outside its batch that no batch holds: names
//                           the /desk-admit to run for them; records nothing
//       done                the person did the step themselves. On a PR it reads the PR from GitHub:
//                           merged is recorded and leaves the list; unmerged is said, and noted on the
//                           item until its head moves
//   needs-you.mjs move <repo> <TICKET> <batch>        record's move alone: the one action the decider is
//                                                     allowed, so its allow rule names no other
//   needs-you.mjs left [<repo>]                       how many items desk-q still counts, and where passes stopped
//
// Two items are the repo's rather than a ticket's, and are named in place of one: `unset:<key>`, every
// ticket parked naming a §3 row the repo's config does not set (done requeues them once it is set), and
// `templates`, the repo's committed copies of desk's templates the supervisor found behind (done
// checks them again). `step:<KEY>` is the repo's too: a step only the person takes, which every ticket
// it names, in any of the repo's batches, waits on to merge (done records nothing; the pass reads the step from Jira).
// Items are what desk-q's home screen counts as "◆ needs you", in order: a PRODUCTION BROKEN park
// first, then the longest waiting, less any put off with not-now whose inputs are unchanged and, where
// its entry recorded the actions it offered, that offers none it did not offer then. Exits 0, or 11
// (show the person) on anything it refuses.
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dragCells, evidenceRecord, missingShots, parseEvidenceRow, ticketShots } from './evidence.mjs';
import { cellPlan } from './undraft.mjs';
import { conflictTriesMade, gapsFix, lastTrySaid, instructionFix, personReviewFix, stuckFindings } from './fix-tries.mjs';
import { repoConfigValue, releaseCommand, repoPermission, repoPermissionUnset, isNone, PERMISSION_KEYS } from './desk-env.mjs';
import { readRecord as templatesRecord, check as templatesCheck } from './repo-templates.mjs';
import { readQueue, isHeld, spinePark, planPark, openQuestion, sessionPark, neverStep, moveTarget, targetsText, moveOffer, prStatusOf, EXIT } from './batch-state.mjs';
import { loadRepos, shownRepos, holdOf, heldDraft, heldAsks, resolveRepo, resumeOf, needsSession, queueRun, checkoutOf, timeOf, needsRows, needText, prWhy, andList, capital, keysOf, triageOf, laneOf, usageHoldOf, stuckOf, behindPrs, worktreeBusy,worktreeBusyText, busyPark, outsideOf, JIRA_CATEGORY } from './desk-q.mjs';
import { answer, override, readDecisions, openQuestions, PRODUCTION_BROKEN } from './digest.mjs';
import { addPutOff, putOffEntry, notNowPath, readRegister, lookup, changedLine, questionKey } from './not-now.mjs';
import { batchHolding, listBatches, otherRunningBatches, finishedOnRecord } from './batches.mjs';

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
const SESSION_WHY = 'lane C/D: a worker would only park on it';
// Why a session park is one: a step no worker is ever allowed, or its lane.
const sessionWhy = (q) => { const s = neverStep(q); return s ? `a worker is never allowed ${s}, so a requeue would only park it again` : SESSION_WHY; };
// Once the person has done a lane C or D park's step, resume hands it back to a worker that starts at
// self-review (queue.mjs handback). Offered only where that worker has somewhere to start, the
// worktree and branch the queue records, and never on a step no worker is allowed: a worker parked
// mid-build there, and self-review would skip the rest of its build.
const handBack = (r, t) => (t.worktree && t.branch && !neverStep(parkText(r, t))
  ? [['resume', null, 'once its step is done, resume "<what you did>" hands it back to a worker that starts at self-review']] : []);
const digestList = (r) => [{ slug: r.slug, batch: r.batch ?? null, state: r.stateDir, queue: r.queuePath }];
// A draft the pass left for the person because the review verdict at its head has gaps (undraft.mjs
// verdictAt's `not clean (… gaps=N …)`), whatever its call: one whose fix tries ran out keeps `findings`.
const reviewGaps = (t) => t.pr_status?.isDraft === true && /not clean \([^)]*\bgaps=[1-9]/.test(String(t.undraft?.why ?? ''));
const prComment = (text) => `The person's call on this PR's review gaps, recorded through desk-needs-you:\n\n${text.split('\n').map((l) => `> ${l}`).join('\n')}\n\nA worker on this branch carries it out.`;
// Every open PR takes an instruction for a worker on it, whatever else the item offers.
const SEND_BACK = ['resume', null, 'resume "<instruction>" keeps it for the next worker and sends the ticket back to a worker on the PR'];
// Why a PR in this state takes no instruction, or null for an open one.
const prShut = (pr, state) => (state === 'MERGED' ? `PR #${pr} is merged, so no worker can carry out an instruction on it, and nothing was recorded.`
  : state === 'CLOSED' ? `PR #${pr} was closed without merging, so no worker can carry out an instruction on it, and nothing was recorded. Drop the ticket, or requeue it for a worker that opens a new PR.` : null);

// ---- A PR item in the person's words: what is wrong, then what to do and what happens once they have.
// No commit SHA, fix try or review-verdict wording: those are the pass's, for its log. Recorded text
// quoted in one is kept whole, and a URL in it untouched, so the session can ask it as it stands.
const URL_PART = /(https?:\/\/\S+)/;
const passWords = (s) => s.replace(/\s*\bat [0-9a-f]{7,40}\b/g, '').replace(/\b[0-9a-f]{7,40}\b/g, 'its latest commit')
  .replace(/\s*after \d+ fix tr(?:y|ies)/g, '').replace(/\bfix tr(?:y|ies)\b/g, 'repair').replace(/\breview verdict\b/g, 'review');
const plainWords = (s) => one(one(s).split(URL_PART).map((p, i) => (i % 2 ? p : passWords(p))).join(''));
// Once the person's step is done: desk merges it where it may, else merging is theirs too.
const thenMerge = (r) => (r.ctx?.merges ? 'desk then merges it once its checks are green' : 'then merge it on GitHub once its checks are green');
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
    evidence: row ? parseEvidenceRow([row]) : null,
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
  return `${n} is in conflict with ${base ?? 'its base'}, and ${how}. Resolve the conflict on its branch; ${thenMerge(r)}.`;
}

function stuckPlain(r, n, s, t) {
  const checks = s?.checks ?? [];
  if (checks.length) {
    const label = (c) => `"${c.name}"${c.step ? ` (failed at "${c.step}")` : ''}`;
    const mine = checks.filter((c) => !c.command), theirs = checks.filter((c) => c.command);
    const parts = [...(mine.length ? [`${andList(mine.map(label))} ${mine.length === 1 ? 'is' : 'are'} failing, and ${REPAIRED} ${mine.length === 1 ? 'it' : 'them'}`] : []),
      ...theirs.map((c) => `${label(c)} needs a step outside GitHub: ${c.command}`)];
    const todo = mine.length ? `Fix ${mine.length === 1 ? 'it' : 'them'} on its branch${theirs.length ? ', and do that step' : ''}` : `Do ${theirs.length === 1 ? 'that step' : 'those steps'}`;
    return `${n}: ${parts.join('; ')}. ${todo}; ${thenMerge(r)}.`;
  }
  const why = String(s?.why ?? '');
  const shots = CAPTURE.exec(why);
  if (shots) {
    const k = Number(shots[1]);
    return `${n} is a draft, and desk's capture try could not take ${k === 1 ? 'one of its screenshots' : `${k} of its screenshots`}, so nothing desk has can fill ${k === 1 ? 'its cell' : 'their cells'}. Edit the PR body so no cell is left; the next pass then takes it out of draft.`;
  }
  // Before the conflict test: a review reason names the conflict tries it was made after.
  if (/^review not clean/.test(why)) {
    const left = stuckFindings(why);
    const named = left.length ? `: ${left.map((f) => `${f.sev} ${one(f.text)}`).join('; ')}` : '';
    return `${n}'s code review still has findings ${repairsMade(why) ?? REPAIRED}${named}. ${left.length ? 'Send it back to a worker for one more try, or fix' : 'Fix'} them on its branch and post a fresh review; ${thenMerge(r)}.`;
  }
  const fb = /^review feedback still open[^:]*: (.+)$/.exec(why);
  if (fb) return `${n} still has review feedback open ${REPAIRED}: ${one(fb[1])}. Answer and resolve it, or fix it on its branch; ${thenMerge(r)}.`;
  if (/conflict/.test(why)) return conflictPlain(r, t, n, r.ctx?.base, why);
  if (/^no review verdict/.test(why)) return `${n} has no code review desk can read for its latest commit. Post one (run /desk-review on it); the next pass then takes it on.`;
  const red = /^still red[^:]*:\s*(.+)$/.exec(why);
  if (red) return `${n} has failing checks ${REPAIRED}: ${plainWords(red[1])}. Fix them on its branch; ${thenMerge(r)}.`;
  return `${n} is stuck where desk can not move it${why ? ` (${plainWords(why)})` : ''}. Settle it on GitHub; the next pass then picks it up.`;
}

function draftPlain(r, n, u) {
  const why = String(u?.why ?? '');
  const dirty = /not clean \(([^)]*)\)/.exec(why);
  if (dirty) {
    const kv = dirty[1].split(/\s+/).filter(Boolean).map((p) => p.split('=')).filter(([, v]) => Number(v) > 0);
    const found = kv.filter(([k]) => /^p\d$/i.test(k)).map(([k, v]) => `${v} ${k.toUpperCase()}`);
    const gaps = Number(kv.find(([k]) => k === 'gaps')?.[1] ?? 0);
    const what = andList([...(found.length ? [`${andList(found)} finding${found.length === 1 && found[0].startsWith('1 ') ? '' : 's'}`] : []), ...(gaps ? [`${gaps} requirement gap${gaps === 1 ? '' : 's'}`] : [])]);
    if (gaps) return `${n} is a draft, and its code review left ${what}. Say how to settle ${gaps === 1 && !found.length ? 'it' : 'them'}; a worker on the PR carries out your call.`;
    // No fix try ran on these: one that did and ran out is stuck (stuckPlain), so the reason is the review's.
    const it = found.length === 1 && found[0].startsWith('1 ') ? 'it' : 'them';
    const unsent = kv.some(([k]) => k === 'deferred') ? `which it marks deferred, so desk sends no worker to ${it}` : `which it does not list with a file:line a worker can fix, so desk sends no worker to ${it}`;
    if (what) return `${n} is a draft, and its code review found ${what}, ${unsent}. Fix ${it} on its branch and post a fresh review; the next pass then takes it out of draft.`;
  }
  if (/Clean review verdict is not set/.test(why)) return `${n} is a draft, and desk can not read its code review because §4 Clean review verdict is not set. Set it with /desk-setup; the next pass then reads the review.`;
  if (/clean and green/.test(why)) return `${n} is a draft with a clean review and green checks. Undraft it; ${thenMerge(r)}.`;
  if (!u) return `${n} is a draft with no review recorded. Review it, then undraft it; ${thenMerge(r)}.`;
  return `${n} is a draft: ${plainWords(why.replace(/^its? /, ''))}. ${capital(plainWords(u.action ?? 'settle it'))}; the next pass then picks it up.`;
}

// A PR into the default branch under a §4 Merge hold (desk-q parseHoldNote): the hold's step comes
// first, so the need names it, or the routine desk ran and the step it failed at.
function holdPlain(n, w) {
  const files = w.where ? ` (${one(w.where)})` : '';
  if (w.failed) {
    return `${n} touches files under a merge hold${files}, and desk ran its routine, \`${w.routine}\`, at ${w.failed.sha}: it failed (exit ${w.failed.exit}) at "${one(w.failed.step)}". Settle that step and finish the routine by hand, then merge it on GitHub; the ticket is then done.`;
  }
  const step = `${n} touches files under a merge hold${files}, and its step comes before the merge: ${one(w.why)}.`;
  // Only a routine held back by the §3 row is one the row can hand to desk; one held by a hold with no
  // routine stays the person's even with the row on.
  if (w.routine && /^§3 /.test(w.off ?? '')) return `${step} desk can run its routine, \`${w.routine}\`, but ${w.off}. Run it yourself, then merge it on GitHub (or set that row to yes with /desk-setup, and desk runs it and merges); the ticket is then done.`;
  if (w.routine) return `${step} desk can run its routine, \`${w.routine}\`, but ${w.off ?? 'it was not run'}. Run it and take that step yourself, then merge it on GitHub; the ticket is then done.`;
  // With no routine, the hold's reason is the step the person takes before merging.
  return `${n} is under a merge hold, so desk never merges it itself: "${one(w.why)}"${files}. Do what it asks first, then merge it on GitHub; the ticket is then done.`;
}

// ---- A red check that wants a person's approval, as its error line says: a review gate on protected
// files or over its file limit, in the wording of desk's review-gate.mjs or a repo's own gate.
const FILE_WORDS = [[/(^|\/)migrations?\//, 'a database migration'], [/(^|\/)schema\.(prisma|sql)$/, 'the database schema']];
const fileWords = (f) => FILE_WORDS.find(([re]) => re.test(f))?.[1] ?? `\`${f}\``;
// What `line` asks for, or null where it names neither cause: { why, then }, the reason and what else it says.
function approvalCause(line) {
  const s = String(line ?? '');
  if (!/approv/i.test(s)) return null;
  const listed = /(\d+) protected file\(s\):(.*)$/.exec(s), touches = /^It touches (.+?) with /.exec(s);
  const over = /\*{0,2}(\d+)\*{0,2} changed files, over the (\d+)-file limit/.exec(s);
  if (!listed && !touches && !over) return null;
  const files = [...String(listed?.[2] ?? touches?.[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const more = listed ? Number(listed[1]) - files.length : Number(/ and (\d+) more$/.exec(touches?.[1] ?? '')?.[1] ?? 0);
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
function prPlain(r, t) {
  const n = `PR #${t.result.pr}`;
  const w = prWhy(r, t) ?? {};
  const ask = approvalAsk(t, w);
  const needsIt = ask && `needs ${approverOf(r)}: ${ask.cause.why}.${ask.cause.then}`;
  if (ask && !ask.left.length) return `${n} ${needsIt} No code change clears it, only an approving review on GitHub at its latest commit; ${thenMerge(r)}.`;
  // Beside other red checks, those are worded as ever, and the approval is said after them.
  const also = ask ? ` It also ${needsIt}` : '';
  switch (w.code) {
    case 'closed': return `${n} was closed without merging, so nothing will merge it. Drop the ticket, or requeue it; a requeued ticket gets a worker that opens a new PR.`;
    case 'stuck': return `${stuckPlain(r, n, ask ? { ...w.stuck, checks: w.stuck.checks.filter((c) => !ask.names.has(c.name)) } : w.stuck, t)}${also}`;
    case 'spine': return `${n} is the feature spine, still a draft. Approve its acceptance specs; desk then takes it out of draft.`;
    case 'skipped': return `${n} is a draft, and CI does not run on drafts, so its checks were skipped. Undraft it so they run; ${thenMerge(r)}.`;
    case 'draft': return draftPlain(r, n, w.undraft);
    case 'hold': return holdPlain(n, w);
    case 'feedback': return `${n} is held for review: ${one(w.text)}. Resolve or answer it; desk then merges it.`;
    case 'approval': return `${n} waits on a person's approval: ${plainWords(w.text).replace(/: a person approves it before desk merges it$/, '')}. Review and approve it on GitHub; desk then merges it.`;
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
  return `(You said done at ${String(d.at).slice(0, 16).replace('T', ' ')} UTC, and GitHub still showed it ${shown}.)`;
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
    return otherRunningBatches(r.slug, r.queuePath, () => repoConfigValue(r.slug, 'default-branch') ?? 'main', finishedOnRecord).map(moveTarget);
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
    return { key: b.key, category: b.category ?? 'new', batch: at ? (at.name ?? 'standing') : null };
  });
}
const holdWords = (o) => `${o.key} (${(JIRA_CATEGORY[o.category] ?? o.category).toLowerCase()}, ${o.batch ? `in batch ${o.batch}` : 'in no batch'})`;
// Every blocker a ticket names, in its batch or outside it, with its state: a put-off item's input, so a
// blocker that moves brings it back.
function blockerStates(r, t) {
  const out = new Map(outsideHolds(r, t).map((o) => [o.key, `${o.category}@${o.batch ?? 'none'}`]));
  return [...new Set([...keysOf(t.held_by), ...out.keys()])].map((b) => `${b}:${r.q.tickets?.[b]?.state ?? out.get(b) ?? 'none'}`).join(',');
}
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
const batchRows = (r) => [usageRow(r), basePushRow(r)].filter(Boolean);
// The base-push items desk-q counts, one per batch of a repo row (each keyed in its batch, `b`): unlike
// a usage hold it never lifts by itself, so it needs the person.
const basePushRows = (r) => (r.batches ?? [r]).flatMap((b) => { const x = basePushRow(b); return x ? [{ ...x, b }] : []; });

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
    need: `§3 ${g.key} is not set in ${g.r.repo}'s config, so desk reads it as no, and ${n === 1 ? 'a ticket' : `${n} tickets`} parked on it (${andList(keys)}). Answer it once with /desk-update in ${rootOf(g.r)}, which asks every row the config lacks; then say done, and ${n === 1 ? 'it is' : 'each is'} requeued`,
    actions: [['done', `once the row is set, done requeues ${n === 1 ? 'the ticket' : `all ${n} tickets`} parked on it`], ['not-now']] };
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
// behind it (merge_after), not its build. The step is one item, `step:<KEY>`, for the repo however
// many of its batches have a ticket still to merge on it, naming every PR and ticket waiting in each;
// the pass lifts the hold once Jira has the step Done, so done records nothing. `batches` are one
// repo's; each item is shown in `r`, the standing batch where it is one of them, else the first by
// name with a ticket waiting, and is put off in `dir`, always the standing batch's state folder, so
// desk-q's count over any of the repo's batches and this list read one register.
const STEP = 'step:';
const standingDir = (b) => (b.batch == null ? b.stateDir : resolve(b.stateDir, '..', '..'));
// Every ticket in any of the repo's batches still to merge on the step, read from the queues on disk,
// so a step is put off under the same inputs whichever of the repo's batches a caller passed.
const waitingOn = (slug, key) => listBatches(slug)
  .flatMap((b) => { try { return Object.values(readQueue(b.queue).tickets ?? {}); } catch { return []; /* no queue there */ } })
  .filter((t) => !t.merged_at && t.state !== 'failed' && keysOf(t.merge_after).includes(key)).map((t) => t.key).sort();
function stepItems(batches) {
  const waits = new Map();
  for (const b of batches) {
    for (const t of Object.values(b.q?.tickets ?? {})) {
      if (t.merged_at || t.state === 'failed') continue;
      for (const k of keysOf(t.merge_after)) waits.set(k, [...(waits.get(k) ?? []), { b, t }]);
    }
  }
  const standing = batches.find((b) => b.batch == null);
  return [...waits].map(([key, ws]) => {
    const r = standing ?? ws.map((w) => w.b).sort((a, c) => String(a.batch).localeCompare(String(c.batch)))[0];
    return { r, dir: standingDir(r), in: new Set(ws.map((w) => w.b)), t: { key: `${STEP}${key}` }, item: { ...stepItem(key, ws), waiting: waitingOn(r.slug, key) } };
  });
}
function stepItem(key, ws) {
  const summary = ws.map(({ b, t }) => (triageOf(b.stateDir, t.key)?.blockers ?? []).find((x) => x?.key === key)?.summary).find(Boolean);
  const what = ({ t }) => (t.state === 'done' && t.result?.pr != null ? `PR #${t.result.pr} (${t.key})` : `${t.key} (${t.state === 'running' ? 'being built' : t.state === 'done' ? 'no PR' : 'not built yet'})`);
  const n = ws.length, merges = ws.filter(({ b }) => b.ctx?.merges).length;
  const merger = merges === n ? 'desk merges them in order' : merges === 0 ? 'you merge them on GitHub'
    : 'desk merges those in batches it merges, and you merge the rest on GitHub';
  return { kind: 'step', step: key,
    need: `${key}${summary ? ` ("${one(summary)}")` : ''} is a step only you can take, and ${n === 1 ? 'one ticket waits' : `${n} tickets wait`} to merge on it: ${andList(ws.map(what))}. Do it and move ${key} to Done in Jira; the next pass that reads it lifts the hold, and ${merger}`,
    actions: [['done', `once ${key} is Done in Jira, the next pass that reads it lifts the hold`], ['not-now']],
    since: finite(Math.min(...ws.map(({ t }) => timeOf(t.added_at) ?? Infinity))) };
}

// One item's kind, its one-line need and its actions, the recommended one first with its reason.
function itemOf(r, x) {
  const t = x.t;
  if (x.usage) return { kind: 'usage', need: usageHoldOf(r), actions: [['done', 'it lifts by itself; switch subscription to lift it sooner, then say done'], ['not-now']] };
  if (x.basePush) {
    const a = r.q.base_push_ask;
    const base = a.base ?? 'the batch base', source = a.source ?? 'the default branch';
    const ci = behindPrs(r.q);
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
    const need = prPlain(r, t), note = [captureNote(stuck), doneNote(t)].filter(Boolean).join(' ');
    // Closed unmerged: nothing merges it, so the ticket leaves the batch, or goes back for a new PR.
    if (t.pr_status?.state === 'CLOSED') return { kind: 'pr', need, note, actions: [['drop', 'its PR was closed without merging, so nothing will merge it; drop takes the ticket out of the batch'], ['requeue'], ['not-now']] };
    const openPr = (...actions) => ({ kind: 'pr', need, note, actions: [...actions, SEND_BACK, ['not-now']] });
    if (reviewGaps(t)) return openPr(['answer', 'say how to settle its review gaps; it is posted on the PR and a worker on the PR carries it out'], ['done']);
    // Held by nothing but a person's approval: once asked for, there is nothing to do but wait for it.
    const ask = approvalAsk(t, prWhy(r, t) ?? {});
    if (ask && !ask.left.length) return { ...openPr(['waiting', 'once the approval is asked for, waiting keeps it off this list until it gets one or its head moves'], ['done']), approval: true };
    // A step off GitHub (a build, a staging migration) has no recommendation: its need names the step,
    // and the item leaves the list once every check it is still stuck on is green.
    const outside = stuck?.outside ?? [];
    if (outside.length) {
      const checks = `${stuck.checks.map((c) => `"${c.name}"`).join(', ')} ${stuck.checks.length === 1 ? 'is' : 'are'} green`;
      return openPr(['done', null, `the step is outside GitHub (${outside.map((c) => c.command).join('; ')}); it drops off once ${checks}`]);
    }
    // Review findings in the code are a worker's to fix, so one more try goes to a worker on the PR.
    if (stuck && personReviewFix(t, { why: stuck.why })) {
      return openPr(['fix', "its findings are in the code, which a worker can fix: fix sends it to a worker on the PR for one more try, and the review of its new head says whether they are gone"], ['done']);
    }
    return openPr(['done', 'only you can do this step; say done once you have, and the PR is checked on GitHub there and then']);
  }
  // A worktree the pass will not spawn into (desk-q worktreeBusy): only the person, or the session in
  // it, makes it clean, and the pass drops the record once it is.
  const wb = worktreeBusy(t);
  // Requeued off a park and held here: the park says why its worker stopped, and the ticket is queued
  // already, so a resume only records what the next worker should know.
  if (busyPark(t)) return { kind: 'worktree', need: one(busyPark(t).question), note: `${capital(worktreeBusyText(wb))}.`, actions: [['resume', 'say what you did about it; a worker finishes it, with your note in its briefing, once a pass finds its worktree clean'], ['not-now']] };
  if (wb) return { kind: 'worktree', need: worktreeBusyText(wb), actions: [['done', 'commit, push or discard its changes (or end the session working in it), then say done; the next pass that finds it clean starts it'], ['not-now']] };
  if (x.k === 'failed' && sessionPark(parkText(r, t))) return { kind: 'stopped', need: `worker stopped: ${one(parkText(r, t))}`, actions: [['open', sessionWhy(parkText(r, t))], ['not-now']] };
  if (x.k === 'failed') return { kind: 'stopped', need: needText(r, x), actions: [['requeue', 'its worker gave up; a requeue lets the next pass start it again'], ['not-now'], ...moveAction(r)] };
  // Held by open tickets outside the batch, held inside it or not, with its question on them open. A
  // blocker no batch holds is worked by nobody, so admitting it comes first; answering says whether this
  // one can start without them.
  if (x.k === 'stuck') {
    const outside = outsideHolds(r, t), free = outside.filter((o) => !o.batch).map((o) => o.key);
    const one1 = free.length === 1;
    const admit = free.length ? [['admit', `${andList(free)} ${one1 ? 'is' : 'are'} in no batch, so nothing works ${one1 ? 'it' : 'them'}: admitting queues ${one1 ? 'it' : 'them'} for a worker`]] : [];
    const answerWhy = 'say whether it can start without the tickets outside; the next pass can then start it';
    return { kind: 'held', need: `held by ${andList(outside.map(holdWords))}, outside this batch`,
      actions: [...admit, admit.length ? ['answer', null, answerWhy] : ['answer', answerWhy], ['not-now']] };
  }
  // A held ticket with a question of its own is asked that question, below.
  if (isHeld(t) && !heldAsks(t)) {
    const h = holdOf(r.q, t, r.ctx);
    return h.act
      ? { kind: 'held', need: h.text, actions: [['start', 'nothing else lets it start, and once you do the next pass can start it'], ['not-now']] }
      : { kind: 'held', need: h.text, actions: [['done', 'only you can do this step; say done once you have'], ['not-now']] };
  }
  if (t.state === 'parked' && !isHeld(t)) {
    const need = one(t.park?.question) || 'parked, with no question recorded';
    // What its worktree holds that origin does not, as the last pass read it.
    const note = t.park?.unpushed ? `${capital(t.park.unpushed)}.` : undefined;
    if (planPark(t)) return { kind: 'plan', need, note, actions: [['answer', 'say start, discard, or the edit to make; the supervisor acts on it at its next tick: an edit is applied and the batch starts, and one it cannot apply comes back here naming why'], ['not-now']] };
    const sp = spinePark(t);
    if (sp === 'approval') return { kind: 'spine', need, note, actions: [['approve', 'its acceptance specs passed the spec check'], ['reject'], ['not-now']] };
    if (sp === 'specs') return { kind: 'spine', need, note, actions: [['reject', 'its acceptance specs failed the spec check, so it goes back with what to fix'], ['not-now']] };
    if (sessionPark(parkText(r, t))) return { kind: 'session', need, note, actions: [['open', sessionWhy(parkText(r, t))], ...handBack(r, t), ['not-now']] };
    if (needsSession(t)) return { kind: 'session', need, note, actions: [['open', `lane ${t.lane ?? 'C or D'}: only an interactive desk-ticket session takes it on`], ...handBack(r, t), ['not-now']] };
    if (triagePark(t)) return { kind: 'session', need, note, actions: [['open', 'parked at triage: it needs splitting or its links fixing, which a requeue cannot do'], ['not-now']] };
    const { taken, overrides } = readDecisions(r.stateDir);
    const overridden = new Set(overrides.map((o) => o.override_of));
    const offer = taken.filter((d) => d.ticket === t.key && !overridden.has(d.id)).slice(-DECISIONS_SHOWN).reverse()
      .map((d) => [`override ${d.id}`, null, `took "${cut(one(d.chose), 40)}" on "${cut(one(d.question), 60)}"`]);
    // No bare answer: it would leave the ticket parked, and desk-q still counting it.
    return { kind: 'parked', need, note, actions: [['resume', `lane ${laneOf(t, triageOf(r.stateDir, t.key))}: a worker finishes it once it has your answer`], ['not-now'], ...moveAction(r), ...offer] };
  }
  // Its questions as the digest page words them, so a put-off entry keys to the same text.
  const need = one(openQuestions(digestList(r)[0]).find((q) => q.ticket === t.key && q.kind === 'triage')?.text) || `${t.open_questions} triage question(s) open`;
  return { kind: 'triage', need, actions: [['answer', 'answering clears its questions, so the next pass can start it'], ['not-now']] };
}

// The question and inputs an item is put off under. A park is keyed as answer.mjs records it, to its
// question and park inputs; anything else to its ticket and kind, since several tickets share a need's
// words, with its need, PR head and the states of any blockers it names as inputs, so a moved head or
// a blocker that went done brings it back. A PR's need is left out: it carries the age of its running
// checks.
const PARK_KINDS = ['parked', 'session', 'spine', 'plan'];
function putOffKey(r, t, item) {
  if (PARK_KINDS.includes(item.kind)) return { question: t.park?.question ?? '', inputs: t.park?.inputs ?? {} };
  // A step: what waits on it in every batch of the repo, not its need, which names only those passed.
  if (item.kind === 'step') return { question: `${t.key} step`, inputs: { ticket: t.key, waiting: item.waiting.join(', ') } };
  const inputs = { ticket: t.key };
  if (item.kind === 'pr') inputs['pr-head'] = t.pr_status?.head ?? '';
  else inputs.need = item.need;
  if (item.approval) inputs.approvals = (t.pr_status?.approvals ?? []).join(', ') || 'none';
  // A worktree item led by its park's reason holds the worktree's state in its note: a new hold brings it back.
  if (item.kind === 'worktree' && item.note) inputs.hold = item.note;
  const blockers = blockerStates(r, t);
  if (blockers || item.kind === 'held') inputs.blockers = blockers;
  return { question: `${t.key} ${item.kind}`, inputs };
}

// A needs row as an item, and what the not-now register says of it: the one rule desk-q's count and
// this list both go by. An item put off with unchanged inputs is asked again once it offers an action
// it did not offer then. An entry from before entries recorded actions is asked again once, and
// records them. Every way of putting an item off records them since (stampActions), so one written
// since without them is an item no batch listed when it was put off: it stays put off on its inputs.
const ACTIONS_SINCE = Date.parse('2026-11-01T15:00:00Z');
const recordedBefore = (e) => !(Date.parse(e.at) >= ACTIONS_SINCE);
function judged(r, x, register) {
  const item = itemOf(r, x);
  const l = lookup(register, putOffKey(r, x.t, item));
  if (l.status !== 'put_off') return { item, l };
  const was = Array.isArray(l.entry.actions) ? l.entry.actions : null, now = verbsOf(item);
  if (was ? now.every((a) => was.includes(a)) : !recordedBefore(l.entry)) return { item, l };
  return { item, l: { status: 'changed', entry: l.entry, line: changedLine(l.entry, [`actions ${was ? was.join(', ') : '(not recorded)'} → ${now.join(', ')}`]) } };
}

// Records on a ticket's put-off entry the actions its item offers now, so one it gains later brings it
// back (judged). answer.mjs and not-now.mjs add call it once they have put a question off, as this
// file's not-now does: neither knows an item's actions. The batch is the one whose state directory is
// `stateDir`. Returns the actions recorded, or null where that batch lists no item for the ticket or
// the item is keyed to another question than the one put off: an older entry of the item's own is
// never stamped, or the actions it gained since would hide it again.
export function stampActions({ stateDir, ticket, question, now = Date.now(), repos = loadRepos(now) }) {
  const r = repos.find((b) => b.q && resolve(b.stateDir) === resolve(stateDir));
  const x = r && needsRows(r).find((y) => y.t.key === ticket);
  const item = x && itemOf(r, x);
  return item && questionKey(putOffKey(r, x.t, item).question) === questionKey(question) ? stampItem(r, x, item) : null;
}
function stampItem(r, x, item) {
  const l = lookup(readRegister(r.stateDir), putOffKey(r, x.t, item));
  if (l.status !== 'put_off') return null;
  const actions = verbsOf(item);
  if (l.entry.actions?.join() !== actions.join()) addPutOff({ ...l.entry, actions }, r.stateDir);
  return actions;
}

// desk-q's NEEDS YOU count for a batch, or for a repo row of several (each row keyed in its own batch,
// `b`): the rows that need the person (`rows`), plus its person's-step items (stepItems), as
// `shown`, less `putOff`, those put off with unchanged inputs.
export function needsCount(r) {
  const registers = new Map();
  const register = (b) => { if (!registers.has(b.stateDir)) registers.set(b.stateDir, readRegister(b.stateDir)); return registers.get(b.stateDir); };
  const rows = [];
  let putOff = 0, steps = 0;
  for (const x of [...basePushRows(r), ...needsRows(r)]) {
    const b = x.b ?? r;
    if (judged(b, x, register(b)).l.status === 'put_off') putOff++; else rows.push(x);
  }
  for (const s of stepItems((r.batches ?? [r]).filter((x) => x.q))) {
    if (lookup(register({ stateDir: s.dir }), putOffKey(s.r, s.t, s.item)).status === 'put_off') putOff++; else steps++;
  }
  return { shown: rows.length + steps, putOff, rows };
}

// The batches `word` names, else every batch desk-q's home screen shows.
const scopeOf = (repos, word) => (word ? batchesNamed(repos, word) : { named: null, scope: shownRepos(repos, false) });

// Every item desk-q counts as needing the person, in the batches `word` names (all when null), less
// those put off with unchanged inputs (`putOff` counts them). One whose inputs changed says what did.
// A usage-limit hold is an item here, but not in desk-q's count; a base-push item is in both.
export function collect({ word = null, now = Date.now(), repos = loadRepos(now) } = {}) {
  const { named, scope } = scopeOf(repos, word);
  const items = [];
  let putOff = 0;
  const seen = new Map();
  const unsetIn = (slug, k) => { const id = `${slug}\t${k}`; if (!seen.has(id)) seen.set(id, repoPermissionUnset(slug, k)); return seen.get(id); };
  const groups = new Map();
  // The repo-level and step items, put off under their own key as any other item is.
  // `dir` is where it is put off, its batch's state folder unless the item names another.
  const repoItem = (r, t, item, since, dir = r.stateDir) => {
    const key = putOffKey(r, t, item);
    const l = lookup(readRegister(dir), key);
    if (l.status === 'put_off') { putOff++; return; }
    if (l.status === 'changed') item.need = `${item.need} (${l.line})`;
    items.push({ r, t, ...item, putOffKey: key, putOffDir: dir, since, broken: false });
  };
  for (const r of scope.filter((x) => !x.error && x.q)) {
    const register = readRegister(r.stateDir);
    for (const x of [...batchRows(r), ...needsRows(r)]) {
      const { item, l } = judged(r, x, register);
      if (l.status === 'put_off') { putOff++; continue; }
      const since = x.usage ? timeOf(r.q.usage_hold.since) : x.basePush ? timeOf(r.q.base_push_ask.since) : timeOf(x.t.park?.since ?? x.t.added_at);
      const row = item.kind === 'parked' ? unsetRowOf(r, x.t, unsetIn) : null;
      if (row) {
        const id = `${r.slug}\t${row}`;
        if (!groups.has(id)) groups.set(id, { r: standingOf(repos, r), key: row, parked: [] });
        groups.get(id).parked.push({ r, t: x.t, since });
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
      if ([...s.in].some((b) => dirs.has(resolve(b.stateDir)))) repoItem(s.r, s.t, s.item, s.item.since, s.dir);
    }
  }
  for (const g of groups.values()) repoItem(g.r, { key: `${UNSET}${g.key}` }, unsetItem(g), finite(Math.min(...g.parked.map((p) => p.since ?? Infinity))));
  const slugs = new Set((word ? scope : repos).map((x) => x.slug));
  for (const slug of slugs) {
    const r = repos.find((x) => x.slug === slug && x.batch == null);
    const item = r && !r.error ? templatesItem(r, templatesRecord(slug)) : null;
    if (item) repoItem(r, { key: TEMPLATES }, item, item.since);
  }
  items.sort((a, b) => (b.broken - a.broken) || ((a.since ?? Infinity) - (b.since ?? Infinity)) || a.t.key.localeCompare(b.t.key));
  return { repos, scope, items, named, putOff };
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

export function listText(c, now = Date.now()) {
  if (!c.items.length) return `Nothing needs you${c.named ? ` in ${c.named.name}` : ''}.${putOffLine(c)}`;
  // A repo-level item is the person's own step, so who runs the batch says nothing about it.
  const lines = [...new Set(c.items.filter((i) => !i.repoLevel).map((i) => i.r))].map(runLine);
  const repos = [...new Set(c.items.map((i) => i.r))];
  for (const i of c.items) {
    const waited = i.since == null ? '' : ` ${since(now - i.since)}`;
    // The need is never cut: the session asks from this line, so a recommendation or URL in it must
    // survive. A done note follows it whole: what GitHub showed when the person last said done.
    const need = `${i.need}${i.note ? ` ${i.note}` : ''}`;
    lines.push(`${i.r.word} ${i.t.key} ${i.kind}${waited} | ${need} | ${i.actions.map(actionText).join(' | ')}`);
  }
  const n = new Set(repos.map((r) => r.slug)).size;
  lines.push(`${c.items.length} item${c.items.length === 1 ? '' : 's'} in ${n} repo${n === 1 ? '' : 's'}.${putOffLine(c)}`);
  return lines.join('\n');
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

// Records one answer: { ok, line, message } where `message` is what a live session must be sent.
export function record({ word, ticket, action, text = '', now = Date.now(), repos = loadRepos(now) }) {
  if (ticket.startsWith(UNSET) || ticket.startsWith(STEP) || ticket === TEMPLATES) return recordRepoItem({ word, ticket, action, now, repos });
  // A ticket is in one batch at most, so the batch named that holds it is the one its answer goes to.
  const { named, scope } = batchesNamed(repos, word);
  const r = scope.find((b) => b.q?.tickets?.[ticket]) ?? named;
  const [verb, id] = action.split(/\s+/);
  // A resume on a PR the queue already has shut says why, not that the verb or the item is unknown.
  const queued = r.q?.tickets?.[ticket], status = prStatusOf(queued);
  const shut = verb === 'resume' && status ? prShut(status.pr, queued.merged_at ? 'MERGED' : status.state) : null;
  if (shut) return { ok: false, line: `${r.name} ${ticket}: ${shut}` };
  const x = !r.q ? null : [...batchRows(r), ...needsRows(r)].find((y) => y.t.key === ticket);
  if (!x) return { ok: false, line: `${r.name} ${ticket}: desk-q does not count it as needing you, so nothing was recorded.` };
  const item = itemOf(r, x);
  // move is taken on any parked or stopped item, listed or not, so one naming no running batch is
  // refused naming those that are.
  const allowed = [...item.actions.map(([a]) => a.split(' ')[0]), ...(MOVABLE.includes(item.kind) ? ['move'] : [])];
  if (!allowed.includes(verb)) return { ok: false, line: `${r.name} ${ticket}: ${verb} is not an action for a ${item.kind} item (${[...new Set(allowed)].join(', ')}).` };
  const w = runner(r);
  const tail = w.by === 'stopped' ? ` Passes are stopped in ${r.name}: nothing acts on it until they resume.` : '';
  const say = (ok, line, message = null) => ({ ok, line: `${r.name} ${ticket}: ${line}${ok ? tail : ''}`, message });
  if (['answer', 'resume', 'reject', 'override'].includes(verb) && !text.trim()) return say(false, `${verb} needs the text to record.`);
  if (verb === 'move' && !text.trim()) return say(false, 'move needs the batch to move it to.');
  const ans = () => answer({ slug: r.slug, ticket, text, list: digestList(r), now: new Date(now) });
  const putOff = () => addPutOff(putOffEntry({ ...putOffKey(r, x.t, item), ticket, at: new Date(now).toISOString(), actions: verbsOf(item) }), r.stateDir);
  // A fix for the ticket's next worker, then the requeue that spawns it: written first so the spawn
  // reads it, and taken back if the requeue is refused. null once both are made, else what refused.
  const sendFix = (fix) => {
    const f = queueCmd(r, ['set', ticket, `fix=${JSON.stringify({ ...fix, at: new Date(now).toISOString() })}`]);
    if (!f.ok) return `its fix was refused: ${f.out}`;
    const q = queueCmd(r, ['requeue', ticket]);
    if (!q.ok) { queueCmd(r, ['set', ticket, 'fix=null']); return `the requeue was refused: ${q.out}`; }
    return null;
  };
  // The person's call on a draft's review gaps: posted on the PR, kept in the briefing and as the fix
  // its next worker starts on, then requeued. Requeued whoever runs the batch: the next pass closes a
  // fix on a ticket still done, so one left for a session to requeue would be lost.
  const gapsAnswer = () => {
    const pr = x.t.result.pr;
    const repo = repoConfigValue(r.slug, 'gh-repo') ?? r.slug.replace('__', '/');
    try { execFileSync('gh', ['pr', 'comment', String(pr), '--repo', repo, '--body', prComment(text)], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return say(false, `not posted on PR #${pr} (${one(e.stderr || e.message)}), so nothing was recorded.`); }
    const a = ans();
    if (!a.ok) return say(false, `posted on PR #${pr}, but not recorded: ${a.why}`);
    const no = sendFix(gapsFix({ pr, head: x.t.pr_status?.head, answer: text }));
    if (no) return say(false, `posted on PR #${pr} and in its briefing, but ${no}`);
    return say(true, `posted on PR #${pr}, kept for its next worker and requeued; the next pass sends it to a worker on the PR.`);
  };
  // The PR as GitHub has it now, which the queue's record may be a pass behind: { v, err, repo }.
  const readPr = (pr, more = '') => {
    const repo = repoConfigValue(r.slug, 'gh-repo') ?? r.slug.replace('__', '/');
    try { return { v: JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', `state,mergedAt,isDraft,headRefOid${more}`],{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })), err: '', repo }; }
    catch (e) { return { v: null, err: one(e.stderr || e.message), repo }; }
  };
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
    const shows = v.state === 'CLOSED' ? 'closed without merging' : `unmerged${check.draft ? ', still a draft' : ''}`;
    const m = queueCmd(r, ['set', ticket, `done_check=${JSON.stringify(check)}`]);
    if (cells) {
      const still = `GitHub still shows ${cells} screenshot cell(s) in PR #${pr}'s body`;
      return say(false, m.ok ? `${still}, so it stays on your list: ${cellWords(r, x.t, pr, v, repo)}.` : `${still}; noting it on the item was refused: ${m.out}`);
    }
    if (!m.ok) return say(false, `GitHub still shows PR #${pr} ${shows}; noting it on the item was refused: ${m.out}`);
    const moved = check.head && x.t.pr_status?.head && check.head !== x.t.pr_status.head;
    return say(false, `GitHub still shows PR #${pr} ${shows}${moved ? ', though it has new commits the next pass reads' : ''}, so it stays on your list with that note.`);
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
      const a = ans();
      if (!a.ok) return say(false, a.why);
      if (item.kind === 'worktree') return say(true, 'recorded for its next worker; the next pass that finds the worktree clean starts it.');
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
      const steps = releaseCommand(ticket, '').split(/, then /).map((s) => s.trim().split(/\s+/));
      for (const s of steps) { const q = queueCmd(r, s); if (!q.ok) return say(false, `refused: ${q.out}`); }
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
      if (PARK_KINDS.includes(item.kind)) {
        const a = answer({ slug: r.slug, ticket, text: 'not now', list: digestList(r), now: new Date(now) });
        if (!a.ok) return say(false, a.why);
        stampItem(r, x, item);
        return say(true, 'put off (not-now register).');
      }
      putOff();
      return say(true, `put off (${notNowPath(r.stateDir)}).`);
    }
    case 'waiting': {
      putOff();
      return say(true, `waiting on its approval (${notNowPath(r.stateDir)}): not listed again until it gets one or its head moves.`);
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
    case 'drop': { const q = queueCmd(r, ['drop', ticket]); return q.ok ? say(true, 'dropped from the batch (queue.mjs drop).') : say(false, `drop refused: ${q.out}`); }
    case 'open': {
      const root = repoConfigValue(r.slug, 'repo-root');
      return say(true, `not requeued (${neverStep(parkText(r, x.t)) ? 'a step no worker is allowed' : 'lane C or D'}). Open an interactive session${root ? ` in ${root}` : ` in ${r.name}`} and run /desk-ticket ${ticket}.`);
    }
    // Admission runs its own checks on each blocker, so it is the person's /desk-admit, not made here.
    case 'admit': {
      const free = outsideHolds(r, x.t).filter((o) => !o.batch).map((o) => o.key);
      const root = repoConfigValue(r.slug, 'repo-root');
      return say(true, `nothing recorded. Run /desk-admit ${free.join(' ')} in ${root ?? r.name}; ${ticket} stays held until ${free.length === 1 ? 'it is' : 'they are'} Done, or you answer that it can start without ${free.length === 1 ? 'it' : 'them'}.`);
    }
    case 'done': {
      if (x.pr || heldDraft(x.t)) return prDone();
      if (item.kind === 'usage') return say(true, 'noted: the batch carries on by itself once the usage limit lifts.');
      if (item.kind === 'worktree') return say(true, 'noted: the next pass that finds the worktree clean drops the record and starts it.');
      return say(true, 'noted: the next pass reads it again and moves it on once your step shows.');
    }
    default: return say(false, `unknown action ${verb}.`);
  }
}

// A repo-level or step item's answer. Done on an unset row requeues every ticket parked on it once the
// row is set, each in its own batch (or names the live session to message); done on behind templates
// checks the copies again now; done on a step records nothing, since the pass reads the step from Jira.
function recordRepoItem({ word, ticket, action, now, repos }) {
  const c = collect({ word, now, repos });
  let i = c.items.find((y) => (y.repoLevel || y.kind === 'step') && y.t.key === ticket);
  // A row set since the list was shown no longer groups its parks there; done still finds them.
  if (!i && ticket.startsWith(UNSET) && c.named) {
    const key = ticket.slice(UNSET.length);
    const parked = repos.filter((b) => b.slug === c.named.slug && !b.error && b.q)
      .flatMap((b) => needsRows(b).filter((x) => x.t.state === 'parked' && namesRow(String(x.t.park?.question ?? ''), key)).map((x) => ({ r: b, t: x.t })));
    if (parked.length) {
      const g = { r: standingOf(repos, c.named), key, parked };
      i = { r: g.r, t: { key: ticket }, ...unsetItem(g) };
      i.putOffKey = putOffKey(i.r, i.t, i);
    }
  }
  if (!i) return { ok: false, line: `${c.named?.name ?? word} ${ticket}: desk-q does not count it as needing you, so nothing was recorded.` };
  const [verb] = action.split(/\s+/);
  const say = (ok, line, message = null) => ({ ok, line: `${i.r.repo} ${ticket}: ${line}`, message });
  if (!i.actions.some(([a]) => a === verb)) return say(false, `${verb} is not an action for a ${i.kind} item (${i.actions.map(([a]) => a).join(', ')}).`);
  if (verb === 'not-now') {
    addPutOff(putOffEntry({ ...i.putOffKey, ticket, at: new Date(now).toISOString(), ...(i.kind === 'step' ? { actions: verbsOf(i) } : {}) }), i.putOffDir ?? i.r.stateDir);
    return say(true, `put off (${notNowPath(i.putOffDir ?? i.r.stateDir)}).`);
  }
  if (i.kind === 'step') return say(true, `noted: the next pass that reads ${i.step} from Jira lifts the hold on what waits for it once it is Done${i.r.ctx?.merges ? ', and desk then merges them' : ''}.`);
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
  const requeued = [], refused = [], bySession = new Map();
  for (const p of i.parked) {
    const w = runner(p.r);
    if (w.by === 'session') { const s = w.name ?? '(no batch name recorded)'; bySession.set(s, [...(bySession.get(s) ?? []), p.t.key]); continue; }
    const q = queueCmd(p.r, ['requeue', p.t.key]);
    if (q.ok) requeued.push(p.t.key); else refused.push(`${p.t.key} (${q.out})`);
  }
  const them = (ks) => (ks.length === 1 ? 'it' : 'them');
  const parts = [...(requeued.length ? [`requeued ${andList(requeued)}; the next pass can spawn ${them(requeued)}`] : []),
    ...(refused.length ? [`the requeue was refused for ${andList(refused)}`] : []),
    ...[...bySession].map(([s, ks]) => `a live session (${s}) runs ${andList(ks)}: message it to requeue ${them(ks)}`)];
  const [first] = bySession;
  return say(!refused.length, `§3 ${key} is set now: ${parts.join('; ')}.`,
    first ? { to: first[0], text: `${andList(first[1])} parked on §3 ${key}, which is now set: requeue ${them(first[1])} (node ~/.claude/desk/bin/queue.mjs requeue <TICKET>).` } : null);
}

// What is left: desk-q's NEEDS YOU count in scope (needsCount's rule), then a line for each unfinished batch there whose passes are
// stopped, needing the person or not: one just answered no longer does, and still waits on a pass.
export function leftText({ word = null, now = Date.now(), repos = loadRepos(now) } = {}) {
  const c = scopeOf(repos, word);
  const where = c.named ? ` in ${c.named.name}` : '';
  const counts = c.scope.filter((x) => !x.error && x.q).map(needsCount);
  const n = counts.reduce((a, y) => a + y.shown, 0);
  const lines = [`desk-q counts ${n} item${n === 1 ? '' : 's'} needing you${where}.${putOffLine({ putOff: counts.reduce((a, y) => a + y.putOff, 0) })}`];
  for (const r of (c.named ? c.scope : repos).filter((x) => !x.error && x.q && !x.live && (x.rows.length || x.prs.length))) {
    lines.push(`Passes are stopped in ${r.name}, so nothing acts on its answers yet. To resume: ${resumeOf(r)}.`);
  }
  return lines.join('\n');
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const refuse = (why) => { console.error(why); process.exit(EXIT.SHOW_PERSON); };
  try {
    if (cmd === 'list' && rest.length <= 1) console.log(listText(collect({ word: rest[0] ?? null })));
    else if (cmd === 'left' && rest.length <= 1) console.log(leftText({ word: rest[0] ?? null }));
    else if (cmd === 'record' && rest.length >= 3) {
      const [word, ticket, verb, ...more] = rest;
      // An override names its decision id before the choice.
      const [action, text] = verb === 'override' ? [`override ${more[0] ?? ''}`, more.slice(1).join(' ')] : [verb, more.join(' ')];
      const res = record({ word, ticket, action, text });
      console.log(res.line);
      if (res.message) console.log(`MESSAGE ${res.message.to ?? '(no batch name recorded)'}: ${res.message.text}`);
      if (!res.ok) process.exit(EXIT.SHOW_PERSON);
    } else if (cmd === 'move' && rest.length === 3) {
      const [word, ticket, to] = rest;
      const res = record({ word, ticket, action: 'move', text: to });
      console.log(res.line);
      if (!res.ok) process.exit(EXIT.SHOW_PERSON);
    } else refuse('usage: needs-you.mjs list [<repo>] | record <repo> <TICKET> <action> ["<text>"] | move <repo> <TICKET> <batch> | left [<repo>]');
  } catch (e) { refuse(e.message); }
}
