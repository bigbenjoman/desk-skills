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
//   check "<name>" on pr <n> passes
//                          the latest run of that check on the PR's head commit succeeded; several names,
//                          each quoted, joined by commas or "and" (`checks "a" and "b" on pr 9 pass`)
//   commit <sha> on <branch>
//                          origin's <branch> holds that commit ("is an ancestor of origin/<branch>" too)
//   gh pr view <n> [--repo <owner/name>] … reports MERGED
//                          the command a worker would run, read as pr <n> merged (in that repo)
//   none                   nothing a script can read; the park waits for a person
// Stored on the park as {kind, pr | ticket | name | run | branch | login | path | repo}: kind is
// pr-merged (with repo: <owner/name> for another repo's PR), pr-ready, ticket-done, variable-set,
// run-completed, push-ok (with lease: <sha> for a lease push), base-contains, pr-reviewed {pr, login},
// file-exists {path, root: abs | worktree | state}, ticket-queued {ticket, repo}, checks-pass
// {pr, checks}, commit-on {sha, branch} or none.
// A worker's line that reads as none of them is stored by the supervisor's pass as unreadable {text,
// why}: the decider restates it once (decider.mjs), and it waits for a person only once the decider has
// seen it. A session's pass, where no decider runs, stores none.
// The pass records one more itself, live-read {reads, head}, for a park waiting on §4 Live reads it
// runs (live-read.mjs), and settles it in its own section. And links-made {links, pr}, for a ticket that
// ended on DONE parked on issue links the pass did not make (pass.mjs parkLinks): it holds once each
// {key, type, other} is on Jira, and the ticket goes back to done on PR `pr`. Only the person's step
// makes that one hold, so its park is still put to them (personClears), not left to wait unseen.

import { realpathSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// A check's name, quoted: names hold spaces.
const QUOTED = '(?:"[^"]+"|\'[^\']+\'|`[^`]+`)';
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
  [new RegExp(`^checks?\\s+(${QUOTED}(?:\\s*(?:,\\s*and|,|and)\\s*${QUOTED})*)\\s+(?:on|of)\\s+pr\\s+#?(\\d+)\\s+(?:pass(?:es|ed)?|succeed(?:s|ed)?|(?:is|are)\\s+green)(?:\\s+at\\s+(?:its\\s+|the\\s+)?head)?$`, 'i'),
    (m) => ({ kind: 'checks-pass', pr: Number(m[2]), checks: [...m[1].matchAll(new RegExp(QUOTED, 'g'))].map((x) => x[0].slice(1, -1).trim()) })],
  [/^commit\s+([0-9a-f]{7,40})\s+(?:is\s+)?(?:on|in|an\s+ancestor\s+of|reachable\s+from)\s+(?:origin\/)?([\w.-]+(?:\/[\w.-]+)*)$/i,
    (m) => ({ kind: 'commit-on', sha: m[1].toLowerCase(), branch: m[2] })],
  [/^gh\s+pr\s+view\s+#?(\d+)((?:\s+\S+)*?)\s+(?:reports|returns|prints|shows|says|is|==?)\s+["'`]?merged["'`]?\.?$/i, (m, here) => {
    // gh takes [HOST/]OWNER/REPO: the repo is the last two parts.
    const repo = /(?:^|\s)(?:--repo|-R)[=\s]+["']?(?:[\w.-]+\/)?([\w.-]+\/[\w.-]+)(?=["']?(?:\s|$))/.exec(m[2])?.[1];
    return { kind: 'pr-merged', pr: Number(m[1]), ...(repo && repo.toLowerCase() !== String(here ?? '').toLowerCase() ? { repo } : {}) };
  }],
  [/^none$/i, () => ({ kind: 'none' })],
];
const FORM_LIST = ['pr <n> merged', 'pr <n> ready', 'ticket <KEY> done', 'variable <NAME> set', 'run <id> completed', 'git push origin <branch> succeeds',
  'base contains <branch>', 'pr <n> reviewed by <login> at head', 'file <path> exists', 'ticket <KEY> in <repo> batch',
  'check "<name>" on pr <n> passes', 'commit <sha> on <branch>', 'gh pr view <n> [--repo <owner/name>] reports MERGED'];
export const CLEARS_WHEN_FORMS = `${FORM_LIST.join(', ')}, or none`;
// One form a line, for a worker checking its line before it ends (queue.mjs clears-when --check).
export const CLEARS_WHEN_FORM_LINES = [...FORM_LIST, 'none'];

// A line no form reads, kept for the decider to restate (decider.mjs): a pass neither checks it nor
// asks the person until the decider has seen it.
export const UNREADABLE = 'unreadable';
export const restating = (c) => c?.kind === UNREADABLE;
// Whether `c` is a condition a pass checks: neither none nor one still to be restated.
export const recorded = (c) => !!c?.kind && c.kind !== 'none' && c.kind !== UNREADABLE;

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

// {ok: true, cond} or {ok: false, why}. Nothing given is none. `here` is this repo's owner/name: a PR
// named in it is this repo's, so no repo is stored for it.
export function parseClearsWhen(raw, { here = null } = {}) {
  const s = String(raw ?? '').trim().replace(/^["'`]|["'`]$/g, '').trim();
  if (!s) return { ok: true, cond: { kind: 'none' } };
  for (const [re, make] of FORMS) {
    const m = re.exec(s);
    if (!m) continue;
    const cond = make(m, here);
    return cond.why ? { ok: false, why: cond.why } : { ok: true, cond };
  }
  return { ok: false, why: `"${s}" is not one of: ${CLEARS_WHEN_FORMS}` };
}

// The check a worker runs on its line before it ends: {ok, text}, the text naming what it reads as, or
// that it reads as no form, one form a line. `node clears-when.mjs --check "<condition>"` (a worker's,
// below) and `queue.mjs clears-when --check` print it, exiting 0 or 1.
export function checkLine(raw, { here = null } = {}) {
  const p = parseClearsWhen(raw, { here });
  if (p.ok) return { ok: true, text: `reads as: ${describeCond(p.cond)}` };
  return { ok: false, text: `${p.why.replace(/ is not one of: [\s\S]*$/, ' is not a form a pass reads')}. The forms:\n${CLEARS_WHEN_FORM_LINES.map((f) => `  ${f}`).join('\n')}` };
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
// A check on a PR's head, as gate.mjs normaliseRollup gives it: by its name, or its workflow's
// "<workflow> / <name>", case aside.
const sameCheck = (r, name) => [r?.name, r?.workflow && r?.name ? `${r.workflow} / ${r.name}` : null]
  .some((n) => n != null && String(n).toLowerCase() === String(name).toLowerCase());
// success for a passed one; otherwise its conclusion, or how far it has got.
const checkState = (r) => String((r?.status === 'completed' ? r.conclusion : r?.status) || 'unknown').toLowerCase();
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
    case 'pr-merged': return `PR ${c.repo ?? ''}#${c.pr} merged`;
    case 'pr-ready': return `PR #${c.pr} out of draft`;
    case 'ticket-done': return `${c.ticket} done`;
    case 'variable-set': return `repo variable ${c.name} set`;
    case 'run-completed': return `Actions run ${c.run} completed`;
    case 'push-ok': return `git push ${c.lease ? `--force-with-lease=${c.branch}:${c.lease} ` : ''}origin ${c.branch} succeeds`;
    case 'base-contains': return `the batch base contains ${c.branch}`;
    case 'pr-reviewed': return `PR #${c.pr} reviewed by ${c.login} at its head`;
    case 'file-exists': return `file ${c.root === 'state' ? `$DESK_STATE/${c.path}` : c.path} exists`;
    case 'ticket-queued': return `${c.ticket} in a running ${c.repo} batch`;
    case 'checks-pass': return `${(c.checks ?? []).map((n) => `"${n}"`).join(' and ')} passing on PR #${c.pr}'s head`;
    case 'commit-on': return `commit ${c.sha} on origin/${c.branch}`;
    case UNREADABLE: return `"${c.text}", for the decider to restate as a form a pass reads`;
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
//   checks(n) → {headRefOid, checks: [{name, workflow, status, conclusion}]}, the latest run of each
//              check on the head (gate.mjs latestPerCheck over normaliseRollup)
//   commitOn(sha, branch) → {holds, note?}, having fetched origin's branch
export function checkCond(c, read) {
  try {
    switch (c?.kind) {
      case 'pr-merged': return { holds: read.pr(c.pr, c.repo).state === 'MERGED' };
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
      case 'checks-pass': {
        const p = read.checks(c.pr);
        if (!p?.headRefOid) throw new Error(`gh pr view ${c.pr}: no head commit`);
        const head = p.headRefOid.slice(0, 9);
        const behind = (c.checks ?? []).flatMap((name) => {
          const runs = (p.checks ?? []).filter((r) => sameCheck(r, name));
          if (!runs.length) return [`"${name}" has not run`];
          const bad = runs.find((r) => checkState(r) !== 'success');
          return bad ? [`"${name}" is ${checkState(bad)}`] : [];
        });
        return behind.length ? { holds: false, note: `${behind.join(', ')} at ${head}` } : { holds: true, note: `at ${head}` };
      }
      case 'commit-on': return read.commitOn(c.sha, c.branch);
      case 'links-made': return { holds: (c.links ?? []).length > 0 && c.links.every((l) => read.link(l) === true) };
      default: return { holds: false };
    }
  } catch (e) { return { error: String(e?.message ?? e).trim().split('\n').pop() || 'the check failed' }; }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

// The --check command, for this file and queue.mjs clears-when --check: checkLine on `args` against
// this repo, printed, exiting 0 or 1.
export async function runCheck(args) {
  let here = null;
  try { here = (await import('./desk-env.mjs')).ghRepo(); } catch { /* outside a desk repo: no repo is this one */ }
  const r = checkLine(args.join(' '), { here });
  (r.ok ? console.log : console.error)(r.text);
  process.exit(r.ok ? 0 : 1);
}

// A worker's check: its settings allow this, and never queue.mjs.
if (isMain) {
  if (process.argv[2] !== '--check') { console.error('usage: clears-when.mjs --check "<condition>"'); process.exit(2); }
  await runCheck(process.argv.slice(3));
}
