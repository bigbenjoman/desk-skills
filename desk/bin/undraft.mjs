// Stage 7's undraft rule, scripted, so a batch nobody is watching undrafts exactly what a session would
// (desk-autopilot references/merging.md, Stage 7, "Undraft only once the PR is done and reviewed with no findings").
// pass.mjs reads each done ticket's open draft PR and asks undraftCall what to do with it:
//
//   ready   every fact holds and config §3 pr-ready allows it: gh pr ready, then the merge driver
//           merges it once it is green
//   wait    nothing for anyone to do yet: checks still running, or GitHub has not worked out whether
//           the head conflicts with its base (it reports UNKNOWN until it has, after every base move)
//   rerun   every red check was cancelled or timed out, so it never tested the code: where §3 ci-rerun
//           is yes the pass reruns `runs` through rerun.sh, within the merge driver's per-head cap
//           and cooldown (`gate` is what rerun.sh reads)
//   build   every red check is one §4 Check builds names, and no build has run at this head: the pass
//           starts its command on the host, in the ticket's worktree at the head (check-build.mjs)
//   rebuilt that build succeeded: the pass re-runs the checks' runs with --failed, once per head
//   evidence  screenshot cells are left and §4 Evidence workflow names the workflow that fills them:
//           the pass starts it, once per head (evidence.mjs), and the next pass reads the body again
//   person  it stays draft until the person acts; `action` is what they do, `why` says why
//   held    (personHold, read by the pass before acting on any other call) a person put it back to
//           draft: it stays draft, and nothing undrafts it or sends it to a worker until they undraft it
//   review  no review verdict the pass can read is at its head (none posted, one it cannot read, or
//           one for an older head that more than merges of the base have moved past), or desk-gate's
//           verdict check alone is red, as it is on a carried verdict: the pass sends
//           it to a review worker (fix-tries.mjs reviewTry), and to the person once no try is left
//   checks  a required check is red: the pass sends it to a fix worker (fix-tries.mjs draftChecksFix),
//           and to the person once no try is left; `failing` is the gate's failing checks
//   findings  the review at its head found a P0 or a P1, or a requirement gap where §3
//           autopilot-judgement is yes (cfg.judgement): the pass sends those to a fix worker
//           (fix-tries.mjs reviewFix), and only once no try is left, or the review lists none of them
//           (a P0 or P1 by file:line in its body or inline comments, a gap under its gaps heading), does
//           it put them to the person (`why` and `action` say what for)
//   conflict  the head conflicts with its base and §3 pr-conflict-unreviewed (no one but the person's
//           handle has reviewed or commented) or pr-conflict-reviewed (someone has) is `yes`: the pass
//           sends it to a fix worker (fix-tries.mjs conflictFix), and to the person once no try is left
//
// The facts, in order: the review verdict on the PR's current head reads as §4 Clean review verdict
// (none with §4 Local review command `none`, so reviewing is the person's call; a row of plain text such
// as `no findings` reads as plainVerdictAt says, and an unset row is the person's), the head has no merge
// conflict (GitHub says MERGEABLE), the checks are green (gate.mjs's one definition; checks a workflow
// skips on a draft leave the undraft to the person once the rest holds), the screenshots are in the body (none
// the pass could not upload, no `_drag <file>_` placeholder left), and only then the grant: §3 pr-ready `yes`, or `ask` with the
// batch's Stage 3 approval (queue approved.undraft). A feature spine is never undrafted here:
// queue.mjs approve does that once the person has approved its specs. A `ready` call carries the
// verdict it read, for the comment the PR gets on leaving draft (undraftComment), and `carried`, the
// commit that verdict was posted on when it was carried to the head (verdictCarries).
import { evaluateGate, skippedOnly, SKIPPED_ON_DRAFT, isHuman } from './gate.mjs';
import { RERUNS_MAX } from './fix-tries.mjs';
import { dragCells, hasEvidenceBlock } from './evidence.mjs';
// The review gate's own parser, so the pass and a repo's desk-gate read a verdict the same way.
// install.sh installs it at this same relative path; /desk-setup copies it into each repo.
import { parseVerdict as gateVerdict, LOCAL_MARKER } from '../templates/scripts/desk/review-gate.mjs';
// The name of desk-gate.yml's verdict job, the check that runs review-gate.mjs verdict.
export const VERDICT_CHECK = 'desk-review verdict';

// key=value pairs, as the §4 Clean review verdict row writes them.
export function pairs(text) {
  return Object.fromEntries([...String(text ?? '').matchAll(/([a-z0-9_]+)=(\S+)/gi)].map((m) => [m[1], m[2]]));
}

// A posted desk-review's verdict as the review gate reads it, or null. Values are strings, in
// marker order, as the §4 Clean review verdict row compares them; the heading is left out.
export function parseVerdict(body) {
  const v = gateVerdict(String(body ?? ''));
  if (!v) return null;
  const { heading, ...marker } = v;
  return Object.fromEntries(Object.entries(marker).map(([k, x]) => [k, String(x)]));
}

// The reviews among `reviews` (gh pr view --json reviews: oldest first) that `handle` posted: on a
// public repo anyone can post a review, and only the person's own attests it.
function ownReviews(reviews, handle) {
  return (reviews ?? []).filter((r) => handle && r.author?.login?.toLowerCase() === handle.toLowerCase());
}

// The latest review carrying a verdict among the reviews `handle` posted, as { verdict, body, id }, or
// null. The body and the id (its GraphQL node id, for its inline comments) are for the findings it lists.
export function latestReview(reviews, handle) {
  return ownReviews(reviews, handle).map((r) => ({ verdict: parseVerdict(r.body), body: r.body, id: r.id ?? null })).filter((r) => r.verdict).pop() ?? null;
}

// What the verdict says about this head: { clean, why, settle } (settle: the verdict is at the head,
// so what is left is its findings or gaps, not a review). Nothing deferred and no requirement gaps,
// whatever the §4 row lists.
export function verdictAt(v, head, clean) {
  if (!v) return { clean: false, why: 'no desk-review verdict is posted on it' };
  if (!head || !head.startsWith(v.sha)) return { clean: false, why: `its review verdict is for ${v.sha.slice(0, 9)}, not the head ${String(head ?? '?').slice(0, 9)}` };
  const want = { ...pairs(clean), deferred: '0', gaps: '0' };
  const off = Object.entries(want).filter(([k, x]) => v[k] !== x).map(([k]) => `${k}=${v[k] ?? '?'}`);
  if (off.length) return { clean: false, settle: true, why: `its review verdict at ${v.sha.slice(0, 9)} is not clean (${off.join(' ')})` };
  return { clean: true, why: null };
}

// A §4 Clean review verdict that is plain text (`no findings`, as the config template offers) names no
// counts. A desk-review verdict marker is then read against every count desk-review writes. A review
// with no marker is clean when it is the latest at the head, a line of it opens with the value as its
// outcome, it states that nothing is deferred or carried, and no line defers, carries or counts an item.
export const DESK_REVIEW_CLEAN = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0';
const LEFT = '(?:defer(?:s|red|ring|rals?)?|carr(?:y|ies|ied|ying))';
const LEFT_OVER = new RegExp(`\\b${LEFT}\\b`, 'i');
// "nothing deferred or carried", "no items carried", "nothing to defer", "deferred: none", "carried 0",
// but not "deferred: no timeout on retries", which defers an item whose name starts with "no".
const NOTHING_LEFT = new RegExp(`\\b(?:no|nothing|none|zero|0)\\s+(?:(?:items?|findings?|issues?|is|are|was|were|has|have|been|to)\\s+){0,2}${LEFT}(?:\\s+(?:or|and|nor)\\s+${LEFT})?\\b|\\b${LEFT}\\s*(?:items?|findings?)?\\s*[:=]?\\s*(?:none|nothing|no|0)(?=\\s*(?:[.;,)]|$))`, 'gi');
// "1 finding", "2 P1s", "3 open issues": a count of items the review still holds open.
const OPEN = /\b[1-9]\d*\s+(?:(?:blocking|open|new|unresolved)\s+)?(?:p[0-3]s?|findings?|issues?|blockers?|problems?)\b/i;
const plainLines = (body) => String(body ?? '').split(/\r?\n/).map((l) => l.replace(/^[\s>*#_-]+/, '').replace(/[*_`]/g, '').trim());

// The lines of a plain review that defer, carry or count an open item, cut to a readable length.
export function leftOver(body) {
  return plainLines(body).filter((l) => LEFT_OVER.test(l.replace(NOTHING_LEFT, '')) || OPEN.test(l))
    .map((l) => (l.length > 80 ? `${l.slice(0, 79)}…` : l));
}

// What the latest of `handle`'s reviews says about this head, under a plain-text §4 row (`clean`):
// { clean, why, settle, verdict }. A review with an empty body (GitHub records one for a reply to an
// inline comment) says nothing and is passed over.
export function plainVerdictAt(reviews, handle, head, clean) {
  const r = ownReviews(reviews, handle).filter((x) => String(x.body ?? '').trim()).pop();
  if (!r) return { clean: false, why: `no review stating "${clean}" is posted on it` };
  const v = parseVerdict(r.body);
  if (v) return { ...verdictAt(v, head, DESK_REVIEW_CLEAN), verdict: v };
  // A desk-review whose marker the review gate cannot read is no verdict, never a plain review.
  if (String(r.body).split(/\r?\n/)[0].trim() === LOCAL_MARKER) return { clean: false, why: 'its desk-review verdict marker is not one the review gate reads' };
  const at = r.commit?.oid ?? '';
  if (!at || !head || !head.startsWith(at)) return { clean: false, why: `its latest review is for ${at ? at.slice(0, 9) : 'an unknown commit'}, not the head ${String(head ?? '?').slice(0, 9)}` };
  const c = clean.toLowerCase();
  const stated = plainLines(r.body).find((l) => l.toLowerCase().startsWith(c) && /^(?:[.!]|$)/.test(l.slice(c.length)));
  if (!stated) return { clean: false, settle: true, why: `its latest review, at ${at.slice(0, 9)}, does not open a line with "${clean}" as its outcome` };
  const left = leftOver(r.body);
  if (left.length) return { clean: false, settle: true, why: `its review at ${at.slice(0, 9)} states "${clean}" but leaves items open, deferred or carried: ${left.map((l) => `"${l}"`).join('; ')}` };
  if (!plainLines(r.body).some((l) => l.replace(NOTHING_LEFT, '') !== l)) return { clean: false, settle: true, why: `its review at ${at.slice(0, 9)} states "${clean}" but not that nothing is deferred or carried` };
  return { clean: true, why: null, verdict: stated };
}

// Whether a review verdict posted on `from` still holds at `head`: `head` is reached from `from` by
// merges of the base alone, each a two-parent merge whose second parent is on `base` and whose tree
// is exactly the one git merges the two to (git merge-tree), so it resolved no conflict and added
// nothing, and the PR's own commits are the ones reviewed. git(args) runs git and returns { ok, out };
// false whenever git cannot say.
export function verdictCarries({ from, head, base, git }) {
  const chain = baseMergeChain({ from, head, base, git });
  return !!chain && chain.every(([c, ours, theirs]) => {
    const merged = git(['merge-tree', '--write-tree', '--no-messages', ours, theirs]);
    const tree = git(['rev-parse', `${c}^{tree}`]);
    return merged.ok && tree.ok && merged.out.split('\n')[0] === tree.out;
  });
}

// The first-parent chain from `from` down to `head`, newest first, as [commit, ours, theirs, …] each;
// null when `head` does not descend from `from` that way, or whenever git cannot say.
function firstParentChain({ from, head, base, git }) {
  if (!from || !head || !base) return null;
  const at = git(['rev-parse', '--verify', '--quiet', `${from}^{commit}`]);
  if (!at.ok || !git(['merge-base', '--is-ancestor', at.out, head]).ok) return null;
  const r = git(['rev-list', '--first-parent', '--parents', `${at.out}..${head}`]);
  const chain = r.ok ? r.out.split('\n').filter(Boolean).map((l) => l.split(' ')) : [];
  // The first-parent chain must come down to `from` itself, not pass it on a side branch.
  return chain.length && chain[chain.length - 1][1] === at.out ? chain : null;
}
// A two-parent merge whose second parent is on `base`.
const isBaseMerge = ([, , theirs, ...more], base, git) => !!theirs && !more.length && git(['merge-base', '--is-ancestor', theirs, base]).ok;

// That chain when every commit on it is a merge from the base; null otherwise.
function baseMergeChain({ from, head, base, git }) {
  const chain = firstParentChain({ from, head, base, git });
  return chain && chain.every((c) => isBaseMerge(c, base, git)) ? chain : null;
}

// Whether a merge from the base, conflicts resolved or not, last moved `head` since `from`: the newest
// commit on the chain is one. Commits of the PR's own before it (a fix try's worker's) do not matter:
// the head it leaves is what the base merge moved.
export const movedByBase = ({ from, head, base, git }) => {
  const chain = firstParentChain({ from, head, base, git });
  return !!chain && isBaseMerge(chain[0], base, git);
};

// The comment on a PR the pass took out of draft: why, and the verdict it read, quoted (a plain
// review's line stating the §4 value, as a string). `carried` is the commit the verdict was posted on
// when it was carried to this head.
export function undraftComment(verdict, head, clean, carried = null) {
  const line = typeof verdict === 'string' ? verdict : Object.entries(verdict ?? {}).map(([k, x]) => `${k}=${x}`).join(' ');
  const what = typeof verdict === 'string' ? 'review' : 'desk-review verdict';
  const short = (sha) => `\`${String(sha ?? '').slice(0, 12)}\``;
  if (carried) {
    return `Out of draft: the ${what} posted on ${short(carried)} is clean under §4 Clean review verdict (\`${clean}\`), and it holds on this head (${short(head)}): every commit since is a clean merge of the base.\n\n> \`${line}\``;
  }
  return `Out of draft: the ${what} posted on this head (${short(head)}) is clean under §4 Clean review verdict (\`${clean}\`).\n\n> \`${line}\``;
}

// A red gate whose every failing check was cancelled or timed out: a `rerun` call while §3 ci-rerun is
// yes and a rerun is left at this head, `wait` while other checks still run or through the last
// rerun's cooldown, else null (a check that failed, or no rerun left, is not green as ever, and its
// why says how many reruns were spent). A rerun call carries the gate as rerun.sh reads it.
const INTERRUPTED = new Set(['cancelled', 'timed_out']);
function rerunCall(gate, cfg) {
  const failing = gate.failing;
  if (cfg.rerun !== 'yes' || !failing.length || failing.some((f) => !INTERRUPTED.has(f.conclusion))) return null;
  if (failing.some((f) => (cfg.reruns?.(f.name) ?? 0) >= RERUNS_MAX)) return null;
  const runs = [...new Set(failing.map((f) => f.runId).filter(Boolean).map(String))];
  if (!runs.length) return null;
  if (gate.pending.length) return { call: 'wait', why: `checks still running (${gate.pending.join(', ')}) beside cancelled or timed-out ones, re-run once they finish` };
  const what = failing.map((f) => `"${f.name}" ${f.conclusion}`).join('; ');
  if (cfg.cooledDown === false) return { call: 'wait', why: `checks re-run after they were cancelled or timed out (${what}), waiting out the rerun's cooldown` };
  return {
    call: 'rerun', why: `its checks were cancelled or timed out, so they are re-run: ${what}`, runs,
    gate: { pending: [], failedRuns: runs, reasons: gate.reasons, failing: failing.map((f) => ({ name: f.name, runId: f.runId ? String(f.runId) : null })) },
  };
}

// A red gate whose every failing check §4 Check builds names (cfg.builds, [{ name, command }]), while
// §3 ci-rerun is yes: the build that clears it, once per head (cfg.built(head), check-build.mjs
// buildRecord). `build` starts it, `wait` while it or another check runs, `rebuilt` re-runs the checks with --failed once
// it succeeded, and `person` when it failed, its re-run was refused, or the checks are still red after
// it. Anything else is null, handled as any red check.
function buildCall(gate, cfg, n, head) {
  const builds = new Map((cfg.builds ?? []).map((b) => [b.name, b.command]));
  const failing = gate.failing;
  if (cfg.rerun !== 'yes' || !builds.size || !failing.length || failing.some((f) => !builds.has(f.name))) return null;
  const names = [...new Set(failing.map((f) => f.name))];
  const checks = names.map((x) => `"${x}"`).join(', ');
  if (gate.pending.length) return { call: 'wait', why: `checks still running (${gate.pending.join(', ')}) beside ${checks}, which §4 Check builds clears once they finish` };
  const at = String(head ?? '?').slice(0, 9);
  const rec = cfg.built?.(head) ?? null;
  const command = rec?.command ?? [...new Set(names.map((x) => builds.get(x)))].join(' && ');
  const runs = [...new Set(failing.map((f) => f.runId).filter(Boolean).map(String))];
  if (!rec) return { call: 'build', why: `${checks} red at ${at}, which §4 Check builds clears: \`${command}\` runs at the head, then the check is re-run`, command, checks: names, runs };
  if (rec.state === 'running') return { call: 'wait', why: `its check build \`${command}\` is running at ${at}, then ${checks} is re-run` };
  if (rec.code !== 0) {
    const exit = rec.code == null ? 'stopped before it finished' : `exited ${rec.code}`;
    return { call: 'person', why: `its check build \`${command}\` ${exit} at ${at}${rec.tail ? `: ${rec.tail}` : ''}`, action: `fix the build, run it at the head of #${n}, then re-run ${checks}` };
  }
  if (!rec.reran) return { call: 'rebuilt', why: `its check build \`${command}\` ran at ${at}, so ${checks} is re-run`, checks: names, runs };
  if (!rec.reran.ok) return { call: 'person', why: `its check build \`${command}\` ran at ${at}, but the re-run of ${checks} was refused: ${rec.reran.out}`, action: `re-run ${checks} on #${n}` };
  return { call: 'person', why: `${checks} is still red at ${at} after its check build \`${command}\` ran and the check was re-run`, action: `fix ${checks} on #${n}` };
}

// A body with `_drag <file>_` cells left and a fenced ```evidence block, where §4 Evidence workflow
// names the workflow that fills them (cfg.evidence, evidence.mjs), once per head (cfg.evidenceRun(head)):
// `evidence` starts it, `wait` while it runs, and `person` once it has run and cells are still left.
// Anything else is null: the cells are the person's, as before.
function evidenceCall(pr, cfg) {
  const wf = cfg.evidence?.workflow;
  if (!wf || !hasEvidenceBlock(pr.body)) return null;
  const n = pr.number;
  const at = String(pr.head ?? '?').slice(0, 9);
  const left = dragCells(pr.body);
  const rec = cfg.evidenceRun?.(pr.head) ?? null;
  if (!rec) return { call: 'evidence', why: `${left} screenshot cell(s) left at ${at}, which §4 Evidence workflow \`${wf}\` fills`, workflow: wf };
  if (rec.state === 'running') return { call: 'wait', why: `its evidence workflow \`${wf}\` is taking the screenshots at ${at}${rec.url ? ` (${rec.url})` : ''}` };
  return {
    call: 'person', why: `its evidence workflow \`${wf}\` ran at ${at} (${rec.conclusion}${rec.url ? `, ${rec.url}` : ''}) and left ${left} screenshot cell(s)`,
    action: `fill the cells it could not on #${n}, or fix its \`evidence\` block and re-run \`gh workflow run ${wf} -f pr=${n}\``,
  };
}

// Whether anyone but `handle`, and not a bot, has reviewed or commented on the PR: the line between
// §3 pr-conflict-unreviewed and pr-conflict-reviewed. With no handle to tell them apart, everyone counts.
export function humanReviewed(pr, handle) {
  return [...(pr.reviews ?? []), ...(pr.comments ?? [])].some((x) => isHuman(x.author, handle));
}

// Whether a person holds a ticket's draft PR #n by having put it back to draft: { why, action }, or
// null. The pass's own undraft of #n (the ticket's `undraft` record says `ready`), or a hold already
// recorded, settles it with no read. Otherwise `redrafts` is the PR's convert_to_draft events,
// [{ at, by }] oldest first: nothing in a batch converts a ticket's PR back, so any one is a person's.
// REDRAFT_JQ reads them from the PR's issue events, one `<at>\t<by>` line each.
export const REDRAFT_JQ = '.[] | select(.event == "convert_to_draft") | [.created_at, (.actor.login // "")] | @tsv';
export function personHold(t, n, redrafts = []) {
  const was = t.undraft?.pr == null || t.undraft.pr === n ? t.undraft ?? {} : {};
  if (was.call === 'held') return { why: was.why, action: was.action };
  const last = redrafts.at(-1);
  if (was.call !== 'ready' && !last) return null;
  const how = last ? `${last.by ? ` by ${last.by}` : ''}${last.at ? ` at ${last.at}` : ''}` : ' after the pass undrafted it';
  return { why: `it was put back to draft${how}`, action: `undraft #${n} to release it; the merge driver then merges it once it is green` };
}

// t: the queue ticket. pr: { number, head, mergeState, mergeable, body, reviews, comments, checks, carry }
// (checks as pr_status keeps them; carry(sha), when given, says whether a verdict posted on sha holds at
// the head, as verdictCarries does). cfg: { spine, perm, approved, localReview, clean, handle, required,
// advisory, permKey, judgement, rerun (§3 ci-rerun), reruns(name) -> reruns tried at the head,
// cooledDown (the last rerun has had its gap), builds (§4 Check builds, parsed), built(head) -> the
// check build recorded at that head, evidence (§4 Evidence workflow, parsed), evidenceRun(head) -> the
// evidence run recorded at that head, missingShots(body) -> the files its `_drag <file>_` cells name that
// the ticket's screenshot directory does not hold, conflictUnreviewed, conflictReviewed (§3
// pr-conflict-unreviewed and -reviewed) }.
export function undraftCall(t, pr, cfg) {
  const n = pr.number;
  if (cfg.spine) return null;
  const person = (why, action = `undraft #${n} once that is settled`) => ({ call: 'person', why, action });
  if (/^none$/i.test(String(cfg.localReview ?? '').trim())) {
    return person('§4 Local review command is none, so there is no review verdict to read', `review #${n}, then undraft it`);
  }
  const clean = String(cfg.clean ?? '').trim();
  if (!clean || /^(todo|none)\b/i.test(clean)) {
    return person('§4 Clean review verdict is not set, so no review can be read as clean', 'set it with /desk-setup');
  }
  const plain = !Object.keys(pairs(clean)).length;
  if (!cfg.handle) return person('§1 GitHub handle is not set, so no review verdict can be attested', 'set it with /desk-setup');
  // A review at the head that found a P0 or a P1 is a code change for a fix worker, whatever else is
  // wrong with the PR: the pass sends it back (fix-tries.mjs reviewFix) with the review's body and
  // the inline comments it reads by the review's id.
  // Under a plain-text row the latest review may still be a desk-review verdict (plainVerdictAt reads
  // it against desk-review's own counts), and its P0s and P1s go the same way.
  const review = latestReview(pr.reviews, cfg.handle);
  const verdict = plain ? null : review?.verdict ?? null;
  let v = plain ? plainVerdictAt(pr.reviews, cfg.handle, pr.head, clean) : verdictAt(verdict, pr.head, clean);
  const found = plain ? (typeof v.verdict === 'object' ? v.verdict : null) : verdict;
  // A verdict for an older head that only merges of the base have moved past is read as at the head.
  let carried = null;
  if (!v.clean && !v.settle && found?.sha && pr.head && !pr.head.startsWith(found.sha) && pr.carry?.(found.sha)) {
    v = { ...verdictAt(found, found.sha, plain ? DESK_REVIEW_CLEAN : clean), ...(plain ? { verdict: found } : {}) };
    carried = found.sha;
  }
  const withCarried = (c) => (carried ? { ...c, carried } : c);
  // Under §3 autopilot-judgement yes, its requirement gaps go the same way: a worker makes the call.
  const gaps = cfg.judgement === 'yes' && Number(found?.gaps) > 0;
  if (v.settle && found && (Number(found.p0) > 0 || Number(found.p1) > 0 || gaps)) {
    return { ...person(v.why, `settle the ${gaps ? 'findings or gaps' : 'findings'} on #${n}`), call: 'findings', verdict: found, review: review.body, reviewId: review.id };
  }
  if (pr.mergeState === 'DIRTY' || pr.mergeable === 'CONFLICTING') {
    const c = person('it has a merge conflict with its base', `resolve the conflict on #${n}; it then needs a fresh review`);
    return (humanReviewed(pr, cfg.handle) ? cfg.conflictReviewed : cfg.conflictUnreviewed) === 'yes' ? { ...c, call: 'conflict' } : c;
  }
  if (pr.mergeable !== 'MERGEABLE') return { call: 'wait', why: `GitHub has not yet worked out whether it conflicts with its base (${pr.mergeable ?? 'no answer'})` };
  const gate = evaluateGate(pr.checks ?? [], { required: cfg.required ?? [], advisory: cfg.advisory ?? [] });
  if (gate.state === 'pending') return { call: 'wait', why: `checks still running (${gate.pending.join(', ')})` };
  // Checks a workflow skips on a draft never go green there, so only the person's undraft runs them.
  const skipped = gate.state !== 'pass' && skippedOnly(pr.checks);
  // A red check is a code change for a fix worker, and a head with no verdict to read is a review for a
  // review worker: the pass sends them there (fix-tries.mjs), and to the person once no try is left.
  // Cancelled or timed-out checks are re-run and §4 Check builds ones built first (above them here).
  // desk-gate's verdict check reads the review on the head, not the code, so no fix turns it green:
  // red alone, it is a review worker's (below), and beside other red checks the fix worker's review
  // after its fix clears it.
  const red = gate.state !== 'pass' && !skipped;
  if (red) {
    const rr = rerunCall(gate, cfg);
    if (rr) return rr;
    const bc = buildCall(gate, cfg, n, pr.head);
    if (bc) return bc;
  }
  const codeRed = gate.failing.filter((f) => f.name !== VERDICT_CHECK);
  if (red && (codeRed.length || !gate.failing.length)) {
    const spent = cfg.rerun === 'yes' && gate.failing.some((f) => (cfg.reruns?.(f.name) ?? 0) >= RERUNS_MAX) ? `, still after ${RERUNS_MAX} reruns at this head` : '';
    const notGreen = person(`its checks are not green: ${gate.reasons.join('; ')}${spent}`, `fix or re-run the checks on #${n}`);
    // A cancelled or timed-out run tested no code, so a fix worker has nothing to fix until its reruns are spent.
    if (!spent && codeRed.length && codeRed.every((f) => INTERRUPTED.has(f.conclusion))) return notGreen;
    return { ...notGreen, call: 'checks', failing: codeRed };
  }
  if (!v.clean && !v.settle) return { ...person(v.why, `review #${n} at its head`), call: 'review' };
  if (!v.clean) return person(v.why, `settle the findings or gaps on #${n}`);
  if (red) {
    const why = `its ${VERDICT_CHECK} check reads only a verdict posted on the head${carried ? `, and its verdict is carried from ${carried.slice(0, 9)}` : ''}`;
    return withCarried({ ...person(why, `review #${n} at its head`), call: 'review' });
  }
  const evidence = dragCells(pr.body) ? evidenceCall(pr, cfg) : null;
  // Cells §4 Evidence workflow does not fill and whose file was never taken go to a capture worker
  // (fix-tries.mjs captureTry); the person gets them only once its try is spent.
  const missing = evidence ? [] : cfg.missingShots?.(pr.body) ?? [];
  if (missing.length) {
    return { ...person(`${missing.length} screenshot(s) in its body were never taken: ${missing.join(', ')}`, `take ${missing.join(', ')} and upload them to #${n}`), call: 'capture', files: missing };
  }
  const unsent = t.images_uploaded === 'partial' || (t.images_reported === true && t.images_uploaded !== true);
  if (unsent) return person('its screenshots are not in the body yet (a `_drag <file>_` cell is left)', `upload the screenshots to #${n}`);
  if (dragCells(pr.body)) return evidence ?? person('its screenshots are not in the body yet (a `_drag <file>_` cell is left)', `upload the screenshots to #${n}`);
  if (skipped) return person(SKIPPED_ON_DRAFT, `undraft #${n}`);
  const read = plain ? v.verdict : verdict;
  if (cfg.perm === 'yes') return withCarried({ call: 'ready', why: null, note: null, verdict: read });
  if (cfg.perm === 'ask' && cfg.approved) {
    return withCarried({ call: 'ready', why: null, verdict: read, note: `- [${t.key}] undrafted #${n} at ${pr.head}: §3 ${cfg.permKey} is ask, batch approval given at Stage 3` });
  }
  return withCarried(person(`it is clean and green, and config §3 ${cfg.permKey} is "${cfg.perm}"${cfg.perm === 'ask' ? ' with no batch approval' : ''}`, `undraft #${n}`));
}
