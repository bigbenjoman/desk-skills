// Stage 7's undraft rule, scripted, so a batch nobody is watching undrafts exactly what a session would
// (desk-autopilot references/merging.md, Stage 7, "Undraft only once the PR is done and reviewed with no findings").
// pass.mjs reads each done ticket's open draft PR and asks undraftCall what to do with it:
//
//   ready   every fact holds and config §3 pr-ready allows it: gh pr ready, then the merge driver
//           merges it once it is green
//   wait    nothing for anyone to do yet: checks still running, or GitHub has not worked out whether
//           the head conflicts with its base (it reports UNKNOWN until it has, after every base move)
//   rerun   every red check was cancelled, timed out or ended by the runner (out of memory, killed or
//           lost), so it never tested the code: where §3 ci-rerun is yes the pass reruns `runs` through
//           rerun.sh, within the merge driver's per-head cap and cooldown, once for one the runner ended
//           (`gate` is what rerun.sh reads); or a check stuck pending whose run has
//           completed, re-run as that one job (stuckCall)
//   cancel  a check pending past PENDING_LIMIT_MS while its run is still in progress: the pass cancels
//           the run, once per check per head, so the next pass re-runs it as a cancelled check
//   build  every red check is one §4 Check builds names, and no build has run at this head: the pass
//           starts its command on the host, from its clean checkout of the default branch, with the
//           head as DESK_CHECK_HEAD and DESK_CHECK_TREE (check-build.mjs)
//   rebuilt that build succeeded: the pass re-runs the checks' runs with --failed, once per head
//   sync    that build failed at a head behind its base (cfg.behind): the pass sends it to a fix worker
//           that merges the base (fix-tries.mjs syncFix), and to the person once no try is left
//   evidence  screenshot cells are left and §4 Evidence workflow names the workflow that fills them:
//           the pass starts it, once per head (evidence.mjs), and the next pass reads the body again
//   evidence-failed  that run failed, or filled no cell: the pass groups the same failure across PRs
//           and starts one fix for the repo, which the PRs wait on (evidence.mjs evidenceFixPlan)
//   person  it stays draft until the person acts; `action` is what they do, `why` says why
//   held    (personHold, read by the pass before acting on any other call) a person put it back to
//           draft: it stays draft, and nothing undrafts it or sends it to a worker until they undraft it
//   review  no review verdict the pass can read is at its head (none posted, one it cannot read, or
//           one for an older head that more than merges of the base have moved past), or desk-gate's
//           verdict check alone is red, as it is on a carried verdict: the pass sends
//           it to a review worker (fix-tries.mjs reviewTry), and to the person once no try is left.
//           `targeted`, when set, is what an older clean review that did not carry still needs
//           read at the head (reviewScope), so that review worker reads only that
//   checks  a required check is red: the pass sends it to a fix worker (fix-tries.mjs draftChecksFix),
//           and to the person once no try is left; `failing` is the gate's failing checks
//   findings  the review at its head found a P0, a P1 or a listed P2 not deferred, or a requirement gap where §3
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
// commit that verdict was posted on when it was carried to the head (verdictCarries, or with the
// review-reuse lever on restsOnCarries, whose base range checked is `range`).
import { evaluateGate, latestPerCheck, skippedOnly, SKIPPED_ON_DRAFT, isHuman, PENDING_LIMIT_MS, since } from './gate.mjs';
import { RERUNS_MAX, runnerRerunsSpent, rerunGate, reviewFindings, syncSaid, captureTry } from './fix-tries.mjs';
import { dragCells, dragFiles, hasEvidenceBlock, runFailed } from './evidence.mjs';
import { isLockfile, isConfig } from './test-scope.mjs';
import { pairs } from './desk-env.mjs';
// The review gate's own parser, so the pass and a repo's desk-gate read a verdict the same way.
// install.sh installs it at this same relative path; /desk-setup copies it into each repo.
import { parseVerdict as gateVerdict, LOCAL_MARKER } from '../templates/scripts/desk/review-gate.mjs';
// The name of desk-gate.yml's verdict job, the check that runs review-gate.mjs verdict.
export const VERDICT_CHECK = 'desk-review verdict';

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

// The review verdict the handle has at this head, under a set §4 Clean review verdict row (`clean`), as
// the undraft and the merge driver both read it: { plain, review, verdict, found, carried, range, v }, v
// being what verdictAt or plainVerdictAt says. A verdict for an older head that still holds at this one
// (carry(sha, body), given the review's body: verdictCarries, or restsOnCarries with the review-reuse
// lever on) is read as at the head; `carried` names its commit, and `range` the base range checked when
// carry returns one. A clean one that does not hold there gets `targeted`, what scope(sha, body) says
// the head still needs read (reviewScope), when it says one.
export function verdictAtHead(reviews, handle, head, clean, carry, scope = null) {
  const plain = !Object.keys(pairs(clean)).length;
  const review = latestReview(reviews, handle);
  const verdict = plain ? null : review?.verdict ?? null;
  let v = plain ? plainVerdictAt(reviews, handle, head, clean) : verdictAt(verdict, head, clean);
  const found = plain ? (typeof v.verdict === 'object' ? v.verdict : null) : verdict;
  let carried = null, range = null, targeted = null;
  const older = !v.clean && !v.settle && found?.sha && head && !head.startsWith(found.sha);
  const held = older ? carry?.(found.sha, review?.body) : null;
  const was = older ? verdictAt(found, found.sha, plain ? DESK_REVIEW_CLEAN : clean) : null;
  if (held) {
    v = { ...was, ...(plain ? { verdict: found } : {}) };
    carried = found.sha;
    range = held.range ?? null;
  } else if (older && was.clean) targeted = scope?.(found.sha, review?.body) || null;
  return { plain, review, verdict, found, carried, range, targeted, v };
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

// The files a desk-review rests on, as verdict.mjs records them on a line of their own after the method
// marker: the files its seats read. null when the body records none, or not in that form.
const RESTS_ON = /^<!-- desk-review:rests-on v=1 files=(\[.*\]) -->$/m;
export function restsOn(body) {
  const m = RESTS_ON.exec(String(body ?? ''));
  if (!m) return null;
  try {
    const files = JSON.parse(m[1]);
    return Array.isArray(files) && files.length && files.every((f) => typeof f === 'string' && f) ? files : null;
  } catch { return null; }
}

// Whether a path is a dependency manifest, a lockfile or repo configuration, which every review rests
// on whatever its seats read: a change to one can change what the code does without touching it.
// test-scope.mjs owns lockfiles and test or build config, any root file but documentation included;
// these are the manifests and build files it does not name, wherever they sit, and any `*.config.*`.
// The same paths make a head that a base move reached need a whole review, not a targeted one.
const MANIFESTS = /^(?:requirements.*\.txt|go\.mod|Cargo\.toml|Gemfile|Pipfile|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|Makefile|Dockerfile.*|(?:docker-)?compose(?:\.[^.]+)?\.ya?ml|vercel\.json|.+\.lockb?|.+\.config\..+)$/;
export function restsOnAlways(path) {
  const p = String(path);
  const parts = p.split('/');
  const name = parts.at(-1);
  // Anything under a top-level dot directory (.github/**, .claude/**), or a dotfile anywhere.
  if (parts[0].startsWith('.') || name.startsWith('.')) return true;
  if (parts[0] === 'scripts' && parts[1] === 'desk') return true;
  return isLockfile(p) || isConfig(p) || MANIFESTS.test(name);
}

// How the base moved under a PR between a review posted on `from` and `head`, after a rebase or any
// merge of the base: { tip, range, now, moved }, `moved` the files the base changed between the two
// merge bases (`range`) and `now` the head's. null when the PR's own diff against the base changed (a
// file of the PR's own the base moved does too: its blob before the PR's change differs), or whenever
// git cannot say. git(args) runs git and returns { ok, out }.
function baseMove({ from, head, base, git }) {
  if (!from || !head || !base) return null;
  let at = git(['rev-parse', '--verify', '--quiet', `${from}^{commit}`]);
  // A rebased-away commit may not be local yet: GitHub serves it by its full SHA.
  if (!at.ok && /^[0-9a-f]{40}$/.test(from) && git(['fetch', '-q', 'origin', from]).ok) at = git(['rev-parse', '--verify', '--quiet', `${from}^{commit}`]);
  const tip = git(['rev-parse', '--verify', '--quiet', `${head}^{commit}`]);
  if (!at.ok || !tip.ok) return null;
  const was = git(['merge-base', at.out, base]);
  const now = git(['merge-base', tip.out, base]);
  if (!was.ok || !now.ok || !git(['merge-base', '--is-ancestor', was.out, now.out]).ok) return null;
  // Each changed file's modes and blobs, before and after: exact, and small on any size of PR.
  const own = (mb, tipSha) => git(['diff', '--raw', '--no-renames', '--no-abbrev', mb, tipSha]);
  const before = own(was.out, at.out);
  const after = own(now.out, tip.out);
  if (!before.ok || !after.ok || before.out !== after.out) return null;
  // NUL-separated, as git would otherwise quote a non-ASCII path and it would match no recorded file.
  const moved = git(['diff', '-z', '--no-renames', '--name-only', was.out, now.out]);
  if (!moved.ok) return null;
  return { tip: tip.out, now: now.out, range: `${was.out.slice(0, 12)}..${now.out.slice(0, 12)}`, moved: moved.out.split('\0').filter(Boolean) };
}

// Whether a review posted on `from` still holds at `head`, after a rebase or any merge of the base:
// the PR's own diff against the base is unchanged (baseMove), and the base moved past none of the
// files the review rests on (`files`, restsOn's list, and every restsOnAlways path). Returns { range }
// naming the base range checked, or null whenever any of that fails or git cannot say.
export function restsOnCarries({ from, head, base, files, git }) {
  if (!Array.isArray(files)) return null;
  const m = baseMove({ from, head, base, git });
  const rests = new Set(files);
  if (!m || m.moved.some((f) => rests.has(f) || restsOnAlways(f))) return null;
  return { range: m.range };
}

// The name a file is used by: its own less its extension, or for an index file its directory's.
const stemOf = (path) => {
  const parts = path.split('/');
  const name = parts.at(-1).replace(/\.[^.]*$/, '');
  return name === 'index' && parts.length > 1 ? parts.at(-2) : name;
};

// What a review posted on `from` that does not carry to `head` still needs read there: where the PR's
// own diff is unchanged and the base moved some of the files the review rests on (`files`) but no
// restsOnAlways path, only those files (`files`) and the PR's changed files that name one by its stem
// (`users`), the rest of the review holding. { from, range, files, users }, or null when the head
// needs a whole review: the PR's own diff changed, the base moved a lockfile, manifest or
// configuration file, the review records no files, or git cannot say.
export function targetedReview({ from, head, base, files, git }) {
  if (!Array.isArray(files)) return null;
  const m = baseMove({ from, head, base, git });
  if (!m || m.moved.some(restsOnAlways)) return null;
  const rests = new Set(files);
  const changed = m.moved.filter((f) => rests.has(f));
  if (!changed.length) return null;
  const own = git(['diff', '-z', '--no-renames', '--name-only', m.now, m.tip]);
  if (!own.ok) return null;
  const mine = own.out.split('\0').filter(Boolean);
  const stems = [...new Set(changed.map(stemOf).filter(Boolean))];
  let users = [];
  if (mine.length && stems.length) {
    // Literal pathspecs, as a PR file named `[id].tsx` would otherwise be read as a glob.
    const hit = git(['--literal-pathspecs', 'grep', '-z', '-l', '-I', '-F', ...stems.flatMap((s) => ['-e', s]), m.tip, '--', ...mine]);
    // git grep exits 1 when nothing matches, and says fatal or error only when it could not search.
    if (!hit.ok && /^(?:fatal|error):/m.test(hit.out)) return null;
    if (hit.ok) users = hit.out.split('\0').filter(Boolean).map((l) => l.slice(m.tip.length + 1));
  }
  return { from, range: m.range, files: changed, users };
}

// The narrowed review a head needs in place of a whole one, as the pass asks it beside the carry: only
// with the review-reuse lever on (`reuse`), from the files the review's `body` records; null otherwise.
export const reviewScope = ({ reuse, from, head, base, body, git }) => (reuse
  ? targetedReview({ from, head, base, files: restsOn(body), git })
  : null);

// Whether a review posted on `from` holds at `head`, as every carry reads it, so the pass and the merge
// driver never disagree: with the review-reuse lever on (`reuse`), only while the files it rests on
// (from the review's `body`) are unchanged (restsOnCarries); off, across clean merges of the base alone
// (verdictCarries).
export const reviewCarries = ({ reuse, from, head, base, body, git }) => (reuse
  ? restsOnCarries({ from, head, base, files: restsOn(body), git })
  : verdictCarries({ from, head, base, git }));

const short = (sha) => `\`${String(sha ?? '').slice(0, 12)}\``;
// What a carry under the review-reuse lever tells the PR, so that nothing reads as a review of the head.
const carriedTo = (head, range) => `carried to this head (${short(head)}), which no review has read: the PR's own diff is unchanged, and the base range \`${range}\` changed none of the files the review rests on, no dependency manifest, lockfile or configuration file`;
// The merge driver's comment on such a carry, for a PR that left draft before its head moved.
export const carryComment = (from, head, range) => `The review posted on ${short(from)} is ${carriedTo(head, range)}.`;

// The comment on a PR the pass took out of draft: why, and the verdict it read, quoted (a plain
// review's line stating the §4 value, as a string). `carried` is the commit the verdict was posted on
// when it was carried to this head, and `range` the base range restsOnCarries checked to carry it.
export function undraftComment(verdict, head, clean, carried = null, range = null) {
  const line = typeof verdict === 'string' ? verdict : Object.entries(verdict ?? {}).map(([k, x]) => `${k}=${x}`).join(' ');
  const what = typeof verdict === 'string' ? 'review' : 'desk-review verdict';
  if (carried && range) {
    return `Out of draft: the ${what} posted on ${short(carried)} is clean under §4 Clean review verdict (\`${clean}\`), and it is ${carriedTo(head, range)}.\n\n> \`${line}\``;
  }
  if (carried) {
    return `Out of draft: the ${what} posted on ${short(carried)} is clean under §4 Clean review verdict (\`${clean}\`), and it holds on this head (${short(head)}): every commit since is a clean merge of the base.\n\n> \`${line}\``;
  }
  return `Out of draft: the ${what} posted on this head (${short(head)}) is clean under §4 Clean review verdict (\`${clean}\`).\n\n> \`${line}\``;
}

// A red gate whose every failing check never tested the code: failed or cancelled because the runner
// killed or lost it (cfg.fault, read first, whatever the conclusion), or else cancelled or timed out. A
// `rerun` call while §3 ci-rerun is yes and a rerun is left at this head (RERUNS_MAX tried for a cancelled
// or timed-out check; RUNNER_RERUNS run for one the runner ended, counting only reruns GitHub accepted,
// cfg.rerunsOk), `wait` while other checks still run or through the last rerun's cooldown, else null (a
// check that failed, or no rerun left, is not green as ever, and its why says how many reruns were spent).
// A check the runner ended is the person's once its rerun ran, once RERUNS_MAX were tried and refused, or
// with ci-rerun not yes, since no change on its branch clears it. A rerun call carries the gate as
// rerun.sh reads it.
const INTERRUPTED = new Set(['cancelled', 'timed_out']);
export const RUNNER_FIX = 'give that job a bigger runner, or cap the memory it uses (fewer test workers, a lower heap limit)';
function rerunCall(gate, cfg, n) {
  const failing = gate.failing;
  if (!failing.length) return null;
  const faults = new Map();
  for (const f of failing) {
    const why = cfg.fault?.(f) ?? null;
    if (why) faults.set(f.name, why);
    else if (!INTERRUPTED.has(f.conclusion)) return null;
  }
  const ended = failing.filter((f) => faults.has(f.name));
  const endedWhat = ended.map((f) => `"${f.name}" (${faults.get(f.name)})`).join('; ');
  const endedNames = ended.map((f) => `"${f.name}"`).join(', ');
  if (cfg.rerun !== 'yes') {
    return ended.length ? { call: 'person', why: `its ${endedNames} check was ended by the runner, not its code: ${endedWhat}; config §3 ci-rerun is "${cfg.rerun ?? 'no'}", so desk is not granted a rerun`, action: `re-run it on #${n}, and if it fails the same way, ${RUNNER_FIX}` } : null;
  }
  const tried = (f) => cfg.reruns?.(f.name) ?? 0;
  const ran = (f) => (cfg.rerunsOk ?? cfg.reruns)?.(f.name) ?? 0;
  const used = runnerRerunsSpent(ended, ran, tried);
  if (used === 'ran') {
    return { call: 'person', why: `its ${endedNames} check was ended by the runner after desk re-ran it at this head: ${endedWhat}`, action: `${RUNNER_FIX}, then re-run it on #${n}` };
  }
  if (used === 'refused') {
    return { call: 'person', why: `its ${endedNames} check was ended by the runner, and GitHub refused desk's ${RERUNS_MAX} reruns of it at this head: ${endedWhat}`, action: `re-run it on #${n}, and if it fails the same way, ${RUNNER_FIX}` };
  }
  if (failing.some((f) => tried(f) >= RERUNS_MAX)) return null;
  const rerun = rerunGate(failing, gate.reasons);
  if (!rerun) return null;
  const how = ended.length ? 'ended by the runner' : 'cancelled or timed out';
  if (gate.pending.length) return { call: 'wait', why: `checks still running (${gate.pending.join(', ')}) beside ${ended.length ? 'ones ended by the runner' : 'cancelled or timed-out ones'}, re-run once they finish` };
  const what = failing.map((f) => (faults.has(f.name) ? `"${f.name}" ${faults.get(f.name)}` : `"${f.name}" ${f.conclusion}`)).join('; ');
  if (cfg.cooledDown === false) return { call: 'wait', why: `checks re-run after they were ${how} (${what}), waiting out the rerun's cooldown` };
  return {
    call: 'rerun', why: ended.length ? `its checks were ended by the runner, not their code, so they are re-run once: ${what}` : `its checks were cancelled or timed out, so they are re-run: ${what}`, runs: rerun.runs, gate: rerun.gate,
  };
}

// A pending check that will never finish on its own: its run completed without it (an orphaned job, no
// runner), or it has been pending past PENDING_LIMIT_MS. cfg.runOf(runId) -> { status, startedAt, jobs:
// [{ databaseId, name, status, startedAt }] } or null (gh run view), cfg.now, and cfg.reruns(name) and
// cfg.cancels(name), what was tried for it at this head. The first stuck check gives a `rerun` of its job
// (an orphan) or a `cancel` of its run (still in progress), and the person once one was tried at this
// head or §3 ci-rerun is not yes. Null while every pending check may yet finish.
const isoMs = (s) => (s && !String(s).startsWith('0001-') ? Date.parse(s) || null : null);
function stuckCall(gate, checks, cfg, n) {
  if (!cfg.runOf || !gate.pending.length) return null;
  const now = cfg.now ?? Date.now();
  const open = latestPerCheck(checks ?? []).filter((c) => c.status !== 'completed' && c.runId && gate.pending.includes(c.name));
  for (const c of open) {
    const run = cfg.runOf(String(c.runId));
    if (!run) continue;
    const job = (run.jobs ?? []).find((j) => j.name === c.name);
    // The run's own record of the job is newer than the PR's rollup: finished there, it is not stuck.
    if (String(job?.status ?? '').toLowerCase() === 'completed') continue;
    const orphan = String(run.status ?? '').toLowerCase() === 'completed';
    const from = isoMs(job?.startedAt) ?? isoMs(c.startedAt) ?? isoMs(run.startedAt);
    const age = from == null ? null : now - from;
    if (!orphan && !(age >= PENDING_LIMIT_MS)) continue;
    const what = orphan ? `"${c.name}" is still ${c.status} though its run ${c.runId} has completed`
      : `"${c.name}" has been ${c.status} for ${since(age)} with its run ${c.runId} still in progress, past the ${since(PENDING_LIMIT_MS)} limit`;
    const person = (why) => ({ call: 'person', why, action: `re-run job "${c.name}" of run ${c.runId} on #${n} once a runner can take it`, job: c.name });
    if (cfg.rerun !== 'yes') return person(`${what}, and config §3 ci-rerun is "${cfg.rerun ?? 'no'}"`);
    // A run still in progress counts only its own cancels: a rerun of the check for an earlier cancel
    // is not this expiry's one try. An orphan's job rerun is recorded as a rerun, so it counts those.
    const tried = (cfg.cancels?.(c.name) ?? 0) + (orphan ? (cfg.reruns?.(c.name) ?? 0) : 0);
    if (tried > 0) return person(`${what}, after it was re-run once at this head`);
    if (!orphan) return { call: 'cancel', why: `${what}, so the run is cancelled and its checks re-run`, runs: [String(c.runId)], checks: [c.name] };
    if (job?.databaseId == null) return person(`${what}, and its job id could not be read to re-run it`);
    return {
      call: 'rerun', why: `${what}, so that job is re-run`, runs: [String(c.runId)],
      gate: { pending: [], failedRuns: [], failedJobs: [{ runId: String(c.runId), jobId: String(job.databaseId), name: c.name, why: 'whose run completed without it' }], reasons: gate.reasons, failing: [{ name: c.name, runId: String(c.runId) }] },
    };
  }
  return null;
}

// A red gate whose every failing check §4 Check builds names (cfg.builds, [{ name, command }]), while
// §3 ci-rerun is yes: the build that clears it, once per head (cfg.built(head), check-build.mjs
// buildRecord). `build` starts it, `wait` while it or another check runs, `rebuilt` re-runs the checks with --failed once
// it succeeded, `sync` when it failed at a head behind its base (cfg.behind(head) -> the base's name, or
// null when the head has it or git cannot say), and `person` when it failed at a head up to date with its base,
// its re-run was refused, or the checks are still red after it. Anything else is null, handled as any red check.
function buildCall(gate, cfg, n, head, t) {
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
    const failed = `its check build \`${command}\` ${exit} at ${at}${rec.tail ? `: ${rec.tail}` : ''}`;
    const base = cfg.behind?.(head) ?? null;
    if (base) return { call: 'sync', why: `${failed}; its head is behind ${base}`, action: `merge ${base} into #${n}'s branch, fix what the merge breaks and push; its check build then runs at the new head`, base };
    return { call: 'person', why: `${failed}${syncSaid(t ?? {})}`, action: `fix the build, run it at the head of #${n}, then re-run ${checks}` };
  }
  if (!rec.reran) return { call: 'rebuilt', why: `its check build \`${command}\` ran at ${at}, so ${checks} is re-run`, checks: names, runs };
  if (!rec.reran.ok) return { call: 'person', why: `its check build \`${command}\` ran at ${at}, but the re-run of ${checks} was refused: ${rec.reran.out}`, action: `re-run ${checks} on #${n}` };
  return { call: 'person', why: `${checks} is still red at ${at} after its check build \`${command}\` ran and the check was re-run`, action: `fix ${checks} on #${n}` };
}

// The words a park's not-reached tail may hold after its marker: the steps the worker contract has it
// name (PR, review comment, Jira comment, transition, tracker state) and their glue.
const TAIL_WORDS = new Set(['the', 'a', 'its', 'and', 'or', 'then', 'to', 'on', 'of', 'in', 'is', 'are', 'yet', 'stage', 'stages',
  'pr', 'draft', 'body', 'self-review', 'review', 'reviews', 'desk-review', 'comment', 'comments', 'post', 'posting', 'posted',
  'jira', 'tracker', 'ticket', 'transition', 'transitions', 'state', 'status', 'progress', 'done', 'screenshots', 'images', 'upload']);

// Whether a park asks for nothing but what `names(clause)` matches: some clause matches, and every
// other one lists the steps it did not reach (the tail the worker contract has every park name). A
// park that asks anything else beside it stays a park.
export function parkOnlyNames(question, names) {
  // Clauses end at . ? ! ; followed by a space, or a line break, so a command's own dots stay whole.
  // Each keeps its own end mark, so a tail clause can tell a question from a list.
  const clauses = String(question ?? '').toLowerCase().split(/(?<=[.?!;])(?:\s+|$)|\n+/).map((s) => s.trim()).filter(Boolean);
  // A tail clause starts with its marker, is no question, and holds nothing but the tail's own steps
  // after it, so a question that only mentions the tail ("before the remaining steps, should we…",
  // "not reached: the Jira comment, so confirm the fee") still parks.
  const tail = (s) => {
    if (s.includes('?')) return false;
    const m = /^(?:steps? )?(?:not (?:yet )?reached|remaining steps?|steps? remaining)\b(.*?)[.!;]*$/.exec(s);
    return !!m && m[1].split(/[\s,:()]+/).map((w) => w.replace(/^[-–—]+|[-–—]+$/g, '')).filter(Boolean).every((w) => TAIL_WORDS.has(w) || /^#?\d+$/.test(w));
  };
  return clauses.some(names) && clauses.every((s) => names(s) || tail(s));
}

// A worker's park whose only blocker is a red check §4 Check builds names: every clause of the park
// names one of those checks or its command, or is the not-reached tail (parkOnlyNames), and the
// ticket's open draft PR is red on such checks and nothing else, with nothing still
// running. buildCall then runs the build once the ticket is done, so the pass records it done rather
// than parked. readPr() -> { state, isDraft, checks } is read only once the park names a build. cfg:
// { builds, rerun (§3 ci-rerun), required, advisory }. Returns { checks: [name], command } or null, and
// null leaves the park as it is.
export function buildPark(question, readPr, cfg) {
  const builds = cfg.builds ?? [];
  const namesBuild = (s) => builds.some((b) => s.includes(b.name.toLowerCase()) || s.includes(b.command.toLowerCase()));
  if (cfg.rerun !== 'yes' || !parkOnlyNames(question, namesBuild)) return null;
  const pr = readPr();
  if (pr?.state !== 'OPEN' || pr.isDraft !== true) return null;
  const gate = evaluateGate(pr.checks ?? [], { required: cfg.required ?? [], advisory: cfg.advisory ?? [] });
  if (gate.state !== 'fail' || gate.pending.length || !gate.failing.length) return null;
  const names = [...new Set(gate.failing.map((f) => f.name))];
  const used = names.map((x) => builds.find((b) => b.name === x));
  if (used.some((b) => !b)) return null;
  return { checks: names, command: [...new Set(used.map((b) => b.command))].join(' && ') };
}

// A body with `_drag <file>_` cells left and a fenced ```evidence block, where §4 Evidence workflow
// names the workflow that fills them (cfg.evidence, evidence.mjs), once per head (cfg.evidenceRun(head)):
// `evidence` starts it, `wait` while it runs, `evidence-failed` once it failed or filled no cell (the pass
// groups those into one fix for the repo, evidence.mjs evidenceFixPlan), and `person` once it has run and
// cells are still left, which undraftCall sends to a capture worker first where their files are missing.
// Anything else is null: no workflow fills them.
function evidenceCall(pr, cfg) {
  const wf = cfg.evidence?.workflow;
  if (!wf || !hasEvidenceBlock(pr.body)) return null;
  const n = pr.number;
  const at = String(pr.head ?? '?').slice(0, 9);
  const left = dragCells(pr.body);
  const rec = cfg.evidenceRun?.(pr.head) ?? null;
  if (!rec) return { call: 'evidence', why: `${left} screenshot cell(s) left at ${at}, which §4 Evidence workflow \`${wf}\` fills`, workflow: wf, cells: left };
  if (rec.state === 'running') return { call: 'wait', why: `its evidence workflow \`${wf}\` is taking the screenshots at ${at}${rec.url ? ` (${rec.url})` : ''}` };
  const action = `fix its \`evidence\` block and re-run \`gh workflow run ${wf} -f pr=${n}\`, or ${noCellsLeft(n)}`;
  // A run that failed, or filled no cell, is the repo's to fix, not cells only the person can reach.
  if (runFailed(rec, left)) {
    const how = rec.conclusion === 'failure' ? 'failed' : 'filled none of its cells';
    return { call: 'evidence-failed', why: `its evidence workflow \`${wf}\` ${how} at ${at}${rec.url ? ` (${rec.url})` : ''} and left ${left} screenshot cell(s)`, action, workflow: wf, runId: rec.runId, url: rec.url ?? null, conclusion: rec.conclusion, at: rec.at ?? null };
  }
  return { call: 'person', why: `its evidence workflow \`${wf}\` ran at ${at} (${rec.conclusion}${rec.url ? `, ${rec.url}` : ''}) and left ${left} screenshot cell(s): ${dragFiles(pr.body).join(', ')}`, action };
}
// What a person does about cells nothing of desk's can fill. They are never asked to upload.
const noCellsLeft = (n) => `edit the body of #${n} so no \`_drag <file>_\` cell is left`;

// The uploads a PR's screenshots get that exit with no result line before they are the person's: the
// pass's own and one retry. The ticket's upload_crash is { pr, dir, tries, log }, log its whole output.
export const UPLOAD_TRIES = 2;
export const UPLOAD_CRASHED = /, and desk's upload of them crashed on \d+ tr(?:y|ies); its output is saved in /;
const crashOf = (t, n) => (t.upload_crash && Number(t.upload_crash.pr) === Number(n) ? t.upload_crash : null);

// The call for a draft's `_drag <file>_` cells, or null with none left: only the cells hold it here,
// however its upload ended. Each goes to what can fill it: §4 Evidence workflow, then for any it left
// with no file a capture worker (fix-tries.mjs captureTry), then for files desk holds the §3 pr-images
// upload, and the person only once none can. cfg as undraftCall's (evidence, evidenceRun, missingShots).
export function cellCall(t, pr, cfg) {
  const cells = dragCells(pr.body);
  if (!cells) return null;
  const n = pr.number;
  const person = (why, action) => ({ call: 'person', why, action });
  const evidence = evidenceCall(pr, cfg);
  if (evidence && evidence.call !== 'person') return evidence;
  const missing = cfg.missingShots?.(pr.body) ?? [];
  if (missing.length) {
    return { ...person(`${missing.length} screenshot(s) in its body were never taken: ${missing.join(', ')}`, noCellsLeft(n)), call: 'capture', files: missing };
  }
  const left = `${cells} screenshot cell(s) left: ${dragFiles(pr.body).join(', ')}`;
  const crash = crashOf(t, n);
  if (crash && crash.tries < UPLOAD_TRIES) {
    return { call: 'wait', why: `${left}: desk's upload of them crashed (try ${crash.tries} of ${UPLOAD_TRIES}), and the next pass tries it again; its output is saved in ${crash.log}`, crashed: crash };
  }
  if (crash) {
    return { ...person(`${left}, and desk's upload of them crashed on ${crash.tries} ${crash.tries === 1 ? 'try' : 'tries'}; its output is saved in ${crash.log}`,
      `read that output, then put them in with \`node ~/.claude/desk/bin/upload-images.mjs ${n} ${crash.dir}\` or ${noCellsLeft(n)}`), crashed: crash };
  }
  if (t.images_reported === true && t.images_uploaded !== true) {
    return { ...person(`${left}, whose files are saved, but config §3 pr-images leaves their upload to you`, `approve it with \`DESK_UPLOAD_APPROVED=1 node ~/.claude/desk/bin/upload-images.mjs ${n} <its screenshot directory>\``), unapproved: true };
  }
  if (evidence) return evidence;
  return person(`${left}, whose files desk holds but could not put in the body`, noCellsLeft(n));
}

// What desk does about each file a draft's cells name, read off the call cellCall makes for it, so the
// person who says done is told what the pass will do: [{ file, doing }].
export function cellPlan(t, pr, cfg) {
  const c = cellCall(t, pr, cfg);
  if (!c) return [];
  const wf = `\`${cfg.evidence?.workflow}\``;
  const spent = c.call === 'capture' && captureTry(t, { pr: pr.number, head: pr.head, files: c.files })?.call === 'stuck';
  const doing = (file) => {
    if (c.crashed) return c.call === 'wait' ? "desk's upload of it crashed, and the next pass tries it again" : `desk's upload of it crashed on every try (its output is in ${c.crashed.log})`;
    if (c.call === 'evidence') return `${wf} takes it at the next pass`;
    if (c.call === 'wait') return `${wf} is taking it now`;
    if (c.call === 'evidence-failed') return `${wf} ${c.conclusion === 'failure' ? 'failed' : 'filled none of its cells'}, so desk fixes the workflow for the repo and runs it again`;
    if (c.call === 'capture' && c.files.includes(file)) return spent ? "desk's capture try could not take it" : 'a capture worker takes it at the next pass';
    if (c.unapproved) return 'its file is saved, and config §3 pr-images leaves its upload to you';
    if (/^its evidence workflow/.test(c.why ?? '')) return `${wf} ran and could not take it`;
    return 'desk holds its file but could not put it in the body';
  };
  return dragFiles(pr.body).map((file) => ({ file, doing: doing(file) }));
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

// t: the queue ticket. pr: { number, head, base, branch, mergeState, mergeable, body, reviews, comments, checks, carry, scope }
// (checks as pr_status keeps them; carry(sha), when given, says whether a verdict posted on sha holds at
// the head, as verdictCarries does, and scope(sha, body) what a head it does not hold at still needs
// read, as reviewScope does). cfg: { spine, perm, approved, localReview, clean, handle, required,
// advisory, permKey, judgement, rerun (§3 ci-rerun), reruns(name) -> reruns tried at the head,
// cooledDown (the last rerun has had its gap), builds (§4 Check builds, parsed), built(head) -> the
// check build recorded at that head, behind(head) -> the base's name when the head is behind it, evidence (§4 Evidence workflow, parsed), evidenceRun(head) -> the
// evidence run recorded at that head, missingShots(body) -> the files its `_drag <file>_` cells name that
// the ticket's screenshot directory does not hold, conflictUnreviewed, conflictReviewed (§3
// pr-conflict-unreviewed and -reviewed), untriggered(base, head, branch) -> gate.mjs untriggeredChecks's map
// for a required check that never reported, stale(base, head, branch, baseHead) -> staleTriggers's
// { behind, reopen } for one the pass's base sync or reopen starts, runOf(runId), cancels(name) and now
// for a check stuck pending (stuckCall), fault(check) -> gate.mjs runnerFault's why for a red check the
// runner killed or lost, or null, and rerunsOk(name), the reruns GitHub accepted at this head }.
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
  if (!cfg.handle) return person('§1 GitHub handle is not set, so no review verdict can be attested', 'set it with /desk-setup');
  // A review at the head that found a P0 or a P1 is a code change for a fix worker, whatever else is
  // wrong with the PR: the pass sends it back (fix-tries.mjs reviewFix) with the review's body and
  // the inline comments it reads by the review's id.
  // Under a plain-text row the latest review may still be a desk-review verdict (plainVerdictAt reads
  // it against desk-review's own counts), and its P0s and P1s go the same way.
  const { plain, review, verdict, v, found, carried, range, targeted } = verdictAtHead(pr.reviews, cfg.handle, pr.head, clean, pr.carry, pr.scope);
  const withCarried = (c) => (carried ? { ...c, carried, ...(range ? { range } : {}) } : c);
  // Under §3 autopilot-judgement yes, its requirement gaps go the same way: a worker makes the call.
  const gaps = cfg.judgement === 'yes' && Number(found?.gaps) > 0;
  // A P2 it lists is a fix worker's too; one deferred, or listed nowhere, is the person's.
  const p2s = Number(found?.p2) > 0 && !(Number(found?.deferred) > 0) && reviewFindings(review?.body, ['P2']).length > 0;
  if (v.settle && found && (Number(found.p0) > 0 || Number(found.p1) > 0 || p2s || gaps)) {
    return { ...person(v.why, `settle the ${gaps ? 'findings or gaps' : 'findings'} on #${n}`), call: 'findings', verdict: found, review: review.body, reviewId: review.id };
  }
  if (pr.mergeState === 'DIRTY' || pr.mergeable === 'CONFLICTING') {
    const c = person('it has a merge conflict with its base', `resolve the conflict on #${n}; it then needs a fresh review`);
    return (humanReviewed(pr, cfg.handle) ? cfg.conflictReviewed : cfg.conflictUnreviewed) === 'yes' ? { ...c, call: 'conflict' } : c;
  }
  if (pr.mergeable !== 'MERGEABLE') return { call: 'wait', why: `GitHub has not yet worked out whether it conflicts with its base (${pr.mergeable ?? 'no answer'})` };
  let gate = evaluateGate(pr.checks ?? [], { required: cfg.required ?? [], advisory: cfg.advisory ?? [] });
  // A required check that never reported may be one its workflow never runs on this PR's base.
  if (gate.state === 'absent' && pr.base && cfg.untriggered) {
    const untriggered = cfg.untriggered(pr.base, pr.head, pr.branch ?? null) ?? {};
    if (Object.keys(untriggered).length) gate = evaluateGate(pr.checks ?? [], { required: cfg.required ?? [], advisory: cfg.advisory ?? [], untriggered });
  }
  // A wait on a check that will never finish is no wait: it is re-run, or put to the person.
  const stuck = () => stuckCall(gate, pr.checks, cfg, n);
  if (gate.state === 'pending') return stuck() ?? { call: 'wait', why: `checks still running (${gate.pending.join(', ')})` };
  // One the base's or the default branch's copy of the workflow runs waits for the pass, which syncs the
  // base and reopens the PR so it gets a run.
  if (gate.state === 'absent' && !gate.failing.length && pr.base && cfg.stale) {
    const s = cfg.stale(pr.base, pr.head, pr.branch ?? null, pr.baseHead ?? null) ?? {};
    const why = { ...s.behind, ...s.reopen };
    if (Object.keys(why).length) return { call: 'wait', why: `its base ${pr.base} is to be synced or the PR reopened before CI runs: ${Object.entries(why).map(([c, w]) => `required check "${c}" ${w}`).join('; ')}` };
  }
  // Checks a workflow skips on a draft never go green there, so only the person's undraft runs them.
  const skipped = gate.state !== 'pass' && skippedOnly(pr.checks);
  // A red check is a code change for a fix worker, and a head with no verdict to read is a review for a
  // review worker: the pass sends them there (fix-tries.mjs), and to the person once no try is left.
  // Cancelled, timed-out or runner-ended checks are re-run and §4 Check builds ones built first (above
  // them here).
  // desk-gate's verdict check reads the review on the head, not the code, so no fix turns it green:
  // red alone, it is a review worker's (below), and beside other red checks the fix worker's review
  // after its fix clears it.
  const red = gate.state !== 'pass' && !skipped;
  if (red) {
    const rr = rerunCall(gate, cfg, n);
    if (rr) return (rr.call === 'wait' && stuck()) || rr;
    const bc = buildCall(gate, cfg, n, pr.head, t);
    if (bc) return (bc.call === 'wait' && stuck()) || bc;
  }
  const codeRed = gate.failing.filter((f) => f.name !== VERDICT_CHECK);
  // No run exists to re-run: the workflow's trigger has to take the base, a change to the repo.
  if (red && gate.untriggered?.length && !codeRed.length) {
    return person(`its checks are not green: ${gate.reasons.join('; ')}`,
      `add ${pr.base} (or a pattern such as feat/**) to the pull_request branches of the workflow that runs ${gate.untriggered.map((c) => `"${c}"`).join(', ')}, a change to the repo; once #${n}'s branch has it, its next push runs the check (re-running cannot, as no run exists)`);
  }
  if (red && (codeRed.length || !gate.failing.length)) {
    const spent = cfg.rerun === 'yes' && gate.failing.some((f) => (cfg.reruns?.(f.name) ?? 0) >= RERUNS_MAX) ? `, still after ${RERUNS_MAX} reruns at this head` : '';
    const notGreen = person(`its checks are not green: ${gate.reasons.join('; ')}${spent}`, `fix or re-run the checks on #${n}`);
    // A cancelled or timed-out run tested no code, so a fix worker has nothing to fix until its reruns are spent.
    if (!spent && codeRed.length && codeRed.every((f) => INTERRUPTED.has(f.conclusion))) return notGreen;
    return { ...notGreen, call: 'checks', failing: codeRed };
  }
  if (!v.clean && !v.settle) return { ...person(v.why, `review #${n} at its head`), call: 'review', ...(targeted ? { targeted } : {}) };
  if (!v.clean) return person(v.why, `settle the findings or gaps on #${n}`);
  if (red) {
    const why = `its ${VERDICT_CHECK} check reads only a verdict posted on the head${carried ? `, and its verdict is carried from ${carried.slice(0, 9)}` : ''}`;
    return withCarried({ ...person(why, `review #${n} at its head`), call: 'review' });
  }
  const shots = cellCall(t, pr, cfg);
  if (shots) return shots;
  if (skipped) return person(SKIPPED_ON_DRAFT, `undraft #${n}`);
  const read = plain ? v.verdict : verdict;
  if (cfg.perm === 'yes') return withCarried({ call: 'ready', why: null, note: null, verdict: read });
  if (cfg.perm === 'ask' && cfg.approved) {
    return withCarried({ call: 'ready', why: null, verdict: read, note: `- [${t.key}] undrafted #${n} at ${pr.head}: §3 ${cfg.permKey} is ask, batch approval given at Stage 3` });
  }
  return withCarried(person(`it is clean and green, and config §3 ${cfg.permKey} is "${cfg.perm}"${cfg.perm === 'ask' ? ' with no batch approval' : ''}`, `undraft #${n}`));
}
