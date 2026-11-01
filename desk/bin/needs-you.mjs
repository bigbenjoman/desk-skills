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
//                           name the session to ask
//       answer "<answer>"   answer it only (digest.mjs answer): triage questions, and an epic's drafted
//                           plan (start, discard, or an edit), recorded on the epic for the supervisor to
//                           act on (epic-plan.mjs actOnPlan). On a draft PR whose
//                           review left gaps, the call on them: posted on the PR, kept for its next
//                           worker, and requeued for a worker on the PR
//       start               let a held ticket start where nothing else will (desk-q's "let it start" command)
//       requeue             send a ticket whose worker stopped, or whose PR was closed unmerged, back to
//                           a worker (queue.mjs requeue)
//       drop                take a ticket whose PR was closed unmerged out of the batch (queue.mjs drop)
//       move "<batch>"      a parked or stopped ticket out of its batch and into another running batch of
//                           the repo (queue.mjs transfer), its next worker on that batch's base; a batch
//                           not running is refused, naming those that are
//       approve | reject "<note>"   a feature spine's specs (queue.mjs approve or reject)
//       override <id> "<choice>"    a decision its worker took (digest.mjs override)
//       not-now             put it off (the not-now register), asked again once its inputs change
//       open                a lane C or D park, or one on a step no worker is allowed (aws, curl, gh
//                           api, …): names the desk-ticket session to open; records nothing
//       admit               a ticket held by open tickets outside its batch that no batch holds: names
//                           the /desk-admit to run for them; records nothing
//       done                the person did the step themselves. On a PR it reads the PR from GitHub:
//                           merged is recorded and leaves the list; unmerged is said, and noted on the
//                           item until its head moves
//   needs-you.mjs left [<repo>]                       how many items desk-q still counts, and where passes stopped
//
// Two items are the repo's rather than a ticket's, and are named in place of one: `unset:<key>`, every
// ticket parked naming a §3 row the repo's config does not set (done requeues them once it is set), and
// `templates`, the repo's committed copies of desk's templates the supervisor found behind (done
// checks them again).
// Items are what desk-q's home screen counts as "◆ needs you", in order: a PRODUCTION BROKEN park
// first, then the longest waiting, less any put off with not-now whose inputs are unchanged and that
// offers no action it did not offer then. Exits 0, or 11 (show the person) on anything it refuses.
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gapsFix } from './fix-tries.mjs';
import { repoConfigValue, releaseCommand, repoPermissionUnset, PERMISSION_KEYS } from './desk-env.mjs';
import { readRecord as templatesRecord, check as templatesCheck } from './repo-templates.mjs';
import { isHeld, spinePark, planPark, openQuestion, sessionPark, neverStep, EXIT } from './batch-state.mjs';
import { loadRepos, shownRepos, holdOf, heldDraft, heldAsks, resolveRepo, resumeOf, needsSession, queueRun, checkoutOf, timeOf, needsRows, needText, prWhy, andList, capital, keysOf, triageOf, laneOf, usageHoldOf, stuckOf, worktreeBusy, worktreeBusyText } from './desk-q.mjs';
import { answer, override, readDecisions, openQuestions, PRODUCTION_BROKEN } from './digest.mjs';
import { addPutOff, putOffEntry, notNowPath, readRegister, lookup, changedLine } from './not-now.mjs';
import { batchHolding } from './batches.mjs';

// A question longer than this is cut on its line: the session asks it, not reads it in full.
const QUESTION_MAX = 240;
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
const digestList = (r) => [{ slug: r.slug, batch: r.batch ?? null, state: r.stateDir, queue: r.queuePath }];
// A draft the pass left for the person because the review verdict at its head has gaps (undraft.mjs
// verdictAt's `not clean (… gaps=N …)`), whatever its call: one whose fix tries ran out keeps `findings`.
const reviewGaps = (t) => t.pr_status?.isDraft === true && /not clean \([^)]*\bgaps=[1-9]/.test(String(t.undraft?.why ?? ''));
const prComment = (text) => `The person's call on this PR's review gaps, recorded through desk-needs-you:\n\n${text.split('\n').map((l) => `> ${l}`).join('\n')}\n\nA worker on this branch carries it out.`;

// ---- A PR item in the person's words: what is wrong, then what to do and what happens once they have.
// No commit SHA, fix try or review-verdict wording: those are the pass's, for its log. Recorded text
// quoted in one is cut short (clip), so the line's cut never takes what to do and what happens next.
const clip = (s, n = 80) => cut(one(s), n);
const plainWords = (s) => clip(one(s).replace(/\s*\bat [0-9a-f]{7,40}\b/g, '').replace(/\b[0-9a-f]{7,40}\b/g, 'its latest commit')
  .replace(/\s*after \d+ fix tr(?:y|ies)/g, '').replace(/\bfix tr(?:y|ies)\b/g, 'repair').replace(/\breview verdict\b/g, 'review'));
// Once the person's step is done: desk merges it where it may, else merging is theirs too.
const thenMerge = (r) => (r.ctx?.merges ? 'desk then merges it once its checks are green' : 'then merge it on GitHub once its checks are green');
const REPAIRED = "desk's own repairs did not fix";
// A draft fix-tries.mjs captureTry left stuck: the screenshots still not taken, then what its worker said.
const CAPTURE = /^(\d+) screenshot\(s\) still not taken after a capture try: (.+?)(?:; the capture try said: ([^]*))?$/;
// Those screens and the worker's reason, whole: the item's note, which listText never cuts.
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

function stuckPlain(r, n, s) {
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
    return `${n} is a draft, and desk's capture try could not take ${k === 1 ? 'one of its screenshots' : `${k} of its screenshots`}. Take ${k === 1 ? 'it' : 'them'} and upload ${k === 1 ? 'it' : 'them'} to the PR; the next pass then takes it out of draft.`;
  }
  // Before the conflict test: a review reason names the conflict tries it was made after.
  if (/^review not clean/.test(why)) return `${n}'s code review still has findings ${repairsMade(why) ?? REPAIRED}. Fix them on its branch and post a fresh review; ${thenMerge(r)}.`;
  if (/conflict/.test(why)) return `${n} is in conflict with ${r.ctx?.base ?? 'its base'}, and ${REPAIRED} it. Resolve the conflict on its branch; ${thenMerge(r)}.`;
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
    if (what) return `${n} is a draft, and its code review found ${what} that ${REPAIRED}. Fix them on its branch and post a fresh review; the next pass then takes it out of draft.`;
  }
  if (/Clean review verdict is not set/.test(why)) return `${n} is a draft, and desk can not read its code review because §4 Clean review verdict is not set. Set it with /desk-setup; the next pass then reads the review.`;
  if (/clean and green/.test(why)) return `${n} is a draft with a clean review and green checks. Undraft it; ${thenMerge(r)}.`;
  if (!u) return `${n} is a draft with no review recorded. Review it, then undraft it; ${thenMerge(r)}.`;
  return `${n} is a draft: ${plainWords(why.replace(/^its? /, ''))}. ${capital(plainWords(u.action ?? 'settle it'))}; the next pass then picks it up.`;
}

// An unmerged PR's need, from the reason desk-q has it need the person (prWhy).
function prPlain(r, t) {
  const n = `PR #${t.result.pr}`;
  const w = prWhy(r, t) ?? {};
  switch (w.code) {
    case 'closed': return `${n} was closed without merging, so nothing will merge it. Drop the ticket, or requeue it; a requeued ticket gets a worker that opens a new PR.`;
    case 'stuck': return stuckPlain(r, n, w.stuck);
    case 'spine': return `${n} is the feature spine, still a draft. Approve its acceptance specs; desk then takes it out of draft.`;
    case 'skipped': return `${n} is a draft, and CI does not run on drafts, so its checks were skipped. Undraft it so they run; ${thenMerge(r)}.`;
    case 'draft': return draftPlain(r, n, w.undraft);
    case 'hold': return `${n} touches files under a merge hold (${clip(w.text)}), so desk never merges it itself. Merge it on GitHub when you are ready; the ticket is then done.`;
    case 'feedback': return `${n} is green, but held for review: ${clip(w.text, 150)}. Resolve or answer it; desk then merges it.`;
    case 'conflict': return `${n} is in conflict with ${w.base}, and ${REPAIRED} it. Resolve the conflict on its branch; ${thenMerge(r)}.`;
    case 'red': return `${n} has ${w.names.length === 1 ? 'a failing check' : `${w.names.length} failing checks`}, ${andList(w.names.map((c) => `"${c}"`))}, and nothing here re-runs or repairs ${w.names.length === 1 ? 'it' : 'them'}. Fix or re-run ${w.names.length === 1 ? 'it' : 'them'}; ${thenMerge(r)}.`;
    case 'gate': return `${n} is not green: ${plainWords(w.text ?? 'a required check did not pass')}. Fix that check, or §4 Required checks if it should not be required; ${thenMerge(r)}.`;
    case 'green': return `${n} has ${w.checks === 1 ? 'its check' : `all ${w.checks} checks`} green${w.advisory ? ` (${w.advisory} advisory failed, which holds nothing)` : ''}, and desk may not merge in this repo. Merge it on GitHub; the ticket is then done.`;
    case 'running': return `${n}${w.checks ? `'s checks are still running (${w.done} of ${w.checks} done)` : ' has no checks reported yet'}, and desk may not merge in this repo. Merge it on GitHub once its checks are green; the ticket is then done.`;
    default: return `${n} is waiting on you. Settle it on GitHub; the next pass then picks it up.`;
  }
}

// What GitHub showed the last time the person said done on a PR, while its head is the one it showed.
// It is the item's `note`, which listText keeps whole when it cuts the need.
function doneNote(t) {
  const d = t.done_check;
  if (!d || (d.head ?? null) !== (t.pr_status?.head ?? null)) return '';
  const shown = d.state === 'CLOSED' ? 'closed without merging' : `unmerged${d.draft ? ', still a draft' : ''}`;
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

// The other batches of r's repo a parked or stopped ticket can be moved into, as queue.mjs transfer
// judges them (queue.mjs running, in that repo's checkout). -> [{ name, base, word }], the standing
// batch's name null.
const MOVABLE = ['parked', 'stopped'];
export function moveTargets(r) {
  try {
    const q = queueRun(r, ['running'], checkoutOf(r, 'list its batches'));
    return q.ok ? JSON.parse(q.out).map((b) => ({ ...b, word: b.name ?? 'standing' })) : [];
  } catch { return []; /* no checkout to ask in: nothing to offer */ }
}
const targetsText = (ts) => ts.map((b) => `${b.word} (on ${b.base})`).join(', ');
const moveAction = (r) => { const ts = moveTargets(r); return ts.length ? [['move', null, `move <batch> takes it out of this batch and queues it in another, its next worker on that base: ${targetsText(ts)}`]] : []; };

// The open blockers outside its batch the last pass recorded for a ticket (pass.mjs outside_blockers),
// each with its Jira status category and the batch of this repo holding it: `standing`, a named
// batch, or null for none. A key two batches hold reads as held, so it is never offered to admit.
const CATEGORY = { new: 'to do', indeterminate: 'in progress', done: 'done' };
function outsideHolds(r, t) {
  return (Array.isArray(t.outside_blockers) ? t.outside_blockers : []).map((b) => {
    let at;
    try { at = batchHolding(b.key, r.slug); } catch { at = { name: 'more than one batch' }; }
    return { key: b.key, category: b.category ?? 'new', batch: at ? (at.name ?? 'standing') : null };
  });
}
const holdWords = (o) => `${o.key} (${CATEGORY[o.category] ?? o.category}, ${o.batch ? `in batch ${o.batch}` : 'in no batch'})`;
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

// One item's kind, its one-line need and its actions, the recommended one first with its reason.
function itemOf(r, x) {
  const t = x.t;
  if (x.usage) return { kind: 'usage', need: usageHoldOf(r), actions: [['done', 'it lifts by itself; switch subscription to lift it sooner, then say done'], ['not-now']] };
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
    if (reviewGaps(t)) return { kind: 'pr', need, note, actions: [['answer', 'say how to settle its review gaps; it is posted on the PR and a worker on the PR carries it out'], ['done'], ['not-now']] };
    // A step off GitHub (a build, a staging migration) has no recommendation: its need names the step,
    // and the item leaves the list once every check it is still stuck on is green.
    const outside = stuck?.outside ?? [];
    if (outside.length) {
      const checks = `${stuck.checks.map((c) => `"${c.name}"`).join(', ')} ${stuck.checks.length === 1 ? 'is' : 'are'} green`;
      return { kind: 'pr', need, note, actions: [['done', null, `the step is outside GitHub (${outside.map((c) => c.command).join('; ')}); it drops off once ${checks}`], ['not-now']] };
    }
    return { kind: 'pr', need, note, actions: [['done', 'only you can do this step; say done once you have, and the PR is checked on GitHub there and then'], ['not-now']] };
  }
  // A worktree the pass will not spawn into (desk-q worktreeBusy): only the person, or the session in
  // it, makes it clean, and the pass drops the record once it is.
  const wb = worktreeBusy(t);
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
    if (planPark(t)) return { kind: 'plan', need, actions: [['answer', 'say start, discard, or the edit to make; the supervisor acts on it at its next tick: an edit is applied and the batch starts, and one it cannot apply comes back here naming why'], ['not-now']] };
    const sp = spinePark(t);
    if (sp === 'approval') return { kind: 'spine', need, actions: [['approve', 'its acceptance specs passed the spec check'], ['reject'], ['not-now']] };
    if (sp === 'specs') return { kind: 'spine', need, actions: [['reject', 'its acceptance specs failed the spec check, so it goes back with what to fix'], ['not-now']] };
    if (sessionPark(parkText(r, t))) return { kind: 'session', need, actions: [['open', sessionWhy(parkText(r, t))], ['not-now']] };
    if (needsSession(t)) return { kind: 'session', need, actions: [['open', `lane ${t.lane ?? 'C or D'}: only an interactive desk-ticket session takes it on`], ['not-now']] };
    if (triagePark(t)) return { kind: 'session', need, actions: [['open', 'parked at triage: it needs splitting or its links fixing, which a requeue cannot do'], ['not-now']] };
    const { taken, overrides } = readDecisions(r.stateDir);
    const overridden = new Set(overrides.map((o) => o.override_of));
    const offer = taken.filter((d) => d.ticket === t.key && !overridden.has(d.id)).slice(-DECISIONS_SHOWN).reverse()
      .map((d) => [`override ${d.id}`, null, `took "${cut(one(d.chose), 40)}" on "${cut(one(d.question), 60)}"`]);
    // No bare answer: it would leave the ticket parked, and desk-q still counting it.
    return { kind: 'parked', need, actions: [['resume', `lane ${laneOf(t, triageOf(r.stateDir, t.key))}: a worker finishes it once it has your answer`], ['not-now'], ...moveAction(r), ...offer] };
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
  const inputs = { ticket: t.key };
  if (item.kind === 'pr') inputs['pr-head'] = t.pr_status?.head ?? '';
  else inputs.need = item.need;
  const blockers = blockerStates(r, t);
  if (blockers || item.kind === 'held') inputs.blockers = blockers;
  return { question: `${t.key} ${item.kind}`, inputs };
}

// A needs row as an item, and what the not-now register says of it: the one rule desk-q's count and
// this list both go by. An item put off with unchanged inputs is asked again once it offers an action
// it did not offer then; an entry that recorded none is asked again once, and records them.
function judged(r, x, register) {
  const item = itemOf(r, x);
  const l = lookup(register, putOffKey(r, x.t, item));
  if (l.status !== 'put_off') return { item, l };
  const was = Array.isArray(l.entry.actions) ? l.entry.actions : null, now = verbsOf(item);
  if (was && now.every((a) => was.includes(a))) return { item, l };
  return { item, l: { status: 'changed', entry: l.entry, line: changedLine(l.entry, [`actions ${was ? was.join(', ') : '(not recorded)'} → ${now.join(', ')}`]) } };
}

// desk-q's NEEDS YOU count for a batch, or for a repo row of several (each row keyed in its own batch,
// `b`): the rows that need the person (`rows`, `shown` of them), less `putOff`, those put off with
// unchanged inputs.
export function needsCount(r) {
  const registers = new Map();
  const rows = [];
  let putOff = 0;
  for (const x of needsRows(r)) {
    const b = x.b ?? r;
    if (!registers.has(b.stateDir)) registers.set(b.stateDir, readRegister(b.stateDir));
    if (judged(b, x, registers.get(b.stateDir)).l.status === 'put_off') putOff++; else rows.push(x);
  }
  return { shown: rows.length, putOff, rows };
}

// The batches `word` names, else every batch desk-q's home screen shows.
const scopeOf = (repos, word) => (word ? batchesNamed(repos, word) : { named: null, scope: shownRepos(repos, false) });

// Every item desk-q counts as needing the person, in the batches `word` names (all when null), less
// those put off with unchanged inputs (`putOff` counts them). One whose inputs changed says what did.
// A usage-limit hold is an item here, but not in desk-q's count.
export function collect({ word = null, now = Date.now(), repos = loadRepos(now) } = {}) {
  const { named, scope } = scopeOf(repos, word);
  const items = [];
  let putOff = 0;
  const seen = new Map();
  const unsetIn = (slug, k) => { const id = `${slug}\t${k}`; if (!seen.has(id)) seen.set(id, repoPermissionUnset(slug, k)); return seen.get(id); };
  const groups = new Map();
  for (const r of scope.filter((x) => !x.error && x.q)) {
    const register = readRegister(r.stateDir);
    const hold = usageRow(r);
    for (const x of [...(hold ? [hold] : []), ...needsRows(r)]) {
      const { item, l } = judged(r, x, register);
      if (l.status === 'put_off') { putOff++; continue; }
      const since = x.usage ? timeOf(r.q.usage_hold.since) : timeOf(x.t.park?.since ?? x.t.added_at);
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
  // The repo-level items, put off under their own key as any other item is.
  const repoItem = (r, t, item, since) => {
    const key = putOffKey(r, t, item);
    const l = lookup(readRegister(r.stateDir), key);
    if (l.status === 'put_off') { putOff++; return; }
    if (l.status === 'changed') item.need = `${item.need} (${l.line})`;
    items.push({ r, t, ...item, putOffKey: key, since, broken: false });
  };
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
    // A done note follows the need whole: it is what GitHub showed when the person last said done.
    const need = `${cut(i.need, QUESTION_MAX)}${i.note ? ` ${i.note}` : ''}`;
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
  if (ticket.startsWith(UNSET) || ticket === TEMPLATES) return recordRepoItem({ word, ticket, action, now, repos });
  // A ticket is in one batch at most, so the batch named that holds it is the one its answer goes to.
  const { named, scope } = batchesNamed(repos, word);
  const r = scope.find((b) => b.q?.tickets?.[ticket]) ?? named;
  const x = !r.q ? null : ticket === USAGE_ITEM ? usageRow(r) : needsRows(r).find((y) => y.t.key === ticket);
  if (!x) return { ok: false, line: `${r.name} ${ticket}: desk-q does not count it as needing you, so nothing was recorded.` };
  const item = itemOf(r, x);
  const [verb, id] = action.split(/\s+/);
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
    const fix = { ...gapsFix({ pr, head: x.t.pr_status?.head, answer: text }), at: new Date(now).toISOString() };
    const f = queueCmd(r, ['set', ticket, `fix=${JSON.stringify(fix)}`]);
    if (!f.ok) return say(false, `posted on PR #${pr} and in its briefing, but its fix was refused: ${f.out}`);
    const q = queueCmd(r, ['requeue', ticket]);
    if (!q.ok) { queueCmd(r, ['set', ticket, 'fix=null']); return say(false, `posted on PR #${pr} and in its briefing, but the requeue was refused: ${q.out}`); }
    return say(true, `posted on PR #${pr}, kept for its next worker and requeued; the next pass sends it to a worker on the PR.`);
  };
  // Done on a PR: read it from GitHub now. Merged is recorded (the next pass records the merge in full,
  // as it does any merge) and leaves the list; anything else is said, and noted on the item.
  const prDone = () => {
    const pr = x.t.result.pr;
    const repo = repoConfigValue(r.slug, 'gh-repo') ?? r.slug.replace('__', '/');
    let v = null, err = '';
    try { v = JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'state,mergedAt,isDraft,headRefOid'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch (e) { err = one(e.stderr || e.message); }
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
    const check = { at: new Date(now).toISOString(), state: v.state, draft: v.isDraft === true, head: v.headRefOid ?? null };
    const shows = v.state === 'CLOSED' ? 'closed without merging' : `unmerged${check.draft ? ', still a draft' : ''}`;
    const m = queueCmd(r, ['set', ticket, `done_check=${JSON.stringify(check)}`]);
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
      const a = ans();
      if (!a.ok) return say(false, a.why);
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
    case 'approve': { const q = queueCmd(r, ['approve', ticket]); return q.ok ? say(true, `spine approved: ${q.out}`) : say(false, q.out); }
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
        const l = lookup(readRegister(r.stateDir), putOffKey(r, x.t, item));
        if (l.entry) addPutOff({ ...l.entry, actions: verbsOf(item) }, r.stateDir);
        return say(true, 'put off (not-now register).');
      }
      addPutOff(putOffEntry({ ...putOffKey(r, x.t, item), ticket, at: new Date(now).toISOString(), actions: verbsOf(item) }), r.stateDir);
      return say(true, `put off (${notNowPath(r.stateDir)}).`);
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

// A repo-level item's answer. Done on an unset row requeues every ticket parked on it once the row is
// set, each in its own batch (or names the live session to message); done on behind templates checks
// the copies again now.
function recordRepoItem({ word, ticket, action, now, repos }) {
  const c = collect({ word, now, repos });
  let i = c.items.find((y) => y.repoLevel && y.t.key === ticket);
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
    addPutOff(putOffEntry({ ...i.putOffKey, ticket, at: new Date(now).toISOString() }), i.r.stateDir);
    return say(true, `put off (${notNowPath(i.r.stateDir)}).`);
  }
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
    } else refuse('usage: needs-you.mjs list [<repo>] | record <repo> <TICKET> <action> ["<text>"] | left [<repo>]');
  } catch (e) { refuse(e.message); }
}
