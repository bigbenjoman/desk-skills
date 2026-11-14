// What clears a park, as a script can read it: the park's `clears_when`, recorded when the ticket
// parks (a worker's `AUTOPILOT_PARK_CLEARS_WHEN:` line, or `queue.mjs clears-when`). Each pass checks
// it for every parked ticket, and a park whose condition holds is settled without a model or a person.
//
// The forms, one per park:
//   pr <n> merged          the PR merged
//   pr <n> ready           the PR is out of draft (open and not a draft, or merged)
//   ticket <KEY> done      the Jira ticket is in a done status category
//   variable <NAME> set    the repo has an Actions variable of that name
//   run <id> completed     the GitHub Actions run finished, whatever its conclusion
//   git push origin <branch> succeeds
//                          the push GitHub refused with a 5xx goes through; the check is the push
//                          itself, and `--force-with-lease=<branch>:<sha>` may come before `origin`.
//                          A lease with no SHA is not read: a pass pushes long after the worker did,
//                          so it must name what it may overwrite
//   base contains <branch> origin's batch base has every commit on origin's <branch> (with no batch
//                          base, the default branch has): "base contains main" is a park waiting for
//                          main to be merged into the base. The pass syncs a base behind the default
//                          branch first, and checks this after that sync, in the same pass
//   pr <n> reviewed by <login> at head
//                          that account has a review on the commit that is the PR's head now; one
//                          only on an older commit does not count
//   file <path> exists     the file is there: an absolute path, one relative to the ticket's worktree,
//                          or one under the state directory written $DESK_STATE/<path>
//   ticket <KEY> in <repo> batch
//                          the ticket is in the queue of a batch of that repo on this computer (its
//                          name or owner/name), other than this one, whose orchestrator has a live beat
//   none                   nothing a script can read; the park waits for a person
// Stored on the park as {kind, pr | ticket | name | run | branch | login | path | repo}: kind is
// pr-merged, pr-ready, ticket-done, variable-set, run-completed, push-ok (with lease: <sha> for a lease
// push), base-contains, pr-reviewed {pr, login}, file-exists {path, root: abs | worktree | state},
// ticket-queued {ticket, repo} or none.
// The pass records one more itself, live-read {reads, head}, for a park waiting on §4 Live reads it
// runs (live-read.mjs), and settles it in its own section. And links-made {links, pr}, for a ticket that
// ended on DONE parked on issue links the pass did not make (pass.mjs parkLinks): it holds once each
// {key, type, other} is on Jira, and the ticket goes back to done on PR `pr`. Only the person's step
// makes that one hold, so its park is still put to them (personClears), not left to wait unseen.

import { join, posix } from 'node:path';

const FORMS = [
  [/^pr\s+#?(\d+)\s+merged$/i, (m) => ({ kind: 'pr-merged', pr: Number(m[1]) })],
  [/^pr\s+#?(\d+)\s+(?:ready|out of draft)$/i, (m) => ({ kind: 'pr-ready', pr: Number(m[1]) })],
  [/^ticket\s+([A-Za-z][A-Za-z0-9_]*-\d+)\s+done$/i, (m) => ({ kind: 'ticket-done', ticket: m[1].toUpperCase() })],
  [/^(?:repo\s+)?variable\s+([A-Za-z_][A-Za-z0-9_]*)\s+set$/i, (m) => ({ kind: 'variable-set', name: m[1] })],
  [/^run\s+#?(\d+)\s+completed$/i, (m) => ({ kind: 'run-completed', run: Number(m[1]) })],
  [/^git\s+push\s+(?:(?:-u|--set-upstream)\s+)?origin\s+([\w./-]+)\s+succeeds$/i, (m) => ({ kind: 'push-ok', branch: m[1] })],
  [/^git\s+push\s+--force-with-lease=([\w./-]+):([0-9a-f]{40})\s+origin\s+\1\s+succeeds$/, (m) => ({ kind: 'push-ok', branch: m[1], lease: m[2] })],
  [/^(?:the\s+)?(?:batch\s+)?base\s+contains\s+(?:origin\/)?([\w.-]+(?:\/[\w.-]+)*)$/i, (m) => ({ kind: 'base-contains', branch: m[1] })],
  [/^pr\s+#?(\d+)\s+reviewed\s+by\s+@?([A-Za-z0-9][\w-]*(?:\[bot\])?)\s+at\s+(?:its\s+|the\s+)?head$/i, (m) => ({ kind: 'pr-reviewed', pr: Number(m[1]), login: m[2] })],
  [/^file\s+(.+?)\s+exists$/i, (m) => fileCond(m[1])],
  [/^(?:ticket\s+)?([A-Za-z][A-Za-z0-9_]*-\d+)\s+(?:is\s+)?(?:queued\s+)?in\s+(?:an?\s+|the\s+)?([\w.-]+(?:\/[\w.-]+)?)\s+batch$/i,
    (m) => ({ kind: 'ticket-queued', ticket: m[1].toUpperCase(), repo: m[2] })],
  [/^none$/i, () => ({ kind: 'none' })],
];
export const CLEARS_WHEN_FORMS = 'pr <n> merged, pr <n> ready, ticket <KEY> done, variable <NAME> set, run <id> completed, git push origin <branch> succeeds, base contains <branch>, pr <n> reviewed by <login> at head, file <path> exists, ticket <KEY> in <repo> batch, or none';

const STATE_PREFIX = /^\$(?:DESK_STATE|\{DESK_STATE\})(?:\/|$)/;
// A relative path that climbs out of where it is read from (`..`) names somewhere else.
const climbs = (p) => posix.normalize(p).split('/')[0] === '..';
function fileCond(raw) {
  const p = raw.replace(/^["'`]|["'`]$/g, '');
  const refuse = { why: `"${p}" is outside the ticket's worktree and $DESK_STATE: name an absolute path, a path relative to the ticket's worktree, or $DESK_STATE/<path>` };
  if (p.startsWith('/')) return { kind: 'file-exists', path: posix.normalize(p), root: 'abs' };
  if (STATE_PREFIX.test(p)) {
    const rest = p.replace(STATE_PREFIX, '') || '.';
    return climbs(rest) ? refuse : { kind: 'file-exists', path: posix.normalize(rest), root: 'state' };
  }
  return p.startsWith('~') || p.startsWith('$') || climbs(p) ? refuse : { kind: 'file-exists', path: posix.normalize(p), root: 'worktree' };
}

// {ok: true, cond} or {ok: false, why}. Nothing given is none.
export function parseClearsWhen(raw) {
  const s = String(raw ?? '').trim().replace(/^["'`]|["'`]$/g, '').trim();
  if (!s) return { ok: true, cond: { kind: 'none' } };
  for (const [re, make] of FORMS) {
    const m = re.exec(s);
    if (!m) continue;
    const cond = make(m);
    return cond.why ? { ok: false, why: cond.why } : { ok: true, cond };
  }
  return { ok: false, why: `"${s}" is not one of: ${CLEARS_WHEN_FORMS}` };
}

// Where a file-exists condition looks: worktree and state are the ticket's worktree and $DESK_STATE.
export function condPath(c, { worktree, state }) {
  if (c.root === 'abs') return c.path;
  const dir = c.root === 'state' ? state : worktree;
  if (!dir) throw new Error(c.root === 'state' ? 'no state directory' : 'the ticket has no worktree recorded');
  return join(dir, c.path);
}

// Whether a GitHub login is `want`: case aside, and with or without an app's [bot] suffix.
const sameLogin = (a, want) => String(a ?? '').toLowerCase().replace(/\[bot\]$/, '') === String(want).toLowerCase().replace(/\[bot\]$/, '');
// Whether a desk slug (owner__name) is the repo a condition names, as name or owner/name. A GitHub
// owner holds no underscore, so the slug's first `__` ends the owner and the rest is the whole name:
// `web` is not the repo `foo__web`, nor `acme/web` the repo `other/acme__web`. A name with no `/` is
// the whole name, which may itself hold `__`, or the whole slug.
const sameRepo = (slug, repo) => {
  const s = String(slug).toLowerCase();
  const r = String(repo).toLowerCase().replace('/', '__');
  const at = s.indexOf('__');
  return s === r || (!String(repo).includes('/') && at > 0 && s.slice(at + 2) === r);
};
const queueLabel = (o) => `${o.slug}${o.batch ? ` batch ${o.batch}` : ''}`;

// Whether `ticket` is in a running batch of `repo`. queues: otherQueues() less this batch's own;
// live(o): its orchestrator has a live beat. A queue of that repo that cannot be read throws, unless
// another of its batches already holds the ticket.
export function queuedIn(ticket, repo, queues, live) {
  const mine = queues.filter((o) => sameRepo(o.slug, repo));
  if (!mine.length) return { holds: false, note: `no ${repo} queue was found on this computer` };
  const holding = mine.filter((o) => !o.error && o.q?.tickets?.[ticket]);
  const running = holding.find(live);
  if (running) return { holds: true, note: `in ${queueLabel(running)}` };
  const bad = mine.find((o) => o.error);
  if (bad) throw new Error(`${queueLabel(bad)}'s queue cannot be read (${bad.error})`);
  return holding.length
    ? { holds: false, note: `in ${holding.map(queueLabel).join(', ')}, whose orchestrator is not running` }
    : { holds: false, note: `not in any ${repo} queue` };
}

// Whether only a step of the person's makes condition `c` hold, so a park waiting on it still asks them.
export const personClears = (c) => c?.kind === 'links-made';

// The condition as it is written, for the report.
export function describeCond(c) {
  switch (c?.kind) {
    case 'pr-merged': return `PR #${c.pr} merged`;
    case 'pr-ready': return `PR #${c.pr} out of draft`;
    case 'ticket-done': return `${c.ticket} done`;
    case 'variable-set': return `repo variable ${c.name} set`;
    case 'run-completed': return `Actions run ${c.run} completed`;
    case 'push-ok': return `git push ${c.lease ? `--force-with-lease=${c.branch}:${c.lease} ` : ''}origin ${c.branch} succeeds`;
    case 'base-contains': return `the batch base contains ${c.branch}`;
    case 'pr-reviewed': return `PR #${c.pr} reviewed by ${c.login} at its head`;
    case 'file-exists': return `file ${c.root === 'state' ? `$DESK_STATE/${c.path}` : c.path} exists`;
    case 'ticket-queued': return `${c.ticket} in a running ${c.repo} batch`;
    case 'live-read': return `live read ${(c.reads ?? []).join(', ')} finished`;
    case 'links-made': return `issue links ${(c.links ?? []).map((l) => `${l.key} ${l.type} ${l.other}`).join(', ')} made`;
    default: return 'none';
  }
}

// Does it hold now? {holds: bool, note?} or {error}. `note` is what the next worker or the report
// needs beside the answer: a finished run's conclusion, or an unfinished one's status. The readers do
// the reading and throw on any failure, so a check that could not run is never read as cleared:
//   pr(n) → {state, isDraft}   ticket(key) → the status category key   variable(name) → bool
//   run(id) → {status, conclusion}   push(c) → {holds, note?}, having tried the push
//   baseContains(branch) → {holds, note?}, the note saying how far behind the base is and why
//   link({key, type, other}) → bool, the link is on Jira
//   reviews(n) → {headRefOid, reviews: [{author: {login}, commit: {oid}}]}
//   file(c) → bool, the file condPath names is there
//   queued(ticket, repo) → {holds, note?}, queuedIn over this computer's other queues
export function checkCond(c, read) {
  try {
    switch (c?.kind) {
      case 'pr-merged': return { holds: read.pr(c.pr).state === 'MERGED' };
      case 'pr-ready': { const p = read.pr(c.pr); return { holds: p.state === 'MERGED' || (p.state === 'OPEN' && p.isDraft === false) }; }
      case 'ticket-done': return { holds: read.ticket(c.ticket) === 'done' };
      case 'variable-set': return { holds: read.variable(c.name) === true };
      case 'run-completed': {
        const r = read.run(c.run);
        if (!r?.status) throw new Error(`gh run view ${c.run}: no status`);
        return r.status === 'completed'
          ? { holds: true, note: `conclusion ${r.conclusion || 'none'}` }
          : { holds: false, note: `still ${r.status}` };
      }
      case 'push-ok': return read.push(c);
      case 'base-contains': return read.baseContains(c.branch);
      case 'pr-reviewed': {
        const p = read.reviews(c.pr);
        if (!p?.headRefOid) throw new Error(`gh pr view ${c.pr}: no head commit`);
        const theirs = (p.reviews ?? []).filter((r) => sameLogin(r?.author?.login, c.login));
        if (theirs.some((r) => r?.commit?.oid === p.headRefOid)) return { holds: true };
        return { holds: false, note: theirs.length ? `${c.login}'s review is on an older commit than the head ${p.headRefOid.slice(0, 9)}` : `no review by ${c.login} yet` };
      }
      case 'file-exists': return { holds: read.file(c) === true };
      case 'ticket-queued': return read.queued(c.ticket, c.repo);
      case 'links-made': return { holds: (c.links ?? []).length > 0 && c.links.every((l) => read.link(l) === true) };
      default: return { holds: false };
    }
  } catch (e) { return { error: String(e?.message ?? e).trim().split('\n').pop() || 'the check failed' }; }
}
